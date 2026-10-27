"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { test } = require("node:test");
const { createCollectionRotationScheduler, defaultConfig, planDays } = require("./collection_rotation_scheduler.cjs");

function store(file, sql, ...params) {
  const db = new DatabaseSync(file);
  try { return /^\s*SELECT\b/i.test(sql) ? db.prepare(sql).all(...params).map(row => ({ ...row })) : db.prepare(sql).run(...params); }
  finally { db.close(); }
}
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
async function fixture(overrides = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "rotation-one-day-trial-"));
  let at = new Date("2026-10-27T00:00:00.000Z");
  const calls = [], readiness = [];
  const options = { dataDir: directory, now: () => at, getFreeBytes: async () => 1024 ** 3,
    getWorkerState: async workerKey => { readiness.push(workerKey); return { ready: true, active: false, protected: false }; },
    executeSlot: async (payload, slot) => { calls.push({ payload, slot }); return { runId: `one_day_fixture_${calls.length}`,
      executionStartedAt: at.toISOString(), collectionQuality: { status: "complete", counts: { mainCount: 1 } } }; }, ...overrides };
  let scheduler = createCollectionRotationScheduler(options);
  await scheduler.updateConfig({ ...defaultConfig(at), collection: { ...defaultConfig(at).collection, bookingDays: 21 } });
  return { directory, calls, readiness, options, get scheduler() { return scheduler; },
    setTime(value) { at = new Date(value); }, getTime() { return at.toISOString(); },
    request(day = "2026-10-28") { const status = scheduler.status(); return { day, expectedRevision: status.revision, expectedPlanHash: status.basePlanHash }; },
    async enable() { return scheduler.setEnabled(true); },
    async register(day) { return scheduler.registerOneDayTrial(this.request(day)); },
    cancel(trialId) { const status = scheduler.status(); return scheduler.cancelOneDayTrial({ trialId, expectedRevision: status.revision, expectedPlanHash: status.basePlanHash }); },
    restart() { scheduler.close(); scheduler = createCollectionRotationScheduler(options); return scheduler; },
    async runDay(day, slots = 6) { for (let index = 0; index < slots; index += 1) { at = new Date(`${day}T${String(index * 2).padStart(2, "0")}:00:00Z`); await scheduler.tick(); } return scheduler.status(); },
    async close() { scheduler.close(); assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir())); assert.ok(path.basename(directory).startsWith("rotation-one-day-trial-")); await fs.rm(directory, { recursive: true, force: true }); } };
}

test("preview and registration preserve the four-slot base, cursor, receipts and unrelated source files", async t => {
  const f = await fixture(); t.after(() => f.close());
  await fs.writeFile(path.join(f.directory, "raw-preserved.json"), '{"source":"fixture"}');
  await f.enable(); await f.runDay("2026-10-27", 4);
  const before = store(f.scheduler.storePath, "SELECT * FROM rotation_state");
  const history = f.scheduler.history(), revisions = store(f.scheduler.storePath, "SELECT * FROM rotation_revisions");
  const preview = f.scheduler.previewOneDayTrial(f.request());
  assert.equal(preview.configUnchanged, true); assert.equal(preview.baseDailySlots, 4); assert.equal(preview.trialDailySlots, 6);
  assert.equal(preview.day, "2026-10-28"); assert.equal(preview.returnDay, "2026-10-29");
  assert.equal(preview.items.length, 6); assert.equal(preview.nextDayItems.length, 4);
  assert.deepEqual(preview.items.map(item => item.workerKey), ["web", "manual", "web", "manual", "web", "manual"]);
  assert.deepEqual(preview.items.map(item => item.scheduledAt), [0, 2, 4, 6, 8, 10].map(hour => `2026-10-28T${String(hour).padStart(2, "0")}:00:00.000Z`));
  assert.equal(store(f.scheduler.storePath, "SELECT * FROM rotation_one_day_trials").length, 0);
  const registered = await f.register();
  assert.equal(registered.oneDayTrial.status, "armed"); assert.equal(registered.oneDayTrial.baseRevision, registered.revision);
  assert.equal(registered.oneDayTrial.basePlanHash, registered.basePlanHash); assert.equal(registered.oneDayTrials.length, 1);
  assert.deepEqual(store(f.scheduler.storePath, "SELECT * FROM rotation_state"), before);
  assert.deepEqual(store(f.scheduler.storePath, "SELECT * FROM rotation_revisions"), revisions);
  assert.deepEqual(f.scheduler.history(), history); assert.equal(f.calls.length, 4);
  assert.equal(await fs.readFile(path.join(f.directory, "raw-preserved.json"), "utf8"), '{"source":"fixture"}');
});

