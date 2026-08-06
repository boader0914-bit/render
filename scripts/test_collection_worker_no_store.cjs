"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { installFixtureNetworkGuard } = require("./fixture_network_guard.cjs");
const {
  COLLECTION_WORKER_JOB_AUDIENCE,
  FIXED_V2_WORKER_RUNTIME_FINGERPRINT,
  buildSignedJobEnvelope
} = require("./collection_worker_contract.cjs");
const {
  verifyCollectionArtifactBundle
} = require("./collection_artifact_contract.cjs");
const {
  COLLECTION_WORKER_MODE_PROVIDER_CANARY,
  createCollectionWorkerRuntime
} = require("./collection_worker_runtime.cjs");
const {
  buildCollectionWorkerExecutionPayload
} = require("./collection_worker_execution_payload.cjs");

const FIXED_NOW = new Date("2026-08-06T06:00:00.000Z");
const DISPATCH_KEY_ID = "preview_dispatch_fixture_v1";
const ARTIFACT_KEY_ID = "worker_artifact_fixture_v1";
const WORKER_ID = "collector_worker_fixture_01";
const WORKER_POOL_ID = "collector_pool_fixture_01";

function collectionContract() {
  return {
    keyword: "Synthetic region lodging",
    searchMode: "keyword",
    collectionMode: "precision",
    collectionPurpose: "revenue_detail",
    productMode: "all",
    checkIn: "2026-08-06",
    checkOut: "2026-08-06",
    rankStart: 1,
    rankEnd: 50,
    detailRankStart: 1,
    detailRankEnd: 3
  };
}

function enabledAuthorization() {
  return {
    enabled: true,
    actualCallsEnabled: true,
    externalCallApproved: true,
    authorizedExecutionCount: 1
  };
}

function signedEnabledJob(privateKey, suffix) {
  return buildSignedJobEnvelope({
    jobId: `job_fixture_${suffix}`,
    attemptId: `attempt_fixture_${suffix}`,
    approvalId: `approval_fixture_${suffix}`,
    audience: COLLECTION_WORKER_JOB_AUDIENCE,
    workerId: WORKER_ID,
    workerPoolId: WORKER_POOL_ID,
    nonce: `fixture_nonce_${suffix}_00000001`,
    contract: collectionContract(),
    authorization: enabledAuthorization()
  }, {
    privateKey,
    signerKeyId: DISPATCH_KEY_ID,
    now: FIXED_NOW,
    ttlSeconds: 120
  });
}

function providerSummary(overrides = {}) {
  return {
    status: "ready",
    providerAttemptCount: 1,
    executedCallCount: 1,
    automaticRetry: false,
    automaticFallback: false,
    currentResultReused: false,
    fallbackResultReused: false,
    resultStored: false,
    writeCount: 0,
    organicCount: 50,
    adCount: 0,
    observedRankCount: 50,
    providerFailureSubtype: null,
    diagnosticId: "crawl-fixture0001",
    ...overrides
  };
}

function verificationOptions(publicKey) {
  return {
    publicKey,
    expectedSignerKeyId: DISPATCH_KEY_ID,
    expectedAudience: COLLECTION_WORKER_JOB_AUDIENCE,
    expectedWorkerId: WORKER_ID,
    expectedWorkerPoolId: WORKER_POOL_ID,
    now: FIXED_NOW,
    clockSkewSeconds: 0
  };
}

function runtimeOptions(dispatchPublicKey, artifactPrivateKey, overrides = {}) {
  return {
    enabled: true,
    runtimeFingerprint: FIXED_V2_WORKER_RUNTIME_FINGERPRINT,
    runtimeId: "runtime:v2-no-store-001",
    jobVerification: verificationOptions(dispatchPublicKey),
    artifactPrivateKey,
    artifactKeyId: ARTIFACT_KEY_ID,
    writeObserver: () => 0,
    ...overrides
  };
}

function executionInput(signedJob, overrides = {}) {
  return {
    mode: COLLECTION_WORKER_MODE_PROVIDER_CANARY,
    signedJob,
    executionPayload: buildCollectionWorkerExecutionPayload({
      jobId: signedJob.jobId,
      attemptId: signedJob.attemptId,
      contract: collectionContract()
    }, signedJob),
    ...overrides
  };
}

function hasCode(code) {
  return (error) => error?.code === code && error?.retryable === false;
}

