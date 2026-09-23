const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const { inspectManifest, inspectResult, allowsDerivedUpdates } = require("./daily_collection_quality.cjs");
const { isNaverBookingRateLimit } = require("./naver_request_pacing.cjs");

function fixture() {
  return {
    scheduledCollection: true,
    keyword: "포천글램핑", collectionMode: "precision", collectionPurpose: "revenue_detail", productMode: "all",
    checkIn: "2026-09-20", checkOut: "2026-10-20", bookingRangeDays: 31, detailRankRanges: "1-20",
    naverAttemptedQueries: [{ status: 200 }],
    counts: {
      naverOverall: 7, naverBookingStockChecked: 3, naverBookingStockSucceeded: 3,
      naverOtaObservationChecked: 7, naverOtaBlocked: 0, naverOtaFailed: 0,
      naverScheduleRequested: 620, naverScheduleSucceeded: 620, naverScheduleFailed: 0, naverScheduleBlocked: 0
    }
  };
}

test("available result count below requested top twenty can pass", () => {
  assert.equal(inspectManifest(fixture(), { expected: { keyword: "포천 글램핑", bookingDays: 31, detailRankRanges: "1-20" } }).status, "complete");
});

test("zero main results or zero successful bookings is a failed collection", () => {
  for (const key of ["naverOverall", "naverBookingStockChecked", "naverBookingStockSucceeded"]) {
    const manifest = fixture(); manifest.counts[key] = 0;
    assert.equal(inspectManifest(manifest).status, "failed", key);
  }
});

test("missing counts remain unknown rather than converting into observed zero", () => {
  for (const value of [undefined, null, "", " ", false, [], {}, -1, 1.2]) {
    const manifest = fixture(); manifest.counts.naverOtaBlocked = value;
    const result = inspectManifest(manifest);
    assert.equal(result.status, "partial");
    assert.equal(result.reason, "quality_metadata_missing");
    assert.equal(result.counts.naverOtaBlocked, null);
  }
  const manifest = fixture(); delete manifest.naverAttemptedQueries;
  assert.equal(inspectManifest(manifest).status, "partial");
});

test("partial booking failures and auxiliary OTA blocks do not stop the batch as blocked", () => {
  const booking = fixture(); booking.counts.naverBookingStockSucceeded = 2;
  assert.equal(inspectManifest(booking).reason, "booking_results_incomplete");
  const ota = fixture(); ota.counts.naverOtaBlocked = 1;
  assert.equal(inspectManifest(ota).status, "partial");
  assert.equal(inspectManifest(ota).blockedReason, undefined);
});

test("explicit main HTTP 403 and 429 are blocked while server failures stay failed", () => {
  const manifest = fixture(); manifest.naverAttemptedQueries = [{ status: 429 }];
  assert.equal(inspectManifest(manifest).status, "blocked");
  assert.equal(inspectManifest(manifest).blockedReason, "naver_main_http_429");
  manifest.naverAttemptedQueries[0].status = 403;
  assert.equal(inspectManifest(manifest).status, "blocked");
  assert.equal(inspectManifest(manifest).blockedReason, "naver_main_http_403");
  manifest.naverAttemptedQueries[0].status = 503;
  assert.equal(inspectManifest(manifest).status, "failed");
});

test("paced auxiliary Naver blocks stop the batch and never update derived inventory", () => {
  for (const status of [403, 429]) {
    const manifest = fixture();
    manifest.requestPacing = { enabled: true, blockedStatus: status };
    // An auxiliary/business lookup can fail before any booking-specific block is recorded.
    manifest.naverBookingBlockedStatus = 0;
    assert.equal(inspectManifest(manifest).status, "blocked");
    assert.equal(inspectManifest(manifest).blockedReason, `naver_request_http_${status}`);
    assert.equal(allowsDerivedUpdates(manifest), false);
  }
  const normal = fixture();
  normal.requestPacing = { enabled: true, blockedStatus: null };
  assert.equal(inspectManifest(normal).status, "complete");
});

