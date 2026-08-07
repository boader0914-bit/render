"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { installFixtureNetworkGuard } = require("./fixture_network_guard.cjs");
const {
  FIXED_V2_WORKER_RUNTIME_FINGERPRINT
} = require("./collection_worker_contract.cjs");
const {
  ALLOWED_PATH_SCOPES,
  COLLECTION_WORKER_AUTH_AUDIENCE,
  buildSignedWorkerRequest,
  sha256Hex
} = require("./collection_worker_auth.cjs");
const { createCollectionJobStore } = require("./collection_job_store.cjs");
const { createNaverProviderHealthStore } = require("./naver_provider_health_store.cjs");
const {
  apolloHtml,
  createApolloFixture
} = require("./naver_collector_fixture_factory.cjs");
const {
  createNaverLegacyCanaryLiveTransport
} = require("./naver_legacy_canary_live_transport.cjs");
const {
  CLAIM_PATH,
  COLLECTION_WORKER_CANARY_BACKEND_ID,
  COLLECTION_WORKER_CANARY_REQUEST_KEY_ID,
  COLLECTION_WORKER_CANARY_TARGET_SERVICE_ID,
  COLLECTION_WORKER_CANARY_WORKER_ID,
  COLLECTION_WORKER_CANARY_WORKER_POOL_ID,
  FAILURE_PATH,
  FINALIZE_PATH,
  PREFLIGHT_PATH,
  createCollectionWorkerCanaryOrchestrator,
  stableJson
} = require("./collection_worker_canary_orchestrator.cjs");
const {
  ENV,
  TARGET_PREVIEW_BASE_URL,
  runCollectionWorkerNaverCanary,
  safeFatalResult
} = require("./collection_worker_naver_canary.cjs");

const NOW = new Date("2026-08-06T08:00:00.000Z");
const COMMIT = "a".repeat(40);
const OPERATOR_TOKEN = "fixture-operator-token-with-at-least-thirty-two-characters";
const KEYWORD = "Synthetic worker canary lodging";

function privateBase64(key) {
  return key.export({ format: "der", type: "pkcs8" }).toString("base64");
}

function publicBase64(key) {
  return key.export({ format: "der", type: "spki" }).toString("base64");
}

function contract() {
  return {
    keyword: KEYWORD,
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
}

function response(body, status = 200, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ "content-type": "application/json", ...headers }),
    text: async () => typeof body === "string" ? body : JSON.stringify(body)
  };
}

function providerResponse(body, status = 200, headers = {}) {
  return {
    status,
    headers: new Headers({ "content-type": "text/html; charset=utf-8", ...headers }),
    text: async () => body
  };
}

function successBody(count = 50) {
  const items = Array.from({ length: count }, (_, index) => ({
    id: `fixture-${index + 1}`,
    name: `Fixture lodging ${index + 1}`,
    roadAddress: `Fixture road ${index + 1}`
  }));
  const { state } = createApolloFixture({ query: KEYWORD, display: 50, items });
  createApolloFixture({
    state,
    operation: "adBusinesses",
    query: KEYWORD,
    items: [{ id: "fixture-ad", name: "Fixture ad", roadAddress: "Fixture ad road" }]
  });
  return apolloHtml(state);
}

async function createFixtureSystem(root, keySet, clock = () => NOW, decorators = {}) {
  const durableJobStore = createCollectionJobStore({ runtimeRoot: root });
  const durableProviderStore = createNaverProviderHealthStore({
    filePath: path.join(root, "provider_health", "naver_place_search.json"),
    runtimeRoot: root,
    now: clock
  });
  const jobStore = typeof decorators.jobStore === "function"
    ? decorators.jobStore(durableJobStore)
    : durableJobStore;
  const providerStore = typeof decorators.providerStore === "function"
    ? decorators.providerStore(durableProviderStore)
    : durableProviderStore;
  const orchestrator = createCollectionWorkerCanaryOrchestrator({
    enabled: true,
    jobStore,
    providerStore,
    targetWorkerCommit: COMMIT,
    dispatchPrivateKeyBase64: privateBase64(keySet.dispatch.privateKey),
    artifactPublicKeyBase64: publicBase64(keySet.artifact.publicKey),
    requestPublicKeyBase64: publicBase64(keySet.request.publicKey),
    operatorTokenSha256: crypto.createHash("sha256").update(OPERATOR_TOKEN).digest("hex"),
    now: clock
  });
  return { durableJobStore, durableProviderStore, jobStore, orchestrator, providerStore };
}

function signedWorkerRequest(pathname, body, keySet, issuedAt) {
  return buildSignedWorkerRequest({
    audience: COLLECTION_WORKER_AUTH_AUDIENCE,
    workerId: COLLECTION_WORKER_CANARY_WORKER_ID,
    workerPoolId: COLLECTION_WORKER_CANARY_WORKER_POOL_ID,
    keyId: COLLECTION_WORKER_CANARY_REQUEST_KEY_ID,
    method: "POST",
    path: pathname,
    scope: ALLOWED_PATH_SCOPES[pathname],
    issuedAt,
    nonce: crypto.randomBytes(18).toString("base64url"),
    bodySha256: sha256Hex(stableJson(body))
  }, { privateKey: keySet.request.privateKey });
}

function workerEnvironment(keySet, overrides = {}) {
  return {
    RENDER: "true",
    RENDER_SERVICE_ID: COLLECTION_WORKER_CANARY_TARGET_SERVICE_ID,
    RENDER_GIT_COMMIT: COMMIT,
    [ENV.workerMode]: "disabled",
    [ENV.externalCalls]: "false",
    [ENV.resultWrites]: "false",
    [ENV.oneShotEnabled]: "true",
    [ENV.previewBaseUrl]: TARGET_PREVIEW_BASE_URL,
    [ENV.dispatchPublicKey]: publicBase64(keySet.dispatch.publicKey),
    [ENV.artifactPrivateKey]: privateBase64(keySet.artifact.privateKey),
    [ENV.requestPrivateKey]: privateBase64(keySet.request.privateKey),
    ...overrides
  };
}

