// ============================================================
// src/controllers/scheduleController.js
// ============================================================

const store = require("../data/store");
const { fetchScheduleForStreamer } = require("../services/scheduleService");

// GET /api/schedule/week
// Returns slots for the next 7 days, keyed by date string "YYYY-MM-DD".
// The frontend consumes this shape directly for both view modes.
exports.getWeek = async (_req, res) => {
  const now  = new Date();
  const from = new Date(now);
  from.setHours(0, 0, 0, 0);

  const to = new Date(from);
  to.setDate(from.getDate() + 7);

  const slots = await store.getSlotsByDateRange(from, to);

  // Group slots by date key so the frontend can look up by day
  const grouped = {};
  slots.forEach((slot) => {
    const key = slot.startTime.slice(0, 10); // "YYYY-MM-DD"
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(slot);
  });

  // Sort each day's slots chronologically
  Object.values(grouped).forEach((day) =>
    day.sort((a, b) => new Date(a.startTime) - new Date(b.startTime))
  );

  res.json(grouped);
};

// GET /api/schedule?from=ISO&to=ISO&platform=twitch
// Returns a flat array of slots, optionally filtered.
exports.getAll = async (req, res) => {
  const { from, to, platform } = req.query;

  let slots = await store.getAllSlots();

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
// Re-fetches the real schedule for a single streamer from their platform API.
exports.refresh = async (req, res) => {
  const { id } = req.params;

  const streamer = await store.getStreamerById(id);
  if (!streamer) {
    return res.status(404).json({ error: "Streamer not found" });
  }

  const newSlots = await fetchScheduleForStreamer(streamer);
  await store.refreshStreamerSchedule(id, newSlots);

  res.json({ refreshed: newSlots.length, slots: newSlots });
};
