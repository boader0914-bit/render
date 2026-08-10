"use strict";

const crypto = require("node:crypto");
const os = require("node:os");
const path = require("node:path");
const {
  COLLECTION_WORKER_JOB_AUDIENCE,
  verifySignedJobEnvelope
} = require("./collection_worker_contract.cjs");
const {
  ALLOWED_PATH_SCOPES,
  COLLECTION_WORKER_AUTH_AUDIENCE,
  buildSignedWorkerRequest,
  sha256Hex
} = require("./collection_worker_auth.cjs");
const {
  buildCollectionArtifactBundle
} = require("./collection_artifact_contract.cjs");
const {
  assertExactV2RuntimeFingerprint,
  observeRuntimeFingerprint
} = require("./collection_worker_runtime.cjs");
const {
  executeV2Top20Collector,
  executeV2Top20MainPlaceRecoveryProbe
} = require("./collection_worker_v2_top20_collector.cjs");
const {
  buildV2Top20FinalArtifactFiles
} = require("./collection_worker_v2_top20_artifact.cjs");
const {
  V2_TOP20_CONTRACT,
  decideV2Top20Persistence,
  validateExecutionState
} = require("./collection_worker_v2_top20_contract.cjs");
const {
  V2_TOP20_RESILIENCE_MAXIMUM_PROVIDER_CALLS,
  providerIdForOperation
} = require("./collection_worker_v2_top20_resilience.cjs");
const {
  COLLECTION_WORKER_V2_TOP20_ARTIFACT_KEY_ID,
  COLLECTION_WORKER_V2_TOP20_CLAIM_PATH,
  COLLECTION_WORKER_V2_TOP20_DISPATCH_KEY_ID,
  COLLECTION_WORKER_V2_TOP20_FAILURE_PATH,
  COLLECTION_WORKER_V2_TOP20_MAIN_PLACE_PROBE_FINALIZE_PATH,
  COLLECTION_WORKER_V2_TOP20_MAIN_PLACE_PROBE_PROFILE,
  COLLECTION_WORKER_V2_TOP20_FINALIZE_PATH,
  COLLECTION_WORKER_V2_TOP20_HEARTBEAT_PATH,
  COLLECTION_WORKER_V2_TOP20_PREFLIGHT_PATH,
  COLLECTION_WORKER_V2_TOP20_RUNTIME_ATTEST_PATH,
  COLLECTION_WORKER_V2_TOP20_INTERNAL_PROTOCOL_VERSION,
  COLLECTION_WORKER_V2_TOP20_PROTOCOL_SCHEMA_VERSION,
  COLLECTION_WORKER_V2_TOP20_REQUEST_KEY_ID,
  COLLECTION_WORKER_V2_TOP20_RESULT_SCHEMA_VERSION,
  COLLECTION_WORKER_V2_TOP20_RUNTIME_ID_PREFIX,
  COLLECTION_WORKER_V2_TOP20_SUMMARY_PATH,
  COLLECTION_WORKER_V2_TOP20_TARGET_SERVICE_ID,
  COLLECTION_WORKER_V2_TOP20_PREVIEW_SERVICE_ID,
  COLLECTION_WORKER_V2_TOP20_WORKER_ID,
  COLLECTION_WORKER_V2_TOP20_WORKER_POOL_ID,
  buildV2Top20ArtifactKeyProof,
  buildV2Top20ExecutionContract,
  computeV2Top20ContractHash,
  decodeEd25519Key,
  normalizeV2Top20PrepareContract,
  stableJson,
  top20ApprovalId
} = require("./collection_worker_v2_top20_protocol.cjs");

const COLLECTION_WORKER_V2_TOP20_WORKER_SCHEMA_VERSION = "collection-worker-v2-top20-worker.v1";
const MAX_INTERNAL_RESPONSE_BYTES = 2 * 1024 * 1024;
const INTERNAL_REQUEST_TIMEOUT_MS = 30_000;
const COMMIT_PATTERN = /^[a-f0-9]{40}$/u;
const SAFE_FAILURE_CODE_PATTERN = /^[A-Z][A-Z0-9_]{2,127}$/u;
const SAFE_SUBTYPE_PATTERN = /^(?:http_403|http_429|challenge_html|unknown_access_block)$/u;
const DIAGNOSTIC_PATTERN = /^crawl-[a-f0-9]{12}$/u;
const MAIN_PLACE_PROBE_CONTRACT_FAILURE_CODES = new Set([
  "NAVER_LEGACY_CANARY_CONTRACT_MISMATCH",
  "V2_TOP20_MAIN_PLACE_PROBE_CONTRACT_INVALID"
]);
const ENV = Object.freeze({
  artifactPrivateKey: "COLLECTION_WORKER_ARTIFACT_PRIVATE_KEY_B64",
  dispatchPublicKey: "COLLECTION_WORKER_DISPATCH_PUBLIC_KEY_B64",
  executionEnabled: "COLLECTION_WORKER_V2_TOP20_EXECUTION_ENABLED",
  externalCalls: "COLLECTOR_EXTERNAL_CALLS_ENABLED",
  previewInternalBaseUrl: "COLLECTION_WORKER_PREVIEW_INTERNAL_BASE_URL",
  previewBaseUrl: "COLLECTION_WORKER_PREVIEW_BASE_URL",
  requestPrivateKey: "COLLECTION_WORKER_REQUEST_PRIVATE_KEY_B64",
  resultWrites: "COLLECTOR_RESULT_WRITE_ENABLED",
  top20Enabled: "COLLECTION_WORKER_V2_TOP20_ENABLED",
  workerMode: "COLLECTOR_WORKER_MODE"
});
const FIXTURE_OVERRIDE_KEYS = Object.freeze([
  "artifactFinalizer",
  "collectorExecutor",
  "internalFetchImpl",
  "now",
  "runtimeFingerprint",
  "tempBase"
]);

