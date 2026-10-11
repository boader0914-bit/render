"use strict";

// Rebuildable results only. This store never changes collection evidence.
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const SCHEMA_VERSION = 1;
const CALCULATION_VERSION = "industry-analysis-v1";
const clone = value => structuredClone(value);
const fault = code => Object.assign(new Error(code), { code, statusCode: 503 });
const safeCode = error => /^[A-Z0-9_:-]{1,100}$/i.test(String(error?.code || "")) ? error.code : "INDUSTRY_CALCULATION_FAILED";
async function readJson(file, fallback = null) {
  try { return JSON.parse(await fs.readFile(file, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return fallback; throw fault("INDUSTRY_STORE_UNAVAILABLE"); }
}
async function atomicJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  let handle;
  try {
    handle = await fs.open(temporary, "wx", 0o600);
    await handle.writeFile(JSON.stringify(value)); await handle.sync(); await handle.close(); handle = null;
    await fs.rename(temporary, file);
  } finally {
    if (handle) await handle.close().catch(() => {});
    await fs.unlink(temporary).catch(() => {});
  }
}
function createIndustryAnalysisStore({ dataDir, calculate, now = () => new Date(), calculationVersion = CALCULATION_VERSION,
  autoStart = true, onInvalidate = () => {}, readSourceRevision = null, normalizeStoredRequest = request => request, writeJson = atomicJson }) {
  if (!dataDir || typeof calculate !== "function") throw new TypeError("dataDir and calculate are required");
  const directory = path.resolve(dataDir, "industry_analysis"), stateFile = path.join(directory, "queue.json");
  const emptyState = () => ({ schemaVersion: SCHEMA_VERSION, epoch: crypto.randomUUID(), revision: 0, monthRevisions: {}, optionsRevision: 0, sequence: 0, jobs: {} });
  let state = emptyState();
  let initialization, bootstrapped, serial = Promise.resolve(), worker = null, stopped = false, storeError = null;
  let tokenTask = null, lastTokenCheck = -Infinity, settleTimer = null;
  const timestamp = () => new Date(now()).toISOString();
  const revisionFor = month => `${state.epoch || "initial"}:${state.revision}.${state.monthRevisions[month] || 0}`;
  const optionsToken = () => `${state.epoch || "initial"}:${state.optionsRevision}`;
  const keyFor = request => crypto.createHash("sha256").update(JSON.stringify([calculationVersion, request.month, request.cutoffDate, request.industry, request.region])).digest("hex");
  const resultFile = key => path.join(directory, "results", `${key}.json`);
  const saveState = () => writeJson(stateFile, state);
  function locked(fn) { const task = serial.then(fn); serial = task.catch(() => {}); return task; }
  async function init() {
    if (!initialization) initialization = (async () => {
      const stored = await readJson(stateFile);
      if (!stored) return;
      if (stored.schemaVersion !== SCHEMA_VERSION || !stored.jobs || Array.isArray(stored.jobs)
        || !Number.isSafeInteger(stored.revision) || !stored.monthRevisions) throw fault("INDUSTRY_STORE_INVALID");
      state = stored;
      for (const [key, job] of Object.entries(state.jobs)) {
        if (!job?.request || !/^\d{4}-\d{2}$/.test(job.request.month) || !Number.isSafeInteger(job.generation)) throw fault("INDUSTRY_STORE_INVALID");
        if (job.calculationVersion !== calculationVersion) { job.status = "obsolete"; continue; }
        if (keyFor(job.request) !== key) throw fault("INDUSTRY_STORE_INVALID");
        // Old rolling cutoffs remain on disk, but must not recreate a job under
        // a different canonical request after month-end normalization changes.
        if (keyFor(normalizeStoredRequest(job.request)) !== key) { job.status = "obsolete"; continue; }
        if (["queued", "processing"].includes(job.status)) {
          job.status = "queued"; job.recoveredAt = timestamp(); job.errorCode = null;
        }
      }
      try { await saveState(); } catch (error) { storeError = safeCode(error); }
    })().catch(error => { state = emptyState(); storeError = safeCode(error); });
    return initialization;
  }
  async function bootstrap() {
    if (!bootstrapped) bootstrapped = (async () => {
      await init();
      await checkSource(true);
      if (autoStart) kick();
    })();
    return bootstrapped;
  }
  async function checkSource(force = false) {
    await init();
    if (!readSourceRevision || storeError) return;
    if (tokenTask) return tokenTask;
    if (!force && !state.sourceCheckPending && new Date(now()).getTime() - lastTokenCheck < 30000) return;
    tokenTask = (async () => {
      const eventSequence = state.sourceEventSequence || 0;
      const value = await readSourceRevision();
      const scoped = value && typeof value === "object" && !Array.isArray(value)
        && typeof value.globalToken === "string" && value.months && typeof value.months === "object" && !Array.isArray(value.months)
        && Object.entries(value.months).every(([month, token]) => /^\d{4}-(0[1-9]|1[0-2])$/.test(month) && typeof token === "string");
      if (value && typeof value === "object" && !scoped) throw fault("INDUSTRY_SOURCE_REVISION_INVALID");
      const token = scoped ? null : String(value);
      await locked(async () => {
        if (scoped) {
          const previous = state.sourceSnapshot;
          if (!previous || previous.globalToken !== value.globalToken) {
            if (previous || state.sourceToken !== undefined) invalidateState(null, "source_revision_changed");
          } else {
            const months = [...new Set([...Object.keys(previous.months), ...Object.keys(value.months)])]
              .filter(month => previous.months[month] !== value.months[month]);
            if (months.length) invalidateState(months, "month_source_changed");
          }
          state.sourceSnapshot = clone(value); delete state.sourceToken;
        } else if (state.sourceToken !== token) {
          if (state.sourceToken !== undefined || state.sourceSnapshot) invalidateState(null, "source_revision_changed");
          state.sourceToken = token; delete state.sourceSnapshot;
        }
        state.sourceCheckPending = eventSequence !== (state.sourceEventSequence || 0);
        await saveState();
      });
      lastTokenCheck = new Date(now()).getTime();
      if (autoStart) scheduleKick();
    })().catch(async error => {
      if (error.code === "INDUSTRY_SOURCE_CHANGED") {
        // A concurrent writer is not damaged evidence. Keep normal snapshots
        // and check after quiet time instead of permanently stopping updates.
        await locked(async () => { state.sourceCheckPending = true; await saveState(); });
        if (autoStart) scheduleKick();
      } else storeError = safeCode(error);
    }).catch(error => { storeError = safeCode(error); }).finally(() => { tokenTask = null; });
    return tokenTask;
  }
  function enqueue(key, request, reason) {
    const prior = state.jobs[key];
    return state.jobs[key] = { ...prior, request: clone(request), calculationVersion,
      generation: (prior?.generation || 0) + 1, sourceRevision: revisionFor(request.month), status: "queued",
      queueOrder: prior?.status === "queued" ? prior.queueOrder : ++state.sequence,
      queuedAt: timestamp(), startedAt: null, failedAt: null, errorCode: null, reason };
  }
  function invalidateState(months, reason) {
    if (months) for (const month of months) state.monthRevisions[month] = (state.monthRevisions[month] || 0) + 1;
    else state.revision++;
    state.optionsRevision++;
    onInvalidate(months);
    for (const [key, job] of Object.entries(state.jobs)) {
      if (job.status !== "obsolete" && job.calculationVersion === calculationVersion && (!months || months.includes(job.request.month))) enqueue(key, job.request, reason);
    }
  }
  async function invalidate({ months, reason = "source_changed" } = {}) {
    if (months !== undefined && (!Array.isArray(months) || months.some(month => !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)))) throw fault("INVALID_INDUSTRY_MONTHS");
    await init();
    await locked(async () => {
      invalidateState(months === undefined ? null : [...new Set(months)], String(reason).slice(0, 120));
      try { await saveState(); } catch (error) { storeError = safeCode(error); throw error; }
    });
    if (autoStart) scheduleKick();
    return status();
  }
  async function notifySourceChanged({ reason = "source_changed" } = {}) {
    if (!readSourceRevision) return invalidate({ reason });
    await init();
    await locked(async () => {
      // The writer records a durable pending check instead of invalidating
      // every historical month. Consecutive writes share the quiet-time scan.
      state.sourceCheckPending = true;
      state.sourceEventSequence = (state.sourceEventSequence || 0) + 1;
      state.optionsRevision++;
      state.lastSourceEvent = { reason: String(reason).slice(0, 120), at: timestamp() };
      onInvalidate([]);
      try { await saveState(); } catch (error) { storeError = safeCode(error); throw error; }
    });
    if (autoStart) scheduleKick();
    return status();
  }
  async function readResult(key, request) {
    const stored = await readJson(resultFile(key));
    if (stored && (stored.schemaVersion !== SCHEMA_VERSION || stored.calculationVersion !== calculationVersion
      || keyFor(stored.request || {}) !== key || !stored.result || !stored.result.summary || Array.isArray(stored.result.summary)
      || typeof stored.result.summary !== "object" || keyFor(stored.result.request || {}) !== key)) throw fault("INDUSTRY_RESULT_INVALID");
    return stored;
  }
  async function get(request, { rebuild = false } = {}) {
    await bootstrap();
    await checkSource();
    const response = await locked(async () => {
      const key = keyFor(request), revision = revisionFor(request.month);
      let saved = null, resultError = null;
      try { saved = await readResult(key, request); } catch (error) { resultError = safeCode(error); }
      if (storeError && rebuild) {
        try {
          // An explicit retry probes writable state before restarting work.
          // No calculation remains active after the worker's fatal I/O exit.
          await saveState();
          for (const value of Object.values(state.jobs)) if (value.status === "processing") value.status = "queued";
          await saveState(); storeError = null;
        } catch (error) { storeError = safeCode(error); }
      }
      let job = state.jobs[key];
      const current = saved?.sourceRevision === revision;
      const today = new Date(new Date(now()).getTime() + 9 * 3600000).toISOString().slice(0, 10);
      const [year, month] = request.month.split("-").map(Number);
      const monthEnd = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
      const calendarChanged = saved && saved.result.period?.monthClosed !== (today > monthEnd);
      if (!storeError && (!resultError || rebuild) && (!current || calendarChanged || rebuild) && !["queued", "processing", ...(rebuild ? [] : ["failed"])].includes(job?.status)) {
        if (rebuild) onInvalidate([request.month]);
        job = enqueue(key, request, rebuild ? "manual_rebuild" : "read_cache_miss");
        try { await saveState(); } catch (error) { storeError = safeCode(error); }
      }
      const jobStatus = job?.status;
      const active = ["queued", "processing"].includes(jobStatus);
      const status = storeError || (resultError && !active) ? "failed" : state.sourceCheckPending ? "queued"
        : ["queued", "processing", "failed"].includes(jobStatus) ? jobStatus : saved ? "ready" : "queued";
      return { ...(saved ? saved.result : {}), request: clone(request), storage: {
        status, hasSnapshot: Boolean(saved), stale: Boolean(saved && (!current || status !== "ready")),
        calculatedAt: saved?.calculatedAt || null, sourceRevision: revision, resultRevision: saved?.sourceRevision || null,
        calculationVersion, cutoffDate: request.cutoffDate, queuedAt: job?.queuedAt || null,
        monthClosed: today > monthEnd, reusePolicy: today > monthEnd ? "closed_month" : "live_month",
        sourceCheckPending: Boolean(state.sourceCheckPending),
        startedAt: job?.startedAt || null, failedAt: job?.failedAt || null, errorCode: storeError || (!active && resultError) || job?.errorCode || null
      } };
    });
    if (autoStart) kick();
    return response;
  }
  async function runQueue() {
    while (!stopped && !settleTimer) {
      await checkSource();
      if (storeError) return;
      if (state.sourceCheckPending) return;
      const job = await locked(async () => {
        const next = Object.entries(state.jobs).filter(([, item]) => item.status === "queued" && item.calculationVersion === calculationVersion)
          .sort((a, b) => a[1].queueOrder - b[1].queueOrder)[0];
        if (!next) return null;
        const [key, value] = next; value.status = "processing"; value.startedAt = timestamp();
        await saveState(); return { key, ...clone(value) };
      });
      if (!job) return;
      try {
        const result = await calculate(clone(job.request));
        if (!result || !result.summary || keyFor(result.request || {}) !== job.key) throw fault("INDUSTRY_RESULT_INVALID");
        // A source write during calculation is checked before publication;
        // generation guards discard only the affected month's old result.
        await checkSource();
        if (storeError) throw fault(storeError);
        await locked(async () => {
          const current = state.jobs[job.key];
          if (current?.generation !== job.generation || revisionFor(job.request.month) !== job.sourceRevision) return;
          if (state.sourceCheckPending) { enqueue(job.key, job.request, "source_changed_during_calculation"); await saveState(); return; }
          if (result.period?.monthClosed) {
            let previous;
            try { previous = await readResult(job.key, job.request); } catch { /* Invalid derived files are replaced only by a successful calculation. */ }
            if (previous && previous.sourceRevision !== job.sourceRevision) {
              const revisionKey = crypto.createHash("sha256").update(JSON.stringify([previous.sourceRevision, previous.calculatedAt])).digest("hex");
              await writeJson(path.join(directory, "revisions", job.key, `${revisionKey}.json`), previous);
            }
          }
          await writeJson(resultFile(job.key), { schemaVersion: SCHEMA_VERSION, calculationVersion, request: job.request,
            sourceRevision: job.sourceRevision, calculatedAt: timestamp(), recalculationReason: job.reason, result });
          Object.assign(current, { status: "ready", finishedAt: timestamp(), errorCode: null }); await saveState();
        });
      } catch (error) {
        await locked(async () => {
          const current = state.jobs[job.key];
          if (current?.generation !== job.generation) return;
          Object.assign(current, { status: "failed", failedAt: timestamp(), errorCode: safeCode(error) }); await saveState();
        });
      }
    }
  }
  function kick() {
    if (worker || stopped || storeError || settleTimer) return;
    worker = runQueue().catch(error => { storeError = safeCode(error); }).finally(() => {
      worker = null;
      if (state.sourceCheckPending) { if (!stopped && !storeError && autoStart) scheduleKick(); return; }
      if (!stopped && !storeError && Object.values(state.jobs).some(job => job.status === "queued" && job.calculationVersion === calculationVersion)) kick();
    });
  }
  function scheduleKick() {
    if (settleTimer) clearTimeout(settleTimer);
    settleTimer = setTimeout(() => { settleTimer = null; kick(); }, 1500);
    settleTimer.unref();
  }
  async function status() {
    await init();
    return { active: Boolean(worker), sourceCheckPending: Boolean(state.sourceCheckPending), errorCode: storeError, counts: Object.values(state.jobs).reduce((out, job) => {
      out[job.status] = (out[job.status] || 0) + 1; return out;
    }, {}) };
  }
  async function drain() {
    await bootstrap();
    if (settleTimer) { clearTimeout(settleTimer); settleTimer = null; }
    do {
      if (settleTimer) { clearTimeout(settleTimer); settleTimer = null; }
      kick(); if (worker) await worker; await serial;
    }
    while (!stopped && !storeError && !state.sourceCheckPending && (worker || Object.values(state.jobs).some(job => job.status === "queued" && job.calculationVersion === calculationVersion)));
    return status();
  }
  async function stop() { stopped = true; if (settleTimer) { clearTimeout(settleTimer); settleTimer = null; } if (worker) await worker; await serial; }
  async function readOptions() {
    await bootstrap(); await checkSource();
    try {
      const saved = await readJson(path.join(directory, "options.json"));
      return saved && typeof saved.revision === "string" && saved.revision.startsWith(`${state.epoch || "initial"}:`) && Array.isArray(saved.value?.industries)
        && Array.isArray(saved.value?.regions) && Array.isArray(saved.value?.months) ? saved : null;
    } catch { return null; } // Selector metadata is a disposable cache, not a normal analytical result.
  }
  async function optionsRevision() { await bootstrap(); return optionsToken(); }
  async function writeOptions(value, revision) {
    await bootstrap();
    return locked(async () => {
      if (revision !== optionsToken()) return false;
      await writeJson(path.join(directory, "options.json"), { revision, calculatedAt: timestamp(), value }); return true;
    });
  }
  return { bootstrap, get, rebuild: request => get(request, { rebuild: true }), invalidate, notifySourceChanged, status, drain, stop, readOptions, writeOptions, optionsRevision };
}
module.exports = { createIndustryAnalysisStore, INDUSTRY_ANALYSIS_CALCULATION_VERSION: CALCULATION_VERSION };
