"use strict";

const crypto = require("node:crypto");
const { performance } = require("node:perf_hooks");
const ROUTES = new Map([["/", "root"], ["/view", "view"], ["/admin", "admin"], ["/b2b", "b2b"]]);
const ASSET_FIELDS = ["assetCount", "versionedAssetCount", "digestReads", "digestHits", "digestBytes", "digestQueueMs",
  "digestWorkMs", "digestReadMs", "digestHashMs", "digestSharedFlights", "digestSharedWaitMs", "versionHtmlMs", "failed"];
const finite = value => typeof value === "number" && Number.isFinite(value) && value >= 0
  ? Math.round(Math.min(value, 1e12) * 1000) / 1000 : null;

// Node route entry through HTML preparation: no URL/query, user, cookie, error text, asset paths,
// buffers or result payloads. Timing is response-header invocation, not socket
// completion or browser TTFB. Child spans overlap; they must not be summed.
function createPrivateDocumentDiagnostics({ now = () => performance.now(), maxRecords = 32, maxLogsPerMinute = 30,
  createTraceId = () => crypto.randomBytes(12).toString("hex"),
  onLog = record => console.info("private_document_diagnostic", JSON.stringify(record)) } = {}) {
  if (typeof now !== "function" || typeof createTraceId !== "function" || !Number.isSafeInteger(maxRecords) || maxRecords < 1 || maxRecords > 32
    || !Number.isSafeInteger(maxLogsPerMinute) || maxLogsPerMinute < 1 || maxLogsPerMinute > 60
    || onLog !== null && typeof onLog !== "function") throw TypeError("Invalid private document diagnostics");
  const records = [], requestStarts = new WeakMap(), counters = { started: 0, finished: 0, observerErrors: 0, droppedLogs: 0 };
  let logWindow = null, logCount = 0;
  const clock = () => { try { return finite(now()); } catch { counters.observerErrors++; return null; } };
  const traceId = () => { try { const id = createTraceId(); if (typeof id === "string" && /^[a-f0-9]{24}$/.test(id)) return id; }
    catch {} counters.observerErrors++; return null; };
  const elapsed = (start, end) => start === null || end === null || end < start ? null : finite(end - start);
  const snapshot = record => ({ ...record, phases: { ...record.phases }, assets: { ...record.assets } });
  function emit(record) {
    if (onLog === null) return;
    const at = clock(); if (at === null) return;
    if (logWindow === null || at < logWindow || at - logWindow >= 60000) { logWindow = at; logCount = 0; }
    if (logCount >= maxLogsPerMinute) { counters.droppedLogs++; return; }
    logCount++;
    try { const pending = onLog(snapshot(record)); if (pending && typeof pending.then === "function") Promise.resolve(pending).catch(() => { counters.observerErrors++; }); }
    catch { counters.observerErrors++; }
  }
  function markRequest(response) {
    if (!response || typeof response !== "object") return;
    try { requestStarts.set(response, clock()); } catch { counters.observerErrors++; }
  }
  async function run(route, operation, response = null) {
    if (typeof operation !== "function") throw TypeError("A document operation is required");
    const preparationAt = clock(); let markedAt = null;
    if (response && typeof response === "object") { markedAt = requestStarts.get(response) ?? null; requestStarts.delete(response); }
    const startedAt = markedAt ?? preparationAt, record = { traceId: traceId(), route: ROUTES.get(route) || "unknown",
      elapsedMs: null, headerReadyMs: null, responseStatus: null, outcome: "running", phases: {}, assets: {} };
    if (markedAt !== null) record.phases.route_to_static = elapsed(markedAt, preparationAt);
    counters.started++;
    const timing = Object.freeze({
      async measure(phase, action) {
        if (typeof action !== "function") throw TypeError("A document phase operation is required");
        const known = ["html_read", "html_versions"].includes(phase), start = clock();
        try { return await action(); }
        finally { if (known) record.phases[phase] = elapsed(start, clock()); }
      },
      assets(value) {
        // Read only own data properties. Observer getters cannot execute in
        // the serving path or change the operation's result.
        for (const key of ASSET_FIELDS) try {
          const descriptor = value && Object.getOwnPropertyDescriptor(value, key);
          if (descriptor && Object.hasOwn(descriptor, "value")) {
            const n = finite(descriptor.value); if (n !== null) record.assets[key] = n;
          }
        } catch { counters.observerErrors++; }
      },
      response(res, status) {
        record.responseStatus = Number.isSafeInteger(status) && status >= 100 && status <= 599 ? status : null;
        record.headerReadyMs = elapsed(startedAt, clock());
        try {
          if (res?.headersSent) return;
          if (record.traceId !== null) res.setHeader?.("X-Document-Trace", record.traceId);
          const spans = Object.entries(record.phases).filter(([,n]) => n !== null).map(([k,n]) => `${k};dur=${n}`);
          if (record.headerReadyMs !== null) spans.push(`header_ready;dur=${record.headerReadyMs}`);
          if (spans.length) res.setHeader?.("Server-Timing", spans.join(", "));
        } catch { counters.observerErrors++; }
      }
    });
    try { const result = await operation(timing); record.outcome = "completed"; return result; }
    catch (error) { record.outcome = "failed"; throw error; }
    finally {
      record.elapsedMs = elapsed(startedAt, clock()); counters.finished++;
      records.push(snapshot(record)); if (records.length > maxRecords) records.shift(); emit(record);
    }
  }
  return Object.freeze({ run, markRequest, status: () => ({ ...counters, maxRecords, maxLogsPerMinute, recent: records.map(snapshot) }) });
}
module.exports = { createPrivateDocumentDiagnostics };
