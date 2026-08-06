"use strict";

const V2_TOP20_SCHEMA_VERSION = "collection-worker-v2-top20-contract.v1";
const V2_TOP20_PROFILE = "preview-v2-place-top20-inventory-revenue.v1";
const V2_TOP20_SCOPE = "main_place_top20_inventory_revenue";

const V2_TOP20_OPERATION_BUDGETS = deepFreeze({
  main_place: 1,
  booking_business: 20,
  booking_items: 20,
  daily_schedule: 160
});

const V2_TOP20_CONTRACT = deepFreeze({
  schemaVersion: V2_TOP20_SCHEMA_VERSION,
  profile: V2_TOP20_PROFILE,
  collectorScope: V2_TOP20_SCOPE,
  mainPlaceRankStart: 1,
  mainPlaceRankEnd: 50,
  inventoryRankStart: 1,
  inventoryRankEnd: 20,
  maxInventoryCompanies: 20,
  observationDays: 1,
  maxProductsPerCompany: 8,
  operationBudgets: V2_TOP20_OPERATION_BUDGETS,
  maximumProviderCalls: 201,
  concurrency: 1,
  automaticRetry: false,
  automaticFallback: false,
  externalCallOnRead: false,
  defaultEnabled: false,
  externalCallApprovalRequired: true,
  previewWriteApprovalRequired: true,
  providerCircuitRequired: true,
  serviceGlobalSingleFlightRequired: true,
  jobLeaseRequired: true,
  providerAttemptLeaseRequired: true,
  heartbeatBeforeEveryProviderCall: true,
  heartbeatDuringInFlightRequired: true,
  minimumLeaseRemainingMs: 30_000,
  saveRunOnSuccessOnly: true,
  saveFailureRun: false,
  missingValueImputation: false,
  revenueEstimateBasis: "naver_booking_public_inventory_estimate_not_settled_revenue"
});

const EXECUTION_PHASES = new Set([
  "planned",
  "collecting_main_place",
  "collecting_inventory",
  "validating",
  "ready_to_persist",
  "completed",
  "failed"
]);
const PROVIDER_RESULT_STATUSES = new Set(["ready", "zero", "missing", "partial", "blocked", "failed"]);
const TERMINAL_COMPANY_STATUSES = new Set(["ready", "zero"]);
const COMPANY_STATUSES = new Set(["pending", "ready", "zero"]);
const COMPANY_PHASE_STATUSES = new Set(["pending", "ready", "zero", "skipped"]);

class CollectionWorkerV2Top20ContractError extends Error {
  constructor(code, message, statusCode = 400) {
    super(message);
    this.name = "CollectionWorkerV2Top20ContractError";
    this.code = code;
    this.statusCode = statusCode;
    this.retryable = false;
  }
}

function contractError(code, message, statusCode = 400) {
  return new CollectionWorkerV2Top20ContractError(code, message, statusCode);
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function nonNegativeInteger(value, fieldName) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) {
    throw contractError("V2_TOP20_CONTRACT_INVALID", `${fieldName} must be a non-negative integer`);
  }
  return number;
}

function instant(value, fieldName) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw contractError("V2_TOP20_TIME_INVALID", `${fieldName} is invalid`);
  }
  return date.toISOString();
}

function assertRevision(state, expectedWorkflowRevision) {
  const expected = nonNegativeInteger(expectedWorkflowRevision, "expectedWorkflowRevision");
  if (state.workflowRevision !== expected) {
    throw contractError("V2_TOP20_WORKFLOW_REVISION_CONFLICT", "top20 execution workflow revision is stale", 409);
  }
}

function buildV2Top20MaximumExecutionPlan() {
  const calls = [];
  const append = (operation, companyOrdinal = null, productOrdinal = null) => {
    calls.push({
      requestOrdinal: calls.length + 1,
      operation,
      companyOrdinal,
      productOrdinal,
      heartbeatRequired: true,
      concurrency: 1
    });
  };
  append("main_place");
  for (let companyOrdinal = 1; companyOrdinal <= V2_TOP20_CONTRACT.maxInventoryCompanies; companyOrdinal += 1) {
    append("booking_business", companyOrdinal);
    append("booking_items", companyOrdinal);
    for (let productOrdinal = 1; productOrdinal <= V2_TOP20_CONTRACT.maxProductsPerCompany; productOrdinal += 1) {
      append("daily_schedule", companyOrdinal, productOrdinal);
    }
  }
  if (calls.length !== V2_TOP20_CONTRACT.maximumProviderCalls) {
    throw contractError("V2_TOP20_PLAN_INVALID", "top20 maximum execution plan does not match its call budget", 500);
  }
  return deepFreeze(calls);
}