function internalFetch(orchestrator, counters) {
  return async (url, options) => {
    counters.internal += 1;
    const payload = JSON.parse(String(options.body || "{}"));
    try {
      const pathname = new URL(url).pathname;
      if (pathname === FINALIZE_PATH) {
        counters.finalizeRequests = Number(counters.finalizeRequests || 0) + 1;
        counters.lastFinalizeBody = structuredClone(payload.body);
      }
      if (pathname === FAILURE_PATH) {
        counters.failureRequests = Number(counters.failureRequests || 0) + 1;
        counters.lastFailureBody = structuredClone(payload.body);
      }
      const result = pathname === CLAIM_PATH
        ? await orchestrator.claim({ signedRequest: payload.signedRequest, body: payload.body })
        : pathname === PREFLIGHT_PATH
          ? await orchestrator.preflight({ signedRequest: payload.signedRequest, body: payload.body })
        : pathname === FINALIZE_PATH
          ? await orchestrator.finalize({ signedRequest: payload.signedRequest, body: payload.body })
          : pathname === FAILURE_PATH
            ? await orchestrator.recordFailure({ signedRequest: payload.signedRequest, body: payload.body })
            : (() => { throw Object.assign(new Error("unknown fixture path"), { code: "NOT_FOUND", statusCode: 404 }); })();
      return response(result, 200);
    } catch (error) {
      return response({
        code: String(error?.code || "COLLECTION_WORKER_INTERNAL_REQUEST_FAILED"),
        retryAt: error?.retryAt || undefined,
        retryAfterSeconds: error?.retryAfterSeconds ?? undefined
      }, Number(error?.statusCode || 500));
    }
  };
}

function liveTransport(fetchImpl) {
  return createNaverLegacyCanaryLiveTransport({
    enabled: true,
    allowTextFallback: true,
    fetchImpl
  });
}

async function runWorker(
  system,
  keySet,
  providerTransport,
  counters,
  environmentOverrides = {},
  internalFetchImpl = null,
  runOverrides = {}
) {
  return runCollectionWorkerNaverCanary({
    fixtureMode: true,
    environment: workerEnvironment(keySet, environmentOverrides),
    now: NOW,
    runtimeFingerprint: FIXED_V2_WORKER_RUNTIME_FINGERPRINT,
    internalFetchImpl: internalFetchImpl || internalFetch(system.orchestrator, counters),
    providerTransport,
    ...runOverrides
  });
}

async function storedText(root) {
  const files = [];
  async function walk(current) {
    for (const entry of await fsp.readdir(current, { withFileTypes: true }).catch(() => [])) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(target);
      else files.push(await fsp.readFile(target, "utf8"));
    }
  }
  await walk(root);
  return files.join("\n");
}

