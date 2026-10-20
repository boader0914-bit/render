"use strict";

// Production function boundaries with saved, synthetic artifacts only. This does
// not start the HTTP service, a crawler, a worker or any provider request.
const assert = require("node:assert/strict"), test = require("node:test"), fs = require("node:fs"), fsp = require("node:fs/promises");
const path = require("node:path"), os = require("node:os"), vm = require("node:vm"), crypto = require("node:crypto");
const { AsyncLocalStorage } = require("node:async_hooks"), { EventEmitter } = require("node:events"), { PassThrough } = require("node:stream");
const { setTimeout: delay } = require("node:timers/promises");
const { inspectManifest, inspectResult, allowsDerivedUpdates } = require("./daily_collection_quality.cjs");
const { createCollectionRotationScheduler, defaultConfig } = require("./collection_rotation_scheduler.cjs");
const { createCollectionPostprocessQueue } = require("./lib/collection_postprocess_queue.cjs");
const source = fs.readFileSync(path.join(__dirname, "glamping_app_server.cjs"), "utf8");
const plain = value => JSON.parse(JSON.stringify(value));
const sha = value => crypto.createHash("sha256").update(value).digest("hex");
function extract(name) {
  const start = source.search(new RegExp(`(?:async )?function ${name}\\(`));
  assert.ok(start >= 0, `production function ${name} exists`);
  const boundary = /\r?\n\}/.exec(source.slice(start + 1)); assert.ok(boundary, `${name} boundary`);
  return source.slice(start, start + 1 + boundary.index + boundary[0].length);
}
async function promptly(promise, message) {
  const controller = new AbortController();
  try { return await Promise.race([promise, delay(1000, undefined, { signal: controller.signal }).then(() => { throw Error(message); })]); }
  finally { controller.abort(); }
}
async function fixture(t, options = {}) {
  const temporary = await fsp.mkdtemp(path.join(os.tmpdir(), "collection-completion-flow-"));
  const cleanup = [];
  t.after(async () => { for (const operation of cleanup) await operation();
    const resolved = path.resolve(temporary); assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith("collection-completion-flow-")); await fsp.rm(resolved, { recursive: true, force: true }); });
  const runId = "fixture_glamping_20261020_090000", outputDir = path.join(temporary, "outputs", runId);
  await fsp.mkdir(outputDir, { recursive: true });
  const manifest = { schemaVersion: 2, outputDir, keyword: "완료시험글램핑", checkIn: "2026-10-20", checkOut: "2026-10-20", adults: 2,
    scheduledCollection: true, workerCollection: true, workerKey: options.workerKey || "manual", trigger: "scheduled",
    startedAt: "2026-10-20T00:00:00.000Z", collectedAt: "2026-10-20T00:00:01.000Z",
    collectionMode: "precision", collectionPurpose: "revenue_detail", productMode: "all", dayUseMode: "inspect", detailRankRanges: "1-20", bookingRangeDays: 1,
    naverAttemptedQueries: [{ status: 200 }], files: ["rows.csv"], fileRoles: { overall: "rows.csv" }, detailJsonFiles: [],
    counts: { naverOverall: 1, naverBookingStockChecked: 1, naverBookingStockSucceeded: 1, naverOtaObservationChecked: 0, naverOtaBlocked: 0,
      naverOtaFailed: 0, naverScheduleRequested: 2, naverScheduleSucceeded: 2, naverScheduleFailed: 0, naverScheduleBlocked: 0 },
    productCoverage: { version: 1, discovered: 2, eligible: 2, excluded: 0, queried: 2, truncated: 0,
      targets: [{ discovered: 2, eligible: 2, excluded: 0, queried: 2, truncated: 0, expectedDays: 1,
        days: [{ date: "2026-10-20", eligible: 2, queried: 2, succeeded: 2, failed: 0, truncated: 0 }] }] } };
  if (options.quality === "blocked") manifest.naverAttemptedQueries[0].status = 429;
  if (options.quality === "partial") { manifest.counts.naverScheduleSucceeded = 1; manifest.counts.naverScheduleFailed = 1; }
  if (options.quality === "failed") manifest.counts.naverOverall = 0;
  if (options.quality === "missing") delete manifest.counts.naverScheduleSucceeded;
  if (options.legacyFlags) {
    delete manifest.scheduledCollection; delete manifest.workerCollection; delete manifest.webCollection;
    if (options.quality === "partial") manifest.counts.naverBookingStockChecked = 2;
  }
  const manifestBytes = JSON.stringify(manifest), csvBytes = "name,place_id\n완료시험글램핑,123456789\n";
  if (!options.missingManifest) await fsp.writeFile(path.join(outputDir, "manifest.json"), manifestBytes);
  await fsp.writeFile(path.join(outputDir, "rows.csv"), csvBytes);
  const output = options.missingOutput ? null : manifest, collectionQuality = options.missingManifest
    ? { status: "failed", reason: "manifest_unreadable" } : inspectManifest(manifest);
  const contextStore = new AsyncLocalStorage(), lanes = Object.fromEntries(["manual", "scheduled", "web"].map(key => [key, {
    key, activeCrawlPromise: null, activeCrawlJob: null, activeCrawlChild: null, crawlQueue: [] }]));
  const calls = { enqueue: [], release: [], heavy: [], ready: [], stop: [], next: [] }, rows = new Map();
  const forbidHeavy = name => async () => { calls.heavy.push(name); throw Error(`${name} must not run before collection completion`); };
  const queue = { enqueue: async (id, config) => {
    calls.enqueue.push({ runId: id, options: plain(config || {}) });
    if (options.enqueueGate) await options.enqueueGate;
    if (options.enqueueFails) throw Object.assign(Error("synthetic persistence failure"), { code: "ENOSPC" });
    const row = rows.get(id) || { runId: id, state: config?.deferred ? "held" : "queued" }; rows.set(id, row); return row;
  }, release: async id => { calls.release.push(id); const row = rows.get(id); if (row?.state === "held") row.state = "queued"; return row; },
    held: async () => [...rows.values()].filter(row => row.state === "held") };
  const plan = payload => ({ ...payload, keyword: manifest.keyword, checkIn: manifest.checkIn, checkOut: manifest.checkOut, resolvedSearchMode: "keyword",
    requestedSearchMode: "keyword", searchIntent: "lodging", searchRegion: "", searchScope: "nationwide", searchScopeLabel: "전국",
    collectionMode: "precision", collectionPurpose: "revenue_detail", detailRankRanges: "1-20", productMode: "all", dayUseMode: "inspect",
    bookingRangeDays: 1, bookingRangePlaceLimit: 20, bookingStockPlaceLimit: 20 });
  const completed = () => {
    if (options.crawlerFails) throw Object.assign(Error("synthetic crawler failure"), { code: "COLLECTOR_PROVIDER_BLOCKED" });
    return { runId: options.missingRunId ? null : runId, manifest: output, collectionQuality };
  };
  const c = vm.createContext({ console: { warn() {}, error() {}, log() {} }, Date, Map, Set, Buffer, process: { env: {}, execPath: process.execPath },
    path, fs, fsp, crypto, ROOT: temporary, DATA_DIR: temporary, OUTPUTS_DIR: path.dirname(outputDir), CONFIG_DIR: temporary, DEFAULT_NODE_MODULES: path.join(temporary, "none"),
    COLLECTOR_EXECUTION_MODE: options.localChild ? "local" : "worker", USER_ROLES: { admin: "admin", b2b: "b2b" },
    crawlLanes: lanes, crawlLane: () => contextStore.getStore() || lanes.manual,
    withCrawlLane: (key, operation) => contextStore.run(lanes[key], operation), collectionPostprocessQueue: queue,
    collectionRotationScheduler: { isEnabled: () => true }, pausedScheduleOccurrences: new Set(), collectorBrokerReady: Promise.resolve(),
    crawlExecutionPlan: plan, normalizeCollectionSource: value => value || "admin_search", sourceRoleForCollectionSource: () => "admin",
    collectionSourceLabel: () => "관리자", normalizeSearchMode: value => value || "keyword", scheduledCrawlerPacingEnv: () => ({}),
    assertCollectorReady: async key => { calls.ready.push(key); }, historicalBookingContext: async () => ({ historicalBookingBusinesses: [] }),
    collectorBrokerForLane: () => ({}), dispatchCollector: async config => { config.onJob?.("collector_fixture"); return completed(); },
    collectorWeb: { run: async () => completed() }, inspectDailyCollectionResult: inspectResult, allowsDerivedUpdates,
    resolveRunDir: id => id === runId ? outputDir : null,
    readManifest: async directory => JSON.parse(await fsp.readFile(path.join(directory, "manifest.json"), "utf8")),
    stopCollectorLane: async key => { calls.stop.push(key); }, appendHistoryForRun: forbidHeavy("history"),
    invalidateIndustryAnalysis: async () => { calls.heavy.push("industry"); }, ensureB2BSearchHistoryForJob: forbidHeavy("b2b"),
    appendCrawlTimingEntry: forbidHeavy("timing"), masterDbDualWriteQueue: { mode: "shadow", enqueue: forbidHeavy("dualwrite") },
    finishOpenCrawlRuntimeStage() {}, publicCrawlStageTimings: () => [], estimateCrawlCompletion: payload => ({ ...plan(payload), estimatedTotalSeconds: 1 }),
    readCrawlTimingStoreSync: () => ({}), cleanupRecentCrawlResults() {}, recentCrawlResults: new Map(),
    startNextCrawlJob: () => { calls.next.push((contextStore.getStore() || lanes.manual).key); }, recordCrawlRuntimeOutputChunk() {},
    spawn: () => { const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
      setImmediate(() => { child.stdout.emit("data", Buffer.from(JSON.stringify(output))); child.emit("close", 0); }); return child; },
    crawlCancelledError: () => Object.assign(Error("cancelled"), { cancelled: true }) });
  for (const name of ["resolveCrawlJob", "enqueueCollectionPostprocess", "processCollectionPostprocess", "releaseCommittedCollectionPostprocess", "withCollectionPostprocess",
    "runCrawlerInternal", "startCrawlJob"]) vm.runInContext(extract(name), c);
  async function run(overrides = {}) {
    const workerKey = overrides.workerKey || options.workerKey || "manual";
    const payload = { ...plan({}), workerKey, sourceRole: "admin", collectionSource: "admin_search", trigger: "scheduled", scheduledCollection: true,
      rotationCollection: true, ...overrides };
    const job = { id: "crawl_fixture", payload, signature: `signature_${workerKey}`, collectionSource: "admin_search", sourceRole: "admin",
      plan: plan(payload), waiterCount: 1, clientRequestIds: new Set([payload.clientRequestId || "rotation_2026-10-20_1"]), b2bSubscribers: new Map(), stageEvents: [] };
    job.promise = new Promise((resolve, reject) => { job.resolve = resolve; job.reject = reject; });
    contextStore.run(lanes[workerKey], () => c.startCrawlJob(job));
    return { job, result: await promptly(job.promise, "archive completion waited for derived processing") };
  }
  return { c, calls, lanes, queue, rows, run, runId, outputDir, manifest, collectionQuality, temporary, cleanup,
    rawHashes: async () => ({ manifest: options.missingManifest ? null : sha(await fsp.readFile(path.join(outputDir, "manifest.json"))),
      csv: sha(await fsp.readFile(path.join(outputDir, "rows.csv"))) }) };
}

