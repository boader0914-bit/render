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
  const monthLabel = (month) => /^\d{4}-\d{2}$/.test(month || "") ? `${Number(month.slice(0, 4))}년 ${Number(month.slice(5))}월` : String(month || "대상 월 미확인");
  const reportTitle = (request = {}, target = {}) => `${monthLabel(request.month)} ${target.label || request.targetId || ""} ${request.type === "keyword" ? "검색시장 리포트" : "월간 리포트"}`;
  const signed = (value, suffix = "") => value == null || !Number.isFinite(Number(value)) ? "비교 불가" : `${Number(value) > 0 ? "+" : ""}${number(value)}${suffix}`;
  const warningList = (warnings) => Array.isArray(warnings) && warnings.length ? `<ul class="mr-insight-warnings">${warnings.map((warning) => `<li>${escapeHtml(textValue(warning))}</li>`).join("")}</ul>` : "";
  const sectionHeading = (label, description) => `<div class="mr-report-section-heading"><h3>${escapeHtml(label)}</h3>${description ? `<p>${escapeHtml(description)}</p>` : ""}</div>`;
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
  function renderContext(context = {}, geography = {}) {
    const sources = Array.isArray(context.sources) ? context.sources : [];
    const warnings = Array.isArray(context.warnings) ? context.warnings : [];
    const geographyRows = Array.isArray(geography.rows) ? geography.rows : [];
    return `<details class="mr-fold mr-report-section" data-mr-section="context"><summary>지역 배경 <span>출처별 기준기간</span></summary><div class="mr-fold-content"><p>저장된 지역·공공 자료를 출처별 기준기간과 함께 확인합니다. 업체 예약 추정치와 별도인 참고 자료입니다.</p>${geographyRows.length ? insightTable("관측 업체의 지역 구성 · 행정구역 전체 시장 점유율이 아님", ["지역", "관측 업체", "숙박 관측 충족률", "숙박 추정 매출", "데이유즈 추정 매출"], geographyRows.map((row) => `<tr><th scope="row">${escapeHtml(row.regionLabel || row.regionKey || "지역 미확인")}</th><td>${count(row.companyCount, "곳")}</td><td>${percent(row.lodging?.coverageRate)}</td><td>${won(row.lodging?.estimatedRevenue)}</td><td>${won(row.dayuse?.estimatedRevenue)}</td></tr>`)) : ""}${warningList(warnings)}${!sources.length ? '<p class="mr-empty">이 리포트에 연결할 수 있는 저장된 지역·공공 자료가 없습니다.</p>' : ""}${sources.map((source) => `<section class="mr-context-source"><h4>${escapeHtml(source.label || "참고 자료")}${source.referenceOnly ? " · 참고용" : ""}</h4><p>${escapeHtml([source.provider, source.regionLabel, source.period].filter(Boolean).join(" · "))}</p><p>저장 시각 ${escapeHtml(timeLabel(source.retrievedAt))}${source.sourceUpdatedAt ? ` · 원자료 갱신 ${escapeHtml(timeLabel(source.sourceUpdatedAt))}` : ""} (한국시간)</p>${source.rows?.length ? `<dl>${source.rows.map((row) => `<div><dt>${escapeHtml(row.label || "지표")}</dt><dd>${row.value == null ? "확인 불가" : `${escapeHtml(typeof row.value === "number" ? number(row.value) : row.value)} ${escapeHtml(row.unit || "")}`}</dd></div>`).join("")}</dl>` : '<p>해당 기준기간에 사용할 수 있는 저장 자료가 없습니다.</p>'}${/^https?:\/\//i.test(source.sourceUrl || "") ? `<a href="${escapeHtml(source.sourceUrl)}" target="_blank" rel="noopener noreferrer">출처 보기</a>` : ""}</section>`).join("")}</div></details>`;
  }
  function dailyTable(rows = [], caption = "날짜별 숙박 자료") {
    if (!rows.length) return '<p class="mr-empty">날짜별 자료가 없습니다.</p>';
    return `<div class="mr-table-scroll" tabindex="0" role="region" aria-label="${escapeHtml(caption)}"><table><caption>${escapeHtml(caption)}</caption><thead><tr><th scope="col">숙박일</th><th scope="col">공급 (실)</th><th scope="col">예약 추정 (실)</th><th scope="col" class="mr-public">공개 예약 (실)</th><th scope="col" class="mr-phone">방막기 추정 (실)</th><th scope="col">숙박 추정 매출</th><th scope="col">데이유즈 추정 매출</th><th scope="col">충족률</th></tr></thead><tbody>${rows.map((row) => `<tr><th scope="row">${escapeHtml(row.date)}</th><td>${number(row.lodging?.supply)}</td><td>${number(row.lodging?.sold)}</td><td class="mr-public">${number(row.lodging?.publicBookings)}</td><td class="mr-phone">${number(row.lodging?.phoneBookings)}</td><td>${won(row.lodging?.estimatedRevenue)}</td><td>${won(row.dayuse?.estimatedRevenue)}</td><td>${percent(row.lodging?.coverageRate)}</td></tr>`).join("")}</tbody></table></div>`;
  }
  function insightTable(caption, headers, rows) {
    return `<div class="mr-table-scroll" tabindex="0" role="region" aria-label="${escapeHtml(caption)}"><table><caption>${escapeHtml(caption)}</caption><thead><tr>${headers.map((header) => `<th scope="col">${escapeHtml(header)}</th>`).join("")}</tr></thead><tbody>${rows.join("")}</tbody></table></div>`;
  }
  function comparisonTotals(label, comparison = {}) {
    const rows = [["이전 월", comparison.previous], ["대상 월", comparison.current]].map(([period, value]) => {
      value = value || {};
      return `<tr><th scope="row">${period}</th><td>${number(value.companyCount)}</td><td>${number(value.coveredCompanyDays)} / ${number(value.expectedCompanyDays)}</td><td>${number(value.sold)}</td><td class="mr-public">${number(value.publicBookings)}</td><td class="mr-phone">${number(value.phoneBookings)}</td><td>${won(value.estimatedRevenue)}</td><td>${percent(value.reservationRate)}</td></tr>`;
    });
    return insightTable(label, ["기준", "업체 수", "관측 업체·숙박일", "예약 추정 (실·박)", "공개 예약 (실·박)", "방막기 추정 (실·박)", "숙박 추정 매출", "관측 예약 추정률"], rows);
  }
  function renderComparison(comparison = {}) {
    const matched = comparison.common?.matched || {};
    const deltas = matched.deltas || {};
    const hasPairs = Number(matched.companyDays) > 0;
    return `<details class="mr-fold mr-report-section" data-mr-section="comparison"><summary>공통 업체 비교 <span>${escapeHtml(comparison.previousMonth ? `${monthLabel(comparison.previousMonth)} 대비` : "이전 월 자료 확인")}</span></summary><div class="mr-fold-content">
      <p>숙박 자료를 비교합니다. 전체 관측 합계는 표본 구성이 달라질 수 있어 증감률로 해석하지 않습니다.</p>
      ${comparison.status ? `<dl class="mr-insight-stats"><div><dt>공통 관측 업체</dt><dd>${count(comparison.common?.companyCount, "곳")}</dd></div><div><dt>동일 조건 비교 자료</dt><dd>${number(matched.companyDays)} 업체·숙박일</dd></div><div><dt>이번 달 새로 관측</dt><dd>${count(Array.isArray(comparison.newlyObservedCompanyIds) ? comparison.newlyObservedCompanyIds.length : null, "곳")}</dd></div><div><dt>이번 달 관측되지 않음</dt><dd>${count(Array.isArray(comparison.noLongerObservedCompanyIds) ? comparison.noLongerObservedCompanyIds.length : null, "곳")}</dd></div></dl>` : ""}
      ${hasPairs ? `<div class="mr-comparison-result"><h4>동일 조건으로 비교한 변화</h4><p>같은 업체·월중 날짜·공급량·관측 선행일이 일치하는 ${number(matched.companyDays)}개 업체·숙박일만 비교합니다.</p><dl class="mr-insight-stats"><div><dt>예약 추정 변화</dt><dd>${signed(deltas.sold, "실·박")}</dd></div><div><dt>숙박 추정 매출 변화</dt><dd>${signed(deltas.estimatedRevenue, "원")}</dd></div><div><dt>관측 예약 추정률 변화</dt><dd>${signed(deltas.reservationRatePoints, "%p")}</dd></div><div><dt>숙박 추정 매출 증감률</dt><dd>${deltas.estimatedRevenueRate == null ? "비교 불가" : signed(Number(deltas.estimatedRevenueRate) * 100, "%")}</dd></div></dl>${comparisonTotals("동일 조건 비교 근거", matched)}</div>` : '<p class="mr-empty">동일 조건으로 비교할 이전 월 자료가 부족합니다. 증감을 계산하지 않습니다.</p>'}
      ${warningList(comparison.warnings)}
      <p class="mr-method-note">새로 관측되거나 관측되지 않은 업체 수는 개업·폐업을 뜻하지 않습니다. 비교 날짜의 요일이 다를 수 있으며, 관측 표본은 시장 전체 조사가 아닙니다.</p>
      ${comparison.all ? `<details class="mr-inner-fold"><summary>전체·공통 업체 관측 소계 확인</summary>${comparisonTotals("전체 관측 업체 소계 · 월별 표본이 다를 수 있음", comparison.all)}${comparisonTotals("공통 업체 소계 · 관측일과 조건이 다를 수 있음", comparison.common)}</details>` : ""}
      ${comparison.previousSources ? `<details class="mr-inner-fold"><summary>고정된 전월 비교 출처</summary><p>전월 관측 마감일 ${escapeHtml(comparison.previousCutoffDate || "확인 불가")} · 자료 충족률 ${percent(comparison.previousQuality?.coverageRate)}. 이 리포트와 함께 저장한 비교 근거입니다.</p><ul class="mr-source-list">${(comparison.previousSources.runs || []).map((run) => `<li><strong>${escapeHtml(run.keyword || run.id || run.runId)}</strong><span>${escapeHtml(timeLabel(run.collectedAt))} (한국시간) · ${escapeHtml(run.id || run.runId)}</span></li>`).join("")}</ul><p class="mr-source-ids">수집 기록: ${escapeHtml((comparison.previousSources.runIds || []).join(", ") || "없음")}</p></details>` : ""}
    </div></details>`;
  }
  function renderRanks(snapshot = {}) {
    const rows = Array.isArray(snapshot.ranks?.rows) ? snapshot.ranks.rows : [];
    const visibility = Array.isArray(snapshot.insights?.rankVisibility?.rows) ? snapshot.insights.rankVisibility.rows : [];
    return `<details class="mr-fold mr-report-section" data-mr-section="ranks"><summary>순위 변화 <span>선택 월에 수집한 검색 순위</span></summary><div class="mr-fold-content"><p>순위는 ${escapeHtml(monthLabel(snapshot.request?.month))}의 관측일 기준입니다. 숙박일 기준 예약·매출과 시간 기준이 다릅니다. 저장된 키워드와 실제 관측일 안에서만 비교합니다.</p>
      ${rows.length ? insightTable("키워드별 첫·마지막 노출 순위", ["업체", "키워드", "처음", "마지막", "순위 개선", "관측 횟수", "첫 관측", "마지막 관측"], rows.map((row) => `<tr><th scope="row">${escapeHtml(row.companyName || row.companyId)}</th><td>${escapeHtml(row.keyword)}</td><td>${number(row.firstRank)}</td><td>${number(row.lastRank)}</td><td>${signed(row.rankImprovement, "계단")}</td><td>${number(row.observations)}</td><td>${escapeHtml(timeLabel(row.firstCollectedAt))}</td><td>${escapeHtml(timeLabel(row.lastCollectedAt))}</td></tr>`)) : '<p class="mr-empty">해당 관측월에 저장된 노출 순위 자료가 없습니다.</p>'}
      ${visibility.length ? insightTable("관측일 기준 노출 범위 · 관측되지 않은 날은 분모에서 제외", ["업체", "키워드", "관측일", "평균 순위", "최고 / 최저", "3위 이내 관측 비중", "10위 이내 관측 비중"], visibility.map((row) => `<tr><th scope="row">${escapeHtml(row.companyName || row.companyId)}</th><td>${escapeHtml(row.keyword)}</td><td>${count(row.observedDays, "일")}</td><td>${number(row.meanRank)}</td><td>${number(row.bestRank)} / ${number(row.worstRank)}</td><td>${percent(row.top3ObservedShare)}</td><td>${percent(row.top10ObservedShare)}</td></tr>`)) : ""}
    </div></details>`;
  }
  function pickupChannel(label, item = {}, channelClass = "", unit = "실·박") {
    const lead = item.leadTime || {};
    const ready = item.status === "ready";
    return `<section class="mr-pickup-card ${channelClass}"><h4>${escapeHtml(label)}</h4>${item.status ? `<dl class="mr-inline-metrics"><div><dt>관측 증가</dt><dd>${count(item.increase, unit)}</dd></div><div><dt>관측 감소</dt><dd>${count(item.decrease, unit)}</dd></div><div><dt>순변화</dt><dd>${signed(item.net, unit)}</dd></div></dl>` : ""}<p>${ready ? `증가 관측 기준 평균 ${number(lead.averageDays)}일 전 · 중간값 ${number(lead.medianDays)}일 전` : item.status === "no_increase" ? "비교 가능한 관측에서 수량 증가가 확인되지 않았습니다." : "같은 숙박일의 반복 관측이 부족해 예약 시점을 추정할 수 없습니다."}</p>${ready && lead.averageMinDays != null ? `<p>수집 간격을 고려한 평균 범위 ${number(lead.averageMinDays)}~${number(lead.averageMaxDays)}일 전</p>` : ""}${ready && Array.isArray(lead.bins) && lead.bins.length ? `<div class="mr-pickup-bins">${lead.bins.map((bin) => `<span>${escapeHtml(bin.label)} <strong>${count(bin.pickup, unit)}</strong> · ${percent(bin.share)}</span>`).join("")}</div><p>구간은 증가를 확인한 관측일 기준입니다.${Number(lead.intervalCrossingPickup) > 0 ? ` 수집 간격이 구간 경계를 넘은 수량 ${count(lead.intervalCrossingPickup, unit)}는 실제 예약 구간을 특정할 수 없습니다.` : ""}</p>` : ""}</section>`;
  }
  function pickupEvidence(pickup, unit) {
    if (!pickup) return "";
    const rejected = Object.values(pickup.rejectedByReason || {}).reduce((sum, value) => sum + (Number(value) || 0), 0);
    return `<p class="mr-method-note">최초 관측에 이미 있던 수량과 마지막 관측 이후 변화는 예약 시점 분석에 포함하지 않습니다.${pickup.baselinePublicBookings != null ? ` 최초 관측 공개 예약 ${count(pickup.baselinePublicBookings, unit)} · 방막기 추정 ${count(pickup.baselineBlockedBookings, unit)}.` : ""}${rejected ? ` 공급·공유 등 기준이 달라 제외한 ${number(rejected)}구간.` : ""}${Number(pickup.offsettingChannelChangeIntervals) > 0 ? ` 공개 예약·방막기 변화가 상쇄된 ${number(pickup.offsettingChannelChangeIntervals)}구간은 채널 분류 변화일 수 있습니다.` : ""}${pickup.includesPartialRuns ? " 일부 수집 회차의 유효 관측을 포함합니다." : ""}</p>`;
  }
  function renderTiming(snapshot = {}) {
    const insights = snapshot.insights || {};
    const parts = [["lodging", "숙박", "실·박"], ["dayuse", "데이유즈", "회"]];
    return `<details class="mr-fold mr-report-section" data-mr-section="timing"><summary>예약 시점 <span>반복 관측과 숙박일 전 시점</span></summary><div class="mr-fold-content"><p>예약이 실제 접수된 날짜가 아니라, 같은 숙박일의 수량 변화를 수집한 시점입니다. 공개 예약과 방막기 추정을 분리합니다. 감소는 취소 확정 건수가 아닙니다.</p>
      ${parts.map(([key, label, unit]) => {
        const pickup = insights.pickup?.[key];
        const pace = Array.isArray(insights.pace?.[key]) ? insights.pace[key] : [];
        if (!pickup && !pace.length && key === "dayuse") return "";
        return `<section class="mr-insight-product"><h4>${label}</h4><div class="mr-pickup-grid">${pickupChannel("공개 예약", pickup?.public, "mr-public", unit)}${pickupChannel("방막기 추정", pickup?.blocked, "mr-phone", unit)}</div>${pickup?.comparableIntervals != null ? `<p class="mr-method-note">비교 가능한 반복 관측 ${number(pickup.comparableIntervals)}구간 · 수량 단위 ${unit}</p>` : ""}${pickupEvidence(pickup, unit)}${pace.length ? `${insightTable(`${label} 숙박일 전 예약 관측 · 해당 선행일에 실제 수집한 값만`, ["관측 시점", "관측 업체·숙박일", `공개 예약 (${unit})`, `방막기 추정 (${unit})`, "관측 예약 추정률", "자료 충족률"], pace.map((row) => `<tr><th scope="row">${number(row.leadDays)}일 전</th><td>${number(row.coveredCompanyDays)} / ${number(row.expectedCompanyDays)}</td><td class="mr-public">${number(row.publicBookings)}</td><td class="mr-phone">${number(row.phoneBookings)}</td><td>${percent(row.reservationRate)}</td><td>${percent(row.coverageRate)}</td></tr>`))}<p class="mr-method-note">각 시점의 관측 업체·숙박일이 다를 수 있습니다. 두 행의 차이를 예약 증가량으로 해석하지 않습니다.</p>` : '<p class="mr-muted">14·7·3·1일 전 시점에 맞는 저장 자료가 없습니다. 가까운 날짜의 값으로 채우지 않습니다.</p>'}</section>`;
      }).join("")}
      <details class="mr-inner-fold"><summary>첫·마지막 관측 변화</summary><p>동일 업체·숙박일의 첫 유효 관측과 마지막 유효 관측 차이입니다. 월간 매출 합계와 별도입니다.</p><dl class="mr-inline-metrics"><div><dt>숙박 예약 추정 변화</dt><dd>${signed(snapshot.changes?.lodging?.soldChange, "실·박")}</dd></div><div><dt>숙박 추정 매출 변화</dt><dd>${signed(snapshot.changes?.lodging?.estimatedRevenueChange, "원")}</dd></div><div><dt>비교 가능 관측 쌍</dt><dd>${number(snapshot.changes?.lodging?.comparablePairs)}</dd></div></dl></details>
    </div></details>`;
  }
  function calendarGroups(groups = {}) {
    if (!Array.isArray(groups.rows) || !groups.rows.length) return "";
    return `<details class="mr-inner-fold"><summary>공휴일·전날·그 외 날짜 비교</summary><p>저장된 공휴일 달력으로 겹치지 않게 나눕니다. 공휴일이면서 다른 공휴일의 전날이면 공휴일로 분류합니다.</p>${groups.missingYears?.length ? `<p class="mr-insight-warnings">${escapeHtml(groups.missingYears.join(", "))}년 달력 근거가 없어 해당 날짜는 미확인으로 남겼습니다.</p>` : ""}${insightTable("숙박일 성격별 관측", ["날짜 구분", "달력 일수", "숙박 관측 업체·숙박일", "숙박 관측 예약 추정률", "숙박 추정 매출", "데이유즈 추정 매출"], groups.rows.map((row) => `<tr><th scope="row">${escapeHtml(row.label)}</th><td>${count(row.calendarDays, "일")}</td><td>${number(row.lodging?.coveredCompanyDays)} / ${number(row.lodging?.expectedCompanyDays)}</td><td>${percent(row.lodging?.reservationRate)}</td><td>${won(row.lodging?.estimatedRevenue)}</td><td>${won(row.dayuse?.estimatedRevenue)}</td></tr>`))}<p class="mr-method-note">달력 출처: ${(groups.sourceYears || []).map((source) => `${escapeHtml(source.year)}년 · ${source.status === "ready" ? `저장 ${escapeHtml(timeLabel(source.updatedAt))}` : "근거 미확인"}`).join(" / ") || "기록 없음"}</p></details>`;
  }
  function renderPriceDistribution(distribution) {
    if (!distribution) return "";
    const sample = Number(distribution.companyCount);
    return `<section class="mr-price-distribution"><h4>업체별 예약 추정 단가 분포</h4><p>각 업체의 가격 근거가 완전한 예상액을 예약 추정 실·박으로 나눈 값입니다. 공시 객실요금이나 실제 결제 객단가가 아닙니다.</p>${sample > 0 ? `<dl class="mr-inline-metrics"><div><dt>가격 확인 업체</dt><dd>${count(sample, "곳")}</dd></div><div><dt>업체별 단가 중간값</dt><dd>${won(distribution.medianUnitPrice)}</dd></div><div><dt>최소 ~ 최대</dt><dd>${won(distribution.minUnitPrice)} ~ ${won(distribution.maxUnitPrice)}</dd></div></dl><div class="mr-price-bands">${(distribution.bands || []).map((band) => `<div class="mr-price-band"><span>${escapeHtml(band.label)}</span>${Number.isFinite(band.companyCount) && band.companyCount >= 0 && band.companyCount <= sample ? `<meter min="0" max="${sample}" value="${band.companyCount}" aria-label="${escapeHtml(band.label)} ${number(sample)}곳 중 ${number(band.companyCount)}곳"></meter>` : ""}<strong>${count(band.companyCount, "곳")}</strong></div>`).join("")}</div>` : '<p class="mr-empty">업체별 단가를 계산할 가격 근거가 없습니다. 미확인 가격을 0원으로 채우지 않습니다.</p>'}</section>`;
  }
  function renderPricing(insights = {}) {
    return `<details class="mr-fold mr-report-section" data-mr-section="pricing"><summary>요일·가격 <span>숙박일의 요일과 관측가격</span></summary><div class="mr-fold-content"><p>수량은 각 숙박일의 최신 유효 관측을 사용합니다. 가격 지표는 가격 근거가 확인된 범위만 계산하며, 실제 결제 객단가가 아닙니다.</p>${[["lodging", "숙박", "실·박"], ["dayuse", "데이유즈", "회"]].map(([key, label, unit]) => {
      const weekdays = Array.isArray(insights.weekdays?.[key]) ? insights.weekdays[key] : [];
      const price = insights.pricing?.[key];
      if (!weekdays.length && !price && key === "dayuse") return "";
      return `<section class="mr-insight-product"><h4>${label}</h4>${weekdays.length ? insightTable(`${label} 요일별 관측`, ["요일", "관측 업체·숙박일", `공급 (${unit})`, `공개 예약 (${unit})`, `방막기 추정 (${unit})`, "관측 예약 추정률", "추정 매출", "자료 충족률"], weekdays.map((row) => `<tr><th scope="row">${escapeHtml(row.label)}요일</th><td>${number(row.coveredCompanyDays)} / ${number(row.expectedCompanyDays)}</td><td>${number(row.supply)}</td><td class="mr-public">${number(row.publicBookings)}</td><td class="mr-phone">${number(row.phoneBookings)}</td><td>${percent(row.reservationRate)}</td><td>${won(row.estimatedRevenue)}</td><td>${percent(row.coverageRate)}</td></tr>`)) : '<p class="mr-empty">이 저장본에 요일별 분석 자료가 없습니다.</p>'}${price ? `<dl class="mr-insight-stats"><div><dt>가격 근거 충족률</dt><dd>${percent(price.priceCoverageRate)}</dd><small>${number(price.pricedCompanyDays)} / ${number(price.expectedCompanyDays)} 업체·숙박일</small></div><div><dt>예약 추정 1${key === "lodging" ? "실·박" : "회"}당 금액</dt><dd>${won(price.estimatedPerSoldUnit)}</dd></div><div><dt>공급 1${key === "lodging" ? "실·박" : "회"}당 금액</dt><dd>${won(price.estimatedPerSupplyUnit)}</dd></div></dl><p class="mr-method-note">가격 근거가 있는 예약 추정 ${count(price.pricedSold, unit)} / 공급 ${count(price.pricedSupply, unit)} 기준 · 가격 근거 제외 ${number(price.excludedPriceCompanyDays)} 업체·숙박일${price.containsFallbackPrice ? " · 다른 관측일의 보완 가격 포함" : ""}. 미확인 금액을 0원으로 채우지 않습니다.</p>` : ""}</section>`;
    }).join("")}${renderPriceDistribution(insights.pricing?.lodging?.companyDistribution)}${calendarGroups(insights.calendarGroups)}</div></details>`;
  }
  function renderMarketOverview(overview) {
    if (!overview) return "";
    return `<dl class="mr-insight-stats mr-overview-metrics"><div><dt>중복 제거 업체</dt><dd>${count(overview.companyCount, "곳")}</dd></div><div><dt>객실 기준 총량</dt><dd>${count(overview.totalRooms, "실")}</dd><small>기준값 있는 업체 ${number(overview.knownCapacityCompanyCount)} / ${number(overview.companyCount)}곳${overview.capacityComplete === false ? " · 일부 업체 소계" : ""}</small></div><div><dt title="숙박월 이전 관측 포함">분석에 사용한 수집일</dt><dd>${count(overview.collectionDateCount, "일")}</dd><small>숙박월 이전 관측 포함 · 같은 날짜는 하루로 계산</small></div><div class="mr-public"><dt>공개 예약 비중</dt><dd>${percent(overview.publicBookingShare)}</dd></div><div class="mr-phone"><dt>방막기 추정 비중</dt><dd>${percent(overview.blockedBookingShare)}</dd></div></dl><p class="mr-method-note">객실 기준 총량은 업체별 DB 보정값을 우선하고, 없으면 최대 관측 추정값을 중복 없이 합합니다. 월간 실·박과 다릅니다. 예약 비중은 숙박 예약 추정 수량 안의 비중입니다.</p>`;
  }
  function renderSnapshot(snapshot = {}) {
    const quality = snapshot.quality || {};
    const warnings = Array.isArray(quality.warnings) ? quality.warnings : [];
    const globalWarnings = Array.isArray(quality.globalWarnings) ? quality.globalWarnings : [];
    const globalWarningsMarkup = globalWarnings.length ? `<section class="mr-context-source" aria-label="전체 DB 참고"><h4>전체 DB 참고</h4><p>아래 내용은 본 리포트의 품질 판단과 별도인 전체 DB 참고 정보입니다.</p><ul>${globalWarnings.map((warning) => `<li>${escapeHtml(textValue(warning))}</li>`).join("")}</ul></section>` : "";
    const companies = snapshot.companies || [];
    const period = snapshot.period || {};
    const runs = snapshot.sources?.runs || [];
    const definitions = snapshot.definitions || {};
    const insightDefinitions = snapshot.insights?.definitions || {};
    const definitionLabels = { month: "대상 월", latestObservation: "관측 선택", coverage: "자료 충족률", reservationRate: "관측 예약 추정률", estimatedRevenue: "추정 매출", phoneBookings: "방막기 추정", knownPartialRevenue: "부분 자료 금액", dayuse: "데이유즈", changes: "관측 변화", ranks: "노출 순위", context: "참고 자료", publication: "발행 기준" };
    const definitionsMarkup = [...(Array.isArray(definitions) ? definitions.map(textValue) : Object.entries(definitions).map(([key, value]) => `${definitionLabels[key] || "기준"}: ${textValue(value)}`)), ...(Array.isArray(insightDefinitions) ? insightDefinitions.map(textValue) : Object.values(insightDefinitions).map(textValue))];
    return `<div class="mr-snapshot">
      <div class="mr-basis">${period.monthClosed === false ? '<span class="mr-status mr-status-review">중간 집계</span>' : ""}<span>예약·매출의 대상 숙박일 <strong>${escapeHtml(period.start || "—")} ~ ${escapeHtml(period.end || "—")}</strong></span><span>순위의 관측월 <strong>${escapeHtml(monthLabel(snapshot.request?.month))}</strong></span><span>관측 마감일 <strong>${escapeHtml(period.cutoffDate || snapshot.request?.cutoffDate || "—")}</strong> (한국시간)</span></div>
      <section class="mr-quality${warnings.length || Number(quality.coverageRate) < 1 ? " has-warning" : ""}" aria-label="자료 품질"><div><strong>자료 충족률 ${percent(quality.coverageRate)}</strong><span>${number(quality.coveredCompanyDays)} / ${number(quality.expectedCompanyDays)} 업체·숙박일</span></div><p>같은 업체·숙박일·상품 유형은 마감일 이전의 최신 유효 관측 1건만 반영합니다. 반복 수집 회차를 합산하지 않습니다.</p>${warnings.length ? `<ul>${warnings.map((warning) => `<li>${escapeHtml(textValue(warning))}</li>`).join("")}</ul>` : ""}<small>미확인 ${number(quality.missingCompanyDays)} 업체·숙박일 · 빈 자료는 0원으로 바꾸지 않습니다.</small>${exclusionSummary(quality)}${freshnessSummary(quality)}</section>
      <section class="mr-report-section mr-market-summary" data-mr-section="summary">${sectionHeading(snapshot.request?.type === "company" ? "업체 요약" : "시장 요약", snapshot.request?.type === "keyword" ? `${snapshot.target?.label || "선택 키워드"} 검색에 관측된 업체 표본입니다. 지역 전체 숙박시장의 합계가 아닙니다.` : "저장된 관측 자료의 범위와 숙박·데이유즈 추정치를 확인합니다.")}
      <div class="mr-summary-strip"><span>반영 업체 <strong>${count(companies.length, "곳")}</strong></span><span>숙박일 <strong>${number((snapshot.daily || []).length)}일</strong></span>${companies.length === 1 ? capacityLabel(companies[0]) : ""}</div>
      ${renderMarketOverview(snapshot.insights?.overview)}
      <div class="mr-metrics">${metricCard("숙박", snapshot.summary?.lodging)}${metricCard("데이유즈", snapshot.summary?.dayuse, true)}</div>
      <p class="mr-method-note">공개 예약은 수집 자료에 표시된 예약 수량입니다. 방막기 추정은 재고 근거로 산출한 전화·타채널 예약을 포함하며 직접 확인한 예약과 구분합니다. 표시한 매출은 관측 가격을 적용한 추정치이며 실제 결제 매출과 다를 수 있습니다. 숙박과 데이유즈는 따로 집계합니다.</p>
      <details class="mr-fold"><summary>날짜별 합계 <span>${number((snapshot.daily || []).length)}일</span></summary>${dailyTable(snapshot.daily)}</details>
      <details class="mr-fold"><summary>업체별 상세 <span>${number(companies.length)}개 업체</span></summary><div class="mr-company-list">${companies.length ? companies.map((company) => `<details class="mr-company"><summary><span>${escapeHtml(company.primaryName || company.companyId)} ${capacityLabel(company)}</span><span>${won(company.summary?.lodging?.estimatedRevenue)} <small>숙박 · ${percent(company.summary?.lodging?.coverageRate)}</small></span></summary>${dailyTable(company.daily, `${company.primaryName || company.companyId} 날짜별 자료`)}</details>`).join("") : '<p class="mr-empty">반영된 업체가 없습니다.</p>'}</div></details>
      </section>
      ${renderComparison(snapshot.comparison)}
      ${renderRanks(snapshot)}
      ${renderTiming(snapshot)}
      ${renderPricing(snapshot.insights)}
      ${renderContext(snapshot.context, snapshot.insights?.geography)}
      <details class="mr-fold"><summary>출처와 산식 <span>저장된 근거 확인</span></summary><div class="mr-fold-content"><p>자료 수집시각과 숙박 대상일을 구분해 확인하세요. 아래 내용은 이 리포트를 만들 때 저장된 기준입니다.</p>${runs.length ? `<ul class="mr-source-list">${runs.map((run) => `<li><strong>${escapeHtml(run.keyword || run.label || run.runId || run.id)}</strong><span>수집 ${escapeHtml(timeLabel(run.collectedAt || run.finishedAt || run.createdAt))} (한국시간) · ${escapeHtml(run.runId || run.id || "")}</span><span>반영 ${number(run.selectedObservationCount)} / ${number(run.observationCount)}건${run.collectionQuality?.status === "partial" ? " · 일부 자료" : ""}</span></li>`).join("")}</ul>` : `<p>참조 수집 기록: ${escapeHtml((snapshot.sources?.runIds || []).join(", ") || "없음")}</p>`}${definitionsMarkup.length ? `<ul>${definitionsMarkup.map((definition) => `<li>${escapeHtml(definition)}</li>`).join("")}</ul>` : ""}${globalWarningsMarkup}</div></details>
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
        <section class="mr-card mr-detail" aria-label="리포트 미리보기와 상세">${snapshot ? `<div class="mr-detail-heading"><div><p class="mr-eyebrow">${report ? `VERSION ${number(report.version || 1)} · 수정 ${number(report.revision)}` : "PREVIEW · 아직 저장하지 않았습니다"}</p><h3>${escapeHtml(report?.title || reportTitle(state.previewRequest || snapshot.request, snapshot.target))}</h3><p>${escapeHtml(snapshot.target?.label || report?.targetId)} · ${escapeHtml(TYPES[report?.type || snapshot.request?.type] || "")}</p></div>${report ? statusTag(report.status) : '<span class="mr-status">미리보기</span>'}</div>
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
          state.title = reportTitle(body, state.preview.target); state.notes = ""; state.acknowledged = false;
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
  const api = { createController, renderSnapshot, renderList, escapeHtml, defaultCutoff, reportTitle, canPublish, show(container, context) { if (!container) return; let instance = instances.get(container); if (!instance) { instance = createController(container); instances.set(container, instance); } return instance.open(context); } };
  root.MonthlyReports = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window === "undefined" ? globalThis : window);
