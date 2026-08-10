"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const {
  FIXED_V2_WORKER_RUNTIME_FINGERPRINT
} = require("./collection_worker_contract.cjs");
const {
  createCollectionJobStore
} = require("./collection_job_store.cjs");
const {
  createNaverProviderHealthStore
} = require("./naver_provider_health_store.cjs");
const {
  V2_TOP20_CONTRACT,
  V2_TOP20_PROFILE,
  V2_TOP20_SCOPE
} = require("./collection_worker_v2_top20_contract.cjs");
const {
  V2_TOP20_PROVIDER_CALL_TRACE_SCHEMA_VERSION,
  computeV2Top20ProviderCallTraceHash,
  expectedV2Top20ProviderCallTrace
} = require("./collection_worker_v2_top20_artifact.cjs");
const {
  COLLECTION_WORKER_V2_TOP20_CLAIM_PATH,
  COLLECTION_WORKER_V2_TOP20_FAILURE_PATH,
  COLLECTION_WORKER_V2_TOP20_FINALIZE_PATH,
  COLLECTION_WORKER_V2_TOP20_HEARTBEAT_PATH,
  COLLECTION_WORKER_V2_TOP20_PREFLIGHT_PATH,
  COLLECTION_WORKER_V2_TOP20_TARGET_SERVICE_ID,
  COLLECTION_WORKER_V2_TOP20_WORKER_ID,
  COLLECTION_WORKER_V2_TOP20_WORKER_POOL_ID
} = require("./collection_worker_v2_top20_protocol.cjs");
const {
  createCollectionWorkerV2Top20Orchestrator
} = require("./collection_worker_v2_top20_orchestrator.cjs");
const {
  ENV,
  assertWorkerEnvironment,
  postSignedWorkerRequest,
  postReceiptWithOneInternalRecovery,
  resolveWorkerEnvironment,
  runCollectionWorkerV2Top20,
  safeFatalResult
} = require("./collection_worker_v2_top20_worker.cjs");

const NOW = new Date("2026-08-06T12:00:00.000Z");
const COMMIT = "e".repeat(40);
const OPERATOR_TOKEN = "fixture-top20-worker-operator-token-with-thirty-two-characters";

let unexpectedNetworkCalls = 0;
const originalFetch = global.fetch;
global.fetch = async () => {
  unexpectedNetworkCalls += 1;
  throw new Error("external network is disabled in top20 Worker fixtures");
};

function privateBase64(key) {
  return key.export({ format: "der", type: "pkcs8" }).toString("base64");
}

function publicBase64(key) {
  return key.export({ format: "der", type: "spki" }).toString("base64");
}

function keySet() {
  return {
    dispatch: crypto.generateKeyPairSync("ed25519"),
    request: crypto.generateKeyPairSync("ed25519"),
    artifact: crypto.generateKeyPairSync("ed25519")
  };
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

function workerEnvironment(keys, overrides = {}) {
  return {
    RENDER: "true",
    RENDER_SERVICE_ID: COLLECTION_WORKER_V2_TOP20_TARGET_SERVICE_ID,
    RENDER_GIT_COMMIT: COMMIT,
    [ENV.workerMode]: "v2_top20_once",
    [ENV.externalCalls]: "true",
    [ENV.resultWrites]: "true",
    [ENV.executionEnabled]: "true",
    [ENV.top20Enabled]: "true",
    [ENV.previewInternalBaseUrl]: "http://preview-internal:10000",
    [ENV.dispatchPublicKey]: publicBase64(keys.dispatch.publicKey),
    [ENV.artifactPrivateKey]: privateBase64(keys.artifact.privateKey),
    [ENV.requestPrivateKey]: privateBase64(keys.request.privateKey),
    ...overrides
  };
}

function response(body, status = 200) {
  const text = JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get(name) {
        const key = String(name).toLowerCase();
        if (key === "content-length") return String(Buffer.byteLength(text));
        if (key === "content-type") return "application/json; charset=utf-8";
        return null;
      }
    },
    async text() { return text; }
  };
}

