"use strict";

// Development-only synthetic data. No production store or provider is read.
function createFixture() {
  const now = Date.parse("2026-11-14T11:30:00.000Z"), day = "2026-11-14";
  const keywords = ["가평글램핑", "포천글램핑", "경남글램핑", "대구글램핑", "부산글램핑", "경북글램핑"];
  const collection = { dateMode: "rolling", bookingDays: 21, bookingRangeDays: 21, adults: 2, searchMode: "keyword", detailRankRanges: "1-20", productMode: "all", collectionMode: "precision", collectionPurpose: "revenue_detail", dayUseMode: "inspect" };
  const items = keywords.map((keyword, index) => {
    const id = `preview_rotation_${day}_${index + 1}`, runId = `preview_run_${index + 1}`;
    return { id, day, keyword, workerKey: index % 2 ? "manual" : "web", scheduledAt: `${day}T${String(index * 2).padStart(2, "0")}:00:00.000Z`,
      startedAt: `${day}T${String(index * 2).padStart(2, "0")}:00:09.000Z`, finishedAt: `${day}T${String(index * 2).padStart(2, "0")}:03:12.000Z`,
      status: "complete", runId, planKind: "regular", conditions: collection, collectionQuality: { status: "complete" },
      postprocess: { state: "complete", runId, scheduleOccurrenceId: id, bindingVerified: true, finishedAt: `${day}T${String(index * 2).padStart(2, "0")}:03:28.000Z` } };
  });
  items[1].postprocess = { ...items[1].postprocess, state: "queued", finishedAt: null };
  items[2] = { ...items[2], status: "partial", collectionQuality: { status: "partial", reason: "booking_schedule_responses_incomplete" }, postprocess: null,
    continuation: { policyVersion: "rotation-partial-v2", decision: "continue", reasonCode: "ROTATION_PARTIAL_CONTINUED", responseReason: "booking_schedule_responses_incomplete", failedSchedules: 1, requestedSchedules: 4935, affectedCompanies: 1, missingBookingResults: 0, failedOtaRequests: 0, consecutivePartialRuns: 0 } };
  items[3] = { ...items[3], status: "blocked", errorCode: "ROTATION_PROVIDER_BLOCKED", collectionQuality: { status: "blocked", blockedReason: "naver_captcha" }, postprocess: null };
  items[4] = { ...items[4], status: "planned", projected: true, planKind: "projected", startedAt: null, finishedAt: null, runId: null, collectionQuality: null, postprocess: null };
  items[5] = { ...items[5], status: "uncertain", errorCode: "ROTATION_UNRESOLVED_EXECUTION", collectionQuality: null, postprocess: null };
  const config = { version: 1, enabled: false, timezone: "Asia/Seoul", repeat: "daily", firstDate: "2026-10-31", time: "09:00", keywordIntervalMinutes: 120,
    workers: [{ workerKey: "web", dailyLimit: 3 }, { workerKey: "manual", dailyLimit: 3 }], keywords, collection, requestPacing: null };
  const workers = ["web", "manual", "scheduled"].map(workerKey => ({ workerKey, configured: true, connected: true, workerLastSeenAt: new Date(now).toISOString(), ready: true,
    halted: workerKey === "manual", retired: workerKey === "scheduled", errorCode: workerKey === "manual" ? "COLLECTOR_PROVIDER_BLOCKED" : "", crawl: { active: false, queueLength: 0 } }));
  const monitor = { available: true, enabled: false, reason: "ROTATION_PROVIDER_BLOCKED", planState: "paused", generatedAt: new Date(now).toISOString(),
    from: "2026-11-09", to: "2026-11-15", today: day, keywords, items,
    currentPlan: { source: "saved_config", dailySlots: 6 },
    coverage: { days: Array.from({ length: 7 }, (_, index) => ({ day: `2026-11-${String(index + 9).padStart(2, "0")}`, status: index === 5 ? "saved" : "missing", count: index === 5 ? 5 : null, dailySlots: index === 5 ? 6 : null })) } };
  const rotation = { config, enabled: false, revision: 3, planState: "paused", reason: "ROTATION_PROVIDER_BLOCKED", cursor: 0, nextKeyword: keywords[0], nextRunAt: null,
    todayItems: items.filter(item => !item.projected), upcomingItems: [items[4]], currentPolicyVersion: "rotation-partial-v2", workers };
  const history = items.filter(item => !item.projected).map((item, index) => ({ ...item, requestId: `preview_request_${index + 1}`, source: "rotation", trigger: "scheduled", date: day,
    dateBasis: "execution", stamp: item.startedAt, createdAt: item.startedAt, state: item.status === "complete" ? "complete" : item.status === "partial" ? "partial" : item.status === "uncertain" ? "review" : "failed" }));
  return { now, day, config, monitor, rotation, workers, history };
}

