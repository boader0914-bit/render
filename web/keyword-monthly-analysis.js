(function (root) {
  "use strict";
  const instances = new WeakMap();
  const controllers = new Set();
  const MONTH = /^20\d{2}-(0[1-9]|1[0-2])$/;
  const PRODUCTS = { lodging: { label: "숙박", unit: "실·박", dailyUnit: "실" }, dayuse: { label: "데이유즈", unit: "회", dailyUnit: "회" } };
  const known = value => typeof value === "number" && Number.isFinite(value);
  const number = value => known(value) ? new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 1 }).format(value) : "—";
  const rate = value => known(value) ? `${number(value * 100)}%` : "—";
  const money = value => known(value) ? `${number(value)}원` : "—";
  const dateValid = value => typeof value === "string" && /^20\d{2}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
  const kstDay = now => new Date(Number(now) + 9 * 3600000).toISOString().slice(0, 10);
  const monthEnd = month => { const [year, part] = month.split("-").map(Number); return new Date(Date.UTC(year, part, 0)).toISOString().slice(0, 10); };
  const defaultCutoff = (month, today) => MONTH.test(month || "") && monthEnd(month) < today ? monthEnd(month) : today;
  const dataThroughDay = (catalog, keyword, month) => { const provenance = catalog?.keywords?.find(row => row.keyword === keyword)?.provenanceByMonth?.[month] || catalog?.provenance; return dateValid(provenance?.dataThrough) ? provenance.dataThrough : Number.isFinite(Date.parse(provenance?.dataThrough || "")) ? kstDay(Date.parse(provenance.dataThrough)) : catalog?.currentDay || kstDay(Date.now()); };
  const cutoffFor = (catalog, keyword, month) => { const recorded = catalog?.keywords.find(row => row.keyword === keyword)?.defaultCutoffs?.[month]; return dateValid(recorded) ? recorded : [defaultCutoff(month, catalog.currentDay), dataThroughDay(catalog, keyword, month)].sort()[0]; };
  const phaseLabel = (month, currentMonth) => !MONTH.test(month || "") ? "자료 선택 전" : month > currentMonth ? "사전 관측" : month === currentMonth ? "누적 중" : "마감된 월";
  const message = value => typeof value === "string" ? value : value?.message || value?.reason || value?.code || "확인 필요";
  const hasDiagnostic = (rows, code) => rows.some(value => value === code || value?.code === code);
  const timeLabel = value => dateValid(value) ? value : typeof value === "string" && /(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value)) ? new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) : "미확인";
  function normalizeOptions(value = {}, today = kstDay(Date.now())) {
    const currentDay = dateValid(value.currentDay) ? value.currentDay : today;
    const keywords = [], seen = new Set();
    for (const row of Array.isArray(value.keywords) ? value.keywords : []) {
      const keyword = typeof row?.keyword === "string" ? row.keyword : "";
      if (!keyword || keyword.length > 300 || seen.has(keyword)) continue;
      seen.add(keyword);
      const cutoffs = values => Object.fromEntries(Object.entries(values && typeof values === "object" ? values : {}).filter(([month, day]) => MONTH.test(month) && dateValid(day) && day <= currentDay));
      keywords.push({ keyword, stayMonths: [...new Set((Array.isArray(row.stayMonths) ? row.stayMonths : []).filter(month => typeof month === "string" && MONTH.test(month)))].sort().reverse(),
        collectionMonths: [...new Set((Array.isArray(row.collectionMonths) ? row.collectionMonths : []).filter(month => typeof month === "string" && MONTH.test(month)))].sort().reverse(),
        defaultCutoffs: cutoffs(row.defaultCutoffs), supportedCutoffs: row.supportedCutoffs && typeof row.supportedCutoffs === "object" ? cutoffs(row.supportedCutoffs) : null,
        provenanceByMonth: Object.fromEntries(Object.entries(row.provenanceByMonth || {}).filter(([month, item]) => MONTH.test(month) && item && typeof item === "object" && Number.isFinite(Date.parse(item.dataThrough || ""))).map(([month, item]) => [month, { dataThrough: item.dataThrough }])) });
    }
    return { status: value.status || "needs_verification", currentDay, currentMonth: MONTH.test(value.currentMonth || "") ? value.currentMonth : currentDay.slice(0, 7), keywords, provenance: value.provenance || null, diagnostics: Array.isArray(value.diagnostics) ? value.diagnostics : [] };
  }
  function metricView(value = {}) {
    value = value && typeof value === "object" ? value : {};
    const observed = known(value.coveredCompanyDays) && value.coveredCompanyDays > 0;
    return { ...value, supply: observed && known(value.supply) ? value.supply : null, sold: observed && known(value.sold) ? value.sold : null,
      publicBookings: observed && known(value.publicBookings) ? value.publicBookings : null, phoneBookings: observed && known(value.phoneBookings) ? value.phoneBookings : null,
      reservationRate: observed && known(value.reservationRate) ? value.reservationRate : null,
      estimatedRevenue: observed && known(value.estimatedRevenue) ? value.estimatedRevenue : null,
      publicRevenue: observed && known(value.publicRevenue) ? value.publicRevenue : null, phoneRevenue: observed && known(value.phoneRevenue) ? value.phoneRevenue : null,
      coverageRate: known(value.coverageRate) ? value.coverageRate : null, observed };
  }
  function calendarCells(month, daily, product) {
    if (!MONTH.test(month || "") || !PRODUCTS[product]) return [];
    const [year, part] = month.split("-").map(Number), firstWeekday = new Date(Date.UTC(year, part - 1, 1)).getUTCDay();
    const days = Number(monthEnd(month).slice(8)), byDate = new Map((Array.isArray(daily) ? daily : []).map(row => [row.date, row]));
    return Array.from({ length: Math.ceil((firstWeekday + days) / 7) * 7 }, (_, index) => {
      const day = index - firstWeekday + 1;
      if (day < 1 || day > days) return null;
      const date = `${month}-${String(day).padStart(2, "0")}`, value = metricView(byDate.get(date)?.[product]);
      return { date, day, observed: value.observed, reservationRate: value.observed ? value.reservationRate : null, coverageRate: value.observed ? value.coverageRate : null };
    });
  }
  function buildViewModel(payload = {}, selection = {}, currentMonth = "") {
    const request = payload.request || {}, snapshot = payload.snapshot;
    const scopeMatches = request.keyword === selection.keyword && request.month === selection.month && request.cutoffDate === selection.cutoffDate;
    const snapshotMatches = snapshot?.request?.type === "keyword" && snapshot.request.targetId === selection.keyword && snapshot.request.month === selection.month && snapshot.request.cutoffDate === selection.cutoffDate;
    const rows = Array.isArray(snapshot?.daily) ? snapshot.daily : [];
    const dates = rows.map(row => row.date);
    const dailyValid = dates.every(day => dateValid(day) && day.startsWith(`${selection.month}-`)) && new Set(dates).size === dates.length;
    const diagnostics = [...(Array.isArray(payload.diagnostics) ? payload.diagnostics : [])];
    // An expired preparation remains inspectable as historical evidence. It is
    // never relabelled fresh, and a cutoff beyond that evidence stays blocked.
    const historicalSnapshot = payload.status === "stale" && hasDiagnostic(diagnostics, "PROJECTION_EXPIRED")
      && !hasDiagnostic(diagnostics, "CUTOFF_AFTER_DATA_THROUGH") && Number.isFinite(Date.parse(payload.provenance?.dataThrough || ""))
      && selection.cutoffDate <= dataThroughDay({ provenance: payload.provenance });
    const eligible = payload.status === "available" || historicalSnapshot;
    const usable = eligible && scopeMatches && snapshotMatches && dailyValid;
    const status = eligible && !usable ? "needs_verification" : payload.status || "needs_verification";
    if (eligible && !usable) diagnostics.push({ code: "KEYWORD_MONTHLY_RESPONSE_MISMATCH", message: "응답의 검색어·숙박월·관측 마감일 또는 일별 자료를 확인해야 합니다." });
    return { usable, status, historicalSnapshot: usable && historicalSnapshot, phase: phaseLabel(selection.month, currentMonth), diagnostics,
      snapshot: usable ? snapshot : null, summary: usable ? { lodging: metricView(snapshot.summary?.lodging), dayuse: metricView(snapshot.summary?.dayuse) } : null,
      daily: usable ? rows.map(row => ({ date: row.date, lodging: metricView(row.lodging), dayuse: metricView(row.dayuse) })) : [],
      companies: usable && Array.isArray(snapshot.companies) ? snapshot.companies : [],
      comparison: usable ? snapshot.comparison || null : null,
      comparisons: usable ? { lodging: Object.hasOwn(snapshot.comparisonByProduct || {}, "lodging") ? snapshot.comparisonByProduct.lodging : snapshot.comparison || null,
        dayuse: snapshot.comparisonByProduct?.dayuse?.productType === "dayuse" ? snapshot.comparisonByProduct.dayuse : null } : { lodging: null, dayuse: null },
      activity: usable && payload.activity?.basis === "collection_month" && Array.isArray(payload.activity.rows) ? payload.activity.rows : [],
      activityScope: typeof payload.activity?.scope === "string" ? payload.activity.scope : "제공 run 집합에서 확인한 고유 회차", runInventoryComplete: payload.activity?.runInventoryComplete === true,
      latestAttempt: payload.latestAttempt || null, lastSuccessfulAttempt: payload.lastSuccessfulAttempt || null, provenance: payload.provenance || null, supportedCutoffDate: dateValid(payload.supportedCutoffDate) ? payload.supportedCutoffDate : null };
  }
  function mount(parent, options = {}) {
    if (!parent || typeof document === "undefined") return null;
    if (instances.has(parent)) return instances.get(parent);
    const doc = parent.ownerDocument || document, win = options.window || root, request = options.fetch || win.fetch.bind(win), now = options.now || Date.now;
    let sequence = 0, active = null, destroyed = false, paused = false, loading = false, phase = "", error = "", catalog = null, payload = null, keyword = "", month = "", cutoffDate = "", product = "lodging", pendingContext = null;
    const el = (tag, cls = "", text = "") => { const node = doc.createElement(tag); node.className = cls; node.textContent = text; return node; };
    const button = (label, handler, cls = "secondary-button") => { const node = el("button", cls, label); node.type = "button"; node.addEventListener("click", handler); return node; };
    const panel = el("section", "keyword-monthly-analysis monthly-reports"); panel.setAttribute("aria-label", "키워드 월별 누적 분석");
    const header = el("header", "mr-intro"), title = el("div"), badge = el("span", "mr-private-label", "관리자 전용 · 저장 자료 조회");
    title.append(el("p", "mr-eyebrow", "KEYWORD MONTHLY"), el("h2", "", "키워드 월별 누적 분석"), el("p", "", "반복 수집한 관측에서 같은 업체·숙박일의 최신 유효 자료를 한 번만 반영합니다.")); header.append(title, badge); panel.append(header);
    const filters = el("form", "mr-card kma-filters"); filters.setAttribute("aria-label", "키워드 월별 조회 조건");
    function field(label, tag, name) { const wrap = el("label"), input = el(tag); input.name = name; wrap.append(el("span", "", label), input); filters.append(wrap); return input; }
    const keywordInput = field("검색어 · 정확한 키워드", "select", "keyword"), monthInput = field("숙박월 · 관측 자료가 있는 월", "select", "month"), cutoffInput = field("관측 마감일 · 한국시간", "input", "cutoffDate"); cutoffInput.type = "date";
    const cutoffNote = el("small", "kma-cutoff-note"); cutoffInput.parentNode.append(cutoffNote);
    const readButton = button("저장 자료 조회", () => { void load(); }, "primary-button"); filters.append(readButton); panel.append(filters);
    const productTabs = el("div", "kma-product-tabs"); productTabs.setAttribute("role", "group"); productTabs.setAttribute("aria-label", "상품 유형");
    const productButtons = {};
    for (const [key, info] of Object.entries(PRODUCTS)) { const node = button(info.label, () => { product = key; render(); }, "kma-product-button"); productButtons[key] = node; productTabs.append(node); }
    panel.append(productTabs);
    const notice = el("p", "mr-notice kma-notice"); notice.setAttribute("role", "status"); notice.setAttribute("aria-live", "polite"); panel.append(notice);
    const errors = el("div", "mr-error kma-error"); errors.hidden = true; errors.setAttribute("role", "alert"); panel.append(errors);
    const results = el("div", "kma-results"); panel.append(results); parent.append(panel);
    const allowed = () => typeof options.isAdmin === "function" ? options.isAdmin() : Boolean(doc.body?.classList.contains("role-admin") && !doc.body?.classList.contains("admin-user-view"));
    const visible = () => !paused && allowed() && !doc.hidden && panel.getClientRects().length > 0;
    const current = token => !destroyed && token === sequence && allowed() && visible();
    const selected = () => ({ keyword, month, cutoffDate });
    function choices(input, rows, value, blank) { input.replaceChildren(); if (!rows.length) { const option = el("option", "", blank); option.value = ""; input.append(option); } else for (const row of rows) { const option = el("option", "", row.label); option.value = row.value; input.append(option); } input.value = value; }
    function renderControls() {
      choices(keywordInput, (catalog?.keywords || []).map(row => ({ value: row.keyword, label: row.keyword })), keyword, "선택 가능한 저장 검색어 없음");
      const months = catalog?.keywords.find(row => row.keyword === keyword)?.stayMonths || [];
      choices(monthInput, months.map(value => ({ value, label: `${value}${value > catalog.currentMonth ? " · 사전 관측" : value === catalog.currentMonth ? " · 누적 중" : ""}` })), month, "관측된 숙박월 없음");
      const supported = catalog?.keywords.find(row => row.keyword === keyword)?.supportedCutoffs?.[month];
      cutoffInput.value = cutoffDate; cutoffInput.min = supported || ""; cutoffInput.max = supported || [catalog?.currentDay || kstDay(now()), catalog ? dataThroughDay(catalog) : kstDay(now())].sort()[0]; cutoffInput.readOnly = Boolean(supported);
      cutoffNote.textContent = supported ? `선택 관측 사본 · ${supported} 마감만 지원` : catalog?.provenance?.dataThrough ? `저장 근거 마감 ${dataThroughDay(catalog)}` : "저장된 관측 근거 범위에서 조회";
      keywordInput.disabled = paused || !catalog?.keywords.length || !allowed() || phase === "options";
      monthInput.disabled = paused || !months.length || !allowed() || phase === "options"; cutoffInput.disabled = paused || !month || !allowed() || phase === "options";
      readButton.disabled = paused || !allowed() || !keyword || !month || !dateValid(cutoffDate) || phase === "options";
      for (const key of Object.keys(PRODUCTS)) productButtons[key].setAttribute("aria-pressed", String(product === key));
    }
    function card(label, value, detail = "", cls = "") { const node = el("div", `kma-metric ${cls}`); node.append(el("span", "", label), el("strong", "", value)); if (detail) node.append(el("small", "", detail)); return node; }
    function section(label, note = "") { const node = el("section", "mr-card kma-panel"), head = el("div", "mr-section-title"); head.append(el("h3", "", label)); node.append(head); if (note) node.append(el("p", "kma-note", note)); results.append(node); return node; }
    function table(parentNode, headers, rows, caption) { const wrap = el("div", "kma-table-wrap"), node = el("table", "kma-table"), head = el("thead"), line = el("tr"), body = el("tbody"); node.append(el("caption", "", caption)); for (const name of headers) { const cell = el("th", "", name); cell.scope = "col"; line.append(cell); } head.append(line); for (const row of rows) { const tr = el("tr"); row.forEach((value, index) => { const cell = el(index ? "td" : "th", "", value); if (!index) cell.scope = "row"; tr.append(cell); }); body.append(tr); } node.append(head, body); wrap.append(node); parentNode.append(wrap); return node; }
    function calendar(parentNode, rows, info) {
      const node = el("table", "kma-calendar"), head = el("thead"), headerRow = el("tr"), body = el("tbody");
      node.append(el("caption", "", `${month} ${info.label} · 숙박일별 달력 · 한국시간 날짜 기준`));
      for (const weekday of ["일", "월", "화", "수", "목", "금", "토"]) { const cell = el("th", "", weekday); cell.scope = "col"; headerRow.append(cell); }
      head.append(headerRow); node.append(head);
      const cells = calendarCells(month, rows, product);
      for (let offset = 0; offset < cells.length; offset += 7) {
        const line = el("tr");
        for (const value of cells.slice(offset, offset + 7)) {
          if (!value) { const blank = el("td", "kma-calendar-outside"); blank.setAttribute("aria-hidden", "true"); line.append(blank); continue; }
          const cell = el("td", `kma-calendar-cell${value.observed ? "" : " kma-calendar-missing"}`), date = el("time", "kma-calendar-day", String(value.day)); date.setAttribute("datetime", value.date);
          cell.setAttribute("data-date", value.date); cell.setAttribute("aria-label", `${value.date} · 예약 추정률 ${rate(value.reservationRate)} · 자료 충족률 ${rate(value.coverageRate)}${value.observed ? "" : " · 미관측"}`);
          cell.append(date, el("strong", "kma-calendar-rate", rate(value.reservationRate)), el("small", "kma-calendar-coverage", `충족 ${rate(value.coverageRate)}`));
          if (!value.observed) cell.append(el("small", "kma-calendar-state", "미관측"));
          line.append(cell);
        }
        body.append(line);
      }
      node.append(body); parentNode.append(el("p", "kma-note", "달력의 큰 값은 예약 추정률, 충족은 해당일 자료 충족률입니다. 회색 미관측 칸은 —이며, 실제 관측된 0%와 구분합니다."), node);
    }
    function warnings(parentNode, values) { if (!values?.length) return; const list = el("ul", "kma-warnings"); for (const value of values) list.append(el("li", "", message(value))); parentNode.append(list); }
    function render() {
      renderControls(); panel.setAttribute("aria-busy", String(loading)); results.replaceChildren();
      notice.textContent = loading ? phase === "options" ? "저장된 검색어와 숙박월을 확인하고 있습니다." : "선택한 조건의 저장 집계를 확인하고 있습니다." : "숙박월 성과와 수집월 실행 횟수는 별도 기준입니다. 조회는 수집이나 재집계를 시작하지 않습니다.";
      errors.hidden = !error; errors.textContent = error;
      if (!allowed() || loading || error || !payload) { if (!loading && !error && catalog && !catalog.keywords.length) section("조회할 저장 자료가 없습니다.", "검색어와 숙박월을 확인할 수 있는 근거가 없습니다. 누락을 정상 0건으로 표시하지 않습니다."); return; }
      const view = buildViewModel(payload, selected(), catalog?.currentMonth || kstDay(now()).slice(0, 7));
      if (catalog?.diagnostics.length) { const evidence = section("저장 자료 목록 확인사항", "일부 키워드·월의 준비 상태와 현재 선택한 집계 상태는 따로 확인합니다."); warnings(evidence, catalog.diagnostics); }
      if (!view.usable) { const labels = { missing: "조회용 저장 집계가 준비되지 않았습니다.", stale: "저장 집계의 갱신 확인이 필요합니다.", needs_verification: "자료 검수가 필요합니다." }; const label = hasDiagnostic(view.diagnostics, "CUTOFF_NOT_RECONSTRUCTIBLE") ? "선택한 마감일의 과거 상태를 재구성할 수 없습니다." : hasDiagnostic(view.diagnostics, "CUTOFF_AFTER_DATA_THROUGH") ? "관측 마감일이 사본의 자료 마감보다 늦습니다." : labels[view.status] || "집계 상태를 확인해야 합니다."; const block = section(label, "이전 저장값을 현재 정상 수치나 0으로 대신 표시하지 않습니다."); warnings(block, view.diagnostics); if (view.supportedCutoffDate) { block.append(el("p", "kma-note", `이 선택 관측 사본은 ${view.supportedCutoffDate} 마감만 확인할 수 있습니다.`)); if (view.supportedCutoffDate !== cutoffDate) block.append(button(`${view.supportedCutoffDate} 근거로 조회`, () => { cutoffDate = view.supportedCutoffDate; void load(); })); } if (view.provenance) block.append(el("p", "kma-note", `집계 생성 ${timeLabel(view.provenance.materializedAt)} · 자료 마감 ${timeLabel(view.provenance.dataThrough)}`)); return; }
      const snapshot = view.snapshot, info = PRODUCTS[product], metric = view.summary[product];
      if (view.historicalSnapshot) section("과거 저장근거 · 갱신 확인 필요", `집계 생성 ${timeLabel(view.provenance?.materializedAt)} · 자료 마감 ${timeLabel(view.provenance?.dataThrough)}. 아래 값은 이 저장 범위의 과거 집계이며 이후 수집 반영이나 현재 최신 상태를 확인한 값이 아닙니다.`);
      const heading = section(`${keyword} · ${month} · ${view.phase}`, `숙박일 기준 · 관측 마감 ${cutoffDate} (KST) · ${info.label}. ${view.phase === "사전 관측" ? "미래 숙박일을 미리 관측한 자료이며 최종 예약·매출이 아닙니다." : "월의 종료와 자료 충족도는 별도입니다."}`);
      const metrics = el("div", "kma-metrics"); metrics.append(card("월 표본 업체", `${number(snapshot.companies?.length)}곳`), card(`예약 추정 / 공급 (${info.unit})`, `${number(metric.sold)} / ${number(metric.supply)}`), card("관측 예약 추정률", rate(metric.reservationRate)), card(metric.revenuePartial ? "가격 확인 부분 소계" : "추정 매출", money(metric.estimatedRevenue), "실제 결제 매출과 다름"), card("자료 충족률", rate(metric.coverageRate), `유효 관측 ${number(metric.coveredCompanyDays)} / 기대 ${number(metric.expectedCompanyDays)} 업체·일`)); heading.append(metrics);
      const split = el("div", "kma-split"); split.append(card("공개 예약", `${number(metric.publicBookings)} ${info.unit}`, money(metric.publicRevenue), "mr-public"), card("방막기·타채널 추정", `${number(metric.phoneBookings)} ${info.unit}`, money(metric.phoneRevenue), "mr-phone")); heading.append(split);
      if (known(metric.knownPartialRevenue) && metric.knownPartialRevenue > 0) heading.append(el("p", "kma-note", `수량이 불완전한 자료에서 확인한 별도 금액 ${money(metric.knownPartialRevenue)} · 위 소계에 다시 더하지 않습니다.`));
      const daily = section("일별 관측 추이", `날짜는 숙박일입니다. 누락은 —로 남기며, ${info.label} 수량은 일별 ${info.dailyUnit}입니다.`);
      calendar(daily, view.daily, info);
      table(daily, ["숙박일", `공급 (${info.dailyUnit})`, `예약 추정 (${info.dailyUnit})`, "관측 예약 추정률", "자료 충족률", "가격 확인 소계"], view.daily.map(row => { const value = row[product]; return [row.date, number(value.supply), number(value.sold), rate(value.reservationRate), rate(value.coverageRate), money(value.estimatedRevenue)]; }), "숙박일별 최신 유효 관측 · 미관측 값을 연결하거나 0으로 채우지 않음");
      const companies = section("업체별 월간 소계", "같은 업체·숙박일의 반복 수집을 다시 더하지 않습니다. 순위만 관측된 업체의 수량과 가격은 미확인으로 남깁니다.");
      table(companies, ["업체", `공급 (${info.unit})`, `예약 추정 (${info.unit})`, "관측 예약 추정률", "자료 충족률", "가격 확인 소계"], view.companies.map(company => { const value = metricView(company.summary?.[product]); return [company.primaryName || company.name || company.companyName || company.companyId || "업체명 미확인", number(value.supply), number(value.sold), rate(value.reservationRate), rate(value.coverageRate), money(value.estimatedRevenue)]; }), "저장된 업체 고유번호 기준 · 표본 소계이며 지역 전체 시장 규모와 다름");
      const comparison = section("전월 공통 표본 비교", "동일 업체·대응 숙박일 중 공급·공유 기준과 관측 선행일수가 같은 표본만 비교합니다."); comparison.className += " kma-comparison";
      const prior = view.comparisons[product], matched = prior?.common?.matched;
      const previousObserved = prior?.all?.previous?.coveredCompanyDays > 0 || prior?.common?.companyCount > 0
        || Array.isArray(prior?.previousSources?.observations) && prior.previousSources.observations.some(row => row.productType === product);
      const directlyComparable = prior && prior.status !== "unavailable" && known(matched?.companyDays) && matched.companyDays > 0;
      comparison.append(el("p", "kma-note kma-comparison-status", `공통 관측 업체 ${number(prior?.common?.companyCount)}곳 · 조건 맞는 업체·일 ${number(matched?.companyDays)}`));
      table(comparison, ["비교 표본과 제외 사유", "업체·일 / 업체 수"], [
        ["전월 유효 관측 업체·일", number(prior?.all?.previous?.coveredCompanyDays)],
        ["선택월 유효 관측 업체·일", number(prior?.all?.current?.coveredCompanyDays)],
        ["공통 관측 업체", number(prior?.common?.companyCount)],
        ["조건 맞는 업체·일", number(matched?.companyDays)],
        [`대응 ${product === "dayuse" ? "이용일" : "숙박일"} 없음`, number(matched?.exclusions?.missingCorrespondingDay)],
        ["공급·공유·산정 기준 변경", number(matched?.exclusions?.capacityOrSharingChanged)],
        ["관측 선행일수 변경", number(matched?.exclusions?.observationTimingChanged)]
      ], "제외 사유는 공통 업체의 선택월 관측 기준 · 저장 근거가 없는 값은 —").className += " kma-comparison-evidence";
      if (!directlyComparable) comparison.append(el("p", "kma-note", previousObserved
        ? `전월 ${info.label} 관측 자료는 있지만 ${matched?.companyDays === 0 ? "조건이 맞는 표본이 없어" : "조건이 맞는 비교 표본을 확인하지 못해"} 직접 비교할 수 없습니다. 예약·매출 증감을 0으로 계산하지 않습니다.`
        : `확인 가능한 ${info.label} 전월 관측 근거가 없습니다. 전월 값과 증감을 0으로 대신 계산하지 않습니다.`));
      else { table(comparison, ["공통 조건 표본", prior.previousMonth || "전월", prior.currentMonth || "선택월", "증감"], [
        [`예약 추정 (${info.unit})`, number(matched.previous?.sold), number(matched.current?.sold), known(matched.deltas?.sold) ? `${matched.deltas.sold > 0 ? "+" : ""}${number(matched.deltas.sold)}` : "비교 불가"],
        ["가격 확인 소계", money(matched.previous?.estimatedRevenue), money(matched.current?.estimatedRevenue), known(matched.deltas?.estimatedRevenue) ? `${matched.deltas.estimatedRevenue > 0 ? "+" : ""}${money(matched.deltas.estimatedRevenue)}` : "비교 불가"]
      ], `조건 일치 ${number(matched.companyDays)} 업체·일에서만 증감 계산`); }
      if (prior) {
        const names = new Map(view.companies.map(company => [company.companyId, company.primaryName || company.name || company.companyName || company.companyId]));
        if (prior.all?.previous?.coveredCompanyDays > 0 && prior.all?.current?.coveredCompanyDays > 0) for (const [label, ids] of [["이번 달 신규 관측", prior.newlyObservedCompanyIds], ["전월에만 관측", prior.noLongerObservedCompanyIds]]) { const values = Array.isArray(ids) ? ids : null; comparison.append(el("p", "kma-note", `${label}: ${values ? `${number(values.length)}곳${values.length ? ` · ${values.slice(0, 20).map(id => names.get(id) || id).join(", ")}${values.length > 20 ? " 외" : ""}` : ""}` : "미확인"}`)); }
        else comparison.append(el("p", "kma-note", "양월의 업체 관측 표본이 부족해 신규·미관측 변화를 판단하지 않습니다."));
        comparison.append(el("p", "kma-note", "신규 관측·전월에만 관측된 업체는 개업·폐업·검색 순위 이탈을 뜻하지 않습니다.")); warnings(comparison, prior.warnings);
      }
      const quality = section("자료 충족도와 최근 수집 상태", "자료 충족률은 유효 관측 범위이며 최종 예약·실제 결제 매출의 확정 여부와 다릅니다.");
      const qualityStatus = { complete: "자료 충족", partial: "일부 자료", insufficient: "자료 부족" }[snapshot.quality?.status] || "상태 미확인";
      const attemptLabel = { complete: "완료", completed: "완료", reused: "재사용", partial: "일부 자료", failed: "실패", blocked: "차단", interrupted: "중단", running: "진행 중", unknown: "미확인", uncertain: "확인 필요" }[view.latestAttempt?.status] || "미확인";
      if (["failed", "blocked", "interrupted"].includes(view.latestAttempt?.status)) notice.textContent = `${view.historicalSnapshot ? "과거 저장근거 · 갱신 확인 필요. " : ""}사본에서 확인한 최근 회차 ${attemptLabel} · ${timeLabel(view.latestAttempt.observedAt)}. 선택월 수치는 마지막 유효 관측 근거를 표시합니다.`;
      table(quality, ["항목", "저장 근거"], [["집계 품질", qualityStatus], ["같은 날 관측 업체·일", number(metric.sameDayObservedCompanyDays)], ["사전 관측 업체·일", number(metric.staleDays)], ["가격 근거 충족률", rate(metric.revenueCoverageRate)], ["사본에서 확인한 최근 회차", view.latestAttempt ? `${attemptLabel} · ${timeLabel(view.latestAttempt.observedAt)}${view.latestAttempt.errorCode ? ` · ${view.latestAttempt.errorCode}` : ""}` : "미확인"], ["마지막 유효 관측", timeLabel(view.lastSuccessfulAttempt?.observedAt)]], "포함된 최근 회차와 선택월의 마지막 유효 관측을 구분");
      warnings(quality, [...(snapshot.quality?.warnings || []), ...view.diagnostics]);
      const activity = section("사본에 포함된 고유 관측 회차", "수집월 기준의 제공 run 집합입니다. 숙박월 예약·매출에 합산하지 않으며, 재사용은 새 수집과 구분합니다.");
      activity.append(el("p", "kma-note", `${view.activityScope}${view.runInventoryComplete ? "" : " · 전체 시도·실패 목록은 미확인입니다. 실패 0도 이 사본 범위의 기록만 뜻합니다."}`));
      if (view.activity.length) table(activity, ["수집월", "포함 회차", "신규 근거", "재사용 근거", "실패 기록", "일부 자료", "미확인"], view.activity.map(row => [row.month, number(row.runCount), number(row.freshRunCount), number(row.reusedRunCount), number(row.failedRunCount), number(row.partialRunCount), number(row.unknownRunCount)]), "한국시간 수집월 기준 · 포함 회차가 많다는 이유만으로 신뢰도를 높이지 않음");
      else activity.append(el("p", "kma-note", "사본에 포함된 수집월별 관측 회차 근거가 없습니다."));
      const sources = section("출처와 채택·제외 근거", "같은 업체·숙박일·상품유형의 최신 유효 관측만 채택합니다. 회차별 스냅샷을 더하지 않습니다.");
      table(sources, ["근거", "값"], [["사본 내 채택 관측", number(snapshot.sources?.selectedObservationCount)], ["사본 내 제외 관측", number(snapshot.sources?.discardedObservationCount)], ["관측 정책", snapshot.sources?.observationPolicy || "미확인"]], "제공된 관측 범위에서 확인한 채택·제외 근거");
      const runs = Array.isArray(snapshot.sources?.runs) ? snapshot.sources.runs : [];
      if (runs.length) table(sources, ["수집 기록", "관측 시각 · KST", "채택 / 관측", "품질"], runs.slice(0, 40).map(run => [run.id || run.runId || "미확인", timeLabel(run.collectedAt), `${number(run.selectedObservationCount)} / ${number(run.observationCount)}`, run.collectionQuality?.status || "미확인"]), `출처 ${number(runs.length)}개${runs.length > 40 ? " 중 40개 표시" : ""}`);
      const provenance = view.provenance || {};
      sources.append(el("p", "kma-note", `집계 생성 ${timeLabel(provenance.materializedAt)} · 자료 마감 ${timeLabel(provenance.dataThrough)} · 저장 집계 기준이며 원본의 최신 변경을 실시간으로 재검수한 값은 아닙니다.`));
      if (provenance.inputSha256) sources.append(el("p", "kma-note kma-source-fingerprint", `입력 근거 지문 ${provenance.inputSha256}`));
      const scopeLabels = { selected_only: "선택 관측 사본", normalized_multirun: "여러 회차 정규 관측 사본", verified_history_subset: "검증된 이력 부분 사본", unspecified: "확인 필요" };
      sources.append(el("p", "kma-note", `관측 범위 ${scopeLabels[provenance.observationScope] || "확인 필요"}${provenance.intermediateObservationsComplete === true ? "" : " · 중간 관측 전체 확보 여부는 미확인"}`));
      const reasonLabels = { duplicate_observation: "중복 관측", superseded_observation: "더 최신 유효 관측으로 대체", legacy_inventory_evidence: "구형 재고 근거", post_stay_observation: "숙박일 이후 관측", after_cutoff: "관측 마감 이후", missing_quantity: "수량 미확보", quantity_conflict: "수량 불일치", unknown_legacy_run_quality: "회차 품질 미확인", run_failed: "실패 회차", run_blocked: "차단 회차" };
      const reasons = Object.entries(snapshot.quality?.discardedByReason || {}).filter(([, count]) => known(count) && count > 0);
      if (reasons.length) table(sources, ["제외 사유", "관측 수"], reasons.map(([reason, count]) => [reasonLabels[reason] || reason, number(count)]), "제외 관측을 정상 0건으로 바꾸지 않음");
      warnings(sources, (snapshot.sources?.excludedRuns || []).map(row => ({ message: `${row.id || "수집 기록"} · ${row.reason || row.status || "제외 사유 미확인"}` })));
    }
    function cancel() { sequence++; active?.abort(); active = null; loading = false; phase = ""; }
    function clearPrivate(reason = "관리자 로그인이 필요합니다.") { cancel(); paused = true; catalog = null; payload = null; keyword = month = cutoffDate = ""; pendingContext = null; error = reason; render(); }
    async function get(url, token) {
      const response = await request(url, { method: "GET", credentials: "same-origin", cache: "no-store", headers: { Accept: "application/json" }, ...(active ? { signal: active.signal } : {}) });
      if (!current(token)) return null;
      if ([401, 403].includes(response.status)) { clearPrivate(); return null; }
      const value = await response.json(); if (!current(token)) return null;
      if (!response.ok && !["missing", "stale", "needs_verification"].includes(value?.status)) throw new Error(`저장 자료를 확인하지 못했습니다 (${response.status}).`);
      return value;
    }
    function applyCatalog(value, context) {
      catalog = normalizeOptions(value, kstDay(now()));
      if (catalog.status !== "available" && !(catalog.status === "stale" && (hasDiagnostic(catalog.diagnostics, "PROJECTION_EXPIRED") || hasDiagnostic(catalog.diagnostics, "KEYWORD_MONTHLY_BUNDLE_STALE_PARTITIONS_PRESENT")))) { error = [...catalog.diagnostics.map(message), "저장된 검색어·숙박월 목록을 확인하지 못했습니다."].join(" "); catalog = null; return false; }
      const requested = context || {};
      keyword = typeof requested.keyword === "string" ? requested.keyword : catalog.keywords.some(row => row.keyword === keyword) ? keyword : catalog.keywords[0]?.keyword || "";
      const row = catalog.keywords.find(item => item.keyword === keyword);
      if (!row) { if (catalog.keywords.length) error = "저장 목록에 있는 정확한 검색어를 선택하세요."; keyword = month = cutoffDate = ""; return false; }
      month = typeof requested.month === "string" ? requested.month : row.stayMonths.includes(month) ? month : row.stayMonths.includes(catalog.currentMonth) ? catalog.currentMonth : row.stayMonths[0] || "";
      if (!row.stayMonths.includes(month)) { error = "선택한 검색어에 실제 숙박 관측이 있는 월을 선택하세요."; month = cutoffDate = ""; return false; }
      cutoffDate = requested.cutoffDate || cutoffFor(catalog, keyword, month); return true;
    }
    async function load(context) {
      if (destroyed || !visible()) return;
      cancel(); payload = null; error = ""; loading = true; phase = "data"; active = typeof AbortController === "function" ? new AbortController() : null; const token = sequence;
      try {
        if (!catalog) { phase = "options"; render(); const value = await get("/api/keyword-monthly/options", token); if (!value || !current(token)) return; if (!applyCatalog(value, context || pendingContext)) return; }
        else if (context && !applyCatalog(catalog, context)) return;
        if (!keyword || !month) return;
        if (!catalog.keywords.some(row => row.keyword === keyword && row.stayMonths.includes(month))) throw new Error("저장 목록에 있는 정확한 검색어와 실제 관측 숙박월을 선택하세요.");
        if (!dateValid(cutoffDate) || cutoffDate > catalog.currentDay) throw new Error("관측 마감일은 오늘 이하의 유효한 날짜로 선택하세요.");
        phase = "data"; render();
        const params = new URLSearchParams({ keyword, month, cutoffDate }); const value = await get(`/api/keyword-monthly?${params}`, token);
        if (value && current(token)) payload = value;
      } catch (failure) { if (current(token)) error = failure.name === "AbortError" ? "조회가 취소됐습니다." : failure.message || "저장 자료를 확인하지 못했습니다."; }
      finally { if (token === sequence && !destroyed) { loading = false; phase = ""; active = null; render(); } }
    }
    async function open(context = null) { paused = false; pendingContext = context; catalog = null; return load(context); }
    keywordInput.addEventListener("change", () => { keyword = keywordInput.value; const row = catalog?.keywords.find(item => item.keyword === keyword); month = row?.stayMonths.includes(catalog.currentMonth) ? catalog.currentMonth : row?.stayMonths[0] || ""; cutoffDate = month ? cutoffFor(catalog, keyword, month) : ""; pendingContext = null; void load(); });
    monthInput.addEventListener("change", () => { month = monthInput.value; cutoffDate = cutoffFor(catalog, keyword, month); pendingContext = null; void load(); });
    cutoffInput.addEventListener("change", () => { cutoffDate = cutoffInput.value; pendingContext = null; void load(); });
    filters.addEventListener("submit", event => { event.preventDefault(); void load(); });
    const onVisibility = () => { if (!visible()) { if (loading) { cancel(); render(); } } else if (!loading && (!catalog || !payload)) { if (catalog) void load(); else void open(pendingContext); } };
    const observer = typeof MutationObserver === "function" ? new MutationObserver(() => { if (!allowed()) clearPrivate(); else if (visible() && !catalog && !loading) void open(pendingContext); }) : null;
    observer?.observe(doc.body, { attributes: true, attributeFilter: ["class"] }); doc.addEventListener("visibilitychange", onVisibility);
    const controller = { open, refresh: () => load(), pause() { cancel(); paused = true; payload = null; render(); }, clear: clearPrivate,
      state: () => ({ selection: selected(), product, loading, paused, status: payload?.status || null }),
      destroy() { if (destroyed) return; clearPrivate(""); destroyed = true; observer?.disconnect(); doc.removeEventListener("visibilitychange", onVisibility); panel.replaceChildren(); controllers.delete(controller); instances.delete(parent); } };
    controllers.add(controller); instances.set(parent, controller);
    render(); if (options.autoStart !== false && visible()) void open(options.context || null); return controller;
  }
  const api = { mount, normalizeOptions, metricView, calendarCells, buildViewModel, number, rate, money, dateValid, defaultCutoff, dataThroughDay, cutoffFor, phaseLabel,
    show(parent, context) { if (!parent) return null; const controller = instances.get(parent) || mount(parent, { autoStart: false }); return controller.open(context); },
    pause(parent) { if (parent) instances.get(parent)?.pause(); else for (const controller of controllers) controller.pause(); },
    clear() { for (const controller of controllers) controller.clear(); } };
  root.KeywordMonthlyAnalysis = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window === "undefined" ? globalThis : window);
