"use strict";

const crypto = require("node:crypto");
const path = require("node:path");
const {
  createSecureJsonStore
} = require("./secure_json_store.cjs");

const COLLECTION_JOB_STORE_DOCUMENT_TYPE = "lodging-collection-worker-job-store";
const COLLECTION_JOB_STORE_SCHEMA_VERSION = 1;
const DEFAULT_LEASE_MS = 2 * 60 * 1000;
const JOB_ID_PATTERN = /^job[-_][a-z0-9][a-z0-9_-]{7,95}$/u;
const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const ID_PATTERN = /^[a-z0-9][a-z0-9._:-]{2,127}$/u;
const FAILURE_CODE_PATTERN = /^[A-Z][A-Z0-9_]{2,127}$/u;
const TERMINAL_JOB_STATES = new Set([
  "blocked",
  "failed",
  "rejected",
  "indeterminate",
  "cancelled",
  "committed"
]);
const TRANSITIONS = Object.freeze({
  queued: new Set(["leased", "cancelled"]),
  leased: new Set(["collecting", "cancelled", "indeterminate"]),
  collecting: new Set(["artifact_received", "blocked", "failed", "cancelled", "indeterminate"]),
  artifact_received: new Set(["validated", "rejected"]),
  validated: new Set(["effects_applied", "rejected"]),
  effects_applied: new Set(["committed", "indeterminate"]),
  blocked: new Set(),
  failed: new Set(),
  rejected: new Set(),
  indeterminate: new Set(),
  cancelled: new Set(),
  committed: new Set()
});

class CollectionJobStoreError extends Error {
  constructor(code, message, statusCode = 409) {
    super(message);
    this.name = "CollectionJobStoreError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

function storeError(code, message, statusCode = 409) {
  return new CollectionJobStoreError(code, message, statusCode);
}

function isoInstant(value, label) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw storeError("COLLECTION_JOB_STORE_INPUT_INVALID", `${label} must be a valid instant`, 400);
  }
  return date.toISOString();
}

function nonEmptyId(value, label, pattern = ID_PATTERN) {
  const normalized = String(value || "").trim();
  if (!pattern.test(normalized)) {
    throw storeError("COLLECTION_JOB_STORE_INPUT_INVALID", `${label} is invalid`, 400);
  }
  return normalized;
}

function nonNegativeInteger(value, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) {
    throw storeError("COLLECTION_JOB_STORE_INPUT_INVALID", `${label} is invalid`, 400);
  }
  return number;
}

function boundedProviderCalls(value) {
  const number = nonNegativeInteger(value, "maxProviderCalls");
  if (![0, 1].includes(number)) {
    throw storeError(
      "COLLECTION_JOB_STORE_INPUT_INVALID",
      "maxProviderCalls must be zero for disabled work or one for an approved one-shot job",
      400
    );
  }
  return number;
}

function defaultCollectionJobStore() {
  return {
    documentType: COLLECTION_JOB_STORE_DOCUMENT_TYPE,
    schemaVersion: COLLECTION_JOB_STORE_SCHEMA_VERSION,
    workflowRevision: 0,
    jobs: []
  };
}

function validateStoredJob(job) {
  if (!job || typeof job !== "object" || Array.isArray(job)) return false;
  if (!JOB_ID_PATTERN.test(String(job.jobId || ""))) return false;
  if (!HASH_PATTERN.test(String(job.idempotencyKey || ""))) return false;
  if (!HASH_PATTERN.test(String(job.contractHash || ""))) return false;
  if (!HASH_PATTERN.test(String(job.executionIdentityHash || ""))) return false;
  if (!Object.prototype.hasOwnProperty.call(TRANSITIONS, String(job.state || ""))) return false;
  if (!Number.isInteger(job.workflowRevision) || job.workflowRevision < 1) return false;
  if (!Number.isInteger(job.attemptNo) || job.attemptNo < 0 || job.attemptNo > 1) return false;
  if (!Number.isInteger(job.maxProviderCalls) || ![0, 1].includes(job.maxProviderCalls)) return false;
  if (job.automaticRetry !== false || job.automaticFallback !== false) return false;
  if (job.externalCallOnRead !== false) return false;
  if (!Number.isFinite(Date.parse(String(job.createdAt || "")))) return false;
  if (!Number.isFinite(Date.parse(String(job.updatedAt || "")))) return false;
  if (job.workerId && !ID_PATTERN.test(String(job.workerId))) return false;
  if (job.workerPoolId && !ID_PATTERN.test(String(job.workerPoolId))) return false;
  if (job.attemptId && !ID_PATTERN.test(String(job.attemptId))) return false;
  if (job.leaseExpiresAt && !Number.isFinite(Date.parse(String(job.leaseExpiresAt)))) return false;
  if (job.artifactHash && !HASH_PATTERN.test(String(job.artifactHash))) return false;
  return true;
}

