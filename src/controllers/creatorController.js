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

// GET /api/creator/search?q= — find creators to gift a pack to
exports.searchCreators = async (req, res) => {
  const q = (req.query.q ?? "").trim();
  if (q.length < 2) return res.json([]);
  const results = await store.searchCreatorProfiles(q, 20);
  // Never return the buyer themselves as a gift target
  const filtered = results.filter((r) => r.userId !== req.user.userId);
  res.json(filtered);
};

// POST /api/creator/checkout — create a Stripe Checkout session
// Body:
//   recipientUserId?   — if present, credits that creator instead of the buyer (gift)
//   consentImmediate?  — UK consumer-law waiver of the 14-day cooling-off period
//                        for digital goods. Required for the pack to be usable
//                        immediately after payment.
exports.createCheckout = async (req, res) => {
  const { recipientUserId, consentImmediate } = req.body ?? {};

  if (!consentImmediate) {
    return res.status(400).json({
      error: "You must waive the 14-day cooling-off period to receive your pack immediately.",
    });
  }

  // Validate recipient if present — must be a creator with a profile
  if (recipientUserId) {
    if (recipientUserId === req.user.userId) {
      return res.status(400).json({ error: "You can't gift a pack to yourself." });
    }
    const recipientProfile = await store.getCreatorProfile(recipientUserId);
    if (!recipientProfile) {
      return res.status(404).json({ error: "Recipient is not a connected creator." });
    }
  }

  const metadata = {
    userId: req.user.userId,
    consentImmediate: "true",
  };
  if (recipientUserId) metadata.recipientUserId = recipientUserId;

  const session = await getStripe().checkout.sessions.create({
    mode:                "payment",
    payment_method_types: ["card"],
    line_items: [
      { price: PACK_PRICE_ID, quantity: 1 },
    ],
    metadata,
    success_url: `${process.env.FRONTEND_URL}?payment=success`,
    cancel_url:  `${process.env.FRONTEND_URL}?payment=cancelled`,
  });
  res.json({ url: session.url });
};

// POST /api/creator/pause — pause/resume boosting of own channel
// Body: { isPaused: boolean }
exports.setPaused = async (req, res) => {
  const { isPaused } = req.body ?? {};
  if (typeof isPaused !== "boolean") {
    return res.status(400).json({ error: "isPaused (boolean) is required" });
  }
  const balance = await store.setPackPaused(req.user.userId, isPaused);
  if (!balance) {
    return res.status(404).json({ error: "No pack to pause/resume — buy a pack first." });
  }
  res.json({ balance });
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
    limit: 5,
  });

  const session = sessions.data.find(
    (s) => s.metadata?.userId === req.user.userId && s.payment_status === "paid"
  );

  if (!session) {
    return res.json({ credited: false });
  }

  // Gifts credit the recipient; ordinary packs credit the buyer.
  const creditedUserId = session.metadata?.recipientUserId || req.user.userId;

  // Check if we've already credited this session (store session ID to prevent double-credit)
  const balance = await store.getPackBalance(creditedUserId);
  if (balance.lastSessionId === session.id) {
    const buyerBalance = await store.getPackBalance(req.user.userId);
    return res.json({ credited: false, balance: buyerBalance });
  }

  await store.addPackCredits(creditedUserId, PACK_CLICKS, session.id);
  await store.recordPackPurchase({
    buyerUserId:      req.user.userId,
    recipientUserId:  session.metadata?.recipientUserId || null,
    sessionId:        session.id,
    clicks:           PACK_CLICKS,
    amountPence:      session.amount_total ?? null,
    currency:         session.currency ?? null,
    consentImmediate: session.metadata?.consentImmediate === "true",
  });
  const updated = await store.getPackBalance(req.user.userId);
  if (session.metadata?.recipientUserId) {
    console.log(`[creator] Verified gift — added ${PACK_CLICKS} clicks to recipient ${creditedUserId} (buyer ${req.user.userId})`);
  } else {
    console.log(`[creator] Verified payment — added ${PACK_CLICKS} clicks to user ${creditedUserId}`);
  }
  res.json({ credited: true, balance: updated, gifted: !!session.metadata?.recipientUserId });
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
    const buyerId    = session.metadata?.userId;
    const recipientId = session.metadata?.recipientUserId;
    const creditedId = recipientId || buyerId;
    if (creditedId) {
      await store.addPackCredits(creditedId, PACK_CLICKS, session.id);
      await store.recordPackPurchase({
        buyerUserId:      buyerId,
        recipientUserId:  recipientId || null,
        sessionId:        session.id,
        clicks:           PACK_CLICKS,
        amountPence:      session.amount_total ?? null,
        currency:         session.currency ?? null,
        consentImmediate: session.metadata?.consentImmediate === "true",
      });
      if (recipientId) {
        console.log(`[creator] Gift — added ${PACK_CLICKS} clicks to recipient ${recipientId} (buyer ${buyerId})`);
      } else {
        console.log(`[creator] Added ${PACK_CLICKS} clicks to user ${buyerId}`);
      }
    }
  }

  res.json({ received: true });
};
