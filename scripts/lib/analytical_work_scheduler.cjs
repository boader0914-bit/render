"use strict";

const { AsyncLocalStorage, AsyncResource } = require("node:async_hooks");
const { runWithCooperativeWork, YIELD_CODE } = require("./cooperative_work_checkpoint.cjs");

function fault(code, name = "Error") { return Object.assign(new Error(code), { code, name }); }
const aborted = () => fault("ANALYTICAL_WORK_ABORTED", "AbortError");

// Own the complete allocation lifetime, not just a source read. Callers must
// await their nested work and must acquire this lease BEFORE a writer lock.
// Memory admission never waits while owning a lease or a caller's large data.
function createAnalyticalWorkScheduler({ foregroundBurst = 4, sampleMemory = null,
  highWatermark = 0.65, lowWatermark = 0.55, resumeSamples = 2,
  sampleIntervalMs = 1000, maxSampleAgeMs = 10000, now = Date.now,
  setTimeoutImpl = setTimeout, clearTimeoutImpl = clearTimeout,
  onTaskTiming = null, timingHistoryLimit = 32, cooperativeYield = false, cooperativeCompanyMonthYield = false,
  cooperativeMinRunMs = 250, cooperativeMinProgress = 1 } = {}) {
  if (!Number.isSafeInteger(foregroundBurst) || foregroundBurst < 1
    || sampleMemory !== null && typeof sampleMemory !== "function"
    || !Number.isFinite(highWatermark) || highWatermark <= 0 || highWatermark > 1
    || !Number.isFinite(lowWatermark) || lowWatermark < 0 || lowWatermark >= highWatermark
    || !Number.isSafeInteger(resumeSamples) || resumeSamples < 1
    || !Number.isSafeInteger(sampleIntervalMs) || sampleIntervalMs < 1
    || !Number.isSafeInteger(maxSampleAgeMs) || maxSampleAgeMs < sampleIntervalMs
    || typeof now !== "function" || typeof setTimeoutImpl !== "function" || typeof clearTimeoutImpl !== "function"
    || onTaskTiming !== null && typeof onTaskTiming !== "function"
    || !Number.isSafeInteger(timingHistoryLimit) || timingHistoryLimit < 0 || timingHistoryLimit > 128
    || typeof cooperativeYield !== "boolean" || typeof cooperativeCompanyMonthYield !== "boolean"
    || !Number.isSafeInteger(cooperativeMinRunMs) || cooperativeMinRunMs < 0
    || !Number.isSafeInteger(cooperativeMinProgress) || cooperativeMinProgress < 1) {
    throw new TypeError("Invalid analytical scheduler options");
  }
  const context = new AsyncLocalStorage(), foreground = [], background = [], checkpointReads = [], idleWaiters = [];
  let checkpointReader = null;
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
    reentrantCompleted: 0, reentrantFailed: 0, reentrantLeaseMs: 0, callbackErrors: 0,
    yielded: 0, restarted: 0, reentrantYielded: 0, cooperativeCheckpoints: 0, maximumCheckpointGapMs: 0, progressRevisionResets: 0,
    checkpointReadEnqueued: 0, checkpointReadStarted: 0, checkpointReadCompleted: 0, checkpointReadFailed: 0,
    checkpointReadAborted: 0, checkpointReadClosed: 0, checkpointReadQueueWaitMs: 0, checkpointReadLeaseMs: 0 };
  const recent = [];
  function accountWaiting() {
    const at = timestamp(), elapsed = Math.max(0, at - waitClockAt); waitClockAt = at;
    for (const priority of ["foreground", "background"]) {
      if (!(priority === "foreground" ? foreground.length + checkpointReads.length : background.length)) continue;
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
    const nested = task.reentrant && !task.checkpointRead;
    const waits = nested ? emptyWait() : task.waits || taskWait(task, finishedAt);
    const code = didFail ? errorCode(error) : null;
    const outcome = !didFail ? "completed" : code === YIELD_CODE && task.cooperativeYielded ? "yielded" : code === "ANALYTICAL_WORK_ABORTED" ? "aborted"
      : code === "ANALYTICAL_WORK_CLOSED" ? "closed" : "failed";
    const record = Object.freeze({ id: task.id, parentId: task.parentId || null, kind: task.kind, priority: task.priority,
      reentrant: Boolean(task.reentrant), queuedAt: task.queuedAt, startedAt: task.startedAt ?? null, finishedAt,
      queueWaitMs: nested ? 0 : Math.max(0, (task.startedAt ?? finishedAt) - task.queuedAt),
      leaseMs: task.startedAt === undefined ? 0 : Math.max(0, finishedAt - task.startedAt),
      ...waits, outcome, errorCode: code,
      ...(task.checkpointRead ? { checkpointRead: true, borrowed: Boolean(task.reentrant) } : {}),
      ...(task.cooperative ? { attempt: task.attempt, checkpoints: task.cooperative.checkpoints,
        checkpointHighWater: task.checkpointHighWater || 0, phaseIndex: task.cooperative.phaseIndex,
        stageIndex: task.cooperative.stageIndex,
        checkpointsInPhase: task.cooperative.phaseCheckpoints, unitIndex: task.cooperative.unitIndex,
        checkpointsInUnit: task.cooperative.unitCheckpoints,
        progressHighWater: Object.freeze({ ...(task.progressHighWater || { phaseIndex: 0, unitIndex: 0, checkpoints: 0 }) }) } : {}) });
    if (task.checkpointRead) {
      const counter = ({ completed: "checkpointReadCompleted", aborted: "checkpointReadAborted", closed: "checkpointReadClosed" })[outcome] || "checkpointReadFailed";
      timing[counter]++; timing.checkpointReadQueueWaitMs += record.queueWaitMs; timing.checkpointReadLeaseMs += record.leaseMs;
    } else if (task.reentrant) {
      timing.reentrantCompleted += !didFail ? 1 : 0;
      if (outcome === "yielded") timing.reentrantYielded++; else timing.reentrantFailed += didFail ? 1 : 0;
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
    task.startedAt = accountWaiting(); task.waits = taskWait(task);
    if (task.checkpointRead) timing.checkpointReadStarted++; else timing.started++;
    const token = { id: task.id, controller, active: true, priority: task.priority, kind: task.kind, checkpointRead: Boolean(task.checkpointRead) };
    active = token;
    task.attempt = (task.attempt || 0) + 1;
    const eligible = task.priority === "background" && (cooperativeYield && task.kind === "industry-build"
      || cooperativeCompanyMonthYield && task.kind === "company-month");
    const checkpointScope = {
      enabled: true, yieldRequested: false, nonInterruptibleDepth: 0, checkpoints: 0, lastCheckpointAt: task.startedAt,
      stageIndex: 0, phaseIndex: 0, phaseCheckpoints: 0, unitIndex: 0, unitCheckpoints: 0,
      isCurrent: () => token.active && active === token,
      drainCheckpointReads: () => drainCheckpointReads(token),
      hasCheckpointRead: () => checkpointReader?.ownerId === token.id,
      waitForCheckpointRead: () => checkpointReader?.ownerId === token.id ? checkpointReader.done : Promise.resolve(),
      setStage(index) {
        // A company month reads the requested month and its comparison month
        // in order. Their source phases repeat 10..70; a later stage is fresh
        // logical progress, not a rewind below the first source's high-water.
        if (index > this.stageIndex) {
          this.stageIndex = index; this.phaseIndex = 0; this.phaseCheckpoints = 0;
          this.unitIndex = 0; this.unitCheckpoints = 0;
        }
      },
      setRevision(revision) {
        if (!eligible) return;
        // Work completed against old originals cannot forbid foreground
        // admission while a changed source starts its new calculation prefix.
        // An unchanged revision keeps its fairness/progress fence intact.
        if (task.progressRevision !== undefined && task.progressRevision !== revision) {
          task.progressHighWater = null; task.checkpointHighWater = 0;
          timing.progressRevisionResets++;
        }
        task.progressRevision = revision;
      },
      setPhase(index, unitIndex) {
        // A warm retry may skip thousands of cold catalog checkpoints. Track
        // ordered logical phases so that advancing into history/recalculation
        // remains progress even when its absolute checkpoint count is lower.
        // The same applies to a completed run unit whose warm cache skips its
        // inner company checkpoints. Mark stable ordered runs independently.
        if (index > this.phaseIndex) {
          this.phaseIndex = index; this.phaseCheckpoints = 0; this.unitIndex = unitIndex; this.unitCheckpoints = 0;
        } else if (index === this.phaseIndex && unitIndex > this.unitIndex) {
          this.unitIndex = unitIndex; this.unitCheckpoints = 0;
        }
      },
      checkpoint() {
        if (!eligible) return;
        const at = timestamp(), gap = Math.max(0, at - this.lastCheckpointAt);
        this.lastCheckpointAt = at; this.checkpoints++; this.phaseCheckpoints++; this.unitCheckpoints++; timing.cooperativeCheckpoints++;
        timing.maximumCheckpointGapMs = Math.max(timing.maximumCheckpointGapMs, gap);
      },
      shouldYield() {
        if (!eligible) return false;
        const highWater = task.progressHighWater || { phaseIndex: 0, unitIndex: 0, checkpoints: 0 }, stage = highWater.stageIndex || 0;
        const advancesUnit = this.stageIndex > stage || this.stageIndex === stage && (this.phaseIndex > highWater.phaseIndex
          || this.phaseIndex === highWater.phaseIndex && this.unitIndex > highWater.unitIndex);
        const progresses = advancesUnit ? this.unitCheckpoints >= cooperativeMinProgress
          : this.stageIndex === stage && this.phaseIndex === highWater.phaseIndex && this.unitIndex === highWater.unitIndex
            && this.unitCheckpoints >= highWater.checkpoints + cooperativeMinProgress;
        return foreground.length > 0 && timestamp() - task.startedAt >= cooperativeMinRunMs
          && progresses;
      }
    };
    const cooperative = eligible ? checkpointScope : null;
    token.checkpointScope = checkpointScope; token.cooperative = cooperative; task.cooperative = cooperative;
    if (task.priority === "foreground") consecutiveForeground++;
    else { consecutiveForeground = 0; admittedSampleSequence = sampleSequence; }
    const info = { signal: controller.signal, priority: task.priority, kind: task.kind,
      timing: Object.freeze({ id: task.id, parentId: null, reentrant: false, queuedAt: task.queuedAt,
        startedAt: task.startedAt, queueWaitMs: Math.max(0, task.startedAt - task.queuedAt), ...task.waits }) };
    const completed = (value, error, didFail) => {
      const finishedAt = accountWaiting();
      const requestedYield = cooperative?.yieldRequested === true;
      // Catch-all adapters may translate or swallow a checkpoint rejection.
      // Only the scheduler's private owner flag authorizes retry, never an
      // arbitrary error code supplied by a caller. The whole invoke promise
      // has now settled, including its awaited cleanup and source-slot release.
      if (requestedYield) {
        task.cooperativeYielded = true;
        didFail = true;
        error = closed ? fault("ANALYTICAL_WORK_CLOSED") : task.signal?.aborted ? aborted() : fault(YIELD_CODE);
      }
      if (task.checkpointRead && (closed || task.signal?.aborted)) {
        didFail = true; error = closed ? fault("ANALYTICAL_WORK_CLOSED") : aborted();
      }
      token.active = false; task.signal?.removeEventListener("abort", onAbort);
      if (active === token) active = null;
      recordTask(task, error, finishedAt, didFail);
      if (requestedYield && !closed && !task.signal?.aborted) {
        task.checkpointHighWater = Math.max(task.checkpointHighWater || 0, cooperative.checkpoints);
        task.progressHighWater = { ...(cooperative.stageIndex ? { stageIndex: cooperative.stageIndex } : {}),
          phaseIndex: cooperative.phaseIndex, unitIndex: cooperative.unitIndex, checkpoints: cooperative.unitCheckpoints };
        // The original caller keeps one pending promise. Retry only its small
        // operation closure; do not retain an allocation/result from the old
        // attempt, and do not mark the durable industry job as failed/complete.
        task.queuedAt = accountWaiting(); task.waitStart = { ...waitClocks[task.priority] };
        delete task.startedAt; delete task.waits; delete task.cooperativeYielded; task.cooperative = null;
        background.push(task); timing.restarted++; task.attach();
        settleIdle(); pump(); return;
      }
      // A timing observer may synchronously abort/close the scheduler. It
      // cannot turn a canceled retry into an escaped internal yield error.
      if (requestedYield && (closed || task.signal?.aborted)) error = closed ? fault("ANALYTICAL_WORK_CLOSED") : aborted();
      if (didFail) task.reject(error); else task.resolve(value);
      settleIdle(); pump();
    };
    Promise.resolve().then(() => task.invoke(token, info)).then(value => completed(value, null, false), error => completed(undefined, error, true));
  }
  function dispatch(queue) { accountWaiting(); return launch(queue.shift()); }
  async function drainCheckpointReads(owner) {
    if (checkpointReader || closed || active !== owner || !owner.active || owner.checkpointScope?.nonInterruptibleDepth !== 0) return;
    // At most four small callbacks per boundary. Even a continuous stream of
    // proof readers must let the background operation advance to its next
    // checkpoint; no replay, callback restart or high-water reset is needed.
    for (let count = 0; count < 4 && checkpointReads.length && !closed && active === owner && owner.active; count++) {
      const task = checkpointReads.shift(); task.cleanup();
      if (task.signal?.aborted) { const error = aborted(); recordTask(task, error, accountWaiting()); task.reject(error); continue; }
      const controller = new AbortController(), onAbort = () => controller.abort(task.signal?.reason), onOwnerAbort = () => controller.abort(owner.controller.signal.reason);
      task.signal?.addEventListener("abort", onAbort, { once: true });
      owner.controller.signal.addEventListener("abort", onOwnerAbort, { once: true });
      if (owner.controller.signal.aborted) onOwnerAbort();
      task.startedAt = accountWaiting(); task.waits = taskWait(task); task.parentId = owner.id; task.reentrant = true; timing.checkpointReadStarted++;
      let releaseRead;
      const token = { id: task.id, controller, active: true, priority: "foreground", kind: task.kind, checkpointRead: true,
        ownerId: owner.id, done: new Promise(resolve => { releaseRead = resolve; }) };
      checkpointReader = token;
      const info = { signal: controller.signal, priority: "foreground", kind: task.kind,
        timing: Object.freeze({ id: task.id, parentId: owner.id, reentrant: true, checkpointRead: true, queuedAt: task.queuedAt,
          startedAt: task.startedAt, queueWaitMs: Math.max(0, task.startedAt - task.queuedAt), ...task.waits }) };
      let value, failure, failed = false;
      try { value = await task.invoke(token, info); }
      catch (error) { failure = error; failed = true; }
      finally {
        token.active = false; checkpointReader = null; releaseRead();
        task.signal?.removeEventListener("abort", onAbort); owner.controller.signal.removeEventListener("abort", onOwnerAbort);
      }
      if (closed || task.signal?.aborted || owner.controller.signal.aborted) { failure = closed ? fault("ANALYTICAL_WORK_CLOSED") : aborted(); failed = true; }
      recordTask(task, failure, accountWaiting(), failed);
      if (failed) task.reject(failure); else task.resolve(value);
    }
  }
  function pump() {
    if (closed || active) return;
    if (checkpointReads.length) return dispatch(checkpointReads);
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
    if (context.getStore()?.checkpointRead && context.getStore().active) return Promise.reject(fault("ANALYTICAL_CHECKPOINT_READ_NESTED_WORK"));
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
      return Promise.resolve().then(() => operation(info)).then(value => {
        if (owner.cooperative?.yieldRequested) { const error = fault(YIELD_CODE); task.cooperativeYielded = true; recordTask(task, error, timestamp(), true); throw error; }
        recordTask(task, null); return value; },
        error => { const failure = owner.cooperative?.yieldRequested ? fault(YIELD_CODE) : error;
          task.cooperativeYielded = owner.cooperative?.yieldRequested === true;
          recordTask(task, failure, timestamp(), true); throw failure; });
    }
    return new Promise((resolve, reject) => {
      const queue = priority === "foreground" ? foreground : background;
      // A queued task may be pumped by another collection lane. Restore the
      // enqueuing caller's other async stores before assigning our new owner.
      const invoke = AsyncResource.bind((token, info) => context.run(token,
        () => runWithCooperativeWork(token.checkpointScope, () => operation(info))));
      const queuedAt = accountWaiting();
      const task = { id: ++taskSequence, invoke, priority, kind, signal, resolve, reject, queuedAt,
        waitStart: { ...waitClocks[priority] }, onTaskTiming: taskCallback, cleanup: () => signal?.removeEventListener("abort", onAbort),
        attach: () => signal?.addEventListener("abort", onAbort, { once: true }) };
      const onAbort = () => {
        const index = queue.indexOf(task);
        if (index !== -1) { const at = accountWaiting(); queue.splice(index, 1); task.cleanup(); const error = aborted();
          recordTask(task, error, at); reject(error); if (!background.length) clearPoll(); pump(); }
      };
      timing.enqueued++; queue.push(task); task.attach(); pump();
    });
  }
  function runCheckpointRead(operation, { kind = "company-month-cached-verification", signal, onTaskTiming: taskCallback = null } = {}) {
    // This explicit application capability is for cache-only verification and
    // one bounded derived certificate publication. It must never reconstruct
    // sources, rebuild an index, collect, or enqueue/await other analytical work.
    if (typeof operation !== "function" || kind !== "company-month-cached-verification"
      || signal !== undefined && (!signal || typeof signal.addEventListener !== "function" || typeof signal.removeEventListener !== "function")
      || taskCallback !== null && typeof taskCallback !== "function") return Promise.reject(new TypeError("Invalid checkpoint read"));
    if (context.getStore()?.checkpointRead && context.getStore().active) return Promise.reject(fault("ANALYTICAL_CHECKPOINT_READ_NESTED_WORK"));
    if (closed) return Promise.reject(fault("ANALYTICAL_WORK_CLOSED"));
    if (signal?.aborted) return Promise.reject(aborted());
    // An existing ordinary owner already has exclusive admission. Reentering
    // its small proof directly avoids waiting for a checkpoint it cannot reach
    // while awaiting this call. It still receives a restricted callback token.
    const owner = context.getStore();
    if (owner?.active && active === owner) {
      if (owner.checkpointScope?.nonInterruptibleDepth > 0) return Promise.reject(fault("ANALYTICAL_CHECKPOINT_READ_ATOMIC_WORK"));
      const controller = new AbortController(), onAbort = () => controller.abort(signal?.reason), onOwnerAbort = () => controller.abort(owner.controller.signal.reason);
      signal?.addEventListener("abort", onAbort, { once: true }); owner.controller.signal.addEventListener("abort", onOwnerAbort, { once: true });
      if (signal?.aborted) onAbort(); if (owner.controller.signal.aborted) onOwnerAbort();
      const token = { id: owner.id, controller, active: true, checkpointRead: true };
      return context.run(token, () => runWithCooperativeWork(null, () => Promise.resolve().then(() => operation({ signal: controller.signal, priority: "foreground", kind }))))
        .then(value => { if (closed || controller.signal.aborted) throw closed ? fault("ANALYTICAL_WORK_CLOSED") : aborted(); return value; })
        .finally(() => { token.active = false; signal?.removeEventListener("abort", onAbort); owner.controller.signal.removeEventListener("abort", onOwnerAbort); });
    }
    return new Promise((resolve, reject) => {
      const invoke = AsyncResource.bind((token, info) => context.run(token, () => runWithCooperativeWork(null, () => operation(info))));
      const queuedAt = accountWaiting(), task = { id: ++taskSequence, invoke, checkpointRead: true, priority: "foreground", kind, signal, resolve, reject,
        queuedAt, waitStart: { ...waitClocks.foreground }, onTaskTiming: taskCallback, cleanup: () => signal?.removeEventListener("abort", onAbort),
        attach: () => signal?.addEventListener("abort", onAbort, { once: true }) };
      const onAbort = () => {
        const index = checkpointReads.indexOf(task); if (index < 0) return;
        const at = accountWaiting(); checkpointReads.splice(index, 1); task.cleanup(); const error = aborted(); recordTask(task, error, at); reject(error); pump();
      };
      timing.checkpointReadEnqueued++; checkpointReads.push(task); task.attach(); pump();
    });
  }
  async function checkpointPressure() {
    // It is an inspection, never a heap-retaining low-memory wait. The owner
    // may release its data and durably requeue at a safe allocation boundary.
    return inspect();
  }
  function status() {
    return { closed, active: Boolean(active), activePriority: active?.priority || null, activeKind: active?.kind || null,
      queuedForeground: foreground.length + checkpointReads.length, queuedBackground: background.length,
      queuedCheckpointReads: checkpointReads.length, activeCheckpointReadKind: checkpointReader?.kind || null,
      sampling: Boolean(sampling), memory: memoryStatus(),
      cooperative: { enabled: cooperativeYield || cooperativeCompanyMonthYield, industryEnabled: cooperativeYield,
        companyMonthEnabled: cooperativeCompanyMonthYield,
        minRunMs: cooperativeMinRunMs, minProgressCheckpoints: cooperativeMinProgress,
        activeEligible: Boolean(active?.cooperative), activeCheckpoints: active?.cooperative?.checkpoints || 0,
        activeStageIndex: active?.cooperative?.stageIndex || 0,
        activePhaseIndex: active?.cooperative?.phaseIndex || 0,
        activeCheckpointsInPhase: active?.cooperative?.phaseCheckpoints || 0,
        activeUnitIndex: active?.cooperative?.unitIndex || 0,
        activeCheckpointsInUnit: active?.cooperative?.unitCheckpoints || 0,
        yieldRequested: active?.cooperative?.yieldRequested || false },
      timing: { ...timing, historyLimit: timingHistoryLimit, recent: recent.map(row => ({ ...row,
        ...(row.progressHighWater ? { progressHighWater: { ...row.progressHighWater } } : {}) })),
        interpretation: "Exclusive lease wall time includes I/O, not only CPU. Reentrant wall time overlaps its parent and is excluded from exclusive totals. Checkpoint reads have separate counters; borrowed reads pause their parent at a safe boundary and never overlap execution or atomic publication. Wait reasons are disjoint; busy ownership precedes memory pressure. Queue wait totals sum per task and can overlap across queued tasks; they are not elapsed scheduler uptime." } };
  }
  async function close() {
    const at = accountWaiting(); closed = true; clearPoll();
    for (const task of [...foreground.splice(0), ...background.splice(0), ...checkpointReads.splice(0)]) { task.cleanup(); const error = fault("ANALYTICAL_WORK_CLOSED");
      recordTask(task, error, at); task.reject(error); }
    active?.controller.abort(fault("ANALYTICAL_WORK_CLOSED"));
    if (active) await new Promise(resolve => idleWaiters.push(resolve));
  }
  return { run, runCheckpointRead, status, close, checkpointPressure };
}

module.exports = { createAnalyticalWorkScheduler };
