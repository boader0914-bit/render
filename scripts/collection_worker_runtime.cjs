"use strict";

const crypto = require("node:crypto");
const {
  FIXED_V2_WORKER_RUNTIME_FINGERPRINT,
  assertCollectionWorkerJobExecutable,
  verifySignedJobEnvelope
} = require("./collection_worker_contract.cjs");
const {
  buildCollectionArtifactBundle,
  sha256Hex
} = require("./collection_artifact_contract.cjs");
const {
  verifyCollectionWorkerExecutionPayload
} = require("./collection_worker_execution_payload.cjs");

const COLLECTION_WORKER_RUNTIME_SCHEMA_VERSION = "collection-worker-runtime.v1";
const COLLECTION_WORKER_RESULT_SCHEMA_VERSION = "collection-worker-no-store-result.v1";
const COLLECTION_WORKER_MODE_SYNTHETIC = "synthetic";
const COLLECTION_WORKER_MODE_PROVIDER_CANARY = "provider_canary";
const COLLECTION_WORKER_MODES = new Set([
  COLLECTION_WORKER_MODE_SYNTHETIC,
  COLLECTION_WORKER_MODE_PROVIDER_CANARY
]);
const RESULT_STATUSES = new Set(["ready", "zero", "partial", "blocked", "failed"]);
const RESULT_KEYS = Object.freeze([
  "status",
  "providerAttemptCount",
  "executedCallCount",
  "automaticRetry",
  "automaticFallback",
  "currentResultReused",
  "fallbackResultReused",
  "resultStored",
  "writeCount",
  "organicCount",
  "adCount",
  "observedRankCount",
  "providerFailureSubtype",
  "diagnosticId"
]);

class CollectionWorkerRuntimeError extends Error {
  constructor(code, message, statusCode = 409) {
    super(message);
    this.name = "CollectionWorkerRuntimeError";
    this.code = code;
    this.statusCode = statusCode;
    this.retryable = false;
  }
}

function runtimeError(code, message, statusCode = 409) {
  return new CollectionWorkerRuntimeError(code, message, statusCode);
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

function exactKeys(value, expectedKeys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw runtimeError("COLLECTION_WORKER_RUNTIME_INPUT_INVALID", `${label} must be an object`, 400);
  }
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw runtimeError("COLLECTION_WORKER_RUNTIME_INPUT_INVALID", `${label} contains unsupported fields`, 400);
  }
}

function observeRuntimeFingerprint() {
  return deepFreeze({
    node: String(process.versions.node || ""),
    undici: String(process.versions.undici || ""),
    openssl: String(process.versions.openssl || ""),
    platform: String(process.platform || ""),
    arch: String(process.arch || "")
  });
}

function normalizeRuntimeFingerprint(value) {
  exactKeys(value, Object.keys(FIXED_V2_WORKER_RUNTIME_FINGERPRINT), "Collection worker runtime fingerprint");
  return deepFreeze(Object.fromEntries(
    Object.keys(FIXED_V2_WORKER_RUNTIME_FINGERPRINT).map((key) => [key, String(value[key] || "")])
  ));
}

function runtimeFingerprintMatches(value) {
  try {
    const normalized = normalizeRuntimeFingerprint(value);
    return Object.entries(FIXED_V2_WORKER_RUNTIME_FINGERPRINT)
      .every(([key, expected]) => normalized[key] === expected);
  } catch {
    return false;
  }
}

function assertExactV2RuntimeFingerprint(value) {
  const normalized = normalizeRuntimeFingerprint(value);
  for (const [key, expected] of Object.entries(FIXED_V2_WORKER_RUNTIME_FINGERPRINT)) {
    if (normalized[key] !== expected) {
      throw runtimeError(
        "COLLECTION_WORKER_RUNTIME_MISMATCH",
        `Collection worker runtime ${key} does not match the approved V2 runtime`,
        503
      );
    }
  }
  return normalized;
}

function nonNegativeIntegerOrNull(value, label) {
  if (value === null) return null;
  const normalized = Number(value);
  if (!Number.isInteger(normalized) || normalized < 0) {
    throw runtimeError("COLLECTION_WORKER_RESULT_INVALID", `${label} is invalid`, 502);
  }
  return normalized;
}

function nullableSafeIdentifier(value, label) {
  if (value === null) return null;
  const normalized = String(value || "");
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{1,127}$/u.test(normalized)) {
    throw runtimeError("COLLECTION_WORKER_RESULT_INVALID", `${label} is invalid`, 502);
  }
  return normalized;
}

