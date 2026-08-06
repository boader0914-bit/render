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
  COLLECTION_WORKER_MODE_SYNTHETIC,
  COLLECTION_WORKER_RUNTIME_SCHEMA_VERSION,
  assertExactV2RuntimeFingerprint,
  createCollectionWorkerRuntime,
  observeRuntimeFingerprint,
  runtimeFingerprintMatches
} = require("./collection_worker_runtime.cjs");

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

function signedDisabledJob(privateKey, suffix = "runtime_001") {
  return buildSignedJobEnvelope({
    jobId: `job_fixture_${suffix}`,
    attemptId: `attempt_fixture_${suffix}`,
    approvalId: `approval_fixture_${suffix}`,
    audience: COLLECTION_WORKER_JOB_AUDIENCE,
    workerId: WORKER_ID,
    workerPoolId: WORKER_POOL_ID,
    nonce: `fixture_nonce_${suffix}_00000001`,
    contract: collectionContract()
  }, {
    privateKey,
    signerKeyId: DISPATCH_KEY_ID,
    now: FIXED_NOW,
    ttlSeconds: 120
  });
}

function syntheticSummary(overrides = {}) {
  return {
    status: "ready",
    providerAttemptCount: 0,
    executedCallCount: 0,
    automaticRetry: false,
    automaticFallback: false,
    currentResultReused: false,
    fallbackResultReused: false,
    resultStored: false,
    writeCount: 0,
    organicCount: 3,
    adCount: 1,
    observedRankCount: 4,
    providerFailureSubtype: null,
    diagnosticId: null,
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

function hasCode(code) {
  return (error) => error?.code === code && error?.retryable === false;
}

async function main() {
  const guard = installFixtureNetworkGuard({ label: "collection worker runtime fixtures" });
  try {
    const dispatchKeys = crypto.generateKeyPairSync("ed25519");
    const artifactKeys = crypto.generateKeyPairSync("ed25519");
    const signedJob = signedDisabledJob(dispatchKeys.privateKey);
    const observed = observeRuntimeFingerprint();

    assert.deepEqual(Object.keys(observed).sort(), ["arch", "node", "openssl", "platform", "undici"]);
    assert.equal(Object.isFrozen(observed), true);
    assert.equal(runtimeFingerprintMatches(FIXED_V2_WORKER_RUNTIME_FINGERPRINT), true);
    assert.deepEqual(
      assertExactV2RuntimeFingerprint(FIXED_V2_WORKER_RUNTIME_FINGERPRINT),
      FIXED_V2_WORKER_RUNTIME_FINGERPRINT
    );

    for (const [field, value] of [
      ["node", "26.4.0"],
      ["undici", "8.6.0"],
      ["openssl", "3.5.6"],
      ["platform", "win32"],
      ["arch", "arm64"]
    ]) {
      const mismatched = { ...FIXED_V2_WORKER_RUNTIME_FINGERPRINT, [field]: value };
      assert.equal(runtimeFingerprintMatches(mismatched), false);
      assert.throws(() => assertExactV2RuntimeFingerprint(mismatched), hasCode("COLLECTION_WORKER_RUNTIME_MISMATCH"));
    }

    let disabledVerifyCalls = 0;
    let disabledExecutorCalls = 0;
    const disabledRuntime = createCollectionWorkerRuntime({
      runtimeFingerprint: FIXED_V2_WORKER_RUNTIME_FINGERPRINT,
      verifyJob() {
        disabledVerifyCalls += 1;
      },
      executor() {
        disabledExecutorCalls += 1;
      }
    });
    assert.deepEqual(disabledRuntime.describe(), {
      schemaVersion: COLLECTION_WORKER_RUNTIME_SCHEMA_VERSION,
      enabled: false,
      runtimeId: disabledRuntime.describe().runtimeId,
      runtimeFingerprint: FIXED_V2_WORKER_RUNTIME_FINGERPRINT,
      runtimeReady: true,
      supportedModes: ["synthetic", "provider_canary"],
      automaticRetry: false,
      automaticFallback: false,
      currentResultReuse: false,
      fallbackResultReuse: false,
      resultWritesEnabled: false
    });
    await assert.rejects(
      () => disabledRuntime.execute({}),
      hasCode("COLLECTION_WORKER_DISABLED")
    );
    assert.equal(disabledVerifyCalls, 0);
    assert.equal(disabledExecutorCalls, 0);

    let mismatchVerifyCalls = 0;
    const mismatchRuntime = createCollectionWorkerRuntime({
      enabled: true,
      runtimeFingerprint: { ...FIXED_V2_WORKER_RUNTIME_FINGERPRINT, node: "26.4.0" },
      verifyJob() {
        mismatchVerifyCalls += 1;
      }
    });
    assert.equal(mismatchRuntime.describe().runtimeReady, false);
    await assert.rejects(
      () => mismatchRuntime.execute({
        mode: COLLECTION_WORKER_MODE_SYNTHETIC,
        signedJob,
        syntheticResult: syntheticSummary()
      }),
      hasCode("COLLECTION_WORKER_RUNTIME_MISMATCH")
    );
    assert.equal(mismatchVerifyCalls, 0, "runtime mismatch must fail before job verification");

    let executorCalls = 0;
    let observedWrites = 0;
    const runtime = createCollectionWorkerRuntime({
      enabled: true,
      runtimeFingerprint: FIXED_V2_WORKER_RUNTIME_FINGERPRINT,
      runtimeId: "runtime:v2-fixture-001",
      jobVerification: verificationOptions(dispatchKeys.publicKey),
      artifactPrivateKey: artifactKeys.privateKey,
      artifactKeyId: ARTIFACT_KEY_ID,
      writeObserver: () => observedWrites,
      executor() {
        executorCalls += 1;
        throw new Error("synthetic mode must not call the provider executor");
      }
    });
    const result = await runtime.execute({
      mode: COLLECTION_WORKER_MODE_SYNTHETIC,
      signedJob,
      syntheticResult: syntheticSummary()
    });
    assert.equal(executorCalls, 0, "synthetic mode must execute zero transports");
    assert.equal(observedWrites, 0);
    assert.equal(result.mode, "synthetic");
    assert.equal(result.providerAttemptCount, 0);
    assert.equal(result.executedCallCount, 0);
    assert.equal(result.resultStored, false);
    assert.equal(result.currentResultReused, false);
    assert.equal(result.fallbackResultReused, false);
    assert.equal(Object.isFrozen(result), true);

    const expectedArtifactIdentity = {
      jobId: signedJob.jobId,
      attemptId: signedJob.attemptId,
      workerId: WORKER_ID,
      workerPoolId: WORKER_POOL_ID,
      runtimeId: "runtime:v2-fixture-001",
      contractHash: signedJob.contractHash,
      executionIdentityHash: signedJob.executionIdentityHash
    };
    const verifiedArtifact = verifyCollectionArtifactBundle(result.signedArtifact, {
      publicKey: artifactKeys.publicKey,
      expectedIdentity: expectedArtifactIdentity,
      expectedSigningKeyId: ARTIFACT_KEY_ID
    });
    assert.equal(verifiedArtifact.bundle.fileCount, 1);
    const summaryText = Buffer.from(verifiedArtifact.bundle.files[0].contentBase64, "base64").toString("utf8");
    const artifactSummary = JSON.parse(summaryText);
    assert.equal(artifactSummary.status, "ready");
    assert.equal(artifactSummary.providerAttemptCount, 0);
    assert.equal(summaryText.includes("Synthetic region lodging"), false, "artifact must not contain the raw keyword");
    assert.equal(summaryText.includes("http://"), false);
    assert.equal(summaryText.includes("https://"), false);

    await assert.rejects(
      () => runtime.execute({
        mode: COLLECTION_WORKER_MODE_SYNTHETIC,
        signedJob,
        syntheticResult: syntheticSummary()
      }),
      hasCode("COLLECTION_WORKER_EXECUTION_REUSED")
    );
    assert.equal(executorCalls, 0);
    assert.equal(guard.blockedAttempts(), 0);
    console.log("Collection worker runtime fingerprint, disabled gate, and synthetic no-transport fixtures passed.");
  } finally {
    guard.restore();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
