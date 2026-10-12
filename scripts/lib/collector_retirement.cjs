"use strict";

const WORKER_KEYS = Object.freeze(["web", "manual", "scheduled"]);
const RETIREMENT_REASON = "인사이트 서버로 전환되어 신규 수집과 예약을 받지 않습니다.";

function parseRetiredWorkerKeys(value = "") {
  if (typeof value !== "string") throw new Error("COLLECTOR_RETIRED_WORKER_KEYS_INVALID");
  if (!value.trim()) return [];
  const keys = value.split(",").map(key => key.trim());
  if (keys.some(key => !WORKER_KEYS.includes(key))) throw new Error("COLLECTOR_RETIRED_WORKER_KEYS_INVALID");
  return [...new Set(keys)];
}

function createCollectorRetirementPolicy(value = "") {
  const retired = new Set(parseRetiredWorkerKeys(value));
  const isRetired = workerKey => retired.has(workerKey);
  function retirementStatus(workerKey) {
    return { retired: isRetired(workerKey), retirementReason: isRetired(workerKey) ? RETIREMENT_REASON : "" };
  }
  function assertAdmission(workerKey) {
    if (isRetired(workerKey)) throw Object.assign(new Error(RETIREMENT_REASON), {
      code: "COLLECTOR_WORKER_RETIRED", statusCode: 409
    });
  }
  function workerStatus(workerKey, status = {}) {
    return { ...status, ...retirementStatus(workerKey), ...(isRetired(workerKey) ? { ready: false } : {}) };
  }
  function scheduleStatus(workerKey, status = {}) {
    return { ...status, ...retirementStatus(workerKey), ...(isRetired(workerKey) ? {
      storedEnabled: status.enabled === true, enabled: false, nextRunAt: null, previewNextRunAt: null, upcomingItems: []
    } : {}) };
  }
  function scheduler(workerKey, original) {
    return {
      ...original,
      status: async () => scheduleStatus(workerKey, await original.status()),
      // A retired lane never starts a timer or creates an occurrence. The original
      // config and terminal receipts remain available through status, unchanged.
      start: async () => scheduleStatus(workerKey, await (isRetired(workerKey) ? original.status() : original.start())),
      tick: (...args) => isRetired(workerKey) ? Promise.resolve(null) : original.tick(...args),
      ...(original.updateConfig ? { updateConfig: (...args) => { assertAdmission(workerKey); return original.updateConfig(...args); } } : {}),
      ...(original.setEnabled ? { setEnabled: enabled => {
        if (enabled) assertAdmission(workerKey);
        // An explicit disable remains possible; retirement itself never rewrites config.
        return original.setEnabled(enabled);
      } } : {})
      // runNow/enqueueNow retain their original exclusive receipt retry lookup.
      // New receipt creation is blocked by beforeNewImmediateRun in the server.
    };
  }
  return { isRetired, assertAdmission, retirementStatus, workerStatus, scheduleStatus, scheduler };
}

module.exports = { WORKER_KEYS, RETIREMENT_REASON, parseRetiredWorkerKeys, createCollectorRetirementPolicy };
