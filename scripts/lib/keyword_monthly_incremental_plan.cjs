"use strict";
const H = require("./keyword_monthly_refresh_preparation.cjs");
const VERSION = "keyword-monthly-incremental-v5", MAX_SCOPES = 128;
function planScopes({ state, catalog, evidence, range, capturedAt, inputsFingerprint }) {
  const dirty = new Set(state.dirtyKeywords || []), wanted = new Map(), add = (keyword, month, reason) => {
    H.need(typeof keyword === "string" && keyword.length > 0 && keyword.length <= 160 && !/[\u0000-\u001f\u007f]/.test(keyword) && H.MONTH.test(month), "KEYWORD_INCREMENTAL_SCOPE_INVALID");
    const key = H.scopeId({ keyword, month }), old = wanted.get(key); if (old) { if (!old.reasons.includes(reason)) old.reasons.push(reason); } else wanted.set(key, { keyword, month, reasons: [reason] });
  };
  const global = state.globalDiagnosticsDirty === true || state.staticInputsFingerprint !== inputsFingerprint;
  for (const scope of catalog.scopes) if (global || dirty.has(scope.keyword)) add(scope.keyword, scope.month, global ? "verified_global_dependency_change" : "changed_company_or_observation_dependency");
  for (const month of new Set([...range.stayMonths, range.collectionMonth])) {
    add(evidence.keyword, month, "completed_run_recorded_month");
    const next = H.nextMonth(month); if (catalog.scopes.some(s => s.keyword === evidence.keyword && s.month === next)) add(evidence.keyword, next, "previous_month_comparison_dependency");
  }
  // A changed company's keyword may not yet have an exposed current scope.
  // New actual run dates/ranges, rather than a synthetic today's date, define it.
  for (const run of state.runs || []) if ((global || dirty.has(run.keyword)) && run.collectedAtSource !== "filesystem" && Number.isFinite(Date.parse(run.collectedAt))) {
    const quality = typeof run.collectionQuality === "string" ? run.collectionQuality : run.collectionQuality?.status;
    if (quality !== undefined && !["complete", "reused", "partial"].includes(quality)) continue;
    const collectionMonth = new Date(Date.parse(run.collectedAt) + 9 * 3600000).toISOString().slice(0, 7);
    add(run.keyword, collectionMonth, "actual_rank_run_month");
    const start = Date.parse(run.checkIn + "T00:00:00Z"), days = Number(run.bookingRangeDays);
    if (Number.isFinite(start) && Number.isSafeInteger(days) && days > 0 && days <= 93) for (let i = 0; i < days; i++) add(run.keyword, new Date(start + i * 86400000).toISOString().slice(0, 7), "actual_run_recorded_stay_month");
  }
  for (const part of state.history?.partitions || []) if (H.MONTH.test(part.month)) for (const keyword of part.keywords || []) if (global || dirty.has(keyword)) add(keyword, part.month, "saved_raw_observation_month");
  H.need(wanted.size > 0 && wanted.size <= MAX_SCOPES, "KEYWORD_INCREMENTAL_SCOPE_FANOUT_BOUND");
  const today = new Date(Date.parse(capturedAt) + 9 * 3600000).toISOString().slice(0, 10);
  const result = [...wanted.values()].sort((a, b) => H.scopeId(a).localeCompare(H.scopeId(b))).map(s => {
    const last = new Date(Date.parse(H.nextMonth(s.month) + "-01T00:00:00Z") - 86400000).toISOString().slice(0, 10);
    return { ...s, cutoffDate: [today, last].sort()[0] };
  });
  return { version: VERSION, scopes: result, globalDependencyChange: global, scopeCount: result.length, calculationBasis: "unchanged_full_calculator_on_dirty_saved_partitions", rawHistoryRescanRequired: false };
}
module.exports = { VERSION, MAX_SCOPES, planScopes };
