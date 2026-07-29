import { ApiError, apiRequest } from "../apiClient";
import { safeInsightText } from "../reporting/stage229Client";

export const STAGE230_ROUTE_IDS = Object.freeze([
  "business-strategy",
  "business-execution",
  "business-retrospective",
  "admin-strategy",
  "admin-execution",
  "admin-retrospective"
] as const);

export type Stage230RouteId = typeof STAGE230_ROUTE_IDS[number];
export type Stage230State = "not-published-report" | "insufficient-confidence" | "empty" | "ready";
export type StrategyDomain = "price" | "channel" | "product" | "content" | "leadtime";
export type PlanStatus = "draft" | "active" | "completed" | "cancelled";
export type ItemStatus = "planned" | "in-progress" | "blocked" | "done" | "cancelled";
export type CandidateType = "carryover" | "repeat" | "new";
export type ConfidenceLevel = "medium" | "high";

export interface Stage230Metric {
  id: string;
  label: string;
  value: string;
  detail: string;
  tone: "neutral" | "info" | "success" | "warning";
}

export interface StrategyEvidence {
  key: string;
  label: string;
  displayValue: string;
  sampleCount: number | null;
}

export interface StrategyLineage {
  sourceReportMonth: string;
  sourceReportVersion: number | null;
  sourceReportPublishedAt: string;
  sourceAlgorithmVersion: string;
  ruleVersion: string;
  evidenceKeys: readonly string[];
  candidateIds: readonly string[];
  sourceRetrospectiveIds: readonly string[];
  generatedAt: string;
  generatedBy: string;
}

export interface StrategyCardView {
  strategyId: string;
  domain: StrategyDomain;
  domainLabel: string;
  ruleVersion: string;
  title: string;
  summary: string;
  confidence: { level: ConfidenceLevel; label: string; reasons: readonly string[] };
  difficulty: "low" | "medium" | "high";
  difficultyLabel: string;
  expectedEffect: { label: string; displayRange: string; direction: string };
  executionTiming: { startDate: string; dueDate: string; label: string };
  evidence: readonly StrategyEvidence[];
  checklist: readonly { checklistId: string; label: string; required: boolean }[];
  kpiTemplate: { metricKey: string; label: string; unit: string; direction: string; targetValue: number | null } | null;
  lineage: StrategyLineage;
}

export interface ChecklistView {
  checklistId: string;
  label: string;
  required: boolean;
  completed: boolean;
  completedAt: string;
}

export interface KpiView {
  kpiId: string;
  metricKey: string;
  label: string;
  unit: string;
  direction: string;
  targetValue: number | null;
  currentValue: number | null;
  inputState: "missing" | "entered";
  achieved: boolean | null;
  version: number;
  updatedAt: string;
}

export interface PlanItemView {
  itemId: string;
  strategyId: string;
  title: string;
  owner: string;
  dueDate: string;
  status: ItemStatus;
  notes: string;
  repeatNextMonth: boolean;
  checklist: readonly ChecklistView[];
  kpis: readonly KpiView[];
  lineage: StrategyLineage;
  createdAt: string;
  updatedAt: string;
}

