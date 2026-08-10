"use strict";

const crypto = require("node:crypto");
const {
  FIXED_V2_COLLECTOR_COMPATIBILITY,
  V2_COLLECTOR_COMPATIBILITY_PROFILE,
  V2_COLLECTOR_COMPATIBILITY_SCHEMA_VERSION,
  V2_COLLECTOR_COMPATIBILITY_SCOPE,
  V2_COLLECTOR_COMPATIBILITY_STRATEGY,
  V2_COLLECTOR_TRANSPORT_STRATEGY,
  normalizedCompatibilityContract
} = require("./v2_collector_compatibility.cjs");
const {
  V2_COLLECTION_REQUEST_SCHEMA_VERSION,
  V2_COLLECTION_SCOPE,
  buildV2CollectionSignedContract,
  normalizeV2CollectionRequest
} = require("./v2_collection_request.cjs");

const COLLECTION_WORKER_JOB_DOCUMENT_TYPE = "lodging-collection-worker-job";
const COLLECTION_WORKER_JOB_SCHEMA_VERSION = "collection-worker-job.v1";
const COLLECTION_WORKER_JOB_AUDIENCE = "lodging-datalab-preview.collector-worker";
const COLLECTION_WORKER_SIGNATURE_ALGORITHM = "Ed25519";
const COLLECTION_WORKER_SIGNATURE_DOMAIN = "lodging-datalab.collection-worker.job.v1";
const COLLECTION_WORKER_DEFAULT_TTL_SECONDS = 300;
const COLLECTION_WORKER_MAX_TTL_SECONDS = 900;
const COLLECTION_WORKER_DEFAULT_CLOCK_SKEW_SECONDS = 30;

const REQUIRED_COLLECTION_WORKER_SCOPES = deepFreeze([
  "collection:claim",
  "collection:heartbeat",
  "collection:artifact:write",
  "collection:failure:write",
  "collection:result:finalize"
]);

const FIXED_V2_WORKER_RUNTIME_FINGERPRINT = deepFreeze({
  node: "26.5.0",
  undici: "8.7.0",
  openssl: "3.5.7",
  platform: "linux",
  arch: "x64"
});

const FIXED_V2_WORKER_COLLECTOR = deepFreeze({
  activationProfile: V2_COLLECTOR_COMPATIBILITY_PROFILE,
  compatibilitySchemaVersion: V2_COLLECTOR_COMPATIBILITY_SCHEMA_VERSION,
  strategy: V2_COLLECTOR_COMPATIBILITY_STRATEGY,
  transportStrategy: V2_COLLECTOR_TRANSPORT_STRATEGY,
  collectorScope: V2_COLLECTOR_COMPATIBILITY_SCOPE,
  historicalSourceCommit: FIXED_V2_COLLECTOR_COMPATIBILITY.historicalSourceCommit,
  historicalCollectorBlob: FIXED_V2_COLLECTOR_COMPATIBILITY.historicalCollectorBlob
});

// New normal jobs invoke the repository's V2 collector child directly.  This
// descriptor identifies that execution boundary without importing any of its
// collection decisions into the worker contract.
const V2_SINGLE_SOURCE_WORKER_COLLECTOR = deepFreeze({
  activationProfile: "v2_collector_single_source.v2",
  compatibilitySchemaVersion: V2_COLLECTION_REQUEST_SCHEMA_VERSION,
  strategy: "existing_v2_collector",
  transportStrategy: "collector_child",
  collectorScope: V2_COLLECTION_SCOPE,
  historicalSourceCommit: "current_repository_v2_collector",
  historicalCollectorBlob: "runtime_verified"
});

const FIXED_ONE_SHOT_POLICY = deepFreeze({
  oneShot: true,
  maxWorkerExecutions: 1,
  automaticRetry: false,
  automaticFallback: false,
  externalCallOnRead: false,
  saveRunOnSuccessOnly: true,
  saveFailureRun: false
});

const NORMALIZED_CONTRACT_KEYS = Object.freeze([
  "schemaVersion",
  "keywordHash",
  "searchMode",
  "collectionMode",
  "collectionPurpose",
  "productMode",
  "checkIn",
  "checkOut",
  "measurementPeriod",
  "rankStart",
  "rankEnd",
  "detailRankStart",
  "detailRankEnd"
]);

