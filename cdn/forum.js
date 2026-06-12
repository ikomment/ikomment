/* ============================================================
   iKomment — Forums Module (forum.js)
   Loaded on demand by i.js for pages with data-module="forum".
   Views: categories → thread list (+ live chat tab) → thread.
   ============================================================ */
(function () {
  "use strict";
  window.iKomment = window.iKomment || {};

  var CSS = "" +
".ikw .ik-crumb{display:flex;gap:.4rem;align-items:center;color:var(--ik-soft);font-size:.85rem;margin-bottom:.8rem;flex-wrap:wrap}" +
".ikw .ik-crumb button{color:var(--ik-accent);font-weight:600;padding:.3rem .2rem;min-height:2rem}" +
".ikw .ik-cat{border:1px solid var(--ik-line);border-radius:var(--ik-r);padding:.9rem 1rem;margin-bottom:.6rem;cursor:pointer;display:flex;gap:.8rem;align-items:center}" +
".ikw .ik-cat:hover{border-color:var(--ik-accent)}" +
".ikw .ik-cat-i{flex:1;min-width:0}" +
".ikw .ik-cat-n{font-weight:700}" +
".ikw .ik-cat-d{color:var(--ik-soft);font-size:.85rem;margin-top:.1rem}" +
".ikw .ik-cat-c{color:var(--ik-soft);font-size:.8rem;white-space:nowrap}" +
".ikw .ik-th{border:1px solid var(--ik-line);border-radius:var(--ik-r);padding:.7rem .9rem;margin-bottom:.5rem;cursor:pointer;display:flex;gap:.6rem;align-items:center}" +
".ikw .ik-th:hover{border-color:var(--ik-accent)}" +
".ikw .ik-th-i{flex:1;min-width:0}" +
".ikw .ik-th-t{font-weight:600;font-size:.95rem;overflow-wrap:anywhere}" +
".ikw .ik-th-m{color:var(--ik-soft);font-size:.78rem;margin-top:.1rem}" +
".ikw .ik-th-c{color:var(--ik-soft);font-size:.82rem;white-space:nowrap}" +
".ikw .ik-tabs{display:flex;gap:.2rem;border-bottom:1px solid var(--ik-line);margin-bottom:.9rem}" +
".ikw .ik-tabs button{padding:.5rem .9rem;color:var(--ik-soft);font-size:.9rem;border-bottom:2px solid transparent;min-height:2.6rem}" +
".ikw .ik-tabs button.ik-on{color:var(--ik-accent);border-bottom-color:var(--ik-accent);font-weight:600}" +
".ikw .ik-newt{margin:.6rem 0 1rem}" +
".ikw .ik-title-in{width:100%;border:1px solid var(--ik-line);border-radius:6px;background:transparent;color:inherit;padding:.55rem .7rem;font-size:1rem;font-weight:600;margin-bottom:.5rem}" +
".ikw .ik-chat{display:flex;flex-direction:column;height:380px;border:1px solid var(--ik-line);border-radius:var(--ik-r)}" +
".ikw .ik-chat-log{flex:1;overflow-y:auto;padding:.8rem;display:flex;flex-direction:column;gap:.45rem}" +
".ikw .ik-msg{font-size:.9rem;line-height:1.45;overflow-wrap:anywhere}" +
".ikw .ik-msg b{color:var(--ik-accent)}" +
".ikw .ik-msg .ik-when{color:var(--ik-soft);font-size:.72rem;margin-left:.35rem}" +
".ikw .ik-chat-in{display:flex;gap:.5rem;border-top:1px solid var(--ik-line);padding:.6rem}" +
".ikw .ik-chat-in input{flex:1;border:1px solid var(--ik-line);border-radius:6px;background:transparent;color:inherit;padding:.5rem .7rem;font-size:1rem;min-height:44px}" +
".ikw .ik-presence{color:var(--ik-soft);font-size:.78rem;padding:.4rem .8rem;border-bottom:1px solid var(--ik-line)}" +
".ikw .ik-prof{position:fixed;inset:0;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;padding:1rem;z-index:99}" +
".ikw .ik-prof-card{background:#1d2026;color:#e7e9ee;border:1px solid rgba(160,165,180,.25);border-radius:12px;padding:1.2rem;width:100%;max-width:340px}" +
".ikw .ik-prof-card .ik-av{width:3rem;height:3rem;font-size:1.2rem;margin-bottom:.5rem}" +
".ikw .ik-prof-card h4{margin:0 0 .15rem}" +
".ikw .ik-prof-card .ik-since{color:#9aa1ad;font-size:.8rem;margin-bottom:.7rem}" +
".ikw .ik-prof-card .ik-rp{font-size:.82rem;color:#cfd3da;border-top:1px solid rgba(160,165,180,.2);padding:.45rem 0}" +
".ikw .ik-lock-note{color:var(--ik-soft);font-size:.85rem;text-align:center;padding:.8rem;border:1px dashed var(--ik-line);border-radius:var(--ik-r)}" +
".ikw.ik-sm .ik-chat{height:320px}" +
".ikw.ik-xs .ik-cat,.ikw.ik-xs .ik-th{padding:.6rem .7rem}";

  var BASE_CSS = "" +
".ikw{--ik-accent:#4f7cff;--ik-fg:#1a1d23;--ik-soft:#6b7280;--ik-line:rgba(128,128,140,.22);--ik-card:rgba(128,128,140,.07);--ik-r:8px;font:inherit;color:var(--ik-fg)}" +
".ikw.ik-dark{--ik-fg:#e7e9ee;--ik-soft:#9aa1ad;--ik-line:rgba(160,165,180,.22);--ik-card:rgba(160,165,180,.09)}" +
".ikw *{box-sizing:border-box;margin:0}.ikw button{font:inherit;color:inherit;background:none;border:0;cursor:pointer}" +
".ikw .ik-compose{border:1px solid var(--ik-line);border-radius:var(--ik-r);background:var(--ik-card);padding:.65rem .8rem}" +
".ikw .ik-input{width:100%;border:0;outline:0;background:transparent;color:inherit;font:inherit;font-size:1rem;resize:vertical;min-height:1.6em}" +
".ikw .ik-compose.ik-open .ik-input{min-height:4.5em}" +
".ikw .ik-bar{display:none;gap:.5rem;flex-wrap:wrap;margin-top:.55rem;align-items:center}" +
".ikw .ik-compose.ik-open .ik-bar{display:flex}" +
".ikw .ik-compose.ik-always .ik-bar{display:flex}" +
".ikw .ik-name{flex:1;min-width:8rem;border:1px solid var(--ik-line);border-radius:6px;background:transparent;color:inherit;padding:.45rem .6rem;font-size:1rem}" +
".ikw .ik-send{margin-left:auto;background:var(--ik-accent);color:#fff;border-radius:6px;padding:.5rem 1.1rem;font-weight:600;min-height:2.6rem}" +
".ikw .ik-av{width:2rem;height:2rem;border-radius:50%;background:var(--ik-accent);color:#fff;display:flex;align-items:center;justify-content:center;font-size:.8rem;font-weight:700;flex-shrink:0;cursor:pointer}" +
".ikw .ik-meta{display:flex;gap:.5rem;align-items:baseline;font-size:.82rem;flex-wrap:wrap}" +
".ikw .ik-who{font-weight:600;cursor:pointer}.ikw .ik-when{color:var(--ik-soft)}" +
".ikw .ik-text{margin:.2rem 0 .3rem;line-height:1.55;font-size:.95rem;overflow-wrap:anywhere}" +
".ikw .ik-acts{display:flex;gap:.15rem;color:var(--ik-soft);font-size:.82rem;flex-wrap:wrap;align-items:center}" +
".ikw .ik-acts button{padding:.35rem .5rem;border-radius:6px;min-height:2rem}" +
".ikw .ik-acts .ik-voted{color:var(--ik-accent);font-weight:600}" +
".ikw .ik-c{display:flex;gap:.6rem;padding:.5rem 0}" +
".ikw .ik-body{flex:1;min-width:0}" +
".ikw .ik-pending{opacity:.65}" +
".ikw .ik-tag{font-size:.72rem;background:var(--ik-card);color:var(--ik-soft);border-radius:99px;padding:.1rem .55rem}" +
".ikw .ik-empty{color:var(--ik-soft);text-align:center;padding:1.2rem 0;font-size:.92rem}" +
".ikw .ik-foot{margin-top:1rem;padding-top:.6rem;border-top:1px solid var(--ik-line);text-align:right}" +
".ikw .ik-foot a{color:var(--ik-soft);font-size:.72rem;text-decoration:none}" +
".ikw .ik-login{display:flex;align-items:center;gap:.4rem;flex-wrap:wrap}" +
".ikw .ik-login-lbl{color:var(--ik-soft);font-size:.82rem}" +
".ikw .ik-oauth{border:1px solid var(--ik-line);border-radius:6px;padding:.45rem .8rem;min-height:2.4rem;font-size:.85rem;font-weight:600}";

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function ago(ts) {
    var s = Math.max(1, Math.floor(Date.now() / 1000 - ts));
    if (s < 60) return "just now";
    if (s < 3600) return Math.floor(s / 60) + "m ago";
    if (s < 86400) return Math.floor(s / 3600) + "h ago";
    return Math.floor(s / 86400) + "d ago";
  }
  var mem = {};
  function store(k, v) { try { localStorage.setItem(k, v); } catch (e) { mem[k] = v; } }
  function read(k) { try { return localStorage.getItem(k) || mem[k]; } catch (e) { return mem[k]; } }

  function api(base, site, method, path, body, qs) {
    if (window.iKommentTransport)
      return window.iKommentTransport(method, path, body, qs);
    var url = base.replace(/\/cdn$/, "") + "/api/" + path +
      (qs ? "?" + new URLSearchParams(Object.assign({ site: site }, qs)) : "");
    var headers = { "content-type": "application/json" };
    var id = read("ik_id_" + site);
    if (id) headers["x-ikomment-user"] = id;
    if (window.iKommentSSO) headers["x-ikomment-sso"] = window.iKommentSSO;
    return fetch(url, {
      method: method, headers: headers,
      body: body ? JSON.stringify(Object.assign({ site: site }, body)) : undefined,
    }).then(function (r) { return r.json(); });
  }

  function Widget(node, cfg) {
    var SITE = cfg.site, BASE = cfg.base;
    var state = { view: "cats", cats: [], cat: null, threads: [], thread: null,
                  posts: [], settings: {}, myVotes: {}, tab: "threads" };
    var ws = null;

    if (!document.getElementById("ik-css")) {
      var b = el("style"); b.id = "ik-css"; b.textContent = BASE_CSS;
      document.head.appendChild(b);
    } else {
      // comments.js base exists but lacks .ik-always — add it
      var extra = el("style"); extra.textContent = ".ikw .ik-compose.ik-always .ik-bar{display:flex}";
      document.head.appendChild(extra);
    }
    if (!document.getElementById("ik-forum-css")) {
      var st = el("style"); st.id = "ik-forum-css"; st.textContent = CSS;
      document.head.appendChild(st);
    }

    var root = el("div", "ikw");
    node.appendChild(root);

    function applyTheme(mode) {
      var dark;
      if (mode === "dark") dark = true;
      else if (mode === "light") dark = false;
      else {
        var bg = getComputedStyle(document.body).backgroundColor.match(/\d+/g) || [255, 255, 255];
        dark = (+bg[0] * 299 + +bg[1] * 587 + +bg[2] * 114) / 1000 < 128;
      }
      root.classList.toggle("ik-dark", dark);
    }
    new ResizeObserver(function (en) {
      var w = en[0].contentRect.width;
      root.classList.toggle("ik-md", w <= 900);
      root.classList.toggle("ik-sm", w <= 600);
      root.classList.toggle("ik-xs", w <= 480);
    }).observe(root);


    function emailBtn(bar) {
      var b = el("button", "ik-oauth", "Email");
      b.type = "button";
      b.onclick = function () {
        var row = el("div", "ik-login");
        var inp = document.createElement("input");
        inp.className = "ik-name"; inp.type = "email"; inp.placeholder = "you@example.com";
        var go = el("button", "ik-oauth", "Send link"); go.type = "button";
        var msg = el("span", "ik-login-lbl", "");
        row.appendChild(inp); row.appendChild(go); row.appendChild(msg);
        bar.replaceChild(row, b.parentNode === bar ? b : b);
        inp.focus();
        go.onclick = function () {
          var em = inp.value.trim();
          if (!em) { inp.focus(); return; }
          go.disabled = true; msg.textContent = "Sending\u2026";
          api(BASE, SITE, "POST", "auth/email/request", { email: em }).then(function (r) {
            if (r.error) { msg.textContent = r.error; go.disabled = false; return; }
            msg.textContent = "Check your inbox \u2014 waiting\u2026";
            inp.disabled = true; go.style.display = "none";
            var tries = 0;
            var poll = setInterval(function () {
              if (tries++ > 100) { clearInterval(poll); msg.textContent = "Link expired \u2014 try again."; return; }
              api(BASE, SITE, "GET", "auth/email/status", null, { r: r.request_id }).then(function (st) {
                if (st.status === "done") {
                  clearInterval(poll);
                  store("ik_id_" + SITE, st.identity.user_id + ":" + st.identity.token);
                  store("ik_name_" + SITE, st.identity.name);
                  render();
                } else if (st.status === "expired") {
                  clearInterval(poll); msg.textContent = "Link expired \u2014 try again.";
                }
              });
            }, 3000);
          });
        };
      };
      return b;
    }

    function oauthBtn(provider, label) {
      var b = el("button", "ik-oauth", label);
      b.type = "button";
      b.onclick = function () {
        window.open(BASE.replace(/\/cdn$/, "") + "/api/auth/" + provider + "?site=" + SITE,
          "ik-login", "width=480,height=640");
      };
      return b;
    }
    window.addEventListener("message", function (e) {
      var d = e.data;
      if (!d || d.type !== "ikomment-auth") return;
      store("ik_id_" + SITE, d.user_id + ":" + d.token);
      store("ik_name_" + SITE, d.name);
      render();
    });

    /* ---------- profile overlay ---------- */
    function showProfile(userId) {
      api(BASE, SITE, "GET", "profile", null, { user_id: userId }).then(function (r) {
        if (r.error) return;
        var p = r.profile;
        var bg = el("div", "ik-prof");
        var card = el("div", "ik-prof-card");
        card.appendChild(el("div", "ik-av", (p.name || "?").slice(0, 1).toUpperCase()));
        var h = el("h4", null, p.name); card.appendChild(h);
        card.appendChild(el("div", "ik-since", "Member since " +
          new Date(p.member_since * 1000).toLocaleDateString()));
        (p.recent || []).forEach(function (rp) {
          var row = el("div", "ik-rp");
          row.innerHTML = (rp.thread_title ? "<b>" + rp.thread_title.replace(/</g, "&lt;") + "</b> · " : "") + rp.body_html;
          card.appendChild(row);
        });
        bg.appendChild(card);
        bg.onclick = function (e) { if (e.target === bg) bg.remove(); };
        root.appendChild(bg);
      });
    }

    /* ---------- generic identity-aware compose bar ---------- */
    function identityBar(bar, name, send) {
      var identified = !!read("ik_id_" + SITE) || !!window.iKommentSSO;
      var canGuest = state.settings.guest_posting === 1;
      if (!identified) {
        if (state.settings.login_google === 1 || state.settings.login_github === 1 || state.settings.login_magic_link === 1) {
          var login = el("div", "ik-login");
          login.appendChild(el("span", "ik-login-lbl", canGuest ? "or sign in:" : "Sign in to post:"));
          if (state.settings.login_google === 1) login.appendChild(oauthBtn("google", "Google"));
          if (state.settings.login_github === 1) login.appendChild(oauthBtn("github", "GitHub"));
          if (state.settings.login_magic_link === 1) login.appendChild(emailBtn(login));
          bar.appendChild(login);
        }
        if (canGuest) bar.appendChild(name);
      }
      if (identified || canGuest) bar.appendChild(send);
      return identified || canGuest;
    }

    /* ============ VIEW: categories ============ */
    function renderCats() {
      root.textContent = "";
      applyTheme(state.settings.theme_mode);
      if (state.settings.accent_color)
        root.style.setProperty("--ik-accent", state.settings.accent_color);
      if (!state.cats.length) {
        root.appendChild(el("div", "ik-empty", "No forum categories yet."));
      }
      state.cats.forEach(function (c) {
        var row = el("div", "ik-cat");
        var i = el("div", "ik-cat-i");
        i.appendChild(el("div", "ik-cat-n", c.name));
        if (c.description) i.appendChild(el("div", "ik-cat-d", c.description));
        row.appendChild(i);
        row.appendChild(el("div", "ik-cat-c",
          (c.thread_count || 0) + " thread" + (c.thread_count !== 1 ? "s" : "")));
        row.onclick = function () { openCat(c); };
        root.appendChild(row);
      });
      foot();
    }

    /* ============ VIEW: thread list + chat tab ============ */
    function openCat(c) {
      state.cat = c; state.view = "threads"; state.tab = "threads";
      api(BASE, SITE, "GET", "forum/threads", null, { category: c.id }).then(function (r) {
        state.threads = r.threads || [];
        renderThreads();
      });
    }

    function renderThreads() {
      root.textContent = "";
      closeChat();
      var crumb = el("div", "ik-crumb");
      var back = el("button", null, "← Forums");
      back.onclick = function () { state.view = "cats"; renderCats(); };
      crumb.appendChild(back);
      crumb.appendChild(el("span", null, "/ " + state.cat.name));
      root.appendChild(crumb);

      if (state.settings.module_chat === 1 && state.cat.chat_enabled === 1) {
        var tabs = el("div", "ik-tabs");
        [["threads", "Threads"], ["chat", "💬 Live chat"]].forEach(function (t) {
          var tb = el("button", state.tab === t[0] ? "ik-on" : "", t[1]);
          tb.onclick = function () { state.tab = t[0]; renderThreads(); };
          tabs.appendChild(tb);
        });
        root.appendChild(tabs);
      }

      if (state.tab === "chat") { renderChat(); foot(); return; }

      /* new thread composer */
      var box = el("div", "ik-compose ik-newt");
      var title = el("input", "ik-title-in"); title.placeholder = "Start a new thread — title";
      var ta = el("textarea", "ik-input"); ta.placeholder = "Say something…";
      var bar = el("div", "ik-bar");
      var name = el("input", "ik-name"); name.placeholder = "Your name";
      name.value = read("ik_name_" + SITE) || "";
      var send = el("button", "ik-send", "Post thread"); send.type = "button";
      identityBar(bar, name, send);
      box.appendChild(title); box.appendChild(ta); box.appendChild(bar);
      title.addEventListener("focus", function () { box.classList.add("ik-open"); });
      ta.addEventListener("focus", function () { box.classList.add("ik-open"); });
      send.onclick = function () {
        if (!title.value.trim() || !ta.value.trim()) return;
        var guestName = name.value.trim() || read("ik_name_" + SITE);
        var identified = !!read("ik_id_" + SITE) || !!window.iKommentSSO;
        if (!identified && !guestName) { name.focus(); return; }
        send.disabled = true;
        api(BASE, SITE, "POST", "forum/thread", {
          category_id: state.cat.id, title: title.value.trim(),
          body: ta.value.trim(), guest_name: guestName,
        }).then(function (r) {
          send.disabled = false;
          if (r.error) { alert(r.error); return; }
          if (r.identity) {
            store("ik_id_" + SITE, r.identity.user_id + ":" + r.identity.token);
            store("ik_name_" + SITE, guestName);
          }
          if (r.held_for_review) alert("Your thread was submitted and is awaiting approval.");
          openCat(state.cat); // refresh list
        });
      };
      root.appendChild(box);

      if (!state.threads.length)
        root.appendChild(el("div", "ik-empty", "No threads yet — start the first one."));
      state.threads.forEach(function (t) {
        var row = el("div", "ik-th");
        var i = el("div", "ik-th-i");
        var tt = el("div", "ik-th-t",
          (t.is_pinned ? "📌 " : "") + (t.is_locked ? "🔒 " : "") + t.title);
        i.appendChild(tt);
        i.appendChild(el("div", "ik-th-m",
          "by " + (t.author_name || "unknown") + " · active " + ago(t.last_activity)));
        row.appendChild(i);
        row.appendChild(el("div", "ik-th-c", t.post_count + " post" + (t.post_count !== 1 ? "s" : "")));
        row.onclick = function () { openThread(t); };
        root.appendChild(row);
      });
      foot();
    }

    /* ============ VIEW: one thread ============ */
    function openThread(t) {
      api(BASE, SITE, "GET", "forum/thread", null, { thread_id: t.id }).then(function (r) {
        if (r.error) { alert(r.error); return; }
        state.thread = r.thread; state.posts = r.posts || []; state.view = "thread";
        renderThread();
      });
    }

    function vote(p, v, upBtn, downBtn) {
      var prev = state.myVotes[p.id] || 0;
      var next = prev === v ? 0 : v;
      p.up_votes += (next === 1 ? 1 : 0) - (prev === 1 ? 1 : 0);
      p.down_votes += (next === -1 ? 1 : 0) - (prev === -1 ? 1 : 0);
      state.myVotes[p.id] = next;
      upBtn.textContent = "▲ " + p.up_votes; downBtn.textContent = "▼ " + p.down_votes;
      upBtn.className = next === 1 ? "ik-voted" : "";
      downBtn.className = next === -1 ? "ik-voted" : "";
      api(BASE, SITE, "POST", "vote", { post_id: p.id, value: next });
    }

    function postRow(p) {
      var c = el("div", "ik-c" + (p.status === "pending" ? " ik-pending" : ""));
      var av = el("div", "ik-av", (p.display_name || "?").slice(0, 1).toUpperCase());
      av.onclick = function () { showProfile(p.author_id); };
      var body = el("div", "ik-body");
      var meta = el("div", "ik-meta");
      var who = el("span", "ik-who", p.display_name);
      who.onclick = function () { showProfile(p.author_id); };
      meta.appendChild(who);
      meta.appendChild(el("span", "ik-when", ago(p.created_at)));
      if (p.status === "pending") meta.appendChild(el("span", "ik-tag", "Awaiting approval"));
      var text = el("div", "ik-text"); text.innerHTML = p.body_html;
      var acts = el("div", "ik-acts");
      if (state.settings.voting !== 0) {
        var up = el("button", state.myVotes[p.id] === 1 ? "ik-voted" : "", "▲ " + (p.up_votes || 0));
        var down = el("button", state.myVotes[p.id] === -1 ? "ik-voted" : "", "▼ " + (p.down_votes || 0));
        up.onclick = function () { vote(p, 1, up, down); };
        down.onclick = function () { vote(p, -1, up, down); };
        acts.appendChild(up); acts.appendChild(down);
      }
      body.appendChild(meta); body.appendChild(text); body.appendChild(acts);
      c.appendChild(av); c.appendChild(body);
      return c;
    }

    function renderThread() {
      root.textContent = "";
      var crumb = el("div", "ik-crumb");
      var b1 = el("button", null, "← Forums");
      b1.onclick = function () { state.view = "cats"; renderCats(); };
      var b2 = el("button", null, state.cat.name);
      b2.onclick = function () { openCat(state.cat); };
      crumb.appendChild(b1); crumb.appendChild(el("span", null, "/"));
      crumb.appendChild(b2); crumb.appendChild(el("span", null, "/"));
      root.appendChild(crumb);

      root.appendChild(el("div", "ik-th-t",
        (state.thread.is_pinned ? "📌 " : "") + (state.thread.is_locked ? "🔒 " : "") + state.thread.title));
      root.appendChild(el("div", "ik-th-m", "started " + ago(state.thread.created_at)));

      var list = el("div"); list.style.marginTop = ".8rem";
      state.posts.forEach(function (p) { list.appendChild(postRow(p)); });
      root.appendChild(list);

      if (state.thread.is_locked) {
        root.appendChild(el("div", "ik-lock-note", "🔒 This thread is locked — replies are closed."));
      } else {
        var box = el("div", "ik-compose"); box.style.marginTop = ".8rem";
        var ta = el("textarea", "ik-input"); ta.placeholder = "Write a reply…";
        var bar = el("div", "ik-bar");
        var name = el("input", "ik-name"); name.placeholder = "Your name";
        name.value = read("ik_name_" + SITE) || "";
        var send = el("button", "ik-send", "Reply"); send.type = "button";
        identityBar(bar, name, send);
        box.appendChild(ta); box.appendChild(bar);
        ta.addEventListener("focus", function () { box.classList.add("ik-open"); });
        send.onclick = function () {
          var text = ta.value.trim();
          if (!text) return;
          var guestName = name.value.trim() || read("ik_name_" + SITE);
          var identified = !!read("ik_id_" + SITE) || !!window.iKommentSSO;
          if (!identified && !guestName) { name.focus(); return; }
          send.disabled = true;
          api(BASE, SITE, "POST", "post", {
            module: "forum", thread_id: state.thread.id, body: text, guest_name: guestName,
          }).then(function (r) {
            send.disabled = false;
            if (r.error) { alert(r.error); return; }
            if (r.identity) {
              store("ik_id_" + SITE, r.identity.user_id + ":" + r.identity.token);
              store("ik_name_" + SITE, guestName);
            }
            r.post.display_name = r.post.display_name || guestName || "You";
            state.posts.push(r.post);
            ta.value = "";
            renderThread();
          });
        };
        root.appendChild(box);
      }
      foot();
    }

    /* ============ VIEW: live chat ============ */
    function renderChat() {
      var wrap = el("div", "ik-chat");
      var presence = el("div", "ik-presence", "Connecting…");
      var log = el("div", "ik-chat-log");
      var inRow = el("div", "ik-chat-in");
      var input = document.createElement("input");
      input.placeholder = "Message #" + state.cat.name + "…";
      var send = el("button", "ik-send", "Send"); send.type = "button";
      inRow.appendChild(input); inRow.appendChild(send);
      wrap.appendChild(presence); wrap.appendChild(log); wrap.appendChild(inRow);
      root.appendChild(wrap);

      function addMsg(name, body, ts) {
        var m = el("div", "ik-msg");
        m.innerHTML = "<b>" + String(name).replace(/</g, "&lt;") + "</b> " +
          String(body).replace(/</g, "&lt;") +
          "<span class='ik-when'>" + ago(ts || Math.floor(Date.now() / 1000)) + "</span>";
        log.appendChild(m);
        log.scrollTop = log.scrollHeight;
      }

      // history first
      api(BASE, SITE, "GET", "chat/history", null, { category: state.cat.id }).then(function (r) {
        (r.messages || []).forEach(function (m) { addMsg(m.display_name, m.body, m.created_at); });
      });

      // live connection (mock transport handles this in demos)
      if (window.iKommentTransport) {
        presence.textContent = "Demo chat — messages echo locally";
        send.onclick = function () {
          if (!input.value.trim()) return;
          addMsg(read("ik_name_" + SITE) || "You", input.value.trim());
          input.value = "";
        };
        input.addEventListener("keydown", function (e) { if (e.key === "Enter") send.onclick(); });
        return;
      }

      var proto = BASE.indexOf("https") === 0 ? "wss" : "ws";
      var wsUrl = BASE.replace(/^https?/, proto).replace(/\/cdn$/, "") +
        "/api/chat/connect?site=" + SITE + "&category=" + state.cat.id;
      ws = new WebSocket(wsUrl);
      ws.onopen = function () {
        ws.send(JSON.stringify({ type: "hello", credential: read("ik_id_" + SITE) || "" }));
      };
      ws.onmessage = function (e) {
        var d = JSON.parse(e.data);
        if (d.type === "presence") presence.textContent = d.count + (d.count === 1 ? " person" : " people") + " here";
        if (d.type === "chat") addMsg(d.name, d.body, d.ts);
        if (d.type === "hello" && !d.ok) presence.textContent = "Sign in or comment once to chat";
      };
      ws.onclose = function () { presence.textContent = "Disconnected — switch tabs to reconnect"; };
      send.onclick = function () {
        if (!input.value.trim() || !ws || ws.readyState !== 1) return;
        ws.send(JSON.stringify({ type: "chat", body: input.value.trim() }));
        input.value = "";
      };
      input.addEventListener("keydown", function (e) { if (e.key === "Enter") send.onclick(); });
    }
    function closeChat() { if (ws) { try { ws.close(); } catch (e) {} ws = null; } }

    function foot() {
      var f = el("div", "ik-foot");
      var a = el("a", null, "Powered by iKomment");
      a.href = "https://ikomment.com"; a.rel = "noopener"; a.target = "_blank";
      f.appendChild(a);
      root.appendChild(f);
    }

    function render() {
      if (state.view === "thread") renderThread();
      else if (state.view === "threads") renderThreads();
      else renderCats();
    }

    api(BASE, SITE, "GET", "forum", null, {}).then(function (r) {
      if (r.disabled) { node.style.display = "none"; return; }
      state.cats = r.categories || [];
      state.settings = r.settings || {};
      renderCats();
    });
  }

  window.iKomment.forum = {
    mount: function (node, cfg) { new Widget(node, cfg); },
  };
})();
