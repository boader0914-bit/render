"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const {
  ALLOWED_PATH_SCOPES,
  COLLECTION_WORKER_AUTH_AUDIENCE,
  buildSignedWorkerRequest,
  sha256Hex: authSha256Hex
} = require("./collection_worker_auth.cjs");
const {
  buildCollectionArtifactBundle
} = require("./collection_artifact_contract.cjs");
const {
  createCollectionJobStore
} = require("./collection_job_store.cjs");
const {
  createNaverProviderHealthStore
} = require("./naver_provider_health_store.cjs");
const {
  createV2Top20ExecutionState,
  getV2Top20NextProviderCall,
  markV2Top20Validation,
  recordV2Top20ProviderResult,
  reserveV2Top20ProviderCall,
  startV2Top20Execution
} = require("./collection_worker_v2_top20_contract.cjs");
const {
  COLLECTION_WORKER_V2_TOP20_ARTIFACT_KEY_ID,
  COLLECTION_WORKER_V2_TOP20_CLAIM_PATH,
  COLLECTION_WORKER_V2_TOP20_FAILURE_PATH,
  COLLECTION_WORKER_V2_TOP20_FINALIZE_PATH,
  COLLECTION_WORKER_V2_TOP20_HEARTBEAT_PATH,
  COLLECTION_WORKER_V2_TOP20_PREFLIGHT_PATH,
  COLLECTION_WORKER_V2_TOP20_REQUEST_KEY_ID,
  COLLECTION_WORKER_V2_TOP20_RESULT_SCHEMA_VERSION,
  COLLECTION_WORKER_V2_TOP20_WORKER_ID,
  COLLECTION_WORKER_V2_TOP20_WORKER_POOL_ID,
  buildV2Top20ArtifactKeyProof,
  stableJson
} = require("./collection_worker_v2_top20_protocol.cjs");
const {
  createCollectionWorkerV2Top20Orchestrator,
  runtimeIdForCommit
} = require("./collection_worker_v2_top20_orchestrator.cjs");

const COMMIT = "d".repeat(40);
const OPERATOR_TOKEN = "fixture-top20-operator-token-with-at-least-thirty-two-characters";

let unexpectedNetworkCalls = 0;
const originalFetch = global.fetch;
global.fetch = async () => {
  unexpectedNetworkCalls += 1;
  throw new Error("fixture network is disabled");
};

function privateBase64(key) {
  return key.export({ format: "der", type: "pkcs8" }).toString("base64");
}

function publicBase64(key) {
  return key.export({ format: "der", type: "spki" }).toString("base64");
}

function contract(keyword) {
  return {
    keyword,
    searchMode: "keyword",
    collectionMode: "precision",
    collectionPurpose: "revenue_detail",
    productMode: "all",
    checkIn: "2026-08-06",
    checkOut: "2026-08-06",
    rankStart: 1,
    rankEnd: 50,
    detailRankStart: 1,
    detailRankEnd: 20
  };
}

function keySet() {
  return {
    dispatch: crypto.generateKeyPairSync("ed25519"),
    request: crypto.generateKeyPairSync("ed25519"),
    artifact: crypto.generateKeyPairSync("ed25519")
  };
}

function clockFixture() {
  let milliseconds = Date.parse("2026-08-06T12:00:00.000Z");
  return {
    now() {
      return new Date(milliseconds);
    },
    tick(step = 1_000) {
      milliseconds += step;
      return new Date(milliseconds);
    }
  };
}

