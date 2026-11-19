"use strict";
const crypto = require("node:crypto");
const { performance } = require("node:perf_hooks");
const { keywordMonthlyGuardDiagnosticFromError } = require("./keyword_monthly_guard_diagnostics.cjs");
const ROUTES = new Set(["catalogue", "saved", "options"]);
const PHASES = new Set(["read_validation", "serialize"]);
const FAILURE_CODES = new Set(["INDUSTRY_SAVED_READ_BUSY", "INDUSTRY_STORE_UNAVAILABLE", "INDUSTRY_ANALYSIS_UNAVAILABLE",
  "INDUSTRY_SAVED_DETAIL_REQUIRED", "KEYWORD_MONTHLY_MEMORY_DEFERRED", "KEYWORD_MONTHLY_MEMORY_UNAVAILABLE",
  "KEYWORD_MONTHLY_RESPONSE_BUSY", "KEYWORD_MONTHLY_QUERY_BUSY", "COMPANY_RESPONSE_TOO_LARGE"]);
const safeNumber = value => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
const elapsed = (start, end) => start === null || end === null || end < start ? null : Math.round((end - start) * 1000) / 1000;
const noop = Object.freeze({ measure: (name, operation) => operation(), measureSync: (name, operation) => operation(),
  admission: (enter, operation) => enter(operation), failure: () => {}, sent: () => {}, send: operation => operation(), finishHandler: () => {} });