class CollectionWorkerV2Top20WorkerError extends Error {
  constructor(code, message, statusCode = 409, meta = {}) {
    super(message);
    this.name = "CollectionWorkerV2Top20WorkerError";
    this.code = code;
    this.statusCode = statusCode;
    this.providerAttemptCount = Number(meta.providerAttemptCount || 0);
    this.executedCallCount = Number(meta.executedCallCount || 0);
    this.providerFailureSubtype = meta.providerFailureSubtype || null;
    this.diagnosticId = meta.diagnosticId || null;
    this.retryable = false;
  }
}

function fail(code, message, statusCode = 409, meta = {}) {
  return new CollectionWorkerV2Top20WorkerError(code, message, statusCode, meta);
}

function shortCommit(value) {
  const commit = String(value || "").trim();
  return COMMIT_PATTERN.test(commit) ? commit.slice(0, 12) : "";
}

function shortSafeHash(value) {
  const hash = String(value || "").trim();
  return /^[a-f0-9]{64}$/u.test(hash) ? hash.slice(0, 12) : "";
}

function maskJobId(value) {
  const text = String(value || "");
  const match = text.match(/^job-top20-([a-f0-9]{24})$/u);
  return match ? `job-top20-${match[1].slice(0, 12)}…` : "";
}

function safeTop20WorkerLog(event, fields = {}) {
  console.warn(`[top20-provenance] ${stableJson({
    timestamp: fields.timestamp || new Date().toISOString(),
    event: String(event || "top20_worker_event"),
    jobId: maskJobId(fields.jobId),
    contractHash: shortSafeHash(fields.contractHash),
    executionIdentityHash: shortSafeHash(fields.executionIdentityHash),
    workerCommit: shortCommit(fields.workerCommit),
    providerOperation: String(fields.providerOperation || ""),
    requestOrdinal: Number.isInteger(fields.requestOrdinal) ? fields.requestOrdinal : null,
    jobState: String(fields.jobState || ""),
    failureCode: String(fields.failureCode || ""),
    parentErrorCode: String(fields.parentErrorCode || ""),
    childFailureCode: String(fields.childFailureCode || ""),
    childStarted: fields.childStarted === true,
    providerCallAuthorized: fields.providerCallAuthorized === true,
    providerCallStarted: fields.providerCallStarted === true,
    executedCallCount: Number.isInteger(fields.executedCallCount) ? fields.executedCallCount : 0,
    pid: process.pid,
    hostname: os.hostname(),
    renderServiceId: String(process.env.RENDER_SERVICE_ID || ""),
    renderServiceName: String(process.env.RENDER_SERVICE_NAME || "")
  })}`);
}

function fixtureModeFor(input) {
  const fixtureMode = input.fixtureMode === true;
  const processIsProduction = process.env.RENDER === "true" || process.env.NODE_ENV === "production";
  const hasOverride = FIXTURE_OVERRIDE_KEYS.some((key) => input[key] !== undefined);
  const hasForeignEnvironment = input.environment !== undefined && input.environment !== process.env;
  if ((fixtureMode && processIsProduction) || (!fixtureMode && (hasOverride || hasForeignEnvironment))) {
    throw fail("COLLECTION_WORKER_V2_TOP20_FIXTURE_BOUNDARY_INVALID", "top20 Worker fixture boundary is invalid", 403);
  }
  return fixtureMode;
}

function resolveWorkerEnvironment(input, fixtureMode) {
  if (fixtureMode) return input.environment;
  if (input.environment !== undefined && input.environment !== process.env) {
    throw fail("COLLECTION_WORKER_V2_TOP20_FIXTURE_BOUNDARY_INVALID", "top20 Worker environment identity is invalid", 403);
  }
  return process.env;
}

function normalizeWorkerAbortSignal(value) {
  if (value === undefined) return undefined;
  if (
    !value
    || typeof value.aborted !== "boolean"
    || typeof value.addEventListener !== "function"
    || typeof value.removeEventListener !== "function"
  ) {
    throw fail("COLLECTION_WORKER_V2_TOP20_SIGNAL_INVALID", "top20 Worker shutdown signal is invalid", 400);
  }
  return value;
}

function responseHeader(response, name) {
  try {
    return String(response?.headers?.get?.(name) || "").slice(0, 120);
  } catch {
    return "";
  }
}

function validatePrivatePreviewBaseUrl(value) {
  let parsed;
  try {
    parsed = new URL(String(value || ""));
  } catch {
    throw fail("COLLECTION_WORKER_PREVIEW_TRANSPORT_UNAVAILABLE", "Preview private transport is not configured", 503);
  }
  if (
    parsed.protocol !== "http:"
    || !parsed.hostname
    || parsed.hostname.endsWith(".onrender.com")
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash
    || parsed.pathname !== "/"
  ) {
    throw fail("COLLECTION_WORKER_PREVIEW_TRANSPORT_UNAVAILABLE", "Preview private transport is invalid", 503);
  }
  return parsed.toString().replace(/\/$/u, "");
}

function logInternalTransportFailure(response, byteLength, expected = {}) {
  console.warn(`[collection-worker-preview-transport-failure] ${stableJson({
    event: "collection_worker_preview_transport_failure",
    statusCode: Number(response?.status || 0) || null,
    contentType: responseHeader(response, "content-type"),
    responseLength: Number.isInteger(byteLength) ? byteLength : null,
    expectedCommitShort: shortCommit(expected.commit),
    observedCommitShort: shortCommit(responseHeader(response, "x-lodging-datalab-commit")) || null,
    protocolMatched: responseHeader(response, "x-lodging-datalab-protocol") === expected.protocol,
    bodyLogged: false
  })}`);
}

