// ============================================================
// iKomment — Core API (Stage 2)
// Cloudflare Worker · talks to D1 (database) and KV (cache)
//
// Endpoints (all under /api/):
//   GET  /api/thread?site=X&url=Y        → fetch a page's comment thread
//   POST /api/post                       → create a comment/reply
//   POST /api/vote                       → up/down vote a post
//   POST /api/edit                       → edit own post (within window)
//   POST /api/delete                     → delete own post
//   GET  /api/count?site=X&url=Y         → comment count badge
// ============================================================

// ---------- small helpers ----------

const json = (data, status = 200, extra = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json",
      "access-control-allow-origin": "*", // widget runs on customers' domains
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": "content-type, x-ikomment-user",
      ...extra,
    },
  });

const err = (message, status = 400) => json({ error: message }, status);

// short unique IDs, e.g. "k7f3x9q2"
const newId = () =>
  [...crypto.getRandomValues(new Uint8Array(8))]
    .map((b) => "abcdefghjkmnpqrstuvwxyz23456789"[b % 31])
    .join("");

const now = () => Math.floor(Date.now() / 1000);

// very small markdown → HTML (bold, italic, code, links) with HTML escaping.
// Escaping first means nobody can inject scripts into pages. Security 101.
function renderMarkdown(text) {
  let s = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
  s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  // only http(s) links, rel=nofollow keeps spammers unrewarded
  s = s.replace(
    /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
    '<a href="$2" rel="nofollow noopener" target="_blank">$1</a>'
  );
  return s.replace(/\n/g, "<br>");
}

// normalise URLs so "/post?utm=x#top" and "/post" are the same page
function normaliseUrl(raw) {
  try {
    const u = new URL(raw);
    return u.origin + u.pathname.replace(/\/+$/, "");
  } catch {
    return raw;
  }
}

// ---------- settings, with KV caching ----------

async function getSettings(env, siteId) {
  const cached = await env.KV.get(`settings:${siteId}`, "json");
  if (cached) return cached;
  const row = await env.DB.prepare(
    "SELECT * FROM site_settings WHERE site_id = ?"
  ).bind(siteId).first();
  if (row) await env.KV.put(`settings:${siteId}`, JSON.stringify(row), { expirationTtl: 60 });
  return row;
}

// ---------- identity ----------
// The widget sends a header: x-ikomment-user = "<userId>:<guestToken>"
// Guests are created on first post. (Magic link / Google / GitHub / SSO
// arrive in Stage 4 and will slot in here.)

async function getUser(env, request, siteId) {
  // 1) SSO token from the site owner's page (HMAC-signed, highest trust)
  const ssoHeader = request.headers.get("x-ikomment-sso");
  if (ssoHeader) {
    const ssoUser = await verifySso(env, siteId, ssoHeader);
    if (ssoUser) return ssoUser;
  }
  // 2) our own credential: "<userId>:<token>" (guests and OAuth sessions alike)
  const header = request.headers.get("x-ikomment-user");
  if (!header) return null;
  const [userId, token] = header.split(":");
  if (!userId || !token) return null;
  return await env.DB.prepare(
    "SELECT * FROM users WHERE id = ? AND guest_token = ? AND site_id = ?"
  ).bind(userId, token, siteId).first();
}

async function createGuest(env, siteId, displayName) {
  const id = newId();
  const token = newId() + newId();
  await env.DB.prepare(
    `INSERT INTO users (id, site_id, display_name, kind, guest_token, trust_level, created_at, last_seen)
     VALUES (?, ?, ?, 'guest', ?, 0, ?, ?)`
  ).bind(id, siteId, displayName.slice(0, 50), token, now(), now()).run();
  return { id, guest_token: token, display_name: displayName.slice(0, 50), trust_level: 0, is_shadow_banned: 0 };
}

// ---------- logged-in user upsert ----------
// Find-or-create a user for any external identity (Google/GitHub/SSO).
// Returns the user row including a fresh-or-existing auth token.

async function upsertExternalUser(env, siteId, kind, externalId, name, email, avatar) {
  let user = await env.DB.prepare(
    "SELECT * FROM users WHERE site_id = ? AND kind = ? AND external_id = ?"
  ).bind(siteId, kind, externalId).first();

  if (user) {
    await env.DB.prepare(
      "UPDATE users SET display_name = ?, avatar_url = ?, last_seen = ? WHERE id = ?"
    ).bind(name.slice(0, 50), avatar || null, now(), user.id).run();
    user.display_name = name.slice(0, 50);
    return user;
  }
  const id = newId();
  const token = newId() + newId();
  await env.DB.prepare(
    `INSERT INTO users (id, site_id, display_name, email, avatar_url, kind, external_id,
                        guest_token, trust_level, created_at, last_seen)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)` // logged-in users start at trust 1
  ).bind(id, siteId, name.slice(0, 50), email || null, avatar || null,
         kind, externalId, token, now(), now()).run();
  return { id, site_id: siteId, display_name: name.slice(0, 50), kind,
           guest_token: token, trust_level: 1, is_shadow_banned: 0, is_moderator: 0 };
}

// ---------- SSO (FastComments-style HMAC) ----------
// The site owner's server builds:  base64(JSON payload) + "." + HMAC-SHA256 hex
// Payload: { id, name, email?, avatar?, ts }   ts must be within 10 minutes.

async function hmacHex(secret, message) {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function verifySso(env, siteId, token) {
  try {
    const settings = await getSettings(env, siteId);
    if (!settings || !settings.login_sso || !settings.sso_secret) return null;
    const dot = token.lastIndexOf(".");
    if (dot < 1) return null;
    const payloadB64 = token.slice(0, dot);
    const theirSig = token.slice(dot + 1);
    const ourSig = await hmacHex(settings.sso_secret, payloadB64);
    if (ourSig !== theirSig) return null;                 // signature mismatch → reject
    const p = JSON.parse(atob(payloadB64));
    if (!p.id || !p.name) return null;
    if (Math.abs(now() - (p.ts || 0)) > 600) return null; // older than 10 min → reject
    return await upsertExternalUser(env, siteId, "sso", String(p.id), p.name, p.email, p.avatar);
  } catch (e) { return null; }
}

// ---------- OAuth: Google & GitHub ----------
// Flow: widget opens a popup → /api/auth/{provider}?site=X
//   → we redirect to the provider's consent screen
//   → provider sends the visitor back to /api/auth/{provider}/callback
//   → we exchange the code for the profile, create the user,
//     and the popup hands the credential to the widget via postMessage.
// Credentials needed (set as Worker secrets):
//   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET

const OAUTH = {
  google: {
    authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    scope: "openid profile email",
    profile: async (accessToken) => {
      const r = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
        headers: { authorization: "Bearer " + accessToken },
      }).then((x) => x.json());
      return { id: r.id, name: r.name || r.email, email: r.email, avatar: r.picture };
    },
  },
  github: {
    authUrl: "https://github.com/login/oauth/authorize",
    tokenUrl: "https://github.com/login/oauth/access_token",
    scope: "read:user user:email",
    profile: async (accessToken) => {
      const r = await fetch("https://api.github.com/user", {
        headers: { authorization: "Bearer " + accessToken, "user-agent": "ikomment" },
      }).then((x) => x.json());
      return { id: r.id, name: r.name || r.login, email: r.email, avatar: r.avatar_url };
    },
  },
};

function oauthCreds(env, provider) {
  return provider === "google"
    ? { id: env.GOOGLE_CLIENT_ID, secret: env.GOOGLE_CLIENT_SECRET }
    : { id: env.GITHUB_CLIENT_ID, secret: env.GITHUB_CLIENT_SECRET };
}

// step 1: send the visitor to the provider's consent screen
async function handleAuthStart(env, request, provider, params) {
  const cfg = OAUTH[provider];
  const creds = oauthCreds(env, provider);
  if (!cfg || !creds.id) return err(provider + " login is not configured", 503);

  const siteId = params.get("site");
  const settings = await getSettings(env, siteId);
  if (!settings || !settings["login_" + provider]) return err("login method disabled", 403);

  const self = new URL(request.url);
  const redirect = self.origin + "/api/auth/" + provider + "/callback";
  // state carries the site id through the round-trip (and blocks CSRF: it's random per request)
  const state = siteId + "." + newId();
  const q = new URLSearchParams({
    client_id: creds.id, redirect_uri: redirect, state,
    scope: cfg.scope, response_type: "code",
  });
  return new Response(null, {
    status: 302,
    headers: {
      location: cfg.authUrl + "?" + q,
      // double-submit cookie: callback must present the same state
      "set-cookie": `ik_state=${state}; Max-Age=600; Path=/api/auth; Secure; HttpOnly; SameSite=Lax`,
    },
  });
}

