// ============================================================
// src/services/xpService.js — XP / gamification logic
//
// Point values for each tracked action and a level curve.
// Level formula: each level requires (level * 100) XP,
// so level 1 = 100, level 2 = 200, level 3 = 300, etc.
// Total XP for level N = N*(N+1)/2 * 100  (triangular sum).
// ============================================================

const store = require("../data/store");

const XP = {
  SLOT_CLICK:       5,   // clicking a streamer slot
  TWITCH_SYNC:      10,  // each new streamer synced from Twitch
  TWITCH_CONNECT:   25,  // connecting personal Twitch account
  YOUTUBE_SYNC:     10,  // each new streamer synced from YouTube subscriptions
  YOUTUBE_CONNECT:  25,  // connecting personal YouTube account
  ADD_PLATFORM:     5,   // adding an extra platform to a streamer
};

// Returns { level, currentXp, xpForNextLevel, totalXp }
function getLevelInfo(totalXp) {
  // Each level costs level*100 XP. Solve for highest level where
  // cumulative XP <= totalXp:  level*(level+1)/2 * 100 <= totalXp
  let level = 1;
  let cumulative = 0;
  while (cumulative + level * 100 <= totalXp) {
    cumulative += level * 100;
    level++;
  }
  return {
    level,
    currentXp:      totalXp - cumulative,
    xpForNextLevel: level * 100,
    totalXp,
  };
}

async function awardXp(userId, points) {
  const newTotal = await store.addUserXp(userId, points);
  return getLevelInfo(newTotal);
}

module.exports = { XP, getLevelInfo, awardXp };
