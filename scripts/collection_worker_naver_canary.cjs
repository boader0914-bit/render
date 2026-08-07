"use strict";

const crypto = require("node:crypto");
const {
  COLLECTION_WORKER_JOB_AUDIENCE,
  verifySignedJobEnvelope
} = require("./collection_worker_contract.cjs");
const {
  verifyCollectionWorkerExecutionPayload
} = require("./collection_worker_execution_payload.cjs");
const {
  COLLECTION_WORKER_MODE_PROVIDER_CANARY,
  assertExactV2RuntimeFingerprint,
  createCollectionWorkerRuntime,
  observeRuntimeFingerprint
} = require("./collection_worker_runtime.cjs");
const {
  ALLOWED_PATH_SCOPES,
  COLLECTION_WORKER_AUTH_AUDIENCE,
  buildSignedWorkerRequest,
  sha256Hex
} = require("./collection_worker_auth.cjs");
const {
  NAVER_LEGACY_CANARY_STRATEGY_VERSION
} = require("./naver_legacy_canary_contract.cjs");
const {
  V2_ENV_WORKER_PHASE,
  V2_ENV_WORKER_STRATEGY
} = require("./v2_env_worker_contract.cjs");
const {
  buildLiveCanaryPlan,
  parseLiveCanaryResponse,
  safeCanaryErrorResult
} = require("./naver_legacy_canary_pure.cjs");
const {
  createNaverLegacyCanaryLiveTransport,
  isRegisteredNaverLegacyCanaryLiveTransport
} = require("./naver_legacy_canary_live_transport.cjs");
const { NAVER_PROVIDER_ID } = require("./naver_provider_resilience.cjs");
const {
  CLAIM_PATH,
  COLLECTION_WORKER_CANARY_ARTIFACT_KEY_ID,
  COLLECTION_WORKER_CANARY_DISPATCH_KEY_ID,
  COLLECTION_WORKER_CANARY_REQUEST_KEY_ID,
  COLLECTION_WORKER_CANARY_RUNTIME_ID_PREFIX,
  COLLECTION_WORKER_CANARY_TARGET_SERVICE_ID,
  COLLECTION_WORKER_CANARY_WORKER_ID,
  COLLECTION_WORKER_CANARY_WORKER_POOL_ID,
  FAILURE_PATH,
  FINALIZE_PATH,
  PREFLIGHT_PATH,
  SIGNED_PREPARE_PATH,
  buildArtifactKeyProof,
  decodeEd25519Key,
  stableJson
} = require("./collection_worker_canary_protocol.cjs");

const COLLECTION_WORKER_NAVER_CANARY_SCHEMA_VERSION = "collection-worker-naver-canary.v2";
const TARGET_PREVIEW_BASE_URL = "https://sa-labs-datalab-v4-preview.onrender.com";
const MAX_INTERNAL_RESPONSE_BYTES = 1024 * 1024;
const INTERNAL_TIMEOUT_MS = 20_000;
const COMMIT_PATTERN = /^[a-f0-9]{40}$/u;
const ENV = Object.freeze({
  artifactPrivateKey: "COLLECTION_WORKER_ARTIFACT_PRIVATE_KEY_B64",
  dispatchPublicKey: "COLLECTION_WORKER_DISPATCH_PUBLIC_KEY_B64",
  externalCalls: "COLLECTOR_EXTERNAL_CALLS_ENABLED",
  oneShotEnabled: "COLLECTION_WORKER_ONE_SHOT_ENABLED",
  previewBaseUrl: "COLLECTION_WORKER_PREVIEW_BASE_URL",
  requestPrivateKey: "COLLECTION_WORKER_REQUEST_PRIVATE_KEY_B64",
  resultWrites: "COLLECTOR_RESULT_WRITE_ENABLED",
  workerMode: "COLLECTOR_WORKER_MODE"
});
const FIXTURE_OVERRIDE_KEYS = Object.freeze([
  "afterProviderExecution",
  "environment",
  "internalFetchImpl",
  "now",
  "providerTransport",
  "runtimeFingerprint"
]);

class CollectionWorkerNaverCanaryError extends Error {
  constructor(code, message, statusCode = 409, meta = {}) {
    super(message);
    this.name = "CollectionWorkerNaverCanaryError";
    this.code = code;
    this.statusCode = statusCode;
    this.providerAttemptCount = Number(meta.providerAttemptCount || 0);
    this.retryAt = meta.retryAt || null;
    this.retryAfterSeconds = meta.retryAfterSeconds ?? null;
    this.retryable = false;
  }
}

