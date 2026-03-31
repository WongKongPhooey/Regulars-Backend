// ============================================================
// src/data/db.js — PostgreSQL connection pool
//
// Uses the DATABASE_URL environment variable (the standard
// connection string format supported by Postgres, Supabase,
// Railway, Render, etc.).
//
// initDb() creates the tables if they don't already exist,
// so you never have to run migrations manually in dev.
// ============================================================

const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // In production with SSL (e.g. Supabase, Railway), uncomment:
  // ssl: { rejectUnauthorized: false },
});

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS streamers (
      id           UUID        PRIMARY KEY,
      display_name TEXT        NOT NULL,
      platform     TEXT        NOT NULL,
      channel_id   TEXT        NOT NULL,
      channel_url  TEXT        NOT NULL,
      avatar_url   TEXT,
      color        TEXT        NOT NULL DEFAULT '#6B6B88',
      added_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (platform, channel_id)
    );

    -- Add color column to existing tables that pre-date this migration
    ALTER TABLE streamers ADD COLUMN IF NOT EXISTS color TEXT NOT NULL DEFAULT '#6B6B88';

    CREATE TABLE IF NOT EXISTS schedule_slots (
      id            UUID        PRIMARY KEY,
      streamer_id   UUID        NOT NULL REFERENCES streamers(id) ON DELETE CASCADE,
      streamer_name TEXT        NOT NULL,
      platform      TEXT        NOT NULL,
      title         TEXT,
      category      TEXT,
      start_time    TIMESTAMPTZ NOT NULL,
      end_time      TIMESTAMPTZ,
      channel_url   TEXT,
      is_live       BOOLEAN     NOT NULL DEFAULT FALSE,
      thumbnail_url TEXT
    );
  `);
}

module.exports = { pool, initDb };