for (const workerKey of ["web", "manual", "scheduled"]) test(`${workerKey}: saved complete result releases the lane while derived work remains held`, async t => {
  const f = await fixture(t, { workerKey }), before = await f.rawHashes();
  const { result, job } = await f.run();
  assert.equal(result.runId, f.runId); assert.equal(result.collectionQuality.status, "complete"); assert.equal(result.postprocess.state, "held");
  assert.equal(job.status, "completed"); assert.equal(f.lanes[workerKey].activeCrawlPromise, null); assert.equal(f.lanes[workerKey].activeCrawlJob, null);
  assert.equal(f.calls.enqueue.length, 1); assert.equal(f.calls.enqueue[0].options.deferred, true); assert.deepEqual(f.calls.heavy, []);
  assert.deepEqual(await f.rawHashes(), before); assert.deepEqual(f.calls.release, []);
});

test("nonrotation completion queues derived work without holding collection ownership", async t => {
  const f = await fixture(t), { result } = await f.run({ rotationCollection: false, trigger: "manual", scheduledCollection: false });
  assert.equal(result.collectionQuality.status, "complete"); assert.equal(result.postprocess.state, "queued");
  assert.equal(f.calls.enqueue[0].options.deferred, false); assert.deepEqual(f.calls.heavy, []);
});

