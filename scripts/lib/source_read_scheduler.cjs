"use strict";

const { cooperativeWorkCheckpoint } = require("./cooperative_work_checkpoint.cjs");

// Source reconstruction is deliberately single-file: overlapping it multiplies
// the complete history/catalog heap. Ordinary readers finish before a peer;
// an opted-in industry owner can instead unwind at a safe checkpoint before
// the analytical scheduler admits a pending user's read.
function createSourceReadScheduler({ foregroundBurst = 4, maxInteractiveHoldMs = 2500 } = {}) {
  if (!Number.isSafeInteger(foregroundBurst) || foregroundBurst < 1) throw new TypeError("foregroundBurst must be a positive integer");
  if (!Number.isSafeInteger(maxInteractiveHoldMs) || maxInteractiveHoldMs < 1) throw new TypeError("maxInteractiveHoldMs must be a positive integer");
  const foreground = [], background = [];
  const checkpointWaiters = [];
  let active = false, activePriority = null, consecutiveForeground = 0;
  let interactiveLeases = 0, interactiveExpired = false, interactiveTimer = null;
  const holdingBackground = () => interactiveLeases > 0 && !interactiveExpired;
  const shouldPauseBackground = () => activePriority === "background" && holdingBackground() && foreground.length === 0;
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
    const complete = (value, error, failed) => {
      // Settle the private source slot before publishing the caller's result.
      // A cooperatively rejected owner may now unwind and requeue; no queued
      // analytical reader can inherit a still-active source allocation.
      active = false; activePriority = null; wakeCheckpoints();
      if (failed) task.reject(error); else task.resolve(value);
      // An awaiting reader may enqueue its immediately following foreground
      // scope before maintenance is selected, preserving the original burst
      // semantics while making the completed slot visibly inactive already.
      queueMicrotask(next);
    };
    Promise.resolve().then(task.operation).then(value => complete(value, null, false), error => complete(undefined, error, true));
  }

  function run(operation, { priority = "foreground" } = {}) {
    if (typeof operation !== "function") return Promise.reject(new TypeError("Source read operation is required"));
    if (!["foreground", "background"].includes(priority)) return Promise.reject(new TypeError("Invalid source read priority"));
    return new Promise((resolve, reject) => {
      (priority === "background" ? background : foreground).push({ operation, resolve, reject, priority });
      // A cache miss can need a foreground source read while an active
      // background reader is paused. Let that reader finish before the queued
      // foreground read, instead of waiting on its own interactive lease.
      wakeCheckpoints();
      next();
    });
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
    // request can acquire it. An eligible industry owner rejects and unwinds;
    // otherwise this background reader retains its slot during a short pause.
    await new Promise(resolve => setImmediate(resolve));
    cooperativeWorkCheckpoint();
    while (shouldPauseBackground()) await new Promise(resolve => checkpointWaiters.push(resolve));
  }

  return { run, runInteractive, checkpoint,
    status: () => ({ active, queuedForeground: foreground.length, queuedBackground: background.length }),
    interactiveStatus: () => ({ activeLeases: interactiveLeases, holdingBackground: holdingBackground(), pausedBackground: checkpointWaiters.length > 0 }) };
}

module.exports = { createSourceReadScheduler };
