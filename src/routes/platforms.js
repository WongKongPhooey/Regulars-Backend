// ============================================================
// src/routes/platforms.js — URL definitions for /api/platforms
// ============================================================

const { Router } = require("express");
const platformsController = require("../controllers/platformsController");

const router = Router();

// GET /api/platforms — list all supported platforms
router.get("/", platformsController.getAll);

module.exports = router;
