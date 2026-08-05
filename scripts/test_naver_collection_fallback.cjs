"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { installFixtureNetworkGuard } = require("./fixture_network_guard.cjs");
const {
  NaverCollectionFallbackContractError,
  buildNaverCollectionFallbackState,
  createNaverSearchContractSignature,
  decideNaverQuotaConsumption,
  matchesExactNaverFallback,
  projectNaverCollectionFallbackForB2B,
  selectLastKnownGoodNaverFallback
} = require("./naver_collection_fallback.cjs");

const networkGuard = installFixtureNetworkGuard({ label: "NAVER collection fallback fixtures" });
const contractSource = fs.readFileSync(path.join(__dirname, "naver_collection_fallback.cjs"), "utf8");

const searchContract = Object.freeze({
  keyword: "Pocheon glamping",
  searchMode: "keyword",
  collectionPurpose: "revenue_detail",
  productMode: "all",
  collectionMode: "precision",
  collectionProfile: "revenue_detail_precision",
  detailRankRanges: "1-20",
  checkIn: "2026-08-10",
  checkOut: "2026-08-16",
  bookingRangeDays: 7,
  bookingRangePlaceLimit: 20
});

function candidate(overrides = {}) {
  const regionKey = overrides.regionKey || "kr_gyeonggi_pocheon";
  const candidateContract = overrides.searchContract || searchContract;
  const searchSignature = overrides.searchSignature || createNaverSearchContractSignature(candidateContract);
  const runId = overrides.runId || "run-pocheon-20260804";
  const completedAt = overrides.completedAt || "2026-08-04T08:00:00.000Z";
  const status = overrides.status || "ready";
  const snapshotOverrides = overrides.snapshot && typeof overrides.snapshot === "object" ? overrides.snapshot : {};
  const hasPublicProjection = Object.prototype.hasOwnProperty.call(overrides, "publicProjection");
  return {
    runId,
    regionKey,
    searchSignature,
    status,
    completedAt,
    snapshot: {
      runId,
      regionKey,
      searchSignature,
      status,
      asOf: completedAt,
      resultCount: 18,
      adminMemo: "PRIVATE_ADMIN_MEMO",
      providerFailureSubtype: "PRIVATE_INTERNAL_SUBTYPE",
      incidentHistory: [{ rawHtml: "PRIVATE_RAW_HTML" }],
      ...snapshotOverrides
    },
    publicProjection: hasPublicProjection ? overrides.publicProjection : {
      runId,
      regionKey,
      status: "stale",
      asOf: completedAt,
      resultCount: 18,
      label: "Last successful result",
      adminMemo: "MALICIOUS_PUBLIC_ADMIN_MEMO",
      internalPath: "/private/runtime",
      reviewNote: "MALICIOUS_PUBLIC_REVIEW_NOTE",
      providerDiagnostic: "MALICIOUS_PUBLIC_DIAGNOSTIC"
    },
    ...Object.fromEntries(Object.entries(overrides).filter(([key]) => !["snapshot", "publicProjection"].includes(key)))
  };
}

function assertNoPrivateB2BFields(value) {
  const serialized = JSON.stringify(value);
  for (const marker of [
    "PRIVATE_ADMIN_MEMO",
    "PRIVATE_INTERNAL_SUBTYPE",
    "PRIVATE_RAW_HTML",
    "MALICIOUS_PUBLIC_ADMIN_MEMO",
    "MALICIOUS_PUBLIC_SUBTYPE",
    "MALICIOUS_PUBLIC_HISTORY",
    "MALICIOUS_PUBLIC_ADMIN_CONTROL",
    "MALICIOUS_PUBLIC_REVIEW_NOTE",
    "MALICIOUS_PUBLIC_DIAGNOSTIC",
    "/private/runtime"
  ]) {
    assert.equal(serialized.includes(marker), false, `B2B projection leaked ${marker}`);
  }
  assert.doesNotMatch(serialized, /adminMemo|adminOnlyControl|providerFailureSubtype|incidentHistory|rawHtml|attemptHistory|internalPath|reviewNote|providerDiagnostic/i);
}