async function createSystem(root, keys) {
  await fsp.mkdir(root, { recursive: true });
  const clock = clockFixture();
  const jobStore = createCollectionJobStore({ runtimeRoot: root, defaultLeaseMs: 5 * 60 * 1000 });
  const providerStore = createNaverProviderHealthStore({
    filePath: path.join(root, "provider", "naver.json"),
    runtimeRoot: root,
    now: () => clock.now()
  });
  let callbackCount = 0;
  const callbackReceipts = new Set();
  const buildOrchestrator = () => createCollectionWorkerV2Top20Orchestrator({
      enabled: true,
      externalCallApproved: true,
      previewWriteApproved: true,
      targetWorkerCommit: COMMIT,
      jobStore,
      providerStore,
      dispatchPrivateKeyBase64: privateBase64(keys.dispatch.privateKey),
      requestPublicKeyBase64: publicBase64(keys.request.publicKey),
      artifactPublicKeyBase64: publicBase64(keys.artifact.publicKey),
      operatorTokenSha256: crypto.createHash("sha256").update(OPERATOR_TOKEN).digest("hex"),
      now: () => clock.now(),
      async applyReadyTransaction(input) {
        assert.equal(input.summary.status, "ready");
        assert.equal(input.top20ContractHash, input.summary.top20ContractHash);
        assert.equal(callbackReceipts.has(input.receiptId), false, "transaction receipt must be applied once");
        callbackReceipts.add(input.receiptId);
        callbackCount += 1;
        return { receiptId: input.receiptId, committed: true, writeCount: 1 };
      }
    });
  const orchestrator = buildOrchestrator();
  return {
    callbackCount: () => callbackCount,
    clock,
    jobStore,
    orchestrator,
    providerStore,
    restartOrchestrator: buildOrchestrator
  };
}

function signedRequest(pathname, body, keys, issuedAt, overrides = {}) {
  return buildSignedWorkerRequest({
    audience: COLLECTION_WORKER_AUTH_AUDIENCE,
    workerId: overrides.workerId || COLLECTION_WORKER_V2_TOP20_WORKER_ID,
    workerPoolId: overrides.workerPoolId || COLLECTION_WORKER_V2_TOP20_WORKER_POOL_ID,
    keyId: COLLECTION_WORKER_V2_TOP20_REQUEST_KEY_ID,
    method: "POST",
    path: pathname,
    scope: ALLOWED_PATH_SCOPES[pathname],
    issuedAt,
    nonce: crypto.randomBytes(18).toString("base64url"),
    bodySha256: authSha256Hex(stableJson(body))
  }, { privateKey: keys.request.privateKey });
}

async function prepareClaimPreflight(system, keys, keyword) {
  const prepared = await system.orchestrator.prepare({
    operatorToken: OPERATOR_TOKEN,
    contract: contract(keyword)
  });
  assert.equal(prepared.status, "queued");
  assert.equal(prepared.maximumProviderCalls, 241);
  assert.equal(prepared.maxProviderAttempts, 1);
  assert.equal(system.orchestrator.status().activePayloadCount, 1);
  assert.equal(system.orchestrator.status().retainedTerminalPayloadCount, 0);

  const claimBody = {
    workerId: COLLECTION_WORKER_V2_TOP20_WORKER_ID,
    workerPoolId: COLLECTION_WORKER_V2_TOP20_WORKER_POOL_ID,
    workerCommit: COMMIT
  };
  const claimed = await system.orchestrator.claim({
    body: claimBody,
    signedRequest: signedRequest(COLLECTION_WORKER_V2_TOP20_CLAIM_PATH, claimBody, keys, system.clock.now())
  });
  assert.equal(claimed.status, "claimed");
  assert.equal(claimed.job.executionPayload.top20ContractHash, prepared.top20ContractHash);
  assert.equal(claimed.job.executionPayload.providerSession.maximumProviderCalls, 241);
  assert.equal(claimed.job.executionPayload.providerSession.concurrency, 1);
  assert.equal(claimed.job.executionPayload.providerSession.automaticRetry, false);
  assert.equal(claimed.job.executionPayload.providerSession.automaticFallback, false);
  assert.equal(
    claimed.job.signedJob.approvalId,
    `approval:top20:${prepared.top20ContractHash}`,
    "the legacy signed-job envelope must bind the full top20 hash"
  );

  const runtimeId = runtimeIdForCommit(COMMIT);
  const proof = buildV2Top20ArtifactKeyProof({
    jobId: prepared.jobId,
    attemptId: claimed.job.signedJob.attemptId,
    workflowRevision: claimed.job.workflowRevision,
    workerId: COLLECTION_WORKER_V2_TOP20_WORKER_ID,
    workerPoolId: COLLECTION_WORKER_V2_TOP20_WORKER_POOL_ID,
    workerCommit: COMMIT,
    runtimeId,
    contractHash: claimed.job.signedJob.contractHash,
    executionIdentityHash: claimed.job.signedJob.executionIdentityHash,
    top20ContractHash: prepared.top20ContractHash
  }, keys.artifact.privateKey);
  const preflightBody = {
    jobId: prepared.jobId,
    attemptId: claimed.job.signedJob.attemptId,
    workflowRevision: claimed.job.workflowRevision,
    workerCommit: COMMIT,
    runtimeId,
    artifactKeyProof: proof
  };
  const preflight = await system.orchestrator.preflight({
    body: preflightBody,
    signedRequest: signedRequest(COLLECTION_WORKER_V2_TOP20_PREFLIGHT_PATH, preflightBody, keys, system.clock.now())
  });
  assert.equal(preflight.status, "preflighted");
  return { claimed, preflight, prepared, runtimeId };
}

