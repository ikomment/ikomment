/**
 * CalCheckAI Cloudflare Worker API
 * Deploy: wrangler deploy
 * Bindings required: DB (D1 database)
 */

/**
 * CalCheckAI Handle Protocol
 * ─────────────────────
 * Format:       5–19 chars · a-z 0-9 _ . only
 * Constraints:  no leading/trailing . or _ · no consecutive separators (.. __ ._ _.)
 * Case:         stored lowercase
 * Reserved:     3–4 chars → premium tier only
 * Category B:   famous identities blocked · separator variants blocked · numeric suffix allowed
 * Cooling:      50 days after vacating before anyone can claim
 * Override:     D1 handle_overrides table wins over everything (legal/urgent)
 * Blocklist:    GitHub JSON → Cloudflare KV (refreshed every 6h via cron)
 */

// ─── ULID GENERATOR ──────────────────────────────────────────────────────────
// Lightweight ULID — no external dependencies, runs natively in Workers
const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford Base32

function ulid() {
  const now = Date.now();
  let ts = '';
  let t = now;
  for (let i = 9; i >= 0; i--) { ts = ENCODING[t % 32] + ts; t = Math.floor(t / 32); }
  let rand = '';
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  let bIdx = 0;
  let bits = 0, bitsLeft = 0;
  for (let i = 0; i < 16; i++) {
    if (bitsLeft < 5) { bits = (bits << 8) | bytes[bIdx++]; bitsLeft += 8; }
    rand += ENCODING[(bits >>> (bitsLeft - 5)) & 31];
    bitsLeft -= 5;
  }
  return ts + rand;
}

function makeId(prefix) { return `${prefix}_${ulid()}`; }

// ─── HANDLE VALIDATION ───────────────────────────────────────────────────────
const HANDLE_RE = /^[a-z0-9_.]{5,19}$/;
const CONSECUTIVE_RE = /[._]{2}|[._][._]/;   // .. __ ._ _.

function validateHandleFormat(raw) {
  const h = raw.toLowerCase().trim();
  if (!h)                           return { ok: false, reason: 'Handle is required' };
  if (h.length < 5)                 return { ok: false, reason: 'Handle must be at least 5 characters' };
  if (h.length > 19)                return { ok: false, reason: 'Handle must be 19 characters or fewer' };
  if (!HANDLE_RE.test(h))           return { ok: false, reason: 'Only letters, numbers, _ and . are allowed' };
  if (/^[._]/.test(h))             return { ok: false, reason: 'Handle cannot start with . or _' };
  if (/[._]$/.test(h))             return { ok: false, reason: 'Handle cannot end with . or _' };
  if (CONSECUTIVE_RE.test(h))      return { ok: false, reason: 'No consecutive separators (.. __ ._ _.)' };
  if (h.length <= 4)               return { ok: false, reason: 'taken' }; // silently reserve 3-4 chars
  return { ok: true, handle: h };
}

// Normalise handle for Category B matching — strip separators, lowercase
function normalise(h) { return h.replace(/[_.]/g, '').toLowerCase(); }

// Check if handle matches a protected identity (with or without numeric suffix)
// Allows: protectedname + digits only (mrbeast65 ✅)
// Blocks: protectedname + word extension (mrbeastfan ✅ allowed)
function matchesProtected(handle, protectedList) {
  const norm = normalise(handle);
  for (const p of protectedList) {
    const pNorm = normalise(p);
    if (norm === pNorm) return true;                          // exact match
    // Check numeric-only suffix: strip trailing digits, see if remainder matches
    const stripped = norm.replace(/[0-9]+$/, '');
    if (stripped === pNorm && stripped !== norm) continue;    // numeric suffix — ALLOWED
    // If norm starts with pNorm and has extra chars → word extension — allowed
  }
  return false;
}

// ─── BLOCKLIST (KV-cached, refreshed from GitHub every 6h) ───────────────────
const KV_BLOCKLIST_KEY = 'handle_blocklist';
const BLOCKLIST_URL    = 'https://raw.githubusercontent.com/YOUR_ORG/YOUR_REPO/main/blocklist.json';

async function getBlocklist(env) {
  // Try KV cache first
  try {
    const cached = await env.KV.get(KV_BLOCKLIST_KEY, 'json');
    if (cached) return cached;
  } catch {}
  // Fetch from GitHub
  try {
    const res  = await fetch(BLOCKLIST_URL);
    const data = await res.json();
    await env.KV.put(KV_BLOCKLIST_KEY, JSON.stringify(data), { expirationTtl: 21600 }); // 6h
    return data;
  } catch {
    return { protected: [], platform_reserved: [] };
  }
}

// Refresh blocklist — called by cron every 6 hours
async function refreshBlocklist(env) {
  try {
    const res  = await fetch(BLOCKLIST_URL);
    const data = await res.json();
    await env.KV.put(KV_BLOCKLIST_KEY, JSON.stringify(data), { expirationTtl: 21600 });
    console.log('Blocklist refreshed:', data.protected.length, 'protected handles');
  } catch (e) {
    console.error('Blocklist refresh failed:', e.message);
  }
}

// ─── AI HANDLE CHECK ─────────────────────────────────────────────────────────
// Called on new handle registration — auto-adds to blocklist if AI says yes
async function aiHandleCheck(handle, env) {
  try {
    const res = await env.AI.run('@cf/meta/llama-3.2-11b-vision-instruct', {
      messages: [{
        role: 'user',
        content: `Is "${handle}" the name of a well-known public figure, celebrity, brand, or organisation that someone might impersonate? Answer only YES or NO.`
      }]
    });
    const answer = (res.response || '').trim().toUpperCase();
    if (answer.startsWith('YES')) {
      // Auto-add to D1 overrides
      await env.DB.prepare(
        "INSERT OR IGNORE INTO handle_overrides (handle, action, reason, created_by) VALUES (?,?,?,?)"
      ).bind(handle, 'block', 'ai_auto_detected', 'system').run();
      return true;
    }
  } catch {}
  return false;
}

// ─── FULL HANDLE CHECK ───────────────────────────────────────────────────────
async function checkHandleAvailability(handle, currentUserId, env) {
  // 1. Format validation
  const fmt = validateHandleFormat(handle);
  if (!fmt.ok) return { available: false, reason: fmt.reason };
  const h = fmt.handle;

  // 2. D1 override table (wins over everything — legal/admin)
  const override = await env.DB.prepare(
    'SELECT action FROM handle_overrides WHERE handle = ?'
  ).bind(h).first();
  if (override) return { available: false, reason: 'taken' };

  // 3. KV blocklist (platform_reserved + Category B protected)
  const blocklist = await getBlocklist(env);
  if ((blocklist.platform_reserved || []).includes(h)) return { available: false, reason: 'taken' };
  if (matchesProtected(h, blocklist.protected || []))   return { available: false, reason: 'taken' };

  // 4. Cooling period — vacated handles locked for 50 days
  const cooling = await env.DB.prepare(
    "SELECT 1 FROM handle_history WHERE handle = ? AND expires_at > datetime('now')"
  ).bind(h).first();
  if (cooling) return { available: false, reason: 'taken' };

  // 5. Already claimed by another user
  const existing = await env.DB.prepare(
    'SELECT id FROM users WHERE handle = ?'
  ).bind(h).first();
  if (existing && existing.id !== currentUserId) return { available: false, reason: 'taken' };

  return { available: true, handle: h };
}

// ─── CLAIM HANDLE ────────────────────────────────────────────────────────────
async function claimHandle(userId, newHandle, env) {
  const check = await checkHandleAvailability(newHandle, userId, env);
  if (!check.available) return { ok: false, reason: check.reason };
  const h = check.handle;

  // Get current handle to record in history
  const user = await env.DB.prepare('SELECT handle FROM users WHERE id = ?').bind(userId).first();

  if (user?.handle && user.handle !== h) {
    // Record old handle in history with 50-day cooling period
    const expires = new Date();
    expires.setDate(expires.getDate() + 50);
    await env.DB.prepare(
      'INSERT OR REPLACE INTO handle_history (handle, user_id, expires_at) VALUES (?,?,?)'
    ).bind(user.handle, userId, expires.toISOString()).run();
  }

  // Claim the new handle
  await env.DB.prepare('UPDATE users SET handle = ? WHERE id = ?').bind(h, userId).run();

  // Background AI check on new handles (non-blocking)
  env.waitUntil?.(aiHandleCheck(h, env));

  return { ok: true, handle: h };
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
};

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });

const err = (msg, status = 400) => json({ error: msg }, status);
// uid kept for session tokens only
const uid = () => crypto.randomUUID();

// ─── AUTH ─────────────────────────────────────────────────────────────────────
async function getSession(request, env) {
  const auth = request.headers.get('Authorization');
  if (!auth?.startsWith('Bearer ')) return null;
  const token = auth.slice(7);
  const session = await env.DB.prepare(
    'SELECT user_id, expires_at FROM sessions WHERE token = ?'
  ).bind(token).first();
  if (!session) return null;
  if (new Date(session.expires_at) < new Date()) return null;
  return session.user_id;
}

async function requireAuth(request, env) {
  const userId = await getSession(request, env);
  if (!userId) throw Object.assign(new Error('Unauthorized'), { status: 401 });
  return userId;
}

// ─── HANDLERS ─────────────────────────────────────────────────────────────────

async function handleAuth(request, env) {
  const { credential, theme } = await request.json();
  const userTheme = theme === 'light' ? 'light' : 'dark';

  // Verify Google token
  const gRes = await fetch(
    `https://www.googleapis.com/oauth2/v3/tokeninfo?id_token=${credential}`
  );
  if (!gRes.ok) return err('Invalid Google token', 401);
  const g = await gRes.json();
  if (g.error_description) return err(g.error_description, 401);

  // Upsert user
  let user = await env.DB.prepare(
    'SELECT * FROM users WHERE google_id = ?'
  ).bind(g.sub).first();

  if (!user) {
    const id = makeId('usr');
    await env.DB.prepare(
      'INSERT INTO users (id,google_id,name,email,picture,theme) VALUES (?,?,?,?,?,?)'
    ).bind(id, g.sub, g.name, g.email, g.picture || null, userTheme).run();
    user = { id, google_id: g.sub, name: g.name, email: g.email, picture: g.picture, bio: '', follower_count: 0, following_count: 0, label_count: 0 };
  } else {
    await env.DB.prepare(
      'UPDATE users SET name=?, picture=?, theme=? WHERE id=?'
    ).bind(g.name, g.picture || null, userTheme, user.id).run();
  }

  // Create 30-day session
  const token = uid() + uid();
  const expires = new Date();
  expires.setDate(expires.getDate() + 30);
  await env.DB.prepare(
    'INSERT INTO sessions (token,user_id,expires_at) VALUES (?,?,?)'
  ).bind(token, user.id, expires.toISOString()).run();

  return json({ token, user });
}

async function handleGetMe(request, env) {
  const userId = await requireAuth(request, env);
  const user = await env.DB.prepare('SELECT * FROM users WHERE id=?').bind(userId).first();
  const labels = await env.DB.prepare(`
    SELECT l.*, ul.joined_at FROM labels l
    JOIN user_labels ul ON l.id = ul.label_id
    WHERE ul.user_id = ? AND l.visibility = 'public'
    ORDER BY ul.joined_at ASC
  `).bind(userId).all();
  return json({ ...user, labels: labels.results });
}

async function handleUpdateMe(request, env) {
  const userId = await requireAuth(request, env);
  const { name, bio } = await request.json();
  await env.DB.prepare('UPDATE users SET name=?, bio=? WHERE id=?')
    .bind(name || '', bio || '', userId).run();
  return json({ success: true });
}

async function handleGetUser(userId, currentUserId, env) {
  // Record profile visit silently (non-blocking)
  if (currentUserId && currentUserId !== userId) {
    recordProfileVisit(userId, currentUserId, env).catch(() => {});
    // Update visitor's last_seen
    env.DB.prepare("UPDATE users SET last_seen=datetime('now') WHERE id=?").bind(currentUserId).run().catch(() => {});
  }

  const user = await env.DB.prepare(
    'SELECT id,name,picture,bio,follower_count,following_count,label_count,created_at FROM users WHERE id=?'
  ).bind(userId).first();
  if (!user) return err('User not found', 404);

  const labels = await env.DB.prepare(`
    SELECT l.id, l.name, l.type, l.member_count, l.parent_id FROM labels l
    JOIN user_labels ul ON l.id = ul.label_id
    WHERE ul.user_id = ? AND l.visibility = 'public'
  `).bind(userId).all();

  let isFollowing = false;
  if (currentUserId && currentUserId !== userId) {
    const f = await env.DB.prepare(
      'SELECT 1 FROM follows WHERE follower_id=? AND following_id=?'
    ).bind(currentUserId, userId).first();
    isFollowing = !!f;
  }

  return json({ ...user, labels: labels.results, isFollowing, isOwn: currentUserId === userId });
}

async function handleGetFollowers(targetId, page, env) {
  const users = await env.DB.prepare(`
    SELECT u.id, u.name, u.picture, u.bio, u.follower_count
    FROM users u JOIN follows f ON u.id = f.follower_id
    WHERE f.following_id = ?
    ORDER BY f.created_at DESC LIMIT 30 OFFSET ?
  `).bind(targetId, page * 30).all();
  return json(users.results);
}

async function handleGetFollowing(targetId, page, env) {
  const users = await env.DB.prepare(`
    SELECT u.id, u.name, u.picture, u.bio, u.follower_count
    FROM users u JOIN follows f ON u.id = f.following_id
    WHERE f.follower_id = ?
    ORDER BY f.created_at DESC LIMIT 30 OFFSET ?
  `).bind(targetId, page * 30).all();
  return json(users.results);
}

async function handleFollow(request, env) {
  const followerId = await requireAuth(request, env);
  const { following_id } = await request.json();
  if (followerId === following_id) return err('Cannot follow yourself');

  try {
    await env.DB.prepare('INSERT INTO follows (follower_id,following_id) VALUES (?,?)').bind(followerId, following_id).run();
    await env.DB.batch([
      env.DB.prepare('UPDATE users SET following_count = following_count+1 WHERE id=?').bind(followerId),
      env.DB.prepare('UPDATE users SET follower_count  = follower_count+1  WHERE id=?').bind(following_id),
    ]);
  } catch { /* already following */ }

  return json({ success: true });
}

async function handleUnfollow(followingId, request, env) {
  const followerId = await requireAuth(request, env);
  const res = await env.DB.prepare('DELETE FROM follows WHERE follower_id=? AND following_id=?').bind(followerId, followingId).run();
  if (res.meta.changes > 0) {
    await env.DB.batch([
      env.DB.prepare('UPDATE users SET following_count = MAX(0,following_count-1) WHERE id=?').bind(followerId),
      env.DB.prepare('UPDATE users SET follower_count  = MAX(0,follower_count-1)  WHERE id=?').bind(followingId),
    ]);
  }
  return json({ success: true });
}

async function handleListLabels(url, env) {
  const parentId = url.searchParams.get('parent_id');
  const search   = url.searchParams.get('search')?.trim() || '';

  if (search) {
    // Search across all public labels
    const results = await env.DB.prepare(
      "SELECT l.*, p.name AS parent_name FROM labels l LEFT JOIN labels p ON l.parent_id = p.id WHERE l.name_lower LIKE ? AND l.visibility='public' ORDER BY l.member_count DESC LIMIT 25"
    ).bind(`%${search.toLowerCase()}%`).all();
    return json(results.results);
  }

  if (parentId) {
    // Children of a specific parent
    const results = await env.DB.prepare(
      "SELECT * FROM labels WHERE parent_id=? AND visibility='public' ORDER BY member_count DESC, name ASC"
    ).bind(parentId).all();
    return json(results.results);
  }

  // Root labels (no parent)
  const results = await env.DB.prepare(
    "SELECT * FROM labels WHERE parent_id IS NULL AND visibility='public' ORDER BY member_count DESC, name ASC"
  ).all();
  return json(results.results);
}

async function handleCreateLabel(request, env) {
  const userId = await requireAuth(request, env);
  const { name, parent_id, type } = await request.json();
  if (!name?.trim()) return err('Name is required');

  const nameLower = name.trim().toLowerCase();
  const parentIdVal = parent_id || null;

  // Check for duplicate under same parent
  const existing = await env.DB.prepare(
    'SELECT * FROM labels WHERE name_lower=? AND parent_id IS ?'
  ).bind(nameLower, parentIdVal).first();

  if (existing) return json({ label: existing, created: false });

  const id = makeId('lbl');
  await env.DB.prepare(
    'INSERT INTO labels (id,name,name_lower,parent_id,type,created_by) VALUES (?,?,?,?,?,?)'
  ).bind(id, name.trim(), nameLower, parentIdVal, type || 'other', userId).run();

  const label = await env.DB.prepare('SELECT * FROM labels WHERE id=?').bind(id).first();
  return json({ label, created: true }, 201);
}

async function handleGetLabel(labelId, currentUserId, env) {
  const label = await env.DB.prepare('SELECT * FROM labels WHERE id=?').bind(labelId).first();
  if (!label) return err('Label not found', 404);

  const [members, children, parent] = await Promise.all([
    env.DB.prepare(`
      SELECT u.id, u.name, u.picture, u.bio, u.follower_count
      FROM users u JOIN user_labels ul ON u.id = ul.user_id
      WHERE ul.label_id = ? ORDER BY ul.joined_at DESC LIMIT 50
    `).bind(labelId).all(),
    env.DB.prepare(
      "SELECT * FROM labels WHERE parent_id=? AND visibility='public' ORDER BY member_count DESC, name ASC"
    ).bind(labelId).all(),
    label.parent_id
      ? env.DB.prepare('SELECT id,name,parent_id FROM labels WHERE id=?').bind(label.parent_id).first()
      : Promise.resolve(null),
  ]);

  let isMember = false;
  if (currentUserId) {
    const m = await env.DB.prepare('SELECT 1 FROM user_labels WHERE user_id=? AND label_id=?').bind(currentUserId, labelId).first();
    isMember = !!m;
  }

  return json({ ...label, members: members.results, children: children.results, parent, isMember });
}

async function handleJoinLabel(request, env) {
  const userId = await requireAuth(request, env);
  const { label_id } = await request.json();
  try {
    await env.DB.prepare('INSERT INTO user_labels (user_id,label_id) VALUES (?,?)').bind(userId, label_id).run();
    await env.DB.batch([
      env.DB.prepare('UPDATE labels SET member_count = member_count+1 WHERE id=?').bind(label_id),
      env.DB.prepare('UPDATE users  SET label_count  = label_count+1  WHERE id=?').bind(userId),
    ]);
  } catch { /* already member */ }
  return json({ success: true });
}

async function handleLeaveLabel(labelId, request, env) {
  const userId = await requireAuth(request, env);
  const res = await env.DB.prepare('DELETE FROM user_labels WHERE user_id=? AND label_id=?').bind(userId, labelId).run();
  if (res.meta.changes > 0) {
    await env.DB.batch([
      env.DB.prepare('UPDATE labels SET member_count = MAX(0,member_count-1) WHERE id=?').bind(labelId),
      env.DB.prepare('UPDATE users  SET label_count  = MAX(0,label_count-1)  WHERE id=?').bind(userId),
    ]);
  }
  return json({ success: true });
}

async function handleDiscover(url, env) {
  const trending = await env.DB.prepare(
    "SELECT * FROM labels WHERE visibility='public' ORDER BY member_count DESC LIMIT 20"
  ).all();
  const newest = await env.DB.prepare(
    "SELECT u.id,u.name,u.picture,u.bio,u.follower_count,u.created_at FROM users u ORDER BY u.created_at DESC LIMIT 20"
  ).all();
  return json({ trending: trending.results, newest: newest.results });
}