function emptyCompany(companyOrdinal) {
  return {
    companyOrdinal,
    status: "pending",
    bookingBusinessStatus: "pending",
    bookingItemsStatus: "pending",
    productCount: null,
    scheduleResults: []
  };
}

function emptyCallLedger() {
  return {
    mainPlace: 0,
    bookingBusiness: 0,
    bookingItems: 0,
    dailySchedule: 0,
    total: 0,
    maximumProviderCalls: V2_TOP20_CONTRACT.maximumProviderCalls,
    companies: Array.from({ length: V2_TOP20_CONTRACT.maxInventoryCompanies }, (_, index) => ({
      companyOrdinal: index + 1,
      bookingBusiness: 0,
      bookingItems: 0,
      dailySchedule: 0
    }))
  };
}

function createV2Top20ExecutionState() {
  return deepFreeze({
    schemaVersion: V2_TOP20_SCHEMA_VERSION,
    profile: V2_TOP20_PROFILE,
    collectorScope: V2_TOP20_SCOPE,
    phase: "planned",
    workflowRevision: 0,
    startedAt: null,
    updatedAt: null,
    lastProviderCallCompletedAt: null,
    currentCompanyOrdinal: null,
    mainPlace: {
      status: "pending",
      organicCount: null
    },
    companies: Array.from(
      { length: V2_TOP20_CONTRACT.maxInventoryCompanies },
      (_, index) => emptyCompany(index + 1)
    ),
    callLedger: emptyCallLedger(),
    inFlight: null,
    failure: null,
    validation: null,
    persistedAt: null
  });
}

function validateCallLedger(ledger) {
  if (!ledger || typeof ledger !== "object" || Array.isArray(ledger)) {
    throw contractError("V2_TOP20_LEDGER_INVALID", "top20 call ledger is invalid");
  }
  const mainPlace = nonNegativeInteger(ledger.mainPlace, "callLedger.mainPlace");
  const bookingBusiness = nonNegativeInteger(ledger.bookingBusiness, "callLedger.bookingBusiness");
  const bookingItems = nonNegativeInteger(ledger.bookingItems, "callLedger.bookingItems");
  const dailySchedule = nonNegativeInteger(ledger.dailySchedule, "callLedger.dailySchedule");
  const total = nonNegativeInteger(ledger.total, "callLedger.total");
  if (!Array.isArray(ledger.companies) || ledger.companies.length !== V2_TOP20_CONTRACT.maxInventoryCompanies) {
    throw contractError("V2_TOP20_LEDGER_INVALID", "top20 company ledger is invalid");
  }
  let companyBusiness = 0;
  let companyItems = 0;
  let companySchedules = 0;
  ledger.companies.forEach((row, index) => {
    const companyOrdinal = index + 1;
    if (row?.companyOrdinal !== companyOrdinal) {
      throw contractError("V2_TOP20_LEDGER_INVALID", "top20 company ledger ordinal is invalid");
    }
    const business = nonNegativeInteger(row.bookingBusiness, `callLedger.companies.${companyOrdinal}.bookingBusiness`);
    const items = nonNegativeInteger(row.bookingItems, `callLedger.companies.${companyOrdinal}.bookingItems`);
    const schedules = nonNegativeInteger(row.dailySchedule, `callLedger.companies.${companyOrdinal}.dailySchedule`);
    if (business > 1 || items > 1 || schedules > V2_TOP20_CONTRACT.maxProductsPerCompany) {
      throw contractError("V2_TOP20_CALL_BUDGET_EXCEEDED", "top20 per-company call budget exceeded");
    }
    if (items > business || schedules > 0 && items !== 1) {
      throw contractError("V2_TOP20_CALL_SEQUENCE_INVALID", "top20 per-company call sequence is invalid");
    }
    companyBusiness += business;
    companyItems += items;
    companySchedules += schedules;
  });
  if (
    mainPlace > V2_TOP20_OPERATION_BUDGETS.main_place
    || bookingBusiness > V2_TOP20_OPERATION_BUDGETS.booking_business
    || bookingItems > V2_TOP20_OPERATION_BUDGETS.booking_items
    || dailySchedule > V2_TOP20_OPERATION_BUDGETS.daily_schedule
    || total > V2_TOP20_CONTRACT.maximumProviderCalls
  ) {
    throw contractError("V2_TOP20_CALL_BUDGET_EXCEEDED", "top20 total call budget exceeded");
  }
  if (
    companyBusiness !== bookingBusiness
    || companyItems !== bookingItems
    || companySchedules !== dailySchedule
    || total !== mainPlace + bookingBusiness + bookingItems + dailySchedule
    || Number(ledger.maximumProviderCalls) !== V2_TOP20_CONTRACT.maximumProviderCalls
  ) {
    throw contractError("V2_TOP20_LEDGER_INVALID", "top20 call ledger totals do not match");
  }
  return ledger;
}

