"use strict";

const crypto = require("node:crypto");

const NAVER_FALLBACK_SCHEMA_VERSION = "naver-collection-fallback.v1";
const NAVER_SEARCH_SIGNATURE_VERSION = "naver-search-contract.v1";
const NAVER_PROVIDER_ID = "naver_place_search";
const REGION_KEY_PATTERN = /^kr_[a-z0-9_]+$/;
const SUCCESSFUL_SNAPSHOT_STATUSES = new Set(["ready", "zero", "success", "completed"]);
const BLOCKED_FAILURE_CODES = new Set(["NAVER_ACCESS_BLOCKED", "NAVER_PROVIDER_COOLDOWN_ACTIVE"]);
const FAILURE_SUBTYPES = new Set(["http_403", "http_429", "challenge_html", "unknown_access_block"]);
const PUBLIC_FALLBACK_STATUSES = new Set(["ready", "zero", "stale"]);

class NaverCollectionFallbackContractError extends Error {
  constructor(message, details = []) {
    super(message);
    this.name = "NaverCollectionFallbackContractError";
    this.code = "INVALID_NAVER_COLLECTION_FALLBACK_CONTRACT";
    this.details = details;
  }
}

function normalizedText(value, maxLength = 240) {
  return String(value ?? "")
    .normalize("NFKC")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, maxLength);
}

function strictNormalizedText(value, maxLength) {
  const text = String(value ?? "")
    .normalize("NFKC")
    .trim()
    .replace(/\s+/g, " ");
  return text && text.length <= maxLength ? text : "";
}

function normalizedQuery(value) {
  return strictNormalizedText(value, 300).toLowerCase();
}

function normalizedRegionKey(value) {
  const regionKey = strictNormalizedText(value, 100);
  return REGION_KEY_PATTERN.test(regionKey) ? regionKey : "";
}

function normalizedOpaqueSignature(value) {
  const signature = strictNormalizedText(value, 160);
  return /^[A-Za-z0-9._:-]{8,160}$/.test(signature) ? signature : "";
}

function normalizedRunId(value) {
  const runId = strictNormalizedText(value, 160);
  return /^[A-Za-z0-9._:-]{1,160}$/.test(runId) ? runId : "";
}

function reconciledAliases(source, keys, normalizer) {
  const values = [];
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(source || {}, key)) continue;
    const raw = normalizedText(source[key], 500);
    if (!raw) continue;
    const normalized = normalizer(source[key]);
    if (!normalized) return Object.freeze({ valid: false, value: "" });
    values.push(normalized);
  }
  if (!values.length) return Object.freeze({ valid: true, value: "" });
  if (values.some((value) => value !== values[0])) return Object.freeze({ valid: false, value: "" });
  return Object.freeze({ valid: true, value: values[0] });
}

function normalizedIsoInstant(value) {
  const text = strictNormalizedText(value, 40);
  if (!text) return "";
  const milliseconds = Date.parse(text);
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : "";
}

function normalizedIsoDate(value) {
  const text = strictNormalizedText(value, 20);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return "";
  const milliseconds = Date.parse(`${text}T00:00:00.000Z`);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString().slice(0, 10) === text ? text : "";
}

function normalizedPositiveInteger(value) {
  if (value === "" || value === null || value === undefined) return null;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0 || number > 10000) return null;
  return number;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

function normalizedRankContract(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => {
      if (entry && typeof entry === "object") {
        return {
          from: normalizedPositiveInteger(entry.from),
          to: normalizedPositiveInteger(entry.to)
        };
      }
      return normalizedText(entry, 40).replace(/\s+/g, "");
    });
  }
  return normalizedText(value, 120).replace(/\s+/g, "");
}

