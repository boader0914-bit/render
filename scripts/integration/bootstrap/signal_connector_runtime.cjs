"use strict";

const { createSignalConnectorRepository } = require("../repositories/signal_connector_store.cjs");
const { createSignalConnectorService } = require("../services/signal_connector_service.cjs");
const {
  createFetchTransport,
  createNaverSearchAdAdapter,
  createNaverTrendAdapter,
  createTourismAdapter
} = require("../services/official_signal_adapters.cjs");
const { createSignalConnectorHttpHandler } = require("../http/signal_connector_http.cjs");
const { connectorError } = require("../contracts/signal_connector.cjs");
const { cleanText } = require("../contracts/insights.cjs");
const { readIntegrationFeatureFlags } = require("../../integration_feature_flags.cjs");

const SIGNAL_PROVIDER_POLICIES = Object.freeze([
  Object.freeze({ id: "tourism", label: "관광", flag: "tourismReal", callsPerRun: 3, costPerCall: 0, signalKinds: Object.freeze(["tourism.visitors", "tourism.resource-demand", "tourism.diversity"]) }),
  Object.freeze({ id: "naver-searchad", label: "검색량", flag: "naverSearchAdReal", callsPerRun: 1, costPerCall: 0, signalKinds: Object.freeze(["search.volume"]) }),
  Object.freeze({ id: "naver-trend", label: "트렌드", flag: "naverTrendReal", callsPerRun: 1, costPerCall: 0, signalKinds: Object.freeze(["trend.index"]) }),
  Object.freeze({ id: "sns", label: "SNS", flag: "snsReal", callsPerRun: 1, costPerCall: 0, signalKinds: Object.freeze(["sns.mentions"]) })
]);

const CLIENT_POLICY_FIELDS = Object.freeze([
  "signalKinds", "region", "dailyCallCap", "monthlyCallCap", "dailyCostCap",
  "monthlyCostCap", "callsPerRun", "costPerCall", "currency", "maxAttempts",
  "timeoutMs", "mode"
]);

function nonZero(value) {
  return Number(value || 0) !== 0;
}

function positiveCap(value) {
  const number = Number(value || 0);
  return Number.isInteger(number) && number > 0 ? number : 0;
}

function providerEnvPrefix(providerId) {
  return `V2_CONNECTOR_${providerId.replace(/-/g, "_").toUpperCase()}`;
}

function approvedPolicy(policy, env, override = {}) {
  const prefix = providerEnvPrefix(policy.id);
  const dailyCallCap = positiveCap(override.dailyCallCap ?? env[`${prefix}_APPROVED_DAILY_CALL_CAP`]);
  const monthlyCallCap = positiveCap(override.monthlyCallCap ?? env[`${prefix}_APPROVED_MONTHLY_CALL_CAP`]);
  const dailyCostCap = Number(override.dailyCostCap ?? env[`${prefix}_APPROVED_DAILY_COST_CAP_KRW`] ?? 0);
  const monthlyCostCap = Number(override.monthlyCostCap ?? env[`${prefix}_APPROVED_MONTHLY_COST_CAP_KRW`] ?? 0);
  return Object.freeze({
    callsPerRun: Number(override.callsPerRun || policy.callsPerRun),
    costPerCall: Number(override.costPerCall ?? policy.costPerCall),
    dailyCallCap,
    monthlyCallCap,
    dailyCostCap: Number.isFinite(dailyCostCap) && dailyCostCap >= 0 ? dailyCostCap : 0,
    monthlyCostCap: Number.isFinite(monthlyCostCap) && monthlyCostCap >= 0 ? monthlyCostCap : 0,
    currency: "KRW",
    maxAttempts: Math.max(1, Math.min(8, Number(override.maxAttempts || 3))),
    timeoutMs: Math.max(100, Math.min(120_000, Number(override.timeoutMs || 15_000)))
  });
}

