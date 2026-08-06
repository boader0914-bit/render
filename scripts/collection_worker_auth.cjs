"use strict";

const crypto = require("node:crypto");

const COLLECTION_WORKER_AUTH_SCHEMA_VERSION = "collection-worker-request-auth.v1";
const COLLECTION_WORKER_AUTH_AUDIENCE = "lodging-datalab-preview.internal-worker";
const COLLECTION_WORKER_AUTH_DOMAIN = "lodging-datalab.collection-worker.request.v1";
const COLLECTION_WORKER_AUTH_MAX_AGE_SECONDS = 60;
const COLLECTION_WORKER_AUTH_CLOCK_SKEW_SECONDS = 15;
const SIGNATURE_PATTERN = /^[A-Za-z0-9_-]{86}$/u;
const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const SAFE_ID_PATTERN = /^[a-z0-9][a-z0-9._:-]{2,127}$/u;
const NONCE_PATTERN = /^[A-Za-z0-9_-]{16,128}$/u;
const ALLOWED_PATH_SCOPES = Object.freeze({
  "/api/internal/collection-worker/jobs/claim": "collection:claim",
  "/api/internal/collection-worker/jobs/preflight": "collection:preflight",
  "/api/internal/collection-worker/jobs/heartbeat": "collection:heartbeat",
  "/api/internal/collection-worker/artifacts": "collection:artifact:write",
  "/api/internal/collection-worker/failures": "collection:failure:write",
  "/api/internal/collection-worker/results/finalize": "collection:result:finalize"
});

class CollectionWorkerAuthError extends Error {
  constructor(code, message, statusCode = 401) {
    super(message);
    this.name = "CollectionWorkerAuthError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

function authError(code, message, statusCode = 401) {
  return new CollectionWorkerAuthError(code, message, statusCode);
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw authError("COLLECTION_WORKER_AUTH_INVALID", "worker request contains an invalid number", 400);
  }
  return JSON.stringify(value);
}

function sha256Hex(value) {
  return crypto.createHash("sha256").update(Buffer.isBuffer(value) ? value : Buffer.from(String(value))).digest("hex");
}

function safeId(value, label) {
  const text = String(value || "").trim();
  if (!SAFE_ID_PATTERN.test(text)) throw authError("COLLECTION_WORKER_AUTH_INVALID", `${label} is invalid`, 400);
  return text;
}

function safeInstant(value, label) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw authError("COLLECTION_WORKER_AUTH_INVALID", `${label} is invalid`, 400);
  return date.toISOString();
}

function normalizeMethod(value) {
  const method = String(value || "").toUpperCase();
  if (method !== "POST") throw authError("COLLECTION_WORKER_AUTH_INVALID", "worker request method is invalid", 400);
  return method;
}

function normalizePath(value) {
  const requestPath = String(value || "");
  if (!Object.prototype.hasOwnProperty.call(ALLOWED_PATH_SCOPES, requestPath)) {
    throw authError("COLLECTION_WORKER_AUTH_SCOPE_INVALID", "worker request path is not allowed", 403);
  }
  return requestPath;
}

function normalizeScope(value, requestPath) {
  const scope = String(value || "").trim();
  if (scope !== ALLOWED_PATH_SCOPES[requestPath]) {
    throw authError("COLLECTION_WORKER_AUTH_SCOPE_INVALID", "worker request scope is not allowed", 403);
  }
  return scope;
}

function normalizeBodyHash(value) {
  const hash = String(value || "");
  if (!HASH_PATTERN.test(hash)) throw authError("COLLECTION_WORKER_AUTH_INVALID", "worker request body hash is invalid", 400);
  return hash;
}

function normalizeNonce(value) {
  const nonce = String(value || "");
  if (!NONCE_PATTERN.test(nonce)) throw authError("COLLECTION_WORKER_AUTH_INVALID", "worker request nonce is invalid", 400);
  return nonce;
}

function normalizeUnsignedRequest(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw authError("COLLECTION_WORKER_AUTH_INVALID", "worker request identity is invalid", 400);
  }
  const requestPath = normalizePath(input.path);
  return Object.freeze({
    schemaVersion: COLLECTION_WORKER_AUTH_SCHEMA_VERSION,
    audience: String(input.audience || COLLECTION_WORKER_AUTH_AUDIENCE),
    workerId: safeId(input.workerId, "workerId"),
    workerPoolId: safeId(input.workerPoolId, "workerPoolId"),
    keyId: safeId(input.keyId, "keyId"),
    method: normalizeMethod(input.method),
    path: requestPath,
    scope: normalizeScope(input.scope, requestPath),
    issuedAt: safeInstant(input.issuedAt || new Date(), "issuedAt"),
    nonce: normalizeNonce(input.nonce),
    bodySha256: normalizeBodyHash(input.bodySha256)
  });
}

function signatureBytes(value) {
  return Buffer.from(`${COLLECTION_WORKER_AUTH_DOMAIN}\n${stableJson(value)}`, "utf8");
}

function privateEd25519(value) {
  try {
    const key = value instanceof crypto.KeyObject ? value : crypto.createPrivateKey(value);
    if (key.type !== "private" || key.asymmetricKeyType !== "ed25519") throw new Error("wrong key");
    return key;
  } catch {
    throw authError("COLLECTION_WORKER_AUTH_KEY_INVALID", "worker request signing key is invalid", 500);
  }
}

