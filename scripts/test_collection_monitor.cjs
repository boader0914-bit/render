"use strict";

const assert = require("node:assert/strict");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { test } = require("node:test");
const { createCollectionRotationScheduler, defaultConfig } = require("./collection_rotation_scheduler.cjs");
const { createCollectionPostprocessQueue } = require("./lib/collection_postprocess_queue.cjs");
const { monitorRange, monitorItem, attachMonitorPostprocess } = require("./lib/collection_monitor.cjs");

async function fixture() {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), "collection-monitor-test-"));
  const calls = [];
  const now = () => new Date("2026-10-16T00:00:00.000Z");
  const scheduler = createCollectionRotationScheduler({ dataDir: directory, now, getFreeBytes: async () => 1e9,
    getWorkerState: async () => ({ ready: true, halted: false, retired: false, active: false }),
    executeSlot: async (payload, slot) => { calls.push(slot); return { runId: "monitor_run_1", collectionQuality: { status: "complete" } }; } });
  return { directory, now, scheduler, calls, async close() {
    scheduler.close();
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith("collection-monitor-test-"));
    await fsp.rm(directory, { recursive: true, force: true });
  } };
}
function storedTables(filename) {
  const db = new DatabaseSync(filename, { readOnly: true });
  try { return ["rotation_state", "rotation_days", "rotation_slots", "rotation_events", "rotation_revisions"].map(table => db.prepare("SELECT * FROM " + table + " ORDER BY rowid").all()); }
  finally { db.close(); }
}

test("monitor range uses Korea Monday through Sunday and rejects invalid or oversized periods", () => {
  assert.deepEqual(monitorRange({}, "2026-10-18T15:00:00Z"), { from: "2026-10-19", to: "2026-10-25", today: "2026-10-19", generatedAt: "2026-10-18T15:00:00.000Z", timezone: "Asia/Seoul" });
  for (const query of [{ from: "2026-02-30" }, { from: "2026-10-01", to: "2026-10-08" }, { from: "2026-10-08", to: "2026-10-01" }, { from: "2026-10-01", runId: "unexpected" }]) {
    assert.throws(() => monitorRange(query), { code: "COLLECTION_MONITOR_RANGE_INVALID" });
  }
});

test("uninitialized monitor creates no store and dispatches no collection", async () => {
  const f = await fixture();
  try {
    const snapshot = f.scheduler.monitorSnapshot();
    assert.equal(snapshot.available, false);
    assert.equal(snapshot.errorCode, "COLLECTION_MONITOR_ROTATION_NOT_INITIALIZED");
    assert.deepEqual(await fsp.readdir(f.directory), []);
    assert.equal(f.calls.length, 0);
  } finally { await f.close(); }
});

test("saved slots and future projections keep date, worker, cursor and quality without changing stored schedule", async () => {
  const f = await fixture();
  try {
    await f.scheduler.updateConfig(defaultConfig(f.now()));
    await f.scheduler.setEnabled(true);
    await f.scheduler.tick();
    const before = storedTables(f.scheduler.storePath);
    const snapshot = f.scheduler.monitorSnapshot({ from: "2026-10-12", to: "2026-10-18" });
    assert.equal(snapshot.available, true);
    assert.equal(snapshot.items.length, 12);
    assert.equal(snapshot.coverage.actualItems, 4);
    assert.equal(snapshot.coverage.projectedItems, 8);
    assert.deepEqual(snapshot.coverage.days.map(day => day.status), ["not_started", "not_started", "not_started", "not_started", "saved", "projected", "projected"]);
    const complete = snapshot.items[0];
    assert.equal(complete.projected, false);
    assert.equal(complete.id, "rotation_2026-10-16_1");
    assert.equal(complete.runId, "monitor_run_1");
    assert.equal(complete.collectionQuality.status, "complete");
    assert.equal(snapshot.items[4].keyword, defaultConfig(f.now()).keywords[4]);
    assert.equal(snapshot.items[4].workerKey, "web");
    assert.equal(snapshot.items[4].projected, true);
    assert.deepEqual(storedTables(f.scheduler.storePath), before);
    assert.equal(f.calls.length, 1);
    // Advancing the displayed week advances the hypothetical cursor only; it
    // cannot allocate missing days or advance the saved cursor.
    const later = f.scheduler.monitorSnapshot({ from: "2026-10-19", to: "2026-10-25" });
    assert.equal(later.items[0].keyword, defaultConfig(f.now()).keywords[12]);
    assert.deepEqual(storedTables(f.scheduler.storePath), before);
  } finally { await f.close(); }
});

