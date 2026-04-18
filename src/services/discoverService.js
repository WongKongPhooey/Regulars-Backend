// ============================================================
// src/services/discoverService.js
//
// Returns a list of streamers the user doesn't follow, matched
// by their preferred categories. Includes promoted creators and
// live/offline status.
// ============================================================

const { getChannelInfo, getTopLiveStreams, getGamesByName, getLiveStreamsByLogins } = require("./twitchService");
const store = require("../data/store");

async function getDiscoverList(userId) {
  const streamers = await store.getStreamersByUser(userId);
  const twitchStreamers = streamers.filter((s) => s.platform === "twitch");
  if (!twitchStreamers.length) return [];

  const allSlots = await store.getSlotsByUser(userId);

  // ── Build user preferences (same logic as gapFillerService) ──
  const logins = twitchStreamers.map((s) => s.channelId);
  let channelInfos = [];
  try {
    channelInfos = await getChannelInfo(logins);
  } catch (err) {
    console.warn("[discover] Could not fetch channel info:", err.message);
    return [];
  }

  const langCount = {};
  for (const ch of channelInfos) {
    if (ch.broadcaster_language) {
      langCount[ch.broadcaster_language] = (langCount[ch.broadcaster_language] || 0) + 1;
    }
  }
  const language = Object.entries(langCount).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "en";

  // One unique category per streamer from slot history
  const streamerIds = new Set(twitchStreamers.map((s) => s.id));
  const latestCategoryByStreamer = {};
  for (const slot of [...allSlots].sort((a, b) => new Date(b.startTime) - new Date(a.startTime))) {
    if (streamerIds.has(slot.streamerId) && slot.category && !latestCategoryByStreamer[slot.streamerId]) {
      latestCategoryByStreamer[slot.streamerId] = slot.category;
    }
  }

  const uniqueCategories = [
    ...new Set(
      Object.values(latestCategoryByStreamer).filter(
        (cat) => cat && cat.toLowerCase() !== "just chatting"
      )
    ),
  ];

  // Channel info game IDs for streamers without stored slots
  const streamersWithSlots = new Set(Object.keys(latestCategoryByStreamer));
  const channelInfoGameIds = [];
  for (const ch of channelInfos) {
    if (!streamersWithSlots.has(ch.broadcaster_id) && ch.game_id && ch.game_id !== "0") {
      channelInfoGameIds.push(ch.game_id);
    }
  }

  let gameIds = [];
  if (uniqueCategories.length) {
    try {
      const games = await getGamesByName(uniqueCategories.slice(0, 10));
      gameIds = games.map((g) => g.id);
    } catch (err) {
      console.warn("[discover] Could not look up game IDs:", err.message);
    }
  }
  for (const gid of channelInfoGameIds) {
    if (!gameIds.includes(gid)) gameIds.push(gid);
  }
  if (!gameIds.length) {
    const gameCount = {};
    for (const ch of channelInfos) {
      if (ch.game_id && ch.game_id !== "0") {
        gameCount[ch.game_id] = (gameCount[ch.game_id] || 0) + 1;
      }
    }
    gameIds = Object.entries(gameCount)
      .sort((a, b) => b[1] - a[1])
      .map(([id]) => id)
      .slice(0, 5);
  }

  const followedIds = new Set(channelInfos.map((c) => c.broadcaster_id));
  const followedLogins = channelInfos.map((c) => c.broadcaster_login);

  // ── Fetch live streams across all game categories ──
  const seenUserIds = new Set();
  const liveStreams = [];
  try {
    for (let i = 0; i < gameIds.length; i += 3) {
      const batch = gameIds.slice(i, i + 3);
      const streams = await getTopLiveStreams({
        gameIds: batch,
        language,
        excludeUserIds: followedIds,
        limit: 15,
      });
      for (const s of streams) {
        if (!seenUserIds.has(s.user_id)) {
          seenUserIds.add(s.user_id);
          liveStreams.push(s);
        }
      }
    }
  } catch (err) {
    console.warn("[discover] Could not fetch live streams:", err.message);
  }

  // ── Paid creators (promoted) ──
  let paidCreators = [];
  try {
    paidCreators = await store.getActivePaidCreators(followedLogins);
  } catch (err) {
    console.warn("[discover] Could not fetch paid creators:", err.message);
  }

  // Check which paid creators are live
  const paidTwitch = paidCreators.filter((c) => c.platform === "twitch");
  const paidLiveLogins = new Set();
  if (paidTwitch.length) {
    try {
      const paidLive = await getLiveStreamsByLogins(paidTwitch.map((c) => c.channelId));
      for (const s of paidLive) paidLiveLogins.add(s.user_login);
    } catch (err) {
      console.warn("[discover] Could not check paid creator live status:", err.message);
    }
  }

  // ── Build results ──
  const results = [];

  // Add promoted creators first
  for (const creator of paidCreators) {
    const isLive = paidLiveLogins.has(creator.channelId);
    // Find matching live stream data if live
    const liveMatch = liveStreams.find((s) => s.user_login === creator.channelId);
    results.push({
      login:       creator.channelId,
      displayName: creator.displayName,
      avatarUrl:   creator.avatarUrl,
      channelUrl:  creator.channelUrl,
      platform:    creator.platform,
      category:    liveMatch?.game_name ?? "",
      viewerCount: liveMatch?.viewer_count ?? 0,
      isLive,
      isPromoted:  true,
    });
    seenUserIds.add(liveMatch?.user_id); // avoid duplicates below
  }

  // Add regular live streams
  for (const s of liveStreams) {
    if (seenUserIds.has(s.user_id) && results.some((r) => r.login === s.user_login)) continue;
    results.push({
      login:       s.user_login,
      displayName: s.user_name,
      avatarUrl:   s.thumbnail_url?.replace("{width}", "70").replace("{height}", "70") ?? null,
      channelUrl:  `https://twitch.tv/${s.user_login}`,
      platform:    "twitch",
      category:    s.game_name ?? "",
      viewerCount: s.viewer_count ?? 0,
      isLive:      true,
      isPromoted:  false,
    });
  }

  // Sort: promoted first, then live, then by viewer count
  results.sort((a, b) => {
    if (a.isPromoted !== b.isPromoted) return a.isPromoted ? -1 : 1;
    if (a.isLive !== b.isLive) return a.isLive ? -1 : 1;
    return (b.viewerCount ?? 0) - (a.viewerCount ?? 0);
  });

  return results;
}

module.exports = { getDiscoverList };
