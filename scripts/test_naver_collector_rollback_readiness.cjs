"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { installFixtureNetworkGuard } = require("./fixture_network_guard.cjs");
const networkGuard = installFixtureNetworkGuard({ label: "NAVER collector rollback readiness fixtures" });
const {
  beginProviderAttempt,
  createInitialProviderCircuitState,
  providerAvailability,
  recordProviderBlock
} = require("./naver_provider_resilience.cjs");
const {
  createNaverSearchContractSignature,
  decideNaverQuotaConsumption
} = require("./naver_collection_fallback.cjs");
const { collectNaverPlaceSnapshot } = require("./naver_collector_strategy.cjs");
const { staticFixtureTransport } = require("./naver_collector_fixture_factory.cjs");
const { LIMITED_PREVIEW_CANARY_PLAN } = require("./naver_collector_rollback_readiness.cjs");

const ROOT = path.resolve(__dirname, "..");

function fullSearchContract(keyword) {
  return {
    keyword,
    searchMode: "keyword",
    collectionPurpose: "demand_location",
    productMode: "all",
    collectionMode: "precision",
    collectionProfile: "demand_location_precision",
    detailRankRanges: "1-20",
    checkIn: "2026-08-10",
    checkOut: "2026-08-16",
    bookingRangeDays: 7,
    bookingRangePlaceLimit: 20
  };
}

function exactManifest(overrides = {}) {
  return {
    documentType: "lodging-collection-manifest",
    schemaVersion: 2,
    collectorVersion: "fixture-collector-v2",
    collectionStartedAt: "2026-08-05T07:59:00.000Z",
    collectionCompletedAt: "2026-08-05T08:00:00.000Z",
    searchRegionKey: "kr_gyeonggi_pocheon",
    lodgingCategoryKey: "glamping",
    keyword: "포천글램핑",
    searchKeyword: "포천 글램핑",
    searchMode: "keyword",
    collectionPurpose: "demand_location",
    productMode: "all",
    collectionMode: "precision",
    collectionProfile: "demand_location_precision",
    detailRankRanges: "1-20",
    checkIn: "2026-08-10",
    checkOut: "2026-08-16",
    bookingRangeDays: 7,
    bookingRangePlaceLimit: 20,
    ...overrides
  };
}

