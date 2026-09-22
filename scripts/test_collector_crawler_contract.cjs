"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { inspectManifest, allowsDerivedUpdates } = require("./daily_collection_quality.cjs");

const source = fs.readFileSync(path.join(__dirname, "gyeongnam_glamping_crawl.cjs"), "utf8");
const entryPoint = source.lastIndexOf("\nmain().catch(");
assert.ok(entryPoint > 0);
const root = path.resolve(os.tmpdir(), "collector-contract-virtual");
const contextFile = path.join(root, "booking-context.json");

function harness(options = {}) {
  const writes = new Map();
  const logs = [];
  const files = options.files || new Map();
  const fsMock = {
    readFile: async file => { if (!files.has(file)) throw new Error("fixture_missing"); return files.get(file); },
    readdir: options.readdir || (async () => { throw new Error("fixture_missing"); }),
    mkdir: async () => {},
    writeFile: async (file, value) => { writes.set(file, value); },
  };
  const processMock = { env: { CHECK_IN: "2026-09-22", CHECK_OUT: "2026-09-23", OUTPUTS_DIR: root, ...options.env }, argv: ["node", "crawler", "경남글램핑"] };
  const context = {
    process: processMock,
    console: { log: (...args) => logs.push(args.join(" ")), error: (...args) => logs.push(args.join(" ")) },
    fetch: options.fetchImpl || (async () => { throw new Error("unexpected_external_request"); }),
    setTimeout, clearTimeout, URL, Response, TextDecoder,
    require: name => {
      if (name === "node:fs/promises") return fsMock;
      if (name === "xlsx") return {};
      return require(name);
    },
  };
  const setup = source.slice(0, entryPoint);
  if (options.runFailure) {
    const script = `${setup}\nmain = async () => { await fetch('https://m.booking.naver.com/graphql'); throw new Error('fixture-sensitive-body'); };${source.slice(entryPoint)}`;
    return { completion: vm.runInNewContext(script, context), writes, logs, process: processMock };
  }
  const exports = vm.runInNewContext(`${setup}\n({
    loadHistoricalNaverBookingBusinessMap, getHistoricalNaverBookingBusiness, getNaverDailySchedule,
    addCollectionDiagnostics, diagnostics: scheduledCollectionDiagnostics,
    profile: COLLECTION_PROFILE,
    concurrency: [NAVER_BOOKING_DETAIL_CONCURRENCY, NAVER_SCHEDULE_CONCURRENCY, NAVER_OTA_OBSERVATION_CONCURRENCY],
  })`, context);
  return { ...exports, writes, logs, process: processMock };
}

function manifestFixture() {
  return {
    workerCollection: true, collectionMode: "precision", collectionPurpose: "revenue_detail",
    collectionProfileFlags: { collectBookingStock: true, collectWeeklyRange: true },
    naverAttemptedQueries: [{ status: 200 }],
    counts: {
      naverOverall: 5, naverBookingStockEligible: 2, naverBookingStockChecked: 2, naverBookingStockSucceeded: 2,
      naverOtaObservationChecked: 2, naverOtaBlocked: 0, naverOtaFailed: 0,
      naverScheduleRequested: 2, naverScheduleSucceeded: 2, naverScheduleFailed: 0, naverScheduleBlocked: 0,
    },
  };
}

test("worker uses low-load detail/schedule/OTA defaults and preserves explicit job profile", () => {
  assert.deepEqual(Array.from(harness().concurrency), [2, 4, 2]);
  assert.deepEqual(Array.from(harness({ env: { COLLECTOR_WORKER_RUNTIME: "1" } }).concurrency), [1, 2, 1]);
  const explicit = harness({ env: { COLLECTOR_WORKER_RUNTIME: "1", NAVER_BOOKING_DETAIL_CONCURRENCY: "2", NAVER_SCHEDULE_CONCURRENCY: "4", NAVER_OTA_OBSERVATION_CONCURRENCY: "2", COLLECTION_PURPOSE: "basic_db" } });
  assert.deepEqual(Array.from(explicit.concurrency), [2, 4, 2]);
  assert.equal(explicit.profile.collectBookingStock, true);
  assert.equal(explicit.profile.collectWeeklyRange, false);
});

