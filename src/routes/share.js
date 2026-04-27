// ============================================================
// src/routes/share.js — sharable daily-guide links
// Mounted at /api/share. requireAuth is applied in index.js.
// ============================================================

const { Router } = require("express");
const shareController = require("../controllers/shareController");

const router = Router();

router.post("/",       shareController.createShare);
router.get("/:token",  shareController.viewShare);

module.exports = router;
