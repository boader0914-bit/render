"use strict";

const { createAnalyticalPhaseDiagnostics } = require("./analytical_phase_diagnostics.cjs");

// Process-local numeric diagnostics only. No files, credentials, task inputs,
// provider calls, timers, GC, or changes to analytical admission policy.
function createAnalyticalPhaseRuntime({ now = Date.now,
  onLog = event => console.info("analytical_phase_diagnostic", JSON.stringify(event)),
  maxEventsPerWindow = 60, windowMs = 60000, ...diagnosticOptions } = {}) {
  if (typeof now !== "function" || onLog !== null && typeof onLog !== "function"
    || !Number.isSafeInteger(maxEventsPerWindow) || maxEventsPerWindow < 1 || maxEventsPerWindow > 120
    || !Number.isSafeInteger(windowMs) || windowMs < 1000) throw new TypeError("Invalid analytical diagnostic logging");
  let windowAt = null, windowEvents = 0;
  const logging = { emitted: 0, dropped: 0, errors: 0 };
  function record(event) {
    if (onLog === null) return;
    let at;
    try { at = Number(now()); } catch { logging.errors++; return; }
    if (!Number.isFinite(at)) { logging.errors++; return; }
    if (windowAt === null || at < windowAt || at - windowAt >= windowMs) { windowAt = at; windowEvents = 0; }
    if (windowEvents >= maxEventsPerWindow) { logging.dropped++; return; }
    windowEvents++; logging.emitted++;
    try {
      const result = onLog({ processId: process.pid, ...event });
      if (result && typeof result.then === "function") Promise.resolve(result).catch(() => { logging.errors++; });
    } catch { logging.errors++; }
  }
  const diagnostics = createAnalyticalPhaseDiagnostics({ ...diagnosticOptions, now, onRecord: record });
  return Object.freeze({ run: diagnostics.run, measure: diagnostics.measure,
    status: () => ({ ...diagnostics.status(), processId: process.pid, logging: { ...logging, maxEventsPerWindow, windowMs } }) });
}

let shared;
function getAnalyticalPhaseDiagnostics() {
  return shared ||= createAnalyticalPhaseRuntime();
}

module.exports = { createAnalyticalPhaseRuntime, getAnalyticalPhaseDiagnostics };
