"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const {
  classifyCollectorProcessFailure,
  createCrawlFailure
} = require("./crawl_failure_contract.cjs");
const {
  collectV2Top20ArtifactFiles,
  computeV2Top20ProviderCallTraceHash,
  normalizeV2Top20ProviderCallTrace
} = require("./collection_worker_v2_top20_artifact.cjs");
const {
  V2_TOP20_CONTRACT,
  V2_TOP20_PROFILE,
  V2_TOP20_SCOPE
} = require("./collection_worker_v2_top20_contract.cjs");
const {
  V2_TOP20_RESILIENCE_MAXIMUM_PROVIDER_CALLS,
  V2_TOP20_RESILIENCE_OPERATION_BUDGETS,
  providerIdForOperation
} = require("./collection_worker_v2_top20_resilience.cjs");
const {
  normalizeV2Top20PrepareContract
} = require("./collection_worker_v2_top20_protocol.cjs");

const V2_TOP20_COLLECTOR_SCHEMA_VERSION = "collection-worker-v2-top20-collector.v1";
const DEFAULT_MAX_RUNTIME_MS = 2 * 60 * 60 * 1000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 60 * 1000;
const V2_TOP20_PROVIDER_CALL_REQUEST_TYPE = "v2_top20_provider_call_heartbeat_request.v1";
const V2_TOP20_PROVIDER_CALL_ACK_TYPE = "v2_top20_provider_call_heartbeat_ack.v1";
const V2_TOP20_PROVIDER_CALL_STARTED_REQUEST_TYPE = "v2_top20_provider_call_started_request.v1";
const V2_TOP20_PROVIDER_CALL_STARTED_ACK_TYPE = "v2_top20_provider_call_started_ack.v1";
const V2_TOP20_SAFE_PROVIDER_OPERATIONS = new Set([
  "main_place",
  "booking_business",
  "booking_business_graphql",
  "booking_business_place_page",
  "booking_items",
  "daily_schedule"
]);
const PROVIDER_CALL_REQUEST_ID_PATTERN = /^provider-call-\d{1,12}-\d{1,3}-[a-f0-9]{8}$/u;

class CollectionWorkerV2Top20CollectorError extends Error {
  constructor(code, message, statusCode = 500) {
    super(message);
    this.name = "CollectionWorkerV2Top20CollectorError";
    this.code = code;
    this.statusCode = statusCode;
    this.retryable = false;
  }
}

function collectorError(code, message, statusCode = 500) {
  return new CollectionWorkerV2Top20CollectorError(code, message, statusCode);
}

function safeRunStamp(value) {
  const text = String(value || "");
  if (!/^\d{8}_\d{6}_[a-f0-9]{8}$/u.test(text)) {
    throw collectorError("V2_TOP20_RUN_STAMP_INVALID", "top20 Worker run stamp is invalid", 400);
  }
  return text;
}

const SAFE_CHILD_ENVIRONMENT_KEYS = Object.freeze([
  "PATH",
  "Path",
  "SystemRoot",
  "ComSpec",
  "PATHEXT",
  "WINDIR",
  "TEMP",
  "TMP",
  "TMPDIR",
  "NODE_ENV",
  "TZ",
  "LANG",
  "LC_ALL"
]);

const FIXTURE_CHILD_ENVIRONMENT_KEYS = Object.freeze([
  "NODE_OPTIONS",
  "NAVER_INVENTORY_FIXTURE_ROOT",
  "NAVER_INVENTORY_FIXTURE_MODE",
  "NAVER_INVENTORY_FIXTURE_AUDIT_FILE",
  "SEARCH_INTENT",
  "SEARCH_INTENT_CONFIDENCE"
]);

function selectV2Top20ChildBaseEnvironment(value = {}) {
  const source = value && typeof value === "object" ? value : {};
  const keys = source.NODE_ENV === "test"
    ? [...SAFE_CHILD_ENVIRONMENT_KEYS, ...FIXTURE_CHILD_ENVIRONMENT_KEYS]
    : SAFE_CHILD_ENVIRONMENT_KEYS;
  const selected = {};
  for (const key of keys) {
    if (typeof source[key] === "string") selected[key] = source[key];
  }
  return selected;
}