function canonicalNaverSearchContract(input = {}) {
  const query = normalizedQuery(
    input.normalizedQuery
    || input.keyword
    || input.query
    || input.searchKeyword
    || input.companyName
  );
  const contract = {
    query,
    searchMode: normalizedText(input.resolvedSearchMode || input.searchMode, 40).toLowerCase(),
    collectionPurpose: normalizedText(input.collectionPurpose, 60).toLowerCase(),
    productMode: normalizedText(input.productMode, 40).toLowerCase(),
    collectionMode: normalizedText(input.collectionMode, 40).toLowerCase(),
    collectionProfile: normalizedText(input.collectionProfile, 80).toLowerCase(),
    detailRankRanges: normalizedRankContract(input.detailRankRanges ?? input.rankRanges),
    checkIn: normalizedIsoDate(input.checkIn),
    checkOut: normalizedIsoDate(input.checkOut),
    bookingRangeDays: normalizedPositiveInteger(input.bookingRangeDays),
    bookingRangePlaceLimit: normalizedPositiveInteger(input.bookingRangePlaceLimit)
  };
  const missing = [];
  for (const key of [
    "query",
    "searchMode",
    "collectionPurpose",
    "productMode",
    "collectionMode",
    "collectionProfile",
    "detailRankRanges",
    "checkIn",
    "checkOut",
    "bookingRangeDays",
    "bookingRangePlaceLimit"
  ]) {
    const value = contract[key];
    if (value === "" || value === null || (Array.isArray(value) && value.length === 0)) missing.push(key);
  }
  if (missing.length) {
    throw new NaverCollectionFallbackContractError("Exact NAVER search contract fields are required", missing);
  }
  return contract;
}

function createNaverSearchContractSignature(input = {}) {
  const contract = canonicalNaverSearchContract(input);
  return crypto
    .createHash("sha256")
    .update(`${NAVER_SEARCH_SIGNATURE_VERSION}:${stableJson(contract)}`)
    .digest("hex");
}

function fallbackMatchIdentity(input = {}) {
  const regionAliases = reconciledAliases(input, ["regionKey", "canonicalRegionKey"], normalizedRegionKey);
  const regionKey = regionAliases.value;
  if (!regionAliases.valid || !regionKey) {
    throw new NaverCollectionFallbackContractError("A valid canonical regionKey is required", ["regionKey"]);
  }
  const signatureAliases = reconciledAliases(input, ["searchSignature", "contractSignature"], normalizedOpaqueSignature);
  if (!signatureAliases.valid) {
    throw new NaverCollectionFallbackContractError("NAVER search signature aliases conflict", ["searchSignature", "contractSignature"]);
  }
  const providedSignature = signatureAliases.value;
  const embeddedContract = input.searchContract && typeof input.searchContract === "object"
    ? input.searchContract
    : ["query", "keyword", "searchMode", "collectionPurpose", "productMode", "collectionMode", "detailRankRanges", "checkIn", "checkOut"]
        .some((key) => Object.prototype.hasOwnProperty.call(input, key))
      ? input
      : null;
  const computedSignature = embeddedContract ? createNaverSearchContractSignature(embeddedContract) : "";
  if (providedSignature && computedSignature && providedSignature !== computedSignature) {
    throw new NaverCollectionFallbackContractError("NAVER search signature does not match its contract", ["searchSignature", "searchContract"]);
  }
  const searchSignature = providedSignature || computedSignature;
  if (!searchSignature) {
    throw new NaverCollectionFallbackContractError("A NAVER search signature or complete contract is required", ["searchSignature"]);
  }
  return Object.freeze({ regionKey, searchSignature });
}

function plainClone(value) {
  if (value === null || value === undefined) return value ?? null;
  try {
    return structuredClone(value);
  } catch {
    return JSON.parse(JSON.stringify(value));
  }
}

function candidateStatus(candidate = {}) {
  const outer = reconciledAliases(candidate, ["collectionStatus", "status"], (value) => normalizedText(value, 40).toLowerCase());
  const nested = reconciledAliases(candidate.snapshot, ["collectionStatus", "status"], (value) => normalizedText(value, 40).toLowerCase());
  if (!outer.valid || !nested.valid) return "";
  return outer.value || nested.value;
}

