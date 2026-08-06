"use strict";

const assert = require("node:assert/strict");
const { installFixtureNetworkGuard } = require("./fixture_network_guard.cjs");
const { FIXED_INVENTORY_ACTIVATION } = require("./naver_legacy_inventory_activation.cjs");
const {
  FIXED_V2_COLLECTOR_COMPATIBILITY,
  V2_COLLECTOR_COMPATIBILITY_PROFILE,
  V2_COLLECTOR_COMPATIBILITY_STRATEGY,
  V2_COLLECTOR_TRANSPORT_STRATEGY,
  normalizedCompatibilityContract,
  resolveV2CollectorCompatibilityActivation
} = require("./v2_collector_compatibility.cjs");

function activationInput(overrides = {}) {
  return {
    environment: {
      EXACT_V2_PREVIEW_RUNTIME: true,
      RENDER: "true",
      PREVIEW_DATA_ROOT: "/var/data/v2-preview-runtime"
    },
    collectionSource: "admin_search",
    sourceRole: "admin",
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
    detailRankEnd: 3,
    ...overrides
  };
}

function main() {
  const guard = installFixtureNetworkGuard({ label: "V2 collector compatibility contract fixtures" });
  try {
    assert.equal(V2_COLLECTOR_COMPATIBILITY_PROFILE, "preview-admin-v2-collector-compatibility.v1");
    assert.equal(V2_COLLECTOR_COMPATIBILITY_STRATEGY, "v2_legacy_4e4e190");
    assert.equal(V2_COLLECTOR_TRANSPORT_STRATEGY, "legacy_candidate");
    assert.equal(FIXED_V2_COLLECTOR_COMPATIBILITY.mainPlaceRankEnd, 50);
    assert.equal(FIXED_V2_COLLECTOR_COMPATIBILITY.maxInventoryCompanies, 3);
    assert.equal(FIXED_V2_COLLECTOR_COMPATIBILITY.observationDays, 1);
    assert.equal(FIXED_V2_COLLECTOR_COMPATIBILITY.maxProductsPerCompany, 8);
    assert.equal(FIXED_V2_COLLECTOR_COMPATIBILITY.naverCallBudget, 31);
    assert.equal(FIXED_V2_COLLECTOR_COMPATIBILITY.otaCallBudget, 5);
    assert.equal(FIXED_V2_COLLECTOR_COMPATIBILITY.totalExternalCallBudget, 36);
    assert.equal(FIXED_V2_COLLECTOR_COMPATIBILITY.collectRegional, false);
    assert.equal(FIXED_V2_COLLECTOR_COMPATIBILITY.collectOta, true);
    assert.equal(FIXED_V2_COLLECTOR_COMPATIBILITY.automaticRetry, false);
    assert.equal(FIXED_V2_COLLECTOR_COMPATIBILITY.automaticFallback, false);
    assert.equal(FIXED_V2_COLLECTOR_COMPATIBILITY.maxProductsPerCompany, FIXED_INVENTORY_ACTIVATION.maxProductsPerCompany);
    assert.equal(Object.isFrozen(FIXED_V2_COLLECTOR_COMPATIBILITY), true);

    const activation = resolveV2CollectorCompatibilityActivation(activationInput());
    assert.equal(activation.activationEnabled, true);
    assert.equal(activation.executionEligible, true);
    assert.equal(activation.actualCallsEnabled, true);
    assert.equal(activation.strategy, V2_COLLECTOR_COMPATIBILITY_STRATEGY);
    assert.equal(activation.transportStrategy, V2_COLLECTOR_TRANSPORT_STRATEGY);
    assert.match(activation.contract.keywordHash, /^[a-f0-9]{64}$/u);
    assert.doesNotMatch(JSON.stringify(activation), /Synthetic region lodging/u);

    const { __test } = require("./glamping_app_server.cjs");
    const trusted = __test.trustedPreviewAdminCrawlPayload({
      keyword: "경남 글램핑",
      searchMode: "keyword",
      collectionMode: "precision",
      collectionPurpose: "revenue_detail",
      productMode: "all",
      checkIn: "2026-08-06",
      checkOut: "2026-08-06",
      detailRankRanges: "1-3"
    }, {
      previewRuntime: true,
      previewDataRoot: "/var/data/v2-preview-runtime",
      activationEnvironment: activationInput().environment
    });
    assert.equal(trusted.v2CollectorCompatibilityActivation, true);
    assert.equal(trusted.v2CollectorCompatibilityStrategy, V2_COLLECTOR_COMPATIBILITY_STRATEGY);
    assert.equal(trusted.naverCollectorStrategy, V2_COLLECTOR_TRANSPORT_STRATEGY);
    assert.equal(trusted.naverLimitedActivationProfile, V2_COLLECTOR_COMPATIBILITY_PROFILE);
    assert.equal(trusted.naverLegacyInventoryActivation, true);
    assert.equal(trusted.naverAutomaticRetry, false);
    assert.equal(trusted.naverAutomaticFallback, false);
    const serverPlan = __test.crawlExecutionPlan(trusted);
    assert.equal(serverPlan.v2CollectorCompatibilityActivation, true);
    assert.equal(serverPlan.boundedInventoryActivation, true);
    assert.equal(serverPlan.collectRegional, false);
    assert.equal(serverPlan.collectOta, true);
    assert.equal(serverPlan.collectWeeklyRange, false);
    const estimate = __test.estimateCrawlCompletion(trusted, { entries: [] });
    assert.equal(estimate.basis.boundedInventory.totalCallBudget, 36);
    assert.equal(estimate.basis.boundedInventory.naverCallBudget, 31);
    assert.equal(estimate.basis.boundedInventory.otaCallBudget, 5);

    for (const [override, blocker] of [
      [{ sourceRole: "b2b" }, "admin_role_required"],
      [{ collectionSource: "b2b_search" }, "admin_search_source_required"],
      [{ searchMode: "company" }, "searchMode_required"],
      [{ collectionMode: "fast" }, "collectionMode_required"],
      [{ collectionPurpose: "demand_location" }, "collectionPurpose_required"]
    ]) {
      const blocked = resolveV2CollectorCompatibilityActivation(activationInput(override));
      assert.equal(blocked.activationEnabled, false);
      assert.equal(blocked.actualCallsEnabled, false);
      assert.equal(blocked.blockers.includes(blocker), true);
    }

    assert.throws(
      () => normalizedCompatibilityContract(activationInput({ checkOut: "2026-08-07" })),
      (error) => error.code === "V2_COLLECTOR_COMPATIBILITY_CONTRACT_INVALID"
    );
    assert.throws(
      () => normalizedCompatibilityContract(activationInput({ rankEnd: 49 })),
      (error) => error.code === "V2_COLLECTOR_COMPATIBILITY_CONTRACT_INVALID"
    );
    assert.equal(guard.blockedAttempts(), 0);
  } finally {
    guard.restore();
  }
  console.log("V2 collector compatibility contract tests passed.");
}

main();
