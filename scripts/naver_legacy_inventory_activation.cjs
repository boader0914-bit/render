"use strict";

const NAVER_LEGACY_INVENTORY_SCHEMA_VERSION = "naver-legacy-inventory-activation.v1";
const NAVER_LEGACY_INVENTORY_PROFILE = "preview-admin-keyword-legacy-inventory-pilot.v1";
const NAVER_LEGACY_INVENTORY_STRATEGY = "legacy_candidate";
const NAVER_LEGACY_INVENTORY_SCOPE = "main_place_with_booking_inventory";
const NAVER_LEGACY_INVENTORY_PREVIEW_ROOT = "/var/data/v2-preview-runtime";

const OPERATION_BUDGETS = Object.freeze({
  main_place: 1,
  booking_business: 3,
  booking_items: 3,
  daily_schedule: 24
});

const FIXED_INVENTORY_ACTIVATION = deepFreeze({
  schemaVersion: NAVER_LEGACY_INVENTORY_SCHEMA_VERSION,
  activationProfile: NAVER_LEGACY_INVENTORY_PROFILE,
  strategy: NAVER_LEGACY_INVENTORY_STRATEGY,
  collectorScope: NAVER_LEGACY_INVENTORY_SCOPE,
  collectionPurpose: "revenue_detail",
  requestedCollectionMode: "precision",
  effectiveCollectionMode: "precision",
  mainPlaceRankStart: 1,
  mainPlaceRankEnd: 50,
  inventoryRankStart: 1,
  inventoryRankEnd: 3,
  maxInventoryCompanies: 3,
  observationDays: 1,
  maxProductsPerCompany: 8,
  mainPlaceCallBudget: 1,
  inventoryCallBudget: 30,
  totalCallBudget: 31,
  operationBudgets: OPERATION_BUDGETS,
  concurrency: 1,
  automaticRetry: false,
  automaticFallback: false,
  collectRegional: false,
  collectOta: false,
  collectCouponPage: false,
  collectBookingStock: true,
  collectRevenueEstimate: true,
  collectWeeklyRange: false,
  bookingIdHtmlFallback: false,
  historicalBookingIdFallback: false,
  externalCallOnRead: false,
  providerCircuitRequired: true,
  saveRunOnSuccessOnly: true,
  saveFailureRun: false,
  missingValueImputation: false
});

const FIXED_OVERRIDE_FIELDS = Object.freeze([
  "strategy",
  "collectorScope",
  "effectiveCollectionMode",
  "mainPlaceRankStart",
  "mainPlaceRankEnd",
  "inventoryRankStart",
  "inventoryRankEnd",
  "maxInventoryCompanies",
  "observationDays",
  "maxProductsPerCompany",
  "mainPlaceCallBudget",
  "inventoryCallBudget",
  "totalCallBudget",
  "concurrency",
  "automaticRetry",
  "automaticFallback",
  "collectRegional",
  "collectOta",
  "collectCouponPage",
  "collectBookingStock",
  "collectRevenueEstimate",
  "collectWeeklyRange",
  "bookingIdHtmlFallback",
  "historicalBookingIdFallback",
  "externalCallOnRead",
  "providerCircuitRequired",
  "saveRunOnSuccessOnly",
  "saveFailureRun",
  "missingValueImputation"
]);

class NaverLegacyInventoryActivationError extends Error {
  constructor(code, message, statusCode = 400) {
    super(message);
    this.name = "NaverLegacyInventoryActivationError";
    this.code = code;
    this.statusCode = statusCode;
    this.retryable = false;
  }
}