function buildV2Top20CollectorEnvironment(input = {}) {
  const contract = normalizeV2Top20PrepareContract(input.contract || {});
  const outputRoot = path.resolve(String(input.outputRoot || ""));
  if (!path.isAbsolute(outputRoot)) {
    throw collectorError("V2_TOP20_RUNTIME_PATH_INVALID", "top20 Worker output root must be absolute", 400);
  }
  const runStamp = safeRunStamp(input.runStamp);
  return Object.freeze({
    ...selectV2Top20ChildBaseEnvironment(input.baseEnvironment),
    CHECK_IN: contract.checkIn,
    CHECK_OUT: contract.checkOut,
    ADULTS: "2",
    SEARCH_MODE: "keyword",
    SEARCH_MODE_REQUESTED: "keyword",
    COLLECTION_MODE: "precision",
    COLLECTION_PURPOSE: "revenue_detail",
    DETAIL_RANK_RANGES: "1-20",
    PRODUCT_MODE: "all",
    BOOKING_RANGE_DAYS: "1",
    BOOKING_RANGE_PLACE_LIMIT: "20",
    SOURCE_ROLE: "admin",
    COLLECTION_SOURCE: "admin_search",
    COLLECTION_SOURCE_LABEL: "관리자 수집",
    NAVER_LEGACY_LIMITED_ACTIVATION: "1",
    NAVER_LEGACY_INVENTORY_ACTIVATION: "1",
    V2_COLLECTOR_COMPATIBILITY_ACTIVATION: "0",
    V2_TOP20_WORKER_ACTIVATION: "1",
    NAVER_COLLECTOR_STRATEGY: "legacy_candidate",
    NAVER_COLLECTOR_SCOPE: V2_TOP20_SCOPE,
    NAVER_LIMITED_ACTIVATION_PROFILE: V2_TOP20_PROFILE,
    NAVER_PROVIDER_CALL_BUDGET: "1",
    NAVER_INVENTORY_CALL_BUDGET: String(V2_TOP20_RESILIENCE_MAXIMUM_PROVIDER_CALLS - 1),
    NAVER_TOTAL_CALL_BUDGET: String(V2_TOP20_RESILIENCE_MAXIMUM_PROVIDER_CALLS),
    NAVER_INVENTORY_PLACE_LIMIT: "20",
    NAVER_INVENTORY_ITEM_LIMIT: "8",
    NAVER_BOOKING_STOCK_LIMIT: "20",
    NAVER_BOOKING_DETAIL_CONCURRENCY: "1",
    NAVER_SCHEDULE_CONCURRENCY: "1",
    NAVER_SCHEDULE_DELAY_MS: "0",
    // Two public pages are an explicit, bounded legacy identity resolution
    // operation; they are not a retry and remain disabled for unapproved runs.
    NAVER_BOOKING_ID_FALLBACK: input.baseEnvironment?.NODE_ENV === "test" ? "0" : "1",
    NAVER_COUPON_PAGE_FALLBACK: "0",
    NAVER_AUTOMATIC_RETRY: "0",
    NAVER_AUTOMATIC_FALLBACK: "0",
    REQUESTED_COLLECTION_MODE: "precision",
    REQUESTED_COLLECTION_PURPOSE: "revenue_detail",
    RUN_STAMP: runStamp,
    DATA_DIR: outputRoot,
    OUTPUTS_DIR: outputRoot,
    CONFIG_DIR: path.join(outputRoot, "config"),
    NAVER_HISTORICAL_BOOKING_HINTS: JSON.stringify(Array.isArray(input.historicalBookingHints) ? input.historicalBookingHints : []),
    NAVER_DETAIL_LIVE_CALLS_ALLOWED: input.detailLiveCallsAllowed === false ? "0" : "1"
  });
}