function projectJob(job) {
  return {
    clientRequestId: job.clientRequestId,
    providerId: job.providerId,
    mode: job.mode,
    status: job.status,
    attempts: Number(job.attempts || 0),
    maxAttempts: Number(job.maxAttempts || 0),
    nextAttemptAt: job.nextAttemptAt || null,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    completedAt: job.completedAt || null,
    target: {
      region: job.target?.region || "",
      periodMonth: job.target?.periodMonth || "",
      signalKinds: [...(job.target?.signalKinds || [])]
    },
    quota: {
      callsPerRun: Number(job.quota?.callsPerRun || 0),
      dailyCallCap: Number(job.quota?.dailyCallCap || 0),
      monthlyCallCap: Number(job.quota?.monthlyCallCap || 0),
      dailyCostCap: Number(job.quota?.dailyCostCap || 0),
      monthlyCostCap: Number(job.quota?.monthlyCostCap || 0),
      currency: job.quota?.currency || "KRW"
    },
    error: job.error ? {
      category: job.error.category || "provider",
      code: job.error.code || "SIGNAL_CONNECTOR_REQUEST_FAILED",
      message: job.error.message || "Connector request failed safely."
    } : null
  };
}

function configuredAdapters(options, flags, env) {
  if (options.adapters) {
    return { adapters: Object.freeze({ ...options.adapters }), credentialReads: 0, reasons: Object.freeze({}), injected: true };
  }
  const allowlist = new Set(String(env.V2_INTEGRATION_SIGNAL_REAL_PROVIDERS || "").split(",").map((row) => row.trim()).filter(Boolean));
  const transportEnabled = String(env.V2_INTEGRATION_SIGNAL_TRANSPORT || "").trim().toLowerCase() === "fetch";
  const transport = options.transport || (transportEnabled ? createFetchTransport({ fetchImpl: options.fetchImpl }) : null);
  const adapters = {};
  const reasons = {};
  let credentialReads = 0;
  const configure = (id, flag, factory, credentialNames) => {
    if (!flags[flag]) return void (reasons[id] = "feature-flag-off");
    if (!allowlist.has(id)) return void (reasons[id] = "provider-not-explicitly-selected");
    if (!transport) return void (reasons[id] = "transport-disabled");
    const values = Object.fromEntries(credentialNames.map(([key, envName]) => [key, String(env[envName] || "").trim()]));
    credentialReads += credentialNames.length;
    if (Object.values(values).some((value) => !value)) return void (reasons[id] = "credential-required");
    try {
      adapters[id] = factory({ ...values, transport, clock: options.clock });
      reasons[id] = "configured";
    } catch {
      reasons[id] = "configuration-invalid";
    }
  };
  configure("naver-trend", "naverTrendReal", createNaverTrendAdapter, [
    ["clientId", "V2_CONNECTOR_NAVER_DATALAB_CLIENT_ID"],
    ["clientSecret", "V2_CONNECTOR_NAVER_DATALAB_CLIENT_SECRET"]
  ]);
  configure("tourism", "tourismReal", createTourismAdapter, [
    ["serviceKey", "V2_CONNECTOR_TOURAPI_SERVICE_KEY"]
  ]);
  configure("naver-searchad", "naverSearchAdReal", createNaverSearchAdAdapter, [
    ["apiKey", "V2_CONNECTOR_NAVER_SEARCHAD_API_KEY"],
    ["secretKey", "V2_CONNECTOR_NAVER_SEARCHAD_SECRET_KEY"],
    ["customerId", "V2_CONNECTOR_NAVER_SEARCHAD_CUSTOMER_ID"]
  ]);
  reasons.sns = flags.snsReal ? "official-contract-unavailable" : "feature-flag-off";
  return { adapters: Object.freeze(adapters), credentialReads, reasons: Object.freeze(reasons), injected: false };
}

