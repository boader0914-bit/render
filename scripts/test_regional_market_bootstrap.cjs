"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs/promises"), os = require("node:os"), path = require("node:path"), crypto = require("node:crypto");
const { createRegionalMarketBootstrapService, normalizeBaseline } = require("./lib/regional_market_bootstrap.cjs");
const KEYS = ["population", "households", "establishments", "employment", "manufacturing_establishments", "manufacturing_employment"], HELD = KEYS.slice(2), HELD_REGION = "original_partial";
const SOURCE_JOB = "bd14458a-0e4c-44ea-a665-b00df766f239", NOW = "2026-10-26T04:00:00.000Z", TOMORROW = "2026-10-27T03:10:00.000Z";
const hash = value => crypto.createHash("sha256").update(value).digest("hex"), tick = () => new Promise(resolve => setImmediate(resolve));
function sourceBytes(change) {
  const job = { id: SOURCE_JOB, status: "blocked", stopReason: "QUOTA_EXCEEDED", inventory: { eligibleRegionCount: 95, uniqueRegionCount: 95, unknownRegionCount: 0, excludedCount: 0 }, regions: [
    ...Array.from({ length: 8 }, (_, index) => ({ regionKey: `complete_${index}`, status: "complete", summary: { remaining: [] }, projected: true })),
    { regionKey: HELD_REGION, status: "blocked", summary: { stopReason: "QUOTA_EXCEEDED", collectedDatasetKeys: KEYS.slice(0, 2), remaining: HELD.map(datasetKey => ({ datasetKey, status: "blocked", reasonCode: "QUOTA_EXCEEDED" })) }, projected: false },
    ...Array.from({ length: 86 }, (_, index) => ({ regionKey: `pending_${String(index).padStart(2, "0")}`, status: "not_checked", summary: null, projected: false })) ] };
  change?.(job); return Buffer.from(JSON.stringify({ schemaVersion: 1, job }));
}
async function fixture(t, overrides = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "market-bootstrap-")); t.after(async () => {
    const resolved = path.resolve(dataDir); assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(resolved).startsWith("market-bootstrap-")); await fs.rm(resolved, { recursive: true, force: true });
  });
  let current = NOW, usedDay = "", used = 0, externalUse = 0, timerCount = 0, cleared = 0, reviewConsumed = false;
  const raw = sourceBytes(), expected = { jobId: SOURCE_JOB, sha256: hash(raw) }, frozen = path.join(dataDir, "original-weekly-job.json"), lock = path.join(dataDir, "original-weekly.lock");
  await fs.writeFile(frozen, raw); await fs.writeFile(lock, "preserved original weekly lock"); const frozenHash = hash(await fs.readFile(frozen)), lockHash = hash(await fs.readFile(lock));
  const available = new Map([[HELD_REGION, new Set(KEYS.slice(0, 2))]]), calls = [], network = [], projections = [];
  const review = { schemaVersion: 1, baselineJobId: SOURCE_JOB, baselineSha256: expected.sha256, regionKey: HELD_REGION, datasetKeys: [...HELD], status: "reviewed", reviewReceiptSha256: "c".repeat(64),
    budgetResumeReview: { schemaVersion: 1, kind: "diagnosed_local_budget", regionKey: HELD_REGION, attemptSha256: "a".repeat(64), cacheSha256: "b".repeat(64), datasetKeys: [...HELD], earliestKstDay: "2026-10-27", sourceJobId: SOURCE_JOB, sourceJobSha256: expected.sha256, reviewReceiptSha256: "c".repeat(64) } };
  const provider = async (regionKey, options) => {
    const day = new Date(Date.parse(current) + 9 * 3600000).toISOString().slice(0, 10); if (day !== usedDay) { usedDay = day; used = externalUse; }
    calls.push({ regionKey, options: structuredClone(options), day });
    const values = available.get(regionKey) || new Set(); available.set(regionKey, values);
    const eligible = options.allowedDatasetKeys.filter(key => !values.has(key)), attempted = [], collected = [];
    let local = false, applied = false;
    if (options.budgetResumeReview) { assert.equal(reviewConsumed, false); assert.deepEqual(options.budgetResumeReview, review.budgetResumeReview); reviewConsumed = true; applied = true; }
    for (const datasetKey of eligible) {
      if (used >= 100) { local = true; break; } used++; network.push({ day, regionKey, datasetKey, kind: "metadata" }); attempted.push(datasetKey);
      if (used >= 100) { local = true; break; } used++; network.push({ day, regionKey, datasetKey, kind: "data" }); values.add(datasetKey); collected.push(datasetKey);
    }
    const remaining = KEYS.filter(key => !values.has(key)).map(datasetKey => ({ datasetKey, status: local ? "blocked" : "missing", reasonCode: local ? "QUOTA_EXCEEDED" : "NOT_COLLECTED" }));
    return { datasets: [{ privatePayload: "NEVER_PERSIST_PROVIDER_PAYLOAD" }], marketCollection: { schemaVersion: 1, mode: "missing_only", status: local ? "blocked" : remaining.length ? "partial" : eligible.length ? "complete" : "not_needed",
      eligibleDatasetKeys: eligible, attemptedDatasetKeys: attempted, collectedDatasetKeys: collected, skipped: KEYS.filter(key => values.has(key) && !collected.includes(key)).map(datasetKey => ({ datasetKey, status: "available", reasonCode: "" })),
      remaining, changed: collected.length > 0, networkAttempted: attempted.length > 0, stopReason: local ? "QUOTA_EXCEEDED" : null,
      localBudgetExhausted: local, budgetDay: local ? day : null, budgetResumeReviewApplied: applied } };
  };
  const options = { dataDir, readBaseline: async () => ({ schemaVersion: 1, bytes: await fs.readFile(frozen) }), expectedBaseline: expected,
    resolveRegion: async regionKey => ({ regionKey, officialCode: "4886000000", level: "local", active: true, selectable: true, unitType: "county" }),
    kosisService: { refreshMissingMarketRegion: provider }, onRegionChanged: async (regionKey, summary) => { projections.push({ regionKey, summary }); return { verified: true }; },
    readHeldReview: async () => structuredClone(review), canRun: async () => ({ allowed: true, reasonCode: null }), now: () => current,
    setIntervalImpl: (_, milliseconds) => { assert.equal(milliseconds, 30000); timerCount++; return { unref() {} }; }, clearIntervalImpl: () => { cleared++; }, ...overrides };
  const service = createRegionalMarketBootstrapService(options); t.after(() => service.close());
  return { service, options, dataDir, frozen, lock, frozenHash, lockHash, calls, network, projections, available, review, raw, expected,
    directory: path.join(dataDir, "regional_market_bootstrap"), stateFile: path.join(dataDir, "regional_market_bootstrap", "state.json"), baselineFile: path.join(dataDir, "regional_market_bootstrap", "baseline.json"),
    at: value => { current = value; }, reserve: count => { externalUse = count; }, used: () => used, timers: () => timerCount, cleared: () => cleared };
}
async function execute(f) { const result = await f.service.tick(); await f.service.idle(); return { result, status: await f.service.get() }; }
test("constructor, GET and disabled tick do not create files, read originals or call providers", async t => {
  const f = await fixture(t, { readBaseline: async () => assert.fail("not a GET side effect"), readHeldReview: async () => assert.fail("not a GET side effect") });
  assert.equal((await f.service.get()).phase, "unconfigured"); await f.service.tick(); f.service.start(); f.service.start(); await f.service.idle();
  assert.deepEqual((await fs.readdir(f.dataDir)).sort(), ["original-weekly-job.json", "original-weekly.lock"]); assert.equal(f.calls.length, 0); assert.equal(f.timers(), 1);
});
test("explicit enable freezes 86 pending regions and four separate reviewed tables, with tomorrow 12:10 as first due", async t => {
  const f = await fixture(t), status = await f.service.configure({ enabled: true }); assert.equal(status.nextDueAt, TOMORROW); assert.equal(status.progress.initialRegionCount, 86); assert.equal(status.progress.initialHeldDatasetCount, 4);
  assert.equal(f.calls.length, 0); await f.service.tick(); f.at("2026-10-27T03:09:59.999Z"); assert.equal((await f.service.tick()).triggered, false);
  assert.equal(hash(await fs.readFile(f.frozen)), f.frozenHash); assert.equal(hash(await fs.readFile(f.lock)), f.lockHash);
  const baseline = JSON.parse(await fs.readFile(f.baselineFile)); assert.equal(baseline.totalRegionCount, 95); assert.equal(baseline.pendingRegionKeys.length, 86);
});
test("daily fill uses the shared 100-request budget and never dispatches the original good two tables", async t => {
  const f = await fixture(t); await f.service.configure({ enabled: true }); f.at(TOMORROW); const { status } = await execute(f);
  assert.equal(status.phase, "active"); assert.equal(status.job.status, "partial"); assert.equal(status.job.stopReason, "BOOTSTRAP_LOCAL_BUDGET_EXHAUSTED"); assert.equal(f.network.length, 100);
  assert.equal(status.progress.initialHeldAvailableDatasets, 4); assert.equal(status.progress.initialHeldProjectionVerified, true);
  assert.deepEqual(f.network.filter(x => x.regionKey === HELD_REGION).map(x => x.datasetKey), HELD.flatMap(key => [key, key]));
  assert.equal(f.calls.filter(x => x.options.budgetResumeReview).length, 1); assert.equal(f.used(), 100);
  assert.equal(hash(await fs.readFile(f.frozen)), f.frozenHash); assert.equal(hash(await fs.readFile(f.lock)), f.lockHash);
});
test("once-per-KST-day claim is durable and concurrent ticks or restarts cannot spend a second budget", async t => {
  const f = await fixture(t); await f.service.configure({ enabled: true }); f.at(TOMORROW);
  const results = await Promise.all(Array.from({ length: 8 }, () => f.service.tick())); await f.service.idle(); assert.equal(results.filter(x => x.triggered).length, 1); const count = f.network.length;
  const claim = path.join(f.directory, "days", "2026-10-27.claim.json"), result = path.join(f.directory, "days", "2026-10-27.result.json"), before = hash(await fs.readFile(claim));
  const restart = createRegionalMarketBootstrapService(f.options); t.after(() => restart.close()); await restart.tick(); assert.equal(f.network.length, count); assert.equal(hash(await fs.readFile(claim)), before); assert.ok(await fs.stat(result));
  if (process.platform !== "win32") assert.equal((await fs.stat(claim)).mode & 0o222, 0);
});
test("completion requires all 86 regions and the initial four reviewed tables, then disables only bootstrap", async t => {
  const f = await fixture(t); await f.service.configure({ enabled: true }); let status;
  for (let offset = 0; offset < 15; offset++) {
    f.at(new Date(Date.parse(TOMORROW) + offset * 86400000).toISOString()); ({ status } = await execute(f));
    if (status.phase === "complete") break; assert.equal(status.phase, "active");
  }
  assert.equal(status.phase, "complete"); assert.equal(status.enabled, false); assert.equal(status.progress.availableRegions, 86); assert.equal(status.progress.initialHeldAvailableDatasets, 4); assert.equal(status.progress.initialHeldProjectionVerified, true);
  const byDay = new Map(); for (const call of f.network) byDay.set(call.day, (byDay.get(call.day) || 0) + 1); assert.ok([...byDay.values()].every(count => count <= 100)); assert.equal(f.network.length, 1040);
  const count = f.calls.length; f.at("2026-12-01T03:10:00.000Z"); await f.service.tick(); assert.equal(f.calls.length, count); await assert.rejects(f.service.configure({ enabled: true }), { code: "BOOTSTRAP_OPERATOR_REVIEW_REQUIRED" });
  assert.equal(hash(await fs.readFile(f.frozen)), f.frozenHash); assert.equal(hash(await fs.readFile(f.lock)), f.lockHash);
});
test("a review is durably consumed even when another operator already exhausted today's shared budget", async t => {
  const f = await fixture(t); f.reserve(100); await f.service.configure({ enabled: true }); f.at(TOMORROW); let { status } = await execute(f);
  assert.equal(f.network.length, 0); assert.equal(status.job.status, "partial"); assert.equal(JSON.parse(await fs.readFile(f.stateFile)).heldReview.consumed, true);
  f.reserve(0); f.at("2026-10-28T03:10:00.000Z"); ({ status } = await execute(f)); assert.equal(status.phase, "active");
  assert.equal(f.calls.filter(x => x.options.budgetResumeReview).length, 1); assert.equal(f.calls[1].options.budgetResumeReview, undefined); assert.equal(status.progress.initialHeldAvailableDatasets, 4);
});
test("same-day typed local marker can defer with no global stop code and zero provider calls", async t => {
  const f = await fixture(t, { kosisService: { refreshMissingMarketRegion: async () => ({ marketCollection: { schemaVersion: 1, mode: "missing_only", status: "blocked", attemptedDatasetKeys: [], collectedDatasetKeys: [], eligibleDatasetKeys: [], skipped: HELD.map(datasetKey => ({ datasetKey, status: "blocked", reasonCode: "QUOTA_EXCEEDED" })), remaining: HELD.map(datasetKey => ({ datasetKey, status: "blocked", reasonCode: "QUOTA_EXCEEDED" })), changed: false, networkAttempted: false, stopReason: null, localBudgetExhausted: true, budgetDay: "2026-10-27", budgetResumeReviewApplied: false } }) } });
  await f.service.configure({ enabled: true }); f.at(TOMORROW); const { status } = await execute(f); assert.equal(status.job.status, "partial"); assert.equal(status.phase, "active"); assert.equal(status.progress.initialHeldAvailableDatasets, 0);
});
for (const reason of ["AUTH_ERROR", "QUOTA_EXCEEDED", "TIMEOUT", "NETWORK_ERROR"]) test(`remote ${reason} without a typed local-budget marker stops for verification`, async t => {
  const f = await fixture(t, { kosisService: { refreshMissingMarketRegion: async () => ({ marketCollection: { schemaVersion: 1, mode: "missing_only", status: "blocked", eligibleDatasetKeys: [...HELD], attemptedDatasetKeys: [HELD[0]], collectedDatasetKeys: [], skipped: [], remaining: HELD.map(datasetKey => ({ datasetKey, status: "blocked", reasonCode: reason })), changed: false, networkAttempted: true, stopReason: reason, localBudgetExhausted: false, budgetDay: null, budgetResumeReviewApplied: true } }) } });
  await f.service.configure({ enabled: true }); f.at(TOMORROW); const { status } = await execute(f); assert.equal(status.phase, "needs_verification"); assert.equal(status.enabled, false); assert.notEqual(status.job.status, "complete");
  f.at("2026-10-28T03:10:00.000Z"); assert.equal((await f.service.tick()).triggered, false);
});
test("unknown/active weekly or protection gates perform zero dispatches and no daily claim writes", async t => {
  for (const canRun of [async () => ({ allowed: false, reasonCode: "WEEKLY_JOB_IN_PROGRESS" }), async () => ({ allowed: false, reasonCode: "ACTIVE_PROTECTION" }), async () => { throw new Error("private ledger"); }]) {
    const f = await fixture(t, { canRun }); await f.service.configure({ enabled: true }); const before = await fs.readFile(f.stateFile); f.at(TOMORROW); const result = await f.service.tick();
    assert.equal(result.triggered, false); assert.equal(f.calls.length, 0); assert.deepEqual(await fs.readFile(f.stateFile), before); await assert.rejects(fs.access(path.join(f.directory, "days")), { code: "ENOENT" });
  }
});
test("orphan lock and orphan claim are visible verification holds without deletion or replay", async t => {
  for (const artifact of ["execution.lock", "days/2026-10-27.claim.json"]) {
    const f = await fixture(t); await f.service.configure({ enabled: true }); f.at(TOMORROW); const file = path.join(f.directory, ...artifact.split("/")); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, '{"preserve":"orphan"}');
    const before = await fs.readFile(file), status = await f.service.get(); assert.equal(status.phase, "needs_verification"); assert.equal(status.enabled, false);
    assert.equal((await f.service.tick()).triggered, false); assert.equal(f.calls.length, 0); assert.deepEqual(await fs.readFile(file), before); await assert.rejects(f.service.configure({ enabled: true }), { code: "BOOTSTRAP_OPERATOR_REVIEW_REQUIRED" });
  }
});
test("a recovered running daily job does not become a real zero or replay, even on a later day", async t => {
  const f = await fixture(t); await f.service.configure({ enabled: true });
  const state = JSON.parse(await fs.readFile(f.stateFile)); state.latestJob = { schemaVersion: 1, id: "12345678-1234-4234-8234-123456789abc", day: "2026-10-27", status: "running", claimedAt: TOMORROW, startedAt: TOMORROW, finishedAt: null, currentRegionKey: HELD_REGION, counts: { checkedRegions: 0, networkAttemptedRegions: 0, unknownAttemptRegions: 1, collectedDatasets: 0, projectedRegions: 0 }, stopReason: null };
  await fs.writeFile(f.stateFile, JSON.stringify(state)); f.at("2026-10-28T03:10:00.000Z"); const status = await f.service.get(); assert.equal(status.phase, "needs_verification"); assert.equal(status.job.counts.unknownAttemptRegions, 1); assert.equal((await f.service.tick()).triggered, false); assert.equal(f.calls.length, 0);
});
test("lost provider acknowledgement preserves unknown execution and never completes the initial four", async t => {
  const f = await fixture(t, { kosisService: { refreshMissingMarketRegion: async () => { throw new Error("private upstream credentials"); } } });
  await f.service.configure({ enabled: true }); f.at(TOMORROW); const { status } = await execute(f); assert.equal(status.phase, "needs_verification"); assert.equal(status.job.counts.unknownAttemptRegions, 1); assert.equal(status.progress.initialHeldAvailableDatasets, 0); assert.equal(JSON.stringify(status).includes("private"), false);
});
test("shared in-flight work is not attributed as four available tables", async t => {
  const f = await fixture(t, { kosisService: { refreshMissingMarketRegion: async () => ({ marketCollection: { schemaVersion: 1, mode: "missing_only", status: "shared_inflight", eligibleDatasetKeys: [], attemptedDatasetKeys: [], collectedDatasetKeys: [], skipped: [], remaining: [], changed: false, networkAttempted: false, stopReason: null, localBudgetExhausted: false, budgetDay: null, budgetResumeReviewApplied: false } }) } });
  await f.service.configure({ enabled: true }); f.at(TOMORROW); const { status } = await execute(f); assert.equal(status.phase, "needs_verification"); assert.equal(status.progress.initialHeldAvailableDatasets, 0); assert.equal(status.progress.initialHeldOutstandingDatasets, 4);
});
test("an unverified cached projection prevents completion even after successful table storage", async t => {
  const f = await fixture(t, { onRegionChanged: async () => undefined }); await f.service.configure({ enabled: true }); f.at(TOMORROW); const { status } = await execute(f);
  assert.equal(status.phase, "needs_verification"); assert.equal(status.progress.initialHeldProjectionVerified, false); assert.equal(status.progress.availableRegions, 0); assert.equal(status.progress.initialHeldAvailableDatasets, 4);
});
test("a same-day marker with the wrong day cannot convert quota into a harmless daily defer", async t => {
  const f = await fixture(t, { kosisService: { refreshMissingMarketRegion: async () => ({ marketCollection: { schemaVersion: 1, mode: "missing_only", status: "blocked", eligibleDatasetKeys: [...HELD], attemptedDatasetKeys: [], collectedDatasetKeys: [], skipped: [], remaining: HELD.map(datasetKey => ({ datasetKey, status: "blocked", reasonCode: "QUOTA_EXCEEDED" })), changed: false, networkAttempted: false, stopReason: "QUOTA_EXCEEDED", localBudgetExhausted: true, budgetDay: "2026-10-26", budgetResumeReviewApplied: false } }) } });
  await f.service.configure({ enabled: true }); f.at(TOMORROW); const { status } = await execute(f); assert.equal(status.phase, "needs_verification"); assert.equal(status.job.stopReason, "BOOTSTRAP_COLLECTION_CONTRACT_INVALID");
});
test("baseline and reviewed held allowlists cannot expand to other jobs, regions or known-good tables", async t => {
  for (const change of [job => { job.id = "12345678-1234-4234-8234-123456789abc"; }, job => { job.regions.pop(); }, job => { job.regions[8].summary.remaining[0].datasetKey = "population"; }]) {
    const raw = sourceBytes(change); assert.throws(() => normalizeBaseline(raw, { jobId: SOURCE_JOB, sha256: hash(raw) }, NOW), { code: "BOOTSTRAP_BASELINE_INVALID" });
  }
  const f = await fixture(t); f.review.datasetKeys[0] = "population"; await assert.rejects(f.service.configure({ enabled: true }), { code: "BOOTSTRAP_HELD_REVIEW_UNVERIFIED" }); assert.equal(f.calls.length, 0);
});
test("unknown force/scope/clock changes are rejected and no provider data or PII is persisted", async t => {
  const f = await fixture(t); for (const input of [null, {}, { enabled: "true" }, { enabled: true, force: true }, { enabled: true, regionKey: "other" }, { enabled: true, hour: 0 }]) await assert.rejects(f.service.configure(input), { code: "BOOTSTRAP_INVALID_POLICY" });
  await f.service.configure({ enabled: true }); f.at(TOMORROW); await execute(f); assert.equal((await fs.readFile(f.stateFile, "utf8")).includes("NEVER_PERSIST_PROVIDER_PAYLOAD"), false);
});
test("GET remains valid across this instance's claim and repeated atomic progress writes", async t => {
  const f = await fixture(t); await f.service.configure({ enabled: true }); f.at(TOMORROW);
  const reads = Promise.all(Array.from({ length: 5 }, async () => { const rows = []; for (let i = 0; i < 30; i++) rows.push(await f.service.get()); return rows; }));
  await f.service.tick(); const results = (await reads).flat(); await f.service.idle(); assert.ok(results.every(x => x.phase !== "needs_verification"));
});

