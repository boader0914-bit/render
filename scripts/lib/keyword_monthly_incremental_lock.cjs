"use strict";
// This lock protects the derived incremental publisher only. Existing locks are
// inspected, never reclaimed on age/PID alone and never automatically retried.
const fs = require("node:fs/promises"), native = require("node:fs"), os = require("node:os"), path = require("node:path"), crypto = require("node:crypto");
const H = require("./keyword_monthly_refresh_preparation.cjs");
const SESSION = crypto.randomUUID(), UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/, MAX_BYTES = 16384;
const plain = v => v !== null && typeof v === "object" && !Array.isArray(v) && [null, Object.prototype].includes(Object.getPrototypeOf(v));
const sameInode = (a, b) => a?.dev === b?.dev && a?.ino === b?.ino;
const safeCause = e => /^[A-Z][A-Z0-9_]{1,119}$/.test(e?.code || "") ? e.code : "KEYWORD_INCREMENTAL_LOCK_IO_FAILED";
function processStartTicks(value) {
  // comm can contain spaces and ')' characters; field 3 starts after its LAST ')'.
  const end = typeof value === "string" ? value.lastIndexOf(") ") : -1;
  const fields = end < 0 ? [] : value.slice(end + 2).trim().split(/\s+/);
  H.need(fields.length >= 20 && /^\d{1,30}$/.test(fields[19]), "KEYWORD_INCREMENTAL_LOCK_PROCESS_IDENTITY_INVALID");
  return fields[19];
}
async function readOwnerIdentity({ fileSystem = fs, platform = process.platform, pid = process.pid, hostname = os.hostname, sessionId = SESSION } = {}) {
  H.need(Number.isSafeInteger(pid) && pid > 0 && UUID.test(sessionId), "KEYWORD_INCREMENTAL_LOCK_OWNER_INVALID");
  if (platform !== "linux") return { kind: "process_session_v1", instanceSha256: null, processStartTicks: null, sessionId, pid };
  const [boot, namespace, stat] = await Promise.all([fileSystem.readFile("/proc/sys/kernel/random/boot_id", "utf8"), fileSystem.readlink("/proc/self/ns/pid"), fileSystem.readFile(`/proc/${pid}/stat`, "utf8")]);
  H.need(UUID.test(boot.trim()) && /^pid:\[\d+\]$/.test(namespace), "KEYWORD_INCREMENTAL_LOCK_OWNER_INVALID");
  return { kind: "linux_proc_v1", instanceSha256: H.hash(JSON.stringify([boot.trim(), namespace, hostname()])), processStartTicks: processStartTicks(stat), sessionId, pid };
}
async function probeProcess(pid, { fileSystem = fs } = {}) {
  try { return { state: "running", processStartTicks: processStartTicks(await fileSystem.readFile(`/proc/${pid}/stat`, "utf8")) }; }
  catch (e) { return { state: e.code === "ENOENT" || e.code === "ESRCH" ? "not_running" : "unavailable" }; }
}
function validOwner(owner) {
  return plain(owner) && Object.keys(owner).every(k => ["kind", "instanceSha256", "processStartTicks", "sessionId"].includes(k)) && UUID.test(owner.sessionId || "")
    && (owner.kind === "linux_proc_v1" && H.SHA.test(owner.instanceSha256 || "") && /^\d{1,30}$/.test(owner.processStartTicks || "")
      || owner.kind === "process_session_v1" && owner.instanceSha256 === null && owner.processStartTicks === null);
}
function validRecord(value) {
  return plain(value) && value.schemaVersion === 2 && Object.keys(value).every(k => ["schemaVersion", "token", "pid", "sourceKey", "createdAt", "owner"].includes(k))
    && UUID.test(value.token || "") && Number.isSafeInteger(value.pid) && value.pid > 0 && H.SHA.test(value.sourceKey || "") && H.validIso(value.createdAt) && validOwner(value.owner);
}
async function savedLock(lockFile, fileSystem) {
  await H.checked(path.dirname(lockFile), true);
  const before = await fileSystem.lstat(lockFile);
  H.need(before.isFile() && !before.isSymbolicLink() && before.nlink === 1 && before.size > 0 && before.size <= MAX_BYTES, "KEYWORD_INCREMENTAL_LOCK_UNSAFE");
  const handle = await fileSystem.open(lockFile, native.constants.O_RDONLY | (native.constants.O_NOFOLLOW || 0)); let bytes, primary;
  try { H.need(H.same(before, await handle.stat()), "KEYWORD_INCREMENTAL_LOCK_CHANGED"); bytes = await handle.readFile(); H.need(bytes.length === before.size && H.same(before, await handle.stat()), "KEYWORD_INCREMENTAL_LOCK_CHANGED"); }
  catch (error) { primary = error; throw error; }
  finally { try { await handle.close(); } catch (error) { if (!primary) throw error; } }
  H.need(H.same(before, await fileSystem.lstat(lockFile)), "KEYWORD_INCREMENTAL_LOCK_CHANGED");
  let value; try { value = JSON.parse(bytes); } catch { throw H.fault("KEYWORD_INCREMENTAL_LOCK_INVALID"); }
  return { value, bytes, stat: before };
}
async function inspectWorkerLock({ lockFile, now = () => new Date(), ownerIdentity, fileSystem = fs, probeOwnerProcess = pid => probeProcess(pid, { fileSystem }) } = {}) {
  H.absolute(lockFile); H.need(path.basename(lockFile) === "worker-lock.json", "KEYWORD_INCREMENTAL_LOCK_PATH_INVALID");
  const result = { schemaVersion: 1, reasonCode: "LOCK_UNVERIFIED", ownerSchemaVersion: null, ageMs: null, sameInstance: null, ownerProcessState: "unverified" };
  let saved;
  try { saved = await savedLock(lockFile, fileSystem); }
  catch (e) { result.reasonCode = e.code === "ENOENT" ? "LOCK_MISSING" : ["KEYWORD_INCREMENTAL_LOCK_INVALID", "KEYWORD_INCREMENTAL_LOCK_UNSAFE"].includes(e.code) ? "LOCK_INVALID" : "LOCK_READ_UNAVAILABLE"; return result; }
  const row = saved.value; result.ownerSchemaVersion = Number.isSafeInteger(row?.schemaVersion) ? row.schemaVersion : null;
  const at = Date.parse(typeof now === "function" ? now() : now), created = Date.parse(row?.createdAt);
  if (Number.isFinite(at) && Number.isFinite(created)) result.ageMs = Math.max(0, at - created);
  if (row?.schemaVersion === 1) { result.reasonCode = "LEGACY_OWNER_UNVERIFIED"; return result; }
  if (!validRecord(row)) { result.reasonCode = "LOCK_INVALID"; return result; }
  let owner;
  try { owner = ownerIdentity || await readOwnerIdentity({ fileSystem }); } catch { result.reasonCode = "OWNER_IDENTITY_UNAVAILABLE"; return result; }
  if (row.pid === owner.pid && row.owner.sessionId === owner.sessionId && row.owner.kind === owner.kind
    && row.owner.instanceSha256 === owner.instanceSha256 && row.owner.processStartTicks === owner.processStartTicks) {
    result.reasonCode = "OWNER_ACTIVE"; result.sameInstance = true; result.ownerProcessState = "running"; return result;
  }
  if (row.owner.kind !== "linux_proc_v1" || owner.kind !== "linux_proc_v1") { result.reasonCode = "OWNER_IDENTITY_UNAVAILABLE"; return result; }
  result.sameInstance = row.owner.instanceSha256 === owner.instanceSha256;
  if (!result.sameInstance) { result.reasonCode = "OWNER_OTHER_INSTANCE"; return result; }
  let observed; try { observed = await probeOwnerProcess(row.pid); } catch { observed = { state: "unavailable" }; }
  result.ownerProcessState = ["running", "not_running"].includes(observed?.state) ? observed.state : "unavailable";
  result.reasonCode = result.ownerProcessState === "not_running" ? "OWNER_NOT_RUNNING"
    : result.ownerProcessState === "running" && /^\d{1,30}$/.test(observed.processStartTicks || "") ? observed.processStartTicks === row.owner.processStartTicks ? "OWNER_ACTIVE" : "OWNER_PID_REUSED"
      : "OWNER_STATE_UNAVAILABLE";
  return result;
}
async function acquireWorkerLock({ lockFile, sourceKey, createdAt, token = crypto.randomUUID(), ownerIdentity, fileSystem = fs, probeOwnerProcess } = {}) {
  H.absolute(lockFile); H.need(path.basename(lockFile) === "worker-lock.json" && H.SHA.test(sourceKey || "") && H.validIso(createdAt), "KEYWORD_INCREMENTAL_LOCK_OPTIONS_INVALID");
  const parent = await H.checked(path.dirname(lockFile), true), identity = ownerIdentity || await readOwnerIdentity({ fileSystem });
  const { pid, ...owner } = identity;
  const record = { schemaVersion: 2, token, pid, sourceKey, createdAt, owner };
  H.need(validRecord(record), "KEYWORD_INCREMENTAL_LOCK_OWNER_INVALID");
  const bytes = Buffer.from(JSON.stringify(record)), digest = H.hash(bytes); let handle, ownedStat, closed = false, released = false;
  async function removeOwned() {
    const saved = await savedLock(lockFile, fileSystem);
    H.need(sameInode(saved.stat, ownedStat) && saved.value.token === record.token && saved.value.sourceKey === sourceKey && H.hash(saved.bytes) === digest, "KEYWORD_INCREMENTAL_LOCK_CHANGED");
    H.need(H.identity(parent, await H.checked(path.dirname(lockFile), true)) && H.same(saved.stat, await fileSystem.lstat(lockFile)), "KEYWORD_INCREMENTAL_LOCK_CHANGED");
    // The private directory and cooperative writer protocol are part of the
    // trust boundary. Node has no compare-and-unlink syscall: observed changes
    // are rejected, but this is not a CAS guarantee against a hostile writer.
    await fileSystem.unlink(lockFile); released = true;
  }
  try {
    try { handle = await fileSystem.open(lockFile, "wx", 0o600); }
    catch (e) {
      if (e.code !== "EEXIST") throw e;
      const error = H.fault("KEYWORD_INCREMENTAL_WORKER_LOCKED");
      error.lockDiagnostic = await inspectWorkerLock({ lockFile, now: createdAt, ownerIdentity: identity, fileSystem, probeOwnerProcess }); throw error;
    }
    ownedStat = await handle.stat(); await handle.writeFile(bytes); await handle.sync(); await handle.close(); closed = true;
    const saved = await savedLock(lockFile, fileSystem);
    H.need(sameInode(saved.stat, ownedStat) && H.hash(saved.bytes) === digest && H.identity(parent, await H.checked(path.dirname(lockFile), true)), "KEYWORD_INCREMENTAL_LOCK_CHANGED");
    return Object.freeze({ async release() { if (released) return; await removeOwned(); } });
  } catch (error) {
    if (handle) {
      if (!closed) { try { await handle.close(); } catch {} }
      if (ownedStat) try { await removeOwned(); } catch (cleanup) { try { error.lockCleanup = { reasonCode: "OWNED_LOCK_CLEANUP_NEEDS_REVIEW", code: safeCause(cleanup) }; } catch {} }
    }
    throw error;
  }
}
async function withWorkerLock(lock, work) {
  let result, failed = false, primary;
  try { result = await work(); } catch (error) { failed = true; primary = error; }
  try { await lock.release(); }
  catch (error) {
    if (!failed) throw error;
    // Keep the original business/publication error and object identity. Cleanup
    // details are controlled codes only, never an exception message or stack.
    try { primary.lockCleanup = { reasonCode: "OWNED_LOCK_CLEANUP_NEEDS_REVIEW", code: safeCause(error) }; } catch {}
  }
  if (failed) throw primary; return result;
}
module.exports = { processStartTicks, readOwnerIdentity, probeProcess, inspectWorkerLock, acquireWorkerLock, withWorkerLock };