test("historical absence remains missing and monitoring a closed scheduler does not reopen it", async () => {
  const f = await fixture();
  try {
    await f.scheduler.updateConfig(defaultConfig("2026-10-10T00:00:00Z"));
    const snapshot = f.scheduler.monitorSnapshot({ from: "2026-10-12", to: "2026-10-18" });
    assert.equal(snapshot.coverage.complete, false);
    assert.deepEqual(snapshot.coverage.days.slice(0, 4).map(day => day.status), ["missing", "missing", "missing", "missing"]);
    assert.ok(snapshot.items.every(item => item.projected));
    f.scheduler.close();
    assert.equal(f.scheduler.monitorSnapshot().available, false);
  } finally { await f.close(); }
});

test("an allocated day with missing slots stays unavailable and is never repaired or shown as zero work", async () => {
  const f = await fixture(); let editor;
  try {
    await f.scheduler.updateConfig(defaultConfig(f.now())); await f.scheduler.setEnabled(true); await f.scheduler.tick();
    editor = new DatabaseSync(f.scheduler.storePath); editor.prepare("DELETE FROM rotation_slots WHERE day='2026-10-16'").run();
    const before = storedTables(f.scheduler.storePath), snapshot = f.scheduler.monitorSnapshot();
    assert.equal(snapshot.available, false); assert.equal(snapshot.errorCode, "COLLECTION_MONITOR_DAY_SNAPSHOT_INCOMPLETE");
    assert.equal(snapshot.currentPlan, null); assert.deepEqual(snapshot.items, []);
    assert.deepEqual(storedTables(f.scheduler.storePath), before); assert.equal(f.calls.length, 1);
  } finally { editor?.close(); await f.close(); }
});

test("conflicting terminal receipts stay uncertain and malformed stored evidence fails closed without repair", async () => {
  const f = await fixture();
  let editor;
  try {
    await f.scheduler.updateConfig(defaultConfig(f.now()));
    await f.scheduler.setEnabled(true);
    await f.scheduler.tick();
    editor = new DatabaseSync(f.scheduler.storePath);
    editor.prepare("UPDATE rotation_slots SET result_json=? WHERE id=?").run(JSON.stringify({ status: "failed", runId: "monitor_run_1", collectionQuality: { status: "complete" } }), "rotation_2026-10-16_1");
    const before = storedTables(f.scheduler.storePath);
    const conflict = f.scheduler.monitorSnapshot().items[0];
    assert.equal(conflict.status, "uncertain");
    assert.equal(conflict.errorCode, "COLLECTION_MONITOR_RESULT_STATUS_MISMATCH");
    assert.deepEqual(storedTables(f.scheduler.storePath), before);
    editor.prepare("UPDATE rotation_slots SET result_json=? WHERE id=?").run("{invalid", "rotation_2026-10-16_1");
    const malformed = storedTables(f.scheduler.storePath);
    assert.equal(f.scheduler.monitorSnapshot().available, false);
    assert.deepEqual(storedTables(f.scheduler.storePath), malformed);
    assert.equal(f.calls.length, 1);
  } finally { editor?.close(); await f.close(); }
});

test("projection strips raw receipts, result payloads, unknown fields and secrets", () => {
  const value = monitorItem({ id: "rotation_2026-10-16_1", day: "2026-10-16", keyword: "대전글램핑", workerKey: "web", status: "complete", runId: "run_1",
    collectionQuality: { status: "complete", password: "must-not-escape", counts: { naverOverall: 20 } }, receipt: { token: "must-not-escape" }, result: { rows: ["must-not-escape"] },
    conditions: { checkIn: "2026-10-16", adults: 2, apiKey: "must-not-escape" } });
  assert.equal(JSON.stringify(value).includes("must-not-escape"), false);
  assert.equal(Object.hasOwn(value, "receipt"), false);
  assert.equal(value.conditions.adults, 2);
});

