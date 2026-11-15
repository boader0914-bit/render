"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs/promises"), path = require("node:path"), os = require("node:os"), crypto = require("node:crypto");
const R = require("./retry_keyword_monthly_reviewed_lock.cjs"), H = require("./lib/keyword_monthly_refresh_preparation.cjs"), M = require("./lib/keyword_monthly_maintenance.cjs");
const NOW = "2026-11-15T15:00:00.000Z", hash = H.hash, bytes = x => Buffer.from(JSON.stringify(x));
async function save(file, value) { await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 }); await fs.writeFile(file, bytes(value), { mode: 0o600 }); }
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "reviewed-retry-")); t.after(async () => { assert.equal(path.dirname(root), path.resolve(os.tmpdir())); await fs.rm(root, { recursive: true, force: true }); });
  const dataDir = path.join(root, "data"), namespace = path.join(dataDir, "keyword_monthly_incremental"), jobs = path.join(dataDir, "keyword_monthly_refresh/jobs"), runId = "run_synthetic_complete";
  const manifestFile = path.join(dataDir, "outputs", runId, "manifest.json"), manifest = { keyword: "synthetic-keyword", collectionQuality: { status: "complete" } }; await save(manifestFile, manifest);
  const manifestSha256 = hash(await fs.readFile(manifestFile)), intent = { runId, keyword: manifest.keyword, manifestSha256, scheduleOccurrenceId: null, scope: manifest.keyword, refreshVersion: R.VERSION };
  const jobId = hash(bytes([R.VERSION, runId, manifestSha256, intent.keyword, intent.scope, null])), sourceKey = hash(bytes([R.VERSION, runId, manifestSha256, intent.keyword]));
  const row = { schemaVersion: 1, jobId, intent, status: "needs_verification", reasonCode: "KEYWORD_INCREMENTAL_WORKER_LOCKED", createdAt: "2026-11-15T14:00:00.000Z", updatedAt: "2026-11-15T14:02:40.000Z",
    startedAt: "2026-11-15T14:00:00.000Z", finishedAt: "2026-11-15T14:02:40.000Z", nextAttemptAt: null, recoveredAt: null, attempts: 1, maxAttempts: 3, result: null,
    lockDiagnostic: { schemaVersion: 1, reasonCode: "OWNER_OTHER_INSTANCE", ownerSchemaVersion: 2, ageMs: 1000, sameInstance: false, ownerProcessState: "unverified" } };
  const jobFile = path.join(jobs, jobId + ".json"); await save(jobFile, row);
  const recoveryId = crypto.randomUUID(), recoveryDir = path.join(namespace, "lock-recovery", recoveryId), lockJobId = crypto.randomUUID(), lock = { schemaVersion: 2, version: R.VERSION, token: crypto.randomUUID(), jobId: lockJobId, pid: 88, sourceKey, createdAt: row.createdAt };
  const archivedLock = path.join(recoveryDir, "original-lock.json"); await save(archivedLock, lock);
  const inputFile = path.join(namespace, "jobs", "refresh-job-" + lockJobId, "job-input.json"), input = { schemaVersion: 1, version: R.VERSION, dataDir,
    evidence: { runId, keyword: intent.keyword, manifestSha256, scheduleOccurrenceId: null, finishedAt: "2026-11-15T13:59:00.000Z" } }; await save(inputFile, input);
  const dbFile = path.join(dataDir, "history/collection_postprocess/runs", hash(Buffer.from(runId)) + ".json"); await save(dbFile, { runId, status: "complete", finishedAt: input.evidence.finishedAt, result: { sourceManifestSha256: manifestSha256 } });
  const snapshot = { targetJobId: jobId, sourceKey, lockSha256: hash(await fs.readFile(archivedLock)), jobInputSha256: hash(await fs.readFile(inputFile)), sourceManifestSha256: manifestSha256,
    dbReceiptSha256: hash(await fs.readFile(dbFile)), sourcePointerSha256: "a".repeat(64), publicPointerSha256: "b".repeat(64) };
  const preflightFile = path.join(recoveryDir, "reviewed-preflight.json"); await save(preflightFile, { schemaVersion: 1, action: "reviewed_dead_worker_lock_recovery", recoveryId, snapshot, snapshotSha256: hash(bytes(snapshot)) });
  const recoveryFile = path.join(recoveryDir, "recovery-complete.json"); await save(recoveryFile, { schemaVersion: 1, action: "archived_verified_dead_worker_lock", recoveryId,
    originalBytesAndModePreserved: true, originalLedgersChanged: false, activeLockPathAbsent: true, completedAt: NOW,
    preflightSha256: hash(await fs.readFile(preflightFile)), snapshotSha256: hash(bytes(snapshot)), lockSha256: snapshot.lockSha256,
    sourcePointerSha256: snapshot.sourcePointerSha256, publicPointerSha256: snapshot.publicPointerSha256 });
  const options = { mode: "inspect", dataDir, jobId, expectedJobSha256: hash(await fs.readFile(jobFile)), recoveryId, recoveryReceiptSha256: hash(await fs.readFile(recoveryFile)), now: () => NOW };
  let admissions = 0; const deps = { fixture: true, admit: async () => { admissions++; return { idle: true, authenticatedLoopbackOnly: true }; } };
  async function approved() { const read = await R.retryReviewedLock(options, deps); return { ...options, mode: "commit", reviewSha256: read.reviewSha256 }; }
  return { root, dataDir, namespace, jobs, jobFile, row, sourceKey, options, deps, approved, manifestFile, dbFile, inputFile, recoveryFile, preflightFile, archivedLock, recoveryDir, admissions: () => admissions };
}
async function absent(file) { await assert.rejects(fs.lstat(file), { code: "ENOENT" }); }
test("review inspection is readonly, exact to v5 original and recovered ownership", async t => {
  const f = await fixture(t), before = await fs.readFile(f.jobFile), entries = await fs.readdir(f.namespace);
  const inspected = await R.retryReviewedLock(f.options, f.deps); assert.equal(inspected.status, "review_required"); assert.equal(inspected.changed, false); assert.equal(inspected.restartRequired, true); assert.equal(f.admissions(), 0);
  assert.equal(inspected.snapshot.sourceKey, f.sourceKey); assert.deepEqual(await fs.readFile(f.jobFile), before); assert.deepEqual(await fs.readdir(f.namespace), entries); await absent(path.join(f.dataDir, "operations"));
});
test("approved retry atomically queues same intent and attempts, keeps exact original audit, starts no collector and requires restart", async t => {
  const f = await fixture(t), files = [f.manifestFile, f.dbFile, f.inputFile, f.recoveryFile, f.preflightFile, f.archivedLock], snapshots = await Promise.all(files.map(file => fs.readFile(file))), original = await fs.readFile(f.jobFile);
  const approved = await f.approved(), result = await R.retryReviewedLock(approved, f.deps), queued = JSON.parse(await fs.readFile(f.jobFile));
  assert.equal(result.status, "queued"); assert.equal(result.restartRequired, true); assert.equal(result.collectorStarted, false); assert.equal(result.providerCalls, 0); assert.equal(f.admissions(), 2);
  assert.equal(queued.jobId, f.row.jobId); assert.deepEqual(queued.intent, f.row.intent); assert.equal(queued.status, "queued"); assert.equal(queued.reasonCode, R.REASON); assert.equal(queued.attempts, 1); assert.equal(queued.maxAttempts, 3);
  assert.equal(queued.createdAt, f.row.createdAt); assert.equal(queued.nextAttemptAt, NOW); assert.equal(queued.recoveredAt, NOW); assert.equal(queued.finishedAt, null); assert.equal(Object.hasOwn(queued, "lockDiagnostic"), false);
  assert.deepEqual(await fs.readFile(path.join(result.auditDir, "original-job.json")), original); assert.ok(await fs.stat(path.join(result.auditDir, "owner.json"))); assert.ok(await fs.stat(path.join(result.auditDir, "retry-complete.json")));
  for (const [i, file] of files.entries()) assert.deepEqual(await fs.readFile(file), snapshots[i]); await absent(path.join(f.namespace, M.MAINTENANCE_FILE));
  const Q = require("./lib/keyword_monthly_refresh.cjs").createKeywordMonthlyRefresh({ dataDir: f.dataDir, refreshVersion: R.VERSION, readCompletedEvidence: async () => assert.fail("status must not read source"), refresh: async () => assert.fail("status must not execute") });
  const readback = await Q.status(); assert.equal(readback.items[0].status, "queued"); await Q.close();
  await assert.rejects(R.retryReviewedLock(approved, f.deps), /CHANGED/);
});
for (const [name, mutate] of [
  ["exhausted attempts", row => { row.attempts = row.maxAttempts; }], ["different error", row => { row.reasonCode = "KEYWORD_MONTHLY_SOURCE_CHANGED"; }],
  ["complete row", row => { row.status = "complete"; }], ["v4 row", row => { row.intent.refreshVersion = "keyword-monthly-incremental-v4"; }]
]) test(`${name} cannot be reviewed or retried`, async t => {
  const f = await fixture(t); mutate(f.row); await save(f.jobFile, f.row); f.options.expectedJobSha256 = hash(await fs.readFile(f.jobFile));
  await assert.rejects(R.retryReviewedLock(f.options, f.deps), { code: "KEYWORD_REVIEWED_RETRY_JOB_NOT_ELIGIBLE" }); await absent(path.join(f.dataDir, "operations"));
});
for (const name of ["worker", "recoveryClaim", "publishLock", "intent", "complete"]) test(`${name} presence holds without changing source or failed job`, async t => {
  const f = await fixture(t), file = name === "worker" ? path.join(f.namespace, "worker-lock.json") : name === "recoveryClaim" ? path.join(f.namespace, "worker-lock-recovery-claim.json")
    : name === "publishLock" ? path.join(f.dataDir, "keyword_monthly_analysis/publish.lock") : path.join(f.dataDir, "keyword_monthly_analysis/refresh-receipts", name + "-" + f.sourceKey + ".json");
  await save(file, { retained: true }); const before = await fs.readFile(f.jobFile);
  await assert.rejects(R.retryReviewedLock(f.options, f.deps), { code: "KEYWORD_REVIEWED_RETRY_PUBLICATION_OR_LOCK_PRESENT" }); assert.deepEqual(await fs.readFile(f.jobFile), before);
});
for (const name of ["manifest", "db", "recovery", "archive", "input"]) test(`changed ${name} evidence cannot authorize a retry`, async t => {
  const f = await fixture(t), before = await fs.readFile(f.jobFile), file = { manifest: f.manifestFile, db: f.dbFile, recovery: f.recoveryFile, archive: f.archivedLock, input: f.inputFile }[name]; await fs.appendFile(file, " ");
  await assert.rejects(R.retryReviewedLock(f.options, f.deps)); assert.deepEqual(await fs.readFile(f.jobFile), before); await absent(path.join(f.dataDir, "operations"));
});
test("runtime unknown cannot mutate a failed job or leave a maintenance lease", async t => {
  const f = await fixture(t), approved = await f.approved(), before = await fs.readFile(f.jobFile);
  await assert.rejects(R.retryReviewedLock(approved, { fixture: true, admit: async () => ({ idle: false, authenticatedLoopbackOnly: true }) }), { code: "KEYWORD_REVIEWED_RETRY_RUNTIME_UNVERIFIED" });
  assert.deepEqual(await fs.readFile(f.jobFile), before); await absent(path.join(f.namespace, M.MAINTENANCE_FILE));
});
for (const replace of [false, true]) test(`concurrent ${replace ? "inode replacement" : "byte mutation"} is never overwritten`, async t => {
  const f = await fixture(t), approved = await f.approved(); let calls = 0, retained;
  await assert.rejects(R.retryReviewedLock(approved, { fixture: true, admit: async () => {
    if (++calls === 2) { retained = await fs.readFile(f.jobFile); if (replace) { await fs.rename(f.jobFile, path.join(f.root, "retained-original-job.json")); await fs.writeFile(f.jobFile, retained, { mode: 0o600 }); }
      else { retained = bytes({ ...f.row, updatedAt: NOW }); await fs.writeFile(f.jobFile, retained); } }
    return { idle: true, authenticatedLoopbackOnly: true };
  } }), { code: "KEYWORD_REVIEWED_RETRY_CHANGED" });
  assert.deepEqual(await fs.readFile(f.jobFile), retained); await absent(path.join(f.namespace, M.MAINTENANCE_FILE));
});
test("rename failure preserves original failed bytes and keeps owned plan audit", async t => {
  const f = await fixture(t), approved = await f.approved(), before = await fs.readFile(f.jobFile), rename = fs.rename;
  t.mock.method(fs, "rename", async (source, destination) => { if (destination === f.jobFile) throw Object.assign(Error("private error"), { code: "EIO" }); return rename(source, destination); });
  await assert.rejects(R.retryReviewedLock(approved, f.deps), { code: "EIO" }); assert.deepEqual(await fs.readFile(f.jobFile), before); await absent(path.join(f.namespace, M.MAINTENANCE_FILE));
});
test("post-rename audit failure reports readback need and never silently retries or restores original over queued data", async t => {
  const f = await fixture(t), approved = await f.approved(), open = fs.open;
  t.mock.method(fs, "open", async (file, ...args) => { if (path.basename(file) === "retry-complete.json") throw Object.assign(Error("private audit error"), { code: "ENOSPC" }); return open(file, ...args); });
  await assert.rejects(R.retryReviewedLock(approved, f.deps), e => e.code === "KEYWORD_REVIEWED_RETRY_NEEDS_READBACK" && e.mutationState === "job_changed_verify_audit");
  assert.equal(JSON.parse(await fs.readFile(f.jobFile)).status, "queued"); await absent(path.join(f.namespace, M.MAINTENANCE_FILE));
});
