"use strict";

const crypto = require("node:crypto");

const SNAPSHOT_SCHEMA_VERSION = "location-collection-snapshot.v1";
const SNAPSHOT_HISTORY_SCHEMA_VERSION = "location-collection-snapshot-history.v1";
const SNAPSHOT_STATUSES = Object.freeze(["ready", "zero", "missing", "partial", "stale", "conflict"]);
const CONFIDENCE_GRADES = Object.freeze(["A", "B", "C", "D", "U"]);
const FRESHNESS_STATUSES = Object.freeze(["fresh", "aging", "stale", "unknown"]);
const SUCCESSFUL_SNAPSHOT_STATUSES = new Set(["ready", "zero"]);
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const REGION_KEY_PATTERN = /^kr_[a-z0-9_]+$/;
const SAFE_ID_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N}._:@+\/-]{0,299}$/u;
const SNAPSHOT_FIELDS = new Set([
  "schemaVersion",
  "snapshotId",
  "taskKey",
  "sourceId",
  "regionKey",
  "sharedCollectionScope",
  "operation",
  "measurementPeriod",
  "overlapPeriod",
  "collectedAt",
  "asOf",
  "providerPublishedAt",
  "watermark",
  "requestPlanVersion",
  "mappingVersion",
  "sourceSchemaVersion",
  "sampleCount",
  "coverage",
  "status",
  "confidence",
  "penalties",
  "contentHash",
  "supersedesSnapshotId",
  "provenance"
]);
const HISTORY_FIELDS = new Set([
  "schemaVersion",
  "historyId",
  "sourceId",
  "regionKey",
  "sharedCollectionScope",
  "createdAt",
  "updatedAt",
  "snapshots"
]);
const FORBIDDEN_STORAGE_KEYS = new Set([
  "headers",
  "requestheaders",
  "responseheaders",
  "query",
  "queryparams",
  "queryparameters",
  "searchparams",
  "requestquery",
  "requesturl",
  "rawrequest",
  "credential",
  "credentials",
  "authorization",
  "cookie",
  "cookies",
  "apikey",
  "servicekey",
  "secret",
  "clientsecret",
  "customerid",
  "accesstoken",
  "refreshtoken",
  "password",
  "signature",
  "privatekey",
  "accesskey"
]);
const SENSITIVE_KEY_TOKENS = Object.freeze([
  "credential",
  "authorization",
  "cookie",
  "apikey",
  "servicekey",
  "secret",
  "accesstoken",
  "refreshtoken",
  "password",
  "signature",
  "privatekey",
  "accesskey",
  "customerid"
]);
const TRANSPORT_KEY_TOKENS = Object.freeze([
  "headers",
  "requestheaders",
  "responseheaders",
  "query",
  "queryparams",
  "queryparameters",
  "searchparams",
  "requestquery",
  "requesturl",
  "rawrequest"
]);

class CollectionSnapshotContractError extends Error {
  constructor(errors = []) {
    super(`Invalid collection snapshot contract: ${errors.map((entry) => `${entry.path}:${entry.code}`).join(", ")}`);
    this.name = "CollectionSnapshotContractError";
    this.code = "LOCATION_COLLECTION_SNAPSHOT_INVALID";
    this.errors = errors;
  }
}

