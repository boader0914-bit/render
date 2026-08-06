"use strict";

const assert = require("node:assert/strict");
const {
  V2_TOP20_CONTRACT,
  V2_TOP20_OPERATION_BUDGETS,
  buildV2Top20MaximumExecutionPlan,
  createV2Top20ExecutionState,
  decideV2Top20Persistence,
  evaluateV2Top20HeartbeatRequirement,
  evaluateV2Top20ProviderGate,
  getV2Top20NextProviderCall,
  markV2Top20Persisted,
  markV2Top20Validation,
  recordV2Top20ProviderResult,
  reserveV2Top20ProviderCall,
  startV2Top20Execution,
  validateCallLedger,
  validateExecutionState
} = require("../scripts/collection_worker_v2_top20_contract.cjs");

assert.deepEqual(V2_TOP20_OPERATION_BUDGETS, {
  main_place: 1,
  booking_business: 20,
  booking_items: 20,
  daily_schedule: 160
});
assert.equal(V2_TOP20_CONTRACT.maximumProviderCalls, 201);
assert.equal(V2_TOP20_CONTRACT.concurrency, 1);
assert.equal(V2_TOP20_CONTRACT.automaticRetry, false);
assert.equal(V2_TOP20_CONTRACT.automaticFallback, false);
assert.equal(V2_TOP20_CONTRACT.heartbeatBeforeEveryProviderCall, true);
assert.equal(V2_TOP20_CONTRACT.defaultEnabled, false);
assert.equal(V2_TOP20_CONTRACT.minimumLeaseRemainingMs, 30_000);
assert.equal(V2_TOP20_CONTRACT.saveRunOnSuccessOnly, true);
assert.equal(V2_TOP20_CONTRACT.saveFailureRun, false);
assert.equal(Object.isFrozen(V2_TOP20_CONTRACT), true);

const maximumPlan = buildV2Top20MaximumExecutionPlan();
assert.equal(maximumPlan.length, 201);
assert.deepEqual(maximumPlan[0], {
  requestOrdinal: 1,
  operation: "main_place",
  companyOrdinal: null,
  productOrdinal: null,
  heartbeatRequired: true,
  concurrency: 1
});
assert.deepEqual(maximumPlan[1], {
  requestOrdinal: 2,
  operation: "booking_business",
  companyOrdinal: 1,
  productOrdinal: null,
  heartbeatRequired: true,
  concurrency: 1
});
assert.deepEqual(maximumPlan.at(-1), {
  requestOrdinal: 201,
  operation: "daily_schedule",
  companyOrdinal: 20,
  productOrdinal: 8,
  heartbeatRequired: true,
  concurrency: 1
});
assert.equal(maximumPlan.some((call) => call.companyOrdinal === 21), false);
assert.equal(maximumPlan.some((call) => Number(call.productOrdinal) > 8), false);
assert.equal(Object.isFrozen(maximumPlan), true);

let clock = Date.parse("2026-08-06T00:00:00.000Z");
function nextInstant(step = 1000) {
  clock += step;
  return new Date(clock).toISOString();
}

function startState() {
  const initial = createV2Top20ExecutionState();
  assert.equal(validateExecutionState(initial), initial);
  assert.equal(Object.isFrozen(initial), true);
  return startV2Top20Execution(initial, {
    expectedWorkflowRevision: initial.workflowRevision,
    now: nextInstant()
  });
}

function heartbeatFor(state) {
  const now = nextInstant();
  return {
    now,
    jobHeartbeatAt: now,
    jobLeaseExpiresAt: new Date(Date.parse(now) + 60_000).toISOString(),
    providerHeartbeatAt: now,
    providerLeaseExpiresAt: new Date(Date.parse(now) + 60_000).toISOString()
  };
}

function reserveNext(state) {
  const call = getV2Top20NextProviderCall(state);
  return reserveV2Top20ProviderCall(state, {
    expectedWorkflowRevision: state.workflowRevision,
    call,
    providerGate: {
      circuitState: "closed",
      serviceGlobalLockHeld: true,
      externalCallApproved: true
    },
    heartbeat: heartbeatFor(state)
  });
}

