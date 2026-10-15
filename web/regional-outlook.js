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
    return `<span>과거 ${number(validation.folds)}회 검증 · 평균 오차 ${number(validation.mae)}${escapeHtml(unit)}${numeric(validation.wapePct) ? ` · 가중 절대오차 ${number(validation.wapePct)}%` : ""}${validation.status !== "validated" ? " · 검증 이력 부족" : ""}</span>`;
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
  function renderCard(state) {
    const snapshot = state.snapshot, metrics = Array.isArray(snapshot?.metrics) ? snapshot.metrics : [], targets = Array.isArray(snapshot?.targets) ? snapshot.targets : [];
    const groups = [];
    for (const metric of metrics) { const key = metric.groupKey || "other"; let group = groups.find(item => item.key === key); if (!group) { group = { key, label: metric.groupLabel || "기타 지표", metrics: [] }; groups.push(group); } group.metrics.push(metric); }
    const busy = state.loading || state.starting || active(state.job), message = state.error || (state.storageError ? "저장 결과 확인이 필요합니다." : "");
    const stale = snapshot?.asOfMonth && state.targetMonth && snapshot.asOfMonth !== state.targetMonth;
    return `<section class="regional-outlook" aria-label="이번 달 예상과 다음 달 전망"><header class="ro-header"><div><span class="ro-eyebrow">저장된 지역 전망</span><h3>${escapeHtml(state.regionLabel || "지역 미선택")}</h3><p>이번 달 예상·다음 달 전망 · 지표별 최근 확보 자료와 연휴 일정</p></div><div class="ro-actions"><button type="button" data-ro-action="status"${state.loading || !state.regionKey ? " disabled" : ""}>${state.loading ? "확인 중…" : "상태 확인"}</button><button type="button" class="ro-primary" data-ro-action="build"${busy || state.needsStatusCheck || !state.regionKey ? " disabled" : ""}>${state.starting ? "접수 중…" : "저장자료로 계산"}</button><button type="button" class="ro-primary" data-ro-action="refresh"${busy || state.needsStatusCheck || !state.regionKey ? " disabled" : ""}>자료 갱신 후 계산</button></div></header><div class="ro-status" role="status" aria-live="polite">${message ? `<p class="ro-warning">${escapeHtml(message)}${snapshot ? " 마지막 정상 저장 결과를 표시합니다." : ""}</p>` : ""}${stale ? `<p class="ro-warning">이전 기준월 ${escapeHtml(snapshot.asOfMonth)}의 전망입니다. 현재 기준월 자료는 다시 계산해 주세요.</p>` : ""}${snapshot ? `<p>자료 기준 ${escapeHtml(snapshot.asOfDate || snapshot.asOfMonth || "미확인")} · 결과 저장 <time datetime="${escapeHtml(snapshot.generatedAt || "")}">${escapeHtml(timeLabel(snapshot.generatedAt))}</time>${state.loading ? " · 변경 여부 확인 중" : ""}</p>` : `<p>${!state.regionKey ? "분석할 지역을 선택해 주세요." : state.loading ? "저장된 전망을 확인하고 있습니다." : "저장된 전망이 없습니다. 확보된 지역자료로 전망을 계산해 주세요."}</p>`}${state.message ? `<p>${escapeHtml(state.message)}</p>` : ""}${active(state.job) ? '<p class="ro-working"><span aria-hidden="true"></span>서버에서 전망을 계산하고 저장하고 있습니다.</p>' : state.job?.status === "failed" || state.job?.status === "interrupted" ? '<p class="ro-warning">최근 전망 계산을 완료하지 못했습니다. 이전 결과가 있으면 그대로 유지합니다.</p>' : ""}</div>${refreshDiagnosticsHtml(state.job)}${targets.length ? `<div class="ro-targets">${targets.map(target => targetHtml(target, metrics)).join("")}</div>` : ""}${groups.length ? `<div class="ro-groups">${groups.map(group => groupHtml(group, targets, state.openGroups)).join("")}</div>` : ""}<details class="ro-method"><summary>예상·전망 산출 기준</summary><p>화면은 저장된 산출값을 재사용합니다. ‘저장자료로 계산’은 확보된 자료만 사용합니다. ‘자료 갱신 후 계산’은 필요한 지역지표·공휴일 자료를 확인한 뒤 전망을 저장합니다. 자동 갱신 설정은 지역 자료 관리에서 진행합니다.</p><p>확정 자료와 예상값을 구별합니다. 정상 응답의 0은 유효한 값이며 오류·누락은 0으로 바꾸지 않습니다. 자료가 부족하거나 오래된 지표는 전망을 보류합니다.</p><p>평균 오차는 과거 자료를 가려 예측한 뒤 실제 값과 비교한 결과입니다. 미래 오차를 보장하는 범위가 아닙니다. 연휴 영향은 비교 근거가 확보된 지표에만 적용합니다.</p><p>네이버 검색지수는 같은 검색어·같은 조회기간 안의 상대 관심도입니다. 조회기간이 다른 지수를 직접 합산하거나 비교하지 않습니다. 관광 지표의 전망은 숙박 예약률이나 매출 예상과 다릅니다.</p>${Array.isArray(snapshot?.notes) ? snapshot.notes.slice(0, 12).map(note => `<p>${escapeHtml(typeof note === "string" ? note : note.label || note.message || "")}</p>`).join("") : ""}${snapshot?.resultId ? `<small>결과 번호 ${escapeHtml(snapshot.resultId)}</small>` : ""}</details></section>`;
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
    const state = { regionKey: "", regionLabel: "", accountKey: "", targetMonth: "", snapshot: null, job: null, loading: false, starting: false, needsStatusCheck: false, error: "", storageError: "", message: "", openGroups: new Set() };
    let host = null, revision = 0, timer = null, paused = true, contextVisible = () => true; const bound = new WeakSet();
    const visible = () => !paused && host?.isConnected !== false && !root.document?.hidden && isVisible() && contextVisible();
    const cacheKey = () => `${state.accountKey}\u0000${state.regionKey}\u0000${state.targetMonth}\u000013`;
    function clearTimer() { if (timer !== null) cancel(timer); timer = null; }
    function render() { if (host) host.innerHTML = renderCard(state); }
    function accept(result) {
      if (!result || !Object.hasOwn(result, "snapshot")) throw new Error("저장 전망 응답을 확인하지 못했습니다.");
      const regionKey = result.snapshot?.scope?.regionKey || result.snapshot?.regionKey || result.scope?.regionKey;
      if (regionKey && regionKey !== state.regionKey) throw new Error("선택 지역과 다른 전망 자료입니다.");
      const jobKey = result.job?.scope?.regionKey || result.job?.regionKey;
      if (jobKey && jobKey !== state.regionKey) throw new Error("선택 지역과 다른 계산 작업입니다.");
      const month = result.scope?.month || result.scope?.currentMonth || result.snapshot?.asOfMonth;
      if (month && month !== state.targetMonth) throw new Error("선택 기준월과 다른 전망 자료입니다.");
      state.snapshot = result.snapshot || null; state.job = result.job || null; state.storageError = result.storage?.errorCode || ""; state.needsStatusCheck = false;
    }
    function poll() { clearTimer(); if (active(state.job) && visible()) timer = schedule(() => { timer = null; if (visible()) void refresh(true); }, 3000); }
    async function refresh(force = false) {
      if (!state.regionKey || !visible() || state.loading || state.starting) return false;
      clearTimer(); const token = revision, key = cacheKey(), url = `${ENDPOINT}?regionKey=${encodeURIComponent(state.regionKey)}&months=13`; state.loading = true; state.error = ""; render();
      try { const result = await cache.get(key, () => fetchJson(url), force); if (token !== revision || !visible()) return false; accept(result); return true; }
      catch (error) { cache.invalidate(key); if (token === revision && visible()) state.error = error.message || "저장 전망 확인 실패"; return false; }
      finally { if (token === revision) { state.loading = false; render(); if (!state.error) poll(); } }
    }
    async function start(collectMissing = false) {
      if (!visible() || !state.regionKey || state.loading || state.starting || state.needsStatusCheck || active(state.job)) return false;
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
    function stop() { clearTimer(); paused = true; revision++; if (state.starting) state.needsStatusCheck = true; state.loading = false; state.starting = false; }
    function onVisibility() { if (root.document?.hidden) clearTimer(); else if (visible() && active(state.job)) void refresh(true); }
    async function mount(element, context = {}) {
      const targetMonth = currentMonth(now()), changed = state.regionKey !== (context.regionKey || "") || state.accountKey !== (context.accountKey || "") || state.targetMonth !== targetMonth;
      const inFlight = !changed && (state.loading || state.starting);
      if (changed) { clearTimer(); revision++; Object.assign(state, { snapshot: null, job: null, error: "", storageError: "", message: "", loading: false, starting: false, needsStatusCheck: false, openGroups: new Set() }); }
      Object.assign(state, { regionKey: context.regionKey || "", regionLabel: context.regionLabel || "지역 미선택", accountKey: context.accountKey || "", targetMonth });
      contextVisible = context.isVisible || (() => true); if (context.fetchJson) fetchJson = context.fetchJson; host = element; paused = false;
      if (!bound.has(host)) { bound.add(host); host.addEventListener("click", event => { const button = event.target.closest?.("[data-ro-action]"); if (!button || button.disabled) return; if (button.dataset.roAction === "status") void refresh(true); if (button.dataset.roAction === "build") void start(false); if (button.dataset.roAction === "refresh") void start(true); }); host.addEventListener("toggle", event => { const key = event.target.dataset?.roGroup; if (key) { if (event.target.open) state.openGroups.add(key); else state.openGroups.delete(key); } }, true); }
      const cached = cache.read(cacheKey()); if (cached && !inFlight && !state.needsStatusCheck) { try { accept(cached); } catch { cache.invalidate(cacheKey()); } }
      render(); if (!state.regionKey || !visible()) return false; if (inFlight) return true;
      if (!cached || !cache.fresh(cacheKey()) || active(state.job)) return refresh(Boolean(active(state.job))); poll(); return true;
    }
    return { state, mount, refresh, start, stop, render, onVisibility };
  }
  const controllers = new Map();
  const exported = { createCache, createController, renderCard, metricHtml, calendarHtml, forecastKnown, number, currentMonth,
    mount(host, context) { if (!host) return false; for (const [element, controller] of controllers) if (element.isConnected === false) { controller.stop(); controllers.delete(element); } let controller = controllers.get(host); if (!controller) { controller = createController(); controllers.set(host, controller); } return controller.mount(host, context); },
    stop(host) { if (host) controllers.get(host)?.stop(); else for (const controller of controllers.values()) controller.stop(); },
    clear() { for (const controller of controllers.values()) controller.stop(); controllers.clear(); sharedCache.clear(); } };
  root.document?.addEventListener?.("visibilitychange", () => { for (const controller of controllers.values()) controller.onVisibility(); });
  root.RegionalOutlook = exported;
  if (typeof module !== "undefined" && module.exports) module.exports = exported;
})(typeof window !== "undefined" ? window : globalThis);