test("registration requires enabled, idle ready workers, no conflict and sufficient disk without starting collection", async t => {
  const disabled = await fixture(); t.after(() => disabled.close());
  await assert.rejects(disabled.register(), { code: "ROTATION_TRIAL_REQUIRES_ENABLED" });
  assert.equal(disabled.calls.length, 0);
  const cases = [
    [{ getWorkerState: async () => ({ ready: false }) }, "ROTATION_WORKER_NOT_READY"],
    [{ getWorkerState: async () => ({ ready: true, protected: true }) }, "ROTATION_WORKER_PROTECTED"],
    [{ getWorkerState: async () => ({ ready: true, active: true }) }, "ROTATION_COLLECTORS_BUSY"],
    [{ getWorkerState: async () => ({ ready: true, retired: true }) }, "ROTATION_WORKER_RETIRED"],
    [{ getFreeBytes: async () => 1 }, "ROTATION_DISK_SPACE_UNAVAILABLE"],
    [{ conflictCheck: async () => "ROTATION_SCHEDULE_CONFLICT" }, "ROTATION_SCHEDULE_CONFLICT"]
  ];
  for (const [options, code] of cases) {
    const f = await fixture(); t.after(() => f.close()); await f.enable();
    Object.assign(f.options, options); f.restart();
    await assert.rejects(f.register(), { code }); assert.equal(f.calls.length, 0);
    assert.equal(f.scheduler.status().enabled, true); assert.equal(f.scheduler.status().oneDayTrials.length, 0);
  }
});

test("trial accepts only a future KST day within 31 days and the exact four-slot base", async t => {
  const f = await fixture(); t.after(() => f.close()); await f.enable();
  for (const day of ["2026-10-26", "2026-10-27", "2026-11-28", "2026-02-30", "2026-10-28T00:00:00Z"]) {
    assert.throws(() => f.scheduler.previewOneDayTrial(f.request(day)), { code: "ROTATION_TRIAL_DATE_INVALID" });
  }
  assert.equal(f.scheduler.previewOneDayTrial(f.request("2026-11-27")).items.length, 6);
  f.setTime("2026-10-27T15:00:00Z");
  assert.throws(() => f.scheduler.previewOneDayTrial(f.request("2026-10-28")), { code: "ROTATION_TRIAL_DATE_INVALID" });
  for (const patch of [{ time: "10:00" }, { keywordIntervalMinutes: 90 }, { workers: [{ workerKey: "web", dailyLimit: 1 }, { workerKey: "manual", dailyLimit: 3 }] },
    { keywords: ["a", "b", "c", "d", "e"] }, { workers: [{ workerKey: "manual", dailyLimit: 2 }, { workerKey: "web", dailyLimit: 2 }] }]) {
    const bad = await fixture(); t.after(() => bad.close());
    await bad.scheduler.updateConfig(patch, patch.keywords ? { startKeyword: patch.keywords[0] } : {}); await bad.enable();
    assert.throws(() => bad.scheduler.previewOneDayTrial(bad.request()), { code: "ROTATION_TRIAL_BASE_CONFIG_INVALID" });
  }
});

