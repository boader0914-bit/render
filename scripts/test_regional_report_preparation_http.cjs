"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createRegionalReportPreparationHttpHandler } = require("./lib/regional_report_preparation_http.cjs");

function fixture() {
  const calls = [];
  let response;
  let fail;
  const handle = createRegionalReportPreparationHttpHandler({
    service: {
      get: async input => { calls.push(["get", input]); if (fail) throw fail; return null; },
      start: async input => { calls.push(["start", input]); if (fail) throw fail; return { id: "job-1", status: "queued", ...input }; }
    },
    requireAdmin: session => { if (session?.role === "admin") return true; response = { status: session ? 403 : 401 }; return false; },
    parseJsonBody: async req => req.body,
    send: (_res, status, body) => { response = { status, body }; },
    rateLimit: () => { calls.push(["rate"]); }
  });
  return {
    calls, fail: error => { fail = error; },
    async request(method, path = "/api/regional-report-preparation", body, headers = {}, session = { role: "admin" }) {
      response = undefined;
      const handled = await handle({ method, body, headers: { host: "localhost:3210", origin: "http://localhost:3210", "content-type": "application/json", ...headers } }, {}, new URL(path, "http://localhost:3210"), session);
      return { ...response, handled };
    }
  };
}
const condition = { regionKey: "kr_gyeongnam_sancheong", month: "2026-08", cutoffDate: "2026-08-31" };

test("regional preparation is admin-only and GET never starts a job", async () => {
  const f = fixture();
  assert.equal((await f.request("GET", "/api/regional-report-preparation?regionKey=x&month=2026-08", undefined, {}, null)).status, 401);
  assert.equal((await f.request("POST", undefined, condition, {}, { role: "b2b" })).status, 403);
  assert.deepEqual(f.calls, []);
  const read = await f.request("GET", "/api/regional-report-preparation?regionKey=kr_gyeongnam_sancheong&month=2026-08");
  assert.equal(read.status, 200); assert.equal(read.body.job, null);
  assert.deepEqual(f.calls, [["get", { regionKey: condition.regionKey, month: condition.month }]]);
  assert.equal((await f.request("GET", "/api/another")).handled, false);
});

test("preparation rejects cross-origin, non-JSON, unknown keys and ambiguous query conditions before creating work", async () => {
  const f = fixture();
  assert.equal((await f.request("POST", undefined, condition, { origin: "https://elsewhere.test" })).status, 403);
  assert.equal((await f.request("POST", undefined, condition, { "content-type": "text/plain" })).status, 415);
  for (const body of [[], null, { ...condition, apiKey: "should-not-be-accepted" }, { ...condition, force: true }]) {
    assert.equal((await f.request("POST", undefined, body)).status, 400);
  }
  for (const query of ["regionKey=x", "regionKey=x&regionKey=y&month=2026-08", "regionKey=x&month=2026-08&force=true"]) {
    assert.equal((await f.request("GET", `/api/regional-report-preparation?${query}`)).status, 400);
  }
  assert.equal((await f.request("DELETE")).status, 405);
  assert.deepEqual(f.calls, []);
  const started = await f.request("POST", undefined, condition);
  assert.equal(started.status, 202);
  assert.equal(started.body.job.month, condition.month);
  assert.deepEqual(f.calls, [["rate"], ["start", condition]]);
});

test("provider or filesystem details never appear in public error responses", async () => {
  const f = fixture();
  f.fail(Object.assign(new Error("secret-key-at-provider-url"), { code: "EACCES" }));
  let result = await f.request("POST", undefined, condition);
  assert.equal(result.status, 500);
  assert.equal(result.body.code, "REGIONAL_PREPARATION_FAILED");
  assert.doesNotMatch(JSON.stringify(result), /secret-key|provider-url/);
  f.fail(Object.assign(new Error("internal validation detail"), { statusCode: 400, code: "REGIONAL_INVALID_MONTH" }));
  result = await f.request("POST", undefined, condition);
  assert.equal(result.status, 400);
  assert.equal(result.body.code, "REGIONAL_INVALID_MONTH");
});
