"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { __test } = require("./glamping_app_server.cjs");

const request = {
  keyword: "Synthetic regional lodging",
  checkIn: "2026-08-06",
  checkOut: "2026-08-06",
  searchMode: "keyword",
  productMode: "all",
  collectionMode: "precision",
  collectionPurpose: "revenue_detail",
  detailRankRanges: "1-20",
  bookingRangePlaceLimit: 0
};

const contract = __test.v2Top20WorkerContract(request);
assert.deepEqual(contract, {
  keyword: request.keyword,
  searchMode: "keyword",
  collectionMode: "precision",
  collectionPurpose: "revenue_detail",
  productMode: "all",
  checkIn: "2026-08-06",
  checkOut: "2026-08-06",
  rankStart: 1,
  rankEnd: 50,
  detailRankStart: 1,
  detailRankEnd: 20
});
assert.throws(
  () => __test.v2Top20WorkerContract({ ...request, checkOut: "2026-08-07" }),
  (error) => error?.code === "COLLECTION_WORKER_V2_TOP20_CONTRACT_INVALID"
);
assert.throws(
  () => __test.v2Top20WorkerContract({ ...request, collectionMode: "fast" }),
  (error) => error?.code === "COLLECTION_WORKER_V2_TOP20_CONTRACT_INVALID"
);
assert.throws(
  () => __test.v2Top20WorkerContract({ ...request, detailRankRanges: "1-10" }),
  (error) => error?.code === "COLLECTION_WORKER_V2_TOP20_CONTRACT_INVALID"
);
assert.equal(__test.isV2Top20WorkerEligible(request), true);
assert.equal(__test.isV2Top20WorkerEligible({ ...request, searchMode: "company" }), false);
assert.equal(__test.isV2Top20WorkerEligible({ ...request, checkOut: "2026-08-07" }), false);
assert.equal(__test.isV2Top20WorkerEligible({ ...request, collectionMode: "fast" }), false);
assert.equal(__test.isV2Top20WorkerEligible({ ...request, collectionPurpose: "basic_db" }), false);
assert.equal(__test.isV2Top20WorkerEligible({ ...request, productMode: "lodging" }), false);
assert.equal(__test.isV2Top20WorkerEligible({ ...request, detailRankRanges: "1-10" }), false);
assert.equal(__test.isExplicitLegacyFrozenCrawlRequest({ collectorBackend: "legacy_frozen" }), true);
assert.equal(__test.isExplicitLegacyFrozenCrawlRequest({}), false);

const projectedProbe = __test.projectTop20TerminalOutcome({
  jobId: "job-top20-probe",
  state: "validated_no_store",
  failureCode: ""
});
assert.deepEqual(projectedProbe, {
  status: "ready",
  success: true,
  operationKind: "main_place_recovery_probe",
  jobState: "validated_no_store",
  noStore: true,
  resultStored: false,
  writeCount: 0,
  code: null,
  jobId: "job-top20-probe",
  runId: null,
  providerAttemptCount: null,
  executedCallCount: null,
  failureStage: null,
  projectionReason: null,
  collectionStatus: null,
  lastProviderOperation: null,
  lastRequestOrdinal: null
});
assert.deepEqual(__test.projectTop20TerminalOutcome({ jobId: "job-top20-full", state: "committed" }, { runId: "run-1", writeCount: 3 }), {
  status: "ready",
  success: true,
  operationKind: "full_collection",
  jobState: "committed",
  noStore: false,
  resultStored: true,
  writeCount: 3,
  code: null,
  jobId: "job-top20-full",
  runId: "run-1",
  providerAttemptCount: null,
  executedCallCount: null,
  failureStage: null,
  projectionReason: null,
  collectionStatus: null,
  lastProviderOperation: null,
  lastRequestOrdinal: null
});
assert.equal(__test.projectTop20TerminalOutcome({ jobId: "job-top20-blocked", state: "blocked", failureCode: "NAVER_ACCESS_BLOCKED" }).status, "blocked");
assert.equal(__test.projectTop20TerminalOutcome({ jobId: "job-top20-failed", state: "indeterminate", failureCode: "TEST_FAILED" }).status, "failed");
const adminArtifactFailure = __test.projectAdminTop20TerminalOutcome(
  { status: "failed", jobId: "job-top20-artifact", code: "COLLECTION_ARTIFACT_SENSITIVE_CONTENT", resultStored: false, writeCount: 0 },
  { jobs: [{ jobId: "job-top20-artifact", providerAttemptCount: 1 }] },
  { detector: "sensitive_key", fileRole: "platform_csv", providerAttemptCount: 1, executedCallCount: 81, lastProviderOperation: "daily_schedule", lastRequestOrdinal: 81 }
);
assert.deepEqual(adminArtifactFailure, {
  status: "failed",
  jobId: "job-top20-artifact",
  code: "COLLECTION_ARTIFACT_SENSITIVE_CONTENT",
  resultStored: false,
  writeCount: 0,
  providerAttemptCount: 1,
  executedCallCount: 81,
  lastProviderOperation: "daily_schedule",
  lastRequestOrdinal: 81,
  detector: "sensitive_key",
  fileRole: "platform_csv",
  failureStage: null,
  projectionReason: null,
  collectionStatus: null
});

