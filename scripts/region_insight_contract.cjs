"use strict";

const crypto = require("node:crypto");

const CONTRACT_VERSION = "region-insight.state.v1";
const REVIEW_STATUSES = Object.freeze([
  "draft",
  "review_required",
  "reviewed",
  "changes_requested"
]);
const PUBLICATION_STATUSES = Object.freeze([
  "unpublished",
  "published",
  "superseded",
  "stale"
]);
const DATA_QUALITY_STATUSES = Object.freeze([
  "ready",
  "zero",
  "missing",
  "partial",
  "stale",
  "conflict"
]);
const DATA_QUALITY_GRADES = Object.freeze(["A", "B", "C", "D", "U"]);
const FRESHNESS_STATUSES = Object.freeze(["fresh", "aging", "stale", "unknown"]);
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const PUBLICATION_ACTOR_ID_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N}._:@+-]{0,119}$/u;

class RegionInsightContractError extends Error {
  constructor(errors) {
    super("Region insight state contract validation failed");
    this.name = "RegionInsightContractError";
    this.errors = errors;
  }
}

function deepFreeze(value, seen = new WeakSet()) {
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function text(value, max = 240) {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function nullableFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function nullableInteger(value) {
  return Number.isInteger(value) && value >= 0 ? value : null;
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalize(value[key])])
  );
}

function hashDraftPayload(value) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(canonicalize(value ?? null)), "utf8")
    .digest("hex");
}

function normalizeComponent(component = {}, index = 0) {
  return {
    key: text(component.key || component.id || `component_${index + 1}`, 80),
    value: nullableFiniteNumber(component.value),
    weight: nullableFiniteNumber(component.weight),
    evidenceIds: Array.isArray(component.evidenceIds)
      ? component.evidenceIds.map((entry) => text(entry, 120)).filter(Boolean)
      : []
  };
}

function normalizeLocationAttractiveness(value = {}) {
  const components = Array.isArray(value.components) ? value.components : [];
  return {
    value: nullableFiniteNumber(value.value),
    components: components.map(normalizeComponent),
    modelVersion: text(value.modelVersion, 120)
  };
}

function normalizePenalty(value = {}, index = 0) {
  return {
    code: text(value.code || `penalty_${index + 1}`, 80),
    message: text(value.message, 320),
    points: nullableFiniteNumber(value.points)
  };
}

function normalizeCoverage(value = {}) {
  const numerator = nullableInteger(value.numerator);
  const denominator = nullableInteger(value.denominator);
  const computedRatio = numerator !== null && denominator !== null && denominator > 0
    ? numerator / denominator
    : null;
  return {
    numerator,
    denominator,
    ratio: computedRatio,
    note: text(value.note, 320)
  };
}

function normalizeFreshness(value = {}) {
  const requestedStatus = text(value.status, 32).toLowerCase();
  return {
    status: requestedStatus || "unknown",
    asOf: text(value.asOf, 40),
    updatedAt: text(value.updatedAt, 40),
    ageDays: nullableFiniteNumber(value.ageDays)
  };
}

function normalizeDataQuality(value = {}) {
  const status = text(value.status, 32).toLowerCase() || "missing";
  const requestedScore = nullableFiniteNumber(value.score);
  const requestedGrade = text(value.grade, 8).toUpperCase();
  return {
    status,
    score: status === "missing" ? null : requestedScore,
    grade: status === "missing" ? "U" : requestedGrade,
    penalties: Array.isArray(value.penalties) ? value.penalties.map(normalizePenalty) : [],
    coverage: normalizeCoverage(value.coverage),
    freshness: normalizeFreshness(value.freshness)
  };
}

function computeRegionDraftHash(regionKey, locationAttractiveness = {}, dataQuality = {}) {
  return hashDraftPayload({
    regionKey: text(regionKey, 160),
    locationAttractiveness: normalizeLocationAttractiveness(locationAttractiveness),
    dataQuality: normalizeDataQuality(dataQuality)
  });
}

