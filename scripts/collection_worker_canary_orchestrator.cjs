"use strict";

const crypto = require("node:crypto");
const {
  COLLECTION_WORKER_JOB_AUDIENCE,
  FIXED_V2_WORKER_RUNTIME_FINGERPRINT,
  buildSignedJobEnvelope
} = require("./collection_worker_contract.cjs");
const {
  buildCollectionWorkerExecutionPayload
} = require("./collection_worker_execution_payload.cjs");
const {
  COLLECTION_WORKER_MODE_PROVIDER_CANARY,
  COLLECTION_WORKER_RESULT_SCHEMA_VERSION,
  normalizeExecutionSummary
} = require("./collection_worker_runtime.cjs");
const {
  verifyCollectionArtifactBundle
} = require("./collection_artifact_contract.cjs");
const {
  decideCollectionArtifactImport
} = require("./collection_artifact_importer.cjs");
const {
  COLLECTION_WORKER_AUTH_AUDIENCE,
  createWorkerNonceRegistry,
  verifySignedWorkerRequest
} = require("./collection_worker_auth.cjs");
const {
  providerAvailability
} = require("./naver_provider_resilience.cjs");
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
  OPERATOR_TOKEN_HEADER,
  PREFLIGHT_PATH,
  PREPARE_PATH,
  decodeEd25519Key,
  stableJson,
  verifyArtifactKeyProof
} = require("./collection_worker_canary_protocol.cjs");

