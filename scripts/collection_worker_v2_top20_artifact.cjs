"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const {
  classifyCollectionArtifactSensitiveContent
} = require("./collection_artifact_contract.cjs");
const {
  V2_TOP20_CONTRACT,
  V2_TOP20_PROFILE,
  V2_TOP20_SCHEMA_VERSION,
  V2_TOP20_SCOPE,
  createV2Top20ExecutionState,
  decideV2Top20Persistence,
  markV2Top20Validation,
  recordV2Top20ProviderResult,
  reserveV2Top20ProviderCall,
  startV2Top20Execution,
  validateExecutionState
} = require("./collection_worker_v2_top20_contract.cjs");
const {
  COLLECTION_WORKER_V2_TOP20_RESULT_SCHEMA_VERSION
} = require("./collection_worker_v2_top20_protocol.cjs");
const {
  V2_TOP20_RESILIENCE_MAXIMUM_PROVIDER_CALLS,
  V2_TOP20_RESILIENCE_OPERATION_BUDGETS,
  summarizeResilientTop20Collection,
  validateResilientProviderTrace
} = require("./collection_worker_v2_top20_resilience.cjs");

const V2_TOP20_ARTIFACT_SCHEMA_VERSION = "collection-worker-v2-top20-artifact.v1";
const V2_TOP20_PROVIDER_CALL_TRACE_SCHEMA_VERSION = "collection-worker-v2-top20-provider-call-trace.v1";
const SUMMARY_PATH = "top20-summary.json";
const CONTENT_RECEIPT_PATH = "top20-content-receipt.json";
const MANIFEST_PATH = "run/manifest.json";
const REQUIRED_CSV_ROLES = Object.freeze(["platform", "overall", "ads", "regional", "ddnayo"]);
const FORBIDDEN_KEY = /^(?:outputDir|runId|stagingDir|finalDir|absolutePath|rawHtml|rawBody|rawResponse|headers?|cookies?|credentials?|authorization|secrets?|tokens?|passwords?|apiKeys?|sourceUrl|bookingUrl|url|uri)$/iu;
const URL_PATTERN = /(?:https?|wss?):\/\/[^\s,"'<>]+|\bwww\.[^\s,"'<>]+/giu;
const RAW_HTML_PATTERN = /<(?:!doctype\s+html|html|head|body|script)\b|window\.__APOLLO_STATE__/iu;
const SENSITIVE_PATTERN = /\b(?:bearer\s+[A-Za-z0-9._~-]+|client[_-]?secret|api[_-]?key|access[_-]?token|refresh[_-]?token|password)\b/iu;

class CollectionWorkerV2Top20ArtifactError extends Error {
  constructor(code, message, statusCode = 400, safeMeta = null) {
    super(message);
    this.name = "CollectionWorkerV2Top20ArtifactError";
    this.code = code;
    this.statusCode = statusCode;
    this.retryable = false;
    this.safeMeta = safeMeta && typeof safeMeta === "object" ? Object.freeze({ ...safeMeta }) : null;
  }
}

function artifactError(code, message, statusCode = 400, safeMeta = null) {
  return new CollectionWorkerV2Top20ArtifactError(code, message, statusCode, safeMeta);
}

function sha256Hex(value) {
  return crypto.createHash("sha256").update(Buffer.isBuffer(value) ? value : Buffer.from(String(value))).digest("hex");
}

function exactObjectKeys(value, expectedKeys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function normalizeTraceOrdinal(value, minimum, maximum, label) {
  const ordinal = Number(value);
  if (!Number.isInteger(ordinal) || ordinal < minimum || ordinal > maximum) {
    throw artifactError("V2_TOP20_PROVIDER_CALL_TRACE_INVALID", `${label} is invalid`, 409);
  }
  return ordinal;
}

function normalizeV2Top20ProviderCallTrace(trace) {
  if (!Array.isArray(trace) || trace.length < 1 || trace.length > V2_TOP20_RESILIENCE_MAXIMUM_PROVIDER_CALLS) {
    throw artifactError("V2_TOP20_PROVIDER_CALL_TRACE_INVALID", "top20 provider call trace is invalid", 409);
  }
  return Object.freeze(trace.map((entry, index) => {
    if (!exactObjectKeys(entry, ["requestOrdinal", "operation", "companyOrdinal", "productOrdinal"])) {
      throw artifactError("V2_TOP20_PROVIDER_CALL_TRACE_INVALID", "top20 provider call trace fields are invalid", 409);
    }
    const requestOrdinal = normalizeTraceOrdinal(
      entry.requestOrdinal,
      1,
      V2_TOP20_RESILIENCE_MAXIMUM_PROVIDER_CALLS,
      "provider call request ordinal"
    );
    if (requestOrdinal !== index + 1) {
      throw artifactError("V2_TOP20_PROVIDER_CALL_TRACE_INVALID", "top20 provider call trace is not contiguous", 409);
    }
    const operation = String(entry.operation || "");
    let companyOrdinal = null;
    let productOrdinal = null;
    if (operation === "main_place") {
      if (entry.companyOrdinal !== null || entry.productOrdinal !== null) {
        throw artifactError("V2_TOP20_PROVIDER_CALL_TRACE_INVALID", "main Place trace ordinals are invalid", 409);
      }
    } else if (["booking_business", "booking_business_graphql", "booking_business_place_page", "booking_items"].includes(operation)) {
      companyOrdinal = normalizeTraceOrdinal(
        entry.companyOrdinal,
        1,
        V2_TOP20_CONTRACT.maxInventoryCompanies,
        "provider call company ordinal"
      );
      if (entry.productOrdinal !== null) {
        throw artifactError("V2_TOP20_PROVIDER_CALL_TRACE_INVALID", "inventory trace product ordinal is invalid", 409);
      }
    } else if (operation === "daily_schedule") {
      companyOrdinal = normalizeTraceOrdinal(
        entry.companyOrdinal,
        1,
        V2_TOP20_CONTRACT.maxInventoryCompanies,
        "provider call company ordinal"
      );
      productOrdinal = normalizeTraceOrdinal(
        entry.productOrdinal,
        1,
        V2_TOP20_CONTRACT.maxProductsPerCompany,
        "provider call product ordinal"
      );
    } else {
      throw artifactError("V2_TOP20_PROVIDER_CALL_TRACE_INVALID", "top20 provider call operation is invalid", 409);
    }
    return Object.freeze({ requestOrdinal, operation, companyOrdinal, productOrdinal });
  }));
}

function computeV2Top20ProviderCallTraceHash(trace) {
  const normalized = normalizeV2Top20ProviderCallTrace(trace);
  return sha256Hex(`${V2_TOP20_PROVIDER_CALL_TRACE_SCHEMA_VERSION}\0${JSON.stringify(normalized)}`);
}

function expectedV2Top20ProviderCallTrace(targetResults) {
  const trace = [{ requestOrdinal: 1, operation: "main_place", companyOrdinal: null, productOrdinal: null }];
  for (const target of targetResults) {
    const companyOrdinal = target.companyOrdinal;
    trace.push({
      requestOrdinal: trace.length + 1,
      operation: "booking_business",
      companyOrdinal,
      productOrdinal: null
    });
    if (target.bookingItems === 0) continue;
    trace.push({
      requestOrdinal: trace.length + 1,
      operation: "booking_items",
      companyOrdinal,
      productOrdinal: null
    });
    for (let productOrdinal = 1; productOrdinal <= target.dailySchedule; productOrdinal += 1) {
      trace.push({
        requestOrdinal: trace.length + 1,
        operation: "daily_schedule",
        companyOrdinal,
        productOrdinal
      });
    }
  }
  return normalizeV2Top20ProviderCallTrace(trace);
}

function validateV2Top20ProviderCallTrace(trace, targetResults) {
  const normalized = normalizeV2Top20ProviderCallTrace(trace);
  const expected = expectedV2Top20ProviderCallTrace(targetResults);
  if (JSON.stringify(normalized) !== JSON.stringify(expected)) {
    throw artifactError("V2_TOP20_PROVIDER_CALL_TRACE_INVALID", "top20 provider call trace does not match target results", 409);
  }
  return normalized;
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

function sanitizeArtifactString(value, context = "top20 artifact") {
  const text = String(value || "").replace(URL_PATTERN, "");
  if (RAW_HTML_PATTERN.test(text) || SENSITIVE_PATTERN.test(text)) {
    throw artifactError("V2_TOP20_ARTIFACT_SENSITIVE", `${context} contains prohibited material`, 403);
  }
  return text;
}

function sanitizeJsonValue(value, context = "top20 artifact") {
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return sanitizeArtifactString(value, context);
  if (Array.isArray(value)) return value.map((item, index) => sanitizeJsonValue(item, `${context}[${index}]`));
  if (!value || typeof value !== "object") {
    throw artifactError("V2_TOP20_ARTIFACT_INVALID", "top20 artifact contains an unsupported value");
  }
  const next = {};
  for (const [key, nested] of Object.entries(value)) {
    if (FORBIDDEN_KEY.test(key)) continue;
    if (["__proto__", "prototype", "constructor"].includes(key)) {
      throw artifactError("V2_TOP20_ARTIFACT_INVALID", "top20 artifact contains an unsafe field");
    }
    next[key] = sanitizeJsonValue(nested, `${context}.${key}`);
  }
  return next;
}

function sanitizeText(value, label) {
  return sanitizeArtifactString(value, label);
}

function parseArtifactCsv(content, label) {
  const text = Buffer.isBuffer(content) ? content.toString("utf8") : String(content || "");
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        field += character;
      }
      continue;
    }
    if (character === '"') {
      if (field) throw artifactError("V2_TOP20_ARTIFACT_INVALID", `${label} CSV quoting is invalid`, 409);
      quoted = true;
    } else if (character === ",") {
      row.push(field);
      field = "";
    } else if (character === "\n") {
      row.push(field.endsWith("\r") ? field.slice(0, -1) : field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += character;
    }
  }
  if (quoted) throw artifactError("V2_TOP20_ARTIFACT_INVALID", `${label} CSV quoting is incomplete`, 409);
  if (field || row.length) {
    row.push(field.endsWith("\r") ? field.slice(0, -1) : field);
    rows.push(row);
  }
  while (rows.length && rows[rows.length - 1].every((value) => value === "")) rows.pop();
  if (rows.length < 1) throw artifactError("V2_TOP20_ARTIFACT_INVALID", `${label} CSV is empty`, 409);
  const headers = rows.shift().map((value, index) => (
    index === 0 ? String(value).replace(/^\uFEFF/u, "") : String(value)
  ));
  if (headers.some((value) => !value) || new Set(headers).size !== headers.length) {
    throw artifactError("V2_TOP20_ARTIFACT_INVALID", `${label} CSV headers are invalid`, 409);
  }
  for (const [index, values] of rows.entries()) {
    if (values.length !== headers.length) {
      throw artifactError("V2_TOP20_ARTIFACT_INVALID", `${label} CSV row ${index + 1} is invalid`, 409);
    }
  }
  return Object.freeze({
    headers: Object.freeze(headers),
    rows: Object.freeze(rows.map((values) => Object.freeze(values)))
  });
}

function escapeArtifactCsv(value) {
  const text = String(value ?? "");
  const formulaSafe = /^[=+\-@]/u.test(text) ? `'${text}` : text;
  return /[",\r\n]/u.test(formulaSafe) ? `"${formulaSafe.replaceAll('"', '""')}"` : formulaSafe;
}

function writeArtifactCsv(headers, rows) {
  return `\uFEFF${[headers, ...rows].map((values) => values.map(escapeArtifactCsv).join(",")).join("\n")}\n`;
}

function projectV2Top20ArtifactCsv(content, role) {
  const parsed = parseArtifactCsv(content, `top20 ${role}`);
  const urlIndex = parsed.headers.indexOf("url");
  if (urlIndex < 0) {
    return sanitizeText(content, `top20 ${role}`);
  }
  const headers = [...parsed.headers];
  headers[urlIndex] = "source_available";
  if (new Set(headers).size !== headers.length) {
    throw artifactError("V2_TOP20_ARTIFACT_INVALID", `top20 ${role} CSV projected headers are invalid`, 409);
  }
  const rows = parsed.rows.map((values) => values.map((value, index) => (
    index === urlIndex
      ? (String(value || "").trim() ? "true" : "false")
      : sanitizeText(value, `top20 ${role} CSV cell`)
  )));
  return writeArtifactCsv(headers, rows);
}

function top20ArtifactFileRole(filePath) {
  if (filePath === SUMMARY_PATH) return "summary";
  if (filePath === CONTENT_RECEIPT_PATH) return "content_receipt";
  if (filePath === MANIFEST_PATH) return "manifest";
  const csv = /^run\/(platform|overall|ads|regional|ddnayo)\.csv$/u.exec(String(filePath || ""));
  if (csv) return `${csv[1]}_csv`;
  if (/^run\/details\/detail-\d{2}\.json$/u.test(String(filePath || ""))) return "detail_json";
  return "unknown";
}

function auditV2Top20ArtifactFiles(files, stage = "bundle_build") {
  if (!Array.isArray(files)) throw artifactError("V2_TOP20_ARTIFACT_INVALID", "top20 artifact files are invalid");
  const audit = files.map((file) => {
    const filePath = String(file?.path || "");
    const content = Buffer.isBuffer(file?.content) ? file.content : Buffer.from(String(file?.content || ""), "utf8");
    const classified = classifyCollectionArtifactSensitiveContent(filePath, content);
    const safePath = /^(?:top20-summary\.json|top20-content-receipt\.json|run\/(?:manifest\.json|(?:platform|overall|ads|regional|ddnayo)\.csv|details\/detail-\d{2}\.json))$/u.test(filePath)
      ? filePath
      : null;
    const entry = Object.freeze({
      fileRole: top20ArtifactFileRole(filePath),
      safePath,
      filePathHashPrefix: sha256Hex(filePath).slice(0, 12),
      byteLength: content.length,
      sha256Prefix: sha256Hex(content).slice(0, 12),
      accepted: !classified,
      detector: classified?.detector || null
    });
    return entry;
  });
  return Object.freeze(audit);
}

function safeRelativePath(value, label) {
  const text = String(value || "").replaceAll("\\", "/");
  if (
    !text
    || text.startsWith("/")
    || text.includes("\0")
    || path.posix.normalize(text) !== text
    || text.split("/").some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw artifactError("V2_TOP20_ARTIFACT_PATH_INVALID", `${label} path is invalid`);
  }
  return text;
}

function assertInside(root, candidate, label) {
  const absoluteRoot = path.resolve(String(root || ""));
  const absolute = path.resolve(String(candidate || ""));
  const relative = path.relative(absoluteRoot, absolute);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw artifactError("V2_TOP20_ARTIFACT_PATH_INVALID", `${label} must stay inside its root`, 403);
  }
  return absolute;
}

function normalizeTargetResults(manifest) {
  const targets = Array.isArray(manifest.inventoryTargetResults) ? manifest.inventoryTargetResults : [];
  if (targets.length !== V2_TOP20_CONTRACT.maxInventoryCompanies) {
    throw artifactError("V2_TOP20_ARTIFACT_NOT_READY", "top20 artifact does not contain 20 inventory targets", 409);
  }
  const seenPlaceIds = new Set();
  return targets.map((target, index) => {
    const companyOrdinal = Number(target.companyOrdinal);
    const placeId = String(target.placeId || "");
    const status = String(target.status || "");
    if (
      companyOrdinal !== index + 1
      || !/^\d{1,30}$/u.test(placeId)
      || seenPlaceIds.has(placeId)
      || !["ready", "zero"].includes(status)
      || target.revenueInputValid !== true
      || Number(target.bookingBusiness || 0) > 1
      || Number(target.bookingItems || 0) > 1
      || Number(target.dailySchedule || 0) > V2_TOP20_CONTRACT.maxProductsPerCompany
    ) {
      throw artifactError("V2_TOP20_ARTIFACT_NOT_READY", "top20 target result is incomplete", 409);
    }
    seenPlaceIds.add(placeId);
    return Object.freeze({
      companyOrdinal,
      placeId,
      status,
      revenueInputValid: true,
      bookingBusiness: Number(target.bookingBusiness || 0),
      bookingItems: Number(target.bookingItems || 0),
      dailySchedule: Number(target.dailySchedule || 0)
    });
  });
}

function validateReadyManifest(manifest) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw artifactError("V2_TOP20_ARTIFACT_INVALID", "top20 manifest is invalid");
  }
  const calls = manifest.providerCallCounts || {};
  const inventory = calls.inventory || {};
  const results = manifest.inventoryResultCounts || {};
  const targetResults = normalizeTargetResults(manifest);
  const providerCallTrace = validateV2Top20ProviderCallTrace(manifest.providerCallTrace, targetResults);
  const providerCallTraceHash = computeV2Top20ProviderCallTraceHash(providerCallTrace);
  const providerCallCount = Number(calls.total);
  const traceCounts = providerCallTrace.reduce((countsByOperation, call) => {
    countsByOperation[call.operation] += 1;
    return countsByOperation;
  }, { main_place: 0, booking_business: 0, booking_items: 0, daily_schedule: 0 });
  const valid = manifest.collectorActivationProfile === V2_TOP20_PROFILE
    && manifest.collectorScope === V2_TOP20_SCOPE
    && manifest.collectionPurpose === "revenue_detail"
    && manifest.collectionMode === "precision"
    && manifest.productMode === "all"
    && manifest.detailRankRanges === "1-20"
    && manifest.bookingRangeDays === 1
    && manifest.automaticRetry === false
    && manifest.automaticFallback === false
    && manifest.saveRunOnSuccessOnly === true
    && manifest.saveFailureRun === false
    && manifest.revenueEstimateBasis === V2_TOP20_CONTRACT.revenueEstimateBasis
    && Number(manifest.counts?.naverOverall) === 50
    && Number(manifest.counts?.naverBookingStockChecked) === 20
    && Number(results.planned) === 20
    && Number(results.ready || 0) + Number(results.zero || 0) === 20
    && Number(results.missing || 0) === 0
    && Number(results.partial || 0) === 0
    && Number(calls.mainPlace) === 1
    && manifest.providerCallTraceSchemaVersion === V2_TOP20_PROVIDER_CALL_TRACE_SCHEMA_VERSION
    && manifest.providerCallTraceHash === providerCallTraceHash
    && providerCallTrace.length === providerCallCount
    && traceCounts.main_place === Number(calls.mainPlace)
    && traceCounts.booking_business === Number(inventory.bookingBusiness)
    && traceCounts.booking_items === Number(inventory.bookingItems)
    && traceCounts.daily_schedule === Number(inventory.dailySchedule)
    && Number(inventory.total) >= 0
    && providerCallCount === 1 + Number(inventory.total)
    && Number.isInteger(providerCallCount)
    && providerCallCount >= 21
    && providerCallCount <= V2_TOP20_CONTRACT.maximumProviderCalls
    && Number(manifest.providerMaxObservedConcurrency) === 1;
  if (!valid) {
    throw artifactError("V2_TOP20_ARTIFACT_NOT_READY", "top20 manifest is not eligible for persistence", 409);
  }
  for (const target of targetResults) {
    const validSequence = target.bookingBusiness === 1 && (
      target.bookingItems === 0 && target.dailySchedule === 0 && target.status === "zero"
      || target.bookingItems === 1 && target.dailySchedule === 0 && target.status === "zero"
      || target.bookingItems === 1 && target.dailySchedule >= 1
    );
    if (!validSequence) {
      throw artifactError("V2_TOP20_ARTIFACT_NOT_READY", "top20 target call sequence is incomplete", 409);
    }
  }
  return { targetResults, providerCallCount, providerCallTrace, providerCallTraceHash };
}

