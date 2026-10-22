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
  setTimeoutImpl = setTimeout, clearTimeoutImpl = clearTimeout,
  onTaskTiming = null, timingHistoryLimit = 32 } = {}) {
  if (!Number.isSafeInteger(foregroundBurst) || foregroundBurst < 1
    || sampleMemory !== null && typeof sampleMemory !== "function"
    || !Number.isFinite(highWatermark) || highWatermark <= 0 || highWatermark > 1
    || !Number.isFinite(lowWatermark) || lowWatermark < 0 || lowWatermark >= highWatermark
    || !Number.isSafeInteger(resumeSamples) || resumeSamples < 1
    || !Number.isSafeInteger(sampleIntervalMs) || sampleIntervalMs < 1
    || !Number.isSafeInteger(maxSampleAgeMs) || maxSampleAgeMs < sampleIntervalMs
    || typeof now !== "function" || typeof setTimeoutImpl !== "function" || typeof clearTimeoutImpl !== "function"
    || onTaskTiming !== null && typeof onTaskTiming !== "function"
    || !Number.isSafeInteger(timingHistoryLimit) || timingHistoryLimit < 0 || timingHistoryLimit > 128) {
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
  // Diagnostic records contain controlled kind tags and numeric identities,
  // never task inputs, results, exception messages or caller context. Nested
  // reads share their parent's lease: their overlapping wall time is kept
  // separate and must not be added to exclusive occupancy totals.
  let taskSequence = 0, waitClockAt = timestamp();
  const waitKeys = ["busyWaitMs", "memoryWaitMs", "samplingWaitMs", "otherWaitMs"];
  const emptyWait = () => Object.fromEntries(waitKeys.map(key => [key, 0]));
  const waitClocks = { foreground: emptyWait(), background: emptyWait() };
  const timing = { enqueued: 0, started: 0, completed: 0, failed: 0, aborted: 0, closed: 0,
    queueWaitMs: 0, leaseMs: 0, ...emptyWait(), reentrantStarted: 0,
    reentrantCompleted: 0, reentrantFailed: 0, reentrantLeaseMs: 0, callbackErrors: 0 };
  const recent = [];
  function accountWaiting() {
    const at = timestamp(), elapsed = Math.max(0, at - waitClockAt); waitClockAt = at;
    for (const priority of ["foreground", "background"]) {
      if (!(priority === "foreground" ? foreground : background).length) continue;
      // These reasons are disjoint. Busy ownership takes precedence over a
      // memory pause; a pause does not double count time spent behind a lease.
      const key = active ? "busyWaitMs" : priority === "background" && memory.paused ? "memoryWaitMs"
        : priority === "background" && sampling ? "samplingWaitMs" : "otherWaitMs";
      waitClocks[priority][key] += elapsed;
    }
    return at;
  }
  function taskWait(task, until = task.startedAt ?? timestamp()) {
    const waits = Object.fromEntries(waitKeys.map(key => [key, Math.max(0, waitClocks[task.priority][key] - task.waitStart[key])]));
    // A clock tick between removing a queue entry and assigning its lease is
    // dispatch overhead, rather than memory pressure or occupied work.
    waits.otherWaitMs += Math.max(0, until - task.queuedAt - Object.values(waits).reduce((sum, value) => sum + value, 0));
    return waits;
  }
  function errorCode(error) {
    try { const code = error?.code; return typeof code === "string" && /^[A-Z][A-Z0-9_]{1,99}$/.test(code) ? code : "ANALYTICAL_WORK_FAILED"; }
    catch { return "ANALYTICAL_WORK_FAILED"; }
  }
  function recordTask(task, error, finishedAt = timestamp(), didFail = Boolean(error)) {
    const waits = task.reentrant ? emptyWait() : task.waits || taskWait(task, finishedAt);
    const code = didFail ? errorCode(error) : null;
    const outcome = !didFail ? "completed" : code === "ANALYTICAL_WORK_ABORTED" ? "aborted"
      : code === "ANALYTICAL_WORK_CLOSED" ? "closed" : "failed";
    const record = Object.freeze({ id: task.id, parentId: task.parentId || null, kind: task.kind, priority: task.priority,
      reentrant: Boolean(task.reentrant), queuedAt: task.queuedAt, startedAt: task.startedAt ?? null, finishedAt,
      queueWaitMs: task.reentrant ? 0 : Math.max(0, (task.startedAt ?? finishedAt) - task.queuedAt),
      leaseMs: task.startedAt === undefined ? 0 : Math.max(0, finishedAt - task.startedAt),
      ...waits, outcome, errorCode: code });
    if (task.reentrant) {
      timing.reentrantCompleted += !didFail ? 1 : 0; timing.reentrantFailed += didFail ? 1 : 0;
      timing.reentrantLeaseMs += record.leaseMs;
    } else {
      timing[outcome]++; timing.queueWaitMs += record.queueWaitMs; timing.leaseMs += record.leaseMs;
      for (const key of waitKeys) timing[key] += record[key];
    }
    if (timingHistoryLimit) { recent.push(record); if (recent.length > timingHistoryLimit) recent.shift(); }
    for (const callback of new Set([onTaskTiming, task.onTaskTiming].filter(Boolean))) {
      try {
        const result = callback(record);
        if (result && typeof result.then === "function") Promise.resolve(result).catch(() => { timing.callbackErrors++; });
      } catch { timing.callbackErrors++; }
    }
    return record;
  }
  const memoryStatus = () => ({ ...memory, highWatermark, lowWatermark, resumeSamples });
  function settleIdle() { if (!active) for (const resolve of idleWaiters.splice(0)) resolve(); }
  function clearPoll() { if (timer !== null) clearTimeoutImpl(timer); timer = null; }
  function poll() {
    if (closed || !sampleMemory || !background.length || timer !== null) return;
    timer = setTimeoutImpl(() => { timer = null; pump(); }, sampleIntervalMs);
    timer?.unref?.();
  }
  function pause(reason, code = null) {
    accountWaiting();
    memory.paused = true; memory.pauseReason = reason; memory.errorCode = code; memory.lowSamples = 0;
  }
  async function inspect() {
    if (!sampleMemory) return memoryStatus();
    if (sampling) return sampling;
    accountWaiting();
    sampling = (async () => {
      try {
        lastAttemptAt = timestamp();
        const sample = await sampleMemory();
        const at = sample?.sampledAt === undefined ? timestamp() : Number(sample.sampledAt);
        const ratio = Number(sample?.ratio), age = timestamp() - at;
        if (!sample || typeof sample.ratio !== "number" || !Number.isFinite(ratio) || ratio < 0
          || !Number.isFinite(at) || age < -1000) throw fault("ANALYTICAL_MEMORY_SAMPLE_INVALID");
        if (age > maxSampleAgeMs) throw fault("ANALYTICAL_MEMORY_SAMPLE_STALE");
        accountWaiting(); memory.ratio = ratio; memory.sampledAt = at; memory.errorCode = null;
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
    finally { accountWaiting(); sampling = null; }
  }
  function fresh() {
    return !sampleMemory || memory.sampledAt !== null && timestamp() - memory.sampledAt <= maxSampleAgeMs;
  }
  function launch(task) {
    task.cleanup();
    if (task.signal?.aborted) { const error = aborted(); recordTask(task, error, accountWaiting()); task.reject(error); pump(); return; }
    clearPoll();
    const controller = new AbortController();
    const onAbort = () => controller.abort(task.signal?.reason);
    task.signal?.addEventListener("abort", onAbort, { once: true });
    task.startedAt = accountWaiting(); task.waits = taskWait(task); timing.started++;
    const token = { id: task.id, controller, active: true, priority: task.priority, kind: task.kind };
    active = token;
    if (task.priority === "foreground") consecutiveForeground++;
    else { consecutiveForeground = 0; admittedSampleSequence = sampleSequence; }
    const info = { signal: controller.signal, priority: task.priority, kind: task.kind,
      timing: Object.freeze({ id: task.id, parentId: null, reentrant: false, queuedAt: task.queuedAt,
        startedAt: task.startedAt, queueWaitMs: Math.max(0, task.startedAt - task.queuedAt), ...task.waits }) };
    const completed = (value, error, didFail) => {
      const finishedAt = accountWaiting();
      token.active = false; task.signal?.removeEventListener("abort", onAbort);
      if (active === token) active = null;
      recordTask(task, error, finishedAt, didFail);
      if (didFail) task.reject(error); else task.resolve(value);
      settleIdle(); pump();
    };
    Promise.resolve().then(() => task.invoke(token, info)).then(value => completed(value, null, false), error => completed(undefined, error, true));
  }
  function dispatch(queue) { accountWaiting(); return launch(queue.shift()); }
  function pump() {
    if (closed || active) return;
    const canBackground = background.length && !sampling && fresh() && !memory.paused;
    if (foreground.length && (!canBackground || consecutiveForeground < foregroundBurst)) return dispatch(foreground);
    // Revalidate memory before background admission. Sampling is deliberately
    // outside the lease; a foreground request can pass a slow sample call.
    if (background.length && sampleMemory && (lastAttemptAt === null || timestamp() - lastAttemptAt >= sampleIntervalMs
      || !memory.paused && sampleSequence <= admittedSampleSequence)) {
      if (!sampling) inspect().finally(() => { pump(); poll(); });
      if (foreground.length) return dispatch(foreground);
      poll(); return;
    }
    if (canBackground) return dispatch(background);
    if (foreground.length) return dispatch(foreground);
    poll();
  }
  function run(operation, { priority = "foreground", kind = "analysis", signal, detached = false, onTaskTiming: taskCallback = null } = {}) {
    if (typeof operation !== "function" || !["foreground", "background"].includes(priority)
      || typeof kind !== "string" || !/^[A-Za-z0-9_:-]{1,80}$/.test(kind) || typeof detached !== "boolean"
      || signal !== undefined && (!signal || typeof signal.addEventListener !== "function" || typeof signal.removeEventListener !== "function")
      || taskCallback !== null && typeof taskCallback !== "function") {
      return Promise.reject(new TypeError("Invalid analytical work"));
    }
    if (closed) return Promise.reject(fault("ANALYTICAL_WORK_CLOSED"));
    if (signal?.aborted) return Promise.reject(aborted());
    const owner = context.getStore();
    // Durable queue dispatch inherits its creator's async context but owns a
    // NEW lifetime. Enqueue detached work without awaiting it inside the owner;
    // otherwise it would wait for the lease that its own caller still holds.
    if (!detached && owner?.active && active === owner) {
      const at = timestamp(), task = { id: ++taskSequence, parentId: owner.id, kind, priority: owner.priority,
        reentrant: true, queuedAt: at, startedAt: at, onTaskTiming: taskCallback };
      timing.reentrantStarted++;
      const info = { signal: owner.controller.signal, priority: owner.priority, kind,
        timing: Object.freeze({ id: task.id, parentId: owner.id, reentrant: true, queuedAt: at, startedAt: at, queueWaitMs: 0, ...emptyWait() }) };
      return Promise.resolve().then(() => operation(info)).then(value => { recordTask(task, null); return value; },
        error => { recordTask(task, error, timestamp(), true); throw error; });
    }
    return new Promise((resolve, reject) => {
      const queue = priority === "foreground" ? foreground : background;
      // A queued task may be pumped by another collection lane. Restore the
      // enqueuing caller's other async stores before assigning our new owner.
      const invoke = AsyncResource.bind((token, info) => context.run(token, () => operation(info)));
      const queuedAt = accountWaiting();
      const task = { id: ++taskSequence, invoke, priority, kind, signal, resolve, reject, queuedAt,
        waitStart: { ...waitClocks[priority] }, onTaskTiming: taskCallback, cleanup: () => signal?.removeEventListener("abort", onAbort) };
      const onAbort = () => {
        const index = queue.indexOf(task);
        if (index !== -1) { const at = accountWaiting(); queue.splice(index, 1); task.cleanup(); const error = aborted();
          recordTask(task, error, at); reject(error); if (!background.length) clearPoll(); pump(); }
      };
      timing.enqueued++; queue.push(task); signal?.addEventListener("abort", onAbort, { once: true }); pump();
    });
  }
  async function checkpointPressure() {
    // It is an inspection, never a heap-retaining low-memory wait. The owner
    // may release its data and durably requeue at a safe allocation boundary.
    return inspect();
  }
  function status() {
    return { closed, active: Boolean(active), activePriority: active?.priority || null, activeKind: active?.kind || null,
      queuedForeground: foreground.length, queuedBackground: background.length, sampling: Boolean(sampling), memory: memoryStatus(),
      timing: { ...timing, historyLimit: timingHistoryLimit, recent: recent.map(row => ({ ...row })),
        interpretation: "Exclusive lease wall time includes I/O, not only CPU. Reentrant wall time overlaps its parent and is excluded from exclusive totals. Wait reasons are disjoint; busy ownership precedes memory pressure. Queue wait totals sum per task and can overlap across queued tasks; they are not elapsed scheduler uptime." } };
  }
  async function close() {
    const at = accountWaiting(); closed = true; clearPoll();
    for (const task of [...foreground.splice(0), ...background.splice(0)]) { task.cleanup(); const error = fault("ANALYTICAL_WORK_CLOSED");
      recordTask(task, error, at); task.reject(error); }
    active?.controller.abort(fault("ANALYTICAL_WORK_CLOSED"));
    if (active) await new Promise(resolve => idleWaiters.push(resolve));
  }
  return { run, status, close, checkpointPressure };
}

module.exports = { createAnalyticalWorkScheduler };
