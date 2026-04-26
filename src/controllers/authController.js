// ============================================================
// src/controllers/authController.js
// ============================================================

const { OAuth2Client } = require("google-auth-library");
const jwt = require("jsonwebtoken");
const store = require("../data/store");
const { getLevelInfo, awardXp, XP } = require("../services/xpService");
const { isAdminUser } = require("../middleware/admin");
const { CURRENT_TERMS_VERSION } = require("../services/legalService");

async function decorateUser(user) {
  if (!user) return user;
  return {
    ...user,
    isAdmin: await isAdminUser(user.id),
    currentTermsVersion: CURRENT_TERMS_VERSION,
  };
}

const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

// ── Google sign-in ────────────────────────────────────────────

// POST /api/auth/google
exports.googleSignIn = async (req, res) => {
  const { idToken, accessToken, code, codeVerifier, redirectUri } = req.body;

  if (!idToken && !accessToken && !code) {
    return res.status(400).json({ error: "idToken, accessToken, or code is required" });
  }

  let payload;

  if (code) {
    // Web PKCE flow: exchange the authorisation code server-side so the
    // client_secret is never exposed to the browser.
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id:     process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        code_verifier: codeVerifier,
        grant_type:    "authorization_code",
        redirect_uri:  redirectUri,
      }).toString(),
    });

    if (!tokenRes.ok) {
      const err = await tokenRes.json();
      console.error("[auth] Google code exchange failed:", err);
      return res.status(401).json({ error: "Google code exchange failed" });
    }

    const tokens = await tokenRes.json();
    const ticket = await googleClient.verifyIdToken({
      idToken:  tokens.id_token,
      audience: process.env.GOOGLE_CLIENT_ID,
    });
    payload = ticket.getPayload();
  } else if (idToken) {
    const ticket = await googleClient.verifyIdToken({
      idToken,
      audience: process.env.GOOGLE_CLIENT_ID,
    });
    payload = ticket.getPayload();
  } else {
    // Fallback: verify access token via userinfo endpoint
    const userInfoRes = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!userInfoRes.ok) {
      return res.status(401).json({ error: "Invalid Google access token" });
    }
    payload = await userInfoRes.json();
  }

  const { user, created } = await store.findOrCreateUser({
    googleId:  payload.sub,
    email:     payload.email,
    name:      payload.name,
    avatarUrl: payload.picture,
  });

  // Free welcome pack for the first N signups (configurable via env).
  if (created) {
    const freeLimit = parseInt(process.env.FREE_SIGNUP_PACK_LIMIT ?? "0", 10);
    if (freeLimit > 0) {
      const total = await store.countUsers();
      if (total <= freeLimit) {
        await store.addPackCredits(user.id, 100, `free-signup-${user.id}`);
        console.log(`[auth] Granted free signup pack to user ${user.id} (#${total} of ${freeLimit})`);
      }
    }
  }

  const token = jwt.sign(
    { userId: user.id },
    process.env.JWT_SECRET,
    { expiresIn: "30d" }
  );

  res.json({ token, user: await decorateUser(user) });
};

// GET /api/auth/me
exports.me = async (req, res) => {
  const user = await store.getUserById(req.user.userId);
  if (!user) return res.status(404).json({ error: "User not found" });
  res.json(await decorateUser(user));
};

// GET /api/auth/xp
exports.getXp = async (req, res) => {
  const totalXp = await store.getUserXp(req.user.userId);
  res.json(getLevelInfo(totalXp));
};

// POST /api/auth/accept-terms — record that the user has read & accepted
// the current Privacy Policy + Terms of Service.
exports.acceptTerms = async (req, res) => {
  const user = await store.recordTermsAcceptance(req.user.userId, CURRENT_TERMS_VERSION);
  if (!user) return res.status(404).json({ error: "User not found" });
  res.json(await decorateUser(user));
};

// ── YouTube connect + import ─────────────────────────────────

