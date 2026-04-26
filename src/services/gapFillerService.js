// ============================================================
// src/services/gapFillerService.js
//
// For the current day only: finds uncovered time gaps in the
// user's schedule and suggests popular live Twitch streams to
// fill them, matched by the user's preferred categories and language.
//
// Filler slots are ephemeral — never stored in the DB.
// They are marked with isFiller: true so the frontend can style
// them differently.
// ============================================================

const { v4: uuidv4 } = require("uuid");
const { getChannelInfo, getTopLiveStreams, getGamesByName, getLiveStreamsByLogins } = require("./twitchService");
const { getRecentUploads } = require("./youtubeService");
const store = require("../data/store");

const MIN_GAP_MINUTES = 15; // ignore gaps shorter than this

// ── Find uncovered time ranges within [todayStart, todayEnd] ──
function findGaps(slots, todayStart, todayEnd) {
  const sorted = slots
    .filter((s) => s.startTime && new Date(s.startTime) < todayEnd)
    .sort((a, b) => new Date(a.startTime) - new Date(b.startTime));

  const gaps = [];
  let cursor = todayStart;

  for (const slot of sorted) {
    const start = new Date(slot.startTime);
    const end   = slot.endTime
      ? new Date(slot.endTime)
      : new Date(start.getTime() + 60 * 60 * 1000);

    if (start > cursor) {
      const gapMins = (start - cursor) / 60000;
      if (gapMins >= MIN_GAP_MINUTES) {
        gaps.push({ start: new Date(cursor), end: start });
      }
    }
    if (end > cursor) cursor = end;
  }

  if (cursor < todayEnd) {
    const gapMins = (todayEnd - cursor) / 60000;
    if (gapMins >= MIN_GAP_MINUTES) {
      gaps.push({ start: new Date(cursor), end: todayEnd });
    }
  }

  return gaps;
}

