/* Service worker: offline-capable app shell + last-known data cache.
   Bump VERSION (and the ?v= on assets in index.html) on every deploy so old
   caches are dropped and clients can never pair stale code with new data. */
const VERSION = "v25";
const SHELL = "shell-" + VERSION;
const DATA = "data-" + VERSION;

const SHELL_ASSETS = [
  "./",
  "./index.html",
  "./css/style.css?v=25",
  "./js/app.js?v=25",
  "./manifest.webmanifest?v=25",
  "./icon.svg",
  "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css",
  "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(SHELL).then((c) => c.addAll(SHELL_ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL && k !== DATA).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // App launch: network-first, fall back to the cached shell so it opens offline.
  if (req.mode === "navigate") {
    e.respondWith(fetch(req).catch(() => caches.match("./index.html")));
    return;
  }

  // Supabase reads (days/weeks/players/terms/rates): network-first, but keep the
  // last good copy so a previously-opened briefing still reads offline.
  if (url.hostname.endsWith("supabase.co")) {
    e.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(DATA).then((c) => c.put(req, copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match(req))
    );
    return;
  }

  // Static assets (own + CDN): serve from cache, refresh in the background.
  e.respondWith(
    caches.match(req).then((cached) => {
      const net = fetch(req)
        .then((res) => {
          if (res && res.status === 200) {
            const copy = res.clone();
            caches.open(SHELL).then((c) => c.put(req, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() => cached);
      return cached || net;
    })
  );
});
