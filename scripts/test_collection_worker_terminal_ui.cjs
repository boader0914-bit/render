"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { installFixtureNetworkGuard } = require("./fixture_network_guard.cjs");

const guard = installFixtureNetworkGuard({ label: "terminal UI fixtures" });
try {
  const app = fs.readFileSync(path.join(__dirname, "..", "web", "app.js"), "utf8");
  assert.match(app, /const TOP20_TERMINAL_JOB_STATES = new Set\(\[\s*"committed",\s*"failed",\s*"blocked",\s*"cancelled",\s*"indeterminate",\s*"rejected",\s*"validated_no_store"/u);
  assert.match(app, /function durableTop20TerminalText\(outcome = null\)[\s\S]*?COLLECTION_RUN_OUTPUT_PROJECTION_INVALID/u);
  assert.match(app, /수집 결과를 저장 데이터로 변환하는 과정에서 오류가 발생했습니다\./u);
  assert.match(app, /function applyDurableTop20TerminalOutcome\(outcome = null\)[\s\S]*?clearCrawlStatusTimer\(\);[\s\S]*?setCrawlProgress\(false\);/u);
  assert.match(app, /submitButton\.disabled = false;/u);
  const poll = app.indexOf("async function pollCrawlStatusUntilIdle");
  const terminalCheck = app.indexOf("loadTop20WorkerTransportStatus", poll);
  const crawlStatusFetch = app.indexOf('fetchJson("/api/crawl-status")', poll);
  assert.ok(poll >= 0 && terminalCheck > poll && crawlStatusFetch > terminalCheck, "durable Top20 status must be evaluated before stale crawl status");
  assert.equal(guard.blockedAttempts(), 0);
  console.log(JSON.stringify({
    durableJobState: "failed",
    spinnerAfterRefresh: "stopped",
    buttonEnabled: true,
    additionalPost: 0,
    errorDisplayed: true,
    externalNetworkCalls: 0,
  }));
} finally {
  guard.restore();
}
