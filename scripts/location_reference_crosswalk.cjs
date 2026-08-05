"use strict";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const REGION_KEY_PATTERN = /^kr_[a-z0-9_]+$/;
const LEGAL_CODE_PATTERN = /^\d{10}$/;
const SIDO_CODE_PATTERN = /^\d{2}$/;
const SIGUNGU_CODE_PATTERN = /^\d{5}$/;
const REFERENCE_STATUSES = new Set(["verified", "unverified", "superseded"]);

class LocationReferenceCrosswalkError extends Error {
  constructor(message, details = []) {
    super(message);
    this.name = "LocationReferenceCrosswalkError";
    this.code = "INVALID_LOCATION_REFERENCE_CROSSWALK";
    this.details = details;
  }
}

function text(value = "") {
  return String(value ?? "").normalize("NFKC").trim();
}

function validDate(value) {
  const candidate = text(value);
  if (!DATE_PATTERN.test(candidate)) return false;
  const [year, month, day] = candidate.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year
    && parsed.getUTCMonth() === month - 1
    && parsed.getUTCDate() === day;
}

function hasSourceRef(value) {
  if (typeof value === "string") return Boolean(text(value));
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Boolean(text(value.datasetId || value.url || value.file))
    && Boolean(text(value.version || value.asOf));
}

function validateLocationReferenceCrosswalk(crosswalk, options = {}) {
  if (!crosswalk || typeof crosswalk !== "object" || Array.isArray(crosswalk)) {
    throw new LocationReferenceCrosswalkError("Location reference crosswalk must be an object", ["crosswalk"]);
  }

  const errors = [];
  if (crosswalk.schemaVersion !== "location-reference-crosswalk.v1") {
    errors.push("schemaVersion must be location-reference-crosswalk.v1");
  }
  if (!text(crosswalk.registryVersion)) errors.push("registryVersion is required");
  if (crosswalk.primaryRegionField !== "regionKey") errors.push("primaryRegionField must be regionKey");
  if (crosswalk.usageRole !== "canonical_crosswalk") errors.push("usageRole must be canonical_crosswalk");
  if (!Array.isArray(crosswalk.records)) errors.push("records must be an array");

  const allowedRegionKeys = options.allowedRegionKeys instanceof Set
    ? options.allowedRegionKeys
    : Array.isArray(options.allowedRegionKeys)
      ? new Set(options.allowedRegionKeys)
      : null;
  const seenRegionKeys = new Set();
  const legalCodeOwners = new Map();

  for (const [index, record] of (Array.isArray(crosswalk.records) ? crosswalk.records : []).entries()) {
    const prefix = `records[${index}]`;
    const regionKey = text(record?.regionKey);
    const status = text(record?.status);
    const legalDongCodes = Array.isArray(record?.legalDongCodes) ? record.legalDongCodes.map(text) : null;

    if (!REGION_KEY_PATTERN.test(regionKey)) errors.push(`${prefix}.regionKey is invalid`);
    if (seenRegionKeys.has(regionKey)) errors.push(`${prefix}.regionKey is duplicated`);
    seenRegionKeys.add(regionKey);
    if (allowedRegionKeys && !allowedRegionKeys.has(regionKey)) errors.push(`${prefix}.regionKey is not canonical`);
    if (!SIDO_CODE_PATTERN.test(text(record?.sidoCode))) errors.push(`${prefix}.sidoCode must contain 2 digits`);
    if (!SIGUNGU_CODE_PATTERN.test(text(record?.sigunguCode))) errors.push(`${prefix}.sigunguCode must contain 5 digits`);
    if (!legalDongCodes) errors.push(`${prefix}.legalDongCodes must be an array`);
    if (!REFERENCE_STATUSES.has(status)) errors.push(`${prefix}.status is invalid`);
    if (!validDate(record?.validFrom)) errors.push(`${prefix}.validFrom must be an ISO date`);
    if (record?.validTo !== null && record?.validTo !== undefined && !validDate(record.validTo)) {
      errors.push(`${prefix}.validTo must be null or an ISO date`);
    }
    if (validDate(record?.validFrom) && validDate(record?.validTo) && record.validTo < record.validFrom) {
      errors.push(`${prefix}.validTo must not precede validFrom`);
    }
    if (!hasSourceRef(record?.sourceRef)) errors.push(`${prefix}.sourceRef must identify a versioned source`);
    if (status === "verified" && (!legalDongCodes || legalDongCodes.length === 0)) {
      errors.push(`${prefix}.verified record requires at least one legalDongCode`);
    }

    const localCodes = new Set();
    for (const [codeIndex, legalDongCode] of (legalDongCodes || []).entries()) {
      if (!LEGAL_CODE_PATTERN.test(legalDongCode)) {
        errors.push(`${prefix}.legalDongCodes[${codeIndex}] must contain 10 digits`);
        continue;
      }
      if (localCodes.has(legalDongCode)) errors.push(`${prefix}.legalDongCodes contains a duplicate`);
      localCodes.add(legalDongCode);
      const owner = legalCodeOwners.get(legalDongCode);
      if (owner && owner !== regionKey) errors.push(`${prefix}.legalDongCodes maps one code to multiple regionKeys`);
      legalCodeOwners.set(legalDongCode, regionKey);
    }
  }

  if (errors.length) {
    throw new LocationReferenceCrosswalkError("Location reference crosswalk validation failed", errors);
  }
  return crosswalk;
}

function recordEffectiveOn(record, asOf) {
  if (!asOf) return true;
  return record.validFrom <= asOf && (!record.validTo || record.validTo >= asOf);
}

function resolveReferenceRegionKey(crosswalkInput, selector = {}, options = {}) {
  const crosswalk = validateLocationReferenceCrosswalk(crosswalkInput, options);
  const regionKey = text(selector.regionKey);
  const legalDongCode = text(selector.legalDongCode || selector.legalDongCode10);
  const asOf = text(selector.asOf);

  if (asOf && !validDate(asOf)) return null;
  if (legalDongCode && !LEGAL_CODE_PATTERN.test(legalDongCode)) return null;

  const effectiveRecords = crosswalk.records.filter((record) => (
    record.status === "verified" && recordEffectiveOn(record, asOf)
  ));

  if (regionKey) {
    const record = effectiveRecords.find((candidate) => candidate.regionKey === regionKey);
    if (!record) return null;
    if (legalDongCode && !record.legalDongCodes.includes(legalDongCode)) return null;
    return record.regionKey;
  }

  if (!legalDongCode) return null;
  const matches = effectiveRecords.filter((record) => record.legalDongCodes.includes(legalDongCode));
  return matches.length === 1 ? matches[0].regionKey : null;
}

module.exports = {
  LocationReferenceCrosswalkError,
  resolveReferenceRegionKey,
  validateLocationReferenceCrosswalk
};
