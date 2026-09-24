"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { createKeywordWorkerScheduler, defaultConfig, validateConfig, uniqueKeywords, payloadFor, dateKey, MIN_FREE_BYTES, GRACE_MS } = require("./keyword_worker_scheduler.cjs");

async function fixture(overrides = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "keyword-worker-scheduler-test-"));
  let time = new Date("2026-09-23T04:59:00.000Z");
  const calls = [];
  const options = { dataDir: directory, now: () => time, getFreeBytes: async () => 1024 * 1024 * 1024,
    runCrawler: async payload => { calls.push(payload); return { runId: `test_glamping_20260923_${String(calls.length).padStart(6, "0")}`, collectionQuality: { status: "complete" } }; }, ...overrides };
  const scheduler = createKeywordWorkerScheduler(options);
  const namespace = !options.workerKey || options.workerKey === "scheduled" ? "keyword-worker-schedule" : `keyword-worker-schedule-${options.workerKey}`;
  const configFile = path.join(directory, "config", `${namespace}.json`);
  const receiptDir = path.join(directory, "history", namespace);
  return { scheduler, options, directory, calls, configFile, receiptDir, setTime: value => { time = new Date(value); },
    prepare: async patch => scheduler.updateConfig({ keywords: ["포천글램핑", "가평글램핑"], ...patch }),
    close: async () => {
      scheduler.stop();
      const resolved = path.resolve(directory);
      assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
      assert.ok(path.basename(resolved).startsWith("keyword-worker-scheduler-test-"));
      await fs.rm(resolved, { recursive: true, force: true });
    } };
}
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
async function waitFor(predicate) { for (let attempt = 0; attempt < 150; attempt += 1) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 2)); } throw new Error("condition_not_reached"); }

test("disabled default and saving never initiate collection or activate former daily policy", async () => {
  const f = await fixture();
  try {
    assert.equal((await f.scheduler.status()).config.enabled, false);
    const saved = await f.prepare();
    assert.equal(saved.firstDate, "2026-09-23");
    assert.equal(saved.enabled, false);
    f.setTime("2026-09-23T05:00:00Z");
    await f.scheduler.tick();
    await assert.rejects(() => f.scheduler.updateConfig({ enabled: true }), { code: "KEYWORD_SCHEDULE_USE_ENABLE_ACTION" });
    assert.equal(f.calls.length, 0);
    assert.equal((await f.scheduler.status()).nextRunAt, null);
    await assert.rejects(() => fs.access(path.join(f.directory, "config", "daily_keyword_collection.json")), { code: "ENOENT" });
  } finally { await f.close(); }
});

test("keyword normalization is ordered and does not conflate internal spaces", () => {
  assert.deepEqual(uniqueKeywords([" 포천글램핑 ", "포천글램핑", "포천 글램핑", "Ａ글램핑", "A글램핑"]), ["포천글램핑", "포천 글램핑", "A글램핑"]);
  assert.throws(() => uniqueKeywords(["a\nb"]));
});

test("dates, repeat, ranks, unsupported version, and injected fields are rejected", () => {
  const config = defaultConfig("2026-09-23T00:00:00Z");
  for (const patch of [{ firstDate: "2026-02-30" }, { time: "24:00" }, { version: 2 }, { repeat: "hourly" }, { token: "secret" }]) assert.throws(() => validateConfig({ ...config, ...patch }));
  for (const patch of [{ adults: 0 }, { bookingDays: 32 }, { detailRankRanges: "0-5" }, { detailRankRanges: "20-1" }, { productMode: "stay" }, { dateMode: "fixed", checkIn: "2026-09-23", checkOut: "2026-09-25", bookingDays: 2 }]) assert.throws(() => validateConfig({ ...config, collection: { ...config.collection, ...patch } }));
  assert.equal(dateKey("2026-12-31T15:00:00Z"), "2027-01-01");
});

test("KST scheduled boundary dispatches ordered snapshots once and records final results", async () => {
  const f = await fixture();
  try {
    await f.prepare();
    await f.scheduler.setEnabled(true);
    await f.scheduler.tick();
    assert.equal(f.calls.length, 0);
    assert.equal((await f.scheduler.status()).nextRunAt, "2026-09-23T05:00:00.000Z");
    f.setTime("2026-09-23T05:00:00Z");
    const occurrence = await f.scheduler.tick();
    assert.equal(occurrence.status, "complete");
    assert.equal(occurrence.id, "scheduled_2026-09-23");
    assert.deepEqual(f.calls.map(call => call.keyword), ["포천글램핑", "가평글램핑"]);
    for (const payload of f.calls) {
      assert.equal(payload.workerKey, "scheduled");
      assert.equal(payload.trigger, "scheduled");
      assert.equal(payload.scheduledCollection, true);
      assert.equal(payload.checkIn, "2026-09-23");
      assert.equal(payload.checkOut, "2026-10-23");
      assert.equal(payload.bookingRangeDays, 31);
      assert.equal(payload.detailRankRanges, "1-20");
      assert.equal(payload.adults, 2);
      assert.equal(Object.hasOwn(payload, "requestPacing"), false);
    }
    await f.scheduler.tick();
    await f.scheduler.updateConfig({ time: "14:01", keywords: ["경남글램핑"] });
    f.setTime("2026-09-23T05:01:00Z");
    await f.scheduler.tick();
    assert.equal(f.calls.length, 2);
    assert.equal((await f.scheduler.status()).nextRunAt, "2026-09-24T05:01:00.000Z");
  } finally { await f.close(); }
});