test("strict inputs, stale revision or hash and an already allocated trial day are rejected", async t => {
  const f = await fixture(); t.after(() => f.close()); await f.enable();
  for (const input of [{ ...f.request(), override: true }, { ...f.request(), expectedRevision: 0 }, { ...f.request(), expectedPlanHash: "invalid" }]) {
    assert.throws(() => f.scheduler.previewOneDayTrial(input), { code: "ROTATION_TRIAL_INPUT_INVALID" });
  }
  assert.throws(() => f.scheduler.previewOneDayTrial({ ...f.request(), expectedRevision: 100 }), { code: "ROTATION_TRIAL_PLAN_CHANGED" });
  assert.throws(() => f.scheduler.previewOneDayTrial({ ...f.request(), expectedPlanHash: "0".repeat(64) }), { code: "ROTATION_TRIAL_PLAN_CHANGED" });
  const s = f.scheduler.status();
  store(f.scheduler.storePath, "INSERT INTO rotation_days VALUES(?,?,?,?,?,?)", "2026-10-28", s.revision, 0, 4, JSON.stringify(s.config), f.getTime());
  await assert.rejects(f.register(), { code: "ROTATION_TRIAL_DAY_ALLOCATED" }); assert.equal(f.calls.length, 0);
});

test("one immutable trial per date and one pending trial prevent accidental multi-day expansion", async t => {
  const f = await fixture(); t.after(() => f.close()); await f.enable();
  const first = await f.register();
  await assert.rejects(f.register(), { code: "ROTATION_TRIAL_EXISTS" });
  await assert.rejects(f.register("2026-10-29"), { code: "ROTATION_TRIAL_PENDING" });
  await f.scheduler.setEnabled(false);
  await assert.rejects(f.scheduler.updateConfig({ time: "10:00" }), { code: "ROTATION_TRIAL_PENDING" });
  const cancelled = f.cancel(first.oneDayTrial.trialId);
  assert.equal(cancelled.oneDayTrial.status, "cancelled"); assert.equal(cancelled.enabled, false);
  assert.equal(cancelled.cursor, 0); assert.equal(f.scheduler.history().items.length, 0);
  await assert.rejects(f.register(), { code: "ROTATION_TRIAL_EXISTS" });
  const saved = await f.scheduler.updateConfig({ collection: { ...cancelled.config.collection, bookingDays: 20 } });
  assert.equal(saved.revision, cancelled.revision + 1);
});

test("enabled toggles do not change base identity and trial cancellation does not clear a protective pause", async t => {
  const f = await fixture(); t.after(() => f.close()); await f.enable();
  const registered = await f.register(), hash = registered.basePlanHash;
  f.options.getWorkerState = async () => ({ ready: true, protected: true, errorCode: "WORKER_PROVIDER_HOLD" }); f.restart();
  await f.scheduler.tick();
  const held = f.scheduler.status();
  assert.equal(held.enabled, false); assert.equal(held.reason, "WORKER_PROVIDER_HOLD"); assert.equal(held.basePlanHash, hash);
  const before = store(f.scheduler.storePath, "SELECT * FROM rotation_state"), prior = f.scheduler.history();
  const cancelled = f.cancel(registered.oneDayTrial.trialId);
  assert.equal(cancelled.enabled, false); assert.equal(cancelled.reason, "WORKER_PROVIDER_HOLD"); assert.equal(cancelled.basePlanHash, hash);
  assert.deepEqual(store(f.scheduler.storePath, "SELECT * FROM rotation_state"), before); assert.deepEqual(f.scheduler.history(), prior);
  await assert.rejects(f.scheduler.setEnabled(true), { code: "WORKER_PROVIDER_HOLD" });
});

test("existing and new preview forecasts use six only on the trial date and carry the cursor to four next day", async t => {
  const f = await fixture(); t.after(() => f.close()); await f.enable();
  const standalone = f.scheduler.previewOneDayTrial(f.request());
  assert.equal(standalone.items[0].keyword, defaultConfig().keywords[4]);
  await f.register();
  const forecast = f.scheduler.preview(undefined, { days: 3 });
  assert.equal(forecast.items.length, 14);
  assert.deepEqual(["2026-10-27", "2026-10-28", "2026-10-29"].map(day => forecast.items.filter(row => row.day === day).length), [4, 6, 4]);
  assert.deepEqual(forecast.items.slice(4, 10).map(row => row.keyword), standalone.items.map(row => row.keyword));
  assert.deepEqual(forecast.items.slice(10).map(row => row.keyword), standalone.nextDayItems.map(row => row.keyword));
  assert.equal(forecast.nextCursor, 1); assert.equal(f.scheduler.status().cursor, 0);
  const pure = planDays(f.scheduler.status().config, { days: 3 }); assert.equal(pure.items.length, 12);
});

