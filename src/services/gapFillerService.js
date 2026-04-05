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
const { getChannelInfo, getTopLiveStreams } = require("./twitchService");

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
// Returns an array of filler slot objects (never stored in DB).
async function getFillersForToday({ streamers, todaySlots }) {
  const twitchStreamers = streamers.filter((s) => s.platform === "twitch");
  if (!twitchStreamers.length) return [];

  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);
  const todayEnd = new Date(todayStart);
  todayEnd.setUTCDate(todayEnd.getUTCDate() + 1);

  const gaps = findGaps(todaySlots, todayStart, todayEnd);
  if (!gaps.length) return [];

  // Profile the user's streamers — language and categories
  const logins = twitchStreamers.map((s) => s.channelId);
  let channelInfos = [];
  try {
    channelInfos = await getChannelInfo(logins);
  } catch (err) {
    console.warn("[gapFiller] Could not fetch channel info:", err.message);
    return [];
  }

  // Pick the most-common language and top 3 game IDs
  const langCount = {};
  const gameCount = {};
  for (const ch of channelInfos) {
    if (ch.broadcaster_language) {
      langCount[ch.broadcaster_language] = (langCount[ch.broadcaster_language] || 0) + 1;
    }
    if (ch.game_id && ch.game_id !== "0") {
      gameCount[ch.game_id] = (gameCount[ch.game_id] || 0) + 1;
    }
  }

  const language = Object.entries(langCount).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "en";
  const gameIds  = Object.entries(gameCount)
    .sort((a, b) => b[1] - a[1])
    .map(([id]) => id)
    .slice(0, 3);

  // IDs to exclude — already followed streamers
  const followedIds = new Set(channelInfos.map((c) => c.broadcaster_id));

  const fillerSlots  = [];
  const usedFillIds  = new Set(); // don't repeat the same filler streamer

  // Fetch a pool of candidate streams once, then assign them to gaps
  let candidates = [];
  try {
    candidates = await getTopLiveStreams({
      gameIds,
      language,
      excludeUserIds: followedIds,
      limit: 20,
    });
  } catch (err) {
    console.warn("[gapFiller] Could not fetch live streams:", err.message);
    return [];
  }

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