test("durable queue persistence failure is reported separately while archive quality and lane cleanup survive", async t => {
  const f = await fixture(t, { enqueueFails: true }), before = await f.rawHashes(), { result, job } = await f.run();
  assert.equal(result.runId, f.runId); assert.equal(result.collectionQuality.status, "complete"); assert.equal(job.status, "completed");
  assert.equal(result.postprocess.state, "failed"); assert.equal(result.postprocess.errorCode, "COLLECTION_POSTPROCESS_PERSIST_FAILED");
  assert.equal(f.lanes.manual.activeCrawlJob, null); assert.equal(f.lanes.manual.activeCrawlPromise, null);
  assert.deepEqual(await f.rawHashes(), before); assert.deepEqual(f.calls.heavy, []);
});

test("collection ownership is held only until the durable queue receipt is acknowledged", async t => {
  let release; const gate = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, { enqueueGate: gate });
  const pending = f.run();
  while (!f.calls.enqueue.length) await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.lanes.manual.activeCrawlJob.status, "active"); assert.ok(f.lanes.manual.activeCrawlPromise);
  assert.deepEqual(f.calls.heavy, []);
  release(); const { result } = await pending;
  assert.equal(result.postprocess.state, "held"); assert.equal(f.lanes.manual.activeCrawlJob, null);
});

