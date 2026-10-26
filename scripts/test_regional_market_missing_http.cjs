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
