"use strict";
const { AsyncLocalStorage } = require("node:async_hooks");
const { createAnalyticalMemorySampler } = require("./analytical_memory.cjs");
const contexts = new AsyncLocalStorage();
const LARGE_PHASES = new Set(["keyword_projection_read", "keyword_source_validate", "keyword_snapshot_current",
  "keyword_snapshot_previous", "keyword_compare", "keyword_prepared_result_read", "keyword_prepared_result_parse"]);
const fault = code => Object.assign(new Error(code), { code, statusCode: 503, deferred: true });

// This is fail-fast admission at allocation boundaries, never a memory wait
// holding a decoded graph or the application's analytical execution lease.
// The existing 65/55 percent hysteresis is retained. Sampling is an estimate,
// not a promise that an arbitrary subsequent allocation fits.
function createKeywordMonthlyMemoryAdmission({ sampleMemory, now = Date.now,
  highWatermark = 0.65, lowWatermark = 0.55, resumeSamples = 2, maxSampleAgeMs = 10000 } = {}) {
  if (sampleMemory === undefined) sampleMemory = createAnalyticalMemorySampler().sample;
  if (typeof sampleMemory !== "function" || typeof now !== "function"
    || !Number.isFinite(highWatermark) || highWatermark <= 0 || highWatermark > 1
    || !Number.isFinite(lowWatermark) || lowWatermark < 0 || lowWatermark >= highWatermark
    || !Number.isSafeInteger(resumeSamples) || resumeSamples < 1 || resumeSamples > 10
    || !Number.isSafeInteger(maxSampleAgeMs) || maxSampleAgeMs < 1) throw new TypeError("Invalid keyword memory admission");
  const instance = Symbol("keyword-memory-admission");
  const state = { paused: false, ratio: null, lowSamples: 0, sampledAt: null,
    samples: 0, admitted: 0, deferred: 0, unavailable: 0, checkpoints: 0 };
  async function inspect() {
    let sample, at;
    try {
      sample = await sampleMemory(); at = Number(now());
      if (!sample || typeof sample.ratio !== "number" || !Number.isFinite(sample.ratio) || sample.ratio < 0
        || !Number.isFinite(at) || !Number.isFinite(sample.sampledAt)
        || at - sample.sampledAt > maxSampleAgeMs || sample.sampledAt - at > 1000) throw Error();
    } catch {
      state.paused = true; state.ratio = null; state.lowSamples = 0; state.sampledAt = null;
      state.unavailable++; throw fault("KEYWORD_MONTHLY_MEMORY_UNAVAILABLE");
    }
    state.samples++; state.ratio = sample.ratio; state.sampledAt = sample.sampledAt;
    if (sample.ratio >= highWatermark) { state.paused = true; state.lowSamples = 0; }
    else if (state.paused) {
      state.lowSamples = sample.ratio <= lowWatermark ? state.lowSamples + 1 : 0;
      if (state.lowSamples >= resumeSamples) { state.paused = false; state.lowSamples = 0; }
    }
    if (state.paused) { state.deferred++; throw fault("KEYWORD_MONTHLY_MEMORY_DEFERRED"); }
  }
  async function run(operation) {
    if (typeof operation !== "function") throw new TypeError("Keyword read must be a function");
    const inherited = contexts.getStore();
    if (inherited?.active && inherited.instance === instance) { await inherited.check(); return operation(); }
    await inspect(); state.admitted++;
    const owner = { active: true, instance, async check() { state.checkpoints++; await inspect(); } };
    try { return await contexts.run(owner, operation); }
    finally { owner.active = false; }
  }
  return Object.freeze({ run, status: () => ({ ...state, highWatermark, lowWatermark, resumeSamples, maxSampleAgeMs }) });
}
async function keywordMonthlyAllocationCheckpoint(phase) {
  const owner = contexts.getStore();
  if (LARGE_PHASES.has(phase) && owner?.active) await owner.check();
}
let shared;
function runKeywordMonthlyMemoryAdmission(operation) {
  shared ||= createKeywordMonthlyMemoryAdmission();
  return shared.run(operation);
}
module.exports = { createKeywordMonthlyMemoryAdmission, keywordMonthlyAllocationCheckpoint, runKeywordMonthlyMemoryAdmission };
