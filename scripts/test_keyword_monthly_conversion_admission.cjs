"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { waitForConversionIdle, statusSnapshot, loopbackRequest } = require("./lib/keyword_monthly_conversion_admission.cjs");
const environment = { GLAMPING_ADMIN_USER: "fixture-admin", GLAMPING_ADMIN_PASSWORD: "fixture-secret-memory-only" };
function state() { return [{ work: { closed: false, active: false, activeCheckpointReadKind: null, sampling: false, queuedForeground: 3, queuedBackground: 7,
  maintenance: { enabled: true, checking: false, paused: false } } }, { workers: ["manual", "scheduled", "web"].map(workerKey => ({ workerKey, activeJobId: null,
  queued: 0, crawl: { active: false, queueLength: 0 } })) }, { active: false, counts: { complete: 10, held: 1 } }]; }
function transportFor(getStates, requests) { return async request => {
  requests.push({ pathname: request.pathname, timeoutMs: request.timeoutMs, hasCookie: Boolean(request.cookie) });
  if (request.pathname === "/api/login") { assert.deepEqual(request.body, { username: environment.GLAMPING_ADMIN_USER, password: environment.GLAMPING_ADMIN_PASSWORD });
    return { statusCode: 200, json: { ok: true, role: "admin" }, headers: { "set-cookie": ["fixture=session-memory; HttpOnly; Secure"] } }; }
  assert.equal(request.cookie, "fixture=session-memory"); const values = getStates();
  return { statusCode: 200, json: values[["/api/analytical-work", "/api/collector-status", "/api/collection-postprocess"].indexOf(request.pathname)] };
}; }
test("maintenance gate accepts held analysis queues only after every running/checking lane is idle", async () => {
  let clock = 0, sleeps = 0, batches = 0; const requests = [], initial = state(); initial[0].work.active = true; initial[0].work.maintenance.checking = true;
  const transport = transportFor(() => (++batches > 3 ? state() : initial), requests);
  const result = await waitForConversionIdle({ transport, environment, now: () => clock, sleep: async ms => { assert.ok(ms <= 1000); clock += ms; sleeps++; } });
  assert.equal(result.idle, true); assert.equal(result.polls, 2); assert.equal(sleeps, 1); assert.equal(result.heldForeground, 3); assert.equal(result.heldBackground, 7);
  assert.ok(requests.every(row => row.timeoutMs <= 3000)); assert.ok(!JSON.stringify(result).includes(environment.GLAMPING_ADMIN_PASSWORD));
  assert.ok(!JSON.stringify(result).includes("session-memory"));
});
test("explicit credentials are required; no application fallback credentials or repeated login are used", async () => {
  let calls = 0; await assert.rejects(waitForConversionIdle({ environment: {}, transport: async () => { calls++; } }), /LOCAL_AUTH_REQUIRED/); assert.equal(calls, 0);
  await assert.rejects(waitForConversionIdle({ environment, transport: async () => { calls++; return { statusCode: 401, json: { ok: false } }; } }), /LOCAL_AUTH_REQUIRED/); assert.equal(calls, 1);
});
test("disabled or unverified maintenance and unknown source state fail closed", () => {
  for (const mutate of [s => { s[0].work.maintenance.enabled = false; }, s => { delete s[0].work.activeCheckpointReadKind; },
    s => { s[1].workers.pop(); }, s => { delete s[1].workers[0].crawl.active; }, s => { s[1].workers[0].errorCode = "COLLECTOR_STATE_UNKNOWN"; },
    s => { s[2].errorCode = "POSTPROCESS_UNKNOWN"; }]) { const s = state(); mutate(s); assert.throws(() => statusSnapshot(...s)); }
});
test("collectors and postprocess active or pending jobs never count as idle", () => {
  for (const mutate of [s => { s[1].workers[0].activeJobId = "fixture-active"; }, s => { s[1].workers[1].queued = 1; },
    s => { s[1].workers[2].crawl.queueLength = 1; }, s => { s[2].active = true; }, s => { s[2].counts.queued = 1; },
    s => { s[0].work.activeCheckpointReadKind = "fixture_read"; }, s => { s[0].work.sampling = true; }]) {
    const s = state(); mutate(s); assert.equal(statusSnapshot(...s).idle, false);
  }
});
test("a closed or unknown scheduler cannot authorize prepared conversion", async () => {
  const closed = state(); closed[0].work.closed = true; assert.equal(statusSnapshot(...closed).idle, false);
  const unknown = state(); delete unknown[0].work.closed; assert.throws(() => statusSnapshot(...unknown), /MAINTENANCE_UNVERIFIED/);
  let clock = 0; await assert.rejects(waitForConversionIdle({ transport: transportFor(() => closed, []), environment, now: () => clock,
    timeoutMs: 1000, sleep: async ms => { clock += ms; } }), /BUSY_TIMEOUT/);
});
test("busy waiting is bounded at sixty seconds and never sleeps more than one second", async () => {
  let clock = 0, requests = []; const states = state(); states[1].workers[0].queued = 1;
  await assert.rejects(waitForConversionIdle({ transport: transportFor(() => states, requests), environment, now: () => clock,
    sleep: async ms => { assert.ok(ms <= 1000); clock += ms; } }), /BUSY_TIMEOUT/);
  assert.equal(clock, 60000); assert.equal(requests.filter(row => row.pathname === "/api/login").length, 1);
});
test("loopback transport cannot call any provider, arbitrary local path or mutation endpoint", () => {
  for (const request of [{ pathname: "https://provider.invalid" }, { pathname: "/api/crawl", method: "POST" },
    { pathname: "/api/analytical-work", method: "POST" }, { pathname: "/api/login", method: "GET" }, { pathname: "/api/analytical-work", timeoutMs: 60000 }]) assert.throws(() => loopbackRequest(request));
});