// ─── AVATAR UPLOAD ────────────────────────────────────────────────────────────
// Flow:
//   1. Client resizes image to ≤800px client-side (canvas)
//   2. Client calls POST /api/users/me/avatar with {contentType, size}
//   3. Worker generates a presigned R2 PUT URL (60s expiry) and a final CDN key
//   4. Client uploads the binary directly to R2 using the presigned URL
//   5. Client calls PATCH /api/users/me/avatar with {key} to confirm
//   6. Worker saves the R2 public URL to users.picture in D1

async function handleAvatarPresign(request, env) {
  const userId = await requireAuth(request, env);
  const { contentType = 'image/jpeg', size = 0 } = await request.json();

  // Basic validation
  const ALLOWED = ['image/jpeg', 'image/png', 'image/webp'];
  if (!ALLOWED.includes(contentType)) return err('Image must be JPEG, PNG or WebP');
  if (size > 5 * 1024 * 1024) return err('Image must be under 5MB');

  // Generate a unique R2 key: avatars/{userId}/{timestamp}.jpg
  const ext   = contentType === 'image/png' ? 'png' : contentType === 'image/webp' ? 'webp' : 'jpg';
  const key   = `avatars/${userId}/${Date.now()}.${ext}`;

  // Create presigned URL — R2 presigned PUT, valid for 60 seconds
  // Requires R2 bucket binding named BUCKET in wrangler.toml
  const presignedUrl = await env.BUCKET.createMultipartUpload
    ? await generatePresignedUrl(key, contentType, env)
    : null;

  // If R2 presigned URLs aren't available (Workers free tier), fall back to
  // direct upload via Worker (see handleAvatarDirect below)
  if (!presignedUrl) {
    return json({ method: 'direct', key, uploadUrl: '/api/users/me/avatar/direct' });
  }

  return json({ method: 'presigned', key, uploadUrl: presignedUrl });
}

async function generatePresignedUrl(key, contentType, env) {
  try {
    // R2 presigned URL generation — requires Workers R2 binding
    const url = await env.BUCKET.put(key, null, {
      httpMetadata: { contentType },
      customMetadata: {},
      onlyIf: { etagDoesNotMatch: '*' }, // don't overwrite
    });
    return url;
  } catch {
    return null;
  }
}

async function handleAvatarConfirm(request, env) {
  const userId = await requireAuth(request, env);
  const { key } = await request.json();
  if (!key || !key.startsWith(`avatars/${userId}/`)) return err('Invalid key');

  // Build the public CDN URL for the R2 object
  // Set env var R2_PUBLIC_URL to your R2 public domain e.g. https://cdn.CalCheckAIapp
  const pictureUrl = `${env.R2_PUBLIC_URL || 'https://cdn.CalCheckAIapp'}/${key}`;

  await env.DB.prepare('UPDATE users SET picture = ? WHERE id = ?')
    .bind(pictureUrl, userId).run();

  return json({ picture: pictureUrl });
}

// Direct upload fallback — client sends binary body straight to Worker
// Used when presigned URLs are unavailable (development / free tier)
async function handleAvatarDirect(request, env) {
  const userId = await requireAuth(request, env);
  const contentType = request.headers.get('Content-Type') || 'image/jpeg';
  const ext = contentType === 'image/png' ? 'png' : 'webp';
  const key = `avatars/${userId}/${Date.now()}.${ext}`;

  const body = await request.arrayBuffer();
  if (body.byteLength > 5 * 1024 * 1024) return err('Image must be under 5MB');

  await env.BUCKET.put(key, body, { httpMetadata: { contentType } });

  const pictureUrl = `${env.R2_PUBLIC_URL || 'https://cdn.CalCheckAIapp'}/${key}`;
  await env.DB.prepare('UPDATE users SET picture = ? WHERE id = ?')
    .bind(pictureUrl, userId).run();

  return json({ picture: pictureUrl });
}




// ─── SSR HELPERS ─────────────────────────────────────────────────────────────
const SITE = 'https://calcheckai.com';

const htmlShell = (title, desc, ogImg, canonicalPath, bodyContent, jsonLd = '') => `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1.0,viewport-fit=cover"/>
<title>${title}</title>
<meta name="description" content="${desc}"/>
<meta name="robots" content="index,follow"/>
<link rel="canonical" href="${SITE}${canonicalPath}"/>
<meta property="og:type" content="website"/>
<meta property="og:site_name" content="CalCheckAI"/>
<meta property="og:url" content="${SITE}${canonicalPath}"/>
<meta property="og:title" content="${title}"/>
<meta property="og:description" content="${desc}"/>
<meta property="og:image" content="${ogImg}"/>
<meta property="og:image:width" content="1200"/>
<meta property="og:image:height" content="630"/>
<meta name="twitter:card" content="summary_large_image"/>
<meta name="twitter:title" content="${title}"/>
<meta name="twitter:description" content="${desc}"/>
<meta name="twitter:image" content="${ogImg}"/>
<meta name="theme-color" content="#c8f135"/>
<meta name="apple-mobile-web-app-capable" content="yes"/>
<link rel="manifest" href="/manifest.json"/>
<link rel="icon" href="/icons/icon-96.png"/>
<link rel="preconnect" href="https://fonts.googleapis.com"/>
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin/>
<link href="https://fonts.googleapis.com/css2?family=Syne:wght@700;800&family=DM+Sans:opsz,wght@9..40,400;9..40,500;9..40,600&display=swap" rel="stylesheet"/>
${jsonLd ? '<script type="application/ld+json">' + jsonLd + '</script>' : ''}
<script defer src="https://static.cloudflareinsights.com/beacon.min.js" data-cf-beacon='{"token":"YOUR_CF_ANALYTICS_TOKEN"}'></script>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0;}
html,body{background:#080808;color:#f2f2f2;font-family:'DM Sans',sans-serif;-webkit-font-smoothing:antialiased;min-height:100dvh;}
a{color:inherit;text-decoration:none;}
.ssr-wrap{max-width:480px;margin:0 auto;padding:0 0 60px;}
.ssr-nav{display:flex;align-items:center;justify-content:space-between;padding:18px 20px;border-bottom:1px solid #1c1c1c;background:#0a0a0a;position:sticky;top:0;z-index:10;}
.ssr-logo{font-family:'Syne',sans-serif;font-weight:800;font-size:1.2rem;letter-spacing:-.5px;}
.ssr-cta{background:#c8f135;color:#000;border:none;border-radius:100px;padding:9px 18px;font-family:'Syne',sans-serif;font-weight:700;font-size:.82rem;cursor:pointer;text-decoration:none;display:inline-block;}
.ssr-cta:hover{filter:brightness(1.06);}
.ssr-hero{padding:28px 20px 20px;border-bottom:1px solid #1c1c1c;}
.ssr-bc{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:14px;}
.ssr-bc-item{font-size:.75rem;color:#8a8a8a;background:#131313;padding:3px 9px;border-radius:6px;}
.ssr-bc-sep{color:#3a3a3a;font-size:.75rem;}
.ssr-h1{font-family:'Syne',sans-serif;font-weight:800;font-size:2rem;letter-spacing:-.5px;margin-bottom:6px;line-height:1.1;}
.ssr-sub{font-size:.88rem;color:#8a8a8a;margin-bottom:18px;line-height:1.6;}
.ssr-stats{display:flex;gap:20px;margin-bottom:20px;}
.ssr-stat{display:flex;flex-direction:column;gap:2px;}
.ssr-stat-n{font-family:'Syne',sans-serif;font-weight:800;font-size:1.3rem;color:#c8f135;}
.ssr-stat-l{font-size:.66rem;color:#5a5a5a;text-transform:uppercase;letter-spacing:.8px;}
.ssr-join{display:inline-flex;align-items:center;gap:8px;background:#c8f135;color:#000;border-radius:14px;padding:13px 22px;font-family:'Syne',sans-serif;font-weight:700;font-size:.95rem;}
.ssr-join:hover{filter:brightness(1.06);}
.ssr-sect{padding:20px 20px 0;}
.ssr-sect-ti{font-family:'Syne',sans-serif;font-weight:700;font-size:.72rem;text-transform:uppercase;letter-spacing:1.2px;color:#5a5a5a;margin-bottom:12px;display:flex;align-items:center;gap:6px;}
.ssr-lb{display:flex;flex-direction:column;gap:7px;margin-bottom:6px;}
.ssr-lb-row{display:flex;align-items:center;gap:10px;padding:11px 14px;background:#131313;border:1px solid #1c1c1c;border-radius:13px;}
.ssr-medal{font-size:1.1rem;width:24px;text-align:center;flex-shrink:0;}
.ssr-rank{font-family:'Syne',sans-serif;font-weight:800;font-size:.85rem;color:#5a5a5a;width:24px;text-align:center;flex-shrink:0;}
.ssr-av{width:36px;height:36px;border-radius:50%;background:#c8f135;color:#000;font-family:'Syne',sans-serif;font-weight:700;font-size:.72rem;display:flex;align-items:center;justify-content:center;flex-shrink:0;}
.ssr-u-inf{flex:1;min-width:0;}
.ssr-u-nm{font-size:.88rem;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.ssr-u-hd{font-size:.72rem;color:#8a8a8a;}
.ssr-streak{font-family:'Syne',sans-serif;font-weight:800;font-size:.85rem;color:#c8f135;flex-shrink:0;}
.ssr-sub-squads{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:6px;}
.ssr-sq-chip{background:#131313;border:1px solid #2c2c2c;border-radius:100px;padding:7px 14px;font-size:.82rem;font-weight:500;display:flex;align-items:center;gap:6px;}
.ssr-sq-cnt{font-size:.7rem;color:#5a5a5a;}
.ssr-promo{margin:28px 20px 0;background:linear-gradient(135deg,rgba(200,241,53,.08),rgba(200,241,53,.03));border:1px solid rgba(200,241,53,.15);border-radius:20px;padding:24px;}
.ssr-promo-ti{font-family:'Syne',sans-serif;font-weight:800;font-size:1.15rem;margin-bottom:6px;}
.ssr-promo-su{font-size:.82rem;color:#8a8a8a;margin-bottom:18px;line-height:1.6;}
.ssr-promo-feats{display:flex;flex-direction:column;gap:8px;margin-bottom:20px;}
.ssr-feat{display:flex;align-items:center;gap:10px;font-size:.82rem;color:#8a8a8a;}
.ssr-feat-dot{width:6px;height:6px;border-radius:50%;background:#c8f135;flex-shrink:0;}
.ssr-foot{padding:28px 20px;border-top:1px solid #1c1c1c;margin-top:28px;text-align:center;}
.ssr-foot-logo{font-family:'Syne',sans-serif;font-weight:800;font-size:1rem;margin-bottom:6px;}
.ssr-foot-sub{font-size:.72rem;color:#5a5a5a;line-height:1.7;}
.ssr-av-lg{width:80px;height:80px;border-radius:50%;background:#c8f135;color:#000;font-family:'Syne',sans-serif;font-weight:800;font-size:1.5rem;display:flex;align-items:center;justify-content:center;margin-bottom:14px;border:3px solid #080808;box-shadow:0 0 0 2px #c8f135;}
.ssr-av-lg img{width:100%;height:100%;object-fit:cover;border-radius:50%;}
.ssr-prof-name{font-family:'Syne',sans-serif;font-weight:800;font-size:1.5rem;letter-spacing:-.5px;margin-bottom:4px;}
.ssr-handle{font-size:.9rem;color:#c8f135;font-weight:600;margin-bottom:8px;}
.ssr-bio{font-size:.85rem;color:#8a8a8a;line-height:1.6;margin-bottom:18px;max-width:280px;}
.ssr-prof-stats{display:flex;gap:28px;margin-bottom:20px;}
.ssr-chips{display:flex;flex-wrap:wrap;gap:8px;}
.ssr-chip{background:#131313;border:1px solid rgba(200,241,53,.3);border-radius:100px;padding:6px 14px;font-size:.8rem;color:#c8f135;font-weight:500;}
.ssr-xp{display:flex;align-items:center;gap:8px;font-size:.78rem;color:#8a8a8a;margin-bottom:18px;}
.ssr-xp-badge{background:rgba(200,241,53,.1);border:1px solid rgba(200,241,53,.25);border-radius:8px;padding:3px 10px;font-size:.76rem;color:#c8f135;font-weight:600;}
@media(min-width:481px){.ssr-wrap{padding:0 0 80px;}.ssr-h1{font-size:2.4rem;}}
</style>
</head>
<body>${bodyContent}</body>
</html>`;

// ─── OG IMAGE (SVG served as PNG-equivalent) ──────────────────────────────────
const ogImageSvg = (line1, line2, sub) => `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630">
  <rect width="1200" height="630" fill="#080808"/>
  <rect width="1200" height="6" y="0" fill="#c8f135"/>
  <text x="60" y="100" font-family="Arial Black,sans-serif" font-weight="900" font-size="36" fill="#f2f2f2">CalCheckAI</text>
  <text x="60" y="320" font-family="Arial Black,sans-serif" font-weight="900" font-size="72" fill="#c8f135">${line1}</text>
  <text x="60" y="410" font-family="Arial Black,sans-serif" font-weight="900" font-size="60" fill="#f2f2f2">${line2}</text>
  <text x="60" y="490" font-family="Arial,sans-serif" font-size="32" fill="#8a8a8a">${sub}</text>
  <rect x="60" y="560" width="160" height="44" rx="22" fill="#c8f135"/>
  <text x="140" y="588" font-family="Arial Black,sans-serif" font-weight="900" font-size="18" fill="#000" text-anchor="middle">Join free</text>
</svg>`;

// ─── SQUAD SSR PAGE ───────────────────────────────────────────────────────────
async function handleSquadSSR(handle, env) {
  // handle = URL path e.g. "miami" or "florida/miami" or "usa/florida/miami"
  // We look up by name (last segment) for simplicity
  const parts = handle.split('/').filter(Boolean);
  const squadName = decodeURIComponent(parts[parts.length - 1]).replace(/-/g, ' ');

  const squad = await env.DB.prepare(
    "SELECT * FROM labels WHERE name_lower = ? AND visibility='public'"
  ).bind(squadName.toLowerCase()).first();

  if (!squad) {
    return new Response('Squad not found', {
      status: 404,
      headers: { ...CORS, 'Content-Type': 'text/html' }
    });
  }

  // Fetch leaderboard, sub-squads, breadcrumb
  const [leaderboard, subSquads] = await Promise.all([
    env.DB.prepare(`
      SELECT u.name, u.handle, u.picture,
             COALESCE(s.current_streak,0) as streak,
             COALESCE(x.level,1) as level,
             COALESCE(x.total_xp,0) as xp
      FROM users u
      JOIN user_labels ul ON u.id=ul.user_id
      LEFT JOIN streaks s ON u.id=s.user_id
      LEFT JOIN user_xp x ON u.id=x.user_id
      WHERE ul.label_id=?
      ORDER BY streak DESC, xp DESC
      LIMIT 10
    `).bind(squad.id).all(),
    env.DB.prepare(
      "SELECT * FROM labels WHERE parent_id=? AND visibility='public' ORDER BY member_count DESC LIMIT 12"
    ).bind(squad.id).all(),
  ]);

  // Build breadcrumb chain
  const breadcrumb = [];
  let current = squad;
  while (current?.parent_id) {
    const parent = await env.DB.prepare('SELECT * FROM labels WHERE id=?').bind(current.parent_id).first();
    if (!parent) break;
    breadcrumb.unshift(parent);
    current = parent;
  }

  const medals = ['🥇','🥈','🥉'];
  const initials = name => name?.split(' ').map(n=>n[0]).slice(0,2).join('').toUpperCase()||'?';
  const canonicalPath = `/squad/${parts.join('/')}`;
  const ogImg = `${SITE}/og/squad/${encodeURIComponent(squad.name.toLowerCase().replace(/\s+/g,'-'))}`;

  const title = `${squad.name} Squad — CalCheckAI Fitness Community`;
  const desc  = `${squad.member_count} members in the ${squad.name} squad on CalCheckAI. Track calories, join the leaderboard and connect with your local fitness community. Free.`;

  const jsonLd = JSON.stringify({
    "@context":"https://schema.org",
    "@type":"SocialMediaPosting",
    "name": squad.name + " Fitness Squad",
    "description": desc,
    "url": SITE + canonicalPath,
    "publisher": {"@type":"Organization","name":"CalCheckAI","url":SITE},
    "interactionStatistic": {
      "@type":"InteractionCounter",
      "interactionType":"https://schema.org/FollowAction",
      "userInteractionCount": squad.member_count
    }
  });

  const lbHtml = leaderboard.results.map((u,i) => `
    <div class="ssr-lb-row">
      ${i<3?`<span class="ssr-medal">${medals[i]}</span>`:`<span class="ssr-rank">${i+1}</span>`}
      <div class="ssr-av">${initials(u.name)}</div>
      <div class="ssr-u-inf">
        <div class="ssr-u-nm">${u.name}</div>
        <div class="ssr-u-hd">@${u.handle||'—'} · Lv.${u.level}</div>
      </div>
      <div class="ssr-streak">🔥 ${u.streak}d</div>
    </div>`).join('');

  const subHtml = subSquads.results.map(s => `
    <div class="ssr-sq-chip">
      <span>${s.name}</span>
      <span class="ssr-sq-cnt">${s.member_count}</span>
    </div>`).join('');

  const bcHtml = [...breadcrumb, squad].map((b,i,arr) =>
    `<span class="ssr-bc-item">${b.name}</span>${i<arr.length-1?'<span class="ssr-bc-sep">›</span>':''}`
  ).join('');

  const body = `
<div class="ssr-wrap">
  <nav class="ssr-nav">
    <span class="ssr-logo">CalCheckAI</span>
    <a href="${SITE}" class="ssr-cta">Join free →</a>
  </nav>
  <div class="ssr-hero">
    ${breadcrumb.length>0?`<div class="ssr-bc">${bcHtml}</div>`:''}
    <h1 class="ssr-h1">${squad.name}</h1>
    <div class="ssr-sub">${squad.type?.charAt(0).toUpperCase()+squad.type?.slice(1)||'Squad'} · ${squad.member_count.toLocaleString()} members on CalCheckAI</div>
    <div class="ssr-stats">
      <div class="ssr-stat"><div class="ssr-stat-n">${squad.member_count.toLocaleString()}</div><div class="ssr-stat-l">Members</div></div>
      ${subSquads.results.length>0?`<div class="ssr-stat"><div class="ssr-stat-n">${subSquads.results.length}</div><div class="ssr-stat-l">Sub-squads</div></div>`:''}
    </div>
    <a href="${SITE}/?squad=${squad.id}" class="ssr-join">Join the ${squad.name} squad →</a>
  </div>

  ${leaderboard.results.length>0?`
  <div class="ssr-sect">
    <div class="ssr-sect-ti">🏆 Streak Leaderboard</div>
    <div class="ssr-lb">${lbHtml}</div>
  </div>`:''}

  ${subSquads.results.length>0?`
  <div class="ssr-sect" style="margin-top:20px;">
    <div class="ssr-sect-ti">📍 Sub-squads</div>
    <div class="ssr-sub-squads">${subHtml}</div>
  </div>`:''}

  <div class="ssr-promo">
    <div class="ssr-promo-ti">Join ${squad.name} on CalCheckAI</div>
    <div class="ssr-promo-su">Track your calories, compete on the leaderboard and connect with people in your community. Free — no subscription.</div>
    <div class="ssr-promo-feats">
      <div class="ssr-feat"><span class="ssr-feat-dot"></span>AI food scanner — snap any meal, get instant calories</div>
      <div class="ssr-feat"><span class="ssr-feat-dot"></span>Barcode and nutrition label scanning</div>
      <div class="ssr-feat"><span class="ssr-feat-dot"></span>Daily streaks, XP levels and badges</div>
      <div class="ssr-feat"><span class="ssr-feat-dot"></span>Squad leaderboards — compete with your community</div>
    </div>
    <a href="${SITE}" class="ssr-join" style="display:inline-flex;">Create your free account →</a>
  </div>

  <footer class="ssr-foot">
    <div class="ssr-foot-logo">CalCheckAI</div>
    <div class="ssr-foot-sub">AI Calorie Scanner & Fitness Community<br/>
      <a href="${SITE}/privacy" style="color:#5a5a5a;">Privacy</a> ·
      <a href="${SITE}/terms" style="color:#5a5a5a;">Terms</a> ·
      <a href="${SITE}" style="color:#c8f135;">calcheckai.com</a>
    </div>
  </footer>
</div>`;

  return new Response(htmlShell(title, desc, ogImg, canonicalPath, body, jsonLd), {
    headers: { ...CORS, 'Content-Type': 'text/html;charset=UTF-8', 'Cache-Control': 'public,max-age=300,stale-while-revalidate=600' }
  });
}

