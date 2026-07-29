import { useMemo, useState, type FormEvent, type ReactNode } from "react";
import { Button, EmptyState, StatusBadge } from "@glamping-datalab-v2/ui";
import type { SessionPayload } from "../apiClient";
import {
  addCoreInterest,
  newClientRequestId,
  removeCoreInterest,
  requestLocationCard,
  requestTourismCollection,
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

function JobProgress({ job, busy, error, onCancel, onRefresh }: {
  job: CoreJob | null;
  busy: boolean;
  error: string;
  onCancel: () => void;
  onRefresh: () => void;
}) {
  if (!job) return <EmptyState title="진행 중인 신규 수집이 없습니다" description="요청을 시작하면 멱등 clientRequestId로 같은 탭의 새로고침 이후에도 진행 상태를 복구합니다." />;
  const active = job.status === "queued" || job.status === "running";
  return <article className="v2-job-card" data-testid="job-progress" data-job-status={job.status}>
    <div className="v2-job-heading">
      <div><strong>{job.query || job.kind}</strong><small>요청 ID {job.clientRequestId}</small></div>
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
      {active ? <Button variant="quiet" type="button" disabled={busy} onClick={onCancel}>수집 취소</Button> : null}
    </div>
  </article>;
}

function CompanyList({ companies, interests, onToggleInterest, onSelectCompany, selectedCompanyId, busyCompanyId }: {
  companies: readonly CoreCompany[];
  interests: ReadonlySet<string>;
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
    <DataSection title="현재 데이터 경계" description="Stage 227은 합성 fresh-collection fixture 기반 provisional acceptance입니다.">
      <div className="v2-boundary-grid">
        <div><span>표시 출처</span><strong>{workspace.source === "synthetic-fresh-integration" ? "Stage 228 fresh integration" : workspace.source === "synthetic-fresh-collection" ? "합성 신규 수집" : "빈 통합 store"}</strong></div>
        <div><span>기존 데이터 이관</span><strong>0건</strong></div>
        <div><span>실제 provider 호출</span><strong>사용 안 함</strong></div>
      </div>
    </DataSection>
  </>;
}

export function BusinessActivityPage({ workspace, session, reload }: CorePageProps) {
  const [keyword, setKeyword] = useState("");
  const [interestBusy, setInterestBusy] = useState("");
  const [mutationError, setMutationError] = useState("");
  const searchJob = useRecoverableJob("business-search", reload);
  const lodgeJob = useRecoverableJob("business-my-lodge", reload);
  const activeJob = searchJob.job || lodgeJob.job || workspace.jobs[0] || null;
  const activeController = searchJob.job ? searchJob : lodgeJob.job ? lodgeJob : searchJob;
  const interestIds = useMemo(() => new Set(workspace.interests.map((item) => item.companyId)), [workspace.interests]);
  const ownedCompanyId = session.companyId || workspace.tenantCompanyId;
  const [selectedCompanyId, setSelectedCompanyId] = useState(workspace.companies[0]?.companyId || "");
  const selectedCompany = workspace.companies.find((company) => company.companyId === selectedCompanyId) || workspace.companies[0] || null;
  const searchActive = Boolean(searchJob.job && ["queued", "running"].includes(searchJob.job.status));
  const lodgeActive = Boolean(lodgeJob.job && ["queued", "running"].includes(lodgeJob.job.status));

  const submitSearch = async (event: FormEvent) => {
    event.preventDefault();
    const trimmed = keyword.trim();
    if (!trimmed) { setMutationError("검색할 업체명 또는 지역을 입력해 주세요."); return; }
    setMutationError("");
    await searchJob.start({ keyword: trimmed });
  };

  const collectMyLodge = async () => {
    if (!ownedCompanyId) { setMutationError("계정에 연결된 업체가 없어 내 숙소 수집을 요청할 수 없습니다."); return; }
    setMutationError("");
    await lodgeJob.start({ companyId: ownedCompanyId, keyword: workspace.tenantCompanyName || "내 숙소" });
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
    <DataSection title="업체 검색과 내 숙소 수집" description="동일한 clientRequestId 재요청은 새 작업을 중복 생성하지 않습니다." testId="business-search-form">
      <form className="v2-action-form" onSubmit={submitSearch}>
        <label className="v2-field"><span>업체명 또는 지역</span><input value={keyword} onChange={(event) => setKeyword(event.target.value)} placeholder="예: 합성 해변 글램핑" autoComplete="off" /></label>
        <Button type="submit" disabled={searchJob.busy || searchActive}>업체 검색 요청</Button>
        <Button variant="secondary" type="button" disabled={lodgeJob.busy || lodgeActive || !ownedCompanyId} onClick={collectMyLodge}>내 숙소 수집 요청</Button>
      </form>
      {mutationError ? <Notice tone="danger">{mutationError}</Notice> : null}
    </DataSection>
    <DataSection title="수집 진행" description="진행률과 예상 시간은 V2 호환 API가 제공한 값을 그대로 표시합니다.">
      <JobProgress job={activeJob} busy={activeController.busy} error={activeController.error} onCancel={() => void activeController.cancel(activeJob?.clientRequestId)} onRefresh={() => void activeController.refreshJob(activeJob?.clientRequestId)} />
    </DataSection>
    <DataSection title="신규 수집 결과" description="합성 fresh-collection fixture 또는 Stage 228 이후 실제 신규 수집 결과만 표시합니다." testId="fresh-company-results">
      <CompanyList
        companies={workspace.companies}
        interests={interestIds}
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

export function AdminCompaniesPage({ workspace }: CorePageProps) {
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
      <CompanyDetailPanel company={selected} role="admin" state={selected ? undefined : "empty"} />
    </DataSection>
  </div>;
}

export function AdminCollectionPage({ workspace, reload }: CorePageProps) {
  const [keyword, setKeyword] = useState("");
  const [regionCode, setRegionCode] = useState("");
  const [tourismBusy, setTourismBusy] = useState(false);
  const [feedback, setFeedback] = useState("");
  const collection = useRecoverableJob("admin-collection", reload);
  const currentJob = collection.job || workspace.jobs.find((job) => job.kind === "admin-collection") || null;
  const collectionActive = Boolean(currentJob && ["queued", "running"].includes(currentJob.status));
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setFeedback("");
    await collection.start({ ...(keyword.trim() ? { keyword: keyword.trim() } : {}) });
  };
  const requestTourism = async () => {
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
    <DataSection title="신규 수집 계획" description="Stage 224 예산과 provider 승인 범위 안에서 합성 fixture 요청만 검증합니다." testId="admin-collection-form">
      <form className="v2-action-form" onSubmit={submit}>
        <label className="v2-field"><span>계획 키워드 (선택)</span><input value={keyword} onChange={(event) => setKeyword(event.target.value)} placeholder="예: 경남 신규 글램핑" /></label>
        <Button type="submit" disabled={collection.busy || collectionActive}>계획 실행 요청</Button>
      </form>
    </DataSection>
    <DataSection title="실행 진행·취소" description="같은 clientRequestId는 중복 실행하지 않으며 새로고침 뒤 상태를 복구합니다.">
      <JobProgress job={currentJob} busy={collection.busy} error={collection.error} onCancel={() => void collection.cancel(currentJob?.clientRequestId)} onRefresh={() => void collection.refreshJob(currentJob?.clientRequestId)} />
    </DataSection>
    <DataSection title="관광 신규 수집 요청" description="실제 provider 호출은 하지 않으며 Stage 228 gate 전까지 provisional 요청으로만 기록합니다." testId="tourism-request-form">
      <div className="v2-action-form">
        <label className="v2-field"><span>행정구역 코드 (선택)</span><input value={regionCode} onChange={(event) => setRegionCode(event.target.value)} placeholder="예: 48" /></label>
        <Button variant="secondary" type="button" disabled={tourismBusy} onClick={() => void requestTourism()}>관광 수집 요청</Button>
      </div>
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
      <ul className="v2-policy-list"><li><span>V2·Cluster runtime 데이터 읽기</span><strong>차단</strong></li><li><span>실제 provider 호출</span><strong>Stage 228 전 차단</strong></li><li><span>통합 플랫폼 core flag</span><strong>기본 OFF</strong></li></ul>
    </DataSection>
  </>;
}

export function DeferredPage() {
  return <DataSection title="이 기능은 후속 단계에서 연결됩니다"><EmptyState title="현재 단계의 대상이 아닙니다" description="Stage 227은 시작 안내, 검색·관심, 입지카드와 관리자 핵심 운영 여정만 구현합니다. 지도·forecast·전략 기능은 선행하지 않습니다." action={<StatusBadge>fresh-only</StatusBadge>} /></DataSection>;
}