function inventoryError(code, message, statusCode = 400) {
  return new NaverLegacyInventoryActivationError(code, message, statusCode);
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

function normalizedToken(value) {
  return String(value || "").trim().toLowerCase();
}

function previewRuntimeMatches(environment = {}) {
  return Boolean(environment)
    && typeof environment === "object"
    && !Array.isArray(environment)
    && environment.EXACT_V2_PREVIEW_RUNTIME === true
    && environment.RENDER === "true"
    && environment.PREVIEW_DATA_ROOT === NAVER_LEGACY_INVENTORY_PREVIEW_ROOT;
}

function sameFixedValue(actual, expected) {
  if (actual === expected) return true;
  if (!actual || !expected || typeof actual !== "object" || typeof expected !== "object") return false;
  return JSON.stringify(actual) === JSON.stringify(expected);
}

function assertNoFixedOverride(input = {}) {
  for (const key of FIXED_OVERRIDE_FIELDS) {
    if (
      Object.prototype.hasOwnProperty.call(input, key)
      && !sameFixedValue(input[key], FIXED_INVENTORY_ACTIVATION[key])
    ) {
      throw inventoryError(
        "NAVER_LEGACY_INVENTORY_CONTRACT_INVALID",
        `NAVER legacy inventory fixed field ${key} cannot be overridden`
      );
    }
  }
  if (
    Object.prototype.hasOwnProperty.call(input, "operationBudgets")
    && !sameFixedValue(input.operationBudgets, OPERATION_BUDGETS)
  ) {
    throw inventoryError(
      "NAVER_LEGACY_INVENTORY_CONTRACT_INVALID",
      "NAVER legacy inventory operation budgets cannot be overridden"
    );
  }
}

function activationBlockers(input = {}) {
  const environment = input.environment || input.env || {};
  const blockers = [];
  if (!previewRuntimeMatches(environment)) blockers.push("preview_runtime_required");
  if (normalizedToken(input.collectionSource) !== "admin_search") blockers.push("admin_search_source_required");
  if (normalizedToken(input.sourceRole) !== "admin") blockers.push("admin_role_required");
  if (normalizedToken(input.searchMode) !== "keyword") blockers.push("keyword_search_required");
  if (normalizedToken(input.collectionMode) !== "precision") blockers.push("precision_collection_mode_required");
  if (normalizedToken(input.collectionPurpose) !== "revenue_detail") blockers.push("revenue_detail_purpose_required");
  return Object.freeze(blockers);
}

function assertNaverLegacyInventoryActivation(plan) {
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) {
    throw inventoryError("NAVER_LEGACY_INVENTORY_CONTRACT_INVALID", "NAVER legacy inventory plan is invalid");
  }
  for (const [key, expected] of Object.entries(FIXED_INVENTORY_ACTIVATION)) {
    if (!sameFixedValue(plan[key], expected)) {
      throw inventoryError(
        "NAVER_LEGACY_INVENTORY_CONTRACT_INVALID",
        `NAVER legacy inventory plan field ${key} is invalid`
      );
    }
  }
  if (
    plan.activationEnabled !== true
    || plan.executionEligible !== true
    || plan.actualCallsEnabled !== true
    || plan.blocker !== null
    || !Array.isArray(plan.blockers)
    || plan.blockers.length !== 0
    || plan.mainPlaceCallBudget + plan.inventoryCallBudget !== plan.totalCallBudget
    || Object.values(plan.operationBudgets).reduce((sum, value) => sum + value, 0) !== plan.totalCallBudget
    || plan.operationBudgets.daily_schedule !== plan.maxInventoryCompanies * plan.maxProductsPerCompany
  ) {
    throw inventoryError("NAVER_LEGACY_INVENTORY_CONTRACT_INVALID", "NAVER legacy inventory safety boundary is invalid");
  }
  return plan;
}

function resolveNaverLegacyInventoryActivation(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw inventoryError("NAVER_LEGACY_INVENTORY_CONTRACT_INVALID", "NAVER legacy inventory activation input is invalid");
  }
  assertNoFixedOverride(input);
  const blockers = activationBlockers(input);
  if (blockers.length) {
    return deepFreeze({
      schemaVersion: NAVER_LEGACY_INVENTORY_SCHEMA_VERSION,
      activationProfile: NAVER_LEGACY_INVENTORY_PROFILE,
      activationEnabled: false,
      executionEligible: false,
      actualCallsEnabled: false,
      strategy: "current",
      collectorScope: "current",
      mainPlaceCallBudget: 0,
      inventoryCallBudget: 0,
      totalCallBudget: 0,
      blocker: blockers[0],
      blockers
    });
  }
  return assertNaverLegacyInventoryActivation(deepFreeze({
    ...FIXED_INVENTORY_ACTIVATION,
    activationEnabled: true,
    executionEligible: true,
    actualCallsEnabled: true,
    blocker: null,
    blockers
  }));
}

