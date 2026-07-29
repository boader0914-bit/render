import { useEffect, useState, type ReactNode } from "react";
import { Button, EmptyState, MetricCard, StatusBadge } from "@glamping-datalab-v2/ui";
import type { SessionPayload } from "../apiClient";
import {
  createActionPlan,
  createPlanItem,
  createRetrospective,
  generateNextMonthCandidates,
  generateStrategies,
  newStage230ClientRequestId,
  stage230AdminTargetReady,
  updateActionPlan,
  updateItemKpi,
  updatePlanItem,
  type ActionPlanView,
  type ItemStatus,
  type Stage230Filters,
  type Stage230RouteId,
  type Stage230State,
  type Stage230Workspace,
  type StrategyCardView
} from "./stage230Client";
import { useStage230Workspace, type Stage230LoadState } from "./useStage230Workspace";

function Section({ title, description, actions, children, testId }: {
  title: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
  testId?: string;
}) {
  return <section className="v2-data-section" data-testid={testId}>
    <header className="v2-section-header"><div><h2>{title}</h2>{description ? <p>{description}</p> : null}</div>{actions ? <div className="v2-section-actions">{actions}</div> : null}</header>
    {children}
  </section>;
}

const STATE_CONTENT: Readonly<Record<Stage230State, { title: string; description: string; badge: string }>> = Object.freeze({
  "not-published-report": {
    title: "공개된 월간 리포트가 필요합니다",
    description: "초안이나 검수 중 리포트에서는 전략을 만들지 않습니다. Stage 229에서 공개된 business-safe 리포트만 사용할 수 있습니다.",
    badge: "리포트 미공개"
  },
  "insufficient-confidence": {
    title: "전략을 만들기에 신뢰도가 부족합니다",
    description: "표본이 부족한 리포트에서 추천값을 꾸며내지 않습니다. 신규 반복 관측과 confidence 기준을 먼저 충족해 주세요.",
    badge: "신뢰도 부족"
  },
  empty: {
    title: "아직 생성된 항목이 없습니다",
    description: "승인된 공개 리포트가 준비되면 deterministic rule로 전략과 실행계획을 만들 수 있습니다.",
    badge: "빈 상태"
  },
  ready: { title: "준비됨", description: "신규 수집 근거의 공개 월간 리포트를 사용합니다.", badge: "준비됨" }
});

function WorkspaceState({ state, reportPath = "/app/report" }: { state: Exclude<Stage230State, "ready">; reportPath?: string }) {
  const content = STATE_CONTENT[state];
  return <div className="v2-stage230-state" data-testid="stage230-state" data-stage230-state={state}>
    <EmptyState title={content.title} description={content.description} action={state === "not-published-report" || state === "insufficient-confidence"
      ? <a className="v2-button v2-button--primary" data-testid="stage230-report-link" href={reportPath}>월간 리포트 확인</a>
      : <StatusBadge tone="neutral">{content.badge}</StatusBadge>} />
  </div>;
}

function LoadState({ state, message }: { state: Exclude<Stage230LoadState, "ready">; message?: string }) {
  const content = {
    loading: ["전략·실행 데이터를 확인하고 있습니다", "published report와 tenant·entitlement 경계를 확인합니다."],
    permission: ["이 운영 데이터에 접근할 수 없습니다", "화면 숨김과 별도로 server가 tenant와 entitlement를 403으로 차단합니다."],
    unavailable: ["전략·실행 기능이 꺼져 있습니다", "각 기능은 기본 OFF이며 승인된 feature flag와 선행 기능이 모두 켜진 경우에만 요청합니다."],
    error: ["전략·실행 데이터를 불러오지 못했습니다", message || "내부 정보나 이전 값을 대신 표시하지 않습니다. 잠시 후 다시 시도해 주세요."]
  }[state];
  return <Section title="전략·실행 상태" testId="stage230-state"><EmptyState title={content[0]} description={content[1]} action={<StatusBadge tone={state === "loading" ? "info" : "warning"}>{state === "loading" ? "확인 중" : "fail closed"}</StatusBadge>} /></Section>;
}

function WorkspaceMetrics({ workspace }: { workspace: Stage230Workspace }) {
  return <div className="v2-metric-grid v2-stage230-metrics" aria-label="Stage 230 핵심 지표" data-testid="stage230-metrics">
    {workspace.metrics.map((metric) => <MetricCard key={metric.id} label={metric.label} value={metric.value} detail={metric.detail} tone={metric.tone} />)}
  </div>;
}

function Feedback({ value }: { value: string }) {
  if (!value) return null;
  return <p className="v2-core-notice" data-tone={value.startsWith("완료") ? "success" : "danger"} role={value.startsWith("완료") ? "status" : "alert"}>{value}</p>;
}

