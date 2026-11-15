"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createKeywordMonthlyHttpHandler } = require("./lib/keyword_monthly_http.cjs");
const { EventEmitter } = require("node:events");
const { KEYWORD_MONTHLY_PREPARED_RESULT_LIMITS: DELIVERY } = require("./lib/keyword_monthly_prepared_results.cjs");
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
test("refresh diagnostics only read status, remain admin GET and cannot activate work", async () => {
  let reads = 0;
  const handler = createKeywordMonthlyHttpHandler({ service: { options: async () => ({ status: "available", keywords: [] }), analyze: async () => ({ status: "missing" }) },
    readRefreshStatus: async () => { reads++; return { status: "available", readOnly: true, started: false, counts: {} }; },
    requireAdmin: session => session.admin === true, send: (res, status, body) => Object.assign(res, { status, body }) });
  async function run(route, method = "GET", admin = true) { const res = { setHeader() {} }; await handler({ method }, res, new URL(route, "https://example.test"), { admin }); return res; }
  assert.equal((await run("/api/keyword-monthly/refresh-status")).body.started, false); assert.equal(reads, 1);
  assert.equal((await run("/api/keyword-monthly/options")).body.refreshStatus.readOnly, true); assert.equal(reads, 2);
  assert.equal((await run("/api/keyword-monthly/refresh-status", "POST")).status, 405);
  assert.equal((await run("/api/keyword-monthly/refresh-status?force=1")).status, 400);
  await run("/api/keyword-monthly/refresh-status", "GET", false); assert.equal(reads, 2);
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

async function nativeResult(result, route = "/api/keyword-monthly?keyword=synthetic&month=2026-09") {
  const req = new EventEmitter(), res = new EventEmitter(); req.method = "GET";
  res.headers = {}; res.setHeader = (key, value) => { res.headers[key] = value; };
  res.writeHead = status => { res.status = status; }; res.end = body => { res.body = body; res.writableEnded = true; res.emit("finish"); };
  const handler = createKeywordMonthlyHttpHandler({ service: { options: async () => result, analyze: async () => result },
    readRefreshStatus: async () => result, requireAdmin: () => true, send: (target, status, body) => { target.writeHead(status); target.end(body); } });
  await handler(req, res, new URL(route, "https://example.test"), {}); return res;
}

test("derived GET responses accept above 8MiB with wrappers but reject the final body above 32MiB", async () => {
  const result = { status: "available", snapshot: { evidence: "x".repeat(9 * 1024 * 1024), observations: [{ sold: 3, estimatedRevenue: 450000 }] },
    provenance: { inputSha256: "a".repeat(64) }, preparedResult: { status: "ready" } };
  const success = await nativeResult(result); assert.equal(success.status, 200); assert.ok(Buffer.isBuffer(success.body));
  assert.deepEqual(JSON.parse(success.body), result); assert.equal(success.headers["Cache-Control"], "private, no-store");
  const empty = { status: "available", snapshot: { evidence: "" }, provenance: { source: "synthetic" } };
  const boundary = { ...empty, snapshot: { evidence: "x".repeat(DELIVERY.responseBytes - Buffer.byteLength(JSON.stringify(empty))) } };
  const exact = await nativeResult(boundary); assert.equal(exact.status, 200); assert.equal(exact.body.length, DELIVERY.responseBytes);
  const overflow = await nativeResult({ ...boundary, preparedResult: { status: "ready" } });
  assert.equal(overflow.status, 503); assert.equal(overflow.body.code, "KEYWORD_MONTHLY_RESPONSE_TOO_LARGE"); assert.equal(overflow.body.snapshot, null);
});

test("derived response allowance does not widen refresh diagnostics or query input limits", async () => {
  const status = await nativeResult({ status: "available", evidence: "x".repeat(2 * 1024 * 1024) }, "/api/keyword-monthly/refresh-status");
  assert.equal(status.status, 503); assert.equal(status.body.code, "KEYWORD_MONTHLY_RESPONSE_TOO_LARGE");
  const input = await nativeResult({ status: "available" }, "/api/keyword-monthly?keyword=" + "x".repeat(4097) + "&month=2026-09");
  assert.equal(input.status, 400); assert.equal(input.body.code, "KEYWORD_MONTHLY_INVALID_REQUEST");
});