export interface ActionPlanView {
  planId: string;
  month: string;
  title: string;
  status: PlanStatus;
  owner: string;
  dueDate: string;
  notes: string;
  strategyIds: readonly string[];
  candidateIds: readonly string[];
  items: readonly PlanItemView[];
  lineage: StrategyLineage;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface BoardItemView extends PlanItemView {
  planId: string;
  planTitle: string;
  planStatus: PlanStatus;
  month: string;
  overdue: boolean;
  thisWeek: boolean;
}

export interface RetrospectiveView {
  retrospectiveId: string;
  planId: string;
  month: string;
  execution: { done: number; total: number; rate: number };
  kpis: { achieved: number; entered: number; total: number; achievementRate: number; missing: number };
  incompleteReasons: readonly { itemId: string; title: string; reason: string }[];
  summary: string;
  lineage: StrategyLineage;
  createdAt: string;
}

export interface CandidateView {
  candidateId: string;
  type: CandidateType;
  typeLabel: string;
  targetMonth: string;
  status: "candidate" | "planned";
  plannedInPlanId: string;
  appliedAt: string;
  appliedBy: string;
  strategyId: string;
  sourceItemId: string;
  title: string;
  reason: string;
  lineage: StrategyLineage;
  createdAt: string;
}

export interface Stage230Workspace {
  stage: 230;
  routeId: Stage230RouteId;
  state: Stage230State;
  month: string;
  generatedAt: string;
  dataBoundary: "published-stage229-business-safe-only";
  projection: "business-safe";
  reportGate: {
    state: Stage230State;
    label: string;
    detail: string;
    reportMonth: string;
    confidenceLabel: string;
    reportPath: "/app/report";
  };
  metrics: readonly Stage230Metric[];
  strategies: readonly StrategyCardView[];
  plans: readonly ActionPlanView[];
  board: {
    summary: { total: number; planned: number; inProgress: number; blocked: number; done: number; overdue: number; thisWeek: number };
    items: readonly BoardItemView[];
  };
  retrospectives: readonly RetrospectiveView[];
  candidates: readonly CandidateView[];
  limits: { allowed: boolean; plan: string; reason: string };
  notices: readonly string[];
}

export interface Stage230Filters {
  companyId?: string;
  tenantCompanyId?: string;
  month?: string;
  status?: string;
  owner?: string;
  due?: "overdue" | "this-week" | "all" | "";
}

type UnknownRecord = Record<string, unknown>;

const DOMAIN_LABEL: Readonly<Record<StrategyDomain, string>> = Object.freeze({
  price: "가격",
  channel: "채널",
  product: "상품",
  content: "콘텐츠",
  leadtime: "리드타임"
});
const CANDIDATE_LABEL: Readonly<Record<CandidateType, string>> = Object.freeze({ carryover: "이월", repeat: "반복", new: "신규" });
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,159}$/;

const record = (value: unknown): UnknownRecord => value && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : {};
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const text = (value: unknown, fallback = "") => safeInsightText(value, fallback);
const id = (value: unknown) => { const candidate = text(value); return SAFE_ID.test(candidate) ? candidate : ""; };
const numberOrNull = (value: unknown): number | null => {
  if (value === null || value === undefined || value === "") return null;
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
};
const count = (value: unknown) => Math.max(0, Math.floor(numberOrNull(value) ?? 0));
const bool = (value: unknown) => value === true;
const textList = (value: unknown) => list(value).map((item) => text(item)).filter(Boolean);

function normalizeState(value: unknown): Stage230State {
  const candidate = text(record(value).state ?? record(value).kind ?? value).toLowerCase().replaceAll("_", "-");
  if (["not-published-report", "report-not-published", "not-published", "missing-report"].includes(candidate)) return "not-published-report";
  if (["insufficient-confidence", "low-confidence", "confidence-insufficient", "insufficient-data"].includes(candidate)) return "insufficient-confidence";
  if (["ready", "active", "complete", "completed"].includes(candidate)) return "ready";
  return "empty";
}

function normalizeDomain(value: unknown): StrategyDomain {
  const candidate = text(value).toLowerCase().replaceAll("-", "");
  return (["price", "channel", "product", "content", "leadtime"] as const).find((item) => item === candidate) || "price";
}

function normalizeConfidence(value: unknown): StrategyCardView["confidence"] {
  const item = record(value);
  const level = text(item.level ?? value).toLowerCase() === "high" ? "high" : "medium";
  return { level, label: level === "high" ? "높음" : "보통", reasons: textList(item.reasons ?? item.causes) };
}

function normalizeLineage(value: unknown): StrategyLineage {
  const item = record(value);
  return {
    sourceReportMonth: text(item.sourceReportMonth ?? item.reportMonth),
    sourceReportVersion: numberOrNull(item.sourceReportVersion ?? item.reportVersion),
    sourceReportPublishedAt: text(item.sourceReportPublishedAt ?? item.reportPublishedAt),
    sourceAlgorithmVersion: text(item.sourceAlgorithmVersion ?? item.algorithmVersion),
    ruleVersion: text(item.ruleVersion),
    evidenceKeys: textList(item.evidenceKeys),
    candidateIds: list(item.candidateIds).map(id).filter(Boolean),
    sourceRetrospectiveIds: list(item.sourceRetrospectiveIds).map(id).filter(Boolean),
    generatedAt: text(item.generatedAt ?? item.appliedAt ?? item.reviewedAt),
    generatedBy: text(item.generatedBy ?? item.appliedBy ?? item.reviewedBy, "deterministic-rule")
  };
}