// step 2: provider sends the visitor back here
async function handleAuthCallback(env, request, provider, params) {
  const cfg = OAUTH[provider];
  const creds = oauthCreds(env, provider);
  const code = params.get("code");
  const state = params.get("state") || "";
  const cookieState = (request.headers.get("cookie") || "").match(/ik_state=([^;]+)/);
  if (!code || !state || !cookieState || cookieState[1] !== state)
    return new Response("Sign-in failed (state mismatch). Close this window and try again.", { status: 400 });

  const siteId = state.split(".")[0];
  const self = new URL(request.url);

  // exchange the one-time code for an access token
  const tokenRes = await fetch(cfg.tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({
      client_id: creds.id, client_secret: creds.secret, code,
      redirect_uri: self.origin + "/api/auth/" + provider + "/callback",
      grant_type: "authorization_code",
    }),
  }).then((r) => r.json());
  if (!tokenRes.access_token)
    return new Response("Sign-in failed. Close this window and try again.", { status: 400 });

  const profile = await cfg.profile(tokenRes.access_token);
  const user = await upsertExternalUser(env, siteId, provider,
    String(profile.id), profile.name, profile.email, profile.avatar);

  // hand the credential back to the widget and close the popup
  const identity = JSON.stringify({
    type: "ikomment-auth",
    user_id: user.id, token: user.guest_token, name: user.display_name,
  });
  return new Response(
    "<!doctype html><script>" +
    "if(window.opener){window.opener.postMessage(" + identity + ",'*');window.close();}" +
    "else{document.write('Signed in. You can close this window.');}" +
    "<\/script>",
    { headers: { "content-type": "text/html" } }
  );
}

// ---------- admin authentication (Option A: per-site admin key) ----------

async function requireAdmin(env, request, siteId) {
  const key = request.headers.get("x-ikomment-admin");
  if (!key || !siteId) return null;
  return await env.DB.prepare(
    "SELECT * FROM sites WHERE id = ? AND admin_key = ?"
  ).bind(siteId, key).first();
}

async function logModAction(env, siteId, moderatorId, action, postId, userId) {
  await env.DB.prepare(
    `INSERT INTO mod_actions (id, site_id, moderator_id, action, target_post_id, target_user_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).bind(newId(), siteId, moderatorId, action, postId || null, userId || null, now()).run();
}

// ---------- AI spam detection (Workers AI — data never leaves Cloudflare) ----------
// Returns: 'clean' | 'suspicious' | 'spam'. Fails open to 'clean' so an AI
// hiccup never blocks real comments (pre-moderation still applies on top).

async function aiSpamCheck(env, body, authorName) {
  if (!env.AI) return "clean";
  try {
    const res = await env.AI.run("@cf/meta/llama-3.1-8b-instruct", {
      messages: [
        { role: "system", content:
          "You are a comment spam filter. Reply with exactly one word: " +
          "SPAM (advertising, scams, phishing, link farming, gibberish), " +
          "SUSPICIOUS (might be spam, needs a human look), or " +
          "CLEAN (a normal comment, including critical or negative ones). " +
          "Disagreement and strong opinions are CLEAN. Only the word, nothing else." },
        { role: "user", content: "Author: " + authorName + "\nComment: " + body.slice(0, 2000) },
      ],
      max_tokens: 5,
    });
    const verdict = (res.response || "").trim().toUpperCase();
    if (verdict.indexOf("SPAM") === 0) return "spam";
    if (verdict.indexOf("SUSPICIOUS") === 0) return "suspicious";
    return "clean";
  } catch (e) { return "clean"; }
}

// ---------- trust level movement (automatic and invisible) ----------
// Approvals raise trust (auto-approval at level 2+). Spam verdicts lower it.

async function adjustTrust(env, userId, delta) {
  await env.DB.prepare(
    "UPDATE users SET trust_level = MAX(0, MIN(3, trust_level + ?)) WHERE id = ?"
  ).bind(delta, userId).run();
}

// ---------- email moderation (Resend) ----------
// Sends the owner a notification with one-tap action links. Links are signed
// with HMAC(admin_key) and expire — possessing the email IS the credential,
// which is why this feature is OFF by default behind typed confirmation.

async function emailActionSig(adminKey, postId, action, exp) {
  return (await hmacHex(adminKey, postId + "|" + action + "|" + exp)).slice(0, 32);
}

async function sendModerationEmail(env, site, post, authorName, requestOrigin) {
  const settings = await getSettings(env, site.id);
  if (!emailConfigured(env, settings)) return;
  const exp = now() + 86400 * 3; // links valid 3 days
  const link = async (action) =>
    requestOrigin + "/api/email-action?site=" + site.id + "&post=" + post.id +
    "&action=" + action + "&exp=" + exp +
    "&sig=" + (await emailActionSig(site.admin_key, post.id, action, exp));
  const approveUrl = await link("approve");
  const spamUrl = await link("spam");
  await sendEmail(env, settings, {
    to: site.owner_email, from_addr: "moderation@ikomment.com",
    subject: "New comment awaiting approval on " + site.name,
    html:
      "<p><strong>" + authorName.replace(/</g, "&lt;") + "</strong> commented:</p>" +
      "<blockquote>" + post.body_html + "</blockquote>" +
      "<p><a href='" + approveUrl + "'>✅ Approve</a> &nbsp;·&nbsp; " +
      "<a href='" + spamUrl + "'>🚫 Mark as spam</a></p>" +
      "<p style='color:#888;font-size:12px'>Links expire in 3 days. Manage everything in your iKomment dashboard.</p>",
  }); // sender swallows failures — email can never block the comment itself
}

// GET /api/email-action — the owner tapped a link in the email
async function handleEmailAction(env, params) {
  const siteId = params.get("site"), postId = params.get("post");
  const action = params.get("action"), exp = parseInt(params.get("exp") || "0");
  const sig = params.get("sig");
  const page = (msg) => new Response(
    "<!doctype html><body style='font-family:system-ui;padding:2rem;text-align:center'><h2>" +
    msg + "</h2></body>", { headers: { "content-type": "text/html" } });

  if (!["approve", "spam"].includes(action)) return page("Unknown action.");
  if (now() > exp) return page("This link has expired. Use the dashboard instead.");
  const site = await env.DB.prepare("SELECT * FROM sites WHERE id = ?").bind(siteId).first();
  if (!site) return page("Unknown site.");
  const expected = await emailActionSig(site.admin_key, postId, action, exp);
  if (sig !== expected) return page("Invalid link.");

  const post = await env.DB.prepare(
    "SELECT * FROM posts WHERE id = ? AND site_id = ?").bind(postId, siteId).first();
  if (!post) return page("Comment not found.");

  await applyModeration(env, site, action, post);
  return page(action === "approve" ? "✅ Comment approved." : "🚫 Marked as spam.");
}

// ---------- the shared moderation core (used by admin API + email links) ----------

async function applyModeration(env, site, action, post, targetUserId) {
  const siteId = site.id;
  switch (action) {
    case "approve":
      await env.DB.prepare("UPDATE posts SET status = 'approved' WHERE id = ?").bind(post.id).run();
      if (post.status === "pending") await adjustTrust(env, post.author_id, 1);
      break;
    case "spam":
      await env.DB.prepare("UPDATE posts SET status = 'spam' WHERE id = ?").bind(post.id).run();
      await adjustTrust(env, post.author_id, -1);
      break;
    case "delete":
      await env.DB.prepare("UPDATE posts SET status = 'deleted' WHERE id = ?").bind(post.id).run();
      break;
    case "pin":
    case "unpin":
      await env.DB.prepare("UPDATE posts SET is_pinned = ? WHERE id = ?")
        .bind(action === "pin" ? 1 : 0, post.id).run();
      break;
    case "shadow_ban":
    case "unban":
      await env.DB.prepare("UPDATE users SET is_shadow_banned = ? WHERE id = ? AND site_id = ?")
        .bind(action === "shadow_ban" ? 1 : 0, targetUserId, siteId).run();
      break;
    case "nuke": // delete every post by this user across the whole site
      await env.DB.batch([
        env.DB.prepare("UPDATE posts SET status = 'deleted' WHERE author_id = ? AND site_id = ?")
          .bind(targetUserId, siteId),
        env.DB.prepare("UPDATE users SET is_shadow_banned = 1 WHERE id = ? AND site_id = ?")
          .bind(targetUserId, siteId),
      ]);
      break;
    default:
      throw new Error("unknown action");
  }
  await logModAction(env, siteId, null, action, post ? post.id : null, targetUserId);
}

// ---------- admin API routes ----------

// GET /api/admin/queue?site=X&status=pending|spam|flagged|all
async function handleAdminQueue(env, request, params) {
  const siteId = params.get("site");
  const site = await requireAdmin(env, request, siteId);
  if (!site) return err("invalid admin key", 401);
  const status = params.get("status") || "pending";

  let q;
  if (status === "flagged") {
    q = env.DB.prepare(
      `SELECT p.*, u.display_name, u.trust_level, u.is_shadow_banned,
              (SELECT COUNT(*) FROM flags f WHERE f.post_id = p.id AND f.resolved = 0) AS flag_count
       FROM posts p JOIN users u ON u.id = p.author_id
       WHERE p.site_id = ? AND flag_count > 0 AND p.status != 'deleted'
       ORDER BY p.created_at DESC LIMIT 100`).bind(siteId);
  } else {
    q = env.DB.prepare(
      `SELECT p.*, u.display_name, u.trust_level, u.is_shadow_banned
       FROM posts p JOIN users u ON u.id = p.author_id
       WHERE p.site_id = ? AND (? = 'all' OR p.status = ?)
       ORDER BY p.created_at DESC LIMIT 100`).bind(siteId, status, status);
  }
  const rows = await q.all();
  return json({ posts: rows.results || [] });
}

// POST /api/admin/action — body: { site, action, post_id?, user_id? }
async function handleAdminAction(env, request) {
  const data = await request.json().catch(() => null);
  if (!data) return err("invalid JSON");
  const site = await requireAdmin(env, request, data.site);
  if (!site) return err("invalid admin key", 401);

  let post = null;
  if (data.post_id) {
    post = await env.DB.prepare("SELECT * FROM posts WHERE id = ? AND site_id = ?")
      .bind(data.post_id, data.site).first();
    if (!post) return err("post not found", 404);
  }
  try {
    await applyModeration(env, site, data.action, post, data.user_id || (post && post.author_id));
  } catch (e) { return err(e.message); }
  return json({ ok: true });
}

// POST /api/admin/words — body: { site, op:'add'|'remove', word, action?:'hold'|'block' }
async function handleAdminWords(env, request) {
  const data = await request.json().catch(() => null);
  if (!data) return err("invalid JSON");
  const site = await requireAdmin(env, request, data.site);
  if (!site) return err("invalid admin key", 401);
  const word = (data.word || "").trim().toLowerCase();
  if (!word) return err("word required");

  if (data.op === "remove") {
    await env.DB.prepare("DELETE FROM word_filters WHERE site_id = ? AND word = ?")
      .bind(data.site, word).run();
  } else {
    await env.DB.prepare(
      "INSERT OR REPLACE INTO word_filters (site_id, word, action) VALUES (?, ?, ?)")
      .bind(data.site, word, data.action === "block" ? "block" : "hold").run();
  }
  return json({ ok: true });
}

// POST /api/admin/regen-key — body: { site }  (dashboard wraps this in type-to-confirm)
async function handleRegenKey(env, request) {
  const data = await request.json().catch(() => null);
  if (!data) return err("invalid JSON");
  const site = await requireAdmin(env, request, data.site);
  if (!site) return err("invalid admin key", 401);
  const fresh = "ik_admin_" + newId() + newId() + newId();
  await env.DB.prepare("UPDATE sites SET admin_key = ? WHERE id = ?").bind(fresh, data.site).run();
  await logModAction(env, data.site, null, "regen_key", null, null);
  return json({ ok: true, admin_key: fresh });
}

// ============================================================
// OWNER DASHBOARD API (Stage 6)
// ============================================================

// ---------- password hashing (PBKDF2, 100k iterations) ----------
async function hashPassword(password, saltHex) {
  const salt = saltHex
    ? Uint8Array.from(saltHex.match(/.{2}/g).map((h) => parseInt(h, 16)))
    : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" }, key, 256);
  const hex = (a) => [...new Uint8Array(a)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return { hash: hex(bits), salt: hex(salt) };
}

// constant-time-ish comparison (avoids leaking match length via timing)
function safeEqual(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// POST /api/admin/signup — { email, password, site_name, domain }
// Creates the owner account, the site, and its default settings in one step.
async function handleSignup(env, request) {
  const d = await request.json().catch(() => null);
  if (!d) return err("invalid JSON");
  const email = (d.email || "").trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return err("valid email required");
  if (!d.password || d.password.length < 8) return err("password must be at least 8 characters");
  if (!d.site_name || !d.domain) return err("site name and domain required");

  const existing = await env.DB.prepare(
    "SELECT id FROM sites WHERE owner_email = ?").bind(email).first();
  if (existing) return err("an account with this email already exists", 409);

  const siteId = newId();
  const adminKey = "ik_admin_" + newId() + newId();
  const { hash, salt } = await hashPassword(d.password);
  const domain = (d.domain || "").replace(/^https?:\/\//, "").replace(/\/.*$/, "").toLowerCase();

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO sites (id, owner_email, owner_password_hash, owner_salt, name, domain,
                          plan, admin_key, created_at, pageviews_month, pageviews_reset_at)
       VALUES (?, ?, ?, ?, ?, ?, 'self', ?, ?, 0, ?)`
    ).bind(siteId, email, hash, salt, d.site_name.slice(0, 80), domain,
           adminKey, now(), now() + 30 * 86400),
    env.DB.prepare("INSERT INTO site_settings (site_id) VALUES (?)").bind(siteId),
  ]);

  return json({ ok: true, site_id: siteId, admin_key: adminKey,
                site: { id: siteId, name: d.site_name, domain, plan: "self" } });
}