const root = path.resolve(__dirname, "..");
const serverSource = fs.readFileSync(path.join(__dirname, "glamping_app_server.cjs"), "utf8");
const appSource = fs.readFileSync(path.join(root, "web", "app.js"), "utf8");
assert.match(serverSource, /collectionWorkerV2Top20Orchestrator\.prepareTrustedAdmin/u);
assert.match(serverSource, /executionRequestId: top20ExecutionRequestIdFromPayload\(payload\)/u);
assert.match(serverSource, /\? "dispatch-readiness"\s*:\s*"prepare"/u);
assert.match(serverSource, /assertTop20WorkerTransportReady\(\)/u);
assert.match(serverSource, /COLLECTION_WORKER_V2_TOP20_RUNTIME_ATTEST_PATH/u);
assert.match(serverSource, /sendCollectionWorkerJson\(/u);
assert.match(serverSource, /COLLECTION_WORKER_V2_TOP20_DISPATCH_TIMEOUT/u);
assert.match(serverSource, /prepareDryRunTrustedAdmin/u);
assert.match(serverSource, /collectionWorkerRunTransactionStore\.finalizeVerifiedRunBundle/u);
assert.match(serverSource, /naverProviderHealthStore\.releaseAttempt/u);
assert.match(serverSource, /collection-worker-v2-top20-cancel\.v1/u);
assert.match(serverSource, /String\(payload\?\.body\?\.jobId \|\| ""\)\.startsWith\("job-top20-"\)/u);
assert.match(serverSource, /useTop20Worker \? 202 : 200/u);
assert.match(serverSource, /const adminPayload = trustedPreviewAdminCrawlPayload\(/u);
assert.match(serverSource, /&& isV2Top20WorkerEligible\(adminPayload\)/u);
assert.match(serverSource, /const explicitLegacyFrozen = isExplicitLegacyFrozenCrawlRequest\(payload\)/u);
assert.match(serverSource, /top20WorkerEnabled && !explicitLegacyFrozen && !useTop20Worker[\s\S]{0,80}v2Top20WorkerContract\(adminPayload\)/u);
assert.match(serverSource, /const trustedPayload = useTop20Worker[\s\S]{0,160}trustedPreviewFrozenCrawlPayload\(adminPayload\)/u);
assert.equal(
  serverSource.includes("isV2Top20WorkerEligible(trustedPayload)"),
  false,
  "Top20 eligibility must be evaluated before frozen wrapping"
);
assert.ok(
  serverSource.indexOf("const useTop20Worker =") < serverSource.indexOf("trustedPreviewFrozenCrawlPayload(adminPayload)"),
  "Top20 Worker branch must be selected before the frozen V2 route is constructed"
);
assert.match(serverSource, /reqUrl\.pathname === "\/api\/crawl\/cancel"/u);
assert.match(serverSource, /collectionWorkerJobStore\.requestCancellation/u);
assert.match(serverSource, /nextState: "cancelled"/u);
assert.match(serverSource, /message: "Worker 수집 중지를 요청했습니다\. 실행 중인 호출이 종료되면 안전하게 중단합니다\."/u);
assert.match(serverSource, /job\.state !== "queued"/u);
assert.match(serverSource, /workerOutcome\.job\.cancellationRequested === true/u);
assert.match(appSource, /result\.queued && result\.worker/u);
assert.match(appSource, /상위 20곳의 재고·가격·예상매출/u);
assert.match(appSource, /workerOutcome\.status === "ready" && workerOutcome\.runId/u);
assert.match(appSource, /workerOutcome\.status === "ready" && workerOutcome\.noStore === true && workerOutcome\.operationKind === "main_place_recovery_probe"/u);
assert.match(appSource, /네이버 메인 순위 연결 확인이 완료되었습니다/u);
assert.match(appSource, /await loadTop20WorkerTransportStatus\(\);/u);
assert.match(serverSource, /lastProbeOutcome/u);
assert.match(serverSource, /recordArtifactSecurityDiagnostic/u);
assert.match(serverSource, /COLLECTION_WORKER_V2_TOP20_ARTIFACT_DIAGNOSTIC_PATH/u);
console.log("collection worker V2 top20 server/UI contract fixtures passed");
