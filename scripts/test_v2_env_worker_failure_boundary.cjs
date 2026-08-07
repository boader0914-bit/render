"use strict";

const assert = require("node:assert/strict");
const { adaptPreviewCrawlToV2EnvWorkerCanary } = require("./v2_env_worker_job_adapter.cjs");
const { assertNoStoreMutationLedger, projectV2EnvWorkerNoStoreResult } = require("./v2_env_worker_no_store_canary.cjs");

const contract = {
  keyword: "Synthetic failure query", searchMode: "keyword", collectionMode: "precision",
  collectionPurpose: "revenue_detail", productMode: "all", checkIn: "2026-08-07", checkOut: "2026-08-07",
  rankStart: 1, rankEnd: 50, detailRankStart: 1, detailRankEnd: 3
};
const blocked = adaptPreviewCrawlToV2EnvWorkerCanary(contract, {
  enabled: true, externalCallApproved: true, oneShotApprovalPresent: true, targetCommit: "d".repeat(40),
  circuitState: { state: "open", retryAt: "2026-08-07T02:00:00.000Z" }
});
assert.equal(blocked.jobPlanned, false);
assert.equal(blocked.executedCallCount, 0);
for (const providerSubtype of ["http_403", "http_429", "challenge_html", "unknown_access_block"]) {
  const failure = projectV2EnvWorkerNoStoreResult({
    status: "blocked", code: "NAVER_ACCESS_BLOCKED", diagnosticId: "crawl-abcdef123456",
    providerFailureSubtype: providerSubtype, startedAt: "2026-08-07T01:00:00.000Z",
    completedAt: "2026-08-07T01:00:01.000Z"
  });
  assert.equal(failure.providerSubtype, providerSubtype);
  assert.equal(failure.organicCount, null);
  assert.equal(failure.observedRankCount, null);
}
assertNoStoreMutationLedger({ runWrites: 0, manifestWrites: 0, companyWrites: 0, productWrites: 0, historyWrites: 0, regionInsightWrites: 0 });
console.log("V2 environment Worker failure boundary fixture checks passed");
