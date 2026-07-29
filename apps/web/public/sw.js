const CACHE_PREFIXES = ["lodging-datalab-pwa-", "glamping-datalab-v2-ui-v3-"];
const SHELL_CACHE = "glamping-datalab-v2-ui-v3-stage225-v1-shell";
const STATIC_CACHE = "glamping-datalab-v2-ui-v3-stage225-v1-static";
const SHELL_ASSETS = ["/offline.html", "/manifest.webmanifest", "/pwa-icon.svg", "/theme-boot.js"];

const ownedCache = (key) => CACHE_PREFIXES.some((prefix) => key.startsWith(prefix));

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL_ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(
    keys.filter((key) => ownedCache(key) && ![SHELL_CACHE, STATIC_CACHE].includes(key)).map((key) => caches.delete(key))
  )).then(() => self.clients.claim()));
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/outputs/")) return;
  if (request.mode === "navigate") {
    event.respondWith(fetch(request).catch(() => caches.match("/offline.html")));
    return;
  }
  const staticAsset = url.pathname.startsWith("/assets/") && ["script", "style", "font", "image"].includes(request.destination);
  const shellAsset = SHELL_ASSETS.includes(url.pathname);
  if (!staticAsset && !shellAsset) return;
  event.respondWith(caches.match(request).then((cached) => cached || fetch(request).then((response) => {
    if (!response.ok || response.type !== "basic") return response;
    const copy = response.clone();
    void caches.open(staticAsset ? STATIC_CACHE : SHELL_CACHE).then((cache) => cache.put(request, copy));
    return response;
  })));
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") self.skipWaiting();
  if (event.data?.type === "PURGE_V2_UI_CACHES") {
    event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter(ownedCache).map((key) => caches.delete(key)))));
  }
});