function validateResilientManifest(manifest) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw artifactError("V2_TOP20_ARTIFACT_INVALID", "top20 manifest is invalid");
  }
  const targets = Array.isArray(manifest.inventoryTargetResults) ? manifest.inventoryTargetResults : [];
  if (targets.length !== V2_TOP20_CONTRACT.maxInventoryCompanies) {
    throw artifactError("V2_TOP20_ARTIFACT_INVALID", "top20 manifest does not contain the requested detail targets", 409);
  }
  const seen = new Set();
  const normalizedTargets = targets.map((target, index) => {
    const placeId = String(target?.placeId || "");
    const status = String(target?.detailCollectionStatus || target?.status || "not_collected");
    if (Number(target?.companyOrdinal) !== index + 1 || !/^\d{1,30}$/u.test(placeId) || seen.has(placeId)
      || !["ready", "zero", "partial", "blocked", "failed", "not_collected", "missing"].includes(status)) {
      throw artifactError("V2_TOP20_ARTIFACT_INVALID", "top20 target result is invalid", 409);
    }
    seen.add(placeId);
    return Object.freeze({
      companyOrdinal: index + 1,
      placeId,
      status,
      detailCollectionStatus: status,
      bookingBusinessIdSource: String(target?.bookingBusinessIdSource || "none"),
      revenueInputValid: target?.revenueInputValid === true
    });
  });
  const trace = normalizeV2Top20ProviderCallTrace(manifest.providerCallTrace);
  const ledger = validateResilientProviderTrace(trace);
  if (
    manifest.collectorActivationProfile !== V2_TOP20_PROFILE
    || manifest.collectorScope !== V2_TOP20_SCOPE
    || manifest.collectionPurpose !== "revenue_detail"
    || manifest.collectionMode !== "precision"
    || manifest.productMode !== "all"
    || manifest.detailRankRanges !== "1-20"
    || manifest.automaticRetry !== false
    || manifest.automaticFallback !== false
    || manifest.saveRunOnSuccessOnly !== true
    || manifest.saveFailureRun !== false
    || Number(manifest.counts?.naverOverall) !== 50
    || ledger.total !== Number(manifest.providerCallCounts?.total)
    || manifest.providerCallTraceHash !== computeV2Top20ProviderCallTraceHash(trace)
  ) {
    throw artifactError("V2_TOP20_ARTIFACT_INVALID", "top20 manifest resilience contract is invalid", 409);
  }
  const summary = summarizeResilientTop20Collection({
    mainPlaceStatus: "ready",
    targets: normalizedTargets,
    detailCircuitOpen: normalizedTargets.some((target) => target.status === "blocked")
  });
  return Object.freeze({ targetResults: normalizedTargets, providerCallCount: ledger.total, providerCallTrace: trace, providerCallTraceHash: computeV2Top20ProviderCallTraceHash(trace), resilience: summary });
}

