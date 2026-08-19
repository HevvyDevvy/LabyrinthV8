// LabyrinthV8 Security Dashboard — minimal service worker.
//
// This exists to satisfy PWA installability requirements (PWABuilder / the
// Microsoft Store, Google Play, and App Store packaging flows all check for
// a registered service worker). It caches the static app shell only —
// /api/* calls always go to the network, since dashboard data (alerts,
// pending requests, audit trail) must never be served stale or from cache.

const CACHE_NAME = "labyrinthv8-shell-v1";
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

  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request)),
  );
});