test("immediate run works while disabled and leaves saved config and future schedule unchanged", async () => {
  const f = await fixture();
  try {
    await f.prepare();
    const before = await fs.readFile(f.configFile, "utf8");
    const entry = await f.scheduler.runNow({ keywords: ["경남글램핑"], collection: { bookingDays: 1, detailRankRanges: "1-5" }, requestId: "manual-test-0001" });
    assert.equal(entry.status, "complete");
    assert.equal(entry.items.length, 1);
    assert.equal(f.calls[0].scheduledCollection, false);
    assert.equal(f.calls[0].trigger, "manual");
    assert.equal(f.calls[0].workerKey, "scheduled");
    assert.equal(f.calls[0].checkOut, "2026-09-24");
    assert.equal(await fs.readFile(f.configFile, "utf8"), before);
    const repeated = await f.scheduler.runNow({ requestId: "manual-test-0001" });
    assert.equal(repeated.id, entry.id);
    assert.equal(f.calls.length, 1);
    await f.scheduler.setEnabled(true);
    const next = (await f.scheduler.status()).nextRunAt;
    await f.scheduler.runNow({ keywords: ["경북글램핑"] });
    assert.equal((await f.scheduler.status()).nextRunAt, next);
  } finally { await f.close(); }
});

test("new settings and immediate overrides cannot reapply removed pacing or guest controls", async () => {
  const f = await fixture();
  try {
    const pacing = { enabled: true, minIntervalMs: 200, maxConcurrentRequests: 2, detailConcurrency: 1, scheduleConcurrency: 2, otaConcurrency: 1 };
    const saved = await f.prepare({ keywords: ["포천글램핑"], collection: { adults: 6 }, requestPacing: pacing });
    assert.equal(saved.collection.adults, 2);
    assert.equal(saved.requestPacing, null);
    assert.deepEqual(JSON.parse(await fs.readFile(f.configFile, "utf8")), saved);
    const first = await f.scheduler.runNow();
    const second = await f.scheduler.runNow({ collection: { adults: 8 }, requestPacing: pacing });
    for (const payload of f.calls) {
      assert.equal(payload.adults, 2);
      assert.equal(Object.hasOwn(payload, "requestPacing"), false);
    }
    for (const receipt of [first, second]) {
      assert.equal(receipt.config.collection.adults, 2);
      assert.equal(receipt.config.requestPacing, null);
    }
    assert.deepEqual((await f.scheduler.status()).config, saved);
  } finally { await f.close(); }
});

test("legacy saved controls are ignored without resaving while historical receipts remain unchanged", async () => {
  const f = await fixture();
  try {
    await f.prepare({ keywords: ["포천글램핑"] });
    const oldReceipt = await f.scheduler.runNow({ requestId: "legacy-request-001" });
    const legacy = defaultConfig("2026-09-23T00:00:00Z");
    legacy.enabled = true;
    legacy.keywords = ["포천글램핑"];
    legacy.collection.adults = 6;
    legacy.requestPacing = { enabled: true, minIntervalMs: 500, maxConcurrentRequests: 1, detailConcurrency: 1, scheduleConcurrency: 1, otaConcurrency: 1 };
    oldReceipt.config = structuredClone(legacy);
    const oldPath = path.join(f.receiptDir, `${oldReceipt.id}.json`);
    await fs.writeFile(oldPath, JSON.stringify(oldReceipt));
    await fs.writeFile(f.configFile, JSON.stringify(legacy));
    const oldReceiptBytes = await fs.readFile(oldPath, "utf8");
    const savedBytes = await fs.readFile(f.configFile, "utf8");
    assert.deepEqual(validateConfig(legacy), legacy);
    const status = await f.scheduler.status();
    assert.equal(status.config.collection.adults, 2);
    assert.equal(status.config.requestPacing, null);
    assert.deepEqual(status.latest[0].config, legacy);
    const retry = await f.scheduler.runNow({ requestId: "legacy-request-001" });
    assert.deepEqual(retry.config, legacy);
    assert.equal(f.calls.length, 1);
    const immediate = await f.scheduler.runNow({ requestId: "current-request-001" });
    f.setTime("2026-09-23T05:00:00Z");
    const scheduled = await f.scheduler.tick();
    for (const receipt of [immediate, scheduled]) {
      assert.equal(receipt.config.collection.adults, 2);
      assert.equal(receipt.config.requestPacing, null);
    }
    for (const payload of [...f.calls.slice(1), payloadFor(legacy, "포천글램핑", "2026-09-23", "scheduled_2026-09-23", 0, "scheduled")]) {
      assert.equal(payload.adults, 2);
      assert.equal(Object.hasOwn(payload, "requestPacing"), false);
    }
    assert.equal(await fs.readFile(f.configFile, "utf8"), savedBytes);
    assert.equal(await fs.readFile(oldPath, "utf8"), oldReceiptBytes);
  } finally { await f.close(); }
});