function parseArtifactFile(files, filePath) {
  const candidates = Array.isArray(files) ? files.filter((file) => file?.path === filePath) : [];
  if (candidates.length !== 1) {
    throw artifactError("V2_TOP20_ARTIFACT_INVALID", `top20 artifact ${filePath} is missing`);
  }
  try {
    return JSON.parse(String(candidates[0].content || ""));
  } catch {
    throw artifactError("V2_TOP20_ARTIFACT_INVALID", `top20 artifact ${filePath} is invalid`);
  }
}

function instant(value, label) {
  const date = value instanceof Date ? new Date(value) : new Date(value || Date.now());
  if (!Number.isFinite(date.getTime())) {
    throw artifactError("V2_TOP20_ARTIFACT_INVALID", `${label} is invalid`);
  }
  return date;
}

function synthesizeReadyExecutionState(targetResults, input = {}) {
  const end = instant(input.now, "top20 artifact time");
  let cursor = new Date(end.getTime() - (V2_TOP20_CONTRACT.maximumProviderCalls * 2 + 10) * 1000);
  const tick = () => {
    cursor = new Date(cursor.getTime() + 1000);
    return cursor.toISOString();
  };
  const reserve = (state, call) => {
    const now = tick();
    const leaseExpiresAt = new Date(Date.parse(now) + 5 * 60 * 1000).toISOString();
    return reserveV2Top20ProviderCall(state, {
      expectedWorkflowRevision: state.workflowRevision,
      call,
      providerGate: {
        circuitState: "closed",
        serviceGlobalLockHeld: true,
        externalCallApproved: true
      },
      heartbeat: {
        now,
        jobHeartbeatAt: now,
        jobLeaseExpiresAt: leaseExpiresAt,
        providerHeartbeatAt: now,
        providerLeaseExpiresAt: leaseExpiresAt
      },
      reservedAt: now
    });
  };
  const record = (state, call, result) => recordV2Top20ProviderResult(state, {
    expectedWorkflowRevision: state.workflowRevision,
    call,
    completedAt: tick(),
    ...result
  });

  let state = createV2Top20ExecutionState();
  state = startV2Top20Execution(state, {
    expectedWorkflowRevision: state.workflowRevision,
    now: tick()
  });
  const mainCall = { operation: "main_place", companyOrdinal: null, productOrdinal: null };
  state = reserve(state, mainCall);
  state = record(state, mainCall, { status: "ready", organicCount: 50 });

  for (const target of targetResults) {
    const companyOrdinal = target.companyOrdinal;
    const businessCall = { operation: "booking_business", companyOrdinal, productOrdinal: null };
    state = reserve(state, businessCall);
    if (target.bookingItems === 0) {
      state = record(state, businessCall, { status: "zero" });
      continue;
    }
    state = record(state, businessCall, { status: "ready" });
    const itemsCall = { operation: "booking_items", companyOrdinal, productOrdinal: null };
    state = reserve(state, itemsCall);
    if (target.dailySchedule === 0) {
      state = record(state, itemsCall, { status: "zero", productCount: 0 });
      continue;
    }
    state = record(state, itemsCall, { status: "ready", productCount: target.dailySchedule });
    for (let productOrdinal = 1; productOrdinal <= target.dailySchedule; productOrdinal += 1) {
      const scheduleCall = { operation: "daily_schedule", companyOrdinal, productOrdinal };
      state = reserve(state, scheduleCall);
      state = record(state, scheduleCall, {
        status: target.status === "zero" ? "zero" : "ready",
        revenueInputValid: true
      });
    }
  }
  state = markV2Top20Validation(state, {
    expectedWorkflowRevision: state.workflowRevision,
    now: tick(),
    manifestValid: true,
    atomicPublishReady: true,
    revenueEstimatesValid: true,
    previewWriteApproved: true,
    executionSucceeded: true,
    providerBlocked: false,
    failureCode: ""
  });
  const decision = decideV2Top20Persistence(state);
  if (!decision.saveRun || state.phase !== "ready_to_persist") {
    throw artifactError("V2_TOP20_ARTIFACT_NOT_READY", "top20 execution state is not persistable", 409);
  }
  return validateExecutionState(state);
}