function deepFreeze(value, seen = new WeakSet()) {
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function text(value, max = 320) {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}

function stableJson(value) {
  return JSON.stringify(stable(value));
}

function hash(value) {
  return crypto.createHash("sha256").update(stableJson(value), "utf8").digest("hex");
}

function normalizedKey(value = "") {
  return String(value).normalize("NFKC").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function forbiddenStorageKey(value = "") {
  const normalized = normalizedKey(value);
  if (FORBIDDEN_STORAGE_KEYS.has(normalized)) return true;
  return [...SENSITIVE_KEY_TOKENS, ...TRANSPORT_KEY_TOKENS]
    .some((token) => normalized.startsWith(token) || normalized.endsWith(token));
}

function credentialUrl(value) {
  if (typeof value !== "string" || !/^[a-z][a-z0-9+.-]*:\/\//i.test(value.trim())) return false;
  try {
    const parsed = new URL(value);
    if (parsed.username || parsed.password) return true;
    return [...parsed.searchParams.keys()].some(forbiddenStorageKey);
  } catch {
    return true;
  }
}

function forbiddenStoragePath(value, path = "snapshot", seen = new WeakSet()) {
  if (typeof value === "string") return credentialUrl(value) ? path : "";
  if (!value || typeof value !== "object") return "";
  if (seen.has(value)) return path;
  seen.add(value);
  for (const [key, child] of Object.entries(value)) {
    const childPath = `${path}.${key}`;
    if (forbiddenStorageKey(key)) return childPath;
    const nested = forbiddenStoragePath(child, childPath, seen);
    if (nested) return nested;
  }
  return "";
}

function safeJsonValue(value, path = "value", seen = new WeakSet()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new CollectionSnapshotContractError([{ path, code: "invalid_number", message: "Only finite JSON numbers are allowed" }]);
    return value;
  }
  if (Array.isArray(value)) return value.map((entry, index) => safeJsonValue(entry, `${path}[${index}]`, seen));
  if (!plainObject(value) || seen.has(value)) {
    throw new CollectionSnapshotContractError([{ path, code: "invalid_json_value", message: "Only acyclic plain JSON values are allowed" }]);
  }
  seen.add(value);
  const result = {};
  for (const [key, child] of Object.entries(value)) result[text(key, 160)] = safeJsonValue(child, `${path}.${key}`, seen);
  seen.delete(value);
  return result;
}

function timestamp(value) {
  if (value === null || value === undefined || value === "") return "";
  const raw = value instanceof Date ? value.toISOString() : text(value, 48);
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : raw;
}

function temporal(value) {
  if (value === null || value === undefined || value === "") return "";
  const raw = text(value, 48);
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw) && Number.isFinite(Date.parse(`${raw}T00:00:00.000Z`))) return raw;
  return timestamp(raw);
}

function validDateOnly(value) {
  const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return false;
  const parsed = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return parsed.toISOString().slice(0, 10) === value;
}

function validTemporal(value) {
  if (!value) return false;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return validDateOnly(value);
  return Number.isFinite(Date.parse(value));
}