function complete(state, result) {
  return recordV2Top20ProviderResult(state, {
    expectedWorkflowRevision: state.workflowRevision,
    call: state.inFlight,
    completedAt: nextInstant(),
    ...result
  });
}

let heartbeatState = startState();
const missingHeartbeat = evaluateV2Top20HeartbeatRequirement(heartbeatState, { now: nextInstant() });
assert.equal(missingHeartbeat.required, true);
assert.equal(missingHeartbeat.satisfied, false);
assert.deepEqual(missingHeartbeat.blockers, [
  "job_heartbeat_required",
  "provider_heartbeat_required"
]);
assert.throws(
  () => reserveV2Top20ProviderCall(heartbeatState, {
    expectedWorkflowRevision: heartbeatState.workflowRevision,
    call: getV2Top20NextProviderCall(heartbeatState),
    providerGate: { circuitState: "closed", serviceGlobalLockHeld: true, externalCallApproved: true },
    heartbeat: { now: nextInstant() }
  }),
  (error) => error.code === "V2_TOP20_HEARTBEAT_REQUIRED"
);
const expiredAt = nextInstant();
const expiredHeartbeat = evaluateV2Top20HeartbeatRequirement(heartbeatState, {
  now: expiredAt,
  jobHeartbeatAt: expiredAt,
  jobLeaseExpiresAt: expiredAt,
  providerHeartbeatAt: expiredAt,
  providerLeaseExpiresAt: expiredAt
});
assert.equal(expiredHeartbeat.canReserveCall, false);
assert.deepEqual(expiredHeartbeat.blockers, ["job_lease_expired", "provider_lease_expired"]);
assert.deepEqual(evaluateV2Top20ProviderGate({
  circuitState: "probe_allowed",
  serviceGlobalLockHeld: true,
  externalCallApproved: true
}).blockers, ["provider_circuit_closed_required"], "probe_allowed remains reserved for the one-call Canary");
assert.throws(
  () => reserveV2Top20ProviderCall(heartbeatState, {
    expectedWorkflowRevision: heartbeatState.workflowRevision,
    call: getV2Top20NextProviderCall(heartbeatState),
    providerGate: { circuitState: "open", serviceGlobalLockHeld: true, externalCallApproved: true },
    heartbeat: heartbeatFor(heartbeatState)
  }),
  (error) => error.code === "V2_TOP20_PROVIDER_GATE_BLOCKED"
);

let sequenceState = startState();
assert.deepEqual(getV2Top20NextProviderCall(sequenceState), {
  operation: "main_place",
  companyOrdinal: null,
  productOrdinal: null
});
assert.throws(
  () => reserveV2Top20ProviderCall(sequenceState, {
    expectedWorkflowRevision: sequenceState.workflowRevision,
    call: { operation: "booking_business", companyOrdinal: 1, productOrdinal: null },
    providerGate: { circuitState: "closed", serviceGlobalLockHeld: true, externalCallApproved: true },
    heartbeat: heartbeatFor(sequenceState)
  }),
  (error) => error.code === "V2_TOP20_CALL_SEQUENCE_INVALID"
);
sequenceState = reserveNext(sequenceState);
assert.equal(sequenceState.callLedger.total, 1);
assert.equal(getV2Top20NextProviderCall(sequenceState), null, "only one provider call may be in flight");
const staleInFlightHeartbeat = evaluateV2Top20HeartbeatRequirement(sequenceState, {
  now: nextInstant(),
  jobHeartbeatAt: sequenceState.startedAt,
  jobLeaseExpiresAt: new Date(clock + 60_000).toISOString(),
  providerHeartbeatAt: sequenceState.startedAt,
  providerLeaseExpiresAt: new Date(clock + 60_000).toISOString()
});
assert.equal(staleInFlightHeartbeat.checkpoint, "in_flight_lease_renewal");
assert.deepEqual(staleInFlightHeartbeat.blockers, ["job_heartbeat_stale", "provider_heartbeat_stale"]);
assert.throws(
  () => reserveV2Top20ProviderCall(sequenceState, {
    expectedWorkflowRevision: sequenceState.workflowRevision,
    call: { operation: "main_place", companyOrdinal: null, productOrdinal: null },
    providerGate: { circuitState: "closed", serviceGlobalLockHeld: true, externalCallApproved: true },
    heartbeat: heartbeatFor(sequenceState)
  }),
  (error) => error.code === "V2_TOP20_CALL_SEQUENCE_INVALID"
);
sequenceState = complete(sequenceState, { status: "ready", organicCount: 50 });
assert.deepEqual(getV2Top20NextProviderCall(sequenceState), {
  operation: "booking_business",
  companyOrdinal: 1,
  productOrdinal: null
});
sequenceState = reserveNext(sequenceState);
sequenceState = complete(sequenceState, { status: "ready" });
assert.deepEqual(getV2Top20NextProviderCall(sequenceState), {
  operation: "booking_items",
  companyOrdinal: 1,
  productOrdinal: null
});
sequenceState = reserveNext(sequenceState);
sequenceState = complete(sequenceState, { status: "ready", productCount: 2 });
assert.deepEqual(getV2Top20NextProviderCall(sequenceState), {
  operation: "daily_schedule",
  companyOrdinal: 1,
  productOrdinal: 1
});
sequenceState = reserveNext(sequenceState);
sequenceState = complete(sequenceState, { status: "ready", revenueInputValid: true });
assert.equal(getV2Top20NextProviderCall(sequenceState).productOrdinal, 2);
sequenceState = reserveNext(sequenceState);
sequenceState = complete(sequenceState, { status: "zero", revenueInputValid: true });
assert.deepEqual(getV2Top20NextProviderCall(sequenceState), {
  operation: "booking_business",
  companyOrdinal: 2,
  productOrdinal: null
});

