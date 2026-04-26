// ============================================================
// src/data/store.js — PostgreSQL-backed data store
// ============================================================

const { v4: uuidv4 } = require("uuid");
const { pool } = require("./db");

// ── Supported platforms (static config — no DB needed) ───────
const PLATFORMS = {
  twitch: {
    id: "twitch",
    name: "Twitch",
    color: "#9146FF",
    icon: "twitch",
    baseUrl: "https://twitch.tv",
  },
  youtube: {
    id: "youtube",
    name: "YouTube",
    color: "#FF0000",
    icon: "youtube",
    baseUrl: "https://youtube.com",
  },
};

// ── Row mappers ───────────────────────────────────────────────
function rowToUser(row) {
  return {
    id:                   row.id,
    email:                row.email,
    name:                 row.name,
    avatarUrl:            row.avatar_url,
    twitchId:             row.twitch_id,
    youtubeConnected:     !!row.youtube_access_token,
    termsVersionAccepted: row.terms_version_accepted ?? null,
    termsAcceptedAt:      row.terms_accepted_at instanceof Date ? row.terms_accepted_at.toISOString() : (row.terms_accepted_at ?? null),
    createdAt:            row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
  };
}

function rowToStreamer(row) {
  return {
    id:          row.id,
    personId:    row.person_id ?? row.id,
    userId:      row.user_id,
    displayName: row.display_name,
    platform:    row.platform,
    channelId:   row.channel_id,
    channelUrl:  row.channel_url,
    avatarUrl:   row.avatar_url,
    color:       row.color,
    addedAt:     row.added_at instanceof Date ? row.added_at.toISOString() : row.added_at,
  };
}

function rowToSlot(row) {
  return {
    id:            row.id,
    streamerId:    row.streamer_id,
    streamerName:  row.streamer_name,
    streamerColor: row.streamer_color ?? null,
    platform:      row.platform,
    title:         row.title,
    category:      row.category,
    startTime:     row.start_time instanceof Date ? row.start_time.toISOString() : row.start_time,
    endTime:       row.end_time instanceof Date   ? row.end_time.toISOString()   : row.end_time,
    channelUrl:    row.channel_url,
    isLive:        row.is_live,
    thumbnailUrl:  row.thumbnail_url,
  };
}

// ── User CRUD ─────────────────────────────────────────────────

