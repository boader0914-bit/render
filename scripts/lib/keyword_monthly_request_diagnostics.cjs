"use strict";

const { AsyncLocalStorage } = require("node:async_hooks");
const crypto = require("node:crypto");
const { keywordMonthlyGuardDiagnosticFromError } = require("./keyword_monthly_guard_diagnostics.cjs");
const { METADATA_PHASES, withKeywordMonthlyMetadataMeasure } = require("./keyword_monthly_metadata_diagnostics.cjs");
const ROUTES = new Set(["options", "catalogue", "data", "refresh_status", "version", "unknown"]);
const PHASES = new Set(["admission", "read", "serialize", "refresh_status", ...METADATA_PHASES]);
const LIFECYCLE_EVENTS = new Set(["owner", "shared", "waiter_timed_out", "waiter_aborted", "operation_started", "operation_settled"]);
const METADATA_RESULT_STATUSES = new Set(["available", "stale", "needs_verification", "missing", "not_prepared"]);
const METRICS = ["queueWaitMs", "leaseMs", "busyWaitMs", "memoryWaitMs", "samplingWaitMs", "otherWaitMs"];
const code = value => typeof value === "string" && /^(?:KEYWORD_MONTHLY|KEYWORD_INCREMENTAL|ANALYTICAL)_[A-Z0-9_]{1,78}$/.test(value) && value.length <= 100 ? value : null;
const duration = value => typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.min(86400000, Math.round(value * 1000) / 1000) : null;
const copy = value => JSON.parse(JSON.stringify(value));

