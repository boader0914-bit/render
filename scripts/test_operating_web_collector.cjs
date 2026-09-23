"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const { setTimeout: delay } = require("node:timers/promises");
const { createOperatingWebCollector } = require("./operating_web_collector.cjs");
const ROOT = path.resolve(__dirname, "..");

const requestEnv = { CHECK_IN: "2026-09-23", CHECK_OUT: "2026-09-24", ADULTS: "2", SEARCH_MODE: "company",
  COLLECTION_MODE: "precision", COLLECTION_PURPOSE: "revenue_detail", PRODUCT_MODE: "all", BOOKING_RANGE_DAYS: "1", BOOKING_RANGE_PLACE_LIMIT: "0",
  DETAIL_RANK_RANGES: "1-20", SOURCE_ROLE: "admin", COLLECTION_SOURCE: "admin_search" };
async function artifacts(env, keyword, { partial = false, blocked = false, mutate = () => {} } = {}) {
  const runId = `company_fixture_web_${env.COLLECTOR_RUN_TOKEN}_glamping_${env.RUN_STAMP}`;
  const outputDir = path.join(env.OUTPUTS_DIR, runId);
  const manifest = { schemaVersion: 2, outputDir, keyword, startedAt: new Date().toISOString(), collectedAt: new Date().toISOString(),
    webCollection: true, workerKey: "web", trigger: "manual", jobId: env.COLLECTOR_JOB_ID, collectorEngine: "operating-web-v2",
    collectorRunToken: env.COLLECTOR_RUN_TOKEN, executionHost: {role:"operating_web",serviceId:env.RENDER_SERVICE_ID||null},
    files: ["rooms.csv"], detailJsonFiles: [], fileRoles: { overall: "rooms.csv" },
    checkIn: env.CHECK_IN, checkOut: env.CHECK_OUT, adults: env.ADULTS, searchMode: env.SEARCH_MODE,
    collectionMode: env.COLLECTION_MODE, collectionPurpose: env.COLLECTION_PURPOSE, productMode: env.PRODUCT_MODE,
    bookingRangeDays: env.BOOKING_RANGE_DAYS, bookingRangePlaceLimit: env.BOOKING_RANGE_PLACE_LIMIT,
    detailRankRanges: env.DETAIL_RANK_RANGES, sourceRole: env.SOURCE_ROLE, collectionSource: env.COLLECTION_SOURCE,
    collectionProfileFlags: { collectBookingStock: true }, naverAttemptedQueries: [{ status: 200 }],
    requestPacing: { enabled: false, guardEnabled: true, pacingEnabled: false, minIntervalMs: 0, maxConcurrentRequests: null, stopped: blocked,
      ...(blocked ? { blockedCode: "BookingAPITooManyRequests", blockedStatus: 200 } : {}) },
    ...(blocked ? { collectionFailed: true } : {}),
    counts: { naverOverall: 1, naverBookingStockEligible: 1, naverBookingStockChecked: 1, naverBookingStockSucceeded: 1,
      naverOtaObservationChecked: 0, naverOtaBlocked: 0, naverOtaFailed: 0,
      naverScheduleRequested: 1, naverScheduleSucceeded: partial || blocked ? 0 : 1, naverScheduleFailed: partial || blocked ? 1 : 0, naverScheduleBlocked: blocked ? 1 : 0 },
    productCoverage: { version: 1, discovered: 1, eligible: 1, excluded: 0, queried: 1, truncated: 0,
      targets: [{ discovered: 1, eligible: 1, excluded: 0, queried: 1, truncated: 0, expectedDays: 1,
        days: [{ date: env.CHECK_IN, eligible: 1, queried: 1, succeeded: partial || blocked ? 0 : 1, failed: partial || blocked ? 1 : 0, truncated: 0 }] }] }
  };
  mutate(manifest);
  await fs.mkdir(outputDir, { recursive: true });
  await fs.writeFile(path.join(outputDir, "rooms.csv"), "room,count\nfixture,10\n");
  await fs.writeFile(path.join(outputDir, "manifest.json"), JSON.stringify(manifest));
  return { runId, outputDir, manifest };
}
async function fixture(t, { execute, ...options } = {}) {
  const tempRoot=await fs.realpath(os.tmpdir());
  const dataDir = await fs.mkdtemp(path.join(tempRoot, "operating-web-collector-test-")), outputsDir = path.join(dataDir, "outputs");
  t.after(async()=>{assert.equal(path.dirname(await fs.realpath(dataDir)),tempRoot);await fs.rm(dataDir,{recursive:true,force:true});});
  const spawned = [], errors = [], children = [];
  const settings = { dataDir, outputsDir, root: ROOT, ...options,
    spawnImpl(executable, args, config) {
      const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
      let closed = false;
      const close = (code = 0, signal = null) => { if (closed) return; closed = true; child.stdout.end(); child.stderr.end(); child.emit("close", code, signal); };
      child.kill = signal => { setImmediate(() => close(null, signal)); return true; };
      spawned.push({ executable, args, config }); children.push(child);
      setImmediate(async () => {
        try { await (execute || (async info => { await artifacts(info.config.env, info.args[1]); info.close(); }))({ child, executable, args, config, close, outputsDir }); }
        catch (error) { errors.push(error); close(1); }
      });
      return child;
    }
  };
  const api = createOperatingWebCollector(settings);
  const run = overrides => api.run({ keyword: "시즌글램핑", env: { ...requestEnv }, jobId: "web-test-job", ...overrides });
  return { api, run, dataDir, outputsDir, spawned, children, errors, settings };
}