function normalizeReviewer(value = {}, review = {}) {
  const reviewer = value && typeof value === "object" ? value : {};
  return {
    id: text(reviewer.id || review.reviewerId, 120),
    displayName: text(reviewer.displayName || reviewer.name || review.reviewerName, 120)
  };
}

function normalizeReview(value = {}, draftHash = "") {
  const requestedStatus = text(value.status, 32).toLowerCase() || "draft";
  const reviewedDraftHash = text(value.reviewedDraftHash, 64).toLowerCase();
  const hashMismatch = requestedStatus === "reviewed" && reviewedDraftHash !== draftHash;
  return {
    status: hashMismatch ? "review_required" : requestedStatus,
    reviewedDraftHash,
    reviewedAt: text(value.reviewedAt, 40),
    requestedAt: text(value.requestedAt, 40),
    reviewer: normalizeReviewer(value.reviewer, value),
    adminMemo: text(value.adminMemo, 2000)
  };
}

function normalizePublicationRegionIdentity(value = {}, fallbackRegionKey = "") {
  const identity = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    regionKey: text(identity.regionKey || fallbackRegionKey, 160),
    sido: text(identity.sido, 40),
    sigungu: text(identity.sigungu, 80),
    displayLabel: text(identity.displayLabel, 120)
  };
}

function normalizePublicationSnapshot(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const regionKey = text(value.regionKey, 160);
  const legacyIdentity = normalizePublicationRegionIdentity(value.regionIdentity, regionKey);
  return {
    registryVersion: text(value.registryVersion, 120),
    regionKey,
    sido: text(value.sido || legacyIdentity.sido, 40),
    sigungu: text(value.sigungu || legacyIdentity.sigungu, 80),
    displayLabel: text(value.displayLabel || legacyIdentity.displayLabel, 120),
    reviewedDraftHash: text(value.reviewedDraftHash || value.draftHash, 64).toLowerCase(),
    locationAttractiveness: normalizeLocationAttractiveness(value.locationAttractiveness),
    dataQuality: normalizeDataQuality(value.dataQuality),
    snapshotHash: text(value.snapshotHash, 64).toLowerCase()
  };
}

function computePublicationSnapshotHash(publication = {}) {
  const snapshot = publication.snapshot || {};
  const basePayload = {
    publicationId: text(publication.publicationId, 120),
    version: text(publication.version, 80),
    publishedAt: text(publication.publishedAt, 40),
    regionKey: text(snapshot.regionKey, 160),
    reviewedDraftHash: text(snapshot.reviewedDraftHash || snapshot.draftHash, 64).toLowerCase(),
    locationAttractiveness: normalizeLocationAttractiveness(snapshot.locationAttractiveness),
    dataQuality: normalizeDataQuality(snapshot.dataQuality)
  };
  const registryVersion = text(snapshot.registryVersion, 120);
  const regionIdentity = normalizePublicationRegionIdentity({
    regionKey: snapshot.regionKey,
    sido: snapshot.sido,
    sigungu: snapshot.sigungu,
    displayLabel: snapshot.displayLabel
  });
  const hasDurableRegionIdentity = Boolean(
    registryVersion
    || regionIdentity.sido
    || regionIdentity.sigungu
    || regionIdentity.displayLabel
  );
  if (!hasDurableRegionIdentity) return hashDraftPayload(basePayload);
  return hashDraftPayload({
    ...basePayload,
    publishedBy: text(publication.publishedBy, 120),
    registryVersion,
    regionIdentity
  });
}

