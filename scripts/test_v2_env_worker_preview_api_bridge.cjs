"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  PRESERVED_PREVIEW_ENDPOINTS,
  V2_ENV_WORKER_OPERATOR_PATH,
  V2_ENV_WORKER_STATUS_PATH,
  projectV2EnvWorkerPrepared,
  projectV2EnvWorkerStatus,
  v2EnvWorkerOperatorPage
} = require("./v2_env_worker_preview_api_bridge.cjs");

const source = fs.readFileSync(path.join(__dirname, "glamping_app_server.cjs"), "utf8");
for (const endpoint of ["/api/crawl-estimate", "/api/crawl", "/api/crawl-status", "/api/crawl/cancel", "/api/runs", "/api/member/runs/"]) {
  assert.equal(source.includes(endpoint), true);
}
assert.equal(PRESERVED_PREVIEW_ENDPOINTS.length, 7);
assert.match(source, /reqUrl\.pathname === V2_ENV_WORKER_STATUS_PATH/u);
assert.match(source, /reqUrl\.pathname === V2_ENV_WORKER_OPERATOR_PATH/u);
assert.match(source, /prepareFromAdminSession/u);
assert.match(source, /prepareFromSignedWorkerRequest/u);
const status = projectV2EnvWorkerStatus({ enabled: true, targetWorkerCommit: "e".repeat(40), internalSecret: "forbidden", query: "forbidden" });
assert.equal(V2_ENV_WORKER_STATUS_PATH, "/api/admin/collection-worker/v2-env-canary/status");
assert.equal(V2_ENV_WORKER_OPERATOR_PATH, "/admin/collection-worker/v2-env-canary");
assert.equal(status.strategy, "v2_env_4e4e190_worker");
assert.equal(status.phase, "naver_place_first_request_only");
assert.equal(status.saveResult, false);
assert.equal(status.actualCallsEnabled, false);
assert.equal(status.executedCallCount, 0);
assert.doesNotMatch(JSON.stringify(status), /forbidden/u);
const prepared = projectV2EnvWorkerPrepared({
  status: "queued",
  jobId: "job-canary-0123456789abcdef",
  providerState: "probe_allowed",
  query: "forbidden"
});
assert.equal(prepared.status, "queued");
assert.equal(prepared.maxProviderAttempts, 1);
assert.equal(prepared.saveResult, false);
assert.doesNotMatch(JSON.stringify(prepared), /forbidden/u);
const page = v2EnvWorkerOperatorPage({ date: "2026-08-07", result: prepared });
assert.match(page, /method="post"/u);
assert.match(page, /결과 저장 안 함/u);
assert.doesNotMatch(page, /job-canary-0123456789abcdef/u);
console.log("V2 environment Worker Preview API bridge fixture checks passed");
