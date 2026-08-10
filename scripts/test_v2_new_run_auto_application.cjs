"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { installFixtureNetworkGuard } = require("./fixture_network_guard.cjs");

const guard = installFixtureNetworkGuard({ allowLocalhost: false });

try {
  const source = fs.readFileSync(path.join(__dirname, "glamping_app_server.cjs"), "utf8");
  const transactionIndex = source.indexOf(".finalizeVerifiedRunBundle({");
  const applicationIndex = source.indexOf("await applyCommittedWorkerProjection(receipt.runId);");

  assert.ok(transactionIndex >= 0, "verified Worker transaction must exist");
  assert.ok(applicationIndex > transactionIndex, "new Worker projections must apply after the immutable Run commits");
  assert.match(
    source,
    /Application failure is deliberately[\s\S]{0,120}non-terminal/u,
    "projection application failure must not invalidate a committed complete, partial, or rank_only Run"
  );
  assert.match(
    source,
    /collection_worker_projection_application_deferred/u,
    "deferred projection application must use the safe terminal diagnostic event"
  );
  assert.equal(guard.blockedAttempts(), 0, "auto-application contract fixture must not call the network");

  console.log("V2 new committed Run auto-application fixture passed");
} finally {
  guard.restore();
}
