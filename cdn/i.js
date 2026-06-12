/* ============================================================
   iKomment — Embed Loader (i.js)
   This is the ONLY file a site owner's page downloads up front.
   Its one job: find iKomment containers, then fetch just the
   module(s) the page actually needs. Target: ~2KB gzipped.

   Usage on any page:
     <div id="ikomment" data-module="comments"></div>
     <script src="https://cdn.ikomment.com/i.js" data-site="abc123" async></script>
   ============================================================ */
(function () {
  "use strict";

  var script = document.currentScript ||
    document.querySelector("script[data-site][src*='i.js']");
  if (!script) return;

  var SITE = script.getAttribute("data-site");
  var BASE = script.getAttribute("data-cdn") ||
    script.src.replace(/\/[^\/]*$/, ""); // modules live next to the loader

  // find every iKomment container on the page
  var nodes = document.querySelectorAll("[id='ikomment'],[data-ikomment]");
  if (!nodes.length || !SITE) return;

  var loaded = {}; // don't fetch the same module twice

  function loadModule(name, node) {
    if (loaded[name]) { whenReady(name, node); return; }
    loaded[name] = true;
    var s = document.createElement("script");
    s.src = BASE + "/" + name + ".js"; // e.g. comments.js, qa.js, forum.js
    s.async = true;
    s.onload = function () { whenReady(name, node); };
    document.head.appendChild(s);
  }

  function whenReady(name, node) {
    // each module registers itself on window.iKomment[name]
    var tries = 0;
    (function poll() {
      var mod = window.iKomment && window.iKomment[name];
      if (mod) return mod.mount(node, { site: SITE, base: BASE });
      if (tries++ < 100) setTimeout(poll, 30);
    })();
  }

  function boot(node) {
    var moduleName = node.getAttribute("data-module") || "comments";
    loadModule(moduleName, node);
  }

  // Lazy loading: only fetch the module when the visitor scrolls near.
  // (Falls back to loading immediately on very old browsers.)
  if ("IntersectionObserver" in window) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) { io.unobserve(e.target); boot(e.target); }
      });
    }, { rootMargin: "600px" }); // start loading 600px before it's visible
    nodes.forEach ? nodes.forEach(function (n) { io.observe(n); })
      : Array.prototype.forEach.call(nodes, function (n) { io.observe(n); });
  } else {
    Array.prototype.forEach.call(nodes, boot);
  }
})();
