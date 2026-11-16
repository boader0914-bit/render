"use strict";

const { AsyncLocalStorage } = require("node:async_hooks");
const crypto = require("node:crypto");
const ROUTES = new Set(["options", "data", "refresh_status", "version", "unknown"]);
const PHASES = new Set(["admission", "read", "serialize", "refresh_status"]);
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
  const counters = { started: 0, finished: 0, observerErrors: 0, droppedLogs: 0 };
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
      sendInvoked: trace.sendInvoked, phases: { ...trace.phases },
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
      elapsedMs: null, responseStatus: null, responseCode: null, sendInvoked: false, phases: {},
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
    try { return await operation(); }
    finally { if (trace) { const value = elapsed(start, clock()); if (value !== null) trace.phases[phase] = duration((trace.phases[phase] || 0) + value); } }
  }
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
  return Object.freeze({ run, measure, work, schedulerOptions, response,
    status: () => ({ ...counters, maxRecords, maxEventsPerWindow, windowMs, recent: records.map(trace => view(trace)) }) });
}

module.exports = { createKeywordMonthlyRequestDiagnostics };
