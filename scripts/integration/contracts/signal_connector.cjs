"use strict";

const {
  INSIGHTS_SCHEMA_VERSION,
  INSIGHTS_SIGNAL_KINDS,
  canonicalJson,
  cleanId,
  cleanText,
  normalizeLiveSignalObservation,
  normalizeSignalObservation,
  requiredMonth,
  stableHash
} = require("./insights.cjs");

const SIGNAL_CONNECTOR_STAGE = 231;
const SIGNAL_CONNECTOR_SCHEMA_VERSION = 1;
const SIGNAL_CONNECTOR_STORE_KIND = "glamping-datalab-v2-stage231-signal-connector-store";
const SIGNAL_CONNECTOR_DIRECTORY = "stage231-signal-connectors";
const SIGNAL_CONNECTOR_JOB_STATES = Object.freeze([
  "queued",
  "running",
  "retry-wait",
  "completed",
  "failed",
  "cancelled"
]);
const SIGNAL_CONNECTOR_ERROR_CATEGORIES = Object.freeze([
  "429",
  "auth",
  "quota",
  "empty",
  "schema",
  "timeout",
  "provider",
  "cancelled"
]);
const SIGNAL_CONNECTOR_RETRYABLE_CATEGORIES = new Set(["429", "empty", "timeout"]);

function connectorError(message, code, statusCode = 400, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  Object.assign(error, details);
  return error;
}

function positiveInteger(value, label, minimum = 1, maximum = Number.MAX_SAFE_INTEGER) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    throw connectorError(`${label} must be an integer from ${minimum} to ${maximum}`, "SIGNAL_CONNECTOR_LIMIT_INVALID");
  }
  return number;
}

function nonNegativeNumber(value, label, maximum = Number.MAX_SAFE_INTEGER) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number > maximum) {
    throw connectorError(`${label} must be a non-negative number`, "SIGNAL_CONNECTOR_LIMIT_INVALID");
  }
  return Math.round(number * 1_000_000) / 1_000_000;
}

function normalizeSignalKinds(value) {
  const rows = [...new Set((Array.isArray(value) ? value : []).map((entry) => cleanText(entry, 80)).filter(Boolean))];
  if (!rows.length || rows.some((kind) => !INSIGHTS_SIGNAL_KINDS.includes(kind))) {
    throw connectorError("signalKinds must reuse supported Stage 229 signal kinds", "SIGNAL_CONNECTOR_SIGNAL_KIND_INVALID");
  }
  return rows.sort();
}

function normalizeClientRequestId(value) {
  const id = cleanId(value, "clientRequestId", 128);
  if (id.length < 8 || id.length > 128) {
    throw connectorError("clientRequestId must be 8-128 URL-safe characters", "SIGNAL_CONNECTOR_CLIENT_REQUEST_INVALID");
  }
  return id;
}

function normalizeSignalJobRequest(payload = {}) {
  const mode = cleanText(payload.mode || "real", 24).toLowerCase();
  if (!["real", "fixture"].includes(mode)) {
    throw connectorError("Signal connector mode must be real or fixture", "SIGNAL_CONNECTOR_MODE_INVALID");
  }
  const clientRequestId = normalizeClientRequestId(payload.clientRequestId);
  const providerId = cleanId(payload.providerId, "providerId", 120);
  const companyId = cleanId(payload.companyId, "companyId");
  const tenantCompanyId = cleanId(payload.tenantCompanyId, "tenantCompanyId");
  const periodMonth = requiredMonth(payload.periodMonth, "periodMonth");
  const region = cleanText(payload.region, 160);
  if (!region) throw connectorError("region is required", "SIGNAL_CONNECTOR_REGION_REQUIRED");
  const signalKinds = normalizeSignalKinds(payload.signalKinds);
  const dailyCallCap = positiveInteger(payload.dailyCallCap, "dailyCallCap", 1, 1_000_000);
  const monthlyCallCap = positiveInteger(payload.monthlyCallCap, "monthlyCallCap", dailyCallCap, 10_000_000);
  const callsPerRun = positiveInteger(payload.callsPerRun ?? 1, "callsPerRun", 1, dailyCallCap);
  const costPerCall = nonNegativeNumber(payload.costPerCall ?? 0, "costPerCall", 1_000_000);
  const dailyCostCap = nonNegativeNumber(payload.dailyCostCap ?? dailyCallCap * costPerCall, "dailyCostCap", 1_000_000_000);
  const monthlyCostCap = nonNegativeNumber(payload.monthlyCostCap ?? monthlyCallCap * costPerCall, "monthlyCostCap", 1_000_000_000);
  const maxAttempts = positiveInteger(payload.maxAttempts ?? 3, "maxAttempts", 1, 8);
  const timeoutMs = positiveInteger(payload.timeoutMs ?? 30_000, "timeoutMs", 100, 120_000);
  const target = {
    companyId,
    tenantCompanyId,
    region,
    periodMonth,
    signalKinds
  };
  const quota = {
    callsPerRun,
    costPerCall,
    dailyCallCap,
    monthlyCallCap,
    dailyCostCap,
    monthlyCostCap,
    currency: cleanText(payload.currency || "KRW", 8).toUpperCase()
  };
  const signature = stableHash(canonicalJson({ mode, providerId, target, quota, maxAttempts, timeoutMs }), 48);
  return {
    schemaVersion: SIGNAL_CONNECTOR_SCHEMA_VERSION,
    clientRequestId,
    mode,
    providerId,
    target,
    quota,
    maxAttempts,
    timeoutMs,
    signature
  };
}