test("web directly executes one guarded native-speed child without credentials and publishes verified artifacts", async t => {
  const progress = [], children = [];
  const f = await fixture(t, { onProgress: line => progress.push(line), execute: async ({ child, args, config, close }) => {
    child.stdout.write("Checking Naver booking stock...\nsecret-not-a-progress-line\n");
    await artifacts(config.env, args[1]); close();
  } });
  const result = await f.run({ onChild: child => children.push(child), env: { ...requestEnv, PATH: process.env.PATH || "", NODE_OPTIONS: "--bad-option",
    GLAMPING_ADMIN_PASSWORD: "do-not-forward", COLLECTOR_WORKER_TOKEN: "do-not-forward", NAVER_REQUEST_PACING_ENABLED: "1",
    NAVER_REQUEST_MIN_INTERVAL_MS: "200", NAVER_REQUEST_MAX_CONCURRENCY: "1", NAVER_BOOKING_DETAIL_CONCURRENCY: "1",
    NAVER_SCHEDULE_CONCURRENCY: "1", NAVER_OTA_OBSERVATION_CONCURRENCY: "1", NAVER_SCHEDULE_DELAY_MS: "900", REGIONAL_SEARCH_CONCURRENCY: "1",
    RENDER_SERVICE_ID: "srv-test123" } });
  assert.equal(result.collectionQuality.status, "complete"); assert.equal(f.spawned.length, 1); assert.deepEqual(f.errors, []);
  const child = f.spawned[0]; assert.equal(child.executable, process.execPath); assert.equal(child.config.shell, false);
  assert.equal(path.basename(child.args[0]), "gyeongnam_glamping_crawl.cjs");
  for (const key of ["GLAMPING_ADMIN_PASSWORD", "COLLECTOR_WORKER_TOKEN", "NODE_OPTIONS", "NAVER_REQUEST_MIN_INTERVAL_MS", "NAVER_REQUEST_MAX_CONCURRENCY",
    "NAVER_BOOKING_DETAIL_CONCURRENCY", "NAVER_SCHEDULE_CONCURRENCY", "NAVER_OTA_OBSERVATION_CONCURRENCY", "NAVER_SCHEDULE_DELAY_MS", "REGIONAL_SEARCH_CONCURRENCY"]) assert.equal(child.config.env[key], undefined, key);
  assert.equal(child.config.env.NAVER_REQUEST_PACING_ENABLED, "0"); assert.equal(child.config.env.COLLECTOR_WEB_RUNTIME, "1");
  assert.equal(child.config.env.COLLECTOR_WORKER_RUNTIME, "0"); assert.equal(child.config.env.SCHEDULED_COLLECTION, "0");
  assert.equal(child.config.env.RENDER_SERVICE_ID, "srv-test123");
  assert.deepEqual(progress, ["Checking Naver booking stock...\n"]); assert.equal(children.at(-1), null);
  assert.equal(result.manifest.outputDir, path.join(f.outputsDir, result.runId));
  const saved = JSON.parse(await fs.readFile(path.join(result.manifest.outputDir, "manifest.json"), "utf8"));
  assert.equal(saved.collectionQuality.status, "complete"); assert.equal((await f.api.status()).activeJobId, null);
});

