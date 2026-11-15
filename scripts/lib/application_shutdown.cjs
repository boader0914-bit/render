"use strict";

// Process lifecycle only. A deployment first stops accepting new HTTP work and
// asks the explicitly supplied derived worker to abort/drain its own children.
// This host never removes locks, changes schedules or writes source records.
const hosts = new WeakMap();

function installApplicationShutdown({ server, closeDerivedWork, processControl = process,
  graceMs = 20000, logger = console, setTimeoutImpl = setTimeout, clearTimeoutImpl = clearTimeout } = {}) {
  if (!server || typeof server.close !== "function" || typeof closeDerivedWork !== "function"
    || !processControl || ["on", "removeListener", "exit"].some(key => typeof processControl[key] !== "function")
    || !Number.isSafeInteger(graceMs) || graceMs < 100 || graceMs > 30000
    || [setTimeoutImpl, clearTimeoutImpl].some(value => typeof value !== "function")) {
    throw TypeError("Explicit application shutdown callbacks are required");
  }
  if (hosts.has(server)) return hosts.get(server);
  let pending = null, detached = false, finished = false, timer = null;
  const log = (event, fields) => {
    try { logger.info?.(event, JSON.stringify(fields)); } catch { /* Logs never prevent cleanup. */ }
  };
  const detach = () => {
    if (detached) return;
    detached = true;
    processControl.removeListener("SIGTERM", onTerm);
    processControl.removeListener("SIGINT", onInt);
  };
  function finish(status, code) {
    if (finished) return;
    finished = true;
    if (timer !== null) clearTimeoutImpl(timer);
    timer = null;
    detach();
    log("application_shutdown_finished", { status, exitCode: code });
    // The normal signal would terminate immediately. Waiting here gives the
    // worker's finally blocks their own cleanup opportunity, without making a
    // new claim that an uncertain or still-live child is safe to unlock.
    processControl.exit(code);
  }
  function begin(signal) {
    if (pending) return pending;
    const safeSignal = signal === "SIGINT" ? "SIGINT" : "SIGTERM";
    log("application_shutdown_started", { signal: safeSignal, graceMs });
    let resolvePending;
    pending = new Promise(resolve => { resolvePending = resolve; });
    timer = setTimeoutImpl(() => {
      finish("timeout", 1);
      resolvePending({ status: "timeout" });
    }, graceMs);
    // Keep the grace timer referenced: Node must not exit between an abort and
    // the active worker's durable receipt/owned-lock cleanup.
    const stoppedHttp = new Promise((resolve, reject) => {
      try {
        server.close(error => error && error.code !== "ERR_SERVER_NOT_RUNNING" ? reject(error) : resolve());
        server.closeIdleConnections?.();
      } catch (error) {
        if (error?.code === "ERR_SERVER_NOT_RUNNING") resolve(); else reject(error);
      }
    });
    const stoppedDerived = Promise.resolve().then(closeDerivedWork);
    Promise.allSettled([stoppedHttp, stoppedDerived]).then(results => {
      const status = results.every(row => row.status === "fulfilled") ? "complete" : "failed";
      finish(status, status === "complete" ? 0 : 1);
      resolvePending({ status });
    });
    return pending;
  }
  function onTerm() { void begin("SIGTERM"); }
  function onInt() { void begin("SIGINT"); }
  processControl.on("SIGTERM", onTerm);
  processControl.on("SIGINT", onInt);
  const host = Object.freeze({ begin, status: () => ({ closing: pending !== null, finished, detached }) });
  hosts.set(server, host);
  return host;
}

module.exports = { installApplicationShutdown };