function normalizePublication(value = {}, review = {}) {
  const requestedStatus = text(value.status, 32).toLowerCase() || "unpublished";
  const staleBecauseDraftChanged = requestedStatus === "published"
    && review.status === "review_required"
    && Boolean(review.reviewedDraftHash);
  return {
    status: staleBecauseDraftChanged ? "stale" : requestedStatus,
    publicationId: text(value.publicationId, 120),
    version: text(value.version, 80),
    publishedAt: text(value.publishedAt, 40),
    publishedBy: text(value.publishedBy, 120),
    supersededAt: text(value.supersededAt, 40),
    staleAt: text(value.staleAt, 40),
    adminMemo: text(value.adminMemo, 2000),
    snapshot: normalizePublicationSnapshot(value.snapshot)
  };
}

function normalizeRegionInsightState(input = {}) {
  const regionKey = text(input.regionKey, 160);
  const locationAttractiveness = normalizeLocationAttractiveness(input.locationAttractiveness);
  const dataQuality = normalizeDataQuality(input.dataQuality);
  const draftHash = text(
    input.draftHash || computeRegionDraftHash(regionKey, locationAttractiveness, dataQuality),
    64
  ).toLowerCase();
  const review = normalizeReview(input.review, draftHash);
  const publication = normalizePublication(input.publication, review);
  return deepFreeze({
    contractVersion: CONTRACT_VERSION,
    regionKey,
    draftHash,
    locationAttractiveness,
    dataQuality,
    review,
    publication
  });
}

function addError(errors, path, code, message) {
  errors.push({ path, code, message });
}

function validTimestamp(value) {
  return Boolean(value) && Number.isFinite(Date.parse(value));
}

function validPublicationActorId(value) {
  return PUBLICATION_ACTOR_ID_PATTERN.test(String(value || ""));
}

function validateRange(errors, path, value, min, max, options = {}) {
  if (value === null && options.nullable) return;
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    addError(errors, path, "out_of_range", `${path} must be${options.nullable ? " null or" : ""} between ${min} and ${max}`);
  }
}

function validateLocationAttractiveness(errors, value = {}) {
  validateRange(errors, "locationAttractiveness.value", value.value, 0, 100, { nullable: true });
  if (!text(value.modelVersion, 120)) {
    addError(errors, "locationAttractiveness.modelVersion", "required", "modelVersion is required");
  }
  if (!Array.isArray(value.components)) {
    addError(errors, "locationAttractiveness.components", "invalid_type", "components must be an array");
    return;
  }
  const keys = new Set();
  value.components.forEach((component, index) => {
    const prefix = `locationAttractiveness.components[${index}]`;
    if (!text(component.key, 80)) addError(errors, `${prefix}.key`, "required", "component key is required");
    if (keys.has(component.key)) addError(errors, `${prefix}.key`, "duplicate", "component keys must be unique");
    keys.add(component.key);
    validateRange(errors, `${prefix}.value`, component.value, 0, 100, { nullable: true });
    validateRange(errors, `${prefix}.weight`, component.weight, 0, 1, { nullable: true });
  });
}

function validateCoverage(errors, coverage = {}) {
  const { numerator, denominator, ratio } = coverage;
  if (numerator !== null && (!Number.isInteger(numerator) || numerator < 0)) {
    addError(errors, "dataQuality.coverage.numerator", "invalid_count", "coverage numerator must be null or a non-negative integer");
  }
  if (denominator !== null && (!Number.isInteger(denominator) || denominator < 0)) {
    addError(errors, "dataQuality.coverage.denominator", "invalid_count", "coverage denominator must be null or a non-negative integer");
  }
  if (numerator !== null && denominator !== null && numerator > denominator) {
    addError(errors, "dataQuality.coverage", "numerator_exceeds_denominator", "coverage numerator must not exceed denominator");
  }
  if (denominator !== null && denominator > 0 && numerator !== null) {
    const expected = numerator / denominator;
    if (typeof ratio !== "number" || Math.abs(ratio - expected) > 1e-12) {
      addError(errors, "dataQuality.coverage.ratio", "inconsistent_ratio", "coverage ratio must equal numerator / denominator");
    }
  } else if (ratio !== null) {
    addError(errors, "dataQuality.coverage.ratio", "ratio_requires_denominator", "coverage ratio must be null without a positive denominator");
  }
}

