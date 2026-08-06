"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { installFixtureNetworkGuard } = require("./fixture_network_guard.cjs");
const {
  NAVER_LEGACY_INVENTORY_PROFILE,
  NAVER_LEGACY_INVENTORY_SCOPE
} = require("./naver_legacy_inventory_activation.cjs");

const guard = installFixtureNetworkGuard({ label: "NAVER legacy inventory crawler fixtures" });
const ROOT = path.resolve(__dirname, "..");
const CRAWLER = path.join(__dirname, "gyeongnam_glamping_crawl.cjs");
const PRELOAD = path.join(__dirname, "naver_legacy_inventory_fixture_preload.cjs");
const NETWORK_GUARD_PRELOAD = path.join(__dirname, "fixture_network_guard_preload.cjs");

function assertSystemTempFixtureRoot(root) {
  const resolvedRoot = path.resolve(root);
  const resolvedTemp = path.resolve(os.tmpdir());
  const relative = path.relative(resolvedTemp, resolvedRoot);
  assert.ok(relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
  return resolvedRoot;
}

function childEnvironment(root, mode, stamp, auditFile) {
  return {
    ...process.env,
    NODE_OPTIONS: [
      process.env.NODE_OPTIONS,
      `--require=${NETWORK_GUARD_PRELOAD.replace(/\\/gu, "/")}`,
      `--require=${PRELOAD.replace(/\\/gu, "/")}`
    ].filter(Boolean).join(" "),
    NODE_ENV: "test",
    CHECK_IN: "2026-08-06",
    CHECK_OUT: "2026-08-06",
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
    COLLECTION_SOURCE_LABEL: "관리자 수집",
    REQUESTED_COLLECTION_MODE: "precision",
    REQUESTED_COLLECTION_PURPOSE: "revenue_detail",
    NAVER_LEGACY_LIMITED_ACTIVATION: "1",
    NAVER_LEGACY_INVENTORY_ACTIVATION: "1",
    NAVER_COLLECTOR_STRATEGY: "legacy_candidate",
    NAVER_COLLECTOR_SCOPE: NAVER_LEGACY_INVENTORY_SCOPE,
    NAVER_LIMITED_ACTIVATION_PROFILE: NAVER_LEGACY_INVENTORY_PROFILE,
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
    RUN_STAMP: stamp,
    DATA_DIR: root,
    OUTPUTS_DIR: path.join(root, "outputs"),
    CONFIG_DIR: path.join(root, "config"),
    NAVER_INVENTORY_FIXTURE_ROOT: root,
    NAVER_INVENTORY_FIXTURE_MODE: mode,
    NAVER_INVENTORY_FIXTURE_AUDIT_FILE: auditFile
  };
}

function runFixture(root, mode, stamp) {
  const auditFile = path.join(root, `audit-${mode}-${stamp}.json`);
  const child = spawnSync(process.execPath, [CRAWLER, "경남 글램핑"], {
    cwd: ROOT,
    encoding: "utf8",
    env: childEnvironment(root, mode, stamp, auditFile),
    timeout: 120_000,
    windowsHide: true
  });
  const audit = fs.existsSync(auditFile) ? JSON.parse(fs.readFileSync(auditFile, "utf8")) : null;
  return { child, audit };
}

function runDirectories(root) {
  const outputs = path.join(root, "outputs");
  if (!fs.existsSync(outputs) || !fs.statSync(outputs).isDirectory()) return [];
  return fs.readdirSync(outputs).filter((name) => fs.statSync(path.join(outputs, name)).isDirectory());
}

(async () => {
  const roots = [];
  try {
    const successRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "naver-inventory-success-"));
    roots.push(successRoot);
    const success = runFixture(successRoot, "success", "20260806_130000");
    assert.equal(success.child.status, 0, success.child.stderr || success.child.stdout);
    assert.deepEqual(success.audit?.operationCounts, {
      main_place: 1,
      booking_business: 3,
      booking_items: 3,
      daily_schedule: 6
    });
    assert.equal(success.audit?.callCount, 13);
    const successRuns = runDirectories(successRoot);
    assert.equal(successRuns.length, 1);
    assert.doesNotMatch(successRuns[0], /\.pending-/u);
    const runDir = path.join(successRoot, "outputs", successRuns[0]);
    const manifest = JSON.parse(await fsp.readFile(path.join(runDir, "manifest.json"), "utf8"));
    assert.equal(manifest.collectorScope, NAVER_LEGACY_INVENTORY_SCOPE);
    assert.equal(manifest.collectorActivationProfile, NAVER_LEGACY_INVENTORY_PROFILE);
    assert.equal(manifest.collectionMode, "precision");
    assert.equal(manifest.detailRankRanges, "1-3");
    assert.equal(manifest.bookingRangeDays, 1);
    assert.equal(manifest.providerRequestCount, 13);
    assert.equal(manifest.providerCallCounts.mainPlace, 1);
    assert.deepEqual(manifest.providerCallCounts.inventory, {
      bookingBusiness: 3,
      bookingItems: 3,
      dailySchedule: 6,
      total: 12
    });
    assert.equal(manifest.providerMaxObservedConcurrency, 1);
    assert.deepEqual(manifest.inventoryResultCounts, { planned: 3, ready: 3, zero: 0, missing: 0, partial: 0 });
    assert.equal(manifest.counts.naverOverall, 50);
    assert.equal(manifest.counts.naverRegional, 0);
    assert.equal(manifest.counts.nolFirstPage, 0);
    assert.equal(manifest.counts.ddnayo, 0);
    assert.equal(manifest.counts.naverBookingStockChecked, 3);
    assert.equal(manifest.counts.naverBookingStockSucceeded, 3);
    const overallCsv = await fsp.readFile(path.join(runDir, manifest.fileRoles.overall), "utf8");
    assert.match(overallCsv, /숙박기준일예상매출/u);
    assert.match(overallCsv, /100000/u, "the local public-inventory revenue estimate must be persisted");

    const zeroRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "naver-inventory-zero-"));
    roots.push(zeroRoot);
    const zeroResult = runFixture(zeroRoot, "zero_two", "20260806_130100");
    assert.equal(zeroResult.child.status, 0, zeroResult.child.stderr || zeroResult.child.stdout);
    assert.equal(zeroResult.audit?.callCount, 5, "two provider-confirmed exposure zeros must not generate booking calls");
    const zeroRun = runDirectories(zeroRoot)[0];
    const zeroManifest = JSON.parse(await fsp.readFile(path.join(zeroRoot, "outputs", zeroRun, "manifest.json"), "utf8"));
    assert.deepEqual(zeroManifest.inventoryResultCounts, { planned: 3, ready: 1, zero: 2, missing: 0, partial: 0 });

    const capRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "naver-inventory-nine-items-"));
    roots.push(capRoot);
    const capResult = runFixture(capRoot, "nine_items", "20260806_130150");
    assert.equal(capResult.child.status, 0, capResult.child.stderr || capResult.child.stdout);
    assert.deepEqual(capResult.audit?.operationCounts, {
      main_place: 1,
      booking_business: 3,
      booking_items: 3,
      daily_schedule: 24
    });
    assert.equal(capResult.audit?.callCount, 31, "the ninth product for every company must not be requested");
    const capRun = runDirectories(capRoot)[0];
    const capManifest = JSON.parse(await fsp.readFile(path.join(capRoot, "outputs", capRun, "manifest.json"), "utf8"));
    assert.deepEqual(capManifest.providerCompanyCallCounts, {
      1: { bookingBusiness: 1, bookingItems: 1, dailySchedule: 8 },
      2: { bookingBusiness: 1, bookingItems: 1, dailySchedule: 8 },
      3: { bookingBusiness: 1, bookingItems: 1, dailySchedule: 8 }
    });

    for (const [mode, expectedMaxCalls, expectedCode] of [
      ["has_booking_omitted", 1, "COLLECTION_FAILED"],
      ["business_booking_omitted", 2, "COLLECTION_FAILED"],
      ["schedule_empty_object", 4, "COLLECTION_FAILED"],
      ["http_403_booking_business", 2, "NAVER_ACCESS_BLOCKED"],
      ["http_429_booking_items", 3, "NAVER_ACCESS_BLOCKED"],
      ["challenge_daily_schedule", 4, "NAVER_ACCESS_BLOCKED"],
      ["malformed_booking_items", 3, "COLLECTION_FAILED"],
      ["graphql_error_daily_schedule", 4, "COLLECTION_FAILED"]
    ]) {
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), `naver-inventory-${mode}-`));
      roots.push(root);
      const failure = runFixture(root, mode, "20260806_130200");
      assert.notEqual(failure.child.status, 0, `${mode} must fail closed`);
      assert.equal(failure.audit?.callCount, expectedMaxCalls, `${mode} must stop before any later provider call`);
      assert.deepEqual(runDirectories(root), [], `${mode} must not publish a final or pending run`);
      assert.match(`${failure.child.stdout}\n${failure.child.stderr}`, new RegExp(`"code":"${expectedCode}"`, "u"));
      assert.doesNotMatch(`${failure.child.stdout}\n${failure.child.stderr}`, /pcmap-api\.place\.naver\.com|m\.booking\.naver\.com\/graphql|Synthetic Inventory Lodge/u);
    }

    assert.equal(guard.blockedAttempts(), 0);
    console.log("NAVER legacy inventory crawler fixtures passed.");
  } finally {
    await Promise.all(roots.map((root) => fsp.rm(assertSystemTempFixtureRoot(root), { recursive: true, force: true })));
    guard.restore();
  }
})().catch((error) => {
  guard.restore();
  console.error(error);
  process.exitCode = 1;
});