test("transferred historical identifiers survive absent worker history and local CSV history retains precedence", async () => {
  const files = new Map([[contextFile, '\uFEFF[{"placeId":"123","businessId":"456"},{"placeId":"789","businessId":"987"}]']]);
  const seeded = harness({ env: { HISTORY_BOOKING_BUSINESS_CONTEXT_FILE: contextFile }, files });
  assert.equal((await seeded.getHistoricalNaverBookingBusiness("123")).bookingBusinessId, "456");
  assert.equal((await seeded.getHistoricalNaverBookingBusiness("789")).sourceRun, "worker-context");
  assert.equal(await seeded.getHistoricalNaverBookingBusiness("999"), null);

  const csvName = "fixture_네이버전체순위.csv";
  files.set(path.join(root, "history", csvName), "place_id,네이버예약사업자ID\n123,654\n");
  const merged = harness({ env: { HISTORY_BOOKING_BUSINESS_CONTEXT_FILE: contextFile }, files,
    readdir: async (_file, options) => options?.withFileTypes ? [{ name: "history", isDirectory: () => true }] : [csvName],
  });
  assert.equal((await merged.getHistoricalNaverBookingBusiness("123")).bookingBusinessId, "654");
  assert.equal((await merged.getHistoricalNaverBookingBusiness("789")).bookingBusinessId, "987");
});

test("malformed context fails with a constant safe error and fallback opt-out preserves local behavior", async () => {
  for (const body of ["private-invalid-json", "{}", '[{"placeId":"123","businessId":"456","token":"private"}]', '[{"placeId":"123","businessId":456}]', '[{"placeId":"123","businessId":"https://private"}]', '[{"placeId":"123","businessId":"456"},{"placeId":"123","businessId":"789"}]']) {
    const crawler = harness({ env: { HISTORY_BOOKING_BUSINESS_CONTEXT_FILE: contextFile }, files: new Map([[contextFile, body]]) });
    await assert.rejects(crawler.loadHistoricalNaverBookingBusinessMap(), error => error.message === "HISTORY_BOOKING_CONTEXT_INVALID" && error.code === "HISTORY_BOOKING_CONTEXT_INVALID");
    assert.deepEqual(crawler.logs, []);
  }
  const disabled = harness({ env: { HISTORY_BOOKING_BUSINESS_CONTEXT_FILE: contextFile, NAVER_BOOKING_ID_FALLBACK: "0" } });
  assert.equal((await disabled.loadHistoricalNaverBookingBusinessMap()).size, 0);
  assert.equal((await harness().loadHistoricalNaverBookingBusinessMap()).size, 0);
});

test("manual worker counts successful schedules and records worker marker without scheduled marker", async () => {
  const crawler = harness({ env: { COLLECTOR_WORKER_RUNTIME: "1", NAVER_REQUEST_MIN_INTERVAL_MS: "0" }, fetchImpl: async () => new Response(JSON.stringify({ data: { schedule: { bizItemSchedule: { daily: { date: { "2026-09-22": { stock: 0 } } } } } } })) });
  await crawler.getNaverDailySchedule("123", "456");
  const manifest = manifestFixture();
  crawler.addCollectionDiagnostics(manifest);
  assert.equal(manifest.workerCollection, true);
  assert.equal(manifest.scheduledCollection, undefined);
  assert.equal(manifest.counts.naverScheduleRequested, 1);
  assert.equal(manifest.counts.naverScheduleSucceeded, 1);
  assert.equal(manifest.requestPacing.enabled, true);
  assert.equal(manifest.collectionQuality.status, "complete");
});

