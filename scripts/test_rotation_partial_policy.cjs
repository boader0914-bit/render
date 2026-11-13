"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { createCollectionRotationScheduler, defaultConfig, MIN_FREE_BYTES } = require("./collection_rotation_scheduler.cjs");
const { inspectManifest, allowsDerivedUpdates } = require("./daily_collection_quality.cjs");
const { partialContinuationEvidence, sanitizePartialContinuation, PARTIAL_POLICY } = require("./lib/rotation_partial_policy.cjs");

function fixture({ products = 247, days = 21, failed = 1, affected = 1 } = {}) {
  const start = Date.parse("2026-11-11T00:00:00Z");
  const targets = Array.from({ length: affected }, (_, index) => {
    const eligible = Math.floor(products / affected) + (index === 0 ? products % affected : 0);
    const failures = failed === 0 ? 0 : Math.floor(failed / affected) + (index === 0 ? failed % affected : 0);
    return { businessId: String(index + 1), productListComplete: true, discovered: eligible, eligible, excluded: 0,
      queried: eligible, truncated: 0, expectedDays: days,
      days: Array.from({ length: days }, (_, day) => ({ date: new Date(start + day * 86400000).toISOString().slice(0, 10),
        eligible, queried: eligible, succeeded: eligible - Math.min(eligible, Math.max(0, failures - day * eligible)),
        failed: Math.min(eligible, Math.max(0, failures - day * eligible)), truncated: 0 })) };
  });
  const output = { schemaVersion: 2, outputDir: "/tmp/test_run", scheduledCollection: true, keyword: "가평글램핑",
    checkIn: "2026-11-11", checkOut: new Date(start + (days - 1) * 86400000).toISOString().slice(0, 10), bookingRangeDays: days,
    naverAttemptedQueries: [{ status: 200 }],
    counts: { naverOverall: 50, naverBookingStockChecked: affected, naverBookingStockSucceeded: affected,
      naverOtaObservationChecked: 20, naverOtaBlocked: 0, naverOtaFailed: 0,
      naverScheduleRequested: products * days, naverScheduleSucceeded: products * days - failed,
      naverScheduleFailed: failed, naverScheduleBlocked: 0 },
    requestPacing: { guardEnabled: true, stopped: false, blockedCode: null, blockedStatus: null, inFlight: 0, queued: 0,
      requestTimeline: { complete: true, snapshotInFlight: 0, snapshotQueued: 0, restrictionEvents: [], restrictionEventsTruncated: false } },
    productCoverage: { version: 1, discovered: products, eligible: products, excluded: 0, queried: products, truncated: 0, targets } };
  const value = { runId: "test_run", output };
  return { output, value, inspect: () => partialContinuationEvidence(value, inspectManifest(output), {}) };
}

function mainUnavailable(output, status = 500) {
  for (const key of Object.keys(output.counts)) output.counts[key] = 0;
  output.productCoverage = { version: 1, targets: [], discovered: 0, eligible: 0, excluded: 0, queried: 0, truncated: 0 };
  output.naverAttemptedQueries = [{ status }];
}

test("one missing schedule out of 5187 permits only scheduling continuation and stays partial for derived data", () => {
  const f = fixture(), before = structuredClone(f.output), quality = inspectManifest(f.output);
  assert.equal(quality.status, "partial");
  assert.equal(quality.reason, "booking_schedule_responses_incomplete");
  assert.deepEqual(f.inspect(), { policyVersion: PARTIAL_POLICY.policyVersion, decision: "continue",
    reasonCode: "ROTATION_PARTIAL_CONTINUED", failedSchedules: 1, requestedSchedules: 5187,
    affectedCompanies: 1, consecutivePartialRuns: 0, previousSlotId: null, responseReason: "booking_schedule_responses_incomplete",
    missingBookingResults: 0, failedOtaRequests: 0 });
  assert.equal(allowsDerivedUpdates(f.output), false);
  assert.deepEqual(f.output, before);
});

test("ordinary response missing continues regardless of count, ratio, affected businesses or zero schedule successes", () => {
  for (const [options, allowed] of [
    [{ products: 1000, days: 1 }, true], [{ products: 999, days: 1 }, true],
    [{ products: 3000, days: 1, failed: 3 }, true], [{ products: 2999, days: 1, failed: 3 }, true],
    [{ products: 10000, days: 1, failed: 4 }, true], [{ failed: 20, affected: 5 }, true],
    [{ failed: 5187 }, true]
  ]) assert.equal(fixture(options).inspect().decision === "continue", allowed, JSON.stringify(options));
});

