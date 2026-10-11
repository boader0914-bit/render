(function (root) {
  "use strict";
  const ENDPOINT = "/api/industry-analysis";
  const TABS = [["overview", "업종 현황"], ["regions", "지역별 비교"], ["industries", "업종 간 비교"], ["companies", "관측 업체"]];
  const escapeHtml = value => String(value ?? "").replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character]));
  const number = value => value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value)) ? Number(value) : null;
  const count = value => number(value) === null ? "—" : Number(value).toLocaleString("ko-KR", { maximumFractionDigits: 1 });
  const percent = value => number(value) === null ? "—" : `${(Number(value) * 100).toLocaleString("ko-KR", { maximumFractionDigits: 1 })}%`;
  const money = value => number(value) === null ? "—" : `${Math.round(Number(value)).toLocaleString("ko-KR")}원`;
  const monthLabel = value => /^\d{4}-\d{2}$/.test(value || "") ? `${value.slice(0, 4)}년 ${Number(value.slice(5))}월` : "기간 확인 전";
  const dateLabel = value => {
    if (String(value || "").includes("T") && Number.isFinite(Date.parse(value))) return new Date(Date.parse(value) + 9 * 3600000).toISOString().slice(0, 10).replace(/-/g, ".");
    return String(value || "").slice(0, 10).replace(/-/g, ".");
  };
  const optionsHtml = (rows, value) => rows.map(row => `<option value="${escapeHtml(row.id)}"${row.id === value ? " selected" : ""}>${escapeHtml(row.label)}</option>`).join("");
  const hasObservations = summary => Number(summary?.coveredCompanyDays) > 0 || Number(summary?.observedCompanies) > 0;

  function empty(title, detail, retry = false) {
    return `<div class="ia-empty"><span class="ia-empty-mark" aria-hidden="true">◇</span><h3>${escapeHtml(title)}</h3><p>${escapeHtml(detail)}</p>${retry ? '<button type="button" data-ia-action="retry">다시 불러오기</button>' : ""}</div>`;
  }

  function metric(label, value, detail, className = "") {
    return `<section class="ia-metric ${className}"><span>${label}</span><strong>${value}</strong><small>${detail}</small></section>`;
  }

  function coverage(summary, period) {
    const known = number(summary.coverageRate) !== null;
    return `<section class="ia-coverage" aria-label="관측 범위"><div><span class="ia-kicker">관측 범위</span><strong>${count(summary.observedCompanies)}개 업체 <span>·</span> ${count(summary.coveredCompanyDays)} / ${count(summary.expectedCompanyDays)} 업체·숙박일</strong><p>자료가 확보된 업체·숙박일 기준입니다. 미관측일은 0으로 계산하지 않습니다.</p>${number(summary.sameDayObservedCompanyDays) === null ? "" : `<p>숙박일 당일 확인 ${count(summary.sameDayObservedCompanyDays)} / ${count(summary.coveredCompanyDays)} 업체·숙박일 · 이전에 확인한 관측값도 포함합니다.</p>`}</div><div class="ia-coverage-meter"><strong>${percent(summary.coverageRate)}</strong><div class="ia-meter"${known ? ` role="meter" aria-label="자료 확보율" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.min(100, Math.max(0, Number(summary.coverageRate) * 100))}"` : ""}><span style="width:${known ? Math.min(100, Math.max(0, Number(summary.coverageRate) * 100)) : 0}%"></span></div><small>${escapeHtml(dateLabel(period.start))} ~ ${escapeHtml(dateLabel(period.end))}</small></div></section>`;
  }

  function dailyChart(daily) {
    if (!daily.length) return empty("숙박일별 관측 자료가 없습니다", "자료가 확보된 숙박일의 공개예약과 타채널 추정을 나누어 표시합니다.");
    const width = Math.max(620, daily.length * 28), height = 190, baseline = 143, chartHeight = 113;
    const totals = daily.map(day => {
      const publicValue = number(day.publicBookings), otherValue = number(day.phoneBookings);
      return publicValue === null && otherValue === null ? null : (publicValue || 0) + (otherValue || 0);
    });
    const max = Math.max(1, ...totals.filter(value => value !== null));
    const step = (width - 66) / daily.length;
    const bars = daily.map((day, index) => {
      const x = 46 + step * index, barWidth = Math.min(15, step - 5), total = totals[index];
      const publicValue = number(day.publicBookings), otherValue = number(day.phoneBookings);
      const publicHeight = (publicValue || 0) / max * chartHeight, otherHeight = (otherValue || 0) / max * chartHeight;
      const title = `${day.date}: 공개예약 ${publicValue === null ? "자료 없음" : count(publicValue)} · 타채널 추정 ${otherValue === null ? "자료 없음" : count(otherValue)}`;
      const shape = total === null ? `<line class="ia-missing-mark" x1="${x}" x2="${x + barWidth}" y1="${baseline - 4}" y2="${baseline - 4}"/>` : total === 0 ? `<circle class="ia-zero" cx="${x + barWidth / 2}" cy="${baseline - 3}" r="3"/>` : `${publicValue !== null ? `<rect class="ia-bar-public" x="${x}" y="${baseline - publicHeight}" width="${barWidth}" height="${publicHeight}" rx="2"/>` : ""}${otherValue !== null ? `<rect class="ia-bar-other" x="${x}" y="${baseline - publicHeight - otherHeight}" width="${barWidth}" height="${otherHeight}" rx="2"/>` : ""}`;
      return `<g><title>${escapeHtml(title)}</title>${shape}${index % (daily.length > 16 ? 2 : 1) === 0 || index === daily.length - 1 ? `<text x="${x + barWidth / 2}" y="164" text-anchor="middle">${escapeHtml(String(day.date || "").slice(8, 10))}</text>` : ""}</g>`;
    }).join("");
    return `<div class="ia-chart-scroll"><svg class="ia-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="숙박일별 공개예약과 타채널 추정 객실 수. 점은 관측된 0, 회색 선은 미관측입니다."><text x="30" y="33" text-anchor="end">${count(max)}</text><text x="30" y="146" text-anchor="end">0</text><line class="ia-grid" x1="40" x2="${width - 10}" y1="30" y2="30"/><line class="ia-grid" x1="40" x2="${width - 10}" y1="${baseline}" y2="${baseline}"/>${bars}</svg></div>`;
  }

  function overview(data) {
    const summary = data.summary || {}, unit = escapeHtml(data.industry?.unitLabel || "객실");
    return `<div class="ia-metrics">${metric("추정예약률", percent(summary.reservationRate), `관측된 판매 가능 ${unit} 대비 예약 비중`)}${metric("예약 단위당 추정금액", money(summary.averageBookedPrice), `판매 단위: ${unit} · 공개예약과 타채널 추정 포함`)}${metric("보유 단위당 하루 추정매출", money(summary.revenuePerAvailableUnitDay), `판매 단위: ${unit} · 관측된 공급량 기준`)}</div><div class="ia-overview-grid"><section class="ia-card ia-trend"><div class="ia-section-head"><div><span class="ia-kicker">숙박일별 흐름</span><h3>예약은 언제 집중되는가</h3></div><span class="ia-unit">예약 ${unit} 수</span></div><div class="ia-legend"><span class="ia-public">공개예약</span><span class="ia-other">타채널 추정</span><span>● 관측된 0 · ━ 미관측</span></div>${dailyChart(data.daily || [])}<p class="ia-note">숙박일별 관측 업체 수가 다를 수 있습니다. 막대의 합은 해당 숙박일의 관측분입니다.</p></section><section class="ia-card ia-source"><span class="ia-kicker">매출 구성</span><h3>관측 추정매출 소계</h3><strong class="ia-total">${money(summary.estimatedRevenue)}</strong><div class="ia-source-row"><span class="ia-public">공개예약</span><strong>${money(summary.publicRevenue)}</strong></div><div class="ia-source-row"><span class="ia-other">타채널 추정</span><strong>${money(summary.phoneRevenue)}</strong></div><p class="ia-note">금액은 확보된 업체·숙박일의 소계입니다. 타채널 추정은 잔여 수량의 변화 등을 바탕으로 하며 실제 정산 매출과 다를 수 있습니다.</p></section></div>`;
  }

  function regionalContext(data) {
    const sources = data.context?.sources || [];
    if (data.request?.region === "all") return `<p class="ia-context-hint">지역을 선택하면 저장된 방문·체류·소비 지표를 함께 볼 수 있습니다. 남해안 사천도 지표 지역에 포함합니다.</p>`;
    if (!sources.length) return `<section class="ia-card"><div class="ia-section-head"><h3>지역 배경 지표</h3><span class="ia-tag">저장 지표 없음</span></div><p class="ia-note">선택 지역의 방문·체류·소비 지표가 아직 확보되지 않았습니다. 지역을 선택한 것만으로 새로운 수집이 시작되지는 않습니다.</p></section>`;
    return `<section class="ia-card"><div class="ia-section-head"><div><span class="ia-kicker">지역 배경 지표</span><h3>숙박 흐름을 이해하는 참고 자료</h3></div><span class="ia-tag">저장된 공표기간 기준</span></div><div class="ia-context-grid">${sources.map(source => {
      const rows = source.rows || [], available = rows.some(row => number(row.value) !== null);
      const metrics = rows.map(row => `<div class="ia-context-row"><span>${escapeHtml(row.label)}</span><strong>${count(row.value)}${number(row.value) === null ? "" : `<small>${escapeHtml(row.unit)}</small>`}</strong></div>`).join("");
      const url = /^https?:\/\//i.test(source.sourceUrl || "") ? source.sourceUrl : "";
      return `<details class="ia-context-source"${available ? " open" : ""}><summary><span>${escapeHtml(source.label)}</span><b>${available ? "저장 지표" : "자료 없음"}</b></summary><p>${escapeHtml(source.provider || "출처 확인 전")} · 기준 ${escapeHtml(source.period || "기간 확인 전")}${source.referenceOnly ? " · 참고 통계" : ""}</p>${metrics || '<p>저장된 지표가 없습니다.</p>'}${url ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">출처 확인 ↗</a>` : ""}</details>`;
    }).join("")}</div><p class="ia-note">지표별 공표기간이 다를 수 있습니다. 지역 통계를 숙박업의 실적이나 원인으로 단정하지 않습니다.</p></section>`;
  }

  function comparisonStatus(row) {
    if (!hasObservations(row)) return "자료 없음";
    if (row.comparisonStatus === "insufficient") return "비교 자료 부족";
    return number(row.coverageRate) === null || Number(row.coverageRate) < 1 ? "부분 관측" : "관측 확보";
  }

  function comparisonTable(rows, type) {
    if (!rows.length) return empty("비교할 자료가 없습니다", "같은 기간의 관측 자료가 확보되면 비교 결과를 표시합니다.");
    const max = Math.max(1, ...rows.map(row => number(row.reservationRate) || 0));
    return `<div class="ia-table-scroll"><table><caption>${type === "regions" ? "실제 주소지 기준 지역별 관측 결과" : "공통 지역과 숙박일 기준 업종별 관측 결과"}</caption><thead><tr><th scope="col">${type === "regions" ? "지역" : "업종"}</th><th scope="col">관측 업체</th><th scope="col">추정예약률</th><th scope="col">예약 단위당 금액</th><th scope="col">보유 단위당 하루 매출</th><th scope="col">자료 확보율</th><th scope="col">관측 상태</th></tr></thead><tbody>${rows.map(row => `<tr><th scope="row">${type === "regions" ? `<button class="ia-text-button" type="button" data-ia-region="${escapeHtml(row.id)}">${escapeHtml(row.label)}</button>` : `${escapeHtml(row.label)}${row.unitLabel ? `<small>판매 단위: ${escapeHtml(row.unitLabel)}</small>` : ""}`}</th><td>${count(row.observedCompanies)} / ${count(row.companyCount)}</td><td><div class="ia-rate-cell"><strong>${percent(row.reservationRate)}</strong>${number(row.reservationRate) === null ? "" : `<span class="ia-rate-track"><i style="width:${Math.max(0, Math.min(100, Number(row.reservationRate) / max * 100))}%"></i></span>`}</div></td><td>${money(row.averageBookedPrice)}</td><td>${money(row.revenuePerAvailableUnitDay)}</td><td>${percent(row.coverageRate)}</td><td><span class="ia-row-state">${comparisonStatus(row)}</span></td></tr>`).join("")}</tbody></table></div>`;
  }

  function comparisons(data, type) {
    const group = data.industryComparison || {};
    if (type === "industries" && group.status !== "ready") return `<section class="ia-card"><div class="ia-section-head"><h3>같은 조건에서 업종 비교</h3><span class="ia-tag">비교 자료 부족</span></div>${empty("공통 관측 조건을 확보하고 있습니다", "업종별로 같은 지역과 숙박일의 자료가 있어야 비교할 수 있습니다. 업종 현황과 관측 업체에서 현재 자료를 확인하세요.")}<p class="ia-note">${escapeHtml(group.basis || "지역 구성과 관측기간이 다른 평균을 업종 차이로 해석하지 않습니다.")}</p></section>`;
    return `<section class="ia-card"><div class="ia-section-head"><div><span class="ia-kicker">${type === "regions" ? "같은 업종 · 같은 선택 월" : "공통 지역 · 공통 숙박일"}</span><h3>${type === "regions" ? "지역별 관측 현황" : "업종별 운영 흐름"}</h3></div>${type === "industries" ? `<span class="ia-tag">${count(group.commonRegionIds?.length)}개 공통 지역 · ${count(group.commonDates?.length)}일</span>` : ""}</div><p class="ia-note">${type === "regions" ? "지역을 누르면 해당 지역으로 좁혀 볼 수 있습니다. 관측기간과 확보율이 다르면 직접적인 성과 비교가 어렵습니다." : escapeHtml(group.basis || "업종마다 판매 단위가 다르므로 단위당 매출을 수익성 순위로 해석하지 않습니다.")}</p>${type === "industries" ? `<p class="ia-note">업종마다 판매 단위가 달라 수익성 순위로 해석하지 않습니다.</p>` : ""}${comparisonTable(type === "regions" ? data.regions || [] : group.rows || [], type)}</section>`;
  }

  function companyTable(data) {
    const rows = data.companies || [];
    if (!rows.length) return empty("조건에 맞는 관측 업체가 없습니다", "선택 지역·기간의 네이버 플레이스 1~20위 저장 자료가 필요합니다.");
    return `<section class="ia-card"><div class="ia-section-head"><h3>지표에 포함된 업체</h3><span class="ia-tag">${count(rows.length)}개 업체</span></div><p class="ia-note">객실·사이트 수는 DB 검수값 또는 고정 관측값입니다. 여러 검색어에 나타나는 업체는 중복을 제거합니다.</p><div class="ia-table-scroll"><table><caption>업체별 검색 순위 근거와 관측 범위</caption><thead><tr><th scope="col">업체</th><th scope="col">지역</th><th scope="col">검색 순위 근거</th><th scope="col">객실·사이트 수</th><th scope="col">자료 확보율</th><th scope="col">추정예약률</th><th scope="col">관측 매출</th></tr></thead><tbody>${rows.map(row => {
      const evidence = row.rankEvidence || [], first = evidence[0];
      const basis = row.capacityBasis || {}, sourceKey = basis.source || row.capacitySource;
      const source = (typeof basis.label === "string" ? basis.label : "") || { manual: "관리자 검수값", verified: "관리자 검수값", db_review: "관리자 검수값", observed_max: "최대 관측값 · 미검수", observed_locked: "최대 관측값 고정 · 미검수", observed_max_locked: "최대 관측값 고정 · 미검수", unverified: "미검수", unknown: "객실 기준 확인 필요" }[sourceKey]
        || (/[가-힣]/.test(row.capacitySource || "") ? row.capacitySource : "객실 기준 확인 필요");
      const basisWarnings = (Array.isArray(basis.warnings) ? basis.warnings : []).filter(value => typeof value === "string");
      return `<tr><th scope="row">${escapeHtml(row.primaryName || row.companyId)}${first?.runId ? `<button type="button" class="ia-text-button ia-open-source" data-industry-open-run="${escapeHtml(first.runId)}">저장 분석 열기 ↗</button>` : ""}</th><td>${escapeHtml(row.regionLabel || "지역 확인 전")}</td><td>${evidence.length ? evidence.slice(0, 3).map(item => `<span class="ia-evidence">${escapeHtml(item.keyword)} <b>${count(item.rank)}위</b></span>`).join("") : "순위 확인 전"}${first?.collectedAt ? `<small>${escapeHtml(dateLabel(first.collectedAt))} 수집</small>` : ""}</td><td>${count(row.capacity)}<small>${escapeHtml(source)}</small>${basisWarnings.map(warning => `<small class="ia-capacity-warning">${escapeHtml(warning)}</small>`).join("")}</td><td>${percent(row.coverageRate)}<small>${count(row.coveredCompanyDays)} / ${count(row.expectedCompanyDays)}일</small></td><td>${percent(row.reservationRate)}</td><td>${money(row.estimatedRevenue)}</td></tr>`;
    }).join("")}</tbody></table></div></section>`;
  }

  function renderDashboard(state) {
    const catalog = state.catalog || {}, data = state.data, selection = state.selection;
    const industries = catalog.industries || [], regions = catalog.regions || [], months = catalog.months || [];
    const industryName = industries.find(row => row.id === selection.industry)?.label || "업종";
    const selectedRegion = regions.find(row => row.id === selection.region)?.label || "전체 관측 지역";
    let body;
    if (state.loading) body = `<div class="ia-loading" role="status"><span></span><strong>관측 자료를 불러오는 중입니다</strong><p>선택한 업종·지역·숙박월을 확인하고 있습니다.</p></div>`;
    else if (state.error) body = `<div role="alert">${empty("자료를 불러오지 못했습니다", state.error, true)}</div>`;
    else if (data && state.tab === "companies") body = `${coverage(data.summary || {}, data.period || {})}${companyTable(data)}`;
    else if (data && state.tab === "industries") body = comparisons(data, "industries");
    else if (!data || !hasObservations(data.summary)) body = empty("아직 분석할 관측 자료가 없습니다", "저장된 네이버 플레이스 1~20위 자료 중 선택한 숙박월과 지역에 해당하는 자료가 없습니다. 다른 조건을 선택하거나 아래 저장 자료를 확인하세요.");
    else body = `${coverage(data.summary || {}, data.period || {})}${state.tab === "overview" ? overview(data) : state.tab === "companies" ? companyTable(data) : comparisons(data, state.tab)}`;
    if (!state.loading && !state.error && data && !hasObservations(data.summary) && state.tab === "regions") body += comparisons(data, "regions");
    if (!state.loading && !state.error && data && state.tab === "overview") body += regionalContext(data);
    const warnings = [...(data?.quality?.warnings || []), ...(data?.context?.warnings || [])].filter(item => typeof item === "string");
    const candidateLabels = regions.filter(row => row.indicatorCandidate).map(row => row.label);
    const metricDefinitions = [["reservationRate", "추정예약률"], ["averageBookedPrice", "예약 단위당 추정금액"], ["revenuePerAvailableUnitDay", "보유 단위당 하루 추정매출"], ["cohort", "순위 표본"]].filter(([key]) => data?.definitions?.[key]).map(([key, label]) => `<p><b>${label}:</b> ${escapeHtml(data.definitions[key])}</p>`).join("");
    return `<div class="industry-analysis"><header class="ia-header"><div><span class="ia-kicker">INDUSTRY OBSERVATORY</span><h2>업종별 숙박 흐름</h2><p>지역의 차이부터 예약의 흐름까지, 저장된 관측 자료로 살펴보세요.</p></div><span class="ia-cohort">네이버 플레이스 <strong>1~20위</strong></span></header><form class="ia-filters" aria-label="업종분석 조건"><label>업종<select data-ia-filter="industry">${optionsHtml(industries, selection.industry)}</select></label><label>숙박월<select data-ia-filter="month">${months.length ? optionsHtml(months.map(id => ({ id, label: monthLabel(id) })), selection.month) : '<option value="">저장된 기간 없음</option>'}</select></label><label>지역<select data-ia-filter="region">${optionsHtml([{ id: "all", label: "전체 관측 지역" }, ...regions.filter(row => row.id !== "all")], selection.region)}</select></label><button type="button" class="ia-refresh" data-ia-action="retry" aria-label="저장 자료 다시 조회">새로고침 <span aria-hidden="true">↻</span></button></form><div class="ia-scope"><span><b>${escapeHtml(industryName)}</b> · ${escapeHtml(selectedRegion)} · ${escapeHtml(monthLabel(selection.month))}</span><span>기간 중 1~20위 관측 업체 · 전체 시장 대표 아님</span></div><nav class="ia-tabs" aria-label="업종분석 보기">${TABS.map(([id, label]) => `<button type="button" data-ia-tab="${id}" aria-pressed="${state.tab === id}">${label}</button>`).join("")}</nav><div class="ia-content" aria-busy="${Boolean(state.loading)}">${body}</div>${warnings.length ? `<details class="ia-disclosure"><summary>자료 해석 시 확인할 점 <span>${warnings.length}건</span></summary><ul>${warnings.map(item => `<li>${escapeHtml(item)}</li>`).join("")}</ul></details>` : ""}<details class="ia-disclosure"><summary>지표 기준과 수집 구상</summary><div class="ia-method">${metricDefinitions}<p><b>대상:</b> 검색 시점의 네이버 플레이스 1~20위 업체. 여러 검색어의 동일 업체는 중복을 제거합니다.</p><p><b>지역:</b> 업체의 실제 주소지를 사용합니다. 복합시설은 해당하는 각 업종에 포함될 수 있습니다.</p><p><b>결측:</b> 미관측 값은 ‘—’로 표시합니다. 공개예약은 초록색, 타채널 추정은 보라색입니다.</p><p><b>규모와 성과등급:</b> 현재 구분을 보류합니다. 규모구간은 추후 업종별로 정의합니다.</p>${candidateLabels.length ? `<p><b>지역 지표 후보:</b> ${escapeHtml(candidateLabels.join(" · "))}. 후보 등록은 자료 확보를 뜻하지 않습니다.</p>` : ""}<p>정기수집 구성은 계획으로 보관하며, 이 화면은 저장 자료만 조회합니다.</p></div></details>${state.legacyHtml ? `<details class="ia-disclosure ia-legacy"${state.legacyOpen ? " open" : ""}><summary>기존 키워드별 저장 분석 열기</summary><div class="ia-legacy-content">${state.legacyHtml}</div></details>` : ""}</div>`;
  }

  async function requestJson(url) {
    const response = await root.fetch(url, { credentials: "same-origin", headers: { Accept: "application/json" } });
    const body = await response.json();
    if (!response.ok || body?.error) throw new Error(typeof body?.error === "string" ? body.error : body?.error?.message || `자료 조회 실패 (${response.status})`);
    return body;
  }

  function createController({ request = requestJson, isAuthorized = () => true } = {}) {
    const state = { catalog: null, data: null, selection: { industry: "glamping", month: "", region: "all" }, tab: "overview", loading: false, error: "", legacyHtml: "", legacyOpen: false };
    let container, revision = 0, destroyed = false;
    const authorized = () => !destroyed && isAuthorized();
    function render() { if (container && authorized()) container.innerHTML = renderDashboard(state); }
    async function loadData() {
      const token = ++revision;
      state.data = null; state.error = "";
      if (!state.selection.month) { state.loading = false; render(); return; }
      state.loading = true; render();
      try {
        const query = new URLSearchParams(state.selection);
        const result = await request(`${ENDPOINT}?${query}`);
        if (token !== revision || !authorized()) return;
        state.data = result;
      } catch (error) {
        if (token === revision && authorized()) state.error = error.message || "잠시 후 다시 시도해 주세요.";
      } finally { if (token === revision && authorized()) { state.loading = false; render(); } }
    }
    async function loadCatalog() {
      const token = ++revision;
      state.loading = true; state.error = ""; state.data = null; render();
      try {
        const result = await request(`${ENDPOINT}/options`);
        if (token !== revision || !authorized()) return;
        state.catalog = result;
        if (!(result.industries || []).some(row => row.id === state.selection.industry)) state.selection.industry = result.defaultIndustry || result.industries?.[0]?.id || "glamping";
        if (!(result.months || []).includes(state.selection.month)) state.selection.month = (result.months || []).includes(result.defaultMonth) ? result.defaultMonth : result.months?.[0] || "";
        if (state.selection.region !== "all" && !(result.regions || []).some(row => row.id === state.selection.region)) state.selection.region = "all";
        await loadData();
      } catch (error) {
        if (token === revision && authorized()) { state.error = error.message || "조건 목록을 불러오지 못했습니다."; state.loading = false; render(); }
      }
    }
    function input(field, value) {
      if (!["industry", "month", "region"].includes(field) || !authorized()) return Promise.resolve();
      state.selection[field] = String(value || "");
      return loadData();
    }
    function selectTab(value) { if (TABS.some(([id]) => id === value)) { state.tab = value; render(); } }
    function click(event) {
      const action = event.target.closest?.("[data-ia-action],[data-ia-tab],[data-ia-region]");
      if (!action || !authorized()) return;
      if (action.dataset.iaAction === "retry") void loadCatalog();
      if (action.dataset.iaTab) { selectTab(action.dataset.iaTab); container.querySelector?.(`[data-ia-tab="${state.tab}"]`)?.focus({ preventScroll: true }); }
      if (action.dataset.iaRegion) { state.tab = "overview"; void input("region", action.dataset.iaRegion); }
    }
    function change(event) { const field = event.target.dataset?.iaFilter; if (field) void input(field, event.target.value); }
    function toggle(event) { if (event.target.matches?.(".ia-legacy")) state.legacyOpen = event.target.open; }
    function submit(event) { if (event.target.matches?.(".ia-filters")) event.preventDefault(); }
    function destroy() { destroyed = true; revision++; if (container) { container.removeEventListener("click", click); container.removeEventListener("change", change); container.removeEventListener("toggle", toggle, true); container.removeEventListener("submit", submit); } }
    function mount(element, context = {}) {
      const first = !container;
      container = element; state.legacyHtml = context.legacyHtml || "";
      if (first) { container.addEventListener("click", click); container.addEventListener("change", change); container.addEventListener("toggle", toggle, true); container.addEventListener("submit", submit); }
      render(); return first ? loadCatalog() : Promise.resolve();
    }
    return { state, mount, input, selectTab, loadData, loadCatalog, render, destroy };
  }

  const mounted = new WeakMap();
  const exported = { createController, renderDashboard, dailyChart, percent, money, count,
    mount(element, context = {}) {
      let record = mounted.get(element);
      if (record && record.accountKey !== context.accountKey) { record.controller.destroy(); record = null; }
      if (!record) { record = { accountKey: context.accountKey, controller: createController({ isAuthorized: context.isAuthorized }) }; mounted.set(element, record); }
      return record.controller.mount(element, context);
    },
    unmount(element) { mounted.get(element)?.controller.destroy(); mounted.delete(element); }
  };
  root.StayIndustryAnalysis = exported;
  if (typeof module !== "undefined" && module.exports) module.exports = exported;
})(typeof window !== "undefined" ? window : globalThis);