function Lineage({ strategy }: { strategy: StrategyCardView }) {
  return <div className="v2-stage230-lineage" data-testid="stage230-lineage">
    <span>근거 lineage</span>
    <strong>{strategy.lineage.sourceReportMonth || "리포트 월 확인"}{strategy.lineage.sourceReportVersion === null ? "" : ` · report v${strategy.lineage.sourceReportVersion}`} · {strategy.ruleVersion || strategy.lineage.ruleVersion || "rule version 확인"}</strong>
    <small>{strategy.lineage.sourceAlgorithmVersion || "알고리즘 version 확인"} · 공개 {strategy.lineage.sourceReportPublishedAt || "시각 확인"} · 근거 {strategy.lineage.evidenceKeys.length || strategy.evidence.length}개</small>
    <small>적용 {strategy.lineage.generatedBy || "deterministic-rule"} · {strategy.lineage.generatedAt || "시각 확인"}</small>
  </div>;
}

export function StrategyView({ workspace, busy = false, feedback = "", admin = false, onGenerate }: {
  workspace: Stage230Workspace;
  busy?: boolean;
  feedback?: string;
  admin?: boolean;
  onGenerate?: () => void;
}) {
  const generationReady = workspace.reportGate.state === "ready";
  const blockedGateState: "not-published-report" | "insufficient-confidence" = workspace.reportGate.state === "insufficient-confidence"
    ? "insufficient-confidence" : "not-published-report";
  return <>
    <WorkspaceMetrics workspace={workspace} />
    <Section title="전략 생성 기준" description={workspace.reportGate.detail} actions={<><StatusBadge tone={generationReady ? "success" : "warning"}>{workspace.reportGate.label}</StatusBadge><a className="v2-button v2-button--quiet" data-testid="stage230-report-link" href={admin ? "/admin/location" : workspace.reportGate.reportPath}>{admin ? "관리자 입지·리포트 근거" : "근거 리포트"}</a></>}>
      {!generationReady ? <WorkspaceState state={blockedGateState} reportPath={admin ? "/admin/location" : workspace.reportGate.reportPath} /> : <div className="v2-stage230-gate">
        <div><span>대상 월</span><strong>{workspace.reportGate.reportMonth || workspace.month || "확인 중"}</strong></div>
        <div><span>Confidence</span><strong>{workspace.reportGate.confidenceLabel || "기준 충족"}</strong></div>
        <Button type="button" disabled={busy || !workspace.limits.allowed} onClick={onGenerate}>deterministic 전략 생성</Button>
      </div>}
      {!workspace.limits.allowed ? <p className="v2-core-notice" data-tone="warning">{workspace.limits.reason || `${workspace.limits.plan} entitlement에서 사용할 수 없습니다.`}</p> : null}
      <Feedback value={feedback} />
    </Section>
    {generationReady ? <Section title="추천 전략" description="가격·채널·상품·콘텐츠·리드타임 고정 rule의 결과만 표시합니다." actions={<a className="v2-button v2-button--secondary" href={admin ? "/admin/stage-review?view=execution" : "/app/execution"}>실행계획으로 이동</a>}>
      {workspace.strategies.length ? <div className="v2-stage230-strategy-grid">{workspace.strategies.map((strategy) => <article key={strategy.strategyId} className="v2-stage230-strategy-card" data-testid="stage230-strategy-card" data-domain={strategy.domain}>
        <header><div><StatusBadge tone="info">{strategy.domainLabel}</StatusBadge><small>{strategy.ruleVersion || "version 확인"}</small></div><StatusBadge tone={strategy.confidence.level === "high" ? "success" : "warning"}>신뢰도 {strategy.confidence.label}</StatusBadge></header>
        <div className="v2-stage230-card-copy"><h3>{strategy.title}</h3><p>{strategy.summary}</p></div>
        <p className="v2-stage230-confidence">신뢰도 근거 · {strategy.confidence.reasons.join(" · ") || "공개 리포트 confidence 기준"}</p>
        <dl className="v2-stage230-facts">
          <div><dt>난이도</dt><dd>{strategy.difficultyLabel}</dd></div>
          <div><dt>{strategy.expectedEffect.label}</dt><dd>{strategy.expectedEffect.displayRange}</dd></div>
          <div><dt>실행 시점</dt><dd>{strategy.executionTiming.label}</dd></div>
        </dl>
        <div className="v2-stage230-evidence"><strong>근거 지표</strong>{strategy.evidence.length ? <ul>{strategy.evidence.map((evidence) => <li key={evidence.key}><span>{evidence.label}</span><b>{evidence.displayValue || "값 확인"}</b><small>{evidence.sampleCount === null ? "표본 확인" : `표본 ${evidence.sampleCount}개`}</small></li>)}</ul> : <p>공개 가능한 근거 지표를 확인 중입니다.</p>}</div>
        <div data-testid="stage230-checklist" className="v2-stage230-template"><strong>체크리스트</strong>{strategy.checklist.length ? <ul>{strategy.checklist.map((item) => <li key={item.checklistId}><span aria-hidden="true">□</span>{item.label}{item.required ? <small>필수</small> : null}</li>)}</ul> : <p>실행계획 생성 시 체크리스트를 확인합니다.</p>}</div>
        <div data-testid="stage230-kpi" className="v2-stage230-template"><strong>추적 KPI</strong><p>{strategy.kpiTemplate ? `${strategy.kpiTemplate.label} · 목표 ${strategy.kpiTemplate.targetValue ?? "확인"}${strategy.kpiTemplate.unit}` : "KPI template 확인 중"}</p></div>
        <Lineage strategy={strategy} />
      </article>)}</div> : <WorkspaceState state="empty" />}
    </Section> : null}
  </>;
}