test("four-six-four day allocation is atomic, durable and keeps all prior receipts and collection conditions", async t => {
  const f = await fixture(); t.after(() => f.close()); await f.enable(); await f.runDay("2026-10-27", 4);
  const prior = f.scheduler.history().items, base = f.scheduler.status();
  await f.register(); const trialId = f.scheduler.status().oneDayTrial.trialId;
  f.restart(); assert.equal(f.scheduler.status().oneDayTrial.trialId, trialId);
  const trial = await f.runDay("2026-10-28");
  assert.equal(trial.todayItems.length, 6); assert.equal(trial.todayCounts.complete, 6); assert.equal(trial.cursor, 10);
  assert.equal(trial.oneDayTrial.status, "allocated"); assert.ok(trial.todayItems.every(row => row.trialId === trialId));
  assert.deepEqual(trial.config, base.config); assert.equal(trial.revision, base.revision); assert.equal(trial.basePlanHash, base.basePlanHash);
  assert.equal(store(f.scheduler.storePath, "SELECT * FROM rotation_one_day_trial_days").length, 1);
  assert.equal(JSON.parse(store(f.scheduler.storePath, "SELECT config_json FROM rotation_days WHERE day=?", "2026-10-28")[0].config_json).workers[0].dailyLimit, 3);
  f.restart(); const next = await f.runDay("2026-10-29");
  assert.equal(next.todayItems.length, 4); assert.equal(next.cursor, 1); assert.equal(next.oneDayTrial.status, "expired");
  assert.ok(next.todayItems.every(row => !row.trialId));
  assert.deepEqual(f.scheduler.history({ from: "2026-10-27", to: "2026-10-27" }).items, prior);
  assert.equal(f.calls.length, 14);
  for (const call of f.calls) {
    assert.equal(call.payload.bookingRangeDays, 21); assert.equal(call.payload.detailRankRanges, "1-20");
    assert.equal(call.payload.adults, 2); assert.equal(call.payload.productMode, "all"); assert.equal(call.payload.dayUseMode, "inspect");
    assert.equal(call.payload.collectionMode, "precision"); assert.equal(call.payload.collectionPurpose, "revenue_detail");
    assert.equal(Object.hasOwn(call.payload, "requestPacing"), false);
  }
});

test("repeated and concurrent ticks never allocate or dispatch extra trial slots", async t => {
  const f = await fixture(); t.after(() => f.close()); await f.enable(); await f.register();
  f.setTime("2026-10-28T00:00:00Z"); await Promise.all([f.scheduler.tick(), f.scheduler.tick(), f.scheduler.tick()]);
  f.restart(); await Promise.all([f.scheduler.tick(), f.scheduler.tick()]);
  assert.equal(f.calls.length, 1); assert.equal(f.scheduler.status().todayItems.length, 6);
  assert.equal(store(f.scheduler.storePath, "SELECT * FROM rotation_one_day_trial_days").length, 1);
  assert.equal(f.scheduler.status().cursor, 6);
});

test("the live-equivalent revision two, 36-slot cursor ten fixture previews the exact six and following four keywords", async t => {
  const f = await fixture(); t.after(() => f.close());
  await f.scheduler.updateConfig({ firstDate: "2026-10-19" }); await f.enable();
  for (let day = 19; day <= 27; day += 1) await f.runDay(`2026-10-${day}`, 4);
  const before = f.scheduler.status();
  assert.equal(before.revision, 2); assert.equal(before.cursor, 10); assert.equal(f.scheduler.history().total, 36);
  const preview = f.scheduler.previewOneDayTrial(f.request());
  assert.deepEqual(preview.items.map(row => row.keyword), ["여수글램핑", "가평글램핑", "포천글램핑", "경남글램핑", "대구글램핑", "부산글램핑"]);
  assert.deepEqual(preview.nextDayItems.map(row => row.keyword), ["경북글램핑", "충남글램핑", "전남글램핑", "전북글램핑"]);
  assert.deepEqual(preview.items.slice(0, 4), planDays(before.config, { startDate: "2026-10-28", days: 1, cursor: 10 }).items);
  await f.register(); assert.deepEqual(f.scheduler.status().config, before.config);
  assert.equal(f.scheduler.status().revision, 2); assert.equal(f.scheduler.status().cursor, 10);
  assert.equal(f.scheduler.history().total, 36); assert.equal(f.calls.length, 36);
});

