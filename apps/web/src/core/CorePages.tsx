import { useMemo, useState, type FormEvent, type ReactNode } from "react";
import { Button, EmptyState, StatusBadge } from "@glamping-datalab-v2/ui";
import type { SessionPayload } from "../apiClient";
import {
  addCoreInterest,
  newClientRequestId,
  removeCoreInterest,
  requestLocationCard,
  requestTourismCollection,
  type CoreCollectionCapability,
  type CoreCollectionJobInput,
  type CoreCompany,
  type CoreJob,
  type CoreWorkspace
} from "./coreClient";
import { CompanyDetailPanel } from "./CompanyDetailPanel";
import { useRecoverableJob } from "./useCoreWorkspace";

interface CorePageProps {
  workspace: CoreWorkspace;
  session: SessionPayload;
  reload: () => Promise<unknown>;
}

function DataSection({ title, description, actions, children, testId }: {
  title: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
  testId?: string;
}) {
  return <section className="v2-data-section" data-testid={testId}>
    <header className="v2-section-header">
      <div><h2>{title}</h2>{description ? <p>{description}</p> : null}</div>
      {actions ? <div className="v2-section-actions">{actions}</div> : null}
    </header>
    {children}
  </section>;
}

function Notice({ tone = "info", children }: { tone?: "info" | "warning" | "danger" | "success"; children: ReactNode }) {
  return <p className="v2-core-notice" data-tone={tone} role={tone === "danger" ? "alert" : "status"}>{children}</p>;
}

function collectionButtonLabel(capability: CoreCollectionCapability, realLabel: string, testLabel: string): string {
  if (capability.realProviderEnabled) return realLabel;
  if (capability.testExecutionEnabled) return testLabel;
  return "실수집 미연결";
}

function collectionCapabilityTone(capability: CoreCollectionCapability): "success" | "warning" | "danger" {
  return capability.realProviderEnabled ? "success" : capability.testExecutionEnabled ? "warning" : "danger";
}

type CollectionPlanFields = Required<Pick<CoreCollectionJobInput,
  "regionCode" | "targetDate" | "checkIn" | "checkOut" | "rankingQuery" | "collectionMode" | "collectionPurpose" | "productMode" | "detailRankRanges"
>> & { bookingRangePlaceLimit: number };

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

export function defaultCollectionPlan(): CollectionPlanFields {
  const today = todayUtc();
  return {
    regionCode: "",
    targetDate: today,
    checkIn: today,
    checkOut: today,
    rankingQuery: "",
    // Start with the bounded official-search path. Detail/OTA collection is an
    // explicit opt-in because it requires separate providers and approval caps.
    collectionMode: "fast",
    collectionPurpose: "basic_db",
    productMode: "all",
    detailRankRanges: "1-10",
    bookingRangePlaceLimit: 10
  };
}

