"use strict";

const crypto = require("node:crypto");
const {
  FIXED_INVENTORY_ACTIVATION,
  OPERATION_BUDGETS: NAVER_OPERATION_BUDGETS
} = require("./naver_legacy_inventory_activation.cjs");

const V2_COLLECTOR_COMPATIBILITY_SCHEMA_VERSION = "v2-collector-compatibility.v1";
const V2_COLLECTOR_COMPATIBILITY_PROFILE = "preview-admin-v2-collector-compatibility.v1";
const V2_COLLECTOR_COMPATIBILITY_STRATEGY = "v2_legacy_4e4e190";
const V2_COLLECTOR_TRANSPORT_STRATEGY = "legacy_candidate";
const V2_COLLECTOR_COMPATIBILITY_SCOPE = "main_place_top3_inventory_ota";
const V2_HISTORICAL_COMMIT = "4e4e1906e2967fe58df66f8ad67f832043d2763b";
const V2_HISTORICAL_COLLECTOR_BLOB = "bcbe229998da3afa6f31ee04375fb0766019e56f";
const V2_PREVIEW_DATA_ROOT = "/var/data/v2-preview-runtime";

const OTA_OPERATION_BUDGETS = Object.freeze({
  nol_count: 1,
  nol_list: 1,
  yeogi_status: 1,
  ddnayo_exact: 1,
  ddnayo_normalized: 1
});

const OTA_REQUEST_DESCRIPTORS = Object.freeze([
  Object.freeze({ operation: "nol_count", providerId: "nol", method: "POST", requestOrdinal: 1 }),
  Object.freeze({ operation: "nol_list", providerId: "nol", method: "POST", requestOrdinal: 2 }),
  Object.freeze({ operation: "yeogi_status", providerId: "yeogi", method: "GET", requestOrdinal: 3 }),
  Object.freeze({ operation: "ddnayo_exact", providerId: "ddnayo", method: "GET", requestOrdinal: 4 }),
  Object.freeze({ operation: "ddnayo_normalized", providerId: "ddnayo", method: "GET", requestOrdinal: 5 })
]);

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

const FIXED_V2_COLLECTOR_COMPATIBILITY = deepFreeze({
  schemaVersion: V2_COLLECTOR_COMPATIBILITY_SCHEMA_VERSION,
  activationProfile: V2_COLLECTOR_COMPATIBILITY_PROFILE,
  strategy: V2_COLLECTOR_COMPATIBILITY_STRATEGY,
  transportStrategy: V2_COLLECTOR_TRANSPORT_STRATEGY,
  collectorScope: V2_COLLECTOR_COMPATIBILITY_SCOPE,
  historicalSourceCommit: V2_HISTORICAL_COMMIT,
  historicalCollectorBlob: V2_HISTORICAL_COLLECTOR_BLOB,
  collectionPurpose: "revenue_detail",
  collectionMode: "precision",
  searchMode: "keyword",
  productMode: "all",
  mainPlaceRankStart: FIXED_INVENTORY_ACTIVATION.mainPlaceRankStart,
  mainPlaceRankEnd: FIXED_INVENTORY_ACTIVATION.mainPlaceRankEnd,
  inventoryRankStart: FIXED_INVENTORY_ACTIVATION.inventoryRankStart,
  inventoryRankEnd: FIXED_INVENTORY_ACTIVATION.inventoryRankEnd,
  maxInventoryCompanies: FIXED_INVENTORY_ACTIVATION.maxInventoryCompanies,
  observationDays: FIXED_INVENTORY_ACTIVATION.observationDays,
  maxProductsPerCompany: FIXED_INVENTORY_ACTIVATION.maxProductsPerCompany,
  naverOperationBudgets: NAVER_OPERATION_BUDGETS,
  mainPlaceCallBudget: FIXED_INVENTORY_ACTIVATION.mainPlaceCallBudget,
  inventoryCallBudget: FIXED_INVENTORY_ACTIVATION.inventoryCallBudget,
  naverCallBudget: FIXED_INVENTORY_ACTIVATION.totalCallBudget,
  otaOperationBudgets: OTA_OPERATION_BUDGETS,
  otaCallBudget: Object.values(OTA_OPERATION_BUDGETS).reduce((sum, value) => sum + value, 0),
  totalExternalCallBudget: FIXED_INVENTORY_ACTIVATION.totalCallBudget
    + Object.values(OTA_OPERATION_BUDGETS).reduce((sum, value) => sum + value, 0),
  concurrency: FIXED_INVENTORY_ACTIVATION.concurrency,
  automaticRetry: false,
  automaticFallback: false,
  collectRegional: false,
  collectOta: true,
  collectBookingStock: true,
  collectRevenueEstimate: true,
  collectWeeklyRange: false,
  collectCouponPage: false,
  bookingIdHtmlFallback: false,
  historicalBookingIdFallback: false,
  externalCallOnRead: false,
  providerCircuitRequired: true,
  otaRequiresMainPlaceReady: true,
  saveRunOnSuccessOnly: true,
  saveFailureRun: false,
  missingValueImputation: false,
  phaseOrder: Object.freeze(["main_place", "ota", "inventory", "publish"])
});