// ── Main export ───────────────────────────────────────────────
// streamers  — user's followed streamers (from store.getStreamersByUser)
// todaySlots — today's existing schedule slots
// allSlots   — all stored slots for this user (used to infer game preferences)
// userId     — the requesting user's ID (used to find paid creators to exclude)
// Returns an array of filler slot objects (never stored in DB).
async function getFillersForToday({ streamers, todaySlots, allSlots = [], userId }) {
  const twitchStreamers  = streamers.filter((s) => s.platform === "twitch");
  const youtubeStreamers = streamers.filter((s) => s.platform === "youtube");

  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);
  const todayEnd = new Date(todayStart);
  todayEnd.setUTCDate(todayEnd.getUTCDate() + 1);

  const gaps = findGaps(todaySlots, todayStart, todayEnd);
  if (!gaps.length) return [];

  // ── Followed YouTube uploads (highest-priority gap filler) ─────
  // For every YouTube channel the user follows, surface anything they've
  // uploaded in the last 24h that isn't already in their schedule.
  let youtubeUploadCandidates = [];
  if (youtubeStreamers.length) {
    const settled = await Promise.allSettled(
      youtubeStreamers.map(async (s) => {
        const uploads = await getRecentUploads(s.channelId, 24);
        return uploads.map((u) => ({ ...u, streamer: s }));
      })
    );
    for (const r of settled) {
      if (r.status === "fulfilled") youtubeUploadCandidates.push(...r.value);
    }
    // Newest first
    youtubeUploadCandidates.sort(
      (a, b) => new Date(b.publishedAt) - new Date(a.publishedAt)
    );
  }

  const youtubeUploadSlots = youtubeUploadCandidates.map((u) => ({
    user_id:           `yt-upload-${u.videoId}`,
    user_login:        u.streamer.channelId,
    user_name:         u.streamer.displayName,
    title:             u.title,
    game_name:         "Recent upload",
    viewer_count:      0,
    thumbnail_url:     u.thumbnail,
    platform:          "youtube",
    channelUrl:        `https://youtube.com/watch?v=${u.videoId}`,
    isLive:            false,
    isFollowerUpload:  true,
  }));

  // If the user has no Twitch streamers, the YouTube uploads alone fill gaps.
  if (!twitchStreamers.length) {
    return packCandidatesIntoGaps(youtubeUploadSlots, gaps);
  }

  // Profile the user's streamers — language from channel info, games from stored slots
  const logins = twitchStreamers.map((s) => s.channelId);
  let channelInfos = [];
  try {
    channelInfos = await getChannelInfo(logins);
  } catch (err) {
    console.warn("[gapFiller] Could not fetch channel info:", err.message);
    return packCandidatesIntoGaps(youtubeUploadSlots, gaps);
  }

  // Language: pick most common from channel settings
  const langCount = {};
  for (const ch of channelInfos) {
    if (ch.broadcaster_language) {
      langCount[ch.broadcaster_language] = (langCount[ch.broadcaster_language] || 0) + 1;
    }
  }
  const language = Object.entries(langCount).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "en";

  // Games: collect one unique category per streamer from slot history,
  // then supplement with channel info for streamers without stored slots.
  // This ensures variety rather than being dominated by the most common game.
  const streamerIds = new Set(twitchStreamers.map((s) => s.id));
  const latestCategoryByStreamer = {};
  for (const slot of [...allSlots].sort((a, b) => new Date(b.startTime) - new Date(a.startTime))) {
    if (streamerIds.has(slot.streamerId) && slot.category && !latestCategoryByStreamer[slot.streamerId]) {
      latestCategoryByStreamer[slot.streamerId] = slot.category;
    }
  }

  // One category per streamer (deduplicated), filtering out "Just Chatting"
  const uniqueCategories = [
    ...new Set(
      Object.values(latestCategoryByStreamer).filter(
        (cat) => cat && cat.toLowerCase() !== "just chatting"
      )
    ),
  ];

  // Also add game IDs from channel info for streamers that had no stored slots
  const streamersWithSlots = new Set(Object.keys(latestCategoryByStreamer));
  const channelInfoGameIds = [];
  for (const ch of channelInfos) {
    if (!streamersWithSlots.has(ch.broadcaster_id) && ch.game_id && ch.game_id !== "0") {
      channelInfoGameIds.push(ch.game_id);
    }
  }

  // Look up Twitch game IDs for the unique category names (max 10)
  let gameIds = [];
  if (uniqueCategories.length) {
    try {
      const games = await getGamesByName(uniqueCategories.slice(0, 10));
      gameIds = games.map((g) => g.id);
    } catch (err) {
      console.warn("[gapFiller] Could not look up game IDs:", err.message);
    }
  }

  // Merge in channel info game IDs (for streamers without slot history)
  for (const gid of channelInfoGameIds) {
    if (!gameIds.includes(gid)) gameIds.push(gid);
  }

  // Fall back to all channel info game IDs if we still have nothing
  if (!gameIds.length) {
    const gameCount = {};
    for (const ch of channelInfos) {
      if (ch.game_id && ch.game_id !== "0") {
        gameCount[ch.game_id] = (gameCount[ch.game_id] || 0) + 1;
      }
    }
    gameIds = Object.entries(gameCount)
      .sort((a, b) => b[1] - a[1])
      .map(([id]) => id)
      .slice(0, 5);
  }

  // IDs to exclude — already followed streamers
  const followedIds    = new Set(channelInfos.map((c) => c.broadcaster_id));
  const followedLogins = channelInfos.map((c) => c.broadcaster_login);

  // ── Paid creator priority ─────────────────────────────────────
  // Fetch creators with pack credits, excluding channels this user already follows.
  // Only Twitch paid creators are relevant since the gap filler is Twitch-only.
  let paidCandidates = [];
  try {
    const paidCreators  = await store.getActivePaidCreators(followedLogins);
    const twitchPaid    = paidCreators.filter((c) => c.platform === "twitch");
    if (twitchPaid.length) {
      const paidLogins  = twitchPaid.map((c) => c.channelId);
      let liveStreams    = [];
      try {
        liveStreams = await getLiveStreamsByLogins(paidLogins);
      } catch (err) {
        console.warn("[gapFiller] Could not check paid creator live status:", err.message);
      }

      // Live paid creators get real stream data
      paidCandidates = liveStreams.map((stream) => {
        const creator = twitchPaid.find((c) => c.channelId === stream.user_login);
        return { ...stream, isPremium: true, creatorUserId: creator?.userId };
      });

      // Paid creators who aren't live still get a promoted slot using their profile
      const liveLogins = new Set(liveStreams.map((s) => s.user_login));
      for (const creator of twitchPaid) {
        if (!liveLogins.has(creator.channelId)) {
          paidCandidates.push({
            user_id:       creator.id,
            user_login:    creator.channelId,
            user_name:     creator.displayName,
            title:         `${creator.displayName} — Promoted`,
            game_name:     "Football Manager 2026",
            game_id:       null,
            viewer_count:  0,
            thumbnail_url: creator.avatarUrl,
            isPremium:     true,
            creatorUserId: creator.userId,
          });
        }
      }

      // Game-matching paid creators first, then others
      paidCandidates.sort((a, b) => {
        const aMatch = gameIds.includes(a.game_id) ? 0 : 1;
        const bMatch = gameIds.includes(b.game_id) ? 0 : 1;
        return aMatch - bMatch;
      });
    }
  } catch (err) {
    console.warn("[gapFiller] Could not fetch paid creators:", err.message);
  }

  const fillerSlots  = [];
  const usedFillIds  = new Set(); // don't repeat the same filler streamer

  // Fetch live candidates in batches of 3 game IDs (Twitch API limit per request)
  // to cover all the user's game interests, not just the first 3.
  let regularCandidates = [];
  const seenUserIds = new Set();
  try {
    for (let i = 0; i < gameIds.length; i += 3) {
      const batch = gameIds.slice(i, i + 3);
      const streams = await getTopLiveStreams({
        gameIds: batch,
        language,
        excludeUserIds: followedIds,
        limit: 10,
      });
      for (const s of streams) {
        if (!seenUserIds.has(s.user_id)) {
          seenUserIds.add(s.user_id);
          regularCandidates.push(s);
        }
      }
    }
  } catch (err) {
    console.warn("[gapFiller] Could not fetch live streams:", err.message);
    return [];
  }

  // Followed YT uploads first (highest priority — channels you actually watch),
  // then paid creators, then discovery streams.
  const candidates = [...youtubeUploadSlots, ...paidCandidates, ...regularCandidates];

  return packCandidatesIntoGaps(candidates, gaps, fillerSlots, usedFillIds);
}