function browserBootstrap(fixture) {
  "use strict";
  const RealDate = window.Date;
  window.Date = class PreviewDate extends RealDate {
    constructor(...args) { super(...(args.length ? args : [fixture.now])); }
    static now() { return fixture.now; }
  };
  window.COLLECTION_WORKSPACE_FIXTURE = { calls: [], blocked: [], fixture };
  const status = message => { const node = document.getElementById("workspacePreviewStatus"); if (node) node.textContent = message; };
  const reject = (method, url) => {
    window.COLLECTION_WORKSPACE_FIXTURE.blocked.push({ method, url: String(url) });
    status("개발 검증용: 실행·저장·외부 호출은 차단됩니다.");
    throw new Error("PREVIEW_WRITE_OR_EXTERNAL_REQUEST_BLOCKED");
  };
  const historyResult = params => {
    const from = params.get("from") || "2026-01-01", to = params.get("to") || "2026-12-31", groupBy = params.get("groupBy") || "month";
    const filtered = fixture.history.filter(row => row.date >= from && row.date <= to && (!params.get("keyword") || row.keyword.includes(params.get("keyword")))
      && (!params.get("worker") || params.get("worker") === "all" || row.workerKey === params.get("worker"))
      && (!params.get("state") || params.get("state") === "all" || row.state === params.get("state") || params.get("state") === "attention" && ["partial", "failed", "review"].includes(row.state))).slice().reverse();
    const counts = { pending: 0, complete: 0, failed: 0, partial: 0, review: 0 };
    for (const row of filtered) counts[row.state]++;
    const key = groupBy === "year" ? "2026" : groupBy === "day" ? fixture.day : groupBy === "week" ? "2026-11-09" : "2026-11";
    const result = { from, to, groupBy, timezone: "Asia/Seoul", updatedAt: new Date(fixture.now).toISOString(), sources: {}, warnings: [],
      summary: { total: filtered.length, counts, latest: filtered[0] || null, latestTerminal: filtered[0] || null, unknownDateCount: 0 },
      groups: filtered.length ? [{ key, label: "2026년 11월 · 모의자료", startDate: from, endDate: to, count: filtered.length, counts, latest: filtered[0] }] : [] };
    if (params.has("groupKey")) Object.assign(result, { groupKey: params.get("groupKey"), rows: filtered, totalRows: filtered.length, offset: 0, limit: 50, hasMore: false, nextOffset: null });
    return result;
  };
  window.fetch = async (input, options = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url, window.location.href), method = String(options.method || "GET").toUpperCase();
    if (url.origin !== window.location.origin || method !== "GET") return reject(method, url.href);
    window.COLLECTION_WORKSPACE_FIXTURE.calls.push({ method, pathname: url.pathname, search: url.search });
    let result;
    if (url.pathname === "/api/collection-monitor") result = fixture.monitor;
    else if (url.pathname === "/api/collector-status") result = { workers: fixture.workers, generatedAt: new Date(fixture.now).toISOString() };
    else if (url.pathname === "/api/crawl-requests") result = { requests: fixture.history };
    else if (url.pathname === "/api/worker-schedule") result = { config: { ...fixture.config, keywords: ["경남글램핑", "대구글램핑"] }, enabled: false, workerKey: url.searchParams.get("workerKey"), todayItems: [], upcomingItems: [] };
    else if (url.pathname === "/api/collection-rotation") result = fixture.rotation;
    else if (url.pathname === "/api/collection-history") result = historyResult(url.searchParams);
    else return reject(method, url.href);
    return { ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(result)) };
  };
  document.addEventListener("submit", event => { event.preventDefault(); event.stopImmediatePropagation(); status("개발 검증용: 수집·예약·설정 저장은 실행하지 않습니다."); }, true);
  document.addEventListener("click", event => {
    const button = event.target.closest("button"); if (!button) return;
    const label = button.textContent.trim();
    const blocked = /수집 실행|예약 등록|조건 저장|순환예약 시작|순환예약 일시정지|6회로 전환|시험.*등록|시험.*취소|결과 보기|저장 후/.test(label);
    if (blocked || button.hasAttribute("data-open-collection-archive")) {
      event.preventDefault(); event.stopImmediatePropagation();
      status(button.hasAttribute("data-open-collection-archive") ? "개발 검증용: 보관함 이동은 운영 화면에서 연결됩니다." : "개발 검증용: 실행·저장 작업은 차단됩니다.");
    }
  }, true);
  window.addEventListener("collector:submit-card", event => { event.detail?.reject?.(new Error("PREVIEW_COLLECTION_BLOCKED")); status("개발 검증용: 수집을 실행하지 않습니다."); });
}

module.exports = { createFixture, browserBootstrap };
