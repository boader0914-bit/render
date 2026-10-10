"use strict";

// A rebuildable read model only. Collection evidence and issued reports remain
// owned by their existing stores; this module never writes to either of them.
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { buildMonthlyReportSnapshot } = require("./monthly_reports.cjs");
const { buildMonthlyComparison, previousMonthlyReportRequest } = require("./monthly_report_comparison.cjs");

const SCHEMA_VERSION = 1;
const CALCULATION_VERSION = "company-integrated-v1";
const clone = value => JSON.parse(JSON.stringify(value));
const identity = row => String(row?.companyId || row?.companyKey || row?.id || "");
const monthValid = value => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(value || ""));
const kstDay = date => new Date(new Date(date).getTime() + 9 * 3600000).toISOString().slice(0, 10);
const digest = value => crypto.createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(stable(value))).digest("hex");
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
  return value;
}
function fault(code, statusCode = 503) {
  return Object.assign(new Error(code), { code, statusCode });
}
function validId(value) {
  if (typeof value !== "string" || !value.trim() || value.length > 300 || /[\x00-\x1f\x7f]/.test(value)) throw fault("invalid_company_id", 400);
  return value.trim();
}
function monthsOf(values) {
  if (!Array.isArray(values) || values.some(month => !monthValid(month))) throw fault("invalid_month", 400);
  return [...new Set(values)].sort();
}
function monthEnd(month) {
  const [year, number] = month.split("-").map(Number);
  return new Date(Date.UTC(year, number, 0)).toISOString().slice(0, 10);
}
function nextMonth(month) {
  const [year, number] = month.split("-").map(Number);
  return new Date(Date.UTC(year, number, 1)).toISOString().slice(0, 7);
}
function cutoffFor(month, now) { return [monthEnd(month), kstDay(now)].sort()[0]; }
function validCutoff(value, now) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw fault("invalid_cutoff", 400);
  const date = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value || value > kstDay(now)) throw fault("invalid_cutoff", 400);
  return value;
}
function safeCode(error) {
  return /^[A-Za-z0-9_:-]{1,100}$/.test(String(error?.code || "")) ? error.code : "COMPANY_INTEGRATION_FAILED";
}
async function readJson(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return fallback; throw fault("COMPANY_INTEGRATION_STORE_UNAVAILABLE"); }
}
async function atomicJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  let handle;
  try {
    handle = await fs.open(temporary, "wx", 0o600);
    await handle.writeFile(JSON.stringify(value));
    await handle.sync();
    await handle.close(); handle = null;
    await fs.rename(temporary, file);
  } finally {
    if (handle) await handle.close().catch(() => {});
    await fs.unlink(temporary).catch(() => {});
  }
}
function scopedSources(source, companyId) {
  const observations = (source.observations || []).filter(row => identity(row) === companyId);
  const rankObservations = (source.rankObservations || []).filter(row => identity(row) === companyId);
  const runIds = new Set([...observations, ...rankObservations].map(row => String(row.runId || "")));
  return { ...source, companies: (source.companies || []).filter(row => identity(row) === companyId), observations, rankObservations,
    runs: (source.runs || []).filter(run => runIds.has(String(run.id || run.runId || ""))) };
}
function latestAttempts(source, snapshot, request) {
  const selected = new Map((snapshot.sources?.observations || []).map(row => [`${row.date}|${row.productType}`, row]));
  const runs = new Map((source.runs || []).map(run => [String(run.id || run.runId || ""), run]));
  const attempts = new Map();
  for (const row of source.observations || []) {
    const date = String(row.stayDate || row.date || ""), collectedAt = String(row.collectedAt || "");
    if (!date.startsWith(request.month + "-") || !Number.isFinite(Date.parse(collectedAt)) || kstDay(collectedAt) > request.cutoffDate) continue;
    const productType = String(row.productType || ""), key = `${date}|${productType}`;
    const prior = attempts.get(key);
    if (prior && (Date.parse(prior.collectedAt) > Date.parse(collectedAt) || (prior.collectedAt === collectedAt && prior.runId >= String(row.runId || "")))) continue;
    const runId = String(row.runId || ""), run = runs.get(runId), accepted = selected.get(key);
    const runQuality = String(typeof run?.collectionQuality === "string" ? run.collectionQuality : run?.collectionQuality?.status || "unknown");
    const reason = row.failed || row.error || row.missing ? "missing_response"
      : !["complete", "reused", "partial"].includes(runQuality) ? `run_${runQuality}`
      : row.partial || row.sharedDayUseIncomplete || Number(row.unknownUnavailable) > 0 ? "partial_inventory"
      : Number(row.inventoryEvidenceVersion || 0) < 3 ? "legacy_inventory_evidence"
      : kstDay(collectedAt) > date ? "post_stay_observation" : "";
    const isSelected = Boolean(accepted && accepted.runId === runId && accepted.collectedAt === collectedAt);
    attempts.set(key, { date, productType, runId, collectedAt, keyword: String(row.keyword || run?.keyword || ""),
      status: reason ? "excluded" : isSelected ? "selected" : "not_selected", reason: reason || (isSelected ? "" : "not_selected_by_quality_rules"),
      lastValidRunId: accepted?.runId || null, lastValidCollectedAt: accepted?.collectedAt || null });
  }
  return [...attempts.values()].sort((a, b) => a.date.localeCompare(b.date) || a.productType.localeCompare(b.productType));
}