function heartbeatState(system, keys, flow) {
  const body = {
    jobId: flow.prepared.jobId,
    attemptId: flow.claimed.job.signedJob.attemptId,
    workflowRevision: flow.claimed.job.workflowRevision,
    providerWorkflowRevision: flow.claimed.job.providerWorkflowRevision,
    workerCommit: COMMIT,
    runtimeId: flow.runtimeId
  };
  return {
    body,
    request: signedRequest(COLLECTION_WORKER_V2_TOP20_HEARTBEAT_PATH, body, keys, system.clock.now())
  };
}

function stateClock() {
  let milliseconds = Date.parse("2026-08-06T01:00:00.000Z");
  return () => new Date(milliseconds += 1_000).toISOString();
}

function heartbeatInput(nextTime) {
  const now = nextTime();
  return {
    now,
    jobHeartbeatAt: now,
    jobLeaseExpiresAt: new Date(Date.parse(now) + 120_000).toISOString(),
    providerHeartbeatAt: now,
    providerLeaseExpiresAt: new Date(Date.parse(now) + 120_000).toISOString()
  };
}

function reserveNext(state, nextTime) {
  return reserveV2Top20ProviderCall(state, {
    expectedWorkflowRevision: state.workflowRevision,
    call: getV2Top20NextProviderCall(state),
    providerGate: {
      circuitState: "closed",
      serviceGlobalLockHeld: true,
      externalCallApproved: true
    },
    heartbeat: heartbeatInput(nextTime)
  });
}

function complete(state, nextTime, result) {
  return recordV2Top20ProviderResult(state, {
    expectedWorkflowRevision: state.workflowRevision,
    call: state.inFlight,
    completedAt: nextTime(),
    ...result
  });
}

function readyExecutionState() {
  const nextTime = stateClock();
  let state = createV2Top20ExecutionState();
  state = startV2Top20Execution(state, {
    expectedWorkflowRevision: state.workflowRevision,
    now: nextTime()
  });
  state = reserveNext(state, nextTime);
  state = complete(state, nextTime, { status: "ready", organicCount: 50 });
  for (let companyOrdinal = 1; companyOrdinal <= 20; companyOrdinal += 1) {
    state = reserveNext(state, nextTime);
    state = complete(state, nextTime, { status: "zero" });
  }
  state = markV2Top20Validation(state, {
    expectedWorkflowRevision: state.workflowRevision,
    now: nextTime(),
    executionSucceeded: true,
    providerBlocked: false,
    failureCode: "",
    manifestValid: true,
    revenueEstimatesValid: true,
    previewWriteApproved: true,
    atomicPublishReady: true
  });
  assert.equal(state.phase, "ready_to_persist");
  assert.equal(state.callLedger.total, 21);
  return state;
}

