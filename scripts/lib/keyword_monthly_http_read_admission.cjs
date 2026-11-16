"use strict";

// A read-only, bounded preflight before an admin read can enter the analytical
// queue. The scheduler's independent admission check remains authoritative for
// a marker created after this check. Neither check reclaims or changes a lease.
function createKeywordMonthlyHttpReadAdmission({ readAdmission = null, timeoutMs = 1500,
  setTimeoutImpl = setTimeout, clearTimeoutImpl = clearTimeout } = {}) {
  if (readAdmission !== null && typeof readAdmission !== "function"
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 1500
    || typeof setTimeoutImpl !== "function" || typeof clearTimeoutImpl !== "function") throw new TypeError("Invalid monthly read admission");
  const denied = code => Object.assign(new Error(code), { code, statusCode: 503 });
  return async function assertReadAdmission() {
    if (readAdmission === null) return;
    let timer;
    const unavailable = "KEYWORD_MONTHLY_PREPARED_CONVERSION_UNVERIFIED";
    try {
      const result = await Promise.race([
        Promise.resolve().then(readAdmission),
        new Promise((resolve, reject) => { timer = setTimeoutImpl(() => reject(denied(unavailable)), timeoutMs); })
      ]);
      if (result?.allowed === true && result.reasonCode === null) return;
      throw denied(result?.allowed === false && result.reasonCode === "KEYWORD_INCREMENTAL_PREPARED_CONVERSION_ACTIVE"
        ? "KEYWORD_MONTHLY_PREPARED_CONVERSION_ACTIVE" : unavailable);
    } catch (error) {
      throw denied(error?.code === "KEYWORD_MONTHLY_PREPARED_CONVERSION_ACTIVE"
        ? error.code : unavailable);
    } finally { if (timer !== undefined) clearTimeoutImpl(timer); }
  };
}

module.exports = { createKeywordMonthlyHttpReadAdmission };
