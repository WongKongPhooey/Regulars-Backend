// ============================================================
// src/services/notificationService.js
//
// Runs on a 1-minute interval. For each user with push tokens,
// checks if any schedule slot starts within the next 15 minutes
// and sends a notification if one hasn't already been sent for
// that slot.
// ============================================================

const { Expo } = require("expo-server-sdk");
const store = require("../data/store");

const expo = new Expo();

const LEAD_TIME_MS = 15 * 60 * 1000; // notify 15 minutes before
const CHECK_INTERVAL_MS = 60 * 1000; // check every minute

// Track which slot IDs we've already notified for (in-memory, resets on restart)
const notifiedSlots = new Set();

async function checkAndNotify() {
  try {
    const tokensByUser = await store.getAllPushTokensGroupedByUser();
    const userIds = Object.keys(tokensByUser);
    if (!userIds.length) return;

    const now = Date.now();
    const windowEnd = now + LEAD_TIME_MS;

    const messages = [];

    for (const userId of userIds) {
      const slots = await store.getSlotsByUser(userId);

      for (const slot of slots) {
        const startMs = new Date(slot.startTime).getTime();

        // Only notify for slots starting within the next 15 minutes
        // and not in the past
        if (startMs <= now || startMs > windowEnd) continue;

        const slotKey = `${userId}:${slot.id}`;
        if (notifiedSlots.has(slotKey)) continue;
        notifiedSlots.add(slotKey);

        const minsAway = Math.round((startMs - now) / 60000);
        const title = `${slot.streamerName} is about to go live`;
        const body = slot.category
          ? `${slot.category} — starting in ${minsAway} min`
          : `Starting in ${minsAway} min`;

        const tokens = tokensByUser[userId];
        for (const { token } of tokens) {
          if (!Expo.isExpoPushToken(token)) {
            console.warn(`[notifications] Invalid token, skipping: ${token}`);
            continue;
          }
          messages.push({
            to: token,
            sound: "default",
            title,
            body,
            data: { slotId: slot.id, channelUrl: slot.channelUrl },
          });
        }
      }
    }

    if (!messages.length) return;

    // Send in chunks (Expo recommends max 100 per batch)
    const chunks = expo.chunkPushNotifications(messages);
    for (const chunk of chunks) {
      try {
        const receipts = await expo.sendPushNotificationsAsync(chunk);
        console.log(`[notifications] Sent ${chunk.length} notification(s)`, receipts);
      } catch (err) {
        console.error("[notifications] Send failed:", err.message);
      }
    }
  } catch (err) {
    console.error("[notifications] Check failed:", err.message);
  }
}

// Clean up old slot keys periodically to prevent memory growth
function pruneNotifiedSlots() {
  if (notifiedSlots.size > 10000) {
    notifiedSlots.clear();
  }
}

function startNotificationScheduler() {
  console.log("🔔 Notification scheduler started (checking every 60s)");
  setInterval(() => {
    checkAndNotify();
    pruneNotifiedSlots();
  }, CHECK_INTERVAL_MS);
}

module.exports = { startNotificationScheduler };