function fail(code, message, statusCode = 409, meta = {}) {
  return new CollectionWorkerNaverCanaryError(code, message, statusCode, meta);
}

function fixtureModeFor(input) {
  const fixtureMode = input.fixtureMode === true;
  const processIsProduction = process.env.RENDER === "true" || process.env.NODE_ENV === "production";
  const hasOverride = FIXTURE_OVERRIDE_KEYS.some((key) => input[key] !== undefined);
  if ((fixtureMode && processIsProduction) || (!fixtureMode && hasOverride)) {
    throw fail("COLLECTION_WORKER_CANARY_FIXTURE_BOUNDARY_INVALID", "Worker canary fixture boundary is invalid", 403);
  }
  return fixtureMode;
}

function assertWorkerEnvironment(environment) {
  const env = environment || {};
  const commit = String(env.RENDER_GIT_COMMIT || "").trim();
  const baseUrl = String(env[ENV.previewBaseUrl] || "").replace(/\/+$/u, "");
  if (
    env.RENDER !== "true"
    || env.RENDER_SERVICE_ID !== COLLECTION_WORKER_CANARY_TARGET_SERVICE_ID
    || !COMMIT_PATTERN.test(commit)
    || env[ENV.workerMode] !== "disabled"
    || env[ENV.externalCalls] !== "false"
    || env[ENV.resultWrites] !== "false"
    || env[ENV.oneShotEnabled] !== "true"
    || baseUrl !== TARGET_PREVIEW_BASE_URL
  ) {
    throw fail("COLLECTION_WORKER_CANARY_RUNTIME_INVALID", "Worker canary runtime is not explicitly approved", 403);
  }
  return Object.freeze({
    artifactPrivateKey: decodeEd25519Key(env[ENV.artifactPrivateKey], "private"),
    baseUrl,
    commit,
    dispatchPublicKey: decodeEd25519Key(env[ENV.dispatchPublicKey], "public"),
    requestPrivateKey: decodeEd25519Key(env[ENV.requestPrivateKey], "private")
  });
}

function safeInstant(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw fail("COLLECTION_WORKER_CANARY_CLOCK_INVALID", "Worker canary clock is invalid", 500);
  }
  return date;
}

function canarySearchContract(rawContract) {
  return Object.freeze({
    keyword: rawContract.keyword,
    searchMode: "keyword",
    rankStart: 1,
    rankEnd: 50,
    display: 50,
    regionKey: null,
    categoryKey: "glamping",
    measurementPeriod: null,
    currentQueryCandidates: Object.freeze([rawContract.keyword]),
    legacyNaverQuery: rawContract.keyword
  });
}

function diagnosticId(executionIdentityHash, startedAt) {
  return `crawl-${crypto.createHash("sha256").update(`${executionIdentityHash}:${startedAt}`).digest("hex").slice(0, 12)}`;
}

