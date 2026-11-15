"use strict";

// Immutable final analysis artifacts. No source adapters, collectors, queues,
// credentials, or mutable result cache. The bundle owns safe file reads and
// atomic generation publication; these helpers only encode/validate bytes.
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const { gzipSync, gunzipSync } = require("node:zlib");
const VERSION = "keyword-monthly-prepared-result-v1";
// Keep a final response below the HTTP layer's 32MiB cap after its fixed
// provenance/generation wrapper is added. Original projection limits are not
// widened or reduced by this independent derived-result delivery budget.
const LIMITS = Object.freeze({ encodedBytes: 8 * 1024 * 1024, responseBytes: 32 * 1024 * 1024,
  wrapperBytes: 64 * 1024, decodedBytes: 32 * 1024 * 1024 - 64 * 1024,
  results: 8192, nodes: 500000 });
const SHA = /^[a-f0-9]{64}$/, MONTH = /^20\d{2}-(0[1-9]|1[0-2])$/;
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const plain = value => value !== null && typeof value === "object" && !Array.isArray(value);
const exact = (value, keys) => plain(value) && Object.keys(value).every(key => keys.includes(key)) && keys.every(key => Object.hasOwn(value, key));
const text = value => typeof value === "string" && value === value.trim() && value.length > 0 && value.length <= 300 && !/[\u0000-\u001f\u007f]/.test(value);
const day = value => typeof value === "string" && /^20\d{2}-\d\d-\d\d$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
const iso = value => typeof value === "string" && /^20\d{2}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(value) && Number.isFinite(Date.parse(value)) && day(value.slice(0, 10));
const kstDay = value => new Date(Date.parse(value) + 9 * 3600000).toISOString().slice(0, 10);
function fault(code) { return Object.assign(new Error(code), { code, statusCode: 503 }); }
function need(value, code) { if (!value) throw fault(code); }
let fingerprint;
function calculationFingerprint() {
  // Normalize checkout line endings so a Windows preparation and a Linux
  // deployment of the exact same Git text identify the same engine.
  return fingerprint ||= hash(JSON.stringify([VERSION, ...[
    "keyword_monthly_prepared_results.cjs", "keyword_monthly_analysis.cjs", "monthly_reports.cjs",
    "monthly_report_comparison.cjs", "monthly_report_insights.cjs", "saved_product_recovery.cjs", "monthly_report_actions.cjs"
  ].map(name => [name, hash(fs.readFileSync(path.join(__dirname, name), "utf8").replace(/\r\n/g, "\n"))]) ]));
}
function queryId(value) { return JSON.stringify([value.keyword, value.month, value.cutoffDate]); }
function validQuery(value) { return exact(value, ["keyword", "month", "cutoffDate"]) && text(value.keyword) && MONTH.test(value.month) && day(value.cutoffDate); }
function validatePreparedDescriptor(value) {
  const fields = ["keyword", "month", "cutoffDate", "partition", "sha256", "bytes", "sourceProjectionSha256", "sourceDigest", "calculationFingerprint"];
  const optional = value?.encoding === undefined ? [] : ["encoding", "uncompressedBytes"];
  need(exact(value, [...fields, ...optional]) && validQuery({ keyword: value.keyword, month: value.month, cutoffDate: value.cutoffDate })
    && ["partition", "sha256", "sourceProjectionSha256", "sourceDigest", "calculationFingerprint"].every(key => SHA.test(value[key] || ""))
    && Number.isSafeInteger(value.bytes) && value.bytes > 0 && value.bytes <= LIMITS.encodedBytes
    && (optional.length ? value.encoding === "gzip" && Number.isSafeInteger(value.uncompressedBytes) && value.uncompressedBytes > 0 && value.uncompressedBytes <= LIMITS.decodedBytes
      : value.bytes <= LIMITS.decodedBytes), "KEYWORD_MONTHLY_RESULT_DESCRIPTOR_INVALID");
  return value;
}
function validatePayload(result, descriptor) {
  need(plain(result) && result.schemaVersion === 1 && result.readOnly === true && result.networkAttempted === false
    && ["available", "stale"].includes(result.status) && validQuery(result.request) && queryId(result.request) === queryId(descriptor)
    && plain(result.snapshot) && result.snapshot.schemaVersion === 1 && iso(result.snapshot.generatedAt)
    && result.snapshot.request?.type === "keyword" && result.snapshot.request?.targetId === descriptor.keyword
    && result.snapshot.request?.month === descriptor.month && result.snapshot.request?.cutoffDate === descriptor.cutoffDate
    && result.snapshot.context === null && plain(result.snapshot.sources) && SHA.test(result.snapshot.sources.digest || "")
    && Array.isArray(result.snapshot.sources.observations) && plain(result.provenance)
    && result.provenance.indexSha256 === descriptor.partition && result.provenance.projectionSha256 === descriptor.sourceProjectionSha256
    && result.provenance.sourceDigest === descriptor.sourceDigest && result.provenance.calculationVersion === "keyword-monthly-v1"
    && result.provenance.originalFreshnessVerified === false && result.provenance.networkAttempted === false && result.provenance.contextIncluded === false
    && iso(result.provenance.materializedAt) && iso(result.provenance.dataThrough)
    && Date.parse(result.provenance.dataThrough) <= Date.parse(result.provenance.materializedAt)
    && Array.isArray(result.diagnostics) && result.diagnostics.length <= 100
    && result.diagnostics.every(code => typeof code === "string" && /^[A-Z][A-Z0-9_]{0,99}$/.test(code)), "KEYWORD_MONTHLY_RESULT_PAYLOAD_INVALID");
  // Stored snapshots contain only the existing public projection. Reject
  // accidental private-field expansion even if a producer recomputed hashes.
  let nodes = 0; const visit = (value, depth = 0) => {
    need(++nodes <= LIMITS.nodes && depth <= 32, "KEYWORD_MONTHLY_RESULT_SHAPE_BOUND");
    if (typeof value === "number") need(Number.isFinite(value), "KEYWORD_MONTHLY_RESULT_PAYLOAD_INVALID");
    if (Array.isArray(value)) for (const item of value) visit(item, depth + 1);
    else if (plain(value)) for (const [key, item] of Object.entries(value)) {
      need(!/(?:password|cookie|authorization|secret|token|private|rawPayload|guest|customer|contact|address|account|kosis)/i.test(key), "KEYWORD_MONTHLY_RESULT_UNSAFE_FIELDS");
      visit(item, depth + 1);
    }
  }; visit(result);
  return result;
}
function encodePreparedResult(result, { partition, compression = "auto" } = {}) {
  need(["auto", "gzip"].includes(compression), "KEYWORD_MONTHLY_RESULT_BUILD_INVALID");
  const descriptor = { ...result?.request, partition, sha256: "0".repeat(64), bytes: 1,
    sourceProjectionSha256: result?.provenance?.projectionSha256, sourceDigest: result?.provenance?.sourceDigest,
    calculationFingerprint: calculationFingerprint() };
  validatePreparedDescriptor(descriptor); validatePayload(result, descriptor);
  const envelope = { schemaVersion: 1, kind: VERSION, calculationFingerprint: descriptor.calculationFingerprint, result };
  const decoded = Buffer.from(JSON.stringify(envelope)); need(decoded.length <= LIMITS.decodedBytes, "KEYWORD_MONTHLY_RESULT_SIZE_LIMIT");
  const compressed = compression === "gzip" || decoded.length > 2 * 1024 * 1024;
  const bytes = compressed ? gzipSync(decoded, { level: 6 }) : decoded;
  need(bytes.length <= LIMITS.encodedBytes, "KEYWORD_MONTHLY_RESULT_SIZE_LIMIT");
  Object.assign(descriptor, { sha256: hash(bytes), bytes: bytes.length, ...(compressed ? { encoding: "gzip", uncompressedBytes: decoded.length } : {}) });
  return { descriptor: validatePreparedDescriptor(descriptor), bytes };
}
function decodePreparedResult(read, descriptor, { currentDay, staleAfterMs = 86400000, now, sourceProvenance } = {}) {
  validatePreparedDescriptor(descriptor);
  need(descriptor.calculationFingerprint === calculationFingerprint(), "KEYWORD_MONTHLY_RESULT_CALCULATION_CHANGED");
  need(Buffer.isBuffer(read?.bytes) && read.bytes.length === descriptor.bytes && hash(read.bytes) === descriptor.sha256, "KEYWORD_MONTHLY_RESULT_MISMATCH");
  let decoded = read.bytes;
  if (descriptor.encoding === "gzip") {
    try { decoded = gunzipSync(read.bytes, { maxOutputLength: LIMITS.decodedBytes }); } catch { throw fault("KEYWORD_MONTHLY_RESULT_COMPRESSION_INVALID"); }
    need(decoded.length === descriptor.uncompressedBytes, "KEYWORD_MONTHLY_RESULT_MISMATCH");
  }
  need(decoded.length <= LIMITS.decodedBytes, "KEYWORD_MONTHLY_RESULT_SIZE_LIMIT");
  let envelope; try { envelope = JSON.parse(decoded.toString("utf8")); } catch { throw fault("KEYWORD_MONTHLY_RESULT_JSON_INVALID"); }
  need(exact(envelope, ["schemaVersion", "kind", "calculationFingerprint", "result"]) && envelope.schemaVersion === 1
    && envelope.kind === VERSION && envelope.calculationFingerprint === descriptor.calculationFingerprint, "KEYWORD_MONTHLY_RESULT_MISMATCH");
  const result = validatePayload(envelope.result, descriptor), provenance = result.provenance;
  need(!sourceProvenance || JSON.stringify(Object.fromEntries(Object.keys(sourceProvenance).map(key => [key, provenance[key]]))) === JSON.stringify(sourceProvenance), "KEYWORD_MONTHLY_RESULT_SOURCE_MISMATCH");
  need(day(currentDay) && Number.isFinite(Date.parse(now)) && Number.isFinite(staleAfterMs) && staleAfterMs >= 0, "KEYWORD_MONTHLY_RESULT_CLOCK_INVALID");
  need(Date.parse(result.snapshot.generatedAt) <= Date.parse(now) + 60000, "KEYWORD_MONTHLY_RESULT_CLOCK_INVALID");
  const elapsed = Date.parse(now) - Date.parse(provenance.materializedAt);
  need(elapsed >= -60000 && result.request.cutoffDate <= currentDay, "KEYWORD_MONTHLY_RESULT_CLOCK_INVALID");
  const diagnostics = result.diagnostics.filter(code => !["PROJECTION_EXPIRED", "CUTOFF_AFTER_DATA_THROUGH"].includes(code));
  if (elapsed > staleAfterMs) diagnostics.push("PROJECTION_EXPIRED");
  if (provenance.observationScope !== "selected_only" && result.request.cutoffDate > kstDay(provenance.dataThrough)) diagnostics.push("CUTOFF_AFTER_DATA_THROUGH");
  return { ...result, currentDay, currentMonth: currentDay.slice(0, 7), diagnostics,
    status: diagnostics.some(code => ["PROJECTION_EXPIRED", "CUTOFF_AFTER_DATA_THROUGH"].includes(code)) ? "stale" : "available",
    preparedResult: { status: "ready", calculationFingerprint: descriptor.calculationFingerprint, sha256: descriptor.sha256,
      generatedAt: result.snapshot.generatedAt, sourceRevalidated: false } };
}
module.exports = { calculationFingerprint, queryId, validatePreparedDescriptor, encodePreparedResult, decodePreparedResult,
  KEYWORD_MONTHLY_PREPARED_RESULT_LIMITS: LIMITS, KEYWORD_MONTHLY_PREPARED_RESULT_VERSION: VERSION };
