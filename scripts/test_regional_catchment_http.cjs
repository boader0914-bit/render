"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { Readable } = require("node:stream");
const { createRegionalCatchmentHttpHandler, readBoundedJson, MAX_IMPORT_BYTES } = require("./lib/regional_catchment_http.cjs");
function setup({ readAddressTargets, rateLimit } = {}) {
  const calls = [], replies = [];
  const service = Object.fromEntries(["get", "configure", "importDataset", "request"].map(method => [method, async value => { calls.push({ method, value }); return method === "request" ? { job: { status: "queued" } } : { result: method }; }]));
  let regularParses = 0;
  const handler = createRegionalCatchmentHttpHandler({ service, readAddressTargets, rateLimit,
    requireAdmin: (session, req, res) => { if (session?.admin) return true; replies.push({ status: 401 }); return false; },
    parseJsonBody: async req => { regularParses++; return JSON.parse(req.body || "{}"); }, send: (res, status, body) => replies.push({ status, body }) });
  async function invoke(route, { method = "GET", payload = {}, headers = {}, admin = true, bytes } = {}) {
    const req = Readable.from([bytes || Buffer.from(JSON.stringify(payload))]); req.method = method;
    req.headers = { host: "staydatalab.kr", "content-type": "application/json", origin: "https://staydatalab.kr", ...headers }; req.body = JSON.stringify(payload);
    const handled = await handler(req, {}, new URL(route, "https://staydatalab.kr"), { admin, username: "local-test" });
    return { handled, reply: replies.at(-1) };
  }
  return { calls, replies, invoke, regularParses: () => regularParses };
}

test("administrator GET only reads saved scope and never starts computation", async () => {
  const env = setup(); const result = await env.invoke("/api/regional-catchment?regionKey=r1");
  assert.equal(result.reply.status, 200); assert.deepEqual(env.calls, [{ method: "get", value: { regionKey: "r1" } }]);
  for (const query of ["regionKey=r1&refresh=true", "regionKey=r1&regionKey=r2", "month=2026-09", ""]) {
    const bad = await env.invoke(`/api/regional-catchment?${query}`); assert.equal(bad.reply.status, 400);
  }
  const unauthorized = await env.invoke("/api/regional-catchment?regionKey=r1", { admin: false }); assert.equal(unauthorized.reply.status, 401);
  assert.equal(env.calls.length, 1);
});

test("POST uses strict routes, same origin and JSON; unrelated route is untouched", async () => {
  const env = setup();
  assert.equal((await env.invoke("/api/regional-catchment/refresh", { method: "POST", payload: { regionKey: "r1" } })).reply.status, 202);
  assert.equal((await env.invoke("/api/regional-catchment/configure", { method: "POST" })).reply.status, 200);
  assert.equal(env.regularParses(), 2);
  assert.equal((await env.invoke("/api/regional-catchment/datasets", { method: "POST", payload: { id: "test" } })).reply.status, 201);
  assert.equal(env.regularParses(), 2);
  assert.equal((await env.invoke("/api/regional-catchment/refresh", { method: "POST", headers: { origin: "https://evil.example" } })).reply.status, 403);
  assert.equal((await env.invoke("/api/regional-catchment/refresh", { method: "POST", headers: { "content-type": "text/plain" } })).reply.status, 415);
  assert.equal((await env.invoke("/api/regional-catchment/refresh?regionKey=r1", { method: "POST" })).reply.status, 400);
  assert.equal((await env.invoke("/api/regional-catchment", { method: "POST" })).reply.status, 405);
  assert.equal((await env.invoke("/api/regional-catchment/datasets", { method: "GET" })).reply.status, 405);
  assert.equal((await env.invoke("/api/unrelated")).handled, false);
  assert.equal(env.calls.length, 3);
});

test("company scope GET is explicit and repeated or blank scope keys are rejected", async () => {
  const env = setup();
  assert.equal((await env.invoke("/api/regional-catchment?regionKey=r1&companyId=c1")).reply.status, 200);
  assert.deepEqual(env.calls, [{ method: "get", value: { regionKey: "r1", companyId: "c1" } }]);
  for (const query of ["regionKey=r1&companyId=", "regionKey=r1&companyId=c1&companyId=c2", "regionKey=r1&address=another", "companyId=c1"]) {
    assert.equal((await env.invoke(`/api/regional-catchment?${query}`)).reply.status, 400);
  }
  assert.equal(env.calls.length, 1);
});

test("address targets are admin-only, read-only, strictly scoped and limited to option fields", async () => {
  const reads = [], env = setup({ readAddressTargets: async regionKey => { reads.push(regionKey); return { addresses: [
    { companyId: "c1", label: "등록 업체", address: "경상남도 산청군 산청읍 산청대로 1", status: "ready", phone: "must-not-leak", raw: { hidden: true } },
    { companyId: "c2", label: "주소 여러 개", address: "unconfirmed-address", status: "ambiguous" }
  ], rawCompanies: ["must-not-leak"] }; } });
  const result = await env.invoke("/api/regional-catchment/addresses?regionKey=r1");
  assert.equal(result.reply.status, 200); assert.deepEqual(reads, ["r1"]); assert.equal(env.calls.length, 0);
  assert.deepEqual(result.reply.body, { addresses: [
    { companyId: "c1", label: "등록 업체", address: "경상남도 산청군 산청읍 산청대로 1", status: "ready" },
    { companyId: "c2", label: "주소 여러 개", address: "", status: "ambiguous" }
  ] });
  assert.equal((await env.invoke("/api/regional-catchment/addresses?regionKey=r1", { admin: false })).reply.status, 401);
  assert.equal((await env.invoke("/api/regional-catchment/addresses?regionKey=r1", { method: "POST" })).reply.status, 405);
  for (const query of ["", "regionKey=r1&companyId=c1", "regionKey=r1&regionKey=r2", "regionKey=r1&refresh=true"]) {
    assert.equal((await env.invoke(`/api/regional-catchment/addresses?${query}`)).reply.status, 400);
  }
  assert.deepEqual(reads, ["r1"]); assert.equal(env.regularParses(), 0);
});