function createSignalConnectorRuntime(options = {}) {
  const env = options.env || process.env;
  const authRuntime = options.authRuntime;
  const freshRepository = options.freshRepository;
  if (!authRuntime?.service || !authRuntime?.http) throw new Error("Stage 231 signal connector runtime requires the Stage 226 auth runtime");
  if (!freshRepository?.getCompany || !freshRepository?.getBusinessSafeCompany) throw new Error("Stage 231 signal connector runtime requires the Stage 228 fresh repository");
  const flags = options.featureFlags || readIntegrationFeatureFlags(env);
  const integrationRoot = String(options.integrationRoot || env.V2_INTEGRATION_DATA_DIR || "").trim();
  const configuration = configuredAdapters(options, flags, env);
  const overrides = options.providerPolicyOverrides || {};
  const providerPolicies = Object.freeze(SIGNAL_PROVIDER_POLICIES.map((policy) => {
    const quota = approvedPolicy(policy, env, overrides[policy.id] || {});
    const adapterConfigured = Boolean(configuration.adapters[policy.id]);
    const quotaApproved = quota.dailyCallCap >= quota.callsPerRun && quota.monthlyCallCap >= quota.callsPerRun;
    return Object.freeze({
      ...policy,
      ...quota,
      rolloutRequested: Boolean(flags[policy.flag]),
      adapterConfigured,
      quotaApproved,
      operational: adapterConfigured && quotaApproved,
      reason: !adapterConfigured ? (configuration.reasons[policy.id] || "adapter-required") : !quotaApproved ? "approved-quota-required" : "operational"
    });
  }));
  const policyById = new Map(providerPolicies.map((row) => [row.id, row]));
  const operationalAdapters = Object.freeze(Object.fromEntries(
    Object.entries(configuration.adapters).filter(([id]) => policyById.get(id)?.operational)
  ));
  const repository = createSignalConnectorRepository({ integrationRoot, env, legacyPaths: options.legacyPaths, clock: options.clock, leaseMs: options.leaseMs });
  const service = createSignalConnectorService({
    repository,
    env,
    adapters: operationalAdapters,
    fixtureAdapter: null,
    clock: options.clock,
    retryBaseMs: options.retryBaseMs,
    retryMaximumMs: options.retryMaximumMs
  });
  const pumpStageBudget = Math.max(1, Math.min(20, Number(options.pumpStageBudget || 4)));
  let pumpPromise = null;
  let wakeTimer = null;
  let wakeDueAt = 0;

  async function targetFor(payload = {}) {
    const identity = await freshRepository.getCompany(payload.companyId, { projection: "identity" });
    if (identity?.synthetic !== false || identity?.dataMode !== "live") {
      throw connectorError("실수집된 fresh 업체만 signal 수집 대상이 될 수 있습니다.", "SIGNAL_CONNECTOR_COMPANY_NOT_LIVE", 404);
    }
    const tenants = [...new Set((identity.tenantCompanyIds || []).map((value) => cleanText(value, 160)).filter(Boolean))];
    const requestedTenant = cleanText(payload.tenantCompanyId, 160);
    if (requestedTenant) await freshRepository.getBusinessSafeCompany(identity.companyId, requestedTenant);
    if (!requestedTenant && tenants.length !== 1) {
      throw connectorError("fresh 업체의 단일 tenant ownership을 확정할 수 없습니다.", "SIGNAL_CONNECTOR_TENANT_REQUIRED", 403);
    }
    const tenantCompanyId = requestedTenant || tenants[0];
    const company = await freshRepository.getBusinessSafeCompany(identity.companyId, tenantCompanyId);
    const region = cleanText(company?.region || company?.regionLabel || identity.regions?.[0] || identity.regionLabel, 160);
    if (!region) throw connectorError("fresh 업체의 지역을 확정할 수 없습니다.", "SIGNAL_CONNECTOR_REGION_REQUIRED", 422);
    return { companyId: identity.companyId, tenantCompanyId, region };
  }

  function runtimeNow() {
    const value = typeof options.clock === "function" ? options.clock() : Date.now();
    if (value instanceof Date) return value.getTime();
    const number = Number(value);
    if (Number.isFinite(number)) return number;
    const parsed = Date.parse(String(value || ""));
    return Number.isFinite(parsed) ? parsed : Date.now();
  }

  async function scheduleFollowup() {
    const pending = await repository.listJobs({ statuses: ["queued", "retry-wait"] });
    if (!pending.length) return;
    const now = runtimeNow();
    const dueAt = Math.min(...pending.map((job) => job.status === "queued" || !job.nextAttemptAt
      ? now
      : Date.parse(job.nextAttemptAt)).filter(Number.isFinite));
    const delay = Math.max(0, Math.min(60_000, dueAt - now));
    if (wakeTimer && wakeDueAt <= now + delay) return;
    if (wakeTimer) clearTimeout(wakeTimer);
    wakeDueAt = now + delay;
    wakeTimer = setTimeout(() => {
      wakeTimer = null;
      wakeDueAt = 0;
      void wake();
    }, delay);
    wakeTimer.unref?.();
  }

  function wake() {
    if (wakeTimer) {
      clearTimeout(wakeTimer);
      wakeTimer = null;
      wakeDueAt = 0;
    }
    if (pumpPromise) return pumpPromise;
    pumpPromise = (async () => {
      let processed = 0;
      while (processed < pumpStageBudget) {
        const result = await service.runNext({}, { actor: { type: "worker", id: "stage231-signal-pump", role: "system" } });
        if (!result.claimed) break;
        processed += 1;
      }
      return processed;
    })().finally(async () => {
      pumpPromise = null;
      await scheduleFollowup();
    });
    return pumpPromise;
  }

  async function submit(payload = {}, context = {}) {
    const forged = CLIENT_POLICY_FIELDS.filter((field) => Object.hasOwn(payload, field));
    if (forged.length) throw connectorError("수집 quota, 대상 범위와 signal kind는 서버 정책으로만 결정됩니다.", "SIGNAL_CONNECTOR_POLICY_FIELDS_FORBIDDEN", 400);
    const providerId = cleanText(payload.providerId, 120);
    const policy = policyById.get(providerId);
    if (!policy) throw connectorError("지원하는 signal provider가 아닙니다.", "SIGNAL_CONNECTOR_PROVIDER_NOT_FOUND", 404);
    if (!policy.operational) throw connectorError("승인된 provider adapter와 quota가 필요합니다.", "SIGNAL_CONNECTOR_ADAPTER_REQUIRED", 503);
    const target = await targetFor(payload);
    const result = await service.enqueue({
      clientRequestId: payload.clientRequestId,
      providerId,
      companyId: target.companyId,
      tenantCompanyId: target.tenantCompanyId,
      region: target.region,
      periodMonth: payload.periodMonth,
      signalKinds: [...policy.signalKinds],
      mode: "real",
      callsPerRun: policy.callsPerRun,
      costPerCall: policy.costPerCall,
      dailyCallCap: policy.dailyCallCap,
      monthlyCallCap: policy.monthlyCallCap,
      dailyCostCap: policy.dailyCostCap,
      monthlyCostCap: policy.monthlyCostCap,
      currency: policy.currency,
      maxAttempts: policy.maxAttempts,
      timeoutMs: policy.timeoutMs
    }, context);
    void wake();
    return result;
  }

  async function resume(reference, context = {}) {
    const row = await service.resume(reference, context);
    void wake();
    return row;
  }

  async function liveCompanies() {
    const identities = await freshRepository.listCompanies({ projection: "identity" });
    const rows = [];
    for (const identity of identities) {
      if (identity?.synthetic !== false || identity?.dataMode !== "live") continue;
      const tenants = (identity.tenantCompanyIds || []).filter(Boolean);
      if (tenants.length !== 1) continue;
      const company = await freshRepository.getBusinessSafeCompany(identity.companyId, tenants[0]);
      rows.push({
        companyId: identity.companyId,
        name: cleanText(company?.name || company?.companyName || identity.companyName, 160),
        region: cleanText(company?.region || company?.regionLabel || identity.regions?.[0], 160)
      });
    }
    return rows.sort((left, right) => left.name.localeCompare(right.name, "ko"));
  }

  async function status() {
    const [metrics, quotaRows, jobs, scheduler, diagnostics, companies] = await Promise.all([
      repository.providerMetrics(), repository.quotaUsage(), repository.listJobs(), repository.schedulerStatus(), service.diagnostics(), liveCompanies()
    ]);
    const metricByProvider = new Map(metrics.map((row) => [row.providerId, row]));
    const quotaByProvider = new Map(quotaRows.map((row) => [row.providerId, row]));
    const providers = providerPolicies.map((policy) => ({
      id: policy.id,
      label: policy.label,
      signalKinds: [...policy.signalKinds],
      rolloutRequested: policy.rolloutRequested,
      adapterConfigured: policy.adapterConfigured,
      operational: policy.operational,
      reason: policy.reason,
      state: metricByProvider.get(policy.id)?.killSwitchOpen ? "stopped" : policy.operational ? "operational" : "approval-required",
      freshness: metricByProvider.get(policy.id)?.freshness || "not-collected",
      coverage: Number(metricByProvider.get(policy.id)?.coverage || 0),
      successRate: metricByProvider.get(policy.id)?.successRate ?? null,
      jobs: Number(metricByProvider.get(policy.id)?.jobs || 0),
      completed: Number(metricByProvider.get(policy.id)?.completed || 0),
      failed: Number(metricByProvider.get(policy.id)?.failed || 0),
      quota: quotaByProvider.get(policy.id) || {
        day: new Date().toISOString().slice(0, 10), month: new Date().toISOString().slice(0, 7),
        daily: { calls: 0, cost: 0, callCap: policy.dailyCallCap || null, costCap: policy.dailyCostCap },
        monthly: { calls: 0, cost: 0, callCap: policy.monthlyCallCap || null, costCap: policy.monthlyCostCap },
        currency: "KRW", transportAttempts: 0, externalNetworkCalls: 0
      }
    }));
    return {
      ok: true,
      metadata: { stage: 231, dataBoundary: "fresh-integration-stage231-signal-only", adapterMode: "explicit-official-provider-only", fixtureAvailable: false },
      scheduler: { stopped: Boolean(scheduler.stopped), configured: Boolean(flags.scheduler), operational: false, reason: scheduler.reason || "schedule-target-manifest-required" },
      providers,
      companies,
      jobs: jobs.slice().sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt))).slice(0, 100).map(projectJob),
      diagnostics: {
        activeJobs: Number(diagnostics.activeJobs || 0), configuredAdapterCount: Object.keys(operationalAdapters).length,
        externalNetworkCalls: Number(diagnostics.externalNetworkCalls || diagnostics.store?.externalNetworkCalls || 0),
        credentialReads: configuration.credentialReads, legacyRuntimeReads: Number(diagnostics.store?.legacyRuntimeReads || 0),
        legacyRuntimeCopies: Number(diagnostics.store?.legacyRuntimeCopies || 0), migrationRows: Number(diagnostics.store?.migrationRows || 0),
        backfillRows: Number(diagnostics.store?.backfillRows || 0), dualWriteRows: Number(diagnostics.store?.dualWriteRows || 0)
      }
    };
  }

  const http = createSignalConnectorHttpHandler({
    service, repository, runtime: { submit, resume, wake }, status, projectJob, providerPolicies,
    schedulerConfigured: Boolean(flags.scheduler), authService: authRuntime.service, authHttp: authRuntime.http,
    send: options.send, parseBody: options.parseBody
  });

  async function initialize() {
    await repository.initialize();
    const scheduler = await repository.schedulerStatus();
    if (!scheduler.stopped) await service.stopScheduler({ actor: { type: "system", id: "stage231-startup", role: "system" }, reason: "manual-start-required" });
    const boundary = await service.diagnostics();
    const store = boundary.store || {};
    if (nonZero(boundary.externalNetworkCalls) || nonZero(store.externalNetworkCalls) || nonZero(store.legacyRuntimeReads) || nonZero(store.legacyRuntimeCopies) || nonZero(store.migrationRows) || nonZero(store.backfillRows) || nonZero(store.dualWriteRows)) {
      const error = new Error("Stage 231 signal connector fresh-data/network boundary verification failed");
      error.code = "SIGNAL_CONNECTOR_RUNTIME_BOUNDARY_VIOLATION";
      throw error;
    }
    return { ok: true, status: await status() };
  }

  return Object.freeze({
    repository, service, http, status, initialize, submit, resume, wake,
    async drain() { if (pumpPromise) await pumpPromise; },
    providerPolicies,
    contract: Object.freeze({ stage: 231, dataBoundary: "fresh-integration-stage231-signal-only", adapterMode: "explicit-official-provider-only", legacyRuntimeReads: 0, legacyRuntimeCopies: 0, migrationRows: 0, backfillRows: 0, dualWriteRows: 0 })
  });
}

module.exports = { SIGNAL_PROVIDER_POLICIES, approvedPolicy, configuredAdapters, projectJob, createSignalConnectorRuntime };