test("all six slots, trial binding and advanced cursor are durable before the first trial execution", async t => {
  let f;
  f = await fixture({ executeSlot: async (payload, slot) => {
    const slots = store(f.scheduler.storePath, "SELECT * FROM rotation_slots ORDER BY slot_index");
    const trial = store(f.scheduler.storePath, "SELECT * FROM rotation_one_day_trials")[0];
    assert.equal(slots.length, 6); assert.equal(slots[slot.index].status, "running");
    assert.equal(store(f.scheduler.storePath, "SELECT cursor FROM rotation_state")[0].cursor, 6);
    assert.equal(store(f.scheduler.storePath, "SELECT * FROM rotation_one_day_trial_days")[0].trial_id, trial.trial_id);
    assert.ok(trial.allocated_at); assert.equal(slot.trialId, trial.trial_id);
    f.calls.push({ payload, slot }); return { runId: "durable_fixture", collectionQuality: { status: "complete" } };
  } });
  t.after(() => f.close()); await f.enable(); await f.register(); f.setTime("2026-10-28T00:00:00Z"); await f.scheduler.tick();
  assert.equal(f.calls.length, 1); assert.equal(f.scheduler.status().todayItems[0].status, "complete");
});

test("restart during a trial running receipt preserves uncertainty and disables every later day", async t => {
  const f = await fixture(); t.after(() => f.close()); await f.enable(); await f.register();
  f.setTime("2026-10-28T00:00:00Z"); await f.scheduler.tick();
  store(f.scheduler.storePath, "UPDATE rotation_slots SET status='running',started_at=? WHERE slot_index=1", f.getTime());
  f.restart(); const restarted = f.scheduler.status();
  assert.equal(restarted.enabled, false); assert.equal(restarted.planState, "review"); assert.equal(restarted.reason, "ROTATION_UNRESOLVED_EXECUTION");
  assert.equal(restarted.todayItems[1].status, "uncertain"); assert.equal(restarted.cursor, 6);
  assert.ok(restarted.todayItems.slice(2).every(row => row.status === "paused"));
  f.setTime("2026-10-29T00:00:00Z"); await f.scheduler.tick();
  assert.equal(f.scheduler.status().enabled, false); assert.equal(f.calls.length, 1); assert.equal(f.scheduler.status().todayItems.length, 0);
  await assert.rejects(f.scheduler.setEnabled(true), { code: "ROTATION_UNRESOLVED_EXECUTION" });
});

test("cancel rejects allocated, same-day, stale or unknown trials and never mutates existing receipts", async t => {
  const f = await fixture(); t.after(() => f.close()); await f.enable(); const registered = await f.register();
  const input = { trialId: registered.oneDayTrial.trialId, expectedRevision: registered.revision, expectedPlanHash: registered.basePlanHash };
  assert.throws(() => f.scheduler.cancelOneDayTrial({ ...input, extra: true }), { code: "ROTATION_TRIAL_INPUT_INVALID" });
  assert.throws(() => f.scheduler.cancelOneDayTrial({ ...input, expectedRevision: 2 }), { code: "ROTATION_TRIAL_PLAN_CHANGED" });
  assert.throws(() => f.scheduler.cancelOneDayTrial({ ...input, trialId: "00000000-0000-0000-0000-000000000000" }), { code: "ROTATION_TRIAL_NOT_FOUND" });
  f.setTime("2026-10-27T15:00:00Z");
  assert.throws(() => f.scheduler.cancelOneDayTrial(input), { code: "ROTATION_TRIAL_CANCEL_FORBIDDEN" });
  f.setTime("2026-10-28T00:00:00Z"); await f.scheduler.tick();
  const before = f.scheduler.history();
  assert.throws(() => f.scheduler.cancelOneDayTrial(input), { code: "ROTATION_TRIAL_CANCEL_FORBIDDEN" });
  assert.deepEqual(f.scheduler.history(), before);
});

