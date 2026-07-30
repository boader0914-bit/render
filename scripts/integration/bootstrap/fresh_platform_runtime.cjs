"use strict";

const { createFreshDataRuntime } = require("./fresh_data_runtime.cjs");
const {
  createDisabledFreshCollectionProvider,
  createSyntheticFreshCollectionProvider
} = require("../services/fresh_collection_provider.cjs");
const {
  NAVER_API_HUB_LOCAL_ENDPOINT,
  NAVER_SEARCH_MODES,
  PROVIDER_KEYS,
  createFetchTransport,
  createV2LiveCollectionProvider
} = require("../services/v2_live_collection_provider.cjs");
const { createFreshCollectionService } = require("../services/fresh_collection_service.cjs");
const { createFreshCollectionWorker } = require("../services/fresh_collection_worker.cjs");
const { createFreshPlatformService } = require("../services/fresh_platform_service.cjs");
const { createFreshDataHttpHandler } = require("../http/fresh_data_http.cjs");

function envTrue(value) {
  return /^(?:1|true|yes|on)$/i.test(String(value || "").trim());
}

function csv(value) {
  return [...new Set(String(value || "").split(",").map((item) => item.trim()).filter(Boolean))];
}

function createConfiguredProvider(options = {}) {
  const env = options.env || process.env;
  // Render does not guarantee that NODE_ENV is explicitly populated. Treat
  // every Render process as production so a stale synthetic-test flag can
  // never enable fixture data in a deployed service.
  const isProduction = String(env.NODE_ENV || "").trim().toLowerCase() === "production"
    || Boolean(env.RENDER || env.RENDER_EXTERNAL_URL || env.RENDER_SERVICE_ID);
  if (options.provider) {
    const injectedSynthetic = options.provider.kind === "synthetic" || options.provider.synthetic === true;
    return isProduction && injectedSynthetic
      ? createDisabledFreshCollectionProvider({ reason: "합성 provider는 배포 환경에서 사용할 수 없습니다." })
      : options.provider;
  }
  const mode = String(env.V2_INTEGRATION_FRESH_PROVIDER || "disabled").trim().toLowerCase();
  const testSynthetic = !isProduction && (
    String(env.NODE_ENV || "").trim().toLowerCase() === "test"
    || envTrue(env.V2_INTEGRATION_SYNTHETIC_TEST_ENABLED)
  );
  if (mode === "synthetic") {
    return testSynthetic
      ? createSyntheticFreshCollectionProvider({ clock: options.clock })
      : createDisabledFreshCollectionProvider({ reason: "합성 provider는 테스트 환경에서만 사용할 수 있습니다." });
  }
  if (["", "disabled", "none"].includes(mode)) {
    return createDisabledFreshCollectionProvider();
  }
  if (!["live", "v2-live"].includes(mode)) {
    const error = new Error("Stage 228 real providers require explicit provider, quota, credential and cost approval");
    error.code = "FRESH_PROVIDER_MODE_INVALID";
    throw error;
  }

  const liveEnabled = envTrue(env.V2_INTEGRATION_LIVE_COLLECTION_ENABLED);
  const naverSearchMode = String(env.V2_INTEGRATION_LIVE_NAVER_SEARCH_MODE || NAVER_SEARCH_MODES.disabled)
    .trim().toLowerCase();
  const transport = options.transport || (liveEnabled
    ? createFetchTransport({ fetchImpl: options.fetchImpl || global.fetch })
    : undefined);
  const providerOptions = {
    clock: options.clock,
    sleep: options.sleep,
    transport,
    liveEnabled,
    naverSearchMode,
    naverApiHubKeyId: env.V2_INTEGRATION_LIVE_NAVER_API_HUB_KEY_ID,
    naverApiHubKey: env.V2_INTEGRATION_LIVE_NAVER_API_HUB_KEY,
    naverApiHubSort: env.V2_INTEGRATION_LIVE_NAVER_SEARCH_SORT || "random",
    approvalManifest: env.V2_INTEGRATION_LIVE_APPROVAL_MANIFEST,
    liveApprovalTokenSha256: env.V2_INTEGRATION_LIVE_APPROVAL_SHA256,
    quotaRepository: options.quotaRepository,
    approvedProviders: csv(env.V2_INTEGRATION_LIVE_APPROVED_PROVIDERS),
    requestedStages: csv(env.V2_INTEGRATION_LIVE_REQUESTED_STAGES || "discovery,quick,detail,ota"),
    seedSourceProvider: PROVIDER_KEYS.naverSearch,
    seedSourceUrl: env.V2_INTEGRATION_LIVE_SEED_SOURCE_URL
      || (naverSearchMode === NAVER_SEARCH_MODES.apiHub
        ? NAVER_API_HUB_LOCAL_ENDPOINT
        : (naverSearchMode === NAVER_SEARCH_MODES.internalWeb
          ? "https://pcmap.place.naver.com/accommodation/list"
          : "")),
    hostnameAllowlist: {
      [PROVIDER_KEYS.naverSearch]: naverSearchMode === NAVER_SEARCH_MODES.apiHub
        ? ["naverapihub.apigw.ntruss.com"]
        : (naverSearchMode === NAVER_SEARCH_MODES.internalWeb ? ["pcmap.place.naver.com"] : []),
      [PROVIDER_KEYS.naverBooking]: ["pcmap-api.place.naver.com", "m.booking.naver.com"],
      [PROVIDER_KEYS.nol]: ["nol.yanolja.com"],
      [PROVIDER_KEYS.ddnayo]: ["trip.ddnayo.com"]
    },
    killSwitches: {
      [PROVIDER_KEYS.naverSearch]: !/^false$/i.test(String(env.V2_INTEGRATION_LIVE_NAVER_SEARCH_KILL_SWITCH || "true")),
      [PROVIDER_KEYS.naverBooking]: !/^false$/i.test(String(env.V2_INTEGRATION_LIVE_NAVER_BOOKING_KILL_SWITCH || "true")),
      [PROVIDER_KEYS.nol]: !/^false$/i.test(String(env.V2_INTEGRATION_LIVE_NOL_KILL_SWITCH || "true")),
      [PROVIDER_KEYS.ddnayo]: !/^false$/i.test(String(env.V2_INTEGRATION_LIVE_DDNAYO_KILL_SWITCH || "true"))
    },
    requestBudget: {
      perRun: Number(env.V2_INTEGRATION_LIVE_REQUESTS_PER_RUN || 0),
      perDay: Number(env.V2_INTEGRATION_LIVE_REQUESTS_PER_DAY || 0)
    },
    timeoutMs: Number(env.V2_INTEGRATION_LIVE_TIMEOUT_MS || 15_000),
    maxAttempts: Number(env.V2_INTEGRATION_LIVE_MAX_ATTEMPTS || 2)
  };
  return createV2LiveCollectionProvider({ ...providerOptions, ...(options.liveProviderOptions || {}) });
}

