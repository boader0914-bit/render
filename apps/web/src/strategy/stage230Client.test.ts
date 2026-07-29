import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createActionPlan,
  normalizeStage230Workspace,
  readStage230Workspace,
  stage230AdminTargetReady
} from "./stage230Client";

export const stage230Payload = {
  ok: true,
  metadata: { stage: 230, generatedAt: "2026-07-29T10:00:00.000Z" },
  view: "business-execution",
  state: "ready",
  month: "2026-08",
  companyId: "cmp_private_owner",
  tenantCompanyId: "tenant_private_owner",
  reportGate: { state: "ready", label: "공개 리포트 기준 충족", reportMonth: "2026-08", confidenceLabel: "높음" },
  strategies: [{
    strategyId: "strategy_price_001",
    companyId: "cmp_private_owner",
    month: "2026-08",
    reportId: "report_private_001",
    domain: "price",
    ruleVersion: "v2-stage230-rules-v1",
    title: "주말 가격 구간 점검",
    summary: "내 숙소와 익명 비교군의 공개 지표 차이를 점검합니다.",
    confidence: { level: "high", reasons: ["공개 리포트 신뢰도 충족"] },
    difficulty: "low",
    expectedEffect: { metricKey: "sold-rate", label: "판매율", direction: "increase", minimum: 3, maximum: 5, unit: "%p" },
    executionTiming: { startDate: "2026-08-01", dueDate: "2026-08-07", label: "첫째 주" },
    evidence: [{ scope: "own", metricKey: "sold-rate", label: "내 숙소 판매율", value: 58, unit: "%", sampleCount: 4 }],
    checklist: [{ checklistId: "check_price_001", label: "가격표 검토", required: true }],
    kpiTemplate: { metricKey: "sold-rate", label: "판매율", unit: "%", direction: "increase", targetValue: 62 },
    lineage: { sourceReportId: "report_private_001", sourceReportMonth: "2026-08", sourceAlgorithmVersion: "stage229-v1", ruleVersion: "v2-stage230-rules-v1", evidenceKeys: ["own:sold-rate"], generatedAt: "2026-07-29", generatedBy: "deterministic-rule" }
  }],
  plans: [{
    planId: "plan_001", companyId: "cmp_private_owner", month: "2026-08", title: "8월 실행계획", status: "active", owner: "운영자", dueDate: "2026-08-31", notes: "", strategyIds: ["strategy_price_001"], candidateIds: ["candidate_planned_001"], lineage: { candidateIds: ["candidate_planned_001"], sourceRetrospectiveIds: ["retro_001"], sourceReportMonth: "2026-08", appliedAt: "2026-08-31", appliedBy: "사업자" }, version: 2,
    items: [{
      itemId: "item_001", strategyId: "strategy_price_001", title: "주말 가격표 수정", owner: "운영자", dueDate: "2026-08-07", status: "in-progress", notes: "공개 채널 반영", repeatNextMonth: true,
      checklist: [{ checklistId: "check_price_001", label: "가격표 검토", required: true, completed: true, completedAt: "2026-08-01" }],
      kpis: [{ kpiId: "kpi_001", metricKey: "sold-rate", label: "판매율", unit: "%", direction: "increase", targetValue: 62, currentValue: 60, inputState: "entered", achieved: false, version: 2, updatedAt: "2026-08-02" }],
      lineage: { sourceReportMonth: "2026-08", sourceReportVersion: 3, sourceReportPublishedAt: "2026-07-29", ruleVersion: "v2-stage230-rules-v1", evidenceKeys: ["own:sold-rate"], appliedAt: "2026-08-01", appliedBy: "사업자" }, createdAt: "2026-08-01", updatedAt: "2026-08-02"
    }]
  }],
  board: { summary: { total: 1, planned: 0, inProgress: 1, blocked: 0, done: 0, overdue: 0, thisWeek: 1 }, items: [] },
  retrospectives: [{ retrospectiveId: "retro_001", planId: "plan_001", companyId: "cmp_private_owner", month: "2026-08", execution: { done: 1, total: 2, rate: 50 }, kpis: { achieved: 1, entered: 1, total: 2, achievementRate: 50, missing: 1 }, incompleteReasons: [{ itemId: "item_001", title: "주말 가격표 수정", reason: "승인 대기" }], summary: "진행 항목을 다음 달로 이월합니다.", lineage: { sourceReportMonth: "2026-08", ruleVersion: "v2-stage230-rules-v1" }, createdAt: "2026-08-31" }],
  candidates: [
    { candidateId: "candidate_001", type: "carryover", targetMonth: "2026-09", status: "candidate", strategyId: "strategy_price_001", sourceItemId: "item_001", title: "주말 가격표 수정", reason: "미완료 이월", lineage: { sourceReportMonth: "2026-08", ruleVersion: "v2-stage230-rules-v1" }, createdAt: "2026-08-31" },
    { candidateId: "candidate_planned_001", type: "repeat", targetMonth: "2026-09", status: "planned", plannedInPlanId: "plan_001", appliedAt: "2026-08-31T12:00:00.000Z", appliedBy: "사업자", strategyId: "strategy_price_001", sourceItemId: "item_001", title: "가격 점검 반복", reason: "반복 실행", lineage: { sourceReportMonth: "2026-08", ruleVersion: "v2-stage230-rules-v1", appliedAt: "2026-08-31T12:00:00.000Z", appliedBy: "사업자" }, createdAt: "2026-08-31" }
  ],
  limits: { allowed: true, plan: "pro" }
};

