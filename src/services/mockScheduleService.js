// ============================================================
// src/services/mockScheduleService.js
//
// A "service" handles external integrations or complex logic
// that doesn't belong in a controller.
//
// This mock service generates fake schedule data. Later, you
// would create twitchService.js and youtubeService.js that call
// real APIs — the controller doesn't need to change, just swap
// which service it imports.
// ============================================================

const { v4: uuidv4 } = require("uuid");

// Popular game/category names to make mock data feel realistic
const CATEGORIES = [
  "Valorant", "Minecraft", "Just Chatting", "League of Legends",
  "Fortnite", "Elden Ring", "Call of Duty", "GTA V", "Apex Legends",
  "Chess", "IRL", "Music", "Art",
];

const randomItem = (arr) => arr[Math.floor(Math.random() * arr.length)];

/**
 * Generates mock stream schedule slots for a streamer over the next 7 days.
 *
 * @param {Object} streamer - A streamer object from the data store
 * @returns {Array}         - Array of schedule slot objects
 */
function generateMockScheduleForStreamer(streamer) {
  const slots = [];
  const now = new Date();

  // Each streamer streams on a random subset of the next 7 days
  // We pick 3–5 days to give variety
  const totalDays = 7;
  const streamDayCount = 3 + Math.floor(Math.random() * 3); // 3–5
  const dayOffsets = [];

  while (dayOffsets.length < streamDayCount) {
    const offset = Math.floor(Math.random() * totalDays);
    if (!dayOffsets.includes(offset)) dayOffsets.push(offset);
  }

  dayOffsets.sort((a, b) => a - b); // Keep days in chronological order

  dayOffsets.forEach((dayOffset) => {
    // Build a start time: today + dayOffset, at a random evening hour
    const startDate = new Date(now);
    startDate.setDate(now.getDate() + dayOffset);
    startDate.setHours(17 + Math.floor(Math.random() * 5), 0, 0, 0); // 5–9 PM

    // Duration between 1.5 and 5 hours
    const durationMs = (1.5 + Math.random() * 3.5) * 60 * 60 * 1000;
    const endDate = new Date(startDate.getTime() + durationMs);

    const category = randomItem(CATEGORIES);

    slots.push({
      id: uuidv4(),
      streamerId: streamer.id,
      streamerName: streamer.displayName,
      platform: streamer.platform,
      title: `${streamer.displayName} — ${category}`,
      category,
      startTime: startDate.toISOString(),
      endTime: endDate.toISOString(),
      channelUrl: streamer.channelUrl,
      // Mark as live if the stream should currently be on air
      isLive: startDate <= now && endDate >= now,
    });
  });

  return slots;
}

// ============================================================
// 🔧 REAL API HOOKS — replace these stubs when ready
// ============================================================

/**
 * Fetch schedule from Twitch API (stub).
 * Requires: TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET in .env
 *
 * Twitch Schedule API docs:
 *   https://dev.twitch.tv/docs/api/reference/#get-channel-stream-schedule
 */
async function fetchTwitchSchedule(streamer) {
  // TODO: implement OAuth + API call
  // const token = await getTwitchAccessToken();
  // const response = await fetch(`https://api.twitch.tv/helix/schedule?broadcaster_id=${streamer.channelId}`, {
  //   headers: { 'Client-Id': process.env.TWITCH_CLIENT_ID, 'Authorization': `Bearer ${token}` }
  // });
  // const data = await response.json();
  // return data.data.segments.map(seg => transformTwitchSlot(seg, streamer));

  console.warn("fetchTwitchSchedule: not yet implemented, using mock");
  return generateMockScheduleForStreamer(streamer);
}

/**
 * Fetch schedule from YouTube API (stub).
 * Requires: YOUTUBE_API_KEY in .env
 *
 * YouTube Live Broadcasts docs:
 *   https://developers.google.com/youtube/v3/live/docs/liveBroadcasts/list
 */
async function fetchYouTubeSchedule(streamer) {
  // TODO: implement API call
  // const response = await fetch(
  //   `https://www.googleapis.com/youtube/v3/search?part=snippet&channelId=${streamer.channelId}&eventType=upcoming&type=video&key=${process.env.YOUTUBE_API_KEY}`
  // );
  // const data = await response.json();
  // return data.items.map(item => transformYouTubeSlot(item, streamer));

  console.warn("fetchYouTubeSchedule: not yet implemented, using mock");
  return generateMockScheduleForStreamer(streamer);
}

module.exports = {
  generateMockScheduleForStreamer,
  fetchTwitchSchedule,
  fetchYouTubeSchedule,
};