let incompleteMain = startState();
incompleteMain = reserveNext(incompleteMain);
incompleteMain = complete(incompleteMain, { status: "ready", organicCount: 49 });
assert.equal(incompleteMain.phase, "failed");
assert.equal(incompleteMain.failure.code, "V2_TOP20_MAIN_PLACE_INCOMPLETE");
assert.equal(decideV2Top20Persistence(incompleteMain).saveRun, false);

let providerFailure = startState();
providerFailure = reserveNext(providerFailure);
providerFailure = complete(providerFailure, {
  status: "blocked",
  failureCode: "NAVER_ACCESS_BLOCKED"
});
assert.equal(providerFailure.phase, "failed");
assert.equal(providerFailure.failure.code, "NAVER_ACCESS_BLOCKED");
assert.equal(decideV2Top20Persistence(providerFailure).saveFailureRun, false);

let revenueFailure = startState();
revenueFailure = reserveNext(revenueFailure);
revenueFailure = complete(revenueFailure, { status: "ready", organicCount: 50 });
revenueFailure = reserveNext(revenueFailure);
revenueFailure = complete(revenueFailure, { status: "ready" });
revenueFailure = reserveNext(revenueFailure);
revenueFailure = complete(revenueFailure, { status: "ready", productCount: 1 });
revenueFailure = reserveNext(revenueFailure);
revenueFailure = complete(revenueFailure, { status: "ready", revenueInputValid: false });
assert.equal(revenueFailure.phase, "failed");
assert.equal(revenueFailure.failure.code, "V2_TOP20_REVENUE_INPUT_INVALID");

