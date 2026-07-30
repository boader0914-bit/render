"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
global.fetch = () => { throw new Error("Network calls are forbidden in lodging collection fixture tests"); };

const {
  collectionContextFromEnv,
  createLodgingSearchContext,
  decorateLodgingResult,
  detectLodgingCategories,
  evaluateLodgingRelevance
} = require("./lodging_collection_context.cjs");

function region(keyword, regionQuery, categoryKey) {
  return createLodgingSearchContext({ originalKeyword: keyword, intent: "region_search", regionQuery, lodgingCategoryKey: categoryKey });
}

assert.equal(region("가평펜션", "가평", "pension").primaryQuery, "가평 펜션");
assert.equal(region("경주 풀빌라", "경주", "poolVilla").primaryQuery, "경주 풀빌라");
assert.equal(region("제주 독채스테이", "제주", "privateStay").primaryQuery, "제주 독채스테이");
assert.equal(region("포천 글램핑", "포천", "glamping").primaryQuery, "포천 글램핑");

const company = createLodgingSearchContext({ originalKeyword: "토리펜션", intent: "company_search", companyName: "토리펜션", lodgingCategoryKey: "pension" });
assert.equal(company.primaryQuery, "토리펜션");
assert.deepEqual(company.platformQueries.naver, ["토리펜션"]);

const companyInRegion = createLodgingSearchContext({ originalKeyword: "가평 토리펜션", intent: "company_in_region", regionQuery: "가평", companyName: "토리펜션", lodgingCategoryKey: "pension" });
assert.equal(companyInRegion.primaryQuery, "가평 토리펜션");
assert.ok(companyInRegion.fallbackQueries.includes("토리펜션"));

const ambiguous = createLodgingSearchContext({ originalKeyword: "제주 스테이", intent: "region_search", regionQuery: "제주", selectedCandidate: { mode: "keyword", query: "제주 스테이" } });
assert.equal(ambiguous.primaryQuery, "제주 스테이");
assert.equal(ambiguous.categoryKey, "");

const legacy = createLodgingSearchContext({ originalKeyword: "경북글램핑" });
assert.equal(legacy.primaryQuery, "경북글램핑");
assert.equal(legacy.categoryKey, "");

const envContext = collectionContextFromEnv({
  SEARCH_INTENT: "company_in_region",
  LODGING_CATEGORY_KEY: "pension",
  SEARCH_REGION_KEY: "kr_gyeonggi_gapyeong",
  SEARCH_REGION_QUERY: "가평",
  SEARCH_COMPANY_NAME: "토리펜션",
  SEARCH_CANDIDATE_MODE: "company",
  SEARCH_CANDIDATE_QUERY: "가평 토리펜션"
}, "가평 토리펜션");
assert.equal(envContext.primaryQuery, "가평 토리펜션");
assert.equal(envContext.categoryKey, "pension");
assert.equal(envContext.regionKey, "kr_gyeonggi_gapyeong");

const fixtures = {
  naver: [
    { name: "가평 숲속 키즈펜션", category: "펜션", location: "경기도 가평군" },
    { name: "경주 라온 풀빌라펜션", category: "펜션", location: "경상북도 경주시" },
    { name: "제주 온담 독채스테이", category: "독채숙소", location: "제주특별자치도" },
    { name: "포천 별빛 글램핑", category: "캠핑, 야영장", location: "경기도 포천시" }
  ],
  nol: [
    { name: "가평 리버펜션", category: "펜션", location: "가평군", ad_flag: "Y", rank_or_order: 1 },
    { name: "부산 오션펜션", category: "펜션", location: "부산", ad_flag: "N", rank_or_order: 2 },
    { name: "가평 비즈니스호텔", category: "호텔", location: "가평군", ad_flag: "N", rank_or_order: 3 }
  ],
  ddnayo: [
    { name: "경주 블루 풀빌라", category: "풀빌라", location: "경주시" },
    { name: "경주 블루 풀빌라펜션", category: "펜션", location: "경주시" },
    { name: "서울 수영장 호텔", category: "호텔", description: "수영장", location: "서울" },
    { name: "제주 한옥스테이", category: "독채", location: "제주" }
  ]
};

