"use strict";

const {
  computeCollectionContractHash,
  normalizeCollectionJobContract
} = require("./collection_worker_contract.cjs");

const COLLECTION_WORKER_EXECUTION_PAYLOAD_SCHEMA_VERSION = "collection-worker-execution-payload.v1";
const JOB_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,159}$/u;
const RAW_CONTRACT_KEYS = Object.freeze([
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

class CollectionWorkerExecutionPayloadError extends Error {
  constructor(code, message, statusCode = 400) {
    super(message);
    this.name = "CollectionWorkerExecutionPayloadError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

function payloadError(code, message, statusCode = 400) {
  return new CollectionWorkerExecutionPayloadError(code, message, statusCode);
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw payloadError("COLLECTION_WORKER_EXECUTION_PAYLOAD_INVALID", `${label} is invalid`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw payloadError("COLLECTION_WORKER_EXECUTION_PAYLOAD_INVALID", `${label} fields are invalid`);
  }
}

function safeIdentity(value, label) {
  const text = String(value || "").trim();
  if (!JOB_ID_PATTERN.test(text)) throw payloadError("COLLECTION_WORKER_EXECUTION_PAYLOAD_INVALID", `${label} is invalid`);
  return text;
}

function rawContract(input) {
  exactKeys(input, RAW_CONTRACT_KEYS, "worker execution contract");
  const keyword = String(input.keyword || "").trim();
  if (!keyword || keyword.length > 120 || /[\r\n\0]/u.test(keyword)) {
    throw payloadError("COLLECTION_WORKER_EXECUTION_PAYLOAD_INVALID", "worker execution keyword is invalid");
  }
  const forbiddenText = JSON.stringify(input);
  if (/(?:https?|wss?):\/\/|"(?:url|headers?|cookies?|credentials?|secret|token|password)"\s*:/iu.test(forbiddenText)) {
    throw payloadError("COLLECTION_WORKER_EXECUTION_PAYLOAD_SENSITIVE", "worker execution payload contains forbidden transport data");
  }
  return Object.freeze({
    keyword,
    searchMode: String(input.searchMode || ""),
    collectionMode: String(input.collectionMode || ""),
    collectionPurpose: String(input.collectionPurpose || ""),
    productMode: String(input.productMode || ""),
    checkIn: String(input.checkIn || ""),
    checkOut: String(input.checkOut || ""),
    rankStart: Number(input.rankStart),
    rankEnd: Number(input.rankEnd),
    detailRankStart: Number(input.detailRankStart),
    detailRankEnd: Number(input.detailRankEnd)
  });
}

function buildCollectionWorkerExecutionPayload(input = {}, signedEnvelope = {}) {
  const contract = rawContract(input.contract || {});
  const normalized = normalizeCollectionJobContract(contract);
  const contractHash = computeCollectionContractHash(normalized);
  if (
    contractHash !== String(signedEnvelope.contractHash || "")
    || signedEnvelope.jobId !== input.jobId
    || signedEnvelope.attemptId !== input.attemptId
  ) {
    throw payloadError(
      "COLLECTION_WORKER_EXECUTION_CONTRACT_MISMATCH",
      "worker execution payload does not match the signed job",
      409
    );
  }
  return Object.freeze({
    schemaVersion: COLLECTION_WORKER_EXECUTION_PAYLOAD_SCHEMA_VERSION,
    jobId: safeIdentity(input.jobId, "jobId"),
    attemptId: safeIdentity(input.attemptId, "attemptId"),
    contractHash,
    contract
  });
}

function verifyCollectionWorkerExecutionPayload(value = {}, signedEnvelope = {}) {
  exactKeys(value, ["schemaVersion", "jobId", "attemptId", "contractHash", "contract"], "worker execution payload");
  if (value.schemaVersion !== COLLECTION_WORKER_EXECUTION_PAYLOAD_SCHEMA_VERSION) {
    throw payloadError("COLLECTION_WORKER_EXECUTION_PAYLOAD_INVALID", "worker execution payload schema is invalid");
  }
  return buildCollectionWorkerExecutionPayload({
    jobId: value.jobId,
    attemptId: value.attemptId,
    contract: value.contract
  }, signedEnvelope);
}

function projectSafeWorkerExecutionPayload(value = {}) {
  return Object.freeze({
    schemaVersion: value.schemaVersion,
    jobId: String(value.jobId || ""),
    attemptId: String(value.attemptId || ""),
    contractHash: String(value.contractHash || ""),
    keywordHash: value.contract ? normalizeCollectionJobContract(value.contract).keywordHash : "",
    measurementPeriod: value.contract ? {
      start: String(value.contract.checkIn || ""),
      end: String(value.contract.checkOut || "")
    } : null,
    rankRange: value.contract ? {
      start: Number(value.contract.rankStart),
      end: Number(value.contract.rankEnd)
    } : null
  });
}

module.exports = {
  COLLECTION_WORKER_EXECUTION_PAYLOAD_SCHEMA_VERSION,
  CollectionWorkerExecutionPayloadError,
  buildCollectionWorkerExecutionPayload,
  projectSafeWorkerExecutionPayload,
  verifyCollectionWorkerExecutionPayload
};
