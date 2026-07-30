"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const regionMap = require(path.join(__dirname, "..", "web", "data", "tourism_region_map.json"));
const { resolveLodgingSearchIntent } = require("./lodging_search_intent.cjs");

function resolve(keyword) {
  return resolveLodgingSearchIntent(keyword, { regionMap });
}

function expect(keyword, expected) {
  const actual = resolve(keyword);
  for (const [key, value] of Object.entries(expected)) {
    if (key === "region") assert.match(actual.region?.canonicalName || "", value, keyword);
    else assert.equal(actual[key], value, keyword);
  }
  return actual;
}

expect("가평펜션", { intent: "region_search", region: /가평군/, lodgingCategoryKey: "pension", companyName: "" });
expect("경주 풀빌라", { intent: "region_search", region: /경주시/, lodgingCategoryKey: "poolVilla" });
expect("제주 독채스테이", { intent: "region_search", region: /제주/, lodgingCategoryKey: "privateStay" });
expect("포천 글램핑", { intent: "region_search", region: /포천시/, lodgingCategoryKey: "glamping" });
expect("토리펜션", { intent: "company_search", lodgingCategoryKey: "pension", companyName: "토리펜션" });
expect("가평 토리펜션", { intent: "company_in_region", region: /가평군/, lodgingCategoryKey: "pension", companyName: "토리펜션" });
expect("스테이폴리오", { intent: "platform_search", platformKey: "stayfolio", lodgingCategoryKey: "" });
expect("스테이폴리오 제주", { intent: "platform_search", platformKey: "stayfolio", region: /제주/ });
expect("제주 숙소", { intent: "region_search", region: /제주/, lodgingCategoryKey: "" });

const ambiguousJejuStay = expect("제주 스테이", { intent: "region_search", region: /제주/, lodgingCategoryKey: "" });
assert.equal(ambiguousJejuStay.searchCandidates.length, 2);
assert.ok(ambiguousJejuStay.confidence < 0.8);

expect("스테이 123", { intent: "company_search", lodgingCategoryKey: "", companyName: "스테이123" });
expect("서울호텔", { intent: "region_search", region: /서울/, lodgingCategoryKey: "hotelResort" });
expect("부산 카라반", { intent: "region_search", region: /부산/, lodgingCategoryKey: "caravan" });
expect("가평달빛애견펜션", { intent: "company_in_region", region: /가평군/, lodgingCategoryKey: "pension", companyName: "달빛애견펜션" });
expect("제주풀빌라바다", { intent: "company_in_region", region: /제주/, lodgingCategoryKey: "poolVilla", companyName: "풀빌라바다" });
expect("온담스테이", { intent: "company_search", lodgingCategoryKey: "", companyName: "온담스테이" });

const unknown = expect("푸른달언덕", { intent: "company_search", lodgingCategoryKey: "", companyName: "푸른달언덕" });
assert.equal(unknown.searchCandidates.length, 2);
assert.ok(unknown.confidence < 0.8);

for (const empty of ["", "   ", null, undefined]) {
  const result = resolve(empty);
  assert.equal(result.intent, "unknown");
  assert.equal(result.confidence, 0);
  assert.deepEqual(result.searchCandidates, []);
}

const glampingRegression = resolve("경남글램핑");
assert.equal(glampingRegression.intent, "region_search");
assert.equal(glampingRegression.lodgingCategoryKey, "glamping");
assert.match(glampingRegression.region?.canonicalName || "", /경상남도/);

console.log("Lodging search intent tests passed");