function CollectionPlanInputs({ value, onChange }: {
  value: CollectionPlanFields;
  onChange: (next: CollectionPlanFields) => void;
}) {
  const update = <Key extends keyof CollectionPlanFields>(key: Key, next: CollectionPlanFields[Key]) => {
    onChange({ ...value, [key]: next });
  };
  return <>
    <label className="v2-field"><span>승인 지역 코드·명</span><input required value={value.regionCode} onChange={(event) => update("regionCode", event.target.value)} placeholder="예: 가평군" autoComplete="off" /></label>
    <label className="v2-field"><span>수집 기준일</span><input required type="date" value={value.targetDate} onChange={(event) => update("targetDate", event.target.value)} /></label>
    <label className="v2-field"><span>상세 수집 시작일</span><input required={value.collectionPurpose === "revenue_detail"} disabled={value.collectionMode === "fast" || value.collectionPurpose !== "revenue_detail"} type="date" value={value.checkIn} onChange={(event) => update("checkIn", event.target.value)} /></label>
    <label className="v2-field"><span>상세 수집 종료일</span><input required={value.collectionPurpose === "revenue_detail"} disabled={value.collectionMode === "fast" || value.collectionPurpose !== "revenue_detail"} type="date" value={value.checkOut} onChange={(event) => update("checkOut", event.target.value)} /></label>
    <label className="v2-field"><span>순위 검색어</span><input value={value.rankingQuery} onChange={(event) => update("rankingQuery", event.target.value)} placeholder="비우면 업체 검색어 사용" autoComplete="off" /></label>
    <label className="v2-field"><span>수집 목적</span><select value={value.collectionPurpose} onChange={(event) => update("collectionPurpose", event.target.value as CollectionPlanFields["collectionPurpose"])}><option value="basic_db">기본정보 수집</option><option value="revenue_detail">상세·매출 수집</option><option value="demand_location">지역·입지 수집</option></select></label>
    <label className="v2-field"><span>실행 방식</span><select value={value.collectionMode} onChange={(event) => update("collectionMode", event.target.value as CollectionPlanFields["collectionMode"])}><option value="precision">상세 확인</option><option value="fast">빠른 순위 확인</option></select></label>
    <label className="v2-field"><span>상품 범위</span><select value={value.productMode} onChange={(event) => update("productMode", event.target.value as CollectionPlanFields["productMode"])}><option value="all">전체</option><option value="lodging">숙박</option><option value="campnic">캠프닉</option></select></label>
    <label className="v2-field"><span>상세 순위 범위</span><input disabled={value.collectionMode === "fast"} value={value.detailRankRanges} onChange={(event) => update("detailRankRanges", event.target.value)} placeholder="예: 1-10" /></label>
    <label className="v2-field"><span>리드타임 업체 상한</span><input disabled={value.collectionMode === "fast" || value.collectionPurpose !== "revenue_detail"} type="number" min="0" max="20" value={value.bookingRangePlaceLimit} onChange={(event) => update("bookingRangePlaceLimit", Math.max(0, Math.min(20, Number(event.target.value) || 0)))} /></label>
  </>;
}

function collectionPayload(plan: CollectionPlanFields, keyword: string): CoreCollectionJobInput {
  return {
    keyword,
    regionCode: plan.regionCode.trim(),
    regionLabel: plan.regionCode.trim(),
    targetDate: plan.targetDate,
    checkIn: plan.checkIn,
    checkOut: plan.checkOut,
    discoveryQuery: keyword,
    rankingQuery: plan.rankingQuery.trim() || keyword,
    collectionMode: plan.collectionMode,
    collectionPurpose: plan.collectionPurpose,
    productMode: plan.productMode,
    detailRankRanges: plan.detailRankRanges.trim(),
    bookingRangePlaceLimit: plan.bookingRangePlaceLimit
  };
}

function strictUtcDay(value: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value ? parsed : null;
}

export function collectionPlanValidationError(plan: CollectionPlanFields): string {
  if (!plan.regionCode.trim()) return "승인 manifest와 일치하는 지역 코드·명을 입력해 주세요.";
  if (strictUtcDay(plan.targetDate) === null) return "올바른 수집 기준일을 입력해 주세요.";
  if (plan.collectionMode === "fast" || plan.collectionPurpose !== "revenue_detail") return "";
  const checkIn = strictUtcDay(plan.checkIn);
  const checkOut = strictUtcDay(plan.checkOut);
  if (checkIn === null || checkOut === null) return "올바른 상세 수집 시작일과 종료일을 입력해 주세요.";
  const inclusiveDays = Math.floor((checkOut - checkIn) / 86_400_000) + 1;
  if (inclusiveDays < 1) return "상세 수집 종료일은 시작일보다 빠를 수 없습니다.";
  if (inclusiveDays > 31) return "상세 수집 기간은 최대 31일입니다.";
  return "";
}

export function adminLodgingCollectionBlockReason(capability: CoreCollectionCapability, keyword: string, plan: CollectionPlanFields): string {
  if (!capability.executionEnabled) return capability.detail;
  if (!keyword.trim()) return "수집 대상 업체명을 입력해 주세요.";
  return collectionPlanValidationError(plan);
}