function candidateStatusesAgree(candidate = {}) {
  const outer = reconciledAliases(candidate, ["collectionStatus", "status"], (value) => normalizedText(value, 40).toLowerCase());
  const nested = reconciledAliases(candidate.snapshot, ["collectionStatus", "status"], (value) => normalizedText(value, 40).toLowerCase());
  return Boolean(
    outer.valid
    && nested.valid
    && outer.value
    && nested.value
    && outer.value === nested.value
  );
}

function candidateCompletedAt(candidate = {}) {
  const outer = reconciledAliases(candidate, ["completedAt", "collectedAt", "asOf"], normalizedIsoInstant);
  const nested = reconciledAliases(candidate.snapshot, ["completedAt", "collectedAt", "asOf"], normalizedIsoInstant);
  if (!outer.valid || !nested.valid || !outer.value || !nested.value || outer.value !== nested.value) return "";
  return outer.value;
}

function candidateRunId(candidate = {}) {
  const outer = normalizedRunId(candidate.runId);
  const nested = normalizedRunId(candidate.snapshot?.runId);
  return outer && nested && outer === nested ? outer : "";
}

function candidateIdentity(candidate = {}) {
  try {
    const outer = fallbackMatchIdentity({
      regionKey: candidate.regionKey,
      canonicalRegionKey: candidate.canonicalRegionKey,
      searchSignature: candidate.searchSignature,
      contractSignature: candidate.contractSignature,
      searchContract: candidate.searchContract
    });
    const nested = fallbackMatchIdentity({
      regionKey: candidate.snapshot?.regionKey,
      canonicalRegionKey: candidate.snapshot?.canonicalRegionKey,
      searchSignature: candidate.snapshot?.searchSignature,
      contractSignature: candidate.snapshot?.contractSignature,
      searchContract: candidate.snapshot?.searchContract
    });
    return outer.regionKey === nested.regionKey && outer.searchSignature === nested.searchSignature ? outer : null;
  } catch {
    return null;
  }
}

function isSuccessfulFallbackCandidate(candidate = {}) {
  return Boolean(
    candidate
    && typeof candidate === "object"
    && candidateRunId(candidate)
    && candidateCompletedAt(candidate)
    && candidateStatusesAgree(candidate)
    && SUCCESSFUL_SNAPSHOT_STATUSES.has(candidateStatus(candidate))
    && candidate.snapshot
    && typeof candidate.snapshot === "object"
  );
}

function matchesExactNaverFallback(request = {}, candidate = {}) {
  let requestedIdentity;
  try {
    requestedIdentity = fallbackMatchIdentity(request);
  } catch {
    return false;
  }
  const storedIdentity = candidateIdentity(candidate);
  return Boolean(
    storedIdentity
    && isSuccessfulFallbackCandidate(candidate)
    && storedIdentity.regionKey === requestedIdentity.regionKey
    && storedIdentity.searchSignature === requestedIdentity.searchSignature
  );
}

function candidatePublicProjection(candidate = {}) {
  const projection = candidate.publicProjection ?? candidate.snapshot?.publicProjection;
  return projection && typeof projection === "object" ? plainClone(projection) : null;
}

function selectLastKnownGoodNaverFallback(request = {}, candidates = [], options = {}) {
  const requestedIdentity = fallbackMatchIdentity(request);
  const referenceAt = normalizedIsoInstant(options.asOf);
  const eligible = (Array.isArray(candidates) ? candidates : [])
    .filter((candidate) => matchesExactNaverFallback(requestedIdentity, candidate))
    .map((candidate) => ({
      candidate,
      completedAt: candidateCompletedAt(candidate),
      runId: candidateRunId(candidate)
    }))
    .filter((entry) => !referenceAt || Date.parse(entry.completedAt) <= Date.parse(referenceAt))
    .sort((left, right) => (
      Date.parse(right.completedAt) - Date.parse(left.completedAt)
      || right.runId.localeCompare(left.runId)
    ));
  if (!eligible.length) return null;
  const selected = eligible[0];
  return {
    regionKey: requestedIdentity.regionKey,
    searchSignature: requestedIdentity.searchSignature,
    runId: selected.runId,
    asOf: selected.completedAt,
    status: candidateStatus(selected.candidate),
    snapshot: plainClone(selected.candidate.snapshot),
    publicProjection: candidatePublicProjection(selected.candidate)
  };
}

