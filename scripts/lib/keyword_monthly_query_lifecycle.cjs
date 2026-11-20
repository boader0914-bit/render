"use strict";

// Share only unfinished read promises, never a decoded result cache. A caller's
// timeout/disconnect releases its waiter; it cannot cancel another reader or
// start a duplicate calculation while the original operation still owns work.
const crypto = require("node:crypto");
const { AsyncResource } = require("node:async_hooks");
const fault = code => Object.assign(new Error(code), { code, statusCode: 503,
  ...(code === "KEYWORD_MONTHLY_QUERY_ABORTED" ? { name: "AbortError" } : {}) });

function createKeywordMonthlyQueryLifecycle({ maxInFlight = 4, maxWaiters = 8,
  timeoutMs = 20000, now = Date.now, setTimeoutImpl = setTimeout, clearTimeoutImpl = clearTimeout } = {}) {
  if (!Number.isSafeInteger(maxInFlight) || maxInFlight < 1 || maxInFlight > 16
    || !Number.isSafeInteger(maxWaiters) || maxWaiters < 1 || maxWaiters > 32
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000
    || [now, setTimeoutImpl, clearTimeoutImpl].some(fn => typeof fn !== "function")) throw new TypeError("Invalid keyword query bounds");
  const flights = new Map(), recent = [], metadataQueue = [], metadataCallers = new Set();
  let closed = false, sequence = 0, metadataPumpScheduled = false, metadataPumping = false;
  const kinds = new Set(["version", "catalogue", "refresh_status"]);
  const observationTime = () => { try { const at = Date.now(); return Number.isFinite(at) ? at : null; } catch { return null; } };
  const counters = { started: 0, shared: 0, completed: 0, failed: 0, aborted: 0, timedOut: 0, rejectedBusy: 0, cleanupErrors: 0, observerErrors: 0 };
  const metadataKinds = new Set(["version", "catalogue"]);
  const totalCallers = () => metadataCallers.size + [...flights.values()].filter(entry => !metadataKinds.has(entry.kind)).reduce((sum, entry) => sum + entry.waiters.size, 0);
  function registerLifetime(hook, lifetime) {
    if (!hook) return;
    const registered = hook(lifetime);
    if (registered !== undefined) {
      try { if (registered && typeof registered.then === "function") Promise.resolve(registered).catch(() => {}); } catch {}
      throw fault("KEYWORD_MONTHLY_RESPONSE_LIFETIME_UNAVAILABLE");
    }
  }
  function scheduleMetadataPump() {
    if (closed || metadataPumpScheduled) return;
    metadataPumpScheduled = true;
    queueMicrotask(() => { metadataPumpScheduled = false; pumpMetadata(); });
  }
  function finishMetadataCaller(item, error, value, failed = Boolean(error)) {
    if (item.done) return;
    item.done = true; metadataCallers.delete(item);
    const index = metadataQueue.indexOf(item); if (index >= 0) metadataQueue.splice(index, 1);
    try { if (item.timer !== null) clearTimeoutImpl(item.timer); } catch { counters.cleanupErrors++; }
    try { item.signal?.removeEventListener("abort", item.onAbort); } catch { counters.cleanupErrors++; }
    if (!item.lifetimeAttached) item.resolveLifetime();
    item.operation = null;
    if (failed) item.reject(error); else item.resolve(value);
    scheduleMetadataPump();
  }
  function expireMetadataCaller(item, code) {
    if (item.done) return;
    const error = fault(code);
    if (item.started && !item.innerSettled) item.controller.abort(error);
    else if (code === "KEYWORD_MONTHLY_QUERY_TIMEOUT") { counters.timedOut++; observe(item.onLifecycleObservation, "waiter_timed_out", "waiter"); }
    else if (code === "KEYWORD_MONTHLY_QUERY_ABORTED") { counters.aborted++; observe(item.onLifecycleObservation, "waiter_aborted", "waiter"); }
    finishMetadataCaller(item, error);
  }
  function metadataInTime(item) {
    let at; try { at = Number(now()); } catch { expireMetadataCaller(item, "KEYWORD_MONTHLY_QUERY_CLOCK_INVALID"); return false; }
    if (!Number.isFinite(at) || at < item.lastAdmissionAt) { expireMetadataCaller(item, "KEYWORD_MONTHLY_QUERY_CLOCK_INVALID"); return false; }
    item.lastAdmissionAt = at;
    if (at >= item.deadlineAt) { expireMetadataCaller(item, "KEYWORD_MONTHLY_QUERY_TIMEOUT"); return false; }
    return !item.done;
  }
  function startMetadataCaller(item) {
    if (closed || item.done || !metadataInTime(item)) return;
    const index = metadataQueue.indexOf(item); if (index >= 0) metadataQueue.splice(index, 1);
    item.started = true;
    const operation = item.operation; item.operation = null;
    let pending;
    try { pending = runImmediate(item.kind, operation, { signal: item.controller.signal, metadataKind: item.kind, ownerTraceId: item.ownerTraceId,
      onOperationSettled: item.onOperationSettled, onLifecycleObservation: item.onLifecycleObservation,
      onOperationLifetime: lifetime => { item.lifetimeAttached = true; lifetime.then(item.resolveLifetime); } }, true, item.key); }
    catch { finishMetadataCaller(item, fault("KEYWORD_MONTHLY_QUERY_CLOCK_INVALID")); return; }
    pending.then(value => { item.innerSettled = true; if (!item.done && metadataInTime(item)) finishMetadataCaller(item, null, value, false); },
      error => { item.innerSettled = true; finishMetadataCaller(item, error, undefined, true); });
  }
  function pumpMetadata() {
    if (closed || metadataPumping) return;
    metadataPumping = true;
    try {
      while (metadataQueue.length && !closed) {
        const item = metadataQueue[0];
        if (item.done || !metadataInTime(item)) { if (metadataQueue[0] === item) metadataQueue.shift(); continue; }
        const entry = flights.get(item.key);
        if (entry && (entry.kind !== item.kind || entry.producerController?.signal.aborted) || !entry && flights.size >= maxInFlight) break;
        startMetadataCaller(item);
        // Producer FIFO is strict. Already-live same-key peers may share that
        // one producer without allocating a second graph or restarting it.
        const live = flights.get(item.key);
        if (live && live.kind === item.kind && !live.producerController?.signal.aborted) {
          for (const peer of [...metadataQueue]) if (peer.key === item.key && peer.kind === item.kind) startMetadataCaller(peer);
        }
      }
    } finally { metadataPumping = false; }
  }
  function runMetadata(identity, operation, { signal, onOperationSettled, onLifecycleObservation, metadataKind, ownerTraceId = null, onOperationLifetime } = {}) {
    if (typeof identity !== "string" || !identity || Buffer.byteLength(identity) > 8192 || typeof operation !== "function"
      || signal !== undefined && (!signal || typeof signal.addEventListener !== "function" || typeof signal.removeEventListener !== "function")
      || onOperationSettled !== undefined && typeof onOperationSettled !== "function"
      || onLifecycleObservation !== undefined && typeof onLifecycleObservation !== "function"
      || onOperationLifetime !== undefined && typeof onOperationLifetime !== "function") return Promise.reject(new TypeError("Invalid keyword read"));
    if (closed) return Promise.reject(fault("KEYWORD_MONTHLY_QUERY_CLOSED"));
    if (signal?.aborted) return Promise.reject(fault("KEYWORD_MONTHLY_QUERY_ABORTED"));
    if (totalCallers() >= maxWaiters) { counters.rejectedBusy++; return Promise.reject(fault("KEYWORD_MONTHLY_QUERY_BUSY")); }
    let at; try { at = Number(now()); } catch { return Promise.reject(fault("KEYWORD_MONTHLY_QUERY_CLOCK_INVALID")); }
    if (!Number.isFinite(at)) return Promise.reject(fault("KEYWORD_MONTHLY_QUERY_CLOCK_INVALID"));
    const item = { key: crypto.createHash("sha256").update(identity).digest("hex"), kind: metadataKind,
      ownerTraceId: typeof ownerTraceId === "string" && /^[a-f0-9]{24}$/.test(ownerTraceId) ? ownerTraceId : null,
      queuedAt: at, deadlineAt: at + timeoutMs, lastAdmissionAt: at, operation: AsyncResource.bind(operation),
      onOperationSettled, onLifecycleObservation, signal, controller: new AbortController(),
      started: false, done: false, lifetimeAttached: false, timer: null };
    const promise = new Promise((resolve, reject) => { item.resolve = resolve; item.reject = reject; });
    item.lifetime = new Promise(resolve => { item.resolveLifetime = resolve; });
    item.onAbort = () => expireMetadataCaller(item, "KEYWORD_MONTHLY_QUERY_ABORTED");
    metadataCallers.add(item);
    try {
      item.timer = setTimeoutImpl(() => expireMetadataCaller(item, "KEYWORD_MONTHLY_QUERY_TIMEOUT"), timeoutMs); item.timer?.unref?.();
      signal?.addEventListener("abort", item.onAbort, { once: true });
      registerLifetime(onOperationLifetime, item.lifetime);
      if (signal?.aborted) item.onAbort();
      if (!item.done) {
        const entry = flights.get(item.key);
        if (entry?.kind === item.kind && !entry.producerController?.signal.aborted) startMetadataCaller(item);
        else { metadataQueue.push(item); pumpMetadata(); }
      }
    } catch { finishMetadataCaller(item, fault("KEYWORD_MONTHLY_RESPONSE_LIFETIME_UNAVAILABLE")); }
    return promise;
  }
  function observe(callback, event, role) {
    if (!callback) return;
    try { const value = callback(Object.freeze({ event, role }));
      if (value && typeof value.then === "function") Promise.resolve(value).catch(() => { counters.observerErrors++; }); }
    catch { counters.observerErrors++; }
  }
  const flightView = entry => ({ id: entry.id, kind: entry.kind, ownerTraceId: entry.ownerTraceId,
    startedAt: entry.startedAt, settledAt: entry.settledAt, outcome: entry.outcome,
    cooperativeCancellation: Boolean(entry.producerController), abortRequestedAt: entry.abortRequestedAt,
    waitingCallers: entry.waiters.size });
  function cancelAbandonedMetadata(entry) {
    // A disconnected peer cannot cancel another reader. Generic/financial
    // flights have no controller and retain their original ownership policy.
    if (!entry.waiters.size && entry.producerController && !entry.settled && !entry.producerController.signal.aborted) {
      entry.abortRequestedAt = observationTime(); entry.producerController.abort();
    }
  }
  function finishWaiter(entry, waiter, error, value, failed = Boolean(error)) {
    if (!entry.waiters.delete(waiter)) return;
    try { if (waiter.timer !== null) clearTimeoutImpl(waiter.timer); } catch { counters.cleanupErrors++; }
    try { waiter.signal?.removeEventListener("abort", waiter.onAbort); } catch { counters.cleanupErrors++; }
    if (failed) waiter.reject(error); else waiter.resolve(value);
    cancelAbandonedMetadata(entry);
  }
  function complete(entry, error, value, failed = Boolean(error)) {
    entry.settled = true; entry.settledAt = observationTime();
    entry.outcome = failed ? entry.producerController?.signal.aborted ? "aborted" : "failed" : "completed";
    if (flights.get(entry.key) === entry) flights.delete(entry.key);
    counters[failed ? "failed" : "completed"]++;
    observe(entry.onLifecycleObservation, "operation_settled", "owner");
    for (const waiter of [...entry.waiters]) finishWaiter(entry, waiter, error, value, failed);
    // A bounded resource owner may release only after this flight can no
    // longer accept a late shared waiter. Never pass results/errors to it.
    try { entry.onOperationSettled?.(); } catch { counters.cleanupErrors++; }
    entry.resolveLifetime?.();
    recent.push(flightView(entry)); if (recent.length > 32) recent.shift();
    scheduleMetadataPump();
    // No result, exception, request, or response is retained by the registry.
  }
  function runImmediate(identity, operation, { signal, onOperationSettled, onLifecycleObservation,
    metadataKind = null, ownerTraceId = null, onOperationLifetime } = {}, metadataOwnsTimer = false, fixedKey = null) {
    if (typeof identity !== "string" || !identity || Buffer.byteLength(identity) > 8192 || typeof operation !== "function"
      || signal !== undefined && (!signal || typeof signal.addEventListener !== "function" || typeof signal.removeEventListener !== "function")
      || onOperationSettled !== undefined && typeof onOperationSettled !== "function"
      || onLifecycleObservation !== undefined && typeof onLifecycleObservation !== "function"
      || metadataKind !== null && !kinds.has(metadataKind)
      || onOperationLifetime !== undefined && typeof onOperationLifetime !== "function") {
      return Promise.reject(new TypeError("Invalid keyword read"));
    }
    if (closed) return Promise.reject(fault("KEYWORD_MONTHLY_QUERY_CLOSED"));
    if (signal?.aborted) return Promise.reject(fault("KEYWORD_MONTHLY_QUERY_ABORTED"));
    if (metadataCallers.size && !metadataOwnsTimer && totalCallers() >= maxWaiters) { counters.rejectedBusy++; return Promise.reject(fault("KEYWORD_MONTHLY_QUERY_BUSY")); }
    const key = fixedKey || crypto.createHash("sha256").update(identity).digest("hex");
    let entry = flights.get(key), fresh = false;
    if (!entry) {
      // A generic caller keeps its fail-fast contract; it cannot overtake a
      // metadata producer already waiting for the one real cleanup owner.
      if (!metadataOwnsTimer && metadataQueue.length) { counters.rejectedBusy++; return Promise.reject(fault("KEYWORD_MONTHLY_QUERY_BUSY")); }
      if (flights.size >= maxInFlight) { counters.rejectedBusy++; return Promise.reject(fault("KEYWORD_MONTHLY_QUERY_BUSY")); }
      const startedAt = Number(now());
      if (!Number.isFinite(startedAt)) return Promise.reject(fault("KEYWORD_MONTHLY_QUERY_CLOCK_INVALID"));
      const cooperative = metadataKind === "version" || metadataKind === "catalogue";
      entry = { key, id: ++sequence, kind: metadataKind || "other", ownerTraceId: typeof ownerTraceId === "string" && /^[a-f0-9]{24}$/.test(ownerTraceId) ? ownerTraceId : null,
        startedAt, settledAt: null, settled: false, outcome: null, abortRequestedAt: null,
        producerController: cooperative ? new AbortController() : null,
        waiters: new Set(), onOperationSettled, onLifecycleObservation };
      if (cooperative) entry.lifetime = new Promise(resolve => { entry.resolveLifetime = resolve; });
      flights.set(key, entry); fresh = true;
    } else if (entry.producerController?.signal.aborted || entry.kind !== (metadataKind || "other")) {
      // A canceled metadata operation cannot be revived or duplicated before
      // its real filesystem/handle cleanup has settled.
      counters.rejectedBusy++; return Promise.reject(fault("KEYWORD_MONTHLY_QUERY_BUSY"));
    } else if (entry.waiters.size >= maxWaiters) {
      counters.rejectedBusy++; return Promise.reject(fault("KEYWORD_MONTHLY_QUERY_BUSY"));
    }
    if (entry.lifetime && onOperationLifetime) try {
      registerLifetime(onOperationLifetime, entry.lifetime);
    }
    catch {
      // This callback owns a byte reservation, not optional observation. If
      // registration fails, do not start an unreserved metadata producer.
      counters.cleanupErrors++;
      if (fresh) { flights.delete(key); entry.settled = true; entry.resolveLifetime?.(); }
      return Promise.reject(fault("KEYWORD_MONTHLY_RESPONSE_LIFETIME_UNAVAILABLE"));
    }
    const role = fresh ? "owner" : "waiter";
    observe(onLifecycleObservation, fresh ? "owner" : "shared", role);
    const promise = new Promise((resolve, reject) => {
      const waiter = { resolve, reject, signal, timer: null, onAbort: null };
      waiter.onAbort = () => {
        if (!entry.waiters.has(waiter)) return;
        const reason = metadataOwnsTimer && ["KEYWORD_MONTHLY_QUERY_TIMEOUT", "KEYWORD_MONTHLY_QUERY_CLOSED", "KEYWORD_MONTHLY_QUERY_CLOCK_INVALID"].includes(signal?.reason?.code) ? signal.reason.code : "KEYWORD_MONTHLY_QUERY_ABORTED";
        if (reason === "KEYWORD_MONTHLY_QUERY_TIMEOUT") { counters.timedOut++; observe(onLifecycleObservation, "waiter_timed_out", role); }
        else if (reason === "KEYWORD_MONTHLY_QUERY_ABORTED") { counters.aborted++; observe(onLifecycleObservation, "waiter_aborted", role); }
        finishWaiter(entry, waiter, fault(reason));
      };
      entry.waiters.add(waiter);
      try {
        if (!metadataOwnsTimer) waiter.timer = setTimeoutImpl(() => { if (!entry.waiters.has(waiter)) return; counters.timedOut++; observe(onLifecycleObservation, "waiter_timed_out", role); finishWaiter(entry, waiter, fault("KEYWORD_MONTHLY_QUERY_TIMEOUT")); }, timeoutMs);
        waiter.timer?.unref?.();
        signal?.addEventListener("abort", waiter.onAbort, { once: true });
        if (signal?.aborted) waiter.onAbort();
      } catch (error) { finishWaiter(entry, waiter, error); }
    });
    if (fresh) {
      if (!entry.waiters.size) { flights.delete(key); entry.settled = true; entry.resolveLifetime?.(); }
      else {
        counters.started++;
        Promise.resolve().then(() => {
          if (entry.producerController?.signal.aborted) throw fault("KEYWORD_MONTHLY_QUERY_ABORTED");
          observe(entry.onLifecycleObservation, "operation_started", "owner");
          return entry.producerController ? operation({ signal: entry.producerController.signal }) : operation();
        })
          .then(value => entry.producerController?.signal.aborted
            ? complete(entry, fault("KEYWORD_MONTHLY_QUERY_ABORTED"), undefined, true) : complete(entry, null, value, false),
          error => complete(entry, error, undefined, true));
      }
    } else counters.shared++;
    return promise;
  }
  function run(identity, operation, options = {}) {
    return metadataKinds.has(options.metadataKind) ? runMetadata(identity, operation, options) : runImmediate(identity, operation, options);
  }
  function status() {
    const at = Number(now());
    return { closed, maxInFlight, maxWaiters, timeoutMs, inFlight: flights.size,
      waitingCallers: [...flights.values()].reduce((sum, entry) => sum + entry.waiters.size, 0) + metadataQueue.length,
      queuedMetadataCallers: metadataQueue.length,
      abandonedInFlight: [...flights.values()].filter(entry => !entry.waiters.size).length,
      oldestAgeMs: flights.size && Number.isFinite(at) ? Math.max(0, ...[...flights.values()].map(entry => at - entry.startedAt)) : 0,
      operationDiagnostics: { version: 1, historyLimit: 32, active: [...flights.values()].map(flightView),
        queued: metadataQueue.map(item => ({ kind:item.kind,ownerTraceId:item.ownerTraceId,queuedAt:item.queuedAt,deadlineAt:item.deadlineAt })), recent: recent.map(row => ({ ...row })) },
      counters: { ...counters } };
  }
  function close() {
    closed = true;
    for (const item of [...metadataCallers]) expireMetadataCaller(item, "KEYWORD_MONTHLY_QUERY_CLOSED");
    for (const entry of flights.values()) for (const waiter of [...entry.waiters]) finishWaiter(entry, waiter, fault("KEYWORD_MONTHLY_QUERY_CLOSED"));
  }
  return Object.freeze({ run, status, close });
}

module.exports = { createKeywordMonthlyQueryLifecycle };
