"use strict";

const assert = require("node:assert/strict");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { installFixtureNetworkGuard } = require("./fixture_network_guard.cjs");
const {
  apolloHtml,
  createApolloFixture
} = require("./naver_collector_fixture_factory.cjs");
const {
  NAVER_LEGACY_CANARY_PHASE,
  NAVER_LEGACY_CANARY_PLAN_VERSION,
  NAVER_LEGACY_CANARY_SCOPE,
  NAVER_LEGACY_CANARY_STRATEGY,
  NAVER_LEGACY_CANARY_STRATEGY_VERSION
} = require("./naver_legacy_canary_contract.cjs");
const { createNaverProviderHealthStore } = require("./naver_provider_health_store.cjs");
const {
  NAVER_LEGACY_CANARY_APPROVAL_SCHEMA_VERSION,
  TARGET_PREVIEW_SERVICE_ID,
  buildLiveCanaryPlan,
  runNaverLegacyCanaryOnce,
  safeCanaryErrorResult
} = require("./naver_legacy_canary_once.cjs");

const guard = installFixtureNetworkGuard({ label: "naver legacy canary once fixtures" });
const BASE_TIME = new Date("2026-08-06T03:00:00.000Z");
const TARGET_COMMIT = "a".repeat(40);
const CONTRACT = Object.freeze({
  keyword: "Synthetic canary lodging",
  searchMode: "keyword",
  rankStart: 1,
  rankEnd: 50,
  display: 50,
  regionKey: null,
  categoryKey: "glamping",
  measurementPeriod: null,
  currentQueryCandidates: Object.freeze(["Synthetic canary lodging"]),
  legacyNaverQuery: "Synthetic canary lodging"
});

function approvalFor(contract, workflowRevision, overrides = {}) {
  const plan = buildLiveCanaryPlan(contract);
  return Object.freeze({
    schemaVersion: NAVER_LEGACY_CANARY_APPROVAL_SCHEMA_VERSION,
    targetServiceId: TARGET_PREVIEW_SERVICE_ID,
    targetCommit: TARGET_COMMIT,
    notBefore: new Date(BASE_TIME.getTime() - 1_000).toISOString(),
    expiresAt: new Date(BASE_TIME.getTime() + 5 * 60_000).toISOString(),
    planVersion: NAVER_LEGACY_CANARY_PLAN_VERSION,
    strategy: NAVER_LEGACY_CANARY_STRATEGY,
    strategyVersion: NAVER_LEGACY_CANARY_STRATEGY_VERSION,
    phase: NAVER_LEGACY_CANARY_PHASE,
    collectorScope: NAVER_LEGACY_CANARY_SCOPE,
    expectedContractHash: plan.collectorPlan.contractHash,
    expectedExecutionIdentityHash: plan.executionIdentityHash,
    expectedWorkflowRevision: workflowRevision,
    maxProviderAttempts: 1,
    authorizedCallCount: 1,
    concurrency: 1,
    automaticRetry: false,
    automaticFallback: false,
    externalCallApproved: true,
    providerHealthWriteApproved: true,
    resultWriteApproved: false,
    saveResult: false,
    ...overrides
  });
}

function fakeResponse(body, status = 200, headers = {}) {
  return {
    status,
    headers: new Headers({ "content-type": "text/html; charset=utf-8", ...headers }),
    text: async () => body
  };
}

function successBody(display = 50) {
  const { state } = createApolloFixture({
    query: CONTRACT.keyword,
    display,
    items: [
      { id: "fixture-place-a", name: "Fixture Lodge A", roadAddress: "Fixture road A" },
      { id: "fixture-place-b", name: "Fixture Lodge B", roadAddress: "Fixture road B" }
    ]
  });
  createApolloFixture({
    state,
    operation: "adBusinesses",
    query: CONTRACT.keyword,
    items: [{ id: "fixture-ad-a", name: "Fixture Ad A", roadAddress: "Fixture ad road" }]
  });
  return apolloHtml(state);
}

async function createFixtureStore(root, now = () => BASE_TIME) {
  return createNaverProviderHealthStore({
    filePath: path.join(root, "provider_health", "naver_place_search.json"),
    runtimeRoot: root,
    now
  });
}

async function filesUnder(root) {
  const result = [];
  async function walk(current) {
    const entries = await fsp.readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(target);
      else result.push(path.relative(root, target).replace(/\\/g, "/"));
    }
  }
  await walk(root);
  return result.sort();
}

async function runWith(root, providerStore, approval, fetchImpl, options = {}) {
  return runNaverLegacyCanaryOnce({
    contract: CONTRACT,
    approval,
    environment: {},
    runtimeRoot: root,
    runtimeIdentityValidator: () => true,
    providerStore,
    fetchImpl,
    fixtureMode: true,
    now: options.now || BASE_TIME,
    completedAt: options.completedAt || new Date(BASE_TIME.getTime() + 2_000)
  });
}