function blockedExecutionState() {
  const nextTime = stateClock();
  let state = createV2Top20ExecutionState();
  state = startV2Top20Execution(state, {
    expectedWorkflowRevision: state.workflowRevision,
    now: nextTime()
  });
  state = reserveNext(state, nextTime);
  state = complete(state, nextTime, {
    status: "blocked",
    failureCode: "NAVER_ACCESS_BLOCKED"
  });
  assert.equal(state.phase, "failed");
  return state;
}

function signedArtifact(flow, keys, status, executionState, providerWorkflowRevision) {
  const summary = {
    schemaVersion: COLLECTION_WORKER_V2_TOP20_RESULT_SCHEMA_VERSION,
    top20SchemaVersion: executionState.schemaVersion,
    profile: executionState.profile,
    collectorScope: executionState.collectorScope,
    top20ContractHash: flow.prepared.top20ContractHash,
    contractHash: flow.claimed.job.signedJob.contractHash,
    executionIdentityHash: flow.claimed.job.signedJob.executionIdentityHash,
    status,
    providerAttemptCount: 1,
    executedCallCount: executionState.callLedger.total,
    providerWorkflowRevision,
    automaticRetry: false,
    automaticFallback: false,
    providerFailureSubtype: status === "blocked" ? "challenge_html" : null,
    diagnosticId: status === "blocked" ? "crawl-abcdef123456" : null,
    executionState
  };
  return buildCollectionArtifactBundle({
    identity: {
      jobId: flow.prepared.jobId,
      attemptId: flow.claimed.job.signedJob.attemptId,
      workerId: COLLECTION_WORKER_V2_TOP20_WORKER_ID,
      workerPoolId: COLLECTION_WORKER_V2_TOP20_WORKER_POOL_ID,
      runtimeId: flow.runtimeId,
      contractHash: flow.claimed.job.signedJob.contractHash,
      executionIdentityHash: flow.claimed.job.signedJob.executionIdentityHash
    },
    files: [
      { path: "top20-summary.json", content: JSON.stringify(summary) },
      { path: "manifest.json", content: JSON.stringify({ status, targetCount: 20 }) }
    ]
  }, {
    privateKey: keys.artifact.privateKey,
    keyId: COLLECTION_WORKER_V2_TOP20_ARTIFACT_KEY_ID
  });
}