test("partial responses remain partial and do not become successful results", async t => {
  const f = await fixture(t, { execute: async ({ args, config, close }) => { await artifacts(config.env, args[1], { partial: true }); close(); } });
  assert.equal((await f.run()).collectionQuality.status, "partial");
});

test("block marker promptly persists protection and reports once while retaining the blocked receipt", async t => {
  let notices = 0, sawPersistent = false;
  const f = await fixture(t, { onProviderBlocked: async () => { notices++; sawPersistent = (await f.api.status()).halted; },
    execute: async ({ child, args, config, close }) => {
      child.stdout.write("COLLECTOR_PROVIDER_"); child.stdout.write("BLOCKED\nCOLLECTOR_PROVIDER_BLOCKED\n");
      for (let i = 0; i < 50 && !notices; i++) await delay(5);
      assert.equal(notices, 1); await artifacts(config.env, args[1], { blocked: true }); close(1);
    } });
  const result = await f.run(); assert.equal(result.collectionQuality.status, "blocked"); assert.equal(notices, 1); assert.equal(sawPersistent, true);
  await assert.rejects(f.run({ jobId: "second-job" }), { code: "COLLECTOR_PROVIDER_BLOCKED" }); assert.equal(f.spawned.length, 1);
  await f.api.resetHalt(); assert.equal((await f.api.status()).halted, false);
});

test("global halt cancels only the active web child and preserves the provider cause", async t => {
  let started;
  const running = new Promise(resolve => { started = resolve; });
  const f = await fixture(t, { execute: async () => { started(); } });
  const work = f.run(); work.catch(() => {}); await running;
  await assert.rejects(f.run({ jobId: "second-job" }), { code: "COLLECTOR_WEB_BUSY" });
  await f.api.halt("COLLECTOR_PROVIDER_BLOCKED", { cancelActive: true });
  await assert.rejects(work, { code: "COLLECTOR_PROVIDER_BLOCKED" }); assert.equal(f.spawned.length, 1);
  assert.equal((await f.api.status()).activeJobId, null);
});

test("restarting with an unfinished durable receipt requires review and never repeats work", async t => {
  const f = await fixture(t); await f.api.initialize();
  await fs.writeFile(path.join(f.dataDir, "collector-web", "state.json"), JSON.stringify({ version: 1, halted: null, active: { jobId: "old-web-job" } }));
  const restarted = createOperatingWebCollector(f.settings), status = await restarted.status();
  assert.equal(status.halted, true); assert.equal(status.errorCode, "COLLECTOR_WEB_RESTART_INTERRUPTED"); assert.equal(status.activeJobId, null);
  await assert.rejects(restarted.run({ keyword: "시즌글램핑", env: requestEnv }), { code: "COLLECTOR_WEB_RESTART_INTERRUPTED" });
  assert.equal(f.spawned.length, 0);
});

test("stdout success cannot replace a missing on-disk receipt", async t => {
  const f = await fixture(t, { execute: async ({ child, close }) => { child.stdout.write('{"collectionQuality":{"status":"complete"}}\n'); close(); } });
  await assert.rejects(f.run(), { code: "COLLECTOR_ARTIFACT_INVALID" });
});