test("ordinary booking-stock and OTA response missing keeps its quality and does not require a schedule failure", () => {
  for (const [mutate, reason, status] of [
    [o => { o.counts.naverOtaFailed = 3; }, "auxiliary_ota_incomplete", "partial"],
    [o => { o.counts.naverBookingStockChecked = 2; }, "booking_results_incomplete", "partial"],
    [o => { o.counts.naverBookingStockSucceeded = 0; }, "no_successful_booking_results", "failed"]
  ]) {
    const f = fixture({ failed: 0 }); mutate(f.output);
    const before = structuredClone(f.output), quality = inspectManifest(f.output);
    assert.equal(quality.reason, reason); assert.equal(quality.status, status);
    const decision = f.inspect();
    assert.equal(decision.decision, "continue"); assert.equal(decision.responseReason, reason);
    assert.equal(decision.failedSchedules, 0); assert.equal(allowsDerivedUpdates(f.output), false);
    assert.deepEqual(f.output, before);
  }
  const f = fixture({ failed: 0 }); f.output.counts.naverBookingStockSucceeded = 0;
  f.output.productCoverage = { version: 1, targets: [], discovered: 0, eligible: 0, excluded: 0, queried: 0, truncated: 0 };
  f.output.counts.naverScheduleRequested = 0; f.output.counts.naverScheduleSucceeded = 0;
  assert.equal(f.inspect().decision, "continue", "completed all-booking missing with a reconciled empty schedule scope is not unknown execution");
  assert.equal(f.inspect().missingBookingResults, 1);
  f.output.counts.naverScheduleRequested = 1; f.output.counts.naverScheduleFailed = 1;
  assert.equal(f.inspect().decision, "pause", "a missing target scope cannot hide recorded schedule requests");
  for (const mutate of [
    o => { o.naverAttemptedQueries = []; },
    o => { o.naverAttemptedQueries[0].status = null; },
    o => { o.counts.naverOtaFailed = o.counts.naverOtaObservationChecked + 1; }
  ]) {
    const missing = fixture({ failed: 0 }); missing.output.counts.naverBookingStockSucceeded = 0;
    mutate(missing.output);
    assert.equal(missing.inspect().decision, "pause", mutate.toString());
  }
});

test("only saved empty main scopes with HTTP 408/5xx or successful empty responses may continue", () => {
  for (const status of [200, 408, 500, 503, 599]) {
    const f = fixture(); mainUnavailable(f.output, status);
    const quality = inspectManifest(f.output), decision = f.inspect();
    assert.equal(quality.status, "failed"); assert.equal(decision.decision, "continue", String(status));
    assert.equal(decision.responseReason, status === 200 ? "no_main_results" : "naver_main_request_failed");
    assert.deepEqual(sanitizePartialContinuation(decision), decision);
    for (const key of ["failedSchedules", "requestedSchedules", "affectedCompanies", "missingBookingResults", "failedOtaRequests"]) {
      assert.equal(sanitizePartialContinuation({ ...decision, [key]: 1 }), null, key);
    }
    assert.equal(allowsDerivedUpdates(f.output), false);
  }
  for (const status of [0, 301, 400, 401, 403, 404, 422, 429, 499, 600, null]) {
    const f = fixture(); mainUnavailable(f.output, status);
    assert.equal(f.inspect().decision, "pause", String(status));
  }
  for (const mutate of [
    o => { o.counts.naverBookingStockChecked = 1; },
    o => { o.counts.naverScheduleRequested = 1; o.counts.naverScheduleFailed = 1; },
    o => { o.productCoverage.eligible = 1; },
    o => { o.collectionQuality = { status: "failed", reason: "collection_execution_failed" }; },
    o => { delete o.naverAttemptedQueries; }
  ]) {
    const f = fixture(); mainUnavailable(f.output); mutate(f.output);
    assert.equal(f.inspect().decision, "pause", mutate.toString());
  }
});

test("main response errors cannot bypass exact payload scope even though source quality returns early", () => {
  const expected = { keyword: "가평글램핑", collectionMode: "precision", collectionPurpose: "revenue_detail", productMode: "all",
    checkIn: "2026-11-11", checkOut: "2026-12-01", bookingRangeDays: 21, dayUseMode: "inspect", detailRankRanges: "1-20" };
  for (const key of Object.keys(expected)) {
    const f = fixture(); mainUnavailable(f.output);
    Object.assign(f.output, expected); f.output[key] = key === "bookingRangeDays" ? 22 : "different";
    const quality = inspectManifest(f.output, expected);
    assert.equal(quality.reason, "naver_main_request_failed");
    assert.equal(partialContinuationEvidence(f.value, quality, expected).decision, "pause", key);
  }
});