test("enqueueNow accepts durable receipt before final result and retry never queues a second batch", async () => {
  const gate = deferred();
  const entered = deferred();
  let count = 0;
  const f = await fixture({ runCrawler: async () => { count += 1; entered.resolve(); await gate.promise; return { runId: "async_run", quality: { status: "complete" } }; } });
  try {
    await f.prepare({ keywords: ["포천글램핑"] });
    const before = await fs.readFile(f.configFile, "utf8");
    const accepted = await f.scheduler.enqueueNow({ requestId: "async-request-001" });
    assert.ok(["queued", "running"].includes(accepted.status));
    assert.ok((await fs.readFile(path.join(f.receiptDir, `${accepted.id}.json`), "utf8")).includes(accepted.id));
    await entered.promise;
    const retry = await f.scheduler.enqueueNow({ requestId: "async-request-001" });
    assert.equal(retry.id, accepted.id);
    assert.equal(count, 1);
    assert.equal((await f.scheduler.status()).active, true);
    assert.equal(await fs.readFile(f.configFile, "utf8"), before);
    gate.resolve();
    await waitFor(async () => (await f.scheduler.status()).active === false);
    assert.equal((await f.scheduler.status()).latest[0].status, "complete");
    assert.equal((await f.scheduler.status()).latest[0].items[0].runId, "async_run");
    await f.scheduler.enqueueNow({ requestId: "async-request-001" });
    assert.equal(count, 1);
  } finally { gate.resolve(); await f.close(); }
});

test("enqueueNow records asynchronous failure after acceptance without unhandled rejection or retry", async () => {
  const f = await fixture({ runCrawler: async () => { const error = new Error("provider detail"); error.status = 429; throw error; } });
  try {
    await f.prepare();
    await f.scheduler.enqueueNow({ requestId: "async-blocked-001" });
    await waitFor(async () => (await f.scheduler.status()).active === false);
    const status = await f.scheduler.status();
    assert.equal(status.latest[0].status, "blocked");
    assert.equal(status.latest[0].items[1].status, "blocked");
  } finally { await f.close(); }
});

test("immediate preflight rejects new work before writing an acceptance receipt", async () => {
  let guards = 0;
  const f = await fixture({ beforeImmediateRun: async () => { guards++; throw Object.assign(new Error("worker unavailable"), { code: "COLLECTOR_OFFLINE" }); } });
  try {
    await f.prepare({ keywords: ["포천글램핑"] });
    await assert.rejects(() => f.scheduler.enqueueNow({ requestId: "offline-request-001" }), { code: "COLLECTOR_OFFLINE" });
    assert.equal(guards, 1);
    assert.equal(f.calls.length, 0);
    assert.equal((await f.scheduler.status()).latest.length, 0);
    assert.deepEqual(await fs.readdir(f.receiptDir), []);
  } finally { await f.close(); }
});

test("same immediate request looks up its accepted snapshot after offline status and expired saved dates", async () => {
  let guards = 0;
  let offline = false;
  const entered = deferred();
  const gate = deferred();
  const f = await fixture({
    beforeImmediateRun: async () => { guards++; if (offline) throw Object.assign(new Error("offline"), { code: "COLLECTOR_OFFLINE" }); },
    runCrawler: async () => { entered.resolve(); await gate.promise; return { runId: "accepted_snapshot", quality: { status: "complete" } }; }
  });
  try {
    await f.prepare({ keywords: ["포천글램핑"] });
    const accepted = await f.scheduler.enqueueNow({ requestId: "retry-snapshot-001" });
    await entered.promise;
    offline = true;
    await f.scheduler.updateConfig({ keywords: ["다른 키워드"], collection: { dateMode: "fixed", checkIn: "2026-09-22", checkOut: "2026-09-22", bookingDays: 1 } });
    const repeated = await f.scheduler.enqueueNow({ requestId: "retry-snapshot-001" });
    assert.equal(repeated.id, accepted.id);
    assert.deepEqual(repeated.config.keywords, ["포천글램핑"]);
    assert.equal(guards, 1);
    gate.resolve();
    await waitFor(async () => !(await f.scheduler.status()).active);
    f.scheduler.stop();
    const completed = await f.scheduler.runNow({ requestId: "retry-snapshot-001" });
    assert.equal(completed.id, accepted.id);
    assert.equal(completed.status, "complete");
    assert.equal(completed.items[0].runId, "accepted_snapshot");
    assert.equal(guards, 1);
    assert.equal((await f.scheduler.status()).latest.length, 1);
  } finally { gate.resolve(); await f.close(); }
});

test("weekdays skip weekends and once does not repeat", async () => {
  const f = await fixture();
  try {
    await f.prepare({ repeat: "weekdays" });
    await f.scheduler.setEnabled(true);
    f.setTime("2026-09-26T05:00:00Z");
    await f.scheduler.tick();
    assert.equal(f.calls.length, 0);
    assert.equal((await f.scheduler.status()).nextRunAt, "2026-09-28T05:00:00.000Z");
    await f.scheduler.updateConfig({ repeat: "once", firstDate: "2026-09-28" });
    f.setTime("2026-09-28T05:00:00Z");
    await f.scheduler.tick();
    f.setTime("2026-09-29T05:00:00Z");
    await f.scheduler.tick();
    assert.equal(f.calls.length, 2);
    assert.equal((await f.scheduler.status()).nextRunAt, null);
  } finally { await f.close(); }
});