test("scope mismatches, escaped files and unguarded receipts never publish", async t => {
  for (const [mutate, code] of [[m => { m.checkOut = "2026-10-01"; }, "COLLECTOR_SCOPE_MISMATCH"],
    [m => { m.collectorRunToken = "wrong-token"; }, "COLLECTOR_SCOPE_MISMATCH"],
    [m => { m.executionHost.role = "remote_worker"; }, "COLLECTOR_SCOPE_MISMATCH"],
    [m => { m.files.push("../outside.csv"); }, "COLLECTOR_ARTIFACT_INVALID"],
    [m => { m.requestPacing.pacingEnabled = true; }, "COLLECTOR_GUARD_RECEIPT_REQUIRED"],
    [m => { m.requestPacing.maxConcurrentRequests = 1; }, "COLLECTOR_GUARD_RECEIPT_REQUIRED"],
    [m => { m.requestPacing.guardEnabled = false; }, "COLLECTOR_GUARD_RECEIPT_REQUIRED"]]) {
    const f = await fixture(t, { execute: async ({ args, config, close }) => { await artifacts(config.env, args[1], { mutate }); close(); } });
    await assert.rejects(f.run(), { code });
    assert.deepEqual(await fs.readdir(f.outputsDir).catch(() => []), []);
  }
});

test("an existing final directory is never overwritten", async t => {
  let sentinel;
  const f = await fixture(t, { execute: async ({ args, config, close, outputsDir }) => {
    const result = await artifacts(config.env, args[1]);
    const destination = path.join(outputsDir, result.runId); await fs.mkdir(destination, { recursive: true });
    sentinel = path.join(destination, "manifest.json"); await fs.writeFile(sentinel, "KEEP EXISTING"); close();
  } });
  await assert.rejects(f.run(), { code: "COLLECTOR_RUN_ALREADY_EXISTS" }); assert.equal(await fs.readFile(sentinel, "utf8"), "KEEP EXISTING");
});

test("cancellation after child exit still prevents result publication", async t => {
  let cancelled = false;
  const f = await fixture(t, { execute: async ({ args, config, close }) => {
    await artifacts(config.env, args[1]); close(); cancelled = true;
  } });
  await assert.rejects(f.run({ isCancelled: () => cancelled }), { code: "CRAWL_CANCELLED" });
  assert.deepEqual(await fs.readdir(f.outputsDir).catch(() => []), []);
});

test("a provider halt during artifact verification cannot publish success", async t => {
  const f = await fixture(t);
  const originalRead = fs.readFile;
  let halted = false;
  fs.readFile = async function(file, ...args) {
    const result = await originalRead.call(this, file, ...args);
    if (!halted && String(file).startsWith(f.dataDir) && path.basename(String(file)) === "manifest.json") {
      halted = true; await f.api.halt("COLLECTOR_PROVIDER_BLOCKED", { cancelActive: true });
    }
    return result;
  };
  try {
    await assert.rejects(f.run(), { code: "COLLECTOR_PROVIDER_BLOCKED" });
    assert.equal(halted, true); assert.deepEqual(await fs.readdir(f.outputsDir).catch(() => []), []);
  } finally { fs.readFile = originalRead; }
});

test("historical booking IDs use the crawler array contract and run stamp records the observation day", async t => {
  let checked = false;
  const f = await fixture(t, { execute: async ({ args, config, close }) => {
    const context = JSON.parse(await fs.readFile(config.env.HISTORY_BOOKING_BUSINESS_CONTEXT_FILE, "utf8"));
    assert.deepEqual(context, [{ placeId: "1104404759", businessId: "1040638" }]);
    assert.equal(config.env.RUN_STAMP.slice(0, 8), new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10).replaceAll("-", ""));
    assert.equal(config.env.CHECK_IN, "2030-01-05"); checked = true;
    await artifacts(config.env, args[1]); close();
  } });
  await f.run({ env: { ...requestEnv, CHECK_IN: "2030-01-05", CHECK_OUT: "2030-01-06" },
    context: { historicalBookingBusinesses: [{ placeId: "1104404759", businessId: "1040638" }] } });
  assert.equal(checked, true); assert.deepEqual(f.errors, []);
});