test("HTTP 200 restriction bodies, missing terminal telemetry and a stopped gate always retain protection", () => {
  const mutations = [
    o => { o.requestPacing.blockedCode = "BookingAPITooManyRequests"; },
    o => { o.requestPacing.blockedCode = "NAVER_CAPTCHA"; },
    o => { o.requestPacing.guardEnabled = false; o.requestPacing.blockedStatus = 429; },
    o => { o.requestPacing.stopped = true; },
    o => { o.requestPacing.requestTimeline.restrictionEvents = [{ code: "BookingAPITooManyRequests", httpStatus: 200 }]; },
    o => { o.requestPacing.requestTimeline.restrictionEventsTruncated = true; },
    o => { o.requestPacing.requestTimeline.complete = false; },
    o => { delete o.requestPacing.requestTimeline; },
    o => { o.requestPacing.requestTimeline.snapshotInFlight = 1; },
    o => { o.requestPacing.queued = 1; },
    o => { o.requestPacing.blockedStatus = 403; },
    o => { o.naverBookingBlockedStatus = 403; },
    o => { o.counts.naverScheduleBlocked = 1; }
  ];
  for (const mutate of mutations) {
    const f = fixture(); mutate(f.output);
    assert.equal(f.inspect().decision, "pause", mutate.toString());
    assert.equal(allowsDerivedUpdates(f.output), false);
  }
});

test("a small schedule error cannot hide booking, OTA, product, date, or evidence defects", () => {
  const mutations = [
    o => { o.counts.naverOtaBlocked = 1; },
    o => { o.counts.naverScheduleRequested++; },
    o => { o.counts.naverScheduleSucceeded = null; },
    o => { o.productCoverage = {}; },
    o => { o.productCoverage.targets[0].productListComplete = false; },
    o => { delete o.productCoverage.targets[0].productListComplete; },
    o => { o.productCoverage.targets[0].truncated = 1; },
    o => { o.productCoverage.targets[0].days[0].queried--; },
    o => { o.productCoverage.targets[0].days[0].failed++; o.productCoverage.targets[0].days[0].succeeded--; },
    o => { o.productCoverage.targets[0].days[0].date = "2026-10-11"; },
    o => { o.productCoverage.targets[0].expectedDays = 20; },
    o => { o.productCoverage.targets[0].businessId = ""; },
    o => { o.outputDir = "/tmp/different_run"; },
    o => { delete o.schemaVersion; },
    o => { o.scheduledCollection = false; },
    o => { o.scheduledCollection = "false"; },
    o => { o.collectionQuality = { status: "blocked", blockedReason: "naver_captcha" }; },
    o => { o.collectionQuality = { status: "partial", counts: { ...o.counts, naverScheduleBlocked: 1 } }; },
    o => { o.collectionQuality = { status: "partial", counts: { ...o.counts, naverOtaBlocked: 1 } }; },
    o => { o.collectionQuality = { status: "partial", counts: { ...o.counts, naverOtaFailed: 1 } }; },
    o => { o.collectionFailed = true; }
  ];
  for (const mutate of mutations) {
    const f = fixture(); mutate(f.output);
    assert.equal(f.inspect().decision, "pause", mutate.toString());
  }
  const f = fixture();
  assert.equal(partialContinuationEvidence(f.value, inspectManifest(f.output), { keyword: "다른글램핑" }).decision, "pause");
  assert.equal(partialContinuationEvidence({ ...f.value, reused: true }, inspectManifest(f.output), {}).decision, "pause");
  for (const key of ["blocked", "providerBlocked", "halted", "protected", "errorCode", "failure"]) {
    assert.equal(partialContinuationEvidence({ ...f.value, [key]: true }, inspectManifest(f.output), {}).decision, "pause", key);
  }
});

