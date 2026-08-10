"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { installFixtureNetworkGuard } = require("./fixture_network_guard.cjs");

const guard = installFixtureNetworkGuard({ label: "booking-detail probe gate fixtures" });
try {
  const server = fs.readFileSync(path.join(__dirname, "glamping_app_server.cjs"), "utf8");
  const worker = fs.readFileSync(path.join(__dirname, "collection_worker_v2_top20_worker.cjs"), "utf8");
  const supervisor = fs.readFileSync(path.join(__dirname, "collection_worker_supervisor.cjs"), "utf8");
  assert.match(server, /webFeatureGateEnabled/u);
  assert.match(server, /workerFeatureGateEnabled/u);
  assert.match(server, /featureGateMatched/u);
  assert.match(server, /bookingDetailProbeTransportReady/u);
  assert.match(server, /COLLECTION_WORKER_BOOKING_DETAIL_PROBE_GATE_MISMATCH/u);
  assert.match(server, /assertBookingDetailProbeTransportReady\(\)/u);
  const queueStart = server.indexOf("async function queueBookingDetailRecoveryProbe()");
  const queueEnd = server.indexOf("async function bookingDetailRecoveryProbePrepareDryRun()", queueStart);
  const queueSource = server.slice(queueStart, queueEnd);
  assert.ok(queueSource.indexOf("assertBookingDetailProbeTransportReady()") < queueSource.indexOf("restoreActiveTop20WorkerJob()"));
  assert.match(worker, /capabilities:\s*\{[\s\S]{0,180}bookingDetailRecoveryProbe/u);
  assert.match(supervisor, /bookingDetailProbeEnabled/u);
  assert.equal(guard.blockedAttempts(), 0);
  console.log("booking-detail probe gate fixtures passed");
} finally {
  guard.restore();
}
