"use strict";

const crypto = require("node:crypto");
const path = require("node:path");
const { createSecureJsonStore } = require("./secure_json_store.cjs");

const COLLECTION_IMPORT_LEDGER_DOCUMENT_TYPE = "lodging-collection-artifact-import-ledger";
const COLLECTION_IMPORT_LEDGER_SCHEMA_VERSION = 1;
const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const JOB_ID_PATTERN = /^job[-_][a-z0-9][a-z0-9_-]{7,95}$/u;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/u;
const RESULT_STATUSES = new Set(["ready", "zero", "partial", "blocked", "failed"]);
const IMPORT_STATES = Object.freeze({
  prepared: new Set(["validated", "rejected"]),
  validated: new Set(["effects_applied", "rejected"]),
  effects_applied: new Set(["committed", "indeterminate"]),
  committed: new Set(),
  rejected: new Set(),
  indeterminate: new Set()
});

class CollectionArtifactImportError extends Error {
  constructor(code, message, statusCode = 409) {
    super(message);
    this.name = "CollectionArtifactImportError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

function importError(code, message, statusCode = 409) {
  return new CollectionArtifactImportError(code, message, statusCode);
}

function instant(value, label) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw importError("COLLECTION_ARTIFACT_IMPORT_INVALID", `${label} is invalid`, 400);
  }
  return date.toISOString();
}

function expectedText(value, pattern, label) {
  const text = String(value || "").trim();
  if (!pattern.test(text)) {
    throw importError("COLLECTION_ARTIFACT_IMPORT_INVALID", `${label} is invalid`, 400);
  }
  return text;
}

function defaultImportLedger() {
  return {
    documentType: COLLECTION_IMPORT_LEDGER_DOCUMENT_TYPE,
    schemaVersion: COLLECTION_IMPORT_LEDGER_SCHEMA_VERSION,
    workflowRevision: 0,
    imports: []
  };
}

function validateImportEntry(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
  if (!HASH_PATTERN.test(String(entry.importId || ""))) return false;
  if (!HASH_PATTERN.test(String(entry.artifactHash || ""))) return false;
  if (!JOB_ID_PATTERN.test(String(entry.jobId || ""))) return false;
  if (!Object.prototype.hasOwnProperty.call(IMPORT_STATES, String(entry.state || ""))) return false;
  if (!Number.isInteger(entry.workflowRevision) || entry.workflowRevision < 1) return false;
  if (!/^preview-run-[a-f0-9]{20}$/u.test(String(entry.previewRunId || ""))) return false;
  if (!String(entry.stagingRelativePath || "").startsWith("imports/pending/")) return false;
  if (!String(entry.finalRelativePath || "").startsWith("outputs/")) return false;
  if (!Number.isFinite(Date.parse(String(entry.createdAt || "")))) return false;
  if (!Number.isFinite(Date.parse(String(entry.updatedAt || "")))) return false;
  return true;
}

function validateImportLedger(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (value.documentType !== COLLECTION_IMPORT_LEDGER_DOCUMENT_TYPE) return false;
  if (value.schemaVersion !== COLLECTION_IMPORT_LEDGER_SCHEMA_VERSION) return false;
  if (!Number.isInteger(value.workflowRevision) || value.workflowRevision < 0) return false;
  if (!Array.isArray(value.imports) || !value.imports.every(validateImportEntry)) return false;
  const importIds = value.imports.map((entry) => entry.importId);
  const jobs = value.imports.map((entry) => entry.jobId);
  return new Set(importIds).size === importIds.length && new Set(jobs).size === jobs.length;
}

function assertInsideRuntime(runtimeRoot, filePath) {
  if (!runtimeRoot || !path.isAbsolute(runtimeRoot)) {
    throw new TypeError("collection artifact importer requires an absolute runtime root");
  }
  const root = path.resolve(runtimeRoot);
  const target = path.resolve(filePath || path.join(root, "collector_worker", "imports.json"));
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new TypeError("collection artifact import ledger must stay inside the runtime root");
  }
  return target;
}

