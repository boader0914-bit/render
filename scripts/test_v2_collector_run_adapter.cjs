"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { installFixtureNetworkGuard } = require("./fixture_network_guard.cjs");
const {
  V2_COLLECTOR_COMPATIBILITY_PROFILE,
  V2_COLLECTOR_COMPATIBILITY_SCOPE,
  V2_COLLECTOR_TRANSPORT_STRATEGY,
  buildV2CollectorCompatibilityRunAdapter,
  validateV2CollectorCompatibilityRunManifest
} = require("./v2_collector_compatibility.cjs");

const ROOT = path.resolve(__dirname, "..");

function contract() {
  return {
    keyword: "Synthetic adapter lodging",
    searchMode: "keyword",
    collectionMode: "precision",
    collectionPurpose: "revenue_detail",
    productMode: "all",
    checkIn: "2026-08-06",
    checkOut: "2026-08-06",
    rankStart: 1,
    rankEnd: 50,
    detailRankStart: 1,
    detailRankEnd: 3
  };
}

function mainPlaceSnapshot() {
  return {
    status: "ready",
    strategy: "legacy_candidate",
    executedTransportCount: 1,
    sampleCount: 50,
    items: Array.from({ length: 50 }, (_, index) => ({
      rank: index + 1,
      placeId: `adapter-place-${String(index + 1).padStart(2, "0")}`
    }))
  };
}

function inventoryResults() {
  return [
    { companyOrdinal: 1, placeId: "adapter-place-01", status: "ready", calls: { bookingBusiness: 1, bookingItems: 1, dailySchedule: 4 } },
    { companyOrdinal: 2, placeId: "adapter-place-02", status: "zero", calls: { bookingBusiness: 1, bookingItems: 0, dailySchedule: 0 } },
    { companyOrdinal: 3, placeId: "adapter-place-03", status: "ready", calls: { bookingBusiness: 1, bookingItems: 1, dailySchedule: 2 } }
  ];
}

function otaResults() {
  return [
    { operation: "nol_count", requestOrdinal: 1, status: "ready", requestCount: 1 },
    { operation: "nol_list", requestOrdinal: 2, status: "ready", requestCount: 1 },
    { operation: "yeogi_status", requestOrdinal: 3, status: "provider_blocked", requestCount: 1 },
    { operation: "ddnayo_exact", requestOrdinal: 4, status: "zero", requestCount: 1 },
    { operation: "ddnayo_normalized", requestOrdinal: 5, status: "ready", requestCount: 1 }
  ];
}