async function readyScenario(root, keys) {
  const system = await createSystem(root, keys);
  const flow = await prepareClaimPreflight(system, keys, "Synthetic top20 ready lodging");

  await assert.rejects(
    () => system.orchestrator.prepare({
      operatorToken: OPERATOR_TOKEN,
      contract: contract("Synthetic competing top20 lodging")
    }),
    { code: "COLLECTION_WORKER_V2_TOP20_ACTIVE_JOB" },
    "active top20 jobs must be service-global single flight"
  );

  const heartbeatFixture = heartbeatState(system, keys, flow);
  system.clock.tick();
  const heartbeat = await system.orchestrator.heartbeat({
    body: heartbeatFixture.body,
    signedRequest: heartbeatFixture.request
  });
  assert.equal(heartbeat.status, "heartbeat");
  assert.ok(heartbeat.providerWorkflowRevision > flow.claimed.job.providerWorkflowRevision);
  const replayRequest = signedRequest(
    COLLECTION_WORKER_V2_TOP20_HEARTBEAT_PATH,
    heartbeatFixture.body,
    keys,
    system.clock.now()
  );
  const heartbeatReplay = await system.orchestrator.heartbeat({
    body: heartbeatFixture.body,
    signedRequest: replayRequest
  });
  assert.equal(heartbeatReplay.replayed, true);
  assert.equal(heartbeatReplay.workflowRevision, heartbeat.workflowRevision);

  const executionState = readyExecutionState();
  const artifact = signedArtifact(flow, keys, "ready", executionState, heartbeat.providerWorkflowRevision);
  const finalizeBody = {
    jobId: flow.prepared.jobId,
    attemptId: flow.claimed.job.signedJob.attemptId,
    workflowRevision: heartbeat.workflowRevision,
    signedArtifact: artifact
  };
  const first = await system.orchestrator.finalize({
    body: finalizeBody,
    signedRequest: signedRequest(COLLECTION_WORKER_V2_TOP20_FINALIZE_PATH, finalizeBody, keys, system.clock.now())
  });
  assert.equal(first.status, "ready");
  assert.equal(first.jobState, "committed");
  assert.equal(first.resultStored, true);
  assert.equal(first.writeCount, 1);
  assert.equal(first.replayed, false);
  assert.equal(system.callbackCount(), 1);
  assert.equal(system.orchestrator.status().activePayloadCount, 0, "committed payload must not count as active");
  assert.equal(system.orchestrator.status().retainedTerminalPayloadCount, 1, "committed payload is retained only for replay");

  // Simulate a lost HTTP response: the worker resubmits the same immutable
  // signed artifact with fresh request authentication. No transaction repeats.
  const replay = await system.orchestrator.finalize({
    body: finalizeBody,
    signedRequest: signedRequest(COLLECTION_WORKER_V2_TOP20_FINALIZE_PATH, finalizeBody, keys, system.clock.now())
  });
  assert.equal(replay.status, "ready");
  assert.equal(replay.jobState, "committed");
  assert.equal(replay.replayed, true);
  assert.equal(replay.transactionReceiptId, first.transactionReceiptId);
  assert.equal(system.callbackCount(), 1, "response-loss replay must not call the transaction twice");
  assert.equal((await system.providerStore.read()).state, "closed");
  assert.equal((await system.jobStore.readSnapshot()).jobs[0].state, "committed");

  const emptyClaimBody = {
    workerId: COLLECTION_WORKER_V2_TOP20_WORKER_ID,
    workerPoolId: COLLECTION_WORKER_V2_TOP20_WORKER_POOL_ID,
    workerCommit: COMMIT
  };
  const terminalClaim = await system.orchestrator.claim({
    body: emptyClaimBody,
    signedRequest: signedRequest(COLLECTION_WORKER_V2_TOP20_CLAIM_PATH, emptyClaimBody, keys, system.clock.now())
  });
  assert.equal(terminalClaim.status, "empty", "terminal payloads must never be claimable");

  system.clock.tick(16 * 60 * 1000);
  assert.equal(system.orchestrator.status().activePayloadCount, 0);
  assert.equal(system.orchestrator.status().retainedTerminalPayloadCount, 0, "terminal payload replay retention expires");
}

async function blockedScenario(root, keys) {
  const system = await createSystem(root, keys);
  const flow = await prepareClaimPreflight(system, keys, "Synthetic top20 blocked lodging");
  const state = blockedExecutionState();
  const artifact = signedArtifact(
    flow,
    keys,
    "blocked",
    state,
    flow.claimed.job.providerWorkflowRevision
  );
  const body = {
    jobId: flow.prepared.jobId,
    attemptId: flow.claimed.job.signedJob.attemptId,
    workflowRevision: flow.claimed.job.workflowRevision,
    signedArtifact: artifact
  };
  const result = await system.orchestrator.finalize({
    body,
    signedRequest: signedRequest(COLLECTION_WORKER_V2_TOP20_FINALIZE_PATH, body, keys, system.clock.now())
  });
  assert.equal(result.status, "blocked");
  assert.equal(result.jobState, "blocked");
  assert.equal(result.resultStored, false);
  assert.equal(result.writeCount, 0);
  assert.equal(system.callbackCount(), 0);
  assert.equal(system.orchestrator.status().activePayloadCount, 0, "blocked payload must not count as active");
  assert.equal(system.orchestrator.status().retainedTerminalPayloadCount, 1);
  const provider = await system.providerStore.read();
  assert.equal(provider.state, "open");
  assert.equal(provider.lastFailureSubtype, "challenge_html");
}