function createCompanyIntegratedDb({ dataDir, loadSources, catalog, listTargets, now = () => new Date(), calculationVersion = CALCULATION_VERSION, autoStart = true } = {}) {
  if (!dataDir || typeof loadSources !== "function" || typeof catalog !== "function" || typeof listTargets !== "function") throw new TypeError("dataDir, loadSources, catalog and listTargets are required");
  const directory = path.resolve(dataDir, "company_integrated"), stateFile = path.join(directory, "queue.json");
  let state = { schemaVersion: SCHEMA_VERSION, jobs: {} }, initPromise, workerPromise = null, serial = Promise.resolve(), stopped = false, storeError = null;
  const current = () => {
    const value = typeof now === "function" ? now() : now, result = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(result.getTime())) throw fault("invalid_clock", 500);
    return result;
  };
  const indexPath = id => path.join(directory, digest(id), "index.json");
  const monthPath = (id, month) => path.join(directory, digest(id), `${month}.json`);
  function locked(fn) {
    const result = serial.then(fn);
    serial = result.catch(() => {});
    return result;
  }
  const saveState = () => atomicJson(stateFile, state);
  async function init() {
    if (!initPromise) initPromise = (async () => {
      const stored = await readJson(stateFile, null);
      if (stored) {
        if (stored.schemaVersion !== SCHEMA_VERSION || !stored.jobs || typeof stored.jobs !== "object" || Array.isArray(stored.jobs)) throw fault("COMPANY_INTEGRATION_STATE_INVALID");
        state = stored;
        state.queueSequence = Math.max(Number(state.queueSequence) || 0, ...Object.values(state.jobs).map(job => Number(job.queueOrder) || 0));
        state.readPrioritySequence = Math.max(Number(state.readPrioritySequence) || 0, ...Object.values(state.jobs).map(job => Number(job.readPriorityOrder) || 0));
        for (const [id, job] of Object.entries(state.jobs)) {
          validId(id); monthsOf(job.months || []);
          if (!job.queueOrder) job.queueOrder = ++state.queueSequence;
          if (["processing", "queued", "failed"].includes(job.status)) { job.status = "queued"; job.recoveredAt = current().toISOString(); }
        }
        await saveState();
      }
    })();
    return initPromise;
  }
  async function activeCompany(companyId) {
    const data = await catalog();
    const company = (data.companies || []).find(row => identity(row) === companyId);
    const raw = data.rawCompanies instanceof Map ? data.rawCompanies.get(companyId) : data.rawCompanies?.[companyId];
    if (!company || company.deletedAt || company.mergedIntoCompanyId || raw?.deletedAt || raw?.mergedIntoCompanyId) throw fault("company_not_found", 404);
    return { company, raw, data };
  }
  async function targetsFor(companyId, additional = []) {
    const [targets, index] = await Promise.all([listTargets({ companyIds: [companyId] }), readJson(indexPath(companyId), null)]);
    return monthsOf([...additional, ...(index?.months || []), ...targets.filter(target => target.companyId === companyId).flatMap(target => target.months || [])]);
  }
  async function queueCompany(companyId, { months, reason = "source_changed" } = {}) {
    companyId = validId(companyId);
    let requested = months === undefined ? null : monthsOf(months);
    await init();
    // The following cached month embeds a comparison against this month. It
    // must be refreshed too, even if none of its own stay dates changed.
    if (requested) {
      const index = await readJson(indexPath(companyId), null);
      requested = monthsOf([...requested, ...requested.map(nextMonth).filter(value => index?.months?.includes(value))]);
    }
    const result = await locked(async () => {
      const prior = state.jobs[companyId], timestamp = current().toISOString();
      const job = state.jobs[companyId] = { ...prior, companyId, generation: (prior?.generation || 0) + 1,
        queueOrder: prior?.status === "queued" && prior.queueOrder ? prior.queueOrder : (state.queueSequence = (state.queueSequence || 0) + 1),
        readPriorityOrder: prior?.status === "queued" ? prior.readPriorityOrder || null : null,
        status: "queued", allMonths: requested === null || (prior?.status !== "idle" && Boolean(prior?.allMonths)),
        months: monthsOf([...(prior?.status !== "idle" ? prior?.months || [] : []), ...(requested || [])]),
        reason: String(reason).slice(0, 160), queuedAt: timestamp, updatedAt: timestamp, errorCode: null };
      await saveState(); return clone(job);
    });
    if (autoStart) kick();
    return result;
  }
  async function prioritizeQueuedRead(companyId) {
    await locked(async () => {
      const job = state.jobs[companyId];
      // Repeated polling must not resubmit a job, invalidate its generation or
      // continually move it ahead of other requested companies.
      if (job?.status !== "queued" || job.readPriorityOrder) return;
      job.readPriorityOrder = state.readPrioritySequence = (state.readPrioritySequence || 0) + 1;
      await saveState();
    });
  }
  async function queueRun({ runId = "", companyIds, months, reason = "collection_saved" } = {}) {
    if (companyIds !== undefined && !Array.isArray(companyIds)) throw fault("invalid_company_ids", 400);
    if (months !== undefined) monthsOf(months);
    const targets = await listTargets({ runId: String(runId), ...(companyIds ? { companyIds: companyIds.map(validId) } : {}) });
    const grouped = new Map();
    for (const target of targets) {
      const id = validId(target.companyId);
      grouped.set(id, monthsOf([...(grouped.get(id) || []), ...(months || target.months || [])]));
    }
    const jobs = [];
    for (const [id, targetMonths] of grouped) jobs.push(await queueCompany(id, { months: targetMonths, reason }));
    return { queued: jobs.length, companyIds: jobs.map(job => job.companyId) };
  }
  async function bootstrap() {
    await init();
    const targets = await listTargets({});
    const grouped = new Map();
    for (const target of targets) {
      const id = validId(target.companyId);
      grouped.set(id, monthsOf([...(grouped.get(id) || []), ...(target.months || [])]));
    }
    for (const [id, months] of grouped) await queueCompany(id, { months, reason: "bootstrap" });
    if (autoStart) kick();
    return { queued: grouped.size };
  }
  async function materialize(companyId, month, metadata, cutoffDate, persist = true) {
    const generatedAt = current().toISOString();
    const request = { type: "company", targetId: companyId, month, cutoffDate: cutoffDate || cutoffFor(month, generatedAt) };
    const source = scopedSources(await loadSources(clone(request)), companyId);
    const previousRequest = previousMonthlyReportRequest(request);
    const previousSource = scopedSources(await loadSources(clone(previousRequest)), companyId);
    const capacityMarker = metadata.raw?._integratedCapacity || metadata.company.capacityBasis || null;
    const capacityWarnings = Array.isArray(capacityMarker?.warnings) ? capacityMarker.warnings.filter(value => typeof value === "string") : [];
    if (capacityWarnings.length) source.warnings = [...new Set([...(source.warnings || []), ...capacityWarnings])];
    const sourceDigest = digest({ version: calculationVersion, request, monthClosed: kstDay(generatedAt) > monthEnd(month),
      source, previousSource, correction: metadata.raw?.manualCorrection || null, capacity: metadata.company.capacity,
      capacitySource: metadata.company.capacitySource, capacityMarker });
    const previous = persist ? await readJson(monthPath(companyId, month), null) : null;
    if (previous?.sourceDigest === sourceDigest && previous.calculationVersion === calculationVersion) return { value: previous, changed: false };
    const snapshot = buildMonthlyReportSnapshot(request, source, generatedAt);
    snapshot.comparison = buildMonthlyComparison(snapshot, buildMonthlyReportSnapshot(previousRequest, previousSource, generatedAt));
    const attempts = latestAttempts(source, snapshot, request);
    const roomBasis = { capacity: capacityMarker?.capacity ?? capacityMarker?.count ?? metadata.company.capacity ?? null,
      source: capacityMarker?.source || metadata.company.capacitySource || "unknown",
      label: capacityMarker?.label || metadata.company.capacitySource || "객실 기준 확인 필요",
      revision: capacityMarker?.revision || null, updatedAt: capacityMarker?.updatedAt || null,
      observedMaximum: capacityMarker?.observedMaximum ?? null, warnings: capacityWarnings };
    return { changed: true, value: { schemaVersion: SCHEMA_VERSION, calculationVersion, companyId, month, sourceDigest, calculatedAt: generatedAt,
      cutoffDate: request.cutoffDate, roomBasis, snapshot, latestAttempts: attempts,
      failedAttempts: attempts.filter(attempt => ["missing_response", "run_failed", "run_blocked", "run_interrupted", "run_cancelled", "run_canceled", "run_error"].includes(attempt.reason)) } };
  }
  async function processJob(job) {
    const metadata = await activeCompany(job.companyId);
    const months = job.allMonths ? await targetsFor(job.companyId, job.months) : monthsOf(job.months);
    for (const month of months) {
      const calculated = await materialize(job.companyId, month, metadata);
      const published = await locked(async () => {
        if (state.jobs[job.companyId]?.generation !== job.generation) return false;
        if (calculated.changed) await atomicJson(monthPath(job.companyId, month), calculated.value);
        const index = await readJson(indexPath(job.companyId), { schemaVersion: SCHEMA_VERSION, companyId: job.companyId, months: [] });
        if (!index.months.includes(month) || calculated.changed) await atomicJson(indexPath(job.companyId), {
          ...index, months: monthsOf([...index.months, month]), updatedAt: current().toISOString(), calculationVersion });
        return true;
      });
      if (!published) return;
    }
    await locked(async () => {
      if (state.jobs[job.companyId]?.generation !== job.generation) return;
      state.jobs[job.companyId] = { ...state.jobs[job.companyId], status: "idle", months: [], allMonths: false, finishedAt: current().toISOString(), errorCode: null };
      await saveState();
    });
  }
  async function runQueue() {
    await init();
    while (!stopped) {
      const job = await locked(async () => {
        const queued = Object.values(state.jobs).filter(value => value.status === "queued").sort((a, b) => a.queueOrder - b.queueOrder);
        // Alternate requested work with the oldest waiting job so background
        // bootstrap continues to advance even while many users are browsing.
        const priority = !state.lastDispatchWasReadPriority && queued.filter(value => value.readPriorityOrder).sort((a, b) => a.readPriorityOrder - b.readPriorityOrder)[0];
        const next = priority || queued[0];
        if (!next) return null;
        state.lastDispatchWasReadPriority = Boolean(priority);
        next.readPriorityOrder = null;
        next.status = "processing"; next.startedAt = current().toISOString(); next.attempts = (next.attempts || 0) + 1;
        await saveState(); return clone(next);
      });
      if (!job) break;
      try { await processJob(job); }
      catch (error) {
        await locked(async () => {
          if (state.jobs[job.companyId]?.generation !== job.generation) return;
          Object.assign(state.jobs[job.companyId], { status: "failed", failedAt: current().toISOString(), errorCode: safeCode(error) });
          await saveState();
        });
      }
    }
  }
  function kick() {
    if (workerPromise || stopped) return;
    workerPromise = runQueue().catch(error => { storeError = safeCode(error); }).finally(() => {
      workerPromise = null;
      if (!storeError && !stopped && Object.values(state.jobs).some(job => job.status === "queued")) kick();
    });
  }
  async function drain() {
    await init();
    do { kick(); if (workerPromise) await workerPromise; await serial; }
    while (!storeError && !stopped && (workerPromise || Object.values(state.jobs).some(job => job.status === "queued")));
    return status();
  }
  async function status() {
    await init();
    return { schemaVersion: SCHEMA_VERSION, calculationVersion, active: Boolean(workerPromise), errorCode: storeError,
      counts: Object.values(state.jobs).reduce((counts, job) => { counts[job.status] = (counts[job.status] || 0) + 1; return counts; }, {}),
      jobs: Object.values(state.jobs).map(job => ({ companyId: job.companyId, status: job.status, generation: job.generation,
        months: job.months, errorCode: job.errorCode, updatedAt: job.updatedAt, startedAt: job.startedAt, finishedAt: job.finishedAt })) };
  }
  async function get(companyId, { month, cutoffDate, knownMonthsOnly = false } = {}) {
    companyId = validId(companyId);
    if (month !== undefined && !monthValid(month)) throw fault("invalid_month", 400);
    if (cutoffDate !== undefined) validCutoff(cutoffDate, current());
    await init();
    const metadata = await activeCompany(companyId);
    const index = await readJson(indexPath(companyId), null);
    const monthList = monthsOf(index?.months || []), currentMonth = kstDay(current()).slice(0, 7);
    const selectedMonth = month || (monthList.includes(currentMonth) ? currentMonth : monthList.filter(value => value <= currentMonth).at(-1) || monthList.at(-1) || currentMonth);
    if (knownMonthsOnly === true && selectedMonth !== currentMonth && !monthList.includes(selectedMonth)) {
      const discovered = await targetsFor(companyId);
      if (!discovered.includes(selectedMonth)) throw fault("MONTH_NOT_OBSERVED", 400);
    }
    let selected = await readJson(monthPath(companyId, selectedMonth), null);
    if (cutoffDate !== undefined && (!selected || selected.cutoffDate !== cutoffDate)) selected = (await materialize(companyId, selectedMonth, metadata, cutoffDate, false)).value;
    const job = state.jobs[companyId];
    const needsRefresh = !selected || selected.calculationVersion !== calculationVersion || (cutoffDate === undefined &&
      (selected.cutoffDate !== cutoffFor(selectedMonth, current()) || selected.snapshot.period.monthClosed !== (kstDay(current()) > monthEnd(selectedMonth))));
    if (needsRefresh && !["queued", "processing", "failed"].includes(job?.status)) {
      // A registered company can have no inventory yet. Materialize its selected
      // empty month too, instead of requeuing an empty discovery on every read.
      const months = index ? [selectedMonth] : await targetsFor(companyId, [selectedMonth]);
      await queueCompany(companyId, { months, reason: "read_cache_miss" });
    }
    if (needsRefresh) await prioritizeQueuedRead(companyId);
    if (autoStart && state.jobs[companyId]?.status === "queued") kick();
    const rows = [];
    for (const value of [...new Set([...monthList, ...(selected ? [selectedMonth] : [])])].sort().reverse()) {
      const entry = value === selectedMonth ? selected : await readJson(monthPath(companyId, value), null);
      if (entry) rows.push({ month: value, calculatedAt: entry.calculatedAt, cutoffDate: entry.cutoffDate,
        status: entry.snapshot.quality.status, quality: entry.snapshot.quality, summary: entry.snapshot.summary });
    }
    const runMap = new Map((metadata.data.runs || []).map(run => [String(run.id || run.runId || ""), run]));
    const keywords = Object.values(metadata.raw?.keywords || {}).map(value => ({ keyword: String(value.keyword || ""),
      runs: (value.runs || []).map(run => ({ runId: String(run.runId || run.id || ""), collectedAt: String(run.collectedAt || ""),
        rank: Number.isFinite(Number(run.rank || run.overallRank)) ? Number(run.rank || run.overallRank) : null,
        status: String(runMap.get(String(run.runId || run.id || ""))?.collectionQuality?.status || "unknown") })) })).filter(value => value.keyword);
    const basis = selected?.snapshot.companies?.[0];
    const selectedRoomBasis = selected?.roomBasis || metadata.raw?._integratedCapacity;
    const stateJob = state.jobs[companyId];
    return { schemaVersion: SCHEMA_VERSION, companyId, calculationVersion, calculatedAt: selected?.calculatedAt || null,
      status: stateJob?.status === "failed" || storeError ? "failed" : ["queued", "processing"].includes(stateJob?.status) ? "refreshing" : selected ? "ready" : "pending",
      errorCode: storeError || stateJob?.errorCode || null, selectedMonth, months: rows, snapshot: selected?.snapshot || null,
      keywords, roomBasis: { ...selectedRoomBasis, capacity: selectedRoomBasis?.capacity ?? selectedRoomBasis?.count ?? basis?.capacity ?? metadata.company.capacity ?? null,
        source: selectedRoomBasis?.source || basis?.capacitySource || metadata.company.capacitySource || "unknown",
        label: selectedRoomBasis?.label || basis?.capacitySource || metadata.company.capacitySource || "객실 기준 확인 필요",
        warnings: [...new Set([...(selectedRoomBasis?.warnings || []), ...(selected?.snapshot.quality?.warnings || []).filter(warning => /객실|재고|총량|수량/.test(warning))])] },
      latestAttempts: selected?.latestAttempts || [], failedAttempts: selected?.failedAttempts || [],
      freshness: { lastCalculatedAt: selected?.calculatedAt || null, refreshStatus: stateJob?.status || "idle", lastRefreshError: stateJob?.errorCode || null },
      sourcePolicy: "원본 보존 · 업체 고유번호 통합 · 최신 유효 관측 · 미관측은 결측 · 월간 리포트 공통 계산" };
  }
  async function stop() { stopped = true; if (workerPromise) await workerPromise; await serial; }
  return { bootstrap, queueCompany, queueRun, get, status, drain, stop };
}

module.exports = { createCompanyIntegratedDb, COMPANY_INTEGRATED_SCHEMA_VERSION: SCHEMA_VERSION, COMPANY_INTEGRATED_CALCULATION_VERSION: CALCULATION_VERSION };