function guardOnlyFixture(manualWorker = false) {
  const manifest = fixture();
  manifest.workerCollection = true;
  manifest.scheduledCollection = !manualWorker;
  manifest.collectionProfileFlags = { collectBookingStock: true };
  manifest.counts.naverBookingStockEligible = manifest.counts.naverBookingStockChecked;
  manifest.requestPacing = {
    enabled: false, guardEnabled: true, pacingEnabled: false,
    minIntervalMs: 0, maxConcurrentRequests: null, blockedStatus: null, blockedCode: null
  };
  return manifest;
}

test("guard-only HTTP and BookingAPITooManyRequests blocks reject scheduled and manual worker results", () => {
  for (const manualWorker of [false, true]) {
    for (const [blockedStatus, blockedCode, reason] of [
      [403, null, "naver_request_http_403"],
      [429, null, "naver_request_http_429"],
      [200, "BookingAPITooManyRequests", "naver_booking_api_too_many_requests"]
    ]) {
      const manifest = guardOnlyFixture(manualWorker);
      Object.assign(manifest.requestPacing, { blockedStatus, blockedCode });
      // Auxiliary requests can latch a block while all main/schedule counters still show success.
      manifest.collectionQuality = { status: "complete" };
      assert.equal(inspectManifest(manifest).status, "blocked");
      assert.equal(inspectManifest(manifest).blockedReason, reason);
      assert.equal(allowsDerivedUpdates(manifest), false);
    }
  }
});

test("guard-only speed leaves normal acceptance and missing, partial and inconsistent counters unchanged", () => {
  for (const manualWorker of [false, true]) {
    const complete = guardOnlyFixture(manualWorker);
    assert.equal(inspectManifest(complete).status, "complete");
    assert.equal(allowsDerivedUpdates(complete), true);
    for (const [mutate, status, reason] of [
      [manifest => { delete manifest.counts.naverScheduleRequested; }, "partial", "quality_metadata_missing"],
      [manifest => { manifest.counts.naverScheduleSucceeded -= 1; manifest.counts.naverScheduleFailed += 1; }, "partial", "booking_schedule_responses_incomplete"],
      [manifest => { manifest.counts.naverScheduleSucceeded -= 1; }, "failed", "inconsistent_schedule_counts"],
      [manifest => { manifest.counts.naverBookingStockSucceeded += 1; }, "failed", "inconsistent_booking_counts"]
    ]) {
      const manifest = guardOnlyFixture(manualWorker);
      mutate(manifest);
      const result = inspectManifest(manifest);
      assert.equal(result.status, status);
      assert.equal(result.reason, reason);
      assert.equal(allowsDerivedUpdates(manifest), false);
    }
  }
});

test("actual crawler rejects 403/429 before trying to parse a blocked HTML response", async () => {
  const source = await fs.readFile(path.join(__dirname, "gyeongnam_glamping_crawl.cjs"), "utf8");
  const start = source.indexOf("async function getNaverState(query) {");
  const end = source.indexOf("\nconst naverBookingBusinessQuery", start);
  assert.ok(start >= 0 && end > start);
  const functionSource = source.slice(start, end).trim();
  for (const status of [403, 429, 200]) {
    let parserCalls = 0;
    const getNaverState = vm.runInNewContext(`(${functionSource})`, {
      fetchText: async () => ({ res: { status }, text: "fixture response" }),
      extractApolloState: () => { parserCalls += 1; return { fixture: true }; }
    });
    if (status === 200) {
      const result = await getNaverState("fixture keyword");
      assert.equal(result.status, 200);
      assert.equal(parserCalls, 1);
    } else {
      await assert.rejects(getNaverState("fixture keyword"), (error) => {
        assert.equal(error.message, `NAVER_MAIN_BLOCKED HTTP ${status}`);
        assert.equal(error.code, "NAVER_MAIN_BLOCKED");
        assert.equal(error.statusCode, status);
        return true;
      });
      assert.equal(parserCalls, 0);
    }
  }
});

test("wrong result configuration and impossible count totals cannot pass", () => {
  for (const expected of [{ keyword: "가평글램핑" }, { bookingDays: 7 }, { productMode: "lodging" }, { checkIn: "2026-09-21" }, { detailRankRanges: "1-10" }]) {
    assert.equal(inspectManifest(fixture(), { payload: expected }).status, "failed");
  }
  const manifest = fixture(); manifest.counts.naverBookingStockSucceeded = 9;
  assert.equal(inspectManifest(manifest).reason, "inconsistent_booking_counts");
  const ota = fixture(); ota.counts.naverOtaFailed = 8;
  assert.equal(inspectManifest(ota).reason, "inconsistent_ota_counts");
});

