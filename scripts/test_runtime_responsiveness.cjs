"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { createRuntimeResponsiveness } = require("./lib/runtime_responsiveness.cjs");
function fixture(options = {}) {
  let at = 1000, tick, enabled = 0, disabled = 0, resets = 0, unrefs = 0, cleared = 0;
  const histogram = { count: 0, max: 0, mean: NaN, percentile: () => 0, enable() { enabled++; }, disable() { disabled++; }, reset() { resets++; this.count = 0; this.max = 0; this.mean = NaN; } };
  const timer = { unref() { unrefs++; } };
  const diagnostics = createRuntimeResponsiveness({ monitor: input => { assert.deepEqual(input, { resolution: 20 }); return histogram; }, now: () => at, uptime: () => 12.5,
    setIntervalImpl: (callback, interval) => { assert.equal(interval, 30000); tick = callback; return timer; }, clearIntervalImpl: value => { assert.equal(value, timer); cleared++; }, ...options });
  return { diagnostics, histogram, advance: value => { at += value; }, tick: () => tick(), counts: () => ({ enabled, disabled, resets, unrefs, cleared }) };
}

test("uninitialized measurements stay null and monitor lifecycle is bounded and explicit", () => {
  const f = fixture(), state = f.diagnostics.status();
  assert.equal(state.state, "monitoring"); assert.equal(state.enabled, true); assert.equal(state.uptimeSeconds, 12.5); assert.equal(state.sampledAt, 1000);
  assert.deepEqual(state.eventLoop, { windowStartedAt: 1000, windowEndedAt: 1000, windowDurationMs: 0, sampleCount: 0, maxMs: null, p99Ms: null, meanMs: null });
  assert.deepEqual(f.counts(), { enabled: 1, disabled: 0, resets: 0, unrefs: 1, cleared: 0 });
  f.diagnostics.close(); f.diagnostics.close(); f.tick();
  assert.deepEqual(f.counts(), { enabled: 1, disabled: 1, resets: 0, unrefs: 1, cleared: 1 });
  assert.equal(f.diagnostics.status().state, "closed"); assert.equal(f.diagnostics.status().eventLoop.maxMs, null);
});

test("completed thirty-second windows reset the histogram and keep only eight detached numeric samples", () => {
  const f = fixture();
  for (let index = 1; index <= 12; index++) {
    f.histogram.count = BigInt(index); f.histogram.max = index * 1e6; f.histogram.mean = index * 5e5; f.histogram.percentile = () => index * 8e5;
    f.advance(30000); f.tick();
  }
  const state = f.diagnostics.status(); assert.equal(state.history.length, 8); assert.equal(state.history[0].maxMs, 5); assert.equal(state.history.at(-1).maxMs, 12);
  assert.ok(state.history.every(value => value.windowDurationMs === 30000)); assert.equal(state.eventLoop.maxMs, null); assert.equal(state.eventLoop.sampleCount, 0);
  assert.equal(state.eventLoop.windowStartedAt, 361000); assert.equal(f.counts().resets, 12);
  state.history[0].maxMs = 999; state.history.push({ secret: "caller value" });
  assert.equal(f.diagnostics.status().history.length, 8); assert.equal(f.diagnostics.status().history[0].maxMs, 5);
  f.diagnostics.close();
});

test("invalid or unavailable readings never become NaN, infinity or a fabricated zero", () => {
  const f = fixture({ now: () => NaN, uptime: () => Infinity }); f.histogram.count = 2;
  f.histogram.max = Infinity; f.histogram.mean = -1; f.histogram.percentile = () => { throw Error("no percentile"); };
  const state = f.diagnostics.status(); assert.equal(state.sampledAt, null); assert.equal(state.uptimeSeconds, null);
  assert.deepEqual(state.eventLoop, { windowStartedAt: null, windowEndedAt: null, windowDurationMs: null, sampleCount: 2, maxMs: null, p99Ms: null, meanMs: null });
  f.histogram.count = 1; f.histogram.max = 0; f.histogram.mean = 0; f.histogram.percentile = () => 0;
  assert.equal(f.diagnostics.status().eventLoop.maxMs, 0, "a measured real zero remains distinct from unavailable"); f.diagnostics.close();
});

test("disabled or unavailable monitoring starts no background timer and exposes no invented measurement", () => {
  let monitors = 0, timers = 0;
  const disabled = createRuntimeResponsiveness({ enabled: false, monitor: () => { monitors++; }, setIntervalImpl: () => { timers++; } });
  assert.equal(disabled.status().state, "disabled"); assert.equal(disabled.status().eventLoop.maxMs, null); disabled.close();
  const unavailable = createRuntimeResponsiveness({ monitor: () => { monitors++; throw Error("private failure"); }, setIntervalImpl: () => { timers++; } });
  assert.equal(unavailable.status().state, "unavailable"); assert.equal(unavailable.status().errorCode, "EVENT_LOOP_MONITOR_UNAVAILABLE"); assert.equal(unavailable.status().eventLoop.sampleCount, null);
  assert.equal(monitors, 1); assert.equal(timers, 0); assert.ok(!JSON.stringify(unavailable.status()).includes("private failure")); unavailable.close();
});

test("histogram reset failure disables the monitor and releases its timer", () => {
  const f = fixture(); f.histogram.count = 1; f.histogram.max = 1e6; f.histogram.mean = 1e6; f.histogram.reset = () => { throw Error("reset unavailable"); };
  f.advance(30000); f.tick(); const state = f.diagnostics.status();
  assert.equal(state.state, "unavailable"); assert.equal(state.errorCode, "EVENT_LOOP_MONITOR_RESET_FAILED"); assert.equal(state.history[0].maxMs, 1); assert.equal(state.eventLoop.maxMs, null);
  assert.equal(f.counts().cleared, 1); assert.equal(f.counts().disabled, 1); f.diagnostics.close();
});

test("option validation prevents unbounded cadence or history and accepts a zero history budget", () => {
  for (const options of [{ historyLimit: 33 }, { historyLimit: -1 }, { sampleIntervalMs: 300001 }, { sampleIntervalMs: 1 }, { resolutionMs: 0 }, { resolutionMs: 1001 }, { enabled: 1 }, { monitor: null }, { now: null }]) assert.throws(() => createRuntimeResponsiveness(options), TypeError);
  const f = fixture({ historyLimit: 0 }); f.histogram.count = 1; f.advance(30000); f.tick(); assert.deepEqual(f.diagnostics.status().history, []); f.diagnostics.close();
});
