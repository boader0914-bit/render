"use strict";

const assert = require("node:assert/strict");
const { installFixtureNetworkGuard } = require("./fixture_network_guard.cjs");
const {
  beginProviderAttempt,
  computeProviderCooldownSeconds,
  createInitialProviderCircuitState,
  providerAvailability,
  PROVIDER_ATTEMPT_LEASE_SECONDS,
  refreshProviderAttemptLease,
  recordProviderBlock,
  recordProviderSuccess,
  releaseProviderAttempt,
  validateProviderCircuitState
} = require("./naver_provider_resilience.cjs");

const networkGuard = installFixtureNetworkGuard({ label: "NAVER provider circuit fixtures" });

function plus(instant, seconds) {
  return new Date(Date.parse(instant) + seconds * 1000).toISOString();
}

function main() {
  const t0 = "2026-08-05T09:00:00.000Z";
  const initial = createInitialProviderCircuitState({ now: t0 });
  assert.equal(validateProviderCircuitState(initial), true);
  assert.equal(initial.state, "closed");
  assert.equal(initial.workflowRevision, 0);

  const normal = beginProviderAttempt(initial, {
    expectedWorkflowRevision: 0,
    now: t0,
    explicit: true
  });
  assert.equal(normal.allowed, true);
  assert.equal(normal.attemptKind, "normal");
  assert.equal(normal.state.state, "probe_allowed", "the reservation is a single-flight lease");
  assert.equal(normal.state.workflowRevision, 1);

  const duplicate = beginProviderAttempt(normal.state, {
    expectedWorkflowRevision: 1,
    now: plus(t0, 1),
    explicit: true
  });
  assert.equal(duplicate.allowed, false);
  assert.equal(duplicate.reason, "probe_in_flight");
  assert.equal(duplicate.state.workflowRevision, 1);
  assert.equal(duplicate.retryAt, plus(t0, PROVIDER_ATTEMPT_LEASE_SECONDS));

  const heartbeatAt = plus(t0, 60);
  const heartbeat = refreshProviderAttemptLease(normal.state, {
    expectedWorkflowRevision: 1,
    now: heartbeatAt
  });
  assert.equal(heartbeat.workflowRevision, 2);
  assert.equal(heartbeat.lastAttemptAt, t0, "a lease heartbeat preserves the original provider attempt time");
  assert.equal(heartbeat.updatedAt, heartbeatAt);
  const protectedAtOriginalExpiry = beginProviderAttempt(heartbeat, {
    expectedWorkflowRevision: 2,
    now: plus(t0, PROVIDER_ATTEMPT_LEASE_SECONDS),
    explicit: true
  });
  assert.equal(protectedAtOriginalExpiry.allowed, false, "a live heartbeat prevents recovery at the original lease boundary");
  assert.equal(protectedAtOriginalExpiry.reason, "probe_in_flight");
  assert.equal(protectedAtOriginalExpiry.retryAt, plus(heartbeatAt, PROVIDER_ATTEMPT_LEASE_SECONDS));
  const recoveredAfterHeartbeatLease = beginProviderAttempt(heartbeat, {
    expectedWorkflowRevision: 2,
    now: plus(heartbeatAt, PROVIDER_ATTEMPT_LEASE_SECONDS),
    explicit: true
  });
  assert.equal(recoveredAfterHeartbeatLease.allowed, true);
  assert.equal(recoveredAfterHeartbeatLease.reason, "stale_attempt_recovered");

  const staleNormalReservation = beginProviderAttempt(normal.state, {
    expectedWorkflowRevision: 1,
    now: plus(t0, PROVIDER_ATTEMPT_LEASE_SECONDS),
    explicit: true
  });
  assert.equal(staleNormalReservation.allowed, true, "an interrupted normal reservation has a bounded lease");
  assert.equal(staleNormalReservation.attemptKind, "normal");
  assert.equal(staleNormalReservation.reason, "stale_attempt_recovered");
  assert.equal(staleNormalReservation.state.workflowRevision, 2);

  const firstBlock = recordProviderBlock(normal.state, {
    subtype: "http_403",
    httpStatus: 403,
    diagnosticId: "crawl-c6ddda12830f",
    rawBody: "must never persist"
  }, {
    expectedWorkflowRevision: 1,
    now: plus(t0, 2)
  });
  assert.equal(firstBlock.state, "open");
  assert.equal(firstBlock.consecutiveBlocks, 1);
  assert.equal(firstBlock.retryAt, plus(t0, 1802));
  assert.equal(firstBlock.workflowRevision, 2);

  const cooling = beginProviderAttempt(firstBlock, {
    expectedWorkflowRevision: 2,
    now: plus(t0, 300),
    explicit: true
  });
  assert.equal(cooling.allowed, false);
  assert.equal(cooling.reason, "cooldown_active");
  assert.equal(providerAvailability(firstBlock, { now: plus(t0, 300) }).retryAfterSeconds, 1502);

  const passiveAfterExpiry = beginProviderAttempt(firstBlock, {
    expectedWorkflowRevision: 2,
    now: firstBlock.retryAt,
    explicit: false
  });
  assert.equal(passiveAfterExpiry.allowed, false);
  assert.equal(passiveAfterExpiry.reason, "explicit_probe_required", "expiry never triggers an automatic probe");

  const probe = beginProviderAttempt(firstBlock, {
    expectedWorkflowRevision: 2,
    now: firstBlock.retryAt,
    explicit: true
  });
  assert.equal(probe.allowed, true);
  assert.equal(probe.attemptKind, "probe");
  assert.equal(probe.state.workflowRevision, 3);

  const stalePassiveProbe = beginProviderAttempt(probe.state, {
    expectedWorkflowRevision: 3,
    now: plus(firstBlock.retryAt, PROVIDER_ATTEMPT_LEASE_SECONDS),
    explicit: false
  });
  assert.equal(stalePassiveProbe.allowed, false);
  assert.equal(stalePassiveProbe.reason, "explicit_probe_required");

  const staleExplicitProbe = beginProviderAttempt(probe.state, {
    expectedWorkflowRevision: 3,
    now: plus(firstBlock.retryAt, PROVIDER_ATTEMPT_LEASE_SECONDS),
    explicit: true
  });
  assert.equal(staleExplicitProbe.allowed, true);
  assert.equal(staleExplicitProbe.attemptKind, "probe");
  assert.equal(staleExplicitProbe.reason, "stale_attempt_recovered");

  const secondBlock = recordProviderBlock(probe.state, {
    subtype: "challenge_html",
    diagnosticId: "crawl-0123456789ab"
  }, {
    expectedWorkflowRevision: 3,
    now: plus(firstBlock.retryAt, 1)
  });
  assert.equal(secondBlock.consecutiveBlocks, 2);
  assert.equal(Date.parse(secondBlock.retryAt) - Date.parse(secondBlock.openedAt), 60 * 60 * 1000);

  const secondProbe = beginProviderAttempt(secondBlock, {
    expectedWorkflowRevision: 4,
    now: secondBlock.retryAt,
    explicit: true
  });
  const thirdBlock = recordProviderBlock(secondProbe.state, {
    subtype: "http_403",
    diagnosticId: "crawl-abcdef012345"
  }, {
    expectedWorkflowRevision: 5,
    now: plus(secondBlock.retryAt, 1)
  });
  assert.equal(thirdBlock.consecutiveBlocks, 3);
  assert.equal(Date.parse(thirdBlock.retryAt) - Date.parse(thirdBlock.openedAt), 120 * 60 * 1000);

  const thirdProbe = beginProviderAttempt(thirdBlock, {
    expectedWorkflowRevision: 6,
    now: thirdBlock.retryAt,
    explicit: true
  });
  const success = recordProviderSuccess(thirdProbe.state, {
    expectedWorkflowRevision: 7,
    now: plus(thirdBlock.retryAt, 1)
  });
  assert.equal(success.state, "closed");
  assert.equal(success.consecutiveBlocks, 0);
  assert.equal(success.retryAt, null);
  assert.equal(success.lastFailureSubtype, null);
  assert.equal(success.workflowRevision, 8);

  assert.equal(computeProviderCooldownSeconds({
    subtype: "http_429",
    consecutiveBlocks: 1
  }), 900);
  assert.equal(computeProviderCooldownSeconds({
    subtype: "http_429",
    retryAfterSeconds: 300,
    consecutiveBlocks: 3
  }), 300, "a valid bounded Retry-After takes precedence");

  const released = releaseProviderAttempt(beginProviderAttempt(success, {
    expectedWorkflowRevision: 8,
    now: plus(thirdBlock.retryAt, 2)
  }).state, {
    expectedWorkflowRevision: 9,
    now: plus(thirdBlock.retryAt, 3)
  });
  assert.equal(released.state, "closed");
  assert.equal(released.workflowRevision, 10);

  assert.throws(
    () => beginProviderAttempt(success, { expectedWorkflowRevision: 7, now: t0 }),
    (error) => error.code === "NAVER_PROVIDER_WORKFLOW_REVISION_CONFLICT" && error.statusCode === 409
  );
  assert.throws(
    () => recordProviderBlock(success, { subtype: "http_403" }, {
      expectedWorkflowRevision: 8,
      now: plus(thirdBlock.retryAt, 4)
    }),
    (error) => error.code === "NAVER_PROVIDER_ATTEMPT_NOT_RESERVED" && error.statusCode === 409,
    "an outcome cannot bypass the single-flight reservation"
  );
  assert.equal(validateProviderCircuitState({ ...success, query: "private" }), false, "unknown fields fail closed");
  assert.equal(validateProviderCircuitState({ ...initial, state: "probe_allowed" }), false, "a reserved state requires a durable attempt lease");
  assert.equal(validateProviderCircuitState({
    ...initial,
    state: "probe_allowed",
    lastAttemptAt: t0,
    consecutiveBlocks: 1
  }), false, "partial incident tuples fail closed");
  assert.equal(validateProviderCircuitState({
    ...firstBlock,
    retryAt: plus(firstBlock.openedAt, -1)
  }), false, "an incident retry time cannot precede its open time");
  assert.equal(networkGuard.blockedAttempts(), 0);

  console.log("NAVER provider circuit breaker state transition tests passed.");
}

try {
  main();
} finally {
  networkGuard.restore();
}