test("scheduled response counters reject unknown, missing, partial and blocked schedule evidence", () => {
  const unknown = fixture(); delete unknown.counts.naverScheduleRequested;
  assert.equal(inspectManifest(unknown).reason, "quality_metadata_missing");
  const empty = fixture(); empty.counts.naverScheduleRequested = 0; empty.counts.naverScheduleSucceeded = 0;
  assert.equal(inspectManifest(empty).reason, "no_booking_schedule_requests");
  const partial = fixture(); partial.counts.naverScheduleSucceeded -= 1; partial.counts.naverScheduleFailed += 1;
  assert.equal(inspectManifest(partial).status, "partial");
  assert.equal(inspectManifest(partial).reason, "booking_schedule_responses_incomplete");
  assert.equal(allowsDerivedUpdates(partial), false);
  const blocked = fixture(); blocked.counts.naverScheduleBlocked = 1; blocked.counts.naverBookingStockSucceeded = 0;
  assert.equal(inspectManifest(blocked).status, "blocked");
  assert.equal(allowsDerivedUpdates(blocked), false);
  for (const status of [403, 429]) {
    const productListBlocked = fixture();
    productListBlocked.naverBookingBlockedStatus = status;
    productListBlocked.counts.naverBookingStockSucceeded = 0;
    productListBlocked.counts.naverScheduleRequested = 0;
    assert.equal(inspectManifest(productListBlocked).status, "blocked");
    assert.equal(inspectManifest(productListBlocked).blockedReason, `naver_booking_http_${status}`);
    assert.equal(allowsDerivedUpdates(productListBlocked), false);
  }
  const inconsistent = fixture(); inconsistent.counts.naverScheduleSucceeded -= 1;
  assert.equal(inspectManifest(inconsistent).reason, "inconsistent_schedule_counts");
  const legacy = fixture(); delete legacy.scheduledCollection;
  delete legacy.counts.naverScheduleRequested; delete legacy.counts.naverScheduleSucceeded;
  delete legacy.counts.naverScheduleFailed; delete legacy.counts.naverScheduleBlocked;
  assert.equal(inspectManifest(legacy).status, "complete");
});

async function scheduleHarness(post, scheduled = true) {
  const source = await fs.readFile(path.join(__dirname, "gyeongnam_glamping_crawl.cjs"), "utf8");
  const start = source.indexOf("async function getNaverDailySchedule(");
  const end = source.indexOf("\nfunction asStockNumber", start);
  assert.ok(start >= 0 && end > start);
  const context = {
    GUARDED_COLLECTION: scheduled, CHECK_IN: "2026-09-20", naverDailyScheduleQuery: "fixture-query",
    naverScheduleBlockedStatus: 0,
    scheduledCollectionDiagnostics: { naverScheduleRequested: 0, naverScheduleSucceeded: 0, naverScheduleFailed: 0, naverScheduleBlocked: 0 },
    postNaverBookingGraphql: post
  };
  const call = vm.runInNewContext(`(${source.slice(start, end).trim()})`, context);
  return { call, context, counts: context.scheduledCollectionDiagnostics };
}

function scheduleResponse(status, day, errors) {
  return { status, data: { data: { schedule: { bizItemSchedule: { daily: { date: { "2026-09-20": day } } } } }, errors } };
}

test("actual schedule reader accepts finite stock including zero and empty GraphQL error lists", async () => {
  for (const stock of [0, 3, "0", "12"]) {
    const harness = await scheduleHarness(async () => scheduleResponse(200, { stock }, []));
    await harness.call("fixture-business", "fixture-product");
    assert.deepEqual(harness.counts, { naverScheduleRequested: 1, naverScheduleSucceeded: 1, naverScheduleFailed: 0, naverScheduleBlocked: 0 });
  }
});

