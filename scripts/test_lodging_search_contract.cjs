"use strict";

const assert = require("node:assert/strict");
const regionMap = require("../web/data/tourism_region_map.json");
const {
  assertSupportedSearchIntent,
  resolveSearchIntentContract
} = require("./lodging_search_contract.cjs");

function plan(keyword, extra = {}) {
  return resolveSearchIntentContract({ keyword, searchIntentMode: "auto", ...extra }, { regionMap });
}

for (const [keyword, intent, mode, category] of [
  ["가평펜션", "region_search", "keyword", "pension"],
  ["경주 풀빌라", "region_search", "keyword", "poolVilla"],
  ["제주 독채스테이", "region_search", "keyword", "privateStay"],
  ["포천 글램핑", "region_search", "keyword", "glamping"],
  ["토리펜션", "company_search", "company", "pension"],
  ["가평 토리펜션", "company_in_region", "company", "pension"]
]) {
  const result = plan(keyword);
  assert.equal(result.resolvedIntent.intent, intent, keyword);
  assert.equal(result.resolvedSearchMode, mode, keyword);
  assert.equal(result.resolvedIntent.lodgingCategoryKey, category, keyword);
  assert.equal(result.intentSupported, true, keyword);
}

for (const keyword of ["스테이폴리오", "스테이폴리오 제주"]) {
  const result = plan(keyword);
  assert.equal(result.resolvedIntent.intent, "platform_search");
  assert.equal(result.intentSupported, false);
  assert.match(result.intentWarning, /수집 연결 전/);
  assert.throws(() => assertSupportedSearchIntent(result), /수집 연결 전/);
}

const ambiguous = plan("제주 스테이");
assert.equal(ambiguous.resolvedIntent.intent, "region_search");
assert.equal(ambiguous.resolvedSearchMode, "keyword");
assert.equal(ambiguous.selectedSearchCandidate.mode, "keyword");
assert.match(ambiguous.intentWarning, /신뢰도/);

const empty = plan("");
assert.equal(empty.resolvedIntent.intent, "unknown");
assert.equal(empty.intentSupported, false);
assert.throws(() => assertSupportedSearchIntent(empty));

const forged = plan("가평펜션", {
  productMode: "campnic",
  clientIntentPreview: { intent: "company_search", lodgingCategoryKey: "motel" }
});
assert.equal(forged.resolvedIntent.intent, "region_search");
assert.equal(forged.resolvedIntent.lodgingCategoryKey, "pension");
assert.equal(forged.resolvedSearchMode, "keyword");

const legacy = resolveSearchIntentContract({ keyword: "토리펜션", searchMode: "keyword" }, { regionMap });
assert.equal(legacy.requestedSearchIntentMode, "legacy");
assert.equal(legacy.resolvedSearchMode, "keyword");
assert.equal(legacy.intentSupported, true);

console.log("Lodging search contract tests passed");
