"use strict";

const crypto = require("node:crypto");

const LOCATION_STATUSES = new Set([
  "verified",
  "resolved",
  "approximate",
  "ambiguous",
  "not_found",
  "invalid",
  "pending",
  "error"
]);
const LOCATION_PRECISIONS = new Set(["rooftop", "parcel", "street", "locality", "region", "unknown"]);
const LOCATION_SOURCES = new Set(["manual", "provider", "legacy", "none"]);
const MAPPABLE_LOCATION_STATUSES = new Set(["verified", "resolved", "approximate"]);
const LOCATION_ERROR_CODES = new Set(["", "timeout", "aborted", "rate_limited", "provider_unavailable", "provider_error"]);
const MAX_ADDRESS_LENGTH = 1000;
const MAX_QUERY_LENGTH = 320;
const DEFAULT_TIMEOUT_MS = 5000;
const SERVICE_LOCATION_BOUNDS = Object.freeze({ minLat: 32, maxLat: 39.5, minLon: 124, maxLon: 132 });

function boundedText(value, max = 240) {
  return String(value ?? "").normalize("NFKC").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

function normalizeAddress(value) {
  const originalAddress = String(value ?? "").slice(0, MAX_ADDRESS_LENGTH);
  const normalizedAddress = boundedText(originalAddress, MAX_QUERY_LENGTH);
  const fingerprint = normalizedAddress
    ? crypto.createHash("sha256").update(normalizedAddress.toLowerCase(), "utf8").digest("hex")
    : "";
  const hasStreetNumber = /(?:대로|로|길|번길|번지|산\s*\d|\d{1,5}(?:-\d{1,5})?)(?:\s|$|,)/u.test(`${normalizedAddress} `);
  const localityOnly = Boolean(normalizedAddress && !hasStreetNumber && /(?:특별자치도|특별자치시|광역시|도|시|군|구|읍|면|동)$/u.test(normalizedAddress));
  return {
    originalAddress,
    normalizedAddress,
    queryAddress: normalizedAddress,
    fingerprint,
    specificity: !normalizedAddress ? "missing" : localityOnly ? "locality" : hasStreetNumber ? "address" : "ambiguous"
  };
}

function finiteCoordinate(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function coordinatePair(latitude, longitude) {
  const lat = finiteCoordinate(latitude);
  const lon = finiteCoordinate(longitude);
  if (lat === null || lon === null) return null;
  if (
    lat < SERVICE_LOCATION_BOUNDS.minLat
    || lat > SERVICE_LOCATION_BOUNDS.maxLat
    || lon < SERVICE_LOCATION_BOUNDS.minLon
    || lon > SERVICE_LOCATION_BOUNDS.maxLon
  ) return null;
  return { latitude: lat, longitude: lon };
}

function hasCoordinateInput(value = {}) {
  if (!value || typeof value !== "object") return false;
  return [value.latitude, value.lat, value.longitude, value.lon, value.lng]
    .some((entry) => entry !== null && entry !== undefined && entry !== "");
}

function rawCoordinatePair(value = {}) {
  if (!value || typeof value !== "object") return null;
  const latitude = value.latitude ?? value.lat;
  const longitude = value.longitude ?? value.lon ?? value.lng;
  return coordinatePair(latitude, longitude);
}

function safeStatus(value, fallback = "pending") {
  const status = boundedText(value, 32).toLowerCase();
  return LOCATION_STATUSES.has(status) ? status : fallback;
}

function safePrecision(value) {
  const precision = boundedText(value, 32).toLowerCase();
  return LOCATION_PRECISIONS.has(precision) ? precision : "unknown";
}

function safeSource(value) {
  const source = boundedText(value, 32).toLowerCase();
  return LOCATION_SOURCES.has(source) ? source : "none";
}

function locationStatusLabel(status) {
  return {
    verified: "검증 위치",
    resolved: "확인 위치",
    approximate: "근사 위치",
    ambiguous: "위치 검토 필요",
    not_found: "좌표 미수집",
    invalid: "좌표 오류",
    pending: "좌표 확인 대기",
    error: "좌표 확인 실패"
  }[status] || "좌표 확인 대기";
}

function normalizeLocationContract(value = {}, options = {}) {
  const fallbackAddress = options.address ?? value.resolvedAddress ?? value.displayAddress ?? value.address ?? "";
  const address = normalizeAddress(fallbackAddress);
  const pair = rawCoordinatePair(value);
  const source = safeSource(value.source || options.defaultSource || "none");
  const requestedStatus = safeStatus(value.status || options.defaultStatus || "pending");
  const suppliedCoordinate = hasCoordinateInput(value);
  let status = requestedStatus;
  // A provider result is resolved evidence. Only an explicit administrator
  // correction may claim the stronger verified state.
  if (source === "provider" && status === "verified") status = "resolved";
  if (pair) {
    if (!MAPPABLE_LOCATION_STATUSES.has(status)) status = source === "manual" ? "verified" : "resolved";
  } else if (suppliedCoordinate) {
    status = "invalid";
  } else if (MAPPABLE_LOCATION_STATUSES.has(status)) {
    status = "invalid";
  }
  const confidenceValue = value.confidence;
  const confidence = typeof confidenceValue === "number" && Number.isFinite(confidenceValue)
    ? Math.max(0, Math.min(1, confidenceValue))
    : null;
  const addressFingerprint = boundedText(value.addressFingerprint, 64) || address.fingerprint;
  const errorCodeValue = boundedText(value.errorCode, 32).toLowerCase();
  return {
    status,
    latitude: pair?.latitude ?? null,
    longitude: pair?.longitude ?? null,
    crs: "EPSG:4326",
    precision: safePrecision(value.precision),
    source,
    providerKey: /^[a-z0-9_-]{1,40}$/i.test(String(value.providerKey || value.provider || ""))
      ? String(value.providerKey || value.provider).toLowerCase()
      : "",
    confidence,
    resolvedAddress: boundedText(value.resolvedAddress || address.normalizedAddress, 320),
    addressFingerprint,
    geocodedAt: boundedText(value.geocodedAt || value.observedAt, 40),
    errorCode: LOCATION_ERROR_CODES.has(errorCodeValue) ? errorCodeValue : ""
  };
}

function locationFromLegacyPoint(point = {}, address = "") {
  const declaredSource = safeSource(point.source);
  // Historical UI code sometimes mirrored a manual correction into the
  // automatic coordinate array. A manual point is authoritative only while
  // it is present in an active manualCorrection record.
  if (declaredSource === "manual") return null;
  const pair = rawCoordinatePair(point);
  if (!pair) return null;
  return normalizeLocationContract({
    ...pair,
    status: point.status || "resolved",
    precision: point.precision || "unknown",
    source: declaredSource === "none" ? "legacy" : declaredSource,
    providerKey: point.providerKey || point.provider || "",
    confidence: typeof point.confidence === "number" ? point.confidence : null,
    resolvedAddress: point.resolvedAddress || point.address || address,
    addressFingerprint: point.addressFingerprint || "",
    geocodedAt: point.geocodedAt || point.observedAt || ""
  }, { address, defaultSource: "legacy", defaultStatus: "resolved" });
}

function primaryAddress(value = {}) {
  if (boundedText(value.address, 320)) return value.address;
  if (Array.isArray(value.addresses)) {
    return [...value.addresses].reverse().find((entry) => boundedText(entry, 320)) || "";
  }
  return value.resolvedAddress || "";
}

function manualLocation(value = {}, address = "") {
  const correction = value.manualCorrection && typeof value.manualCorrection === "object" ? value.manualCorrection : {};
  if (correction.active === false) return null;
  const raw = correction.location && typeof correction.location === "object"
    ? correction.location
    : {
        latitude: correction.latitude,
        longitude: correction.longitude,
        precision: correction.locationPrecision,
        resolvedAddress: correction.resolvedAddress || correction.address,
        geocodedAt: correction.locationUpdatedAt || correction.updatedAt
      };
  const supplied = hasCoordinateInput(raw);
  if (!supplied) return null;
  return normalizeLocationContract({ ...raw, status: "verified", source: "manual", confidence: 1 }, {
    address: raw.resolvedAddress || address,
    defaultSource: "manual",
    defaultStatus: "verified"
  });
}

function explicitLocation(value = {}, address = "") {
  const raw = value.location && typeof value.location === "object"
    ? value.location
    : value.geocoding && typeof value.geocoding === "object"
      ? value.geocoding
      : null;
  if (!raw) return null;
  if (safeSource(raw.source) === "manual") return null;
  return normalizeLocationContract(raw, { address, defaultSource: raw.source || "provider", defaultStatus: raw.status || "resolved" });
}

function effectiveCompanyLocation(value = {}) {
  const address = primaryAddress(value);
  const currentFingerprint = normalizeAddress(address).fingerprint;
  const manual = manualLocation(value, address);
  if (manual) return manual;

  const explicit = explicitLocation(value, address);
  if (explicit) {
    if (
      explicit.source !== "manual"
      && explicit.addressFingerprint
      && currentFingerprint
      && explicit.addressFingerprint !== currentFingerprint
    ) {
      return {
        ...explicit,
        status: "ambiguous",
        latitude: null,
        longitude: null,
        confidence: null
      };
    }
    return explicit;
  }

  const points = Array.isArray(value.coordinates) ? value.coordinates : [];
  for (let index = points.length - 1; index >= 0; index -= 1) {
    const legacy = locationFromLegacyPoint(points[index], address);
    if (legacy) return legacy;
  }

  const direct = locationFromLegacyPoint(value, address);
  if (direct) return direct;
  return normalizeLocationContract({
    status: address ? "pending" : "invalid",
    source: "none",
    resolvedAddress: address
  }, { address, defaultStatus: address ? "pending" : "invalid" });
}

function publicCompanyLocationSummary(value = {}) {
  const location = effectiveCompanyLocation(value);
  const address = primaryAddress(value);
  const mappable = MAPPABLE_LOCATION_STATUSES.has(location.status) && rawCoordinatePair(location);
  return {
    status: location.status,
    statusLabel: locationStatusLabel(location.status),
    lat: mappable ? location.latitude : null,
    lon: mappable ? location.longitude : null,
    crs: "EPSG:4326",
    precision: location.precision,
    source: location.source,
    providerKey: location.providerKey || "",
    confidence: location.confidence,
    resolvedAddress: boundedText(location.resolvedAddress, 240),
    displayAddress: boundedText(address || location.resolvedAddress, 240),
    geocodedAt: location.geocodedAt || ""
  };
}

function locationCandidateFromObservation(value = {}, options = {}) {
  const address = options.address ?? value.address ?? value.location?.address ?? "";
  const explicit = value.location && typeof value.location === "object" ? value.location : value;
  if (!rawCoordinatePair(explicit)) return null;
  const source = explicit.source || options.defaultSource || "legacy";
  const addressFingerprint = source === "provider"
    ? normalizeAddress(address).fingerprint
    : explicit.addressFingerprint;
  return normalizeLocationContract({
    ...explicit,
    status: explicit.status || options.defaultStatus || "resolved",
    source,
    resolvedAddress: explicit.resolvedAddress || address,
    addressFingerprint,
    geocodedAt: explicit.geocodedAt || explicit.observedAt || options.observedAt || ""
  }, { address, defaultSource: options.defaultSource || "legacy", defaultStatus: options.defaultStatus || "resolved" });
}

function locationPriority(location = {}) {
  const source = safeSource(location.source);
  const status = safeStatus(location.status);
  const sourceScore = { manual: 40, provider: 30, legacy: 20, none: 0 }[source] || 0;
  const statusScore = { verified: 8, resolved: 6, approximate: 3, ambiguous: 0, pending: 0, not_found: 0, invalid: -4, error: -5 }[status] || 0;
  return sourceScore + statusScore + (typeof location.confidence === "number" ? location.confidence : 0);
}

function locationObservedTime(location = {}) {
  const time = Date.parse(String(location.geocodedAt || location.observedAt || ""));
  return Number.isFinite(time) ? time : 0;
}

function locationDistanceMeters(left = {}, right = {}) {
  if (![left.latitude, left.longitude, right.latitude, right.longitude].every((entry) => typeof entry === "number" && Number.isFinite(entry))) return null;
  const radians = (degree) => degree * Math.PI / 180;
  const dLat = radians(right.latitude - left.latitude);
  const dLon = radians(right.longitude - left.longitude);
  const lat1 = radians(left.latitude);
  const lat2 = radians(right.latitude);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function mergeCompanyLocation(company = {}, incoming = null) {
  if (!incoming) return company.location || null;
  const address = primaryAddress(company);
  const candidate = normalizeLocationContract(incoming, { address, defaultSource: incoming.source || "legacy", defaultStatus: incoming.status || "resolved" });
  if (!rawCoordinatePair(candidate) || !MAPPABLE_LOCATION_STATUSES.has(candidate.status)) return company.location || null;
  const current = effectiveCompanyLocation(company);
  if (current.source === "manual" && rawCoordinatePair(current)) return current;
  if (rawCoordinatePair(current)) {
    const distance = locationDistanceMeters(current, candidate);
    // A conflicting far-away automatic point must be reviewed separately;
    // merging a duplicate record must never silently move the current marker.
    if (distance !== null && distance > 3000) return company.location || current;
    const currentPriority = locationPriority(current);
    const candidatePriority = locationPriority(candidate);
    if (currentPriority > candidatePriority) return company.location || current;
    if (currentPriority === candidatePriority) {
      const currentTime = locationObservedTime(current);
      const candidateTime = locationObservedTime(candidate);
      if (!candidateTime || candidateTime <= currentTime) return company.location || current;
    }
  }
  return candidate;
}

function mergeCompanyLocationProfiles(target = {}, source = {}) {
  const targetLocation = effectiveCompanyLocation(target);
  const sourceLocation = effectiveCompanyLocation(source);
  if (!rawCoordinatePair(sourceLocation)) return target.location || (rawCoordinatePair(targetLocation) ? targetLocation : null);
  return mergeCompanyLocation(target, sourceLocation);
}

function fixtureKey(value) {
  return normalizeAddress(value).normalizedAddress.toLowerCase();
}

function createFixtureGeocoder(fixtures = {}) {
  const rows = fixtures instanceof Map
    ? new Map([...fixtures.entries()].map(([key, value]) => [fixtureKey(key), value]))
    : new Map(Object.entries(fixtures || {}).map(([key, value]) => [fixtureKey(key), value]));
  return async ({ normalizedAddress }) => {
    const match = rows.get(fixtureKey(normalizedAddress));
    if (match instanceof Error) throw match;
    if (match && match.error) {
      const error = new Error(match.error.message || match.error.code || "fixture geocoder error");
      error.code = match.error.code || "GEOCODER_ERROR";
      error.statusCode = match.error.statusCode;
      throw error;
    }
    return Array.isArray(match) ? match : match ? [match] : [];
  };
}

async function geocodeAddress(input = {}, options = {}) {
  const address = normalizeAddress(input.originalAddress ?? input.address ?? input.normalizedAddress ?? "");
  if (!address.normalizedAddress) {
    return normalizeLocationContract({ status: "invalid", source: "none" }, { address: "", defaultStatus: "invalid" });
  }
  if (address.specificity === "locality") {
    return normalizeLocationContract({ status: "ambiguous", source: "none", resolvedAddress: address.normalizedAddress }, { address: address.normalizedAddress, defaultStatus: "ambiguous" });
  }
  if (options.enabled !== true || typeof options.adapter !== "function") {
    return normalizeLocationContract({ status: "pending", source: "none", resolvedAddress: address.normalizedAddress }, { address: address.normalizedAddress, defaultStatus: "pending" });
  }

  const timeoutMs = Math.max(100, Math.min(30000, Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS));
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error("geocoder timeout")), timeoutMs);
  const abort = () => controller.abort(options.signal?.reason || new Error("geocoder aborted"));
  if (options.signal) {
    if (options.signal.aborted) abort();
    else options.signal.addEventListener("abort", abort, { once: true });
  }
  try {
    const rawResults = await options.adapter({
      originalAddress: address.originalAddress,
      normalizedAddress: address.normalizedAddress,
      requestId: boundedText(input.requestId, 80),
      signal: controller.signal
    });
    const rows = (Array.isArray(rawResults) ? rawResults : rawResults ? [rawResults] : []).slice(0, 5);
    const results = rows
      .map((row) => normalizeLocationContract({ ...row, addressFingerprint: address.fingerprint }, {
        address: address.normalizedAddress,
        defaultSource: "provider",
        defaultStatus: "resolved"
      }))
      .filter((row) => rawCoordinatePair(row) && MAPPABLE_LOCATION_STATUSES.has(row.status));
    if (!results.length) {
      if (rows.length) {
        return normalizeLocationContract({ status: "invalid", source: "provider", resolvedAddress: address.normalizedAddress }, { address: address.normalizedAddress, defaultStatus: "invalid" });
      }
      return normalizeLocationContract({ status: "not_found", source: "provider", resolvedAddress: address.normalizedAddress }, { address: address.normalizedAddress, defaultStatus: "not_found" });
    }
    if (results.length > 1) {
      return normalizeLocationContract({ status: "ambiguous", source: "provider", resolvedAddress: address.normalizedAddress }, { address: address.normalizedAddress, defaultStatus: "ambiguous" });
    }
    return results[0];
  } catch (error) {
    const externallyAborted = Boolean(options.signal?.aborted);
    const statusCode = Number(error?.statusCode || error?.status || 0);
    const errorCode = controller.signal.aborted
      ? (externallyAborted ? "aborted" : "timeout")
      : statusCode === 429
        ? "rate_limited"
        : statusCode >= 500
          ? "provider_unavailable"
          : "provider_error";
    return normalizeLocationContract({ status: "error", errorCode, source: "provider", resolvedAddress: address.normalizedAddress }, { address: address.normalizedAddress, defaultStatus: "error" });
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener?.("abort", abort);
  }
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  LOCATION_PRECISIONS,
  LOCATION_ERROR_CODES,
  LOCATION_SOURCES,
  LOCATION_STATUSES,
  MAPPABLE_LOCATION_STATUSES,
  SERVICE_LOCATION_BOUNDS,
  coordinatePair,
  createFixtureGeocoder,
  effectiveCompanyLocation,
  geocodeAddress,
  locationCandidateFromObservation,
  locationStatusLabel,
  mergeCompanyLocation,
  mergeCompanyLocationProfiles,
  normalizeAddress,
  normalizeLocationContract,
  publicCompanyLocationSummary
};
