"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  CAPTURE_SCHEMA_VERSION,
  EVIDENCE_LEVEL,
  SCHEMA_VERSION,
  SOURCE,
  collectVisiblePlaceAds,
  mergeVisibleAdsWithPlaceResult,
  parseAdvertiserRedirect,
  validateVisibleAdCaptureEnvelope
} = require("./v2_naver_visible_place_ad_contract.cjs");

const fixture = JSON.parse(fs.readFileSync(path.resolve(
  __dirname,
  "..",
  "tests",
  "fixtures",
  "v2_naver_visible_place_ads_20260815.sanitized.json"
), "utf8"));
let assertions = 0;

function equal(actual, expected) {
  assert.equal(actual, expected);
  assertions += 1;
}

function deepEqual(actual, expected) {
  assert.deepEqual(actual, expected);
  assertions += 1;
}

function syntheticCandidate(row, suffix = "") {
  const destination = `https://map.naver.com/p/search/${encodeURIComponent(fixture.query)}${row.destinationPath}`;
  return {
    visible: true,
    labels: [row.adLabel],
    name: row.name,
    href: `https://ader.naver.com/redirect?tracking=must-not-survive-${row.visualOrder}${suffix}&fu=${encodeURIComponent(destination)}`
  };
}

function captureEnvelope(overrides = {}) {
  return {
    schemaVersion: CAPTURE_SCHEMA_VERSION,
    query: fixture.query,
    capturedAt: "2026-08-15T00:05:00.000Z",
    sourceHost: "search.naver.com",
    sourceSurface: "integrated-search-place",
    transport: "manual-bookmarklet",
    advertisements: fixture.advertisements.map((row) => ({
      adOrder: row.visualOrder,
      placeId: row.placeId,
      name: row.name,
      adTagPresent: true,
      source: SOURCE,
      evidenceLevel: EVIDENCE_LEVEL
    })),
    diagnostics: {
      candidateContainerCount: 4,
      advertiserLinkCount: 40,
      acceptedCount: 4,
      duplicateLinkCount: 36,
      rejectedContainerCount: 0
    },
    privacy: {
      rawHtmlStored: false,
      trackingUrlsStored: false,
      cookiesStored: false,
      providerResponseStored: false,
      operationalWrites: 0
    },
    ...overrides
  };
}

function throwsCode(action, code) {
  assert.throws(action, (error) => error?.code === code);
  assertions += 1;
}

