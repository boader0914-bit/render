"use strict";

const SCHEMA_VERSION = "v2-naver-visible-place-ad-contract.v1";
const SOURCE = "naver-integrated-search-visible-dom";
const EVIDENCE_LEVEL = "visible-ad-label-and-place-destination";
const CAPTURE_SCHEMA_VERSION = "v2-naver-visible-place-ad-capture.v1";
const CAPTURE_SOURCE_HOST = "search.naver.com";
const CAPTURE_SOURCE_SURFACE = "integrated-search-place";
const CAPTURE_TRANSPORT = "manual-bookmarklet";
const MAX_CAPTURE_AGE_MS = 60 * 60 * 1000;
const AD_LABEL = "광고";
const REDIRECT_HOST = "ader.naver.com";
const DESTINATION_HOSTS = new Set(["map.naver.com"]);

function cleanText(value, limit) {
  if (typeof value !== "string") return "";
  return value.normalize("NFC").trim().replace(/\s+/gu, " ").slice(0, limit);
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertKeys(value, allowed, code) {
  if (!isObject(value) || Object.keys(value).some((key) => !allowed.has(key))) reject(code);
}

function integer(value) {
  const number = Number(value);
  return Number.isInteger(number) ? number : null;
}

function reason(error) {
  return typeof error?.code === "string" ? error.code : "invalid-candidate";
}

function reject(code) {
  const error = new TypeError(code);
  error.code = code;
  throw error;
}

function parseDestination(value) {
  const candidates = [String(value || "")];
  if (/%(?:2f|3a)/iu.test(candidates[0])) {
    try {
      candidates.push(decodeURIComponent(candidates[0]));
    } catch {
      // The undecoded value is still checked below.
    }
  }

  for (const candidate of candidates) {
    try {
      const destination = new URL(candidate);
      const host = destination.hostname.toLowerCase();
      if (destination.protocol !== "https:" || !DESTINATION_HOSTS.has(host)) continue;
      const match = destination.pathname.match(/(?:^|\/)place\/(\d{1,30})(?:\/|$)/u);
      if (!match) continue;
      return Object.freeze({
        placeId: match[1],
        destinationHost: host
      });
    } catch {
      // Try the next safe decoding form.
    }
  }
  reject("destination-place-missing");
}

function parseAdvertiserRedirect(href) {
  const text = typeof href === "string" ? href.trim() : "";
  if (!text || text.length > 8192) reject("redirect-invalid");

  let redirect;
  try {
    redirect = new URL(text);
  } catch {
    reject("redirect-invalid");
  }
  if (redirect.protocol !== "https:" || redirect.hostname.toLowerCase() !== REDIRECT_HOST) {
    reject("redirect-host-invalid");
  }
  const destination = redirect.searchParams.get("fu");
  if (!destination) reject("destination-missing");
  return parseDestination(destination);
}

function projectVisibleAdCandidate(candidate) {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) reject("candidate-invalid");
  if (candidate.visible !== true) reject("candidate-not-visible");
  const labels = Array.isArray(candidate.labels)
    ? candidate.labels.slice(0, 20).map((value) => cleanText(value, 40))
    : [];
  if (!labels.includes(AD_LABEL)) reject("ad-label-missing");
  const name = cleanText(candidate.name, 300);
  if (!name) reject("name-missing");
  const destination = parseAdvertiserRedirect(candidate.href);
  return Object.freeze({
    placeId: destination.placeId,
    name,
    adTagPresent: true,
    source: SOURCE,
    evidenceLevel: EVIDENCE_LEVEL
  });
}

function collectVisiblePlaceAds(candidates) {
  if (!Array.isArray(candidates) || candidates.length > 500) {
    throw new TypeError("Visible ad candidates must be an array of at most 500 entries");
  }
  const rows = [];
  const seenPlaceIds = new Set();
  const rejectedByReason = {};
  let duplicateCount = 0;

  for (const candidate of candidates) {
    let projected;
    try {
      projected = projectVisibleAdCandidate(candidate);
    } catch (error) {
      const code = reason(error);
      rejectedByReason[code] = (rejectedByReason[code] || 0) + 1;
      continue;
    }
    if (seenPlaceIds.has(projected.placeId)) {
      duplicateCount += 1;
      continue;
    }
    seenPlaceIds.add(projected.placeId);
    rows.push(Object.freeze({ adOrder: rows.length + 1, ...projected }));
  }

  return Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    status: rows.length > 0 ? "visible-ads-collected" : "visible-ads-empty",
    advertisements: Object.freeze(rows),
    diagnostics: Object.freeze({
      candidateCount: candidates.length,
      acceptedCount: rows.length,
      duplicateCount,
      rejectedByReason: Object.freeze({ ...rejectedByReason }),
      rawHtmlStored: false,
      trackingUrlsStored: false,
      cookiesStored: false
    })
  });
}