function JobProgress({ job, busy, error, operationLabel, onCancel, onResume, onRefresh }: {
  job: CoreJob | null;
  busy: boolean;
  error: string;
  operationLabel: string;
  onCancel: () => void;
  onResume: () => void;
  onRefresh: () => void;
}) {
  if (!job) return <EmptyState title="진행 중인 데이터 작업이 없습니다" description={`${operationLabel}. 요청을 시작하면 멱등 clientRequestId로 같은 탭의 새로고침 이후에도 진행 상태를 복구합니다.`} />;
  const active = job.status === "queued" || job.status === "running";
  return <article className="v2-job-card" data-testid="job-progress" data-job-status={job.status}>
    <div className="v2-job-heading">
      <div><strong>{job.query || job.kind}</strong><small>{operationLabel} · 요청 ID {job.clientRequestId}</small></div>
      <StatusBadge tone={job.status === "completed" ? "success" : job.status === "failed" ? "warning" : "info"}>{job.status}</StatusBadge>
    </div>
    <label className="v2-progress-row">
      <span><strong>{job.progressLabel}</strong><small>예상 시간 {job.etaLabel}</small></span>
      <progress max="100" value={job.progress}>{job.progress}%</progress>
    </label>
    {job.message ? <p>{job.message}</p> : null}
    {error ? <Notice tone="danger">{error}</Notice> : null}
    <div className="v2-inline-actions">
      <Button variant="secondary" type="button" disabled={busy} onClick={onRefresh}>상태 새로고침</Button>
      {active ? <Button variant="quiet" type="button" disabled={busy} onClick={onCancel}>작업 취소</Button> : null}
      {["failed", "cancelled"].includes(job.status) ? <Button variant="quiet" type="button" disabled={busy} onClick={onResume}>중단 지점부터 재개</Button> : null}
    </div>
  </article>;
}

function CompanyList({ companies, interests, sourceLabel, onToggleInterest, onSelectCompany, selectedCompanyId, busyCompanyId }: {
  companies: readonly CoreCompany[];
  interests: ReadonlySet<string>;
  sourceLabel: string;
  onToggleInterest: (company: CoreCompany) => void;
  onSelectCompany: (company: CoreCompany) => void;
  selectedCompanyId: string;
  busyCompanyId: string;
}) {
  if (!companies.length) return <EmptyState title="새로 수집된 업체가 없습니다" description="과거 V2·Cluster 업체는 표시하지 않습니다. 신규 수집 결과가 준비되면 이 목록에 나타납니다." />;
  return <div className="v2-card-list" aria-label="신규 수집 업체">
    {companies.map((company) => {
      const interested = interests.has(company.companyId);
      return <article className="v2-company-card" key={company.companyId} data-selected={selectedCompanyId === company.companyId}>
        <div><strong>{company.name}</strong><span>{company.region}</span></div>
        <div className="v2-company-meta">
          <StatusBadge tone={company.dataQuality === "partial" ? "warning" : company.status === "ready" || company.status === "fresh" ? "success" : "info"}>{company.dataQuality === "partial" ? "일부 누락" : company.status}</StatusBadge>
          <small data-testid="company-data-source">{sourceLabel}</small>
          {company.freshnessLabel ? <small>{company.freshnessLabel}</small> : null}
        </div>
        {company.fields?.length ? <dl className="v2-business-values" aria-label={`${company.name} V2 호환 업무 값`}>
          {company.fields.slice(0, 3).map((field) => <div key={field.label}><dt>{field.label}</dt><dd>{field.value}</dd></div>)}
        </dl> : null}
        <div className="v2-company-actions">
          <Button variant="secondary" type="button" onClick={() => onSelectCompany(company)}>상세 보기</Button>
          <Button variant={interested ? "secondary" : "quiet"} type="button" disabled={busyCompanyId === company.companyId} onClick={() => onToggleInterest(company)}>
            {interested ? "관심 해제" : "관심 숙소 추가"}
          </Button>
        </div>
      </article>;
    })}
  </div>;
}