function manifestFiles() {
  const targetResults = Array.from({ length: 20 }, (_, index) => ({
    companyOrdinal: index + 1,
    placeId: String(100000 + index),
    status: "zero",
    revenueInputValid: true,
    bookingBusiness: 1,
    bookingItems: 0,
    dailySchedule: 0
  }));
  const providerCallTrace = expectedV2Top20ProviderCallTrace(targetResults);
  const manifest = {
    collectorActivationProfile: V2_TOP20_PROFILE,
    collectorScope: V2_TOP20_SCOPE,
    collectionPurpose: "revenue_detail",
    collectionMode: "precision",
    productMode: "all",
    detailRankRanges: "1-20",
    bookingRangeDays: 1,
    automaticRetry: false,
    automaticFallback: false,
    saveRunOnSuccessOnly: true,
    saveFailureRun: false,
    revenueEstimateBasis: V2_TOP20_CONTRACT.revenueEstimateBasis,
    counts: { naverOverall: 50, naverBookingStockChecked: 20 },
    inventoryResultCounts: { planned: 20, ready: 0, zero: 20, missing: 0, partial: 0 },
    providerCallCounts: {
      mainPlace: 1,
      inventory: { bookingBusiness: 20, bookingItems: 0, dailySchedule: 0, total: 20 },
      total: providerCallTrace.length
    },
    providerCallTraceSchemaVersion: V2_TOP20_PROVIDER_CALL_TRACE_SCHEMA_VERSION,
    providerCallTrace,
    providerCallTraceHash: computeV2Top20ProviderCallTraceHash(providerCallTrace),
    providerMaxObservedConcurrency: 1,
    inventoryTargetResults: targetResults,
    fileRoles: {
      platform: "platform.csv",
      overall: "overall.csv",
      ads: "ads.csv",
      regional: "regional.csv",
      ddnayo: "ddnayo.csv"
    },
    files: ["platform.csv", "overall.csv", "ads.csv", "regional.csv", "ddnayo.csv"],
    detailJsonFiles: []
  };
  return [
    { path: "top20-summary.json", content: JSON.stringify({ schemaVersion: "collector-intermediate.v1" }) },
    { path: "run/manifest.json", content: JSON.stringify(manifest) },
    ...["platform", "overall", "ads", "regional", "ddnayo"].map((role) => ({
      path: `run/${role}.csv`,
      content: "rank,place_id\n"
    }))
  ];
}

async function createSystem(root, keys, options = {}) {
  await fsp.mkdir(root, { recursive: true });
  const jobStore = createCollectionJobStore({ runtimeRoot: root });
  const providerStore = createNaverProviderHealthStore({
    filePath: path.join(root, "provider", "naver.json"),
    runtimeRoot: root,
    now: () => NOW
  });
  let callbackCount = 0;
  const orchestrator = createCollectionWorkerV2Top20Orchestrator({
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
    now: () => NOW,
    async applyReadyTransaction(input) {
      callbackCount += 1;
      return { receiptId: input.receiptId, committed: true, writeCount: 1 };
    }
  });
  await orchestrator.prepare({ operatorToken: OPERATOR_TOKEN, contract: contract(options.keyword) });
  return { callbackCount: () => callbackCount, jobStore, orchestrator, providerStore };
}

function internalFetch(system, counters, behavior = {}) {
  return async (url, options) => {
    counters.internal += 1;
    const pathname = new URL(url).pathname;
    counters[pathname] = Number(counters[pathname] || 0) + 1;
    const payload = JSON.parse(String(options.body || "{}"));
    try {
      const result = pathname === COLLECTION_WORKER_V2_TOP20_CLAIM_PATH
        ? await system.orchestrator.claim(payload)
        : pathname === COLLECTION_WORKER_V2_TOP20_PREFLIGHT_PATH
          ? await system.orchestrator.preflight(payload)
          : pathname === COLLECTION_WORKER_V2_TOP20_HEARTBEAT_PATH
            ? await system.orchestrator.heartbeat(payload)
            : pathname === COLLECTION_WORKER_V2_TOP20_FINALIZE_PATH
              ? await system.orchestrator.finalize(payload)
              : pathname === COLLECTION_WORKER_V2_TOP20_FAILURE_PATH
                ? await system.orchestrator.recordFailure(payload)
                : (() => { throw Object.assign(new Error("unknown fixture path"), { code: "NOT_FOUND", statusCode: 404 }); })();
      if (
        behavior.loseFirstFinalizeResponse === true
        && pathname === COLLECTION_WORKER_V2_TOP20_FINALIZE_PATH
        && counters[pathname] === 1
      ) {
        throw Object.assign(new Error("synthetic response loss"), { responseLost: true });
      }
      if (
        behavior.loseFirstFailureResponse === true
        && pathname === COLLECTION_WORKER_V2_TOP20_FAILURE_PATH
        && counters[pathname] === 1
      ) {
        throw Object.assign(new Error("synthetic failure response loss"), { responseLost: true });
      }
      if (behavior.loseAllFailureResponses === true && pathname === COLLECTION_WORKER_V2_TOP20_FAILURE_PATH) {
        throw Object.assign(new Error("synthetic failure response loss"), { responseLost: true });
      }
      return response(result);
    } catch (error) {
      if (error?.responseLost) throw error;
      return response({ code: String(error?.code || "FIXTURE_INTERNAL_ERROR") }, Number(error?.statusCode || 500));
    }
  };
}