function buildV2Top20FinalArtifactFiles(input = {}) {
  const contractHash = String(input.contractHash || "");
  const executionIdentityHash = String(input.executionIdentityHash || "");
  const top20ContractHash = String(input.top20ContractHash || "");
  const providerWorkflowRevision = Number(input.providerWorkflowRevision);
  if (
    !/^[a-f0-9]{64}$/u.test(contractHash)
    || !/^[a-f0-9]{64}$/u.test(executionIdentityHash)
    || !/^[a-f0-9]{64}$/u.test(top20ContractHash)
    || !Number.isInteger(providerWorkflowRevision)
    || providerWorkflowRevision < 0
  ) {
    throw artifactError("V2_TOP20_ARTIFACT_INVALID", "top20 final artifact identity is invalid");
  }
  const manifest = parseArtifactFile(input.files, MANIFEST_PATH);
  const validated = validateResilientManifest(manifest);
  const payloadFiles = input.files
    .filter((file) => file?.path !== SUMMARY_PATH && file?.path !== CONTENT_RECEIPT_PATH)
    .map((file) => ({ path: safeRelativePath(file.path, "top20 artifact"), content: String(file.content || "") }));
  const contentHashes = Object.fromEntries(payloadFiles.map((file) => [file.path, sha256Hex(file.content)]));
  const contentReceipt = Object.freeze({
    schemaVersion: V2_TOP20_ARTIFACT_SCHEMA_VERSION,
    contractHash,
    executionIdentityHash,
    contentHashes
  });
  const summary = Object.freeze({
    schemaVersion: COLLECTION_WORKER_V2_TOP20_RESULT_SCHEMA_VERSION,
    top20SchemaVersion: V2_TOP20_SCHEMA_VERSION,
    profile: V2_TOP20_PROFILE,
    collectorScope: V2_TOP20_SCOPE,
    top20ContractHash,
    contractHash,
    executionIdentityHash,
    status: "ready",
    collectionStatus: validated.resilience.collectionStatus,
    mainPlaceStatus: validated.resilience.mainPlaceStatus,
    detailStatus: validated.resilience.detailStatus,
    providerAttemptCount: 1,
    executedCallCount: validated.providerCallCount,
    providerWorkflowRevision,
    automaticRetry: false,
    automaticFallback: false,
        // The child only passes a subtype when it has been safely classified.
        // Never infer a particular block subtype from a partial detail result.
        providerFailureSubtype: manifest.detailCircuitFailureSubtype || null,
    diagnosticId: null,
    executionState: null,
    targetCompanyCount: validated.resilience.targetCompanyCount,
    detailReadyCompanyCount: validated.resilience.detailReadyCompanyCount,
    revenueReadyCompanyCount: validated.resilience.revenueReadyCompanyCount,
    detailCoverageRate: validated.resilience.detailCoverageRate,
    revenueCoverageRate: validated.resilience.revenueCoverageRate
  });
  return deepFreeze({
    summary,
    executionState: null,
    files: [
      { path: SUMMARY_PATH, content: JSON.stringify(summary) },
      { path: CONTENT_RECEIPT_PATH, content: JSON.stringify(contentReceipt) },
      ...payloadFiles
    ]
  });
}