function nonNegativeInteger(value, fieldName) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) {
    throw inventoryError("NAVER_LEGACY_INVENTORY_LEDGER_INVALID", `${fieldName} must be a non-negative integer`);
  }
  return number;
}

function createNaverLegacyInventoryCallLedger() {
  return deepFreeze({
    schemaVersion: NAVER_LEGACY_INVENTORY_SCHEMA_VERSION,
    mainPlace: 0,
    inventory: {
      bookingBusiness: 0,
      bookingItems: 0,
      dailySchedule: 0
    },
    companies: {},
    inventoryTotal: 0,
    total: 0
  });
}

function validateNaverLegacyInventoryCallLedger(ledger = {}) {
  if (!ledger || typeof ledger !== "object" || Array.isArray(ledger)) {
    throw inventoryError("NAVER_LEGACY_INVENTORY_LEDGER_INVALID", "NAVER legacy inventory call ledger is invalid");
  }
  const mainPlace = nonNegativeInteger(ledger.mainPlace, "mainPlace");
  const bookingBusiness = nonNegativeInteger(ledger.inventory?.bookingBusiness, "bookingBusiness");
  const bookingItems = nonNegativeInteger(ledger.inventory?.bookingItems, "bookingItems");
  const dailySchedule = nonNegativeInteger(ledger.inventory?.dailySchedule, "dailySchedule");
  const companies = ledger.companies && typeof ledger.companies === "object" && !Array.isArray(ledger.companies)
    ? ledger.companies
    : null;
  if (!companies) {
    throw inventoryError("NAVER_LEGACY_INVENTORY_LEDGER_INVALID", "NAVER legacy inventory company ledger is invalid");
  }
  let companyBookingBusiness = 0;
  let companyBookingItems = 0;
  let companyDailySchedule = 0;
  for (const [key, value] of Object.entries(companies)) {
    const ordinal = Number(key);
    if (!Number.isInteger(ordinal) || ordinal < 1 || ordinal > FIXED_INVENTORY_ACTIVATION.maxInventoryCompanies) {
      throw inventoryError("NAVER_LEGACY_INVENTORY_LEDGER_INVALID", "NAVER legacy inventory company ordinal is invalid");
    }
    const business = nonNegativeInteger(value?.bookingBusiness, `companies.${key}.bookingBusiness`);
    const items = nonNegativeInteger(value?.bookingItems, `companies.${key}.bookingItems`);
    const schedules = nonNegativeInteger(value?.dailySchedule, `companies.${key}.dailySchedule`);
    if (business > 1 || items > 1 || schedules > FIXED_INVENTORY_ACTIVATION.maxProductsPerCompany) {
      throw inventoryError("NAVER_LEGACY_INVENTORY_CALL_BUDGET_EXCEEDED", "NAVER legacy inventory per-company call budget exceeded");
    }
    if (items > business || schedules > 0 && items !== 1) {
      throw inventoryError("NAVER_LEGACY_INVENTORY_CALL_SEQUENCE_INVALID", "NAVER legacy inventory call sequence is invalid");
    }
    companyBookingBusiness += business;
    companyBookingItems += items;
    companyDailySchedule += schedules;
  }
  const inventoryTotal = bookingBusiness + bookingItems + dailySchedule;
  const total = mainPlace + inventoryTotal;
  if (
    mainPlace > OPERATION_BUDGETS.main_place
    || bookingBusiness > OPERATION_BUDGETS.booking_business
    || bookingItems > OPERATION_BUDGETS.booking_items
    || dailySchedule > OPERATION_BUDGETS.daily_schedule
    || inventoryTotal > FIXED_INVENTORY_ACTIVATION.inventoryCallBudget
    || total > FIXED_INVENTORY_ACTIVATION.totalCallBudget
  ) {
    throw inventoryError("NAVER_LEGACY_INVENTORY_CALL_BUDGET_EXCEEDED", "NAVER legacy inventory total call budget exceeded");
  }
  if (
    companyBookingBusiness !== bookingBusiness
    || companyBookingItems !== bookingItems
    || companyDailySchedule !== dailySchedule
    || nonNegativeInteger(ledger.inventoryTotal, "inventoryTotal") !== inventoryTotal
    || nonNegativeInteger(ledger.total, "total") !== total
  ) {
    throw inventoryError("NAVER_LEGACY_INVENTORY_LEDGER_INVALID", "NAVER legacy inventory call ledger totals do not match");
  }
  return ledger;
}