function validateExecutionState(state) {
  if (!state || typeof state !== "object" || Array.isArray(state)) {
    throw contractError("V2_TOP20_STATE_INVALID", "top20 execution state is invalid");
  }
  if (
    state.schemaVersion !== V2_TOP20_SCHEMA_VERSION
    || state.profile !== V2_TOP20_PROFILE
    || state.collectorScope !== V2_TOP20_SCOPE
    || !EXECUTION_PHASES.has(String(state.phase || ""))
    || !Number.isInteger(state.workflowRevision)
    || state.workflowRevision < 0
  ) {
    throw contractError("V2_TOP20_STATE_INVALID", "top20 execution state identity is invalid");
  }
  if (!Array.isArray(state.companies) || state.companies.length !== V2_TOP20_CONTRACT.maxInventoryCompanies) {
    throw contractError("V2_TOP20_STATE_INVALID", "top20 execution company state is invalid");
  }
  state.companies.forEach((company, index) => {
    if (
      company?.companyOrdinal !== index + 1
      || !Array.isArray(company.scheduleResults)
      || !COMPANY_STATUSES.has(String(company.status || ""))
      || !COMPANY_PHASE_STATUSES.has(String(company.bookingBusinessStatus || ""))
      || !COMPANY_PHASE_STATUSES.has(String(company.bookingItemsStatus || ""))
    ) {
      throw contractError("V2_TOP20_STATE_INVALID", "top20 execution company ordering is invalid");
    }
    if (company.productCount !== null) {
      const productCount = nonNegativeInteger(company.productCount, `companies.${index + 1}.productCount`);
      if (productCount > V2_TOP20_CONTRACT.maxProductsPerCompany || company.scheduleResults.length > productCount) {
        throw contractError("V2_TOP20_STATE_INVALID", "top20 execution product state is invalid");
      }
    }
    company.scheduleResults.forEach((result, scheduleIndex) => {
      if (
        result?.productOrdinal !== scheduleIndex + 1
        || !TERMINAL_COMPANY_STATUSES.has(String(result.status || ""))
        || result.revenueInputValid !== true
      ) {
        throw contractError("V2_TOP20_STATE_INVALID", "top20 schedule result state is invalid");
      }
    });
    if (company.status === "ready" && (
      company.productCount < 1
      || company.scheduleResults.length !== company.productCount
      || !company.scheduleResults.some((result) => result.status === "ready")
    )) {
      throw contractError("V2_TOP20_STATE_INVALID", "top20 ready company state is incomplete");
    }
    if (company.status === "zero" && company.productCount > 0 && (
      company.scheduleResults.length !== company.productCount
      || !company.scheduleResults.every((result) => result.status === "zero")
    )) {
      throw contractError("V2_TOP20_STATE_INVALID", "top20 zero company state is incomplete");
    }
  });
  validateCallLedger(state.callLedger);
  if (state.inFlight && (
    !Number.isInteger(state.inFlight.requestOrdinal)
    || state.inFlight.requestOrdinal !== state.callLedger.total
    || !Number.isFinite(Date.parse(String(state.inFlight.reservedAt || "")))
  )) {
    throw contractError("V2_TOP20_STATE_INVALID", "top20 in-flight state is invalid");
  }
  if (state.phase === "collecting_main_place" && state.currentCompanyOrdinal !== null) {
    throw contractError("V2_TOP20_STATE_INVALID", "top20 main Place phase cannot have a current company");
  }
  if (state.phase === "collecting_inventory" && (
    !Number.isInteger(state.currentCompanyOrdinal)
    || state.currentCompanyOrdinal < 1
    || state.currentCompanyOrdinal > V2_TOP20_CONTRACT.maxInventoryCompanies
  )) {
    throw contractError("V2_TOP20_STATE_INVALID", "top20 inventory phase requires a current company");
  }
  if (["validating", "ready_to_persist", "completed"].includes(state.phase) && (
    state.currentCompanyOrdinal !== null
    || state.mainPlace?.status !== "ready"
    || state.mainPlace?.organicCount !== V2_TOP20_CONTRACT.mainPlaceRankEnd
    || !state.companies.every((company) => TERMINAL_COMPANY_STATUSES.has(company.status))
  )) {
    throw contractError("V2_TOP20_STATE_INVALID", "top20 terminal collection state is incomplete");
  }
  return state;
}