export function OnboardingPage({ workspace }: CorePageProps) {
  return <>
    <DataSection title="신규 수집 시작 순서" description="기존 데이터를 옮기지 않고 내 숙소를 새로 수집하는 세 단계입니다." testId="onboarding-steps">
      <ol className="v2-step-list">
        <li><span>1</span><div><strong>계정과 업체 확인</strong><p>신규 발급 계정에 연결된 내 업체만 server ownership 검사를 통과합니다.</p></div></li>
        <li><span>2</span><div><strong>수집 요청</strong><p>업체 검색 또는 내 숙소 수집 요청을 생성하고 예상 시간을 확인합니다.</p></div></li>
        <li><span>3</span><div><strong>결과 검토</strong><p>새 통합 store에서 생성된 이력·관심 숙소·입지카드 요청만 이어서 사용합니다.</p></div></li>
      </ol>
      <a className="v2-button v2-button--primary v2-start-link" href="/app/activity">업체 검색 시작</a>
    </DataSection>
    <DataSection title="현재 데이터 경계" description={workspace.collectionCapability.detail}>
      <div className="v2-boundary-grid">
        <div><span>표시 출처</span><strong>{workspace.collectionCapability.sourceLabel}</strong></div>
        <div><span>기존 데이터 이관</span><strong>0건</strong></div>
        <div><span>실제 provider</span><strong>{workspace.collectionCapability.realProviderEnabled ? "연결 확인" : "미연결"}</strong></div>
      </div>
    </DataSection>
  </>;
}

