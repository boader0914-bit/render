"use strict";

const crypto = require("node:crypto");

const NAVER_COLLECTOR_ROLLBACK_READINESS_SCHEMA_VERSION = "naver-collector-rollback-readiness.v1";
const BASELINE_HEAD = "4b33a1d5eb4c100a95070729160cc4c79de4ee56";
const PARSER_HARDENING_COMMIT = "26b61fab0eecef2e4b43fc2b3bfbd93e5fe990a4";
const PRE_HARDENING_PARENT = "b265163230892ce3ef29fb270bffeaec6ddbff7f";
const UNIFIED_SEARCH_COMMIT = "8a5b529fb2a8ebb8cd8336e26a6e223f5b90eb3a";
const PRE_UNIFIED_SEARCH_PARENT = "f68d28d45f961e6db1ed31a877b69d394a9a9f7c";
const ALTERNATE_V2_BRANCH_COMMIT = "f15492b95d0e9a648cd2ad2914139595b3944712";
const LEGACY_V2_LIVE_COMMIT = "4e4e1906e2967fe58df66f8ad67f832043d2763b";
const LEGACY_V2_SERVICE_ID = "srv-d8rjrmojs32c73c4tmhg";
const LEGACY_V2_DEPLOY_ID = "dep-d9atqu5ckfvc73bubmgg";
const LEGACY_V2_COLLECTOR_BLOB = "bcbe229998da3afa6f31ee04375fb0766019e56f";
const PREVIEW_E4_COLLECTOR_BLOB = "388cea0a5423c928e00111b750304e80598f868a";

function immutable(value) {
  if (Array.isArray(value)) {
    value.forEach(immutable);
    return Object.freeze(value);
  }
  if (value && typeof value === "object") {
    Object.values(value).forEach(immutable);
    return Object.freeze(value);
  }
  return value;
}

const EXISTING_V2_FRESHNESS_ASSESSMENT = immutable({
  classification: "confirmed_fresh_collection",
  evidenceScope: "sanitized_read_only_deployment_and_run_metadata",
  serviceId: LEGACY_V2_SERVICE_ID,
  serviceRegion: "Singapore",
  liveCommitSha: LEGACY_V2_LIVE_COMMIT,
  deployId: LEGACY_V2_DEPLOY_ID,
  collectorBlob: LEGACY_V2_COLLECTOR_BLOB,
  comparisonCollectorBlob: PREVIEW_E4_COLLECTOR_BLOB,
  successWindows: [
    {
      startedAt: "2026-08-05T21:41:08+09:00",
      completedAt: "2026-08-05T21:43:01+09:00"
    },
    {
      startedAt: "2026-08-05T23:34:33+09:00",
      completedAt: "2026-08-05T23:36:24+09:00"
    }
  ],
  resultSummary: {
    naverOverallCount: 50,
    naverRegionalCount: 10,
    resultFileCount: 8,
    collectionKinds: ["precision", "revenue_detail", "keyword"]
  },
  evidence: [
    "new_run_ids_observed_without_storing_values",
    "new_success_manifests_observed",
    "matching_collection_windows_observed",
    "fresh_result_files_observed"
  ],
  safeConclusion: "The identified legacy V2 deployment completed two fresh collections; this does not prove that its strategy will avoid a future provider block."
});