function normalizeExecutionSummary(value, mode) {
  exactKeys(value, RESULT_KEYS, "Collection worker execution result");
  const providerAttemptCount = nonNegativeIntegerOrNull(value.providerAttemptCount, "providerAttemptCount");
  const executedCallCount = nonNegativeIntegerOrNull(value.executedCallCount, "executedCallCount");
  const expectedCalls = mode === COLLECTION_WORKER_MODE_PROVIDER_CANARY ? 1 : 0;
  if (
    !RESULT_STATUSES.has(value.status)
    || providerAttemptCount !== expectedCalls
    || executedCallCount !== expectedCalls
    || value.automaticRetry !== false
    || value.automaticFallback !== false
    || value.currentResultReused !== false
    || value.fallbackResultReused !== false
    || value.resultStored !== false
    || value.writeCount !== 0
  ) {
    throw runtimeError(
      "COLLECTION_WORKER_RESULT_POLICY_VIOLATION",
      "Collection worker result violates the no-store one-shot policy",
      502
    );
  }
  if (mode === COLLECTION_WORKER_MODE_SYNTHETIC && value.status === "blocked") {
    throw runtimeError("COLLECTION_WORKER_RESULT_INVALID", "Synthetic collection result cannot be provider-blocked", 502);
  }
  return deepFreeze({
    status: value.status,
    providerAttemptCount,
    executedCallCount,
    automaticRetry: false,
    automaticFallback: false,
    currentResultReused: false,
    fallbackResultReused: false,
    resultStored: false,
    writeCount: 0,
    organicCount: nonNegativeIntegerOrNull(value.organicCount, "organicCount"),
    adCount: nonNegativeIntegerOrNull(value.adCount, "adCount"),
    observedRankCount: nonNegativeIntegerOrNull(value.observedRankCount, "observedRankCount"),
    providerFailureSubtype: nullableSafeIdentifier(value.providerFailureSubtype, "providerFailureSubtype"),
    diagnosticId: nullableSafeIdentifier(value.diagnosticId, "diagnosticId")
  });
}

function assertDisabledSyntheticJob(job) {
  const authorization = job?.authorization;
  if (
    !authorization
    || authorization.enabled !== false
    || authorization.actualCallsEnabled !== false
    || authorization.externalCallApproved !== false
    || authorization.authorizedExecutionCount !== 0
  ) {
    throw runtimeError(
      "COLLECTION_WORKER_SYNTHETIC_AUTHORIZATION_INVALID",
      "Synthetic collection worker jobs must remain externally disabled",
      409
    );
  }
}

function assertJobRuntime(job, runtimeFingerprint) {
  if (!job || typeof job !== "object" || !runtimeFingerprintMatches(job.runtimeFingerprint)) {
    throw runtimeError("COLLECTION_WORKER_RUNTIME_MISMATCH", "Collection worker job runtime is invalid", 409);
  }
  for (const key of Object.keys(FIXED_V2_WORKER_RUNTIME_FINGERPRINT)) {
    if (job.runtimeFingerprint[key] !== runtimeFingerprint[key]) {
      throw runtimeError("COLLECTION_WORKER_RUNTIME_MISMATCH", "Collection worker job runtime does not match", 409);
    }
  }
}

function defaultRuntimeId(runtimeFingerprint) {
  const fingerprintHash = sha256Hex(Buffer.from(JSON.stringify(runtimeFingerprint), "utf8"));
  return `runtime:${fingerprintHash.slice(0, 24)}`;
}

function buildDefaultArtifactInput({ job, runtimeId, summary }) {
  const content = JSON.stringify({
    schemaVersion: COLLECTION_WORKER_RESULT_SCHEMA_VERSION,
    contractHash: job.contractHash,
    executionIdentityHash: job.executionIdentityHash,
    status: summary.status,
    providerAttemptCount: summary.providerAttemptCount,
    executedCallCount: summary.executedCallCount,
    automaticRetry: false,
    automaticFallback: false,
    currentResultReused: false,
    fallbackResultReused: false,
    resultStored: false,
    writeCount: 0,
    organicCount: summary.organicCount,
    adCount: summary.adCount,
    observedRankCount: summary.observedRankCount,
    providerFailureSubtype: summary.providerFailureSubtype,
    diagnosticId: summary.diagnosticId
  });
  return deepFreeze({
    identity: {
      jobId: job.jobId,
      attemptId: job.attemptId,
      workerId: job.worker.workerId,
      workerPoolId: job.worker.workerPoolId,
      runtimeId,
      contractHash: job.contractHash,
      executionIdentityHash: job.executionIdentityHash
    },
    files: [{ path: "canary-summary.json", content }]
  });
}

