"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const {
  buildV2Top20CollectorEnvironment,
  executeV2Top20Collector,
  normalizeProviderCallMessage,
  runCollectorChild,
  selectV2Top20ChildBaseEnvironment
} = require("./collection_worker_v2_top20_collector.cjs");
const {
  SUMMARY_PATH,
  V2_TOP20_PROVIDER_CALL_TRACE_SCHEMA_VERSION,
  collectV2Top20ArtifactFiles,
  computeV2Top20ProviderCallTraceHash,
  expectedV2Top20ProviderCallTrace
} = require("./collection_worker_v2_top20_artifact.cjs");
const {
  V2_TOP20_CONTRACT,
  V2_TOP20_PROFILE,
  V2_TOP20_SCOPE
} = require("./collection_worker_v2_top20_contract.cjs");
const { installFixtureNetworkGuard } = require("./fixture_network_guard.cjs");

const ROOT = path.resolve(__dirname, "..");
const PRELOAD = path.join(__dirname, "naver_legacy_inventory_fixture_preload.cjs");
const NETWORK_GUARD_PRELOAD = path.join(__dirname, "fixture_network_guard_preload.cjs");
const guard = installFixtureNetworkGuard({ label: "V2 top20 Worker collector fixtures" });

function contract() {
  return {
    keyword: "Synthetic regional lodging",
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

function baseEnvironment(root, auditFile, mode) {
  return {
    ...process.env,
    NODE_OPTIONS: [
      process.env.NODE_OPTIONS,
      `--require=${NETWORK_GUARD_PRELOAD.replace(/\\/gu, "/")}`,
      `--require=${PRELOAD.replace(/\\/gu, "/")}`
    ].filter(Boolean).join(" "),
    NODE_ENV: "test",
    NAVER_INVENTORY_FIXTURE_ROOT: root,
    NAVER_INVENTORY_FIXTURE_MODE: mode,
    NAVER_INVENTORY_FIXTURE_AUDIT_FILE: auditFile,
    SEARCH_INTENT: "",
    SEARCH_INTENT_CONFIDENCE: "0"
  };
}

async function readAudit(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function verifyRealDetailManifestShape(root) {
  const outputDir = path.join(root, "real-detail-output");
  await fs.mkdir(path.join(outputDir, "raw-details"), { recursive: true });
  const targets = Array.from({ length: 20 }, (_, index) => ({
    companyOrdinal: index + 1,
    placeId: String(910000 + index),
    status: "zero",
    revenueInputValid: true,
    bookingBusiness: 1,
    bookingItems: 0,
    dailySchedule: 0
  }));
  const trace = expectedV2Top20ProviderCallTrace(targets);
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
      total: trace.length
    },
    providerCallTraceSchemaVersion: V2_TOP20_PROVIDER_CALL_TRACE_SCHEMA_VERSION,
    providerCallTrace: trace,
    providerCallTraceHash: computeV2Top20ProviderCallTraceHash(trace),
    providerMaxObservedConcurrency: 1,
    inventoryTargetResults: targets,
    fileRoles: {
      platform: "platform.csv",
      overall: "overall.csv",
      ads: "ads.csv",
      regional: "regional.csv",
      ddnayo: "ddnayo.csv"
    },
    files: ["platform.csv", "overall.csv", "ads.csv", "regional.csv", "ddnayo.csv", "raw-details/one.json"],
    detailJsonFiles: [{
      field: "productDetails",
      name: "Synthetic detail",
      placeId: "910000",
      bookingBusinessId: "920000",
      file: "raw-details/one.json",
      itemCount: 1,
      originalLength: 32
    }]
  };
  await Promise.all([
    fs.writeFile(path.join(outputDir, "manifest.json"), JSON.stringify(manifest), "utf8"),
    ...Object.values(manifest.fileRoles).map((file) => fs.writeFile(path.join(outputDir, file), "rank,place_id\n", "utf8")),
    fs.writeFile(path.join(outputDir, "raw-details", "one.json"), JSON.stringify({ fixture: true }), "utf8")
  ]);
  const collected = await collectV2Top20ArtifactFiles({
    tempRoot: root,
    outputDir,
    contractHash: "9".repeat(64),
    executionIdentityHash: "a".repeat(64)
  });
  assert.deepEqual(collected.manifest.detailJsonFiles, ["details/detail-01.json"]);
  assert.equal(collected.files.some((file) => file.path.includes("[object Object]")), false);
  assert.equal(collected.files.some((file) => file.path === "run/details/detail-01.json"), true);
}

(async () => {
  const roots = [];
  try {
    const sanitizedBase = selectV2Top20ChildBaseEnvironment({
      PATH: "synthetic-path",
      NODE_ENV: "production",
      COLLECTION_WORKER_ARTIFACT_PRIVATE_KEY_B64: "must-not-reach-child",
      COLLECTION_WORKER_REQUEST_PRIVATE_KEY_B64: "must-not-reach-child"
    });
    assert.equal(sanitizedBase.PATH, "synthetic-path");
    assert.equal(Object.hasOwn(sanitizedBase, "COLLECTION_WORKER_ARTIFACT_PRIVATE_KEY_B64"), false);
    assert.equal(Object.hasOwn(sanitizedBase, "COLLECTION_WORKER_REQUEST_PRIVATE_KEY_B64"), false);
    const sanitizedCollectorEnvironment = buildV2Top20CollectorEnvironment({
      contract: contract(),
      outputRoot: path.join(os.tmpdir(), "v2-top20-sanitized-environment"),
      runStamp: "20260806_000000_abcdef12",
      baseEnvironment: {
        PATH: "synthetic-path",
        COLLECTION_WORKER_DISPATCH_PRIVATE_KEY_B64: "must-not-reach-child"
      }
    });
    assert.equal(sanitizedCollectorEnvironment.PATH, "synthetic-path");
    assert.equal(Object.hasOwn(sanitizedCollectorEnvironment, "COLLECTION_WORKER_DISPATCH_PRIVATE_KEY_B64"), false);
    const preAborted = new AbortController();
    preAborted.abort();
    let preAbortedSpawnCount = 0;
    await assert.rejects(
      () => runCollectorChild({
        signal: preAborted.signal,
        spawnImpl() {
          preAbortedSpawnCount += 1;
          throw new Error("spawn must not run after abort");
        }
      }),
      { code: "V2_TOP20_COLLECTION_ABORTED" }
    );
    assert.equal(preAbortedSpawnCount, 0, "an already-aborted signal must prevent child start");
    assert.deepEqual(normalizeProviderCallMessage({
      type: "v2_top20_provider_call_heartbeat_request.v1",
      requestId: "provider-call-123-1-abcdef12",
      providerId: "naver_place_search",
      operation: "main_place",
      requestOrdinal: 1,
      companyOrdinal: null,
      productOrdinal: null
    }, 1), {
      requestId: "provider-call-123-1-abcdef12",
      providerId: "naver_place_search",
      operation: "main_place",
      requestOrdinal: 1,
      companyOrdinal: null,
      productOrdinal: null
    });
    assert.throws(
      () => normalizeProviderCallMessage({
        type: "v2_top20_provider_call_heartbeat_request.v1",
        requestId: "provider-call-123-1-abcdef12",
        providerId: "naver_place_search",
        operation: "main_place",
        requestOrdinal: 1,
        companyOrdinal: null,
        productOrdinal: null,
        query: "forbidden"
      }, 1),
      (error) => error?.code === "V2_TOP20_PROVIDER_CALL_IPC_INVALID",
      "IPC messages containing a query must fail closed"
    );
    const successRoot = await fs.mkdtemp(path.join(os.tmpdir(), "v2-top20-worker-success-"));
    roots.push(successRoot);
    await verifyRealDetailManifestShape(successRoot);
    const successAudit = path.join(successRoot, "audit-success.json");
    let heartbeats = 0;
    const successProviderCalls = [];
    const success = await executeV2Top20Collector({
      contract: contract(),
      contractHash: "a".repeat(64),
      executionIdentityHash: "b".repeat(64),
      tempBase: successRoot,
      cwd: ROOT,
      baseEnvironment: baseEnvironment(successRoot, successAudit, "success"),
      heartbeat: async () => { heartbeats += 1; },
      onProviderCall: async (metadata) => {
        assert.deepEqual(Object.keys(metadata).sort(), [
          "companyOrdinal",
          "operation",
          "productOrdinal",
          "providerId",
          "requestOrdinal"
        ]);
        assert.equal(metadata.providerId, "naver_place_search");
        assert.equal(JSON.stringify(metadata).includes("Synthetic regional lodging"), false);
        assert.equal(/https?:|query|body|placeId|businessId/iu.test(JSON.stringify(metadata)), false);
        successProviderCalls.push(metadata);
      },
      heartbeatIntervalMs: 1_000,
      maxRuntimeMs: 120_000
    });
    assert.equal(success.providerCallCount, 81);
    assert.equal(success.readyCount, 20);
    assert.equal(success.zeroCount, 0);
    assert.equal(successProviderCalls.length, 81);
    assert.deepEqual(successProviderCalls.map((item) => item.requestOrdinal), Array.from({ length: 81 }, (_, index) => index + 1));
    assert.equal(successProviderCalls[0].operation, "main_place");
    assert.equal(successProviderCalls[0].companyOrdinal, null);
    assert.equal(successProviderCalls[1].companyOrdinal, 1);
    assert.equal(successProviderCalls[3].productOrdinal, 1);
    assert.equal(successProviderCalls.at(-1).operation, "daily_schedule");
    assert.ok(heartbeats >= 2);
    assert.ok(success.files.some((file) => file.path === SUMMARY_PATH));
    assert.ok(success.files.some((file) => file.path === "run/overall.csv"));
    assert.equal(success.files.some((file) => /https?:\/\//iu.test(String(file.content))), false);
    const audit = await readAudit(successAudit);
    assert.deepEqual(audit.operationCounts, {
      main_place: 1,
      booking_business: 20,
      booking_items: 20,
      daily_schedule: 40
    });
    assert.equal(audit.callCount, 81);
    assert.equal(audit.maxConcurrentCalls, 1);
    assert.equal((await fs.readdir(successRoot)).some((name) => name.startsWith("v2-top20-")), false);

    const zeroRoot = await fs.mkdtemp(path.join(os.tmpdir(), "v2-top20-worker-zero-"));
    roots.push(zeroRoot);
    const zeroAudit = path.join(zeroRoot, "audit-zero.json");
    const zeroProviderCalls = [];
    const zero = await executeV2Top20Collector({
      contract: contract(),
      contractHash: "c".repeat(64),
      executionIdentityHash: "d".repeat(64),
      tempBase: zeroRoot,
      cwd: ROOT,
      baseEnvironment: baseEnvironment(zeroRoot, zeroAudit, "zero_two"),
      heartbeat: async () => {},
      onProviderCall: async (metadata) => { zeroProviderCalls.push(metadata); },
      maxRuntimeMs: 120_000
    });
    assert.equal(zero.readyCount, 19);
    assert.equal(zero.zeroCount, 1);
    assert.equal(zero.providerCallCount, 78);
    assert.equal(zeroProviderCalls.length, 78);
    assert.deepEqual((await readAudit(zeroAudit)).operationCounts, {
      main_place: 1,
      booking_business: 20,
      booking_items: 19,
      daily_schedule: 38
    });
    assert.equal((await readAudit(zeroAudit)).callCount, 78);

    const blockedRoot = await fs.mkdtemp(path.join(os.tmpdir(), "v2-top20-worker-blocked-"));
    roots.push(blockedRoot);
    const blockedAudit = path.join(blockedRoot, "audit-blocked.json");
    const blockedProviderCalls = [];
    await assert.rejects(
      () => executeV2Top20Collector({
        contract: contract(),
        contractHash: "e".repeat(64),
        executionIdentityHash: "f".repeat(64),
        tempBase: blockedRoot,
        cwd: ROOT,
        baseEnvironment: baseEnvironment(blockedRoot, blockedAudit, "challenge_daily_schedule"),
        heartbeat: async () => {},
        onProviderCall: async (metadata) => { blockedProviderCalls.push(metadata); },
        maxRuntimeMs: 120_000
      }),
      (error) => error?.code === "NAVER_ACCESS_BLOCKED"
    );
    const blocked = await readAudit(blockedAudit);
    assert.equal(blocked.callCount, 4, "the first blocked schedule must stop every later rank");
    assert.equal(blockedProviderCalls.length, 4, "the blocked response still counts as one executed provider call");
    assert.equal((await fs.readdir(blockedRoot)).some((name) => name.startsWith("v2-top20-")), false);

    const abortedRoot = await fs.mkdtemp(path.join(os.tmpdir(), "v2-top20-worker-aborted-"));
    roots.push(abortedRoot);
    const abortedAudit = path.join(abortedRoot, "audit-aborted.json");
    const abortController = new AbortController();
    let abortedProviderCalls = 0;
    await assert.rejects(
      () => executeV2Top20Collector({
        contract: contract(),
        contractHash: "7".repeat(64),
        executionIdentityHash: "8".repeat(64),
        tempBase: abortedRoot,
        cwd: ROOT,
        baseEnvironment: baseEnvironment(abortedRoot, abortedAudit, "success"),
        heartbeat: async () => {},
        onProviderCall: async () => {
          abortedProviderCalls += 1;
          abortController.abort();
        },
        signal: abortController.signal,
        maxRuntimeMs: 120_000
      }),
      (error) => error?.code === "V2_TOP20_COLLECTION_ABORTED"
    );
    assert.equal(abortedProviderCalls, 1, "shutdown must stop after the in-flight provider call starts");
    assert.equal(
      (await fs.readdir(abortedRoot)).some((name) => name.startsWith("v2-top20-")),
      false,
      "shutdown must clean the Worker temp root"
    );

    const providerHeartbeatRoot = await fs.mkdtemp(path.join(os.tmpdir(), "v2-top20-worker-provider-heartbeat-"));
    roots.push(providerHeartbeatRoot);
    const providerHeartbeatAudit = path.join(providerHeartbeatRoot, "audit-provider-heartbeat.json");
    let failedProviderHeartbeatCount = 0;
    await assert.rejects(
      () => executeV2Top20Collector({
        contract: contract(),
        contractHash: "1".repeat(64),
        executionIdentityHash: "2".repeat(64),
        tempBase: providerHeartbeatRoot,
        cwd: ROOT,
        baseEnvironment: baseEnvironment(providerHeartbeatRoot, providerHeartbeatAudit, "success"),
        heartbeat: async () => {},
        onProviderCall: async () => {
          failedProviderHeartbeatCount += 1;
          throw new Error("synthetic parent heartbeat failure");
        },
        maxRuntimeMs: 120_000
      }),
      (error) => error?.code === "V2_TOP20_PROVIDER_CALL_HEARTBEAT_FAILED"
    );
    assert.equal(failedProviderHeartbeatCount, 1);
    assert.equal(
      (await readAudit(providerHeartbeatAudit)).callCount,
      1,
      "a started-call ACK failure occurs only after the first provider fetch has started"
    );
    assert.equal(
      (await fs.readdir(providerHeartbeatRoot)).some((name) => name.startsWith("v2-top20-")),
      false,
      "provider heartbeat failure must clean the Worker temp root"
    );

    const initialHeartbeatRoot = await fs.mkdtemp(path.join(os.tmpdir(), "v2-top20-worker-initial-heartbeat-"));
    roots.push(initialHeartbeatRoot);
    const initialHeartbeatFailure = Object.assign(new Error("synthetic initial heartbeat failure"), {
      code: "SYNTHETIC_INITIAL_HEARTBEAT_FAILED"
    });
    let initialProviderCalls = 0;
    await assert.rejects(
      () => executeV2Top20Collector({
        contract: contract(),
        contractHash: "3".repeat(64),
        executionIdentityHash: "4".repeat(64),
        tempBase: initialHeartbeatRoot,
        heartbeat: async () => { throw initialHeartbeatFailure; },
        onProviderCall: async () => { initialProviderCalls += 1; }
      }),
      (error) => error === initialHeartbeatFailure
    );
    assert.equal(initialProviderCalls, 0);
    assert.equal(
      (await fs.readdir(initialHeartbeatRoot)).some((name) => name.startsWith("v2-top20-")),
      false,
      "initial heartbeat failure must clean the Worker temp root"
    );

    await assert.rejects(
      () => executeV2Top20Collector({
        contract: contract(),
        contractHash: "5".repeat(64),
        executionIdentityHash: "6".repeat(64),
        tempBase: "",
        heartbeat: async () => {},
        onProviderCall: async () => {}
      }),
      (error) => error?.code === "V2_TOP20_RUNTIME_PATH_INVALID"
    );
    assert.equal(guard.blockedAttempts(), 0);
    console.log("collection worker V2 top20 collector fixtures passed");
  } finally {
    await Promise.all(roots.map((root) => fs.rm(root, { recursive: true, force: true })));
    guard.restore();
  }
})().catch((error) => {
  guard.restore();
  console.error(error);
  process.exitCode = 1;
});