for (const quality of ["blocked", "partial", "failed", "missing"]) test(`${quality} collection quality is never promoted by postprocessing admission`, async t => {
  const f = await fixture(t, { quality }), { result } = await f.run();
  assert.notEqual(result.collectionQuality.status, "complete"); assert.equal(result.collectionQuality.status, f.collectionQuality.status);
  assert.equal(f.calls.enqueue.length, 0); assert.deepEqual(f.calls.heavy, ["industry"]); assert.equal(f.lanes.manual.activeCrawlJob, null);
  if (quality === "blocked") assert.deepEqual(f.calls.stop, ["manual"]);
});

test("missing immutable manifest is a failed result, not a real zero or a complete queued result", async t => {
  const f = await fixture(t, { missingManifest: true }), { result } = await f.run();
  assert.equal(result.collectionQuality.status, "failed"); assert.equal(result.collectionQuality.reason, "manifest_unreadable");
  assert.equal(f.calls.enqueue.length, 0); assert.deepEqual(f.calls.heavy, ["industry"]);
});

test("legacy unguarded partial results do not enter postprocessing or the successful-result cache", async t => {
  const f = await fixture(t, { legacyFlags: true, quality: "partial" });
  assert.equal(allowsDerivedUpdates(f.manifest), true, "legacy compatibility alone cannot authorize a successful completion");
  const { result } = await f.run({ rotationCollection: false, scheduledCollection: false, trigger: "manual" });
  assert.equal(result.collectionQuality.status, "partial"); assert.equal(f.calls.enqueue.length, 0);
  assert.equal(f.c.recentCrawlResults.size, 0); assert.deepEqual(f.calls.heavy, ["industry"]);
  assert.equal(f.lanes.manual.activeCrawlPromise, null); assert.equal(f.lanes.manual.activeCrawlJob, null);
});

for (const missing of ["missingOutput", "missingRunId"]) test(`a claimed complete result with ${missing} is downgraded before postprocess admission`, async t => {
  const f = await fixture(t, { workerKey: "web", [missing]: true }), { result } = await f.run();
  assert.equal(result.collectionQuality.status, "failed"); assert.equal(result.collectionQuality.reason, "manifest_missing");
  assert.equal(f.calls.enqueue.length, 0); assert.deepEqual(f.calls.heavy, missing === "missingRunId" ? [] : ["industry"]);
  assert.equal(f.lanes.web.activeCrawlJob, null);
});

test("a collection failure still rejects its caller and always releases collection ownership", async t => {
  const f = await fixture(t, { crawlerFails: true });
  await assert.rejects(f.run(), { code: "COLLECTOR_PROVIDER_BLOCKED" });
  assert.equal(f.lanes.manual.activeCrawlPromise, null); assert.equal(f.lanes.manual.activeCrawlJob, null);
  assert.equal(f.calls.enqueue.length, 0); assert.deepEqual(f.calls.heavy, ["industry"]);
});

