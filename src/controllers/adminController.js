// ============================================================
// src/controllers/adminController.js
//
// Aggregated stats for the admin dashboard. All queries run in
// parallel against PostgreSQL — no Stripe API calls (the
// pack_purchases audit table is the source of truth for revenue).
// ============================================================

const { pool } = require("../data/db");

// Run an array of [key, sqlText, params?] tuples in parallel and zip into an object.
async function runQueries(specs) {
  const results = await Promise.all(
    specs.map(([_key, sql, params]) => pool.query(sql, params ?? []))
  );
  const out = {};
  specs.forEach(([key], i) => { out[key] = results[i].rows; });
  return out;
}

exports.getStats = async (_req, res) => {
  const r = await runQueries([
    // ── Users ─────────────────────────────────────────────
    ["userTotals", `
      SELECT
        COUNT(*)::int                                                              AS "total",
        COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours')::int       AS "last24h",
        COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '7 days')::int         AS "last7d",
        COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '30 days')::int        AS "last30d",
        COUNT(*) FILTER (WHERE twitch_id IS NOT NULL)::int                          AS "withTwitch",
        COUNT(*) FILTER (WHERE total_xp > 0)::int                                   AS "withXp",
        COALESCE(SUM(total_xp), 0)::int                                             AS "totalXpAwarded",
        COALESCE(AVG(total_xp), 0)::float                                           AS "avgXp"
      FROM users
    `],
    ["signupsByDay", `
      SELECT TO_CHAR(date_trunc('day', created_at), 'YYYY-MM-DD') AS "day",
             COUNT(*)::int AS "count"
      FROM users
      WHERE created_at > NOW() - INTERVAL '30 days'
      GROUP BY 1
      ORDER BY 1
    `],
    ["topByXp", `
      SELECT id, name, email, total_xp AS "totalXp"
      FROM users
      WHERE total_xp > 0
      ORDER BY total_xp DESC
      LIMIT 10
    `],

    // ── Streamers (followed channels) ─────────────────────
    ["streamerTotals", `
      SELECT
        COUNT(*)::int                            AS "total",
        COUNT(DISTINCT user_id)::int             AS "uniqueUsers",
        COUNT(DISTINCT channel_id)::int          AS "uniqueChannels"
      FROM streamers
    `],
    ["streamersByPlatform", `
      SELECT platform, COUNT(*)::int AS "count"
      FROM streamers
      GROUP BY platform
      ORDER BY "count" DESC
    `],
    ["topFollowedStreamers", `
      SELECT display_name AS "displayName", platform, COUNT(*)::int AS "followers"
      FROM streamers
      GROUP BY display_name, platform
      ORDER BY "followers" DESC
      LIMIT 10
    `],

    // ── Schedule ──────────────────────────────────────────
    ["slotTotals", `
      SELECT
        COUNT(*)::int                                                                AS "total",
        COUNT(*) FILTER (WHERE start_time BETWEEN NOW() AND NOW() + INTERVAL '7 days')::int AS "upcoming7d",
        COUNT(*) FILTER (WHERE is_live)::int                                         AS "liveNow"
      FROM schedule_slots
    `],

    // ── Creator profiles ──────────────────────────────────
    ["creatorTotals", `
      SELECT
        COUNT(*)::int                                                  AS "total",
        COUNT(*) FILTER (WHERE platform = 'twitch')::int               AS "twitch",
        COUNT(*) FILTER (WHERE platform = 'youtube')::int              AS "youtube"
      FROM creator_profiles
    `],
    ["creatorsWithCredits", `
      SELECT COUNT(*)::int AS "count"
      FROM promotion_packs
      WHERE clicks_remaining > 0
    `],

    // ── Promotion / pack engagement ───────────────────────
    ["packEngagement", `
      SELECT
        COALESCE(SUM(views_remaining), 0)::int  AS "totalImpressions",
        COALESCE(SUM(clicks_total), 0)::int     AS "totalClicksUsed",
        COALESCE(SUM(clicks_remaining), 0)::int AS "totalClicksRemaining"
      FROM promotion_packs
    `],

    // ── Revenue ───────────────────────────────────────────
    ["revenueTotals", `
      SELECT
        COUNT(*)::int                                                                AS "totalPurchases",
        COUNT(*) FILTER (WHERE recipient_user_id IS NOT NULL)::int                   AS "giftPurchases",
        COUNT(*) FILTER (WHERE recipient_user_id IS NULL)::int                       AS "selfPurchases",
        COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '30 days')::int         AS "last30d",
        COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '7 days')::int          AS "last7d",
        COUNT(DISTINCT buyer_user_id)::int                                           AS "uniqueBuyers",
        COALESCE(SUM(amount_pence), 0)::int                                          AS "totalRevenuePence",
        COALESCE(SUM(amount_pence) FILTER (WHERE created_at > NOW() - INTERVAL '30 days'), 0)::int AS "revenueLast30dPence",
        COALESCE(SUM(clicks), 0)::int                                                AS "totalClicksSold"
      FROM pack_purchases
    `],
    ["purchasesByDay", `
      SELECT TO_CHAR(date_trunc('day', created_at), 'YYYY-MM-DD') AS "day",
             COUNT(*)::int                                        AS "count",
             COALESCE(SUM(amount_pence), 0)::int                  AS "pence"
      FROM pack_purchases
      WHERE created_at > NOW() - INTERVAL '30 days'
      GROUP BY 1
      ORDER BY 1
    `],
    ["topGiftedRecipients", `
      SELECT u.id, u.name, u.email, COUNT(*)::int AS "giftsReceived"
      FROM pack_purchases pp
      JOIN users u ON u.id = pp.recipient_user_id
      WHERE pp.recipient_user_id IS NOT NULL
      GROUP BY u.id, u.name, u.email
      ORDER BY "giftsReceived" DESC
      LIMIT 10
    `],
    ["topBuyers", `
      SELECT u.id, u.name, u.email,
             COUNT(*)::int                       AS "purchases",
             COALESCE(SUM(amount_pence), 0)::int AS "spentPence"
      FROM pack_purchases pp
      JOIN users u ON u.id = pp.buyer_user_id
      GROUP BY u.id, u.name, u.email
      ORDER BY "purchases" DESC
      LIMIT 10
    `],

    // ── Push notifications ────────────────────────────────
    ["pushTotals", `
      SELECT
        COUNT(*)::int                                              AS "totalTokens",
        COUNT(DISTINCT user_id)::int                               AS "uniqueUsers",
        COUNT(*) FILTER (WHERE platform = 'expo')::int             AS "expo"
      FROM push_tokens
    `],
  ]);

  res.json({
    generatedAt: new Date().toISOString(),
    users: {
      ...r.userTotals[0],
      signupsByDay: r.signupsByDay,
      topByXp:      r.topByXp,
    },
    streamers: {
      ...r.streamerTotals[0],
      byPlatform:  r.streamersByPlatform,
      topFollowed: r.topFollowedStreamers,
    },
    schedule: r.slotTotals[0],
    creators: {
      ...r.creatorTotals[0],
      withCreditsRemaining: r.creatorsWithCredits[0]?.count ?? 0,
    },
    promotion: r.packEngagement[0],
    revenue: {
      ...r.revenueTotals[0],
      purchasesByDay:      r.purchasesByDay,
      topGiftedRecipients: r.topGiftedRecipients,
      topBuyers:           r.topBuyers,
    },
    push: r.pushTotals[0],
  });
};