function assertWorkerEnvironment(environment) {
  const env = environment || {};
  const commit = String(env.RENDER_GIT_COMMIT || "").trim();
  const baseUrl = env.RENDER === "true"
    ? validatePrivatePreviewBaseUrl(env[ENV.previewInternalBaseUrl])
    : String(env[ENV.previewInternalBaseUrl] || env[ENV.previewBaseUrl] || "").replace(/\/+$/u, "");
  if (
    env.RENDER !== "true"
    || env.RENDER_SERVICE_ID !== COLLECTION_WORKER_V2_TOP20_TARGET_SERVICE_ID
    || !COMMIT_PATTERN.test(commit)
    || env[ENV.workerMode] !== "v2_top20_once"
    || env[ENV.executionEnabled] !== "true"
    || env[ENV.externalCalls] !== "true"
    || env[ENV.resultWrites] !== "true"
    || env[ENV.top20Enabled] !== "true"
    || !baseUrl
  ) {
    throw fail("COLLECTION_WORKER_V2_TOP20_RUNTIME_INVALID", "top20 Worker runtime is not explicitly approved", 403);
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
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw fail("COLLECTION_WORKER_V2_TOP20_CLOCK_INVALID", "top20 Worker clock is invalid", 500);
  }
  return date;
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw fail("COLLECTION_WORKER_V2_TOP20_PAYLOAD_INVALID", `${label} is invalid`, 400);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw fail("COLLECTION_WORKER_V2_TOP20_PAYLOAD_INVALID", `${label} fields are invalid`, 400);
  }
}

function verifyTop20ExecutionPayload(value, verifiedJob) {
  exactKeys(value, [
    "schemaVersion",
    "jobId",
    "attemptId",
    "contractHash",
    "executionIdentityHash",
    "top20ContractHash",
    "executionRequestHash",
    "contract",
    "top20Contract",
    "providerSession",
    "detailProviderSession",
    "executionProfile"
  ], "top20 execution payload");
  exactKeys(value.providerSession, [
    "maximumProviderCalls",
    "providerAttemptCount",
    "concurrency",
    "automaticRetry",
    "automaticFallback",
    "circuitStateAtReservation",
    "serviceGlobalLockHeld"
  ], "top20 provider session");
  exactKeys(value.detailProviderSession, ["state", "retryAt", "liveCallsAllowed"], "top20 detail provider session");
  const normalized = normalizeV2Top20PrepareContract(value.contract);
  const expectedTop20Contract = buildV2Top20ExecutionContract(value.contract);
  const expectedTop20Hash = computeV2Top20ContractHash(expectedTop20Contract);
  if (
    value.schemaVersion !== COLLECTION_WORKER_V2_TOP20_PROTOCOL_SCHEMA_VERSION
    || value.jobId !== verifiedJob.jobId
    || value.attemptId !== verifiedJob.attemptId
    || value.contractHash !== verifiedJob.contractHash
    || value.executionIdentityHash !== verifiedJob.executionIdentityHash
    || value.top20ContractHash !== expectedTop20Hash
    || !/^[a-f0-9]{64}$/u.test(String(value.executionRequestHash || ""))
    || stableJson(value.top20Contract) !== stableJson(expectedTop20Contract)
    || verifiedJob.approvalId !== top20ApprovalId(expectedTop20Hash, value.executionRequestHash)
    || verifiedJob.contract.keywordHash !== normalized.keywordHash
    || verifiedJob.contract.checkIn !== normalized.checkIn
    || verifiedJob.contract.checkOut !== normalized.checkOut
    || value.providerSession.maximumProviderCalls !== V2_TOP20_RESILIENCE_MAXIMUM_PROVIDER_CALLS
    || value.providerSession.providerAttemptCount !== 1
    || value.providerSession.concurrency !== 1
    || value.providerSession.automaticRetry !== false
    || value.providerSession.automaticFallback !== false
    || !["closed", "open"].includes(value.providerSession.circuitStateAtReservation)
    || value.providerSession.serviceGlobalLockHeld !== true
    || !["closed", "open", "probe_allowed"].includes(value.detailProviderSession.state)
    || typeof value.detailProviderSession.liveCallsAllowed !== "boolean"
    || value.detailProviderSession.liveCallsAllowed !== (value.detailProviderSession.state === "closed")
    || !["top20_inventory_revenue", COLLECTION_WORKER_V2_TOP20_MAIN_PLACE_PROBE_PROFILE].includes(value.executionProfile)
    || (value.executionProfile === COLLECTION_WORKER_V2_TOP20_MAIN_PLACE_PROBE_PROFILE && value.providerSession.circuitStateAtReservation !== "open")
    || (value.executionProfile === "top20_inventory_revenue" && value.providerSession.circuitStateAtReservation !== "closed")
  ) {
    throw fail("COLLECTION_WORKER_V2_TOP20_PAYLOAD_INVALID", "top20 execution payload is not authorized", 409);
  }
  return Object.freeze({
    contract: Object.freeze({ ...value.contract }),
    top20Contract: expectedTop20Contract,
    top20ContractHash: expectedTop20Hash,
    executionRequestHash: value.executionRequestHash,
    detailProviderSession: Object.freeze({ ...value.detailProviderSession }),
    executionProfile: value.executionProfile
  });
}

async function readBoundedJsonResponse(response, expectedGeneration = null) {
  const statusCode = Number(response?.status || 0);
  const contentType = responseHeader(response, "content-type");
  const byteLength = Number(response?.headers?.get?.("content-length"));
  const generationMatches = !expectedGeneration || (
    responseHeader(response, "x-lodging-datalab-service-id") === COLLECTION_WORKER_V2_TOP20_PREVIEW_SERVICE_ID
    && responseHeader(response, "x-lodging-datalab-commit") === expectedGeneration.commit
    && responseHeader(response, "x-lodging-datalab-protocol") === expectedGeneration.protocol
  );
  if ([502, 503, 504].includes(statusCode) || !/^application\/json(?:;|$)/iu.test(contentType)) {
    logInternalTransportFailure(response, Number.isFinite(byteLength) ? byteLength : null, expectedGeneration || {});
    throw fail("COLLECTION_WORKER_PREVIEW_RESPONSE_NOT_JSON", "Preview private transport did not return JSON", 502);
  }
  if (!generationMatches) {
    logInternalTransportFailure(response, Number.isFinite(byteLength) ? byteLength : null, expectedGeneration || {});
    throw fail("COLLECTION_WORKER_PREVIEW_GENERATION_MISMATCH", "Preview response generation does not match", 409);
  }
  const contentLength = Number(response?.headers?.get?.("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_INTERNAL_RESPONSE_BYTES) {
    await response?.body?.cancel?.().catch(() => {});
    throw fail("COLLECTION_WORKER_V2_TOP20_INTERNAL_RESPONSE_TOO_LARGE", "Preview response is too large", 502);
  }
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > MAX_INTERNAL_RESPONSE_BYTES) {
    throw fail("COLLECTION_WORKER_V2_TOP20_INTERNAL_RESPONSE_TOO_LARGE", "Preview response is too large", 502);
  }
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    logInternalTransportFailure(response, Buffer.byteLength(text, "utf8"), expectedGeneration || {});
    throw fail("COLLECTION_WORKER_V2_TOP20_INTERNAL_RESPONSE_INVALID", "Preview response is invalid", 502);
  }
  if (!response.ok) {
    throw fail(
      String(payload?.code || "COLLECTION_WORKER_V2_TOP20_INTERNAL_REQUEST_FAILED"),
      "Preview rejected the top20 Worker request",
      Number(response.status || 502)
    );
  }
  return payload;
}

