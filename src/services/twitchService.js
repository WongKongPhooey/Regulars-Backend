// ============================================================
// src/services/twitchService.js
//
// Twitch Helix API integration.
//
// Auth: App Access Token via Client Credentials flow.
//   The token is cached in memory and refreshed automatically
//   before it expires — no user login required for public data.
//
// Endpoints used:
//   POST https://id.twitch.tv/oauth2/token     — get access token
//   GET  /helix/users?login=<login>            — resolve login → broadcaster_id
//   GET  /helix/schedule?broadcaster_id=<id>  — upcoming scheduled segments
//   GET  /helix/streams?user_login=<login>     — check if currently live
//
// Required env vars: TWITCH_CLIENT_ID, TWITCH_CLIENT_SECRET
// ============================================================

const { v4: uuidv4 } = require("uuid");

// ── Token cache ───────────────────────────────────────────────
// App access tokens are valid for ~60 days. We cache it in memory
// and renew proactively 60 seconds before it expires.
let cachedToken = null;
let tokenExpiresAt = 0;

async function getAccessToken() {
  if (cachedToken && Date.now() < tokenExpiresAt) return cachedToken;

  const res = await fetch("https://id.twitch.tv/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.TWITCH_CLIENT_ID,
      client_secret: process.env.TWITCH_CLIENT_SECRET,
      grant_type: "client_credentials",
    }),
  });

  if (!res.ok) {
    throw new Error(`Twitch token request failed: ${res.status}`);
  }

  const data = await res.json();
  cachedToken = data.access_token;
  // Expire 60 s early to avoid using a token that's just expired
  tokenExpiresAt = Date.now() + (data.expires_in - 60) * 1000;
  return cachedToken;
}

// ── Authenticated GET helper ──────────────────────────────────
async function twitchGet(path) {
  const token = await getAccessToken();
  const res = await fetch(`https://api.twitch.tv/helix${path}`, {
    headers: {
      "Client-Id": process.env.TWITCH_CLIENT_ID,
      Authorization: `Bearer ${token}`,
    },
  });

  if (!res.ok) {
    throw new Error(`Twitch API error ${res.status}: GET /helix${path}`);
  }

  return res.json();
}

// ── Look up a channel by login name ──────────────────────────
// Returns { broadcasterId, displayName, avatarUrl } or throws.
async function resolveUser(login) {
  const data = await twitchGet(`/users?login=${encodeURIComponent(login)}`);
  const user = data.data?.[0];
  if (!user) throw new Error(`Twitch user not found: ${login}`);
  return {
    broadcasterId: user.id,
    displayName: user.display_name,
    avatarUrl: user.profile_image_url,
  };
}

// ── Fetch schedule for a streamer ─────────────────────────────
// Returns an array of schedule slot objects for the next 7 days.
async function fetchSchedule(streamer) {
  const now = new Date();
  const cutoff = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  const slots = [];

  // 1. Check if the streamer is currently live
  try {
    const liveData = await twitchGet(
      `/streams?user_login=${encodeURIComponent(streamer.channelId)}`
    );
    const stream = liveData.data?.[0];
    if (stream) {
      // Estimate end time as +3 hours from now (Twitch doesn't provide this)
      const endEstimate = new Date(now.getTime() + 3 * 60 * 60 * 1000);
      slots.push({
        id: uuidv4(),
        streamerId: streamer.id,
        streamerName: streamer.displayName,
        platform: "twitch",
        title: stream.title || `${streamer.displayName} is live`,
        category: stream.game_name || "",
        startTime: stream.started_at,
        endTime: endEstimate.toISOString(),
        channelUrl: streamer.channelUrl,
        isLive: true,
        thumbnailUrl: stream.thumbnail_url
          ?.replace("{width}", "320")
          .replace("{height}", "180"),
      });
    }
  } catch (err) {
    console.warn(`[Twitch] Could not check live status for ${streamer.channelId}: ${err.message}`);
  }

  // 2. Fetch the broadcaster's scheduled segments
  // Note: not all streamers use Twitch's schedule feature — that's fine.
  try {
    const { broadcasterId } = await resolveUser(streamer.channelId);
    const scheduleData = await twitchGet(
      `/schedule?broadcaster_id=${broadcasterId}&first=25`
    );

    const segments = scheduleData.data?.segments ?? [];
    for (const seg of segments) {
      const start = new Date(seg.start_time);
      // Twitch may return end_time as null for open-ended streams
      const end = seg.end_time
        ? new Date(seg.end_time)
        : new Date(start.getTime() + 3 * 60 * 60 * 1000);

      if (start > now && start <= cutoff) {
        slots.push({
          id: uuidv4(),
          streamerId: streamer.id,
          streamerName: streamer.displayName,
          platform: "twitch",
          title: seg.title || `${streamer.displayName} stream`,
          category: seg.category?.name || "",
          startTime: start.toISOString(),
          endTime: end.toISOString(),
          channelUrl: streamer.channelUrl,
          isLive: false,
        });
      }
    }
  } catch (err) {
    // 404 means the streamer has no schedule set up — perfectly normal
    if (!err.message.includes("404")) {
      console.warn(`[Twitch] Schedule fetch failed for ${streamer.channelId}: ${err.message}`);
    }
  }

  return slots;
}

// ── Look up a streamer's profile by login ─────────────────────
// Used by the "add streamer" flow to auto-populate profile data.
async function lookupStreamer(channelId) {
  const data = await twitchGet(`/users?login=${encodeURIComponent(channelId)}`);
  const user = data.data?.[0];
  if (!user) return null;
  return {
    displayName: user.display_name,
    channelId: user.login,
    channelUrl: `https://twitch.tv/${user.login}`,
    avatarUrl: user.profile_image_url,
  };
}

// ── Fetch channel info for multiple logins ────────────────────
// Returns array of channel objects with broadcaster_language and game_id.
async function getChannelInfo(logins) {
  if (!logins.length) return [];
  const userParams = logins.map((l) => `login=${encodeURIComponent(l)}`).join("&");
  const userData = await twitchGet(`/users?${userParams}`);
  const users = userData.data ?? [];
  if (!users.length) return [];

  const idParams = users.map((u) => `broadcaster_id=${u.id}`).join("&");
  const channelData = await twitchGet(`/channels?${idParams}`);
  return channelData.data ?? [];
}

// ── Fetch top live streams by game IDs and language ───────────
// excludeUserIds — Set of broadcaster IDs to exclude (already followed)
async function getTopLiveStreams({ gameIds, language, excludeUserIds, limit = 10 }) {
  let path = `/streams?first=${limit}&type=live`;
  if (language) path += `&language=${encodeURIComponent(language)}`;
  for (const id of gameIds.slice(0, 3)) path += `&game_id=${encodeURIComponent(id)}`;

  const data = await twitchGet(path);
  const streams = (data.data ?? []).filter((s) => !excludeUserIds.has(s.user_id));
  return streams;
}

// ── Look up game IDs by name ──────────────────────────────────
// names — array of game name strings (e.g. ["Football Manager 26", "Minecraft"])
// Returns array of { id, name } objects
async function getGamesByName(names) {
  if (!names.length) return [];
  const unique = [...new Set(names.filter(Boolean))].slice(0, 10);
  const params = unique.map((n) => `name=${encodeURIComponent(n)}`).join("&");
  const data = await twitchGet(`/games?${params}`);
  return data.data ?? [];
}

module.exports = { fetchSchedule, lookupStreamer, getChannelInfo, getTopLiveStreams, getGamesByName };
