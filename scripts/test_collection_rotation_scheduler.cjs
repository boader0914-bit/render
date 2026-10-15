"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { test } = require("node:test");
const { createCollectionRotationScheduler, defaultConfig, validateConfig, planDays, payloadFor, resultFor, errorResult, DEFAULT_KEYWORDS, MIN_FREE_BYTES } = require("./collection_rotation_scheduler.cjs");

function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function readStore(file, sql, ...params) { const db = new DatabaseSync(file, { readOnly: true }); try { return db.prepare(sql).all(...params); } finally { db.close(); } }
function editStore(file, sql, ...params) { const db = new DatabaseSync(file); try { return db.prepare(sql).run(...params); } finally { db.close(); } }
async function fixture(overrides = {}) {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), "collection-rotation-test-"));
  let at = new Date("2026-10-16T00:00:00.000Z");
  const calls = [];
  const options = { dataDir: directory, now: () => at, getFreeBytes: async () => 1024 * 1024 * 1024,
    getWorkerState: async () => ({ ready: true, halted: false, retired: false, active: false }),
    executeSlot: async (payload, slot) => { calls.push({ payload, slot }); return { runId: `rotation_test_${calls.length}`, collectionQuality: { status: "complete" } }; }, ...overrides };
  let scheduler = createCollectionRotationScheduler(options);
  return { directory, calls, options, get scheduler() { return scheduler; }, setTime(value) { at = new Date(value); },
    async prepare(patch = {}) { return scheduler.updateConfig({ ...defaultConfig(at), ...patch }); },
    restart() { scheduler.close(); scheduler = createCollectionRotationScheduler(options); return scheduler; },
    async close() {
      scheduler.close();
      const target = path.resolve(directory);
      assert.equal(path.dirname(target), path.resolve(os.tmpdir()));
      assert.ok(path.basename(target).startsWith("collection-rotation-test-"));
      await fsp.rm(target, { recursive: true, force: true });
    } };
}

test("13-keyword continuous allocation wraps on day four and is balanced per worker over 13 days", () => {
  const config = defaultConfig("2026-10-16T00:00:00Z");
  const result = planDays(config, { days: 13 });
  assert.equal(result.items.length, 52);
  assert.equal(result.nextCursor, 0);
  assert.deepEqual(result.items.slice(12, 16).map(item => item.keyword), ["포천글램핑", "경남글램핑", "대구글램핑", "부산글램핑"]);
  assert.deepEqual(result.items.slice(0, 4).map(item => item.workerKey), ["web", "manual", "web", "manual"]);
  assert.deepEqual(result.items.slice(0, 4).map(item => item.scheduledAt), ["2026-10-16T00:00:00.000Z", "2026-10-16T02:00:00.000Z", "2026-10-16T04:00:00.000Z", "2026-10-16T06:00:00.000Z"]);
  for (const keyword of DEFAULT_KEYWORDS) {
    assert.equal(result.items.filter(item => item.keyword === keyword).length, 4);
    for (const worker of ["web", "manual"]) assert.equal(result.items.filter(item => item.keyword === keyword && item.workerKey === worker).length, 2);
  }
  for (let day = 0; day < 13; day += 1) assert.equal(new Set(result.items.slice(day * 4, day * 4 + 4).map(item => item.keyword)).size, 4);
});