async function postSignedWorkerRequest(input) {
  const issuedAt = safeInstant(typeof input.now === "function" ? input.now() : input.now);
  const bodyText = stableJson(input.body);
  const signedRequest = buildSignedWorkerRequest({
    audience: COLLECTION_WORKER_AUTH_AUDIENCE,
    workerId: COLLECTION_WORKER_V2_TOP20_WORKER_ID,
    workerPoolId: COLLECTION_WORKER_V2_TOP20_WORKER_POOL_ID,
    keyId: COLLECTION_WORKER_V2_TOP20_REQUEST_KEY_ID,
    method: "POST",
    path: input.path,
    scope: ALLOWED_PATH_SCOPES[input.path],
    issuedAt,
    nonce: crypto.randomBytes(18).toString("base64url"),
    bodySha256: sha256Hex(bodyText)
  }, { privateKey: input.requestPrivateKey });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), INTERNAL_REQUEST_TIMEOUT_MS);
  timer.unref?.();
  try {
    const response = await input.fetchImpl(new URL(input.path, `${input.baseUrl}/`), {
      method: "POST",
      headers: { "content-type": "application/json" },
      redirect: "error",
      signal: controller.signal,
      body: JSON.stringify({ signedRequest, body: input.body })
    });
    const expectedGeneration = input.expectedGeneration || (process.env.RENDER === "true"
      ? {
          commit: String(process.env.RENDER_GIT_COMMIT || "").trim(),
          protocol: COLLECTION_WORKER_V2_TOP20_INTERNAL_PROTOCOL_VERSION
        }
      : null);
    return await readBoundedJsonResponse(response, expectedGeneration);
  } catch (error) {
    if (error instanceof CollectionWorkerV2Top20WorkerError) throw error;
    throw fail(
      controller.signal.aborted
        ? "COLLECTION_WORKER_V2_TOP20_INTERNAL_REQUEST_TIMEOUT"
        : "COLLECTION_WORKER_V2_TOP20_INTERNAL_REQUEST_FAILED",
      "Preview top20 Worker request failed",
      controller.signal.aborted ? 504 : 502
    );
  } finally {
    clearTimeout(timer);
  }
}

function isReceiptRetryable(error) {
  return Number(error?.statusCode || 0) >= 500 || [
    "COLLECTION_WORKER_V2_TOP20_INTERNAL_REQUEST_FAILED",
    "COLLECTION_WORKER_V2_TOP20_INTERNAL_REQUEST_TIMEOUT"
  ].includes(String(error?.code || ""));
}

async function postReceiptWithOneInternalRecovery(input) {
  try {
    return await postSignedWorkerRequest(input);
  } catch (firstError) {
    if (!isReceiptRetryable(firstError)) throw firstError;
    try {
      return await postSignedWorkerRequest(input);
    } catch {
      throw fail(
        "COLLECTION_WORKER_V2_TOP20_RECEIPT_INDETERMINATE",
        "Preview did not durably acknowledge the top20 receipt",
        502,
        input.failureMeta || {}
      );
    }
  }
}

function safeFailureMeta(error, observedProviderCallCount = 0) {
  const reportedCallCount = Number.isInteger(error?.executedCallCount)
    && error.executedCallCount >= 0
    && error.executedCallCount <= V2_TOP20_CONTRACT.maximumProviderCalls
    ? error.executedCallCount
    : 0;
  const observed = Number.isInteger(observedProviderCallCount)
    && observedProviderCallCount >= 0
    && observedProviderCallCount <= V2_TOP20_CONTRACT.maximumProviderCalls
    ? observedProviderCallCount
    : 0;
  const executedCallCount = Math.max(reportedCallCount, observed);
  const providerFailureSubtype = SAFE_SUBTYPE_PATTERN.test(String(error?.providerFailureSubtype || ""))
    ? error.providerFailureSubtype
    : null;
  const diagnosticId = DIAGNOSTIC_PATTERN.test(String(error?.diagnosticId || ""))
    ? error.diagnosticId
    : null;
  return Object.freeze({
    code: SAFE_FAILURE_CODE_PATTERN.test(String(error?.code || ""))
      ? error.code
      : "COLLECTION_WORKER_V2_TOP20_EXECUTION_FAILED",
    providerAttemptCount: executedCallCount > 0 ? 1 : 0,
    executedCallCount,
    providerFailureSubtype,
    diagnosticId
  });
}

