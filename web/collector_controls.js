(function () {
  "use strict";
  const STATUS_LABELS = { pending: "접수 · 처리 중", queued: "대기", running: "처리 중", complete: "완료", completed: "완료", reused: "기존 자료 사용", partial: "일부 완료", failed: "실패", blocked: "접근 제한", interrupted: "중단", missed: "실행 시각 지남" };
  const WORKER_FRESH_MS = 90000;
  const WORKER_LABELS = { manual: "0922 수동워커", web: "기본워커", scheduled: "0923 예약워커" };
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
        adults: 2, detailRankRanges: ranks, productMode: "all", collectionMode: "precision", collectionPurpose: "revenue_detail" }, requestPacing: null };
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
    if (worker.halted) return { ready: false, reason: errorMessage(worker.errorCode) || "수집기 보호 상태를 먼저 확인하세요." };
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
  if (typeof module !== "undefined" && module.exports) module.exports = { workerKey, workerLabel, keywordLines, duplicateKeywordCount, scheduleConfig, formatTime, workerState, workerQueueCount, workerAvailability, durationLabel, errorMessage, STATUS_LABELS };
  if (typeof document === "undefined") return;
  const byId = id => document.getElementById(id);
  const panel = byId("collectorControlsCard");
  if (!panel) return;
  const form = byId("workerScheduleForm");
  const fieldIds = { keywords: "workerScheduleKeywords", repeat: "workerScheduleRepeat", firstDate: "workerScheduleFirstDate", time: "workerScheduleTime",
    dateMode: "workerScheduleDateMode", days: "workerScheduleDays", checkIn: "workerScheduleCheckIn", checkOut: "workerScheduleCheckOut", ranks: "workerScheduleRanks" };
  let latest = null;
  let workerData = null;
  let dirty = false;
  let busy = false;
  let refreshInFlight = null;
  let pendingRequestId = null;
  let loaded = false;
  const admin = () => document.body.classList.contains("role-admin") && !document.body.classList.contains("admin-user-view");
  const visible = () => admin() && !document.hidden && Boolean(panel.closest("[data-admin-section-panel]")?.classList.contains("active"));
  function notice(message, tone = "") { byId("workerScheduleStatus").textContent = message; byId("workerScheduleStatus").dataset.tone = tone; }
  function syncFields() {
    const fixed = byId("workerScheduleDateMode").value === "fixed";
    byId("workerScheduleRollingField").hidden = fixed;
    byId("workerScheduleDays").required = !fixed;
    for (const name of ["CheckIn", "CheckOut"]) {
      byId(`workerSchedule${name}Field`).hidden = !fixed;
      byId(`workerSchedule${name}`).required = fixed;
    }
  }
  function syncButtons() {
    const enabled = latest?.config?.enabled === true;
    const availability = workerAvailability(workerData, "scheduled");
    const timeExpired = latest?.expiryReason === "KEYWORD_SCHEDULE_TIME_EXPIRED";
    const dateExpired = latest?.expired && !timeExpired;
    const blockedReason = !latest?.config ? "예약 조건을 읽지 못했습니다. 상태를 새로고침하세요." : dateExpired ? "관측 기간이 지났습니다. 날짜를 수정하고 저장하세요." : latest?.lastError ? errorMessage(latest.lastError) : !availability.ready ? availability.reason : "";
    const enableReason = blockedReason || (timeExpired ? "예약 시각이 지났습니다. 예약하려면 실행일과 시각을 수정하세요. 저장 조건으로 지금 수집은 가능합니다." : "");
    byId("workerScheduleSave").disabled = busy || !latest?.config;
    byId("workerScheduleEnable").disabled = busy || !latest?.config || (!enabled && (dirty || !latest.config.keywords.length || Boolean(enableReason)));
    byId("workerScheduleEnable").textContent = enabled ? "예약 일시정지" : "예약 켜기";
    byId("workerScheduleRunNow").disabled = busy || !latest?.config || dirty || !latest.config.keywords.length || Boolean(blockedReason);
    byId("collectorRefresh").disabled = busy;
    byId("workerScheduleSaveHint").textContent = dirty ? "변경한 조건을 먼저 저장하세요. 저장해도 꺼진 예약이 켜지지 않습니다." : enableReason || "조건 저장과 예약 켜기는 별개입니다. 지금 수집해도 예약 일정은 유지됩니다.";
    byId("workerScheduleEnable").title = enabled ? "예약된 후속 실행을 일시정지합니다." : enableReason;
    byId("workerScheduleRunNow").title = blockedReason;
    syncSelectedWorker();
  }
  function syncSelectedWorker() {
    const key = workerKey(byId("crawlWorkerKey").value);
    const availability = workerAvailability(workerData, key);
    const worker = workerData?.workers?.find(item => item.workerKey === key);
    byId("crawlWorkerHint").textContent = `${workerLabel(key)}에서 지금 한 번 수집합니다. ${availability.reason} 모든 수집기의 당일 자료를 먼저 확인합니다.`;
    byId("crawlWorkerHint").dataset.ready = String(availability.ready);
    byId("crawlWorkerHint").dataset.workerKey = key;
    byId("crawlWorkerScheduleShortcut").hidden = key !== "scheduled";
    for (const card of byId("collectorWorkerStates").children) card.dataset.selected = String(card.dataset.workerKey === key);
    window.dispatchEvent(new CustomEvent("collector:worker-availability", { detail: { workerKey: key, ...availability, status: worker ? workerState(worker) : "확인 중" } }));
  }
  function selectWorker(key, openSchedule = false) {
    byId("crawlWorkerKey").value = key;
    byId("crawlWorkerKey").dispatchEvent(new Event("change", { bubbles: true }));
    if (openSchedule) {
      byId("workerScheduleDetails").open = true;
      byId("workerScheduleDetails").scrollIntoView({ block: "nearest", behavior: "smooth" });
      byId("workerScheduleKeywords").focus({ preventScroll: true });
    } else {
      byId("crawlWorkerKey").scrollIntoView({ block: "nearest", behavior: "smooth" });
      byId("crawlWorkerKey").focus({ preventScroll: true });
    }
  }
  async function api(url, method = "GET", body) {
    const response = await fetch(url, { method, credentials: "same-origin", ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) });
    let value;
    try { value = await response.json(); } catch { throw new Error("서버 응답을 확인하지 못했습니다. 상태를 새로고침하세요."); }
    if (!response.ok) throw new Error(response.status === 401 ? "관리자 로그인이 필요합니다." : response.status === 403 ? "운영관리자 권한이 필요합니다." : errorMessage(value.code || value.error) || "요청을 처리하지 못했습니다.");
    return value;
  }
  function node(tag, text, className = "") { const element = document.createElement(tag); element.textContent = text; if (className) element.className = className; return element; }
  function renderWorkers(data) {
    const container = byId("collectorWorkerStates");
    container.replaceChildren();
    const workers = Array.isArray(data?.workers) ? data.workers : [];
    for (const key of ["manual", "web", "scheduled"]) {
      const worker = workers.find(item => item.workerKey === key) || { workerKey: key, configured: false };
      const card = node("article", "", "collector-worker");
      card.dataset.workerKey = key;
      const head = node("div", "", "collector-worker-head");
      head.append(node("h4", workerLabel(key)), node("span", workerState(worker), "state-badge"));
      card.append(head, node("p", `${key === "scheduled" ? "즉시수집 · 예약수집" : "즉시수집"} · 대기 ${workerQueueCount(worker)}건`));
      card.append(node("p", key === "web" ? "운영 웹서버에서 직접 수집합니다." : `최근 연결 ${formatTime(worker.workerLastSeenAt)} · 연결 시각은 수집 완료 시각이 아닙니다.`));
      const current = worker.crawl?.activeJob || worker.crawl?.currentJob;
      if (current?.keyword) card.append(node("p", `현재 작업: ${current.keyword}${Number.isFinite(worker.crawl.elapsedSeconds) ? ` · ${durationLabel({ durationMs: worker.crawl.elapsedSeconds * 1000 })} 경과` : ""}`));
      const availability = workerAvailability(data, key);
      card.append(node("p", availability.reason, availability.ready ? "" : "collector-worker-alert"));
      const actions = node("div", "", "collector-worker-actions");
      const select = node("button", "즉시수집에 선택", "ghost-button");
      select.type = "button";
      select.addEventListener("click", () => selectWorker(key));
      actions.append(select);
      if (key === "scheduled") {
        const schedule = node("button", "예약 설정", "secondary-button");
        schedule.type = "button";
        schedule.addEventListener("click", () => selectWorker(key, true));
        actions.append(schedule);
      }
      card.append(actions);
      container.append(card);
    }
  }
  function resultButton(runId) {
    const button = node("button", "결과 보기", "ghost-button collector-result-button");
    button.type = "button";
    button.addEventListener("click", () => window.dispatchEvent(new CustomEvent("collector:open-result", { detail: { runId } })));
    return button;
  }
  function renderHistory(entries) {
    const container = byId("workerScheduleHistory");
    container.replaceChildren();
    if (!entries?.length) { container.append(node("p", "아직 기록이 없습니다.", "hint")); return; }
    for (const entry of entries.slice(0, 10)) {
      const row = node("article", "", "collector-history-row");
      const info = node("div", "");
      info.append(node("strong", `${entry.trigger === "scheduled" ? "예약수집" : "즉시수집"} · ${(entry.items || []).length}개 키워드`));
      const elapsed = durationLabel(entry) ? ` · ${durationLabel(entry)}` : "";
      info.append(node("small", `${formatTime(entry.startedAt || entry.createdAt)}${elapsed}`));
      if (entry.errorCode) info.append(node("small", errorMessage(entry.errorCode), "collector-worker-alert"));
      row.append(info, node("span", STATUS_LABELS[entry.status] || "확인 필요", "state-badge"));
      const detail = node("details", "");
      detail.append(node("summary", "키워드별 결과"));
      const list = node("ul", "");
      for (const item of (entry.items || []).slice(0, 100)) {
        const itemRow = node("li", "");
        itemRow.append(node("span", `${item.keyword} · ${STATUS_LABELS[item.status] || "확인 필요"}${durationLabel(item) ? ` · ${durationLabel(item)}` : ""}`));
        if (item.runId) itemRow.append(resultButton(item.runId));
        if (item.errorCode) itemRow.append(node("small", errorMessage(item.errorCode), "collector-worker-alert"));
        list.append(itemRow);
      }
      detail.append(list);
      row.append(detail);
      container.append(row);
    }
  }
  function renderRequests(entries) {
    const container = byId("collectorRequestHistory");
    container.replaceChildren();
    if (!entries?.length) { container.append(node("p", "아직 요청이 없습니다.", "hint")); return; }
    for (const request of entries.slice(0, 10)) {
      const row = node("article", "", "collector-history-row");
      const info = node("div", "");
      info.append(node("strong", `${workerLabel(request.workerKey)} · ${request.keyword || "키워드 확인 중"}`));
      info.append(node("small", `${formatTime(request.createdAt)}${durationLabel(request) ? ` · ${durationLabel(request)}${request.status === "pending" ? " 경과" : ""}` : ""}`));
      if (request.errorCode || request.message && ["failed", "blocked", "interrupted"].includes(request.status)) info.append(node("small", errorMessage(request.errorCode || request.message), "collector-worker-alert"));
      row.append(info, node("span", STATUS_LABELS[request.status] || "확인 필요", "state-badge"));
      if (request.result?.runId) row.append(resultButton(request.result.runId));
      container.append(row);
    }
  }
  function fill(config) {
    const values = { keywords: config.keywords.join("\n"), repeat: config.repeat, firstDate: config.firstDate, time: config.time,
      dateMode: config.collection.dateMode, days: config.collection.bookingDays, checkIn: config.collection.checkIn || "", checkOut: config.collection.checkOut || "",
      ranks: config.collection.detailRankRanges };
    for (const [name, id] of Object.entries(fieldIds)) byId(id).value = values[name];
    dirty = false;
    syncFields();
  }
  async function refresh(forceForm = false) {
    if (!admin()) return;
    if (refreshInFlight) return refreshInFlight;
    refreshInFlight = (async () => {
      const results = await Promise.allSettled([api("/api/collector-status"), api("/api/worker-schedule"), api("/api/crawl-requests")]);
      if (results[0].status === "fulfilled") { workerData = results[0].value; renderWorkers(workerData); }
      else { workerData = null; byId("collectorWorkerStates").replaceChildren(node("p", results[0].reason.message, "hint")); }
      if (results[1].status === "fulfilled") {
        latest = results[1].value;
        if (latest.config && (forceForm || !loaded)) fill(latest.config);
        loaded = true;
        byId("workerScheduleBadge").textContent = latest.lastError || latest.expired ? "확인 필요" : latest.enabled ? "예약 켜짐" : "예약 꺼짐";
        byId("workerScheduleNext").textContent = latest.expiryReason === "KEYWORD_SCHEDULE_TIME_EXPIRED" ? "예약 시각이 지났습니다. 관측 기간은 유효하여 지금 수집은 가능합니다." : latest.expired ? "날짜가 지난 조건입니다. 관측 기간을 수정하세요." : latest.nextRunAt ? `다음 예약 ${formatTime(latest.nextRunAt)} · 한국시간` : !latest.enabled && latest.previewNextRunAt ? `예약 꺼짐 · 켜면 ${formatTime(latest.previewNextRunAt)}부터 · 한국시간` : latest.enabled ? "다음 예약 없음 · 기록과 실행일을 확인하세요." : "예약이 꺼져 있습니다. 조건 저장 후 연결 상태를 확인하세요.";
        renderHistory(latest.latest);
        if (latest.lastError) notice(errorMessage(latest.lastError), "error");
      } else {
        latest = null;
        byId("workerScheduleBadge").textContent = "확인 필요";
        byId("workerScheduleNext").textContent = "상태를 읽지 못했습니다.";
        notice(results[1].reason.message, "error");
      }
      if (results[2].status === "fulfilled") renderRequests(results[2].value.requests);
      else byId("collectorRequestHistory").replaceChildren(node("p", "즉시수집 요청 기록을 읽지 못했습니다. 상태를 새로고침하세요.", "hint"));
      syncButtons();
    })().finally(() => { refreshInFlight = null; });
    return refreshInFlight;
  }
  async function action(fn) {
    if (busy || !admin()) return;
    busy = true;
    syncButtons();
    try { await fn(); } catch (error) { notice(error.message, "error"); }
    finally { busy = false; syncButtons(); }
  }
  form.addEventListener("input", () => { dirty = true; syncFields(); syncButtons(); });
  form.addEventListener("change", () => { dirty = true; syncFields(); syncButtons(); });
  form.addEventListener("submit", event => {
    event.preventDefault();
    if (!form.reportValidity()) return;
    action(async () => {
      const rawKeywords = byId("workerScheduleKeywords").value;
      const duplicates = duplicateKeywordCount(rawKeywords);
      const config = scheduleConfig(Object.fromEntries(Object.entries(fieldIds).map(([name, id]) => [name, byId(id).value])));
      await api("/api/worker-schedule", "PUT", config);
      await refresh(true);
      notice(`조건을 저장했습니다.${duplicates ? ` 중복 키워드 ${duplicates}개를 제외하고 ${config.keywords.length}개를 저장했습니다.` : ""} 예약 켜짐 여부는 그대로 유지했습니다.`, "success");
    });
  });
  byId("workerScheduleEnable").addEventListener("click", () => action(async () => {
    const enabled = latest?.config?.enabled !== true;
    if (enabled && !workerAvailability(workerData, "scheduled").ready) throw new Error(workerAvailability(workerData, "scheduled").reason);
    if (enabled && latest?.expired) throw new Error("예약 날짜 또는 관측 기간을 수정하고 저장하세요.");
    await api("/api/worker-schedule/enabled", "POST", { enabled });
    await refresh();
    notice(enabled ? "예약을 켰습니다. 표시된 다음 예약 시각부터 실행합니다." : "예약을 일시정지했습니다. 실행 중인 작업은 마무리하고, 대기 중인 예약과 나머지 키워드는 중단합니다. 다른 즉시수집 요청과 함께 처리하는 작업은 유지합니다.", "success");
  }));
  byId("workerScheduleRunNow").addEventListener("click", () => action(async () => {
    if (dirty) throw new Error("변경한 조건을 먼저 저장하세요.");
    if (!workerAvailability(workerData, "scheduled").ready) throw new Error(workerAvailability(workerData, "scheduled").reason);
    if (latest?.expired && latest.expiryReason !== "KEYWORD_SCHEDULE_TIME_EXPIRED") throw new Error("관측 기간을 수정하고 저장하세요.");
    pendingRequestId ||= typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `manual-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const result = await api("/api/worker-schedule/run-now", "POST", { requestId: pendingRequestId });
    pendingRequestId = null;
    await refresh();
    const state = result.status || result.occurrence?.status;
    notice(state && STATUS_LABELS[state] ? `예약워커 즉시수집: ${STATUS_LABELS[state]}. 예약 일정은 유지됩니다.` : "예약워커에 즉시수집을 요청했습니다. 최근 작업에서 결과를 확인하세요. 예약 일정은 유지됩니다.", ["blocked", "failed", "interrupted"].includes(state) ? "error" : "success");
  }));
  byId("collectorRefresh").addEventListener("click", () => refresh());
  byId("crawlWorkerKey").addEventListener("change", syncSelectedWorker);
  byId("crawlWorkerScheduleShortcut").addEventListener("click", () => selectWorker("scheduled", true));
  window.addEventListener("collector:requests-changed", () => { if (admin()) refresh(); });
  byId("crawlAllowRepeat")?.addEventListener("change", event => { byId("crawlRepeatReason").disabled = !event.target.checked; byId("crawlRepeatReason").required = event.target.checked; if (!event.target.checked) byId("crawlRepeatReason").value = ""; });
  const observer = new MutationObserver(() => { if (visible() && !loaded) refresh(); });
  observer.observe(document.body, { attributes: true, attributeFilter: ["class"] });
  const section = panel.closest("[data-admin-section-panel]");
  if (section) observer.observe(section, { attributes: true, attributeFilter: ["class"] });
  document.addEventListener("visibilitychange", () => { if (visible()) refresh(); });
  window.addEventListener("pagehide", () => observer.disconnect(), { once: true });
  setInterval(() => { if (visible() && !busy) refresh(); }, 15000);
  if (visible()) refresh();
})();