async function failureScenario(root, keys) {
  const system = await createSystem(root, keys);
  const flow = await prepareClaimPreflight(system, keys, "Synthetic top20 worker failure lodging");
  const body = {
    jobId: flow.prepared.jobId,
    attemptId: flow.claimed.job.signedJob.attemptId,
    workflowRevision: flow.claimed.job.workflowRevision,
    providerWorkflowRevision: flow.claimed.job.providerWorkflowRevision,
    providerAttemptCount: 0,
    executedCallCount: 0,
    code: "COLLECTION_WORKER_PROCESS_FAILED",
    providerFailureSubtype: null,
    diagnosticId: null
  };
  const result = await system.orchestrator.recordFailure({
    body,
    signedRequest: signedRequest(COLLECTION_WORKER_V2_TOP20_FAILURE_PATH, body, keys, system.clock.now())
  });
  assert.equal(result.status, "failed");
  assert.equal(result.resultStored, false);
  assert.equal(result.writeCount, 0);
  assert.equal(system.callbackCount(), 0);
  assert.equal(system.orchestrator.status().activePayloadCount, 0, "failed payload must not count as active");
  assert.equal(system.orchestrator.status().retainedTerminalPayloadCount, 1);
  assert.equal((await system.providerStore.read()).state, "closed");
  const replay = await system.orchestrator.recordFailure({
    body,
    signedRequest: signedRequest(COLLECTION_WORKER_V2_TOP20_FAILURE_PATH, body, keys, system.clock.now())
  });
  assert.equal(replay.replayed, true);
  assert.equal(system.callbackCount(), 0);
  assert.equal(system.orchestrator.status().activePayloadCount, 0);
  assert.equal(system.orchestrator.status().retainedTerminalPayloadCount, 1);
}

async function cancellationScenario(root, keys) {
  const system = await createSystem(root, keys);
  const flow = await prepareClaimPreflight(system, keys, "Synthetic top20 cancellation lodging");
  const cancelledRequest = await system.jobStore.requestCancellation({
    jobId: flow.prepared.jobId,
    expectedWorkflowRevision: flow.claimed.job.workflowRevision,
    now: system.clock.tick()
  });
  assert.equal(cancelledRequest.cancellationRequested, true);
  const heartbeatFixture = heartbeatState(system, keys, flow);
  await assert.rejects(
    () => system.orchestrator.heartbeat({
      body: heartbeatFixture.body,
      signedRequest: heartbeatFixture.request
    }),
    { code: "COLLECTION_WORKER_V2_TOP20_CANCEL_REQUESTED" },
    "a cancellation request must stop the next provider heartbeat without releasing early"
  );
  assert.equal((await system.providerStore.read()).state, "probe_allowed");
  const body = {
    jobId: flow.prepared.jobId,
    attemptId: flow.claimed.job.signedJob.attemptId,
    workflowRevision: flow.claimed.job.workflowRevision,
    providerWorkflowRevision: flow.claimed.job.providerWorkflowRevision,
    providerAttemptCount: 0,
    executedCallCount: 0,
    code: "COLLECTION_WORKER_V2_TOP20_CANCEL_REQUESTED",
    providerFailureSubtype: null,
    diagnosticId: null
  };
  const result = await system.orchestrator.recordFailure({
    body,
    signedRequest: signedRequest(COLLECTION_WORKER_V2_TOP20_FAILURE_PATH, body, keys, system.clock.now())
  });
  assert.equal(result.status, "cancelled");
  assert.equal(result.jobState, "cancelled");
  assert.equal(result.resultStored, false);
  assert.equal(result.writeCount, 0);
  assert.equal(system.callbackCount(), 0);
  assert.equal((await system.providerStore.read()).state, "closed", "provider lease releases only after Worker stop receipt");
  assert.equal(system.orchestrator.status().activePayloadCount, 0, "cancelled payload must not count as active");
  assert.equal(system.orchestrator.status().retainedTerminalPayloadCount, 1);
  const replay = await system.orchestrator.recordFailure({
    body,
    signedRequest: signedRequest(COLLECTION_WORKER_V2_TOP20_FAILURE_PATH, body, keys, system.clock.now())
  });
  assert.equal(replay.replayed, true);
  assert.equal(system.orchestrator.status().activePayloadCount, 0);
  assert.equal(system.orchestrator.status().retainedTerminalPayloadCount, 1);
}

