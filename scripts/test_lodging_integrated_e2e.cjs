"use strict";
const assert = require("node:assert/strict");
global.fetch = (url) => { throw new Error(`External network forbidden: ${url}`); };
const regionMap = require("../web/data/tourism_region_map.json");
const { resolveSearchIntentContract } = require("./lodging_search_contract.cjs");
const { createLodgingSearchContext, decorateLodgingResult } = require("./lodging_collection_context.cjs");
const { applyObservationToCompany, decideCompanyMatch, standardizeCompanyObservation } = require("./lodging_company_identity.cjs");
const { categorySummary, normalizeCompanyCategory } = require("./lodging_category_profile.cjs");
const { assertFixtureMode, collectorEnvFromPlan } = require("./lodging_e2e_fixture.cjs");

assert.throws(() => assertFixtureMode({ NODE_ENV: "production", LODGING_E2E_FIXTURE_MODE: "1" }), /only/);
assert.throws(() => assertFixtureMode({ NODE_ENV: "test", LODGING_E2E_FIXTURE_MODE: "1", V2_PREVIEW_DATA_ROOT: "/var/data/v2-preview-runtime" }), /blocked/);
assert.equal(assertFixtureMode({ NODE_ENV: "test", LODGING_E2E_FIXTURE_MODE: "1" }), true);

function plan(keyword, productMode = "lodging", preview = {}) {
  const contract = resolveSearchIntentContract({ keyword, productMode, searchIntentMode: "auto", clientIntentPreview: preview }, { regionMap });
  return { keyword, productMode, ...contract };
}
function contextFromPlan(value) {
  const intent = value.resolvedIntent;
  return createLodgingSearchContext({
    originalKeyword: value.keyword, intent: intent.intent, regionKey: intent.region?.key, regionQuery: intent.region?.query,
    companyName: intent.companyName, lodgingCategoryKey: intent.lodgingCategoryKey, selectedCandidate: value.selectedSearchCandidate
  });
}

const cases = [
  ["가평펜션", "region_search", "pension"], ["경주 풀빌라", "region_search", "poolVilla"],
  ["제주 독채스테이", "region_search", "privateStay"], ["포천 글램핑", "region_search", "glamping"],
  ["부산 카라반", "region_search", "caravan"], ["토리펜션", "company_search", "pension"],
  ["가평 토리펜션", "company_in_region", "pension"]
];
for (const [keyword, intent, categoryKey] of cases) {
  const estimate = plan(keyword);
  const execution = plan(keyword, "lodging", { intent: "platform_search", lodgingCategoryKey: "glamping" });
  assert.equal(estimate.resolvedIntent.intent, intent, keyword);
  assert.equal(estimate.resolvedIntent.lodgingCategoryKey, categoryKey, keyword);
  assert.deepEqual(execution.resolvedIntent, estimate.resolvedIntent, `${keyword}: forged preview ignored`);
  assert.equal(execution.resolvedSearchMode, estimate.resolvedSearchMode);
  const context = contextFromPlan(execution);
  assert.ok(context.primaryQuery);
  const env = collectorEnvFromPlan(execution);
  assert.equal(env.PRODUCT_MODE, "lodging");
  assert.equal(env.LODGING_CATEGORY_KEY, categoryKey);
  assert.equal(env.SEARCH_INTENT, intent);
}
assert.equal(plan("스테이폴리오").resolvedIntent.intent, "platform_search");
assert.equal(plan("스테이폴리오 제주").resolvedIntent.lodgingCategoryKey, "");
assert.equal(plan("제주 스테이").resolvedIntent.lodgingCategoryKey, "");
assert.equal(plan("스테이 123").resolvedIntent.lodgingCategoryKey, "");
assert.equal(plan("").intentSupported, false);
assert.equal(plan("   ").intentSupported, false);
const campnic = plan("포천 글램핑", "campnic");
assert.equal(campnic.productMode, "campnic");
assert.equal(campnic.resolvedIntent.lodgingCategoryKey, "glamping");

const poolPlan = plan("경주 풀빌라");
const poolContext = contextFromPlan(poolPlan);
const poolVilla = decorateLodgingResult({ name: "경주 블루 풀빌라펜션", address: "경상북도 경주시 보문로 10", category: "풀빌라 펜션" }, poolContext, poolContext.primaryQuery);
const hotel = decorateLodgingResult({ name: "경주 블루 호텔", address: "경상북도 경주시 보문로 20", category: "호텔", description: "수영장 보유" }, poolContext, poolContext.primaryQuery);
assert.equal(poolVilla.relevanceStatus, "matched");
assert.ok(poolVilla.detectedLodgingCategoryTags.includes("poolVilla"));
assert.equal(hotel.relevanceStatus, "rejected");
const stayPlan = plan("제주 독채스테이");
const stayContext = contextFromPlan(stayPlan);
assert.equal(decorateLodgingResult({ name: "제주 봄날 독채스테이", address: "제주특별자치도 제주시", category: "독채스테이" }, stayContext).relevanceStatus, "matched");
assert.notEqual(decorateLodgingResult({ name: "스테이폴리오 제주", address: "제주특별자치도 제주시", category: "플랫폼" }, stayContext).detectedLodgingCategoryKey, "privateStay");

const observed = standardizeCompanyObservation({ sourcePlatform: "naver", sourceId: "place-1", name: poolVilla.name, address: poolVilla.address, region: "경주", detectedCategoryKey: "poolVilla", categoryTags: ["poolVilla", "pension"], categoryConfidence: 0.94, categoryEvidence: poolVilla.categoryEvidence, observedAt: "2026-07-30T00:00:00Z", headers: { cookie: "drop" }, clientIntentPreview: { forged: true } });
const base = { companyId: "cmp-1", primaryName: poolVilla.name, addresses: [poolVilla.address], regions: ["경주"], placeIds: ["place-1"], createdAt: "2026-07-01T00:00:00Z", customUserField: "keep" };
assert.equal(decideCompanyMatch(observed, [base]).decision, "merge");
const once = applyObservationToCompany(base, observed);
const twice = applyObservationToCompany(once.company, observed);
assert.equal(twice.changed, false);
assert.equal(once.company.customUserField, "keep");
assert.equal("headers" in once.company, false);
assert.equal("clientIntentPreview" in once.company, false);
assert.deepEqual(once.company.categoryTags, ["poolVilla", "pension"]);
const manual = applyObservationToCompany({ ...once.company, manualCorrection: { primaryCategoryKey: "pension", categoryTags: ["pension"], categoryNote: "현장 확인", note: "기존 메모" } }, observed).company;
assert.equal(normalizeCompanyCategory(manual).primaryCategoryKey, "pension");
assert.equal(manual.manualCorrection.note, "기존 메모");
const summary = categorySummary([manual, { primaryCategoryKey: "glamping", categoryTags: ["glamping", "caravan"], sourcePlatforms: ["ddnayo"] }]);
assert.equal(Object.values(summary.primaryCounts).reduce((sum, value) => sum + value, 0), 2);
assert.equal(summary.tagCounts.pension, 1);
assert.equal(summary.tagCounts.poolVilla, 1);
console.log("Integrated lodging search E2E fixtures passed without provider calls or company-master I/O");