async function main() {
  const guard = installFixtureNetworkGuard({ label: "collection worker no-store fixtures" });
  try {
    const dispatchKeys = crypto.generateKeyPairSync("ed25519");
    const artifactKeys = crypto.generateKeyPairSync("ed25519");

    const noExecutorJob = signedEnabledJob(dispatchKeys.privateKey, "no_executor_001");
    const noExecutorRuntime = createCollectionWorkerRuntime(runtimeOptions(
      dispatchKeys.publicKey,
      artifactKeys.privateKey
    ));
    await assert.rejects(
      () => noExecutorRuntime.execute(executionInput(noExecutorJob)),
      hasCode("COLLECTION_WORKER_EXECUTOR_REQUIRED"),
      "provider collection must have no implicit/default executor"
    );

    const payloadJob = signedEnabledJob(dispatchKeys.privateKey, "payload_mismatch_001");
    const validPayloadInput = executionInput(payloadJob);
    let payloadExecutorCalls = 0;
    const payloadRuntime = createCollectionWorkerRuntime(runtimeOptions(
      dispatchKeys.publicKey,
      artifactKeys.privateKey,
      {
        executor() {
          payloadExecutorCalls += 1;
          return providerSummary();
        }
      }
    ));
    await assert.rejects(
      () => payloadRuntime.execute(executionInput(payloadJob, {
        executionPayload: {
          ...validPayloadInput.executionPayload,
          contract: {
            ...validPayloadInput.executionPayload.contract,
            keyword: "Different synthetic lodging"
          }
        }
      })),
      (error) => error?.code === "COLLECTION_WORKER_EXECUTION_CONTRACT_MISMATCH"
    );
    assert.equal(payloadExecutorCalls, 0, "a mismatched raw payload must fail before provider execution");
    await payloadRuntime.execute(validPayloadInput);
    assert.equal(payloadExecutorCalls, 1, "input validation failure must not consume the valid one-shot job");

    const happyJob = signedEnabledJob(dispatchKeys.privateKey, "happy_path_001");
    let happyExecutorCalls = 0;
    let capturedContext = null;
    const happyRuntime = createCollectionWorkerRuntime(runtimeOptions(
      dispatchKeys.publicKey,
      artifactKeys.privateKey,
      {
        async executor(context) {
          happyExecutorCalls += 1;
          capturedContext = context;
          return providerSummary();
        }
      }
    ));
    const happy = await happyRuntime.execute(executionInput(happyJob));
    assert.equal(happyExecutorCalls, 1);
    assert.equal(capturedContext.callBudget, 1);
    assert.equal(capturedContext.maxProviderAttempts, 1);
    assert.equal(capturedContext.automaticRetry, false);
    assert.equal(capturedContext.automaticFallback, false);
    assert.equal(capturedContext.allowCurrentResultReuse, false);
    assert.equal(capturedContext.allowFallbackResultReuse, false);
    assert.equal(capturedContext.saveResult, false);
    assert.equal(capturedContext.executionPayload.contract.keyword, collectionContract().keyword);
    assert.equal(Object.isFrozen(capturedContext), true);
    assert.equal(happy.executedCallCount, 1);
    assert.equal(happy.providerAttemptCount, 1);
    assert.equal(happy.resultStored, false);
    assert.equal(happy.writeCount, 0);

    const expectedIdentity = {
      jobId: happyJob.jobId,
      attemptId: happyJob.attemptId,
      workerId: WORKER_ID,
      workerPoolId: WORKER_POOL_ID,
      runtimeId: "runtime:v2-no-store-001",
      contractHash: happyJob.contractHash,
      executionIdentityHash: happyJob.executionIdentityHash
    };
    const verifiedArtifact = verifyCollectionArtifactBundle(happy.signedArtifact, {
      publicKey: artifactKeys.publicKey,
      expectedIdentity,
      expectedSigningKeyId: ARTIFACT_KEY_ID
    });
    assert.equal(verifiedArtifact.bundle.fileCount, 1);
    const artifactText = Buffer.from(verifiedArtifact.bundle.files[0].contentBase64, "base64").toString("utf8");
    assert.equal(artifactText.includes("Synthetic region lodging"), false);
    assert.equal(artifactText.includes("currentResult"), true, "reuse prohibition is explicit in the safe summary");
    await assert.rejects(
      () => happyRuntime.execute(executionInput(happyJob)),
      hasCode("COLLECTION_WORKER_EXECUTION_REUSED")
    );
    assert.equal(happyExecutorCalls, 1, "a used one-shot job must never run the executor again");

    const concurrentJob = signedEnabledJob(dispatchKeys.privateKey, "concurrent_001");
    let concurrentCalls = 0;
    const concurrentRuntime = createCollectionWorkerRuntime(runtimeOptions(
      dispatchKeys.publicKey,
      artifactKeys.privateKey,
      {
        async executor() {
          concurrentCalls += 1;
          await Promise.resolve();
          return providerSummary();
        }
      }
    ));
    const concurrent = await Promise.allSettled([
      concurrentRuntime.execute(executionInput(concurrentJob)),
      concurrentRuntime.execute(executionInput(concurrentJob))
    ]);
    assert.equal(concurrent.filter((entry) => entry.status === "fulfilled").length, 1);
    assert.equal(concurrent.filter(
      (entry) => entry.status === "rejected" && entry.reason?.code === "COLLECTION_WORKER_EXECUTION_REUSED"
    ).length, 1);
    assert.equal(concurrentCalls, 1, "concurrent one-shot execution must invoke one executor");

    const resultViolations = [
      ["two_attempts", { providerAttemptCount: 2 }],
      ["two_calls", { executedCallCount: 2 }],
      ["automatic_retry", { automaticRetry: true }],
      ["automatic_fallback", { automaticFallback: true }],
      ["current_reuse", { currentResultReused: true }],
      ["fallback_reuse", { fallbackResultReused: true }],
      ["stored_result", { resultStored: true }],
      ["reported_write", { writeCount: 1 }]
    ];
    for (const [suffix, override] of resultViolations) {
      let calls = 0;
      const job = signedEnabledJob(dispatchKeys.privateKey, `violation_${suffix}`);
      const runtime = createCollectionWorkerRuntime(runtimeOptions(
        dispatchKeys.publicKey,
        artifactKeys.privateKey,
        {
          executor() {
            calls += 1;
            return providerSummary(override);
          }
        }
      ));
      await assert.rejects(
        () => runtime.execute(executionInput(job)),
        hasCode("COLLECTION_WORKER_RESULT_POLICY_VIOLATION")
      );
      assert.equal(calls, 1, `${suffix} must not trigger an automatic retry`);
    }

    let observedWrites = 0;
    let writeAttemptCalls = 0;
    const writeJob = signedEnabledJob(dispatchKeys.privateKey, "write_attempt_001");
    const writeRuntime = createCollectionWorkerRuntime(runtimeOptions(
      dispatchKeys.publicKey,
      artifactKeys.privateKey,
      {
        writeObserver: () => observedWrites,
        executor() {
          writeAttemptCalls += 1;
          observedWrites += 1;
          return providerSummary();
        }
      }
    ));
    await assert.rejects(
      () => writeRuntime.execute(executionInput(writeJob)),
      hasCode("COLLECTION_WORKER_WRITE_DETECTED")
    );
    assert.equal(writeAttemptCalls, 1);

    observedWrites = 0;
    const writeThenFailJob = signedEnabledJob(dispatchKeys.privateKey, "write_then_fail_001");
    const writeThenFailRuntime = createCollectionWorkerRuntime(runtimeOptions(
      dispatchKeys.publicKey,
      artifactKeys.privateKey,
      {
        writeObserver: () => observedWrites,
        executor() {
          observedWrites += 1;
          throw new Error("failure after a prohibited write");
        }
      }
    ));
    await assert.rejects(
      () => writeThenFailRuntime.execute(executionInput(writeThenFailJob)),
      hasCode("COLLECTION_WORKER_WRITE_DETECTED"),
      "a failing executor must not hide a write attempt"
    );

    let failedCalls = 0;
    const failedJob = signedEnabledJob(dispatchKeys.privateKey, "failed_executor_001");
    const providerError = Object.assign(new Error("synthetic provider failure"), {
      code: "NAVER_ACCESS_BLOCKED",
      retryable: false
    });
    const failedRuntime = createCollectionWorkerRuntime(runtimeOptions(
      dispatchKeys.publicKey,
      artifactKeys.privateKey,
      {
        executor() {
          failedCalls += 1;
          throw providerError;
        }
      }
    ));
    await assert.rejects(
      () => failedRuntime.execute(executionInput(failedJob)),
      (error) => error === providerError
    );
    assert.equal(failedCalls, 1, "executor failure must not be retried");
    await assert.rejects(
      () => failedRuntime.execute(executionInput(failedJob)),
      hasCode("COLLECTION_WORKER_EXECUTION_REUSED")
    );
    assert.equal(failedCalls, 1);

    let unexpectedExecutorCalls = 0;
    const extraFieldJob = signedEnabledJob(dispatchKeys.privateKey, "extra_field_001");
    const extraFieldRuntime = createCollectionWorkerRuntime(runtimeOptions(
      dispatchKeys.publicKey,
      artifactKeys.privateKey,
      {
        executor() {
          unexpectedExecutorCalls += 1;
          return providerSummary();
        }
      }
    ));
    await assert.rejects(
      () => extraFieldRuntime.execute(executionInput(extraFieldJob, {
        currentResult: { status: "ready" }
      })),
      hasCode("COLLECTION_WORKER_RUNTIME_INPUT_INVALID")
    );
    await assert.rejects(
      () => extraFieldRuntime.execute(executionInput(extraFieldJob, {
        fallbackResult: { status: "ready" }
      })),
      hasCode("COLLECTION_WORKER_RUNTIME_INPUT_INVALID")
    );
    assert.equal(unexpectedExecutorCalls, 0, "current/fallback result injection must fail before executor use");

    assert.equal(guard.blockedAttempts(), 0);
    console.log("Collection worker one-shot, no-retry, no-reuse, and no-store fixtures passed.");
  } finally {
    guard.restore();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