async function main() {
  try {
  const serverModule = require("./glamping_app_server.cjs");
  const storedContract = serverModule.__test.storedNaverFallbackSearchContract({}, exactManifest());
  assert.ok(storedContract, "compact and spaced stored aliases must reconcile without cross-contract fallback");
  const canonicalRegionQuery = "region:kr_gyeonggi_pocheon:category:glamping";
  assert.equal(storedContract.keyword, canonicalRegionQuery);
  assert.equal(
    createNaverSearchContractSignature(storedContract),
    createNaverSearchContractSignature(fullSearchContract(canonicalRegionQuery))
  );
  assert.equal(
    serverModule.__test.naverFallbackKeywordIdentity("포천글램핑", {
      searchMode: "keyword",
      regionKey: "kr_gyeonggi_pocheon",
      categoryKey: "glamping"
    }),
    serverModule.__test.naverFallbackKeywordIdentity("포천 글램핑", {
      searchMode: "keyword",
      regionKey: "kr_gyeonggi_pocheon",
      categoryKey: "glamping"
    })
  );
  assert.equal(serverModule.__test.storedNaverFallbackSearchContract({}, exactManifest({
    searchKeyword: "산청 글램핑"
  })), null, "different regions remain a fail-closed alias conflict");
  assert.equal(serverModule.__test.storedNaverFallbackSearchContract({}, exactManifest({
    keyword: "AB C",
    searchKeyword: "A BC"
  })), null, "arbitrary whitespace removal cannot merge distinct search queries");
  const missingExactField = exactManifest();
  delete missingExactField.collectionProfile;
  assert.equal(
    serverModule.__test.storedNaverFallbackSearchContract({}, missingExactField),
    null,
    "presentation defaults cannot invent a missing exact manifest contract"
  );

  const initial = createInitialProviderCircuitState({ now: "2026-08-05T08:00:00.000Z" });
  const reserved = beginProviderAttempt(initial, {
    now: "2026-08-05T08:00:01.000Z",
    expectedWorkflowRevision: initial.workflowRevision,
    explicit: true
  });
  const blocked = recordProviderBlock(reserved.state, {
    subtype: "http_403",
    httpStatus: 403,
    occurredAt: "2026-08-05T08:00:02.000Z"
  }, {
    now: "2026-08-05T08:00:02.000Z",
    expectedWorkflowRevision: reserved.state.workflowRevision
  });
  const availability = providerAvailability(blocked, { now: "2026-08-05T08:01:00.000Z" });
  assert.equal(availability.coolingDown, true);
  const cooldownReservation = beginProviderAttempt(blocked, {
    now: "2026-08-05T08:01:00.000Z",
    expectedWorkflowRevision: blocked.workflowRevision,
    explicit: true
  });
  assert.equal(cooldownReservation.allowed, false);
  const transport = staticFixtureTransport({ status: 200, body: "" });
  for (const strategy of ["current", "legacy_candidate"]) {
    await assert.rejects(collectNaverPlaceSnapshot({
      contract: { keyword: "Circuit fixture", searchMode: "keyword", rankStart: 1, rankEnd: 20 },
      strategy,
      allowLegacyCandidate: strategy === "legacy_candidate",
      fixtureMode: true,
      providerReservation: cooldownReservation,
      transport
    }), (error) => error.code === "NAVER_PROVIDER_COOLDOWN_ACTIVE");
  }
  assert.equal(transport.fixtureCallCount(), 0, "an authoritative open circuit prevents every collector strategy transport");

  assert.deepEqual(decideNaverQuotaConsumption({ cooldownPrevented: true }), {
    consumeQuota: false,
    reason: "provider_cooldown_prevented",
    existingPolicyApplied: false
  });
  assert.deepEqual(decideNaverQuotaConsumption({ reused: true }), {
    consumeQuota: false,
    reason: "existing_result_reused",
    existingPolicyApplied: false
  });

  const serverSource = fs.readFileSync(path.join(ROOT, "scripts", "glamping_app_server.cjs"), "utf8");
  assert.match(serverSource, /reserveNaverProviderAttempt/);
  assert.match(serverSource, /startNaverProviderAttemptHeartbeat/);
  assert.match(serverSource, /naver_collection_fallback\.cjs/);
  assert.doesNotMatch(serverSource, /integration[\\/]services[\\/]v2_live_collection_provider/);
  assert.equal((serverSource.match(/runCrawlerLegacySingleFlight\s*\(/g) || []).length, 1);

  assert.equal(LIMITED_PREVIEW_CANARY_PLAN.executionState, "blocked_pending_separate_approval");
  assert.equal(LIMITED_PREVIEW_CANARY_PLAN.targetServiceId, "srv-d9jf91v41pts73cj9bu0");
  assert.equal(LIMITED_PREVIEW_CANARY_PLAN.targetCommit, null);
  assert.equal(LIMITED_PREVIEW_CANARY_PLAN.strategy, "legacy_candidate");
  assert.equal(LIMITED_PREVIEW_CANARY_PLAN.phase, "naver_place_rank_main");
  assert.equal(LIMITED_PREVIEW_CANARY_PLAN.scopeType, "main_place_only");
  assert.equal(LIMITED_PREVIEW_CANARY_PLAN.scope.keywordCount, 1);
  assert.equal(LIMITED_PREVIEW_CANARY_PLAN.scope.keywordValueStoredInPlan, false);
  assert.equal(LIMITED_PREVIEW_CANARY_PLAN.maxProviderAttempts, 1);
  assert.equal(LIMITED_PREVIEW_CANARY_PLAN.concurrency, 1);
  assert.equal(LIMITED_PREVIEW_CANARY_PLAN.actualCallsEnabled, false);
  assert.equal(LIMITED_PREVIEW_CANARY_PLAN.externalCallApproved, false);
  assert.equal(LIMITED_PREVIEW_CANARY_PLAN.previewWriteApproved, false);
  assert.equal(LIMITED_PREVIEW_CANARY_PLAN.authorizedCallCount, 0);
  assert.equal(LIMITED_PREVIEW_CANARY_PLAN.executedCallCount, 0);
  assert.equal(LIMITED_PREVIEW_CANARY_PLAN.saveResult, false);
  assert.equal(LIMITED_PREVIEW_CANARY_PLAN.circuitMustBeClosed, true);
  assert.equal(LIMITED_PREVIEW_CANARY_PLAN.stopOn403, true);
  assert.equal(LIMITED_PREVIEW_CANARY_PLAN.stopOn429, true);
  assert.equal(LIMITED_PREVIEW_CANARY_PLAN.stopOnChallenge, true);
  assert.equal(LIMITED_PREVIEW_CANARY_PLAN.rollbackStrategy, "current");
  assert.equal(LIMITED_PREVIEW_CANARY_PLAN.blocker, "separate_external_call_and_preview_write_approvals_required");
  assert.equal(LIMITED_PREVIEW_CANARY_PLAN.providerGuard.automaticRetry, false);
  assert.equal(LIMITED_PREVIEW_CANARY_PLAN.providerGuard.automaticProbe, false);
  assert.equal(LIMITED_PREVIEW_CANARY_PLAN.freshnessEvidence.forceFreshRequired, true);
  assert.equal(LIMITED_PREVIEW_CANARY_PLAN.freshnessEvidence.fallbackCanSatisfyCanary, false);
  assert.equal(LIMITED_PREVIEW_CANARY_PLAN.executionIdentity.productionIntegrationImplemented, false);
  assert.equal(LIMITED_PREVIEW_CANARY_PLAN.dataWrite.previewWriteApproved, false);

    assert.equal(networkGuard.blockedAttempts(), 0, "rollback readiness must not attempt external network access");
    console.log("NAVER collector rollback readiness fixture tests passed (network disabled).");
  } finally {
    networkGuard.restore();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
