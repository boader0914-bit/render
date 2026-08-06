"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { installFixtureNetworkGuard } = require("./fixture_network_guard.cjs");
const {
  COLLECTION_WORKER_JOB_AUDIENCE,
  COLLECTION_WORKER_JOB_DOCUMENT_TYPE,
  COLLECTION_WORKER_JOB_SCHEMA_VERSION,
  COLLECTION_WORKER_SIGNATURE_ALGORITHM,
  COLLECTION_WORKER_SIGNATURE_DOMAIN,
  FIXED_ONE_SHOT_POLICY,
  FIXED_V2_WORKER_COLLECTOR,
  FIXED_V2_WORKER_RUNTIME_FINGERPRINT,
  REQUIRED_COLLECTION_WORKER_SCOPES,
  assertCollectionWorkerJobExecutable,
  buildCollectionIdempotencyKey,
  buildSignedJobEnvelope,
  computeCollectionContractHash,
  normalizeCollectionJobContract,
  verifySignedJobEnvelope
} = require("./collection_worker_contract.cjs");

const FIXED_NOW = new Date("2026-08-06T06:00:00.000Z");
const SIGNER_KEY_ID = "preview_dispatch_key_v1";
const WORKER_ID = "collector_worker_fixture_01";
const WORKER_POOL_ID = "collector_pool_fixture_01";

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

function resign(value, privateKey) {
  const payload = Object.fromEntries(Object.entries(value).filter(([key]) => key !== "signature"));
  const bytes = Buffer.from(`${COLLECTION_WORKER_SIGNATURE_DOMAIN}\n${stableJson(payload)}`, "utf8");
  return {
    ...payload,
    signature: crypto.sign(null, bytes, privateKey).toString("base64url")
  };
}

function contract(overrides = {}) {
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
    detailRankEnd: 3,
    ...overrides
  };
}