test("actual schedule reader records HTTP, GraphQL, missing day, invalid stock and network failures", async () => {
  const responses = [
    scheduleResponse(503, { stock: 1 }), scheduleResponse(200, { stock: 1 }, [{ message: "fixture" }]),
    ...[null, undefined, {}, [], { stock: null }, { stock: undefined }, { stock: "" }, { stock: " " }, { stock: true }, { stock: NaN }].map(day => scheduleResponse(200, day))
  ];
  for (const response of responses) {
    const harness = await scheduleHarness(async () => response);
    await harness.call("fixture-business", "fixture-product");
    assert.equal(harness.counts.naverScheduleFailed, 1);
    assert.equal(harness.counts.naverScheduleSucceeded, 0);
    assert.equal(harness.counts.naverScheduleBlocked, 0);
  }
  const harness = await scheduleHarness(async () => { throw new Error("fixture-network-failure"); });
  await assert.rejects(harness.call("fixture-business", "fixture-product"), /fixture-network-failure/);
  assert.equal(harness.counts.naverScheduleRequested, 1);
  assert.equal(harness.counts.naverScheduleFailed, 1);
});

test("schedule 403/429 sets a latch before the next request without double-counting failures", async () => {
  for (const status of [403, 429]) {
    let requests = 0;
    const harness = await scheduleHarness(async () => { requests += 1; return scheduleResponse(status, null); });
    for (let index = 0; index < 2; index += 1) {
      await assert.rejects(harness.call("fixture-business", "fixture-product"), new RegExp(`NAVER_SCHEDULE_BLOCKED HTTP ${status}`));
    }
    assert.equal(requests, 1);
    assert.deepEqual(harness.counts, { naverScheduleRequested: 1, naverScheduleSucceeded: 0, naverScheduleFailed: 1, naverScheduleBlocked: 1 });
  }
});

test("manual schedule calls retain previous response behavior without diagnostics or a blocking latch", async () => {
  let requests = 0;
  const harness = await scheduleHarness(async () => { requests += 1; return scheduleResponse(403, null); }, false);
  await harness.call("fixture-business", "fixture-product");
  await harness.call("fixture-business", "fixture-product");
  assert.equal(requests, 2);
  assert.equal(harness.context.naverScheduleBlockedStatus, 0);
  assert.deepEqual(harness.counts, { naverScheduleRequested: 0, naverScheduleSucceeded: 0, naverScheduleFailed: 0, naverScheduleBlocked: 0 });
});

test("schedule block latch stops new booking GraphQL calls and new place lookups", async () => {
  const source = await fs.readFile(path.join(__dirname, "gyeongnam_glamping_crawl.cjs"), "utf8");
  const graphqlStart = source.indexOf("async function postNaverBookingGraphql(");
  const graphqlEnd = source.indexOf("\nasync function getNaverBookingItems", graphqlStart);
  assert.ok(graphqlStart >= 0 && graphqlEnd > graphqlStart);
  let fetchCalls = 0;
  const graphql = vm.runInNewContext(`(${source.slice(graphqlStart, graphqlEnd).trim()})`, {
    GUARDED_COLLECTION: true, naverScheduleBlockedStatus: 429, CHECK_IN: "2026-09-20",
    fetch: async () => { fetchCalls += 1; throw new Error("unexpected_network"); }
  });
  await assert.rejects(graphql("searchBizItem", "fixture", {}, "fixture-business"), /NAVER_SCHEDULE_BLOCKED HTTP 429/);
  assert.equal(fetchCalls, 0);
  const availabilityStart = source.indexOf("async function collectNaverBookingAvailability(");
  const availabilityEnd = source.indexOf("\nasync function enrichNaverRowsWithBookingAvailability", availabilityStart);
  assert.ok(availabilityStart >= 0 && availabilityEnd > availabilityStart);
  let lookupCalls = 0;
  const availability = vm.runInNewContext(`(${source.slice(availabilityStart, availabilityEnd).trim()})`, {
    GUARDED_COLLECTION: true, naverScheduleBlockedStatus: 403,
    getNaverBookingBusiness: async () => { lookupCalls += 1; throw new Error("unexpected_lookup"); }
  });
  await assert.rejects(availability("fixture-place", new Map()), /NAVER_SCHEDULE_BLOCKED HTTP 403/);
  assert.equal(lookupCalls, 0);
});

