"use strict";

const assert = require("node:assert/strict");
const {
  buildV2CollectionJobIdentity,
  buildV2CollectionPlan,
  normalizeV2CollectionRequest
} = require("./v2_collection_request.cjs");
const {
  buildCollectionWorkerJobEnvelope,
  computeCollectionContractHash,
  normalizeCollectionJobContract,
  V2_SINGLE_SOURCE_WORKER_COLLECTOR
} = require("./collection_worker_contract.cjs");

const base = Object.freeze({
  keyword: "synthetic glamping",
  searchMode: "keyword",
  collectionMode: "precision",
  collectionPurpose: "revenue_detail",
  productMode: "all",
  checkIn: "2026-08-23",
  checkOut: "2026-08-25",
  bookingRangeDays: 3,
  rankStart: 1,
  rankEnd: 50,
  detailRankStart: 1,
  detailRankEnd: 20,
  clientRequestId: "fixture-v2-request-0001"
});

const normalized = normalizeV2CollectionRequest(base);
assert.equal(normalized.schemaVersion, "collection-worker-v2-request.v2");
assert.equal(normalized.bookingRangeDays, 3);
assert.equal(normalized.measurementPeriod.start, "2026-08-23");
assert.equal(normalized.measurementPeriod.end, "2026-08-25");
assert.equal(buildV2CollectionPlan(normalized).maximumProviderCalls, 561);

const oneDay = normalizeV2CollectionRequest({
  ...base,
  checkOut: "2026-08-23",
  bookingRangeDays: 1,
  clientRequestId: "fixture-v2-request-one-day"
});
assert.equal(buildV2CollectionPlan(oneDay).maximumProviderCalls, 241);

const sevenDays = normalizeV2CollectionRequest({
  ...base,
  checkOut: "2026-08-29",
  bookingRangeDays: 7,
  clientRequestId: "fixture-v2-request-seven-days"
});
assert.equal(buildV2CollectionPlan(sevenDays).maximumProviderCalls, 1201);

const identity = buildV2CollectionJobIdentity(base);
assert.match(identity.jobId, /^job-v2-[a-f0-9]{12}-[a-f0-9]{12}$/u);
assert.match(identity.attemptId, /^attempt:v2-[a-f0-9]{12}-[a-f0-9]{12}$/u);
assert.equal(identity.contractHash, normalized.contractHash);
assert.equal(identity.executionRequestHash, normalized.executionRequestHash);

const normalizedContract = normalizeCollectionJobContract(normalized);
assert.equal(computeCollectionContractHash(normalizedContract), normalized.contractHash);
assert.equal(normalizedContract.clientRequestId, base.clientRequestId);

const envelope = buildCollectionWorkerJobEnvelope({
  jobId: identity.jobId,
  attemptId: identity.attemptId,
  approvalId: `approval:v2:${normalized.contractHash}`,
  audience: "lodging-datalab-preview.collector-worker",
  workerId: "collector_worker_preview_top20_01",
  workerPoolId: "collector_pool_preview_top20_01",
  collector: V2_SINGLE_SOURCE_WORKER_COLLECTOR,
  contract: normalized,
  authorization: { enabled: true, actualCallsEnabled: true, externalCallApproved: true, authorizedExecutionCount: 1 },
  nonce: "fixture-v2-single-contract-nonce"
}, { now: new Date("2026-08-11T00:00:00.000Z") });
assert.equal(envelope.contract.checkOut, "2026-08-25");
assert.equal(envelope.contract.detailRankEnd, 20);
assert.equal(envelope.collector.collectorScope, "v2_collector_single_source");
assert.equal(envelope.contractHash, normalized.contractHash);

assert.throws(() => normalizeV2CollectionRequest({ ...base, checkOut: "2026-08-30", bookingRangeDays: 8 }), /range|request/u);
assert.throws(() => normalizeV2CollectionRequest({ ...base, bookingRangeDays: 1 }), /day count/u);

console.log("v2 single contract worker fixtures passed");
