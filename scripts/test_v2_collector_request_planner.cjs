"use strict";

const assert = require("node:assert/strict");
const { installFixtureNetworkGuard } = require("./fixture_network_guard.cjs");
const {
  OTA_REQUEST_DESCRIPTORS,
  buildV2CollectorCompatibilityRequestPlan
} = require("./v2_collector_compatibility.cjs");

function contract() {
  return {
    keyword: "Synthetic region lodging",
    searchMode: "keyword",
    collectionMode: "precision",
    collectionPurpose: "revenue_detail",
    productMode: "all",
    checkIn: "2026-08-06",
    checkOut: "2026-08-06",
    rankStart: 1,
    rankEnd: 50,
    detailRankStart: 1,
    detailRankEnd: 3
  };
}

function readyMain() {
  return {
    status: "ready",
    strategy: "legacy_candidate",
    executedTransportCount: 1,
    sampleCount: 50,
    items: Array.from({ length: 50 }, (_, index) => ({
      rank: index + 1,
      placeId: `synthetic-place-${String(index + 1).padStart(2, "0")}`
    }))
  };
}

function main() {
  const guard = installFixtureNetworkGuard({ label: "V2 collector compatibility request planner fixtures" });
  try {
    const blocked = buildV2CollectorCompatibilityRequestPlan({ contract: contract() });
    assert.equal(blocked.mainPlace.maxRequests, 1);
    assert.equal(blocked.mainPlace.transportStrategy, "legacy_candidate");
    assert.equal(blocked.mainPlace.automaticRetry, false);
    assert.equal(blocked.mainPlace.automaticFallback, false);
    assert.equal(blocked.otaEligible, false);
    assert.equal(blocked.ota.length, 5);
    assert.equal(blocked.ota.every((row) => row.executionState === "blocked"), true);
    assert.equal(blocked.ota.every((row) => row.blocker === "main_place_not_ready"), true);
    assert.equal(blocked.regionalRequestCount, 0);
    assert.equal(blocked.actualCallsEnabled, false);
    assert.equal(blocked.executedCallCount, 0);

    const eligible = buildV2CollectorCompatibilityRequestPlan({
      contract: contract(),
      mainPlaceSnapshot: readyMain()
    });
    assert.equal(eligible.otaEligible, true);
    assert.equal(eligible.ota.every((row) => row.executionState === "eligible" && row.blocker === null), true);
    assert.deepEqual(eligible.ota.map((row) => row.operation), OTA_REQUEST_DESCRIPTORS.map((row) => row.operation));
    assert.deepEqual(eligible.ota.map((row) => row.method), ["POST", "POST", "GET", "GET", "GET"]);
    assert.deepEqual(eligible.ota.map((row) => row.requestOrdinal), [1, 2, 3, 4, 5]);
    assert.equal(eligible.plannedNaverRequestCount, 31);
    assert.equal(eligible.plannedOtaRequestCount, 5);
    assert.equal(eligible.plannedTotalExternalRequestCount, 36);
    assert.equal(eligible.ota.every((row) => row.actualCallsEnabled === false), true);
    assert.doesNotMatch(JSON.stringify(eligible), /https?:|query=|Synthetic region lodging|cookie|authorization/i);

    const partialMain = readyMain();
    partialMain.sampleCount = 49;
    partialMain.items = partialMain.items.slice(0, 49);
    const partialPlan = buildV2CollectorCompatibilityRequestPlan({ contract: contract(), mainPlaceSnapshot: partialMain });
    assert.equal(partialPlan.otaEligible, false);
    assert.equal(partialPlan.ota.every((row) => row.executionState === "blocked"), true);
    assert.equal(guard.blockedAttempts(), 0);
  } finally {
    guard.restore();
  }
  console.log("V2 collector compatibility request planner tests passed.");
}

main();