const BASE_ENVELOPE_KEYS = Object.freeze([
  "documentType",
  "schemaVersion",
  "jobId",
  "attemptId",
  "approvalId",
  "audience",
  "worker",
  "collector",
  "runtimeFingerprint",
  "runtimeFingerprintHash",
  "contract",
  "contractHash",
  "idempotencyKey",
  "executionIdentityHash",
  "authorization",
  "policy",
  "issuedAt",
  "notBefore",
  "expiresAt",
  "nonce"
]);

const SIGNED_ENVELOPE_KEYS = Object.freeze([
  ...BASE_ENVELOPE_KEYS,
  "signerKeyId",
  "signatureAlgorithm",
  "signature"
]);

class CollectionWorkerContractError extends Error {
  constructor(code, message, statusCode = 400) {
    super(message);
    this.name = "CollectionWorkerContractError";
    this.code = code;
    this.statusCode = statusCode;
    this.retryable = false;
  }
}

function contractError(code, message, statusCode = 400) {
  return new CollectionWorkerContractError(code, message, statusCode);
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw contractError("COLLECTION_WORKER_VALUE_INVALID", "Collection worker values must be finite");
  }
  return JSON.stringify(value ?? null);
}

function sha256Hex(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw contractError("COLLECTION_WORKER_CONTRACT_INVALID", `${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw contractError("COLLECTION_WORKER_CONTRACT_INVALID", `${label} contains unsupported fields`);
  }
}

function normalizedIdentifier(value, label, maxLength = 160) {
  const normalized = String(value || "").trim();
  if (
    normalized.length < 3
    || normalized.length > maxLength
    || !/^[a-z0-9][a-z0-9._:-]*$/u.test(normalized)
  ) {
    throw contractError("COLLECTION_WORKER_IDENTITY_INVALID", `${label} is invalid`);
  }
  return normalized;
}

function normalizedAudience(value) {
  const audience = String(value ?? COLLECTION_WORKER_JOB_AUDIENCE).trim();
  if (
    !audience
    || audience.length > 180
    || !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u.test(audience)
  ) {
    throw contractError("COLLECTION_WORKER_AUDIENCE_INVALID", "Collection worker audience is invalid");
  }
  return audience;
}

function canonicalInstant(value, label) {
  const text = String(value || "").trim();
  const parsed = new Date(text);
  if (!text || Number.isNaN(parsed.getTime()) || parsed.toISOString() !== text) {
    throw contractError("COLLECTION_WORKER_TIME_INVALID", `${label} is invalid`);
  }
  return text;
}

function canonicalDate(value, label) {
  const text = String(value || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(text)) {
    throw contractError("COLLECTION_WORKER_CONTRACT_HASH_INVALID", `${label} is invalid`);
  }
  const parsed = new Date(`${text}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== text) {
    throw contractError("COLLECTION_WORKER_CONTRACT_HASH_INVALID", `${label} is invalid`);
  }
  return text;
}

function normalizedNonce(value) {
  const nonce = String(value || "").trim();
  if (!/^[A-Za-z0-9_-]{16,128}$/u.test(nonce)) {
    throw contractError("COLLECTION_WORKER_NONCE_INVALID", "Collection worker nonce is invalid");
  }
  return nonce;
}

function assertSha256(value, label) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/u.test(normalized)) {
    throw contractError("COLLECTION_WORKER_CONTRACT_HASH_INVALID", `${label} is invalid`);
  }
  return normalized;
}

function cloneFixedObject(value) {
  return Object.fromEntries(Object.entries(value).map(([key, nested]) => [
    key,
    Array.isArray(nested) ? [...nested] : nested
  ]));
}

function assertExactFixedObject(value, fixed, label) {
  exactKeys(value, Object.keys(fixed), label);
  for (const [key, expected] of Object.entries(fixed)) {
    if (value[key] !== expected) {
      throw contractError("COLLECTION_WORKER_RUNTIME_MISMATCH", `${label}.${key} does not match the approved value`);
    }
  }
  return deepFreeze(cloneFixedObject(fixed));
}

