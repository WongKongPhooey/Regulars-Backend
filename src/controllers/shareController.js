// ============================================================
// src/controllers/shareController.js
//
// Sharable read-only links for a single day's guide.
// Tokens map to (userId, date); the slot list is fetched live
// at view time so the link reflects the sharer's current schedule.
// ============================================================

const crypto = require("crypto");
const store = require("../data/store");

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// POST /api/share — body: { date: "YYYY-MM-DD" }
exports.createShare = async (req, res) => {
  const { date } = req.body;
  if (!date || !DATE_RE.test(date)) {
    return res.status(400).json({ error: "date must be YYYY-MM-DD" });
  }

  const token = crypto.randomBytes(16).toString("hex");
  await store.createSharedGuide({
    userId:    req.user.userId,
    token,
    guideDate: date,
  });

  res.json({ token });
};

// GET /api/share/:token — auth required (any signed-in user can view)
exports.viewShare = async (req, res) => {
  const share = await store.getSharedGuide(req.params.token);
  if (!share) return res.status(404).json({ error: "Share not found" });

  const from = new Date(`${share.guideDate}T00:00:00.000Z`);
  const to   = new Date(`${share.guideDate}T23:59:59.999Z`);

  const slots = await store.getSlotsByDateRange(from, to, share.userId);
  const owner = await store.getUserById(share.userId);

  slots.sort((a, b) => new Date(a.startTime) - new Date(b.startTime));

  res.json({
    date:  share.guideDate,
    owner: owner ? { name: owner.name, avatarUrl: owner.avatarUrl } : null,
    slots,
  });
};
