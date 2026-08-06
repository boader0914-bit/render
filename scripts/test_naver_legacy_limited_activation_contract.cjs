"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  NAVER_LEGACY_LIMITED_ACTIVATION_PREVIEW_ROOT,
  chooseLegacyMainQuery,
  previewRuntimeMatches,
  projectNaverLegacyLimitedActivation,
  resolveNaverLegacyLimitedActivation,
  resolveNaverLegacyLimitedActivationForTrustedServer
} = require("./naver_legacy_limited_activation.cjs");

const ROOT = path.resolve(__dirname, "..");
const previewEnvironment = Object.freeze({
  EXACT_V2_PREVIEW_RUNTIME: true,
  RENDER: "true",
  PREVIEW_DATA_ROOT: NAVER_LEGACY_LIMITED_ACTIVATION_PREVIEW_ROOT
});
const eligibleRequest = Object.freeze({
  environment: previewEnvironment,
  collectionSource: "admin_search",
  sourceRole: "admin",
  searchMode: "keyword",
  collectionMode: "fast"
});

assert.equal(previewRuntimeMatches(previewEnvironment), true);
assert.equal(previewRuntimeMatches({ ...previewEnvironment, RENDER: "false" }), false);
assert.equal(previewRuntimeMatches({ ...previewEnvironment, RENDER: "TRUE" }), false);
assert.equal(previewRuntimeMatches({ ...previewEnvironment, RENDER: " true " }), false);
assert.equal(previewRuntimeMatches({ ...previewEnvironment, EXACT_V2_PREVIEW_RUNTIME: false }), false);
assert.equal(previewRuntimeMatches({ ...previewEnvironment, PREVIEW_DATA_ROOT: "/var/data" }), false);
assert.equal(previewRuntimeMatches({ ...previewEnvironment, PREVIEW_DATA_ROOT: "/var/data/v2-preview-runtime/" }), false);
assert.equal(previewRuntimeMatches({ ...previewEnvironment, PREVIEW_DATA_ROOT: "/var/data/v2-preview-runtime " }), false);

const active = resolveNaverLegacyLimitedActivation(eligibleRequest);
assert.equal(active.activationEnabled, true);
assert.equal(active.executionEligible, true);
assert.equal(active.strategy, "legacy_candidate");
assert.equal(active.collectorScope, "main_place_only");
assert.equal(active.rankStart, 1);
assert.equal(active.rankEnd, 50);
assert.equal(active.display, 50);
assert.equal(active.maxProviderAttempts, 1);
assert.equal(active.callBudget, 1);
assert.equal(active.concurrency, 1);
assert.equal(active.automaticRetry, false);
assert.equal(active.automaticFallback, false);
assert.equal(active.externalCallOnRead, false);
assert.equal(active.providerCircuitRequired, true);
assert.equal(active.saveRunOnSuccessOnly, true);
assert.equal(active.saveFailureRun, false);
assert.equal(active.blocker, null);
assert.deepEqual(active.blockers, []);
assert.equal(active.requestedCollectionMode, "fast");
assert.equal(active.effectiveCollectionMode, "fast");
assert.equal(active.collectionModeForced, false);
assert.equal(Object.isFrozen(active), true);

for (const [label, override, blocker] of [
  ["B2B source", { collectionSource: "b2b_search" }, "admin_search_source_required"],
  ["B2B role", { sourceRole: "b2b" }, "admin_role_required"],
  ["company mode", { searchMode: "company" }, "keyword_search_required"],
  ["precision mode", { collectionMode: "precision" }, "fast_collection_mode_required"],
  ["local runtime", { environment: { RENDER: "false", PREVIEW_DATA_ROOT: NAVER_LEGACY_LIMITED_ACTIVATION_PREVIEW_ROOT } }, "preview_runtime_required"],
  ["production root", { environment: { RENDER: "true", PREVIEW_DATA_ROOT: "/var/data" } }, "preview_runtime_required"]
]) {
  const inactive = resolveNaverLegacyLimitedActivation({ ...eligibleRequest, ...override });
  assert.equal(inactive.activationEnabled, false, label);
  assert.equal(inactive.executionEligible, false, label);
  assert.equal(inactive.strategy, "current", label);
  assert.equal(inactive.collectorScope, "current", label);
  assert.equal(inactive.blocker, blocker, label);
  assert.equal(Object.isFrozen(inactive), true, label);
}

const trustedUiPrecision = resolveNaverLegacyLimitedActivationForTrustedServer({
  ...eligibleRequest,
  collectionMode: "precision"
});
assert.equal(trustedUiPrecision.activationEnabled, true, "the exact Preview admin path forces the limited fast profile server-side");
assert.equal(trustedUiPrecision.strategy, "legacy_candidate");
assert.equal(trustedUiPrecision.collectorScope, "main_place_only");
assert.equal(trustedUiPrecision.requestedCollectionMode, "precision");
assert.equal(trustedUiPrecision.effectiveCollectionMode, "fast");
assert.equal(trustedUiPrecision.collectionModeForced, true);
assert.equal(trustedUiPrecision.callBudget, 1);
assert.equal(trustedUiPrecision.automaticRetry, false);
assert.equal(trustedUiPrecision.automaticFallback, false);

