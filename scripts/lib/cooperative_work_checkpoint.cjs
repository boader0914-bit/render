"use strict";

const { AsyncLocalStorage } = require("node:async_hooks");

// Only the scheduler creates an enabled scope. A checkpoint never transfers a
// live heap to another reader: it rejects the current operation so its normal
// finally blocks can release everything before the scheduler admits a peer.
const scopes = new AsyncLocalStorage();
const YIELD_CODE = "ANALYTICAL_WORK_YIELDED";
const yielded = () => Object.assign(new Error(YIELD_CODE), { code: YIELD_CODE });
function current() {
  const owner = scopes.getStore();
  return owner?.enabled && owner.isCurrent() ? owner : null;
}
function runWithCooperativeWork(owner, operation) {
  if (typeof operation !== "function") throw new TypeError("Cooperative work must be a function");
  return scopes.run(owner || null, operation);
}
function assertCooperativeWorkActive() {
  if (current()?.yieldRequested) throw yielded();
}
function setCooperativeWorkStage(index) {
  if (!Number.isSafeInteger(index) || index < 0) throw new TypeError("Cooperative stage must be a nonnegative integer");
  const owner = current();
  if (!owner) return;
  if (owner.yieldRequested) throw yielded();
  owner.setStage(index);
}
function setCooperativeWorkPhase(index, unitIndex = 0) {
  if (!Number.isSafeInteger(index) || index < 0) throw new TypeError("Cooperative phase must be a nonnegative integer");
  if (!Number.isSafeInteger(unitIndex) || unitIndex < 0) throw new TypeError("Cooperative unit must be a nonnegative integer");
  const owner = current();
  if (!owner) return;
  if (owner.yieldRequested) throw yielded();
  owner.setPhase(index, unitIndex);
}
function setCooperativeWorkRevision(revision) {
  if (typeof revision !== "string" || !revision || revision.length > 512) throw new TypeError("Cooperative revision must be a bounded string");
  const owner = current();
  if (!owner) return;
  if (owner.yieldRequested) throw yielded();
  owner.setRevision(revision);
}
function cooperativeWorkCheckpoint() {
  const owner = current();
  if (!owner) return;
  if (owner.yieldRequested) throw yielded();
  owner.checkpoint();
  if (owner.nonInterruptibleDepth === 0 && owner.shouldYield()) {
    owner.yieldRequested = true;
    throw yielded();
  }
}
async function runCooperativeCheckpointReads() {
  const owner = current();
  if (!owner || owner.nonInterruptibleDepth !== 0 || owner.yieldRequested) return;
  // A trusted bounded proof may borrow this safe boundary. The background
  // callback remains paused until the proof and all of its cleanup settle.
  // It cannot borrow a boundary inside an atomic publication operation.
  await owner.drainCheckpointReads?.();
}
async function runNonInterruptibleCooperativeWork(operation) {
  if (typeof operation !== "function") throw new TypeError("Publication work must be a function");
  assertCooperativeWorkActive();
  const owner = current();
  if (!owner) return operation();
  // A separate async branch of the same owner can reach publication while a
  // sibling lends its checkpoint. Fence in both directions: readers do not
  // enter an atomic section, and publication waits for a borrowed read to end.
  while (owner.hasCheckpointRead?.()) await owner.waitForCheckpointRead();
  if (!owner.isCurrent()) throw Object.assign(new Error("ANALYTICAL_WORK_OWNER_EXPIRED"), { code: "ANALYTICAL_WORK_OWNER_EXPIRED" });
  assertCooperativeWorkActive();
  owner.nonInterruptibleDepth++;
  try { return await operation(); }
  finally { owner.nonInterruptibleDepth--; }
}
function isCooperativeWorkYield(error) { return error?.code === YIELD_CODE; }

module.exports = { runWithCooperativeWork, cooperativeWorkCheckpoint, setCooperativeWorkStage, setCooperativeWorkPhase, setCooperativeWorkRevision, assertCooperativeWorkActive,
  runCooperativeCheckpointReads, runNonInterruptibleCooperativeWork, isCooperativeWorkYield, YIELD_CODE };