export function BusinessActivityPage({ workspace, session, reload }: CorePageProps) {
  const [keyword, setKeyword] = useState("");
  const [collectionPlan, setCollectionPlan] = useState<CollectionPlanFields>(defaultCollectionPlan);
  const [interestBusy, setInterestBusy] = useState("");
  const [mutationError, setMutationError] = useState("");
  const searchJob = useRecoverableJob("business-search", reload);
  const lodgeJob = useRecoverableJob("business-my-lodge", reload);
  const localJobs = [searchJob.job, lodgeJob.job].filter((job): job is CoreJob => Boolean(job));
  const activeJob = localJobs.find((job) => ["queued", "running"].includes(job.status))
    || [...localJobs].sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)))[0]
    || workspace.jobs.find((job) => ["queued", "running"].includes(job.status))
    || workspace.jobs[0]
    || null;
  const activeController = activeJob?.kind === "business-my-lodge" ? lodgeJob : searchJob;
  const interestIds = useMemo(() => new Set(workspace.interests.map((item) => item.companyId)), [workspace.interests]);
  const ownedCompanyId = session.companyId || workspace.tenantCompanyId;
  const [selectedCompanyId, setSelectedCompanyId] = useState(workspace.companies[0]?.companyId || "");
  const selectedCompany = workspace.companies.find((company) => company.companyId === selectedCompanyId) || workspace.companies[0] || null;
  const searchActive = Boolean(searchJob.job && ["queued", "running"].includes(searchJob.job.status));
  const lodgeActive = Boolean(lodgeJob.job && ["queued", "running"].includes(lodgeJob.job.status));
  const collectionCapability = workspace.collectionCapability;

  const submitSearch = async (event: FormEvent) => {
    event.preventDefault();
    if (!collectionCapability.executionEnabled) { setMutationError(collectionCapability.detail); return; }
    const trimmed = keyword.trim();
    if (!trimmed) { setMutationError("검색할 업체명 또는 지역을 입력해 주세요."); return; }
    const validationError = collectionPlanValidationError(collectionPlan);
    if (validationError) { setMutationError(validationError); return; }
    setMutationError("");
    await searchJob.start(collectionPayload(collectionPlan, trimmed));
  };

  const collectMyLodge = async () => {
    if (!collectionCapability.executionEnabled) { setMutationError(collectionCapability.detail); return; }
    if (!ownedCompanyId) { setMutationError("계정에 연결된 업체가 없어 내 숙소 수집을 요청할 수 없습니다."); return; }
    const validationError = collectionPlanValidationError(collectionPlan);
    if (validationError) { setMutationError(validationError); return; }
    setMutationError("");
    await lodgeJob.start({
      ...collectionPayload({ ...collectionPlan, collectionMode: "precision", collectionPurpose: "revenue_detail" }, workspace.tenantCompanyName || "내 숙소"),
      companyId: ownedCompanyId
    });
  };

  const toggleInterest = async (company: CoreCompany) => {
    setInterestBusy(company.companyId);
    setMutationError("");
    try {
      if (interestIds.has(company.companyId)) await removeCoreInterest(company.companyId);
      else await addCoreInterest(company.companyId);
      await reload();
    } catch (reason) {
      setMutationError(reason instanceof Error ? reason.message : "관심 숙소를 변경하지 못했습니다.");
    } finally {
      setInterestBusy("");
    }
  };

  return <>
    <DataSection title="업체 검색과 내 숙소 데이터 생성" description="동일한 in-flight clientRequestId만 복구하며 종료된 요청 ID는 새 작업에 재사용하지 않습니다." testId="business-search-form">
      <Notice tone={collectionCapabilityTone(collectionCapability)}>{collectionCapability.sourceLabel} · {collectionCapability.detail}</Notice>
      <form className="v2-action-form v2-collection-form" onSubmit={submitSearch}>
        <label className="v2-field"><span>업체명 또는 지역</span><input value={keyword} onChange={(event) => setKeyword(event.target.value)} placeholder="예: 가평 ○○ 글램핑" autoComplete="off" /></label>
        <CollectionPlanInputs value={collectionPlan} onChange={setCollectionPlan} />
        <div className="v2-collection-actions"><Button type="submit" disabled={!collectionCapability.executionEnabled || searchJob.busy || searchActive}>{collectionButtonLabel(collectionCapability, "실제 업체 수집", "테스트 업체 생성")}</Button>
        <Button variant="secondary" type="button" disabled={!collectionCapability.executionEnabled || lodgeJob.busy || lodgeActive || !ownedCompanyId} onClick={collectMyLodge}>{collectionButtonLabel(collectionCapability, "내 숙소 실제 수집", "내 숙소 테스트 데이터 생성")}</Button></div>
      </form>
      {mutationError ? <Notice tone="danger">{mutationError}</Notice> : null}
    </DataSection>
    <DataSection title="데이터 작업 진행" description="진행률과 예상 시간은 V2 호환 API가 제공한 값을 그대로 표시하며 종료 즉시 결과를 다시 불러옵니다.">
      <JobProgress job={activeJob} busy={activeController.busy} error={activeController.error} operationLabel={collectionCapability.sourceLabel} onCancel={() => void activeController.cancel(activeJob?.clientRequestId)} onResume={() => void activeController.resume(activeJob?.clientRequestId)} onRefresh={() => void activeController.refreshJob(activeJob?.clientRequestId)} />
    </DataSection>
    <DataSection title="신규 데이터 결과" description={`표시 출처: ${collectionCapability.sourceLabel}. 테스트 데이터와 실제 수집 결과를 같은 이름으로 표시하지 않습니다.`} testId="fresh-company-results">
      <CompanyList
        companies={workspace.companies}
        interests={interestIds}
        sourceLabel={collectionCapability.sourceLabel}
        selectedCompanyId={selectedCompany?.companyId || ""}
        onSelectCompany={(company) => setSelectedCompanyId(company.companyId)}
        onToggleInterest={(company) => void toggleInterest(company)}
        busyCompanyId={interestBusy}
      />
    </DataSection>
    <DataSection title="업체 상세" description="관리자와 사업자에게 동일한 business-safe 신규 수집 요약을 표시합니다." testId="business-company-detail">
      <CompanyDetailPanel company={selectedCompany} role="business" state={selectedCompany ? undefined : "empty"} />
    </DataSection>
    <div className="v2-two-column">
      <DataSection title="신규 검색·run 이력" testId="fresh-history">
        {workspace.history.length ? <ul className="v2-record-list">{workspace.history.map((item) => <li key={item.id}><div><strong>{item.label}</strong><span>{item.detail}</span>{item.resultValues.length ? <span className="v2-result-values">{item.resultValues.map((value) => `${value.label} ${value.value}`).join(" · ")}</span> : null}</div><StatusBadge>{item.status}</StatusBadge></li>)}</ul> : <p className="v2-inline-empty">아직 신규 이력이 없습니다.</p>}
      </DataSection>
      <DataSection title="관심 숙소" testId="fresh-interests">
        {workspace.interests.length ? <ul className="v2-record-list">{workspace.interests.map((item) => <li key={item.companyId}><div><strong>{item.name}</strong><span>{item.region}</span></div><Button variant="quiet" type="button" disabled={interestBusy === item.companyId} onClick={() => void toggleInterest({ ...item, status: "ready" })}>해제</Button></li>)}</ul> : <p className="v2-inline-empty">신규 수집 결과에서 관심 숙소를 추가해 주세요.</p>}
      </DataSection>
    </div>
  </>;
}

