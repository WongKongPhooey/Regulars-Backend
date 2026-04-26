// ============================================================
// src/services/youtubeService.js
//
// YouTube Data API v3 integration.
//
// Auth: API key (no OAuth required for public channel data).
//
// Endpoints used:
//   GET /youtube/v3/search   — find upcoming/live broadcasts for a channel
//   GET /youtube/v3/videos   — get liveStreamingDetails (start times, etc.)
//   GET /youtube/v3/channels — resolve channel handle → channel ID
//
// Required env var: YOUTUBE_API_KEY
//
// YouTube schedule notes:
//   • "Upcoming" broadcasts have a scheduledStartTime in liveStreamingDetails.
//   • YouTube does not provide a scheduled end time — we estimate +3 hours.
//   • Live streams in progress have an actualStartTime instead.
// ============================================================

const { v4: uuidv4 } = require("uuid");

const YT_BASE = "https://www.googleapis.com/youtube/v3";

// ── Authenticated GET helper ──────────────────────────────────
async function ytGet(path, params = {}) {
  const url = new URL(`${YT_BASE}${path}`);
  url.searchParams.set("key", process.env.YOUTUBE_API_KEY);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }

  const res = await fetch(url.toString());
  if (!res.ok) {
    throw new Error(`YouTube API error ${res.status}: ${path}`);
  }
  return res.json();
}

// ── Fetch video details for a list of video IDs ───────────────
async function getVideoDetails(videoIds) {
  if (!videoIds.length) return [];
  const data = await ytGet("/videos", {
    part: "snippet,liveStreamingDetails",
    id: videoIds.join(","),
    maxResults: videoIds.length,
  });
  return data.items ?? [];
}

// ── Fetch schedule for a streamer ─────────────────────────────
// Returns an array of schedule slot objects for the next 7 days.
async function fetchSchedule(streamer) {
  const now = new Date();
  const cutoff = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  const slots = [];

  // 1. Check if the streamer is currently live
  try {
    const liveSearch = await ytGet("/search", {
      part: "snippet",
      channelId: streamer.channelId,
      eventType: "live",
      type: "video",
      maxResults: "1",
    });

    const liveItem = liveSearch.items?.[0];
    if (liveItem) {
      const details = await getVideoDetails([liveItem.id.videoId]);
      const video = details[0];
      if (video) {
        const startTime =
          video.liveStreamingDetails?.actualStartTime ?? now.toISOString();
        const endEstimate = new Date(now.getTime() + 3 * 60 * 60 * 1000);

        slots.push({
          id: uuidv4(),
          streamerId: streamer.id,
          streamerName: streamer.displayName,
          platform: "youtube",
          title: video.snippet.title,
          category: "",
          startTime,
          endTime: endEstimate.toISOString(),
          channelUrl: streamer.channelUrl,
          isLive: true,
          thumbnailUrl: video.snippet.thumbnails?.medium?.url,
        });
      }
    }
  } catch (err) {
    console.warn(`[YouTube] Could not check live status for ${streamer.channelId}: ${err.message}`);
  }

  // 2. Fetch upcoming scheduled broadcasts and premieres
  try {
    const upcomingSearch = await ytGet("/search", {
      part: "snippet",
      channelId: streamer.channelId,
      eventType: "upcoming",
      type: "video",
      maxResults: "10",
      order: "date",
    });

    const videoIds = (upcomingSearch.items ?? []).map((item) => item.id.videoId);
    const videos = await getVideoDetails(videoIds);

    for (const video of videos) {
      // Scheduled live stream — has liveStreamingDetails.scheduledStartTime
      const scheduledStart = video.liveStreamingDetails?.scheduledStartTime;
      if (scheduledStart) {
        const start = new Date(scheduledStart);
        if (start <= now || start > cutoff) continue;
        const end = new Date(start.getTime() + 3 * 60 * 60 * 1000);
        slots.push({
          id: uuidv4(),
          streamerId: streamer.id,
          streamerName: streamer.displayName,
          platform: "youtube",
          title: video.snippet.title,
          category: "",
          startTime: start.toISOString(),
          endTime: end.toISOString(),
          channelUrl: `https://youtube.com/watch?v=${video.id}`,
          isLive: false,
          thumbnailUrl: video.snippet.thumbnails?.medium?.url,
        });
        continue;
      }

      // Premiere — no liveStreamingDetails, but publishedAt is in the future
      // YouTube sets publishedAt to the premiere time for scheduled premieres
      const publishedAt = video.snippet?.publishedAt;
      if (publishedAt) {
        const start = new Date(publishedAt);
        if (start <= now || start > cutoff) continue;
        // Premieres are typically shorter — estimate 1 hour
        const end = new Date(start.getTime() + 60 * 60 * 1000);
        slots.push({
          id: uuidv4(),
          streamerId: streamer.id,
          streamerName: streamer.displayName,
          platform: "youtube",
          title: video.snippet.title,
          category: "Premiere",
          startTime: start.toISOString(),
          endTime: end.toISOString(),
          channelUrl: `https://youtube.com/watch?v=${video.id}`,
          isLive: false,
          thumbnailUrl: video.snippet.thumbnails?.medium?.url,
        });
      }
    }
  } catch (err) {
    console.warn(`[YouTube] Schedule fetch failed for ${streamer.channelId}: ${err.message}`);
  }

  return slots;
}