afterEach(() => vi.unstubAllGlobals());

describe("Stage 230 business-safe client", () => {
  it("normalizes deterministic strategy, execution, KPI, retrospective and candidate contracts", () => {
    const workspace = normalizeStage230Workspace(stage230Payload, "business-execution");
    expect(workspace).toMatchObject({ stage: 230, state: "ready", month: "2026-08", dataBoundary: "published-stage229-business-safe-only", projection: "business-safe" });
    expect(workspace.strategies[0]).toMatchObject({ domain: "price", ruleVersion: "v2-stage230-rules-v1", expectedEffect: { displayRange: "3~5%p" } });
    expect(workspace.plans[0].items[0]).toMatchObject({ status: "in-progress", repeatNextMonth: true });
    expect(workspace.plans[0]).toMatchObject({ candidateIds: ["candidate_planned_001"], lineage: { candidateIds: ["candidate_planned_001"], sourceRetrospectiveIds: ["retro_001"], generatedBy: "사업자" } });
    expect(workspace.plans[0].items[0].lineage).toMatchObject({ sourceReportVersion: 3, sourceReportPublishedAt: "2026-07-29", generatedAt: "2026-08-01", generatedBy: "사업자" });
    expect(workspace.plans[0].items[0].kpis[0]).toMatchObject({ inputState: "entered", currentValue: 60, version: 2 });
    expect(workspace.retrospectives[0]).toMatchObject({ execution: { rate: 50 }, kpis: { missing: 1 } });
    expect(workspace.candidates[0]).toMatchObject({ type: "carryover", typeLabel: "이월" });
    expect(workspace.candidates[1]).toMatchObject({ status: "planned", plannedInPlanId: "plan_001", appliedBy: "사업자" });
  });

  it("does not project tenant, company, report IDs, raw paths or internal formulas", () => {
    const workspace = normalizeStage230Workspace({
      ...stage230Payload,
      strategies: [{ ...stage230Payload.strategies[0], summary: "C:\\private\\raw.json", internalFormula: "peer company id cmp_other" }]
    }, "business-strategy");
    const serialized = JSON.stringify(workspace);
    expect(serialized).not.toMatch(/cmp_private|tenant_private|report_private|raw\.json|internalFormula|peer company/i);
  });

  it("keeps not-published and insufficient confidence states distinct", () => {
    expect(normalizeStage230Workspace({ state: "not-published-report", reportGate: { state: "not-published-report" } }, "business-strategy").state).toBe("not-published-report");
    expect(normalizeStage230Workspace({ state: "insufficient-confidence", reportGate: { state: "insufficient-confidence" } }, "business-strategy").state).toBe("insufficient-confidence");
  });

  it("sends only business-safe filters to the workspace route", async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify(stage230Payload), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    await readStage230Workspace("business-execution", { month: "2026-08", status: "in-progress", owner: "운영자", due: "this-week" });
    expect(fetchMock).toHaveBeenCalledWith("/api/integration/strategy/workspace?view=business-execution&month=2026-08&status=in-progress&owner=%EC%9A%B4%EC%98%81%EC%9E%90&due=this-week", expect.any(Object));
    expect(String(fetchMock.mock.calls[0][0])).not.toMatch(/companyId|tenantCompanyId/);
  });

  it("requires and sends both explicit target IDs for admin workspaces", async () => {
    expect(stage230AdminTargetReady({})).toBe(false);
    expect(stage230AdminTargetReady({ companyId: "cmp_admin_001" })).toBe(false);
    expect(stage230AdminTargetReady({ companyId: "cmp_admin_001", tenantCompanyId: "tenant_admin_001" })).toBe(true);
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify(stage230Payload), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    await readStage230Workspace("admin-strategy", { companyId: "cmp_admin_001", tenantCompanyId: "tenant_admin_001" });
    expect(fetchMock).toHaveBeenCalledWith("/api/integration/strategy/workspace?view=admin-strategy&companyId=cmp_admin_001&tenantCompanyId=tenant_admin_001", expect.any(Object));
  });

  it("sends selected candidate IDs with the explicit admin target when creating a next-month plan", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
      if (String(input) === "/api/auth/csrf") return new Response(JSON.stringify({ csrfToken: "csrf-stage230-candidate-plan" }), { status: 200, headers: { "Content-Type": "application/json" } });
      return new Response(JSON.stringify({ ok: true }), { status: 201, headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    await createActionPlan({
      tenantCompanyId: "tenant_admin_001",
      companyId: "cmp_admin_001",
      month: "2026-09",
      title: "9월 후보 실행계획",
      owner: "관리자",
      dueDate: "2026-09-30",
      candidateIds: ["candidate_001"],
      clientRequestId: "stage230-candidate-plan-request"
    });
    const [, init] = fetchMock.mock.calls.at(-1) || [];
    const body = JSON.parse(String(init?.body || "{}"));
    expect(body).toMatchObject({ tenantCompanyId: "tenant_admin_001", companyId: "cmp_admin_001", candidateIds: ["candidate_001"], strategyIds: [] });
  });
});
