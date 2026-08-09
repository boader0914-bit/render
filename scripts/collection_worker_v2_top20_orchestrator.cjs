"use strict";

const crypto = require("node:crypto");
const os = require("node:os");
const {
  COLLECTION_WORKER_JOB_AUDIENCE,
  buildSignedJobEnvelope
} = require("./collection_worker_contract.cjs");
const {
  COLLECTION_WORKER_AUTH_AUDIENCE,
  createWorkerNonceRegistry,
  verifySignedWorkerRequest
} = require("./collection_worker_auth.cjs");
const {
  verifyCollectionArtifactBundle
} = require("./collection_artifact_contract.cjs");
const {
  PROVIDER_ATTEMPT_LEASE_SECONDS,
  providerAvailability
} = require("./naver_provider_resilience.cjs");
const {
  V2_TOP20_CONTRACT,
  V2_TOP20_PROFILE,
  V2_TOP20_SCHEMA_VERSION,
  V2_TOP20_SCOPE,
  decideV2Top20Persistence,
  validateExecutionState
} = require("./collection_worker_v2_top20_contract.cjs");
const {
  V2_TOP20_RESILIENCE_MAXIMUM_PROVIDER_CALLS
} = require("./collection_worker_v2_top20_resilience.cjs");
const {
  COLLECTION_WORKER_V2_TOP20_ARTIFACT_KEY_ID,
  COLLECTION_WORKER_V2_TOP20_BACKEND_ID,
  COLLECTION_WORKER_V2_TOP20_CLAIM_PATH,
  COLLECTION_WORKER_V2_TOP20_DISPATCH_KEY_ID,
  COLLECTION_WORKER_V2_TOP20_FAILURE_PATH,
  COLLECTION_WORKER_V2_TOP20_FINALIZE_PATH,
  COLLECTION_WORKER_V2_TOP20_HEARTBEAT_PATH,
  COLLECTION_WORKER_V2_TOP20_PREFLIGHT_PATH,
  COLLECTION_WORKER_V2_TOP20_PROTOCOL_SCHEMA_VERSION,
  COLLECTION_WORKER_V2_TOP20_REQUEST_KEY_ID,
  COLLECTION_WORKER_V2_TOP20_RESULT_SCHEMA_VERSION,
  COLLECTION_WORKER_V2_TOP20_RUNTIME_ID_PREFIX,
  COLLECTION_WORKER_V2_TOP20_SUMMARY_PATH,
  COLLECTION_WORKER_V2_TOP20_TARGET_SERVICE_ID,
  COLLECTION_WORKER_V2_TOP20_WORKER_ID,
  COLLECTION_WORKER_V2_TOP20_WORKER_POOL_ID,
  buildV2Top20DispatchCompatibilityContract,
  buildV2Top20ExecutionIdempotencyKey,
  buildV2Top20ExecutionContract,
  computeV2Top20ExecutionRequestHash,
  computeV2Top20ContractHash,
  decodeEd25519Key,
  normalizeV2Top20ExecutionRequestId,
  normalizeV2Top20PrepareContract,
  sha256Hex,
  stableJson,
  top20ApprovalId,
  verifyV2Top20ArtifactKeyProof
} = require("./collection_worker_v2_top20_protocol.cjs");

const COLLECTION_WORKER_V2_TOP20_ORCHESTRATOR_SCHEMA_VERSION = "collection-worker-v2-top20-orchestrator.v1";
const ACTIVE_JOB_STATES = new Set([
  "queued",
  "leased",
  "collecting",
  "artifact_received",
  "validated",
  "effects_applied",
  "failure_received"
]);
const ARTIFACT_STATES = new Set([
  "collecting",
  "artifact_received",
  "validated",
  "effects_applied",
  "committed",
  "blocked",
  "failed"
]);
const RESTART_RECOVERABLE_JOB_STATES = new Set(ACTIVE_JOB_STATES);
const RESTART_REJECTED_JOB_STATES = new Set(["artifact_received", "validated"]);
const COMMIT_PATTERN = /^[a-f0-9]{40}$/u;
const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const FAILURE_CODE_PATTERN = /^[A-Z][A-Z0-9_]{2,127}$/u;
const CANCELLATION_FAILURE_CODES = new Set([
  "COLLECTION_WORKER_V2_TOP20_CANCEL_REQUESTED",
  "V2_TOP20_COLLECTION_ABORTED",
  "V2_TOP20_PROVIDER_CALL_HEARTBEAT_FAILED"
]);
const SAFE_SUBTYPE_PATTERN = /^(?:http_403|http_429|challenge_html|unknown_access_block)$/u;
const DIAGNOSTIC_PATTERN = /^crawl-[a-f0-9]{12}$/u;
const TERMINAL_PAYLOAD_REPLAY_GRACE_MS = 15 * 60 * 1000;
const CLAIM_KEYS = Object.freeze(["workerId", "workerPoolId", "workerCommit"]);
const PREFLIGHT_KEYS = Object.freeze([
  "jobId",
  "attemptId",
  "workflowRevision",
  "workerCommit",
  "runtimeId",
  "artifactKeyProof"
]);
const HEARTBEAT_KEYS = Object.freeze([
  "jobId",
  "attemptId",
  "workflowRevision",
  "providerWorkflowRevision",
  "workerCommit",
  "runtimeId"
]);
const FINALIZE_KEYS = Object.freeze(["jobId", "attemptId", "workflowRevision", "signedArtifact"]);
const FAILURE_KEYS = Object.freeze([
  "jobId",
  "attemptId",
  "workflowRevision",
  "providerWorkflowRevision",
  "providerAttemptCount",
  "executedCallCount",
  "code",
  "providerFailureSubtype",
  "diagnosticId"
]);
const SUMMARY_KEYS = Object.freeze([
  "schemaVersion",
  "top20SchemaVersion",
  "profile",
  "collectorScope",
  "top20ContractHash",
  "contractHash",
  "executionIdentityHash",
  "status",
  "collectionStatus",
  "mainPlaceStatus",
  "detailStatus",
  "providerAttemptCount",
  "executedCallCount",
  "providerWorkflowRevision",
  "automaticRetry",
  "automaticFallback",
  "providerFailureSubtype",
  "diagnosticId",
  "executionState",
  "targetCompanyCount",
  "detailReadyCompanyCount",
  "revenueReadyCompanyCount",
  "detailCoverageRate",
  "revenueCoverageRate"
]);
const LEGACY_SUMMARY_KEYS = Object.freeze(SUMMARY_KEYS.filter((key) => ![
  "collectionStatus", "mainPlaceStatus", "detailStatus", "targetCompanyCount",
  "detailReadyCompanyCount", "revenueReadyCompanyCount", "detailCoverageRate", "revenueCoverageRate"
].includes(key)));

class CollectionWorkerV2Top20OrchestratorError extends Error {
  constructor(code, message, statusCode = 409, meta = {}) {
    super(message);
    this.name = "CollectionWorkerV2Top20OrchestratorError";
    this.code = code;
    this.statusCode = statusCode;
    this.retryable = false;
    this.retryAt = meta.retryAt || null;
    this.retryAfterSeconds = meta.retryAfterSeconds ?? null;
  }
}

function fail(code, message, statusCode = 409, meta = {}) {
  return new CollectionWorkerV2Top20OrchestratorError(code, message, statusCode, meta);
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw fail("COLLECTION_WORKER_V2_TOP20_INPUT_INVALID", `${label} is invalid`, 400);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw fail("COLLECTION_WORKER_V2_TOP20_INPUT_INVALID", `${label} fields are invalid`, 400);
  }
}

function canonicalCommit(value) {
  const commit = String(value || "").trim();
  if (!COMMIT_PATTERN.test(commit)) {
    throw fail("COLLECTION_WORKER_V2_TOP20_WORKER_MISMATCH", "top20 worker commit is invalid", 403);
  }
  return commit;
}

function safeEqualHash(left, right) {
  return HASH_PATTERN.test(String(left || ""))
    && HASH_PATTERN.test(String(right || ""))
    && crypto.timingSafeEqual(Buffer.from(left, "ascii"), Buffer.from(right, "ascii"));
}

function normalizeOperatorToken(value, expectedHash) {
  const token = String(value || "");
  if (token.length < 32 || !safeEqualHash(sha256Hex(token), String(expectedHash || ""))) {
    throw fail("COLLECTION_WORKER_V2_TOP20_OPERATOR_UNAUTHORIZED", "top20 operator is not authorized", 401);
  }
}

function runtimeIdForCommit(commit) {
  return `${COLLECTION_WORKER_V2_TOP20_RUNTIME_ID_PREFIX}${canonicalCommit(commit).slice(0, 12)}`;
}

function shortCommit(value) {
  const commit = String(value || "").trim();
  return COMMIT_PATTERN.test(commit) ? commit.slice(0, 12) : "";
}

function shortSafeHash(value) {
  const hash = String(value || "").trim();
  return HASH_PATTERN.test(hash) ? hash.slice(0, 12) : "";
}

function maskJobId(value) {
  const text = String(value || "");
  const match = text.match(/^job-top20-([a-f0-9]{24})$/u);
  return match ? `job-top20-${match[1].slice(0, 12)}…` : "";
}