function normalizeStrategy(value: unknown): StrategyCardView | null {
  const item = record(value);
  const strategyId = id(item.strategyId ?? item.id);
  if (!strategyId) return null;
  const domain = normalizeDomain(item.domain);
  const difficulty = (["low", "high"] as const).includes(text(item.difficulty) as "low" | "high")
    ? text(item.difficulty) as "low" | "high" : "medium";
  const effect = record(item.expectedEffect);
  const minimum = numberOrNull(effect.minimum);
  const maximum = numberOrNull(effect.maximum);
  const unit = text(effect.unit);
  const displayRange = minimum === null && maximum === null ? "산정 중"
    : minimum === maximum || maximum === null ? `${minimum ?? maximum}${unit}`
      : `${minimum}~${maximum}${unit}`;
  const timing = record(item.executionTiming);
  const template = record(item.kpiTemplate);
  const lineage = normalizeLineage(item.lineage);
  return {
    strategyId,
    domain,
    domainLabel: DOMAIN_LABEL[domain],
    ruleVersion: text(item.ruleVersion ?? lineage.ruleVersion),
    title: text(item.title, `${DOMAIN_LABEL[domain]} 전략`),
    summary: text(item.summary, "공개 월간 리포트의 근거 지표를 사용한 deterministic 추천입니다."),
    confidence: normalizeConfidence(item.confidence),
    difficulty,
    difficultyLabel: difficulty === "low" ? "낮음" : difficulty === "high" ? "높음" : "보통",
    expectedEffect: { label: text(effect.label, "기대 효과"), displayRange, direction: text(effect.direction) },
    executionTiming: { startDate: text(timing.startDate), dueDate: text(timing.dueDate), label: text(timing.label, "실행 시점 확인") },
    evidence: list(item.evidence).map((entry, index) => {
      const evidence = record(entry);
      const metricKey = text(evidence.metricKey);
      const valueText = text(evidence.value);
      const evidenceUnit = text(evidence.unit);
      return {
        key: `${text(evidence.scope, "scope")}:${metricKey || index}`,
        label: text(evidence.label, "근거 지표"),
        displayValue: [valueText, evidenceUnit].filter(Boolean).join(" "),
        sampleCount: numberOrNull(evidence.sampleCount)
      };
    }),
    checklist: list(item.checklist).map((entry, index) => {
      const checklist = record(entry);
      return { checklistId: id(checklist.checklistId) || `check-${index}`, label: text(checklist.label, "실행 항목"), required: checklist.required !== false };
    }),
    kpiTemplate: Object.keys(template).length ? {
      metricKey: text(template.metricKey), label: text(template.label, "추적 KPI"), unit: text(template.unit),
      direction: text(template.direction), targetValue: numberOrNull(template.targetValue)
    } : null,
    lineage,
  };
}

function normalizeChecklist(value: unknown, index: number): ChecklistView {
  const item = record(value);
  return {
    checklistId: id(item.checklistId ?? item.id) || `check-${index}`,
    label: text(item.label, "실행 항목"),
    required: item.required !== false,
    completed: bool(item.completed),
    completedAt: text(item.completedAt)
  };
}

function normalizeKpi(value: unknown): KpiView | null {
  const item = record(value);
  const kpiId = id(item.kpiId ?? item.id);
  if (!kpiId) return null;
  const currentValue = numberOrNull(item.currentValue);
  return {
    kpiId,
    metricKey: text(item.metricKey),
    label: text(item.label, "추적 KPI"),
    unit: text(item.unit),
    direction: text(item.direction),
    targetValue: numberOrNull(item.targetValue),
    currentValue,
    inputState: text(item.inputState) === "entered" || currentValue !== null ? "entered" : "missing",
    achieved: typeof item.achieved === "boolean" ? item.achieved : null,
    version: count(item.version),
    updatedAt: text(item.updatedAt)
  };
}

