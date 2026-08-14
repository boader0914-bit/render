"use strict";

const SCHEMA_VERSION = "v2-naver-visible-place-ad-contract.v1";
const SOURCE = "naver-integrated-search-visible-dom";
const EVIDENCE_LEVEL = "visible-ad-label-and-place-destination";
const AD_LABEL = "광고";
const REDIRECT_HOST = "ader.naver.com";
const DESTINATION_HOSTS = new Set(["map.naver.com"]);

function cleanText(value, limit) {
  if (typeof value !== "string") return "";
  return value.normalize("NFC").trim().replace(/\s+/gu, " ").slice(0, limit);
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

module.exports = {
  AD_LABEL,
  EVIDENCE_LEVEL,
  SCHEMA_VERSION,
  SOURCE,
  collectVisiblePlaceAds,
  parseAdvertiserRedirect,
  projectVisibleAdCandidate
};
