"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createSearchDemandHttpHandler } = require("./lib/search_demand_http.cjs");

function fixture(admin = true) {
  const calls = [];
  const service = {
    catalog: async () => { calls.push("catalog"); return { schemaVersion: 1, keywords: [], readOnly: true, networkAttempted: false }; },
    analyze: async input => { calls.push(input); return { status: "missing", selection: input, readOnly: true, networkAttempted: false }; },
    report: async input => { calls.push(input); return { status: "available", csv: "키워드,검색량\r\n경남글램핑,9660\r\n" }; }
  };
  const handler = createSearchDemandHttpHandler({ service, requireAdmin: () => admin, send: (res, status, body, type) => Object.assign(res, { status, body, type }) });
  return { calls, service, async run(path, method = "GET") { const res = { headers: {}, setHeader(key, value) { this.headers[key] = value; } }; const handled = await handler({ method }, res, new URL(path, "https://local.invalid"), {}); return { ...res, handled }; } };
}

test("admin-only stored reads have private headers and cannot trigger work", async () => {
  const f = fixture();
  assert.equal((await f.run("/api/search-demand/catalog")).status, 200);
  const a = await f.run("/api/search-demand/analysis?keyword=경남글램핑&day=2026-11-01&month=2026-11&page=2&pageSize=20");
  assert.equal(a.status, 200); assert.equal(a.body.status, "missing"); assert.equal(a.body.selection.page, 2);
  assert.equal(a.headers["Cache-Control"], "private, no-store"); assert.equal(a.headers.Vary, "Cookie");
  const denied = fixture(false); assert.equal((await denied.run("/api/search-demand/catalog")).handled, true); assert.deepEqual(denied.calls, []);
  assert.equal((await f.run("/api/other")).handled, false);
});

test("mutation methods and unknown or duplicate parameters cannot reach service", async () => {
  const f = fixture();
  for (const method of ["POST", "PUT", "DELETE", "HEAD", "PATCH"]) assert.equal((await f.run("/api/search-demand/catalog", method)).status, 405);
  for (const query of ["keyword=a&keyword=b", "keyword=a&refresh=1", "keyword=", "keyword=a&day=2026-02-30", "keyword=a&page=0", "keyword=a&pageSize=201", "keyword=a&month=2026-13", "keyword=a&sort=secret"]) assert.equal((await f.run("/api/search-demand/analysis?" + query)).status, 400, query);
  assert.equal((await f.run("/api/search-demand/catalog?force=1")).status, 400);
  assert.equal((await f.run("/api/search-demand/start")).status, 404);
  assert.deepEqual(f.calls, []);
});

test("CSV is authenticated, bounded, correctly typed and named without keyword injection", async () => {
  const f = fixture();
  const res = await f.run("/api/search-demand/report?keyword=경남글램핑&day=2026-11-01&cadence=weekly&format=csv");
  assert.equal(res.status, 200); assert.equal(res.type, "text/csv; charset=utf-8"); assert.ok(res.body.startsWith("\ufeff키워드"));
  assert.match(res.headers["Content-Disposition"], /search-demand-weekly-2026-11-01\.csv/);
  assert.equal((await f.run("/api/search-demand/report?keyword=a&format=html")).status, 400);
});

test("source errors are safe codes and never raw credentials or paths", async () => {
  const f = fixture(); f.service.analyze = async () => { throw new Error("secret credential path /private"); };
  const res = await f.run("/api/search-demand/analysis?keyword=a");
  assert.equal(res.status, 503); assert.equal(res.body.code, "SEARCH_DEMAND_UNAVAILABLE"); assert.equal(res.body.networkAttempted, false);
  assert.doesNotMatch(JSON.stringify(res), /secret|credential|private\//);
});
