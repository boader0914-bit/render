"use strict";

// Side-effect-free menu reads. Keep this adapter outside the calculator/store
// fingerprint: it never changes a result key, arithmetic, queue or source proof.
const path = require("node:path");
const crypto = require("node:crypto");
const { readBundleFile } = require("./keyword_monthly_bundle.cjs");
const { boundedJsonBuffer } = require("./bounded_company_response.cjs");
const { runKeywordMonthlyMemoryAdmission } = require("./keyword_monthly_memory_admission.cjs");
const LIMIT = 2 * 1024 * 1024;
const fault = code => Object.assign(new Error(code), { code, statusCode: 503 });
const safeCode = error => /^[A-Z0-9_:-]{1,100}$/i.test(String(error?.code || "")) ? error.code : "INDUSTRY_STORE_UNAVAILABLE";
const clone = value => structuredClone(value);
async function readBounded(file, checkMemory) {
  try {
    await checkMemory();
    // The shared strict reader rejects ancestor links, file symlinks/hardlinks,
    // path swaps, opened/path identity changes, growth and oversized reads.
    const read = await readBundleFile(file, LIMIT);
    await checkMemory();
    return { value: JSON.parse(read.bytes.toString("utf8")), identity: read.sha256 };
  } catch (error) {
    if (error.code === "ENOENT") return null;
    if (/^KEYWORD_MONTHLY_MEMORY_/.test(error.code || "")) throw error;
    if (error.code === "KEYWORD_MONTHLY_BUNDLE_SIZE_LIMIT") throw fault("INDUSTRY_SAVED_DETAIL_REQUIRED");
    throw /^INDUSTRY_/.test(error.code || "") ? error : fault("INDUSTRY_STORE_UNAVAILABLE");
  }
}
function createIndustryAnalysisSavedReader({ dataDir, calculationVersion = "industry-analysis-v1", now = () => new Date(),
  normalizeStoredRequest = request => request, needsResultRefresh = () => false, runMemoryAdmission = runKeywordMonthlyMemoryAdmission }) {
  if (!dataDir || typeof normalizeStoredRequest !== "function" || typeof needsResultRefresh !== "function" || typeof runMemoryAdmission !== "function") throw new TypeError("Invalid saved industry reader");
  const directory = path.resolve(dataDir, "industry_analysis"), stateFile = path.join(directory, "queue.json"), versions = new Map();
  const keyFor = request => crypto.createHash("sha256").update(JSON.stringify([calculationVersion, request.month, request.cutoffDate, request.industry, request.region])).digest("hex");
  const timestamp = () => new Date(now()).toISOString();
  const checkMemory = () => runMemoryAdmission(async () => undefined);
  let activeRead = null;
  function memoryFailure(error) { return /^KEYWORD_MONTHLY_MEMORY_/.test(error?.code || ""); }
  function boundedResult(value) {
    try { boundedJsonBuffer(value, LIMIT); return value; }
    catch (error) { if (error.code === "COMPANY_RESPONSE_TOO_LARGE") throw fault("INDUSTRY_SAVED_DETAIL_REQUIRED"); throw error; }
  }
  function inLane(key, operation) {
    if (activeRead) return activeRead.key === key ? activeRead.task : Promise.reject(fault("INDUSTRY_SAVED_READ_BUSY"));
    const entry = { key, task: null }; activeRead = entry;
    entry.task = Promise.resolve().then(() => runMemoryAdmission(async () => {
      const value = await operation(); await checkMemory();
      try { return boundedResult(value); }
      catch (error) {
        if (error.code !== "INDUSTRY_SAVED_DETAIL_REQUIRED") throw error;
        return { ...(Object.hasOwn(value, "value") ? { value: null } : { request: value.request }),
          storage: { status: "detail_required", hasSnapshot: false, stale: false, calculationVersion,
            sourceVerification: "not_checked", sourceRevisionMatches: null, readOnly: true, checkedAt: timestamp(), errorCode: error.code } };
      }
    }))
      .finally(() => { if (activeRead === entry) activeRead = null; });
    return entry.task;
  }
  function validateQueue(queue) {
    if (queue && (queue.schemaVersion !== 1 || !queue.jobs || Array.isArray(queue.jobs) || typeof queue.jobs !== "object"
      || !Number.isSafeInteger(queue.revision) || !Number.isSafeInteger(queue.optionsRevision)
      || !queue.monthRevisions || typeof queue.monthRevisions !== "object" || Array.isArray(queue.monthRevisions)
      || typeof queue.epoch !== "string" || !queue.epoch || queue.epoch.length > 128 || /[\x00-\x1f]/.test(queue.epoch))) throw fault("INDUSTRY_STORE_INVALID");
    return queue;
  }
  async function queueRead() {
    const read = await readBounded(stateFile, checkMemory);
    if (read) validateQueue(read.value);
    return read;
  }
  function validRequest(request) {
    const fields = ["industry", "region", "month", "cutoffDate"];
    if (!request || fields.some(field => typeof request[field] !== "string" || !request[field]
      || request[field].length > (field === "region" ? 120 : 32) || /[\x00-\x1f]/.test(request[field]))) throw fault("INDUSTRY_REQUEST_INVALID");
    const normalized = normalizeStoredRequest(Object.fromEntries(fields.map(field => [field, request[field]])));
    if (!normalized || ["industry", "region", "month", "cutoffDate"].some(field => typeof normalized[field] !== "string" || !normalized[field] || normalized[field] !== request?.[field])
      || !/^\d{4}-(0[1-9]|1[0-2])$/.test(normalized.month) || !/^\d{4}-\d{2}-\d{2}$/.test(normalized.cutoffDate)) throw fault("INDUSTRY_REQUEST_INVALID");
    return normalized;
  }
  function validJob(key, job) {
    if (job && (job.calculationVersion !== calculationVersion || keyFor(job.request || {}) !== key
      || keyFor(validRequest(job.request)) !== key || !Number.isSafeInteger(job.generation)
      || !["queued", "processing", "ready", "failed"].includes(job.status))) throw fault("INDUSTRY_JOB_INVALID");
    return job;
  }
  async function readResult(key) {
    const read = await readBounded(path.join(directory, "results", `${key}.json`), checkMemory);
    if (!read) return null;
    const stored = read.value;
    if (!stored || typeof stored !== "object" || Array.isArray(stored) || stored.schemaVersion !== 1 || stored.calculationVersion !== calculationVersion
      || keyFor(stored.request || {}) !== key || keyFor(validRequest(stored.request)) !== key
      || !stored.result || !stored.result.summary || typeof stored.result.summary !== "object" || Array.isArray(stored.result.summary)
      || keyFor(stored.result.request || {}) !== key || keyFor(validRequest(stored.result.request)) !== key
      || typeof stored.sourceRevision !== "string" || !Number.isFinite(Date.parse(stored.calculatedAt))) throw fault("INDUSTRY_RESULT_INVALID");
    await checkMemory();
    const cached = versions.get(key), version = cached?.identity === read.identity ? cached.version
      : crypto.createHash("sha256").update(JSON.stringify([stored.schemaVersion, stored.calculationVersion, stored.request,
        stored.sourceRevision, stored.calculatedAt, stored.result])).digest("hex");
    versions.delete(key); versions.set(key, { identity: read.identity, version });
    while (versions.size > 128) versions.delete(versions.keys().next().value);
    return { stored, version };
  }
  async function readSavedOptionsCore() {
    const storage = { status: "pending", hasSnapshot: false, stale: false, calculatedAt: null, checkedAt: timestamp(),
      sourceVerification: "not_checked", sourceRevisionMatches: null, readOnly: true, errorCode: null };
    try {
      const before = await queueRead(), read = await readBounded(path.join(directory, "options.json"), checkMemory);
      if (!read) return { value: null, storage };
      const queue = before?.value, saved = read.value;
      if (!queue || typeof saved?.revision !== "string" || !saved.revision.startsWith(`${queue.epoch}:`)
        || !Number.isFinite(Date.parse(saved.calculatedAt)) || !Array.isArray(saved.value?.industries)
        || !Array.isArray(saved.value?.regions) || !Array.isArray(saved.value?.months)) throw fault("INDUSTRY_SAVED_OPTIONS_INVALID");
      const after = await queueRead();
      const stale = before.identity !== after?.identity || saved.revision !== `${queue.epoch}:${queue.optionsRevision}` || Boolean(queue.sourceCheckPending);
      return { value: clone(saved.value), storage: { ...storage, status: stale ? "stale" : "ready", hasSnapshot: true,
        stale, calculatedAt: saved.calculatedAt, revision: saved.revision } };
    } catch (error) { if (memoryFailure(error)) throw error; return { value: null, storage: { ...storage, status: error.code === "INDUSTRY_SAVED_DETAIL_REQUIRED" ? "detail_required" : "unavailable", errorCode: safeCode(error) } }; }
  }
  async function readSavedCore(request, { allowEarlierCutoff = false } = {}) {
    let normalized, key;
    const baseStorage = { hasSnapshot: false, stale: false, resultVersion: null, resultRevision: null, sourceRevision: null,
      calculationVersion, sourceVerification: "not_checked", sourceCheckedAt: null, sourceRevisionMatches: null, sourceTokenMatches: null,
      readOnly: true, checkedAt: timestamp() };
    try {
      normalized = validRequest(request); key = keyFor(normalized);
      const before = await queueRead(), queue = before?.value, requestedCutoffDate = normalized.cutoffDate;
      const requestedJob = validJob(key, queue?.jobs[key]);
      let job = requestedJob, saved = await readResult(key), fallback = false;
      if (!saved && allowEarlierCutoff && queue) {
        // Select once from bounded queue metadata, never scan original history
        // or every result file. Invalid/non-normal/future keys cannot be lenders.
        const candidate = Object.entries(queue.jobs).filter(([candidateKey, value]) => {
          try {
            const item = value?.request;
            return value?.status === "ready" && item && ["industry", "month", "region"].every(field => item[field] === normalized[field])
              && item.cutoffDate < requestedCutoffDate && Boolean(validJob(candidateKey, value));
          } catch { return false; }
        }).sort((a, b) => b[1].request.cutoffDate.localeCompare(a[1].request.cutoffDate))[0];
        if (candidate) {
          const older = await readResult(candidate[0]);
          if (older) { key = candidate[0]; job = candidate[1]; normalized = clone(job.request); saved = older; fallback = true; }
        }
      }
      if (saved && !queue) throw fault("INDUSTRY_RESULT_INVALID");
      const after = await queueRead(), stableQueue = before?.identity === after?.identity;
      const revision = queue ? `${queue.epoch}:${queue.revision}.${queue.monthRevisions[normalized.month] || 0}` : null;
      const today = new Date(new Date(now()).getTime() + 9 * 3600000).toISOString().slice(0, 10);
      const [year, month] = normalized.month.split("-").map(Number), monthClosed = today > new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
      const current = Boolean(saved && stableQueue && saved.stored.sourceRevision === revision && !queue.sourceCheckPending
        && !needsResultRefresh(saved.stored.result) && saved.stored.result.period?.monthClosed === monthClosed);
      const status = fallback ? ["queued", "processing", "failed"].includes(requestedJob?.status) ? requestedJob.status : "stale"
        : ["queued", "processing", "failed"].includes(job?.status) ? job.status : !saved ? "pending" : current ? "ready" : "stale";
      await checkMemory();
      return { ...(saved ? clone(saved.stored.result) : {}), request: clone(normalized), storage: { ...baseStorage, key, status, hasSnapshot: Boolean(saved),
        stale: Boolean(saved && (!current || status !== "ready")), calculatedAt: saved?.stored.calculatedAt || null, cutoffDate: normalized.cutoffDate,
        resultVersion: saved?.version || null, resultRevision: saved?.stored.sourceRevision || null, sourceRevision: revision,
        sourceCheckPending: Boolean(queue?.sourceCheckPending), monthClosed, reusePolicy: monthClosed ? "closed_month" : "live_month",
        queuedAt: job?.queuedAt || null, startedAt: job?.startedAt || null, failedAt: job?.failedAt || null, errorCode: job?.errorCode || null,
        fallback, requestedCutoffDate } };
    } catch (error) { if (memoryFailure(error)) throw error; return { request: clone(normalized || request || {}), storage: { ...baseStorage, key: key || null,
      status: error.code === "INDUSTRY_SAVED_DETAIL_REQUIRED" ? "detail_required" : "unavailable", cutoffDate: normalized?.cutoffDate || null, errorCode: safeCode(error) } }; }
  }
  return {
    readSavedOptions: () => inLane("catalogue", readSavedOptionsCore),
    readSaved(request, options = {}) {
      // Public callers provide four bounded scalar fields; never stringify an
      // arbitrary request graph merely to acquire the single read lane.
      let normalized;
      try { normalized = validRequest(request); } catch (error) { return Promise.reject(error); }
      return inLane(JSON.stringify([normalized, options.allowEarlierCutoff === true]), () => readSavedCore(normalized, options));
    }
  };
}
module.exports = { createIndustryAnalysisSavedReader };