// ─── PROFILE SSR PAGE ─────────────────────────────────────────────────────────
async function handleProfileSSR(handle, env) {
  const h = handle.toLowerCase().trim();
  const user = await env.DB.prepare('SELECT * FROM users WHERE handle=?').bind(h).first();
  if (!user) return new Response('User not found', { status:404, headers:{...CORS,'Content-Type':'text/html'} });

  const [squads, streak, xp] = await Promise.all([
    env.DB.prepare(`SELECT l.name,l.type FROM labels l JOIN user_labels ul ON l.id=ul.label_id WHERE ul.user_id=? AND l.visibility='public' LIMIT 12`).bind(user.id).all(),
    env.DB.prepare('SELECT * FROM streaks WHERE user_id=?').bind(user.id).first(),
    env.DB.prepare('SELECT * FROM user_xp WHERE user_id=?').bind(user.id).first(),
  ]);

  const LEVEL_TITLES=['','Newcomer','Tracker','Consistent','Dedicated','Committed','Elite','Champion','Legend'];
  const level = xp?.level||1;
  const initials = user.name?.split(' ').map(n=>n[0]).slice(0,2).join('').toUpperCase()||'?';
  const canonicalPath = `/u/${h}`;
  const ogImg = `${SITE}/og/u/${h}`;
  const title = `${user.name} (@${h}) — CalCheckAI`;
  const desc  = user.bio
    ? `${user.bio.slice(0,140)} — Follow @${h} on CalCheckAI.`
    : `Follow @${h} on CalCheckAI — AI Calorie Scanner & Fitness Community.`;

  const jsonLd = JSON.stringify({
    "@context":"https://schema.org",
    "@type":"Person",
    "name": user.name,
    "identifier": `@${h}`,
    "description": user.bio||'',
    "url": SITE + canonicalPath,
    "memberOf": squads.results.map(s=>({ "@type":"Organization","name":s.name }))
  });

  const squadsHtml = squads.results.map(s=>`<span class="ssr-chip">${s.name}</span>`).join('');

  const body = `
<div class="ssr-wrap">
  <nav class="ssr-nav">
    <span class="ssr-logo">CalCheckAI</span>
    <a href="${SITE}" class="ssr-cta">Join free →</a>
  </nav>
  <div class="ssr-hero" style="display:flex;flex-direction:column;align-items:center;text-align:center;padding:28px 20px;">
    ${user.picture
      ? `<div class="ssr-av-lg"><img src="${user.picture}" alt="${user.name}" loading="lazy"/></div>`
      : `<div class="ssr-av-lg">${initials}</div>`
    }
    <div class="ssr-prof-name">${user.name}</div>
    <div class="ssr-handle">@${h}</div>
    ${user.bio?`<div class="ssr-bio">${user.bio}</div>`:''}
    ${streak?.current_streak>0||xp?.total_xp>0?`
    <div class="ssr-xp">
      ${streak?.current_streak>0?`<span>🔥 ${streak.current_streak} day streak</span>`:''}
      ${xp?.total_xp>0?`<span class="ssr-xp-badge">Lv.${level} ${LEVEL_TITLES[level]||''}</span>`:''}
      ${xp?.total_xp>0?`<span>${xp.total_xp.toLocaleString()} XP</span>`:''}
    </div>`:''}
    <div class="ssr-prof-stats">
      <div class="ssr-stat"><div class="ssr-stat-n">${squads.results.length}</div><div class="ssr-stat-l">Squads</div></div>
      <div class="ssr-stat"><div class="ssr-stat-n">${user.follower_count||0}</div><div class="ssr-stat-l">Followers</div></div>
      <div class="ssr-stat"><div class="ssr-stat-n">${user.following_count||0}</div><div class="ssr-stat-l">Following</div></div>
    </div>
    <a href="${SITE}/u/${h}" class="ssr-join">Follow @${h} on CalCheckAI →</a>
  </div>

  ${squads.results.length>0?`
  <div class="ssr-sect">
    <div class="ssr-sect-ti">🏘️ Squads</div>
    <div class="ssr-chips">${squadsHtml}</div>
  </div>`:''}

  <div class="ssr-promo" style="margin-top:28px;">
    <div class="ssr-promo-ti">Join CalCheckAI free</div>
    <div class="ssr-promo-su">Track your calories with AI, join squads, follow friends and compete on leaderboards. No subscription required.</div>
    <a href="${SITE}" class="ssr-join" style="display:inline-flex;">Create your free account →</a>
  </div>

  <footer class="ssr-foot">
    <div class="ssr-foot-logo">CalCheckAI</div>
    <div class="ssr-foot-sub">AI Calorie Scanner & Fitness Community<br/>
      <a href="${SITE}/privacy" style="color:#5a5a5a;">Privacy</a> ·
      <a href="${SITE}/terms" style="color:#5a5a5a;">Terms</a> ·
      <a href="${SITE}" style="color:#c8f135;">calcheckai.com</a>
    </div>
  </footer>
</div>`;

  return new Response(htmlShell(title, desc, ogImg, canonicalPath, body, jsonLd), {
    headers: { ...CORS, 'Content-Type': 'text/html;charset=UTF-8', 'Cache-Control': 'public,max-age=300,stale-while-revalidate=600' }
  });
}