test("late restart marks missed occurrence without catchup requests", async () => {
  const f = await fixture();
  try {
    await f.prepare();
    await f.scheduler.setEnabled(true);
    f.setTime(new Date(Date.parse("2026-09-23T05:00:00Z") + GRACE_MS + 1));
    const late = await f.scheduler.tick();
    assert.equal(late.status, "missed");
    assert.equal(f.calls.length, 0);
    f.setTime("2026-09-26T05:00:00Z");
    await f.scheduler.tick();
    assert.equal(f.calls.length, 2);
    const entries = (await f.scheduler.status()).latest;
    assert.equal(entries.length, 2);
    assert.equal(entries.some(entry => entry.day === "2026-09-24"), false);
  } finally { await f.close(); }
});

test("missed once schedule is recorded and is not run after reactivation", async () => {
  const f = await fixture();
  try {
    await f.prepare({ repeat: "once", firstDate: "2026-09-23" });
    await f.scheduler.setEnabled(true);
    f.setTime("2026-09-24T05:00:00Z");
    const result = await f.scheduler.tick();
    assert.equal(result.status, "missed");
    await f.scheduler.setEnabled(false);
    await assert.rejects(() => f.scheduler.setEnabled(true), { code: "KEYWORD_SCHEDULE_TIME_EXPIRED" });
    await f.scheduler.tick();
    assert.equal(f.calls.length, 0);
    assert.equal((await f.scheduler.status()).latest.length, 1);
  } finally { await f.close(); }
});

test("pause finishes submitted item and prevents remaining batch even if resumed before it finishes", async () => {
  const entered = deferred();
  const gate = deferred();
  let count = 0;
  const f = await fixture({ runCrawler: async () => { count += 1; entered.resolve(); await gate.promise; return { runId: "run_first", quality: { status: "complete" } }; } });
  try {
    await f.prepare();
    await f.scheduler.setEnabled(true);
    f.setTime("2026-09-23T05:00:00Z");
    const running = f.scheduler.tick();
    await entered.promise;
    await f.scheduler.setEnabled(false);
    await f.scheduler.setEnabled(true);
    gate.resolve();
    const result = await running;
    assert.equal(count, 1);
    assert.equal(result.items[0].status, "complete");
    assert.equal(result.items[1].status, "interrupted");
    assert.equal(result.status, "interrupted");
    await f.scheduler.tick();
    assert.equal(count, 1);
  } finally { gate.resolve(); await f.close(); }
});

test("busy immediate run does not block scheduled dispatch and no busy timeout is imposed", async () => {
  const manual = deferred();
  const entered = deferred();
  const triggers = [];
  const f = await fixture({ runCrawler: async payload => { triggers.push(payload.trigger); if (payload.trigger === "manual") { entered.resolve(); await manual.promise; } return { runId: `run_${payload.trigger}`, quality: { status: "complete" } }; } });
  try {
    await f.prepare({ keywords: ["포천글램핑"] });
    await f.scheduler.setEnabled(true);
    const immediate = f.scheduler.runNow();
    await entered.promise;
    f.setTime("2026-09-23T05:00:00Z");
    await f.scheduler.tick();
    assert.deepEqual(triggers, ["manual", "scheduled"]);
    manual.resolve();
    await immediate;
  } finally { manual.resolve(); await f.close(); }
});

test("configuration edit does not change an active batch snapshot", async () => {
  const entered = deferred();
  const gate = deferred();
  const calls = [];
  const f = await fixture({ runCrawler: async payload => { calls.push(payload); if (calls.length === 1) { entered.resolve(); await gate.promise; } return { runId: `run_${calls.length}`, quality: { status: "complete" } }; } });
  try {
    await f.prepare();
    const running = f.scheduler.runNow();
    await entered.promise;
    await f.scheduler.updateConfig({ keywords: ["경남글램핑"], collection: { bookingDays: 1 } });
    gate.resolve();
    await running;
    assert.deepEqual(calls.map(call => call.keyword), ["포천글램핑", "가평글램핑"]);
    assert.ok(calls.every(call => call.bookingRangeDays === 31));
  } finally { gate.resolve(); await f.close(); }
});

test("403, 429 and HTTP200 provider/captcha errors end remaining batch without exposing messages", async () => {
  for (const error of [Object.assign(new Error("password-secret"), { statusCode: 403 }), Object.assign(new Error("cookie-secret"), { statusCode: 429 }), new Error("HTTP200 BookingAPITooManyRequests cookie-secret"), new Error("CAPTCHA token-secret")]) {
    let calls = 0;
    const f = await fixture({ runCrawler: async () => { calls += 1; throw error; } });
    try {
      await f.prepare();
      const result = await f.scheduler.runNow();
      assert.equal(calls, 1);
      assert.equal(result.status, "blocked");
      assert.equal(result.items[1].status, "blocked");
      assert.ok(!JSON.stringify(await f.scheduler.status()).includes("secret"));
    } finally { await f.close(); }
  }
});

