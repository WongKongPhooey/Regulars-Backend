// ============================================================
// src/index.js — Entry point for the Express server
// This file boots up the app, connects middleware, and starts
// listening for incoming HTTP requests.
// ============================================================

// Load environment variables from .env file (e.g. PORT, API keys)
require("dotenv").config();

const express = require("express");
const cors = require("cors");

// Import our route modules (defined in /routes/)
const streamerRoutes = require("./routes/streamers");
const scheduleRoutes = require("./routes/schedule");
const platformRoutes = require("./routes/platforms");
const authRoutes     = require("./routes/auth");
const creatorRoutes  = require("./routes/creator");
const discoverRoutes      = require("./routes/discover");
const notificationRoutes  = require("./routes/notifications");
const adminRoutes         = require("./routes/admin");

const { requireAuth } = require("./middleware/auth");

const store = require("./data/store");
const { initDb } = require("./data/db");
const { fetchSchedulesForAll } = require("./services/scheduleService");
const { startNotificationScheduler } = require("./services/notificationService");

const app = express();
const PORT = process.env.PORT || 3001;

// ── Middleware ───────────────────────────────────────────────

app.use(cors());

// Stripe webhook needs raw body — must be registered BEFORE express.json()
app.use(
  "/api/creator/webhook",
  express.raw({ type: "application/json" })
);

app.use(express.json());

// Simple request logger — logs method + URL for every request.
// Useful during development to see what's being called.
app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next(); // Always call next() to pass control to the next middleware/route
});

// ── Routes ───────────────────────────────────────────────────
// Auth routes are public — no JWT needed to sign in.
app.use("/api/auth", authRoutes);

// API routes require a valid JWT (requireAuth attaches req.user).
// Platforms are static config so they stay public.
app.use("/api/streamers", requireAuth, streamerRoutes);
app.use("/api/schedule",  requireAuth, scheduleRoutes);
app.use("/api/platforms", platformRoutes);
app.use("/api/creator",  creatorRoutes);
app.use("/api/discover",       requireAuth, discoverRoutes);
app.use("/api/notifications",  requireAuth, notificationRoutes);
app.use("/api/admin",          adminRoutes);

// ── Health check ─────────────────────────────────────────────
// A simple endpoint to confirm the server is running.
// Hit http://localhost:3001/health to verify.
app.get("/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// ── 404 handler ──────────────────────────────────────────────
// If no route matched, send a 404. The order matters — this must
// come AFTER all app.use() route registrations.
app.use((_req, res) => {
  res.status(404).json({ error: "Route not found" });
});

// ── Global error handler ─────────────────────────────────────
// Express recognises error-handling middleware by the 4-argument
// signature (err, req, res, next). Any route that calls next(err)
// will land here.
app.use((err, _req, res, _next) => {
  console.error("Unhandled error:", err);
  res.status(500).json({ error: "Internal server error" });
});

// ── Start listening ──────────────────────────────────────────
// Initialise the database (creates tables if needed) before
// accepting requests, then kick off the schedule refresh.
initDb()
  .then(() => {
    console.log("✅ Database ready");
    app.listen(PORT, "0.0.0.0", () => {
      console.log(`✅ Regulars API running on http://localhost:${PORT}`);

      startNotificationScheduler();

      store.getAllStreamers()
        .then((streamers) => fetchSchedulesForAll(streamers))
        .then((slots) => {
          const byStreamer = {};
          slots.forEach((slot) => {
            if (!byStreamer[slot.streamerId]) byStreamer[slot.streamerId] = [];
            byStreamer[slot.streamerId].push(slot);
          });
          return Promise.all(
            Object.entries(byStreamer).map(([streamerId, streamerSlots]) =>
              store.refreshStreamerSchedule(streamerId, streamerSlots)
            )
          ).then(() =>
            console.log(`📅 Loaded ${slots.length} schedule slots for ${Object.keys(byStreamer).length} streamers`)
          );
        })
        .catch((err) => console.error("❌ Startup schedule fetch failed:", err.message));
    });
  })
  .catch((err) => {
    console.error("❌ Failed to initialise database:", err.message);
    process.exit(1);
  });