test("address lookup failure is unavailable rather than an empty target list", async () => {
  const env = setup({ readAddressTargets: async () => ({ addresses: [{ companyId: "c1", label: "업체", status: "ready", address: "" }] }) });
  const result = await env.invoke("/api/regional-catchment/addresses?regionKey=r1");
  assert.equal(result.reply.status, 503); assert.equal(result.reply.body.code, "CATCHMENT_ADDRESS_TARGETS_UNAVAILABLE");
});

test("configure retains optional company scope while origin and write rate guards stay active", async () => {
  let checks = 0; const env = setup({ rateLimit: () => { checks++; } });
  const value = { regionKey: "r1", companyId: "c1", center: { address: "확인한 업체 주소" } };
  assert.equal((await env.invoke("/api/regional-catchment/configure", { method: "POST", payload: value })).reply.status, 200);
  assert.deepEqual(env.calls, [{ method: "configure", value }]); assert.equal(checks, 1);
  assert.equal((await env.invoke("/api/regional-catchment/configure", { method: "POST", payload: value, headers: { origin: "https://other.example" } })).reply.status, 403);
  assert.equal(checks, 1); assert.equal(env.calls.length, 1);
});

test("dataset reader enforces byte size, content length, UTF8 and stream failures", async () => {
  await assert.rejects(readBoundedJson(Object.assign(Readable.from([Buffer.alloc(9)]), { headers: {} }), 8), { code: "CATCHMENT_IMPORT_TOO_LARGE", statusCode: 413 });
  await assert.rejects(readBoundedJson(Object.assign(Readable.from([]), { headers: { "content-length": String(MAX_IMPORT_BYTES + 1) } })), { statusCode: 413 });
  await assert.rejects(readBoundedJson(Object.assign(Readable.from([Buffer.from([0xff, 0xfe])]), { headers: {} })), { code: "CATCHMENT_INVALID_JSON" });
  await assert.rejects(readBoundedJson(Object.assign(Readable.from([Buffer.from("{")]), { headers: {} })), { code: "CATCHMENT_INVALID_JSON" });
  const bad = new Readable({ read() { this.destroy(new Error("secret detail")); } }); bad.headers = {};
  await assert.rejects(readBoundedJson(bad), { code: "CATCHMENT_INVALID_JSON" });
  const value = await readBoundedJson(Object.assign(Readable.from([Buffer.from('{"지역":"산청"}')]), { headers: {} }));
  assert.equal(value.지역, "산청");
});

test("16MiB import guard responds 413 without calling service", async () => {
  assert.equal(MAX_IMPORT_BYTES, 16 * 1024 * 1024);
  const env = setup();
  const result = await env.invoke("/api/regional-catchment/datasets", { method: "POST", headers: { "content-length": String(MAX_IMPORT_BYTES + 1) } });
  assert.equal(result.reply.status, 413); assert.equal(env.calls.length, 0);
  assert.equal(result.reply.body.code, "CATCHMENT_IMPORT_TOO_LARGE");
  assert.match(result.reply.body.error, /16MiB/);
});

test("a bounded body larger than the former 8MiB limit is accepted without truncation", async () => {
  const value = "가".repeat(3 * 1024 * 1024), bytes = Buffer.from(JSON.stringify({ value }));
  assert.ok(bytes.length > 8 * 1024 * 1024 && bytes.length < MAX_IMPORT_BYTES);
  const parsed = await readBoundedJson(Object.assign(Readable.from([bytes.subarray(0, 1024), bytes.subarray(1024)]), { headers: { "content-length": String(bytes.length) } }));
  assert.equal(parsed.value, value);
});

test("only one large import is retained while saved GET remains responsive and the gate is released", async () => {
  let release, imports = 0;
  const held = new Promise(resolve => { release = resolve; });
  const replies = new Map(), service = { get: async () => ({ status: "ready" }), importDataset: async () => { imports++; await held; return {}; } };
  const handle = createRegionalCatchmentHttpHandler({ service, requireAdmin: () => true, parseJsonBody: async () => ({}), send: (res, status, body) => { replies.set(res, { status, body }); } });
  function req(method) { const stream = Readable.from([Buffer.from('{}')]); stream.method = method; stream.headers = { host: "localhost", "content-type": "application/json" }; return stream; }
  const firstResponse = {}, first = handle(req("POST"), firstResponse, new URL("http://localhost/api/regional-catchment/datasets"), {});
  await new Promise(resolve => setImmediate(resolve)); assert.equal(imports, 1);
  const secondResponse = {}; await handle(req("POST"), secondResponse, new URL("http://localhost/api/regional-catchment/datasets"), {});
  assert.equal(replies.get(secondResponse).status, 429); assert.equal(replies.get(secondResponse).body.code, "CATCHMENT_IMPORT_BUSY"); assert.equal(imports, 1);
  const readResponse = {}; await handle(req("GET"), readResponse, new URL("http://localhost/api/regional-catchment?regionKey=r1"), {}); assert.equal(replies.get(readResponse).status, 200);
  release(); await first; assert.equal(replies.get(firstResponse).status, 201);
  const afterResponse = {}; await handle(req("POST"), afterResponse, new URL("http://localhost/api/regional-catchment/datasets"), {}); assert.equal(replies.get(afterResponse).status, 201); assert.equal(imports, 2);
});