async function identityScenario(root, keys) {
  const system = await createSystem(root, keys);
  await system.orchestrator.prepare({
    operatorToken: OPERATOR_TOKEN,
    contract: contract("Synthetic top20 identity lodging")
  });
  const body = {
    workerId: "collector_worker_preview_top20_02",
    workerPoolId: COLLECTION_WORKER_V2_TOP20_WORKER_POOL_ID,
    workerCommit: COMMIT
  };
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (line) => warnings.push(String(line));
  try {
    await assert.rejects(
      () => system.orchestrator.claim({
        body,
        signedRequest: signedRequest(COLLECTION_WORKER_V2_TOP20_CLAIM_PATH, body, keys, system.clock.now())
      }),
      { code: "COLLECTION_WORKER_V2_TOP20_WORKER_MISMATCH" },
      "the body must match the exact top20 worker identity"
    );
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /top20-worker-mismatch/u);
  assert.match(warnings[0], /"expectedWorkerId":"collector_worker_preview_top20_01"/u);
  assert.match(warnings[0], /"actualWorkerId":"collector_worker_preview_top20_02"/u);
  assert.match(warnings[0], /"expectedWorkerCommit":"dddddddddddd"/u);
  assert.match(warnings[0], /"actualWorkerCommit":"dddddddddddd"/u);
  assert.match(warnings[0], /"expectedTargetServiceId":"srv-d9q6mrfavr4c73atllf0"/u);
  assert.match(warnings[0], /"mismatchField":"workerId"/u);
}

async function claimAfterRestart(system, keys) {
  const body = {
    workerId: COLLECTION_WORKER_V2_TOP20_WORKER_ID,
    workerPoolId: COLLECTION_WORKER_V2_TOP20_WORKER_POOL_ID,
    workerCommit: COMMIT
  };
  const restarted = system.restartOrchestrator();
  const result = await restarted.claim({
    body,
    signedRequest: signedRequest(COLLECTION_WORKER_V2_TOP20_CLAIM_PATH, body, keys, system.clock.now())
  });
  assert.equal(result.status, "empty", "restart reconciliation must not reconstruct or dispatch lost payloads");
  assert.equal(result.job, null);
  return restarted;
}

async function queuedRestartScenario(root, keys) {
  const system = await createSystem(root, keys);
  const prepared = await system.orchestrator.prepare({
    operatorToken: OPERATOR_TOKEN,
    contract: contract("Synthetic queued restart lodging")
  });
  const restarted = await claimAfterRestart(system, keys);
  const snapshot = await system.jobStore.readSnapshot();
  const abandoned = snapshot.jobs.find((job) => job.jobId === prepared.jobId);
  assert.equal(abandoned.state, "indeterminate");
  assert.equal(abandoned.failureCode, "COLLECTION_WORKER_V2_TOP20_PAYLOAD_UNAVAILABLE");
  assert.equal((await system.providerStore.read()).state, "closed", "an unclaimed reservation must be released");

  const replacement = await restarted.prepare({
    operatorToken: OPERATOR_TOKEN,
    contract: contract("Synthetic replacement after queued restart")
  });
  assert.equal(replacement.status, "queued", "the abandoned durable job must not permanently block preparation");
}