function publicEd25519(value) {
  try {
    const key = value instanceof crypto.KeyObject && value.type === "public" ? value : crypto.createPublicKey(value);
    if (key.type !== "public" || key.asymmetricKeyType !== "ed25519") throw new Error("wrong key");
    return key;
  } catch {
    throw authError("COLLECTION_WORKER_AUTH_KEY_INVALID", "worker request verification key is invalid", 500);
  }
}

function buildSignedWorkerRequest(input = {}, options = {}) {
  const request = normalizeUnsignedRequest(input);
  const signature = crypto.sign(null, signatureBytes(request), privateEd25519(options.privateKey)).toString("base64url");
  return Object.freeze({ request, signature });
}

function createWorkerNonceRegistry(options = {}) {
  const maxEntries = Number.isInteger(options.maxEntries) && options.maxEntries > 0 ? options.maxEntries : 2048;
  const now = typeof options.now === "function" ? options.now : () => Date.now();
  const consumed = new Map();
  return Object.freeze({
    consume(key, expiresAt) {
      const nowMs = Number(now());
      if (!Number.isFinite(nowMs)) {
        throw authError("COLLECTION_WORKER_AUTH_NONCE_STORE_INVALID", "worker nonce registry clock is invalid", 500);
      }
      for (const [storedKey, expiry] of consumed) if (expiry <= nowMs) consumed.delete(storedKey);
      if (consumed.has(key)) return false;
      if (consumed.size >= maxEntries) {
        const oldest = consumed.keys().next().value;
        if (oldest) consumed.delete(oldest);
      }
      consumed.set(key, expiresAt);
      return true;
    },
    size() {
      return consumed.size;
    }
  });
}

function verifySignedWorkerRequest(value = {}, options = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw authError("COLLECTION_WORKER_AUTH_INVALID", "signed worker request is invalid", 400);
  }
  const keys = Object.keys(value).sort().join(",");
  if (keys !== "request,signature") throw authError("COLLECTION_WORKER_AUTH_INVALID", "signed worker request fields are invalid", 400);
  const request = normalizeUnsignedRequest(value.request);
  if (request.schemaVersion !== value.request.schemaVersion) {
    throw authError("COLLECTION_WORKER_AUTH_INVALID", "worker request schema is invalid", 400);
  }
  const signature = String(value.signature || "");
  if (!SIGNATURE_PATTERN.test(signature)) {
    throw authError("COLLECTION_WORKER_AUTH_SIGNATURE_INVALID", "worker request signature is invalid", 401);
  }
  if (!crypto.verify(null, signatureBytes(request), publicEd25519(options.publicKey), Buffer.from(signature, "base64url"))) {
    throw authError("COLLECTION_WORKER_AUTH_SIGNATURE_INVALID", "worker request signature verification failed", 401);
  }
  if (request.audience !== String(options.expectedAudience || COLLECTION_WORKER_AUTH_AUDIENCE)) {
    throw authError("COLLECTION_WORKER_AUTH_AUDIENCE_INVALID", "worker request audience is invalid", 403);
  }
  if (request.workerId !== safeId(options.expectedWorkerId, "expectedWorkerId")) {
    throw authError("COLLECTION_WORKER_AUTH_IDENTITY_INVALID", "worker request identity is invalid", 403);
  }
  if (request.workerPoolId !== safeId(options.expectedWorkerPoolId, "expectedWorkerPoolId")) {
    throw authError("COLLECTION_WORKER_AUTH_IDENTITY_INVALID", "worker pool identity is invalid", 403);
  }
  if (request.keyId !== safeId(options.expectedKeyId, "expectedKeyId")) {
    throw authError("COLLECTION_WORKER_AUTH_IDENTITY_INVALID", "worker request key is not authorized", 403);
  }
  if (options.body !== undefined && request.bodySha256 !== sha256Hex(options.body)) {
    throw authError("COLLECTION_WORKER_AUTH_BODY_MISMATCH", "worker request body does not match", 409);
  }
  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  if (!Number.isFinite(now.getTime())) throw authError("COLLECTION_WORKER_AUTH_INVALID", "verification time is invalid", 400);
  const issuedMs = Date.parse(request.issuedAt);
  const ageMs = now.getTime() - issuedMs;
  if (
    ageMs > COLLECTION_WORKER_AUTH_MAX_AGE_SECONDS * 1000
    || ageMs < -COLLECTION_WORKER_AUTH_CLOCK_SKEW_SECONDS * 1000
  ) {
    throw authError("COLLECTION_WORKER_AUTH_EXPIRED", "worker request authorization expired", 401);
  }
  if (!options.nonceRegistry || typeof options.nonceRegistry.consume !== "function") {
    throw authError("COLLECTION_WORKER_AUTH_NONCE_STORE_REQUIRED", "worker nonce registry is required", 500);
  }
  const nonceKey = `${request.workerId}:${request.keyId}:${request.nonce}`;
  if (!options.nonceRegistry.consume(nonceKey, issuedMs + COLLECTION_WORKER_AUTH_MAX_AGE_SECONDS * 1000)) {
    throw authError("COLLECTION_WORKER_AUTH_REPLAY", "worker request nonce was already used", 409);
  }
  return request;
}

module.exports = {
  ALLOWED_PATH_SCOPES,
  COLLECTION_WORKER_AUTH_AUDIENCE,
  COLLECTION_WORKER_AUTH_SCHEMA_VERSION,
  CollectionWorkerAuthError,
  buildSignedWorkerRequest,
  createWorkerNonceRegistry,
  sha256Hex,
  verifySignedWorkerRequest
};
