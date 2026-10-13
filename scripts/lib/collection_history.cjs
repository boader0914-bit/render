"use strict";

// Read stored receipts directly. Scheduler/requests initialize() methods can
// recover pending jobs by writing their state and must not be called here.
const fs = require("node:fs/promises");
const path = require("node:path");
const { sanitizeCollectionQuality } = require("./collection_diagnostics.cjs");
const DAY_MS = 86400000;
const KST_MS = 9 * 60 * 60 * 1000;
const STATES = ["pending", "complete", "failed", "partial", "review"];
const GROUPS = new Set(["year", "month", "week", "day"]);
const WORKERS = new Set(["all", "web", "manual", "scheduled"]);
const FILTER_STATES = new Set(["all", ...STATES, "attention"]);
const DATE_BASIS = { execution: "실행일", received: "접수일", scheduled: "예정일", saved: "저장일", unknown: "시각 미확인" };
const SOURCE_LABELS = { requests: "즉시수집 기록", scheduled: "예약워커 기록", web: "운영웹 예약 기록", manual: "BG 예약 기록", daily: "기존 일일수집 기록", outputs: "보관함 결과 기록" };
const WARNING_LABELS = {
  source_missing: "일부 기록 저장소가 없어 해당 출처를 확인하지 못했습니다.",
  source_unreadable: "일부 기록 저장소를 읽지 못했습니다.",
  record_unreadable: "일부 저장 기록을 읽지 못했습니다.",
  record_invalid: "일부 저장 기록의 형식을 확인해야 합니다.",
  unsafe_path: "외부 경로 또는 연결 파일은 조회에서 제외했습니다.",
  record_too_large: "크기가 큰 일부 기록은 조회에서 제외했습니다.",
  time_unknown: "수집·접수·예정·저장 시각이 없는 기록은 기간 합계에서 제외했습니다.",
  quality_unknown: "일부 보관함 결과에는 수집 완료를 판단할 상태 기록이 없습니다.",
  worker_unknown: "일부 보관함 결과의 수집기를 확인할 수 없습니다.",
  scan_limit: "기록 수가 많아 일부 출처를 모두 읽지 못했습니다. 조회 범위를 확인해 주세요."
};
function fault(message) { return Object.assign(new Error(message), { code: "COLLECTION_HISTORY_QUERY_INVALID", statusCode: 400 }); }
function object(value) { return value && typeof value === "object" && !Array.isArray(value); }
function text(value, max = 160) { return typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max) : ""; }
function identifier(value) { return /^[A-Za-z0-9_-]{1,240}$/.test(String(value || "")) ? String(value) : null; }
function code(value) { return /^[A-Za-z][A-Za-z0-9_]{1,100}$/.test(String(value || "")) ? String(value) : null; }
function calendarDate(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}
function validDate(value) { return calendarDate(value) && value >= "2000-01-01" && value <= "2099-12-31"; }
function iso(value) {
  // A timezone is required; otherwise old local times must not silently become UTC.
  if (typeof value !== "string" || !validDate(value.slice(0, 10)) || !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
  const instant = Date.parse(value); return Number.isFinite(instant) ? new Date(instant).toISOString() : null;
}
function dateKey(instant) { return new Date(Date.parse(instant) + KST_MS).toISOString().slice(0, 10); }
function addDays(day, days) { return new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10); }
function monday(day) { return addDays(day, -((new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7)); }
function emptyCounts() { return Object.fromEntries(STATES.map(key => [key, 0])); }
function normalizeQuery(input, now) {
  const params = input instanceof URLSearchParams ? input : new URLSearchParams(Object.entries(input || {}).filter(([, value]) => value !== undefined && value !== null));
  const allowed = new Set(["from", "to", "groupBy", "worker", "keyword", "state", "groupKey", "offset", "limit"]);
  for (const key of params.keys()) if (!allowed.has(key) || params.getAll(key).length !== 1) throw fault("조회 조건을 확인해 주세요.");
  const today = dateKey(new Date(now).toISOString());
  const requestedFrom = params.get("from") || `${today.slice(0, 4)}-01-01`, requestedTo = params.get("to") || today;
  if (!validDate(requestedFrom) || !validDate(requestedTo) || requestedFrom > requestedTo
    || (Date.parse(requestedTo) - Date.parse(requestedFrom)) / DAY_MS > 3660) throw fault("조회 기간은 올바른 날짜로 최대 10년까지 선택해 주세요.");
  const groupBy = params.get("groupBy") || "month", worker = params.get("worker") || "all", state = params.get("state") || "all";
  if (!GROUPS.has(groupBy) || !WORKERS.has(worker) || !FILTER_STATES.has(state)) throw fault("기간 단위·수집기·결과 조건을 확인해 주세요.");
  const rawKeyword = params.get("keyword") || "";
  if (rawKeyword.length > 160 || /[\u0000-\u001f\u007f]/.test(rawKeyword)) throw fault("검색어는 160자 이내로 입력해 주세요.");
  const keyword = rawKeyword.normalize("NFKC").trim();
  const from = groupBy === "week" ? monday(requestedFrom) : requestedFrom;
  const to = groupBy === "week" ? addDays(monday(requestedTo), 6) : requestedTo;
  const groupKey = params.get("groupKey") || null;
  if (groupKey && !(groupBy === "year" ? /^\d{4}$/.test(groupKey) && validDate(`${groupKey}-01-01`)
    : groupBy === "month" ? /^\d{4}-\d{2}$/.test(groupKey) && validDate(`${groupKey}-01`)
      : (groupBy === "week" ? calendarDate(groupKey) && groupKey >= "1999-12-27" && groupKey <= "2099-12-31" && monday(groupKey) === groupKey : validDate(groupKey)))) throw fault("기록 묶음을 확인해 주세요.");
  function number(name, fallback, max) {
    const value = params.get(name); if (value === null || value === "") return fallback;
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > max || (name === "limit" && Number(value) < 1)) throw fault("기록 조회 개수를 확인해 주세요.");
    return Number(value);
  }
  return { requestedFrom, requestedTo, from, to, groupBy, worker, keyword, state, groupKey, offset: number("offset", 0, 10000000), limit: number("limit", 50, 50) };
}
function safeConditions(input) {
  if (!object(input)) return {};
  const output = {};
  for (const key of ["checkIn", "checkOut"]) if (validDate(input[key])) output[key] = input[key];
  for (const key of ["bookingRangeDays", "bookingDays"]) if (Number.isSafeInteger(input[key]) && input[key] >= 1 && input[key] <= 366) output.bookingRangeDays = input[key];
  if (typeof input.detailRankRanges === "string" && /^\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*$/.test(input.detailRankRanges) && input.detailRankRanges.length <= 150) output.detailRankRanges = input.detailRankRanges;
  const choices = { collectionMode: ["fast", "precision"], collectionPurpose: ["basic_db", "revenue_detail"], dayUseMode: ["inspect", "lodging_only", "detail"], productMode: ["all", "lodging", "campnic"], searchMode: ["keyword", "company"] };
  for (const [key, values] of Object.entries(choices)) if (values.includes(input[key])) output[key] = input[key];
  return output;
}
function safeRecovery(value) {
  if (!object(value)) return null;
  const output = {};
  if (identifier(value.jobId)) output.jobId = identifier(value.jobId);
  if (iso(value.recoveredAt)) output.recoveredAt = iso(value.recoveredAt);
  if (iso(value.originalFinishedAt)) output.originalFinishedAt = iso(value.originalFinishedAt);
  if (["failed", "blocked", "partial", "interrupted"].includes(value.originalStatus)) output.originalStatus = value.originalStatus;
  if (code(value.originalErrorCode)) output.originalErrorCode = code(value.originalErrorCode);
  return Object.keys(output).length ? output : null;
}
function stateFor(status, quality, errorCode) {
  if (["COLLECTION_REVIEW_REQUIRED", "COLLECTION_SCOPE_REVIEW"].includes(errorCode)) return "review";
  if (["failed", "blocked", "interrupted", "missed", "cancelled", "canceled"].includes(status)) return "failed";
  if (["failed", "blocked", "interrupted"].includes(quality?.status)) return "failed";
  if (status === "partial" || quality?.status === "partial") return "partial";
  if (["pending", "queued", "running"].includes(status)) return "pending";
  if (["complete", "completed", "reused"].includes(status) || ["complete", "reused"].includes(quality?.status)) return "complete";
  return "review";
}
function compactStoredValue(input) {
  // The shared filesystem cache only needs receipt metadata, not product
  // observations, credentials or arbitrary historical config payloads.
  if (!object(input)) return input;
  const output = {};
  for (const key of ["version", "id", "requestId", "day", "workerKey", "trigger", "keyword", "status", "createdAt", "startedAt", "executionStartedAt", "scheduledAt", "finishedAt", "endedAt", "collectedAt", "completedAt", "collectedAtSource", "runId", "errorCode", "brokerErrorCode", "failurePhase", "reused"])
    if (typeof input[key] === "string") output[key] = input[key].slice(0, 500);
    else if (["number", "boolean"].includes(typeof input[key])) output[key] = input[key];
  output.collectionQuality = sanitizeCollectionQuality(input.collectionQuality || input.quality);
  output.conditions = safeConditions(input.conditions || input);
  if (object(input.result)) output.result = compactStoredValue(input.result);
  if (object(input.recovery)) output.recovery = safeRecovery(input.recovery);
  if (object(input.config)) output.config = { collection: { ...safeConditions(input.config.collection), ...(["rolling", "fixed"].includes(input.config.collection?.dateMode) ? { dateMode: input.config.collection.dateMode } : {}) } };
  if (Number.isFinite(input.durationMs) && input.durationMs >= 0 && input.durationMs <= 1e12) output.durationMs = input.durationMs;
  if (Array.isArray(input.items)) output.items = input.items.map(compactStoredValue);
  if (object(input.days)) output.days = Object.fromEntries(Object.entries(input.days).map(([day, entry]) => [day, compactStoredValue(entry)]));
  return output;
}
function normalizedRow(value, context) {
  const result = object(value.result) ? value.result : {};
  const collectionQuality = sanitizeCollectionQuality(value.collectionQuality || value.quality || result.collectionQuality);
  let status = ["pending", "queued", "running", "complete", "completed", "reused", "partial", "failed", "blocked", "interrupted", "missed", "cancelled", "canceled"].includes(value.status) ? value.status : collectionQuality?.status || "unknown";
  const recordedStatus = status;
  const errorCode = code(value.errorCode);
  const runId = identifier(value.runId || result.runId), requestId = identifier(value.requestId || context.requestId);
  let state = stateFor(status, collectionQuality, errorCode);
  if (state === "complete" && !runId) { state = "review"; status = "unknown"; }
  const startedAt = iso(value.executionStartedAt) || iso(value.startedAt);
  const receivedAt = iso(value.createdAt) || iso(context.createdAt);
  const scheduledAt = iso(value.scheduledAt) || iso(context.scheduledAt);
  const savedAt = (value.collectedAtSource === "filesystem" ? null : iso(value.collectedAt))
    || (context.source === "outputs" ? iso(value.completedAt) || iso(value.finishedAt) : null);
  const finishedAt = iso(value.finishedAt) || iso(value.endedAt) || savedAt;
  let stamp = startedAt, dateBasis = "execution";
  if (!stamp && ["queued", "missed", "cancelled", "canceled", "pending"].includes(status) && scheduledAt) { stamp = scheduledAt; dateBasis = "scheduled"; }
  if (!stamp && receivedAt) { stamp = receivedAt; dateBasis = "received"; }
  if (!stamp && scheduledAt) { stamp = scheduledAt; dateBasis = "scheduled"; }
  if (!stamp && savedAt) { stamp = savedAt; dateBasis = "saved"; }
  if (!stamp) dateBasis = "unknown";
  const worker = value.workerKey || result.workerKey || context.workerKey;
  const row = { id: context.id, requestId, source: context.source, keyword: text(value.keyword), workerKey: WORKERS.has(worker) && worker !== "all" ? worker : "unknown",
    trigger: ["manual", "scheduled"].includes(value.trigger || context.trigger) ? value.trigger || context.trigger : "unknown", status, state, ...(status !== recordedStatus ? { recordedStatus } : {}), collectionQuality, runId,
    stamp: stamp || null, date: stamp ? dateKey(stamp) : null, dateBasis, dateBasisLabel: DATE_BASIS[dateBasis], startedAt, receivedAt, scheduledAt, finishedAt,
    conditions: { ...safeConditions(context.conditions), ...safeConditions(value.conditions || value) }, errorCode, brokerErrorCode: code(value.brokerErrorCode),
    failurePhase: ["main_search", "booking_detail", "booking_schedule", "ota_observation", "file_upload", "final_validation"].includes(value.failurePhase) ? value.failurePhase : null,
    recovery: safeRecovery(value.recovery), reused: status === "reused" || result.reused === true };
  if (Number.isFinite(value.durationMs) && value.durationMs >= 0 && value.durationMs <= 1e12) row.durationMs = value.durationMs;
  return row;
}
function groupFor(day, by, query) {
  let key, startDate, endDate, label;
  if (by === "year") { key = day.slice(0, 4); startDate = `${key}-01-01`; endDate = `${key}-12-31`; label = `${key}년`; }
  else if (by === "month") { key = day.slice(0, 7); startDate = `${key}-01`; endDate = addDays(new Date(Date.UTC(Number(key.slice(0, 4)), Number(key.slice(5)), 1)).toISOString().slice(0, 10), -1); label = `${key.slice(0, 4)}년 ${Number(key.slice(5))}월`; }
  else if (by === "week") { key = startDate = monday(day); endDate = addDays(startDate, 6); label = `${startDate.replaceAll("-", ".")} ~ ${endDate.replaceAll("-", ".")}`; }
  else { key = startDate = endDate = day; label = `${day.slice(0, 4)}년 ${Number(day.slice(5, 7))}월 ${Number(day.slice(8))}일`; }
  return { key, label, startDate: startDate < query.from ? query.from : startDate, endDate: endDate > query.to ? query.to : endDate };
}
function createCollectionHistory({ dataDir, outputsDir = path.join(dataDir, "outputs"), now = () => new Date(), cacheTtlMs = 5000, maxRecords = 100000 } = {}) {
  if (typeof dataDir !== "string") throw new Error("collection_history_data_dir_required");
  dataDir = path.resolve(dataDir); outputsDir = path.resolve(outputsDir);
  let cached, loading, lastLoaded = 0;
  const fileCache = new Map();
  async function load() {
    const warnings = new Map(), sources = {}, rows = [], referenced = new Set(), seenFiles = new Set();
    const warn = (warningCode, count = 1) => warnings.set(warningCode, (warnings.get(warningCode) || 0) + count);
    function inside(file, root) { const relative = path.relative(root, file); return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative)); }
    async function safeStat(file, root) {
      if (!inside(file, root)) throw Object.assign(new Error("unsafe"), { code: "UNSAFE_PATH" });
      // Reject links at every component as well as a linked root. Never trust
      // a receipt's outputDir or file path as a source location.
      let current = root;
      const parts = path.relative(root, file).split(path.sep).filter(Boolean);
      for (const part of [null, ...parts]) {
        if (part !== null) current = path.join(current, part);
        const stat = await fs.lstat(current);
        if (stat.isSymbolicLink()) throw Object.assign(new Error("unsafe"), { code: "UNSAFE_PATH" });
      }
      const real = await fs.realpath(file);
      if (!inside(real, await fs.realpath(root))) throw Object.assign(new Error("unsafe"), { code: "UNSAFE_PATH" });
      return fs.stat(file);
    }
    async function read(file, root) {
      seenFiles.add(file);
      try {
        const stat = await safeStat(file, root);
        if (!stat.isFile()) { warn("record_invalid"); return null; }
        if (stat.size > 32 * 1024 * 1024) { warn("record_too_large"); return null; }
        const signature = `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
        const previous = fileCache.get(file);
        if (previous?.signature === signature) return previous.value;
        const parsed = JSON.parse((await fs.readFile(file, "utf8")).replace(/^\uFEFF/, ""));
        const value = compactStoredValue(parsed);
        if (!object(value)) { warn("record_invalid"); return null; }
        fileCache.set(file, { signature, value }); return value;
      } catch (error) { warn(error.code === "UNSAFE_PATH" ? "unsafe_path" : error instanceof SyntaxError ? "record_invalid" : "record_unreadable"); return null; }
    }
    async function entries(dir, root, source) {
      const state = sources[source] = { label: SOURCE_LABELS[source], status: "available", files: 0, rows: 0 };
      try {
        const stat = await safeStat(dir, root);
        if (!stat.isDirectory()) throw Object.assign(new Error("invalid"), { code: "UNSAFE_PATH" });
        return await fs.readdir(dir, { withFileTypes: true });
      } catch (error) { state.status = error.code === "ENOENT" ? "absent" : "unreadable"; warn(error.code === "ENOENT" ? "source_missing" : error.code === "UNSAFE_PATH" ? "unsafe_path" : "source_unreadable"); return []; }
    }
    function add(row, source) {
      if (rows.length >= maxRecords) { warn("scan_limit"); return; }
      if (row.recordedStatus) warn("record_invalid");
      rows.push(row); sources[source].rows += 1;
      if (row.runId && !row.reused) referenced.add(row.runId);
    }
    const namespaces = [["requests", "collector-requests", null], ["scheduled", "keyword-worker-schedule", "scheduled"], ["web", "keyword-worker-schedule-web", "web"], ["manual", "keyword-worker-schedule-manual", "manual"]];
    // A bounded pool allows independent small receipt reads without creating
    // thousands of simultaneous filesystem operations.
    async function pool(values, run) {
      let next = 0;
      await Promise.all(Array.from({ length: Math.min(8, values.length) }, async () => { while (next < values.length) { const item = values[next++]; await run(item); } }));
    }
    for (const [source, namespace, workerKey] of namespaces) {
      const dir = path.join(dataDir, "history", namespace), listed = await entries(dir, dataDir, source);
      const files = listed.filter(entry => entry.name.endsWith(".json"));
      if (files.length > maxRecords) warn("scan_limit", files.length - maxRecords);
      await pool(files.slice(0, maxRecords), async entry => {
        sources[source].files += 1;
        if (!entry.isFile() || entry.isSymbolicLink() || !identifier(entry.name.slice(0, -5))) { warn("unsafe_path"); return; }
        const value = await read(path.join(dir, entry.name), dataDir); if (!value) return;
        if (source === "requests") {
          if (!identifier(value.requestId) || value.requestId !== entry.name.slice(0, -5) || !text(value.keyword)) { warn("record_invalid"); return; }
          add(normalizedRow(value, { id: `request_${value.requestId}`, source }), source);
        } else {
          if (!identifier(value.id) || value.id !== entry.name.slice(0, -5) || !Array.isArray(value.items)) { warn("record_invalid"); return; }
          value.items.forEach((item, index) => {
            if (!object(item) || !text(item.keyword)) { warn("record_invalid"); return; }
            const conditions = { ...value.config?.collection };
            if (conditions.dateMode === "rolling" && validDate(value.day) && conditions.bookingRangeDays) {
              conditions.checkIn = value.day;
              conditions.checkOut = addDays(value.day, conditions.bookingRangeDays === 1 ? 1 : conditions.bookingRangeDays - 1);
            }
            add(normalizedRow(item, { id: `${source}_${value.id}_${index + 1}`, requestId: `${workerKey === "scheduled" ? "" : `${workerKey}_`}${value.id}_${index + 1}`,
              source, workerKey, trigger: value.trigger, createdAt: value.createdAt, scheduledAt: value.scheduledAt, conditions }), source);
          });
        }
      });
    }
    sources.daily = { label: SOURCE_LABELS.daily, status: "available", files: 0, rows: 0 };
    const dailyPath = path.join(dataDir, "history", "daily_keyword_collection_state.json");
    try {
      await safeStat(dailyPath, dataDir); sources.daily.files = 1;
      const daily = await read(dailyPath, dataDir);
      if (daily && object(daily.days)) for (const [day, value] of Object.entries(daily.days)) {
        if (!validDate(day) || !object(value) || !Array.isArray(value.items)) { warn("record_invalid"); continue; }
        value.items.forEach((item, index) => {
          if (!object(item) || !text(item.keyword)) { warn("record_invalid"); return; }
          add(normalizedRow(item, { id: `daily_${day}_${index + 1}`, requestId: `daily_${day}_${index + 1}`, source: "daily", workerKey: value.workerKey || "unknown", trigger: "scheduled",
            createdAt: value.createdAt, scheduledAt: value.scheduledAt }), "daily");
        });
      } else if (daily) warn("record_invalid");
    } catch (error) { sources.daily.status = error.code === "ENOENT" ? "absent" : "unreadable"; warn(error.code === "ENOENT" ? "source_missing" : error.code === "UNSAFE_PATH" ? "unsafe_path" : "source_unreadable"); }
    const receiptsByRun = new Map();
    for (const row of rows) if (row.runId && !row.reused) {
      if (!receiptsByRun.has(row.runId)) receiptsByRun.set(row.runId, []);
      receiptsByRun.get(row.runId).push(row);
    }
    const outputEntries = await entries(outputsDir, outputsDir, "outputs");
    await pool(outputEntries.slice(0, maxRecords), async entry => {
      if (!entry.isDirectory() || !identifier(entry.name)) { if (entry.isSymbolicLink()) warn("unsafe_path"); return; }
      sources.outputs.files += 1;
      const value = await read(path.join(outputsDir, entry.name, "manifest.json"), outputsDir); if (!value) return;
      if (!text(value.keyword)) { warn("record_invalid"); return; }
      if (referenced.has(entry.name)) {
        const executionStartedAt = iso(value.startedAt);
        const resultSavedAt = (value.collectedAtSource === "filesystem" ? null : iso(value.collectedAt)) || iso(value.completedAt) || iso(value.finishedAt);
        for (const receipt of receiptsByRun.get(entry.name) || []) {
          // A reused run has its own original date. Only fill an actual start
          // for the original non-reuse attempt when the execution fits its
          // recorded request/completion window.
          if (executionStartedAt && !receipt.startedAt && (!receipt.receivedAt || executionStartedAt >= receipt.receivedAt)
            && (!receipt.finishedAt || executionStartedAt <= receipt.finishedAt)) {
            Object.assign(receipt, { startedAt: executionStartedAt, stamp: executionStartedAt, date: dateKey(executionStartedAt), dateBasis: "execution", dateBasisLabel: DATE_BASIS.execution });
          }
          // Older receipts can lack all timing metadata. Keep the known result
          // storage date when suppressing its duplicate manifest fallback;
          // this is explicitly a saved date, never inferred execution time.
          if (!receipt.stamp && resultSavedAt) Object.assign(receipt, { stamp: resultSavedAt, date: dateKey(resultSavedAt), dateBasis: "saved", dateBasisLabel: DATE_BASIS.saved });
          receipt.conditions = { ...safeConditions(value.conditions), ...receipt.conditions };
        }
        return;
      }
      const quality = sanitizeCollectionQuality(value.collectionQuality);
      // File presence is not a successful collection. A legacy result without
      // quality metadata remains a review item even if HTTP/process was OK.
      const row = normalizedRow({ ...value, runId: entry.name, status: quality?.status || "unknown", collectionQuality: quality }, { id: `result_${entry.name}`, source: "outputs" });
      if (!quality || quality.status === "unknown") warn("quality_unknown");
      if (row.workerKey === "unknown") warn("worker_unknown");
      add(row, "outputs");
    });
    if (outputEntries.length > maxRecords) warn("scan_limit", outputEntries.length - maxRecords);
    const unknownDateCount = rows.filter(row => !row.date).length;
    if (unknownDateCount) warn("time_unknown", unknownDateCount);
    // Drop cache entries for removed files, keeping only data under the two
    // explicitly configured roots. Cached objects are never sent as raw JSON.
    for (const file of fileCache.keys()) if (!seenFiles.has(file)) fileCache.delete(file);
    rows.sort((a, b) => String(b.stamp || "").localeCompare(String(a.stamp || "")) || a.id.localeCompare(b.id));
    return { rows, warnings: [...warnings].map(([warningCode, count]) => ({ code: warningCode, label: WARNING_LABELS[warningCode], count })), sources, updatedAt: new Date(now()).toISOString() };
  }
  async function snapshot() {
    if (cached && Date.parse(new Date(now()).toISOString()) - lastLoaded < cacheTtlMs) return cached;
    if (loading) return loading;
    loading = load().then(result => { cached = result; lastLoaded = Date.parse(new Date(now()).toISOString()); return result; }).finally(() => { loading = null; });
    return loading;
  }
  async function query(input = {}) {
    const q = normalizeQuery(input, now()), snapshotValue = await snapshot();
    const matches = row => (q.worker === "all" || q.worker === row.workerKey) && (!q.keyword || row.keyword.normalize("NFKC").toLocaleLowerCase().includes(q.keyword.toLocaleLowerCase()))
      && (q.state === "all" || q.state === row.state || q.state === "attention" && ["failed", "partial", "review"].includes(row.state));
    const matched = snapshotValue.rows.filter(matches), unknownDateCount = matched.filter(row => !row.date).length;
    const rows = matched.filter(row => row.date && row.date >= q.from && row.date <= q.to);
    const counts = emptyCounts(), groups = new Map();
    for (const row of rows) {
      counts[row.state] += 1;
      const grouping = groupFor(row.date, q.groupBy, q);
      if (!groups.has(grouping.key)) groups.set(grouping.key, { ...grouping, count: 0, counts: emptyCounts(), latest: row, latestTerminal: null });
      const group = groups.get(grouping.key); group.count += 1; group.counts[row.state] += 1;
      if (!group.latestTerminal && row.state !== "pending") group.latestTerminal = row;
    }
    const result = { from: q.from, to: q.to, requestedFrom: q.requestedFrom, requestedTo: q.requestedTo, groupBy: q.groupBy, timezone: "Asia/Seoul",
      summary: { total: rows.length, counts, latest: rows[0] || null, latestTerminal: rows.find(row => row.state !== "pending") || null, unknownDateCount }, groups: [...groups.values()].sort((a, b) => b.key.localeCompare(a.key)),
      warnings: snapshotValue.warnings, sources: snapshotValue.sources, updatedAt: snapshotValue.updatedAt };
    if (q.groupKey) {
      const selected = rows.filter(row => groupFor(row.date, q.groupBy, q).key === q.groupKey);
      Object.assign(result, { groupKey: q.groupKey, rows: selected.slice(q.offset, q.offset + q.limit), totalRows: selected.length, offset: q.offset, limit: q.limit,
        hasMore: q.offset + q.limit < selected.length, nextOffset: q.offset + q.limit < selected.length ? q.offset + q.limit : null });
    }
    return result;
  }
  return { query };
}
module.exports = { createCollectionHistory, normalizeQuery, normalizedRow, stateFor };
