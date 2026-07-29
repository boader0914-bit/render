import { EmptyState, MetricCard, StatusBadge } from "@glamping-datalab-v2/ui";
import type { CoreCompany } from "./coreClient";

export type CompanyDetailViewState = "loading" | "error" | "empty" | "ready" | "partial";

interface CompanyDetailPanelProps {
  company: CoreCompany | null | undefined;
  role: "admin" | "business";
  state?: CompanyDetailViewState;
  onRetry?: () => void;
}

function StatePanel({ state, onRetry }: { state: "loading" | "error" | "empty"; onRetry?: () => void }) {
  const copy = {
    loading: ["업체 상세를 불러오는 중입니다", "fresh store의 business-safe 필드만 확인하고 있습니다."],
    error: ["업체 상세를 불러오지 못했습니다", "과거 데이터로 대신 채우지 않습니다. 잠시 후 다시 확인해 주세요."],
    empty: ["표시할 신규 업체 상세가 없습니다", "신규 수집이 완료되면 검증된 값과 관측 요약이 이곳에 표시됩니다."]
  }[state];
  return <div className="v2-company-fresh-detail" data-testid="company-fresh-detail" data-detail-state={state}>
    <EmptyState
      title={copy[0]}
      description={copy[1]}
      action={state === "error" && onRetry
        ? <button className="v2-button v2-button--secondary" type="button" onClick={onRetry}>다시 시도</button>
        : <StatusBadge tone={state === "loading" ? "info" : "warning"}>{state === "loading" ? "확인 중" : "fresh-only"}</StatusBadge>}
    />
  </div>;
}

