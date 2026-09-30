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
  const processMock = { env: { CHECK_IN: "2026-09-22", CHECK_OUT: "2026-09-23", OUTPUTS_DIR: root, ...options.env }, argv: ["node", "crawler", options.keyword || "경남글램핑"] };
  const context = {
    process: processMock,
    console: { log: (...args) => logs.push(args.join(" ")), error: (...args) => logs.push(args.join(" ")) },
    fetch: options.fetchImpl || (async () => { throw new Error("unexpected_external_request"); }),
    setTimeout, clearTimeout, URL, Response, TextDecoder, Buffer,
    require: name => {
      if (name === "node:fs/promises") return fsMock;
      if (name === "xlsx") return {};
      return require(name);
    },
  };
  const setup = source.slice(0, entryPoint);
  if (options.runMainFailure) return { completion: vm.runInNewContext(source, context), writes, logs, process: processMock };
  if (options.runFailure) {
    const script = `${setup}\nmain = async () => { await fetch('https://m.booking.naver.com/graphql'); throw new Error('fixture-sensitive-body'); };${source.slice(entryPoint)}`;
    return { completion: vm.runInNewContext(script, context), writes, logs, process: processMock };
  }
  const exports = vm.runInNewContext(`${setup}\n${options.setup || ""}\n({
    loadHistoricalNaverBookingBusinessMap, getHistoricalNaverBookingBusiness, getNaverDailySchedule,
    addCollectionDiagnostics, diagnostics: scheduledCollectionDiagnostics,
    collectNaverSchedulesForItems, collectWeeklyNaverAvailability, collectNaverBookingAvailability, compactNaverScheduleDetail, productCoverage, outputDir: OUTPUT_DIR,
    profile: COLLECTION_PROFILE, searchRegion: SEARCH_REGION, collectNaverMain,
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

test("worker restores historical stage pools and preserves explicit low-load job profiles", () => {
  assert.deepEqual(Array.from(harness().concurrency), [2, 4, 2]);
  assert.deepEqual(Array.from(harness({ env: { COLLECTOR_WORKER_RUNTIME: "1" } }).concurrency), [2, 4, 2]);
  assert.deepEqual(Array.from(harness({ env: { COLLECTOR_WORKER_RUNTIME: "1", NAVER_REQUEST_PACING_ENABLED: "0" } }).concurrency), [2, 4, 2]);
  assert.deepEqual(Array.from(harness({ env: { COLLECTOR_WORKER_RUNTIME: "1", NAVER_REQUEST_PACING_ENABLED: "1" } }).concurrency), [1, 2, 1]);
  const explicit = harness({ env: { COLLECTOR_WORKER_RUNTIME: "1", NAVER_BOOKING_DETAIL_CONCURRENCY: "2", NAVER_SCHEDULE_CONCURRENCY: "4", NAVER_OTA_OBSERVATION_CONCURRENCY: "2", COLLECTION_PURPOSE: "basic_db" } });
  assert.deepEqual(Array.from(explicit.concurrency), [2, 4, 2]);
  assert.equal(explicit.profile.collectBookingStock, true);
  assert.equal(explicit.profile.collectWeeklyRange, false);
});

test("real booking path preserves seven lodging dates and only queries day-use dates for detail", async () => {
  for (const mode of ["inspect", "lodging_only", "detail"]) {
    const called = [];
    const crawler = harness({ env: { COLLECTOR_WORKER_RUNTIME: "1", DAY_USE_MODE: mode, BOOKING_RANGE_DAYS: "7",
      NAVER_SCHEDULE_DELAY_MS: "0", NAVER_COUPON_PAGE_FALLBACK: "0" },
      setup: 'getNaverBookingBusiness = async () => ({bookingBusinessId:"123",bookingUrl:"fixture"});',
      fetchImpl: async (_url, init) => {
        const query = JSON.parse(init.body);
        if (query.operationName === "searchBizItem") return new Response(JSON.stringify({ data: { searchBizItem: { bizItems: [
          { bizItemId: "night", name: "숙박", bizItemSubType: "ACCOMMODATION_NIGHT" },
          { bizItemId: "day", name: "데이유즈", bizItemSubType: "ACCOMMODATION_DAY_USE" }
        ] } } }));
        assert.equal(query.operationName, "dailySchedule");
        const params = query.variables.scheduleParams; called.push(params);
        const date = params.startDateTime.slice(0, 10);
        return new Response(JSON.stringify({ data: { schedule: { bizItemSchedule: { daily: { date: {
          [date]: { stock: 10, bookingCount: 1, occupiedBookingCount: 0, price: 100000 }
        } } } } } }));
      }
    });
    const result = await crawler.collectNaverBookingAvailability("456", new Map(), { collectRange: true });
    assert.equal(called.filter(row => row.bizItemId === "night").length, 7, mode);
    assert.equal(called.filter(row => row.bizItemId === "day").length, mode === "detail" ? 7 : 0, mode);
    assert.equal(result.dayUsePresence, "present");
    assert.equal(result.dayUseSharingStatus, "unconfirmed");
    assert.equal(result.weekly.dates.length, 7);
    if (mode !== "detail") { assert.equal(result.dayUseTotalStock, null); assert.equal(result.dayUseEstimatedRevenue, null); }
    const manifest = manifestFixture();
    manifest.counts.naverBookingStockEligible = manifest.counts.naverBookingStockChecked = manifest.counts.naverBookingStockSucceeded = 1;
    crawler.addCollectionDiagnostics(manifest);
    assert.equal(manifest.collectionQuality.status, "complete", JSON.stringify(manifest.collectionQuality));
    assert.equal(manifest.dayUseMode, mode);
  }
});

test("basic collection never adds day-use schedule requests even when detail is selected", async () => {
  const called = [];
  const crawler = harness({ env: { COLLECTOR_WORKER_RUNTIME: "1", DAY_USE_MODE: "detail", COLLECTION_PURPOSE: "basic_db", NAVER_COUPON_PAGE_FALLBACK: "0" },
    setup: 'getNaverBookingBusiness = async () => ({bookingBusinessId:"123",bookingUrl:"fixture"});',
    fetchImpl: async (_url, init) => {
      const query = JSON.parse(init.body);
      if (query.operationName === "searchBizItem") return new Response(JSON.stringify({ data: { searchBizItem: { bizItems: [
        { bizItemId: "night", name: "숙박", bizItemSubType: "ACCOMMODATION_NIGHT" },
        { bizItemId: "day", name: "데이유즈", bizItemSubType: "ACCOMMODATION_DAY_USE" }
      ] } } }));
      const params = query.variables.scheduleParams; called.push(params.bizItemId);
      return new Response(JSON.stringify({ data: { schedule: { bizItemSchedule: { daily: { date: {
        "2026-09-22": { stock: 0, bookingCount: 0, occupiedBookingCount: 0 }
      } } } } } }));
    }
  });
  const result = await crawler.collectNaverBookingAvailability("456", new Map());
  assert.deepEqual(called, ["night"]);
  assert.equal(result.dayUsePresence, "present");
  assert.equal(result.dayUseScheduleStatus, "not_requested_basic");
  assert.equal(result.dayUseTotalStock, null);
});

test("real lodging path queries all 68 or 85 unique products on the first and subsequent dates and retains every detail", async () => {
  for (const productCount of [68, 85]) {
    const products = Array.from({ length: productCount }, (_, index) => ({
      bizItemId: String(index), name: "숙박 상품", bizItemSubType: "ACCOMMODATION_NIGHT",
    }));
    const called = [];
    const dates = ["2026-09-22", "2026-09-23", "2026-09-24"];
    const crawler = harness({
      env: { COLLECTOR_WORKER_RUNTIME: "1", DAY_USE_MODE: "inspect", BOOKING_RANGE_DAYS: "3",
        NAVER_SCHEDULE_DELAY_MS: "0", NAVER_COUPON_PAGE_FALLBACK: "0" },
      setup: 'getNaverBookingBusiness = async () => ({bookingBusinessId:"123",bookingUrl:"fixture"});',
      fetchImpl: async (_url, init) => {
        const query = JSON.parse(init.body);
        if (query.operationName === "searchBizItem") return new Response(JSON.stringify({ data: {
          searchBizItem: { bizItems: [...products, { ...products[0] }, { ...products[productCount - 1] }] },
        } }));
        assert.equal(query.operationName, "dailySchedule");
        const params = query.variables.scheduleParams;
        const date = params.startDateTime.slice(0, 10);
        called.push({ date, id: params.bizItemId });
        return new Response(JSON.stringify({ data: { schedule: { bizItemSchedule: { daily: { date: {
          [date]: { stock: 1, bookingCount: 0, occupiedBookingCount: 0, price: 100000 },
        } } } } } }));
      },
    });
    const result = await crawler.collectNaverBookingAvailability("456", new Map(), { collectRange: true });
    assert.equal(called.length, productCount * dates.length);
    assert.equal(result.itemDetails.length, productCount);
    assert.equal(result.weekly.productDetails.length, productCount * dates.length);
    for (const date of dates) {
      const ids = called.filter(row => row.date === date).map(row => row.id).sort();
      assert.deepEqual(ids, products.map(row => row.bizItemId).sort());
      assert.equal(result.weekly.dates.find(row => row.date === date).productDetails.length, productCount);
    }
    const coverage = crawler.productCoverage.snapshot();
    assert.equal(coverage.discovered, productCount);
    assert.equal(coverage.queried, productCount);
    assert.equal(coverage.truncated, 0);
    assert.equal(result.collectionProductCoverage.businessId, "123");
    assert.equal(result.collectionProductCoverage.eligible, productCount);
    for (const day of coverage.targets[0].days) {
      assert.equal(day.queried, productCount);
      assert.equal(day.succeeded, productCount);
      assert.equal(day.failed, 0);
      assert.equal(day.truncated, 0);
    }
    const manifest = manifestFixture();
    manifest.counts.naverBookingStockEligible = manifest.counts.naverBookingStockChecked = manifest.counts.naverBookingStockSucceeded = 1;
    crawler.addCollectionDiagnostics(manifest);
    assert.equal(manifest.collectionQuality.status, "complete", JSON.stringify(manifest.collectionQuality));
  }
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
  crawler.productCoverage.discover("123", [{ bizItemId: "456" }], [{ bizItemId: "456" }], ["2026-09-22"]);
  crawler.productCoverage.record("123", [{ bizItemId: "456" }], 40, "2026-09-22", [{ bizItemId: "456", stock: 0 }]);
  const manifest = manifestFixture();
  crawler.addCollectionDiagnostics(manifest);
  assert.equal(manifest.workerCollection, true);
  assert.equal(manifest.scheduledCollection, undefined);
  assert.equal(manifest.counts.naverScheduleRequested, 1);
  assert.equal(manifest.counts.naverScheduleSucceeded, 1);
  assert.equal(manifest.requestPacing.enabled, false);
  assert.equal(manifest.requestPacing.guardEnabled, true);
  assert.equal(manifest.requestPacing.minIntervalMs, 0);
  assert.equal(manifest.requestPacing.maxConcurrentRequests, null);
  assert.equal(manifest.collectionQuality.status, "complete");
});

test("job-derived alphabetic prefixes preserve the legacy suffix and real collection timestamps", () => {
  const before = Date.now();
  const crawler = harness({ env: { COLLECTOR_WORKER_RUNTIME: "1", COLLECTOR_WORKER_KEY: "scheduled", COLLECTOR_TRIGGER: "manual",
    COLLECTOR_RUN_TOKEN: "abcdefghijklmnopabcdefgh", COLLECTOR_JOB_ID: "collector_fixture", COLLECTOR_ENGINE: "archive-keyword-adapted-v2" } });
  const runId = path.basename(crawler.outputDir);
  assert.match(runId, /^gyeongnam_scheduled_[a-p]{24}_glamping_20260922_\d{6}$/);
  assert.match(runId, /_glamping_\d{8}(?:_\d{6})?$/);
  assert.equal(runId.match(/\d{8}/)[0], "20260922");
  const manifest = manifestFixture(); crawler.addCollectionDiagnostics(manifest);
  assert.equal(manifest.workerKey, "scheduled");
  assert.equal(manifest.trigger, "manual");
  assert.equal(manifest.jobId, "collector_fixture");
  assert.equal(manifest.collectorEngine, "archive-keyword-adapted-v2");
  assert.ok(Date.parse(manifest.startedAt) >= before && Date.parse(manifest.startedAt) <= Date.now());
  assert.throws(() => harness({ env: { COLLECTOR_RUN_TOKEN: "20260101" } }), /COLLECTOR_RUN_TOKEN_INVALID/);
});

test("operating web collection preserves basic speed, role identity and complete quality evidence", async () => {
  const token = "abcdefghijklmnopabcdefgh";
  const crawler = harness({ env: { COLLECTOR_WEB_RUNTIME: "1", NAVER_REQUEST_PACING_ENABLED: "0",
    COLLECTOR_RUN_TOKEN: token, COLLECTOR_JOB_ID: "collector_web_fixture", RENDER_SERVICE_ID: "srv-web-fixture" },
    fetchImpl: async () => new Response(JSON.stringify({ data: { schedule: { bizItemSchedule: { daily: { date: { "2026-09-22": { stock: 0 } } } } } } })),
  });
  assert.deepEqual(Array.from(crawler.concurrency), [2, 4, 2]);
  assert.match(path.basename(crawler.outputDir), /^gyeongnam_web_[a-p]{24}_glamping_20260922_\d{6}$/);
  await crawler.getNaverDailySchedule("123", "456");
  crawler.productCoverage.discover("123", [{ bizItemId: "456" }], [{ bizItemId: "456" }], ["2026-09-22"]);
  crawler.productCoverage.record("123", [{ bizItemId: "456" }], 40, "2026-09-22", [{ bizItemId: "456", stock: 0 }]);
  const manifest = manifestFixture();
  delete manifest.workerCollection;
  crawler.addCollectionDiagnostics(manifest);
  assert.equal(manifest.webCollection, true);
  assert.equal(manifest.workerCollection, undefined);
  assert.equal(manifest.scheduledCollection, undefined);
  assert.equal(manifest.executionHost.role, "operating_web");
  assert.equal(manifest.executionHost.serviceId, "srv-web-fixture");
  assert.equal(manifest.workerKey, "web");
  assert.equal(manifest.trigger, "manual");
  assert.equal(manifest.collectorRunToken, token);
  assert.equal(manifest.jobId, "collector_web_fixture");
  assert.equal(manifest.collectorEngine, "operating-web-v2");
  assert.equal(manifest.counts.naverScheduleRequested, 1);
  assert.equal(manifest.counts.naverScheduleSucceeded, 1);
  assert.equal(manifest.requestPacing.pacingEnabled, false);
  assert.equal(manifest.requestPacing.guardEnabled, true);
  assert.equal(manifest.requestPacing.minIntervalMs, 0);
  assert.equal(manifest.requestPacing.maxConcurrentRequests, null);
  assert.equal(manifest.collectionQuality.status, "complete");
  assert.equal(allowsDerivedUpdates(manifest), true);
});

test("web role rejects worker, schedule and engine identity mismatches before any request", () => {
  for (const env of [
    { COLLECTOR_WEB_RUNTIME: "1", COLLECTOR_WORKER_RUNTIME: "1" },
    { COLLECTOR_WEB_RUNTIME: "1", SCHEDULED_COLLECTION: "1" },
    { COLLECTOR_WEB_RUNTIME: "1", COLLECTOR_WORKER_KEY: "manual" },
    { COLLECTOR_WEB_RUNTIME: "1", COLLECTOR_TRIGGER: "scheduled" },
    { COLLECTOR_WEB_RUNTIME: "1", COLLECTOR_ENGINE: "archive-keyword-adapted-v2" },
    { COLLECTOR_WORKER_KEY: "web" },
  ]) assert.throws(() => harness({ env }), /COLLECTOR_ROLE_MISMATCH/);
});

test("web main-stage standalone captcha preserves a blocked receipt without a worker or scheduled marker", async () => {
  let calls = 0;
  const crawler = harness({ runFailure: true, env: { COLLECTOR_WEB_RUNTIME: "1", COLLECTOR_JOB_ID: "web-block-fixture" },
    readdir: async () => [],
    fetchImpl: async () => { calls++; return new Response('<html><body><div id="wtm-captcha-root"></div></body></html>'); },
  });
  await crawler.completion;
  const saved = Array.from(crawler.writes.values());
  assert.equal(calls, 1);
  assert.equal(crawler.process.exitCode, 1);
  assert.equal(saved.length, 1);
  const manifest = JSON.parse(saved[0]);
  assert.equal(manifest.webCollection, true);
  assert.equal(manifest.workerCollection, undefined);
  assert.equal(manifest.scheduledCollection, undefined);
  assert.equal(manifest.jobId, "web-block-fixture");
  assert.equal(manifest.executionHost.role, "operating_web");
  assert.equal(manifest.collectionQuality.status, "blocked");
  assert.equal(manifest.requestPacing.blockedCode, "NAVER_CAPTCHA");
  assert.equal(allowsDerivedUpdates(manifest), false);
  assert.doesNotMatch(saved[0] + crawler.logs.join(" "), /wtm-captcha-root|fixture-sensitive-body/);
});

test("real schedule reader preserves zero, missing and failure while coverage records limited products for every date", async () => {
  const items = Array.from({ length: 42 }, (_, index) => ({ bizItemId: String(index), name: `객실 ${index}`, bizItemSubType: "ACCOMMODATION_NIGHT" }));
  const crawler = harness({ env: { COLLECTOR_WORKER_RUNTIME: "1", NAVER_SCHEDULE_DELAY_MS: "0" }, fetchImpl: async (_url, init) => {
    const params = JSON.parse(init.body).variables.scheduleParams;
    const date = params.startDateTime.slice(0, 10);
    const id = Number(params.bizItemId);
    if (id === 2) throw new Error("fixture network failure");
    return new Response(JSON.stringify({ data: { schedule: { bizItemSchedule: { daily: { date: { [date]: { stock: id === 0 ? 0 : id === 1 ? null : 3, bookingCount: 0, occupiedBookingCount: 0 } } } } } } }));
  } });
  crawler.productCoverage.discover("biz", [...items, { bizItemId: "excluded" }], items, ["2026-09-22", "2026-09-23"]);
  const first = await crawler.collectNaverSchedulesForItems("biz", items, 40);
  assert.equal(first.length, 40);
  assert.equal(first[0].stock, 0); assert.equal(first[0].collectionFailed, false);
  assert.equal(first[1].stock, null); assert.equal(first[1].collectionFailed, true);
  assert.equal(first[2].stock, null); assert.equal(first[2].collectionFailed, true);
  await crawler.collectWeeklyNaverAvailability("biz", items, first, 2, "개", 40);
  const coverage = crawler.productCoverage.snapshot();
  assert.equal(coverage.discovered, 43); assert.equal(coverage.eligible, 42); assert.equal(coverage.excluded, 1);
  assert.equal(coverage.queried, 40); assert.equal(coverage.truncated, 2);
  for (const day of coverage.targets[0].days) { assert.equal(day.queried, 40); assert.equal(day.succeeded, 38); assert.equal(day.failed, 2); assert.equal(day.truncated, 2); }
});

test("schedule failure details retain safe evidence without guessing causes or leaking provider text", async () => {
  const secret = "private-token=https://fixture.invalid/path?access_token=do-not-persist";
  const dayBody = (day, errors) => ({ data: { schedule: { bizItemSchedule: { daily: { date: { "2026-09-22": day } } } } }, errors });
  const cases = [
    { name: "normal zero", body: dayBody({ stock: 0, bookingCount: 0 }), status: 200, code: "", failed: false },
    { name: "timeout name", error: Object.assign(new Error(secret), { name: "TimeoutError" }), status: 0, code: "TIMEOUT" },
    { name: "timeout cause", error: new TypeError("fetch failed", { cause: { code: "UND_ERR_HEADERS_TIMEOUT", message: secret } }), status: 0, code: "TIMEOUT" },
    { name: "network cause", error: new TypeError("fetch failed", { cause: { code: "ECONNRESET", message: secret } }), status: 0, code: "NETWORK_ERROR" },
    { name: "http response", body: { message: secret }, status: 503, code: "HTTP_ERROR" },
    { name: "graphql response", body: dayBody({ stock: 2 }, [{ message: secret, extensions: { code: "INTERNAL_SERVER_ERROR" } }]), status: 200, code: "GRAPHQL_ERROR" },
    { name: "missing schedule", body: dayBody(null), status: 200, code: "MISSING_SCHEDULE" },
    { name: "invalid stock", body: dayBody({ stock: "unavailable" }), status: 200, code: "INVALID_STOCK" },
    { name: "unknown error", error: new Error(secret), status: 0, code: "UNKNOWN_ERROR" },
    { name: "abort is not proof of timeout", error: Object.assign(new Error(secret), { name: "AbortError" }), status: 0, code: "UNKNOWN_ERROR" },
    { name: "http block", body: { message: secret }, status: 429, code: "PROVIDER_BLOCKED" },
    { name: "http200 throttle", body: { errors: [{ message: secret, extensions: { code: "BookingAPITooManyRequests" } }] }, status: 200, code: "PROVIDER_BLOCKED" },
  ];
  for (const fixture of cases) {
    let requests = 0;
    const crawler = harness({ env: { COLLECTOR_WORKER_RUNTIME: "1", NAVER_SCHEDULE_DELAY_MS: "0" }, fetchImpl: async () => {
      requests++;
      if (fixture.error) throw fixture.error;
      return new Response(JSON.stringify(fixture.body), { status: fixture.status });
    } });
    const [row] = await crawler.collectNaverSchedulesForItems("fixture-business", [{ bizItemId: "fixture-product", name: "객실", bizItemSubType: "ACCOMMODATION_NIGHT" }], 40);
    const detail = crawler.compactNaverScheduleDetail(row, "객실 종류별 리스트", "2026-09-22");
    assert.equal(requests, 1, fixture.name);
    assert.equal(detail.collectionErrorCode, fixture.code, fixture.name);
    assert.equal(detail.responseStatus, fixture.status, fixture.name);
    assert.equal(detail.collectionPhase, "booking_schedule", fixture.name);
    assert.equal(detail.collectionFailed, fixture.failed !== false, fixture.name);
    assert.equal(row.queryAttempted, true, fixture.name);
    assert.doesNotMatch(JSON.stringify(detail), /private-token|access_token|do-not-persist|fixture\.invalid|INTERNAL_SERVER_ERROR/, fixture.name);
  }
});

test("compact schedule diagnostics accept only the diagnostic vocabulary and real HTTP statuses", () => {
  const crawler = harness();
  const input = { bizItemId: "p", name: "객실", stock: null, collectionFailed: true,
    collectionErrorCode: "https://fixture.invalid/?token=secret", responseStatus: 999,
    collectionPhase: "private-query", error: "secret", errors: [{ message: "private-response" }] };
  const detail = crawler.compactNaverScheduleDetail(input, "객실 종류별 리스트", "2026-09-22");
  assert.equal(detail.collectionErrorCode, "");
  assert.equal(detail.responseStatus, 0);
  assert.equal(detail.collectionPhase, "booking_schedule");
  assert.doesNotMatch(JSON.stringify(detail), /fixture\.invalid|secret|private-query|private-response/);
  const legacy = crawler.compactNaverScheduleDetail({ bizItemId: "p", collectionFailed: true });
  assert.equal(legacy.collectionErrorCode, "", "old unrecorded failures must not acquire a guessed cause");
});

test("all three runtimes retain all lodging and day-use products beyond former limits on every date", async () => {
  const products = [
    ...Array.from({ length: 68 }, (_, i) => ({ bizItemId: `night-${i}`, name: `숙박 ${i}`, bizItemSubType: "ACCOMMODATION_NIGHT" })),
    ...Array.from({ length: 85 }, (_, i) => ({ bizItemId: `day-${i}`, name: `데이유즈 ${i}`, bizItemSubType: "ACCOMMODATION_DAY_USE" })),
  ];
  const dates = ["2026-09-22", "2026-09-23", "2026-09-24"];
  for (const runtime of [
    { COLLECTOR_WEB_RUNTIME: "1", COLLECTOR_WORKER_KEY: "web" },
    { COLLECTOR_WORKER_RUNTIME: "1", COLLECTOR_WORKER_KEY: "manual" },
    { COLLECTOR_WORKER_RUNTIME: "1", COLLECTOR_WORKER_KEY: "scheduled", COLLECTOR_TRIGGER: "scheduled", SCHEDULED_COLLECTION: "1" },
  ]) {
    const called = [];
    const crawler = harness({ env: { ...runtime, DAY_USE_MODE: "detail", BOOKING_RANGE_DAYS: "3",
      NAVER_SCHEDULE_DELAY_MS: "0", NAVER_COUPON_PAGE_FALLBACK: "0" },
      setup: 'getNaverBookingBusiness = async () => ({bookingBusinessId:"123",bookingUrl:"fixture"});',
      fetchImpl: async (_url, init) => {
        const query = JSON.parse(init.body);
        if (query.operationName === "searchBizItem") return new Response(JSON.stringify({ data: {
          searchBizItem: { bizItems: [...products, { ...products[0] }, { ...products.at(-1) }] },
        } }));
        assert.equal(query.operationName, "dailySchedule");
        const params = query.variables.scheduleParams, date = params.startDateTime.slice(0, 10);
        called.push({ date, id: params.bizItemId });
        return new Response(JSON.stringify({ data: { schedule: { bizItemSchedule: { daily: { date: {
          [date]: { stock: 1, bookingCount: 0, occupiedBookingCount: 0, price: 100000 },
        } } } } } }));
      },
    });
    const result = await crawler.collectNaverBookingAvailability("456", new Map(), { collectRange: true });
    assert.equal(called.length, 153 * 3, runtime.COLLECTOR_WORKER_KEY);
    assert.equal(result.itemDetails.length, 153);
    assert.equal(result.weekly.productDetails.length, 68 * 3);
    assert.equal(result.dayUseWeekly.productDetails.length, 85 * 3);
    for (const date of dates) {
      assert.deepEqual(called.filter(row => row.date === date).map(row => row.id).sort(), products.map(row => row.bizItemId).sort());
      assert.equal(result.weekly.dates.find(row => row.date === date).productDetails.length, 68);
      assert.equal(result.dayUseWeekly.dates.find(row => row.date === date).productDetails.length, 85);
    }
    const coverage = crawler.productCoverage.snapshot();
    assert.equal(coverage.queried, 153);
    assert.equal(coverage.truncated, 0);
    for (const day of coverage.targets[0].days) {
      assert.equal(day.queried, 153); assert.equal(day.succeeded, 153);
      assert.equal(day.truncated, 0); assert.equal(day.failed, 0);
    }
    assert.ok(result.inventoryEvidence.capacityReview.codes.includes("glamping_observed_over_40"), "large capacity remains a warning, not a collection cap");
    const manifest = manifestFixture();
    manifest.counts.naverBookingStockEligible = manifest.counts.naverBookingStockChecked = manifest.counts.naverBookingStockSucceeded = 1;
    crawler.addCollectionDiagnostics(manifest);
    assert.equal(manifest.collectionQuality.status, "complete", JSON.stringify(manifest.collectionQuality));
  }
});

test("paced captcha cancellation counts only schedules that reached the network", async () => {
  const items = Array.from({ length: 68 }, (_, index) => ({ bizItemId: String(index), name: `객실 ${index}` }));
  let calls = 0;
  const crawler = harness({ env: { COLLECTOR_WORKER_RUNTIME: "1", NAVER_REQUEST_PACING_ENABLED: "1",
    NAVER_REQUEST_MIN_INTERVAL_MS: "0", NAVER_REQUEST_MAX_CONCURRENCY: "1", NAVER_SCHEDULE_CONCURRENCY: "4", NAVER_SCHEDULE_DELAY_MS: "0" },
    fetchImpl: async () => { calls++; return new Response('<title>자동입력 방지</title>'); } });
  crawler.productCoverage.discover("biz", items, items, ["2026-09-22"]);
  const schedules = await crawler.collectNaverSchedulesForItems("biz", items);
  assert.equal(calls, 1);
  assert.equal(schedules.length, 68);
  assert.equal(schedules.filter(row => row.queryAttempted === false).length, 67);
  const coverage = crawler.productCoverage.snapshot();
  assert.equal(coverage.eligible, 68);
  assert.equal(coverage.queried, 1);
  assert.equal(coverage.truncated, 0, "guard cancellation is not a product count limit");
  assert.equal(coverage.targets[0].days[0].queried, 1);
  assert.equal(coverage.targets[0].days[0].failed, 1);
  assert.equal(coverage.targets[0].days[0].succeeded, 0);
  const manifest = manifestFixture();
  crawler.addCollectionDiagnostics(manifest);
  assert.equal(manifest.collectionQuality.status, "blocked");
  assert.equal(allowsDerivedUpdates(manifest), false);
  assert.equal(crawler.logs.filter(line => line === "COLLECTOR_PROVIDER_BLOCKED").length, 1);
});

test("unlimited default-speed lodging stops new requests after a block and later dates remain unqueried", async () => {
  const items = Array.from({ length: 68 }, (_, index) => ({ bizItemId: String(index), name: `객실 ${index}` }));
  let calls = 0;
  const crawler = harness({
    env: { COLLECTOR_WORKER_RUNTIME: "1", NAVER_SCHEDULE_DELAY_MS: "0" },
    fetchImpl: async () => { calls++; return new Response("{}", { status: 429 }); },
  });
  crawler.productCoverage.discover("biz", items, items, ["2026-09-22", "2026-09-23", "2026-09-24"]);
  const first = await crawler.collectNaverSchedulesForItems("biz", items);
  const startedBeforeStop = calls;
  assert.ok(startedBeforeStop > 0 && startedBeforeStop <= crawler.concurrency[1]);
  await crawler.collectWeeklyNaverAvailability("biz", items, first, 3);
  assert.equal(calls, startedBeforeStop, "later dates must not restart blocked requests");
  const coverage = crawler.productCoverage.snapshot();
  assert.equal(coverage.truncated, 0);
  assert.equal(coverage.targets[0].days[0].queried, startedBeforeStop);
  assert.equal(coverage.targets[0].days[0].succeeded, 0);
  for (const day of coverage.targets[0].days.slice(1)) {
    assert.equal(day.queried, 0);
    assert.equal(day.succeeded, 0);
    assert.equal(day.failed, 0, "unstarted requests are not failed network responses");
  }
  const manifest = manifestFixture();
  crawler.addCollectionDiagnostics(manifest);
  assert.equal(manifest.collectionQuality.status, "blocked");
  assert.equal(allowsDerivedUpdates(manifest), false);
});

test("0923 entry selects the maintained archive engine and preserves the authorized trigger", () => {
  const wrapper = fs.readFileSync(path.join(__dirname, "archive_keyword_collector.cjs"), "utf8");
  for (const trigger of ["manual", "scheduled"]) {
    const env = { COLLECTOR_WORKER_KEY: "scheduled", COLLECTOR_TRIGGER: trigger };
    const loaded = [];
    vm.runInNewContext(wrapper, { process: { env }, require: name => loaded.push(name) });
    assert.equal(env.COLLECTOR_ENGINE, "archive-keyword-adapted-v2");
    assert.equal(env.SCHEDULED_COLLECTION, trigger === "scheduled" ? "1" : "0");
    assert.deepEqual(loaded, ["./gyeongnam_glamping_crawl.cjs"]);
  }
  assert.throws(() => vm.runInNewContext(wrapper, { process: { env: { COLLECTOR_WORKER_KEY: "manual", COLLECTOR_TRIGGER: "manual" } }, require: () => assert.fail("must not start") }), /COLLECTOR_ROLE_MISMATCH/);
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

test("explicit empty regions remain empty in every collector while legacy CLI inference is preserved", () => {
  for (const runtime of [{COLLECTOR_WEB_RUNTIME:"1"}, {COLLECTOR_WORKER_RUNTIME:"1"}, {COLLECTOR_WORKER_RUNTIME:"1",COLLECTOR_WORKER_KEY:"scheduled",SCHEDULED_COLLECTION:"1"}]) {
    for (const keyword of ["조천 숙소", "함덕펜션", "제주바블"]) {
      const crawler = harness({ keyword, env: {...runtime, SEARCH_MODE:"keyword",SEARCH_REGION:""} });
      assert.equal(crawler.searchRegion, "", keyword);
    }
    assert.equal(harness({ keyword:"조천 숙소", env:{...runtime, SEARCH_REGION:"조천"} }).searchRegion,"조천");
  }
  assert.equal(harness({ keyword:"조천 숙소" }).searchRegion,"조천");
});

test("company search reads a placeList response and excludes unrelated companies", async () => {
  const key = 'placeList({"input":{"query":"제주바블","display":50}})';
  const state = { ROOT_QUERY: { [key]: { businesses: { total:2,items:[{__ref:"a"},{__ref:"b"}] } } }, a:{id:"123",name:"제주바블",category:"펜션"}, b:{id:"456",name:"다른 펜션",category:"펜션"} };
  let calls=0;
  const crawler=harness({keyword:"제주바블",env:{COLLECTOR_WORKER_RUNTIME:"1",SEARCH_MODE:"company",SEARCH_REGION:""},fetchImpl:async()=>{calls++;return new Response(`window.__APOLLO_STATE__ = ${JSON.stringify(state)};`);}});
  const result=await crawler.collectNaverMain();
  assert.equal(calls,1); assert.equal(result.overall.length,1); assert.equal(result.overall[0].업체명,"제주바블");
  assert.equal(result.attemptedQueries[0].searchType,"placeList"); assert.equal(result.attemptedQueries[0].filteredOut,1);
});

test("actual first-search failures retain safe codes, stage, HTTP status and region without raw bodies", async () => {
  for (const [body,status,code] of [
    ["private-response-body",200,"NAVER_SEARCH_STATE_MISSING"],
    ['window.__APOLLO_STATE__ = {broken}',200,"NAVER_SEARCH_STATE_INVALID"],
    ['window.__APOLLO_STATE__ = {"ROOT_QUERY":{}};',200,"NAVER_SEARCH_RESULT_UNSUPPORTED"],
    ["private-response-body",503,"NAVER_SEARCH_HTTP_ERROR"]
  ]) {
    let calls=0;
    const crawler=harness({keyword:"제주바블",runMainFailure:true,readdir:async()=>[],env:{COLLECTOR_WEB_RUNTIME:"1",SEARCH_MODE:"keyword",SEARCH_REGION:""},fetchImpl:async()=>{calls++; return new Response(body,{status});}});
    await crawler.completion;
    const json=[...crawler.writes.entries()].find(([file])=>path.basename(file)==="manifest.json")?.[1];
    assert.ok(json); const manifest=JSON.parse(json);
    assert.equal(calls,1); assert.equal(manifest.searchRegion,""); assert.equal(manifest.collectionQuality.status,"failed");
    assert.deepEqual(manifest.collectionQuality.failure,{code,phase:"naver_main",httpStatus:status});
    assert.equal(manifest.naverAttemptedQueries.length,1); assert.equal(manifest.naverAttemptedQueries[0].status,status);
    assert.equal(manifest.requestPacing.stopped,false); assert.equal(allowsDerivedUpdates(manifest),false);
    assert.doesNotMatch(json,/private-response-body|broken|stack/);
  }
});