function maskTop20ExecutionJobId(value) {
  const text = String(value || "");
  const match = text.match(/^job-top20-([a-f0-9]{12})-([a-f0-9]{12})$/u);
  return match ? `job-top20-${match[1]}-${match[2]}` : "";
}

function safeTop20Log(event, fields = {}) {
  console.warn(`[top20-provenance] ${stableJson({
    timestamp: fields.timestamp || new Date().toISOString(),
    event: String(event || "top20_event"),
    jobId: maskTop20ExecutionJobId(fields.jobId) || maskJobId(fields.jobId),
    contractHash: shortSafeHash(fields.contractHash),
    executionRequestHash: shortSafeHash(fields.executionRequestHash),
    executionIdentityHash: shortSafeHash(fields.executionIdentityHash),
    workerCommit: shortCommit(fields.workerCommit),
    sourceRole: String(fields.sourceRole || ""),
    sourceRoute: String(fields.sourceRoute || ""),
    actorKind: String(fields.actorKind || ""),
    collectorBackend: String(fields.collectorBackend || ""),
    collectionProfile: String(fields.collectionProfile || ""),
    providerOperation: String(fields.providerOperation || ""),
    requestOrdinal: Number.isInteger(fields.requestOrdinal) ? fields.requestOrdinal : null,
    jobState: String(fields.jobState || ""),
    failureCode: String(fields.failureCode || ""),
    existingJobId: maskTop20ExecutionJobId(fields.existingJobId) || maskJobId(fields.existingJobId),
    existingJobState: String(fields.existingJobState || ""),
    pid: process.pid,
    hostname: os.hostname(),
    renderServiceId: String(process.env.RENDER_SERVICE_ID || ""),
    renderServiceName: String(process.env.RENDER_SERVICE_NAME || "")
  })}`);
}

function logWorkerMismatch(fields = {}) {
  console.warn(`[top20-worker-mismatch] ${stableJson({
    expectedWorkerId: COLLECTION_WORKER_V2_TOP20_WORKER_ID,
    actualWorkerId: String(fields.actualWorkerId || ""),
    expectedWorkerPoolId: COLLECTION_WORKER_V2_TOP20_WORKER_POOL_ID,
    actualWorkerPoolId: String(fields.actualWorkerPoolId || ""),
    expectedWorkerCommit: shortCommit(fields.expectedWorkerCommit),
    actualWorkerCommit: shortCommit(fields.actualWorkerCommit),
    expectedTargetServiceId: COLLECTION_WORKER_V2_TOP20_TARGET_SERVICE_ID,
    actualTargetServiceId: String(fields.actualTargetServiceId || "unreported"),
    mismatchField: String(fields.mismatchField || "unknown")
  })}`);
}

function retryMeta(state, now) {
  const availability = providerAvailability(state, { now });
  return Object.freeze({
    retryAt: availability.retryAt,
    retryAfterSeconds: availability.retryAfterSeconds
  });
}

function transactionReceiptId(job, artifactHash) {
  return sha256Hex(stableJson({
    domain: "lodging-datalab.collection-worker.top20-transaction-receipt.v1",
    jobId: job.jobId,
    attemptId: job.attemptId,
    contractHash: job.contractHash,
    executionIdentityHash: job.executionIdentityHash,
    artifactHash
  }));
}

function failureReceiptHash(body) {
  return sha256Hex(stableJson({
    domain: "lodging-datalab.collection-worker.top20-failure-receipt.v1",
    jobId: String(body.jobId || ""),
    attemptId: String(body.attemptId || ""),
    workflowRevision: Number(body.workflowRevision),
    providerWorkflowRevision: Number(body.providerWorkflowRevision),
    providerAttemptCount: Number(body.providerAttemptCount),
    executedCallCount: Number(body.executedCallCount),
    code: String(body.code || ""),
    providerFailureSubtype: body.providerFailureSubtype || null,
    diagnosticId: body.diagnosticId || null
  }));
}

function providerLeaseExpiresAt(providerState) {
  return new Date(
    Date.parse(providerState.updatedAt) + PROVIDER_ATTEMPT_LEASE_SECONDS * 1000
  ).toISOString();
}

function normalizeTransactionResult(value, receiptId) {
  exactKeys(value, ["receiptId", "committed", "writeCount"], "top20 transaction result");
  if (
    value.receiptId !== receiptId
    || value.committed !== true
    || !Number.isInteger(value.writeCount)
    || value.writeCount < 1
  ) {
    throw fail("COLLECTION_WORKER_V2_TOP20_TRANSACTION_INVALID", "top20 transaction callback result is invalid", 500);
  }
  return Object.freeze({ receiptId, committed: true, writeCount: value.writeCount });
}