async function readyScenario(root, keys) {
  const keyword = "Synthetic top20 Worker ready lodging";
  const system = await createSystem(root, keys, { keyword });
  const counters = { internal: 0, collector: 0, provider: 0 };
  const controller = new AbortController();
  const environment = workerEnvironment(keys);
  const result = await runCollectionWorkerV2Top20({
    fixtureMode: true,
    environment,
    signal: controller.signal,
    internalFetchImpl: internalFetch(system, counters, { loseFirstFinalizeResponse: true }),
    now: NOW,
    runtimeFingerprint: FIXED_V2_WORKER_RUNTIME_FINGERPRINT,
    tempBase: root,
    async collectorExecutor(input) {
      counters.collector += 1;
      assert.equal(input.baseEnvironment, environment);
      assert.equal(input.signal, controller.signal);
      assert.equal(input.contract.keyword, keyword);
      assert.equal(input.contract.detailRankEnd, 20);
      assert.equal(typeof input.heartbeat, "function");
      assert.equal(typeof input.onProviderCall, "function");
      await Promise.all([input.heartbeat(), input.heartbeat()]);
      for (let requestOrdinal = 1; requestOrdinal <= 21; requestOrdinal += 1) {
        await input.onProviderCall({
          providerId: "naver_place_search",
          operation: requestOrdinal === 1 ? "main_place" : "booking_business",
          requestOrdinal
        });
        counters.provider += 1;
      }
      return { providerCallCount: 21, files: manifestFiles() };
    }
  });
  assert.equal(result.status, "ready");
  assert.equal(result.jobState, "committed");
  assert.equal(result.resultStored, true);
  assert.equal(result.executedCallCount, 21);
  assert.equal(result.writeCount, 1);
  assert.equal(result.replayed, true, "the second receipt submission must return the durable replay");
  assert.equal(counters.collector, 1, "receipt recovery must never repeat the collector");
  assert.equal(counters.provider, 21, "there is no automatic provider retry");
  assert.equal(counters[COLLECTION_WORKER_V2_TOP20_FINALIZE_PATH], 2, "internal receipt recovery is bounded to one retry");
  assert.equal(counters[COLLECTION_WORKER_V2_TOP20_HEARTBEAT_PATH], 22);
  assert.equal(system.callbackCount(), 1, "response loss must not repeat the Preview transaction");
  assert.equal((await system.jobStore.readSnapshot()).jobs[0].state, "committed");
  assert.equal((await system.providerStore.read()).state, "closed");
}

async function failureScenario(root, keys) {
  const keyword = "Synthetic top20 Worker blocked lodging";
  const system = await createSystem(root, keys, { keyword });
  const counters = { internal: 0, collector: 0, provider: 0 };
  await assert.rejects(
    () => runCollectionWorkerV2Top20({
      fixtureMode: true,
      environment: workerEnvironment(keys),
      internalFetchImpl: internalFetch(system, counters, { loseFirstFailureResponse: true }),
      now: NOW,
      runtimeFingerprint: FIXED_V2_WORKER_RUNTIME_FINGERPRINT,
      tempBase: root,
      async collectorExecutor(input) {
        counters.collector += 1;
        await input.heartbeat();
        for (let requestOrdinal = 1; requestOrdinal <= 4; requestOrdinal += 1) {
          await input.onProviderCall({
            providerId: "naver_place_search",
            operation: ["main_place", "booking_business", "booking_items", "daily_schedule"][requestOrdinal - 1],
            requestOrdinal
          });
          counters.provider += 1;
        }
        throw Object.assign(new Error("synthetic blocked response"), {
          code: "NAVER_ACCESS_BLOCKED",
          statusCode: 503,
          providerFailureSubtype: "challenge_html",
          diagnosticId: "crawl-abcdef123456",
          executedCallCount: 4
        });
      }
    }),
    (error) => error?.code === "NAVER_ACCESS_BLOCKED" && error.providerAttemptCount === 1
  );
  assert.equal(counters.collector, 1);
  assert.equal(counters.provider, 4, "failure receipt recovery must not repeat provider work");
  assert.equal(counters[COLLECTION_WORKER_V2_TOP20_FAILURE_PATH], 2, "failure receipt retry is bounded to one");
  assert.equal(counters[COLLECTION_WORKER_V2_TOP20_FINALIZE_PATH] || 0, 0);
  assert.equal(system.callbackCount(), 0, "failure receipt must not apply a result transaction");
  assert.equal((await system.jobStore.readSnapshot()).jobs[0].state, "failed");
  assert.equal((await system.providerStore.read()).state, "open");
}