test("only internally consistent v2 receipts and preserved historical v1 decisions are projected", () => {
  const good = fixture().inspect();
  assert.deepEqual(sanitizePartialContinuation({ ...good, token: "private" }), good);
  for (const patch of [{ policyVersion: "future" }, { decision: "complete" }, { reasonCode: "unknown" },
    { failedSchedules: -1 }, { requestedSchedules: 0 }, { affectedCompanies: 0 }, { consecutivePartialRuns: 2 },
    { missingBookingResults: null }, { failedOtaRequests: -1 }, { responseReason: "unknown" }]) assert.equal(sanitizePartialContinuation({ ...good, ...patch }), null);
  const historical = { policyVersion: "rotation-partial-v1", decision: "continue", reasonCode: "ROTATION_PARTIAL_CONTINUED",
    failedSchedules: 1, requestedSchedules: 5187, affectedCompanies: 1, consecutivePartialRuns: 1, previousSlotId: null };
  assert.deepEqual(sanitizePartialContinuation(historical), historical);
  assert.equal(sanitizePartialContinuation({ ...historical, failedSchedules: 4 }), null);
  assert.equal(sanitizePartialContinuation({ ...historical, affectedCompanies: 2 }), null);
});

test("malformed nested coverage remains an unverified partial instead of throwing or becoming complete", () => {
  for (const bad of [null, undefined, "invalid"]) {
    const f = fixture(), quality = inspectManifest(f.output);
    f.output.productCoverage.targets[0] = bad;
    const decision = partialContinuationEvidence(f.value, quality, {});
    assert.equal(decision.decision, "pause");
    assert.equal(decision.reasonCode, "ROTATION_PARTIAL_EVIDENCE_UNVERIFIED");
    assert.equal(quality.status, "partial");
  }
});

test("an explicit postprocess persistence failure retains storage protection", () => {
  const f = fixture();
  f.value.postprocess = { state: "failed", errorCode: "COLLECTION_POSTPROCESS_PERSISTENCE_FAILED" };
  assert.equal(f.inspect().decision, "pause");
  assert.equal(f.inspect().reasonCode, "ROTATION_PARTIAL_STORAGE_UNVERIFIED");
});

async function schedulerFixture(options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "rotation-partial-policy-"));
  let at = new Date("2026-11-11T00:00:00.000Z"), executions = 0;
  const committed = [];
  const settings = { dataDir: directory, now: () => at, getFreeBytes: async () => 1024 ** 3,
    getWorkerState: async () => ({ ready: true }),
    executeSlot: async payload => {
      executions++;
      if (options.results?.[executions - 1] === "complete") return { runId: `normal_${executions}`, collectionQuality: { status: "complete" } };
      if (options.results?.[executions - 1] === "reused") return { runId: `reused_${executions}`, reused: true, collectionQuality: { status: "complete" } };
      const f = fixture(), runId = `partial_${executions}`;
      Object.assign(f.output, { outputDir: "/tmp/" + runId, keyword: payload.keyword, startedAt: at.toISOString(),
        checkIn: payload.checkIn, checkOut: payload.checkOut, bookingRangeDays: payload.bookingRangeDays,
        collectionMode: payload.collectionMode, collectionPurpose: payload.collectionPurpose,
        productMode: payload.productMode, dayUseMode: payload.dayUseMode, detailRankRanges: payload.detailRankRanges });
      for (const target of f.output.productCoverage.targets) for (const [index, row] of target.days.entries()) {
        row.date = new Date(Date.parse(payload.checkIn + "T00:00:00Z") + index * 86400000).toISOString().slice(0, 10);
      }
      if (options.mutateOutput) options.mutateOutput(f.output, executions, payload);
      if (options.waitForResult) await options.waitForResult();
      return { runId, output: f.output, collectionQuality: inspectManifest(f.output, payload) };
    },
    onResultCommitted: async result => committed.push(structuredClone(result)), ...options };
  let scheduler = createCollectionRotationScheduler(settings);
  scheduler.updateConfig({ ...defaultConfig(at), enabled: false,
    workers: [{ workerKey: "web", dailyLimit: 3 }, { workerKey: "manual", dailyLimit: 3 }],
    collection: { ...defaultConfig(at).collection, bookingDays: 21 } });
  await scheduler.setEnabled(true);
  return { get scheduler() { return scheduler; }, committed, get executions() { return executions; },
    setTime(value) { at = new Date(value); }, restart() { scheduler.close(); scheduler = createCollectionRotationScheduler(settings); },
    async close() {
      scheduler.close();
      assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
      assert.ok(path.basename(directory).startsWith("rotation-partial-policy-"));
      await fs.rm(directory, { recursive: true, force: true });
    } };
}