function reserveNaverLegacyInventoryCall(ledger, operation, companyOrdinal = null) {
  validateNaverLegacyInventoryCallLedger(ledger);
  const key = normalizedToken(operation);
  const next = JSON.parse(JSON.stringify(ledger));
  if (key === "main_place") {
    if (companyOrdinal !== null && companyOrdinal !== undefined) {
      throw inventoryError("NAVER_LEGACY_INVENTORY_LEDGER_INVALID", "main_place must not have a company ordinal");
    }
    next.mainPlace += 1;
  } else {
    const ordinal = Number(companyOrdinal);
    if (!Number.isInteger(ordinal) || ordinal < 1 || ordinal > FIXED_INVENTORY_ACTIVATION.maxInventoryCompanies) {
      throw inventoryError("NAVER_LEGACY_INVENTORY_LEDGER_INVALID", "inventory call company ordinal is invalid");
    }
    if (next.mainPlace !== 1) {
      throw inventoryError("NAVER_LEGACY_INVENTORY_CALL_SEQUENCE_INVALID", "main_place must complete before inventory calls");
    }
    const companyKey = String(ordinal);
    next.companies[companyKey] ||= { bookingBusiness: 0, bookingItems: 0, dailySchedule: 0 };
    if (key === "booking_business") {
      next.inventory.bookingBusiness += 1;
      next.companies[companyKey].bookingBusiness += 1;
    } else if (key === "booking_items") {
      next.inventory.bookingItems += 1;
      next.companies[companyKey].bookingItems += 1;
    } else if (key === "daily_schedule") {
      next.inventory.dailySchedule += 1;
      next.companies[companyKey].dailySchedule += 1;
    } else {
      throw inventoryError("NAVER_LEGACY_INVENTORY_LEDGER_INVALID", "NAVER legacy inventory operation is invalid");
    }
  }
  next.inventoryTotal = next.inventory.bookingBusiness + next.inventory.bookingItems + next.inventory.dailySchedule;
  next.total = next.mainPlace + next.inventoryTotal;
  validateNaverLegacyInventoryCallLedger(next);
  return deepFreeze(next);
}

function normalizePenaltyList(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => !String(item || "").trim())) {
    throw inventoryError("NAVER_LEGACY_INVENTORY_OBSERVATION_INVALID", "inventory penalties are invalid");
  }
  return [...new Set(value.map((item) => String(item).trim()))];
}

function buildNaverLegacyInventoryObservation(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw inventoryError("NAVER_LEGACY_INVENTORY_OBSERVATION_INVALID", "inventory observation input is invalid");
  }
  const providerSucceeded = input.providerSucceeded === true;
  const observed = input.observed === true;
  const rawMissing = input.rawValue === null || input.rawValue === undefined || input.rawValue === "";
  const penalties = normalizePenaltyList(input.penalties);
  const sampleCount = nonNegativeInteger(input.sampleCount ?? 0, "sampleCount");
  const coverage = input.coverage === null || input.coverage === undefined
    ? null
    : Number(input.coverage);
  if (coverage !== null && (!Number.isFinite(coverage) || coverage < 0 || coverage > 1)) {
    throw inventoryError("NAVER_LEGACY_INVENTORY_OBSERVATION_INVALID", "inventory observation coverage is invalid");
  }
  if (!providerSucceeded || !observed || rawMissing) {
    if (!rawMissing) {
      throw inventoryError("NAVER_LEGACY_INVENTORY_OBSERVATION_INVALID", "an unobserved inventory value must be null");
    }
    return deepFreeze({
      status: "missing",
      providerSucceeded,
      observed: false,
      sampleCount,
      coverage,
      rawValue: null,
      normalizedValue: null,
      penalties: penalties.length ? penalties : [providerSucceeded ? "value_not_observed" : "provider_not_succeeded"],
      imputed: false
    });
  }
  const rawValue = Number(input.rawValue);
  if (!Number.isFinite(rawValue) || rawValue < 0 || sampleCount < 1 || coverage === null) {
    throw inventoryError("NAVER_LEGACY_INVENTORY_OBSERVATION_INVALID", "an observed inventory value requires non-negative data, samples, and coverage");
  }
  const status = rawValue === 0
    ? "zero"
    : (coverage < 1 || penalties.length ? "partial" : "ready");
  return deepFreeze({
    status,
    providerSucceeded: true,
    observed: true,
    sampleCount,
    coverage,
    rawValue,
    normalizedValue: rawValue,
    penalties,
    imputed: false
  });
}

