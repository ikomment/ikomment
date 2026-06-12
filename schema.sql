-- iKomment — privacy-first comments, Q&A & forums · https://ikomment.com
-- ============================================================
-- iKomment — D1 Database Schema (Stage 1)
-- One schema powers all three modules: Comments, Q&A, Forums
-- ============================================================

-- ------------------------------------------------------------
-- SITES — every website using iKomment
-- ------------------------------------------------------------
CREATE TABLE sites (
    id TEXT PRIMARY KEY,                -- short unique site key, e.g. "abc123" (goes in the embed tag)
    owner_email TEXT NOT NULL,          -- the site owner's login email
    owner_password_hash TEXT,           -- PBKDF2 hash for dashboard login (Option B)
    owner_salt TEXT,                    -- per-account random salt
    name TEXT NOT NULL,                 -- display name, e.g. "My Travel Blog"
    domain TEXT NOT NULL,               -- e.g. "mytravelblog.com" (used to verify embeds)
    custom_domain TEXT,                 -- optional vanity domain (Cloud plan)
    plan TEXT NOT NULL DEFAULT 'self',  -- 'self' or 'cloud'
    admin_key TEXT NOT NULL,            -- secret master key for moderation/admin API (Option A)
    created_at INTEGER NOT NULL,        -- unix timestamp
    pageviews_month INTEGER DEFAULT 0,  -- usage counter for the 500k Cloud limit
    pageviews_reset_at INTEGER          -- when the monthly counter resets
);

-- ------------------------------------------------------------
-- SITE SETTINGS — the Feature Control Panel toggles
-- One row per site. Every toggle is a column with a sane default.
-- ------------------------------------------------------------
CREATE TABLE site_settings (
    site_id TEXT PRIMARY KEY REFERENCES sites(id),

    -- Module master switches
    module_comments INTEGER DEFAULT 1,      -- 1 = on, 0 = off
    module_qa INTEGER DEFAULT 1,
    module_forums INTEGER DEFAULT 1,
    module_chat INTEGER DEFAULT 1,

    -- Comment features
    voting INTEGER DEFAULT 1,
    edit_own INTEGER DEFAULT 1,
    edit_window_minutes INTEGER DEFAULT 15,
    delete_own INTEGER DEFAULT 1,
    markdown INTEGER DEFAULT 1,
    formatting_toolbar INTEGER DEFAULT 0,   -- B/i/code/link buttons in composer (off by default)
    sorting INTEGER DEFAULT 1,
    pinned_comments INTEGER DEFAULT 1,
    flagging INTEGER DEFAULT 1,
    count_badge INTEGER DEFAULT 1,

    -- Identity options
    guest_posting INTEGER DEFAULT 0,        -- OFF by default; enabling requires typed confirmation in dashboard
    guest_recognition INTEGER DEFAULT 1,
    login_magic_link INTEGER DEFAULT 0,     -- email login; OFF until email sending is configured
    email_provider TEXT DEFAULT 'resend',   -- 'resend' | 'sendgrid' (key itself is a deployment secret)
    login_google INTEGER DEFAULT 1,
    login_github INTEGER DEFAULT 1,
    login_sso INTEGER DEFAULT 0,            -- off until owner configures it
    sso_secret TEXT,                        -- HMAC key for SSO (generated when enabled)

    -- Moderation
    ai_spam INTEGER DEFAULT 1,
    pre_moderation INTEGER DEFAULT 1,       -- on by default for new sites
    email_moderation INTEGER DEFAULT 0,     -- OFF by default; enabling requires typed confirmation
    word_filter INTEGER DEFAULT 1,
    trust_levels INTEGER DEFAULT 1,

    -- Display & misc
    theme_mode TEXT DEFAULT 'auto',         -- 'auto' | 'dark' | 'light'
    accent_color TEXT DEFAULT '#4f7cff',
    font TEXT DEFAULT 'inherit',            -- inherit host site font by default
    corner_radius INTEGER DEFAULT 8,        -- px
    lazy_loading INTEGER DEFAULT 1,
    reply_notifications INTEGER DEFAULT 1,
    live_updates INTEGER DEFAULT 1
);