// ─── DYNAMIC OG IMAGE ─────────────────────────────────────────────────────────
async function handleOgImage(path, env) {
  // /og/squad/miami → squad OG image
  // /og/u/alex.rivera → profile OG image
  const parts = path.split('/').filter(Boolean);
  let line1='CalCheckAI', line2='Fitness Community', sub='calcheckai.com';

  if (parts[0]==='squad' && parts[1]) {
    const name = decodeURIComponent(parts[1]).replace(/-/g,' ');
    const sq = await env.DB.prepare("SELECT name,member_count FROM labels WHERE name_lower=?").bind(name).first();
    if (sq) { line1=sq.name; line2='Squad'; sub=`${sq.member_count.toLocaleString()} members · calcheckai.com`; }
  } else if (parts[0]==='u' && parts[1]) {
    const u = await env.DB.prepare('SELECT name,handle FROM users WHERE handle=?').bind(parts[1]).first();
    if (u) { line1=u.name; line2=`@${u.handle}`; sub='CalCheckAI Fitness Community'; }
  }

  return new Response(ogImageSvg(line1, line2, sub), {
    headers: { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public,max-age=86400', ...CORS }
  });
}

// ─── DYNAMIC SITEMAP ──────────────────────────────────────────────────────────
async function handleSitemap(env) {
  const squads = await env.DB.prepare(
    "SELECT name_lower,member_count FROM labels WHERE visibility='public' ORDER BY member_count DESC LIMIT 500"
  ).all();

  const urls = [
    `<url><loc>${SITE}/</loc><changefreq>daily</changefreq><priority>1.0</priority></url>`,
    ...squads.results.map(s =>
      `<url><loc>${SITE}/squad/${encodeURIComponent(s.name_lower.replace(/\s+/g,'-'))}</loc><changefreq>daily</changefreq><priority>0.8</priority></url>`
    )
  ].join('\n');

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>`;

  return new Response(xml, {
    headers: { 'Content-Type': 'application/xml', 'Cache-Control': 'public,max-age=3600', ...CORS }
  });
}

// ─── GAMIFICATION CONSTANTS ───────────────────────────────────────────────────

const XP_VALUES = {
  log_meal:       10,
  hit_goal:       25,
  scan_barcode:    5,
  scan_label:      5,
  streak_7:       50,
  streak_30:      200,
  streak_100:     500,
  join_squad:     20,
  follow_user:    10,
  referral:       200,
  first_scan:     15,
};

const LEVELS = [
  { level:1, xp:0,    title:"Newcomer"   },
  { level:2, xp:100,  title:"Tracker"    },
  { level:3, xp:300,  title:"Consistent" },
  { level:4, xp:600,  title:"Dedicated"  },
  { level:5, xp:1000, title:"Committed"  },
  { level:6, xp:1750, title:"Elite"      },
  { level:7, xp:2750, title:"Champion"   },
  { level:8, xp:4000, title:"Legend"     },
];

const BADGES = [
  { id:"first_meal",   emoji:"🌱", name:"First Bite",        desc:"Logged your first meal"             },
  { id:"streak_7",     emoji:"🔥", name:"On Fire",           desc:"Achieved a 7-day streak"            },
  { id:"streak_30",    emoji:"💪", name:"Consistent",        desc:"Achieved a 30-day streak"           },
  { id:"streak_100",   emoji:"🎖️", name:"Century",           desc:"Achieved a 100-day streak"          },
  { id:"on_target_5",  emoji:"🎯", name:"On Target",         desc:"Hit your goal 5 days in a row"      },
  { id:"scans_10",     emoji:"📸", name:"Shutterbug",        desc:"Scanned 10 meals with the camera"   },
  { id:"label_first",  emoji:"🔖", name:"Label Reader",      desc:"Used nutrition label scanner"       },
  { id:"barcodes_5",   emoji:"🛒", name:"Barcode Pro",       desc:"Scanned 5 barcodes"                 },
  { id:"first_follow", emoji:"🤝", name:"Social",            desc:"Followed your first person"         },
  { id:"first_squad",  emoji:"🏘️", name:"Community",         desc:"Joined your first squad"            },
  { id:"squads_5",     emoji:"🌍", name:"Squad Builder",     desc:"Joined 5 squads"                    },
  { id:"favs_3",       emoji:"⭐", name:"Favourites",        desc:"Saved 3 meals to favourites"        },
  { id:"squad_top",    emoji:"🏆", name:"Weekly Champion",   desc:"Top streak in a squad for a week"   },
];

function getLevel(totalXp) {
  let current = LEVELS[0];
  for (const l of LEVELS) { if (totalXp >= l.xp) current = l; }
  const next = LEVELS.find(l => l.xp > totalXp) || null;
  return { ...current, nextXp: next?.xp || null, nextTitle: next?.title || null };
}

function todayDate() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

// ─── AWARD XP ─────────────────────────────────────────────────────────────────
async function awardXp(userId, action, env) {
  const amount = XP_VALUES[action];
  if (!amount) return null;

  // Upsert user_xp
  await env.DB.prepare(`
    INSERT INTO user_xp (user_id, total_xp, level)
    VALUES (?, ?, 1)
    ON CONFLICT(user_id) DO UPDATE SET
      total_xp = total_xp + ?,
      level    = level,
      updated_at = datetime('now')
  `).bind(userId, amount, amount).run();

  const row = await env.DB.prepare('SELECT total_xp FROM user_xp WHERE user_id = ?').bind(userId).first();
  const totalXp = row?.total_xp || 0;
  const lvl = getLevel(totalXp);

  // Update level
  await env.DB.prepare('UPDATE user_xp SET level = ? WHERE user_id = ?').bind(lvl.level, userId).run();

  return { xpEarned: amount, totalXp, ...lvl };
}

// ─── CHECK AND AWARD BADGES ───────────────────────────────────────────────────
async function checkBadges(userId, context, env) {
  const earned = await env.DB.prepare('SELECT badge_id FROM user_badges WHERE user_id = ?').bind(userId).all();
  const earnedIds = new Set(earned.results.map(r => r.badge_id));
  const newBadges = [];

  const maybeBadge = async (id) => {
    if (earnedIds.has(id)) return;
    await env.DB.prepare('INSERT OR IGNORE INTO user_badges (user_id, badge_id) VALUES (?,?)').bind(userId, id).run();
    const badge = BADGES.find(b => b.id === id);
    if (badge) newBadges.push(badge);
    // Award XP for earning badge
    if (['streak_7','streak_30','streak_100'].includes(id)) {
      await awardXp(userId, id, env);
    }
  };

  if (context.mealCount === 1)               await maybeBadge('first_meal');
  if (context.streak >= 7)                   await maybeBadge('streak_7');
  if (context.streak >= 30)                  await maybeBadge('streak_30');
  if (context.streak >= 100)                 await maybeBadge('streak_100');
  if (context.consecutiveOnTarget >= 5)      await maybeBadge('on_target_5');
  if (context.foodScanCount >= 10)           await maybeBadge('scans_10');
  if (context.labelScanDone)                 await maybeBadge('label_first');
  if (context.barcodeScanCount >= 5)         await maybeBadge('barcodes_5');
  if (context.followCount >= 1)              await maybeBadge('first_follow');
  if (context.squadCount >= 1)               await maybeBadge('first_squad');
  if (context.squadCount >= 5)               await maybeBadge('squads_5');
  if (context.favCount >= 3)                 await maybeBadge('favs_3');

  return newBadges;
}

// ─── UPDATE STREAK ─────────────────────────────────────────────────────────────
async function updateStreak(userId, env) {
  const today = todayDate();

  // Record today's log marker
  await env.DB.prepare('INSERT OR IGNORE INTO daily_logs (user_id, log_date) VALUES (?,?)').bind(userId, today).run();

  // Get or create streak record
  let streak = await env.DB.prepare('SELECT * FROM streaks WHERE user_id = ?').bind(userId).first();

  if (!streak) {
    await env.DB.prepare('INSERT INTO streaks (user_id, current_streak, longest_streak, last_log_date) VALUES (?,1,1,?)').bind(userId, today).run();
    return { current_streak: 1, longest_streak: 1, isNew: true };
  }

  const last = streak.last_log_date;
  if (last === today) return streak; // already logged today

  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const yStr = yesterday.toISOString().slice(0, 10);

  let newStreak = last === yStr ? streak.current_streak + 1 : 1; // consecutive or reset
  let longest   = Math.max(newStreak, streak.longest_streak);

  await env.DB.prepare(`
    UPDATE streaks
    SET current_streak = ?, longest_streak = ?, last_log_date = ?, updated_at = datetime('now')
    WHERE user_id = ?
  `).bind(newStreak, longest, today, userId).run();

  return { current_streak: newStreak, longest_streak: longest };
}

// ─── LOG MEAL (server-side marker) ────────────────────────────────────────────
async function handleLogMeal(request, env) {
  const userId = await requireAuth(request, env);
  const { calories, goal, scanType } = await request.json();

  // Update streak
  const streak = await updateStreak(userId, env);

  // Award base XP for logging
  const xpResult = await awardXp(userId, 'log_meal', env);

  // Award scan-type XP
  if (scanType === 'barcode') await awardXp(userId, 'scan_barcode', env);
  if (scanType === 'label')   await awardXp(userId, 'scan_label', env);

  // Award goal XP if hit
  const hitGoal = calories && goal && calories >= goal * 0.85 && calories <= goal * 1.15;
  if (hitGoal) await awardXp(userId, 'hit_goal', env);

  // Fetch counts for badge checking
  const [mealCount, foodScans, barcodeScans, follows, squads, favs] = await Promise.all([
    env.DB.prepare("SELECT COUNT(*) as n FROM daily_logs WHERE user_id=?").bind(userId).first(),
    env.DB.prepare("SELECT COUNT(*) as n FROM daily_logs WHERE user_id=?").bind(userId).first(), // proxy
    env.DB.prepare("SELECT COUNT(*) as n FROM daily_logs WHERE user_id=?").bind(userId).first(), // proxy
    env.DB.prepare("SELECT following_count as n FROM users WHERE id=?").bind(userId).first(),
    env.DB.prepare("SELECT label_count as n FROM users WHERE id=?").bind(userId).first(),
    env.DB.prepare("SELECT label_count as n FROM users WHERE id=?").bind(userId).first(), // proxy
  ]);

  const newBadges = await checkBadges(userId, {
    mealCount:  mealCount?.n || 0,
    streak:     streak.current_streak,
    followCount: follows?.n || 0,
    squadCount: squads?.n || 0,
    labelScanDone: scanType === 'label',
  }, env);

  return json({ streak, xp: xpResult, newBadges });
}

// ─── GET GAMIFICATION PROFILE ─────────────────────────────────────────────────
async function handleGetGamification(userId, env) {
  const [xp, streak, badges, weekScore] = await Promise.all([
    env.DB.prepare('SELECT * FROM user_xp WHERE user_id=?').bind(userId).first(),
    env.DB.prepare('SELECT * FROM streaks WHERE user_id=?').bind(userId).first(),
    env.DB.prepare('SELECT badge_id, earned_at FROM user_badges WHERE user_id=? ORDER BY earned_at DESC').bind(userId).all(),
    env.DB.prepare('SELECT * FROM weekly_scores WHERE user_id=? ORDER BY week_start DESC LIMIT 1').bind(userId).first(),
  ]);

  const totalXp = xp?.total_xp || 0;
  const lvl = getLevel(totalXp);

  const earnedIds = new Set(badges.results.map(r => r.badge_id));
  const allBadges = BADGES.map(b => ({
    ...b,
    earned: earnedIds.has(b.id),
    earned_at: badges.results.find(r => r.badge_id === b.id)?.earned_at || null,
  }));

  return json({
    xp: { total: totalXp, ...lvl },
    streak: streak || { current_streak: 0, longest_streak: 0 },
    badges: allBadges,
    weeklyScore: weekScore || null,
  });
}

// ─── SQUAD LEADERBOARD ────────────────────────────────────────────────────────
async function handleSquadLeaderboard(labelId, currentUserId, env) {
  const rows = await env.DB.prepare(`
    SELECT u.id, u.name, u.picture, u.handle,
           COALESCE(s.current_streak, 0) as current_streak,
           COALESCE(x.total_xp, 0) as total_xp,
           COALESCE(x.level, 1) as level
    FROM users u
    JOIN user_labels ul ON u.id = ul.user_id
    LEFT JOIN streaks s ON u.id = s.user_id
    LEFT JOIN user_xp x ON u.id = x.user_id
    WHERE ul.label_id = ?
    ORDER BY current_streak DESC, total_xp DESC
    LIMIT 50
  `).bind(labelId).all();

  const board = rows.results.map((r, i) => ({
    ...r,
    rank: i + 1,
    medal: i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : null,
    isMe: r.id === currentUserId,
  }));

  return json(board);
}

// ─── WEEKLY SCORE CALCULATOR (called by cron) ─────────────────────────────────
async function calculateWeeklyScores(env) {
  // Get last Monday as week_start
  const now = new Date();
  const day = now.getDay();
  const diff = day === 0 ? 6 : day - 1;
  const monday = new Date(now);
  monday.setDate(now.getDate() - diff);
  const weekStart = monday.toISOString().slice(0, 10);

  const users = await env.DB.prepare('SELECT id FROM users').all();

  for (const { id } of users.results) {
    // Count days logged this week
    const daysLogged = await env.DB.prepare(`
      SELECT COUNT(*) as n FROM daily_logs
      WHERE user_id=? AND log_date >= ?
    `).bind(id, weekStart).first();

    const streak = await env.DB.prepare('SELECT current_streak FROM streaks WHERE user_id=?').bind(id).first();
    const streakDays = Math.min(streak?.current_streak || 0, 7);
    const logged = Math.min(daysLogged?.n || 0, 7);

    // Score formula: days logged (40%) + streak (20%) + on-target proxy (40%)
    // On-target: approximate from logged days (full calculation needs localStorage data)
    const score = Math.round((logged / 7) * 40 + (streakDays / 7) * 20 + (logged / 7) * 40);

    await env.DB.prepare(`
      INSERT INTO weekly_scores (user_id, week_start, score, days_logged, streak_days)
      VALUES (?,?,?,?,?)
      ON CONFLICT(user_id, week_start) DO UPDATE SET
        score=excluded.score, days_logged=excluded.days_logged, streak_days=excluded.streak_days
    `).bind(id, weekStart, score, logged, streakDays).run();
  }

  // Award Weekly Champion badges to squad top-streakers
  const squads = await env.DB.prepare("SELECT id FROM labels WHERE visibility='public'").all();
  for (const { id } of squads.results) {
    const top = await env.DB.prepare(`
      SELECT u.id FROM users u
      JOIN user_labels ul ON u.id=ul.user_id
      LEFT JOIN streaks s ON u.id=s.user_id
      WHERE ul.label_id=?
      ORDER BY COALESCE(s.current_streak,0) DESC LIMIT 1
    `).bind(id).first();
    if (top) {
      await env.DB.prepare('INSERT OR IGNORE INTO user_badges (user_id,badge_id) VALUES (?,?)').bind(top.id, 'squad_top').run();
    }
  }

  console.log('Weekly scores calculated for', users.results.length, 'users');
}




// ─── CUSTOM FOODS ─────────────────────────────────────────────────────────────

async function handleGetCustomFoods(request, env) {
  const userId = await requireAuth(request, env);
  const foods = await env.DB.prepare(
    'SELECT * FROM custom_foods WHERE user_id=? ORDER BY created_at DESC'
  ).bind(userId).all();
  return json(foods.results);
}

async function handleAddCustomFood(request, env) {
  const userId = await requireAuth(request, env);
  const { name, emoji, calories, protein, carbs, fat, fiber, sodium, sugar } = await request.json();
  if (!name?.trim() || !calories) return err('Name and calories required');
  const id = makeId('cf');
  await env.DB.prepare(
    'INSERT INTO custom_foods (id,user_id,name,emoji,calories,protein,carbs,fat,fiber,sodium,sugar) VALUES (?,?,?,?,?,?,?,?,?,?,?)'
  ).bind(id, userId, name.trim(), emoji||'🍽️', Math.round(calories), protein||0, carbs||0, fat||0, fiber||0, sodium||0, sugar||0).run();
  return json({ id, name: name.trim(), emoji: emoji||'🍽️', calories: Math.round(calories), protein: protein||0, carbs: carbs||0, fat: fat||0 }, 201);
}

async function handleDeleteCustomFood(foodId, request, env) {
  const userId = await requireAuth(request, env);
  await env.DB.prepare('DELETE FROM custom_foods WHERE id=? AND user_id=?').bind(foodId, userId).run();
  return json({ success: true });
}

// ─── CUSTOM RECIPES ───────────────────────────────────────────────────────────

async function handleGetRecipes(request, env) {
  const userId = await requireAuth(request, env);
  const recipes = await env.DB.prepare(
    'SELECT * FROM custom_recipes WHERE user_id=? ORDER BY created_at DESC'
  ).bind(userId).all();
  return json(recipes.results.map(r => ({
    ...r,
    ingredients: JSON.parse(r.ingredients || '[]'),
    steps: JSON.parse(r.steps || '[]'),
  })));
}

async function handleAddRecipe(request, env) {
  const userId = await requireAuth(request, env);
  const { name, emoji, servings, calories, protein, carbs, fat, fiber, sodium, sugar, ingredients, steps } = await request.json();
  if (!name?.trim() || !calories) return err('Name and calories required');
  const id = makeId('cr');
  await env.DB.prepare(
    'INSERT INTO custom_recipes (id,user_id,name,emoji,servings,calories,protein,carbs,fat,fiber,sodium,sugar,ingredients,steps) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
  ).bind(id, userId, name.trim(), emoji||'🥘', servings||1, Math.round(calories), protein||0, carbs||0, fat||0, fiber||0, sodium||0, sugar||0,
    JSON.stringify(ingredients||[]), JSON.stringify(steps||[])).run();
  return json({ id, success: true }, 201);
}

async function handleDeleteRecipe(recipeId, request, env) {
  const userId = await requireAuth(request, env);
  await env.DB.prepare('DELETE FROM custom_recipes WHERE id=? AND user_id=?').bind(recipeId, userId).run();
  return json({ success: true });
}

// ─── AI MEAL PLANNING ─────────────────────────────────────────────────────────

const DIET_LABELS = {
  no_restriction: 'no dietary restrictions',
  high_protein: 'high protein focus (min 150g protein/day)',
  vegetarian: 'vegetarian (no meat or fish)',
  vegan: 'vegan (no animal products)',
  low_carb: 'low carbohydrate (under 100g carbs/day)',
};

async function handleGenerateMealPlan(request, env) {
  const userId = await requireAuth(request, env);
  const { preference = 'no_restriction', targets } = await request.json();
  if (!targets?.calories) return err('Targets required');

  // Serve cached plan from last 24 hours for same preference
  const cached = await env.DB.prepare(
    "SELECT plan_json FROM meal_plans WHERE user_id=? AND preference=? AND created_at >= datetime('now','-1 day') ORDER BY created_at DESC LIMIT 1"
  ).bind(userId, preference).first();
  if (cached) {
    try {
      const cp = JSON.parse(cached.plan_json);
      if (cp && Array.isArray(cp.days) && cp.days.length >= 1) return json(cp);
    } catch {}
    // Broken cached plan — clear it so a fresh one can generate
    await env.DB.prepare('DELETE FROM meal_plans WHERE user_id=? AND preference=?').bind(userId, preference).run();
  }

  const dietLabel = DIET_LABELS[preference] || 'no dietary restrictions';

  // Shared JSON extractor/validator (expects {days:[...]})
  const extract = (r) => {
    let raw = '';
    if (typeof r === 'string') raw = r;
    else if (r && typeof r.response === 'string') raw = r.response;
    else if (r && r.response != null) raw = JSON.stringify(r.response);
    else raw = JSON.stringify(r);
    raw = String(raw).replace(/```json|```/g, '').trim();
    const mm = raw.match(/\{[\s\S]*\}/);
    if (!mm) throw new Error('no JSON in model output');
    const p = JSON.parse(mm[0]);
    if (!p || !Array.isArray(p.days) || p.days.length < 1 || !Array.isArray(p.days[0].meals)) throw new Error('invalid plan shape');
    return p;
  };

  // Generate the week in small batches so each model response stays small and valid.
  // Asking for all 21 meals at once routinely overflows the token limit and breaks JSON.
  const BATCHES = [['Monday','Tuesday'],['Wednesday','Thursday'],['Friday','Saturday'],['Sunday']];

  const genBatch = async (dayNames) => {
    const bp = `You are a professional nutritionist. Create meal plan days for exactly these days: ${dayNames.join(', ')}. Daily targets: ${targets.calories} kcal, ${targets.protein}g protein, ${targets.carbs}g carbs, ${targets.fat}g fat. Diet: ${dietLabel}. Each day has 3 meals (Breakfast, Lunch, Dinner). Keep meal names short. "ingredients" is max 4 very short strings. Do NOT include cooking steps. Return ONLY valid compact JSON, no markdown, no explanation:
{"days":[{"day":"${dayNames[0]}","meals":[{"type":"Breakfast","name":"Oatmeal & berries","emoji":"🥣","calories":320,"protein":12,"carbs":58,"fat":6,"ingredients":["oats","berries","milk","honey"]}]}]}`;
    const run = () => env.AI.run('@cf/meta/llama-3.2-11b-vision-instruct', {
      messages: [
        { role: 'system', content: 'You are a nutritionist. Return ONLY valid compact JSON. No explanation. No markdown.' },
        { role: 'user', content: bp },
      ],
      max_tokens: 2048,
      temperature: 0.2,
    });
    try { return extract(await run()).days; }
    catch { return extract(await run()).days; } // one retry per batch
  };

  try {
    let allDays = [];
    for (const b of BATCHES) {
      const days = await genBatch(b);
      allDays = allDays.concat(days);
    }
    if (allDays.length < 1) throw new Error('empty plan');
    const plan = { days: allDays };

    // Cache the plan
    await env.DB.prepare(
      'INSERT INTO meal_plans (id,user_id,preference,plan_json) VALUES (?,?,?,?)'
    ).bind(makeId('mp'), userId, preference, JSON.stringify(plan)).run();

    return json(plan);
  } catch (e) {
    return json({ error: 'Could not generate plan. Please try again.', retry: true });
  }
}
async function handleGetSavedPlan(request, env) {
  const userId = await requireAuth(request, env);
  const pref = new URL(request.url).searchParams.get('preference') || 'no_restriction';
  const plan = await env.DB.prepare(
    'SELECT plan_json, preference, created_at FROM meal_plans WHERE user_id=? ORDER BY created_at DESC LIMIT 1'
  ).bind(userId).first();
  if (!plan) return json({ plan: null });
  return json({ plan: JSON.parse(plan.plan_json), preference: plan.preference, created_at: plan.created_at });
}


// ─── COMPLIANCE / LEGAL RECORDS ──────────────────────────────────────────────

// Hash email on server side for lookup (email never stored in logs)
async function handleComplianceLookup(request, env) {
  const admin = await requireAdmin(request, env, 'admin_manage');
  const { email } = await request.json();
  if (!email?.trim()) return err('Email required');

  // Hash the provided email
  const hash = await sha256(email.trim().toLowerCase());

  // Search audit table
  const records = await env.DB.prepare(
    'SELECT * FROM account_deletions WHERE email_hash=? ORDER BY deletion_requested_at DESC'
  ).bind(hash).all();

  // Log this search in admin audit trail
  await audit(admin.id, admin.email, 'compliance_lookup', 'account_deletion', hash.slice(0, 12) + '…', {
    search_performed_at: new Date().toISOString(),
    records_found: records.results.length,
  }, env);

  return json({
    email_searched: email.trim(),
    hash: hash.slice(0, 12) + '…[truncated for security]',
    records_found: records.results.length,
    records: records.results,
  });
}

// Get recent deletion records for admin overview
async function handleComplianceList(url, env) {
  const page = parseInt(url.searchParams.get('page') || '0');
  const rows = await env.DB.prepare(
    'SELECT id, email_hash, export_generated_at, deletion_requested_at, deletion_completed_at, reason, gdpr_compliant FROM account_deletions ORDER BY deletion_requested_at DESC LIMIT 30 OFFSET ?'
  ).bind(page * 30).all();
  const total = await env.DB.prepare('SELECT COUNT(*) as n FROM account_deletions').first();
  return json({ records: rows.results, total: total?.n || 0, page });
}

// ─── DATA EXPORT & ACCOUNT DELETION ──────────────────────────────────────────

// ── SHA-256 hash helper ───────────────────────────────────────────────────────
async function sha256(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text.toLowerCase().trim()));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
}

// ── Export all user data ──────────────────────────────────────────────────────
async function handleDataExport(request, env) {
  const userId = await requireAuth(request, env);

  const [user, meals, weightLogs, waterLogs, follows, followers,
    posts, squads, privacy, xp, badges, streak, messages] = await Promise.all([
    env.DB.prepare("SELECT id,name,email,handle,bio,picture,follower_count,following_count,created_at FROM users WHERE id=?").bind(userId).first(),
    env.DB.prepare("SELECT * FROM daily_logs WHERE user_id=? ORDER BY logged_at DESC").bind(userId).all(),
    env.DB.prepare("SELECT date,weight_kg FROM weight_logs WHERE user_id=? ORDER BY date DESC").bind(userId).all(),
    env.DB.prepare("SELECT intake_ml,unit_pref,logged_at FROM water_logs WHERE user_id=? ORDER BY logged_at DESC").bind(userId).all(),
    env.DB.prepare("SELECT u.name,u.handle FROM follows f JOIN users u ON u.id=f.following_id WHERE f.follower_id=?").bind(userId).all(),
    env.DB.prepare("SELECT u.name,u.handle FROM follows f JOIN users u ON u.id=f.follower_id WHERE f.following_id=?").bind(userId).all(),
    env.DB.prepare("SELECT id,text,post_type,created_at FROM posts WHERE user_id=? ORDER BY created_at DESC").bind(userId).all(),
    env.DB.prepare("SELECT l.name,l.type FROM user_labels ul JOIN labels l ON l.id=ul.label_id WHERE ul.user_id=?").bind(userId).all(),
    env.DB.prepare("SELECT show_following,show_last_seen FROM user_privacy WHERE user_id=?").bind(userId).first(),
    env.DB.prepare("SELECT total_xp,level FROM user_xp WHERE user_id=?").bind(userId).first(),
    env.DB.prepare("SELECT badge_id,earned_at FROM user_badges WHERE user_id=?").bind(userId).all(),
    env.DB.prepare("SELECT current_streak,longest_streak FROM streaks WHERE user_id=?").bind(userId).first(),
    env.DB.prepare("SELECT text,created_at,sender_id FROM messages WHERE conversation_id IN (SELECT id FROM conversations WHERE user_a=? OR user_b=?) ORDER BY created_at DESC LIMIT 500").bind(userId,userId).all(),
  ]);

  const exportData = {
    export_generated_at: new Date().toISOString(),
    export_note: "This file contains all personal data CalCheckAI holds about your account as of the export date.",
    gdpr_note: "Exported under GDPR Article 15 (Right of Access) and Article 20 (Right to Data Portability).",
    profile: user,
    stats: { xp: xp?.total_xp || 0, level: xp?.level || 1, streak: streak?.current_streak || 0, longest_streak: streak?.longest_streak || 0 },
    badges: badges?.results || [],
    privacy_settings: privacy || {},
    food_logs: meals?.results || [],
    weight_logs: weightLogs?.results || [],
    water_logs: waterLogs?.results || [],
    following: follows?.results || [],
    followers: followers?.results || [],
    posts: posts?.results || [],
    squads: squads?.results || [],
    messages: (messages?.results || []).map(m => ({ ...m, is_mine: m.sender_id === userId })),
  };

  // Record that export was generated (for audit trail ahead of any deletion)
  const emailHash = user?.email ? await sha256(user.email) : makeId("anon");
  await env.DB.prepare(`
    INSERT INTO account_deletions (id, email_hash, export_generated_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(id) DO NOTHING
  `).bind(makeId("del"), emailHash).run().catch(() => {});

  return new Response(JSON.stringify(exportData, null, 2), {
    headers: {
      "Content-Type": "application/json",
      "Content-Disposition": `attachment; filename="calcheckai-data-${new Date().toISOString().split("T")[0]}.json"`,
      "Access-Control-Allow-Origin": "*",
    },
  });
}

// ── Delete account ────────────────────────────────────────────────────────────
async function handleDeleteAccount(request, env) {
  const userId = await requireAuth(request, env);
  const { reason } = await request.json().catch(() => ({}));

  const user = await env.DB.prepare("SELECT id,email FROM users WHERE id=?").bind(userId).first();
  if (!user) return err("User not found", 404);

  const emailHash = user.email ? await sha256(user.email) : makeId("anon");
  const anonId = makeId("del");
  const now = new Date().toISOString();

  // Check if export was previously generated (look up by email hash)
  const prevExport = await env.DB.prepare(
    "SELECT export_generated_at FROM account_deletions WHERE email_hash=? ORDER BY export_generated_at DESC LIMIT 1"
  ).bind(emailHash).first();

  // ── Delete all user data ──────────────────────────────────────────────────
  // All child tables have ON DELETE CASCADE so deleting the user row is sufficient
  // for most data. Explicitly delete R2 avatar and session data first.
  try {
    // Delete avatar from R2 if exists
    const avatarKey = `avatars/${userId}`;
    await env.R2.delete(avatarKey).catch(() => {});
  } catch {}

  // Delete the user — cascades to: sessions, follows, user_labels, daily_logs,
  // streaks, user_xp, user_badges, weekly_scores, water_logs, posts, reactions,
  // profile_visits, user_privacy, conversations (and messages via cascade),
  // weight_logs, referrals
  await env.DB.prepare("DELETE FROM users WHERE id=?").bind(userId).run();

  // ── Write permanent audit record ──────────────────────────────────────────
  await env.DB.prepare(`
    INSERT INTO account_deletions
      (id, email_hash, export_generated_at, deletion_requested_at, deletion_completed_at, reason, gdpr_compliant)
    VALUES (?, ?, ?, ?, ?, ?, 1)
  `).bind(
    anonId,
    emailHash,
    prevExport?.export_generated_at || null,
    now,
    now,
    reason || "user_request"
  ).run();

  return json({ success: true, message: "Your account and all associated data has been permanently deleted." });
}


// ─── REFERRAL LANDING ─────────────────────────────────────────────────────────

// Returns referrer's public info from a ref code — no auth needed
async function handleRefLookup(request, env) {
  const code = new URL(request.url).searchParams.get('code');
  if (!code) return err('Code required');
  const user = await env.DB.prepare(
    'SELECT name, handle, picture, follower_count FROM users WHERE ref_code=?'
  ).bind(code).first();
  if (!user) return err('Invalid referral code', 404);
  return json({ name: user.name, handle: user.handle, picture: user.picture });
}

// ─── REFERRAL SYSTEM ─────────────────────────────────────────────────────────

const REFERRAL_XP = 500;
const REFERRAL_BADGE = "ambassador";
const REFERRAL_VELOCITY_LIMIT = 5; // max successful referrals per 30 days before review
const STEALTH_DAYS = 7;

// ── Generate a short ref code from user ULID ──────────────────────────────────
function refCode(userId) {
  return userId.replace("usr_", "").slice(0, 8).toLowerCase();
}

// ── Device fingerprint check ──────────────────────────────────────────────────
async function fingerprintMatch(fpA, fpB) {
  if (!fpA || !fpB) return false;
  return fpA === fpB;
}

// ── Get or create referral code for a user ────────────────────────────────────
async function handleGetRefCode(request, env) {
  const userId = await requireAuth(request, env);
  const user = await env.DB.prepare("SELECT id, ref_code FROM users WHERE id=?").bind(userId).first();
  if (!user) return err("User not found", 404);

  let code = user.ref_code;
  if (!code) {
    code = refCode(userId) + Math.random().toString(36).slice(2, 5);
    await env.DB.prepare("UPDATE users SET ref_code=? WHERE id=?").bind(code, userId).run();
  }
  return json({ ref_code: code, url: `https://calcheckai.com?ref=${code}` });
}

// ── Record referral link click (called when a visitor arrives via ref link) ───
async function handleRefClick(request, env) {
  const { code } = await request.json();
  const ip = request.headers.get("CF-Connecting-IP") || "";
  const fp = request.headers.get("X-Device-FP") || "";

  const referrer = await env.DB.prepare(
    "SELECT id FROM users WHERE ref_code=?"
  ).bind(code).first();
  if (!referrer) return err("Invalid referral code", 404);

  // Check if a referral record already exists for this code that hasn't been used
  let ref = await env.DB.prepare(
    "SELECT * FROM referrals WHERE ref_code=? AND referred_id IS NULL ORDER BY created_at DESC LIMIT 1"
  ).bind(code).first();

  if (!ref) {
    const id = makeId("ref");
    await env.DB.prepare(`
      INSERT INTO referrals (id, referrer_id, ref_code, clicked_at, ip_ref, device_fp_ref)
      VALUES (?, ?, ?, datetime('now'), ?, ?)
    `).bind(id, referrer.id, code, ip, fp).run();
    ref = { id };
  }

  return json({ success: true, ref_id: ref.id });
}

// ── Complete referral signup ──────────────────────────────────────────────────
async function handleRefSignup(request, env) {
  const newUserId = await requireAuth(request, env);
  const { ref_code } = await request.json();
  const ip = request.headers.get("CF-Connecting-IP") || "";
  const fp = request.headers.get("X-Device-FP") || "";

  // Find pending referral
  const ref = await env.DB.prepare(`
    SELECT r.*, u.id as ref_user_id, u.device_fp_ref as rfp
    FROM referrals r
    JOIN users u ON u.id = r.referrer_id
    WHERE r.ref_code = ? AND r.referred_id IS NULL
    ORDER BY r.created_at DESC LIMIT 1
  `).bind(ref_code).first();

  if (!ref) return err("Invalid or expired referral", 404);

  // ── Anti-fraud Layer 1: Self-referral check ────────────────────────────────
  if (ref.referrer_id === newUserId) return err("Self-referral not allowed", 403);

  // ── Anti-fraud Layer 2: Device fingerprint check ──────────────────────────
  if (fp && ref.device_fp_ref && await fingerprintMatch(fp, ref.device_fp_ref)) {
    await env.DB.prepare(
      "UPDATE referrals SET is_flagged=1, referred_id=?, signed_up_at=datetime('now'), ip_new=?, device_fp_new=? WHERE id=?"
    ).bind(newUserId, ip, fp, ref.id).run();
    return json({ success: true, flagged: true });
  }

  // ── Anti-fraud Layer 3: Velocity check ────────────────────────────────────
  const recentWins = await env.DB.prepare(`
    SELECT COUNT(*) as n FROM referrals
    WHERE referrer_id=? AND reward_a_at IS NOT NULL
    AND reward_a_at >= datetime('now', '-30 days')
  `).bind(ref.referrer_id).first();

  const needsReview = (recentWins?.n || 0) >= REFERRAL_VELOCITY_LIMIT;

  // Link referral to new user
  await env.DB.prepare(`
    UPDATE referrals SET
      referred_id = ?,
      signed_up_at = datetime('now'),
      ip_new = ?,
      device_fp_new = ?,
      is_flagged = ?
    WHERE id = ?
  `).bind(newUserId, ip, fp, needsReview ? 1 : 0, ref.id).run();

  // Update new user's referred_by
  await env.DB.prepare("UPDATE users SET referred_by=? WHERE id=?").bind(ref.id, newUserId).run();

  return json({ success: true, flagged: needsReview, ref_id: ref.id });
}

// ── Trigger Reward A — when referred user logs first meal ─────────────────────
async function processReferralFirstMeal(userId, env) {
  // Find this user's referral record
  const ref = await env.DB.prepare(`
    SELECT r.* FROM referrals r
    JOIN users u ON u.referred_by = r.id
    WHERE u.id = ? AND r.reward_a_at IS NULL AND r.is_flagged = 0 AND r.referred_id IS NOT NULL
  `).bind(userId).first();

  if (!ref) return;

  const now = new Date().toISOString();

  // Issue Reward A to both users
  await Promise.all([
    // XP + badge for referrer
    env.DB.prepare("UPDATE users SET ambassador_badge=1 WHERE id=?").bind(ref.referrer_id).run(),
    env.DB.prepare(`UPDATE user_xp SET total_xp=total_xp+${REFERRAL_XP} WHERE user_id=?`).bind(ref.referrer_id).run(),
    // XP + badge for referred user
    env.DB.prepare("UPDATE users SET ambassador_badge=1 WHERE id=?").bind(userId).run(),
    env.DB.prepare(`UPDATE user_xp SET total_xp=total_xp+${REFERRAL_XP} WHERE user_id=?`).bind(userId).run(),
    // Mark reward A issued
    env.DB.prepare("UPDATE referrals SET reward_a_at=?, first_meal_at=? WHERE id=?").bind(now, now, ref.id).run(),
  ]);
}

// ── Track active day for 7-day milestone ──────────────────────────────────────
async function trackReferralActivity(userId, env) {
  const ref = await env.DB.prepare(`
    SELECT r.* FROM referrals r
    JOIN users u ON u.referred_by = r.id
    WHERE u.id = ? AND r.reward_b_at IS NULL AND r.reward_a_at IS NOT NULL AND r.is_flagged = 0
  `).bind(userId).first();

  if (!ref) return;

  const today = new Date().toISOString().split("T")[0];

  // Record today as active (upsert)
  try {
    await env.DB.prepare(`
      INSERT INTO referral_activity (id, referral_id, user_id, activity_date)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(referral_id, activity_date) DO NOTHING
    `).bind(makeId("ra"), ref.id, userId, today).run();
  } catch {}

  // Count distinct active days
  const count = await env.DB.prepare(
    "SELECT COUNT(*) as n FROM referral_activity WHERE referral_id=?"
  ).bind(ref.id).first();

  if ((count?.n || 0) >= 5) {
    // Issue Reward B — stealth access to referrer
    const stealthUntil = new Date();
    stealthUntil.setDate(stealthUntil.getDate() + STEALTH_DAYS);
    await env.DB.prepare("UPDATE users SET stealth_until=? WHERE id=?")
      .bind(stealthUntil.toISOString(), ref.referrer_id).run();
    await env.DB.prepare("UPDATE referrals SET reward_b_at=datetime('now'), days_active=? WHERE id=?")
      .bind(count.n, ref.id).run();
  } else {
    await env.DB.prepare("UPDATE referrals SET days_active=? WHERE id=?").bind(count.n, ref.id).run();
  }
}

// ── Get referral stats for profile ───────────────────────────────────────────
async function handleGetRefStats(request, env) {
  const userId = await requireAuth(request, env);
  const [codeRow, stats, user] = await Promise.all([
    env.DB.prepare("SELECT ref_code FROM users WHERE id=?").bind(userId).first(),
    env.DB.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN reward_a_at IS NOT NULL THEN 1 ELSE 0 END) as rewarded,
        SUM(CASE WHEN reward_b_at IS NOT NULL THEN 1 ELSE 0 END) as stealth_earned
      FROM referrals WHERE referrer_id=? AND is_flagged=0
    `).bind(userId).first(),
    env.DB.prepare("SELECT stealth_until, ambassador_badge FROM users WHERE id=?").bind(userId).first(),
  ]);

  const code = codeRow?.ref_code || "";
  return json({
    ref_code: code,
    ref_url: code ? `https://calcheckai.com?ref=${code}` : null,
    total_referrals: stats?.total || 0,
    active_referrals: stats?.rewarded || 0,
    stealth_referrals: stats?.stealth_earned || 0,
    stealth_until: user?.stealth_until || null,
    has_ambassador_badge: !!(user?.ambassador_badge),
  });
}

// ─── WEIGHT TRACKING ─────────────────────────────────────────────────────────

async function handleLogWeight(request, env) {
  const userId = await requireAuth(request, env);
  const { weight_kg, date } = await request.json();
  if (!weight_kg || weight_kg < 20 || weight_kg > 500) return err('Invalid weight');
  const d = date || new Date().toISOString().split('T')[0];
  const id = makeId('wt');
  await env.DB.prepare(`
    INSERT INTO weight_logs (id, user_id, weight_kg, date)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id, date) DO UPDATE SET weight_kg = ?
  `).bind(id, userId, Math.round(weight_kg * 100) / 100, d, Math.round(weight_kg * 100) / 100).run();
  return json({ success: true, date: d, weight_kg });
}

async function handleGetWeightLogs(request, env) {
  const userId = await requireAuth(request, env);
  const logs = await env.DB.prepare(
    'SELECT date, weight_kg FROM weight_logs WHERE user_id=? ORDER BY date DESC LIMIT 90'
  ).bind(userId).all();
  return json(logs.results);
}

async function handleDeleteWeightLog(date, request, env) {
  const userId = await requireAuth(request, env);
  await env.DB.prepare('DELETE FROM weight_logs WHERE user_id=? AND date=?').bind(userId, date).run();
  return json({ success: true });
}

// ─── PRIVATE MESSAGING ────────────────────────────────────────────────────────
// Friends only (mutual follows). Text only. 4-week auto-deletion.

// ── Ensure friends (mutual follows) ──────────────────────────────────────────
async function assertFriends(userA, userB, env) {
  const friends = await areFriends(userA, userB, env);
  if (!friends) throw Object.assign(new Error('You can only message friends (mutual follows)'), {status:403});
}

// ── Get or create conversation between two users ──────────────────────────────
async function getOrCreateConversation(userA, userB, env) {
  // Always store with lower ID first for consistent keying
  const [lo, hi] = [userA, userB].sort();
  let conv = await env.DB.prepare(
    'SELECT * FROM conversations WHERE user_a=? AND user_b=?'
  ).bind(lo, hi).first();
  if (!conv) {
    const id = makeId('conv');
    await env.DB.prepare(
      'INSERT INTO conversations (id,user_a,user_b) VALUES (?,?,?)'
    ).bind(id, lo, hi).run();
    conv = { id, user_a: lo, user_b: hi, last_message: null, unread_a: 0, unread_b: 0 };
  }
  return conv;
}

// ── Send a message ────────────────────────────────────────────────────────────
async function handleSendMessage(request, env) {
  const senderId = await requireAuth(request, env);
  const { recipient_id, text } = await request.json();
  if (!text?.trim()) return err('Message cannot be empty');
  if (text.trim().length > 1000) return err('Message too long (max 1000 characters)');
  if (!recipient_id) return err('Recipient required');
  if (recipient_id === senderId) return err('Cannot message yourself');

  // Friends only
  await assertFriends(senderId, recipient_id, env);

  const conv = await getOrCreateConversation(senderId, recipient_id, env);
  const msgId = makeId('msg');
  const now = new Date().toISOString();

  await env.DB.prepare(
    'INSERT INTO messages (id,conversation_id,sender_id,text,created_at) VALUES (?,?,?,?,?)'
  ).bind(msgId, conv.id, senderId, text.trim(), now).run();

  // Update conversation preview and unread count for recipient
  const recipientIsA = conv.user_a === recipient_id;
  await env.DB.prepare(`
    UPDATE conversations SET
      last_message    = ?,
      last_message_at = ?,
      ${recipientIsA ? 'unread_a = unread_a + 1' : 'unread_b = unread_b + 1'}
    WHERE id = ?
  `).bind(text.trim().slice(0, 60), now, conv.id).run();

  return json({
    id: msgId,
    conversation_id: conv.id,
    sender_id: senderId,
    text: text.trim(),
    created_at: now,
    is_read: 0,
  }, 201);
}

// ── Get conversations list ────────────────────────────────────────────────────
async function handleGetConversations(request, env) {
  const userId = await requireAuth(request, env);

  const rows = await env.DB.prepare(`
    SELECT c.*,
      CASE WHEN c.user_a = ? THEN c.user_b ELSE c.user_a END as other_id,
      CASE WHEN c.user_a = ? THEN c.unread_a ELSE c.unread_b END as my_unread
    FROM conversations c
    WHERE c.user_a = ? OR c.user_b = ?
    ORDER BY c.last_message_at DESC
    LIMIT 30
  `).bind(userId, userId, userId, userId).all();

  // Hydrate with other user's info
  const convs = await Promise.all(rows.results.map(async row => {
    const other = await env.DB.prepare(
      'SELECT id,name,handle,picture FROM users WHERE id=?'
    ).bind(row.other_id).first();
    return { ...row, other_user: other };
  }));

  return json(convs);
}

// ── Get total unread message count ────────────────────────────────────────────
async function handleGetUnreadCount(request, env) {
  const userId = await requireAuth(request, env);
  const row = await env.DB.prepare(`
    SELECT
      SUM(CASE WHEN user_a=? THEN unread_a ELSE 0 END) +
      SUM(CASE WHEN user_b=? THEN unread_b ELSE 0 END) as total
    FROM conversations
    WHERE user_a=? OR user_b=?
  `).bind(userId, userId, userId, userId).first();
  return json({ unread: row?.total || 0 });
}

// ── Get messages in a conversation ────────────────────────────────────────────
async function handleGetMessages(convId, request, env) {
  const userId = await requireAuth(request, env);
  const page   = parseInt(new URL(request.url).searchParams.get('page') || '0');

  // Verify user is part of this conversation
  const conv = await env.DB.prepare(
    'SELECT * FROM conversations WHERE id=? AND (user_a=? OR user_b=?)'
  ).bind(convId, userId, userId).first();
  if (!conv) return err('Conversation not found', 404);

  // Mark messages as read
  await env.DB.prepare(`
    UPDATE messages SET is_read=1
    WHERE conversation_id=? AND sender_id!=? AND is_read=0
  `).bind(convId, userId).run();

  // Reset unread count for this user
  const isA = conv.user_a === userId;
  await env.DB.prepare(
    `UPDATE conversations SET ${isA ? 'unread_a=0' : 'unread_b=0'} WHERE id=?`
  ).bind(convId).run();

  // Fetch messages — oldest first, paginated
  const messages = await env.DB.prepare(`
    SELECT m.*, u.name, u.handle, u.picture
    FROM messages m
    JOIN users u ON u.id = m.sender_id
    WHERE m.conversation_id = ?
    ORDER BY m.created_at DESC
    LIMIT 40 OFFSET ?
  `).bind(convId, page * 40).all();

  return json(messages.results.reverse()); // reverse for chronological display
}

// ── Delete a message (own only) ───────────────────────────────────────────────
async function handleDeleteMessage(msgId, request, env) {
  const userId = await requireAuth(request, env);
  const msg = await env.DB.prepare('SELECT * FROM messages WHERE id=?').bind(msgId).first();
  if (!msg) return err('Message not found', 404);
  if (msg.sender_id !== userId) return err("Cannot delete others' messages", 403);
  await env.DB.prepare('DELETE FROM messages WHERE id=?').bind(msgId).run();
  return json({ success: true });
}

// ── Cron: delete messages older than 4 weeks ──────────────────────────────────
async function deleteOldMessages(env) {
  const result = await env.DB.prepare(`
    DELETE FROM messages
    WHERE created_at < datetime('now', '-28 days')
  `).run();

  // Clean up empty conversations
  await env.DB.prepare(`
    DELETE FROM conversations
    WHERE id NOT IN (SELECT DISTINCT conversation_id FROM messages)
    AND created_at < datetime('now', '-28 days')
  `).run();

  console.log('CalCheckAI: old messages cleaned up (4-week policy)');
  return result;
}

// ─── PRIVACY & PROFILE VISIT NOTIFICATIONS ────────────────────────────────────

const VISIT_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour in milliseconds
const MAX_VISIT_NOTIFS  = 50;              // rolling limit per user

// ── Record a profile visit ────────────────────────────────────────────────────
async function recordProfileVisit(profileId, visitorId, env) {
  if (profileId === visitorId) return; // never notify own visits

  const now = new Date().toISOString();

  // Check 1-hour cooldown — same visitor+profile pair
  const recent = await env.DB.prepare(`
    SELECT visited_at FROM profile_visits
    WHERE profile_id=? AND visitor_id=? AND is_stealth=0
    ORDER BY visited_at DESC LIMIT 1
  `).bind(profileId, visitorId).first();

  if (recent) {
    const lastMs = new Date(recent.visited_at).getTime();
    if (Date.now() - lastMs < VISIT_COOLDOWN_MS) return; // within cooldown
  }

  // Upsert visit record
  await env.DB.prepare(`
    INSERT INTO profile_visits (id, profile_id, visitor_id, visited_at, is_read)
    VALUES (?, ?, ?, ?, 0)
    ON CONFLICT(profile_id, visitor_id) DO UPDATE SET
      visited_at = ?,
      is_read    = 0
  `).bind(makeId('pv'), profileId, visitorId, now, now).run();

  // Enforce rolling 50-visit limit — delete oldest if over limit
  const count = await env.DB.prepare(
    'SELECT COUNT(*) as n FROM profile_visits WHERE profile_id=? AND is_stealth=0'
  ).bind(profileId).first();

  if ((count?.n || 0) > MAX_VISIT_NOTIFS) {
    // Delete oldest beyond limit
    await env.DB.prepare(`
      DELETE FROM profile_visits WHERE id IN (
        SELECT id FROM profile_visits
        WHERE profile_id=? AND is_stealth=0
        ORDER BY visited_at ASC
        LIMIT ?
      )
    `).bind(profileId, (count.n - MAX_VISIT_NOTIFS)).run();
  }
}

// ── Check if two users are friends (mutual follows) ───────────────────────────
async function areFriends(userA, userB, env) {
  const [aFollowsB, bFollowsA] = await Promise.all([
    env.DB.prepare('SELECT 1 FROM follows WHERE follower_id=? AND following_id=?').bind(userA, userB).first(),
    env.DB.prepare('SELECT 1 FROM follows WHERE follower_id=? AND following_id=?').bind(userB, userA).first(),
  ]);
  return !!(aFollowsB && bFollowsA);
}

// ── Get profile visits (notifications) for current user ──────────────────────
async function handleGetVisitNotifications(request, env) {
  const userId = await requireAuth(request, env);
  const visits = await env.DB.prepare(`
    SELECT pv.id, pv.visitor_id, pv.visited_at, pv.is_read,
           u.name, u.handle, u.picture, u.bio,
           u.follower_count
    FROM profile_visits pv
    JOIN users u ON u.id = pv.visitor_id
    WHERE pv.profile_id = ? AND pv.is_stealth = 0
    ORDER BY pv.visited_at DESC
    LIMIT 50
  `).bind(userId).all();

  const unreadCount = visits.results.filter(v => !v.is_read).length;
  return json({ visits: visits.results, unreadCount });
}

// ── Mark visit notifications as read ─────────────────────────────────────────
async function handleMarkVisitsRead(request, env) {
  const userId = await requireAuth(request, env);
  await env.DB.prepare(
    'UPDATE profile_visits SET is_read=1 WHERE profile_id=? AND is_read=0'
  ).bind(userId).run();
  return json({ success: true });
}

// ── Get privacy settings ──────────────────────────────────────────────────────
async function handleGetPrivacy(request, env) {
  const userId = await requireAuth(request, env);
  const priv = await env.DB.prepare('SELECT * FROM user_privacy WHERE user_id=?').bind(userId).first();
  // Return defaults if no record yet
  return json(priv || { user_id: userId, show_following: 'everyone', show_last_seen: 'everyone', stealth_mode: 0 });
}

// ── Update privacy settings ───────────────────────────────────────────────────
async function handleUpdatePrivacy(request, env) {
  const userId = await requireAuth(request, env);
  const { show_following } = await request.json();
  const validFollowing = ['everyone', 'only_me'];
  if (!validFollowing.includes(show_following)) return err('Invalid privacy setting');

  await env.DB.prepare(`
    INSERT INTO user_privacy (user_id, show_following)
    VALUES (?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      show_following = ?,
      updated_at     = datetime('now')
  `).bind(userId, show_following, show_following).run();

  // Also update the column on users table for quick access
  await env.DB.prepare('UPDATE users SET show_following=? WHERE id=?').bind(show_following, userId).run();

  return json({ success: true, show_following });
}

// ── Updated: get followers/following with privacy enforcement ─────────────────
async function handleGetFollowersPrivate(targetId, currentUserId, env) {
  // Followers list — always visible to logged-in users (C1)
  if (!currentUserId) return err('Sign in to view followers', 401);

  const users = await env.DB.prepare(`
    SELECT u.id, u.name, u.picture, u.bio, u.handle, u.follower_count
    FROM users u
    JOIN follows f ON u.id = f.follower_id
    WHERE f.following_id = ?
    ORDER BY f.created_at DESC LIMIT 50
  `).bind(targetId).all();

  return json(users.results);
}

async function handleGetFollowingPrivate(targetId, currentUserId, env) {
  // Following list — auth required, privacy-aware (C2), friends override (C3)
  if (!currentUserId) return err('Sign in to view following list', 401);

  const targetUser = await env.DB.prepare('SELECT id, show_following FROM users WHERE id=?').bind(targetId).first();
  if (!targetUser) return err('User not found', 404);

  // C2: if set to only_me, check C3 friends override
  if (targetUser.show_following === 'only_me' && targetUser.id !== currentUserId) {
    const friends = await areFriends(currentUserId, targetId, env);
    if (!friends) return err('This user has made their following list private', 403);
  }

  // C2 consequence: if current user has only_me, check if they are friends with target
  if (targetId !== currentUserId) {
    const currentUserPrivacy = await env.DB.prepare('SELECT show_following FROM users WHERE id=?').bind(currentUserId).first();
    if (currentUserPrivacy?.show_following === 'only_me') {
      const friends = await areFriends(currentUserId, targetId, env);
      if (!friends) return err("You cannot view others' following lists while yours is private", 403);
    }
  }

  const users = await env.DB.prepare(`
    SELECT u.id, u.name, u.picture, u.bio, u.handle, u.follower_count
    FROM users u
    JOIN follows f ON u.id = f.following_id
    WHERE f.follower_id = ?
    ORDER BY f.created_at DESC LIMIT 50
  `).bind(targetId).all();

  return json(users.results);
}

// ── Updated getUser — record visit and update last_seen ───────────────────────
// We patch handleGetUser to record visits silently

// ─── ADMIN DASHBOARD API ──────────────────────────────────────────────────────
// All routes prefixed /admin/*
// Protected by separate admin session tokens
// Super admin flag checked for sensitive operations

const ADMIN_PERMISSIONS = [
  'posts_view','posts_moderate',
  'users_view','users_suspend','users_delete',
  'squads_view','squads_manage',
  'handle_manage',
  'analytics_view',
  'admin_manage',
];

// ── Simple password hashing using Web Crypto (no bcrypt needed in Workers) ────
async function hashPassword(password) {
  const encoder = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  const hash = await crypto.subtle.deriveBits({ name:'PBKDF2', salt, iterations:100000, hash:'SHA-256' }, keyMaterial, 256);
  const hashArray = new Uint8Array(hash);
  return btoa(String.fromCharCode(...salt)) + '.' + btoa(String.fromCharCode(...hashArray));
}

async function verifyPassword(password, stored) {
  try {
    const [saltB64, hashB64] = stored.split('.');
    const salt = Uint8Array.from(atob(saltB64), c=>c.charCodeAt(0));
    const encoder = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
    const hash = await crypto.subtle.deriveBits({ name:'PBKDF2', salt, iterations:100000, hash:'SHA-256' }, keyMaterial, 256);
    const hashArray = new Uint8Array(hash);
    return btoa(String.fromCharCode(...hashArray)) === hashB64;
  } catch { return false; }
}

// ── Simple TOTP verification ──────────────────────────────────────────────────
function base32Decode(str) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0, value = 0;
  const output = [];
  for (const c of str.toUpperCase().replace(/=+$/, '')) {
    value = (value << 5) | alphabet.indexOf(c);
    bits += 5;
    if (bits >= 8) { output.push((value >>> (bits - 8)) & 0xFF); bits -= 8; }
  }
  return new Uint8Array(output);
}