function createProviderExecutor(input) {
  const { transport, startedAt } = input;
  const afterProviderExecution = typeof input.afterProviderExecution === "function"
    ? input.afterProviderExecution
    : null;
  let captured = null;
  const executor = async (context) => {
    if (
      context.callBudget !== 1
      || context.maxProviderAttempts !== 1
      || context.automaticRetry !== false
      || context.automaticFallback !== false
      || context.allowCurrentResultReuse !== false
      || context.allowFallbackResultReuse !== false
      || context.saveResult !== false
      || !isRegisteredNaverLegacyCanaryLiveTransport(transport)
      || transport.maxCalls !== 1
      || transport.callCount() !== 0
    ) {
      throw fail("COLLECTION_WORKER_CANARY_POLICY_INVALID", "Worker canary policy is invalid", 500);
    }

    let rawContract = context.executionPayload.contract;
    const livePlan = buildLiveCanaryPlan(canarySearchContract(rawContract));
    let safe;
    try {
      const response = await transport(Object.freeze({
        providerId: NAVER_PROVIDER_ID,
        providerOperation: livePlan.collectorPlan.providerOperation,
        query: rawContract.keyword,
        searchMode: rawContract.searchMode,
        rankStart: 1,
        rankEnd: 50,
        display: 50,
        requestOrdinal: 1,
        callBudget: 1,
        actualCallsEnabled: true,
        fixtureOnly: false
      }));
      if (transport.callCount() !== 1) {
        throw fail("COLLECTION_WORKER_CANARY_CALL_BUDGET_EXCEEDED", "Worker canary call count is invalid", 409);
      }
      const parsed = parseLiveCanaryResponse(response, livePlan, startedAt, 1);
      const resultStatus = parsed.organicCount === 50
        ? "ready"
        : parsed.organicCount === 0
          ? "zero"
          : "partial";
      safe = Object.freeze({
        status: resultStatus,
        organicCount: parsed.organicCount,
        adCount: parsed.adCount,
        observedRankCount: parsed.observedRankCount,
        providerFailureSubtype: null,
        diagnosticId: diagnosticId(context.job.executionIdentityHash, startedAt)
      });
    } catch (error) {
      if (transport.callCount() !== 1) throw error;
      const projected = safeCanaryErrorResult({
        code: error?.code,
        providerFailureSubtype: error?.providerFailureSubtype,
        diagnosticId: error?.diagnosticId || diagnosticId(context.job.executionIdentityHash, startedAt),
        retryAt: error?.retryAt,
        retryAfterSeconds: error?.retryAfterSeconds,
        externalAttemptCount: 1
      });
      safe = Object.freeze({
        status: projected.code === "NAVER_ACCESS_BLOCKED" ? "blocked" : "failed",
        organicCount: null,
        adCount: null,
        observedRankCount: null,
        providerFailureSubtype: projected.providerResponseSubtype,
        diagnosticId: projected.diagnosticId || diagnosticId(context.job.executionIdentityHash, startedAt)
      });
    } finally {
      rawContract = null;
    }
    if (afterProviderExecution) {
      await afterProviderExecution(Object.freeze({
        providerAttemptCount: transport.callCount(),
        status: safe.status
      }));
    }
    captured = safe;
    return Object.freeze({
      status: safe.status,
      providerAttemptCount: 1,
      executedCallCount: 1,
      automaticRetry: false,
      automaticFallback: false,
      currentResultReused: false,
      fallbackResultReused: false,
      resultStored: false,
      writeCount: 0,
      organicCount: safe.organicCount,
      adCount: safe.adCount,
      observedRankCount: safe.observedRankCount,
      providerFailureSubtype: safe.providerFailureSubtype,
      diagnosticId: safe.diagnosticId
    });
  };
  return Object.freeze({ executor, captured: () => captured });
}

async function readBoundedJsonResponse(response) {
  const contentLength = Number(response?.headers?.get?.("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_INTERNAL_RESPONSE_BYTES) {
    await response?.body?.cancel?.().catch(() => {});
    throw fail("COLLECTION_WORKER_INTERNAL_RESPONSE_TOO_LARGE", "Preview response is too large", 502);
  }
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > MAX_INTERNAL_RESPONSE_BYTES) {
    throw fail("COLLECTION_WORKER_INTERNAL_RESPONSE_TOO_LARGE", "Preview response is too large", 502);
  }
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw fail("COLLECTION_WORKER_INTERNAL_RESPONSE_INVALID", "Preview response is invalid", 502);
  }
  if (!response.ok) {
    throw fail(
      String(payload?.code || "COLLECTION_WORKER_INTERNAL_REQUEST_FAILED"),
      "Preview rejected the worker request",
      Number(response.status || 502),
      {
        retryAt: payload?.retryAt,
        retryAfterSeconds: payload?.retryAfterSeconds
      }
    );
  }
  return payload;
}

async function postSignedWorkerRequest(input) {
  const bodyText = stableJson(input.body);
  const signedRequest = buildSignedWorkerRequest({
    audience: COLLECTION_WORKER_AUTH_AUDIENCE,
    workerId: COLLECTION_WORKER_CANARY_WORKER_ID,
    workerPoolId: COLLECTION_WORKER_CANARY_WORKER_POOL_ID,
    keyId: COLLECTION_WORKER_CANARY_REQUEST_KEY_ID,
    method: "POST",
    path: input.path,
    scope: ALLOWED_PATH_SCOPES[input.path],
    issuedAt: input.now,
    nonce: crypto.randomBytes(18).toString("base64url"),
    bodySha256: sha256Hex(bodyText)
  }, { privateKey: input.requestPrivateKey });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), INTERNAL_TIMEOUT_MS);
  timer.unref?.();
  try {
    const response = await input.fetchImpl(new URL(input.path, `${input.baseUrl}/`), {
      method: "POST",
      headers: { "content-type": "application/json" },
      redirect: "error",
      signal: controller.signal,
      body: JSON.stringify({ signedRequest, body: input.body })
    });
    return await readBoundedJsonResponse(response);
  } catch (error) {
    if (error instanceof CollectionWorkerNaverCanaryError) throw error;
    throw fail(
      controller.signal.aborted
        ? "COLLECTION_WORKER_INTERNAL_REQUEST_TIMEOUT"
        : "COLLECTION_WORKER_INTERNAL_REQUEST_FAILED",
      "Preview worker request failed",
      controller.signal.aborted ? 504 : 502
    );
  } finally {
    clearTimeout(timer);
  }
}

