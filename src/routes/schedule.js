// ============================================================
// src/routes/schedule.js — URL definitions for /api/schedule
//
// Mounted at /api/schedule in index.js, so all paths below
// are relative to that prefix.
// ============================================================

const { Router } = require("express");
const scheduleController = require("../controllers/scheduleController");

const router = Router();

// GET /api/schedule/week — weekly schedule grouped by date
// Important: this must come BEFORE /:id style routes to avoid
// the string "week" being parsed as an :id parameter.
router.get("/week", scheduleController.getWeek);

// GET /api/schedule — all slots with optional ?from=&to=&platform= filters
router.get("/", scheduleController.getAll);

// POST /api/schedule/refresh/:id — re-fetch schedule for one streamer
router.post("/refresh/:id", scheduleController.refresh);

module.exports = router;