function rejectRemoteStorageIdentity(value) {
  const forbidden = new Set(["outputDir", "runId", "stagingDir", "finalDir", "absolutePath"]);
  const visit = (node) => {
    if (!node || typeof node !== "object") return;
    for (const [key, child] of Object.entries(node)) {
      if (forbidden.has(key)) {
        throw importError(
          "COLLECTION_ARTIFACT_REMOTE_IDENTITY_FORBIDDEN",
          `worker supplied storage identity is forbidden: ${key}`,
          400
        );
      }
      visit(child);
    }
  };
  visit(value);
}

function normalizeVerification(value) {
  if (!value || typeof value !== "object" || value.verified !== true) {
    throw importError("COLLECTION_ARTIFACT_VERIFICATION_REQUIRED", "artifact must be cryptographically verified", 403);
  }
  const providerAttemptCount = Number(value.providerAttemptCount ?? 0);
  const resultStatus = String(value.resultStatus || value.status || "").trim();
  if (!Number.isInteger(providerAttemptCount) || ![0, 1].includes(providerAttemptCount)) {
    throw importError("COLLECTION_ARTIFACT_IMPORT_INVALID", "providerAttemptCount is invalid", 400);
  }
  if (!RESULT_STATUSES.has(resultStatus)) {
    throw importError("COLLECTION_ARTIFACT_IMPORT_INVALID", "resultStatus is invalid", 400);
  }
  return {
    verified: true,
    artifactHash: expectedText(value.artifactHash, HASH_PATTERN, "artifactHash"),
    jobId: expectedText(value.jobId, JOB_ID_PATTERN, "jobId"),
    attemptId: expectedText(value.attemptId, ID_PATTERN, "attemptId"),
    workerId: expectedText(value.workerId, ID_PATTERN, "workerId"),
    workerPoolId: expectedText(value.workerPoolId, ID_PATTERN, "workerPoolId"),
    contractHash: expectedText(value.contractHash, HASH_PATTERN, "contractHash"),
    executionIdentityHash: expectedText(value.executionIdentityHash, HASH_PATTERN, "executionIdentityHash"),
    resultStatus,
    providerAttemptCount
  };
}

function decideCollectionArtifactImport(input = {}) {
  rejectRemoteStorageIdentity(input.signedArtifact);
  if (typeof input.verifier !== "function") {
    throw importError("COLLECTION_ARTIFACT_VERIFIER_REQUIRED", "artifact verifier is required", 500);
  }
  const verification = normalizeVerification(input.verifier(input.signedArtifact, input.files || {}));
  const saveResult = input.saveResult === true;
  const previewWriteApproved = input.previewWriteApproved === true;
  if (!saveResult || !previewWriteApproved) {
    return Object.freeze({
      decision: "validated_no_store",
      saveResult: false,
      previewWriteApproved,
      artifactHash: verification.artifactHash,
      jobId: verification.jobId,
      verification
    });
  }
  if (verification.resultStatus !== "ready") {
    throw importError("COLLECTION_ARTIFACT_NOT_READY", "only a ready artifact may be imported", 409);
  }
  return Object.freeze({
    decision: "prepare_import",
    saveResult: true,
    previewWriteApproved: true,
    artifactHash: verification.artifactHash,
    jobId: verification.jobId,
    verification
  });
}