function normalizeItem(value: unknown): PlanItemView | null {
  const item = record(value);
  const itemId = id(item.itemId ?? item.id);
  if (!itemId) return null;
  const statusCandidate = text(item.status).toLowerCase().replaceAll("_", "-");
  const status = (["planned", "in-progress", "blocked", "done", "cancelled"] as const).includes(statusCandidate as ItemStatus)
    ? statusCandidate as ItemStatus : "planned";
  return {
    itemId,
    strategyId: id(item.strategyId),
    title: text(item.title, "실행 항목"),
    owner: text(item.owner, "미지정"),
    dueDate: text(item.dueDate),
    status,
    notes: text(item.notes),
    repeatNextMonth: bool(item.repeatNextMonth),
    checklist: list(item.checklist).map(normalizeChecklist),
    kpis: list(item.kpis).map(normalizeKpi).filter((entry): entry is KpiView => Boolean(entry)),
    lineage: normalizeLineage(item.lineage),
    createdAt: text(item.createdAt),
    updatedAt: text(item.updatedAt)
  };
}

function normalizePlan(value: unknown): ActionPlanView | null {
  const item = record(value);
  const planId = id(item.planId ?? item.id);
  if (!planId) return null;
  const statusCandidate = text(item.status).toLowerCase();
  const status = (["draft", "active", "completed", "cancelled"] as const).includes(statusCandidate as PlanStatus)
    ? statusCandidate as PlanStatus : "draft";
  return {
    planId,
    month: text(item.month),
    title: text(item.title, "월간 실행계획"),
    status,
    owner: text(item.owner, "미지정"),
    dueDate: text(item.dueDate),
    notes: text(item.notes),
    strategyIds: list(item.strategyIds).map(id).filter(Boolean),
    candidateIds: list(item.candidateIds ?? record(item.lineage).candidateIds).map(id).filter(Boolean),
    items: list(item.items).map(normalizeItem).filter((entry): entry is PlanItemView => Boolean(entry)),
    lineage: normalizeLineage(item.lineage),
    version: count(item.version),
    createdAt: text(item.createdAt),
    updatedAt: text(item.updatedAt)
  };
}

function normalizeBoard(value: unknown, plans: readonly ActionPlanView[]): Stage230Workspace["board"] {
  const item = record(value);
  const summary = record(item.summary);
  const fallbackItems = plans.flatMap((plan) => plan.items.map((entry) => ({ ...entry, planId: plan.planId, planTitle: plan.title, planStatus: plan.status, month: plan.month })));
  const items = (list(item.items).length ? list(item.items) : fallbackItems).map((entry) => {
    const raw = record(entry);
    const normalized = normalizeItem(raw);
    if (!normalized) return null;
    return {
      ...normalized,
      planId: id(raw.planId), planTitle: text(raw.planTitle, "월간 실행계획"),
      planStatus: (["active", "completed", "cancelled"] as const).includes(text(raw.planStatus) as "active" | "completed" | "cancelled") ? text(raw.planStatus) as PlanStatus : "draft",
      month: text(raw.month), overdue: bool(raw.overdue), thisWeek: bool(raw.thisWeek)
    };
  }).filter((entry): entry is BoardItemView => Boolean(entry));
  return {
    summary: {
      total: count(summary.total ?? items.length), planned: count(summary.planned), inProgress: count(summary.inProgress), blocked: count(summary.blocked),
      done: count(summary.done), overdue: count(summary.overdue), thisWeek: count(summary.thisWeek)
    },
    items
  };
}

function normalizeRetrospective(value: unknown): RetrospectiveView | null {
  const item = record(value);
  const retrospectiveId = id(item.retrospectiveId ?? item.id);
  if (!retrospectiveId) return null;
  const execution = record(item.execution);
  const kpis = record(item.kpis);
  return {
    retrospectiveId,
    planId: id(item.planId),
    month: text(item.month),
    execution: { done: count(execution.done), total: count(execution.total), rate: numberOrNull(execution.rate) ?? 0 },
    kpis: { achieved: count(kpis.achieved), entered: count(kpis.entered), total: count(kpis.total), achievementRate: numberOrNull(kpis.achievementRate) ?? 0, missing: count(kpis.missing) },
    incompleteReasons: list(item.incompleteReasons).map((entry) => {
      const reason = record(entry);
      return { itemId: id(reason.itemId), title: text(reason.title, "미완료 항목"), reason: text(reason.reason, "사유 미입력") };
    }),
    summary: text(item.summary, "월간 실행 결과를 검토했습니다."),
    lineage: normalizeLineage(item.lineage),
    createdAt: text(item.createdAt)
  };
}