function buildV2Top20MainPlaceProbeEnvironment(input = {}) {
  normalizeV2Top20PrepareContract(input.contract || {});
  return Object.freeze({
    ...buildV2Top20CollectorEnvironment({
      ...input,
      contract: input.contract,
      outputRoot: path.resolve(String(input.outputRoot || path.join(os.tmpdir(), "v2-top20-probe-unused"))),
      runStamp: input.runStamp || "20260818_000000_deadbeef"
    }),
    // The crawler exits immediately after a single main-place response. No
    // booking, detail, output, or result-persistence code is reachable.
    COLLECTION_MODE: "fast",
    COLLECTION_PURPOSE: "basic_db",
    DETAIL_RANK_RANGES: "",
    NAVER_LEGACY_INVENTORY_ACTIVATION: "0",
    NAVER_INVENTORY_CALL_BUDGET: "0",
    NAVER_TOTAL_CALL_BUDGET: "1",
    NAVER_MAIN_PLACE_RECOVERY_PROBE: "1"
  });
}

function parseMainPlaceProbeResult(stdout) {
  const marker = "MAIN_PLACE_RECOVERY_PROBE_RESULT=";
  const lines = String(stdout || "").split(/\r?\n/u).filter((line) => line.startsWith(marker));
  if (lines.length !== 1) {
    throw collectorError("V2_TOP20_MAIN_PLACE_PROBE_RESULT_INVALID", "main-place recovery probe result is invalid", 502);
  }
  let result;
  try { result = JSON.parse(lines[0].slice(marker.length)); } catch {
    throw collectorError("V2_TOP20_MAIN_PLACE_PROBE_RESULT_INVALID", "main-place recovery probe result is invalid", 502);
  }
  const keys = Object.keys(result || {}).sort();
  const expected = ["adCount", "observedRankCount", "organicCount", "providerSubtype", "schemaVersion"];
  if (
    keys.length !== expected.length || !keys.every((key, index) => key === expected[index])
    || result.schemaVersion !== "main-place-recovery-probe-result.v1"
    || result.providerSubtype !== "apollo_success"
    || !Number.isInteger(result.organicCount) || result.organicCount < 0 || result.organicCount > 50
    || !Number.isInteger(result.observedRankCount) || result.observedRankCount < 0 || result.observedRankCount > 50
    || !Number.isInteger(result.adCount) || result.adCount < 0 || result.adCount > 50
  ) {
    throw collectorError("V2_TOP20_MAIN_PLACE_PROBE_RESULT_INVALID", "main-place recovery probe result is invalid", 502);
  }
  return Object.freeze({ ...result });
}

function normalizeProviderCallMessage(message, expectedRequestOrdinal, expectedType = V2_TOP20_PROVIDER_CALL_REQUEST_TYPE) {
  const expectedKeys = [
    "companyOrdinal",
    "operation",
    "productOrdinal",
    "providerId",
    "requestId",
    "requestOrdinal",
    "type"
  ].sort();
  const actualKeys = message && typeof message === "object" && !Array.isArray(message)
    ? Object.keys(message).sort()
    : [];
  const requestOrdinal = Number(message?.requestOrdinal);
  if (
    actualKeys.length !== expectedKeys.length
    || !actualKeys.every((key, index) => key === expectedKeys[index])
    || message.type !== expectedType
    || !PROVIDER_CALL_REQUEST_ID_PATTERN.test(String(message.requestId || ""))
    || ![providerIdForOperation(String(message.operation || "")), "naver_place_search"].includes(message.providerId)
    || !V2_TOP20_SAFE_PROVIDER_OPERATIONS.has(String(message.operation || ""))
    || !Number.isInteger(requestOrdinal)
    || requestOrdinal !== expectedRequestOrdinal
    || requestOrdinal < 1
    || requestOrdinal > V2_TOP20_RESILIENCE_MAXIMUM_PROVIDER_CALLS
  ) {
    throw collectorError("V2_TOP20_PROVIDER_CALL_IPC_INVALID", "top20 provider call IPC request is invalid", 409);
  }
  const operation = String(message.operation);
  const companyOrdinal = message.companyOrdinal === null ? null : Number(message.companyOrdinal);
  const productOrdinal = message.productOrdinal === null ? null : Number(message.productOrdinal);
  const ordinalShapeValid = operation === "main_place"
    ? companyOrdinal === null && productOrdinal === null
    : ["booking_business", "booking_business_graphql", "booking_business_place_page", "booking_items"].includes(operation)
      ? Number.isInteger(companyOrdinal)
        && companyOrdinal >= 1
        && companyOrdinal <= V2_TOP20_CONTRACT.maxInventoryCompanies
        && productOrdinal === null
      : Number.isInteger(companyOrdinal)
        && companyOrdinal >= 1
        && companyOrdinal <= V2_TOP20_CONTRACT.maxInventoryCompanies
        && Number.isInteger(productOrdinal)
        && productOrdinal >= 1
        && productOrdinal <= V2_TOP20_CONTRACT.maxProductsPerCompany;
  if (!ordinalShapeValid) {
    throw collectorError("V2_TOP20_PROVIDER_CALL_IPC_INVALID", "top20 provider call IPC ordinals are invalid", 409);
  }
  return Object.freeze({
    requestId: String(message.requestId),
    providerId: message.providerId === "naver_place_search" ? "naver_place_search" : providerIdForOperation(operation),
    operation,
    requestOrdinal,
    companyOrdinal,
    productOrdinal
  });
}