test("result verification distinguishes reuse, partial, failed and unknown result", async () => {
  let index = 0;
  const responses = [{ runId: "reused_run", reused: true, quality: { status: "complete" } }, { runId: "partial_run", quality: { status: "partial" } }, { runId: "failed_run", quality: { status: "failed" } }, { runId: "unknown_run" }];
  const f = await fixture({ runCrawler: async () => responses[index++] });
  try {
    await f.prepare({ keywords: ["a", "b", "c", "d"] });
    const result = await f.scheduler.runNow();
    assert.deepEqual(result.items.map(item => item.status), ["reused", "partial", "failed", "failed"]);
    assert.equal(result.status, "partial");
    assert.equal(result.items[3].errorCode, "RESULT_QUALITY_UNKNOWN");
  } finally { await f.close(); }
});

test("unknown worker infrastructure state interrupts remaining keywords without retry", async () => {
  let count = 0;
  const f = await fixture({ runCrawler: async () => { count += 1; throw Object.assign(new Error("connection detail"), { code: "COLLECTOR_WORKER_UNAVAILABLE" }); } });
  try { await f.prepare(); const result = await f.scheduler.runNow(); assert.equal(result.status, "interrupted"); assert.equal(result.items[1].status, "interrupted"); assert.equal(count, 1); }
  finally { await f.close(); }
});

test("collector provider block stays blocked in the schedule ledger rather than interrupted", async () => {
  let calls = 0;
  const f = await fixture({ runCrawler: async () => {
    calls += 1;
    throw Object.assign(new Error("safe provider protection"), { code: "COLLECTOR_PROVIDER_BLOCKED", statusCode: 409, cancelled: false });
  } });
  try {
    await f.prepare();
    const result = await f.scheduler.runNow();
    assert.equal(calls, 1);
    assert.equal(result.status, "blocked");
    assert.equal(result.errorCode, "PROVIDER_ACCESS_RESTRICTED");
    assert.ok(result.items.every(item => item.status === "blocked"));
  } finally { await f.close(); }
});

test("receipt with unknown fields is rejected without exposing or replacing its contents", async () => {
  const f = await fixture();
  let other;
  try {
    await f.prepare({ keywords: ["a"] });
    const result = await f.scheduler.runNow();
    const file = path.join(f.receiptDir, `${result.id}.json`);
    const tampered = JSON.stringify({ ...result, token: "never-render-this" });
    await fs.writeFile(file, tampered);
    other = createKeywordWorkerScheduler(f.options);
    const status = await other.status();
    assert.equal(status.config, null);
    assert.equal(status.lastError, "KEYWORD_SCHEDULE_STATE_INVALID");
    assert.ok(!JSON.stringify(status).includes("never-render-this"));
    await assert.rejects(() => other.runNow());
    assert.equal(await fs.readFile(file, "utf8"), tampered);
  } finally { other?.stop(); await f.close(); }
});

test("inspector result is authoritative and complete without runId is rejected", async () => {
  const f = await fixture({ runCrawler: async () => ({ quality: { status: "blocked" } }), inspectResult: async () => ({ status: "complete" }) });
  try { await f.prepare({ keywords: ["a"] }); const result = await f.scheduler.runNow(); assert.equal(result.status, "failed"); assert.equal(result.items[0].errorCode, "RESULT_RUN_ID_MISSING"); }
  finally { await f.close(); }
});

test("fixed dates require consistent inclusive range and cannot collect past dates", async () => {
  const f = await fixture();
  try {
    await f.prepare({ keywords: ["a"], collection: { dateMode: "fixed", checkIn: "2026-09-24", checkOut: "2026-09-26", bookingDays: 3 } });
    await f.scheduler.runNow();
    assert.equal(f.calls[0].checkIn, "2026-09-24");
    assert.equal(f.calls[0].checkOut, "2026-09-26");
    f.setTime("2026-09-25T00:00:00Z");
    await assert.rejects(() => f.scheduler.runNow(), { code: "KEYWORD_SCHEDULE_DATE_EXPIRED" });
    await assert.rejects(() => f.scheduler.setEnabled(true), { code: "KEYWORD_SCHEDULE_DATE_EXPIRED" });
    assert.equal(f.calls.length, 1);
  } finally { await f.close(); }
});

test("disabled schedules preview the next eligible execution without activating or submitting", async () => {
  const f = await fixture();
  try {
    await f.prepare({ repeat: "weekdays", firstDate: "2026-09-26" });
    const status = await f.scheduler.status();
    assert.equal(status.enabled, false);
    assert.equal(status.nextRunAt, null);
    assert.equal(status.previewNextRunAt, "2026-09-28T05:00:00.000Z");
    assert.equal(status.expired, false);
    assert.equal(status.expiryReason, null);
    assert.equal(f.calls.length, 0);
    assert.equal(status.latest.length, 0);
  } finally { await f.close(); }
});

