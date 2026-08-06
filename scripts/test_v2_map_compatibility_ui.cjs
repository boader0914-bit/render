"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  CURRENT_MARKER_RANK_LIMIT,
  MAX_DETAIL_RANK,
  MAX_OVERALL_RANK,
  V2_MAP_COMPATIBILITY_SCHEMA_VERSION,
  assertV2MapCompatibilityReady,
  isCurrentMapMarkerEligible,
  normalizeV2MapCompatibility
} = require("./v2_map_compatibility.cjs");

global.fetch = (url) => {
  throw new Error(`External requests are forbidden in V2 map compatibility fixtures: ${url}`);
};

function rankingItem(rank, overrides = {}) {
  return {
    placeId: `place-${rank}`,
    overallRank: rank,
    rankingSource: "overall",
    name: `Fixture Stay ${rank}`,
    address: `Fixture Province Fixture City ${rank}`,
    searchRegion: "Fixture City",
    addressRegion: "Fixture City",
    regionBoundaryStatus: "same",
    ...overrides
  };
}

const manualLocation = {
  status: "verified",
  latitude: 37.5,
  longitude: 127.1,
  crs: "EPSG:4326",
  precision: "unknown",
  source: "manual",
  confidence: 1,
  resolvedAddress: "Fixture Province Fixture City 1",
  providerKey: "must-not-survive"
};
const providerLocation = {
  status: "resolved",
  latitude: 37.51,
  longitude: 127.11,
  crs: "EPSG:4326",
  precision: "parcel",
  source: "provider",
  confidence: 0.91,
  resolvedAddress: "Fixture Province Fixture City 2"
};
const approximateLocation = {
  status: "approximate",
  latitude: 37.52,
  longitude: 127.12,
  crs: "EPSG:4326",
  precision: "street",
  source: "provider",
  confidence: 0.62,
  resolvedAddress: "Fixture Province Fixture City 3"
};

const rankingItems = Array.from({ length: 55 }, (_, index) => rankingItem(index + 1));
rankingItems[1] = rankingItem(2, { location: providerLocation });
rankingItems[4] = rankingItem(5, {
  lat: 37.9,
  lon: 127.2,
  geo: { lat: 37.9, lon: 127.2 },
  rawResponse: "must-not-survive"
});
rankingItems.push(rankingItem(2, { name: "Duplicate worse row" }));
rankingItems.push({ ...rankingItem(10), placeId: "regional-only", overallRank: 10, rankingSource: "regional" });
rankingItems.push({ ...rankingItem(11), placeId: "generic-rank-only", overallRank: null, rank: 1 });

const detailItems = [
  rankingItem(1, { location: manualLocation, estimatedRevenue: 1010000, inventoryState: "ready" }),
  rankingItem(2, { estimatedRevenue: 2020000, inventoryState: "ready" }),
  rankingItem(3, { location: approximateLocation, estimatedRevenue: 3030000, inventoryState: "zero" }),
  rankingItem(4, { location: providerLocation, estimatedRevenue: 4040000, inventoryState: "ready" })
];

const input = {
  regionContext: {
    matchStatus: "matched",
    regionKey: "kr_fixture_province_city",
    sido: "Fixture Province",
    sigungu: "Fixture City",
    displayLabel: "Fixture Province Fixture City",
    registryVersion: "fixture-registry.v1",
    active: true
  },
  ranking: {
    source: "naver_overall",
    items: rankingItems
  },
  availability: {
    items: detailItems
  }
};
const original = JSON.stringify(input);
const projected = normalizeV2MapCompatibility(input);
assert.equal(assertV2MapCompatibilityReady(projected), projected);

assert.equal(JSON.stringify(input), original, "map compatibility projection must not mutate collector data");
assert.equal(projected.schemaVersion, V2_MAP_COMPATIBILITY_SCHEMA_VERSION);
assert.equal(projected.strategy, "v2_legacy_4e4e190");
assert.equal(projected.status, "ready");
assert.equal(projected.blocker, "");
assert.equal(projected.ranking.source, "naver_overall");
assert.equal(projected.ranking.total, MAX_OVERALL_RANK);
assert.equal(projected.ranking.items.length, MAX_OVERALL_RANK);
assert.equal(projected.ranking.items[0].overallRank, 1);
assert.equal(projected.ranking.items.at(-1).overallRank, 50);
assert.equal(projected.ranking.items.filter((item) => item.placeId === "place-2").length, 1, "duplicate Place identities must collapse to their best rank");
assert.equal(projected.ranking.items.some((item) => item.placeId === "regional-only"), false, "regional rows cannot become overall map ranks");
assert.equal(projected.ranking.items.some((item) => item.placeId === "generic-rank-only"), false, "generic rank cannot become an overall map rank");

