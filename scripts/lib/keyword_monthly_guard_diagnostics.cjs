"use strict";

// Fixed diagnostic vocabulary only. Never return arbitrary error text, task
// identities, paths, environment values or an owner/lease token to a caller.
const REASONS = Object.freeze({
  scheduler: new Set(["external_checking", "maintenance", "checkpoint_reader_active", "atomic_work",
    "ineligible_owner", "child_window_closed", "owner_changed", "checkpoint_context_mismatch",
    "scheduler_closed", "checkpoint_aborted", "owner_aborted", "checkpoint_expired",
    "checkpoint_clock_invalid", "reservation_changed", "saved_permit_busy"]),
  memory: new Set(["high_watermark", "low_watermark_recovery_pending", "hysteresis_middle_pressure",
    "sample_read_failed", "sample_invalid", "sample_stale", "sample_future", "clock_invalid"]),
  saved_read: new Set(["response_window_closed", "response_flight_settled"])
});
const ACTIVE_KINDS = new Set(["industry-build", "company-month", "company-month-repair",
  "keyword_monthly_refresh", "keyword_monthly_saved_read", "keyword_monthly_analysis",
  "source-options", "source-catalog", "verified-company-catalog"]);
const MEMORY_COMPONENT_FIELDS = Object.freeze(["heapUsedBytes", "heapLimitBytes", "heapRatio", "liveAllocationRatio", "estimatedLiveBytes", "limitBytes", "rssBytes"]);
const finiteNonnegative = value => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
function observedAt(value) {
  try {
    if (typeof value === "number" && Number.isFinite(value)) return new Date(value).toISOString();
    if (typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(value)
      && Number.isFinite(Date.parse(value))) return value;
  } catch {}
  return null;
}
function sanitizeKeywordMonthlyGuardDiagnostic(value) {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value) || typeof value.component !== "string" || typeof value.reason !== "string"
      || !Object.hasOwn(REASONS, value.component) || !REASONS[value.component].has(value.reason)) return null;
    const result = { version: 1, component: value.component, reason: value.reason,
      observedAt: observedAt(value.observedAt),
      activeKind: value.activeKind == null ? null : ACTIVE_KINDS.has(value.activeKind) ? value.activeKind : "other" };
    if (value.component === "memory") {
      const memory = value.memory;
      const components = {};
      for (const key of MEMORY_COMPONENT_FIELDS) try { if (Object.hasOwn(memory || {}, key)) components[key] = finiteNonnegative(memory[key]); }
      catch { components[key] = null; }
      result.memory = Object.freeze({ sampledAt: finiteNonnegative(memory?.sampledAt), ratio: finiteNonnegative(memory?.ratio),
        paused: typeof memory?.paused === "boolean" ? memory.paused : null,
        lowSamples: Number.isSafeInteger(memory?.lowSamples) && memory.lowSamples >= 0 && memory.lowSamples <= 10 ? memory.lowSamples : null, ...components });
    }
    if (value.component === "scheduler") {
      const flags = value.flags;
      result.flags = Object.freeze(Object.fromEntries(["externalChecking", "maintenancePaused", "checkpointReaderActive", "atomicWork", "ownerMatches"]
        .map(key => [key, typeof flags?.[key] === "boolean" ? flags[key] : null])));
    }
    return Object.freeze(result);
  } catch { return null; }
}
function withKeywordMonthlyGuardDiagnostic(error, value) {
  // Diagnostic failure must never replace the original denial or alter policy.
  try {
    const at = value.observedAt === undefined ? Date.now() : value.observedAt;
    const safe = sanitizeKeywordMonthlyGuardDiagnostic({ ...value, observedAt: at });
    if (safe) error.readGuard = safe;
  } catch {}
  return error;
}
function keywordMonthlyGuardDiagnosticFromError(error) {
  try { return sanitizeKeywordMonthlyGuardDiagnostic(error?.readGuard); }
  catch { return null; }
}
module.exports = { sanitizeKeywordMonthlyGuardDiagnostic, withKeywordMonthlyGuardDiagnostic, keywordMonthlyGuardDiagnosticFromError, MEMORY_COMPONENT_FIELDS };