function validateNormalizedCollectionJobContract(value) {
  exactKeys(value, NORMALIZED_CONTRACT_KEYS, "Collection worker collection contract");
  const checkIn = canonicalDate(value.checkIn, "checkIn");
  const checkOut = canonicalDate(value.checkOut, "checkOut");
  exactKeys(value.measurementPeriod, ["start", "end"], "Collection worker measurement period");
  const valid = value.schemaVersion === V2_COLLECTOR_COMPATIBILITY_SCHEMA_VERSION
    && /^[a-f0-9]{64}$/u.test(String(value.keywordHash || ""))
    && value.searchMode === "keyword"
    && value.collectionMode === "precision"
    && value.collectionPurpose === "revenue_detail"
    && value.productMode === "all"
    && checkIn === checkOut
    && value.measurementPeriod.start === checkIn
    && value.measurementPeriod.end === checkOut
    && Number(value.rankStart) === FIXED_V2_COLLECTOR_COMPATIBILITY.mainPlaceRankStart
    && Number(value.rankEnd) === FIXED_V2_COLLECTOR_COMPATIBILITY.mainPlaceRankEnd
    && Number(value.detailRankStart) === FIXED_V2_COLLECTOR_COMPATIBILITY.inventoryRankStart
    && Number(value.detailRankEnd) === FIXED_V2_COLLECTOR_COMPATIBILITY.inventoryRankEnd;
  if (!valid) {
    throw contractError(
      "COLLECTION_WORKER_CONTRACT_HASH_INVALID",
      "Collection worker collection contract does not match the approved V2 contract"
    );
  }
  return deepFreeze({
    schemaVersion: value.schemaVersion,
    keywordHash: String(value.keywordHash),
    searchMode: value.searchMode,
    collectionMode: value.collectionMode,
    collectionPurpose: value.collectionPurpose,
    productMode: value.productMode,
    checkIn,
    checkOut,
    measurementPeriod: { start: checkIn, end: checkOut },
    rankStart: Number(value.rankStart),
    rankEnd: Number(value.rankEnd),
    detailRankStart: Number(value.detailRankStart),
    detailRankEnd: Number(value.detailRankEnd)
  });
}

function validateV2SingleSourceCollectionJobContract(value) {
  let normalized;
  try {
    normalized = buildV2CollectionSignedContract(value);
  } catch (error) {
    throw contractError("COLLECTION_WORKER_CONTRACT_HASH_INVALID", "V2 collection contract is invalid");
  }
  if (stableJson(value) !== stableJson(normalized)) {
    throw contractError("COLLECTION_WORKER_CONTRACT_HASH_INVALID", "V2 collection contract fields do not match", 409);
  }
  return normalized;
}

function normalizeCollectionJobContract(input = {}) {
  if (
    input
    && typeof input === "object"
    && !Array.isArray(input)
    && input.schemaVersion === V2_COLLECTION_REQUEST_SCHEMA_VERSION
  ) {
    return validateV2SingleSourceCollectionJobContract(input);
  }
  if (
    input
    && typeof input === "object"
    && !Array.isArray(input)
    && input.schemaVersion === V2_COLLECTOR_COMPATIBILITY_SCHEMA_VERSION
    && Object.prototype.hasOwnProperty.call(input, "keywordHash")
  ) {
    return validateNormalizedCollectionJobContract(input);
  }
  try {
    return validateNormalizedCollectionJobContract(normalizedCompatibilityContract(input));
  } catch (error) {
    if (error instanceof CollectionWorkerContractError) throw error;
    throw contractError(
      "COLLECTION_WORKER_CONTRACT_HASH_INVALID",
      "Collection worker collection contract is invalid"
    );
  }
}

function computeCollectionContractHash(contract) {
  const normalized = normalizeCollectionJobContract(contract);
  if (normalized.schemaVersion === V2_COLLECTION_REQUEST_SCHEMA_VERSION) return normalized.contractHash;
  return sha256Hex(stableJson(normalized));
}

