"use strict";

const crypto = require("node:crypto");
const {
  V2_TOP20_CONTRACT,
  V2_TOP20_PROFILE,
  V2_TOP20_SCHEMA_VERSION,
  V2_TOP20_SCOPE
} = require("./collection_worker_v2_top20_contract.cjs");
const {
  V2_TOP20_SCHEDULE_REQUEST_GRANULARITY,
  v2Top20ResiliencePlan
} = require("./collection_worker_v2_top20_resilience.cjs");

const COLLECTION_WORKER_V2_TOP20_PROTOCOL_SCHEMA_VERSION = "collection-worker-v2-top20-protocol.v1";
const COLLECTION_WORKER_V2_TOP20_RESULT_SCHEMA_VERSION = "collection-worker-v2-top20-result.v1";
const COLLECTION_WORKER_V2_TOP20_WORKER_ID = "collector_worker_preview_top20_01";
const COLLECTION_WORKER_V2_TOP20_WORKER_POOL_ID = "collector_pool_preview_top20_01";
const COLLECTION_WORKER_V2_TOP20_REQUEST_KEY_ID = "collector_worker_top20_request_v1";
const COLLECTION_WORKER_V2_TOP20_DISPATCH_KEY_ID = "preview_top20_dispatch_v1";
const COLLECTION_WORKER_V2_TOP20_ARTIFACT_KEY_ID = "collector_top20_artifact_v1";
const COLLECTION_WORKER_V2_TOP20_TARGET_SERVICE_ID = "srv-d9q6mrfavr4c73atllf0";
const COLLECTION_WORKER_V2_TOP20_PREVIEW_SERVICE_ID = "srv-d9jf91v41pts73cj9bu0";
const COLLECTION_WORKER_V2_TOP20_RUNTIME_ID_PREFIX = `runtime:${COLLECTION_WORKER_V2_TOP20_TARGET_SERVICE_ID}:top20:`;
const COLLECTION_WORKER_V2_TOP20_BACKEND_ID = "naver_place_top20_inventory";
const COLLECTION_WORKER_V2_TOP20_PREPARE_PATH = "/api/internal/collection-worker/v2-top20/prepare";
const COLLECTION_WORKER_V2_TOP20_RUNTIME_ATTEST_PATH = "/api/internal/collection-worker/runtime/attest";
const COLLECTION_WORKER_V2_TOP20_INTERNAL_PROTOCOL_VERSION = "collection-worker-top20-internal.v2";
const COLLECTION_WORKER_V2_TOP20_CLAIM_PATH = "/api/internal/collection-worker/jobs/claim";
const COLLECTION_WORKER_V2_TOP20_PREFLIGHT_PATH = "/api/internal/collection-worker/jobs/preflight";
const COLLECTION_WORKER_V2_TOP20_HEARTBEAT_PATH = "/api/internal/collection-worker/jobs/heartbeat";
const COLLECTION_WORKER_V2_TOP20_FINALIZE_PATH = "/api/internal/collection-worker/results/finalize";
const COLLECTION_WORKER_V2_TOP20_FAILURE_PATH = "/api/internal/collection-worker/failures";
const COLLECTION_WORKER_V2_TOP20_ARTIFACT_DIAGNOSTIC_PATH = "/api/internal/collection-worker/v2-top20/artifact-security-diagnostic";
const COLLECTION_WORKER_V2_TOP20_MAIN_PLACE_PROBE_FINALIZE_PATH = "/api/internal/collection-worker/v2-top20/main-place-recovery-probe/finalize";
const COLLECTION_WORKER_V2_TOP20_MAIN_PLACE_PROBE_PROFILE = "main_place_recovery_probe.v1";
const COLLECTION_WORKER_V2_TOP20_BOOKING_DETAIL_PROBE_FINALIZE_PATH = "/api/internal/collection-worker/v2-top20/booking-detail-recovery-probe/finalize";
const COLLECTION_WORKER_V2_TOP20_BOOKING_DETAIL_PROBE_PROFILE = "booking_detail_recovery_probe.v1";
const COLLECTION_WORKER_V2_TOP20_SUMMARY_PATH = "top20-summary.json";
const COLLECTION_WORKER_V2_TOP20_ARTIFACT_PROOF_DOMAIN = "lodging-datalab.collection-worker.top20-artifact-key-proof.v1";
const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const SIGNATURE_PATTERN = /^[A-Za-z0-9_-]{86}$/u;
const EXECUTION_REQUEST_ID_PATTERN = /^[a-zA-Z0-9._:-]{8,128}$/u;

