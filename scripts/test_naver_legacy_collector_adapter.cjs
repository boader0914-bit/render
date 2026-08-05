"use strict";

const assert = require("node:assert/strict");
const { installFixtureNetworkGuard } = require("./fixture_network_guard.cjs");
const {
  DEFAULT_NAVER_COLLECTOR_STRATEGY,
  MAX_PROVIDER_CALL_BUDGET,
  buildCollectorStrategyPlan,
  collectNaverPlaceSnapshot,
  compareCollectorSnapshots,
  legacyCompanySearchQueries,
  selectLegacyCompatibleResult
} = require("./naver_collector_strategy.cjs");
const {
  apolloHtml,
  createApolloFixture,
  fixtureProviderReservation,
  staticFixtureTransport
} = require("./naver_collector_fixture_factory.cjs");

const contract = Object.freeze({
  keyword: "Synthetic lodging",
  searchMode: "keyword",
  rankStart: 1,
  rankEnd: 50,
  regionKey: "kr_fixture_alpha",
  categoryKey: "glamping",
  measurementPeriod: Object.freeze({ start: "2026-08-01", end: "2026-08-05" })
});

async function expectCode(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, code);
    assert.doesNotMatch(error.message, /Synthetic lodging|https?:|cookie|authorization|query=/i);
    return true;
  });
}