async function verifyTOTP(secret, token) {
  const counter = Math.floor(Date.now() / 30000);
  for (const offset of [-1, 0, 1]) {
    const c = counter + offset;
    const key = await crypto.subtle.importKey('raw', base32Decode(secret), {name:'HMAC', hash:'SHA-1'}, false, ['sign']);
    const buf = new ArrayBuffer(8);
    new DataView(buf).setUint32(4, c);
    const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, buf));
    const offset2 = sig[19] & 0xf;
    const otp = ((sig[offset2] & 0x7f) << 24 | sig[offset2+1] << 16 | sig[offset2+2] << 8 | sig[offset2+3]) % 1000000;
    if (String(otp).padStart(6,'0') === String(token)) return true;
  }
  return false;
}

// ── Admin auth middleware ──────────────────────────────────────────────────────
async function getAdmin(request, env) {
  const auth = request.headers.get('Authorization');
  if (!auth?.startsWith('AdminBearer ')) return null;
  const token = auth.slice(12);
  const session = await env.DB.prepare(
    'SELECT admin_id, expires_at FROM admin_sessions WHERE token=?'
  ).bind(token).first();
  if (!session || new Date(session.expires_at) < new Date()) return null;
  const admin = await env.DB.prepare('SELECT * FROM admins WHERE id=?').bind(session.admin_id).first();
  if (!admin || admin.is_suspended) return null;
  admin.permissions = JSON.parse(admin.permissions || '[]');
  return admin;
}

