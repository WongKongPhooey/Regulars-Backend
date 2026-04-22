const { Router } = require("express");
const { requireAuth } = require("../middleware/auth");
const creatorController = require("../controllers/creatorController");

const router = Router();

// Stripe webhook must receive raw body — mounted separately in index.js
router.post("/webhook", creatorController.webhook);

// All other routes require auth
router.get("/profile",                    requireAuth, creatorController.getProfile);
router.post("/profile",                   requireAuth, creatorController.connectChannel);
router.get("/search",                     requireAuth, creatorController.searchCreators);
router.post("/checkout",                  requireAuth, creatorController.createCheckout);
router.post("/verify-payment",            requireAuth, creatorController.verifyPayment);
router.post("/views",                     requireAuth, creatorController.trackViewBatch);
router.post("/:creatorUserId/view",       requireAuth, creatorController.trackView);
router.post("/:creatorUserId/click",      requireAuth, creatorController.trackClick);

module.exports = router;