function validateFinalArtifactInput(value, expected) {
  exactKeys(value, ["files", "summary", "executionState"], "top20 final artifact input");
  if (!Array.isArray(value.files) || !value.files.length) {
    throw fail("COLLECTION_WORKER_V2_TOP20_ARTIFACT_INVALID", "top20 final artifact files are invalid", 500);
  }
  const summaryFiles = value.files.filter((file) => file?.path === COLLECTION_WORKER_V2_TOP20_SUMMARY_PATH);
  if (summaryFiles.length !== 1) {
    throw fail("COLLECTION_WORKER_V2_TOP20_ARTIFACT_INVALID", "top20 final summary is invalid", 500);
  }
  const resilient = value.executionState === null;
  const state = resilient ? null : validateExecutionState(value.executionState);
  const decision = resilient ? { saveRun: ["complete", "partial", "rank_only"].includes(value.summary.collectionStatus) } : decideV2Top20Persistence(state);
  if (
    value.summary.schemaVersion !== COLLECTION_WORKER_V2_TOP20_RESULT_SCHEMA_VERSION
    || value.summary.status !== "ready"
    || value.summary.top20ContractHash !== expected.top20ContractHash
    || value.summary.contractHash !== expected.contractHash
    || value.summary.executionIdentityHash !== expected.executionIdentityHash
    || value.summary.providerWorkflowRevision !== expected.providerWorkflowRevision
    || !Number.isInteger(value.summary.executedCallCount)
    || value.summary.executedCallCount < 1
    || value.summary.executedCallCount > V2_TOP20_RESILIENCE_MAXIMUM_PROVIDER_CALLS
    || value.summary.automaticRetry !== false
    || value.summary.automaticFallback !== false
    || !resilient && stableJson(value.summary.executionState) !== stableJson(state)
    || decision.saveRun !== true
  ) {
    throw fail("COLLECTION_WORKER_V2_TOP20_ARTIFACT_INVALID", "top20 final artifact is not persistable", 409);
  }
  return Object.freeze({ files: value.files, summary: value.summary, executionState: state });
}

function safeFatalResult(error) {
  const failure = safeFailureMeta(error, 0);
  return Object.freeze({
    schemaVersion: COLLECTION_WORKER_V2_TOP20_WORKER_SCHEMA_VERSION,
    status: "failed",
    code: failure.code,
    targetServiceId: COLLECTION_WORKER_V2_TOP20_TARGET_SERVICE_ID,
    providerAttemptCount: failure.providerAttemptCount,
    executedCallCount: failure.executedCallCount,
    automaticRetry: false,
    automaticFallback: false,
    resultStored: false,
    writeCount: 0
  });
}