async function requireAdmin(request, env, permission = null) {
  const admin = await getAdmin(request, env);
  if (!admin) throw Object.assign(new Error('Admin auth required'), {status:401});
  if (permission && !admin.is_super_admin && !admin.permissions.includes(permission)) {
    throw Object.assign(new Error('Insufficient permissions'), {status:403});
  }
  return admin;
}

// ── Audit log helper ──────────────────────────────────────────────────────────
async function audit(adminId, adminEmail, action, targetType, targetId, detail, env) {
  await env.DB.prepare(
    'INSERT INTO admin_audit (id,admin_id,admin_email,action,target_type,target_id,detail) VALUES (?,?,?,?,?,?,?)'
  ).bind(makeId('aud'), adminId, adminEmail, action, targetType||null, targetId||null, detail?JSON.stringify(detail):null).run();
}

// ── Admin login ───────────────────────────────────────────────────────────────
async function handleAdminLogin(request, env) {
  const { email, password, totp_token } = await request.json();
  const admin = await env.DB.prepare('SELECT * FROM admins WHERE email=?').bind(email).first();
  if (!admin) return err('Invalid credentials', 401);
  if (admin.is_suspended) return err('Account suspended', 403);
  const valid = await verifyPassword(password, admin.password_hash);
  if (!valid) return err('Invalid credentials', 401);
  // 2FA check
  if (admin.totp_enabled && admin.totp_secret) {
    if (!totp_token) return json({ requires_2fa: true }, 200);
    const totpValid = await verifyTOTP(admin.totp_secret, totp_token);
    if (!totpValid) return err('Invalid 2FA code', 401);
  }
  // Create session (8 hours)
  const token = uid() + uid();
  const expires = new Date(); expires.setHours(expires.getHours() + 8);
  await env.DB.prepare('INSERT INTO admin_sessions (token,admin_id,expires_at) VALUES (?,?,?)')
    .bind(token, admin.id, expires.toISOString()).run();
  await env.DB.prepare('UPDATE admins SET last_login=datetime("now") WHERE id=?').bind(admin.id).run();
  const { password_hash, totp_secret, ...safeAdmin } = admin;
  safeAdmin.permissions = JSON.parse(admin.permissions || '[]');
  return json({ token, admin: safeAdmin, must_change_pw: admin.must_change_pw === 1 });
}

// ── Admin: change own password ────────────────────────────────────────────────
async function handleAdminChangePassword(request, env) {
  const admin = await requireAdmin(request, env);
  const { current_password, new_password } = await request.json();
  if (new_password.length < 12) return err('Password must be at least 12 characters');
  const valid = await verifyPassword(current_password, admin.password_hash);
  if (!valid) return err('Current password incorrect', 401);
  const hash = await hashPassword(new_password);
  await env.DB.prepare('UPDATE admins SET password_hash=?, must_change_pw=0 WHERE id=?').bind(hash, admin.id).run();
  await audit(admin.id, admin.email, 'change_password', 'admin', admin.id, null, env);
  return json({ success: true });
}

// ── Admin: get dashboard stats ────────────────────────────────────────────────
async function handleAdminStats(request, env) {
  const admin = await requireAdmin(request, env, 'analytics_view');
  const [users, posts, squads, follows, darkCount, lightCount, newUsers, newPosts] = await Promise.all([
    env.DB.prepare('SELECT COUNT(*) as n FROM users').first(),
    env.DB.prepare('SELECT COUNT(*) as n FROM posts WHERE is_archived=0').first(),
    env.DB.prepare('SELECT COUNT(*) as n FROM labels').first(),
    env.DB.prepare('SELECT COUNT(*) as n FROM follows').first(),
    env.DB.prepare("SELECT COUNT(*) as n FROM users WHERE theme='dark'").first(),
    env.DB.prepare("SELECT COUNT(*) as n FROM users WHERE theme='light'").first(),
    env.DB.prepare("SELECT COUNT(*) as n FROM users WHERE created_at >= datetime('now','-7 days')").first(),
    env.DB.prepare("SELECT COUNT(*) as n FROM posts WHERE created_at >= datetime('now','-7 days') AND is_archived=0").first(),
  ]);
  const total = (darkCount?.n||0) + (lightCount?.n||0);
  return json({
    totals: { users: users?.n||0, posts: posts?.n||0, squads: squads?.n||0, follows: follows?.n||0 },
    newThisWeek: { users: newUsers?.n||0, posts: newPosts?.n||0 },
    theme: {
      dark:  darkCount?.n||0,
      light: lightCount?.n||0,
      dark_pct:  total ? Math.round((darkCount?.n||0)/total*100) : 0,
      light_pct: total ? Math.round((lightCount?.n||0)/total*100) : 0,
    },
  });
}

// ── Admin: list users ─────────────────────────────────────────────────────────
async function handleAdminListUsers(url, env) {
  const page   = parseInt(url.searchParams.get('page')||'0');
  const search = url.searchParams.get('search')||'';
  const filter = url.searchParams.get('filter')||'all'; // all | suspended
  let q = `SELECT id,name,email,handle,picture,follower_count,following_count,label_count,theme,created_at,
    CASE WHEN id IN (SELECT DISTINCT target_id FROM admin_audit WHERE action='suspend_user' AND target_type='user') THEN 1 ELSE 0 END as is_suspended
    FROM users`;
  const params = [];
  const where = [];
  if (search) { where.push("(name LIKE ? OR email LIKE ? OR handle LIKE ?)"); params.push('%'+search+'%','%'+search+'%','%'+search+'%'); }
  if (where.length) q += ' WHERE ' + where.join(' AND ');
  q += ' ORDER BY created_at DESC LIMIT 30 OFFSET ?';
  params.push(page * 30);
  const users = await env.DB.prepare(q).bind(...params).all();
  return json(users.results);
}

// ── Admin: suspend / restore user ─────────────────────────────────────────────
async function handleAdminSuspendUser(userId, action, request, env) {
  const admin = await requireAdmin(request, env, 'users_suspend');
  // Store suspension in audit log — we flag via audit rather than a column on users
  // to avoid schema changes; a suspended user check in auth reads the audit log
  await audit(admin.id, admin.email, action+'_user', 'user', userId, { action }, env);
  // Also store in a simple way: add 'suspended' to their handle_overrides as a block
  if (action === 'suspend') {
    const user = await env.DB.prepare('SELECT handle FROM users WHERE id=?').bind(userId).first();
    if (user?.handle) {
      await env.DB.prepare("INSERT OR REPLACE INTO handle_overrides (handle,action,reason,created_by) VALUES (?,?,?,?)")
        .bind('__suspended_'+userId, 'block', 'admin_suspension', admin.id).run();
    }
  } else {
    await env.DB.prepare("DELETE FROM handle_overrides WHERE handle=?").bind('__suspended_'+userId).run();
  }
  return json({ success: true, action });
}

// ── Admin: delete user ────────────────────────────────────────────────────────
async function handleAdminDeleteUser(userId, request, env) {
  const admin = await requireAdmin(request, env, 'users_delete');
  if (!admin.is_super_admin && !admin.permissions.includes('users_delete')) return err('Forbidden', 403);
  const user = await env.DB.prepare('SELECT name,email FROM users WHERE id=?').bind(userId).first();
  await env.DB.prepare('DELETE FROM users WHERE id=?').bind(userId).run();
  await audit(admin.id, admin.email, 'delete_user', 'user', userId, { name:user?.name, email:user?.email }, env);
  return json({ success: true });
}

// ── Admin: list posts ─────────────────────────────────────────────────────────
async function handleAdminListPosts(url, env) {
  const page   = parseInt(url.searchParams.get('page')||'0');
  const filter = url.searchParams.get('filter')||'all'; // all | archived | reports
  const where  = filter === 'archived' ? 'WHERE p.is_archived=1' : filter === 'reports' ? 'WHERE p.id IN (SELECT target_id FROM reports WHERE target_type="post" AND status="pending")' : '';
  const posts  = await env.DB.prepare(`
    SELECT p.*, u.name, u.handle FROM posts p JOIN users u ON p.user_id=u.id
    ${where} ORDER BY p.created_at DESC LIMIT 20 OFFSET ?
  `).bind(page * 20).all();
  return json(posts.results);
}

// ── Admin: archive post ───────────────────────────────────────────────────────
async function handleAdminArchivePost(postId, request, env) {
  const admin = await requireAdmin(request, env, 'posts_moderate');
  await env.DB.prepare('UPDATE posts SET is_archived=1 WHERE id=?').bind(postId).run();
  await audit(admin.id, admin.email, 'archive_post', 'post', postId, null, env);
  return json({ success: true });
}

// ── Admin: delete post ────────────────────────────────────────────────────────
async function handleAdminDeletePost(postId, request, env) {
  const admin = await requireAdmin(request, env, 'posts_moderate');
  await env.DB.prepare('DELETE FROM posts WHERE id=?').bind(postId).run();
  await audit(admin.id, admin.email, 'delete_post', 'post', postId, null, env);
  return json({ success: true });
}