function Filters({ value, onChange }: { value: Stage230Filters; onChange: (next: Stage230Filters) => void }) {
  return <form className="v2-stage230-filters" aria-label="실행계획 필터" onSubmit={(event) => event.preventDefault()}>
    <label><span>상태</span><select value={value.status || ""} onChange={(event) => onChange({ ...value, status: event.target.value })}><option value="">전체</option><option value="planned">계획</option><option value="in-progress">진행 중</option><option value="blocked">차단</option><option value="done">완료</option></select></label>
    <label><span>담당자</span><input value={value.owner || ""} onChange={(event) => onChange({ ...value, owner: event.target.value })} placeholder="담당자" /></label>
    <label><span>목표일</span><select value={value.due || "all"} onChange={(event) => onChange({ ...value, due: event.target.value as Stage230Filters["due"] })}><option value="all">전체</option><option value="overdue">지연</option><option value="this-week">이번 주</option></select></label>
  </form>;
}

function KpiControl({ planId, itemId, kpi, busy, onSave }: {
  planId: string;
  itemId: string;
  kpi: ActionPlanView["items"][number]["kpis"][number];
  busy: boolean;
  onSave?: (planId: string, itemId: string, kpiId: string, value: number, version: number) => void;
}) {
  const [value, setValue] = useState(kpi.currentValue === null ? "" : String(kpi.currentValue));
  return <div className="v2-stage230-kpi" data-testid="stage230-kpi">
    <div><strong>{kpi.label}</strong><StatusBadge tone={kpi.inputState === "missing" ? "warning" : kpi.achieved ? "success" : "info"}>{kpi.inputState === "missing" ? "미입력" : kpi.achieved ? "달성" : "입력됨"}</StatusBadge></div>
    <p>목표 {kpi.targetValue ?? "확인"}{kpi.unit} · 현재 {kpi.currentValue ?? "미입력"}{kpi.currentValue === null ? "" : kpi.unit}</p>
    <form onSubmit={(event) => { event.preventDefault(); const numeric = Number(value); if (Number.isFinite(numeric)) onSave?.(planId, itemId, kpi.kpiId, numeric, kpi.version); }}>
      <label><span className="v2-visually-hidden">{kpi.label} 현재값</span><input type="number" step="any" value={value} onChange={(event) => setValue(event.target.value)} placeholder="현재값" /></label>
      <Button type="submit" variant="secondary" disabled={busy || value === ""}>KPI 저장</Button>
    </form>
    <small>변경 audit · version {kpi.version} · {kpi.updatedAt || "아직 입력 없음"}</small>
  </div>;
}