test("legacy child completion also avoids inline history work", async t => {
  const f = await fixture(t, { localChild: true }), { result } = await f.run();
  assert.equal(result.runId, f.runId); assert.equal(result.collectionQuality.status, "complete");
  assert.equal(result.postprocess.state, "held"); assert.deepEqual(f.calls.heavy, []);
});

test("later derived-work failure cannot rewrite the already-completed collection or published files", async t => {
  const f = await fixture(t), { result } = await f.run(), before = await f.rawHashes();
  const context = f.calls.enqueue[0].options.context;
  await assert.rejects(f.c.processCollectionPostprocess(f.runId, context), /history must not run before collection completion/);
  assert.equal(result.collectionQuality.status, "complete"); assert.equal(f.lanes.manual.activeCrawlJob, null);
  assert.deepEqual(await f.rawHashes(), before); assert.deepEqual(f.calls.heavy, ["history"]);
});

test("derived execution rechecks saved evidence and refuses an artifact changed after admission", async t => {
  const f = await fixture(t), { result } = await f.run();
  const changed = plain(f.manifest); changed.naverAttemptedQueries[0].status = 429;
  await fsp.writeFile(path.join(f.outputDir, "manifest.json"), JSON.stringify(changed));
  const before = await f.rawHashes();
  await assert.rejects(f.c.processCollectionPostprocess(f.runId, f.calls.enqueue[0].options.context), { code: "COLLECTION_POSTPROCESS_EVIDENCE_CHANGED" });
  assert.equal(result.collectionQuality.status, "complete", "the prior collection receipt remains unchanged");
  assert.deepEqual(f.calls.heavy, []); assert.deepEqual(await f.rawHashes(), before);
});

test("matching evidence hashes cannot bypass the derived worker's saved quality check", async t => {
  const f = await fixture(t), { result } = await f.run();
  const changed = plain(f.manifest); changed.naverAttemptedQueries[0].status = 429;
  const bytes = JSON.stringify(changed); await fsp.writeFile(path.join(f.outputDir, "manifest.json"), bytes);
  const context = { ...f.calls.enqueue[0].options.context, manifestSha256: sha(bytes) }, before = await f.rawHashes();
  await assert.rejects(f.c.processCollectionPostprocess(f.runId, context), { code: "COLLECTION_POSTPROCESS_QUALITY_HOLD" });
  assert.equal(result.collectionQuality.status, "complete"); assert.deepEqual(f.calls.heavy, []); assert.deepEqual(await f.rawHashes(), before);
});

test("rotation commits its complete slot before releasing held derived work", async t => {
  const f = await fixture(t), at = new Date("2026-10-20T00:00:00.000Z"); let scheduler, committed = false, resultSeen;
  scheduler = createCollectionRotationScheduler({ dataDir: f.temporary, now: () => at, getFreeBytes: async () => 1024 ** 3,
    getWorkerState: async () => ({ ready: true, active: false, halted: false }),
    executeSlot: async payload => { resultSeen = (await f.run(payload)).result; return resultSeen; },
    onResultCommitted: async (result, slot) => {
      const saved = scheduler.history().items.find(item => item.id === slot.id);
      assert.equal(saved.status, "complete"); assert.equal(saved.runId, f.runId); assert.equal(result.status, "complete");
      assert.equal(resultSeen.postprocess.state, "held");
      committed = true; await f.queue.release(result.runId);
    } });
  f.cleanup.push(() => scheduler.close());
  const config = defaultConfig(at); config.keywords = [f.manifest.keyword]; config.workers = [{ workerKey: "manual", dailyLimit: 1 }]; config.collection.bookingDays = 1;
  await scheduler.updateConfig(config, { startKeyword: f.manifest.keyword }); await scheduler.setEnabled(true);
  await promptly(scheduler.tick(), "rotation waited for derived work after immutable completion");
  assert.equal(committed, true); assert.equal(scheduler.history().items[0].status, "complete"); assert.equal(scheduler.status().active, false);
  assert.equal(resultSeen.collectionQuality.status, "complete"); assert.deepEqual(f.calls.release, [f.runId]); assert.deepEqual(f.calls.heavy, []);
});