const HISTORY_CANDIDATES = immutable([
  {
    commitSha: LEGACY_V2_LIVE_COMMIT,
    role: "confirmed_legacy_v2_live_collector",
    codeCandidateConfidence: "confirmed",
    lastSuccessfulRunConfidence: "confirmed",
    evidence: [
      "sanitized_deployment_metadata_matches_live_commit",
      "two_fresh_collection_windows_and_manifests_observed",
      "collector_blob_differs_from_preview_e4_collector"
    ],
    limitation: "Fresh collection success does not establish the cause of the environment difference or guarantee future access."
  },
  {
    commitSha: PRE_HARDENING_PARENT,
    role: "pre_hardening_parser_parent",
    codeCandidateConfidence: "high",
    lastSuccessfulRunConfidence: "insufficient_evidence",
    evidence: [
      "immediately_precedes_parser_hardening_commit",
      "contains_inline_exact_display_50_apollo_selector"
    ],
    limitation: "No successful run metadata or deployed service identity links this commit to the observed existing V2 result."
  },
  {
    commitSha: PARSER_HARDENING_COMMIT,
    role: "parser_hardening_transition",
    codeCandidateConfidence: "high",
    lastSuccessfulRunConfidence: "insufficient_evidence",
    evidence: [
      "introduces_shared_apollo_parser",
      "introduces_fail_closed_access_and_contract_errors",
      "does_not_change_primary_naver_place_request_target"
    ],
    limitation: "Parser hardening is a code transition, not evidence of a last successful provider collection."
  },
  {
    commitSha: PRE_UNIFIED_SEARCH_PARENT,
    transitionCommitSha: UNIFIED_SEARCH_COMMIT,
    role: "pre_unified_query_planning_candidate",
    codeCandidateConfidence: "medium",
    lastSuccessfulRunConfidence: "insufficient_evidence",
    evidence: ["precedes_unified_lodging_search_query_planning"],
    limitation: "This older request-planning candidate is not linked to the unidentified existing V2 service or to a successful run."
  },
  {
    commitSha: ALTERNATE_V2_BRANCH_COMMIT,
    role: "alternate_v2_live_collection_branch_candidate",
    codeCandidateConfidence: "medium",
    lastSuccessfulRunConfidence: "insufficient_evidence",
    evidence: [
      "exists_on_preview_lodging_datalab_v2_branch",
      "uses_a_separate_fresh_store_and_provider_contract"
    ],
    limitation: "The branch is not an ancestor of the current runtime, its live service identity is unconfirmed, and its provider is not connected to the Stage 8 service-global circuit."
  },
  {
    commitSha: BASELINE_HEAD,
    role: "current_committed_baseline",
    codeCandidateConfidence: "high",
    lastSuccessfulRunConfidence: "insufficient_evidence",
    evidence: ["matches_handoff_head"],
    limitation: "Stage 8 resilience changes are uncommitted and must be assessed from the working tree."
  }
]);

const COLLECTOR_DIFFERENCE_ASSESSMENT = immutable([
  {
    category: "portable_parser_difference",
    finding: "The historical selector required one exact display=50 accommodationSearch result and used placeList only for company mode.",
    action: "preserve_only_as_fixture_legacy_candidate_under_modern_validation"
  },
  {
    category: "security_regression",
    finding: "The historical path lacked current ambiguity, malformed reference, safe block subtype, and public failure boundaries.",
    action: "excluded_from_production_restore"
  },
  {
    category: "portable_request_planning_difference",
    finding: "The confirmed 4e4e190 collector blob differs from the Preview e4 collector blob; only its main Place request planning is eligible for isolated fixture comparison.",
    action: "isolate_without_copying_network_or_server_code"
  },
  {
    category: "environment_difference",
    finding: "The confirmed legacy service ran in Singapore at 4e4e190, but no external egress probe was authorized.",
    action: "egress_difference_unverified"
  },
  {
    category: "cache_or_reuse_difference",
    finding: "Reuse remains possible generally, but the two sanitized legacy observations had new run identities and success manifests.",
    action: "confirmed_fresh_for_two_observed_windows_only"
  },
  {
    category: "traffic_pattern_difference",
    finding: "The collector performs one main search plus optional regional and per-place booking requests; live request counts were not probed.",
    action: "unverified_without_authorized_canary"
  },
  {
    category: "unknown",
    finding: "The alternate V2 branch can use official Local Search for discovery, but that contract is not equivalent to actual NAVER Place exposure ranking.",
    action: "do_not_label_as_place_rank_or_auto_port"
  }
]);

const CANARY_PLAN_VERSION = "naver-legacy-main-place-canary-plan.v1";
const CANARY_REGION_PLACEHOLDER = "__approval_required_region_key__";
const CANARY_KEYWORD_PLACEHOLDER = "__approval_required_keyword__";