function normalizeWorkerScopes(value = REQUIRED_COLLECTION_WORKER_SCOPES) {
  if (!Array.isArray(value)) {
    throw contractError("COLLECTION_WORKER_SCOPE_INVALID", "Collection worker scopes must be an array", 403);
  }
  const scopes = value.map((scope) => String(scope || "").trim());
  const scopeSet = new Set(scopes);
  const valid = scopes.length === REQUIRED_COLLECTION_WORKER_SCOPES.length
    && scopeSet.size === scopes.length
    && REQUIRED_COLLECTION_WORKER_SCOPES.every((scope) => scopeSet.has(scope));
  if (!valid) {
    throw contractError("COLLECTION_WORKER_SCOPE_INVALID", "Collection worker scopes do not match the exact allowlist", 403);
  }
  return deepFreeze([...REQUIRED_COLLECTION_WORKER_SCOPES]);
}

function normalizeAuthorization(input = {}) {
  const source = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  for (const key of ["enabled", "actualCallsEnabled", "externalCallApproved"]) {
    if (Object.prototype.hasOwnProperty.call(source, key) && typeof source[key] !== "boolean") {
      throw contractError(
        "COLLECTION_WORKER_AUTHORIZATION_INVALID",
        `Collection worker authorization ${key} must be boolean`,
        409
      );
    }
  }
  if (
    Object.prototype.hasOwnProperty.call(source, "authorizedExecutionCount")
    && !Number.isInteger(source.authorizedExecutionCount)
  ) {
    throw contractError(
      "COLLECTION_WORKER_AUTHORIZATION_INVALID",
      "Collection worker authorized execution count must be an integer",
      409
    );
  }
  const enabled = source.enabled === true;
  const actualCallsEnabled = source.actualCallsEnabled === true;
  const externalCallApproved = source.externalCallApproved === true;
  const expectedCount = enabled && actualCallsEnabled && externalCallApproved ? 1 : 0;
  const authorizedExecutionCount = Number(source.authorizedExecutionCount ?? expectedCount);
  const fullyDisabled = !enabled && !actualCallsEnabled && !externalCallApproved && authorizedExecutionCount === 0;
  const oneShotEnabled = enabled && actualCallsEnabled && externalCallApproved && authorizedExecutionCount === 1;
  if (!fullyDisabled && !oneShotEnabled) {
    throw contractError(
      "COLLECTION_WORKER_AUTHORIZATION_INVALID",
      "Collection worker authorization must be fully disabled or an approved one-shot execution",
      409
    );
  }
  return deepFreeze({ enabled, actualCallsEnabled, externalCallApproved, authorizedExecutionCount });
}

function normalizePolicy(input = {}) {
  const source = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  for (const [key, expected] of Object.entries(FIXED_ONE_SHOT_POLICY)) {
    if (Object.prototype.hasOwnProperty.call(source, key) && source[key] !== expected) {
      throw contractError("COLLECTION_WORKER_POLICY_INVALID", `Collection worker policy ${key} is invalid`, 409);
    }
  }
  return deepFreeze(cloneFixedObject(FIXED_ONE_SHOT_POLICY));
}

function normalizeCollector(input = FIXED_V2_WORKER_COLLECTOR) {
  const source = input && typeof input === "object" ? input : {};
  const fixed = source.collectorScope === V2_COLLECTION_SCOPE
    ? V2_SINGLE_SOURCE_WORKER_COLLECTOR
    : FIXED_V2_WORKER_COLLECTOR;
  return assertExactFixedObject(source, fixed, "Collection worker collector");
}

function normalizeRuntimeFingerprint(input = FIXED_V2_WORKER_RUNTIME_FINGERPRINT) {
  return assertExactFixedObject(input, FIXED_V2_WORKER_RUNTIME_FINGERPRINT, "Collection worker runtime fingerprint");
}

