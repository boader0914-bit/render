"use strict";

const { createFreshDataRuntime } = require("./fresh_data_runtime.cjs");
const { createSyntheticFreshCollectionProvider } = require("../services/fresh_collection_provider.cjs");
const { createFreshCollectionService } = require("../services/fresh_collection_service.cjs");
const { createFreshCollectionWorker } = require("../services/fresh_collection_worker.cjs");
const { createFreshPlatformService } = require("../services/fresh_platform_service.cjs");
const { createFreshDataHttpHandler } = require("../http/fresh_data_http.cjs");

function createFreshPlatformRuntime(options = {}) {
  const env = options.env || process.env;
  if (!options.authRuntime?.service || !options.authRuntime?.http) {
    throw new Error("Stage 228 fresh platform requires the Stage 226 auth runtime");
  }
  const providerMode = String(env.V2_INTEGRATION_FRESH_PROVIDER || "synthetic").trim().toLowerCase();
  if (providerMode !== "synthetic") {
    const error = new Error("Stage 228 real providers require explicit provider, quota, credential and cost approval");
    error.code = "FRESH_REAL_PROVIDER_APPROVAL_REQUIRED";
    throw error;
  }
  const data = createFreshDataRuntime({
    env,
    projectRoot: options.projectRoot,
    dataDir: options.dataDir,
    legacyPaths: options.legacyPaths,
    clock: options.clock,
    idFactory: options.storeIdFactory
  });
  const provider = options.provider || createSyntheticFreshCollectionProvider({ clock: options.clock });
  const collectionService = createFreshCollectionService({
    repository: data.repository,
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

module.exports = { createFreshPlatformRuntime };
