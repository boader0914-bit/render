import { useState, type ReactNode } from "react";
import { Button, EmptyState, MetricCard, StatusBadge } from "@glamping-datalab-v2/ui";
import type { SessionPayload } from "../apiClient";
import {
  newStage229ClientRequestId,
  approveInsightLocationCardReview,
  publishInsightLocationCard,
  requestInsightLocationCardChanges,
  requestInsightLocationCard,
  submitInsightLocationCardReview,
  updateInsightLocationCardDraft,
  type InsightForecast,
  type InsightState,
  type LocationCardAction,
  type LocationCardLifecycle,
  type LocationCardView,
  type LocationScoreId,
  type ReportScopeId,
  type Stage229RouteId,
  type Stage229Workspace
} from "./stage229Client";
import { useStage229Workspace, type Stage229LoadState } from "./useStage229Workspace";

interface InsightSectionProps {
  title: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
  testId?: string;
}

function InsightSection({ title, description, actions, children, testId }: InsightSectionProps) {
  return <section className="v2-data-section" data-testid={testId}>
    <header className="v2-section-header">
      <div><h2>{title}</h2>{description ? <p>{description}</p> : null}</div>
      {actions ? <div className="v2-section-actions">{actions}</div> : null}
    </header>
    {children}
  </section>;
}

const STATE_CONTENT: Readonly<Record<Exclude<InsightState, "ready">, { title: string; description: string; badge: string; tone: "neutral" | "warning" | "info" }>> = Object.freeze({
  "not-collected": {
    title: "아직 신규 관측이 수집되지 않았습니다",
    description: "과거 V2·Cluster 값으로 빈칸을 채우지 않습니다. 첫 신규 수집을 시작해 주세요.",
    badge: "미수집",
    tone: "neutral"
  },
  collecting: {
    title: "신규 관측을 수집하고 있습니다",
    description: "완료되지 않은 값은 결과처럼 표시하지 않습니다. 수집 상태와 예상 표본만 확인할 수 있습니다.",
    badge: "수집 중",
    tone: "info"
  },
  "insufficient-data": {
    title: "공개하기에 데이터가 부족합니다",
    description: "최소 반복 관측과 freshness 기준을 모두 충족한 뒤에만 예측과 booking pace를 공개합니다.",
    badge: "데이터 부족",
    tone: "warning"
  },
  "not-published": {
    title: "공개된 결과가 없습니다",
    description: "검수를 통과해 공개된 입지카드와 월간 리포트만 사업자 화면에 표시합니다.",
    badge: "미노출",
    tone: "neutral"
  }
});

function StatePanel({ state, cta, reasons = [] }: {
  state: Exclude<InsightState, "ready">;
  cta?: { label: string; path: string } | null;
  reasons?: readonly string[];
}) {
  const content = STATE_CONTENT[state];
  return <div className="v2-insight-state" data-testid="stage229-state" data-insight-state={state}>
    <EmptyState
      title={content.title}
      description={content.description}
      action={cta
        ? <a className="v2-button v2-button--primary" href={cta.path}>{cta.label}</a>
        : <StatusBadge tone={content.tone}>{content.badge}</StatusBadge>}
    />
    {reasons.length ? <ul className="v2-insight-reasons" aria-label="데이터 부족 사유">
      {reasons.map((reason) => <li key={reason}>{reason}</li>)}
    </ul> : null}
  </div>;
}

function LoadStatePanel({ state }: { state: Exclude<Stage229LoadState, "ready"> }) {
  const content = {
    loading: ["입지·예측 결과를 확인하고 있습니다", "fresh-only 데이터 경계와 공개 상태를 확인합니다."],
    permission: ["이 결과에 접근할 수 없습니다", "화면 숨김과 별도로 server에서 tenant와 역할을 403으로 차단합니다."],
    unavailable: ["입지·예측 리포트 기능이 꺼져 있습니다", "승인된 feature flag가 명시적으로 켜진 환경에서만 API를 요청합니다."],
    error: ["입지·예측 결과를 불러오지 못했습니다", "내부 오류나 과거 값을 대신 표시하지 않습니다. 잠시 후 다시 시도해 주세요."]
  }[state];
  return <InsightSection title="입지·예측 데이터 상태" testId="stage229-load-state">
    <EmptyState
      title={content[0]}
      description={content[1]}
      action={<StatusBadge tone={state === "loading" ? "info" : "warning"}>{state === "loading" ? "확인 중" : "fail closed"}</StatusBadge>}
    />
  </InsightSection>;
}

