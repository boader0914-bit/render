"use strict";

const {
  runIdleWorker
} = require("./collection_worker_idle.cjs");
const {
  runCollectionWorkerV2Top20,
  safeFatalResult
} = require("./collection_worker_v2_top20_worker.cjs");

const TOP20_MODE = "v2_top20_once";
const DEFAULT_POLL_MS = 15_000;
const FAILURE_POLL_MS = 30_000;

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
  while (!signal?.aborted) {
    try {
      const result = await runner({ environment, signal });
      if (signal?.aborted) break;
      logger(JSON.stringify(result));
      await wait(pollMs, signal);
    } catch (error) {
      if (signal?.aborted) break;
      if (error?.code !== "COLLECTION_WORKER_V2_TOP20_NO_JOB") {
        logger(JSON.stringify(safeFatalResult(error)));
      }
      await wait(error?.code === "COLLECTION_WORKER_V2_TOP20_NO_JOB" ? pollMs : FAILURE_POLL_MS, signal);
    }
  }
  return Object.freeze({ stopped: true });
}

async function startCollectionWorkerSupervisor(options = {}) {
  const environment = options.environment || process.env;
  const mode = String(environment.COLLECTOR_WORKER_MODE || "disabled").trim().toLowerCase();
  if (mode === "disabled") {
    return runIdleWorker({
      environment,
      runtimeFingerprint: options.runtimeFingerprint,
      log: options.log,
      schedule: options.schedule
    });
  }
  if (mode !== TOP20_MODE) {
    const error = new Error("collector worker mode is not approved");
    error.code = "COLLECTION_WORKER_MODE_INVALID";
    throw error;
  }
  return runTop20WorkerLoop(options);
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
  runTop20WorkerLoop,
  startCollectionWorkerSupervisor
};