async function main() {
  const guard = installFixtureNetworkGuard({ label: "NAVER legacy collector adapter fixtures" });
  try {
    assert.equal(DEFAULT_NAVER_COLLECTOR_STRATEGY, "current");
    const fixture = createApolloFixture({
      query: contract.keyword,
      items: [
        { id: "place-1", name: "First Lodge", category: "Lodging", roadAddress: "Road 1" },
        { id: "place-2", name: "Second Lodge", category: "Lodging", address: "Lot 2" }
      ]
    });
    const response = { status: 200, headers: { "content-type": "text/html" }, body: apolloHtml(fixture.state) };
    const currentTransport = staticFixtureTransport(response);
    const legacyTransport = staticFixtureTransport(response);

    const current = await collectNaverPlaceSnapshot({
      contract,
      asOf: "2026-08-05T08:00:00.000Z",
      fixtureMode: true,
      providerReservation: fixtureProviderReservation(),
      transport: currentTransport
    });
    const legacy = await collectNaverPlaceSnapshot({
      contract,
      strategy: "legacy_candidate",
      asOf: "2026-08-05T08:00:00.000Z",
      fixtureMode: true,
      allowLegacyCandidate: true,
      providerReservation: fixtureProviderReservation(),
      transport: legacyTransport
    });

    assert.equal(
      currentTransport.fixtureCallCount() + legacyTransport.fixtureCallCount(),
      2,
      "each explicit fixture comparison consumes exactly one injected response"
    );
    assert.equal(current.strategy, "current");
    assert.equal(legacy.strategy, "legacy_candidate");
    assert.equal(current.status, "ready");
    assert.equal(current.sampleCount, 2);
    assert.equal(current.items[0].address, "Road 1");
    assert.equal(current.items[1].address, "Lot 2");
    assert.equal(current.contractHash, legacy.contractHash);
    assert.notEqual(current.executionIdentityHash, legacy.executionIdentityHash);
    assert.equal(current.provenance.rankingContractVersion, "naver-place-rank-current.v2");
    assert.equal(legacy.provenance.rankingContractVersion, "naver-place-rank-legacy-exact50.v2");
    assert.equal(legacy.provenance.historicalSourceCommit, "4e4e1906e2967fe58df66f8ad67f832043d2763b");
    assert.equal(legacy.provenance.historicalCollectorBlob, "bcbe229998da3afa6f31ee04375fb0766019e56f");
    assert.equal(legacy.provenance.parserVersion, "apollo-safe-parser.v1");
    assert.equal(legacy.provenance.legacyParserReferenceUsed, false);
    assert.equal(legacy.provenance.legacyParserReferenceVersion, "4e4e190-parser-reference.v1");
    const comparison = compareCollectorSnapshots(current, legacy, { fixtureId: "equivalent-main-rank" });
    assert.equal(comparison.classification, "equivalent");
    assert.equal(comparison.sameContract, true);
    assert.equal(comparison.sameOrder, true);
    assert.equal(comparison.sameSampleCount, true);
    assert.equal(comparison.currentSampleCount, 2);
    assert.equal(comparison.legacySampleCount, 2);
    assert.deepEqual(comparison.onlyCurrent, []);
    assert.deepEqual(comparison.onlyLegacy, []);
    assert.equal(comparison.requestPlanningDifference, "none");
    assert.equal(comparison.parserDifference, "none");
    for (const snapshot of [current, legacy]) {
      const serialized = JSON.stringify(snapshot);
      assert.equal(snapshot.source, "naver_place_search");
      assert.equal(snapshot.regionKey, "kr_fixture_alpha");
      assert.deepEqual(snapshot.measurementPeriod, { start: "2026-08-01", end: "2026-08-05" });
      assert.equal(snapshot.observedAt, "2026-08-05T08:00:00.000Z");
      assert.match(snapshot.snapshotHash, /^[a-f0-9]{64}$/);
      assert.equal(Object.isFrozen(snapshot), true);
      assert.equal(Object.isFrozen(snapshot.provenance), true);
      assert.equal(Object.isFrozen(snapshot.coverage), true);
      assert.equal(snapshot.provenance.actualCallsEnabled, false);
      assert.equal(snapshot.provenance.fixtureOnly, true);
      assert.equal(snapshot.provenance.externalProviderAttemptCount, 0);
      assert.equal(snapshot.provenance.executedFixtureTransportCount, 1);
      assert.doesNotMatch(serialized, /Synthetic lodging|__APOLLO_STATE__|https?:|query=/i);
    }

    const emptyFixture = createApolloFixture({ query: contract.keyword, items: [], total: 0 });
    const empty = await collectNaverPlaceSnapshot({
      contract,
      fixtureMode: true,
      providerReservation: fixtureProviderReservation(),
      transport: staticFixtureTransport({ status: 200, body: apolloHtml(emptyFixture.state) })
    });
    assert.equal(empty.status, "zero");
    assert.equal(empty.sampleCount, 0);

    await expectCode(collectNaverPlaceSnapshot({
      contract,
      providerReservation: fixtureProviderReservation(),
      transport: staticFixtureTransport(response)
    }), "NAVER_COLLECTOR_STRATEGY_FIXTURE_ONLY");
    await expectCode(collectNaverPlaceSnapshot({
      contract,
      strategy: "legacy_candidate",
      fixtureMode: true,
      providerReservation: fixtureProviderReservation(),
      transport: staticFixtureTransport(response)
    }), "NAVER_LEGACY_STRATEGY_DISABLED");

    const plan = buildCollectorStrategyPlan({ contract });
    assert.equal(plan.strategy, "current");
    assert.equal(plan.callBudget, MAX_PROVIDER_CALL_BUDGET);
    assert.equal(plan.plannedRequestCount, 1);
    assert.equal(plan.executableRequestCount, 1);
    assert.equal(plan.requestDescriptors[0].requestOrdinal, 1);
    assert.equal(plan.requestDescriptors[0].queryRole, "primary");
    assert.match(plan.requestDescriptors[0].queryHash, /^[a-f0-9]{64}$/);
    assert.equal(plan.requestDescriptors[0].display, 50);
    assert.equal(plan.actualCallsEnabled, false);
    assert.equal(plan.externalCallOnRead, false);
    assert.equal("keyword" in plan, false);
    assert.equal("url" in plan, false);
    assert.doesNotMatch(JSON.stringify(plan), /Synthetic lodging|https?:|query=/i);

    const divergentContract = {
      ...contract,
      currentQueryCandidates: ["Current primary", "Current fallback"],
      legacyNaverQuery: "Legacy exact"
    };
    const currentPlan = buildCollectorStrategyPlan({ contract: divergentContract, strategy: "current" });
    const legacyPlan = buildCollectorStrategyPlan({ contract: divergentContract, strategy: "legacy_candidate" });
    assert.equal(currentPlan.candidateSequenceCount, 2);
    assert.equal(currentPlan.plannedRequestCount, 1);
    assert.equal(legacyPlan.plannedRequestCount, 1, "4e4 keyword mode plans NAVER_QUERY exactly once");
    assert.equal(legacyPlan.candidateSequenceCount, 1);
    assert.notEqual(currentPlan.requestDescriptors[0].queryHash, legacyPlan.requestDescriptors[0].queryHash);
    assert.equal(currentPlan.serviceGlobalProviderLockKey, legacyPlan.serviceGlobalProviderLockKey);
    assert.notEqual(currentPlan.strategySingleFlightKey, legacyPlan.strategySingleFlightKey);
    assert.doesNotMatch(JSON.stringify({ currentPlan, legacyPlan }), /Current primary|Current fallback|Legacy exact/i);

    const companyCandidates = legacyCompanySearchQueries("Synthetic Company");
    const companyPlan = buildCollectorStrategyPlan({
      strategy: "legacy_candidate",
      contract: { ...contract, keyword: "Synthetic Company", searchMode: "company" }
    });
    assert.equal(companyPlan.candidateSequenceCount, companyCandidates.length);
    assert.equal(companyPlan.plannedRequestCount, 1, "call budget one never plans a second provider request");
    assert.equal(companyPlan.requestDescriptors.length, 1);
    assert.equal(companyPlan.requestDescriptors[0].queryRole, "primary");
    assert.equal(companyPlan.candidateQueryHashes.length, companyCandidates.length);
    assert.doesNotMatch(JSON.stringify(companyPlan), /Synthetic Company/i);

    const missingLegacy = createApolloFixture({ query: "Different query", items: [] });
    assert.equal(selectLegacyCompatibleResult(missingLegacy.state, contract.keyword, { required: false }), null);
    assert.throws(
      () => selectLegacyCompatibleResult(missingLegacy.state, contract.keyword),
      (error) => error.code === "NAVER_SEARCH_CONTRACT_UNAVAILABLE"
    );

    const invalidBudgetTransport = staticFixtureTransport(response);
    await expectCode(collectNaverPlaceSnapshot({
      contract,
      callBudget: 2,
      fixtureMode: true,
      providerReservation: fixtureProviderReservation(),
      transport: invalidBudgetTransport
    }), "NAVER_COLLECTOR_CALL_BUDGET_INVALID");
    assert.equal(invalidBudgetTransport.fixtureCallCount(), 0);
    assert.equal(guard.blockedAttempts(), 0);
  } finally {
    guard.restore();
  }
  console.log("NAVER legacy collector adapter fixture tests passed.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
