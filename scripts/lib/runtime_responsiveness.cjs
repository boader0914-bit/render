"use strict";

const { monitorEventLoopDelay } = require("node:perf_hooks");

// Process-only diagnostics. No request, account, company or result is retained.
// Nanosecond histogram readings are reported as milliseconds in explicit windows.
function createRuntimeResponsiveness({ enabled = true, resolutionMs = 20, sampleIntervalMs = 30000, historyLimit = 8,
  monitor = monitorEventLoopDelay, now = Date.now, uptime = () => process.uptime(),
  setIntervalImpl = setInterval, clearIntervalImpl = clearInterval } = {}) {
  if (typeof enabled !== "boolean" || !Number.isSafeInteger(resolutionMs) || resolutionMs < 1 || resolutionMs > 1000
    || !Number.isSafeInteger(sampleIntervalMs) || sampleIntervalMs < resolutionMs || sampleIntervalMs > 300000
    || !Number.isSafeInteger(historyLimit) || historyLimit < 0 || historyLimit > 32
    || [monitor, now, uptime, setIntervalImpl, clearIntervalImpl].some(value => typeof value !== "function")) throw TypeError("Invalid runtime responsiveness options");
  let histogram = null, timer = null, closed = false, available = false, errorCode = null;
  const history = [];
  const finite = value => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
  function time() { try { return finite(Number(now())); } catch { return null; } }
  function processUptime() { try { return finite(uptime()); } catch { return null; } }
  let windowStartedAt = time();
  function measurement(at) {
    let count = null, max = null, mean = null, p99 = null;
    if (available && histogram) {
      try { const value = histogram.count; count = typeof value === "bigint" ? value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : null : Number.isSafeInteger(value) && value >= 0 ? value : null; } catch {}
      // Empty native histograms have a sentinel minimum and a NaN mean. They
      // cannot be represented as a measured 0ms delay.
      if (count !== null && count > 0) {
        try { const value = finite(histogram.max); max = value === null ? null : value / 1e6; } catch {}
        try { const value = finite(histogram.mean); mean = value === null ? null : value / 1e6; } catch {}
        try { const value = finite(histogram.percentile(99)); p99 = value === null ? null : value / 1e6; } catch {}
      }
    }
    return { windowStartedAt, windowEndedAt: at, windowDurationMs: at !== null && windowStartedAt !== null ? Math.max(0, at - windowStartedAt) : null,
      sampleCount: count, maxMs: max, p99Ms: p99, meanMs: mean };
  }
  function stop() {
    if (timer !== null) { try { clearIntervalImpl(timer); } catch {} timer = null; }
    const previous = histogram; histogram = null;
    if (previous) { try { previous.disable(); } catch {} }
    available = false;
  }
  function sample() {
    if (closed || !available) return;
    const at = time(), value = measurement(at);
    if (historyLimit) { history.push(value); if (history.length > historyLimit) history.splice(0, history.length - historyLimit); }
    try { histogram.reset(); windowStartedAt = at; }
    catch { errorCode = "EVENT_LOOP_MONITOR_RESET_FAILED"; stop(); }
  }
  if (enabled) {
    try {
      histogram = monitor({ resolution: resolutionMs });
      if (!histogram || typeof histogram.enable !== "function" || typeof histogram.disable !== "function" || typeof histogram.reset !== "function") throw Error("Monitor unavailable");
      histogram.enable(); available = true;
      timer = setIntervalImpl(sample, sampleIntervalMs);
      if (typeof timer?.unref === "function") timer.unref();
    } catch { errorCode = "EVENT_LOOP_MONITOR_UNAVAILABLE"; stop(); }
  }
  return {
    status() {
      const at = time();
      return { state: closed ? "closed" : !enabled ? "disabled" : available ? "monitoring" : "unavailable", enabled: enabled && available && !closed,
        resolutionMs, sampleIntervalMs, historyLimit, sampledAt: at, uptimeSeconds: processUptime(), errorCode,
        eventLoop: measurement(at), history: history.map(value => ({ ...value })) };
    },
    close() { if (closed) return; closed = true; stop(); }
  };
}

module.exports = { createRuntimeResponsiveness };