function normalizeCandidate(value: unknown): CandidateView | null {
  const item = record(value);
  const candidateId = id(item.candidateId ?? item.id);
  if (!candidateId) return null;
  const typeCandidate = text(item.type).toLowerCase();
  const type = (["carryover", "repeat", "new"] as const).includes(typeCandidate as CandidateType) ? typeCandidate as CandidateType : "new";
  const lineage = normalizeLineage(item.lineage);
  const status = text(item.status).toLowerCase() === "planned" ? "planned" : "candidate";
  return {
    candidateId, type, typeLabel: CANDIDATE_LABEL[type], targetMonth: text(item.targetMonth), status,
    plannedInPlanId: id(item.plannedInPlanId), appliedAt: text(item.appliedAt ?? lineage.generatedAt), appliedBy: text(item.appliedBy ?? lineage.generatedBy),
    strategyId: id(item.strategyId), sourceItemId: id(item.sourceItemId), title: text(item.title, "다음달 후보"),
    reason: text(item.reason, "월간 회고 결과"), lineage, createdAt: text(item.createdAt)
  };
}

function deriveMetrics(workspace: Omit<Stage230Workspace, "metrics">): Stage230Metric[] {
  if (workspace.routeId === "business-strategy") return [
    { id: "strategies", label: "추천 전략", value: `${workspace.strategies.length}개`, detail: "published report 근거", tone: workspace.strategies.length ? "success" : "warning" },
    { id: "domains", label: "전략 영역", value: `${new Set(workspace.strategies.map((item) => item.domain)).size}/5`, detail: "가격·채널·상품·콘텐츠·리드타임", tone: "info" },
    { id: "confidence", label: "Confidence", value: workspace.reportGate.confidenceLabel || "확인 중", detail: workspace.reportGate.label, tone: workspace.state === "ready" ? "success" : "warning" }
  ];
  if (workspace.routeId === "business-execution") return [
    { id: "plans", label: "실행계획", value: `${workspace.plans.length}개`, detail: `${workspace.month || "대상월 확인"}`, tone: workspace.plans.length ? "success" : "warning" },
    { id: "thisWeek", label: "이번 주", value: `${workspace.board.summary.thisWeek}건`, detail: "목표일 기준", tone: "info" },
    { id: "overdue", label: "지연", value: `${workspace.board.summary.overdue}건`, detail: "완료되지 않은 기한 경과 항목", tone: workspace.board.summary.overdue ? "warning" : "success" }
  ];
  const latest = workspace.retrospectives[0];
  return [
    { id: "executionRate", label: "실행률", value: latest ? `${latest.execution.rate}%` : "—", detail: latest ? `${latest.execution.done}/${latest.execution.total} 완료` : "회고 없음", tone: latest ? "success" : "warning" },
    { id: "kpiRate", label: "KPI 달성률", value: latest ? `${latest.kpis.achievementRate}%` : "—", detail: latest ? `${latest.kpis.missing}개 미입력` : "회고 없음", tone: "info" },
    { id: "candidates", label: "다음달 후보", value: `${workspace.candidates.length}개`, detail: "이월·반복·신규", tone: workspace.candidates.length ? "success" : "neutral" }
  ];
}

