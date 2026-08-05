"use strict";

const assert = require("node:assert/strict");
const { installFixtureNetworkGuard } = require("./fixture_network_guard.cjs");
const {
  collectNaverPlaceSnapshot,
  compareCollectorSnapshots,
  selectLegacyCompatibleResult
} = require("./naver_collector_strategy.cjs");
const {
  apolloHtml,
  createApolloFixture,
  fixtureProviderReservation,
  staticFixtureTransport
} = require("./naver_collector_fixture_factory.cjs");

function contract(keyword = "Comparison lodging", searchMode = "keyword", overrides = {}) {
  return {
    keyword,
    searchMode,
    rankStart: 1,
    rankEnd: 50,
    regionKey: "kr_fixture_comparison",
    categoryKey: "glamping",
    measurementPeriod: { start: "2026-08-01", end: "2026-08-05" },
    ...overrides
  };
}

async function collect(strategy, state, options = {}) {
  return collectNaverPlaceSnapshot({
    contract: options.contract || contract(options.query || "Comparison lodging", options.searchMode || "keyword"),
    strategy,
    asOf: "2026-08-05T08:00:00.000Z",
    fixtureMode: true,
    allowLegacyCandidate: strategy === "legacy_candidate",
    providerReservation: fixtureProviderReservation(),
    transport: staticFixtureTransport({
      status: 200,
      headers: { "content-type": "text/html" },
      body: apolloHtml(state, options.marker)
    })
  });
}

async function expectCode(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, code);
    return true;
  });
}

