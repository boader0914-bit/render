"use strict";

const { AsyncLocalStorage } = require("node:async_hooks");
const { isPromise } = require("node:util").types;
const v8 = require("node:v8");

const VERSION = "analytical-phase-diagnostics-v1";
const MAX_RECORDS = 64;
const MAX_PHASES = 32;
// Match the scheduler's bounded internal task codes. Callers must supply these
// codes, never customer/keyword labels, paths or arbitrary error strings.
const IDENTIFIER = /^[A-Za-z0-9_:-]{1,80}$/;
const MEMORY_FIELDS = Object.freeze(["heapUsed", "heapTotal", "rss", "external", "arrayBuffers", "heapSizeLimit"]);
const METADATA_FIELDS = Object.freeze(["inputBytes", "outputBytes", "uncompressedBytes", "rowCount", "partitionCount", "cacheHits", "readCount"]);

const count = value => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
const number = value => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
const emptyMemory = () => Object.fromEntries(MEMORY_FIELDS.map(key => [key, null]));
const copy = value => JSON.parse(JSON.stringify(value));
const elapsed = (start, end) => start === null || end === null ? null : Math.max(0, end - start);

function limit(value, fallback, maximum, name) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1 || value > maximum) throw new RangeError(`Invalid ${name}`);
  return value;
}

