"use strict";

// Application receipts deliberately live outside the signed Worker output
// tree.  A signed bundle proves what the Worker produced; this document
// proves that Preview applied that immutable projection to its own stores.
const crypto = require("node:crypto");
const path = require("node:path");
const { createSecureJsonStore } = require("./secure_json_store.cjs");

const DOCUMENT_TYPE = "lodging-worker-run-projection-application";
const SCHEMA_VERSION = "collection-worker-run-projection-application.v1";
const HASH = /^[a-f0-9]{64}$/u;
const RUN_ID = /^preview-worker-run-[a-f0-9]{20}$/u;

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

function applicationHash(value) {
  return crypto.createHash("sha256").update(stable(value)).digest("hex");
}

function positiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error(`${label} is invalid`);
  return number;
}

function validateReceipt(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("projection application receipt is invalid");
  if (value.documentType !== DOCUMENT_TYPE || value.schemaVersion !== SCHEMA_VERSION || value.state !== "applied") {
    throw new Error("projection application receipt is invalid");
  }
  if (!HASH.test(String(value.transactionId || "")) || !RUN_ID.test(String(value.runId || "")) || !HASH.test(String(value.artifactHash || "")) || !HASH.test(String(value.projectionsHash || "")) || !HASH.test(String(value.applicationHash || ""))) {
    throw new Error("projection application receipt identity is invalid");
  }
  for (const key of [
    "companyProjectionCount", "companyAppliedCount", "productProjectionCount", "productAppliedCount",
    "revenueProjectionCount", "revenueAppliedCount", "historyProjectionCount", "historyAppliedCount"
  ]) positiveInteger(value[key], key);
  if (!Number.isFinite(Date.parse(String(value.appliedAt || "")))) throw new Error("projection application receipt time is invalid");
  const body = { ...value };
  delete body.applicationHash;
  if (applicationHash(body) !== value.applicationHash) throw new Error("projection application receipt hash is invalid");
  return true;
}

function receiptFrom(input = {}) {
  const counts = input.counts || {};
  const base = {
    documentType: DOCUMENT_TYPE,
    schemaVersion: SCHEMA_VERSION,
    state: "applied",
    transactionId: String(input.transactionId || ""),
    runId: String(input.runId || ""),
    artifactHash: String(input.artifactHash || ""),
    projectionsHash: String(input.projectionsHash || ""),
    collectionStatus: String(input.collectionStatus || ""),
    companyProjectionCount: positiveInteger(counts.companyProjectionCount, "companyProjectionCount"),
    companyAppliedCount: positiveInteger(counts.companyAppliedCount, "companyAppliedCount"),
    productProjectionCount: positiveInteger(counts.productProjectionCount, "productProjectionCount"),
    productAppliedCount: positiveInteger(counts.productAppliedCount, "productAppliedCount"),
    revenueProjectionCount: positiveInteger(counts.revenueProjectionCount, "revenueProjectionCount"),
    revenueAppliedCount: positiveInteger(counts.revenueAppliedCount, "revenueAppliedCount"),
    historyProjectionCount: positiveInteger(counts.historyProjectionCount, "historyProjectionCount"),
    historyAppliedCount: positiveInteger(counts.historyAppliedCount, "historyAppliedCount"),
    appliedAt: new Date(input.appliedAt || Date.now()).toISOString()
  };
  base.applicationHash = applicationHash(base);
  validateReceipt(base);
  return Object.freeze(base);
}

function createCollectionWorkerProjectionApplicationStore(options = {}) {
  if (!options.runtimeRoot || !path.isAbsolute(options.runtimeRoot)) throw new TypeError("projection application store requires an absolute runtime root");
  const runtimeRoot = path.resolve(options.runtimeRoot);
  const root = path.join(runtimeRoot, "collector_worker", "projection_applications");
  const store = options.store || createSecureJsonStore();
  const receiptPath = (transactionId) => {
    if (!HASH.test(String(transactionId || ""))) throw new TypeError("projection application transaction ID is invalid");
    return path.join(root, `${transactionId}.json`);
  };
  return Object.freeze({
    root,
    async read(transactionId) {
      try {
        return await store.readJsonFile(receiptPath(transactionId), { validator: validateReceipt });
      } catch (error) {
        if (error?.code === "ENOENT") return null;
        throw error;
      }
    },
    async writeOnce(receipt) {
      validateReceipt(receipt);
      try {
        await store.atomicWriteJson(receiptPath(receipt.transactionId), receipt, { validator: validateReceipt, noReplace: true });
        return Object.freeze({ receipt, reused: false });
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
        const existing = await store.readJsonFile(receiptPath(receipt.transactionId), { validator: validateReceipt });
        if (existing.applicationHash !== receipt.applicationHash) throw new Error("projection application receipt conflicts");
        return Object.freeze({ receipt: existing, reused: true });
      }
    }
  });
}

module.exports = {
  DOCUMENT_TYPE,
  SCHEMA_VERSION,
  applicationHash,
  createCollectionWorkerProjectionApplicationStore,
  receiptFrom,
  validateReceipt
};
