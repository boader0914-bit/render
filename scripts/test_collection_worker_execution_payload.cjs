"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const {
  COLLECTION_WORKER_JOB_AUDIENCE,
  buildSignedJobEnvelope,
  verifySignedJobEnvelope
} = require("./collection_worker_contract.cjs");
const {
  buildCollectionWorkerExecutionPayload,
  projectSafeWorkerExecutionPayload,
  verifyCollectionWorkerExecutionPayload
} = require("./collection_worker_execution_payload.cjs");

const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
const contract = {
  keyword: "Synthetic region lodging",
  searchMode: "keyword",
  collectionMode: "precision",
  collectionPurpose: "revenue_detail",
  productMode: "all",
  checkIn: "2026-08-06",
  checkOut: "2026-08-06",
  rankStart: 1,
  rankEnd: 50,
  detailRankStart: 1,
  detailRankEnd: 3
};
const now = new Date("2026-08-06T04:00:00.000Z");
const signed = buildSignedJobEnvelope({
  jobId: "job_fixture_20260806_001",
  attemptId: "attempt_fixture_001",
  approvalId: "approval_fixture_001",
  audience: COLLECTION_WORKER_JOB_AUDIENCE,
  workerId: "collector_worker_fixture_01",
  workerPoolId: "collector_pool_fixture_01",
  nonce: "fixture_nonce_20260806_0001",
  contract,
  authorization: {
    enabled: true,
    actualCallsEnabled: true,
    externalCallApproved: true,
    authorizedExecutionCount: 1
  }
}, {
  privateKey,
  signerKeyId: "preview_dispatch_key_v1",
  now,
  ttlSeconds: 120
});
const envelope = verifySignedJobEnvelope(signed, {
  publicKey,
  expectedSignerKeyId: "preview_dispatch_key_v1",
  expectedAudience: COLLECTION_WORKER_JOB_AUDIENCE,
  expectedWorkerId: "collector_worker_fixture_01",
  expectedWorkerPoolId: "collector_pool_fixture_01",
  now,
  clockSkewSeconds: 0
});

const payload = buildCollectionWorkerExecutionPayload({
  jobId: envelope.jobId,
  attemptId: envelope.attemptId,
  contract
}, envelope);
assert.equal(verifyCollectionWorkerExecutionPayload(payload, envelope).contract.keyword, contract.keyword);
const safe = projectSafeWorkerExecutionPayload(payload);
assert.equal(Object.prototype.hasOwnProperty.call(safe, "keyword"), false);
assert.equal(JSON.stringify(safe).includes(contract.keyword), false);
assert.match(safe.keywordHash, /^[a-f0-9]{64}$/u);

assert.throws(
  () => buildCollectionWorkerExecutionPayload({
    jobId: envelope.jobId,
    attemptId: envelope.attemptId,
    contract: { ...contract, keyword: "Different synthetic region lodging" }
  }, envelope),
  { code: "COLLECTION_WORKER_EXECUTION_CONTRACT_MISMATCH", statusCode: 409 }
);
assert.throws(
  () => buildCollectionWorkerExecutionPayload({
    jobId: envelope.jobId,
    attemptId: envelope.attemptId,
    contract: { ...contract, url: "https://example.invalid" }
  }, envelope),
  { code: "COLLECTION_WORKER_EXECUTION_PAYLOAD_INVALID", statusCode: 400 }
);
assert.throws(
  () => verifyCollectionWorkerExecutionPayload({ ...payload, outputDir: "/var/data/output" }, envelope),
  { code: "COLLECTION_WORKER_EXECUTION_PAYLOAD_INVALID", statusCode: 400 }
);

console.log("Collection worker in-memory execution payload fixture checks passed");
