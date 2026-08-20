// LabyrinthV8 Security Dashboard — minimal service worker.
//
// This exists to satisfy PWA installability requirements (PWABuilder / the
// Microsoft Store, Google Play, and App Store packaging flows all check for
// a registered service worker). It caches the static app shell only —
// /api/* calls always go to the network, since dashboard data (alerts,
// pending requests, audit trail) must never be served stale or from cache.

const CACHE_NAME = "labyrinthv8-shell-v2";
const SHELL_URLS = [".", "index.html", "favicon.svg", "manifest.json"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_URLS)).catch(() => undefined),
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // Never cache API calls — always hit the network for live security data.
  if (url.pathname.includes("/api/")) return;

  // Only handle same-origin GET requests for the shell; let everything else
  // (fonts, cross-origin, non-GET) pass straight through to the network.
  if (event.request.method !== "GET" || url.origin !== self.location.origin) return;

  // Navigation requests (the HTML document itself) are network-first: a
  // stale cached index.html can reference JS/CSS bundle filenames from a
  // build that no longer exists on the server (Vite hashes every filename
  // per build), which is exactly the kind of "redeployed but nothing
  // changed" bug that's easy to ship silently. Cache is only a fallback
  // for when the network is genuinely unreachable (offline).
  if (event.request.mode === "navigate") {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
          return response;
        })
        .catch(() => caches.match(event.request)),
    );
    return;
  }

  // Everything else (favicon, manifest, hashed JS/CSS bundles) is safe to
  // serve cache-first — hashed asset filenames change whenever their
  // content does, so a cache hit always means genuinely unchanged content.
  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request)),
  );
});