function validateFreshness(errors, freshness = {}) {
  if (!FRESHNESS_STATUSES.includes(freshness.status)) {
    addError(errors, "dataQuality.freshness.status", "invalid_status", "freshness status is invalid");
  }
  if (freshness.asOf && !validTimestamp(freshness.asOf)) {
    addError(errors, "dataQuality.freshness.asOf", "invalid_time", "freshness asOf must be an ISO date or timestamp");
  }
  if (freshness.updatedAt && !validTimestamp(freshness.updatedAt)) {
    addError(errors, "dataQuality.freshness.updatedAt", "invalid_time", "freshness updatedAt must be an ISO date or timestamp");
  }
  if (freshness.ageDays !== null && (freshness.ageDays < 0 || !Number.isFinite(freshness.ageDays))) {
    addError(errors, "dataQuality.freshness.ageDays", "invalid_age", "freshness ageDays must be null or non-negative");
  }
}

function validateDataQuality(errors, value = {}) {
  if (!DATA_QUALITY_STATUSES.includes(value.status)) {
    addError(errors, "dataQuality.status", "invalid_status", "data quality status is invalid");
  }
  if (value.status === "missing") {
    if (value.score !== null) addError(errors, "dataQuality.score", "missing_score_must_be_null", "missing data quality must have a null score");
    if (value.grade !== "U") addError(errors, "dataQuality.grade", "missing_grade_must_be_unknown", "missing data quality must use grade U");
  } else {
    validateRange(errors, "dataQuality.score", value.score, 0, 100);
    if (!DATA_QUALITY_GRADES.includes(value.grade) || value.grade === "U") {
      addError(errors, "dataQuality.grade", "invalid_grade", "non-missing data quality must use grade A, B, C, or D");
    }
  }
  if (!Array.isArray(value.penalties)) {
    addError(errors, "dataQuality.penalties", "invalid_type", "penalties must be an array");
  } else {
    value.penalties.forEach((penalty, index) => {
      if (!text(penalty.code, 80)) addError(errors, `dataQuality.penalties[${index}].code`, "required", "penalty code is required");
      validateRange(errors, `dataQuality.penalties[${index}].points`, penalty.points, 0, 100, { nullable: true });
    });
  }
  validateCoverage(errors, value.coverage);
  validateFreshness(errors, value.freshness);
}

function validateReview(errors, value = {}, draftHash = "") {
  if (!REVIEW_STATUSES.includes(value.status)) {
    addError(errors, "review.status", "invalid_status", "review status is invalid");
    return;
  }
  if (value.reviewedDraftHash && !HASH_PATTERN.test(value.reviewedDraftHash)) {
    addError(errors, "review.reviewedDraftHash", "invalid_hash", "reviewedDraftHash must be a SHA-256 hex digest");
  }
  if (value.status === "reviewed") {
    if (value.reviewedDraftHash !== draftHash) {
      addError(errors, "review.reviewedDraftHash", "reviewed_draft_mismatch", "reviewedDraftHash must equal draftHash");
    }
    if (!validTimestamp(value.reviewedAt)) {
      addError(errors, "review.reviewedAt", "required", "reviewed state requires reviewedAt");
    }
    if (!text(value.reviewer?.id, 120)) {
      addError(errors, "review.reviewer.id", "required", "reviewed state requires a reviewer id");
    }
  }
}