// ── Admin: list squads ────────────────────────────────────────────────────────
async function handleAdminListSquads(url, env) {
  const page   = parseInt(url.searchParams.get('page')||'0');
  const search = url.searchParams.get('search')||'';
  let q = "SELECT l.*, u.name as creator_name FROM labels l LEFT JOIN users u ON l.created_by=u.id";
  if (search) q += " WHERE l.name_lower LIKE '%" + search.toLowerCase().replace(/'/g,"''") + "%'";
  q += " ORDER BY l.member_count DESC LIMIT 30 OFFSET ?";
  const squads = await env.DB.prepare(q).bind(page * 30).all();
  return json(squads.results);
}

// ── Admin: edit squad ─────────────────────────────────────────────────────────
async function handleAdminEditSquad(squadId, request, env) {
  const admin = await requireAdmin(request, env, 'squads_manage');
  const { name, type } = await request.json();
  await env.DB.prepare('UPDATE labels SET name=?, type=? WHERE id=?').bind(name, type, squadId).run();
  await audit(admin.id, admin.email, 'edit_squad', 'squad', squadId, {name,type}, env);
  return json({ success: true });
}

// ── Admin: delete squad ───────────────────────────────────────────────────────
async function handleAdminDeleteSquad(squadId, request, env) {
  const admin = await requireAdmin(request, env, 'squads_manage');
  await env.DB.prepare('DELETE FROM labels WHERE id=?').bind(squadId).run();
  await audit(admin.id, admin.email, 'delete_squad', 'squad', squadId, null, env);
  return json({ success: true });
}

// ── Admin: handle overrides ───────────────────────────────────────────────────
async function handleAdminListOverrides(env) {
  const rows = await env.DB.prepare("SELECT * FROM handle_overrides WHERE handle NOT LIKE '__suspended_%' ORDER BY created_at DESC").all();
  return json(rows.results);
}

async function handleAdminAddOverride(request, env) {
  const admin  = await requireAdmin(request, env, 'handle_manage');
  const { handle, action, reason } = await request.json();
  await env.DB.prepare("INSERT OR REPLACE INTO handle_overrides (handle,action,reason,created_by) VALUES (?,?,?,?)")
    .bind(handle.toLowerCase(), action, reason||'admin', admin.id).run();
  await audit(admin.id, admin.email, 'add_override', 'handle', handle, {action,reason}, env);
  return json({ success: true });
}

async function handleAdminDeleteOverride(handle, request, env) {
  const admin = await requireAdmin(request, env, 'handle_manage');
  await env.DB.prepare('DELETE FROM handle_overrides WHERE handle=?').bind(handle).run();
  await audit(admin.id, admin.email, 'delete_override', 'handle', handle, null, env);
  return json({ success: true });
}

// ── Admin: list admin accounts ────────────────────────────────────────────────
async function handleAdminListAdmins(request, env) {
  const admin = await requireAdmin(request, env, 'admin_manage');
  const admins = await env.DB.prepare(
    'SELECT id,email,name,is_super_admin,is_suspended,permissions,must_change_pw,last_login,created_at FROM admins ORDER BY created_at DESC'
  ).all();
  return json(admins.results.map(a=>({...a,permissions:JSON.parse(a.permissions||'[]')})));
}

// ── Admin: create admin account ───────────────────────────────────────────────
async function handleAdminCreateAdmin(request, env) {
  const admin = await requireAdmin(request, env, 'admin_manage');
  if (!admin.is_super_admin) return err('Only super admin can create admin accounts', 403);
  const { email, name, permissions = [] } = await request.json();
  if (!email || !name) return err('Email and name required');
  const existing = await env.DB.prepare('SELECT id FROM admins WHERE email=?').bind(email).first();
  if (existing) return err('Email already exists');
  // Generate temporary password
  const tempPassword = uid().slice(0,8) + 'Cc1!';
  const hash = await hashPassword(tempPassword);
  const id = makeId('adm');
  const validPerms = permissions.filter(p => ADMIN_PERMISSIONS.includes(p));
  await env.DB.prepare(
    'INSERT INTO admins (id,email,name,password_hash,permissions,must_change_pw,created_by) VALUES (?,?,?,?,?,1,?)'
  ).bind(id, email, name, hash, JSON.stringify(validPerms), admin.id).run();
  await audit(admin.id, admin.email, 'create_admin', 'admin', id, {email,name,permissions:validPerms}, env);
  return json({ success:true, id, email, temp_password: tempPassword, must_change_pw: true }, 201);
}

// ── Admin: update admin permissions ──────────────────────────────────────────
async function handleAdminUpdatePermissions(targetId, request, env) {
  const admin = await requireAdmin(request, env, 'admin_manage');
  if (!admin.is_super_admin) return err('Only super admin can update permissions', 403);
  const { permissions } = await request.json();
  const validPerms = permissions.filter(p => ADMIN_PERMISSIONS.includes(p));
  await env.DB.prepare('UPDATE admins SET permissions=? WHERE id=? AND is_super_admin=0')
    .bind(JSON.stringify(validPerms), targetId).run();
  await audit(admin.id, admin.email, 'update_permissions', 'admin', targetId, {permissions:validPerms}, env);
  return json({ success: true });
}

// ── Admin: suspend/restore admin ──────────────────────────────────────────────
async function handleAdminToggleSuspend(targetId, request, env) {
  const admin = await requireAdmin(request, env, 'admin_manage');
  if (!admin.is_super_admin) return err('Only super admin can suspend admin accounts', 403);
  if (targetId === admin.id) return err('Cannot suspend yourself');
  const target = await env.DB.prepare('SELECT is_suspended FROM admins WHERE id=?').bind(targetId).first();
  const newState = target?.is_suspended ? 0 : 1;
  await env.DB.prepare('UPDATE admins SET is_suspended=? WHERE id=?').bind(newState, targetId).run();
  await audit(admin.id, admin.email, newState?'suspend_admin':'restore_admin', 'admin', targetId, null, env);
  return json({ success: true, suspended: newState === 1 });
}

// ── Admin: audit log ──────────────────────────────────────────────────────────
async function handleAdminAuditLog(url, env) {
  const page = parseInt(url.searchParams.get('page')||'0');
  const rows = await env.DB.prepare(
    'SELECT * FROM admin_audit ORDER BY created_at DESC LIMIT 50 OFFSET ?'
  ).bind(page * 50).all();
  return json(rows.results);
}

// ── Initialize super admin (one-time setup) ───────────────────────────────────
// POST /admin/setup — only works if no admins exist yet
async function handleAdminSetup(request, env) {
  const count = await env.DB.prepare('SELECT COUNT(*) as n FROM admins').first();
  if ((count?.n||0) > 0) return err('Admin already initialized', 403);
  const { email, name, password } = await request.json();
  if (!email||!name||!password) return err('Email, name and password required');
  if (password.length < 12) return err('Password must be at least 12 characters');
  const hash = await hashPassword(password);
  const id = makeId('adm');
  await env.DB.prepare(
    'INSERT INTO admins (id,email,name,password_hash,is_super_admin,must_change_pw,permissions) VALUES (?,?,?,?,1,0,?)'
  ).bind(id, email, name, hash, JSON.stringify(ADMIN_PERMISSIONS)).run();
  return json({ success: true, id, message: 'Super admin created. Login at manage.calcheckai.com' }, 201);
}

// ─── SOCIAL POSTS ─────────────────────────────────────────────────────────────

const POST_LIMITS = { text: 200, image: 50, total: 250 };
const VALID_REACTIONS = ['heart','fire','strong','laugh','inspire','respect','wow'];
const REACTION_EMOJI  = { heart:'❤️', fire:'🔥', strong:'💪', laugh:'😂', inspire:'✨', respect:'🙌', wow:'😮' };

// ─── PRUNING ──────────────────────────────────────────────────────────────────
// Two independent rules:
// Rule 1: total posts > 250 → archive oldest post of any type
// Rule 2: image posts > 50  → archive oldest image post

async function runPruning(userId, postType, env) {
  const counts = await env.DB.prepare(
    'SELECT * FROM post_counts WHERE user_id=?'
  ).bind(userId).first();
  if (!counts) return { pruned: false };

  const pruned = [];

  // Rule 2 — image cap (independent, runs first)
  if ((postType === 'image') && counts.image_count > POST_LIMITS.image) {
    const oldest = await env.DB.prepare(`
      SELECT id FROM posts
      WHERE user_id=? AND post_type='image' AND is_archived=0
      ORDER BY created_at ASC LIMIT 1
    `).bind(userId).first();
    if (oldest) {
      await env.DB.prepare('UPDATE posts SET is_archived=1 WHERE id=?').bind(oldest.id).run();
      pruned.push({ rule: 'image_cap', postId: oldest.id });
    }
  }

  // Rule 1 — total cap
  if (counts.total_count > POST_LIMITS.total) {
    const oldest = await env.DB.prepare(`
      SELECT id FROM posts
      WHERE user_id=? AND is_archived=0
      ORDER BY created_at ASC LIMIT 1
    `).bind(userId).first();
    if (oldest) {
      await env.DB.prepare('UPDATE posts SET is_archived=1 WHERE id=?').bind(oldest.id).run();
      pruned.push({ rule: 'total_cap', postId: oldest.id });
    }
  }

  return { pruned };
}

// ─── CREATE POST ──────────────────────────────────────────────────────────────
async function handleCreatePost(request, env) {
  const userId = await requireAuth(request, env);
  const { text = '', image_url, scan_data, post_type = 'text' } = await request.json();

  if (!text.trim() && !image_url && !scan_data) return err('Post cannot be empty');
  if (text.length > 500) return err('Post text cannot exceed 500 characters');
  if (!['text','image','scan'].includes(post_type)) return err('Invalid post type');

  const id = makeId('pst');

  // Insert post
  await env.DB.prepare(`
    INSERT INTO posts (id, user_id, text, image_url, scan_data, post_type)
    VALUES (?,?,?,?,?,?)
  `).bind(id, userId, text.trim(), image_url||null, scan_data?JSON.stringify(scan_data):null, post_type).run();

  // Update counts
  await env.DB.prepare(`
    INSERT INTO post_counts (user_id, text_count, image_count, total_count)
    VALUES (?,?,?,1)
    ON CONFLICT(user_id) DO UPDATE SET
      text_count  = text_count  + ?,
      image_count = image_count + ?,
      total_count = total_count + 1,
      updated_at  = datetime('now')
  `).bind(
    userId,
    post_type !== 'image' ? 1 : 0,  // initial insert values
    post_type === 'image' ? 1 : 0,
    post_type !== 'image' ? 1 : 0,  // update values
    post_type === 'image' ? 1 : 0
  ).run();

  // Run pruning checks
  const { pruned } = await runPruning(userId, post_type, env);

  // Fetch fresh counts for limit warnings
  const counts = await env.DB.prepare('SELECT * FROM post_counts WHERE user_id=?').bind(userId).first();

  // Build warning messages
  const warnings = [];
  if (pruned.length) {
    pruned.forEach(p => {
      if (p.rule === 'image_cap') warnings.push('Your oldest photo post has been archived. Go premium to keep all photo posts visible.');
      if (p.rule === 'total_cap') warnings.push('Your oldest post has been archived. Go premium to keep everything.');
    });
  }
  if (counts?.image_count >= 45 && counts?.image_count <= 50) {
    warnings.push(`You have posted ${counts.image_count} of your 50 photo posts. Go premium for unlimited photos.`);
  }

  const post = await env.DB.prepare('SELECT * FROM posts WHERE id=?').bind(id).first();
  return json({ post, counts, warnings }, 201);
}

// ─── GET PROFILE POSTS ────────────────────────────────────────────────────────
async function handleGetProfilePosts(targetUserId, currentUserId, page, env) {
  const isOwn = targetUserId === currentUserId;
  // Own posts: show all including archived. Others: public only.
  const posts = await env.DB.prepare(`
    SELECT p.*, u.name, u.handle, u.picture,
      (SELECT COUNT(*) FROM reactions r WHERE r.post_id=p.id) as total_reactions,
      ${currentUserId ? `(SELECT reaction_type FROM reactions r WHERE r.post_id=p.id AND r.user_id='${currentUserId}') as my_reaction,` : 'NULL as my_reaction,'}
      (SELECT json_group_object(reaction_type, cnt) FROM (
        SELECT reaction_type, COUNT(*) as cnt FROM reactions WHERE post_id=p.id GROUP BY reaction_type
      )) as reaction_counts
    FROM posts p
    JOIN users u ON p.user_id = u.id
    WHERE p.user_id=? ${isOwn ? '' : 'AND p.is_archived=0'}
    ORDER BY p.created_at DESC
    LIMIT 20 OFFSET ?
  `).bind(targetUserId, page * 20).all();

  return json(posts.results.map(p => ({
    ...p,
    scan_data: p.scan_data ? JSON.parse(p.scan_data) : null,
    reaction_counts: p.reaction_counts ? JSON.parse(p.reaction_counts) : {},
  })));
}

// ─── GET ARCHIVED POSTS (own only) ───────────────────────────────────────────
async function handleGetArchivedPosts(request, env) {
  const userId = await requireAuth(request, env);
  const posts = await env.DB.prepare(
    'SELECT * FROM posts WHERE user_id=? AND is_archived=1 ORDER BY created_at DESC LIMIT 50'
  ).bind(userId).all();
  return json(posts.results.map(p => ({ ...p, scan_data: p.scan_data ? JSON.parse(p.scan_data) : null })));
}

// ─── HOME FEED ────────────────────────────────────────────────────────────────
async function handleGetFeed(request, env) {
  const userId = await requireAuth(request, env);
  const page = parseInt(new URL(request.url).searchParams.get('page') || '0');

  const posts = await env.DB.prepare(`
    SELECT p.*, u.name, u.handle, u.picture,
      (SELECT COUNT(*) FROM reactions r WHERE r.post_id=p.id) as total_reactions,
      (SELECT reaction_type FROM reactions r WHERE r.post_id=p.id AND r.user_id=?) as my_reaction,
      (SELECT json_group_object(reaction_type, cnt) FROM (
        SELECT reaction_type, COUNT(*) as cnt FROM reactions WHERE post_id=p.id GROUP BY reaction_type
      )) as reaction_counts
    FROM posts p
    JOIN users u ON p.user_id = u.id
    JOIN follows f ON f.following_id = p.user_id
    WHERE f.follower_id=? AND p.is_archived=0
    ORDER BY p.created_at DESC
    LIMIT 20 OFFSET ?
  `).bind(userId, userId, page * 20).all();

  return json(posts.results.map(p => ({
    ...p,
    scan_data: p.scan_data ? JSON.parse(p.scan_data) : null,
    reaction_counts: p.reaction_counts ? JSON.parse(p.reaction_counts) : {},
  })));
}

// ─── REACT TO POST ────────────────────────────────────────────────────────────
async function handleReaction(request, env) {
  const userId = await requireAuth(request, env);
  const { post_id, reaction_type } = await request.json();

  if (!VALID_REACTIONS.includes(reaction_type)) return err('Invalid reaction type');

  // Check user follows the post author
  const post = await env.DB.prepare('SELECT user_id FROM posts WHERE id=?').bind(post_id).first();
  if (!post) return err('Post not found', 404);

  if (post.user_id !== userId) {
    const follows = await env.DB.prepare(
      'SELECT 1 FROM follows WHERE follower_id=? AND following_id=?'
    ).bind(userId, post.user_id).first();
    if (!follows) return err('You must follow this user to react', 403);
  }

  // Toggle: if same reaction exists, remove it; else upsert
  const existing = await env.DB.prepare(
    'SELECT reaction_type FROM reactions WHERE post_id=? AND user_id=?'
  ).bind(post_id, userId).first();

  if (existing?.reaction_type === reaction_type) {
    // Remove reaction
    await env.DB.prepare('DELETE FROM reactions WHERE post_id=? AND user_id=?').bind(post_id, userId).run();
    await env.DB.prepare('UPDATE posts SET reaction_count=MAX(0,reaction_count-1) WHERE id=?').bind(post_id).run();
    return json({ action: 'removed', reaction_type });
  } else {
    // Add or change reaction
    await env.DB.prepare(`
      INSERT INTO reactions (post_id, user_id, reaction_type)
      VALUES (?,?,?)
      ON CONFLICT(post_id, user_id) DO UPDATE SET reaction_type=?, created_at=datetime('now')
    `).bind(post_id, userId, reaction_type, reaction_type).run();
    if (!existing) {
      await env.DB.prepare('UPDATE posts SET reaction_count=reaction_count+1 WHERE id=?').bind(post_id).run();
    }
    return json({ action: 'added', reaction_type });
  }
}

// ─── DELETE POST ──────────────────────────────────────────────────────────────
async function handleDeletePost(postId, request, env) {
  const userId = await requireAuth(request, env);
  const post = await env.DB.prepare('SELECT * FROM posts WHERE id=?').bind(postId).first();
  if (!post) return err('Post not found', 404);
  if (post.user_id !== userId) return err('Forbidden', 403);

  await env.DB.prepare('DELETE FROM posts WHERE id=?').bind(postId).run();
  await env.DB.prepare(`
    UPDATE post_counts SET
      text_count  = MAX(0, text_count  - ?),
      image_count = MAX(0, image_count - ?),
      total_count = MAX(0, total_count - 1),
      updated_at  = datetime('now')
    WHERE user_id=?
  `).bind(
    post.post_type !== 'image' ? 1 : 0,
    post.post_type === 'image' ? 1 : 0,
    userId
  ).run();

  return json({ success: true });
}

// ─── WATER TRACKING ───────────────────────────────────────────────────────────

const WATER_BADGES = [
  { id:'hydrated',   emoji:'💧', name:'Hydrated',   desc:'Hit water goal 7 days in a row'  },
  { id:'flow_state', emoji:'🌊', name:'Flow State',  desc:'Hit water goal 30 days in a row' },
];

// Default goal: 2000ml / 8 glasses
// Personalised: 35ml × bodyWeight kg (from onboarding profile)
function calcWaterGoal(weightKg) {
  if (!weightKg || weightKg < 30) return 2000;
  return Math.round(weightKg * 35 / 100) * 100; // round to nearest 100ml
}

async function handleLogWater(request, env) {
  const userId = await requireAuth(request, env);
  const { intake_ml, unit_pref = 'glasses', use_personalised = false } = await request.json();
  if (typeof intake_ml !== 'number' || intake_ml < 0) return err('Invalid intake value');

  const today = todayDate();

  // Get user's weight for personalised goal
  let goalMl = 2000;
  if (use_personalised) {
    const u = await env.DB.prepare('SELECT * FROM users WHERE id=?').bind(userId).first();
    // weight stored in profile during onboarding — stored as part of user record
    goalMl = calcWaterGoal(u?.weight_kg || 0);
  }

  // Upsert today's water log
  await env.DB.prepare(`
    INSERT INTO water_logs (user_id, log_date, intake_ml, goal_ml, unit_pref)
    VALUES (?,?,?,?,?)
    ON CONFLICT(user_id, log_date) DO UPDATE SET
      intake_ml  = ?,
      goal_ml    = ?,
      unit_pref  = ?,
      updated_at = datetime('now')
  `).bind(userId, today, intake_ml, goalMl, unit_pref, intake_ml, goalMl, unit_pref).run();

  // Check if goal is hit
  const goalHit = intake_ml >= goalMl;
  let streakResult = null;
  let newBadges   = [];
  let xpResult    = null;

  if (goalHit) {
    // Award XP for hitting daily water goal
    xpResult = await awardXp(userId, 'hit_goal', env); // reuse hit_goal XP value (25 XP)

    // Update water streak
    let wStreak = await env.DB.prepare('SELECT * FROM water_streaks WHERE user_id=?').bind(userId).first();

    if (!wStreak) {
      await env.DB.prepare('INSERT INTO water_streaks (user_id,current_streak,longest_streak,last_goal_date) VALUES (?,1,1,?)').bind(userId, today).run();
      wStreak = { current_streak:1, longest_streak:1 };
    } else if (wStreak.last_goal_date !== today) {
      const yesterday = new Date(); yesterday.setDate(yesterday.getDate()-1);
      const yStr = yesterday.toISOString().slice(0,10);
      const newStreak = wStreak.last_goal_date === yStr ? wStreak.current_streak + 1 : 1;
      const longest   = Math.max(newStreak, wStreak.longest_streak);
      await env.DB.prepare(`UPDATE water_streaks SET current_streak=?,longest_streak=?,last_goal_date=?,updated_at=datetime('now') WHERE user_id=?`).bind(newStreak, longest, today, userId).run();
      wStreak = { current_streak: newStreak, longest_streak: longest };
    }

    streakResult = wStreak;

    // Check water badges
    const earned = await env.DB.prepare('SELECT badge_id FROM user_badges WHERE user_id=?').bind(userId).all();
    const earnedIds = new Set(earned.results.map(r=>r.badge_id));

    const maybeBadge = async id => {
      if (earnedIds.has(id)) return;
      await env.DB.prepare('INSERT OR IGNORE INTO user_badges (user_id,badge_id) VALUES (?,?)').bind(userId, id).run();
      const b = WATER_BADGES.find(x=>x.id===id);
      if (b) newBadges.push(b);
    };

    if (wStreak.current_streak >= 7)  await maybeBadge('hydrated');
    if (wStreak.current_streak >= 30) await maybeBadge('flow_state');

    // Bonus XP for logging water with every meal
    const todayLog = await env.DB.prepare('SELECT COUNT(*) as n FROM daily_logs WHERE user_id=? AND log_date=?').bind(userId, today).first();
    if ((todayLog?.n || 0) >= 3) await awardXp(userId, 'log_meal', env); // 10 XP bonus
  }

  const log = await env.DB.prepare('SELECT * FROM water_logs WHERE user_id=? AND log_date=?').bind(userId, today).first();

  return json({ log, goalHit, waterStreak: streakResult, xp: xpResult, newBadges });
}

async function handleGetWater(userId, env) {
  const today = todayDate();
  const [todayLog, streak, history] = await Promise.all([
    env.DB.prepare('SELECT * FROM water_logs WHERE user_id=? AND log_date=?').bind(userId, today).first(),
    env.DB.prepare('SELECT * FROM water_streaks WHERE user_id=?').bind(userId).first(),
    env.DB.prepare('SELECT * FROM water_logs WHERE user_id=? ORDER BY log_date DESC LIMIT 7').bind(userId).all(),
  ]);
  return json({
    today:   todayLog || { intake_ml:0, goal_ml:2000, unit_pref:'glasses', log_date:today },
    streak:  streak   || { current_streak:0, longest_streak:0 },
    history: history.results,
  });
}

// ─── NUTRITION LABEL SCAN ─────────────────────────────────────────────────────
// Accepts a base64 image of a nutrition facts panel.
// Sends to Cloudflare Workers AI (Llama 3.2 Vision) with a targeted prompt.
// Returns structured nutritional data as JSON.

const LABEL_PROMPT = `Identify the food in this image and estimate its nutrition for the visible portion. Output ONLY a JSON object, nothing else, no words before or after. Use this exact format:
{"food_name":"name of the food","calories":250,"protein":6,"carbs":55,"fat":1,"fiber":1,"sugar":0,"sodium":10,"serving_size":"1 portion"}
Replace the numbers with your best estimate. If the image is a nutrition label, read the per-serving values. Output only the JSON.`;

// ─── TEXT FOOD SCAN (manual entry) ───────────────────────────────────
// Accepts a plain-text meal description; guests allowed (same policy as label scan).
const TEXT_SCAN_PROMPT = (desc) => `Estimate the nutrition for this meal description: "${desc}".
Assume standard portions when unspecified. Output ONLY a JSON object, nothing else, no words before or after:
{"food_name":"short name of the meal","calories":250,"protein":6,"carbs":55,"fat":1,"fiber":1,"sugar":0,"sodium":10,"serving_size":"1 portion"}
Replace the numbers with your best estimate for the WHOLE described meal. Output only the JSON.`;

async function handleTextScan(request, env) {
  const { text } = await request.json();
  if (!text || !String(text).trim()) return err('Description required');
  if (String(text).length > 500) return err('Description too long (max 500 characters)');
  if (!env.AI) return err('Workers AI binding not configured', 500);
  try {
    const res = await env.AI.run('@cf/meta/llama-3.2-11b-vision-instruct', {
      messages: [
        { role: 'system', content: 'You are a nutritionist. Return ONLY valid compact JSON. No explanation. No markdown.' },
        { role: 'user', content: TEXT_SCAN_PROMPT(String(text).trim().replace(/"/g, "'")) },
      ],
      max_tokens: 600,
      temperature: 0.2,
    });
    let raw = '';
    if (typeof res === 'string') raw = res;
    else if (res && typeof res.response === 'string') raw = res.response;
    else if (res && res.response != null) raw = JSON.stringify(res.response);
    else raw = JSON.stringify(res);
    raw = String(raw).replace(/```json|```/g, '').trim();
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return json({ error: true }, 200);
    let parsed;
    try { parsed = JSON.parse(m[0]); } catch { return json({ error: true }, 200); }
    if (typeof parsed.calories !== 'number') return err('Could not estimate nutrition from that description');
    const item = {
      name: parsed.food_name || parsed.name || 'Meal',
      emoji: parsed.emoji || '🍽️',
      calories: Math.round(Number(parsed.calories) || 0),
      protein: Math.round(Number(parsed.protein) || 0),
      carbs: Math.round(Number(parsed.carbs) || 0),
      fat: Math.round(Number(parsed.fat) || 0),
      fiber: parsed.fiber != null ? Math.round(Number(parsed.fiber) || 0) : undefined,
      sugar: parsed.sugar != null ? Math.round(Number(parsed.sugar) || 0) : undefined,
      sodium: parsed.sodium != null ? Math.round(Number(parsed.sodium) || 0) : undefined,
    };
    if (!(item.calories > 0)) return err('Could not estimate nutrition from that description');
    return json({ items: [item], total: item.calories, notes: parsed.serving_size || '' });
  } catch (e) {
    return err('AI model error: ' + ((e && e.message) || 'unknown'));
  }
}

async function handleLabelScan(request, env) {
  // Auth optional — guests can scan labels (no AI cost concern, low frequency)
  const { image, mediaType = 'image/jpeg' } = await request.json();
  if (!image) return err('Image required');

  if (!env.AI) return err('Workers AI binding not configured', 500);
  try {
    // Convert base64 image to array of 8-bit unsigned integers (Cloudflare vision format)
    const binaryStr = atob(image);
    const bytes = new Uint8Array(binaryStr.length);
    for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);

    let res;
    try {
      res = await env.AI.run('@cf/meta/llama-3.2-11b-vision-instruct', {
        prompt: LABEL_PROMPT,
        image: [...bytes],
        max_tokens: 800,
        temperature: 0.2,
      });
    } catch (aiErr) {
      // If model needs license agreement, send 'agree' then retry once
      const msg = String(aiErr && aiErr.message || aiErr);
      if (msg.toLowerCase().includes('agree') || msg.toLowerCase().includes('license') || msg.toLowerCase().includes('5006') || msg.toLowerCase().includes('terms')) {
        await env.AI.run('@cf/meta/llama-3.2-11b-vision-instruct', { prompt: 'agree' });
        res = await env.AI.run('@cf/meta/llama-3.2-11b-vision-instruct', {
          prompt: LABEL_PROMPT,
          image: [...bytes],
          max_tokens: 800,
          temperature: 0.2,
        });
      } else {
        return err('AI model error: ' + msg);
      }
    }

    // Bulletproof extraction — res.response may be a string, object, or array
    let raw = '';
    if (typeof res === 'string') {
      raw = res;
    } else if (res && typeof res.response === 'string') {
      raw = res.response;
    } else if (res && typeof res.description === 'string') {
      raw = res.description;
    } else if (res && res.response != null) {
      // response exists but isn't a string — stringify it
      raw = JSON.stringify(res.response);
    } else {
      // Last resort — stringify whole response object
      raw = JSON.stringify(res);
    }
    raw = String(raw).replace(/```json|```/g, '').trim();

    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return json({ error: true, debug: true,
        raw_model_output: raw.substring(0, 600),
        res_type: typeof res,
        res_keys: (res && typeof res === 'object') ? Object.keys(res).join(',') : 'n/a',
        res_full: JSON.stringify(res).substring(0, 600)
      }, 200);
    }
    let parsed;
    try { parsed = JSON.parse(jsonMatch[0]); }
    catch(pe) { return json({ error: true, debug: true, parse_error: pe.message, raw_model_output: raw.substring(0, 600) }, 200); }

    // Validate — must have at least calories
    if (typeof parsed.calories !== 'number') return err('Could not read nutrition — calories missing');

    return json({
      food_name: parsed.food_name || '',
      calories:  Math.round(parsed.calories || 0),
      protein:   Math.round(parsed.protein  || 0),
      carbs:     Math.round(parsed.carbs    || 0),
      fat:       Math.round(parsed.fat      || 0),
      fiber:     Math.round(parsed.fiber    || 0),
      sugar:     Math.round(parsed.sugar    || 0),
      sodium:    Math.round(parsed.sodium   || 0),
      serving:   parsed.serving_size || '',
      per:       parsed.per || 'serving',
    });
  } catch (e) {
    return err('Label could not be read — ' + e.message);
  }
}

// ─── ROUTER ───────────────────────────────────────────────────────────────────

// ─── CRON: WEEKLY STATS EMAIL ─────────────────────────────────────────────────
// Runs every Monday at 08:00 UTC
// Configure in wrangler.toml: [triggers] crons = ["0 8 * * 1"]
// Requires env vars: ADMIN_EMAIL, RESEND_API_KEY

async function sendWeeklyStats(env) {
  // Count theme preferences
  const stats = await env.DB.prepare(`
    SELECT
      theme,
      COUNT(*) as count,
      ROUND(COUNT(*) * 100.0 / SUM(COUNT(*)) OVER (), 1) as pct
    FROM users
    GROUP BY theme
    ORDER BY count DESC
  `).all();

  const totalUsers   = await env.DB.prepare('SELECT COUNT(*) as n FROM users').first();
  const newThisWeek  = await env.DB.prepare(
    "SELECT COUNT(*) as n FROM users WHERE created_at >= datetime('now', '-7 days')"
  ).first();
  const totalLabels  = await env.DB.prepare('SELECT COUNT(*) as n FROM labels').first();
  const totalFollows = await env.DB.prepare('SELECT COUNT(*) as n FROM follows').first();

  const themeRows = stats.results.map(r => {
    const icon = r.theme === 'dark' ? '🌙' : '☀️';
    return `  ${icon} ${r.theme.charAt(0).toUpperCase() + r.theme.slice(1)} mode   ${r.pct}%  (${r.count} users)`;
  }).join('\n');

  const weekOf = new Date().toLocaleDateString('en-GB', { day:'numeric', month:'long', year:'numeric' });

  const body = `
CalCheckAI Weekly Stats — w/c ${weekOf}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Theme Preference
${themeRows}

Platform Overview
  👥 Total users:     ${totalUsers.n}
  🆕 New this week:   ${newThisWeek.n}
  🏷️  Labels created:  ${totalLabels.n}
  🤝 Total follows:   ${totalFollows.n}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Sent automatically every Monday · CalCheckAI
  `.trim();

  // Send via Resend (free tier: 3,000 emails/month)
  if (!env.RESEND_API_KEY || !env.ADMIN_EMAIL) {
    console.log('Weekly stats (no email configured):\n' + body);
    return;
  }

  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: 'CalCheckAI Stats <stats@calcheckai.com>',
      to:   env.ADMIN_EMAIL,
      subject: `CalCheckAI Weekly Stats — w/c ${weekOf}`,
      text: body,
    }),
  });
}

