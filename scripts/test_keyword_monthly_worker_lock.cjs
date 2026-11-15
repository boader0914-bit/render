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
function reusedOwner(f, asServer = false) {
  const identity = { executableIdentity: "a".repeat(64), cwdIdentity: "b".repeat(64), timeNamespace: "time:[1234]" };
  f.rows.delete(64); f.rows.delete(63); f.rows.delete(52); f.options.serverPid = asServer ? 84 : 85;
  f.rows.set(73, { pid: 73, ppid: 1, startTicks: "4319900", kind: "node", ...identity });
  f.rows.set(84, { pid: 84, ppid: 73, startTicks: "4320000", kind: asServer ? "node" : "shell", ...identity });
  if (!asServer) f.rows.set(85, { pid: 85, ppid: 84, startTicks: "4320100", kind: "node", ...identity });
  const basis = { bootEpochSeconds: String(Date.parse("2026-11-15T00:00:00.000Z") / 1000), ticksPerSecond: "100", timeNamespace: "time:[1234]",
    getconfSha256: "7".repeat(64), getconfIdentity: { dev: "1", ino: "2", mode: "33261", uid: "0", gid: "0", size: "100", nlink: "1", mtimeNs: "3", ctimeNs: "4" }, coherenceVerified: true };
  f.processReader.clockBasis = async () => ({ ...basis }); return basis;
}
async function retiredFixture(t) {
  const f = await fixture(t, 2), nextContext = { bootId: "77777777-1111-4222-8333-444444444444", pidNamespace: "pid:[9999]", hostId: "8".repeat(64) };
  const priorInstanceHostname = "srv-da9q6don74is738t7id0-77b475ff68-qmrs5";
  f.lock.owner.hostId = H(J([priorInstanceHostname, context.bootId])); await save(f.lockFile, f.lock);
  f.processReader.context = async () => ({ ...nextContext });
  const contextHash = value => H(J([value.bootId, value.pidNamespace, value.hostId]));
  const proof = { schemaVersion: 1, action: "reviewed_retired_instance_worker_lock", serviceId: "srv-da9q6don74is738t7id0", persistentDiskMount: "/var/data",
    priorDeploymentId: "dep-111111111111111111111111", priorDeploymentStartedAt: "2026-11-15T11:00:00.000Z", retirementNoLaterThan: "2026-11-15T11:46:00.000Z", retirementBoundBasis: "exclusive_persistent_disk_handover",
    currentDeploymentId: "dep-222222222222222222222222", currentInstanceStartedAt: "2026-11-15T11:46:00.000Z", reviewedAt: NOW,
    lockSha256: H(await fs.readFile(f.lockFile)), ownerContextSha256: contextHash(f.lock.owner), currentContextSha256: contextHash(nextContext), priorInstanceHostname, priorHostnameEvidenceSha256: "5".repeat(64),
    providerEvidenceSha256: "9".repeat(64), diskExclusivityEvidenceSha256: "7".repeat(64), priorInstanceTerminationBoundVerified: true, exclusiveDiskHandoverVerified: true };
  f.options.retiredInstanceProof = proof; f.options.now = () => Date.parse(NOW);
  const originalApproval = f.approval;
  f.approval = async () => ({ ...await originalApproval(), incident: { kind: "retired_instance", retirementProofSha256: H(J(proof)), evidenceSha256: proof.providerEvidenceSha256 } });
  return { ...f, retiredProof: proof, nextContext };
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
test("prepared conversion excludes a new incremental worker before wx without changing its marker", async t => {
  const f = await fixture(t), M = require("./lib/keyword_monthly_maintenance.cjs"); await fs.unlink(f.lockFile);
  const lease = await M.acquirePreparedConversionLease({ dataDir: f.dataDir, mode: "stage", operationId: crypto.randomUUID(), contextSha256: "a".repeat(64) });
  const marker = path.join(f.directory, M.MAINTENANCE_FILE), before = await fs.readFile(marker);
  await assert.rejects(L.acquireWorkerLock({ directory: f.directory, sourceKey: f.sourceKey, version: V, fixture: true, processReader: f.processReader }),
    e => e.code === "KEYWORD_INCREMENTAL_PREPARED_CONVERSION_ACTIVE" && e.deferred === true);
  await absent(f.lockFile); assert.deepEqual(await fs.readFile(marker), before); await lease.release();
});
for (const invalid of [false, true]) test(`prepared conversion appearing after worker wx ${invalid ? "invalid" : "active"} defers and removes only the empty own inode`, async t => {
  const f = await fixture(t), M = require("./lib/keyword_monthly_maintenance.cjs"); await fs.unlink(f.lockFile); const marker = path.join(f.directory, M.MAINTENANCE_FILE), originalOpen = fs.open; let maintenance;
  t.mock.method(fs, "open", async (file, ...args) => {
    const h = await originalOpen(file, ...args);
    if (file === f.lockFile && args[0] === "wx") {
      if (invalid) await fs.writeFile(marker, "unknown marker", { flag: "wx", mode: 0o600 });
      else maintenance = await M.acquirePreparedConversionLease({ dataDir: f.dataDir, mode: "publish", operationId: crypto.randomUUID(), contextSha256: "b".repeat(64) });
    }
    return h;
  });
  await assert.rejects(L.acquireWorkerLock({ directory: f.directory, sourceKey: f.sourceKey, version: V, fixture: true, processReader: f.processReader }),
    e => e.code === (invalid ? "KEYWORD_INCREMENTAL_PREPARED_CONVERSION_UNVERIFIED" : "KEYWORD_INCREMENTAL_PREPARED_CONVERSION_ACTIVE") && e.deferred === true);
  await absent(f.lockFile); assert.ok(await fs.stat(marker)); if (maintenance) await maintenance.release(); else assert.equal(await fs.readFile(marker, "utf8"), "unknown marker");
});
test("prepared conversion admission read errors remain controlled and deferred before own wx", async t => {
  const f = await fixture(t), M = require("./lib/keyword_monthly_maintenance.cjs"); await fs.unlink(f.lockFile);
  t.mock.method(M, "readPreparedConversionAdmission", async () => { throw Error("private admission error"); });
  await assert.rejects(L.acquireWorkerLock({ directory: f.directory, sourceKey: f.sourceKey, version: V, fixture: true, processReader: f.processReader }),
    e => e.code === "KEYWORD_INCREMENTAL_PREPARED_CONVERSION_UNVERIFIED" && e.deferred === true && !e.message.includes("private"));
  await absent(f.lockFile);
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
test("cross-instance context inspection is redacted and cannot authorize recovery", async t => {
  const f = await retiredFixture(t), before = await fs.readFile(f.lockFile), entries = await fs.readdir(f.directory);
  const result = await L.inspectWorkerLockInstanceContext(f.options);
  assert.equal(result.status, "retirement_evidence_required"); assert.equal(result.changed, false); assert.equal(result.providerRetirementVerified, false);
  assert.equal(result.lockSha256, f.retiredProof.lockSha256); assert.equal(result.ownerContextSha256, f.retiredProof.ownerContextSha256); assert.equal(result.currentContextSha256, f.retiredProof.currentContextSha256);
  const serialized = JSON.stringify(result); for (const secret of [SECRET, context.bootId, context.pidNamespace, context.hostId, f.nextContext.bootId, f.jobRoot, f.retiredProof.priorInstanceHostname]) assert.equal(serialized.includes(secret), false);
  assert.deepEqual(await fs.readFile(f.lockFile), before); assert.deepEqual(await fs.readdir(f.directory), entries);
  delete f.options.retiredInstanceProof; await assert.rejects(L.inspectWorkerLockRecovery(f.options), { code: "KEYWORD_INCREMENTAL_LOCK_CONTEXT_UNKNOWN" });
});
test("retired-instance review accepts the existing ISO-string clock contract", async t => {
  const f = await retiredFixture(t); f.options.now = () => NOW;
  assert.equal((await L.inspectWorkerLockRecovery(f.options)).status, "retired_instance_review_required");
});
test("reviewed retired instance recovery preserves lock bytes and never uses a local colliding owner PID as death evidence", async t => {
  const f = await retiredFixture(t); f.lock.pid = f.options.serverPid; await save(f.lockFile, f.lock); f.retiredProof.lockSha256 = H(await fs.readFile(f.lockFile));
  const original = await fs.readFile(f.lockFile), files = [f.queueFile, f.pointerFile, f.sourcePointerFile, f.ownerFile, f.proofFile], saved = await Promise.all(files.map(file => fs.readFile(file)));
  const inspected = await L.inspectWorkerLockRecovery(f.options); assert.equal(inspected.status, "retired_instance_review_required"); assert.equal(inspected.snapshot.retiredInstance.proofSha256, H(J(f.retiredProof)));
  const approval = await f.approval(), dry = await L.recoverWorkerLock({ ...f.options, reviewedProof: approval }); assert.equal(dry.changed, false);
  const result = await L.recoverWorkerLock({ ...f.options, reviewedProof: approval, dryRun: false }); assert.equal(result.status, "recovered");
  await absent(f.lockFile); const directory = path.join(f.directory, "lock-recovery", result.recoveryId);
  assert.deepEqual(await fs.readFile(path.join(directory, "original-lock.json")), original);
  const receipt = JSON.parse(await fs.readFile(path.join(directory, "recovery-complete.json"))); assert.equal(receipt.retiredInstance.proofSha256, H(J(f.retiredProof)));
  for (const [i, file] of files.entries()) assert.deepEqual(await fs.readFile(file), saved[i]);
});
for (const [name, mutate, code] of [
  ["unconfirmed old termination", p => { p.priorInstanceTerminationBoundVerified = false; }, "KEYWORD_INCREMENTAL_LOCK_RETIREMENT_PROOF_REQUIRED"],
  ["unconfirmed disk handover", p => { p.exclusiveDiskHandoverVerified = false; }, "KEYWORD_INCREMENTAL_LOCK_RETIREMENT_PROOF_REQUIRED"],
  ["wrong service", p => { p.serviceId = "srv-other-service"; }, "KEYWORD_INCREMENTAL_LOCK_RETIREMENT_PROOF_REQUIRED"],
  ["wrong disk mount", p => { p.persistentDiskMount = "/tmp"; }, "KEYWORD_INCREMENTAL_LOCK_RETIREMENT_PROOF_REQUIRED"],
  ["same deployment", p => { p.priorDeploymentId = p.currentDeploymentId; }, "KEYWORD_INCREMENTAL_LOCK_RETIREMENT_PROOF_REQUIRED"],
  ["missing provider evidence", p => { p.providerEvidenceSha256 = null; }, "KEYWORD_INCREMENTAL_LOCK_RETIREMENT_PROOF_REQUIRED"],
  ["unknown extra field", p => { p.autoReclaim = true; }, "KEYWORD_INCREMENTAL_LOCK_RETIREMENT_PROOF_REQUIRED"],
  ["wrong lock", p => { p.lockSha256 = "0".repeat(64); }, "KEYWORD_INCREMENTAL_LOCK_RETIREMENT_PROOF_MISMATCH"],
  ["wrong prior context", p => { p.ownerContextSha256 = "0".repeat(64); }, "KEYWORD_INCREMENTAL_LOCK_RETIREMENT_PROOF_MISMATCH"],
  ["wrong prior hostname", p => { p.priorInstanceHostname = p.priorInstanceHostname.replace("qmrs5", "other"); }, "KEYWORD_INCREMENTAL_LOCK_RETIREMENT_PROOF_MISMATCH"],
  ["missing prior hostname evidence", p => { p.priorHostnameEvidenceSha256 = null; }, "KEYWORD_INCREMENTAL_LOCK_RETIREMENT_PROOF_REQUIRED"],
  ["wrong current context", p => { p.currentContextSha256 = "0".repeat(64); }, "KEYWORD_INCREMENTAL_LOCK_RETIREMENT_PROOF_MISMATCH"],
  ["lock outside deployment lifetime", p => { p.priorDeploymentStartedAt = p.retirementNoLaterThan; }, "KEYWORD_INCREMENTAL_LOCK_RETIREMENT_PROOF_MISMATCH"],
  ["replacement instance predating retirement bound", p => { p.currentInstanceStartedAt = "2026-11-15T11:44:00.000Z"; }, "KEYWORD_INCREMENTAL_LOCK_RETIREMENT_PROOF_MISMATCH"],
  ["future review", p => { p.reviewedAt = "2027-01-01T00:00:00.000Z"; }, "KEYWORD_INCREMENTAL_LOCK_RETIREMENT_PROOF_MISMATCH"]
]) test(`retired-instance ${name} fails closed without mutation`, async t => {
  const f = await retiredFixture(t), before = await fs.readFile(f.lockFile); mutate(f.retiredProof);
  await assert.rejects(L.inspectWorkerLockRecovery(f.options), { code }); assert.deepEqual(await fs.readFile(f.lockFile), before); await absent(path.join(f.directory, "lock-recovery"));
});
test("retirement proof cannot bypass a same-instance live owner or legacy unknown owner", async t => {
  const f = await retiredFixture(t); f.processReader.context = async () => ({ bootId: f.lock.owner.bootId, pidNamespace: f.lock.owner.pidNamespace, hostId: f.lock.owner.hostId });
  await assert.rejects(L.inspectWorkerLockRecovery(f.options), { code: "KEYWORD_INCREMENTAL_LOCK_RETIREMENT_NOT_APPLICABLE" });
  const legacy = await fixture(t); legacy.options.retiredInstanceProof = f.retiredProof;
  await assert.rejects(L.inspectWorkerLockRecovery(legacy.options), { code: "KEYWORD_INCREMENTAL_LOCK_RETIREMENT_NOT_APPLICABLE" });
});
test("retired-instance recovery still requires separate exact snapshot approval", async t => {
  const f = await retiredFixture(t), approved = await f.approval(), before = await fs.readFile(f.lockFile);
  for (const incident of [null, { pid: 84, exitCode: 134, exitedAt: NOW, evidenceSha256: "9".repeat(64) }, { ...approved.incident, retirementProofSha256: "0".repeat(64) }])
    await assert.rejects(L.recoverWorkerLock({ ...f.options, reviewedProof: { ...approved, incident }, dryRun: false }), { code: "KEYWORD_INCREMENTAL_LOCK_RETIREMENT_PROOF_MISMATCH" });
  f.retiredProof.providerEvidenceSha256 = "6".repeat(64);
  await assert.rejects(L.recoverWorkerLock({ ...f.options, reviewedProof: approved, dryRun: false }), { code: "KEYWORD_INCREMENTAL_LOCK_REVIEW_MISMATCH" });
  assert.deepEqual(await fs.readFile(f.lockFile), before); await absent(path.join(f.directory, "lock-recovery"));
});
test("retired-instance proof does not bypass current peer work or unresolved publication", async t => {
  const f = await retiredFixture(t); f.processReader.peers = async () => [{ pid: 999, kind: "node", startTicks: "500" }];
  await assert.rejects(L.inspectWorkerLockRecovery(f.options), { code: "KEYWORD_INCREMENTAL_LOCK_PEER_UNKNOWN" }); f.processReader.peers = async () => [];
  await save(path.join(f.receiptDir, "intent-" + f.sourceKey + ".json"), { publishing: true });
  await assert.rejects(L.inspectWorkerLockRecovery(f.options), { code: "KEYWORD_INCREMENTAL_LOCK_PUBLICATION_INTENT_PRESENT" });
});
test("changed replacement context invalidates retired-instance review without clearing the old lock", async t => {
  const f = await retiredFixture(t), approval = await f.approval(), before = await fs.readFile(f.lockFile);
  f.processReader.context = async () => ({ ...f.nextContext, pidNamespace: "pid:[10000]" });
  await assert.rejects(L.recoverWorkerLock({ ...f.options, reviewedProof: approval, dryRun: false }), { code: "KEYWORD_INCREMENTAL_LOCK_RETIREMENT_PROOF_MISMATCH" });
  assert.deepEqual(await fs.readFile(f.lockFile), before); await absent(path.join(f.directory, "lock-recovery"));
});
test("retired-instance final boundary preserves a replacement lock and leaves its recovery claim for review", async t => {
  const f = await retiredFixture(t), approval = await f.approval(), replacement = J({ schemaVersion: 2, anotherOwner: true });
  const archiveNoReplace = f.options.archiveNoReplace || (async (a, b) => fs.rename(a, b));
  f.options.archiveNoReplace = async (a, b) => { await archiveNoReplace(a, b); await fs.writeFile(a, replacement, { flag: "wx", mode: 0o600 }); };
  await assert.rejects(L.recoverWorkerLock({ ...f.options, reviewedProof: approval, dryRun: false }), { code: "KEYWORD_INCREMENTAL_LOCK_NEW_OWNER_PRESENT" });
  assert.deepEqual(await fs.readFile(f.lockFile), replacement); assert.ok(await fs.stat(path.join(f.directory, "worker-lock-recovery-claim.json")));
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
  const birth = await p.clockBasis(me.startTicks); assert.match(birth.bootEpochSeconds, /^\d+$/); assert.match(birth.ticksPerSecond, /^[1-9]\d*$/);
  assert.equal(birth.coherenceVerified, true); assert.equal(birth.timeNamespace, me.timeNamespace); assert.match(birth.getconfSha256, /^[a-f0-9]{64}$/);
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
test("legacy reused shell ancestor is only an inspect candidate until an independently reviewed earlier exit134", async t => {
  const f = await fixture(t); reusedOwner(f); const inspected = await L.inspectWorkerLockRecovery(f.options);
  assert.equal(inspected.status, "reuse_review_required"); assert.equal(inspected.snapshot.ownerReuse.currentKind, "shell"); assert.equal(inspected.snapshot.ownerReuse.oldOwnerRuntimeContract, "node_host_worker");
  assert.equal(inspected.snapshot.ownerReuse.currentBirthLowerEpochMs, Date.parse("2026-11-15T11:59:58.000Z"));
  assert.equal(JSON.stringify(inspected).includes(SECRET), false);
  const dry = await L.recoverWorkerLock({ ...f.options, reviewedProof: await f.approval() }); assert.equal(dry.status, "verified_dry_run");
  const result = await L.recoverWorkerLock({ ...f.options, reviewedProof: await f.approval(), dryRun: false }); assert.equal(result.status, "recovered");
});
test("a legacy PID reused by the exact current server has the same strict reviewed-birth rule", async t => {
  const f = await fixture(t); reusedOwner(f, true); const plan = await L.inspectWorkerLockRecovery(f.options);
  assert.equal(plan.snapshot.ownerReuse.currentKind, "node"); const r = await L.recoverWorkerLock({ ...f.options, reviewedProof: await f.approval() }); assert.equal(r.status, "verified_dry_run");
});
test("legacy PID reuse rejects equal/later exit boundaries and a non134 exit", async t => {
  const f = await fixture(t); reusedOwner(f); const approved = await f.approval(), lower = (await L.inspectWorkerLockRecovery(f.options)).snapshot.ownerReuse.currentBirthLowerEpochMs;
  for (const incident of [{ ...approved.incident, exitedAt: new Date(lower).toISOString() }, { ...approved.incident, exitedAt: new Date(lower + 1).toISOString() }, { ...approved.incident, exitCode: 1 }])
    await assert.rejects(L.recoverWorkerLock({ ...f.options, reviewedProof: { ...approved, incident }, dryRun: false }), { code: "KEYWORD_INCREMENTAL_LOCK_PID_REUSE_EXIT_UNPROVEN" });
  assert.equal(JSON.parse(await fs.readFile(f.lockFile)).token, SECRET);
});
test("a live PID outside the current server chain remains active even with a later clock basis", async t => {
  const f = await fixture(t); reusedOwner(f); f.rows.set(85, { ...f.rows.get(85), ppid: 73 });
  await assert.rejects(L.inspectWorkerLockRecovery(f.options), { code: "KEYWORD_INCREMENTAL_LOCK_OWNER_ACTIVE" });
});
test("unknown HZ/btime/coherence/time namespace cannot authorize a reuse candidate", async t => {
  const f = await fixture(t), basis = reusedOwner(f);
  for (const patch of [{ ticksPerSecond: "0" }, { ticksPerSecond: "unknown" }, { bootEpochSeconds: "unknown" }, { coherenceVerified: false }, { timeNamespace: "time:[999]" }]) {
    f.processReader.clockBasis = async () => ({ ...basis, ...patch }); await assert.rejects(L.inspectWorkerLockRecovery(f.options), { code: "KEYWORD_INCREMENTAL_LOCK_BIRTH_PROOF_UNKNOWN" });
  }
});
test("reviewed reuse pins remain stable across fresh clock samples and reject changed process/birth identities", async t => {
  const f = await fixture(t), basis = reusedOwner(f); let sample = 0;
  f.processReader.clockBasis = async () => ({ ...basis, diagnosticSample: ++sample });
  const a = await L.inspectWorkerLockRecovery(f.options), approved = await f.approval(), b = await L.inspectWorkerLockRecovery(f.options); assert.equal(a.snapshotSha256, b.snapshotSha256);
  const original = { ...f.rows.get(84) };
  for (const patch of [{ startTicks: "4320200" }, { executableIdentity: "2".repeat(64) }, { cwdIdentity: "3".repeat(64) }, { ppid: 1 }]) {
    f.rows.set(84, { ...original, ...patch }); await assert.rejects(L.recoverWorkerLock({ ...f.options, reviewedProof: approved, dryRun: false }));
  }
  f.rows.set(84, original); f.processReader.clockBasis = async () => ({ ...basis, bootEpochSeconds: String(Number(basis.bootEpochSeconds) + 1) });
  await assert.rejects(L.recoverWorkerLock({ ...f.options, reviewedProof: approved, dryRun: false }), { code: "KEYWORD_INCREMENTAL_LOCK_REVIEW_MISMATCH" });
});
test("schema2 still refuses a live reused PID even when it is a verified current ancestor", async t => {
  const f = await fixture(t, 2); reusedOwner(f); await assert.rejects(L.inspectWorkerLockRecovery(f.options), { code: "KEYWORD_INCREMENTAL_LOCK_PID_REUSED" });
});