test("configuration rejects duplicate daily keywords, retired workers, invalid units and next-day timetables", () => {
  const config = defaultConfig("2026-10-16T00:00:00Z");
  assert.throws(() => validateConfig({ ...config, keywords: ["a", " a ", "b", "c"] }), { code: "ROTATION_DUPLICATE_KEYWORDS" });
  assert.throws(() => validateConfig({ ...config, keywords: ["a", "b", "c"] }), { code: "ROTATION_DAILY_SLOTS_EXCEED_KEYWORDS" });
  assert.throws(() => validateConfig({ ...config, workers: [{ workerKey: "scheduled", dailyLimit: 2 }] }), { code: "ROTATION_WORKERS_INVALID" });
  assert.throws(() => validateConfig({ ...config, time: "22:00" }), { code: "ROTATION_INTERVAL_INVALID" });
  for (const value of [0, -1, 0.5, "120"]) assert.throws(() => validateConfig({ ...config, keywordIntervalMinutes: value }), { code: "ROTATION_INTERVAL_INVALID" });
  assert.throws(() => validateConfig({ ...config, collection: { ...config.collection, adults: 2 } }), { code: "ROTATION_COLLECTION_INVALID" });
  assert.throws(() => validateConfig({ ...config, requestPacing: null }), { code: "ROTATION_CONFIG_INVALID" });
  assert.throws(() => planDays(config, { cursor: 13 }), { code: "ROTATION_CURSOR_INVALID" });
  assert.throws(() => planDays(config, { days: 0 }), { code: "ROTATION_PREVIEW_DAYS_INVALID" });
  const unequal = planDays({ ...config, workers: [{ workerKey: "web", dailyLimit: 1 }, { workerKey: "manual", dailyLimit: 2 }] }, { days: 1 });
  assert.deepEqual(unequal.items.map(item => item.workerKey), ["web", "manual", "manual"]);
});

test("payload preserves current worker speed, stable receipts, rolling stay dates and two adults", () => {
  const config = defaultConfig("2026-10-16T00:00:00Z");
  const slot = planDays(config, { days: 1 }).items[0];
  const payload = payloadFor(config, slot);
  assert.equal(payload.checkIn, "2026-10-16");
  assert.equal(payload.checkOut, "2026-11-15");
  assert.equal(payload.bookingRangeDays, 31);
  assert.equal(payload.clientRequestId, "rotation_2026-10-16_1");
  assert.equal(payload.scheduleOccurrenceId, payload.clientRequestId);
  assert.equal(payload.adults, 2);
  assert.equal(Object.hasOwn(payload, "requestPacing"), false);
  assert.equal(payloadFor({ ...config, collection: { ...config.collection, bookingDays: 1 } }, slot).checkOut, "2026-10-17");
});

test("read, preview and save never allocate days or execute, and preview is read only", async () => {
  const f = await fixture();
  try {
    const initial = await f.scheduler.status();
    assert.equal(initial.enabled, false);
    assert.equal(initial.revision, 0);
    const saved = await f.prepare();
    const before = readStore(f.scheduler.storePath, "SELECT * FROM rotation_state")[0];
    const preview = await f.scheduler.preview(saved.config, { days: 7 });
    assert.equal(preview.items.length, 28);
    assert.deepEqual(readStore(f.scheduler.storePath, "SELECT * FROM rotation_state")[0], before);
    await f.scheduler.tick();
    assert.equal(readStore(f.scheduler.storePath, "SELECT COUNT(*) count FROM rotation_days")[0].count, 0);
    assert.equal(readStore(f.scheduler.storePath, "SELECT COUNT(*) count FROM rotation_slots")[0].count, 0);
    assert.equal(f.calls.length, 0);
    assert.equal((await f.scheduler.status()).cursor, 0);
  } finally { await f.close(); }
});

test("day allocation and cursor persist atomically before execution; restart cannot repeat a slot", async () => {
  let f;
  f = await fixture({ executeSlot: async (payload, slot) => {
    const rows = readStore(f.scheduler.storePath, "SELECT * FROM rotation_slots ORDER BY slot_index");
    assert.equal(rows.length, 4);
    assert.equal(rows[slot.index].status, "running");
    assert.equal(JSON.parse(rows[slot.index].receipt_json).id, payload.clientRequestId);
    assert.equal(readStore(f.scheduler.storePath, "SELECT cursor FROM rotation_state")[0].cursor, 4);
    f.calls.push({ payload, slot });
    return { runId: `durable_${f.calls.length}`, collectionQuality: { status: "complete" } };
  } });
  try {
    await f.prepare(); await f.scheduler.setEnabled(true);
    const first = await f.scheduler.tick();
    assert.equal(first.status, "complete");
    assert.equal(f.calls.length, 1);
    await f.scheduler.tick();
    f.restart();
    assert.equal(f.scheduler.isEnabled(), true);
    await f.scheduler.tick();
    assert.equal(f.calls.length, 1);
    const current = await f.scheduler.status();
    assert.equal(current.cursor, 4);
    assert.equal(current.todayItems.length, 4);
    assert.equal(current.todayItems[0].runId, "durable_1");
    f.setTime("2026-10-16T02:00:00Z"); await f.scheduler.tick();
    assert.equal(f.calls.length, 2);
    assert.equal(f.calls[1].payload.workerKey, "manual");
  } finally { await f.close(); }
});