// Request-local numeric observations only. No URL, query, keyword, company,
// request/response objects, error text, paths, credentials or result payloads.
// A shared unfinished read owns only its first caller's work observation;
// another caller's waiting time is never represented as its own lease timing.
function createKeywordMonthlyRequestDiagnostics({ now = Date.now, maxRecords = 32,
  onLog = value => console.info("keyword_monthly_request_diagnostic", JSON.stringify(value)),
  maxEventsPerWindow = 60, windowMs = 60000 } = {}) {
  if (typeof now !== "function" || !Number.isSafeInteger(maxRecords) || maxRecords < 1 || maxRecords > 64
    || onLog !== null && typeof onLog !== "function" || !Number.isSafeInteger(maxEventsPerWindow)
    || maxEventsPerWindow < 1 || maxEventsPerWindow > 120 || !Number.isSafeInteger(windowMs) || windowMs < 1000) throw new TypeError("Invalid monthly request diagnostics");
  const storage = new AsyncLocalStorage(), records = [];
  const counters = { started: 0, finished: 0, observerErrors: 0, droppedLogs: 0, metadataStarted: 0, metadataFinished: 0, metadataFinishedAfterHandler: 0 };
  let windowAt = null, emitted = 0;
  const clock = () => { try { const value = Number(now()); return Number.isFinite(value) ? value : null; } catch { return null; } };
  const elapsed = (start, end) => start === null || end === null ? null : duration(Math.max(0, end - start));
  function emit(event, record) {
    if (onLog === null) return;
    const at = clock();
    if (at === null) { counters.observerErrors++; return; }
    if (windowAt === null || at < windowAt || at - windowAt >= windowMs) { windowAt = at; emitted = 0; }
    if (emitted >= maxEventsPerWindow) { counters.droppedLogs++; return; }
    emitted++;
    try { const pending = onLog({ event, ...copy(record) }); if (pending && typeof pending.then === "function") Promise.resolve(pending).catch(() => { counters.observerErrors++; }); }
    catch { counters.observerErrors++; }
  }
  function view(trace) {
    return { traceId: trace.traceId, route: trace.route, handlerFinished: trace.handlerFinished,
      elapsedMs: trace.elapsedMs, responseStatus: trace.responseStatus, responseCode: trace.responseCode,
      sendInvoked: trace.sendInvoked, phases: { ...trace.phases }, phaseCounts: { ...trace.phaseCounts },
      readGuard: trace.readGuard ? copy(trace.readGuard) : null,
      lifecycleRole: trace.lifecycleRole, lifecycleWaiterOutcome: trace.lifecycleWaiterOutcome,
      lifecycleOperationStarted: trace.lifecycleOperationStarted, lifecycleOperationFinished: trace.lifecycleOperationFinished,
      metadataStarted: trace.metadataStarted, metadataFinished: trace.metadataFinished,
      metadataStartedAfterHandler: trace.metadataStartedAfterHandler, metadataFinishedAfterHandler: trace.metadataFinishedAfterHandler,
      metadataElapsedMs: trace.metadataStarted ? elapsed(trace.metadataStartedAt, trace.metadataFinishedAt ?? clock()) : null,
      metadataOutcome: trace.metadataOutcome, metadataErrorCode: trace.metadataErrorCode,
      metadataResultStatus: trace.metadataResultStatus, metadataResultCode: trace.metadataResultCode,
      metadataReadGuard: trace.metadataReadGuard ? copy(trace.metadataReadGuard) : null,
      workStarted: trace.workStarted, workFinished: trace.workFinished,
      workStartedAfterHandler: trace.workStartedAfterHandler,
      workStateAtHandlerEnd: trace.workStateAtHandlerEnd, workElapsedAtHandlerEndMs: trace.workElapsedAtHandlerEndMs,
      queueWaitAtStartMs: trace.queueWaitAtStartMs,
      workElapsedMs: trace.workStarted ? elapsed(trace.workStartedAt,trace.workFinishedAt ?? clock()) : null,
      taskTimingObserved: trace.taskTimingObserved, taskTimingObservedAfterHandler: trace.taskTimingObservedAfterHandler,
      task: trace.task ? { ...trace.task } : null };
  }
  async function run(route, operation) {
    if (!ROUTES.has(route) || typeof operation !== "function") throw new TypeError("Invalid monthly diagnostic route");
    const trace = { traceId: crypto.randomBytes(12).toString("hex"), route, startedAt: clock(), handlerFinished: false,
      elapsedMs: null, responseStatus: null, responseCode: null, sendInvoked: false, phases: {}, phaseCounts: {}, readGuard: null,
      lifecycleRole: null, lifecycleWaiterOutcome: null, lifecycleOperationStarted: false, lifecycleOperationFinished: false,
      metadataStarted: false, metadataFinished: false, metadataStartedAt: null, metadataFinishedAt: null,
      metadataStartedAfterHandler: false, metadataFinishedAfterHandler: false, metadataOutcome: "not_observed", metadataErrorCode: null, metadataReadGuard: null,
      metadataResultStatus: null, metadataResultCode: null,
      workStarted: false, workFinished: false, workStartedAt: null, workFinishedAt: null, handlerFinishedAt: null, queueWaitAtStartMs: null,
      workStartedAfterHandler: false, workStateAtHandlerEnd: null, workElapsedAtHandlerEndMs: null,
      taskTimingObserved: false, taskTimingObservedAfterHandler: false, task: null };
    counters.started++;
    return storage.run(trace, async () => {
      try { return await operation(); }
      finally {
        trace.handlerFinished = true; trace.handlerFinishedAt = clock(); trace.elapsedMs = elapsed(trace.startedAt, trace.handlerFinishedAt); counters.finished++;
        // "not_observed" includes a queued owner and a non-owner joining a
        // shared flight. It never asserts that no other caller's work ran.
        trace.workStateAtHandlerEnd = !trace.workStarted ? "not_observed" : trace.workFinished ? "finished" : "running";
        trace.workElapsedAtHandlerEndMs = trace.workStarted ? elapsed(trace.workStartedAt,trace.workFinishedAt ?? trace.handlerFinishedAt) : null;
        records.push(trace); if (records.length > maxRecords) records.shift(); emit("handler_end", view(trace));
      }
    });
  }
  function work(operation) {
    if (typeof operation !== "function") throw new TypeError("A monthly diagnostic operation is required");
    const trace = storage.getStore();
    return async info => {
      if (trace) { trace.workStarted = true; trace.workStartedAfterHandler = trace.handlerFinished; trace.workStartedAt = clock(); trace.queueWaitAtStartMs = duration(info?.timing?.queueWaitMs); }
      try { return await operation(info); }
      finally { if (trace) { trace.workFinished = true; trace.workFinishedAt = clock(); } }
    };
  }
  async function measure(phase, operation) {
    if (!PHASES.has(phase) || typeof operation !== "function") throw new TypeError("Invalid monthly diagnostic phase");
    const trace = storage.getStore(), start = clock();
    if (trace) trace.phaseCounts[phase] = Math.min(1000000, (trace.phaseCounts[phase] || 0) + 1);
    try { return await operation(); }
    finally { if (trace) { const value = elapsed(start, clock()); if (value !== null) trace.phases[phase] = duration((trace.phases[phase] || 0) + value); } }
  }
  function measureSync(phase, operation) {
    if (phase !== "response_send" || typeof operation !== "function") throw new TypeError("Invalid synchronous monthly diagnostic phase");
    const trace = storage.getStore(), start = clock();
    if (trace) trace.phaseCounts[phase] = Math.min(1000000, (trace.phaseCounts[phase] || 0) + 1);
    // Observe only the synchronous invocation. Preserve its exact return/throw,
    // including a thenable; do not await socket completion or async callbacks.
    try { return operation(); }
    finally { if (trace) { const value = elapsed(start, clock()); if (value !== null) trace.phases[phase] = duration((trace.phases[phase] || 0) + value); } }
  }
  async function admission(phase, enter, operation) {
    if (!PHASES.has(phase) || typeof enter !== "function" || typeof operation !== "function") throw new TypeError("Invalid admission observation");
    const trace = storage.getStore(), start = clock(); let entered = false;
    if (trace) trace.phaseCounts[phase] = Math.min(1000000, (trace.phaseCounts[phase] || 0) + 1);
    const finish = () => { if (entered) return; entered = true;
      if (trace) { const value = elapsed(start, clock()); if (value !== null) trace.phases[phase] = duration((trace.phases[phase] || 0) + value); } };
    // Measure only the gate, not the operation it admits. A denied gate is
    // observed too; the original rejection, including a falsy reason, survives.
    try { return await enter(() => { finish(); return operation(); }); }
    finally { finish(); }
  }
  function metadata(operation) {
    if (typeof operation !== "function") throw new TypeError("A metadata operation is required");
    const trace = storage.getStore();
    return () => withKeywordMonthlyMetadataMeasure(measure, async () => {
      if (trace) { trace.metadataStarted = true; trace.metadataStartedAt = clock(); trace.metadataStartedAfterHandler = trace.handlerFinished;
        trace.metadataOutcome = "running"; counters.metadataStarted++; emit("metadata_start", view(trace)); }
      let failed = false;
      try {
        const result = await operation();
        if (trace) {
          // A bounded saved read can return a verification refusal instead of
          // throwing. Observe that result separately from operation settlement;
          // no payload, arbitrary status or error text enters the trace. Each
          // getter is observational and may fail without changing the result.
          try { const status = result?.status; trace.metadataResultStatus = METADATA_RESULT_STATUSES.has(status) ? status : null; }
          catch { counters.observerErrors++; }
          try { trace.metadataResultCode = code(result?.code); }
          catch { counters.observerErrors++; }
          if (trace.metadataResultCode === null) try {
            const diagnostics = result?.diagnostics;
            if (Array.isArray(diagnostics)) for (let index = 0; index < Math.min(diagnostics.length, 32); index++) {
              const value = code(diagnostics[index]); if (value) { trace.metadataResultCode = value; break; }
            }
          } catch { counters.observerErrors++; }
          trace.metadataReadGuard = keywordMonthlyGuardDiagnosticFromError(result);
        }
        return result;
      }
      catch (error) { failed = true; if (trace) { try { trace.metadataErrorCode = code(error?.code); } catch {}
        trace.metadataReadGuard = keywordMonthlyGuardDiagnosticFromError(error); } throw error; }
      finally { if (trace) { trace.metadataFinished = true; trace.metadataFinishedAt = clock(); trace.metadataFinishedAfterHandler = trace.handlerFinished;
        trace.metadataOutcome = failed ? "failed" : "completed"; counters.metadataFinished++;
        if (trace.handlerFinished) counters.metadataFinishedAfterHandler++;
        emit("metadata_end", view(trace)); } }
    });
  }
  function lifecycleOptions() {
    const trace = storage.getStore();
    if (!trace) return {};
    return { onLifecycleObservation: value => {
      if (!value || !LIFECYCLE_EVENTS.has(value.event) || !["owner", "waiter"].includes(value.role)) { counters.observerErrors++; return; }
      if (value.event === "owner" || value.event === "shared") trace.lifecycleRole = value.role;
      if (value.event === "waiter_timed_out") trace.lifecycleWaiterOutcome = "timed_out";
      if (value.event === "waiter_aborted") trace.lifecycleWaiterOutcome = "aborted";
      if (value.event === "operation_started") trace.lifecycleOperationStarted = true;
      if (value.event === "operation_settled") { trace.lifecycleOperationFinished = true;
        if (trace.metadataStarted) emit("metadata_operation_settled", view(trace)); }
    } };
  }
  function guard(error) { const trace = storage.getStore(); if (trace) trace.readGuard = keywordMonthlyGuardDiagnosticFromError(error); }
  function schedulerOptions() {
    const trace = storage.getStore();
    if (!trace) return {};
    return { onTaskTiming: record => {
      const task = { outcome: ["completed", "failed", "aborted", "closed", "yielded"].includes(record?.outcome) ? record.outcome : "unknown", errorCode: code(record?.errorCode) };
      for (const key of METRICS) task[key] = duration(record?.[key]);
      trace.task = task; trace.taskTimingObserved = true; trace.taskTimingObservedAfterHandler = trace.handlerFinished;
      emit("task_end", view(trace));
    } };
  }
  function response(res, status, errorCode = null) {
    const trace = storage.getStore(); if (!trace) return;
    trace.responseStatus = Number.isSafeInteger(status) && status >= 100 && status <= 599 ? status : null;
    trace.responseCode = code(errorCode); trace.sendInvoked = true;
    if (res?.headersSent) return;
    try {
      res.setHeader?.("X-Keyword-Monthly-Trace", trace.traceId);
      const values = Object.entries(trace.phases).map(([phase, ms]) => `${phase};dur=${ms}`);
      if (trace.task) for (const key of ["queueWaitMs", "leaseMs"]) if (trace.task[key] !== null) values.push(`${key === "queueWaitMs" ? "queue" : "work"};dur=${trace.task[key]}`);
      if (values.length) res.setHeader?.("Server-Timing", values.join(", "));
    } catch { counters.observerErrors++; }
  }
  return Object.freeze({ run, measure, measureSync, admission, metadata, guard, work, lifecycleOptions, schedulerOptions, response,
    status: () => ({ ...counters, maxRecords, maxEventsPerWindow, windowMs, recent: records.map(trace => view(trace)) }) });
}

module.exports = { createKeywordMonthlyRequestDiagnostics };