function createAnalyticalPhaseDiagnostics({ memoryUsage = () => process.memoryUsage(), heapStatistics = () => v8.getHeapStatistics(),
  now = Date.now, onRecord = null, maxRecords, maxPhases } = {}) {
  maxRecords = limit(maxRecords, MAX_RECORDS, MAX_RECORDS, "maxRecords");
  maxPhases = limit(maxPhases, MAX_PHASES, MAX_PHASES, "maxPhases");
  const storage = new AsyncLocalStorage();
  const active = new Map();
  const records = [];
  const counters = { started: 0, completed: 0, failed: 0, droppedRecords: 0, droppedPhases: 0, nestedRuns: 0,
    observerErrors: 0, samplingErrors: 0, invalidIdentifiers: 0 };
  let nextId = 0;

  function clock() {
    try { return typeof now === "function" ? number(now()) : null; }
    catch { return null; }
  }

  function identifier(value, fallback) {
    if (typeof value === "string" && IDENTIFIER.test(value)) return value;
    counters.invalidIdentifiers += 1;
    return fallback;
  }

  function metadata(value) {
    const safe = {};
    if (!value || typeof value !== "object") return safe;
    for (const key of METADATA_FIELDS) {
      try {
        if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
        const scalar = count(value[key]);
        if (scalar !== null) safe[key] = scalar;
      } catch { /* A proxy/getter must not change the observed operation. */ }
    }
    return safe;
  }

  function sampleMemory() {
    const safe = emptyMemory();
    try {
      const usage = typeof memoryUsage === "function" ? memoryUsage() : null;
      for (const key of MEMORY_FIELDS) {
        if (key === "heapSizeLimit") continue;
        try { safe[key] = count(usage?.[key]); }
        catch { counters.samplingErrors += 1; }
      }
    } catch { counters.samplingErrors += 1; }
    try {
      const statistics = typeof heapStatistics === "function" ? heapStatistics() : null;
      const value = count(statistics?.heap_size_limit);
      safe.heapSizeLimit = value > 0 ? value : null;
    } catch { counters.samplingErrors += 1; }
    return safe;
  }

  function mergePeak(peak, snapshot) {
    for (const key of MEMORY_FIELDS) {
      if (snapshot[key] !== null) peak[key] = peak[key] === null ? snapshot[key] : Math.max(peak[key], snapshot[key]);
    }
  }

  function sample(record) {
    const snapshot = sampleMemory();
    record.sampleCount += 1;
    mergePeak(record.peak, snapshot);
    for (const phase of record.phases) {
      if (phase.status !== "running") continue;
      phase.sampleCount += 1;
      mergePeak(phase.peak, snapshot);
    }
    return snapshot;
  }

  function emit(event) {
    if (typeof onRecord !== "function") return;
    try {
      // Give the observer a detached, already-filtered payload. Do not await a
      // logging sink or retain its promise in a request's diagnostic record.
      const pending = onRecord(copy(event));
      if (isPromise(pending)) {
        Promise.prototype.then.call(pending, undefined, () => { counters.observerErrors += 1; });
      }
    } catch { counters.observerErrors += 1; }
  }

  function event(record, type, at, memory, extra = {}) {
    emit({ event: type, id: record.id, kind: record.kind, at, memory, ...extra });
  }

  function view(record) {
    return { id: record.id, kind: record.kind, status: record.status, errorCode: record.errorCode,
      startedAt: record.startedAt, finishedAt: record.finishedAt, elapsedMs: record.elapsedMs,
      before: record.before, after: record.after, peak: record.peak, sampleCount: record.sampleCount,
      phaseCount: record.phases.length, droppedPhaseCount: record.droppedPhaseCount, phases: record.phases };
  }

  function begin(kind) {
    const startedAt = clock();
    const record = { id: ++nextId, kind, status: "running", errorCode: null, startedAt, finishedAt: null,
      elapsedMs: null, before: null, after: null, peak: emptyMemory(), sampleCount: 0, phases: [], droppedPhaseCount: 0, closed: false };
    record.before = sample(record);
    active.set(record.id, record);
    event(record, "run_start", startedAt, record.before, { metadata: {} });
    return record;
  }

  function finish(record, status) {
    if (!record || record.closed) return;
    record.finishedAt = clock();
    record.after = sample(record);
    record.elapsedMs = elapsed(record.startedAt, record.finishedAt);
    record.status = status;
    record.errorCode = status === "failed" ? "ANALYTICAL_OPERATION_FAILED" : null;
    for (const phase of record.phases) {
      if (phase.status === "running") {
        phase.status = "unsettled";
        phase.errorCode = "ANALYTICAL_PHASE_NOT_SETTLED";
      }
    }
    record.closed = true;
    active.delete(record.id);
    records.push(copy(view(record)));
    if (records.length > maxRecords) records.shift();
    event(record, "run_end", record.finishedAt, record.after, { metadata: {}, status, errorCode: record.errorCode,
      elapsedMs: record.elapsedMs, phaseCount: record.phases.length, droppedPhaseCount: record.droppedPhaseCount });
  }

  function safelyFinish(record, status) {
    try { finish(record, status); }
    catch { if (record) { record.closed = true; active.delete(record.id); } }
  }

  function measure(phaseName, suppliedMetadata, operation) {
    if (typeof operation !== "function") throw new TypeError("A diagnostic operation must be a function");
    const record = storage.getStore()?.record;
    if (!record || record.closed) return operation();
    const retained = record.phases.length < maxPhases;
    if (!retained) {
      record.droppedPhaseCount += 1;
      counters.droppedPhases += 1;
    }

    let phase = null;
    try {
      const name = identifier(phaseName, "invalid_phase"), startedAt = clock(), safeMetadata = metadata(suppliedMetadata);
      phase = retained ? { phase: name, status: "running", errorCode: null, startedAt, finishedAt: null,
        elapsedMs: null, metadata: safeMetadata, before: null, after: null, peak: emptyMemory(), sampleCount: 0 }
        : { phase: name, status: "running", startedAt };
      if (retained) record.phases.push(phase);
      const before = sample(record);
      if (retained) phase.before = before;
      // Retention bounds must not hide later partitions' allocations. Overflow
      // checkpoints still reach the caller's throttled observer, without adding
      // phase records or event arrays to the retained diagnostic history.
      event(record, "phase_start", phase.startedAt, before, { phase: phase.phase, metadata: safeMetadata, retained });
    } catch { /* Execute the original operation even if instrumentation fails. */ }

    function settle(status) {
      try {
        if (!phase || record.closed || phase.status !== "running") return;
        const finishedAt = clock(), after = sample(record), elapsedMs = elapsed(phase.startedAt, finishedAt);
        const safeMetadata = metadata(suppliedMetadata), errorCode = status === "failed" ? "ANALYTICAL_PHASE_FAILED" : null;
        if (retained) {
          phase.finishedAt = finishedAt;
          phase.after = after;
          phase.elapsedMs = elapsedMs;
          phase.metadata = safeMetadata;
          phase.errorCode = errorCode;
        }
        phase.status = status;
        event(record, "phase_end", finishedAt, after, { phase: phase.phase, metadata: safeMetadata,
          status, errorCode, elapsedMs, retained });
      } catch { /* No diagnostic failure may replace the business result. */ }
    }

    let result;
    try { result = operation(); }
    catch (error) { settle("failed"); throw error; }
    if (isPromise(result)) {
      try {
        return Promise.prototype.then.call(result,
          value => { settle("completed"); return value; },
          error => { settle("failed"); throw error; });
      } catch {
        // A custom Promise species/then implementation is not our operation.
        // Preserve that original object instead of making observation fatal.
        settle("unsettled");
        return result;
      }
    }
    // Do not inspect arbitrary return objects' `then` getters. Native promises
    // are observed above; opaque objects/thenables retain their original shape.
    settle("completed");
    return result;
  }

  async function run(kind, operation) {
    if (typeof operation !== "function") throw new TypeError("A diagnostic operation must be a function");
    const inherited = storage.getStore()?.record;
    if (inherited && !inherited.closed && active.get(inherited.id) === inherited) {
      counters.nestedRuns += 1;
      // Nested execution belongs to its original root. Do not retain the inner
      // caller's kind, which might otherwise turn a free label into a log field.
      return measure("nested_run", {}, operation);
    }
    counters.started += 1;
    const safeKind = identifier(kind, "invalid_kind");
    let record = null;
    if (active.size < maxRecords) {
      try { record = begin(safeKind); }
      catch { /* An unavailable diagnostic remains an executable operation. */ }
    } else counters.droppedRecords += 1;

    const context = { record };
    return storage.run(context, async () => {
      try {
        const result = await operation();
        counters.completed += 1;
        safelyFinish(record, "completed");
        return result;
      } catch (error) {
        counters.failed += 1;
        safelyFinish(record, "failed");
        throw error;
      } finally {
        // Detached scheduler resources may outlive this operation. Keep their
        // context marker, but release the completed record and its phase array.
        context.record = null;
      }
    });
  }

  function status() {
    return { version: VERSION, limits: { maxRecords, maxPhases, maxActive: maxRecords }, counters: { ...counters },
      interpretation: "Peak means the highest endpoint/checkpoint observation, not a continuous allocation peak. Phase retention limits do not stop later boundary samples or observer checkpoints. arrayBuffers is a separate component already included in external; these fields must not be added together.",
      active: [...active.values()].map(record => copy(view(record))), records: copy(records) };
  }

  return { run, measure, status };
}

module.exports = { createAnalyticalPhaseDiagnostics };