function ReadinessSummary({ workspace }: { workspace: Stage229Workspace }) {
  const readiness = workspace.readiness;
  const sample = readiness.sampleCount === null ? "확인 중" : `${readiness.sampleCount}개`;
  const minimum = readiness.minimumSampleCount === null ? "최소 기준 확인 중" : `최소 ${readiness.minimumSampleCount}개`;
  return <InsightSection
    title="공개 준비 상태"
    description={readiness.detail}
    actions={<StatusBadge tone={readiness.state === "ready" ? "success" : readiness.state === "collecting" ? "info" : "warning"}>{readiness.label}</StatusBadge>}
    testId="stage229-readiness"
  >
    <div className="v2-insight-metrics">
      <MetricCard label="신규 표본" value={sample} detail={minimum} tone={readiness.state === "ready" ? "success" : "warning"} />
      <MetricCard label="Freshness" value={readiness.freshnessLabel || "확인 중"} detail={readiness.inputFrom && readiness.inputTo ? `${readiness.inputFrom} ~ ${readiness.inputTo}` : "입력 기간 확인 중"} tone="info" />
      <MetricCard label="Confidence" value={readiness.confidenceLabel || "확인 중"} detail={readiness.confidenceCauses.join(" · ") || "신뢰도 원인 확인 중"} />
    </div>
    {readiness.missingReasons.length ? <ul className="v2-insight-reasons" aria-label="공개 준비 부족 사유">
      {readiness.missingReasons.map((reason) => <li key={reason}>{reason}</li>)}
    </ul> : null}
  </InsightSection>;
}

function ForecastPanel({ forecast }: { forecast: InsightForecast }) {
  if (forecast.state !== "ready") return <InsightSection title="다음달 예측" description="최소 반복 관측 전에는 예측값과 booking pace를 공개하지 않습니다." testId="stage229-forecast">
    <StatePanel state={forecast.state === "not-published" ? "not-published" : forecast.state === "collecting" ? "collecting" : forecast.state === "not-collected" ? "not-collected" : "insufficient-data"} reasons={forecast.insufficientReasons} />
  </InsightSection>;
  return <InsightSection
    title="다음달 예측"
    description={forecast.summary}
    actions={<StatusBadge tone="success">기준 충족</StatusBadge>}
    testId="stage229-forecast"
  >
    <div className="v2-insight-metrics">
      <MetricCard label="예측 구간" value={forecast.interval?.displayValue || "확인 중"} detail={`기준일 ${forecast.asOfDate}`} tone="success" />
      <MetricCard label="입력 기간" value={`${forecast.inputFrom} ~ ${forecast.inputTo}`} detail={`${forecast.sampleCount ?? "확인 중"}개 표본 · 최소 ${forecast.minimumSampleCount ?? "확인 중"}개`} tone="info" />
      <MetricCard label="신뢰도" value={forecast.confidenceLabel || "확인 중"} detail={forecast.confidenceCauses.join(" · ") || "신뢰도 원인 확인 중"} />
    </div>
    {forecast.bookingPace ? <div className="v2-insight-highlight" data-testid="stage229-booking-pace">
      <div><span>Booking pace</span><strong>{forecast.bookingPace.displayValue}</strong></div><p>{forecast.bookingPace.detail}</p>
    </div> : null}
  </InsightSection>;
}