const COLLECTION_WORKER_CANARY_ORCHESTRATOR_SCHEMA_VERSION = "collection-worker-canary-orchestrator.v1";
const {
  V2_ENV_WORKER_PHASE,
  V2_ENV_WORKER_STRATEGY
} = require("./v2_env_worker_contract.cjs");
const {
  assertPrivateExecutionContract
} = require("./v2_env_worker_job_adapter.cjs");
// Keep prior one-shot receipts immutable while giving the V2 environment
// worker its own backend identity. Provider health is still governed by the
// shared naver_place_search circuit store.
const COLLECTION_WORKER_CANARY_BACKEND_ID = "naver_place_first_request_v2_env";
const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const COMMIT_PATTERN = /^[a-f0-9]{40}$/u;
const FAILURE_CODE_PATTERN = /^[A-Z][A-Z0-9_]{2,127}$/u;
const SAFE_SUBTYPE_PATTERN = /^(?:http_403|http_429|challenge_html|unknown_access_block)$/u;
const DIAGNOSTIC_PATTERN = /^crawl-[a-f0-9]{12}$/u;
const PREPARE_CONTRACT_KEYS = Object.freeze([
  "keyword",
  "searchMode",
  "collectionMode",
  "collectionPurpose",
  "productMode",
  "checkIn",
  "checkOut",
  "rankStart",
  "rankEnd",
  "detailRankStart",
  "detailRankEnd"
]);
const CLAIM_BODY_KEYS = Object.freeze(["workerId", "workerPoolId", "workerCommit"]);
const PREFLIGHT_BODY_KEYS = Object.freeze([
  "jobId",
  "attemptId",
  "workflowRevision",
  "workerCommit",
  "runtimeId",
  "artifactKeyProof"
]);
const FINALIZE_BODY_KEYS = Object.freeze([
  "jobId",
  "attemptId",
  "workflowRevision",
  "signedArtifact"
]);
const FAILURE_BODY_KEYS = Object.freeze([
  "jobId",
  "attemptId",
  "workflowRevision",
  "code",
  "providerAttemptCount"
]);
const SUMMARY_DOCUMENT_KEYS = Object.freeze([
  "schemaVersion",
  "contractHash",
  "executionIdentityHash",
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
const SUMMARY_KEYS = Object.freeze([
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
const ARTIFACT_TERMINAL_STATES = new Set(["validated_no_store", "blocked", "failed"]);

class CollectionWorkerCanaryOrchestratorError extends Error {
  constructor(code, message, statusCode = 409, meta = {}) {
    super(message);
    this.name = "CollectionWorkerCanaryOrchestratorError";
    this.code = code;
    this.statusCode = statusCode;
    this.retryAt = meta.retryAt || null;
    this.retryAfterSeconds = meta.retryAfterSeconds ?? null;
  }
}

function fail(code, message, statusCode = 409, meta = {}) {
  return new CollectionWorkerCanaryOrchestratorError(code, message, statusCode, meta);
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw fail("COLLECTION_WORKER_CANARY_INPUT_INVALID", `${label} is invalid`, 400);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw fail("COLLECTION_WORKER_CANARY_INPUT_INVALID", `${label} fields are invalid`, 400);
  }
}

function sha256Hex(value) {
  return crypto.createHash("sha256").update(Buffer.isBuffer(value) ? value : Buffer.from(String(value))).digest("hex");
}

function safeEqualHash(actual, expected) {
  if (!HASH_PATTERN.test(actual) || !HASH_PATTERN.test(expected)) return false;
  return crypto.timingSafeEqual(Buffer.from(actual, "ascii"), Buffer.from(expected, "ascii"));
}

function normalizeOperatorToken(value, expectedHash) {
  const token = String(value || "");
  const actualHash = sha256Hex(token);
  if (token.length < 32 || !safeEqualHash(actualHash, String(expectedHash || ""))) {
    throw fail("COLLECTION_WORKER_CANARY_OPERATOR_UNAUTHORIZED", "Collection worker canary operator is not authorized", 401);
  }
  return actualHash;
}

function canonicalCommit(value, label) {
  const commit = String(value || "").trim();
  if (!COMMIT_PATTERN.test(commit)) {
    throw fail("COLLECTION_WORKER_CANARY_INPUT_INVALID", `${label} is invalid`, 400);
  }
  return commit;
}

function readArtifactSummary(verifiedArtifact, expected) {
  const bundle = verifiedArtifact.bundle;
  if (bundle.fileCount !== 1 || bundle.files.length !== 1 || bundle.files[0].path !== "canary-summary.json") {
    throw fail("COLLECTION_WORKER_CANARY_ARTIFACT_INVALID", "Collection worker canary artifact files are invalid", 400);
  }
  let document;
  try {
    document = JSON.parse(Buffer.from(bundle.files[0].contentBase64, "base64").toString("utf8"));
  } catch {
    throw fail("COLLECTION_WORKER_CANARY_ARTIFACT_INVALID", "Collection worker canary artifact is invalid", 400);
  }
  exactKeys(document, SUMMARY_DOCUMENT_KEYS, "Collection worker canary summary");
  if (
    document.schemaVersion !== COLLECTION_WORKER_RESULT_SCHEMA_VERSION
    || document.contractHash !== expected.contractHash
    || document.executionIdentityHash !== expected.executionIdentityHash
  ) {
    throw fail("COLLECTION_WORKER_CANARY_ARTIFACT_INVALID", "Collection worker canary summary identity is invalid", 409);
  }
  const summary = Object.fromEntries(SUMMARY_KEYS.map((key) => [key, document[key]]));
  return normalizeExecutionSummary(summary, COLLECTION_WORKER_MODE_PROVIDER_CANARY);
}

function retryMeta(state, now = new Date()) {
  const availability = providerAvailability(state, { now });
  return {
    retryAt: availability.retryAt,
    retryAfterSeconds: availability.retryAfterSeconds
  };
}

function terminalStateForSummary(summary) {
  if (summary.status === "ready" && summary.organicCount === 50) return "validated_no_store";
  if (summary.status === "blocked") return "blocked";
  return "failed";
}

function finalizationCodeForSummary(summary) {
  if (summary.status === "blocked") return "NAVER_ACCESS_BLOCKED";
  if (summary.status === "ready" && summary.organicCount === 50) return null;
  return "COLLECTION_WORKER_CANARY_NOT_READY";
}

function assertMatchingTerminalReceipt(job, summary, artifactHash) {
  const expectedState = terminalStateForSummary(summary);
  const expectedFailureCode = finalizationCodeForSummary(summary) || "";
  if (
    job.state !== expectedState
    || job.artifactHash !== artifactHash
    || (expectedFailureCode && job.failureCode !== expectedFailureCode)
  ) {
    throw fail(
      "COLLECTION_WORKER_CANARY_FINALIZE_CONFLICT",
      "Collection worker canary terminal receipt does not match the artifact",
      409
    );
  }
  return job;
}

function providerOutcomeKindForSummary(summary) {
  if (summary.status === "blocked") return "block";
  if (summary.status === "ready" && summary.organicCount === 50) return "success";
  return "release";
}

function failureReceiptHash(body) {
  return sha256Hex(stableJson({
    schemaVersion: "collection-worker-failure-receipt.v1",
    jobId: String(body.jobId || ""),
    attemptId: String(body.attemptId || ""),
    workflowRevision: Number(body.workflowRevision),
    code: String(body.code || ""),
    providerAttemptCount: Number(body.providerAttemptCount)
  }));
}

function assertMatchingFailureReceipt(job, body, receiptHash) {
  if (
    job.failureReceiptHash !== receiptHash
    || job.failureCode !== body.code
    || Number(job.providerAttemptCount) !== Number(body.providerAttemptCount)
  ) {
    throw fail(
      "COLLECTION_WORKER_CANARY_FINALIZE_CONFLICT",
      "Collection worker failure receipt does not match",
      409
    );
  }
  return job;
}

function createCollectionWorkerCanaryOrchestrator(options = {}) {
  const enabled = options.enabled === true;
  const jobStore = options.jobStore;
  const providerStore = options.providerStore;
  const targetWorkerCommit = String(options.targetWorkerCommit || "").trim();
  const payloads = new Map();
  const nonceRegistry = options.nonceRegistry || createWorkerNonceRegistry();
  const now = typeof options.now === "function" ? options.now : () => new Date();
  const dispatchPrivateKey = () => decodeEd25519Key(options.dispatchPrivateKeyBase64, "private");
  const artifactPublicKey = () => decodeEd25519Key(options.artifactPublicKeyBase64, "public");
  const requestPublicKey = () => decodeEd25519Key(options.requestPublicKeyBase64, "public");
  const recoverableJobStates = new Set(["queued", "leased", "collecting"]);
  let reconciliationComplete = false;
  let reconciliationPromise = null;

  function assertReady() {
    if (!enabled) {
      throw fail("COLLECTION_WORKER_CANARY_DISABLED", "Collection worker canary is disabled", 503);
    }
    canonicalCommit(targetWorkerCommit, "target worker commit");
    if (
      !jobStore
      || typeof jobStore.readSnapshot !== "function"
      || typeof jobStore.createOrReuseJob !== "function"
      || typeof jobStore.claimNextJob !== "function"
      || typeof jobStore.transitionJob !== "function"
      || !providerStore
      || typeof providerStore.read !== "function"
      || typeof providerStore.beginAttempt !== "function"
      || typeof providerStore.recordSuccess !== "function"
      || typeof providerStore.recordBlock !== "function"
      || typeof providerStore.releaseAttempt !== "function"
    ) {
      throw fail("COLLECTION_WORKER_CANARY_DEPENDENCY_INVALID", "Collection worker canary dependency is invalid", 500);
    }
  }

  function verifyWorkerAuth(signedRequest, body, path) {
    const verified = verifySignedWorkerRequest(signedRequest, {
      publicKey: requestPublicKey(),
      expectedAudience: COLLECTION_WORKER_AUTH_AUDIENCE,
      expectedWorkerId: COLLECTION_WORKER_CANARY_WORKER_ID,
      expectedWorkerPoolId: COLLECTION_WORKER_CANARY_WORKER_POOL_ID,
      expectedKeyId: COLLECTION_WORKER_CANARY_REQUEST_KEY_ID,
      body: stableJson(body),
      now: now(),
      nonceRegistry
    });
    if (verified.method !== "POST" || verified.path !== path) {
      throw fail("COLLECTION_WORKER_AUTH_SCOPE_INVALID", "Collection worker request route does not match its signature", 403);
    }
    return verified;
  }

  async function settleAbandonedProviderAttempt(job, options = {}) {
    const expectedWorkflowRevision = Number(
      options.providerWorkflowRevision ?? job.providerWorkflowRevision
    );
    const current = await providerStore.read();
    if (
      !Number.isInteger(expectedWorkflowRevision)
      || expectedWorkflowRevision < 0
      || current.state !== "probe_allowed"
      || current.workflowRevision !== expectedWorkflowRevision
    ) {
      return current;
    }
    try {
      if (options.providerAttemptMayHaveStarted === true) {
        return await providerStore.recordBlock({
          expectedWorkflowRevision,
          failure: {
            subtype: "unknown_access_block",
            diagnosticId: null
          },
          now: now()
        });
      }
      return await providerStore.releaseAttempt({
        expectedWorkflowRevision,
        now: now()
      });
    } catch (error) {
      if (error?.code === "NAVER_PROVIDER_WORKFLOW_REVISION_CONFLICT") {
        return providerStore.read();
      }
      throw error;
    }
  }

  async function transitionAbandonedJob(job, failureCode) {
    const snapshot = await jobStore.readSnapshot();
    const current = snapshot.jobs.find((candidate) => candidate.jobId === job.jobId);
    if (!current || !recoverableJobStates.has(current.state)) return current || null;
    try {
      return await jobStore.transitionJob({
        jobId: current.jobId,
        expectedWorkflowRevision: current.workflowRevision,
        nextState: "indeterminate",
        failureCode,
        now: now()
      });
    } catch (error) {
      if (!["COLLECTION_JOB_REVISION_CONFLICT", "COLLECTION_JOB_TRANSITION_INVALID"].includes(error?.code)) {
        throw error;
      }
      const latest = await jobStore.readSnapshot();
      const reconciled = latest.jobs.find((candidate) => candidate.jobId === current.jobId);
      if (!reconciled || !recoverableJobStates.has(reconciled.state)) return reconciled || null;
      throw error;
    }
  }

  async function abandonJob(job, options = {}) {
    await settleAbandonedProviderAttempt(job, options);
    const terminal = await transitionAbandonedJob(
      job,
      options.failureCode || "COLLECTION_WORKER_CANARY_PAYLOAD_UNAVAILABLE"
    );
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
          job.backendId !== COLLECTION_WORKER_CANARY_BACKEND_ID
          || !recoverableJobStates.has(job.state)
          || payloads.has(job.jobId)
        ) continue;
        await abandonJob(job, {
          failureCode: "COLLECTION_WORKER_CANARY_PAYLOAD_UNAVAILABLE",
          providerAttemptMayHaveStarted: job.state !== "queued"
        });
      }
      reconciliationComplete = true;
    })();
    try {
      await reconciliationPromise;
    } finally {
      reconciliationPromise = null;
    }
  }

  async function enforceActiveLease(job, entry) {
    const leaseExpiresAt = Date.parse(String(job.leaseExpiresAt || ""));
    if (Number.isFinite(leaseExpiresAt) && leaseExpiresAt > new Date(now()).getTime()) return;
    await abandonJob(job, {
      failureCode: "COLLECTION_JOB_LEASE_EXPIRED",
      providerAttemptMayHaveStarted: true,
      providerWorkflowRevision: entry?.providerWorkflowRevision
    });
    throw fail(
      "COLLECTION_WORKER_CANARY_LEASE_EXPIRED",
      "Collection worker canary lease expired before finalization",
      409
    );
  }

  async function prepareValidatedContract(contract) {
    assertReady();
    exactKeys(contract, PREPARE_CONTRACT_KEYS, "Collection worker canary contract");
    assertPrivateExecutionContract(contract);
    await reconcileFirstUse();
    const existing = await jobStore.readSnapshot();
    if (existing.jobs.some((job) => job.backendId === COLLECTION_WORKER_CANARY_BACKEND_ID)) {
      throw fail("COLLECTION_WORKER_CANARY_ALREADY_CREATED", "Collection worker canary already exists", 409);
    }

    const createdAt = new Date(now());
    const providerState = await providerStore.read();
    const reservation = await providerStore.beginAttempt({
      expectedWorkflowRevision: providerState.workflowRevision,
      explicit: true,
      now: createdAt
    });
    if (!reservation.allowed) {
      const meta = retryMeta(reservation.state, createdAt);
      throw fail("NAVER_PROVIDER_COOLDOWN_ACTIVE", "NAVER provider is not available for the canary", 503, meta);
    }

    let jobStored = false;
    try {
      const suffix = crypto.randomBytes(8).toString("hex");
      const jobId = `job-canary-${suffix}`;
      const attemptId = `attempt:canary-${suffix}`;
      const approvalId = `approval:canary-${suffix}`;
      const signedJob = buildSignedJobEnvelope({
        jobId,
        attemptId,
        approvalId,
        audience: COLLECTION_WORKER_JOB_AUDIENCE,
        workerId: COLLECTION_WORKER_CANARY_WORKER_ID,
        workerPoolId: COLLECTION_WORKER_CANARY_WORKER_POOL_ID,
        nonce: crypto.randomBytes(18).toString("base64url"),
        contract,
        authorization: {
          enabled: true,
          actualCallsEnabled: true,
          externalCallApproved: true,
          authorizedExecutionCount: 1
        }
      }, {
        privateKey: dispatchPrivateKey(),
        signerKeyId: COLLECTION_WORKER_CANARY_DISPATCH_KEY_ID,
        now: createdAt,
        ttlSeconds: 15 * 60
      });
      const executionPayload = buildCollectionWorkerExecutionPayload({
        jobId,
        attemptId,
        contract
      }, signedJob);
      const storedJob = await jobStore.createOrReuseJob({
        jobId,
        attemptId,
        idempotencyKey: signedJob.idempotencyKey,
        contractHash: signedJob.contractHash,
        executionIdentityHash: signedJob.executionIdentityHash,
        backendId: COLLECTION_WORKER_CANARY_BACKEND_ID,
        backendVersion: targetWorkerCommit,
        workerPoolId: COLLECTION_WORKER_CANARY_WORKER_POOL_ID,
        providerWorkflowRevision: reservation.state.workflowRevision,
        maxProviderCalls: 1,
        now: createdAt
      });
      jobStored = true;
      payloads.set(jobId, {
        signedJob,
        executionPayload,
        providerWorkflowRevision: reservation.state.workflowRevision,
        claimed: false,
        preflighted: false
      });
      return Object.freeze({
        schemaVersion: COLLECTION_WORKER_CANARY_ORCHESTRATOR_SCHEMA_VERSION,
        status: "queued",
        strategy: V2_ENV_WORKER_STRATEGY,
        phase: V2_ENV_WORKER_PHASE,
        jobId,
        contractHash: signedJob.contractHash,
        executionIdentityHash: signedJob.executionIdentityHash,
        workflowRevision: storedJob.workflowRevision,
        providerState: reservation.state.state,
        providerWorkflowRevision: reservation.state.workflowRevision,
        maxProviderAttempts: 1,
        resultWriteApproved: false
      });
    } catch (error) {
      if (!jobStored) {
        await providerStore.releaseAttempt({
          expectedWorkflowRevision: reservation.state.workflowRevision,
          now: new Date(now())
        }).catch(() => {});
      }
      throw error;
    }
  }

  async function prepare(input = {}) {
    normalizeOperatorToken(input.operatorToken, options.operatorTokenSha256);
    return prepareValidatedContract(input.contract);
  }

  async function prepareFromAdminSession(input = {}) {
    return prepareValidatedContract(input.contract);
  }

  async function claim(input = {}) {
    assertReady();
    exactKeys(input.body, CLAIM_BODY_KEYS, "Collection worker claim body");
    verifyWorkerAuth(input.signedRequest, input.body, CLAIM_PATH);
    if (
      input.body.workerId !== COLLECTION_WORKER_CANARY_WORKER_ID
      || input.body.workerPoolId !== COLLECTION_WORKER_CANARY_WORKER_POOL_ID
      || input.body.workerCommit !== targetWorkerCommit
    ) {
      throw fail("COLLECTION_WORKER_CANARY_WORKER_MISMATCH", "Collection worker identity is invalid", 403);
    }
    await reconcileFirstUse();
    const snapshot = await jobStore.readSnapshot();
    const candidate = snapshot.jobs.find((job) => (
      job.state === "queued"
      && job.backendId === COLLECTION_WORKER_CANARY_BACKEND_ID
      && payloads.has(job.jobId)
      && payloads.get(job.jobId).claimed === false
    ));
    if (!candidate) return Object.freeze({ status: "empty", job: null });
    const entry = payloads.get(candidate.jobId);
    let providerState = await providerStore.read();
    if (providerState.workflowRevision !== entry.providerWorkflowRevision || providerState.state !== "probe_allowed") {
      throw fail("COLLECTION_WORKER_CANARY_PROVIDER_LEASE_LOST", "Collection worker provider lease is unavailable", 409);
    }
    let availability = providerAvailability(providerState, { now: now() });
    if (!availability.attemptInFlight) {
      const refreshedReservation = await providerStore.beginAttempt({
        expectedWorkflowRevision: providerState.workflowRevision,
        explicit: true,
        now: now()
      });
      if (!refreshedReservation.allowed) {
        const meta = retryMeta(refreshedReservation.state, now());
        throw fail("NAVER_PROVIDER_COOLDOWN_ACTIVE", "NAVER provider is not available for the canary", 503, meta);
      }
      providerState = refreshedReservation.state;
      entry.providerWorkflowRevision = providerState.workflowRevision;
      availability = providerAvailability(providerState, { now: now() });
    }
    if (!availability.attemptInFlight) {
      throw fail("COLLECTION_WORKER_CANARY_PROVIDER_LEASE_LOST", "Collection worker provider lease is unavailable", 409);
    }
    const leased = await jobStore.claimNextJob({
      jobId: candidate.jobId,
      workerId: COLLECTION_WORKER_CANARY_WORKER_ID,
      workerPoolId: COLLECTION_WORKER_CANARY_WORKER_POOL_ID,
      providerWorkflowRevision: entry.providerWorkflowRevision,
      leaseMs: 2 * 60 * 1000,
      now: now()
    });
    if (!leased) return Object.freeze({ status: "empty", job: null });
    const collecting = await jobStore.transitionJob({
      jobId: leased.jobId,
      expectedWorkflowRevision: leased.workflowRevision,
      workerId: COLLECTION_WORKER_CANARY_WORKER_ID,
      nextState: "collecting",
      now: now()
    });
    entry.claimed = true;
    const result = Object.freeze({
      status: "claimed",
      job: Object.freeze({
        signedJob: entry.signedJob,
        executionPayload: entry.executionPayload,
        workflowRevision: collecting.workflowRevision,
        leaseExpiresAt: collecting.leaseExpiresAt,
        targetWorkerCommit
      })
    });
    entry.executionPayload = null;
    return result;
  }

  async function preflight(input = {}) {
    assertReady();
    exactKeys(input.body, PREFLIGHT_BODY_KEYS, "Collection worker preflight body");
    verifyWorkerAuth(input.signedRequest, input.body, PREFLIGHT_PATH);
    await reconcileFirstUse();
    const snapshot = await jobStore.readSnapshot();
    const job = snapshot.jobs.find((candidate) => candidate.jobId === input.body.jobId);
    const entry = job ? payloads.get(job.jobId) : null;
    if (
      !job
      || !entry
      || job.state !== "collecting"
      || job.workerId !== COLLECTION_WORKER_CANARY_WORKER_ID
      || job.attemptId !== input.body.attemptId
      || job.workflowRevision !== input.body.workflowRevision
      || input.body.workerCommit !== targetWorkerCommit
      || input.body.runtimeId !== `${COLLECTION_WORKER_CANARY_RUNTIME_ID_PREFIX}${targetWorkerCommit.slice(0, 12)}`
    ) {
      throw fail("COLLECTION_WORKER_CANARY_PREFLIGHT_CONFLICT", "Collection worker canary preflight is stale", 409);
    }
    await enforceActiveLease(job, entry);
    verifyArtifactKeyProof(input.body.artifactKeyProof, {
      jobId: job.jobId,
      attemptId: job.attemptId,
      workflowRevision: job.workflowRevision,
      workerId: job.workerId,
      workerPoolId: job.workerPoolId,
      workerCommit: targetWorkerCommit,
      runtimeId: input.body.runtimeId,
      contractHash: job.contractHash,
      executionIdentityHash: job.executionIdentityHash
    }, artifactPublicKey());
    entry.preflighted = true;
    return Object.freeze({
      status: "preflighted",
      jobId: job.jobId,
      workflowRevision: job.workflowRevision,
      providerAttemptCount: 0,
      resultWriteApproved: false
    });
  }

  async function settleProviderFinalization(job, summary, outcomeReceiptHash) {
    const expectedWorkflowRevision = Number(job.providerWorkflowRevision);
    let providerState = await providerStore.read();
    if (!Number.isInteger(expectedWorkflowRevision) || expectedWorkflowRevision < 0) {
      throw fail("COLLECTION_WORKER_CANARY_PROVIDER_LEASE_LOST", "Collection worker provider receipt is invalid", 409);
    }
    if (providerState.workflowRevision < expectedWorkflowRevision) {
      throw fail("COLLECTION_WORKER_CANARY_PROVIDER_LEASE_LOST", "Collection worker provider receipt is stale", 409);
    }
    // Exactly one revision beyond the reserved attempt is the only durable
    // evidence that the provider CAS completed before a previous response or
    // job-store transition was lost. Never treat later, unrelated revisions as
    // this artifact's receipt.
    if (providerState.workflowRevision === expectedWorkflowRevision + 1) {
      const expectedSubtype = SAFE_SUBTYPE_PATTERN.test(String(summary.providerFailureSubtype || ""))
        ? summary.providerFailureSubtype
        : "unknown_access_block";
      const expectedDiagnosticId = DIAGNOSTIC_PATTERN.test(String(summary.diagnosticId || ""))
        ? summary.diagnosticId
        : null;
      const expectedOutcomeKind = providerOutcomeKindForSummary(summary);
      const matchesReceipt = providerState.lastOutcomeKind === expectedOutcomeKind
        && providerState.lastOutcomeReceiptHash === outcomeReceiptHash;
      const matches = matchesReceipt && (summary.status === "blocked"
        ? providerState.state === "open"
          && providerState.lastFailureSubtype === expectedSubtype
          && providerState.lastDiagnosticId === expectedDiagnosticId
        : summary.status === "ready" && summary.organicCount === 50
          ? providerState.state === "closed"
            && providerState.lastSuccessAt === providerState.updatedAt
            && providerState.lastFailureSubtype === null
          : providerState.state !== "probe_allowed");
      if (!matches) {
        throw fail(
          "COLLECTION_WORKER_CANARY_PROVIDER_FINALIZATION_CONFLICT",
          "Collection worker provider receipt does not match the artifact",
          409
        );
      }
      return providerState;
    }
    if (providerState.workflowRevision > expectedWorkflowRevision + 1) {
      throw fail(
        "COLLECTION_WORKER_CANARY_PROVIDER_FINALIZATION_AMBIGUOUS",
        "Collection worker provider receipt is ambiguous",
        409
      );
    }

    providerState = summary.status === "blocked"
      ? await providerStore.recordBlock({
          expectedWorkflowRevision,
          failure: {
            subtype: SAFE_SUBTYPE_PATTERN.test(String(summary.providerFailureSubtype || ""))
              ? summary.providerFailureSubtype
              : "unknown_access_block",
            diagnosticId: DIAGNOSTIC_PATTERN.test(String(summary.diagnosticId || ""))
              ? summary.diagnosticId
              : null
          },
          outcomeReceiptHash,
          now: now()
        })
      : summary.status === "ready" && summary.organicCount === 50
        ? await providerStore.recordSuccess({
            expectedWorkflowRevision,
            outcomeReceiptHash,
            now: now()
          })
        : await providerStore.releaseAttempt({
            expectedWorkflowRevision,
            outcomeReceiptHash,
            now: now()
          });
    return providerState;
  }

  async function settleProviderFailure(job) {
    const expectedWorkflowRevision = Number(job.providerWorkflowRevision);
    const providerAttemptCount = Number(job.providerAttemptCount);
    const outcomeKind = providerAttemptCount === 1 ? "block" : "release";
    let providerState = await providerStore.read();
    if (!Number.isInteger(expectedWorkflowRevision) || expectedWorkflowRevision < 0) {
      throw fail("COLLECTION_WORKER_CANARY_PROVIDER_LEASE_LOST", "Collection worker provider receipt is invalid", 409);
    }
    if (providerState.workflowRevision < expectedWorkflowRevision) {
      throw fail("COLLECTION_WORKER_CANARY_PROVIDER_LEASE_LOST", "Collection worker provider receipt is stale", 409);
    }
    if (providerState.workflowRevision === expectedWorkflowRevision + 1) {
      const matchesReceipt = providerState.lastOutcomeKind === outcomeKind
        && providerState.lastOutcomeReceiptHash === job.failureReceiptHash;
      const matchesOutcome = providerAttemptCount === 1
        ? providerState.state === "open"
          && providerState.lastFailureSubtype === "unknown_access_block"
          && providerState.lastDiagnosticId === null
        : providerState.state !== "probe_allowed";
      if (!matchesReceipt || !matchesOutcome) {
        throw fail(
          "COLLECTION_WORKER_CANARY_PROVIDER_FINALIZATION_CONFLICT",
          "Collection worker provider failure receipt does not match",
          409
        );
      }
      return providerState;
    }
    if (providerState.workflowRevision > expectedWorkflowRevision + 1) {
      throw fail(
        "COLLECTION_WORKER_CANARY_PROVIDER_FINALIZATION_AMBIGUOUS",
        "Collection worker provider failure receipt is ambiguous",
        409
      );
    }
    providerState = providerAttemptCount === 1
      ? await providerStore.recordBlock({
          expectedWorkflowRevision,
          failure: { subtype: "unknown_access_block", diagnosticId: null },
          outcomeReceiptHash: job.failureReceiptHash,
          now: now()
        })
      : await providerStore.releaseAttempt({
          expectedWorkflowRevision,
          outcomeReceiptHash: job.failureReceiptHash,
          now: now()
        });
    return providerState;
  }

  function finalizationResponse(job, summary, providerState, importDecision, replayed) {
    const providerMeta = retryMeta(providerState, now());
    return Object.freeze({
      schemaVersion: COLLECTION_WORKER_CANARY_ORCHESTRATOR_SCHEMA_VERSION,
      status: summary.status,
      code: finalizationCodeForSummary(summary),
      jobId: job.jobId,
      jobState: job.state,
      workflowRevision: job.workflowRevision,
      organicCount: summary.organicCount,
      adCount: summary.adCount,
      observedRankCount: summary.observedRankCount,
      providerFailureSubtype: summary.providerFailureSubtype,
      diagnosticId: summary.diagnosticId,
      providerState: providerState.state,
      retryAt: providerMeta.retryAt,
      retryAfterSeconds: providerMeta.retryAfterSeconds,
      providerAttemptCount: 1,
      executedCallCount: 1,
      artifactDecision: importDecision.decision,
      resultStored: false,
      writeCount: 0,
      replayed: replayed === true
    });
  }

  async function finalize(input = {}) {
    assertReady();
    exactKeys(input.body, FINALIZE_BODY_KEYS, "Collection worker finalize body");
    verifyWorkerAuth(input.signedRequest, input.body, FINALIZE_PATH);
    await reconcileFirstUse();
    const requestedRevision = Number(input.body.workflowRevision);
    if (!Number.isInteger(requestedRevision) || requestedRevision < 1) {
      throw fail("COLLECTION_WORKER_CANARY_FINALIZE_CONFLICT", "Collection worker canary finalization is stale", 409);
    }

    let snapshot = await jobStore.readSnapshot();
    let job = snapshot.jobs.find((candidate) => candidate.jobId === input.body.jobId);
    const entry = job ? payloads.get(job.jobId) : null;
    if (
      !job
      || job.workerId !== COLLECTION_WORKER_CANARY_WORKER_ID
      || job.attemptId !== input.body.attemptId
      || !["collecting", "artifact_received", ...ARTIFACT_TERMINAL_STATES].includes(job.state)
    ) {
      throw fail("COLLECTION_WORKER_CANARY_FINALIZE_CONFLICT", "Collection worker canary finalization is stale", 409);
    }
    if (job.state === "collecting") {
      await enforceActiveLease(job, entry);
      if (!entry || entry.preflighted !== true || job.workflowRevision !== requestedRevision) {
        throw fail("COLLECTION_WORKER_CANARY_FINALIZE_CONFLICT", "Collection worker canary finalization is stale", 409);
      }
    }

    const expectedIdentity = {
      jobId: job.jobId,
      attemptId: job.attemptId,
      workerId: job.workerId,
      workerPoolId: job.workerPoolId,
      runtimeId: `${COLLECTION_WORKER_CANARY_RUNTIME_ID_PREFIX}${targetWorkerCommit.slice(0, 12)}`,
      contractHash: job.contractHash,
      executionIdentityHash: job.executionIdentityHash
    };
    const verifiedArtifact = verifyCollectionArtifactBundle(input.body.signedArtifact, {
      publicKey: artifactPublicKey(),
      expectedIdentity,
      expectedSigningKeyId: COLLECTION_WORKER_CANARY_ARTIFACT_KEY_ID
    });
    const artifactHash = verifiedArtifact.bundle.bundleHash;
    const summary = readArtifactSummary(verifiedArtifact, job);
    const importDecision = decideCollectionArtifactImport({
      signedArtifact: input.body.signedArtifact,
      verifier() {
        return {
          verified: true,
          artifactHash,
          jobId: job.jobId,
          attemptId: job.attemptId,
          workerId: job.workerId,
          workerPoolId: job.workerPoolId,
          contractHash: job.contractHash,
          executionIdentityHash: job.executionIdentityHash,
          resultStatus: summary.status,
          providerAttemptCount: summary.providerAttemptCount
        };
      },
      saveResult: false,
      previewWriteApproved: false
    });

    if (job.artifactHash && job.artifactHash !== artifactHash) {
      throw fail("COLLECTION_WORKER_CANARY_FINALIZE_CONFLICT", "Collection worker canary artifact receipt conflicts", 409);
    }
    if (ARTIFACT_TERMINAL_STATES.has(job.state)) {
      assertMatchingTerminalReceipt(job, summary, artifactHash);
      const providerState = await providerStore.read();
      return finalizationResponse(job, summary, providerState, importDecision, true);
    }

    // The immutable artifact receipt is persisted before touching the provider
    // store. A response loss can therefore replay the same signed artifact
    // without issuing another provider request or applying provider state twice.
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
        snapshot = await jobStore.readSnapshot();
        const latest = snapshot.jobs.find((candidate) => candidate.jobId === input.body.jobId);
        if (!latest || latest.state !== "artifact_received" || latest.artifactHash !== artifactHash) throw error;
        job = latest;
      }
    }
    if (job.state !== "artifact_received" || job.artifactHash !== artifactHash) {
      throw fail("COLLECTION_WORKER_CANARY_FINALIZE_CONFLICT", "Collection worker canary artifact receipt is invalid", 409);
    }

    const providerState = await settleProviderFinalization(job, summary, artifactHash);
    const nextState = terminalStateForSummary(summary);
    const failureCode = finalizationCodeForSummary(summary);
    let terminal;
    try {
      terminal = await jobStore.transitionJob({
        jobId: job.jobId,
        expectedWorkflowRevision: job.workflowRevision,
        workerId: job.workerId,
        nextState,
        failureCode: failureCode || undefined,
        now: now()
      });
    } catch (error) {
      if (!["COLLECTION_JOB_REVISION_CONFLICT", "COLLECTION_JOB_TRANSITION_INVALID"].includes(error?.code)) throw error;
      snapshot = await jobStore.readSnapshot();
      const latest = snapshot.jobs.find((candidate) => candidate.jobId === job.jobId);
      terminal = assertMatchingTerminalReceipt(latest || {}, summary, artifactHash);
    }
    payloads.delete(job.jobId);
    return finalizationResponse(terminal, summary, providerState, importDecision, false);
  }

  async function recordFailure(input = {}) {
    assertReady();
    exactKeys(input.body, FAILURE_BODY_KEYS, "Collection worker failure body");
    verifyWorkerAuth(input.signedRequest, input.body, FAILURE_PATH);
    await reconcileFirstUse();
    if (!FAILURE_CODE_PATTERN.test(String(input.body.code || ""))) {
      throw fail("COLLECTION_WORKER_CANARY_INPUT_INVALID", "Collection worker failure code is invalid", 400);
    }
    let snapshot = await jobStore.readSnapshot();
    let job = snapshot.jobs.find((candidate) => candidate.jobId === input.body.jobId);
    const entry = job ? payloads.get(job.jobId) : null;
    if (
      !job
      || job.workerId !== COLLECTION_WORKER_CANARY_WORKER_ID
      || job.attemptId !== input.body.attemptId
      || !["collecting", "failure_received", "failed"].includes(job.state)
      || ![0, 1].includes(Number(input.body.providerAttemptCount))
    ) {
      throw fail("COLLECTION_WORKER_CANARY_FINALIZE_CONFLICT", "Collection worker failure finalization is stale", 409);
    }
    const receiptHash = failureReceiptHash(input.body);
    if (job.state === "collecting") {
      await enforceActiveLease(job, entry);
      if (!entry || job.workflowRevision !== input.body.workflowRevision) {
        throw fail("COLLECTION_WORKER_CANARY_FINALIZE_CONFLICT", "Collection worker failure finalization is stale", 409);
      }
      try {
        job = await jobStore.transitionJob({
          jobId: job.jobId,
          expectedWorkflowRevision: job.workflowRevision,
          workerId: job.workerId,
          nextState: "failure_received",
          failureCode: input.body.code,
          failureReceiptHash: receiptHash,
          providerAttemptCount: Number(input.body.providerAttemptCount),
          now: now()
        });
      } catch (error) {
        if (error?.code !== "COLLECTION_JOB_REVISION_CONFLICT") throw error;
        snapshot = await jobStore.readSnapshot();
        const latest = snapshot.jobs.find((candidate) => candidate.jobId === input.body.jobId);
        job = assertMatchingFailureReceipt(latest || {}, input.body, receiptHash);
      }
    } else {
      assertMatchingFailureReceipt(job, input.body, receiptHash);
    }
    if (job.state === "failed") {
      const providerState = await providerStore.read();
      return Object.freeze({
        status: "failed",
        code: input.body.code,
        jobState: job.state,
        providerState: providerState.state,
        providerAttemptCount: Number(input.body.providerAttemptCount),
        executedCallCount: Number(input.body.providerAttemptCount),
        resultStored: false,
        writeCount: 0,
        replayed: true
      });
    }
    if (job.state !== "failure_received") {
      throw fail("COLLECTION_WORKER_CANARY_FINALIZE_CONFLICT", "Collection worker failure receipt is invalid", 409);
    }
    const providerState = await settleProviderFailure(job);
    let terminal;
    try {
      terminal = await jobStore.transitionJob({
        jobId: job.jobId,
        expectedWorkflowRevision: job.workflowRevision,
        workerId: job.workerId,
        nextState: "failed",
        failureCode: input.body.code,
        now: now()
      });
    } catch (error) {
      if (!["COLLECTION_JOB_REVISION_CONFLICT", "COLLECTION_JOB_TRANSITION_INVALID"].includes(error?.code)) throw error;
      snapshot = await jobStore.readSnapshot();
      const latest = snapshot.jobs.find((candidate) => candidate.jobId === job.jobId);
      terminal = assertMatchingFailureReceipt(latest || {}, input.body, receiptHash);
      if (terminal.state !== "failed") throw error;
    }
    payloads.delete(job.jobId);
    return Object.freeze({
      status: "failed",
      code: input.body.code,
      jobState: terminal.state,
      providerState: providerState.state,
      providerAttemptCount: Number(input.body.providerAttemptCount),
      executedCallCount: Number(input.body.providerAttemptCount),
      resultStored: false,
      writeCount: 0,
      replayed: false
    });
  }

  return Object.freeze({
    claim,
    finalize,
    preflight,
    prepare,
    prepareFromAdminSession,
    recordFailure,
    status() {
      return Object.freeze({
        schemaVersion: COLLECTION_WORKER_CANARY_ORCHESTRATOR_SCHEMA_VERSION,
        enabled,
        strategy: V2_ENV_WORKER_STRATEGY,
        phase: V2_ENV_WORKER_PHASE,
        targetWorkerCommit: COMMIT_PATTERN.test(targetWorkerCommit) ? targetWorkerCommit : null,
        inMemoryPayloadCount: payloads.size,
        resultWriteApproved: false,
        maxProviderAttempts: 1
      });
    }
  });
}

module.exports = {
  CLAIM_PATH,
  COLLECTION_WORKER_CANARY_ARTIFACT_KEY_ID,
  COLLECTION_WORKER_CANARY_BACKEND_ID,
  COLLECTION_WORKER_CANARY_DISPATCH_KEY_ID,
  COLLECTION_WORKER_CANARY_ORCHESTRATOR_SCHEMA_VERSION,
  COLLECTION_WORKER_CANARY_REQUEST_KEY_ID,
  COLLECTION_WORKER_CANARY_RUNTIME_ID_PREFIX,
  COLLECTION_WORKER_CANARY_TARGET_SERVICE_ID,
  COLLECTION_WORKER_CANARY_WORKER_ID,
  COLLECTION_WORKER_CANARY_WORKER_POOL_ID,
  CollectionWorkerCanaryOrchestratorError,
  FAILURE_PATH,
  FINALIZE_PATH,
  OPERATOR_TOKEN_HEADER,
  PREFLIGHT_PATH,
  PREPARE_PATH,
  createCollectionWorkerCanaryOrchestrator,
  decodeKey: decodeEd25519Key,
  stableJson
};
