const UI_ASSET_VERSION = "v2-20260810-resilient-run-projection-v50";
const CACHE_VERSION = "lodging-datalab-pwa-v20260810-resilient-run-projection-v50";
const CACHE_PREFIX = "lodging-datalab-pwa-";
const APP_SHELL = [
  "/offline.html",
  `/styles.css?v=${UI_ASSET_VERSION}`,
  `/app.js?v=${UI_ASSET_VERSION}`,
  "/login-theme.js",
  "/public-ui.css",
  "/favicon.svg",
  "/manifest.webmanifest",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/maskable-512.png"
];
const STATIC_CACHE_PATHS = new Set([
  "/offline.html",
  "/styles.css",
  "/app.js",
  "/login-theme.js",
  "/public-ui.css",
  "/favicon.svg",
  "/manifest.webmanifest",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/maskable-512.png"
]);
const SENSITIVE_NAVIGATION_PATHS = new Set([
  "/admin",
  "/b2b",
  "/login",
  "/signup",
  "/account-delete",
  "/account-request"
]);

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys
        .filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_VERSION)
        .map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/outputs/")) return;

  if (request.mode === "navigate" || SENSITIVE_NAVIGATION_PATHS.has(url.pathname)) {
    // Navigation HTML can contain authentication or personal state. It is always
    // fetched from the network and is never written to Cache API. The explicit
    // set documents the routes that must remain network-only; all other HTML is
    // treated with the same privacy-preserving policy.
    event.respondWith(
      fetch(request)
        .catch(() => caches.open(CACHE_VERSION).then((cache) => cache.match("/offline.html")))
    );
    return;
  }

  if (STATIC_CACHE_PATHS.has(url.pathname)) {
    event.respondWith(
      fetch(request).then((response) => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_VERSION).then((cache) => cache.put(request, clone)).catch(() => {});
        }
        return response;
      }).catch(() => caches.open(CACHE_VERSION).then((cache) => cache.match(request)))
    );
    return;
  }
});
