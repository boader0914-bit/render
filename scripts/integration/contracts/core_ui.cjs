"use strict";

const crypto = require("node:crypto");

const CORE_STAGE = 227;
const CORE_API_BASE = "/api/integration/core";
const CORE_STORE_KIND = "stage227-provisional-memory";
const CORE_DATA_BOUNDARY = "fresh-only";
const CORE_ROLES = Object.freeze({ admin: "admin", business: "b2b" });
const CORE_JOB_KINDS = Object.freeze([
  "business-search",
  "business-my-lodge",
  "admin-collection"
]);
const CORE_JOB_STATUSES = Object.freeze([
  "queued",
  "running",
  "completed",
  "cancelled",
  "failed"
]);

function cleanText(value, maximum = 240) {
  return String(value || "").normalize("NFKC").replace(/\s+/g, " ").trim().slice(0, maximum);
}

function cleanClientRequestId(value) {
  const id = cleanText(value, 128);
  if (!id || !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(id)) {
    const error = new Error("clientRequestId must be 8-128 URL-safe characters");
    error.statusCode = 400;
    error.code = "CORE_CLIENT_REQUEST_ID_INVALID";
    throw error;
  }
  return id;
}

function normalizeV2CollectionMode(value) {
  const text = cleanText(value, 32).toLowerCase();
  if (["fast", "precision"].includes(text)) return text;
  return "precision";
}

function normalizeV2ProductMode(value) {
  const text = cleanText(value, 32).toLowerCase();
  return ["all", "lodging", "campnic"].includes(text) ? text : "all";
}

function normalizeV2DetailRankRanges(value, fallback = "1-10") {
  const text = cleanText(value || fallback, 32);
  return /^\d{1,2}-\d{1,2}$/.test(text) ? text : fallback;
}

// Mirrors the field meanings used by V2's b2bSearchResultSummary. Stage 227 does
// not calculate replacement business metrics; it only projects fresh fixture values.
function projectV2ResultSummary(data = {}) {
  const items = Array.isArray(data.availability?.items) ? data.availability.items : [];
  const ranked = Array.isArray(data.ranking?.items)
    ? data.ranking.items
    : (Array.isArray(data.ranking?.rankedItems) ? data.ranking.rankedItems : []);
  const stats = data.availability?.stats || {};
  return {
    exposureSampleCount: Number(ranked.length || items.length || 0),
    companyCount: Number(items.length || 0),
    revenueSampleCount: Number(stats.revenueSampleCount || 0),
    averageRevenue: Number(stats.averageAdjustedEstimatedRevenue || 0),
    soldOutRate: Number(stats.weightedSoldOutRate || 0)
  };
}

// Same public keys/defaults as V2's publicB2BSearchHistoryEntry.
function projectV2SearchHistoryEntry(entry = {}) {
  return {
    id: entry.id || "",
    runId: entry.runId || "",
    keyword: entry.keyword || "",
    clientRequestId: entry.clientRequestId || "",
    runLabel: entry.runLabel || "",
    regionLabel: entry.regionLabel || "",
    checkIn: entry.checkIn || "",
    checkOut: entry.checkOut || "",
    detailRankRanges: entry.detailRankRanges || "",
    collectionMode: entry.collectionMode || "",
    collectionModeLabel: entry.collectionModeLabel || "",
    bookingRangeDays: entry.bookingRangeDays || 0,
    status: entry.status || "completed",
    createdAt: entry.createdAt || "",
    completedAt: entry.completedAt || "",
    quotaCounted: entry.quotaCounted !== false,
    reuseMode: entry.reuseMode || "",
    reusedFromRunId: entry.reusedFromRunId || "",
    resultSummary: entry.resultSummary || {}
  };
}

function stableRequestSignature(value = {}) {
  const canonical = {
    kind: cleanText(value.kind, 48),
    tenantCompanyId: cleanText(value.tenantCompanyId, 160),
    keyword: cleanText(value.keyword || value.lodgingName, 180),
    collectionMode: normalizeV2CollectionMode(value.collectionMode),
    productMode: normalizeV2ProductMode(value.productMode),
    detailRankRanges: normalizeV2DetailRankRanges(
      value.detailRankRanges,
      value.kind === "business-my-lodge" ? "1-5" : "1-10"
    ),
    checkIn: cleanText(value.checkIn, 16),
    checkOut: cleanText(value.checkOut, 16)
  };
  return crypto.createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

function provisionalMetadata(options = {}) {
  const fixtureMode = Boolean(options.fixtureMode);
  return {
    stage: CORE_STAGE,
    provisional: true,
    acceptance: "synthetic-fixture-only",
    dataBoundary: CORE_DATA_BOUNDARY,
    store: CORE_STORE_KIND,
    source: fixtureMode ? "synthetic-fresh-collection" : "empty",
    fixtureMode,
    providerCalls: 0,
    legacyRuntimeReads: 0,
    processRestartRecovery: false
  };
}

function publicJob(job = {}) {
  const estimatedTotalSeconds = Number(job.estimatedTotalSeconds || 0) || null;
  const progress = Math.max(0, Math.min(100, Math.round(Number(job.progress || 0))));
  const remainingSeconds = ["completed", "cancelled", "failed"].includes(job.status)
    ? 0
    : (Number(job.remainingSeconds || 0) || null);
  return {
    jobId: job.jobId || "",
    clientRequestId: job.clientRequestId || "",
    kind: CORE_JOB_KINDS.includes(job.kind) ? job.kind : "business-search",
    status: CORE_JOB_STATUSES.includes(job.status) ? job.status : "queued",
    keyword: job.keyword || "",
    tenantCompanyId: job.tenantCompanyId || "",
    collectionMode: normalizeV2CollectionMode(job.collectionMode),
    productMode: normalizeV2ProductMode(job.productMode),
    detailRankRanges: job.detailRankRanges || "",
    progress,
    estimatedProgress: progress,
    estimatedTotalSeconds,
    remainingSeconds,
    estimatedCompleteAt: job.estimatedCompleteAt || "",
    currentStage: job.currentStage || "",
    cancelling: job.status === "cancelled" ? false : Boolean(job.cancelling),
    cancelReason: job.cancelReason || "",
    createdAt: job.createdAt || "",
    startedAt: job.startedAt || "",
    completedAt: job.completedAt || "",
    cancelledAt: job.cancelledAt || "",
    resultSummary: job.resultSummary || {},
    result: job.result || null,
    provisional: true
  };
}

module.exports = {
  CORE_API_BASE,
  CORE_DATA_BOUNDARY,
  CORE_JOB_KINDS,
  CORE_JOB_STATUSES,
  CORE_ROLES,
  CORE_STAGE,
  CORE_STORE_KIND,
  cleanClientRequestId,
  cleanText,
  normalizeV2CollectionMode,
  normalizeV2DetailRankRanges,
  normalizeV2ProductMode,
  projectV2ResultSummary,
  projectV2SearchHistoryEntry,
  provisionalMetadata,
  publicJob,
  stableRequestSignature
};
