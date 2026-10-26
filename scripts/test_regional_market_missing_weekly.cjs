"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs/promises"), os = require("node:os"), path = require("node:path"), crypto = require("node:crypto");
const { createRegionalMarketMissingWeeklyScheduler, SCHEDULE, TICK_MS, MAX_BYTES, weekOf } = require("./lib/regional_market_missing_weekly.cjs");
const { createRegionalMarketMissingService } = require("./lib/regional_market_missing.cjs");
const MONDAY_NOON = "2026-10-26T03:00:00.000Z", JOB_ID = "12345678-1234-4234-8234-123456789abc", WEEK_MS = 7 * 86400000;
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
async function fixture(t, overrides = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "regional-weekly-")); t.after(async () => {
    const resolved = path.resolve(dataDir); assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(resolved).startsWith("regional-weekly-")); await fs.rm(resolved, { recursive: true, force: true });
  });
  let current = MONDAY_NOON, job = null, reads = 0, requests = 0, intervalCalls = 0, cleared = 0, intervalCallback;
  const preserved = path.join(dataDir, "collection-schedule-original.json"); await fs.writeFile(preserved, "frozen original schedule and protection");
  const originalHash = hash(await fs.readFile(preserved));
  const missingService = { get: async () => { reads++; return { job }; }, request: async () => {
    requests++; job = { id: JOB_ID, status: "complete", nextEligibleAt: new Date(Date.parse(current) + WEEK_MS).toISOString() }; return { job, reused: false };
  } };
  const options = { dataDir, missingService, now: () => current,
    setIntervalImpl: (callback, milliseconds) => { intervalCalls++; assert.equal(milliseconds, 30000); intervalCallback = callback; return { unref() {} }; },
    clearIntervalImpl: () => { cleared++; }, ...overrides };
  const scheduler = createRegionalMarketMissingWeeklyScheduler(options); t.after(() => scheduler.close());
  return { scheduler, dataDir, options, preserved, originalHash, directory: path.join(dataDir, "regional_market_missing"), file: path.join(dataDir, "regional_market_missing", "weekly-policy.json"),
    at: value => { current = value; }, job: value => { job = value; }, requests: () => requests, reads: () => reads, intervals: () => intervalCalls, cleared: () => cleared,
    interval: () => intervalCallback?.() };
}
test("constructor and disabled GET are write-free, do not inspect targets, and never request collection", async t => {
  const f = await fixture(t); assert.deepEqual(await fs.readdir(f.dataDir), ["collection-schedule-original.json"]);
  const status = await f.scheduler.get(); assert.equal(status.enabled, false); assert.equal(status.status, "disabled"); assert.deepEqual(status.schedule, SCHEDULE);
  assert.equal(f.requests(), 0); assert.equal(f.reads(), 0); assert.equal(f.intervals(), 0); assert.deepEqual(await fs.readdir(f.dataDir), ["collection-schedule-original.json"]);
});
test("start is a separate idempotent opt-in and disabled ticks create no files", async t => {
  const f = await fixture(t); f.scheduler.start(); f.scheduler.start(); assert.equal(f.intervals(), 1); await f.scheduler.tick(); f.interval(); await f.scheduler.tick();
  assert.equal(f.requests(), 0); assert.deepEqual(await fs.readdir(f.dataDir), ["collection-schedule-original.json"]); await f.scheduler.close(); assert.equal(f.cleared(), 1);
  assert.equal((await f.scheduler.tick()).status, "closed");
});
test("configure only saves a dedicated opt-in policy and GET remains read-only", async t => {
  const f = await fixture(t); await f.scheduler.configure({ enabled: true }); const before = await fs.readFile(f.file);
  assert.equal((await f.scheduler.get()).status, "due"); assert.deepEqual(await fs.readFile(f.file), before); assert.equal(f.requests(), 0);
  assert.equal(hash(await fs.readFile(f.preserved)), f.originalHash); assert.deepEqual(await fs.readdir(f.directory), ["weekly-policy.json"]);
});
test("Monday 12 KST is exact and pre-noon enable does not catch up an old week", async t => {
  const f = await fixture(t); f.at("2026-10-26T02:59:59.999Z"); const enabled = await f.scheduler.configure({ enabled: true });
  assert.equal(enabled.nextDueAt, MONDAY_NOON); assert.equal(enabled.status, "waiting"); assert.equal((await f.scheduler.tick()).triggered, false); assert.equal(f.requests(), 0);
  f.at(MONDAY_NOON); const due = await f.scheduler.tick(); assert.equal(due.triggered, true); assert.equal(f.requests(), 1);
  assert.equal(due.nextDueAt, "2026-11-02T03:00:00.000Z");
});
test("one due invocation per calendar week across concurrent ticks and process restart", async t => {
  const f = await fixture(t); await f.scheduler.configure({ enabled: true }); const runs = await Promise.all(Array.from({ length: 10 }, () => f.scheduler.tick()));
  assert.equal(runs.filter(value => value.triggered).length, 1); assert.equal(f.requests(), 1);
  const bytes = await fs.readFile(f.file), restarted = createRegionalMarketMissingWeeklyScheduler(f.options); t.after(() => restarted.close());
  assert.equal((await restarted.tick()).triggered, false); assert.equal(f.requests(), 1); assert.deepEqual(await fs.readFile(f.file), bytes);
});
test("server restart catches up only the current missing week and never replays skipped historical weeks", async t => {
  const f = await fixture(t); await f.scheduler.configure({ enabled: true }); f.at("2026-11-18T08:00:00.000Z");
  const restarted = createRegionalMarketMissingWeeklyScheduler(f.options); t.after(() => restarted.close()); const result = await restarted.tick();
  assert.equal(result.triggered, true); assert.equal(f.requests(), 1); assert.equal(result.lastAttemptWeek, "2026-11-16"); assert.equal(result.lastAttemptAt, "2026-11-18T08:00:00.000Z");
});
test("the coordinator's persisted seven-day eligibility wins over calendar Monday timing", async t => {
  const f = await fixture(t); await f.scheduler.configure({ enabled: true }); f.job({ id: JOB_ID, status: "partial", nextEligibleAt: "2026-10-26T04:30:00.000Z" });
  const early = await f.scheduler.tick(); assert.equal(early.triggered, false); assert.equal(early.nextDueAt, "2026-10-26T04:30:00.000Z"); assert.equal(f.requests(), 0);
  f.at("2026-10-26T04:30:00.000Z"); assert.equal((await f.scheduler.tick()).triggered, true); assert.equal(f.requests(), 1);
  f.at("2026-11-02T03:00:00.000Z"); assert.equal((await f.scheduler.tick()).triggered, false); f.at("2026-11-02T04:30:00.000Z"); assert.equal((await f.scheduler.tick()).triggered, true); assert.equal(f.requests(), 2);
});
for (const status of ["queued", "running", "needs_verification"]) test(`existing ${status} jobs are held without recovery, lock manipulation, or a new request`, async t => {
  const f = await fixture(t); await f.scheduler.configure({ enabled: true }); f.job({ id: JOB_ID, status, nextEligibleAt: "2026-10-19T03:00:00.000Z" }); const bytes = await fs.readFile(f.file);
  const result = await f.scheduler.tick(); assert.equal(result.status, "held"); assert.equal(result.triggered, false); assert.equal(f.requests(), 0); assert.deepEqual(await fs.readFile(f.file), bytes);
});
test("an interrupted dispatch claim is a durable verification hold even after another week", async t => {
  const f = await fixture(t); await f.scheduler.configure({ enabled: true }); const policy = JSON.parse(await fs.readFile(f.file));
  Object.assign(policy, { lastAttemptWeek: "2026-10-26", lastAttemptAt: MONDAY_NOON, dispatchStatus: "claimed" }); await fs.writeFile(f.file, JSON.stringify(policy)); const bytes = await fs.readFile(f.file);
  f.at("2026-11-09T03:00:00.000Z"); const status = await f.scheduler.tick(); assert.equal(status.status, "needs_verification"); assert.equal(status.reasonCode, "WEEKLY_DISPATCH_INTERRUPTED");
  assert.equal(f.requests(), 0); assert.deepEqual(await fs.readFile(f.file), bytes);
});
test("failed admission is recorded with safe text and no automatic same-week retry", async t => {
  let calls = 0; const f = await fixture(t, { missingService: { get: async () => ({ job: null }), request: async () => { calls++; throw new Error("private API key and contact message"); } } });
  await f.scheduler.configure({ enabled: true }); const result = await f.scheduler.tick(); assert.equal(result.reasonCode, "WEEKLY_REQUEST_FAILED"); assert.equal(calls, 1);
  f.at("2026-10-31T10:00:00.000Z"); assert.equal((await f.scheduler.tick()).triggered, false); assert.equal(calls, 1);
  assert.equal((await fs.readFile(f.file, "utf8")).includes("private"), false); f.at("2026-11-02T03:00:00.000Z"); await f.scheduler.tick(); assert.equal(calls, 2);
});
test("reused admission consumes only this calendar week's check and is not reported as new collection", async t => {
  let calls = 0; const f = await fixture(t, { missingService: { get: async () => ({ job: null }), request: async () => { calls++; return { reused: true, job: { id: JOB_ID, status: "complete", nextEligibleAt: MONDAY_NOON } }; } } });
  await f.scheduler.configure({ enabled: true }); const result = await f.scheduler.tick(); assert.equal(result.triggered, false); assert.equal(result.reused, true); assert.equal(result.dispatchStatus, "reused");
  await f.scheduler.tick(); assert.equal(calls, 1);
});
test("unknown, missing, failed or malformed job reads never mean absence and cannot trigger collection", async t => {
  for (const response of [undefined, {}, { job: {} }, { job: { id: JOB_ID, status: "complete", nextEligibleAt: "unknown" } }]) {
    let calls = 0; const f = await fixture(t, { missingService: { get: async () => response, request: async () => { calls++; assert.fail("unknown read must not collect"); } } });
    await f.scheduler.configure({ enabled: true }); assert.equal((await f.scheduler.tick()).status, "needs_verification"); assert.equal(calls, 0);
  }
});
test("disabling and enabling does not clear the current week's completed or failed claim", async t => {
  const f = await fixture(t); await f.scheduler.configure({ enabled: true }); await f.scheduler.tick(); await f.scheduler.configure({ enabled: false });
  assert.equal((await f.scheduler.tick()).status, "disabled"); await f.scheduler.configure({ enabled: true }); await f.scheduler.tick(); assert.equal(f.requests(), 1);
});
test("forcing, alternate schedules and extra collection flags are rejected", async t => {
  const f = await fixture(t);
  for (const value of [undefined, null, {}, { enabled: "true" }, { enabled: true, force: true }, { enabled: true, hour: 1 }, { enabled: true, collectMissing: true }]) await assert.rejects(f.scheduler.configure(value), { code: "REGIONAL_MARKET_WEEKLY_INVALID_POLICY" });
  assert.equal(f.requests(), 0); assert.deepEqual(await fs.readdir(f.dataDir), ["collection-schedule-original.json"]);
});
test("malformed and oversized policy files fail closed without collection or rewritten evidence", async t => {
  const f = await fixture(t); await fs.mkdir(f.directory);
  for (const bytes of ["not JSON", JSON.stringify({ schemaVersion: 1, enabled: true }), "x".repeat(MAX_BYTES + 1)]) {
    await fs.writeFile(f.file, bytes); await assert.rejects(f.scheduler.get(), { code: "REGIONAL_MARKET_WEEKLY_POLICY_INVALID" }); await assert.rejects(f.scheduler.tick(), { code: "REGIONAL_MARKET_WEEKLY_POLICY_INVALID" }); assert.equal(f.requests(), 0); assert.equal(await fs.readFile(f.file, "utf8"), bytes);
  }
});
test("policy GET and writes stay consistent while an enabled scheduler saves claims", async t => {
  const f = await fixture(t); await f.scheduler.configure({ enabled: true });
  const results = await Promise.all([f.scheduler.tick(), ...Array.from({ length: 30 }, () => f.scheduler.get())]);
  assert.equal(f.requests(), 1); for (const result of results) assert.equal(result.enabled, true); assert.equal(hash(await fs.readFile(f.preserved)), f.originalHash);
});
test("policy paths reject symlinks and never touch their external targets", async t => {
  if (process.platform === "win32") { t.skip("Linux release check covers symlink safety without Windows privilege dependence"); return; }
  const f = await fixture(t), outside = await fs.mkdtemp(path.join(os.tmpdir(), "regional-weekly-outside-")); t.after(async () => {
    const resolved = path.resolve(outside); assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(resolved).startsWith("regional-weekly-outside-")); await fs.rm(resolved, { recursive: true, force: true });
  });
  await fs.symlink(outside, f.directory); await assert.rejects(f.scheduler.get(), { code: "REGIONAL_MARKET_WEEKLY_UNSAFE_PATH" }); await assert.rejects(f.scheduler.configure({ enabled: true }), { code: "REGIONAL_MARKET_WEEKLY_UNSAFE_PATH" }); assert.deepEqual(await fs.readdir(outside), []);
  await fs.unlink(f.directory); await fs.mkdir(f.directory); const sentinel = path.join(outside, "sentinel.json"); await fs.writeFile(sentinel, "preserved"); await fs.symlink(sentinel, f.file);
  await assert.rejects(f.scheduler.get(), { code: "REGIONAL_MARKET_WEEKLY_POLICY_INVALID" }); await assert.rejects(f.scheduler.configure({ enabled: true }), { code: "REGIONAL_MARKET_WEEKLY_POLICY_INVALID" }); assert.equal(await fs.readFile(sentinel, "utf8"), "preserved"); assert.equal(f.requests(), 0);
});
test("KST calendar week boundaries are stable at Sunday midnight and Monday noon", () => {
  assert.equal(weekOf(Date.parse("2026-10-25T14:59:59.999Z")), "2026-10-19"); assert.equal(weekOf(Date.parse("2026-10-25T15:00:00.000Z")), "2026-10-26"); assert.equal(weekOf(Date.parse(MONDAY_NOON)), "2026-10-26"); assert.equal(TICK_MS, 30000);
});
test("native weekly policy and the real coordinator share one durable job and preserve the original schedule", async t => {
  const f = await fixture(t); await f.scheduler.close(); let calls = 0;
  const missingService = createRegionalMarketMissingService({ dataDir: f.dataDir, readTargets: async () => ["fixture_region", "fixture_region"],
    resolveRegion: async regionKey => ({ regionKey, officialCode: "48860", active: true, selectable: true, level: "local", unitType: "county" }), now: f.options.now,
    kosisService: { refreshMissingMarketRegion: async () => { calls++; return { marketCollection: { schemaVersion: 1, mode: "missing_only", status: "not_needed", changed: false, networkAttempted: false,
      attemptedDatasetKeys: [], collectedDatasetKeys: [], eligibleDatasetKeys: [], skipped: [], remaining: [], stopReason: null } }; } } });
  t.after(() => missingService.close()); const scheduler = createRegionalMarketMissingWeeklyScheduler({ ...f.options, missingService }); t.after(() => scheduler.close());
  await scheduler.configure({ enabled: true }); assert.equal((await scheduler.tick()).triggered, true); await missingService.idle();
  const first = (await missingService.get()).job; assert.equal(first.status, "complete"); assert.equal(calls, 1); assert.equal((await scheduler.get()).status, "waiting");
  await scheduler.tick(); assert.equal((await missingService.get()).job.id, first.id); assert.equal(calls, 1);
  f.at("2026-11-02T03:00:00.000Z"); assert.equal((await scheduler.tick()).triggered, true); await missingService.idle();
  assert.notEqual((await missingService.get()).job.id, first.id); assert.equal(calls, 2); assert.equal(hash(await fs.readFile(f.preserved)), f.originalHash);
  assert.deepEqual((await fs.readdir(f.directory)).sort(), ["latest-job.json", "weekly-policy.json"]);
});
