"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs/promises"), os = require("node:os"), path = require("node:path");
const { DatabaseSync } = require("node:sqlite"), { test } = require("node:test");
const { createCollectionRotationScheduler, defaultConfig } = require("./collection_rotation_scheduler.cjs");
const six = [{ workerKey: "web", dailyLimit: 3 }, { workerKey: "manual", dailyLimit: 3 }];
const tables = ["rotation_days", "rotation_slots", "rotation_events", "rotation_revisions", "rotation_one_day_trials", "rotation_one_day_trial_days"];
function sql(file, statement, ...params) {
  const db = new DatabaseSync(file);
  try { return /^SELECT/i.test(statement) ? db.prepare(statement).all(...params).map(value => ({ ...value })) : db.prepare(statement).run(...params); }
  finally { db.close(); }
}
function stored(scheduler) { return Object.fromEntries(["rotation_state", ...tables].map(table => [table, sql(scheduler.storePath, "SELECT * FROM " + table + " ORDER BY rowid")])); }
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
async function fixture(t, { historyTrial = true, pendingTrial = false, execute } = {}) {
  const directory = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "rotation-daily-limits-"));
  let at = new Date("2026-10-27T00:00:00.000Z");
  const state = { protected: false, busy: false, conflict: null, freeWait: null, requests: [], admissions: [] };
  const scheduler = createCollectionRotationScheduler({ dataDir: directory, now: () => at,
    getFreeBytes: async () => { if (state.freeWait) await state.freeWait.promise; return 1024 ** 3; },
    conflictCheck: async (_config, context) => { state.admissions.push(context.phase); return state.conflict; },
    getWorkerState: async () => ({ ready: true, active: state.busy, protected: state.protected, ...(state.protected ? { errorCode: "COLLECTOR_PROVIDER_BLOCKED" } : {}) }),
    executeSlot: async (payload, slot) => { state.requests.push({ payload, slot }); if (execute) return execute(payload, slot);
      return { runId: `limits_fixture_${state.requests.length}`, executionStartedAt: at.toISOString(), collectionQuality: { status: "complete", counts: { mainCount: 1 } } }; } });
  await scheduler.updateConfig({ ...defaultConfig(at), collection: { ...defaultConfig(at).collection, bookingDays: 21 } });
  await scheduler.setEnabled(true);
  if (historyTrial || pendingTrial) {
    const current = scheduler.status();
    await scheduler.registerOneDayTrial({ day: "2026-10-28", expectedRevision: current.revision, expectedPlanHash: current.basePlanHash });
  }
  if (historyTrial) for (let index = 0; index < 6; index++) { at = new Date(`2026-10-28T${String(index * 2).padStart(2, "0")}:00:00.000Z`); await scheduler.tick(); }
  if (!pendingTrial) at = new Date("2026-10-30T00:00:00.000Z");
  const sentinel = path.join(directory, "preserve-original.json"), sentinelBytes = Buffer.from('{"unchanged":"individual/source/protection fixture"}\n');
  await fs.writeFile(sentinel, sentinelBytes);
  t.after(async () => { scheduler.close(); assert.equal(path.dirname(await fs.realpath(directory)), await fs.realpath(os.tmpdir())); await fs.rm(directory, { recursive: true, force: true }); });
  return { scheduler, state, directory, sentinel, sentinelBytes, setTime(value) { at = new Date(value); },
    input() { return { workers: six, expectedRevision: scheduler.status().revision }; } };
}