const SCOPE_ORDER: readonly ReportScopeId[] = ["national", "regional", "own", "anonymous-cohort"];
const SCOPE_LABEL: Readonly<Record<ReportScopeId, string>> = {
  national: "전국",
  regional: "지역",
  own: "내 숙소",
  "anonymous-cohort": "익명 비교군"
};

export function BusinessReportView({ workspace, strategyLinkEnabled = false }: { workspace: Stage229Workspace; strategyLinkEnabled?: boolean }) {
  const report = workspace.monthlyReport;
  if (workspace.state !== "ready" || !report) return <>
    <ReadinessSummary workspace={workspace} />
    <InsightSection title="월간 리포트" testId="stage229-monthly-report">
      <StatePanel
        state={workspace.state === "ready" ? "not-published" : workspace.state}
        cta={workspace.readiness.nextCollectionCta}
        reasons={workspace.readiness.missingReasons}
      />
    </InsightSection>
  </>;
  const scopeById = new Map(report.scopes.map((scope) => [scope.id, scope]));
  return <>
    <ReadinessSummary workspace={workspace} />
    <InsightSection
      title={report.title}
      description={report.summary}
      actions={<><StatusBadge tone="success">공개됨</StatusBadge><StatusBadge>{report.month || "월 확인 중"}</StatusBadge></>}
      testId="stage229-monthly-report"
    >
      <div className="v2-insight-scope-grid" data-testid="stage229-report-scopes">
        {SCOPE_ORDER.map((id) => {
          const scope = scopeById.get(id);
          return <article key={id} data-scope={id} data-scope-state={scope?.state || "not-collected"}>
            <header><strong>{scope?.label || SCOPE_LABEL[id]}</strong><StatusBadge tone={scope?.state === "ready" ? "success" : "warning"}>{scope?.state === "ready" ? "준비됨" : "미수집"}</StatusBadge></header>
            <b>{scope?.displayValue || "미수집"}</b>
            <p>{scope?.detail || "기준을 충족한 신규 관측이 아직 없습니다."}</p>
          </article>;
        })}
      </div>
      <div className="v2-insight-cohort" data-testid="stage229-anonymous-cohort">
        <div><span>{report.cohort.label}</span><strong>{report.cohort.sampleCount === null ? "표본 확인 중" : `${report.cohort.sampleCount}개 비식별 표본`}</strong></div>
        <p>{report.cohort.summary}</p>
        <small>{report.cohort.minimumSampleCount === null ? "최소 표본 기준 확인 중" : `공개 최소 기준 ${report.cohort.minimumSampleCount}개`}</small>
      </div>
      <div className="v2-insight-footer-row">
        <small>알고리즘 {report.algorithmVersion || workspace.algorithmVersion || "확인 중"} · 공개 {report.publishedAt}</small>
        <div className="v2-inline-actions">
          <a className="v2-button v2-button--quiet" data-testid="stage229-report-location-link" href={report.locationCardPath}>입지카드 보기</a>
          {strategyLinkEnabled ? <a className="v2-button v2-button--secondary" data-testid="stage230-report-strategy-link" href="/app/strategy">전략 추천 보기</a> : null}
        </div>
      </div>
    </InsightSection>
    <ForecastPanel forecast={report.forecast} />
  </>;
}

const SCORE_ORDER: readonly LocationScoreId[] = ["tourism", "industry", "living-area", "accessibility", "interest", "ota", "leadtime"];
const SCORE_LABEL: Readonly<Record<LocationScoreId, string>> = {
  tourism: "관광",
  industry: "산업",
  "living-area": "생활권",
  accessibility: "접근성",
  interest: "관심도",
  ota: "OTA",
  leadtime: "리드타임"
};

