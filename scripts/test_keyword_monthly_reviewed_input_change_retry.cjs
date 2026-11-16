"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs/promises"), path = require("node:path"), os = require("node:os"), crypto = require("node:crypto");
const R = require("./retry_keyword_monthly_reviewed_input_change.cjs"), H = require("./lib/keyword_monthly_refresh_preparation.cjs"), F = require("./lib/keyword_monthly_incremental_failure.cjs"), M = require("./lib/keyword_monthly_maintenance.cjs");
const NOW = "2026-11-16T01:05:00.000Z", bytes = v => Buffer.from(JSON.stringify(v)), hash = H.hash;
async function save(file, value) { await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 }); await fs.writeFile(file, bytes(value), { mode: 0o600 }); }
async function absent(file) { await assert.rejects(fs.lstat(file), { code: "ENOENT" }); }
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "reviewed-input-retry-")); t.after(async () => { assert.equal(path.dirname(root), path.resolve(os.tmpdir())); await fs.rm(root, { recursive: true, force: true }); });
  const dataDir = path.join(root, "data"), namespace = path.join(dataDir, "keyword_monthly_incremental"), receipts = path.join(dataDir, "keyword_monthly_analysis/refresh-receipts"), failureId = crypto.randomUUID(), jobRoot = path.join(namespace, "jobs", "refresh-job-" + failureId), runId = "synthetic_complete_run", keyword = "synthetic-keyword", slot = "rotation_2026-11-16_1";
  const manifestFile = path.join(dataDir, "outputs", runId, "manifest.json"); await save(manifestFile, { keyword, collectionQuality: { status: "complete" } }); const manifestSha256 = hash(await fs.readFile(manifestFile));
  const intent = { runId, keyword, manifestSha256, scheduleOccurrenceId: slot, scope: keyword, refreshVersion: R.VERSION }, jobId = hash(bytes([R.VERSION, runId, manifestSha256, keyword, keyword, slot])), sourceKey = hash(bytes([R.VERSION, runId, manifestSha256, keyword]));
  const row = { schemaVersion: 1, jobId, intent, status: "needs_verification", reasonCode: "KEYWORD_RECONSTRUCT_OUTSIDE_READ_DENIED", createdAt: "2026-11-16T00:03:53.915Z", updatedAt: "2026-11-16T00:39:50.691Z", startedAt: "2026-11-16T00:03:53.915Z", finishedAt: "2026-11-16T00:39:50.691Z", nextAttemptAt: null, recoveredAt: null, attempts: 1, maxAttempts: 3, result: null }, jobFile = path.join(dataDir, "keyword_monthly_refresh/jobs", jobId + ".json"); await save(jobFile, row);
  const publicPointerFile = path.join(dataDir, "keyword_monthly_analysis/current.json"), publicPointer = { schemaVersion: 1, generation: "c".repeat(32), catalogSha256: "d".repeat(64), catalogBytes: 256, publishedAt: "2026-11-15T17:49:05.637Z" }; await save(publicPointerFile, publicPointer); const publicSha = hash(await fs.readFile(publicPointerFile));
  const sourcePointerFile = path.join(namespace, "source-current.json"); await save(sourcePointerFile, { schemaVersion: 1, version: "keyword-monthly-incremental-state-v1", compression: "gzip", stateSha256: "a".repeat(64), storageSha256: "b".repeat(64) });
  const evidence = { runId, keyword, manifestSha256, scheduleOccurrenceId: slot, status: "complete", quality: "complete", postprocessStatus: "complete", finishedAt: "2026-11-16T00:03:14.000Z" }, inputFile = path.join(jobRoot, "job-input.json"); await save(inputFile, { schemaVersion: 1, dataDir, version: R.VERSION, evidence, initialBundle: { generation: publicPointer.generation, pointerSha256: publicSha, catalogSha256: publicPointer.catalogSha256 } });
  const ownerFile = path.join(jobRoot, "refresh-owner.json"); await save(ownerFile, { schemaVersion: 1, token: failureId, sourceKey, root: jobRoot });
  const pid = 987654, proofFile = path.join(jobRoot, "control/isolation.json"); await save(proofFile, { mode: "seccomp", pid, expectedRoot: jobRoot, noNewPrivs: true, seccompMode: 2, networkFdsClosed: true, preflightOnly: false, environmentSanitizedForExec: true, unrestrictedFallbackAllowed: false, applicationStarted: false, guardRequiredBeforeNormalization: true, guardName: "reconstruct_keyword_monthly_incremental.cjs", providerCalls: 0, guardSha256: "e".repeat(64), nodeSha256: "f".repeat(64), nonStandardFdsClosedBeforeExec: true, nonStandardFdsRemainingBeforeExec: 0, kernelProbe: { tcpSocketDenied: true, udpSocketDenied: true, ipv6SocketDenied: true, syscallsDeniedWithEperm: { socket: true, socketpair: true, connect: true, sendto: true, sendmsg: true } } });
  const inputSha256 = hash(await fs.readFile(inputFile)), binding = await F.captureBinding({ jobRoot, inputSha256, sourceKey, version: R.VERSION, pid });
  const childFile = path.join(jobRoot, "preparation-failed.json"), child = { schemaVersion: 1, kind: F.KIND, status: "failed", version: R.VERSION, sourceKey, jobId: failureId, pid, jobInputSha256: inputSha256, ownerSha256: binding.ownerSha256, proofSha256: binding.proofSha256, guardSha256: binding.guardSha256, nodeSha256: binding.nodeSha256, code: row.reasonCode, errorType: "Error", frames: [
    { file: "reconstruct_keyword_monthly_source_copy.cjs", line: 15, column: 43 }, { file: "reconstruct_keyword_monthly_source_copy.cjs", line: 75, column: 38 }, { file: "reconstruct_keyword_monthly_source_copy.cjs", line: 135, column: 300 }, { file: "lib/keyword_monthly_source_copy.cjs", line: 25, column: 64 }, { file: "lib/keyword_monthly_incremental_inputs.cjs", line: 37, column: 118 }, { file: "lib/keyword_monthly_incremental_inputs.cjs", line: 61, column: 22 } ], memory: { heapUsed: 1, heapTotal: 1, rss: 1, external: 1, arrayBuffers: 1, heapSizeLimit: 1 }, progress: { phase: "final_verification", scopeIndex: null, plannedScopes: 99, completedParts: 99 }, elapsedMs: 2108880, observedAt: "2026-11-16T00:39:50.366Z", diagnosticsOnly: true }; await save(childFile, child);
  const parentFailureFile = path.join(receipts, "failed-incremental-" + sourceKey + "-" + failureId + ".json"); await save(parentFailureFile, { schemaVersion: 1, sourceKey, code: row.reasonCode, publicationIntentAbsent: true, operatingPointerChanged: false, sourceCacheRetained: true, jobRoot, observedAt: row.finishedAt, childPid: pid, childExitCode: 1, childExitSignal: null, childFailure: { status: "verified", receiptSha256: hash(await fs.readFile(childFile)), code: row.reasonCode } });
  const dbFile = path.join(dataDir, "history/collection_postprocess/runs", hash(Buffer.from(runId)) + ".json"); await save(dbFile, { runId, status: "complete", scheduleOccurrenceId: slot, finishedAt: evidence.finishedAt, result: { sourceManifestSha256: manifestSha256 } });
  for (const name of ["collector", "collector-scheduled"]) await save(path.join(dataDir, name, "jobs.json"), { version: 1, halted: null, reviewHold: null, workerLastSeenAt: NOW, jobs: [{ id: "collector_" + crypto.randomUUID(), status: "completed", leaseHash: null, leaseReleasedAt: null }] });
  await save(path.join(dataDir, "collector-web/state.json"), { version: 1, halted: null, reviewHold: null, active: null }); const postFile = path.join(dataDir, "history/collection_postprocess/queue.json"); await save(postFile, { version: 1, sequence: 1, jobs: { old: { runId: "old", status: "complete" } } });
  const code = await R.codeIdentity(), options = { mode: "inspect", dataDir, jobId, failureId, expectedJobSha256: hash(await fs.readFile(jobFile)), expectedInputSha256: inputSha256, expectedFailureSha256: hash(await fs.readFile(childFile)), expectedPublicPointerSha256: publicSha, expectedSourcePointerSha256: hash(await fs.readFile(sourcePointerFile)), expectedCodeFingerprint: code.fingerprint, now: () => NOW };
  const deps = { fixture: true, processReader: { process: async () => null, context: async () => ({ bootId: "0".repeat(36), pidNamespace: "pid:[1]", hostId: "a".repeat(64) }) } };
  const approved = async () => ({ ...options, mode: "commit", reviewSha256: (await R.retryReviewedInputChange(options, deps)).reviewSha256 });
  const otherRow = (status, version) => { const i = { ...intent, runId: "synthetic_other_run", refreshVersion: version }, id = hash(bytes([version, i.runId, i.manifestSha256, i.keyword, i.scope, i.scheduleOccurrenceId])); return { ...row, jobId: id, intent: i, status, reasonCode: status === "deferred" ? "KEYWORD_REFRESH_COLLECTION_BUSY" : null, finishedAt: status === "complete" ? row.finishedAt : null, nextAttemptAt: status === "deferred" || status === "queued" ? NOW : null }; };
  return { root, dataDir, namespace, receipts, jobRoot, jobId, sourceKey, row, jobFile, options, deps, approved, child, childFile, parentFailureFile, proofFile, inputFile, ownerFile, manifestFile, dbFile, publicPointerFile, sourcePointerFile, postFile, otherRow };
}
test("inspection is read-only and explicitly does not claim in-memory analytical idle", async t => {
  const f = await fixture(t), before = await fs.readFile(f.jobFile), entries = await fs.readdir(f.namespace), v = await R.retryReviewedInputChange(f.options, f.deps);
  assert.equal(v.status, "review_required"); assert.equal(v.changed, false); assert.equal(v.runtimeAdmission.inMemoryAnalyticalIdleVerified, false); assert.equal(v.credentialOrEnvironmentReads, 0); assert.equal(v.snapshot.failureChildAbsent, true); assert.deepEqual(await fs.readFile(f.jobFile), before); assert.deepEqual(await fs.readdir(f.namespace), entries); await absent(path.join(f.dataDir, "operations"));
});
test("reviewed retry retains exact failed bytes, same intent and existing 1/3 budget; executes no collection", async t => {
  const f = await fixture(t), originals = await Promise.all([f.jobFile, f.inputFile, f.childFile, f.parentFailureFile, f.manifestFile, f.dbFile, f.sourcePointerFile, f.publicPointerFile].map(p => fs.readFile(p))), v = await R.retryReviewedInputChange(await f.approved(), f.deps), next = JSON.parse(await fs.readFile(f.jobFile));
  assert.equal(v.status, "queued"); assert.equal(v.restartRequired, true); assert.equal(v.collectorStarted, false); assert.equal(v.providerCalls, 0); assert.equal(v.sourceWrites, 0); assert.equal(next.attempts, 1); assert.equal(next.maxAttempts, 3); assert.deepEqual(next.intent, f.row.intent); assert.equal(next.createdAt, f.row.createdAt); assert.equal(next.reasonCode, R.REASON); assert.equal(next.nextAttemptAt, NOW); assert.equal(next.finishedAt, null);
  for (const [n, name] of ["original-job.json", "original-job-input.json", "original-child-failure.json", "original-parent-failure.json"].entries()) assert.deepEqual(await fs.readFile(path.join(v.auditDir, name)), originals[n]);
  for (const [n, file] of [f.inputFile, f.childFile, f.parentFailureFile, f.manifestFile, f.dbFile, f.sourcePointerFile, f.publicPointerFile].entries()) assert.deepEqual(await fs.readFile(file), originals[n + 1]);
  assert.ok(await fs.stat(path.join(v.auditDir, "retry-complete.json"))); await absent(path.join(f.namespace, M.MAINTENANCE_FILE)); await assert.rejects(async () => R.retryReviewedInputChange(await f.approved(), f.deps));
});
for (const [name, mutate] of [["different reason", r => { r.reasonCode = "KEYWORD_INCREMENTAL_INPUTS_CHANGED"; }], ["attempt 2", r => { r.attempts = 2; }], ["budget expanded", r => { r.maxAttempts = 4; }], ["complete", r => { r.status = "complete"; }], ["different version", r => { r.intent.refreshVersion = "keyword-monthly-incremental-v4"; }], ["extra authorization", r => { r.oneShotRetry = {}; }]]) test(`${name} is ineligible`, async t => {
  const f = await fixture(t); mutate(f.row); await save(f.jobFile, f.row); f.options.expectedJobSha256 = hash(await fs.readFile(f.jobFile)); await assert.rejects(R.retryReviewedInputChange(f.options, f.deps), { code: "KEYWORD_REVIEWED_INPUT_RETRY_JOB_INELIGIBLE" }); await absent(path.join(f.dataDir, "operations"));
});
for (const [name, relative] of [["worker", "keyword_monthly_incremental/worker-lock.json"], ["recovery claim", "keyword_monthly_incremental/worker-lock-recovery-claim.json"], ["publisher", "keyword_monthly_analysis/publish.lock"]]) test(`${name} is never removed or bypassed`, async t => {
  const f = await fixture(t), file = path.join(f.dataDir, ...relative.split("/")); await save(file, { retained: true }); const before = await fs.readFile(f.jobFile); await assert.rejects(R.retryReviewedInputChange(f.options, f.deps), { code: "KEYWORD_REVIEWED_INPUT_RETRY_PUBLICATION_OR_LOCK_PRESENT" }); assert.deepEqual(await fs.readFile(f.jobFile), before); assert.deepEqual(JSON.parse(await fs.readFile(file)), { retained: true });
});
for (const prefix of ["intent-", "complete-"]) test(`uncertain ${prefix} receipt blocks retry`, async t => {
  const f = await fixture(t); await save(path.join(f.receipts, prefix + f.sourceKey + ".json"), { unknown: true }); await assert.rejects(R.retryReviewedInputChange(f.options, f.deps), { code: "KEYWORD_REVIEWED_INPUT_RETRY_PUBLICATION_OR_LOCK_PRESENT" });
});
test("preparation success receipt blocks review of a failed child", async t => { const f = await fixture(t); await save(path.join(f.jobRoot, "preparation-complete.json"), {}); await assert.rejects(R.retryReviewedInputChange(f.options, f.deps), { code: "KEYWORD_REVIEWED_INPUT_RETRY_PUBLICATION_OR_LOCK_PRESENT" }); });
for (const name of ["inputFile", "childFile", "parentFailureFile", "proofFile", "ownerFile", "manifestFile", "dbFile", "publicPointerFile", "sourcePointerFile"]) test(`changed ${name} cannot authorize mutation`, async t => {
  const f = await fixture(t), approved = await f.approved(), before = await fs.readFile(f.jobFile); await fs.appendFile(f[name], " "); await assert.rejects(R.retryReviewedInputChange(approved, f.deps)); assert.deepEqual(await fs.readFile(f.jobFile), before); await absent(path.join(f.dataDir, "operations"));
});
for (const state of ["alive", "unknown"]) test(`child ${state} holds`, async t => {
  const f = await fixture(t), processReader = { ...f.deps.processReader, process: async () => state === "alive" ? { pid: 987654 } : Promise.reject(Object.assign(Error("unavailable"), { code: "EACCES" })) };
  await assert.rejects(R.retryReviewedInputChange(f.options, { fixture: true, processReader })); await absent(path.join(f.dataDir, "operations"));
});
test("fixed code pin mismatch holds without creating audit", async t => { const f = await fixture(t); f.options.expectedCodeFingerprint = "0".repeat(64); await assert.rejects(R.retryReviewedInputChange(f.options, f.deps), { code: "KEYWORD_REVIEWED_INPUT_RETRY_CODE_CHANGED" }); await absent(path.join(f.dataDir, "operations")); });
for (const [state, version] of [["running", "old-version"], ["queued", R.VERSION], ["deferred", R.VERSION]]) test(`${state} journal work blocks retry`, async t => {
  const f = await fixture(t), row = f.otherRow(state, version === "old-version" ? "keyword-monthly-incremental-v1" : version); await save(path.join(f.dataDir, "keyword_monthly_refresh/jobs", row.jobId + ".json"), row);
  await assert.rejects(R.retryReviewedInputChange(f.options, f.deps), { code: "KEYWORD_REVIEWED_INPUT_RETRY_QUEUE_ACTIVE" });
});
test("historical deferred record remains untouched and is not current work", async t => {
  const f = await fixture(t), row = f.otherRow("deferred", "keyword-monthly-incremental-v2"), file = path.join(f.dataDir, "keyword_monthly_refresh/jobs", row.jobId + ".json"); await save(file, row); const before = await fs.readFile(file); await R.retryReviewedInputChange(await f.approved(), f.deps); assert.deepEqual(await fs.readFile(file), before);
});
for (const [kind, value] of [["broker", { version: 1, halted: null, reviewHold: null, jobs: [{ status: "running" }] }], ["protection", { version: 1, halted: { reason: "retain" }, jobs: [] }], ["web", { version: 1, halted: null, active: {} }], ["post", { version: 1, jobs: { x: { status: "running" } } }]]) test(`${kind} busy/protection is retained`, async t => {
  const f = await fixture(t), file = kind === "post" ? f.postFile : kind === "web" ? path.join(f.dataDir, "collector-web/state.json") : path.join(f.dataDir, "collector/jobs.json"); await save(file, value); const before = await fs.readFile(file); await assert.rejects(R.retryReviewedInputChange(f.options, f.deps)); assert.deepEqual(await fs.readFile(file), before);
});
test("incomplete or wrong-stage failure is not reclassified as input change", async t => {
  const f = await fixture(t); f.child.progress.phase = "prepared_results"; await save(f.childFile, f.child); f.options.expectedFailureSha256 = hash(await fs.readFile(f.childFile)); await assert.rejects(R.retryReviewedInputChange(f.options, f.deps), { code: "KEYWORD_REVIEWED_INPUT_RETRY_FAILURE_UNVERIFIED" });
});
test("pre-rename failure keeps original failed job and retained audit", async t => {
  const f = await fixture(t), approved = await f.approved(), before = await fs.readFile(f.jobFile), rename = fs.rename; t.mock.method(fs, "rename", async (a, b) => { if (b === f.jobFile) throw Object.assign(Error("private"), { code: "EIO" }); return rename(a, b); });
  await assert.rejects(R.retryReviewedInputChange(approved, f.deps), { code: "EIO" }); assert.deepEqual(await fs.readFile(f.jobFile), before); await absent(path.join(f.namespace, M.MAINTENANCE_FILE));
});
test("post-rename audit failure is uncertain and never silently restored/replayed", async t => {
  const f = await fixture(t), approved = await f.approved(), open = fs.open; t.mock.method(fs, "open", async (file, ...args) => { if (path.basename(file) === "retry-complete.json") throw Object.assign(Error("private"), { code: "ENOSPC" }); return open(file, ...args); });
  await assert.rejects(R.retryReviewedInputChange(approved, f.deps), e => e.code === "KEYWORD_REVIEWED_INPUT_RETRY_NEEDS_READBACK" && e.mutationState === "job_changed_verify_audit"); assert.equal(JSON.parse(await fs.readFile(f.jobFile)).status, "queued"); await absent(path.join(f.namespace, M.MAINTENANCE_FILE));
});
test("expired review hold is validated and preserved without unpausing anything", async t => {
  const f = await fixture(t), file = path.join(f.dataDir, "collector/jobs.json"), v = JSON.parse(await fs.readFile(file)); v.reviewHold = { holdThrough: "2026-10-10", reason: "retained history" }; await save(file, v); const before = await fs.readFile(file); await R.retryReviewedInputChange(await f.approved(), f.deps); assert.deepEqual(await fs.readFile(file), before);
});
test("active review hold cannot be reinterpreted as idle", async t => {
  const f = await fixture(t), file = path.join(f.dataDir, "collector/jobs.json"), v = JSON.parse(await fs.readFile(file)); v.reviewHold = { holdThrough: "2099-01-01" }; await save(file, v); await assert.rejects(R.retryReviewedInputChange(f.options, f.deps), { code: "KEYWORD_REVIEWED_INPUT_RETRY_COLLECTION_PROTECTED" });
});
test("held DB work remains protected and blocks commit", async t => {
  const f = await fixture(t); await save(f.postFile, { version: 1, sequence: 1, jobs: { old: { runId: "old", status: "held" } } }); await assert.rejects(R.retryReviewedInputChange(f.options, f.deps), { code: "KEYWORD_REVIEWED_INPUT_RETRY_DB_BUSY" }); await absent(path.join(f.dataDir, "operations"));
});
test("malformed terminal unrelated journal is unknown rather than idle", async t => {
  const f = await fixture(t); await save(path.join(f.dataDir, "keyword_monthly_refresh/jobs", "0".repeat(64) + ".json"), { jobId: "0".repeat(64), intent: { refreshVersion: "keyword-monthly-incremental-v1" }, status: "complete" }); await assert.rejects(R.retryReviewedInputChange(f.options, f.deps), { code: "KEYWORD_REVIEWED_INPUT_RETRY_QUEUE_UNKNOWN" });
});
test("malformed terminal broker row is unknown rather than idle", async t => {
  const f = await fixture(t); await save(path.join(f.dataDir, "collector/jobs.json"), { version: 1, halted: null, reviewHold: null, jobs: [{ status: "completed" }] }); await assert.rejects(R.retryReviewedInputChange(f.options, f.deps)); await absent(path.join(f.dataDir, "operations"));
});
for (const replace of [false, true]) test(`concurrent ${replace ? "inode replacement" : "byte mutation"} is not overwritten`, async t => {
  const f = await fixture(t), approved = await f.approved(), open = fs.open; let changed = false, retained;
  t.mock.method(fs, "open", async (file, ...args) => {
    if (!changed && path.basename(file) === "planned-job.json" && args[0] === "wx") { changed = true; retained = replace ? await fs.readFile(f.jobFile) : bytes({ ...f.row, updatedAt: NOW }); if (replace) await fs.rename(f.jobFile, path.join(f.root, "retained-original-job.json")); await fs.writeFile(f.jobFile, retained, { mode: 0o600 }); }
    return open(file, ...args);
  });
  await assert.rejects(R.retryReviewedInputChange(approved, f.deps), { code: "KEYWORD_REVIEWED_INPUT_RETRY_CHANGED" }); assert.deepEqual(await fs.readFile(f.jobFile), retained); await absent(path.join(f.namespace, M.MAINTENANCE_FILE));
});
test("a normally reloaded worker consumes attempt 2 within max 3", async t => {
  const f = await fixture(t); await R.retryReviewedInputChange(await f.approved(), f.deps); let attempt;
  const q = require("./lib/keyword_monthly_refresh.cjs").createKeywordMonthlyRefresh({ dataDir: f.dataDir, refreshVersion: R.VERSION, readCompletedEvidence: async () => JSON.parse(await fs.readFile(f.inputFile)).evidence, refresh: async (_e, _i, context) => { attempt = context.attempt; return { status: "published", generation: "1".repeat(32), providerCalls: 0 }; } });
  try { const result = await q.runOnce(); assert.equal(attempt, 2); assert.equal(result.status, "complete"); const row = JSON.parse(await fs.readFile(f.jobFile)); assert.equal(row.attempts, 2); assert.equal(row.maxAttempts, 3); assert.equal(Object.hasOwn(row, "oneShotRetry"), false); } finally { await q.close(); }
});
function stagedStat(mode, extra = {}) { return { mode, uid: 0, gid: 1000, nlink: 1, size: 1000, isSymbolicLink: () => false, isDirectory: () => true, isFile: () => false, ...extra }; }
const STAGED_V2 = "/var/data/operations/monthly-queue-normalization-20261116/retry-reviewed-input-change-v2.cjs";
for (const [name, file, st, allowed] of [
  ["exact root-owned Render mount", "/var/data", stagedStat(0o2775), true],
  ["conservative nonwritable mount remains valid", "/var/data", stagedStat(0o755), true],
  ["other primary group", "/var/data", stagedStat(0o2775, { gid: 999 }), false],
  ["service-owned group-writable mount", "/var/data", stagedStat(0o2775, { uid: 1000 }), false],
  ["foreign owner", "/var/data", stagedStat(0o2775, { uid: 999 }), false],
  ["missing setgid", "/var/data", stagedStat(0o775), false],
  ["world writable mount", "/var/data", stagedStat(0o2777), false],
  ["sticky mount", "/var/data", stagedStat(0o3775), false],
  ["setuid mount", "/var/data", stagedStat(0o6775), false],
  ["similar prefix", "/var/database", stagedStat(0o2775), false],
  ["operations parent group write", "/var/data/operations", stagedStat(0o2775), false],
  ["own operations parent group write", "/var/data/operations/monthly-queue-normalization-20261116", stagedStat(0o2775, { uid: 1000 }), false],
  ["code parent group write", "/opt/render/project/src/scripts", stagedStat(0o2775), false],
  ["mount symlink", "/var/data", stagedStat(0o2775, { isSymbolicLink: () => true }), false],
  ["mount non-directory", "/var/data", stagedStat(0o2775, { isDirectory: () => false, isFile: () => true }), false],
  ["exact private tool", STAGED_V2, stagedStat(0o600, { uid: 1000, isDirectory: () => false, isFile: () => true }), true],
  ["group-writable tool", STAGED_V2, stagedStat(0o660, { uid: 1000, isDirectory: () => false, isFile: () => true }), false],
  ["hardlinked tool", STAGED_V2, stagedStat(0o600, { uid: 1000, nlink: 2, isDirectory: () => false, isFile: () => true }), false],
  ["setgid tool", STAGED_V2, stagedStat(0o2600, { uid: 1000, isDirectory: () => false, isFile: () => true }), false],
  ["oversize tool", STAGED_V2, stagedStat(0o600, { uid: 1000, size: 65537, isDirectory: () => false, isFile: () => true }), false]
]) test(`fixed staged path predicate: ${name}`, () => assert.equal(R.stagedPathStatAllowed(file, st, 1000, 1000), allowed));