async function findOrCreateUser({ googleId, email, name, avatarUrl }) {
  const { rows: existing } = await pool.query(
    "SELECT * FROM users WHERE google_id = $1",
    [googleId]
  );
  if (existing[0]) return { user: rowToUser(existing[0]), created: false };

  const id = uuidv4();
  const { rows } = await pool.query(
    `INSERT INTO users (id, google_id, email, name, avatar_url)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [id, googleId, email, name, avatarUrl]
  );
  return { user: rowToUser(rows[0]), created: true };
}

async function countUsers() {
  const { rows } = await pool.query("SELECT COUNT(*)::int AS count FROM users");
  return rows[0]?.count ?? 0;
}

async function getUserById(id) {
  const { rows } = await pool.query(
    "SELECT * FROM users WHERE id = $1",
    [id]
  );
  return rows[0] ? rowToUser(rows[0]) : null;
}

async function updateUserTwitch(userId, { twitchId, accessToken, refreshToken }) {
  const { rows } = await pool.query(
    `UPDATE users
     SET twitch_id = $1, twitch_access_token = $2, twitch_refresh_token = $3
     WHERE id = $4
     RETURNING *`,
    [twitchId, accessToken, refreshToken, userId]
  );
  return rows[0] ? rowToUser(rows[0]) : null;
}

// Returns raw Twitch tokens — used internally, never sent to client.
async function getUserTwitchTokens(userId) {
  const { rows } = await pool.query(
    "SELECT twitch_access_token, twitch_refresh_token, twitch_id FROM users WHERE id = $1",
    [userId]
  );
  if (!rows[0]) return null;
  return {
    twitchId:     rows[0].twitch_id,
    accessToken:  rows[0].twitch_access_token,
    refreshToken: rows[0].twitch_refresh_token,
  };
}

async function updateUserYoutube(userId, { accessToken, refreshToken }) {
  // Preserve a previously stored refresh_token if Google didn't return a fresh one
  // (it only returns refresh_token on first consent unless we re-prompt with prompt=consent).
  const { rows } = await pool.query(
    `UPDATE users
     SET youtube_access_token  = $1,
         youtube_refresh_token = COALESCE($2, youtube_refresh_token),
         youtube_connected_at  = NOW()
     WHERE id = $3
     RETURNING *`,
    [accessToken, refreshToken ?? null, userId]
  );
  return rows[0] ? rowToUser(rows[0]) : null;
}

async function getUserYoutubeTokens(userId) {
  const { rows } = await pool.query(
    "SELECT youtube_access_token, youtube_refresh_token FROM users WHERE id = $1",
    [userId]
  );
  if (!rows[0]) return null;
  return {
    accessToken:  rows[0].youtube_access_token,
    refreshToken: rows[0].youtube_refresh_token,
  };
}

// ── Streamer CRUD ─────────────────────────────────────────────

// Returns ALL streamers across all users — only used internally for startup schedule refresh.
async function getAllStreamers() {
  const { rows } = await pool.query(
    "SELECT * FROM streamers ORDER BY added_at"
  );
  return rows.map(rowToStreamer);
}

// Returns streamers belonging to a specific user — used by controllers.
async function getStreamersByUser(userId) {
  const { rows } = await pool.query(
    "SELECT * FROM streamers WHERE user_id = $1 ORDER BY added_at",
    [userId]
  );
  return rows.map(rowToStreamer);
}

async function getStreamerById(id) {
  const { rows } = await pool.query(
    "SELECT * FROM streamers WHERE id = $1",
    [id]
  );
  return rows[0] ? rowToStreamer(rows[0]) : null;
}

async function addStreamer(data) {
  const id = uuidv4();
  // person_id defaults to this streamer's own id unless linking to an existing person
  const personId = data.personId ?? id;
  const { rows } = await pool.query(
    `INSERT INTO streamers (id, person_id, user_id, display_name, platform, channel_id, channel_url, avatar_url, color)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING *`,
    [id, personId, data.userId, data.displayName, data.platform, data.channelId, data.channelUrl, data.avatarUrl, data.color ?? '#6B6B88']
  );
  return rowToStreamer(rows[0]);
}

async function removeStreamer(id, userId) {
  // Only deletes if the streamer belongs to the requesting user
  const { rowCount } = await pool.query(
    "DELETE FROM streamers WHERE id = $1 AND user_id = $2",
    [id, userId]
  );
  return rowCount > 0;
}

// ── Schedule queries ──────────────────────────────────────────

const SLOT_SELECT = `
  SELECT ss.id, ss.streamer_id, ss.streamer_name, ss.platform, ss.title, ss.category,
         ss.start_time, ss.end_time, ss.channel_url, ss.is_live, ss.thumbnail_url,
         s.color AS streamer_color
  FROM schedule_slots ss
  JOIN streamers s ON s.id = ss.streamer_id
`;

// Returns ALL slots across all users — only used internally.
async function getAllSlots() {
  const { rows } = await pool.query(SLOT_SELECT);
  return rows.map(rowToSlot);
}

// Returns slots belonging to a specific user's streamers.
async function getSlotsByUser(userId) {
  const { rows } = await pool.query(
    `${SLOT_SELECT} WHERE s.user_id = $1`,
    [userId]
  );
  return rows.map(rowToSlot);
}

async function getSlotsByStreamer(streamerId) {
  const { rows } = await pool.query(
    `${SLOT_SELECT} WHERE ss.streamer_id = $1`,
    [streamerId]
  );
  return rows.map(rowToSlot);
}

async function getSlotsByDateRange(from, to, userId) {
  const { rows } = await pool.query(
    `${SLOT_SELECT} WHERE s.user_id = $1 AND ss.start_time >= $2 AND ss.start_time <= $3`,
    [userId, from, to]
  );
  return rows.map(rowToSlot);
}

async function refreshStreamerSchedule(streamerId, newSlots) {
  await pool.query(
    "DELETE FROM schedule_slots WHERE streamer_id = $1",
    [streamerId]
  );

  for (const slot of newSlots) {
    await pool.query(
      `INSERT INTO schedule_slots
         (id, streamer_id, streamer_name, platform, title, category,
          start_time, end_time, channel_url, is_live, thumbnail_url)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        slot.id,
        slot.streamerId,
        slot.streamerName,
        slot.platform,
        slot.title,
        slot.category,
        slot.startTime,
        slot.endTime,
        slot.channelUrl,
        slot.isLive,
        slot.thumbnailUrl ?? null,
      ]
    );
  }
}

// ── Creator profiles ──────────────────────────────────────────

function rowToCreator(row) {
  return {
    id:          row.id,
    userId:      row.user_id,
    platform:    row.platform,
    channelId:   row.channel_id,
    channelUrl:  row.channel_url,
    displayName: row.display_name,
    avatarUrl:   row.avatar_url,
    createdAt:   row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
  };
}

