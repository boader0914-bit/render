"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { Readable } = require("node:stream");
const { createRegionalCatchmentHttpHandler, readBoundedJson, MAX_IMPORT_BYTES } = require("./lib/regional_catchment_http.cjs");
function setup() {
  const calls = [], replies = [];
  const service = Object.fromEntries(["get", "configure", "importDataset", "request"].map(method => [method, async value => { calls.push({ method, value }); return method === "request" ? { job: { status: "queued" } } : { result: method }; }]));
  let regularParses = 0;
  const handler = createRegionalCatchmentHttpHandler({ service,
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

test("8MiB import guard responds 413 without calling service", async () => {
  const env = setup();
  const result = await env.invoke("/api/regional-catchment/datasets", { method: "POST", headers: { "content-length": String(MAX_IMPORT_BYTES + 1) } });
  assert.equal(result.reply.status, 413); assert.equal(env.calls.length, 0);
  assert.equal(result.reply.body.code, "CATCHMENT_IMPORT_TOO_LARGE");
});
