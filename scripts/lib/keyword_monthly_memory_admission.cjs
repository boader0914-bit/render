"use strict";
const { AsyncLocalStorage } = require("node:async_hooks");
const { createAnalyticalMemorySampler } = require("./analytical_memory.cjs");
const { withKeywordMonthlyGuardDiagnostic, MEMORY_COMPONENT_FIELDS } = require("./keyword_monthly_guard_diagnostics.cjs");
const contexts = new AsyncLocalStorage();
const LARGE_PHASES = new Set(["keyword_projection_read", "keyword_source_validate", "keyword_snapshot_current",
  "keyword_snapshot_previous", "keyword_compare", "keyword_prepared_result_read", "keyword_prepared_result_parse"]);
const fault = code => Object.assign(new Error(code), { code, statusCode: 503, deferred: true });
function numericComponents(value) {
  const result = {};
  for (const key of MEMORY_COMPONENT_FIELDS) try { if (Object.hasOwn(value || {}, key)) {
    const number = value[key]; result[key] = typeof number === "number" && Number.isFinite(number) && number >= 0 ? number : null;
  } } catch { result[key] = null; }
  return result;
}

// This is fail-fast admission at allocation boundaries, never a memory wait
// holding a decoded graph or the application's analytical execution lease.
// The existing 65/55 percent hysteresis is retained. Sampling is an estimate,
// not a promise that an arbitrary subsequent allocation fits.
function createKeywordMonthlyMemoryAdmission({ sampleMemory, now = Date.now,
  highWatermark = 0.65, lowWatermark = 0.55, resumeSamples = 2, maxSampleAgeMs = 10000 } = {}) {
  if (sampleMemory === undefined) {
    const sampler = createAnalyticalMemorySampler();
    sampleMemory = () => {
      const sample = sampler.sample(), ratio = sample?.ratio, sampledAt = sample?.sampledAt; let components = {};
      // Read the already-cached details of this exact sample, never sample a
      // second time. Optional observation failure cannot change admission.
      try { const detail = sampler.status(); if (detail?.sampledAt === sampledAt) components = numericComponents(detail); } catch {}
      return { ratio, sampledAt, ...components };
    };
  }
  if (typeof sampleMemory !== "function" || typeof now !== "function"
    || !Number.isFinite(highWatermark) || highWatermark <= 0 || highWatermark > 1
    || !Number.isFinite(lowWatermark) || lowWatermark < 0 || lowWatermark >= highWatermark
    || !Number.isSafeInteger(resumeSamples) || resumeSamples < 1 || resumeSamples > 10
    || !Number.isSafeInteger(maxSampleAgeMs) || maxSampleAgeMs < 1) throw new TypeError("Invalid keyword memory admission");
  const instance = Symbol("keyword-memory-admission");
  const state = { paused: false, ratio: null, lowSamples: 0, sampledAt: null, reason: null,
    samples: 0, admitted: 0, deferred: 0, unavailable: 0, checkpoints: 0 };
  let components = {};
  const denied = (code, at) => withKeywordMonthlyGuardDiagnostic(fault(code), {
    component: "memory", reason: state.reason, observedAt: at, activeKind: null,
    memory: { sampledAt: state.sampledAt, ratio: state.ratio, paused: state.paused, lowSamples: state.lowSamples, ...components }
  });
  async function inspect() {
    let sample, core, at, unavailableReason = "sample_read_failed";
    try {
      sample = await sampleMemory(); unavailableReason = "clock_invalid"; at = Number(now()); unavailableReason = "sample_invalid";
      const ratio = sample?.ratio, sampledAt = sample?.sampledAt;
      if (!sample || typeof ratio !== "number" || !Number.isFinite(ratio) || ratio < 0
        || !Number.isFinite(at) || !Number.isFinite(sampledAt)
        || at - sampledAt > maxSampleAgeMs || sampledAt - at > 1000) {
        unavailableReason = !Number.isFinite(at) ? "clock_invalid"
          : !sample || typeof ratio !== "number" || !Number.isFinite(ratio) || ratio < 0 || !Number.isFinite(sampledAt) ? "sample_invalid"
            : at - sampledAt > maxSampleAgeMs ? "sample_stale" : sampledAt - at > 1000 ? "sample_future" : "sample_invalid";
        throw Error();
      }
      core = { ratio, sampledAt };
    } catch {
      state.paused = true; state.ratio = null; state.lowSamples = 0; state.sampledAt = null;
      components = Object.fromEntries(Object.keys(components).map(key => [key, null]));
      state.reason = unavailableReason;
      state.unavailable++; throw denied("KEYWORD_MONTHLY_MEMORY_UNAVAILABLE", at ?? null);
    }
    const { ratio, sampledAt } = core;
    state.samples++; state.ratio = ratio; state.sampledAt = sampledAt;
    const observed = numericComponents(sample);
    components = Object.keys(components).length || Object.keys(observed).length
      ? Object.fromEntries(MEMORY_COMPONENT_FIELDS.map(key => [key, observed[key] ?? null])) : {};
    if (ratio >= highWatermark) { state.paused = true; state.lowSamples = 0; state.reason = "high_watermark"; }
    else if (state.paused) {
      state.lowSamples = ratio <= lowWatermark ? state.lowSamples + 1 : 0;
      state.reason = ratio <= lowWatermark ? "low_watermark_recovery_pending" : "hysteresis_middle_pressure";
      if (state.lowSamples >= resumeSamples) { state.paused = false; state.lowSamples = 0; state.reason = null; }
    } else state.reason = null;
    if (state.paused) { state.deferred++; throw denied("KEYWORD_MONTHLY_MEMORY_DEFERRED", at); }
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
  return Object.freeze({ run, status: () => ({ ...state, ...components, highWatermark, lowWatermark, resumeSamples, maxSampleAgeMs }) });
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
function readKeywordMonthlyMemoryAdmissionState() {
  // Inspecting this state never creates a sampler, samples memory or resumes it.
  const value = shared?.status();
  return Object.freeze({ initialized: Boolean(value), sampledAt: value?.sampledAt ?? null, ratio: value?.ratio ?? null,
    paused: value?.paused ?? null, lowSamples: value?.lowSamples ?? null, reason: value?.reason ?? null, ...numericComponents(value) });
}
module.exports = { createKeywordMonthlyMemoryAdmission, keywordMonthlyAllocationCheckpoint, runKeywordMonthlyMemoryAdmission, readKeywordMonthlyMemoryAdmissionState };