async function collectingRestartScenario(root, keys) {
  const system = await createSystem(root, keys);
  const flow = await prepareClaimPreflight(system, keys, "Synthetic collecting restart lodging");
  const heartbeatFixture = heartbeatState(system, keys, flow);
  system.clock.tick();
  const heartbeat = await system.orchestrator.heartbeat({
    body: heartbeatFixture.body,
    signedRequest: heartbeatFixture.request
  });
  const durableBeforeRestart = (await system.jobStore.readSnapshot()).jobs[0];
  assert.equal(
    durableBeforeRestart.providerWorkflowRevision,
    heartbeat.providerWorkflowRevision,
    "provider heartbeat revision must be durable before process restart"
  );

  await claimAfterRestart(system, keys);
  const abandoned = (await system.jobStore.readSnapshot()).jobs[0];
  assert.equal(abandoned.state, "indeterminate");
  assert.equal(abandoned.failureCode, "COLLECTION_WORKER_V2_TOP20_PAYLOAD_UNAVAILABLE");
  const provider = await system.providerStore.read();
  assert.equal(provider.state, "open", "a possibly started provider attempt must fail closed into cooldown");
  assert.equal(provider.lastFailureSubtype, "unknown_access_block");
}

async function validatedRestartScenario(root, keys) {
  const system = await createSystem(root, keys);
  const flow = await prepareClaimPreflight(system, keys, "Synthetic validated restart lodging");
  const artifactHash = "a".repeat(64);
  let job = await system.jobStore.transitionJob({
    jobId: flow.prepared.jobId,
    expectedWorkflowRevision: flow.claimed.job.workflowRevision,
    workerId: COLLECTION_WORKER_V2_TOP20_WORKER_ID,
    nextState: "artifact_received",
    artifactHash,
    now: system.clock.tick()
  });
  await system.providerStore.recordSuccess({
    expectedWorkflowRevision: flow.claimed.job.providerWorkflowRevision,
    outcomeReceiptHash: artifactHash,
    now: system.clock.tick()
  });
  job = await system.jobStore.transitionJob({
    jobId: job.jobId,
    expectedWorkflowRevision: job.workflowRevision,
    workerId: COLLECTION_WORKER_V2_TOP20_WORKER_ID,
    nextState: "validated",
    now: system.clock.tick()
  });
  assert.equal(job.state, "validated");

  await claimAfterRestart(system, keys);
  const abandoned = (await system.jobStore.readSnapshot()).jobs[0];
  assert.equal(abandoned.state, "rejected", "validated work without its payload must not be committed after restart");
  assert.equal(abandoned.failureCode, "COLLECTION_WORKER_V2_TOP20_PAYLOAD_UNAVAILABLE");
  assert.equal((await system.providerStore.read()).state, "closed");
  assert.equal(system.callbackCount(), 0, "restart reconciliation must never apply the write transaction");
}

async function main() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "collection-worker-top20-orchestrator-"));
  const keys = keySet();
  try {
    await readyScenario(path.join(root, "ready"), keys);
    await blockedScenario(path.join(root, "blocked"), keys);
    await failureScenario(path.join(root, "failed"), keys);
    await cancellationScenario(path.join(root, "cancelled"), keys);
    await identityScenario(path.join(root, "identity"), keys);
    await queuedRestartScenario(path.join(root, "restart-queued"), keys);
    await collectingRestartScenario(path.join(root, "restart-collecting"), keys);
    await validatedRestartScenario(path.join(root, "restart-validated"), keys);
    assert.equal(unexpectedNetworkCalls, 0, "top20 orchestrator fixtures must not use external networking");
    console.log("collection worker V2 top20 orchestrator fixtures passed");
  } finally {
    global.fetch = originalFetch;
    await fsp.rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  global.fetch = originalFetch;
  console.error(error);
  process.exitCode = 1;
});