async function artifactFailureScenario(root, keys) {
  const system = await createSystem(root, keys, { keyword: "Synthetic artifact failure lodging" });
  const counters = { internal: 0, collector: 0, provider: 0 };
  await assert.rejects(
    () => runCollectionWorkerV2Top20({
      fixtureMode: true,
      environment: workerEnvironment(keys),
      internalFetchImpl: internalFetch(system, counters, { loseFirstFailureResponse: true }),
      now: NOW,
      runtimeFingerprint: FIXED_V2_WORKER_RUNTIME_FINGERPRINT,
      tempBase: root,
      async collectorExecutor() {
        counters.collector += 1;
        return { providerCallCount: 0, files: [] };
      },
      async artifactFinalizer() {
        throw Object.assign(new Error("synthetic artifact policy rejection"), {
          code: "COLLECTION_ARTIFACT_SENSITIVE_CONTENT",
          statusCode: 403,
          safeMeta: Object.freeze({ detector: "url_literal", fileRole: "manifest", contentHashPrefix: "a".repeat(12), filePathHashPrefix: "b".repeat(12), contentLength: 24, stage: "bundle_build" })
        });
      }
    }),
    (error) => error?.code === "COLLECTION_ARTIFACT_SENSITIVE_CONTENT" && error.providerAttemptCount === 0 && error.executedCallCount === 0
  );
  assert.equal(counters.collector, 1);
  assert.equal(counters.provider, 0);
  assert.equal(counters[COLLECTION_WORKER_V2_TOP20_FAILURE_PATH], 2, "artifact failure receipt recovery is bounded to one retry");
  assert.equal((await system.jobStore.readSnapshot()).jobs[0].state, "failed");
  assert.equal((await system.providerStore.read()).state, "closed");
  assert.equal(system.orchestrator.status().activePayloadCount, 0);

  const indeterminate = await createSystem(path.join(root, "receipt-indeterminate"), keys, { keyword: "Synthetic receipt indeterminate lodging" });
  const indeterminateCounters = { internal: 0, collector: 0, provider: 0 };
  await assert.rejects(
    () => runCollectionWorkerV2Top20({
      fixtureMode: true,
      environment: workerEnvironment(keys),
      internalFetchImpl: internalFetch(indeterminate, indeterminateCounters, { loseAllFailureResponses: true }),
      now: NOW,
      runtimeFingerprint: FIXED_V2_WORKER_RUNTIME_FINGERPRINT,
      tempBase: root,
      async collectorExecutor() { return { providerCallCount: 0, files: [] }; },
      async artifactFinalizer() { throw Object.assign(new Error("synthetic artifact policy rejection"), { code: "COLLECTION_ARTIFACT_SENSITIVE_CONTENT", statusCode: 403 }); }
    }),
    (error) => error?.code === "COLLECTION_WORKER_V2_TOP20_RECEIPT_INDETERMINATE"
  );
  assert.equal(indeterminateCounters.provider, 0);
  assert.equal(indeterminateCounters[COLLECTION_WORKER_V2_TOP20_FAILURE_PATH], 2);
}