async function getCreatorProfile(userId) {
  const { rows } = await pool.query(
    "SELECT * FROM creator_profiles WHERE user_id = $1",
    [userId]
  );
  return rows[0] ? rowToCreator(rows[0]) : null;
}

// Search creator profiles by display name (case-insensitive, prefix-like).
// Used by the gift-a-pack feature to find recipients.
async function searchCreatorProfiles(query, limit = 20) {
  const q = `%${query.toLowerCase()}%`;
  const { rows } = await pool.query(
    `SELECT * FROM creator_profiles
     WHERE LOWER(display_name) LIKE $1
     ORDER BY display_name
     LIMIT $2`,
    [q, limit]
  );
  return rows.map(rowToCreator);
}

async function upsertCreatorProfile(data) {
  const id = uuidv4();
  const { rows } = await pool.query(
    `INSERT INTO creator_profiles (id, user_id, platform, channel_id, channel_url, display_name, avatar_url)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (user_id) DO UPDATE SET
       platform     = EXCLUDED.platform,
       channel_id   = EXCLUDED.channel_id,
       channel_url  = EXCLUDED.channel_url,
       display_name = EXCLUDED.display_name,
       avatar_url   = EXCLUDED.avatar_url
     RETURNING *`,
    [id, data.userId, data.platform, data.channelId, data.channelUrl, data.displayName, data.avatarUrl ?? null]
  );
  return rowToCreator(rows[0]);
}

// ── Promotion packs ───────────────────────────────────────────

function rowToPack(row) {
  return {
    id:               row.id,
    userId:           row.user_id,
    totalViews:       row.views_remaining,   // repurposed: counts UP (impressions since pack purchase)
    clicksRemaining:  row.clicks_remaining,
    clicksTotal:      row.clicks_total ?? 0, // total clicks received (counts UP)
    isPaused:         row.is_paused ?? true,
    lastSessionId:    row.last_session_id ?? null,
    updatedAt:        row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
  };
}

async function getPackBalance(userId) {
  const { rows } = await pool.query(
    "SELECT * FROM promotion_packs WHERE user_id = $1",
    [userId]
  );
  return rows[0] ? rowToPack(rows[0]) : { totalViews: 0, clicksRemaining: 0, clicksTotal: 0, isPaused: true };
}

async function setPackPaused(userId, isPaused) {
  const { rows } = await pool.query(
    `UPDATE promotion_packs
     SET is_paused = $1, updated_at = NOW()
     WHERE user_id = $2
     RETURNING *`,
    [!!isPaused, userId]
  );
  return rows[0] ? rowToPack(rows[0]) : null;
}

// Called by Stripe webhook or verify-payment after successful payment.
// Resets views to 0 (new tracking period) and adds clicks.
async function addPackCredits(userId, clicks, sessionId = null) {
  const id = uuidv4();
  const { rows } = await pool.query(
    `INSERT INTO promotion_packs (id, user_id, views_remaining, clicks_remaining, last_session_id)
     VALUES ($1, $2, 0, $3, $4)
     ON CONFLICT (user_id) DO UPDATE SET
       views_remaining  = 0,
       clicks_remaining = promotion_packs.clicks_remaining + EXCLUDED.clicks_remaining,
       last_session_id  = COALESCE(EXCLUDED.last_session_id, promotion_packs.last_session_id),
       updated_at       = NOW()
     RETURNING *`,
    [id, userId, clicks, sessionId]
  );
  return rowToPack(rows[0]);
}

// Increment view count (impression tracking — not a balance, just a counter)
async function incrementPackViews(userId) {
  await pool.query(
    `UPDATE promotion_packs
     SET views_remaining = views_remaining + 1, updated_at = NOW()
     WHERE user_id = $1`,
    [userId]
  );
}

// Decrement click credit — floor at 0; also increment total clicks counter
async function decrementPackClicks(userId) {
  await pool.query(
    `UPDATE promotion_packs
     SET clicks_remaining = GREATEST(clicks_remaining - 1, 0),
         clicks_total     = clicks_total + 1,
         updated_at       = NOW()
     WHERE user_id = $1 AND clicks_remaining > 0`,
    [userId]
  );
}

// Returns paid creators with click credits remaining,
// excluding those already followed by the requesting user.
async function getActivePaidCreators(excludeChannelIds = []) {
  const { rows } = await pool.query(
    `SELECT cp.*, pp.views_remaining, pp.clicks_remaining
     FROM creator_profiles cp
     JOIN promotion_packs pp ON pp.user_id = cp.user_id
     WHERE pp.clicks_remaining > 0
       AND pp.is_paused = FALSE`
  );
  const excluded = new Set(excludeChannelIds);
  return rows
    .filter((r) => !excluded.has(r.channel_id))
    .map((r) => ({ ...rowToCreator(r), totalViews: r.views_remaining, clicksRemaining: r.clicks_remaining }));
}

