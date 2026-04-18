// ============================================================
// scripts/seedTestPromotion.js
//
// Seeds a dummy paid creator for testing the promotion system.
// Creates a fake user with a Twitch creator profile and pack credits.
//
// Usage:  node src/scripts/seedTestPromotion.js
// Remove: node src/scripts/seedTestPromotion.js --remove
// ============================================================

require("dotenv").config();
const { pool, initDb } = require("../data/db");
const { v4: uuidv4 } = require("uuid");

const TEST_USER_ID = "00000000-0000-0000-0000-000000000001";
const TEST_PACK_ID = "00000000-0000-0000-0000-000000000002";
const TEST_PROFILE_ID = "00000000-0000-0000-0000-000000000003";

async function seed() {
  await initDb();

  // 1. Create a dummy user
  await pool.query(
    `INSERT INTO users (id, google_id, email, name, avatar_url)
     VALUES ($1, 'test-google-id-promo-001', 'test-creator@example.com', 'TestPromoCreator', NULL)
     ON CONFLICT (id) DO NOTHING`,
    [TEST_USER_ID]
  );

  // 2. Create creator profile — uses a real FM Twitch channel name
  await pool.query(
    `INSERT INTO creator_profiles (id, user_id, platform, channel_id, channel_url, display_name, avatar_url)
     VALUES ($1, $2, 'twitch', 'testfmcreator', 'https://twitch.tv/testfmcreator', 'FM Test Creator', NULL)
     ON CONFLICT (user_id) DO UPDATE SET
       display_name = EXCLUDED.display_name,
       channel_id   = EXCLUDED.channel_id`,
    [TEST_PROFILE_ID, TEST_USER_ID]
  );

  // 3. Add pack credits (1000 views + 100 clicks)
  await pool.query(
    `INSERT INTO promotion_packs (id, user_id, views_remaining, clicks_remaining)
     VALUES ($1, $2, 1000, 100)
     ON CONFLICT (user_id) DO UPDATE SET
       views_remaining  = 1000,
       clicks_remaining = 100,
       updated_at       = NOW()`,
    [TEST_PACK_ID, TEST_USER_ID]
  );

  console.log("✅ Test promotion data seeded:");
  console.log("   User ID:      ", TEST_USER_ID);
  console.log("   Creator:       FM Test Creator (twitch/testfmcreator)");
  console.log("   Pack:          1000 views, 100 clicks");
}

async function remove() {
  await initDb();
  await pool.query("DELETE FROM promotion_packs WHERE user_id = $1", [TEST_USER_ID]);
  await pool.query("DELETE FROM creator_profiles WHERE user_id = $1", [TEST_USER_ID]);
  await pool.query("DELETE FROM users WHERE id = $1", [TEST_USER_ID]);
  console.log("✅ Test promotion data removed");
}

(async () => {
  try {
    if (process.argv.includes("--remove")) {
      await remove();
    } else {
      await seed();
    }
  } catch (err) {
    console.error("❌ Seed failed:", err.message);
  } finally {
    await pool.end();
  }
})();