const FIXED_CONTRACT_FIELDS = Object.freeze({
  searchMode: "keyword",
  collectionMode: "precision",
  collectionPurpose: "revenue_detail",
  productMode: "all"
});

const OTA_TERMINAL_STATUSES = Object.freeze({
  nol_count: new Set(["ready", "zero"]),
  nol_list: new Set(["ready", "zero"]),
  yeogi_status: new Set(["ready", "zero", "provider_blocked"]),
  ddnayo_exact: new Set(["ready", "zero"]),
  ddnayo_normalized: new Set(["ready", "zero"])
});

class V2CollectorCompatibilityError extends Error {
  constructor(code, message, statusCode = 400) {
    super(message);
    this.name = "V2CollectorCompatibilityError";
    this.code = code;
    this.statusCode = statusCode;
    this.retryable = false;
  }
}

function v2CollectorCompatibilityError(code, message, statusCode = 400) {
  return new V2CollectorCompatibilityError(code, message, statusCode);
}

function normalizedToken(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizedDate(value, fieldName) {
  const date = String(value || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(date)) {
    throw v2CollectorCompatibilityError(
      "V2_COLLECTOR_COMPATIBILITY_CONTRACT_INVALID",
      `V2 collector compatibility ${fieldName} is invalid`
    );
  }
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
    throw v2CollectorCompatibilityError(
      "V2_COLLECTOR_COMPATIBILITY_CONTRACT_INVALID",
      `V2 collector compatibility ${fieldName} is invalid`
    );
  }
  return date;
}

function normalizedKeywordHash(value) {
  const keyword = String(value || "").normalize("NFC").trim().replace(/\s+/gu, " ");
  if (!keyword || keyword.length > 120 || /[\u0000-\u001f\u007f]/u.test(keyword)) {
    throw v2CollectorCompatibilityError(
      "V2_COLLECTOR_COMPATIBILITY_CONTRACT_INVALID",
      "V2 collector compatibility keyword is invalid"
    );
  }
  return crypto.createHash("sha256").update(keyword).digest("hex");
}

function previewRuntimeMatches(environment = {}) {
  return Boolean(environment)
    && typeof environment === "object"
    && !Array.isArray(environment)
    && environment.EXACT_V2_PREVIEW_RUNTIME === true
    && environment.RENDER === "true"
    && environment.PREVIEW_DATA_ROOT === V2_PREVIEW_DATA_ROOT;
}

function activationBlockers(input = {}) {
  const blockers = [];
  if (!previewRuntimeMatches(input.environment || input.env || {})) blockers.push("preview_runtime_required");
  if (normalizedToken(input.collectionSource) !== "admin_search") blockers.push("admin_search_source_required");
  if (normalizedToken(input.sourceRole) !== "admin") blockers.push("admin_role_required");
  for (const [field, expected] of Object.entries(FIXED_CONTRACT_FIELDS)) {
    if (normalizedToken(input[field]) !== expected) blockers.push(`${field}_required`);
  }
  return Object.freeze(blockers);
}

