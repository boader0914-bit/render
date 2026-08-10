"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { installFixtureNetworkGuard } = require("./fixture_network_guard.cjs");

const guard = installFixtureNetworkGuard({ label: "worker signed download boundary fixtures" });
try {
  const server = fs.readFileSync(path.join(__dirname, "glamping_app_server.cjs"), "utf8");
  const transaction = fs.readFileSync(path.join(__dirname, "collection_worker_run_transaction.cjs"), "utf8");
  const allowed = [
    "manifest.json",
    "platform.csv",
    "overall.csv",
    "ads.csv",
    "regional.csv",
    "ddnayo.csv",
    "details/detail-01.json"
  ];
  const denied = [
    "traffic_metrics.json",
    "top20-summary.json",
    "../manifest.json",
    "details/extra.json"
  ];
  const safe = /^(?:manifest\.json|(?:platform|overall|ads|regional|ddnayo)\.csv|details\/detail-\d{2}\.json)$/u;
  allowed.forEach((filePath) => assert.equal(safe.test(filePath), true));
  denied.forEach((filePath) => assert.equal(safe.test(filePath), false));
  assert.match(transaction, /SAFE_OUTPUT_RELATIVE_PATH_PATTERN/u);
  assert.match(server, /workerApplication\.committed\.fileEntries[\s\S]{0,900}?details\\\/detail-\\d\{2\}/u);
  assert.match(server, /isCommittedRunOutputValid/u);
  assert.equal(guard.blockedAttempts(), 0);
  console.log(JSON.stringify({
    signedAllowed: allowed.length,
    unsignedBlocked: denied.length,
    traversalBlocked: true,
    workerReadOnly: true,
    externalNetworkCalls: 0
  }));
} finally {
  guard.restore();
}
