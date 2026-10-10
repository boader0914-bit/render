(function (root) {
  "use strict";
  const instances = new WeakMap();
  const remembered = new Map();
  const TABS = { settlement: "월별 결산", analysis: "예약 흐름 분석", history: "관측 이력", review: "자료 검토" };
  const REASONS = {
    unknown_legacy_run_quality: "과거 수집의 정상 응답 여부 미확인", legacy_inventory_evidence: "과거 재고 계산 근거 미확인",
    superseded_observation: "더 최근의 유효 관측 채택", duplicate_observation: "중복 관측 제외",
    after_cutoff: "관측 기준일 이후 자료", post_stay_observation: "숙박일 이후 관측", dayuse_unobserved: "데이유즈 미관측",
    missing_response: "정상 응답 누락", run_cancelled: "수집 취소", run_canceled: "수집 취소", run_error: "수집 오류", run_failed: "수집 실패", run_blocked: "접근 제한", run_interrupted: "수집 중단", invalid_stay_date: "숙박일 미확인",
    invalid_collection_time: "수집 시각 미확인", unverified_collection_time: "수집 시각의 근거 미확인",
    partial_inventory: "일부 상품만 관측", capacity_recalculation_unavailable: "객실 기준 재계산 근거 부족",
    capacity_conflict: "객실 기준과 수량 불일치", inventory_conflict: "재고 수량 불일치",
    missing_inventory: "재고 누락", partial: "일부 관측", invalid_quantity: "수량 근거 미확인",
    missing_quantity: "예약·재고 수량 누락", quantity_conflict: "예약 수량과 객실 총량 불일치", rate_unavailable: "예약률 계산 근거 미확인",
    run_unknown: "수집의 정상 응답 여부 미확인", not_selected_by_quality_rules: "품질 기준에 따라 다른 관측 채택",
    invalid_product_type: "숙박·데이유즈 구분 미확인", inconsistent_revenue: "수량과 매출 계산 근거 불일치",
    supply_changed: "비교 관측의 객실 기준 변경", inventory_basis_changed: "상품·재고 기준 변경"
  };
  const esc = value => String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
  const numeric = value => value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value)) ? Number(value) : null;
  const num = value => numeric(value) === null ? "미확인" : Number(value).toLocaleString("ko-KR", { maximumFractionDigits: 1 });
  const money = value => numeric(value) === null ? "미확인" : `${num(Number(value) / 10000)}만원`;
  const pct = value => numeric(value) === null ? "미확인" : `${num(Number(value) * 100)}%`;
  const signed = value => numeric(value) === null ? "미확인" : `${Number(value) > 0 ? "+" : ""}${num(value)}`;
  const reason = value => REASONS[value] || value || "사유 미확인";
  const text = value => typeof value === "string" ? value : value?.message || value?.label || value?.reason || "";
  const validMonth = month => /^\d{4}-(0[1-9]|1[0-2])$/.test(month || "");
  const time = value => {
    if (!value) return "미확인";
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", dateStyle: "short", timeStyle: "short" }).format(date) : "미확인";
  };
  const kstDay = value => {
    if (!value || !Number.isFinite(Date.parse(value))) return null;
    return new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Seoul" }).format(new Date(value));
  };
  const monthLabel = month => validMonth(month) ? `${Number(month.slice(0, 4))}년 ${Number(month.slice(5))}월` : "대상 월 미확인";
  const runButton = (id, label = "수집 원본") => id ? `<button type="button" class="ci-link" data-archive-run-id="${esc(id)}">${esc(label)}</button>` : "미확인";
  const warnings = values => values?.length ? `<ul class="ci-warnings">${values.map(value => `<li>${esc(text(value))}</li>`).join("")}</ul>` : "";
  const table = (caption, headers, rows) => `<div class="ci-table-scroll" role="region" tabindex="0" aria-label="${esc(caption)}"><table><caption>${esc(caption)}</caption><thead><tr>${headers.map(header => `<th scope="col">${esc(header)}</th>`).join("")}</tr></thead><tbody>${rows.length ? rows.join("") : `<tr><td colspan="${headers.length}">표시할 관측 자료가 없습니다.</td></tr>`}</tbody></table></div>`;

  function buildViewModel(envelope = {}, context = {}) {
    const snapshot = envelope.snapshot || {};
    const month = envelope.selectedMonth || snapshot.request?.month || context.month || "";
    const companyId = envelope.companyId || context.companyId || "";
    const company = (snapshot.companies || []).find(item => item.companyId === companyId || item.id === companyId) || snapshot.companies?.[0] || {};
    const basis = envelope.roomBasis || {};
    const capacity = numeric(basis.capacity ?? basis.rooms ?? basis.totalRooms ?? company.capacity ?? snapshot.target?.capacity);
    const sources = (snapshot.sources?.observations || []).filter(row => row.productType === "lodging" && (!row.companyId || row.companyId === companyId));
    const sourceMap = new Map(sources.map(row => [row.date, row]));
    const daily = new Map((snapshot.daily || []).map(row => [row.date, row]));
    const days = validMonth(month) ? new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5)), 0)).getUTCDate() : 0;
    const rows = Array.from({ length: days }, (_, index) => {
      const date = `${month}-${String(index + 1).padStart(2, "0")}`;
      const row = daily.get(date) || {}, metric = row.lodging || {}, source = sourceMap.get(date);
      const observed = numeric(metric.sold) !== null && numeric(metric.supply) !== null && metric.coveredCompanyDays !== 0;
      const observedDay = kstDay(source?.collectedAt);
      const lag = numeric(source?.observationLeadTimeDays) ?? (observedDay ? Math.max(0, Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${observedDay}T00:00:00Z`)) / 86400000)) : null);
      return { date, day: index + 1, observed, source, observedDay, lag,
        sold: observed ? numeric(metric.sold) : null, supply: observed ? numeric(metric.supply) : null,
        publicBookings: observed ? numeric(metric.publicBookings) : null, phoneBookings: observed ? numeric(metric.phoneBookings) : null,
        estimatedRevenue: observed ? numeric(metric.estimatedRevenue) : null,
        publicRevenue: observed ? numeric(metric.publicRevenue) : null, phoneRevenue: observed ? numeric(metric.phoneRevenue) : null,
        reservationRate: observed ? numeric(metric.reservationRate) : null,
        revenuePartial: Boolean(metric.revenuePartial), knownPartialRevenue: numeric(metric.knownPartialRevenue) };
    });
    let keywords = Array.isArray(envelope.keywords) ? envelope.keywords : [];
    if (!keywords.length) {
      const grouped = new Map();
      for (const run of snapshot.sources?.runs || []) { const key = run.keyword || "키워드 미확인"; if (!grouped.has(key)) grouped.set(key, []); grouped.get(key).push(run); }
      keywords = [...grouped].map(([keyword, runs]) => ({ keyword, runs }));
    }
    return { ...envelope, snapshot, companyId, companyName: snapshot.target?.label || company.name || company.companyName || context.companyName || "선택 업체",
      month, capacity, roomBasis: basis, rows, keywords, summary: snapshot.summary?.lodging || {}, quality: snapshot.quality || {}, insights: snapshot.insights || {} };
  }

  function freshness(row) {
    if (!row.observed) return "미관측·미확인";
    if (row.lag === null) return "관측일 미확인";
    return row.lag === 0 ? "숙박 당일 관측" : `${num(row.lag)}일 전 관측`;
  }
  function metrics(model) {
    const m = model.summary, q = model.quality;
    return `<div class="ci-metrics"><section><span>객실 기준</span><strong>${num(model.capacity)}${model.capacity === null ? "" : "<small>실</small>"}</strong><small>${esc(model.roomBasis.label || model.roomBasis.source || "업체 DB 기준")}</small></section>
      <section><span>예약 합계</span><strong>${num(m.sold)}${numeric(m.sold) === null ? "" : "<small>실·박</small>"}</strong><small><b class="ci-public">네이버 ${num(m.publicBookings)}</b> · <b class="ci-other">타채널 추정 ${num(m.phoneBookings)}</b></small></section>
      <section><span>추정 매출${m.revenuePartial ? " · 확인된 소계" : ""}</span><strong>${money(m.estimatedRevenue)}</strong><small>네이버 ${money(m.publicRevenue)}${numeric(m.phoneRevenue) > 0 ? ` · 타채널 ${money(m.phoneRevenue)}` : ""}</small></section>
      <section><span>관측 예약률</span><strong>${pct(m.reservationRate)}</strong><small>관측 공급 ${num(m.supply)}실·박 기준</small></section></div>
      <div class="ci-coverage"><span>숙박 당일 <b>${num(q.sameDayObservedCompanyDays ?? m.sameDayObservedCompanyDays)}</b>일</span><span>사전 관측 <b>${num(q.staleDays ?? m.staleDays)}</b>일</span><span>미관측·미확인 <b>${num(q.missingCompanyDays ?? m.missingCompanyDays)}</b>일</span><span>실·박은 날짜별 객실 수의 합계입니다.</span></div>`;
  }
  function reservationChart(model) {
    const max = Math.max(1, model.capacity || 0, ...model.rows.map(row => row.supply || 0), ...model.rows.map(row => row.sold || 0));
    const fixedBasis = model.capacity > 0 && model.rows.some(row => row.observed) && model.rows.every(row => !row.observed || row.supply === model.capacity);
    const width = Math.max(740, model.rows.length * 28 + 64), height = 212, top = 20, bottom = 176, chartHeight = bottom - top, left = 35, cell = (width - 70) / Math.max(1, model.rows.length);
    const bars = model.rows.map((row, index) => {
      const x = left + index * cell + 3, barWidth = Math.max(6, cell - 8);
      const title = `${row.date}: ${row.observed ? `예약 ${num(row.sold)}실, 예약률 ${pct(row.reservationRate)}, 네이버 ${num(row.publicBookings)}실, 타채널 추정 ${num(row.phoneBookings)}실, ${freshness(row)}` : "미관측·미확인"}`;
      const green = (row.publicBookings || 0) / max * chartHeight, purple = (row.phoneBookings || 0) / max * chartHeight;
      return `<g><title>${esc(title)}</title>${!row.observed ? `<rect class="ci-gap-bar" x="${x}" y="${bottom - 5}" width="${barWidth}" height="5"/>` : `<rect class="ci-public-bar" x="${x}" y="${bottom - green}" width="${barWidth}" height="${green}" rx="2"/>${row.phoneBookings > 0 ? `<rect class="ci-other-bar" x="${x}" y="${bottom - green - purple}" width="${barWidth}" height="${purple}" rx="2"/>` : ""}${row.sold === 0 ? `<circle class="ci-zero-dot" cx="${x + barWidth / 2}" cy="${bottom}" r="2.3"/>` : ""}`}<text x="${x + barWidth / 2}" y="${bottom + 22}" text-anchor="middle">${row.day}</text></g>`;
    }).join("");
    return `<section class="ci-card"><div class="ci-section-head"><h4>날짜별 예약 흐름</h4><span>${fixedBasis ? `객실 ${num(model.capacity)}실 기준 · 왼쪽 수량 / 오른쪽 예약률` : "수량·예약률을 함께 확인"}</span></div><div class="ci-legend"><span class="ci-public">● 네이버 공개 예약</span><span class="ci-other">● 타채널 추정</span><span>━ 미확인 · 작은 점은 정상 0실</span></div>
      <div class="ci-chart-scroll" tabindex="0" role="region" aria-label="날짜별 예약 수량 그래프"><svg class="ci-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(monthLabel(model.month))} 날짜별 예약 수량. 정확한 수량과 예약률은 아래 날짜별 표에서 확인할 수 있습니다." style="min-width:${width}px"><title>네이버 예약과 타채널 추정 예약</title>${[0, .5, 1].map(ratio => `<line x1="${left}" y1="${bottom - chartHeight * ratio}" x2="${width - 28}" y2="${bottom - chartHeight * ratio}" class="ci-chart-grid"/><text x="${left - 8}" y="${bottom - chartHeight * ratio + 4}" text-anchor="end">${num(max * ratio)}</text>`).join("")}${bars}${fixedBasis ? [0, .5, 1].map(ratio => `<text x="${width - 23}" y="${bottom - chartHeight * ratio + 4}" text-anchor="start">${num(max * ratio / model.capacity * 100)}%</text>`).join("") : ""}</svg></div></section>`;
  }
  function dailyTable(model) {
    return table("날짜별 예약·추정 매출과 관측 기준", ["숙박일", "예약 / 공급", "예약률", "네이버", "타채널 추정", "추정 매출", "관측 기준", "근거"], model.rows.map(row => `<tr><th scope="row">${esc(row.date)}</th><td>${num(row.sold)} / ${num(row.supply)}</td><td>${pct(row.reservationRate)}</td><td class="ci-public">${num(row.publicBookings)}</td><td class="${row.phoneBookings > 0 ? "ci-other" : ""}">${row.phoneBookings === 0 ? "—" : num(row.phoneBookings)}</td><td>${money(row.estimatedRevenue)}${row.observed && row.revenuePartial ? " · 일부" : ""}</td><td>${esc(freshness(row))}${row.observedDay ? `<small>${esc(row.observedDay)}</small>` : ""}</td><td><button type="button" class="ci-link" data-ci-date="${esc(row.date)}">확인</button></td></tr>`));
  }
  function calendar(model) {
    if (!model.rows.length) return '<p class="ci-empty">선택할 월별 자료가 없습니다.</p>';
    const offset = new Date(`${model.month}-01T00:00:00Z`).getUTCDay();
    return `<div class="ci-calendar" aria-label="${esc(monthLabel(model.month))} 예약·매출 캘린더"><div class="ci-weekdays" aria-hidden="true">${["일", "월", "화", "수", "목", "금", "토"].map(day => `<span>${day}</span>`).join("")}</div><div class="ci-calendar-grid">${Array.from({ length: offset }, () => '<div class="ci-calendar-padding" aria-hidden="true"></div>').join("")}${model.rows.map(row => `<button type="button" data-ci-date="${row.date}" class="ci-day${row.observed ? "" : " ci-day-missing"}${row.phoneBookings > 0 ? " ci-day-other" : ""}" aria-label="${esc(`${row.date}, 예약 ${num(row.sold)}실, 매출 ${money(row.estimatedRevenue)}, ${freshness(row)}`)}"><span class="ci-day-number">${row.day}</span><strong>${row.observed ? `${num(row.sold)}실 · ${pct(row.reservationRate)}` : "미확인"}</strong><span>${money(row.estimatedRevenue)}</span>${row.phoneBookings > 0 ? `<span class="ci-other">타채널 ${num(row.phoneBookings)}실<br>${money(row.phoneRevenue)}</span>` : ""}<small>${row.lag > 0 ? `${num(row.lag)}일 전 관측` : row.observed && row.lag === 0 ? "당일 관측" : row.observed ? "관측일 미확인" : "관측 근거 없음"}</small></button>`).join("")}</div></div>`;
  }
  function dateDetail(model, selected) {
    const row = model.rows.find(item => item.date === selected);
    if (!row) return "";
    const excluded = (model.quality.discardedSamples || []).filter(item => item.date === selected);
    return `<section class="ci-card ci-date-detail" tabindex="-1" data-ci-date-detail><div class="ci-section-head"><h4>${esc(selected)} 계산 근거</h4><button type="button" data-ci-close-date aria-label="날짜 근거 닫기">닫기</button></div><p>${row.observed ? `${esc(time(row.source?.collectedAt))}의 유효 관측을 채택했습니다. ${esc(freshness(row))}.` : "이 날짜에 채택할 유효 관측이 없습니다. 0실·0원으로 계산하지 않았습니다."}</p>${row.observed ? `<dl class="ci-facts"><div><dt>예약 / 공급</dt><dd>${num(row.sold)} / ${num(row.supply)}실</dd></div><div><dt>추정 매출</dt><dd>${money(row.estimatedRevenue)}</dd></div><div><dt>사용한 수집</dt><dd>${runButton(row.source?.runId)}</dd></div><div><dt>가격 근거</dt><dd>${esc(row.source?.revenueEligible === false ? "가격 근거 미확인" : row.source?.priceEvidenceType === "stay_date_observed_price" ? "해당 숙박일 관측 가격" : row.source?.priceEvidenceType === "same_product_observed_fallback" ? "동일 상품의 보완 가격 포함" : "저장된 상품별 가격 근거")}</dd></div></dl>` : ""}${excluded.length ? `<details><summary>제외된 관측 ${excluded.length}건 · 표시된 표본</summary>${table("이 날짜의 제외된 관측 표본", ["사유", "수집 원본"], excluded.map(item => `<tr><td>${esc(reason(item.reason))}</td><td>${runButton(item.runId)}</td></tr>`))}</details>` : ""}</section>`;
  }
  function analysis(model) {
    const insights = model.insights, pickup = insights.pickup?.lodging || {}, publicPickup = pickup.public || {}, lead = publicPickup.leadTime || {};
    const intervals = pickup.recentIntervals || [];
    const weekdays = insights.weekdays?.lodging || [], pace = insights.pace?.lodging || [];
    return `${reservationChart(model)}<div class="ci-analysis-grid"><section class="ci-card"><h4>예약 증가를 확인한 시점</h4><p class="ci-big">${lead.averageMinDays != null && lead.averageMaxDays != null ? `숙박 ${num(lead.averageMinDays)}~${num(lead.averageMaxDays)}일 전` : "산출할 비교 자료 없음"}</p><p>네이버 공개 예약 증가의 가중 평균 구간입니다. 실제 예약 접수일은 아닙니다.</p><dl class="ci-facts"><div><dt>증가 관측</dt><dd>${num(publicPickup.increase)}실</dd></div><div><dt>감소 관측</dt><dd>${num(publicPickup.decrease)}실</dd></div><div><dt>비교 구간</dt><dd>${num(pickup.comparableIntervals)}건</dd></div><div><dt>최초 관측 예약</dt><dd>${num(pickup.baselinePublicBookings)}실</dd></div></dl><small>최초 관측 전에 이미 예약된 수량은 리드타임에서 제외합니다. 감소는 취소 확정 건수가 아닙니다.</small></section>
      <section class="ci-card"><h4>숙박일이 가까워질 때의 예약률</h4>${table("D별 당일 관측이 있는 표본만 비교", ["시점", "예약률", "예약 수량", "관측 표본"], pace.map(row => `<tr><th scope="row">D-${num(row.leadDays)}</th><td>${pct(row.reservationRate)}</td><td>${num(row.sold)}실</td><td>${num(row.coveredCompanyDays)}일</td></tr>`))}<small>각 시점의 표본이 다를 수 있습니다. 빈 구간은 채우지 않습니다.</small></section></div>
      <section class="ci-card"><h4>요일별 예약·매출</h4>${table("공휴일 분리 전 요일별 관측", ["요일", "예약률", "예약 / 공급 (실·박)", "추정 매출", "관측 일수"], weekdays.map(row => `<tr><th scope="row">${esc(row.label)}요일</th><td>${pct(row.reservationRate)}</td><td>${num(row.sold)} / ${num(row.supply)}</td><td>${money(row.estimatedRevenue)}</td><td>${num(row.coveredCompanyDays)} / ${num(row.expectedCompanyDays)}</td></tr>`))}<p>예약 1실·박당 금액 ${money(insights.pricing?.lodging?.estimatedPerSoldUnit)} · 가격 근거 충족률 ${pct(insights.pricing?.lodging?.priceCoverageRate)}</p></section>
      <section class="ci-card"><h4>최근 예약 변화</h4>${table("동일 숙박일·동일 객실 기준의 연속 관측", ["숙박일", "이전 관측 → 최근 관측", "네이버 증감", "타채널 증감", "합계 증감", "증가 관측 구간"], intervals.map(row => `<tr><th scope="row">${esc(row.date)}</th><td>${esc(time(row.previousCollectedAt))}<br>→ ${esc(time(row.collectedAt))}</td><td class="ci-public">${signed(row.publicChange)}실</td><td class="ci-other">${signed(row.blockedChange)}실</td><td>${signed(row.netChange)}실</td><td>${row.netChange > 0 ? `${num(row.currentLeadDays)}~${num(row.previousLeadDays)}일 전` : "—"}</td></tr>`))}${pickup.intervalsTruncated ? "<p>최근 60개 구간입니다. 합계는 전체 유효 비교 구간을 사용합니다.</p>" : ""}<small>채널 분류 변경과 가격 보정은 신규 예약·신규 매출로 단정하지 않습니다.</small></section>
      <details class="ci-card"><summary>날짜별 수량·예약률 표</summary>${dailyTable(model)}</details>`;
  }
  function history(model) {
    return `<section class="ci-card"><h4>키워드별 수집 원본</h4><p>같은 업체는 통합하고 검색 순위와 당시 수집값은 키워드별로 보존합니다.</p>${model.keywords.length ? model.keywords.map(group => `<details class="ci-keyword"><summary>${esc(group.keyword || "키워드 미확인")} <span>${num(group.runs?.length)}회</span></summary>${table(`${group.keyword || "키워드"} 수집 이력`, ["수집 시각", "검색 순위", "수집 상태", "원본"], (group.runs || []).map(run => `<tr><td>${esc(time(run.collectedAt))}</td><td>${numeric(run.rank ?? run.overallRank) === null ? "미확인" : `${num(run.rank ?? run.overallRank)}위`}</td><td>${esc(({ complete: "완료", partial: "일부 완료", failed: "실패", blocked: "접근 제한", reused: "기존 자료 사용" })[run.status || run.collectionQuality?.status] || run.status || run.collectionQuality?.status || "미확인")}</td><td>${runButton(run.runId || run.id)}</td></tr>`))}</details>`).join("") : '<p class="ci-empty">연결된 키워드별 원본이 없습니다.</p>'}</section><section class="ci-card"><h4>숙박일별 채택값</h4>${dailyTable(model)}</section>`;
  }
  function review(model) {
    const q = model.quality, snap = model.snapshot, reasons = Object.entries(q.discardedByReason || {});
    const recentFailures = model.failedAttempts || model.latestFailures || model.latestFailedObservations || [];
    const basisWarnings = model.roomBasis.warnings || [];
    return `<section class="ci-card"><h4>객실 기준과 가공 상태</h4><dl class="ci-facts"><div><dt>객실 기준</dt><dd>${num(model.capacity)}실</dd></div><div><dt>기준 출처</dt><dd>${esc(model.roomBasis.label || model.roomBasis.source || "미확인")}</dd></div><div><dt>가공 시각</dt><dd>${esc(time(model.calculatedAt))}</dd></div><div><dt>계산 버전</dt><dd>${esc(model.calculationVersion || "미확인")}</dd></div></dl>${warnings(basisWarnings)}${warnings([...(q.warnings || []), ...(q.globalWarnings || [])])}</section>
      ${recentFailures.length ? `<section class="ci-card ci-alert"><h4>최근 수집 실패·제한</h4>${table("이전 정상 관측은 유지하고 최근 실패를 따로 표시", ["숙박일", "관측 시각", "상태·사유", "이전 정상 관측", "원본"], recentFailures.map(row => `<tr><td>${esc(row.date || "미확인")}</td><td>${esc(time(row.collectedAt))}</td><td>${esc(reason(row.reason || row.status))}</td><td>${esc(time(row.lastValidCollectedAt))}</td><td>${runButton(row.runId || row.id)}</td></tr>`))}</section>` : ""}
      <section class="ci-card"><h4>합산에서 제외한 자료</h4>${table("정상 중복 제외와 품질 미확인을 구분", ["사유", "관측 건수"], reasons.map(([key, count]) => `<tr><th scope="row">${esc(reason(key))}</th><td>${num(count)}</td></tr>`))}<p>과거 자료의 정상 응답과 계산 근거가 확인되지 않으면 월 합계에 포함하지 않습니다.</p></section>
      ${(snap.sources?.partialEvidence || []).length ? `<section class="ci-card"><h4>부분 관측 자료</h4>${table("정상 합계에서 제외한 부분 자료", ["숙박일", "부분 자료 금액", "사유", "원본"], snap.sources.partialEvidence.map(row => `<tr><th scope="row">${esc(row.date)}</th><td>${money(row.knownPartialRevenue)}</td><td>${esc(reason(row.reason))}</td><td>${runButton(row.runId)}</td></tr>`))}</section>` : ""}
      <section class="ci-card"><h4>계산 기준</h4><ul class="ci-rules"><li>업체 고유번호와 숙박일로 통합하고, 같은 날짜의 최신 유효 관측 한 번만 채택합니다.</li><li>숙박일이 지난 뒤 관측한 자료는 해당 숙박일의 예약으로 사용하지 않습니다.</li><li>실패·누락을 0으로 바꾸지 않습니다. 사전 관측은 마지막 관측일을 함께 표시합니다.</li><li>타채널 수량·매출은 공개 재고 기반의 추정이며 실제 결제 내역이 아닙니다.</li><li>객실을 공유하는 데이유즈는 숙박 객실과 중복 합산하지 않습니다.</li></ul>${snap.sourceContext ? `<details><summary>자료 연결 근거</summary><pre>${esc(JSON.stringify(snap.sourceContext, null, 2))}</pre></details>` : ""}</section>`;
  }
  function render(model, state) {
    const working = ["updating", "refreshing"].includes(model.status);
    const tabs = Object.entries(TABS), status = ({ ready: "갱신 완료", updating: "통합 중", refreshing: "통합 중", pending: "가공 대기", failed: "가공 실패" })[model.status] || "상태 미확인";
    const months = [...new Set([model.month, ...(model.months || []).map(item => typeof item === "string" ? item : item.month)].filter(validMonth))].sort().reverse();
    const page = state.tab === "analysis" ? analysis(model) : state.tab === "history" ? history(model) : state.tab === "review" ? review(model) : `${reservationChart(model)}<section class="ci-card"><div class="ci-section-head"><h4>날짜별 예약·추정 매출</h4><div class="ci-view-switch" role="group" aria-label="매출 보기 방식"><button type="button" data-ci-view="calendar" aria-pressed="${state.view === "calendar"}">캘린더</button><button type="button" data-ci-view="table" aria-pressed="${state.view === "table"}">표</button></div></div>${state.view === "table" ? dailyTable(model) : calendar(model)}</section>`;
    return `<div class="company-integrated"><header class="ci-header"><div><p class="ci-eyebrow">COMPANY INSIGHT</p><h3>월별 통합 분석</h3><p>숙박일 기준 · 키워드 중복 제외</p></div><div class="ci-controls"><span class="ci-status${working ? " ci-status-updating" : model.status === "failed" ? " ci-status-failed" : ""}" role="status">${esc(status)}</span><label>숙박월<select data-ci-month aria-label="통합 DB 숙박월"${!months.length ? " disabled" : ""}>${months.length ? months.map(month => `<option value="${month}"${month === model.month ? " selected" : ""}>${esc(monthLabel(month))}</option>`).join("") : '<option value="">자료 없음</option>'}</select></label><button type="button" data-ci-refresh${state.loading ? " disabled" : ""}>${state.loading ? "불러오는 중" : "상태 확인"}</button></div></header>
      ${state.error ? `<div class="ci-alert" role="alert">${esc(state.error)}${model.snapshot?.summary ? " 기존 저장 자료를 표시합니다." : ""}</div>` : ""}
      ${model.status === "failed" && model.errorCode ? `<div class="ci-alert" role="status">통합 가공에 실패했습니다. 오류 코드: ${esc(model.errorCode)}</div>` : ""}
      ${model.roomBasis.warnings?.length ? `<div class="ci-alert" role="status"><strong>객실 기준 검토 필요</strong>${warnings(model.roomBasis.warnings)}</div>` : ""}
      ${model.failedAttempts?.length ? '<p class="ci-status-note">일부 날짜의 최근 수집이 실패하여 이전 정상 관측을 유지합니다. <button type="button" data-ci-tab="review">자료 검토</button></p>' : ""}
      ${model.status !== "ready" && model.snapshot?.summary ? `<p class="ci-status-note">${model.status === "failed" ? "최근 가공에 실패했습니다. 마지막 정상 가공 자료입니다." : "새 자료를 통합하는 동안 마지막 가공 자료를 표시합니다."}</p>` : ""}
      ${model.snapshot?.summary ? `${metrics(model)}<p class="ci-method">마지막 가공 ${esc(time(model.calculatedAt))} · 관측 기준일 ${esc(model.snapshot.request?.cutoffDate || "미확인")} · 실제 결제 매출이 아닌 관측 기반 추정입니다.</p>` : `<p class="ci-empty" role="status">${state.loading || ["pending", "updating", "refreshing"].includes(model.status) ? "저장된 수집 자료로 업체 통합 DB를 준비하고 있습니다." : "사용할 수 있는 통합 자료가 없습니다."}</p>`}
      <div class="ci-tabs" role="tablist" aria-label="업체 통합 DB 메뉴">${tabs.map(([id, title]) => `<button type="button" id="ci-tab-${id}" role="tab" data-ci-tab="${id}" aria-selected="${id === state.tab}" aria-controls="ci-panel-${id}" tabindex="${id === state.tab ? "0" : "-1"}">${title}</button>`).join("")}</div><div id="ci-panel-${state.tab}" role="tabpanel" aria-labelledby="ci-tab-${state.tab}" class="ci-content">${model.snapshot?.summary ? page : ""}${dateDetail(model, state.selectedDate)}</div>
      ${model.snapshot?.summary ? `<footer class="ci-footer"><span>원본과 전체 관측 이력은 보존됩니다.</span><button type="button" data-monthly-report-context="company" data-monthly-report-target="${esc(model.companyId)}" data-monthly-report-month="${esc(model.month)}">이 월로 리포트 열기</button></footer>` : ""}</div>`;
  }

  async function request(companyId, month, signal) {
    const query = new URLSearchParams({ companyId });
    if (validMonth(month)) query.set("month", month);
    const response = await root.fetch(`/api/company-master/integrated?${query}`, { credentials: "same-origin", headers: { Accept: "application/json" }, signal });
    if (response.status === 401 || response.status === 403) throw new Error("관리자 로그인이 필요합니다. 다시 로그인한 뒤 확인하세요.");
    const body = await response.json();
    if (!response.ok) throw new Error(body.message || body.error || "통합 자료를 불러오지 못했습니다.");
    return body;
  }
  function createController(container, options = {}) {
    const fetchData = options.fetchData || request, schedule = options.setTimeout || root.setTimeout.bind(root), cancel = options.clearTimeout || root.clearTimeout.bind(root);
    const state = { context: {}, tab: "settlement", view: "calendar", selectedDate: "", loading: false, error: "", envelope: {}, month: "" };
    let timer = null, sequence = 0, aborted = null, disposed = false;
    function clearTimer() { if (timer !== null) cancel(timer); timer = null; }
    function draw() {
      if (disposed) return;
      const active = root.document?.activeElement;
      const focused = active && container.contains?.(active);
      const selector = focused && active.matches?.("[data-ci-month]") ? "[data-ci-month]" : focused && active.matches?.("[data-ci-refresh]") ? "[data-ci-refresh]" : null;
      container.innerHTML = render(buildViewModel(state.envelope, { ...state.context, month: state.month }), state);
      if (selector) container.querySelector(selector)?.focus();
    }
    function remember() { if (state.context.companyId) { remembered.set(state.context.companyId, { tab: state.tab, view: state.view, month: state.month }); if (remembered.size > 100) remembered.delete(remembered.keys().next().value); } }
    async function load(month = state.month) {
      if (disposed || !state.context.companyId) return;
      clearTimer(); aborted?.abort(); aborted = new AbortController(); const current = ++sequence;
      if (month !== state.month) { state.envelope = {}; state.selectedDate = ""; }
      state.month = month; state.loading = true; state.error = ""; draw();
      try {
        const envelope = await fetchData(state.context.companyId, month, aborted.signal);
        if (disposed || current !== sequence) return;
        if (envelope.companyId && envelope.companyId !== state.context.companyId) throw new Error("요청한 업체와 자료의 업체가 일치하지 않습니다.");
        if (validMonth(month) && envelope.selectedMonth && envelope.selectedMonth !== month) throw new Error("선택한 월과 자료의 월이 일치하지 않습니다.");
        state.envelope = envelope; state.month = envelope.selectedMonth || envelope.snapshot?.request?.month || month;
        // Pending means queued but not running. Poll only actual in-progress work.
        if (["updating", "refreshing"].includes(envelope.status)) timer = schedule(() => { timer = null; if (container.isConnected === false || container.closest?.("[hidden]")) return; void load(); }, 3000);
      } catch (error) { if (!disposed && current === sequence && error.name !== "AbortError") state.error = error.message || "통합 자료를 불러오지 못했습니다."; }
      finally { if (!disposed && current === sequence) { state.loading = false; remember(); draw(); } }
    }
    async function open(context) {
      const changed = state.context.companyId !== context.companyId;
      state.context = { ...context };
      if (changed) { const previous = remembered.get(context.companyId) || {}; state.tab = previous.tab || "settlement"; state.view = previous.view || "calendar"; state.month = context.month || previous.month || ""; state.envelope = {}; state.selectedDate = ""; }
      await load(context.month || state.month);
    }
    function selectTab(tab) { if (!Object.hasOwn(TABS, tab)) return; state.tab = tab; state.selectedDate = ""; remember(); draw(); container.querySelector(`[data-ci-tab="${tab}"]`)?.focus(); }
    const click = event => {
      const tab = event.target.closest?.("[data-ci-tab]"); if (tab) { selectTab(tab.dataset.ciTab); return; }
      const view = event.target.closest?.("[data-ci-view]"); if (view) { state.view = view.dataset.ciView === "table" ? "table" : "calendar"; remember(); draw(); container.querySelector(`[data-ci-view="${state.view}"]`)?.focus(); return; }
      if (event.target.closest?.("[data-ci-refresh]")) { void load(); return; }
      const date = event.target.closest?.("[data-ci-date]"); if (date) { state.selectedDate = date.dataset.ciDate; draw(); container.querySelector("[data-ci-date-detail]")?.focus(); return; }
      if (event.target.closest?.("[data-ci-close-date]")) { const selected = state.selectedDate; state.selectedDate = ""; draw(); container.querySelector(`[data-ci-date="${selected}"]`)?.focus(); }
    };
    const change = event => { if (event.target.matches?.("[data-ci-month]") && validMonth(event.target.value)) void load(event.target.value); };
    const keydown = event => {
      if (!event.target.matches?.("[data-ci-tab]") || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault(); const keys = Object.keys(TABS), index = keys.indexOf(state.tab);
      selectTab(event.key === "Home" ? keys[0] : event.key === "End" ? keys.at(-1) : keys[(index + (event.key === "ArrowRight" ? 1 : keys.length - 1)) % keys.length]);
    };
    container.addEventListener("click", click); container.addEventListener("change", change); container.addEventListener("keydown", keydown);
    function dispose() { disposed = true; sequence += 1; aborted?.abort(); clearTimer(); container.removeEventListener("click", click); container.removeEventListener("change", change); container.removeEventListener("keydown", keydown); instances.delete(container); }
    draw(); return { state, open, load, selectTab, dispose };
  }
  const api = { buildViewModel, render, createController, show(container, context) { if (!container) return; let controller = instances.get(container); if (!controller) { controller = createController(container); instances.set(container, controller); } void controller.open(context); return controller; }, disposeWithin(parent) { if (!parent) return; for (const container of parent.querySelectorAll("[data-company-integrated]")) instances.get(container)?.dispose(); } };
  root.CompanyIntegrated = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window === "undefined" ? globalThis : window);