function validatePublicationSnapshot(errors, publication = {}, regionKey = "") {
  const snapshot = publication.snapshot;
  if (!snapshot || typeof snapshot !== "object") {
    addError(errors, "publication.snapshot", "publication_snapshot_required", "published, superseded, and stale states require an immutable snapshot");
    return;
  }
  if (snapshot.regionKey !== regionKey) {
    addError(errors, "publication.snapshot.regionKey", "snapshot_region_mismatch", "publication snapshot regionKey must equal the state regionKey");
  }
  const registryVersion = text(snapshot.registryVersion, 120);
  const regionIdentity = normalizePublicationRegionIdentity({
    regionKey: snapshot.regionKey,
    sido: snapshot.sido,
    sigungu: snapshot.sigungu,
    displayLabel: snapshot.displayLabel
  });
  const hasDurableRegionIdentity = Boolean(
    registryVersion
    || regionIdentity.sido
    || regionIdentity.sigungu
    || regionIdentity.displayLabel
  );
  if (hasDurableRegionIdentity) {
    if (!registryVersion) {
      addError(errors, "publication.snapshot.registryVersion", "required", "durable publication snapshots require registryVersion");
    }
    for (const field of ["regionKey", "sido", "sigungu", "displayLabel"]) {
      if (!regionIdentity[field]) {
        addError(errors, `publication.snapshot.${field}`, "required", `durable publication snapshots require ${field}`);
      }
    }
  }
  if (!HASH_PATTERN.test(snapshot.reviewedDraftHash)) {
    addError(errors, "publication.snapshot.reviewedDraftHash", "invalid_hash", "snapshot reviewedDraftHash must be a SHA-256 hex digest");
  }
  const nestedErrors = [];
  validateLocationAttractiveness(nestedErrors, snapshot.locationAttractiveness);
  validateDataQuality(nestedErrors, snapshot.dataQuality);
  for (const error of nestedErrors) {
    addError(errors, `publication.snapshot.${error.path}`, error.code, error.message);
  }
  if (!HASH_PATTERN.test(snapshot.snapshotHash)) {
    addError(errors, "publication.snapshot.snapshotHash", "invalid_hash", "snapshotHash must be a SHA-256 hex digest");
  } else if (snapshot.snapshotHash !== computePublicationSnapshotHash(publication)) {
    addError(errors, "publication.snapshot.snapshotHash", "snapshot_hash_mismatch", "snapshotHash must match the immutable publication snapshot payload");
  }
}

function sameContractValue(left, right) {
  return JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right));
}

function validatePublication(
  errors,
  value = {},
  review = {},
  draftHash = "",
  regionKey = "",
  currentAttractiveness = {},
  currentDataQuality = {}
) {
  if (!PUBLICATION_STATUSES.includes(value.status)) {
    addError(errors, "publication.status", "invalid_status", "publication status is invalid");
    return;
  }
  const hasPublicationIdentity = Boolean(value.publicationId && value.version && validTimestamp(value.publishedAt));
  if (value.status === "unpublished") {
    if (
      value.publicationId
      || value.version
      || value.publishedAt
      || value.publishedBy
      || value.supersededAt
      || value.staleAt
      || value.snapshot
    ) {
      addError(errors, "publication", "unpublished_has_snapshot", "unpublished state cannot carry published snapshot identity");
    }
    return;
  }
  if (!hasPublicationIdentity) {
    addError(errors, "publication", "published_snapshot_required", "published, superseded, and stale states require publicationId, version, and publishedAt");
  }
  const durableSnapshot = Boolean(text(value.snapshot?.registryVersion, 120));
  if ((durableSnapshot || value.publishedBy) && !validPublicationActorId(value.publishedBy)) {
    addError(errors, "publication.publishedBy", "invalid_actor_id", "publishedBy must be a stable actor identifier");
  }
  validatePublicationSnapshot(errors, value, regionKey);
  if (value.status === "published") {
    if (review.status !== "reviewed") {
      addError(errors, "publication.status", "publication_requires_review", "published state requires reviewed state");
    }
    if (review.reviewedDraftHash !== draftHash) {
      addError(errors, "publication.status", "publication_draft_mismatch", "published state requires the current reviewed draft hash");
    }
    if (value.snapshot?.reviewedDraftHash !== draftHash) {
      addError(errors, "publication.snapshot.reviewedDraftHash", "publication_draft_mismatch", "published snapshot must reference the current reviewed draft hash");
    }
    if (!sameContractValue(value.snapshot?.locationAttractiveness, currentAttractiveness)) {
      addError(errors, "publication.snapshot.locationAttractiveness", "published_snapshot_not_current", "published snapshot attractiveness must equal the reviewed current draft");
    }
    if (!sameContractValue(value.snapshot?.dataQuality, currentDataQuality)) {
      addError(errors, "publication.snapshot.dataQuality", "published_snapshot_not_current", "published snapshot data quality must equal the reviewed current draft");
    }
  }
  if (value.status === "superseded" && !validTimestamp(value.supersededAt)) {
    addError(errors, "publication.supersededAt", "required", "superseded state requires supersededAt");
  }
  if (value.status === "stale" && value.staleAt && !validTimestamp(value.staleAt)) {
    addError(errors, "publication.staleAt", "invalid_time", "staleAt must be an ISO date or timestamp");
  }
}

