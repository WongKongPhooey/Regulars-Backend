// ============================================================
// src/controllers/creatorController.js
//
// Handles creator profile management, pack purchases via Stripe,
// and Stripe webhook for crediting views/clicks after payment.
// ============================================================

const store  = require("../data/store");
const { lookupStreamer } = require("../services/scheduleService");

const PACK_PRICE_ID = process.env.STRIPE_PACK_PRICE_ID; // created in Stripe dashboard

// Lazy-init Stripe — avoids crash at require time if env vars aren't loaded yet
let _stripe;
function getStripe() {
  if (!_stripe) _stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
  return _stripe;
}
const PACK_CLICKS   = 100;

// GET /api/creator/profile
exports.getProfile = async (req, res) => {
  const profile = await store.getCreatorProfile(req.user.userId);
  const balance  = await store.getPackBalance(req.user.userId);
  res.json({ profile, balance });
};

// POST /api/creator/profile — connect own channel
exports.connectChannel = async (req, res) => {
  const { platform, channelId } = req.body;
  if (!platform || !channelId) {
    return res.status(400).json({ error: "platform and channelId are required" });
  }

  const lookup = await lookupStreamer(platform, channelId).catch(() => null);
  if (!lookup) {
    return res.status(404).json({ error: "Channel not found on that platform" });
  }

  const profile = await store.upsertCreatorProfile({
    userId:      req.user.userId,
    platform,
    channelId:   lookup.channelId ?? channelId,
    channelUrl:  lookup.channelUrl,
    displayName: lookup.displayName,
    avatarUrl:   lookup.avatarUrl ?? null,
  });

  res.json(profile);
};

// POST /api/creator/checkout — create a Stripe Checkout session
exports.createCheckout = async (req, res) => {
  const session = await getStripe().checkout.sessions.create({
    mode:                "payment",
    payment_method_types: ["card"],
    line_items: [
      { price: PACK_PRICE_ID, quantity: 1 },
    ],
    metadata: { userId: req.user.userId },
    success_url: `${process.env.FRONTEND_URL}?payment=success`,
    cancel_url:  `${process.env.FRONTEND_URL}?payment=cancelled`,
  });
  res.json({ url: session.url });
};

// POST /api/creator/views — batch increment view counters
exports.trackViewBatch = async (req, res) => {
  const { creatorUserIds } = req.body;
  if (!Array.isArray(creatorUserIds) || !creatorUserIds.length) {
    return res.json({ ok: true, count: 0 });
  }
  await Promise.all(creatorUserIds.map((id) => store.incrementPackViews(id)));
  res.json({ ok: true, count: creatorUserIds.length });
};

// POST /api/creator/:creatorUserId/view — increment view counter (called on filler slot render)
exports.trackView = async (req, res) => {
  const { creatorUserId } = req.params;
  await store.incrementPackViews(creatorUserId);
  res.json({ ok: true });
};

// POST /api/creator/:creatorUserId/click — decrement click credit (called on filler slot tap)
exports.trackClick = async (req, res) => {
  const { creatorUserId } = req.params;
  await store.decrementPackClicks(creatorUserId);
  res.json({ ok: true });
};

// POST /api/creator/verify-payment — called by frontend after Stripe redirect
// Checks the most recent checkout session and credits the user if paid.
// This is a fallback for when the webhook hasn't fired yet (e.g. local dev).
exports.verifyPayment = async (req, res) => {
  const sessions = await getStripe().checkout.sessions.list({
    limit: 1,
  });

  const session = sessions.data.find(
    (s) => s.metadata?.userId === req.user.userId && s.payment_status === "paid"
  );

  if (!session) {
    return res.json({ credited: false });
  }

  // Check if we've already credited this session (store session ID to prevent double-credit)
  const balance = await store.getPackBalance(req.user.userId);
  if (balance.lastSessionId === session.id) {
    return res.json({ credited: false, balance });
  }

  await store.addPackCredits(req.user.userId, PACK_CLICKS, session.id);
  const updated = await store.getPackBalance(req.user.userId);
  console.log(`[creator] Verified payment — added ${PACK_CLICKS} clicks to user ${req.user.userId}`);
  res.json({ credited: true, balance: updated });
};

// POST /api/creator/webhook — Stripe sends events here (no auth middleware)
exports.webhook = async (req, res) => {
  const sig = req.headers["stripe-signature"];
  let event;
  try {
    event = getStripe().webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).send(`Webhook error: ${err.message}`);
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    const userId  = session.metadata?.userId;
    if (userId) {
      await store.addPackCredits(userId, PACK_CLICKS);
      console.log(`[creator] Added ${PACK_CLICKS} clicks to user ${userId}`);
    }
  }

  res.json({ received: true });
};
