"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  isCurrentMapMarkerEligible,
  isMapLocationMappable,
  normalizeCanonicalRegionContext,
  normalizeMapLocation,
  normalizeV2MapCompatibility
} = require("./v2_map_compatibility.cjs");

global.fetch = (url) => {
  throw new Error(`External requests are forbidden in V2 map region safety fixtures: ${url}`);
};

const matched = normalizeCanonicalRegionContext({
  matchStatus: "matched",
  regionKey: "kr_gyeongnam_sancheong",
  sido: "경상남도",
  sigungu: "산청군",
  displayLabel: "경상남도 산청군",
  registryVersion: "canonical-fixture.v1",
  active: true
});
assert.deepEqual(matched, {
  matchStatus: "matched",
  matched: true,
  active: true,
  regionKey: "kr_gyeongnam_sancheong",
  sido: "경상남도",
  sigungu: "산청군",
  displayLabel: "경상남도 산청군",
  registryVersion: "canonical-fixture.v1"
});

for (const fixture of [
  { matchStatus: "unmatched", regionKey: "kr_gyeongnam_sancheong" },
  { matchStatus: "ambiguous", regionKey: "kr_gyeongnam_sancheong" },
  { matchStatus: "matched", regionKey: "kr_gyeongnam_sancheong", active: false },
  { matchStatus: "matched", regionKey: "not-canonical" },
  { regionKey: "kr_gyeongnam_sancheong" }
]) {
  const result = normalizeCanonicalRegionContext(fixture);
  assert.equal(result.matched, false);
  assert.equal(result.active, false);
  assert.equal(result.regionKey, "", "non-authoritative context must never retain a fallback region key");
  assert.equal(result.displayLabel, "", "non-authoritative context must never expose another region label");
}
assert.equal(normalizeCanonicalRegionContext({ matchStatus: "ambiguous" }).matchStatus, "ambiguous");
assert.equal(normalizeCanonicalRegionContext({ matchStatus: "matched", regionKey: "kr_gyeongnam_sancheong", active: false }).matchStatus, "inactive");

const verifiedManual = normalizeMapLocation({
  status: "verified",
  latitude: 35.4,
  longitude: 127.87,
  precision: "unknown",
  source: "manual",
  crs: "EPSG:4326"
});
assert.equal(verifiedManual.status, "verified");
assert.equal(isMapLocationMappable(verifiedManual), true);

const providerVerified = normalizeMapLocation({
  status: "verified",
  latitude: 35.4,
  longitude: 127.87,
  precision: "parcel",
  source: "provider"
});
assert.equal(providerVerified.status, "resolved", "provider evidence cannot claim administrator verification");
assert.equal(isMapLocationMappable(providerVerified), true);

const providerStreet = normalizeMapLocation({
  status: "resolved",
  latitude: 35.4,
  longitude: 127.87,
  precision: "street",
  source: "provider"
});
assert.equal(providerStreet.status, "approximate");
assert.equal(isMapLocationMappable(providerStreet), true);

for (const fixture of [
  { status: "resolved", latitude: 35.4, longitude: 127.87, precision: "locality", source: "provider" },
  { status: "resolved", latitude: 35.4, longitude: 127.87, precision: "region", source: "provider" },
  { status: "resolved", latitude: 35.4, longitude: 127.87, precision: "unknown", source: "legacy" },
  { status: "resolved", latitude: "35.4", longitude: "127.87", precision: "parcel", source: "provider" },
  { status: "resolved", latitude: 35.4, longitude: 140, precision: "parcel", source: "provider" },
  { status: "resolved", latitude: 35.4, longitude: 127.87, precision: "parcel", source: "unknown" },
  { status: "not_found", latitude: 35.4, longitude: 127.87, precision: "parcel", source: "provider" },
  { status: "resolved", latitude: 35.4, longitude: 127.87, precision: "parcel", source: "provider", crs: "EPSG:3857" }
]) {
  const result = normalizeMapLocation(fixture);
  assert.equal(isMapLocationMappable(result), false, `unsafe location must stay list-only: ${JSON.stringify(fixture)}`);
  assert.equal(result.lat, null);
  assert.equal(result.lon, null);
}

const unmatchedProjection = normalizeV2MapCompatibility({
  regionContext: {
    matchStatus: "unmatched",
    regionKey: "kr_gyeongnam_hadong",
    displayLabel: "다른 지역을 표시하면 안 됨"
  },
  ranking: {
    source: "naver_overall",
    items: [{
      placeId: "fixture-place",
      overallRank: 1,
      rankingSource: "overall",
      name: "Fixture Stay",
      address: "경상남도 산청군 Fixture 1",
      lat: 35.4,
      lon: 127.87,
      geo: { latitude: 35.4, longitude: 127.87 },
      rawHtml: "must-not-survive",
      providerKey: "must-not-survive"
    }]
  },
  availability: { items: [] },
  regions: [{ regionKey: "kr_gyeongnam_hadong", lat: 35.06, lon: 127.75 }]
});
assert.equal(unmatchedProjection.status, "ready", "unmatched regions may retain a textual company list");
assert.equal(unmatchedProjection.regionContext.matchStatus, "unmatched");
assert.equal(unmatchedProjection.regionContext.regionKey, "");
assert.equal(unmatchedProjection.mapCompatibility.exactRegionMatched, false);
assert.equal(unmatchedProjection.mapCompatibility.markerCandidateCount, 0);
assert.equal(unmatchedProjection.ranking.items[0].location.status, "not_found");
assert.equal(isCurrentMapMarkerEligible(unmatchedProjection.ranking.items[0]), false);
assert.equal(unmatchedProjection.ranking.items[0].lat, undefined);
assert.equal(unmatchedProjection.ranking.items[0].lon, undefined);
assert.equal(unmatchedProjection.ranking.items[0].geo, undefined);
assert.equal(unmatchedProjection.ranking.items[0].rawHtml, undefined);
assert.equal(unmatchedProjection.ranking.items[0].providerKey, undefined);

const moduleSource = fs.readFileSync(path.join(__dirname, "v2_map_compatibility.cjs"), "utf8");
assert.doesNotMatch(moduleSource, /fallbackCompanyCoordinate|regionForCompanyMapItem|regions\s*\[\s*0\s*\]/, "compatibility code must not restore arbitrary region fallback");
assert.doesNotMatch(moduleSource, /https?:\/\//i, "map compatibility code must not contain an external endpoint");
assert.doesNotMatch(moduleSource, /\bfetch\s*\(/, "map compatibility code must remain transport-free");
assert.doesNotMatch(moduleSource, /setTimeout|setInterval|writeFile|mkdir|rename/, "map compatibility code must not schedule or persist work");

console.log("V2 map canonical region and coordinate safety fixtures passed.");