for (const [label, override] of [
  ["B2B source", { collectionSource: "b2b_search" }],
  ["B2B role", { sourceRole: "b2b" }],
  ["company mode", { searchMode: "company" }],
  ["unknown collection mode", { collectionMode: "unexpected" }],
  ["local runtime", { environment: { RENDER: "false", PREVIEW_DATA_ROOT: NAVER_LEGACY_LIMITED_ACTIVATION_PREVIEW_ROOT } }],
  ["production root", { environment: { RENDER: "true", PREVIEW_DATA_ROOT: "/var/data" } }]
]) {
  const inactive = resolveNaverLegacyLimitedActivationForTrustedServer({
    ...eligibleRequest,
    collectionMode: "precision",
    ...override
  });
  assert.equal(inactive.activationEnabled, false, `${label} cannot use the trusted Preview policy`);
  assert.equal(inactive.strategy, "current", label);
}

const explicit = chooseLegacyMainQuery({ explicitLegacyQuery: "경상남도   글램핑" });
assert.equal(explicit.query, "경상남도 글램핑");
assert.equal(explicit.selectionSource, "explicit_legacy_query");
assert.match(explicit.queryHash, /^[a-f0-9]{64}$/u);
assert.equal(explicit.requestOrdinal, 1);
assert.equal(explicit.plannedRequestCount, 1);

const historical = chooseLegacyMainQuery({
  crawlerContext: {
    historicalNaverQuery: "경상남도 글램핑",
    platformQueries: { naver: ["경남 글램핑", "경남글램핑"] }
  }
});
assert.equal(historical.query, "경상남도 글램핑");
assert.equal(historical.selectionSource, "crawler_historical_naver_query");

const derived = chooseLegacyMainQuery({
  crawlerContext: {
    originalKeyword: "경남 글램핑",
    province: { short: "경남", full: "경상남도", isLocal: false, isCompany: false },
    platformQueries: { naver: ["경남 글램핑", "경남글램핑"] }
  }
});
assert.equal(derived.query, "경상남도 글램핑", "the 4e4e190 historical NAVER_QUERY rule is preserved");
assert.equal(derived.selectionSource, "historical_province_query_rule");

const local = chooseLegacyMainQuery({
  crawlerContext: {
    originalKeyword: "포천 글램핑",
    province: { short: "포천", full: "포천", isLocal: true, isCompany: false },
    platformQueries: { naver: ["포천 글램핑", "포천글램핑", "ignored fallback"] }
  }
});
assert.equal(local.query, "포천 글램핑");
assert.equal(local.plannedRequestCount, 1, "fallback candidates must not become requests");

assert.throws(
  () => chooseLegacyMainQuery({ crawlerContext: {} }),
  (error) => error.code === "NAVER_LEGACY_LIMITED_QUERY_REQUIRED"
);

const metadata = projectNaverLegacyLimitedActivation(active, explicit);
assert.equal(metadata.activationEnabled, true);
assert.equal(metadata.strategy, "legacy_candidate");
assert.equal(metadata.collectorScope, "main_place_only");
assert.equal(metadata.requestIdentityHash, explicit.queryHash);
assert.equal(metadata.requestOrdinal, 1);
assert.equal(metadata.effectiveCollectionMode, "fast");
assert.equal(metadata.collectionModeForced, false);
assert.equal(Object.isFrozen(metadata), true);
const serializedMetadata = JSON.stringify(metadata);
assert.doesNotMatch(serializedMetadata, /경상남도|글램핑|https?:|url|header|cookie|authorization/iu);

const inactiveMetadata = projectNaverLegacyLimitedActivation(
  resolveNaverLegacyLimitedActivation({ ...eligibleRequest, collectionMode: "precision" }),
  explicit
);
assert.equal(inactiveMetadata.strategy, "current");
assert.equal(inactiveMetadata.rankStart, null);
assert.equal(inactiveMetadata.maxProviderAttempts, null);

const moduleSource = fs.readFileSync(path.join(ROOT, "scripts", "naver_legacy_limited_activation.cjs"), "utf8");
assert.doesNotMatch(moduleSource, /require\(["']node:(?:fs|child_process|http|https|net|tls)["']\)/u);
assert.doesNotMatch(moduleSource, /\bfetch\s*\(/u);
assert.doesNotMatch(moduleSource, /process\.env/u, "the pure contract must not read ambient environment state");

console.log("NAVER legacy limited Preview activation contract fixtures passed.");
