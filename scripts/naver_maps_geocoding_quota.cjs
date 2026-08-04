"use strict";

const path = require("node:path");
const { updateJsonFile } = require("./secure_json_store.cjs");
const {
  MAX_TRANSIENT_MONTHLY_REQUESTS,
  kstMonthKey,
  monthlyRequestLimit
} = require("./naver_maps_geocoding_adapter.cjs");

const QUOTA_SCHEMA_VERSION = 1;

function quotaError() {
  const error = new Error("NAVER Maps Geocoding monthly display budget exhausted");
  error.code = "NAVER_GEOCODING_MONTHLY_BUDGET_EXHAUSTED";
  error.statusCode = 429;
  return error;
}

function validateQuotaLedger(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  if (JSON.stringify(keys) !== JSON.stringify(["month", "schemaVersion", "used"])) return false;
  return value.schemaVersion === QUOTA_SCHEMA_VERSION
    && /^\d{4}-\d{2}$/.test(String(value.month || ""))
    && Number.isInteger(value.used)
    && value.used >= 0
    && value.used <= MAX_TRANSIENT_MONTHLY_REQUESTS;
}

function createPersistentMonthlyRequestBudget(options = {}) {
  const filePath = path.resolve(String(options.filePath || ""));
  if (!options.filePath || !path.isAbsolute(String(options.filePath))) {
    throw new TypeError("NAVER Maps Geocoding quota requires an absolute file path");
  }
  const now = typeof options.now === "function" ? options.now : () => new Date();
  const limit = monthlyRequestLimit(options.limit);
  let last = Object.freeze({ month: kstMonthKey(now()), limit, used: 0, remaining: limit });

  const storeOptions = {
    defaultValue: () => ({ schemaVersion: QUOTA_SCHEMA_VERSION, month: kstMonthKey(now()), used: 0 }),
    validator: validateQuotaLedger,
    mode: 0o600,
    directoryMode: 0o700
  };

  return Object.freeze({
    async reserve(count = 1) {
      const requested = Number(count);
      if (!Number.isInteger(requested) || requested < 1 || requested > MAX_TRANSIENT_MONTHLY_REQUESTS) {
        throw quotaError();
      }
      const currentMonth = kstMonthKey(now());
      const persisted = await updateJsonFile(filePath, (value) => {
        const used = value.month === currentMonth ? value.used : 0;
        if (used + requested > limit) throw quotaError();
        return {
          schemaVersion: QUOTA_SCHEMA_VERSION,
          month: currentMonth,
          used: used + requested
        };
      }, storeOptions);
      last = Object.freeze({
        month: persisted.month,
        limit,
        used: persisted.used,
        remaining: Math.max(0, limit - persisted.used)
      });
      return last;
    },
    snapshot() {
      return last;
    },
    filePath
  });
}

module.exports = {
  QUOTA_SCHEMA_VERSION,
  createPersistentMonthlyRequestBudget,
  validateQuotaLedger
};
