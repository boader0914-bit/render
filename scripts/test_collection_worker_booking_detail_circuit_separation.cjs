"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createNaverProviderHealthStore } = require("./naver_provider_health_store.cjs");
const { installFixtureNetworkGuard } = require("./fixture_network_guard.cjs");

const guard = installFixtureNetworkGuard({ label: "booking-detail circuit separation fixtures" });

(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "booking-detail-circuit-separation-"));
  try {
    const main = createNaverProviderHealthStore({ filePath: path.join(root, "main.json"), runtimeRoot: root });
    const detail = createNaverProviderHealthStore({ filePath: path.join(root, "detail.json"), runtimeRoot: root });
    const generic = createNaverProviderHealthStore({ filePath: path.join(root, "generic.json"), runtimeRoot: root });
    const initialMain = await main.read();
    const initialDetail = await detail.read();
    const initialGeneric = await generic.read();
    const reservation = await detail.beginAttempt({ expectedWorkflowRevision: initialDetail.workflowRevision, explicit: true, now: new Date("2026-08-20T00:00:00.000Z") });
    assert.equal(reservation.allowed, true);
    const closed = await detail.recordSuccess({ expectedWorkflowRevision: reservation.state.workflowRevision, outcomeReceiptHash: "a".repeat(64), now: new Date("2026-08-20T00:00:01.000Z") });
    assert.equal(closed.state, "closed");
    assert.equal((await main.read()).workflowRevision, initialMain.workflowRevision);
    assert.equal((await generic.read()).workflowRevision, initialGeneric.workflowRevision);
    assert.equal(guard.blockedAttempts(), 0);
    console.log("booking-detail circuit separation fixtures passed");
  } finally {
    guard.restore();
    await fs.rm(root, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
