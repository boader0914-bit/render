"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { DEFINITIONS: KOSIS_DEFINITIONS } = require("./kosis.cjs");

const TOURISM = Object.freeze([
  { key: "visitors", label: "지역 방문자", method: "collectVisitorHistory", fields: ["averageDailyVisitors", "visitorDays"] },
  { key: "demandStrength", label: "체류·소비 지수", method: "collectDemandStrengthHistory", fields: ["stayOverall", "spendOverall"] },
  { key: "resourceDemand", label: "관광자원 수요 지수", method: "collectResourceDemandHistory", fields: ["service", "culture"] },
  { key: "diversity", label: "관광 다양성 지수", method: "collectDiversityHistory", fields: ["visitor", "spend", "international"] }
]);
const STEP_DEFINITIONS = [...TOURISM, { key: "kosis", label: "인구·산업 통계" }, { key: "searchTrend", label: "검색 트렌드" }];
const ACTIVE = new Set(["queued", "running"]);
const SAFE_CODES = new Set(["INVALID_REQUEST", "INVALID_REGION", "INVALID_MONTH", "INVALID_CUTOFF_DATE", "PREPARATION_STORAGE_ERROR", "PREPARATION_INTERRUPTED",
  "PROVIDER_UNAVAILABLE", "PROVIDER_FAILED", "CACHE_ONLY_VIOLATION", "REGION_MISMATCH", "PERIOD_MISMATCH", "INVALID_RESPONSE", "MISSING_KEY", "AUTH_ERROR",
  "QUOTA_EXCEEDED", "TIMEOUT", "NETWORK_ERROR", "CACHE_READ_ERROR", "CACHE_WRITE_ERROR", "COOLDOWN", "REFRESH_INCOMPLETE", "NO_DATA", "MISSING_VALUES",
  "MAPPING_MISSING", "AMBIGUOUS_REGION", "PARTIAL_DATA", "PUBLICATION_PENDING", "REGIONAL_SOURCE_BUSY", "CONFIG_READ_ERROR", "KEYWORD_MISMATCH", "RESPONSE_TOO_LARGE"]);
