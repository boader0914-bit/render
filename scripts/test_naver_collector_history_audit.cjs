"use strict";

const assert = require("node:assert/strict");
const { installFixtureNetworkGuard } = require("./fixture_network_guard.cjs");
const networkGuard = installFixtureNetworkGuard({ label: "NAVER collector history audit fixtures" });
const {
  ALTERNATE_V2_BRANCH_COMMIT,
  BASELINE_HEAD,
  COLLECTOR_DIFFERENCE_ASSESSMENT,
  EXISTING_V2_FRESHNESS_ASSESSMENT,
  HISTORY_CANDIDATES,
  LEGACY_V2_LIVE_COMMIT,
  LEGACY_V2_SERVICE_ID,
  LIMITED_PREVIEW_CANARY_PLAN,
  PARSER_HARDENING_COMMIT,
  PRE_UNIFIED_SEARCH_PARENT,
  PRE_HARDENING_PARENT,
  UNIFIED_SEARCH_COMMIT,
  readinessFingerprint,
  safeReadinessProjection
} = require("./naver_collector_rollback_readiness.cjs");

function main() {
  try {
  assert.equal(EXISTING_V2_FRESHNESS_ASSESSMENT.classification, "confirmed_fresh_collection");
  assert.equal(EXISTING_V2_FRESHNESS_ASSESSMENT.serviceId, LEGACY_V2_SERVICE_ID);
  assert.equal(EXISTING_V2_FRESHNESS_ASSESSMENT.liveCommitSha, LEGACY_V2_LIVE_COMMIT);
  assert.equal(EXISTING_V2_FRESHNESS_ASSESSMENT.successWindows.length, 2);
  assert.equal(EXISTING_V2_FRESHNESS_ASSESSMENT.resultSummary.naverOverallCount, 50);
  assert.equal(EXISTING_V2_FRESHNESS_ASSESSMENT.resultSummary.naverRegionalCount, 10);
  assert.equal(EXISTING_V2_FRESHNESS_ASSESSMENT.resultSummary.resultFileCount, 8);

  for (const commit of [
    BASELINE_HEAD,
    LEGACY_V2_LIVE_COMMIT,
    PARSER_HARDENING_COMMIT,
    PRE_HARDENING_PARENT,
    UNIFIED_SEARCH_COMMIT,
    PRE_UNIFIED_SEARCH_PARENT,
    ALTERNATE_V2_BRANCH_COMMIT
  ]) {
    assert.match(commit, /^[a-f0-9]{40}$/);
  }
  assert.ok(HISTORY_CANDIDATES.some((candidate) => candidate.commitSha === PRE_HARDENING_PARENT));
  assert.ok(HISTORY_CANDIDATES.some((candidate) => candidate.commitSha === PARSER_HARDENING_COMMIT));
  assert.ok(HISTORY_CANDIDATES.some((candidate) => candidate.commitSha === ALTERNATE_V2_BRANCH_COMMIT));
  const confirmedLegacyCandidate = HISTORY_CANDIDATES.find((candidate) => candidate.commitSha === LEGACY_V2_LIVE_COMMIT);
  assert.equal(confirmedLegacyCandidate.codeCandidateConfidence, "confirmed");
  assert.equal(confirmedLegacyCandidate.lastSuccessfulRunConfidence, "confirmed");
  const preHardenCandidate = HISTORY_CANDIDATES.find((candidate) => candidate.commitSha === PRE_HARDENING_PARENT);
  assert.equal(preHardenCandidate.codeCandidateConfidence, "high");
  assert.equal(preHardenCandidate.lastSuccessfulRunConfidence, "insufficient_evidence");

  const parserDifference = COLLECTOR_DIFFERENCE_ASSESSMENT.find((row) => row.category === "portable_parser_difference");
  const environmentDifference = COLLECTOR_DIFFERENCE_ASSESSMENT.find((row) => row.category === "environment_difference");
  const securityRegression = COLLECTOR_DIFFERENCE_ASSESSMENT.find((row) => row.category === "security_regression");
  assert.match(parserDifference.finding, /display=50/);
  assert.equal(environmentDifference.action, "egress_difference_unverified");
  assert.equal(securityRegression.action, "excluded_from_production_restore");

  assert.equal(LIMITED_PREVIEW_CANARY_PLAN.targetService.serviceId, "srv-d9jf91v41pts73cj9bu0");
  assert.equal(LIMITED_PREVIEW_CANARY_PLAN.targetServiceId, "srv-d9jf91v41pts73cj9bu0");
  assert.equal(LIMITED_PREVIEW_CANARY_PLAN.targetCommit, null);
  assert.equal(LIMITED_PREVIEW_CANARY_PLAN.strategy, "legacy_candidate");
  assert.equal(LIMITED_PREVIEW_CANARY_PLAN.phase, "naver_place_rank_main");
  assert.equal(LIMITED_PREVIEW_CANARY_PLAN.scopeType, "main_place_only");
  assert.equal(LIMITED_PREVIEW_CANARY_PLAN.maxProviderAttempts, 1);
  assert.equal(LIMITED_PREVIEW_CANARY_PLAN.concurrency, 1);
  assert.equal(LIMITED_PREVIEW_CANARY_PLAN.automaticRetry, false);
  assert.equal(LIMITED_PREVIEW_CANARY_PLAN.automaticFallback, false);
  assert.equal(LIMITED_PREVIEW_CANARY_PLAN.candidateCommitSha, null);
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
  assert.equal(LIMITED_PREVIEW_CANARY_PLAN.scope.maximumProviderAttempts, 1);
  assert.equal(LIMITED_PREVIEW_CANARY_PLAN.providerGuard.additionalAttemptsAfterBlock, 0);
  assert.equal(LIMITED_PREVIEW_CANARY_PLAN.legacyCandidateDefaultEnabled, false);
  assert.equal(LIMITED_PREVIEW_CANARY_PLAN.executionIdentity.productionIntegrationImplemented, false);
  assert.ok(LIMITED_PREVIEW_CANARY_PLAN.executionIdentity.requiredFields.includes("rankingContractVersion"));
  assert.equal(LIMITED_PREVIEW_CANARY_PLAN.freshnessEvidence.recentReuseAllowed, false);
  assert.equal(LIMITED_PREVIEW_CANARY_PLAN.freshnessEvidence.completedReuseAllowed, false);
  assert.equal(LIMITED_PREVIEW_CANARY_PLAN.freshnessEvidence.fallbackCanSatisfyCanary, false);
  assert.equal(LIMITED_PREVIEW_CANARY_PLAN.dataWrite.previewWriteApproved, false);

  const projection = safeReadinessProjection();
  const serialized = JSON.stringify(projection);
  assert.equal(projection.conclusion, "rollback_not_proven_to_resolve_provider_access_block");
  assert.equal(projection.restoredCompatibility.fixtureOnly, true);
  assert.equal(projection.restoredCompatibility.productionActivationStatus, "disabled");
  assert.doesNotMatch(serialized, /https?:\/\//i);
  assert.doesNotMatch(serialized, /api[_-]?key|client[_-]?secret|authorization|cookie/i);
  assert.doesNotMatch(serialized, /query string|raw html/i);
  assert.match(readinessFingerprint(), /^[a-f0-9]{64}$/);
  assert.equal(readinessFingerprint(), readinessFingerprint(), "readiness fingerprint must be deterministic");

    assert.equal(networkGuard.blockedAttempts(), 0, "history audit must not attempt external network access");
    console.log("NAVER collector history audit fixture tests passed (network disabled).");
  } finally {
    networkGuard.restore();
  }
}

main();