function LocationCardContent({ card, admin = false }: { card: LocationCardView; admin?: boolean }) {
  const scoreById = new Map(card.scores.map((score) => [score.id, score]));
  return <>
    <InsightSection
      title={card.title}
      description={card.summary}
      actions={<StatusBadge tone={card.lifecycle === "published" ? "success" : card.lifecycle === "in-review" ? "info" : "warning"}>{card.lifecycle}</StatusBadge>}
      testId="stage229-location-card"
    >
      <div className="v2-insight-facts">
        <div><span>대상</span><strong>{card.companyName}</strong><small>{card.regionLabel || "지역 확인 중"}</small></div>
        <div><span>Freshness</span><strong>{card.freshnessLabel || "확인 중"}</strong><small>{card.updatedAt || "갱신 시각 확인 중"}</small></div>
        <div><span>Confidence</span><strong>{card.confidenceLabel || "확인 중"}</strong><small>{card.confidenceCauses.join(" · ") || "신뢰도 원인 확인 중"}</small></div>
      </div>
      <div className="v2-insight-score-grid" data-testid="stage229-location-scores">
        {SCORE_ORDER.map((id) => {
          const score = scoreById.get(id);
          return <article key={id} data-score={id} data-score-state={score?.state || "not-collected"}>
            <header><span>{score?.label || SCORE_LABEL[id]}</span><StatusBadge tone={score?.state === "ready" ? "success" : "warning"}>{score?.state === "ready" ? "준비됨" : "미수집"}</StatusBadge></header>
            <strong>{score?.displayValue || "미수집"}</strong><p>{score?.detail || "신규 관측 표본이 부족합니다."}</p>
          </article>;
        })}
      </div>
      <div className="v2-insight-evidence" data-testid="stage229-evidence-summary">
        <div><span>Evidence snapshot 요약</span><strong>{card.evidenceSummary}</strong></div>
        <small>알고리즘 {card.algorithmVersion || "확인 중"}{card.publishedAt ? ` · 공개 ${card.publishedAt}` : ""}</small>
      </div>
      {!admin && card.lifecycle !== "published" ? <p className="v2-core-notice" data-tone="warning">검수를 통과해 공개된 카드만 사업자에게 표시합니다.</p> : null}
    </InsightSection>
    {card.forecast ? <ForecastPanel forecast={card.forecast} /> : null}
  </>;
}

export function BusinessLocationView({ workspace }: { workspace: Stage229Workspace }) {
  if (workspace.state !== "ready" || !workspace.locationCard) return <>
    <ReadinessSummary workspace={workspace} />
    <InsightSection title="공개 입지카드" testId="stage229-published-location">
      <StatePanel
        state={workspace.state === "ready" ? "not-published" : workspace.state}
        cta={workspace.readiness.nextCollectionCta}
        reasons={workspace.readiness.missingReasons}
      />
    </InsightSection>
  </>;
  return <><ReadinessSummary workspace={workspace} /><LocationCardContent card={workspace.locationCard} /></>;
}

const LIFECYCLE_STEPS: ReadonlyArray<{ id: LocationCardLifecycle; label: string }> = [
  { id: "requested", label: "요청" },
  { id: "draft", label: "초안·수정" },
  { id: "in-review", label: "검수 중" },
  { id: "reviewed", label: "검수 승인" },
  { id: "published", label: "공개" }
];

function lifecyclePosition(lifecycle: LocationCardLifecycle): number {
  if (lifecycle === "changes-requested") return 1;
  return Math.max(0, LIFECYCLE_STEPS.findIndex((step) => step.id === lifecycle));
}

interface AdminLocationViewProps {
  workspace: Stage229Workspace;
  selectedCompanyId?: string;
  busy?: boolean;
  feedback?: string;
  revisionNote?: string;
  onRevisionNoteChange?: (value: string) => void;
  onAction?: (action: LocationCardAction) => void;
  onCompanyChange?: (companyId: string) => void;
}

