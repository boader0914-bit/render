"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { createRegionalMarketMissingWeeklyHttpHandler } = require("./lib/regional_market_missing_weekly_http.cjs");
function fixture(overrides = {}) {
  let gets = 0, writes = 0, limits = 0, reply, time = 0; const values = [];
  const handler = createRegionalMarketMissingWeeklyHttpHandler({ service: { get: async () => { gets++; return { enabled: false }; }, configure: async value => { writes++; values.push(value); return { enabled: value.enabled }; } },
    requireAdmin: session => session?.admin === true, parseJsonBody: async req => req.body, rateLimit: async () => { limits++; }, now: () => time,
    send: (_, status, body) => { reply = { status, body }; }, ...overrides });
  return { invoke: async ({ pathname = "/api/regional-market/missing-weekly-policy", method = "GET", body = { enabled: true }, headers = { host: "test.invalid", origin: "https://test.invalid", "x-forwarded-proto": "https", "content-type": "application/json" }, admin = true } = {}) => {
    reply = null; return { handled: await handler({ method, headers, body }, {}, new URL(pathname, "https://test.invalid"), { admin }), reply };
  }, gets: () => gets, writes: () => writes, limits: () => limits, values, advance: ms => { time += ms; } };
}
test("weekly policy GET is admin-only and never changes policy or schedules", async () => {
  const f = fixture(); assert.equal((await f.invoke({ pathname: "/api/regional-market/missing-check" })).handled, false);
  await f.invoke({ admin: false }); assert.equal(f.gets(), 0); assert.equal(f.writes(), 0);
  assert.deepEqual((await f.invoke()).reply, { status: 200, body: { enabled: false } }); assert.equal(f.gets(), 1); assert.equal(f.writes(), 0); assert.equal(f.limits(), 0);
});
test("weekly policy commands require same-origin JSON and one strict enabled boolean", async () => {
  const f = fixture();
  for (const body of [{}, { force: true }, { enabled: true, force: true }, { enabled: true, hour: 1 }, { enabled: "true" }, { enabled: false, collectMissing: true }, null, []]) assert.equal((await f.invoke({ method: "POST", body })).reply.status, 400);
  for (const origin of [undefined, "https://other.invalid", "null", "https://user:password@test.invalid", "https://test.invalid/?force=1", "http://test.invalid"]) {
    assert.equal((await f.invoke({ method: "POST", headers: { host: "test.invalid", origin, "x-forwarded-proto": "https", "content-type": "application/json" } })).reply.status, 403);
  }
  assert.equal((await f.invoke({ method: "POST", headers: {} })).reply.status, 415); assert.equal((await f.invoke({ method: "POST", pathname: "/api/regional-market/missing-weekly-policy?enabled=1" })).reply.status, 400);
  assert.equal((await f.invoke({ method: "DELETE" })).reply.status, 405); assert.equal(f.writes(), 0); assert.equal(f.limits(), 0);
  assert.equal((await f.invoke({ method: "POST" })).reply.status, 200); assert.equal((await f.invoke({ method: "POST", body: { enabled: false } })).reply.status, 200);
  assert.deepEqual(f.values, [{ enabled: true }, { enabled: false }]); assert.equal(f.writes(), 2); assert.equal(f.limits(), 2);
});
test("only four validated policy changes are accepted per hour, while reads remain available", async () => {
  const f = fixture(); for (let index = 0; index < 4; index++) assert.equal((await f.invoke({ method: "POST" })).reply.status, 200);
  assert.equal((await f.invoke({ method: "POST" })).reply.status, 429); assert.equal(f.writes(), 4); assert.equal(f.limits(), 4);
  assert.equal((await f.invoke()).reply.status, 200); f.advance(3600000); assert.equal((await f.invoke({ method: "POST" })).reply.status, 200); assert.equal(f.writes(), 5);
});
test("parse failures and application rate limits never reach policy persistence", async () => {
  const parse = fixture({ parseJsonBody: async () => { throw new Error("private request"); } }); assert.equal((await parse.invoke({ method: "POST" })).reply.status, 400); assert.equal(parse.writes(), 0);
  const rate = fixture({ rateLimit: async () => { throw new Error("private session"); } }); const reply = (await rate.invoke({ method: "POST" })).reply;
  assert.equal(reply.status, 429); assert.equal(rate.writes(), 0); assert.equal(JSON.stringify(reply).includes("private"), false);
});
test("unexpected service errors expose only safe policy codes", async () => {
  const f = fixture({ service: { get: async () => { throw new Error("private cookie"); }, configure: async () => { throw Object.assign(new Error("private key"), { code: "PRIVATE_TOKEN" }); } } });
  for (const method of ["GET", "POST"]) { const reply = (await f.invoke({ method })).reply; assert.equal(reply.status, 503); assert.equal(reply.body.code, "REGIONAL_MARKET_WEEKLY_UNAVAILABLE"); assert.equal(JSON.stringify(reply).includes("private"), false); }
});
