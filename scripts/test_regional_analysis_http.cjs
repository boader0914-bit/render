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

test("outlook namespace keeps administrator and origin checks without adding a policy endpoint", async () => {
  const calls = [], replies = [];
  const handle = createRegionalAnalysisHttpHandler({ basePath: "/api/regional-outlook", allowPolicy: false,
    service: { get: async input => { calls.push(["get", input]); return { snapshot: null }; }, request: async (...args) => { calls.push(["request", ...args]); return { job: { status: "queued" } }; } },
    requireAdmin: (session, req, res) => { if (session?.role === "admin") return true; replies.push(403); return false; },
    parseJsonBody: async req => req.payload, send: (res, status) => replies.push(status) });
  const req = { method: "GET", headers: { host: "localhost", "content-type": "application/json" }, payload: { regionKey: "pocheon", collectMissing: false } };
  const invoke = (route, request = req, session = { role: "admin" }) => handle(request, {}, new URL(route, "http://localhost"), session);
  await invoke("/api/regional-outlook?regionKey=pocheon"); assert.deepEqual(calls[0], ["get", { regionKey: "pocheon" }]);
  await invoke("/api/regional-outlook?regionKey=pocheon", req, { role: "b2b" }); assert.equal(replies.at(-1), 403);
  await invoke("/api/regional-outlook/refresh", { ...req, method: "POST", headers: { ...req.headers, origin: "https://foreign.invalid" } }); assert.equal(replies.at(-1), 403);
  assert.equal(calls.length, 1);
  await invoke("/api/regional-outlook/refresh", { ...req, method: "POST" }); assert.equal(replies.at(-1), 202);
  assert.deepEqual(calls[1], ["request", { regionKey: "pocheon" }, { collectMissing: false, reason: "manual" }]);
  assert.equal(await invoke("/api/regional-outlook/policy", { ...req, method: "POST" }), false);
  assert.equal(await invoke("/api/regional-analysis?regionKey=pocheon"), false);
});

test("validation routes inherit admin/origin/JSON checks and categorically reject provider refresh", async () => {
  let calls = 0, status, data;
  const handle = createRegionalAnalysisHttpHandler({ basePath: "/api/regional-outlook/validation", cacheOnly: true, allowPolicy: false,
    service: { get: async () => { calls++; return { snapshot: null }; }, request: async (input, options) => { calls++; assert.equal(options.collectMissing, false); return { job: { status: "queued" } }; } },
    requireAdmin: (session, req, res) => { if (session?.role === "admin") return true; status = 403; return false; },
    parseJsonBody: async req => req.payload, send: (res, code, body) => { status = code; data = body; } });
  const route = "/api/regional-outlook/validation", req = { method: "POST", headers: { host: "localhost", "content-type": "application/json" }, payload: { regionKey: "sancheong" } };
  const invoke = (suffix, request = req, session = { role: "admin" }) => handle(request, {}, new URL(route + suffix, "http://localhost"), session);
  await invoke("/refresh", req, { role: "b2b" }); assert.equal(status, 403);
  await invoke("/refresh", { ...req, headers: { ...req.headers, origin: "https://evil.invalid" } }); assert.equal(status, 403);
  await invoke("/refresh", { ...req, headers: { ...req.headers, "content-type": "text/plain" } }); assert.equal(status, 415);
  await invoke("/refresh", { ...req, payload: { ...req.payload, collectMissing: true } }); assert.equal(status, 400); assert.equal(calls, 0);
  await invoke("?regionKey=sancheong&regionKey=other", { ...req, method: "GET" }); assert.equal(status, 400); assert.equal(calls, 0);
  await invoke("?regionKey=sancheong", { ...req, method: "GET" }); assert.equal(status, 200); assert.equal(data.snapshot, null);
  await invoke("/refresh"); assert.equal(status, 202); assert.equal(calls, 2);
  assert.equal(await invoke("/policy"), false);
});
