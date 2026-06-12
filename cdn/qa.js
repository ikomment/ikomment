/* ============================================================
   iKomment — Q&A Module (qa.js)
   Loaded on demand by i.js for pages with data-module="qa".
   Question at top · accepted answer pinned with ✅ · answers
   sorted by votes · nested comment discussion under each answer.
   ============================================================ */
(function () {
  "use strict";
  window.iKomment = window.iKomment || {};

  var CSS = "" +
".ikw .ik-q{border:1px solid var(--ik-line);border-radius:var(--ik-r);background:var(--ik-card);padding:1rem;margin-bottom:1rem}" +
".ikw .ik-q-t{font-weight:700;font-size:1.05rem;line-height:1.4}" +
".ikw .ik-q-s{color:var(--ik-soft);font-size:.82rem;margin-top:.3rem}" +
".ikw .ik-q-s .ik-answered{color:#3ecf8e;font-weight:600}" +
".ikw .ik-a{border:1px solid var(--ik-line);border-radius:var(--ik-r);padding:.9rem;margin-bottom:.8rem}" +
".ikw .ik-a.ik-accepted{border-color:#3ecf8e;background:rgba(62,207,142,.06)}" +
".ikw .ik-acc-tag{display:inline-flex;align-items:center;gap:.3rem;color:#3ecf8e;font-size:.8rem;font-weight:700;margin-bottom:.4rem}" +
".ikw .ik-a-head{display:flex;align-items:center;gap:.5rem;margin-bottom:.35rem}" +
".ikw .ik-write{width:100%;margin:.6rem 0 1.2rem}" +
".ikw .ik-a-comments{margin-top:.7rem;border-top:1px solid var(--ik-line);padding-top:.6rem}" +
".ikw .ik-filter{display:flex;gap:.15rem;color:var(--ik-soft);font-size:.85rem;margin-left:auto}" +
".ikw .ik-filter button{padding:.35rem .55rem;border-radius:6px;min-height:2rem}" +
".ikw .ik-filter button.ik-on{color:var(--ik-accent);font-weight:600}" +
".ikw.ik-xs .ik-a{padding:.7rem}";

  // minimal shared base, injected only if comments.js isn't already on the page
  var BASE_CSS = "" +
".ikw{--ik-accent:#4f7cff;--ik-fg:#1a1d23;--ik-soft:#6b7280;--ik-line:rgba(128,128,140,.22);--ik-card:rgba(128,128,140,.07);--ik-r:8px;font:inherit;color:var(--ik-fg)}" +
".ikw.ik-dark{--ik-fg:#e7e9ee;--ik-soft:#9aa1ad;--ik-line:rgba(160,165,180,.22);--ik-card:rgba(160,165,180,.09)}" +
".ikw *{box-sizing:border-box;margin:0}.ikw button{font:inherit;color:inherit;background:none;border:0;cursor:pointer}" +
".ikw .ik-compose{border:1px solid var(--ik-line);border-radius:var(--ik-r);background:var(--ik-card);padding:.65rem .8rem}" +
".ikw .ik-input{width:100%;border:0;outline:0;background:transparent;color:inherit;font:inherit;font-size:1rem;resize:vertical;min-height:1.6em}" +
".ikw .ik-compose.ik-open .ik-input{min-height:4.5em}" +
".ikw .ik-bar{display:none;gap:.5rem;flex-wrap:wrap;margin-top:.55rem;align-items:center}" +
".ikw .ik-compose.ik-open .ik-bar{display:flex}" +
".ikw .ik-name{flex:1;min-width:8rem;border:1px solid var(--ik-line);border-radius:6px;background:transparent;color:inherit;padding:.45rem .6rem;font-size:1rem}" +
".ikw .ik-send{margin-left:auto;background:var(--ik-accent);color:#fff;border-radius:6px;padding:.5rem 1.1rem;font-weight:600;min-height:2.6rem}" +
".ikw .ik-av{width:2rem;height:2rem;border-radius:50%;background:var(--ik-accent);color:#fff;display:flex;align-items:center;justify-content:center;font-size:.8rem;font-weight:700;flex-shrink:0}" +
".ikw .ik-meta{display:flex;gap:.5rem;align-items:baseline;font-size:.82rem;flex-wrap:wrap}" +
".ikw .ik-who{font-weight:600}.ikw .ik-when{color:var(--ik-soft)}" +
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
    var state = { posts: [], q: {}, settings: {}, myVotes: {}, filter: "votes", thread: null };
    var pageUrl = location.href, pageTitle = document.title;

    if (!document.getElementById("ik-css")) {
      var b = el("style"); b.id = "ik-css"; b.textContent = BASE_CSS;
      document.head.appendChild(b);
    }
    if (!document.getElementById("ik-qa-css")) {
      var st = el("style"); st.id = "ik-qa-css"; st.textContent = CSS;
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

    /* composer: parentId null = write an ANSWER; otherwise a comment under it */
    function composer(parentId) {
      var box = el("div", "ik-compose" + (parentId ? "" : " ik-write"));
      var ta = el("textarea", "ik-input");
      ta.placeholder = parentId ? "Add a comment…" : "Write an answer…";
      var bar = el("div", "ik-bar");
      var name = el("input", "ik-name"); name.placeholder = "Your name";
      name.value = read("ik_name_" + SITE) || "";
      var send = el("button", "ik-send", parentId ? "Comment" : "Post answer");
      send.type = "button";

      var identified = !!read("ik_id_" + SITE) || !!window.iKommentSSO;
      var canGuest = state.settings.guest_posting === 1;
      if (!identified) {
        if (state.settings.login_google === 1 || state.settings.login_github === 1 || state.settings.login_magic_link === 1) {
          var login = el("div", "ik-login");
          login.appendChild(el("span", "ik-login-lbl", canGuest ? "or sign in:" : "Sign in to answer:"));
          if (state.settings.login_google === 1) login.appendChild(oauthBtn("google", "Google"));
          if (state.settings.login_github === 1) login.appendChild(oauthBtn("github", "GitHub"));
          if (state.settings.login_magic_link === 1) login.appendChild(emailBtn(login));
          bar.appendChild(login);
        }
        if (canGuest) bar.appendChild(name);
      }
      if (identified || canGuest) bar.appendChild(send);
      box.appendChild(ta); box.appendChild(bar);
      ta.addEventListener("focus", function () { box.classList.add("ik-open"); });

      send.onclick = function () {
        var text = ta.value.trim();
        if (!text) return;
        var guestName = name.value.trim() || read("ik_name_" + SITE);
        var identifiedNow = !!read("ik_id_" + SITE) || !!window.iKommentSSO;
        if (!identifiedNow && !canGuest) return;
        if (!identifiedNow && !guestName) { name.focus(); return; }
        send.disabled = true;
        api(BASE, SITE, "POST", "post", {
          module: "qa", url: pageUrl, title: pageTitle,
          parent_id: parentId || null, body: text, guest_name: guestName,
        }).then(function (res) {
          send.disabled = false;
          if (res.error) { alert(res.error); return; }
          if (res.identity) {
            store("ik_id_" + SITE, res.identity.user_id + ":" + res.identity.token);
            store("ik_name_" + SITE, guestName);
          }
          res.post._mine = true;
          state.posts.push(res.post);
          render();
        });
      };
      return box;
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

    function commentRow(p) {
      var c = el("div", "ik-c" + (p.status === "pending" ? " ik-pending" : ""));
      var av = el("div", "ik-av", (p.display_name || "?").slice(0, 1).toUpperCase());
      var body = el("div", "ik-body");
      var meta = el("div", "ik-meta");
      meta.appendChild(el("span", "ik-who", p.display_name));
      meta.appendChild(el("span", "ik-when", ago(p.created_at)));
      if (p.status === "pending") meta.appendChild(el("span", "ik-tag", "Awaiting approval"));
      var text = el("div", "ik-text"); text.innerHTML = p.body_html;
      body.appendChild(meta); body.appendChild(text);
      c.appendChild(av); c.appendChild(body);
      return c;
    }

    function answerCard(a, comments) {
      var isAccepted = state.q.accepted_post_id === a.id;
      var card = el("div", "ik-a" + (isAccepted ? " ik-accepted" : "") +
                          (a.status === "pending" ? " ik-pending" : ""));
      if (isAccepted) card.appendChild(el("div", "ik-acc-tag", "✅ Accepted answer"));

      var head = el("div", "ik-a-head");
      head.appendChild(el("div", "ik-av", (a.display_name || "?").slice(0, 1).toUpperCase()));
      var meta = el("div", "ik-meta");
      meta.appendChild(el("span", "ik-who", a.display_name));
      meta.appendChild(el("span", "ik-when", ago(a.created_at)));
      if (a.status === "pending") meta.appendChild(el("span", "ik-tag", "Awaiting approval"));
      head.appendChild(meta);
      card.appendChild(head);

      var text = el("div", "ik-text"); text.innerHTML = a.body_html;
      card.appendChild(text);

      var acts = el("div", "ik-acts");
      if (state.settings.voting !== 0) {
        var up = el("button", state.myVotes[a.id] === 1 ? "ik-voted" : "", "▲ " + (a.up_votes || 0));
        var down = el("button", state.myVotes[a.id] === -1 ? "ik-voted" : "", "▼ " + (a.down_votes || 0));
        up.onclick = function () { vote(a, 1, up, down); };
        down.onclick = function () { vote(a, -1, up, down); };
        acts.appendChild(up); acts.appendChild(down);
      }
      var reply = el("button", null, "💬 Discuss" + (comments.length ? " (" + comments.length + ")" : ""));
      acts.appendChild(reply);
      card.appendChild(acts);

      var disc = el("div", "ik-a-comments");
      disc.style.display = comments.length ? "" : "none";
      comments.forEach(function (cm) { disc.appendChild(commentRow(cm)); });
      card.appendChild(disc);
      reply.onclick = function () {
        disc.style.display = "";
        if (!disc.querySelector(".ik-compose")) disc.appendChild(composer(a.id));
      };
      return card;
    }

    function render() {
      root.textContent = "";
      applyTheme(state.settings.theme_mode);
      if (state.settings.accent_color)
        root.style.setProperty("--ik-accent", state.settings.accent_color);

      var live = state.posts.filter(function (p) { return p.status !== "deleted"; });
      var answers = live.filter(function (p) { return p.kind === "answer"; });

      // question header
      var q = el("div", "ik-q");
      q.appendChild(el("div", "ik-q-t", state.q.title || pageTitle));
      var status = el("div", "ik-q-s");
      if (state.q.is_answered) {
        status.appendChild(el("span", "ik-answered", "✅ Answered"));
        status.appendChild(document.createTextNode(
          " · " + answers.length + " answer" + (answers.length !== 1 ? "s" : "")));
      } else {
        status.textContent = answers.length
          ? answers.length + " answer" + (answers.length !== 1 ? "s" : "") + " — none accepted yet"
          : "No answers yet — be the first";
      }
      q.appendChild(status);
      root.appendChild(q);

      root.appendChild(composer(null));

      var byParent = {};
      live.forEach(function (p) {
        if (p.parent_id) (byParent[p.parent_id] = byParent[p.parent_id] || []).push(p);
      });
      answers.sort(function (a, b) {
        var accA = state.q.accepted_post_id === a.id ? 1 : 0;
        var accB = state.q.accepted_post_id === b.id ? 1 : 0;
        if (accA !== accB) return accB - accA;
        if (state.filter === "new") return b.created_at - a.created_at;
        return (b.up_votes - b.down_votes) - (a.up_votes - a.down_votes);
      });

      if (answers.length && state.settings.sorting !== 0) {
        var bar = el("div", "ik-meta");
        var filter = el("div", "ik-filter");
        [["votes", "Top"], ["new", "Newest"]].forEach(function (f) {
          var fb = el("button", state.filter === f[0] ? "ik-on" : "", f[1]);
          fb.onclick = function () { state.filter = f[0]; render(); };
          filter.appendChild(fb);
        });
        bar.appendChild(filter);
        root.appendChild(bar);
      }

      if (!answers.length) root.appendChild(el("div", "ik-empty", "No answers yet."));
      answers.forEach(function (a) { root.appendChild(answerCard(a, byParent[a.id] || [])); });

      var foot = el("div", "ik-foot");
      var pb = el("a", null, "Powered by iKomment");
      pb.href = "https://ikomment.com"; pb.rel = "noopener"; pb.target = "_blank";
      foot.appendChild(pb);
      root.appendChild(foot);
    }

    function load() {
      api(BASE, SITE, "GET", "qa", null, { url: pageUrl, title: pageTitle })
        .then(function (res) {
          if (res.disabled) { node.style.display = "none"; return; }
          state.thread = res.thread_id;
          state.q = res.question || {};
          state.settings = res.settings || {};
          var mine = state.posts.filter(function (p) { return p._mine; });
          var ids = {};
          state.posts = (res.posts || []).map(function (p) { ids[p.id] = 1; return p; });
          mine.forEach(function (p) { if (!ids[p.id]) state.posts.push(p); });
          render();
        });
    }
    load();
    if (!window.iKommentTransport) setInterval(load, 20000);
  }

  window.iKomment.qa = {
    mount: function (node, cfg) { new Widget(node, cfg); },
  };
})();