test("official daily-limit update preserves today's four queued receipts, old history/trial/cursor/payload and enabled state", async t => {
  const f = await fixture(t); await f.scheduler.tick();
  const before = stored(f.scheduler), status = f.scheduler.status(), requestsBefore = f.state.requests.length;
  assert.equal(status.todayItems.length, 4); assert.equal(status.todayItems.filter(item => item.status === "queued").length, 3);
  const result = await f.scheduler.updateDailyLimits(f.input()), after = stored(f.scheduler);
  assert.equal(result.enabled, true); assert.equal(result.revision, status.revision + 1); assert.equal(result.cursor, status.cursor);
  assert.equal(result.dailyLimitsUpdate.effectiveFrom, "2026-10-31"); assert.equal(result.dailyLimitsUpdate.todayAllocated, true);
  assert.equal(result.dailyLimitsUpdate.dailySlots, 6); assert.equal(result.dailyLimitsUpdate.previousDailySlots, 4);
  for (const table of ["rotation_days", "rotation_slots", "rotation_one_day_trials", "rotation_one_day_trial_days"]) assert.deepEqual(after[table], before[table], table);
  assert.deepEqual(after.rotation_events.slice(0, -1), before.rotation_events); assert.equal(after.rotation_events.at(-1).kind, "daily_limits_saved");
  assert.deepEqual(after.rotation_revisions.slice(0, -1), before.rotation_revisions);
  const oldConfig = JSON.parse(before.rotation_state[0].config_json), newConfig = JSON.parse(after.rotation_state[0].config_json);
  assert.deepEqual({ ...newConfig, workers: oldConfig.workers }, oldConfig);
  for (const key of ["cursor", "plan_state", "reason"]) assert.equal(after.rotation_state[0][key], before.rotation_state[0][key]);
  assert.equal(f.state.requests.length, requestsBefore, "changing daily limits cannot dispatch a collection");
  assert.deepEqual(await fs.readFile(f.sentinel), f.sentinelBytes);
  const today = result.todayItems; assert.equal(today.length, 4); assert.equal(today[1].status, "queued");
  assert.deepEqual(today.map(item => item.conditions), status.todayItems.map(item => item.conditions));
  const tomorrow = result.upcomingItems.filter(item => item.day === "2026-10-31"); assert.equal(tomorrow.length, 6);
  assert.deepEqual(tomorrow.map(item => item.workerKey), ["web", "manual", "web", "manual", "web", "manual"]);
  assert.deepEqual(tomorrow.map(item => item.scheduledAt.slice(11, 16)), ["00:00", "02:00", "04:00", "06:00", "08:00", "10:00"]);
  for (const index of [1, 2, 3]) { f.setTime(`2026-10-30T${String(index * 2).padStart(2, "0")}:00:00.000Z`); await f.scheduler.tick(); }
  assert.equal(f.scheduler.status().todayItems.length, 4, "current day is never expanded after its snapshot was allocated");
  f.setTime("2026-10-31T00:00:00.000Z"); await f.scheduler.tick();
  assert.equal(f.scheduler.status().todayItems.length, 6); assert.equal(f.state.requests.at(-1).payload.bookingRangeDays, 21);
  assert.equal(f.state.requests.at(-1).payload.detailRankRanges, "1-20");
  assert.equal(Object.hasOwn(f.state.requests.at(-1).payload, "requestPacing"), false);
});

test("idempotent limits do not append a revision/event and disabled user pause never becomes enabled", async t => {
  const f = await fixture(t); await f.scheduler.tick();
  const before = stored(f.scheduler), current = f.scheduler.status();
  const unchanged = await f.scheduler.updateDailyLimits({ workers: current.config.workers, expectedRevision: current.revision });
  assert.equal(unchanged.dailyLimitsUpdate.changed, false); assert.deepEqual(stored(f.scheduler), before);
  await f.scheduler.setEnabled(false); const paused = stored(f.scheduler);
  const result = await f.scheduler.updateDailyLimits(f.input()); assert.equal(result.enabled, false);
  assert.equal(result.reason, "ROTATION_PAUSED_BY_USER"); assert.equal(result.dailyLimitsUpdate.enabledPreserved, true);
  assert.deepEqual(stored(f.scheduler).rotation_slots, paused.rotation_slots);
});

