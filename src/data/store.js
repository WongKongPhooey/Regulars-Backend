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
  const { rows } = await pool.query(
    `INSERT INTO streamers (id, user_id, display_name, platform, channel_id, channel_url, avatar_url, color)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [id, data.userId, data.displayName, data.platform, data.channelId, data.channelUrl, data.avatarUrl, data.color ?? '#6B6B88']
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
  SELECT ss.*, s.color AS streamer_color
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
};
