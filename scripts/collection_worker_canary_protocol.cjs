"use strict";

const crypto = require("node:crypto");

const COLLECTION_WORKER_CANARY_PROTOCOL_SCHEMA_VERSION = "collection-worker-canary-protocol.v1";
// Stage 16 uses a distinct execution identity so an immutable terminal receipt
// from an earlier Preview canary cannot be mistaken for this environment-parity
// worker. The service-global NAVER circuit remains shared.
const COLLECTION_WORKER_CANARY_WORKER_ID = "collector_worker_v2_env_preview_01";
const COLLECTION_WORKER_CANARY_WORKER_POOL_ID = "collector_pool_v2_env_preview_01";
const COLLECTION_WORKER_CANARY_REQUEST_KEY_ID = "collector_worker_request_v1";
const COLLECTION_WORKER_CANARY_DISPATCH_KEY_ID = "preview_dispatch_v1";
const COLLECTION_WORKER_CANARY_ARTIFACT_KEY_ID = "collector_artifact_v1";
const COLLECTION_WORKER_CANARY_TARGET_SERVICE_ID = "srv-d9q6mrfavr4c73atllf0";
const COLLECTION_WORKER_CANARY_RUNTIME_ID_PREFIX = `runtime:${COLLECTION_WORKER_CANARY_TARGET_SERVICE_ID}:`;
const OPERATOR_TOKEN_HEADER = "x-collector-canary-token";
const PREPARE_PATH = "/api/internal/collection-worker/canary/prepare";
const SIGNED_PREPARE_PATH = "/api/internal/collection-worker/canary/prepare-signed";
const CLAIM_PATH = "/api/internal/collection-worker/jobs/claim";
const PREFLIGHT_PATH = "/api/internal/collection-worker/jobs/preflight";
const FINALIZE_PATH = "/api/internal/collection-worker/results/finalize";
const FAILURE_PATH = "/api/internal/collection-worker/failures";
const ARTIFACT_KEY_PROOF_DOMAIN = "lodging-datalab.collection-worker.artifact-key-proof.v1";
const ARTIFACT_KEY_PROOF_PATTERN = /^[A-Za-z0-9_-]{86}$/u;

function protocolError(code, message, statusCode = 400) {
  return Object.assign(new Error(message), { code, statusCode });
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw protocolError("COLLECTION_WORKER_CANARY_INPUT_INVALID", "non-finite values are forbidden");
  }
  return JSON.stringify(value ?? null);
}

function decodeEd25519Key(value, type) {
  try {
    const encoded = String(value || "");
    const bytes = Buffer.from(encoded, "base64");
    if (!bytes.length || bytes.toString("base64") !== encoded) throw new Error("invalid base64");
    const key = type === "private"
      ? crypto.createPrivateKey({ key: bytes, format: "der", type: "pkcs8" })
      : crypto.createPublicKey({ key: bytes, format: "der", type: "spki" });
    if (key.type !== type || key.asymmetricKeyType !== "ed25519") throw new Error("wrong key type");
    return key;
  } catch {
    throw protocolError("COLLECTION_WORKER_CANARY_KEY_INVALID", "Collection worker canary key is invalid", 500);
  }
}

function artifactKeyProofPayload(input = {}) {
  const payload = {
    schemaVersion: COLLECTION_WORKER_CANARY_PROTOCOL_SCHEMA_VERSION,
    artifactKeyId: COLLECTION_WORKER_CANARY_ARTIFACT_KEY_ID,
    jobId: String(input.jobId || ""),
    attemptId: String(input.attemptId || ""),
    workflowRevision: Number(input.workflowRevision),
    workerId: String(input.workerId || ""),
    workerPoolId: String(input.workerPoolId || ""),
    workerCommit: String(input.workerCommit || ""),
    runtimeId: String(input.runtimeId || ""),
    contractHash: String(input.contractHash || ""),
    executionIdentityHash: String(input.executionIdentityHash || "")
  };
  if (
    !/^job[-_][a-z0-9][a-z0-9_-]{7,95}$/u.test(payload.jobId)
    || !/^[a-z0-9][a-z0-9._:-]{2,127}$/u.test(payload.attemptId)
    || !Number.isInteger(payload.workflowRevision)
    || payload.workflowRevision < 1
    || !/^[a-z0-9][a-z0-9._:-]{2,127}$/u.test(payload.workerId)
    || !/^[a-z0-9][a-z0-9._:-]{2,127}$/u.test(payload.workerPoolId)
    || !/^[a-f0-9]{40}$/u.test(payload.workerCommit)
    || !/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/u.test(payload.runtimeId)
    || !/^[a-f0-9]{64}$/u.test(payload.contractHash)
    || !/^[a-f0-9]{64}$/u.test(payload.executionIdentityHash)
  ) {
    throw protocolError("COLLECTION_WORKER_CANARY_PREFLIGHT_INVALID", "Collection worker artifact key proof input is invalid");
  }
  return Object.freeze(payload);
}

function artifactKeyProofBytes(payload) {
  return Buffer.from(`${ARTIFACT_KEY_PROOF_DOMAIN}\n${stableJson(payload)}`, "utf8");
}

function buildArtifactKeyProof(input, privateKey) {
  const payload = artifactKeyProofPayload(input);
  const signature = crypto.sign(null, artifactKeyProofBytes(payload), privateKey).toString("base64url");
  return Object.freeze({ payload, signature });
}

function verifyArtifactKeyProof(value, expected, publicKey) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw protocolError("COLLECTION_WORKER_CANARY_ARTIFACT_KEY_MISMATCH", "Collection worker artifact key proof is invalid", 401);
  }
  if (Object.keys(value).sort().join(",") !== "payload,signature") {
    throw protocolError("COLLECTION_WORKER_CANARY_ARTIFACT_KEY_MISMATCH", "Collection worker artifact key proof fields are invalid", 401);
  }
  const payload = artifactKeyProofPayload(value.payload);
  const expectedPayload = artifactKeyProofPayload(expected);
  if (stableJson(payload) !== stableJson(expectedPayload)) {
    throw protocolError("COLLECTION_WORKER_CANARY_ARTIFACT_KEY_MISMATCH", "Collection worker artifact key proof identity is invalid", 401);
  }
  const signature = String(value.signature || "");
  if (
    !ARTIFACT_KEY_PROOF_PATTERN.test(signature)
    || !crypto.verify(null, artifactKeyProofBytes(payload), publicKey, Buffer.from(signature, "base64url"))
  ) {
    throw protocolError("COLLECTION_WORKER_CANARY_ARTIFACT_KEY_MISMATCH", "Collection worker artifact key proof verification failed", 401);
  }
  return payload;
}

module.exports = {
  CLAIM_PATH,
  COLLECTION_WORKER_CANARY_ARTIFACT_KEY_ID,
  COLLECTION_WORKER_CANARY_DISPATCH_KEY_ID,
  COLLECTION_WORKER_CANARY_PROTOCOL_SCHEMA_VERSION,
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
  SIGNED_PREPARE_PATH,
  artifactKeyProofPayload,
  buildArtifactKeyProof,
  decodeEd25519Key,
  stableJson,
  verifyArtifactKeyProof
};