async function gateScenario(keys) {
  const valid = workerEnvironment(keys);
  assert.equal(assertWorkerEnvironment(valid).commit, COMMIT);
  assert.equal(resolveWorkerEnvironment({ environment: process.env }, false), process.env);
  assert.throws(
    () => resolveWorkerEnvironment({ environment: { ...process.env } }, false),
    (error) => error?.code === "COLLECTION_WORKER_V2_TOP20_FIXTURE_BOUNDARY_INVALID"
  );
  await assert.rejects(
    () => runCollectionWorkerV2Top20({ environment: { ...process.env } }),
    (error) => error?.code === "COLLECTION_WORKER_V2_TOP20_FIXTURE_BOUNDARY_INVALID"
  );
  await assert.rejects(
    () => runCollectionWorkerV2Top20({ signal: {} }),
    (error) => error?.code === "COLLECTION_WORKER_V2_TOP20_SIGNAL_INVALID"
  );
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(
    () => runCollectionWorkerV2Top20({ signal: aborted.signal }),
    (error) => error?.code === "COLLECTION_WORKER_V2_TOP20_ABORTED"
  );
  for (const [field, value] of [
    [ENV.workerMode, "disabled"],
    [ENV.externalCalls, "false"],
    [ENV.resultWrites, "false"],
    [ENV.executionEnabled, "false"],
    [ENV.top20Enabled, "false"],
    ["RENDER_GIT_COMMIT", "not-a-commit"]
  ]) {
    assert.throws(
      () => assertWorkerEnvironment({ ...valid, [field]: value }),
      (error) => error?.code === "COLLECTION_WORKER_V2_TOP20_RUNTIME_INVALID"
    );
  }
  assert.throws(
    () => assertWorkerEnvironment({ ...valid, RENDER_SERVICE_ID: "srv-wrong" }),
    (error) => error?.code === "COLLECTION_WORKER_V2_TOP20_RUNTIME_INVALID"
  );
  const fatal = safeFatalResult(Object.assign(new Error("secret detail"), { code: "UNSAFE lowercase" }));
  assert.equal(fatal.code, "COLLECTION_WORKER_V2_TOP20_EXECUTION_FAILED");
  assert.equal(JSON.stringify(fatal).includes("secret detail"), false);

  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (line) => warnings.push(String(line));
  try {
    await assert.rejects(
      () => postSignedWorkerRequest({
        baseUrl: "http://preview-internal:10000",
        body: {
          workerId: COLLECTION_WORKER_V2_TOP20_WORKER_ID,
          workerPoolId: COLLECTION_WORKER_V2_TOP20_WORKER_POOL_ID,
          workerCommit: COMMIT
        },
        fetchImpl: async () => {
          const text = "<html><body>synthetic internal page</body></html>";
          return {
            ok: false,
            status: 403,
            headers: {
              get(name) {
                if (String(name).toLowerCase() === "content-type") return "text/html; charset=utf-8";
                if (String(name).toLowerCase() === "content-length") return String(Buffer.byteLength(text));
                return null;
              }
            },
            async text() { return text; }
          };
        },
        now: () => NOW,
        path: COLLECTION_WORKER_V2_TOP20_CLAIM_PATH,
        requestPrivateKey: keys.request.privateKey
      }),
      (error) => error?.code === "COLLECTION_WORKER_PREVIEW_RESPONSE_NOT_JSON"
    );
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /collection-worker-preview-transport-failure/u);
  assert.match(warnings[0], /"statusCode":403/u);
  assert.match(warnings[0], /"contentType":"text\/html; charset=utf-8"/u);
  assert.match(warnings[0], /"bodyLogged":false/u);
  assert.equal(warnings[0].includes("synthetic internal page"), false, "internal response body must not be logged");

  let receiptAttempts = 0;
  await assert.rejects(
    () => postReceiptWithOneInternalRecovery({
      baseUrl: "http://preview-internal:10000",
      body: { fixture: true },
      fetchImpl: async () => {
        receiptAttempts += 1;
        throw new Error("synthetic internal transport loss");
      },
      now: () => NOW,
      path: COLLECTION_WORKER_V2_TOP20_FAILURE_PATH,
      requestPrivateKey: keys.request.privateKey
    }),
    (error) => error?.code === "COLLECTION_WORKER_V2_TOP20_RECEIPT_INDETERMINATE"
  );
  assert.equal(receiptAttempts, 2, "receipt hand-off must stop after one internal recovery attempt");
}

async function main() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "collection-worker-top20-client-"));
  const keys = keySet();
  try {
    await gateScenario(keys);
    await readyScenario(path.join(root, "ready"), keys);
    await failureScenario(path.join(root, "failure"), keys);
    await artifactFailureScenario(path.join(root, "artifact-failure"), keys);
    assert.equal(unexpectedNetworkCalls, 0, "top20 Worker fixtures must not call external networking");
    console.log("collection worker V2 top20 Worker fixtures passed");
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
