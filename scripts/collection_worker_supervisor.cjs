"use strict";

const {
  runIdleWorker
} = require("./collection_worker_idle.cjs");
const {
  runCollectionWorkerV2Top20,
  safeFatalResult
} = require("./collection_worker_v2_top20_worker.cjs");
const {
  observeRuntimeFingerprint
} = require("./collection_worker_runtime.cjs");

const TOP20_MODE = "v2_top20_once";
const DEFAULT_POLL_MS = 15_000;
const FAILURE_POLL_MS = 30_000;

function envFlag(environment, name) {
  return String(environment?.[name] || "false").trim().toLowerCase() === "true";
}

function envConfigured(environment, name) {
  return Boolean(String(environment?.[name] || "").trim());
}

function collectorStartupDiagnostics(environment = process.env, runtime = observeRuntimeFingerprint()) {
  const privateBaseUrlConfigured = Boolean(String(environment.COLLECTION_WORKER_PREVIEW_INTERNAL_BASE_URL || "").trim());
  return Object.freeze({
    event: "collector_worker_startup",
    serviceId: String(environment.RENDER_SERVICE_ID || ""),
    serviceName: String(environment.RENDER_SERVICE_NAME || ""),
    gitCommitShort: String(environment.RENDER_GIT_COMMIT || "").slice(0, 12),
    node: String(runtime.node || ""),
    undici: String(runtime.undici || ""),
    openssl: String(runtime.openssl || ""),
    platform: String(runtime.platform || ""),
    arch: String(runtime.arch || ""),
    workerMode: String(environment.COLLECTOR_WORKER_MODE || ""),
    top20Enabled: envFlag(environment, "COLLECTION_WORKER_V2_TOP20_ENABLED"),
    executionEnabled: envFlag(environment, "COLLECTION_WORKER_V2_TOP20_EXECUTION_ENABLED"),
    externalCallsEnabled: envFlag(environment, "COLLECTOR_EXTERNAL_CALLS_ENABLED"),
    resultWriteEnabled: envFlag(environment, "COLLECTOR_RESULT_WRITE_ENABLED"),
    internalTransport: "private",
    privateBaseUrlConfigured,
    requestPrivateKeyConfigured: envConfigured(environment, "COLLECTION_WORKER_REQUEST_PRIVATE_KEY_B64"),
    dispatchPublicKeyConfigured: envConfigured(environment, "COLLECTION_WORKER_DISPATCH_PUBLIC_KEY_B64"),
    artifactPrivateKeyConfigured: envConfigured(environment, "COLLECTION_WORKER_ARTIFACT_PRIVATE_KEY_B64")
  });
}

function wait(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener?.("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener?.("abort", finish, { once: true });
  });
}

async function runTop20WorkerLoop(options = {}) {
  const environment = options.environment || process.env;
  const runner = options.runner || runCollectionWorkerV2Top20;
  const logger = options.log || console.log;
  const signal = options.signal;
  const pollMs = Number.isInteger(options.pollMs) && options.pollMs >= 10
    ? options.pollMs
    : DEFAULT_POLL_MS;
  const attestationState = options.attestationState || { consecutiveMatches: 0, lastAttestedAt: null };
  while (!signal?.aborted) {
    try {
      const result = await runner({ environment, signal, attestationState });
      if (signal?.aborted) break;
      logger(JSON.stringify(result));
      await wait(pollMs, signal);
    } catch (error) {
      if (signal?.aborted) break;
      if (error?.code !== "COLLECTION_WORKER_V2_TOP20_NO_JOB" && error?.code !== "COLLECTION_WORKER_PREVIEW_ATTESTATION_PENDING") {
        logger(JSON.stringify(safeFatalResult(error)));
      }
      await wait(error?.code === "COLLECTION_WORKER_V2_TOP20_NO_JOB" ? pollMs : FAILURE_POLL_MS, signal);
    }
  }
  return Object.freeze({ stopped: true });
}

async function startCollectionWorkerSupervisor(options = {}) {
  const environment = options.environment || process.env;
  const logger = options.log || console.log;
  const runtimeFingerprint = options.runtimeFingerprint || observeRuntimeFingerprint();
  logger(JSON.stringify(collectorStartupDiagnostics(environment, runtimeFingerprint)));
  const mode = String(environment.COLLECTOR_WORKER_MODE || "disabled").trim().toLowerCase();
  if (mode === "disabled") {
    return runIdleWorker({
      environment,
      runtimeFingerprint,
      log: logger,
      schedule: options.schedule
    });
  }
  if (mode !== TOP20_MODE) {
    const error = new Error("collector worker mode is not approved");
    error.code = "COLLECTION_WORKER_MODE_INVALID";
    throw error;
  }
  return runTop20WorkerLoop({ ...options, environment, runtimeFingerprint, log: logger });
}

if (require.main === module) {
  const controller = new AbortController();
  process.once("SIGTERM", () => controller.abort());
  process.once("SIGINT", () => controller.abort());
  startCollectionWorkerSupervisor({ signal: controller.signal }).catch((error) => {
    console.error(JSON.stringify(safeFatalResult(error)));
    process.exitCode = 1;
  });
}

module.exports = {
  DEFAULT_POLL_MS,
  FAILURE_POLL_MS,
  TOP20_MODE,
  collectorStartupDiagnostics,
  runTop20WorkerLoop,
  startCollectionWorkerSupervisor
};