function normalizeConnectorSignal(record, mode) {
  if (mode === "fixture") return normalizeSignalObservation(record);
  if (mode === "real") return normalizeLiveSignalObservation(record);
  throw connectorError("Unknown signal connector mode", "SIGNAL_CONNECTOR_MODE_INVALID");
}

function classifyProviderError(reason) {
  const error = reason && typeof reason === "object" ? reason : {};
  const explicit = cleanText(error.category, 32).toLowerCase();
  if (SIGNAL_CONNECTOR_ERROR_CATEGORIES.includes(explicit)) return explicit;
  const status = Number(error.statusCode || error.status || error.response?.status || 0);
  const code = cleanText(error.code, 120).toLowerCase();
  const message = cleanText(error.message || reason, 500).toLowerCase();
  if (status === 429 || /(?:rate.?limit|too many requests|http.?429)/i.test(`${code} ${message}`)) return "429";
  if ([401, 403].includes(status) || /(?:unauthori[sz]ed|forbidden|credential|api.?key|auth)/i.test(`${code} ${message}`)) return "auth";
  if (/(?:quota|budget|daily.?cap|monthly.?cap)/i.test(`${code} ${message}`)) return "quota";
  if (/(?:empty|no.?result|zero.?result)/i.test(`${code} ${message}`)) return "empty";
  if (/(?:schema|validation|parse|malformed|invalid.?payload)/i.test(`${code} ${message}`)) return "schema";
  if (error.name === "AbortError" || /(?:timeout|timed.?out|etimedout)/i.test(`${code} ${message}`)) return "timeout";
  if (/(?:cancelled|canceled|abort)/i.test(`${code} ${message}`)) return "cancelled";
  return "provider";
}

function retryAfterMilliseconds(reason, now = Date.now()) {
  const direct = Number(reason?.retryAfterSeconds ?? reason?.retryAfter ?? 0);
  if (Number.isFinite(direct) && direct > 0) return Math.ceil(direct * 1000);
  const header = reason?.response?.headers?.get?.("retry-after") || reason?.headers?.["retry-after"] || reason?.headers?.["Retry-After"];
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds > 0) return Math.ceil(seconds * 1000);
  const date = Date.parse(String(header || ""));
  return Number.isFinite(date) && date > now ? date - now : 0;
}

function retryBackoffMilliseconds(attempt, reason, options = {}) {
  const base = positiveInteger(options.baseMs ?? 1_000, "baseMs", 1, 3_600_000);
  const maximum = positiveInteger(options.maximumMs ?? 3_600_000, "maximumMs", base, 86_400_000);
  return Math.min(maximum, Math.max(retryAfterMilliseconds(reason, options.now ?? Date.now()), base * (2 ** Math.max(0, Number(attempt || 1) - 1))));
}

function publicProviderError(reason) {
  const category = classifyProviderError(reason);
  const messages = {
    "429": "provider 요청 한도에 도달했습니다.",
    auth: "provider 인증을 확인해야 합니다.",
    quota: "승인된 provider quota를 초과했습니다.",
    empty: "provider가 빈 결과를 반환했습니다.",
    schema: "provider 응답 계약이 일치하지 않습니다.",
    timeout: "provider 응답 시간이 초과되었습니다.",
    cancelled: "수집 작업이 취소되었습니다.",
    provider: "provider 요청을 처리하지 못했습니다."
  };
  const safeCode = cleanText(reason?.code || `SIGNAL_PROVIDER_${category.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`, 120)
    .replace(/[^A-Za-z0-9_:-]/g, "_");
  return {
    category,
    code: safeCode,
    message: messages[category]
  };
}

function assertSignalJobTransition(from, to) {
  const allowed = {
    queued: ["running", "cancelled"],
    running: ["retry-wait", "completed", "failed", "cancelled"],
    "retry-wait": ["queued", "running", "failed", "cancelled"],
    failed: ["queued"],
    cancelled: ["queued"],
    completed: []
  }[from] || [];
  if (!allowed.includes(to)) {
    throw connectorError(`Invalid signal job transition: ${from} -> ${to}`, "SIGNAL_CONNECTOR_STATE_INVALID", 409);
  }
  return true;
}

module.exports = {
  INSIGHTS_SCHEMA_VERSION,
  INSIGHTS_SIGNAL_KINDS,
  SIGNAL_CONNECTOR_DIRECTORY,
  SIGNAL_CONNECTOR_ERROR_CATEGORIES,
  SIGNAL_CONNECTOR_JOB_STATES,
  SIGNAL_CONNECTOR_RETRYABLE_CATEGORIES,
  SIGNAL_CONNECTOR_SCHEMA_VERSION,
  SIGNAL_CONNECTOR_STAGE,
  SIGNAL_CONNECTOR_STORE_KIND,
  assertSignalJobTransition,
  classifyProviderError,
  connectorError,
  normalizeClientRequestId,
  normalizeConnectorSignal,
  normalizeSignalJobRequest,
  publicProviderError,
  retryAfterMilliseconds,
  retryBackoffMilliseconds
};
