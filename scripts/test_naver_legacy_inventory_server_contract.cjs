"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { __test } = require("./glamping_app_server.cjs");
const {
  NAVER_LEGACY_INVENTORY_PREVIEW_ROOT,
  NAVER_LEGACY_INVENTORY_PROFILE,
  NAVER_LEGACY_INVENTORY_SCOPE
} = require("./naver_legacy_inventory_activation.cjs");

const previewRuntime = {
  previewRuntime: true,
  previewDataRoot: NAVER_LEGACY_INVENTORY_PREVIEW_ROOT,
  activationEnvironment: {
    EXACT_V2_PREVIEW_RUNTIME: true,
    RENDER: "true",
    PREVIEW_DATA_ROOT: NAVER_LEGACY_INVENTORY_PREVIEW_ROOT
  }
};
const request = {
  keyword: "경남 글램핑",
  checkIn: "2026-08-06",
  checkOut: "2026-08-12",
  bookingDays: 7,
  searchMode: "keyword",
  productMode: "all",
  collectionMode: "precision",
  collectionPurpose: "revenue_detail",
  detailRankRanges: "1-10",
  bookingRangePlaceLimit: 10
};

const trusted = __test.trustedPreviewAdminCrawlPayload(request, previewRuntime);
assert.equal(trusted.naverLegacyLimitedActivation, true);
assert.equal(trusted.naverLegacyInventoryActivation, true);
assert.equal(trusted.naverCollectorStrategy, "legacy_candidate");
assert.equal(trusted.naverCollectorScope, NAVER_LEGACY_INVENTORY_SCOPE);
assert.equal(trusted.naverLimitedActivationProfile, NAVER_LEGACY_INVENTORY_PROFILE);
assert.equal(trusted.collectionMode, "precision");
assert.equal(trusted.collectionPurpose, "revenue_detail");
assert.equal(trusted.detailRankRanges, "1-3");
assert.equal(trusted.checkOut, trusted.checkIn);
assert.equal(trusted.bookingRangeDays, 1);
assert.equal(trusted.bookingRangePlaceLimit, 0);
assert.equal(trusted.naverProviderCallBudget, 1);
assert.equal(trusted.naverInventoryCallBudget, 30);
assert.equal(trusted.naverTotalCallBudget, 31);
assert.equal(trusted.naverInventoryPlaceLimit, 3);
assert.equal(trusted.naverInventoryItemLimit, 8);
assert.equal(trusted.naverProviderConcurrency, 1);
assert.equal(trusted.naverAutomaticRetry, false);
assert.equal(trusted.naverAutomaticFallback, false);

const plan = __test.crawlExecutionPlan(trusted);
assert.equal(plan.boundedInventoryActivation, true);
assert.equal(plan.detailRankRanges, "1-3");
assert.equal(plan.detailPlaceLimit, 3);
assert.equal(plan.bookingRangeDays, 1);
assert.equal(plan.collectRegional, false);
assert.equal(plan.collectOta, false);
assert.equal(plan.collectBookingStock, true);
assert.equal(plan.collectWeeklyRange, false);
const estimate = __test.estimateCrawlCompletion(trusted, { entries: [] });
assert.equal(estimate.basis.boundedInventory.totalCallBudget, 31);
assert.equal(estimate.basis.boundedInventory.inventoryPlaceLimit, 3);
assert.equal(estimate.basis.boundedInventory.observationDays, 1);
assert.match(estimate.stages.find((stage) => stage.key === "inventory").detail, /최대 31건/u);

const local = __test.trustedPreviewAdminCrawlPayload({
  ...request,
  naverLegacyInventoryActivation: true,
  naverInventoryCallBudget: 999
});
assert.equal(local.naverLegacyInventoryActivation, false);
assert.equal(local.naverCollectorStrategy, "current");
assert.equal(local.naverInventoryCallBudget, 0);

const fast = __test.trustedPreviewAdminCrawlPayload({ ...request, collectionMode: "fast" }, previewRuntime);
assert.equal(fast.naverLegacyInventoryActivation, false);
assert.equal(fast.naverCollectorScope, "main_place_only");
assert.equal(fast.naverProviderCallBudget, 1);

const currentSignature = __test.crawlPayloadSignature({ ...request, naverLegacyLimitedActivation: false });
const boundedSignature = __test.crawlPayloadSignature(trusted);
assert.notEqual(currentSignature, boundedSignature);

