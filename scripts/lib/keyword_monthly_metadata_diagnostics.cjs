"use strict";
const { AsyncLocalStorage } = require("node:async_hooks");
// Optional request-local observations only. The bundle does not import an HTTP
// handler, scheduler, source reader, account or global mutable trace registry.
const context = new AsyncLocalStorage();
const METADATA_PHASES = Object.freeze(["conversion_guard", "memory_admission", "catalogue_open", "catalogue_project", "catalogue_revalidate"]);
function withKeywordMonthlyMetadataMeasure(measure, operation) {
  if (typeof measure !== "function" || typeof operation !== "function") throw new TypeError("Metadata observation callbacks required");
  return context.run(measure, operation);
}
function measureKeywordMonthlyMetadata(phase, operation) {
  if (!METADATA_PHASES.includes(phase) || typeof operation !== "function") throw new TypeError("Invalid metadata observation phase");
  const measure = context.getStore();
  return measure ? measure(phase, operation) : operation();
}
module.exports = { METADATA_PHASES, withKeywordMonthlyMetadataMeasure, measureKeywordMonthlyMetadata };
