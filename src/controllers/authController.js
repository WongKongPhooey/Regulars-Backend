// ============================================================
// src/controllers/authController.js
// ============================================================

const { OAuth2Client } = require("google-auth-library");
const jwt = require("jsonwebtoken");
const store = require("../data/store");
const { getLevelInfo, awardXp, XP } = require("../services/xpService");
const { isAdminUser } = require("../middleware/admin");

async function withIsAdmin(user) {
  if (!user) return user;
  return { ...user, isAdmin: await isAdminUser(user.id) };
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

  const user = await store.findOrCreateUser({
    googleId:  payload.sub,
    email:     payload.email,
    name:      payload.name,
    avatarUrl: payload.picture,
  });

  const token = jwt.sign(
    { userId: user.id },
    process.env.JWT_SECRET,
    { expiresIn: "30d" }
  );

  res.json({ token, user: await withIsAdmin(user) });
};

// GET /api/auth/me
exports.me = async (req, res) => {
  const user = await store.getUserById(req.user.userId);
  if (!user) return res.status(404).json({ error: "User not found" });
  res.json(await withIsAdmin(user));
};

// GET /api/auth/xp
exports.getXp = async (req, res) => {
  const totalXp = await store.getUserXp(req.user.userId);
  res.json(getLevelInfo(totalXp));
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

  res.json({ user: await withIsAdmin(user), twitchLogin: login });
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