function PlanCard({ plan, strategies, busy, onPlanStatus, onItemStatus, onChecklist, onKpi, onAddItem }: {
  plan: ActionPlanView;
  strategies: readonly StrategyCardView[];
  busy: boolean;
  onPlanStatus?: (plan: ActionPlanView, status: ActionPlanView["status"]) => void;
  onItemStatus?: (planId: string, itemId: string, status: ItemStatus) => void;
  onChecklist?: (planId: string, itemId: string, checklistId: string, completed: boolean) => void;
  onKpi?: (planId: string, itemId: string, kpiId: string, value: number, version: number) => void;
  onAddItem?: (plan: ActionPlanView, form: HTMLFormElement) => void;
}) {
  return <article className="v2-stage230-plan">
    <header><div><h3>{plan.title}</h3><p>{plan.month} · 담당 {plan.owner} · 목표일 {plan.dueDate || "미지정"}</p></div><label><span className="v2-visually-hidden">계획 상태</span><select value={plan.status} disabled={busy} onChange={(event) => onPlanStatus?.(plan, event.target.value as ActionPlanView["status"])}><option value="draft">초안</option><option value="active">진행</option><option value="completed">완료</option><option value="cancelled">취소</option></select></label></header>
    {plan.candidateIds.length ? <small className="v2-stage230-audit" data-testid="stage230-lineage">후보 {plan.candidateIds.length}개 · 원천 회고 {plan.lineage.sourceRetrospectiveIds.length}개 · 적용 {plan.lineage.generatedBy} {plan.lineage.generatedAt}</small> : null}
    <div className="v2-stage230-items">{plan.items.map((item) => <section key={item.itemId} className="v2-stage230-item" data-item-status={item.status}>
      <header><div><strong>{item.title}</strong><small>{item.owner} · {item.dueDate || "목표일 미지정"}</small></div><select aria-label={`${item.title} 상태`} value={item.status} disabled={busy} onChange={(event) => onItemStatus?.(plan.planId, item.itemId, event.target.value as ItemStatus)}><option value="planned">계획</option><option value="in-progress">진행 중</option><option value="blocked">차단</option><option value="done">완료</option><option value="cancelled">취소</option></select></header>
      {item.notes ? <p>{item.notes}</p> : null}
      <ul className="v2-stage230-checklist" data-testid="stage230-checklist">{item.checklist.map((check) => <li key={check.checklistId}><label><input type="checkbox" checked={check.completed} disabled={busy} onChange={(event) => onChecklist?.(plan.planId, item.itemId, check.checklistId, event.target.checked)} /><span>{check.label}</span></label>{check.required ? <small>필수</small> : null}</li>)}</ul>
      {item.kpis.map((kpi) => <KpiControl key={kpi.kpiId} planId={plan.planId} itemId={item.itemId} kpi={kpi} busy={busy} onSave={onKpi} />)}
      <small className="v2-stage230-audit">lineage {item.lineage.sourceReportMonth || plan.month} · 적용 {item.lineage.generatedBy} {item.lineage.generatedAt} · 변경 {item.updatedAt || item.createdAt}</small>
    </section>)}</div>
    <form className="v2-stage230-add-form" onSubmit={(event) => { event.preventDefault(); onAddItem?.(plan, event.currentTarget); }}>
      <label><span>연결 전략</span><select name="strategyId" required>{strategies.filter((strategy) => plan.strategyIds.includes(strategy.strategyId)).map((strategy) => <option key={strategy.strategyId} value={strategy.strategyId}>{strategy.domainLabel} · {strategy.title}</option>)}</select></label>
      <label><span>새 실행 항목</span><input name="title" required placeholder="실행할 작업" /></label>
      <label><span>담당자</span><input name="owner" required defaultValue={plan.owner} /></label>
      <label><span>목표일</span><input name="dueDate" type="date" required defaultValue={plan.dueDate} /></label>
      <Button type="submit" variant="secondary" disabled={busy || !plan.strategyIds.length}>항목 추가</Button>
    </form>
  </article>;
}