test("expired fixed ranges report no next execution and do not create daily missed receipts", async () => {
  const f = await fixture();
  try {
    await f.prepare({ keywords: ["포천글램핑"], collection: { dateMode: "fixed", checkIn: "2026-09-23", checkOut: "2026-09-25", bookingDays: 3 } });
    await f.scheduler.setEnabled(true);
    f.setTime("2026-09-24T05:00:00Z");
    const first = await f.scheduler.status();
    assert.equal(first.enabled, true);
    assert.equal(first.expired, true);
    assert.equal(first.expiryReason, "KEYWORD_SCHEDULE_DATE_EXPIRED");
    assert.equal(first.nextRunAt, null);
    assert.equal(first.previewNextRunAt, null);
    assert.equal(await f.scheduler.tick(), null);
    f.setTime("2026-09-25T05:00:00Z");
    assert.equal(await f.scheduler.tick(), null);
    assert.equal(f.calls.length, 0);
    assert.equal((await f.scheduler.status()).latest.length, 0);
    await f.scheduler.updateConfig({ firstDate: "2026-09-26", collection: { dateMode: "fixed", checkIn: "2026-09-26", checkOut: "2026-09-28", bookingDays: 3 } });
    const restored = await f.scheduler.status();
    assert.equal(restored.expired, false);
    assert.equal(restored.expiryReason, null);
    assert.equal(restored.nextRunAt, "2026-09-26T05:00:00.000Z");
    assert.equal(restored.previewNextRunAt, restored.nextRunAt);
  } finally { await f.close(); }
});

test("first execution after the fixed arrival date is visibly expired and cannot be enabled", async () => {
  const f = await fixture();
  try {
    await f.prepare({ firstDate: "2026-09-25", collection: { dateMode: "fixed", checkIn: "2026-09-24", checkOut: "2026-09-25", bookingDays: 2 } });
    const status = await f.scheduler.status();
    assert.equal(status.expired, true);
    assert.equal(status.previewNextRunAt, null);
    await assert.rejects(() => f.scheduler.setEnabled(true), { code: "KEYWORD_SCHEDULE_DATE_EXPIRED" });
    assert.equal(f.calls.length, 0);
  } finally { await f.close(); }
});

test("fixed windows without a remaining weekday or time slot cannot be activated", async () => {
  const f = await fixture();
  try {
    await f.prepare({ repeat: "weekdays", firstDate: "2026-09-26", collection: { dateMode: "fixed", checkIn: "2026-09-27", checkOut: "2026-09-28", bookingDays: 2 } });
    assert.equal((await f.scheduler.status()).expired, true);
    await assert.rejects(() => f.scheduler.setEnabled(true), { code: "KEYWORD_SCHEDULE_DATE_EXPIRED" });
    await f.scheduler.updateConfig({ repeat: "daily", firstDate: "2026-09-23", collection: { dateMode: "fixed", checkIn: "2026-09-23", checkOut: "2026-09-24", bookingDays: 2 } });
    f.setTime("2026-09-23T05:06:00Z");
    const expired = await f.scheduler.status();
    assert.equal(expired.expired, true);
    assert.equal(expired.previewNextRunAt, null);
    await assert.rejects(() => f.scheduler.setEnabled(true), { code: "KEYWORD_SCHEDULE_DATE_EXPIRED" });
    assert.equal(f.calls.length, 0);
  } finally { await f.close(); }
});

test("past once schedule reports expiry and preserves only one missed receipt until conditions change", async () => {
  const f = await fixture();
  try {
    await f.prepare({ repeat: "once", firstDate: "2026-09-23" });
    await f.scheduler.setEnabled(true);
    f.setTime("2026-09-24T04:00:00Z");
    let status = await f.scheduler.status();
    assert.equal(status.expired, true);
    assert.equal(status.expiryReason, "KEYWORD_SCHEDULE_TIME_EXPIRED");
    assert.equal(status.previewNextRunAt, null);
    await assert.rejects(() => f.scheduler.setEnabled(true), { code: "KEYWORD_SCHEDULE_TIME_EXPIRED" });
    assert.equal((await f.scheduler.tick()).status, "missed");
    f.setTime("2026-09-24T05:00:00Z");
    await f.scheduler.tick();
    status = await f.scheduler.status();
    assert.equal(status.latest.length, 1);
    assert.equal(status.nextRunAt, null);
    await f.scheduler.updateConfig({ firstDate: "2026-09-25" });
    status = await f.scheduler.status();
    assert.equal(status.expired, false);
    assert.equal(status.expiryReason, null);
    assert.equal(status.nextRunAt, "2026-09-25T05:00:00.000Z");
    assert.equal(f.calls.length, 0);
  } finally { await f.close(); }
});

