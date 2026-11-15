"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs/promises"), path = require("node:path"), os = require("node:os"), crypto = require("node:crypto"), zlib = require("node:zlib");
const L = require("./lib/keyword_monthly_worker_lock.cjs");
const { spawn } = require("node:child_process");
const H = b => crypto.createHash("sha256").update(b).digest("hex"), J = x => Buffer.from(JSON.stringify(x)), V = "keyword-monthly-incremental-v4";
const NOW = "2026-11-15T11:50:00.000Z", SECRET = "11111111-2222-4333-8444-555555555555", JOB = "99999999-2222-4333-8444-555555555555";
const context = { bootId: "00000000-1111-4222-8333-444444444444", pidNamespace: "pid:[1234]", hostId: "c".repeat(64) };
async function save(f, v) { await fs.mkdir(path.dirname(f), { recursive: true, mode: 0o700 }); await fs.writeFile(f, J(v), { mode: 0o600 }); }
async function absent(f) { await assert.rejects(fs.lstat(f), { code: "ENOENT" }); }
async function fixtureAtomicArchive(source, destination) {
  let python; for (const file of ["/usr/bin/python3.12", "/usr/bin/python3.11"]) { try { await fs.access(file); python = file; break; } catch {} }
  assert.ok(python, "fixture requires a known system Python for the identical renameat2 program");
  await new Promise((resolve, reject) => { const p = spawn(python, ["-I", "-S", "-c", L.ATOMIC_ARCHIVE_PROGRAM, source, destination], { cwd: path.dirname(destination), env: {}, stdio: ["ignore", "ignore", "ignore"], shell: false });
    const timer = setTimeout(() => p.kill("SIGKILL"), 10000); p.once("error", reject); p.once("close", (code, signal) => { clearTimeout(timer); if (code === 0 && !signal) resolve(); else reject(Object.assign(new Error("fixture atomic archive rejected"), { code: code === 17 ? "EEXIST" : "FIXTURE_ATOMIC_FAILED" })); }); });
}
async function fixture(t, schema = 1) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "monthly-worker-lock-"));
  t.after(async () => { assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); await fs.rm(root, { recursive: true, force: true }); });
  const dataDir = path.join(root, "data"), directory = path.join(dataDir, "keyword_monthly_incremental"), lockFile = path.join(directory, "worker-lock.json"), publicDir = path.join(dataDir, "keyword_monthly_analysis");
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const manifest = { keyword: "fixture", collectionQuality: { status: "complete" } }, mh = H(J(manifest));
  const intent = { refreshVersion: V, runId: "run_fixture", manifestSha256: mh, keyword: "fixture", scope: "fixture", scheduleOccurrenceId: null };
  const sourceKey = H(J([V, intent.runId, mh, intent.keyword])), targetJobId = H(J([V, intent.runId, mh, intent.keyword, intent.scope, null]));
  const q = { schemaVersion: 1, jobId: targetJobId, intent, status: "needs_verification", reasonCode: "KEYWORD_INCREMENTAL_WORKER_LOCKED" };
  const queueFile = path.join(dataDir, "keyword_monthly_refresh/jobs", targetJobId + ".json"); await save(queueFile, q);
  for (const name of ["collector", "collector-scheduled"]) await save(path.join(dataDir, name, "jobs.json"), { version: 1, halted: null, reviewHold: null, jobs: [] });
  await save(path.join(dataDir, "collector-web/state.json"), { version: 1, halted: null, reviewHold: null, active: null });
  await save(path.join(dataDir, "history/collection_postprocess/queue.json"), { version: 1, sequence: 1, jobs: {} });
  const lock = { schemaVersion: schema, token: SECRET, pid: 84, sourceKey, createdAt: "2026-11-15T11:39:48.550Z",
    ...(schema === 2 ? { jobId: JOB, version: V, owner: { ...context, startTicks: "100" } } : {}) };
  await save(lockFile, lock);
  const jobRoot = path.join(directory, "jobs", "refresh-job-" + (schema === 1 ? SECRET : JOB));
  const ownerFile = path.join(jobRoot, "refresh-owner.json"); await save(ownerFile, { token: schema === 1 ? SECRET : JOB, sourceKey, root: jobRoot });
  const evidence = { runId: intent.runId, keyword: intent.keyword, manifestSha256: mh, scheduleOccurrenceId: null, finishedAt: "2026-11-15T11:35:00.000Z" };
  await save(path.join(jobRoot, "job-input.json"), { version: V, dataDir, evidence });
  await save(path.join(dataDir, "outputs", intent.runId, "manifest.json"), manifest);
  await save(path.join(dataDir, "history/collection_postprocess/runs", H(Buffer.from(intent.runId)) + ".json"), { runId: intent.runId, status: "complete", finishedAt: evidence.finishedAt, result: { sourceManifestSha256: mh }, scheduleOccurrenceId: null });
  const proofFile = path.join(jobRoot, "control/isolation.json");
  await save(proofFile, { pid: 146, expectedRoot: jobRoot, mode: "seccomp", noNewPrivs: true, seccompMode: 2, networkFdsClosed: true,
    guardName: "reconstruct_keyword_monthly_incremental.cjs", guardRequiredBeforeNormalization: true, applicationStarted: false, preflightOnly: false, providerCalls: 0,
    environmentSanitizedForExec: true, unrestrictedFallbackAllowed: false, guardSha256: "d".repeat(64), nodeSha256: "e".repeat(64), nonStandardFdsClosedBeforeExec: true, nonStandardFdsRemainingBeforeExec: 0,
    kernelProbe: { tcpSocketDenied: true, udpSocketDenied: true, ipv6SocketDenied: true, syscallsDeniedWithEperm: Object.fromEntries(["socket", "socketpair", "connect", "sendto", "sendmsg"].map(k => [k, true])) } });
  const generation = "a".repeat(32), catalog = { schemaVersion: 1, kind: "keyword_monthly_partition_bundle", createdAt: NOW, partitions: [], scopes: [] }, catBytes = J(catalog);
  const pointer = { schemaVersion: 1, generation, catalogSha256: H(catBytes), catalogBytes: catBytes.length, publishedAt: NOW }, pointerBytes = J(pointer);
  const pointerFile = path.join(publicDir, "current.json"); await save(pointerFile, pointer); await save(path.join(publicDir, "generations", generation, "catalog.json"), catalog);
  const publication = { status: "published", generation, pointerSha256: H(pointerBytes), catalogSha256: H(catBytes) }; await save(path.join(publicDir, "generations", generation, "publication-receipt.json"), publication);
  const priorEvidence = { runId: "run_previous", keyword: "previous", manifestSha256: "f".repeat(64) }, previousKey = H(J([V, priorEvidence.runId, priorEvidence.manifestSha256, priorEvidence.keyword]));
  async function state(value) { const raw = J(value), digest = H(raw), gzip = zlib.gzipSync(raw); const file = path.join(directory, "states", digest + ".json.gz"); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, gzip, { mode: 0o600 });
    return { schemaVersion: 1, version: value.version, compression: "gzip", stateSha256: digest, storageSha256: H(gzip), rawBytes: raw.length, storageBytes: gzip.length }; }
  const oldState = await state({ schemaVersion: 1, version: "keyword-monthly-incremental-state-v1", generation: 1, companies: [], appliedEvents: [] });
  const currentState = await state({ schemaVersion: 1, version: oldState.version, generation: 2, companies: [], appliedEvents: [], lastPublished: { sourceKey: previousKey, stateSha256: oldState.stateSha256, generation, pointerSha256: H(pointerBytes) } });
  const sourcePointerFile = path.join(directory, "source-current.json"); await save(sourcePointerFile, currentState);
  const prepared = { version: V, status: "complete", stateSha256: oldState.stateSha256, providerCalls: 0, sourceWrites: 0 }, preparedRaw = J(prepared), preparedGzip = zlib.gzipSync(preparedRaw);
  const receiptDir = path.join(publicDir, "refresh-receipts"); await fs.mkdir(receiptDir, { recursive: true }); await fs.writeFile(path.join(receiptDir, "incremental-evidence-" + previousKey + ".json.gz"), preparedGzip, { mode: 0o600 });
  await save(path.join(receiptDir, "complete-" + previousKey + ".json"), { schemaVersion: 1, generatedBy: "keyword_monthly_incremental_refresh", mode: "live", sourceKey: previousKey, ...priorEvidence,
    status: "published", fixtureOnly: false, strictIsolationVerified: true, incrementalValidated: true, refreshVersion: V, stateSha256: oldState.stateSha256,
    pointerSha256: H(pointerBytes), catalogSha256: H(catBytes), generation, publicationReceiptSha256: H(J(publication)), providerCalls: 0, sourceWrites: 0,
    preparationSha256: H(preparedRaw), preparationEvidenceSha256: H(preparedGzip) });
  const identities = { executableIdentity: "a".repeat(64), cwdIdentity: "b".repeat(64) };
  const rows = new Map([[64, { pid: 64, ppid: 63, startTicks: "200", kind: "node", ...identities }], [63, { pid: 63, ppid: 52, startTicks: "190", kind: "shell", ...identities }],
    [52, { pid: 52, ppid: 1, startTicks: "180", kind: "node", ...identities }], [1, { pid: 1, ppid: 0, startTicks: "1", kind: "shell", ...identities }],
    [process.pid, { pid: process.pid, ppid: 1, startTicks: "300", kind: "node", ...identities }]]);
  const processReader = { context: async () => ({ ...context }), process: async p => rows.get(p) || null, peers: async () => [] };
  const options = { dataDir, targetJobId, serverPid: 64, fixture: true, processReader };
  if (process.platform === "linux") options.archiveNoReplace = fixtureAtomicArchive;
  async function approval() { const inspected = await L.inspectWorkerLockRecovery(options); return { schemaVersion: 1, action: "reviewed_dead_worker_lock_recovery", targetJobId,
    snapshotSha256: inspected.snapshotSha256, lockSha256: inspected.snapshot.lockSha256, sourcePointerSha256: inspected.snapshot.sourcePointerSha256, publicPointerSha256: inspected.snapshot.publicPointerSha256,
    incident: { pid: 84, exitCode: 134, exitedAt: "2026-11-15T11:42:52.000Z", evidenceSha256: "9".repeat(64) } }; }
  return { root, dataDir, directory, lockFile, lock, sourceKey, jobRoot, proofFile, ownerFile, receiptDir, queueFile, q, pointerFile, pointer, sourcePointerFile, options, processReader, rows, approval };
}

