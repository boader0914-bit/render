"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createRegionalAnalysisHttpHandler } = require("./lib/regional_analysis_http.cjs");
function fixture() {
  const calls = [], replies = [];
  const service = {
    get: async input => { calls.push(["get", input]); return { status: "missing", snapshot: null, policy: { enabled: false } }; },
    request: async (input, options) => { calls.push(["request", input, options]); return { job: { status: "queued", id: "job1" }, reused: false }; },
    updatePolicy: async (input, options) => { calls.push(["policy", input, options]); return { ...options, nextRunAt: null }; }
  };
  const handler = createRegionalAnalysisHttpHandler({ service,
    requireAdmin: (session, req, res) => { if (session?.role === "admin") return true; replies.push({ status: 403 }); return false; },
    parseJsonBody: async req => req.payload, send: (res, status, data) => replies.push({ status, data }) });
  const request = async (route, { method = "GET", payload, role = "admin", headers = {} } = {}) => {
    await handler({ method, payload, headers: { host: "localhost:8080", "content-type": "application/json", ...headers } }, {}, new URL(route, "http://localhost:8080"), { role });
    return replies.at(-1);
  };
  return { service, calls, request };
}
test("GET only reads persisted result; duplicate and unknown query conditions are rejected", async () => {
  const f = fixture();
  assert.equal((await f.request("/api/regional-analysis?regionKey=pocheon&months=13")).status, 200);
  assert.deepEqual(f.calls, [["get", { regionKey: "pocheon", months: 13 }]]);
  assert.equal((await f.request("/api/regional-analysis?regionKey=pocheon&regionKey=other")).status, 400);
  assert.equal((await f.request("/api/regional-analysis?regionKey=pocheon&force=true")).status, 400);
  assert.equal(f.calls.length, 1);
});
test("refresh and policy mutations require admin, same origin and JSON", async () => {
  const f = fixture(), route = "/api/regional-analysis/refresh", payload = { regionKey: "pocheon", months: 13 };
  assert.equal((await f.request(route, { method: "POST", payload, role: "b2b" })).status, 403);
  assert.equal((await f.request(route, { method: "POST", payload, headers: { origin: "https://evil.invalid" } })).status, 403);
  assert.equal((await f.request(route, { method: "POST", payload, headers: { "content-type": "text/plain" } })).status, 415);
  assert.equal(f.calls.length, 0);
  assert.equal((await f.request(route, { method: "POST", payload })).status, 202);
  assert.deepEqual(f.calls[0], ["request", payload, { collectMissing: false, reason: "manual" }]);
  assert.equal((await f.request(route, { method: "POST", payload: { ...payload, collectMissing: true } })).status, 202);
  assert.equal(f.calls[1][2].collectMissing, true);
});
test("invalid flags/unknown fields cannot trigger providers; errors never expose secrets", async () => {
  const f = fixture();
  assert.equal((await f.request("/api/regional-analysis/refresh", { method: "POST", payload: { regionKey: "pocheon", collectMissing: "false" } })).status, 400);
  assert.equal((await f.request("/api/regional-analysis/policy", { method: "POST", payload: { regionKey: "pocheon", token: "secret" } })).status, 400);
  assert.equal(f.calls.length, 0);
  f.service.get = async () => { throw Object.assign(new Error("token=secret"), { code: "token=secret" }); };
  const result = await f.request("/api/regional-analysis?regionKey=pocheon");
  assert.equal(result.status, 500); assert.ok(!JSON.stringify(result).includes("token=secret"));
});
test("malformed JSON is a client error and cannot create work", async () => {
  let requests = 0, status;
  const handle = createRegionalAnalysisHttpHandler({ service: { request: async () => { requests++; } }, requireAdmin: () => true,
    parseJsonBody: async () => { throw new SyntaxError("Unexpected token secret"); }, send: (res, code) => { status = code; } });
  await handle({ method: "POST", headers: { host: "localhost", "content-type": "application/json" } }, {}, new URL("http://localhost/api/regional-analysis/refresh"), {});
  assert.equal(status, 400); assert.equal(requests, 0);
});