test("pausing withdraws pending scheduled occurrences only and leaves immediate work untouched", async () => {
  const gate = deferred();
  const started = [];
  const withdrawals = [];
  const f = await fixture({
    runCrawler: async payload => { started.push(payload); await gate.promise; return { runId: `run_${payload.trigger}`, quality: { status: "complete" } }; },
    cancelPendingScheduled: async request => { withdrawals.push(request); }
  });
  try {
    await f.prepare({ keywords: ["포천글램핑"] });
    await f.scheduler.setEnabled(true);
    const immediate = f.scheduler.runNow({ requestId: "pause-manual-001" });
    await waitFor(() => started.length === 1);
    f.setTime("2026-09-23T05:00:00Z");
    const scheduled = f.scheduler.tick();
    await waitFor(() => started.length === 2);
    await f.scheduler.setEnabled(false);
    assert.deepEqual(withdrawals, [{ occurrenceIds: ["scheduled_2026-09-23"], reason: "SCHEDULE_PAUSED" }]);
    assert.equal((await f.scheduler.status()).activeOccurrenceIds.length, 2);
    gate.resolve();
    const [manualResult, scheduledResult] = await Promise.all([immediate, scheduled]);
    assert.equal(manualResult.status, "complete");
    assert.equal(scheduledResult.status, "complete");
    assert.equal((await f.scheduler.status()).enabled, false);
  } finally { gate.resolve(); await f.close(); }
});

test("pausing an immediate-only batch does not call scheduled queue withdrawal", async () => {
  const gate = deferred();
  const entered = deferred();
  let withdrawals = 0;
  const f = await fixture({
    runCrawler: async () => { entered.resolve(); await gate.promise; return { runId: "manual_result", quality: { status: "complete" } }; },
    cancelPendingScheduled: async () => { withdrawals += 1; }
  });
  try {
    await f.prepare({ keywords: ["포천글램핑"] });
    const running = f.scheduler.runNow();
    await entered.promise;
    await f.scheduler.setEnabled(false);
    assert.equal(withdrawals, 0);
    gate.resolve();
    assert.equal((await running).status, "complete");
  } finally { gate.resolve(); await f.close(); }
});

test("exact disk protection threshold rejects collection", async () => {
  const f = await fixture({ getFreeBytes: async () => MIN_FREE_BYTES });
  try { await f.prepare(); const result = await f.scheduler.runNow(); assert.equal(result.status, "failed"); assert.equal(result.errorCode, "DISK_SPACE_UNAVAILABLE"); assert.equal(f.calls.length, 0); }
  finally { await f.close(); }
});

test("restart quarantines queued/running receipts and never automatically resubmits", async () => {
  const f = await fixture();
  let restarted;
  try {
    await f.prepare({ keywords: ["a"] });
    await f.scheduler.setEnabled(true);
    f.setTime("2026-09-23T05:00:00Z");
    const entry = await f.scheduler.tick();
    entry.status = "running"; entry.items[0].status = "queued"; entry.finishedAt = null;
    await fs.writeFile(path.join(f.receiptDir, `${entry.id}.json`), JSON.stringify(entry));
    f.scheduler.stop();
    restarted = createKeywordWorkerScheduler(f.options);
    const status = await restarted.status();
    assert.equal(status.latest[0].status, "interrupted");
    assert.equal(status.latest[0].errorCode, "RESTART_RESULT_UNKNOWN");
    await restarted.tick();
    assert.equal(f.calls.length, 1);
  } finally { restarted?.stop(); await f.close(); }
});

test("invalid persisted version blocks execution without replacing original state", async () => {
  const f = await fixture();
  try {
    await f.prepare();
    const invalid = JSON.stringify({ ...(await f.scheduler.status()).config, version: 999 });
    await fs.writeFile(f.configFile, invalid);
    await assert.rejects(() => f.scheduler.runNow());
    assert.equal(f.calls.length, 0);
    assert.equal((await f.scheduler.status()).config, null);
    assert.equal(await fs.readFile(f.configFile, "utf8"), invalid);
  } finally { await f.close(); }
});

test("exclusive schedule receipt prevents two initialized controllers dispatching same occurrence", async () => {
  const f = await fixture();
  let other;
  try {
    await f.prepare({ keywords: ["a"] });
    await f.scheduler.setEnabled(true);
    other = createKeywordWorkerScheduler(f.options);
    await other.status();
    f.setTime("2026-09-23T05:00:00Z");
    const outcomes = await Promise.allSettled([f.scheduler.tick(), other.tick()]);
    assert.equal(f.calls.length, 1, JSON.stringify(outcomes.map(outcome => ({ status: outcome.status, error: outcome.reason?.code }))));
  } finally { other?.stop(); await f.close(); }
});

test("timer lifecycle starts with no immediate run and stop clears the interval", async () => {
  let callback;
  let cleared = false;
  const f = await fixture({ setIntervalImpl: fn => { callback = fn; return { unref() {} }; }, clearIntervalImpl: () => { cleared = true; } });
  try {
    await f.prepare();
    await f.scheduler.start();
    assert.equal(typeof callback, "function");
    assert.equal(f.calls.length, 0);
    f.scheduler.stop();
    assert.equal(cleared, true);
    await assert.rejects(() => f.scheduler.runNow(), { code: "KEYWORD_SCHEDULE_STOPPED" });
  } finally { await f.close(); }
});

