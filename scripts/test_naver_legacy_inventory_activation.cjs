"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  FIXED_INVENTORY_ACTIVATION,
  NAVER_LEGACY_INVENTORY_PREVIEW_ROOT,
  OPERATION_BUDGETS,
  assertNaverLegacyInventoryActivation,
  buildNaverLegacyInventoryObservation,
  createNaverLegacyInventoryCallLedger,
  decideNaverLegacyInventoryRunPersistence,
  previewRuntimeMatches,
  reserveNaverLegacyInventoryCall,
  resolveNaverLegacyInventoryActivation,
  validateNaverLegacyInventoryCallLedger,
  validateNaverLegacyInventoryRunManifest
} = require("./naver_legacy_inventory_activation.cjs");

const ROOT = path.resolve(__dirname, "..");
const previewEnvironment = Object.freeze({
  EXACT_V2_PREVIEW_RUNTIME: true,
  RENDER: "true",
  PREVIEW_DATA_ROOT: NAVER_LEGACY_INVENTORY_PREVIEW_ROOT
});
const eligible = Object.freeze({
  environment: previewEnvironment,
  collectionSource: "admin_search",
  sourceRole: "admin",
  searchMode: "keyword",
  collectionMode: "precision",
  collectionPurpose: "revenue_detail"
});

assert.equal(previewRuntimeMatches(previewEnvironment), true);
assert.equal(previewRuntimeMatches({ ...previewEnvironment, RENDER: "false" }), false);
assert.equal(previewRuntimeMatches({ ...previewEnvironment, PREVIEW_DATA_ROOT: "/var/data" }), false);

const active = resolveNaverLegacyInventoryActivation(eligible);
assert.equal(assertNaverLegacyInventoryActivation(active), active);
assert.equal(active.activationEnabled, true);
assert.equal(active.executionEligible, true);
assert.equal(active.actualCallsEnabled, true);
assert.equal(active.strategy, "legacy_candidate");
assert.equal(active.collectorScope, "main_place_with_booking_inventory");
assert.equal(active.collectionPurpose, "revenue_detail");
assert.equal(active.effectiveCollectionMode, "precision");
assert.equal(active.mainPlaceRankStart, 1);
assert.equal(active.mainPlaceRankEnd, 50);
assert.equal(active.inventoryRankStart, 1);
assert.equal(active.inventoryRankEnd, 3);
assert.equal(active.maxInventoryCompanies, 3);
assert.equal(active.observationDays, 1);
assert.equal(active.maxProductsPerCompany, 8);
assert.equal(active.mainPlaceCallBudget, 1);
assert.equal(active.inventoryCallBudget, 30);
assert.equal(active.totalCallBudget, 31);
assert.deepEqual(active.operationBudgets, {
  main_place: 1,
  booking_business: 3,
  booking_items: 3,
  daily_schedule: 24
});
assert.equal(Object.values(OPERATION_BUDGETS).reduce((sum, value) => sum + value, 0), 31);
assert.equal(active.concurrency, 1);
assert.equal(active.automaticRetry, false);
assert.equal(active.automaticFallback, false);
assert.equal(active.collectRegional, false);
assert.equal(active.collectOta, false);
assert.equal(active.collectCouponPage, false);
assert.equal(active.collectBookingStock, true);
assert.equal(active.collectRevenueEstimate, true);
assert.equal(active.collectWeeklyRange, false);
assert.equal(active.bookingIdHtmlFallback, false);
assert.equal(active.historicalBookingIdFallback, false);
assert.equal(active.externalCallOnRead, false);
assert.equal(active.providerCircuitRequired, true);
assert.equal(active.saveRunOnSuccessOnly, true);
assert.equal(active.saveFailureRun, false);
assert.equal(active.missingValueImputation, false);
assert.equal(Object.isFrozen(active), true);
assert.equal(Object.isFrozen(active.operationBudgets), true);
assert.equal(Object.isFrozen(FIXED_INVENTORY_ACTIVATION), true);

