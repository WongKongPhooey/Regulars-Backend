// ============================================================
// src/services/scheduleService.js
//
// Single entry point for fetching schedule data.
// Routes to the correct platform service based on streamer.platform.
//
// Controllers and startup code should import this file only —
// they never need to know which platform service is underneath.
// ============================================================

const twitchService = require("./twitchService");
const youtubeService = require("./youtubeService");

// ── Config guards ─────────────────────────────────────────────
// Return true only if the required env vars are set for a platform.
function twitchConfigured() {
  return !!(process.env.TWITCH_CLIENT_ID && process.env.TWITCH_CLIENT_SECRET);
}

function youtubeConfigured() {
  return !!process.env.YOUTUBE_API_KEY;
}

// ── Fetch schedule for a single streamer ─────────────────────
// Returns an array of slot objects (may be empty).
// Falls back gracefully if the platform isn't configured.
async function fetchScheduleForStreamer(streamer) {
  if (streamer.platform === "twitch") {
    if (!twitchConfigured()) {
      console.warn("[scheduleService] Skipping Twitch fetch — TWITCH_CLIENT_ID/SECRET not set");
      return [];
    }
    return twitchService.fetchSchedule(streamer);
  }

  if (streamer.platform === "youtube") {
    if (!youtubeConfigured()) {
      console.warn("[scheduleService] Skipping YouTube fetch — YOUTUBE_API_KEY not set");
      return [];
    }
    return youtubeService.fetchSchedule(streamer);
  }

  console.warn(`[scheduleService] Unknown platform: ${streamer.platform}`);
  return [];
}

// ── Fetch schedules for multiple streamers in parallel ────────
// Used on startup to populate schedule data for all seeded streamers.
async function fetchSchedulesForAll(streamers) {
  const results = await Promise.allSettled(
    streamers.map((s) => fetchScheduleForStreamer(s))
  );

  const allSlots = [];
  results.forEach((result, i) => {
    if (result.status === "fulfilled") {
      allSlots.push(...result.value);
    } else {
      console.error(
        `[scheduleService] Failed to fetch schedule for ${streamers[i].displayName}:`,
        result.reason?.message
      );
    }
  });

  return allSlots;
}

// ── Look up a streamer's profile from their platform ──────────
// Returns { displayName, channelId, channelUrl, avatarUrl } or null.
async function lookupStreamer(platform, channelId) {
  if (platform === "twitch") {
    if (!twitchConfigured()) return null;
    return twitchService.lookupStreamer(channelId);
  }
  if (platform === "youtube") {
    if (!youtubeConfigured()) return null;
    return youtubeService.lookupStreamer(channelId);
  }
  return null;
}

module.exports = { fetchScheduleForStreamer, fetchSchedulesForAll, lookupStreamer };