function validateCollectionJobStore(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (value.documentType !== COLLECTION_JOB_STORE_DOCUMENT_TYPE) return false;
  if (value.schemaVersion !== COLLECTION_JOB_STORE_SCHEMA_VERSION) return false;
  if (!Number.isInteger(value.workflowRevision) || value.workflowRevision < 0) return false;
  if (!Array.isArray(value.jobs) || !value.jobs.every(validateStoredJob)) return false;
  const ids = value.jobs.map((job) => job.jobId);
  const keys = value.jobs.map((job) => job.idempotencyKey);
  return new Set(ids).size === ids.length && new Set(keys).size === keys.length;
}

function assertRuntimeTarget(runtimeRoot, filePath) {
  if (!runtimeRoot || !path.isAbsolute(runtimeRoot)) {
    throw new TypeError("collection job store requires an absolute runtime root");
  }
  const root = path.resolve(runtimeRoot);
  const target = path.resolve(filePath || path.join(root, "collector_worker", "jobs.json"));
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new TypeError("collection job store target must stay inside the runtime root");
  }
  return target;
}

function createCollectionJobStore(options = {}) {
  const runtimeRoot = path.resolve(String(options.runtimeRoot || ""));
  const filePath = assertRuntimeTarget(runtimeRoot, options.filePath);
  const secureStore = options.store || createSecureJsonStore(options.storeDependencies || {});
  const defaultLeaseMs = Number.isInteger(options.defaultLeaseMs) && options.defaultLeaseMs > 0
    ? options.defaultLeaseMs
    : DEFAULT_LEASE_MS;
  const storeOptions = {
    defaultValue: defaultCollectionJobStore,
    validator: validateCollectionJobStore
  };

  async function readSnapshot() {
    return secureStore.readJsonFile(filePath, storeOptions);
  }

  async function createOrReuseJob(input = {}) {
    const now = isoInstant(input.now || new Date(), "now");
    const normalized = {
      jobId: nonEmptyId(input.jobId, "jobId", JOB_ID_PATTERN),
      idempotencyKey: nonEmptyId(input.idempotencyKey, "idempotencyKey", HASH_PATTERN),
      contractHash: nonEmptyId(input.contractHash, "contractHash", HASH_PATTERN),
      executionIdentityHash: nonEmptyId(input.executionIdentityHash, "executionIdentityHash", HASH_PATTERN),
      backendId: nonEmptyId(input.backendId, "backendId"),
      backendVersion: nonEmptyId(input.backendVersion, "backendVersion"),
      workerPoolId: nonEmptyId(input.workerPoolId, "workerPoolId"),
      maxProviderCalls: boundedProviderCalls(input.maxProviderCalls)
    };
    let selected = null;
    await secureStore.updateJsonFile(filePath, (store) => {
      const existingByKey = store.jobs.find((job) => job.idempotencyKey === normalized.idempotencyKey);
      if (existingByKey) {
        if (
          existingByKey.contractHash !== normalized.contractHash
          || existingByKey.executionIdentityHash !== normalized.executionIdentityHash
          || existingByKey.backendId !== normalized.backendId
          || existingByKey.backendVersion !== normalized.backendVersion
          || existingByKey.workerPoolId !== normalized.workerPoolId
        ) {
          throw storeError("COLLECTION_JOB_IDEMPOTENCY_CONFLICT", "collection job idempotency key conflicts with an existing job");
        }
        selected = existingByKey;
        return store;
      }
      if (store.jobs.some((job) => job.jobId === normalized.jobId)) {
        throw storeError("COLLECTION_JOB_ID_CONFLICT", "collection job ID already exists");
      }
      store.workflowRevision += 1;
      selected = {
        ...normalized,
        state: "queued",
        workflowRevision: 1,
        attemptNo: 0,
        attemptId: "",
        workerId: "",
        leaseExpiresAt: "",
        artifactHash: "",
        failureCode: "",
        cancellationRequested: false,
        automaticRetry: false,
        automaticFallback: false,
        externalCallOnRead: false,
        createdAt: now,
        updatedAt: now
      };
      store.jobs.push(selected);
      return store;
    }, storeOptions);
    return structuredClone(selected);
  }

  async function claimNextJob(input = {}) {
    const now = isoInstant(input.now || new Date(), "now");
    const workerId = nonEmptyId(input.workerId, "workerId");
    const workerPoolId = nonEmptyId(input.workerPoolId, "workerPoolId");
    const leaseMs = Number.isInteger(input.leaseMs) && input.leaseMs > 0 ? input.leaseMs : defaultLeaseMs;
    let claimed = null;
    await secureStore.updateJsonFile(filePath, (store) => {
      const job = store.jobs.find((candidate) => candidate.state === "queued" && candidate.workerPoolId === workerPoolId);
      if (!job) return store;
      job.state = "leased";
      job.workerId = workerId;
      job.attemptNo = 1;
      job.attemptId = `attempt:${crypto.randomUUID()}`;
      job.leaseExpiresAt = new Date(Date.parse(now) + leaseMs).toISOString();
      job.workflowRevision += 1;
      job.updatedAt = now;
      store.workflowRevision += 1;
      claimed = job;
      return store;
    }, storeOptions);
    return claimed ? structuredClone(claimed) : null;
  }

  async function transitionJob(input = {}) {
    const jobId = nonEmptyId(input.jobId, "jobId", JOB_ID_PATTERN);
    const nextState = String(input.nextState || "");
    const expectedWorkflowRevision = nonNegativeInteger(input.expectedWorkflowRevision, "expectedWorkflowRevision");
    const now = isoInstant(input.now || new Date(), "now");
    let updated = null;
    await secureStore.updateJsonFile(filePath, (store) => {
      const job = store.jobs.find((candidate) => candidate.jobId === jobId);
      if (!job) throw storeError("COLLECTION_JOB_NOT_FOUND", "collection job was not found", 404);
      if (job.workflowRevision !== expectedWorkflowRevision) {
        throw storeError("COLLECTION_JOB_REVISION_CONFLICT", "collection job workflow revision is stale", 409);
      }
      if (!TRANSITIONS[job.state]?.has(nextState)) {
        throw storeError("COLLECTION_JOB_TRANSITION_INVALID", `collection job cannot transition from ${job.state} to ${nextState}`, 409);
      }
      if (input.workerId && job.workerId !== nonEmptyId(input.workerId, "workerId")) {
        throw storeError("COLLECTION_JOB_WORKER_MISMATCH", "collection job worker does not match", 403);
      }
      job.state = nextState;
      job.workflowRevision += 1;
      job.updatedAt = now;
      if (input.artifactHash) job.artifactHash = nonEmptyId(input.artifactHash, "artifactHash", HASH_PATTERN);
      if (input.failureCode) job.failureCode = nonEmptyId(input.failureCode, "failureCode", FAILURE_CODE_PATTERN);
      if (TERMINAL_JOB_STATES.has(nextState)) job.leaseExpiresAt = "";
      store.workflowRevision += 1;
      updated = job;
      return store;
    }, storeOptions);
    return structuredClone(updated);
  }

  async function heartbeatJob(input = {}) {
    const leaseMs = Number.isInteger(input.leaseMs) && input.leaseMs > 0 ? input.leaseMs : defaultLeaseMs;
    const now = isoInstant(input.now || new Date(), "now");
    const jobId = nonEmptyId(input.jobId, "jobId", JOB_ID_PATTERN);
    const expectedWorkflowRevision = nonNegativeInteger(input.expectedWorkflowRevision, "expectedWorkflowRevision");
    let heartbeat = null;
    await secureStore.updateJsonFile(filePath, (store) => {
      const job = store.jobs.find((candidate) => candidate.jobId === jobId);
      if (!job) throw storeError("COLLECTION_JOB_NOT_FOUND", "collection job was not found", 404);
      if (job.workflowRevision !== expectedWorkflowRevision) {
        throw storeError("COLLECTION_JOB_REVISION_CONFLICT", "collection job workflow revision is stale", 409);
      }
      if (job.workerId !== nonEmptyId(input.workerId, "workerId")) {
        throw storeError("COLLECTION_JOB_WORKER_MISMATCH", "collection job worker does not match", 403);
      }
      if (!["leased", "collecting"].includes(job.state)) {
        throw storeError("COLLECTION_JOB_HEARTBEAT_INVALID", "collection job cannot accept a heartbeat", 409);
      }
      job.leaseExpiresAt = new Date(Date.parse(now) + leaseMs).toISOString();
      job.workflowRevision += 1;
      job.updatedAt = now;
      store.workflowRevision += 1;
      heartbeat = job;
      return store;
    }, storeOptions);
    return structuredClone(heartbeat);
  }

  async function requestCancellation(input = {}) {
    const jobId = nonEmptyId(input.jobId, "jobId", JOB_ID_PATTERN);
    const expectedWorkflowRevision = nonNegativeInteger(input.expectedWorkflowRevision, "expectedWorkflowRevision");
    const now = isoInstant(input.now || new Date(), "now");
    let updated = null;
    await secureStore.updateJsonFile(filePath, (store) => {
      const job = store.jobs.find((candidate) => candidate.jobId === jobId);
      if (!job) throw storeError("COLLECTION_JOB_NOT_FOUND", "collection job was not found", 404);
      if (job.workflowRevision !== expectedWorkflowRevision) {
        throw storeError("COLLECTION_JOB_REVISION_CONFLICT", "collection job workflow revision is stale", 409);
      }
      if (TERMINAL_JOB_STATES.has(job.state)) {
        throw storeError("COLLECTION_JOB_TRANSITION_INVALID", "terminal collection job cannot be cancelled", 409);
      }
      job.cancellationRequested = true;
      job.workflowRevision += 1;
      job.updatedAt = now;
      store.workflowRevision += 1;
      updated = job;
      return store;
    }, storeOptions);
    return structuredClone(updated);
  }

  async function expireWorkerLeases(input = {}) {
    const now = isoInstant(input.now || new Date(), "now");
    const expired = [];
    await secureStore.updateJsonFile(filePath, (store) => {
      for (const job of store.jobs) {
        if (!["leased", "collecting"].includes(job.state)) continue;
        if (!job.leaseExpiresAt || Date.parse(job.leaseExpiresAt) > Date.parse(now)) continue;
        job.state = "indeterminate";
        job.failureCode = "COLLECTION_JOB_LEASE_EXPIRED";
        job.leaseExpiresAt = "";
        job.workflowRevision += 1;
        job.updatedAt = now;
        store.workflowRevision += 1;
        expired.push(structuredClone(job));
      }
      return store;
    }, storeOptions);
    return expired;
  }

  return Object.freeze({
    filePath,
    createOrReuseJob,
    claimNextJob,
    expireWorkerLeases,
    heartbeatJob,
    readSnapshot,
    requestCancellation,
    transitionJob
  });
}

module.exports = {
  COLLECTION_JOB_STORE_DOCUMENT_TYPE,
  COLLECTION_JOB_STORE_SCHEMA_VERSION,
  CollectionJobStoreError,
  TERMINAL_JOB_STATES,
  TRANSITIONS,
  createCollectionJobStore,
  defaultCollectionJobStore,
  validateCollectionJobStore
};