for (const [label, override, blocker] of [
  ["local runtime", { environment: { ...previewEnvironment, RENDER: "false" } }, "preview_runtime_required"],
  ["production root", { environment: { ...previewEnvironment, PREVIEW_DATA_ROOT: "/var/data" } }, "preview_runtime_required"],
  ["B2B source", { collectionSource: "b2b_search" }, "admin_search_source_required"],
  ["B2B role", { sourceRole: "b2b" }, "admin_role_required"],
  ["company search", { searchMode: "company" }, "keyword_search_required"],
  ["fast mode", { collectionMode: "fast" }, "precision_collection_mode_required"],
  ["basic collection", { collectionPurpose: "basic_db" }, "revenue_detail_purpose_required"]
]) {
  const inactive = resolveNaverLegacyInventoryActivation({ ...eligible, ...override });
  assert.equal(inactive.activationEnabled, false, label);
  assert.equal(inactive.actualCallsEnabled, false, label);
  assert.equal(inactive.strategy, "current", label);
  assert.equal(inactive.totalCallBudget, 0, label);
  assert.equal(inactive.blocker, blocker, label);
}

for (const override of [
  { maxInventoryCompanies: 4 },
  { observationDays: 7 },
  { maxProductsPerCompany: 9 },
  { mainPlaceCallBudget: 2 },
  { inventoryCallBudget: 31 },
  { totalCallBudget: 32 },
  { concurrency: 2 },
  { automaticRetry: true },
  { automaticFallback: true },
  { collectRegional: true },
  { collectOta: true },
  { collectWeeklyRange: true },
  { saveRunOnSuccessOnly: false },
  { saveFailureRun: true },
  { missingValueImputation: true },
  { operationBudgets: { ...OPERATION_BUDGETS, daily_schedule: 25 } }
]) {
  assert.throws(
    () => resolveNaverLegacyInventoryActivation({ ...eligible, ...override }),
    (error) => error.code === "NAVER_LEGACY_INVENTORY_CONTRACT_INVALID"
  );
}

let ledger = createNaverLegacyInventoryCallLedger();
assert.equal(validateNaverLegacyInventoryCallLedger(ledger), ledger);
assert.throws(
  () => reserveNaverLegacyInventoryCall(ledger, "booking_business", 1),
  (error) => error.code === "NAVER_LEGACY_INVENTORY_CALL_SEQUENCE_INVALID"
);
ledger = reserveNaverLegacyInventoryCall(ledger, "main_place");
assert.throws(
  () => reserveNaverLegacyInventoryCall(ledger, "main_place"),
  (error) => error.code === "NAVER_LEGACY_INVENTORY_CALL_BUDGET_EXCEEDED"
);

for (let companyOrdinal = 1; companyOrdinal <= 3; companyOrdinal += 1) {
  assert.throws(
    () => reserveNaverLegacyInventoryCall(ledger, "booking_items", companyOrdinal),
    (error) => error.code === "NAVER_LEGACY_INVENTORY_CALL_SEQUENCE_INVALID"
  );
  ledger = reserveNaverLegacyInventoryCall(ledger, "booking_business", companyOrdinal);
  ledger = reserveNaverLegacyInventoryCall(ledger, "booking_items", companyOrdinal);
  for (let productOrdinal = 1; productOrdinal <= 8; productOrdinal += 1) {
    ledger = reserveNaverLegacyInventoryCall(ledger, "daily_schedule", companyOrdinal);
  }
}
assert.equal(ledger.mainPlace, 1);
assert.deepEqual(ledger.inventory, { bookingBusiness: 3, bookingItems: 3, dailySchedule: 24 });
assert.equal(ledger.inventoryTotal, 30);
assert.equal(ledger.total, 31);
assert.equal(Object.isFrozen(ledger), true);
assert.throws(
  () => reserveNaverLegacyInventoryCall(ledger, "daily_schedule", 3),
  (error) => error.code === "NAVER_LEGACY_INVENTORY_CALL_BUDGET_EXCEEDED"
);
assert.throws(
  () => reserveNaverLegacyInventoryCall(ledger, "booking_business", 4),
  (error) => error.code === "NAVER_LEGACY_INVENTORY_LEDGER_INVALID"
);

const ready = buildNaverLegacyInventoryObservation({
  providerSucceeded: true,
  observed: true,
  rawValue: 7,
  sampleCount: 8,
  coverage: 1
});
assert.equal(ready.status, "ready");
assert.equal(ready.rawValue, 7);
assert.equal(ready.normalizedValue, 7);
assert.equal(ready.imputed, false);