assert.equal(evaluateLodgingRelevance(fixtures.naver[0], region("가평펜션", "가평", "pension")).relevant, true);
assert.equal(evaluateLodgingRelevance(fixtures.nol[1], region("가평펜션", "가평", "pension")).relevant, false);
assert.equal(evaluateLodgingRelevance(fixtures.nol[2], region("가평펜션", "가평", "pension")).relevant, false);
assert.equal(evaluateLodgingRelevance(fixtures.ddnayo[0], region("경주풀빌라", "경주", "poolVilla")).relevant, true);
assert.equal(evaluateLodgingRelevance(fixtures.ddnayo[1], region("경주풀빌라", "경주", "poolVilla")).relevant, true);
assert.equal(evaluateLodgingRelevance(fixtures.ddnayo[2], region("서울풀빌라", "서울", "poolVilla")).relevant, false);
assert.equal(evaluateLodgingRelevance(fixtures.ddnayo[3], region("제주독채스테이", "제주", "privateStay")).relevant, true);

for (const value of ["스테이폴리오 제주", "호텔스테이", "스테이 123"]) {
  assert.notEqual(detectLodgingCategories({ name: value }).primaryCategoryKey, "privateStay", value);
}
assert.equal(detectLodgingCategories({ name: "제주 독채스테이" }).primaryCategoryKey, "privateStay");
assert.equal(detectLodgingCategories({ name: "경주 한옥스테이" }).primaryCategoryKey, "privateStay");
assert.equal(detectLodgingCategories({ name: "가평 풀빌라펜션" }).primaryCategoryKey, "poolVilla");
assert.ok(detectLodgingCategories({ name: "가평 풀빌라펜션" }).categoryTags.includes("pension"));
assert.equal(detectLodgingCategories({ name: "포천 글램핑" }).primaryCategoryKey, "glamping");
assert.equal(detectLodgingCategories({ name: "양평 오토캠핑장" }).primaryCategoryKey, "campground");
assert.equal(detectLodgingCategories({ name: "강화 카라반" }).primaryCategoryKey, "caravan");

const decorated = decorateLodgingResult(fixtures.nol[0], region("가평펜션", "가평", "pension"), "가평 펜션");
assert.equal(decorated.requestedLodgingCategoryKey, "pension");
assert.equal(decorated.detectedLodgingCategoryKey, "pension");
assert.equal(decorated.relevanceStatus, "matched");
assert.equal(decorated.ad_flag, "Y");
assert.equal(decorated.rank_or_order, 1);
assert.equal(decorated.sourceQuery, "가평 펜션");

const serverSource = fs.readFileSync(path.join(__dirname, "glamping_app_server.cjs"), "utf8");
const crawlerSource = fs.readFileSync(path.join(__dirname, "gyeongnam_glamping_crawl.cjs"), "utf8");
for (const key of [
  "SEARCH_INTENT", "SEARCH_INTENT_CONFIDENCE", "LODGING_CATEGORY_KEY", "SEARCH_REGION_KEY",
  "SEARCH_REGION_QUERY", "SEARCH_COMPANY_NAME", "SEARCH_PLATFORM_KEY", "SEARCH_CANDIDATE_MODE"
]) {
  assert.match(serverSource, new RegExp(`${key}:`), key);
}
assert.match(crawlerSource, /collectionContextFromEnv/);
assert.match(crawlerSource, /filterCollectionRows\(rawRows, QUERY/);
assert.match(crawlerSource, /filterCollectionRows\(rawRows, usedQuery/);
assert.match(crawlerSource, /COLLECTION_SEARCH_CONTEXT\.platformQueries\.naver/);

console.log("Lodging collection context fixture tests passed without network calls");