function normalizedCompatibilityContract(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw v2CollectorCompatibilityError(
      "V2_COLLECTOR_COMPATIBILITY_CONTRACT_INVALID",
      "V2 collector compatibility contract is invalid"
    );
  }
  const checkIn = normalizedDate(input.checkIn, "check-in date");
  const checkOut = normalizedDate(input.checkOut, "check-out date");
  if (checkIn !== checkOut) {
    throw v2CollectorCompatibilityError(
      "V2_COLLECTOR_COMPATIBILITY_CONTRACT_INVALID",
      "V2 collector compatibility observation period must be exactly one day"
    );
  }
  for (const [field, expected] of Object.entries(FIXED_CONTRACT_FIELDS)) {
    if (normalizedToken(input[field]) !== expected) {
      throw v2CollectorCompatibilityError(
        "V2_COLLECTOR_COMPATIBILITY_CONTRACT_INVALID",
        `V2 collector compatibility ${field} is invalid`
      );
    }
  }
  const rankStart = Number(input.rankStart ?? FIXED_V2_COLLECTOR_COMPATIBILITY.mainPlaceRankStart);
  const rankEnd = Number(input.rankEnd ?? FIXED_V2_COLLECTOR_COMPATIBILITY.mainPlaceRankEnd);
  const detailRankStart = Number(input.detailRankStart ?? FIXED_V2_COLLECTOR_COMPATIBILITY.inventoryRankStart);
  const detailRankEnd = Number(input.detailRankEnd ?? FIXED_V2_COLLECTOR_COMPATIBILITY.inventoryRankEnd);
  if (
    rankStart !== FIXED_V2_COLLECTOR_COMPATIBILITY.mainPlaceRankStart
    || rankEnd !== FIXED_V2_COLLECTOR_COMPATIBILITY.mainPlaceRankEnd
    || detailRankStart !== FIXED_V2_COLLECTOR_COMPATIBILITY.inventoryRankStart
    || detailRankEnd !== FIXED_V2_COLLECTOR_COMPATIBILITY.inventoryRankEnd
  ) {
    throw v2CollectorCompatibilityError(
      "V2_COLLECTOR_COMPATIBILITY_CONTRACT_INVALID",
      "V2 collector compatibility ranking contract is invalid"
    );
  }
  return deepFreeze({
    schemaVersion: V2_COLLECTOR_COMPATIBILITY_SCHEMA_VERSION,
    keywordHash: normalizedKeywordHash(input.keyword),
    searchMode: "keyword",
    collectionMode: "precision",
    collectionPurpose: "revenue_detail",
    productMode: "all",
    checkIn,
    checkOut,
    measurementPeriod: Object.freeze({ start: checkIn, end: checkOut }),
    rankStart,
    rankEnd,
    detailRankStart,
    detailRankEnd
  });
}

function resolveV2CollectorCompatibilityActivation(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw v2CollectorCompatibilityError(
      "V2_COLLECTOR_COMPATIBILITY_ACTIVATION_INVALID",
      "V2 collector compatibility activation input is invalid"
    );
  }
  const blockers = activationBlockers(input);
  if (blockers.length) {
    return deepFreeze({
      schemaVersion: V2_COLLECTOR_COMPATIBILITY_SCHEMA_VERSION,
      activationProfile: V2_COLLECTOR_COMPATIBILITY_PROFILE,
      activationEnabled: false,
      executionEligible: false,
      actualCallsEnabled: false,
      strategy: "current",
      transportStrategy: "current",
      collectorScope: "current",
      blocker: blockers[0],
      blockers
    });
  }
  const contract = normalizedCompatibilityContract(input);
  return deepFreeze({
    ...FIXED_V2_COLLECTOR_COMPATIBILITY,
    activationEnabled: true,
    executionEligible: true,
    actualCallsEnabled: true,
    blocker: null,
    blockers: Object.freeze([]),
    contract
  });
}

function positiveInteger(value, fieldName, max = Number.MAX_SAFE_INTEGER) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0 || number > max) {
    throw v2CollectorCompatibilityError(
      "V2_COLLECTOR_COMPATIBILITY_RESULT_INVALID",
      `V2 collector compatibility ${fieldName} is invalid`,
      502
    );
  }
  return number;
}

function mainPlaceProjection(snapshot = {}) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    throw v2CollectorCompatibilityError(
      "V2_COLLECTOR_COMPATIBILITY_MAIN_INVALID",
      "V2 collector compatibility main Place result is invalid",
      502
    );
  }
  const items = Array.isArray(snapshot.items) ? snapshot.items : [];
  const executedTransportCount = Number(
    snapshot.executedTransportCount
      ?? snapshot.mainPlaceRequestCount
      ?? snapshot.provenance?.executedFixtureTransportCount
  );
  if (
    snapshot.status !== "ready"
    || String(snapshot.strategy || "") !== V2_COLLECTOR_TRANSPORT_STRATEGY
    || executedTransportCount !== 1
    || Number(snapshot.sampleCount) !== 50
    || items.length !== 50
  ) {
    throw v2CollectorCompatibilityError(
      "V2_COLLECTOR_COMPATIBILITY_MAIN_INVALID",
      "V2 collector compatibility main Place result is not a complete 1-50 snapshot",
      502
    );
  }
  const seen = new Set();
  const ranks = items.map((item, index) => {
    const rank = Number(item?.rank);
    const placeId = String(item?.placeId || "").trim();
    if (rank !== index + 1 || !placeId || placeId.length > 160 || seen.has(placeId)) {
      throw v2CollectorCompatibilityError(
        "V2_COLLECTOR_COMPATIBILITY_MAIN_INVALID",
        "V2 collector compatibility main Place ranks are invalid",
        502
      );
    }
    seen.add(placeId);
    return deepFreeze({ rank, placeId });
  });
  return deepFreeze({
    status: "ready",
    transportStrategy: V2_COLLECTOR_TRANSPORT_STRATEGY,
    organicCount: 50,
    mainPlaceRequestCount: 1,
    ranks,
    detailTargets: ranks.slice(0, FIXED_V2_COLLECTOR_COMPATIBILITY.maxInventoryCompanies)
  });
}