test("actual start and finish delay the next slot without backlog bursts", async () => {
  let f;
  f = await fixture({ executeSlot: async (payload, slot) => {
    f.calls.push({ payload, slot });
    if (f.calls.length === 1) f.setTime("2026-10-16T03:00:00Z");
    return { runId: `delayed_${f.calls.length}`, output: { startedAt: slot.startedAt }, collectionQuality: { status: "complete" } };
  } });
  try {
    await f.prepare(); await f.scheduler.setEnabled(true);
    f.setTime("2026-10-16T00:30:00Z");
    await f.scheduler.tick();
    assert.equal((await f.scheduler.status()).todayItems[1].notBeforeAt, "2026-10-16T03:00:00.000Z");
    await f.scheduler.tick();
    assert.equal(f.calls.length, 2);
    assert.equal((await f.scheduler.status()).todayItems[2].notBeforeAt, "2026-10-16T05:00:00.000Z");
    f.setTime("2026-10-16T04:00:00Z"); await f.scheduler.tick();
    assert.equal(f.calls.length, 2);
    f.setTime("2026-10-16T05:00:00Z"); await f.scheduler.tick();
    assert.equal(f.calls.length, 3);
  } finally { await f.close(); }
});

test("verified crawler start, rather than receipt acceptance, determines the next start gap", async () => {
  let f;
  f = await fixture({ executeSlot: async (payload, slot) => {
    f.calls.push({ payload, slot });
    f.setTime("2026-10-16T00:40:00Z");
    return { runId: "queue_delay", output: { startedAt: "2026-10-16T00:20:00Z" }, collectionQuality: { status: "complete" } };
  } });
  try {
    await f.prepare(); await f.scheduler.setEnabled(true); await f.scheduler.tick();
    const state = await f.scheduler.status();
    assert.equal(state.todayItems[0].acceptedAt, "2026-10-16T00:00:00.000Z");
    assert.equal(state.todayItems[0].startedAt, "2026-10-16T00:20:00.000Z");
    assert.equal(state.todayItems[0].executionDurationMs, 20 * 60000);
    assert.equal(state.todayItems[1].notBeforeAt, "2026-10-16T02:20:00.000Z");
    f.setTime("2026-10-16T02:00:00Z"); await f.scheduler.tick();
    assert.equal(f.calls.length, 1);
  } finally { await f.close(); }
});

test("missing actual start uses completion as a conservative timing bound, not an invented observation", async () => {
  let f;
  f = await fixture({ executeSlot: async () => {
    f.setTime("2026-10-16T00:40:00Z");
    return { runId: "old_engine_without_actual_timing", collectionQuality: { status: "complete" } };
  } });
  try {
    await f.prepare(); await f.scheduler.setEnabled(true); await f.scheduler.tick();
    const state = await f.scheduler.status();
    assert.equal(state.todayItems[0].startedAt, null);
    assert.equal(state.todayItems[0].observedAt, undefined);
    assert.equal(state.todayItems[1].notBeforeAt, "2026-10-16T02:40:00.000Z");
    f.setTime("2026-10-16T02:00:00Z"); await f.scheduler.tick();
    assert.equal(state.todayItems[1].status, "queued");
  } finally { await f.close(); }
});