const clone = (value) => value == null ? value : JSON.parse(JSON.stringify(value));
function problem(code, statusCode = 503) {
  return Object.assign(new Error(code === "PREPARATION_STORAGE_ERROR" ? "지역 자료 준비 기록을 저장하거나 읽지 못했습니다." : "지역 자료 준비 상태를 확인해 주세요."), { code, statusCode });
}
function safeCode(error, fallback = "PROVIDER_FAILED") {
  const aliases = { tourism_visitor_history_busy: "REGIONAL_SOURCE_BUSY", tourism_demand_strength_daily_quota_exceeded: "QUOTA_EXCEEDED", tourism_demand_strength_scheduler_active: "REGIONAL_SOURCE_BUSY",
    tourism_demand_strength_manual_active: "REGIONAL_SOURCE_BUSY", tourism_demand_strength_backfill_busy: "REGIONAL_SOURCE_BUSY",
    tourism_demand_strength_state_unavailable: "CACHE_READ_ERROR" };
  return SAFE_CODES.has(error?.code) ? error.code : aliases[error?.code] || fallback;
}
function validDay(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const ms = Date.parse(`${value}T12:00:00Z`);
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === value;
}
function timeString(value) { return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T[\d:.+-]+Z?$/.test(value) && Number.isFinite(Date.parse(value)) ? value : ""; }
function networkAttempted(result) {
  return result?.networkAttempted === true || Number(result?.collection?.networkAttemptedMonths || 0) > 0 || Number(result?.collection?.operationCallsAttempted || 0) > 0;
}
function errorFromTourism(result, point) {
  const reasons = [point?.reason, point?.stayReason, point?.spendReason, result?.reason, ...(result?.collection?.refreshErrors || []).map((row) => row.reason)];
  const mappings = { missing_service_key: "MISSING_KEY", disabled: "PROVIDER_UNAVAILABLE", missing_endpoint: "PROVIDER_UNAVAILABLE",
    invalid_endpoint: "PROVIDER_UNAVAILABLE", untrusted_endpoint: "PROVIDER_UNAVAILABLE", fetch_unavailable: "PROVIDER_UNAVAILABLE",
    requested_region_not_matched: "REGION_MISMATCH", region_not_matched: "REGION_MISMATCH", period_not_closed: "PUBLICATION_PENDING",
    schema_error: "INVALID_RESPONSE", invalid_response: "INVALID_RESPONSE", gateway_error: "PROVIDER_FAILED", evidence_write_failed: "CACHE_WRITE_ERROR" };
  return reasons.map((reason) => mappings[reason]).find(Boolean) || (Number(result?.collection?.networkFailedMonths || 0) > 0 ? "PROVIDER_FAILED" : "");
}
function tourismView(spec, result, regionKey, requestedPeriod) {
  if (!result || typeof result !== "object") throw problem("INVALID_RESPONSE");
  const regions = spec.key === "visitors" ? result.regions : null;
  const regional = spec.key === "visitors" ? (regions || []).filter((region) => region.regionKey === regionKey) : null;
  if (spec.key === "visitors" ? regional.length > 1 || ((regions || []).length > 0 && !regional.length)
    : result.region?.regionKey && result.region.regionKey !== regionKey) throw problem("REGION_MISMATCH");
  const points = spec.key === "visitors" ? regional[0]?.series : result.series;
  const exact = (points || []).filter((point) => point.yearMonth === requestedPeriod);
  if (exact.length > 1 || result.period?.endYearMonth && result.period.endYearMonth !== requestedPeriod) throw problem("PERIOD_MISMATCH");
  const point = exact[0];
  const values = spec.fields.map((field) => ["resourceDemand", "diversity"].includes(spec.key) ? point?.values?.[field] : point?.[field]);
  const ready = point?.status === "complete" && values.every(Number.isFinite);
  const errorCode = errorFromTourism(result, point);
  const hasValues = values.some(Number.isFinite);
  const refreshFailed = Boolean(point?.refreshFailed || Number(result.collection?.networkFailedMonths || 0) > 0);
  const status = errorCode === "PUBLICATION_PENDING" ? "publication_pending"
    : ready && !refreshFailed ? "ready"
      : (hasValues || point?.status === "partial") ? "partial"
        : errorCode || refreshFailed ? "failed" : "missing";
  return { status, requestedPeriod, period: point ? requestedPeriod : "", retrievedAt: timeString(point?.collectedAt),
    errorCode: status === "ready" ? "" : errorCode || (status === "partial" ? "PARTIAL_DATA" : "NO_DATA"),
    cacheReused: ready && !networkAttempted(result), networkAttempted: networkAttempted(result), dataAvailable: hasValues,
    zeroValuesObserved: values.filter((value) => Number.isFinite(value) && value === 0).length,
    observedValueCount: values.filter(Number.isFinite).length, expectedValueCount: spec.fields.length };
}
function kosisView(result, regionKey) {
  if (!result || typeof result !== "object" || !Array.isArray(result.datasets)) throw problem("INVALID_RESPONSE");
  if (result.region?.regionKey && result.region.regionKey !== regionKey) throw problem("REGION_MISMATCH");
  const periods = KOSIS_DEFINITIONS.map((definition) => {
    const candidates = result.datasets.filter((dataset) => dataset.key === definition.key);
    if (candidates.length > 1) throw problem("INVALID_RESPONSE");
    const dataset = candidates[0];
    const rows = Array.isArray(dataset?.rows) ? dataset.rows : [];
    const validPeriod = definition.periodType === "M" ? /^\d{4}(0[1-9]|1[0-2])$/.test(dataset?.period || "") : /^\d{4}$/.test(dataset?.period || "");
    const expected = definition.metrics.flatMap((metric) => (definition.breakdowns || [null]).map((breakdown) => ({ key: breakdown?.key || metric.key, unit: metric.unit })));
    const observed = rows.filter((row) => row.status === "observed" && Number.isSafeInteger(row.value) && row.value >= 0
      && expected.some((metric) => metric.key === row.key && metric.unit === row.unit));
    const shapeValid = rows.length === expected.length && expected.every((metric) => rows.filter((row) => row.key === metric.key && row.unit === metric.unit).length === 1);
    const ready = dataset?.status === "ready" && dataset.periodType === definition.periodType && validPeriod && shapeValid && observed.length === rows.length;
    return { key: definition.key, label: definition.label, period: validPeriod ? dataset.period : "", periodType: definition.periodType,
      status: ready ? "ready" : observed.length ? "partial" : "missing", retrievedAt: timeString(dataset?.retrievedAt),
      observedValueCount: observed.length, zeroValuesObserved: observed.filter((row) => row.value === 0).length };
  });
  const complete = result.status === "ready" && periods.every((period) => period.status === "ready");
  const available = periods.some((period) => period.observedValueCount > 0);
  const code = result.error ? safeCode(result.error) : "";
  return { status: complete ? "ready" : available ? "partial" : code ? "failed" : "missing",
    period: [...new Set(periods.map((row) => row.period).filter(Boolean))].join(" · "), periods,
    retrievedAt: periods.map((row) => row.retrievedAt).filter(Boolean).sort().at(-1) || "",
    errorCode: complete ? "" : code || (available ? "PARTIAL_DATA" : "NO_DATA"),
    cacheReused: complete && !networkAttempted(result), networkAttempted: networkAttempted(result), dataAvailable: available,
    zeroValuesObserved: periods.reduce((sum, row) => sum + row.zeroValuesObserved, 0), referenceOnly: true };
}

