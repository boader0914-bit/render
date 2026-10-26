"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { createRegionalMarketMissingHttpHandler } = require("./lib/regional_market_missing_http.cjs");
test("missing-only command requires admin, same-origin JSON and no arbitrary scope/force switches", async () => {
  let gets = 0, writes = 0, limits = 0, reply;
  const handler = createRegionalMarketMissingHttpHandler({ service: { get: async () => { gets++; return { job: null }; }, request: async () => { writes++; return { job: { status: "queued" } }; } },
    requireAdmin: session => session?.admin === true, parseJsonBody: async req => req.body, rateLimit: () => { limits++; }, send: (_, status, body) => { reply = { status, body }; } });
  const invoke = async ({ path = "/api/regional-market/missing-check", method = "GET", body = {}, headers = { host: "test.invalid", origin: "https://test.invalid", "content-type": "application/json" }, admin = true } = {}) => {
    reply = null; return { handled: await handler({ method, headers, body }, {}, new URL(path, "https://test.invalid"), { admin }), reply };
  };
  assert.equal((await invoke({ path: "/api/regional-market" })).handled, false);
  await invoke({ method: "POST", admin: false }); assert.equal(writes, 0);
  assert.equal((await invoke()).reply.status, 200); assert.equal(gets, 1); assert.equal(writes, 0);
  for (const body of [{ force: true }, { regionKey: "other" }, { collectMissing: false }, [], null]) assert.equal((await invoke({ method: "POST", body })).reply.status, 400);
  assert.equal((await invoke({ method: "POST", headers: { host: "test.invalid", origin: "https://other.invalid", "content-type": "application/json" } })).reply.status, 403);
  assert.equal((await invoke({ method: "POST", headers: {} })).reply.status, 415);
  assert.equal((await invoke({ method: "POST", path: "/api/regional-market/missing-check?force=1" })).reply.status, 400);
  assert.equal((await invoke({ method: "DELETE" })).reply.status, 405);
  assert.equal(writes, 0); assert.equal(limits, 0);
  assert.equal((await invoke({ method: "POST" })).reply.status, 202); assert.equal(writes, 1); assert.equal(limits, 1);
});

function gatedHandler(canRun) {
  const events = []; let reply;
  const handler = createRegionalMarketMissingHttpHandler({ canRun: async () => { events.push("gate"); return canRun(); },
    service: { get: async () => { events.push("get"); return { job: null }; }, request: async () => { events.push("request"); return { job: { status: "queued" } }; } },
    requireAdmin: () => true, parseJsonBody: async req => req.body, rateLimit: () => { events.push("rateLimit"); }, send: (_, status, body) => { reply = { status, body }; } });
  return { events, invoke: async (method = "POST", body = {}) => {
    reply = null; await handler({ method, body, headers: { host: "test.invalid", origin: "https://test.invalid", "content-type": "application/json" } }, {}, new URL("https://test.invalid/api/regional-market/missing-check"), {}); return reply;
  } };
}

test("active bootstrap rejects an admitted manual POST after rate limiting without reaching the service", async () => {
  const f = gatedHandler(async () => ({ allowed: false, reason: "private bootstrap detail" }));
  assert.deepEqual(await f.invoke(), { status: 409, body: { code: "REGIONAL_MARKET_MISSING_BOOTSTRAP_ACTIVE", reason: "BOOTSTRAP_IN_PROGRESS" } });
  assert.deepEqual(f.events, ["rateLimit", "gate"]);
  assert.equal((await f.invoke("GET")).status, 200); assert.deepEqual(f.events, ["rateLimit", "gate", "get"]);
  assert.equal((await f.invoke("POST", { force: true })).status, 400); assert.deepEqual(f.events, ["rateLimit", "gate", "get"]);
});

test("manual POST fails closed on unknown or failed bootstrap gates and never exposes the original error", async () => {
  for (const gate of [() => undefined, () => null, () => [], () => ({}), () => ({ allowed: "true" }), () => { throw Object.assign(new Error("private API key"), { code: "REGIONAL_MARKET_MISSING_PRIVATE_SECRET" }); }]) {
    const f = gatedHandler(gate), result = await f.invoke();
    assert.equal(result.status, 503); assert.equal(result.body.code, "REGIONAL_MARKET_MISSING_GATE_UNAVAILABLE"); assert.equal(JSON.stringify(result).includes("private"), false);
    assert.deepEqual(f.events, ["rateLimit", "gate"]);
    assert.equal((await f.invoke("GET")).status, 200); assert.deepEqual(f.events, ["rateLimit", "gate", "get"]);
  }
});

test("an allowed asynchronous bootstrap gate preserves manual request ordering", async () => {
  const f = gatedHandler(async () => { await Promise.resolve(); return { allowed: true }; });
  assert.equal((await f.invoke()).status, 202); assert.deepEqual(f.events, ["rateLimit", "gate", "request"]);
});

test("manual rate-limit rejection does not inspect bootstrap or request collection", async () => {
  let gates = 0, requests = 0, reply;
  const handler = createRegionalMarketMissingHttpHandler({ service: { request: async () => { requests++; } }, requireAdmin: () => true, parseJsonBody: async () => ({}),
    send: (_, status, body) => { reply = { status, body }; }, rateLimit: () => { throw new Error("limited"); }, canRun: async () => { gates++; return { allowed: true }; } });
  await handler({ method: "POST", headers: { "content-type": "application/json" } }, {}, new URL("https://test.invalid/api/regional-market/missing-check"), {});
  assert.equal(reply.status, 503); assert.equal(gates, 0); assert.equal(requests, 0);
});