// POST /api/auth/youtube/connect
// Exchanges a Google PKCE code (with the youtube.readonly scope) for tokens
// and stores them on the user. Mirrors the /auth/google PKCE exchange.
exports.youtubeConnect = async (req, res) => {
  const { code, codeVerifier, redirectUri } = req.body;
  if (!code || !codeVerifier || !redirectUri) {
    return res.status(400).json({ error: "code, codeVerifier and redirectUri are required" });
  }

  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id:     process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      code_verifier: codeVerifier,
      grant_type:    "authorization_code",
      redirect_uri:  redirectUri,
    }).toString(),
  });

  if (!tokenRes.ok) {
    const err = await tokenRes.json();
    console.error("[auth] YouTube code exchange failed:", err);
    return res.status(401).json({ error: "YouTube code exchange failed" });
  }

  const tokens = await tokenRes.json();
  const existingTokens = await store.getUserYoutubeTokens(req.user.userId);
  const isFirstConnect = !existingTokens?.accessToken;

  const user = await store.updateUserYoutube(req.user.userId, {
    accessToken:  tokens.access_token,
    refreshToken: tokens.refresh_token ?? null,
  });

  if (isFirstConnect) {
    await awardXp(req.user.userId, XP.YOUTUBE_CONNECT);
  }

  res.json({ user: await decorateUser(user) });
};

// POST /api/auth/youtube/import — fetch the user's YouTube subscriptions and
// add any not-yet-followed ones as streamers.
exports.youtubeImport = async (req, res) => {
  const tokens = await store.getUserYoutubeTokens(req.user.userId);
  if (!tokens?.accessToken) {
    return res.status(400).json({ error: "YouTube account not connected" });
  }

  // Page through subscriptions (50 per page, hard cap at 200)
  const subscriptions = [];
  let pageToken = null;
  const HARD_CAP = 200;

  do {
    const url = new URL("https://www.googleapis.com/youtube/v3/subscriptions");
    url.searchParams.set("part",       "snippet");
    url.searchParams.set("mine",       "true");
    url.searchParams.set("maxResults", "50");
    if (pageToken) url.searchParams.set("pageToken", pageToken);

    const subRes = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${tokens.accessToken}` },
    });

    if (!subRes.ok) {
      const body = await subRes.json().catch(() => ({}));
      console.error("[youtubeImport] subscriptions fetch failed:", subRes.status, body);
      return res.status(502).json({ error: "Failed to fetch YouTube subscriptions — please reconnect your account" });
    }

    const { items, nextPageToken } = await subRes.json();
    subscriptions.push(...(items ?? []));
    pageToken = nextPageToken;
  } while (pageToken && subscriptions.length < HARD_CAP);

  if (!subscriptions.length) {
    return res.json({ imported: 0, skipped: 0 });
  }

  const existing = await store.getStreamersByUser(req.user.userId);
  const existingKeys = new Set(
    existing.filter((s) => s.platform === "youtube").map((s) => s.channelId)
  );

  let imported = 0;
  let skipped  = 0;

  for (const sub of subscriptions) {
    const channelId = sub.snippet?.resourceId?.channelId;
    if (!channelId) continue;
    if (existingKeys.has(channelId)) { skipped++; continue; }

    await store.addStreamer({
      userId:      req.user.userId,
      displayName: sub.snippet.title,
      platform:    "youtube",
      channelId,
      channelUrl:  `https://youtube.com/channel/${channelId}`,
      avatarUrl:   sub.snippet.thumbnails?.default?.url ?? null,
      color:       "#6B6B88",
    });
    imported++;
  }

  if (imported > 0) {
    await awardXp(req.user.userId, XP.YOUTUBE_SYNC * imported);
  }

  res.json({ imported, skipped });
};