test("policy toggles during a deferred provider call cannot overwrite the running job or progress", async t => {
  let entered, finish;
  const entering = new Promise(resolve => { entered = resolve; }), deferred = new Promise(resolve => { finish = resolve; });
  const f = await fixture(t), provider = f.options.kosisService.refreshMissingMarketRegion;
  f.options.kosisService.refreshMissingMarketRegion = async (...args) => { entered(); await deferred; return provider(...args); };
  await f.service.configure({ enabled: true }); f.at(TOMORROW); await f.service.tick(); await entering;
  const before = await fs.readFile(f.stateFile), running = await f.service.get();
  try {
    for (const enabled of [false, true]) await assert.rejects(f.service.configure({ enabled }), { code: "BOOTSTRAP_BUSY", statusCode: 409 });
    assert.deepEqual(await fs.readFile(f.stateFile), before); assert.equal(f.network.length, 0); assert.equal(running.job.counts.unknownAttemptRegions, 1);
  } finally { finish(); }
  await f.service.idle(); const status = await f.service.get();
  assert.equal(status.phase, "active"); assert.equal(status.enabled, true); assert.equal(status.job.id, running.job.id); assert.equal(status.job.status, "partial"); assert.equal(f.network.length, 100);
});
test("symlinks and malformed private state fail closed without changing external or original files", async t => {
  if (process.platform === "win32") { t.skip("Linux release fixtures execute symlink safety without Windows privilege requirements"); return; }
  const f = await fixture(t); await fs.symlink(f.frozen, f.directory); await assert.rejects(f.service.get(), { code: "BOOTSTRAP_UNSAFE_PATH" }); await assert.rejects(f.service.configure({ enabled: true }), { code: "BOOTSTRAP_UNSAFE_PATH" }); assert.equal(hash(await fs.readFile(f.frozen)), f.frozenHash);
});