function createCollectionArtifactImporter(options = {}) {
  const runtimeRoot = path.resolve(String(options.runtimeRoot || ""));
  const ledgerPath = assertInsideRuntime(runtimeRoot, options.ledgerPath);
  const secureStore = options.store || createSecureJsonStore(options.storeDependencies || {});
  const storeOptions = {
    defaultValue: defaultImportLedger,
    validator: validateImportLedger
  };

  async function readLedger() {
    return secureStore.readJsonFile(ledgerPath, storeOptions);
  }

  async function prepareVerifiedImport(input = {}) {
    const verification = normalizeVerification(input.verification);
    if (input.previewWriteApproved !== true || input.saveResult !== true) {
      throw importError("COLLECTION_ARTIFACT_WRITE_NOT_APPROVED", "Preview artifact import is not approved", 403);
    }
    if (verification.resultStatus !== "ready") {
      throw importError("COLLECTION_ARTIFACT_NOT_READY", "only a ready artifact may be imported", 409);
    }
    const now = instant(input.now || new Date(), "now");
    const importId = crypto.createHash("sha256")
      .update(`collection-import\0${verification.jobId}\0${verification.artifactHash}`)
      .digest("hex");
    const previewRunId = `preview-run-${importId.slice(0, 20)}`;
    let prepared = null;
    await secureStore.updateJsonFile(ledgerPath, (ledger) => {
      const existing = ledger.imports.find((entry) => entry.jobId === verification.jobId);
      if (existing) {
        if (existing.artifactHash !== verification.artifactHash) {
          throw importError(
            "COLLECTION_ARTIFACT_JOB_CONFLICT",
            "the collection job already has a different artifact",
            409
          );
        }
        prepared = { ...existing, reused: true };
        return ledger;
      }
      ledger.workflowRevision += 1;
      prepared = {
        importId,
        artifactHash: verification.artifactHash,
        jobId: verification.jobId,
        attemptId: verification.attemptId,
        workerId: verification.workerId,
        workerPoolId: verification.workerPoolId,
        contractHash: verification.contractHash,
        executionIdentityHash: verification.executionIdentityHash,
        state: "prepared",
        workflowRevision: 1,
        previewRunId,
        stagingRelativePath: `imports/pending/${importId}`,
        finalRelativePath: `outputs/${previewRunId}`,
        createdAt: now,
        updatedAt: now
      };
      ledger.imports.push(prepared);
      return ledger;
    }, storeOptions);
    return structuredClone(prepared);
  }

  async function transitionImport(input = {}) {
    const importId = expectedText(input.importId, HASH_PATTERN, "importId");
    const expectedWorkflowRevision = Number(input.expectedWorkflowRevision);
    if (!Number.isInteger(expectedWorkflowRevision) || expectedWorkflowRevision < 1) {
      throw importError("COLLECTION_ARTIFACT_IMPORT_INVALID", "expectedWorkflowRevision is invalid", 400);
    }
    const nextState = String(input.nextState || "");
    const now = instant(input.now || new Date(), "now");
    let updated = null;
    await secureStore.updateJsonFile(ledgerPath, (ledger) => {
      const entry = ledger.imports.find((candidate) => candidate.importId === importId);
      if (!entry) throw importError("COLLECTION_ARTIFACT_IMPORT_NOT_FOUND", "artifact import was not found", 404);
      if (entry.workflowRevision !== expectedWorkflowRevision) {
        throw importError("COLLECTION_ARTIFACT_IMPORT_REVISION_CONFLICT", "artifact import revision is stale", 409);
      }
      if (!IMPORT_STATES[entry.state]?.has(nextState)) {
        throw importError(
          "COLLECTION_ARTIFACT_IMPORT_TRANSITION_INVALID",
          `artifact import cannot transition from ${entry.state} to ${nextState}`,
          409
        );
      }
      entry.state = nextState;
      entry.workflowRevision += 1;
      entry.updatedAt = now;
      ledger.workflowRevision += 1;
      updated = entry;
      return ledger;
    }, storeOptions);
    return structuredClone(updated);
  }

  return Object.freeze({
    ledgerPath,
    prepareVerifiedImport,
    readLedger,
    transitionImport
  });
}

module.exports = {
  COLLECTION_IMPORT_LEDGER_DOCUMENT_TYPE,
  COLLECTION_IMPORT_LEDGER_SCHEMA_VERSION,
  CollectionArtifactImportError,
  IMPORT_STATES,
  createCollectionArtifactImporter,
  decideCollectionArtifactImport,
  defaultImportLedger,
  rejectRemoteStorageIdentity,
  validateImportLedger
};
