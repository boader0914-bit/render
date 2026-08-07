"use strict";

const assert = require("node:assert/strict");
const {
  buildDisabledCollectorWorkerReleasePlan
} = require("./collection_worker_release_plan.cjs");
const {
  runIdleWorker,
  workerStartupStatus
} = require("./collection_worker_idle.cjs");
const {
  FIXED_V2_WORKER_RUNTIME_FINGERPRINT
} = require("./collection_worker_contract.cjs");

const plan = buildDisabledCollectorWorkerReleasePlan({
  sourceCommit: "c5a3e38217715142a6e5a7ea49909fc8c9de8b0d"
});
assert.equal(plan.serviceType, "background_worker");
assert.equal(plan.region, "singapore");
assert.equal(plan.buildCommand, "npm install");
assert.equal(plan.nodeVersion, "26.5.0");
assert.equal(plan.autoDeploy, false);
assert.equal(plan.persistentDisk, false);
assert.equal(plan.cronSchedule, null);
assert.equal(plan.externalIngress, false);
assert.equal(plan.externalCallsEnabled, false);
assert.equal(plan.resultWriteEnabled, false);
assert.equal(plan.maxProviderAttempts, 0);
assert.equal(plan.executedCallCount, 0);

const status = workerStartupStatus({
  environment: {},
  runtimeFingerprint: FIXED_V2_WORKER_RUNTIME_FINGERPRINT
});
assert.equal(status.workerMode, "disabled");
assert.equal(status.executedCallCount, 0);

assert.throws(
  () => workerStartupStatus({
    environment: { COLLECTOR_EXTERNAL_CALLS_ENABLED: "true" },
    runtimeFingerprint: FIXED_V2_WORKER_RUNTIME_FINGERPRINT
  }),
  { code: "COLLECTION_WORKER_RELEASE_NOT_DISABLED" }
);
assert.throws(
  () => workerStartupStatus({
    environment: {},
    runtimeFingerprint: { ...FIXED_V2_WORKER_RUNTIME_FINGERPRINT, node: "22.22.0" }
  }),
  { code: "COLLECTION_WORKER_RUNTIME_MISMATCH" }
);

let scheduleCalls = 0;
let logLine = "";
const idle = runIdleWorker({
  environment: {},
  runtimeFingerprint: FIXED_V2_WORKER_RUNTIME_FINGERPRINT,
  log(value) { logLine = value; },
  schedule() {
    scheduleCalls += 1;
    return { unref() {} };
  }
});
assert.equal(scheduleCalls, 1);
assert.equal(JSON.parse(logLine).externalCallsEnabled, false);
assert.equal(idle.status.resultWriteEnabled, false);

console.log("Disabled collector worker release plan fixture checks passed");
