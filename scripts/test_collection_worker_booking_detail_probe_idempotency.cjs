"use strict";

const assert = require("node:assert/strict");
const {
  buildBookingDetailProbeExecutionIdempotencyKey,
  buildV2Top20ExecutionIdempotencyKey
} = require("./collection_worker_v2_top20_protocol.cjs");
const { installFixtureNetworkGuard } = require("./fixture_network_guard.cjs");

const guard = installFixtureNetworkGuard({ label: "booking-detail probe idempotency fixtures" });

try {
  const contractIdempotencyKey = "a".repeat(64);
  const executionRequestHash = "b".repeat(64);
  const targetIdentityHash = "c".repeat(64);
  const jobId = `job-booking-detail-probe-${targetIdentityHash.slice(0, 12)}-${executionRequestHash.slice(0, 12)}`;
  const attemptId = `attempt:booking-detail-probe-${targetIdentityHash.slice(0, 12)}-${executionRequestHash.slice(0, 12)}`;
  const key = buildBookingDetailProbeExecutionIdempotencyKey({
    contractIdempotencyKey,
    executionRequestHash,
    targetIdentityHash,
    jobId,
    attemptId
  });
  assert.match(key, /^[a-f0-9]{64}$/u);
  assert.equal(key, buildBookingDetailProbeExecutionIdempotencyKey({
    contractIdempotencyKey,
    executionRequestHash,
    targetIdentityHash,
    jobId,
    attemptId
  }));
  assert.notEqual(key, buildBookingDetailProbeExecutionIdempotencyKey({
    contractIdempotencyKey,
    executionRequestHash,
    targetIdentityHash: "d".repeat(64),
    jobId,
    attemptId
  }));
  assert.throws(
    () => buildBookingDetailProbeExecutionIdempotencyKey({ contractIdempotencyKey, executionRequestHash, targetIdentityHash, jobId: "job-top20-aaaaaaaaaaaa-bbbbbbbbbbbb", attemptId: "attempt:top20-aaaaaaaaaaaa-bbbbbbbbbbbb" }),
    { code: "COLLECTION_WORKER_BOOKING_DETAIL_PROBE_IDEMPOTENCY_INVALID" }
  );
  assert.throws(
    () => buildV2Top20ExecutionIdempotencyKey({ contractIdempotencyKey, executionRequestHash, jobId, attemptId }),
    { code: "COLLECTION_WORKER_V2_TOP20_INPUT_INVALID" }
  );
  assert.throws(
    () => buildBookingDetailProbeExecutionIdempotencyKey({ contractIdempotencyKey, executionRequestHash, targetIdentityHash, jobId: `${jobId}x`, attemptId }),
    { code: "COLLECTION_WORKER_BOOKING_DETAIL_PROBE_IDEMPOTENCY_INVALID" }
  );
  assert.equal(guard.blockedAttempts(), 0);
  console.log("booking-detail probe idempotency fixtures passed");
} finally {
  guard.restore();
}
