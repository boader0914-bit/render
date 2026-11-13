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
    const failures = index === 0 ? failed - affected + 1 : 1;
    return { businessId: String(index + 1), productListComplete: true, discovered: eligible, eligible, excluded: 0,
      queried: eligible, truncated: 0, expectedDays: days,
      days: Array.from({ length: days }, (_, day) => ({ date: new Date(start + day * 86400000).toISOString().slice(0, 10),
        eligible, queried: eligible, succeeded: eligible - (day === 0 ? failures : 0), failed: day === 0 ? failures : 0, truncated: 0 })) };
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

test("one missing schedule out of 5187 permits only scheduling continuation and stays partial for derived data", () => {
  const f = fixture(), before = structuredClone(f.output), quality = inspectManifest(f.output);
  assert.equal(quality.status, "partial");
  assert.equal(quality.reason, "booking_schedule_responses_incomplete");
  assert.deepEqual(f.inspect(), { policyVersion: PARTIAL_POLICY.policyVersion, decision: "continue",
    reasonCode: "ROTATION_PARTIAL_CONTINUED", failedSchedules: 1, requestedSchedules: 5187,
    affectedCompanies: 1, consecutivePartialRuns: 1, previousSlotId: null });
  assert.equal(allowsDerivedUpdates(f.output), false);
  assert.deepEqual(f.output, before);
});

test("absolute and proportional failure boundaries both apply, including multiple affected businesses", () => {
  for (const [options, allowed] of [
    [{ products: 1000, days: 1 }, true], [{ products: 999, days: 1 }, false],
    [{ products: 3000, days: 1, failed: 3 }, true], [{ products: 2999, days: 1, failed: 3 }, false],
    [{ products: 10000, days: 1, failed: 4 }, false], [{ failed: 2, affected: 2 }, false]
  ]) assert.equal(fixture(options).inspect().decision === "continue", allowed, JSON.stringify(options));
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
    o => { o.counts.naverOtaFailed = 1; },
    o => { o.counts.naverBookingStockChecked = 2; },
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

test("only internally consistent bounded continuation receipts are projected", () => {
  const good = fixture().inspect();
  assert.deepEqual(sanitizePartialContinuation({ ...good, token: "private" }), good);
  for (const patch of [{ policyVersion: "future" }, { decision: "complete" }, { reasonCode: "unknown" },
    { failedSchedules: -1 }, { requestedSchedules: 0 }, { affectedCompanies: 2 }, { consecutivePartialRuns: 2 },
    { failedSchedules: 4 }]) assert.equal(sanitizePartialContinuation({ ...good, ...patch }), null);
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

test("consecutive partials across workers and restart pause at the second execution", async () => {
  const f = await schedulerFixture();
  try {
    const first = await f.scheduler.tick(); f.restart();
    assert.equal(f.scheduler.isEnabled(), true);
    f.setTime("2026-11-11T02:00:00.000Z");
    const second = await f.scheduler.tick();
    assert.equal(second.workerKey, "manual");
    assert.equal(second.status, "partial");
    assert.equal(second.continuation.reasonCode, "ROTATION_PARTIAL_REPEATED");
    assert.equal(second.continuation.consecutivePartialRuns, 2);
    assert.equal(second.continuation.previousSlotId, first.id);
    assert.equal(f.scheduler.isEnabled(), false);
    assert.ok((await f.scheduler.status()).todayItems.slice(2).every(item => item.status === "paused"));
    f.setTime("2026-11-12T10:00:00.000Z"); await f.scheduler.tick();
    assert.equal(f.executions, 2);
  } finally { await f.close(); }
});

test("a reused result and a date change cannot erase a prior partial, while a fresh normal result can", async () => {
  for (const middle of ["reused", "complete"]) {
    const f = await schedulerFixture({ results: ["partial", middle, "partial"] });
    try {
      const first = await f.scheduler.tick();
      f.setTime("2026-11-11T02:00:00.000Z"); await f.scheduler.tick();
      f.restart(); f.setTime("2026-11-12T00:00:00.000Z");
      const next = await f.scheduler.tick();
      assert.equal(next.continuation.decision, middle === "complete" ? "continue" : "pause");
      assert.equal(next.continuation.consecutivePartialRuns, middle === "complete" ? 1 : 2);
      if (middle === "reused") assert.equal(next.continuation.previousSlotId, first.id);
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

test("a contradictory previous complete receipt cannot reset a partial streak", async () => {
  const mutations = [
    saved => { saved.providerBlocked = true; },
    saved => { saved.collectionQuality.blockedReason = "naver_captcha"; },
    ...["naverScheduleBlocked", "naverScheduleFailed", "naverOtaBlocked", "naverOtaFailed"].map(key =>
      saved => { saved.collectionQuality.counts = { [key]: 1 }; }),
    saved => { saved.collectionQuality.counts = { naverScheduleFailed: null }; },
    saved => { saved.collectionQuality.counts = { naverBookingStockChecked: 2, naverBookingStockSucceeded: 1 }; }
  ];
  for (const mutate of mutations) {
    const f = await schedulerFixture({ results: ["complete", "partial"] });
    try {
      const first = await f.scheduler.tick();
      const database = new DatabaseSync(f.scheduler.storePath);
      try {
        const saved = JSON.parse(database.prepare("SELECT result_json FROM rotation_slots WHERE id=?").get(first.id).result_json);
        mutate(saved);
        database.prepare("UPDATE rotation_slots SET result_json=? WHERE id=?").run(JSON.stringify(saved), first.id);
      } finally { database.close(); }
      f.restart(); f.setTime("2026-11-11T02:00:00.000Z");
      const next = await f.scheduler.tick();
      assert.equal(next.continuation.reasonCode, "ROTATION_PARTIAL_HISTORY_UNVERIFIED", mutate.toString());
      assert.equal(f.scheduler.isEnabled(), false);
    } finally { await f.close(); }
  }
});

test("a policy pause and the partial receipt commit together, including a failed transaction", async () => {
  const f = await schedulerFixture();
  try {
    await f.scheduler.tick();
    const database = new DatabaseSync(f.scheduler.storePath);
    try {
      database.exec(`CREATE TRIGGER fail_policy_pause BEFORE UPDATE ON rotation_state
        WHEN NEW.reason='ROTATION_PARTIAL_REPEATED' BEGIN SELECT RAISE(ABORT,'injected policy write failure'); END;`);
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

test("legacy partial receipts retain their status and cannot silently reset the new policy streak", async () => {
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
    assert.equal(next.continuation.reasonCode, "ROTATION_PARTIAL_HISTORY_UNVERIFIED");
    assert.equal(f.scheduler.isEnabled(), false);
    const saved = (await f.scheduler.status()).todayItems[0];
    assert.equal(saved.status, "partial");
    assert.equal(saved.continuation, undefined);
    assert.equal(saved.runId, old.runId);
  } finally { await f.close(); }
});