export function LocationCardPage({ workspace, session, reload }: CorePageProps) {
  void session;
  const defaultCompanyId = workspace.companies[0]?.companyId || "";
  const [companyId, setCompanyId] = useState(defaultCompanyId);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState("");
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!companyId) { setFeedback("신규 수집된 내 업체가 있어야 입지카드를 요청할 수 있습니다."); return; }
    setBusy(true);
    setFeedback("");
    try {
      await requestLocationCard(newClientRequestId(), companyId);
      setFeedback("입지카드 제작 요청을 접수했습니다.");
      await reload();
    } catch (reason) {
      setFeedback(reason instanceof Error ? reason.message : "입지카드 요청을 접수하지 못했습니다.");
    } finally { setBusy(false); }
  };
  return <>
    <DataSection title="입지카드 제작 요청" description="표본과 freshness 기준은 server에서 확인하며 부족하면 안전한 대기 상태로 남습니다." testId="location-card-form">
      <form className="v2-action-form" onSubmit={submit}>
        <label className="v2-field"><span>신규 수집 업체</span><select value={companyId} onChange={(event) => setCompanyId(event.target.value)} disabled={!workspace.companies.length}>
          {!defaultCompanyId ? <option value="">신규 수집 업체 없음</option> : null}
          {workspace.companies.map((company) => <option value={company.companyId} key={company.companyId}>{company.name}</option>)}
        </select></label>
        <Button type="submit" disabled={busy || !companyId}>제작 요청</Button>
      </form>
      {feedback ? <Notice tone={feedback.includes("접수") ? "success" : "danger"}>{feedback}</Notice> : null}
    </DataSection>
    <DataSection title="신규 요청 이력" description="기존 입지 분석 산출물이나 raw output 경로는 노출하지 않습니다.">
      {workspace.locationCardRequests.length ? <ul className="v2-record-list">{workspace.locationCardRequests.map((item) => <li key={item.clientRequestId}><div><strong>{item.label}</strong><span>{item.detail || item.requestedAt}</span></div><StatusBadge tone="info">{item.status}</StatusBadge></li>)}</ul> : <EmptyState title="입지카드 요청이 없습니다" description="신규 수집된 내 업체를 선택해 첫 제작 요청을 시작해 주세요." />}
    </DataSection>
  </>;
}

export function AdminOverviewPage({ workspace }: CorePageProps) {
  return <>
    {workspace.notices.length ? <Notice tone="warning">{workspace.notices.join(" · ")}</Notice> : null}
    <div className="v2-two-column">
      <DataSection title="최근 신규 수집 run" testId="admin-recent-runs">
        {workspace.jobs.length ? <ul className="v2-record-list">{workspace.jobs.slice(0, 5).map((job) => <li key={job.clientRequestId}><div><strong>{job.query || job.kind}</strong><span>{job.progressLabel} · {job.etaLabel}</span>{job.resultValues.length ? <span className="v2-result-values">{job.resultValues.map((value) => `${value.label} ${value.value}`).join(" · ")}</span> : null}</div><StatusBadge tone={job.status === "completed" ? "success" : "info"}>{job.status}</StatusBadge></li>)}</ul> : <p className="v2-inline-empty">실행된 신규 수집이 없습니다.</p>}
      </DataSection>
      <DataSection title="Connector 준비 상태" testId="admin-connector-summary">
        {workspace.connectors.length ? <ul className="v2-record-list">{workspace.connectors.slice(0, 5).map((connector) => <li key={connector.id}><div><strong>{connector.label}</strong><span>{connector.detail}</span></div><StatusBadge tone={connector.status === "ready" ? "success" : "warning"}>{connector.status}</StatusBadge></li>)}</ul> : <p className="v2-inline-empty">승인된 connector가 없습니다.</p>}
      </DataSection>
    </div>
    <DataSection title="운영 시작점" description="신규 수집 계획과 업체 DB를 순서대로 검토합니다.">
      <div className="v2-link-grid"><a href="/admin/collection">수집 계획 열기 <span>→</span></a><a href="/admin/companies">업체 DB 열기 <span>→</span></a></div>
    </DataSection>
  </>;
}

