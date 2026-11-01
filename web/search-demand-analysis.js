(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.SearchDemandAnalysis = api;
})(typeof window === "object" ? window : this, function () {
  "use strict";
  const instances = new WeakMap();
  const controllers = new Set();
  const TABS = { overview: "대시보드", related: "연관 키워드", forecast: "예측·리포트", history: "갱신 이력" };
  const DEVICES = { all: "전체", pc: "PC", mobile: "모바일" };
  const SORTS = { searchVolumeDesc: "검색량 높은 순", keywordAsc: "키워드 이름순", searchVolumeAsc: "검색량 낮은 순" };
  const STATUS = { ready: "저장 자료 확인", available: "저장 자료 있음", verified: "검증됨", complete: "완료", completed: "완료", partial: "일부 자료", range: "범위값 포함", stale: "이전 저장 자료", missing: "자료 없음", no_data: "제공 자료 없음", held: "보류", deferred: "이월", queued: "대기", running: "진행 중", failed: "실패", blocked: "제한 확인", interrupted: "중단", paused: "보류", disabled: "비활성", idle: "대기", reused: "저장 자료 재사용", unknown: "미확인", needs_verification: "검증 보류", unavailable: "조회 미확인" };
  const REASONS = { MISSING_KEY: "연결 키 설정이 필요합니다.", AUTH_ERROR: "인증 또는 이용 권한을 확인해야 합니다.", QUOTA_EXCEEDED: "제공처 호출 한도로 보류됐습니다.", NO_DATA: "해당 조건의 제공 자료가 없습니다.", MISSING_VALUES: "일부 기간의 관측이 없습니다.", PUBLICATION_PENDING: "제공처 자료 준비를 기다립니다.", EXACT_KEYWORD_MISSING: "정확한 기준 검색어가 응답에 없습니다.", KEYWORD_MISMATCH: "선택 키워드와 응답이 일치하지 않습니다.", PERIOD_MISMATCH: "조회 기간이 일치하지 않습니다.", INPUT_MISSING: "전망 입력 자료가 부족합니다.", INCOMPLETE_TREND: "월별 트렌드 자료가 부족합니다.", RANGE_INPUT: "범위값으로 점 전망을 계산하지 않았습니다.",
    FORECAST_INPUTS_MISSING: "검색량과 월별 트렌드 입력 자료가 모두 필요합니다.", FORECAST_INPUTS_PARTIAL: "부분 자료가 있어 전망 계산을 보류합니다.", FORECAST_TREND_COVERAGE_INCOMPLETE: "완료된 12개월 트렌드가 모두 확인되지 않았습니다.", FORECAST_SEARCH_COUNT_NOT_EXACT: "검색량이 범위값 또는 미확인이라 점 전망을 계산하지 않았습니다.", FORECAST_SEARCH_SNAPSHOT_NOT_FRESH: "계산 기준일에 맞는 검색량 관측이 필요합니다.", FORECAST_TARGET_OUTSIDE_BASE: "저장된 트렌드와 전망 대상월의 연결을 확인해야 합니다.", COMPARABLE_CALENDAR_OBSERVATION_UNAVAILABLE: "같은 기간 정의의 사후 실측이 없어 정확도 평가를 보류합니다." };
  const escape = value => String(value ?? "").replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character]));
  const text = (value, maximum = 300) => typeof value === "string" ? value.slice(0, maximum) : "";
  const number = value => typeof value === "number" && Number.isFinite(value);
  const integer = value => Number.isSafeInteger(value) && value >= 0;
  const fmt = value => number(value) ? value.toLocaleString("ko-KR", { maximumFractionDigits: 2 }) : "미확인";
  const validDay = value => typeof value === "string" && /^20\d{2}-(0[1-9]|1[0-2])-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
  const validMonth = value => typeof value === "string" && /^20\d{2}-(0[1-9]|1[0-2])$/.test(value);
  const today = () => new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
  const statusLabel = value => STATUS[value] || "미확인";
  const timeLabel = value => typeof value === "string" && /(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value)) ? `${new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date(value))} KST` : "미확인";

  function countView(value) {
    if (value?.state === "number" && number(value.value) && value.value >= 0) return { state: "number", value: value.value, lowerBound: value.value, upperBoundExclusive: null, label: fmt(value.value) };
    if (value?.state === "range" && number(value.lowerBound) && value.lowerBound >= 0 && number(value.upperBoundExclusive) && value.upperBoundExclusive > value.lowerBound) return { state: "range", value: null, lowerBound: value.lowerBound, upperBoundExclusive: value.upperBoundExclusive, label: value.lowerBound === 0 ? `${fmt(value.upperBoundExclusive)} 미만` : `${fmt(value.lowerBound)} 이상 ${fmt(value.upperBoundExclusive)} 미만` };
    return { state: "unknown", value: null, lowerBound: null, upperBoundExclusive: null, label: "미확인" };
  }
  function currentSelection(value = {}) {
    const day = validDay(value.day) ? value.day : today();
    return { keyword: text(value.keyword), month: validMonth(value.month) ? value.month : day.slice(0, 7), day,
      tab: Object.hasOwn(TABS, value.tab) ? value.tab : "overview", device: Object.hasOwn(DEVICES, value.device) ? value.device : "all",
      relatedQuery: text(value.relatedQuery, 100), relatedPage: Number.isSafeInteger(value.relatedPage) && value.relatedPage > 0 ? value.relatedPage : 1,
      relatedSort: Object.hasOwn(SORTS, value.relatedSort) ? value.relatedSort : "searchVolumeDesc", relatedKeyword: text(value.relatedKeyword), cadence: ["daily", "weekly", "monthly"].includes(value.cadence) ? value.cadence : "daily" };
  }
  function query(selection, extra = {}) {
    const value = { keyword: selection.keyword, day: selection.day, month: selection.month, relatedKeyword: selection.relatedKeyword, page: String(selection.relatedPage), pageSize: "20", sort: selection.relatedSort, search: selection.relatedQuery, ...extra };
    return new URLSearchParams(Object.entries(value).filter(([, item]) => item !== "" && item !== undefined)).toString();
  }
  function reportQuery(selection, format) { return new URLSearchParams({ keyword: selection.keyword, day: selection.day, month: selection.month, cadence: selection.cadence, format }).toString(); }
  function catalogView(value) {
    const seen = new Set(), keywords = [];
    for (const row of Array.isArray(value?.keywords) ? value.keywords : []) {
      const keyword = text(row?.keyword);
      if (!keyword || seen.has(keyword)) continue;
      seen.add(keyword); keywords.push({ keyword, keywordId: text(row.keywordId, 100), kind: row.kind === "anchor" ? "anchor" : "unknown" });
    }
    return { keywords, scheduler: value?.scheduler && typeof value.scheduler === "object" ? value.scheduler : null };
  }
  function viewModel(payload, selection) {
    const echo = payload?.selection || payload?.request;
    const matches = Boolean(echo && echo.keyword === selection.keyword && echo.day === selection.day && echo.month === selection.month
      && (echo.relatedKeyword || "") === selection.relatedKeyword && (echo.search || "") === selection.relatedQuery
      && (echo.sort || "searchVolumeDesc") === selection.relatedSort && (!echo.page || echo.page === selection.relatedPage));
    if (!matches) return { matches: false, anchor: null, status: "unknown", daily: [], trend: [], related: [], history: [], forecast: { status: "missing", value: null } };
    const search = payload.searchVolume || {}, anchor = search.exact === true && search.anchor?.keyword === selection.keyword ? search.anchor : null;
    const dailyKeyword = selection.relatedKeyword || selection.keyword;
    const daily = payload.daily?.keyword === dailyKeyword ? (Array.isArray(payload.daily.rows) ? payload.daily.rows : []).filter(row => validDay(row?.day)).map(row => ({ ...row, day: row.day, monthlyPc: countView(row.monthlyPc), monthlyMobile: countView(row.monthlyMobile), total: countView(row.total) })) : [];
    const trend = payload.trend?.keyword === selection.keyword ? (Array.isArray(payload.trend.series) ? payload.trend.series : []).map(row => ({ period: validDay(row?.period) ? row.period : "", value: row?.state === "observed" && number(row.ratio) && row.ratio >= 0 && row.ratio <= 100 ? row.ratio : null })).filter(row => row.period) : [];
    const related = (Array.isArray(payload.related?.rows) ? payload.related.rows : []).filter(row => text(row?.keyword)).map(row => ({ ...row, keyword: text(row.keyword), monthlyPc: countView(row.monthlyPc), monthlyMobile: countView(row.monthlyMobile), total: countView(row.total) }));
    const forecastMatches = payload.forecast?.targetMonth === selection.month;
    const forecast = payload.forecast?.status === "verified" && forecastMatches && number(payload.forecast.value) && payload.forecast.value >= 0 ? payload.forecast
      : forecastMatches ? { ...payload.forecast, status: payload.forecast.status === "verified" ? "held" : payload.forecast.status, value: null }
        : { status: "missing", value: null, targetMonth: selection.month, reasonCode: "INPUT_MISSING" };
    return { matches: true, status: search.stale ? "stale" : search.status || "missing", anchor: anchor ? { ...anchor, monthlyPc: countView(anchor.monthlyPc), monthlyMobile: countView(anchor.monthlyMobile), total: countView(anchor.total) } : null,
      observedAt: search.observedAt, snapshotId: text(search.snapshotId, 100), dailyKeyword, daily, trend, trendMeta: payload.trend || {}, related, relatedMeta: payload.related || {},
      history: Array.isArray(payload.history?.rows) ? payload.history.rows : [], historyMeta: payload.history || {}, forecast, forecastHistory: payload.forecastHistory || null, evaluation: payload.evaluation || null, refreshStatus: payload.refreshStatus || null, jobHistory: payload.jobHistory || null, comparisons: payload.comparisons || {}, reportSummary: payload.reportSummary || null };
  }
  function chartMarkup(rows = [], { metric = "total", trend = false, label = "저장 관측" } = {}) {
    const points = (Array.isArray(rows) ? rows : []).filter(row => row && typeof row === "object").map(row => ({ date: trend ? row.period : row.day, value: trend ? row.value : row[metric]?.value, range: trend ? null : row[metric] })).filter(row => validDay(row.date));
    const dates = points.map(row => Date.parse(`${row.date}T00:00:00Z`)), values = points.map(row => row.value).filter(number);
    const left = 55, right = 610, top = 28, bottom = 184, width = 640, height = 230;
    const maximum = trend ? 100 : values.length ? Math.max(1, Math.ceil(Math.max(...values) * 1.15 / 10) * 10) : 100;
    const minTime = dates.length ? Math.min(...dates) : 0, maxTime = dates.length ? Math.max(...dates) : 1;
    const x = timestamp => minTime === maxTime ? (left + right) / 2 : left + (timestamp - minTime) / (maxTime - minTime) * (right - left);
    const y = value => bottom - value / maximum * (bottom - top);
    const grid = [0, maximum / 2, maximum].map(value => `<g><line x1="${left}" x2="${right}" y1="${y(value)}" y2="${y(value)}" class="sda-chart-grid"/><text x="${left - 9}" y="${y(value) + 4}" text-anchor="end">${escape(fmt(value))}</text></g>`).join("");
    const segments = []; let segment = [];
    points.forEach((row, index) => {
      if (!number(row.value)) { if (segment.length) segments.push(segment); segment = []; return; }
      if (!trend && segment.length && dates[index] - dates[index - 1] > 86400000) { segments.push(segment); segment = []; }
      if (trend && segment.length) {
        const before = points[index - 1]?.date, next = new Date(Date.UTC(Number(before?.slice(0, 4)), Number(before?.slice(5, 7)), 1)).toISOString().slice(0, 7);
        if (next !== row.date.slice(0, 7)) { segments.push(segment); segment = []; }
      }
      segment.push(`${x(dates[index]).toFixed(1)},${y(row.value).toFixed(1)}`);
    });
    if (segment.length) segments.push(segment);
    const lines = segments.filter(row => row.length > 1).map(row => `<polyline points="${row.join(" ")}" class="sda-chart-line"/>`).join("");
    const circles = points.map((row, index) => number(row.value) ? `<circle cx="${x(dates[index])}" cy="${y(row.value)}" r="4" class="sda-chart-point"><title>${escape(row.date)} · ${escape(fmt(row.value))}${trend ? " 지수" : "회"}</title></circle>` : `<g><line x1="${x(dates[index]) - 3}" x2="${x(dates[index]) + 3}" y1="${bottom + 6}" y2="${bottom + 12}" class="sda-chart-missing"/><title>${escape(row.date)} · ${escape(row.range?.state === "range" ? row.range.label : "미확인")}</title></g>`).join("");
    const labelIndices = [...new Set([0, Math.floor((points.length - 1) / 2), points.length - 1])].filter(index => index >= 0 && index < points.length);
    const axis = labelIndices.map(index => `<text x="${x(dates[index])}" y="${bottom + 30}" text-anchor="${index === 0 ? "start" : index === points.length - 1 ? "end" : "middle"}">${escape(trend ? points[index].date.slice(0, 7) : points[index].date.slice(5).replace("-", "/"))}</text>`).join("");
    const empty = !values.length ? `<text x="${(left + right) / 2}" y="100" text-anchor="middle">${points.some(row => row.range?.state === "range") ? "범위값만 확인 · 점 관측선 미표시" : "저장된 유효 관측 없음"}</text>` : "";
    return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${escape(label)}. 미관측은 0으로 채우거나 선으로 연결하지 않습니다.">${grid}${lines}${circles}${axis}${empty}<text x="${left}" y="16">${trend ? "상대지수 0–100" : "조회 시점 월간 검색수 (회)"}</text></svg>`;
  }
  const badge = value => `<span class="sda-badge" data-status="${escape(STATUS[value] ? value : "unknown")}">${escape(statusLabel(value))}</span>`;
  const countCell = value => `<span class="sda-count" data-count-state="${escape(value?.state || "unknown")}">${escape(value?.label || "미확인")}</span>`;
  function reasonLabel(value) { const code = text(value?.reasonCode || value?.errorCode || value?.reason, 100); return REASONS[code] || (code && /^[A-Z0-9_:-]{1,100}$/.test(code) ? `저장 사유: ${code}` : "자료 조건과 저장 근거를 확인해 주세요."); }

  function overview(state, model) {
    const anchor = model.anchor, volume = anchor?.total, forecast = model.forecast;
    const chartRows = model.daily;
    const deviceMetric = state.selection.device === "pc" ? "monthlyPc" : state.selection.device === "mobile" ? "monthlyMobile" : "total";
    return `<div class="sda-metrics">
      <article><span>최근 월간 검색량 관측</span><strong>${countCell(volume)}<small>회</small></strong><p>${escape(model.observedAt ? timeLabel(model.observedAt) : "정확 일치 자료 미확보")}</p></article>
      <article><span>PC 검색량</span><strong>${countCell(anchor?.monthlyPc)}<small>회</small></strong><p>조회 시점 제공값</p></article>
      <article><span>모바일 검색량</span><strong>${countCell(anchor?.monthlyMobile)}<small>회</small></strong><p>조회 시점 제공값</p></article>
      <article><span>${escape(state.selection.month)} 전망${forecast.preview === true && forecast.published !== true ? " · 미발행 계산" : ""}</span><strong>${number(forecast.value) ? `${escape(fmt(forecast.value))}<small>회</small>` : "미계산"}</strong><p>${number(forecast.value) ? forecast.published === true ? "저장된 발행 전망" : "저장 입력으로 계산 · 아직 미발행" : reasonLabel(forecast)}</p></article>
    </div><div class="sda-comparisons"><span>기준 검색어 전일 대비 <strong>${comparisonLabel(model.comparisons?.day)}</strong></span><span>7일 전 대비 <strong>${comparisonLabel(model.comparisons?.week)}</strong></span><small>같은 정의의 월간 규모 관측 변화이며, 해당 날짜의 검색수가 아닙니다.</small></div><div class="sda-two">
      <section class="sda-panel"><div class="sda-panel-head"><h3>관측일별 검색량${model.dailyKeyword && model.dailyKeyword !== state.selection.keyword ? ` · ${escape(model.dailyKeyword)}` : ""}</h3><div class="sda-switch" role="group" aria-label="검색 기기">${Object.entries(DEVICES).map(([key, label]) => `<button type="button" data-sda-device="${key}" aria-pressed="${state.selection.device === key}">${label}</button>`).join("")}</div></div>${chartMarkup(chartRows, { metric: deviceMetric, label: `${model.dailyKeyword || state.selection.keyword} 관측일별 ${DEVICES[state.selection.device]} 검색량` })}<p class="sda-caption">각 점은 그날 조회한 최근 월간 검색수입니다. 당일 검색수나 달 전체 확정 합계가 아닙니다.</p></section>
      <section class="sda-panel"><div class="sda-panel-head"><h3>12개월 검색 트렌드</h3>${badge(model.trendMeta?.status)}</div>${chartMarkup(model.trend, { trend: true, label: `${state.selection.keyword} 동일 조회창의 월별 검색 상대지수` })}<p class="sda-caption">${escape(model.trendMeta?.startDate || "기간 미확인")} ~ ${escape(model.trendMeta?.endDate || "미확인")} · 같은 조회창의 최댓값 100 기준</p></section>
    </div><div class="sda-note">기준 검색어와 연관어의 검색량은 서로 더하지 않습니다. 미확인·범위값은 점 추정치나 0으로 바꾸지 않습니다.</div>
    <div class="sda-two"><section class="sda-panel"><div class="sda-panel-head"><h3>기준·연관 키워드</h3><button type="button" data-sda-tab="related" class="sda-link-button">전체 목록 보기</button></div>${relatedTable(model.related.slice(0, 5), state)}<p class="sda-caption">화면 미리보기 ${fmt(Math.min(5, model.related.length))}행 · 저장된 목록 전체 범위는 연관 키워드 탭에서 확인합니다.</p></section>${freshness(state, model)}</div>`;
  }
  function comparisonLabel(value) {
    if (!["verified", "ready", "available", "comparable", "zero_base"].includes(value?.status) || !number(value.absolute)) return "미확인";
    const signed = value.absolute > 0 ? "+" : "";
    const percentage = number(value.percent) ? ` · ${value.percent > 0 ? "+" : ""}${fmt(value.percent * 100)}%` : " · 증감률 미확인";
    return `${escape(signed + fmt(value.absolute))}회${escape(percentage)}`;
  }
  function relatedTable(rows, state) {
    return `<div class="sda-table-wrap"><table><thead><tr><th>키워드</th><th>구분</th><th class="sda-number">PC</th><th class="sda-number">모바일</th><th class="sda-number">합계</th><th>자료 상태</th></tr></thead><tbody>${rows.length ? rows.map(row => `<tr${state.selection.relatedKeyword === row.keyword ? ' class="is-selected"' : ""}><td><button type="button" class="sda-keyword-button" data-sda-related="${escape(row.keyword)}">${escape(row.keyword)}</button></td><td>${row.isAnchor ? "기준" : "연관"}</td><td class="sda-number">${countCell(row.monthlyPc)}</td><td class="sda-number">${countCell(row.monthlyMobile)}</td><td class="sda-number">${countCell(row.total)}</td><td>${badge(row.status)}${row.conflicting ? '<span class="sda-warning-text">상충 기록</span>' : ""}</td></tr>`).join("") : '<tr><td colspan="6" class="sda-empty">선택 조건의 저장 키워드 목록이 없습니다.</td></tr>'}</tbody></table></div>`;
  }
  function relatedPane(state, model) {
    const meta = model.relatedMeta || {}, counts = meta.counts || {}, total = integer(meta.total) ? meta.total : null, pages = integer(meta.totalPages) && meta.totalPages > 0 ? meta.totalPages : 1;
    return `<section class="sda-panel"><div class="sda-panel-head"><div><h3>${escape(state.selection.keyword)} 기준의 전체 저장 목록</h3><p class="sda-caption">${escape(timeLabel(meta.observedAt))} · ${statusLabel(meta.status)}</p></div></div>
      <form class="sda-related-search" data-sda-form="related"><label>키워드 찾기<input type="search" name="search" maxlength="100" value="${escape(state.selection.relatedQuery)}" placeholder="저장된 목록 안에서 검색"></label><label>정렬<select data-sda-related-sort name="sort">${Object.entries(SORTS).map(([value, label]) => `<option value="${value}"${state.selection.relatedSort === value ? " selected" : ""}>${label}</option>`).join("")}</select></label><button type="submit">목록 조회</button></form>
      <div class="sda-summary">반환 ${escape(fmt(counts.returnedRows))}행 · 정규화 ${escape(fmt(counts.validRows))}행 · 고유 ${escape(fmt(counts.uniqueRows))}개 · 중복 ${escape(fmt(counts.duplicateRows))}행 · 상충 ${escape(fmt(counts.conflictingKeys))}개 · 무효 ${escape(fmt(counts.invalidRows))}행</div>
      ${relatedTable(model.related, state)}<div class="sda-pagination"><span>검색 결과 ${escape(fmt(total))}개 · ${escape(fmt(meta.page || state.selection.relatedPage))}/${escape(fmt(pages))}페이지</span><div><button type="button" data-sda-page="${state.selection.relatedPage - 1}"${state.selection.relatedPage <= 1 ? " disabled" : ""}>이전</button><button type="button" data-sda-page="${state.selection.relatedPage + 1}"${state.selection.relatedPage >= pages ? " disabled" : ""}>다음</button></div></div>
      <p class="sda-caption">검색광고 응답에 함께 포함된 관련 키워드입니다. 개별 단어 선택은 저장 이력만 조회하며 추가 수집이나 등록을 실행하지 않습니다.</p></section>
      ${state.selection.relatedKeyword ? `<section class="sda-panel"><div class="sda-panel-head"><h3>${escape(state.selection.relatedKeyword)} 관측 이력</h3><button type="button" data-sda-related="">기준 키워드 이력 보기</button></div>${chartMarkup(model.daily, { label: `${state.selection.relatedKeyword} 저장 관측 이력` })}<p class="sda-caption">현재 기준 검색어는 ${escape(state.selection.keyword)}로 유지합니다. 이력의 출처·관측일이 없는 구간은 미확인입니다.</p></section>` : ""}`;
  }
  function freshness(state, model) {
    const scheduler = state.catalog?.scheduler || {}, refresh = model.refreshStatus || {};
    return `<section class="sda-panel"><div class="sda-panel-head"><h3>저장·갱신 상태</h3>${badge(refresh.status || (scheduler.enabled === false ? "disabled" : "unknown"))}</div><dl class="sda-facts"><div><dt>검색량 관측</dt><dd>${escape(timeLabel(model.observedAt))}</dd></div><div><dt>트렌드 관측</dt><dd>${escape(timeLabel(model.trendMeta?.observedAt))}</dd></div><div><dt>트렌드 확인 월</dt><dd>${integer(model.trendMeta?.coverage?.expectedMonths) && model.trendMeta.coverage.expectedMonths > 0 ? escape(fmt(model.trendMeta.coverage.observedMonths)) + " / " + escape(fmt(model.trendMeta.coverage.expectedMonths)) : "조회창 미확보"}</dd></div><div><dt>숙소 정규수집</dt><dd>기존 하루 6회 · 별도 운영</dd></div></dl><p class="sda-caption">이 화면은 저장 자료만 읽습니다. 검색 API 갱신과 숙소 수집·DB 반영 상태는 별도로 확인합니다.</p><details class="sda-source-details"><summary>저장 자료 근거</summary><dl class="sda-facts"><div><dt>검색량 자료 번호</dt><dd>${escape(model.snapshotId || "미확인")}</dd></div><div><dt>트렌드 자료 번호</dt><dd>${escape(text(model.trendMeta?.snapshotId, 100) || "미확인")}</dd></div><div><dt>트렌드 조회기간</dt><dd>${escape(model.trendMeta?.startDate || "미확인")} ~ ${escape(model.trendMeta?.endDate || "미확인")}</dd></div></dl></details></section>`;
  }
  function forecastPane(state, model) {
    const value = model.forecast || {}, reportEcho = state.report?.selection || state.report?.request;
    const report = reportEcho?.keyword === state.selection.keyword && reportEcho?.day === state.selection.day && reportEcho?.month === state.selection.month && state.report?.cadence === state.selection.cadence ? state.report : null;
    const cadenceLabels = { daily: "일간", weekly: "주간", monthly: "월간" };
    return `<div class="sda-two"><section class="sda-panel"><div class="sda-panel-head"><h3>${escape(value.targetMonth || state.selection.month)} 전망${value.preview === true && value.published !== true ? " · 미발행 계산" : ""}</h3>${badge(value.status)}</div><div class="sda-forecast-value">${number(value.value) ? `${escape(fmt(value.value))}<small>회</small>` : "미계산"}</div><dl class="sda-facts"><div><dt>발행 상태</dt><dd>${value.published === true ? "저장된 발행 전망" : value.preview === true ? "미발행 계산 · 조회가 발행을 실행하지 않음" : "발행 근거 미확인"}</dd></div><div><dt>계산 기준</dt><dd>${escape(forecastBasis(value))}</dd></div><div><dt>입력 검색량 관측</dt><dd>${number(value.inputVolume) ? escape(fmt(value.inputVolume)) + "회" : "미확인"} · ${escape(timeLabel(value.searchObservedAt))}</dd></div><div><dt>트렌드 분모 / 분자 월</dt><dd>${escape(validMonth(value.basePeriod) ? value.basePeriod : "미확인")} / ${escape(validMonth(value.seasonalPeriod) ? value.seasonalPeriod : "해당 없음 / 미확인")}</dd></div><div><dt>적용 보정계수</dt><dd>${escape(fmt(value.factor))}</dd></div><div><dt>모델 버전</dt><dd>${escape(text(value.modelVersion, 100) || "미확인")}</dd></div><div><dt>계산 시각</dt><dd>${escape(timeLabel(value.calculatedAt))}</dd></div></dl><p class="sda-caption">기존 수요전망의 계산을 보존합니다. 최근 월간 검색수에 적용한 추정이며 예약 건수·실매출을 뜻하지 않습니다. 트렌드 월을 입력 검색량의 달력월 확정 총량으로 해석하지 않습니다.</p><details class="sda-source-details"><summary>전망 입력 자료 근거</summary><dl class="sda-facts"><div><dt>입력 자료 번호</dt><dd>${Array.isArray(value.sourceSnapshotIds) && value.sourceSnapshotIds.length ? value.sourceSnapshotIds.slice(0, 10).map(id => escape(text(id, 100))).join("<br>") : "미확인"}</dd></div><div><dt>트렌드 조회창 번호</dt><dd>${escape(text(value.trendWindowId, 100) || "미확인")}</dd></div></dl></details></section>
      <section class="sda-panel"><h3>일간·주간·월간 리포트</h3><div class="sda-report-controls"><label>보고 주기<select data-sda-cadence>${Object.entries(cadenceLabels).map(([key, label]) => `<option value="${key}"${state.selection.cadence === key ? " selected" : ""}>${label}</option>`).join("")}</select></label><button type="button" data-sda-report${state.reportLoading ? " disabled" : ""}>${state.reportLoading ? "저장 보고서 확인 중…" : "저장 보고서 조회"}</button><a class="sda-button" href="/api/search-demand/report?${escape(reportQuery(state.selection, "csv"))}" download>CSV 내려받기</a></div>
      ${state.reportError ? '<p class="sda-warning" role="status">보고서를 읽지 못했습니다. 이전 보고서가 있으면 원래 기준과 함께 유지합니다.</p>' : ""}
      ${report ? `<dl class="sda-facts"><div><dt>보고 주기</dt><dd>${escape(cadenceLabels[report.cadence] || "미확인")}</dd></div><div><dt>상태</dt><dd>${escape(statusLabel(report.status))}</dd></div><div><dt>자료 확인 시각</dt><dd>${escape(timeLabel(report.generatedAt || report.observedAt))}</dd></div><div><dt>관측 범위</dt><dd>${escape(validDay(report.scope?.from) ? report.scope.from : "미확인")} ~ ${escape(validDay(report.scope?.to) ? report.scope.to : "미확인")}</dd></div><div><dt>정상 / 범위 / 미확인 행</dt><dd>${escape(fmt(report.summary?.known))} / ${escape(fmt(report.summary?.ranged))} / ${escape(fmt(report.summary?.missing))}</dd></div><div><dt>대표 관측</dt><dd>${countCell(countView(report.summary?.representative?.total))}회 · ${escape(validDay(report.summary?.representative?.day) ? report.summary.representative.day : "일자 미확인")}</dd></div></dl>` : '<p class="sda-empty">선택 키워드·관측일·전망 대상월의 저장 보고서를 조회합니다.</p>'}
      ${report ? reportRequestMetrics(report) : ""}<ul class="sda-report-notes"><li>같은 정의와 기간의 관측끼리 비교합니다.</li><li>반복 조회한 월간 검색량을 합산하지 않습니다.</li><li>자료 부족·범위값·보류 사유를 보고서에 함께 남깁니다.</li><li>전망 정확도는 동일 기준의 사후 관측이 쌓인 뒤 별도로 평가합니다.</li></ul></section></div>${forecastHistory(state, model)}${report ? reportRows(report) : ""}`;
  }
  function reportRequestMetrics(report) {
    const value = report.requestMetrics || {}, validBasis = value.countBasis === "cumulative_attempts_of_jobs_grouped_by_scheduled_period";
    const subtotal = validBasis && integer(value.knownRequestCountSubtotal) ? `${fmt(value.knownRequestCountSubtotal)}건` : "미확인";
    const complete = validBasis && value.completeCoverage === true && value.truncated !== true && report.jobHistory?.truncated !== true;
    const actualVerified = value.actualPeriodRequestCountStatus === "verified" && integer(value.actualPeriodRequestCount);
    return `<div class="sda-request-metrics"><dl class="sda-facts"><div><dt>보고기간 예정 작업의 누적 요청 소계</dt><dd>${escape(subtotal)}</dd></div><div><dt>요청 계수 확인 / 미확인 작업</dt><dd>${escape(integer(value.knownJobCount) ? fmt(value.knownJobCount) : "미확인")} / ${escape(integer(value.unknownJobCount) ? fmt(value.unknownJobCount) : "미확인")}</dd></div><div><dt>누적 소계 확인 범위</dt><dd>${complete ? "해당 예정 작업 범위 확인" : "일부 · 미확인 범위 있음"}</dd></div></dl><p class="sda-caption">${actualVerified ? `기간 내 실제 호출 총량 ${escape(fmt(value.actualPeriodRequestCount))}건` : "기간 내 실제 호출 총량 미확인(월간 재시도가 다른 날짜에 걸칠 수 있음)"}</p><p class="sda-caption">누적 요청 소계는 예정 기간에 속한 작업의 전체 시도를 묶은 값이며, 그날 실제 발생한 호출 수나 계정 전체 사용량이 아닙니다.</p></div>`;
  }
  function forecastBasis(value) {
    if (value.status !== "verified") return reasonLabel(value);
    const input = `${fmt(value.inputVolume)}회`, factor = fmt(value.factor);
    const base = validMonth(value.basePeriod) ? value.basePeriod : "기준월 미확인", seasonal = validMonth(value.seasonalPeriod) ? value.seasonalPeriod : "비교월 미확인";
    if (value.method === "seasonal_ratio") return `최근 기간 검색량 ${input} × (${seasonal} 트렌드 지수 ÷ ${base} 트렌드 지수) · 보정계수 ${factor}`;
    if (value.method === "recent_three_month") return `최근 기간 검색량 ${input} × 최근 3개월 추세 보정계수 ${factor}`;
    if (value.method === "twelve_month_trend") return `최근 기간 검색량 ${input} × 12개월 추세 보정계수 ${factor}`;
    return text(value.basis, 600) || "저장된 계산 방법을 확인해야 합니다.";
  }
  function forecastHistory(state, model) {
    const history = model.forecastHistory || {}, rows = (Array.isArray(history.rows) ? history.rows : []).filter(row => row?.keyword === state.selection.keyword).slice(0, 100), evaluation = model.evaluation || {};
    return `<section class="sda-panel"><div class="sda-panel-head"><h3>전망 발행 이력</h3><small>전체 ${escape(fmt(history.total))}건${history.truncated === true ? " · 일부만 표시" : ""}</small></div><div class="sda-table-wrap"><table><thead><tr><th>대상월</th><th>발행 계산 시각</th><th class="sda-number">전망값</th><th>계산 기준</th><th>모델</th></tr></thead><tbody>${rows.length ? rows.map(row => `<tr><td>${escape(validMonth(row.targetMonth) ? row.targetMonth : "미확인")}</td><td>${escape(timeLabel(row.calculatedAt))}</td><td class="sda-number">${row.status === "verified" && number(row.value) && row.value >= 0 ? escape(fmt(row.value)) + "회" : "미계산"}</td><td>${escape(forecastBasis(row))}</td><td>${escape(text(row.modelVersion, 100) || "미확인")}</td></tr>`).join("") : '<tr><td colspan="5" class="sda-empty">선택 키워드의 저장된 전망 발행 이력이 없습니다.</td></tr>'}</tbody></table></div><div class="sda-note sda-evaluation"><strong>사후 평가 · ${escape(statusLabel(evaluation.status))}</strong><p>${escape(evaluation.reasonCode ? reasonLabel(evaluation) : "같은 정의·기간의 사후 관측이 확인돼야 평가할 수 있습니다.")}</p></div></section>`;
  }
  function reportRows(report) {
    const rows = Array.isArray(report.rows) ? report.rows : [], shown = rows.slice(0, 200);
    return `<section class="sda-panel"><div class="sda-panel-head"><h3>리포트 관측 자료</h3><small>표시 ${fmt(shown.length)} / ${fmt(rows.length)}행${rows.length > shown.length ? " · 전체는 CSV에서 확인" : ""}</small></div><div class="sda-table-wrap"><table><thead><tr><th>관측일</th><th>키워드</th><th>구분</th><th class="sda-number">PC</th><th class="sda-number">모바일</th><th class="sda-number">합계</th><th>상태</th></tr></thead><tbody>${shown.length ? shown.map(row => `<tr><td>${escape(validDay(row.day) ? row.day : "미확인")}</td><td>${escape(text(row.keyword) || "미확인")}</td><td>${row.isAnchor === true ? "기준" : row.isAnchor === false ? "연관" : "미확인"}</td><td class="sda-number">${countCell(countView(row.monthlyPc))}</td><td class="sda-number">${countCell(countView(row.monthlyMobile))}</td><td class="sda-number">${countCell(countView(row.total))}</td><td>${badge(row.status)}</td></tr>`).join("") : '<tr><td colspan="7" class="sda-empty">보고 범위의 저장 관측이 없습니다.</td></tr>'}</tbody></table></div></section>`;
  }
  function historyPane(state, model) {
    const meta = model.historyMeta || {};
    return `${freshness(state, model)}${jobsTable(state, model)}<section class="sda-panel"><div class="sda-panel-head"><h3>관측·갱신 이력</h3><small>저장 근거 ${escape(fmt(meta.total))}건${meta.truncated === true ? " · 일부만 표시" : ""}</small></div><div class="sda-table-wrap"><table><thead><tr><th>제공처</th><th>키워드</th><th>관측일</th><th>관측 시각</th><th>상태</th><th>반환 / 고유</th></tr></thead><tbody>${model.history.length ? model.history.map(row => `<tr><td>${row.provider === "searchad" ? "네이버 검색광고" : row.provider === "datalab" ? "검색 트렌드" : "미확인"}</td><td>${escape(text(row.keyword) || state.selection.keyword)}</td><td>${escape(validDay(row.day) ? row.day : "미확인")}</td><td>${escape(timeLabel(row.observedAt))}</td><td>${badge(row.status)}${row.errorCode || row.reasonCode ? `<small>${escape(reasonLabel(row))}</small>` : ""}</td><td>${escape(fmt(row.counts?.returnedRows))} / ${escape(fmt(row.counts?.uniqueRows))}</td></tr>`).join("") : '<tr><td colspan="6" class="sda-empty">선택 조건의 저장 이력이 없습니다.</td></tr>'}</tbody></table></div><p class="sda-caption">이력 수와 실제 HTTP 요청 수는 다릅니다. 표시되지 않은 호출량이나 제공처 잔여 한도를 추정하지 않습니다.</p></section>`;
  }
  function jobsTable(state, model) {
    const history = model.jobHistory || {}, rows = (Array.isArray(history.items) ? history.items : []).filter(row => row?.keyword === state.selection.keyword).slice(0, 100);
    const requests = value => integer(value) ? fmt(value) : "미확인";
    return `<section class="sda-panel"><div class="sda-panel-head"><h3>검색 API 작업 이력</h3>${badge(history.status)}</div><div class="sda-table-wrap"><table><thead><tr><th>제공처 / 대상</th><th>예정 시각</th><th>실제 시작 / 종료</th><th>상태</th><th>HTTP 요청<br>누적 / 마지막</th><th>다음 허용일</th></tr></thead><tbody>${rows.length ? rows.map(row => `<tr><td>${row.provider === "searchad" ? "검색광고" : row.provider === "datalab" ? "검색 트렌드" : "미확인"}<small>${escape(text(row.period, 40))}</small></td><td>${escape(timeLabel(row.scheduledAt))}</td><td>${escape(timeLabel(row.startedAt))}<br>${escape(timeLabel(row.finishedAt))}</td><td>${badge(row.status)}${row.errorCode ? `<small>${escape(reasonLabel(row))}</small>` : ""}</td><td class="sda-number">${requests(row.requestCount)} / ${requests(row.lastRequestCount)}</td><td>${escape(validDay(row.nextRetryDay) ? row.nextRetryDay : "미확인 / 해당 없음")}</td></tr>`).join("") : '<tr><td colspan="6" class="sda-empty">선택 키워드의 저장 작업 이력이 없습니다.</td></tr>'}</tbody></table></div><p class="sda-caption">예정과 실제 실행을 구분합니다. 호출 수 미기록은 0이 아닙니다.${history.truncated === true ? " · 작업 이력은 일부만 조회됐습니다." : ""}</p></section>`;
  }
  function render(state) {
    if (!state.root) return;
    const selection = state.selection, model = viewModel(state.data, selection), error = Boolean(state.error);
    const selected = state.catalog?.keywords || [], hasSelected = selected.some(row => row.keyword === selection.keyword);
    const controls = `${!hasSelected && selection.keyword ? `<option value="${escape(selection.keyword)}" selected>${escape(selection.keyword)} · 등록 목록 외</option>` : ""}${selected.map(row => `<option value="${escape(row.keyword)}"${selection.keyword === row.keyword ? " selected" : ""}>${escape(row.keyword)}</option>`).join("")}`;
    const content = !selection.keyword ? '<section class="sda-panel sda-empty">등록된 기준 키워드가 없습니다. 이 화면에서는 수집 대상을 자동으로 추가하지 않습니다.</section>'
      : !model.matches ? `<section class="sda-panel sda-empty">${state.loading ? "선택 조건의 저장 자료를 확인하고 있습니다." : "선택 키워드·관측일·전망 대상월에 맞는 저장 자료를 확인하지 못했습니다."}</section>`
      : selection.tab === "related" ? relatedPane(state, model) : selection.tab === "forecast" ? forecastPane(state, model) : selection.tab === "history" ? historyPane(state, model) : overview(state, model);
    state.root.innerHTML = `<div class="search-demand-analysis" aria-busy="${state.loading}"><header class="sda-heading"><div><p>업종분석 / 검색 수요 분석</p><h2>${escape(selection.keyword || "검색 수요 분석")}</h2></div><div class="sda-heading-actions">${badge(model.matches ? model.status : "unknown")}<button type="button" data-sda-refresh${state.loading ? " disabled" : ""}>${state.loading ? "저장 자료 확인 중…" : "저장 자료 조회"}</button>${state.options.onOpenKeywordMonthly && selection.keyword ? '<button type="button" data-sda-monthly>키워드 월별 보기</button>' : ""}</div></header>
      <form class="sda-filter" data-sda-form="selection"><label>기준 키워드<select data-sda-keyword name="keyword">${controls || '<option value="">등록 키워드 없음</option>'}</select></label><label>검색량 관측일<input type="date" name="day" value="${escape(selection.day)}" max="${today()}"></label><label>전망 대상월<input type="month" name="month" value="${escape(selection.month)}"></label><button type="submit">저장 조건 조회</button></form>
      ${error ? '<div class="sda-warning" role="status">저장 자료를 읽지 못했습니다. 이전 자료가 보이면 원래 관측 시각의 자료이며 이번 조회 성공을 뜻하지 않습니다.</div>' : ""}
      ${state.loading && model.matches ? '<p class="sda-caption" role="status">저장 자료 확인 중 · 아래에는 직전 조회 자료를 유지합니다.</p>' : ""}
      <nav class="sda-tabs" aria-label="검색 수요 분석 탭">${Object.entries(TABS).map(([key, label]) => `<button type="button" data-sda-tab="${key}" aria-current="${selection.tab === key ? "page" : "false"}">${label}</button>`).join("")}</nav><div class="sda-content">${content}</div><footer class="sda-footer">관측일 · 트렌드 조회기간 · 전망 대상월을 구분합니다. 화면 조회는 저장 자료만 읽으며 공급자 호출·수집 실행·설정 변경을 하지 않습니다.</footer></div>`;
  }
  async function defaultFetch(url) {
    if (!/^\/api\/search-demand\/(?:catalog|analysis|report)(?:\?|$)/.test(url)) throw new Error("Invalid saved-data URL");
    const response = await fetch(url, { method: "GET", credentials: "same-origin", cache: "no-store" });
    if (!response.ok) throw Object.assign(new Error("Stored data unavailable"), { status: response.status });
    return response.json();
  }
  async function read(state, { catalog = false } = {}) {
    const sequence = ++state.sequence;
    state.loading = true; state.error = false; render(state);
    try {
      if (catalog || !state.catalog) {
        const result = await state.options.fetchJson("/api/search-demand/catalog");
        if (state.paused || sequence !== state.sequence) return;
        state.catalog = catalogView(result);
        if (!state.selection.keyword && state.catalog.keywords.length) state.selection.keyword = state.catalog.keywords[0].keyword;
      }
      if (!state.selection.keyword) { state.data = null; return; }
      const requested = { ...state.selection }, data = await state.options.fetchJson(`/api/search-demand/analysis?${query(requested)}`);
      if (state.paused || sequence !== state.sequence) return;
      if (!viewModel(data, requested).matches) throw new Error("Stored response selection mismatch");
      state.data = data;
    } catch (error) {
      if (!state.paused && sequence === state.sequence) {
        if ([401, 403].includes(error?.status || error?.statusCode)) { clearState(state); state.error = true; render(state); }
        else state.error = true;
      }
    }
    finally { if (!state.paused && sequence === state.sequence) { state.loading = false; render(state); } }
  }
  async function readReport(state) {
    const sequence = ++state.reportSequence, requested = { ...state.selection };
    state.reportLoading = true; state.reportError = false; render(state);
    try {
      const report = await state.options.fetchJson(`/api/search-demand/report?${reportQuery(requested, "json")}`);
      if (state.paused || sequence !== state.reportSequence) return;
      const echo = report?.selection || report?.request;
      if (!echo || echo.keyword !== requested.keyword || echo.day !== requested.day || echo.month !== requested.month || report.cadence !== requested.cadence) throw new Error("Report selection mismatch");
      state.report = report;
    } catch (error) {
      if (!state.paused && sequence === state.reportSequence) {
        if ([401, 403].includes(error?.status || error?.statusCode)) { clearState(state); state.error = true; render(state); }
        else state.reportError = true;
      }
    }
    finally { if (!state.paused && sequence === state.reportSequence) { state.reportLoading = false; render(state); } }
  }
  function bind(state) {
    state.root.addEventListener("click", event => {
      const button = event.target.closest?.("button"); if (!button || button.disabled || state.paused) return;
      if (button.dataset.sdaTab && Object.hasOwn(TABS, button.dataset.sdaTab)) { state.selection.tab = button.dataset.sdaTab; render(state); }
      else if (button.dataset.sdaDevice && Object.hasOwn(DEVICES, button.dataset.sdaDevice)) { state.selection.device = button.dataset.sdaDevice; render(state); }
      else if (Object.hasOwn(button.dataset, "sdaRefresh")) void read(state, { catalog: true });
      else if (Object.hasOwn(button.dataset, "sdaMonthly")) state.options.onOpenKeywordMonthly?.({ keyword: state.selection.keyword, month: state.selection.month, day: state.selection.day });
      else if (Object.hasOwn(button.dataset, "sdaRelated")) { state.selection.relatedKeyword = text(button.dataset.sdaRelated); state.selection.tab = "related"; void read(state); }
      else if (Object.hasOwn(button.dataset, "sdaPage")) { const page = Number(button.dataset.sdaPage); if (Number.isSafeInteger(page) && page > 0) { state.selection.relatedPage = page; void read(state); } }
      else if (Object.hasOwn(button.dataset, "sdaReport")) void readReport(state);
    });
    state.root.addEventListener("change", event => {
      if (state.paused) return;
      if (event.target.matches?.("[data-sda-cadence]")) { state.selection.cadence = ["daily", "weekly", "monthly"].includes(event.target.value) ? event.target.value : "daily"; state.reportSequence++; state.report = null; render(state); }
    });
    state.root.addEventListener("submit", event => {
      const form = event.target; if (!form?.dataset?.sdaForm || state.paused) return;
      event.preventDefault();
      if (form.dataset.sdaForm === "selection") {
        const keyword = text(form.elements.keyword?.value), day = form.elements.day?.value, month = form.elements.month?.value;
        if (!keyword || !validDay(day) || day > today() || !validMonth(month)) return;
        const changedKeyword = keyword !== state.selection.keyword;
        state.selection = currentSelection({ ...state.selection, keyword, day, month, ...(changedKeyword ? { relatedKeyword: "", relatedPage: 1, relatedQuery: "" } : {}) });
      } else if (form.dataset.sdaForm === "related") {
        state.selection.relatedQuery = text(form.elements.search?.value, 100);
        state.selection.relatedSort = Object.hasOwn(SORTS, form.elements.sort?.value) ? form.elements.sort.value : "searchVolumeDesc";
        state.selection.relatedPage = 1;
      }
      state.reportSequence++; state.report = null;
      void read(state);
    });
  }
  async function show(element, options = {}) {
    if (!element || typeof element.addEventListener !== "function") return;
    let state = instances.get(element);
    if (!state) {
      state = { root: element, selection: currentSelection(options), options: {}, catalog: null, data: null, report: null, paused: false, loading: false, error: false, reportLoading: false, reportError: false, sequence: 0, reportSequence: 0 };
      instances.set(element, state); controllers.add(state); bind(state);
    }
    state.options = { ...state.options, ...options, fetchJson: typeof options.fetchJson === "function" ? options.fetchJson : state.options.fetchJson || defaultFetch };
    const oldScope = `${state.selection.keyword}|${state.selection.day}|${state.selection.month}`;
    if (Object.hasOwn(options, "keyword") && text(options.keyword) && text(options.keyword) !== state.selection.keyword) state.selection = currentSelection({ ...state.selection, keyword: options.keyword, relatedKeyword: "", relatedPage: 1, relatedQuery: "" });
    if (validDay(options.day)) state.selection.day = options.day;
    if (validMonth(options.month)) state.selection.month = options.month;
    if (oldScope !== `${state.selection.keyword}|${state.selection.day}|${state.selection.month}`) { state.reportSequence++; state.report = null; }
    state.paused = false;
    await read(state, { catalog: true });
  }
  function pause(element) { const state = instances.get(element); if (state) { state.paused = true; state.sequence++; state.reportSequence++; state.loading = false; state.reportLoading = false; } }
  function clearState(state) {
    state.paused = true; state.sequence++; state.reportSequence++; state.loading = false; state.reportLoading = false;
    state.selection = currentSelection(); state.catalog = null; state.data = null; state.report = null;
    state.options = {}; state.error = false; state.reportError = false; state.root.innerHTML = "";
  }
  function clear(element) {
    if (element) { const state = instances.get(element); if (state) clearState(state); }
    else controllers.forEach(clearState);
  }
  function getSelection(element) { const state = instances.get(element); return state ? { ...state.selection } : null; }
  async function setSelection(element, patch = {}, options = {}) {
    const state = instances.get(element); if (!state) return;
    const next = currentSelection({ ...state.selection, ...patch });
    if (next.keyword !== state.selection.keyword) { next.relatedKeyword = ""; next.relatedPage = 1; next.relatedQuery = ""; }
    const changedScope = ["keyword", "day", "month", "relatedKeyword", "relatedPage", "relatedQuery", "relatedSort"].some(key => next[key] !== state.selection[key]);
    state.selection = next; state.reportSequence++; state.report = null;
    if (changedScope && !options.reload) { state.sequence++; state.loading = false; }
    if (options.reload && !state.paused) await read(state); else render(state);
  }
  return { show, pause, clear, getSelection, setSelection, countView, viewModel, chartMarkup, currentSelection };
});
