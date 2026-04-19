const store = require("../data/store");

// POST /api/notifications/register — save push token for this user
exports.register = async (req, res) => {
  const { token, platform } = req.body;
  if (!token) return res.status(400).json({ error: "token is required" });

  await store.savePushToken(req.user.userId, token, platform ?? "expo");
  res.json({ ok: true });
};

// POST /api/notifications/unregister — remove a push token
exports.unregister = async (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: "token is required" });

  await store.removePushToken(token);
  res.json({ ok: true });
};
