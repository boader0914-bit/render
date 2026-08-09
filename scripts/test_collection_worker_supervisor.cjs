"use strict";

const assert = require("node:assert/strict");
const {
  collectorStartupDiagnostics,
  runTop20WorkerLoop,
  startCollectionWorkerSupervisor
} = require("./collection_worker_supervisor.cjs");

(async () => {
  const diagnostics = collectorStartupDiagnostics({
    RENDER_SERVICE_ID: "srv-d9q6mrfavr4c73atllf0",
    RENDER_SERVICE_NAME: "lodging-datalab-collector-preview",
    RENDER_GIT_COMMIT: "0b86ad823d8f968a62486a1b32140717a0beb529",
    COLLECTOR_WORKER_MODE: "v2_top20_once",
    COLLECTION_WORKER_V2_TOP20_ENABLED: "true",
    COLLECTION_WORKER_V2_TOP20_EXECUTION_ENABLED: "true",
    COLLECTOR_EXTERNAL_CALLS_ENABLED: "true",
    COLLECTOR_RESULT_WRITE_ENABLED: "true",
    COLLECTION_WORKER_PREVIEW_INTERNAL_BASE_URL: "http://preview-internal:10000",
    COLLECTION_WORKER_REQUEST_PRIVATE_KEY_B64: "configured",
    COLLECTION_WORKER_DISPATCH_PUBLIC_KEY_B64: "configured",
    COLLECTION_WORKER_ARTIFACT_PRIVATE_KEY_B64: "configured"
  }, {
    node: "26.5.0",
    undici: "8.7.0",
    openssl: "3.5.7",
    platform: "linux",
    arch: "x64"
  });
  assert.deepEqual(diagnostics, {
    event: "collector_worker_startup",
    serviceId: "srv-d9q6mrfavr4c73atllf0",
    serviceName: "lodging-datalab-collector-preview",
    gitCommitShort: "0b86ad823d8f",
    node: "26.5.0",
    undici: "8.7.0",
    openssl: "3.5.7",
    platform: "linux",
    arch: "x64",
    workerMode: "v2_top20_once",
    top20Enabled: true,
    executionEnabled: true,
    externalCallsEnabled: true,
    resultWriteEnabled: true,
    internalTransport: "private",
    privateBaseUrlConfigured: true,
    requestPrivateKeyConfigured: true,
    dispatchPublicKeyConfigured: true,
    artifactPrivateKeyConfigured: true
  });

  const controller = new AbortController();
  const environment = { COLLECTOR_WORKER_MODE: "v2_top20_once", fixture: "supervisor" };
  let calls = 0;
  const lines = [];
  await runTop20WorkerLoop({
    environment,
    signal: controller.signal,
    pollMs: 10,
    log: (line) => lines.push(JSON.parse(line)),
    runner: async (input) => {
      assert.equal(input.environment, environment);
      assert.equal(input.signal, controller.signal);
      calls += 1;
      if (calls === 1) {
        const error = new Error("empty");
        error.code = "COLLECTION_WORKER_V2_TOP20_NO_JOB";
        throw error;
      }
      setImmediate(() => controller.abort());
      return { status: "ready", resultStored: true };
    }
  });
  assert.equal(calls, 2);
  assert.deepEqual(lines, [{ status: "ready", resultStored: true }]);

  const shutdownController = new AbortController();
  let shutdownInput = null;
  const shutdownLoop = runTop20WorkerLoop({
    environment,
    signal: shutdownController.signal,
    pollMs: 10,
    log: () => assert.fail("an aborted in-flight Worker must not log a failure receipt"),
    runner: async (input) => {
      shutdownInput = input;
      return new Promise((resolve) => {
        input.signal.addEventListener("abort", () => resolve({ status: "aborted" }), { once: true });
      });
    }
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(shutdownInput.environment, environment);
  assert.equal(shutdownInput.signal, shutdownController.signal);
  shutdownController.abort();
  assert.deepEqual(await shutdownLoop, { stopped: true });

  await assert.rejects(
    () => startCollectionWorkerSupervisor({ environment: { COLLECTOR_WORKER_MODE: "unknown" } }),
    (error) => error?.code === "COLLECTION_WORKER_MODE_INVALID"
  );
  console.log("collection worker supervisor fixtures passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