test("a new partial receipt continues the next normal slot at the existing interval without retry or quality promotion", async () => {
  const f = await schedulerFixture({ results: ["partial", "complete"] });
  try {
    const first = await f.scheduler.tick();
    assert.equal(first.status, "partial");
    assert.equal(first.collectionQuality.status, "partial");
    assert.equal(first.continuation.decision, "continue");
    assert.equal(f.scheduler.isEnabled(), true);
    await f.scheduler.tick();
    f.setTime("2026-11-11T01:59:59.000Z"); await f.scheduler.tick();
    assert.equal(f.executions, 1);
    f.setTime("2026-11-11T02:00:00.000Z");
    assert.equal((await f.scheduler.tick()).status, "complete");
    assert.equal(f.executions, 2);
    assert.equal(f.committed[0].status, "partial");
    assert.equal(f.committed[0].postprocess, undefined);
    assert.equal((await f.scheduler.status()).todayItems[0].status, "partial");
  } finally { await f.close(); }
});

test("all six consecutive partials across workers and restart continue at the existing normal schedule", async () => {
  const f = await schedulerFixture();
  try {
    for (let index = 0; index < 6; index++) {
      f.setTime(new Date(Date.parse("2026-11-11T00:00:00Z") + index * 2 * 3600000));
      const result = await f.scheduler.tick();
      assert.equal(result.workerKey, index % 2 ? "manual" : "web");
      assert.equal(result.status, "partial");
      assert.equal(result.continuation.decision, "continue");
      assert.equal(result.continuation.consecutivePartialRuns, 0);
      assert.equal(result.continuation.previousSlotId, null);
      assert.equal(f.scheduler.isEnabled(), true);
      if (index === 0) f.restart();
    }
    await f.scheduler.tick();
    assert.equal(f.executions, 6);
    assert.equal((await f.scheduler.status()).todayItems.length, 6);
  } finally { await f.close(); }
});

test("date changes and reused or complete results do not add a partial stop condition", async () => {
  for (const middle of ["reused", "complete"]) {
    const f = await schedulerFixture({ results: ["partial", middle, "partial"] });
    try {
      await f.scheduler.tick();
      f.setTime("2026-11-11T02:00:00.000Z"); await f.scheduler.tick();
      f.restart(); f.setTime("2026-11-12T00:00:00.000Z");
      const next = await f.scheduler.tick();
      assert.equal(next.continuation.decision, "continue");
      assert.equal(next.continuation.consecutivePartialRuns, 0);
      assert.equal(next.continuation.previousSlotId, null);
      assert.equal(f.scheduler.isEnabled(), true);
    } finally { await f.close(); }
  }
});

test("post-result provider protection or low storage still pauses an otherwise small partial", async () => {
  for (const condition of ["worker", "storage"]) {
    let reads = 0;
    const f = await schedulerFixture(condition === "worker" ? {
      getWorkerState: async () => ++reads > 3 ? { ready: true, halted: true, errorCode: "COLLECTOR_PROVIDER_BLOCKED" } : { ready: true }
    } : { getFreeBytes: async () => ++reads > 2 ? MIN_FREE_BYTES : 1024 ** 3 });
    try {
      const result = await f.scheduler.tick();
      assert.equal(result.status, "partial");
      assert.equal(result.continuation.decision, "pause");
      assert.equal(f.scheduler.isEnabled(), false);
      assert.equal(f.executions, 1);
    } finally { await f.close(); }
  }
});

test("storage exceptions and unknown execution retain protection and are not retried", async () => {
  for (const [code, status] of [["ENOSPC", "failed"], ["COLLECTOR_STATE_UNKNOWN", "uncertain"]]) {
    let attempts = 0;
    const f = await schedulerFixture({ executeSlot: async () => { attempts++; throw Object.assign(new Error("fixture"), { code }); } });
    try {
      const result = await f.scheduler.tick();
      assert.equal(result.status, status); assert.equal(result.continuation, undefined);
      assert.equal(f.scheduler.isEnabled(), false);
      f.setTime("2026-11-11T02:00:00.000Z"); await f.scheduler.tick();
      assert.equal(attempts, 1);
    } finally { await f.close(); }
  }
});

test("all-booking response missing continues only with verified coverage and keeps the failed source quality", async () => {
  const f = await schedulerFixture({ mutateOutput: output => { output.counts.naverBookingStockSucceeded = 0; } });
  try {
    const result = await f.scheduler.tick();
    assert.equal(result.status, "failed");
    assert.equal(result.collectionQuality.status, "failed");
    assert.equal(result.continuation.responseReason, "no_successful_booking_results");
    assert.equal(result.continuation.decision, "continue");
    assert.equal(f.scheduler.isEnabled(), true);
    assert.equal(f.committed[0].postprocess, undefined);
  } finally { await f.close(); }
});

