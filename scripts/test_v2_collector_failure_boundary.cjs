"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { installFixtureNetworkGuard } = require("./fixture_network_guard.cjs");
const {
  buildV2CollectorCompatibilityRequestPlan,
  buildV2CollectorCompatibilityRunAdapter,
  decideV2CollectorCompatibilityPersistence
} = require("./v2_collector_compatibility.cjs");

const contract = {
  keyword: "Synthetic failure lodging",
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

function readyMain() {
  return {
    status: "ready",
    strategy: "legacy_candidate",
    executedTransportCount: 1,
    sampleCount: 50,
    items: Array.from({ length: 50 }, (_, index) => ({ rank: index + 1, placeId: `failure-place-${index + 1}` }))
  };
}

function terminalInventory() {
  return [1, 2, 3].map((companyOrdinal) => ({
    companyOrdinal,
    placeId: `failure-place-${companyOrdinal}`,
    status: "ready",
    calls: { bookingBusiness: 1, bookingItems: 1, dailySchedule: 1 }
  }));
}

function terminalOta() {
  return [
    ["nol_count", "ready"],
    ["nol_list", "ready"],
    ["yeogi_status", "provider_blocked"],
    ["ddnayo_exact", "zero"],
    ["ddnayo_normalized", "ready"]
  ].map(([operation, status], index) => ({ operation, status, requestOrdinal: index + 1, requestCount: 1 }));
}

function assertNoWrites(decision, blocker) {
  assert.equal(decision.saveRun, false);
  assert.equal(decision.saveFailureRun, false);
  assert.equal(decision.updateCompanyMaster, false);
  assert.equal(decision.appendInventoryHistory, false);
  assert.equal(decision.appendRevenueHistory, false);
  assert.equal(decision.blocker, blocker);
}

function main() {
  const guard = installFixtureNetworkGuard({ label: "V2 collector failure boundary fixtures" });
  try {
    const lastSuccessfulRun = Object.freeze({ runId: "existing-success", hash: "unchanged" });
    const mainBlocked = decideV2CollectorCompatibilityPersistence({
      mainPlaceSnapshot: { status: "blocked", strategy: "legacy_candidate", executedTransportCount: 1, sampleCount: 0, items: [] },
      providerBlocked: true,
      failureCode: "NAVER_ACCESS_BLOCKED"
    });
    assertNoWrites(mainBlocked, "provider_blocked");
    assert.deepEqual(lastSuccessfulRun, { runId: "existing-success", hash: "unchanged" });
    const blockedPlan = buildV2CollectorCompatibilityRequestPlan({ contract, mainPlaceSnapshot: null });
    assert.equal(blockedPlan.otaEligible, false);
    assert.equal(blockedPlan.ota.every((row) => row.executionState === "blocked"), true);
    assert.equal(blockedPlan.executedCallCount, 0);

    const otaFailure = terminalOta();
    otaFailure[3] = { ...otaFailure[3], status: "missing" };
    assertNoWrites(decideV2CollectorCompatibilityPersistence({
      mainPlaceSnapshot: readyMain(),
      otaResults: otaFailure,
      inventoryResults: terminalInventory(),
      executionSucceeded: true,
      manifestValid: true,
      atomicPublishReady: true
    }), "ota_not_terminal");

    const inventoryPartial = terminalInventory();
    inventoryPartial[1] = { ...inventoryPartial[1], status: "partial" };
    assertNoWrites(decideV2CollectorCompatibilityPersistence({
      mainPlaceSnapshot: readyMain(),
      otaResults: terminalOta(),
      inventoryResults: inventoryPartial,
      executionSucceeded: true,
      manifestValid: true,
      atomicPublishReady: true
    }), "inventory_not_terminal");

    assertNoWrites(decideV2CollectorCompatibilityPersistence({
      mainPlaceSnapshot: readyMain(),
      otaResults: terminalOta(),
      inventoryResults: terminalInventory(),
      executionSucceeded: true,
      manifestValid: false,
      atomicPublishReady: true
    }), "manifest_invalid");

    const excessiveInventory = terminalInventory();
    excessiveInventory[0] = {
      ...excessiveInventory[0],
      calls: { bookingBusiness: 1, bookingItems: 1, dailySchedule: 9 }
    };
    assert.throws(
      () => buildV2CollectorCompatibilityRunAdapter({
        contract,
        mainPlaceSnapshot: readyMain(),
        otaResults: terminalOta(),
        inventoryResults: excessiveInventory
      }),
      (error) => error.code === "V2_COLLECTOR_COMPATIBILITY_RESULT_INVALID"
    );

    const crawlerSource = fs.readFileSync(path.join(__dirname, "gyeongnam_glamping_crawl.cjs"), "utf8");
    const mainCollection = crawlerSource.indexOf("const naver = await collectNaverMain()");
    const otaCollection = crawlerSource.indexOf("const nol = COLLECTION_PROFILE.collectOta ? await collectNol()");
    const inventoryCollection = crawlerSource.indexOf("const naverBookingStock = await enrichNaverRowsWithBookingAvailability");
    const compatibilityValidation = crawlerSource.indexOf("validateV2CollectorCompatibilityRunManifest(manifest)");
    const finalRename = crawlerSource.indexOf("await fs.rename(OUTPUT_DIR, FINAL_OUTPUT_DIR)");
    assert.equal(mainCollection >= 0 && mainCollection < otaCollection, true, "OTA must remain blocked until main Place succeeds");
    assert.equal(otaCollection < inventoryCollection, true, "the fixed V2 phase order must be main, OTA, inventory");
    assert.equal(compatibilityValidation >= 0 && compatibilityValidation < finalRename, true, "manifest validation must precede atomic publication");
    assert.match(crawlerSource, /V2_COLLECTOR_COMPATIBILITY_PROFILE[\s\S]{0,900}collectRegional:\s*false,[\s\S]{0,120}collectOta:\s*true/u);

    assert.equal(guard.blockedAttempts(), 0);
  } finally {
    guard.restore();
  }
  console.log("V2 collector failure boundary tests passed.");
}

main();