test("missed trial days never catch up and a paused trial expiry cannot enable the four-slot base", async t => {
  const f = await fixture(); t.after(() => f.close()); await f.enable(); await f.register();
  f.setTime("2026-10-29T00:00:00Z"); f.restart(); await f.scheduler.tick();
  assert.equal(f.scheduler.status().todayItems.length, 4); assert.equal(f.scheduler.status().oneDayTrial.status, "expired");
  assert.equal(f.scheduler.history({ from: "2026-10-28", to: "2026-10-28" }).items.length, 0);
  assert.equal(f.calls.length, 1);
  const paused = await fixture(); t.after(() => paused.close()); await paused.enable(); await paused.register(); await paused.scheduler.setEnabled(false);
  paused.setTime("2026-10-29T00:00:00Z"); paused.restart(); await paused.scheduler.tick();
  assert.equal(paused.scheduler.status().enabled, false); assert.equal(paused.scheduler.status().oneDayTrial.status, "expired");
  assert.equal(paused.scheduler.status().cursor, 0); assert.equal(paused.calls.length, 0); assert.equal(paused.scheduler.history().items.length, 0);
});

test("partial, blocked and unknown trial results retain the original stop and no-retry contracts", async t => {
  for (const [quality, expected, error] of [["partial", "partial"], ["blocked", "blocked"], [null, "uncertain", { code: "COLLECTOR_RESPONSE_UNKNOWN" }]]) {
    const f = await fixture({ executeSlot: async () => { if (error) throw Object.assign(new Error(error.code), error); return { runId: "fixture", collectionQuality: { status: quality } }; } });
    t.after(() => f.close()); await f.enable(); await f.register(); f.setTime("2026-10-28T00:00:00Z"); await f.scheduler.tick();
    const stopped = f.scheduler.status();
    assert.equal(stopped.todayItems[0].status, expected); assert.equal(stopped.enabled, false);
    assert.ok(stopped.todayItems.slice(1).every(row => row.status === "paused"));
    f.setTime("2026-10-29T10:00:00Z"); f.restart(); await f.scheduler.tick();
    assert.equal(f.scheduler.status().enabled, false); assert.equal(f.scheduler.status().todayItems.length, 0);
    assert.equal(f.scheduler.history().items.length, 6); assert.equal(f.scheduler.status().cursor, 6);
    if (expected === "uncertain") await assert.rejects(f.scheduler.setEnabled(true), { code: "ROTATION_UNRESOLVED_EXECUTION" });
  }
});

test("allocation mismatch fails closed without touching source data, clearing protection or making a provider request", async t => {
  const f = await fixture(); t.after(() => f.close()); await f.enable(); await f.register();
  const before = f.scheduler.status();
  store(f.scheduler.storePath, "UPDATE rotation_one_day_trials SET base_plan_hash=?", "0".repeat(64));
  assert.equal(f.scheduler.status().oneDayTrial.status, "needs_verification");
  f.setTime("2026-10-28T00:00:00Z"); await f.scheduler.tick();
  const state = f.scheduler.status();
  assert.equal(state.enabled, false); assert.equal(state.planState, "review"); assert.equal(state.reason, "ROTATION_TRIAL_PLAN_CHANGED");
  assert.equal(state.cursor, before.cursor); assert.equal(state.todayItems.length, 0); assert.equal(f.calls.length, 0);
});