function validateRegionInsightState(value = {}) {
  const errors = [];
  if (value.contractVersion !== CONTRACT_VERSION) {
    addError(errors, "contractVersion", "invalid_version", `contractVersion must be ${CONTRACT_VERSION}`);
  }
  if (!text(value.regionKey, 160)) addError(errors, "regionKey", "required", "regionKey is required");
  if (!HASH_PATTERN.test(String(value.draftHash || ""))) {
    addError(errors, "draftHash", "invalid_hash", "draftHash must be a SHA-256 hex digest");
  } else {
    const expectedDraftHash = computeRegionDraftHash(
      value.regionKey,
      value.locationAttractiveness,
      value.dataQuality
    );
    if (value.draftHash !== expectedDraftHash) {
      addError(errors, "draftHash", "draft_hash_mismatch", "draftHash must match the normalized region, attractiveness, and data quality payload");
    }
  }
  validateLocationAttractiveness(errors, value.locationAttractiveness);
  validateDataQuality(errors, value.dataQuality);
  validateReview(errors, value.review, value.draftHash);
  validatePublication(
    errors,
    value.publication,
    value.review,
    value.draftHash,
    value.regionKey,
    value.locationAttractiveness,
    value.dataQuality
  );
  return { valid: errors.length === 0, errors };
}

function buildRegionInsightState(input = {}) {
  const normalized = normalizeRegionInsightState(input);
  const result = validateRegionInsightState(normalized);
  if (!result.valid) throw new RegionInsightContractError(result.errors);
  return normalized;
}

