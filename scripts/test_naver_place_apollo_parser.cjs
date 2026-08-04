"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  NaverPlaceParseError,
  extractApolloState,
  normalizeQuery,
  parseRootKey,
  selectNaverOrganicResult
} = require("./naver_place_apollo_parser.cjs");

const ROOT = path.resolve(__dirname, "..");
const CRAWLER_SOURCE = fs.readFileSync(path.join(ROOT, "scripts", "gyeongnam_glamping_crawl.cjs"), "utf8");

function operationKey(operation, input, extras = {}) {
  return `${operation}(${JSON.stringify({ input, ...extras })})`;
}

function stateWithResult({ operation = "accommodationSearch", query = "포천 글램핑", display = 50, items = [{ id: "place-1", name: "Fixture" }], total = items.length, inputExtras = {}, keyExtras = {}, containerKey } = {}) {
  const input = { query, ...inputExtras };
  if (display !== undefined) input.display = display;
  const key = operationKey(operation, input, keyExtras);
  const actualContainer = containerKey || (operation === "placeList" ? "businesses" : "business");
  const state = { ROOT_QUERY: {} };
  const refs = items.map((item, index) => {
    if (item?.inline) return { id: item.id, name: item.name };
    if (item?.missing) return { __ref: `Missing:${index}` };
    const ref = `Business:${index}`;
    state[ref] = item;
    return { __ref: ref };
  });
  state.ROOT_QUERY[key] = { [actualContainer]: { items: refs, total } };
  return { state, key };
}

function expectCode(fn, code) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof NaverPlaceParseError);
    assert.equal(error.code, code);
    assert.doesNotMatch(error.message, /포천|ROOT_QUERY|https?:|[A-Za-z]:[\\/]|\/opt\/|node:internal|\n\s*at\s/);
    return true;
  });
}

