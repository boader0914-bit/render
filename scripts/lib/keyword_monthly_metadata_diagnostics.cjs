"use strict";
const { AsyncLocalStorage } = require("node:async_hooks");
const { performance } = require("node:perf_hooks");
// Optional request-local observations only. The bundle does not import an HTTP
// handler, scheduler, source reader, account or global mutable trace registry.
const context = new AsyncLocalStorage();
const METADATA_PHASES = Object.freeze(["conversion_guard", "memory_admission", "catalogue_open", "catalogue_project", "catalogue_revalidate", "version_open", "version_revalidate"]);
const METADATA_FS_PHASES = Object.freeze(["path_queue", "path_check", "lstat", "realpath", "open", "fstat", "read", "close"]);
function withKeywordMonthlyMetadataMeasure(measure, operation, recordFs = null) {
  if (typeof measure !== "function" || typeof operation !== "function") throw new TypeError("Metadata observation callbacks required");
  return context.run({ measure, recordFs: typeof recordFs === "function" ? recordFs : null }, operation);
}
function measureKeywordMonthlyMetadata(phase, operation) {
  if (!METADATA_PHASES.includes(phase) || typeof operation !== "function") throw new TypeError("Invalid metadata observation phase");
  const measure = context.getStore()?.measure;
  return measure ? measure(phase, operation) : operation();
}
function captureKeywordMonthlyMetadataFsObserver() {
  const observe = context.getStore()?.recordFs;
  if (!observe) return null;
  return (phase, ms) => { if (!METADATA_FS_PHASES.includes(phase) || !Number.isFinite(ms) || ms < 0) return;
    try { observe(phase, Math.min(ms, 86400000)); } catch {} };
}
function beginKeywordMonthlyMetadataFs(phase, observer) {
  if (!observer || !METADATA_FS_PHASES.includes(phase)) return () => {};
  let start; try { start = performance.now(); } catch { return () => {}; }
  return () => { try { const end = performance.now(); if (Number.isFinite(start) && Number.isFinite(end) && end >= start) observer(phase, end - start); } catch {} };
}
async function measureKeywordMonthlyMetadataFs(phase, operation, observer) {
  const end = beginKeywordMonthlyMetadataFs(phase, observer);
  try { return await operation(); } finally { end(); }
}
module.exports = { METADATA_PHASES, METADATA_FS_PHASES, withKeywordMonthlyMetadataMeasure, measureKeywordMonthlyMetadata,
  captureKeywordMonthlyMetadataFsObserver, beginKeywordMonthlyMetadataFs, measureKeywordMonthlyMetadataFs };