export function normalizeStage230Workspace(value: unknown, routeId: Stage230RouteId): Stage230Workspace {
  const envelope = record(value);
  const data = Object.keys(record(envelope.workspace)).length ? record(envelope.workspace) : envelope;
  const metadata = { ...record(envelope.metadata), ...record(data.metadata) };
  const reportGateRaw = record(data.reportGate);
  const state = normalizeState(data.state ?? reportGateRaw.state);
  const reportGateState = normalizeState(reportGateRaw.state ?? state);
  const limitRecord = record(data.limits);
  const plans = list(data.plans).map(normalizePlan).filter((entry): entry is ActionPlanView => Boolean(entry));
  const base: Omit<Stage230Workspace, "metrics"> = {
    stage: 230,
    routeId,
    state,
    month: text(data.month ?? reportGateRaw.reportMonth),
    generatedAt: text(metadata.generatedAt ?? data.generatedAt),
    dataBoundary: "published-stage229-business-safe-only",
    projection: "business-safe",
    reportGate: {
      state: reportGateState,
      label: text(reportGateRaw.label, reportGateState === "ready" ? "공개 리포트 기준 충족" : reportGateState === "insufficient-confidence" ? "신뢰도 기준 미달" : "공개 리포트 필요"),
      detail: text(reportGateRaw.detail ?? reportGateRaw.reason, "Stage 229의 공개 월간 리포트와 confidence 기준을 확인합니다."),
      reportMonth: text(reportGateRaw.reportMonth ?? data.month),
      confidenceLabel: text(reportGateRaw.confidenceLabel ?? record(reportGateRaw.confidence).label ?? reportGateRaw.confidence),
      reportPath: "/app/report"
    },
    strategies: list(data.strategies).map(normalizeStrategy).filter((entry): entry is StrategyCardView => Boolean(entry)),
    plans,
    board: normalizeBoard(data.board, plans),
    retrospectives: list(data.retrospectives).map(normalizeRetrospective).filter((entry): entry is RetrospectiveView => Boolean(entry)),
    candidates: list(data.candidates).map(normalizeCandidate).filter((entry): entry is CandidateView => Boolean(entry)),
    limits: {
      allowed: limitRecord.allowed !== false,
      plan: text(limitRecord.plan ?? data.limits, "현재 요금제"),
      reason: text(limitRecord.reason)
    },
    notices: textList(data.notices)
  };
  return { ...base, metrics: deriveMetrics(base) };
}

export function isStage230Route(routeId: string): routeId is Stage230RouteId {
  return (STAGE230_ROUTE_IDS as readonly string[]).includes(routeId);
}

export function adminStage230Route(search: string): Extract<Stage230RouteId, `admin-${string}`> {
  const view = new URLSearchParams(search).get("view");
  if (view === "execution") return "admin-execution";
  if (view === "retrospective") return "admin-retrospective";
  return "admin-strategy";
}

export function stage230AdminTargetReady(filters: Stage230Filters): boolean {
  return Boolean(id(filters.companyId) && id(filters.tenantCompanyId));
}

export function stage230FailureState(reason: unknown): "permission" | "unavailable" | "error" {
  if (reason instanceof ApiError && reason.status === 403) return "permission";
  if (reason instanceof ApiError && (reason.status === 404 || reason.status === 503)) return "unavailable";
  return "error";
}

export async function readStage230Workspace(view: Stage230RouteId, filters: Stage230Filters = {}, signal?: AbortSignal): Promise<Stage230Workspace> {
  const query = new URLSearchParams({ view });
  if (view.startsWith("admin-")) {
    if (id(filters.companyId)) query.set("companyId", id(filters.companyId));
    if (id(filters.tenantCompanyId)) query.set("tenantCompanyId", id(filters.tenantCompanyId));
  }
  if (text(filters.month)) query.set("month", text(filters.month));
  if (text(filters.status)) query.set("status", text(filters.status));
  if (text(filters.owner)) query.set("owner", text(filters.owner));
  if (text(filters.due) && filters.due !== "all") query.set("due", text(filters.due));
  const payload = await apiRequest<unknown>(`/api/integration/strategy/workspace?${query.toString()}`, { signal, cache: "no-store" });
  return normalizeStage230Workspace(payload, view);
}