function sameProviderCall(left, right) {
  return Boolean(left && right)
    && left.requestId === right.requestId
    && left.providerId === right.providerId
    && left.operation === right.operation
    && left.requestOrdinal === right.requestOrdinal
    && left.companyOrdinal === right.companyOrdinal
    && left.productOrdinal === right.productOrdinal;
}

function runCollectorChild(input = {}) {
  const spawnImpl = input.spawnImpl || spawn;
  const providerCallHook = typeof input.onProviderCall === "function" ? input.onProviderCall : null;
  const providerAuthorizeHook = typeof input.authorizeProviderCall === "function"
    ? input.authorizeProviderCall
    : null;
  const maxRuntimeMs = Number.isInteger(input.maxRuntimeMs) && input.maxRuntimeMs > 0
    ? Math.min(input.maxRuntimeMs, DEFAULT_MAX_RUNTIME_MS)
    : DEFAULT_MAX_RUNTIME_MS;
  return new Promise((resolve, reject) => {
    let child = null;
    const onAbort = () => child?.kill?.("SIGTERM");
    if (input.signal?.aborted) {
      reject(Object.assign(new Error("top20 Worker collection was aborted before child start"), {
        code: "V2_TOP20_COLLECTION_ABORTED",
        statusCode: 499,
        retryable: false
      }));
      return;
    }
    input.signal?.addEventListener?.("abort", onAbort, { once: true });
    const spawnOptions = {
      cwd: input.cwd,
      env: input.environment,
      windowsHide: true
    };
    if (providerCallHook) spawnOptions.stdio = ["ignore", "pipe", "pipe", "ipc"];
    try {
      child = spawnImpl(process.execPath, [input.scriptPath, input.keyword], spawnOptions);
    } catch (error) {
      input.signal?.removeEventListener?.("abort", onAbort);
      reject(classifyCollectorProcessFailure({ spawnError: error }));
      return;
    }
    if (input.signal?.aborted) onAbort();
    let stdout = "";
    let stderr = "";
    let settled = false;
    let executedCallCount = 0;
    let providerHeartbeatFailure = null;
    let providerMessageChain = Promise.resolve();
    let authorizedRequest = null;
    const providerCallTrace = [];

    function sendProviderCallAck(request, ok, ackType) {
      if (typeof child.send !== "function" || child.connected === false) return;
      const ack = {
        type: ackType,
        requestId: request?.requestId || "provider-call-0-0-00000000",
        requestOrdinal: Number(request?.requestOrdinal || 0),
        ok: ok === true,
        executedCallCount
      };
      if (!ok) ack.code = "V2_TOP20_PROVIDER_CALL_HEARTBEAT_FAILED";
      try {
        child.send(ack, (error) => {
          if (error && !providerHeartbeatFailure) {
            providerHeartbeatFailure = collectorError(
              "V2_TOP20_PROVIDER_CALL_HEARTBEAT_FAILED",
              "top20 provider call heartbeat ACK failed",
              503
            );
            child.kill?.("SIGTERM");
          }
        });
      } catch {
        if (!providerHeartbeatFailure) {
          providerHeartbeatFailure = collectorError(
            "V2_TOP20_PROVIDER_CALL_HEARTBEAT_FAILED",
            "top20 provider call heartbeat ACK failed",
            503
          );
        }
        child.kill?.("SIGTERM");
      }
    }

    async function handleProviderCallMessage(message) {
      let request = null;
      try {
        const isAuthorize = message?.type === V2_TOP20_PROVIDER_CALL_REQUEST_TYPE;
        const isStarted = message?.type === V2_TOP20_PROVIDER_CALL_STARTED_REQUEST_TYPE;
        if (!isAuthorize && !isStarted) {
          throw collectorError("V2_TOP20_PROVIDER_CALL_IPC_INVALID", "top20 provider call IPC phase is invalid", 409);
        }
        request = normalizeProviderCallMessage(message, executedCallCount + 1, message.type);
        const safeMetadata = Object.freeze({
          providerId: request.providerId,
          operation: request.operation,
          requestOrdinal: request.requestOrdinal,
          companyOrdinal: request.companyOrdinal,
          productOrdinal: request.productOrdinal
        });
        if (isAuthorize) {
          if (authorizedRequest) {
            throw collectorError("V2_TOP20_PROVIDER_CALL_IPC_INVALID", "top20 provider call is already authorized", 409);
          }
          await providerAuthorizeHook(safeMetadata);
          authorizedRequest = request;
          sendProviderCallAck(request, true, V2_TOP20_PROVIDER_CALL_ACK_TYPE);
          return;
        }
        if (!sameProviderCall(authorizedRequest, request)) {
          throw collectorError("V2_TOP20_PROVIDER_CALL_IPC_INVALID", "top20 started call does not match its authorization", 409);
        }
        await providerCallHook(safeMetadata);
        executedCallCount = request.requestOrdinal;
        providerCallTrace.push(Object.freeze({
          requestOrdinal: request.requestOrdinal,
          operation: request.operation,
          companyOrdinal: request.companyOrdinal,
          productOrdinal: request.productOrdinal
        }));
        authorizedRequest = null;
        sendProviderCallAck(request, true, V2_TOP20_PROVIDER_CALL_STARTED_ACK_TYPE);
      } catch (error) {
        if (!providerHeartbeatFailure) {
          const cancelled = error?.code === "COLLECTION_WORKER_V2_TOP20_CANCEL_REQUESTED";
          providerHeartbeatFailure = collectorError(
            cancelled ? error.code : "V2_TOP20_PROVIDER_CALL_HEARTBEAT_FAILED",
            cancelled ? "top20 Worker collection cancellation was requested" : "top20 provider call heartbeat failed",
            cancelled ? 409 : 503
          );
        }
        const ackType = message?.type === V2_TOP20_PROVIDER_CALL_STARTED_REQUEST_TYPE
          ? V2_TOP20_PROVIDER_CALL_STARTED_ACK_TYPE
          : V2_TOP20_PROVIDER_CALL_ACK_TYPE;
        sendProviderCallAck(request || message, false, ackType);
      }
    }

    if (providerCallHook) {
      child.on?.("message", (message) => {
        providerMessageChain = providerMessageChain.then(() => handleProviderCallMessage(message));
      });
    }
    const timeout = setTimeout(() => {
      if (settled) return;
      child.kill?.("SIGTERM");
      settled = true;
      reject(createCrawlFailure("NAVER_TEMPORARY_UNAVAILABLE"));
    }, maxRuntimeMs);
    timeout.unref?.();
    child.stdout?.on?.("data", (chunk) => {
      stdout = (stdout + chunk.toString("utf8")).slice(-2 * 1024 * 1024);
    });
    child.stderr?.on?.("data", (chunk) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-128 * 1024);
    });
    child.once?.("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      input.signal?.removeEventListener?.("abort", onAbort);
      reject(classifyCollectorProcessFailure({ spawnError: error }));
    });
    child.once?.("close", async (code) => {
      if (settled) return;
      await providerMessageChain.catch(() => {});
      settled = true;
      clearTimeout(timeout);
      input.signal?.removeEventListener?.("abort", onAbort);
      if (providerHeartbeatFailure) {
        reject(providerHeartbeatFailure);
      } else if (input.signal?.aborted) {
        reject(Object.assign(new Error("top20 Worker collection was aborted"), {
          code: "V2_TOP20_COLLECTION_ABORTED",
          statusCode: 499,
          retryable: false
        }));
      } else if (code !== 0) {
        reject(classifyCollectorProcessFailure({ stderr, stdout, exitCode: code }));
      } else {
        try {
          const normalizedTrace = normalizeV2Top20ProviderCallTrace(providerCallTrace);
          const probeResult = typeof input.parseResult === "function" ? input.parseResult(stdout) : null;
          resolve({
            code,
            stdoutLength: Buffer.byteLength(stdout),
            stderrLength: Buffer.byteLength(stderr),
            executedCallCount,
            providerCallTrace: normalizedTrace,
            providerCallTraceHash: computeV2Top20ProviderCallTraceHash(normalizedTrace),
            probeResult
          });
        } catch (error) {
          reject(error);
        }
      }
    });
  });
}