function main() {
  const originalFetch = global.fetch;
  global.fetch = () => { throw new Error("network access is forbidden in parser tests"); };
  try {
    for (const marker of ["window.__APOLLO_STATE__ = ", "window.__APOLLO_STATE__=", "__APOLLO_STATE__ = ", "__APOLLO_STATE__="]) {
      const fixture = stateWithResult();
      assert.deepEqual(extractApolloState(`<script>${marker}${JSON.stringify(fixture.state)};</script>`), fixture.state);
    }
    expectCode(() => extractApolloState("<html>no state</html>"), "NAVER_APOLLO_STATE_MISSING");
    expectCode(() => extractApolloState("window.__APOLLO_STATE__={broken"), "NAVER_APOLLO_STATE_INVALID");
    expectCode(() => extractApolloState("window.__APOLLO_STATE__=[]"), "NAVER_APOLLO_STATE_INVALID");

    assert.equal(normalizeQuery("  포천   글램핑  "), "포천 글램핑");
    assert.equal(normalizeQuery("포천"), "포천");
    assert.equal(parseRootKey(operationKey("placeList", { query: "q" })).operation, "placeList");
    assert.equal(parseRootKey("bad-key"), null);

    for (const display of [10, 20, 30, 50, 70, undefined]) {
      const fixture = stateWithResult({ display: display === undefined ? null : display });
      const result = selectNaverOrganicResult(fixture.state, "포천 글램핑");
      assert.equal(result.key, fixture.key);
      assert.equal(result.items[0].id, "place-1");
      assert.equal(result.display, display ?? null);
    }

    const normalizedFixture = stateWithResult({ query: "포천   글램핑" });
    assert.equal(selectNaverOrganicResult(normalizedFixture.state, "  포천 글램핑 ").items.length, 1);

    const placeListFixture = stateWithResult({ operation: "placeList", display: 20 });
    const placeList = selectNaverOrganicResult(placeListFixture.state, "포천 글램핑");
    assert.equal(placeList.type, "placeList");
    assert.equal(placeList.containerKey, "businesses");

    const both = stateWithResult({ operation: "placeList" });
    const accommodation = stateWithResult({ operation: "accommodationSearch" });
    Object.assign(both.state.ROOT_QUERY, accommodation.state.ROOT_QUERY);
    Object.assign(both.state, Object.fromEntries(Object.entries(accommodation.state).filter(([key]) => key !== "ROOT_QUERY")));
    assert.equal(selectNaverOrganicResult(both.state, "포천 글램핑").type, "accommodationSearch");

    const inline = stateWithResult({ items: [{ id: "inline-1", name: "Inline", inline: true }] });
    const inlineResult = selectNaverOrganicResult(inline.state, "포천 글램핑");
    assert.equal(inlineResult.items.length, 1);
    assert.equal(inlineResult.items[0].id, "inline-1");
    assert.equal(inlineResult.malformedItemCount, 0);

    const onlyMissing = stateWithResult({ items: [{ missing: true }], total: 1 });
    expectCode(() => selectNaverOrganicResult(onlyMissing.state, "포천 글램핑"), "NAVER_SEARCH_CONTRACT_UNAVAILABLE");
    const partiallyMissing = stateWithResult({ items: [{ id: "valid" }, { missing: true }], total: 2 });
    expectCode(() => selectNaverOrganicResult(partiallyMissing.state, "포천 글램핑"), "NAVER_SEARCH_CONTRACT_UNAVAILABLE");

    const empty = stateWithResult({ items: [], total: 0 });
    const emptyResult = selectNaverOrganicResult(empty.state, "포천 글램핑");
    assert.equal(emptyResult.items.length, 0);
    assert.equal(emptyResult.total, 0);

    const unknownTotal = stateWithResult({ total: "unknown" });
    const unknownTotalResult = selectNaverOrganicResult(unknownTotal.state, "포천 글램핑");
    assert.equal(unknownTotalResult.total, 1);
    assert.equal(unknownTotalResult.totalKnown, false);

    const filtered = stateWithResult({ keyExtras: { filterOpening: true } });
    expectCode(() => selectNaverOrganicResult(filtered.state, "포천 글램핑"), "NAVER_SEARCH_CONTRACT_UNAVAILABLE");
    const invalidDisplay = stateWithResult({ display: 1000 });
    expectCode(() => selectNaverOrganicResult(invalidDisplay.state, "포천 글램핑"), "NAVER_SEARCH_CONTRACT_UNAVAILABLE");
    const queryMismatch = stateWithResult({ query: "가평 글램핑" });
    expectCode(() => selectNaverOrganicResult(queryMismatch.state, "포천 글램핑"), "NAVER_SEARCH_CONTRACT_UNAVAILABLE");
    assert.equal(selectNaverOrganicResult(queryMismatch.state, "포천 글램핑", { required: false }), null);

    const malformedRoot = { ROOT_QUERY: { [operationKey("accommodationSearch", { query: "포천 글램핑", display: 20 })]: { unrelated: { items: [] } } } };
    expectCode(() => selectNaverOrganicResult(malformedRoot, "포천 글램핑"), "NAVER_SEARCH_CONTRACT_UNAVAILABLE");

    const firstPage = stateWithResult({ display: 20, items: [], total: 0, inputExtras: { start: 1 } });
    const cachedSecondPage = stateWithResult({ display: 20, items: [{ id: "page-2", inline: true }], total: 1, inputExtras: { start: 51 } });
    Object.assign(firstPage.state.ROOT_QUERY, cachedSecondPage.state.ROOT_QUERY);
    assert.equal(selectNaverOrganicResult(firstPage.state, "포천 글램핑").items.length, 0, "cached later pages cannot be relabelled as rank 1");
    const invalidNegativePage = stateWithResult({ inputExtras: { start: -1 } });
    expectCode(() => selectNaverOrganicResult(invalidNegativePage.state, "포천 글램핑"), "NAVER_SEARCH_CONTRACT_UNAVAILABLE");

    const ambiguousA = stateWithResult({ display: 20, items: [{ id: "a", inline: true }], keyExtras: { sort: "a" } });
    const ambiguousB = stateWithResult({ display: 20, items: [{ id: "b", inline: true }], keyExtras: { sort: "b" } });
    Object.assign(ambiguousA.state.ROOT_QUERY, ambiguousB.state.ROOT_QUERY);
    Object.assign(ambiguousA.state, Object.fromEntries(Object.entries(ambiguousB.state).filter(([key]) => key !== "ROOT_QUERY")));
    expectCode(() => selectNaverOrganicResult(ambiguousA.state, "포천 글램핑"), "NAVER_SEARCH_AMBIGUOUS");

    assert.doesNotMatch(CRAWLER_SOURCE, /display\s*===\s*50/);
    assert.match(CRAWLER_SOURCE, /selectNaverOrganicResult\(state, query, \{ allowPlaceList: true/);
    assert.ok((CRAWLER_SOURCE.match(/selectNaverOrganicResult\(state, query, \{ allowPlaceList: true, required: false \}\)/g) || []).length >= 2, "main and regional collection share a soft-select parser before their own failure policy");
    assert.doesNotMatch(CRAWLER_SOURCE, /Naver main search key not found/);
  } finally {
    global.fetch = originalFetch;
  }
  console.log("Naver Place Apollo parser contract tests passed.");
}

main();