// POST /api/admin/login — { email, password }
async function handleLogin(env, request) {
  const d = await request.json().catch(() => null);
  if (!d) return err("invalid JSON");
  const email = (d.email || "").trim().toLowerCase();
  const site = await env.DB.prepare(
    "SELECT * FROM sites WHERE owner_email = ?").bind(email).first();
  // same error for wrong email and wrong password — don't reveal which
  if (!site || !site.owner_password_hash)
    return err("incorrect email or password", 401);
  const { hash } = await hashPassword(d.password || "", site.owner_salt);
  if (!safeEqual(hash, site.owner_password_hash))
    return err("incorrect email or password", 401);

  const settings = await getSettings(env, site.id);
  return json({ ok: true, site_id: site.id, admin_key: site.admin_key,
                site: { id: site.id, name: site.name, domain: site.domain, plan: site.plan,
                        owner_email: site.owner_email },
                settings });
}

// ---------- settings management ----------
// Whitelist of columns the dashboard may change — nothing else gets through.
const EDITABLE_SETTINGS = [
  "module_comments","module_qa","module_forums","module_chat",
  "voting","edit_own","edit_window_minutes","delete_own","markdown",
  "formatting_toolbar","sorting","pinned_comments","flagging","count_badge",
  "guest_posting","guest_recognition","login_magic_link","login_google","login_github","login_sso",
  "ai_spam","pre_moderation","email_moderation","email_provider","word_filter","trust_levels",
  "theme_mode","accent_color","font","corner_radius","lazy_loading",
  "reply_notifications","live_updates",
];

// GET /api/admin/settings?site=X   |   POST { site, changes: { key: value } }
async function handleAdminSettings(env, request, params) {
  if (request.method === "GET") {
    const siteId = params.get("site");
    const site = await requireAdmin(env, request, siteId);
    if (!site) return err("admin key required", 401);
    const settings = await env.DB.prepare(
      "SELECT * FROM site_settings WHERE site_id = ?").bind(siteId).first();
    return json({ settings });
  }
  const d = await request.json().catch(() => null);
  if (!d || !d.changes) return err("invalid JSON");
  const site = await requireAdmin(env, request, d.site);
  if (!site) return err("admin key required", 401);

  const sets = [], vals = [];
  for (const [k, v] of Object.entries(d.changes)) {
    if (!EDITABLE_SETTINGS.includes(k)) return err("unknown setting: " + k);
    sets.push(k + " = ?");
    vals.push(typeof v === "string" ? v.slice(0, 100) : (v ? (typeof v === "number" ? v : 1) : 0));
  }
  if (!sets.length) return err("no changes");
  vals.push(d.site);
  await env.DB.prepare(
    "UPDATE site_settings SET " + sets.join(", ") + " WHERE site_id = ?").bind(...vals).run();
  await env.KV.delete("settings:" + d.site); // widget picks up changes within seconds
  await logModAction(env, d.site, "owner", "settings_change:" + Object.keys(d.changes).join(","), null, null);
  return json({ ok: true });
}

// POST /api/admin/sso-secret — generate (or regenerate) the SSO signing key
async function handleSsoSecret(env, request) {
  const d = await request.json().catch(() => null);
  if (!d) return err("invalid JSON");
  const site = await requireAdmin(env, request, d.site);
  if (!site) return err("admin key required", 401);
  const secret = "ik_sso_" + newId() + newId() + newId();
  await env.DB.prepare(
    "UPDATE site_settings SET sso_secret = ? WHERE site_id = ?").bind(secret, d.site).run();
  await env.KV.delete("settings:" + d.site);
  await logModAction(env, d.site, "owner", "sso_secret_regen", null, null);
  return json({ ok: true, sso_secret: secret });
}

// ---------- pages & per-page overrides ----------
const EDITABLE_OVERRIDES = ["override_comments","override_qa","override_voting",
                            "override_guest_posting","override_pre_moderation"];

// GET /api/admin/pages?site=X&q=search   |   POST { site, page_id, overrides: {} }
async function handleAdminPages(env, request, params) {
  if (request.method === "GET") {
    const siteId = params.get("site");
    const site = await requireAdmin(env, request, siteId);
    if (!site) return err("admin key required", 401);
    const q = "%" + (params.get("q") || "") + "%";
    const rows = await env.DB.prepare(
      `SELECT id, url, title, override_comments, override_qa, override_voting,
              override_guest_posting, override_pre_moderation
       FROM pages WHERE site_id = ? AND (url LIKE ? OR title LIKE ?)
       ORDER BY first_seen DESC LIMIT 200`
    ).bind(siteId, q, q).all();
    return json({ pages: rows.results || [] });
  }
  const d = await request.json().catch(() => null);
  if (!d || !d.page_id || !d.overrides) return err("invalid JSON");
  const site = await requireAdmin(env, request, d.site);
  if (!site) return err("admin key required", 401);
  const sets = [], vals = [];
  for (const [k, v] of Object.entries(d.overrides)) {
    if (!EDITABLE_OVERRIDES.includes(k)) return err("unknown override: " + k);
    sets.push(k + " = ?");
    vals.push(v === null ? null : (v ? 1 : 0)); // null = follow site default
  }
  vals.push(d.page_id, d.site);
  await env.DB.prepare(
    "UPDATE pages SET " + sets.join(", ") + " WHERE id = ? AND site_id = ?").bind(...vals).run();
  return json({ ok: true });
}

