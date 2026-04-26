// ============================================================
// src/middleware/admin.js — Admin gate
//
// Reads ADMIN_EMAILS env var (comma-separated). Looks up the
// signed-in user's email and 403s anyone not on the list.
// ============================================================

const store = require("../data/store");

function getAdminEmails() {
  return (process.env.ADMIN_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

async function isAdminUser(userId) {
  if (!userId) return false;
  const allowed = getAdminEmails();
  if (!allowed.length) return false;
  const user = await store.getUserById(userId);
  return !!user && allowed.includes(user.email.toLowerCase());
}

async function requireAdmin(req, res, next) {
  const ok = await isAdminUser(req.user?.userId);
  if (!ok) return res.status(403).json({ error: "Admin only" });
  next();
}

module.exports = { requireAdmin, isAdminUser };
