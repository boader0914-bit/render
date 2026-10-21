"use strict";

const { AsyncLocalStorage, AsyncResource } = require("node:async_hooks");

function fault(code, name = "Error") { return Object.assign(new Error(code), { code, name }); }
const aborted = () => fault("ANALYTICAL_WORK_ABORTED", "AbortError");

// Own the complete allocation lifetime, not just a source read. Callers must
// await their nested work and must acquire this lease BEFORE a writer lock.
// Memory admission never waits while owning a lease or a caller's large data.
function createAnalyticalWorkScheduler({ foregroundBurst = 4, sampleMemory = null,
  highWatermark = 0.65, lowWatermark = 0.55, resumeSamples = 2,
  sampleIntervalMs = 1000, maxSampleAgeMs = 10000, now = Date.now,
  setTimeoutImpl = setTimeout, clearTimeoutImpl = clearTimeout } = {}) {
  if (!Number.isSafeInteger(foregroundBurst) || foregroundBurst < 1
    || sampleMemory !== null && typeof sampleMemory !== "function"
    || !Number.isFinite(highWatermark) || highWatermark <= 0 || highWatermark > 1
    || !Number.isFinite(lowWatermark) || lowWatermark < 0 || lowWatermark >= highWatermark
    || !Number.isSafeInteger(resumeSamples) || resumeSamples < 1
    || !Number.isSafeInteger(sampleIntervalMs) || sampleIntervalMs < 1
    || !Number.isSafeInteger(maxSampleAgeMs) || maxSampleAgeMs < sampleIntervalMs
    || typeof now !== "function" || typeof setTimeoutImpl !== "function" || typeof clearTimeoutImpl !== "function") {
    throw new TypeError("Invalid analytical scheduler options");
  }
  const context = new AsyncLocalStorage(), foreground = [], background = [], idleWaiters = [];
  let active = null, closed = false, consecutiveForeground = 0, timer = null, sampling = null;
  let lastAttemptAt = null, sampleSequence = 0, admittedSampleSequence = 0;
  const memory = { enabled: sampleMemory !== null, paused: false, pauseReason: null,
    errorCode: null, ratio: null, sampledAt: null, lowSamples: 0 };
  const timestamp = () => {
    const value = Number(now());
    if (!Number.isFinite(value)) throw fault("ANALYTICAL_WORK_CLOCK_INVALID");
    return value;
  };
  const memoryStatus = () => ({ ...memory, highWatermark, lowWatermark, resumeSamples });
  function settleIdle() { if (!active) for (const resolve of idleWaiters.splice(0)) resolve(); }
  function clearPoll() { if (timer !== null) clearTimeoutImpl(timer); timer = null; }
  function poll() {
    if (closed || !sampleMemory || !background.length || timer !== null) return;
    timer = setTimeoutImpl(() => { timer = null; pump(); }, sampleIntervalMs);
    timer?.unref?.();
  }
  function pause(reason, code = null) {
    memory.paused = true; memory.pauseReason = reason; memory.errorCode = code; memory.lowSamples = 0;
  }
  async function inspect() {
    if (!sampleMemory) return memoryStatus();
    if (sampling) return sampling;
    sampling = (async () => {
      try {
        lastAttemptAt = timestamp();
        const sample = await sampleMemory();
        const at = sample?.sampledAt === undefined ? timestamp() : Number(sample.sampledAt);
        const ratio = Number(sample?.ratio), age = timestamp() - at;
        if (!sample || typeof sample.ratio !== "number" || !Number.isFinite(ratio) || ratio < 0
          || !Number.isFinite(at) || age < -1000) throw fault("ANALYTICAL_MEMORY_SAMPLE_INVALID");
        if (age > maxSampleAgeMs) throw fault("ANALYTICAL_MEMORY_SAMPLE_STALE");
        memory.ratio = ratio; memory.sampledAt = at; memory.errorCode = null;
        if (ratio >= highWatermark) pause("memory_pressure");
        else if (memory.paused) {
          memory.lowSamples = ratio <= lowWatermark ? memory.lowSamples + 1 : 0;
          if (memory.lowSamples >= resumeSamples) {
            memory.paused = false; memory.pauseReason = null; memory.lowSamples = 0;
          }
        } else { memory.pauseReason = null; memory.lowSamples = 0; }
      } catch (error) {
        const code = ["ANALYTICAL_MEMORY_SAMPLE_STALE", "ANALYTICAL_MEMORY_SAMPLE_INVALID"].includes(error?.code)
          ? error.code : "ANALYTICAL_MEMORY_SAMPLE_FAILED";
        pause(code === "ANALYTICAL_MEMORY_SAMPLE_STALE" ? "memory_sample_stale" : "memory_sample_failed", code);
      }
      sampleSequence++;
      return memoryStatus();
    })();
    try { return await sampling; }
    finally { sampling = null; }
  }
  function fresh() {
    return !sampleMemory || memory.sampledAt !== null && timestamp() - memory.sampledAt <= maxSampleAgeMs;
  }
  function launch(task) {
    task.cleanup();
    if (task.signal?.aborted) { task.reject(aborted()); pump(); return; }
    clearPoll();
    const controller = new AbortController();
    const onAbort = () => controller.abort(task.signal?.reason);
    task.signal?.addEventListener("abort", onAbort, { once: true });
    const token = { controller, active: true, priority: task.priority, kind: task.kind };
    active = token;
    if (task.priority === "foreground") consecutiveForeground++;
    else { consecutiveForeground = 0; admittedSampleSequence = sampleSequence; }
    const info = { signal: controller.signal, priority: task.priority, kind: task.kind };
    Promise.resolve().then(() => task.invoke(token, info)).then(task.resolve, task.reject).finally(() => {
      token.active = false; task.signal?.removeEventListener("abort", onAbort);
      if (active === token) active = null;
      settleIdle(); pump();
    });
  }
  function pump() {
    if (closed || active) return;
    const canBackground = background.length && !sampling && fresh() && !memory.paused;
    if (foreground.length && (!canBackground || consecutiveForeground < foregroundBurst)) return launch(foreground.shift());
    // Revalidate memory before background admission. Sampling is deliberately
    // outside the lease; a foreground request can pass a slow sample call.
    if (background.length && sampleMemory && (lastAttemptAt === null || timestamp() - lastAttemptAt >= sampleIntervalMs
      || !memory.paused && sampleSequence <= admittedSampleSequence)) {
      if (!sampling) inspect().finally(() => { pump(); poll(); });
      if (foreground.length) return launch(foreground.shift());
      poll(); return;
    }
    if (canBackground) return launch(background.shift());
    if (foreground.length) return launch(foreground.shift());
    poll();
  }
  function run(operation, { priority = "foreground", kind = "analysis", signal, detached = false } = {}) {
    if (typeof operation !== "function" || !["foreground", "background"].includes(priority)
      || typeof kind !== "string" || !/^[A-Za-z0-9_:-]{1,80}$/.test(kind) || typeof detached !== "boolean"
      || signal !== undefined && (!signal || typeof signal.addEventListener !== "function" || typeof signal.removeEventListener !== "function")) {
      return Promise.reject(new TypeError("Invalid analytical work"));
    }
    if (closed) return Promise.reject(fault("ANALYTICAL_WORK_CLOSED"));
    if (signal?.aborted) return Promise.reject(aborted());
    const owner = context.getStore();
    // Durable queue dispatch inherits its creator's async context but owns a
    // NEW lifetime. Enqueue detached work without awaiting it inside the owner;
    // otherwise it would wait for the lease that its own caller still holds.
    if (!detached && owner?.active && active === owner) return Promise.resolve().then(() => operation({ signal: owner.controller.signal, priority: owner.priority, kind }));
    return new Promise((resolve, reject) => {
      const queue = priority === "foreground" ? foreground : background;
      // A queued task may be pumped by another collection lane. Restore the
      // enqueuing caller's other async stores before assigning our new owner.
      const invoke = AsyncResource.bind((token, info) => context.run(token, () => operation(info)));
      const task = { invoke, priority, kind, signal, resolve, reject, cleanup: () => signal?.removeEventListener("abort", onAbort) };
      const onAbort = () => {
        const index = queue.indexOf(task);
        if (index !== -1) { queue.splice(index, 1); task.cleanup(); reject(aborted()); if (!background.length) clearPoll(); pump(); }
      };
      queue.push(task); signal?.addEventListener("abort", onAbort, { once: true }); pump();
    });
  }
  async function checkpointPressure() {
    // It is an inspection, never a heap-retaining low-memory wait. The owner
    // may release its data and durably requeue at a safe allocation boundary.
    return inspect();
  }
  function status() {
    return { closed, active: Boolean(active), activePriority: active?.priority || null, activeKind: active?.kind || null,
      queuedForeground: foreground.length, queuedBackground: background.length, sampling: Boolean(sampling), memory: memoryStatus() };
  }
  async function close() {
    closed = true; clearPoll();
    for (const task of [...foreground.splice(0), ...background.splice(0)]) { task.cleanup(); task.reject(fault("ANALYTICAL_WORK_CLOSED")); }
    active?.controller.abort(fault("ANALYTICAL_WORK_CLOSED"));
    if (active) await new Promise(resolve => idleWaiters.push(resolve));
  }
  return { run, status, close, checkpointPressure };
}

module.exports = { createAnalyticalWorkScheduler };
