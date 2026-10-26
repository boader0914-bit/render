"use strict";

// Opt-in clock for the existing same-process missing-only service. It never
// constructs a second KOSIS client and never changes collection schedules.
const fs = require("node:fs/promises"), { constants } = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const DIRECTORY = "regional_market_missing", POLICY_FILE = "weekly-policy.json", TICK_MS = 30000, MAX_BYTES = 64 * 1024, DAY = 86400000, KST = 9 * 3600000;
const SCHEDULE = Object.freeze({ timezone: "Asia/Seoul", weekday: 1, hour: 12, minute: 0, intervalHours: 168, tickMs: TICK_MS });
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/, WEEK = /^20\d{2}-\d{2}-\d{2}$/;
const STATUSES = new Set(["queued", "running", "complete", "partial", "failed", "blocked", "needs_verification"]);
const DISPATCH = new Set(["idle", "claimed", "accepted", "reused", "failed"]);
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const exact = (value, keys) => object(value) && Object.keys(value).every(key => keys.includes(key)) && keys.every(key => Object.hasOwn(value, key));
const stamp = value => typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const fault = (code, statusCode = 503) => Object.assign(new Error(code), { code, statusCode });
const copy = value => structuredClone(value);
const samePath = (a, b) => process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
const inode = stat => `${stat.dev}:${stat.ino}`, identity = stat => `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
function weekOf(instant) {
  const kst = new Date(instant + KST), monday = new Date(Date.UTC(kst.getUTCFullYear(), kst.getUTCMonth(), kst.getUTCDate() - (kst.getUTCDay() + 6) % 7));
  return monday.toISOString().slice(0, 10);
}
function validWeek(value) { return WEEK.test(value || "") && Number.isFinite(Date.parse(value + "T00:00:00Z")) && weekOf(Date.parse(value + "T03:00:00Z")) === value; }
const dueFor = week => Date.parse(week + "T03:00:00.000Z");
const laterWeek = week => weekOf(dueFor(week) + 7 * DAY);
function defaultPolicy() { return { schemaVersion: 1, enabled: false, enabledAt: null, configuredAt: null, firstWeek: null, lastAttemptWeek: null, lastAttemptAt: null, lastJobId: null, dispatchStatus: "idle", errorCode: null }; }
function validatePolicy(value) {
  if (!exact(value, ["schemaVersion", "enabled", "enabledAt", "configuredAt", "firstWeek", "lastAttemptWeek", "lastAttemptAt", "lastJobId", "dispatchStatus", "errorCode"])
    || value.schemaVersion !== 1 || typeof value.enabled !== "boolean" || value.enabledAt !== null && !stamp(value.enabledAt) || value.configuredAt !== null && !stamp(value.configuredAt)
    || value.firstWeek !== null && !validWeek(value.firstWeek) || value.enabled && (!value.enabledAt || !value.firstWeek)
    || value.lastAttemptWeek !== null && !validWeek(value.lastAttemptWeek) || value.lastAttemptAt !== null && !stamp(value.lastAttemptAt)
    || value.lastJobId !== null && !UUID.test(value.lastJobId) || !DISPATCH.has(value.dispatchStatus) || ![null, "WEEKLY_REQUEST_FAILED", "WEEKLY_REQUEST_CONTRACT_INVALID"].includes(value.errorCode)
    || value.dispatchStatus !== "idle" && (!value.lastAttemptWeek || !value.lastAttemptAt)) throw fault("REGIONAL_MARKET_WEEKLY_POLICY_INVALID");
  return value;
}
function jobProjection(value) {
  if (!object(value) || !Object.hasOwn(value, "job")) throw fault("REGIONAL_MARKET_WEEKLY_JOB_INVALID");
  if (value.job === null) return null;
  const job = value.job;
  if (!object(job) || !UUID.test(job.id || "") || !STATUSES.has(job.status) || !stamp(job.nextEligibleAt)) throw fault("REGIONAL_MARKET_WEEKLY_JOB_INVALID");
  return { id: job.id, status: job.status, nextEligibleAt: job.nextEligibleAt };
}
function createRegionalMarketMissingWeeklyScheduler({ dataDir, missingService, now = () => new Date(), setIntervalImpl = setInterval, clearIntervalImpl = clearInterval, canRun = async () => ({ allowed: true }) } = {}) {
  if (typeof dataDir !== "string" || !dataDir || typeof missingService?.get !== "function" || typeof missingService?.request !== "function" || typeof now !== "function"
    || typeof setIntervalImpl !== "function" || typeof clearIntervalImpl !== "function" || typeof canRun !== "function") throw new TypeError("Invalid weekly regional market scheduler options");
  const base = path.resolve(dataDir), directory = path.join(base, DIRECTORY), filename = path.join(directory, POLICY_FILE);
  let serial = Promise.resolve(), stateIO = Promise.resolve(), timer = null, closed = false, ownedDispatch = null;
  const instant = () => { const value = new Date(now()).getTime(); if (!Number.isFinite(value)) throw fault("REGIONAL_MARKET_WEEKLY_CLOCK_INVALID"); return value; };
  const locked = fn => { const task = serial.then(fn); serial = task.catch(() => {}); return task; };
  const stateLocked = fn => { const task = stateIO.then(fn); stateIO = task.catch(() => {}); return task; };
  async function checkDirectory(create = false) {
    const parent = await fs.lstat(base);
    if (!parent.isDirectory() || parent.isSymbolicLink() || !samePath(await fs.realpath(base), base)) throw fault("REGIONAL_MARKET_WEEKLY_UNSAFE_PATH");
    let stat;
    try { stat = await fs.lstat(directory); }
    catch (error) {
      if (error.code !== "ENOENT") throw error;
      if (!create) return null;
      try { await fs.mkdir(directory, { mode: 0o700 }); } catch (creation) { if (creation.code !== "EEXIST") throw creation; }
      stat = await fs.lstat(directory);
    }
    if (!stat.isDirectory() || stat.isSymbolicLink() || !samePath(await fs.realpath(directory), directory)) throw fault("REGIONAL_MARKET_WEEKLY_UNSAFE_PATH");
    return { parent: inode(parent), directory: inode(stat) };
  }
  async function recheck(expected) { const actual = await checkDirectory(false); if (!actual || actual.parent !== expected.parent || actual.directory !== expected.directory) throw fault("REGIONAL_MARKET_WEEKLY_UNSAFE_PATH"); }
  async function rawRead() {
    const checked = await checkDirectory(false); if (!checked) return defaultPolicy(); let handle;
    try {
      const stat = await fs.lstat(filename);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size < 2 || stat.size > MAX_BYTES || !samePath(await fs.realpath(filename), filename)) throw fault("REGIONAL_MARKET_WEEKLY_POLICY_INVALID");
      handle = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
      if (identity(await handle.stat()) !== identity(stat)) throw fault("REGIONAL_MARKET_WEEKLY_POLICY_CHANGED");
      const bytes = Buffer.alloc(stat.size + 1); let count = 0;
      while (count < bytes.length) { const result = await handle.read(bytes, count, bytes.length - count, count); if (!result.bytesRead) break; count += result.bytesRead; }
      if (count !== stat.size || identity(await handle.stat()) !== identity(stat) || identity(await fs.lstat(filename)) !== identity(stat)) throw fault("REGIONAL_MARKET_WEEKLY_POLICY_CHANGED");
      await recheck(checked);
      let value; try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, count))); } catch { throw fault("REGIONAL_MARKET_WEEKLY_POLICY_INVALID"); }
      return validatePolicy(value);
    } catch (error) { if (error.code === "ENOENT" && !handle) return defaultPolicy(); throw error; }
    finally { await handle?.close(); }
  }
  async function rawSave(value) {
    validatePolicy(value); const checked = await checkDirectory(true);
    try { const stat = await fs.lstat(filename); if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || !samePath(await fs.realpath(filename), filename)) throw fault("REGIONAL_MARKET_WEEKLY_UNSAFE_PATH"); } catch (error) { if (error.code !== "ENOENT") throw error; }
    const temporary = path.join(directory, `weekly-policy-${crypto.randomUUID()}.tmp`); let handle;
    try {
      handle = await fs.open(temporary, "wx", 0o600); await handle.writeFile(JSON.stringify(value)); await handle.sync(); await handle.close(); handle = null; await recheck(checked);
      for (let attempt = 0; ; attempt++) {
        try { await fs.rename(temporary, filename); break; }
        catch (error) { if (attempt >= 3 || !["EACCES", "EPERM", "EBUSY"].includes(error.code)) throw error; await new Promise(resolve => setTimeout(resolve, 10 * (attempt + 1))); await recheck(checked); }
      }
      await recheck(checked);
    } finally { await handle?.close(); await fs.unlink(temporary).catch(() => {}); }
  }
  const read = () => stateLocked(rawRead), save = value => { const snapshot = copy(value); return stateLocked(() => rawSave(snapshot)); };
  async function admissionAllowed() {
    let gate; try { gate = await canRun(); } catch { throw fault("REGIONAL_MARKET_WEEKLY_GATE_UNAVAILABLE"); }
    if (!object(gate) || typeof gate.allowed !== "boolean") throw fault("REGIONAL_MARKET_WEEKLY_GATE_UNAVAILABLE");
    return gate.allowed;
  }
  async function inspect(policy, time) {
    const result = { schemaVersion: 1, enabled: policy.enabled, schedule: { ...SCHEDULE }, status: "disabled", reasonCode: null, nextDueAt: null, nextEligibleAt: null,
      lastAttemptWeek: policy.lastAttemptWeek, lastAttemptAt: policy.lastAttemptAt, lastJobId: policy.lastJobId, dispatchStatus: policy.dispatchStatus, errorCode: policy.errorCode };
    if (!policy.enabled) return result;
    if (!await admissionAllowed()) return { ...result, status: "held", reasonCode: "BOOTSTRAP_IN_PROGRESS" };
    const currentWeek = weekOf(time), dueWeek = currentWeek < policy.firstWeek ? policy.firstWeek : currentWeek;
    let nextDue = dueFor(dueWeek);
    if (policy.dispatchStatus === "claimed") {
      result.status = ownedDispatch === policy.lastAttemptWeek ? "dispatching" : "needs_verification";
      result.reasonCode = ownedDispatch === policy.lastAttemptWeek ? null : "WEEKLY_DISPATCH_INTERRUPTED"; return result;
    }
    if (policy.lastAttemptWeek !== null && policy.lastAttemptWeek >= dueWeek) nextDue = dueFor(laterWeek(policy.lastAttemptWeek));
    result.nextDueAt = new Date(nextDue).toISOString();
    let job; try { job = jobProjection(await missingService.get()); } catch { result.status = "needs_verification"; result.reasonCode = "WEEKLY_JOB_READ_FAILED"; return result; }
    if (job) {
      result.nextEligibleAt = job.nextEligibleAt;
      if (["queued", "running", "needs_verification"].includes(job.status)) { result.status = "held"; result.reasonCode = job.status === "needs_verification" ? "MISSING_JOB_NEEDS_VERIFICATION" : "MISSING_JOB_IN_PROGRESS"; return result; }
      nextDue = Math.max(nextDue, Date.parse(job.nextEligibleAt)); result.nextDueAt = new Date(nextDue).toISOString();
    }
    result.status = time >= nextDue ? "due" : "waiting";
    if (policy.lastAttemptWeek === currentWeek && policy.dispatchStatus === "failed") result.reasonCode = policy.errorCode;
    return result;
  }
  async function tick() {
    if (closed) return { schemaVersion: 1, status: "closed", triggered: false };
    return locked(async () => {
      if (closed) return { schemaVersion: 1, status: "closed", triggered: false };
      const policy = await read(), time = instant(), status = await inspect(policy, time);
      if (status.status !== "due") return { ...status, triggered: false };
      // Target/job reads may yield to a bootstrap start. Recheck before consuming
      // this week's durable claim, without rewriting the existing policy or job.
      if (!await admissionAllowed()) return { ...status, status: "held", reasonCode: "BOOTSTRAP_IN_PROGRESS", triggered: false };
      const week = weekOf(time); policy.lastAttemptWeek = week; policy.lastAttemptAt = new Date(time).toISOString(); policy.lastJobId = null; policy.dispatchStatus = "claimed"; policy.errorCode = null;
      await save(policy); ownedDispatch = week;
      let outcome;
      try {
        const response = await missingService.request();
        if (!object(response) || typeof response.reused !== "boolean") throw fault("WEEKLY_REQUEST_CONTRACT_INVALID");
        const job = jobProjection(response); if (!job) throw fault("WEEKLY_REQUEST_CONTRACT_INVALID");
        policy.lastJobId = job.id; policy.dispatchStatus = response.reused ? "reused" : "accepted"; await save(policy);
        outcome = { triggered: !response.reused, reused: response.reused };
      } catch (error) {
        policy.dispatchStatus = "failed"; policy.errorCode = error?.code === "WEEKLY_REQUEST_CONTRACT_INVALID" ? error.code : "WEEKLY_REQUEST_FAILED"; await save(policy);
        outcome = { triggered: false };
      } finally { ownedDispatch = null; }
      // A later status/gate read failure must not relabel an accepted request.
      return { ...(await inspect(policy, instant())), ...outcome };
    });
  }
  return {
    async get() { return inspect(await read(), instant()); },
    async configure(input) {
      if (closed || !exact(input, ["enabled"]) || typeof input.enabled !== "boolean") throw fault(closed ? "REGIONAL_MARKET_WEEKLY_CLOSED" : "REGIONAL_MARKET_WEEKLY_INVALID_POLICY", closed ? 503 : 400);
      return locked(async () => {
        const policy = await read(), time = instant();
        if (input.enabled && !policy.enabled) { policy.enabledAt = new Date(time).toISOString(); policy.firstWeek = weekOf(time); }
        policy.enabled = input.enabled; policy.configuredAt = new Date(time).toISOString(); await save(policy);
        return inspect(policy, time);
      });
    },
    tick,
    start() {
      if (closed || timer !== null) return;
      timer = setIntervalImpl(() => { void tick().catch(() => {}); }, TICK_MS); timer?.unref?.();
      void tick().catch(() => {});
    },
    async close() { closed = true; if (timer !== null) { clearIntervalImpl(timer); timer = null; } await serial; await stateIO; }
  };
}
module.exports = { createRegionalMarketMissingWeeklyScheduler, SCHEDULE, TICK_MS, MAX_BYTES, weekOf };