function main() {
  const guard = installFixtureNetworkGuard({ label: "V2 collector run adapter fixtures" });
  let fixtureRoot = "";
  let malformedFixtureRoot = "";
  try {
    const adapted = buildV2CollectorCompatibilityRunAdapter({
      contract: contract(),
      mainPlaceSnapshot: mainPlaceSnapshot(),
      inventoryResults: inventoryResults(),
      otaResults: otaResults()
    });
    assert.equal(adapted.manifest.collectorStrategy, "v2_legacy_4e4e190");
    assert.equal(adapted.manifest.collectorTransportStrategy, "legacy_candidate");
    assert.equal(adapted.manifest.counts.naverOverall, 50);
    assert.equal(adapted.manifest.counts.naverRegional, 0);
    assert.equal(adapted.manifest.counts.naverBookingStockChecked, 3);
    assert.equal(adapted.manifest.counts.otaRequests, 5);
    assert.deepEqual(adapted.manifest.providerCallCounts.inventory, {
      bookingBusiness: 3,
      bookingItems: 2,
      dailySchedule: 6,
      total: 11
    });
    assert.equal(adapted.manifest.providerRequestCount, 17);
    assert.equal(adapted.manifest.inventoryResultCounts.ready, 2);
    assert.equal(adapted.manifest.inventoryResultCounts.zero, 1);
    assert.equal(adapted.manifest.otaResultCounts.providerBlockedObserved, true);
    assert.equal(adapted.manifest.collectionProfileFlags.collectRegional, false);
    assert.equal(adapted.manifest.collectionProfileFlags.collectOta, true);
    assert.equal(adapted.manifest.externalRequestConcurrency, 1);
    assert.equal(adapted.manifest.revenueEstimateBasis, "naver_booking_public_inventory_estimate_not_settled_revenue");
    assert.equal(adapted.persistence.saveRun, true);
    assert.equal(adapted.persistence.updateCompanyMaster, true);
    assert.equal(adapted.persistence.appendInventoryHistory, true);
    assert.equal(adapted.persistence.appendRevenueHistory, true);
    assert.equal(Object.prototype.hasOwnProperty.call(adapted, "map"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(adapted.run, "location"), false);
    assert.doesNotMatch(JSON.stringify(adapted), /Synthetic adapter lodging|https?:|authorization|cookie/i);

    const validated = validateV2CollectorCompatibilityRunManifest(adapted.manifest);
    assert.equal(validated.saveRun, true);
    assert.equal(validated.mainPlaceRequestCount, 1);
    assert.equal(validated.inventoryRequestCount, 11);
    assert.equal(validated.otaRequestCount, 5);
    assert.equal(validated.totalExternalRequestCount, 17);

    const regionalRegression = JSON.parse(JSON.stringify(adapted.manifest));
    regionalRegression.counts.naverRegional = 1;
    assert.throws(
      () => validateV2CollectorCompatibilityRunManifest(regionalRegression),
      (error) => error.code === "V2_COLLECTOR_COMPATIBILITY_MANIFEST_INVALID"
    );
    const targetCallRegression = JSON.parse(JSON.stringify(adapted.manifest));
    targetCallRegression.inventoryTargetResults[0].calls.dailySchedule = 8;
    assert.throws(
      () => validateV2CollectorCompatibilityRunManifest(targetCallRegression),
      (error) => error.code === "V2_COLLECTOR_COMPATIBILITY_MANIFEST_INVALID"
    );

    fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "v2-collector-compat-"));
    const auditFile = path.join(fixtureRoot, "audit.json");
    const guardPreload = path.join(__dirname, "fixture_network_guard_preload.cjs").replace(/\\/gu, "/");
    const providerPreload = path.join(__dirname, "naver_legacy_inventory_fixture_preload.cjs").replace(/\\/gu, "/");
    let fixtureEnvironment = null;
    const child = spawnSync(process.execPath, [path.join(__dirname, "gyeongnam_glamping_crawl.cjs"), "경남 글램핑"], {
      cwd: ROOT,
      encoding: "utf8",
      timeout: 120_000,
      windowsHide: true,
      env: (fixtureEnvironment = {
        ...process.env,
        NODE_OPTIONS: [`--require=${guardPreload}`, `--require=${providerPreload}`].join(" "),
        NODE_ENV: "test",
        CHECK_IN: "2026-08-06",
        CHECK_OUT: "2026-08-06",
        ADULTS: "2",
        SEARCH_MODE: "keyword",
        SEARCH_INTENT: "region_category",
        SEARCH_INTENT_CONFIDENCE: "1",
        LODGING_CATEGORY_KEY: "glamping",
        SEARCH_REGION_KEY: "gyeongnam",
        SEARCH_REGION_QUERY: "경남",
        SEARCH_CANDIDATE_MODE: "keyword",
        SEARCH_CANDIDATE_QUERY: "경남 글램핑",
        COLLECTION_MODE: "precision",
        COLLECTION_PURPOSE: "revenue_detail",
        DETAIL_RANK_RANGES: "1-3",
        PRODUCT_MODE: "all",
        BOOKING_RANGE_DAYS: "1",
        BOOKING_RANGE_PLACE_LIMIT: "0",
        SOURCE_ROLE: "admin",
        COLLECTION_SOURCE: "admin_search",
        REQUESTED_COLLECTION_MODE: "precision",
        REQUESTED_COLLECTION_PURPOSE: "revenue_detail",
        NAVER_LEGACY_LIMITED_ACTIVATION: "1",
        NAVER_LEGACY_INVENTORY_ACTIVATION: "1",
        V2_COLLECTOR_COMPATIBILITY_ACTIVATION: "1",
        NAVER_COLLECTOR_STRATEGY: V2_COLLECTOR_TRANSPORT_STRATEGY,
        NAVER_COLLECTOR_SCOPE: V2_COLLECTOR_COMPATIBILITY_SCOPE,
        NAVER_LIMITED_ACTIVATION_PROFILE: V2_COLLECTOR_COMPATIBILITY_PROFILE,
        NAVER_PROVIDER_CALL_BUDGET: "1",
        NAVER_INVENTORY_CALL_BUDGET: "30",
        NAVER_TOTAL_CALL_BUDGET: "31",
        NAVER_INVENTORY_PLACE_LIMIT: "3",
        NAVER_INVENTORY_ITEM_LIMIT: "8",
        NAVER_BOOKING_STOCK_LIMIT: "3",
        NAVER_BOOKING_DETAIL_CONCURRENCY: "1",
        NAVER_SCHEDULE_CONCURRENCY: "1",
        NAVER_SCHEDULE_DELAY_MS: "0",
        NAVER_BOOKING_ID_FALLBACK: "0",
        NAVER_COUPON_PAGE_FALLBACK: "0",
        NAVER_AUTOMATIC_RETRY: "0",
        NAVER_AUTOMATIC_FALLBACK: "0",
        RUN_STAMP: "20260806_170000",
        DATA_DIR: fixtureRoot,
        OUTPUTS_DIR: path.join(fixtureRoot, "outputs"),
        CONFIG_DIR: path.join(fixtureRoot, "config"),
        NAVER_INVENTORY_FIXTURE_ROOT: fixtureRoot,
        NAVER_INVENTORY_FIXTURE_MODE: "success",
        NAVER_INVENTORY_FIXTURE_AUDIT_FILE: auditFile
      })
    });
    assert.equal(child.status, 0, child.stderr || child.stdout);
    const runNames = fs.readdirSync(path.join(fixtureRoot, "outputs"));
    assert.equal(runNames.length, 1);
    assert.doesNotMatch(runNames[0], /\.pending-/u);
    const storedManifest = JSON.parse(fs.readFileSync(path.join(fixtureRoot, "outputs", runNames[0], "manifest.json"), "utf8"));
    assert.equal(storedManifest.collectorStrategy, "v2_legacy_4e4e190");
    assert.equal(storedManifest.collectorTransportStrategy, "legacy_candidate");
    assert.equal(storedManifest.collectionProfileFlags.collectRegional, false);
    assert.equal(storedManifest.collectionProfileFlags.collectOta, true);
    assert.equal(storedManifest.providerRequestCount, 18);
    assert.equal(storedManifest.providerCallCounts.mainPlace, 1);
    assert.equal(storedManifest.providerCallCounts.inventory.total, 12);
    assert.equal(storedManifest.providerCallCounts.ota, 5);
    assert.equal(storedManifest.counts.naverOverall, 50);
    assert.equal(storedManifest.counts.naverRegional, 0);
    assert.equal(storedManifest.counts.naverBookingStockChecked, 3);
    assert.equal(storedManifest.counts.otaRequests, 5);
    validateV2CollectorCompatibilityRunManifest(storedManifest);
    const providerAudit = JSON.parse(fs.readFileSync(auditFile, "utf8"));
    assert.deepEqual(providerAudit.operationCounts, {
      main_place: 1,
      nol_count: 1,
      nol_list: 1,
      yeogi_status: 1,
      ddnayo_exact: 1,
      ddnayo_normalized: 1,
      booking_business: 3,
      booking_items: 3,
      daily_schedule: 6
    });
    assert.equal(providerAudit.callCount, 18);
    assert.equal(providerAudit.maxConcurrentCalls, 1, "the compatibility profile must serialize every external request");
    assert.deepEqual(
      providerAudit.calls.slice(0, 6).map((row) => row.operation),
      ["main_place", "nol_count", "nol_list", "yeogi_status", "ddnayo_exact", "ddnayo_normalized"]
    );

    malformedFixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "v2-collector-malformed-ota-"));
    const malformedAuditFile = path.join(malformedFixtureRoot, "audit.json");
    const malformedChild = spawnSync(process.execPath, [path.join(__dirname, "gyeongnam_glamping_crawl.cjs"), "Synthetic adapter lodging"], {
      cwd: ROOT,
      encoding: "utf8",
      timeout: 120_000,
      windowsHide: true,
      env: {
        ...fixtureEnvironment,
        RUN_STAMP: "20260806_170100",
        DATA_DIR: malformedFixtureRoot,
        OUTPUTS_DIR: path.join(malformedFixtureRoot, "outputs"),
        CONFIG_DIR: path.join(malformedFixtureRoot, "config"),
        NAVER_INVENTORY_FIXTURE_ROOT: malformedFixtureRoot,
        NAVER_INVENTORY_FIXTURE_MODE: "malformed_ota_json",
        NAVER_INVENTORY_FIXTURE_AUDIT_FILE: malformedAuditFile
      }
    });
    assert.notEqual(malformedChild.status, 0, "malformed OTA observations must fail the collector");
    const malformedOutputs = path.join(malformedFixtureRoot, "outputs");
    assert.deepEqual(fs.existsSync(malformedOutputs) ? fs.readdirSync(malformedOutputs) : [], [], "malformed OTA observations must publish no run");
    const malformedAudit = JSON.parse(fs.readFileSync(malformedAuditFile, "utf8"));
    assert.equal(malformedAudit.maxConcurrentCalls, 1);
    assert.deepEqual(
      malformedAudit.calls.slice(0, 6).map((row) => row.operation),
      ["main_place", "nol_count", "nol_list", "yeogi_status", "ddnayo_exact", "ddnayo_normalized"]
    );
    assert.equal(guard.blockedAttempts(), 0);
  } finally {
    if (fixtureRoot) {
      const tempRelative = path.relative(path.resolve(os.tmpdir()), path.resolve(fixtureRoot));
      assert.ok(tempRelative && tempRelative !== ".." && !tempRelative.startsWith(`..${path.sep}`) && !path.isAbsolute(tempRelative));
      fs.rmSync(fixtureRoot, { recursive: true, force: true });
    }
    if (malformedFixtureRoot) {
      const tempRelative = path.relative(path.resolve(os.tmpdir()), path.resolve(malformedFixtureRoot));
      assert.ok(tempRelative && tempRelative !== ".." && !tempRelative.startsWith(`..${path.sep}`) && !path.isAbsolute(tempRelative));
      fs.rmSync(malformedFixtureRoot, { recursive: true, force: true });
    }
    guard.restore();
  }
  console.log("V2 collector run adapter tests passed.");
}

main();