function safeDiagnosticId(value) {
  const diagnosticId = strictNormalizedText(value, 120);
  return /^[A-Za-z0-9._:-]{1,120}$/.test(diagnosticId) ? diagnosticId : "";
}

function normalizeCurrentCollectionFailure(failure = {}, asOf = "") {
  const code = BLOCKED_FAILURE_CODES.has(failure.code) ? failure.code : "NAVER_ACCESS_BLOCKED";
  const subtype = FAILURE_SUBTYPES.has(failure.providerFailureSubtype || failure.failureSubtype)
    ? (failure.providerFailureSubtype || failure.failureSubtype)
    : "unknown_access_block";
  return {
    status: "blocked",
    code,
    providerId: NAVER_PROVIDER_ID,
    providerFailureSubtype: subtype,
    diagnosticId: safeDiagnosticId(failure.diagnosticId),
    occurredAt: normalizedIsoInstant(failure.occurredAt || failure.failedAt || asOf)
  };
}

function buildNaverCollectionFallbackState({ request = {}, currentFailure = {}, candidates = [], asOf = "" } = {}) {
  const identity = fallbackMatchIdentity(request);
  const referenceAt = normalizedIsoInstant(asOf);
  if (!referenceAt) {
    throw new NaverCollectionFallbackContractError("A fixed asOf instant is required", ["asOf"]);
  }
  const failure = normalizeCurrentCollectionFailure(currentFailure, referenceAt);
  const selected = selectLastKnownGoodNaverFallback(identity, candidates, { asOf: referenceAt });
  if (!selected) {
    return {
      schemaVersion: NAVER_FALLBACK_SCHEMA_VERSION,
      status: "blocked",
      regionKey: identity.regionKey,
      searchSignature: identity.searchSignature,
      currentCollectionFailure: failure,
      fallbackSnapshot: null,
      fallbackPublicProjection: null,
      fallbackRunId: null,
      fallbackAsOf: null,
      fallbackReason: "no_exact_last_known_good",
      fallbackFreshness: {
        status: "missing",
        reason: "no_exact_last_known_good",
        evaluatedAt: referenceAt,
        ageSeconds: null
      }
    };
  }
  const ageSeconds = Math.max(0, Math.floor((Date.parse(referenceAt) - Date.parse(selected.asOf)) / 1000));
  return {
    schemaVersion: NAVER_FALLBACK_SCHEMA_VERSION,
    status: "blocked",
    regionKey: identity.regionKey,
    searchSignature: identity.searchSignature,
    currentCollectionFailure: failure,
    fallbackSnapshot: selected.snapshot,
    fallbackPublicProjection: selected.publicProjection,
    fallbackRunId: selected.runId,
    fallbackAsOf: selected.asOf,
    fallbackReason: "last_known_good_exact_contract",
    fallbackFreshness: {
      status: "stale",
      reason: "current_collection_blocked",
      evaluatedAt: referenceAt,
      ageSeconds
    }
  };
}

function publicFallbackProjection(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const runId = normalizedRunId(value.runId);
  const regionKey = normalizedRegionKey(value.regionKey);
  const status = normalizedText(value.status, 40).toLowerCase();
  const asOf = normalizedIsoInstant(value.asOf);
  if (!runId || !regionKey || !PUBLIC_FALLBACK_STATUSES.has(status) || !asOf) return null;
  const output = { runId, regionKey, status, asOf };
  const label = normalizedText(value.label, 160);
  if (label) output.label = label;
  if (typeof value.resultCount === "number" && Number.isInteger(value.resultCount) && value.resultCount >= 0) {
    output.resultCount = value.resultCount;
  }
  return output;
}