async function main() {
  const guard = installFixtureNetworkGuard({ label: "NAVER collector comparison fixtures" });
  try {
    const base = createApolloFixture({
      query: "Comparison lodging",
      items: [
        { id: "place-1", name: "First", category: "Lodging", roadAddress: "Road 1" },
        { id: "place-2", name: "Second", category: "Lodging", jibunAddress: "Lot 2" }
      ],
      page: 1
    });
    createApolloFixture({
      state: base.state,
      query: "Comparison lodging",
      items: [{ id: "place-99", name: "Second page" }],
      display: 50,
      page: 2
    });
    createApolloFixture({
      state: base.state,
      operation: "adBusinesses",
      query: "Comparison lodging",
      items: [{ id: "ad-place-1", name: "Sponsored fixture", category: "Lodging" }],
      inputExtras: { businessType: "accommodation" }
    });
    const current = await collect("current", base.state);
    const legacy = await collect("legacy_candidate", base.state);
    assert.deepEqual(current.items.map((item) => item.placeId), ["place-1", "place-2"]);
    assert.deepEqual(legacy.items.map((item) => item.placeId), ["place-1", "place-2"]);
    assert.equal(current.adCount, 1);
    assert.equal(legacy.adCount, 1);
    assert.equal(current.adItems[0].placeId, "ad-place-1");
    const baseComparison = compareCollectorSnapshots(current, legacy, { fixtureId: "base-with-ad" });
    assert.equal(baseComparison.sameOrder, true);
    assert.equal(baseComparison.classification, "equivalent");
    assert.deepEqual(baseComparison.adCount, { current: 1, legacy: 1 });
    assert.equal(baseComparison.executedTransportCount.current, 1);
    assert.equal(baseComparison.executedTransportCount.legacy, 1);
    assert.doesNotMatch(JSON.stringify(baseComparison), /Comparison lodging|Sponsored fixture|https?:|query=/i);

    const fifty = createApolloFixture({
      query: "Comparison lodging",
      items: Array.from({ length: 50 }, (unused, index) => ({
        id: `rank-${String(index + 1).padStart(2, "0")}`,
        name: `Synthetic rank ${index + 1}`,
        address: `Synthetic address ${index + 1}`
      }))
    });
    const reversedRootState = {
      ...fifty.state,
      ROOT_QUERY: Object.fromEntries(Object.entries(fifty.state.ROOT_QUERY).reverse())
    };
    const fiftyCurrent = await collect("current", reversedRootState);
    const fiftyLegacy = await collect("legacy_candidate", reversedRootState);
    assert.equal(fiftyCurrent.sampleCount, 50);
    assert.equal(fiftyLegacy.sampleCount, 50);
    assert.equal(fiftyCurrent.items[49].rank, 50);
    assert.equal(compareCollectorSnapshots(fiftyCurrent, fiftyLegacy).classification, "equivalent");

    const flexible = createApolloFixture({
      query: "Comparison lodging",
      display: 20,
      items: [{ id: "place-flex", name: "Flexible display" }]
    });
    const flexibleCurrent = await collect("current", flexible.state);
    const flexibleLegacySafe = await collect("legacy_candidate", flexible.state);
    assert.equal(flexibleCurrent.items[0].placeId, "place-flex");
    assert.equal(flexibleLegacySafe.items[0].placeId, "place-flex");
    assert.throws(
      () => selectLegacyCompatibleResult(flexible.state, "Comparison lodging"),
      (error) => error.code === "NAVER_SEARCH_CONTRACT_UNAVAILABLE"
    );

    const duplicate = createApolloFixture({
      query: "Comparison lodging",
      items: [
        { id: "place-dup", name: "Same", address: "Same address" },
        { id: "place-dup", name: "Same", address: "Same address" }
      ]
    });
    const deduplicated = await collect("current", duplicate.state);
    assert.equal(deduplicated.sampleCount, 1);
    assert.equal(deduplicated.items[0].rank, 1);

    const conflict = createApolloFixture({
      query: "Comparison lodging",
      items: [
        { id: "place-conflict", name: "First identity", address: "Address" },
        { id: "place-conflict", name: "Conflicting identity", address: "Address" }
      ]
    });
    await expectCode(collect("current", conflict.state), "NAVER_PLACE_ID_CONFLICT");
    await expectCode(collect("legacy_candidate", conflict.state), "NAVER_PLACE_ID_CONFLICT");

    const malformed = createApolloFixture({
      query: "Comparison lodging",
      items: [{ id: "place-ok", name: "Valid" }, { missing: true }]
    });
    await expectCode(collect("current", malformed.state), "NAVER_SEARCH_CONTRACT_UNAVAILABLE");
    await expectCode(collect("legacy_candidate", malformed.state), "NAVER_SEARCH_CONTRACT_UNAVAILABLE");
    assert.throws(
      () => selectLegacyCompatibleResult(malformed.state, "Comparison lodging"),
      (error) => error.code === "NAVER_LEGACY_RESULT_INVALID"
    );

    for (const invalidItem of [
      { id: { nested: "place" }, name: "Invalid ID" },
      { id: "place-object-name", name: { nested: "name" } },
      { id: "place-control", name: "Invalid\u0000Name" },
      { id: "place-object-address", name: "Invalid address", address: { nested: "address" } }
    ]) {
      const invalidItemFixture = createApolloFixture({
        query: "Comparison lodging",
        items: [invalidItem]
      });
      await expectCode(collect("current", invalidItemFixture.state), "NAVER_PLACE_ITEM_INVALID");
      await expectCode(collect("legacy_candidate", invalidItemFixture.state), "NAVER_PLACE_ITEM_INVALID");
    }

    const ambiguous = createApolloFixture({
      query: "Comparison lodging",
      items: [{ id: "place-a", name: "A" }]
    });
    createApolloFixture({
      state: ambiguous.state,
      query: "Comparison lodging",
      items: [{ id: "place-b", name: "B" }],
      display: 50,
      inputExtras: { deviceType: "mobile" }
    });
    await expectCode(collect("current", ambiguous.state), "NAVER_SEARCH_AMBIGUOUS");
    await expectCode(collect("legacy_candidate", ambiguous.state), "NAVER_SEARCH_AMBIGUOUS");

    const company = createApolloFixture({
      operation: "placeList",
      query: "Exact Company",
      items: [{ id: "company-place", name: "Exact Company" }]
    });
    const companyLegacy = await collect("legacy_candidate", company.state, {
      query: "Exact Company",
      searchMode: "company",
      marker: "__APOLLO_STATE__="
    });
    assert.equal(companyLegacy.items[0].placeId, "company-place");
    await expectCode(collect("legacy_candidate", company.state, {
      query: "Exact Company",
      searchMode: "keyword"
    }), "NAVER_SEARCH_CONTRACT_UNAVAILABLE");

    const companyAdsOnly = createApolloFixture({
      operation: "adBusinesses",
      query: "Ad Only Company",
      businessType: "place",
      items: [{ id: "ad-only-place", name: "Ad Only Company" }]
    });
    const adOnlyLegacy = await collect("legacy_candidate", companyAdsOnly.state, {
      query: "Ad Only Company",
      searchMode: "company"
    });
    assert.equal(adOnlyLegacy.status, "partial");
    assert.equal(adOnlyLegacy.sampleCount, 0);
    assert.equal(adOnlyLegacy.adCount, 1);
    assert.deepEqual(adOnlyLegacy.penalties, ["organic_contract_missing"]);

    const divergentContract = contract("Original synthetic input", "keyword", {
      currentQueryCandidates: ["Current primary", "Current fallback"],
      legacyNaverQuery: "Legacy exact"
    });
    const currentQueryFixture = createApolloFixture({
      query: "Current primary",
      items: [{ id: "same-place", name: "Same normalized result", address: "Synthetic road" }]
    });
    const legacyQueryFixture = createApolloFixture({
      query: "Legacy exact",
      items: [{ id: "same-place", name: "Same normalized result", address: "Synthetic road" }]
    });
    const divergentCurrent = await collect("current", currentQueryFixture.state, { contract: divergentContract });
    const divergentLegacy = await collect("legacy_candidate", legacyQueryFixture.state, { contract: divergentContract });
    const planDifference = compareCollectorSnapshots(divergentCurrent, divergentLegacy, {
      fixtureId: "query-plan-difference"
    });
    assert.equal(planDifference.classification, "query_plan_difference");
    assert.equal(planDifference.requestPlanningDifference, "primary_or_candidate_sequence_differs");
    assert.equal(planDifference.parserDifference, "none");
    assert.deepEqual(planDifference.plannedRequestCount, { current: 1, legacy: 1 });
    assert.equal(planDifference.currentPlan.candidateSequenceCount, 2);
    assert.equal(planDifference.legacyPlan.candidateSequenceCount, 1);
    assert.notEqual(planDifference.currentPlan.queryHash, planDifference.legacyPlan.queryHash);
    assert.doesNotMatch(JSON.stringify(planDifference), /Current primary|Current fallback|Legacy exact|Original synthetic input/i);

    assert.equal(guard.blockedAttempts(), 0);
  } finally {
    guard.restore();
  }
  console.log("NAVER collector fixture comparison tests passed.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