export function newStage230ClientRequestId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `stage230-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function post(path: string, body: UnknownRecord) {
  return apiRequest<unknown>(path, { method: "POST", body: JSON.stringify(body) });
}

function patch(path: string, body: UnknownRecord) {
  return apiRequest<unknown>(path, { method: "PATCH", body: JSON.stringify(body) });
}

type AdminTarget = { companyId?: string; tenantCompanyId?: string };
const targetPayload = (input: AdminTarget): UnknownRecord => ({
  ...(id(input.companyId) ? { companyId: id(input.companyId) } : {}),
  ...(id(input.tenantCompanyId) ? { tenantCompanyId: id(input.tenantCompanyId) } : {})
});

export const generateStrategies = (input: { month: string; reportId?: string; clientRequestId: string } & AdminTarget) => post("/api/integration/strategy/strategies/generate", {
  ...targetPayload(input), month: text(input.month), reportId: id(input.reportId), clientRequestId: id(input.clientRequestId)
});

export const createActionPlan = (input: { month: string; title: string; owner: string; dueDate: string; strategyIds?: readonly string[]; candidateIds?: readonly string[]; clientRequestId: string } & AdminTarget) => post("/api/integration/strategy/plans", {
  ...targetPayload(input), month: text(input.month), title: text(input.title), owner: text(input.owner), dueDate: text(input.dueDate),
  strategyIds: (input.strategyIds || []).map(id).filter(Boolean), candidateIds: (input.candidateIds || []).map(id).filter(Boolean), clientRequestId: id(input.clientRequestId)
});

export const updateActionPlan = (planId: string, input: Partial<Pick<ActionPlanView, "title" | "status" | "owner" | "dueDate" | "notes">> & { expectedVersion?: number } & AdminTarget) => patch(`/api/integration/strategy/plans/${encodeURIComponent(id(planId))}`, { ...input, ...targetPayload(input) } as UnknownRecord);

export const createPlanItem = (planId: string, input: { clientRequestId: string; strategyId: string; title: string; owner: string; dueDate: string; notes?: string; repeatNextMonth?: boolean; checklist?: readonly { checklistId: string; label: string; required: boolean }[] } & AdminTarget) => post(`/api/integration/strategy/plans/${encodeURIComponent(id(planId))}/items`, {
  ...input, ...targetPayload(input), clientRequestId: id(input.clientRequestId), strategyId: id(input.strategyId), title: text(input.title), owner: text(input.owner), dueDate: text(input.dueDate), notes: text(input.notes)
});

export const updatePlanItem = (planId: string, itemId: string, input: Partial<Pick<PlanItemView, "title" | "owner" | "dueDate" | "status" | "notes" | "repeatNextMonth">> & { checklistUpdates?: readonly { checklistId: string; completed: boolean }[] } & AdminTarget) => patch(`/api/integration/strategy/plans/${encodeURIComponent(id(planId))}/items/${encodeURIComponent(id(itemId))}`, { ...input, ...targetPayload(input) } as UnknownRecord);

export const createItemKpi = (planId: string, itemId: string, input: { clientRequestId: string; metricKey: string; label: string; unit: string; direction: string; targetValue: number } & AdminTarget) => post(`/api/integration/strategy/plans/${encodeURIComponent(id(planId))}/items/${encodeURIComponent(id(itemId))}/kpis`, {
  ...input, ...targetPayload(input), clientRequestId: id(input.clientRequestId), metricKey: text(input.metricKey), label: text(input.label), unit: text(input.unit), direction: text(input.direction)
});

export const updateItemKpi = (planId: string, itemId: string, kpiId: string, input: { currentValue?: number; targetValue?: number; expectedVersion?: number } & AdminTarget) => patch(`/api/integration/strategy/plans/${encodeURIComponent(id(planId))}/items/${encodeURIComponent(id(itemId))}/kpis/${encodeURIComponent(id(kpiId))}`, { ...input, ...targetPayload(input) });

export const createRetrospective = (input: { planId: string; clientRequestId: string; summary: string; incompleteReasons: readonly { itemId: string; reason: string }[] } & AdminTarget) => post("/api/integration/strategy/retrospectives", {
  ...targetPayload(input), planId: id(input.planId), clientRequestId: id(input.clientRequestId), summary: text(input.summary),
  incompleteReasons: input.incompleteReasons.map((entry) => ({ itemId: id(entry.itemId), reason: text(entry.reason) })).filter((entry) => entry.itemId && entry.reason)
});

export const generateNextMonthCandidates = (retrospectiveId: string, input: { clientRequestId: string; targetMonth: string } & AdminTarget) => post(`/api/integration/strategy/retrospectives/${encodeURIComponent(id(retrospectiveId))}/candidates`, {
  ...targetPayload(input), clientRequestId: id(input.clientRequestId), targetMonth: text(input.targetMonth)
});