function startV2Top20Execution(state, input = {}) {
  validateExecutionState(state);
  assertRevision(state, input.expectedWorkflowRevision);
  if (state.phase !== "planned") {
    throw contractError("V2_TOP20_TRANSITION_INVALID", "top20 execution can only start from planned", 409);
  }
  const now = instant(input.now, "now");
  const next = clone(state);
  next.phase = "collecting_main_place";
  next.startedAt = now;
  next.updatedAt = now;
  next.workflowRevision += 1;
  return deepFreeze(next);
}

function getV2Top20NextProviderCall(state) {
  validateExecutionState(state);
  if (state.inFlight || ["planned", "validating", "ready_to_persist", "completed", "failed"].includes(state.phase)) {
    return null;
  }
  if (state.phase === "collecting_main_place") {
    return deepFreeze({ operation: "main_place", companyOrdinal: null, productOrdinal: null });
  }
  const ordinal = state.currentCompanyOrdinal;
  if (!Number.isInteger(ordinal) || ordinal < 1 || ordinal > V2_TOP20_CONTRACT.maxInventoryCompanies) {
    throw contractError("V2_TOP20_STATE_INVALID", "top20 current company ordinal is invalid");
  }
  const company = state.companies[ordinal - 1];
  if (company.bookingBusinessStatus === "pending") {
    return deepFreeze({ operation: "booking_business", companyOrdinal: ordinal, productOrdinal: null });
  }
  if (company.bookingBusinessStatus === "ready" && company.bookingItemsStatus === "pending") {
    return deepFreeze({ operation: "booking_items", companyOrdinal: ordinal, productOrdinal: null });
  }
  if (company.bookingItemsStatus === "ready" && company.scheduleResults.length < company.productCount) {
    return deepFreeze({
      operation: "daily_schedule",
      companyOrdinal: ordinal,
      productOrdinal: company.scheduleResults.length + 1
    });
  }
  throw contractError("V2_TOP20_STATE_INVALID", "top20 execution has no valid next provider call");
}

function evaluateV2Top20HeartbeatRequirement(state, input = {}) {
  validateExecutionState(state);
  const now = instant(input.now, "now");
  const anchor = state.inFlight?.reservedAt || state.lastProviderCallCompletedAt || state.startedAt;
  if (!anchor) {
    throw contractError("V2_TOP20_HEARTBEAT_INVALID", "top20 execution has not started");
  }
  const nowMs = Date.parse(now);
  const anchorMs = Date.parse(anchor);
  const blockers = [];
  const evaluateLease = (kind) => {
    const heartbeatValue = input[`${kind}HeartbeatAt`];
    const leaseValue = input[`${kind}LeaseExpiresAt`];
    if (!heartbeatValue) {
      blockers.push(`${kind}_heartbeat_required`);
      return;
    }
    const heartbeatAt = instant(heartbeatValue, `${kind}HeartbeatAt`);
    if (Date.parse(heartbeatAt) < anchorMs || Date.parse(heartbeatAt) > nowMs) {
      blockers.push(`${kind}_heartbeat_stale`);
    }
    if (!leaseValue) {
      blockers.push(`${kind}_lease_required`);
      return;
    }
    const leaseExpiresAt = instant(leaseValue, `${kind}LeaseExpiresAt`);
    const leaseRemainingMs = Date.parse(leaseExpiresAt) - nowMs;
    if (leaseRemainingMs <= 0) blockers.push(`${kind}_lease_expired`);
    else if (leaseRemainingMs < V2_TOP20_CONTRACT.minimumLeaseRemainingMs) blockers.push(`${kind}_lease_refresh_required`);
  };
  evaluateLease("job");
  evaluateLease("provider");
  return deepFreeze({
    required: true,
    checkpoint: state.inFlight ? "in_flight_lease_renewal" : "before_provider_call",
    heartbeatBeforeEveryProviderCall: true,
    anchor,
    checkedAt: now,
    satisfied: blockers.length === 0,
    canReserveCall: blockers.length === 0,
    blockers
  });
}