function canaryPlanError(message) {
  const error = new Error(message);
  error.code = "NAVER_LEGACY_CANARY_PLAN_BLOCKED";
  return error;
}

function validateDisabledLegacyCanaryPlan(plan) {
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) {
    throw canaryPlanError("A canary plan object is required.");
  }
  const exact = {
    targetServiceId: "srv-d9jf91v41pts73cj9bu0",
    targetCommit: null,
    strategy: "legacy_candidate",
    phase: "naver_place_rank_main",
    scopeType: "main_place_only",
    regionKey: CANARY_REGION_PLACEHOLDER,
    keyword: CANARY_KEYWORD_PLACEHOLDER,
    maxProviderAttempts: 1,
    concurrency: 1,
    automaticRetry: false,
    automaticFallback: false,
    actualCallsEnabled: false,
    externalCallApproved: false,
    previewWriteApproved: false,
    authorizedCallCount: 0,
    executedCallCount: 0,
    saveResult: false,
    circuitMustBeClosed: true,
    stopOn403: true,
    stopOn429: true,
    stopOnChallenge: true,
    rollbackStrategy: "current"
  };
  for (const [key, expected] of Object.entries(exact)) {
    if (plan[key] !== expected) {
      throw canaryPlanError(`Disabled canary invariant failed: ${key}.`);
    }
  }
  if (plan.blocker !== "separate_external_call_and_preview_write_approvals_required") {
    throw canaryPlanError("The disabled canary blocker must remain explicit.");
  }
  return true;
}

function buildDisabledLegacyCanaryPlan(overrides = {}) {
  if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) {
    throw canaryPlanError("Canary overrides must be an object.");
  }
  const allowedOverrides = new Set([
    "targetCommit", "regionKey", "keyword", "maxProviderAttempts", "concurrency",
    "automaticRetry", "automaticFallback", "actualCallsEnabled", "externalCallApproved",
    "previewWriteApproved", "authorizedCallCount", "executedCallCount", "saveResult"
  ]);
  for (const key of Object.keys(overrides)) {
    if (!allowedOverrides.has(key)) {
      throw canaryPlanError(`Unsupported canary override: ${key}.`);
    }
  }
  const flatPlan = {
    planVersion: CANARY_PLAN_VERSION,
    schemaVersion: "naver-collector-canary-plan.v2",
    targetServiceId: "srv-d9jf91v41pts73cj9bu0",
    targetCommit: null,
    strategy: "legacy_candidate",
    phase: "naver_place_rank_main",
    scopeType: "main_place_only",
    regionKey: CANARY_REGION_PLACEHOLDER,
    keyword: CANARY_KEYWORD_PLACEHOLDER,
    maxProviderAttempts: 1,
    concurrency: 1,
    automaticRetry: false,
    automaticFallback: false,
    actualCallsEnabled: false,
    externalCallApproved: false,
    previewWriteApproved: false,
    authorizedCallCount: 0,
    executedCallCount: 0,
    saveResult: false,
    circuitMustBeClosed: true,
    stopOn403: true,
    stopOn429: true,
    stopOnChallenge: true,
    rollbackStrategy: "current",
    blocker: "separate_external_call_and_preview_write_approvals_required",
    ...overrides
  };
  validateDisabledLegacyCanaryPlan(flatPlan);
  return immutable({
    ...flatPlan,
    targetService: { name: "lodging-datalab-preview", serviceId: flatPlan.targetServiceId },
    baseCommitSha: BASELINE_HEAD,
    candidateCommitSha: flatPlan.targetCommit,
    candidateCommitStatus: "pending_separate_commit_approval",
    executionState: "blocked_pending_separate_approval",
    collectorStrategyDefault: "current",
    legacyCandidateDefaultEnabled: false,
    executionIdentity: {
      requiredBeforeActivation: true,
      productionIntegrationImplemented: false,
      requiredFields: ["strategy", "strategyVersion", "queryPlanVersion", "parserVersion", "rankingContractVersion", "executionIdentityHash"],
      requiredStores: [],
      forbiddenStores: ["job_signature", "success_manifest", "history", "snapshot", "fallback_provenance"]
    },
    operatorCount: 1,
    explicitAdminActionRequired: true,
    scope: {
      phase: flatPlan.phase,
      scopeType: flatPlan.scopeType,
      canonicalRegionCount: 1,
      keywordCount: 1,
      keywordValueStoredInPlan: false,
      rankStart: 1,
      rankEnd: 50,
      maximumProviderAttempts: flatPlan.maxProviderAttempts,
      concurrentAttempts: flatPlan.concurrency
    },
    providerGuard: {
      circuitMustBeClosed: true,
      stopOnCodes: ["NAVER_ACCESS_BLOCKED", "NAVER_PROVIDER_COOLDOWN_ACTIVE"],
      additionalAttemptsAfterBlock: 0,
      automaticRetry: false,
      automaticProbe: false
    },
    freshnessEvidence: {
      forceFreshRequired: true,
      recentReuseAllowed: false,
      sharedReuseAllowed: false,
      completedReuseAllowed: false,
      fallbackCanSatisfyCanary: false,
      requiredEvidence: ["provider_transport_attempt_started", "safe_count_summary", "execution_identity", "started_at", "completed_at"]
    },
    approvals: {
      externalCallApproved: false,
      previewWriteApproved: false
    },
    dataWrite: { previewWriteApproved: false, mode: "no_store_canary" },
    rollback: { strategy: "current", automaticLegacyEnablement: false, migrationRequired: false },
    remainingApprovals: ["candidate_commit_sha", "preview_deployment", "single_provider_attempt", "one_shot_approval_and_provider_health_metadata"]
  });
}