function buildCollectionIdempotencyKey(contract, options = {}) {
  const normalizedContract = normalizeCollectionJobContract(contract);
  const workerPoolId = normalizedIdentifier(options.workerPoolId, "workerPoolId", 80);
  const audience = normalizedAudience(options.audience);
  const runtimeFingerprint = normalizeRuntimeFingerprint(options.runtimeFingerprint || FIXED_V2_WORKER_RUNTIME_FINGERPRINT);
  return sha256Hex(stableJson({
    domain: normalizedContract.schemaVersion === V2_COLLECTION_REQUEST_SCHEMA_VERSION
      ? "lodging-datalab.v2-collection-execution.v2"
      : "lodging-datalab.collection-worker.idempotency.v1",
    audience,
    workerPoolId,
    collector: normalizedContract.schemaVersion === V2_COLLECTION_REQUEST_SCHEMA_VERSION
      ? V2_SINGLE_SOURCE_WORKER_COLLECTOR
      : FIXED_V2_WORKER_COLLECTOR,
    runtimeFingerprint,
    contract: normalizedContract
  }));
}

function buildCollectionExecutionIdentity(input) {
  return sha256Hex(stableJson({
    domain: "lodging-datalab.collection-worker.execution.v1",
    jobId: input.jobId,
    attemptId: input.attemptId,
    approvalId: input.approvalId,
    workerId: input.worker.workerId,
    workerPoolId: input.worker.workerPoolId,
    contractHash: input.contractHash,
    idempotencyKey: input.idempotencyKey,
    collector: input.collector,
    runtimeFingerprintHash: input.runtimeFingerprintHash
  }));
}

function buildCollectionWorkerJobEnvelope(input = {}, options = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw contractError("COLLECTION_WORKER_CONTRACT_INVALID", "Collection worker job input is invalid");
  }
  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  if (Number.isNaN(now.getTime())) {
    throw contractError("COLLECTION_WORKER_TIME_INVALID", "Collection worker issue time is invalid");
  }
  const ttlSeconds = Number(options.ttlSeconds ?? input.ttlSeconds ?? COLLECTION_WORKER_DEFAULT_TTL_SECONDS);
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > COLLECTION_WORKER_MAX_TTL_SECONDS) {
    throw contractError("COLLECTION_WORKER_TIME_INVALID", "Collection worker envelope TTL is invalid");
  }
  const jobId = normalizedIdentifier(input.jobId, "jobId");
  const attemptId = normalizedIdentifier(input.attemptId, "attemptId");
  const approvalId = normalizedIdentifier(input.approvalId, "approvalId");
  const audience = normalizedAudience(input.audience);
  const worker = deepFreeze({
    workerId: normalizedIdentifier(input.workerId || input.worker?.workerId, "workerId", 80),
    workerPoolId: normalizedIdentifier(input.workerPoolId || input.worker?.workerPoolId, "workerPoolId", 80),
    scopes: normalizeWorkerScopes(input.workerScopes || input.worker?.scopes || REQUIRED_COLLECTION_WORKER_SCOPES)
  });
  const request = normalizeCollectionJobContract(input.contract || input);
  const collector = normalizeCollector(input.collector || (
    request.schemaVersion === V2_COLLECTION_REQUEST_SCHEMA_VERSION
      ? V2_SINGLE_SOURCE_WORKER_COLLECTOR
      : FIXED_V2_WORKER_COLLECTOR
  ));
  const runtimeFingerprint = normalizeRuntimeFingerprint(input.runtimeFingerprint || FIXED_V2_WORKER_RUNTIME_FINGERPRINT);
  const runtimeFingerprintHash = sha256Hex(stableJson(runtimeFingerprint));
  const contract = request;
  const contractHash = computeCollectionContractHash(contract);
  const idempotencyKey = buildCollectionIdempotencyKey(contract, {
    workerPoolId: worker.workerPoolId,
    audience,
    runtimeFingerprint
  });
  const authorization = normalizeAuthorization(input.authorization || input);
  const policy = normalizePolicy(input.policy || input);
  const issuedAt = now.toISOString();
  const notBefore = issuedAt;
  const expiresAt = new Date(now.getTime() + ttlSeconds * 1000).toISOString();
  const nonce = normalizedNonce(input.nonce);
  const base = {
    documentType: COLLECTION_WORKER_JOB_DOCUMENT_TYPE,
    schemaVersion: COLLECTION_WORKER_JOB_SCHEMA_VERSION,
    jobId,
    attemptId,
    approvalId,
    audience,
    worker,
    collector,
    runtimeFingerprint,
    runtimeFingerprintHash,
    contract,
    contractHash,
    idempotencyKey,
    executionIdentityHash: "",
    authorization,
    policy,
    issuedAt,
    notBefore,
    expiresAt,
    nonce
  };
  base.executionIdentityHash = buildCollectionExecutionIdentity(base);
  return deepFreeze(base);
}