const zero = buildNaverLegacyInventoryObservation({
  providerSucceeded: true,
  observed: true,
  rawValue: 0,
  sampleCount: 8,
  coverage: 1
});
assert.equal(zero.status, "zero");
assert.equal(zero.rawValue, 0);
assert.equal(zero.normalizedValue, 0);

const missing = buildNaverLegacyInventoryObservation({
  providerSucceeded: false,
  observed: false,
  rawValue: null,
  sampleCount: 0,
  coverage: null
});
assert.equal(missing.status, "missing");
assert.equal(missing.rawValue, null);
assert.equal(missing.normalizedValue, null);
assert.equal(missing.imputed, false);
assert.notEqual(zero.status, missing.status, "an observed zero must never collapse into missing");

const partial = buildNaverLegacyInventoryObservation({
  providerSucceeded: true,
  observed: true,
  rawValue: 4,
  sampleCount: 4,
  coverage: 0.5,
  penalties: ["product_coverage_partial"]
});
assert.equal(partial.status, "partial");
assert.equal(partial.normalizedValue, 4);
assert.throws(
  () => buildNaverLegacyInventoryObservation({ providerSucceeded: false, observed: false, rawValue: 0 }),
  (error) => error.code === "NAVER_LEGACY_INVENTORY_OBSERVATION_INVALID",
  "zero without a successful observation must fail closed"
);
assert.throws(
  () => buildNaverLegacyInventoryObservation({ providerSucceeded: true, observed: true, rawValue: -1, sampleCount: 1, coverage: 1 }),
  (error) => error.code === "NAVER_LEGACY_INVENTORY_OBSERVATION_INVALID"
);
assert.throws(
  () => buildNaverLegacyInventoryObservation({ providerSucceeded: true, observed: true, rawValue: 1, sampleCount: 0, coverage: 1 }),
  (error) => error.code === "NAVER_LEGACY_INVENTORY_OBSERVATION_INVALID"
);

const successfulPersistence = decideNaverLegacyInventoryRunPersistence({
  mainPlaceReady: true,
  executionSucceeded: true,
  providerBlocked: false,
  failureCode: "",
  manifestValid: true,
  atomicPublishReady: true,
  callLedger: ledger,
  observations: [
    { providerSucceeded: true, observed: true, rawValue: 7, sampleCount: 8, coverage: 1 },
    { providerSucceeded: true, observed: true, rawValue: 0, sampleCount: 8, coverage: 1 },
    { providerSucceeded: true, observed: true, rawValue: 3, sampleCount: 8, coverage: 1 }
  ]
});
assert.equal(successfulPersistence.saveRun, true);
assert.equal(successfulPersistence.saveFailureRun, false);
assert.equal(successfulPersistence.dataStatus, "ready");
assert.equal(successfulPersistence.totalCallCount, 31);

for (const [label, override, blocker] of [
  ["main failure", { mainPlaceReady: false }, "main_place_not_ready"],
  ["execution failure", { executionSucceeded: false }, "execution_not_succeeded"],
  ["provider block", { providerBlocked: true }, "provider_blocked"],
  ["failure code", { failureCode: "NAVER_ACCESS_BLOCKED" }, "collection_failure_present"],
  ["manifest failure", { manifestValid: false }, "manifest_invalid"],
  ["atomic failure", { atomicPublishReady: false }, "atomic_publish_not_ready"]
]) {
  const decision = decideNaverLegacyInventoryRunPersistence({
    mainPlaceReady: true,
    executionSucceeded: true,
    providerBlocked: false,
    failureCode: "",
    manifestValid: true,
    atomicPublishReady: true,
    callLedger: ledger,
    observations: [],
    ...override
  });
  assert.equal(decision.saveRun, false, label);
  assert.equal(decision.blocker, blocker, label);
}