const LIMITED_PREVIEW_CANARY_PLAN = buildDisabledLegacyCanaryPlan();

function safeReadinessProjection() {
  return immutable({
    schemaVersion: NAVER_COLLECTOR_ROLLBACK_READINESS_SCHEMA_VERSION,
    assessedHead: BASELINE_HEAD,
    existingV2Freshness: EXISTING_V2_FRESHNESS_ASSESSMENT,
    historyCandidates: HISTORY_CANDIDATES,
    differences: COLLECTOR_DIFFERENCE_ASSESSMENT,
    restoredCompatibility: {
      strategy: "legacy_candidate",
      fixtureOnly: true,
      actualCallsEnabled: false,
      productionActivationStatus: "disabled"
    },
    conclusion: "rollback_not_proven_to_resolve_provider_access_block",
    canaryPlan: LIMITED_PREVIEW_CANARY_PLAN
  });
}

function readinessFingerprint() {
  return crypto.createHash("sha256").update(JSON.stringify(safeReadinessProjection())).digest("hex");
}

module.exports = {
  ALTERNATE_V2_BRANCH_COMMIT,
  BASELINE_HEAD,
  CANARY_KEYWORD_PLACEHOLDER,
  CANARY_PLAN_VERSION,
  CANARY_REGION_PLACEHOLDER,
  COLLECTOR_DIFFERENCE_ASSESSMENT,
  EXISTING_V2_FRESHNESS_ASSESSMENT,
  HISTORY_CANDIDATES,
  LEGACY_V2_COLLECTOR_BLOB,
  LEGACY_V2_DEPLOY_ID,
  LEGACY_V2_LIVE_COMMIT,
  LEGACY_V2_SERVICE_ID,
  LIMITED_PREVIEW_CANARY_PLAN,
  NAVER_COLLECTOR_ROLLBACK_READINESS_SCHEMA_VERSION,
  PARSER_HARDENING_COMMIT,
  PREVIEW_E4_COLLECTOR_BLOB,
  PRE_UNIFIED_SEARCH_PARENT,
  PRE_HARDENING_PARENT,
  UNIFIED_SEARCH_COMMIT,
  buildDisabledLegacyCanaryPlan,
  readinessFingerprint,
  safeReadinessProjection,
  validateDisabledLegacyCanaryPlan
};