test("pause, revision and resume cannot create more allocations on an already allocated day", async () => {
  const f = await fixture();
  try {
    await f.prepare(); await f.scheduler.setEnabled(true); await f.scheduler.tick();
    await assert.rejects(f.scheduler.updateConfig({ time: "10:00" }), { code: "ROTATION_ACTIVE_EDIT_FORBIDDEN" });
    await f.scheduler.setEnabled(false);
    assert.ok((await f.scheduler.status()).todayItems.slice(1).every(item => item.status === "paused"));
    await f.scheduler.updateConfig({ time: "10:00", workers: [{ workerKey: "web", dailyLimit: 3 }, { workerKey: "manual", dailyLimit: 2 }] });
    await f.scheduler.setEnabled(true);
    f.setTime("2026-10-16T07:00:00Z"); await f.scheduler.tick();
    assert.equal(f.calls.length, 1);
    assert.equal((await f.scheduler.status()).todayItems.length, 4);
    f.setTime("2026-10-17T01:00:00Z"); await f.scheduler.tick();
    const tomorrow = await f.scheduler.status();
    assert.equal(tomorrow.todayItems.length, 5);
    assert.equal(tomorrow.todayItems[0].keyword, "충남글램핑");
    assert.equal(tomorrow.cursor, 9);
    assert.equal((await f.scheduler.history()).items.length, 9);
  } finally { await f.close(); }
});

test("paused days do not allocate or advance cursor, and downtime does not allocate past days", async () => {
  const f = await fixture();
  try {
    await f.prepare();
    f.setTime("2026-10-19T00:00:00Z"); await f.scheduler.tick();
    assert.equal((await f.scheduler.status()).cursor, 0);
    await f.scheduler.setEnabled(true); await f.scheduler.tick();
    assert.equal((await f.scheduler.history()).items.length, 4);
    assert.equal((await f.scheduler.status()).todayItems[0].keyword, "경남글램핑");
    await f.scheduler.setEnabled(false);
    f.setTime("2026-10-21T00:00:00Z"); await f.scheduler.tick();
    assert.equal((await f.scheduler.status()).cursor, 4);
    assert.equal((await f.scheduler.history()).items.length, 4);
  } finally { await f.close(); }
});

test("shared busy state waits without receipt, then expires at midnight instead of replaying", async () => {
  let busy = true;
  const f = await fixture({ conflictCheck: async (_config, { phase }) => phase === "tick" && busy ? { wait: true, code: "COLLECTION_ROTATION_BUSY" } : null });
  try {
    await f.prepare(); await f.scheduler.setEnabled(true); await f.scheduler.tick();
    const waiting = (await f.scheduler.status()).todayItems[0];
    assert.equal(waiting.status, "waiting"); assert.equal(waiting.receipt, null);
    assert.equal(f.calls.length, 0); assert.equal(f.scheduler.isEnabled(), true);
    f.setTime("2026-10-17T00:00:00Z"); busy = false;
    await f.scheduler.tick();
    const yesterday = await f.scheduler.history({ from: "2026-10-16", to: "2026-10-16" });
    assert.ok(yesterday.items.every(item => item.status === "missed"));
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].payload.checkIn, "2026-10-17");
    assert.equal(f.calls[0].payload.keyword, "충남글램핑");
  } finally { await f.close(); }
});

test("partial, provider block and unverified quality pause remaining work and retain safe diagnostics", async () => {
  for (const result of [{ runId: "partial_run", collectionQuality: { status: "partial", reason: "booking_results_incomplete" } },
    { runId: "blocked_run", collectionQuality: { status: "blocked", blockedReason: "naver_booking_api_too_many_requests" } },
    { runId: "http200_is_not_validation", statusCode: 200 }]) {
    const f = await fixture({ executeSlot: async () => { f.calls.push({}); return result; } });
    try {
      await f.prepare(); await f.scheduler.setEnabled(true);
      const first = await f.scheduler.tick();
      assert.ok(["partial", "blocked", "failed"].includes(first.status));
      assert.equal(f.scheduler.isEnabled(), false);
      const state = await f.scheduler.status();
      assert.ok(state.todayItems.slice(1).every(item => item.status === "paused"));
      f.setTime("2026-10-16T08:00:00Z"); await f.scheduler.tick();
      assert.equal(f.calls.length, 1);
      assert.equal(state.cursor, 4);
    } finally { await f.close(); }
  }
});

