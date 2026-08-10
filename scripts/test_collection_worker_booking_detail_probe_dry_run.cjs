"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { installFixtureNetworkGuard } = require("./fixture_network_guard.cjs");

const guard = installFixtureNetworkGuard({ label: "booking-detail probe dry-run fixtures" });
try {
  const server = fs.readFileSync(path.join(__dirname, "glamping_app_server.cjs"), "utf8");
  assert.match(server, /booking-detail-recovery-probe\/prepare-dry-run/u);
  assert.match(server, /async function bookingDetailRecoveryProbePrepareDryRun/u);
  assert.match(server, /providerReservationCreated:\s*false/u);
  assert.match(server, /workerClaimStarted:\s*false/u);
  assert.match(server, /providerCallCount:\s*0/u);
  assert.match(server, /writeCount:\s*0/u);
  assert.match(server, /buildBookingDetailProbeExecutionIdempotencyKey/u);
  assert.equal(guard.blockedAttempts(), 0);
  console.log("booking-detail probe dry-run fixtures passed");
} finally {
  guard.restore();
}