class CollectionWorkerV2Top20ProtocolError extends Error {
  constructor(code, message, statusCode = 400) {
    super(message);
    this.name = "CollectionWorkerV2Top20ProtocolError";
    this.code = code;
    this.statusCode = statusCode;
    this.retryable = false;
  }
}

function protocolError(code, message, statusCode = 400) {
  return new CollectionWorkerV2Top20ProtocolError(code, message, statusCode);
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw protocolError("COLLECTION_WORKER_V2_TOP20_INPUT_INVALID", "top20 protocol values must be finite");
  }
  return JSON.stringify(value ?? null);
}

function sha256Hex(value) {
  return crypto.createHash("sha256").update(Buffer.isBuffer(value) ? value : Buffer.from(String(value))).digest("hex");
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw protocolError("COLLECTION_WORKER_V2_TOP20_INPUT_INVALID", `${label} is invalid`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw protocolError("COLLECTION_WORKER_V2_TOP20_INPUT_INVALID", `${label} fields are invalid`);
  }
}

function canonicalDate(value, label) {
  const text = String(value || "");
  const parsed = new Date(`${text}T00:00:00.000Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(text) || !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== text) {
    throw protocolError("COLLECTION_WORKER_V2_TOP20_INPUT_INVALID", `${label} is invalid`);
  }
  return text;
}

function inclusiveKstDateRangeDays(start, end) {
  const startMs = Date.UTC(Number(start.slice(0, 4)), Number(start.slice(5, 7)) - 1, Number(start.slice(8, 10)));
  const endMs = Date.UTC(Number(end.slice(0, 4)), Number(end.slice(5, 7)) - 1, Number(end.slice(8, 10)));
  return Math.floor((endMs - startMs) / 86400000) + 1;
}

function maxBookingRangeDays() {
  const configured = Number(process.env.MAX_BOOKING_RANGE_DAYS || 7);
  return Number.isSafeInteger(configured) && configured >= 1 && configured <= 7 ? configured : 7;
}

function normalizeV2Top20PrepareContract(input = {}) {
  const keys = [
    "keyword",
    "searchMode",
    "collectionMode",
    "collectionPurpose",
    "productMode",
    "checkIn",
    "checkOut",
    "bookingRangeDays",
    "rankStart",
    "rankEnd",
    "detailRankStart",
    "detailRankEnd"
  ];
  exactKeys(input, keys, "top20 collection contract");
  const keyword = String(input.keyword || "").trim();
  const checkIn = canonicalDate(input.checkIn, "checkIn");
  const checkOut = canonicalDate(input.checkOut, "checkOut");
  if (
    !keyword
    || keyword.length > 120
    || /[\r\n\0]/u.test(keyword)
    || input.searchMode !== "keyword"
    || input.collectionMode !== "precision"
    || input.collectionPurpose !== "revenue_detail"
    || input.productMode !== "all"
    || Number(input.rankStart) !== V2_TOP20_CONTRACT.mainPlaceRankStart
    || Number(input.rankEnd) !== V2_TOP20_CONTRACT.mainPlaceRankEnd
    || Number(input.detailRankStart) !== V2_TOP20_CONTRACT.inventoryRankStart
    || Number(input.detailRankEnd) !== V2_TOP20_CONTRACT.inventoryRankEnd
  ) {
    throw protocolError(
      "COLLECTION_WORKER_V2_TOP20_CONTRACT_INVALID",
      "collection contract does not match the fixed V2 top20 profile",
      409
    );
  }
  if (checkOut < checkIn) {
    throw protocolError("COLLECTION_WORKER_V2_TOP20_DATE_RANGE_INVALID", "collection end date precedes the start date", 422);
  }
  const bookingRangeDays = inclusiveKstDateRangeDays(checkIn, checkOut);
  if (bookingRangeDays < 1 || bookingRangeDays > maxBookingRangeDays()) {
    throw protocolError("COLLECTION_WORKER_V2_TOP20_DATE_RANGE_EXCEEDED", "collection date range exceeds the allowed limit", 422);
  }
  if (Number(input.bookingRangeDays) !== bookingRangeDays) {
    throw protocolError("COLLECTION_WORKER_V2_TOP20_DATE_RANGE_INVALID", "collection date range day count is invalid", 422);
  }
  const serialized = JSON.stringify(input);
  if (/(?:https?|wss?):\/\/|"(?:url|headers?|cookies?|credentials?|secret|token|password)"\s*:/iu.test(serialized)) {
    throw protocolError("COLLECTION_WORKER_V2_TOP20_SENSITIVE_INPUT", "top20 contract contains forbidden transport data");
  }
  return Object.freeze({
    keyword,
    keywordHash: sha256Hex(keyword),
    searchMode: "keyword",
    collectionMode: "precision",
    collectionPurpose: "revenue_detail",
    productMode: "all",
    checkIn,
    checkOut,
    measurementPeriod: Object.freeze({ start: checkIn, end: checkOut }),
    bookingRangeDays,
    scheduleRequestGranularity: V2_TOP20_SCHEDULE_REQUEST_GRANULARITY,
    rankStart: V2_TOP20_CONTRACT.mainPlaceRankStart,
    rankEnd: V2_TOP20_CONTRACT.mainPlaceRankEnd,
    detailRankStart: V2_TOP20_CONTRACT.inventoryRankStart,
    detailRankEnd: V2_TOP20_CONTRACT.inventoryRankEnd
  });
}

function buildV2Top20ExecutionContract(input = {}) {
  const normalized = normalizeV2Top20PrepareContract(input);
  const plan = v2Top20ResiliencePlan(normalized.bookingRangeDays);
  return Object.freeze({
    schemaVersion: V2_TOP20_SCHEMA_VERSION,
    profile: V2_TOP20_PROFILE,
    collectorScope: V2_TOP20_SCOPE,
    keywordHash: normalized.keywordHash,
    searchMode: normalized.searchMode,
    collectionMode: normalized.collectionMode,
    collectionPurpose: normalized.collectionPurpose,
    productMode: normalized.productMode,
    checkIn: normalized.checkIn,
    checkOut: normalized.checkOut,
    measurementPeriod: normalized.measurementPeriod,
    bookingRangeDays: normalized.bookingRangeDays,
    scheduleRequestGranularity: plan.scheduleRequestGranularity,
    rankStart: normalized.rankStart,
    rankEnd: normalized.rankEnd,
    detailRankStart: normalized.detailRankStart,
    detailRankEnd: normalized.detailRankEnd,
    maximumProviderCalls: plan.maximumProviderCalls,
    concurrency: V2_TOP20_CONTRACT.concurrency,
    automaticRetry: false,
    automaticFallback: false
  });
}

function computeV2Top20ContractHash(input = {}) {
  const contract = Object.prototype.hasOwnProperty.call(input, "keyword")
    ? buildV2Top20ExecutionContract(input)
    : input;
  exactKeys(contract, [
    "schemaVersion",
    "profile",
    "collectorScope",
    "keywordHash",
    "searchMode",
    "collectionMode",
    "collectionPurpose",
    "productMode",
    "checkIn",
    "checkOut",
    "measurementPeriod",
    "bookingRangeDays",
    "scheduleRequestGranularity",
    "rankStart",
    "rankEnd",
    "detailRankStart",
    "detailRankEnd",
    "maximumProviderCalls",
    "concurrency",
    "automaticRetry",
    "automaticFallback"
  ], "top20 execution contract");
  return sha256Hex(stableJson({
    domain: "lodging-datalab.collection-worker.top20-contract.v1",
    contract
  }));
}

function normalizeV2Top20ExecutionRequestId(value) {
  const executionRequestId = String(value || "").trim();
  if (!EXECUTION_REQUEST_ID_PATTERN.test(executionRequestId)) {
    throw protocolError(
      "COLLECTION_WORKER_V2_TOP20_EXECUTION_REQUEST_INVALID",
      "top20 execution request ID is invalid",
      400
    );
  }
  return executionRequestId;
}

function computeV2Top20ExecutionRequestHash(value) {
  const executionRequestId = normalizeV2Top20ExecutionRequestId(value);
  return sha256Hex(stableJson({
    domain: "lodging-datalab.top20-execution-request.v1",
    executionRequestId
  }));
}

function buildV2Top20ExecutionIdempotencyKey(input = {}) {
  const contractIdempotencyKey = String(input.contractIdempotencyKey || "");
  const executionRequestHash = String(input.executionRequestHash || "");
  const jobId = String(input.jobId || "");
  const attemptId = String(input.attemptId || "");
  if (
    !HASH_PATTERN.test(contractIdempotencyKey)
    || !HASH_PATTERN.test(executionRequestHash)
    || !/^job-top20-[a-f0-9]{12}-[a-f0-9]{12}$/u.test(jobId)
    || !/^attempt:top20-[a-f0-9]{12}-[a-f0-9]{12}$/u.test(attemptId)
  ) {
    throw protocolError("COLLECTION_WORKER_V2_TOP20_INPUT_INVALID", "top20 execution idempotency input is invalid");
  }
  return sha256Hex(stableJson({
    domain: "lodging-datalab.top20-job-execution.v1",
    contractIdempotencyKey,
    executionRequestHash,
    jobId,
    attemptId
  }));
}

// collection_worker_contract.v1 signs the fixed single-day top-three compatibility
// shape. The full Top20 range hash is bound by the signed approvalId and is
// rechecked by the Worker and the signed artifact. This bridge deliberately
// projects the generic envelope to its supported one-day shape; it must never
// alter the Top20 execution payload or its range-aware hash.
function buildV2Top20DispatchCompatibilityContract(input = {}) {
  const normalized = normalizeV2Top20PrepareContract(input);
  return Object.freeze({
    keyword: normalized.keyword,
    searchMode: normalized.searchMode,
    collectionMode: normalized.collectionMode,
    collectionPurpose: normalized.collectionPurpose,
    productMode: normalized.productMode,
    checkIn: normalized.checkIn,
    checkOut: normalized.checkIn,
    rankStart: normalized.rankStart,
    rankEnd: normalized.rankEnd,
    detailRankStart: 1,
    detailRankEnd: 3
  });
}

function top20ApprovalId(contractHash, executionRequestHash = null) {
  const hash = String(contractHash || "");
  if (!HASH_PATTERN.test(hash)) {
    throw protocolError("COLLECTION_WORKER_V2_TOP20_CONTRACT_INVALID", "top20 contract hash is invalid");
  }
  if (executionRequestHash === null) return `approval:top20:${hash}`;
  if (!HASH_PATTERN.test(String(executionRequestHash || ""))) {
    throw protocolError("COLLECTION_WORKER_V2_TOP20_CONTRACT_INVALID", "top20 execution request hash is invalid");
  }
  // Both full hashes are signed by collection_worker_contract.v1.  A prefix
  // is still used for the durable job/attempt identifiers, but never for the
  // approval that authorizes this precise range-aware execution.
  return `approval:top20:v2:${hash}:${String(executionRequestHash)}`;
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
    throw protocolError("COLLECTION_WORKER_V2_TOP20_KEY_INVALID", "top20 protocol key is invalid", 500);
  }
}

function artifactKeyProofPayload(input = {}) {
  const payload = {
    schemaVersion: COLLECTION_WORKER_V2_TOP20_PROTOCOL_SCHEMA_VERSION,
    artifactKeyId: COLLECTION_WORKER_V2_TOP20_ARTIFACT_KEY_ID,
    jobId: String(input.jobId || ""),
    attemptId: String(input.attemptId || ""),
    workflowRevision: Number(input.workflowRevision),
    workerId: String(input.workerId || ""),
    workerPoolId: String(input.workerPoolId || ""),
    workerCommit: String(input.workerCommit || ""),
    runtimeId: String(input.runtimeId || ""),
    contractHash: String(input.contractHash || ""),
    executionIdentityHash: String(input.executionIdentityHash || ""),
    top20ContractHash: String(input.top20ContractHash || "")
  };
  if (
    !/^job[-_][a-z0-9][a-z0-9_-]{7,95}$/u.test(payload.jobId)
    || !/^[a-z0-9][a-z0-9._:-]{2,127}$/u.test(payload.attemptId)
    || !Number.isInteger(payload.workflowRevision)
    || payload.workflowRevision < 1
    || payload.workerId !== COLLECTION_WORKER_V2_TOP20_WORKER_ID
    || payload.workerPoolId !== COLLECTION_WORKER_V2_TOP20_WORKER_POOL_ID
    || !/^[a-f0-9]{40}$/u.test(payload.workerCommit)
    || !/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/u.test(payload.runtimeId)
    || !HASH_PATTERN.test(payload.contractHash)
    || !HASH_PATTERN.test(payload.executionIdentityHash)
    || !HASH_PATTERN.test(payload.top20ContractHash)
  ) {
    throw protocolError("COLLECTION_WORKER_V2_TOP20_PREFLIGHT_INVALID", "top20 artifact key proof input is invalid");
  }
  return Object.freeze(payload);
}

function artifactKeyProofBytes(payload) {
  return Buffer.from(`${COLLECTION_WORKER_V2_TOP20_ARTIFACT_PROOF_DOMAIN}\n${stableJson(payload)}`, "utf8");
}

function buildV2Top20ArtifactKeyProof(input, privateKey) {
  const payload = artifactKeyProofPayload(input);
  const signature = crypto.sign(null, artifactKeyProofBytes(payload), privateKey).toString("base64url");
  return Object.freeze({ payload, signature });
}

function verifyV2Top20ArtifactKeyProof(value, expected, publicKey) {
  exactKeys(value, ["payload", "signature"], "top20 artifact key proof");
  const payload = artifactKeyProofPayload(value.payload);
  const expectedPayload = artifactKeyProofPayload(expected);
  const signature = String(value.signature || "");
  if (
    stableJson(payload) !== stableJson(expectedPayload)
    || !SIGNATURE_PATTERN.test(signature)
    || !crypto.verify(null, artifactKeyProofBytes(payload), publicKey, Buffer.from(signature, "base64url"))
  ) {
    throw protocolError("COLLECTION_WORKER_V2_TOP20_ARTIFACT_KEY_MISMATCH", "top20 artifact key proof verification failed", 401);
  }
  return payload;
}

module.exports = {
  COLLECTION_WORKER_V2_TOP20_ARTIFACT_DIAGNOSTIC_PATH,
  COLLECTION_WORKER_V2_TOP20_ARTIFACT_KEY_ID,
  COLLECTION_WORKER_V2_TOP20_BACKEND_ID,
  COLLECTION_WORKER_V2_TOP20_BOOKING_DETAIL_PROBE_FINALIZE_PATH,
  COLLECTION_WORKER_V2_TOP20_BOOKING_DETAIL_PROBE_PROFILE,
  COLLECTION_WORKER_V2_TOP20_CLAIM_PATH,
  COLLECTION_WORKER_V2_TOP20_DISPATCH_KEY_ID,
  COLLECTION_WORKER_V2_TOP20_FAILURE_PATH,
  COLLECTION_WORKER_V2_TOP20_MAIN_PLACE_PROBE_FINALIZE_PATH,
  COLLECTION_WORKER_V2_TOP20_MAIN_PLACE_PROBE_PROFILE,
  COLLECTION_WORKER_V2_TOP20_FINALIZE_PATH,
  COLLECTION_WORKER_V2_TOP20_HEARTBEAT_PATH,
  COLLECTION_WORKER_V2_TOP20_PREFLIGHT_PATH,
  COLLECTION_WORKER_V2_TOP20_PREPARE_PATH,
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
  CollectionWorkerV2Top20ProtocolError,
  artifactKeyProofPayload,
  buildV2Top20ArtifactKeyProof,
  buildV2Top20DispatchCompatibilityContract,
  buildV2Top20ExecutionIdempotencyKey,
  buildV2Top20ExecutionContract,
  computeV2Top20ExecutionRequestHash,
  computeV2Top20ContractHash,
  decodeEd25519Key,
  normalizeV2Top20PrepareContract,
  normalizeV2Top20ExecutionRequestId,
  sha256Hex,
  stableJson,
  top20ApprovalId,
  verifyV2Top20ArtifactKeyProof
};
