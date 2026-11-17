"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { sanitizeKeywordMonthlyGuardDiagnostic, withKeywordMonthlyGuardDiagnostic } = require("./lib/keyword_monthly_guard_diagnostics.cjs");
const { createKeywordMonthlyMemoryAdmission, readKeywordMonthlyMemoryAdmissionState } = require("./lib/keyword_monthly_memory_admission.cjs");
const { createAnalyticalWorkScheduler } = require("./lib/analytical_work_scheduler.cjs");
const { createKeywordMonthlyHttpHandler } = require("./lib/keyword_monthly_http.cjs");
const { createKeywordMonthlySavedReadService } = require("./lib/keyword_monthly_saved_read_service.cjs");
const { EventEmitter } = require("node:events");
const gate = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { resolve, promise }; };
const turn = () => new Promise(resolve => setImmediate(resolve));
async function until(check) { for (let n = 0; n < 100; n++) { if (check()) return; await turn(); } assert.fail("synthetic state did not settle"); }

test("reading uninitialized shared memory diagnostics neither creates a sampler nor changes state", () => {
  const first = readKeywordMonthlyMemoryAdmissionState(), second = readKeywordMonthlyMemoryAdmissionState();
  assert.deepEqual(first, { initialized: false, sampledAt: null, ratio: null, paused: null, lowSamples: null, reason: null });
  assert.deepEqual(second, first); assert.ok(Object.isFrozen(first));
});

test("the diagnostic whitelist discards tokens, unknown kinds, raw memory and arbitrary error text", () => {
  const value = { component: "scheduler", reason: "atomic_work", observedAt: 1000, activeKind: "private-owner-token",
    ownerToken: "private-token", stack: "private-stack", flags: { atomicWork: true, externalChecking: false, ownerMatches: true, extra: "private-extra" } };
  const safe = sanitizeKeywordMonthlyGuardDiagnostic(value);
  assert.equal(safe.activeKind, "other"); assert.equal(safe.observedAt, "1970-01-01T00:00:01.000Z");
  assert.deepEqual(safe.flags, { externalChecking: false, maintenancePaused: null, checkpointReaderActive: null, atomicWork: true, ownerMatches: true });
  assert.ok(!JSON.stringify(safe).includes("private")); assert.ok(Object.isFrozen(safe)); assert.ok(Object.isFrozen(safe.flags));
  for (const bad of [null, {}, { ...value, reason: "private-detail" }, { ...value, component: "private-component" },
    Object.defineProperty({}, "component", { get() { throw Error("private getter"); } })]) assert.equal(sanitizeKeywordMonthlyGuardDiagnostic(bad), null);
  const frozen = Object.freeze(Object.assign(Error("original"), { code: "KEYWORD_MONTHLY_ANALYTICAL_BUSY" }));
  assert.equal(withKeywordMonthlyGuardDiagnostic(frozen, value), frozen); assert.equal(frozen.code, "KEYWORD_MONTHLY_ANALYTICAL_BUSY");
});

test("65/55 percent and two-low-sample hysteresis remain unchanged and failures retain their own snapshots", async () => {
  const ratios = [0.65, 0.55, 0.55]; let n = 0, allocations = 0;
  const guard = createKeywordMonthlyMemoryAdmission({ now: () => 1000, sampleMemory: () => ({ ratio: ratios[n++], sampledAt: 1000 }) });
  let high, low;
  await guard.run(() => allocations++).catch(error => { high = error; });
  await guard.run(() => allocations++).catch(error => { low = error; });
  assert.equal(high.code, "KEYWORD_MONTHLY_MEMORY_DEFERRED"); assert.equal(high.readGuard.reason, "high_watermark");
  assert.deepEqual(high.readGuard.memory, { sampledAt: 1000, ratio: 0.65, paused: true, lowSamples: 0 });
  assert.equal(low.readGuard.reason, "low_watermark_recovery_pending"); assert.equal(low.readGuard.memory.lowSamples, 1);
  assert.equal(allocations, 0); await guard.run(() => allocations++); assert.equal(allocations, 1);
  assert.equal(guard.status().paused, false); assert.equal(guard.status().reason, null);
  assert.equal(guard.status().highWatermark, 0.65); assert.equal(guard.status().lowWatermark, 0.55); assert.equal(guard.status().resumeSamples, 2);
  assert.equal(high.readGuard.memory.ratio, 0.65); assert.equal(high.readGuard.memory.lowSamples, 0);
});

test("invalid and unavailable samples still fail closed and expose only classified null memory values", async () => {
  const cases = [[() => null, "sample_invalid"], [() => ({ ratio: NaN, sampledAt: 1000 }), "sample_invalid"],
    [() => ({ ratio: .2, sampledAt: -10001 }), "sample_stale"], [() => ({ ratio: .2, sampledAt: 3000 }), "sample_future"],
    [() => { throw Error("private cgroup value"); }, "sample_read_failed"]];
  for (const [sampleMemory, reason] of cases) {
    const guard = createKeywordMonthlyMemoryAdmission({ now: () => 1000, sampleMemory });
    await assert.rejects(guard.run(() => assert.fail("unsafe allocation")), error => {
      assert.equal(error.code, "KEYWORD_MONTHLY_MEMORY_UNAVAILABLE"); assert.equal(error.readGuard.reason, reason);
      assert.deepEqual(error.readGuard.memory, { sampledAt: null, ratio: null, paused: true, lowSamples: 0 });
      assert.ok(!JSON.stringify(error.readGuard).includes("private")); return true;
    });
  }
});