function createCollectionWorkerV2Top20Orchestrator(options = {}) {
  const enabled = options.enabled === true;
  const externalCallApproved = options.externalCallApproved === true;
  const previewWriteApproved = options.previewWriteApproved === true;
  const targetWorkerCommit = String(options.targetWorkerCommit || "").trim();
  const jobStore = options.jobStore;
  const providerStore = options.providerStore;
  const detailProviderStore = options.detailProviderStore || providerStore;
  const applyReadyTransaction = options.applyReadyTransaction;
  const nonceRegistry = options.nonceRegistry || createWorkerNonceRegistry();
  const now = typeof options.now === "function" ? options.now : () => new Date();
  const jobLeaseMs = Number.isInteger(options.jobLeaseMs) && options.jobLeaseMs >= 60_000
    ? options.jobLeaseMs
    : 5 * 60 * 1000;
  const payloads = new Map();
  const heartbeatReceipts = new Map();
  const transactionResults = new Map();
  const finalizationFlights = new Map();
  let reconciliationComplete = false;
  let reconciliationPromise = null;

  const dispatchPrivateKey = () => decodeEd25519Key(options.dispatchPrivateKeyBase64, "private");
  const artifactPublicKey = () => decodeEd25519Key(options.artifactPublicKeyBase64, "public");
  const requestPublicKey = () => decodeEd25519Key(options.requestPublicKeyBase64, "public");

  function assertReady() {
    canonicalCommit(targetWorkerCommit);
    if (!enabled || !externalCallApproved || !previewWriteApproved) {
      throw fail("COLLECTION_WORKER_V2_TOP20_DISABLED", "top20 collection workflow is disabled", 503);
    }
    if (
      !jobStore
      || typeof jobStore.readSnapshot !== "function"
      || typeof jobStore.createOrReuseJob !== "function"
      || typeof jobStore.claimNextJob !== "function"
      || typeof jobStore.transitionJob !== "function"
      || typeof jobStore.heartbeatJob !== "function"
      || !providerStore
      || typeof providerStore.read !== "function"
      || typeof providerStore.beginAttempt !== "function"
      || typeof providerStore.refreshAttempt !== "function"
      || typeof providerStore.recordSuccess !== "function"
      || typeof providerStore.recordBlock !== "function"
      || typeof providerStore.releaseAttempt !== "function"
      || !detailProviderStore
      || typeof detailProviderStore.read !== "function"
      || typeof detailProviderStore.beginAttempt !== "function"
      || typeof detailProviderStore.recordBlock !== "function"
      || typeof applyReadyTransaction !== "function"
    ) {
      throw fail("COLLECTION_WORKER_V2_TOP20_DEPENDENCY_INVALID", "top20 workflow dependency is invalid", 500);
    }
  }

  function verifyWorkerAuth(signedRequest, body, requestPath) {
    const request = verifySignedWorkerRequest(signedRequest, {
      publicKey: requestPublicKey(),
      expectedAudience: COLLECTION_WORKER_AUTH_AUDIENCE,
      expectedWorkerId: COLLECTION_WORKER_V2_TOP20_WORKER_ID,
      expectedWorkerPoolId: COLLECTION_WORKER_V2_TOP20_WORKER_POOL_ID,
      expectedKeyId: COLLECTION_WORKER_V2_TOP20_REQUEST_KEY_ID,
      body: stableJson(body),
      now: now(),
      nonceRegistry
    });
    if (request.path !== requestPath || request.method !== "POST") {
      throw fail("COLLECTION_WORKER_AUTH_SCOPE_INVALID", "top20 worker request route is invalid", 403);
    }
    return request;
  }

  function assertWorkerBody(body) {
    const mismatchField = body.workerId !== COLLECTION_WORKER_V2_TOP20_WORKER_ID
      ? "workerId"
      : body.workerPoolId !== COLLECTION_WORKER_V2_TOP20_WORKER_POOL_ID
        ? "workerPoolId"
        : body.workerCommit !== targetWorkerCommit
          ? "workerCommit"
          : "";
    if (
      mismatchField
    ) {
      logWorkerMismatch({
        actualWorkerId: body.workerId,
        actualWorkerPoolId: body.workerPoolId,
        expectedWorkerCommit: targetWorkerCommit,
        actualWorkerCommit: body.workerCommit,
        actualTargetServiceId: body.targetServiceId,
        mismatchField
      });
      throw fail("COLLECTION_WORKER_V2_TOP20_WORKER_MISMATCH", "top20 worker identity is invalid", 403);
    }
  }

  function currentTimeMs() {
    return new Date(now()).getTime();
  }

  function pruneExpiredTerminalPayloads() {
    const cutoff = currentTimeMs() - TERMINAL_PAYLOAD_REPLAY_GRACE_MS;
    for (const [jobId, entry] of payloads.entries()) {
      if (
        entry?.lifecycle === "terminal"
        && entry.terminalAt
        && Date.parse(entry.terminalAt) <= cutoff
      ) {
        safeTop20Log("top20_payload_pruned", {
          timestamp: new Date(now()).toISOString(),
          jobId,
          contractHash: entry.signedJob?.contractHash,
          executionIdentityHash: entry.signedJob?.executionIdentityHash,
          workerCommit: targetWorkerCommit,
          jobState: entry.terminalState || "terminal"
        });
        payloads.delete(jobId);
      }
    }
  }

  function isActivePayload(jobId) {
    pruneExpiredTerminalPayloads();
    const entry = payloads.get(jobId);
    return Boolean(entry && entry.lifecycle === "active");
  }

  function activePayloadCount() {
    pruneExpiredTerminalPayloads();
    let count = 0;
    for (const entry of payloads.values()) {
      if (entry?.lifecycle === "active") count += 1;
    }
    return count;
  }

  function retainedTerminalPayloadCount() {
    pruneExpiredTerminalPayloads();
    let count = 0;
    for (const entry of payloads.values()) {
      if (entry?.lifecycle === "terminal") count += 1;
    }
    return count;
  }

  function markPayloadTerminal(jobId, terminalState = "terminal") {
    pruneExpiredTerminalPayloads();
    const entry = payloads.get(jobId);
    if (!entry) return false;
    if (entry.lifecycle !== "terminal") {
      entry.lifecycle = "terminal";
      entry.terminalAt = new Date(now()).toISOString();
      entry.terminalState = String(terminalState || "terminal");
      safeTop20Log("top20_payload_retained", {
        timestamp: entry.terminalAt,
        jobId,
        contractHash: entry.signedJob?.contractHash,
        executionIdentityHash: entry.signedJob?.executionIdentityHash,
        workerCommit: targetWorkerCommit,
        jobState: entry.terminalState
      });
    }
    return true;
  }

  function forgetTerminalPayloadEntry(jobId) {
    const entry = payloads.get(jobId);
    if (!entry || entry.lifecycle !== "terminal") return false;
    payloads.delete(jobId);
    return true;
  }

  async function readJob(jobId) {
    const snapshot = await jobStore.readSnapshot();
    return snapshot.jobs.find((candidate) => candidate.jobId === jobId) || null;
  }

  async function settleAbandonedProviderAttempt(job) {
    const expectedWorkflowRevision = Number(job.providerWorkflowRevision);
    let providerState = await providerStore.read();
    if (
      providerState.state !== "probe_allowed"
      || !Number.isInteger(expectedWorkflowRevision)
      || expectedWorkflowRevision < 0
      || providerState.workflowRevision !== expectedWorkflowRevision
    ) {
      return providerState;
    }
    try {
      providerState = job.state === "queued"
        ? await providerStore.releaseAttempt({
            expectedWorkflowRevision,
            now: now()
          })
        : await providerStore.recordBlock({
            expectedWorkflowRevision,
            failure: {
              subtype: "unknown_access_block",
              diagnosticId: null
            },
            now: now()
          });
    } catch (error) {
      if (error?.code !== "NAVER_PROVIDER_WORKFLOW_REVISION_CONFLICT") throw error;
      providerState = await providerStore.read();
    }
    return providerState;
  }

  async function transitionAbandonedJob(job) {
    const snapshot = await jobStore.readSnapshot();
    const current = snapshot.jobs.find((candidate) => candidate.jobId === job.jobId) || null;
    if (!current || !RESTART_RECOVERABLE_JOB_STATES.has(current.state)) return current;
    const nextState = RESTART_REJECTED_JOB_STATES.has(current.state) ? "rejected" : "indeterminate";
    try {
      return await jobStore.transitionJob({
        jobId: current.jobId,
        expectedWorkflowRevision: current.workflowRevision,
        nextState,
        failureCode: "COLLECTION_WORKER_V2_TOP20_PAYLOAD_UNAVAILABLE",
        now: now()
      });
    } catch (error) {
      if (![
        "COLLECTION_JOB_REVISION_CONFLICT",
        "COLLECTION_JOB_TRANSITION_INVALID"
      ].includes(error?.code)) throw error;
      const latest = await jobStore.readSnapshot();
      const reconciled = latest.jobs.find((candidate) => candidate.jobId === current.jobId) || null;
      if (!reconciled || !RESTART_RECOVERABLE_JOB_STATES.has(reconciled.state)) return reconciled;
      throw error;
    }
  }

  async function abandonJobAfterRestart(job) {
    await settleAbandonedProviderAttempt(job);
    const terminal = await transitionAbandonedJob(job);
    payloads.delete(job.jobId);
    return terminal;
  }

  async function reconcileFirstUse() {
    if (reconciliationComplete) return;
    if (reconciliationPromise) return reconciliationPromise;
    reconciliationPromise = (async () => {
      const snapshot = await jobStore.readSnapshot();
      for (const job of snapshot.jobs) {
        if (
          job.backendId !== COLLECTION_WORKER_V2_TOP20_BACKEND_ID
          || !RESTART_RECOVERABLE_JOB_STATES.has(job.state)
          || isActivePayload(job.jobId)
        ) continue;
        await abandonJobAfterRestart(job);
      }
      reconciliationComplete = true;
    })();
    try {
      await reconciliationPromise;
    } finally {
      reconciliationPromise = null;
    }
  }

  function assertActiveLease(job) {
    if (!job.leaseExpiresAt || Date.parse(job.leaseExpiresAt) <= new Date(now()).getTime()) {
      throw fail("COLLECTION_WORKER_V2_TOP20_LEASE_EXPIRED", "top20 job lease expired", 409);
    }
  }

  async function prepareCore(input = {}) {
    assertReady();
    await reconcileFirstUse();
    const normalized = normalizeV2Top20PrepareContract(input.contract);
    const executionRequestId = input.executionRequestId === undefined || input.executionRequestId === null
      ? crypto.randomUUID()
      : normalizeV2Top20ExecutionRequestId(input.executionRequestId);
    const executionRequestHash = computeV2Top20ExecutionRequestHash(executionRequestId);
    const top20Contract = buildV2Top20ExecutionContract(input.contract);
    const top20ContractHash = computeV2Top20ContractHash(top20Contract);
    safeTop20Log("top20_job_prepare_requested", {
      timestamp: new Date(now()).toISOString(),
      contractHash: top20ContractHash,
      executionRequestHash,
      workerCommit: targetWorkerCommit,
      sourceRole: "admin",
      sourceRoute: "/api/crawl",
      actorKind: "operator",
      collectorBackend: "v2_top20_worker",
      collectionProfile: "top20_inventory_revenue"
    });
    const snapshot = await jobStore.readSnapshot();
    const contractPrefix = top20ContractHash.slice(0, 12);
    const executionPrefix = executionRequestHash.slice(0, 12);
    const jobId = `job-top20-${contractPrefix}-${executionPrefix}`;
    const attemptId = `attempt:top20-${contractPrefix}-${executionPrefix}`;
    const existingExecution = snapshot.jobs.find((job) => job.jobId === jobId) || null;
    if (existingExecution) {
      safeTop20Log("top20_job_prepare_reused", {
        timestamp: new Date(now()).toISOString(),
        jobId: existingExecution.jobId,
        contractHash: top20ContractHash,
        executionRequestHash,
        executionIdentityHash: existingExecution.executionIdentityHash,
        workerCommit: targetWorkerCommit,
        sourceRole: input.provenance?.sourceRole || "admin",
        sourceRoute: input.provenance?.sourceRoute || "/api/crawl",
        actorKind: input.provenance?.actorKind || "operator",
        collectorBackend: input.provenance?.collectorBackend || "v2_top20_worker",
        collectionProfile: "top20_inventory_revenue",
        jobState: existingExecution.state
      });
      return Object.freeze({
        schemaVersion: COLLECTION_WORKER_V2_TOP20_ORCHESTRATOR_SCHEMA_VERSION,
        status: existingExecution.state,
        reused: true,
        jobId: existingExecution.jobId,
        workflowRevision: existingExecution.workflowRevision,
        contractHash: existingExecution.contractHash,
        executionIdentityHash: existingExecution.executionIdentityHash,
        top20ContractHash,
        executionRequestHash,
        providerWorkflowRevision: existingExecution.providerWorkflowRevision,
        maxProviderAttempts: 1,
        maximumProviderCalls: V2_TOP20_RESILIENCE_MAXIMUM_PROVIDER_CALLS,
        automaticRetry: false,
        automaticFallback: false
      });
    }
    const active = snapshot.jobs.find((job) => (
      job.backendId === COLLECTION_WORKER_V2_TOP20_BACKEND_ID && ACTIVE_JOB_STATES.has(job.state)
    ));
    if (active) {
      const error = fail("COLLECTION_WORKER_V2_TOP20_ACTIVE_JOB", "another top20 job is active", 409);
      error.existingJobId = active.jobId;
      error.existingJobState = active.state;
      throw error;
    }

    const createdAt = new Date(now());
    const providerState = await providerStore.read();
    const detailProviderState = await detailProviderStore.read();
    if (providerState.state !== "closed") {
      throw fail(
        "NAVER_PROVIDER_COOLDOWN_ACTIVE",
        "NAVER provider must be closed before a top20 job can reserve its session",
        503,
        retryMeta(providerState, createdAt)
      );
    }
    const reservation = await providerStore.beginAttempt({
      expectedWorkflowRevision: providerState.workflowRevision,
      explicit: true,
      now: createdAt
    });
    if (!reservation.allowed || reservation.state.state !== "probe_allowed") {
      throw fail(
        "NAVER_PROVIDER_COOLDOWN_ACTIVE",
        "NAVER provider session could not be reserved",
        503,
        retryMeta(reservation.state, createdAt)
      );
    }

    let stored = false;
    try {
      const signedJob = buildSignedJobEnvelope({
        jobId,
        attemptId,
        approvalId: top20ApprovalId(top20ContractHash, executionRequestHash),
        audience: COLLECTION_WORKER_JOB_AUDIENCE,
        workerId: COLLECTION_WORKER_V2_TOP20_WORKER_ID,
        workerPoolId: COLLECTION_WORKER_V2_TOP20_WORKER_POOL_ID,
        nonce: crypto.randomBytes(18).toString("base64url"),
        contract: buildV2Top20DispatchCompatibilityContract(input.contract),
        authorization: {
          enabled: true,
          actualCallsEnabled: true,
          externalCallApproved: true,
          authorizedExecutionCount: 1
        }
      }, {
        privateKey: dispatchPrivateKey(),
        signerKeyId: COLLECTION_WORKER_V2_TOP20_DISPATCH_KEY_ID,
        now: createdAt,
        ttlSeconds: 15 * 60
      });
      const job = await jobStore.createOrReuseJob({
        jobId,
        attemptId,
        idempotencyKey: buildV2Top20ExecutionIdempotencyKey({
          contractIdempotencyKey: signedJob.idempotencyKey,
          executionRequestHash,
          jobId,
          attemptId
        }),
        contractHash: signedJob.contractHash,
        executionIdentityHash: signedJob.executionIdentityHash,
        backendId: COLLECTION_WORKER_V2_TOP20_BACKEND_ID,
        backendVersion: targetWorkerCommit,
        workerPoolId: COLLECTION_WORKER_V2_TOP20_WORKER_POOL_ID,
        providerWorkflowRevision: reservation.state.workflowRevision,
        maxProviderCalls: 1,
        now: createdAt
      });
      stored = true;
      const executionPayload = Object.freeze({
        schemaVersion: COLLECTION_WORKER_V2_TOP20_PROTOCOL_SCHEMA_VERSION,
        jobId,
        attemptId,
        contractHash: signedJob.contractHash,
        executionIdentityHash: signedJob.executionIdentityHash,
        top20ContractHash,
        executionRequestHash,
        contract: Object.freeze({
          keyword: normalized.keyword,
          searchMode: normalized.searchMode,
          collectionMode: normalized.collectionMode,
          collectionPurpose: normalized.collectionPurpose,
          productMode: normalized.productMode,
          checkIn: normalized.checkIn,
          checkOut: normalized.checkOut,
          rankStart: normalized.rankStart,
          rankEnd: normalized.rankEnd,
          detailRankStart: normalized.detailRankStart,
          detailRankEnd: normalized.detailRankEnd
        }),
        top20Contract,
        providerSession: Object.freeze({
          maximumProviderCalls: V2_TOP20_RESILIENCE_MAXIMUM_PROVIDER_CALLS,
          providerAttemptCount: 1,
          concurrency: 1,
          automaticRetry: false,
          automaticFallback: false,
          circuitStateAtReservation: "closed",
          serviceGlobalLockHeld: true
        }),
        detailProviderSession: Object.freeze({
          state: detailProviderState.state,
          retryAt: detailProviderState.retryAt || null,
          liveCallsAllowed: detailProviderState.state === "closed"
        })
      });
      payloads.set(jobId, {
        signedJob,
        executionPayload,
        top20ContractHash,
        executionRequestHash,
        providerWorkflowRevision: reservation.state.workflowRevision,
        preflighted: false,
        lifecycle: "active",
        terminalAt: null,
        terminalState: null
      });
      safeTop20Log("top20_job_queued", {
        timestamp: createdAt.toISOString(),
        jobId,
        contractHash: signedJob.contractHash,
        executionRequestHash,
        executionIdentityHash: signedJob.executionIdentityHash,
        workerCommit: targetWorkerCommit,
        sourceRole: "admin",
        sourceRoute: "/api/crawl",
        actorKind: "operator",
        collectorBackend: "v2_top20_worker",
        collectionProfile: "top20_inventory_revenue",
        jobState: "queued"
      });
      return Object.freeze({
        schemaVersion: COLLECTION_WORKER_V2_TOP20_ORCHESTRATOR_SCHEMA_VERSION,
        status: "queued",
        jobId,
        workflowRevision: job.workflowRevision,
        contractHash: signedJob.contractHash,
        executionIdentityHash: signedJob.executionIdentityHash,
        top20ContractHash,
        executionRequestHash,
        providerWorkflowRevision: reservation.state.workflowRevision,
        maxProviderAttempts: 1,
        maximumProviderCalls: V2_TOP20_RESILIENCE_MAXIMUM_PROVIDER_CALLS,
        automaticRetry: false,
        automaticFallback: false
      });
    } catch (error) {
      if (!stored) {
        await providerStore.releaseAttempt({
          expectedWorkflowRevision: reservation.state.workflowRevision,
          now: new Date(now())
        }).catch(() => {});
      }
      throw error;
    }
  }

  async function prepareWithAudit(input = {}) {
    try {
      return await prepareCore(input);
    } catch (error) {
      let contractHash = "";
      let executionRequestHash = "";
      try {
        contractHash = computeV2Top20ContractHash(buildV2Top20ExecutionContract(input.contract));
      } catch {}
      try {
        executionRequestHash = computeV2Top20ExecutionRequestHash(input.executionRequestId);
      } catch {}
      safeTop20Log("top20_job_prepare_rejected", {
        timestamp: new Date(now()).toISOString(),
        contractHash,
        executionRequestHash,
        existingJobId: error?.existingJobId,
        existingJobState: error?.existingJobState,
        workerCommit: targetWorkerCommit,
        sourceRole: input.provenance?.sourceRole || "admin",
        sourceRoute: input.provenance?.sourceRoute || "/api/crawl",
        actorKind: input.provenance?.actorKind || "operator",
        collectorBackend: input.provenance?.collectorBackend || "v2_top20_worker",
        failureCode: error?.code || "COLLECTION_WORKER_V2_TOP20_PREPARE_FAILED"
      });
      throw error;
    }
  }

  async function prepare(input = {}) {
    try {
      normalizeOperatorToken(input.operatorToken, options.operatorTokenSha256);
    } catch (error) {
      safeTop20Log("top20_job_prepare_rejected", {
        timestamp: new Date(now()).toISOString(),
        sourceRole: input.provenance?.sourceRole || "operator",
        sourceRoute: input.provenance?.sourceRoute || "",
        actorKind: input.provenance?.actorKind || "operator",
        collectorBackend: input.provenance?.collectorBackend || "v2_top20_worker",
        failureCode: error?.code || "COLLECTION_WORKER_V2_TOP20_PREPARE_FAILED"
      });
      throw error;
    }
    return prepareWithAudit(input);
  }

  async function prepareTrustedAdmin(input = {}) {
    if (input.trustedAdmin !== true) {
      throw fail("COLLECTION_WORKER_V2_TOP20_ADMIN_PREPARE_FORBIDDEN", "trusted admin preparation is required", 403);
    }
    return prepareWithAudit({
      contract: input.contract,
      executionRequestId: input.executionRequestId,
      provenance: input.provenance
    });
  }

  async function prepareDryRunTrustedAdmin(input = {}) {
    if (input.trustedAdmin !== true) {
      throw fail("COLLECTION_WORKER_V2_TOP20_ADMIN_PREPARE_FORBIDDEN", "trusted admin preparation is required", 403);
    }
    assertReady();
    await reconcileFirstUse();
    const executionRequestId = normalizeV2Top20ExecutionRequestId(input.executionRequestId);
    const executionRequestHash = computeV2Top20ExecutionRequestHash(executionRequestId);
    const top20ContractHash = computeV2Top20ContractHash(buildV2Top20ExecutionContract(input.contract));
    const contractPrefix = top20ContractHash.slice(0, 12);
    const executionPrefix = executionRequestHash.slice(0, 12);
    const jobId = `job-top20-${contractPrefix}-${executionPrefix}`;
    const snapshot = await jobStore.readSnapshot();
    const existingExecution = snapshot.jobs.find((job) => job.jobId === jobId) || null;
    const active = snapshot.jobs.find((job) => (
      job.backendId === COLLECTION_WORKER_V2_TOP20_BACKEND_ID && ACTIVE_JOB_STATES.has(job.state)
    )) || null;
    const providerState = await providerStore.read();
    const conflictCode = existingExecution
      ? "COLLECTION_WORKER_V2_TOP20_EXECUTION_ALREADY_EXISTS"
      : active
        ? "COLLECTION_WORKER_V2_TOP20_ACTIVE_JOB"
        : providerState.state !== "closed"
          ? "NAVER_PROVIDER_COOLDOWN_ACTIVE"
          : null;
    safeTop20Log("top20_job_prepare_dry_run", {
      timestamp: new Date(now()).toISOString(),
      jobId,
      contractHash: top20ContractHash,
      executionRequestHash,
      workerCommit: targetWorkerCommit,
      sourceRole: input.provenance?.sourceRole || "admin",
      sourceRoute: input.provenance?.sourceRoute || "/api/admin/collection-worker/v2-top20/prepare-dry-run",
      actorKind: input.provenance?.actorKind || "operator",
      collectorBackend: input.provenance?.collectorBackend || "v2_top20_worker",
      jobState: existingExecution?.state || "",
      failureCode: conflictCode || ""
    });
    return Object.freeze({
      schemaVersion: COLLECTION_WORKER_V2_TOP20_ORCHESTRATOR_SCHEMA_VERSION,
      wouldCreate: conflictCode === null,
      conflictCode,
      reused: Boolean(existingExecution),
      generatedJobId: jobId,
      contractHash: top20ContractHash,
      executionRequestHash,
      existingJobId: existingExecution?.jobId || null,
      existingJobState: existingExecution?.state || null,
      activeJobId: active?.jobId || null,
      providerState: providerState.state,
      providerReservationCreated: false,
      workerClaimStarted: false,
      writeCount: 0
    });
  }

  async function claim(input = {}) {
    assertReady();
    exactKeys(input.body, CLAIM_KEYS, "top20 claim body");
    verifyWorkerAuth(input.signedRequest, input.body, COLLECTION_WORKER_V2_TOP20_CLAIM_PATH);
    assertWorkerBody(input.body);
    await reconcileFirstUse();
    const snapshot = await jobStore.readSnapshot();
    const candidate = snapshot.jobs.find((job) => (
      job.backendId === COLLECTION_WORKER_V2_TOP20_BACKEND_ID
      && job.state === "queued"
      && job.cancellationRequested !== true
      && isActivePayload(job.jobId)
    ));
    if (!candidate) return Object.freeze({ status: "empty", job: null });
    const entry = payloads.get(candidate.jobId);
    const providerState = await providerStore.read();
    if (
      providerState.state !== "probe_allowed"
      || providerState.workflowRevision !== entry.providerWorkflowRevision
      || !providerAvailability(providerState, { now: now() }).attemptInFlight
    ) {
      throw fail("COLLECTION_WORKER_V2_TOP20_PROVIDER_LEASE_LOST", "top20 provider session lease is unavailable", 409);
    }
    const leased = await jobStore.claimNextJob({
      jobId: candidate.jobId,
      workerId: COLLECTION_WORKER_V2_TOP20_WORKER_ID,
      workerPoolId: COLLECTION_WORKER_V2_TOP20_WORKER_POOL_ID,
      providerWorkflowRevision: entry.providerWorkflowRevision,
      leaseMs: jobLeaseMs,
      now: now()
    });
    if (!leased) return Object.freeze({ status: "empty", job: null });
    const collecting = await jobStore.transitionJob({
      jobId: leased.jobId,
      expectedWorkflowRevision: leased.workflowRevision,
      workerId: COLLECTION_WORKER_V2_TOP20_WORKER_ID,
      nextState: "collecting",
      now: now()
    });
    safeTop20Log("top20_job_claimed", {
      timestamp: new Date(now()).toISOString(),
      jobId: collecting.jobId,
      contractHash: collecting.contractHash,
      executionIdentityHash: collecting.executionIdentityHash,
      workerCommit: targetWorkerCommit,
      providerOperation: "naver_place_top20",
      requestOrdinal: 1,
      jobState: collecting.state
    });
    return Object.freeze({
      status: "claimed",
      job: Object.freeze({
        signedJob: entry.signedJob,
        executionPayload: entry.executionPayload,
        workflowRevision: collecting.workflowRevision,
        providerWorkflowRevision: entry.providerWorkflowRevision,
        leaseExpiresAt: collecting.leaseExpiresAt,
        providerLeaseExpiresAt: providerLeaseExpiresAt(providerState),
        targetWorkerCommit
      })
    });
  }

  async function preflight(input = {}) {
    assertReady();
    exactKeys(input.body, PREFLIGHT_KEYS, "top20 preflight body");
    verifyWorkerAuth(input.signedRequest, input.body, COLLECTION_WORKER_V2_TOP20_PREFLIGHT_PATH);
    await reconcileFirstUse();
    const job = await readJob(input.body.jobId);
    const entry = job ? payloads.get(job.jobId) : null;
    const identityMatches = Boolean(
      job
      && entry
      && job.state === "collecting"
      && job.workerId === COLLECTION_WORKER_V2_TOP20_WORKER_ID
      && job.attemptId === input.body.attemptId
      && input.body.workerCommit === targetWorkerCommit
      && input.body.runtimeId === runtimeIdForCommit(targetWorkerCommit)
    );
    if (
      identityMatches
      && job.cancellationRequested === true
      && job.workflowRevision === Number(input.body.workflowRevision) + 1
    ) {
      throw fail(
        "COLLECTION_WORKER_V2_TOP20_CANCEL_REQUESTED",
        "top20 Worker collection cancellation was requested",
        409
      );
    }
    if (
      !job
      || !entry
      || job.state !== "collecting"
      || job.workerId !== COLLECTION_WORKER_V2_TOP20_WORKER_ID
      || job.attemptId !== input.body.attemptId
      || job.workflowRevision !== Number(input.body.workflowRevision)
      || input.body.workerCommit !== targetWorkerCommit
      || input.body.runtimeId !== runtimeIdForCommit(targetWorkerCommit)
    ) {
      throw fail("COLLECTION_WORKER_V2_TOP20_PREFLIGHT_CONFLICT", "top20 preflight is stale", 409);
    }
    assertActiveLease(job);
    const providerState = await providerStore.read();
    if (
      providerState.state !== "probe_allowed"
      || providerState.workflowRevision !== entry.providerWorkflowRevision
      || !providerAvailability(providerState, { now: now() }).attemptInFlight
    ) {
      throw fail("COLLECTION_WORKER_V2_TOP20_PROVIDER_LEASE_LOST", "top20 provider session lease is unavailable", 409);
    }
    verifyV2Top20ArtifactKeyProof(input.body.artifactKeyProof, {
      jobId: job.jobId,
      attemptId: job.attemptId,
      workflowRevision: job.workflowRevision,
      workerId: job.workerId,
      workerPoolId: job.workerPoolId,
      workerCommit: targetWorkerCommit,
      runtimeId: input.body.runtimeId,
      contractHash: job.contractHash,
      executionIdentityHash: job.executionIdentityHash,
      top20ContractHash: entry.top20ContractHash
    }, artifactPublicKey());
    entry.preflighted = true;
    safeTop20Log("top20_preflight_completed", {
      timestamp: new Date(now()).toISOString(),
      jobId: job.jobId,
      contractHash: job.contractHash,
      executionIdentityHash: job.executionIdentityHash,
      workerCommit: targetWorkerCommit,
      providerOperation: "naver_place_top20",
      requestOrdinal: 1,
      jobState: job.state
    });
    return Object.freeze({
      status: "preflighted",
      jobId: job.jobId,
      workflowRevision: job.workflowRevision,
      providerWorkflowRevision: entry.providerWorkflowRevision,
      top20ContractHash: entry.top20ContractHash,
      maximumProviderCalls: V2_TOP20_CONTRACT.maximumProviderCalls,
      concurrency: 1,
      automaticRetry: false,
      automaticFallback: false
    });
  }

  async function heartbeat(input = {}) {
    assertReady();
    exactKeys(input.body, HEARTBEAT_KEYS, "top20 heartbeat body");
    verifyWorkerAuth(input.signedRequest, input.body, COLLECTION_WORKER_V2_TOP20_HEARTBEAT_PATH);
    await reconcileFirstUse();
    const receiptKey = sha256Hex(stableJson(input.body));
    if (heartbeatReceipts.has(receiptKey)) {
      return Object.freeze({ ...heartbeatReceipts.get(receiptKey), replayed: true });
    }
    let job = await readJob(input.body.jobId);
    const entry = job ? payloads.get(job.jobId) : null;
    const identityMatches = Boolean(
      job
      && entry
      && job.state === "collecting"
      && job.workerId === COLLECTION_WORKER_V2_TOP20_WORKER_ID
      && job.attemptId === input.body.attemptId
      && input.body.workerCommit === targetWorkerCommit
      && input.body.runtimeId === runtimeIdForCommit(targetWorkerCommit)
      && entry.providerWorkflowRevision === Number(input.body.providerWorkflowRevision)
    );
    if (
      identityMatches
      && job.cancellationRequested === true
      && job.workflowRevision === Number(input.body.workflowRevision) + 1
    ) {
      throw fail(
        "COLLECTION_WORKER_V2_TOP20_CANCEL_REQUESTED",
        "top20 Worker collection cancellation was requested",
        409
      );
    }
    if (
      !job
      || !entry
      || job.state !== "collecting"
      || job.workerId !== COLLECTION_WORKER_V2_TOP20_WORKER_ID
      || job.attemptId !== input.body.attemptId
      || job.workflowRevision !== Number(input.body.workflowRevision)
      || entry.providerWorkflowRevision !== Number(input.body.providerWorkflowRevision)
      || input.body.workerCommit !== targetWorkerCommit
      || input.body.runtimeId !== runtimeIdForCommit(targetWorkerCommit)
    ) {
      throw fail("COLLECTION_WORKER_V2_TOP20_HEARTBEAT_CONFLICT", "top20 heartbeat is stale", 409);
    }
    assertActiveLease(job);
    const providerState = await providerStore.read();
    if (
      providerState.state !== "probe_allowed"
      || providerState.workflowRevision !== entry.providerWorkflowRevision
    ) {
      throw fail("COLLECTION_WORKER_V2_TOP20_PROVIDER_LEASE_LOST", "top20 provider session lease is unavailable", 409);
    }
    const providerHeartbeat = await providerStore.refreshAttempt({
      expectedWorkflowRevision: entry.providerWorkflowRevision,
      now: now()
    });
    entry.providerWorkflowRevision = providerHeartbeat.workflowRevision;
    job = await jobStore.heartbeatJob({
      jobId: job.jobId,
      expectedWorkflowRevision: job.workflowRevision,
      workerId: job.workerId,
      providerWorkflowRevision: providerHeartbeat.workflowRevision,
      leaseMs: jobLeaseMs,
      now: now()
    });
    const response = Object.freeze({
      status: "heartbeat",
      jobId: job.jobId,
      workflowRevision: job.workflowRevision,
      providerWorkflowRevision: providerHeartbeat.workflowRevision,
      jobLeaseExpiresAt: job.leaseExpiresAt,
      providerLeaseExpiresAt: providerLeaseExpiresAt(providerHeartbeat),
      replayed: false
    });
    heartbeatReceipts.set(receiptKey, response);
    return response;
  }

  function readArtifactSummary(verifiedArtifact, job, entry) {
    const files = verifiedArtifact.bundle.files.filter((file) => file.path === COLLECTION_WORKER_V2_TOP20_SUMMARY_PATH);
    if (files.length !== 1) {
      throw fail("COLLECTION_WORKER_V2_TOP20_ARTIFACT_INVALID", "top20 summary artifact is missing", 400);
    }
    let document;
    try {
      document = JSON.parse(Buffer.from(files[0].contentBase64, "base64").toString("utf8"));
    } catch {
      throw fail("COLLECTION_WORKER_V2_TOP20_ARTIFACT_INVALID", "top20 summary artifact is invalid", 400);
    }
    exactKeys(document, Object.hasOwn(document, "collectionStatus") ? SUMMARY_KEYS : LEGACY_SUMMARY_KEYS, "top20 summary");
    if (
      document.schemaVersion !== COLLECTION_WORKER_V2_TOP20_RESULT_SCHEMA_VERSION
      || document.top20SchemaVersion !== V2_TOP20_SCHEMA_VERSION
      || document.profile !== V2_TOP20_PROFILE
      || document.collectorScope !== V2_TOP20_SCOPE
      || document.top20ContractHash !== entry.top20ContractHash
      || document.contractHash !== job.contractHash
      || document.executionIdentityHash !== job.executionIdentityHash
      || document.providerAttemptCount !== 1
      || !Number.isInteger(document.executedCallCount)
      || document.executedCallCount < 1
      || document.executedCallCount > V2_TOP20_RESILIENCE_MAXIMUM_PROVIDER_CALLS
      || !Number.isInteger(document.providerWorkflowRevision)
      || document.providerWorkflowRevision < 0
      || document.automaticRetry !== false
      || document.automaticFallback !== false
      || !["ready", "blocked", "failed"].includes(document.status)
    ) {
      throw fail("COLLECTION_WORKER_V2_TOP20_ARTIFACT_INVALID", "top20 summary identity or budget is invalid", 409);
    }
    const resilient = document.executionState === null;
    const state = resilient ? null : validateExecutionState(document.executionState);
    if (!resilient && state.callLedger.total !== document.executedCallCount) {
      throw fail("COLLECTION_WORKER_V2_TOP20_ARTIFACT_INVALID", "top20 provider ledger does not match", 409);
    }
    const decision = resilient
      ? { saveRun: ["complete", "partial", "rank_only"].includes(document.collectionStatus) }
      : decideV2Top20Persistence(state);
    if (document.status === "ready") {
      if (
        decision.saveRun !== true
        || !resilient && state.phase !== "ready_to_persist"
        || !resilient && document.providerFailureSubtype !== null
        || document.diagnosticId !== null
      ) {
        throw fail("COLLECTION_WORKER_V2_TOP20_NOT_READY", "top20 artifact is not persistable", 409);
      }
    } else if (document.status === "blocked") {
      if (
        state.phase !== "failed"
        || state.failure?.resultStatus !== "blocked"
        || !SAFE_SUBTYPE_PATTERN.test(String(document.providerFailureSubtype || ""))
        || document.diagnosticId !== null && !DIAGNOSTIC_PATTERN.test(String(document.diagnosticId))
      ) {
        throw fail("COLLECTION_WORKER_V2_TOP20_ARTIFACT_INVALID", "top20 block receipt is invalid", 409);
      }
    } else if (
      state.phase !== "failed"
      || document.providerFailureSubtype !== null
      || document.diagnosticId !== null
    ) {
      throw fail("COLLECTION_WORKER_V2_TOP20_ARTIFACT_INVALID", "top20 failure receipt is invalid", 409);
    }
    return Object.freeze({ ...document, executionState: state, persistenceDecision: decision });
  }

  async function settleProviderArtifact(summary, artifactHash) {
    const expectedRevision = Number(summary.providerWorkflowRevision);
    let providerState = await providerStore.read();
    const expectedKind = summary.status === "ready" ? "success" : summary.status === "blocked" ? "block" : "release";
    if (providerState.workflowRevision === expectedRevision + 1) {
      if (
        providerState.lastOutcomeKind !== expectedKind
        || providerState.lastOutcomeReceiptHash !== artifactHash
      ) {
        throw fail("COLLECTION_WORKER_V2_TOP20_PROVIDER_FINALIZATION_CONFLICT", "top20 provider receipt conflicts", 409);
      }
      return providerState;
    }
    if (providerState.workflowRevision !== expectedRevision || providerState.state !== "probe_allowed") {
      throw fail("COLLECTION_WORKER_V2_TOP20_PROVIDER_FINALIZATION_AMBIGUOUS", "top20 provider receipt is ambiguous", 409);
    }
    providerState = summary.status === "ready"
      ? await providerStore.recordSuccess({
          expectedWorkflowRevision: expectedRevision,
          outcomeReceiptHash: artifactHash,
          now: now()
        })
      : summary.status === "blocked"
        ? await providerStore.recordBlock({
            expectedWorkflowRevision: expectedRevision,
            outcomeReceiptHash: artifactHash,
            failure: {
              subtype: summary.providerFailureSubtype,
              diagnosticId: summary.diagnosticId
            },
            now: now()
          })
        : await providerStore.releaseAttempt({
            expectedWorkflowRevision: expectedRevision,
            outcomeReceiptHash: artifactHash,
            now: now()
          });
    return providerState;
  }

  async function settleDetailProviderArtifact(summary, artifactHash) {
    if (summary.detailStatus !== "blocked") return detailProviderStore.read();
    let state = await detailProviderStore.read();
    if (state.state === "open") return state;
    if (state.state !== "closed") return state;
    const reservation = await detailProviderStore.beginAttempt({
      expectedWorkflowRevision: state.workflowRevision,
      explicit: true,
      now: now()
    });
    if (!reservation.allowed || reservation.state.state !== "probe_allowed") return reservation.state;
    return detailProviderStore.recordBlock({
      expectedWorkflowRevision: reservation.state.workflowRevision,
      outcomeReceiptHash: artifactHash,
      failure: {
        subtype: summary.providerFailureSubtype || "unknown_access_block",
        diagnosticId: summary.diagnosticId || null
      },
      now: now()
    });
  }

  function assertTerminalArtifact(job, summary, artifactHash) {
    const expectedState = summary.status === "ready" ? "committed" : summary.status === "blocked" ? "blocked" : "failed";
    const expectedCode = summary.status === "blocked"
      ? "NAVER_ACCESS_BLOCKED"
      : summary.status === "failed" ? "COLLECTION_WORKER_V2_TOP20_NOT_READY" : "";
    if (
      job.state !== expectedState
      || job.artifactHash !== artifactHash
      || expectedCode && job.failureCode !== expectedCode
    ) {
      throw fail("COLLECTION_WORKER_V2_TOP20_FINALIZE_CONFLICT", "top20 terminal artifact receipt conflicts", 409);
    }
  }

  function finalizationResponse(job, summary, providerState, detailProviderState, artifactHash, transactionResult, replayed) {
    return Object.freeze({
      schemaVersion: COLLECTION_WORKER_V2_TOP20_ORCHESTRATOR_SCHEMA_VERSION,
      status: summary.status,
      collectionStatus: summary.collectionStatus || (summary.status === "ready" ? "complete" : summary.status),
      code: summary.status === "blocked"
        ? "NAVER_ACCESS_BLOCKED"
        : summary.status === "failed" ? "COLLECTION_WORKER_V2_TOP20_NOT_READY" : null,
      jobId: job.jobId,
      jobState: job.state,
      workflowRevision: job.workflowRevision,
      artifactHash,
      transactionReceiptId: summary.status === "ready" ? transactionReceiptId(job, artifactHash) : null,
      providerState: providerState.state,
      mainPlaceProviderState: providerState.state,
      bookingDetailProviderState: detailProviderState?.state || null,
      providerAttemptCount: 1,
      executedCallCount: summary.executedCallCount,
      resultStored: summary.status === "ready",
      writeCount: transactionResult?.writeCount || 0,
      replayed: replayed === true
    });
  }

  async function finalizeCore(input = {}) {
    let job = await readJob(input.body.jobId);
    const entry = job ? payloads.get(job.jobId) : null;
    if (
      !job
      || !entry
      || job.workerId !== COLLECTION_WORKER_V2_TOP20_WORKER_ID
      || job.attemptId !== input.body.attemptId
      || !ARTIFACT_STATES.has(job.state)
    ) {
      throw fail("COLLECTION_WORKER_V2_TOP20_FINALIZE_CONFLICT", "top20 finalization is stale", 409);
    }
    if (job.state === "collecting") {
      assertActiveLease(job);
      if (entry.preflighted !== true || job.workflowRevision !== Number(input.body.workflowRevision)) {
        throw fail("COLLECTION_WORKER_V2_TOP20_FINALIZE_CONFLICT", "top20 finalization is stale", 409);
      }
    }
    const verifiedArtifact = verifyCollectionArtifactBundle(input.body.signedArtifact, {
      publicKey: artifactPublicKey(),
      expectedIdentity: {
        jobId: job.jobId,
        attemptId: job.attemptId,
        workerId: job.workerId,
        workerPoolId: job.workerPoolId,
        runtimeId: runtimeIdForCommit(targetWorkerCommit),
        contractHash: job.contractHash,
        executionIdentityHash: job.executionIdentityHash
      },
      expectedSigningKeyId: COLLECTION_WORKER_V2_TOP20_ARTIFACT_KEY_ID
    });
    const artifactHash = verifiedArtifact.bundle.bundleHash;
    const summary = readArtifactSummary(verifiedArtifact, job, entry);
    if (job.artifactHash && job.artifactHash !== artifactHash) {
      throw fail("COLLECTION_WORKER_V2_TOP20_FINALIZE_CONFLICT", "top20 artifact hash conflicts", 409);
    }
    if (["committed", "blocked", "failed"].includes(job.state)) {
      assertTerminalArtifact(job, summary, artifactHash);
      markPayloadTerminal(job.jobId, job.state);
      const providerState = await providerStore.read();
      const detailProviderState = await detailProviderStore.read();
      const receiptId = transactionReceiptId(job, artifactHash);
      return finalizationResponse(
        job,
        summary,
        providerState,
        detailProviderState,
        artifactHash,
        transactionResults.get(receiptId) || null,
        true
      );
    }

    if (summary.providerWorkflowRevision !== entry.providerWorkflowRevision) {
      throw fail("COLLECTION_WORKER_V2_TOP20_PROVIDER_LEASE_LOST", "top20 artifact provider revision is stale", 409);
    }
    if (job.state === "collecting") {
      try {
        job = await jobStore.transitionJob({
          jobId: job.jobId,
          expectedWorkflowRevision: job.workflowRevision,
          workerId: job.workerId,
          nextState: "artifact_received",
          artifactHash,
          now: now()
        });
      } catch (error) {
        if (error?.code !== "COLLECTION_JOB_REVISION_CONFLICT") throw error;
        const latest = await readJob(job.jobId);
        if (!latest || latest.state !== "artifact_received" || latest.artifactHash !== artifactHash) throw error;
        job = latest;
      }
    }
    if (!["artifact_received", "validated", "effects_applied"].includes(job.state)) {
      throw fail("COLLECTION_WORKER_V2_TOP20_FINALIZE_CONFLICT", "top20 artifact receipt is invalid", 409);
    }

    const providerState = await settleProviderArtifact(summary, artifactHash);
    const detailProviderState = await settleDetailProviderArtifact(summary, artifactHash);
    if (summary.status !== "ready") {
      const nextState = summary.status === "blocked" ? "blocked" : "failed";
      const failureCode = summary.status === "blocked"
        ? "NAVER_ACCESS_BLOCKED"
        : "COLLECTION_WORKER_V2_TOP20_NOT_READY";
      if (job.state !== "artifact_received") {
        throw fail("COLLECTION_WORKER_V2_TOP20_FINALIZE_CONFLICT", "non-ready top20 artifact has invalid state", 409);
      }
      job = await jobStore.transitionJob({
        jobId: job.jobId,
        expectedWorkflowRevision: job.workflowRevision,
        workerId: job.workerId,
        nextState,
        failureCode,
        now: now()
      });
      markPayloadTerminal(job.jobId, nextState);
      safeTop20Log("top20_job_terminal", {
        timestamp: new Date(now()).toISOString(),
        jobId: job.jobId,
        contractHash: job.contractHash,
        executionIdentityHash: job.executionIdentityHash,
        workerCommit: targetWorkerCommit,
        jobState: job.state,
        failureCode
      });
      return finalizationResponse(job, summary, providerState, detailProviderState, artifactHash, null, false);
    }

    if (job.state === "artifact_received") {
      job = await jobStore.transitionJob({
        jobId: job.jobId,
        expectedWorkflowRevision: job.workflowRevision,
        workerId: job.workerId,
        nextState: "validated",
        now: now()
      });
    }
    const receiptId = transactionReceiptId(job, artifactHash);
    let transactionResult = transactionResults.get(receiptId) || null;
    if (job.state === "validated") {
      if (!transactionResult) {
        transactionResult = normalizeTransactionResult(await applyReadyTransaction(Object.freeze({
          receiptId,
          artifactHash,
          signedArtifact: input.body.signedArtifact,
          verifiedArtifact,
          summary,
          job: Object.freeze({ ...job }),
          top20ContractHash: entry.top20ContractHash
        })), receiptId);
        transactionResults.set(receiptId, transactionResult);
      }
      job = await jobStore.transitionJob({
        jobId: job.jobId,
        expectedWorkflowRevision: job.workflowRevision,
        workerId: job.workerId,
        nextState: "effects_applied",
        now: now()
      });
    }
    if (job.state === "effects_applied") {
      job = await jobStore.transitionJob({
        jobId: job.jobId,
        expectedWorkflowRevision: job.workflowRevision,
        workerId: job.workerId,
        nextState: "committed",
        now: now()
      });
    }
    if (job.state !== "committed") {
      throw fail("COLLECTION_WORKER_V2_TOP20_TRANSACTION_INVALID", "top20 transaction did not commit", 500);
    }
    markPayloadTerminal(job.jobId, "committed");
    safeTop20Log("top20_job_terminal", {
      timestamp: new Date(now()).toISOString(),
      jobId: job.jobId,
      contractHash: job.contractHash,
      executionIdentityHash: job.executionIdentityHash,
      workerCommit: targetWorkerCommit,
      jobState: job.state
    });
    return finalizationResponse(job, summary, providerState, detailProviderState, artifactHash, transactionResult, false);
  }

  async function finalize(input = {}) {
    assertReady();
    exactKeys(input.body, FINALIZE_KEYS, "top20 finalize body");
    verifyWorkerAuth(input.signedRequest, input.body, COLLECTION_WORKER_V2_TOP20_FINALIZE_PATH);
    await reconcileFirstUse();
    const jobId = String(input.body.jobId || "");
    const prior = finalizationFlights.get(jobId);
    if (prior) await prior;
    const task = finalizeCore(input);
    finalizationFlights.set(jobId, task);
    try {
      return await task;
    } finally {
      if (finalizationFlights.get(jobId) === task) finalizationFlights.delete(jobId);
    }
  }

  async function settleFailureProvider(body, receiptHash) {
    const expectedRevision = Number(body.providerWorkflowRevision);
    const providerAttemptCount = Number(body.providerAttemptCount);
    const blocked = providerAttemptCount === 1 && SAFE_SUBTYPE_PATTERN.test(String(body.providerFailureSubtype || ""));
    const expectedKind = blocked ? "block" : "release";
    let providerState = await providerStore.read();
    if (providerState.workflowRevision === expectedRevision + 1) {
      if (
        providerState.lastOutcomeKind !== expectedKind
        || providerState.lastOutcomeReceiptHash !== receiptHash
      ) {
        throw fail("COLLECTION_WORKER_V2_TOP20_PROVIDER_FINALIZATION_CONFLICT", "top20 failure provider receipt conflicts", 409);
      }
      return providerState;
    }
    if (providerState.workflowRevision !== expectedRevision || providerState.state !== "probe_allowed") {
      throw fail("COLLECTION_WORKER_V2_TOP20_PROVIDER_FINALIZATION_AMBIGUOUS", "top20 failure provider receipt is ambiguous", 409);
    }
    providerState = blocked
      ? await providerStore.recordBlock({
          expectedWorkflowRevision: expectedRevision,
          outcomeReceiptHash: receiptHash,
          failure: {
            subtype: body.providerFailureSubtype,
            diagnosticId: body.diagnosticId
          },
          now: now()
        })
      : await providerStore.releaseAttempt({
          expectedWorkflowRevision: expectedRevision,
          outcomeReceiptHash: receiptHash,
          now: now()
        });
    return providerState;
  }

  async function recordFailure(input = {}) {
    assertReady();
    exactKeys(input.body, FAILURE_KEYS, "top20 failure body");
    verifyWorkerAuth(input.signedRequest, input.body, COLLECTION_WORKER_V2_TOP20_FAILURE_PATH);
    await reconcileFirstUse();
    const body = input.body;
    if (
      !FAILURE_CODE_PATTERN.test(String(body.code || ""))
      || ![0, 1].includes(Number(body.providerAttemptCount))
      || !Number.isInteger(body.executedCallCount)
      || body.executedCallCount < 0
      || body.executedCallCount > V2_TOP20_CONTRACT.maximumProviderCalls
      || Number(body.providerAttemptCount) === 0 && body.executedCallCount !== 0
      || body.providerFailureSubtype !== null && !SAFE_SUBTYPE_PATTERN.test(String(body.providerFailureSubtype))
      || body.diagnosticId !== null && !DIAGNOSTIC_PATTERN.test(String(body.diagnosticId))
    ) {
      throw fail("COLLECTION_WORKER_V2_TOP20_INPUT_INVALID", "top20 failure receipt is invalid", 400);
    }
    let job = await readJob(body.jobId);
    const entry = job ? payloads.get(job.jobId) : null;
    const receiptHash = failureReceiptHash(body);
    if (
      !job
      || !entry
      || job.workerId !== COLLECTION_WORKER_V2_TOP20_WORKER_ID
      || job.attemptId !== body.attemptId
      || !["collecting", "failure_received", "failed", "cancelled"].includes(job.state)
    ) {
      throw fail("COLLECTION_WORKER_V2_TOP20_FAILURE_CONFLICT", "top20 failure receipt is stale", 409);
    }
    if (job.state === "cancelled") {
      if (job.failureReceiptHash !== receiptHash || job.failureCode !== "COLLECTION_WORKER_V2_TOP20_CANCELLED") {
        throw fail("COLLECTION_WORKER_V2_TOP20_FAILURE_CONFLICT", "top20 cancellation receipt conflicts", 409);
      }
      markPayloadTerminal(job.jobId, "cancelled");
      safeTop20Log("top20_job_terminal", {
        timestamp: new Date(now()).toISOString(),
        jobId: job.jobId,
        contractHash: job.contractHash,
        executionIdentityHash: job.executionIdentityHash,
        workerCommit: targetWorkerCommit,
        jobState: job.state,
        failureCode: job.failureCode
      });
      return Object.freeze({
        status: "cancelled",
        code: job.failureCode,
        jobState: job.state,
        providerAttemptCount: Number(body.providerAttemptCount),
        executedCallCount: body.executedCallCount,
        resultStored: false,
        writeCount: 0,
        replayed: true
      });
    }
    if (job.state === "failed") {
      if (job.failureReceiptHash !== receiptHash || job.failureCode !== body.code) {
        throw fail("COLLECTION_WORKER_V2_TOP20_FAILURE_CONFLICT", "top20 failure receipt conflicts", 409);
      }
      markPayloadTerminal(job.jobId, "failed");
      return Object.freeze({
        status: "failed",
        code: body.code,
        jobState: job.state,
        providerAttemptCount: Number(body.providerAttemptCount),
        executedCallCount: body.executedCallCount,
        resultStored: false,
        writeCount: 0,
        replayed: true
      });
    }
    const cancellationReceipt = job.state === "collecting"
      && job.cancellationRequested === true
      && CANCELLATION_FAILURE_CODES.has(body.code)
      && job.workflowRevision === Number(body.workflowRevision) + 1
      && entry.providerWorkflowRevision === Number(body.providerWorkflowRevision);
    if (cancellationReceipt) {
      assertActiveLease(job);
      await settleFailureProvider(body, receiptHash);
      job = await jobStore.transitionJob({
        jobId: job.jobId,
        expectedWorkflowRevision: job.workflowRevision,
        workerId: job.workerId,
        nextState: "cancelled",
        failureCode: "COLLECTION_WORKER_V2_TOP20_CANCELLED",
        failureReceiptHash: receiptHash,
        providerAttemptCount: Number(body.providerAttemptCount),
        now: now()
      });
      markPayloadTerminal(job.jobId, "cancelled");
      return Object.freeze({
        status: "cancelled",
        code: job.failureCode,
        jobState: job.state,
        providerAttemptCount: Number(body.providerAttemptCount),
        executedCallCount: body.executedCallCount,
        resultStored: false,
        writeCount: 0,
        replayed: false
      });
    }
    if (job.state === "collecting") {
      assertActiveLease(job);
      if (
        job.workflowRevision !== Number(body.workflowRevision)
        || entry.providerWorkflowRevision !== Number(body.providerWorkflowRevision)
      ) {
        throw fail("COLLECTION_WORKER_V2_TOP20_FAILURE_CONFLICT", "top20 failure receipt is stale", 409);
      }
      job = await jobStore.transitionJob({
        jobId: job.jobId,
        expectedWorkflowRevision: job.workflowRevision,
        workerId: job.workerId,
        nextState: "failure_received",
        failureCode: body.code,
        failureReceiptHash: receiptHash,
        providerAttemptCount: Number(body.providerAttemptCount),
        now: now()
      });
    } else if (job.failureReceiptHash !== receiptHash || job.failureCode !== body.code) {
      throw fail("COLLECTION_WORKER_V2_TOP20_FAILURE_CONFLICT", "top20 failure receipt conflicts", 409);
    }
    await settleFailureProvider(body, receiptHash);
    if (job.state === "failure_received") {
      job = await jobStore.transitionJob({
        jobId: job.jobId,
        expectedWorkflowRevision: job.workflowRevision,
        workerId: job.workerId,
        nextState: "failed",
        failureCode: body.code,
        now: now()
      });
    }
    markPayloadTerminal(job.jobId, "failed");
    safeTop20Log("top20_job_terminal", {
      timestamp: new Date(now()).toISOString(),
      jobId: job.jobId,
      contractHash: job.contractHash,
      executionIdentityHash: job.executionIdentityHash,
      workerCommit: targetWorkerCommit,
      jobState: job.state,
      failureCode: body.code
    });
    return Object.freeze({
      status: "failed",
      code: body.code,
      jobState: job.state,
      providerAttemptCount: Number(body.providerAttemptCount),
      executedCallCount: body.executedCallCount,
      resultStored: false,
      writeCount: 0,
      replayed: false
    });
  }

  return Object.freeze({
    claim,
    finalize,
    heartbeat,
    preflight,
    prepare,
    prepareTrustedAdmin,
    prepareDryRunTrustedAdmin,
    recordFailure,
    markTerminalPayload(input = {}) {
      const jobId = String(input.jobId || "");
      const terminalState = String(input.terminalState || "terminal");
      return markPayloadTerminal(jobId, terminalState);
    },
    forgetTerminalPayload(input = {}) {
      return forgetTerminalPayloadEntry(String(input.jobId || ""));
    },
    status() {
      return Object.freeze({
        schemaVersion: COLLECTION_WORKER_V2_TOP20_ORCHESTRATOR_SCHEMA_VERSION,
        enabled,
        externalCallApproved,
        previewWriteApproved,
        targetWorkerCommit: COMMIT_PATTERN.test(targetWorkerCommit) ? targetWorkerCommit : null,
        workerId: COLLECTION_WORKER_V2_TOP20_WORKER_ID,
        workerPoolId: COLLECTION_WORKER_V2_TOP20_WORKER_POOL_ID,
        activePayloadCount: activePayloadCount(),
        retainedTerminalPayloadCount: retainedTerminalPayloadCount(),
        maxProviderAttempts: 1,
        maximumProviderCalls: V2_TOP20_RESILIENCE_MAXIMUM_PROVIDER_CALLS,
        automaticRetry: false,
        automaticFallback: false
      });
    },
    async providerStatus() {
      const [mainPlace, bookingDetail] = await Promise.all([
        providerStore.read(),
        detailProviderStore.read()
      ]);
      return Object.freeze({
        mainPlaceProviderState: mainPlace.state,
        bookingDetailProviderState: bookingDetail.state,
        mainPlaceRetryAt: mainPlace.retryAt || null,
        bookingDetailRetryAt: bookingDetail.retryAt || null,
        mainPlaceFailureSubtype: mainPlace.lastFailureSubtype || null,
        bookingDetailFailureSubtype: bookingDetail.lastFailureSubtype || null
      });
    }
  });
}

module.exports = {
  COLLECTION_WORKER_V2_TOP20_ORCHESTRATOR_SCHEMA_VERSION,
  CollectionWorkerV2Top20OrchestratorError,
  createCollectionWorkerV2Top20Orchestrator,
  failureReceiptHash,
  runtimeIdForCommit,
  transactionReceiptId
};