function evaluateV2Top20ProviderGate(input = {}) {
  const blockers = [];
  if (String(input.circuitState || "") !== "closed") blockers.push("provider_circuit_closed_required");
  if (input.serviceGlobalLockHeld !== true) blockers.push("service_global_lock_required");
  if (input.externalCallApproved !== true) blockers.push("external_call_approval_required");
  return deepFreeze({
    requiredCircuitState: "closed",
    serviceGlobalLockRequired: true,
    externalCallApprovalRequired: true,
    allowed: blockers.length === 0,
    blockers
  });
}

function sameCall(actual, expected) {
  return actual?.operation === expected?.operation
    && (actual?.companyOrdinal ?? null) === (expected?.companyOrdinal ?? null)
    && (actual?.productOrdinal ?? null) === (expected?.productOrdinal ?? null);
}

function reserveV2Top20ProviderCall(state, input = {}) {
  validateExecutionState(state);
  assertRevision(state, input.expectedWorkflowRevision);
  const expected = getV2Top20NextProviderCall(state);
  if (!expected) {
    throw contractError("V2_TOP20_CALL_SEQUENCE_INVALID", "top20 execution cannot reserve another provider call", 409);
  }
  if (!sameCall(input.call, expected)) {
    throw contractError("V2_TOP20_CALL_SEQUENCE_INVALID", "top20 provider call does not match the next sequential call", 409);
  }
  const providerGate = evaluateV2Top20ProviderGate(input.providerGate || {});
  if (!providerGate.allowed) {
    throw contractError("V2_TOP20_PROVIDER_GATE_BLOCKED", `top20 provider gate is closed: ${providerGate.blockers.join(",")}`, 409);
  }
  const heartbeat = evaluateV2Top20HeartbeatRequirement(state, input.heartbeat || {});
  if (!heartbeat.canReserveCall) {
    throw contractError("V2_TOP20_HEARTBEAT_REQUIRED", `top20 provider call requires current leases: ${heartbeat.blockers.join(",")}`, 409);
  }
  const reservedAt = instant(input.reservedAt || input.heartbeat?.now, "reservedAt");
  const next = clone(state);
  next.callLedger.total += 1;
  if (expected.operation === "main_place") {
    next.callLedger.mainPlace += 1;
  } else {
    const companyLedger = next.callLedger.companies[expected.companyOrdinal - 1];
    if (expected.operation === "booking_business") {
      next.callLedger.bookingBusiness += 1;
      companyLedger.bookingBusiness += 1;
    } else if (expected.operation === "booking_items") {
      next.callLedger.bookingItems += 1;
      companyLedger.bookingItems += 1;
    } else if (expected.operation === "daily_schedule") {
      next.callLedger.dailySchedule += 1;
      companyLedger.dailySchedule += 1;
    }
  }
  next.inFlight = { ...expected, requestOrdinal: next.callLedger.total, reservedAt };
  next.updatedAt = reservedAt;
  next.workflowRevision += 1;
  validateCallLedger(next.callLedger);
  return deepFreeze(next);
}

function failState(state, code, resultStatus, completedAt) {
  const next = clone(state);
  next.phase = "failed";
  next.failure = {
    code: String(code || "V2_TOP20_COLLECTION_FAILED"),
    resultStatus: String(resultStatus || "failed")
  };
  next.inFlight = null;
  next.updatedAt = completedAt;
  next.lastProviderCallCompletedAt = completedAt;
  next.workflowRevision += 1;
  return deepFreeze(next);
}

