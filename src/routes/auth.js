// ============================================================
// src/routes/auth.js — URL definitions for /api/auth
// ============================================================

const { Router } = require("express");
const { requireAuth } = require("../middleware/auth");
const authController = require("../controllers/authController");

const router = Router();

// POST /api/auth/google — exchange a Google ID token for a JWT
router.post("/google", authController.googleSignIn);

// GET /api/auth/me — return the current user's profile (requires JWT)
router.get("/me", requireAuth, authController.me);

// GET /api/auth/xp — return the current user's XP and level info
router.get("/xp", requireAuth, authController.getXp);

// POST /api/auth/twitch/connect — validate Twitch token + store it (requires JWT)
router.post("/twitch/connect", requireAuth, authController.twitchConnect);

// POST /api/auth/twitch/import — import Twitch followed channels as streamers (requires JWT)
router.post("/twitch/import", requireAuth, authController.twitchImport);

module.exports = router;
