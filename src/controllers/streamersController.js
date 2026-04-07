// ============================================================
// src/controllers/streamersController.js
//
// All streamer operations are scoped to req.user.userId so
// each user only sees and manages their own followed streamers.
// ============================================================

const store = require("../data/store");
const { fetchScheduleForStreamer, lookupStreamer } = require("../services/scheduleService");

function buildChannelUrl(platform, channelId) {
  if (platform === "twitch")  return `https://twitch.tv/${channelId}`;
  if (platform === "youtube") return `https://youtube.com/channel/${channelId}`;
  return null;
}

// GET /api/streamers
exports.getAll = async (req, res) => {
  const streamers = await store.getStreamersByUser(req.user.userId);
  res.json(streamers);
};

// POST /api/streamers
exports.create = async (req, res) => {
  const { displayName, platform, channelId, avatarUrl, color, personId } = req.body;
  const userId = req.user.userId;

  const existing = (await store.getStreamersByUser(userId)).find(
    (s) => s.platform === platform && s.channelId === channelId
  );
  if (existing) {
    return res.status(409).json({ error: "Already following this streamer" });
  }

  // If personId is supplied, verify it belongs to this user
  if (personId) {
    const person = (await store.getStreamersByUser(userId)).find(
      (s) => s.personId === personId
    );
    if (!person) {
      return res.status(400).json({ error: "Invalid personId" });
    }
  }

  const profile = await lookupStreamer(platform, channelId).catch(() => null);
  const resolvedAvatarUrl  = profile?.avatarUrl  || avatarUrl || null;
  const resolvedChannelUrl = profile?.channelUrl || buildChannelUrl(platform, channelId);

  const newStreamer = await store.addStreamer({
    userId,
    personId,   // undefined = new person, UUID = link to existing
    displayName,
    platform,
    channelId,
    channelUrl: resolvedChannelUrl,
    avatarUrl:  resolvedAvatarUrl,
    color,
  });

  fetchScheduleForStreamer(newStreamer)
    .then((slots) => store.refreshStreamerSchedule(newStreamer.id, slots))
    .catch((err) =>
      console.error(`[streamersController] Schedule fetch failed for ${displayName}:`, err.message)
    );

  res.status(201).json(newStreamer);
};

// DELETE /api/streamers/:id
exports.remove = async (req, res) => {
  const { id } = req.params;

  const removed = await store.removeStreamer(id, req.user.userId);
  if (!removed) {
    return res.status(404).json({ error: "Streamer not found" });
  }

  res.status(204).send();
};