test("three worker schedules persist independently and dispatch the selected collector without changing disabled neighbors", async () => {
  const f = await fixture();
  const calls = [];
  const workers = Object.fromEntries(["web", "manual", "scheduled"].map(workerKey => [workerKey, createKeywordWorkerScheduler({
    ...f.options, workerKey, runCrawler: async payload => { calls.push(payload); return {runId:`run_${payload.workerKey}_${calls.length}`,quality:{status:"complete"}}; }
  })]));
  try {
    for (const [index, key] of Object.keys(workers).entries()) {
      const status = await workers[key].status();
      assert.equal(status.workerKey, key); assert.equal(status.enabled, false);
      assert.equal(status.config.collection.dayUseMode, "inspect");
      await workers[key].updateConfig({keywords:[`${key}글램핑`], collection:{bookingDays:index+1,collectionPurpose:index===0?"basic_db":"revenue_detail",dayUseMode:["inspect","lodging_only","detail"][index]}});
    }
    await workers.web.setEnabled(true);
    assert.equal((await workers.manual.status()).enabled,false);
    assert.equal((await workers.scheduled.status()).enabled,false);
    f.setTime("2026-09-23T05:00:00Z");
    await workers.web.tick(); await workers.manual.tick(); await workers.scheduled.tick();
    assert.equal(calls.length,1); assert.equal(calls[0].workerKey,"web"); assert.equal(calls[0].trigger,"scheduled");
    assert.equal(calls[0].collectionPurpose,"basic_db"); assert.equal(calls[0].dayUseMode,"inspect");
    assert.equal(calls[0].scheduleOccurrenceId,"web_scheduled_2026-09-23");
    for (const key of ["manual","scheduled"]) { await workers[key].setEnabled(true); await workers[key].tick(); }
    assert.deepEqual(calls.map(p=>p.workerKey),["web","manual","scheduled"]);
    assert.deepEqual(calls.map(p=>p.bookingRangeDays),[1,2,3]);
    assert.deepEqual(calls.map(p=>p.dayUseMode),["inspect","lodging_only","detail"]);
    assert.equal(new Set(calls.map(p=>p.clientRequestId)).size,3);
    assert.equal(new Set(calls.map(p=>p.scheduleOccurrenceId)).size,3);
    for (const key of Object.keys(workers)) {
      await workers[key].tick();
      const immediate = await workers[key].runNow({requestId:"same-browser-request-001"});
      assert.equal(immediate.workerKey,key);
      assert.equal(calls.at(-1).workerKey,key); assert.equal(calls.at(-1).trigger,"manual");
      const count=calls.length;
      await workers[key].runNow({requestId:"same-browser-request-001"}); assert.equal(calls.length,count);
      const filename=key==="scheduled"?"keyword-worker-schedule.json":`keyword-worker-schedule-${key}.json`;
      assert.deepEqual(JSON.parse(await fs.readFile(path.join(f.directory,"config",filename),"utf8")).keywords,[`${key}글램핑`]);
    }
    assert.equal(calls.length,6);
  } finally { Object.values(workers).forEach(worker=>worker.stop()); await f.close(); }
});

test("legacy day-use condition stays detail while new defaults inspect and invalid modes are rejected", async () => {
  const f = await fixture();
  try {
    const legacy=defaultConfig("2026-09-23T00:00:00Z");
    delete legacy.collection.dayUseMode;
    legacy.keywords=["경남글램핑"];
    await fs.mkdir(path.dirname(f.configFile),{recursive:true});
    const original=JSON.stringify(legacy);
    await fs.writeFile(f.configFile,original);
    assert.equal((await f.scheduler.status()).config.collection.dayUseMode,"detail");
    assert.equal(await fs.readFile(f.configFile,"utf8"),original);
    await f.scheduler.runNow(); assert.equal(f.calls[0].dayUseMode,"detail");
    await f.scheduler.runNow({collection:{dayUseMode:"inspect",collectionPurpose:"basic_db"}});
    assert.equal(f.calls[1].dayUseMode,"inspect"); assert.equal(f.calls[1].collectionPurpose,"basic_db");
    await assert.rejects(f.scheduler.updateConfig({collection:{dayUseMode:"anything"}}),{code:"KEYWORD_SCHEDULE_COLLECTION_INVALID"});
    assert.throws(()=>createKeywordWorkerScheduler({...f.options,workerKey:"unknown"}),{code:"KEYWORD_SCHEDULE_WORKER_INVALID"});
  } finally { await f.close(); }
});

test("web and manual pause callbacks identify only their own scheduled occurrence", async () => {
  for(const workerKey of ["web","manual"]) {
    const gate=deferred(),started=deferred(),withdrawals=[];
    const f=await fixture({workerKey,runCrawler:async()=>{started.resolve();await gate.promise;return{runId:"test_run",quality:{status:"complete"}};},cancelPendingScheduled:async event=>withdrawals.push(event)});
    try {
      await f.prepare({keywords:["경남글램핑"]}); await f.scheduler.setEnabled(true);
      f.setTime("2026-09-23T05:00:00Z"); const executing=f.scheduler.tick(); await started.promise;
      await f.scheduler.setEnabled(false);
      assert.deepEqual(withdrawals,[{occurrenceIds:[`${workerKey}_scheduled_2026-09-23`],reason:"SCHEDULE_PAUSED"}]);
      gate.resolve(); await executing;
    } finally {gate.resolve();await f.close();}
  }
});
