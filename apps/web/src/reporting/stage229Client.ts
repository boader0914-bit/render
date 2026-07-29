import { ApiError, apiRequest } from "../apiClient";

export const STAGE229_ROUTE_IDS = Object.freeze([
  "business-report",
  "business-location",
  "admin-location"
] as const);

export type Stage229RouteId = typeof STAGE229_ROUTE_IDS[number];
export type InsightState = "not-collected" | "collecting" | "insufficient-data" | "not-published" | "ready";
export type LocationCardLifecycle = "requested" | "draft" | "in-review" | "changes-requested" | "reviewed" | "published";
export type InsightTone = "neutral" | "success" | "warning" | "info";
export type LocationCardAction = "request" | "edit-draft" | "submit-review" | "approve-review" | "request-changes" | "publish";
export type LocationScoreId = "tourism" | "industry" | "living-area" | "accessibility" | "interest" | "ota" | "leadtime";
export type ReportScopeId = "national" | "regional" | "own" | "anonymous-cohort";

export interface InsightMetric {
  id: string;
  label: string;
  value: string;
  detail: string;
  tone: InsightTone;
}

export interface InsightCta {
  label: string;
  path: "/app/activity" | "/app/location" | "/admin/collection";
}

export interface InsightReadiness {
  state: InsightState;
  label: string;
  detail: string;
  sampleCount: number | null;
  minimumSampleCount: number | null;
  missingReasons: readonly string[];
  freshnessLabel: string;
  confidenceLabel: string;
  confidenceCauses: readonly string[];
  inputFrom: string;
  inputTo: string;
  nextCollectionCta: InsightCta | null;
}

export interface LocationScore {
  id: LocationScoreId;
  label: string;
  displayValue: string;
  detail: string;
  state: InsightState;
}

export interface ForecastInterval {
  displayValue: string;
  low: string;
  high: string;
  unit: string;
}

export interface InsightForecast {
  state: InsightState;
  label: string;
  summary: string;
  asOfDate: string;
  inputFrom: string;
  inputTo: string;
  sampleCount: number | null;
  minimumSampleCount: number | null;
  confidenceLabel: string;
  confidenceCauses: readonly string[];
  insufficientReasons: readonly string[];
  interval: ForecastInterval | null;
  bookingPace: { displayValue: string; detail: string } | null;
}

export interface LocationCardView {
  cardId: string;
  version: number;
  lifecycle: LocationCardLifecycle;
  title: string;
  companyName: string;
  regionLabel: string;
  summary: string;
  algorithmVersion: string;
  evidenceSummary: string;
  updatedAt: string;
  publishedAt: string;
  freshnessLabel: string;
  confidenceLabel: string;
  confidenceCauses: readonly string[];
  scores: readonly LocationScore[];
  forecast: InsightForecast | null;
  allowedActions: readonly LocationCardAction[];
}

export interface ReportScopeView {
  id: ReportScopeId;
  label: string;
  displayValue: string;
  detail: string;
  state: InsightState;
}

export interface MonthlyReportView {
  state: InsightState;
  month: string;
  title: string;
  summary: string;
  publishedAt: string;
  algorithmVersion: string;
  locationCardPath: "/app/location";
  scopes: readonly ReportScopeView[];
  cohort: {
    label: string;
    summary: string;
    sampleCount: number | null;
    minimumSampleCount: number | null;
  };
  forecast: InsightForecast;
}

export interface InsightAuditItem {
  id: string;
  action: string;
  label: string;
  detail: string;
  occurredAt: string;
}

export interface InsightSubject {
  companyId: string;
  companyName: string;
  regionLabel: string;
}

export interface Stage229Workspace {
  stage: 229;
  routeId: Stage229RouteId;
  state: InsightState;
  algorithmVersion: string;
  generatedAt: string;
  dataBoundary: "fresh-integration-only";
  projection: "business-safe";
  subject: InsightSubject;
  subjects: readonly InsightSubject[];
  readiness: InsightReadiness;
  metrics: readonly InsightMetric[];
  locationCard: LocationCardView | null;
  monthlyReport: MonthlyReportView | null;
  allowedActions: readonly LocationCardAction[];
  audit: readonly InsightAuditItem[];
  notices: readonly string[];
}