function epoch(value) {
  if (!validTemporal(value)) return null;
  return Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00.000Z` : value);
}

function nonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0 ? value : null;
}

function finite(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizePeriod(value, { nullable = false } = {}) {
  if (nullable && (value === null || value === undefined || value === "")) return null;
  const source = plainObject(value) ? value : {};
  return { from: temporal(source.from), to: temporal(source.to) };
}

function normalizeCoverage(value = {}) {
  const source = plainObject(value) ? value : {};
  const numerator = nonNegativeInteger(source.numerator);
  const denominator = nonNegativeInteger(source.denominator);
  return {
    numerator,
    denominator,
    ratio: numerator !== null && denominator !== null && denominator > 0 ? numerator / denominator : null,
    note: text(source.note, 400)
  };
}

function normalizePenalty(value = {}, index = 0) {
  if (typeof value === "string") return { code: text(value, 120), message: "", points: null };
  const source = plainObject(value) ? value : {};
  return {
    code: text(source.code, 120),
    message: text(source.message, 500),
    points: finite(source.points)
  };
}

function normalizeConfidence(value = {}, status = "missing") {
  const source = plainObject(value) ? value : {};
  const unknown = status === "missing" || status === "conflict";
  return {
    grade: text(source.grade || (unknown ? "U" : ""), 8).toUpperCase(),
    score: unknown ? null : finite(source.score)
  };
}

function normalizeCollectionSnapshot(input = {}) {
  const source = plainObject(input) ? input : {};
  const status = text(source.status || "missing", 24).toLowerCase();
  const normalized = {
    schemaVersion: text(source.schemaVersion || SNAPSHOT_SCHEMA_VERSION, 120),
    snapshotId: text(source.snapshotId, 300),
    taskKey: text(source.taskKey, 300),
    sourceId: text(source.sourceId, 200),
    regionKey: text(source.regionKey, 160),
    sharedCollectionScope: text(source.sharedCollectionScope, 160),
    operation: text(source.operation, 160),
    measurementPeriod: normalizePeriod(source.measurementPeriod),
    overlapPeriod: normalizePeriod(source.overlapPeriod, { nullable: true }),
    collectedAt: timestamp(source.collectedAt),
    asOf: timestamp(source.asOf),
    providerPublishedAt: timestamp(source.providerPublishedAt),
    watermark: source.watermark === undefined ? null : safeJsonValue(source.watermark, "snapshot.watermark"),
    requestPlanVersion: text(source.requestPlanVersion, 120),
    mappingVersion: text(source.mappingVersion, 120),
    sourceSchemaVersion: text(source.sourceSchemaVersion, 120),
    sampleCount: nonNegativeInteger(source.sampleCount),
    coverage: normalizeCoverage(source.coverage),
    status,
    confidence: normalizeConfidence(source.confidence, status),
    penalties: Array.isArray(source.penalties) ? source.penalties.map(normalizePenalty) : [],
    contentHash: text(source.contentHash, 64).toLowerCase(),
    supersedesSnapshotId: text(source.supersedesSnapshotId, 300),
    provenance: plainObject(source.provenance) ? safeJsonValue(source.provenance, "snapshot.provenance") : {}
  };
  return normalized;
}

function snapshotHashPayload(snapshot) {
  const payload = { ...snapshot };
  delete payload.contentHash;
  return payload;
}

function computeCollectionContentHash(input = {}) {
  const forbiddenPath = forbiddenStoragePath(input);
  if (forbiddenPath) {
    throw new CollectionSnapshotContractError([{
      path: forbiddenPath,
      code: "sensitive_transport_metadata_forbidden",
      message: "Collection snapshots must not persist credentials or request query/header material"
    }]);
  }
  return hash(snapshotHashPayload(normalizeCollectionSnapshot(input)));
}

function error(errors, path, code, message) {
  errors.push({ path, code, message });
}

function validateId(errors, path, value) {
  if (!value) error(errors, path, "required", `${path} is required`);
  else if (!SAFE_ID_PATTERN.test(value)) error(errors, path, "invalid_id", `${path} contains unsupported characters`);
}

function validatePeriod(errors, path, value, { nullable = false } = {}) {
  if (nullable && value === null) return;
  if (!plainObject(value)) {
    error(errors, path, "invalid_type", `${path} must be an object`);
    return;
  }
  if (!validDateOnly(value.from)) error(errors, `${path}.from`, "invalid_date", `${path}.from must be a real YYYY-MM-DD calendar date`);
  if (!validDateOnly(value.to)) error(errors, `${path}.to`, "invalid_date", `${path}.to must be a real YYYY-MM-DD calendar date`);
  if (epoch(value.from) !== null && epoch(value.to) !== null && epoch(value.from) > epoch(value.to)) {
    error(errors, `${path}.to`, "invalid_range", `${path}.to must not precede from`);
  }
}

function validateCoverage(errors, coverage = {}) {
  if (coverage.numerator !== null && nonNegativeInteger(coverage.numerator) === null) error(errors, "coverage.numerator", "invalid_count", "coverage numerator must be null or a non-negative integer");
  if (coverage.denominator !== null && nonNegativeInteger(coverage.denominator) === null) error(errors, "coverage.denominator", "invalid_count", "coverage denominator must be null or a non-negative integer");
  if (coverage.numerator !== null && coverage.denominator !== null && coverage.numerator > coverage.denominator) error(errors, "coverage", "invalid_counts", "coverage numerator must not exceed denominator");
  if (coverage.numerator !== null && coverage.denominator > 0) {
    const expected = coverage.numerator / coverage.denominator;
    if (!Number.isFinite(coverage.ratio) || Math.abs(coverage.ratio - expected) > 1e-12) error(errors, "coverage.ratio", "inconsistent_ratio", "coverage ratio must match counts");
  } else if (coverage.ratio !== null) {
    error(errors, "coverage.ratio", "ratio_requires_counts", "coverage ratio requires counts and a positive denominator");
  }
}

function validateCollectionSnapshot(input = {}) {
  const errors = [];
  if (!plainObject(input)) return { valid: false, errors: [{ path: "snapshot", code: "invalid_type", message: "Snapshot must be a plain object" }], normalized: null };
  for (const key of Object.keys(input)) if (!SNAPSHOT_FIELDS.has(key)) error(errors, `snapshot.${key}`, "unknown_field", "Unknown snapshot fields are not persisted");
  const forbiddenPath = forbiddenStoragePath(input);
  if (forbiddenPath) error(errors, forbiddenPath, "sensitive_transport_metadata_forbidden", "Collection snapshots must not persist credentials or request query/header material");
  let value;
  try {
    value = normalizeCollectionSnapshot(input);
  } catch (caught) {
    if (caught instanceof CollectionSnapshotContractError) errors.push(...caught.errors);
    else throw caught;
    return { valid: false, errors, normalized: null };
  }
  if (value.schemaVersion !== SNAPSHOT_SCHEMA_VERSION) error(errors, "schemaVersion", "invalid_version", "Snapshot schemaVersion is invalid");
  validateId(errors, "snapshotId", value.snapshotId);
  validateId(errors, "taskKey", value.taskKey);
  validateId(errors, "sourceId", value.sourceId);
  const hasRegion = Boolean(value.regionKey);
  const hasSharedScope = Boolean(value.sharedCollectionScope);
  if (hasRegion === hasSharedScope) error(errors, "scope", "exclusive_scope_required", "Exactly one of regionKey or sharedCollectionScope is required");
  if (hasRegion && !REGION_KEY_PATTERN.test(value.regionKey)) error(errors, "regionKey", "invalid_region_key", "regionKey must be canonical");
  if (hasSharedScope) validateId(errors, "sharedCollectionScope", value.sharedCollectionScope);
  validateId(errors, "operation", value.operation);
  validatePeriod(errors, "measurementPeriod", value.measurementPeriod);
  validatePeriod(errors, "overlapPeriod", value.overlapPeriod, { nullable: true });
  if (!validTemporal(value.collectedAt)) error(errors, "collectedAt", "invalid_time", "collectedAt is required");
  if (!validTemporal(value.asOf)) error(errors, "asOf", "invalid_time", "asOf is required");
  if (value.providerPublishedAt && !validTemporal(value.providerPublishedAt)) error(errors, "providerPublishedAt", "invalid_time", "providerPublishedAt must be an ISO timestamp");
  if (epoch(value.collectedAt) !== null && epoch(value.asOf) !== null && epoch(value.collectedAt) > epoch(value.asOf)) error(errors, "collectedAt", "after_as_of", "collectedAt must not be after asOf");
  if (epoch(value.providerPublishedAt) !== null && epoch(value.collectedAt) !== null && epoch(value.providerPublishedAt) > epoch(value.collectedAt)) error(errors, "providerPublishedAt", "after_collection", "providerPublishedAt must not be after collection");
  if (epoch(value.measurementPeriod.to) !== null && epoch(value.asOf) !== null && epoch(value.measurementPeriod.to) > epoch(value.asOf)) error(errors, "measurementPeriod.to", "after_as_of", "measurement period must not extend beyond asOf");
  for (const field of ["requestPlanVersion", "mappingVersion", "sourceSchemaVersion"]) if (!value[field]) error(errors, field, "required", `${field} is required`);
  if (!SNAPSHOT_STATUSES.includes(value.status)) error(errors, "status", "invalid_status", "Snapshot status is invalid");
  if (!CONFIDENCE_GRADES.includes(value.confidence.grade)) error(errors, "confidence.grade", "invalid_grade", "Confidence grade is invalid");
  if (["missing", "conflict"].includes(value.status)) {
    if (value.sampleCount !== null) error(errors, "sampleCount", "status_requires_null", "Missing or conflict snapshots cannot invent a sample count");
    if (value.confidence.grade !== "U" || value.confidence.score !== null) error(errors, "confidence", "unknown_quality_required", "Missing or conflict snapshots require U/null confidence");
    if (value.coverage.numerator !== null || value.coverage.denominator !== null || value.coverage.ratio !== null) error(errors, "coverage", "status_requires_null", "Missing or conflict snapshots cannot invent coverage");
  } else {
    if (value.sampleCount === null) error(errors, "sampleCount", "count_required", "Observed snapshots require a sample count");
    if (!Number.isFinite(value.confidence.score) || value.confidence.score < 0 || value.confidence.score > 100) error(errors, "confidence.score", "invalid_score", "Observed snapshots require a 0-100 confidence score");
    if (value.coverage.numerator === null || value.coverage.denominator === null) error(errors, "coverage", "counts_required", "Observed snapshots require explicit coverage counts");
  }
  if (value.status === "zero" && value.sampleCount !== 0) error(errors, "sampleCount", "zero_requires_zero", "A zero snapshot requires sampleCount 0");
  if (value.status === "ready" && (!Number.isInteger(value.sampleCount) || value.sampleCount <= 0)) error(errors, "sampleCount", "ready_requires_samples", "A ready snapshot requires at least one sample");
  if (["partial", "stale"].includes(value.status) && value.penalties.length === 0) error(errors, "penalties", "reason_required", "Partial or stale snapshots require an explicit reason penalty");
  validateCoverage(errors, value.coverage);
  if (value.status === "zero" && value.coverage.numerator !== null && value.coverage.numerator !== 0) error(errors, "coverage.numerator", "zero_requires_zero", "A zero snapshot cannot claim observed rows");
  const penaltyCodes = new Set();
  for (const [index, penalty] of value.penalties.entries()) {
    if (!penalty.code) error(errors, `penalties[${index}].code`, "required", "Penalty code is required");
    if (penaltyCodes.has(penalty.code)) error(errors, `penalties[${index}].code`, "duplicate", "Penalty codes must be unique");
    penaltyCodes.add(penalty.code);
    if (penalty.points !== null && (penalty.points < 0 || penalty.points > 100)) error(errors, `penalties[${index}].points`, "invalid_points", "Penalty points must be between 0 and 100");
  }
  if (!plainObject(value.provenance) || text(value.provenance.sourceId, 200) !== value.sourceId) error(errors, "provenance.sourceId", "source_mismatch", "Provenance sourceId must match the snapshot sourceId");
  if (value.supersedesSnapshotId && !SAFE_ID_PATTERN.test(value.supersedesSnapshotId)) error(errors, "supersedesSnapshotId", "invalid_id", "supersedesSnapshotId is invalid");
  if (!HASH_PATTERN.test(value.contentHash)) error(errors, "contentHash", "invalid_hash", "contentHash must be a SHA-256 hash");
  else {
    const expectedHash = hash(snapshotHashPayload(value));
    if (value.contentHash !== expectedHash) error(errors, "contentHash", "hash_mismatch", "contentHash does not match the immutable snapshot metadata");
  }
  return { valid: errors.length === 0, errors, normalized: value };
}

function assertValidCollectionSnapshot(input) {
  const result = validateCollectionSnapshot(input);
  if (!result.valid) throw new CollectionSnapshotContractError(result.errors);
  return result.normalized;
}

function buildCollectionSnapshot(input = {}) {
  const forbiddenPath = forbiddenStoragePath(input);
  if (forbiddenPath) {
    throw new CollectionSnapshotContractError([{
      path: forbiddenPath,
      code: "sensitive_transport_metadata_forbidden",
      message: "Collection snapshots must not persist credentials or request query/header material"
    }]);
  }
  const unknown = plainObject(input) ? Object.keys(input).filter((key) => !SNAPSHOT_FIELDS.has(key)) : [];
  if (unknown.length) throw new CollectionSnapshotContractError(unknown.map((key) => ({ path: `snapshot.${key}`, code: "unknown_field", message: "Unknown snapshot fields are not persisted" })));
  const normalized = normalizeCollectionSnapshot(input);
  normalized.contentHash = hash(snapshotHashPayload(normalized));
  return deepFreeze(assertValidCollectionSnapshot(normalized));
}

function normalizeCollectionSnapshotHistory(input = {}) {
  const source = plainObject(input) ? input : {};
  return {
    schemaVersion: text(source.schemaVersion || SNAPSHOT_HISTORY_SCHEMA_VERSION, 120),
    historyId: text(source.historyId, 300),
    sourceId: text(source.sourceId, 200),
    regionKey: text(source.regionKey, 160),
    sharedCollectionScope: text(source.sharedCollectionScope, 160),
    createdAt: timestamp(source.createdAt),
    updatedAt: timestamp(source.updatedAt),
    snapshots: Array.isArray(source.snapshots) ? source.snapshots.map((snapshot) => normalizeCollectionSnapshot(snapshot)) : []
  };
}

function scopeMatches(left, right) {
  return left.regionKey === right.regionKey && left.sharedCollectionScope === right.sharedCollectionScope;
}

function validateCollectionSnapshotHistory(input = {}, options = {}) {
  const errors = [];
  if (!plainObject(input)) return { valid: false, errors: [{ path: "history", code: "invalid_type", message: "History must be a plain object" }], normalized: null };
  for (const key of Object.keys(input)) if (!HISTORY_FIELDS.has(key)) error(errors, `history.${key}`, "unknown_field", "Unknown history fields are not persisted");
  const value = normalizeCollectionSnapshotHistory(input);
  if (value.schemaVersion !== SNAPSHOT_HISTORY_SCHEMA_VERSION) error(errors, "schemaVersion", "invalid_version", "History schemaVersion is invalid");
  validateId(errors, "historyId", value.historyId);
  validateId(errors, "sourceId", value.sourceId);
  const hasRegion = Boolean(value.regionKey);
  const hasSharedScope = Boolean(value.sharedCollectionScope);
  if (hasRegion === hasSharedScope) error(errors, "scope", "exclusive_scope_required", "Exactly one history scope is required");
  if (hasRegion && !REGION_KEY_PATTERN.test(value.regionKey)) error(errors, "regionKey", "invalid_region_key", "History regionKey must be canonical");
  if (hasSharedScope) validateId(errors, "sharedCollectionScope", value.sharedCollectionScope);
  if (!validTemporal(value.createdAt)) error(errors, "createdAt", "invalid_time", "History createdAt is required");
  if (!validTemporal(value.updatedAt)) error(errors, "updatedAt", "invalid_time", "History updatedAt is required");
  if (epoch(value.createdAt) !== null && epoch(value.updatedAt) !== null && epoch(value.createdAt) > epoch(value.updatedAt)) error(errors, "updatedAt", "invalid_range", "History updatedAt must not precede createdAt");
  if (!Array.isArray(input.snapshots)) error(errors, "snapshots", "invalid_type", "History snapshots must be an array");
  const expectedUpdatedAt = value.snapshots.at(-1)?.collectedAt || value.createdAt;
  if (validTemporal(expectedUpdatedAt) && value.updatedAt !== expectedUpdatedAt) error(errors, "updatedAt", "latest_snapshot_mismatch", "History updatedAt must equal the latest snapshot collectedAt");
  const snapshotIds = new Set();
  const successfulTaskKeys = new Set();
  let priorCollectedAt = null;
  for (const [index, original] of (Array.isArray(input.snapshots) ? input.snapshots : []).entries()) {
    const result = validateCollectionSnapshot(original);
    for (const entry of result.errors) error(errors, `snapshots[${index}].${entry.path}`, entry.code, entry.message);
    const snapshot = result.normalized;
    if (!snapshot) continue;
    if (snapshot.sourceId !== value.sourceId) error(errors, `snapshots[${index}].sourceId`, "source_mismatch", "Snapshot sourceId must match history");
    if (!scopeMatches(snapshot, value)) error(errors, `snapshots[${index}].scope`, "scope_mismatch", "Snapshot scope must match history");
    if (snapshotIds.has(snapshot.snapshotId)) error(errors, `snapshots[${index}].snapshotId`, "duplicate", "snapshotId must be unique");
    snapshotIds.add(snapshot.snapshotId);
    if (SUCCESSFUL_SNAPSHOT_STATUSES.has(snapshot.status)) {
      if (successfulTaskKeys.has(snapshot.taskKey)) {
        error(errors, `snapshots[${index}].taskKey`, "duplicate_success", "A taskKey may have only one ready or zero snapshot");
      }
      successfulTaskKeys.add(snapshot.taskKey);
    }
    const collectedAt = epoch(snapshot.collectedAt);
    if (priorCollectedAt !== null && collectedAt !== null && collectedAt < priorCollectedAt) error(errors, `snapshots[${index}].collectedAt`, "out_of_order", "Snapshot history must remain chronological");
    priorCollectedAt = collectedAt;
    if (snapshot.supersedesSnapshotId) {
      const supersededIndex = value.snapshots.findIndex((candidate) => candidate.snapshotId === snapshot.supersedesSnapshotId);
      if (supersededIndex < 0 || supersededIndex >= index) error(errors, `snapshots[${index}].supersedesSnapshotId`, "invalid_reference", "A superseded snapshot must exist earlier in this history");
    }
  }
  const previous = options.previousHistory;
  if (previous !== undefined) {
    const previousResult = validateCollectionSnapshotHistory(previous);
    if (!previousResult.valid) error(errors, "previousHistory", "invalid_previous_history", "Previous immutable history is invalid");
    else {
      const previousValue = previousResult.normalized;
      if (previousValue.historyId !== value.historyId || previousValue.sourceId !== value.sourceId || !scopeMatches(previousValue, value)) error(errors, "history", "identity_changed", "History identity and scope are immutable");
      if (value.snapshots.length < previousValue.snapshots.length) error(errors, "snapshots", "history_truncated", "Snapshot history must never be truncated");
      const prefixLength = Math.min(value.snapshots.length, previousValue.snapshots.length);
      for (let index = 0; index < prefixLength; index += 1) {
        if (stableJson(value.snapshots[index]) !== stableJson(previousValue.snapshots[index])) {
          error(errors, `snapshots[${index}]`, "immutable_entry_changed", "Persisted snapshot history entries are immutable");
        }
      }
      if (value.createdAt !== previousValue.createdAt) error(errors, "createdAt", "immutable_field_changed", "History createdAt is immutable");
    }
  }
  return { valid: errors.length === 0, errors, normalized: value };
}

function assertValidCollectionSnapshotHistory(input, options = {}) {
  const result = validateCollectionSnapshotHistory(input, options);
  if (!result.valid) throw new CollectionSnapshotContractError(result.errors);
  return result.normalized;
}

function createCollectionSnapshotHistory(input = {}) {
  const snapshotInputs = Array.isArray(input.snapshots) ? input.snapshots : [];
  const snapshots = snapshotInputs.map((snapshot) => (
    snapshot && HASH_PATTERN.test(snapshot.contentHash || "") ? assertValidCollectionSnapshot(snapshot) : buildCollectionSnapshot(snapshot)
  ));
  const firstTime = snapshots[0]?.collectedAt || timestamp(input.createdAt);
  const lastTime = snapshots[snapshots.length - 1]?.collectedAt || timestamp(input.updatedAt || input.createdAt);
  const candidate = {
    schemaVersion: SNAPSHOT_HISTORY_SCHEMA_VERSION,
    historyId: text(input.historyId, 300),
    sourceId: text(input.sourceId || snapshots[0]?.sourceId, 200),
    regionKey: text(input.regionKey || snapshots[0]?.regionKey, 160),
    sharedCollectionScope: text(input.sharedCollectionScope || snapshots[0]?.sharedCollectionScope, 160),
    createdAt: timestamp(input.createdAt || firstTime),
    updatedAt: timestamp(input.updatedAt || lastTime),
    snapshots
  };
  return deepFreeze(assertValidCollectionSnapshotHistory(candidate));
}

function appendCollectionSnapshot(history, snapshotInput) {
  const current = assertValidCollectionSnapshotHistory(history);
  const snapshot = snapshotInput && HASH_PATTERN.test(snapshotInput.contentHash || "")
    ? assertValidCollectionSnapshot(snapshotInput)
    : buildCollectionSnapshot(snapshotInput);
  const candidate = {
    ...current,
    updatedAt: snapshot.collectedAt,
    snapshots: [...current.snapshots, snapshot]
  };
  return deepFreeze(assertValidCollectionSnapshotHistory(candidate, { previousHistory: current }));
}

function parseDurationMs(value) {
  if (value === null || value === undefined || value === "") return null;
  if (plainObject(value)) {
    const namedUnits = [
      ["weeks", 604800000],
      ["days", 86400000],
      ["hours", 3600000],
      ["minutes", 60000],
      ["seconds", 1000],
      ["milliseconds", 1]
    ];
    const named = namedUnits.find(([field]) => Object.prototype.hasOwnProperty.call(value, field));
    if (named) {
      const amount = Number(value[named[0]]);
      return Number.isFinite(amount) && amount > 0 ? amount * named[1] : null;
    }
    const amount = Number(value.value ?? value.amount);
    const unit = text(value.unit, 24).toLowerCase();
    const factors = { millisecond: 1, milliseconds: 1, second: 1000, seconds: 1000, minute: 60000, minutes: 60000, hour: 3600000, hours: 3600000, day: 86400000, days: 86400000, week: 604800000, weeks: 604800000 };
    return Number.isFinite(amount) && amount > 0 && factors[unit] ? amount * factors[unit] : null;
  }
  const raw = text(value, 64).toUpperCase();
  const match = raw.match(/^P(?:(\d+(?:\.\d+)?)W|(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?)$/);
  if (!match || !match.slice(1).some((entry) => entry !== undefined)) return null;
  const [, weeks, days, hours, minutes, seconds] = match;
  const duration = (Number(weeks || 0) * 7 + Number(days || 0)) * 86400000
    + Number(hours || 0) * 3600000
    + Number(minutes || 0) * 60000
    + Number(seconds || 0) * 1000;
  return Number.isFinite(duration) && duration > 0 ? duration : null;
}

function classifySnapshotFreshness(snapshot, policy = {}, asOf = new Date()) {
  if (!snapshot) return deepFreeze({ status: "unknown", ageMs: null, staleAfterMs: null, referenceAt: "", asOf: timestamp(asOf), reason: "snapshot_missing" });
  const validation = validateCollectionSnapshot(snapshot);
  if (!validation.valid) return deepFreeze({ status: "unknown", ageMs: null, staleAfterMs: null, referenceAt: "", asOf: timestamp(asOf), reason: "snapshot_invalid" });
  const value = validation.normalized;
  const referenceField = text(policy?.freshnessPolicy?.referenceField || "collectedAt", 40);
  const allowedReference = new Set(["collectedAt", "asOf", "providerPublishedAt"]);
  const referenceAt = allowedReference.has(referenceField) && value[referenceField] ? value[referenceField] : value.collectedAt;
  const evaluatedAt = timestamp(asOf);
  const staleAfterMs = parseDurationMs(policy.staleAfter);
  if (!validTemporal(evaluatedAt)) return deepFreeze({ status: "unknown", ageMs: null, staleAfterMs, referenceAt, asOf: evaluatedAt, reason: "as_of_invalid" });
  if (!staleAfterMs) return deepFreeze({ status: "unknown", ageMs: null, staleAfterMs: null, referenceAt, asOf: evaluatedAt, reason: "stale_after_unverified" });
  const ageMs = epoch(evaluatedAt) - epoch(referenceAt);
  if (!Number.isFinite(ageMs) || ageMs < 0) return deepFreeze({ status: "unknown", ageMs, staleAfterMs, referenceAt, asOf: evaluatedAt, reason: "reference_after_as_of" });
  const freshForHours = Number(policy?.freshnessPolicy?.freshForHours);
  const configuredFreshForMs = Number.isFinite(freshForHours) && freshForHours > 0 ? freshForHours * 3600000 : null;
  const agingRatio = Number(policy?.freshnessPolicy?.agingRatio);
  const agingAt = configuredFreshForMs !== null && configuredFreshForMs < staleAfterMs
    ? configuredFreshForMs
    : staleAfterMs * (Number.isFinite(agingRatio) && agingRatio > 0 && agingRatio < 1 ? agingRatio : 0.75);
  const status = ageMs >= staleAfterMs ? "stale" : ageMs >= agingAt ? "aging" : "fresh";
  return deepFreeze({
    status,
    ageMs,
    staleAfterMs,
    referenceAt,
    asOf: evaluatedAt,
    reason: status === "stale" ? "stale_after_exceeded" : status === "aging" ? "stale_threshold_approaching" : "within_freshness_window"
  });
}

function projectLatestUsableSnapshot(history, policy = {}, asOf = new Date()) {
  const value = assertValidCollectionSnapshotHistory(history);
  const latestAttemptSnapshot = value.snapshots.at(-1) || null;
  const lastSuccessfulSnapshot = [...value.snapshots].reverse().find((snapshot) => SUCCESSFUL_SNAPSHOT_STATUSES.has(snapshot.status)) || null;
  const freshness = classifySnapshotFreshness(lastSuccessfulSnapshot, policy, asOf);
  const latestAttemptStatus = latestAttemptSnapshot?.status || "missing";
  const servingStatus = !lastSuccessfulSnapshot
    ? latestAttemptStatus
    : freshness.status === "stale"
      ? "stale"
      : latestAttemptStatus;
  const staleReason = freshness.status === "stale"
    ? freshness.reason
    : latestAttemptSnapshot && lastSuccessfulSnapshot && latestAttemptSnapshot.snapshotId !== lastSuccessfulSnapshot.snapshotId && !SUCCESSFUL_SNAPSHOT_STATUSES.has(latestAttemptStatus)
      ? `latest_attempt_${latestAttemptStatus}`
      : "";
  return deepFreeze({
    servingStatus,
    latestAttemptStatus,
    lastSuccessfulStatus: lastSuccessfulSnapshot?.status || "missing",
    freshnessStatus: freshness.status,
    staleReason,
    latestAttemptSnapshot,
    lastSuccessfulSnapshot,
    servedSnapshot: lastSuccessfulSnapshot,
    lastSuccessfulSnapshotPreserved: Boolean(lastSuccessfulSnapshot),
    freshness
  });
}

module.exports = {
  CONFIDENCE_GRADES,
  CollectionSnapshotContractError,
  FRESHNESS_STATUSES,
  SNAPSHOT_HISTORY_SCHEMA_VERSION,
  SNAPSHOT_SCHEMA_VERSION,
  SNAPSHOT_STATUSES,
  appendCollectionSnapshot,
  assertValidCollectionSnapshot,
  assertValidCollectionSnapshotHistory,
  buildCollectionSnapshot,
  classifySnapshotFreshness,
  computeCollectionContentHash,
  createCollectionSnapshotHistory,
  forbiddenStoragePath,
  normalizeCollectionSnapshot,
  parseDurationMs,
  projectLatestUsableSnapshot,
  validateCollectionSnapshot,
  validateCollectionSnapshotHistory
};