// GET /api/admin/overview?site=X — the home screen numbers
async function handleAdminOverview(env, request, params) {
  const siteId = params.get("site");
  const site = await requireAdmin(env, request, siteId);
  if (!site) return err("admin key required", 401);
  const dayAgo = now() - 86400;

  const [pending, today, users, recent] = await Promise.all([
    env.DB.prepare("SELECT COUNT(*) c FROM posts WHERE site_id = ? AND status = 'pending'")
      .bind(siteId).first(),
    env.DB.prepare("SELECT COUNT(*) c FROM posts WHERE site_id = ? AND created_at > ? AND status != 'deleted'")
      .bind(siteId, dayAgo).first(),
    env.DB.prepare("SELECT COUNT(*) c FROM users WHERE site_id = ?").bind(siteId).first(),
    env.DB.prepare(
      `SELECT p.id, p.body_html, p.status, p.created_at, u.display_name
       FROM posts p JOIN users u ON u.id = p.author_id
       WHERE p.site_id = ? AND p.status != 'deleted'
       ORDER BY p.created_at DESC LIMIT 10`).bind(siteId).all(),
  ]);

  return json({
    pending: pending.c, posts_today: today.c, total_users: users.c,
    pageviews_month: site.pageviews_month, plan: site.plan,
    recent: recent.results || [],
  });
}

// ============================================================
// PLATFORM ADAPTER — "the universal plug socket"
// All NEW code talks to these helpers, never to Cloudflare directly.
// A future Docker version swaps ONLY this section (SQLite/Postgres,
// Redis/in-memory cache, any AI endpoint) — business logic untouched.
// Existing Stage 2-6 handlers migrate here opportunistically.
// ============================================================
const platform = {
  dbFirst: (env, sql, ...args) => env.DB.prepare(sql).bind(...args).first(),
  dbAll:   (env, sql, ...args) => env.DB.prepare(sql).bind(...args).all()
             .then((r) => r.results || []),
  dbRun:   (env, sql, ...args) => env.DB.prepare(sql).bind(...args).run(),
  dbBatch: (env, list) => env.DB.batch(list.map(([sql, ...args]) => env.DB.prepare(sql).bind(...args))),
  cacheGet:(env, key) => env.KV.get(key, "json"),
  cachePut:(env, key, value, ttl) => env.KV.put(key, JSON.stringify(value), { expirationTtl: ttl || 60 }),
  cacheDel:(env, key) => env.KV.delete(key),
  aiClassify: (env, text, author) => aiSpamCheck(env, text, author),
};

// ============================================================
// Q&A MODULE API (Stage 7) — built entirely on the platform adapter
// A page's Q&A thread: the page hosts ONE question; top-level posts of
// kind 'answer' are the answers; nested replies under answers are
// ordinary comments. Accepted answer pins to the top with a ✅.
// ============================================================

async function getOrCreateQaThread(env, siteId, pageUrl, pageTitle, questionBody) {
  const url = normaliseUrl(pageUrl);
  let page = await platform.dbFirst(env,
    "SELECT * FROM pages WHERE site_id = ? AND url = ?", siteId, url);
  if (!page) {
    const pageId = newId();
    await platform.dbRun(env,
      "INSERT INTO pages (id, site_id, url, title, first_seen) VALUES (?, ?, ?, ?, ?)",
      pageId, siteId, url, pageTitle || null, now());
    page = { id: pageId };
  }
  let thread = await platform.dbFirst(env,
    "SELECT * FROM threads WHERE site_id = ? AND page_id = ? AND type = 'question'",
    siteId, page.id);
  if (!thread) {
    const threadId = newId();
    await platform.dbRun(env,
      `INSERT INTO threads (id, site_id, page_id, type, title, post_count, last_activity, created_at)
       VALUES (?, ?, ?, 'question', ?, 0, ?, ?)`,
      threadId, siteId, page.id, (questionBody || pageTitle || "").slice(0, 200), now(), now());
    thread = { id: threadId, is_answered: 0, accepted_post_id: null, is_locked: 0 };
  }
  return { page, thread };
}

// GET /api/qa?site=X&url=Y — the whole Q&A view in one call
async function handleGetQa(env, request, params) {
  const siteId = params.get("site");
  const pageUrl = params.get("url");
  if (!siteId || !pageUrl) return err("site and url required");

  const settings = await getSettings(env, siteId);
  if (!settings) return err("unknown site", 404);
  if (!settings.module_qa) return json({ disabled: true });

  const page = await platform.dbFirst(env,
    "SELECT override_qa FROM pages WHERE site_id = ? AND url = ?",
    siteId, normaliseUrl(pageUrl));
  if (page && page.override_qa === 0) return json({ disabled: true });

  const { thread } = await getOrCreateQaThread(env, siteId, pageUrl, params.get("title"));

  const viewer = await getUser(env, request, siteId);
  const viewerId = viewer ? viewer.id : "-";

  const posts = await platform.dbAll(env,
    `SELECT p.id, p.parent_id, p.kind, p.body_html, p.status, p.up_votes, p.down_votes,
            p.depth, p.created_at, p.edited_at,
            u.id AS author_id, u.display_name, u.avatar_url
     FROM posts p JOIN users u ON u.id = p.author_id
     WHERE p.thread_id = ?
       AND p.status != 'deleted'
       AND (p.status = 'approved' OR p.author_id = ?)
       AND (u.is_shadow_banned = 0 OR p.author_id = ?)
     ORDER BY p.created_at ASC LIMIT 500`,
    thread.id, viewerId, viewerId);

  return json({
    thread_id: thread.id,
    question: { title: thread.title, is_answered: thread.is_answered,
                accepted_post_id: thread.accepted_post_id },
    settings: {
      voting: settings.voting, markdown: settings.markdown,
      formatting_toolbar: settings.formatting_toolbar,
      guest_posting: settings.guest_posting,
      login_magic_link: settings.login_magic_link,
      login_google: settings.login_google, login_github: settings.login_github,
      login_sso: settings.login_sso, sorting: settings.sorting,
      theme_mode: settings.theme_mode, accent_color: settings.accent_color,
    },
    posts,
  });
}

// POST /api/qa/accept — body: { site, thread_id, post_id }
// Only the site owner (admin key) can accept in MVP; question authors later.
async function handleQaAccept(env, request) {
  const d = await request.json().catch(() => null);
  if (!d) return err("invalid JSON");
  const site = await requireAdmin(env, request, d.site);
  if (!site) return err("admin key required", 401);

  const post = await platform.dbFirst(env,
    "SELECT id, thread_id, kind FROM posts WHERE id = ? AND site_id = ?", d.post_id, d.site);
  if (!post || post.thread_id !== d.thread_id) return err("answer not found", 404);
  if (post.kind !== "answer") return err("only answers can be accepted");

  const already = await platform.dbFirst(env,
    "SELECT accepted_post_id FROM threads WHERE id = ?", d.thread_id);
  const toggleOff = already && already.accepted_post_id === d.post_id;

  await platform.dbRun(env,
    "UPDATE threads SET accepted_post_id = ?, is_answered = ? WHERE id = ? AND site_id = ?",
    toggleOff ? null : d.post_id, toggleOff ? 0 : 1, d.thread_id, d.site);
  await logModAction(env, d.site, "owner", toggleOff ? "unaccept_answer" : "accept_answer", d.post_id, null);
  return json({ ok: true, accepted: !toggleOff });
}

// ============================================================
// FORUMS MODULE API (Stage 8) — built on the platform adapter
// ============================================================

// GET /api/forum?site=X — categories with thread counts
async function handleGetForum(env, request, params) {
  const siteId = params.get("site");
  const settings = await getSettings(env, siteId);
  if (!settings) return err("unknown site", 404);
  if (!settings.module_forums) return json({ disabled: true });

  const cats = await platform.dbAll(env,
    `SELECT c.id, c.name, c.description, c.position, c.chat_enabled,
            COUNT(t.id) AS thread_count, MAX(t.last_activity) AS last_activity
     FROM categories c LEFT JOIN threads t ON t.category_id = c.id AND t.type = 'forum'
     WHERE c.site_id = ? GROUP BY c.id ORDER BY c.position ASC`, siteId);

  return json({
    categories: cats,
    settings: {
      voting: settings.voting, markdown: settings.markdown,
      formatting_toolbar: settings.formatting_toolbar,
      guest_posting: settings.guest_posting,
      login_magic_link: settings.login_magic_link,
      login_google: settings.login_google, login_github: settings.login_github,
      module_chat: settings.module_chat,
      theme_mode: settings.theme_mode, accent_color: settings.accent_color,
    },
  });
}

// GET /api/forum/threads?site=X&category=Y — thread list, pinned first
async function handleForumThreads(env, request, params) {
  const siteId = params.get("site");
  const catId = params.get("category");
  const settings = await getSettings(env, siteId);
  if (!settings || !settings.module_forums) return err("forums unavailable", 403);

  const threads = await platform.dbAll(env,
    `SELECT t.id, t.title, t.is_pinned, t.is_locked, t.post_count, t.last_activity, t.created_at,
            u.display_name AS author_name
     FROM threads t LEFT JOIN users u ON u.id = t.author_id
     WHERE t.site_id = ? AND t.category_id = ? AND t.type = 'forum'
     ORDER BY t.is_pinned DESC, t.last_activity DESC LIMIT 100`, siteId, catId);
  return json({ threads });
}