export function AdminLocationView({ workspace, selectedCompanyId = "", busy = false, feedback = "", revisionNote = "", onRevisionNoteChange, onAction, onCompanyChange }: AdminLocationViewProps) {
  const card = workspace.locationCard;
  const actions = new Set(workspace.allowedActions.length ? workspace.allowedActions : card?.allowedActions || []);
  const position = card ? lifecyclePosition(card.lifecycle) : -1;
  const activeCompanyId = selectedCompanyId || workspace.subject.companyId;
  const activeSubjectIndex = Math.max(0, workspace.subjects.findIndex((subject) => subject.companyId === activeCompanyId));
  return <>
    <InsightSection title="검토 업체" description="신규 통합 store의 business-safe 업체 목록에서 검토 대상을 선택합니다." testId="stage229-company-selector">
      <label className="v2-insight-select">
        <span>신규 수집 업체</span>
        <select
          data-testid="stage229-company-select"
          value={workspace.subjects.length ? String(activeSubjectIndex) : ""}
          disabled={busy || !workspace.subjects.length}
          onChange={(event) => {
            const subject = workspace.subjects[Number(event.target.value)];
            if (subject) onCompanyChange?.(subject.companyId);
          }}
        >
          {!workspace.subjects.length ? <option value="">선택 가능한 신규 업체 없음</option> : workspace.subjects.map((subject, index) => <option key={`${subject.companyName}-${index}`} value={String(index)}>{subject.companyName}{subject.regionLabel ? ` · ${subject.regionLabel}` : ""}</option>)}
        </select>
      </label>
    </InsightSection>
    <ReadinessSummary workspace={workspace} />
    <InsightSection title="입지카드 생명주기" description="요청→초안·수정→검수→공개 전이를 server 권한과 audit로 강제합니다." testId="stage229-lifecycle">
      <ol className="v2-insight-lifecycle">
        {LIFECYCLE_STEPS.map((step, index) => <li key={step.id} data-current={card?.lifecycle === step.id || (step.id === "draft" && card?.lifecycle === "changes-requested")} data-complete={position > index}>
          <span>{index + 1}</span><div><strong>{step.label}</strong><small>{step.id === "draft" && card?.lifecycle === "changes-requested" ? "수정 요청됨" : position > index ? "완료" : position === index ? "현재 단계" : "대기"}</small></div>
        </li>)}
      </ol>
    </InsightSection>
    {card ? <LocationCardContent card={card} admin /> : <InsightSection title="입지카드 초안" testId="stage229-admin-card-empty">
      <StatePanel state={workspace.state === "ready" ? "not-collected" : workspace.state} reasons={workspace.readiness.missingReasons} />
    </InsightSection>}
    <InsightSection title="검수 작업" description="허용된 상태 전이만 표시하며 실제 권한은 server에서 다시 검증합니다." testId="stage229-admin-actions">
      <label className="v2-insight-editor">
        <span>수정·검수 메모</span>
        <textarea value={revisionNote} onChange={(event) => onRevisionNoteChange?.(event.target.value)} rows={4} placeholder="변경 근거 또는 수정 요청 사유를 입력하세요." />
      </label>
      <div className="v2-inline-actions">
        {actions.has("request") ? <Button type="button" disabled={busy} onClick={() => onAction?.("request")}>제작 요청</Button> : null}
        {actions.has("edit-draft") ? <Button type="button" disabled={busy} onClick={() => onAction?.("edit-draft")}>초안 저장</Button> : null}
        {actions.has("submit-review") ? <Button variant="secondary" type="button" disabled={busy} onClick={() => onAction?.("submit-review")}>검수 요청</Button> : null}
        {actions.has("approve-review") ? <Button type="button" disabled={busy} onClick={() => onAction?.("approve-review")}>검수 승인</Button> : null}
        {actions.has("request-changes") ? <Button variant="quiet" type="button" disabled={busy} onClick={() => onAction?.("request-changes")}>수정 요청</Button> : null}
        {actions.has("publish") ? <Button type="button" disabled={busy} onClick={() => onAction?.("publish")}>공개</Button> : null}
        {!actions.size ? <StatusBadge>허용 작업 없음</StatusBadge> : null}
      </div>
      {feedback ? <p className="v2-core-notice" data-tone={feedback.startsWith("완료") ? "success" : "danger"} role={feedback.startsWith("완료") ? "status" : "alert"}>{feedback}</p> : null}
    </InsightSection>
    <InsightSection title="상태 전이 audit" description="민감한 actor 식별자 없이 공개 가능한 상태 변경 요약만 표시합니다." testId="stage229-audit">
      {workspace.audit.length ? <ol className="v2-insight-audit">{workspace.audit.map((item) => <li key={item.id}>
        <div><strong>{item.label}</strong><time>{item.occurredAt}</time></div>{item.detail ? <p>{item.detail}</p> : null}
      </li>)}</ol> : <p className="v2-inline-empty">기록된 상태 전이가 없습니다.</p>}
    </InsightSection>
  </>;
}

