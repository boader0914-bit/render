"use strict";

const assert = require("node:assert/strict");
const { assertNoStoreMutationLedger, projectV2EnvWorkerNoStoreResult } = require("./v2_env_worker_no_store_canary.cjs");

const projected = projectV2EnvWorkerNoStoreResult({
  status: "ready", diagnosticId: "crawl-123456789abc", startedAt: "2026-08-07T01:00:00.000Z",
  completedAt: "2026-08-07T01:00:01.000Z", organicCount: 50, adCount: 2, observedRankCount: 50,
  rawHtml: "forbidden", url: "https://forbidden.invalid", keyword: "forbidden query",
  headers: { authorization: "forbidden" }
});
assert.deepEqual(Object.keys(projected), [
  "status", "strategy", "phase", "code", "diagnosticId", "startedAt", "completedAt",
  "providerSubtype", "observedRankCount", "organicCount", "adCount", "providerAttemptCount",
  "executedCallCount", "resultStored", "writeCount"
]);
assert.equal(projected.strategy, "v2_env_4e4e190_worker");
assert.equal(projected.phase, "naver_place_first_request_only");
assert.equal(projected.providerSubtype, "apollo_success");
assert.doesNotMatch(JSON.stringify(projected), /forbidden/u);
const ledger = assertNoStoreMutationLedger({});
assert.equal(Object.values(ledger).reduce((sum, value) => sum + value, 0), 0);
assert.throws(() => assertNoStoreMutationLedger({ runWrites: 1 }), { code: "V2_ENV_WORKER_WRITE_DETECTED" });
console.log("V2 environment Worker no-store Canary fixture checks passed");