test("a saved all-main response error retains failed quality and progresses only at the next normal slot", async () => {
  const f = await schedulerFixture({ mutateOutput: output => mainUnavailable(output) });
  try {
    const result = await f.scheduler.tick();
    assert.equal(result.status, "failed"); assert.equal(result.collectionQuality.status, "failed");
    assert.equal(result.continuation.responseReason, "naver_main_request_failed");
    assert.equal(result.continuation.decision, "continue"); assert.equal(f.scheduler.isEnabled(), true);
    await f.scheduler.tick(); assert.equal(f.executions, 1);
    f.setTime("2026-11-11T02:00:00.000Z"); await f.scheduler.tick();
    assert.equal(f.executions, 2); assert.equal(f.committed[0].postprocess, undefined);
  } finally { await f.close(); }
});

test("a policy pause and the partial receipt commit together, including a failed transaction", async () => {
  const f = await schedulerFixture({ mutateOutput: (output, execution) => { if (execution === 2) output.requestPacing.requestTimeline.complete = false; } });
  try {
    await f.scheduler.tick();
    const database = new DatabaseSync(f.scheduler.storePath);
    try {
      database.exec(`CREATE TRIGGER fail_policy_pause BEFORE UPDATE ON rotation_state
        WHEN NEW.reason='ROTATION_PARTIAL_PROVIDER_PROTECTED' BEGIN SELECT RAISE(ABORT,'injected policy write failure'); END;`);
    } finally { database.close(); }
    f.setTime("2026-11-11T02:00:00.000Z");
    await assert.rejects(f.scheduler.tick());
    const read = new DatabaseSync(f.scheduler.storePath, { readOnly: true });
    try {
      const current = read.prepare("SELECT status,result_json FROM rotation_slots WHERE slot_index=1").get();
      assert.equal(current.status, "running", "the interrupted transaction cannot leave a terminal partial with a live plan");
      assert.equal(current.result_json, null);
      assert.equal(JSON.parse(read.prepare("SELECT config_json FROM rotation_state").get().config_json).enabled, false);
    } finally { read.close(); }
    f.restart();
    assert.equal(f.scheduler.isEnabled(), false);
    assert.equal((await f.scheduler.status()).todayItems[1].status, "uncertain");
    await f.scheduler.tick();
    assert.equal(f.executions, 2);
  } finally { await f.close(); }
});

test("an explicit manual pause remains paused when a permitted partial finishes", async () => {
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; });
  const pending = new Promise(resolve => { release = resolve; });
  const f = await schedulerFixture({ waitForResult: () => { entered(); return pending; } });
  try {
    const running = f.scheduler.tick();
    await started;
    await f.scheduler.setEnabled(false);
    release();
    const result = await running;
    assert.equal(result.status, "partial");
    assert.equal(result.continuation.decision, "continue");
    assert.equal(f.scheduler.isEnabled(), false);
    assert.ok((await f.scheduler.status()).todayItems.slice(1).every(item => item.status === "paused"));
    f.setTime("2026-11-11T02:00:00.000Z"); await f.scheduler.tick();
    assert.equal(f.executions, 1);
  } finally { release(); await f.close(); }
});

test("legacy partial receipts remain unchanged and do not add a count or history stop condition", async () => {
  const f = await schedulerFixture();
  try {
    const first = await f.scheduler.tick();
    const database = new DatabaseSync(f.scheduler.storePath);
    let old;
    try {
      old = JSON.parse(database.prepare("SELECT result_json FROM rotation_slots WHERE id=?").get(first.id).result_json);
      delete old.continuation;
      database.prepare("UPDATE rotation_slots SET result_json=? WHERE id=?").run(JSON.stringify(old), first.id);
    } finally { database.close(); }
    f.restart(); f.setTime("2026-11-11T02:00:00.000Z");
    const next = await f.scheduler.tick();
    assert.equal(next.continuation.decision, "continue");
    assert.equal(f.scheduler.isEnabled(), true);
    const saved = (await f.scheduler.status()).todayItems[0];
    assert.equal(saved.status, "partial");
    assert.equal(saved.continuation, undefined);
    assert.equal(saved.runId, old.runId);
  } finally { await f.close(); }
});