async function executeV2Top20MainPlaceRecoveryProbe(input = {}) {
  const contract = normalizeV2Top20PrepareContract(input.contract || {});
  if (typeof input.heartbeat !== "function" || typeof input.onProviderCall !== "function") {
    throw collectorError("V2_TOP20_HEARTBEAT_REQUIRED", "main-place recovery probe heartbeat is required", 500);
  }
  const tempBase = path.resolve(String(input.tempBase || os.tmpdir()));
  if (!path.isAbsolute(tempBase)) throw collectorError("V2_TOP20_RUNTIME_PATH_INVALID", "probe temp base must be absolute", 400);
  const tempRoot = await fs.mkdtemp(path.join(tempBase, "v2-top20-main-place-probe-"));
  try {
    const environment = buildV2Top20MainPlaceProbeEnvironment({
      contract,
      outputRoot: path.join(tempRoot, "unused-output"),
      runStamp: `20260818_000000_${crypto.randomBytes(4).toString("hex")}`,
      baseEnvironment: input.baseEnvironment || process.env
    });
    await input.heartbeat();
    const collected = await runCollectorChild({
      spawnImpl: input.spawnImpl,
      maxRuntimeMs: input.maxRuntimeMs,
      signal: input.signal,
      scriptPath: path.resolve(input.scriptPath || path.join(__dirname, "gyeongnam_glamping_crawl.cjs")),
      cwd: path.resolve(input.cwd || path.join(__dirname, "..")),
      keyword: contract.keyword,
      environment,
      authorizeProviderCall: async (metadata) => {
        if (metadata?.providerId !== providerIdForOperation("main_place") || metadata?.operation !== "main_place") {
          throw collectorError("V2_TOP20_MAIN_PLACE_PROBE_SEQUENCE_INVALID", "probe may only authorize main place", 409);
        }
        await input.heartbeat();
      },
      onProviderCall: async (metadata) => {
        if (metadata?.providerId !== providerIdForOperation("main_place") || metadata?.operation !== "main_place" || metadata?.requestOrdinal !== 1) {
          throw collectorError("V2_TOP20_MAIN_PLACE_PROBE_SEQUENCE_INVALID", "probe may only start one main-place call", 409);
        }
        await input.onProviderCall(metadata);
      },
      parseResult: parseMainPlaceProbeResult
    });
    if (collected.executedCallCount !== 1 || collected.providerCallTrace.length !== 1 || collected.providerCallTrace[0].operation !== "main_place") {
      throw collectorError("V2_TOP20_MAIN_PLACE_PROBE_SEQUENCE_INVALID", "probe did not execute exactly one main-place call", 409);
    }
    return Object.freeze({ ...collected.probeResult, providerCallCount: 1 });
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => {});
  }
}