export function ExecutionView({ workspace, filters, busy = false, feedback = "", admin = false, onFiltersChange, onCreatePlan, onPlanStatus, onItemStatus, onChecklist, onKpi, onAddItem }: {
  workspace: Stage230Workspace;
  filters: Stage230Filters;
  busy?: boolean;
  feedback?: string;
  admin?: boolean;
  onFiltersChange?: (filters: Stage230Filters) => void;
  onCreatePlan?: (form: HTMLFormElement) => void;
  onPlanStatus?: (plan: ActionPlanView, status: ActionPlanView["status"]) => void;
  onItemStatus?: (planId: string, itemId: string, status: ItemStatus) => void;
  onChecklist?: (planId: string, itemId: string, checklistId: string, completed: boolean) => void;
  onKpi?: (planId: string, itemId: string, kpiId: string, value: number, version: number) => void;
  onAddItem?: (plan: ActionPlanView, form: HTMLFormElement) => void;
}) {
  return <>
    <WorkspaceMetrics workspace={workspace} />
    {workspace.state !== "ready" && workspace.state !== "empty" ? <Section title="실행계획 준비 상태"><WorkspaceState state={workspace.state} reportPath={admin ? "/admin/location" : workspace.reportGate.reportPath} /></Section> : <>
      <Section title="운영보드" description="상태·담당자·목표일 기준으로 이번 주와 지연 항목을 분리합니다." actions={<a className="v2-button v2-button--quiet" href={admin ? "/admin/stage-review?view=strategy" : "/app/strategy"}>전략 보기</a>} testId="stage230-board">
        <Filters value={filters} onChange={(next) => onFiltersChange?.(next)} />
        <div className="v2-stage230-board-summary">
          <div><span>전체</span><strong>{workspace.board.summary.total}</strong></div><div><span>진행 중</span><strong>{workspace.board.summary.inProgress}</strong></div><div data-tone={workspace.board.summary.overdue ? "warning" : "neutral"}><span>지연</span><strong>{workspace.board.summary.overdue}</strong></div><div><span>이번 주</span><strong>{workspace.board.summary.thisWeek}</strong></div><div><span>완료</span><strong>{workspace.board.summary.done}</strong></div>
        </div>
      </Section>
      <Section title="월간 실행계획" description="담당자·목표일·상태·메모를 가진 계획과 항목을 관리합니다." actions={<a className="v2-button v2-button--secondary" href={admin ? "/admin/stage-review?view=retrospective" : "/app/retrospective"}>월간 회고</a>}>
        <form className="v2-stage230-plan-form" onSubmit={(event) => { event.preventDefault(); onCreatePlan?.(event.currentTarget); }}>
          <label><span>계획명</span><input name="title" required defaultValue={`${workspace.month || "다음달"} 실행계획`} /></label>
          <label><span>담당자</span><input name="owner" required placeholder="담당자" /></label>
          <label><span>목표일</span><input name="dueDate" type="date" required /></label>
          <Button type="submit" disabled={busy || !workspace.strategies.length || !workspace.limits.allowed}>계획 생성</Button>
        </form>
        {!workspace.strategies.length ? <p className="v2-core-notice" data-tone="warning">먼저 공개 리포트 기반 전략을 생성해 주세요.</p> : null}
        <Feedback value={feedback} />
        {workspace.plans.length ? <div className="v2-stage230-plan-list">{workspace.plans.map((plan) => <PlanCard key={plan.planId} plan={plan} strategies={workspace.strategies} busy={busy} onPlanStatus={onPlanStatus} onItemStatus={onItemStatus} onChecklist={onChecklist} onKpi={onKpi} onAddItem={onAddItem} />)}</div> : <WorkspaceState state="empty" />}
      </Section>
    </>}
  </>;
}