// ── Pack candidates into gaps ─────────────────────────────────
// Splits each gap into ~2hr blocks and assigns one candidate per block,
// recycling once all candidates have been used.
function packCandidatesIntoGaps(candidates, gaps, fillerSlots = [], usedFillIds = new Set()) {
  const BLOCK_MS = 2 * 60 * 60 * 1000;

  for (const gap of gaps) {
    let cursor = gap.start.getTime();
    while (cursor < gap.end.getTime()) {
      const blockEnd = Math.min(cursor + BLOCK_MS, gap.end.getTime());

      let stream = candidates.find((s) => !usedFillIds.has(s.user_id));
      if (!stream) {
        if (!candidates.length) break;
        usedFillIds.clear();
        stream = candidates[0];
      }
      usedFillIds.add(stream.user_id);

      const platform = stream.platform ?? "twitch";
      const channelUrl =
        stream.channelUrl ?? `https://twitch.tv/${stream.user_login}`;

      fillerSlots.push({
        id:               uuidv4(),
        streamerId:       `filler-${stream.user_id}`,
        streamerName:     stream.user_name,
        streamerColor:    "#F5BB04",
        platform,
        title:            stream.title,
        category:         stream.game_name,
        startTime:        new Date(cursor).toISOString(),
        endTime:          new Date(blockEnd).toISOString(),
        channelUrl,
        isLive:           stream.isLive ?? true,
        isFiller:         true,
        isPremium:        stream.isPremium ?? false,
        isFollowerUpload: stream.isFollowerUpload ?? false,
        creatorUserId:    stream.creatorUserId ?? null,
        viewerCount:      stream.viewer_count,
        thumbnailUrl:     stream.thumbnail_url
          ?.replace("{width}", "320")
          .replace("{height}", "180"),
      });

      cursor = blockEnd;
    }
  }

  return fillerSlots;
}

module.exports = { getFillersForToday };