async function postFinalizationWithOneInternalRecovery(input) {
  try {
    return await postSignedWorkerRequest(input);
  } catch (error) {
    const retryable = Number(error?.statusCode || 0) >= 500 || [
      "COLLECTION_WORKER_INTERNAL_REQUEST_FAILED",
      "COLLECTION_WORKER_INTERNAL_REQUEST_TIMEOUT"
    ].includes(String(error?.code || ""));
    // This retries only the Preview receipt hand-off with a fresh request
    // nonce. The durable artifact hash makes it idempotent; the NAVER
    // transport has already exhausted its one-call budget and is never rerun.
    if (retryable) {
      try {
        return await postSignedWorkerRequest(input);
      } catch {
        // The provider call has already happened. Never downgrade this to a
        // zero-attempt failure or repeat the provider transport.
      }
    }
    throw fail(
      "COLLECTION_WORKER_CANARY_FINALIZATION_INDETERMINATE",
      "Preview did not durably acknowledge the worker artifact",
      502,
      { providerAttemptCount: 1 }
    );
  }
}

async function postFailureWithOneInternalRecovery(input) {
  try {
    return await postSignedWorkerRequest(input);
  } catch (error) {
    const retryable = Number(error?.statusCode || 0) >= 500 || [
      "COLLECTION_WORKER_INTERNAL_REQUEST_FAILED",
      "COLLECTION_WORKER_INTERNAL_REQUEST_TIMEOUT"
    ].includes(String(error?.code || ""));
    if (!retryable) throw error;
    return postSignedWorkerRequest(input);
  }
}

function safeFatalResult(error) {
  const candidate = String(error?.code || "");
  const code = /^[A-Z][A-Z0-9_]{2,127}$/u.test(candidate)
    ? candidate
    : "COLLECTION_WORKER_CANARY_FAILED";
  const providerAttemptCount = [0, 1].includes(Number(error?.providerAttemptCount))
    ? Number(error.providerAttemptCount)
    : 0;
  return Object.freeze({
    schemaVersion: COLLECTION_WORKER_NAVER_CANARY_SCHEMA_VERSION,
    status: "failed",
    code,
    providerAttemptCount,
    executedCallCount: providerAttemptCount,
    automaticRetry: false,
    automaticFallback: false,
    currentResultReused: false,
    fallbackResultReused: false,
    resultStored: false,
    writeCount: 0
  });
}

