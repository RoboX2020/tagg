/* Tagg service worker - offline app shell, stale-while-revalidate */
var CACHE = "tagg-v10";
var SHELL = ["./", "index.html", "styles.css", "app.js", "qrcode.min.js",
  "icon.svg", "icon-180.png", "icon-192.png", "icon-512.png", "manifest.webmanifest"];
self.addEventListener("install", function (e) {
  e.waitUntil(
    caches.open(CACHE).then(function (c) { return c.addAll(SHELL.map(function (u) { return new Request(u, { cache: "no-cache" }); })); })
      .then(function () { return self.skipWaiting(); })
  );
});
self.addEventListener("activate", function (e) {
  e.waitUntil(
    caches.keys().then(function (ks) {
      return Promise.all(ks.map(function (k) { if (k !== CACHE) return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});
self.addEventListener("fetch", function (e) {
  if (e.request.method !== "GET") return;
  var url = new URL(e.request.url);
  if (url.origin !== location.origin) return; /* API, Google GIS: always network */
  if (url.pathname.endsWith("/sw.js")) return;  /* never serve a stale worker */
  if (e.request.mode === "navigate") {
    e.respondWith(
      fetch(e.request).then(function (r) {
        var copy = r.clone();
        caches.open(CACHE).then(function (c) { c.put("./", copy); });
        return r;
      }).catch(function () { return caches.match("./"); })
    );
    return;
  }
  /* stale-while-revalidate for shell assets */
  e.respondWith(
    caches.match(e.request).then(function (hit) {
      var fetched = fetch(e.request).then(function (r) {
        var copy = r.clone();
        caches.open(CACHE).then(function (c) { c.put(e.request, copy); });
        return r;
      }).catch(function () { return hit; });
      return hit || fetched;
    })
  );
});
