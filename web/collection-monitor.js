(function () {
  "use strict";
  const DAY_MS = 86400000, KST_MS = 9 * 3600000;
  const TONES = {
    complete: { label: "정상 완료", symbol: "✓" }, pending: { label: "대기·예정", symbol: "○" },
    running: { label: "진행 중", symbol: "↻" }, issue: { label: "문제", symbol: "!" },
    unknown: { label: "확인 필요", symbol: "?" }
  };
  function validDay(day) { return typeof day === "string" && /^\d{4}-\d{2}-\d{2}$/.test(day) && day >= "2000-01-01" && day <= "2099-12-31" && Number.isFinite(Date.parse(day + "T00:00:00Z")) && new Date(day + "T00:00:00Z").toISOString().slice(0, 10) === day; }
  function addDays(day, count) { return new Date(Date.parse(day + "T00:00:00Z") + count * DAY_MS).toISOString().slice(0, 10); }
  function kstDay(now = Date.now()) { return new Date(now + KST_MS).toISOString().slice(0, 10); }
  function weekStart(day) { if (!validDay(day)) return weekStart(kstDay()); const weekday = new Date(day + "T00:00:00Z").getUTCDay(); return addDays(day, -(weekday + 6) % 7); }
  function time(value, withDate = false) { const stamp = Date.parse(value || ""); return Number.isFinite(stamp) ? new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", ...(withDate ? { month: "numeric", day: "numeric" } : {}), hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(stamp) : "미확인"; }
  const workerLabel = key => ({ web: "중앙 웹", manual: "BG 워커" }[key] || "수집기 미확인");
  const itemKey = item => [item.id, item.workerKey, item.keyword].join("|");
  function postprocessBound(item = {}) { const db = item.postprocess || {}; return Boolean(item.id && item.runId && db.runId === item.runId && db.scheduleOccurrenceId === item.id && db.bindingVerified !== false); }
  function coverageFor(snapshot = {}, day) { return (snapshot.coverage?.days || []).find(value => value.day === day) || { day, status: "missing", count: null, dailySlots: null }; }
  function cellPlaceholder(snapshot, day, filtered = false) { const coverage = coverageFor(snapshot, day); return filtered ? "—" : coverage.status === "not_started" ? "시작 전" : coverage.status === "saved" && coverage.count === 0 ? "배정 확인 필요" : ["saved", "available", "projected"].includes(coverage.status) ? "—" : "기록 미확인"; }
  function conditionDays(item = {}) { const days = item.conditions?.bookingDays ?? item.conditions?.bookingRangeDays ?? item.bookingDays ?? item.bookingRangeDays; return Number.isInteger(days) && days > 0 ? `${days}일` : "미확인"; }
  function conditionRanks(item = {}) { const ranks = item.conditions?.detailRankRanges ?? item.detailRankRanges; return typeof ranks === "string" && /^\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*$/.test(ranks) ? `${ranks.replaceAll("-", "–").replaceAll(",", ", ")}위` : "미확인"; }
  function allocationLabel(item = {}) { return item.projected ? "예정(계산)" : item.planKind === "one_day_trial" ? "저장 배정 · 1일 시험" : "저장 배정"; }
  function classify(item = {}, now = Date.now()) {
    const state = item.status, quality = item.collectionQuality || {}, db = item.postprocess || {}, dbState = db.state || db.status;
    const dbBound = postprocessBound(item);
    if (item.projected) return { tone: "pending", label: "예정(계산)", note: "현재 설정으로 계산한 예정이며 확정 배정·실행 기록이 아닙니다." };
    if (["failed", "blocked", "partial", "missed", "interrupted", "error"].includes(state)) return { tone: "issue", label: ({ failed: "수집 실패", blocked: "접근 제한", partial: "일부 누락", missed: "미실행", interrupted: "중단" }[state] || "오류"), note: "저장된 수집 결과에 문제가 있습니다." };
    if (["failed", "blocked", "partial"].includes(quality.status) || quality.blockedReason || quality.failure) return { tone: "issue", label: "품질 확인 필요", note: "품질 검사에서 오류·누락이 확인됐습니다." };
    if (dbBound && dbState === "failed") return { tone: "issue", label: "DB 반영 실패", note: "수집 결과와 DB 반영 상태를 따로 확인하세요." };
    if (["uncertain", "unknown", "review"].includes(state)) return { tone: "unknown", label: "실행 확인 필요", note: "실행 여부를 확정할 기록이 없습니다." };
    if (state === "running") return { tone: "running", label: "수집 중", note: "저장된 실행 상태입니다. 완료 결과는 아직 없습니다." };
    if (["complete", "completed", "reused"].includes(state)) {
      if (!item.runId || quality.status !== "complete" || item.errorCode) return { tone: "unknown", label: "결과 확인 필요", note: "수집 결과·품질·실행 연결을 모두 확인하지 못했습니다." };
      if (!dbBound) return { tone: "unknown", label: "DB 기록 미확인", note: "같은 실행·배정의 DB 반영 기록이 확인되지 않습니다." };
      if (["held", "queued", "pending", "waiting"].includes(dbState)) return { tone: "running", label: "DB 반영 대기", note: "수집은 끝났고 DB 반영을 기다립니다." };
      if (dbState === "running") return { tone: "running", label: "DB 반영 중", note: "수집은 끝났고 DB에 반영하고 있습니다." };
      if (dbState !== "complete") return { tone: "unknown", label: "DB 기록 미확인", note: "DB 반영 완료를 확인하지 못했습니다." };
      if (state === "reused") return { tone: "unknown", label: "기존 자료 사용", note: "새 수집과 구별합니다. 원래 관측시각을 확인하세요." };
      return { tone: "complete", label: "정상 완료", note: "같은 배정·실행의 수집, 품질 검사와 DB 반영이 완료됐습니다. 전체 월집계 완료와는 별도입니다." };
    }
    if (["queued", "pending", "scheduled", "planned", "waiting", "paused", "cancelled", "canceled"].includes(state)) {
      if (state === "paused" && item.errorCode && item.errorCode !== "ROTATION_PAUSED_BY_USER") {
        const uncertain = /UNCERTAIN|UNRESOLVED|UNKNOWN|RESTART/.test(item.errorCode);
        return { tone: uncertain ? "unknown" : "issue", label: uncertain ? "실행 확인 필요" : "문제로 보류", note: "자동 실행 조건을 충족하지 못해 보류됐습니다. 상세 기록에서 사유를 확인하세요." };
      }
      const due = Date.parse(item.notBeforeAt || item.scheduledAt || "");
      const label = state === "paused" ? "보류" : ["cancelled", "canceled"].includes(state) ? "취소" : Number.isFinite(due) && due < now ? "시작 대기" : "대기";
      return { tone: "pending", label, note: "예정 시각과 앞 작업 종료·실행 조건에 따라 시작합니다. 지연만으로 실패 판정하지 않습니다." };
    }
    return { tone: "unknown", label: "상태 미확인", note: "저장된 상태가 없거나 해석할 수 없습니다." };
  }
  function buildModel(snapshot = {}, filters = {}, now = Date.now()) {
    const from = validDay(snapshot.from) ? snapshot.from : weekStart(kstDay(now)), days = Array.from({ length: 7 }, (_, i) => addDays(from, i));
    const seen = new Set(), items = [];
    for (const item of snapshot.items || []) {
      if (!item || !days.includes(item.day) || !item.id || !item.keyword) continue;
      const key = itemKey(item); if (seen.has(key)) continue; seen.add(key);
      items.push({ ...item, visual: classify(item, now) });
    }
    items.sort((a, b) => (a.scheduledAt || "").localeCompare(b.scheduledAt || "") || a.id.localeCompare(b.id));
    const keywords = [...new Set([...(snapshot.keywords || []), ...items.map(x => x.keyword)])].filter(x => typeof x === "string" && x.length);
    const counts = Object.fromEntries(Object.keys(TONES).map(tone => [tone, items.filter(x => x.visual.tone === tone).length]));
    const visible = items.filter(x => (!filters.worker || x.workerKey === filters.worker) && (!filters.tone || x.visual.tone === filters.tone));
    const query = String(filters.query || "").trim().toLocaleLowerCase("ko-KR");
    const rows = keywords.filter(keyword => keyword.toLocaleLowerCase("ko-KR").includes(query) && ((!filters.worker && !filters.tone) || visible.some(x => x.keyword === keyword))).map(keyword => ({ keyword, cells: days.map(day => ({ day, items: visible.filter(x => x.keyword === keyword && x.day === day) })) }));
    const selectedDay = validDay(filters.day) && days.includes(filters.day) ? filters.day : days.includes(snapshot.today) ? snapshot.today : days[0];
    const dayItems = items.filter(item => item.day === selectedDay), visibleItems = visible.filter(item => item.keyword.toLocaleLowerCase("ko-KR").includes(query));
    return { from, to: days[6], days, rows, items, counts, actualCount: items.filter(x => !x.projected).length, projectedCount: items.filter(x => x.projected).length,
      selectedDay, dayItems, visibleDayItems: visibleItems.filter(item => item.day === selectedDay), visibleItems, dayCoverage: coverageFor(snapshot, selectedDay),
      coverageIncomplete: days.some(day => !["saved", "available", "projected", "not_started"].includes(coverageFor(snapshot, day).status)) };
  }
  const exported = { classify, buildModel, weekStart, kstDay, addDays, validDay, time, TONES, workerLabel, itemKey, postprocessBound, coverageFor, cellPlaceholder, conditionDays, conditionRanks, allocationLabel };
  if (typeof module === "object" && module.exports) module.exports = exported;
  if (typeof document === "undefined" || typeof window === "undefined") return;

  function mount(parent, options = {}) {
    if (!parent || document.getElementById("collectionWeeklyMonitor")) return;
    const preview = options.snapshot || null, standalone = Boolean(preview), clock = options.now || Date.now, request = options.fetch || window.fetch.bind(window);
    let snapshot = preview, selectedDay = validDay(preview?.today) ? preview.today : kstDay(clock()), selectedWeek = preview?.from || weekStart(selectedDay), loading = false, sequence = 0, destroyed = false, lastRead = 0, timer, selectedItem = null, lastError = "", focusTargets = new Map(), activeRequest = null, authBlocked = false, refreshPending = false;
    const filters = { query: "", worker: "", tone: "", day: selectedDay }, el = (tag, cls = "", text = "") => { const n = document.createElement(tag); n.className = cls; n.textContent = text; return n; };
    const root = el("section", "collection-monitor"); root.id = "collectionWeeklyMonitor"; root.setAttribute("aria-label", "요일·키워드별 정기 수집 현황");
    const header = el("header", "cm-header"), title = el("div"); title.append(el("p", "cm-eyebrow", "COLLECTION MONITOR"), el("h3", "", "정기 수집 현황"), el("p", "cm-subtitle", "요일과 키워드로 보는 수집 · 품질 · DB 반영 상태"));
    const connection = el("span", "cm-connection", standalone ? "실제 기록 미리보기" : "연결 확인 중"); header.append(title, connection); root.append(header);
    const notice = el("p", "cm-notice"); notice.setAttribute("role", "status"); root.append(notice);
    const bar = el("div", "cm-toolbar"), nav = el("div", "cm-week-nav");
    function button(label, action, cls = "cm-button") { const b = el("button", cls, label); b.type = "button"; b.addEventListener("click", action); return b; }
    const prev = button("‹", () => changeWeek(-7)), weekLabel = el("strong"), next = button("›", () => changeWeek(7)); prev.setAttribute("aria-label", "이전 주"); next.setAttribute("aria-label", "다음 주");
    const today = button("이번 주", () => selectDay(kstDay(clock())));
    nav.append(prev, weekLabel, next, today); const freshness = el("span", "cm-freshness"), refreshButton = button("새로고침", () => refresh(true));
    if (standalone) { prev.disabled = next.disabled = today.disabled = true; refreshButton.hidden = true; }
    bar.append(nav, freshness, refreshButton); root.append(bar);
    const daySection = el("section", "cm-day-section"), dayHeader = el("div", "cm-day-heading"), dayTitle = el("h4"), dateNav = el("div", "cm-date-nav");
    daySection.setAttribute("aria-label", "선택일 수집 배정");
    const prevDay = button("‹", () => selectDay(addDays(selectedDay, -1))), dayInput = el("input"), nextDay = button("›", () => selectDay(addDays(selectedDay, 1)));
    prevDay.setAttribute("aria-label", "이전 날짜"); nextDay.setAttribute("aria-label", "다음 날짜"); dayInput.type = "date"; dayInput.setAttribute("aria-label", "조회 날짜");
    dayInput.addEventListener("change", () => selectDay(dayInput.value)); dateNav.append(prevDay, dayInput, nextDay); dayHeader.append(dayTitle, dateNav);
    const dayCards = el("div", "cm-day-cards"), dayEmpty = el("p", "cm-empty"), dateError = el("p", "cm-date-error"); dateError.hidden = true; dateError.setAttribute("role", "alert");
    dayCards.setAttribute("aria-label", "선택일의 저장 배정 및 계산 예정"); daySection.append(dayHeader, dateError, dayCards, dayEmpty); root.append(daySection);
    const cards = el("div", "cm-summary"); cards.setAttribute("aria-label", "조회 주의 확인된 배정 상태별 합계 및 필터"); root.append(cards);
    const filterBar = el("div", "cm-filters");
    function select(label, entries, key) { const wrap = el("label"), input = el("select"); wrap.append(el("span", "", label), input); for (const [value, text] of entries) { const option = el("option", "", text); option.value = value; input.append(option); } input.addEventListener("change", () => { filters[key] = input.value; render(); }); filterBar.append(wrap); return input; }
    const searchLabel = el("label"), search = el("input"); search.type = "search"; search.placeholder = "키워드 검색"; searchLabel.append(el("span", "", "키워드"), search); search.addEventListener("input", () => { filters.query = search.value; render(); }); filterBar.append(searchLabel);
    const workerSelect = select("수집기", [["", "전체 수집기"], ["web", "중앙 웹"], ["manual", "BG 워커"]], "worker");
    const toneSelect = select("상태", [["", "전체 상태"], ...Object.entries(TONES).map(([k, v]) => [k, v.label])], "tone");
    const legend = el("div", "cm-legend"); for (const [tone, { label, symbol }] of Object.entries(TONES)) { const item = el("span", "cm-legend-item", `${symbol} ${label}`); item.dataset.tone = tone; legend.append(item); } filterBar.append(legend); root.append(filterBar);
    const tableWrap = el("div", "cm-table-wrap"); tableWrap.tabIndex = 0; tableWrap.setAttribute("aria-label", "주간 수집표. 좁은 화면에서는 좌우로 이동할 수 있습니다."); const table = el("table", "cm-table"); tableWrap.append(table); root.append(tableWrap);
    const empty = el("p", "cm-empty", "저장된 예약을 확인하고 있습니다."); root.append(empty);
    const detail = el("section", "cm-detail"); detail.hidden = true; detail.setAttribute("aria-label", "선택한 수집 상세"); root.append(detail);
    const footer = el("p", "cm-footnote", "녹색 = 수집·품질·같은 실행의 DB 반영 완료. 월집계 완료와 별도입니다. ‘예정(계산)’은 저장된 확정 배정과 구분합니다. 상태 합계는 확인된 배정 기준이며 기록이 없는 날짜는 미확인입니다. 표의 빈칸은 수집 실패나 예약 0건을 뜻하지 않습니다. 모든 시각은 한국시간입니다."); root.append(footer);
    const before = document.getElementById("collectionRotationPanel") || document.getElementById("collectorWorkerStates"); if (before?.parentNode === parent) parent.insertBefore(root, before); else parent.append(root);
    function allowed() { return standalone || (document.body.classList.contains("role-admin") && !document.body.classList.contains("admin-user-view")); }
    function visible() { return allowed() && !document.hidden && root.getClientRects().length > 0; }
    function focusTarget(node, key) { node.dataset.monitorFocus = key; focusTargets.set(key, node); return node; }
    function selectItem(item) { selectedItem = item; selectedDay = item.day; filters.day = selectedDay; render(); renderDetail(item, true); }
    function renderDetail(item, focus = true) {
      selectedItem = item; detail.replaceChildren(); if (!item) { detail.hidden = true; return; } detail.hidden = false;
      const top = el("div", "cm-detail-head"), name = focusTarget(el("h4", "", `${item.keyword} · ${item.day} · ${time(item.scheduledAt)}`), "detail-title"); name.tabIndex = -1;
      const close = focusTarget(button("닫기", () => { const key = selectedItem && itemKey(selectedItem); selectedItem = null; render(); focusTargets.get(`table:${key}`)?.focus({ preventScroll: true }); }), "detail-close");
      top.append(name, close); detail.append(top);
      const badge = el("strong", "cm-detail-state", item.visual.label); badge.dataset.tone = item.visual.tone; detail.append(badge, el("p", "", item.visual.note));
      const list = el("dl", "cm-detail-grid"), db = item.postprocess || {}, quality = item.collectionQuality || {}, bound = !item.projected && postprocessBound(item);
      const dbLabel = item.projected ? "실제 기록 미확인" : item.runId && !bound ? "기록 연결 미확인" : bound ? ({ complete: "완료", running: "반영 중", queued: "대기", held: "대기", failed: "실패" }[db.state || db.status] || "미확인") : "미확인";
      for (const [label, value] of [["수집기", workerLabel(item.workerKey)], ["배정", allocationLabel(item)], ["예정 시작 · KST", time(item.scheduledAt, true)], ["실제 시작", item.projected ? "미확인" : time(item.startedAt, true)], ["수집 종료", item.projected ? "미확인" : time(item.finishedAt, true)], ["품질 검사", item.projected ? "미확인" : quality.status === "complete" ? "완료" : quality.status || "미확인"], ["DB 반영", dbLabel], ["DB 반영 종료", bound ? time(db.finishedAt, true) : "미확인"], ["대기 가능 시각", time(item.notBeforeAt, true)], ["숙박 조회기간", conditionDays(item)], ["상세 조회순위", conditionRanks(item)], ["문제·대기 코드", item.errorCode || db.errorCode || db.lastErrorCode || db.admissionErrorCode || item.reason || "기록 없음"], ["실행 번호", !item.projected && item.runId || "미확인"], [item.projected ? "계산 식별자" : "배정 번호", item.id]]) { const pair = el("div"); pair.append(el("dt", "", label), el("dd", "", String(value))); list.append(pair); }
      detail.append(list); if (focus) name.focus({ preventScroll: true });
    }
    function render() {
      const activeFocus = document.activeElement?.dataset?.monitorFocus; focusTargets = new Map();
      const model = buildModel(snapshot || { from: selectedWeek }, { ...filters, day: selectedDay }, clock()); selectedDay = model.selectedDay; filters.day = selectedDay;
      weekLabel.textContent = `${model.from.replaceAll("-", ".")} — ${model.to.slice(5).replace("-", ".")}`;
      freshness.textContent = snapshot?.generatedAt ? `${standalone ? "저장 기준" : "마지막 확인"} ${time(snapshot.generatedAt, true)}${standalone ? " · 자동 갱신 없음" : " · 화면을 보는 동안 15초 갱신"}` : "상태 확인 전";
      const usable = snapshot?.available === true && snapshot.from === selectedWeek;
      if (selectedItem) selectedItem = usable && !lastError ? model.visibleItems.find(item => itemKey(item) === itemKey(selectedItem)) || null : null;
      const planProblem = snapshot?.reason && snapshot.reason !== "ROTATION_PAUSED_BY_USER";
      const dailySlots = snapshot?.currentPlan?.source === "saved_config" && Number.isSafeInteger(snapshot.currentPlan.dailySlots) && snapshot.currentPlan.dailySlots > 0 ? snapshot.currentPlan.dailySlots : null;
      connection.textContent = standalone ? "실제 기록 미리보기" : lastError ? "연결 확인 필요" : usable ? `${planProblem ? "실행 조건 확인 필요" : snapshot.enabled ? "정기 수집 예약 켜짐" : "정기 수집 예약 정지"}${dailySlots === null ? "" : ` · 설정 ${dailySlots}회/일`}` : "상태 확인 필요";
      connection.dataset.tone = lastError || !usable || planProblem ? "unknown" : "complete";
      notice.hidden = !standalone && !lastError && usable && !planProblem;
      notice.dataset.tone = planProblem ? "issue" : "unknown";
      notice.textContent = lastError || (standalone ? `실제 저장 기록을 ${time(snapshot?.generatedAt, true)}에 읽은 화면입니다. 현재 운영 화면에 적용하기 전이며 자동 갱신하지 않습니다.` : !usable ? "저장된 상태를 아직 확인하지 못했습니다. 대기나 정상 완료로 판정하지 않습니다." : planProblem ? `실행 조건을 확인해야 하므로 예약이 보류되었습니다. 사유: ${snapshot.reason}` : "");
      const weekday = new Intl.DateTimeFormat("ko-KR", { weekday: "long", timeZone: "UTC" }).format(new Date(selectedDay + "T00:00:00Z"));
      const dayActual = model.dayItems.filter(item => !item.projected).length, dayProjected = model.dayItems.filter(item => item.projected).length;
      const savedEmptyDay = usable && model.dayCoverage.status === "saved" && model.dayCoverage.count === 0, beforeStart = usable && model.dayCoverage.status === "not_started";
      const daySummary = !usable ? "기록 미확인" : model.dayItems.length ? [...(dayActual ? [`저장 ${dayActual}회`] : []), ...(dayProjected ? [`계산 예정 ${dayProjected}회`] : [])].join(" · ") : savedEmptyDay ? "저장 배정 확인 필요" : beforeStart ? "정기수집 시작 전" : "기록 미확인";
      dayTitle.textContent = `${selectedDay.slice(5).replace("-", "/")} ${weekday} · ${daySummary}`;
      dayInput.value = selectedDay; dayInput.min = standalone ? model.from : "2000-01-01"; dayInput.max = standalone ? model.to : "2099-12-31";
      prevDay.disabled = standalone ? selectedDay <= model.from : selectedDay <= "2000-01-01"; nextDay.disabled = standalone ? selectedDay >= model.to : selectedDay >= "2099-12-31";
      dayCards.replaceChildren();
      if (usable) for (const item of model.visibleDayItems) {
        const card = focusTarget(button("", () => selectItem(item), "cm-day-card"), `day:${itemKey(item)}`); card.dataset.tone = item.visual.tone;
        card.setAttribute("aria-pressed", String(Boolean(selectedItem && itemKey(selectedItem) === itemKey(item))));
        card.setAttribute("aria-label", `${item.day} ${time(item.scheduledAt)} ${item.keyword} ${workerLabel(item.workerKey)} ${item.visual.label} ${allocationLabel(item)}`);
        card.append(el("span", "cm-card-time", time(item.scheduledAt)), el("span", "cm-card-keyword", item.keyword), el("span", "cm-card-worker", workerLabel(item.workerKey)), el("span", "cm-card-state", `${TONES[item.visual.tone].symbol} ${item.visual.label}`), el("small", "cm-card-source", allocationLabel(item))); dayCards.append(card);
      }
      dayEmpty.hidden = usable && model.visibleDayItems.length > 0;
      dayEmpty.textContent = !usable ? "표시할 수 있는 저장 상태가 없습니다." : model.dayItems.length ? "조건에 맞는 선택일 배정이 없습니다." : savedEmptyDay ? "날짜의 저장 기록은 있으나 배정 항목을 확인하지 못했습니다. 배정 없음이나 정상 완료로 판정하지 않습니다." : beforeStart ? "정기수집을 시작하기 전 날짜입니다." : "이 날짜의 배정 기록을 확인하지 못했습니다. 정상 대기나 0건으로 판정하지 않습니다.";
      cards.replaceChildren();
      for (const [tone, info] of Object.entries(TONES)) { const card = button("", () => { filters.tone = filters.tone === tone ? "" : tone; toneSelect.value = filters.tone; render(); }, "cm-stat"); card.dataset.tone = tone; card.setAttribute("aria-pressed", String(filters.tone === tone)); card.append(el("span", "", `${info.symbol} ${info.label}`), el("b", "", usable ? String(model.counts[tone]) : "—")); cards.append(card); }
      const cap = el("caption", "", `키워드별 정기 수집 주간표. 저장 배정 ${usable ? model.actualCount : "미확인"}개 · 계산 예정 ${usable ? model.projectedCount : "미확인"}개. 합계는 조회 주의 확인된 배정 기준입니다.${usable && model.coverageIncomplete ? " 일부 날짜의 기록이 미확인입니다." : ""}`), head = el("thead"), hr = el("tr"), first = el("th", "", "키워드"); first.scope = "col"; hr.append(first);
      for (const day of model.days) {
        const th = el("th"); th.scope = "col"; const isToday = day === (snapshot?.today || kstDay(clock()));
        th.className = [isToday ? "cm-today" : "", day === selectedDay ? "cm-selected-day" : ""].filter(Boolean).join(" ");
        const dayName = new Intl.DateTimeFormat("ko-KR", { weekday: "short", timeZone: "UTC" }).format(new Date(day + "T00:00:00Z")), pickDay = focusTarget(button("", () => selectDay(day), "cm-day-column"), `date:${day}`);
        pickDay.setAttribute("aria-label", `${day} ${dayName}요일 배정 보기`); pickDay.setAttribute("aria-pressed", String(day === selectedDay)); pickDay.append(el("span", "", `${dayName}요일`), el("small", "", `${day.slice(5).replace("-", "/")}${isToday ? " · 오늘" : ""}`)); th.append(pickDay); hr.append(th);
      } head.append(hr);
      const body = el("tbody");
      if (usable) for (const row of model.rows) {
        const tr = el("tr"), rowHead = el("th", "", row.keyword); rowHead.scope = "row"; tr.append(rowHead);
        for (const cell of row.cells) {
          const td = el("td"); td.className = [cell.day === snapshot.today ? "cm-today" : "", cell.day === selectedDay ? "cm-selected-day" : ""].filter(Boolean).join(" ");
          for (const item of cell.items) {
            const chip = focusTarget(button("", () => selectItem(item), "cm-slot"), `table:${itemKey(item)}`); chip.dataset.tone = item.visual.tone;
            chip.setAttribute("aria-pressed", String(Boolean(selectedItem && itemKey(selectedItem) === itemKey(item))));
            chip.setAttribute("aria-label", `${item.day} ${item.keyword} ${time(item.scheduledAt)} ${workerLabel(item.workerKey)} ${item.visual.label} ${allocationLabel(item)}`);
            chip.append(el("span", "cm-slot-top", `${TONES[item.visual.tone].symbol} ${item.visual.label}`), el("small", "", `${time(item.scheduledAt)} · ${workerLabel(item.workerKey)}`));
            if (item.planKind === "one_day_trial") chip.append(el("small", "cm-slot-source", "1일 시험")); td.append(chip);
          }
          if (!cell.items.length) td.append(el("span", "cm-no-slot", cellPlaceholder(snapshot, cell.day, Boolean(filters.worker || filters.tone))));
          tr.append(td);
        }
        body.append(tr);
      }
      table.replaceChildren(cap, head, body); empty.hidden = usable && model.rows.length > 0; empty.textContent = usable ? "조건에 맞는 키워드가 없습니다." : "표시할 수 있는 저장 상태가 없습니다.";
      if (selectedItem) renderDetail(selectedItem, false);
      else if (!detail.hidden) renderDetail(null);
      refreshButton.disabled = loading; root.setAttribute("aria-busy", String(loading));
      if (activeFocus) focusTargets.get(activeFocus)?.focus({ preventScroll: true });
    }
    function resetFilters() { filters.query = filters.worker = filters.tone = ""; search.value = workerSelect.value = toneSelect.value = ""; }
    function clearSensitive() { sequence++; activeRequest?.abort(); activeRequest = null; loading = false; refreshPending = false; snapshot = null; lastRead = 0; lastError = ""; selectedItem = null; resetFilters(); detail.replaceChildren(); detail.hidden = true; render(); }
    async function refresh(force = false) {
      if (destroyed || !allowed() || !visible() || loading || standalone || (authBlocked && !force)) { if (standalone) render(); return; }
      const token = ++sequence, from = selectedWeek; loading = true; activeRequest = typeof AbortController === "function" ? new AbortController() : null; render();
      try {
        const response = await request(`/api/collection-monitor?from=${encodeURIComponent(from)}&to=${encodeURIComponent(addDays(from, 6))}`, { method: "GET", cache: "no-store", credentials: "same-origin", headers: { Accept: "application/json" }, ...(activeRequest ? { signal: activeRequest.signal } : {}) });
        if (destroyed || token !== sequence || !allowed() || from !== selectedWeek) return;
        if (!response.ok) { if ([401, 403].includes(response.status)) { snapshot = null; authBlocked = true; resetFilters(); renderDetail(null); } throw new Error([401, 403].includes(response.status) ? "관리자 로그인이 필요합니다." : "상태를 새로 읽지 못했습니다. 마지막 기록을 확인하세요."); }
        const data = await response.json();
        if (destroyed || token !== sequence || !allowed() || from !== selectedWeek) return;
        if (data.from !== from || data.to !== addDays(from, 6)) throw new Error("응답의 조회 기간이 달라 표시하지 않았습니다.");
        snapshot = data; lastError = ""; authBlocked = false; lastRead = clock();
      } catch (error) { if (token === sequence && !destroyed && allowed()) lastError = error.message || "연결 상태를 확인하세요."; }
      finally { if (token === sequence) { loading = false; activeRequest = null; if (!destroyed) { render(); if (refreshPending) { refreshPending = false; if (visible()) refresh(); } } } }
    }
    function selectDay(day) {
      const from = validDay(day) ? weekStart(day) : null;
      if (!validDay(day) || !validDay(from) || !validDay(addDays(from, 6)) || (standalone && (day < preview.from || day > preview.to))) { dateError.hidden = false; dateError.textContent = standalone ? "이 사본의 조회 기간 안에서 날짜를 선택하세요." : "지원되는 날짜를 선택하세요."; dayInput.value = selectedDay; return; }
      dateError.hidden = true; selectedDay = day; filters.day = day; selectedItem = null;
      if (standalone || from === selectedWeek) { render(); return; }
      sequence++; activeRequest?.abort(); activeRequest = null; loading = false; refreshPending = false; selectedWeek = from; snapshot = null; lastError = ""; render(); refresh();
    }
    function changeWeek(offset) { selectDay(addDays(selectedDay, offset)); }
    const onVisible = () => { if (visible()) refresh(); };
    const onRotationChanged = () => { if (!standalone && visible()) { if (loading) refreshPending = true; else refresh(); } };
    let wasAllowed = allowed();
    const observer = standalone ? null : new MutationObserver(() => { if (!allowed()) { wasAllowed = false; clearSensitive(); } else { if (!wasAllowed) authBlocked = false; wasAllowed = true; if (visible() && !snapshot) refresh(); } }); observer?.observe(document.body, { attributes: true, attributeFilter: ["class"] });
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("collector:rotation-changed", onRotationChanged);
    if (!standalone) timer = window.setInterval(() => { if (visible() && clock() - lastRead >= 15000) refresh(); }, 15000);
    render(); if (!standalone && visible()) refresh();
    const controller = { refresh: () => refresh(true), destroy() { if (destroyed) return; clearSensitive(); destroyed = true; sequence++; window.clearInterval(timer); observer?.disconnect(); document.removeEventListener("visibilitychange", onVisible); window.removeEventListener("collector:rotation-changed", onRotationChanged); } };
    window.addEventListener("pagehide", () => controller.destroy(), { once: true }); return controller;
  }
  window.CollectionMonitor = { ...exported, mount };
  const parent = document.getElementById("collectionMonitorPreview") || document.getElementById("collectorControlsCard");
  if (parent) mount(parent, window.COLLECTION_MONITOR_PREVIEW ? { snapshot: window.COLLECTION_MONITOR_PREVIEW } : {});
})();