export default {
  async scheduled(event, env) {
    // Every 6 hours — refresh blocklist from GitHub into KV
    if (event.cron === '0 */6 * * *') {
      await refreshBlocklist(env);
      return;
    }
    // Every Monday 08:00 — send weekly stats email + calculate weekly scores
    await calculateWeeklyScores(env);
    await deleteOldMessages(env); // 4-week message retention policy
    await sendWeeklyStats(env);
  },
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });

    const url    = new URL(request.url);
    const path   = url.pathname;
    const method = request.method;

    try {
      // ── SSR ROUTES (served before API routes) ─────────────────────────────
      if (path.startsWith('/squad/')) return handleSquadSSR(path.slice(7), env);
      if (path.startsWith('/u/'))     return handleProfileSSR(path.slice(3), env);
      if (path.startsWith('/og/'))    return handleOgImage(path.slice(4), env);
      if (path === '/sitemap.xml')    return handleSitemap(env);

      // Auth
      if (path === '/api/auth' && method === 'POST') return handleAuth(request, env);

      // Current user
      if (path === '/api/users/me') {
        if (method === 'GET') return handleGetMe(request, env);
        if (method === 'PUT') return handleUpdateMe(request, env);
      }

      // Discover
      if (path === '/api/discover' && method === 'GET') return handleDiscover(url, env);

      // User routes
      const userMatch = path.match(/^\/api\/users\/([^/]+)(\/followers|\/following)?$/);
      if (userMatch) {
        const targetId = userMatch[1];
        const sub      = userMatch[2];
        const page     = parseInt(url.searchParams.get('page') || '0');
        const currentUserId = await getSession(request, env);
        if (sub === '/followers') return handleGetFollowers(targetId, page, env);
        if (sub === '/following') return handleGetFollowing(targetId, page, env);
        return handleGetUser(targetId, currentUserId, env);
      }

      // Follows
      if (path === '/api/follows' && method === 'POST') return handleFollow(request, env);
      const followMatch = path.match(/^\/api\/follows\/([^/]+)$/);
      if (followMatch && method === 'DELETE') return handleUnfollow(followMatch[1], request, env);

      // Labels
      if (path === '/api/labels') {
        if (method === 'GET')  return handleListLabels(url, env);
        if (method === 'POST') return handleCreateLabel(request, env);
      }
      const labelMatch = path.match(/^\/api\/labels\/([^/]+)$/);
      if (labelMatch) {
        const labelId       = labelMatch[1];
        const currentUserId = await getSession(request, env);
        if (method === 'GET') return handleGetLabel(labelId, currentUserId, env);
      }

      // User-label membership
      if (path === '/api/user-labels' && method === 'POST') return handleJoinLabel(request, env);
      const ulMatch = path.match(/^\/api\/user-labels\/([^/]+)$/);
      if (ulMatch && method === 'DELETE') return handleLeaveLabel(ulMatch[1], request, env);

      // Avatar upload — step 1: get presigned URL
      if (path === '/api/users/me/avatar' && method === 'POST') return handleAvatarPresign(request, env);
      // Avatar upload — step 2: confirm upload, save URL to D1
      if (path === '/api/users/me/avatar' && method === 'PATCH') return handleAvatarConfirm(request, env);
      // Avatar upload — direct fallback (no presigned URL)
      if (path === '/api/users/me/avatar/direct' && method === 'POST') return handleAvatarDirect(request, env);

      // Handle availability check
      if (path === '/api/handles/check' && method === 'GET') {
        const handle = url.searchParams.get('handle') || '';
        const currentUserId = await getSession(request, env);
        const result = await checkHandleAvailability(handle, currentUserId, env);
        return json(result);
      }

      // Claim / change handle
      if (path === '/api/users/me/handle' && method === 'PUT') {
        const userId = await requireAuth(request, env);
        const { handle } = await request.json();
        const result = await claimHandle(userId, handle, env);
        if (!result.ok) return err(result.reason);
        return json({ handle: result.handle });
      }

      // Look up user by @handle
      if (path.match(/^\/api\/u\/[^/]+$/) && method === 'GET') {
        const handle = path.split('/')[3].toLowerCase();
        const currentUserId = await getSession(request, env);
        const user = await env.DB.prepare('SELECT id FROM users WHERE handle = ?').bind(handle).first();
        if (!user) return err('User not found', 404);
        return handleGetUser(user.id, currentUserId, env);
      }

      // Log meal (streak + XP + badge check)
      if (path === '/api/log-meal' && method === 'POST') return handleLogMeal(request, env);

      // Gamification profile (XP, streak, badges, weekly score)
      if (path === '/api/gamification/me' && method === 'GET') {
        const userId = await requireAuth(request, env);
        return handleGetGamification(userId, env);
      }

      // Squad leaderboard
      if (path.match(/^\/api\/labels\/[^/]+\/leaderboard$/) && method === 'GET') {
        const labelId = path.split('/')[3];
        const currentUserId = await getSession(request, env);
        return handleSquadLeaderboard(labelId, currentUserId, env);
      }

      // Private messaging
      if (path === '/api/messages' && method === 'POST')          return handleSendMessage(request, env);
      if (path === '/api/conversations' && method === 'GET')      return handleGetConversations(request, env);
      if (path === '/api/conversations/unread' && method === 'GET') return handleGetUnreadCount(request, env);
      const msgConvMatch = path.match(/^\/api\/conversations\/([^/]+)\/messages$/);
      if (msgConvMatch && method === 'GET') return handleGetMessages(msgConvMatch[1], request, env);
      const msgDelMatch = path.match(/^\/api\/messages\/([^/]+)$/);
      if (msgDelMatch && method === 'DELETE') return handleDeleteMessage(msgDelMatch[1], request, env);

      // Weight tracking
      if (path === '/api/weight' && method === 'POST')   return handleLogWeight(request, env);
      if (path === '/api/weight' && method === 'GET')    return handleGetWeightLogs(request, env);
      const wtDelMatch = path.match(/^\/api\/weight\/([^/]+)$/);
      if (wtDelMatch && method === 'DELETE') return handleDeleteWeightLog(wtDelMatch[1], request, env);

      // Custom foods
      if (path === '/api/foods' && method === 'GET')  return handleGetCustomFoods(request, env);
      if (path === '/api/foods' && method === 'POST') return handleAddCustomFood(request, env);
      const foodDelMatch = path.match(/^\/api\/foods\/([^/]+)$/);
      if (foodDelMatch && method === 'DELETE') return handleDeleteCustomFood(foodDelMatch[1], request, env);

      // Custom recipes
      if (path === '/api/recipes' && method === 'GET')  return handleGetRecipes(request, env);
      if (path === '/api/recipes' && method === 'POST') return handleAddRecipe(request, env);
      const recipeDelMatch = path.match(/^\/api\/recipes\/([^/]+)$/);
      if (recipeDelMatch && method === 'DELETE') return handleDeleteRecipe(recipeDelMatch[1], request, env);

      // Meal planning
      if (path === '/api/meal-plan/generate' && method === 'POST') return handleGenerateMealPlan(request, env);
      if (path === '/api/meal-plan' && method === 'GET')           return handleGetSavedPlan(request, env);

      // Data export and account deletion
      if (path === '/api/account/export' && method === 'GET')  return handleDataExport(request, env);
      if (path === '/api/account/delete' && method === 'POST') return handleDeleteAccount(request, env);

      // Referral landing lookup (public — no auth)
      if (path === '/api/referral/lookup' && method === 'GET') return handleRefLookup(request, env);

      // Referral system
      if (path === '/api/referral/code' && method === 'GET')   return handleGetRefCode(request, env);
      if (path === '/api/referral/click' && method === 'POST') return handleRefClick(request, env);
      if (path === '/api/referral/signup' && method === 'POST') return handleRefSignup(request, env);
      if (path === '/api/referral/stats' && method === 'GET')  return handleGetRefStats(request, env);

      // Privacy settings
      if (path === '/api/privacy' && method === 'GET')  return handleGetPrivacy(request, env);
      if (path === '/api/privacy' && method === 'PUT')  return handleUpdatePrivacy(request, env);

      // Profile visit notifications
      if (path === '/api/visits' && method === 'GET')   return handleGetVisitNotifications(request, env);
      if (path === '/api/visits/read' && method === 'POST') return handleMarkVisitsRead(request, env);

      // Override followers/following with privacy-aware versions
      const privFollowMatch = path.match(/^\/api\/users\/([^/]+)\/(followers|following)$/);
      if (privFollowMatch) {
        const targetId     = privFollowMatch[1];
        const type         = privFollowMatch[2];
        const currentUserId = await getSession(request, env);
        if (type === 'followers') return handleGetFollowersPrivate(targetId, currentUserId, env);
        if (type === 'following') return handleGetFollowingPrivate(targetId, currentUserId, env);
      }

      // ── ADMIN ROUTES (/admin/*) ────────────────────────────────────────────
      if (path === '/admin/setup'  && method === 'POST') return handleAdminSetup(request, env);
      if (path === '/admin/login'  && method === 'POST') return handleAdminLogin(request, env);
      if (path === '/admin/me/password' && method === 'PUT') return handleAdminChangePassword(request, env);
      if (path === '/admin/stats'  && method === 'GET') {await requireAdmin(request,env,'analytics_view');return handleAdminStats(request,env);}
      if (path === '/admin/users'  && method === 'GET') {await requireAdmin(request,env,'users_view');return handleAdminListUsers(url,env);}
      if (path === '/admin/posts'  && method === 'GET') {await requireAdmin(request,env,'posts_view');return handleAdminListPosts(url,env);}
      if (path === '/admin/squads' && method === 'GET') {await requireAdmin(request,env,'squads_view');return handleAdminListSquads(url,env);}
      if (path === '/admin/overrides' && method === 'GET') {await requireAdmin(request,env,'handle_manage');return handleAdminListOverrides(env);}
      if (path === '/admin/overrides' && method === 'POST') return handleAdminAddOverride(request,env);
      if (path === '/admin/admins' && method === 'GET')  return handleAdminListAdmins(request,env);
      if (path === '/admin/admins' && method === 'POST') return handleAdminCreateAdmin(request,env);
      if (path === '/admin/audit'  && method === 'GET') {await requireAdmin(request,env,null);return handleAdminAuditLog(url,env);}
      if (path === '/admin/compliance/lookup' && method === 'POST') return handleComplianceLookup(request, env);
      if (path === '/admin/compliance' && method === 'GET') {await requireAdmin(request,env,'admin_manage');return handleComplianceList(url,env);}

      const adminUserMatch  = path.match(/^\/admin\/users\/([^/]+)(\/suspend|\/restore|\/delete)?$/);
      if (adminUserMatch) {
        const uid2 = adminUserMatch[1], sub = adminUserMatch[2], reqBody = method === 'POST'||method==='DELETE';
        if (sub === '/suspend' && method === 'POST') return handleAdminSuspendUser(uid2,'suspend',request,env);
        if (sub === '/restore' && method === 'POST') return handleAdminSuspendUser(uid2,'restore',request,env);
        if (sub === '/delete'  && method === 'DELETE') return handleAdminDeleteUser(uid2,request,env);
      }

      const adminPostMatch = path.match(/^\/admin\/posts\/([^/]+)(\/archive|\/delete)?$/);
      if (adminPostMatch) {
        const pid = adminPostMatch[1], sub = adminPostMatch[2];
        if (sub === '/archive' && method === 'POST') return handleAdminArchivePost(pid,request,env);
        if (sub === '/delete'  && method === 'DELETE') return handleAdminDeletePost(pid,request,env);
      }

      const adminSquadMatch = path.match(/^\/admin\/squads\/([^/]+)$/);
      if (adminSquadMatch) {
        if (method === 'PUT')    return handleAdminEditSquad(adminSquadMatch[1],request,env);
        if (method === 'DELETE') return handleAdminDeleteSquad(adminSquadMatch[1],request,env);
      }

      const adminOverrideMatch = path.match(/^\/admin\/overrides\/([^/]+)$/);
      if (adminOverrideMatch && method === 'DELETE') return handleAdminDeleteOverride(adminOverrideMatch[1],request,env);

      const adminPermsMatch = path.match(/^\/admin\/admins\/([^/]+)\/permissions$/);
      if (adminPermsMatch && method === 'PUT') return handleAdminUpdatePermissions(adminPermsMatch[1],request,env);

      const adminSuspendMatch = path.match(/^\/admin\/admins\/([^/]+)\/suspend$/);
      if (adminSuspendMatch && method === 'POST') return handleAdminToggleSuspend(adminSuspendMatch[1],request,env);

      // Posts
      if (path === '/api/posts' && method === 'POST') return handleCreatePost(request, env);
      if (path === '/api/posts/feed' && method === 'GET') return handleGetFeed(request, env);
      if (path === '/api/posts/archived' && method === 'GET') return handleGetArchivedPosts(request, env);
      if (path === '/api/reactions' && method === 'POST') return handleReaction(request, env);
      const postDeleteMatch = path.match(/^\/api\/posts\/([^/]+)$/);
      if (postDeleteMatch && method === 'DELETE') return handleDeletePost(postDeleteMatch[1], request, env);
      const profilePostsMatch = path.match(/^\/api\/users\/([^/]+)\/posts$/);
      if (profilePostsMatch && method === 'GET') {
        const currentUserId = await getSession(request, env);
        const page = parseInt(new URL(request.url).searchParams.get('page')||'0');
        return handleGetProfilePosts(profilePostsMatch[1], currentUserId, page, env);
      }

      // Water tracking
      if (path === '/api/water' && method === 'POST') return handleLogWater(request, env);
      if (path === '/api/water' && method === 'GET') {
        const userId = await requireAuth(request, env);
        return handleGetWater(userId, env);
      }

      // Nutrition label scan
      if (path === '/api/scan/label' && method === 'POST') return handleLabelScan(request, env);
      if (path === '/api/scan/text' && method === 'POST') return handleTextScan(request, env);
      if (path === '/api/ai/test' && method === 'GET') {
        if (!env.AI) return err('AI binding missing', 500);
        const out = { ok: true, binding: 'AI binding present' };
        // Vision test: fetch a real photo and ask the model what it sees
        try {
          const imgResp = await fetch('https://cataas.com/cat');
          const buf = await imgResp.arrayBuffer();
          const bytes = [...new Uint8Array(buf)];
          // Try llama-3.2-11b-vision
          try {
            const llamaRes = await env.AI.run('@cf/meta/llama-3.2-11b-vision-instruct', {
              prompt: 'What animal is in this image? Answer in one word.',
              image: bytes, max_tokens: 50,
            });
            out.llama_vision = (llamaRes.response || llamaRes.description || JSON.stringify(llamaRes)).substring(0, 200);
          } catch (e1) { out.llama_vision_error = String(e1 && e1.message || e1); }
          // Try llava-1.5-7b as comparison
          try {
            const llavaRes = await env.AI.run('@cf/llava-hf/llava-1.5-7b-hf', {
              prompt: 'What animal is in this image? Answer in one word.',
              image: bytes, max_tokens: 50,
            });
            out.llava_vision = (llavaRes.description || llavaRes.response || JSON.stringify(llavaRes)).substring(0, 200);
          } catch (e2) { out.llava_vision_error = String(e2 && e2.message || e2); }
        } catch (e) {
          out.image_fetch_error = String(e && e.message || e);
        }
        return json(out);
      }

            return new Response('Not found', { status: 404, headers: CORS });
    } catch (e) {
      const status = e.status || 500;
      console.error(e.message);
      return err(status === 500 ? 'Internal server error' : e.message, status);
    }
  },
};