async function findSingleFinalOutput(outputRoot) {
  const entries = await fs.readdir(outputRoot, { withFileTypes: true });
  const directories = entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith("config"));
  const pending = directories.filter((entry) => entry.name.includes(".pending-"));
  const final = directories.filter((entry) => !entry.name.includes(".pending-"));
  if (pending.length || final.length !== 1) {
    throw collectorError("V2_TOP20_OUTPUT_INVALID", "top20 Worker did not produce exactly one final run", 502);
  }
  return path.join(outputRoot, final[0].name);
}

async function executeV2Top20Collector(input = {}) {
  const contract = normalizeV2Top20PrepareContract(input.contract || {});
  if (typeof input.heartbeat !== "function") {
    throw collectorError("V2_TOP20_HEARTBEAT_REQUIRED", "top20 Worker heartbeat is required", 500);
  }
  if (typeof input.onProviderCall !== "function") {
    throw collectorError(
      "V2_TOP20_PROVIDER_CALL_HEARTBEAT_REQUIRED",
      "top20 per-provider-call heartbeat is required",
      500
    );
  }
  const rawTempBase = String(input.tempBase || "").trim();
  if (!rawTempBase || !path.isAbsolute(rawTempBase)) {
    throw collectorError("V2_TOP20_RUNTIME_PATH_INVALID", "top20 Worker temp base must be absolute", 400);
  }
  const tempBase = path.resolve(rawTempBase);
  await fs.mkdir(tempBase, { recursive: true });
  const tempRoot = await fs.mkdtemp(path.join(tempBase, "v2-top20-"));
  const collectorController = new AbortController();
  const onExternalAbort = () => collectorController.abort();
  if (input.signal?.aborted) collectorController.abort();
  else input.signal?.addEventListener?.("abort", onExternalAbort, { once: true });
  let heartbeatFlight = null;
  let heartbeatError = null;
  let timer = null;
  const heartbeat = async () => {
    if (heartbeatError) throw heartbeatError;
    if (heartbeatFlight) return heartbeatFlight;
    const task = (async () => {
      try {
        await input.heartbeat();
      } catch (error) {
        heartbeatError = error;
        collectorController.abort();
        throw error;
      }
    })();
    heartbeatFlight = task;
    try {
      return await task;
    } finally {
      if (heartbeatFlight === task) heartbeatFlight = null;
    }
  };
  try {
    const outputRoot = path.join(tempRoot, "outputs");
    await fs.mkdir(outputRoot, { recursive: true });
    const runStamp = safeRunStamp(input.runStamp || `${contract.checkIn.replaceAll("-", "")}_000000_${crypto.randomBytes(4).toString("hex")}`);
    const environment = buildV2Top20CollectorEnvironment({
      contract: input.contract,
      outputRoot,
      runStamp,
      baseEnvironment: input.baseEnvironment || process.env,
      historicalBookingHints: input.historicalBookingHints,
      detailLiveCallsAllowed: input.detailLiveCallsAllowed
    });
    await heartbeat();
    const intervalMs = Number.isInteger(input.heartbeatIntervalMs) && input.heartbeatIntervalMs >= 1000
      ? input.heartbeatIntervalMs
      : DEFAULT_HEARTBEAT_INTERVAL_MS;
    timer = setInterval(() => { void heartbeat().catch(() => {}); }, intervalMs);
    timer.unref?.();
    let collectorResult;
    if (typeof input.collectorProcess === "function") {
      let executedCallCount = 0;
      const providerCallTrace = [];
      await input.collectorProcess({
        contract,
        environment,
        outputRoot,
        tempRoot,
        runStamp,
        signal: collectorController.signal,
        authorizeProviderCall: async (metadata) => {
          const operation = String(metadata?.operation || "");
          if (metadata?.providerId !== providerIdForOperation(operation) || !V2_TOP20_SAFE_PROVIDER_OPERATIONS.has(operation)) {
            throw collectorError("V2_TOP20_PROVIDER_CALL_IPC_INVALID", "top20 provider call metadata is invalid", 409);
          }
          await heartbeat();
        },
        onProviderCall: async (metadata) => {
          const operation = String(metadata?.operation || "");
          if (metadata?.providerId !== providerIdForOperation(operation) || !V2_TOP20_SAFE_PROVIDER_OPERATIONS.has(operation)) {
            throw collectorError("V2_TOP20_PROVIDER_CALL_IPC_INVALID", "top20 provider call metadata is invalid", 409);
          }
          await input.onProviderCall(Object.freeze({
            providerId: providerIdForOperation(operation),
            operation,
            requestOrdinal: executedCallCount + 1,
            companyOrdinal: metadata.companyOrdinal ?? null,
            productOrdinal: metadata.productOrdinal ?? null
          }));
          executedCallCount += 1;
          providerCallTrace.push(Object.freeze({
            requestOrdinal: executedCallCount,
            operation,
            companyOrdinal: metadata.companyOrdinal ?? null,
            productOrdinal: metadata.productOrdinal ?? null
          }));
          return executedCallCount;
        }
      });
      collectorResult = {
        executedCallCount,
        providerCallTrace: normalizeV2Top20ProviderCallTrace(providerCallTrace),
        providerCallTraceHash: computeV2Top20ProviderCallTraceHash(providerCallTrace)
      };
    } else {
      collectorResult = await runCollectorChild({
        spawnImpl: input.spawnImpl,
        maxRuntimeMs: input.maxRuntimeMs,
        signal: collectorController.signal,
        scriptPath: path.resolve(input.scriptPath || path.join(__dirname, "gyeongnam_glamping_crawl.cjs")),
        cwd: path.resolve(input.cwd || path.join(__dirname, "..")),
        keyword: contract.keyword,
        environment,
        authorizeProviderCall: heartbeat,
        onProviderCall: input.onProviderCall
      });
    }
    await heartbeat();
    const outputDir = await findSingleFinalOutput(outputRoot);
    const artifactInput = await collectV2Top20ArtifactFiles({
      tempRoot,
      outputDir,
      contractHash: input.contractHash,
      executionIdentityHash: input.executionIdentityHash
    });
    if (collectorResult.executedCallCount !== artifactInput.summary.executedCallCount) {
      throw collectorError(
        "V2_TOP20_EXECUTED_CALL_COUNT_MISMATCH",
        "top20 parent and child provider call counts do not match",
        409
      );
    }
    if (collectorResult.providerCallTraceHash !== artifactInput.summary.providerCallTraceHash) {
      throw collectorError(
        "V2_TOP20_PROVIDER_CALL_TRACE_MISMATCH",
        "top20 parent call trace does not match the child manifest",
        409
      );
    }
    return Object.freeze({
      schemaVersion: V2_TOP20_COLLECTOR_SCHEMA_VERSION,
      runStamp,
      providerCallCount: collectorResult.executedCallCount,
      providerCallTraceHash: collectorResult.providerCallTraceHash,
      readyCount: artifactInput.summary.readyCount,
      zeroCount: artifactInput.summary.zeroCount,
      collectionStatus: artifactInput.summary.collectionStatus || "complete",
      files: artifactInput.files
    });
  } finally {
    if (timer) clearInterval(timer);
    input.signal?.removeEventListener?.("abort", onExternalAbort);
    await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => {});
  }
}

module.exports = {
  CollectionWorkerV2Top20CollectorError,
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  DEFAULT_MAX_RUNTIME_MS,
  V2_TOP20_PROVIDER_CALL_ACK_TYPE,
  V2_TOP20_PROVIDER_CALL_REQUEST_TYPE,
  V2_TOP20_PROVIDER_CALL_STARTED_ACK_TYPE,
  V2_TOP20_PROVIDER_CALL_STARTED_REQUEST_TYPE,
  V2_TOP20_COLLECTOR_SCHEMA_VERSION,
  buildV2Top20CollectorEnvironment,
  buildV2Top20MainPlaceProbeEnvironment,
  executeV2Top20MainPlaceRecoveryProbe,
  executeV2Top20Collector,
  findSingleFinalOutput,
  normalizeProviderCallMessage,
  runCollectorChild,
  parseMainPlaceProbeResult,
  selectV2Top20ChildBaseEnvironment
};
