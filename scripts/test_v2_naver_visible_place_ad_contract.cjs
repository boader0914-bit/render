"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  EVIDENCE_LEVEL,
  SCHEMA_VERSION,
  SOURCE,
  collectVisiblePlaceAds,
  parseAdvertiserRedirect
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