test("schema2 acquisition keeps its secret distinct from the public job id and releases only its exact own lock", async t => {
  const f = await fixture(t); await fs.unlink(f.lockFile);
  const lease = await L.acquireWorkerLock({ directory: f.directory, sourceKey: f.sourceKey, version: "keyword-monthly-incremental-v5", fixture: true, processReader: f.processReader, now: () => NOW });
  const lock = JSON.parse(await fs.readFile(f.lockFile)); assert.equal(lock.schemaVersion, 2); assert.notEqual(lock.token, lease.jobId); assert.equal(lock.jobId, lease.jobId); assert.equal(lock.owner.startTicks, "300");
  assert.equal(JSON.stringify(lease).includes(lock.token), false);
  await assert.rejects(L.acquireWorkerLock({ directory: f.directory, sourceKey: f.sourceKey, version: V, fixture: true, processReader: f.processReader }), { code: "KEYWORD_INCREMENTAL_WORKER_LOCKED" });
  await lease.release(); await absent(f.lockFile);
});
test("acquisition respects a recovery claim and never takes an old lock merely because of age", async t => {
  const f = await fixture(t); f.lock.createdAt = "2000-01-01T00:00:00.000Z"; await save(f.lockFile, f.lock);
  await assert.rejects(L.acquireWorkerLock({ directory: f.directory, sourceKey: f.sourceKey, version: V, fixture: true, processReader: f.processReader }), { code: "KEYWORD_INCREMENTAL_WORKER_LOCKED" });
  await save(path.join(f.directory, "worker-lock-recovery-claim.json"), { unknown: true });
  await assert.rejects(L.acquireWorkerLock({ directory: f.directory, sourceKey: f.sourceKey, version: V, fixture: true, processReader: f.processReader }), { code: "KEYWORD_INCREMENTAL_LOCK_RECOVERY_IN_PROGRESS" });
});
test("failed initial lock write removes only the inode this acquisition created", async t => {
  const f = await fixture(t); await fs.unlink(f.lockFile); const original = fs.open;
  t.mock.method(fs, "open", async (file, ...args) => { const h = await original(file, ...args); if (file !== f.lockFile || args[0] !== "wx") return h;
    return { stat: (...a) => h.stat(...a), close: () => h.close(), sync: () => h.sync(), writeFile: async () => { throw Object.assign(new Error("fixture"), { code: "EIO" }); } }; });
  await assert.rejects(L.acquireWorkerLock({ directory: f.directory, sourceKey: f.sourceKey, version: V, fixture: true, processReader: f.processReader }), { code: "EIO" }); await absent(f.lockFile);
});
test("a replaced live lease is never removed by release", async t => {
  const f = await fixture(t); await fs.unlink(f.lockFile); const lease = await L.acquireWorkerLock({ directory: f.directory, sourceKey: f.sourceKey, version: V, fixture: true, processReader: f.processReader });
  await fs.unlink(f.lockFile); await save(f.lockFile, { foreign: true }); const bytes = await fs.readFile(f.lockFile);
  await assert.rejects(lease.release(), { code: "KEYWORD_INCREMENTAL_LOCK_CHANGED" }); assert.deepEqual(await fs.readFile(f.lockFile), bytes);
});
test("legacy inspection is redacted and reviewed dry-run makes no recovery filesystem changes", async t => {
  const f = await fixture(t), before = await fs.readFile(f.lockFile), entries = await fs.readdir(f.directory), inspected = await L.inspectWorkerLockRecovery(f.options);
  assert.equal(inspected.legacyIncidentRequired, true); assert.equal(JSON.stringify(inspected).includes(SECRET), false); assert.equal(JSON.stringify(inspected).includes(f.jobRoot), false);
  await assert.rejects(L.recoverWorkerLock(f.options), { code: "KEYWORD_INCREMENTAL_LOCK_REVIEW_MISMATCH" });
  const result = await L.recoverWorkerLock({ ...f.options, reviewedProof: await f.approval() }); assert.equal(result.status, "verified_dry_run");
  assert.deepEqual(await fs.readFile(f.lockFile), before); assert.deepEqual(await fs.readdir(f.directory), entries);
});
test("reviewed recovery atomically archives original bytes and mode while preserving ledgers, pointers and job evidence", async t => {
  const f = await fixture(t), original = await fs.readFile(f.lockFile), stat = await fs.stat(f.lockFile), files = [f.queueFile, f.pointerFile, f.sourcePointerFile, f.ownerFile, f.proofFile], saved = await Promise.all(files.map(file => fs.readFile(file)));
  const result = await L.recoverWorkerLock({ ...f.options, reviewedProof: await f.approval(), dryRun: false }); assert.equal(result.status, "recovered"); assert.equal(result.activeLockPathAbsent, true); await absent(f.lockFile);
  const dir = path.join(f.directory, "lock-recovery", result.recoveryId), archive = path.join(dir, "original-lock.json"); assert.deepEqual(await fs.readFile(archive), original); assert.equal((await fs.stat(archive)).mode, stat.mode);
  for (const name of ["reviewed-preflight.json", "recovery-complete.json"]) { const s = await fs.readFile(path.join(dir, name), "utf8"); assert.equal(s.includes(SECRET), false); assert.equal(s.includes(f.jobRoot), false); }
  for (const [i, file] of files.entries()) assert.deepEqual(await fs.readFile(file), saved[i]); await absent(path.join(f.directory, "worker-lock-recovery-claim.json"));
});
for (const [name, change, code] of [
  ["active parent", f => f.rows.set(84, { pid: 84, startTicks: "100" }), "KEYWORD_INCREMENTAL_LOCK_OWNER_ACTIVE"],
  ["active child", f => f.rows.set(146, { pid: 146, startTicks: "400" }), "KEYWORD_INCREMENTAL_LOCK_CHILD_ACTIVE"],
  ["unknown peer", f => { f.processReader.peers = async () => [{ pid: 99, kind: "node", startTicks: "500" }]; }, "KEYWORD_INCREMENTAL_LOCK_PEER_UNKNOWN"],
  ["unresolved publication intent", f => save(path.join(f.receiptDir, "intent-" + f.sourceKey + ".json"), { publishing: true }), "KEYWORD_INCREMENTAL_LOCK_PUBLICATION_INTENT_PRESENT"],
  ["changed public pointer", f => save(f.pointerFile, { ...f.pointer, publishedAt: "2026-11-15T12:00:00.000Z" }), "KEYWORD_INCREMENTAL_LOCK_PUBLIC_POINTER_CONFLICT"],
  ["other running queue", f => save(path.join(f.dataDir, "keyword_monthly_refresh/jobs", "1".repeat(64) + ".json"), { jobId: "1".repeat(64), status: "running" }), "KEYWORD_INCREMENTAL_LOCK_QUEUE_ACTIVE"]
]) test(name + " fails closed without archiving", async t => {
  const f = await fixture(t), original = await fs.readFile(f.lockFile); await change(f);
  await assert.rejects(L.inspectWorkerLockRecovery(f.options), { code }); assert.deepEqual(await fs.readFile(f.lockFile), original); await absent(path.join(f.directory, "lock-recovery"));
});
test("schema2 distinguishes PID reuse and refuses boot or namespace changes", async t => {
  const f = await fixture(t, 2); f.rows.set(84, { pid: 84, startTicks: "999" }); await assert.rejects(L.inspectWorkerLockRecovery(f.options), { code: "KEYWORD_INCREMENTAL_LOCK_PID_REUSED" });
  f.rows.delete(84); f.processReader.context = async () => ({ ...context, pidNamespace: "pid:[9999]" }); await assert.rejects(L.inspectWorkerLockRecovery(f.options), { code: "KEYWORD_INCREMENTAL_LOCK_CONTEXT_UNKNOWN" });
  f.processReader.context = async () => ({ ...context, bootId: "55555555-1111-4222-8333-444444444444" }); await assert.rejects(L.inspectWorkerLockRecovery(f.options), { code: "KEYWORD_INCREMENTAL_LOCK_CONTEXT_UNKNOWN" });
});
test("review pins and reviewed exit evidence are mandatory and never inferred from age", async t => {
  const f = await fixture(t), approved = await f.approval();
  await assert.rejects(L.recoverWorkerLock({ ...f.options, reviewedProof: { ...approved, lockSha256: "0".repeat(64) }, dryRun: false }), { code: "KEYWORD_INCREMENTAL_LOCK_REVIEW_MISMATCH" });
  await assert.rejects(L.recoverWorkerLock({ ...f.options, reviewedProof: { ...approved, incident: null }, dryRun: false }), { code: "KEYWORD_INCREMENTAL_LOCK_EXIT_EVIDENCE_REQUIRED" });
  await absent(path.join(f.directory, "worker-lock-recovery-claim.json"));
});
test("hard-linked lock bodies are rejected without changing either name", async t => {
  const f = await fixture(t), other = path.join(f.root, "other-lock.json"); await fs.link(f.lockFile, other);
  await assert.rejects(L.inspectWorkerLockRecovery(f.options)); assert.equal((await fs.stat(other)).nlink, 2);
});
test("pre-existing recovery destination is never overwritten", async t => {
  const f = await fixture(t), approved = await f.approval(), id = "88888888-2222-4333-8444-555555555555", destination = path.join(f.directory, "lock-recovery", id); await fs.mkdir(destination, { recursive: true, mode: 0o700 });
  const saved = Buffer.from("preserve historical archive"); await fs.writeFile(path.join(destination, "original-lock.json"), saved); t.mock.method(crypto, "randomUUID", () => id);
  await assert.rejects(L.recoverWorkerLock({ ...f.options, reviewedProof: approved, dryRun: false }), { code: "EEXIST" });
  assert.deepEqual(await fs.readFile(path.join(destination, "original-lock.json")), saved); assert.equal(JSON.parse(await fs.readFile(f.lockFile)).token, SECRET);
});
test("a process appearing at the final boundary preserves the original and audit claim", async t => {
  const f = await fixture(t), approved = await f.approval(); let calls = 0;
  f.processReader.peers = async () => ++calls >= 5 ? [{ pid: 147, kind: "node", startTicks: "999" }] : [];
  await assert.rejects(L.recoverWorkerLock({ ...f.options, reviewedProof: approved, dryRun: false }), { code: "KEYWORD_INCREMENTAL_LOCK_PROCESS_CHANGED" });
  assert.equal(JSON.parse(await fs.readFile(f.lockFile)).token, SECRET); assert.equal((await fs.stat(path.join(f.directory, "worker-lock-recovery-claim.json"))).isFile(), true);
});
test("a new worker lock appearing after archival is preserved and the recovery claim holds", async t => {
  const f = await fixture(t), approved = await f.approval();
  await assert.rejects(L.recoverWorkerLock({ ...f.options, reviewedProof: approved, dryRun: false, archiveNoReplace: async (source, dest) => {
    await fs.rename(source, dest); await save(f.lockFile, { newWorker: true });
  } }), { code: "KEYWORD_INCREMENTAL_LOCK_NEW_OWNER_PRESENT" });
  assert.deepEqual(JSON.parse(await fs.readFile(f.lockFile)), { newWorker: true }); assert.equal((await fs.stat(path.join(f.directory, "worker-lock-recovery-claim.json"))).isFile(), true);
});