async function runCollectionWorkerV2Top20(input = {}) {
  const fixtureMode = fixtureModeFor(input);
  const signal = normalizeWorkerAbortSignal(input.signal);
  if (signal?.aborted) {
    throw fail("COLLECTION_WORKER_V2_TOP20_ABORTED", "top20 Worker was stopped before claiming a job", 499);
  }
  const clock = () => safeInstant(fixtureMode ? input.now : new Date());
  const environment = resolveWorkerEnvironment(input, fixtureMode);
  const runtimeFingerprint = assertExactV2RuntimeFingerprint(
    fixtureMode ? input.runtimeFingerprint : observeRuntimeFingerprint()
  );
  const worker = assertWorkerEnvironment(environment);
  const internalFetchImpl = fixtureMode ? input.internalFetchImpl : globalThis.fetch;
  if (typeof internalFetchImpl !== "function") {
    throw fail("COLLECTION_WORKER_V2_TOP20_INTERNAL_TRANSPORT_INVALID", "Preview transport is unavailable", 500);
  }

  const generation = Object.freeze({
    commit: worker.commit,
    protocol: COLLECTION_WORKER_V2_TOP20_INTERNAL_PROTOCOL_VERSION
  });
  if (!fixtureMode || input.requireAttestation === true) {
    const attestation = await postSignedWorkerRequest({
      baseUrl: worker.baseUrl,
      body: {
        workerId: COLLECTION_WORKER_V2_TOP20_WORKER_ID,
        workerPoolId: COLLECTION_WORKER_V2_TOP20_WORKER_POOL_ID,
        workerCommit: worker.commit,
        targetServiceId: COLLECTION_WORKER_V2_TOP20_PREVIEW_SERVICE_ID,
        targetCommit: worker.commit,
        runtimeFingerprintHash: sha256Hex(stableJson(runtimeFingerprint)),
        protocolVersion: COLLECTION_WORKER_V2_TOP20_INTERNAL_PROTOCOL_VERSION
      },
      expectedGeneration: generation,
      fetchImpl: internalFetchImpl,
      now: clock,
      path: COLLECTION_WORKER_V2_TOP20_RUNTIME_ATTEST_PATH,
      requestPrivateKey: worker.requestPrivateKey
    });
    if (
      attestation?.status !== "ready"
      || attestation.commitMatched !== true
      || attestation.previewCommit !== worker.commit
      || attestation.workerCommit !== worker.commit
      || attestation.protocolVersion !== COLLECTION_WORKER_V2_TOP20_INTERNAL_PROTOCOL_VERSION
      || attestation.draining === true
    ) {
      throw fail("COLLECTION_WORKER_PREVIEW_GENERATION_MISMATCH", "Preview runtime attestation is not ready", 409);
    }
    if (input.attestationState && typeof input.attestationState === "object") {
      input.attestationState.consecutiveMatches = Number(input.attestationState.consecutiveMatches || 0) + 1;
      input.attestationState.lastAttestedAt = attestation.attestedAt;
      if (input.attestationState.consecutiveMatches < 2) {
        throw fail("COLLECTION_WORKER_PREVIEW_ATTESTATION_PENDING", "Preview runtime attestation needs a second confirmation", 503);
      }
    }
  }

  const claim = await postSignedWorkerRequest({
    baseUrl: worker.baseUrl,
    body: {
      workerId: COLLECTION_WORKER_V2_TOP20_WORKER_ID,
      workerPoolId: COLLECTION_WORKER_V2_TOP20_WORKER_POOL_ID,
      workerCommit: worker.commit
    },
    expectedGeneration: !fixtureMode ? generation : null,
    fetchImpl: internalFetchImpl,
    now: clock,
    path: COLLECTION_WORKER_V2_TOP20_CLAIM_PATH,
    requestPrivateKey: worker.requestPrivateKey
  });
  if (claim?.status !== "claimed" || !claim.job) {
    throw fail("COLLECTION_WORKER_V2_TOP20_NO_JOB", "No approved top20 job is available", 409);
  }
  const claimed = claim.job;
  if (
    claimed.targetWorkerCommit !== worker.commit
    || !Number.isInteger(claimed.workflowRevision)
    || claimed.workflowRevision < 1
    || !Number.isInteger(claimed.providerWorkflowRevision)
    || claimed.providerWorkflowRevision < 0
    || Date.parse(String(claimed.leaseExpiresAt || "")) <= clock().getTime()
  ) {
    throw fail("COLLECTION_WORKER_V2_TOP20_CLAIM_INVALID", "top20 claim is invalid or expired", 409);
  }

  const runtimeId = `${COLLECTION_WORKER_V2_TOP20_RUNTIME_ID_PREFIX}${worker.commit.slice(0, 12)}`;
  const verifiedJob = verifySignedJobEnvelope(claimed.signedJob, {
    publicKey: worker.dispatchPublicKey,
    expectedSignerKeyId: COLLECTION_WORKER_V2_TOP20_DISPATCH_KEY_ID,
    expectedAudience: COLLECTION_WORKER_JOB_AUDIENCE,
    expectedWorkerId: COLLECTION_WORKER_V2_TOP20_WORKER_ID,
    expectedWorkerPoolId: COLLECTION_WORKER_V2_TOP20_WORKER_POOL_ID,
    now: clock(),
    clockSkewSeconds: 30,
    requireExecutable: true
  });
  const execution = verifyTop20ExecutionPayload(claimed.executionPayload, verifiedJob);
  let jobWorkflowRevision = claimed.workflowRevision;
  let providerWorkflowRevision = claimed.providerWorkflowRevision;
  let providerCallCount = 0;

  async function sendFailure(error) {
    const failure = safeFailureMeta(error, providerCallCount);
    const body = {
      jobId: verifiedJob.jobId,
      attemptId: verifiedJob.attemptId,
      workflowRevision: jobWorkflowRevision,
      providerWorkflowRevision,
      providerAttemptCount: failure.providerAttemptCount,
      executedCallCount: failure.executedCallCount,
      code: failure.code,
      providerFailureSubtype: failure.providerFailureSubtype,
      diagnosticId: failure.diagnosticId
    };
    return postReceiptWithOneInternalRecovery({
      baseUrl: worker.baseUrl,
      body,
      failureMeta: failure,
      fetchImpl: internalFetchImpl,
      now: clock,
      path: COLLECTION_WORKER_V2_TOP20_FAILURE_PATH,
      requestPrivateKey: worker.requestPrivateKey
    });
  }

  try {
    await postSignedWorkerRequest({
      baseUrl: worker.baseUrl,
      body: {
        jobId: verifiedJob.jobId,
        attemptId: verifiedJob.attemptId,
        workflowRevision: jobWorkflowRevision,
        workerCommit: worker.commit,
        runtimeId,
        artifactKeyProof: buildV2Top20ArtifactKeyProof({
          jobId: verifiedJob.jobId,
          attemptId: verifiedJob.attemptId,
          workflowRevision: jobWorkflowRevision,
          workerId: COLLECTION_WORKER_V2_TOP20_WORKER_ID,
          workerPoolId: COLLECTION_WORKER_V2_TOP20_WORKER_POOL_ID,
          workerCommit: worker.commit,
          runtimeId,
          contractHash: verifiedJob.contractHash,
          executionIdentityHash: verifiedJob.executionIdentityHash,
          top20ContractHash: execution.top20ContractHash
        }, worker.artifactPrivateKey)
      },
      fetchImpl: internalFetchImpl,
      now: clock,
      path: COLLECTION_WORKER_V2_TOP20_PREFLIGHT_PATH,
      requestPrivateKey: worker.requestPrivateKey
    });
  } catch (error) {
    await sendFailure(error).catch(() => {});
    throw error;
  }

  let heartbeatFlight = null;
  const heartbeat = async () => {
    if (heartbeatFlight) return heartbeatFlight;
    const task = (async () => {
      const previousJobRevision = jobWorkflowRevision;
      const previousProviderRevision = providerWorkflowRevision;
      const response = await postSignedWorkerRequest({
        baseUrl: worker.baseUrl,
        body: {
          jobId: verifiedJob.jobId,
          attemptId: verifiedJob.attemptId,
          workflowRevision: previousJobRevision,
          providerWorkflowRevision: previousProviderRevision,
          workerCommit: worker.commit,
          runtimeId
        },
        fetchImpl: internalFetchImpl,
        now: clock,
        path: COLLECTION_WORKER_V2_TOP20_HEARTBEAT_PATH,
        requestPrivateKey: worker.requestPrivateKey
      });
      if (
        response?.status !== "heartbeat"
        || !Number.isInteger(response.workflowRevision)
        || response.workflowRevision <= previousJobRevision
        || !Number.isInteger(response.providerWorkflowRevision)
        || response.providerWorkflowRevision <= previousProviderRevision
      ) {
        throw fail("COLLECTION_WORKER_V2_TOP20_HEARTBEAT_INVALID", "top20 heartbeat response is invalid", 409);
      }
      jobWorkflowRevision = response.workflowRevision;
      providerWorkflowRevision = response.providerWorkflowRevision;
      return response;
    })();
    heartbeatFlight = task;
    try {
      return await task;
    } finally {
      if (heartbeatFlight === task) heartbeatFlight = null;
    }
  };

  if (execution.executionProfile === COLLECTION_WORKER_V2_TOP20_MAIN_PLACE_PROBE_PROFILE) {
    async function finalizeProbe(body) {
      return postSignedWorkerRequest({
        baseUrl: worker.baseUrl,
        body,
        fetchImpl: internalFetchImpl,
        now: clock,
        path: COLLECTION_WORKER_V2_TOP20_MAIN_PLACE_PROBE_FINALIZE_PATH,
        requestPrivateKey: worker.requestPrivateKey
      });
    }
    try {
      const probe = await executeV2Top20MainPlaceRecoveryProbe({
        baseEnvironment: environment,
        contract: execution.contract,
        heartbeat,
        async onProviderCall(metadata) {
          if (metadata?.providerId !== providerIdForOperation("main_place") || metadata?.operation !== "main_place" || Number(metadata?.requestOrdinal) !== 1 || providerCallCount !== 0) {
            throw fail("COLLECTION_WORKER_V2_TOP20_PROVIDER_CALL_SEQUENCE_INVALID", "main-place recovery probe call sequence is invalid", 409);
          }
          await heartbeat();
          providerCallCount = 1;
        },
        signal,
        tempBase: fixtureMode ? path.resolve(String(input.tempBase || os.tmpdir())) : os.tmpdir()
      });
      if (probe.organicCount !== 50 || probe.observedRankCount !== 50 || probe.providerSubtype !== "apollo_success") {
        throw fail(
          "COLLECTION_WORKER_MAIN_PLACE_PROBE_RESULT_INCOMPLETE",
          "main-place recovery probe did not satisfy the full-rank success contract",
          502,
          { providerAttemptCount: 1, executedCallCount: 1 }
        );
      }
      const finalized = await finalizeProbe({
        jobId: verifiedJob.jobId,
        attemptId: verifiedJob.attemptId,
        workflowRevision: jobWorkflowRevision,
        providerWorkflowRevision,
        providerAttemptCount: 1,
        executedCallCount: 1,
        organicCount: probe.organicCount,
        observedRankCount: probe.observedRankCount,
        providerSubtype: probe.providerSubtype,
        diagnosticId: null,
        failureCode: null,
        outcome: "ready"
      });
      if (finalized?.jobState !== "validated_no_store" || finalized?.resultStored !== false || finalized?.writeCount !== 0) {
        throw fail("COLLECTION_WORKER_MAIN_PLACE_PROBE_FINALIZE_INVALID", "main-place recovery probe finalization is invalid", 409, { providerAttemptCount: 1, executedCallCount: 1 });
      }
      return Object.freeze({
        schemaVersion: COLLECTION_WORKER_V2_TOP20_WORKER_SCHEMA_VERSION,
        status: "validated_no_store",
        code: null,
        targetServiceId: COLLECTION_WORKER_V2_TOP20_TARGET_SERVICE_ID,
        targetCommit: worker.commit,
        executionIdentityHash: verifiedJob.executionIdentityHash,
        runtimeFingerprint,
        providerAttemptCount: 1,
        executedCallCount: 1,
        automaticRetry: false,
        automaticFallback: false,
        jobState: "validated_no_store",
        resultStored: false,
        writeCount: 0
      });
    } catch (error) {
      const failure = safeFailureMeta(error, providerCallCount);
      const blocked = failure.executedCallCount === 1 && SAFE_SUBTYPE_PATTERN.test(String(failure.providerFailureSubtype || ""));
      const childFailureCode = String(error?.probeDiagnostics?.childFailureCode || "");
      const failureCode = MAIN_PLACE_PROBE_CONTRACT_FAILURE_CODES.has(String(error?.code || ""))
        || MAIN_PLACE_PROBE_CONTRACT_FAILURE_CODES.has(childFailureCode)
        ? "COLLECTION_WORKER_MAIN_PLACE_PROBE_CONTRACT_INVALID"
        : null;
      safeTop20WorkerLog("main_place_recovery_probe_failed", {
        jobId: verifiedJob.jobId,
        contractHash: verifiedJob.contractHash,
        executionIdentityHash: verifiedJob.executionIdentityHash,
        workerCommit: worker.commit,
        jobState: "indeterminate",
        failureCode: failureCode || failure.code,
        parentErrorCode: failureCode || failure.code,
        childFailureCode,
        childStarted: error?.probeDiagnostics?.childStarted === true,
        providerCallAuthorized: error?.probeDiagnostics?.providerCallAuthorized === true,
        providerCallStarted: error?.probeDiagnostics?.providerCallStarted === true,
        executedCallCount: failure.executedCallCount
      });
      await finalizeProbe({
        jobId: verifiedJob.jobId,
        attemptId: verifiedJob.attemptId,
        workflowRevision: jobWorkflowRevision,
        providerWorkflowRevision,
        providerAttemptCount: failure.providerAttemptCount,
        executedCallCount: failure.executedCallCount,
        organicCount: 0,
        observedRankCount: 0,
        providerSubtype: blocked ? failure.providerFailureSubtype : null,
        diagnosticId: blocked ? failure.diagnosticId : null,
        failureCode,
        outcome: blocked ? "blocked" : "indeterminate"
      }).catch(() => {});
      throw fail(
        blocked ? "NAVER_ACCESS_BLOCKED" : (failureCode || failure.code),
        "main-place recovery probe failed",
        Number(error?.statusCode || 502),
        failure
      );
    }
  }

  const collectorExecutor = fixtureMode && typeof input.collectorExecutor === "function"
    ? input.collectorExecutor
    : executeV2Top20Collector;
  const artifactFinalizer = fixtureMode && typeof input.artifactFinalizer === "function"
    ? input.artifactFinalizer
    : buildV2Top20FinalArtifactFiles;
  if (typeof artifactFinalizer !== "function") {
    const error = fail(
      "COLLECTION_WORKER_V2_TOP20_ARTIFACT_FINALIZER_REQUIRED",
      "buildV2Top20FinalArtifactFiles is not available",
      500
    );
    await sendFailure(error).catch(() => {});
    throw error;
  }

  let collected;
  let finalArtifactInput;
  try {
    collected = await collectorExecutor({
      baseEnvironment: environment,
      contract: execution.contract,
      contractHash: verifiedJob.contractHash,
      executionIdentityHash: verifiedJob.executionIdentityHash,
      heartbeat,
      detailLiveCallsAllowed: execution.detailProviderSession.liveCallsAllowed,
      async onProviderCall(metadata = {}) {
        const requestOrdinal = Number(metadata.requestOrdinal);
        if (
          ![providerIdForOperation(String(metadata.operation || "")), "naver_place_search"].includes(metadata.providerId)
          || !["main_place", "booking_business", "booking_business_graphql", "booking_business_place_page", "booking_items", "daily_schedule"].includes(String(metadata.operation || ""))
          || requestOrdinal !== providerCallCount + 1
          || requestOrdinal > V2_TOP20_RESILIENCE_MAXIMUM_PROVIDER_CALLS
        ) {
          throw fail(
            "COLLECTION_WORKER_V2_TOP20_PROVIDER_CALL_SEQUENCE_INVALID",
            "top20 provider call heartbeat sequence is invalid",
            409,
            { providerAttemptCount: providerCallCount > 0 ? 1 : 0, executedCallCount: providerCallCount }
          );
        }
        safeTop20WorkerLog("top20_provider_call_authorized", {
          jobId: verifiedJob.jobId,
          contractHash: verifiedJob.contractHash,
          executionIdentityHash: verifiedJob.executionIdentityHash,
          workerCommit: worker.commit,
          providerOperation: String(metadata.operation || ""),
          requestOrdinal,
          jobState: "collecting"
        });
        await heartbeat();
        safeTop20WorkerLog("top20_provider_call_started", {
          jobId: verifiedJob.jobId,
          contractHash: verifiedJob.contractHash,
          executionIdentityHash: verifiedJob.executionIdentityHash,
          workerCommit: worker.commit,
          providerOperation: String(metadata.operation || ""),
          requestOrdinal,
          jobState: "collecting"
        });
        providerCallCount = requestOrdinal;
        return Object.freeze({ requestOrdinal, providerWorkflowRevision, jobWorkflowRevision });
      },
      signal,
      tempBase: fixtureMode ? path.resolve(String(input.tempBase || os.tmpdir())) : os.tmpdir()
    });
    if (collected.providerCallCount !== providerCallCount) {
      throw fail(
        "COLLECTION_WORKER_V2_TOP20_EXECUTED_CALL_COUNT_MISMATCH",
        "top20 collector and Worker provider call counts do not match",
        409,
        { providerAttemptCount: providerCallCount > 0 ? 1 : 0, executedCallCount: providerCallCount }
      );
    }
    finalArtifactInput = validateFinalArtifactInput(await artifactFinalizer({
      files: collected.files,
      top20ContractHash: execution.top20ContractHash,
      contractHash: verifiedJob.contractHash,
      executionIdentityHash: verifiedJob.executionIdentityHash,
      providerWorkflowRevision,
      now: clock()
    }), {
      top20ContractHash: execution.top20ContractHash,
      contractHash: verifiedJob.contractHash,
      executionIdentityHash: verifiedJob.executionIdentityHash,
      providerWorkflowRevision
    });
  } catch (error) {
    await sendFailure(error).catch(() => {});
    throw fail(
      String(error?.code || "COLLECTION_WORKER_V2_TOP20_EXECUTION_FAILED"),
      "top20 Worker collection failed",
      Number(error?.statusCode || 502),
      safeFailureMeta(error, providerCallCount)
    );
  }

  const signedArtifact = buildCollectionArtifactBundle({
    identity: {
      jobId: verifiedJob.jobId,
      attemptId: verifiedJob.attemptId,
      workerId: COLLECTION_WORKER_V2_TOP20_WORKER_ID,
      workerPoolId: COLLECTION_WORKER_V2_TOP20_WORKER_POOL_ID,
      runtimeId,
      contractHash: verifiedJob.contractHash,
      executionIdentityHash: verifiedJob.executionIdentityHash
    },
    files: finalArtifactInput.files
  }, {
    privateKey: worker.artifactPrivateKey,
    keyId: COLLECTION_WORKER_V2_TOP20_ARTIFACT_KEY_ID
  });

  const finalized = await postReceiptWithOneInternalRecovery({
    baseUrl: worker.baseUrl,
    body: {
      jobId: verifiedJob.jobId,
      attemptId: verifiedJob.attemptId,
      workflowRevision: jobWorkflowRevision,
      signedArtifact
    },
    failureMeta: {
      providerAttemptCount: 1,
      executedCallCount: finalArtifactInput.summary.executedCallCount
    },
    fetchImpl: internalFetchImpl,
    now: clock,
    path: COLLECTION_WORKER_V2_TOP20_FINALIZE_PATH,
    requestPrivateKey: worker.requestPrivateKey
  });
  if (
    finalized?.status !== "ready"
    || finalized.jobState !== "committed"
    || finalized.resultStored !== true
    || finalized.artifactHash !== signedArtifact.bundle.bundleHash
  ) {
    throw fail("COLLECTION_WORKER_V2_TOP20_FINALIZE_INVALID", "top20 finalization response is invalid", 409, {
      providerAttemptCount: 1,
      executedCallCount: finalArtifactInput.summary.executedCallCount
    });
  }
  return Object.freeze({
    schemaVersion: COLLECTION_WORKER_V2_TOP20_WORKER_SCHEMA_VERSION,
    status: "ready",
    code: null,
    targetServiceId: COLLECTION_WORKER_V2_TOP20_TARGET_SERVICE_ID,
    targetCommit: worker.commit,
    executionIdentityHash: verifiedJob.executionIdentityHash,
    runtimeFingerprint,
    providerAttemptCount: finalized.providerAttemptCount,
    executedCallCount: finalized.executedCallCount,
    automaticRetry: false,
    automaticFallback: false,
    jobState: finalized.jobState,
    transactionReceiptId: finalized.transactionReceiptId,
    resultStored: true,
    writeCount: finalized.writeCount,
    replayed: finalized.replayed === true
  });
}

module.exports = {
  COLLECTION_WORKER_V2_TOP20_WORKER_SCHEMA_VERSION,
  CollectionWorkerV2Top20WorkerError,
  ENV,
  assertWorkerEnvironment,
  postReceiptWithOneInternalRecovery,
  postSignedWorkerRequest,
  resolveWorkerEnvironment,
  runCollectionWorkerV2Top20,
  safeFatalResult,
  validatePrivatePreviewBaseUrl,
  verifyTop20ExecutionPayload
};