export function AdminCompaniesPage({ workspace, reload }: CorePageProps) {
  const [selectedId, setSelectedId] = useState(workspace.companies[0]?.companyId || "");
  const selected = workspace.companies.find((company) => company.companyId === selectedId) || workspace.companies[0];
  if (!workspace.companies.length) return <DataSection title="신규 업체 DB" testId="company-table"><EmptyState title="신규 수집 업체가 없습니다" description="기존 V2·Cluster 업체 DB는 읽지 않습니다. 수집 계획을 실행하면 새 통합 store 결과만 이곳에 표시됩니다." action={<a className="v2-button v2-button--primary" href="/admin/collection">수집 계획 열기</a>} /></DataSection>;
  return <div className="v2-master-detail">
    <DataSection title="신규 업체 DB" description={`${workspace.companies.length}개 신규 업체`} testId="company-table">
      <div className="v2-company-table" role="list" aria-label="신규 업체 DB">
        {workspace.companies.map((company) => <button key={company.companyId} type="button" role="listitem" data-selected={company.companyId === selected?.companyId} onClick={() => setSelectedId(company.companyId)}>
          <span><strong>{company.name}</strong><small>{company.region}</small></span><StatusBadge tone="info">{company.status}</StatusBadge>
        </button>)}
      </div>
    </DataSection>
    <DataSection title="업체 상세" description="완전성·freshness·confidence와 business-safe 출처·변경·관측 요약만 표시합니다." testId="company-detail">
      <CompanyDetailPanel company={selected} role="admin" state={selected ? undefined : "empty"} onRetry={() => { void reload(); }} />
    </DataSection>
  </div>;
}

export function AdminCollectionPage({ workspace, reload }: CorePageProps) {
  const [keyword, setKeyword] = useState("");
  const [collectionPlan, setCollectionPlan] = useState<CollectionPlanFields>(defaultCollectionPlan);
  const [regionCode, setRegionCode] = useState("");
  const [tourismBusy, setTourismBusy] = useState(false);
  const [feedback, setFeedback] = useState("");
  const collection = useRecoverableJob("admin-collection", reload);
  const currentJob = collection.job || workspace.jobs.find((job) => job.kind === "admin-collection") || null;
  const collectionActive = Boolean(currentJob && ["queued", "running"].includes(currentJob.status));
  const collectionCapability = workspace.collectionCapability;
  const tourismConnector = workspace.connectors.find((connector) => connector.id === "tourism");
  const tourismEnabled = collectionCapability.realProviderEnabled
    && tourismConnector?.configured === true
    && tourismConnector.status === "ready";
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const blockedReason = adminLodgingCollectionBlockReason(collectionCapability, keyword, collectionPlan);
    if (blockedReason) { setFeedback(blockedReason); return; }
    setFeedback("");
    await collection.start(collectionPayload(collectionPlan, keyword.trim()));
  };
  const requestTourism = async () => {
    if (!tourismEnabled) { setFeedback("관광 실수집 connector가 별도로 승인·구성되지 않았습니다."); return; }
    setTourismBusy(true);
    setFeedback("");
    try {
      await requestTourismCollection(newClientRequestId(), regionCode.trim() || undefined);
      setFeedback("관광 신규 수집 요청을 접수했습니다.");
      await reload();
    } catch (reason) { setFeedback(reason instanceof Error ? reason.message : "관광 수집 요청을 접수하지 못했습니다."); }
    finally { setTourismBusy(false); }
  };
  return <>
    <DataSection title="신규 데이터 생성 계획" description="서버가 실행 mode와 provider 연결을 명시적으로 확인한 경우에만 실행할 수 있습니다." testId="admin-collection-form">
      <Notice tone={collectionCapabilityTone(collectionCapability)}>{collectionCapability.sourceLabel} · {collectionCapability.detail}</Notice>
      <form className="v2-action-form v2-collection-form" onSubmit={submit}>
        <label className="v2-field"><span>수집 대상 업체명</span><input required value={keyword} onChange={(event) => setKeyword(event.target.value)} placeholder="예: 경남 신규 글램핑" /></label>
        <CollectionPlanInputs value={collectionPlan} onChange={setCollectionPlan} />
        <div className="v2-collection-actions"><Button type="submit" disabled={!collectionCapability.executionEnabled || collection.busy || collectionActive}>{collectionButtonLabel(collectionCapability, "실제 수집 실행", "테스트 데이터 생성")}</Button></div>
      </form>
    </DataSection>
    <DataSection title="실행 진행·취소" description="같은 clientRequestId는 중복 실행하지 않으며 새로고침 뒤 상태를 복구합니다.">
      <JobProgress job={currentJob} busy={collection.busy} error={collection.error} operationLabel={collectionCapability.sourceLabel} onCancel={() => void collection.cancel(currentJob?.clientRequestId)} onResume={() => void collection.resume(currentJob?.clientRequestId)} onRefresh={() => void collection.refreshJob(currentJob?.clientRequestId)} />
    </DataSection>
    <DataSection title="관광 신규 수집 요청" description="승인된 관광 provider가 구성된 경우에만 실제 요청을 실행합니다. 미구성 상태에서는 결과를 만들지 않습니다." testId="tourism-request-form">
      <div className="v2-action-form">
        <label className="v2-field"><span>행정구역 코드 (선택)</span><input value={regionCode} onChange={(event) => setRegionCode(event.target.value)} placeholder="예: 48" /></label>
        <Button variant="secondary" type="button" disabled={!tourismEnabled || tourismBusy} onClick={() => void requestTourism()}>{tourismEnabled ? "관광 실제 수집 요청" : "관광 실수집 미연결"}</Button>
      </div>
      {!tourismEnabled ? <Notice tone="warning">숙소 수집 provider와 관광 provider는 별도입니다. 관광 connector 승인 전에는 이 요청을 실행하지 않습니다.</Notice> : null}
      {feedback ? <Notice tone={feedback.includes("접수") ? "success" : "danger"}>{feedback}</Notice> : null}
      {workspace.tourismRequests.length ? <ul className="v2-record-list">{workspace.tourismRequests.map((item) => <li key={item.clientRequestId}><div><strong>{item.label}</strong><span>{item.detail || item.requestedAt}</span></div><StatusBadge>{item.status}</StatusBadge></li>)}</ul> : null}
    </DataSection>
  </>;
}