// GET /api/forum/thread?site=X&thread_id=Y — one thread's posts
async function handleForumThread(env, request, params) {
  const siteId = params.get("site");
  const threadId = params.get("thread_id");
  const thread = await platform.dbFirst(env,
    "SELECT * FROM threads WHERE id = ? AND site_id = ? AND type = 'forum'", threadId, siteId);
  if (!thread) return err("thread not found", 404);

  const viewer = await getUser(env, request, siteId);
  const viewerId = viewer ? viewer.id : "-";
  const posts = await platform.dbAll(env,
    `SELECT p.id, p.parent_id, p.body_html, p.status, p.up_votes, p.down_votes,
            p.depth, p.created_at, u.id AS author_id, u.display_name
     FROM posts p JOIN users u ON u.id = p.author_id
     WHERE p.thread_id = ? AND p.status != 'deleted'
       AND (p.status = 'approved' OR p.author_id = ?)
       AND (u.is_shadow_banned = 0 OR p.author_id = ?)
     ORDER BY p.created_at ASC LIMIT 500`, threadId, viewerId, viewerId);

  return json({
    thread: { id: thread.id, title: thread.title, is_pinned: thread.is_pinned,
              is_locked: thread.is_locked, created_at: thread.created_at },
    posts,
  });
}

// POST /api/forum/thread — body: { site, category_id, title, body, guest_name }
async function handleForumNewThread(env, request) {
  const d = await request.json().catch(() => null);
  if (!d) return err("invalid JSON");
  const { site: siteId, category_id, title, body } = d;
  if (!title || !title.trim()) return err("title required");
  if (!body || !body.trim()) return err("first post required");

  const settings = await getSettings(env, siteId);
  if (!settings || !settings.module_forums) return err("forums unavailable", 403);
  const cat = await platform.dbFirst(env,
    "SELECT id FROM categories WHERE id = ? AND site_id = ?", category_id, siteId);
  if (!cat) return err("category not found", 404);

  let user = await getUser(env, request, siteId);
  let newGuest = null;
  if (!user) {
    if (!settings.guest_posting) return err("login required", 401);
    if (!d.guest_name || !d.guest_name.trim()) return err("name required");
    user = newGuest = await createGuest(env, siteId, d.guest_name.trim());
  }

  const filterHit = await wordFilterAction(env, siteId, title + " " + body);
  if (filterHit === "block") return err("post rejected", 422);
  let status = "approved";
  if (settings.ai_spam) {
    const verdict = await platform.aiClassify(env, title + "\n" + body, user.display_name);
    if (verdict === "spam") status = "spam";
    else if (verdict === "suspicious") status = "pending";
  }
  if (status === "approved" &&
      (filterHit === "hold" || (settings.pre_moderation && user.trust_level < 2)))
    status = "pending";

  const threadId = newId(), postId = newId(), ts = now();
  await platform.dbBatch(env, [
    [`INSERT INTO threads (id, site_id, category_id, type, title, author_id,
        is_pinned, is_locked, post_count, last_activity, created_at)
      VALUES (?, ?, ?, 'forum', ?, ?, 0, 0, 1, ?, ?)`,
      threadId, siteId, category_id, title.slice(0, 200), user.id, ts, ts],
    [`INSERT INTO posts (id, thread_id, site_id, author_id, parent_id, kind, body, body_html,
        status, up_votes, down_votes, depth, created_at)
      VALUES (?, ?, ?, ?, NULL, 'comment', ?, ?, ?, 0, 0, 0, ?)`,
      postId, threadId, siteId, user.id, body, renderMarkdown(body), status, ts],
  ]);

  return json({ ok: true, thread_id: threadId,
    identity: newGuest ? { user_id: newGuest.id, token: newGuest.guest_token } : null,
    held_for_review: status === "pending" });
}

// GET /api/profile?site=X&user_id=Y — minimal public profile
async function handleProfile(env, request, params) {
  const siteId = params.get("site");
  const userId = params.get("user_id");
  const u = await platform.dbFirst(env,
    "SELECT id, display_name, avatar_url, created_at FROM users WHERE id = ? AND site_id = ?",
    userId, siteId);
  if (!u) return err("user not found", 404);
  const recent = await platform.dbAll(env,
    `SELECT p.body_html, p.created_at, t.title AS thread_title
     FROM posts p LEFT JOIN threads t ON t.id = p.thread_id
     WHERE p.author_id = ? AND p.status = 'approved'
     ORDER BY p.created_at DESC LIMIT 5`, userId);
  return json({ profile: { name: u.display_name, avatar: u.avatar_url,
                           member_since: u.created_at, recent } });
}

// ---------- admin: category management ----------
// POST /api/admin/categories — { site, op:'add'|'remove'|'update', id?, name?, description?, chat_enabled? }
async function handleAdminCategories(env, request, params) {
  if (request.method === "GET") {
    const siteId = params.get("site");
    const site = await requireAdmin(env, request, siteId);
    if (!site) return err("admin key required", 401);
    const cats = await platform.dbAll(env,
      "SELECT * FROM categories WHERE site_id = ? ORDER BY position ASC", siteId);
    return json({ categories: cats });
  }
  const d = await request.json().catch(() => null);
  if (!d) return err("invalid JSON");
  const site = await requireAdmin(env, request, d.site);
  if (!site) return err("admin key required", 401);

  if (d.op === "add") {
    if (!d.name || !d.name.trim()) return err("name required");
    const id = newId();
    const max = await platform.dbFirst(env,
      "SELECT COALESCE(MAX(position),0) m FROM categories WHERE site_id = ?", d.site);
    await platform.dbRun(env,
      "INSERT INTO categories (id, site_id, name, description, position, chat_enabled) VALUES (?, ?, ?, ?, ?, ?)",
      id, d.site, d.name.slice(0, 60), (d.description || "").slice(0, 200), max.m + 1,
      d.chat_enabled === 0 ? 0 : 1);
    return json({ ok: true, id });
  }
  if (d.op === "remove" && d.id) {
    await platform.dbRun(env,
      "DELETE FROM categories WHERE id = ? AND site_id = ?", d.id, d.site);
    return json({ ok: true });
  }
  if (d.op === "update" && d.id) {
    await platform.dbRun(env,
      "UPDATE categories SET name = COALESCE(?, name), description = COALESCE(?, description), chat_enabled = COALESCE(?, chat_enabled) WHERE id = ? AND site_id = ?",
      d.name || null, d.description != null ? d.description : null,
      d.chat_enabled != null ? d.chat_enabled : null, d.id, d.site);
    return json({ ok: true });
  }
  return err("op must be add/remove/update");
}

// ============================================================
// LIVE CHAT (Stage 8) — Durable Objects, deliberately isolated.
// Portability note: in a future Docker version, ONLY this section
// changes (e.g. to a WebSocket server). Everything else is untouched.
// ============================================================

// GET /api/chat/history?site=X&category=Y — recent messages from D1
async function handleChatHistory(env, request, params) {
  const siteId = params.get("site");
  const catId = params.get("category");
  const settings = await getSettings(env, siteId);
  if (!settings || !settings.module_chat) return err("chat unavailable", 403);
  const msgs = await platform.dbAll(env,
    `SELECT m.id, m.body, m.created_at, u.display_name
     FROM chat_messages m JOIN users u ON u.id = m.author_id
     WHERE m.category_id = ? AND m.site_id = ?
     ORDER BY m.created_at DESC LIMIT 50`, catId, siteId);
  return json({ messages: msgs.reverse() });
}

// WebSocket upgrade: /api/chat/connect?site=X&category=Y
// Routed into the ChatRoom Durable Object for that category.
async function handleChatConnect(env, request, params) {
  if (!env.CHAT) return err("chat not configured", 503);
  const siteId = params.get("site");
  const catId = params.get("category");
  const settings = await getSettings(env, siteId);
  if (!settings || !settings.module_chat) return err("chat unavailable", 403);
  const id = env.CHAT.idFromName(siteId + ":" + catId);
  return env.CHAT.get(id).fetch(request);
}

// The Durable Object class — one instance per chat room.
export class ChatRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sessions = []; // everyone currently in the room
  }
  async fetch(request) {
    const url = new URL(request.url);
    if (request.headers.get("upgrade") !== "websocket")
      return new Response("expected websocket", { status: 400 });

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();

    const siteId = url.searchParams.get("site");
    const catId = url.searchParams.get("category");
    const session = { ws: server, user: null };
    this.sessions.push(session);
    this.broadcast({ type: "presence", count: this.sessions.length });

    server.addEventListener("message", async (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === "hello") {
          // identify via the same credential the widgets use
          const [userId, token] = (msg.credential || "").split(":");
          const u = userId && token ? await this.env.DB.prepare(
            "SELECT id, display_name, is_shadow_banned FROM users WHERE id = ? AND guest_token = ? AND site_id = ?"
          ).bind(userId, token, siteId).first() : null;
          session.user = u || null;
          server.send(JSON.stringify({ type: "hello", ok: !!u,
            name: u ? u.display_name : null }));
        }
        if (msg.type === "chat" && session.user && msg.body && msg.body.trim()) {
          if (session.user.is_shadow_banned) {
            // shadow ban in chat: echo only to the sender
            server.send(JSON.stringify({ type: "chat", name: session.user.display_name,
              body: msg.body.slice(0, 500), ts: Math.floor(Date.now() / 1000) }));
            return;
          }
          const body = msg.body.slice(0, 500);
          const ts = Math.floor(Date.now() / 1000);
          this.broadcast({ type: "chat", name: session.user.display_name, body, ts });
          // persist so history survives
          await this.env.DB.prepare(
            `INSERT INTO chat_messages (id, category_id, site_id, author_id, body, created_at)
             VALUES (?, ?, ?, ?, ?, ?)`
          ).bind(
            [...crypto.getRandomValues(new Uint8Array(8))].map((b) => "abcdefghjkmnpqrstuvwxyz23456789"[b % 31]).join(""),
            catId, siteId, session.user.id, body, ts).run();
        }
      } catch (err) { /* malformed message — ignore */ }
    });

    const drop = () => {
      this.sessions = this.sessions.filter((s) => s !== session);
      this.broadcast({ type: "presence", count: this.sessions.length });
    };
    server.addEventListener("close", drop);
    server.addEventListener("error", drop);

    return new Response(null, { status: 101, webSocket: client });
  }
  broadcast(obj) {
    const data = JSON.stringify(obj);
    this.sessions = this.sessions.filter((s) => {
      try { s.ws.send(data); return true; } catch (e) { return false; }
    });
  }
}

