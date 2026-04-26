const { Router } = require("express");
const { requireAuth } = require("../middleware/auth");
const { requireAdmin } = require("../middleware/admin");
const adminController = require("../controllers/adminController");

const router = Router();

router.get("/stats", requireAuth, requireAdmin, adminController.getStats);

module.exports = router;
