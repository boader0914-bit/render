"use strict";

const {
  SIGNAL_CONNECTOR_RETRYABLE_CATEGORIES,
  classifyProviderError,
  connectorError,
  normalizeConnectorSignal,
  normalizeSignalJobRequest,
  publicProviderError,
  retryBackoffMilliseconds
} = require("../contracts/signal_connector.cjs");
const { canonicalJson, cleanText, stableHash } = require("../contracts/insights.cjs");

function clockTime(clock) {
  const value = clock();
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function workerActor(actor = {}) {
  return {
    type: cleanText(actor.type || "worker", 32),
    id: cleanText(actor.id || actor.accountId || "stage231-signal-connector", 120),
    role: cleanText(actor.role, 32)
  };
}

function createSignalConnectorService(options = {}) {
  const repository = options.repository;
  if (!repository) throw connectorError("Signal connector repository is required", "SIGNAL_CONNECTOR_REPOSITORY_REQUIRED", 500);
  const env = options.env || process.env;
  const clock = options.clock || Date.now;
  const adapters = Object.freeze({ ...(options.adapters || {}) });
  const fixtureAdapter = options.fixtureAdapter || null;
  const active = new Map();
  const runtimeMetrics = {
    adapterInvocations: 0,
    externalNetworkCalls: 0,
    realAdapterInvocations: 0,
    fixtureAdapterInvocations: 0,
    fallbackAdapterInvocations: 0,
    schedulerTicks: 0,
    schedulerCreated: 0,
    schedulerDeduplicated: 0
  };

  function adapterFor(request) {
    if (request.mode === "fixture") {
      if (env.NODE_ENV !== "test") {
        throw connectorError("Deterministic signal fixtures are test-only", "SIGNAL_CONNECTOR_FIXTURE_FORBIDDEN", 503);
      }
      if (!fixtureAdapter || fixtureAdapter.kind !== "deterministic-fixture" || fixtureAdapter.id !== request.providerId || typeof fixtureAdapter.collect !== "function") {
        throw connectorError("An explicit Stage 229 deterministic fixture adapter is required", "SIGNAL_CONNECTOR_ADAPTER_REQUIRED", 503);
      }
      return fixtureAdapter;
    }
    const adapter = adapters[request.providerId];
    if (!adapter || adapter.kind !== "real" || adapter.id !== request.providerId || typeof adapter.collect !== "function") {
      throw connectorError("An explicit real signal adapter is required", "SIGNAL_CONNECTOR_ADAPTER_REQUIRED", 503);
    }
    return adapter;
  }

  async function enqueue(payload, context = {}) {
    const request = normalizeSignalJobRequest(payload);
    adapterFor(request);
    return repository.createJob(request, {
      actor: workerActor(context.actor),
      scheduleKey: context.scheduleKey || ""
    });
  }

  async function providerStopped(providerId) {
    return Boolean((await repository.killSwitch(providerId)).open);
  }

  function providerInput(job, controller) {
    return {
      companyId: job.target.companyId,
      tenantCompanyId: job.target.tenantCompanyId,
      region: job.target.region,
      periodMonth: job.target.periodMonth,
      signalKinds: [...job.target.signalKinds],
      runId: job.jobId,
      clientRequestId: job.clientRequestId,
      timeoutMs: job.timeoutMs,
      signal: controller.signal
    };
  }

  async function collectWithTimeout(adapter, input, timeoutMs, controller) {
    let timer;
    try {
      return await Promise.race([
        Promise.resolve().then(() => adapter.collect(input)),
        new Promise((_resolve, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            const error = connectorError("provider timeout", "SIGNAL_PROVIDER_TIMEOUT", 504, { category: "timeout" });
            error.name = "AbortError";
            reject(error);
          }, timeoutMs);
        })
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  function normalizeResultSignals(job, result) {
    if (!result || !Array.isArray(result.signals) || !result.signals.length) {
      throw connectorError("provider returned an empty result", "SIGNAL_PROVIDER_EMPTY", 502, { category: "empty" });
    }
    return result.signals.map((row) => normalizeConnectorSignal({
      ...row,
      companyId: job.target.companyId,
      region: job.target.region,
      periodMonth: job.target.periodMonth,
      runId: job.jobId,
      source: job.providerId,
      providerId: job.providerId,
      synthetic: job.mode === "fixture",
      dataMode: job.mode === "real" ? "live" : row.dataMode,
      provenance: {
        ...(row.provenance && typeof row.provenance === "object" ? row.provenance : {}),
        externalNetworkCalls: Math.max(0, Math.floor(Number(result.externalNetworkCalls ?? row.externalNetworkCalls ?? row.provenance?.externalNetworkCalls ?? 0) || 0))
      }
    }, job.mode));
  }

  async function settleFailure(job, reason, actor, reservation = null) {
    if (reservation && Number(reason?.externalNetworkCalls || 0) > 0) {
      await repository.recordTransportAttempt(reservation.reservationId, Number(reason.externalNetworkCalls), actor);
      runtimeMetrics.externalNetworkCalls += Math.max(0, Math.floor(Number(reason.externalNetworkCalls) || 0));
    }
    const current = await repository.getJob(job.jobId);
    if (!current || current.status === "cancelled") return current;
    const error = publicProviderError(reason);
    if (SIGNAL_CONNECTOR_RETRYABLE_CATEGORIES.has(error.category) && current.attempts < current.maxAttempts) {
      const now = clockTime(clock);
      const waitMs = retryBackoffMilliseconds(current.attempts, reason, {
        now,
        baseMs: options.retryBaseMs || 1_000,
        maximumMs: options.retryMaximumMs || 3_600_000
      });
      return repository.retryJob(current.jobId, error, new Date(now + waitMs).toISOString(), actor);
    }
    return repository.failJob(current.jobId, error, actor);
  }

  async function execute(job, context = {}) {
    const actor = workerActor(context.actor);
    if (await providerStopped(job.providerId)) {
      return repository.failJob(job.jobId, {
        category: "provider",
        code: "SIGNAL_CONNECTOR_KILL_SWITCH_OPEN",
        message: "provider 수집이 수동 중단되었습니다."
      }, actor);
    }
    let adapter;
    try {
      adapter = adapterFor(job);
    } catch (error) {
      return settleFailure(job, error, actor);
    }

    let reservation = null;
    const controller = new AbortController();
    active.set(job.jobId, controller);
    try {
      reservation = (await repository.reserveQuota({
        reservationKey: `${job.jobId}:attempt:${job.attempts}`,
        jobId: job.jobId,
        providerId: job.providerId,
        calls: job.quota.callsPerRun,
        cost: job.quota.callsPerRun * job.quota.costPerCall,
        caps: job.quota
      }, actor)).reservation;
      // The durable reservation is committed before this transport-start audit.
      await repository.recordTransportAttempt(reservation.reservationId, 0, actor);
      runtimeMetrics.adapterInvocations += 1;
      if (job.mode === "real") runtimeMetrics.realAdapterInvocations += 1;
      else runtimeMetrics.fixtureAdapterInvocations += 1;
      const result = await collectWithTimeout(adapter, providerInput(job, controller), job.timeoutMs, controller);
      const externalNetworkCalls = Math.max(0, Math.floor(Number(result?.externalNetworkCalls || 0)));
      if (externalNetworkCalls) {
        await repository.recordTransportAttempt(reservation.reservationId, externalNetworkCalls, actor);
        runtimeMetrics.externalNetworkCalls += externalNetworkCalls;
      }
      const current = await repository.getJob(job.jobId);
      if (!current || current.status === "cancelled") return current;
      let signals;
      try {
        signals = normalizeResultSignals(job, result);
      } catch (error) {
        if (!error.category) error.category = "schema";
        throw error;
      }
      if (signals.some((row) => row.companyId !== job.target.companyId || row.periodMonth !== job.target.periodMonth)) {
        throw connectorError("provider signal scope mismatch", "SIGNAL_PROVIDER_SCHEMA", 502, { category: "schema" });
      }
      const committed = await repository.commitSignals(job.jobId, signals, job.mode, actor);
      return {
        ...committed.job,
        insertedSignals: committed.signals.length,
        duplicateSignals: committed.duplicates
      };
    } catch (reason) {
      if (controller.signal.aborted && (await repository.getJob(job.jobId))?.status === "cancelled") {
        return repository.getJob(job.jobId);
      }
      return settleFailure(job, reason, actor, reservation);
    } finally {
      active.delete(job.jobId);
    }
  }

  async function runNext(filter = {}, context = {}) {
    const job = await repository.claimNext(filter, workerActor(context.actor));
    if (!job) return { claimed: false, job: null };
    return { claimed: true, job: await execute(job, context) };
  }

  async function cancel(reference, context = {}) {
    const job = await repository.cancelJob(reference, workerActor(context.actor), context.reason || "manual-stop");
    active.get(job.jobId)?.abort();
    return job;
  }

  async function resume(reference, context = {}) {
    const existing = await repository.getJob(reference);
    if (!existing) throw connectorError("Signal connector job was not found", "SIGNAL_CONNECTOR_JOB_NOT_FOUND", 404);
    adapterFor(existing);
    return repository.resumeJob(reference, workerActor(context.actor));
  }

  async function stopProvider(providerId, context = {}) {
    const actor = workerActor(context.actor);
    const state = await repository.setKillSwitch(providerId, true, actor, context.reason || "manual-stop");
    const pending = await repository.listJobs({ providerId, statuses: ["queued", "running", "retry-wait"] });
    for (const job of pending) {
      await repository.cancelJob(job.jobId, actor, context.reason || "manual-stop");
      active.get(job.jobId)?.abort();
    }
    return { ...state, cancelledJobs: pending.length };
  }

  async function resumeProvider(providerId, context = {}) {
    return repository.setKillSwitch(providerId, false, workerActor(context.actor), context.reason || "manual-resume");
  }

  async function enableScheduler(context = {}) {
    return repository.setSchedulerStopped(false, workerActor(context.actor), context.reason || "manual-enable");
  }

  async function stopScheduler(context = {}) {
    return repository.setSchedulerStopped(true, workerActor(context.actor), context.reason || "manual-stop");
  }

  async function schedule(slotInput, requests, context = {}) {
    runtimeMetrics.schedulerTicks += 1;
    const scheduler = await repository.schedulerStatus();
    if (scheduler.stopped) return { stopped: true, created: 0, deduplicated: 0, jobs: [] };
    const slot = cleanText(slotInput, 80);
    if (!/^\d{4}-\d{2}-\d{2}(?:T\d{2})?$/.test(slot)) {
      throw connectorError("Scheduler slot must be a UTC day or hour", "SIGNAL_CONNECTOR_SCHEDULE_SLOT_INVALID");
    }
    const jobs = [];
    let created = 0;
    let deduplicated = 0;
    for (const raw of requests || []) {
      const base = { ...raw };
      const identity = stableHash(canonicalJson({
        slot,
        providerId: base.providerId,
        companyId: base.companyId,
        tenantCompanyId: base.tenantCompanyId,
        periodMonth: base.periodMonth,
        signalKinds: base.signalKinds
      }), 40);
      const scheduleKey = `signal_schedule_${identity}`;
      const result = await enqueue({ ...base, clientRequestId: `signal_sched_${identity}` }, {
        actor: context.actor,
        scheduleKey
      });
      if (result.idempotent) deduplicated += 1;
      else created += 1;
      jobs.push(result.job);
    }
    runtimeMetrics.schedulerCreated += created;
    runtimeMetrics.schedulerDeduplicated += deduplicated;
    return { stopped: false, created, deduplicated, jobs };
  }

  async function providerMetrics(providerId = "") {
    return repository.providerMetrics(providerId);
  }

  async function diagnostics() {
    const store = await repository.diagnostics();
    return {
      stage: 231,
      adapterMode: "explicit-injection-only",
      configuredRealAdapters: Object.values(adapters).filter((adapter) => adapter?.kind === "real").map((adapter) => cleanText(adapter.id, 120)).sort(),
      fixtureAdapterConfigured: Boolean(fixtureAdapter),
      activeJobs: active.size,
      ...runtimeMetrics,
      store,
      credentialValuesExposed: false,
      fallbackAdapterInvocations: 0
    };
  }

  return Object.freeze({
    enqueue,
    runNext,
    cancel,
    resume,
    stopProvider,
    resumeProvider,
    enableScheduler,
    stopScheduler,
    schedule,
    providerMetrics,
    diagnostics
  });
}

module.exports = {
  createSignalConnectorService
};
