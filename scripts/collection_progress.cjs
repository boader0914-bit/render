"use strict";

const COLLECTOR_PROGRESS_PREFIX = "COLLECTOR_PROGRESS ";

function sanitizeCollectionProgress(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || value.version !== 1 || value.phase !== "inventory"
    || !Number.isSafeInteger(value.completedPlaces) || value.completedPlaces < 0
    || !Number.isSafeInteger(value.totalPlaces) || value.totalPlaces < 0
    || value.completedPlaces > value.totalPlaces
    || typeof value.currentPlaceName !== "string" || typeof value.updatedAt !== "string") return null;
  const time = new Date(value.updatedAt);
  if (!Number.isFinite(time.getTime()) || time.toISOString() !== value.updatedAt) return null;
  return {
    version: 1,
    phase: "inventory",
    completedPlaces: value.completedPlaces,
    totalPlaces: value.totalPlaces,
    currentPlaceName: value.currentPlaceName.replace(/[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]/g, " ").replace(/\s+/g, " ").trim().slice(0, 120),
    updatedAt: time.toISOString(),
  };
}

function parseCollectionProgressLine(line) {
  if (typeof line !== "string" || line.length > 4096 || !line.startsWith(COLLECTOR_PROGRESS_PREFIX)) return null;
  try {
    return sanitizeCollectionProgress(JSON.parse(line.slice(COLLECTOR_PROGRESS_PREFIX.length)));
  } catch { return null; }
}

// This measures finished place processing, including errors. It does not assert
// provider success, result validation, archive persistence, or job completion.
function createCollectionProgressReporter({ totalPlaces, write = line => process.stdout.write(`${line}\n`), now = () => new Date().toISOString() } = {}) {
  if (!Number.isSafeInteger(totalPlaces) || totalPlaces < 0) throw new TypeError("INVALID_COLLECTION_PROGRESS_TOTAL");
  const active = new Map();
  const completed = new Set();
  let started = false;
  let latest = null;
  function emit() {
    latest = sanitizeCollectionProgress({
      version: 1, phase: "inventory", completedPlaces: completed.size, totalPlaces,
      currentPlaceName: [...active.values()].at(-1) || "", updatedAt: now(),
    });
    if (latest) {
      // Optional progress output must not turn successful collection into failure.
      try { write(`${COLLECTOR_PROGRESS_PREFIX}${JSON.stringify(latest)}`); } catch { /* keep collecting */ }
    }
    return latest ? { ...latest } : null;
  }
  return {
    start() {
      if (started) return latest ? { ...latest } : null;
      started = true;
      return emit();
    },
    startPlace(placeId, name = "") {
      const key = String(placeId || "");
      if (!started || !key || active.has(key) || completed.has(key) || active.size + completed.size >= totalPlaces) return false;
      active.set(key, typeof name === "string" ? name : "");
      emit();
      return true;
    },
    completePlace(placeId) {
      const key = String(placeId || "");
      if (!active.delete(key)) return false;
      completed.add(key);
      emit();
      return true;
    },
    snapshot() { return latest ? { ...latest } : null; },
  };
}

module.exports = { COLLECTOR_PROGRESS_PREFIX, sanitizeCollectionProgress, parseCollectionProgressLine, createCollectionProgressReporter };
