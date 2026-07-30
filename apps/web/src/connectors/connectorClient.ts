import { apiRequest } from "../apiClient";

export type ConnectorProviderState = "approval-required" | "operational" | "stopped";

export interface ConnectorQuotaWindow {
  calls: number;
  cost: number;
  callCap: number | null;
  costCap: number | null;
}

export interface ConnectorProviderStatus {
  id: string;
  label: string;
  signalKinds: readonly string[];
  rolloutRequested: boolean;
  adapterConfigured: boolean;
  operational: boolean;
  state: ConnectorProviderState;
  reason: string;
  freshness: string;
  coverage: number;
  successRate: number | null;
  jobs: number;
  completed: number;
  failed: number;
  quota: {
    day: string;
    month: string;
    daily: ConnectorQuotaWindow;
    monthly: ConnectorQuotaWindow;
    currency: string;
    transportAttempts: number;
    externalNetworkCalls: number;
  };
}

export interface ConnectorJob {
  clientRequestId: string;
  providerId: string;
  mode: string;
  status: string;
  attempts: number;
  maxAttempts: number;
  nextAttemptAt: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  target: { region: string; periodMonth: string; signalKinds: readonly string[] };
  quota: {
    callsPerRun: number;
    dailyCallCap: number;
    monthlyCallCap: number;
    dailyCostCap: number;
    monthlyCostCap: number;
    currency: string;
  };
  error: { category: string; code: string; message: string } | null;
}

export interface ConnectorStatus {
  metadata: { stage: number; dataBoundary: string; adapterMode: string; fixtureAvailable: boolean };
  scheduler: { stopped: boolean; configured: boolean; operational: boolean; reason: string };
  providers: readonly ConnectorProviderStatus[];
  companies: readonly { companyId: string; name: string; region: string }[];
  jobs: readonly ConnectorJob[];
  diagnostics: {
    activeJobs: number;
    configuredAdapterCount: number;
    externalNetworkCalls: number;
    credentialReads: number;
    legacyRuntimeReads: number;
    legacyRuntimeCopies: number;
    migrationRows: number;
    backfillRows: number;
    dualWriteRows: number;
  };
}

const numberValue = (value: unknown): number => Number.isFinite(Number(value)) ? Number(value) : 0;
const optionalNumber = (value: unknown): number | null => value === null || value === undefined || value === "" ? null : numberValue(value);
const textValue = (value: unknown, maximum = 160): string => String(value || "").replace(/[\r\n\t]/g, " ").trim().slice(0, maximum);

function quotaWindow(value: unknown): ConnectorQuotaWindow {
  const row = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return {
    calls: numberValue(row.calls),
    cost: numberValue(row.cost),
    callCap: optionalNumber(row.callCap),
    costCap: optionalNumber(row.costCap)
  };
}

function normalizeProvider(value: unknown): ConnectorProviderStatus {
  const row = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const quota = row.quota && typeof row.quota === "object" ? row.quota as Record<string, unknown> : {};
  return {
    id: textValue(row.id, 80),
    label: textValue(row.label, 80),
    signalKinds: Array.isArray(row.signalKinds) ? row.signalKinds.map((entry) => textValue(entry, 80)).filter(Boolean) : [],
    rolloutRequested: row.rolloutRequested === true,
    adapterConfigured: row.adapterConfigured === true,
    operational: row.operational === true,
    state: row.state === "stopped" ? "stopped" : row.state === "operational" ? "operational" : "approval-required",
    reason: textValue(row.reason, 120),
    freshness: textValue(row.freshness, 40) || "not-collected",
    coverage: numberValue(row.coverage),
    successRate: optionalNumber(row.successRate),
    jobs: numberValue(row.jobs),
    completed: numberValue(row.completed),
    failed: numberValue(row.failed),
    quota: {
      day: textValue(quota.day, 10),
      month: textValue(quota.month, 7),
      daily: quotaWindow(quota.daily),
      monthly: quotaWindow(quota.monthly),
      currency: textValue(quota.currency, 8) || "KRW",
      transportAttempts: numberValue(quota.transportAttempts),
      externalNetworkCalls: numberValue(quota.externalNetworkCalls)
    }
  };
}

function normalizeJob(value: unknown): ConnectorJob {
  const row = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const target = row.target && typeof row.target === "object" ? row.target as Record<string, unknown> : {};
  const quota = row.quota && typeof row.quota === "object" ? row.quota as Record<string, unknown> : {};
  const error = row.error && typeof row.error === "object" ? row.error as Record<string, unknown> : null;
  return {
    clientRequestId: textValue(row.clientRequestId, 128),
    providerId: textValue(row.providerId, 80),
    mode: textValue(row.mode, 20),
    status: textValue(row.status, 32),
    attempts: numberValue(row.attempts),
    maxAttempts: numberValue(row.maxAttempts),
    nextAttemptAt: row.nextAttemptAt ? textValue(row.nextAttemptAt, 40) : null,
    createdAt: textValue(row.createdAt, 40),
    updatedAt: textValue(row.updatedAt, 40),
    completedAt: row.completedAt ? textValue(row.completedAt, 40) : null,
    target: {
      region: textValue(target.region, 120),
      periodMonth: textValue(target.periodMonth, 7),
      signalKinds: Array.isArray(target.signalKinds) ? target.signalKinds.map((entry) => textValue(entry, 80)).filter(Boolean) : []
    },
    quota: {
      callsPerRun: numberValue(quota.callsPerRun),
      dailyCallCap: numberValue(quota.dailyCallCap),
      monthlyCallCap: numberValue(quota.monthlyCallCap),
      dailyCostCap: numberValue(quota.dailyCostCap),
      monthlyCostCap: numberValue(quota.monthlyCostCap),
      currency: textValue(quota.currency, 8) || "KRW"
    },
    error: error ? {
      category: textValue(error.category, 32),
      code: textValue(error.code, 120),
      message: textValue(error.message, 200)
    } : null
  };
}

