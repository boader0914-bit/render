"use strict";

const assert = require("node:assert/strict");
const {
  runTop20WorkerLoop,
  startCollectionWorkerSupervisor
} = require("./collection_worker_supervisor.cjs");

(async () => {
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
