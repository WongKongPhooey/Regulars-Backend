// ============================================================
// src/data/store.js — PostgreSQL-backed data store
//
// All functions are async — they return Promises that resolve
// to the same shapes the controllers already expect, so
// controller changes are minimal (just add await).
//
// DB rows use snake_case; JS objects use camelCase.
// The row→object helpers below handle the conversion.
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
// node-postgres returns TIMESTAMPTZ columns as JS Date objects.
// Controllers expect ISO strings, so we convert here.

function rowToStreamer(row) {
  return {
    id:          row.id,
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

// ── Streamer CRUD ─────────────────────────────────────────────

async function getAllStreamers() {
  const { rows } = await pool.query(
    "SELECT * FROM streamers ORDER BY added_at"
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
    `INSERT INTO streamers (id, display_name, platform, channel_id, channel_url, avatar_url, color)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [id, data.displayName, data.platform, data.channelId, data.channelUrl, data.avatarUrl, data.color ?? '#6B6B88']
  );
  return rowToStreamer(rows[0]);
}

async function removeStreamer(id) {
  // schedule_slots rows cascade-delete automatically (ON DELETE CASCADE)
  const { rowCount } = await pool.query(
    "DELETE FROM streamers WHERE id = $1",
    [id]
  );
  return rowCount > 0;
}

// ── Schedule queries ──────────────────────────────────────────

const SLOT_SELECT = `
  SELECT ss.*, s.color AS streamer_color
  FROM schedule_slots ss
  JOIN streamers s ON s.id = ss.streamer_id
`;

async function getAllSlots() {
  const { rows } = await pool.query(SLOT_SELECT);
  return rows.map(rowToSlot);
}

async function getSlotsByStreamer(streamerId) {
  const { rows } = await pool.query(
    `${SLOT_SELECT} WHERE ss.streamer_id = $1`,
    [streamerId]
  );
  return rows.map(rowToSlot);
}

async function getSlotsByDateRange(from, to) {
  const { rows } = await pool.query(
    `${SLOT_SELECT} WHERE ss.start_time >= $1 AND ss.start_time <= $2`,
    [from, to]
  );
  return rows.map(rowToSlot);
}

async function refreshStreamerSchedule(streamerId, newSlots) {
  // Delete old slots first, then insert the fresh batch
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
  getAllStreamers,
  getStreamerById,
  addStreamer,
  removeStreamer,
  getAllSlots,
  getSlotsByStreamer,
  getSlotsByDateRange,
  refreshStreamerSchedule,
};