test("reuse is distinct from new collection and unknown acknowledgement is never automatically retried", async () => {
  const reused = resultFor({ reused: true, runId: "known_good", observedAt: "2026-10-16T00:01:00Z", collectionQuality: { status: "complete" } });
  assert.equal(reused.status, "reused");
  assert.equal(reused.observedAt, "2026-10-16T00:01:00.000Z");
  assert.equal(resultFor({ reused: true, runId: "known_good", reuse: { observedAt: "2026-10-16T00:01:00Z" },
    output: { startedAt: "2026-10-16T02:00:00Z" }, collectionQuality: { status: "complete" } }).observedAt, "2026-10-16T00:01:00.000Z");
  const secret = "https://private.invalid/?token=secret cookie=secret";
  const f = await fixture({ executeSlot: async () => { f.calls.push({}); throw Object.assign(new Error(secret), { code: "COLLECTOR_RESULT_TIMEOUT" }); } });
  try {
    await f.prepare(); await f.scheduler.setEnabled(true);
    assert.equal((await f.scheduler.tick()).status, "uncertain");
    await assert.rejects(f.scheduler.setEnabled(true), { code: "ROTATION_UNRESOLVED_EXECUTION" });
    f.restart(); await f.scheduler.tick();
    assert.equal(f.calls.length, 1);
    assert.equal((await f.scheduler.status()).planState, "review");
    assert.equal(JSON.stringify(await f.scheduler.history()).includes("secret"), false);
  } finally { await f.close(); }
});

test("confirmed unclaimed broker pause is distinct from cancellation with unknown remote execution", () => {
  assert.deepEqual(errorResult({ code: "COLLECTOR_SCHEDULE_PAUSED" }), { status: "paused", errorCode: "COLLECTOR_SCHEDULE_PAUSED" });
  assert.deepEqual(errorResult({ code: "CRAWL_CANCELLED" }), { status: "uncertain", errorCode: "CRAWL_CANCELLED" });
  assert.deepEqual(errorResult({ code: "COLLECTOR_RESULT_TIMEOUT" }), { status: "uncertain", errorCode: "COLLECTOR_RESULT_TIMEOUT" });
});

test("restart with an accepted running receipt fails closed without generating another request", async () => {
  const f = await fixture();
  try {
    await f.prepare(); await f.scheduler.setEnabled(true); await f.scheduler.tick();
    editStore(f.scheduler.storePath, "UPDATE rotation_slots SET status='running',started_at=?,receipt_json=? WHERE slot_index=1", "2026-10-16T02:00:00Z", JSON.stringify({ id: "rotation_2026-10-16_2" }));
    f.restart();
    const state = await f.scheduler.status();
    assert.equal(state.enabled, false); assert.equal(state.planState, "review");
    assert.equal(state.todayItems[1].status, "uncertain");
    f.setTime("2026-10-16T06:00:00Z"); await f.scheduler.tick();
    assert.equal(f.calls.length, 1);
    await assert.rejects(f.scheduler.setEnabled(true), { code: "ROTATION_UNRESOLVED_EXECUTION" });
  } finally { await f.close(); }
});

test("offline worker or low disk pauses finitely and never clears protection or starts the other worker", async () => {
  let ready = true, freeBytes = 1024 * 1024 * 1024;
  const f = await fixture({ getWorkerState: async () => ({ ready }), getFreeBytes: async () => freeBytes });
  try {
    await f.prepare(); ready = false;
    await assert.rejects(f.scheduler.setEnabled(true), { code: "ROTATION_WORKER_NOT_READY" });
    ready = true; freeBytes = MIN_FREE_BYTES;
    await assert.rejects(f.scheduler.setEnabled(true), { code: "ROTATION_DISK_SPACE_UNAVAILABLE" });
    freeBytes = MIN_FREE_BYTES + 1; await f.scheduler.setEnabled(true);
    ready = false; await f.scheduler.tick();
    assert.equal(f.scheduler.isEnabled(), false);
    assert.equal((await f.scheduler.status()).reason, "ROTATION_WORKER_NOT_READY");
    assert.equal(f.calls.length, 0);
    ready = true; await f.scheduler.setEnabled(true);
    f.setTime("2026-10-17T00:00:00Z"); freeBytes = MIN_FREE_BYTES;
    await f.scheduler.tick();
    assert.equal(f.scheduler.isEnabled(), false);
    assert.equal((await f.scheduler.status()).reason, "ROTATION_DISK_SPACE_UNAVAILABLE");
    assert.equal(f.calls.length, 0);
  } finally { await f.close(); }
});