function main() {
  equal(fixture.rawHtmlStored, false);
  equal(fixture.trackingUrlsStored, false);
  equal(fixture.advertisements.length, 4);

  const candidates = fixture.advertisements.map((row) => syntheticCandidate(row));
  candidates.push(syntheticCandidate(fixture.advertisements[0], "-duplicate"));
  candidates.push({ ...syntheticCandidate(fixture.advertisements[0]), visible: false });
  candidates.push({ ...syntheticCandidate(fixture.advertisements[0]), labels: ["일반"] });
  candidates.push({ ...syntheticCandidate(fixture.advertisements[0]), name: "" });
  candidates.push({ ...syntheticCandidate(fixture.advertisements[0]), href: "https://map.naver.com/place/1000421329" });
  candidates.push({ ...syntheticCandidate(fixture.advertisements[0]), href: "https://ader.naver.com/redirect?fu=https%3A%2F%2Fevil.example%2Fplace%2F1000421329" });
  candidates.push({ ...syntheticCandidate(fixture.advertisements[0]), href: "javascript:alert(1)" });

  const result = collectVisiblePlaceAds(candidates);
  equal(result.schemaVersion, SCHEMA_VERSION);
  equal(result.status, "visible-ads-collected");
  equal(result.diagnostics.candidateCount, 11);
  equal(result.diagnostics.acceptedCount, 4);
  equal(result.diagnostics.duplicateCount, 1);
  equal(result.diagnostics.rejectedByReason["candidate-not-visible"], 1);
  equal(result.diagnostics.rejectedByReason["ad-label-missing"], 1);
  equal(result.diagnostics.rejectedByReason["name-missing"], 1);
  equal(result.diagnostics.rejectedByReason["redirect-host-invalid"], 2);
  equal(result.diagnostics.rejectedByReason["destination-place-missing"], 1);
  equal(result.diagnostics.rawHtmlStored, false);
  equal(result.diagnostics.trackingUrlsStored, false);
  equal(result.diagnostics.cookiesStored, false);
  deepEqual(result.advertisements.map((row) => row.adOrder), [1, 2, 3, 4]);
  deepEqual(result.advertisements.map((row) => row.placeId), fixture.advertisements.map((row) => row.placeId));
  deepEqual(result.advertisements.map((row) => row.name), fixture.advertisements.map((row) => row.name));
  deepEqual([...new Set(result.advertisements.map((row) => row.source))], [SOURCE]);
  deepEqual([...new Set(result.advertisements.map((row) => row.evidenceLevel))], [EVIDENCE_LEVEL]);
  deepEqual([...new Set(result.advertisements.map((row) => row.adTagPresent))], [true]);

  const parsed = parseAdvertiserRedirect(syntheticCandidate(fixture.advertisements[0]).href);
  equal(parsed.placeId, "1000421329");
  equal(parsed.destinationHost, "map.naver.com");

  const empty = collectVisiblePlaceAds([{ visible: true, labels: ["일반"], name: "Organic", href: "https://example.com" }]);
  equal(empty.status, "visible-ads-empty");
  equal(empty.advertisements.length, 0);

  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /ader\.naver\.com|tracking=|must-not-survive|\bfu=|https?:\/\//iu);
  assertions += 1;
  assert.doesNotMatch(serialized, /cookie-value|authorization-value|set-cookie-value/iu);
  assertions += 1;
  assert.throws(() => collectVisiblePlaceAds(new Array(501).fill({})), /at most 500/u);
  assertions += 1;

  const capture = validateVisibleAdCaptureEnvelope(captureEnvelope(), {
    expectedQuery: fixture.query,
    now: new Date("2026-08-15T00:10:00.000Z")
  });
  equal(capture.schemaVersion, CAPTURE_SCHEMA_VERSION);
  equal(capture.advertisements.length, 4);
  equal(capture.diagnostics.duplicateLinkCount, 36);
  equal(capture.privacy.rawHtmlStored, false);

  const merged = mergeVisibleAdsWithPlaceResult({
    keyword: fixture.query,
    organic: [{
      rank: 1,
      placeId: "1000421329",
      name: "합천H글램핑",
      category: "캠핑,야영장",
      address: "경상남도 합천군",
      hasBooking: true,
      reviewScore: 4.74,
      reviewCount: 1879,
      minimumPrice: 180000,
      roomPreviewCount: 1,
      roomPreviewNames: ["카바나"]
    }],
    advertisements: [{ adOrder: 1, placeId: "server-snapshot" }],
    counts: { organicRows: 1, advertisementRows: 1 },
    diagnostics: { status: "current-filter-matched-empty" },
    rawProviderResponseStored: false,
    operationalWrites: 0
  }, captureEnvelope(), { now: new Date("2026-08-15T00:10:00.000Z") });
  equal(merged.advertisements.length, 4);
  equal(merged.advertisements[0].category, "캠핑,야영장");
  equal(merged.advertisements[0].minimumPrice, 180000);
  equal(merged.advertisements[1].category, "");
  equal(merged.advertisementEvidence.serverSnapshotRows, 1);
  equal(merged.advertisementEvidence.browserVisibleRows, 4);
  equal(merged.counts.advertisementRows, 4);
  equal(merged.operationalWrites, 0);
  assert.doesNotMatch(JSON.stringify(merged), /ader\.naver\.com|tracking=|\bfu=|https?:\/\//iu);
  assertions += 1;

  throwsCode(() => validateVisibleAdCaptureEnvelope(captureEnvelope({ query: "다른 검색어" }), {
    expectedQuery: fixture.query,
    now: new Date("2026-08-15T00:10:00.000Z")
  }), "capture-envelope-invalid");
  throwsCode(() => validateVisibleAdCaptureEnvelope(captureEnvelope({ capturedAt: "2026-08-14T00:00:00.000Z" }), {
    now: new Date("2026-08-15T00:10:00.000Z")
  }), "capture-envelope-invalid");
  throwsCode(() => validateVisibleAdCaptureEnvelope(captureEnvelope({
    privacy: { ...captureEnvelope().privacy, trackingUrlsStored: true }
  }), { now: new Date("2026-08-15T00:10:00.000Z") }), "capture-privacy-invalid");
  throwsCode(() => validateVisibleAdCaptureEnvelope(captureEnvelope({
    advertisements: [captureEnvelope().advertisements[0], { ...captureEnvelope().advertisements[0], adOrder: 2 }],
    diagnostics: { ...captureEnvelope().diagnostics, acceptedCount: 2 }
  }), { now: new Date("2026-08-15T00:10:00.000Z") }), "capture-advertisement-duplicate");

  process.stdout.write(`${JSON.stringify({
    event: "v2_naver_visible_place_ad_contract_tests_complete",
    assertions,
    liveDerivedSanitizedRows: fixture.advertisements.length,
    externalRequests: 0,
    operationalWrites: 0,
    rawProviderResponsesStored: 0
  })}\n`);
}

main();
