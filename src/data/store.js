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
    id:        row.id,
    email:     row.email,
    name:      row.name,
    avatarUrl: row.avatar_url,
    twitchId:  row.twitch_id,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
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
  if (existing[0]) return rowToUser(existing[0]);

  const id = uuidv4();
  const { rows } = await pool.query(
    `INSERT INTO users (id, google_id, email, name, avatar_url)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [id, googleId, email, name, avatarUrl]
  );
  return rowToUser(rows[0]);
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
    lastSessionId:    row.last_session_id ?? null,
    updatedAt:        row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
  };
}

async function getPackBalance(userId) {
  const { rows } = await pool.query(
    "SELECT * FROM promotion_packs WHERE user_id = $1",
    [userId]
  );
  return rows[0] ? rowToPack(rows[0]) : { totalViews: 0, clicksRemaining: 0, clicksTotal: 0 };
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
     WHERE pp.clicks_remaining > 0`
  );
  const excluded = new Set(excludeChannelIds);
  return rows
    .filter((r) => !excluded.has(r.channel_id))
    .map((r) => ({ ...rowToCreator(r), totalViews: r.views_remaining, clicksRemaining: r.clicks_remaining }));
}

module.exports = {
  PLATFORMS,
  // Users
  findOrCreateUser,
  getUserById,
  updateUserTwitch,
  getUserTwitchTokens,
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
  // Promotion packs
  getPackBalance,
  addPackCredits,
  incrementPackViews,
  decrementPackClicks,
  getActivePaidCreators,
};
