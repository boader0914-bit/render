"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..");
const source = fs.readFileSync(path.join(ROOT, "web", "sw.js"), "utf8");
const listeners = new Map();
const stores = new Map();
const putCalls = [];
const deletedCaches = [];
const networkCalls = [];
let fetchImpl = async (request) => new Response(`network:${request.url}`, { status: 200 });

const cacheKey = (request) => typeof request === "string" ? request : String(request?.url || request);
const cacheApi = (name) => {
  if (!stores.has(name)) stores.set(name, new Map());
  const store = stores.get(name);
  return {
    async addAll(entries) {
      for (const entry of entries) store.set(cacheKey(entry), new Response(`precache:${entry}`, { status: 200 }));
    },
    async put(request, response) {
      putCalls.push({ name, key: cacheKey(request) });
      store.set(cacheKey(request), response);
    },
    async match(request) {
      return store.get(cacheKey(request));
    }
  };
};

const context = vm.createContext({
  URL,
  Response,
  Promise,
  Set,
  console,
  fetch: async (request) => {
    networkCalls.push(cacheKey(request));
    return fetchImpl(request);
  },
  caches: {
    open: async (name) => cacheApi(name),
    keys: async () => [...stores.keys()],
    delete: async (name) => {
      deletedCaches.push(name);
      return stores.delete(name);
    },
    match: async (request) => {
      const key = cacheKey(request);
      for (const store of stores.values()) {
        if (store.has(key)) return store.get(key);
      }
      return undefined;
    }
  },
  self: {
    location: { origin: "https://fixture.local" },
    clients: { claim: async () => {} },
    skipWaiting: async () => {},
    addEventListener(type, listener) {
      listeners.set(type, listener);
    }
  }
});

vm.runInContext(source, context, { filename: "web/sw.js" });

function dispatchFetch(request) {
  let responsePromise;
  listeners.get("fetch")({
    request,
    respondWith(value) {
      responsePromise = Promise.resolve(value);
    }
  });
  return responsePromise;
}

async function main() {
  assert.ok(listeners.has("fetch"), "fetch handler registered");
  assert.ok(listeners.has("activate"), "activate handler registered");

  const currentCache = "lodging-datalab-pwa-v20260810-resilient-run-projection-v50";
  stores.set("lodging-datalab-pwa-v20260809-basic-collection-v47", new Map([["https://fixture.local/b2b", new Response("old-v47-private")]]));
  stores.set("lodging-datalab-pwa-v20260806-bounded-inventory-v43", new Map([["https://fixture.local/b2b", new Response("old-v43-private")]]));
  stores.set("lodging-datalab-pwa-v20260804-detail-sheet-v40", new Map([["https://fixture.local/b2b", new Response("old-v40-private")]]));
  stores.set("lodging-datalab-pwa-v20260804-detail-sheet-v39", new Map([["https://fixture.local/b2b", new Response("old-v39-private")]]));
  stores.set("lodging-datalab-pwa-v20260804-detail-sheet-v38", new Map([["https://fixture.local/b2b", new Response("old-v38-private")]]));
  stores.set("lodging-datalab-pwa-v20260804-region-hierarchy-v37", new Map([["https://fixture.local/b2b", new Response("old-v37-private")]]));
  stores.set("lodging-datalab-pwa-v20260801-ui-release-v27", new Map([["https://fixture.local/admin", new Response("old-private")]]));
  stores.set("unrelated-app-cache-v4", new Map([
    ["/unrelated", new Response("must-survive")],
    ["https://fixture.local/styles.css", new Response("unrelated-cache-must-not-win")]
  ]));
  stores.set(currentCache, new Map([["/offline.html", new Response("offline-only")]]));
  let activation;
  listeners.get("activate")({ waitUntil(value) { activation = Promise.resolve(value); } });
  await activation;
  assert.deepEqual(deletedCaches.sort(), ["lodging-datalab-pwa-v20260801-ui-release-v27", "lodging-datalab-pwa-v20260804-region-hierarchy-v37", "lodging-datalab-pwa-v20260804-detail-sheet-v38", "lodging-datalab-pwa-v20260804-detail-sheet-v39", "lodging-datalab-pwa-v20260804-detail-sheet-v40", "lodging-datalab-pwa-v20260806-bounded-inventory-v43", "lodging-datalab-pwa-v20260809-basic-collection-v47"].sort(), "activate removes previous caches");
  assert.equal(stores.has("unrelated-app-cache-v4"), true, "activate preserves caches owned by unrelated applications");

  const privateNavigation = {
    method: "GET",
    mode: "navigate",
    destination: "document",
    url: "https://fixture.local/admin"
  };
  const beforeNavigationPuts = putCalls.length;
  const navigationResponse = await dispatchFetch(privateNavigation);
  assert.equal(await navigationResponse.text(), "network:https://fixture.local/admin");
  assert.equal(putCalls.length, beforeNavigationPuts, "navigation HTML is never cached");

  fetchImpl = async () => { throw new Error("offline"); };
  const offlineResponse = await dispatchFetch({ ...privateNavigation, url: "https://fixture.local/b2b" });
  assert.equal(await offlineResponse.text(), "offline-only", "offline navigation uses only static offline page");
  assert.equal(putCalls.length, beforeNavigationPuts, "offline navigation does not cache personalized routes");

  fetchImpl = async (request) => new Response(`fresh:${request.url}`, { status: 200 });
  const staticResponse = await dispatchFetch({
    method: "GET",
    mode: "cors",
    destination: "script",
    url: "https://fixture.local/app.js?v=v2-20260810-resilient-run-projection-v50"
  });
  assert.equal(await staticResponse.text(), "fresh:https://fixture.local/app.js?v=v2-20260810-resilient-run-projection-v50");
  await Promise.resolve();
  await Promise.resolve();
  assert.ok(putCalls.some((call) => call.key.includes("/app.js?v=v2-20260810-resilient-run-projection-v50")), "allowlisted static asset is cached");

  fetchImpl = async () => { throw new Error("offline"); };
  const unrelatedStaticFallback = await dispatchFetch({
    method: "GET",
    mode: "cors",
    destination: "style",
    url: "https://fixture.local/styles.css"
  });
  assert.equal(unrelatedStaticFallback, undefined, "static fallback reads only this application's current cache");

  assert.equal(dispatchFetch({
    method: "GET",
    mode: "cors",
    destination: "style",
    url: "https://fixture.local/private-generated.css"
  }), undefined, "unknown static path is not intercepted or cached");
  assert.equal(dispatchFetch({
    method: "GET",
    mode: "cors",
    destination: "",
    url: "https://fixture.local/api/session"
  }), undefined, "API requests are never intercepted");

  for (const sensitivePath of ["/admin", "/b2b", "/login", "/signup", "/account-delete", "/account-request"]) {
    fetchImpl = async (request) => new Response(`network-only:${request.url}`, { status: 200 });
    const response = await dispatchFetch({
      method: "GET",
      mode: "cors",
      destination: "document",
      url: `https://fixture.local${sensitivePath}`
    });
    assert.match(await response.text(), /^network-only:/, `${sensitivePath} remains network-only outside navigate mode`);
  }

  assert.ok(networkCalls.includes("https://fixture.local/admin"), "private route fetched from network");
  console.log("Service worker privacy and static-cache allowlist tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