assert.equal(projected.availability.items.length, MAX_DETAIL_RANK, "only the exact top-three Place identities may link details");
assert.deepEqual(projected.availability.items.map((item) => item.placeId), ["place-1", "place-2", "place-3"]);
assert.deepEqual(projected.availability.items.map((item) => item.availabilityIndex), [0, 1, 2]);
assert.deepEqual(projected.availability.items.map((item) => item.estimatedRevenue), [1010000, 2020000, 3030000], "detail metrics must survive the map projection");
assert.equal(projected.ranking.inventoryLinkedCount, 3);
for (const rank of [1, 2, 3]) {
  const row = projected.ranking.items.find((item) => item.overallRank === rank);
  assert.equal(row.hasInventory, true);
  assert.equal(row.availabilityIndex, rank - 1);
}
assert.equal(projected.ranking.items.find((item) => item.overallRank === 4).hasInventory, false, "rank four must remain outside the detailed top-three boundary");
assert.equal(projected.availability.items.some((item) => item.overallRank === 4), false);

assert.equal(projected.availability.items[0].location.status, "verified");
assert.equal(projected.availability.items[1].location.status, "resolved", "a safe ranking location must survive when its linked detail omits location metadata");
assert.equal(projected.availability.items[2].location.status, "approximate");
assert.equal(projected.availability.items[0].location.providerKey, undefined, "private geocoder metadata must not enter map input");
assert.equal(projected.ranking.items[4].lat, undefined, "legacy top-level coordinates must be removed");
assert.equal(projected.ranking.items[4].lon, undefined);
assert.equal(projected.ranking.items[4].geo, undefined);
assert.equal(projected.ranking.items[4].rawResponse, undefined);
assert.equal(projected.ranking.items[4].location.status, "not_found", "legacy raw coordinates must not silently become markers");

assert.equal(projected.mapCompatibility.overallRankLimit, 50);
assert.equal(projected.mapCompatibility.detailRankLimit, 3);
assert.equal(projected.mapCompatibility.currentMarkerRankLimit, CURRENT_MARKER_RANK_LIMIT);
assert.equal(projected.mapCompatibility.exactRegionMatched, true);
assert.equal(projected.mapCompatibility.markerCandidateCount, 3);
assert.equal(projected.mapCompatibility.mappableCount, 3);
assert.equal(projected.mapCompatibility.unresolvedLocationCount, 47);
assert.equal(projected.mapCompatibility.arbitraryRegionFallback, false);
assert.equal(projected.mapCompatibility.generatedCompanyCoordinates, false);
assert.equal(projected.ranking.items.filter(isCurrentMapMarkerEligible).length, 3);

const duplicateDetail = normalizeV2MapCompatibility({
  ...input,
  availability: {
    items: [detailItems[0], { ...detailItems[0], estimatedRevenue: 9999999 }, detailItems[1], detailItems[2]]
  }
});
assert.equal(duplicateDetail.ranking.items.find((item) => item.overallRank === 1).hasInventory, false, "ambiguous duplicate details must fail closed");
assert.equal(duplicateDetail.availability.items.length, 2);

const blocked = normalizeV2MapCompatibility({
  ...input,
  ranking: { source: "naver_regional", items: rankingItems }
});
assert.equal(blocked.status, "blocked");
assert.equal(blocked.blocker, "ranking_source_not_overall");
assert.equal(blocked.ranking.source, "");
assert.equal(blocked.ranking.items.length, 0);
assert.equal(blocked.availability.items.length, 0);
assert.throws(
  () => assertV2MapCompatibilityReady(blocked),
  (error) => error.code === "V2_MAP_COMPATIBILITY_RESULT_INVALID" && error.statusCode === 502
);
assert.throws(
  () => assertV2MapCompatibilityReady(normalizeV2MapCompatibility({
    ...input,
    ranking: { ...input.ranking, items: rankingItems.slice(0, 49) }
  })),
  (error) => error.code === "V2_MAP_COMPATIBILITY_RESULT_INVALID",
  "an incomplete 1-50 ranking must fail before replacing the run projection"
);
assert.throws(
  () => assertV2MapCompatibilityReady(duplicateDetail),
  (error) => error.code === "V2_MAP_COMPATIBILITY_RESULT_INVALID",
  "all three exact detail identities must link before replacing the run projection"
);

const serverSource = fs.readFileSync(path.join(__dirname, "glamping_app_server.cjs"), "utf8");
assert.match(
  serverSource,
  /collectorActivationProfile === V2_COLLECTOR_COMPATIBILITY_PROFILE[\s\S]{0,500}normalizeV2MapCompatibility\(/u,
  "the deployed run loader must apply the V2 map adapter only to the compatibility profile"
);
assert.match(
  serverSource,
  /assertV2MapCompatibilityReady\(normalizeV2MapCompatibility\([\s\S]{0,400}result\.mapCompatibility/u,
  "the run loader must validate the complete 50-rank/top-three projection before replacing data"
);

console.log("V2 map compatibility UI fixtures passed.");