function createPublicationSnapshot(input = {}, metadata = {}) {
  const state = buildRegionInsightState(input);
  const publicationId = text(metadata.publicationId, 120);
  const version = text(metadata.version, 80);
  const publishedAt = text(metadata.publishedAt, 40);
  const publishedBy = text(metadata.publishedBy, 120);
  const registryVersion = text(metadata.registryVersion, 120);
  const regionIdentity = normalizePublicationRegionIdentity(
    metadata.regionIdentity || metadata.region,
    state.regionKey
  );
  const errors = [];
  if (state.review.status !== "reviewed") {
    addError(errors, "review.status", "publication_requires_review", "only a reviewed draft can be published");
  }
  if (state.review.reviewedDraftHash !== state.draftHash) {
    addError(errors, "review.reviewedDraftHash", "publication_draft_mismatch", "the reviewed draft hash must equal the current draft hash");
  }
  if (!publicationId) addError(errors, "publication.publicationId", "required", "publicationId is required");
  if (!version) addError(errors, "publication.version", "required", "publication version is required");
  if (!validTimestamp(publishedAt)) addError(errors, "publication.publishedAt", "required", "publishedAt must be an ISO date or timestamp");
  if (registryVersion) {
    if (!validPublicationActorId(publishedBy)) {
      addError(errors, "publication.publishedBy", "invalid_actor_id", "durable publication snapshots require a stable publishedBy actor identifier");
    }
    for (const field of ["regionKey", "sido", "sigungu", "displayLabel"]) {
      if (!regionIdentity[field]) {
        addError(errors, `publication.snapshot.${field}`, "required", `durable publication snapshots require ${field}`);
      }
    }
    if (regionIdentity.regionKey !== state.regionKey) {
      addError(errors, "publication.snapshot.regionKey", "snapshot_region_mismatch", "snapshot regionKey must equal the state regionKey");
    }
  } else if (metadata.regionIdentity || metadata.region) {
    addError(errors, "publication.snapshot.registryVersion", "required", "region identity metadata requires registryVersion");
  }
  if (errors.length) throw new RegionInsightContractError(errors);

  const snapshot = {
    registryVersion,
    regionKey: state.regionKey,
    sido: registryVersion ? regionIdentity.sido : "",
    sigungu: registryVersion ? regionIdentity.sigungu : "",
    displayLabel: registryVersion ? regionIdentity.displayLabel : "",
    reviewedDraftHash: state.review.reviewedDraftHash,
    locationAttractiveness: state.locationAttractiveness,
    dataQuality: state.dataQuality,
    snapshotHash: ""
  };
  snapshot.snapshotHash = computePublicationSnapshotHash({
    publicationId,
    version,
    publishedAt,
    publishedBy,
    snapshot
  });
  return deepFreeze(snapshot);
}

function publishRegionInsightState(input = {}, metadata = {}) {
  const state = buildRegionInsightState(input);
  const publicationId = text(metadata.publicationId, 120);
  const version = text(metadata.version, 80);
  const publishedAt = text(metadata.publishedAt, 40);
  const publishedBy = text(metadata.publishedBy, 120);
  const registryVersion = text(metadata.registryVersion, 120);
  const regionIdentity = metadata.regionIdentity || metadata.region;
  const snapshot = createPublicationSnapshot(state, {
    publicationId,
    version,
    publishedAt,
    publishedBy,
    registryVersion,
    regionIdentity
  });
  return buildRegionInsightState({
    ...state,
    publication: {
      status: "published",
      publicationId,
      version,
      publishedAt,
      publishedBy,
      supersededAt: "",
      staleAt: "",
      adminMemo: metadata.adminMemo,
      snapshot
    }
  });
}

function toPublicRegionInsight(input = {}) {
  const state = buildRegionInsightState(input);
  if (state.publication.status === "unpublished") return null;
  const snapshot = state.publication.snapshot;
  return deepFreeze({
    contractVersion: state.contractVersion,
    regionKey: snapshot.regionKey,
    locationAttractiveness: snapshot.locationAttractiveness,
    dataQuality: snapshot.dataQuality,
    publication: {
      status: state.publication.status,
      publicationId: state.publication.publicationId,
      version: state.publication.version,
      publishedAt: state.publication.publishedAt,
      supersededAt: state.publication.supersededAt,
      staleAt: state.publication.staleAt
    }
  });
}

module.exports = {
  CONTRACT_VERSION,
  DATA_QUALITY_GRADES,
  DATA_QUALITY_STATUSES,
  FRESHNESS_STATUSES,
  PUBLICATION_STATUSES,
  REVIEW_STATUSES,
  RegionInsightContractError,
  buildRegionInsightState,
  computePublicationSnapshotHash,
  computeRegionDraftHash,
  createPublicationSnapshot,
  deepFreeze,
  hashDraftPayload,
  normalizeDataQuality,
  normalizeLocationAttractiveness,
  normalizePublicationRegionIdentity,
  normalizeRegionInsightState,
  publishRegionInsightState,
  toPublicRegionInsight,
  validPublicationActorId,
  validateRegionInsightState
};