function mainPlaceReady(snapshot) {
  try {
    mainPlaceProjection(snapshot);
    return true;
  } catch {
    return false;
  }
}

function buildV2CollectorCompatibilityRequestPlan(input = {}) {
  const contract = normalizedCompatibilityContract(input.contract || input);
  const canReleaseOta = mainPlaceReady(input.mainPlaceSnapshot);
  const mainPlace = deepFreeze({
    phase: "main_place",
    providerId: "naver_place_search",
    operation: "naver_place_rank_main",
    transportStrategy: V2_COLLECTOR_TRANSPORT_STRATEGY,
    rankStart: 1,
    rankEnd: 50,
    display: 50,
    maxRequests: 1,
    automaticRetry: false,
    automaticFallback: false,
    actualCallsEnabled: false,
    externalCallOnRead: false
  });
  const ota = OTA_REQUEST_DESCRIPTORS.map((descriptor) => deepFreeze({
    ...descriptor,
    phase: "ota",
    dependsOn: "main_place_ready",
    executionState: canReleaseOta ? "eligible" : "blocked",
    blocker: canReleaseOta ? null : "main_place_not_ready",
    maxRequests: 1,
    automaticRetry: false,
    automaticFallback: false,
    actualCallsEnabled: false,
    externalCallOnRead: false
  }));
  return deepFreeze({
    schemaVersion: V2_COLLECTOR_COMPATIBILITY_SCHEMA_VERSION,
    strategy: V2_COLLECTOR_COMPATIBILITY_STRATEGY,
    transportStrategy: V2_COLLECTOR_TRANSPORT_STRATEGY,
    activationProfile: V2_COLLECTOR_COMPATIBILITY_PROFILE,
    contractHash: crypto.createHash("sha256").update(JSON.stringify(contract)).digest("hex"),
    phaseOrder: FIXED_V2_COLLECTOR_COMPATIBILITY.phaseOrder,
    mainPlace,
    ota,
    otaEligible: canReleaseOta,
    regionalRequestCount: 0,
    plannedNaverRequestCount: FIXED_V2_COLLECTOR_COMPATIBILITY.naverCallBudget,
    plannedOtaRequestCount: FIXED_V2_COLLECTOR_COMPATIBILITY.otaCallBudget,
    plannedTotalExternalRequestCount: FIXED_V2_COLLECTOR_COMPATIBILITY.totalExternalCallBudget,
    actualCallsEnabled: false,
    authorizedCallCount: 0,
    executedCallCount: 0
  });
}

function normalizedInventoryResults(value, mainProjection) {
  if (!Array.isArray(value) || value.length !== FIXED_V2_COLLECTOR_COMPATIBILITY.maxInventoryCompanies) {
    throw v2CollectorCompatibilityError(
      "V2_COLLECTOR_COMPATIBILITY_INVENTORY_INVALID",
      "V2 collector compatibility inventory results are incomplete",
      502
    );
  }
  let bookingBusiness = 0;
  let bookingItems = 0;
  let dailySchedule = 0;
  const results = value.map((row, index) => {
    const companyOrdinal = Number(row?.companyOrdinal);
    const status = String(row?.status || "");
    const placeId = String(row?.placeId || "").trim();
    const calls = row?.calls && typeof row.calls === "object" && !Array.isArray(row.calls) ? row.calls : {};
    const business = positiveInteger(calls.bookingBusiness, `inventory ${index + 1} bookingBusiness`, 1);
    const items = positiveInteger(calls.bookingItems, `inventory ${index + 1} bookingItems`, 1);
    const schedules = positiveInteger(
      calls.dailySchedule,
      `inventory ${index + 1} dailySchedule`,
      FIXED_V2_COLLECTOR_COMPATIBILITY.maxProductsPerCompany
    );
    const expectedTarget = mainProjection.detailTargets[index];
    const callShapeValid = status === "ready"
      ? business === 1 && items === 1 && schedules >= 1
      : status === "zero" && (
          business === 0 && items === 0 && schedules === 0
          || business === 1 && items === 0 && schedules === 0
          || business === 1 && items === 1 && schedules === 0
        );
    if (
      companyOrdinal !== index + 1
      || !expectedTarget
      || placeId !== expectedTarget.placeId
      || !callShapeValid
    ) {
      throw v2CollectorCompatibilityError(
        "V2_COLLECTOR_COMPATIBILITY_INVENTORY_INVALID",
        "V2 collector compatibility inventory result contract failed",
        502
      );
    }
    bookingBusiness += business;
    bookingItems += items;
    dailySchedule += schedules;
    return deepFreeze({ companyOrdinal, placeId, status, calls: { bookingBusiness: business, bookingItems: items, dailySchedule: schedules } });
  });
  const total = bookingBusiness + bookingItems + dailySchedule;
  if (
    bookingBusiness > NAVER_OPERATION_BUDGETS.booking_business
    || bookingItems > NAVER_OPERATION_BUDGETS.booking_items
    || dailySchedule > NAVER_OPERATION_BUDGETS.daily_schedule
    || total > FIXED_V2_COLLECTOR_COMPATIBILITY.inventoryCallBudget
  ) {
    throw v2CollectorCompatibilityError(
      "V2_COLLECTOR_COMPATIBILITY_CALL_BUDGET_EXCEEDED",
      "V2 collector compatibility inventory call budget exceeded",
      502
    );
  }
  return deepFreeze({
    results,
    counts: { bookingBusiness, bookingItems, dailySchedule, total },
    ready: results.filter((row) => row.status === "ready").length,
    zero: results.filter((row) => row.status === "zero").length
  });
}

