"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createKeywordMonthlyHttpHandler } = require("./lib/keyword_monthly_http.cjs");
function fixture(authorized = true, result = { status: "available", snapshot: {} }) {
  const calls = [];
  const service = { options: async () => { calls.push("options"); return { ...result, keywords: [] }; }, analyze: async input => { calls.push(input); return result; } };
  const handler = createKeywordMonthlyHttpHandler({ service, requireAdmin: () => authorized, send: (res, status, body) => Object.assign(res, { status, body }) });
  return { calls, async run(address, method = "GET") { const res = { headers: {}, setHeader(key, value) { this.headers[key] = value; } }; const handled = await handler({ method }, res, new URL(address, "https://example.test"), {}); return { ...res, handled }; } };
}
test("only authenticated GET paths invoke read-only service", async () => {
  const f = fixture();
  assert.equal((await f.run("/api/keyword-monthly/options")).status, 200);
  assert.equal((await f.run("/api/keyword-monthly?keyword=가평글램핑&month=2026-09&cutoffDate=2026-09-30")).status, 200);
  assert.deepEqual(f.calls[1], { keyword: "가평글램핑", month: "2026-09", cutoffDate: "2026-09-30" });
  const unauthorized = fixture(false); assert.equal((await unauthorized.run("/api/keyword-monthly/options")).handled, true); assert.deepEqual(unauthorized.calls, []);
  assert.equal((await f.run("/api/other")).handled, false);
});
test("write methods, unknown endpoints, duplicate/unknown/empty query parameters never invoke service", async () => {
  const f = fixture();
  for (const method of ["POST", "PUT", "PATCH", "DELETE", "HEAD"]) assert.equal((await f.run("/api/keyword-monthly", method)).status, 405);
  assert.equal((await f.run("/api/keyword-monthly/rebuild")).status, 404);
  for (const url of ["/api/keyword-monthly/options?force=1", "/api/keyword-monthly?keyword=a&keyword=b&month=2026-09", "/api/keyword-monthly?keyword=a&month=2026-09&refresh=1", "/api/keyword-monthly?keyword=&month=2026-09"]) assert.equal((await f.run(url)).status, 400);
  assert.deepEqual(f.calls, []);
});
test("missing/stale remain honest read results; verification failures are503 and no source error text leaks", async () => {
  for (const status of ["missing", "stale"]) assert.equal((await fixture(true, { status, snapshot: null }).run("/api/keyword-monthly?keyword=a&month=2026-09")).status, 200);
  const failing = fixture(true, { status: "needs_verification", snapshot: null });
  assert.equal((await failing.run("/api/keyword-monthly/options")).status, 503);
  const res = { headers: {}, setHeader(key, value) { this.headers[key] = value; } };
  const handler = createKeywordMonthlyHttpHandler({ service: { options: async () => { throw new Error("secret path"); }, analyze: async () => {} }, requireAdmin: () => true,
    send: (target, status, body) => Object.assign(target, { status, body }) });
  await handler({ method: "GET" }, res, new URL("https://example.test/api/keyword-monthly/options"), {});
  assert.equal(res.status, 503); assert.ok(!JSON.stringify(res.body).includes("secret")); assert.equal(res.body.snapshot, null);
});
test("private no-store applies before auth and on all success/error/method responses", async () => {
  for (const authorized of [true, false]) {
    const f = fixture(authorized, { status: "needs_verification", snapshot: null });
    for (const [url, method] of [["/api/keyword-monthly/options", "GET"], ["/api/keyword-monthly", "POST"], ["/api/keyword-monthly?bad=1", "GET"]]) {
      const result = await f.run(url, method);
      assert.equal(result.headers["Cache-Control"], "private, no-store"); assert.equal(result.headers.Vary, "Cookie");
    }
  }
});