(async () => {
  const roots = [];
  try {
    let forbiddenStoreReads = 0;
    let forbiddenFetches = 0;
    await assert.rejects(
      () => runNaverLegacyCanaryOnce({
        contract: CONTRACT,
        approval: approvalFor(CONTRACT, 0),
        environment: {},
        runtimeRoot: os.tmpdir(),
        runtimeIdentityValidator: () => true,
        providerStore: { read: async () => { forbiddenStoreReads += 1; } },
        fetchImpl: async () => { forbiddenFetches += 1; }
      }),
      (error) => error?.code === "NAVER_LEGACY_CANARY_TRANSPORT_INVALID"
    );
    assert.equal(forbiddenStoreReads, 0);
    assert.equal(forbiddenFetches, 0);

    const successRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "naver-canary-success-"));
    roots.push(successRoot);
    const successStore = await createFixtureStore(successRoot);
    let successCalls = 0;
    const approval = approvalFor(CONTRACT, 0);
    const success = await runWith(successRoot, successStore, approval, async () => {
      successCalls += 1;
      return fakeResponse(successBody());
    });
    assert.equal(success.status, "ready");
    assert.equal(success.organicCount, 2);
    assert.equal(success.adCount, 1);
    assert.equal(success.executedCallCount, 1);
    assert.equal(success.resultStored, false);
    assert.equal(successCalls, 1);
    const succeededState = await successStore.read();
    assert.equal(succeededState.state, "closed");
    assert.equal(succeededState.workflowRevision, 2);
    assert.equal(succeededState.lastSuccessAt, new Date(BASE_TIME.getTime() + 2_000).toISOString());
    assert.deepEqual(await filesUnder(successRoot), ["provider_health/naver_place_search.json"]);

    await assert.rejects(
      () => runWith(successRoot, successStore, approval, async () => {
        successCalls += 1;
        return fakeResponse(successBody());
      }),
      (error) => error?.code === "NAVER_PROVIDER_WORKFLOW_REVISION_CONFLICT"
    );
    assert.equal(successCalls, 1);

    const blockedRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "naver-canary-blocked-"));
    roots.push(blockedRoot);
    const blockedStore = await createFixtureStore(blockedRoot);
    let blockedCalls = 0;
    let blockedError = null;
    try {
      await runWith(blockedRoot, blockedStore, approvalFor(CONTRACT, 0), async () => {
        blockedCalls += 1;
        return fakeResponse("<html><body>captcha security check</body></html>", 403);
      });
    } catch (error) {
      blockedError = error;
    }
    assert.equal(blockedError?.code, "NAVER_ACCESS_BLOCKED");
    assert.equal(blockedError?.providerFailureSubtype, "http_403");
    assert.equal(blockedCalls, 1);
    const blockedState = await blockedStore.read();
    assert.equal(blockedState.state, "open");
    assert.equal(blockedState.workflowRevision, 2);
    assert.equal(blockedState.consecutiveBlocks, 1);
    assert.match(blockedState.lastDiagnosticId, /^crawl-[a-f0-9]{12}$/u);
    const publicBlocked = safeCanaryErrorResult(blockedError);
    assert.equal(publicBlocked.executedCallCount, 1);
    assert.equal(JSON.stringify(publicBlocked).includes(CONTRACT.keyword), false);

    let cooldownCalls = 0;
    await assert.rejects(
      () => runWith(
        blockedRoot,
        blockedStore,
        approvalFor(CONTRACT, 2),
        async () => {
          cooldownCalls += 1;
          return fakeResponse(successBody());
        },
        { now: new Date(BASE_TIME.getTime() + 60_000), completedAt: new Date(BASE_TIME.getTime() + 62_000) }
      ),
      (error) => error?.code === "NAVER_PROVIDER_COOLDOWN_ACTIVE" && error?.externalAttemptCount === 0
    );
    assert.equal(cooldownCalls, 0);

    const rateLimitedRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "naver-canary-rate-limited-"));
    roots.push(rateLimitedRoot);
    const rateLimitedStore = await createFixtureStore(rateLimitedRoot);
    let rateLimitedCalls = 0;
    let rateLimitedError = null;
    try {
      await runWith(rateLimitedRoot, rateLimitedStore, approvalFor(CONTRACT, 0), async () => {
        rateLimitedCalls += 1;
        return fakeResponse("ignored oversized provider body", 429, { "retry-after": "120" });
      });
    } catch (error) {
      rateLimitedError = error;
    }
    assert.equal(rateLimitedError?.code, "NAVER_ACCESS_BLOCKED");
    assert.equal(rateLimitedError?.providerFailureSubtype, "http_429");
    assert.equal(rateLimitedError?.retryAfterSeconds, 120);
    assert.equal(rateLimitedCalls, 1);
    const rateLimitedState = await rateLimitedStore.read();
    assert.equal(rateLimitedState.state, "open");
    assert.equal(rateLimitedState.lastFailureSubtype, "http_429");

    const challengeRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "naver-canary-challenge-"));
    roots.push(challengeRoot);
    const challengeStore = await createFixtureStore(challengeRoot);
    let challengeCalls = 0;
    let challengeError = null;
    try {
      await runWith(challengeRoot, challengeStore, approvalFor(CONTRACT, 0), async () => {
        challengeCalls += 1;
        return fakeResponse("<html><body>captcha security check</body></html>");
      });
    } catch (error) {
      challengeError = error;
    }
    assert.equal(challengeError?.code, "NAVER_ACCESS_BLOCKED");
    assert.equal(challengeError?.providerFailureSubtype, "challenge_html");
    assert.equal(challengeCalls, 1);
    const challengeState = await challengeStore.read();
    assert.equal(challengeState.state, "open");
    assert.equal(challengeState.lastFailureSubtype, "challenge_html");

    const malformedRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "naver-canary-malformed-"));
    roots.push(malformedRoot);
    const malformedStore = await createFixtureStore(malformedRoot);
    let malformedCalls = 0;
    await assert.rejects(
      () => runWith(malformedRoot, malformedStore, approvalFor(CONTRACT, 0), async () => {
        malformedCalls += 1;
        return fakeResponse("<html><body>not apollo</body></html>");
      }),
      (error) => error?.code === "NAVER_APOLLO_STATE_INVALID" && error?.externalAttemptCount === 1
    );
    assert.equal(malformedCalls, 1);
    const malformedState = await malformedStore.read();
    assert.equal(malformedState.state, "closed");
    assert.equal(malformedState.workflowRevision, 2);
    assert.equal(malformedState.lastSuccessAt, null);

    const wrongDisplayRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "naver-canary-display-"));
    roots.push(wrongDisplayRoot);
    const wrongDisplayStore = await createFixtureStore(wrongDisplayRoot);
    await assert.rejects(
      () => runWith(wrongDisplayRoot, wrongDisplayStore, approvalFor(CONTRACT, 0), async () => fakeResponse(successBody(20))),
      (error) => error?.code === "NAVER_SEARCH_CONTRACT_UNAVAILABLE" && error?.externalAttemptCount === 1
    );
    const wrongDisplayState = await wrongDisplayStore.read();
    assert.equal(wrongDisplayState.state, "closed");
    assert.equal(wrongDisplayState.workflowRevision, 2);

    const invalidTransportRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "naver-canary-invalid-transport-"));
    roots.push(invalidTransportRoot);
    const invalidTransportStore = await createFixtureStore(invalidTransportRoot);
    await assert.rejects(
      () => runWith(invalidTransportRoot, invalidTransportStore, approvalFor(CONTRACT, 0), null),
      (error) => error?.code === "NAVER_LEGACY_CANARY_TRANSPORT_DISABLED" && error?.externalAttemptCount === 0
    );
    const invalidTransportState = await invalidTransportStore.read();
    assert.equal(invalidTransportState.state, "closed");
    assert.equal(invalidTransportState.workflowRevision, 2);

    const concurrentRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "naver-canary-concurrent-"));
    roots.push(concurrentRoot);
    const concurrentStores = await Promise.all([
      createFixtureStore(concurrentRoot),
      createFixtureStore(concurrentRoot),
      createFixtureStore(concurrentRoot)
    ]);
    let concurrentCalls = 0;
    const slowFetch = async () => {
      concurrentCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 25));
      return fakeResponse(successBody());
    };
    const concurrentApproval = approvalFor(CONTRACT, 0);
    const concurrentResults = await Promise.allSettled([
      runWith(concurrentRoot, concurrentStores[0], concurrentApproval, slowFetch),
      runWith(concurrentRoot, concurrentStores[1], concurrentApproval, slowFetch),
      runWith(concurrentRoot, concurrentStores[2], concurrentApproval, slowFetch)
    ]);
    assert.equal(concurrentResults.filter((entry) => entry.status === "fulfilled").length, 1);
    assert.equal(concurrentResults.filter((entry) => entry.status === "rejected").length, 2);
    assert.equal(concurrentCalls, 1);

    const maliciousPublicError = safeCanaryErrorResult({
      code: "SECRET_CANARY_TOKEN",
      providerFailureSubtype: "secret-provider-subtype",
      diagnosticId: "crawl-deadbeef0000-secret",
      retryAt: "2026-08-06T05:00:00.000Z-secret",
      retryAfterSeconds: 999_999,
      externalAttemptCount: 999_999
    });
    assert.deepEqual(maliciousPublicError, {
      status: "failed",
      code: "NAVER_LEGACY_CANARY_FAILED",
      providerResponseSubtype: null,
      diagnosticId: null,
      retryAt: null,
      retryAfterSeconds: null,
      executedCallCount: 0,
      resultStored: false
    });
    assert.equal(JSON.stringify(maliciousPublicError).includes("SECRET"), false);

    assert.equal(guard.blockedAttempts(), 0);
    console.log("NAVER legacy canary once fixtures passed");
  } finally {
    for (const root of roots) {
      const resolved = path.resolve(root);
      assert.equal(resolved.startsWith(path.resolve(os.tmpdir())), true);
      await fsp.rm(resolved, { recursive: true, force: true });
    }
    guard.restore();
  }
})().catch((error) => {
  guard.restore();
  console.error(error);
  process.exitCode = 1;
});