for (const [label, observations] of [
  ["missing inventory", [
    { providerSucceeded: true, observed: true, rawValue: 1, sampleCount: 8, coverage: 1 },
    { providerSucceeded: true, observed: true, rawValue: 0, sampleCount: 8, coverage: 1 },
    { providerSucceeded: false, observed: false, rawValue: null, sampleCount: 0, coverage: null }
  ]],
  ["partial inventory", [
    { providerSucceeded: true, observed: true, rawValue: 1, sampleCount: 8, coverage: 1 },
    { providerSucceeded: true, observed: true, rawValue: 0, sampleCount: 8, coverage: 1 },
    { providerSucceeded: true, observed: true, rawValue: 2, sampleCount: 4, coverage: 0.5, penalties: ["partial"] }
  ]],
  ["too few inventory companies", [
    { providerSucceeded: true, observed: true, rawValue: 1, sampleCount: 8, coverage: 1 },
    { providerSucceeded: true, observed: true, rawValue: 0, sampleCount: 8, coverage: 1 }
  ]]
]) {
  const decision = decideNaverLegacyInventoryRunPersistence({
    mainPlaceReady: true,
    executionSucceeded: true,
    providerBlocked: false,
    failureCode: "",
    manifestValid: true,
    atomicPublishReady: true,
    callLedger: ledger,
    observations
  });
  assert.equal(decision.saveRun, false, label);
  assert.equal(decision.blocker, "inventory_not_terminal", label);
}

