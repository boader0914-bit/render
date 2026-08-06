"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { __test } = require("./glamping_app_server.cjs");

const payload = {
  keyword: "경남 글램핑",
  checkIn: "2026-08-06",
  checkOut: "2026-08-06",
  searchMode: "keyword",
  productMode: "all",
  collectionMode: "fast",
  collectionPurpose: "revenue_detail",
  detailRankRanges: "",
  sourceRole: "admin",
  collectionSource: "admin_search"
};

const localTrusted = __test.trustedPreviewAdminCrawlPayload({
  ...payload,
  collectionMode: "precision",
  collectionSource: "b2b_search",
  naverLegacyLimitedActivation: true,
  naverCollectorStrategy: "legacy_candidate",
  naverCollectorScope: "main_place_only",
  naverProviderCallBudget: 1
});
assert.equal(localTrusted.sourceRole, "admin");
assert.equal(localTrusted.collectionSource, "admin_search");
assert.equal(localTrusted.naverLegacyLimitedActivation, false, "client fields cannot activate legacy outside exact Preview");
assert.equal(localTrusted.naverCollectorStrategy, "current");
assert.equal(localTrusted.naverCollectorScope, "current");
assert.equal(localTrusted.naverProviderCallBudget, 0);

const currentSignature = __test.crawlPayloadSignature({
  ...payload,
  naverLegacyLimitedActivation: false
});
const legacySignature = __test.crawlPayloadSignature({
  ...payload,
  naverLegacyLimitedActivation: true,
  naverCollectorStrategy: "legacy_candidate",
  naverCollectorScope: "main_place_only",
  naverLimitedActivationProfile: "preview-admin-keyword-fast-main-place.v1"
});
assert.match(currentSignature, /^[a-f0-9]{40}$/u);
assert.match(legacySignature, /^[a-f0-9]{40}$/u);
assert.notEqual(currentSignature, legacySignature, "current and limited legacy runs must not share reuse identity");

const validLimitedManifest = {
  documentType: "lodging-collection-manifest",
  outputDir: path.join(__dirname, "..", "outputs", "fixture_limited_glamping_20260806_120000"),
  collectorStrategy: "legacy_candidate",
  collectorScope: "main_place_only",
  collectorActivationProfile: "preview-admin-keyword-fast-main-place.v1",
  collectionMode: "fast",
  collectionProfile: "fast_rank",
  providerCallBudget: 1,
  providerRequestCount: 1,
  automaticRetry: false,
  automaticFallback: false,
  saveRunOnSuccessOnly: true,
  collectorContractHash: "contract-fixture",
  executionIdentityHash: "identity-fixture",
  counts: {
    naverOverall: 50,
    naverRegional: 0,
    naverBookingStockChecked: 0,
    nolFirstPage: 0,
    nolRawFirstPage: 0,
    ddnayo: 0
  }
};
assert.equal(
  __test.validateNaverLegacyLimitedRunManifest(validLimitedManifest, { naverLegacyLimitedActivation: true }).runId,
  "fixture_limited_glamping_20260806_120000"
);
assert.throws(
  () => __test.validateNaverLegacyLimitedRunManifest(
    { ...validLimitedManifest, providerRequestCount: 0 },
    { naverLegacyLimitedActivation: true }
  ),
  (error) => error?.code === "NAVER_LEGACY_LIMITED_RESULT_INVALID"
);
assert.throws(
  () => __test.validateNaverLegacyLimitedRunManifest(
    { ...validLimitedManifest, counts: { naverOverall: 50 } },
    { naverLegacyLimitedActivation: true }
  ),
  (error) => error?.code === "NAVER_LEGACY_LIMITED_RESULT_INVALID"
);
assert.throws(
  () => __test.validateNaverLegacyLimitedRunManifest(
    {
      ...validLimitedManifest,
      outputDir: path.join(__dirname, "..", "outputs", "nested", "fixture_limited_glamping_20260806_120000")
    },
    { naverLegacyLimitedActivation: true }
  ),
  (error) => error?.code === "NAVER_LEGACY_LIMITED_RESULT_INVALID"
);
assert.throws(
  () => __test.validateNaverLegacyLimitedRunManifest(
    { ...validLimitedManifest, outputDir: path.resolve(__dirname, "..", "outside_fixture") },
    { naverLegacyLimitedActivation: true }
  ),
  (error) => error?.code === "NAVER_LEGACY_LIMITED_RESULT_INVALID"
);

for (const purpose of ["basic_db", "demand_location", "revenue_detail"]) {
  const route = __test.collectionDbRouteProfile(purpose, "fast_rank");
  assert.equal(route.key, "rank_probe");
  assert.equal(route.appliesInventory, false);
  assert.equal(route.appliesHistory, false);
  assert.equal(route.appliesDemandLocation, false);
}

const serverSource = fs.readFileSync(path.join(__dirname, "glamping_app_server.cjs"), "utf8");
assert.match(serverSource, /POST"\s*&&\s*reqUrl\.pathname === "\/api\/crawl"[\s\S]{0,1000}trustedPreviewAdminCrawlPayload\(payload\)/u);
assert.match(serverSource, /NAVER_LEGACY_LIMITED_ACTIVATION:[\s\S]{0,160}payload\.naverLegacyLimitedActivation/u);
assert.match(serverSource, /NAVER_PROVIDER_CALL_BUDGET:[\s\S]{0,180}payload\.naverProviderCallBudget/u);
const b2bRouteStart = serverSource.indexOf('if (req.method === "POST" && reqUrl.pathname === "/api/b2b-search")');
const b2bRouteEnd = serverSource.indexOf('if (req.method === "POST" && reqUrl.pathname === "/api/b2b-my-lodge-collect")', b2bRouteStart);
assert.ok(b2bRouteStart >= 0 && b2bRouteEnd > b2bRouteStart);
const b2bSearchRoute = serverSource.slice(b2bRouteStart, b2bRouteEnd);
assert.doesNotMatch(b2bSearchRoute, /trustedPreviewAdminCrawlPayload|naverLegacyLimitedActivation/u);

console.log("NAVER legacy limited activation server contract fixtures passed.");