const outputDir = path.join(path.resolve(__dirname, "..", "outputs"), "fixture_inventory_glamping_20260806_130000");
const manifest = {
  documentType: "lodging-collection-manifest",
  outputDir,
  collectorStrategy: "legacy_candidate",
  collectorScope: NAVER_LEGACY_INVENTORY_SCOPE,
  collectorActivationProfile: NAVER_LEGACY_INVENTORY_PROFILE,
  collectionPurpose: "revenue_detail",
  collectionMode: "precision",
  collectionProfile: "revenue_detail_deep",
  detailRankRanges: "1-3",
  checkIn: "2026-08-06",
  checkOut: "2026-08-06",
  bookingRangeDays: 1,
  maxInventoryCompanies: 3,
  maxProductsPerCompany: 8,
  revenueEstimateBasis: "naver_booking_public_inventory_estimate_not_settled_revenue",
  providerConcurrency: 1,
  providerMaxObservedConcurrency: 1,
  providerCallBudget: 31,
  mainPlaceCallBudget: 1,
  inventoryCallBudget: 30,
  totalCallBudget: 31,
  mainPlaceRequestCount: 1,
  providerRequestCount: 13,
  automaticRetry: false,
  automaticFallback: false,
  saveRunOnSuccessOnly: true,
  saveFailureRun: false,
  collectionProfileFlags: {
    collectRegional: false,
    collectOta: false,
    collectBookingStock: true,
    collectWeeklyRange: false
  },
  providerCallCounts: {
    mainPlace: 1,
    inventory: { bookingBusiness: 3, bookingItems: 3, dailySchedule: 6, total: 12 },
    total: 13
  },
  providerCompanyCallCounts: {
    1: { bookingBusiness: 1, bookingItems: 1, dailySchedule: 2 },
    2: { bookingBusiness: 1, bookingItems: 1, dailySchedule: 2 },
    3: { bookingBusiness: 1, bookingItems: 1, dailySchedule: 2 }
  },
  inventoryResultCounts: { planned: 3, ready: 3, zero: 0, missing: 0, partial: 0 },
  inventoryTargetResults: [
    { companyOrdinal: 1, status: "ready", bookingBusiness: 1, bookingItems: 1, dailySchedule: 2 },
    { companyOrdinal: 2, status: "ready", bookingBusiness: 1, bookingItems: 1, dailySchedule: 2 },
    { companyOrdinal: 3, status: "ready", bookingBusiness: 1, bookingItems: 1, dailySchedule: 2 }
  ],
  counts: {
    naverOverall: 50,
    naverRegional: 0,
    naverBookingStockChecked: 3,
    nolFirstPage: 0,
    nolRawFirstPage: 0,
    ddnayo: 0
  }
};
assert.equal(
  __test.validateNaverLegacyLimitedRunManifest(manifest, {
    naverLegacyLimitedActivation: true,
    naverLegacyInventoryActivation: true
  }).runId,
  "fixture_inventory_glamping_20260806_130000"
);
for (const invalid of [
  { providerRequestCount: 12 },
  { inventoryResultCounts: { planned: 3, ready: 2, zero: 0, missing: 1, partial: 0 } },
  { providerConcurrency: 2 },
  { counts: { ...manifest.counts, naverRegional: 1 } }
]) {
  assert.throws(
    () => __test.validateNaverLegacyLimitedRunManifest({ ...manifest, ...invalid }, {
      naverLegacyLimitedActivation: true,
      naverLegacyInventoryActivation: true
    }),
    (error) => error?.code === "NAVER_LEGACY_LIMITED_RESULT_INVALID"
  );
}

const mainOnlyDowngrade = {
  ...manifest,
  collectorScope: "main_place_only",
  collectorActivationProfile: "preview-admin-keyword-fast-main-place.v1",
  collectionMode: "fast",
  collectionProfile: "fast_rank"
};
assert.throws(
  () => __test.validateNaverLegacyLimitedRunManifest(mainOnlyDowngrade, {
    naverLegacyLimitedActivation: true,
    naverLegacyInventoryActivation: true
  }),
  (error) => error?.code === "NAVER_LEGACY_LIMITED_RESULT_INVALID"
);

const appSource = fs.readFileSync(path.join(__dirname, "..", "web", "app.js"), "utf8");
assert.match(appSource, /메인 순위 1~50 · 재고 상위 3곳 · 기준일 1일 · 순차 수집 · 최대 31요청/u);
assert.match(appSource, /실제 정산매출 아님/u);

(async () => {
  const cleanupRoot = fs.mkdtempSync(path.join(os.tmpdir(), "naver-inventory-parent-cleanup-"));
  try {
    const stamp = "20260806_130300";
    const finalRun = path.join(cleanupRoot, `fixture_inventory_glamping_${stamp}`);
    const pendingRun = path.join(cleanupRoot, `fixture_inventory_glamping_${stamp}.pending-1234-a1b2c3d4`);
    const sibling = path.join(cleanupRoot, "fixture_inventory_glamping_20260806_130200");
    fs.mkdirSync(finalRun);
    fs.mkdirSync(pendingRun);
    fs.mkdirSync(sibling);
    const cleaned = await __test.cleanupLimitedRunArtifactsForStamp(cleanupRoot, stamp);
    assert.equal(cleaned.removed, 2);
    assert.equal(fs.existsSync(finalRun), false);
    assert.equal(fs.existsSync(pendingRun), false);
    assert.equal(fs.existsSync(sibling), true, "parent cleanup must preserve earlier runs");
    console.log("NAVER legacy inventory server contract fixtures passed.");
  } finally {
    fs.rmSync(cleanupRoot, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
