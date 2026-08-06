"use strict";

const assert = require("node:assert/strict");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const {
  createCollectionJobStore
} = require("./collection_job_store.cjs");

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);

function jobInput(overrides = {}) {
  return {
    jobId: "job-synthetic-0001",
    idempotencyKey: HASH_A,
    contractHash: HASH_B,
    executionIdentityHash: HASH_C,
    backendId: "render-worker-v2",
    backendVersion: "4e4e190-runtime-v1",
    workerPoolId: "v2-runtime-worker",
    maxProviderCalls: 1,
    now: "2026-08-06T01:00:00.000Z",
    ...overrides
  };
}

async function main() {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "collection-job-store-"));
  try {
    assert.throws(
      () => createCollectionJobStore({ runtimeRoot: tempRoot, filePath: path.join(path.dirname(tempRoot), "outside.json") }),
      /inside the runtime root/
    );

    const store = createCollectionJobStore({ runtimeRoot: tempRoot, defaultLeaseMs: 1000 });
    await assert.rejects(
      () => store.createOrReuseJob(jobInput({ maxProviderCalls: 2 })),
      { code: "COLLECTION_JOB_STORE_INPUT_INVALID", statusCode: 400 },
      "the durable queue must reject more than one provider call"
    );
    const created = await store.createOrReuseJob(jobInput());
    assert.equal(created.state, "queued");
    assert.equal(created.attemptNo, 0);
    assert.equal(created.automaticRetry, false);
    assert.equal(created.automaticFallback, false);
    assert.equal(created.externalCallOnRead, false);

    const reused = await store.createOrReuseJob(jobInput({ jobId: "job-different-0002" }));
    assert.equal(reused.jobId, created.jobId, "same idempotency key must reuse the original job");
    assert.equal((await store.readSnapshot()).jobs.length, 1);

    await assert.rejects(
      () => store.createOrReuseJob(jobInput({ contractHash: HASH_A })),
      { code: "COLLECTION_JOB_IDEMPOTENCY_CONFLICT", statusCode: 409 }
    );

    const [claimA, claimB] = await Promise.all([
      store.claimNextJob({ workerId: "worker-a", workerPoolId: "v2-runtime-worker", now: "2026-08-06T01:01:00.000Z" }),
      store.claimNextJob({ workerId: "worker-b", workerPoolId: "v2-runtime-worker", now: "2026-08-06T01:01:00.000Z" })
    ]);
    assert.equal([claimA, claimB].filter(Boolean).length, 1, "concurrent claims must lease exactly one worker");
    const claimed = claimA || claimB;
    assert.equal(claimed.state, "leased");
    assert.equal(claimed.attemptNo, 1);

    await assert.rejects(
      () => store.transitionJob({
        jobId: claimed.jobId,
        expectedWorkflowRevision: claimed.workflowRevision - 1,
        workerId: claimed.workerId,
        nextState: "collecting",
        now: "2026-08-06T01:01:01.000Z"
      }),
      { code: "COLLECTION_JOB_REVISION_CONFLICT", statusCode: 409 }
    );

    const collecting = await store.transitionJob({
      jobId: claimed.jobId,
      expectedWorkflowRevision: claimed.workflowRevision,
      workerId: claimed.workerId,
      nextState: "collecting",
      now: "2026-08-06T01:01:01.000Z"
    });
    assert.equal(collecting.state, "collecting");

    const heartbeat = await store.heartbeatJob({
      jobId: collecting.jobId,
      expectedWorkflowRevision: collecting.workflowRevision,
      workerId: collecting.workerId,
      providerWorkflowRevision: 2,
      now: "2026-08-06T01:01:01.500Z",
      leaseMs: 1000
    });
    assert.equal(heartbeat.state, "collecting");
    assert.equal(heartbeat.leaseExpiresAt, "2026-08-06T01:01:02.500Z");
    assert.equal(heartbeat.providerWorkflowRevision, 2, "provider lease revision must survive a process restart");
    await assert.rejects(
      () => store.heartbeatJob({
        jobId: heartbeat.jobId,
        expectedWorkflowRevision: heartbeat.workflowRevision,
        workerId: heartbeat.workerId,
        providerWorkflowRevision: 1,
        now: "2026-08-06T01:01:01.750Z",
        leaseMs: 1000
      }),
      { code: "COLLECTION_JOB_PROVIDER_REVISION_CONFLICT", statusCode: 409 },
      "a stale provider heartbeat must not move the durable revision backwards"
    );

    const restarted = createCollectionJobStore({ runtimeRoot: tempRoot, defaultLeaseMs: 1000 });
    const reloaded = (await restarted.readSnapshot()).jobs[0];
    assert.equal(reloaded.state, "collecting", "restart must reload the durable lease");
    assert.equal(reloaded.providerWorkflowRevision, 2, "restart must reload the provider lease revision");
    const expired = await restarted.expireWorkerLeases({ now: "2026-08-06T01:01:03.000Z" });
    assert.equal(expired.length, 1);
    assert.equal(expired[0].state, "indeterminate");
    assert.equal(await restarted.claimNextJob({
      workerId: "worker-c",
      workerPoolId: "v2-runtime-worker",
      now: "2026-08-06T01:02:00.000Z"
    }), null, "expired work must never be automatically requeued");

    await fsp.writeFile(restarted.filePath, "{broken", "utf8");
    await assert.rejects(() => restarted.readSnapshot(), SyntaxError, "corrupt job storage must fail closed");

    console.log("Collection worker durable job store fixture checks passed");
  } finally {
    const relative = path.relative(path.resolve(os.tmpdir()), path.resolve(tempRoot));
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`refusing to remove unexpected fixture directory: ${tempRoot}`);
    }
    await fsp.rm(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
