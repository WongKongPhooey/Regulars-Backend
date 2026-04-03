// ============================================================
// src/controllers/streamersController.js
//
// Controllers contain the business logic for each route.
// They read from req, talk to the data store, and write to res.
//
// Keeping logic here (not in the route file) means routes stay
// clean URL definitions and controllers stay independently testable.
// ============================================================

const store = require("../data/store");
const { fetchScheduleForStreamer, lookupStreamer } = require("../services/scheduleService");

function buildChannelUrl(platform, channelId) {
  if (platform === "twitch")  return `https://twitch.tv/${channelId}`;
  if (platform === "youtube") return `https://youtube.com/channel/${channelId}`;
  return null;
}

// GET /api/streamers
// Returns the full list of followed streamers.
exports.getAll = async (_req, res) => {
  const streamers = await store.getAllStreamers();
  res.json(streamers);
};

// POST /api/streamers
// Adds a new streamer. Input is already validated by the route middleware.
exports.create = async (req, res) => {
  const { displayName, platform, channelId, avatarUrl, color } = req.body;

  // Check for duplicate: same platform + channelId
  const existing = (await store.getAllStreamers()).find(
    (s) => s.platform === platform && s.channelId === channelId
  );
  if (existing) {
    return res.status(409).json({ error: "Already following this streamer" });
  }

  // Fetch real profile data (avatar + canonical channel URL) from the platform API.
  // Falls back to sensible defaults if the API isn't configured.
  const profile = await lookupStreamer(platform, channelId).catch(() => null);
  const resolvedAvatarUrl = profile?.avatarUrl || avatarUrl || null;
  const resolvedChannelUrl = profile?.channelUrl || buildChannelUrl(platform, channelId);

  const newStreamer = await store.addStreamer({
    displayName,
    platform,
    channelId,
    channelUrl: resolvedChannelUrl,
    avatarUrl: resolvedAvatarUrl,
    color,
  });

  // Kick off a real schedule fetch in the background — don't await it so the
  // response is instant. The schedule will appear on the next guide refresh.
  fetchScheduleForStreamer(newStreamer)
    .then((slots) => store.refreshStreamerSchedule(newStreamer.id, slots))
    .catch((err) =>
      console.error(`[streamersController] Schedule fetch failed for ${displayName}:`, err.message)
    );

  // 201 Created — standard for successful resource creation
  res.status(201).json(newStreamer);
};

// DELETE /api/streamers/:id
// Removes a streamer and their schedule slots.
exports.remove = async (req, res) => {
  const { id } = req.params;

  const removed = await store.removeStreamer(id);
  if (!removed) {
    return res.status(404).json({ error: "Streamer not found" });
  }

  // 204 No Content — success with no response body (standard for DELETE)
  res.status(204).send();
};
