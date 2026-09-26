(function (root) {
  "use strict";
  const TYPES = { company: "업체별", keyword: "키워드별", region: "지역별" };
  const STATUSES = { draft: "초안", review: "검토 중", published: "발행됨" };
  const instances = new WeakMap();
  const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
  const number = (value) => value == null || !Number.isFinite(Number(value)) ? "확인 불가" : Number(value).toLocaleString("ko-KR", { maximumFractionDigits: 1 });
  const percent = (value) => value == null || !Number.isFinite(Number(value)) ? "확인 불가" : `${number(Number(value) * 100)}%`;
  const won = (value) => value == null ? "확인 불가" : `${number(value)}원`;
  const count = (value, unit = "건") => value == null ? "확인 불가" : `${number(value)}${unit}`;
  const today = () => new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Seoul" }).format(new Date());
  const defaultCutoff = (month, currentDay = today()) => {
    if (!/^\d{4}-\d{2}$/.test(month)) return currentDay;
    const [year, part] = month.split("-").map(Number);
    const end = new Date(Date.UTC(year, part, 0)).toISOString().slice(0, 10);
    return end < currentDay ? end : currentDay;
  };
  const canPublish = (report, acknowledged) => report?.status === "review" && acknowledged === true;
  const statusTag = (status) => `<span class="mr-status mr-status-${Object.hasOwn(STATUSES, status) ? status : "draft"}">${escapeHtml(STATUSES[status] || status || "미리보기")}</span>`;
  const textValue = (value) => typeof value === "string" ? value : value?.message || value?.label || value?.description || JSON.stringify(value ?? "");
  const timeLabel = (value) => {
    if (!value) return "기록 없음";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? String(value) : new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", dateStyle: "medium", timeStyle: "short" }).format(date);
  };
  function metricCard(label, metric = {}, secondary = false) {
    metric = metric || {};
    const unit = secondary ? "회" : "실·박";
    return `<section class="mr-metric-card${secondary ? " mr-dayuse" : ""}" aria-label="${escapeHtml(label)}">
      <div class="mr-section-title"><h3>${escapeHtml(label)}</h3><span class="mr-muted">${secondary ? "별도 집계" : "숙박일 기준"}</span></div>
      <p class="mr-amount">${won(metric.estimatedRevenue)}<small>추정 매출${metric.revenuePartial ? " · 일부 자료" : ""}</small></p>
      <div class="mr-split"><div class="mr-public"><span>공개 예약</span><strong>${count(metric.publicBookings, unit)}</strong><small>추정 매출 ${won(metric.publicRevenue)}</small></div><div class="mr-phone"><span>방막기 추정</span><strong>${count(metric.phoneBookings, unit)}</strong><small>추정 매출 ${won(metric.phoneRevenue)}</small></div></div>
      <dl class="mr-inline-metrics"><div><dt>예약 추정 / 공급 합계 (${unit})</dt><dd>${number(metric.sold)} / ${number(metric.supply)}</dd></div><div><dt>관측 예약 추정률</dt><dd>${percent(metric.reservationRate)}</dd></div><div><dt>자료 충족률</dt><dd>${percent(metric.coverageRate)}</dd></div></dl>
      <p class="mr-unit-note">${secondary ? "데이유즈 이용 수량을 회 단위로 별도 집계합니다." : "실·박은 일자별 객실 수를 합한 값입니다."}</p>
      ${metric.knownPartialRevenue != null && (metric.partial || Number(metric.knownPartialRevenue) > 0) ? `<p class="mr-partial-note">부분 자료에서 확인한 금액 <strong>${won(metric.knownPartialRevenue)}</strong><small>위 추정 매출에 합산하지 않은 별도 소계입니다.</small></p>` : ""}
    </section>`;
  }
  function capacityLabel(company = {}) {
    return Number.isFinite(Number(company.capacity)) && Number(company.capacity) > 0 ? `<span class="mr-capacity" title="${escapeHtml(company.capacitySource || "등록된 객실 규모")}">객실 규모 ${number(company.capacity)}실</span>` : "";
  }
  function exclusionSummary(quality) {
    const reasons = quality.discardedByReason || {};
    const sum = (keys) => keys.reduce((total, key) => total + (Number(reasons[key]) || 0), 0);
    const dedupKeys = ["duplicate_observation", "superseded_observation"];
    const timeKeys = ["after_cutoff", "post_stay_observation"];
    const dedup = sum(dedupKeys), timing = sum(timeKeys);
    const other = sum(Object.keys(reasons).filter((key) => !dedupKeys.includes(key) && !timeKeys.includes(key)));
    const unknown = Math.max(0, (Number(quality.discardedObservationCount) || 0) - dedup - timing - other);
    return `<div class="mr-exclusions"><span>중복·이전 관측 ${count(dedup)} <small>최신값 선택에 따른 정상 제외</small></span>${timing ? `<span>시점 기준 제외 ${count(timing)}</span>` : ""}${other ? `<span class="mr-exclusion-warning">근거·품질 등 기준 미충족 ${count(other)}</span>` : ""}${unknown ? `<span>기타 집계 제외 ${count(unknown)} · 세부 사유 확인 불가</span>` : ""}</div>`;
  }
  function freshnessSummary(quality) {
    if (quality.sameDayObservedCompanyDays == null && quality.staleDays == null) return "";
    return `<div class="mr-freshness"><strong>예약 관측 시점</strong><p>숙박 당일 관측 ${number(quality.sameDayObservedCompanyDays)} · 사전 관측 ${number(quality.staleDays)} 업체·숙박일</p>${quality.minObservationLeadTimeDays != null ? `<p>숙박일보다 ${number(quality.minObservationLeadTimeDays)}~${number(quality.maxObservationLeadTimeDays)}일 전 관측 · 중간값 ${number(quality.medianObservationLeadTimeDays)}일 전</p>` : ""}<small>자료 충족률 100%여도 사전 관측만 있다면 최종 예약 상태나 실제 매출을 뜻하지 않습니다.</small></div>`;
  }
  function renderContext(context = {}) {
    const sources = Array.isArray(context.sources) ? context.sources : [];
    const warnings = Array.isArray(context.warnings) ? context.warnings : [];
    if (!sources.length && !warnings.length) return "";
    return `<details class="mr-fold"><summary>지역·공공 자료 <span>출처별 기준기간</span></summary><div class="mr-fold-content">${warnings.length ? `<ul>${warnings.map((warning) => `<li>${escapeHtml(textValue(warning))}</li>`).join("")}</ul>` : ""}${sources.map((source) => `<section class="mr-context-source"><h4>${escapeHtml(source.label || "참고 자료")}${source.referenceOnly ? " · 참고용" : ""}</h4><p>${escapeHtml([source.provider, source.regionLabel, source.period].filter(Boolean).join(" · "))}</p><p>저장 시각 ${escapeHtml(timeLabel(source.retrievedAt))}${source.sourceUpdatedAt ? ` · 원자료 갱신 ${escapeHtml(timeLabel(source.sourceUpdatedAt))}` : ""} (한국시간)</p>${source.rows?.length ? `<dl>${source.rows.map((row) => `<div><dt>${escapeHtml(row.label || "지표")}</dt><dd>${row.value == null ? "확인 불가" : `${escapeHtml(typeof row.value === "number" ? number(row.value) : row.value)} ${escapeHtml(row.unit || "")}`}</dd></div>`).join("")}</dl>` : '<p>해당 월에 사용할 수 있는 저장 자료가 없습니다.</p>'}${/^https?:\/\//i.test(source.sourceUrl || "") ? `<a href="${escapeHtml(source.sourceUrl)}" target="_blank" rel="noopener noreferrer">출처 보기</a>` : ""}</section>`).join("")}</div></details>`;
  }
  function dailyTable(rows = [], caption = "날짜별 숙박 자료") {
    if (!rows.length) return '<p class="mr-empty">날짜별 자료가 없습니다.</p>';
    return `<div class="mr-table-scroll" tabindex="0" role="region" aria-label="${escapeHtml(caption)}"><table><caption>${escapeHtml(caption)}</caption><thead><tr><th scope="col">숙박일</th><th scope="col">공급 (실)</th><th scope="col">예약 추정 (실)</th><th scope="col" class="mr-public">공개 예약 (실)</th><th scope="col" class="mr-phone">방막기 추정 (실)</th><th scope="col">숙박 추정 매출</th><th scope="col">데이유즈 추정 매출</th><th scope="col">충족률</th></tr></thead><tbody>${rows.map((row) => `<tr><th scope="row">${escapeHtml(row.date)}</th><td>${number(row.lodging?.supply)}</td><td>${number(row.lodging?.sold)}</td><td class="mr-public">${number(row.lodging?.publicBookings)}</td><td class="mr-phone">${number(row.lodging?.phoneBookings)}</td><td>${won(row.lodging?.estimatedRevenue)}</td><td>${won(row.dayuse?.estimatedRevenue)}</td><td>${percent(row.lodging?.coverageRate)}</td></tr>`).join("")}</tbody></table></div>`;
  }
  function renderSnapshot(snapshot = {}) {
    const quality = snapshot.quality || {};
    const warnings = Array.isArray(quality.warnings) ? quality.warnings : [];
    const globalWarnings = Array.isArray(quality.globalWarnings) ? quality.globalWarnings : [];
    const globalWarningsMarkup = globalWarnings.length ? `<section class="mr-context-source" aria-label="전체 DB 참고"><h4>전체 DB 참고</h4><p>아래 내용은 본 리포트의 품질 판단과 별도인 전체 DB 참고 정보입니다.</p><ul>${globalWarnings.map((warning) => `<li>${escapeHtml(textValue(warning))}</li>`).join("")}</ul></section>` : "";
    const companies = snapshot.companies || [];
    const period = snapshot.period || {};
    const runs = snapshot.sources?.runs || [];
    const ranks = snapshot.ranks?.rows || [];
    const definitions = snapshot.definitions || {};
    const definitionLabels = { month: "대상 월", latestObservation: "관측 선택", coverage: "자료 충족률", reservationRate: "관측 예약 추정률", estimatedRevenue: "추정 매출", phoneBookings: "방막기 추정", knownPartialRevenue: "부분 자료 금액", dayuse: "데이유즈", changes: "관측 변화", ranks: "노출 순위", context: "참고 자료", publication: "발행 기준" };
    const definitionsMarkup = Array.isArray(definitions) ? definitions.map(textValue) : Object.entries(definitions).map(([key, value]) => `${definitionLabels[key] || "기준"}: ${textValue(value)}`);
    return `<div class="mr-snapshot">
      <div class="mr-basis">${period.monthClosed === false ? '<span class="mr-status mr-status-review">중간 집계</span>' : ""}<span>대상 숙박일 <strong>${escapeHtml(period.start || "—")} ~ ${escapeHtml(period.end || "—")}</strong></span><span>관측 마감일 <strong>${escapeHtml(period.cutoffDate || snapshot.request?.cutoffDate || "—")}</strong> (한국시간)</span></div>
      <section class="mr-quality${warnings.length || Number(quality.coverageRate) < 1 ? " has-warning" : ""}" aria-label="자료 품질"><div><strong>자료 충족률 ${percent(quality.coverageRate)}</strong><span>${number(quality.coveredCompanyDays)} / ${number(quality.expectedCompanyDays)} 업체·숙박일</span></div><p>같은 업체·숙박일·상품 유형은 마감일 이전의 최신 유효 관측 1건만 반영합니다. 반복 수집 회차를 합산하지 않습니다.</p>${warnings.length ? `<ul>${warnings.map((warning) => `<li>${escapeHtml(textValue(warning))}</li>`).join("")}</ul>` : ""}<small>미확인 ${number(quality.missingCompanyDays)} 업체·숙박일 · 빈 자료는 0원으로 바꾸지 않습니다.</small>${exclusionSummary(quality)}${freshnessSummary(quality)}</section>
      ${companies.length === 1 ? capacityLabel(companies[0]) : ""}
      <div class="mr-metrics">${metricCard("숙박", snapshot.summary?.lodging)}${metricCard("데이유즈", snapshot.summary?.dayuse, true)}</div>
      <p class="mr-method-note">공개 예약은 수집 자료에 표시된 예약 수량입니다. 방막기 추정은 재고 근거로 산출한 전화·타채널 예약을 포함하며 직접 확인한 예약과 구분합니다. 표시한 매출은 관측 가격을 적용한 추정치이며 실제 결제 매출과 다를 수 있습니다. 숙박과 데이유즈는 따로 집계합니다.</p>
      <details class="mr-fold"><summary>날짜별 합계 <span>${number((snapshot.daily || []).length)}일</span></summary>${dailyTable(snapshot.daily)}</details>
      <details class="mr-fold"><summary>업체별 상세 <span>${number(companies.length)}개 업체</span></summary><div class="mr-company-list">${companies.length ? companies.map((company) => `<details class="mr-company"><summary><span>${escapeHtml(company.primaryName || company.companyId)} ${capacityLabel(company)}</span><span>${won(company.summary?.lodging?.estimatedRevenue)} <small>숙박 · ${percent(company.summary?.lodging?.coverageRate)}</small></span></summary>${dailyTable(company.daily, `${company.primaryName || company.companyId} 날짜별 자료`)}</details>`).join("") : '<p class="mr-empty">반영된 업체가 없습니다.</p>'}</div></details>
      <details class="mr-fold"><summary>관측 변화와 노출 순위 <span>비교 가능한 기록만</span></summary><div class="mr-fold-content"><p>동일 업체·숙박일의 첫 유효 관측과 마지막 유효 관측을 비교합니다. 월간 매출 합계와 별도 지표입니다.</p><dl class="mr-inline-metrics"><div><dt>숙박 판매 변화</dt><dd>${count(snapshot.changes?.lodging?.soldChange, "실·박")}</dd></div><div><dt>숙박 추정 매출 변화</dt><dd>${won(snapshot.changes?.lodging?.estimatedRevenueChange)}</dd></div><div><dt>비교 가능 관측 쌍</dt><dd>${number(snapshot.changes?.lodging?.comparablePairs)}</dd></div></dl>${ranks.length ? `<div class="mr-table-scroll" tabindex="0" role="region" aria-label="노출 순위 변화"><table><caption>저장된 키워드 노출 순위</caption><thead><tr><th>업체</th><th>키워드</th><th>처음</th><th>마지막</th><th>관측 횟수</th></tr></thead><tbody>${ranks.map((row) => `<tr><th scope="row">${escapeHtml(row.companyName || row.companyId)}</th><td>${escapeHtml(row.keyword)}</td><td>${number(row.firstRank)}</td><td>${number(row.lastRank)}</td><td>${number(row.observations)}</td></tr>`).join("")}</tbody></table></div>` : '<p class="mr-muted">비교 가능한 노출 순위 자료가 없습니다.</p>'}</div></details>
      <details class="mr-fold"><summary>출처와 산식 <span>저장된 근거 확인</span></summary><div class="mr-fold-content"><p>자료 수집시각과 숙박 대상일을 구분해 확인하세요. 아래 내용은 이 리포트를 만들 때 저장된 기준입니다.</p>${runs.length ? `<ul class="mr-source-list">${runs.map((run) => `<li><strong>${escapeHtml(run.keyword || run.label || run.runId || run.id)}</strong><span>수집 ${escapeHtml(timeLabel(run.collectedAt || run.finishedAt || run.createdAt))} (한국시간) · ${escapeHtml(run.runId || run.id || "")}</span><span>반영 ${number(run.selectedObservationCount)} / ${number(run.observationCount)}건${run.collectionQuality?.status === "partial" ? " · 일부 자료" : ""}</span></li>`).join("")}</ul>` : `<p>참조 수집 기록: ${escapeHtml((snapshot.sources?.runIds || []).join(", ") || "없음")}</p>`}${definitionsMarkup.length ? `<ul>${definitionsMarkup.map((definition) => `<li>${escapeHtml(definition)}</li>`).join("")}</ul>` : ""}${globalWarningsMarkup}</div></details>
      ${renderContext(snapshot.context)}
    </div>`;
  }
  function renderList(reports, filter, currentId) {
    const selected = reports.filter((report) => filter === "all" || report.status === filter);
    return selected.length ? `<div class="mr-report-list">${selected.map((report) => `<button type="button" class="mr-report-row${currentId === report.id ? " is-selected" : ""}" data-mr-action="open" data-report-id="${escapeHtml(report.id)}"${currentId === report.id ? ' aria-current="true"' : ""}><span class="mr-report-title">${escapeHtml(report.title || `${report.month} ${TYPES[report.type] || ""} 리포트`)}</span>${statusTag(report.status)}<span class="mr-row-meta">${escapeHtml(report.month)} · ${escapeHtml(report.targetLabel || report.target?.label || report.snapshot?.target?.label || report.targetId)} · ${escapeHtml(TYPES[report.type] || report.type)} · v${number(report.version || 1)} / 수정 ${number(report.revision)}</span></button>`).join("")}</div>` : '<div class="mr-empty"><strong>저장된 리포트가 없습니다.</strong><p>조건을 선택해 미리보기를 만든 다음 초안으로 저장하세요.</p></div>';
  }
  async function request(path, method = "GET", body) {
    const response = await root.fetch(`/api/monthly-reports${path}`, { method, credentials: "same-origin", headers: { "Accept": "application/json", ...(body === undefined ? {} : { "Content-Type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.message || data.error?.message || (typeof data.error === "string" ? data.error : "") || (response.status === 409 ? "다른 화면에서 리포트가 변경되었습니다. 목록을 새로고침한 뒤 다시 열어 주세요." : response.status === 401 || response.status === 403 ? "관리자 로그인이 필요합니다. 다시 로그인한 뒤 열어 주세요." : `요청을 처리하지 못했습니다 (${response.status}).`));
    return data;
  }
  function createController(container, api = request) {
    const state = { options: null, reports: [], filter: "all", form: { month: "", type: "company", targetId: "", cutoffDate: "" }, search: "", preview: null, previewRequest: null, previewToken: null, report: null, title: "", notes: "", acknowledged: false, busy: "", message: "", error: "" };
    const optionsForType = () => state.options?.[{ company: "companies", keyword: "keywords", region: "regions" }[state.form.type]] || [];
    const setReport = (report) => { state.report = report; state.preview = null; state.previewRequest = null; state.previewToken = null; state.title = report.title || ""; state.notes = report.notes || ""; state.acknowledged = false; };
    const invalidatePreview = () => { state.preview = null; state.previewRequest = null; state.previewToken = null; };
    function targetOptions() {
      const query = state.search.toLocaleLowerCase();
      return '<option value="">대상을 선택하세요</option>' + optionsForType().filter((option) => option.id === state.form.targetId || !query || `${option.label} ${option.id}`.toLocaleLowerCase().includes(query)).map((option) => `<option value="${escapeHtml(option.id)}"${option.id === state.form.targetId ? " selected" : ""}>${escapeHtml(option.label)}</option>`).join("");
    }
    function render() {
      const report = state.report;
      const snapshot = report?.snapshot || state.preview;
      const busy = state.busy ? " disabled" : "";
      const editable = report && ["draft", "review"].includes(report.status);
      container.innerHTML = `<div class="monthly-reports" aria-busy="${Boolean(state.busy)}"><header class="mr-intro"><div><p class="mr-eyebrow">MONTHLY REPORTS</p><h2>자료를 확인하고, 월간 리포트로 남기세요</h2><p>업체·키워드·지역별 예약 흐름과 추정 매출을 저장된 자료로 정리합니다.</p></div><span class="mr-private-label">관리자 전용</span></header>
        <div class="mr-notice" role="status" aria-live="polite">${escapeHtml(state.busy || state.message)}</div>${state.error ? `<div class="mr-error" role="alert">${escapeHtml(state.error)}</div>` : ""}
        <section class="mr-card mr-create" aria-label="월간 리포트 생성 조건"><div class="mr-section-title"><h3>새 리포트</h3><span class="mr-muted">① 조건 선택 → ② 미리보기 → ③ 초안 저장</span></div><form data-mr-form><div class="mr-form-grid"><label>대상 월<input type="month" name="month" value="${escapeHtml(state.form.month)}" max="${today().slice(0, 7)}" required${busy}></label><label>유형<select name="type"${busy}>${Object.entries(TYPES).map(([key, label]) => `<option value="${key}"${key === state.form.type ? " selected" : ""}>${label}</option>`).join("")}</select></label><label class="mr-target">대상<select name="targetId" required${busy}>${targetOptions()}</select></label><label>관측 마감일<input type="date" name="cutoffDate" value="${escapeHtml(state.form.cutoffDate)}" max="${today()}"${busy}><small>비우면 해당 월 말일, 진행 중인 달은 오늘</small></label></div><div class="mr-form-actions"><label class="mr-search-label"><span class="mr-sr-only">대상 검색</span><input type="search" name="targetSearch" value="${escapeHtml(state.search)}" placeholder="업체명·키워드·지역 검색" autocomplete="off"${busy}></label><button class="primary-button" type="submit"${busy || !state.options ? " disabled" : ""}>미리보기 만들기</button></div></form></section>
        <div class="mr-workspace"><aside class="mr-card mr-library" aria-label="저장 리포트"><div class="mr-section-title"><h3>저장 리포트 <span>${number(state.reports.length)}</span></h3><button type="button" class="mr-text-button" data-mr-action="refresh"${busy}>새로고침</button></div><div class="mr-filters" role="group" aria-label="발행 상태 필터">${Object.entries({ all: "전체", ...STATUSES }).map(([key, label]) => `<button type="button" data-mr-action="filter" data-filter="${key}" aria-pressed="${state.filter === key}"${busy}>${label}</button>`).join("")}</div>${renderList(state.reports, state.filter, report?.id)}</aside>
        <section class="mr-card mr-detail" aria-label="리포트 미리보기와 상세">${snapshot ? `<div class="mr-detail-heading"><div><p class="mr-eyebrow">${report ? `VERSION ${number(report.version || 1)} · 수정 ${number(report.revision)}` : "PREVIEW · 아직 저장하지 않았습니다"}</p><h3>${escapeHtml(report?.title || `${state.previewRequest?.month || snapshot.request?.month || ""} ${snapshot.target?.label || ""} 월간 리포트`)}</h3><p>${escapeHtml(snapshot.target?.label || report?.targetId)} · ${escapeHtml(TYPES[report?.type || snapshot.request?.type] || "")}</p></div>${report ? statusTag(report.status) : '<span class="mr-status">미리보기</span>'}</div>
        ${report ? `<p class="mr-dates">작성 ${escapeHtml(timeLabel(report.createdAt))} · 수정 ${escapeHtml(timeLabel(report.updatedAt))}${report.publishedAt ? ` · 발행 ${escapeHtml(timeLabel(report.publishedAt))}` : ""} (한국시간)</p>` : ""}
        ${editable || !report ? `<div class="mr-editor"><label>리포트 제목<input name="title" value="${escapeHtml(state.title)}" maxlength="200"${busy}></label><label>검토 메모<textarea name="notes" rows="3" maxlength="10000" placeholder="자료의 해석과 확인할 내용을 남기세요."${busy}>${escapeHtml(state.notes)}</textarea></label></div>` : report.notes ? `<p class="mr-notes">${escapeHtml(report.notes)}</p>` : ""}
        <div class="mr-lifecycle">${!report ? `<button class="primary-button" type="button" data-mr-action="save"${busy}>초안으로 저장</button><p>저장된 수치와 근거는 고정되며, 발행은 검토 단계에서 진행합니다.</p>` : editable ? `<div class="mr-button-row"><button class="secondary-button" type="button" data-mr-action="update"${busy}>제목·메모 저장</button><button class="secondary-button" type="button" data-mr-action="rebuild"${busy}>저장 자료로 다시 집계</button>${report.status === "draft" ? `<button class="primary-button" type="button" data-mr-action="review"${busy}>검토 단계로 이동</button>` : `<button class="secondary-button" type="button" data-mr-action="draft"${busy}>초안으로 돌리기</button>`}</div>${report.status === "review" ? `<div class="mr-publish"><label><input type="checkbox" name="qualityAck"${state.acknowledged ? " checked" : ""}${busy}>자료 충족률, 누락·제외 경고와 추정 매출 기준을 확인했습니다.</label><button class="primary-button" type="button" data-mr-action="publish"${busy || !canPublish(report, state.acknowledged) ? " disabled" : ""}>리포트 발행</button><small>현재 제목·메모와 저장된 수치를 발행합니다. 외부에 자동 전송되지 않습니다.</small></div>` : '<p>수치와 근거는 저장 당시 기준입니다. 다시 집계하면 초안 상태에서 최신 저장 자료를 검토하게 됩니다. 기존 발행본은 보존됩니다.</p>'}` : `<div class="mr-button-row"><a class="primary-button" href="/api/monthly-reports/${encodeURIComponent(report.id)}/pdf" download>PDF 다운로드</a><button class="secondary-button" type="button" data-mr-action="revise"${busy}>새 수정본 만들기</button></div><p>발행본은 수정할 수 없습니다. 새 수정본을 만들면 기존 발행본이 보존됩니다.</p>`}</div>${renderSnapshot(snapshot)}` : `<div class="mr-detail-empty"><span aria-hidden="true">▤</span><h3>한 달의 관측을 하나의 기록으로</h3><p>위에서 조건을 선택해 미리보기를 만들거나<br>왼쪽에서 저장한 리포트를 열어 보세요.</p><div class="mr-empty-legend"><span class="mr-public">● 공개 예약</span><span class="mr-phone">● 방막기 추정</span></div></div>`}</section></div></div>`;
    }
    async function loadList() { const data = await api(""); state.reports = Array.isArray(data) ? data : data.reports || []; }
    async function execute(label, operation) {
      if (state.busy) return false;
      state.busy = label; state.error = ""; state.message = ""; render();
      try { await operation(); return true; } catch (error) { state.error = String(error.message || "리포트를 처리하지 못했습니다."); return false; }
      finally { state.busy = ""; render(); }
    }
    async function open(context = {}) {
      await execute("저장된 리포트와 선택 항목을 불러오는 중입니다.", async () => {
        if (!state.options) {
          const data = await api("/options"); state.options = data;
          state.form.month = data.defaultMonth || data.months?.[0] || today().slice(0, 7);
        }
        if (context.type && Object.hasOwn(TYPES, context.type)) {
          state.form.type = context.type; state.form.targetId = context.targetId || ""; state.search = ""; invalidatePreview();
          state.report = null; state.title = ""; state.notes = "";
        }
        await loadList(); state.message = "조건을 선택해 미리보기를 만들 수 있습니다.";
      });
    }
    async function action(name, value) {
      if (state.busy) return;
      if (name === "filter") { state.filter = value; render(); return; }
      await execute("리포트를 처리하는 중입니다.", async () => {
        if (name === "refresh") { await loadList(); state.message = "목록을 새로고침했습니다."; return; }
        if (name === "open") { const data = await api(`/${encodeURIComponent(value)}`); setReport(data.report || data); state.message = "저장된 리포트를 열었습니다."; return; }
        if (name === "preview") {
          if (!state.form.month || !state.form.targetId) throw new Error("대상 월과 대상을 선택해 주세요.");
          const body = { ...state.form, cutoffDate: state.form.cutoffDate || defaultCutoff(state.form.month) };
          const data = await api("/preview", "POST", body);
          state.report = null; state.preview = data.snapshot || data; state.previewRequest = body; state.previewToken = data.previewToken || null;
          state.title = `${body.month} ${state.preview.target?.label || ""} 월간 리포트`; state.notes = ""; state.acknowledged = false;
          state.message = "미리보기를 만들었습니다. 수치와 자료 품질을 확인한 뒤 초안으로 저장하세요."; return;
        }
        if (name === "save") {
          if (!state.preview || !state.previewRequest) throw new Error("조건을 확인하고 미리보기를 먼저 만들어 주세요.");
          const data = await api("", "POST", { ...state.previewRequest, title: state.title, notes: state.notes, ...(state.previewToken ? { previewToken: state.previewToken } : {}) });
          setReport(data.report || data); state.message = "초안을 저장했습니다. 저장된 수치와 자료 품질을 확인해 주세요.";
        } else {
          const report = state.report;
          if (!report) throw new Error("저장된 리포트를 먼저 선택해 주세요.");
          const path = `/${encodeURIComponent(report.id)}`;
          let data;
          if (["update", "review", "draft"].includes(name)) {
            if (!["draft", "review"].includes(report.status)) throw new Error("발행된 리포트는 새 수정본에서 수정할 수 있습니다.");
            data = await api(path, "PATCH", { revision: report.revision, title: state.title, notes: state.notes, status: name === "review" ? "review" : name === "draft" ? "draft" : report.status });
          } else if (name === "rebuild") {
            if (!["draft", "review"].includes(report.status)) throw new Error("발행본은 새 수정본을 만든 뒤 다시 집계할 수 있습니다.");
            if (state.title !== report.title || state.notes !== (report.notes || "")) throw new Error("변경한 제목·메모를 먼저 저장한 뒤 다시 집계해 주세요.");
            data = await api(`${path}/rebuild`, "POST", { revision: report.revision });
          } else if (name === "publish") {
            if (!canPublish(report, state.acknowledged)) throw new Error("검토 단계에서 자료 품질을 확인한 뒤 발행할 수 있습니다.");
            if (state.title !== report.title || state.notes !== (report.notes || "")) throw new Error("변경한 제목·메모를 먼저 저장한 뒤 자료 품질을 다시 확인해 주세요.");
            data = await api(`${path}/publish`, "POST", { revision: report.revision, acknowledgeQuality: true });
          } else if (name === "revise") {
            if (report.status !== "published") throw new Error("발행본에서 새 수정본을 만들 수 있습니다.");
            data = await api(`${path}/revise`, "POST", { revision: report.revision });
          } else throw new Error("지원하지 않는 작업입니다.");
          setReport(data.report || data);
          state.message = name === "rebuild" ? "최신 저장 자료로 다시 집계했습니다. 초안의 수치와 품질을 다시 검토해 주세요." : name === "publish" ? "발행했습니다. PDF를 다운로드할 수 있습니다." : name === "revise" ? "기존 발행본을 보존하고 새 수정본을 만들었습니다." : name === "review" ? "검토 단계로 이동했습니다. 자료 품질을 확인해 주세요." : "변경 내용을 저장했습니다.";
        }
        await loadList();
      });
    }
    function input(name, value) {
      if (state.busy) return;
      if (name === "qualityAck") { state.acknowledged = Boolean(value); const button = container.querySelector('[data-mr-action="publish"]'); if (button) button.disabled = !canPublish(state.report, state.acknowledged); return; }
      if (name === "title" || name === "notes") { state[name] = value; return; }
      if (name === "targetSearch") { state.search = value; const select = container.querySelector('[name="targetId"]'); if (select) select.innerHTML = targetOptions(); return; }
      if (Object.hasOwn(state.form, name)) {
        state.form[name] = value; invalidatePreview();
        if (name === "type") { state.form.targetId = ""; state.search = ""; }
        if (name === "month") state.form.cutoffDate = "";
        render();
      }
    }
    container.addEventListener("submit", (event) => { if (event.target.matches("[data-mr-form]")) { event.preventDefault(); void action("preview"); } });
    container.addEventListener("click", (event) => { const button = event.target.closest("[data-mr-action]"); if (button && !button.disabled) void action(button.dataset.mrAction, button.dataset.reportId || button.dataset.filter); });
    container.addEventListener("change", (event) => { const target = event.target; if (["month", "type", "targetId", "cutoffDate", "qualityAck"].includes(target.name)) input(target.name, target.type === "checkbox" ? target.checked : target.value); });
    container.addEventListener("input", (event) => { if (["title", "notes", "targetSearch"].includes(event.target.name)) input(event.target.name, event.target.value); });
    render();
    return { open, action, input, state };
  }
  const api = { createController, renderSnapshot, renderList, escapeHtml, defaultCutoff, canPublish, show(container, context) { if (!container) return; let instance = instances.get(container); if (!instance) { instance = createController(container); instances.set(container, instance); } return instance.open(context); } };
  root.MonthlyReports = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window === "undefined" ? globalThis : window);
