"use strict";

const assert = require("node:assert/strict");
const { adaptPreviewCrawlToV2EnvWorkerCanary, assertPrivateExecutionContract } = require("./v2_env_worker_job_adapter.cjs");

const contract = Object.freeze({
  keyword: "Synthetic lodging query", searchMode: "keyword", collectionMode: "precision",
  collectionPurpose: "revenue_detail", productMode: "all", checkIn: "2026-08-07", checkOut: "2026-08-07",
  rankStart: 1, rankEnd: 50, detailRankStart: 1, detailRankEnd: 3
});
assert.equal(assertPrivateExecutionContract(contract), contract);
const planned = adaptPreviewCrawlToV2EnvWorkerCanary(contract, {
  targetCommit: "b".repeat(40), enabled: true, externalCallApproved: true, oneShotApprovalPresent: true,
  circuitState: { state: "closed" }
});
assert.equal(planned.jobPlanned, true);
assert.equal(planned.maxProviderAttempts, 1);
assert.equal(planned.currentPlannerUsed, false);
assert.equal(planned.top20PlannerUsed, false);
assert.equal(planned.regionCollectionUsed, false);
assert.equal(planned.saveResult, false);
assert.doesNotMatch(JSON.stringify(planned), /Synthetic lodging query/u);
const blocked = adaptPreviewCrawlToV2EnvWorkerCanary(contract, {
  targetCommit: "b".repeat(40), enabled: true, externalCallApproved: true, oneShotApprovalPresent: true,
  circuitState: { state: "open", retryAt: "2026-08-07T12:00:00.000Z" }
});
assert.equal(blocked.jobPlanned, false);
assert.equal(blocked.maxProviderAttempts, 0);
assert.equal(blocked.blocker, "provider_circuit_open");
assert.equal(blocked.executedCallCount, 0);
console.log("V2 environment Worker job adapter fixture checks passed");