-- ------------------------------------------------------------
-- PAGES — every page on a site where the widget appears.
-- Also stores per-page overrides (NULL = follow site default).
-- ------------------------------------------------------------
CREATE TABLE pages (
    id TEXT PRIMARY KEY,
    site_id TEXT NOT NULL REFERENCES sites(id),
    url TEXT NOT NULL,                  -- the page URL (normalised)
    title TEXT,                         -- page title, captured on first load
    first_seen INTEGER NOT NULL,

    -- Per-page overrides: NULL means "use site default"
    override_comments INTEGER,          -- 0/1 or NULL
    override_qa INTEGER,
    override_voting INTEGER,
    override_guest_posting INTEGER,
    override_pre_moderation INTEGER,

    UNIQUE(site_id, url)
);

-- ------------------------------------------------------------
-- USERS — anyone who participates (guest or registered)
-- ------------------------------------------------------------
CREATE TABLE users (
    id TEXT PRIMARY KEY,
    site_id TEXT NOT NULL REFERENCES sites(id),  -- users belong to a site (like FastComments SSO isolation)
    display_name TEXT NOT NULL,
    email TEXT,                          -- NULL for pure guests
    avatar_url TEXT,
    kind TEXT NOT NULL DEFAULT 'guest',  -- 'guest' | 'google' | 'github' | 'sso'
    external_id TEXT,                    -- Google/GitHub/SSO id when applicable
    guest_token TEXT,                    -- auth token for ALL kinds (guests + logged-in sessions)
    trust_level INTEGER DEFAULT 0,       -- 0 new → rises with good behaviour; auto-approve at 2+
    is_shadow_banned INTEGER DEFAULT 0,
    is_moderator INTEGER DEFAULT 0,
    created_at INTEGER NOT NULL,
    last_seen INTEGER
);

CREATE INDEX idx_users_site ON users(site_id);
CREATE INDEX idx_users_guest_token ON users(guest_token);

-- ------------------------------------------------------------
-- THREADS — a discussion container.
-- A blog post's comment section, a Q&A question, or a forum topic
-- are all "threads" of different types. One engine, three modules.
-- ------------------------------------------------------------
CREATE TABLE threads (
    id TEXT PRIMARY KEY,
    site_id TEXT NOT NULL REFERENCES sites(id),
    page_id TEXT REFERENCES pages(id),   -- which page it lives on (NULL for forum threads)
    category_id TEXT,                    -- forum category (NULL for comments/Q&A)
    type TEXT NOT NULL,                  -- 'comments' | 'question' | 'forum'
    title TEXT,                          -- question title / forum topic title (NULL for comment sections)
    author_id TEXT REFERENCES users(id), -- who started it (NULL for auto-created comment sections)
    is_pinned INTEGER DEFAULT 0,         -- sticky forum threads
    is_locked INTEGER DEFAULT 0,         -- read-only
    is_answered INTEGER DEFAULT 0,       -- Q&A: has an accepted answer
    accepted_post_id TEXT,               -- Q&A: which answer was accepted
    post_count INTEGER DEFAULT 0,        -- cached for fast thread lists
    last_activity INTEGER,               -- cached for sorting thread lists
    created_at INTEGER NOT NULL
);

CREATE INDEX idx_threads_site_type ON threads(site_id, type);
CREATE INDEX idx_threads_category ON threads(category_id, last_activity);

-- ------------------------------------------------------------
-- CATEGORIES — forum boards (General, Support, Ideas...)
-- ------------------------------------------------------------
CREATE TABLE categories (
    id TEXT PRIMARY KEY,
    site_id TEXT NOT NULL REFERENCES sites(id),
    name TEXT NOT NULL,
    description TEXT,
    position INTEGER DEFAULT 0,          -- display order
    chat_enabled INTEGER DEFAULT 1       -- live chat room for this category
);

