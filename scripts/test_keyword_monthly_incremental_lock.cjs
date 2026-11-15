"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs/promises"), path = require("node:path"), os = require("node:os"), crypto = require("node:crypto");
const L = require("./lib/keyword_monthly_incremental_lock.cjs");
const AT = "2026-11-15T00:00:00.000Z", KEY = "a".repeat(64);
const identity = (changes = {}) => ({ kind: "linux_proc_v1", instanceSha256: "b".repeat(64), processStartTicks: "700", sessionId: "11111111-1111-4111-8111-111111111111", pid: 100, ...changes });
const ownerRecord = (changes = {}) => { const { pid, ...owner } = identity(); return { schemaVersion: 2, token: crypto.randomUUID(), pid, sourceKey: KEY, createdAt: AT, owner, ...changes }; };
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "keyword-lock-fixture-"));
  t.after(async () => { assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); await fs.rm(root, { recursive: true, force: true }); });
  const lockFile = path.join(root, "worker-lock.json");
  return { root, lockFile, options: { lockFile, sourceKey: KEY, createdAt: AT, ownerIdentity: identity() },
    async write(v) { await fs.writeFile(lockFile, JSON.stringify(v)); },
    async exists() { try { await fs.lstat(lockFile); return true; } catch (e) { if (e.code === "ENOENT") return false; throw e; } } };
}
function faultingFs(lockFile, step, error, { partial = false } = {}) {
  return { ...fs, async open(file, flags, ...rest) {
    const handle = await fs.open(file, flags, ...rest);
    if (file !== lockFile || flags !== "wx") return handle;
    return { stat: () => handle.stat(), async writeFile(bytes) { if (step === "write" && partial) { await handle.writeFile('{"schemaVersion":2'); throw error; } await handle.writeFile(bytes); if (step === "write") throw error; },
      async sync() { if (step === "sync") throw error; await handle.sync(); }, async close() { await handle.close(); if (step === "close") throw error; } };
  } };
}
test("Linux identity parser handles spaces and parentheses without exposing comm", () => {
  const stat = "100 (fixture ) process) S " + Array.from({ length: 18 }, () => "0").join(" ") + " 456 0";
  assert.equal(L.processStartTicks(stat), "456");
  assert.throws(() => L.processStartTicks("100 invalid"), { code: "KEYWORD_INCREMENTAL_LOCK_PROCESS_IDENTITY_INVALID" });
});
test("new lock binds process instance/start, preserves supplied job token and releases once", async t => {
  const f = await fixture(t), token = crypto.randomUUID(), lock = await L.acquireWorkerLock({ ...f.options, token });
  const saved = JSON.parse(await fs.readFile(f.lockFile)); assert.equal(saved.schemaVersion, 2); assert.equal(saved.token, token); assert.equal(saved.owner.instanceSha256, "b".repeat(64));
  const d = await L.inspectWorkerLock({ lockFile: f.lockFile, now: AT, ownerIdentity: identity() });
  assert.equal(d.reasonCode, "OWNER_ACTIVE"); assert.equal(d.ownerProcessState, "running"); assert.equal(d.ageMs, 0);
  await lock.release(); await lock.release(); assert.equal(await f.exists(), false);
});
test("legacy lock cannot be declared stale from its PID or age", async t => {
  const f = await fixture(t), original = { schemaVersion: 1, token: crypto.randomUUID(), pid: 1, sourceKey: KEY, createdAt: "2026-01-01T00:00:00Z" }; await f.write(original);
  let probes = 0;
  await assert.rejects(L.acquireWorkerLock({ ...f.options, probeOwnerProcess: async () => { probes++; return { state: "not_running" }; } }), e => e.code === "KEYWORD_INCREMENTAL_WORKER_LOCKED" && e.lockDiagnostic.reasonCode === "LEGACY_OWNER_UNVERIFIED");
  assert.equal(probes, 0); assert.deepEqual(JSON.parse(await fs.readFile(f.lockFile)), original);
});
test("invalid existing bytes are preserved and report safe diagnosis only", async t => {
  const f = await fixture(t); await fs.writeFile(f.lockFile, "foreign-secret-fixture");
  await assert.rejects(L.acquireWorkerLock(f.options), e => { assert.equal(e.code, "KEYWORD_INCREMENTAL_WORKER_LOCKED"); assert.equal(e.lockDiagnostic.reasonCode, "LOCK_INVALID"); assert.equal(JSON.stringify(e.lockDiagnostic).includes("foreign-secret"), false); return true; });
  assert.equal(await fs.readFile(f.lockFile, "utf8"), "foreign-secret-fixture");
});
test("same-instance live owner retains lock", async t => {
  const f = await fixture(t), record = ownerRecord({ pid: 200 }); await f.write(record);
  const d = await L.inspectWorkerLock({ lockFile: f.lockFile, now: AT, ownerIdentity: identity(), probeOwnerProcess: async pid => { assert.equal(pid, 200); return { state: "running", processStartTicks: "700" }; } });
  assert.equal(d.reasonCode, "OWNER_ACTIVE"); assert.equal(d.sameInstance, true); assert.deepEqual(JSON.parse(await fs.readFile(f.lockFile)), record);
});
test("known dead and reused PID owners are distinguished but neither is reclaimed", async t => {
  for (const [probe, reason] of [[{ state: "not_running" }, "OWNER_NOT_RUNNING"], [{ state: "running", processStartTicks: "701" }, "OWNER_PID_REUSED"]]) {
    const f = await fixture(t), record = ownerRecord({ pid: 200 }); await f.write(record);
    await assert.rejects(L.acquireWorkerLock({ ...f.options, probeOwnerProcess: async () => probe }), e => e.code === "KEYWORD_INCREMENTAL_WORKER_LOCKED" && e.lockDiagnostic.reasonCode === reason);
    assert.deepEqual(JSON.parse(await fs.readFile(f.lockFile)), record);
  }
});
test("foreign instance is never inspected by a local PID", async t => {
  const f = await fixture(t), record = ownerRecord({ pid: 200, owner: { ...ownerRecord().owner, instanceSha256: "c".repeat(64) } }); await f.write(record); let probes = 0;
  const d = await L.inspectWorkerLock({ lockFile: f.lockFile, now: AT, ownerIdentity: identity(), probeOwnerProcess: async () => { probes++; return { state: "not_running" }; } });
  assert.equal(d.reasonCode, "OWNER_OTHER_INSTANCE"); assert.equal(d.sameInstance, false); assert.equal(probes, 0);
  assert.equal(JSON.stringify(d).includes("c".repeat(64)), false); assert.equal(Object.hasOwn(d, "pid"), false); assert.equal(Object.hasOwn(d, "token"), false);
});
test("unavailable/malformed process evidence remains unknown", async t => {
  const f = await fixture(t); await f.write(ownerRecord({ pid: 200 }));
  for (const probe of [async () => { throw Object.assign(Error("not printed"), { code: "EACCES" }); }, async () => ({ state: "running", processStartTicks: "invalid" })]) {
    const d = await L.inspectWorkerLock({ lockFile: f.lockFile, now: AT, ownerIdentity: identity(), probeOwnerProcess: probe }); assert.equal(d.reasonCode, "OWNER_STATE_UNAVAILABLE");
  }
});
test("non-Linux process-session identity cannot prove another session dead", async t => {
  const f = await fixture(t), owner = await L.readOwnerIdentity({ platform: "win32", pid: 100, sessionId: crypto.randomUUID() });
  const lock = await L.acquireWorkerLock({ ...f.options, ownerIdentity: owner });
  const next = { ...owner, sessionId: crypto.randomUUID() }, d = await L.inspectWorkerLock({ lockFile: f.lockFile, now: AT, ownerIdentity: next });
  assert.equal(d.reasonCode, "OWNER_IDENTITY_UNAVAILABLE"); await lock.release();
});
for (const step of ["write", "sync", "close"]) test(`acquisition ${step} failure cleans only complete proven own bytes and preserves original error`, async t => {
  const f = await fixture(t), original = Object.assign(Error("private exception text"), { code: "EIO" });
  await assert.rejects(L.acquireWorkerLock({ ...f.options, fileSystem: faultingFs(f.lockFile, step, original) }), e => e === original);
  assert.equal(await f.exists(), false);
});
test("partial acquisition write preserves unproven bytes and marks review without masking primary error", async t => {
  const f = await fixture(t), original = Object.assign(Error("not printed"), { code: "ENOSPC" });
  await assert.rejects(L.acquireWorkerLock({ ...f.options, fileSystem: faultingFs(f.lockFile, "write", original, { partial: true }) }), e => e === original && e.lockCleanup.reasonCode === "OWNED_LOCK_CLEANUP_NEEDS_REVIEW");
  assert.equal(await fs.readFile(f.lockFile, "utf8"), '{"schemaVersion":2');
});
test("release rejects a changed token without deleting foreign content", async t => {
  const f = await fixture(t), lock = await L.acquireWorkerLock(f.options), row = JSON.parse(await fs.readFile(f.lockFile)); row.token = crypto.randomUUID(); await f.write(row);
  await assert.rejects(lock.release(), { code: "KEYWORD_INCREMENTAL_LOCK_CHANGED" }); assert.deepEqual(JSON.parse(await fs.readFile(f.lockFile)), row);
});
test("release rejects a replacement inode even when its bytes are identical", async t => {
  const f = await fixture(t), lock = await L.acquireWorkerLock(f.options), bytes = await fs.readFile(f.lockFile); await fs.rename(f.lockFile, path.join(f.root, "retained-original.json")); await fs.writeFile(f.lockFile, bytes);
  await assert.rejects(lock.release(), { code: "KEYWORD_INCREMENTAL_LOCK_CHANGED" }); assert.deepEqual(await fs.readFile(f.lockFile), bytes);
});
test("replacement observed between release lstat and open is preserved", async t => {
  const f = await fixture(t), foreign = ownerRecord(); let inject = false;
  const fileSystem = { ...fs, async lstat(file) { const s = await fs.lstat(file); if (file === f.lockFile && inject) { inject = false; await fs.rename(file, path.join(f.root, "old.json")); await fs.writeFile(file, JSON.stringify(foreign)); } return s; } };
  const lock = await L.acquireWorkerLock({ ...f.options, fileSystem }); inject = true;
  await assert.rejects(lock.release(), { code: "KEYWORD_INCREMENTAL_LOCK_CHANGED" }); assert.equal(await f.exists(), true); assert.deepEqual(JSON.parse(await fs.readFile(f.lockFile)), foreign);
});
test("hardlinked lock is not adopted or removed", async t => {
  const f = await fixture(t); await f.write(ownerRecord()); await fs.link(f.lockFile, path.join(f.root, "retained-hardlink.json"));
  await assert.rejects(L.acquireWorkerLock(f.options), e => e.code === "KEYWORD_INCREMENTAL_WORKER_LOCKED" && e.lockDiagnostic.reasonCode === "LOCK_INVALID");
  assert.equal((await fs.stat(f.lockFile)).nlink, 2);
});
test("unsafe symlink lock is not followed or unlinked", { skip: process.platform === "win32" }, async t => {
  const f = await fixture(t), target = path.join(f.root, "target.json"); await fs.writeFile(target, "preserve"); await fs.symlink(target, f.lockFile);
  await assert.rejects(L.acquireWorkerLock(f.options), e => e.code === "KEYWORD_INCREMENTAL_WORKER_LOCKED" && e.lockDiagnostic.reasonCode === "LOCK_INVALID"); assert.equal((await fs.lstat(f.lockFile)).isSymbolicLink(), true); assert.equal(await fs.readFile(target, "utf8"), "preserve");
});
test("work error identity survives cleanup failure and cleanup adds controlled codes only", async () => {
  const primary = Object.assign(Error("primary secret"), { code: "PUBLICATION_FAILED" });
  await assert.rejects(L.withWorkerLock({ async release() { throw Object.assign(Error("cleanup secret"), { code: "KEYWORD_INCREMENTAL_LOCK_CHANGED" }); } }, async () => { throw primary; }), e => e === primary);
  assert.deepEqual(primary.lockCleanup, { reasonCode: "OWNED_LOCK_CLEANUP_NEEDS_REVIEW", code: "KEYWORD_INCREMENTAL_LOCK_CHANGED" });
  assert.equal(JSON.stringify(primary.lockCleanup).includes("secret"), false);
});
test("successful work is not reported successful when owned lock cleanup fails", async () => {
  const error = Object.assign(Error("cleanup"), { code: "EIO" }); await assert.rejects(L.withWorkerLock({ async release() { throw error; } }, async () => ({ status: "published" })), e => e === error);
});
test("owner identity failure occurs before creating a lock", async t => {
  const f = await fixture(t); await assert.rejects(L.acquireWorkerLock({ ...f.options, ownerIdentity: { ...identity(), processStartTicks: "invalid" } }), { code: "KEYWORD_INCREMENTAL_LOCK_OWNER_INVALID" }); assert.equal(await f.exists(), false);
});