function keyObject(value, kind) {
  try {
    const key = value instanceof crypto.KeyObject
      ? value
      : kind === "private"
        ? crypto.createPrivateKey(value)
        : crypto.createPublicKey(value);
    if (key.type !== kind || key.asymmetricKeyType !== "ed25519") {
      throw new TypeError("wrong key type");
    }
    return key;
  } catch {
    throw contractError(
      "COLLECTION_WORKER_SIGNING_KEY_INVALID",
      `Collection worker ${kind} signing key is invalid`,
      500
    );
  }
}

function signatureBytes(value) {
  return Buffer.from(`${COLLECTION_WORKER_SIGNATURE_DOMAIN}\n${stableJson(value)}`, "utf8");
}

function buildSignedJobEnvelope(input = {}, options = {}) {
  const envelope = buildCollectionWorkerJobEnvelope(input, options);
  const signerKeyId = normalizedIdentifier(options.signerKeyId || input.signerKeyId, "signerKeyId", 80);
  const signedPayload = deepFreeze({
    ...envelope,
    signerKeyId,
    signatureAlgorithm: COLLECTION_WORKER_SIGNATURE_ALGORITHM
  });
  const privateKey = keyObject(options.privateKey, "private");
  const signature = crypto.sign(null, signatureBytes(signedPayload), privateKey).toString("base64url");
  return deepFreeze({ ...signedPayload, signature });
}

function validateBaseEnvelope(value) {
  exactKeys(value, BASE_ENVELOPE_KEYS, "Collection worker job envelope");
  if (
    value.documentType !== COLLECTION_WORKER_JOB_DOCUMENT_TYPE
    || value.schemaVersion !== COLLECTION_WORKER_JOB_SCHEMA_VERSION
  ) {
    throw contractError("COLLECTION_WORKER_CONTRACT_INVALID", "Collection worker job envelope type is invalid");
  }
  const contract = normalizeCollectionJobContract(value.contract);
  const contractHash = computeCollectionContractHash(contract);
  if (assertSha256(value.contractHash, "contractHash") !== contractHash) {
    throw contractError("COLLECTION_WORKER_CONTRACT_HASH_INVALID", "Collection worker contract hash does not match", 409);
  }
  const runtimeFingerprint = normalizeRuntimeFingerprint(value.runtimeFingerprint);
  const runtimeFingerprintHash = sha256Hex(stableJson(runtimeFingerprint));
  if (assertSha256(value.runtimeFingerprintHash, "runtimeFingerprintHash") !== runtimeFingerprintHash) {
    throw contractError("COLLECTION_WORKER_RUNTIME_MISMATCH", "Collection worker runtime fingerprint hash does not match", 409);
  }
  exactKeys(value.worker, ["workerId", "workerPoolId", "scopes"], "Collection worker identity");
  exactKeys(
    value.authorization,
    ["enabled", "actualCallsEnabled", "externalCallApproved", "authorizedExecutionCount"],
    "Collection worker authorization"
  );
  exactKeys(value.policy, Object.keys(FIXED_ONE_SHOT_POLICY), "Collection worker policy");
  const worker = deepFreeze({
    workerId: normalizedIdentifier(value.worker?.workerId, "workerId", 80),
    workerPoolId: normalizedIdentifier(value.worker?.workerPoolId, "workerPoolId", 80),
    scopes: normalizeWorkerScopes(value.worker?.scopes)
  });
  const normalized = {
    documentType: value.documentType,
    schemaVersion: value.schemaVersion,
    jobId: normalizedIdentifier(value.jobId, "jobId"),
    attemptId: normalizedIdentifier(value.attemptId, "attemptId"),
    approvalId: normalizedIdentifier(value.approvalId, "approvalId"),
    audience: normalizedAudience(value.audience),
    worker,
    collector: normalizeCollector(value.collector),
    runtimeFingerprint,
    runtimeFingerprintHash,
    contract,
    contractHash,
    idempotencyKey: assertSha256(value.idempotencyKey, "idempotencyKey"),
    executionIdentityHash: assertSha256(value.executionIdentityHash, "executionIdentityHash"),
    authorization: normalizeAuthorization(value.authorization),
    policy: normalizePolicy(value.policy),
    issuedAt: canonicalInstant(value.issuedAt, "issuedAt"),
    notBefore: canonicalInstant(value.notBefore, "notBefore"),
    expiresAt: canonicalInstant(value.expiresAt, "expiresAt"),
    nonce: normalizedNonce(value.nonce)
  };
  const expectedIdempotencyKey = buildCollectionIdempotencyKey(contract, {
    workerPoolId: worker.workerPoolId,
    audience: normalized.audience,
    runtimeFingerprint
  });
  if (normalized.idempotencyKey !== expectedIdempotencyKey) {
    throw contractError("COLLECTION_WORKER_CONTRACT_HASH_INVALID", "Collection worker idempotency key does not match", 409);
  }
  const expectedExecutionIdentity = buildCollectionExecutionIdentity(normalized);
  if (normalized.executionIdentityHash !== expectedExecutionIdentity) {
    throw contractError("COLLECTION_WORKER_CONTRACT_HASH_INVALID", "Collection worker execution identity does not match", 409);
  }
  return deepFreeze(normalized);
}