async function runCollectionWorkerNaverCanary(input = {}) {
  const fixtureMode = fixtureModeFor(input);
  const clock = () => safeInstant(fixtureMode ? input.now : new Date());
  const now = clock();
  const environment = fixtureMode ? input.environment : process.env;
  const runtimeFingerprint = assertExactV2RuntimeFingerprint(
    fixtureMode ? input.runtimeFingerprint : observeRuntimeFingerprint()
  );
  const worker = assertWorkerEnvironment(environment);
  const internalFetchImpl = fixtureMode ? input.internalFetchImpl : globalThis.fetch;
  if (typeof internalFetchImpl !== "function") {
    throw fail("COLLECTION_WORKER_INTERNAL_TRANSPORT_INVALID", "Preview transport is unavailable", 500);
  }

  if (input.prepareContract) {
    await postSignedWorkerRequest({
      baseUrl: worker.baseUrl,
      body: {
        workerId: COLLECTION_WORKER_CANARY_WORKER_ID,
        workerPoolId: COLLECTION_WORKER_CANARY_WORKER_POOL_ID,
        workerCommit: worker.commit,
        contract: input.prepareContract
      },
      fetchImpl: internalFetchImpl,
      now,
      path: SIGNED_PREPARE_PATH,
      requestPrivateKey: worker.requestPrivateKey
    });
  }

  const claim = await postSignedWorkerRequest({
    baseUrl: worker.baseUrl,
    body: {
      workerId: COLLECTION_WORKER_CANARY_WORKER_ID,
      workerPoolId: COLLECTION_WORKER_CANARY_WORKER_POOL_ID,
      workerCommit: worker.commit
    },
    fetchImpl: internalFetchImpl,
    now,
    path: CLAIM_PATH,
    requestPrivateKey: worker.requestPrivateKey
  });
  if (claim?.status !== "claimed" || !claim.job) {
    throw fail("COLLECTION_WORKER_CANARY_NO_JOB", "No approved collection worker canary job is available", 409);
  }
  const claimed = claim.job;
  if (
    claimed.targetWorkerCommit !== worker.commit
    || !Number.isInteger(claimed.workflowRevision)
    || claimed.workflowRevision < 1
    || Date.parse(String(claimed.leaseExpiresAt || "")) <= clock().getTime()
  ) {
    throw fail("COLLECTION_WORKER_CANARY_CLAIM_INVALID", "Worker canary claim is invalid or expired", 409);
  }

  const runtimeId = `${COLLECTION_WORKER_CANARY_RUNTIME_ID_PREFIX}${worker.commit.slice(0, 12)}`;
  const verifiedJob = verifySignedJobEnvelope(claimed.signedJob, {
    publicKey: worker.dispatchPublicKey,
    expectedSignerKeyId: COLLECTION_WORKER_CANARY_DISPATCH_KEY_ID,
    expectedAudience: COLLECTION_WORKER_JOB_AUDIENCE,
    expectedWorkerId: COLLECTION_WORKER_CANARY_WORKER_ID,
    expectedWorkerPoolId: COLLECTION_WORKER_CANARY_WORKER_POOL_ID,
    now: clock(),
    clockSkewSeconds: 30,
    requireExecutable: true
  });
  verifyCollectionWorkerExecutionPayload(claimed.executionPayload, verifiedJob);

  try {
    const proofInput = {
      jobId: verifiedJob.jobId,
      attemptId: verifiedJob.attemptId,
      workflowRevision: claimed.workflowRevision,
      workerId: COLLECTION_WORKER_CANARY_WORKER_ID,
      workerPoolId: COLLECTION_WORKER_CANARY_WORKER_POOL_ID,
      workerCommit: worker.commit,
      runtimeId,
      contractHash: verifiedJob.contractHash,
      executionIdentityHash: verifiedJob.executionIdentityHash
    };
    await postSignedWorkerRequest({
      baseUrl: worker.baseUrl,
      body: {
        jobId: verifiedJob.jobId,
        attemptId: verifiedJob.attemptId,
        workflowRevision: claimed.workflowRevision,
        workerCommit: worker.commit,
        runtimeId,
        artifactKeyProof: buildArtifactKeyProof(proofInput, worker.artifactPrivateKey)
      },
      fetchImpl: internalFetchImpl,
      now: clock(),
      path: PREFLIGHT_PATH,
      requestPrivateKey: worker.requestPrivateKey
    });
  } catch (error) {
    await postFailureWithOneInternalRecovery({
      baseUrl: worker.baseUrl,
      body: {
        jobId: verifiedJob.jobId,
        attemptId: verifiedJob.attemptId,
        workflowRevision: claimed.workflowRevision,
        code: /^[A-Z][A-Z0-9_]{2,127}$/u.test(String(error?.code || ""))
          ? error.code
          : "COLLECTION_WORKER_CANARY_PREFLIGHT_FAILED",
        providerAttemptCount: 0
      },
      fetchImpl: internalFetchImpl,
      now: clock(),
      path: FAILURE_PATH,
      requestPrivateKey: worker.requestPrivateKey
    }).catch(() => {});
    throw fail(
      String(error?.code || "COLLECTION_WORKER_CANARY_PREFLIGHT_FAILED"),
      "Worker canary preflight failed",
      Number(error?.statusCode || 502),
      { providerAttemptCount: 0 }
    );
  }

  const providerTransport = fixtureMode
    ? input.providerTransport
    : createNaverLegacyCanaryLiveTransport({ enabled: true, fetchImpl: globalThis.fetch });
  if (!isRegisteredNaverLegacyCanaryLiveTransport(providerTransport)) {
    throw fail("COLLECTION_WORKER_CANARY_TRANSPORT_INVALID", "NAVER canary transport is invalid", 500);
  }
  const providerStartedAt = clock().toISOString();
  const provider = createProviderExecutor({
    transport: providerTransport,
    startedAt: providerStartedAt,
    afterProviderExecution: fixtureMode ? input.afterProviderExecution : null
  });
  const runtime = createCollectionWorkerRuntime({
    enabled: true,
    runtimeFingerprint,
    runtimeId,
    jobVerification: {
      publicKey: worker.dispatchPublicKey,
      expectedSignerKeyId: COLLECTION_WORKER_CANARY_DISPATCH_KEY_ID,
      expectedAudience: COLLECTION_WORKER_JOB_AUDIENCE,
      expectedWorkerId: COLLECTION_WORKER_CANARY_WORKER_ID,
      expectedWorkerPoolId: COLLECTION_WORKER_CANARY_WORKER_POOL_ID,
      now: clock(),
      clockSkewSeconds: 30
    },
    artifactPrivateKey: worker.artifactPrivateKey,
    artifactKeyId: COLLECTION_WORKER_CANARY_ARTIFACT_KEY_ID,
    writeObserver: () => 0,
    executor: provider.executor
  });

  let executed;
  try {
    executed = await runtime.execute({
      mode: COLLECTION_WORKER_MODE_PROVIDER_CANARY,
      signedJob: claimed.signedJob,
      executionPayload: claimed.executionPayload
    });
  } catch (error) {
    const providerAttemptCount = Number(providerTransport.callCount?.() || 0);
    await postFailureWithOneInternalRecovery({
      baseUrl: worker.baseUrl,
      body: {
        jobId: claimed.signedJob?.jobId,
        attemptId: claimed.signedJob?.attemptId,
        workflowRevision: claimed.workflowRevision,
        code: /^[A-Z][A-Z0-9_]{2,127}$/u.test(String(error?.code || ""))
          ? error.code
          : "COLLECTION_WORKER_CANARY_EXECUTION_FAILED",
        providerAttemptCount: [0, 1].includes(providerAttemptCount) ? providerAttemptCount : 0
      },
      fetchImpl: internalFetchImpl,
      now: clock(),
      path: FAILURE_PATH,
      requestPrivateKey: worker.requestPrivateKey
    }).catch(() => {});
    throw fail(
      String(error?.code || "COLLECTION_WORKER_CANARY_EXECUTION_FAILED"),
      "Worker canary execution failed",
      Number(error?.statusCode || 502),
      { providerAttemptCount }
    );
  }

  const finalized = await postFinalizationWithOneInternalRecovery({
    baseUrl: worker.baseUrl,
    body: {
      jobId: claimed.signedJob.jobId,
      attemptId: claimed.signedJob.attemptId,
      workflowRevision: claimed.workflowRevision,
      signedArtifact: executed.signedArtifact
    },
    fetchImpl: internalFetchImpl,
    now: clock(),
    path: FINALIZE_PATH,
    requestPrivateKey: worker.requestPrivateKey
  });
  return Object.freeze({
    schemaVersion: COLLECTION_WORKER_NAVER_CANARY_SCHEMA_VERSION,
    status: finalized.status,
    code: finalized.code,
    targetServiceId: COLLECTION_WORKER_CANARY_TARGET_SERVICE_ID,
    targetCommit: worker.commit,
    strategy: V2_ENV_WORKER_STRATEGY,
    phase: V2_ENV_WORKER_PHASE,
    strategyVersion: NAVER_LEGACY_CANARY_STRATEGY_VERSION,
    executionIdentityHash: claimed.signedJob.executionIdentityHash,
    runtimeFingerprint,
    providerAttemptCount: finalized.providerAttemptCount,
    executedCallCount: finalized.executedCallCount,
    automaticRetry: false,
    automaticFallback: false,
    currentResultReused: false,
    fallbackResultReused: false,
    organicCount: finalized.organicCount,
    adCount: finalized.adCount,
    observedRankCount: finalized.observedRankCount,
    providerFailureSubtype: finalized.providerFailureSubtype,
    diagnosticId: finalized.diagnosticId,
    startedAt: providerStartedAt,
    completedAt: clock().toISOString(),
    providerState: finalized.providerState,
    retryAt: finalized.retryAt,
    retryAfterSeconds: finalized.retryAfterSeconds,
    jobState: finalized.jobState,
    resultStored: false,
    writeCount: 0,
    artifactDecision: finalized.artifactDecision
  });
}

module.exports = {
  COLLECTION_WORKER_NAVER_CANARY_SCHEMA_VERSION,
  CollectionWorkerNaverCanaryError,
  ENV,
  TARGET_PREVIEW_BASE_URL,
  assertWorkerEnvironment,
  createProviderExecutor,
  postSignedWorkerRequest,
  postFinalizationWithOneInternalRecovery,
  postFailureWithOneInternalRecovery,
  runCollectionWorkerNaverCanary,
  safeFatalResult
};