test("real durable queue recovery releases only the exact committed slot after a crash before release", async t => {
  const f = await fixture(t), at = new Date("2026-10-20T00:00:00.000Z"), processed = [], directory = path.join(f.temporary, "derived");
  let queue = createCollectionPostprocessQueue({ dataDir: directory, processRun: async id => { processed.push(id); return { derived: true }; } });
  const bindQueue = () => { f.c.collectionPostprocessQueue = {
    enqueue: (id, options) => queue.enqueue(id, plain(options)), release: id => queue.release(id), status: options => queue.status(plain(options)),
    held: () => queue.held()
  }; };
  bindQueue();
  let scheduler = createCollectionRotationScheduler({ dataDir: f.temporary, now: () => at, getFreeBytes: async () => 1024 ** 3,
    getWorkerState: async () => ({ ready: true, active: false, halted: false }),
    executeSlot: async payload => (await f.run(payload)).result,
    onResultCommitted: async () => { throw Object.assign(Error("crash before release"), { code: "SYNTHETIC_RELEASE_CRASH" }); } });
  f.cleanup.push(async () => { scheduler.close(); await queue.close(); });
  const config = defaultConfig(at); config.keywords = [f.manifest.keyword]; config.workers = [{ workerKey: "manual", dailyLimit: 1 }]; config.collection.bookingDays = 1;
  await scheduler.updateConfig(config, { startKeyword: f.manifest.keyword }); await scheduler.setEnabled(true);
  await promptly(scheduler.tick(), "complete slot waited for the derived queue");
  const slot = scheduler.history().items[0]; assert.equal(slot.status, "complete"); assert.equal(slot.runId, f.runId);
  const held = await queue.status({ runId: f.runId });
  assert.equal(held.state, "held", "the server state contract must be present on real queue rows");
  assert.equal(held.scheduleOccurrenceId, slot.id); assert.deepEqual(processed, []);
  const wrongRun = "different_glamping_20261020_090000", wrongSlot = "uncommitted_glamping_20261020_090000", noSlot = "unbound_glamping_20261020_090000";
  await queue.enqueue(wrongRun, { deferred: true, context: { scheduleOccurrenceId: slot.id } });
  await queue.enqueue(wrongSlot, { deferred: true, context: { scheduleOccurrenceId: "rotation_2026-10-20_2" } });
  await queue.enqueue(noSlot, { deferred: true, context: {} });
  await queue.close(); scheduler.close();
  queue = createCollectionPostprocessQueue({ dataDir: directory, processRun: async id => { processed.push(id); return { derived: true }; } }); bindQueue();
  scheduler = createCollectionRotationScheduler({ dataDir: f.temporary, now: () => at, executeSlot: async () => { throw Error("recovery must never recollect"); } });
  f.c.collectionRotationScheduler = scheduler;
  await f.c.releaseCommittedCollectionPostprocess();
  assert.equal((await queue.status({ runId: f.runId })).state, "queued");
  for (const id of [wrongRun, wrongSlot, noSlot]) assert.equal((await queue.status({ runId: id })).state, "held");
  const decorated = await f.c.withCollectionPostprocess([{ runId: f.runId }, { runId: "absent_result" }]);
  assert.equal(decorated[0].postprocess.state, "queued"); assert.equal(decorated[1].postprocess, undefined);
  const before = await f.rawHashes(); await queue.runOnce();
  assert.equal((await queue.status({ runId: f.runId })).state, "complete"); assert.deepEqual(processed, [f.runId]);
  await f.c.releaseCommittedCollectionPostprocess(); await queue.runOnce();
  assert.deepEqual(processed, [f.runId], "completed derivation must not repeat after another recovery pass");
  assert.deepEqual(await f.rawHashes(), before); assert.equal(scheduler.history().items[0].status, "complete");
});