// ---------- provider-neutral email sender (platform adapter for email) ----------
// Provider is the owner's dashboard choice; the API key is a deployment
// secret (RESEND_API_KEY / SENDGRID_API_KEY) and never touches the database.
async function sendEmail(env, settings, msg) {
  const provider = (settings && settings.email_provider) === "sendgrid" ? "sendgrid" : "resend";
  try {
    if (provider === "sendgrid") {
      if (!env.SENDGRID_API_KEY) return false;
      const r = await fetch("https://api.sendgrid.com/v3/mail/send", {
        method: "POST",
        headers: { authorization: "Bearer " + env.SENDGRID_API_KEY, "content-type": "application/json" },
        body: JSON.stringify({
          personalizations: [{ to: [{ email: msg.to }] }],
          from: { email: msg.from_addr || "no-reply@ikomment.com", name: msg.from_name || "iKomment" },
          subject: msg.subject,
          content: [{ type: "text/html", value: msg.html }],
        }),
      });
      return r.ok;
    }
    if (!env.RESEND_API_KEY) return false;
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: "Bearer " + env.RESEND_API_KEY, "content-type": "application/json" },
      body: JSON.stringify({
        from: (msg.from_name || "iKomment") + " <" + (msg.from_addr || "no-reply@ikomment.com") + ">",
        to: [msg.to], subject: msg.subject, html: msg.html,
      }),
    });
    return r.ok;
  } catch (e) { return false; }
}

function emailConfigured(env, settings) {
  return (settings && settings.email_provider) === "sendgrid"
    ? !!env.SENDGRID_API_KEY : !!env.RESEND_API_KEY;
}

// ---------- email login (magic link) ----------
// Flow: widget asks for a link → we email it → widget polls status →
// user taps the link (any device) → poll returns the credential.

// POST /api/auth/email/request — { site, email }
async function handleEmailLoginRequest(env, request) {
  const d = await request.json().catch(() => null);
  if (!d) return err("invalid JSON");
  const siteId = d.site;
  const email = (d.email || "").trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return err("valid email required");

  const settings = await getSettings(env, siteId);
  if (!settings || !settings.login_magic_link) return err("email login is not enabled", 403);
  if (!emailConfigured(env, settings)) return err("email login is not configured", 503);

  const site = await platform.dbFirst(env, "SELECT name FROM sites WHERE id = ?", siteId);
  const token = newId() + newId() + newId();
  const requestId = newId() + newId();
  await platform.dbRun(env,
    `INSERT INTO magic_links (token, request_id, site_id, email, expires_at, used)
     VALUES (?, ?, ?, ?, ?, 0)`,
    token, requestId, siteId, email, now() + 900); // 15 minutes

  const base = env.PUBLIC_API_URL || "https://api.ikomment.com";
  const link = base + "/api/auth/email/verify?t=" + token;
  await sendEmail(env, settings, {
    to: email, from_addr: "login@ikomment.com",
    subject: "Your sign-in link" + (site ? " — " + site.name : ""),
    html: "<p>Tap to sign in and join the discussion:</p>" +
          "<p><a href='" + link + "'>Sign me in</a></p>" +
          "<p style='color:#888;font-size:12px'>This link works once and expires in 15 minutes. " +
          "If you didn't request it, you can ignore this email.</p>",
  });
  return json({ ok: true, request_id: requestId });
}

// GET /api/auth/email/verify?t=... — the link in the inbox
async function handleEmailLoginVerify(env, params) {
  const t = params.get("t") || "";
  const row = await platform.dbFirst(env, "SELECT * FROM magic_links WHERE token = ?", t);
  const page = (msg) => new Response(
    "<!doctype html><body style='font-family:system-ui;padding:2rem;text-align:center'>" +
    "<h2>" + msg + "</h2></body>", { headers: { "content-type": "text/html" } });
  if (!row || row.used) return page("This sign-in link is invalid or already used.");
  if (now() > row.expires_at) return page("This sign-in link has expired. Request a new one.");

  const name = row.email.split("@")[0]; // friendly default display name
  const user = await upsertExternalUser(env, row.site_id, "email", row.email, name, row.email, null);
  await platform.dbRun(env,
    "UPDATE magic_links SET used = 1, user_id = ?, user_token = ? WHERE token = ?",
    user.id, user.guest_token, t);
  return page("✓ You're signed in. Return to the page you came from — it will update by itself.");
}

// GET /api/auth/email/status?r=... — the widget's poll while waiting
async function handleEmailLoginStatus(env, params) {
  const r = params.get("r") || "";
  const row = await platform.dbFirst(env, "SELECT * FROM magic_links WHERE request_id = ?", r);
  if (!row) return err("unknown request", 404);
  if (now() > row.expires_at && !row.used) return json({ status: "expired" });
  if (!row.used) return json({ status: "pending" });
  const u = await platform.dbFirst(env, "SELECT display_name FROM users WHERE id = ?", row.user_id);
  return json({ status: "done",
    identity: { user_id: row.user_id, token: row.user_token,
                name: u ? u.display_name : row.email.split("@")[0] } });
}

// ============================================================
// DISQUS IMPORT (admin) — the dashboard parses the export file in
// the owner's browser and sends comments here in small batches.
// Client sends parents before children and translates parent ids
// using the mapping we return, so nesting survives perfectly.
// ============================================================
// POST /api/admin/import — { site, items:[{ ext_id, parent_new_id?, page_url,
//   page_title?, author_name, author_email?, body_html, created_at }] }
async function handleAdminImport(env, request) {
  const d = await request.json().catch(() => null);
  if (!d || !Array.isArray(d.items)) return err("invalid JSON");
  if (d.items.length > 200) return err("max 200 items per batch");
  const site = await requireAdmin(env, request, d.site);
  if (!site) return err("admin key required", 401);

  const map = {};          // ext_id (Disqus id) → new iKomment post id
  const userCache = {};    // author key → user id (within this batch)
  const threadCache = {};  // page url → { pageId, threadId }
  let imported = 0, skipped = 0;

  for (const it of d.items) {
    try {
      if (!it.page_url || !it.body_html || !it.author_name) { skipped++; continue; }

      // page + thread (cached per batch; getOrCreateThread handles cross-batch)
      const urlKey = normaliseUrl(it.page_url);
      if (!threadCache[urlKey]) {
        const { thread } = await getOrCreateThread(env, d.site, it.page_url, it.page_title);
        threadCache[urlKey] = thread;
      }
      const thread = threadCache[urlKey];

      // imported author: find-or-create by email (preferred) or name
      const ukey = (it.author_email || "").toLowerCase() || "name:" + it.author_name;
      if (!userCache[ukey]) {
        let u = it.author_email
          ? await platform.dbFirst(env,
              "SELECT id FROM users WHERE site_id = ? AND email = ?", d.site, it.author_email.toLowerCase())
          : await platform.dbFirst(env,
              "SELECT id FROM users WHERE site_id = ? AND kind = 'import' AND display_name = ?", d.site, it.author_name.slice(0, 50));
        if (!u) {
          const uid = newId();
          await platform.dbRun(env,
            `INSERT INTO users (id, site_id, display_name, email, kind, trust_level, created_at, last_seen)
             VALUES (?, ?, ?, ?, 'import', 1, ?, ?)`,
            uid, d.site, it.author_name.slice(0, 50),
            it.author_email ? it.author_email.toLowerCase() : null, now(), now());
          u = { id: uid };
        }
        userCache[ukey] = u.id;
      }

      // parent: already translated by the client to a new id (or null)
      let depth = 0;
      if (it.parent_new_id) {
        const parent = await platform.dbFirst(env,
          "SELECT depth FROM posts WHERE id = ? AND thread_id = ?", it.parent_new_id, thread.id);
        if (parent) depth = parent.depth + 1;
        else it.parent_new_id = null; // orphan: import at top level rather than lose it
      }

      const postId = newId();
      const ts = Math.max(0, parseInt(it.created_at) || now());
      // imported HTML is sanitised: strip tags except basic formatting
      const safe = String(it.body_html)
        .replace(/<(?!\/?(p|br|strong|em|b|i|a|code|blockquote)\b)[^>]*>/gi, "")
        .replace(/ on\w+="[^"]*"/gi, "")
        .replace(/href="(?!https?:\/\/)[^"]*"/gi, 'href="#"')
        .slice(0, 20000);

      await platform.dbBatch(env, [
        [`INSERT INTO posts (id, thread_id, site_id, author_id, parent_id, kind, body, body_html,
            status, up_votes, down_votes, depth, created_at)
          VALUES (?, ?, ?, ?, ?, 'comment', '', ?, 'approved', 0, 0, ?, ?)`,
          postId, thread.id, d.site, userCache[ukey], it.parent_new_id || null, safe, depth, ts],
        ["UPDATE threads SET post_count = post_count + 1, last_activity = MAX(COALESCE(last_activity,0), ?) WHERE id = ?",
          ts, thread.id],
      ]);
      if (it.ext_id) map[it.ext_id] = postId;
      imported++;
    } catch (e) { skipped++; }
  }

  await logModAction(env, d.site, "owner", "disqus_import:" + imported, null, null);
  return json({ ok: true, imported, skipped, map });
}