export function RetrospectiveView({ workspace, busy = false, feedback = "", admin = false, onCreate, onCandidates, onCreateCandidatePlan }: {
  workspace: Stage230Workspace;
  busy?: boolean;
  feedback?: string;
  admin?: boolean;
  onCreate?: (form: HTMLFormElement) => void;
  onCandidates?: (retrospectiveId: string, targetMonth: string) => void;
  onCreateCandidatePlan?: (input: { candidateIds: readonly string[]; month: string; title: string; owner: string; dueDate: string }) => void;
}) {
  const [targetMonth, setTargetMonth] = useState("");
  const availableCandidates = workspace.candidates.filter((candidate) => candidate.status !== "planned");
  const candidateMonths = [...new Set(availableCandidates.map((candidate) => candidate.targetMonth).filter(Boolean))];
  const [candidatePlanMonth, setCandidatePlanMonth] = useState(candidateMonths[0] || "");
  const [selectedCandidateIds, setSelectedCandidateIds] = useState<readonly string[]>([]);
  const eligibleSelectedIds = selectedCandidateIds.filter((candidateId) => availableCandidates.some((candidate) => candidate.candidateId === candidateId && candidate.targetMonth === candidatePlanMonth));
  const candidateMonthKey = candidateMonths.join("|");
  useEffect(() => {
    if (!candidateMonths.length) {
      if (candidatePlanMonth) setCandidatePlanMonth("");
      return;
    }
    if (!candidateMonths.includes(candidatePlanMonth)) {
      setCandidatePlanMonth(candidateMonths[0]);
      setSelectedCandidateIds([]);
    }
  }, [candidateMonthKey, candidatePlanMonth]);
  return <>
    <WorkspaceMetrics workspace={workspace} />
    {workspace.state !== "ready" && workspace.state !== "empty" ? <Section title="월간 회고 준비 상태"><WorkspaceState state={workspace.state} reportPath={admin ? "/admin/location" : workspace.reportGate.reportPath} /></Section> : <>
      <Section title="월간 회고 작성" description="실행률·KPI 달성률·미완료 원인을 저장하고 다음달 후보의 근거로 사용합니다." actions={<a className="v2-button v2-button--quiet" href={admin ? "/admin/stage-review?view=execution" : "/app/execution"}>실행계획 보기</a>}>
        <form className="v2-stage230-retro-form" onSubmit={(event) => { event.preventDefault(); onCreate?.(event.currentTarget); }}>
          <label><span>대상 계획</span><select name="planId" required>{workspace.plans.length ? workspace.plans.map((plan) => <option value={plan.planId} key={plan.planId}>{plan.title} · {plan.month}</option>) : <option value="">선택 가능한 계획 없음</option>}</select></label>
          <label><span>회고 요약</span><textarea name="summary" required rows={4} placeholder="이번 달 실행 결과와 다음 달에 반영할 내용을 입력하세요." /></label>
          <Button type="submit" disabled={busy || !workspace.plans.length}>회고 저장</Button>
        </form>
        <Feedback value={feedback} />
      </Section>
      <Section title="회고 결과" description="KPI 미입력은 달성으로 간주하지 않으며 변경 이력을 함께 표시합니다." testId="stage230-retrospective">
        {workspace.retrospectives.length ? <div className="v2-stage230-retro-list">{workspace.retrospectives.map((retro) => <article key={retro.retrospectiveId}>
          <header><div><h3>{retro.month} 월간 회고</h3><p>{retro.summary}</p></div><StatusBadge tone="success">저장됨</StatusBadge></header>
          <div className="v2-stage230-retro-metrics"><MetricCard label="실행률" value={`${retro.execution.rate}%`} detail={`${retro.execution.done}/${retro.execution.total} 완료`} tone="success" /><MetricCard label="KPI 달성률" value={`${retro.kpis.achievementRate}%`} detail={`${retro.kpis.achieved}/${retro.kpis.total} 달성`} tone="info" /><MetricCard label="KPI 미입력" value={`${retro.kpis.missing}개`} detail="미입력은 달성 제외" tone={retro.kpis.missing ? "warning" : "success"} /></div>
          {retro.incompleteReasons.length ? <ul>{retro.incompleteReasons.map((item) => <li key={`${item.itemId}:${item.title}`}><strong>{item.title}</strong><span>{item.reason}</span></li>)}</ul> : <p className="v2-inline-empty">기록된 미완료 원인이 없습니다.</p>}
          <div className="v2-stage230-candidate-form"><label><span>다음 대상 월</span><input type="month" value={targetMonth} onChange={(event) => setTargetMonth(event.target.value)} /></label><Button type="button" variant="secondary" disabled={busy || !targetMonth} onClick={() => onCandidates?.(retro.retrospectiveId, targetMonth)}>다음달 후보 생성</Button></div>
          <small className="v2-stage230-audit">lineage {retro.lineage.sourceReportMonth || retro.month} · 적용 {retro.lineage.generatedBy} {retro.lineage.generatedAt} · 생성 {retro.createdAt}</small>
        </article>)}</div> : <WorkspaceState state="empty" />}
      </Section>
      <Section title="다음달 후보" description="이월·반복·신규 후보를 idempotent하게 만들고 출처 lineage를 보존합니다." actions={<a className="v2-button v2-button--secondary" href={admin ? "/admin/stage-review?view=strategy" : "/app/strategy"}>전략 흐름 처음으로</a>} testId="stage230-candidates">
        {workspace.candidates.length ? <div className="v2-stage230-candidate-grid">{workspace.candidates.map((candidate) => {
          const selectable = candidate.status !== "planned" && candidate.targetMonth === candidatePlanMonth;
          const selected = selectable && selectedCandidateIds.includes(candidate.candidateId);
          return <article key={candidate.candidateId} data-candidate-type={candidate.type} data-candidate-status={candidate.status}>
            <header><div className="v2-inline-actions"><StatusBadge tone={candidate.type === "new" ? "success" : candidate.type === "repeat" ? "info" : "warning"}>{candidate.typeLabel}</StatusBadge><StatusBadge tone={candidate.status === "planned" ? "success" : "neutral"}>{candidate.status === "planned" ? "계획 적용됨" : "후보"}</StatusBadge></div><small>{candidate.targetMonth}</small></header>
            <label className="v2-stage230-candidate-select"><input type="checkbox" checked={selected} disabled={busy || !selectable} onChange={(event) => setSelectedCandidateIds((current) => event.target.checked ? [...new Set([...current, candidate.candidateId])] : current.filter((item) => item !== candidate.candidateId))} /><span>{candidate.title}</span></label>
            <p>{candidate.reason}</p>
            {candidate.status === "planned" ? <small className="v2-stage230-applied">적용 계획 {candidate.plannedInPlanId || "연결됨"} · {candidate.appliedBy || "적용자 확인"} · {candidate.appliedAt || "시각 확인"}</small> : null}
            <small data-testid="stage230-lineage">근거 {candidate.lineage.sourceReportMonth || "월 확인"} · {candidate.lineage.ruleVersion || "rule 확인"} · 적용 {candidate.lineage.generatedBy} {candidate.lineage.generatedAt}</small>
          </article>;
        })}</div> : <WorkspaceState state="empty" />}
        {availableCandidates.length ? <form className="v2-stage230-candidate-plan" data-testid="stage230-candidate-plan-form" onSubmit={(event) => {
          event.preventDefault();
          if (!eligibleSelectedIds.length) return;
          onCreateCandidatePlan?.({ candidateIds: eligibleSelectedIds, month: candidatePlanMonth, title: formText(event.currentTarget, "title"), owner: formText(event.currentTarget, "owner"), dueDate: formText(event.currentTarget, "dueDate") });
        }}>
          <label><span>대상 월</span><select value={candidatePlanMonth} onChange={(event) => { setCandidatePlanMonth(event.target.value); setSelectedCandidateIds([]); }}>{candidateMonths.map((month) => <option value={month} key={month}>{month}</option>)}</select></label>
          <label><span>계획명</span><input name="title" required placeholder="다음달 실행계획" /></label>
          <label><span>담당자</span><input name="owner" required placeholder="담당자" /></label>
          <label><span>목표일</span><input name="dueDate" type="date" required /></label>
          <Button type="submit" disabled={busy || !eligibleSelectedIds.length}>선택 후보로 계획 생성</Button>
        </form> : <p className="v2-core-notice" data-tone="success">모든 후보가 실행계획에 적용되었습니다. 이미 적용된 후보는 다시 선택할 수 없습니다.</p>}
      </Section>
    </>}
  </>;
}