async function collectV2Top20ArtifactFiles(input = {}) {
  const tempRoot = path.resolve(String(input.tempRoot || ""));
  const outputDir = assertInside(tempRoot, input.outputDir, "top20 output directory");
  let manifest;
  try {
    manifest = JSON.parse(await fs.readFile(path.join(outputDir, "manifest.json"), "utf8"));
  } catch {
    throw artifactError("V2_TOP20_ARTIFACT_INVALID", "top20 manifest cannot be read", 502);
  }
  const validated = validateResilientManifest(manifest);
  const detailEntries = Array.isArray(manifest.detailJsonFiles) ? manifest.detailJsonFiles : [];
  if (detailEntries.length > 24) {
    throw artifactError("V2_TOP20_ARTIFACT_OVERSIZE", "top20 detail artifact count exceeds the approved limit", 413);
  }
  const detailPaths = detailEntries.map((entry, index) => {
    const candidate = typeof entry === "string"
      ? entry
      : entry && typeof entry === "object" && !Array.isArray(entry)
        ? entry.file
        : "";
    return safeRelativePath(candidate, `detailJsonFiles.${index}.file`);
  });
  if (new Set(detailPaths).size !== detailPaths.length) {
    throw artifactError("V2_TOP20_ARTIFACT_INVALID", "top20 detail artifact path is duplicated", 409);
  }
  const normalizedRoles = Object.fromEntries(REQUIRED_CSV_ROLES.map((role) => [role, `${role}.csv`]));
  const files = [];
  for (const role of REQUIRED_CSV_ROLES) {
    const sourceName = safeRelativePath(manifest.fileRoles?.[role], `manifest.fileRoles.${role}`);
    const sourcePath = assertInside(outputDir, path.join(outputDir, sourceName), `top20 ${role}`);
    const content = projectV2Top20ArtifactCsv(await fs.readFile(sourcePath, "utf8"), role);
    files.push({ path: `run/${role}.csv`, content });
  }
  const normalizedDetails = [];
  for (let index = 0; index < detailPaths.length; index += 1) {
    const sourceName = safeRelativePath(detailPaths[index], `detailJsonFiles.${index}`);
    const sourcePath = assertInside(outputDir, path.join(outputDir, sourceName), `top20 detail ${index + 1}`);
    let parsed;
    try {
      parsed = JSON.parse(await fs.readFile(sourcePath, "utf8"));
    } catch {
      throw artifactError("V2_TOP20_ARTIFACT_INVALID", "top20 detail JSON is invalid", 502);
    }
    const targetName = `details/detail-${String(index + 1).padStart(2, "0")}.json`;
    normalizedDetails.push(targetName);
    files.push({ path: `run/${targetName}`, content: JSON.stringify(sanitizeJsonValue(parsed)) });
  }
  const sanitizedManifest = sanitizeJsonValue(manifest);
  sanitizedManifest.documentType = "lodging-collection-manifest";
  sanitizedManifest.fileRoles = normalizedRoles;
  sanitizedManifest.files = [...Object.values(normalizedRoles), ...normalizedDetails];
  sanitizedManifest.detailJsonFiles = normalizedDetails;
  sanitizedManifest.workerArtifactSchemaVersion = V2_TOP20_ARTIFACT_SCHEMA_VERSION;
  const manifestContent = JSON.stringify(sanitizedManifest, null, 2);
  files.unshift({ path: MANIFEST_PATH, content: manifestContent });
  const contentHashes = Object.fromEntries(files.map((file) => [file.path, sha256Hex(file.content)]));
  const summary = {
    schemaVersion: V2_TOP20_ARTIFACT_SCHEMA_VERSION,
    status: "ready",
    profile: V2_TOP20_PROFILE,
    collectorScope: V2_TOP20_SCOPE,
    contractHash: String(input.contractHash || ""),
    executionIdentityHash: String(input.executionIdentityHash || ""),
    providerAttemptCount: 1,
    executedCallCount: validated.providerCallCount,
    providerCallTraceHash: validated.providerCallTraceHash,
    automaticRetry: false,
    automaticFallback: false,
    resultStored: false,
    writeCount: 0,
    organicCount: 50,
    inventoryTargetCount: 20,
    collectionStatus: validated.resilience.collectionStatus,
    readyCount: validated.targetResults.filter((item) => item.status === "ready").length,
    zeroCount: validated.targetResults.filter((item) => item.status === "zero").length,
    targetResults: validated.targetResults,
    contentHashes
  };
  files.unshift({ path: SUMMARY_PATH, content: JSON.stringify(summary) });
  return deepFreeze({ summary, manifest: sanitizedManifest, files });
}