// ── Recent uploads (for the "you might have missed this" gap filler) ──
//
// Uses the channel's uploads playlist (UU{rest of ID}) which costs 1 quota
// unit per call vs 100 for search.list. Caches results in-memory for 15
// minutes since uploads happen every few hours at most.
const _uploadsCache = new Map(); // channelId -> { fetchedAt, uploads }
const UPLOADS_CACHE_TTL_MS = 15 * 60 * 1000;

async function getRecentUploads(channelId, maxAgeHours = 24) {
  if (!channelId?.startsWith("UC")) return [];

  const cached = _uploadsCache.get(channelId);
  if (cached && Date.now() - cached.fetchedAt < UPLOADS_CACHE_TTL_MS) {
    return cached.uploads.filter(
      (u) => Date.now() - new Date(u.publishedAt).getTime() < maxAgeHours * 3600 * 1000
    );
  }

  const uploadsPlaylistId = "UU" + channelId.slice(2);
  let items = [];
  try {
    const data = await ytGet("/playlistItems", {
      part:       "snippet,contentDetails",
      playlistId: uploadsPlaylistId,
      maxResults: "5",
    });
    items = data.items ?? [];
  } catch (err) {
    console.warn(`[YouTube] uploads fetch failed for ${channelId}: ${err.message}`);
    return [];
  }

  const uploads = items
    .map((item) => ({
      videoId:     item.contentDetails.videoId,
      publishedAt: item.contentDetails.videoPublishedAt ?? item.snippet.publishedAt,
      title:       item.snippet.title,
      thumbnail:   item.snippet.thumbnails?.medium?.url ?? item.snippet.thumbnails?.default?.url,
    }));

  _uploadsCache.set(channelId, { fetchedAt: Date.now(), uploads });

  const cutoff = Date.now() - maxAgeHours * 3600 * 1000;
  return uploads.filter((u) => new Date(u.publishedAt).getTime() > cutoff);
}

// ── Look up a channel by ID ───────────────────────────────────
// channelId should be in UC... format. Used to validate and
// populate profile data when adding a new streamer.
async function lookupStreamer(channelId) {
  const data = await ytGet("/channels", {
    part: "snippet",
    id: channelId,
  });

  const channel = data.items?.[0];
  if (!channel) return null;

  return {
    displayName: channel.snippet.title,
    channelId: channel.id,
    channelUrl: `https://youtube.com/channel/${channel.id}`,
    avatarUrl: channel.snippet.thumbnails?.default?.url,
  };
}

module.exports = { fetchSchedule, lookupStreamer, getRecentUploads };