test("stale revisions, changed worker identity/order and non-limit inputs cannot change scheduling", async t => {
  const f = await fixture(t); await f.scheduler.tick(); const before = stored(f.scheduler), input = f.input();
  for (const candidate of [
    { ...input, expectedRevision: input.expectedRevision + 1 }, { ...input, enabled: true },
    { ...input, workers: [...six].reverse() }, { ...input, workers: [{ workerKey: "web", dailyLimit: 6 }] },
    { ...input, workers: [{ workerKey: "web", dailyLimit: 3, minIntervalMs: 0 }, six[1]] },
    { ...input, workers: [{ workerKey: "web", dailyLimit: 3.5 }, six[1]] },
    { ...input, workers: [{ workerKey: "web", dailyLimit: 12 }, { workerKey: "manual", dailyLimit: 12 }] }
  ]) { await assert.rejects(f.scheduler.updateDailyLimits(candidate)); assert.deepEqual(stored(f.scheduler), before); }
});

test("protection, uncertainty, existing future trial, conflicts and busy workers reject without writes", async t => {
  const f = await fixture(t); await f.scheduler.tick();
  for (const [key, value, expected] of [["protected", true, "COLLECTOR_PROVIDER_BLOCKED"], ["busy", true, "ROTATION_COLLECTORS_BUSY"], ["conflict", { code: "COLLECTION_ROTATION_INDIVIDUAL_ACTIVE" }, "COLLECTION_ROTATION_INDIVIDUAL_ACTIVE"]]) {
    f.state[key] = value; const before = stored(f.scheduler);
    await assert.rejects(f.scheduler.updateDailyLimits(f.input()), { code: expected }); assert.deepEqual(stored(f.scheduler), before); f.state[key] = key === "conflict" ? null : false;
  }
  sql(f.scheduler.storePath, "UPDATE rotation_slots SET status='uncertain' WHERE day='2026-10-30' AND slot_index=3");
  const uncertain = stored(f.scheduler); await assert.rejects(f.scheduler.updateDailyLimits(f.input()), { code: "ROTATION_UNRESOLVED_EXECUTION" }); assert.deepEqual(stored(f.scheduler), uncertain);
  const pending = await fixture(t, { historyTrial: false, pendingTrial: true }), beforePending = stored(pending.scheduler);
  await assert.rejects(pending.scheduler.updateDailyLimits(pending.input()), { code: "ROTATION_TRIAL_PENDING" }); assert.deepEqual(stored(pending.scheduler), beforePending);
});

test("a current protective pause reason cannot be cleared or resumed by a limit change", async t => {
  const f = await fixture(t); await f.scheduler.setEnabled(false);
  sql(f.scheduler.storePath, "UPDATE rotation_state SET reason='ROTATION_PROVIDER_BLOCKED',plan_state='paused'");
  const before = stored(f.scheduler); await assert.rejects(f.scheduler.updateDailyLimits(f.input()), { code: "ROTATION_LIMITS_PROTECTED" });
  assert.deepEqual(stored(f.scheduler), before); assert.equal(f.scheduler.status().enabled, false);
});

test("active/ticking execution, an admission-time pause and midnight crossing cannot race a limit update", async t => {
  const completion = deferred(), started = deferred();
  const f = await fixture(t, { historyTrial: false, execute: async () => { started.resolve(); return completion.promise; } });
  const tick = f.scheduler.tick(); await started.promise; const active = stored(f.scheduler);
  await assert.rejects(f.scheduler.updateDailyLimits(f.input()), { code: "ROTATION_COLLECTORS_BUSY" }); assert.deepEqual(stored(f.scheduler), active);
  completion.resolve({ runId: "limits_active", collectionQuality: { status: "complete" } }); await tick;
  f.state.freeWait = deferred(); const input = f.input(), update = f.scheduler.updateDailyLimits(input);
  await Promise.resolve(); await f.scheduler.setEnabled(false); const paused = stored(f.scheduler); f.state.freeWait.resolve();
  await assert.rejects(update, { code: "ROTATION_CONFIG_CHANGED" }); assert.deepEqual(stored(f.scheduler), paused);
  f.state.freeWait = deferred(); const midnightBefore = stored(f.scheduler), crossing = f.scheduler.updateDailyLimits(f.input());
  await Promise.resolve(); f.setTime("2026-10-31T00:00:00.000Z"); f.state.freeWait.resolve();
  await assert.rejects(crossing, { code: "ROTATION_CONFIG_CHANGED" }); assert.deepEqual(stored(f.scheduler), midnightBefore);
});