function normalizedOtaResults(value) {
  if (!Array.isArray(value) || value.length !== OTA_REQUEST_DESCRIPTORS.length) {
    throw v2CollectorCompatibilityError(
      "V2_COLLECTOR_COMPATIBILITY_OTA_INVALID",
      "V2 collector compatibility OTA results are incomplete",
      502
    );
  }
  const results = value.map((row, index) => {
    const expected = OTA_REQUEST_DESCRIPTORS[index];
    const operation = String(row?.operation || "");
    const status = String(row?.status || "");
    const requestCount = positiveInteger(row?.requestCount, `OTA ${index + 1} request count`, 1);
    if (
      operation !== expected.operation
      || Number(row?.requestOrdinal) !== expected.requestOrdinal
      || requestCount !== 1
      || !OTA_TERMINAL_STATUSES[operation]?.has(status)
    ) {
      throw v2CollectorCompatibilityError(
        "V2_COLLECTOR_COMPATIBILITY_OTA_INVALID",
        "V2 collector compatibility OTA result contract failed",
        502
      );
    }
    return deepFreeze({ operation, requestOrdinal: expected.requestOrdinal, status, requestCount });
  });
  return deepFreeze({
    results,
    requestCount: results.reduce((sum, row) => sum + row.requestCount, 0),
    providerBlockedObserved: results.some((row) => row.operation === "yeogi_status" && row.status === "provider_blocked")
  });
}

function failureWritePlan(blocker) {
  return deepFreeze({
    saveRun: false,
    saveFailureRun: false,
    updateCompanyMaster: false,
    appendInventoryHistory: false,
    appendRevenueHistory: false,
    blocker
  });
}

function decideV2CollectorCompatibilityPersistence(input = {}) {
  if (input.providerBlocked === true) return failureWritePlan("provider_blocked");
  if (String(input.failureCode || "").trim()) return failureWritePlan("collection_failure_present");
  let main;
  try {
    main = mainPlaceProjection(input.mainPlaceSnapshot);
  } catch {
    return failureWritePlan("main_place_not_ready");
  }
  let ota;
  try {
    ota = normalizedOtaResults(input.otaResults);
  } catch {
    return failureWritePlan("ota_not_terminal");
  }
  let inventory;
  try {
    inventory = normalizedInventoryResults(input.inventoryResults, main);
  } catch {
    return failureWritePlan("inventory_not_terminal");
  }
  if (input.executionSucceeded !== true) return failureWritePlan("execution_not_succeeded");
  if (input.manifestValid !== true) return failureWritePlan("manifest_invalid");
  if (input.atomicPublishReady !== true) return failureWritePlan("atomic_publish_not_ready");
  return deepFreeze({
    saveRun: true,
    saveFailureRun: false,
    updateCompanyMaster: true,
    appendInventoryHistory: true,
    appendRevenueHistory: true,
    blocker: null,
    mainPlaceRequestCount: main.mainPlaceRequestCount,
    inventoryRequestCount: inventory.counts.total,
    otaRequestCount: ota.requestCount,
    totalExternalRequestCount: main.mainPlaceRequestCount + inventory.counts.total + ota.requestCount
  });
}

