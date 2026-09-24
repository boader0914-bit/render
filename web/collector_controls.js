(function () {
  "use strict";
  const STATUS_LABELS = { pending: "접수 · 처리 중", queued: "대기", running: "처리 중", complete: "완료", completed: "완료", reused: "기존 자료 사용", partial: "일부 완료", failed: "실패", blocked: "접근 제한", interrupted: "중단", missed: "실행 시각 지남" };
  const WORKER_FRESH_MS = 90000;
  const WORKER_LABELS = { manual: "BG worker", web: "2Gweb_worker", scheduled: "AWS worker" };
  function workerKey(value) { return Object.hasOwn(WORKER_LABELS, value) ? value : "manual"; }
  function workerLabel(value) { return WORKER_LABELS[workerKey(value)]; }
  function keywordEntries(value) { return String(value || "").split(/\r?\n/).map(text => text.normalize("NFKC").trim()).filter(Boolean); }
  function keywordLines(value) {
    const seen = new Set();
    return keywordEntries(value).filter(keyword => { const key = keyword.toLowerCase(); if (seen.has(key)) return false; seen.add(key); return true; });
  }
  function duplicateKeywordCount(value) { return keywordEntries(value).length - keywordLines(value).length; }
  function validDay(value) { return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value; }
  function scheduleConfig(values) {
    const keywords = keywordLines(values.keywords);
    if (!keywords.length || keywords.length > 100 || keywords.some(keyword => keyword.length > 160 || /[\x00-\x1f\x7f]/.test(keyword))) throw new Error("키워드를 한 줄에 하나씩, 최대 100개 입력하세요.");
    if (!validDay(values.firstDate)) throw new Error("첫 실행일을 확인하세요.");
    if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(values.time)) throw new Error("실행 시각을 확인하세요.");
    const fixed = values.dateMode === "fixed";
    const bookingDays = fixed ? Math.round((Date.parse(values.checkOut) - Date.parse(values.checkIn)) / 86400000) + 1 : Number(values.days);
    if (fixed && (!validDay(values.checkIn) || !validDay(values.checkOut))) throw new Error("첫 관측일과 마지막 관측일을 확인하세요.");
    if (!Number.isInteger(bookingDays) || bookingDays < 1 || bookingDays > 31) throw new Error("관측 기간은 1~31일로 설정하세요. 마지막 관측일도 포함합니다.");
    const ranks = String(values.ranks).trim();
    if (!/^\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*$/.test(ranks) || ranks.split(",").some(range => { const [first, last = first] = range.split("-").map(Number); return first < 1 || last > 100 || first > last; })) throw new Error("상세수집 순위를 1~100위 안에서 입력하세요. 예: 1-20");
    return { version: 1, timezone: "Asia/Seoul", repeat: values.repeat, firstDate: values.firstDate, time: values.time, keywords,
      collection: { dateMode: fixed ? "fixed" : "rolling", bookingDays, checkIn: fixed ? values.checkIn : null, checkOut: fixed ? values.checkOut : null,
        adults: 2, detailRankRanges: ranks, productMode: "all", collectionMode: "precision", collectionPurpose: values.purpose === "basic_db" ? "basic_db" : "revenue_detail", dayUseMode: normalizeDayUse(values.dayUseMode) }, requestPacing: null };
  }
  function formatTime(value) {
    const date = new Date(value);
    return value && Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(date) : "없음";
  }
  function workerQueueCount(worker) {
    const count = Number(worker.waitingCount ?? Math.max(Number(worker.queued) || 0, Number(worker.crawl?.queueLength) || 0));
    return Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
  }
  function workerFresh(worker, now = Date.now()) {
    if (worker.workerKey === "web") return worker.connected === true;
    const seen = Date.parse(worker.workerLastSeenAt);
    return Number.isFinite(seen) && seen <= now + 30000 && now - seen <= WORKER_FRESH_MS;
  }
  function workerState(worker, now = Date.now()) {
    if (worker.halted) return "보호 중";
    if (!worker.configured) return "연결 설정 전";
    if (!workerFresh(worker, now)) return worker.workerKey !== "web" && worker.workerLastSeenAt ? "연결 갱신 지연" : "연결 확인 필요";
    if (worker.ready === false) return "실행 확인 필요";
    if (worker.activeJobId || worker.crawl?.active) return "작업 중";
    if (workerQueueCount(worker) > 0) return "작업 대기";
    return "대기";
  }
  function errorMessage(code) {
    const text = String(code || "");
    if (!text) return "";
    if (text === "COLLECTOR_DUPLICATE_PATH") return "상세 파일 목록이 중복되어 최종 저장 검증에 실패했습니다. 보존 자료 복구가 필요합니다.";
    if (text === "COLLECTOR_UPLOAD_FAILED") return "수집 결과의 전송 또는 최종 저장 확인에 실패했습니다.";
    if (/PROVIDER|NAVER.*BLOCK|CAPTCHA|TOO_MANY|BookingAPITooManyRequests|HTTP_(403|429)/i.test(text)) return "네이버 접근 제한이 감지되어 수집을 멈췄습니다. 운영 점검이 필요합니다.";
    if (/REPEAT|SCOPE_REVIEW|SAME_DAY|DUPLICATE/.test(text)) return "당일 수집 기록 또는 조건이 다른 자료가 있습니다. 기존 결과와 수집 범위를 확인하세요.";
    if (/PERSISTENCE|STATE_INVALID|STATE_UNREADABLE/.test(text)) return "저장된 작업 기록을 확인하지 못했습니다. 기록 점검 후 실행할 수 있습니다.";
    if (/NOT_CONFIGURED|TOKEN|AUTH/.test(text)) return "수집기 연결 설정을 확인해야 합니다.";
    if (/DISK|STORAGE/.test(text)) return "저장공간이 부족해 실행을 멈췄습니다.";
    if (/RESTART|LEASE|STATE_LOST/.test(text)) return "수집기 연결이 끊겨 완료를 확인하지 못했습니다. 자동으로 재실행하지 않습니다.";
    if (/WINDOW_MISSED/.test(text)) return "예약 시각을 지나 이번 실행은 건너뛰었습니다.";
    if (/CANCEL|ABORT|INTERRUPT|PAUSED|STOPPED/.test(text)) return "작업이 중단되었습니다. 기존 결과를 확인하세요.";
    if (/RESULT_EMPTY/.test(text)) return "수집된 업체가 없어 정상 자료로 저장하지 못했습니다.";
    if (/RESULT|QUALITY|ARTIFACT|MANIFEST/.test(text)) return "결과 검증을 통과하지 못했습니다. 상세 기록을 확인하세요.";
    if (/FAILED|TIMEOUT|DEADLINE|HALT|UNKNOWN/.test(text)) return "작업을 완료하지 못했습니다. 수집기 상태와 상세 기록을 확인하세요.";
    return /^[A-Z][A-Z0-9_:-]+$/.test(text) ? "작업 상태를 확인해야 합니다. 운영 점검이 필요합니다." : text;
  }
  function workerAvailability(data, key, now = Date.now()) {
    if (!data) return { ready: false, reason: "수집기 상태를 새로고침하여 연결을 확인하세요." };
    const workers = Array.isArray(data.workers) ? data.workers : [];
    if (workers.some(worker => worker.halted && /PROVIDER.*BLOCK|PROVIDER_ACCESS/.test(worker.errorCode || ""))) return { ready: false, reason: "접근 제한 보호 중입니다. 모든 수집기의 새 요청을 보류합니다." };
    const worker = workers.find(item => item.workerKey === key);
    if (!worker?.configured) return { ready: false, reason: "수집기 연결 설정이 필요합니다. 조건은 미리 저장할 수 있습니다." };
    if (worker.halted) return { ready: false, reason: errorMessage(worker.brokerErrorCode || worker.errorCode) || "수집기 보호 상태를 먼저 확인하세요." };
    if (worker.workerKey === "web" && !workerFresh(worker, now)) return { ready: false, reason: "운영 웹서버의 수집 연결을 확인하지 못했습니다. 상태를 새로고침하세요." };
    if (!workerFresh(worker, now)) return { ready: false, reason: worker.workerLastSeenAt ? "90초 동안 연결이 갱신되지 않았습니다. 새로고침 후 연결을 확인하세요." : "수집기의 첫 연결을 기다리고 있습니다." };
    if (worker.ready === false) return { ready: false, reason: errorMessage(worker.errorCode) || "수집기가 실행 준비 중입니다. 잠시 후 상태를 새로고침하세요." };
    return { ready: true, reason: worker.activeJobId || worker.crawl?.active || workerQueueCount(worker) ? "실행하면 현재 작업 뒤에 대기합니다." : "지금 수집할 수 있습니다." };
  }
  function durationLabel(entry, now = Date.now()) {
    let duration = Number(entry.durationMs);
    if (entry.durationMs == null || !Number.isFinite(duration)) {
      const start = Date.parse(entry.startedAt || entry.createdAt);
      const end = Date.parse(entry.finishedAt || entry.endedAt) || (["running", "pending"].includes(entry.status) ? now : NaN);
      duration = end - start;
    }
    if (!Number.isFinite(duration) || duration < 0) return "";
    const seconds = Math.round(duration / 1000);
    return seconds >= 3600 ? `${Math.floor(seconds / 3600)}시간 ${Math.floor(seconds % 3600 / 60)}분` : seconds >= 60 ? `${Math.floor(seconds / 60)}분 ${seconds % 60}초` : `${seconds}초`;
  }
  const WORKER_KEYS = ["web", "manual", "scheduled"];
  const DAY_USE_LABELS = { inspect: "유무확인", lodging_only: "숙박만", detail: "상세수집" };
  function normalizeDayUse(value) { return Object.hasOwn(DAY_USE_LABELS, value) ? value : "inspect"; }
  function todayKst(now = Date.now()) { return new Date(now + 9 * 3600000).toISOString().slice(0, 10); }
  function addDays(day, count) { return new Date(Date.parse(`${day}T00:00:00Z`) + count * 86400000).toISOString().slice(0, 10); }
  function collectionDates(values, now = Date.now()) {
    const fixed = values.period === "custom";
    const checkIn = fixed ? values.checkIn : todayKst(now);
    const days = fixed ? Math.round((Date.parse(values.checkOut) - Date.parse(checkIn)) / 86400000) + 1 : Number(values.period);
    if (!validDay(checkIn) || !Number.isInteger(days) || days < 1 || days > 31 || (fixed && !validDay(values.checkOut))) throw new Error("조회할 숙박일을 1~31일 범위로 설정하세요. 시작일과 종료일을 모두 포함합니다.");
    return { checkIn, checkOut: fixed ? values.checkOut : addDays(checkIn, days - 1), bookingDays: days };
  }
  function defaultDraft(now = Date.now()) { const today = todayKst(now), firstDate = Date.parse(`${today}T14:00:00+09:00`) <= now ? addDays(today, 1) : today; return { keywords: "", period: "7", checkIn: today, checkOut: addDays(today, 6), purpose: "basic_db", ranks: "1-20", dayUseMode: "inspect", execution: "now", repeat: "once", firstDate, time: "14:00", allowRepeat: false, repeatReason: "" }; }
  function scheduleStartError(values, now = Date.now()) { return values.repeat === "once" && Date.parse(`${values.firstDate}T${values.time}:00+09:00`) <= now ? "예약 시각이 지났습니다. 앞으로 실행할 날짜와 시각을 선택하세요." : ""; }
  function historyEntries(requests = [], schedules = {}) {
    const rows = requests.map(item => ({ ...item, workerKey: workerKey(item.workerKey), trigger: "manual", runId: item.result?.runId, stamp: item.createdAt || item.startedAt }));
    for (const key of WORKER_KEYS) for (const occurrence of schedules[key]?.latest || []) {
      const items = occurrence.items?.length ? occurrence.items : [{ keyword: "예약 실행", status: occurrence.status, errorCode: occurrence.errorCode }];
      for (const item of items) rows.push({ ...item, workerKey: key, trigger: occurrence.trigger || "scheduled", stamp: item.startedAt || occurrence.startedAt || occurrence.createdAt, startedAt: item.startedAt || occurrence.startedAt, finishedAt: item.endedAt || occurrence.finishedAt, status: item.status || occurrence.status });
    }
    const seen = new Set();
    return rows.sort((a, b) => (Date.parse(b.stamp) || Number(b.stamp) || 0) - (Date.parse(a.stamp) || Number(a.stamp) || 0)).filter(row => {
      const identity = row.requestId ? `request:${row.requestId}` : row.runId ? `${row.workerKey}:${row.runId}:${row.keyword}` : `${row.workerKey}:${row.stamp}:${row.keyword}:${row.trigger}`;
      if (seen.has(identity)) return false;
      seen.add(identity); return true;
    });
  }
  function filterHistory(rows, filters) { return rows.filter(row => { const stamp = Date.parse(row.stamp) || Number(row.stamp); return (filters.worker === "all" || row.workerKey === filters.worker) && (!filters.keyword || String(row.keyword || "").toLowerCase().includes(filters.keyword.toLowerCase())) && (!filters.date || Number.isFinite(stamp) && todayKst(stamp) === filters.date) && (filters.state === "all" || (filters.state === "pending" ? ["pending", "queued", "running"].includes(row.status) : filters.state === "complete" ? ["complete", "completed", "reused"].includes(row.status) : !["pending", "queued", "running", "complete", "completed", "reused"].includes(row.status))); }); }
  if (typeof module !== "undefined" && module.exports) module.exports = { workerKey, workerLabel, keywordLines, duplicateKeywordCount, scheduleConfig, formatTime, workerState, workerQueueCount, workerAvailability, durationLabel, errorMessage, STATUS_LABELS, normalizeDayUse, collectionDates, defaultDraft, historyEntries, filterHistory };
  if (typeof document === "undefined") return;
  const byId = id => document.getElementById(id);
  const panel = byId("collectorControlsCard");
  if (!panel) return;
  const cards = new Map();
  const schedules = {};
  let workerData = null, requests = [], refreshInFlight = null, loaded = false, requestsReadError = false;
  const admin = () => document.body.classList.contains("role-admin") && !document.body.classList.contains("admin-user-view");
  const visible = () => admin() && !document.hidden && Boolean(panel.closest("[data-admin-section-panel]")?.classList.contains("active"));
  const storageKey = "staydatalab:collector-drafts:v2";
  let drafts = {};
  try { drafts = JSON.parse(window.localStorage.getItem(storageKey) || "{}"); } catch { /* Drafts remain in memory when local storage is unavailable. */ }
  if (!drafts || typeof drafts !== "object" || Array.isArray(drafts)) drafts = {};
  function node(tag, text = "", className = "") { const el = document.createElement(tag); el.textContent = text; if (className) el.className = className; return el; }
  function saveDraft(card) { drafts[card.key] = values(card); try { window.localStorage.setItem(storageKey, JSON.stringify(drafts)); } catch { /* No collection is issued to repair draft storage. */ } }
  function values(card) { return Object.fromEntries(Object.entries(card.inputs).map(([name, input]) => [name, input.type === "checkbox" ? input.checked : input.value])); }
  function fill(card, value) { for (const [name, input] of Object.entries(card.inputs)) if (Object.hasOwn(value, name)) { if (input.type === "checkbox") input.checked = value[name] === true; else input.value = value[name]; } syncCard(card); }
  function field(card, name, label, type, options = {}) {
    const wrapper = node("label", "", "field"); wrapper.append(node("span", label));
    const input = node(type === "select" ? "select" : type === "textarea" ? "textarea" : "input");
    input.id = `collector-${card.key}-${name}`; input.name = name;
    if (!["select", "textarea"].includes(type)) input.type = type;
    if (type === "select") for (const [value, text] of options.choices || []) { const choice = node("option", text); choice.value = value; input.append(choice); }
    for (const [key, value] of Object.entries(options)) if (key !== "choices") input[key] = value;
    wrapper.append(input); card.inputs[name] = input; card.fields[name] = wrapper; return wrapper;
  }
  function button(text, className, callback) { const el = node("button", text, className); el.type = "button"; if (callback) el.addEventListener("click", callback); return el; }
  function notice(card, message, tone = "") { card.notice.textContent = message; card.notice.dataset.tone = tone; }
  function resultButton(runId) { return button("결과 보기", "ghost-button collector-result-button", () => window.dispatchEvent(new CustomEvent("collector:open-result", { detail: { runId } }))); }
  function makeCard(key, index) {
    const card = { key, inputs: {}, fields: {}, dirty: false, busy: false, loaded: false };
    card.root = node("details", "", "collector-worker-card"); card.root.dataset.workerKey = key; card.root.open = true;
    const summary = node("summary", "", "collector-worker-summary");
    const identity = node("div", "", "collector-worker-identity"); identity.append(node("span", `0${index + 1}`, "collector-worker-number"));
    const name = node("div"); name.append(node("h4", workerLabel(key))); card.summary = node("small", "조건을 설정하세요"); name.append(card.summary); identity.append(name);
    card.badge = node("span", "확인 중", "state-badge"); summary.append(identity, card.badge, node("span", "", "collector-chevron")); card.root.append(summary);
    card.form = node("form", "", "collector-worker-form");
    const intro = node("div", "", "collector-card-status"); card.state = node("p", "연결 상태 확인 중"); card.next = node("small", "예약 꺼짐"); intro.append(card.state, card.next); card.form.append(intro);
    card.form.append(field(card, "keywords", "검색 키워드", "textarea", { rows: 2, maxLength: 17000, placeholder: "예: 경남글램핑\n여러 키워드는 한 줄에 하나씩", required: true }));
    const grid = node("div", "", "collector-settings-grid");
    grid.append(field(card, "period", "조회할 숙박일", "select", { choices: [["1", "수집 당일"], ["7", "수집일부터 7일"], ["14", "수집일부터 14일"], ["31", "수집일부터 31일"], ["custom", "날짜 직접 지정"]] }), field(card, "ranks", "수집 순위", "text", { maxLength: 150, placeholder: "예: 1-20", required: true }));
    grid.append(field(card, "checkIn", "숙박 시작일", "date"), field(card, "checkOut", "숙박 종료일 · 포함", "date"));
    grid.append(field(card, "purpose", "수집 종류", "select", { choices: [["basic_db", "기본수집"], ["revenue_detail", "상세수집"]] }), field(card, "dayUseMode", "데이유즈", "select", { choices: [["inspect", "유무확인"], ["lodging_only", "숙박만"], ["detail", "상세수집"]] }));
    card.form.append(grid); card.detailHint = node("p", "", "collector-field-hint"); card.form.append(card.detailHint);
    const execution = node("div", "", "collector-execution-field"); execution.append(field(card, "execution", "실행 방식", "select", { choices: [["now", "즉시수집"], ["schedule", "예약수집"]] })); card.form.append(execution);
    card.reservation = node("div", "", "collector-reservation"); const reservationGrid = node("div", "", "collector-settings-grid");
    reservationGrid.append(field(card, "firstDate", "수집 실행일", "date", { min: "2000-01-01", max: "2099-12-31" }), field(card, "time", "실행 시각 · 한국시간", "time"), field(card, "repeat", "반복", "select", { choices: [["once", "한 번"], ["daily", "매일"], ["weekdays", "평일 · 월~금"]] })); card.reservationHint = node("p", "", "collector-field-hint"); card.reservation.append(reservationGrid, card.reservationHint); card.form.append(card.reservation);
    card.repeat = node("details", "", "collector-repeat-options"); card.repeat.append(node("summary", "당일 재수집 옵션")); card.repeat.append(field(card, "allowRepeat", "기존 자료 대신 다시 수집", "checkbox"), field(card, "repeatReason", "재수집 사유", "text", { maxLength: 200, placeholder: "4글자 이상 입력" }), node("p", "기본은 세 워커의 당일 정상 자료를 먼저 확인합니다. 접근 제한 보호는 유지됩니다.", "collector-field-hint")); card.form.append(card.repeat);
    const actions = node("div", "", "collector-card-actions"); card.submit = node("button", "지금 수집", "primary-button"); card.submit.type = "submit"; card.save = button("예약 조건 저장", "secondary-button", () => action(card, () => saveSchedule(card))); card.pause = button("예약 일시정지", "ghost-button", () => action(card, () => pauseSchedule(card))); actions.append(card.save, card.submit, card.pause); card.form.append(actions);
    card.notice = node("p", "", "collector-control-status"); card.notice.setAttribute("role", "status"); card.notice.setAttribute("aria-live", "polite"); card.form.append(card.notice);
    card.lastResult = node("div", "", "collector-last-result"); card.form.append(card.lastResult); card.root.append(card.form);
    card.form.addEventListener("input", () => { card.dirty = true; syncCard(card); saveDraft(card); });
    card.form.addEventListener("change", () => { card.dirty = true; syncCard(card); saveDraft(card); });
    card.form.addEventListener("submit", event => { event.preventDefault(); if (card.form.reportValidity()) action(card, () => values(card).execution === "schedule" ? enableSchedule(card) : runNow(card)); });
    cards.set(key, card); fill(card, { ...defaultDraft(), ...(drafts[key] || {}) }); return card.root;
  }
  function syncCard(card) {
    const v = values(card), custom = v.period === "custom", reservation = v.execution === "schedule";
    const availability = workerAvailability(workerData, card.key), schedule = schedules[card.key];
    card.fields.checkIn.hidden = card.fields.checkOut.hidden = !custom;
    card.inputs.checkIn.required = card.inputs.checkOut.required = custom;
    card.reservation.hidden = !reservation; card.inputs.firstDate.required = card.inputs.time.required = reservation;
    card.repeat.hidden = reservation; card.inputs.repeatReason.disabled = !v.allowRepeat; card.inputs.repeatReason.required = v.allowRepeat && !reservation;
    const detailChoice = [...card.inputs.dayUseMode.children].find(option => option.value === "detail"); if (detailChoice) detailChoice.disabled = v.purpose === "basic_db";
    if (v.purpose === "basic_db" && v.dayUseMode === "detail") { card.inputs.dayUseMode.value = "inspect"; v.dayUseMode = "inspect"; }
    card.detailHint.textContent = v.purpose === "basic_db" ? "기본수집은 업체·상품 목록과 데이유즈 유무를 확인합니다. 날짜별 예약·가격은 상세수집에서 확인합니다." : v.dayUseMode === "detail" ? "숙박과 데이유즈의 날짜별 예약·가격을 함께 확인합니다. 객실 공유 여부는 수집 근거로 별도 판단합니다." : v.dayUseMode === "lodging_only" ? "숙박의 날짜별 예약·가격을 확인합니다. 데이유즈 예약 상세는 수집하지 않습니다." : "상품 목록에서 데이유즈 유무를 확인하고, 숙박의 날짜별 예약·가격을 수집합니다.";
    const keyword = keywordLines(v.keywords); const date = custom ? `${v.checkIn || "시작일"} ~ ${v.checkOut || "종료일"}` : `${v.period}일`;
    card.summary.textContent = `${keyword[0] || "키워드 미입력"}${keyword.length > 1 ? ` 외 ${keyword.length - 1}개` : ""} · ${date} · ${v.purpose === "basic_db" ? "기본" : "상세"}`;
    const expiredDraft = scheduleStartError(v);
    card.reservationHint.textContent = expiredDraft || "조회할 숙박일과 수집 실행일은 서로 다릅니다. 예약 시각은 한국시간입니다.";
    card.reservationHint.className = expiredDraft ? "collector-field-hint collector-worker-alert" : "collector-field-hint";
    card.submit.disabled = card.busy || !availability.ready || (reservation && (!schedule?.config || Boolean(expiredDraft)));
    card.submit.title = !availability.ready ? availability.reason : reservation ? expiredDraft : "";
    const reservationLabel = v.repeat === "once" ? `${v.firstDate.slice(5).replace("-", "/")} ${v.time}` : `${v.repeat === "weekdays" ? "평일" : "매일"} ${v.time}`;
    card.submit.textContent = card.busy ? "처리 중…" : reservation ? `${reservationLabel} ${schedule?.config?.enabled ? "예약 변경" : "예약 등록"}` : "지금 수집";
    card.save.hidden = !reservation; card.save.disabled = card.busy || !schedule?.config;
    card.pause.hidden = !schedule?.config?.enabled; card.pause.disabled = card.busy;
    card.next.textContent = schedule?.enabled && schedule.nextRunAt ? `다음 예약 ${formatTime(schedule.nextRunAt)}` : schedule?.enabled ? "예약 켜짐 · 다음 실행 확인 필요" : "예약 꺼짐";
    if (schedule?.expired) card.next.textContent = "예약 날짜 확인 필요 · 실행일 또는 숙박일을 수정하세요";
  }
  function renderWorkers() {
    for (const card of cards.values()) {
      const worker = workerData?.workers?.find(item => item.workerKey === card.key) || { workerKey: card.key, configured: false };
      card.badge.textContent = workerData ? workerState(worker) : "연결 확인 필요";
      card.root.dataset.state = worker.halted ? "alert" : worker.activeJobId || worker.crawl?.active ? "running" : "idle";
      const current = worker.crawl?.activeJob || worker.crawl?.currentJob;
      card.state.textContent = current?.keyword ? `${current.keyword} 수집 중${Number.isFinite(worker.crawl?.elapsedSeconds) ? ` · ${durationLabel({ durationMs: worker.crawl.elapsedSeconds * 1000 })} 경과` : ""}` : `${workerAvailability(workerData, card.key).reason} 대기 ${workerQueueCount(worker)}건`;
      syncCard(card);
    }
    syncLegacyAvailability();
  }
  function syncLegacyAvailability() {
    const key = workerKey(byId("crawlWorkerKey")?.value), availability = workerAvailability(workerData, key), hint = byId("crawlWorkerHint");
    if (hint) { hint.textContent = `${workerLabel(key)} · ${availability.reason}`; hint.dataset.ready = String(availability.ready); hint.dataset.workerKey = key; }
    window.dispatchEvent(new CustomEvent("collector:worker-availability", { detail: { workerKey: key, ...availability } }));
  }
  async function api(url, method = "GET", body) {
    const response = await fetch(url, { method, credentials: "same-origin", ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) });
    let value; try { value = await response.json(); } catch { throw new Error("서버 응답을 확인하지 못했습니다. 기록을 새로고침하세요."); }
    if (!response.ok) throw new Error(response.status === 401 ? "관리자 로그인이 필요합니다." : response.status === 403 ? "운영관리자 권한이 필요합니다." : errorMessage(value.code || value.error) || "요청을 처리하지 못했습니다."); return value;
  }
  const scheduleUrl = (key, suffix = "") => `/api/worker-schedule${suffix}?workerKey=${key}`;
  function configFor(card) { const v = values(card); return scheduleConfig({ ...v, days: v.period, dateMode: v.period === "custom" ? "fixed" : "rolling" }); }
  async function saveSchedule(card) {
    const config = configFor(card); await api(scheduleUrl(card.key), "PUT", config); card.dirty = false; saveDraft(card); await refresh(); notice(card, "예약 조건을 저장했습니다. 예약 켜짐 여부는 그대로 유지했습니다.", "success"); return config;
  }
  async function enableSchedule(card) {
    if (!workerAvailability(workerData, card.key).ready) throw new Error(workerAvailability(workerData, card.key).reason);
    if (scheduleStartError(values(card))) throw new Error(scheduleStartError(values(card)));
    const config = configFor(card); await api(scheduleUrl(card.key), "PUT", config);
    await api(scheduleUrl(card.key, "/enabled"), "POST", { enabled: true }); card.dirty = false; saveDraft(card); await refresh(); notice(card, `${formatTime(schedules[card.key]?.nextRunAt)} 예약을 등록했습니다.`, "success");
  }
  async function pauseSchedule(card) { await api(scheduleUrl(card.key, "/enabled"), "POST", { enabled: false }); await refresh(); notice(card, "예약을 일시정지했습니다. 실행 중인 작업은 마무리하며 후속 예약을 멈춥니다.", "success"); }
  async function runNow(card) {
    const v = values(card), keywords = keywordLines(v.keywords), dates = collectionDates(v);
    if (!keywords.length || keywords.length > 100 || keywords.some(keyword => keyword.length > 160 || /[\x00-\x1f\x7f]/.test(keyword))) throw new Error("키워드를 한 줄에 하나씩 최대 100개 입력하세요.");
    // Share validation with reservations without requiring a future execution date for immediate work.
    scheduleConfig({ ...v, firstDate: todayKst(), time: "14:00", dateMode: "fixed", ...dates, days: dates.bookingDays });
    if (v.allowRepeat && String(v.repeatReason).trim().length < 4) throw new Error("재수집 사유를 4글자 이상 입력하세요.");
    let accepted = 0;
    for (const keyword of keywords) {
      if (!workerAvailability(workerData, card.key).ready) throw new Error(workerAvailability(workerData, card.key).reason);
      const receipt = await new Promise((resolve, reject) => window.dispatchEvent(new CustomEvent("collector:submit-card", { detail: { input: { workerKey: card.key, keyword, checkIn: dates.checkIn, checkOut: dates.bookingDays === 1 ? addDays(dates.checkIn, 1) : dates.checkOut, bookingRangeDays: dates.bookingDays, collectionPurpose: v.purpose, detailRankRanges: v.ranks, dayUseMode: v.dayUseMode, allowRepeat: v.allowRepeat, repeatReason: v.repeatReason }, resolve, reject } })));
      accepted += 1; notice(card, `${accepted}/${keywords.length}개 키워드를 접수했습니다. 아래 기록에서 진행 상태를 확인하세요.`, "success");
      if (receipt?.submissionUncertain) { notice(card, "접수 응답 확인 중입니다. 후속 키워드 접수를 보류했습니다. 기록을 확인하세요.", "error"); break; }
    }
    saveDraft(card); await refresh();
  }
  async function action(card, operation) { if (card.busy || !admin()) return; card.busy = true; syncCard(card); try { await operation(); } catch (error) { notice(card, error.message, "error"); } finally { card.busy = false; syncCard(card); } }
  function renderHistory() {
    const rows = historyEntries(requests, schedules), filters = { worker: byId("collectorHistoryWorker").value || "all", keyword: byId("collectorHistoryKeyword").value.trim(), date: byId("collectorHistoryDate").value, state: byId("collectorHistoryState").value || "all" };
    const filtered = filterHistory(rows, filters), container = byId("collectorUnifiedHistory"); container.replaceChildren(); byId("collectorHistoryCount").textContent = `${filtered.length}건`;
    if (requestsReadError) container.append(node("p", "일부 즉시수집 기록을 읽지 못했습니다. 상태를 새로고침하세요.", "collector-control-status"));
    if (!filtered.length) container.append(node("p", "조건에 맞는 수집 기록이 없습니다.", "hint"));
    for (const entry of filtered.slice(0, 50)) {
      const row = node("article", "", "collector-history-row"), info = node("div");
      info.append(node("strong", entry.keyword || "키워드 확인 중"), node("small", `${workerLabel(entry.workerKey)} · ${entry.trigger === "scheduled" ? "예약" : "즉시"} · ${formatTime(entry.stamp)}${durationLabel(entry) ? ` · ${durationLabel(entry)}` : ""}`));
      if (entry.errorCode) info.append(node("small", errorMessage(entry.brokerErrorCode || entry.errorCode), "collector-worker-alert"));
      if (entry.recovery) info.append(node("small", "보존 자료 복구 완료 · 업체 DB 반영"));
      row.append(info, node("span", entry.recovery && entry.status === "complete" ? "복구 완료" : STATUS_LABELS[entry.status] || "확인 필요", "state-badge"));
      if (entry.runId) row.append(resultButton(entry.runId)); container.append(row);
    }
    for (const card of cards.values()) { card.lastResult.replaceChildren(); const last = rows.find(row => row.workerKey === card.key && row.runId); if (last) card.lastResult.append(node("small", `최근 결과 · ${last.keyword}`), resultButton(last.runId)); }
  }
  async function refresh() {
    if (!admin()) return; if (refreshInFlight) return refreshInFlight;
    refreshInFlight = (async () => {
      const results = await Promise.allSettled([api("/api/collector-status"), api("/api/crawl-requests"), ...WORKER_KEYS.map(key => api(scheduleUrl(key)))]);
      workerData = results[0].status === "fulfilled" ? results[0].value : null;
      requestsReadError = results[1].status !== "fulfilled"; if (!requestsReadError) requests = results[1].value.requests || [];
      for (let i = 0; i < WORKER_KEYS.length; i += 1) {
        const key = WORKER_KEYS[i], result = results[i + 2], card = cards.get(key);
        if (result.status === "fulfilled") {
          schedules[key] = result.value; const config = result.value.config;
          if (!card.loaded && !drafts[key] && config?.keywords?.length) fill(card, { keywords: config.keywords.join("\n"), period: config.collection.dateMode === "fixed" ? "custom" : String(config.collection.bookingDays), checkIn: config.collection.checkIn || todayKst(), checkOut: config.collection.checkOut || todayKst(), purpose: config.collection.collectionPurpose, ranks: config.collection.detailRankRanges, dayUseMode: config.collection.dayUseMode || "detail", firstDate: config.firstDate, time: config.time, repeat: config.repeat, execution: config.enabled ? "schedule" : "now" });
          card.loaded = true;
        } else { schedules[key] = null; notice(card, "예약 상태를 읽지 못했습니다. 즉시수집과 연결 상태는 별도로 확인합니다.", "error"); }
      }
      loaded = true; renderWorkers(); renderHistory();
    })().finally(() => { refreshInFlight = null; }); return refreshInFlight;
  }
  byId("collectorWorkerStates").replaceChildren(...WORKER_KEYS.map(makeCard));
  for (const id of ["collectorHistoryWorker", "collectorHistoryKeyword", "collectorHistoryDate", "collectorHistoryState"]) byId(id).addEventListener(id === "collectorHistoryKeyword" ? "input" : "change", renderHistory);
  byId("collectorRefresh").addEventListener("click", () => refresh());
  byId("crawlWorkerKey")?.addEventListener("change", syncLegacyAvailability);
  byId("crawlAllowRepeat")?.addEventListener("change", event => { byId("crawlRepeatReason").disabled = !event.target.checked; byId("crawlRepeatReason").required = event.target.checked; });
  window.addEventListener("collector:requests-changed", () => { if (admin()) refresh(); });
  window.addEventListener("collector:prepare-card", event => {
    const input = event.detail || {}, card = cards.get(workerKey(input.workerKey));
    fill(card, { keywords: input.keyword || "", period: "custom", checkIn: input.checkIn, checkOut: input.bookingRangeDays === 1 ? input.checkIn : input.checkOut, purpose: input.collectionPurpose || "revenue_detail", ranks: input.detailRankRanges || "1-20", dayUseMode: input.dayUseMode || "inspect", execution: "now" });
    card.root.open = true; card.root.scrollIntoView({ block: "start", behavior: "smooth" }); saveDraft(card);
  });
  const observer = new MutationObserver(() => { if (visible() && !loaded) refresh(); }); observer.observe(document.body, { attributes: true, attributeFilter: ["class"] });
  const section = panel.closest("[data-admin-section-panel]"); if (section) observer.observe(section, { attributes: true, attributeFilter: ["class"] });
  document.addEventListener("visibilitychange", () => { if (visible()) refresh(); });
  window.addEventListener("pagehide", () => observer.disconnect(), { once: true });
  setInterval(() => { if (visible()) refresh(); }, 15000); if (visible()) refresh();
})();