function projectNaverCollectionFallbackForB2B(state = {}) {
  const failure = state.currentCollectionFailure && typeof state.currentCollectionFailure === "object"
    ? state.currentCollectionFailure
    : {};
  const candidatePublicSnapshot = state.fallbackPublicProjection && typeof state.fallbackPublicProjection === "object"
    ? publicFallbackProjection(state.fallbackPublicProjection)
    : null;
  const stateRunId = normalizedRunId(state.fallbackRunId);
  const stateRegionKey = normalizedRegionKey(state.regionKey);
  const stateAsOf = normalizedIsoInstant(state.fallbackAsOf);
  const publicSnapshot = candidatePublicSnapshot
    && candidatePublicSnapshot.runId === stateRunId
    && candidatePublicSnapshot.regionKey === stateRegionKey
    && candidatePublicSnapshot.asOf === stateAsOf
    ? candidatePublicSnapshot
    : null;
  const fallbackAvailable = Boolean(publicSnapshot);
  return {
    status: "blocked",
    fallbackAvailable,
    currentCollectionFailure: {
      status: "blocked",
      code: BLOCKED_FAILURE_CODES.has(failure.code) ? failure.code : "NAVER_ACCESS_BLOCKED",
      diagnosticId: safeDiagnosticId(failure.diagnosticId) || undefined,
      occurredAt: normalizedIsoInstant(failure.occurredAt) || undefined,
      message: "현재 네이버 수집이 중단되었습니다."
    },
    fallbackSnapshot: publicSnapshot,
    fallbackRunId: fallbackAvailable ? stateRunId : null,
    fallbackAsOf: fallbackAvailable ? stateAsOf : null,
    fallbackReason: fallbackAvailable ? "last_known_good_exact_contract" : "no_public_fallback",
    fallbackFreshness: fallbackAvailable
      ? {
          status: "stale",
          reason: "current_collection_blocked",
          evaluatedAt: normalizedIsoInstant(state.fallbackFreshness?.evaluatedAt) || null,
          ageSeconds: Number.isFinite(Number(state.fallbackFreshness?.ageSeconds))
            ? Math.max(0, Math.floor(Number(state.fallbackFreshness.ageSeconds)))
            : null
        }
      : {
          status: "missing",
          reason: "no_public_fallback",
          evaluatedAt: normalizedIsoInstant(state.fallbackFreshness?.evaluatedAt) || null,
          ageSeconds: null
        }
  };
}

function decideNaverQuotaConsumption({
  cooldownPrevented = false,
  reused = false,
  providerRequestAttempted = false,
  existingPolicyConsumesQuota = true
} = {}) {
  if (cooldownPrevented && providerRequestAttempted) {
    throw new NaverCollectionFallbackContractError(
      "A cooldown-prevented request cannot also be marked as attempted",
      ["cooldownPrevented", "providerRequestAttempted"]
    );
  }
  if (cooldownPrevented) {
    return { consumeQuota: false, reason: "provider_cooldown_prevented", existingPolicyApplied: false };
  }
  if (reused) {
    return { consumeQuota: false, reason: "existing_result_reused", existingPolicyApplied: false };
  }
  if (!providerRequestAttempted) {
    return { consumeQuota: false, reason: "provider_request_not_attempted", existingPolicyApplied: false };
  }
  return {
    consumeQuota: existingPolicyConsumesQuota !== false,
    reason: "existing_policy_after_provider_attempt",
    existingPolicyApplied: true
  };
}

module.exports = {
  NAVER_FALLBACK_SCHEMA_VERSION,
  NAVER_PROVIDER_ID,
  NAVER_SEARCH_SIGNATURE_VERSION,
  NaverCollectionFallbackContractError,
  buildNaverCollectionFallbackState,
  canonicalNaverSearchContract,
  createNaverSearchContractSignature,
  decideNaverQuotaConsumption,
  fallbackMatchIdentity,
  matchesExactNaverFallback,
  projectNaverCollectionFallbackForB2B,
  selectLastKnownGoodNaverFallback
};