// ── Push notification tokens ──────────────────────────────────

async function savePushToken(userId, token, platform = "expo") {
  const id = uuidv4();
  await pool.query(
    `INSERT INTO push_tokens (id, user_id, token, platform)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (token) DO UPDATE SET user_id = EXCLUDED.user_id`,
    [id, userId, token, platform]
  );
}

async function removePushToken(token) {
  await pool.query("DELETE FROM push_tokens WHERE token = $1", [token]);
}

async function getPushTokensByUser(userId) {
  const { rows } = await pool.query(
    "SELECT token, platform FROM push_tokens WHERE user_id = $1",
    [userId]
  );
  return rows;
}

async function getAllPushTokensGroupedByUser() {
  const { rows } = await pool.query(
    "SELECT user_id, token, platform FROM push_tokens ORDER BY user_id"
  );
  const grouped = {};
  for (const row of rows) {
    if (!grouped[row.user_id]) grouped[row.user_id] = [];
    grouped[row.user_id].push({ token: row.token, platform: row.platform });
  }
  return grouped;
}

// ── Pack purchase audit log ──────────────────────────────────

// Insert a row for a paid checkout. Returns true if newly inserted,
// false if the session was already logged (idempotent via unique constraint).
async function recordPackPurchase({ buyerUserId, recipientUserId, sessionId, clicks, amountPence, currency, consentImmediate }) {
  const id = uuidv4();
  const { rowCount } = await pool.query(
    `INSERT INTO pack_purchases
       (id, buyer_user_id, recipient_user_id, stripe_session_id, clicks, amount_pence, currency, consent_immediate)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (stripe_session_id) DO NOTHING`,
    [id, buyerUserId, recipientUserId ?? null, sessionId, clicks, amountPence ?? null, currency ?? null, !!consentImmediate]
  );
  return rowCount > 0;
}

// ── Terms acceptance + account deletion ─────────────────────

async function recordTermsAcceptance(userId, version) {
  const { rows } = await pool.query(
    `UPDATE users
     SET terms_version_accepted = $1,
         terms_accepted_at      = NOW()
     WHERE id = $2
     RETURNING *`,
    [version, userId]
  );
  return rows[0] ? rowToUser(rows[0]) : null;
}

async function deleteUser(userId) {
  // ON DELETE CASCADE on streamers, creator_profiles, promotion_packs,
  // push_tokens, and pack_purchases.buyer_user_id wipes downstream rows.
  // pack_purchases.recipient_user_id is ON DELETE SET NULL so gift records
  // remain auditable.
  const { rowCount } = await pool.query("DELETE FROM users WHERE id = $1", [userId]);
  return rowCount > 0;
}

// ── XP / gamification ────────────────────────────────────────

async function getUserXp(userId) {
  const { rows } = await pool.query(
    "SELECT total_xp FROM users WHERE id = $1",
    [userId]
  );
  return rows[0]?.total_xp ?? 0;
}

async function addUserXp(userId, points) {
  const { rows } = await pool.query(
    `UPDATE users SET total_xp = total_xp + $1 WHERE id = $2 RETURNING total_xp`,
    [points, userId]
  );
  return rows[0]?.total_xp ?? 0;
}

module.exports = {
  PLATFORMS,
  // Users
  findOrCreateUser,
  countUsers,
  getUserById,
  updateUserTwitch,
  getUserTwitchTokens,
  updateUserYoutube,
  getUserYoutubeTokens,
  // Streamers
  getAllStreamers,
  getStreamersByUser,
  getStreamerById,
  addStreamer,
  removeStreamer,
  // Schedule
  getAllSlots,
  getSlotsByUser,
  getSlotsByStreamer,
  getSlotsByDateRange,
  refreshStreamerSchedule,
  // Creator profiles
  getCreatorProfile,
  upsertCreatorProfile,
  searchCreatorProfiles,
  // Promotion packs
  getPackBalance,
  setPackPaused,
  addPackCredits,
  incrementPackViews,
  decrementPackClicks,
  getActivePaidCreators,
  // Push tokens
  savePushToken,
  removePushToken,
  getPushTokensByUser,
  getAllPushTokensGroupedByUser,
  // XP
  getUserXp,
  addUserXp,
  // Audit
  recordPackPurchase,
  // Terms / account
  recordTermsAcceptance,
  deleteUser,
};
