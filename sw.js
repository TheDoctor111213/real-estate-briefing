/* Service worker: offline-capable app shell + last-known data cache + web push.
   Bump VERSION (and the ?v= on assets in index.html) on every deploy so old
   caches are dropped and clients can never pair stale code with new data. */
const VERSION = "v64";
const SHELL = "shell-" + VERSION;
const DATA = "data-" + VERSION;

const SHELL_ASSETS = [
  "./",
  "./index.html",
  "./css/style.css?v=64",
  "./js/app.js?v=64",
  "./manifest.webmanifest?v=64",
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

/* ---------- web push (Phase 4 alerts) ----------
   Payloads come from the push-send / push-dispatch edge functions as JSON:
   { title, body, url, tag }. Each one is shown as a notification, added to the
   device-local alerts inbox (IndexedDB, read by the app's Alerts page), and
   bumps the app-icon badge. Tapping deep-links into the app. */

const INBOX_DB = "briefing-alerts";
const INBOX_STORE = "inbox";
const INBOX_MAX = 30;

function inboxDb() {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(INBOX_DB, 1);
    open.onupgradeneeded = () => {
      open.result.createObjectStore(INBOX_STORE, { keyPath: "at" });
    };
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  });
}

async function inboxAdd(entry) {
  const db = await inboxDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(INBOX_STORE, "readwrite");
    tx.objectStore(INBOX_STORE).put(entry);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  // trim to the newest INBOX_MAX
  const keys = await new Promise((resolve, reject) => {
    const tx = db.transaction(INBOX_STORE, "readonly");
    const r = tx.objectStore(INBOX_STORE).getAllKeys();
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  if (keys.length > INBOX_MAX) {
    const drop = keys.sort().slice(0, keys.length - INBOX_MAX);
    const tx = db.transaction(INBOX_STORE, "readwrite");
    for (const k of drop) tx.objectStore(INBOX_STORE).delete(k);
  }
}

self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { title: "Real Estate Briefing" }; }
  e.waitUntil((async () => {
    try {
      await inboxAdd({
        at: new Date().toISOString(),
        title: d.title || "Real Estate Briefing",
        body: d.body || "",
        url: d.url || "./",
      });
    } catch { /* inbox is a nicety, never block the notification */ }
    try { await self.navigator.setAppBadge?.(1); } catch { /* unsupported */ }
    await self.registration.showNotification(d.title || "Real Estate Briefing", {
      body: d.body || "",
      tag: d.tag || undefined,
      icon: "./icon.svg",
      data: { url: d.url || "./" },
    });
  })());
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = e.notification.data?.url || "./";
  e.waitUntil((async () => {
    try { await self.navigator.clearAppBadge?.(); } catch { /* unsupported */ }
    const list = await clients.matchAll({ type: "window", includeUncontrolled: true });
    if (list.length) {
      const c = list[0];
      try { await c.navigate(url); } catch { /* cross-origin edge */ }
      return c.focus();
    }
    return clients.openWindow(url);
  })());
});