// Fixed numeric observations only. No request, session, body, query, exception
// text or filesystem path enters this module. The HTTP operation owns its
// original admission, response budget and lifetime; observation never gates it.
function createIndustryReadDiagnostics({ now = () => performance.now(), wallNow = Date.now,
  onLog = value => console.info("industry_read_diagnostic", JSON.stringify(value)),
  maxRecords = 32, maxEventsPerWindow = 60, windowMs = 60000 } = {}) {
  if (typeof now !== "function" || typeof wallNow !== "function" || onLog !== null && typeof onLog !== "function"
    || !Number.isSafeInteger(maxRecords) || maxRecords < 1 || maxRecords > 128
    || !Number.isSafeInteger(maxEventsPerWindow) || maxEventsPerWindow < 1 || maxEventsPerWindow > 120
    || !Number.isSafeInteger(windowMs) || windowMs < 1000) throw new TypeError("Invalid industry read diagnostics");
  const records = []; let windowAt = null, events = 0, dropped = 0, observerErrors = 0;
  const clock = () => { try { return safeNumber(now()); } catch { observerErrors++; return null; } };
  const wall = () => { try { return safeNumber(wallNow()); } catch { observerErrors++; return null; } };
  function emit(event, state) {
    const record = { event, ...state };
    records.push(record); while (records.length > maxRecords) records.shift();
    if (onLog === null) return;
    const at = clock(); if (at === null) { dropped++; return; }
    if (windowAt === null || at < windowAt || at - windowAt >= windowMs) { windowAt = at; events = 0; }
    if (events >= maxEventsPerWindow) { dropped++; return; }
    events++;
    try { const pending = onLog({ ...record }); if (pending && typeof pending.then === "function") Promise.resolve(pending).catch(() => { observerErrors++; }); }
    catch { observerErrors++; }
  }
  function begin(route, res) {
    if (!ROUTES.has(route)) return noop;
    const start = clock(); let traceId = null;
    try { traceId = crypto.randomBytes(12).toString("hex"); } catch { observerErrors++; }
    const state = { traceId, processId: process.pid, route, startedAtUnixMs: wall(), queueWaitMs: null,
      preHandlerWaitMs: null, preReadMs: null, admissionMs: null, readValidationMs: null,
      readOutcome: "not_observed", serializeMs: null, sendCallMs: null, sendInvokedAtMs: null,
      responseStatus: null, errorCode: null, responseErrorCode: null, readGuard: null, handlerTotalMs: null, handlerFinished: false,
      socketOutcome: "not_observed", socketElapsedMs: null };
    const sinceStart = () => elapsed(start, clock());
    const add = (key, value) => { if (value !== null) state[key] = (state[key] ?? 0) + value; };
    let native = false;
    try { native = typeof res?.once === "function" && typeof res?.removeListener === "function"
      && typeof res?.writeHead === "function" && typeof res?.end === "function"; } catch { observerErrors++; }
    const detach = () => { try { res.removeListener("finish", finish); res.removeListener("close", close); } catch { observerErrors++; } };
    function socket(outcome) { if (state.socketOutcome !== "pending") return; state.socketOutcome = outcome; state.socketElapsedMs = sinceStart(); detach(); emit(`response_${outcome}`, state); }
    function finish() { socket("finish"); }
    function close() { socket("close"); }
    if (native) {
      try {
        if (res.destroyed || res.closed || res.writableFinished) state.socketOutcome = "already_closed";
        else { state.socketOutcome = "pending"; res.once("finish", finish); res.once("close", close); }
      } catch { detach(); state.socketOutcome = "not_observed"; observerErrors++; }
    }
    // This server-generated identifier is independent of every request field.
    try { res?.setHeader?.("X-Industry-Read-Trace", traceId || "unavailable"); } catch { observerErrors++; }
    function measureSync(name, operation) {
      if (!PHASES.has(name) || typeof operation !== "function") throw new TypeError("Invalid industry diagnostic phase");
      const at = clock(); if (name === "read_validation" && state.preReadMs === null) state.preReadMs = elapsed(start, at);
      try { const value = operation(); if (name === "read_validation") state.readOutcome = "completed"; return value; }
      catch (error) { if (name === "read_validation") state.readOutcome = "failed"; throw error; }
      finally { add(name === "serialize" ? "serializeMs" : "readValidationMs", elapsed(at, clock())); }
    }
    async function measure(name, operation) {
      if (!PHASES.has(name) || typeof operation !== "function") throw new TypeError("Invalid industry diagnostic phase");
      const at = clock(); if (name === "read_validation" && state.preReadMs === null) state.preReadMs = elapsed(start, at);
      try { const value = await operation(); if (name === "read_validation") state.readOutcome = "completed"; return value; }
      catch (error) { if (name === "read_validation") state.readOutcome = "failed"; throw error; }
      finally { add(name === "serialize" ? "serializeMs" : "readValidationMs", elapsed(at, clock())); }
    }
    return {
      measure, measureSync,
      async admission(enter, operation) {
        const at = clock(); let entered = false;
        const finishAdmission = () => { if (!entered) { entered = true; add("admissionMs", elapsed(at, clock())); } };
        try { return await enter(() => { finishAdmission(); return operation(); }); } finally { finishAdmission(); }
      },
      failure(error, responseCode = null) {
        state.responseErrorCode = FAILURE_CODES.has(responseCode) ? responseCode : null;
        // Do not invoke an exception's code/readGuard accessors merely to log.
        // The response's original status/code are captured by HTTP first.
        try { const descriptor = Object.getOwnPropertyDescriptor(error || {}, "code"); state.errorCode = FAILURE_CODES.has(descriptor?.value) ? descriptor.value : null; } catch { observerErrors++; }
        try {
          const descriptor = Object.getOwnPropertyDescriptor(error || {}, "readGuard");
          state.readGuard = descriptor && Object.hasOwn(descriptor, "value") ? keywordMonthlyGuardDiagnosticFromError({ readGuard: descriptor.value }) : null;
        } catch { observerErrors++; }
      },
      sent(status) {
        state.responseStatus = Number.isInteger(status) && status >= 100 && status <= 599 ? status : null; state.sendInvokedAtMs = sinceStart();
        const timing = [["admission", state.admissionMs], ["read_validation", state.readValidationMs], ["serialize", state.serializeMs],
          ["pre_read", state.preReadMs], ["handler_to_send", state.sendInvokedAtMs]].filter(([, value]) => safeNumber(value) !== null)
          .map(([name, value]) => `${name};dur=${Math.round(value * 1000) / 1000}`).join(", ");
        try { if (timing && !res?.headersSent) res?.setHeader?.("Server-Timing", timing); } catch { observerErrors++; }
      },
      send(operation) { const at = clock(); try { return operation(); } finally { add("sendCallMs", elapsed(at, clock())); } },
      finishHandler() { if (state.handlerFinished) return; state.handlerFinished = true; state.handlerTotalMs = sinceStart(); emit("handler_end", state); }
    };
  }
  return Object.freeze({ begin, status: () => ({ records: records.map(record => ({ ...record })), dropped, observerErrors,
    maxRecords, maxEventsPerWindow, windowMs }) });
}
module.exports = { createIndustryReadDiagnostics };
