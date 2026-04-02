// ============================================================
// src/controllers/scheduleController.js
//
// All schedule queries are scoped to req.user.userId so each
// user only sees slots for their own followed streamers.
// ============================================================

const store = require("../data/store");
const { fetchScheduleForStreamer } = require("../services/scheduleService");

// GET /api/schedule/week
exports.getWeek = async (req, res) => {
  const now  = new Date();
  const from = new Date(now);
  from.setHours(0, 0, 0, 0);

  const to = new Date(from);
  to.setDate(from.getDate() + 7);

  const slots = await store.getSlotsByDateRange(from, to, req.user.userId);

  const grouped = {};
  slots.forEach((slot) => {
    const key = slot.startTime.slice(0, 10);
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(slot);
  });

  Object.values(grouped).forEach((day) =>
    day.sort((a, b) => new Date(a.startTime) - new Date(b.startTime))
  );

  res.json(grouped);
};

// GET /api/schedule?from=ISO&to=ISO&platform=twitch
exports.getAll = async (req, res) => {
  const { from, to, platform } = req.query;

  let slots = await store.getSlotsByUser(req.user.userId);

  if (from) {
    const fromDate = new Date(from);
    if (!isNaN(fromDate)) slots = slots.filter((s) => new Date(s.startTime) >= fromDate);
  }
  if (to) {
    const toDate = new Date(to);
    if (!isNaN(toDate)) slots = slots.filter((s) => new Date(s.startTime) <= toDate);
  }
  if (platform) {
    slots = slots.filter((s) => s.platform === platform);
  }

  res.json(slots);
};

// POST /api/schedule/refresh/:id
exports.refresh = async (req, res) => {
  const { id } = req.params;

  const streamer = await store.getStreamerById(id);
  if (!streamer || streamer.userId !== req.user.userId) {
    return res.status(404).json({ error: "Streamer not found" });
  }

  const newSlots = await fetchScheduleForStreamer(streamer);
  await store.refreshStreamerSchedule(id, newSlots);

  res.json({ refreshed: newSlots.length, slots: newSlots });
};