test("bound day snapshot or trial binding tampering is not accepted for a later trial slot", async t => {
  for (const mutation of ["DELETE FROM rotation_one_day_trial_days", "UPDATE rotation_one_day_trial_days SET effective_plan_hash='bad'"] ) {
    const f = await fixture(); t.after(() => f.close()); await f.enable(); await f.register();
    f.setTime("2026-10-28T00:00:00Z"); await f.scheduler.tick(); store(f.scheduler.storePath, mutation);
    f.setTime("2026-10-28T02:00:00Z"); await f.scheduler.tick();
    const state = f.scheduler.status(); assert.equal(state.enabled, false); assert.equal(state.reason, "ROTATION_TRIAL_PLAN_CHANGED");
    assert.equal(f.calls.length, 1); assert.equal(state.todayItems[0].status, "complete"); assert.equal(state.todayItems[1].status, "paused");
  }
});

test("preflight awaits are followed by a CAS and cannot register through a pause or crossing KST midnight", async t => {
  for (const change of ["pause", "midnight", "revision", "active"]) {
    const ready = deferred(), gate = deferred(); let hold = false;
    const f = await fixture({ getFreeBytes: async () => { if (hold) { ready.resolve(); await gate.promise; } return 1024 ** 3; } });
    t.after(() => f.close()); await f.enable(); hold = true;
    const pending = f.register(); await ready.promise;
    if (change === "pause") await f.scheduler.setEnabled(false);
    if (change === "midnight") f.setTime("2026-10-27T15:00:00Z");
    if (change === "revision") store(f.scheduler.storePath, "UPDATE rotation_state SET revision=revision+1");
    if (change === "active") {
      // A tick still in preflight is sufficient to block trial registration;
      // no fixture provider work is needed to exercise this race.
      const tick = f.scheduler.tick(); gate.resolve(); await assert.rejects(pending, { code: "ROTATION_CONFIG_CHANGED" }); await tick;
      assert.equal(f.scheduler.status().oneDayTrials.length, 0); continue;
    }
    gate.resolve(); await assert.rejects(pending);
    assert.equal(f.scheduler.status().oneDayTrials.length, 0); assert.equal(f.calls.length, 0);
  }
});

test("actual start spacing, waiting and midnight expiry are unchanged by six trial slots", async t => {
  let f;
  f = await fixture({ executeSlot: async (payload, slot) => {
    f.calls.push({ payload, slot });
    const began = f.getTime(); f.setTime(new Date(Date.parse(began) + 30 * 60000).toISOString());
    return { runId: `fixture_${f.calls.length}`, executionStartedAt: began, collectionQuality: { status: "complete" } };
  } });
  t.after(() => f.close()); await f.enable(); await f.register();
  f.setTime("2026-10-28T01:00:00Z"); await f.scheduler.tick();
  assert.equal(f.scheduler.status().todayItems[1].notBeforeAt, "2026-10-28T03:00:00.000Z");
  f.setTime("2026-10-28T02:00:00Z"); await f.scheduler.tick(); assert.equal(f.calls.length, 1);
  f.setTime("2026-10-28T03:00:00Z"); await f.scheduler.tick(); assert.equal(f.calls.length, 2);
  f.setTime("2026-10-28T15:00:00Z"); await f.scheduler.tick();
  assert.equal(f.scheduler.status().todayItems.length, 0);
  const previous = f.scheduler.history({ from: "2026-10-28", to: "2026-10-28" }).items;
  assert.equal(previous.filter(row => row.status === "missed").length, 4); assert.equal(f.calls.length, 2);
});

test("registration preview and status stay read-only, and registration refuses an in-flight tick", async t => {
  const executing = deferred(), entered = deferred();
  const f = await fixture({ executeSlot: async () => { entered.resolve(); await executing.promise; return { runId: "busy", collectionQuality: { status: "complete" } }; } });
  t.after(() => f.close()); await f.enable();
  const tick = f.scheduler.tick(); await entered.promise;
  await assert.rejects(f.register(), { code: "ROTATION_COLLECTORS_BUSY" });
  executing.resolve(); await tick;
  const before = store(f.scheduler.storePath, "SELECT * FROM rotation_state"), events = store(f.scheduler.storePath, "SELECT * FROM rotation_events");
  f.scheduler.previewOneDayTrial(f.request()); f.scheduler.status();
  assert.deepEqual(store(f.scheduler.storePath, "SELECT * FROM rotation_state"), before);
  assert.deepEqual(store(f.scheduler.storePath, "SELECT * FROM rotation_events"), events);
});
