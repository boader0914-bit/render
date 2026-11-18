"use strict";

// Read-only web-host query, not a migration or a weaker replacement for index
// integrity. The caller retains its serialized source/index lifetime until the
// actual worker exit, then independently rechecks both saved inputs.
const path = require("node:path"), { Worker, isMainThread, parentPort, workerData } = require("node:worker_threads");
const { performance } = require("node:perf_hooks");
const KIND = "history-index-exact-months-v1";
const INVALID = "HISTORY_OBSERVATION_INDEX_INVALID", CHANGED = "HISTORY_OBSERVATION_INDEX_MONTHS_CHANGED";
const FAILED = "HISTORY_OBSERVATION_INDEX_MONTHS_WORKER_FAILED", TIMEOUT = "HISTORY_OBSERVATION_INDEX_MONTHS_TIMEOUT";
const SQL = "SELECT DISTINCT options_month AS month FROM physical_rows WHERE monthly_object=1 AND options_month IS NOT NULL ORDER BY options_month DESC";
const fault = code => Object.assign(new Error(code), { code, statusCode: 503 });
const signature = stat => `${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}:${stat.ino}:${stat.dev}`;
const valid = value => value && typeof value.indexFile === "string" && path.isAbsolute(value.indexFile) && path.resolve(value.indexFile) === value.indexFile
  && typeof value.expectedSignature === "string" && value.expectedSignature.length > 0 && value.expectedSignature.length < 300 && !/[\x00-\x1f\x7f]/.test(value.expectedSignature)
  && Number.isSafeInteger(value.busyTimeoutMs) && value.busyTimeoutMs >= 0 && value.busyTimeoutMs <= 5000;
function validMonths(values) {
  if (!Array.isArray(values) || values.length > 120000) return false;
  for (let index = 0; index < values.length; index++) {
    if (!Object.hasOwn(values, index) || typeof values[index] !== "string" || !/^\d{4}-(0[1-9]|1[0-2])$/.test(values[index])
      || index > 0 && values[index - 1] <= values[index]) return false;
  }
  return true;
}

function workerMain() {
  let db;
  try {
    if (workerData?.kind !== KIND || !valid(workerData)) throw fault(FAILED);
    const fs = require("node:fs"), { DatabaseSync } = require("node:sqlite");
    const checked = () => { const stat = fs.lstatSync(workerData.indexFile, { bigint: true });
      if (!stat.isFile() || stat.isSymbolicLink() || signature(stat) !== workerData.expectedSignature) throw fault(CHANGED); };
    checked();
    db = new DatabaseSync(workerData.indexFile, { readOnly: true });
    db.exec(`PRAGMA busy_timeout=${workerData.busyTimeoutMs}; PRAGMA cache_size=-4096; PRAGMA mmap_size=0; PRAGMA temp_store=FILE; PRAGMA query_only=ON;`);
    const months = db.prepare(SQL).all().map(row => row.month);
    if (!validMonths(months)) throw fault(INVALID);
    db.close(); db = null; checked();
    parentPort.postMessage({ kind: KIND, ok: true, months });
  } catch (error) {
    try { db?.close(); } catch {}
    parentPort.postMessage({ kind: KIND, ok: false, code: [INVALID, CHANGED].includes(error?.code) ? error.code : INVALID });
  } finally { parentPort.close(); }
}

function createHistoryIndexMonthsReader({ WorkerClass = Worker, setTimeoutImpl = setTimeout, clearTimeoutImpl = clearTimeout, now = () => performance.now() } = {}) {
  if ([WorkerClass, setTimeoutImpl, clearTimeoutImpl, now].some(value => typeof value !== "function")) throw TypeError("Month worker callbacks are required");
  const pending = new Map(); let serial = Promise.resolve();
  const metrics = { started: 0, joined: 0, completed: 0, failed: 0, timedOut: 0, exitObserved: 0, activeWorkers: 0, maximumActiveWorkers: 0, elapsedMs: 0, maximumElapsedMs: 0 };
  function run(input) {
    return new Promise((resolve, reject) => {
      let worker, timer = null, message = null, errored = false, timedOut = false, settled = false;
      const began = now();
      const finish = (code, months) => {
        if (settled) return; settled = true;
        if (timer !== null) clearTimeoutImpl(timer);
        if (worker) metrics.activeWorkers--;
        const elapsed = Math.max(0, now() - began); metrics.elapsedMs += elapsed; metrics.maximumElapsedMs = Math.max(metrics.maximumElapsedMs, elapsed);
        if (code) { metrics.failed++; reject(fault(code)); }
        else { metrics.completed++; resolve(Object.freeze(months.slice())); }
      };
      try {
        worker = new WorkerClass(__filename, { env: {}, execArgv: [], resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16, stackSizeMb: 2 },
          workerData: { kind: KIND, indexFile: input.indexFile, expectedSignature: input.expectedSignature, busyTimeoutMs: input.busyTimeoutMs } });
        metrics.started++; metrics.activeWorkers++; metrics.maximumActiveWorkers = Math.max(metrics.maximumActiveWorkers, metrics.activeWorkers);
        worker.on("message", value => {
          if (message !== null || !value || value.kind !== KIND || typeof value.ok !== "boolean"
            || Object.keys(value).some(key => !(value.ok ? ["kind", "ok", "months"] : ["kind", "ok", "code"]).includes(key))
            || value.ok && !validMonths(value.months) || !value.ok && ![INVALID, CHANGED].includes(value.code)) { errored = true; return; }
          message = value;
        });
        worker.on("error", () => { errored = true; });
        worker.once("exit", code => {
          metrics.exitObserved++;
          if (timedOut) finish(TIMEOUT);
          else if (errored || code !== 0 || !message) finish(FAILED);
          else if (!message.ok) finish(message.code);
          else finish(null, message.months);
        });
        timer = setTimeoutImpl(() => {
          if (settled || timedOut) return;
          timedOut = true; metrics.timedOut++;
          // A native SQLite scan may finish after terminate() was requested.
          // Keep this serial allocation until its actual exit, even on timeout.
          try { Promise.resolve(worker.terminate()).catch(() => { errored = true; }); } catch { errored = true; }
        }, input.timeoutMs); timer?.unref?.();
      } catch {
        if (!worker) finish(FAILED);
        else { errored = true; try { Promise.resolve(worker.terminate()).catch(() => {}); } catch {} }
      }
    });
  }
  function read({ indexFile, expectedSignature, busyTimeoutMs = 1000, timeoutMs = 60000 } = {}) {
    const input = { indexFile, expectedSignature, busyTimeoutMs, timeoutMs };
    if (!valid(input) || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) return Promise.reject(TypeError("Invalid history index month request"));
    const existing = pending.get(indexFile);
    if (existing) {
      metrics.joined++;
      if (existing.signature === expectedSignature) return existing.promise;
      return existing.promise.then(() => { throw fault(CHANGED); }, () => { throw fault(CHANGED); });
    }
    const promise = serial.then(() => run(input)), task = { signature: expectedSignature, promise };
    serial = promise.then(() => undefined, () => undefined); pending.set(indexFile, task);
    promise.then(() => { if (pending.get(indexFile) === task) pending.delete(indexFile); }, () => { if (pending.get(indexFile) === task) pending.delete(indexFile); });
    return promise;
  }
  read.status = () => ({ ...metrics, pendingQueries: pending.size });
  return read;
}

if (!isMainThread && workerData?.kind === KIND) workerMain();
const readHistoryIndexMonths = createHistoryIndexMonthsReader();
module.exports = { readHistoryIndexMonths, createHistoryIndexMonthsReader };
