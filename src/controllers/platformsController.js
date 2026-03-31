// ============================================================
// src/controllers/platformsController.js
// ============================================================

const store = require("../data/store");

// GET /api/platforms
// Returns the PLATFORMS map as an array so the frontend can
// iterate it without knowing the object keys in advance.
exports.getAll = (_req, res) => {
  const platforms = Object.values(store.PLATFORMS);
  res.json(platforms);
};