export function normalizeConnectorStatus(value: unknown): ConnectorStatus {
  const row = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const metadata = row.metadata && typeof row.metadata === "object" ? row.metadata as Record<string, unknown> : {};
  const scheduler = row.scheduler && typeof row.scheduler === "object" ? row.scheduler as Record<string, unknown> : {};
  const diagnostics = row.diagnostics && typeof row.diagnostics === "object" ? row.diagnostics as Record<string, unknown> : {};
  return {
    metadata: {
      stage: numberValue(metadata.stage),
      dataBoundary: textValue(metadata.dataBoundary, 120),
      adapterMode: textValue(metadata.adapterMode, 80),
      fixtureAvailable: metadata.fixtureAvailable === true
    },
    scheduler: {
      stopped: scheduler.stopped !== false,
      configured: scheduler.configured === true,
      operational: scheduler.operational === true,
      reason: textValue(scheduler.reason, 120)
    },
    providers: Array.isArray(row.providers) ? row.providers.map(normalizeProvider).filter((provider) => provider.id) : [],
    companies: Array.isArray(row.companies) ? row.companies.map((value) => {
      const company = value && typeof value === "object" ? value as Record<string, unknown> : {};
      return { companyId: textValue(company.companyId, 160), name: textValue(company.name, 160), region: textValue(company.region, 160) };
    }).filter((company) => company.companyId) : [],
    jobs: Array.isArray(row.jobs) ? row.jobs.map(normalizeJob).filter((job) => job.clientRequestId) : [],
    diagnostics: {
      activeJobs: numberValue(diagnostics.activeJobs),
      configuredAdapterCount: numberValue(diagnostics.configuredAdapterCount),
      externalNetworkCalls: numberValue(diagnostics.externalNetworkCalls),
      credentialReads: numberValue(diagnostics.credentialReads),
      legacyRuntimeReads: numberValue(diagnostics.legacyRuntimeReads),
      legacyRuntimeCopies: numberValue(diagnostics.legacyRuntimeCopies),
      migrationRows: numberValue(diagnostics.migrationRows),
      backfillRows: numberValue(diagnostics.backfillRows),
      dualWriteRows: numberValue(diagnostics.dualWriteRows)
    }
  };
}

export async function readConnectorStatus(signal?: AbortSignal): Promise<ConnectorStatus> {
  return normalizeConnectorStatus(await apiRequest("/api/integration/connectors/status", { signal, cache: "no-store" }));
}

export function connectorJobPayload(input: {
  clientRequestId: string;
  providerId: string;
  companyId: string;
  periodMonth: string;
}): { clientRequestId: string; providerId: string; companyId: string; periodMonth: string } {
  return {
    clientRequestId: textValue(input.clientRequestId, 128),
    providerId: textValue(input.providerId, 80),
    companyId: textValue(input.companyId, 160),
    periodMonth: textValue(input.periodMonth, 7)
  };
}

export function createConnectorJob(input: {
  clientRequestId: string;
  providerId: string;
  companyId: string;
  periodMonth: string;
}): Promise<unknown> {
  return apiRequest("/api/integration/connectors/jobs", {
    method: "POST",
    body: JSON.stringify(connectorJobPayload(input))
  });
}

function mutate(path: string): Promise<unknown> {
  return apiRequest(path, { method: "POST", body: JSON.stringify({ reason: "manual-admin-control" }) });
}

export function stopConnectorProvider(providerId: string): Promise<unknown> {
  return mutate(`/api/integration/connectors/providers/${encodeURIComponent(providerId)}/stop`);
}

export function resumeConnectorProvider(providerId: string): Promise<unknown> {
  return mutate(`/api/integration/connectors/providers/${encodeURIComponent(providerId)}/resume`);
}

export function cancelConnectorJob(clientRequestId: string): Promise<unknown> {
  return mutate(`/api/integration/connectors/jobs/${encodeURIComponent(clientRequestId)}/cancel`);
}

export function resumeConnectorJob(clientRequestId: string): Promise<unknown> {
  return mutate(`/api/integration/connectors/jobs/${encodeURIComponent(clientRequestId)}/resume`);
}

export function stopConnectorScheduler(): Promise<unknown> {
  return mutate("/api/integration/connectors/scheduler/stop");
}

export function enableConnectorScheduler(): Promise<unknown> {
  return mutate("/api/integration/connectors/scheduler/enable");
}
