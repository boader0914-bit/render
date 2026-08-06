"use strict";

const {
  FIXED_V2_WORKER_RUNTIME_FINGERPRINT
} = require("./collection_worker_contract.cjs");

const COLLECTOR_WORKER_MODE_ENV = "COLLECTOR_WORKER_MODE";
const COLLECTOR_EXTERNAL_CALLS_ENV = "COLLECTOR_EXTERNAL_CALLS_ENABLED";
const COLLECTOR_RESULT_WRITE_ENV = "COLLECTOR_RESULT_WRITE_ENABLED";

function runtimeFingerprintFromProcess(runtime = process) {
  return Object.freeze({
    node: String(runtime.versions?.node || ""),
    undici: String(runtime.versions?.undici || ""),
    openssl: String(runtime.versions?.openssl || ""),
    platform: String(runtime.platform || ""),
    arch: String(runtime.arch || "")
  });
}

function exactRuntimeMatch(actual, expected = FIXED_V2_WORKER_RUNTIME_FINGERPRINT) {
  return Object.keys(expected).every((key) => actual?.[key] === expected[key]);
}

function workerStartupStatus(input = {}) {
  const environment = input.environment || {};
  const runtimeFingerprint = input.runtimeFingerprint || runtimeFingerprintFromProcess();
  if (!exactRuntimeMatch(runtimeFingerprint)) {
    const error = new Error("collector worker runtime does not match the approved V2 fingerprint");
    error.code = "COLLECTION_WORKER_RUNTIME_MISMATCH";
    throw error;
  }
  const mode = String(environment[COLLECTOR_WORKER_MODE_ENV] || "disabled").trim().toLowerCase();
  const externalCallsEnabled = String(environment[COLLECTOR_EXTERNAL_CALLS_ENV] || "false").trim().toLowerCase() === "true";
  const resultWriteEnabled = String(environment[COLLECTOR_RESULT_WRITE_ENV] || "false").trim().toLowerCase() === "true";
  if (mode !== "disabled" || externalCallsEnabled || resultWriteEnabled) {
    const error = new Error("collector worker release must start fully disabled");
    error.code = "COLLECTION_WORKER_RELEASE_NOT_DISABLED";
    throw error;
  }
  return Object.freeze({
    ok: true,
    workerMode: "disabled",
    externalCallsEnabled: false,
    resultWriteEnabled: false,
    authorizedCallCount: 0,
    executedCallCount: 0,
    runtimeFingerprint
  });
}

function runIdleWorker(options = {}) {
  const status = workerStartupStatus(options);
  const logger = typeof options.log === "function" ? options.log : console.log;
  logger(JSON.stringify(status));
  const schedule = typeof options.schedule === "function" ? options.schedule : setInterval;
  const timer = schedule(() => {}, 60_000);
  timer?.unref?.();
  return { status, timer };
}

if (require.main === module) {
  try {
    const { status } = runIdleWorker({ environment: process.env });
    // A background worker must remain alive while disabled, but must never poll
    // or call a provider until a later explicitly approved release.
    setInterval(() => {
      if (status.externalCallsEnabled || status.resultWriteEnabled) process.exitCode = 1;
    }, 60_000);
  } catch (error) {
    console.error(JSON.stringify({ ok: false, code: String(error?.code || "COLLECTION_WORKER_STARTUP_FAILED") }));
    process.exitCode = 1;
  }
}

module.exports = {
  COLLECTOR_EXTERNAL_CALLS_ENV,
  COLLECTOR_RESULT_WRITE_ENV,
  COLLECTOR_WORKER_MODE_ENV,
  exactRuntimeMatch,
  runIdleWorker,
  runtimeFingerprintFromProcess,
  workerStartupStatus
};
