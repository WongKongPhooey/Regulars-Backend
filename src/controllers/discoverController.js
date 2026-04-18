const { getDiscoverList } = require("../services/discoverService");

exports.getDiscover = async (req, res) => {
  try {
    const results = await getDiscoverList(req.user.userId);
    res.json(results);
  } catch (err) {
    console.error("[discover] Error:", err.message);
    res.status(500).json({ error: "Could not load discover list" });
  }
};