function normalizeCaptureAdvertisement(value, index) {
  assertKeys(value, new Set([
    "adOrder",
    "placeId",
    "name",
    "adTagPresent",
    "source",
    "evidenceLevel"
  ]), "capture-advertisement-invalid");
  const adOrder = integer(value.adOrder);
  const placeId = String(value.placeId || "").trim();
  const name = cleanText(value.name, 300);
  if (
    adOrder !== index + 1
    || !/^\d{1,30}$/u.test(placeId)
    || !name
    || value.adTagPresent !== true
    || value.source !== SOURCE
    || value.evidenceLevel !== EVIDENCE_LEVEL
  ) reject("capture-advertisement-invalid");
  return Object.freeze({ adOrder, placeId, name, adTagPresent: true, source: SOURCE, evidenceLevel: EVIDENCE_LEVEL });
}

function validateVisibleAdCaptureEnvelope(value, options = {}) {
  assertKeys(value, new Set([
    "schemaVersion",
    "query",
    "capturedAt",
    "sourceHost",
    "sourceSurface",
    "transport",
    "advertisements",
    "diagnostics",
    "privacy"
  ]), "capture-envelope-invalid");
  const query = cleanText(value.query, 120);
  const expectedQuery = options.expectedQuery === undefined ? null : cleanText(options.expectedQuery, 120);
  const capturedAtMs = Date.parse(String(value.capturedAt || ""));
  const nowMs = options.now instanceof Date ? options.now.getTime() : Number(options.now ?? Date.now());
  const maxAgeMs = Number(options.maxAgeMs ?? MAX_CAPTURE_AGE_MS);
  if (
    value.schemaVersion !== CAPTURE_SCHEMA_VERSION
    || !query
    || /[\u0000-\u001f\u007f]/u.test(String(value.query || ""))
    || (expectedQuery !== null && query !== expectedQuery)
    || !Number.isFinite(capturedAtMs)
    || !Number.isFinite(nowMs)
    || !Number.isFinite(maxAgeMs)
    || maxAgeMs < 0
    || capturedAtMs > nowMs + 5 * 60 * 1000
    || nowMs - capturedAtMs > maxAgeMs
    || value.sourceHost !== CAPTURE_SOURCE_HOST
    || value.sourceSurface !== CAPTURE_SOURCE_SURFACE
    || value.transport !== CAPTURE_TRANSPORT
    || !Array.isArray(value.advertisements)
    || value.advertisements.length > 100
  ) reject("capture-envelope-invalid");

  const advertisements = value.advertisements.map(normalizeCaptureAdvertisement);
  if (new Set(advertisements.map((row) => row.placeId)).size !== advertisements.length) {
    reject("capture-advertisement-duplicate");
  }
  assertKeys(value.diagnostics, new Set([
    "candidateContainerCount",
    "advertiserLinkCount",
    "acceptedCount",
    "duplicateLinkCount",
    "rejectedContainerCount"
  ]), "capture-diagnostics-invalid");
  const diagnostics = Object.freeze({
    candidateContainerCount: integer(value.diagnostics.candidateContainerCount),
    advertiserLinkCount: integer(value.diagnostics.advertiserLinkCount),
    acceptedCount: integer(value.diagnostics.acceptedCount),
    duplicateLinkCount: integer(value.diagnostics.duplicateLinkCount),
    rejectedContainerCount: integer(value.diagnostics.rejectedContainerCount)
  });
  if (
    Object.values(diagnostics).some((count) => count === null || count < 0)
    || Object.values(diagnostics).some((count) => count > 10000)
    || diagnostics.acceptedCount !== advertisements.length
    || diagnostics.advertiserLinkCount < diagnostics.acceptedCount
    || diagnostics.candidateContainerCount < diagnostics.acceptedCount
  ) reject("capture-diagnostics-invalid");
  assertKeys(value.privacy, new Set([
    "rawHtmlStored",
    "trackingUrlsStored",
    "cookiesStored",
    "providerResponseStored",
    "operationalWrites"
  ]), "capture-privacy-invalid");
  if (
    value.privacy.rawHtmlStored !== false
    || value.privacy.trackingUrlsStored !== false
    || value.privacy.cookiesStored !== false
    || value.privacy.providerResponseStored !== false
    || value.privacy.operationalWrites !== 0
  ) reject("capture-privacy-invalid");

  return Object.freeze({
    schemaVersion: CAPTURE_SCHEMA_VERSION,
    query,
    capturedAt: new Date(capturedAtMs).toISOString(),
    sourceHost: CAPTURE_SOURCE_HOST,
    sourceSurface: CAPTURE_SOURCE_SURFACE,
    transport: CAPTURE_TRANSPORT,
    advertisements: Object.freeze(advertisements),
    diagnostics,
    privacy: Object.freeze({
      rawHtmlStored: false,
      trackingUrlsStored: false,
      cookiesStored: false,
      providerResponseStored: false,
      operationalWrites: 0
    })
  });
}