export function AdminSettingsPage({ workspace }: CorePageProps) {
  return <>
    <DataSection title="Traffic·Connector 상태" description="설정값·token·raw 경로는 숨기고 승인 및 연결 상태만 표시합니다." testId="connector-status">
      {workspace.connectors.length ? <div className="v2-connector-grid">{workspace.connectors.map((connector) => <article key={connector.id}>
        <header><strong>{connector.label}</strong><StatusBadge tone={connector.status === "ready" ? "success" : connector.status === "error" ? "warning" : "info"}>{connector.status}</StatusBadge></header>
        <p>{connector.detail}</p><small>{connector.configured ? "보안 저장소에 구성됨" : "키 값 미표시"}</small>
      </article>)}</div> : <EmptyState title="구성된 connector가 없습니다" description="실제 provider 승인을 받기 전에는 연결을 시도하지 않습니다." />}
    </DataSection>
    <DataSection title="안전 기준" description="V2 우선 계산 계약과 fresh-only 데이터 경계를 유지합니다.">
      <ul className="v2-policy-list"><li><span>V2·Cluster runtime 데이터 읽기</span><strong>차단</strong></li><li><span>실제 provider 호출</span><strong>승인·quota 확인 후 허용</strong></li><li><span>통합 플랫폼 core flag</span><strong>기본 OFF</strong></li></ul>
    </DataSection>
  </>;
}

export function DeferredPage() {
  return <DataSection title="이 기능은 후속 단계에서 연결됩니다"><EmptyState title="현재 단계의 대상이 아닙니다" description="Stage 227은 시작 안내, 검색·관심, 입지카드와 관리자 핵심 운영 여정만 구현합니다. 지도·forecast·전략 기능은 선행하지 않습니다." action={<StatusBadge>fresh-only</StatusBadge>} /></DataSection>;
}