function buildV2CollectorCompatibilityRunAdapter(input = {}) {
  const contract = normalizedCompatibilityContract(input.contract || {});
  const main = mainPlaceProjection(input.mainPlaceSnapshot);
  const ota = normalizedOtaResults(input.otaResults);
  const inventory = normalizedInventoryResults(input.inventoryResults, main);
  const naverRequestCount = main.mainPlaceRequestCount + inventory.counts.total;
  if (naverRequestCount > FIXED_V2_COLLECTOR_COMPATIBILITY.naverCallBudget) {
    throw v2CollectorCompatibilityError(
      "V2_COLLECTOR_COMPATIBILITY_CALL_BUDGET_EXCEEDED",
      "V2 collector compatibility NAVER call budget exceeded",
      502
    );
  }
  const manifest = deepFreeze({
    documentType: "lodging-collection-manifest",
    schemaVersion: 2,
    compatibilitySchemaVersion: V2_COLLECTOR_COMPATIBILITY_SCHEMA_VERSION,
    collectorActivationProfile: V2_COLLECTOR_COMPATIBILITY_PROFILE,
    collectorStrategy: V2_COLLECTOR_COMPATIBILITY_STRATEGY,
    collectorTransportStrategy: V2_COLLECTOR_TRANSPORT_STRATEGY,
    collectorScope: V2_COLLECTOR_COMPATIBILITY_SCOPE,
    historicalSourceCommit: V2_HISTORICAL_COMMIT,
    historicalCollectorBlob: V2_HISTORICAL_COLLECTOR_BLOB,
    keywordHash: contract.keywordHash,
    searchMode: contract.searchMode,
    collectionMode: contract.collectionMode,
    collectionPurpose: contract.collectionPurpose,
    productMode: contract.productMode,
    checkIn: contract.checkIn,
    checkOut: contract.checkOut,
    detailRankRanges: "1-3",
    collectionProfile: "revenue_detail_deep",
    collectionProfileFlags: {
      collectRegional: false,
      collectOta: true,
      collectBookingStock: true,
      collectWeeklyRange: false
    },
    automaticRetry: false,
    automaticFallback: false,
    externalRequestConcurrency: FIXED_V2_COLLECTOR_COMPATIBILITY.concurrency,
    saveRunOnSuccessOnly: true,
    saveFailureRun: false,
    revenueEstimateBasis: "naver_booking_public_inventory_estimate_not_settled_revenue",
    maxInventoryCompanies: FIXED_V2_COLLECTOR_COMPATIBILITY.maxInventoryCompanies,
    maxProductsPerCompany: FIXED_V2_COLLECTOR_COMPATIBILITY.maxProductsPerCompany,
    providerCallBudget: FIXED_V2_COLLECTOR_COMPATIBILITY.totalExternalCallBudget,
    naverCallBudget: FIXED_V2_COLLECTOR_COMPATIBILITY.naverCallBudget,
    otaCallBudget: FIXED_V2_COLLECTOR_COMPATIBILITY.otaCallBudget,
    providerRequestCount: naverRequestCount + ota.requestCount,
    providerCallCounts: {
      mainPlace: main.mainPlaceRequestCount,
      inventory: inventory.counts,
      ota: ota.requestCount,
      total: naverRequestCount + ota.requestCount
    },
    inventoryResultCounts: {
      planned: inventory.results.length,
      ready: inventory.ready,
      zero: inventory.zero,
      missing: 0,
      partial: 0
    },
    inventoryTargetResults: inventory.results,
    otaResultCounts: {
      planned: ota.results.length,
      terminal: ota.results.length,
      providerBlockedObserved: ota.providerBlockedObserved
    },
    otaResults: ota.results,
    counts: {
      naverOverall: main.organicCount,
      naverRegional: 0,
      naverBookingStockChecked: inventory.results.length,
      otaRequests: ota.requestCount
    }
  });
  validateV2CollectorCompatibilityRunManifest(manifest);
  const persistence = decideV2CollectorCompatibilityPersistence({
    mainPlaceSnapshot: input.mainPlaceSnapshot,
    otaResults: input.otaResults,
    inventoryResults: input.inventoryResults,
    executionSucceeded: true,
    manifestValid: true,
    atomicPublishReady: true,
    providerBlocked: false,
    failureCode: ""
  });
  return deepFreeze({
    manifest,
    run: {
      collectorStrategy: manifest.collectorStrategy,
      collectorTransportStrategy: manifest.collectorTransportStrategy,
      collectorScope: manifest.collectorScope,
      collectionPurpose: manifest.collectionPurpose,
      collectionMode: manifest.collectionMode,
      productMode: manifest.productMode,
      checkIn: manifest.checkIn,
      checkOut: manifest.checkOut,
      detailRankRanges: manifest.detailRankRanges,
      counts: manifest.counts
    },
    persistence
  });
}