function mergeVisibleAdsWithPlaceResult(result, capture, options = {}) {
  if (!isObject(result) || !Array.isArray(result.organic) || !Array.isArray(result.advertisements)) {
    reject("place-result-invalid");
  }
  const keyword = cleanText(result.keyword, 120);
  if (!keyword) reject("place-result-invalid");
  const validated = validateVisibleAdCaptureEnvelope(capture, { ...options, expectedQuery: keyword });
  const organicById = new Map(result.organic
    .filter((row) => /^\d{1,30}$/u.test(String(row?.placeId || "")))
    .map((row) => [String(row.placeId), row]));
  const advertisements = validated.advertisements.map((row) => {
    const organic = organicById.get(row.placeId) || {};
    return Object.freeze({
      adOrder: row.adOrder,
      placeId: row.placeId,
      name: row.name,
      category: cleanText(organic.category, 300),
      address: cleanText(organic.address, 1000),
      hasBooking: typeof organic.hasBooking === "boolean" ? organic.hasBooking : null,
      reviewScore: Number.isFinite(Number(organic.reviewScore)) ? Number(organic.reviewScore) : null,
      reviewCount: Number.isFinite(Number(organic.reviewCount)) ? Number(organic.reviewCount) : null,
      visitorReviewCount: Number.isFinite(Number(organic.visitorReviewCount)) ? Number(organic.visitorReviewCount) : null,
      minimumPrice: Number.isFinite(Number(organic.minimumPrice)) ? Number(organic.minimumPrice) : null,
      roomPreviewCount: Number.isInteger(Number(organic.roomPreviewCount)) ? Number(organic.roomPreviewCount) : 0,
      roomPreviewNames: Array.isArray(organic.roomPreviewNames) ? organic.roomPreviewNames.slice(0, 20).map((name) => cleanText(name, 300)) : [],
      adTagPresent: true,
      source: SOURCE,
      evidenceLevel: EVIDENCE_LEVEL
    });
  });
  return Object.freeze({
    ...result,
    advertisements: Object.freeze(advertisements),
    counts: Object.freeze({ ...(isObject(result.counts) ? result.counts : {}), advertisementRows: advertisements.length }),
    advertisementEvidence: Object.freeze({
      schemaVersion: validated.schemaVersion,
      source: SOURCE,
      evidenceLevel: EVIDENCE_LEVEL,
      transport: validated.transport,
      capturedAt: validated.capturedAt,
      browserVisibleRows: advertisements.length,
      serverSnapshotRows: result.advertisements.length,
      rawHtmlStored: false,
      trackingUrlsStored: false,
      operationalWrites: 0
    }),
    diagnostics: Object.freeze({
      ...(isObject(result.diagnostics) ? result.diagnostics : {}),
      browserVisibleAdvertisements: validated.diagnostics
    }),
    rawProviderResponseStored: false,
    operationalWrites: 0
  });
}

const publicApi = Object.freeze({
  AD_LABEL,
  CAPTURE_SCHEMA_VERSION,
  CAPTURE_SOURCE_HOST,
  CAPTURE_SOURCE_SURFACE,
  CAPTURE_TRANSPORT,
  EVIDENCE_LEVEL,
  MAX_CAPTURE_AGE_MS,
  SCHEMA_VERSION,
  SOURCE,
  collectVisiblePlaceAds,
  mergeVisibleAdsWithPlaceResult,
  parseAdvertiserRedirect,
  projectVisibleAdCandidate,
  validateVisibleAdCaptureEnvelope
});

if (typeof module !== "undefined" && module.exports) module.exports = publicApi;
if (typeof document !== "undefined" && typeof globalThis !== "undefined") {
  globalThis.V2NaverVisiblePlaceAdContract = publicApi;
}
