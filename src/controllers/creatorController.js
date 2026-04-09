// ============================================================
// src/controllers/creatorController.js
//
// Handles creator profile management, pack purchases via Stripe,
// and Stripe webhook for crediting views/clicks after payment.
// ============================================================

const store  = require("../data/store");
const { lookupStreamer } = require("../services/scheduleService");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

const PACK_PRICE_ID = process.env.STRIPE_PACK_PRICE_ID; // created in Stripe dashboard
const PACK_VIEWS    = 1000;
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
  const session = await stripe.checkout.sessions.create({
    mode:                "payment",
    payment_method_types: ["card"],
    line_items: [
      { price: PACK_PRICE_ID, quantity: 1 },
    ],
    metadata: { userId: req.user.userId },
    success_url: `${process.env.FRONTEND_URL}/settings?payment=success`,
    cancel_url:  `${process.env.FRONTEND_URL}/settings?payment=cancelled`,
  });
  res.json({ url: session.url });
};

// POST /api/creator/:creatorUserId/view — decrement view credit (called on filler slot render)
exports.trackView = async (req, res) => {
  const { creatorUserId } = req.params;
  await store.decrementPackViews(creatorUserId);
  res.json({ ok: true });
};

// POST /api/creator/:creatorUserId/click — decrement click credit (called on filler slot tap)
exports.trackClick = async (req, res) => {
  const { creatorUserId } = req.params;
  await store.decrementPackClicks(creatorUserId);
  res.json({ ok: true });
};

// POST /api/creator/webhook — Stripe sends events here (no auth middleware)
exports.webhook = async (req, res) => {
  const sig = req.headers["stripe-signature"];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).send(`Webhook error: ${err.message}`);
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    const userId  = session.metadata?.userId;
    if (userId) {
      await store.addPackCredits(userId, PACK_VIEWS, PACK_CLICKS);
      console.log(`[creator] Added ${PACK_VIEWS} views + ${PACK_CLICKS} clicks to user ${userId}`);
    }
  }

  res.json({ received: true });
};