function jobInput(overrides = {}) {
  return {
    jobId: "job_fixture_20260806_001",
    attemptId: "attempt_fixture_001",
    approvalId: "approval_fixture_001",
    audience: COLLECTION_WORKER_JOB_AUDIENCE,
    workerId: WORKER_ID,
    workerPoolId: WORKER_POOL_ID,
    nonce: "fixture_nonce_20260806_0001",
    contract: contract(),
    ...overrides
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

function verifyOptions(publicKey, overrides = {}) {
  return {
    publicKey,
    expectedSignerKeyId: SIGNER_KEY_ID,
    expectedAudience: COLLECTION_WORKER_JOB_AUDIENCE,
    expectedWorkerId: WORKER_ID,
    expectedWorkerPoolId: WORKER_POOL_ID,
    now: FIXED_NOW,
    clockSkewSeconds: 0,
    ...overrides
  };
}

function hasCode(code) {
  return (error) => error?.code === code && error.retryable === false;
}

function main() {
  const guard = installFixtureNetworkGuard({ label: "collection worker contract fixtures" });
  try {
    const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
    const otherKeys = crypto.generateKeyPairSync("ed25519");

    assert.deepEqual(FIXED_V2_WORKER_RUNTIME_FINGERPRINT, {
      node: "26.5.0",
      undici: "8.7.0",
      openssl: "3.5.7",
      platform: "linux",
      arch: "x64"
    });
    assert.equal(Object.isFrozen(FIXED_V2_WORKER_RUNTIME_FINGERPRINT), true);
    assert.deepEqual(REQUIRED_COLLECTION_WORKER_SCOPES, [
      "collection:claim",
      "collection:heartbeat",
      "collection:artifact:write",
      "collection:failure:write",
      "collection:result:finalize"
    ]);
    assert.equal(Object.isFrozen(REQUIRED_COLLECTION_WORKER_SCOPES), true);
    assert.equal(FIXED_V2_WORKER_COLLECTOR.collectorScope, "main_place_top3_inventory_ota");
    assert.deepEqual(FIXED_ONE_SHOT_POLICY, {
      oneShot: true,
      maxWorkerExecutions: 1,
      automaticRetry: false,
      automaticFallback: false,
      externalCallOnRead: false,
      saveRunOnSuccessOnly: true,
      saveFailureRun: false
    });

    const normalizedContract = normalizeCollectionJobContract(contract());
    assert.match(normalizedContract.keywordHash, /^[a-f0-9]{64}$/u);
    assert.equal(normalizedContract.rankStart, 1);
    assert.equal(normalizedContract.rankEnd, 50);
    assert.equal(normalizedContract.detailRankStart, 1);
    assert.equal(normalizedContract.detailRankEnd, 3);
    assert.equal(JSON.stringify(normalizedContract).includes("Synthetic region lodging"), false);
    assert.match(computeCollectionContractHash(normalizedContract), /^[a-f0-9]{64}$/u);
    assert.equal(
      buildCollectionIdempotencyKey(normalizedContract, {
        workerPoolId: WORKER_POOL_ID,
        audience: COLLECTION_WORKER_JOB_AUDIENCE
      }),
      buildCollectionIdempotencyKey(contract(), {
        workerPoolId: WORKER_POOL_ID,
        audience: COLLECTION_WORKER_JOB_AUDIENCE
      }),
      "raw and normalized forms must produce the same idempotency key"
    );

    const disabledSigned = buildSignedJobEnvelope(jobInput(), {
      privateKey,
      signerKeyId: SIGNER_KEY_ID,
      now: FIXED_NOW,
      ttlSeconds: 120
    });
    assert.equal(disabledSigned.documentType, COLLECTION_WORKER_JOB_DOCUMENT_TYPE);
    assert.equal(disabledSigned.schemaVersion, COLLECTION_WORKER_JOB_SCHEMA_VERSION);
    assert.equal(disabledSigned.signatureAlgorithm, COLLECTION_WORKER_SIGNATURE_ALGORITHM);
    assert.match(disabledSigned.signature, /^[A-Za-z0-9_-]{86}$/u);
    assert.equal(disabledSigned.authorization.enabled, false);
    assert.equal(disabledSigned.authorization.actualCallsEnabled, false);
    assert.equal(disabledSigned.authorization.externalCallApproved, false);
    assert.equal(disabledSigned.authorization.authorizedExecutionCount, 0);
    assert.equal(disabledSigned.policy.automaticRetry, false);
    assert.equal(disabledSigned.policy.automaticFallback, false);
    assert.equal(disabledSigned.policy.externalCallOnRead, false);
    assert.equal(Object.isFrozen(disabledSigned), true);
    assert.equal(JSON.stringify(disabledSigned).includes("Synthetic region lodging"), false);

    const inspectedDisabled = verifySignedJobEnvelope(disabledSigned, verifyOptions(publicKey, {
      requireExecutable: false
    }));
    assert.equal(inspectedDisabled.contractHash, computeCollectionContractHash(normalizedContract));
    assert.throws(
      () => assertCollectionWorkerJobExecutable(inspectedDisabled),
      hasCode("COLLECTION_WORKER_JOB_DISABLED")
    );
    assert.throws(
      () => verifySignedJobEnvelope(disabledSigned, verifyOptions(publicKey)),
      hasCode("COLLECTION_WORKER_JOB_DISABLED"),
      "verification must require an executable envelope unless explicitly inspecting disabled state"
    );

    const enabledSigned = buildSignedJobEnvelope(jobInput({
      authorization: enabledAuthorization()
    }), {
      privateKey,
      signerKeyId: SIGNER_KEY_ID,
      now: FIXED_NOW,
      ttlSeconds: 120
    });
    const verified = verifySignedJobEnvelope(enabledSigned, verifyOptions(publicKey));
    assert.equal(assertCollectionWorkerJobExecutable(verified), true);
    assert.equal(verified.authorization.authorizedExecutionCount, 1);
    assert.equal(verified.policy.oneShot, true);
    assert.equal(verified.policy.maxWorkerExecutions, 1);
    assert.deepEqual(verified.worker.scopes, REQUIRED_COLLECTION_WORKER_SCOPES);
    assert.deepEqual(verified.runtimeFingerprint, FIXED_V2_WORKER_RUNTIME_FINGERPRINT);
    assert.match(verified.runtimeFingerprintHash, /^[a-f0-9]{64}$/u);
    assert.match(verified.executionIdentityHash, /^[a-f0-9]{64}$/u);
    assert.match(verified.idempotencyKey, /^[a-f0-9]{64}$/u);

    assert.throws(
      () => buildSignedJobEnvelope(jobInput({
        authorization: {
          enabled: true,
          actualCallsEnabled: false,
          externalCallApproved: true,
          authorizedExecutionCount: 1
        }
      }), { privateKey, signerKeyId: SIGNER_KEY_ID, now: FIXED_NOW }),
      hasCode("COLLECTION_WORKER_AUTHORIZATION_INVALID"),
      "partially enabled authorization must fail closed"
    );
    assert.throws(
      () => buildSignedJobEnvelope(jobInput({
        authorization: {
          enabled: "false",
          actualCallsEnabled: false,
          externalCallApproved: false,
          authorizedExecutionCount: 0
        }
      }), { privateKey, signerKeyId: SIGNER_KEY_ID, now: FIXED_NOW }),
      hasCode("COLLECTION_WORKER_AUTHORIZATION_INVALID"),
      "string booleans must not be coerced into a disabled authorization"
    );
    for (const policyOverride of [
      { automaticRetry: true },
      { automaticFallback: true },
      { externalCallOnRead: true },
      { oneShot: false },
      { maxWorkerExecutions: 2 }
    ]) {
      assert.throws(
        () => buildSignedJobEnvelope(jobInput({ policy: policyOverride }), {
          privateKey,
          signerKeyId: SIGNER_KEY_ID,
          now: FIXED_NOW
        }),
        hasCode("COLLECTION_WORKER_POLICY_INVALID")
      );
    }

    for (const invalidScopes of [
      REQUIRED_COLLECTION_WORKER_SCOPES.slice(1),
      [...REQUIRED_COLLECTION_WORKER_SCOPES, "collection:*"],
      [...REQUIRED_COLLECTION_WORKER_SCOPES.slice(0, -1), REQUIRED_COLLECTION_WORKER_SCOPES[0]],
      ["*"]
    ]) {
      assert.throws(
        () => buildSignedJobEnvelope(jobInput({ workerScopes: invalidScopes }), {
          privateKey,
          signerKeyId: SIGNER_KEY_ID,
          now: FIXED_NOW
        }),
        hasCode("COLLECTION_WORKER_SCOPE_INVALID")
      );
    }

    for (const [field, value] of [
      ["node", "26.4.0"],
      ["undici", "8.6.0"],
      ["openssl", "3.5.6"],
      ["platform", "win32"],
      ["arch", "arm64"]
    ]) {
      assert.throws(
        () => buildSignedJobEnvelope(jobInput({
          runtimeFingerprint: { ...FIXED_V2_WORKER_RUNTIME_FINGERPRINT, [field]: value }
        }), { privateKey, signerKeyId: SIGNER_KEY_ID, now: FIXED_NOW }),
        hasCode("COLLECTION_WORKER_RUNTIME_MISMATCH")
      );
    }

    assert.throws(
      () => verifySignedJobEnvelope(enabledSigned, verifyOptions(otherKeys.publicKey)),
      hasCode("COLLECTION_WORKER_SIGNATURE_INVALID")
    );
    assert.throws(
      () => verifySignedJobEnvelope(enabledSigned, verifyOptions(publicKey, {
        expectedSignerKeyId: "different_dispatch_key"
      })),
      hasCode("COLLECTION_WORKER_SIGNATURE_INVALID")
    );
    assert.throws(
      () => verifySignedJobEnvelope(enabledSigned, verifyOptions(publicKey, {
        expectedWorkerId: "different_worker_fixture"
      })),
      hasCode("COLLECTION_WORKER_SCOPE_INVALID")
    );
    assert.throws(
      () => verifySignedJobEnvelope(enabledSigned, verifyOptions(publicKey, {
        expectedWorkerPoolId: "different_pool_fixture"
      })),
      hasCode("COLLECTION_WORKER_SCOPE_INVALID")
    );
    assert.throws(
      () => verifySignedJobEnvelope(enabledSigned, verifyOptions(publicKey, {
        expectedContractHash: "0".repeat(64)
      })),
      hasCode("COLLECTION_WORKER_CONTRACT_HASH_INVALID")
    );

    const wrongAudienceSigned = buildSignedJobEnvelope(jobInput({
      audience: "different.collector-worker",
      authorization: enabledAuthorization()
    }), {
      privateKey,
      signerKeyId: SIGNER_KEY_ID,
      now: FIXED_NOW,
      ttlSeconds: 120
    });
    assert.throws(
      () => verifySignedJobEnvelope(wrongAudienceSigned, verifyOptions(publicKey)),
      hasCode("COLLECTION_WORKER_AUDIENCE_MISMATCH")
    );
    assert.throws(
      () => buildSignedJobEnvelope(jobInput({ audience: "" }), {
        privateKey,
        signerKeyId: SIGNER_KEY_ID,
        now: FIXED_NOW
      }),
      hasCode("COLLECTION_WORKER_AUDIENCE_INVALID"),
      "an explicitly empty audience must not fall back to the default"
    );

    assert.throws(
      () => verifySignedJobEnvelope(enabledSigned, verifyOptions(publicKey, {
        now: new Date("2026-08-06T06:02:01.000Z")
      })),
      hasCode("COLLECTION_WORKER_JOB_EXPIRED")
    );
    assert.throws(
      () => verifySignedJobEnvelope(enabledSigned, verifyOptions(publicKey, {
        now: new Date("2026-08-06T05:59:59.000Z")
      })),
      hasCode("COLLECTION_WORKER_JOB_NOT_YET_VALID")
    );
    assert.throws(
      () => buildSignedJobEnvelope(jobInput(), {
        privateKey,
        signerKeyId: SIGNER_KEY_ID,
        now: FIXED_NOW,
        ttlSeconds: 901
      }),
      hasCode("COLLECTION_WORKER_TIME_INVALID")
    );

    const tamperedContract = {
      ...enabledSigned,
      contract: { ...enabledSigned.contract, checkIn: "2026-08-07" }
    };
    assert.throws(
      () => verifySignedJobEnvelope(tamperedContract, verifyOptions(publicKey)),
      hasCode("COLLECTION_WORKER_SIGNATURE_INVALID"),
      "contract mutation must invalidate the Ed25519 signature before execution"
    );

    const validlySignedWrongHash = resign({
      ...enabledSigned,
      contractHash: "f".repeat(64)
    }, privateKey);
    assert.throws(
      () => verifySignedJobEnvelope(validlySignedWrongHash, verifyOptions(publicKey)),
      hasCode("COLLECTION_WORKER_CONTRACT_HASH_INVALID"),
      "a valid signature must not bypass contract hash recomputation"
    );

    const validlySignedExtraScope = resign({
      ...enabledSigned,
      worker: {
        ...enabledSigned.worker,
        scopes: [...enabledSigned.worker.scopes, "collection:admin"]
      }
    }, privateKey);
    assert.throws(
      () => verifySignedJobEnvelope(validlySignedExtraScope, verifyOptions(publicKey)),
      hasCode("COLLECTION_WORKER_SCOPE_INVALID"),
      "a correctly signed envelope still must not expand the exact worker scope"
    );

    const validlySignedRetry = resign({
      ...enabledSigned,
      policy: { ...enabledSigned.policy, automaticRetry: true }
    }, privateKey);
    assert.throws(
      () => verifySignedJobEnvelope(validlySignedRetry, verifyOptions(publicKey)),
      hasCode("COLLECTION_WORKER_POLICY_INVALID")
    );

    assert.equal(guard.blockedAttempts(), 0);
    console.log("Collection worker contract fixtures passed.");
  } finally {
    guard.restore();
  }
}

main();