function decideNaverLegacyInventoryRunPersistence(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw inventoryError("NAVER_LEGACY_INVENTORY_PERSISTENCE_INVALID", "inventory persistence input is invalid");
  }
  const ledger = validateNaverLegacyInventoryCallLedger(input.callLedger || {});
  const observations = Array.isArray(input.observations)
    ? input.observations.map((item) => buildNaverLegacyInventoryObservation(item))
    : [];
  if (observations.length > FIXED_INVENTORY_ACTIVATION.maxInventoryCompanies) {
    throw inventoryError("NAVER_LEGACY_INVENTORY_PERSISTENCE_INVALID", "too many inventory company observations");
  }
  const blocker = input.mainPlaceReady !== true
    ? "main_place_not_ready"
    : (ledger.mainPlace !== 1
        ? "main_place_call_count_invalid"
        : (input.executionSucceeded !== true
            ? "execution_not_succeeded"
            : (input.providerBlocked === true
                ? "provider_blocked"
                : (String(input.failureCode || "").trim()
                    ? "collection_failure_present"
                    : (input.manifestValid !== true
                        ? "manifest_invalid"
                        : (input.atomicPublishReady !== true
                            ? "atomic_publish_not_ready"
                            : (observations.length !== FIXED_INVENTORY_ACTIVATION.maxInventoryCompanies
                                || observations.some((item) => !["ready", "zero"].includes(item.status))
                              ? "inventory_not_terminal"
                              : null)))))));
  const statuses = observations.map((item) => item.status);
  const dataStatus = !statuses.length || statuses.every((status) => status === "missing")
    ? "missing"
    : (statuses.some((status) => status === "missing" || status === "partial") ? "partial" : "ready");
  return deepFreeze({
    saveRun: blocker === null,
    saveFailureRun: false,
    blocker,
    dataStatus,
    observationStatuses: statuses,
    mainPlaceCallCount: ledger.mainPlace,
    inventoryCallCount: ledger.inventoryTotal,
    totalCallCount: ledger.total
  });
}

function requiredManifestInteger(value, fieldName) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) {
    throw inventoryError(
      "NAVER_LEGACY_INVENTORY_MANIFEST_INVALID",
      `NAVER legacy inventory manifest ${fieldName} is invalid`,
      502
    );
  }
  return number;
}

