"use strict";

// Source reconstruction is deliberately single-file: overlapping it multiplies
// the complete history/catalog heap. Prefer a user's pending read without
// interrupting the active reader or starving saved-view maintenance forever.
function createSourceReadScheduler({ foregroundBurst = 4 } = {}) {
  if (!Number.isSafeInteger(foregroundBurst) || foregroundBurst < 1) throw new TypeError("foregroundBurst must be a positive integer");
  const foreground = [], background = [];
  let active = false, consecutiveForeground = 0;

  function next() {
    if (active) return;
    let task;
    if (foreground.length && (!background.length || consecutiveForeground < foregroundBurst)) {
      task = foreground.shift(); consecutiveForeground++;
    } else if (background.length) {
      task = background.shift(); consecutiveForeground = 0;
    }
    if (!task) { consecutiveForeground = 0; return; }
    active = true;
    Promise.resolve().then(task.operation).then(task.resolve, task.reject).finally(() => {
      active = false;
      next();
    });
  }

  function run(operation, { priority = "foreground" } = {}) {
    if (typeof operation !== "function") return Promise.reject(new TypeError("Source read operation is required"));
    if (!["foreground", "background"].includes(priority)) return Promise.reject(new TypeError("Invalid source read priority"));
    return new Promise((resolve, reject) => {
      (priority === "background" ? background : foreground).push({ operation, resolve, reject });
      next();
    });
  }

  return { run, status: () => ({ active, queuedForeground: foreground.length, queuedBackground: background.length }) };
}

module.exports = { createSourceReadScheduler };