// ---------- word filter check ----------

async function wordFilterAction(env, siteId, body) {
  const rows = await env.DB.prepare(
    "SELECT word, action FROM word_filters WHERE site_id = ?"
  ).bind(siteId).all();
  const lower = body.toLowerCase();
  for (const r of rows.results || []) {
    if (lower.includes(r.word.toLowerCase())) return r.action; // 'hold' or 'block'
  }
  return null;
}

// ---------- thread fetch / create ----------

async function getOrCreateThread(env, siteId, pageUrl, pageTitle) {
  const url = normaliseUrl(pageUrl);

  let page = await env.DB.prepare(
    "SELECT * FROM pages WHERE site_id = ? AND url = ?"
  ).bind(siteId, url).first();

  if (!page) {
    const pageId = newId();
    await env.DB.prepare(
      "INSERT INTO pages (id, site_id, url, title, first_seen) VALUES (?, ?, ?, ?, ?)"
    ).bind(pageId, siteId, url, pageTitle || null, now()).run();
    page = { id: pageId, site_id: siteId, url };
  }

  let thread = await env.DB.prepare(
    "SELECT * FROM threads WHERE site_id = ? AND page_id = ? AND type = 'comments'"
  ).bind(siteId, page.id).first();

  if (!thread) {
    const threadId = newId();
    await env.DB.prepare(
      `INSERT INTO threads (id, site_id, page_id, type, post_count, last_activity, created_at)
       VALUES (?, ?, ?, 'comments', 0, ?, ?)`
    ).bind(threadId, siteId, page.id, now(), now()).run();
    thread = { id: threadId, post_count: 0 };
  }

  return { page, thread };
}

// ---------- route handlers ----------

// GET /api/thread — everything the widget needs to render
async function handleGetThread(env, request, params) {
  const siteId = params.get("site");
  const pageUrl = params.get("url");
  if (!siteId || !pageUrl) return err("site and url required");

  const settings = await getSettings(env, siteId);
  if (!settings) return err("unknown site", 404);
  if (!settings.module_comments) return json({ disabled: true });

  // page-level override check
  const url = normaliseUrl(pageUrl);
  const page = await env.DB.prepare(
    "SELECT override_comments FROM pages WHERE site_id = ? AND url = ?"
  ).bind(siteId, url).first();
  if (page && page.override_comments === 0) return json({ disabled: true });

  const { thread } = await getOrCreateThread(env, siteId, pageUrl, params.get("title"));

  // shadow-banned users see their own posts; nobody else does.
  const viewer = await getUser(env, request, siteId);
  const viewerId = viewer ? viewer.id : "-";

  const posts = await env.DB.prepare(
    `SELECT p.id, p.parent_id, p.body_html, p.status, p.is_pinned,
            p.up_votes, p.down_votes, p.depth, p.created_at, p.edited_at,
            u.id AS author_id, u.display_name, u.avatar_url, u.is_shadow_banned
     FROM posts p JOIN users u ON u.id = p.author_id
     WHERE p.thread_id = ?
       AND p.status != 'deleted'
       AND (p.status = 'approved' OR p.author_id = ?)
       AND (u.is_shadow_banned = 0 OR p.author_id = ?)
     ORDER BY p.is_pinned DESC, p.created_at ASC
     LIMIT 500`
  ).bind(thread.id, viewerId, viewerId).all();

  return json({
    thread_id: thread.id,
    settings: {
      voting: settings.voting,
      markdown: settings.markdown,
      formatting_toolbar: settings.formatting_toolbar,
      guest_posting: settings.guest_posting,
      login_magic_link: settings.login_magic_link,
      login_google: settings.login_google,
      login_github: settings.login_github,
      login_sso: settings.login_sso,
      sorting: settings.sorting,
      theme_mode: settings.theme_mode,
      accent_color: settings.accent_color,
    },
    posts: posts.results || [],
  });
}