test("only the exact application ancestor chain may be excluded from peer checks", async t => {
  const f = await fixture(t); f.processReader.peers = async excluded => [{ pid: 52, kind: "node" }].filter(p => !excluded.includes(p.pid));
  const inspected = await L.inspectWorkerLockRecovery(f.options); assert.deepEqual(inspected.snapshot.serverChain.map(p => p.pid), [64, 63, 52, 1]);
  f.processReader.peers = async excluded => [{ pid: 52, kind: "node" }, { pid: 99, kind: "node" }].filter(p => !excluded.includes(p.pid));
  await assert.rejects(L.inspectWorkerLockRecovery(f.options), { code: "KEYWORD_INCREMENTAL_LOCK_PEER_UNKNOWN" });
});
test("a changed server ancestor identity invalidates a reviewed snapshot", async t => {
  const f = await fixture(t), approved = await f.approval(); f.rows.set(52, { ...f.rows.get(52), startTicks: "999" });
  await assert.rejects(L.recoverWorkerLock({ ...f.options, reviewedProof: approved, dryRun: false }), { code: "KEYWORD_INCREMENTAL_LOCK_REVIEW_MISMATCH" }); await absent(path.join(f.directory, "lock-recovery"));
});
for (const [name, change, code] of [
  ["protected collection", f => save(path.join(f.dataDir, "collector/jobs.json"), { version: 1, halted: { reason: "protected" }, jobs: [] }), "KEYWORD_INCREMENTAL_LOCK_COLLECTION_PROTECTED"],
  ["collection lease", f => save(path.join(f.dataDir, "collector-scheduled/jobs.json"), { version: 1, halted: null, jobs: [{ status: "completed", leaseHash: "private", leaseReleasedAt: null }] }), "KEYWORD_INCREMENTAL_LOCK_COLLECTION_BUSY"],
  ["web collection active", f => save(path.join(f.dataDir, "collector-web/state.json"), { version: 1, halted: null, active: { runId: "active" } }), "KEYWORD_INCREMENTAL_LOCK_COLLECTION_BUSY"],
  ["DB postprocess queued", f => save(path.join(f.dataDir, "history/collection_postprocess/queue.json"), { version: 1, jobs: { x: { status: "queued" } } }), "KEYWORD_INCREMENTAL_LOCK_DB_BUSY"],
  ["current v4 pending", f => save(path.join(f.dataDir, "keyword_monthly_refresh/jobs", "2".repeat(64) + ".json"), { jobId: "2".repeat(64), intent: { refreshVersion: V }, status: "deferred" }), "KEYWORD_INCREMENTAL_LOCK_QUEUE_ACTIVE"]
]) test(name + " blocks recovery and preserves protections", async t => {
  const f = await fixture(t); await change(f); const bytes = await fs.readFile(f.lockFile);
  await assert.rejects(L.inspectWorkerLockRecovery(f.options), { code }); assert.deepEqual(await fs.readFile(f.lockFile), bytes);
});
test("historical v2 deferred records are preserved and are not active v4/v5 work", async t => {
  const f = await fixture(t), old = path.join(f.dataDir, "keyword_monthly_refresh/jobs", "3".repeat(64) + ".json");
  await save(old, { jobId: "3".repeat(64), intent: { refreshVersion: "keyword-monthly-completed-run-v2" }, status: "deferred" }); const bytes = await fs.readFile(old);
  const r = await L.recoverWorkerLock({ ...f.options, reviewedProof: await f.approval(), dryRun: false }); assert.equal(r.status, "recovered"); assert.deepEqual(await fs.readFile(old), bytes);
});
test("Linux atomic no-replace rejects a destination appearing after preflight without changing either file", { skip: process.platform !== "linux" }, async t => {
  const f = await fixture(t), approved = await f.approval(), original = await fs.readFile(f.lockFile); let destination;
  await assert.rejects(L.recoverWorkerLock({ ...f.options, reviewedProof: approved, dryRun: false, archiveNoReplace: async (source, dest) => {
    destination = dest; await fs.writeFile(dest, "existing private archive", { flag: "wx", mode: 0o600 }); await fixtureAtomicArchive(source, dest);
  } }), { code: "EEXIST" });
  assert.deepEqual(await fs.readFile(f.lockFile), original); assert.equal(await fs.readFile(destination, "utf8"), "existing private archive"); assert.equal((await fs.stat(path.join(f.directory, "worker-lock-recovery-claim.json"))).isFile(), true);
});
test("Linux proc identity reads boot, namespace, start ticks and executable without cmdline or environment", { skip: process.platform !== "linux" }, async () => {
  const p = L.createLinuxProcessReader(), c = await p.context(), me = await p.process(process.pid); assert.match(c.bootId, /^[a-f0-9-]{36}$/); assert.match(c.pidNamespace, /^pid:\[\d+\]$/);
  assert.match(me.startTicks, /^\d+$/); assert.match(me.executableIdentity, /^[a-f0-9]{64}$/); assert.equal(me.kind, "node");
});
test("collection admission is rechecked at the final rename boundary", async t => {
  const f = await fixture(t), approved = await f.approval(); let calls = 0;
  f.processReader.peers = async () => { if (++calls === 5) await save(path.join(f.dataDir, "collector-web/state.json"), { version: 1, halted: null, active: { runId: "new" } }); return []; };
  await assert.rejects(L.recoverWorkerLock({ ...f.options, reviewedProof: approved, dryRun: false }), { code: "KEYWORD_INCREMENTAL_LOCK_COLLECTION_BUSY" });
  assert.equal(JSON.parse(await fs.readFile(f.lockFile)).token, SECRET);
});
test("a replaced original inode at the final boundary is not archived", async t => {
  const f = await fixture(t), approved = await f.approval(); let calls = 0;
  f.processReader.peers = async () => { if (++calls === 5) { await fs.rename(f.lockFile, path.join(f.root, "preserved-old-lock")); await save(f.lockFile, { replaced: true }); } return []; };
  await assert.rejects(L.recoverWorkerLock({ ...f.options, reviewedProof: approved, dryRun: false }), { code: "KEYWORD_INCREMENTAL_LOCK_CHANGED" });
  assert.deepEqual(JSON.parse(await fs.readFile(f.lockFile)), { replaced: true });
});
test("preflight-only and other-guard proof files cannot authorize legacy lock recovery", async t => {
  const f = await fixture(t), proof = JSON.parse(await fs.readFile(f.proofFile));
  for (const patch of [{ guardName: "another.cjs" }, { guardRequiredBeforeNormalization: false }, { applicationStarted: true }, { preflightOnly: true }, { providerCalls: 1 }]) {
    await save(f.proofFile, { ...proof, ...patch }); await assert.rejects(L.inspectWorkerLockRecovery(f.options), { code: "KEYWORD_INCREMENTAL_LOCK_CHILD_PROOF_INVALID" });
  }
});