function assertWorkerScopeAllowsJob(envelope, identity = {}) {
  const expectedWorkerId = normalizedIdentifier(identity.workerId, "expected workerId", 80);
  const expectedWorkerPoolId = normalizedIdentifier(identity.workerPoolId, "expected workerPoolId", 80);
  normalizeWorkerScopes(envelope?.worker?.scopes);
  if (
    envelope.worker.workerId !== expectedWorkerId
    || envelope.worker.workerPoolId !== expectedWorkerPoolId
    || ![V2_COLLECTOR_COMPATIBILITY_SCOPE, V2_COLLECTION_SCOPE].includes(envelope.collector.collectorScope)
  ) {
    throw contractError("COLLECTION_WORKER_SCOPE_INVALID", "Collection worker identity or collector scope is not authorized", 403);
  }
  return true;
}

function assertCollectionWorkerJobExecutable(envelope) {
  const authorization = normalizeAuthorization(envelope?.authorization);
  const policy = normalizePolicy(envelope?.policy);
  if (
    !authorization.enabled
    || !authorization.actualCallsEnabled
    || !authorization.externalCallApproved
    || authorization.authorizedExecutionCount !== 1
    || policy.oneShot !== true
    || policy.maxWorkerExecutions !== 1
  ) {
    throw contractError("COLLECTION_WORKER_JOB_DISABLED", "Collection worker job is disabled", 409);
  }
  return true;
}

