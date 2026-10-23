"use strict";

// A queued caller publishes only a lightweight group, never its scheduler
// promise. An owner that reenters can start the same load without awaiting a
// queued caller which needs that owner's lease to finish first.
function createScheduledSingleFlight({ runWork = operation => operation(), kind = "analysis" } = {}) {
  if (typeof runWork !== "function") throw new TypeError("Scheduled work must be a function");
  const groups = new Map();
  return {
    has: key => groups.has(key),
    async run(key, load) {
      if (typeof load !== "function") throw new TypeError("Scheduled load must be a function");
      let group = groups.get(key);
      if (!group) {
        group = { started: false, loadPromise: null, callers: 0 };
        groups.set(key, group);
      }
      group.callers += 1;
      const forget = () => { if (groups.get(key) === group) groups.delete(key); };
      try {
        return await runWork(() => {
          if (!group.started) {
            group.started = true;
            // Publish before executing user code, including synchronous code.
            group.loadPromise = Promise.resolve().then(() => load());
            // Completed groups must not admit a new caller after invalidation.
            // Both handlers resolve so a rejected load leaves no orphan tail.
            group.loadPromise.then(forget, forget);
          }
          return group.loadPromise;
        }, { priority: "foreground", kind });
      } finally {
        group.callers -= 1;
        // A scheduler may reject before invoking its callback at all.
        if (group.callers === 0) forget();
      }
    }
  };
}

module.exports = { createScheduledSingleFlight };