-- ------------------------------------------------------------
-- POSTS — every comment, answer, and forum reply.
-- parent_id makes unlimited nesting possible.
-- ------------------------------------------------------------
CREATE TABLE posts (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL REFERENCES threads(id),
    site_id TEXT NOT NULL REFERENCES sites(id),
    author_id TEXT NOT NULL REFERENCES users(id),
    parent_id TEXT REFERENCES posts(id), -- NULL = top level; otherwise it's a reply
    kind TEXT NOT NULL DEFAULT 'comment',-- 'comment' | 'answer'  (answers only in Q&A threads)
    body TEXT NOT NULL,                  -- the raw markdown text
    body_html TEXT,                      -- pre-rendered HTML (served instantly from cache)
    status TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'approved' | 'spam' | 'deleted'
    is_pinned INTEGER DEFAULT 0,
    up_votes INTEGER DEFAULT 0,          -- cached counters for speed
    down_votes INTEGER DEFAULT 0,
    depth INTEGER DEFAULT 0,             -- nesting level, cached for rendering
    created_at INTEGER NOT NULL,
    edited_at INTEGER
);

CREATE INDEX idx_posts_thread ON posts(thread_id, status, created_at);
CREATE INDEX idx_posts_author ON posts(author_id);
CREATE INDEX idx_posts_parent ON posts(parent_id);

-- ------------------------------------------------------------
-- VOTES — one row per user per post (prevents double-voting)
-- ------------------------------------------------------------
CREATE TABLE votes (
    post_id TEXT NOT NULL REFERENCES posts(id),
    user_id TEXT NOT NULL REFERENCES users(id),
    value INTEGER NOT NULL,              -- 1 = up, -1 = down
    created_at INTEGER NOT NULL,
    PRIMARY KEY (post_id, user_id)
);

-- ------------------------------------------------------------
-- FLAGS — user reports on posts
-- ------------------------------------------------------------
CREATE TABLE flags (
    id TEXT PRIMARY KEY,
    post_id TEXT NOT NULL REFERENCES posts(id),
    reporter_id TEXT REFERENCES users(id),
    reason TEXT,
    created_at INTEGER NOT NULL,
    resolved INTEGER DEFAULT 0
);

-- ------------------------------------------------------------
-- WORD FILTERS — banned words per site
-- ------------------------------------------------------------
CREATE TABLE word_filters (
    site_id TEXT NOT NULL REFERENCES sites(id),
    word TEXT NOT NULL,
    action TEXT DEFAULT 'hold',          -- 'hold' (send to moderation) | 'block' (reject outright)
    PRIMARY KEY (site_id, word)
);

-- ------------------------------------------------------------
-- CHAT MESSAGES — live chat history per forum category.
-- (Real-time delivery happens via Durable Objects; this table
--  is the permanent record so history survives.)
-- ------------------------------------------------------------
CREATE TABLE chat_messages (
    id TEXT PRIMARY KEY,
    category_id TEXT NOT NULL REFERENCES categories(id),
    site_id TEXT NOT NULL REFERENCES sites(id),
    author_id TEXT NOT NULL REFERENCES users(id),
    body TEXT NOT NULL,
    created_at INTEGER NOT NULL
);

CREATE INDEX idx_chat_category ON chat_messages(category_id, created_at);

-- ------------------------------------------------------------
-- MAGIC LINKS — email login tokens.
-- request_id lets the widget poll "has my link been clicked yet?"
-- so sign-in completes even if the email is opened on another device.
-- ------------------------------------------------------------
CREATE TABLE magic_links (
    token TEXT PRIMARY KEY,             -- secret in the emailed link
    request_id TEXT NOT NULL,           -- secret the waiting widget polls with
    site_id TEXT NOT NULL REFERENCES sites(id),
    email TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    used INTEGER DEFAULT 0,
    user_id TEXT,                       -- filled in once verified
    user_token TEXT                     -- credential handed to the widget
);
CREATE INDEX idx_magic_request ON magic_links(request_id);

-- ------------------------------------------------------------
-- MOD ACTIONS — audit trail of every moderation action
-- (shadow bans, nukes, approvals — accountability built in)
-- ------------------------------------------------------------
CREATE TABLE mod_actions (
    id TEXT PRIMARY KEY,
    site_id TEXT NOT NULL REFERENCES sites(id),
    moderator_id TEXT,                   -- NULL when the AI did it
    action TEXT NOT NULL,                -- 'approve' | 'spam' | 'shadow_ban' | 'nuke' | 'pin' | ...
    target_post_id TEXT,
    target_user_id TEXT,
    created_at INTEGER NOT NULL
);