test("concurrent daily-limit updates use the exact revision and append only once", async t => {
  const f = await fixture(t); await f.scheduler.tick(); const before = stored(f.scheduler), input = f.input();
  const results = await Promise.allSettled([f.scheduler.updateDailyLimits(input), f.scheduler.updateDailyLimits(input)]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(results.find(result => result.status === "rejected").reason.code, "ROTATION_CONFIG_CHANGED");
  const after = stored(f.scheduler); assert.equal(after.rotation_revisions.length, before.rotation_revisions.length + 1);
  assert.equal(after.rotation_events.length, before.rotation_events.length + 1); assert.deepEqual(after.rotation_slots, before.rotation_slots);
});

test("read-only monitor distinguishes saved four-slot day from regular six-slot projections without allocating", async t => {
  const f = await fixture(t); await f.scheduler.tick(); await f.scheduler.updateDailyLimits(f.input());
  const before = stored(f.scheduler), requestCount = f.state.requests.length;
  for (let i = 0; i < 3; i++) {
    const snapshot = f.scheduler.monitorSnapshot({ from: "2026-10-30", to: "2026-11-05" });
    assert.equal(snapshot.available, true, snapshot.errorCode); assert.equal(snapshot.currentPlan.dailySlots, 6);
    assert.equal(snapshot.currentPlan.source, "saved_config"); assert.equal(snapshot.currentPlan.nextUnallocatedDay, "2026-10-31");
    assert.deepEqual(snapshot.coverage.days.map(day => day.dailySlots), [4, 6, 6, 6, 6, 6, 6]);
    assert.equal(snapshot.coverage.actualItems, 4); assert.equal(snapshot.coverage.projectedItems, 36);
    assert.ok(snapshot.items.filter(item => item.day === "2026-10-30").every(item => !item.projected && item.conditions.bookingRangeDays === 21));
    assert.ok(snapshot.items.filter(item => item.day === "2026-10-31").every(item => item.projected && item.planKind === "regular"));
    assert.deepEqual(stored(f.scheduler), before); assert.equal(f.state.requests.length, requestCount);
  }
  const old = f.scheduler.monitorSnapshot({ from: "2026-10-27", to: "2026-11-02" });
  assert.equal(old.coverage.days.find(day => day.day === "2026-10-28").planKind, "one_day_trial");
  assert.equal(old.coverage.days.find(day => day.day === "2026-10-28").dailySlots, 6);
});

test("unallocated future trial contributes its two extra cursor positions before a later selected week", async t => {
  const f = await fixture(t, { historyTrial: false, pendingTrial: true }), before = stored(f.scheduler);
  const mixed = f.scheduler.monitorSnapshot({ from: "2026-10-27", to: "2026-11-02" });
  assert.equal(mixed.available, true, mixed.errorCode); assert.equal(mixed.currentPlan.dailySlots, 4);
  assert.deepEqual(mixed.coverage.days.map(day => day.dailySlots), [4, 6, 4, 4, 4, 4, 4]);
  assert.ok(mixed.items.filter(item => item.day === "2026-10-28").every(item => item.projected && item.planKind === "one_day_trial" && item.trialId));
  const later = f.scheduler.monitorSnapshot({ from: "2026-11-02", to: "2026-11-08" });
  assert.equal(later.items[0].keyword, f.scheduler.status().config.keywords[0], "(six days × 4 + trial extra 2) % 13 = 0");
  assert.deepEqual(stored(f.scheduler), before); assert.equal(f.state.requests.length, 0);
});
