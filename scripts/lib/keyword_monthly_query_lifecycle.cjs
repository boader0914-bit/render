"use strict";

// Share only unfinished read promises, never a decoded result cache. A caller's
// timeout/disconnect releases its waiter; it cannot cancel another reader or
// start a duplicate calculation while the original operation still owns work.
const crypto = require("node:crypto");
const fault = code => Object.assign(new Error(code), { code, statusCode: 503,
  ...(code === "KEYWORD_MONTHLY_QUERY_ABORTED" ? { name: "AbortError" } : {}) });

function createKeywordMonthlyQueryLifecycle({ maxInFlight = 4, maxWaiters = 8,
  timeoutMs = 20000, now = Date.now, setTimeoutImpl = setTimeout, clearTimeoutImpl = clearTimeout } = {}) {
  if (!Number.isSafeInteger(maxInFlight) || maxInFlight < 1 || maxInFlight > 16
    || !Number.isSafeInteger(maxWaiters) || maxWaiters < 1 || maxWaiters > 32
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000
    || [now, setTimeoutImpl, clearTimeoutImpl].some(fn => typeof fn !== "function")) throw new TypeError("Invalid keyword query bounds");
  const flights = new Map(); let closed = false;
  const counters = { started: 0, shared: 0, completed: 0, failed: 0, aborted: 0, timedOut: 0, rejectedBusy: 0, cleanupErrors: 0 };
  function finishWaiter(entry, waiter, error, value, failed = Boolean(error)) {
    if (!entry.waiters.delete(waiter)) return;
    try { if (waiter.timer !== null) clearTimeoutImpl(waiter.timer); } catch { counters.cleanupErrors++; }
    try { waiter.signal?.removeEventListener("abort", waiter.onAbort); } catch { counters.cleanupErrors++; }
    if (failed) waiter.reject(error); else waiter.resolve(value);
  }
  function complete(entry, error, value, failed = Boolean(error)) {
    if (flights.get(entry.key) === entry) flights.delete(entry.key);
    counters[failed ? "failed" : "completed"]++;
    for (const waiter of [...entry.waiters]) finishWaiter(entry, waiter, error, value, failed);
    // No result, exception, request, or response is retained by the registry.
  }
  function run(identity, operation, { signal } = {}) {
    if (typeof identity !== "string" || !identity || Buffer.byteLength(identity) > 8192 || typeof operation !== "function"
      || signal !== undefined && (!signal || typeof signal.addEventListener !== "function" || typeof signal.removeEventListener !== "function")) {
      return Promise.reject(new TypeError("Invalid keyword read"));
    }
    if (closed) return Promise.reject(fault("KEYWORD_MONTHLY_QUERY_CLOSED"));
    if (signal?.aborted) return Promise.reject(fault("KEYWORD_MONTHLY_QUERY_ABORTED"));
    const key = crypto.createHash("sha256").update(identity).digest("hex");
    let entry = flights.get(key), fresh = false;
    if (!entry) {
      if (flights.size >= maxInFlight) { counters.rejectedBusy++; return Promise.reject(fault("KEYWORD_MONTHLY_QUERY_BUSY")); }
      const startedAt = Number(now());
      if (!Number.isFinite(startedAt)) return Promise.reject(fault("KEYWORD_MONTHLY_QUERY_CLOCK_INVALID"));
      entry = { key, startedAt, waiters: new Set() }; flights.set(key, entry); fresh = true;
    } else if (entry.waiters.size >= maxWaiters) {
      counters.rejectedBusy++; return Promise.reject(fault("KEYWORD_MONTHLY_QUERY_BUSY"));
    }
    const promise = new Promise((resolve, reject) => {
      const waiter = { resolve, reject, signal, timer: null, onAbort: null };
      waiter.onAbort = () => { if (!entry.waiters.has(waiter)) return; counters.aborted++; finishWaiter(entry, waiter, fault("KEYWORD_MONTHLY_QUERY_ABORTED")); };
      entry.waiters.add(waiter);
      try {
        waiter.timer = setTimeoutImpl(() => { if (!entry.waiters.has(waiter)) return; counters.timedOut++; finishWaiter(entry, waiter, fault("KEYWORD_MONTHLY_QUERY_TIMEOUT")); }, timeoutMs);
        waiter.timer?.unref?.();
        signal?.addEventListener("abort", waiter.onAbort, { once: true });
        if (signal?.aborted) waiter.onAbort();
      } catch (error) { finishWaiter(entry, waiter, error); }
    });
    if (fresh) {
      if (!entry.waiters.size) flights.delete(key);
      else {
        counters.started++;
        Promise.resolve().then(operation).then(value => complete(entry, null, value, false), error => complete(entry, error, undefined, true));
      }
    } else counters.shared++;
    return promise;
  }
  function status() {
    const at = Number(now());
    return { closed, maxInFlight, maxWaiters, timeoutMs, inFlight: flights.size,
      waitingCallers: [...flights.values()].reduce((sum, entry) => sum + entry.waiters.size, 0),
      abandonedInFlight: [...flights.values()].filter(entry => !entry.waiters.size).length,
      oldestAgeMs: flights.size && Number.isFinite(at) ? Math.max(0, ...[...flights.values()].map(entry => at - entry.startedAt)) : 0,
      counters: { ...counters } };
  }
  function close() {
    closed = true;
    for (const entry of flights.values()) for (const waiter of [...entry.waiters]) finishWaiter(entry, waiter, fault("KEYWORD_MONTHLY_QUERY_CLOSED"));
  }
  return Object.freeze({ run, status, close });
}

module.exports = { createKeywordMonthlyQueryLifecycle };