try {
  const request = {
    regionKey: "kr_gyeonggi_pocheon",
    searchSignature: createNaverSearchContractSignature(searchContract)
  };

  assert.equal(
    createNaverSearchContractSignature({ ...searchContract, keyword: "  POCHEON   GLAMPING " }),
    request.searchSignature,
    "canonical text normalization should produce a stable exact signature"
  );
  assert.notEqual(
    createNaverSearchContractSignature({ ...searchContract, detailRankRanges: "1-10" }),
    request.searchSignature,
    "rank-range changes must create a different search contract"
  );
  assert.notEqual(
    createNaverSearchContractSignature({ ...searchContract, checkOut: "2026-08-17" }),
    request.searchSignature,
    "measurement-period changes must create a different search contract"
  );
  for (const [field, value] of [
    ["searchMode", "company"],
    ["collectionPurpose", "demand_location"],
    ["productMode", "campnic"]
  ]) {
    assert.notEqual(
      createNaverSearchContractSignature({ ...searchContract, [field]: value }),
      request.searchSignature,
      `${field} changes must create a different search contract`
    );
  }
  assert.throws(
    () => createNaverSearchContractSignature({ keyword: "Pocheon glamping" }),
    NaverCollectionFallbackContractError,
    "incomplete contracts must fail closed"
  );
  assert.equal(matchesExactNaverFallback({
    ...request,
    searchContract: { ...searchContract, productMode: "campnic" }
  }, candidate()), false, "a supplied signature must agree with its supplied search contract");
  assert.throws(
    () => buildNaverCollectionFallbackState({ request, currentFailure: {}, candidates: [] }),
    NaverCollectionFallbackContractError,
    "a fixed asOf is required so the pure contract cannot read the system clock"
  );

  const exactOlder = candidate();
  const exactNewest = candidate({
    runId: "run-pocheon-20260805",
    completedAt: "2026-08-05T07:30:00.000Z",
    snapshot: { resultCount: 19 },
    publicProjection: { runId: "run-pocheon-20260805", regionKey: request.regionKey, status: "stale", asOf: "2026-08-05T07:30:00.000Z", resultCount: 19 }
  });
  const wrongRegion = candidate({
    runId: "run-sancheong-newer",
    regionKey: "kr_gyeongnam_sancheong",
    completedAt: "2026-08-05T09:00:00.000Z"
  });
  const wrongContract = candidate({
    runId: "run-pocheon-wrong-contract",
    searchContract: { ...searchContract, productMode: "campnic" },
    completedAt: "2026-08-05T10:00:00.000Z"
  });
  const missingAttempt = candidate({
    runId: "run-pocheon-missing",
    status: "missing",
    completedAt: "2026-08-05T11:00:00.000Z",
    snapshot: { runId: "run-pocheon-missing", status: "missing" }
  });

  assert.equal(matchesExactNaverFallback(request, exactOlder), true);
  assert.equal(matchesExactNaverFallback(request, wrongRegion), false, "cross-region fallback must be impossible");
  assert.equal(matchesExactNaverFallback(request, wrongContract), false, "other search contracts must not match");
  assert.equal(matchesExactNaverFallback(request, missingAttempt), false, "failed attempts are not last-known-good snapshots");
  assert.equal(matchesExactNaverFallback(request, candidate({
    status: "ready",
    snapshot: { status: "missing" }
  })), false, "conflicting outer and nested statuses must fail closed");
  assert.equal(matchesExactNaverFallback(request, candidate({
    snapshot: { regionKey: "kr_gyeongnam_hadong" }
  })), false, "conflicting nested region identity must fail closed");
  assert.equal(matchesExactNaverFallback(request, candidate({
    snapshot: { searchSignature: "different-contract-signature" }
  })), false, "conflicting nested search identity must fail closed");
  assert.equal(matchesExactNaverFallback(request, candidate({
    snapshot: { asOf: "2026-08-03T08:00:00.000Z" }
  })), false, "conflicting nested completion time must fail closed");
  assert.equal(matchesExactNaverFallback(request, candidate({
    canonicalRegionKey: "kr_gyeongnam_hadong"
  })), false, "conflicting outer region aliases must fail closed");
  assert.equal(matchesExactNaverFallback(request, candidate({
    contractSignature: "different-contract-signature"
  })), false, "conflicting outer signature aliases must fail closed");
  assert.equal(matchesExactNaverFallback(request, candidate({
    collectionStatus: "ready",
    status: "missing",
    snapshot: { collectionStatus: "ready", status: "missing" }
  })), false, "conflicting status aliases must fail closed");
  assert.equal(matchesExactNaverFallback(request, candidate({
    collectedAt: "2026-08-03T08:00:00.000Z"
  })), false, "conflicting outer time aliases must fail closed");
  assert.equal(matchesExactNaverFallback({
    ...request,
    canonicalRegionKey: "kr_gyeongnam_hadong"
  }, candidate()), false, "conflicting request region aliases must fail closed");
  assert.equal(matchesExactNaverFallback({
    regionKey: `kr_${"a".repeat(110)}`,
    searchSignature: request.searchSignature
  }, candidate({ regionKey: `kr_${"a".repeat(109)}b` })), false, "overlong region identities must not collide after truncation");
  assert.equal(matchesExactNaverFallback({
    regionKey: request.regionKey,
    searchSignature: `${request.searchSignature}${"a".repeat(120)}`
  }, candidate()), false, "overlong signatures must fail closed instead of being truncated");
  assert.equal(matchesExactNaverFallback(request, candidate({
    runId: "run-1!",
    snapshot: { runId: "run-1" }
  })), false, "malformed run IDs must not match after character deletion");

  const selected = selectLastKnownGoodNaverFallback(request, [wrongRegion, wrongContract, missingAttempt, exactOlder, exactNewest]);
  assert.equal(selected.runId, exactNewest.runId, "latest exact last-known-good result should win");
  assert.equal(selected.regionKey, request.regionKey);
  assert.equal(selected.searchSignature, request.searchSignature);

  const zeroResult = candidate({
    runId: "run-pocheon-zero",
    status: "zero",
    completedAt: "2026-08-05T12:00:00.000Z",
    snapshot: { resultCount: 0 },
    publicProjection: { runId: "run-pocheon-zero", regionKey: request.regionKey, status: "zero", asOf: "2026-08-05T12:00:00.000Z", resultCount: 0 }
  });
  assert.equal(matchesExactNaverFallback(request, zeroResult), true, "zero is a successful observation, not missing");

  const state = buildNaverCollectionFallbackState({
    request,
    currentFailure: {
      code: "NAVER_ACCESS_BLOCKED",
      providerFailureSubtype: "http_403",
      diagnosticId: "crawl-fixture-403",
      occurredAt: "2026-08-05T12:00:00.000Z",
      rawHtml: "MUST_NOT_BE_COPIED",
      adminMemo: "MUST_NOT_BE_COPIED"
    },
    candidates: [wrongRegion, wrongContract, missingAttempt, exactOlder],
    asOf: "2026-08-05T12:00:00.000Z"
  });
  assert.equal(state.status, "blocked", "the current failed attempt remains blocked");
  assert.equal(state.currentCollectionFailure.status, "blocked");
  assert.equal(state.currentCollectionFailure.providerFailureSubtype, "http_403");
  assert.equal(Object.hasOwn(state.currentCollectionFailure, "rawHtml"), false);
  assert.equal(Object.hasOwn(state.currentCollectionFailure, "adminMemo"), false);
  assert.equal(state.fallbackRunId, exactOlder.runId);
  assert.equal(state.fallbackReason, "last_known_good_exact_contract");
  assert.equal(state.fallbackFreshness.status, "stale", "fallback is never represented as the current result");
  assert.equal(state.fallbackFreshness.reason, "current_collection_blocked");

  const b2b = projectNaverCollectionFallbackForB2B(state);
  assert.equal(b2b.status, "blocked");
  assert.equal(b2b.currentCollectionFailure.code, "NAVER_ACCESS_BLOCKED");
  assert.equal(Object.hasOwn(b2b.currentCollectionFailure, "providerFailureSubtype"), false);
  assert.equal(b2b.fallbackFreshness.status, "stale");
  assert.equal(b2b.fallbackRunId, exactOlder.runId);
  assert.equal(b2b.fallbackSnapshot.resultCount, 18);
  assert.deepEqual(Object.keys(b2b.fallbackSnapshot).sort(), ["asOf", "label", "regionKey", "resultCount", "runId", "status"].sort());
  assertNoPrivateB2BFields(b2b);

  const noExactState = buildNaverCollectionFallbackState({
    request,
    currentFailure: { code: "NAVER_PROVIDER_COOLDOWN_ACTIVE", diagnosticId: "crawl-fixture-cooldown" },
    candidates: [wrongRegion, wrongContract, missingAttempt],
    asOf: "2026-08-05T12:00:00.000Z"
  });
  assert.equal(noExactState.fallbackSnapshot, null);
  assert.equal(noExactState.fallbackFreshness.status, "missing");
  assert.equal(noExactState.fallbackReason, "no_exact_last_known_good");

  const futureOnlyState = buildNaverCollectionFallbackState({
    request,
    currentFailure: { code: "NAVER_ACCESS_BLOCKED" },
    candidates: [candidate({
      runId: "run-future-corrupt",
      completedAt: "2026-08-06T12:00:00.000Z"
    })],
    asOf: "2026-08-05T12:00:00.000Z"
  });
  assert.equal(futureOnlyState.fallbackSnapshot, null, "future-dated snapshots cannot become last-known-good");

  const noPublicProjectionState = buildNaverCollectionFallbackState({
    request,
    currentFailure: { code: "NAVER_ACCESS_BLOCKED" },
    candidates: [candidate({ publicProjection: null })],
    asOf: "2026-08-05T12:00:00.000Z"
  });
  assert.ok(noPublicProjectionState.fallbackSnapshot, "admin/internal state may preserve the exact snapshot");
  const noPublicProjection = projectNaverCollectionFallbackForB2B(noPublicProjectionState);
  assert.equal(noPublicProjection.fallbackSnapshot, null, "B2B fallback must fail closed without an explicit public projection");
  assert.equal(noPublicProjection.fallbackRunId, null);
  assert.equal(noPublicProjection.fallbackFreshness.status, "missing");

  const mismatchedPublicState = {
    ...state,
    fallbackPublicProjection: {
      runId: "run-hadong-private-mismatch",
      regionKey: "kr_gyeongnam_hadong",
      status: "stale",
      asOf: state.fallbackAsOf
    }
  };
  const mismatchedPublicProjection = projectNaverCollectionFallbackForB2B(mismatchedPublicState);
  assert.equal(mismatchedPublicProjection.fallbackAvailable, false, "public fallback identity mismatch must fail closed");
  assert.equal(mismatchedPublicProjection.fallbackSnapshot, null);
  assert.equal(mismatchedPublicProjection.fallbackRunId, null);

  const missingCountState = {
    ...state,
    fallbackPublicProjection: {
      runId: state.fallbackRunId,
      regionKey: state.regionKey,
      status: "stale",
      asOf: state.fallbackAsOf,
      resultCount: null
    }
  };
  const missingCountProjection = projectNaverCollectionFallbackForB2B(missingCountState);
  assert.equal(Object.hasOwn(missingCountProjection.fallbackSnapshot, "resultCount"), false, "missing result count must not become zero");
  for (const nonNumericCount of ["", "   ", false]) {
    const nonNumericCountProjection = projectNaverCollectionFallbackForB2B({
      ...missingCountState,
      fallbackPublicProjection: { ...missingCountState.fallbackPublicProjection, resultCount: nonNumericCount }
    });
    assert.equal(Object.hasOwn(nonNumericCountProjection.fallbackSnapshot, "resultCount"), false, "non-numeric count must remain missing");
  }

  assert.deepEqual(
    decideNaverQuotaConsumption({ cooldownPrevented: true }),
    { consumeQuota: false, reason: "provider_cooldown_prevented", existingPolicyApplied: false }
  );
  assert.deepEqual(
    decideNaverQuotaConsumption({ reused: true }),
    { consumeQuota: false, reason: "existing_result_reused", existingPolicyApplied: false }
  );
  assert.deepEqual(
    decideNaverQuotaConsumption({ providerRequestAttempted: false }),
    { consumeQuota: false, reason: "provider_request_not_attempted", existingPolicyApplied: false }
  );
  assert.deepEqual(
    decideNaverQuotaConsumption({ providerRequestAttempted: true, existingPolicyConsumesQuota: true }),
    { consumeQuota: true, reason: "existing_policy_after_provider_attempt", existingPolicyApplied: true }
  );
  assert.deepEqual(
    decideNaverQuotaConsumption({ providerRequestAttempted: true, existingPolicyConsumesQuota: false }),
    { consumeQuota: false, reason: "existing_policy_after_provider_attempt", existingPolicyApplied: true },
    "an attempted provider request must preserve the caller's existing quota policy"
  );
  assert.throws(
    () => decideNaverQuotaConsumption({ cooldownPrevented: true, providerRequestAttempted: true }),
    NaverCollectionFallbackContractError
  );

  assert.doesNotMatch(
    contractSource,
    /\bfetch\s*\(|https?\.(?:get|request)\s*\(|\baxios\b|XMLHttpRequest|WebSocket/,
    "fallback contract must not contain network execution paths"
  );
  const serverSource = fs.readFileSync(path.join(__dirname, "glamping_app_server.cjs"), "utf8");
  assert.match(serverSource, /decideNaverQuotaConsumption\(\{ reused: true \}\)/, "shared jobs must apply the no-duplicate quota contract");
  assert.equal(networkGuard.blockedAttempts(), 0, "fallback fixtures must never call the network");
  console.log("NAVER last-known-good fallback contract fixture checks passed");
} finally {
  networkGuard.restore();
}
