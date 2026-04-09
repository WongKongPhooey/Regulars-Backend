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
  const twitchStreamers = streamers.filter((s) => s.platform === "twitch");
  if (!twitchStreamers.length) return [];

  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);
  const todayEnd = new Date(todayStart);
  todayEnd.setUTCDate(todayEnd.getUTCDate() + 1);

  const gaps = findGaps(todaySlots, todayStart, todayEnd);
  if (!gaps.length) return [];

  // Profile the user's streamers — language from channel info, games from stored slots
  const logins = twitchStreamers.map((s) => s.channelId);
  let channelInfos = [];
  try {
    channelInfos = await getChannelInfo(logins);
  } catch (err) {
    console.warn("[gapFiller] Could not fetch channel info:", err.message);
    return [];
  }

  // Language: pick most common from channel settings
  const langCount = {};
  for (const ch of channelInfos) {
    if (ch.broadcaster_language) {
      langCount[ch.broadcaster_language] = (langCount[ch.broadcaster_language] || 0) + 1;
    }
  }
  const language = Object.entries(langCount).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "en";

  // Games: use the most recent stored slot category per streamer, not channel settings
  // This reflects what they actually stream rather than their current channel state
  const streamerIds = new Set(twitchStreamers.map((s) => s.id));
  const latestCategoryByStreamer = {};
  for (const slot of [...allSlots].sort((a, b) => new Date(b.startTime) - new Date(a.startTime))) {
    if (streamerIds.has(slot.streamerId) && slot.category && !latestCategoryByStreamer[slot.streamerId]) {
      latestCategoryByStreamer[slot.streamerId] = slot.category;
    }
  }

  // Count category frequency across streamers
  const categoryCount = {};
  for (const cat of Object.values(latestCategoryByStreamer)) {
    if (cat && cat.toLowerCase() !== "just chatting") {
      categoryCount[cat] = (categoryCount[cat] || 0) + 1;
    }
  }

  // Top 3 categories by frequency
  const topCategories = Object.entries(categoryCount)
    .sort((a, b) => b[1] - a[1])
    .map(([name]) => name)
    .slice(0, 3);

  // Look up Twitch game IDs for those category names
  let gameIds = [];
  if (topCategories.length) {
    try {
      const games = await getGamesByName(topCategories);
      gameIds = games.map((g) => g.id);
    } catch (err) {
      console.warn("[gapFiller] Could not look up game IDs:", err.message);
    }
  }

  // Fall back to channel info game IDs if we couldn't derive any from slots
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
      .slice(0, 3);
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
      const liveStreams  = await getLiveStreamsByLogins(paidLogins);
      paidCandidates = liveStreams.map((stream) => {
        const creator = twitchPaid.find((c) => c.channelId === stream.user_login);
        return { ...stream, isPremium: true, creatorUserId: creator?.userId };
      });
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

  // Fetch a pool of regular candidate streams, then combine with paid priority list
  let regularCandidates = [];
  try {
    regularCandidates = await getTopLiveStreams({
      gameIds,
      language,
      excludeUserIds: followedIds,
      limit: 20,
    });
  } catch (err) {
    console.warn("[gapFiller] Could not fetch live streams:", err.message);
    return [];
  }

  // Paid creators appear first; regulars fill the rest
  let candidates = [...paidCandidates, ...regularCandidates];

  // Each gap gets its own filler stream, split into ~2hr blocks so the
  // day view doesn't have one enormous card spanning the whole day.
  const BLOCK_MS = 2 * 60 * 60 * 1000; // 2 hours

  for (const gap of gaps) {
    let cursor = gap.start.getTime();
    while (cursor < gap.end.getTime()) {
      const blockEnd = Math.min(cursor + BLOCK_MS, gap.end.getTime());

      // Pick next unused candidate
      const stream = candidates.find((s) => !usedFillIds.has(s.user_id));
      if (!stream) break;
      usedFillIds.add(stream.user_id);

      fillerSlots.push({
        id:            uuidv4(),
        streamerId:    `filler-${stream.user_id}`,
        streamerName:  stream.user_name,
        streamerColor: "#6B6B88",
        platform:      "twitch",
        title:         stream.title,
        category:      stream.game_name,
        startTime:     new Date(cursor).toISOString(),
        endTime:       new Date(blockEnd).toISOString(),
        channelUrl:    `https://twitch.tv/${stream.user_login}`,
        isLive:        true,
        isFiller:      true,
        isPremium:     stream.isPremium ?? false,
        creatorUserId: stream.creatorUserId ?? null,
        viewerCount:   stream.viewer_count,
        thumbnailUrl:  stream.thumbnail_url
          ?.replace("{width}", "320")
          .replace("{height}", "180"),
      });

      cursor = blockEnd;
    }
  }

  return fillerSlots;
}

module.exports = { getFillersForToday };