function verifySignedJobEnvelope(value = {}, options = {}) {
  exactKeys(value, SIGNED_ENVELOPE_KEYS, "Signed collection worker job envelope");
  if (value.signatureAlgorithm !== COLLECTION_WORKER_SIGNATURE_ALGORITHM) {
    throw contractError("COLLECTION_WORKER_SIGNATURE_INVALID", "Collection worker signature algorithm is invalid", 401);
  }
  const signerKeyId = normalizedIdentifier(value.signerKeyId, "signerKeyId", 80);
  if (options.expectedSignerKeyId && signerKeyId !== normalizedIdentifier(options.expectedSignerKeyId, "expected signerKeyId", 80)) {
    throw contractError("COLLECTION_WORKER_SIGNATURE_INVALID", "Collection worker signer key is not authorized", 401);
  }
  const signature = String(value.signature || "");
  if (!/^[A-Za-z0-9_-]{86}$/u.test(signature)) {
    throw contractError("COLLECTION_WORKER_SIGNATURE_INVALID", "Collection worker signature is malformed", 401);
  }
  const signedPayload = Object.fromEntries(
    Object.entries(value).filter(([key]) => key !== "signature")
  );
  const publicKey = keyObject(options.publicKey, "public");
  if (!crypto.verify(null, signatureBytes(signedPayload), publicKey, Buffer.from(signature, "base64url"))) {
    throw contractError("COLLECTION_WORKER_SIGNATURE_INVALID", "Collection worker signature verification failed", 401);
  }
  const basePayload = Object.fromEntries(
    Object.entries(signedPayload).filter(([key]) => !["signerKeyId", "signatureAlgorithm"].includes(key))
  );
  const envelope = validateBaseEnvelope(basePayload);
  const expectedAudience = normalizedAudience(options.expectedAudience || COLLECTION_WORKER_JOB_AUDIENCE);
  if (envelope.audience !== expectedAudience) {
    throw contractError("COLLECTION_WORKER_AUDIENCE_MISMATCH", "Collection worker audience does not match", 403);
  }
  assertWorkerScopeAllowsJob(envelope, {
    workerId: options.expectedWorkerId,
    workerPoolId: options.expectedWorkerPoolId
  });
  if (options.expectedContractHash && envelope.contractHash !== assertSha256(options.expectedContractHash, "expectedContractHash")) {
    throw contractError("COLLECTION_WORKER_CONTRACT_HASH_INVALID", "Collection worker expected contract hash does not match", 409);
  }
  const issuedMs = Date.parse(envelope.issuedAt);
  const notBeforeMs = Date.parse(envelope.notBefore);
  const expiresMs = Date.parse(envelope.expiresAt);
  if (
    notBeforeMs < issuedMs
    || expiresMs <= notBeforeMs
    || expiresMs - issuedMs > COLLECTION_WORKER_MAX_TTL_SECONDS * 1000
  ) {
    throw contractError("COLLECTION_WORKER_TIME_INVALID", "Collection worker validity window is invalid", 401);
  }
  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  const clockSkewSeconds = Number(options.clockSkewSeconds ?? COLLECTION_WORKER_DEFAULT_CLOCK_SKEW_SECONDS);
  if (Number.isNaN(now.getTime()) || !Number.isInteger(clockSkewSeconds) || clockSkewSeconds < 0 || clockSkewSeconds > 120) {
    throw contractError("COLLECTION_WORKER_TIME_INVALID", "Collection worker verification time is invalid", 401);
  }
  if (now.getTime() + clockSkewSeconds * 1000 < notBeforeMs) {
    throw contractError("COLLECTION_WORKER_JOB_NOT_YET_VALID", "Collection worker job is not yet valid", 401);
  }
  if (now.getTime() - clockSkewSeconds * 1000 > expiresMs) {
    throw contractError("COLLECTION_WORKER_JOB_EXPIRED", "Collection worker job has expired", 401);
  }
  if (options.requireExecutable !== false) assertCollectionWorkerJobExecutable(envelope);
  return deepFreeze({ ...envelope, signerKeyId, signatureAlgorithm: value.signatureAlgorithm, signature });
}

module.exports = {
  COLLECTION_WORKER_DEFAULT_CLOCK_SKEW_SECONDS,
  COLLECTION_WORKER_DEFAULT_TTL_SECONDS,
  COLLECTION_WORKER_JOB_AUDIENCE,
  COLLECTION_WORKER_JOB_DOCUMENT_TYPE,
  COLLECTION_WORKER_JOB_SCHEMA_VERSION,
  COLLECTION_WORKER_MAX_TTL_SECONDS,
  COLLECTION_WORKER_SIGNATURE_ALGORITHM,
  COLLECTION_WORKER_SIGNATURE_DOMAIN,
  CollectionWorkerContractError,
  FIXED_ONE_SHOT_POLICY,
  FIXED_V2_WORKER_COLLECTOR,
  V2_SINGLE_SOURCE_WORKER_COLLECTOR,
  FIXED_V2_WORKER_RUNTIME_FINGERPRINT,
  REQUIRED_COLLECTION_WORKER_SCOPES,
  assertCollectionWorkerJobExecutable,
  assertWorkerScopeAllowsJob,
  buildCollectionExecutionIdentity,
  buildCollectionIdempotencyKey,
  buildCollectionWorkerJobEnvelope,
  buildSignedJobEnvelope,
  computeCollectionContractHash,
  normalizeCollectionJobContract,
  verifySignedJobEnvelope
};