function formText(form: HTMLFormElement, name: string): string {
  return String(new FormData(form).get(name) || "").trim();
}

function adminTabHref(view: "strategy" | "execution" | "retrospective", filters: Stage230Filters): string {
  const query = new URLSearchParams({ view });
  if (filters.tenantCompanyId) query.set("tenantCompanyId", filters.tenantCompanyId);
  if (filters.companyId) query.set("companyId", filters.companyId);
  return `/admin/stage-review?${query.toString()}`;
}

export function AdminWorkspaceControls({ routeId, filters, onApply }: { routeId: Stage230RouteId; filters: Stage230Filters; onApply: (filters: Stage230Filters) => void }) {
  const [tenantCompanyId, setTenantCompanyId] = useState(filters.tenantCompanyId || "");
  const [companyId, setCompanyId] = useState(filters.companyId || "");
  return <>
    <nav className="v2-stage230-tabs" aria-label="관리자 전략 운영 화면" data-testid="stage230-admin-tabs">
      <a href={adminTabHref("strategy", filters)} aria-current={routeId === "admin-strategy" ? "page" : undefined}>전략 추천</a>
      <a href={adminTabHref("execution", filters)} aria-current={routeId === "admin-execution" ? "page" : undefined}>실행계획</a>
      <a href={adminTabHref("retrospective", filters)} aria-current={routeId === "admin-retrospective" ? "page" : undefined}>월간 회고</a>
    </nav>
    <Section title="관리 대상" description="관리자 요청은 tenantCompanyId와 companyId를 명시하고 server ownership 검사를 통과해야 합니다." testId="stage230-admin-target">
      <form className="v2-stage230-admin-target" onSubmit={(event) => { event.preventDefault(); onApply({ ...filters, tenantCompanyId: tenantCompanyId.trim(), companyId: companyId.trim() }); }}>
        <label><span>Tenant company ID</span><input value={tenantCompanyId} onChange={(event) => setTenantCompanyId(event.target.value)} required pattern={"[A-Za-z0-9][A-Za-z0-9:._\\-]*"} autoComplete="off" /></label>
        <label><span>대상 company ID</span><input value={companyId} onChange={(event) => setCompanyId(event.target.value)} required pattern={"[A-Za-z0-9][A-Za-z0-9:._\\-]*"} autoComplete="off" /></label>
        <Button type="submit">대상 확인</Button>
      </form>
    </Section>
  </>;
}

