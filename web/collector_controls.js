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
  function keywordSchedule(values) {
    const rawInterval = values.keywordIntervalMinutes ?? 0, intervalMinutes = Number(rawInterval);
    if (String(rawInterval).trim() === "" || !Number.isInteger(intervalMinutes) || intervalMinutes < 0 || intervalMinutes > 1440) throw new Error("키워드 간격은 0~1440분 사이의 정수로 입력하세요. 0은 연속 수집입니다.");
    if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(values.time)) throw new Error("실행 시각을 확인하세요.");
    const keywords = keywordLines(values.keywords), [hour, minute] = values.time.split(":").map(Number), startMinutes = hour * 60 + minute;
    if (startMinutes + Math.max(0, keywords.length - 1) * intervalMinutes >= 1440) throw new Error("마지막 키워드의 예정 시각이 다음 날로 넘어갑니다. 시작 시각이나 키워드 간격을 줄이세요.");
    return { intervalMinutes, items: keywords.map((keyword, index) => { const minutes = startMinutes + index * intervalMinutes; return { keyword, time: intervalMinutes === 0 && index > 0 ? "앞 키워드 완료 후" : `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}` }; }) };
  }
  function scheduleConfig(values) {
    if (values.searchMode !== undefined && !["keyword", "company"].includes(values.searchMode)) throw new Error("검색 대상을 지역·키워드 또는 업체명으로 선택하세요.");
    const keywords = keywordLines(values.keywords);
    if (!keywords.length || keywords.length > 100 || keywords.some(keyword => keyword.length > 160 || /[\x00-\x1f\x7f]/.test(keyword))) throw new Error("키워드를 한 줄에 하나씩, 최대 100개 입력하세요.");
    if (!validDay(values.firstDate)) throw new Error("첫 실행일을 확인하세요.");
    if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(values.time)) throw new Error("실행 시각을 확인하세요.");
    const { intervalMinutes: keywordIntervalMinutes } = keywordSchedule(values);
    const fixed = values.dateMode === "fixed";
    const bookingDays = fixed ? Math.round((Date.parse(values.checkOut) - Date.parse(values.checkIn)) / 86400000) + 1 : Number(values.days);
    if (fixed && (!validDay(values.checkIn) || !validDay(values.checkOut))) throw new Error("첫 관측일과 마지막 관측일을 확인하세요.");
    if (!Number.isInteger(bookingDays) || bookingDays < 1 || bookingDays > 31) throw new Error("관측 기간은 1~31일로 설정하세요. 마지막 관측일도 포함합니다.");
    const ranks = String(values.ranks).trim();
    if (!/^\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*$/.test(ranks) || ranks.split(",").some(range => { const [first, last = first] = range.split("-").map(Number); return first < 1 || last > 100 || first > last; })) throw new Error("상세수집 순위를 1~100위 안에서 입력하세요. 예: 1-20");
    return { version: 1, timezone: "Asia/Seoul", repeat: values.repeat, firstDate: values.firstDate, time: values.time, keywords, keywordIntervalMinutes,
      collection: { dateMode: fixed ? "fixed" : "rolling", bookingDays, checkIn: fixed ? values.checkIn : null, checkOut: fixed ? values.checkOut : null,
        adults: 2, searchMode: values.searchMode || "keyword", detailRankRanges: ranks, productMode: "all", collectionMode: "precision", collectionPurpose: values.purpose === "basic_db" ? "basic_db" : "revenue_detail", dayUseMode: normalizeDayUse(values.dayUseMode) }, requestPacing: null };
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
    if (text === "COLLECTOR_SCOPE_MISMATCH") return "요청한 검색 조건과 결과의 조건이 달라 등록하지 못했습니다. 보존 자료와 수집 조건을 확인하세요.";
    if (text === "COLLECTOR_DUPLICATE_PATH") return "상세 파일 목록이 중복되어 최종 저장 검증에 실패했습니다. 보존 자료 복구가 필요합니다.";
    if (text === "COLLECTOR_UPLOAD_FAILED") return "수집 결과의 전송 또는 최종 저장 확인에 실패했습니다.";
    if (/PROVIDER_(?:BLOCKED|ACCESS)|NAVER.*BLOCK|CAPTCHA|TOO_MANY|BookingAPITooManyRequests|HTTP_(403|429)/i.test(text)) return "네이버 접근 제한이 감지되어 수집을 멈췄습니다. 운영 점검이 필요합니다.";
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
  function defaultDraft(now = Date.now()) { const today = todayKst(now), firstDate = Date.parse(`${today}T14:00:00+09:00`) <= now ? addDays(today, 1) : today; return { keywords: "", searchMode: "keyword", period: "7", checkIn: today, checkOut: addDays(today, 6), purpose: "basic_db", ranks: "1-20", dayUseMode: "inspect", execution: "now", repeat: "once", firstDate, time: "14:00", keywordIntervalMinutes: 0, allowRepeat: false, repeatReason: "" }; }
  function scheduleStartError(values, now = Date.now()) { return values.repeat === "once" && Date.parse(`${values.firstDate}T${values.time}:00+09:00`) <= now ? "예약 시각이 지났습니다. 앞으로 실행할 날짜와 시각을 선택하세요." : ""; }
  function reservationSummary(values) {
    const date = validDay(values.firstDate) ? values.firstDate.replace(/-/g, ".") : "날짜 확인 필요";
    const time = /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(values.time) ? `${values.time} KST` : "시각 확인 필요";
    const repeat = { once: "한 번", daily: "매일", weekdays: "평일 · 월~금" }[values.repeat] || "반복 확인 필요";
    const interval = Number(values.keywordIntervalMinutes || 0), intervalLabel = interval === 0 ? "연속 수집" : interval === 60 ? "1시간 간격" : `${interval}분 간격`;
    return `${date} · ${time} · ${repeat} · ${intervalLabel}`;
  }
  function historyEntries(requests = [], schedules = {}) {
    const rows = requests.map(item => ({ ...item, collectionQuality: item.result?.collectionQuality || item.collectionQuality, workerKey: workerKey(item.workerKey), trigger: "manual", runId: item.result?.runId, stamp: item.createdAt || item.startedAt }));
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
  function etaRange(seconds) {
    if (!Number.isFinite(seconds) || seconds <= 0) return "응답 확인 중";
    if (seconds < 60) { const low = Math.max(10, Math.floor(seconds * .8 / 10) * 10), high = Math.max(low, Math.ceil(seconds * 1.2 / 10) * 10); return low === high ? `약 ${low}초` : `약 ${low}~${high}초`; }
    const low = Math.max(1, Math.round(seconds * .8 / 60)), high = Math.max(low, Math.ceil(seconds * 1.2 / 60));
    return low === high ? `약 ${low}분` : `약 ${low}~${high}분`;
  }
  function progressModel(worker = {}, record = null, now = Date.now(), receivedAt = now) {
    const crawl = worker.crawl || {}, active = Boolean(crawl.active || worker.activeJobId);
    const terminalStatus = !active && workerQueueCount(worker) === 0 && ["complete", "completed", "reused", "failed", "partial", "blocked", "interrupted", "cancelled"].includes(record?.status) ? record.status : "";
    const verified = ["complete", "completed", "reused"].includes(terminalStatus) && Boolean(record?.runId || record?.result?.runId)
      && (!record?.result || record.result.collectionQuality?.status === "complete");
    const progress = crawl.progress;
    const validCounts = active && progress?.version === 1 && progress.source === "actual" && Number.isInteger(progress.totalPlaces) && progress.totalPlaces > 0
      && Number.isInteger(progress.completedPlaces) && progress.completedPlaces >= 0 && progress.completedPlaces <= progress.totalPlaces;
    const reportAt = Math.max(Date.parse(crawl.lastProgressAt || "") || 0, Date.parse(progress?.receivedAt || progress?.updatedAt || "") || 0);
    const staleConnection = active && (!workerFresh(worker, now) || now - receivedAt > 30000);
    const stalled = active && reportAt > 0 && now - reportAt > 90000;
    const paused = Boolean(worker.halted || crawl.cancelling || staleConnection || stalled);
    const pending = !active && !terminalStatus && (workerQueueCount(worker) > 0 || ["pending", "queued", "running"].includes(record?.status));
    const stageKey = crawl.stageSource === "runtime" ? crawl.currentStage?.key || "" : "";
    const phase = verified ? 3 : /^(save|uploading|completing)$/.test(stageKey) ? 2 : stageKey === "inventory" || validCounts ? 1 : stageKey ? 0 : -1;
    let state = verified ? "complete" : terminalStatus ? "attention" : active ? "running" : pending ? "queued" : "idle";
    if (worker.halted || crawl.cancelling || staleConnection || stalled) state = "attention";
    const secondsSinceStatus = receivedAt > 0 ? Math.max(0, Math.min(30, Math.floor((now - receivedAt) / 1000))) : 0;
    const remaining = Number.isFinite(crawl.remainingSeconds) ? Math.max(0, crawl.remainingSeconds - secondsSinceStatus) : null;
    const delay = active && (crawl.isDelayed || remaining === 0);
    const eta = worker.halted ? "수집 중단" : crawl.cancelling ? "중단 처리 중" : staleConnection ? "연결 확인 필요" : stalled ? "응답 확인 중" : verified ? "저장·검증 완료" : ["complete", "completed", "reused"].includes(terminalStatus) ? "정상 저장 확인 필요" : terminalStatus ? STATUS_LABELS[terminalStatus] || "확인 필요" : pending ? "차례를 기다리는 중" : delay ? "예상보다 지연" : active ? etaRange(remaining) : "";
    const error = worker.halted ? errorMessage(worker.brokerErrorCode || worker.errorCode) : terminalStatus && !verified ? qualityReason(record.collectionQuality || record.result?.collectionQuality) || errorMessage(record.brokerErrorCode || record.errorCode) : "";
    const keyword = crawl.activeJob?.keyword || crawl.currentJob?.keyword || record?.keyword || "수집 작업";
    return { visible: active || pending || Boolean(terminalStatus) || Boolean(worker.halted), state, active, animated: active && !paused && !delay, keyword, eta,
      label: active && !paused && !delay ? "예상 남은 시간" : verified ? "결과 확인" : "진행 상태", phase,
      elapsed: Number.isFinite(crawl.elapsedSeconds) ? durationLabel({durationMs:(crawl.elapsedSeconds + (active && !staleConnection ? secondsSinceStatus : 0)) * 1000}) : "",
      completeAt: active && !paused && !delay ? formatTime(crawl.estimatedCompleteAt) : "",
      countText: validCounts ? `${progress.completedPlaces} / ${progress.totalPlaces}곳 처리` : "처리 수량 확인 중",
      percent: validCounts ? Math.round(progress.completedPlaces / progress.totalPlaces * 100) : null,
      completedPlaces: validCounts ? progress.completedPlaces : null, totalPlaces: validCounts ? progress.totalPlaces : null,
      detail: error || (staleConnection ? "최근 서버 상태를 받지 못했습니다. 완료 여부를 확인하고 있습니다." : stalled ? "워커 연결과 별도로 새 처리 보고를 기다립니다." : delay ? "완료 시각을 다시 확인하고 있습니다. 수집 결과 저장 전까지 완료로 표시하지 않습니다." : verified ? "정상 결과가 중앙 보관함에 저장되었습니다." : phase === 2 ? "2G 서버로 결과를 보내고 저장·검증하고 있습니다." : validCounts ? `${progress.currentPlaceName ? `${progress.currentPlaceName} · ` : ""}처리 수량에는 실패한 업체가 포함될 수 있습니다.` : "서버에서 확인한 단계와 처리 수량을 표시합니다."),
      basis: crawl.estimateBasis?.timing?.source === "measured" ? `최근 유사 수집 ${crawl.estimateBasis.timing.sampleCount || 0}건 기준` : "수집 조건 기준 추정",
      runId: verified ? record.runId || record.result.runId : null };
  }
  const QUALITY_REASONS = {
    product_targets_truncated: "상품 수 제한으로 일부 미수집", product_targets_incomplete: "일부 상품을 조회하지 못함",
    product_day_targets_incomplete: "일부 상품·숙박일 응답 미확보", product_list_incomplete: "상품 목록을 끝까지 확인하지 못함",
    product_coverage_missing: "상품별 조회 범위 기록 없음", product_coverage_invalid: "상품별 조회 범위 검증 필요",
    booking_schedule_responses_incomplete: "일부 예약 일정 응답 미확보", booking_results_incomplete: "일부 업체의 예약 자료 미확보",
    booking_targets_incomplete: "일부 대상 업체 미수집", auxiliary_ota_incomplete: "보조 예약채널 자료 일부 미확보",
    quality_metadata_missing: "수집 품질 기록 일부 없음", collection_profile_missing: "수집 조건 기록 없음",
    naver_request_blocked: "네이버 접근 제한 감지", naver_main_rate_limited: "네이버 요청량 제한 감지",
    naver_main_access_blocked: "네이버 접근 제한 감지", naver_booking_blocked: "네이버 예약 접근 제한 감지", naver_schedule_blocked: "예약 일정 접근 제한 감지",
    collection_execution_failed: "수집 작업 실패", naver_main_request_failed: "검색 응답 미확보", no_main_results: "검색 결과 없음",
    no_successful_booking_results: "예약 자료 미확보", no_booking_schedule_requests: "예약 일정 조회 기록 없음",
    inconsistent_booking_counts: "업체 성공 건수 검증 필요", inconsistent_ota_counts: "보조 예약채널 건수 검증 필요", inconsistent_schedule_counts: "예약 일정 건수 검증 필요",
    inventory_review_required: "객실 수량 검토 필요", quantity_review_required: "객실 수량 검토 필요",
    manifest_missing: "결과 확인 기록 없음", manifest_unreadable: "결과 확인 기록을 읽지 못함", result_artifacts_missing: "결과 파일 기록 없음"
  };
  function qualityReason(quality = {}) {
    const reason = quality?.reason || "";
    const failureLabels = { NAVER_SEARCH_STATE_MISSING: "검색 응답에 업체 목록 데이터가 없음", NAVER_SEARCH_STATE_INVALID: "검색 응답의 업체 목록을 해석하지 못함", NAVER_SEARCH_RESULT_UNSUPPORTED: "선택한 검색 방식에 맞는 결과 목록이 없음", NAVER_SEARCH_HTTP_ERROR: "검색 서버 오류 응답", COLLECTION_NETWORK_ERROR: "수집 서버 통신 실패", COLLECTION_TIMEOUT: "수집 응답 시간 초과", COLLECTION_STAGE_FAILED: "수집 단계 실행 실패" };
    const phases = { setup: "수집 준비", naver_main: "첫 검색", naver_regional: "지역 검색", nol: "NOL 조회", yeogi: "여기어때 조회", ddnayo: "떠나요 조회", ota: "예약 채널 확인", booking: "예약 상세 조회", output: "결과 파일 저장" };
    const failure = quality?.failure;
    if (reason === "collection_execution_failed" && Object.hasOwn(failureLabels, failure?.code) && Object.hasOwn(phases, failure?.phase)) return `${phases[failure.phase]} · ${failureLabels[failure.code]}${Number.isInteger(failure.httpStatus) && failure.httpStatus >= 100 && failure.httpStatus <= 599 ? ` (HTTP ${failure.httpStatus})` : ""}`;
    if (reason === "manifest_checks_passed") return "";
    if (Object.hasOwn(QUALITY_REASONS, reason)) return QUALITY_REASONS[reason];
    if (/_mismatch$|_invalid$/.test(reason)) return "수집 조건·결과 검증 필요";
    return reason || ["partial", "failed", "blocked", "interrupted"].includes(quality?.status) ? "세부 원인 기록 확인 필요" : "";
  }
  function diagnosticCount(value) { return value !== null && value !== undefined && value !== "" && Number.isInteger(Number(value)) && Number(value) >= 0 ? Number(value).toLocaleString("ko-KR") : "미기록"; }
  function diagnosticMetrics(counts = {}) {
    const rows = [
      `업체 응답 성공 ${diagnosticCount(counts.naverBookingStockSucceeded)} / 확인 ${diagnosticCount(counts.naverBookingStockChecked)}`,
      `예약 일정 성공 ${diagnosticCount(counts.naverScheduleSucceeded)} / 요청 ${diagnosticCount(counts.naverScheduleRequested)}`,
      `예약 일정 실패 ${diagnosticCount(counts.naverScheduleFailed)} · 차단 ${diagnosticCount(counts.naverScheduleBlocked)}`
    ];
    if (counts.productEligible != null || counts.productQueried != null || counts.productTruncated != null) rows.push(`대상 상품 ${diagnosticCount(counts.productEligible)}개 · 조회 ${diagnosticCount(counts.productQueried)}개 · 수 제한으로 미조회 ${diagnosticCount(counts.productTruncated)}개`);
    return rows;
  }
  function diagnosticDates(values = []) {
    const dates = [...new Set((Array.isArray(values) ? values : []).filter(validDay))].sort();
    if (!dates.length) return "세부 기록 없음";
    if (dates.length > 2 && dates.every((date, index) => index === 0 || Date.parse(date) - Date.parse(dates[index - 1]) === 86400000)) return `${dates[0]} ~ ${dates.at(-1)} (${dates.length}일)`;
    return dates.join(", ");
  }
  if (typeof module !== "undefined" && module.exports) module.exports = { workerKey, workerLabel, keywordLines, duplicateKeywordCount, scheduleConfig, keywordSchedule, formatTime, workerState, workerQueueCount, workerAvailability, durationLabel, errorMessage, STATUS_LABELS, normalizeDayUse, collectionDates, defaultDraft, reservationSummary, historyEntries, filterHistory, etaRange, progressModel, qualityReason, diagnosticMetrics, diagnosticDates };
  if (typeof document === "undefined") return;
  // Reuse the same stored-only diagnosis in history and the archive. Opening it never starts collection.
  const diagnosticCache = new Map(), diagnosticOpen = new Map();
  function diagnosticIssueTone(issue = {}) {
    return /quantity|inventory|capacity|stock.*review/i.test(issue.code || "") ? "review" : /truncat|limit|coverage|unqueried/i.test(issue.code || "") ? "scope" : "attention";
  }
  function renderDiagnosticBody(body, value, quality = {}) {
    body.replaceChildren();
    if (!value) {
      body.append(node("p", "세부 기록 없음 · 이 결과에는 원인을 확인할 세부 기록이 없습니다.", "collection-diagnostic-note"));
      for (const metric of diagnosticMetrics(quality.counts)) body.append(node("p", metric, "collection-diagnostic-count"));
      return;
    }
    body.append(node("p", value.summary || value.reasonLabel || qualityReason(value) || "저장된 수집 기록을 확인했습니다.", "collection-diagnostic-summary"));
    const metrics = node("div", "", "collection-diagnostic-metrics");
    for (const metric of diagnosticMetrics(value.counts || quality.counts)) metrics.append(node("p", metric, "collection-diagnostic-count"));
    body.append(metrics);
    if (Number.isInteger(value.observedZeroScheduleCount) && Number.isInteger(value.failedZeroScheduleCount) && (value.observedZeroScheduleCount > 0 || value.failedZeroScheduleCount > 0)) body.append(node("p", `재고 0 응답: 정상 응답 ${diagnosticCount(value.observedZeroScheduleCount)}건 · 오류가 동반된 0 ${diagnosticCount(value.failedZeroScheduleCount)}건 (상품·숙박일 기준)`, "collection-diagnostic-note"));
    const issues = Array.isArray(value.issues) ? value.issues : [];
    for (const issue of issues) {
      const item = node("article", "", "collection-diagnostic-issue"), tone = diagnosticIssueTone(issue);
      item.dataset.tone = tone;
      item.append(node("strong", `${tone === "review" ? "수량 검토 · " : ""}${issue.label || "수집 기록 확인"}`));
      item.append(node("p", `업체: ${issue.companyName || "이름 미기록"}${issue.productName ? ` · 상품: ${issue.productName}` : ""}`));
      if (!issue.productName && issue.phase !== "validation") item.append(node("small", "상품별 이름은 미기록"));
      item.append(node("p", `숙박일: ${diagnosticDates(issue.dates)}`));
      if (issue.code === "PRODUCT_TARGETS_TRUNCATED" && Number.isInteger(issue.affectedCount)) item.append(node("p", `대상 ${diagnosticCount(issue.expectedCount)}개 상품 · 조회 ${diagnosticCount(issue.queriedCount)}개 · 수 제한으로 미조회 ${diagnosticCount(issue.affectedCount)}개 · 요청 실패와 구분`));
      else if (issue.countUnit === "product_dates" && Number.isInteger(issue.affectedCount)) item.append(node("p", `미확보 ${diagnosticCount(issue.affectedCount)}건 · 상품·숙박일별 조회 기준`));
      if (Number.isInteger(issue.httpStatus) && issue.httpStatus >= 100 && issue.httpStatus <= 599) item.append(node("p", `응답 상태 HTTP ${issue.httpStatus}`));
      if (issue.message && issue.message !== issue.label && issue.detailStatus !== "unrecorded") item.append(node("p", issue.message));
      if (issue.detailStatus === "unrecorded") item.append(node("small", "세부 기록 없음 · 개별 응답 원인을 확정할 수 없습니다."));
      body.append(item);
    }
    if (!issues.length) body.append(node("p", value.status === "complete" ? "저장 기록에서 수집 실패는 확인되지 않았습니다. 객실 수량 검토는 별도입니다." : "세부 기록 없음 · 일부 완료만으로 접근 차단을 판단하지 않습니다.", "collection-diagnostic-note"));
    if (value.truncated) body.append(node("p", "세부 기록이 많아 일부만 표시합니다.", "collection-diagnostic-note"));
    for (const limitation of value.limitations || []) body.append(node("p", limitation, "collection-diagnostic-note"));
    body.append(node("p", "상품 수는 실제 객실 수와 다릅니다. 숙박일별 기록을 더해 객실 수로 계산하지 않습니다.", "collection-diagnostic-note"));
  }
  async function storedDiagnostics(runId) {
    if (diagnosticCache.has(runId)) return diagnosticCache.get(runId);
    const pending = (async () => {
      const response = await fetch(`/api/runs/${encodeURIComponent(runId)}/diagnostics`, { method: "GET", credentials: "same-origin" });
      if (!response.ok) throw new Error(response.status === 401 || response.status === 403 ? "관리자 로그인을 확인하세요." : "저장된 원인 기록을 불러오지 못했습니다.");
      const payload = await response.json();
      if (payload.runId !== runId) throw new Error("결과 번호가 일치하지 않아 표시하지 않았습니다.");
      return payload.collectionDiagnostics || null;
    })();
    diagnosticCache.set(runId, pending);
    return pending;
  }
  function diagnosticCard(runId, quality = {}, scope = "history") {
    const details = node("details", "", "collection-diagnostics"), summary = node("summary"), body = node("div", "", "collection-diagnostic-body");
    const key = `${scope}:${runId}`, reason = qualityReason(quality);
    summary.append(node("strong", "원인 확인"));
    if (reason) summary.append(node("small", reason));
    details.append(summary, body); body.setAttribute("aria-live", "polite");
    let loaded = false;
    const load = async () => {
      if (loaded) return; loaded = true; body.replaceChildren(node("p", "저장된 원인 기록을 확인하는 중입니다.", "collection-diagnostic-note"));
      if (!runId) { renderDiagnosticBody(body, null, quality); return; }
      try { renderDiagnosticBody(body, await storedDiagnostics(runId), quality); }
      catch (error) {
        body.replaceChildren(node("p", error.message, "collection-diagnostic-note"));
        const retry = node("button", "다시 확인", "small-button"); retry.type = "button";
        retry.addEventListener("click", () => { diagnosticCache.delete(runId); loaded = false; return load(); }); body.append(retry);
      }
    };
    details.addEventListener("toggle", () => { diagnosticOpen.set(key, details.open); if (details.open) return load(); });
    if (diagnosticOpen.get(key)) { details.open = true; load(); }
    return details;
  }
  window.CollectionDiagnosticsUi = {
    qualityReason,
    mount(root, runs) {
      for (const slot of root?.querySelectorAll?.("[data-collection-diagnostics]") || []) {
        const run = runs.find(item => item.id === slot.dataset.collectionDiagnostics);
        if (run) slot.replaceChildren(diagnosticCard(run.id, run.collectionQuality, "archive"));
      }
    }
  };
  window.dispatchEvent(new CustomEvent("collector:diagnostics-ready"));
  const byId = id => document.getElementById(id);
  const panel = byId("collectorControlsCard");
  if (!panel) return;
  const cards = new Map();
  const schedules = {};
  let workerData = null, lastWorkerData = null, requests = [], refreshInFlight = null, loaded = false, requestsReadError = false, statusReceivedAt = 0, lastRefreshAt = 0;
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
  function makeProgress(card) {
    const panel = node("section", "", "collector-live-progress"); panel.hidden = true; panel.setAttribute("aria-label", `${workerLabel(card.key)} 수집 진행`);
    const heading = node("div", "", "collector-progress-heading"); heading.append(node("span", "", "collector-progress-dot"));
    const keyword = node("strong", "수집 작업"); heading.append(keyword);
    const label = node("span", "예상 남은 시간", "collector-eta-label"), eta = node("strong", "시간 확인 중", "collector-eta-value"), meta = node("small", "", "collector-progress-meta");
    const count = node("strong", "처리 수량 확인 중", "collector-progress-count"), meter = node("div", "", "collector-actual-meter"), bar = node("span");
    meter.setAttribute("role", "progressbar"); meter.setAttribute("aria-label", "업체 처리 진행 · 결과 저장과 검증은 별도"); meter.append(bar);
    const steps = node("ol", "", "collector-progress-steps");
    for (const [index, title] of ["목록 확인", "상세수집", "저장·검증"].entries()) { const step = node("li"); step.append(node("span", String(index + 1)), node("small", title)); steps.append(step); }
    const detail = node("p", "", "collector-progress-detail"), basis = node("small", "", "collector-progress-basis"), announcement = node("span", "", "sr-only");
    announcement.setAttribute("aria-live", "polite"); announcement.setAttribute("aria-atomic", "true");
    panel.append(heading, label, eta, meta, count, meter, steps, detail, basis, announcement);
    card.progress = { panel, keyword, label, eta, meta, count, meter, bar, steps, detail, basis, announcement };
    return panel;
  }
  function makeCard(key, index) {
    const card = { key, inputs: {}, fields: {}, dirty: false, busy: false, loaded: false };
    card.root = node("details", "", "collector-worker-card"); card.root.dataset.workerKey = key; card.root.open = true;
    const summary = node("summary", "", "collector-worker-summary");
    const identity = node("div", "", "collector-worker-identity"); identity.append(node("span", `0${index + 1}`, "collector-worker-number"));
    const name = node("div"); name.append(node("h4", workerLabel(key))); card.summary = node("small", "조건을 설정하세요"); card.summaryProgress = node("small", "", "collector-summary-progress"); card.summaryProgress.hidden = true; name.append(card.summary, card.summaryProgress); identity.append(name);
    card.badge = node("span", "확인 중", "state-badge"); summary.append(identity, card.badge, node("span", "", "collector-chevron")); card.root.append(summary);
    card.form = node("form", "", "collector-worker-form");
    const intro = node("div", "", "collector-card-status"); card.state = node("p", "연결 상태 확인 중"); card.next = node("small", "예약 꺼짐"); intro.append(card.state, card.next); card.form.append(intro, makeProgress(card));
    const common = node("div", "", "collector-common-fields");
    common.append(field(card, "searchMode", "검색 대상", "select", { choices: [["keyword", "지역·키워드"], ["company", "업체명"]] }));
    common.append(node("p", "특정 숙소를 찾을 때는 업체명을 선택하세요. 선택한 방식은 즉시수집과 예약수집에 함께 적용됩니다.", "collector-field-hint"));
    common.append(field(card, "keywords", "검색 키워드", "textarea", { rows: 2, maxLength: 17000, placeholder: "예: 경남글램핑\n여러 키워드는 한 줄에 하나씩", required: true }));
    const grid = node("div", "", "collector-settings-grid");
    grid.append(field(card, "period", "조회할 숙박일", "select", { choices: [["1", "수집 당일"], ["7", "수집일부터 7일"], ["14", "수집일부터 14일"], ["31", "수집일부터 31일"], ["custom", "날짜 직접 지정"]] }), field(card, "ranks", "수집 순위", "text", { maxLength: 150, placeholder: "예: 1-20", required: true }));
    grid.append(field(card, "purpose", "수집 종류", "select", { choices: [["basic_db", "기본수집"], ["revenue_detail", "상세수집"]] }), field(card, "dayUseMode", "데이유즈", "select", { choices: [["inspect", "유무확인"], ["lodging_only", "숙박만"], ["detail", "상세수집"]] }));
    common.append(grid);
    const execution = node("div", "", "collector-execution-field"); execution.append(field(card, "execution", "실행 방식", "select", { choices: [["now", "즉시수집"], ["schedule", "예약수집"]] })); common.append(execution); card.form.append(common);
    card.customDates = node("div", "", "collector-settings-grid collector-custom-dates"); card.customDates.append(field(card, "checkIn", "숙박 시작일", "date"), field(card, "checkOut", "숙박 종료일 · 포함", "date")); card.form.append(card.customDates);
    card.reservation = node("details", "", "collector-reservation");
    const reservationHeading = node("summary", "", "collector-reservation-summary"), reservationCopy = node("span");
    card.reservationLabel = node("strong", "예약 조건"); card.reservationValue = node("small", "조건 확인");
    reservationCopy.append(card.reservationLabel, card.reservationValue); reservationHeading.append(reservationCopy, node("span", "", "collector-chevron"));
    const reservationBody = node("div", "", "collector-reservation-body"), reservationGrid = node("div", "", "collector-settings-grid");
    reservationGrid.append(field(card, "firstDate", "수집 실행일", "date", { min: "2000-01-01", max: "2099-12-31" }), field(card, "time", "첫 키워드 시각 · 한국시간", "time"), field(card, "repeat", "반복", "select", { choices: [["once", "한 번"], ["daily", "매일"], ["weekdays", "평일 · 월~금"]] }), field(card, "keywordIntervalMinutes", "키워드 간격 · 분", "number", { min: 0, max: 1440, step: 1 }));
    card.intervalHint = node("p", "0: 앞 키워드 완료 후 연속 · 60: 1시간 간격. 모든 예정 시각은 수집 실행일 안에 설정하세요.", "collector-field-hint");
    card.keywordSchedule = node("table", "", "collector-keyword-schedule"); card.keywordSchedule.append(node("caption", "키워드별 시작 예정 · 한국시간"));
    card.keywordScheduleBody = node("tbody"); card.keywordSchedule.append(card.keywordScheduleBody);
    card.reservationHint = node("p", "", "collector-field-hint"); reservationBody.append(reservationGrid, card.intervalHint, card.keywordSchedule, card.reservationHint); card.reservation.append(reservationHeading, reservationBody); card.form.append(card.reservation);
    card.repeat = node("details", "", "collector-repeat-options"); card.repeat.append(node("summary", "당일 재수집 옵션")); card.repeat.append(field(card, "allowRepeat", "기존 자료 대신 다시 수집", "checkbox"), field(card, "repeatReason", "재수집 사유", "text", { maxLength: 200, placeholder: "4글자 이상 입력" }), node("p", "기본은 세 워커의 당일 정상 자료를 먼저 확인합니다. 접근 제한 보호는 유지됩니다.", "collector-field-hint")); card.form.append(card.repeat);
    card.detailHint = node("p", "", "collector-field-hint"); card.form.append(card.detailHint);
    card.notice = node("p", "", "collector-control-status"); card.notice.setAttribute("role", "status"); card.notice.setAttribute("aria-live", "polite"); card.form.append(card.notice);
    const footer = node("footer", "", "collector-card-footer"), actions = node("div", "", "collector-card-actions"); card.submit = node("button", "지금 수집", "primary-button"); card.submit.type = "submit"; card.save = button("예약 조건 저장", "secondary-button", () => action(card, () => saveSchedule(card))); card.pause = button("예약 일시정지", "ghost-button", () => action(card, () => pauseSchedule(card))); actions.append(card.submit, card.save, card.pause); footer.append(actions);
    card.lastResult = node("div", "", "collector-last-result"); footer.append(card.lastResult); card.form.append(footer); card.root.append(card.form);
    card.form.addEventListener("input", () => { card.dirty = true; syncCard(card); saveDraft(card); });
    card.form.addEventListener("change", event => { if (event.target === card.inputs.execution && event.target.value === "schedule") card.reservation.open = true; card.dirty = true; syncCard(card); saveDraft(card); });
    card.form.addEventListener("invalid", event => { if ([card.inputs.firstDate, card.inputs.time, card.inputs.repeat, card.inputs.keywordIntervalMinutes].includes(event.target)) card.reservation.open = true; if (event.target === card.inputs.repeatReason) card.repeat.open = true; }, true);
    card.form.addEventListener("submit", event => { event.preventDefault(); if (card.form.reportValidity()) action(card, () => values(card).execution === "schedule" ? enableSchedule(card) : runNow(card)); });
    cards.set(key, card); fill(card, { ...defaultDraft(), ...(drafts[key] || {}) }); return card.root;
  }
  function syncCard(card) {
    const v = values(card), custom = v.period === "custom", reservation = v.execution === "schedule";
    card.inputs.keywords.placeholder = v.searchMode === "company" ? "예: 제주바블\n업체명은 한 줄에 하나씩" : "예: 조천숙소\n여러 키워드는 한 줄에 하나씩";
    const availability = workerAvailability(workerData, card.key), schedule = schedules[card.key];
    card.fields.checkIn.hidden = card.fields.checkOut.hidden = !custom;
    card.customDates.hidden = !custom;
    card.inputs.checkIn.required = card.inputs.checkOut.required = custom;
    card.reservation.hidden = !reservation; card.inputs.firstDate.required = card.inputs.time.required = reservation;
    card.inputs.keywordIntervalMinutes.required = reservation; card.inputs.keywordIntervalMinutes.disabled = !reservation;
    card.repeat.hidden = reservation; card.inputs.repeatReason.disabled = !v.allowRepeat; card.inputs.repeatReason.required = v.allowRepeat && !reservation;
    const detailChoice = [...card.inputs.dayUseMode.children].find(option => option.value === "detail"); if (detailChoice) detailChoice.disabled = v.purpose === "basic_db";
    if (v.purpose === "basic_db" && v.dayUseMode === "detail") { card.inputs.dayUseMode.value = "inspect"; v.dayUseMode = "inspect"; }
    card.detailHint.textContent = v.purpose === "basic_db" ? "기본수집은 업체·상품 목록과 데이유즈 유무를 확인합니다. 날짜별 예약·가격은 상세수집에서 확인합니다." : v.dayUseMode === "detail" ? "숙박과 데이유즈의 날짜별 예약·가격을 함께 확인합니다. 객실 공유 여부는 수집 근거로 별도 판단합니다." : v.dayUseMode === "lodging_only" ? "숙박의 날짜별 예약·가격을 확인합니다. 데이유즈 예약 상세는 수집하지 않습니다." : "상품 목록에서 데이유즈 유무를 확인하고, 숙박의 날짜별 예약·가격을 수집합니다.";
    const keyword = keywordLines(v.keywords); const date = custom ? `${v.checkIn || "시작일"} ~ ${v.checkOut || "종료일"}` : `${v.period}일`;
    card.summary.textContent = `${keyword[0] || "키워드 미입력"}${keyword.length > 1 ? ` 외 ${keyword.length - 1}개` : ""} · ${date} · ${v.purpose === "basic_db" ? "기본" : "상세"}`;
    let plan = null, intervalError = "";
    try { plan = keywordSchedule(v); } catch (error) { intervalError = error.message; }
    const expiredDraft = scheduleStartError(v), reservationError = expiredDraft || intervalError;
    card.keywordSchedule.hidden = !plan?.items.length;
    card.keywordScheduleBody.replaceChildren(...(plan?.items || []).map(item => { const row = node("tr"), keyword = node("th", item.keyword); keyword.setAttribute("scope", "row"); row.append(keyword, node("td", item.time)); return row; }));
    card.reservationLabel.textContent = reservationError ? "예약 시각 확인 필요" : "예약 조건";
    card.reservationValue.textContent = reservationSummary(v);
    card.reservationHint.textContent = reservationError || "조회할 숙박일과 수집 실행일은 서로 다릅니다. 키워드는 순서대로 수집하며, 앞 수집이 길어지면 예정 시각보다 늦어질 수 있습니다.";
    card.reservationHint.className = reservationError ? "collector-field-hint collector-worker-alert" : "collector-field-hint";
    card.submit.disabled = card.busy || !availability.ready || (reservation && (!schedule?.config || Boolean(reservationError)));
    card.submit.title = !availability.ready ? availability.reason : reservation ? reservationError : "";
    const reservationLabel = v.repeat === "once" ? `${v.firstDate.slice(5).replace("-", "/")} ${v.time}` : `${v.repeat === "weekdays" ? "평일" : "매일"} ${v.time}`;
    card.submit.textContent = card.busy ? "처리 중…" : reservation ? `${reservationLabel} ${schedule?.config?.enabled ? "예약 변경" : "예약 등록"}` : "지금 수집";
    card.save.hidden = !reservation; card.save.disabled = card.busy || !schedule?.config || Boolean(intervalError);
    card.pause.hidden = !schedule?.config?.enabled; card.pause.disabled = card.busy;
    card.next.textContent = schedule?.enabled && schedule.nextRunAt ? `다음 예약 ${formatTime(schedule.nextRunAt)}` : schedule?.enabled ? "예약 켜짐 · 다음 실행 확인 필요" : "예약 꺼짐";
    if (schedule?.active) {
      const activeItems = (schedule.latest || []).filter(entry => schedule.activeOccurrenceIds?.includes(entry.id)).flatMap(entry => entry.items || []);
      const running = activeItems.find(item => item.status === "running"), next = activeItems.find(item => item.status === "queued" && Number.isFinite(Date.parse(item.scheduledAt)));
      card.next.textContent = `${running ? `예약 진행 중 · ${running.keyword}` : "예약 진행 중"}${next ? ` · 다음 키워드 예정 ${formatTime(next.scheduledAt)} · ${next.keyword}` : ""}`;
    } else if (schedule?.expired) card.next.textContent = "예약 날짜 확인 필요 · 실행일 또는 숙박일을 수정하세요";
  }
  function renderWorkers() {
    for (const card of cards.values()) {
      const worker = (workerData || lastWorkerData)?.workers?.find(item => item.workerKey === card.key) || { workerKey: card.key, configured: false };
      card.badge.textContent = workerData ? workerState(worker) : "연결 확인 필요";
      card.root.dataset.state = worker.halted ? "alert" : worker.activeJobId || worker.crawl?.active ? "running" : "idle";
      const current = worker.crawl?.activeJob || worker.crawl?.currentJob;
      card.state.textContent = current?.keyword ? `${current.keyword} 수집 중${Number.isFinite(worker.crawl?.elapsedSeconds) ? ` · ${durationLabel({ durationMs: worker.crawl.elapsedSeconds * 1000 })} 경과` : ""}` : `${workerAvailability(workerData, card.key).reason} 대기 ${workerQueueCount(worker)}건`;
      syncCard(card);
    }
    renderProgress();
    syncLegacyAvailability();
  }
  function renderProgress() {
    const rows = historyEntries(requests, schedules), compactRows = [];
    for (const card of cards.values()) {
      const worker = (workerData || lastWorkerData)?.workers?.find(item => item.workerKey === card.key) || { workerKey: card.key, configured: false };
      const latest = rows.find(row => row.workerKey === card.key);
      const recordedAt = latest ? Date.parse(latest.finishedAt || latest.endedAt || latest.stamp) || Number(latest.stamp) : 0;
      const recent = latest && (["pending", "running", "queued"].includes(latest.status) || Date.now() - recordedAt < 300000) ? latest : null;
      const model = progressModel(worker, recent, Date.now(), statusReceivedAt);
      const p = card.progress; p.panel.hidden = !model.visible; p.panel.dataset.state = model.state; p.panel.dataset.animated = String(model.animated);
      card.summaryProgress.hidden = !model.visible; card.summaryProgress.textContent = model.visible ? `${model.keyword} · ${model.eta}` : "";
      card.root.dataset.progress = model.visible ? model.state : "idle";
      if (!model.visible) continue;
      p.keyword.textContent = model.keyword; p.label.textContent = model.label; p.eta.textContent = model.eta;
      p.meta.textContent = [model.active && model.elapsed ? `경과 ${model.elapsed}` : "", model.completeAt && model.completeAt !== "없음" ? `종료 예상 ${model.completeAt}` : ""].filter(Boolean).join(" · ");
      p.count.textContent = model.state === "complete" ? "결과 저장·검증 확인" : model.countText;
      p.count.hidden = !model.active && model.state !== "complete";
      p.meter.hidden = model.state === "complete" || !model.active;
      p.steps.hidden = !model.active && model.state !== "complete";
      p.meter.dataset.determinate = String(model.percent !== null);
      p.bar.style.width = model.percent === null ? "35%" : `${model.percent}%`;
      p.meter.setAttribute("aria-valuetext", `${model.countText}. 전체 완료는 결과 저장·검증 후 확인합니다.`);
      if (model.percent !== null) { p.meter.setAttribute("aria-valuemin", "0"); p.meter.setAttribute("aria-valuemax", String(model.totalPlaces)); p.meter.setAttribute("aria-valuenow", String(model.completedPlaces)); }
      else { p.meter.removeAttribute("aria-valuemin"); p.meter.removeAttribute("aria-valuemax"); p.meter.removeAttribute("aria-valuenow"); }
      for (const [index, step] of [...p.steps.children].entries()) { step.dataset.state = model.phase > index ? "done" : model.phase === index ? "active" : "pending"; if (model.phase === index) step.setAttribute("aria-current", "step"); else step.removeAttribute("aria-current"); }
      p.detail.textContent = model.detail; p.basis.hidden = !model.active; p.basis.textContent = `${model.basis} · 시간 범위는 참고값이며 응답 속도에 따라 달라집니다.`;
      const announcement = `${workerLabel(card.key)} ${model.keyword}. ${model.state === "running" ? ["목록 확인", "상세수집", "저장·검증"][model.phase] || "진행 중" : model.eta}. ${model.percent !== null ? model.countText : ""}`;
      if (p.announcement.textContent !== announcement) p.announcement.textContent = announcement;
      if (model.active || model.state === "queued" || model.state === "attention" || model.state === "complete") compactRows.push({card, model});
    }
    renderCompactProgress(compactRows);
  }
  const compactProgress = node("aside", "", "collector-compact-progress"), compactButtons = new Map(); compactProgress.id = "collectorCompactProgress"; compactProgress.hidden = true; compactProgress.setAttribute("aria-label", "백그라운드 수집 진행"); compactProgress.append(node("strong", "수집 진행", "collector-compact-title")); document.body.append(compactProgress);
  function renderCompactProgress(rows) {
    compactProgress.hidden = !admin() || visible() || !rows.length;
    if (compactProgress.hidden) return;
    const signature = rows.map(({card, model}) => `${card.key}|${model.state}|${model.keyword}|${model.eta}|${model.countText}|${model.animated}`).join(";");
    if (compactProgress.dataset.signature === signature) return;
    compactProgress.dataset.signature = signature;
    const shown = new Set(rows.map(({card}) => card.key));
    for (const [key, item] of compactButtons) item.row.hidden = !shown.has(key);
    for (const {card, model} of rows) {
      let item = compactButtons.get(card.key);
      if (!item) {
        const row = button("", "collector-compact-row", () => {
          const navigation = document.querySelector('[data-admin-primary="collect"]') || document.querySelector('[data-admin-mobile-section="collect"]');
          if (navigation) navigation.click();
          else window.dispatchEvent(new CustomEvent("collector:show-workspace"));
          card.root.open = true; card.root.scrollIntoView({block:"start",behavior:"smooth"});
        });
        const copy = node("span"), keyword = node("small"), eta = node("b"); copy.append(node("strong", workerLabel(card.key)), keyword); row.append(node("span", "", "collector-progress-dot"), copy, eta); compactProgress.append(row);
        item = {row, keyword, eta}; compactButtons.set(card.key, item);
      }
      // Reuse the focused button while status text changes on each poll.
      item.row.hidden = false; item.row.dataset.animated = String(model.animated); item.row.dataset.state = model.state;
      item.keyword.textContent = model.keyword; item.eta.textContent = model.eta;
    }
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
    scheduleConfig({ ...v, firstDate: todayKst(), time: "14:00", keywordIntervalMinutes: 0, dateMode: "fixed", ...dates, days: dates.bookingDays });
    if (v.allowRepeat && String(v.repeatReason).trim().length < 4) throw new Error("재수집 사유를 4글자 이상 입력하세요.");
    let accepted = 0;
    for (const keyword of keywords) {
      if (!workerAvailability(workerData, card.key).ready) throw new Error(workerAvailability(workerData, card.key).reason);
      const receipt = await new Promise((resolve, reject) => window.dispatchEvent(new CustomEvent("collector:submit-card", { detail: { input: { workerKey: card.key, keyword, searchMode: v.searchMode, checkIn: dates.checkIn, checkOut: dates.bookingDays === 1 ? addDays(dates.checkIn, 1) : dates.checkOut, bookingRangeDays: dates.bookingDays, collectionPurpose: v.purpose, detailRankRanges: v.ranks, dayUseMode: v.dayUseMode, allowRepeat: v.allowRepeat, repeatReason: v.repeatReason }, resolve, reject } })));
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
      const reason = qualityReason(entry.collectionQuality);
      if (reason) info.append(node("small", reason, "collector-worker-alert"));
      if (entry.errorCode) info.append(node("small", errorMessage(entry.brokerErrorCode || entry.errorCode), "collector-worker-alert"));
      if (entry.recovery) info.append(node("small", "보존 자료 복구 완료 · 업체 DB 반영"));
      row.append(info, node("span", entry.recovery && entry.status === "complete" ? "복구 완료" : STATUS_LABELS[entry.status] || "확인 필요", "state-badge"));
      if (entry.runId) row.append(resultButton(entry.runId));
      if (entry.runId || ["partial", "failed", "blocked", "interrupted"].includes(entry.status)) row.append(diagnosticCard(entry.runId || "", entry.collectionQuality || { status: entry.status }, `history:${entry.requestId || entry.keyword}`));
      container.append(row);
    }
    for (const card of cards.values()) {
      card.lastResult.replaceChildren(); const last = rows.find(row => row.workerKey === card.key && row.runId);
      if (last) { const label = node("small", `최근 결과 · ${last.keyword}`); label.title = last.keyword || ""; card.lastResult.append(label, resultButton(last.runId)); }
      else card.lastResult.append(node("small", requestsReadError ? "최근 결과를 확인하지 못했습니다." : "아직 표시할 수집 결과가 없습니다."));
    }
  }
  async function refresh() {
    if (!admin()) return; if (refreshInFlight) return refreshInFlight;
    refreshInFlight = (async () => {
      const results = await Promise.allSettled([api("/api/collector-status"), api("/api/crawl-requests"), ...WORKER_KEYS.map(key => api(scheduleUrl(key)))]);
      workerData = results[0].status === "fulfilled" ? results[0].value : null;
      if (workerData) { lastWorkerData = workerData; statusReceivedAt = Date.now(); } else statusReceivedAt = 0;
      lastRefreshAt = Date.now();
      requestsReadError = results[1].status !== "fulfilled"; if (!requestsReadError) requests = results[1].value.requests || [];
      for (let i = 0; i < WORKER_KEYS.length; i += 1) {
        const key = WORKER_KEYS[i], result = results[i + 2], card = cards.get(key);
        if (result.status === "fulfilled") {
          schedules[key] = result.value; const config = result.value.config;
          if (!card.loaded && !drafts[key] && config?.keywords?.length) fill(card, { keywords: config.keywords.join("\n"), searchMode: config.collection.searchMode || "keyword", period: config.collection.dateMode === "fixed" ? "custom" : String(config.collection.bookingDays), checkIn: config.collection.checkIn || todayKst(), checkOut: config.collection.checkOut || todayKst(), purpose: config.collection.collectionPurpose, ranks: config.collection.detailRankRanges, dayUseMode: config.collection.dayUseMode || "detail", firstDate: config.firstDate, time: config.time, repeat: config.repeat, keywordIntervalMinutes: config.keywordIntervalMinutes ?? 0, execution: config.enabled ? "schedule" : "now" });
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
    fill(card, { keywords: input.keyword || "", searchMode: input.searchMode === "company" ? "company" : "keyword", period: "custom", checkIn: input.checkIn, checkOut: input.bookingRangeDays === 1 ? input.checkIn : input.checkOut, purpose: input.collectionPurpose || "revenue_detail", ranks: input.detailRankRanges || "1-20", dayUseMode: input.dayUseMode || "inspect", execution: "now" });
    card.root.open = true; card.root.scrollIntoView({ block: "start", behavior: "smooth" }); saveDraft(card);
  });
  const observer = new MutationObserver(() => { renderProgress(); if (admin() && !loaded) refresh(); }); observer.observe(document.body, { attributes: true, attributeFilter: ["class"] });
  const section = panel.closest("[data-admin-section-panel]"); if (section) observer.observe(section, { attributes: true, attributeFilter: ["class"] });
  document.addEventListener("visibilitychange", () => { if (admin() && !document.hidden) refresh(); });
  window.addEventListener("pagehide", () => observer.disconnect(), { once: true });
  setInterval(() => {
    if (!admin() || document.hidden) { compactProgress.hidden = true; return; }
    renderProgress();
    const active = (workerData || lastWorkerData)?.workers?.some(worker => worker.activeJobId || worker.crawl?.active || workerQueueCount(worker));
    if (Date.now() - lastRefreshAt >= (active ? 5000 : visible() ? 15000 : 60000)) refresh();
  }, 1000);
  if (admin()) refresh();
})();
