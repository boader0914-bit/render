"use strict";

// This queue processes an already-published run. It never starts a collector.
// One server process owns the queue; processRun must publish its derived results
// atomically and be idempotent because a crash can precede the completion receipt.
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { monitorPostprocessItem } = require("./collection_monitor.cjs");
const VERSION = 1;
const SOURCE_MANIFEST_SHA = /^[a-f0-9]{64}$/;
const STATES = new Set(["held", "queued", "running", "complete", "failed"]);
const TERMINAL = new Set(["complete", "failed"]);
const MAX_CONTEXT_BYTES = 64 * 1024;
const MAX_RECORD_BYTES = MAX_CONTEXT_BYTES + 16 * 1024;
const MAX_STATE_BYTES = 2 * 1024 * 1024;
const clone = value => JSON.parse(JSON.stringify(value));
const fault = code => Object.assign(new Error(code), { code, statusCode: 503 });
const safeCode = error => /^[A-Z][A-Z0-9_]{1,99}$/.test(error?.code || "") ? error.code : "COLLECTION_POSTPROCESS_FAILED";
const validTime = value => typeof value === "string" && Number.isFinite(Date.parse(value));
const validRunId = value => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,239}$/.test(value);
const digest = value => crypto.createHash("sha256").update(value).digest("hex");
function bounded(value, fallback, min, max) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new TypeError("Invalid postprocess queue option");
  return value;
}
function contextCopy(value = {}) {
  const visiting = new Set();
  let nodes = 0;
  function inspect(item, depth) {
    if (++nodes > 20000 || depth > 12) throw fault("COLLECTION_POSTPROCESS_CONTEXT_INVALID");
    if (typeof item === "string" && item.length > MAX_CONTEXT_BYTES) throw fault("COLLECTION_POSTPROCESS_CONTEXT_TOO_LARGE");
    if (item === null || typeof item === "boolean" || typeof item === "string") return;
    if (typeof item === "number" && Number.isFinite(item)) return;
    if (!item || typeof item !== "object" || visiting.has(item)
      || !Array.isArray(item) && ![Object.prototype, null].includes(Object.getPrototypeOf(item))) throw fault("COLLECTION_POSTPROCESS_CONTEXT_INVALID");
    visiting.add(item);
    for (const [key, child] of Object.entries(item)) {
      if (["__proto__", "prototype", "constructor"].includes(key)
        || /(?:password|passwd|secret|authorization|cookie|credential|api[_-]?key|token$)/i.test(key)) {
        throw fault("COLLECTION_POSTPROCESS_CONTEXT_SECRET");
      }
      inspect(child, depth + 1);
    }
    visiting.delete(item);
  }
  inspect(value, 0);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw fault("COLLECTION_POSTPROCESS_CONTEXT_INVALID");
  const bytes = JSON.stringify(value);
  if (Buffer.byteLength(bytes) > MAX_CONTEXT_BYTES) throw fault("COLLECTION_POSTPROCESS_CONTEXT_TOO_LARGE");
  return JSON.parse(bytes);
}
function publicRow(job) {
  if (!job) return null;
  const { runId, status, reason, sequence, attempts, maxAttempts, createdAt, updatedAt, releasedAt, startedAt, finishedAt,
    nextAttemptAt, recoveredAt, lastErrorCode, admissionErrorCode, admissionDeferrals, timings, lastSuccess, result } = job;
  return { runId, state: status, status, reason, sequence, attempts, maxAttempts, createdAt, updatedAt, releasedAt, startedAt, finishedAt,
    nextAttemptAt, recoveredAt, lastErrorCode, admissionErrorCode, admissionDeferrals,
    scheduleOccurrenceId: job.scheduleOccurrenceId ?? job.context?.scheduleOccurrenceId ?? null,
    timings: timings ? clone(timings) : null, lastSuccess: lastSuccess ? clone(lastSuccess) : null,
    result: result ? clone(result) : null };
}