test("product-list HTTP 403/429 sets the booking latch even before any schedule request", async () => {
  const source = await fs.readFile(path.join(__dirname, "gyeongnam_glamping_crawl.cjs"), "utf8");
  const start = source.indexOf("async function postNaverBookingGraphql(");
  const end = source.indexOf("\nasync function getNaverBookingItems", start);
  assert.ok(start >= 0 && end > start);
  for (const status of [403, 429]) {
    let requests = 0;
    const context = {
      GUARDED_COLLECTION: true, naverScheduleBlockedStatus: 0, CHECK_IN: "2026-09-20", ADULTS: 2, isNaverBookingRateLimit,
      NAVER_BOOKING_GRAPHQL_URL: "https://fixture.invalid/graphql", headers: {}, addDays: () => "2026-09-21",
      fetch: async () => { requests += 1; return { status, json: async () => ({ fixture: true }) }; }
    };
    const post = vm.runInNewContext(`(${source.slice(start, end).trim()})`, context);
    const first = await post("searchBizItem", "fixture-query", {}, "fixture-business");
    assert.equal(first.status, status);
    assert.equal(context.naverScheduleBlockedStatus, status);
    await assert.rejects(post("searchBizItem", "fixture-query", {}, "fixture-business"), new RegExp(`NAVER_SCHEDULE_BLOCKED HTTP ${status}`));
    assert.equal(requests, 1);
  }
});

test("scheduled concurrent mapper waits for started responses before exposing an error", async () => {
  const source = await fs.readFile(path.join(__dirname, "gyeongnam_glamping_crawl.cjs"), "utf8");
  const start = source.indexOf("async function mapWithConcurrency(");
  const end = source.indexOf("\nfunction naverBookingEvidenceFromRow", start);
  assert.ok(start >= 0 && end > start);
  const mapper = vm.runInNewContext(`(${source.slice(start, end).trim()})`, { GUARDED_COLLECTION: true });
  let resolveSecond;
  const second = new Promise(resolve => { resolveSecond = resolve; });
  let finished = false;
  const work = mapper([1, 2], 2, async (item) => {
    if (item === 1) throw new Error("fixture-blocked");
    return second;
  });
  const observed = work.then(() => { finished = true; }, () => { finished = true; });
  await Promise.resolve(); await Promise.resolve();
  assert.equal(finished, false);
  resolveSecond(2);
  await assert.rejects(work, /fixture-blocked/);
  await observed;
  assert.equal(finished, true);
});

test("derived update gate preserves legacy behavior and rejects scheduled noncomplete results", () => {
  assert.equal(allowsDerivedUpdates({}), true);
  for (const state of ["complete", "partial", "failed", "blocked"]) {
    const manifest = fixture(); manifest.scheduledCollection = true;
    if (state === "partial") manifest.counts.naverOtaBlocked = 1;
    if (state === "failed") manifest.counts.naverOverall = 0;
    if (state === "blocked") manifest.naverAttemptedQueries = [{ status: 429 }];
    manifest.collectionQuality = { status: "complete" }; // A stale receipt cannot override current count evidence.
    assert.equal(allowsDerivedUpdates(manifest), state === "complete", state);
  }
});

test("inspectResult reads persisted manifest, checks run identity and does not mutate it", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "daily-quality-test-"));
  try {
    const file = path.join(dir, "manifest.json");
    const original = JSON.stringify(fixture());
    await fs.writeFile(file, original);
    const result = { runId: path.basename(dir), output: { outputDir: dir, counts: { naverOverall: 0 } } };
    assert.equal((await inspectResult(result, { bookingDays: 31 })).status, "complete");
    assert.equal((await inspectResult({ ...result, runId: "wrong-run" })).reason, "run_id_mismatch");
    assert.equal(await fs.readFile(file, "utf8"), original);
    await fs.writeFile(file, "broken JSON");
    assert.equal((await inspectResult(result)).reason, "manifest_unreadable");
    assert.equal((await inspectResult({ output: "stdout", runId: null })).reason, "result_artifacts_missing");
  } finally {
    // Only remove the exact test-created folder, never a caller-provided data directory.
    const resolved = path.resolve(dir);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith("daily-quality-test-"));
    await fs.rm(resolved, { recursive: true, force: true });
  }
});