// POST /api/post — body: { site, url, title, parent_id, body, guest_name }
async function handleCreatePost(env, request) {
  const data = await request.json().catch(() => null);
  if (!data) return err("invalid JSON");
  const { site: siteId, url: pageUrl, parent_id, body, guest_name } = data;

  if (!siteId || (!pageUrl && !(data.module === "forum" && data.thread_id)))
    return err("site and url required");
  if (!body || !body.trim()) return err("comment cannot be empty");
  if (body.length > 10000) return err("comment too long (10,000 character max)");

  const settings = await getSettings(env, siteId);
  if (!settings) return err("unknown site", 404);
  if (!settings.module_comments) return err("comments are disabled", 403);

  // identify or create the user
  let user = await getUser(env, request, siteId);
  let newGuest = null;
  if (!user) {
    if (!settings.guest_posting) return err("login required", 401);
    if (!guest_name || !guest_name.trim()) return err("name required");
    user = newGuest = await createGuest(env, siteId, guest_name.trim());
  }

  // word filter
  const filterHit = await wordFilterAction(env, siteId, body);
  if (filterHit === "block") return err("comment rejected", 422);

  // which module is posting? Q&A pages use the question thread;
  // top-level posts there are answers, nested replies are comments.
  let thread, postKind = "comment";
  if (data.module === "qa") {
    if (!settings.module_qa) return err("Q&A is disabled", 403);
    ({ thread } = await getOrCreateQaThread(env, siteId, pageUrl, data.title));
    if (!parent_id) postKind = "answer";
  } else if (data.module === "forum") {
    if (!settings.module_forums) return err("forums are disabled", 403);
    thread = await platform.dbFirst(env,
      "SELECT * FROM threads WHERE id = ? AND site_id = ? AND type = 'forum'",
      data.thread_id, siteId);
    if (!thread) return err("thread not found", 404);
  } else {
    ({ thread } = await getOrCreateThread(env, siteId, pageUrl, data.title));
  }
  if (thread.is_locked) return err("thread is locked", 403);

  // nesting depth (parent must exist in same thread)
  let depth = 0;
  if (parent_id) {
    const parent = await env.DB.prepare(
      "SELECT depth FROM posts WHERE id = ? AND thread_id = ?"
    ).bind(parent_id, thread.id).first();
    if (!parent) return err("parent comment not found", 404);
    depth = parent.depth + 1;
  }

  // status decision pipeline:
  //  - word filter 'block' already rejected above
  //  - AI verdict: spam → spam bucket; suspicious → pending
  //  - word filter 'hold' → pending
  //  - pre-moderation on → pending, unless the user has earned trust (level 2+)
  //  - otherwise approved
  let status = "approved";
  if (settings.ai_spam) {
    const verdict = await aiSpamCheck(env, body, user.display_name);
    if (verdict === "spam") status = "spam";
    else if (verdict === "suspicious") status = "pending";
  }
  if (status === "approved") {
    if (filterHit === "hold") status = "pending";
    else if (settings.pre_moderation && user.trust_level < 2) status = "pending";
  }

  const postId = newId();
  const ts = now();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO posts (id, thread_id, site_id, author_id, parent_id, kind, body, body_html,
                          status, up_votes, down_votes, depth, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?)`
    ).bind(postId, thread.id, siteId, user.id, parent_id || null, postKind,
           body, renderMarkdown(body), status, depth, ts),
    env.DB.prepare(
      "UPDATE threads SET post_count = post_count + 1, last_activity = ? WHERE id = ?"
    ).bind(ts, thread.id),
    env.DB.prepare(
      "UPDATE users SET last_seen = ? WHERE id = ?"
    ).bind(ts, user.id),
  ]);

  // email moderation: notify the owner about held comments (OFF by default)
  if (status === "pending" && settings.email_moderation) {
    const site = await env.DB.prepare("SELECT * FROM sites WHERE id = ?").bind(siteId).first();
    if (site) {
      const origin = new URL(request.url).origin;
      await sendModerationEmail(env, site,
        { id: postId, body_html: renderMarkdown(body), status },
        user.display_name, origin);
    }
  }

  return json({
    ok: true,
    post: {
      id: postId, parent_id: parent_id || null, status, depth, kind: postKind,
      body_html: renderMarkdown(body),
      author_id: user.id, display_name: user.display_name,
      created_at: ts, up_votes: 0, down_votes: 0,
    },
    // first-time guests get their identity to store locally
    identity: newGuest ? { user_id: newGuest.id, token: newGuest.guest_token } : null,
    held_for_review: status === "pending",
  });
}

// POST /api/vote — body: { site, post_id, value }  value: 1 | -1 | 0 (remove)
async function handleVote(env, request) {
  const data = await request.json().catch(() => null);
  if (!data) return err("invalid JSON");
  const { site: siteId, post_id, value } = data;
  if (![1, -1, 0].includes(value)) return err("value must be 1, -1 or 0");

  const settings = await getSettings(env, siteId);
  if (!settings || !settings.voting) return err("voting unavailable", 403);

  const user = await getUser(env, request, siteId);
  if (!user) return err("login or comment first to vote", 401);

  const existing = await env.DB.prepare(
    "SELECT value FROM votes WHERE post_id = ? AND user_id = ?"
  ).bind(post_id, user.id).first();

  const old = existing ? existing.value : 0;
  if (old === value) return json({ ok: true, unchanged: true });

  const ops = [];
  if (existing) {
    ops.push(env.DB.prepare(
      value === 0
        ? "DELETE FROM votes WHERE post_id = ? AND user_id = ?"
        : "UPDATE votes SET value = ?2 WHERE post_id = ?1 AND user_id = ?3"
    ).bind(...(value === 0 ? [post_id, user.id] : [post_id, value, user.id])));
  } else {
    ops.push(env.DB.prepare(
      "INSERT INTO votes (post_id, user_id, value, created_at) VALUES (?, ?, ?, ?)"
    ).bind(post_id, user.id, value, now()));
  }

  // adjust cached counters by the difference
  const upDelta = (value === 1 ? 1 : 0) - (old === 1 ? 1 : 0);
  const downDelta = (value === -1 ? 1 : 0) - (old === -1 ? 1 : 0);
  ops.push(env.DB.prepare(
    "UPDATE posts SET up_votes = up_votes + ?, down_votes = down_votes + ? WHERE id = ?"
  ).bind(upDelta, downDelta, post_id));

  await env.DB.batch(ops);
  return json({ ok: true });
}

// POST /api/edit — body: { site, post_id, body }
async function handleEdit(env, request) {
  const data = await request.json().catch(() => null);
  if (!data) return err("invalid JSON");
  const { site: siteId, post_id, body } = data;
  if (!body || !body.trim()) return err("comment cannot be empty");

  const settings = await getSettings(env, siteId);
  if (!settings || !settings.edit_own) return err("editing unavailable", 403);

  const user = await getUser(env, request, siteId);
  if (!user) return err("not logged in", 401);

  const post = await env.DB.prepare(
    "SELECT author_id, created_at FROM posts WHERE id = ? AND site_id = ?"
  ).bind(post_id, siteId).first();
  if (!post) return err("post not found", 404);
  if (post.author_id !== user.id) return err("you can only edit your own comments", 403);

  const windowSecs = (settings.edit_window_minutes || 15) * 60;
  if (now() - post.created_at > windowSecs)
    return err(`edit window (${settings.edit_window_minutes} min) has passed`, 403);

  await env.DB.prepare(
    "UPDATE posts SET body = ?, body_html = ?, edited_at = ? WHERE id = ?"
  ).bind(body, renderMarkdown(body), now(), post_id).run();

  return json({ ok: true, body_html: renderMarkdown(body) });
}

// POST /api/delete — body: { site, post_id }
async function handleDelete(env, request) {
  const data = await request.json().catch(() => null);
  if (!data) return err("invalid JSON");
  const { site: siteId, post_id } = data;

  const settings = await getSettings(env, siteId);
  if (!settings || !settings.delete_own) return err("deleting unavailable", 403);

  const user = await getUser(env, request, siteId);
  if (!user) return err("not logged in", 401);

  const post = await env.DB.prepare(
    "SELECT author_id, thread_id FROM posts WHERE id = ? AND site_id = ?"
  ).bind(post_id, siteId).first();
  if (!post) return err("post not found", 404);
  if (post.author_id !== user.id && !user.is_moderator)
    return err("you can only delete your own comments", 403);

  // soft delete — replies underneath survive as "[deleted]"
  await env.DB.batch([
    env.DB.prepare("UPDATE posts SET status = 'deleted' WHERE id = ?").bind(post_id),
    env.DB.prepare("UPDATE threads SET post_count = post_count - 1 WHERE id = ?").bind(post.thread_id),
  ]);
  return json({ ok: true });
}

// GET /api/count — for the comment count badge
async function handleCount(env, params) {
  const siteId = params.get("site");
  const pageUrl = params.get("url");
  if (!siteId || !pageUrl) return err("site and url required");

  const cacheKey = `count:${siteId}:${normaliseUrl(pageUrl)}`;
  const cached = await env.KV.get(cacheKey);
  if (cached !== null) return json({ count: parseInt(cached) });

  const row = await env.DB.prepare(
    `SELECT t.post_count AS c FROM threads t
     JOIN pages pg ON pg.id = t.page_id
     WHERE t.site_id = ? AND pg.url = ? AND t.type = 'comments'`
  ).bind(siteId, normaliseUrl(pageUrl)).first();

  const count = row ? row.c : 0;
  await env.KV.put(cacheKey, String(count), { expirationTtl: 60 });
  return json({ count });
}

// ---------- main router ----------

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "OPTIONS") return json({}); // CORS preflight

    try {
      // auth endpoints: /api/auth/google, /api/auth/google/callback, same for github
      var authMatch = path.match(/^\/api\/auth\/(google|github)(\/callback)?$/);
      if (request.method === "GET" && authMatch) {
        return authMatch[2]
          ? await handleAuthCallback(env, request, authMatch[1], url.searchParams)
          : await handleAuthStart(env, request, authMatch[1], url.searchParams);
      }

      if (request.method === "GET" && path === "/api/thread")
        return await handleGetThread(env, request, url.searchParams);
      if (request.method === "GET" && path === "/api/count")
        return await handleCount(env, url.searchParams);
      if (request.method === "POST" && path === "/api/post")
        return await handleCreatePost(env, request);
      if (request.method === "POST" && path === "/api/vote")
        return await handleVote(env, request);
      if (request.method === "POST" && path === "/api/edit")
        return await handleEdit(env, request);
      if (request.method === "POST" && path === "/api/delete")
        return await handleDelete(env, request);

      if (request.method === "POST" && path === "/api/auth/email/request")
        return await handleEmailLoginRequest(env, request);
      if (request.method === "GET" && path === "/api/auth/email/verify")
        return await handleEmailLoginVerify(env, url.searchParams);
      if (request.method === "GET" && path === "/api/auth/email/status")
        return await handleEmailLoginStatus(env, url.searchParams);
      if (request.method === "GET" && path === "/api/qa")
        return await handleGetQa(env, request, url.searchParams);
      if (request.method === "POST" && path === "/api/qa/accept")
        return await handleQaAccept(env, request);
      if (request.method === "GET" && path === "/api/forum")
        return await handleGetForum(env, request, url.searchParams);
      if (request.method === "GET" && path === "/api/forum/threads")
        return await handleForumThreads(env, request, url.searchParams);
      if (request.method === "GET" && path === "/api/forum/thread")
        return await handleForumThread(env, request, url.searchParams);
      if (request.method === "POST" && path === "/api/forum/thread")
        return await handleForumNewThread(env, request);
      if (request.method === "GET" && path === "/api/profile")
        return await handleProfile(env, request, url.searchParams);
      if (path === "/api/admin/categories")
        return await handleAdminCategories(env, request, url.searchParams);
      if (request.method === "GET" && path === "/api/chat/history")
        return await handleChatHistory(env, request, url.searchParams);
      if (request.method === "GET" && path === "/api/chat/connect")
        return await handleChatConnect(env, request, url.searchParams);
      if (request.method === "GET" && path === "/api/email-action")
        return await handleEmailAction(env, url.searchParams);
      if (request.method === "POST" && path === "/api/admin/signup")
        return await handleSignup(env, request);
      if (request.method === "POST" && path === "/api/admin/login")
        return await handleLogin(env, request);
      if (path === "/api/admin/settings")
        return await handleAdminSettings(env, request, url.searchParams);
      if (path === "/api/admin/pages")
        return await handleAdminPages(env, request, url.searchParams);
      if (request.method === "GET" && path === "/api/admin/overview")
        return await handleAdminOverview(env, request, url.searchParams);
      if (request.method === "POST" && path === "/api/admin/import")
        return await handleAdminImport(env, request);
      if (request.method === "POST" && path === "/api/admin/sso-secret")
        return await handleSsoSecret(env, request);
      if (request.method === "GET" && path === "/api/admin/queue")
        return await handleAdminQueue(env, request, url.searchParams);
      if (request.method === "POST" && path === "/api/admin/action")
        return await handleAdminAction(env, request);
      if (request.method === "POST" && path === "/api/admin/words")
        return await handleAdminWords(env, request);
      if (request.method === "GET" && path === "/api/admin/words") {
        const siteId = url.searchParams.get("site");
        const site = await requireAdmin(env, request, siteId);
        if (!site) return err("admin key required", 401);
        const rows = await env.DB.prepare(
          "SELECT word, action FROM word_filters WHERE site_id = ?").bind(siteId).all();
        return json({ words: rows.results || [] });
      }
      if (request.method === "POST" && path === "/api/admin/regen-key")
        return await handleRegenKey(env, request);

      return err("not found", 404);
    } catch (e) {
      return err("server error: " + e.message, 500);
    }
  },
};