function validateV2CollectorCompatibilityRunManifest(manifest = {}) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw v2CollectorCompatibilityError(
      "V2_COLLECTOR_COMPATIBILITY_MANIFEST_INVALID",
      "V2 collector compatibility manifest is invalid",
      502
    );
  }
  const flags = manifest.collectionProfileFlags;
  const calls = manifest.providerCallCounts;
  const inventory = calls?.inventory;
  const results = manifest.inventoryResultCounts;
  const counts = manifest.counts;
  const otaResults = Array.isArray(manifest.otaResults) ? manifest.otaResults : [];
  const expectedOtaOperations = OTA_REQUEST_DESCRIPTORS.map((row) => row.operation);
  const inventoryTargets = Array.isArray(manifest.inventoryTargetResults)
    ? manifest.inventoryTargetResults
    : [];
  const targetPlaceIds = new Set();
  let targetBookingBusiness = 0;
  let targetBookingItems = 0;
  let targetDailySchedule = 0;
  let targetReady = 0;
  let targetZero = 0;
  const inventoryTargetsValid = inventoryTargets.length === FIXED_V2_COLLECTOR_COMPATIBILITY.maxInventoryCompanies
    && inventoryTargets.every((row, index) => {
      const companyOrdinal = Number(row?.companyOrdinal);
      const placeId = String(row?.placeId || "").trim();
      const status = String(row?.status || "");
      const rowCalls = row?.calls && typeof row.calls === "object" && !Array.isArray(row.calls)
        ? row.calls
        : {};
      const business = Number(rowCalls.bookingBusiness);
      const items = Number(rowCalls.bookingItems);
      const schedules = Number(rowCalls.dailySchedule);
      const numbersValid = Number.isInteger(business) && business >= 0 && business <= 1
        && Number.isInteger(items) && items >= 0 && items <= 1
        && Number.isInteger(schedules) && schedules >= 0
        && schedules <= FIXED_V2_COLLECTOR_COMPATIBILITY.maxProductsPerCompany;
      const callShapeValid = status === "ready"
        ? business === 1 && items === 1 && schedules >= 1
        : status === "zero" && (
            business === 0 && items === 0 && schedules === 0
            || business === 1 && items === 0 && schedules === 0
            || business === 1 && items === 1 && schedules === 0
          );
      if (
        companyOrdinal !== index + 1
        || !placeId
        || targetPlaceIds.has(placeId)
        || !numbersValid
        || !callShapeValid
      ) return false;
      targetPlaceIds.add(placeId);
      targetBookingBusiness += business;
      targetBookingItems += items;
      targetDailySchedule += schedules;
      if (status === "ready") targetReady += 1;
      if (status === "zero") targetZero += 1;
      return true;
    });
  const valid = manifest.documentType === "lodging-collection-manifest"
    && Number(manifest.schemaVersion) === 2
    && manifest.compatibilitySchemaVersion === V2_COLLECTOR_COMPATIBILITY_SCHEMA_VERSION
    && manifest.collectorActivationProfile === V2_COLLECTOR_COMPATIBILITY_PROFILE
    && manifest.collectorStrategy === V2_COLLECTOR_COMPATIBILITY_STRATEGY
    && manifest.collectorTransportStrategy === V2_COLLECTOR_TRANSPORT_STRATEGY
    && manifest.collectorScope === V2_COLLECTOR_COMPATIBILITY_SCOPE
    && manifest.historicalSourceCommit === V2_HISTORICAL_COMMIT
    && manifest.historicalCollectorBlob === V2_HISTORICAL_COLLECTOR_BLOB
    && /^[a-f0-9]{64}$/u.test(String(manifest.keywordHash || ""))
    && manifest.searchMode === "keyword"
    && manifest.collectionMode === "precision"
    && manifest.collectionPurpose === "revenue_detail"
    && manifest.productMode === "all"
    && /^\d{4}-\d{2}-\d{2}$/u.test(String(manifest.checkIn || ""))
    && manifest.checkIn === manifest.checkOut
    && manifest.detailRankRanges === "1-3"
    && manifest.collectionProfile === "revenue_detail_deep"
    && flags?.collectRegional === false
    && flags?.collectOta === true
    && flags?.collectBookingStock === true
    && flags?.collectWeeklyRange === false
    && manifest.automaticRetry === false
    && manifest.automaticFallback === false
    && Number(manifest.externalRequestConcurrency) === FIXED_V2_COLLECTOR_COMPATIBILITY.concurrency
    && manifest.saveRunOnSuccessOnly === true
    && manifest.saveFailureRun === false
    && manifest.revenueEstimateBasis === "naver_booking_public_inventory_estimate_not_settled_revenue"
    && Number(manifest.maxInventoryCompanies) === FIXED_V2_COLLECTOR_COMPATIBILITY.maxInventoryCompanies
    && Number(manifest.maxProductsPerCompany) === FIXED_V2_COLLECTOR_COMPATIBILITY.maxProductsPerCompany
    && Number(manifest.providerCallBudget) === FIXED_V2_COLLECTOR_COMPATIBILITY.totalExternalCallBudget
    && Number(manifest.naverCallBudget) === FIXED_V2_COLLECTOR_COMPATIBILITY.naverCallBudget
    && Number(manifest.otaCallBudget) === FIXED_V2_COLLECTOR_COMPATIBILITY.otaCallBudget
    && Number(calls?.mainPlace) === 1
    && Number(inventory?.bookingBusiness) >= 0
    && Number(inventory?.bookingItems) >= 0
    && Number(inventory?.dailySchedule) >= 0
    && Number(inventory?.bookingBusiness) <= NAVER_OPERATION_BUDGETS.booking_business
    && Number(inventory?.bookingItems) <= NAVER_OPERATION_BUDGETS.booking_items
    && Number(inventory?.dailySchedule) <= NAVER_OPERATION_BUDGETS.daily_schedule
    && Number(inventory?.total) === Number(inventory?.bookingBusiness)
      + Number(inventory?.bookingItems)
      + Number(inventory?.dailySchedule)
    && Number(inventory?.bookingBusiness) === targetBookingBusiness
    && Number(inventory?.bookingItems) === targetBookingItems
    && Number(inventory?.dailySchedule) === targetDailySchedule
    && Number(inventory?.total) <= FIXED_V2_COLLECTOR_COMPATIBILITY.inventoryCallBudget
    && Number(calls?.ota) === FIXED_V2_COLLECTOR_COMPATIBILITY.otaCallBudget
    && Number(calls?.total) === 1 + Number(inventory?.total) + Number(calls?.ota)
    && Number(manifest.providerRequestCount) === Number(calls?.total)
    && Number(manifest.providerRequestCount) <= FIXED_V2_COLLECTOR_COMPATIBILITY.totalExternalCallBudget
    && Number(results?.planned) === FIXED_V2_COLLECTOR_COMPATIBILITY.maxInventoryCompanies
    && Number(results?.ready) + Number(results?.zero) === Number(results?.planned)
    && Number(results?.ready) === targetReady
    && Number(results?.zero) === targetZero
    && Number(results?.missing) === 0
    && Number(results?.partial) === 0
    && inventoryTargetsValid
    && Number(manifest.otaResultCounts?.planned) === FIXED_V2_COLLECTOR_COMPATIBILITY.otaCallBudget
    && Number(manifest.otaResultCounts?.terminal) === FIXED_V2_COLLECTOR_COMPATIBILITY.otaCallBudget
    && otaResults.length === FIXED_V2_COLLECTOR_COMPATIBILITY.otaCallBudget
    && otaResults.every((row, index) => row.operation === expectedOtaOperations[index]
      && Number(row.requestOrdinal) === index + 1
      && Number(row.requestCount) === 1
      && OTA_TERMINAL_STATUSES[row.operation]?.has(String(row.status || "")))
    && Number(counts?.naverOverall) === 50
    && Number(counts?.naverRegional) === 0
    && Number(counts?.naverBookingStockChecked) === 3
    && Number(counts?.otaRequests) === 5;
  if (!valid) {
    throw v2CollectorCompatibilityError(
      "V2_COLLECTOR_COMPATIBILITY_MANIFEST_INVALID",
      "V2 collector compatibility manifest failed closed",
      502
    );
  }
  return deepFreeze({
    strategy: manifest.collectorStrategy,
    transportStrategy: manifest.collectorTransportStrategy,
    mainPlaceRequestCount: 1,
    inventoryRequestCount: Number(inventory.total),
    otaRequestCount: Number(calls.ota),
    totalExternalRequestCount: Number(calls.total),
    saveRun: true
  });
}

module.exports = {
  FIXED_V2_COLLECTOR_COMPATIBILITY,
  OTA_OPERATION_BUDGETS,
  OTA_REQUEST_DESCRIPTORS,
  V2_COLLECTOR_COMPATIBILITY_PROFILE,
  V2_COLLECTOR_COMPATIBILITY_SCHEMA_VERSION,
  V2_COLLECTOR_COMPATIBILITY_SCOPE,
  V2_COLLECTOR_COMPATIBILITY_STRATEGY,
  V2_COLLECTOR_TRANSPORT_STRATEGY,
  V2CollectorCompatibilityError,
  activationBlockers,
  buildV2CollectorCompatibilityRequestPlan,
  buildV2CollectorCompatibilityRunAdapter,
  decideV2CollectorCompatibilityPersistence,
  mainPlaceProjection,
  normalizedCompatibilityContract,
  previewRuntimeMatches,
  resolveV2CollectorCompatibilityActivation,
  v2CollectorCompatibilityError,
  validateV2CollectorCompatibilityRunManifest
};