test("SQL payload budget rejects aggregate and individual oversize results without schedule writes", async () => {
  const f = await fixture();
  let editor;
  try {
    await f.scheduler.updateConfig({ ...defaultConfig(f.now()), keywordIntervalMinutes: 60, workers: [{ workerKey: "web", dailyLimit: 13 }] });
    await f.scheduler.setEnabled(true);
    await f.scheduler.tick();
    editor = new DatabaseSync(f.scheduler.storePath);
    const result = JSON.stringify({ status: "queued", padding: "x".repeat(700 * 1024) });
    assert.ok(Buffer.byteLength(result) < 1024 * 1024);
    editor.prepare("UPDATE rotation_slots SET result_json=?").run(result);
    const before = storedTables(f.scheduler.storePath);
    const snapshot = f.scheduler.monitorSnapshot();
    assert.equal(snapshot.available, false);
    assert.equal(snapshot.errorCode, "COLLECTION_MONITOR_PAYLOAD_LIMIT");
    assert.deepEqual(storedTables(f.scheduler.storePath), before);
    editor.prepare("UPDATE rotation_slots SET result_json=NULL").run();
    editor.prepare("UPDATE rotation_slots SET result_json=? WHERE id=?").run(JSON.stringify({ padding: "x".repeat(1024 * 1024) }), "rotation_2026-10-16_1");
    assert.equal(f.scheduler.monitorSnapshot().errorCode, "COLLECTION_MONITOR_PAYLOAD_LIMIT");
    assert.equal(f.calls.length, 1);
  } finally { editor?.close(); await f.close(); }
});

test("large private receipts are never selected into a monitor response", async () => {
  const f = await fixture();
  let editor;
  try {
    await f.scheduler.updateConfig(defaultConfig(f.now()));
    await f.scheduler.setEnabled(true);
    await f.scheduler.tick();
    editor = new DatabaseSync(f.scheduler.storePath);
    const receipt = JSON.stringify({ privateDiagnostic: "private-marker".repeat(100000) });
    editor.prepare("UPDATE rotation_slots SET receipt_json=? WHERE id=?").run(receipt, "rotation_2026-10-16_1");
    const snapshot = f.scheduler.monitorSnapshot();
    assert.equal(snapshot.available, true);
    assert.equal(JSON.stringify(snapshot).includes("private-marker"), false);
    assert.equal(editor.prepare("SELECT receipt_json FROM rotation_slots WHERE id=?").get("rotation_2026-10-16_1").receipt_json, receipt);
  } finally { editor?.close(); await f.close(); }
});

test("same-run postprocess must also match the exact occurrence before it can show completed", () => {
  const item = monitorItem({ id: "rotation_2026-10-16_1", day: "2026-10-16", keyword: "대전글램핑", workerKey: "web", status: "complete", runId: "run_1", collectionQuality: { status: "complete" } });
  const snapshot = { items: [item] };
  const row = { runId: "run_1", scheduleOccurrenceId: item.id, state: "complete" };
  assert.equal(attachMonitorPostprocess(snapshot, { available: true, items: [row] }).items[0].postprocess.bindingVerified, true);
  for (const supplied of [[], [{ ...row, scheduleOccurrenceId: "rotation_2026-10-17_1" }], [{ ...row, runId: "run_other" }]]) {
    const result = attachMonitorPostprocess(snapshot, { available: true, items: supplied }).items[0];
    assert.equal(result.postprocess.state, "unavailable");
    assert.equal(result.postprocess.bindingVerified, false);
  }
});

test("postprocess peek performs zero filesystem calls and preserves uninitialized and missing evidence", async () => {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), "collection-monitor-test-"));
  let allowIO = false, ioCount = 0;
  const fileSystem = new Proxy(fsp, { get(target, key) {
    if (typeof target[key] !== "function") return target[key];
    return (...args) => { ioCount += 1; if (!allowIO) throw new Error("UNEXPECTED_MONITOR_IO"); return target[key](...args); };
  } });
  const queue = createCollectionPostprocessQueue({ dataDir: directory, processRun: async () => ({ ok: true }), fileSystem });
  try {
    assert.equal(queue.peekMonitor({ runIds: ["run_1"] }).available, false);
    assert.equal(ioCount, 0);
    allowIO = true;
    await queue.enqueue("run_1", { context: { scheduleOccurrenceId: "rotation_2026-10-16_1", privateContext: "must-not-escape" } });
    await queue.runOnce();
    allowIO = false;
    const countBefore = ioCount, snapshot = queue.peekMonitor({ runIds: ["run_1", "run_missing"] });
    assert.equal(snapshot.available, true);
    assert.equal(snapshot.items[0].state, "complete");
    assert.equal(snapshot.items[0].scheduleOccurrenceId, "rotation_2026-10-16_1");
    assert.deepEqual(snapshot.missingRunIds, ["run_missing"]);
    assert.equal(JSON.stringify(snapshot).includes("must-not-escape"), false);
    assert.equal(ioCount, countBefore);
  } finally {
    allowIO = true; await queue.close();
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith("collection-monitor-test-"));
    await fsp.rm(directory, { recursive: true, force: true });
  }
});