function createRegionalReportPreparation({ dataDir, tourismCollector, kosisService, searchTrendService, resolveRegion, now = () => new Date(), kosisCacheTtlMs = 30 * 86400000, historyMonths = 1, reuseFinishedMs = 0 }) {
  if (!dataDir || typeof resolveRegion !== "function") throw problem("INVALID_REQUEST", 400);
  if (![1,24].includes(historyMonths) || !Number.isFinite(reuseFinishedMs) || reuseFinishedMs < 0) throw problem("INVALID_REQUEST",400);
  if (!Number.isFinite(kosisCacheTtlMs) || kosisCacheTtlMs < 0) throw problem("INVALID_REQUEST", 400);
  const file = path.join(dataDir, "jobs.json");
  let jobs = {}, initialization, lock = Promise.resolve(), runner = null;
  const queue = [];
  const instant = () => new Date(now());
  const iso = () => instant().toISOString();
  const today = () => new Date(instant().getTime() + 9 * 3600000).toISOString().slice(0, 10);
  const keyFor = (regionKey, month) => `${regionKey}|${month}`;
  const exclusive = (action) => { const task = lock.then(action); lock = task.catch(() => {}); return task; };
  async function persist() {
    const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
      await fs.mkdir(dataDir, { recursive: true });
      await fs.writeFile(temporary, JSON.stringify({ version: 1, jobs }), { encoding: "utf8", mode: 0o600 });
      await fs.rename(temporary, file);
    } catch { throw problem("PREPARATION_STORAGE_ERROR"); }
  }
  function progress(job) {
    const completed = job.steps.filter((step) => !ACTIVE.has(step.status)).length;
    job.progress = { completed, total: STEP_DEFINITIONS.length, percent: Math.round(completed / STEP_DEFINITIONS.length * 100) };
    job.updatedAt = iso();
  }
  async function initialize() {
    if (!initialization) initialization = (async () => {
      let stored;
      try { stored = JSON.parse(await fs.readFile(file, "utf8")); }
      catch (error) { if (error.code === "ENOENT") return; throw problem("PREPARATION_STORAGE_ERROR"); }
      if (stored.version !== 1 || !stored.jobs || typeof stored.jobs !== "object" || Array.isArray(stored.jobs)) throw problem("PREPARATION_STORAGE_ERROR");
      let migrated = false;
      for (const [key, job] of Object.entries(stored.jobs)) {
        if (job?.steps?.length === 5 && job.steps.every((step, index) => step.key === STEP_DEFINITIONS[index].key)) {
          job.steps.push({ key: "searchTrend", label: "검색 트렌드", status: "missing", errorCode: "NO_DATA", dataAvailable: false, networkAttempted: false });
          if (job.status === "complete") job.status = "partial";
          progress(job); migrated = true;
        }
        if (!job || key !== keyFor(job.regionKey, job.month) || !Array.isArray(job.steps) || job.steps.length !== STEP_DEFINITIONS.length
          || job.steps.some((step, index) => step.key !== STEP_DEFINITIONS[index].key)) throw problem("PREPARATION_STORAGE_ERROR");
      }
      jobs = stored.jobs;
      let changed = migrated;
      for (const job of Object.values(jobs)) if (ACTIVE.has(job.status)) {
        changed = true; job.status = "interrupted"; job.finishedAt = iso(); job.errorCode = "PREPARATION_INTERRUPTED";
        for (const step of job.steps) if (ACTIVE.has(step.status)) { step.status = "interrupted"; step.errorCode = "PREPARATION_INTERRUPTED"; }
        progress(job);
      }
      if (changed) await persist();
    })();
    return initialization;
  }
  function validate(input, requireCutoff) {
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some((field) => !["regionKey", "month", "cutoffDate"].includes(field))) throw problem("INVALID_REQUEST", 400);
    const { regionKey, month, cutoffDate } = input;
    if (typeof regionKey !== "string" || !regionKey || regionKey.length > 120 || /[\s\u0000-\u001f|/\\]/.test(regionKey)) throw problem("INVALID_REGION", 400);
    if (typeof month !== "string" || !/^20\d{2}-(0[1-9]|1[0-2])$/.test(month) || month > today().slice(0, 7)) throw problem("INVALID_MONTH", 400);
    if (requireCutoff && (!validDay(cutoffDate) || !/^20\d{2}-/.test(cutoffDate) || cutoffDate > today())) throw problem("INVALID_CUTOFF_DATE", 400);
    return { regionKey, month, cutoffDate };
  }
  async function runTourism(job, spec) {
    const requestedPeriod = job.month.replace("-", "");
    if (job.month >= today().slice(0, 7)) return { status: "publication_pending", errorCode: "PUBLICATION_PENDING", period: "", requestedPeriod };
    const method = tourismCollector?.[spec.method];
    if (typeof method !== "function") throw problem("PROVIDER_UNAVAILABLE");
    const input = { regionKeys: [job.regionKey], regionKey: job.regionKey, endYearMonth: requestedPeriod, months: historyMonths, analysisMonths: historyMonths,
      collectMissing: false, refresh: false, force: false, concurrency: 1, maxPagesPerOperation: 1 };
    const viewOf = result => {
      if(historyMonths===1)return tourismView(spec,result,job.regionKey,requestedPeriod);
      if(result?.period?.endYearMonth&&result.period.endYearMonth!==requestedPeriod)throw problem('PERIOD_MISMATCH');
      const periods=Array.from({length:historyMonths},(_,i)=>new Date(Date.UTC(Number(job.month.slice(0,4)),Number(job.month.slice(5,7))-historyMonths+i,1)).toISOString().slice(0,7).replace('-',''));
      const views=periods.map(period=>tourismView(spec,{...result,period:undefined},job.regionKey,period));
      const ready=views.every(v=>v.status==='ready'),available=views.some(v=>v.dataAvailable);
      return {status:ready?'ready':available?'partial':views.some(v=>v.status==='failed')?'failed':'missing',
        requestedPeriod,period:`${periods[0]} ~ ${requestedPeriod}`,observedMonths:views.filter(v=>v.status==='ready').length,expectedMonths:historyMonths,
        dataAvailable:available,cacheReused:ready&&!networkAttempted(result),networkAttempted:networkAttempted(result),
        retrievedAt:views.map(v=>v.retrievedAt).filter(Boolean).sort().at(-1)||'',
        errorCode:ready?'':views.find(v=>v.errorCode&&v.errorCode!=='NO_DATA')?.errorCode||'MISSING_VALUES'};
    };
    const cached = await method.call(tourismCollector, input);
    if (networkAttempted(cached)) throw problem("CACHE_ONLY_VIOLATION");
    const existing = viewOf(cached);
    if (existing.status === "ready") return existing;
    if (["REGION_MISMATCH", "PUBLICATION_PENDING"].includes(existing.errorCode)) return existing;
    try {
      const collected = await method.call(tourismCollector, { ...input, collectMissing: true });
      const view = viewOf(collected);
      return !view.dataAvailable && existing.dataAvailable
        ? { ...existing, status: "partial", cacheReused: true, networkAttempted: view.networkAttempted, errorCode: view.errorCode || "PROVIDER_FAILED" } : view;
    } catch (error) {
      return { ...existing, status: existing.dataAvailable ? "partial" : "failed", cacheReused: existing.dataAvailable,
        networkAttempted: null, errorCode: safeCode(error) };
    }
  }
  async function runKosis(job) {
    if (typeof kosisService?.getRegion !== "function" || typeof kosisService?.refreshRegion !== "function") throw problem("PROVIDER_UNAVAILABLE");
    const cached = await kosisService.getRegion(job.regionKey);
    if (networkAttempted(cached)) throw problem("CACHE_ONLY_VIOLATION");
    const existing = kosisView(cached, job.regionKey);
    const current = instant().getTime();
    const fresh = existing.periods.every((period) => period.retrievedAt && Date.parse(period.retrievedAt) <= current && current - Date.parse(period.retrievedAt) <= kosisCacheTtlMs);
    if (existing.status === "ready" && fresh) return existing;
    try {
      const view = kosisView(await kosisService.refreshRegion(job.regionKey), job.regionKey);
      return !view.dataAvailable && existing.dataAvailable
        ? { ...existing, status: "partial", cacheReused: true, networkAttempted: view.networkAttempted, errorCode: view.errorCode || "PROVIDER_FAILED" } : view;
    } catch (error) {
      return { ...existing, status: existing.dataAvailable ? "partial" : "failed", cacheReused: existing.dataAvailable,
        networkAttempted: null, errorCode: safeCode(error) };
    }
  }
  async function execute(job) {
    await exclusive(async () => { job.status = "running"; job.startedAt = iso(); progress(job); await persist(); });
    for (let index = 0; index < job.steps.length; index++) {
      const step = job.steps[index], spec = STEP_DEFINITIONS[index];
      await exclusive(async () => { step.status = "running"; step.startedAt = iso(); progress(job); await persist(); });
      let result;
      try { result = spec.key === "searchTrend" ? await runSearchTrend(job) : spec.key === "kosis" ? await runKosis(job) : await runTourism(job, spec); }
      catch (error) { result = { status: "failed", errorCode: safeCode(error), networkAttempted: null }; }
      await exclusive(async () => { Object.assign(step, result, { finishedAt: iso() }); progress(job); await persist(); });
    }
    await exclusive(async () => {
      job.status = job.steps.every((step) => step.status === "ready") ? "complete" : job.steps.every((step) => step.status === "failed") ? "failed" : "partial";
      job.finishedAt = iso(); progress(job); await persist();
    });
  }
  async function runSearchTrend(job) {
    if (typeof searchTrendService?.refresh !== "function") throw problem("PROVIDER_UNAVAILABLE");
    const result = await searchTrendService.refresh({ regionKey: job.regionKey, month: job.month, ...(historyMonths===24?{months:24}:{}) });
    if (!result || result.regionKey !== job.regionKey) throw problem("REGION_MISMATCH");
    if (!["ready", "partial", "missing", "failed", "publication_pending"].includes(result.status)) throw problem("INVALID_RESPONSE");
    const observed = (result.series || []).filter(row => row.status === "observed" && Number.isFinite(row.value) && row.value >= 0 && row.value <= 100);
    job.searchKeyword = String(result.keyword || "");
    return { status: result.status, keyword: job.searchKeyword, period: result.startDate && result.endDate ? `${result.startDate} ~ ${result.endDate}` : "",
      startDate: result.startDate || "", endDate: result.endDate || "", partialMonth: Boolean(result.partialMonth),
      retrievedAt: timeString(result.retrievedAt), errorCode: result.errorCode ? safeCode({ code: result.errorCode }) : "",
      configured: Boolean(result.configured), dataAvailable: observed.length > 0, zeroValuesObserved: observed.filter(row => row.value === 0).length,
      observedValueCount: observed.length, expectedValueCount: result.series?.length || 0,
      networkAttempted: result.networkAttempted === true, cacheReused: result.cacheReused === true, referenceOnly: true };
  }
  function kick() {
    if (runner || !queue.length) return;
    runner = (async () => {
      while (queue.length) {
        const job = queue.shift();
        try { await execute(job); }
        catch (error) {
          await exclusive(async () => {
            job.status = "failed"; job.errorCode = safeCode(error, "PREPARATION_STORAGE_ERROR"); job.finishedAt = iso();
            for (const step of job.steps) if (ACTIVE.has(step.status)) { step.status = "interrupted"; step.errorCode = job.errorCode; }
            progress(job); await persist().catch(() => {});
          });
        }
      }
    })().finally(() => { runner = null; if (queue.length) kick(); });
  }
  async function start(input) {
    const request = validate(input, true);
    await initialize();
    const region = await resolveRegion(request.regionKey);
    if (!region || region.regionKey !== request.regionKey || region.level !== "local" || region.active === false || region.selectable === false) throw problem("INVALID_REGION", 400);
    return exclusive(async () => {
      const key = keyFor(request.regionKey, request.month), existing = jobs[key];
      if (existing && ACTIVE.has(existing.status)) return clone(existing);
      if(existing?.finishedAt&&reuseFinishedMs>0&&instant().getTime()-Date.parse(existing.finishedAt)>=0&&instant().getTime()-Date.parse(existing.finishedAt)<reuseFinishedMs)return {...clone(existing),reused:true};
      const job = { id: crypto.randomUUID(), ...request, historyMonths, regionName: String(region.fullName || region.name || region.regionKey).slice(0, 160),
        status: "queued", createdAt: iso(), startedAt: "", finishedAt: "", updatedAt: iso(), errorCode: "",
        steps: STEP_DEFINITIONS.map((spec) => ({ key: spec.key, label: spec.label, status: "queued", requestedPeriod: request.month.replace("-", ""),
          period: "", retrievedAt: "", errorCode: "", cacheReused: false, networkAttempted: false, dataAvailable: false, zeroValuesObserved: 0,
          startedAt: "", finishedAt: "" })) };
      progress(job); jobs[key] = job;
      try { await persist(); } catch (error) { if (existing) jobs[key] = existing; else delete jobs[key]; throw error; }
      queue.push(job); setImmediate(kick);
      return clone(job);
    });
  }
  async function get(input) {
    const request = validate(input, false);
    await initialize();
    return exclusive(() => clone(jobs[keyFor(request.regionKey, request.month)] || null));
  }
  async function awaitIdle() {
    await initialize(); await lock; kick();
    while (runner) { await runner; await lock; kick(); }
  }
  async function connectionStatus() {
    if (typeof searchTrendService?.status !== "function") return { configured: false, lastCheckedAt: "", lastSuccessAt: "", errorCode: "PROVIDER_UNAVAILABLE" };
    const result = await searchTrendService.status();
    return { configured: Boolean(result.configured), lastCheckedAt: timeString(result.lastCheckedAt), lastSuccessAt: timeString(result.lastSuccessAt),
      errorCode: result.errorCode ? safeCode({ code: result.errorCode }) : "" };
  }
  return { start, get, awaitIdle, connectionStatus };
}

module.exports = { createRegionalReportPreparation };