export function Stage230RoutePage({ routeId, session, enabled }: { routeId: Stage230RouteId; session: SessionPayload; enabled: boolean }) {
  const { workspace, loadState, message, filters, setFilters, reload } = useStage230Workspace(routeId, enabled);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState("");
  const admin = session.role === "admin";
  const adminTargetReady = !admin || stage230AdminTargetReady(filters);
  const adminTarget = admin ? { companyId: filters.companyId, tenantCompanyId: filters.tenantCompanyId } : {};

  async function mutate(task: () => Promise<unknown>, success: string) {
    if (!workspace || busy || !adminTargetReady) return;
    setBusy(true); setFeedback("");
    try { await task(); setFeedback(`완료: ${success}`); await reload(); }
    catch { setFeedback("요청을 완료하지 못했습니다. 권한·상태·entitlement를 확인한 뒤 다시 시도해 주세요."); }
    finally { setBusy(false); }
  }

  const strategyRoute = routeId.endsWith("strategy");
  const executionRoute = routeId.endsWith("execution");
  const view = !workspace ? null : strategyRoute
    ? <StrategyView workspace={workspace} busy={busy} feedback={feedback} admin={admin} onGenerate={() => void mutate(() => generateStrategies({ ...adminTarget, month: workspace.month, clientRequestId: newStage230ClientRequestId() }), "전략을 생성했습니다.")} />
    : executionRoute
      ? <ExecutionView workspace={workspace} filters={filters} busy={busy} feedback={feedback} admin={admin} onFiltersChange={setFilters}
        onCreatePlan={(form) => void mutate(() => createActionPlan({ ...adminTarget, month: workspace.month, title: formText(form, "title"), owner: formText(form, "owner"), dueDate: formText(form, "dueDate"), strategyIds: workspace.strategies.map((item) => item.strategyId), clientRequestId: newStage230ClientRequestId() }), "월간 실행계획을 생성했습니다.")}
        onPlanStatus={(plan, status) => void mutate(() => updateActionPlan(plan.planId, { ...adminTarget, status, expectedVersion: plan.version }), "계획 상태를 변경했습니다.")}
        onItemStatus={(planId, itemId, status) => void mutate(() => updatePlanItem(planId, itemId, { ...adminTarget, status }), "실행 항목 상태를 변경했습니다.")}
        onChecklist={(planId, itemId, checklistId, completed) => void mutate(() => updatePlanItem(planId, itemId, { ...adminTarget, checklistUpdates: [{ checklistId, completed }] }), "체크리스트를 저장했습니다.")}
        onKpi={(planId, itemId, kpiId, currentValue, expectedVersion) => void mutate(() => updateItemKpi(planId, itemId, kpiId, { ...adminTarget, currentValue, expectedVersion }), "KPI 현재값과 audit를 저장했습니다.")}
        onAddItem={(plan, form) => void mutate(() => createPlanItem(plan.planId, { ...adminTarget, clientRequestId: newStage230ClientRequestId(), strategyId: formText(form, "strategyId"), title: formText(form, "title"), owner: formText(form, "owner"), dueDate: formText(form, "dueDate") }), "실행 항목과 기본 KPI를 추가했습니다.")} />
      : <RetrospectiveView workspace={workspace} busy={busy} feedback={feedback} admin={admin}
        onCreate={(form) => void mutate(() => createRetrospective({ ...adminTarget, planId: formText(form, "planId"), clientRequestId: newStage230ClientRequestId(), summary: formText(form, "summary"), incompleteReasons: [] }), "월간 회고를 저장했습니다.")}
        onCandidates={(retrospectiveId, targetMonth) => void mutate(() => generateNextMonthCandidates(retrospectiveId, { ...adminTarget, clientRequestId: newStage230ClientRequestId(), targetMonth }), "다음달 후보를 생성했습니다.")}
        onCreateCandidatePlan={(input) => void mutate(() => createActionPlan({ ...adminTarget, ...input, strategyIds: [], candidateIds: input.candidateIds, clientRequestId: newStage230ClientRequestId() }), "선택한 다음달 후보를 실행계획으로 전환했습니다.")} />;

  return <div data-testid="stage230-surface" data-stage230-route={routeId} data-stage230-load-state={loadState} data-stage230-state={workspace?.state || "loading"}>
    {admin ? <AdminWorkspaceControls routeId={routeId} filters={filters} onApply={(next) => {
      const query = new URLSearchParams(window.location.search);
      query.set("view", routeId.replace("admin-", ""));
      query.set("tenantCompanyId", next.tenantCompanyId || "");
      query.set("companyId", next.companyId || "");
      window.history.replaceState(null, "", `${window.location.pathname}?${query.toString()}`);
      setFilters(next);
    }} /> : null}
    {!adminTargetReady ? <Section title="관리 업체 선택" testId="stage230-state"><EmptyState title="관리 대상을 먼저 선택해 주세요" description="tenantCompanyId와 companyId가 모두 없으면 Stage 230 API를 호출하지 않고 fail closed합니다." action={<StatusBadge tone="warning">선택 필요</StatusBadge>} /></Section>
      : loadState !== "ready" ? <LoadState state={loadState} message={message} /> : view}
  </div>;
}
