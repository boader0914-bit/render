"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { installFixtureNetworkGuard } = require("./fixture_network_guard.cjs");

const guard = installFixtureNetworkGuard({ label: "booking-detail probe terminal contract fixtures" });

try {
  const server = fs.readFileSync(path.join(__dirname, "glamping_app_server.cjs"), "utf8");
  const orchestrator = fs.readFileSync(path.join(__dirname, "collection_worker_v2_top20_orchestrator.cjs"), "utf8");
  const worker = fs.readFileSync(path.join(__dirname, "collection_worker_v2_top20_worker.cjs"), "utf8");
  assert.match(server, /booking-detail-recovery-probe\/status/u);
  assert.match(server, /queueBookingDetailRecoveryProbe\(\)/u);
  assert.match(orchestrator, /finalizeBookingDetailRecoveryProbe/u);
  assert.match(orchestrator, /BOOKING_DETAIL_PROBE_TARGET_STALE/u);
  assert.match(orchestrator, /detailProviderStore\.recordSuccess/u);
  assert.match(orchestrator, /detailProviderStore\.releaseAttempt/u);
  assert.match(worker, /COLLECTION_WORKER_BOOKING_DETAIL_PROBE_DISABLED/u);
  assert.match(worker, /COLLECTION_WORKER_V2_TOP20_BOOKING_DETAIL_PROBE_FINALIZE_PATH/u);
  assert.equal(guard.blockedAttempts(), 0);
  console.log("booking-detail probe terminal fixtures passed");
} finally {
  guard.restore();
}