function advanceCompany(next, companyOrdinal) {
  if (companyOrdinal < V2_TOP20_CONTRACT.maxInventoryCompanies) {
    next.currentCompanyOrdinal = companyOrdinal + 1;
    next.phase = "collecting_inventory";
  } else {
    next.currentCompanyOrdinal = null;
    next.phase = "validating";
  }
}

function recordV2Top20ProviderResult(state, input = {}) {
  validateExecutionState(state);
  assertRevision(state, input.expectedWorkflowRevision);
  if (!state.inFlight || !sameCall(input.call, state.inFlight)) {
    throw contractError("V2_TOP20_CALL_SEQUENCE_INVALID", "top20 provider result does not match the in-flight call", 409);
  }
  const completedAt = instant(input.completedAt, "completedAt");
  if (Date.parse(completedAt) < Date.parse(state.inFlight.reservedAt)) {
    throw contractError("V2_TOP20_TIME_INVALID", "provider result completed before its reservation");
  }
  const status = String(input.status || "").trim();
  if (!PROVIDER_RESULT_STATUSES.has(status)) {
    throw contractError("V2_TOP20_PROVIDER_RESULT_INVALID", "top20 provider result status is invalid");
  }
  if (!TERMINAL_COMPANY_STATUSES.has(status)) {
    return failState(state, input.failureCode || `V2_TOP20_${status.toUpperCase()}`, status, completedAt);
  }
  const next = clone(state);
  const call = next.inFlight;
  next.inFlight = null;
  next.updatedAt = completedAt;
  next.lastProviderCallCompletedAt = completedAt;
  next.workflowRevision += 1;
  if (call.operation === "main_place") {
    const organicCount = nonNegativeInteger(input.organicCount, "organicCount");
    if (status !== "ready" || organicCount !== V2_TOP20_CONTRACT.mainPlaceRankEnd) {
      return failState(state, "V2_TOP20_MAIN_PLACE_INCOMPLETE", status, completedAt);
    }
    next.mainPlace = { status: "ready", organicCount };
    next.phase = "collecting_inventory";
    next.currentCompanyOrdinal = 1;
    return deepFreeze(next);
  }
  const company = next.companies[call.companyOrdinal - 1];
  if (call.operation === "booking_business") {
    company.bookingBusinessStatus = status;
    if (status === "zero") {
      company.bookingItemsStatus = "skipped";
      company.productCount = 0;
      company.status = "zero";
      advanceCompany(next, call.companyOrdinal);
    }
    return deepFreeze(next);
  }
  if (call.operation === "booking_items") {
    const productCount = nonNegativeInteger(input.productCount, "productCount");
    if (productCount > V2_TOP20_CONTRACT.maxProductsPerCompany) {
      return failState(state, "V2_TOP20_PRODUCT_BUDGET_EXCEEDED", status, completedAt);
    }
    if (status === "zero" && productCount !== 0 || status === "ready" && productCount < 1) {
      return failState(state, "V2_TOP20_PRODUCT_RESULT_INCONSISTENT", status, completedAt);
    }
    company.bookingItemsStatus = status;
    company.productCount = productCount;
    if (status === "zero") {
      company.status = "zero";
      advanceCompany(next, call.companyOrdinal);
    }
    return deepFreeze(next);
  }
  if (input.revenueInputValid !== true) {
    return failState(state, "V2_TOP20_REVENUE_INPUT_INVALID", status, completedAt);
  }
  company.scheduleResults.push({
    productOrdinal: call.productOrdinal,
    status,
    revenueInputValid: true
  });
  if (company.scheduleResults.length === company.productCount) {
    company.status = company.scheduleResults.every((row) => row.status === "zero") ? "zero" : "ready";
    advanceCompany(next, call.companyOrdinal);
  }
  return deepFreeze(next);
}

