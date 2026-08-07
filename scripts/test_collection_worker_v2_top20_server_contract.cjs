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
  detailRankRanges: "1-3",
  bookingRangePlaceLimit: 3
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
assert.equal(__test.isV2Top20WorkerEligible(request), true);
assert.equal(__test.isV2Top20WorkerEligible({ ...request, searchMode: "company" }), false);
assert.equal(__test.isV2Top20WorkerEligible({ ...request, checkOut: "2026-08-07" }), false);
assert.equal(__test.isV2Top20WorkerEligible({ ...request, collectionMode: "fast" }), false);
assert.equal(__test.isV2Top20WorkerEligible({ ...request, collectionPurpose: "basic_db" }), false);
assert.equal(__test.isV2Top20WorkerEligible({ ...request, productMode: "lodging" }), false);

const root = path.resolve(__dirname, "..");
const serverSource = fs.readFileSync(path.join(__dirname, "glamping_app_server.cjs"), "utf8");
const appSource = fs.readFileSync(path.join(root, "web", "app.js"), "utf8");
assert.match(serverSource, /collectionWorkerV2Top20Orchestrator\.prepareTrustedAdmin/u);
assert.match(serverSource, /collectionWorkerRunTransactionStore\.finalizeVerifiedRunBundle/u);
assert.match(serverSource, /naverProviderHealthStore\.releaseAttempt/u);
assert.match(serverSource, /collection-worker-v2-top20-cancel\.v1/u);
assert.match(serverSource, /String\(payload\?\.body\?\.jobId \|\| ""\)\.startsWith\("job-top20-"\)/u);
assert.match(serverSource, /useTop20Worker \? 202 : 200/u);
assert.match(serverSource, /const adminPayload = trustedPreviewAdminCrawlPayload\(/u);
assert.match(serverSource, /&& isV2Top20WorkerEligible\(adminPayload\)/u);
assert.match(serverSource, /const trustedPayload = useTop20Worker[\s\S]{0,120}trustedPreviewFrozenCrawlPayload\(adminPayload\)/u);
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
console.log("collection worker V2 top20 server/UI contract fixtures passed");