const expectedOutputDir = "/var/data/v2-preview-runtime/outputs/gyeongnam_glamping_fixture";
const validManifest = {
  documentType: "lodging-collection-manifest",
  outputDir: expectedOutputDir,
  collectorStrategy: "legacy_candidate",
  collectorScope: "main_place_with_booking_inventory",
  collectorActivationProfile: "preview-admin-keyword-legacy-inventory-pilot.v1",
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
    inventory: {
      bookingBusiness: 3,
      bookingItems: 3,
      dailySchedule: 24,
      total: 30
    },
    total: 31
  },
  providerRequestCount: 31,
  providerCompanyCallCounts: {
    1: { bookingBusiness: 1, bookingItems: 1, dailySchedule: 8 },
    2: { bookingBusiness: 1, bookingItems: 1, dailySchedule: 8 },
    3: { bookingBusiness: 1, bookingItems: 1, dailySchedule: 8 }
  },
  inventoryResultCounts: {
    planned: 3,
    ready: 3,
    zero: 0,
    missing: 0,
    partial: 0
  },
  inventoryTargetResults: [
    { companyOrdinal: 1, status: "ready", bookingBusiness: 1, bookingItems: 1, dailySchedule: 8 },
    { companyOrdinal: 2, status: "ready", bookingBusiness: 1, bookingItems: 1, dailySchedule: 8 },
    { companyOrdinal: 3, status: "ready", bookingBusiness: 1, bookingItems: 1, dailySchedule: 8 }
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

const manifestProjection = validateNaverLegacyInventoryRunManifest(validManifest, {
  expectedOutputDir,
  outputPathIsFinal: true
});
assert.deepEqual(manifestProjection, {
  outputDir: expectedOutputDir,
  mainPlaceCallCount: 1,
  inventoryCallCount: 30,
  totalCallCount: 31,
  planned: 3,
  ready: 3,
  zero: 0,
  missing: 0,
  partial: 0,
  dataStatus: "ready"
});
assert.equal(Object.isFrozen(manifestProjection), true);

const allZeroManifest = JSON.parse(JSON.stringify(validManifest));
allZeroManifest.inventoryResultCounts = { planned: 3, ready: 0, zero: 3, missing: 0, partial: 0 };
allZeroManifest.providerCallCounts.inventory = { bookingBusiness: 0, bookingItems: 0, dailySchedule: 0, total: 0 };
allZeroManifest.providerCallCounts.total = 1;
allZeroManifest.providerRequestCount = 1;
allZeroManifest.providerMaxObservedConcurrency = 0;
allZeroManifest.providerCompanyCallCounts = {
  1: { bookingBusiness: 0, bookingItems: 0, dailySchedule: 0 },
  2: { bookingBusiness: 0, bookingItems: 0, dailySchedule: 0 },
  3: { bookingBusiness: 0, bookingItems: 0, dailySchedule: 0 }
};
allZeroManifest.inventoryTargetResults = [
  { companyOrdinal: 1, status: "zero", bookingBusiness: 0, bookingItems: 0, dailySchedule: 0 },
  { companyOrdinal: 2, status: "zero", bookingBusiness: 0, bookingItems: 0, dailySchedule: 0 },
  { companyOrdinal: 3, status: "zero", bookingBusiness: 0, bookingItems: 0, dailySchedule: 0 }
];
const allZeroProjection = validateNaverLegacyInventoryRunManifest(allZeroManifest, {
  expectedOutputDir,
  outputPathIsFinal: true
});
assert.equal(allZeroProjection.dataStatus, "zero", "an explicit all-zero result is technically complete but remains semantically zero");
assert.equal(allZeroProjection.zero, 3);

function cloneManifest() {
  return JSON.parse(JSON.stringify(validManifest));
}

for (const [label, mutate] of [
  ["wrong profile", (value) => { value.collectorActivationProfile = "wrong"; }],
  ["wrong scope", (value) => { value.collectorScope = "main_place_only"; }],
  ["rank expansion", (value) => { value.detailRankRanges = "1-10"; }],
  ["day expansion", (value) => { value.bookingRangeDays = 7; }],
  ["date expansion", (value) => { value.checkOut = "2026-08-07"; }],
  ["product expansion", (value) => { value.maxProductsPerCompany = 9; }],
  ["concurrency expansion", (value) => { value.providerConcurrency = 2; }],
  ["observed concurrency expansion", (value) => { value.providerMaxObservedConcurrency = 2; }],
  ["declared total budget expansion", (value) => { value.totalCallBudget = 32; }],
  ["retry enabled", (value) => { value.automaticRetry = true; }],
  ["fallback enabled", (value) => { value.automaticFallback = true; }],
  ["regional enabled", (value) => { value.collectionProfileFlags.collectRegional = true; }],
  ["OTA enabled", (value) => { value.collectionProfileFlags.collectOta = true; }],
  ["main call expansion", (value) => { value.providerCallCounts.mainPlace = 2; value.providerCallCounts.total = 32; }],
  ["inventory budget expansion", (value) => { value.providerCallCounts.inventory.dailySchedule = 25; value.providerCallCounts.inventory.total = 31; value.providerCallCounts.total = 32; }],
  ["phase sum mismatch", (value) => { value.providerCallCounts.inventory.total = 29; }],
  ["total sum mismatch", (value) => { value.providerCallCounts.total = 30; }],
  ["provider request count mismatch", (value) => { value.providerRequestCount = 30; }],
  ["company schedule expansion", (value) => { value.providerCompanyCallCounts[1].dailySchedule = 9; }],
  ["target call mismatch", (value) => { value.inventoryTargetResults[0].dailySchedule = 7; }],
  ["main result not exact 50", (value) => { value.counts.naverOverall = 49; }],
  ["planned not exact top three", (value) => { value.inventoryResultCounts.planned = 2; value.inventoryResultCounts.ready = 1; }],
  ["planned mismatch", (value) => { value.inventoryResultCounts.ready = 1; }],
  ["missing admitted", (value) => { value.inventoryResultCounts.ready = 1; value.inventoryResultCounts.missing = 1; }],
  ["partial admitted", (value) => { value.inventoryResultCounts.ready = 1; value.inventoryResultCounts.partial = 1; }],
  ["regional result", (value) => { value.counts.naverRegional = 1; }],
  ["OTA result", (value) => { value.counts.nolFirstPage = 1; }],
  ["failure run save", (value) => { value.saveFailureRun = true; }]
]) {
  const invalid = cloneManifest();
  mutate(invalid);
  assert.throws(
    () => validateNaverLegacyInventoryRunManifest(invalid, { expectedOutputDir, outputPathIsFinal: true }),
    (error) => error.code === "NAVER_LEGACY_INVENTORY_MANIFEST_INVALID",
    label
  );
}
assert.throws(
  () => validateNaverLegacyInventoryRunManifest(validManifest, { expectedOutputDir: `${expectedOutputDir}-other`, outputPathIsFinal: true }),
  (error) => error.code === "NAVER_LEGACY_INVENTORY_MANIFEST_INVALID"
);
assert.throws(
  () => validateNaverLegacyInventoryRunManifest(validManifest, { expectedOutputDir, outputPathIsFinal: false }),
  (error) => error.code === "NAVER_LEGACY_INVENTORY_MANIFEST_INVALID"
);

const source = fs.readFileSync(path.join(ROOT, "scripts", "naver_legacy_inventory_activation.cjs"), "utf8");
assert.doesNotMatch(source, /require\(["']node:(?:fs|child_process|http|https|net|tls)["']\)/u);
assert.doesNotMatch(source, /\bfetch\s*\(/u);
assert.doesNotMatch(source, /process\.env/u);

console.log("NAVER legacy inventory limited activation contract fixtures passed.");