function markV2Top20Validation(state, input = {}) {
  validateExecutionState(state);
  assertRevision(state, input.expectedWorkflowRevision);
  if (state.phase !== "validating" || state.inFlight) {
    throw contractError("V2_TOP20_TRANSITION_INVALID", "top20 execution is not ready for validation", 409);
  }
  const now = instant(input.now, "now");
  const checks = {
    manifestValid: input.manifestValid === true,
    atomicPublishReady: input.atomicPublishReady === true,
    revenueEstimatesValid: input.revenueEstimatesValid === true,
    previewWriteApproved: input.previewWriteApproved === true,
    executionSucceeded: input.executionSucceeded === true,
    providerBlocked: input.providerBlocked === true,
    failureCode: String(input.failureCode || "").trim()
  };
  const next = clone(state);
  next.validation = checks;
  next.updatedAt = now;
  next.workflowRevision += 1;
  const blocker = !checks.executionSucceeded
    ? "execution_not_succeeded"
    : (checks.providerBlocked
        ? "provider_blocked"
        : (checks.failureCode
            ? "collection_failure_present"
            : (!checks.manifestValid
                ? "manifest_invalid"
                : (!checks.revenueEstimatesValid
                    ? "revenue_estimates_invalid"
                    : (!checks.previewWriteApproved
                        ? "preview_write_not_approved"
                        : (!checks.atomicPublishReady ? "atomic_publish_not_ready" : null))))));
  if (blocker) {
    next.phase = "failed";
    next.failure = { code: blocker, resultStatus: "failed" };
  } else {
    next.phase = "ready_to_persist";
  }
  return deepFreeze(next);
}

function decideV2Top20Persistence(state) {
  validateExecutionState(state);
  const companyStatuses = state.companies.map((company) => company.status);
  const allCompaniesTerminal = companyStatuses.every((status) => TERMINAL_COMPANY_STATUSES.has(status));
  const allRevenueInputsValid = state.companies.every((company) => (
    company.status === "zero" && company.productCount === 0
    || company.scheduleResults.length === company.productCount
      && company.scheduleResults.every((result) => result.revenueInputValid === true)
  ));
  let blocker = null;
  if (state.phase === "failed") blocker = state.failure?.code || "execution_failed";
  else if (state.phase !== "ready_to_persist") blocker = "execution_not_ready_to_persist";
  else if (state.mainPlace.status !== "ready" || state.mainPlace.organicCount !== 50) blocker = "main_place_not_ready";
  else if (!allCompaniesTerminal) blocker = "inventory_not_terminal";
  else if (!allRevenueInputsValid) blocker = "revenue_inputs_not_terminal";
  else if (state.validation?.manifestValid !== true) blocker = "manifest_invalid";
  else if (state.validation?.atomicPublishReady !== true) blocker = "atomic_publish_not_ready";
  else if (state.validation?.previewWriteApproved !== true) blocker = "preview_write_not_approved";
  else if (state.validation?.revenueEstimatesValid !== true) blocker = "revenue_estimates_invalid";
  return deepFreeze({
    saveRun: blocker === null,
    saveFailureRun: false,
    blocker,
    dataStatus: blocker === null ? "ready" : (state.phase === "failed" ? "failed" : "partial"),
    mainPlaceCount: state.mainPlace.organicCount,
    inventoryTargetCount: state.companies.length,
    companyStatuses,
    providerCallCount: state.callLedger.total,
    maximumProviderCalls: V2_TOP20_CONTRACT.maximumProviderCalls
  });
}

function markV2Top20Persisted(state, input = {}) {
  validateExecutionState(state);
  assertRevision(state, input.expectedWorkflowRevision);
  const decision = decideV2Top20Persistence(state);
  if (!decision.saveRun) {
    throw contractError("V2_TOP20_PERSISTENCE_NOT_ALLOWED", `top20 run cannot be persisted: ${decision.blocker}`, 409);
  }
  const now = instant(input.now, "now");
  const next = clone(state);
  next.phase = "completed";
  next.persistedAt = now;
  next.updatedAt = now;
  next.workflowRevision += 1;
  return deepFreeze(next);
}

module.exports = {
  CollectionWorkerV2Top20ContractError,
  V2_TOP20_CONTRACT,
  V2_TOP20_OPERATION_BUDGETS,
  V2_TOP20_PROFILE,
  V2_TOP20_SCHEMA_VERSION,
  V2_TOP20_SCOPE,
  buildV2Top20MaximumExecutionPlan,
  createV2Top20ExecutionState,
  decideV2Top20Persistence,
  evaluateV2Top20HeartbeatRequirement,
  evaluateV2Top20ProviderGate,
  getV2Top20NextProviderCall,
  markV2Top20Persisted,
  markV2Top20Validation,
  recordV2Top20ProviderResult,
  reserveV2Top20ProviderCall,
  startV2Top20Execution,
  validateCallLedger,
  validateExecutionState
};
