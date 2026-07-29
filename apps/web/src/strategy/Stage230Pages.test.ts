import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { normalizeStage230Workspace } from "./stage230Client";
import { AdminWorkspaceControls, ExecutionView, RetrospectiveView, StrategyView } from "./Stage230Pages";
import { stage230Payload } from "./stage230Client.test";

describe("Stage 230 V3 business surfaces", () => {
  it("renders strategy cards with evidence, confidence, checklist, KPI, lineage and flow navigation", () => {
    const workspace = normalizeStage230Workspace(stage230Payload, "business-strategy");
    const markup = renderToStaticMarkup(createElement(StrategyView, { workspace }));
    expect(markup).toContain('data-testid="stage230-metrics"');
    expect(markup).toContain('data-testid="stage230-strategy-card"');
    expect(markup).toContain('data-testid="stage230-checklist"');
    expect(markup).toContain('data-testid="stage230-kpi"');
    expect(markup).toContain('data-testid="stage230-lineage"');
    expect(markup).toContain('href="/app/execution"');
    expect(markup).not.toMatch(/cmp_private|tenant_private|report_private/);
  });

  it("renders filters, overdue/this-week board, plan items, KPI input and retrospective link", () => {
    const workspace = normalizeStage230Workspace(stage230Payload, "business-execution");
    const markup = renderToStaticMarkup(createElement(ExecutionView, { workspace, filters: { due: "all" } }));
    expect(markup).toContain('data-testid="stage230-board"');
    expect(markup).toContain("이번 주");
    expect(markup).toContain("지연");
    expect(markup).toContain("KPI 저장");
    expect(markup).toContain('href="/app/retrospective"');
  });

  it("renders execution/KPI rates, incomplete reasons and carryover candidates", () => {
    const workspace = normalizeStage230Workspace(stage230Payload, "business-retrospective");
    const markup = renderToStaticMarkup(createElement(RetrospectiveView, { workspace }));
    expect(markup).toContain('data-testid="stage230-retrospective"');
    expect(markup).toContain('data-testid="stage230-candidates"');
    expect(markup).toContain("실행률");
    expect(markup).toContain("KPI 달성률");
    expect(markup).toContain("이월");
    expect(markup).toContain('data-candidate-status="candidate"');
    expect(markup).toContain('data-candidate-status="planned"');
    expect(markup).toContain('data-testid="stage230-candidate-plan-form"');
    expect(markup).toContain("적용 계획 plan_001");
    expect(markup).toContain("선택 후보로 계획 생성");
    expect(markup).toContain('href="/app/strategy"');
  });

  it("uses only admin composite-tab links on admin surfaces", () => {
    const strategy = renderToStaticMarkup(createElement(StrategyView, { workspace: normalizeStage230Workspace(stage230Payload, "admin-strategy"), admin: true }));
    const execution = renderToStaticMarkup(createElement(ExecutionView, { workspace: normalizeStage230Workspace(stage230Payload, "admin-execution"), filters: {}, admin: true }));
    const retrospective = renderToStaticMarkup(createElement(RetrospectiveView, { workspace: normalizeStage230Workspace(stage230Payload, "admin-retrospective"), admin: true }));
    expect(strategy).toContain('href="/admin/stage-review?view=execution"');
    expect(strategy).toContain('href="/admin/location"');
    expect(execution).toContain('href="/admin/stage-review?view=strategy"');
    expect(execution).toContain('href="/admin/stage-review?view=retrospective"');
    expect(retrospective).toContain('href="/admin/stage-review?view=execution"');
    expect(`${strategy}${execution}${retrospective}`).not.toMatch(/href="\/app\/(?:strategy|execution|retrospective)/);
  });

  it("keeps blocked admin CTAs inside admin routes", () => {
    const blockedPayload = { state: "insufficient-confidence", reportGate: { state: "insufficient-confidence" } };
    const strategy = renderToStaticMarkup(createElement(StrategyView, { workspace: normalizeStage230Workspace(blockedPayload, "admin-strategy"), admin: true }));
    const execution = renderToStaticMarkup(createElement(ExecutionView, { workspace: normalizeStage230Workspace(blockedPayload, "admin-execution"), filters: {}, admin: true }));
    const retrospective = renderToStaticMarkup(createElement(RetrospectiveView, { workspace: normalizeStage230Workspace(blockedPayload, "admin-retrospective"), admin: true }));
    const markup = `${strategy}${execution}${retrospective}`;
    expect(markup).toContain('href="/admin/location"');
    expect(markup).not.toMatch(/href="\/app\//);
  });

  it("uses a browser-safe HTML pattern for explicit admin targets", () => {
    const markup = renderToStaticMarkup(createElement(AdminWorkspaceControls, { routeId: "admin-strategy", filters: {}, onApply: () => undefined }));
    expect(markup).toContain('pattern="[A-Za-z0-9][A-Za-z0-9:._\\-]*"');
    expect(markup).not.toContain("[A-Za-z0-9:._-]");
  });

  it("keeps not-published and insufficient states explicit without rendering strategies", () => {
    const unpublished = normalizeStage230Workspace({ state: "not-published-report", reportGate: { state: "not-published-report" } }, "business-strategy");
    const insufficient = normalizeStage230Workspace({ state: "insufficient-confidence", reportGate: { state: "insufficient-confidence" } }, "business-strategy");
    const unpublishedMarkup = renderToStaticMarkup(createElement(StrategyView, { workspace: unpublished }));
    const insufficientMarkup = renderToStaticMarkup(createElement(StrategyView, { workspace: insufficient }));
    expect(unpublishedMarkup).toContain('data-stage230-state="not-published-report"');
    expect(insufficientMarkup).toContain('data-stage230-state="insufficient-confidence"');
    expect(unpublishedMarkup).not.toContain('data-testid="stage230-strategy-card"');
    expect(insufficientMarkup).not.toContain('data-testid="stage230-strategy-card"');
  });
});