let fullState = startState();
fullState = reserveNext(fullState);
fullState = complete(fullState, { status: "ready", organicCount: 50 });
for (let companyOrdinal = 1; companyOrdinal <= 20; companyOrdinal += 1) {
  assert.equal(getV2Top20NextProviderCall(fullState).companyOrdinal, companyOrdinal);
  fullState = reserveNext(fullState);
  fullState = complete(fullState, { status: "ready" });
  fullState = reserveNext(fullState);
  fullState = complete(fullState, { status: "ready", productCount: 8 });
  for (let productOrdinal = 1; productOrdinal <= 8; productOrdinal += 1) {
    assert.equal(getV2Top20NextProviderCall(fullState).productOrdinal, productOrdinal);
    fullState = reserveNext(fullState);
    fullState = complete(fullState, { status: "ready", revenueInputValid: true });
  }
}
assert.equal(fullState.phase, "validating");
assert.equal(fullState.callLedger.mainPlace, 1);
assert.equal(fullState.callLedger.bookingBusiness, 20);
assert.equal(fullState.callLedger.bookingItems, 20);
assert.equal(fullState.callLedger.dailySchedule, 160);
assert.equal(fullState.callLedger.total, 201);
assert.equal(validateCallLedger(fullState.callLedger), fullState.callLedger);
assert.equal(getV2Top20NextProviderCall(fullState), null);
assert.throws(
  () => markV2Top20Validation(fullState, {
    expectedWorkflowRevision: fullState.workflowRevision - 1,
    now: nextInstant(),
    executionSucceeded: true,
    manifestValid: true,
    revenueEstimatesValid: true,
    previewWriteApproved: true,
    atomicPublishReady: true
  }),
  (error) => error.code === "V2_TOP20_WORKFLOW_REVISION_CONFLICT"
);
fullState = markV2Top20Validation(fullState, {
  expectedWorkflowRevision: fullState.workflowRevision,
  now: nextInstant(),
  executionSucceeded: true,
  providerBlocked: false,
  failureCode: "",
  manifestValid: true,
  revenueEstimatesValid: true,
  previewWriteApproved: true,
  atomicPublishReady: true
});
assert.equal(fullState.phase, "ready_to_persist");
const fullDecision = decideV2Top20Persistence(fullState);
assert.equal(fullDecision.saveRun, true);
assert.equal(fullDecision.saveFailureRun, false);
assert.equal(fullDecision.providerCallCount, 201);
fullState = markV2Top20Persisted(fullState, {
  expectedWorkflowRevision: fullState.workflowRevision,
  now: nextInstant()
});
assert.equal(fullState.phase, "completed");
assert.ok(fullState.persistedAt);

let zeroState = startState();
zeroState = reserveNext(zeroState);
zeroState = complete(zeroState, { status: "ready", organicCount: 50 });
for (let companyOrdinal = 1; companyOrdinal <= 20; companyOrdinal += 1) {
  zeroState = reserveNext(zeroState);
  zeroState = complete(zeroState, { status: "zero" });
}
assert.equal(zeroState.phase, "validating");
assert.equal(zeroState.callLedger.total, 21, "provider-confirmed zero avoids item and schedule calls");
zeroState = markV2Top20Validation(zeroState, {
  expectedWorkflowRevision: zeroState.workflowRevision,
  now: nextInstant(),
  executionSucceeded: true,
  providerBlocked: false,
  failureCode: "",
  manifestValid: true,
  revenueEstimatesValid: true,
  previewWriteApproved: true,
  atomicPublishReady: true
});
assert.equal(decideV2Top20Persistence(zeroState).saveRun, true, "explicit zero is terminal and is not missing");

let unapprovedWrite = cloneForTest(zeroState);
unapprovedWrite.phase = "validating";
unapprovedWrite.validation = null;
unapprovedWrite = markV2Top20Validation(unapprovedWrite, {
  expectedWorkflowRevision: unapprovedWrite.workflowRevision,
  now: nextInstant(),
  executionSucceeded: true,
  providerBlocked: false,
  failureCode: "",
  manifestValid: true,
  revenueEstimatesValid: true,
  previewWriteApproved: false,
  atomicPublishReady: true
});
assert.equal(unapprovedWrite.phase, "failed");
assert.equal(decideV2Top20Persistence(unapprovedWrite).blocker, "preview_write_not_approved");

let invalidValidation = cloneForTest(zeroState);
invalidValidation.phase = "validating";
invalidValidation.validation = null;
invalidValidation = markV2Top20Validation(invalidValidation, {
  expectedWorkflowRevision: invalidValidation.workflowRevision,
  now: nextInstant(),
  executionSucceeded: true,
  providerBlocked: false,
  failureCode: "",
  manifestValid: true,
  revenueEstimatesValid: false,
  previewWriteApproved: true,
  atomicPublishReady: true
});
assert.equal(invalidValidation.phase, "failed");
assert.equal(decideV2Top20Persistence(invalidValidation).saveRun, false);
assert.equal(decideV2Top20Persistence(invalidValidation).blocker, "revenue_estimates_invalid");

function cloneForTest(value) {
  return JSON.parse(JSON.stringify(value));
}

console.log("collection worker V2 top20 contract fixtures passed");
