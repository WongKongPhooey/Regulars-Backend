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
    CREATE TABLE IF NOT EXISTS users (
      id                   UUID        PRIMARY KEY,
      google_id            TEXT        UNIQUE NOT NULL,
      email                TEXT        NOT NULL,
      name                 TEXT,
      avatar_url           TEXT,
      twitch_id            TEXT,
      twitch_access_token  TEXT,
      twitch_refresh_token TEXT,
      created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

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

    -- Add user_id column (nullable so existing rows aren't broken)
    ALTER TABLE streamers ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES users(id) ON DELETE CASCADE;

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

  // Replace the old (platform, channel_id) unique constraint with a per-user one.
  await pool.query(`
    ALTER TABLE streamers DROP CONSTRAINT IF EXISTS streamers_platform_channel_id_key;
  `);
  await pool.query(`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'streamers_user_platform_channel_unique'
      ) THEN
        ALTER TABLE streamers
          ADD CONSTRAINT streamers_user_platform_channel_unique
          UNIQUE (user_id, platform, channel_id);
      END IF;
    END $$;
  `);

  // Creator profiles — a user's own channel (for promotion)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS creator_profiles (
      id           UUID        PRIMARY KEY,
      user_id      UUID        NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
      platform     TEXT        NOT NULL,
      channel_id   TEXT        NOT NULL,
      channel_url  TEXT        NOT NULL,
      display_name TEXT        NOT NULL,
      avatar_url   TEXT,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // Promotion packs — views and clicks balance per user
  await pool.query(`
    CREATE TABLE IF NOT EXISTS promotion_packs (
      id           UUID        PRIMARY KEY,
      user_id      UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      views_remaining  INTEGER NOT NULL DEFAULT 0,
      clicks_remaining INTEGER NOT NULL DEFAULT 0,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // One pack balance row per user (upsert on purchase)
  await pool.query(`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'promotion_packs_user_id_key'
      ) THEN
        ALTER TABLE promotion_packs ADD CONSTRAINT promotion_packs_user_id_key UNIQUE (user_id);
      END IF;
    END $$;
  `);

  await pool.query(`ALTER TABLE promotion_packs ADD COLUMN IF NOT EXISTS last_session_id TEXT`);
  await pool.query(`ALTER TABLE promotion_packs ADD COLUMN IF NOT EXISTS clicks_total INTEGER NOT NULL DEFAULT 0`);

  // Push notification tokens — one row per device per user
  await pool.query(`
    CREATE TABLE IF NOT EXISTS push_tokens (
      id         UUID        PRIMARY KEY,
      user_id    UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token      TEXT        NOT NULL,
      platform   TEXT        NOT NULL DEFAULT 'expo',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await pool.query(`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'push_tokens_token_key'
      ) THEN
        ALTER TABLE push_tokens ADD CONSTRAINT push_tokens_token_key UNIQUE (token);
      END IF;
    END $$;
  `);

  // XP / gamification — running total per user
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS total_xp INTEGER NOT NULL DEFAULT 0`);

  // Add person_id — groups multiple platform entries for the same real-world creator.
  // Defaults to the streamer's own id so existing rows get a stable person_id automatically.
  await pool.query(`
    ALTER TABLE streamers ADD COLUMN IF NOT EXISTS person_id UUID;
  `);
  await pool.query(`
    UPDATE streamers SET person_id = id WHERE person_id IS NULL;
  `);
}

module.exports = { pool, initDb };