test("external admission checking and maintenance retain the same denials with distinct safe reasons", async () => {
  const checking = gate(), scheduler = createAnalyticalWorkScheduler({ externalAdmission: () => checking.promise });
  const pending = scheduler.run(() => 1, { kind: "industry-build", priority: "background" });
  await until(() => scheduler.status().maintenance.checking);
  assert.throws(() => scheduler.acquireSavedReadPermit(), error => error.code === "KEYWORD_MONTHLY_ANALYTICAL_BUSY"
    && error.readGuard.reason === "external_checking" && error.readGuard.flags.externalChecking === true);
  checking.resolve({ allowed: true, reasonCode: null }); assert.equal(await pending, 1); await scheduler.close();
  const held = createAnalyticalWorkScheduler({ externalAdmission: () => ({ allowed: false, reasonCode: "KEYWORD_INCREMENTAL_PREPARED_CONVERSION_ACTIVE" }) });
  const waiting = held.run(() => assert.fail("maintenance bypass"), { kind: "industry-build", priority: "background" });
  const stopped = assert.rejects(waiting, { code: "ANALYTICAL_WORK_CLOSED" });
  await until(() => held.status().maintenance.paused && !held.status().maintenance.checking);
  assert.throws(() => held.acquireSavedReadPermit(), error => error.code === "KEYWORD_MONTHLY_ANALYTICAL_BUSY"
    && error.readGuard.reason === "maintenance" && error.readGuard.flags.maintenancePaused === true);
  await held.close(); await stopped;
});

async function httpFailure({ failure, result, authorized = true } = {}) {
  let calls = 0; const response = { setHeader() {} };
  const invoke = async () => { calls++; if (failure) throw failure; return result; };
  const handler = createKeywordMonthlyHttpHandler({ service: { options: invoke, analyze: invoke }, requireAdmin: () => authorized,
    send: (res, status, body) => Object.assign(res, { status, body }) });
  await handler({ method: "GET" }, response, new URL("https://example.test/api/keyword-monthly/options"), {});
  return { response, calls };
}
test("authenticated 503 responses preserve safe failure-time diagnostics without exposing generic errors", async () => {
  const failure = withKeywordMonthlyGuardDiagnostic(Object.assign(Error("private message"), { code: "KEYWORD_MONTHLY_ANALYTICAL_BUSY" }),
    { component: "scheduler", reason: "atomic_work", activeKind: "industry-build", observedAt: 1000, flags: { atomicWork: true } });
  const { response } = await httpFailure({ failure }); assert.equal(response.status, 503);
  assert.equal(response.body.code, failure.code); assert.equal(response.body.readGuard.reason, "atomic_work");
  assert.equal(response.body.readGuard.activeKind, "industry-build"); assert.equal(response.body.snapshot, null);
  assert.equal(response.body.readOnly, true); assert.equal(response.body.networkAttempted, false);
  assert.ok(!JSON.stringify(response.body).includes("private"));
  const generic = await httpFailure({ failure: Error("private stack and token") }); assert.equal(generic.response.status, 503);
  assert.equal(Object.hasOwn(generic.response.body, "readGuard"), false);
  const unauthorized = await httpFailure({ failure, authorized: false }); assert.equal(unauthorized.calls, 0);
});

test("a guard snapshot carried by a failure DTO is re-whitelisted while its existing status and values remain unchanged", async () => {
  const result = { status: "needs_verification", snapshot: null, observations: 0, diagnostics: ["KEYWORD_MONTHLY_MEMORY_DEFERRED"],
    readGuard: { component: "memory", reason: "high_watermark", observedAt: 1000, activeKind: null,
      memory: { sampledAt: 1000, ratio: .7, paused: true, lowSamples: 0, rawCgroup: "private value" }, token: "private token" } };
  const { response } = await httpFailure({ result }); assert.equal(response.status, 503);
  assert.equal(response.body.observations, 0); assert.equal(response.body.snapshot, null);
  assert.deepEqual(response.body.diagnostics, result.diagnostics); assert.equal(response.body.readGuard.memory.ratio, .7);
  assert.ok(!JSON.stringify(response.body).includes("private")); assert.equal(result.readGuard.token, "private token");
  const invalid = await httpFailure({ result: { ...result, readGuard: { component: "memory", reason: "private reason" } } });
  assert.equal(Object.hasOwn(invalid.response.body, "readGuard"), false);
});

test("cohort denial records the original window decision without sampling its permit twice", async () => {
  for (const accepting of [false, true]) {
    let checks = 0, releases = 0;
    const permit = { run: async operation => operation(), acceptsNewResponses() { checks++; return accepting; }, release() { releases++; } };
    const service = createKeywordMonthlySavedReadService({ saved: { options: async () => ({ status: "available" }), readPrepared: async () => {}, analyze: async () => {} },
      acquirePermit: () => permit, assertReadAdmission: async () => {}, runMemoryAdmission: async operation => operation(), runWork: async operation => operation() });
    const res = new EventEmitter(); res.writeHead = () => {}; res.end = () => {};
    await service.withResponse("same", res, async () => { await service.options(); service.lifecycleOptions().onOperationSettled(); });
    await assert.rejects(service.withResponse("same", res, () => assert.fail("late response admitted")), error => {
      assert.equal(error.code, "KEYWORD_MONTHLY_ANALYTICAL_BUSY");
      assert.equal(error.readGuard.reason, accepting ? "response_flight_settled" : "response_window_closed"); return true;
    });
    assert.equal(checks, 1); res.emit("finish"); assert.equal(releases, 1); assert.equal(service.status().active, false);
  }
});
