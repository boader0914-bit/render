import { ApiError, apiRequest } from "../apiClient";

export type CoreWorkspaceState = "empty" | "ready" | "partial";
export type CoreJobKind = "business-search" | "business-my-lodge" | "admin-collection";
export type CoreJobStatus = "queued" | "running" | "completed" | "cancelled" | "failed";
export type CoreTone = "neutral" | "success" | "warning" | "info";

export interface CoreMetadata {
  stage: 227 | 228;
  provisional: boolean;
  dataBoundary: "fresh-only" | "fresh-integration-only";
  source: "empty" | "synthetic-fresh-collection" | "synthetic-fresh-integration";
}

export interface CoreMetric {
  id: string;
  label: string;
  value: string;
  detail: string;
  tone: CoreTone;
}

export interface Stage228CompanyDetailPayload {
  state?: "ready" | "partial";
  completeness?: { state?: string; displayValue?: string; detail?: string; verifiedFields?: number; totalFields?: number; missingFields?: readonly string[] };
  freshness?: { state?: string; displayValue?: string; detail?: string; observedAt?: string; validUntil?: string };
  confidence?: { state?: string; displayValue?: string; detail?: string; basis?: string };
  provenance?: { summary?: string; sourceCount?: number; lastVerifiedAt?: string };
  verifiedValues?: ReadonlyArray<{ field?: string; label?: string; value?: string | number; verified?: boolean; verifiedAt?: string }>;
  changes?: ReadonlyArray<{ changeId?: string; fieldLabel?: string; previousValue?: string | number; currentValue?: string | number; changedAt?: string }>;
  enrichment?: { state?: string; ctaLabel?: string; detail?: string; missingFields?: readonly string[] };
  observations?: { displayCount?: string | number; repeatCount?: number; firstObservedAt?: string; lastObservedAt?: string; summary?: string };
}

export interface CoreCompanyDetailMetric {
  state: string;
  displayValue: string;
  detail: string;
}

export interface CoreCompanyFreshDetail {
  state: "ready" | "partial" | "empty";
  completeness: CoreCompanyDetailMetric & { verifiedFields: string; totalFields: string; missingFields: readonly string[] };
  freshness: CoreCompanyDetailMetric & { observedAt: string; validUntil: string };
  confidence: CoreCompanyDetailMetric & { basis: string };
  provenance: { summary: string; sourceCount: string; lastVerifiedAt: string };
  verifiedValues: ReadonlyArray<{ field: string; label: string; value: string; verifiedAt: string }>;
  changes: ReadonlyArray<{ changeId: string; fieldLabel: string; previousValue: string; currentValue: string; changedAt: string }>;
  enrichment: { state: string; ctaLabel: string; detail: string; missingFields: readonly string[] };
  observations: { displayCount: string; repeatCount: string; firstObservedAt: string; lastObservedAt: string; summary: string };
}

export interface CoreCompany {
  companyId: string;
  name: string;
  region: string;
  status: string;
  observationCount?: string;
  freshnessLabel?: string;
  dataQuality?: string;
  missingFields?: readonly string[];
  isInterested?: boolean;
  fields?: ReadonlyArray<{ label: string; value: string }>;
  freshDetail?: CoreCompanyFreshDetail | null;
}

export interface CoreJob {
  clientRequestId: string;
  kind: CoreJobKind;
  status: CoreJobStatus;
  progress: number;
  progressLabel: string;
  etaLabel: string;
  requestedAt: string;
  updatedAt: string;
  query?: string;
  companyId?: string;
  resultCount?: string;
  resultValues: readonly CoreResultValue[];
  message?: string;
}

export interface CoreHistoryItem {
  id: string;
  label: string;
  detail: string;
  occurredAt: string;
  status: string;
  clientRequestId?: string;
  resultValues: readonly CoreResultValue[];
}

export interface CoreResultValue {
  id: string;
  label: string;
  value: string;
}

export interface CoreInterest {
  companyId: string;
  name: string;
  region: string;
  addedAt: string;
}