// DELETE /api/auth/account — GDPR right to erasure / Apple+Google requirement.
// Hard-deletes the user; cascade clears streamers, creator profile, packs,
// push tokens. Pack-purchase rows persist (FK set to NULL) for tax records.
exports.deleteAccount = async (req, res) => {
  const ok = await store.deleteUser(req.user.userId);
  if (!ok) return res.status(404).json({ error: "User not found" });
  console.log(`[auth] Account deleted: ${req.user.userId}`);
  res.json({ deleted: true });
};

// ── Twitch connect ────────────────────────────────────────────

// POST /api/auth/twitch/connect
exports.twitchConnect = async (req, res) => {
  const { accessToken } = req.body;
  if (!accessToken) {
    return res.status(400).json({ error: "accessToken is required" });
  }

  const validateRes = await fetch("https://id.twitch.tv/oauth2/validate", {
    headers: { Authorization: `OAuth ${accessToken}` },
  });

  if (!validateRes.ok) {
    return res.status(401).json({ error: "Invalid Twitch access token" });
  }

  const { user_id, login } = await validateRes.json();

  // Award XP only on first Twitch connect
  const existingUser = await store.getUserById(req.user.userId);
  const isFirstConnect = !existingUser?.twitchId;

  const user = await store.updateUserTwitch(req.user.userId, {
    twitchId:     user_id,
    accessToken,
    refreshToken: null,
  });

  if (isFirstConnect) {
    await awardXp(req.user.userId, XP.TWITCH_CONNECT);
  }

  res.json({ user: await decorateUser(user), twitchLogin: login });
};

// ── Twitch import ─────────────────────────────────────────────

// POST /api/auth/twitch/import
exports.twitchImport = async (req, res) => {
  const tokens = await store.getUserTwitchTokens(req.user.userId);
  if (!tokens?.twitchId || !tokens?.accessToken) {
    return res.status(400).json({ error: "Twitch account not connected" });
  }

  const headers = {
    Authorization: `Bearer ${tokens.accessToken}`,
    "Client-Id": process.env.TWITCH_CLIENT_ID,
  };

  const followsRes = await fetch(
    `https://api.twitch.tv/helix/channels/followed?user_id=${tokens.twitchId}&first=100`,
    { headers }
  );

  if (!followsRes.ok) {
    const body = await followsRes.json().catch(() => ({}));
    console.error("[twitchImport] follows fetch failed:", followsRes.status, body);
    return res.status(502).json({ error: "Failed to fetch Twitch follows — token may be expired" });
  }

  const { data: follows } = await followsRes.json();
  if (!follows?.length) {
    return res.json({ imported: 0, skipped: 0 });
  }

  // Batch-fetch user profiles to get avatar URLs
  const loginParams = follows
    .map((f) => `login=${encodeURIComponent(f.broadcaster_login)}`)
    .join("&");

  const usersRes = await fetch(
    `https://api.twitch.tv/helix/users?${loginParams}`,
    { headers }
  );
  const { data: twitchUsers } = await usersRes.json();
  const avatarMap = Object.fromEntries(
    (twitchUsers ?? []).map((u) => [u.login, u.profile_image_url])
  );

  const existing = await store.getStreamersByUser(req.user.userId);
  const existingKeys = new Set(existing.map((s) => `twitch:${s.channelId}`));

  let imported = 0;
  let skipped  = 0;

  for (const follow of follows) {
    const key = `twitch:${follow.broadcaster_login}`;
    if (existingKeys.has(key)) {
      skipped++;
      continue;
    }

    await store.addStreamer({
      userId:      req.user.userId,
      displayName: follow.broadcaster_name,
      platform:    "twitch",
      channelId:   follow.broadcaster_login,
      channelUrl:  `https://twitch.tv/${follow.broadcaster_login}`,
      avatarUrl:   avatarMap[follow.broadcaster_login] ?? null,
      color:       "#6B6B88",
    });
    imported++;
  }

  // Award XP for each newly imported streamer
  if (imported > 0) {
    await awardXp(req.user.userId, XP.TWITCH_SYNC * imported);
  }

  res.json({ imported, skipped });
};
