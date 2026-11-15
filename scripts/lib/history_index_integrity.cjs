"use strict";

// Web-process integrity inspection only. Private isolated source-copy readers
// inject their original synchronous check and never load this worker module.
const path = require("node:path"), { Worker, isMainThread, parentPort, workerData } = require("node:worker_threads");
const { performance } = require("node:perf_hooks");
const KIND = "history-index-full-integrity-v1";
const INVALID = "HISTORY_OBSERVATION_INDEX_INVALID", CHANGED = "HISTORY_OBSERVATION_INDEX_INTEGRITY_CHANGED";
const FAILED = "HISTORY_OBSERVATION_INDEX_INTEGRITY_WORKER_FAILED", TIMEOUT = "HISTORY_OBSERVATION_INDEX_INTEGRITY_TIMEOUT";
const fault = code => Object.assign(new Error(code), { code, statusCode: 503 });
const signature = stat => `${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}:${stat.ino}:${stat.dev}`;
const valid = value => value && typeof value.indexFile === "string" && path.isAbsolute(value.indexFile) && path.resolve(value.indexFile) === value.indexFile
  && typeof value.expectedSignature === "string" && value.expectedSignature.length > 0 && value.expectedSignature.length < 300 && !/[\x00-\x1f\x7f]/.test(value.expectedSignature)
  && Number.isSafeInteger(value.busyTimeoutMs) && value.busyTimeoutMs >= 0 && value.busyTimeoutMs <= 5000;

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
    // Exactly the former full check, not quick_check(N), a sampled table, a
    // cached success, or merely opening the database. SQLite failures stay data
    // failures; their text/rows never cross the worker boundary.
    const check = db.prepare("PRAGMA quick_check").get();
    if (!check || Object.values(check)[0] !== "ok") throw fault(INVALID);
    db.close(); db = null; checked();
    parentPort.postMessage({ kind: KIND, ok: true });
  } catch (error) {
    try { db?.close(); } catch {}
    const code = [INVALID, CHANGED].includes(error?.code) ? error.code : INVALID;
    parentPort.postMessage({ kind: KIND, ok: false, code });
  } finally { parentPort.close(); }
}

function createHistoryIndexIntegrityChecker({ WorkerClass = Worker, setTimeoutImpl = setTimeout, clearTimeoutImpl = clearTimeout, now = () => performance.now() } = {}) {
  if ([WorkerClass, setTimeoutImpl, clearTimeoutImpl, now].some(value => typeof value !== "function")) throw TypeError("Integrity worker callbacks are required");
  const pending = new Map(); let serial = Promise.resolve();
  const metrics = { started: 0, joined: 0, completed: 0, failed: 0, timedOut: 0, exitObserved: 0, activeWorkers: 0, maximumActiveWorkers: 0, elapsedMs: 0, maximumElapsedMs: 0 };
  function run(input) {
    return new Promise((resolve, reject) => {
      let worker, timer = null, message = null, errored = false, timedOut = false, settled = false;
      const began = now();
      const finish = (code, result) => {
        if (settled) return; settled = true;
        if (timer !== null) clearTimeoutImpl(timer);
        if (worker) metrics.activeWorkers--;
        const elapsed = Math.max(0, now() - began); metrics.elapsedMs += elapsed; metrics.maximumElapsedMs = Math.max(metrics.maximumElapsedMs, elapsed);
        if (code) { metrics.failed++; reject(fault(code)); } else { metrics.completed++; resolve(Object.freeze(result)); }
      };
      try {
        worker = new WorkerClass(__filename, { env: {}, execArgv: [], resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16, stackSizeMb: 2 },
          workerData: { kind: KIND, indexFile: input.indexFile, expectedSignature: input.expectedSignature, busyTimeoutMs: input.busyTimeoutMs } });
        metrics.started++; metrics.activeWorkers++; metrics.maximumActiveWorkers = Math.max(metrics.maximumActiveWorkers, metrics.activeWorkers);
        worker.on("message", value => { if (message !== null || !value || value.kind !== KIND || typeof value.ok !== "boolean"
          || Object.keys(value).some(key => !["kind", "ok", "code"].includes(key)) || !value.ok && ![INVALID, CHANGED].includes(value.code)) { errored = true; return; } message = value; });
        worker.on("error", () => { errored = true; });
        worker.once("exit", code => {
          metrics.exitObserved++;
          if (timedOut) finish(TIMEOUT);
          else if (errored || code !== 0 || !message) finish(FAILED);
          else if (!message.ok) finish(message.code);
          else finish(null, { quick_check: "ok" });
        });
        timer = setTimeoutImpl(() => {
          if (settled || timedOut) return;
          timedOut = true; metrics.timedOut++;
          // Native SQLite may not return promptly to Worker.terminate(). Keep
          // this promise/serial ownership until the actual exit event, even
          // after the requested timeout; never start a replacement worker yet.
          try { Promise.resolve(worker.terminate()).catch(() => { errored = true; }); } catch { errored = true; }
        }, input.timeoutMs); timer?.unref?.();
      } catch {
        if (!worker) finish(FAILED);
        else { errored = true; try { Promise.resolve(worker.terminate()).catch(() => {}); } catch {} }
      }
    });
  }
  function check({ indexFile, expectedSignature, busyTimeoutMs = 1000, timeoutMs = 60000 } = {}) {
    const input = { indexFile, expectedSignature, busyTimeoutMs, timeoutMs };
    if (!valid(input) || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) return Promise.reject(TypeError("Invalid history index integrity request"));
    const existing = pending.get(indexFile);
    if (existing) {
      metrics.joined++;
      if (existing.signature === expectedSignature) return existing.promise;
      return existing.promise.then(() => { throw fault(CHANGED); }, () => { throw fault(CHANGED); });
    }
    // One physical worker at a time, including multiple index instances/files.
    // A rejected/timeout caller cannot relinquish the native worker lifetime.
    const promise = serial.then(() => run(input)), task = { signature: expectedSignature, promise };
    serial = promise.then(() => undefined, () => undefined); pending.set(indexFile, task);
    promise.then(() => { if (pending.get(indexFile) === task) pending.delete(indexFile); }, () => { if (pending.get(indexFile) === task) pending.delete(indexFile); });
    return promise;
  }
  check.status = () => ({ ...metrics, pendingChecks: pending.size });
  return check;
}

if (!isMainThread && workerData?.kind === KIND) workerMain();
const checkHistoryIndexIntegrity = createHistoryIndexIntegrityChecker();
module.exports = { checkHistoryIndexIntegrity, createHistoryIndexIntegrityChecker };