export interface CoreRequestItem {
  clientRequestId: string;
  label: string;
  status: string;
  requestedAt: string;
  detail?: string;
}

export interface CoreConnectorStatus {
  id: string;
  label: string;
  status: "ready" | "approval-required" | "disabled" | "error";
  detail: string;
  configured: boolean;
}

export interface CoreWorkspace extends CoreMetadata {
  state: CoreWorkspaceState;
  view: string;
  tenantCompanyId: string;
  tenantCompanyName: string;
  metrics: readonly CoreMetric[];
  companies: readonly CoreCompany[];
  jobs: readonly CoreJob[];
  history: readonly CoreHistoryItem[];
  interests: readonly CoreInterest[];
  locationCardRequests: readonly CoreRequestItem[];
  tourismRequests: readonly CoreRequestItem[];
  connectors: readonly CoreConnectorStatus[];
  notices: readonly string[];
}

type UnknownRecord = Record<string, unknown>;

const record = (value: unknown): UnknownRecord => value && typeof value === "object" ? value as UnknownRecord : {};
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const text = (value: unknown, fallback = ""): string => typeof value === "string" || typeof value === "number" ? String(value) : fallback;
const bool = (value: unknown): boolean => value === true;
const boundedProgress = (value: unknown): number => Math.max(0, Math.min(100, Number(value) || 0));
const RAW_PATH_PATTERN = /(?:[A-Za-z]:[\\/]|\\\\[^\\]|file:\/\/|\/(?:var|home|Users|tmp|outputs|customer_db|company_master|tourism_data)(?:[\\/]|$)|(?:^|[\s"'(])(?:outputs|customer_db|company_master|tourism_data)[\\/])/i;
const SENSITIVE_DETAIL_KEY = /(?:raw|path|sourceurl|evidenceid|token|secret)/i;

export function businessSafeDisplayText(value: unknown, fallback = ""): string {
  const candidate = text(value).trim();
  return candidate && !RAW_PATH_PATTERN.test(candidate) ? candidate : fallback;
}

function businessSafeProvenanceText(value: unknown, fallback: string): string {
  const candidate = businessSafeDisplayText(value);
  return candidate && !/(?:https?:\/\/|sourceUrl|evidenceId)/i.test(candidate) ? candidate : fallback;
}

function safeList(value: unknown): string[] {
  return list(value).map((item) => businessSafeDisplayText(item)).filter(Boolean);
}

function detailMetric(value: unknown): CoreCompanyDetailMetric {
  const metric = record(value);
  return {
    state: businessSafeDisplayText(metric.state, "unknown"),
    displayValue: businessSafeDisplayText(metric.displayValue, "확인 중"),
    detail: businessSafeDisplayText(metric.detail, "공개 가능한 요약이 아직 없습니다.")
  };
}

export function normalizeStage228CompanyDetail(value: unknown): CoreCompanyFreshDetail | null {
  const detail = record(value);
  if (!Object.keys(detail).length) return null;
  const completeness = record(detail.completeness);
  const freshness = record(detail.freshness);
  const confidence = record(detail.confidence);
  const provenance = record(detail.provenance);
  const enrichment = record(detail.enrichment);
  const observations = record(detail.observations);
  const observationDisplayCount = businessSafeDisplayText(observations.displayCount, "0회");
  const verifiedValues = list(detail.verifiedValues).map((value) => {
    const item = record(value);
    return {
      field: businessSafeDisplayText(item.field),
      label: businessSafeDisplayText(item.label),
      value: businessSafeDisplayText(item.value),
      verifiedAt: businessSafeDisplayText(item.verifiedAt),
      verified: item.verified === true
    };
  }).filter((item) => item.verified && item.field && item.label && item.value && !SENSITIVE_DETAIL_KEY.test(item.field)).map(({ verified: _verified, ...item }) => item);
  const changes = list(detail.changes).map((value, index) => {
    const item = record(value);
    return {
      changeId: businessSafeDisplayText(item.changeId, `change-${index}`),
      fieldLabel: businessSafeDisplayText(item.fieldLabel),
      previousValue: businessSafeDisplayText(item.previousValue, "공개되지 않음"),
      currentValue: businessSafeDisplayText(item.currentValue, "공개되지 않음"),
      changedAt: businessSafeDisplayText(item.changedAt)
    };
  }).filter((item) => item.fieldLabel && item.changedAt && !SENSITIVE_DETAIL_KEY.test(item.fieldLabel));
  const detailState = businessSafeDisplayText(detail.state);
  return {
    state: detailState === "ready" ? "ready" : detailState === "empty" ? "empty" : "partial",
    completeness: {
      ...detailMetric(completeness),
      verifiedFields: businessSafeDisplayText(completeness.verifiedFields),
      totalFields: businessSafeDisplayText(completeness.totalFields),
      missingFields: safeList(completeness.missingFields)
    },
    freshness: {
      ...detailMetric(freshness),
      observedAt: businessSafeDisplayText(freshness.observedAt),
      validUntil: businessSafeDisplayText(freshness.validUntil)
    },
    confidence: {
      ...detailMetric(confidence),
      basis: businessSafeDisplayText(confidence.basis, "검증 근거 요약 없음")
    },
    provenance: {
      summary: businessSafeProvenanceText(provenance.summary, "공개 가능한 출처 요약이 없습니다."),
      sourceCount: businessSafeDisplayText(provenance.sourceCount),
      lastVerifiedAt: businessSafeDisplayText(provenance.lastVerifiedAt)
    },
    verifiedValues,
    changes,
    enrichment: {
      state: businessSafeDisplayText(enrichment.state, "unavailable"),
      ctaLabel: businessSafeDisplayText(enrichment.ctaLabel, "신규 수집으로 보강하기"),
      detail: businessSafeDisplayText(enrichment.detail, "누락 항목은 승인된 신규 수집으로만 보강합니다."),
      missingFields: safeList(enrichment.missingFields)
    },
    observations: {
      displayCount: typeof observations.displayCount === "number" ? `${observationDisplayCount}회` : observationDisplayCount,
      repeatCount: businessSafeDisplayText(observations.repeatCount, "0"),
      firstObservedAt: businessSafeDisplayText(observations.firstObservedAt),
      lastObservedAt: businessSafeDisplayText(observations.lastObservedAt),
      summary: businessSafeDisplayText(observations.summary, "반복 관측 요약이 아직 없습니다.")
    }
  };
}

function normalizeStage228BusinessSafeProjection(value: UnknownRecord): CoreCompanyFreshDetail | null {
  const dataQuality = record(value.dataQuality);
  if (businessSafeDisplayText(value.projection) !== "business-safe" && !Object.keys(dataQuality).length) return null;
  const collection = record(value.collection);
  const verification = record(value.verification);
  const completeness = record(dataQuality.dataCompleteness);
  const freshness = record(dataQuality.freshness);
  const confidence = record(dataQuality.confidence);
  const enrichment = record(dataQuality.enrichmentCta);
  const completenessScore = businessSafeDisplayText(completeness.score);
  const confidenceScore = businessSafeDisplayText(confidence.score);
  const ageHours = businessSafeDisplayText(freshness.ageHours);
  const observationCount = businessSafeDisplayText(collection.observationCount, "0");
  const modes = safeList(collection.modes);
  return normalizeStage228CompanyDetail({
    state: "partial",
    completeness: {
      state: "reported",
      displayValue: completenessScore ? `${completenessScore}%` : "확인 중",
      detail: modes.length ? `수집 모드: ${modes.join(", ")}` : "수집 모드 확인 중",
      missingFields: safeList(completeness.missingModes)
    },
    freshness: {
      state: businessSafeDisplayText(freshness.state, "unknown"),
      displayValue: businessSafeDisplayText(freshness.state, "확인 중"),
      detail: ageHours ? `최근 관측 후 ${ageHours}시간` : "최근 관측 시각 확인 중",
      observedAt: businessSafeDisplayText(freshness.latestObservedAt)
    },
    confidence: {
      state: businessSafeDisplayText(confidence.level, "unknown"),
      displayValue: confidenceScore || businessSafeDisplayText(confidence.level, "확인 중"),
      detail: businessSafeDisplayText(verification.status, "검증 대기"),
      basis: businessSafeDisplayText(verification.reviewedAt, "검증 근거 요약 대기")
    },
    provenance: {
      summary: businessSafeDisplayText(value.sourceBoundary) === "fresh-integration-only"
        ? "fresh integration store에서 생성된 business-safe 요약"
        : "공개 가능한 출처 요약이 없습니다.",
      lastVerifiedAt: businessSafeDisplayText(verification.reviewedAt)
    },
    verifiedValues: [],
    changes: [],
    enrichment: {
      state: enrichment.required === true ? "recommended" : "complete",
      ctaLabel: businessSafeDisplayText(enrichment.label, "신규 수집으로 보강하기"),
      detail: businessSafeDisplayText(enrichment.action, "승인된 신규 수집으로만 보강합니다."),
      missingFields: safeList(completeness.missingModes)
    },
    observations: {
      displayCount: `${observationCount}회`,
      repeatCount: businessSafeDisplayText(collection.repeatCount, "0"),
      firstObservedAt: businessSafeDisplayText(collection.firstObservedAt),
      lastObservedAt: businessSafeDisplayText(collection.lastObservedAt),
      summary: modes.length
        ? `${observationCount}회 관측에서 ${modes.join(", ")} 수집 모드를 확인했습니다.`
        : "반복 관측 요약이 아직 없습니다."
    }
  });
}

function normalizeResultValues(value: unknown): CoreResultValue[] {
  const summary = record(value);
  const fields: ReadonlyArray<[string, string]> = [
    ["exposureSampleCount", "노출 표본"],
    ["companyCount", "업체 수"],
    ["revenueSampleCount", "매출 표본"],
    ["averageRevenue", "평균 매출"],
    ["soldOutRate", "매진율"]
  ];
  return fields.filter(([id]) => summary[id] !== undefined && summary[id] !== null).map(([id, label]) => ({ id, label, value: text(summary[id]) }));
}

function normalizeStatus(value: unknown): CoreJobStatus {
  const status = text(value).toLowerCase();
  if (["queued", "running", "completed", "cancelled", "failed"].includes(status)) return status as CoreJobStatus;
  if (status === "done" || status === "success") return "completed";
  if (status === "canceled") return "cancelled";
  return "queued";
}

function normalizeJob(value: unknown): CoreJob {
  const item = record(value);
  const progress = boundedProgress(item.progress ?? item.progressPercent);
  const remainingSeconds = Number(item.remainingSeconds ?? item.etaSeconds);
  const resultSummary = record(item.resultSummary);
  return {
    clientRequestId: text(item.clientRequestId ?? item.id),
    kind: text(item.kind, "business-search") as CoreJobKind,
    status: normalizeStatus(item.status),
    progress,
    progressLabel: text(item.progressLabel, `${progress}%`),
    etaLabel: text(item.etaLabel, Number.isFinite(remainingSeconds) && remainingSeconds >= 0 ? `${remainingSeconds}초` : text(item.estimatedCompleteAt, "산정 중")),
    requestedAt: text(item.requestedAt ?? item.createdAt),
    updatedAt: text(item.updatedAt ?? item.completedAt ?? item.cancelledAt ?? item.createdAt),
    query: text(item.query ?? item.keyword) || undefined,
    companyId: text(item.companyId ?? item.tenantCompanyId) || undefined,
    resultCount: text(item.resultCount ?? resultSummary.companyCount) || undefined,
    resultValues: normalizeResultValues(resultSummary),
    message: text(item.message ?? item.currentStage) || undefined
  };
}

function normalizeMetric(value: unknown, index: number): CoreMetric {
  const item = record(value);
  const tone = text(item.tone, "neutral");
  return {
    id: text(item.id, `metric-${index}`),
    label: text(item.label, "지표"),
    value: text(item.value, "0"),
    detail: text(item.detail, "신규 수집 기준"),
    tone: (["neutral", "success", "warning", "info"].includes(tone) ? tone : "neutral") as CoreTone
  };
}

function normalizeCompany(value: unknown): CoreCompany {
  const item = record(value);
  const businessValues = record(item.businessValues);
  const explicitDetail = item.freshDetail ?? item.businessSafeDetail ?? item.detail;
  const detailEnvelope = record(explicitDetail);
  const projectionHasDetail = ["completeness", "freshness", "confidence", "provenance", "verifiedValues", "changes", "enrichment", "observations"]
    .some((key) => item[key] !== undefined);
  const normalizedFreshDetail = normalizeStage228CompanyDetail(explicitDetail)
    || (projectionHasDetail ? normalizeStage228CompanyDetail(item) : null)
    || normalizeStage228BusinessSafeProjection(item);
  const topLevelMissingFields = list(item.missingFields).map((field) => text(field)).filter(Boolean);
  const businessFields = [
    ["네이버 순위", businessValues.naverRank],
    ["평균 가격", businessValues.averagePrice],
    ["주간 매출", businessValues.weeklyRevenue],
    ["매진율", businessValues.soldOutRate],
    ["리뷰 수", businessValues.reviewCount]
  ].filter((entry) => entry[1] !== undefined && entry[1] !== null).map(([label, value]) => ({ label: String(label), value: String(value) }));
  return {
    companyId: text(item.companyId ?? item.id ?? detailEnvelope.companyId),
    name: text(item.name ?? item.companyName ?? detailEnvelope.name, "이름 없음"),
    region: text(item.region ?? item.regionLabel ?? item.address ?? detailEnvelope.region, "지역 미확인"),
    status: text(item.status ?? detailEnvelope.state, "수집 전"),
    observationCount: text(item.observationCount) || text(item.observations) || text(record(detailEnvelope.observations).displayCount) || undefined,
    freshnessLabel: text(item.freshnessLabel) || text(item.freshness) || text(item.freshAt) || text(record(detailEnvelope.freshness).displayValue) || undefined,
    dataQuality: text(item.dataQuality) || text(detailEnvelope.state) || undefined,
    missingFields: topLevelMissingFields.length ? topLevelMissingFields : normalizedFreshDetail?.completeness.missingFields || [],
    isInterested: bool(item.isInterested),
    fields: [...list(item.fields).map((field) => {
      const entry = record(field);
      return { label: text(entry.label), value: text(entry.value) };
    }).filter((field) => field.label && field.value), ...businessFields],
    freshDetail: normalizedFreshDetail
  };
}

function normalizeHistory(value: unknown, index: number): CoreHistoryItem {
  const item = record(value);
  return {
    id: text(item.id, `history-${index}`),
    label: text(item.label ?? item.runLabel ?? item.query ?? item.keyword ?? item.kind, "신규 수집 요청"),
    detail: text(item.detail ?? item.message ?? item.regionLabel, "통합 store 신규 이력"),
    occurredAt: text(item.occurredAt ?? item.requestedAt ?? item.createdAt),
    status: text(item.status, "대기"),
    clientRequestId: text(item.clientRequestId) || undefined,
    resultValues: normalizeResultValues(item.resultSummary)
  };
}

function normalizeInterest(value: unknown): CoreInterest {
  const item = record(value);
  const company = record(item.company);
  return {
    companyId: text(item.companyId ?? item.id ?? company.companyId),
    name: text(item.name ?? item.companyName ?? company.companyName ?? company.name, "이름 없음"),
    region: text(item.region ?? item.regionLabel ?? item.address ?? company.regionLabel ?? company.region, "지역 미확인"),
    addedAt: text(item.addedAt ?? item.createdAt)
  };
}

function normalizeRequest(value: unknown, index: number): CoreRequestItem {
  const item = record(value);
  return {
    clientRequestId: text(item.clientRequestId ?? item.id, `request-${index}`),
    label: text(item.label ?? item.companyName ?? item.regionCode ?? item.companyId, "신규 요청"),
    status: text(item.status, "대기"),
    requestedAt: text(item.requestedAt ?? item.createdAt),
    detail: text(item.detail ?? item.message) || undefined
  };
}

function normalizeConnector(value: unknown, index: number): CoreConnectorStatus {
  const item = record(value);
  const rawStatus = text(item.status ?? item.state, bool(item.configured) ? "ready" : "disabled");
  const status = (rawStatus === "ready" || rawStatus === "verified" || rawStatus === "fixture-ready"
    ? "ready"
    : rawStatus === "error" ? "error" : rawStatus === "approval-required" ? "approval-required" : "disabled") as CoreConnectorStatus["status"];
  return {
    id: text(item.id ?? item.provider, `connector-${index}`),
    label: text(item.label ?? item.provider, "Connector"),
    status,
    detail: text(item.detail, `server 상태: ${rawStatus}`),
    configured: bool(item.configured)
  };
}

/**
 * Stage 227 compatibility boundary. It renames transport fields only and never
 * recomputes V2 business values; displayed numbers stay server-authored.
 */
export function normalizeCoreWorkspace(value: unknown, requestedView: string): CoreWorkspace {
  const envelope = record(value);
  const data = Object.keys(record(envelope.workspace)).length
    ? record(envelope.workspace)
    : Object.keys(record(envelope.data)).length ? record(envelope.data) : envelope;
  const metadata = { ...envelope, ...record(envelope.metadata), ...record(data.metadata) };
  const rawSource = text(metadata.source);
  const source: CoreMetadata["source"] = rawSource === "synthetic-fresh-integration"
    ? "synthetic-fresh-integration"
    : rawSource === "synthetic-fresh-collection" ? "synthetic-fresh-collection" : "empty";
  const stateEnvelope = record(data.state);
  const explicitState = text(stateEnvelope.kind ?? data.state ?? metadata.state);
  const metricEnvelope = record(data.metrics);
  const metricLabels: ReadonlyArray<[string, string, CoreTone]> = [
    ["companyCount", "신규 업체", "info"],
    ["freshCompanyCount", "fresh 업체", "success"],
    ["activeJobCount", "진행 중 run", "warning"],
    ["completedJobCount", "완료 run", "success"],
    ["interestCount", "관심 숙소", "info"],
    ["locationCardRequestCount", "입지카드 요청", "neutral"],
    ["tourismRequestCount", "관광 요청", "neutral"]
  ];
  const metrics = Array.isArray(data.metrics)
    ? list(data.metrics).map(normalizeMetric)
    : metricLabels.filter(([key]) => metricEnvelope[key] !== undefined).map(([key, label, tone]) => ({
      id: key,
      label,
      value: text(metricEnvelope[key], "0"),
      detail: "server 제공 신규 수집 값",
      tone
    }));
  const connectorEnvelope = record(data.connectors ?? data.connectorStatus);
  const connectors = Array.isArray(data.connectors ?? data.connectorStatus)
    ? list(data.connectors ?? data.connectorStatus).map(normalizeConnector)
    : Object.entries(connectorEnvelope).map(([id, connector], index) => normalizeConnector({ ...record(connector), id, label: id.toUpperCase() }, index));
  const tenant = record(data.tenant);
  const state: CoreWorkspaceState = explicitState === "partial"
    ? "partial"
    : explicitState === "ready" || source !== "empty" ? "ready" : "empty";
  return {
    stage: Number(metadata.stage) === 228 ? 228 : 227,
    provisional: metadata.provisional !== false,
    dataBoundary: text(metadata.dataBoundary) === "fresh-integration-only" ? "fresh-integration-only" : "fresh-only",
    source,
    state,
    view: text(data.view ?? metadata.view, requestedView),
    tenantCompanyId: text(tenant.companyId),
    tenantCompanyName: text(tenant.companyName),
    metrics,
    companies: list(data.companies).map(normalizeCompany).filter((item) => item.companyId),
    jobs: list(data.jobs ?? data.runs).map(normalizeJob).filter((item) => item.clientRequestId),
    history: list(data.history ?? data.searchHistory).map(normalizeHistory),
    interests: list(data.interests).map(normalizeInterest).filter((item) => item.companyId),
    locationCardRequests: list(data.locationCardRequests).map(normalizeRequest),
    tourismRequests: list(data.tourismRequests).map(normalizeRequest),
    connectors,
    notices: [explicitState === "partial" ? text(stateEnvelope.message) : "", ...list(data.notices ?? data.warnings).map((item) => text(item))].filter(Boolean)
  };
}

function normalizeJobEnvelope(value: unknown): CoreJob {
  const payload = record(value);
  return normalizeJob(payload.job ?? payload.data ?? payload);
}

export async function readCoreWorkspace(view: string, signal?: AbortSignal): Promise<CoreWorkspace> {
  const payload = await apiRequest<unknown>(`/api/integration/core/workspace?view=${encodeURIComponent(view)}`, { signal, cache: "no-store" });
  return normalizeCoreWorkspace(payload, view);
}

export async function createCoreJob(input: {
  clientRequestId: string;
  kind: CoreJobKind;
  keyword?: string;
  companyId?: string;
}): Promise<CoreJob> {
  return normalizeJobEnvelope(await apiRequest<unknown>("/api/integration/core/jobs", {
    method: "POST",
    body: JSON.stringify({
      clientRequestId: input.clientRequestId,
      kind: input.kind,
      ...(input.keyword ? { keyword: input.keyword } : {}),
      ...(input.companyId ? { tenantCompanyId: input.companyId } : {})
    })
  }));
}

export async function readCoreJob(clientRequestId: string, signal?: AbortSignal): Promise<CoreJob> {
  return normalizeJobEnvelope(await apiRequest<unknown>(`/api/integration/core/jobs/${encodeURIComponent(clientRequestId)}`, { signal, cache: "no-store" }));
}

export async function cancelCoreJob(clientRequestId: string): Promise<CoreJob> {
  return normalizeJobEnvelope(await apiRequest<unknown>(`/api/integration/core/jobs/${encodeURIComponent(clientRequestId)}/cancel`, {
    method: "POST",
    body: JSON.stringify({ clientRequestId })
  }));
}

export async function addCoreInterest(companyId: string): Promise<void> {
  await apiRequest("/api/integration/core/interests", { method: "POST", body: JSON.stringify({ companyId }) });
}

export async function removeCoreInterest(companyId: string): Promise<void> {
  await apiRequest(`/api/integration/core/interests/${encodeURIComponent(companyId)}`, { method: "DELETE" });
}

export async function requestLocationCard(clientRequestId: string, companyId: string): Promise<void> {
  await apiRequest("/api/integration/core/location-card-requests", {
    method: "POST",
    body: JSON.stringify({ clientRequestId, companyId })
  });
}

export async function requestTourismCollection(clientRequestId: string, regionCode?: string): Promise<void> {
  await apiRequest("/api/integration/core/admin/tourism-requests", {
    method: "POST",
    body: JSON.stringify({ clientRequestId, ...(regionCode ? { regionCode } : {}) })
  });
}

export function coreFailureState(reason: unknown): "permission" | "unavailable" | "error" {
  if (reason instanceof ApiError && reason.status === 403) return "permission";
  if (reason instanceof ApiError && (reason.status === 404 || reason.status === 503)) return "unavailable";
  return "error";
}

export function newClientRequestId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `stage227-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function recoveredJobId(kind: CoreJobKind): string {
  if (typeof sessionStorage === "undefined") return "";
  return sessionStorage.getItem(`lodging-v2-stage227-job:${kind}`) || "";
}

export function rememberJobId(kind: CoreJobKind, clientRequestId: string): void {
  if (typeof sessionStorage === "undefined") return;
  sessionStorage.setItem(`lodging-v2-stage227-job:${kind}`, clientRequestId);
}

export function forgetJobId(kind: CoreJobKind): void {
  if (typeof sessionStorage === "undefined") return;
  sessionStorage.removeItem(`lodging-v2-stage227-job:${kind}`);
}