test("pause while preflight is awaiting and concurrent ticks cannot dispatch a new slot", async () => {
  const gate = deferred();
  let checking = false;
  const f = await fixture({ conflictCheck: async (_config, { phase }) => {
    if (phase === "tick") { checking = true; await gate.promise; }
    return null;
  } });
  try {
    await f.prepare(); await f.scheduler.setEnabled(true);
    const first = f.scheduler.tick(); const second = f.scheduler.tick();
    assert.equal(first, second);
    for (let attempts = 0; attempts < 30 && !checking; attempts++) await new Promise(resolve => setImmediate(resolve));
    assert.equal(checking, true);
    await f.scheduler.setEnabled(false); gate.resolve();
    await first;
    assert.equal(f.calls.length, 0);
    assert.ok((await f.scheduler.status()).todayItems.every(item => item.receipt === null));
  } finally { await f.close(); }
});

test("individual schedule conflict is rejected without modifying the saved schedule or receipts", async () => {
  const f = await fixture({ conflictCheck: async () => ({ code: "INDIVIDUAL_SCHEDULE_ENABLED", workerKey: "manual" }) });
  try {
    await f.prepare();
    await assert.rejects(f.scheduler.setEnabled(true), { code: "INDIVIDUAL_SCHEDULE_ENABLED" });
    assert.equal((await f.scheduler.status()).enabled, false);
    assert.equal((await f.scheduler.history()).items.length, 0);
    assert.equal(f.calls.length, 0);
  } finally { await f.close(); }
});

test("keyword edits preserve the next unallocated keyword and cannot silently reset the cursor", async () => {
  const f = await fixture();
  try {
    await f.prepare(); await f.scheduler.setEnabled(true); await f.scheduler.tick(); await f.scheduler.setEnabled(false);
    const keywords = [...DEFAULT_KEYWORDS].reverse();
    await f.scheduler.updateConfig({ keywords });
    assert.equal((await f.scheduler.status()).nextKeyword, "충남글램핑");
    await assert.rejects(f.scheduler.updateConfig({ keywords: keywords.filter(word => word !== "충남글램핑") }), { code: "ROTATION_START_POSITION_REQUIRED" });
    assert.throws(() => f.scheduler.preview({ ...(f.scheduler.status().config), keywords: keywords.filter(word => word !== "충남글램핑") }), { code: "ROTATION_START_POSITION_REQUIRED" });
    assert.equal((await f.scheduler.status()).nextKeyword, "충남글램핑");
    const changed = { ...(f.scheduler.status().config), keywords: keywords.filter(word => word !== "충남글램핑") };
    assert.equal(f.scheduler.preview(changed, { startKeyword: "경주글램핑" }).items[0].keyword, "경주글램핑");
    await assert.rejects(f.scheduler.updateConfig(changed, { startKeyword: "없는키워드" }), { code: "ROTATION_START_POSITION_INVALID" });
    await f.scheduler.updateConfig(changed, { startKeyword: "경주글램핑" });
    assert.equal(f.scheduler.status().nextKeyword, "경주글램핑");
  } finally { await f.close(); }
});

test("history pages preserve every allocation without a silent maximum or duplicate boundary", async () => {
  const f = await fixture();
  try {
    await f.prepare(); await f.scheduler.setEnabled(true);
    for (let day = 16; day <= 20; day += 1) { f.setTime(`2026-10-${day}T00:00:00Z`); await f.scheduler.tick(); }
    const collected = [];
    let offset = 0, page;
    do {
      page = f.scheduler.history({ limit: 3, offset });
      assert.equal(page.total, 20);
      assert.equal(page.offset, offset);
      collected.push(...page.items); offset += page.items.length;
    } while (page.hasMore);
    assert.equal(collected.length, 20);
    assert.equal(new Set(collected.map(item => item.id)).size, 20);
    assert.equal(f.scheduler.history({ from: "2026-10-18", to: "2026-10-19", limit: 2 }).total, 8);
    assert.throws(() => f.scheduler.history({ offset: -1 }), { code: "ROTATION_HISTORY_QUERY_INVALID" });
    assert.throws(() => f.scheduler.history({ offset: 10000001 }), { code: "ROTATION_HISTORY_QUERY_INVALID" });
  } finally { await f.close(); }
});