export interface InsightMutationResult {
  ok: boolean;
  cardId: string;
  lifecycle: LocationCardLifecycle;
}

type UnknownRecord = Record<string, unknown>;

const SCORE_LABELS: Readonly<Record<LocationScoreId, string>> = Object.freeze({
  tourism: "관광",
  industry: "산업",
  "living-area": "생활권",
  accessibility: "접근성",
  interest: "관심도",
  ota: "OTA",
  leadtime: "리드타임"
});
const REPORT_SCOPE_LABELS: Readonly<Record<ReportScopeId, string>> = Object.freeze({
  national: "전국",
  regional: "지역",
  own: "내 숙소",
  "anonymous-cohort": "익명 비교군"
});
const SAFE_CTA_PATHS = new Set<InsightCta["path"]>(["/app/activity", "/app/location", "/admin/collection"]);
const RAW_PATH_PATTERN = /(?:[A-Za-z]:[\\/]|\\\\[^\\]|file:\/\/|\/(?:var|home|Users|tmp|outputs|customer_db|company_master|tourism_data)(?:[\\/]|$)|(?:^|[\s"'(])(?:outputs|customer_db|company_master|tourism_data)[\\/])/i;
const SENSITIVE_TEXT_PATTERN = /(?:source\s*key|sourceKey|evidence\s*id|evidenceId|raw\s*(?:output|payload|path)|internal\s*(?:formula|error|path)|peer\s*company|other\s*company\s*id)/i;
const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,159}$/;

const record = (value: unknown): UnknownRecord => value && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : {};
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];

export function safeInsightText(value: unknown, fallback = ""): string {
  const candidate = typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
  if (!candidate || RAW_PATH_PATTERN.test(candidate) || /https?:\/\//i.test(candidate) || SENSITIVE_TEXT_PATTERN.test(candidate)) return fallback;
  return candidate;
}

function safeId(value: unknown): string {
  const candidate = safeInsightText(value);
  return SAFE_ID_PATTERN.test(candidate) ? candidate : "";
}

function optionalNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : null;
}

function safeTextList(value: unknown): string[] {
  return list(value).map((item) => safeInsightText(item)).filter(Boolean);
}

export function normalizeInsightState(value: unknown): InsightState {
  const candidate = safeInsightText(record(value).kind ?? record(value).state ?? value).toLowerCase().replaceAll("_", "-");
  if (["collecting", "in-progress", "running", "queued"].includes(candidate)) return "collecting";
  if (["insufficient", "insufficient-data", "data-insufficient", "cold-start"].includes(candidate)) return "insufficient-data";
  if (["not-published", "unpublished", "hidden", "not-visible"].includes(candidate)) return "not-published";
  if (["ready", "published", "complete", "completed"].includes(candidate)) return "ready";
  return "not-collected";
}

function normalizeLifecycle(value: unknown): LocationCardLifecycle {
  const candidate = safeInsightText(value).toLowerCase().replaceAll("_", "-");
  if (candidate === "draft") return "draft";
  if (["in-review", "review", "reviewing"].includes(candidate)) return "in-review";
  if (["changes-requested", "change-requested", "rejected"].includes(candidate)) return "changes-requested";
  if (["reviewed", "approved", "review-approved"].includes(candidate)) return "reviewed";
  if (candidate === "published") return "published";
  return "requested";
}

function normalizeTone(value: unknown): InsightTone {
  const candidate = safeInsightText(value);
  return (["success", "warning", "info"].includes(candidate) ? candidate : "neutral") as InsightTone;
}

function normalizeAction(value: unknown): LocationCardAction | null {
  const candidate = safeInsightText(record(value).id ?? record(value).action ?? value).toLowerCase().replaceAll("_", "-");
  const aliases: Readonly<Record<string, LocationCardAction>> = {
    request: "request",
    "request-card": "request",
    "create-draft": "edit-draft",
    draft: "edit-draft",
    edit: "edit-draft",
    "edit-draft": "edit-draft",
    review: "submit-review",
    "submit-review": "submit-review",
    approve: "approve-review",
    "approve-review": "approve-review",
    "changes-request": "request-changes",
    "request-changes": "request-changes",
    publish: "publish"
  };
  return aliases[candidate] || null;
}

function normalizeActions(value: unknown): LocationCardAction[] {
  return [...new Set(list(value).map(normalizeAction).filter((item): item is LocationCardAction => Boolean(item)))];
}

function normalizeCta(value: unknown, fallbackPath?: InsightCta["path"]): InsightCta | null {
  const item = record(value);
  const path = (safeInsightText(item.path ?? item.href) || fallbackPath || "") as InsightCta["path"];
  if (!SAFE_CTA_PATHS.has(path)) return null;
  return { label: safeInsightText(item.label, "신규 수집 확인"), path };
}

function normalizeReadiness(value: unknown, fallbackState: InsightState, fallbackCtaPath?: InsightCta["path"]): InsightReadiness {
  const item = record(value);
  const input = record(item.inputRange ?? item.inputPeriod);
  const confidence = record(item.confidence);
  const state = normalizeInsightState(item.state ?? item.kind ?? fallbackState);
  return {
    state,
    label: safeInsightText(item.label, state === "ready" ? "공개 준비 완료" : "신규 데이터 준비 중"),
    detail: safeInsightText(item.detail ?? item.message, "기준을 충족한 신규 관측만 공개합니다."),
    sampleCount: optionalNumber(item.sampleCount),
    minimumSampleCount: optionalNumber(item.minimumSampleCount ?? item.requiredSampleCount),
    missingReasons: safeTextList(item.missingReasons ?? item.reasons),
    freshnessLabel: safeInsightText(item.freshnessLabel ?? record(item.freshness).label)
      || [safeInsightText(record(item.freshness).observations), safeInsightText(record(item.freshness).signals)].filter(Boolean).join(" · "),
    confidenceLabel: safeInsightText(item.confidenceLabel ?? confidence.label ?? confidence.level ?? item.confidence),
    confidenceCauses: safeTextList(item.confidenceCauses ?? confidence.causes),
    inputFrom: safeInsightText(item.inputFrom ?? input.from ?? input.start),
    inputTo: safeInsightText(item.inputTo ?? input.to ?? input.end),
    nextCollectionCta: normalizeCta(item.nextCollectionCta ?? item.cta, fallbackCtaPath)
  };
}

function normalizeScoreId(value: unknown): LocationScoreId | null {
  const candidate = safeInsightText(value).toLowerCase().replaceAll("_", "-");
  const aliases: Readonly<Record<string, LocationScoreId>> = {
    tourism: "tourism",
    industry: "industry",
    living: "living-area",
    "living-area": "living-area",
    catchment: "living-area",
    accessibility: "accessibility",
    access: "accessibility",
    interest: "interest",
    ota: "ota",
    leadtime: "leadtime",
    "lead-time": "leadtime"
  };
  return aliases[candidate] || null;
}

function normalizeScores(value: unknown): LocationScore[] {
  const source = Array.isArray(value)
    ? list(value)
    : Object.entries(record(value)).map(([id, score]) => ({ id, ...record(score) }));
  const byId = new Map<LocationScoreId, LocationScore>();
  for (const raw of source) {
    const item = record(raw);
    const id = normalizeScoreId(item.id ?? item.key ?? item.category);
    if (!id || byId.has(id)) continue;
    byId.set(id, {
      id,
      label: safeInsightText(item.label, SCORE_LABELS[id]),
      displayValue: safeInsightText(item.displayValue ?? item.value ?? item.score),
      detail: safeInsightText(item.detail ?? item.summary, "신규 관측 기준"),
      state: normalizeInsightState(item.state ?? (item.displayValue !== undefined || item.value !== undefined || item.score !== undefined ? "ready" : "not-collected"))
    });
  }
  return [...byId.values()];
}

function normalizeForecast(value: unknown): InsightForecast {
  const item = record(value);
  const input = record(item.inputRange ?? item.inputPeriod);
  const confidence = record(item.confidence);
  const interval = record(item.interval ?? item.confidenceInterval);
  const bookingPace = record(item.bookingPace);
  const sampleCount = optionalNumber(item.sampleCount);
  const minimumSampleCount = optionalNumber(item.minimumSampleCount ?? item.requiredSampleCount);
  const intervalView = safeInsightText(interval.displayValue ?? interval.display ?? item.intervalDisplay)
    || (interval.low !== undefined && interval.high !== undefined
      ? `${safeInsightText(interval.low)} ~ ${safeInsightText(interval.high)} ${safeInsightText(interval.unit)}`.trim()
      : "");
  let state = normalizeInsightState(item.state ?? item.kind);
  const readyContract = Boolean(
    state === "ready"
    && safeInsightText(item.asOfDate ?? item.baseDate ?? item.asOf)
    && safeInsightText(input.from ?? input.start ?? item.inputFrom)
    && safeInsightText(input.to ?? input.end ?? item.inputTo)
    && intervalView
    && (sampleCount === null || minimumSampleCount === null || sampleCount >= minimumSampleCount)
  );
  if (state === "ready" && !readyContract) state = "insufficient-data";
  return {
    state,
    label: safeInsightText(item.label, "다음달 수요 예측"),
    summary: safeInsightText(item.summary ?? item.detail, state === "ready" ? "신규 반복 관측 기반 예측" : "최소 반복 관측을 충족해야 공개됩니다."),
    asOfDate: safeInsightText(item.asOfDate ?? item.baseDate ?? item.asOf),
    inputFrom: safeInsightText(input.from ?? input.start ?? item.inputFrom),
    inputTo: safeInsightText(input.to ?? input.end ?? item.inputTo),
    sampleCount,
    minimumSampleCount,
    confidenceLabel: safeInsightText(item.confidenceLabel ?? confidence.label ?? confidence.level ?? item.confidence),
    confidenceCauses: safeTextList(item.confidenceCauses ?? confidence.causes),
    insufficientReasons: safeTextList(item.insufficientReasons ?? item.missingReasons ?? item.reasons),
    interval: state === "ready" ? {
      displayValue: intervalView,
      low: safeInsightText(interval.low),
      high: safeInsightText(interval.high),
      unit: safeInsightText(interval.unit)
    } : null,
    bookingPace: state === "ready" && safeInsightText(bookingPace.displayValue ?? bookingPace.value ?? item.bookingPacePerDay) ? {
      displayValue: safeInsightText(bookingPace.displayValue ?? bookingPace.value ?? item.bookingPacePerDay),
      detail: safeInsightText(bookingPace.detail, "신규 반복 관측 기준")
    } : null
  };
}

function normalizeEvidenceSummary(value: unknown): string {
  const item = record(value);
  const input = record(item.inputRange ?? item.inputPeriod);
  const parts = [
    optionalNumber(item.observationCount) === null ? "" : `관측 ${optionalNumber(item.observationCount)}건`,
    optionalNumber(item.signalCount) === null ? "" : `신호 ${optionalNumber(item.signalCount)}건`,
    safeInsightText(input.from) && safeInsightText(input.to) ? `${safeInsightText(input.from)} ~ ${safeInsightText(input.to)}` : ""
  ].filter(Boolean);
  return parts.join(" · ");
}

function normalizeLocationCard(value: unknown, businessView: boolean, fallbackSubject?: InsightSubject): LocationCardView | null {
  const item = record(value);
  if (!Object.keys(item).length) return null;
  const analysis = record(item.analysis ?? item.locationAnalysis);
  const analysisReadiness = record(analysis.readiness);
  const readiness = record(item.readiness ?? analysisReadiness);
  const editorial = record(item.editorial);
  const confidence = record(item.confidence);
  const freshness = record(item.freshness ?? readiness.freshness);
  const evidence = record(item.evidence ?? item.evidenceSnapshot);
  const lifecycle = normalizeLifecycle(item.lifecycle ?? item.status);
  if (businessView && lifecycle !== "published") return null;
  return {
    cardId: safeId(item.cardId ?? item.id),
    version: optionalNumber(item.version) ?? 0,
    lifecycle,
    title: safeInsightText(item.title ?? editorial.headline, fallbackSubject?.companyName ? `${fallbackSubject.companyName} 입지카드` : "입지카드"),
    companyName: safeInsightText(item.companyName ?? record(item.company).name, fallbackSubject?.companyName || "내 숙소"),
    regionLabel: safeInsightText(item.regionLabel ?? item.region ?? record(item.company).region, fallbackSubject?.regionLabel || ""),
    summary: safeInsightText(item.summary ?? item.description ?? editorial.summary ?? editorial.note, "공개 가능한 입지 요약이 아직 없습니다."),
    algorithmVersion: safeInsightText(item.algorithmVersion ?? analysis.algorithmVersion ?? evidence.algorithmVersion),
    evidenceSummary: safeInsightText(item.evidenceSummary ?? evidence.summary) || normalizeEvidenceSummary(evidence) || "신규 관측 범위 요약",
    updatedAt: safeInsightText(item.updatedAt),
    publishedAt: safeInsightText(item.publishedAt),
    freshnessLabel: safeInsightText(item.freshnessLabel ?? freshness.label ?? freshness.state)
      || [safeInsightText(freshness.observations), safeInsightText(freshness.signals)].filter(Boolean).join(" · "),
    confidenceLabel: safeInsightText(item.confidenceLabel ?? confidence.label ?? confidence.level ?? readiness.confidence),
    confidenceCauses: safeTextList(item.confidenceCauses ?? confidence.causes ?? readiness.confidenceCauses),
    scores: normalizeScores(item.scores ?? item.locationScores ?? item.dimensions ?? analysis.dimensions),
    forecast: Object.keys(record(item.forecast ?? analysis.forecast)).length ? normalizeForecast(item.forecast ?? analysis.forecast) : null,
    allowedActions: businessView ? [] : normalizeActions(item.allowedActions)
  };
}

function normalizeScopeId(value: unknown): ReportScopeId | null {
  const candidate = safeInsightText(value).toLowerCase().replaceAll("_", "-");
  const aliases: Readonly<Record<string, ReportScopeId>> = {
    national: "national",
    nationwide: "national",
    regional: "regional",
    region: "regional",
    own: "own",
    company: "own",
    cohort: "anonymous-cohort",
    "anonymous-cohort": "anonymous-cohort",
    anonymous: "anonymous-cohort"
  };
  return aliases[candidate] || null;
}

function normalizeScopes(value: unknown): ReportScopeView[] {
  const source = Array.isArray(value)
    ? list(value)
    : Object.entries(record(value)).map(([id, scope]) => ({ id, ...record(scope) }));
  const byId = new Map<ReportScopeId, ReportScopeView>();
  for (const raw of source) {
    const item = record(raw);
    const id = normalizeScopeId(item.id ?? item.scope ?? item.key);
    if (!id || byId.has(id)) continue;
    const metrics = record(item.metrics);
    const averagePrice = optionalNumber(metrics.averagePrice);
    const soldRate = optionalNumber(metrics.soldRate);
    const otaExposureRate = optionalNumber(metrics.otaExposureRate);
    const metricParts = [
      averagePrice === null ? "" : `평균가 ${Math.round(averagePrice).toLocaleString("ko-KR")}원`,
      soldRate === null ? "" : `판매율 ${soldRate}%`,
      otaExposureRate === null ? "" : `OTA 노출 ${otaExposureRate}%`
    ].filter(Boolean);
    const missingReasons = safeTextList(item.missingReasons);
    byId.set(id, {
      id,
      label: safeInsightText(item.label, REPORT_SCOPE_LABELS[id]),
      displayValue: safeInsightText(item.displayValue ?? item.value) || metricParts[0] || "",
      detail: safeInsightText(item.detail ?? item.summary) || metricParts.join(" · ") || missingReasons.join(" · ") || "신규 관측 기준",
      state: normalizeInsightState(item.state ?? (metricParts.length || item.displayValue !== undefined || item.value !== undefined ? "ready" : "not-collected"))
    });
  }
  return [...byId.values()];
}

function normalizeMonthlyReport(value: unknown, businessView: boolean): MonthlyReportView | null {
  const item = record(value);
  if (!Object.keys(item).length) return null;
  const editorial = record(item.editorial);
  const rawScopes = Array.isArray(item.scopes)
    ? list(item.scopes)
    : Object.entries(record(item.scopes)).map(([id, scope]) => ({ id, ...record(scope) }));
  const anonymousScope = record(rawScopes.find((scope) => normalizeScopeId(record(scope).id ?? record(scope).scope ?? record(scope).key) === "anonymous-cohort"));
  const cohort = record(item.cohort ?? item.anonymousCohort ?? anonymousScope.cohort);
  const cohortSummary = [
    safeInsightText(cohort.region) ? `지역 ${safeInsightText(cohort.region)}` : "",
    safeInsightText(cohort.category) ? `업종 ${safeInsightText(cohort.category)}` : "",
    safeInsightText(cohort.sizeBand) ? `규모 ${safeInsightText(cohort.sizeBand)}` : "",
    safeInsightText(cohort.priceBand) ? `가격대 ${safeInsightText(cohort.priceBand)}` : "",
    safeInsightText(cohort.otaBand) ? `OTA ${safeInsightText(cohort.otaBand)}` : ""
  ].filter(Boolean).join(" · ");
  let state = normalizeInsightState(item.state ?? item.status);
  const publishedAt = safeInsightText(item.publishedAt);
  if (businessView && (state !== "ready" || !publishedAt)) return null;
  const forecast = normalizeForecast(item.forecast);
  if (state === "ready" && forecast.state !== "ready") state = "insufficient-data";
  return {
    state,
    month: safeInsightText(item.month ?? item.reportMonth),
    title: safeInsightText(item.title ?? editorial.headline, "월간 리포트"),
    summary: safeInsightText(item.summary ?? editorial.summary ?? editorial.note, "공개 가능한 월간 요약이 아직 없습니다."),
    publishedAt,
    algorithmVersion: safeInsightText(item.algorithmVersion),
    locationCardPath: safeInsightText(item.locationCardPath) === "/app/location" ? "/app/location" : "/app/location",
    scopes: normalizeScopes(item.scopes),
    cohort: {
      label: safeInsightText(cohort.label, "익명 비교군"),
      summary: safeInsightText(cohort.summary) || cohortSummary || "비식별 비교군 표본이 준비되면 공개됩니다.",
      sampleCount: optionalNumber(cohort.sampleCount ?? anonymousScope.sampleCount),
      minimumSampleCount: optionalNumber(cohort.minimumSampleCount ?? cohort.requiredSampleCount ?? anonymousScope.minimumSampleCount)
    },
    forecast
  };
}

function normalizeMetric(value: unknown, index: number): InsightMetric {
  const item = record(value);
  return {
    id: safeId(item.id) || `metric-${index}`,
    label: safeInsightText(item.label, "신규 지표"),
    value: safeInsightText(item.value ?? item.displayValue, "—"),
    detail: safeInsightText(item.detail, "신규 관측 기준"),
    tone: normalizeTone(item.tone)
  };
}

function normalizeMetrics(value: unknown): InsightMetric[] {
  if (Array.isArray(value)) return list(value).map(normalizeMetric);
  return Object.entries(record(value)).map(([id, metric], index) => {
    const item = record(metric);
    return normalizeMetric(Object.keys(item).length ? { id, ...item } : { id, label: id, value: metric }, index);
  });
}

function normalizeAudit(value: unknown): InsightAuditItem[] {
  const source = Array.isArray(value) ? list(value) : list(record(value).latest);
  return source.map((raw, index) => {
    const item = record(raw);
    return {
      id: safeId(item.auditId ?? item.id) || `audit-${index}`,
      action: safeInsightText(item.action ?? item.event),
      label: safeInsightText(item.label ?? item.action ?? item.event, "상태 변경"),
      detail: safeInsightText(item.detail ?? item.summary ?? item.actorRole),
      occurredAt: safeInsightText(item.occurredAt ?? item.at ?? item.createdAt ?? item.updatedAt)
    };
  }).filter((item) => item.action || item.occurredAt);
}

function normalizeSubject(value: unknown, fallbackName = "신규 수집 업체"): InsightSubject | null {
  const item = record(value);
  const companyId = safeId(item.companyId ?? item.id);
  if (!companyId) return null;
  return {
    companyId,
    companyName: safeInsightText(item.companyName ?? item.name, fallbackName),
    regionLabel: safeInsightText(item.regionLabel ?? item.region)
  };
}

export function isStage229Route(routeId: string): routeId is Stage229RouteId {
  return (STAGE229_ROUTE_IDS as readonly string[]).includes(routeId);
}

export function isStage229OnlyRoute(routeId: string): routeId is Exclude<Stage229RouteId, "business-location"> {
  return routeId === "business-report" || routeId === "admin-location";
}

export function normalizeStage229Workspace(value: unknown, requestedView: Stage229RouteId): Stage229Workspace {
  const envelope = record(value);
  const data = Object.keys(record(envelope.workspace)).length
    ? record(envelope.workspace)
    : Object.keys(record(envelope.data)).length ? record(envelope.data) : envelope;
  const metadata = { ...record(envelope.metadata), ...record(data.metadata) };
  const businessView = requestedView.startsWith("business-");
  const subjectRecord = record(data.subject ?? data.company);
  const normalizedSubjects = list(data.subjects).map((item) => normalizeSubject(item)).filter((item): item is InsightSubject => Boolean(item));
  const declaredCompanyId = safeId(subjectRecord.companyId ?? data.companyId);
  const explicitSubject = safeInsightText(subjectRecord.companyName ?? subjectRecord.name)
    ? normalizeSubject({ ...subjectRecord, companyId: declaredCompanyId })
    : null;
  const resolvedSubject = explicitSubject
    || normalizedSubjects.find((item) => item.companyId === declaredCompanyId)
    || normalizedSubjects[0]
    || null;
  const declaredState = normalizeInsightState(data.state ?? metadata.state);
  const fallbackCtaPath: InsightCta["path"] = businessView ? "/app/activity" : "/admin/collection";
  const readiness = normalizeReadiness(data.readiness ?? record(data.locationCard).readiness ?? record(record(data.locationCard).analysis).readiness, declaredState, fallbackCtaPath);
  const locationCard = normalizeLocationCard(data.locationCard ?? data.card, businessView, resolvedSubject || undefined);
  const reportPayload = record(data.monthlyReport ?? data.report);
  const monthlyReport = normalizeMonthlyReport(
    Object.keys(reportPayload).length
      ? { ...reportPayload, scopes: reportPayload.scopes ?? data.reportScopes, locationCardPath: reportPayload.locationCardPath ?? data.locationCardPath }
      : reportPayload,
    businessView
  );
  let state = declaredState;
  if (state === "ready" && readiness.state !== "ready") state = readiness.state;
  if (requestedView === "business-location" && state === "ready" && !locationCard) state = "not-published";
  if (requestedView === "business-report" && state === "ready" && !monthlyReport) state = "not-published";
  if (requestedView === "business-report" && monthlyReport?.state === "insufficient-data") state = "insufficient-data";
  const algorithmVersion = safeInsightText(metadata.algorithmVersion ?? data.algorithmVersion ?? locationCard?.algorithmVersion ?? monthlyReport?.algorithmVersion);
  return {
    stage: 229,
    routeId: requestedView,
    state,
    algorithmVersion,
    generatedAt: safeInsightText(metadata.generatedAt ?? data.generatedAt),
    dataBoundary: "fresh-integration-only",
    projection: "business-safe",
    subject: businessView ? {
      companyId: "",
      companyName: safeInsightText(resolvedSubject?.companyName ?? data.companyName, "내 숙소"),
      regionLabel: safeInsightText(resolvedSubject?.regionLabel ?? data.regionLabel)
    } : resolvedSubject || { companyId: "", companyName: "신규 수집 업체", regionLabel: "" },
    subjects: businessView ? [] : normalizedSubjects,
    readiness,
    metrics: normalizeMetrics(data.metrics),
    locationCard,
    monthlyReport,
    allowedActions: businessView ? [] : normalizeActions(data.allowedActions ?? locationCard?.allowedActions),
    audit: businessView ? [] : normalizeAudit(data.audit ?? data.history),
    notices: safeTextList(data.notices ?? data.warnings)
  };
}

export function stage229FailureState(reason: unknown): "permission" | "unavailable" | "error" {
  if (reason instanceof ApiError && reason.status === 403) return "permission";
  if (reason instanceof ApiError && (reason.status === 404 || reason.status === 503)) return "unavailable";
  return "error";
}

export async function readStage229Workspace(view: Stage229RouteId, companyId = "", signal?: AbortSignal): Promise<Stage229Workspace> {
  const selectedCompanyId = safeId(companyId);
  const query = new URLSearchParams({ view });
  if (selectedCompanyId && view === "admin-location") query.set("companyId", selectedCompanyId);
  const payload = await apiRequest<unknown>(`/api/integration/insights/workspace?${query.toString()}`, {
    signal,
    cache: "no-store"
  });
  return normalizeStage229Workspace(payload, view);
}

function requireCardId(cardId: string): string {
  const normalized = safeId(cardId);
  if (!normalized) throw new Error("유효한 입지카드 ID가 필요합니다.");
  return normalized;
}

function normalizeMutation(value: unknown): InsightMutationResult {
  const envelope = record(value);
  const item = Object.keys(record(envelope.locationCard)).length
    ? record(envelope.locationCard)
    : Object.keys(record(envelope.card)).length
      ? record(envelope.card)
      : Object.keys(record(envelope.request)).length ? record(envelope.request) : envelope;
  return {
    ok: envelope.ok !== false,
    cardId: safeId(item.cardId ?? item.id),
    lifecycle: normalizeLifecycle(item.lifecycle ?? item.status)
  };
}

export async function requestInsightLocationCard(input: { clientRequestId: string; companyId?: string }): Promise<InsightMutationResult> {
  return normalizeMutation(await apiRequest<unknown>("/api/integration/insights/location-cards", {
    method: "POST",
    body: JSON.stringify({
      clientRequestId: safeId(input.clientRequestId),
      ...(safeId(input.companyId) ? { companyId: safeId(input.companyId) } : {})
    })
  }));
}

export async function updateInsightLocationCardDraft(cardId: string, expectedVersion: number, revisionNote: string, lifecycle: LocationCardLifecycle): Promise<InsightMutationResult> {
  return normalizeMutation(await apiRequest<unknown>(`/api/integration/insights/location-cards/${encodeURIComponent(requireCardId(cardId))}/draft`, {
    method: lifecycle === "requested" ? "POST" : "PATCH",
    body: JSON.stringify({ expectedVersion, editorial: { note: safeInsightText(revisionNote) } })
  }));
}

async function mutateLocationCard(cardId: string, action: "review" | "publish", body: UnknownRecord): Promise<InsightMutationResult> {
  return normalizeMutation(await apiRequest<unknown>(`/api/integration/insights/location-cards/${encodeURIComponent(requireCardId(cardId))}/${action}`, {
    method: "POST",
    body: JSON.stringify(body)
  }));
}

export const submitInsightLocationCardReview = (cardId: string, expectedVersion: number, note = "") => mutateLocationCard(cardId, "review", {
  expectedVersion,
  decision: "submit",
  ...(safeInsightText(note) ? { reason: safeInsightText(note) } : {})
});
export const approveInsightLocationCardReview = (cardId: string, expectedVersion: number, note = "") => mutateLocationCard(cardId, "review", {
  expectedVersion,
  decision: "approve",
  ...(safeInsightText(note) ? { reason: safeInsightText(note) } : {})
});
export const requestInsightLocationCardChanges = (cardId: string, expectedVersion: number, note: string) => mutateLocationCard(cardId, "review", {
  expectedVersion,
  decision: "request-changes",
  reason: safeInsightText(note)
});
export const publishInsightLocationCard = (cardId: string, expectedVersion: number, note = "") => mutateLocationCard(cardId, "publish", {
  expectedVersion,
  ...(safeInsightText(note) ? { note: safeInsightText(note) } : {})
});

export function newStage229ClientRequestId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `stage229-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
