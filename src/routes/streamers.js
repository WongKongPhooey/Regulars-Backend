// ============================================================
// src/routes/streamers.js — URL definitions for /api/streamers
//
// A Router is a mini Express app — it groups related routes and
// is mounted at a base path in index.js.
//
// The pattern here is: validate → controller.
//   1. express-validator checks inputs before they hit the controller
//   2. The controller focuses purely on business logic (no raw validation)
// ============================================================

const { Router } = require("express");
const { body, validationResult } = require("express-validator");
const streamersController = require("../controllers/streamersController");

const router = Router();

// ── Validation middleware ─────────────────────────────────────
// Runs before the controller. If validation fails we return 422
// immediately so the controller never runs with bad data.
const validateStreamer = [
  body("displayName")
    .trim()
    .notEmpty().withMessage("displayName is required")
    .isLength({ max: 100 }).withMessage("displayName must be 100 chars or fewer"),

  body("platform")
    .trim()
    .notEmpty().withMessage("platform is required")
    .isIn(["twitch", "youtube"]).withMessage("platform must be 'twitch' or 'youtube'"),

  body("channelId")
    .trim()
    .notEmpty().withMessage("channelId is required"),

  body("channelUrl")
    .optional()
    .trim()
    .isURL().withMessage("channelUrl must be a valid URL"),

  body("color")
    .optional()
    .trim()
    .matches(/^#[0-9A-Fa-f]{6}$/).withMessage("color must be a hex colour e.g. #FF0000"),

  // Middleware that reads the validation result and short-circuits if invalid
  (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      // 422 Unprocessable Entity is the standard code for validation failures
      return res.status(422).json({ errors: errors.array() });
    }
    next();
  },
];

// ── Routes ───────────────────────────────────────────────────
// GET /api/streamers — list all followed streamers
router.get("/", streamersController.getAll);

// POST /api/streamers — follow a new streamer
// validateStreamer runs first; if it passes, the controller runs
router.post("/", validateStreamer, streamersController.create);

// DELETE /api/streamers/:id — unfollow a streamer
// :id becomes req.params.id in the controller
router.delete("/:id", streamersController.remove);

module.exports = router;