test("manual worker HTTP 200 throttling stops subsequent schedules and prevents derived updates", async () => {
  let calls = 0;
  const crawler = harness({ env: { COLLECTOR_WORKER_RUNTIME: "1", NAVER_REQUEST_MIN_INTERVAL_MS: "0" }, fetchImpl: async () => {
    calls++;
    return new Response(JSON.stringify({ errors: [{ message: "fixture-sensitive-body", extensions: { code: "BookingAPITooManyRequests" } }] }));
  } });
  await assert.rejects(crawler.getNaverDailySchedule("123", "456"), /NAVER_SCHEDULE_BLOCKED/);
  await assert.rejects(crawler.getNaverDailySchedule("123", "456"), /NAVER_SCHEDULE_BLOCKED/);
  assert.equal(calls, 1);
  const manifest = manifestFixture();
  crawler.addCollectionDiagnostics(manifest);
  assert.equal(manifest.counts.naverScheduleRequested, 1);
  assert.equal(manifest.counts.naverScheduleFailed, 1);
  assert.equal(manifest.counts.naverScheduleBlocked, 1);
  assert.equal(manifest.requestPacing.blockedStatus, 200);
  assert.equal(manifest.requestPacing.blockedCode, "BookingAPITooManyRequests");
  assert.equal(manifest.collectionQuality.status, "blocked");
  assert.equal(allowsDerivedUpdates(manifest), false);
  assert.doesNotMatch(JSON.stringify(manifest), /fixture-sensitive-body/);
});

test("worker quality accepts intentional fast/basic zero targets but rejects missing or partial detail evidence", () => {
  for (const purpose of ["fast", "basic_db"]) {
    const manifest = manifestFixture();
    manifest.collectionMode = purpose === "fast" ? "fast" : "precision";
    manifest.collectionPurpose = purpose === "fast" ? "revenue_detail" : purpose;
    manifest.collectionProfileFlags = { collectBookingStock: purpose !== "fast", collectWeeklyRange: false };
    Object.assign(manifest.counts, { naverBookingStockEligible: 0, naverBookingStockChecked: 0, naverBookingStockSucceeded: 0, naverScheduleRequested: 0, naverScheduleSucceeded: 0 });
    assert.equal(inspectManifest(manifest).status, "complete");
    assert.equal(allowsDerivedUpdates(manifest), true);
    if (purpose === "basic_db") {
      manifest.counts.naverBookingStockEligible = 2;
      assert.equal(inspectManifest(manifest).status, "failed");
      assert.equal(allowsDerivedUpdates(manifest), false);
    }
  }
  const partial = manifestFixture();
  partial.counts.naverScheduleSucceeded = 1;
  partial.counts.naverScheduleFailed = 1;
  partial.collectionQuality = { status: "complete" };
  assert.equal(inspectManifest(partial).status, "partial");
  assert.equal(allowsDerivedUpdates(partial), false);
  const missing = manifestFixture(); delete missing.collectionProfileFlags;
  assert.equal(inspectManifest(missing).reason, "collection_profile_missing");
  const missingCounters = manifestFixture(); delete missingCounters.counts.naverScheduleRequested;
  assert.equal(inspectManifest(missingCounters).status, "partial");
  const scheduled = manifestFixture(); scheduled.scheduledCollection = true;
  scheduled.counts.naverBookingStockChecked = 0;
  assert.equal(inspectManifest(scheduled).status, "failed");
});

test("main-stage block writes a safe failure manifest before worker exit", async () => {
  const crawler = harness({ runFailure: true, env: { COLLECTOR_WORKER_RUNTIME: "1", NAVER_REQUEST_MIN_INTERVAL_MS: "0" },
    readdir: async () => [],
    fetchImpl: async () => new Response(JSON.stringify({ errors: [{ extensions: { code: "BookingAPITooManyRequests" }, message: "fixture-sensitive-body" }] })),
  });
  await crawler.completion;
  assert.equal(crawler.process.exitCode, 1);
  const saved = Array.from(crawler.writes.values());
  assert.equal(saved.length, 1);
  const manifest = JSON.parse(saved[0]);
  assert.equal(manifest.workerCollection, true);
  assert.equal(manifest.collectionQuality.status, "blocked");
  assert.equal(manifest.collectionFailed, true);
  assert.equal(manifest.checkIn, "2026-09-22");
  assert.ok(Array.isArray(manifest.files));
  assert.equal(manifest.sourceRole, "admin");
  assert.equal(manifest.requestPacing.blockedCode, "BookingAPITooManyRequests");
  assert.doesNotMatch(saved[0] + crawler.logs.join(" "), /fixture-sensitive-body/);
});