function createFreshPlatformRuntime(options = {}) {
  const env = options.env || process.env;
  if (!options.authRuntime?.service || !options.authRuntime?.http) {
    throw new Error("Stage 228 fresh platform requires the Stage 226 auth runtime");
  }
  const data = createFreshDataRuntime({
    env,
    projectRoot: options.projectRoot,
    dataDir: options.dataDir,
    legacyPaths: options.legacyPaths,
    clock: options.clock,
    idFactory: options.storeIdFactory
  });
  const provider = createConfiguredProvider({
    ...options,
    env,
    quotaRepository: data.repository
  });
  const collectionService = createFreshCollectionService({
    repository: data.repository,
    provider,
    clock: options.clock,
    idFactory: options.runIdFactory
  });
  const worker = createFreshCollectionWorker({
    repository: data.repository,
    provider,
    clock: options.clock,
    workerId: options.workerId,
    leaseSeconds: options.leaseSeconds,
    maxAttempts: options.maxAttempts,
    retryBaseMs: options.retryBaseMs,
    retryMaximumMs: options.retryMaximumMs,
    batchSize: options.batchSize
  });
  const pumpOptions = Object.freeze({
    stageBudget: Math.max(1, Math.min(5, Number(options.pumpStageBudget || 1))),
    yieldMs: Math.max(0, Math.min(5_000, Number(options.pumpYieldMs ?? 25))),
    maximumTimerMs: Math.max(10, Math.min(2_147_483_647, Number(options.pumpMaximumTimerMs || 60_000))),
    errorDelayMs: Math.max(10, Math.min(60_000, Number(options.pumpErrorDelayMs || 1_000)))
  });
  let initialized = false;
  let stopped = false;
  let wakeRequested = false;
  let scheduledTimer = null;
  let scheduledFor = 0;
  let activePump = null;
  let followupDelay = null;
  const pumpMetrics = {
    cycles: 0,
    claimedCycles: 0,
    scheduledWakeups: 0,
    startupRecoveries: 0,
    errors: 0,
    lastOutcome: "not-started",
    lastError: "",
    lastReason: "",
    lastCycleAt: ""
  };

  function clearScheduledTimer() {
    if (scheduledTimer) clearTimeout(scheduledTimer);
    scheduledTimer = null;
    scheduledFor = 0;
  }

  function schedulePump(delayMs = 0, reason = "scheduled") {
    if (stopped || !initialized) return false;
    const boundedDelay = Math.max(0, Math.min(pumpOptions.maximumTimerMs, Number(delayMs || 0)));
    const dueAt = Date.now() + boundedDelay;
    if (scheduledTimer && scheduledFor <= dueAt) return false;
    clearScheduledTimer();
    scheduledFor = dueAt;
    scheduledTimer = setTimeout(() => {
      scheduledTimer = null;
      scheduledFor = 0;
      void pump(reason);
    }, boundedDelay);
    scheduledTimer.unref?.();
    pumpMetrics.scheduledWakeups += 1;
    return true;
  }

  function wake(reason = "work-submitted") {
    if (stopped) return false;
    wakeRequested = true;
    if (initialized) schedulePump(pumpOptions.yieldMs, reason);
    return true;
  }

  async function schedulePendingWork() {
    if (stopped || !initialized) return;
    const delay = await worker.nextWakeDelayMs({ maximumMs: pumpOptions.maximumTimerMs });
    if (delay === null) return;
    schedulePump(delay === 0 ? pumpOptions.yieldMs : delay, "pending-work");
  }

  async function pump(reason = "manual") {
    if (stopped) return { ok: false, outcome: "stopped", claimed: false };
    if (!initialized) {
      wakeRequested = true;
      return { ok: false, outcome: "not-initialized", claimed: false };
    }
    if (activePump) {
      wakeRequested = true;
      return activePump;
    }
    clearScheduledTimer();
    wakeRequested = false;
    followupDelay = null;
    activePump = (async () => {
      pumpMetrics.cycles += 1;
      pumpMetrics.lastReason = reason;
      pumpMetrics.lastCycleAt = new Date().toISOString();
      try {
        const outcome = await worker.processNext({ stageBudget: pumpOptions.stageBudget });
        if (outcome.claimed) pumpMetrics.claimedCycles += 1;
        pumpMetrics.lastOutcome = outcome.outcome;
        pumpMetrics.lastError = "";
        return { ok: true, ...outcome };
      } catch (error) {
        pumpMetrics.errors += 1;
        pumpMetrics.lastOutcome = "error";
        pumpMetrics.lastError = String(error?.message || error);
        followupDelay = pumpOptions.errorDelayMs;
        return {
          ok: false,
          claimed: false,
          terminal: false,
          outcome: "error",
          error: pumpMetrics.lastError,
          code: error?.code || "FRESH_WORKER_PUMP_FAILED"
        };
      }
    })();
    try {
      return await activePump;
    } finally {
      activePump = null;
      if (!stopped) {
        if (wakeRequested) schedulePump(pumpOptions.yieldMs, "wake-requested");
        else if (followupDelay !== null) schedulePump(followupDelay, "pump-error-retry");
        else await schedulePendingWork();
      }
    }
  }

  async function close() {
    stopped = true;
    initialized = false;
    wakeRequested = false;
    clearScheduledTimer();
    if (activePump) await activePump;
    return { ok: true, runner: runnerDiagnostics() };
  }

  function runnerDiagnostics() {
    return {
      ...pumpMetrics,
      initialized,
      stopped,
      pumping: Boolean(activePump),
      wakeScheduled: Boolean(scheduledTimer),
      scheduledFor: scheduledFor ? new Date(scheduledFor).toISOString() : "",
      options: pumpOptions
    };
  }

  const service = createFreshPlatformService({
    repository: data.repository,
    collectionService,
    worker,
    authService: options.authRuntime.service,
    clock: options.clock,
    allowSynthetic: provider.kind === "synthetic"
      && !Boolean(env.RENDER || env.RENDER_EXTERNAL_URL || env.RENDER_SERVICE_ID)
      && (
        String(env.NODE_ENV || "").trim().toLowerCase() === "test"
        || (!String(env.NODE_ENV || "").trim() && Boolean(options.provider))
        || envTrue(env.V2_INTEGRATION_SYNTHETIC_TEST_ENABLED)
      ),
    scheduleWork: wake
  });
  const http = createFreshDataHttpHandler({
    service,
    authService: options.authRuntime.service,
    authHttp: options.authRuntime.http,
    send: options.send,
    parseBody: options.parseBody
  });
  const runner = Object.freeze({
    wake,
    pump,
    close,
    diagnostics: runnerDiagnostics
  });
  return Object.freeze({
    data,
    repository: data.repository,
    provider,
    collectionService,
    worker,
    runner,
    service,
    http,
    async initialize() {
      if (stopped) throw new Error("Stage 228 fresh platform runtime has been closed");
      const store = await data.initialize();
      initialized = true;
      const recovery = await worker.recover();
      pumpMetrics.startupRecoveries += recovery.recovered.length;
      const startupPump = await pump("startup-recovery");
      return { ok: true, store, recovery, startupPump, metadata: service.metadata() };
    },
    close,
    async diagnostics() {
      return {
        ...(await data.diagnostics()),
        worker: worker.diagnostics(),
        runner: runnerDiagnostics(),
        metadata: service.metadata()
      };
    }
  });
}

module.exports = { createConfiguredProvider, createFreshPlatformRuntime };