function createCollectionPostprocessQueue(options = {}) {
  const { dataDir, processRun, canProcess = async () => true, now = () => new Date(),
    setTimeoutImpl = setTimeout, clearTimeoutImpl = clearTimeout, fileSystem = fs } = options;
  if (!dataDir || typeof processRun !== "function" || typeof canProcess !== "function") throw new TypeError("dataDir, processRun and canProcess are required");
  const maxAttempts = bounded(options.maxAttempts, 3, 1, 10);
  const retryBaseMs = bounded(options.retryBaseMs, 30000, 1, 3600000);
  const retryMaxMs = bounded(options.retryMaxMs, 300000, retryBaseMs, 86400000);
  const idleIntervalMs = bounded(options.idleIntervalMs, 2000, 1, 60000);
  const maxRetained = bounded(options.maxRetained, 128, 0, 1024);
  const maxPending = bounded(options.maxPending, 256, 1, 1024);
  const directory = path.resolve(dataDir, "collection_postprocess"), records = path.join(directory, "runs"),
    pendingDirectory = path.join(directory, "pending"), stateFile = path.join(directory, "queue.json");
  let state = { version: VERSION, sequence: 0, jobs: {} }, initPromise, initialized = false, serial = Promise.resolve(), workerPromise = null;
  let timer = null, started = false, closed = false, storeError = null, activeRunId = null, controller = null;
  const timestamp = () => {
    const result = new Date(now());
    if (!Number.isFinite(result.getTime())) throw fault("COLLECTION_POSTPROCESS_CLOCK_INVALID");
    return result.toISOString();
  };
  const locked = action => { const result = serial.then(action); serial = result.catch(() => {}); return result; };
  const fileFor = runId => path.join(records, digest(runId) + ".json");
  const pendingFor = runId => path.join(pendingDirectory, digest(runId) + ".json");
  const assertHealthy = () => { if (storeError) throw fault(storeError); };
  async function atomicJson(filename, value) {
    const temporary = filename + "." + crypto.randomUUID() + ".tmp";
    let handle;
    try {
      await fileSystem.mkdir(path.dirname(filename), { recursive: true });
      handle = await fileSystem.open(temporary, "wx", 0o600);
      await handle.writeFile(JSON.stringify(value)); await handle.sync(); await handle.close(); handle = null;
      await fileSystem.rename(temporary, filename);
      try {
        handle = await fileSystem.open(path.dirname(filename), "r");
        await handle.sync(); await handle.close(); handle = null;
      } catch (error) {
        if (process.platform !== "win32" || !["EISDIR", "EPERM", "EACCES", "EINVAL"].includes(error.code)) throw error;
        if (handle) await handle.close().catch(() => {}); handle = null;
      }
    } catch { throw fault("COLLECTION_POSTPROCESS_STORE_WRITE_FAILED"); }
    finally {
      if (handle) await handle.close().catch(() => {});
      await fileSystem.unlink(temporary).catch(() => {});
    }
  }
  async function readJson(filename, limit) {
    try {
      const before = await fileSystem.lstat(filename, { bigint: true });
      if (!before.isFile() || before.isSymbolicLink() || before.size > BigInt(limit)) throw fault("COLLECTION_POSTPROCESS_STATE_INVALID");
      const bytes = await fileSystem.readFile(filename);
      const after = await fileSystem.lstat(filename, { bigint: true });
      if (!["size", "mtimeNs", "ctimeNs", "ino", "dev"].every(key => before[key] === after[key])) throw fault("COLLECTION_POSTPROCESS_STATE_CHANGED");
      return JSON.parse(bytes);
    } catch (error) {
      if (error.code === "ENOENT") return null;
      if (/^COLLECTION_POSTPROCESS_/.test(error.code || "")) throw error;
      throw fault("COLLECTION_POSTPROCESS_STATE_INVALID");
    }
  }
  function validateRecord(job, runId) {
    if (!job) return null;
    if (job.version !== VERSION || job.runId !== runId || !STATES.has(job.status)
      || !Number.isSafeInteger(job.sequence) || job.sequence < 1 || !Number.isSafeInteger(job.attempts) || job.attempts < 0
      || !Number.isSafeInteger(job.maxAttempts) || job.maxAttempts < 1 || job.maxAttempts > 10 || job.attempts > job.maxAttempts
      || !validTime(job.createdAt) || !validTime(job.updatedAt)
      || job.nextAttemptAt !== null && !validTime(job.nextAttemptAt)) throw fault("COLLECTION_POSTPROCESS_STATE_INVALID");
    // Forward-only optional linkage. Legacy terminal records have no source
    // hash and must retain their original bytes/shape; never infer one later.
    if (job.result && Object.hasOwn(job.result, "sourceManifestSha256") && (typeof job.result.sourceManifestSha256 !== "string" || !SOURCE_MANIFEST_SHA.test(job.result.sourceManifestSha256))) throw fault("COLLECTION_POSTPROCESS_STATE_INVALID");
    if (!TERMINAL.has(job.status)) job.context = contextCopy(job.context);
    return job;
  }
  async function readRecord(runId) {
    const record = validateRecord(await readJson(fileFor(runId), MAX_RECORD_BYTES), runId);
    if (record && TERMINAL.has(record.status)) return record;
    // Nonterminal journal publication precedes the ordinary record/index.
    return validateRecord(await readJson(pendingFor(runId), MAX_RECORD_BYTES), runId) || record;
  }
  async function pendingRunIds() {
    let entries;
    try { entries = await fileSystem.opendir(pendingDirectory); }
    catch (error) { if (error.code === "ENOENT") return []; throw error; }
    const ids = [];
    for await (const entry of entries) {
      if (entry.name.endsWith(".tmp")) continue;
      if (!entry.isFile() || !/^[a-f0-9]{64}\.json$/.test(entry.name) || ids.length >= 2048) throw fault("COLLECTION_POSTPROCESS_STATE_INVALID");
      const row = await readJson(path.join(pendingDirectory, entry.name), MAX_RECORD_BYTES);
      if (!row || !validRunId(row.runId) || entry.name !== digest(row.runId) + ".json") throw fault("COLLECTION_POSTPROCESS_STATE_INVALID");
      validateRecord(row, row.runId); ids.push(row.runId);
    }
    return ids;
  }
  function indexed(nextState, job) {
    const jobs = { ...nextState.jobs, [job.runId]: publicRow(job) };
    const terminal = Object.values(jobs).filter(item => TERMINAL.has(item.status))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.sequence - a.sequence);
    for (const item of terminal.slice(maxRetained)) delete jobs[item.runId];
    const result = { version: VERSION, sequence: Math.max(nextState.sequence, job.sequence), jobs };
    // Result summaries may differ in size. Count retention alone must never
    // produce an index larger than the bounded reader can reopen after restart.
    for (const item of terminal.slice(0, maxRetained).reverse()) {
      if (Buffer.byteLength(JSON.stringify(result)) <= MAX_STATE_BYTES) break;
      delete jobs[item.runId];
    }
    if (Buffer.byteLength(JSON.stringify(result)) > MAX_STATE_BYTES) throw fault("COLLECTION_POSTPROCESS_QUEUE_FULL");
    return result;
  }
  async function commit(job) {
    assertHealthy();
    try {
      const nextState = indexed(state, job);
      if (!TERMINAL.has(job.status)) await atomicJson(pendingFor(job.runId), job);
      await atomicJson(fileFor(job.runId), job);
      await atomicJson(stateFile, nextState);
      state = nextState;
      if (TERMINAL.has(job.status)) await fileSystem.unlink(pendingFor(job.runId)).catch(error => { if (error.code !== "ENOENT") throw error; });
    } catch (error) { storeError = safeCode(error); throw error; }
    return publicRow(job);
  }
  async function initialize() {
    if (!initPromise) initPromise = (async () => {
      try {
        const stored = await readJson(stateFile, MAX_STATE_BYTES) || { version: VERSION, sequence: 0, jobs: {} };
        if (stored.version !== VERSION || !Number.isSafeInteger(stored.sequence) || stored.sequence < 0
          || !stored.jobs || typeof stored.jobs !== "object" || Array.isArray(stored.jobs)
          || Object.keys(stored.jobs).length > 2048) throw fault("COLLECTION_POSTPROCESS_STATE_INVALID");
        state = { version: VERSION, sequence: stored.sequence, jobs: {} };
        const spoolIds = await pendingRunIds(), discardSpool = [];
        let changed = spoolIds.some(runId => !Object.hasOwn(stored.jobs, runId));
        for (const runId of new Set([...Object.keys(stored.jobs), ...spoolIds])) {
          if (!validRunId(runId)) throw fault("COLLECTION_POSTPROCESS_STATE_INVALID");
          let job = await readRecord(runId);
          if (!job) throw fault("COLLECTION_POSTPROCESS_STATE_INVALID");
          if (job.status === "running") {
            const stamp = timestamp(), exhausted = job.attempts >= job.maxAttempts;
            job = { ...job, status: exhausted ? "failed" : "queued", updatedAt: stamp, recoveredAt: stamp,
              nextAttemptAt: exhausted ? null : stamp, finishedAt: exhausted ? stamp : null,
              lastErrorCode: exhausted ? "COLLECTION_POSTPROCESS_INTERRUPTED_EXHAUSTED" : "COLLECTION_POSTPROCESS_INTERRUPTED" };
            if (exhausted) delete job.context;
            await atomicJson(fileFor(runId), job); changed = true;
          }
          if (TERMINAL.has(job.status)) discardSpool.push(runId);
          else {
            // This spool is the discoverable journal if queue.json was never
            // published. Old index-only records are upgraded without processing.
            await atomicJson(pendingFor(runId), job);
            if (!await readJson(fileFor(runId), MAX_RECORD_BYTES)) await atomicJson(fileFor(runId), job);
          }
          state = indexed(state, job);
          if (JSON.stringify(stored.jobs[runId]) !== JSON.stringify(publicRow(job))) changed = true;
        }
        if (changed || Object.keys(state.jobs).length !== Object.keys(stored.jobs).length) await atomicJson(stateFile, state);
        for (const runId of discardSpool) await fileSystem.unlink(pendingFor(runId)).catch(error => { if (error.code !== "ENOENT") throw error; });
        initialized = true;
      } catch (error) { storeError = safeCode(error); throw error; }
    })();
    return initPromise;
  }
  async function enqueue(runId, { deferred = false, context = {}, reason = "collection_saved" } = {}) {
    if (!validRunId(runId) || typeof deferred !== "boolean" || typeof reason !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(reason)) throw fault("COLLECTION_POSTPROCESS_INPUT_INVALID");
    const safeContext = contextCopy(context);
    return locked(async () => {
      await initialize(); assertHealthy();
      if (closed) throw fault("COLLECTION_POSTPROCESS_CLOSED");
      const existing = await readRecord(runId);
      if (existing) {
        // Per-run receipts remain on disk even when the recent index is pruned.
        if (!Object.hasOwn(state.jobs, runId) && !TERMINAL.has(existing.status)) await commit(existing);
        return publicRow(existing);
      }
      if (Object.values(state.jobs).filter(item => !TERMINAL.has(item.status)).length >= maxPending) throw fault("COLLECTION_POSTPROCESS_QUEUE_FULL");
      const stamp = timestamp();
      return commit({ version: VERSION, runId, status: deferred ? "held" : "queued", reason, context: safeContext,
        scheduleOccurrenceId: typeof safeContext.scheduleOccurrenceId === "string" ? safeContext.scheduleOccurrenceId : null,
        sequence: state.sequence + 1, attempts: 0, maxAttempts, createdAt: stamp, updatedAt: stamp,
        releasedAt: deferred ? null : stamp, startedAt: null, finishedAt: null, nextAttemptAt: deferred ? null : stamp,
        recoveredAt: null, lastErrorCode: null, admissionErrorCode: null, admissionDeferrals: 0, timings: null, lastSuccess: null });
    });
  }
  async function release(runId) {
    if (!validRunId(runId)) throw fault("COLLECTION_POSTPROCESS_INPUT_INVALID");
    return locked(async () => {
      await initialize(); assertHealthy();
      if (closed) throw fault("COLLECTION_POSTPROCESS_CLOSED");
      const job = await readRecord(runId);
      if (!job) throw fault("COLLECTION_POSTPROCESS_NOT_FOUND");
      if (job.status !== "held") return publicRow(job);
      const stamp = timestamp();
      return commit({ ...job, status: "queued", releasedAt: stamp, updatedAt: stamp, nextAttemptAt: stamp });
    });
  }
  async function doRunOnce() {
    await initialize(); assertHealthy();
    if (closed) return null;
    const candidate = await locked(async () => {
      const stamp = timestamp();
      const next = Object.values(state.jobs).filter(job => job.status === "queued" && job.nextAttemptAt <= stamp)
        .sort((a, b) => a.sequence - b.sequence)[0];
      return next ? readRecord(next.runId) : null;
    });
    if (!candidate) return null;
    let allowed = false, admissionErrorCode = null;
    try { allowed = await canProcess(candidate.runId, publicRow(candidate)); }
    catch (error) { admissionErrorCode = safeCode(error); }
    if (closed) return null;
    if (allowed !== true) return locked(async () => {
      const stamp = timestamp();
      return commit({ ...candidate, updatedAt: stamp, nextAttemptAt: new Date(Date.parse(stamp) + idleIntervalMs).toISOString(),
        admissionErrorCode, admissionDeferrals: candidate.admissionDeferrals + 1 });
    });
    const job = await locked(async () => {
      if (closed) return null;
      const stamp = timestamp();
      const next = { ...candidate, status: "running", attempts: candidate.attempts + 1, updatedAt: stamp, startedAt: stamp,
        finishedAt: null, nextAttemptAt: null, admissionErrorCode: null };
      await commit(next); return next;
    });
    if (!job) return null;
    activeRunId = job.runId; controller = new AbortController();
    const start = performance.now();
    try {
      const processed = await processRun(job.runId, { ...clone(job.context), attempt: job.attempts, signal: controller.signal });
      if (processed && Object.hasOwn(processed, "sourceManifestSha256") && (typeof processed.sourceManifestSha256 !== "string" || !SOURCE_MANIFEST_SHA.test(processed.sourceManifestSha256))) {
        throw Object.assign(fault("COLLECTION_POSTPROCESS_SOURCE_MANIFEST_SHA_INVALID"), { retryable: false });
      }
      const result = contextCopy(Object.fromEntries(["stages", "elapsedMs", "appended", "sourceManifestSha256"]
        .filter(key => processed && processed[key] !== undefined).map(key => [key, processed[key]])));
      if (Buffer.byteLength(JSON.stringify(result)) > 8 * 1024) throw Object.assign(fault("COLLECTION_POSTPROCESS_RESULT_TOO_LARGE"), { retryable: false });
      const stamp = timestamp(), durationMs = Math.max(0, performance.now() - start);
      const next = { ...job, status: "complete", updatedAt: stamp, finishedAt: stamp, nextAttemptAt: null, lastErrorCode: null,
        result,
        timings: { queueMs: Math.max(0, Date.parse(job.startedAt) - Date.parse(job.releasedAt)), durationMs,
          totalMs: Math.max(0, Date.parse(stamp) - Date.parse(job.createdAt)) },
        lastSuccess: { finishedAt: stamp, durationMs, attempt: job.attempts } };
      delete next.context;
      return await locked(() => commit(next));
    } catch (error) {
      // A receipt-write failure must not be converted into a normal retry result.
      if (storeError) throw error;
      const stamp = timestamp(), retry = error?.retryable !== false && job.attempts < job.maxAttempts;
      const retryMs = Math.min(retryMaxMs, retryBaseMs * 2 ** (job.attempts - 1));
      const next = { ...job, status: retry ? "queued" : "failed", updatedAt: stamp, finishedAt: retry ? null : stamp,
        nextAttemptAt: retry ? new Date(Date.parse(stamp) + retryMs).toISOString() : null, lastErrorCode: safeCode(error),
        timings: { queueMs: Math.max(0, Date.parse(job.startedAt) - Date.parse(job.releasedAt)),
          durationMs: Math.max(0, performance.now() - start), totalMs: Math.max(0, Date.parse(stamp) - Date.parse(job.createdAt)) } };
      if (!retry) delete next.context;
      return await locked(() => commit(next));
    } finally { activeRunId = null; controller = null; }
  }
  function runOnce() {
    if (workerPromise) return workerPromise;
    workerPromise = doRunOnce().finally(() => { workerPromise = null; });
    return workerPromise;
  }
  function schedule(delay = idleIntervalMs) {
    if (!started || closed || timer || storeError) return;
    timer = setTimeoutImpl(() => {
      timer = null;
      runOnce().catch(error => { storeError ||= safeCode(error); }).finally(() => schedule());
    }, delay);
    timer?.unref?.();
  }
  async function get(runId) {
    if (!validRunId(runId)) throw fault("COLLECTION_POSTPROCESS_INPUT_INVALID");
    await initialize(); return publicRow(Object.hasOwn(state.jobs, runId) ? state.jobs[runId] : await readRecord(runId));
  }
  async function status({ runId, limit = 50 } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 0 || limit > 2048 || runId !== undefined && !validRunId(runId)) throw fault("COLLECTION_POSTPROCESS_INPUT_INVALID");
    await initialize();
    if (runId !== undefined) return get(runId);
    const jobs = Object.values(state.jobs);
    return { version: VERSION, active: Boolean(activeRunId), activeRunId, started, closed, errorCode: storeError,
      counts: jobs.reduce((result, job) => { result[job.status] = (result[job.status] || 0) + 1; return result; }, {}),
      items: jobs.sort((a, b) => b.sequence - a.sequence).slice(0, limit).map(publicRow) };
  }
  async function held() {
    await initialize();
    return Object.values(state.jobs).filter(job => job.status === "held")
      .sort((a, b) => a.sequence - b.sequence).map(publicRow);
  }
  function peekMonitor({ runIds = [] } = {}) {
    if (!Array.isArray(runIds) || runIds.length > 700 || runIds.some(runId => !validRunId(runId))) throw fault("COLLECTION_MONITOR_RUN_IDS_INVALID");
    const unique = [...new Set(runIds)];
    // Memory only. A diagnostic read must not recover a journal or start work.
    if (!initialized || storeError || closed) return { available: false, source: "memory", items: [], missingRunIds: unique,
      errorCode: storeError || (closed ? "COLLECTION_MONITOR_POSTPROCESS_CLOSED" : "COLLECTION_MONITOR_POSTPROCESS_NOT_INITIALIZED") };
    const items = unique.filter(runId => Object.hasOwn(state.jobs, runId)).map(runId => monitorPostprocessItem(state.jobs[runId]));
    return { available: true, source: "memory", items, missingRunIds: unique.filter(runId => !Object.hasOwn(state.jobs, runId)), errorCode: null };
  }
  async function start() { await initialize(); assertHealthy(); if (closed) throw fault("COLLECTION_POSTPROCESS_CLOSED"); started = true; schedule(0); return status(); }
  async function close() {
    closed = true; started = false;
    if (timer) clearTimeoutImpl(timer); timer = null;
    controller?.abort();
    if (workerPromise) await workerPromise.catch(() => {});
    await serial;
  }
  return { enqueue, release, runOnce, start, close, get, status, peekMonitor, held, stateFile };
}

module.exports = { createCollectionPostprocessQueue };
