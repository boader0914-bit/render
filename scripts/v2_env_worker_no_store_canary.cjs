"use strict";

const {
  V2_ENV_WORKER_PHASE,
  V2_ENV_WORKER_STRATEGY
} = require("./v2_env_worker_contract.cjs");

const SAFE_STATUS = new Set(["ready", "partial", "zero", "blocked", "failed"]);
const SAFE_SUBTYPE = /^(?:http_403|http_429|challenge_html|unknown_access_block|apollo_success)$/u;
const SAFE_DIAGNOSTIC = /^(?:crawl-[a-f0-9]{12})$/u;
const SAFE_ERROR_CODE = /^[A-Z][A-Z0-9_]{2,127}$/u;

function safeCount(value) {
  if (value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 && number <= 50 ? number : null;
}

function safeInstant(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function safeAttemptCount(value) {
  const number = Number(value || 0);
  return number === 1 ? 1 : 0;
}

function projectV2EnvWorkerNoStoreResult(input = {}) {
  const status = SAFE_STATUS.has(String(input.status || "")) ? String(input.status) : "failed";
  const diagnosticId = SAFE_DIAGNOSTIC.test(String(input.diagnosticId || "")) ? String(input.diagnosticId) : null;
  const providerSubtype = SAFE_SUBTYPE.test(String(input.providerFailureSubtype || input.providerSubtype || ""))
    ? String(input.providerFailureSubtype || input.providerSubtype)
    : (status === "ready" || status === "partial" || status === "zero" ? "apollo_success" : null);
  const code = SAFE_ERROR_CODE.test(String(input.code || "")) ? String(input.code) : null;
  return Object.freeze({
    status,
    strategy: V2_ENV_WORKER_STRATEGY,
    phase: V2_ENV_WORKER_PHASE,
    code,
    diagnosticId,
    startedAt: safeInstant(input.startedAt),
    completedAt: safeInstant(input.completedAt),
    providerSubtype,
    observedRankCount: safeCount(input.observedRankCount),
    organicCount: safeCount(input.organicCount),
    adCount: safeCount(input.adCount),
    providerAttemptCount: safeAttemptCount(input.providerAttemptCount),
    executedCallCount: safeAttemptCount(input.executedCallCount),
    resultStored: false,
    writeCount: 0
  });
}

function assertNoStoreMutationLedger(input = {}) {
  const keys = [
    "runWrites",
    "manifestWrites",
    "workbookWrites",
    "companyWrites",
    "productWrites",
    "inventoryWrites",
    "revenueWrites",
    "historyWrites",
    "publicationWrites",
    "regionInsightWrites"
  ];
  if (keys.some((key) => Number(input[key] || 0) !== 0)) {
    throw Object.assign(new Error("V2 environment Worker no-store canary attempted a data write"), {
      code: "V2_ENV_WORKER_WRITE_DETECTED",
      statusCode: 500,
      retryable: false
    });
  }
  return Object.freeze(Object.fromEntries(keys.map((key) => [key, 0])));
}

module.exports = {
  assertNoStoreMutationLedger,
  projectV2EnvWorkerNoStoreResult
};