async function main() {
  const guard = installFixtureNetworkGuard({ label: "collection worker NAVER orchestrated canary fixtures" });
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "collection-worker-canary-"));
  try {
    const keySet = {
      dispatch: crypto.generateKeyPairSync("ed25519"),
      artifact: crypto.generateKeyPairSync("ed25519"),
      request: crypto.generateKeyPairSync("ed25519")
    };

    const successRoot = path.join(root, "success");
    await fsp.mkdir(successRoot, { recursive: true });
    const successSystem = await createFixtureSystem(successRoot, keySet);
    const prepared = await successSystem.orchestrator.prepare({
      operatorToken: OPERATOR_TOKEN,
      contract: contract()
    });
    assert.equal(prepared.status, "queued");
    assert.equal(prepared.providerState, "probe_allowed");
    assert.equal(JSON.stringify(prepared).includes(KEYWORD), false);
    assert.equal((await storedText(successRoot)).includes(KEYWORD), false, "durable metadata must not store the raw keyword");

    let providerCalls = 0;
    const counters = { internal: 0 };
    const result = await runWorker(
      successSystem,
      keySet,
      liveTransport(async () => {
        providerCalls += 1;
        return providerResponse(successBody());
      }),
      counters
    );
    assert.equal(providerCalls, 1);
    assert.equal(counters.internal, 3, "one claim, one preflight, and one finalize request are expected");
    assert.equal(result.status, "ready");
    assert.equal(result.organicCount, 50);
    assert.equal(result.adCount, 1);
    assert.equal(result.jobState, "validated_no_store");
    assert.equal(result.artifactDecision, "validated_no_store");
    assert.equal(result.resultStored, false);
    assert.equal(result.writeCount, 0);
    const successProviderReceipt = await successSystem.providerStore.read();
    assert.equal(successProviderReceipt.state, "closed");
    const successSnapshot = await successSystem.jobStore.readSnapshot();
    assert.equal(successSnapshot.jobs.length, 1);
    assert.equal(successSnapshot.jobs[0].attemptNo, 1);
    assert.equal(successSnapshot.jobs[0].state, "validated_no_store");
    assert.equal(successProviderReceipt.lastOutcomeKind, "success");
    assert.equal(successProviderReceipt.lastOutcomeReceiptHash, successSnapshot.jobs[0].artifactHash);
    assert.equal((await storedText(successRoot)).includes(KEYWORD), false);
    const serializedResult = JSON.stringify(result);
    assert.equal(serializedResult.includes(KEYWORD), false);
    assert.equal(serializedResult.includes("Fixture lodging"), false);
    assert.equal(serializedResult.includes("pcmap.place.naver.com"), false);

    const replayedFinalize = await successSystem.orchestrator.finalize({
      signedRequest: signedWorkerRequest(FINALIZE_PATH, counters.lastFinalizeBody, keySet, NOW),
      body: counters.lastFinalizeBody
    });
    assert.equal(replayedFinalize.replayed, true, "the same durable artifact must return a terminal receipt");
    assert.equal(replayedFinalize.jobState, "validated_no_store");
    assert.equal(replayedFinalize.resultStored, false);
    const replayedProviderReceipt = await successSystem.providerStore.read();
    const replayedJobReceipt = (await successSystem.jobStore.readSnapshot()).jobs[0];
    assert.equal(replayedProviderReceipt.workflowRevision, successProviderReceipt.workflowRevision,
      "response-loss replay must not apply the provider transition twice");
    assert.equal(replayedJobReceipt.workflowRevision, successSnapshot.jobs[0].workflowRevision,
      "response-loss replay must not rewrite a durable terminal job");

    const responseLossRoot = path.join(root, "worker-finalize-response-loss");
    await fsp.mkdir(responseLossRoot, { recursive: true });
    const responseLossSystem = await createFixtureSystem(responseLossRoot, keySet);
    await responseLossSystem.orchestrator.prepare({ operatorToken: OPERATOR_TOKEN, contract: contract() });
    const responseLossCounters = { internal: 0 };
    const durableInternalFetch = internalFetch(responseLossSystem.orchestrator, responseLossCounters);
    let loseFirstFinalizeResponse = true;
    const responseLossInternalFetch = async (url, options) => {
      const response = await durableInternalFetch(url, options);
      if (new URL(url).pathname === FINALIZE_PATH && loseFirstFinalizeResponse) {
        loseFirstFinalizeResponse = false;
        const error = new Error("synthetic internal response loss after durable finalize");
        error.code = "UND_ERR_SOCKET";
        throw error;
      }
      return response;
    };
    let responseLossProviderCalls = 0;
    const responseLossResult = await runWorker(
      responseLossSystem,
      keySet,
      liveTransport(async () => {
        responseLossProviderCalls += 1;
        return providerResponse(successBody());
      }),
      responseLossCounters,
      {},
      responseLossInternalFetch
    );
    assert.equal(responseLossProviderCalls, 1,
      "a lost Preview finalize response must never repeat the provider request");
    assert.equal(responseLossCounters.internal, 4,
      "the Worker may retry only the internal finalize handoff once");
    assert.equal(responseLossCounters.finalizeRequests, 2);
    assert.equal(responseLossResult.jobState, "validated_no_store");
    assert.equal(responseLossResult.resultStored, false);
    const responseLossSnapshot = await responseLossSystem.jobStore.readSnapshot();
    assert.equal(responseLossSnapshot.jobs[0].attemptNo, 1);
    assert.equal(responseLossSnapshot.jobs[0].state, "validated_no_store");

    const interruptedRoot = path.join(root, "interrupted-terminal-transition");
    await fsp.mkdir(interruptedRoot, { recursive: true });
    let interruptedDurableJobStore;
    let failTerminalTransitionOnce = true;
    let providerSuccessWrites = 0;
    let providerObservedArtifactReceipt = false;
    const interruptedSystem = await createFixtureSystem(interruptedRoot, keySet, () => NOW, {
      jobStore(store) {
        interruptedDurableJobStore = store;
        return Object.freeze({
          ...store,
          async transitionJob(input) {
            if (input.nextState === "validated_no_store" && failTerminalTransitionOnce) {
              failTerminalTransitionOnce = false;
              const error = new Error("synthetic job-store interruption after provider update");
              error.code = "COLLECTION_JOB_DURABLE_WRITE_INTERRUPTED";
              error.statusCode = 500;
              throw error;
            }
            return store.transitionJob(input);
          }
        });
      },
      providerStore(store) {
        return Object.freeze({
          ...store,
          async recordSuccess(input) {
            providerSuccessWrites += 1;
            const receipt = (await interruptedDurableJobStore.readSnapshot()).jobs[0];
            providerObservedArtifactReceipt = receipt?.state === "artifact_received"
              && /^[a-f0-9]{64}$/u.test(String(receipt?.artifactHash || ""));
            return store.recordSuccess(input);
          }
        });
      }
    });
    await interruptedSystem.orchestrator.prepare({ operatorToken: OPERATOR_TOKEN, contract: contract() });
    const interruptedCounters = { internal: 0 };
    const interruptedResult = await runWorker(
      interruptedSystem,
      keySet,
      liveTransport(async () => providerResponse(successBody())),
      interruptedCounters
    );
    assert.equal(providerObservedArtifactReceipt, true,
      "the signed artifact receipt must be durable before provider state changes");
    assert.equal(providerSuccessWrites, 1);
    const interruptedReceipt = (await interruptedDurableJobStore.readSnapshot()).jobs[0];
    const interruptedProvider = await interruptedSystem.durableProviderStore.read();
    assert.equal(interruptedCounters.finalizeRequests, 2,
      "a Preview 5xx may replay only the same internal artifact handoff once");
    assert.equal(interruptedResult.jobState, "validated_no_store");
    assert.equal(interruptedReceipt.state, "validated_no_store");
    assert.match(interruptedReceipt.artifactHash, /^[a-f0-9]{64}$/u);
    assert.equal(interruptedProvider.state, "closed");

    const converged = await interruptedSystem.orchestrator.finalize({
      signedRequest: signedWorkerRequest(FINALIZE_PATH, interruptedCounters.lastFinalizeBody, keySet, NOW),
      body: interruptedCounters.lastFinalizeBody
    });
    assert.equal(converged.status, "ready");
    assert.equal(converged.jobState, "validated_no_store");
    assert.equal(converged.replayed, true,
      "a receipt completed by the Worker retry must replay its terminal receipt");
    assert.equal(providerSuccessWrites, 1,
      "convergence must recognize the one completed provider CAS instead of applying it twice");
    assert.equal((await interruptedSystem.durableProviderStore.read()).workflowRevision,
      interruptedProvider.workflowRevision);
    assert.equal((await interruptedDurableJobStore.readSnapshot()).jobs[0].artifactHash,
      interruptedReceipt.artifactHash);

    const finalizeUnavailableRoot = path.join(root, "finalize-unavailable");
    await fsp.mkdir(finalizeUnavailableRoot, { recursive: true });
    const finalizeUnavailableSystem = await createFixtureSystem(finalizeUnavailableRoot, keySet);
    await finalizeUnavailableSystem.orchestrator.prepare({ operatorToken: OPERATOR_TOKEN, contract: contract() });
    const finalizeUnavailableCounters = { internal: 0, finalizeRequests: 0 };
    const finalizeUnavailableBaseFetch = internalFetch(
      finalizeUnavailableSystem.orchestrator,
      finalizeUnavailableCounters
    );
    const finalizeUnavailableFetch = async (url, options) => {
      if (new URL(url).pathname === FINALIZE_PATH) {
        finalizeUnavailableCounters.internal += 1;
        finalizeUnavailableCounters.finalizeRequests += 1;
        return response({ code: "COLLECTION_JOB_DURABLE_WRITE_INTERRUPTED" }, 503);
      }
      return finalizeUnavailableBaseFetch(url, options);
    };
    let finalizeUnavailableProviderCalls = 0;
    let finalizeUnavailableError;
    try {
      await runWorker(
        finalizeUnavailableSystem,
        keySet,
        liveTransport(async () => {
          finalizeUnavailableProviderCalls += 1;
          return providerResponse(successBody());
        }),
        finalizeUnavailableCounters,
        {},
        finalizeUnavailableFetch
      );
    } catch (error) {
      finalizeUnavailableError = error;
    }
    assert.equal(finalizeUnavailableProviderCalls, 1);
    assert.equal(finalizeUnavailableCounters.finalizeRequests, 2,
      "an unavailable Preview may receive at most two copies of the same artifact");
    assert.equal(finalizeUnavailableError?.code, "COLLECTION_WORKER_CANARY_FINALIZATION_INDETERMINATE");
    assert.equal(finalizeUnavailableError?.providerAttemptCount, 1);
    const finalizeUnavailableSafe = safeFatalResult(finalizeUnavailableError);
    assert.equal(finalizeUnavailableSafe.providerAttemptCount, 1,
      "fatal output must never downgrade an executed provider call to zero");
    assert.equal(finalizeUnavailableSafe.executedCallCount, 1);

    let replayProviderCalls = 0;
    await assert.rejects(
      () => runWorker(
        successSystem,
        keySet,
        liveTransport(async () => {
          replayProviderCalls += 1;
          return providerResponse(successBody());
        }),
        { internal: 0 }
      ),
      (error) => error?.code === "COLLECTION_WORKER_CANARY_NO_JOB"
    );
    assert.equal(replayProviderCalls, 0, "a new process cannot replay a durable terminal job");
    await assert.rejects(
      () => successSystem.orchestrator.prepare({ operatorToken: OPERATOR_TOKEN, contract: contract() }),
      (error) => error?.code === "COLLECTION_WORKER_CANARY_ALREADY_CREATED"
    );

    const historicalReceiptRoot = path.join(root, "historical-receipt-isolation");
    await fsp.mkdir(historicalReceiptRoot, { recursive: true });
    const historicalReceiptSystem = await createFixtureSystem(historicalReceiptRoot, keySet);
    await historicalReceiptSystem.jobStore.createOrReuseJob({
      jobId: "job-canary-historical-receipt",
      attemptId: "attempt:canary-historical-receipt",
      idempotencyKey: "b".repeat(64),
      contractHash: "c".repeat(64),
      executionIdentityHash: "d".repeat(64),
      backendId: "naver_place_search",
      backendVersion: "e".repeat(40),
      workerPoolId: "collector_pool_preview_01",
      providerWorkflowRevision: 0,
      maxProviderCalls: 1,
      now: NOW
    });
    const isolatedPrepared = await historicalReceiptSystem.orchestrator.prepare({
      operatorToken: OPERATOR_TOKEN,
      contract: contract()
    });
    assert.equal(isolatedPrepared.status, "queued");
    const isolatedSnapshot = await historicalReceiptSystem.jobStore.readSnapshot();
    assert.equal(isolatedSnapshot.jobs.length, 2, "historical receipts must be preserved");
    assert.equal(isolatedSnapshot.jobs[0].backendId, "naver_place_search");
    assert.equal(isolatedSnapshot.jobs[1].backendId, COLLECTION_WORKER_CANARY_BACKEND_ID);

    const adminSessionRoot = path.join(root, "trusted-admin-session-prepare");
    await fsp.mkdir(adminSessionRoot, { recursive: true });
    const adminSessionSystem = await createFixtureSystem(adminSessionRoot, keySet);
    const adminPrepared = await adminSessionSystem.orchestrator.prepareFromAdminSession({
      contract: contract()
    });
    assert.equal(adminPrepared.status, "queued");
    assert.equal(adminPrepared.maxProviderAttempts, 1);
    assert.equal(adminPrepared.resultWriteApproved, false);
    await assert.rejects(
      () => adminSessionSystem.orchestrator.prepareFromAdminSession({ contract: contract() }),
      (error) => error?.code === "COLLECTION_WORKER_CANARY_ALREADY_CREATED"
    );

    const restartQueuedRoot = path.join(root, "restart-queued");
    await fsp.mkdir(restartQueuedRoot, { recursive: true });
    const restartQueuedOriginal = await createFixtureSystem(restartQueuedRoot, keySet);
    await restartQueuedOriginal.orchestrator.prepare({ operatorToken: OPERATOR_TOKEN, contract: contract() });
    const restartQueuedSystem = await createFixtureSystem(restartQueuedRoot, keySet);
    await assert.rejects(
      () => restartQueuedSystem.orchestrator.prepare({ operatorToken: OPERATOR_TOKEN, contract: contract() }),
      (error) => error?.code === "COLLECTION_WORKER_CANARY_ALREADY_CREATED"
    );
    assert.equal((await restartQueuedSystem.jobStore.readSnapshot()).jobs[0].state, "indeterminate");
    assert.equal((await restartQueuedSystem.providerStore.read()).state, "closed",
      "a lost queued payload has not started provider work and may release its reservation");

    const restartCollectingRoot = path.join(root, "restart-collecting");
    await fsp.mkdir(restartCollectingRoot, { recursive: true });
    const restartCollectingOriginal = await createFixtureSystem(restartCollectingRoot, keySet);
    const restartCollectingPrepared = await restartCollectingOriginal.orchestrator.prepare({
      operatorToken: OPERATOR_TOKEN,
      contract: contract()
    });
    const restartLeased = await restartCollectingOriginal.jobStore.claimNextJob({
      jobId: restartCollectingPrepared.jobId,
      workerId: COLLECTION_WORKER_CANARY_WORKER_ID,
      workerPoolId: COLLECTION_WORKER_CANARY_WORKER_POOL_ID,
      providerWorkflowRevision: restartCollectingPrepared.providerWorkflowRevision,
      leaseMs: 2 * 60 * 1000,
      now: NOW
    });
    await restartCollectingOriginal.jobStore.transitionJob({
      jobId: restartLeased.jobId,
      expectedWorkflowRevision: restartLeased.workflowRevision,
      workerId: COLLECTION_WORKER_CANARY_WORKER_ID,
      nextState: "collecting",
      now: NOW
    });
    const restartCollectingSystem = await createFixtureSystem(restartCollectingRoot, keySet);
    await assert.rejects(
      () => restartCollectingSystem.orchestrator.prepare({ operatorToken: OPERATOR_TOKEN, contract: contract() }),
      (error) => error?.code === "COLLECTION_WORKER_CANARY_ALREADY_CREATED"
    );
    assert.equal((await restartCollectingSystem.jobStore.readSnapshot()).jobs[0].state, "indeterminate");
    assert.equal((await restartCollectingSystem.providerStore.read()).state, "open",
      "a lost collecting payload must fail closed because an external attempt may have started");

    let finalizeClock = NOW;
    const expiredFinalizeRoot = path.join(root, "expired-finalize");
    await fsp.mkdir(expiredFinalizeRoot, { recursive: true });
    const expiredFinalizeSystem = await createFixtureSystem(expiredFinalizeRoot, keySet, () => finalizeClock);
    await expiredFinalizeSystem.orchestrator.prepare({ operatorToken: OPERATOR_TOKEN, contract: contract() });
    const expiredFinalizeClaimBody = {
      workerId: COLLECTION_WORKER_CANARY_WORKER_ID,
      workerPoolId: COLLECTION_WORKER_CANARY_WORKER_POOL_ID,
      workerCommit: COMMIT
    };
    const expiredFinalizeClaim = await expiredFinalizeSystem.orchestrator.claim({
      signedRequest: signedWorkerRequest(CLAIM_PATH, expiredFinalizeClaimBody, keySet, finalizeClock),
      body: expiredFinalizeClaimBody
    });
    finalizeClock = new Date(NOW.getTime() + 121_000);
    const staleArtifactBody = {
      jobId: expiredFinalizeClaim.job.signedJob.jobId,
      attemptId: expiredFinalizeClaim.job.signedJob.attemptId,
      workflowRevision: expiredFinalizeClaim.job.workflowRevision,
      signedArtifact: {}
    };
    await assert.rejects(
      () => expiredFinalizeSystem.orchestrator.finalize({
        signedRequest: signedWorkerRequest(FINALIZE_PATH, staleArtifactBody, keySet, finalizeClock),
        body: staleArtifactBody
      }),
      (error) => error?.code === "COLLECTION_WORKER_CANARY_LEASE_EXPIRED"
    );
    assert.equal((await expiredFinalizeSystem.jobStore.readSnapshot()).jobs[0].state, "indeterminate");
    assert.equal((await expiredFinalizeSystem.providerStore.read()).state, "open");

    let failureClock = NOW;
    const expiredFailureRoot = path.join(root, "expired-failure");
    await fsp.mkdir(expiredFailureRoot, { recursive: true });
    const expiredFailureSystem = await createFixtureSystem(expiredFailureRoot, keySet, () => failureClock);
    await expiredFailureSystem.orchestrator.prepare({ operatorToken: OPERATOR_TOKEN, contract: contract() });
    const expiredFailureClaimBody = {
      workerId: COLLECTION_WORKER_CANARY_WORKER_ID,
      workerPoolId: COLLECTION_WORKER_CANARY_WORKER_POOL_ID,
      workerCommit: COMMIT
    };
    const expiredFailureClaim = await expiredFailureSystem.orchestrator.claim({
      signedRequest: signedWorkerRequest(CLAIM_PATH, expiredFailureClaimBody, keySet, failureClock),
      body: expiredFailureClaimBody
    });
    failureClock = new Date(NOW.getTime() + 121_000);
    const expiredFailureBody = {
      jobId: expiredFailureClaim.job.signedJob.jobId,
      attemptId: expiredFailureClaim.job.signedJob.attemptId,
      workflowRevision: expiredFailureClaim.job.workflowRevision,
      code: "COLLECTION_WORKER_CANARY_EXECUTION_FAILED",
      providerAttemptCount: 1
    };
    await assert.rejects(
      () => expiredFailureSystem.orchestrator.recordFailure({
        signedRequest: signedWorkerRequest(FAILURE_PATH, expiredFailureBody, keySet, failureClock),
        body: expiredFailureBody
      }),
      (error) => error?.code === "COLLECTION_WORKER_CANARY_LEASE_EXPIRED"
    );
    assert.equal((await expiredFailureSystem.jobStore.readSnapshot()).jobs[0].state, "indeterminate");
    assert.equal((await expiredFailureSystem.providerStore.read()).state, "open");

    const failureRecoveryRoot = path.join(root, "failure-recovery");
    await fsp.mkdir(failureRecoveryRoot, { recursive: true });
    let failFailureTerminalOnce = true;
    let failureProviderBlocks = 0;
    const failureRecoverySystem = await createFixtureSystem(failureRecoveryRoot, keySet, () => NOW, {
      jobStore(store) {
        return Object.freeze({
          ...store,
          async transitionJob(input) {
            if (input.nextState === "failed" && failFailureTerminalOnce) {
              failFailureTerminalOnce = false;
              const error = new Error("synthetic failure terminal interruption");
              error.code = "COLLECTION_JOB_DURABLE_WRITE_INTERRUPTED";
              error.statusCode = 500;
              throw error;
            }
            return store.transitionJob(input);
          }
        });
      },
      providerStore(store) {
        return Object.freeze({
          ...store,
          async recordBlock(input) {
            failureProviderBlocks += 1;
            return store.recordBlock(input);
          }
        });
      }
    });
    await failureRecoverySystem.orchestrator.prepare({ operatorToken: OPERATOR_TOKEN, contract: contract() });
    const failureRecoveryClaimBody = {
      workerId: COLLECTION_WORKER_CANARY_WORKER_ID,
      workerPoolId: COLLECTION_WORKER_CANARY_WORKER_POOL_ID,
      workerCommit: COMMIT
    };
    const failureRecoveryClaim = await failureRecoverySystem.orchestrator.claim({
      signedRequest: signedWorkerRequest(CLAIM_PATH, failureRecoveryClaimBody, keySet, NOW),
      body: failureRecoveryClaimBody
    });
    const failureRecoveryBody = {
      jobId: failureRecoveryClaim.job.signedJob.jobId,
      attemptId: failureRecoveryClaim.job.signedJob.attemptId,
      workflowRevision: failureRecoveryClaim.job.workflowRevision,
      code: "COLLECTION_WORKER_CANARY_EXECUTION_FAILED",
      providerAttemptCount: 1
    };
    await assert.rejects(
      () => failureRecoverySystem.orchestrator.recordFailure({
        signedRequest: signedWorkerRequest(FAILURE_PATH, failureRecoveryBody, keySet, NOW),
        body: failureRecoveryBody
      }),
      (error) => error?.code === "COLLECTION_JOB_DURABLE_WRITE_INTERRUPTED"
    );
    const failureReceived = (await failureRecoverySystem.jobStore.readSnapshot()).jobs[0];
    const failureProviderReceipt = await failureRecoverySystem.providerStore.read();
    assert.equal(failureReceived.state, "failure_received");
    assert.match(failureReceived.failureReceiptHash, /^[a-f0-9]{64}$/u);
    assert.equal(failureReceived.providerAttemptCount, 1);
    assert.equal(failureProviderReceipt.state, "open",
      "an unknown failure after one provider call must open the circuit fail-closed");
    assert.equal(failureProviderReceipt.lastFailureSubtype, "unknown_access_block");
    assert.equal(failureProviderReceipt.lastOutcomeKind, "block");
    assert.equal(failureProviderReceipt.lastOutcomeReceiptHash, failureReceived.failureReceiptHash);
    const recoveredFailure = await failureRecoverySystem.orchestrator.recordFailure({
      signedRequest: signedWorkerRequest(FAILURE_PATH, failureRecoveryBody, keySet, NOW),
      body: failureRecoveryBody
    });
    assert.equal(recoveredFailure.jobState, "failed");
    assert.equal(failureProviderBlocks, 1,
      "failure convergence must not apply the provider block twice");
    const replayedFailure = await failureRecoverySystem.orchestrator.recordFailure({
      signedRequest: signedWorkerRequest(FAILURE_PATH, failureRecoveryBody, keySet, NOW),
      body: failureRecoveryBody
    });
    assert.equal(replayedFailure.replayed, true);
    assert.equal(failureProviderBlocks, 1);

    const workerFailureLossRoot = path.join(root, "worker-failure-response-loss");
    await fsp.mkdir(workerFailureLossRoot, { recursive: true });
    const workerFailureLossSystem = await createFixtureSystem(workerFailureLossRoot, keySet);
    await workerFailureLossSystem.orchestrator.prepare({ operatorToken: OPERATOR_TOKEN, contract: contract() });
    const workerFailureLossCounters = { internal: 0 };
    const workerFailureLossBaseFetch = internalFetch(
      workerFailureLossSystem.orchestrator,
      workerFailureLossCounters
    );
    let loseFirstFailureResponse = true;
    const workerFailureLossFetch = async (url, options) => {
      const response = await workerFailureLossBaseFetch(url, options);
      if (new URL(url).pathname === FAILURE_PATH && loseFirstFailureResponse) {
        loseFirstFailureResponse = false;
        const error = new Error("synthetic failure response loss after durable receipt");
        error.code = "UND_ERR_SOCKET";
        throw error;
      }
      return response;
    };
    let workerFailureLossProviderCalls = 0;
    let workerFailureLossError;
    try {
      await runWorker(
        workerFailureLossSystem,
        keySet,
        liveTransport(async () => {
          workerFailureLossProviderCalls += 1;
          return providerResponse(successBody());
        }),
        workerFailureLossCounters,
        {},
        workerFailureLossFetch,
        {
          afterProviderExecution() {
            const error = new Error("synthetic runtime failure after provider execution");
            error.code = "COLLECTION_WORKER_CANARY_POST_PROVIDER_FIXTURE_FAILURE";
            error.statusCode = 500;
            throw error;
          }
        }
      );
    } catch (error) {
      workerFailureLossError = error;
    }
    assert.equal(workerFailureLossError?.code, "COLLECTION_WORKER_CANARY_POST_PROVIDER_FIXTURE_FAILURE");
    assert.equal(workerFailureLossError?.providerAttemptCount, 1);
    assert.equal(workerFailureLossProviderCalls, 1);
    assert.equal(workerFailureLossCounters.failureRequests, 2,
      "a lost failure acknowledgement may replay only the internal failure receipt once");
    const workerFailureLossJob = (await workerFailureLossSystem.jobStore.readSnapshot()).jobs[0];
    const workerFailureLossProvider = await workerFailureLossSystem.providerStore.read();
    assert.equal(workerFailureLossJob.state, "failed");
    assert.equal(workerFailureLossJob.providerAttemptCount, 1);
    assert.equal(workerFailureLossProvider.state, "open");
    assert.equal(workerFailureLossProvider.lastFailureSubtype, "unknown_access_block");

    const concurrentRoot = path.join(root, "concurrent");
    await fsp.mkdir(concurrentRoot, { recursive: true });
    const concurrentSystem = await createFixtureSystem(concurrentRoot, keySet);
    await concurrentSystem.orchestrator.prepare({ operatorToken: OPERATOR_TOKEN, contract: contract() });
    let concurrentProviderCalls = 0;
    const makeConcurrentTransport = () => liveTransport(async () => {
      concurrentProviderCalls += 1;
      return providerResponse(successBody());
    });
    const concurrent = await Promise.allSettled([
      runWorker(concurrentSystem, keySet, makeConcurrentTransport(), { internal: 0 }),
      runWorker(concurrentSystem, keySet, makeConcurrentTransport(), { internal: 0 })
    ]);
    assert.equal(concurrent.filter((entry) => entry.status === "fulfilled").length, 1);
    assert.equal(concurrent.filter(
      (entry) => entry.status === "rejected" && entry.reason?.code === "COLLECTION_WORKER_CANARY_NO_JOB"
    ).length, 1);
    assert.equal(concurrentProviderCalls, 1, "concurrent worker processes must share one durable provider attempt");

    const blockedRoot = path.join(root, "blocked");
    await fsp.mkdir(blockedRoot, { recursive: true });
    const blockedSystem = await createFixtureSystem(blockedRoot, keySet);
    await blockedSystem.orchestrator.prepare({ operatorToken: OPERATOR_TOKEN, contract: contract() });
    let blockedCalls = 0;
    const blockedResult = await runWorker(
      blockedSystem,
      keySet,
      liveTransport(async () => {
        blockedCalls += 1;
        return providerResponse("", 403);
      }),
      { internal: 0 }
    );
    assert.equal(blockedCalls, 1);
    assert.equal(blockedResult.status, "blocked");
    assert.equal(blockedResult.code, "NAVER_ACCESS_BLOCKED");
    assert.equal(blockedResult.providerFailureSubtype, "http_403");
    assert.equal(blockedResult.jobState, "blocked");
    assert.equal(blockedResult.resultStored, false);
    assert.equal((await blockedSystem.providerStore.read()).state, "open");
    assert.equal((await blockedSystem.jobStore.readSnapshot()).jobs[0].state, "blocked");
    const blockedProviderReceipt = await blockedSystem.providerStore.read();
    const blockedJobReceipt = (await blockedSystem.jobStore.readSnapshot()).jobs[0];
    assert.equal(blockedProviderReceipt.lastOutcomeKind, "block");
    assert.equal(blockedProviderReceipt.lastOutcomeReceiptHash, blockedJobReceipt.artifactHash);

    const partialRoot = path.join(root, "partial");
    await fsp.mkdir(partialRoot, { recursive: true });
    const partialSystem = await createFixtureSystem(partialRoot, keySet);
    await partialSystem.orchestrator.prepare({ operatorToken: OPERATOR_TOKEN, contract: contract() });
    const partialResult = await runWorker(
      partialSystem,
      keySet,
      liveTransport(async () => providerResponse(successBody(1))),
      { internal: 0 }
    );
    assert.equal(partialResult.status, "partial");
    assert.equal(partialResult.organicCount, 1);
    assert.equal(partialResult.jobState, "failed");
    assert.equal(partialResult.code, "COLLECTION_WORKER_CANARY_NOT_READY");
    assert.equal(partialResult.resultStored, false);
    const partialProviderReceipt = await partialSystem.providerStore.read();
    const partialJobReceipt = (await partialSystem.jobStore.readSnapshot()).jobs[0];
    assert.equal(partialProviderReceipt.state, "closed");
    assert.equal(partialProviderReceipt.lastOutcomeKind, "release");
    assert.equal(partialProviderReceipt.lastOutcomeReceiptHash, partialJobReceipt.artifactHash);

    const cooldownRoot = path.join(root, "cooldown");
    await fsp.mkdir(cooldownRoot, { recursive: true });
    const cooldownSystem = await createFixtureSystem(cooldownRoot, keySet);
    const cooldownInitial = await cooldownSystem.providerStore.read();
    const cooldownReservation = await cooldownSystem.providerStore.beginAttempt({
      expectedWorkflowRevision: cooldownInitial.workflowRevision,
      explicit: true,
      now: NOW
    });
    await cooldownSystem.providerStore.recordBlock({
      expectedWorkflowRevision: cooldownReservation.state.workflowRevision,
      failure: {
        subtype: "http_403",
        diagnosticId: "crawl-aaaaaaaaaaaa"
      },
      now: NOW
    });
    await assert.rejects(
      () => cooldownSystem.orchestrator.prepare({ operatorToken: OPERATOR_TOKEN, contract: contract() }),
      (error) => error?.code === "NAVER_PROVIDER_COOLDOWN_ACTIVE"
    );
    assert.equal((await cooldownSystem.jobStore.readSnapshot()).jobs.length, 0, "cooldown must block job creation");

    const unauthorizedRoot = path.join(root, "unauthorized");
    await fsp.mkdir(unauthorizedRoot, { recursive: true });
    const unauthorizedSystem = await createFixtureSystem(unauthorizedRoot, keySet);
    await assert.rejects(
      () => unauthorizedSystem.orchestrator.prepare({
        operatorToken: "wrong-operator-token-with-at-least-thirty-two-characters",
        contract: contract()
      }),
      (error) => error?.code === "COLLECTION_WORKER_CANARY_OPERATOR_UNAUTHORIZED"
    );
    assert.equal((await unauthorizedSystem.jobStore.readSnapshot()).jobs.length, 0);

    const mismatchRoot = path.join(root, "key-mismatch");
    await fsp.mkdir(mismatchRoot, { recursive: true });
    const mismatchSystem = await createFixtureSystem(mismatchRoot, keySet);
    await mismatchSystem.orchestrator.prepare({ operatorToken: OPERATOR_TOKEN, contract: contract() });
    const wrongKeys = { ...keySet, dispatch: crypto.generateKeyPairSync("ed25519") };
    let mismatchProviderCalls = 0;
    await assert.rejects(
      () => runWorker(
        mismatchSystem,
        wrongKeys,
        liveTransport(async () => {
          mismatchProviderCalls += 1;
          return providerResponse(successBody());
        }),
        { internal: 0 }
      ),
      (error) => error?.code === "COLLECTION_WORKER_SIGNATURE_INVALID"
        || error?.code === "COLLECTION_WORKER_SIGNING_KEY_INVALID"
    );
    assert.equal(mismatchProviderCalls, 0, "untrusted dispatch signatures fail before provider transport");

    const artifactMismatchRoot = path.join(root, "artifact-key-mismatch");
    await fsp.mkdir(artifactMismatchRoot, { recursive: true });
    const artifactMismatchSystem = await createFixtureSystem(artifactMismatchRoot, keySet);
    await artifactMismatchSystem.orchestrator.prepare({ operatorToken: OPERATOR_TOKEN, contract: contract() });
    const wrongArtifactKeys = { ...keySet, artifact: crypto.generateKeyPairSync("ed25519") };
    let artifactMismatchProviderCalls = 0;
    const artifactMismatchCounters = { internal: 0 };
    await assert.rejects(
      () => runWorker(
        artifactMismatchSystem,
        wrongArtifactKeys,
        liveTransport(async () => {
          artifactMismatchProviderCalls += 1;
          return providerResponse(successBody());
        }),
        artifactMismatchCounters
      ),
      (error) => error?.code === "COLLECTION_WORKER_CANARY_ARTIFACT_KEY_MISMATCH"
    );
    assert.equal(artifactMismatchProviderCalls, 0, "artifact key mismatch must fail before provider transport");
    assert.equal(artifactMismatchCounters.internal, 3, "claim, rejected preflight, and failure finalization are expected");
    assert.equal((await artifactMismatchSystem.jobStore.readSnapshot()).jobs[0].state, "failed");
    assert.equal((await artifactMismatchSystem.providerStore.read()).state, "closed");

    const disabledRoot = path.join(root, "disabled");
    await fsp.mkdir(disabledRoot, { recursive: true });
    const disabledSystem = await createFixtureSystem(disabledRoot, keySet);
    await disabledSystem.orchestrator.prepare({ operatorToken: OPERATOR_TOKEN, contract: contract() });
    let disabledCalls = 0;
    await assert.rejects(
      () => runWorker(
        disabledSystem,
        keySet,
        liveTransport(async () => {
          disabledCalls += 1;
          return providerResponse(successBody());
        }),
        { internal: 0 },
        { [ENV.oneShotEnabled]: "false" }
      ),
      (error) => error?.code === "COLLECTION_WORKER_CANARY_RUNTIME_INVALID"
    );
    assert.equal(disabledCalls, 0);

    const cli = spawnSync(process.execPath, [path.join(__dirname, "run_collection_worker_naver_canary_once.cjs")], {
      cwd: path.resolve(__dirname, ".."),
      encoding: "utf8",
      env: { ...process.env, RENDER: "", NODE_ENV: "test" }
    });
    assert.equal(cli.status, 1);
    assert.equal(cli.stderr, "");
    const cliLines = cli.stdout.trim().split(/\r?\n/u);
    assert.equal(cliLines.length, 1, "CLI failure output must be one sanitized JSON line");
    const cliResult = JSON.parse(cliLines[0]);
    assert.equal(cliResult.providerAttemptCount, 0);
    assert.equal(JSON.stringify(cliResult).includes(KEYWORD), false);

    const workerSource = await fsp.readFile(path.join(__dirname, "collection_worker_naver_canary.cjs"), "utf8");
    assert.equal(/require\(["'](?:node:)?fs/u.test(workerSource), false, "worker executor must not depend on filesystem APIs");
    assert.equal(/create(?:SecureJson|CollectionJob|NaverProviderHealth)Store/u.test(workerSource), false,
      "worker executor must not own durable stores");

    assert.equal(guard.blockedAttempts(), 0);
    console.log("Collection worker durable one-shot, circuit-bound, no-store NAVER canary fixtures passed.");
  } finally {
    guard.restore();
    const relative = path.relative(path.resolve(os.tmpdir()), path.resolve(root));
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`refusing to remove unexpected fixture directory: ${root}`);
    }
    await fsp.rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