function actionSuccessLabel(action: LocationCardAction): string {
  return {
    request: "완료: 입지카드 제작 요청을 접수했습니다.",
    "edit-draft": "완료: 입지카드 초안을 저장했습니다.",
    "submit-review": "완료: 입지카드 검수를 요청했습니다.",
    "approve-review": "완료: 입지카드 검수를 승인했습니다.",
    "request-changes": "완료: 수정 요청을 기록했습니다.",
    publish: "완료: 입지카드를 공개했습니다."
  }[action];
}

export function Stage229RoutePage({ routeId, session, enabled, strategyLinkEnabled = false }: {
  routeId: Stage229RouteId;
  session: SessionPayload;
  enabled: boolean;
  strategyLinkEnabled?: boolean;
}) {
  const { workspace, loadState, reload, selectedCompanyId, selectCompanyId } = useStage229Workspace(routeId, enabled);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [revisionNote, setRevisionNote] = useState("");
  const admin = session.role === "admin";

  async function runAdminAction(action: LocationCardAction) {
    if (!admin || !workspace) return;
    const cardId = workspace.locationCard?.cardId || "";
    const cardVersion = workspace.locationCard?.version ?? 0;
    if (["edit-draft", "request-changes"].includes(action) && !revisionNote.trim()) {
      setFeedback("요청을 완료하려면 수정·검수 메모가 필요합니다.");
      return;
    }
    setBusy(true);
    setFeedback("");
    try {
      if (action === "request") await requestInsightLocationCard({ clientRequestId: newStage229ClientRequestId(), companyId: workspace.subject.companyId });
      else if (action === "edit-draft") await updateInsightLocationCardDraft(cardId, cardVersion, revisionNote, workspace.locationCard?.lifecycle || "requested");
      else if (action === "submit-review") await submitInsightLocationCardReview(cardId, cardVersion, revisionNote);
      else if (action === "approve-review") await approveInsightLocationCardReview(cardId, cardVersion, revisionNote);
      else if (action === "request-changes") await requestInsightLocationCardChanges(cardId, cardVersion, revisionNote);
      else await publishInsightLocationCard(cardId, cardVersion, revisionNote);
      setFeedback(actionSuccessLabel(action));
      setRevisionNote("");
      await reload();
    } catch {
      setFeedback("요청을 완료하지 못했습니다. 내부 정보는 표시하지 않으며 잠시 후 다시 시도해 주세요.");
    } finally {
      setBusy(false);
    }
  }

  if (!enabled) return null;
  const view = !workspace ? null
    : routeId === "business-report" ? <BusinessReportView workspace={workspace} strategyLinkEnabled={strategyLinkEnabled} />
      : routeId === "business-location" ? <BusinessLocationView workspace={workspace} />
        : <AdminLocationView
          workspace={workspace}
          selectedCompanyId={selectedCompanyId}
          busy={busy}
          feedback={feedback}
          revisionNote={revisionNote}
          onRevisionNoteChange={setRevisionNote}
          onCompanyChange={(companyId) => {
            setFeedback("");
            setRevisionNote("");
            selectCompanyId(companyId);
          }}
          onAction={(action) => { void runAdminAction(action); }}
        />;
  return <div data-testid="stage229-surface" data-stage229-route={routeId} data-stage229-load-state={loadState} data-stage229-state={workspace?.state || "loading"}>
    {loadState !== "ready" ? <LoadStatePanel state={loadState} /> : view}
  </div>;
}
