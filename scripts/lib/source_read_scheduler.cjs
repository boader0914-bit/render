"use strict";

// The app installs its shared analytical-work admission before constructing
// source readers. Standalone consumers/tests retain the existing local queue.
let defaultHeavyWork = action => action();
let defaultExternalForegroundWaiting = () => false;
function configureSourceReadHeavyWork(runHeavy, { hasExternalForegroundWaiting = () => false } = {}) {
  if (typeof runHeavy !== "function") throw new TypeError("Heavy work admission is required");
  if (typeof hasExternalForegroundWaiting !== "function") throw new TypeError("Foreground inspection is required");
  defaultHeavyWork = runHeavy;
  defaultExternalForegroundWaiting = hasExternalForegroundWaiting;
}

// Source reconstruction is deliberately single-file: overlapping it multiplies
// the complete history/catalog heap. Prefer a user's pending read without
// interrupting the active reader or starving saved-view maintenance forever.
function createSourceReadScheduler({ foregroundBurst = 4, maxInteractiveHoldMs = 2500, runHeavy = defaultHeavyWork,
  hasExternalForegroundWaiting = defaultExternalForegroundWaiting } = {}) {
  if (!Number.isSafeInteger(foregroundBurst) || foregroundBurst < 1) throw new TypeError("foregroundBurst must be a positive integer");
  if (!Number.isSafeInteger(maxInteractiveHoldMs) || maxInteractiveHoldMs < 1) throw new TypeError("maxInteractiveHoldMs must be a positive integer");
  if (typeof runHeavy !== "function" || typeof hasExternalForegroundWaiting !== "function") throw new TypeError("Invalid shared scheduling options");
  const foreground = [], background = [];
  const checkpointWaiters = [];
  let active = false, activePriority = null, consecutiveForeground = 0;
  let interactiveLeases = 0, interactiveExpired = false, interactiveTimer = null;
  const holdingBackground = () => interactiveLeases > 0 && !interactiveExpired;
  const shouldPauseBackground = () => activePriority === "background" && holdingBackground() && foreground.length === 0
    && !hasExternalForegroundWaiting();
  function wakeCheckpoints() {
    if (!shouldPauseBackground()) for (const resolve of checkpointWaiters.splice(0)) resolve();
  }

  function next() {
    if (active) return;
    let task;
    if (foreground.length && (!background.length || consecutiveForeground < foregroundBurst)) {
      task = foreground.shift(); consecutiveForeground++;
    } else if (background.length && (!holdingBackground() || consecutiveForeground >= foregroundBurst)) {
      task = background.shift(); consecutiveForeground = 0;
    }
    if (!task) { if (!foreground.length && !background.length) consecutiveForeground = 0; return; }
    active = true; activePriority = task.priority;
    Promise.resolve().then(task.operation).then(task.resolve, task.reject).finally(() => {
      active = false; activePriority = null; wakeCheckpoints();
      next();
    });
  }

  function enqueue(operation, priority) {
    return new Promise((resolve, reject) => {
      (priority === "background" ? background : foreground).push({ operation, resolve, reject, priority });
      wakeCheckpoints();
      next();
    });
  }

  function run(operation, { priority = "foreground" } = {}) {
    if (typeof operation !== "function") return Promise.reject(new TypeError("Source read operation is required"));
    if (!["foreground", "background"].includes(priority)) return Promise.reject(new TypeError("Invalid source read priority"));
    // Always acquire the shared heavy slot before the local source slot. The
    // opposite order deadlocks when detail recovery needs a source reader.
    return runHeavy(() => enqueue(operation, priority), { label: "analysis_source_read", priority });
  }

  async function runInteractive(operation) {
    if (typeof operation !== "function") throw new TypeError("Interactive operation is required");
    if (interactiveLeases++ === 0) {
      interactiveExpired = false;
      interactiveTimer = setTimeout(() => {
        interactiveTimer = null; interactiveExpired = true;
        wakeCheckpoints(); next();
      }, maxInteractiveHoldMs);
    }
    try { return await operation(); }
    finally {
      interactiveLeases--;
      if (interactiveLeases === 0) {
        if (interactiveTimer) clearTimeout(interactiveTimer);
        interactiveTimer = null; interactiveExpired = false;
      }
      wakeCheckpoints(); next();
    }
  }

  async function checkpoint({ priority = "foreground" } = {}) {
    if (!["foreground", "background"].includes(priority)) throw new TypeError("Invalid source read priority");
    if (priority !== "background") return;
    // Even with no lease yet, yield one event-loop turn so a newly arrived HTTP
    // request can acquire it. The active source slot and its heap stay owned by
    // this background reader throughout the cooperative pause.
    await new Promise(resolve => setImmediate(resolve));
    while (shouldPauseBackground()) await new Promise(resolve => {
      // A cold detail can wait outside this local queue at shared admission.
      // Observe that foreground demand promptly instead of holding its owner
      // for the full interactive lease. The timer and waiter clean each other.
      const wake = () => {
        clearTimeout(timer);
        const index = checkpointWaiters.indexOf(wake);
        if (index >= 0) checkpointWaiters.splice(index, 1);
        resolve();
      };
      const timer = setTimeout(wake, 25);
      checkpointWaiters.push(wake);
    });
  }

  return { run, runInteractive, checkpoint,
    status: () => ({ active, queuedForeground: foreground.length, queuedBackground: background.length }),
    interactiveStatus: () => ({ activeLeases: interactiveLeases, holdingBackground: holdingBackground(), pausedBackground: checkpointWaiters.length > 0 }) };
}

module.exports = { createSourceReadScheduler, configureSourceReadHeavyWork };