function assertSignedArtifactShape(value) {
  if (
    !value
    || typeof value !== "object"
    || Array.isArray(value)
    || !value.bundle
    || typeof value.bundle !== "object"
    || typeof value.signature !== "string"
  ) {
    throw runtimeError("COLLECTION_WORKER_ARTIFACT_INVALID", "Collection worker signed artifact is invalid", 502);
  }
  return value;
}

async function readWriteCount(observer) {
  const count = Number(await observer());
  if (!Number.isInteger(count) || count < 0) {
    throw runtimeError("COLLECTION_WORKER_WRITE_OBSERVER_INVALID", "Collection worker write observer is invalid", 500);
  }
  return count;
}

function createCollectionWorkerRuntime(options = {}) {
  const enabled = options.enabled === true;
  const runtimeFingerprint = normalizeRuntimeFingerprint(
    options.runtimeFingerprint || observeRuntimeFingerprint()
  );
  const runtimeId = String(options.runtimeId || defaultRuntimeId(runtimeFingerprint));
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/u.test(runtimeId)) {
    throw runtimeError("COLLECTION_WORKER_RUNTIME_INPUT_INVALID", "Collection worker runtimeId is invalid", 400);
  }
  const usedExecutionIdentities = new Set();
  const writeObserver = options.writeObserver || (() => 0);
  if (typeof writeObserver !== "function") {
    throw runtimeError("COLLECTION_WORKER_DEPENDENCY_INVALID", "Collection worker write observer is invalid", 500);
  }

  const verifyJob = options.verifyJob || ((signedJob, context) => verifySignedJobEnvelope(
    signedJob,
    { ...(options.jobVerification || {}), requireExecutable: context.requireExecutable }
  ));
  const buildArtifact = options.buildArtifact || buildDefaultArtifactInput;
  const verifyExecutionPayload = options.verifyExecutionPayload || verifyCollectionWorkerExecutionPayload;
  const signArtifact = options.signArtifact || ((artifactInput) => {
    if (!options.artifactPrivateKey || !options.artifactKeyId) {
      throw runtimeError(
        "COLLECTION_WORKER_DEPENDENCY_INVALID",
        "Collection worker artifact signing dependency is unavailable",
        500
      );
    }
    return buildCollectionArtifactBundle(artifactInput, {
      privateKey: options.artifactPrivateKey,
      keyId: options.artifactKeyId
    });
  });

  if (
    typeof verifyJob !== "function"
    || typeof verifyExecutionPayload !== "function"
    || typeof buildArtifact !== "function"
    || typeof signArtifact !== "function"
  ) {
    throw runtimeError("COLLECTION_WORKER_DEPENDENCY_INVALID", "Collection worker dependency is invalid", 500);
  }
  if (options.executor !== undefined && typeof options.executor !== "function") {
    throw runtimeError("COLLECTION_WORKER_DEPENDENCY_INVALID", "Collection worker executor is invalid", 500);
  }

  async function execute(input = {}) {
    if (!enabled) {
      throw runtimeError("COLLECTION_WORKER_DISABLED", "Collection worker runtime is disabled", 503);
    }
    const exactRuntime = assertExactV2RuntimeFingerprint(runtimeFingerprint);
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw runtimeError("COLLECTION_WORKER_RUNTIME_INPUT_INVALID", "Collection worker execution input is invalid", 400);
    }
    const mode = String(input.mode || "");
    if (!COLLECTION_WORKER_MODES.has(mode)) {
      throw runtimeError("COLLECTION_WORKER_MODE_INVALID", "Collection worker mode is invalid", 400);
    }
    exactKeys(
      input,
      mode === COLLECTION_WORKER_MODE_SYNTHETIC
        ? ["mode", "signedJob", "syntheticResult"]
        : ["mode", "signedJob", "executionPayload"],
      "Collection worker execution input"
    );
    const requireExecutable = mode === COLLECTION_WORKER_MODE_PROVIDER_CANARY;
    const verifiedJob = await verifyJob(input.signedJob, {
      mode,
      requireExecutable,
      runtimeFingerprint: exactRuntime
    });
    assertJobRuntime(verifiedJob, exactRuntime);
    if (requireExecutable) assertCollectionWorkerJobExecutable(verifiedJob);
    else assertDisabledSyntheticJob(verifiedJob);
    const executionPayload = requireExecutable
      ? await verifyExecutionPayload(input.executionPayload, verifiedJob)
      : null;

    const executionIdentityHash = String(verifiedJob.executionIdentityHash || "");
    if (!/^[a-f0-9]{64}$/u.test(executionIdentityHash)) {
      throw runtimeError("COLLECTION_WORKER_RUNTIME_INPUT_INVALID", "Collection worker execution identity is invalid", 400);
    }
    if (usedExecutionIdentities.has(executionIdentityHash)) {
      throw runtimeError("COLLECTION_WORKER_EXECUTION_REUSED", "Collection worker one-shot execution was already used", 409);
    }
    usedExecutionIdentities.add(executionIdentityHash);

    const writesBefore = await readWriteCount(writeObserver);
    try {
      let rawResult;
      if (mode === COLLECTION_WORKER_MODE_SYNTHETIC) {
        rawResult = input.syntheticResult;
      } else {
        if (typeof options.executor !== "function") {
          throw runtimeError(
            "COLLECTION_WORKER_EXECUTOR_REQUIRED",
            "Collection worker provider execution requires an injected executor",
            503
          );
        }
        rawResult = await options.executor(deepFreeze({
          mode,
          job: verifiedJob,
          executionPayload,
          callBudget: 1,
          maxProviderAttempts: 1,
          automaticRetry: false,
          automaticFallback: false,
          allowCurrentResultReuse: false,
          allowFallbackResultReuse: false,
          saveResult: false
        }));
      }

      const summary = normalizeExecutionSummary(rawResult, mode);
      const writesAfterExecution = await readWriteCount(writeObserver);
      if (writesAfterExecution !== writesBefore) {
        throw runtimeError("COLLECTION_WORKER_WRITE_DETECTED", "Collection worker executor attempted a write", 500);
      }
      const artifactInput = await buildArtifact({
        job: verifiedJob,
        runtimeId,
        runtimeFingerprint: exactRuntime,
        mode,
        summary
      });
      const signedArtifact = assertSignedArtifactShape(await signArtifact(artifactInput, {
        job: verifiedJob,
        runtimeId,
        runtimeFingerprint: exactRuntime,
        mode,
        summary
      }));
      const writesAfterArtifact = await readWriteCount(writeObserver);
      if (writesAfterArtifact !== writesBefore) {
        throw runtimeError("COLLECTION_WORKER_WRITE_DETECTED", "Collection worker artifact path attempted a write", 500);
      }

      return deepFreeze({
        schemaVersion: COLLECTION_WORKER_RUNTIME_SCHEMA_VERSION,
        mode,
        runtimeId,
        runtimeFingerprint: exactRuntime,
        jobId: verifiedJob.jobId,
        attemptId: verifiedJob.attemptId,
        contractHash: verifiedJob.contractHash,
        executionIdentityHash,
        status: summary.status,
        providerAttemptCount: summary.providerAttemptCount,
        executedCallCount: summary.executedCallCount,
        automaticRetry: false,
        automaticFallback: false,
        currentResultReused: false,
        fallbackResultReused: false,
        resultStored: false,
        writeCount: 0,
        signedArtifact
      });
    } catch (error) {
      const writesAfterFailure = await readWriteCount(writeObserver);
      if (writesAfterFailure !== writesBefore && error?.code !== "COLLECTION_WORKER_WRITE_DETECTED") {
        throw runtimeError("COLLECTION_WORKER_WRITE_DETECTED", "Collection worker failure path attempted a write", 500);
      }
      throw error;
    }
  }

  return Object.freeze({
    describe() {
      return deepFreeze({
        schemaVersion: COLLECTION_WORKER_RUNTIME_SCHEMA_VERSION,
        enabled,
        runtimeId,
        runtimeFingerprint,
        runtimeReady: runtimeFingerprintMatches(runtimeFingerprint),
        supportedModes: [...COLLECTION_WORKER_MODES],
        automaticRetry: false,
        automaticFallback: false,
        currentResultReuse: false,
        fallbackResultReuse: false,
        resultWritesEnabled: false
      });
    },
    execute
  });
}

module.exports = {
  COLLECTION_WORKER_MODE_PROVIDER_CANARY,
  COLLECTION_WORKER_MODE_SYNTHETIC,
  COLLECTION_WORKER_RESULT_SCHEMA_VERSION,
  COLLECTION_WORKER_RUNTIME_SCHEMA_VERSION,
  CollectionWorkerRuntimeError,
  assertExactV2RuntimeFingerprint,
  createCollectionWorkerRuntime,
  normalizeExecutionSummary,
  observeRuntimeFingerprint,
  runtimeFingerprintMatches
};