export function CompanyDetailPanel({ company, role, state, onRetry }: CompanyDetailPanelProps) {
  if (state === "loading" || state === "error") return <StatePanel state={state} onRetry={onRetry} />;
  if (!company || state === "empty" || company.freshDetail?.state === "empty") return <StatePanel state="empty" />;
  const detail = company.freshDetail;
  const detailState: CompanyDetailViewState = state || detail?.state || "partial";
  const enrichmentHref = role === "admin"
    ? `/admin/collection?companyId=${encodeURIComponent(company.companyId)}`
    : `/app/activity?companyId=${encodeURIComponent(company.companyId)}`;

  return <article
    className="v2-company-fresh-detail"
    data-testid="company-fresh-detail"
    data-detail-state={detailState}
    data-detail-role={role}
  >
    <header className="v2-company-detail-heading">
      <div><strong>{company.name}</strong><span>{company.region}</span></div>
      <StatusBadge tone={detailState === "ready" ? "success" : "warning"}>{detailState === "ready" ? "수집 완료" : "일부 보강 필요"}</StatusBadge>
    </header>

    {!detail ? <div className="v2-company-detail-gap" role="status">
      <div><strong>business-safe 상세가 아직 준비되지 않았습니다</strong><p>기존 파일이나 raw output으로 값을 채우지 않습니다. 승인된 신규 수집 결과를 기다려 주세요.</p></div>
      <a className="v2-button v2-button--secondary" href={enrichmentHref}>신규 수집으로 보강하기</a>
    </div> : <>
      {detailState === "partial" ? <p className="v2-core-notice" data-tone="warning" role="status">일부 필드가 비어 있습니다. 확인된 값은 그대로 표시하고 누락값을 추정하지 않습니다.</p> : null}

      <div className="v2-company-detail-metrics" data-testid="company-detail-metrics">
        <MetricCard label="완전성" value={detail.completeness.displayValue} detail={detail.completeness.detail} tone={detail.completeness.state === "complete" ? "success" : "warning"} />
        <MetricCard label="Freshness" value={detail.freshness.displayValue} detail={detail.freshness.detail} tone={detail.freshness.state === "fresh" ? "success" : "warning"} />
        <MetricCard label="Confidence" value={detail.confidence.displayValue} detail={detail.confidence.detail} tone={detail.confidence.state === "high" ? "success" : "info"} />
      </div>

      <section className="v2-company-detail-block" data-testid="company-provenance-summary">
        <header><h3>출처 요약</h3><StatusBadge>business-safe</StatusBadge></header>
        <p>{detail.provenance.summary}</p>
        <dl className="v2-company-detail-facts">
          <div><dt>출처 수</dt><dd>{detail.provenance.sourceCount || "확인 중"}</dd></div>
          <div><dt>마지막 검증</dt><dd>{detail.provenance.lastVerifiedAt || "확인 중"}</dd></div>
          <div><dt>검증 근거</dt><dd>{detail.confidence.basis}</dd></div>
          <div><dt>검증 필드</dt><dd>{detail.completeness.verifiedFields || "확인 중"} / {detail.completeness.totalFields || "확인 중"}</dd></div>
          <div><dt>관측 시각</dt><dd>{detail.freshness.observedAt || "확인 중"}</dd></div>
          <div><dt>유효 기준</dt><dd>{detail.freshness.validUntil || "확인 중"}</dd></div>
        </dl>
        {detail.completeness.missingFields.length ? <small className="v2-company-detail-missing">완전성 누락: {detail.completeness.missingFields.join(", ")}</small> : null}
      </section>

      <section className="v2-company-detail-block" data-testid="company-verified-values">
        <header><h3>검증된 값</h3><StatusBadge tone="success">verified only</StatusBadge></header>
        {detail.verifiedValues.length ? <dl className="v2-verified-value-list">
          {detail.verifiedValues.map((item) => <div key={`${item.field}-${item.verifiedAt}`}>
            <dt>{item.label}<small>{item.verifiedAt || "검증 시각 확인 중"}</small></dt><dd>{item.value}</dd>
          </div>)}
        </dl> : <p className="v2-company-detail-empty">공개 가능한 검증값이 아직 없습니다.</p>}
      </section>

      <section className="v2-company-detail-block" data-testid="company-observation-summary">
        <header><h3>반복 관측 요약</h3><StatusBadge tone="info">{detail.observations.displayCount}</StatusBadge></header>
        <p>{detail.observations.summary}</p>
        <dl className="v2-company-detail-facts">
          <div><dt>반복 관측</dt><dd>{detail.observations.repeatCount}회</dd></div>
          <div><dt>최초 관측</dt><dd>{detail.observations.firstObservedAt || "확인 중"}</dd></div>
          <div><dt>최근 관측</dt><dd>{detail.observations.lastObservedAt || "확인 중"}</dd></div>
        </dl>
      </section>

      <section className="v2-company-detail-block" data-testid="company-change-history">
        <header><h3>변경 이력</h3><StatusBadge>{detail.changes.length}건</StatusBadge></header>
        {detail.changes.length ? <ol className="v2-company-change-list">
          {detail.changes.map((change) => <li key={change.changeId}>
            <div><strong>{change.fieldLabel}</strong><time>{change.changedAt}</time></div>
            <p><span>{change.previousValue}</span><b aria-label="변경됨">→</b><span>{change.currentValue}</span></p>
          </li>)}
        </ol> : <p className="v2-company-detail-empty">신규 수집 이후 확인된 변경 이력이 없습니다.</p>}
      </section>

      <section className="v2-company-detail-enrichment" data-testid="company-enrichment-cta">
        <div><strong>{detail.enrichment.ctaLabel}</strong><p>{detail.enrichment.detail}</p>
          <span><StatusBadge tone="warning">{detail.enrichment.state}</StatusBadge>{detail.enrichment.missingFields.length ? <small>보강 대상: {detail.enrichment.missingFields.join(", ")}</small> : null}</span>
        </div>
        <a className="v2-button v2-button--primary" href={enrichmentHref}>{detail.enrichment.ctaLabel}</a>
      </section>
    </>}
  </article>;
}