test("queue status failure keeps archived results visible and exposes only a safe unavailable status", async t => {
  const f = await fixture(t), rows = [{ runId: f.runId, collectionQuality: { status: "complete" }, totalRooms: 16, revenue: 19568000 }];
  f.c.collectionPostprocessQueue = { status: async () => { throw Error("private path and token must not be copied"); } };
  const unavailable = plain(await f.c.withCollectionPostprocess(rows));
  assert.equal(unavailable.length, 1); assert.equal(unavailable[0].runId, rows[0].runId);
  assert.equal(unavailable[0].totalRooms, 16); assert.equal(unavailable[0].revenue, 19568000);
  assert.deepEqual(unavailable[0].collectionQuality, { status: "complete" });
  assert.deepEqual(unavailable[0].postprocess, { state: "unavailable", errorCode: "COLLECTION_POSTPROCESS_STATUS_UNAVAILABLE" });
  assert.deepEqual(rows[0].postprocess, undefined);
  f.c.collectionPostprocessQueue = { status: async () => ({ items: [], errorCode: "COLLECTION_POSTPROCESS_STATE_INVALID" }) };
  const corrupt = plain(await f.c.withCollectionPostprocess(rows));
  assert.equal(corrupt[0].postprocess.errorCode, "COLLECTION_POSTPROCESS_STATE_INVALID"); assert.equal(corrupt[0].totalRooms, 16);
});

test("archive ID projection uses real postprocess state and does not lose unrelated result fields", async t => {
  const f = await fixture(t);
  f.c.collectionPostprocessQueue = { status: async () => ({ items: [{ runId: f.runId, state: "queued" }], errorCode: null }) };
  const rows = await f.c.withCollectionPostprocess([{ id: f.runId, quality: "complete" }, { id: "other_run", quality: "partial" }], "id");
  assert.equal(rows[0].postprocess.state, "queued"); assert.equal(rows[0].quality, "complete");
  assert.equal(rows[1].postprocess, undefined); assert.equal(rows[1].quality, "partial");
});

test("company-search history retains the original safe request projection through delayed processing", async t => {
  const f = await fixture(t), original = { keyword: f.manifest.keyword, searchMode: "company", adults: 4, workerKey: "manual", sourceRole: "b2b",
    collectionSource: "b2b_search", collectionMode: "precision", collectionPurpose: "revenue_detail", dayUseMode: "inspect",
    bookingRangeDays: 1, productMode: "all", detailRankRanges: "1-20", rotationCollection: false,
    recrawlContext: { companyId: "cmp_place_123456789", sourceRunId: "previous_glamping_20261019_090000" },
    cookie: "DO_NOT_PERSIST_COOKIE", authorization: "DO_NOT_PERSIST_AUTH", env: { password: "DO_NOT_PERSIST_ENV" },
    b2bSubscriber: { password: "DO_NOT_PERSIST_SUBSCRIBER_SECRET" } };
  const job = { plan: { keyword: f.manifest.keyword }, payload: original, startedAt: new Date("2026-10-20T00:00:00Z"),
    collectionSource: "b2b_search", sourceRole: "b2b", b2bSubscribers: new Map() };
  const result = { runId: f.runId, output: f.manifest, collectionQuality: f.collectionQuality, workerKey: "manual", trigger: "manual" };
  await f.c.enqueueCollectionPostprocess(job, result, { endedAt: new Date("2026-10-20T00:00:01Z"), stageTimings: [], estimate: { seconds: 1 } });
  const context = f.calls.enqueue[0].options.context, saved = context.historyPayload;
  assert.equal(saved.searchMode, "company"); assert.equal(saved.adults, 4); assert.equal(saved.collectionSource, "b2b_search");
  assert.deepEqual(saved.recrawlContext, original.recrawlContext); assert.equal(saved.cookie, undefined); assert.equal(saved.authorization, undefined);
  assert.equal(saved.env, undefined); assert.equal(saved.b2bSubscriber, undefined); assert.equal(JSON.stringify(context).includes("DO_NOT_PERSIST"), false);
  let memberPayload;
  f.c.appendHistoryForRun = async () => ({ appended: 1 }); f.c.appendCrawlTimingEntry = async () => ({ recorded: true });
  f.c.ensureB2BSearchHistoryForJob = async delayed => { memberPayload = plain(delayed.payload); };
  f.c.masterDbDualWriteQueue = { mode: "off" };
  await f.c.processCollectionPostprocess(f.runId, context);
  assert.deepEqual(memberPayload, saved); assert.equal(memberPayload.searchMode, "company");
});
