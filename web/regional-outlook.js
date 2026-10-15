(function (root) {
  "use strict";
  const ENDPOINT = "/api/regional-outlook";
  const active = job => ["queued", "running"].includes(job?.status);
  const escapeHtml = value => String(value ?? "").replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character]));
  const numeric = value => typeof value === "number" && Number.isFinite(value);
  const number = value => numeric(value) ? value.toLocaleString("ko-KR", { maximumFractionDigits: 2 }) : "—";
  const currentMonth = (value = Date.now()) => new Date(Number(value) + 9 * 3600000).toISOString().slice(0, 7);
  function timeLabel(value) {
    return value && Number.isFinite(Date.parse(value)) ? `${new Date(Date.parse(value) + 9 * 3600000).toISOString().slice(0, 16).replace("T", " ")} KST` : "저장 전";
  }
  const monthLabel = period => /^\d{4}-\d{2}$/.test(period || "") ? `${period.slice(0, 4)}년 ${Number(period.slice(5))}월` : "기간 미확인";
  const codeLabel = value => ({ STALE_SOURCE: "최근 자료가 오래되어 전망 보류", INSUFFICIENT_HISTORY: "비교할 월별 자료 부족", NO_DATA: "확보 자료 없음", NO_OBSERVATIONS: "정상 관측 자료 없음", RECENT_OBSERVATIONS_MISSING: "최근 연속 관측 자료 부족", MISSING_BASELINE: "비교 기준 자료 없음", NO_VALIDATION: "검증 자료 부족", INSUFFICIENT_VALIDATION: "검증 자료 부족", VALIDATION_FAILED: "예측 검증 기준 미충족", ZERO_BASELINE: "비교 기준이 0", HOLIDAY_DATA_MISSING: "공휴일 자료 미확인", HOLIDAY_COVERAGE_MISSING: "공휴일 자료 미확인", HOLIDAY_CALENDAR_UNAVAILABLE: "공휴일 자료 미확인", HOLIDAY_HISTORY_INSUFFICIENT: "연휴 영향을 검증할 이력 부족", HOLIDAY_EFFECT_NOT_VALIDATED: "연휴 영향의 검증 기준 미충족", HOLIDAY_CONTEXT_ONLY: "연휴 일정 참고", HOLIDAY_SEASONAL_BASELINE_REQUIRED: "전년 같은 달 비교 자료 필요", FORECAST_UNAVAILABLE: "전망 산출 자료 부족", UNIDENTIFIABLE_HOLIDAY_EFFECT: "연휴 영향 분리 어려움", INSUFFICIENT_HOLIDAY_VARIATION: "연휴 차이를 비교할 자료 부족", MISSING_TARGET_CALENDAR: "대상월 공휴일 자료 미확인", MISSING_HISTORY_CALENDAR: "과거 공휴일 자료 미확인", SAME_BATCH_REQUIRED: "같은 조회기간의 검색자료 필요" })[value] || (value ? "산출 근거 확인 필요" : "자료 부족으로 전망 보류");
  const methodLabel = method => ({ seasonal_naive: "전년 같은 달 기준", recent_level: "최근 관측 수준", recent_trend: "최근 추세", seasonal_holiday: "연휴 반영", official_observation: "공식 관측" })[method] || "";
  const forecastKnown = item => ["forecast", "observed"].includes(item?.status) && numeric(item?.value);
  function forecastHtml(item, unit = "") {
    if (!forecastKnown(item)) return `<span class="ro-unavailable">—</span><small>${escapeHtml(codeLabel(item?.reasonCode))}</small>`;
    return `<strong>${number(item.value)}<span>${escapeHtml(unit)}</span></strong><small>${item.status === "observed" ? "확정 자료" : "예상값"}</small>`;
  }
  function validationHtml(item, unit = "") {
    const validation = item?.validation;
    if (item?.status === "observed") return '<span class="ro-muted">공식 관측 자료 · 예측 검증 대상 아님</span>';
    if (!validation || !numeric(validation.mae) || !(validation.folds > 0)) return '<span class="ro-muted">검증 자료 부족</span>';
    return `<span>과거 자료 모의검증 ${number(validation.folds)}회 · 평균 오차 ${number(validation.mae)}${escapeHtml(unit)}${numeric(validation.wapePct) ? ` · 가중 절대오차 ${number(validation.wapePct)}%` : ""}${validation.status !== "validated" ? " · 검증 이력 부족" : ""}</span>`;
  }
  function holidayAdjustmentHtml(item, unit = "") {
    const holiday = item?.holiday;
    if (item?.status === "observed") return '<span class="ro-muted">공식값 사용 · 연휴 보정 없음</span>';
    if (holiday?.adjustmentApplied === true && numeric(holiday.adjustment)) return `<span class="ro-holiday-applied">연휴 영향 ${holiday.adjustment >= 0 ? "+" : ""}${number(holiday.adjustment)}${escapeHtml(unit)} 반영</span>`;
    return `<span class="ro-muted">연휴 영향 반영 보류${holiday?.reasonCode ? ` · ${escapeHtml(codeLabel(holiday.reasonCode))}` : " · 영향 계수 적용 안 함"}</span>`;
  }
  function calendarHtml(calendar, period) {
    if (!calendar) return '<p class="ro-muted">공휴일 자료 미확인 · 없는 자료를 휴일 0일로 계산하지 않습니다.</p>';
    const runs = Array.isArray(calendar.holidayRuns) ? calendar.holidayRuns : Array.isArray(calendar.runs) ? calendar.runs : Array.isArray(calendar.longBreaks) ? calendar.longBreaks : [];
    const coverage = calendar.coverage || {};
    const confirmed = calendar.status === "ready" || calendar.status === "complete" || calendar.status === "observed" || calendar.coverageComplete === true || coverage.complete === true;
    const holidays = calendar.publicHolidayDays ?? calendar.holidayDays ?? calendar.publicHolidays;
    const weekend = calendar.weekendDays;
    const longest = calendar.longestRunDays ?? calendar.longestRun;
    const bridges = Array.isArray(calendar.bridgeCandidateDates) ? calendar.bridgeCandidateDates : [];
    return `<details class="ro-calendar"><summary>연휴·주말 일정 <span class="ro-pill${confirmed ? "" : " is-warning"}">${confirmed ? "공휴일 자료 확인" : "공휴일 자료 일부·미확인"}</span></summary><div class="ro-calendar-body"><dl class="ro-calendar-counts"><div><dt>주말</dt><dd>${numeric(weekend) ? `${number(weekend)}일` : "—"}</dd></div><div><dt>공휴일</dt><dd>${numeric(holidays) ? `${number(holidays)}일` : "미확인"}</dd></div><div><dt>최장 연속 휴일</dt><dd>${numeric(longest) ? `${number(longest)}일` : "미확인"}</dd></div></dl>${!confirmed ? '<p class="ro-warning">공휴일 자료가 완전히 확보되지 않았습니다. 주말 정보와 구별해 표시합니다.</p>' : ""}${calendar.stale ? '<p class="ro-warning">이전에 저장한 공휴일 자료입니다. 최근 변경이 반영되지 않았을 수 있습니다.</p>' : ""}${runs.length ? `<ul class="ro-holiday-runs">${runs.map(run => `<li><strong>${escapeHtml(run.startDate || run.start || "")} ~ ${escapeHtml(run.endDate || run.end || "")}</strong><span>${numeric(run.days ?? run.length) ? `${number(run.days ?? run.length)}일` : "기간 확인"}${Array.isArray(run.names) && run.names.length ? ` · ${escapeHtml(run.names.join(", "))}` : ""}${run.boundaryComplete === false ? " · 전후 날짜 일부 미확인" : ""}</span></li>`).join("")}</ul>` : `<p class="ro-muted">${escapeHtml(monthLabel(period))}의 연속 휴일 목록이 없습니다.${confirmed ? "" : " 공휴일 자료를 확인해 주세요."}</p>`}${bridges.length ? `<p class="ro-muted">징검다리 평일 후보: ${escapeHtml(bridges.join(", "))} · 공식 휴일이 아닙니다.</p>` : ""}</div></details>`;
  }
  function targetHtml(target, metrics) {
    const items = metrics.map(metric => ({ metric, forecast: (metric.forecasts || []).find(item => item.period === target.period) }));
    const prepared = items.filter(item => forecastKnown(item.forecast)).length;
    const metricKey = metric => metric.metricKey || String(metric.key || "").split(":").at(-1);
    // Keep one visitor measure, two distinct operating indices and search
    // interest visible even when source metrics arrive in another order.
    const featured = [
      items.find(item => item.metric.groupKey === "visitors" && metricKey(item.metric) === "averageDailyVisitors") || items.find(item => item.metric.groupKey === "visitors"),
      items.find(item => item.metric.groupKey === "demandStrength" && metricKey(item.metric) === "stayOverall"),
      items.find(item => item.metric.groupKey === "demandStrength" && metricKey(item.metric) === "spendOverall"),
      items.find(item => ["searchTrend", "searchTrends", "search"].includes(item.metric.groupKey) && metricKey(item.metric) === "interest") || items.find(item => ["searchTrend", "searchTrends", "search"].includes(item.metric.groupKey))
    ].filter(Boolean);
    const shown = featured.length ? featured : items.slice(0, 4);
    return `<article class="ro-target is-${target.kind === "next" ? "next" : "current"}"><header><span>${escapeHtml(target.label || (target.kind === "next" ? "다음 달 전망" : "이번 달 예상"))}</span><h4>${escapeHtml(monthLabel(target.period))}</h4><small>${prepared}/${items.length}개 지표 산출</small></header><dl class="ro-target-values">${shown.map(({ metric, forecast }) => `<div><dt>${escapeHtml(metric.label || metric.key)}</dt><dd>${forecastHtml(forecast, metric.unit)}</dd></div>`).join("")}</dl>${calendarHtml(target.calendar, target.period)}</article>`;
  }
  function metricHtml(metric, targets) {
    const forecasts = targets.map(target => ({ target, item: (metric.forecasts || []).find(item => item.period === target.period) }));
    return `<details class="ro-metric"><summary><span><strong>${escapeHtml(metric.label || metric.key)}</strong><small>최근 확정 ${escapeHtml(metric.latestPeriod || "미확인")} · ${number(metric.availableMonths)}개월 확보</small></span><span class="ro-latest">${number(metric.latestValue)}<small>${escapeHtml(metric.unit || "")}</small></span></summary><div class="ro-metric-body"><div class="ro-forecast-grid">${forecasts.map(({ target, item }) => `<div class="ro-forecast-cell"><span>${escapeHtml(target.label || monthLabel(target.period))} · ${escapeHtml(target.period)}</span><div class="ro-forecast-value">${forecastHtml(item, metric.unit)}</div>${methodLabel(item?.method) ? `<span class="ro-muted">산출 방법 · ${escapeHtml(methodLabel(item.method))}</span>` : ""}${validationHtml(item, metric.unit)}${holidayAdjustmentHtml(item, metric.unit)}</div>`).join("")}</div><p class="ro-muted">제공처 ${escapeHtml(metric.provider || "미확인")}${metric.normalizationPeriod ? ` · 검색지수 기준 ${escapeHtml(typeof metric.normalizationPeriod === "object" ? [metric.normalizationPeriod.startDate, metric.normalizationPeriod.endDate].filter(Boolean).join(" ~ ") : metric.normalizationPeriod)}` : ""}</p></div></details>`;
  }
  function groupHtml(group, targets, openGroups) {
    const prepared = group.metrics.filter(metric => (metric.forecasts || []).some(forecastKnown)).length;
    return `<details class="ro-group" data-ro-group="${escapeHtml(group.key)}"${openGroups?.has(group.key) ? " open" : ""}><summary><strong>${escapeHtml(group.label)}</strong><span>${prepared}/${group.metrics.length}개 지표 산출</span></summary><div class="ro-group-body">${group.metrics.map(metric => metricHtml(metric, targets)).join("")}</div></details>`;
  }
  function refreshDiagnosticsHtml(job) {
    const diagnostics = job?.refreshDiagnostics;
    if (!diagnostics || diagnostics.status !== "partial") return "";
    const labels = { visitors: "지역 방문자", demandStrength: "체류·소비 지수", resourceDemand: "관광자원 수요 지수", diversity: "관광 다양성 지수", searchTrend: "검색 트렌드", kosis: "인구·산업 통계", holiday: "공휴일 자료", specialDays: "공휴일 자료" };
    const steps = [...(Array.isArray(diagnostics.steps) ? diagnostics.steps : []), ...(Array.isArray(diagnostics.calendars) ? diagnostics.calendars.map(row => ({ ...row, key: "holiday", label: `공휴일 자료${Number.isInteger(row.year) ? ` · ${row.year}년` : ""}` })) : [])].filter(row => ["failed", "error", "partial", "interrupted", "missing", "blocked", "stale", "publication_pending"].includes(row.status) || row.errorCode);
    const safeCode = value => /^[A-Z0-9_.:-]{1,100}$/.test(value || "") ? value : "SOURCE_REFRESH_INCOMPLETE";
    return `<div class="ro-refresh-warning"><p class="ro-warning">일부 자료 갱신을 완료하지 못했습니다. 저장된 자료로 계산했습니다.</p>${steps.length ? `<details><summary>갱신하지 못한 자료 확인</summary><ul>${steps.map(row => `<li>${escapeHtml(row.label || labels[row.key] || "지역 자료")} · ${escapeHtml(safeCode(row.errorCode))}</li>`).join("")}</ul></details>` : ""}</div>`;
  }
  const validMonth = value => /^20\d{2}-(0[1-9]|1[0-2])$/.test(value || "");
  const evaluationStatus = status => ({ compared: "비교 완료", pending: "공식자료 대기", excluded: "비교 제외" })[status] || "검증 상태 확인 필요";
  const evaluationReason = code => ({ TARGET_MONTH_OPEN: "대상월이 아직 끝나지 않았습니다.", OFFICIAL_OBSERVATION_NOT_AVAILABLE: "후속 공식 관측자료가 아직 없습니다.", OFFICIAL_PUBLICATION_PENDING: "공식자료 공표를 기다리고 있습니다.", ACTUAL_OBSERVATION_PARTIAL: "공식 관측자료가 일부만 확보됐습니다.", ACTUAL_OBSERVATION_ERROR: "공식 관측자료 확인이 실패해 검증을 기다립니다.", ACTUAL_OBSERVATION_MISSING: "공식 관측자료가 누락돼 검증을 기다립니다.", STALE_ACTUAL_OBSERVATION: "이전 공식자료를 사용 중이어서 검증을 기다립니다.", SEARCH_NORMALIZATION_NOT_COMPARABLE: "검색어·조회기간의 정규화 기준이 달라 검색지수를 비교할 수 없습니다.", UNSUPPORTED_SEARCH_NORMALIZATION: "검색지수 정규화 기준을 확인할 수 없습니다.", PUBLICATION_NOT_PROVEN: "당시 발행을 확인할 보존 기록이 없습니다.", FORECAST_NOT_AVAILABLE_AS_OF: "검증 기준시점 뒤에 생성·발행된 전망입니다.", ISSUE_TIME_MISMATCH: "발행 기준월과 생성·발행시각이 맞지 않습니다.", TARGET_KIND_MISMATCH: "당시 이번 달·다음 달과 대상월이 맞지 않습니다.", INPUT_PERIOD_NOT_VERIFIABLE: "당시 사용한 자료의 기준기간을 검증할 수 없습니다.", INPUT_REGION_MISMATCH: "당시 사용한 자료의 지역이 다릅니다.", INPUT_RECEIVED_AFTER_PUBLICATION: "발행 이후 받은 자료가 포함돼 비교에서 제외합니다.", ALREADY_OBSERVED_AT_ISSUE: "발행 당시 이미 공식값이어서 예측 검증 대상이 아닙니다.", FORECAST_NOT_PRODUCED: "당시 산출된 전망값이 없습니다.", INVALID_FORECAST_VALUE: "당시 전망값이 유효하지 않습니다.", PUBLISHED_AFTER_TARGET_CLOSED: "대상월이 끝난 뒤 발행된 전망입니다.", UNSUPPORTED_FORECAST_METADATA: "당시 전망의 지표·발행 조건을 확인할 수 없습니다.", UNSUPPORTED_FORECAST_UNIT: "당시 전망의 단위가 검증 기준과 다릅니다.", UNSUPPORTED_ACTUAL_TIMESTAMP: "공식자료 확인시각을 검증할 수 없습니다.", DUPLICATE_ACTUAL_OBSERVATION: "같은 월에 공식 관측자료가 중복돼 있습니다.", ACTUAL_SCOPE_PERIOD_MISMATCH: "공식 관측자료의 기준기간이 다릅니다.", UNSUPPORTED_ACTUAL_METADATA: "공식 관측자료의 지표 조건을 확인할 수 없습니다.", PROVIDER_MISMATCH: "전망과 공식 관측자료의 제공기관이 다릅니다.", UNIT_MISMATCH: "전망과 공식 관측자료의 단위가 다릅니다.", UNSUPPORTED_ACTUAL_PERIOD_TYPE: "월간 지표끼리 비교할 수 있는 자료가 아닙니다.", ACTUAL_RECEIVED_BEFORE_MONTH_CLOSED: "대상월 마감 전 자료여서 공식값으로 비교하지 않습니다.", INVALID_ACTUAL_VALUE: "공식 관측값이 유효하지 않습니다.", CONFLICTING_ACTUAL_OBSERVATIONS: "같은 시점의 공식 관측값이 서로 다릅니다.", DUPLICATE_FORECAST_OBSERVATION: "같은 지표·대상월의 전망이 중복돼 있습니다.", CONFLICTING_FORECAST_REFERENCE: "같은 전망 발행 번호에 다른 값이 보존돼 있습니다.", ZERO_ACTUAL_DENOMINATOR: "실제값이 0이므로 오차율을 계산하지 않습니다." })[code] || "비교 조건이나 자료를 확인해야 합니다.";
  function evaluationModel(state) {
    const snapshot = state.validation?.snapshot;
    const rows = Array.isArray(snapshot?.rows) ? snapshot.rows : [];
    const months = [...new Set([...(Array.isArray(snapshot?.availableIssueMonths) ? snapshot.availableIssueMonths : []), ...rows.map(row => row.issueMonth)].filter(validMonth))].sort().reverse();
    const selected = months.includes(state.validationIssueMonth) ? state.validationIssueMonth : months[0] || "";
    const selectedRows = rows.filter(row => row.issueMonth === selected);
    const counts = { compared: 0, pending: 0, excluded: 0 };
    for (const row of selectedRows) if (Object.hasOwn(counts, row.status)) counts[row.status]++;
    return { snapshot, rows: selectedRows, months, selected, counts };
  }
  const signedNumber = value => numeric(value) ? `${value > 0 ? "+" : ""}${number(value)}` : "—";
  function evaluationRowHtml(row) {
    const compared = row.status === "compared" && numeric(row.forecastValue) && numeric(row.actualValue);
    const kind = row.kind === "current" ? "당시 이번 달 예상" : row.kind === "next" ? "당시 다음 달 전망" : "예상기간 미확인";
    const value = value => numeric(value) ? `${number(value)}<small>${escapeHtml(row.unit || "")}</small>` : "미확인";
    const prediction = row.predictionRef || {}, actual = row.actualRef || {};
    return `<article class="ro-evaluation-row is-${escapeHtml(["compared", "pending", "excluded"].includes(row.status) ? row.status : "unknown")}"><header><div><strong>${escapeHtml(row.label || row.metricKey || "지표 미확인")}</strong><small>${escapeHtml(row.targetPeriod || "대상월 미확인")} · ${kind}</small></div><span class="ro-evaluation-badge">${escapeHtml(evaluationStatus(row.status))}</span></header><dl class="ro-evaluation-values"><div><dt>당시 전망</dt><dd>${row.status === "excluded" ? "비교 제외" : value(row.forecastValue)}</dd></div><div><dt>후속 공식값</dt><dd>${compared ? value(row.actualValue) : "미확인"}</dd></div>${compared ? `<div><dt>차이 · 실제−전망</dt><dd>${numeric(row.difference) ? `${signedNumber(row.difference)}<small>${escapeHtml(row.unit || "")}</small>` : "미확인"}</dd></div><div><dt>절대오차</dt><dd>${value(row.absoluteError)}</dd></div><div><dt>절대오차율</dt><dd>${row.actualValue === 0 ? '<span class="ro-muted">산출 안 함 · 실제값 0</span>' : numeric(row.errorPct) && row.errorPct >= 0 ? `${number(row.errorPct)}<small>%</small>` : "미확인"}</dd></div>` : ""}</dl>${!compared ? `<p class="ro-muted">${escapeHtml(evaluationReason(row.reasonCode))}</p>` : ""}<details class="ro-evaluation-evidence"><summary>발행·공식자료 근거</summary><dl><div><dt>전망 발행</dt><dd>${prediction.publishedAt ? escapeHtml(timeLabel(prediction.publishedAt)) : "발행시각 미확인"}</dd></div><div><dt>전망 생성</dt><dd>${prediction.generatedAt ? escapeHtml(timeLabel(prediction.generatedAt)) : "생성시각 미확인"}</dd></div><div><dt>발행 기록</dt><dd>${prediction.coverage === "legacy_reference" ? "기존에 보존된 참조" : prediction.proof === "journal" ? "발행 기록 보존" : "보존 근거 확인 필요"}</dd></div><div><dt>제공기관 · 모델</dt><dd>${escapeHtml(row.provider || "미확인")} · ${escapeHtml(row.modelVersion || "미확인")}</dd></div>${compared ? `<div><dt>공식값 확인</dt><dd>${actual.receivedAt ? escapeHtml(timeLabel(actual.receivedAt)) : "확인시각 미확인"}${actual.receiptEvidence === "snapshot_timestamp" ? " · 저장 결과 확인시각 기준" : ""}</dd></div>` : ""}${prediction.resultId ? `<div><dt>당시 전망 번호</dt><dd>${escapeHtml(prediction.resultId)}</dd></div>` : ""}</dl></details></article>`;
  }
  function evaluationScoresHtml(snapshot, open) {
    const scores = (Array.isArray(snapshot?.scores) ? snapshot.scores : []).filter(score => Number.isInteger(score.sampleCount) && score.sampleCount > 0 && numeric(score.mae));
    if (!scores.length) return "";
    return `<details class="ro-evaluation-scores" data-ro-detail="scores"${open ? " open" : ""}><summary>지표별 누적 오차 · 전체 보존 발행월</summary><p class="ro-muted">같은 지표·단위·제공기관·예상기간·모델끼리 계산합니다. 표본이 적으면 결과를 일반화할 수 없습니다.</p><ul>${scores.map(score => `<li><strong>${escapeHtml(score.label || score.metricKey)}</strong><span>${score.kind === "next" ? "다음 달 전망" : "이번 달 예상"} · ${number(score.sampleCount)}건 표본</span><span>평균 절대오차 ${number(score.mae)}${escapeHtml(score.unit || "")}${numeric(score.wapePct) ? ` · 가중 절대오차 ${number(score.wapePct)}%` : " · 가중 절대오차율 산출 안 함"}</span><small>${escapeHtml(score.provider || "미확인")} · ${escapeHtml(score.modelVersion || "미확인")}</small></li>`).join("")}</ul></details>`;
  }
  function evaluationHtml(state) {
    const { snapshot, rows, months, selected, counts } = evaluationModel(state);
    const waitingPublication = state.validation?.publicationPending === true;
    const busy = state.loading || state.starting || state.validationStarting || active(state.job) || active(state.validation?.job) || waitingPublication;
    const failed = ["failed", "interrupted"].includes(state.validation?.job?.status);
    const issue = state.validationError || (state.validation?.storage?.errorCode ? "검증 결과 저장 상태를 확인해야 합니다." : "");
    return `<details class="ro-evaluation" data-ro-detail="validation"${state.validationOpen ? " open" : ""}><summary><strong>지난 전망 검증</strong><span>${active(state.validation?.job) || state.validationStarting || waitingPublication ? "저장자료 검증 중" : selected ? `${escapeHtml(selected)} 발행 · 비교 완료 ${counts.compared} · 대기 ${counts.pending} · 제외 ${counts.excluded}` : snapshot ? "비교 완료 0 · 공식자료 대기" : "공식 실측 발표 후 검증합니다"}</span></summary><div class="ro-evaluation-body"><div class="ro-evaluation-toolbar">${months.length ? `<label>발행 기준월<select data-ro-field="issueMonth" aria-label="검증할 전망의 발행 기준월">${months.map(month => `<option value="${escapeHtml(month)}"${month === selected ? " selected" : ""}>${escapeHtml(monthLabel(month))}</option>`).join("")}</select></label>` : ""}<button type="button" data-ro-action="validate"${busy || state.needsStatusCheck || state.validationNeedsStatusCheck || !state.regionKey ? " disabled" : ""}>${state.validationStarting ? "접수 중…" : "저장자료로 검증"}</button></div><p class="ro-muted">보존된 발행본 중 첫 전망을 후속 공식 관측값과 비교합니다. 과거 자료 모의검증과 별도이며, 외부 자료를 새로 요청하지 않습니다.</p><div class="ro-evaluation-status" role="status" aria-live="polite">${issue ? `<p class="ro-warning">${escapeHtml(issue)}${snapshot ? " 마지막 정상 검증 결과를 표시합니다." : ""}</p>` : ""}${failed ? '<p class="ro-warning">최근 검증 계산을 완료하지 못했습니다. 이전 정상 결과는 유지합니다.</p>' : ""}${state.validationMessage ? `<p>${escapeHtml(state.validationMessage)}</p>` : ""}${active(state.validation?.job) || waitingPublication ? `<p class="ro-working"><span aria-hidden="true"></span>${waitingPublication ? "전망 발행 기록과 검증 접수 상태를 확인하고 있습니다." : "서버에서 저장자료를 비교하고 검증 결과를 저장하고 있습니다."}</p>` : ""}${snapshot ? `<p>검증 기준 ${escapeHtml(timeLabel(snapshot.evaluatedThrough))} · 결과 저장 ${escapeHtml(timeLabel(snapshot.generatedAt))}</p>` : '<p>공식 실측 발표 후 검증합니다. 보존된 전망과 후속 공식자료가 확보되면 저장자료로 검증할 수 있습니다.</p>'}</div>${rows.length ? `<p class="ro-evaluation-counts">선택 발행월 · 비교 완료 <b>${counts.compared}</b> · 공식자료 대기 <b>${counts.pending}</b> · 비교 제외 <b>${counts.excluded}</b></p><div class="ro-evaluation-rows">${rows.map(evaluationRowHtml).join("")}</div>` : snapshot ? '<p class="ro-muted">선택한 발행월의 검증 대상이 없습니다. 당시 발행된 전망을 보존한 이후부터 비교할 수 있습니다.</p>' : ""}${evaluationScoresHtml(snapshot, state.validationScoresOpen)}${snapshot?.resultId ? `<small class="ro-evaluation-id">검증 결과 번호 ${escapeHtml(snapshot.resultId)}</small>` : ""}</div></details>`;
  }
  function renderCard(state) {
    const snapshot = state.snapshot, metrics = Array.isArray(snapshot?.metrics) ? snapshot.metrics : [], targets = Array.isArray(snapshot?.targets) ? snapshot.targets : [];
    const groups = [];
    for (const metric of metrics) { const key = metric.groupKey || "other"; let group = groups.find(item => item.key === key); if (!group) { group = { key, label: metric.groupLabel || "기타 지표", metrics: [] }; groups.push(group); } group.metrics.push(metric); }
    const busy = state.loading || state.starting || state.validationStarting || active(state.job) || active(state.validation?.job) || state.validation?.publicationPending === true, message = state.error || (state.storageError ? "저장 결과 확인이 필요합니다." : "");
    const stale = snapshot?.asOfMonth && state.targetMonth && snapshot.asOfMonth !== state.targetMonth;
    return `<section class="regional-outlook" aria-label="이번 달 예상과 다음 달 전망"><header class="ro-header"><div><span class="ro-eyebrow">저장된 지역 전망</span><h3>${escapeHtml(state.regionLabel || "지역 미선택")}</h3><p>이번 달 예상·다음 달 전망 · 지표별 최근 확보 자료와 연휴 일정</p></div><div class="ro-actions"><button type="button" data-ro-action="status"${state.loading || state.starting || state.validationStarting || !state.regionKey ? " disabled" : ""}>${state.loading ? "확인 중…" : "상태 확인"}</button><button type="button" class="ro-primary" data-ro-action="build"${busy || state.needsStatusCheck || state.validationNeedsStatusCheck || !state.regionKey ? " disabled" : ""}>${state.starting ? "접수 중…" : "저장자료로 계산"}</button><button type="button" class="ro-primary" data-ro-action="refresh"${busy || state.needsStatusCheck || state.validationNeedsStatusCheck || !state.regionKey ? " disabled" : ""}>자료 갱신 후 계산</button></div></header><div class="ro-status" role="status" aria-live="polite">${message ? `<p class="ro-warning">${escapeHtml(message)}${snapshot ? " 마지막 정상 저장 결과를 표시합니다." : ""}</p>` : ""}${stale ? `<p class="ro-warning">이전 기준월 ${escapeHtml(snapshot.asOfMonth)}의 전망입니다. 현재 기준월 자료는 다시 계산해 주세요.</p>` : ""}${snapshot ? `<p>자료 기준 ${escapeHtml(snapshot.asOfDate || snapshot.asOfMonth || "미확인")} · 결과 저장 <time datetime="${escapeHtml(snapshot.generatedAt || "")}">${escapeHtml(timeLabel(snapshot.generatedAt))}</time>${state.loading ? " · 변경 여부 확인 중" : ""}</p>` : `<p>${!state.regionKey ? "분석할 지역을 선택해 주세요." : state.loading ? "저장된 전망을 확인하고 있습니다." : "저장된 전망이 없습니다. 확보된 지역자료로 전망을 계산해 주세요."}</p>`}${state.message ? `<p>${escapeHtml(state.message)}</p>` : ""}${active(state.job) ? '<p class="ro-working"><span aria-hidden="true"></span>서버에서 전망을 계산하고 저장하고 있습니다.</p>' : state.job?.status === "failed" || state.job?.status === "interrupted" ? '<p class="ro-warning">최근 전망 계산을 완료하지 못했습니다. 이전 결과가 있으면 그대로 유지합니다.</p>' : ""}</div>${refreshDiagnosticsHtml(state.job)}${targets.length ? `<div class="ro-targets">${targets.map(target => targetHtml(target, metrics)).join("")}</div>` : ""}${evaluationHtml(state)}${groups.length ? `<div class="ro-groups">${groups.map(group => groupHtml(group, targets, state.openGroups)).join("")}</div>` : ""}<details class="ro-method"><summary>예상·전망 산출 기준</summary><p>화면은 저장된 산출값을 재사용합니다. ‘저장자료로 계산’은 확보된 자료만 사용합니다. ‘자료 갱신 후 계산’은 필요한 지역지표·공휴일 자료를 확인한 뒤 전망을 저장합니다. 자동 갱신 설정은 지역 자료 관리에서 진행합니다.</p><p>확정 자료와 예상값을 구별합니다. 정상 응답의 0은 유효한 값이며 오류·누락은 0으로 바꾸지 않습니다. 자료가 부족하거나 오래된 지표는 전망을 보류합니다.</p><p>과거 자료 모의검증의 평균 오차는 과거 자료를 가려 예측한 뒤 실제 값과 비교한 결과입니다. 실제 발행 전망의 사후 검증은 지난 전망 검증에서 구분해 확인합니다. 미래 오차를 보장하는 범위가 아닙니다. 연휴 영향은 비교 근거가 확보된 지표에만 적용합니다.</p><p>네이버 검색지수는 같은 검색어·같은 조회기간 안의 상대 관심도입니다. 조회기간이 다른 지수를 직접 합산하거나 비교하지 않습니다. 관광 지표의 전망은 숙박 예약률이나 매출 예상과 다릅니다.</p>${Array.isArray(snapshot?.notes) ? snapshot.notes.slice(0, 12).map(note => `<p>${escapeHtml(typeof note === "string" ? note : note.label || note.message || "")}</p>`).join("") : ""}${snapshot?.resultId ? `<small>결과 번호 ${escapeHtml(snapshot.resultId)}</small>` : ""}</details></section>`;
  }
  async function defaultFetch(url, options = {}) {
    const response = await root.fetch(url, { credentials: "same-origin", ...options }), body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || "지역 전망을 확인하지 못했습니다.");
    return body;
  }
  function createCache({ now = () => Date.now(), ttl = 60000, maxEntries = 80 } = {}) {
    const entries = new Map(), flights = new Map(); let generation = 0;
    function remember(key, data) { entries.delete(key); entries.set(key, { data, at: now() }); while (entries.size > maxEntries) entries.delete(entries.keys().next().value); }
    return { read(key) { return entries.get(key)?.data || null; }, fresh(key) { const item = entries.get(key); return Boolean(item && now() - item.at < ttl); },
      async get(key, fetcher, force = false) { if (flights.has(key)) return flights.get(key); if (!force && this.fresh(key)) return this.read(key); const token = generation; const promise = Promise.resolve().then(fetcher).then(data => { if (token === generation) remember(key, data); return data; }).finally(() => { if (flights.get(key) === promise) flights.delete(key); }); flights.set(key, promise); return promise; },
      set: remember, invalidate(key) { const item = entries.get(key); if (item) item.at = -Infinity; }, clear() { generation++; entries.clear(); flights.clear(); } };
  }
  const sharedCache = createCache();
  function createController({ cache = sharedCache, fetchJson = defaultFetch, schedule = (fn, ms) => root.setTimeout(fn, ms), cancel = id => root.clearTimeout(id), isVisible = () => true, now = () => Date.now() } = {}) {
    const state = { regionKey: "", regionLabel: "", accountKey: "", targetMonth: "", snapshot: null, job: null, validation: null, validationIssueMonth: "", validationOpen: false, validationScoresOpen: false, validationStarting: false, validationNeedsStatusCheck: false, validationError: "", validationMessage: "", loading: false, starting: false, needsStatusCheck: false, error: "", storageError: "", message: "", openGroups: new Set() };
    let host = null, revision = 0, timer = null, paused = true, contextVisible = () => true; const bound = new WeakSet();
    const visible = () => !paused && host?.isConnected !== false && !root.document?.hidden && isVisible() && contextVisible();
    const cacheKey = () => `${state.accountKey}\u0000${state.regionKey}\u0000${state.targetMonth}\u000013`;
    function clearTimer() { if (timer !== null) cancel(timer); timer = null; }
    function render() { if (host) host.innerHTML = renderCard(state); }
    function checkValidation(validation) {
      if (!validation || typeof validation !== "object" || !Object.hasOwn(validation, "snapshot")) throw new Error("저장 검증 응답을 확인하지 못했습니다.");
      for (const scope of [validation.scope, validation.snapshot?.scope, validation.job?.scope]) {
        if (scope?.regionKey && scope.regionKey !== state.regionKey) throw new Error("선택 지역과 다른 전망 검증 자료입니다.");
        if (scope?.month && scope.month !== state.targetMonth) throw new Error("선택 기준월과 다른 전망 검증 자료입니다.");
      }
      if (validation.job?.regionKey && validation.job.regionKey !== state.regionKey || (validation.snapshot?.rows || []).some(row => row.regionKey && row.regionKey !== state.regionKey)) throw new Error("선택 지역과 다른 전망 검증 자료입니다.");
      return validation;
    }
    function accept(result) {
      if (!result || !Object.hasOwn(result, "snapshot")) throw new Error("저장 전망 응답을 확인하지 못했습니다.");
      const regionKey = result.snapshot?.scope?.regionKey || result.snapshot?.regionKey || result.scope?.regionKey;
      if (regionKey && regionKey !== state.regionKey) throw new Error("선택 지역과 다른 전망 자료입니다.");
      const jobKey = result.job?.scope?.regionKey || result.job?.regionKey;
      if (jobKey && jobKey !== state.regionKey) throw new Error("선택 지역과 다른 계산 작업입니다.");
      const month = result.scope?.month || result.scope?.currentMonth || result.snapshot?.asOfMonth;
      if (month && month !== state.targetMonth) throw new Error("선택 기준월과 다른 전망 자료입니다.");
      const validation = Object.hasOwn(result, "validation") ? checkValidation(result.validation) : undefined;
      state.snapshot = result.snapshot || null; state.job = result.job || null; state.storageError = result.storage?.errorCode || ""; state.needsStatusCheck = false;
      if (validation !== undefined) { state.validation = validation; state.validationNeedsStatusCheck = false; state.validationError = ""; }
    }
    const jobActive = () => active(state.job) || active(state.validation?.job) || state.validation?.publicationPending === true;
    function poll() { clearTimer(); if (jobActive() && visible()) timer = schedule(() => { timer = null; if (visible()) void refresh(true); }, 3000); }
    async function refresh(force = false) {
      if (!state.regionKey || !visible() || state.loading || state.starting || state.validationStarting) return false;
      clearTimer(); const token = revision, key = cacheKey(), url = `${ENDPOINT}?regionKey=${encodeURIComponent(state.regionKey)}&months=13`; state.loading = true; state.error = ""; render();
      try { const result = await cache.get(key, () => fetchJson(url), force); if (token !== revision || !visible()) return false; accept(result); return true; }
      catch (error) { cache.invalidate(key); if (token === revision && visible()) state.error = error.message || "저장 전망 확인 실패"; return false; }
      finally { if (token === revision) { state.loading = false; render(); if (!state.error) poll(); } }
    }
    async function start(collectMissing = false) {
      if (!visible() || !state.regionKey || state.loading || state.starting || state.validationStarting || state.needsStatusCheck || state.validationNeedsStatusCheck || jobActive()) return false;
      clearTimer(); const token = ++revision; cache.invalidate(cacheKey()); state.starting = true; state.error = ""; state.message = ""; render();
      try {
        const result = await fetchJson(`${ENDPOINT}/refresh`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ regionKey: state.regionKey, months: 13, collectMissing: collectMissing === true }) });
        if (token !== revision || !visible()) return false;
        if (!result?.job) throw new Error("계산 접수 여부가 불명확합니다.");
        const key = result.job.scope?.regionKey || result.job.regionKey; if (key && key !== state.regionKey) throw new Error("선택 지역과 다른 계산 작업입니다.");
        state.job = result.job; state.message = result.reused ? "진행 중인 계산을 확인합니다." : collectMissing ? "자료 갱신 후 전망 계산을 등록했습니다." : "저장자료를 이용한 전망 계산을 등록했습니다."; return true;
      } catch (error) { if (token === revision && visible()) { state.needsStatusCheck = true; state.error = `${error.message || "계산 접수 확인 실패"} 상태 확인으로 실행 여부를 확인해 주세요.`; } return false; }
      finally { if (token === revision) { state.starting = false; render(); if (!state.error) { if (active(state.job)) poll(); else void refresh(true); } } }
    }
    async function startValidation() {
      if (!visible() || !state.regionKey || state.loading || state.starting || state.validationStarting || state.needsStatusCheck || state.validationNeedsStatusCheck || jobActive()) return false;
      if (state.targetMonth !== currentMonth(now())) { state.validationError = "기준월이 바뀌었습니다. 화면을 다시 연 뒤 검증해 주세요."; render(); return false; }
      clearTimer(); const token = ++revision; cache.invalidate(cacheKey()); state.validationStarting = true; state.validationOpen = true; state.validationError = ""; state.validationMessage = ""; render();
      try {
        const result = await fetchJson(`${ENDPOINT}/validation/refresh`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ regionKey: state.regionKey, months: 13, month: state.targetMonth }) });
        if (token !== revision || !visible()) return false;
        if (!result?.job) throw new Error("검증 접수 여부가 불명확합니다.");
        state.validation = checkValidation(result); state.validationNeedsStatusCheck = false;
        state.validationMessage = result.reused ? "저장된 검증 결과 또는 진행 중인 작업을 확인합니다." : "저장자료로 전망 검증을 등록했습니다.";
        cache.set(cacheKey(), { scope: { regionKey: state.regionKey, month: state.targetMonth, months: 13 }, snapshot: state.snapshot, job: state.job, storage: { errorCode: state.storageError }, validation: state.validation });
        cache.invalidate(cacheKey()); return true;
      } catch (error) { if (token === revision && visible()) { state.validationNeedsStatusCheck = true; state.validationError = `${error.message || "검증 접수 확인 실패"} 상태 확인으로 실행 여부를 확인해 주세요.`; } return false; }
      finally { if (token === revision) { state.validationStarting = false; render(); if (!state.validationError) { if (jobActive()) poll(); else void refresh(true); } } }
    }
    function selectIssueMonth(month) { const model = evaluationModel(state); if (!model.months.includes(month)) return false; state.validationIssueMonth = month; render(); return true; }
    function stop() { clearTimer(); paused = true; revision++; if (state.starting) state.needsStatusCheck = true; if (state.validationStarting) state.validationNeedsStatusCheck = true; state.loading = false; state.starting = false; state.validationStarting = false; }
    function onVisibility() { if (root.document?.hidden) clearTimer(); else if (visible() && jobActive()) void refresh(true); }
    async function mount(element, context = {}) {
      const targetMonth = currentMonth(now()), changed = state.regionKey !== (context.regionKey || "") || state.accountKey !== (context.accountKey || "") || state.targetMonth !== targetMonth;
      const inFlight = !changed && (state.loading || state.starting || state.validationStarting);
      if (changed) { clearTimer(); revision++; Object.assign(state, { snapshot: null, job: null, validation: null, validationIssueMonth: "", validationOpen: false, validationScoresOpen: false, validationStarting: false, validationNeedsStatusCheck: false, validationError: "", validationMessage: "", error: "", storageError: "", message: "", loading: false, starting: false, needsStatusCheck: false, openGroups: new Set() }); }
      Object.assign(state, { regionKey: context.regionKey || "", regionLabel: context.regionLabel || "지역 미선택", accountKey: context.accountKey || "", targetMonth });
      contextVisible = context.isVisible || (() => true); if (context.fetchJson) fetchJson = context.fetchJson; host = element; paused = false;
      if (!bound.has(host)) {
        bound.add(host);
        host.addEventListener("click", event => {
          // Native toggle is queued after click. Remember its next state now so
          // an arriving GET or month-selection render cannot collapse the view.
          const details = event.target.closest?.("summary")?.parentElement;
          if (!event.defaultPrevented && details?.isConnected !== false) {
            if (details?.dataset?.roDetail === "validation") state.validationOpen = !details.open;
            if (details?.dataset?.roDetail === "scores") state.validationScoresOpen = !details.open;
          }
          const button = event.target.closest?.("[data-ro-action]");
          if (!button || button.disabled) return;
          if (button.dataset.roAction === "status") void refresh(true);
          if (button.dataset.roAction === "build") void start(false);
          if (button.dataset.roAction === "refresh") void start(true);
          if (button.dataset.roAction === "validate") void startValidation();
        });
        host.addEventListener("change", event => { if (event.target.dataset?.roField === "issueMonth") selectIssueMonth(event.target.value); });
        host.addEventListener("toggle", event => {
          if (event.target.isConnected === false) return;
          const key = event.target.dataset?.roGroup;
          if (key) { if (event.target.open) state.openGroups.add(key); else state.openGroups.delete(key); }
          if (event.target.dataset?.roDetail === "validation") state.validationOpen = event.target.open;
          if (event.target.dataset?.roDetail === "scores") state.validationScoresOpen = event.target.open;
        }, true);
      }
      const cached = cache.read(cacheKey()); if (cached && !inFlight && !state.needsStatusCheck && !state.validationNeedsStatusCheck && !jobActive()) { try { accept(cached); } catch { cache.invalidate(cacheKey()); } }
      render(); if (!state.regionKey || !visible()) return false; if (inFlight) return true;
      if (!cached || !cache.fresh(cacheKey()) || jobActive() || state.needsStatusCheck || state.validationNeedsStatusCheck) return refresh(jobActive() || state.needsStatusCheck || state.validationNeedsStatusCheck); poll(); return true;
    }
    return { state, mount, refresh, start, startValidation, selectIssueMonth, stop, render, onVisibility };
  }
  const controllers = new Map();
  const exported = { createCache, createController, renderCard, metricHtml, calendarHtml, evaluationHtml, evaluationReason, forecastKnown, number, currentMonth,
    mount(host, context) { if (!host) return false; for (const [element, controller] of controllers) if (element.isConnected === false) { controller.stop(); controllers.delete(element); } let controller = controllers.get(host); if (!controller) { controller = createController(); controllers.set(host, controller); } return controller.mount(host, context); },
    stop(host) { if (host) controllers.get(host)?.stop(); else for (const controller of controllers.values()) controller.stop(); },
    clear() { for (const controller of controllers.values()) controller.stop(); controllers.clear(); sharedCache.clear(); } };
  root.document?.addEventListener?.("visibilitychange", () => { for (const controller of controllers.values()) controller.onVisibility(); });
  root.RegionalOutlook = exported;
  if (typeof module !== "undefined" && module.exports) module.exports = exported;
})(typeof window !== "undefined" ? window : globalThis);