function readJsonFileFromVerifiedArtifact(verifiedArtifact, filePath) {
  const file = verifiedArtifact?.bundle?.files?.find((candidate) => candidate.path === filePath);
  if (!file) throw artifactError("V2_TOP20_ARTIFACT_INVALID", `top20 artifact ${filePath} is missing`, 400);
  try {
    return JSON.parse(Buffer.from(file.contentBase64, "base64").toString("utf8"));
  } catch {
    throw artifactError("V2_TOP20_ARTIFACT_INVALID", `top20 artifact ${filePath} is invalid`, 400);
  }
}

function verifyV2Top20ArtifactContents(verifiedArtifact, expected = {}) {
  const summary = readJsonFileFromVerifiedArtifact(verifiedArtifact, SUMMARY_PATH);
  const manifest = readJsonFileFromVerifiedArtifact(verifiedArtifact, MANIFEST_PATH);
  if (summary.schemaVersion === COLLECTION_WORKER_V2_TOP20_RESULT_SCHEMA_VERSION) {
    const receipt = readJsonFileFromVerifiedArtifact(verifiedArtifact, CONTENT_RECEIPT_PATH);
    if (summary.executionState === null) {
      const validated = validateResilientManifest(manifest);
      if (
        summary.status !== "ready"
        || !["complete", "partial", "rank_only"].includes(summary.collectionStatus)
        || summary.contractHash !== expected.contractHash
        || summary.executionIdentityHash !== expected.executionIdentityHash
        || summary.executedCallCount !== validated.providerCallCount
        || summary.automaticRetry !== false
        || summary.automaticFallback !== false
        || receipt.schemaVersion !== V2_TOP20_ARTIFACT_SCHEMA_VERSION
      ) {
        throw artifactError("V2_TOP20_ARTIFACT_INVALID", "top20 resilient artifact summary is invalid", 409);
      }
      return deepFreeze({ summary, manifest, contentReceipt: receipt, targetResults: validated.targetResults, executionState: null });
    }
    const state = validateExecutionState(summary.executionState);
    const decision = decideV2Top20Persistence(state);
    if (
      summary.top20SchemaVersion !== V2_TOP20_SCHEMA_VERSION
      || summary.status !== "ready"
      || summary.profile !== V2_TOP20_PROFILE
      || summary.collectorScope !== V2_TOP20_SCOPE
      || summary.contractHash !== expected.contractHash
      || summary.executionIdentityHash !== expected.executionIdentityHash
      || expected.top20ContractHash && summary.top20ContractHash !== expected.top20ContractHash
      || summary.providerAttemptCount !== 1
      || !Number.isInteger(summary.providerWorkflowRevision)
      || summary.providerWorkflowRevision < 0
      || summary.automaticRetry !== false
      || summary.automaticFallback !== false
      || summary.providerFailureSubtype !== null
      || summary.diagnosticId !== null
      || state.phase !== "ready_to_persist"
      || decision.saveRun !== true
      || state.callLedger.total !== summary.executedCallCount
      || receipt.schemaVersion !== V2_TOP20_ARTIFACT_SCHEMA_VERSION
      || receipt.contractHash !== summary.contractHash
      || receipt.executionIdentityHash !== summary.executionIdentityHash
    ) {
      throw artifactError("V2_TOP20_ARTIFACT_INVALID", "top20 final artifact summary is invalid", 409);
    }
    const validated = validateResilientManifest(manifest);
    if (validated.providerCallCount !== summary.executedCallCount) {
      throw artifactError("V2_TOP20_ARTIFACT_HASH_MISMATCH", "top20 final call ledger does not match", 409);
    }
    for (const [filePath, expectedHash] of Object.entries(receipt.contentHashes || {})) {
      const file = verifiedArtifact.bundle.files.find((candidate) => candidate.path === filePath);
      if (!file || file.sha256 !== expectedHash) {
        throw artifactError("V2_TOP20_ARTIFACT_HASH_MISMATCH", "top20 final content hash does not match", 409);
      }
    }
    return deepFreeze({
      summary,
      manifest,
      contentReceipt: receipt,
      targetResults: validated.targetResults,
      executionState: state
    });
  }
  if (expected.requireFinalSummary === true) {
    throw artifactError("V2_TOP20_ARTIFACT_INVALID", "top20 final artifact summary is required", 409);
  }
  if (
    summary.schemaVersion !== V2_TOP20_ARTIFACT_SCHEMA_VERSION
    || summary.status !== "ready"
    || summary.profile !== V2_TOP20_PROFILE
    || summary.collectorScope !== V2_TOP20_SCOPE
    || summary.contractHash !== expected.contractHash
    || summary.executionIdentityHash !== expected.executionIdentityHash
    || summary.providerAttemptCount !== 1
    || !Number.isInteger(summary.executedCallCount)
    || summary.executedCallCount < 1
    || summary.executedCallCount > V2_TOP20_RESILIENCE_MAXIMUM_PROVIDER_CALLS
    || summary.automaticRetry !== false
    || summary.automaticFallback !== false
    || summary.resultStored !== false
    || summary.writeCount !== 0
    || summary.organicCount !== 50
    || summary.inventoryTargetCount !== 20
  ) {
    throw artifactError("V2_TOP20_ARTIFACT_INVALID", "top20 artifact summary is invalid", 409);
  }
  const validated = validateResilientManifest(manifest);
  if (
    validated.providerCallCount !== summary.executedCallCount
    || summary.providerCallTraceHash !== validated.providerCallTraceHash
  ) {
    throw artifactError("V2_TOP20_ARTIFACT_HASH_MISMATCH", "top20 call ledger does not match the summary", 409);
  }
  for (const [filePath, expectedHash] of Object.entries(summary.contentHashes || {})) {
    const file = verifiedArtifact.bundle.files.find((candidate) => candidate.path === filePath);
    if (!file || file.sha256 !== expectedHash) {
      throw artifactError("V2_TOP20_ARTIFACT_HASH_MISMATCH", "top20 content hash does not match", 409);
    }
  }
  return deepFreeze({ summary, manifest, targetResults: validated.targetResults });
}

module.exports = {
  CONTENT_RECEIPT_PATH,
  CollectionWorkerV2Top20ArtifactError,
  MANIFEST_PATH,
  REQUIRED_CSV_ROLES,
  SUMMARY_PATH,
  V2_TOP20_ARTIFACT_SCHEMA_VERSION,
  V2_TOP20_PROVIDER_CALL_TRACE_SCHEMA_VERSION,
  buildV2Top20FinalArtifactFiles,
  auditV2Top20ArtifactFiles,
  collectV2Top20ArtifactFiles,
  computeV2Top20ProviderCallTraceHash,
  expectedV2Top20ProviderCallTrace,
  normalizeV2Top20ProviderCallTrace,
  parseArtifactCsv,
  projectV2Top20ArtifactCsv,
  sanitizeJsonValue,
  sanitizeArtifactString,
  sanitizeText,
  synthesizeReadyExecutionState,
  validateV2Top20ProviderCallTrace,
  validateResilientManifest,
  validateReadyManifest,
  verifyV2Top20ArtifactContents
};
