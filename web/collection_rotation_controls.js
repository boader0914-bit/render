(function () {
  "use strict";
  const POLICY_KEYWORDS = ["경남글램핑", "대구글램핑", "부산글램핑", "경북글램핑", "충남글램핑", "전남글램핑", "전북글램핑", "대전글램핑", "서울근교글램핑", "경주글램핑", "여수글램핑", "가평글램핑", "포천글램핑"];
  const WORKERS = { web: "2Gweb_worker", manual: "BG worker" };
  const STATES = { queued: "예정", scheduled: "예정", pending: "대기", waiting: "대기", running: "수집 중", complete: "새 수집 완료", completed: "새 수집 완료", reused: "기존 자료 사용", partial: "일부 완료", failed: "실패", blocked: "접근 제한", missed: "미실행", paused: "보류", uncertain: "결과 확인 필요", interrupted: "중단", cancelled: "미실행", planned: "예정" };
  const ERRORS = {
    ROTATION_CONFIG_INVALID: "예약 조건을 확인하세요.", ROTATION_KEYWORDS_REQUIRED: "키워드를 한 줄에 하나씩 입력하세요.",
    ROTATION_DUPLICATE_KEYWORDS: "목록에 같은 키워드가 있습니다. 중복을 정리한 뒤 다시 확인하세요.",
    ROTATION_DAILY_SLOTS_EXCEED_KEYWORDS: "하루 배정 수가 키워드 수보다 많습니다. 같은 날 중복되지 않도록 배정 수를 줄이세요.",
    ROTATION_INTERVAL_INVALID: "마지막 배정 시각이 다음 날을 넘지 않도록 시작 시각과 간격을 확인하세요.",
    ROTATION_COLLECTION_INVALID: "숙박 조회기간과 상세 순위를 확인하세요.",
    ROTATION_ACTIVE_EDIT_FORBIDDEN: "예약을 일시정지하고 진행 중인 작업이 끝난 뒤 조건을 변경하세요.",
    ROTATION_WORKER_NOT_READY: "선택한 수집기의 연결과 실행 상태를 확인하세요.",
    ROTATION_WORKER_PROTECTED: "선택한 수집기가 보호 중입니다. 예약 시작으로 보호가 해제되지 않습니다.",
    ROTATION_DISK_SPACE_UNAVAILABLE: "저장공간을 확인하지 못했거나 여유가 부족해 시작하지 않았습니다.",
    ROTATION_UNRESOLVED_EXECUTION: "실행 여부가 확인되지 않은 기록이 있습니다. 자동으로 다시 수집하지 않으며 기존 결과를 먼저 확인해야 합니다.",
    ROTATION_INDIVIDUAL_SCHEDULE_ENABLED: "선택한 수집기의 개별 예약이 켜져 있습니다. 개별 예약을 먼저 일시정지하세요.",
    ROTATION_COLLECTION_FAILED: "수집 결과를 확인해야 하므로 공동 예약을 일시정지했습니다.",
    ROTATION_PROVIDER_BLOCKED: "접근 제한이 감지되어 공동 예약을 일시정지했습니다.",
    ROTATION_STATE_INVALID: "저장된 배정 기록을 확인해야 합니다. 자동으로 다시 수집하지 않습니다.",
    COLLECTION_ROTATION_INDIVIDUAL_ACTIVE: "선택한 수집기의 개별 예약이 켜져 있습니다. 개별 예약을 먼저 일시정지하세요.",
    COLLECTION_ROTATION_LEGACY_ACTIVE: "기존 일일 자동수집이 켜져 있습니다. 기존 예약을 먼저 일시정지하세요.",
    ROTATION_PAUSED_BY_USER: "관리자가 순환예약을 일시정지했습니다. 진행 중인 작업은 마무리합니다.",
    ROTATION_COLLECTORS_BUSY: "다른 수집이 진행 또는 대기 중입니다. 작업이 끝난 뒤 시작하세요.",
    ROTATION_START_POSITION_REQUIRED: "현재 다음 배정 키워드가 새 목록에 없습니다. 시작 위치를 확인하세요.",
    ROTATION_SAVE_REQUIRED: "조건을 먼저 저장한 뒤 순환예약을 시작하세요.",
    ROTATION_WORKERS_INVALID: "대상 수집기와 하루 배정 수를 확인하세요.",
    ROTATION_WORKER_STATE_UNKNOWN: "수집기의 실행 상태를 확인하지 못했습니다. 상태를 새로고침하세요.",
    ROTATION_WORKER_RETIRED: "인사이트 서버로 전환된 수집기는 새 예약에 사용할 수 없습니다.",
    ROTATION_CONFIG_CHANGED: "다른 작업에서 예약 조건이 변경되었습니다. 상태를 새로고침하고 다시 확인하세요.",
    ROTATION_SCHEDULE_CONFLICT: "기존 예약 또는 진행 중인 작업과 겹칩니다. 해당 예약과 실행 상태를 확인하세요.",
    ROTATION_TRIAL_INPUT_INVALID: "시험일과 저장된 기본 조건을 다시 확인하세요.",
    ROTATION_TRIAL_DATE_INVALID: "하루 시험은 한국시간 기준 내일부터 지정할 수 있습니다.",
    ROTATION_TRIAL_BASE_CONFIG_INVALID: "하루 시험은 09시 시작·120분 간격·수집기별 2회인 기본 4회 조건에서만 등록할 수 있습니다.",
    ROTATION_TRIAL_PLAN_CHANGED: "기본 조건이 변경됐습니다. 상태를 새로고침하고 시험 배정표를 다시 확인하세요.",
    ROTATION_TRIAL_DAY_ALLOCATED: "이미 확정된 날짜의 배정은 바꾸지 않습니다. 다른 미래 날짜를 선택하세요.",
    ROTATION_TRIAL_EXISTS: "해당 날짜의 하루 시험이 이미 등록돼 있습니다. 저장된 시험 상태를 확인하세요.",
    ROTATION_TRIAL_PENDING: "등록된 하루 시험을 먼저 확인하세요. 기본 조건과 시험을 함께 변경하지 않습니다.",
    ROTATION_TRIAL_REQUIRES_ENABLED: "기본 순환예약이 정상 대기 중일 때 하루 시험을 등록할 수 있습니다.",
    ROTATION_TRIAL_NOT_FOUND: "저장된 하루 시험을 찾지 못했습니다. 상태를 새로고침하세요.",
    ROTATION_TRIAL_CANCEL_FORBIDDEN: "이미 배정되었거나 지난 시험은 취소하지 않습니다. 기존 이력을 확인하세요."
  };
  function keywordEntries(text) { return String(text || "").split(/\r?\n/).map(value => value.normalize("NFKC").trim()).filter(Boolean); }
  function validDay(value) { return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value; }
  function todayKst(now = Date.now()) { return new Date(now + 9 * 3600000).toISOString().slice(0, 10); }
  function defaultDraft(now = Date.now()) {
    return { keywords: "", web: true, manual: true, webLimit: "2", manualLimit: "2", firstDate: todayKst(now + 86400000), time: "09:00", keywordIntervalMinutes: "120", bookingDays: "", purpose: "revenue_detail", ranks: "1-20", dayUseMode: "inspect" };
  }
  function configFromDraft(values) {
    const keywords = keywordEntries(values.keywords), unique = new Set(keywords.map(value => value.toLowerCase()));
    if (!keywords.length || keywords.length > 100 || keywords.some(value => value.length > 160 || /[\x00-\x1f\x7f]/.test(value))) throw new Error("키워드를 한 줄에 하나씩, 최대 100개 입력하세요.");
    if (unique.size !== keywords.length) throw new Error(ERRORS.ROTATION_DUPLICATE_KEYWORDS);
    const workers = Object.keys(WORKERS).filter(key => values[key]).map(workerKey => ({ workerKey, dailyLimit: Number(values[`${workerKey}Limit`]) }));
    if (!workers.length || workers.some(worker => !Number.isSafeInteger(worker.dailyLimit) || worker.dailyLimit < 1 || worker.dailyLimit > 100)) throw new Error("수집기를 선택하고 하루 배정 수를 1~100개로 입력하세요.");
    const dailySlots = workers.reduce((total, worker) => total + worker.dailyLimit, 0);
    if (dailySlots > keywords.length) throw new Error(ERRORS.ROTATION_DAILY_SLOTS_EXCEED_KEYWORDS);
    if (!validDay(values.firstDate) || values.firstDate < "2000-01-01" || values.firstDate > "2099-12-31") throw new Error("수집 시작일을 확인하세요.");
    if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(values.time)) throw new Error("첫 배정 시각을 확인하세요.");
    const interval = Number(values.keywordIntervalMinutes), [hour, minute] = values.time.split(":").map(Number);
    if (String(values.keywordIntervalMinutes).trim() === "" || !Number.isSafeInteger(interval) || interval < 1 || interval > 1440 || hour * 60 + minute + (dailySlots - 1) * interval >= 1440) throw new Error(ERRORS.ROTATION_INTERVAL_INVALID);
    const bookingDays = Number(values.bookingDays);
    if (String(values.bookingDays).trim() === "" || !Number.isSafeInteger(bookingDays) || bookingDays < 1 || bookingDays > 31) throw new Error("숙박 조회기간을 1~31일로 입력하세요. 관측일을 포함합니다.");
    const ranks = String(values.ranks || "").trim();
    if (!/^\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*$/.test(ranks) || ranks.split(",").some(range => { const [first, last = first] = range.split("-").map(Number); return first < 1 || last > 100 || first > last; })) throw new Error("상세 순위를 1~100위 안에서 입력하세요. 예: 1-20");
    if (!["basic_db", "revenue_detail"].includes(values.purpose) || !["inspect", "lodging_only", "detail"].includes(values.dayUseMode)) throw new Error(ERRORS.ROTATION_COLLECTION_INVALID);
    if (values.purpose === "basic_db" && values.dayUseMode === "detail") throw new Error("데이유즈 상세는 상세수집에서 선택할 수 있습니다.");
    return { version: 1, enabled: false, timezone: "Asia/Seoul", firstDate: values.firstDate, time: values.time, keywordIntervalMinutes: interval, keywords, workers,
      collection: { bookingDays, collectionMode: "precision", collectionPurpose: values.purpose, detailRankRanges: ranks, productMode: "all", dayUseMode: values.dayUseMode } };
  }
  function draftFromConfig(config, now = Date.now()) {
    const draft = defaultDraft(now); if (!config) return draft;
    draft.keywords = Array.isArray(config.keywords) ? config.keywords.join("\n") : "";
    for (const key of Object.keys(WORKERS)) { const worker = config.workers?.find(item => item.workerKey === key); draft[key] = Boolean(worker); draft[`${key}Limit`] = String(worker?.dailyLimit || 2); }
    for (const key of ["firstDate", "time", "keywordIntervalMinutes"]) if (config[key] != null) draft[key] = String(config[key]);
    draft.bookingDays = config.collection?.bookingDays == null ? "" : String(config.collection.bookingDays);
    draft.purpose = config.collection?.collectionPurpose || "revenue_detail"; draft.ranks = config.collection?.detailRankRanges || "1-20"; draft.dayUseMode = config.collection?.dayUseMode || "inspect";
    return draft;
  }
  function reasonText(code) {
    if (!code) return "";
    if (ERRORS[code]) return ERRORS[code];
    if (/PROVIDER|BLOCKED|CAPTCHA|TOO_MANY|BookingAPITooManyRequests/.test(code)) return "접근 제한이 감지되어 이후 배정을 보류했습니다.";
    if (/WORKER.*(?:OFFLINE|NOT_READY)|CONNECTION|CLAIM_TIMEOUT/.test(code)) return "수집기 연결 또는 작업 인수를 확인하지 못했습니다.";
    if (/DISK|STORAGE/.test(code)) return "저장공간 확인이 필요합니다.";
    if (/UNCERTAIN|UNRESOLVED|RESTART|LEASE/.test(code)) return "실행 여부를 확인해야 합니다. 자동으로 다시 수집하지 않습니다.";
    if (/QUALITY|PARTIAL|FAILED/.test(code)) return "완료하지 못한 자료가 있어 결과 확인이 필요합니다.";
    if (/PAUS|DISABLED/.test(code)) return "새 수집을 시작하지 않습니다. 진행 중인 작업은 마무리합니다.";
    if (/^[A-Z][A-Z0-9_:-]+$/.test(code)) return "상세 실행 기록을 확인하세요.";
    return String(code).slice(0, 240);
  }
  function planLabel(status = {}) {
    if (!status.config) return "조건 저장 전";
    if (status.active || status.todayItems?.some(item => item.status === "running")) return status.enabled ? "수집 중" : "일시정지 · 진행 작업 마무리 중";
    if (status.enabled) return "순환예약 대기";
    if (["review", "uncertain", "attention", "error"].includes(status.planState)) return "확인 필요";
    return status.revision ? "일시정지" : "예약 꺼짐";
  }
  function formatTime(value, date = true) {
    const stamp = Date.parse(value || "");
    return Number.isFinite(stamp) ? new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", ...(date ? { month: "numeric", day: "numeric" } : {}), hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(stamp) : "—";
  }
  function savedTableRows(status = {}) {
    const rows = [], seen = new Set();
    for (const item of [...(status.todayItems || []), ...(status.upcomingItems || [])]) {
      if (item.id && seen.has(item.id)) continue;
      if (item.id) seen.add(item.id);
      rows.push(item);
    }
    const stamp = item => { const value = Date.parse(item.scheduledAt || item.notBeforeAt || ""); return Number.isFinite(value) ? value : Infinity; };
    return rows.sort((a, b) => stamp(a) - stamp(b));
  }
  function oneDayTrialReady(status = {}, day, now = Date.now()) {
    const config = status.config, workers = config?.workers;
    return validDay(day) && day > todayKst(now) && /^[a-f0-9]{64}$/.test(status.basePlanHash || "")
      && Number.isSafeInteger(status.revision) && status.revision > 0 && status.enabled === true && !status.active && !status.reason
      && config?.time === "09:00" && config.keywordIntervalMinutes === 120 && config.keywords?.length >= 6
      && Array.isArray(workers) && workers.length === 2
      && ["web", "manual"].every(key => workers.some(worker => worker.workerKey === key && worker.dailyLimit === 2));
  }
  function oneDayPreviewMatches(value, status, day) {
    return Boolean(value && value.day === day && value.baseRevision === status?.revision && value.basePlanHash === status?.basePlanHash
      && value.baseDailySlots === 4 && value.trialDailySlots === 6 && value.configUnchanged === true && validDay(value.returnDay)
      && value.returnDay === todayKst(Date.parse(`${day}T00:00:00+09:00`) + 86400000)
      && Array.isArray(value.items) && value.items.length === 6 && value.items.every(item => (item.day || item.date) === day)
      && Array.isArray(value.nextDayItems) && value.nextDayItems.length === 4 && value.nextDayItems.every(item => (item.day || item.date) === value.returnDay));
  }
  const exported = { POLICY_KEYWORDS, configFromDraft, draftFromConfig, defaultDraft, keywordEntries, reasonText, planLabel, formatTime, savedTableRows, oneDayTrialReady, oneDayPreviewMatches };
  if (typeof module === "object" && module.exports) module.exports = exported;
  if (typeof document === "undefined" || typeof window === "undefined") return;

  function mount(parent, options = {}) {
    if (!parent || document.getElementById("collectionRotationPanel")) return null;
    const request = options.fetch || window.fetch.bind(window), now = options.now || Date.now;
    const inputs = {}, buttons = {}, view = {}, trialButtons = {}, trialView = {}; let saved = null, loaded = false, dirty = false, busy = false, readError = false, destroyed = false, sequence = 0, editRevision = 0, lastReadAt = 0, preview = null, pendingRead = null;
    let trialPreview = null, trialEditRevision = 0, trialNeedsRead = false;
    const admin = () => document.body.classList.contains("role-admin") && !document.body.classList.contains("admin-user-view");
    const node = (tag, className = "", text = "") => { const el = document.createElement(tag); el.className = className; if (text) el.textContent = text; return el; };
    const details = node("details", "collection-rotation"); details.id = "collectionRotationPanel";
    const summary = node("summary", "rotation-summary"), summaryCopy = node("span", "rotation-summary-copy");
    summaryCopy.append(node("strong", "", "공동 순환예약"), node("small", "", "키워드를 나누어 하루 배정량만큼 순서대로 수집"));
    view.badge = node("span", "rotation-badge", "상태 확인 전"); const chevron = node("span", "rotation-chevron"); chevron.setAttribute("aria-hidden", "true");
    summary.append(summaryCopy, view.badge, chevron); details.append(summary);
    const body = node("div", "rotation-body"); details.append(body);
    const status = node("div", "rotation-status"); status.setAttribute("role", "status");
    view.headline = node("strong", "", "저장된 예약을 확인하고 있습니다."); view.next = node("p"); view.reason = node("p", "rotation-reason"); view.freshness = node("small"); status.append(view.headline, view.next, view.reason, view.freshness); body.append(status);
    const form = node("form", "rotation-form"); form.setAttribute("aria-label", "공동 순환예약 조건"); body.append(form);
    function field(name, label, type = "text", choices) {
      const wrapper = node("label", "field"), title = node("span", "", label), input = node(type === "select" ? "select" : type === "textarea" ? "textarea" : "input");
      if (!["select", "textarea"].includes(type)) input.type = type;
      input.id = `rotation_${name}`; input.name = name; inputs[name] = input;
      if (choices) for (const [value, text] of choices) { const option = node("option", "", text); option.value = value; input.append(option); }
      wrapper.append(title, input); return wrapper;
    }
    const keywordHead = node("div", "rotation-keyword-head"), keywordCopy = node("strong", "", "공동 키워드 목록"); view.keywordCount = node("span", "", "0개");
    buttons.policy = node("button", "rotation-button rotation-secondary", "기존 13개 목록 불러오기"); buttons.policy.type = "button"; keywordHead.append(keywordCopy, view.keywordCount, buttons.policy); form.append(keywordHead);
    const keywords = field("keywords", "키워드 · 한 줄에 하나씩", "textarea"); inputs.keywords.rows = 5; inputs.keywords.placeholder = "경남글램핑\n대구글램핑"; inputs.keywords.required = true; form.append(keywords);
    form.append(field("startKeyword", "다음 순환 시작 키워드 · 목록을 변경할 때 선택", "select", [["", "현재 순환 위치 유지"]]));
    const workerSet = node("fieldset", "rotation-workers"); workerSet.append(node("legend", "", "대상 수집기와 하루 배정 수"));
    for (const [key, label] of Object.entries(WORKERS)) {
      const worker = node("div", "rotation-worker"), check = node("label", "rotation-worker-check"), input = node("input"); input.type = "checkbox"; input.id = `rotation_${key}`; inputs[key] = input; check.append(input, node("span", "", label));
      const count = field(`${key}Limit`, "하루 배정", "number"); inputs[`${key}Limit`].min = "1"; inputs[`${key}Limit`].max = "100"; inputs[`${key}Limit`].step = "1"; count.className += " rotation-limit"; worker.append(check, count); workerSet.append(worker);
    }
    form.append(workerSet); view.allocationHint = node("p", "rotation-hint"); form.append(view.allocationHint);
    const grid = node("div", "rotation-grid"); grid.append(field("firstDate", "수집 시작일", "date"), field("time", "첫 배정 시각 · 한국시간", "time"), field("keywordIntervalMinutes", "작업 시작 간격 · 분", "number"), field("bookingDays", "숙박 조회기간 · 관측일 포함", "number"), field("purpose", "수집 종류", "select", [["basic_db", "기본수집"], ["revenue_detail", "상세수집"]]), field("ranks", "상세수집 순위", "text"), field("dayUseMode", "데이유즈", "select", [["inspect", "유무확인"], ["lodging_only", "숙박만"], ["detail", "상세수집"]]));
    for (const name of ["firstDate", "time", "keywordIntervalMinutes", "bookingDays", "ranks"]) inputs[name].required = true;
    inputs.firstDate.min = "2000-01-01"; inputs.firstDate.max = "2099-12-31"; inputs.keywordIntervalMinutes.min = "1"; inputs.keywordIntervalMinutes.max = "1440"; inputs.keywordIntervalMinutes.step = "1"; inputs.bookingDays.min = "1"; inputs.bookingDays.max = "31"; inputs.bookingDays.step = "1"; inputs.bookingDays.placeholder = "예: 14"; form.append(grid);
    form.append(node("p", "rotation-hint", "목록 끝에서 첫 키워드로 계속 순환합니다. 앞 작업이 끝나고 설정 간격이 지난 뒤 다음 작업을 시작합니다."));
    const actions = node("div", "rotation-actions");
    for (const [name, label] of [["preview", "배정표 미리보기"], ["save", "조건 저장"], ["start", "순환예약 시작"], ["pause", "일시정지"]]) { const button = node("button", `rotation-button ${name === "start" ? "rotation-primary" : "rotation-secondary"}`, label); button.type = "button"; buttons[name] = button; actions.append(button); }
    form.append(actions); view.draft = node("p", "rotation-draft"); form.append(view.draft);
    view.notice = node("p", "rotation-notice"); view.notice.setAttribute("role", "status"); view.notice.setAttribute("aria-live", "polite"); view.notice.hidden = true; body.append(view.notice);
    const trialSection = node("section", "rotation-trial"); trialSection.id = "rotationOneDayTrial"; trialSection.setAttribute("aria-label", "하루 6회 시험");
    trialSection.append(node("h4", "", "하루 6회 시험"), node("p", "rotation-hint", "선택한 하루만 09·11·13·15·17·19시에 배정하고, 다음 날부터 기본 4회로 돌아갑니다. 기본 조건·순환 순서·기록은 유지합니다. 보호로 정지되면 계속 정지하며 자동으로 재개하지 않습니다."));
    const trialDateLabel = node("label", "field rotation-trial-date"); trialDateLabel.append(node("span", "", "시험일 · 한국시간"));
    const trialDay = node("input"); trialDay.id = "rotation_trialDay"; trialDay.type = "date"; trialDay.value = todayKst(now() + 86400000); trialDay.min = trialDay.value; trialDay.max = "2099-12-31"; trialDateLabel.append(trialDay); trialSection.append(trialDateLabel);
    trialView.status = node("p", "rotation-trial-status"); trialView.status.setAttribute("role", "status"); trialSection.append(trialView.status);
    const trialActions = node("div", "rotation-actions");
    for (const [name, label] of [["preview", "시험 배정표 미리보기"], ["register", "하루 시험 등록"], ["cancel", "미배정 시험 취소"]]) {
      const button = node("button", `rotation-button ${name === "register" ? "rotation-primary" : "rotation-secondary"}`, label); button.id = `rotation_trial_${name}`; button.type = "button"; trialButtons[name] = button; trialActions.append(button);
    }
    trialSection.append(trialActions); trialView.notice = node("p", "rotation-notice"); trialView.notice.hidden = true; trialView.notice.setAttribute("role", "status"); trialView.notice.setAttribute("aria-live", "polite"); trialSection.append(trialView.notice);
    trialView.preview = node("div", "rotation-trial-preview"); trialView.preview.hidden = true;
    trialView.previewNote = node("p", "rotation-hint"); trialView.preview.append(trialView.previewNote);
    trialView.preview.append(node("h5", "", "시험일 · 6회 배정")); trialView.table = node("div", "rotation-table-wrap"); trialView.table.setAttribute("role", "region"); trialView.table.setAttribute("aria-label", "시험일 6회 미리보기"); trialView.table.tabIndex = 0; trialView.preview.append(trialView.table);
    trialView.preview.append(node("h5", "", "다음 날 · 기본 4회 배정")); trialView.nextTable = node("div", "rotation-table-wrap"); trialView.nextTable.setAttribute("role", "region"); trialView.nextTable.setAttribute("aria-label", "다음 날 4회 미리보기"); trialView.nextTable.tabIndex = 0; trialView.preview.append(trialView.nextTable);
    trialSection.append(trialView.preview); body.append(trialSection);
    const scheduleHead = node("div", "rotation-section-head"); view.tableTitle = node("h4", "", "저장된 배정표"); buttons.refresh = node("button", "rotation-button rotation-secondary", "상태 새로고침"); buttons.refresh.type = "button"; scheduleHead.append(view.tableTitle, buttons.refresh); body.append(scheduleHead);
    view.tableNote = node("p", "rotation-hint", "조건을 확인한 뒤 배정표를 미리 볼 수 있습니다."); body.append(view.tableNote);
    view.table = node("div", "rotation-table-wrap"); view.table.tabIndex = 0; view.table.setAttribute("role", "region"); view.table.setAttribute("aria-label", "날짜별 순환 배정표"); body.append(view.table);
    const before = parent.querySelector?.("#collectorWorkerStates"); if (before) parent.insertBefore(details, before); else parent.append(details);
    try { details.open = window.localStorage.getItem("staydatalab:collection-rotation-open:v1") === "true"; } catch { /* Open state is optional. */ }
    const readValues = () => Object.fromEntries(Object.entries(inputs).map(([name, input]) => [name, input.type === "checkbox" ? input.checked : input.value]));
    function fill(values) { for (const [name, input] of Object.entries(inputs)) { if (input.type === "checkbox") input.checked = Boolean(values[name]); else input.value = values[name] ?? ""; } }
    fill(defaultDraft(now()));
    function notice(message, tone = "") { view.notice.textContent = message || ""; view.notice.hidden = !message; view.notice.dataset.tone = tone; }
    function trialNotice(message, tone = "") { trialView.notice.textContent = message || ""; trialView.notice.hidden = !message; trialView.notice.dataset.tone = tone; }
    function currentTrial() {
      const trials = [saved?.oneDayTrial, ...(Array.isArray(saved?.oneDayTrials) ? saved.oneDayTrials : [])].filter(Boolean);
      return trials.find(item => ["armed", "allocated", "needs_verification"].includes(item.status)) || trials[0] || null;
    }
    function renderTrial() {
      const trial = currentTrial();
      if (!loaded) trialView.status.textContent = "저장된 하루 시험 상태를 확인하고 있습니다.";
      else if (!saved?.basePlanHash) trialView.status.textContent = "현재 서버에서 하루 시험 상태를 확인하지 못했습니다. 상태를 새로고침하세요.";
      else if (trial) {
        const labels = { armed: "등록됨 · 아직 미배정", allocated: "배정 확정 · 기록 보존", expired: "시험일 경과 · 기본 4회 유지", cancelled: "취소됨 · 기본 4회 유지", needs_verification: "확인 필요 · 자동 변경 없음" };
        trialView.status.textContent = `${trial.day || "날짜 확인 필요"} · ${labels[trial.status] || "상태 확인 필요"}${trial.returnDay ? ` · ${trial.returnDay}부터 기본 4회` : ""}`;
      } else trialView.status.textContent = "등록된 하루 시험이 없습니다. 저장된 기본 4회 조건으로 시험 배정표를 먼저 확인하세요.";
      if (readError) trialView.status.textContent += " · 마지막 확인값이며 현재 상태를 새로 확인하지 못했습니다.";
      trialView.preview.hidden = !trialPreview;
      if (trialPreview) {
        trialView.previewNote.textContent = `${trialPreview.day} 하루 6회 → ${trialPreview.returnDay}부터 기본 4회 · 미리보기이며 등록 전에는 예약이 변경되지 않습니다. 등록 시 연결·보호 상태를 다시 확인합니다.`;
        renderRows(trialPreview.items, saved.config, trialView.table, "시험일 6회 미리보기");
        renderRows(trialPreview.nextDayItems, saved.config, trialView.nextTable, "다음 날 4회 미리보기");
      } else { trialView.previewNote.textContent = ""; trialView.table.replaceChildren(); trialView.nextTable.replaceChildren(); }
    }
    let startChoicesKey = "";
    function sync() {
      const values = readValues(), keywords = keywordEntries(values.keywords), dupes = keywords.length - new Set(keywords.map(value => value.toLowerCase())).size;
      const choicesKey = JSON.stringify(keywords);
      if (choicesKey !== startChoicesKey) {
        const selected = inputs.startKeyword.value, options = [["", "현재 순환 위치 유지"], ...[...new Set(keywords)].map(keyword => [keyword, keyword])];
        inputs.startKeyword.replaceChildren(...options.map(([value, label]) => { const option = node("option", "", label); option.value = value; return option; }));
        inputs.startKeyword.value = keywords.includes(selected) ? selected : ""; startChoicesKey = choicesKey;
      }
      view.keywordCount.textContent = `${keywords.length}개${dupes ? ` · 중복 ${dupes}개` : ""}`; view.keywordCount.dataset.tone = dupes ? "error" : "";
      const limits = Object.keys(WORKERS).filter(key => values[key]).map(key => `${WORKERS[key]} ${Number(values[`${key}Limit`]) || 0}개`);
      view.allocationHint.textContent = `${limits.join(" + ") || "대상 수집기 선택 필요"} · 배정 순서대로 번갈아 실행`;
      const locked = Boolean(saved?.enabled || saved?.active), allowed = admin();
      for (const input of Object.values(inputs)) input.disabled = !allowed || busy || locked;
      for (const key of Object.keys(WORKERS)) inputs[`${key}Limit`].disabled = !allowed || busy || locked || !values[key];
      const detailOption = [...inputs.dayUseMode.children].find(option => option.value === "detail"); if (detailOption) detailOption.disabled = values.purpose === "basic_db";
      inputs.ranks.disabled = !allowed || busy || locked || values.purpose === "basic_db";
      buttons.policy.disabled = !allowed || busy || locked; buttons.preview.disabled = !allowed || busy || !loaded || readError; buttons.save.disabled = !allowed || busy || !loaded || readError || locked;
      buttons.start.disabled = !allowed || busy || !loaded || readError || dirty || !saved?.revision || !saved?.config?.keywords?.length || Boolean(saved.enabled || saved.active);
      buttons.pause.disabled = !allowed || busy || !saved?.enabled; buttons.refresh.disabled = !allowed || busy;
      view.draft.textContent = locked ? "실행 중인 조건입니다. 일시정지하고 진행 작업이 끝나면 변경할 수 있습니다." : dirty ? "편집안 · 변경한 조건은 아직 저장되지 않았습니다. 저장 후 시작하세요." : saved?.config?.keywords?.length ? `저장본${saved.revision ? ` · 개정 ${saved.revision}` : ""} · 조건 저장만으로 수집을 시작하지 않습니다.` : "조건 저장 전 · 미리보기와 저장은 수집을 시작하지 않습니다.";
      details.dataset.state = saved?.enabled ? "active" : saved?.reason || readError ? "attention" : "idle";
      const trial = currentTrial(), hasPendingTrial = trial && trial.day >= todayKst(now()) && ["armed", "allocated", "needs_verification"].includes(trial.status);
      const trialAllowed = allowed && loaded && !busy && !readError && !trialNeedsRead && !dirty;
      trialSection.hidden = !allowed;
      trialDay.disabled = !allowed || busy;
      trialDay.min = todayKst(now() + 86400000);
      trialButtons.preview.disabled = !trialAllowed || hasPendingTrial || !oneDayTrialReady(saved || {}, trialDay.value, now());
      trialButtons.register.disabled = trialButtons.preview.disabled || !oneDayPreviewMatches(trialPreview, saved, trialDay.value);
      trialButtons.cancel.disabled = !allowed || !loaded || busy || readError || trialNeedsRead || dirty || !["armed", "needs_verification"].includes(trial?.status) || !trial?.trialId || !validDay(trial.day) || trial.day <= todayKst(now()) || !saved?.basePlanHash;
    }
    function postprocessStatus(value) {
      if (!value) return null;
      const labels = { held: "업체 DB 반영 대기", queued: "업체 DB 반영 대기", running: "업체 DB 반영 중",
        complete: "업체 DB 반영 완료", failed: "업체 DB 반영 실패 · 수집 결과 보관됨", unavailable: "업체 DB 반영 상태 확인 필요" };
      const label = Object.hasOwn(labels, value.state) ? labels[value.state] : labels.unavailable;
      const status = node("small", value.state === "failed" ? "collector-worker-alert" : "collector-postprocess-status", label);
      status.title = [value.updatedAt ? `갱신 ${formatTime(value.updatedAt)}` : "", value.lastErrorCode || value.errorCode || "",
        value.attempts ? `DB 반영 시도 ${value.attempts}/${value.maxAttempts || 3}` : ""].filter(Boolean).join(" · ");
      return status;
    }
    function renderRows(rows, config, target = view.table, title = view.tableTitle.textContent) {
      if (!rows?.length) { target.replaceChildren(node("p", "rotation-empty", "표시할 배정이 없습니다.")); return; }
      const table = node("table", "rotation-table"), caption = node("caption", "rotation-sr-only", title); table.append(caption);
      const thead = node("thead"), heading = node("tr");
      for (const text of ["날짜 · 예정", "수집기", "키워드", "숙박 조회기간", "상태 · 실제 시작"]) { const th = node("th", "", text); th.scope = "col"; heading.append(th); } thead.append(heading); table.append(thead);
      const tbody = node("tbody");
      for (const item of rows) {
        const tr = node("tr"), stamp = item.scheduledAt || item.notBeforeAt, day = item.day || item.date || (stamp ? todayKst(Date.parse(stamp)) : "");
        const dates = node("td"); dates.append(node("strong", "", day || "—"), node("small", "", formatTime(stamp, false)));
        const worker = node("td", "", WORKERS[item.workerKey] || "수집기 확인 필요"), keyword = node("td", "rotation-keyword", item.keyword || "—");
        const range = node("td"); const days = item.bookingDays || item.collection?.bookingDays || config?.collection?.bookingDays;
        if (day && Number.isInteger(Number(days)) && Number(days) > 0) range.append(node("span", "", `${day.slice(5)} ~ ${todayKst(Date.parse(`${day}T00:00:00+09:00`) + (Number(days) - 1) * 86400000).slice(5)}`), node("small", "", `${days}일 · 관측일 포함`)); else range.textContent = "조회기간 확인 필요";
        const state = node("td"), stateText = node("span", "rotation-row-state", STATES[item.status] || "확인 필요"); stateText.dataset.state = item.status || "planned"; state.append(stateText);
        const postprocess = postprocessStatus(item.postprocess); if (postprocess) state.append(postprocess);
        if (item.status === "reused" && item.observedAt) state.append(node("small", "", `원래 관측 ${formatTime(item.observedAt)}`));
        else if (item.startedAt) state.append(node("small", "", `실제 ${formatTime(item.startedAt)}`));
        else if (item.notBeforeAt && Date.parse(item.notBeforeAt) > Date.parse(item.scheduledAt || "")) state.append(node("small", "", `${formatTime(item.notBeforeAt)} 이후`));
        if (item.reason || item.errorCode) { const reason = node("small", "rotation-row-reason", reasonText(item.reason || item.errorCode)); reason.title = String(item.errorCode || item.reason); state.append(reason); }
        if (item.runId) { const link = node("button", "rotation-result-link", "결과 보기"); link.type = "button"; link.addEventListener("click", () => window.dispatchEvent(new CustomEvent("collector:open-result", { detail: { runId: item.runId } }))); state.append(link); }
        tr.append(dates, worker, keyword, range, state); tbody.append(tr);
      }
      table.append(tbody); target.replaceChildren(table);
    }
    function renderStatus() {
      view.badge.textContent = readError ? "상태 확인 필요" : loaded ? planLabel(saved || {}) : "상태 확인 전";
      const rows = saved?.todayItems || [], complete = rows.filter(item => ["complete", "completed"].includes(item.status)).length, reused = rows.filter(item => item.status === "reused").length, missed = rows.filter(item => ["missed", "paused", "cancelled"].includes(item.status)).length, attention = rows.filter(item => ["partial", "failed", "blocked", "uncertain", "interrupted"].includes(item.status)).length;
      view.headline.textContent = loaded ? `오늘 배정 ${rows.length}개 · 새 수집 ${complete} · 기존 자료 ${reused} · 미실행·보류 ${missed} · 확인 필요 ${attention}` : "저장된 예약을 확인하고 있습니다.";
      const next = saved?.upcomingItems?.find(item => ["queued", "planned", "waiting", "pending", "scheduled"].includes(item.status));
      view.next.textContent = saved?.enabled ? `다음 배정 · ${next?.keyword || saved.nextKeyword || "배정 확인 중"}${next?.workerKey ? ` · ${WORKERS[next.workerKey] || next.workerKey}` : ""} · ${formatTime(next?.scheduledAt || saved.nextRunAt)} 이후` : saved?.nextKeyword ? `다음 순환 위치 · ${saved.nextKeyword}` : "순환 목록을 저장하면 다음 배정 위치를 표시합니다.";
      view.reason.textContent = saved?.reason ? reasonText(saved.reason) : ""; view.reason.hidden = !saved?.reason;
      view.freshness.textContent = readError ? "상태를 새로 확인하지 못했습니다. 아래 자료는 마지막 확인값입니다." : lastReadAt ? `상태 확인 ${formatTime(new Date(lastReadAt).toISOString())} · 예정 시각보다 늦게 시작될 수 있습니다.` : "";
      if (!preview) { view.tableTitle.textContent = "저장된 배정표"; view.tableNote.textContent = "오늘 저장된 배정과 향후 순환 순서입니다. 미래 항목은 실행 전 변경될 수 있습니다."; renderRows(savedTableRows(saved || {}), saved?.config); }
      if (trialPreview && (readError || !oneDayPreviewMatches(trialPreview, saved, trialDay.value) || dirty || currentTrial()?.status === "armed")) trialPreview = null;
      renderTrial(); sync();
    }
    async function api(path, method = "GET", payload) {
      const response = await request(`/api/collection-rotation${path}`, { method, credentials: "same-origin", ...(payload === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }) });
      let value; try { value = await response.json(); } catch { throw new Error("서버 응답을 확인하지 못했습니다. 상태를 새로고침하세요."); }
      if (!response.ok) { const code = value?.code || value?.error || value?.reason || value?.message; throw new Error(response.status === 401 ? "관리자 로그인이 필요합니다." : response.status === 403 ? "운영관리자 권한이 필요합니다." : reasonText(code) || "요청을 처리하지 못했습니다."); }
      return value;
    }
    async function refresh() {
      if (destroyed || !admin()) return;
      if (pendingRead) return pendingRead;
      const seq = ++sequence;
      pendingRead = (async () => {
        try { const result = await api(""); if (destroyed || !admin() || seq !== sequence) return; saved = result; readError = false; trialNeedsRead = false; lastReadAt = now(); if (!dirty) fill(draftFromConfig(saved.config, now())); loaded = true; renderStatus(); }
        catch (error) { if (seq !== sequence || destroyed) return; readError = true; renderStatus(); notice(error.message, "error"); }
      })().finally(() => { pendingRead = null; });
      return pendingRead;
    }
    function changed() { dirty = true; editRevision++; preview = null; trialPreview = null; renderTrial(); if (readValues().purpose === "basic_db" && inputs.dayUseMode.value === "detail") inputs.dayUseMode.value = "inspect"; notice(""); view.tableTitle.textContent = "배정표 확인 필요"; view.tableNote.textContent = "편집안을 변경했습니다. 미리보기로 새 배정 순서를 확인하세요."; view.table.replaceChildren(); sync(); }
    form.addEventListener("submit", event => event.preventDefault());
    for (const input of Object.values(inputs)) { input.addEventListener("input", changed); input.addEventListener("change", changed); }
    buttons.policy.addEventListener("click", () => { inputs.keywords.value = POLICY_KEYWORDS.join("\n"); changed(); notice("기존 13개 목록을 편집안에 불러왔습니다. 저장과 시작은 별도입니다."); });
    async function action(task) { if (busy || !admin()) return; busy = true; sync(); try { if (pendingRead) await pendingRead; if (!destroyed && admin()) await task(); } catch (error) { notice(error.message, "error"); } finally { busy = false; sync(); } }
    buttons.preview.addEventListener("click", () => action(async () => {
      const config = configFromDraft(readValues()), revision = editRevision, seq = ++sequence; notice("7일 배정표를 계산하고 있습니다.");
      const result = await api("/preview", "POST", { config, days: 7, ...(inputs.startKeyword.value ? { startKeyword: inputs.startKeyword.value } : {}) });
      if (destroyed || !admin() || revision !== editRevision || seq !== sequence) return;
      preview = result; view.tableTitle.textContent = "편집안 · 향후 7일 미리보기"; view.tableNote.textContent = "계산 결과이며 실제 예약은 아닙니다. 저장한 뒤 순환예약 시작을 눌러야 실행합니다."; renderRows(result.items || result.upcomingItems || [], result.config || config); notice("배정표를 계산했습니다. 예약 설정과 수집은 변경하지 않았습니다.", "success");
    }));
    buttons.save.addEventListener("click", () => action(async () => {
      const config = configFromDraft(readValues()), payload = inputs.startKeyword.value ? { config, startKeyword: inputs.startKeyword.value } : config; const result = await api("", "PUT", payload); if (destroyed || !admin()) return;
      saved = result?.config ? result : { ...saved, config, enabled: false }; dirty = false; preview = null; editRevision++; await refresh(); notice("조건을 저장했습니다. 수집을 시작하려면 순환예약 시작을 누르세요.", "success");
    }));
    buttons.start.addEventListener("click", () => action(async () => {
      if (dirty) throw new Error("변경한 조건을 먼저 저장하세요.");
      const result = await api("/enabled", "POST", { enabled: true }); if (result?.config) saved = result; preview = null; await refresh(); notice("순환예약을 시작했습니다. 선택한 수집기의 보호와 실행 상태에 따라 배정 순서대로 진행합니다.", "success"); window.dispatchEvent(new CustomEvent("collector:rotation-changed"));
    }));
    buttons.pause.addEventListener("click", () => action(async () => { const result = await api("/enabled", "POST", { enabled: false }); if (result?.config) saved = result; preview = null; await refresh(); notice("순환예약을 일시정지했습니다. 이미 진행 중인 수집은 결과 저장까지 마무리합니다.", "success"); window.dispatchEvent(new CustomEvent("collector:rotation-changed")); }));
    buttons.refresh.addEventListener("click", () => { preview = null; return refresh(); });
    trialDay.addEventListener("input", () => { trialEditRevision++; trialPreview = null; trialNotice(""); renderTrial(); sync(); });
    trialDay.addEventListener("change", () => { trialEditRevision++; trialPreview = null; trialNotice(""); renderTrial(); sync(); });
    const trialInput = () => ({ day: trialDay.value, expectedRevision: saved.revision, expectedPlanHash: saved.basePlanHash });
    async function trialAction(task) {
      if (busy || !admin()) return; busy = true; sync();
      try { if (pendingRead) await pendingRead; if (!destroyed && admin()) await task(); }
      catch (error) { trialPreview = null; renderTrial(); trialNotice(error.message, "error"); }
      finally { busy = false; sync(); }
    }
    trialButtons.preview.addEventListener("click", () => trialAction(async () => {
      if (dirty || readError || trialNeedsRead || !oneDayTrialReady(saved || {}, trialDay.value, now())) throw new Error("저장된 기본 4회 조건과 미래 시험일을 확인하세요.");
      const input = trialInput(), revision = trialEditRevision, draftRevision = editRevision;
      trialNotice("시험일 6회와 다음 날 4회 배정표를 확인하고 있습니다.");
      const result = await api("/trial/preview", "POST", input);
      if (destroyed || !admin() || revision !== trialEditRevision || draftRevision !== editRevision || dirty) return;
      if (!oneDayPreviewMatches(result, saved, input.day)) throw new Error("시험 배정표와 현재 저장 조건이 일치하지 않습니다. 상태를 새로고침하세요.");
      trialPreview = result; renderTrial(); trialNotice("시험 배정표를 확인했습니다. 하루 시험 등록을 누르면 선택한 날짜에만 적용됩니다.", "success");
    }));
    trialButtons.register.addEventListener("click", () => trialAction(async () => {
      if (dirty || readError || trialNeedsRead || !oneDayTrialReady(saved || {}, trialDay.value, now()) || !oneDayPreviewMatches(trialPreview, saved, trialDay.value)) throw new Error("현재 조건의 시험 배정표를 먼저 확인하세요.");
      try { const result = await api("/trial", "POST", trialInput()); if (destroyed || !admin()) return; saved = result; trialPreview = null; renderStatus(); await refresh(); if (!readError) trialNotice("하루 시험을 등록했습니다. 시험일만 6회이고 다음 날부터 기본 4회입니다. 지금 수집을 실행하지 않습니다.", "success"); }
      catch (error) { trialNeedsRead = true; throw error; }
    }));
    trialButtons.cancel.addEventListener("click", () => trialAction(async () => {
      const trial = currentTrial(); if (dirty || readError || trialNeedsRead || !["armed", "needs_verification"].includes(trial?.status) || !trial?.trialId || !validDay(trial.day) || trial.day <= todayKst(now())) throw new Error("미래의 미배정 시험만 취소할 수 있습니다.");
      try { const result = await api("/trial/cancel", "POST", { trialId: trial.trialId, expectedRevision: saved.revision, expectedPlanHash: saved.basePlanHash }); if (destroyed || !admin()) return; saved = result; trialPreview = null; renderStatus(); await refresh(); if (!readError) trialNotice("미배정 시험을 취소했습니다. 기본 조건과 기존 기록·보호 상태는 유지합니다.", "success"); }
      catch (error) { trialNeedsRead = true; throw error; }
    }));
    details.addEventListener("toggle", () => { try { window.localStorage.setItem("staydatalab:collection-rotation-open:v1", String(details.open)); } catch { /* Open state is optional. */ } if (!busy && details.open && admin()) refresh(); });
    const onVisible = () => { if (!busy && admin() && !document.hidden && details.open) refresh(); };
    document.addEventListener("visibilitychange", onVisible);
    const observer = new MutationObserver(() => {
      if (!admin()) { sequence++; saved = null; preview = null; trialPreview = null; trialNeedsRead = false; loaded = false; readError = false; dirty = false; fill(defaultDraft(now())); view.table.replaceChildren(); view.headline.textContent = "관리자 연결을 확인하세요."; view.next.textContent = ""; view.reason.textContent = ""; view.freshness.textContent = ""; view.badge.textContent = "관리자 연결 필요"; notice(""); trialNotice(""); renderTrial(); sync(); }
      else if (!loaded && !pendingRead) refresh();
    }); observer.observe(document.body, { attributes: true, attributeFilter: ["class"] });
    const timer = window.setInterval(() => { if (!busy && details.open && admin() && !document.hidden && now() - lastReadAt >= 15000) refresh(); }, 15000);
    sync(); if (admin()) refresh();
    const controller = { refresh, destroy() { destroyed = true; sequence++; window.clearInterval(timer); observer.disconnect(); document.removeEventListener("visibilitychange", onVisible); } };
    window.addEventListener("pagehide", () => controller.destroy(), { once: true });
    return controller;
  }
  window.CollectionRotationControls = { ...exported, mount };
  const parent = document.getElementById("collectorControlsCard"); if (parent) mount(parent);
})();