function validateNaverLegacyInventoryRunManifest(manifest = {}, options = {}) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw inventoryError("NAVER_LEGACY_INVENTORY_MANIFEST_INVALID", "NAVER legacy inventory manifest is invalid", 502);
  }
  const expectedOutputDir = String(options.expectedOutputDir || "").trim();
  const outputDir = String(manifest.outputDir || "").trim();
  if (!expectedOutputDir || outputDir !== expectedOutputDir || options.outputPathIsFinal !== true) {
    throw inventoryError(
      "NAVER_LEGACY_INVENTORY_MANIFEST_INVALID",
      "NAVER legacy inventory final output path is invalid",
      502
    );
  }
  const calls = manifest.providerCallCounts && typeof manifest.providerCallCounts === "object"
    ? manifest.providerCallCounts
    : null;
  const inventoryCalls = calls?.inventory && typeof calls.inventory === "object"
    ? calls.inventory
    : null;
  const results = manifest.inventoryResultCounts && typeof manifest.inventoryResultCounts === "object"
    ? manifest.inventoryResultCounts
    : null;
  const companyCalls = manifest.providerCompanyCallCounts && typeof manifest.providerCompanyCallCounts === "object"
    && !Array.isArray(manifest.providerCompanyCallCounts)
    ? manifest.providerCompanyCallCounts
    : null;
  const targetResults = Array.isArray(manifest.inventoryTargetResults)
    ? manifest.inventoryTargetResults
    : null;
  const flags = manifest.collectionProfileFlags && typeof manifest.collectionProfileFlags === "object"
    ? manifest.collectionProfileFlags
    : null;
  const counts = manifest.counts && typeof manifest.counts === "object" ? manifest.counts : null;
  if (!calls || !inventoryCalls || !results || !companyCalls || !targetResults || !flags || !counts) {
    throw inventoryError(
      "NAVER_LEGACY_INVENTORY_MANIFEST_INVALID",
      "NAVER legacy inventory manifest phase counts are missing",
      502
    );
  }
  const mainPlace = requiredManifestInteger(calls.mainPlace, "providerCallCounts.mainPlace");
  const bookingBusiness = requiredManifestInteger(inventoryCalls.bookingBusiness, "providerCallCounts.inventory.bookingBusiness");
  const bookingItems = requiredManifestInteger(inventoryCalls.bookingItems, "providerCallCounts.inventory.bookingItems");
  const dailySchedule = requiredManifestInteger(inventoryCalls.dailySchedule, "providerCallCounts.inventory.dailySchedule");
  const inventoryTotal = requiredManifestInteger(inventoryCalls.total, "providerCallCounts.inventory.total");
  const total = requiredManifestInteger(calls.total, "providerCallCounts.total");
  const providerRequestCount = requiredManifestInteger(manifest.providerRequestCount, "providerRequestCount");
  const planned = requiredManifestInteger(results.planned, "inventoryResultCounts.planned");
  const ready = requiredManifestInteger(results.ready, "inventoryResultCounts.ready");
  const zero = requiredManifestInteger(results.zero, "inventoryResultCounts.zero");
  const missing = requiredManifestInteger(results.missing, "inventoryResultCounts.missing");
  const partial = requiredManifestInteger(results.partial, "inventoryResultCounts.partial");
  const naverRegional = requiredManifestInteger(counts.naverRegional, "counts.naverRegional");
  const nolFirstPage = requiredManifestInteger(counts.nolFirstPage, "counts.nolFirstPage");
  const nolRawFirstPage = requiredManifestInteger(counts.nolRawFirstPage, "counts.nolRawFirstPage");
  const ddnayo = requiredManifestInteger(counts.ddnayo, "counts.ddnayo");
  const naverOverall = requiredManifestInteger(counts.naverOverall, "counts.naverOverall");
  const naverBookingStockChecked = requiredManifestInteger(
    counts.naverBookingStockChecked,
    "counts.naverBookingStockChecked"
  );
  const companyKeys = Object.keys(companyCalls).sort();
  const companyPhaseRows = Array.from({ length: FIXED_INVENTORY_ACTIVATION.maxInventoryCompanies }, (_, index) => {
    const companyOrdinal = index + 1;
    const row = companyCalls[String(companyOrdinal)];
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      throw inventoryError(
        "NAVER_LEGACY_INVENTORY_MANIFEST_INVALID",
        "NAVER legacy inventory company call counts are invalid",
        502
      );
    }
    const bookingBusiness = requiredManifestInteger(row.bookingBusiness, `providerCompanyCallCounts.${companyOrdinal}.bookingBusiness`);
    const bookingItems = requiredManifestInteger(row.bookingItems, `providerCompanyCallCounts.${companyOrdinal}.bookingItems`);
    const dailySchedule = requiredManifestInteger(row.dailySchedule, `providerCompanyCallCounts.${companyOrdinal}.dailySchedule`);
    if (
      bookingBusiness > 1
      || bookingItems > 1
      || dailySchedule > FIXED_INVENTORY_ACTIVATION.maxProductsPerCompany
      || bookingItems > bookingBusiness
      || dailySchedule > 0 && bookingItems !== 1
    ) {
      throw inventoryError(
        "NAVER_LEGACY_INVENTORY_MANIFEST_INVALID",
        "NAVER legacy inventory company call sequence is invalid",
        502
      );
    }
    return { companyOrdinal, bookingBusiness, bookingItems, dailySchedule };
  });
  const companyPhasesValid = companyKeys.length === FIXED_INVENTORY_ACTIVATION.maxInventoryCompanies
    && companyKeys.every((key, index) => key === String(index + 1))
    && companyPhaseRows.reduce((sum, row) => sum + row.bookingBusiness, 0) === bookingBusiness
    && companyPhaseRows.reduce((sum, row) => sum + row.bookingItems, 0) === bookingItems
    && companyPhaseRows.reduce((sum, row) => sum + row.dailySchedule, 0) === dailySchedule;
  const normalizedTargets = targetResults.map((row, index) => {
    const companyOrdinal = requiredManifestInteger(row?.companyOrdinal, `inventoryTargetResults.${index}.companyOrdinal`);
    const targetBookingBusiness = requiredManifestInteger(row?.bookingBusiness, `inventoryTargetResults.${index}.bookingBusiness`);
    const targetBookingItems = requiredManifestInteger(row?.bookingItems, `inventoryTargetResults.${index}.bookingItems`);
    const targetDailySchedule = requiredManifestInteger(row?.dailySchedule, `inventoryTargetResults.${index}.dailySchedule`);
    const status = String(row?.status || "");
    const company = companyPhaseRows[index];
    const callShapeMatches = companyOrdinal === index + 1
      && company?.companyOrdinal === companyOrdinal
      && company.bookingBusiness === targetBookingBusiness
      && company.bookingItems === targetBookingItems
      && company.dailySchedule === targetDailySchedule;
    const statusCallShapeValid = status === "ready"
      ? targetBookingBusiness === 1 && targetBookingItems === 1 && targetDailySchedule >= 1
      : status === "zero" && (
          targetBookingBusiness === 0 && targetBookingItems === 0 && targetDailySchedule === 0
          || targetBookingBusiness === 1 && targetBookingItems === 0 && targetDailySchedule === 0
          || targetBookingBusiness === 1 && targetBookingItems === 1 && targetDailySchedule === 0
        );
    return { companyOrdinal, status, callShapeMatches, statusCallShapeValid };
  });
  const mainPhaseValid = mainPlace === 1;
  const inventoryPhaseValid = inventoryTotal === bookingBusiness + bookingItems + dailySchedule
    && bookingBusiness <= OPERATION_BUDGETS.booking_business
    && bookingItems <= OPERATION_BUDGETS.booking_items
    && dailySchedule <= OPERATION_BUDGETS.daily_schedule
    && inventoryTotal <= FIXED_INVENTORY_ACTIVATION.inventoryCallBudget;
  const totalPhaseValid = total === mainPlace + inventoryTotal
    && providerRequestCount === total
    && total <= FIXED_INVENTORY_ACTIVATION.totalCallBudget;
  const inventoryResultsValid = planned === FIXED_INVENTORY_ACTIVATION.maxInventoryCompanies
    && planned === ready + zero
    && missing === 0
    && partial === 0
    && normalizedTargets.length === FIXED_INVENTORY_ACTIVATION.maxInventoryCompanies
    && normalizedTargets.every((row) => row.callShapeMatches && row.statusCallShapeValid)
    && normalizedTargets.filter((row) => row.status === "ready").length === ready
    && normalizedTargets.filter((row) => row.status === "zero").length === zero;
  const staticContractValid = manifest.documentType === "lodging-collection-manifest"
    && manifest.collectorStrategy === NAVER_LEGACY_INVENTORY_STRATEGY
    && manifest.collectorScope === NAVER_LEGACY_INVENTORY_SCOPE
    && manifest.collectorActivationProfile === NAVER_LEGACY_INVENTORY_PROFILE
    && manifest.collectionPurpose === "revenue_detail"
    && manifest.collectionMode === "precision"
    && manifest.collectionProfile === "revenue_detail_deep"
    && String(manifest.detailRankRanges || "") === "1-3"
    && Number(manifest.bookingRangeDays) === FIXED_INVENTORY_ACTIVATION.observationDays
    && /^\d{4}-\d{2}-\d{2}$/u.test(String(manifest.checkIn || ""))
    && manifest.checkIn === manifest.checkOut
    && Number(manifest.maxInventoryCompanies) === FIXED_INVENTORY_ACTIVATION.maxInventoryCompanies
    && Number(manifest.maxProductsPerCompany) === FIXED_INVENTORY_ACTIVATION.maxProductsPerCompany
    && Number(manifest.providerCallBudget) === FIXED_INVENTORY_ACTIVATION.totalCallBudget
    && Number(manifest.mainPlaceCallBudget) === FIXED_INVENTORY_ACTIVATION.mainPlaceCallBudget
    && Number(manifest.inventoryCallBudget) === FIXED_INVENTORY_ACTIVATION.inventoryCallBudget
    && Number(manifest.totalCallBudget) === FIXED_INVENTORY_ACTIVATION.totalCallBudget
    && Number(manifest.mainPlaceRequestCount) === FIXED_INVENTORY_ACTIVATION.mainPlaceCallBudget
    && manifest.revenueEstimateBasis === "naver_booking_public_inventory_estimate_not_settled_revenue"
    && Number(manifest.providerConcurrency) === FIXED_INVENTORY_ACTIVATION.concurrency
    && Number.isInteger(Number(manifest.providerMaxObservedConcurrency))
    && Number(manifest.providerMaxObservedConcurrency) >= 0
    && Number(manifest.providerMaxObservedConcurrency) <= FIXED_INVENTORY_ACTIVATION.concurrency
    && Number(manifest.providerMaxObservedConcurrency) === (inventoryTotal > 0 ? 1 : 0)
    && manifest.automaticRetry === false
    && manifest.automaticFallback === false
    && manifest.saveRunOnSuccessOnly === true
    && manifest.saveFailureRun === false
    && flags.collectRegional === false
    && flags.collectOta === false
    && flags.collectBookingStock === true
    && flags.collectWeeklyRange === false
    && naverOverall === FIXED_INVENTORY_ACTIVATION.mainPlaceRankEnd
    && naverBookingStockChecked === FIXED_INVENTORY_ACTIVATION.maxInventoryCompanies
    && naverRegional === 0
    && nolFirstPage === 0
    && nolRawFirstPage === 0
    && ddnayo === 0;
  if (
    !staticContractValid
    || !mainPhaseValid
    || !inventoryPhaseValid
    || !companyPhasesValid
    || !totalPhaseValid
    || !inventoryResultsValid
  ) {
    throw inventoryError(
      "NAVER_LEGACY_INVENTORY_MANIFEST_INVALID",
      "NAVER legacy inventory manifest failed the limited activation contract",
      502
    );
  }
  return deepFreeze({
    outputDir,
    mainPlaceCallCount: mainPlace,
    inventoryCallCount: inventoryTotal,
    totalCallCount: total,
    planned,
    ready,
    zero,
    missing,
    partial,
    dataStatus: zero === planned && planned > 0 ? "zero" : "ready"
  });
}

module.exports = {
  FIXED_INVENTORY_ACTIVATION,
  NAVER_LEGACY_INVENTORY_PREVIEW_ROOT,
  NAVER_LEGACY_INVENTORY_PROFILE,
  NAVER_LEGACY_INVENTORY_SCHEMA_VERSION,
  NAVER_LEGACY_INVENTORY_SCOPE,
  NAVER_LEGACY_INVENTORY_STRATEGY,
  NaverLegacyInventoryActivationError,
  OPERATION_BUDGETS,
  activationBlockers,
  assertNaverLegacyInventoryActivation,
  buildNaverLegacyInventoryObservation,
  createNaverLegacyInventoryCallLedger,
  decideNaverLegacyInventoryRunPersistence,
  inventoryError,
  previewRuntimeMatches,
  reserveNaverLegacyInventoryCall,
  resolveNaverLegacyInventoryActivation,
  validateNaverLegacyInventoryRunManifest,
  validateNaverLegacyInventoryCallLedger
};
