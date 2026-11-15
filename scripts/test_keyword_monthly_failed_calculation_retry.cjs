"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs/promises"), path = require("node:path"), os = require("node:os"), crypto = require("node:crypto"), zlib = require("node:zlib");
const R = require("./retry_keyword_monthly_failed_calculation.cjs"), A = require("./lib/keyword_monthly_failed_retry_authorization.cjs"), H = require("./lib/keyword_monthly_refresh_preparation.cjs"), M = require("./lib/keyword_monthly_maintenance.cjs");
const NOW = "2026-11-16T01:00:00.000Z", bytes = v => Buffer.from(JSON.stringify(v)), hash = H.hash;
async function save(file, value) { await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 }); await fs.writeFile(file, bytes(value), { mode: 0o600 }); }
async function absent(file) { await assert.rejects(fs.lstat(file), { code: "ENOENT" }); }
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "failed-derived-retry-")); t.after(async () => {
    const resolved = await fs.realpath(root); assert.equal(path.dirname(resolved), await fs.realpath(os.tmpdir()));
    assert.match(path.basename(resolved), /^failed-derived-retry-/); await fs.rm(resolved, { recursive: true, force: true }); });
  const dataDir = path.join(root, "data"), namespace = path.join(dataDir, "keyword_monthly_incremental"), runId = "synthetic_complete_run", keyword = "synthetic_keyword", generation = "a".repeat(32);
  const manifestFile = path.join(dataDir, "outputs", runId, "manifest.json"); await save(manifestFile, { keyword, collectionQuality: { status: "complete" } });
  const manifestSha256 = hash(await fs.readFile(manifestFile)), intent = { runId, keyword, manifestSha256, scheduleOccurrenceId: null, scope: keyword, refreshVersion: R.VERSION };
  const jobId = hash(bytes([R.VERSION, runId, manifestSha256, keyword, keyword, null])), sourceKey = hash(bytes([R.VERSION, runId, manifestSha256, keyword])), failureId = crypto.randomUUID();
  const row = { schemaVersion: 1, jobId, intent, status: "needs_verification", reasonCode: "KEYWORD_PREP_CHILD_FAILED", createdAt: "2026-11-15T14:00:00.000Z", updatedAt: "2026-11-15T16:01:46.610Z",
    startedAt: "2026-11-15T15:00:00.000Z", finishedAt: "2026-11-15T16:01:46.610Z", nextAttemptAt: null, recoveredAt: null, attempts: 3, maxAttempts: 3, result: null };
  const jobFile = path.join(dataDir, "keyword_monthly_refresh/jobs", jobId + ".json"); await save(jobFile, row);
  const catalogFile = path.join(dataDir, "keyword_monthly_analysis/generations", generation, "catalog.json"), catalog = { schemaVersion: 1, kind: "keyword_monthly_partition_bundle", createdAt: row.createdAt, partitions: [], scopes: [] }; await save(catalogFile, catalog);
  const pointer = { schemaVersion: 1, generation, catalogSha256: hash(await fs.readFile(catalogFile)), catalogBytes: bytes(catalog).length, publishedAt: row.createdAt }, pointerFile = path.join(dataDir, "keyword_monthly_analysis/current.json"); await save(pointerFile, pointer);
  const publicSha = hash(await fs.readFile(pointerFile)), publicationFile = path.join(path.dirname(catalogFile), "publication-receipt.json");
  await save(publicationFile, { schemaVersion: 1, status: "published", generation, pointerSha256: publicSha, catalogSha256: pointer.catalogSha256, fixedValidationClock: row.createdAt,
    sourceProvenancePreserved: true, originalEnvelopesRewritten: false, providerCalls: 0, collectorStarted: false, kosisReadOrChanged: false, semanticPrevalidationSha256: "b".repeat(64) });
  const jobRoot = path.join(namespace, "jobs", "refresh-job-" + failureId), inputFile = path.join(jobRoot, "job-input.json"), evidence = { runId, keyword, manifestSha256, scheduleOccurrenceId: null, finishedAt: "2026-11-15T13:59:00.000Z" };
  await save(inputFile, { schemaVersion: 1, version: R.VERSION, dataDir, evidence, initialBundle: { generation, pointerSha256: publicSha, catalogSha256: pointer.catalogSha256 } });
  const proofFile = path.join(jobRoot, "control/isolation.json"), proof = { mode: "seccomp", noNewPrivs: true, seccompMode: 2, networkFdsClosed: true, expectedRoot: jobRoot, preflightOnly: false,
    environmentSanitizedForExec: true, unrestrictedFallbackAllowed: false, providerCalls: 0, guardSha256: "0".repeat(64), nodeSha256: "1".repeat(64), pid: 162,
    kernelProbe: { tcpSocketDenied: true, udpSocketDenied: true, ipv6SocketDenied: true, syscallsDeniedWithEperm: Object.fromEntries(["socket", "socketpair", "connect", "sendto", "sendmsg"].map(k => [k, true])) }, nonStandardFdsClosedBeforeExec: true, nonStandardFdsRemainingBeforeExec: 0 }; await save(proofFile, proof);
  const failureFile = path.join(dataDir, "keyword_monthly_analysis/refresh-receipts", "failed-incremental-" + sourceKey + "-" + failureId + ".json");
  await save(failureFile, { schemaVersion: 1, sourceKey, code: row.reasonCode, publicationIntentAbsent: true, operatingPointerChanged: false, sourceCacheRetained: true, jobRoot, observedAt: row.finishedAt });
  const dbFile = path.join(dataDir, "history/collection_postprocess/runs", hash(Buffer.from(runId)) + ".json"); await save(dbFile, { runId, status: "complete", finishedAt: evidence.finishedAt, result: { sourceManifestSha256: manifestSha256 } });
  const stamp = { dev: "1", ino: "1", size: "0", mtimeNs: "1", ctimeNs: "1", nlink: "1" };
  const state = { schemaVersion: 1, version: "keyword-monthly-incremental-state-v1", generation: 1, companies: [], appliedEvents: [], dirtyCompanyIds: [], dirtyMonths: [],
    sourceStamps: { company: stamp, history: stamp }, bootstrapSources: Object.fromEntries(["company", "history"].map(k => [k, { sha256: hash(Buffer.alloc(0)), bytes: 0, sourceStamp: stamp }])),
    history: require("./lib/keyword_monthly_incremental_history.cjs").empty(), lastPublished: { stateSha256: "c".repeat(64), sourceKey: "d".repeat(64), generation, pointerSha256: publicSha } };
  const stateRaw = bytes(state), compressed = zlib.gzipSync(stateRaw), stateSha = hash(stateRaw), stateFile = path.join(namespace, "states", stateSha + ".json.gz");
  await fs.mkdir(path.dirname(stateFile), { recursive: true, mode: 0o700 }); await fs.writeFile(stateFile, compressed, { mode: 0o600 });
  const sourceFile = path.join(namespace, "source-current.json"); await save(sourceFile, { schemaVersion: 1, version: state.version, stateSha256: stateSha, compression: "gzip", storageSha256: hash(compressed), storageBytes: compressed.length, rawBytes: stateRaw.length, generation: 1, createdAt: NOW });
  const options = { mode: "inspect", dataDir, jobId, expectedJobSha256: hash(await fs.readFile(jobFile)), failureId, expectedFailureSha256: hash(await fs.readFile(failureFile)), expectedPublicPointerSha256: publicSha, expectedSourcePointerSha256: hash(await fs.readFile(sourceFile)), now: () => NOW };
  let calls = 0; const dependencies = { fixture: true, admit: async () => { calls++; return { idle: true, authenticatedLoopbackOnly: true }; } };
  async function approved() { return { ...options, mode: "commit", reviewSha256: (await R.retryFailedCalculation(options, dependencies)).reviewSha256 }; }
  return { root, dataDir, namespace, row, jobFile, options, dependencies, approved, manifestFile, dbFile, inputFile, proofFile, proof, failureFile, pointerFile, sourceFile, stateFile, publicationFile, calls: () => calls };
}
function queue(f, refresh) { return require("./lib/keyword_monthly_refresh.cjs").createKeywordMonthlyRefresh({ dataDir: f.dataDir, refreshVersion: R.VERSION, now: () => new Date(NOW),
  readCompletedEvidence: async i => ({ ...i, status: "complete", quality: "complete", postprocessStatus: "complete" }), refresh }); }
test("inspection pins failed source and current last-success publication without writing or admitting work", async t => {
  const f = await fixture(t), before = await fs.readFile(f.jobFile), r = await R.retryFailedCalculation(f.options, f.dependencies);
  assert.equal(r.status, "review_required"); assert.equal(r.snapshot.attempts, 3); assert.equal(r.snapshot.authorizedAttempt, 4); assert.equal(f.calls(), 0);
  assert.deepEqual(await fs.readFile(f.jobFile), before); await absent(path.join(f.dataDir, "operations"));
});
test("reviewed commit preserves failed bytes and counters, verifies private authorization and starts no worker", async t => {
  const f = await fixture(t), before = await fs.readFile(f.jobFile), protectedFiles = [f.manifestFile, f.dbFile, f.inputFile, f.proofFile, f.failureFile, f.pointerFile, f.sourceFile, f.stateFile, f.publicationFile], protectedBytes = await Promise.all(protectedFiles.map(x => fs.readFile(x)));
  const result = await R.retryFailedCalculation(await f.approved(), f.dependencies), next = JSON.parse(await fs.readFile(f.jobFile));
  assert.equal(result.status, "queued"); assert.equal(result.restartRequired, true); assert.equal(result.providerCalls, 0); assert.equal(result.collectorStarted, false); assert.equal(f.calls(), 3);
  assert.equal(next.attempts, 3); assert.equal(next.maxAttempts, 3); assert.equal(next.createdAt, f.row.createdAt); assert.deepEqual(next.intent, f.row.intent); assert.equal(next.reasonCode, A.REASON);
  assert.deepEqual(await fs.readFile(path.join(result.auditDir, "original-job.json")), before); assert.equal((await A.verifyAuthorization({ dataDir: f.dataDir, row: next })).authorizedAttempt, 4);
  for (let n = 0; n < protectedFiles.length; n++) assert.deepEqual(await fs.readFile(protectedFiles[n]), protectedBytes[n]);
  await absent(path.join(f.namespace, M.MAINTENANCE_FILE)); await assert.rejects(R.retryFailedCalculation(f.options, f.dependencies), /CHANGED|ELIGIBLE/);
});
test("actual queue executes only explicit fourth attempt while max3 remains and persists successful result", async t => {
  const f = await fixture(t); await R.retryFailedCalculation(await f.approved(), f.dependencies); let calls = 0;
  const q = queue(f, async (proof, intent, work) => { calls++; assert.equal(work.attempt, 4); return { status: "complete", providerCalls: 0 }; }); t.after(() => q.close());
  const r = await q.runOnce(); assert.equal(r.status, "complete"); assert.equal(r.attempts, 4); assert.equal(r.maxAttempts, 3); assert.equal(calls, 1); assert.equal(await q.runOnce(), null);
  await q.close(); const cold = queue(f, async () => assert.fail("no fifth attempt")); t.after(() => cold.close()); assert.equal((await cold.status()).items[0].attempts, 4); assert.equal(await cold.runOnce(), null);
});
for (const deferred of [false, true]) test(`fourth attempt ${deferred ? "deferral" : "retryable failure"} cannot automatically schedule fifth`, async t => {
  const f = await fixture(t); await R.retryFailedCalculation(await f.approved(), f.dependencies); let calls = 0;
  const q = queue(f, async () => { calls++; throw Object.assign(Error("private payload"), { code: "KEYWORD_PREP_CHILD_FAILED", retryable: true, ...(deferred ? { deferred: true } : {}) }); }); t.after(() => q.close());
  const r = await q.runOnce(); assert.equal(r.status, "needs_verification"); assert.equal(r.attempts, 4); assert.equal(r.maxAttempts, 3); assert.equal(r.nextAttemptAt, null); assert.equal(await q.runOnce(), null); assert.equal(calls, 1);
});
test("fourth attempt interrupted at restart is held and never silently executed again", async t => {
  const f = await fixture(t); await R.retryFailedCalculation(await f.approved(), f.dependencies); const row = JSON.parse(await fs.readFile(f.jobFile));
  await save(f.jobFile, { ...row, status: "running", attempts: 4, startedAt: NOW, nextAttemptAt: null });
  const q = queue(f, async () => assert.fail("no resumed fifth")); t.after(() => q.close()); assert.equal(await q.runOnce(), null); const r = (await q.status()).items[0]; assert.equal(r.status, "needs_verification"); assert.equal(r.reasonCode, "KEYWORD_REFRESH_INTERRUPTED_EXHAUSTED"); assert.equal(r.attempts, 4);
});
test("forged small metadata without immutable authorization cannot execute saved-source callback", async t => {
  const f = await fixture(t), identity = await A.codeIdentity(); await save(f.jobFile, { ...f.row, status: "queued", reasonCode: A.REASON, nextAttemptAt: NOW,
    oneShotRetry: { schemaVersion: 1, kind: A.KIND, codeFingerprint: identity.fingerprint, reviewSha256: "a".repeat(64), originalJobSha256: f.options.expectedJobSha256, authorizationSha256: "b".repeat(64) } });
  const q = queue(f, async () => assert.fail("forged authorization")); t.after(() => q.close()); const result = await q.runOnce(); assert.equal(result.status, "needs_verification"); assert.equal((await q.status()).items[0].attempts, 3);
  assert.equal(JSON.parse(await fs.readFile(f.jobFile)).status, "needs_verification"); assert.equal(result.nextAttemptAt, null); assert.equal(await q.runOnce(), null);
});
for (const target of ["original-job.json", "authorization.json", "reviewed-preflight.json"]) test(`changed immutable ${target} stops fourth attempt`, async t => {
  const f = await fixture(t), result = await R.retryFailedCalculation(await f.approved(), f.dependencies); await fs.appendFile(path.join(result.auditDir, target), " ");
  const q = queue(f, async () => assert.fail("changed authorization")); t.after(() => q.close()); assert.equal((await q.runOnce()).status, "needs_verification"); assert.equal((await q.status()).items[0].attempts, 3);
  assert.equal(JSON.parse(await fs.readFile(f.jobFile)).status, "needs_verification"); assert.equal(await q.runOnce(), null);
});
test("current deployed code fingerprint change atomically holds queued retry without executing or polling it again", async t => {
  const f = await fixture(t); await R.retryFailedCalculation(await f.approved(), f.dependencies); const originalRead = fs.readFile;
  t.mock.method(fs, "readFile", async (file, ...args) => { const raw = await originalRead(file, ...args); return path.basename(file) === "keyword_monthly_incremental_failure.cjs" ? Buffer.concat([raw, Buffer.from("\n// synthetic changed code\n")]) : raw; });
  const q = queue(f, async () => assert.fail("changed calculation code")); t.after(() => q.close()); const r = await q.runOnce();
  assert.equal(r.status, "needs_verification"); assert.equal(r.reasonCode, "KEYWORD_FAILED_RETRY_CODE_CHANGED"); assert.equal(r.attempts, 3); assert.equal(r.nextAttemptAt, null); assert.equal(await q.runOnce(), null);
});
test("authorization changed while admission awaits is rechecked before consuming attempt", async t => {
  const f = await fixture(t), result = await R.retryFailedCalculation(await f.approved(), f.dependencies);
  const q = require("./lib/keyword_monthly_refresh.cjs").createKeywordMonthlyRefresh({ dataDir: f.dataDir, refreshVersion: R.VERSION, now: () => new Date(NOW),
    canProcess: async () => { await fs.appendFile(path.join(result.auditDir, "authorization.json"), " "); return true; },
    readCompletedEvidence: async i => ({ ...i, status: "complete", quality: "complete", postprocessStatus: "complete" }), refresh: async () => assert.fail("late changed auth") }); t.after(() => q.close());
  const row = await q.runOnce(); assert.equal(row.status, "needs_verification"); assert.equal(row.attempts, 3); assert.equal(await q.runOnce(), null);
});
test("same failed job and code cannot be reauthorized even if original failed bytes are restored", async t => {
  const f = await fixture(t), original = await fs.readFile(f.jobFile), approved = await f.approved(), result = await R.retryFailedCalculation(approved, f.dependencies);
  const auth = await fs.readFile(path.join(result.auditDir, "authorization.json")); await fs.writeFile(f.jobFile, original);
  await assert.rejects(R.retryFailedCalculation(f.options, f.dependencies), { code: "KEYWORD_FAILED_RETRY_ALREADY_REVIEWED" }); assert.deepEqual(await fs.readFile(path.join(result.auditDir, "authorization.json")), auth);
});
test("queueing one reviewed job preserves unrelated historical job bytes", async t => {
  const f = await fixture(t), unrelated = structuredClone(f.row); unrelated.intent.runId = "unrelated_preserved"; unrelated.jobId = hash(bytes([R.VERSION, unrelated.intent.runId, unrelated.intent.manifestSha256, unrelated.intent.keyword, unrelated.intent.scope, null]));
  const file = path.join(path.dirname(f.jobFile), unrelated.jobId + ".json"); await save(file, unrelated); const before = await fs.readFile(file);
  await R.retryFailedCalculation(await f.approved(), f.dependencies); assert.deepEqual(await fs.readFile(file), before);
});
test("changed review SHA and replacement original inode are never accepted", async t => {
  const f = await fixture(t), approved = await f.approved(), before = await fs.readFile(f.jobFile);
  await assert.rejects(R.retryFailedCalculation({ ...approved, reviewSha256: "0".repeat(64) }, f.dependencies), { code: "KEYWORD_FAILED_RETRY_REVIEW_MISMATCH" });
  await fs.rename(f.jobFile, path.join(f.root, "old-job.json")); await fs.writeFile(f.jobFile, before, { mode: 0o600 });
  await assert.rejects(R.retryFailedCalculation(approved, f.dependencies), { code: "KEYWORD_FAILED_RETRY_REVIEW_MISMATCH" });
});
test("post-rename audit failure preserves queued intent and reports uncertain readback instead of silently retrying", async t => {
  const f = await fixture(t), approved = await f.approved(), open = fs.open;
  t.mock.method(fs, "open", async (file, ...args) => { if (path.basename(file) === "retry-complete.json") throw Object.assign(Error("private disk path"), { code: "ENOSPC" }); return open(file, ...args); });
  await assert.rejects(R.retryFailedCalculation(approved, f.dependencies), e => e.code === "KEYWORD_FAILED_RETRY_NEEDS_READBACK" && e.mutationState === "job_changed_verify_audit");
  assert.equal(JSON.parse(await fs.readFile(f.jobFile)).status, "queued"); await absent(path.join(f.namespace, M.MAINTENANCE_FILE));
});
test("invalid CLI input prints one controlled JSON record without stack or arbitrary input", async () => {
  const { spawnSync } = require("node:child_process"), result = spawnSync(process.execPath, [path.join(__dirname, "retry_keyword_monthly_failed_calculation.cjs"), "--private-token", "never-print-this-value"], { encoding: "utf8", env: {} });
  assert.equal(result.status, 1); assert.equal(result.stderr, ""); assert.deepEqual(JSON.parse(result.stdout), { status: "hold", code: "KEYWORD_FAILED_RETRY_OPTIONS_INVALID" });
});
for (const [name, file] of [["manifest", "manifestFile"], ["postprocess", "dbFile"], ["failure receipt", "failureFile"], ["source pointer", "sourceFile"], ["public pointer", "pointerFile"], ["publication receipt", "publicationFile"]]) test(`changed ${name} after review prevents mutation`, async t => {
  const f = await fixture(t), approved = await f.approved(), before = await fs.readFile(f.jobFile); await fs.appendFile(f[file], " ");
  await assert.rejects(R.retryFailedCalculation(approved, f.dependencies)); assert.deepEqual(await fs.readFile(f.jobFile), before); await absent(path.join(f.dataDir, "operations"));
});
for (const name of ["worker", "claim", "publish", "intent", "complete", "preparedComplete"]) test(`${name} presence makes retry hold`, async t => {
  const f = await fixture(t), source = R.failedJob(f.row, f.row.jobId), file = name === "worker" ? path.join(f.namespace, "worker-lock.json") : name === "claim" ? path.join(f.namespace, "worker-lock-recovery-claim.json")
    : name === "publish" ? path.join(f.dataDir, "keyword_monthly_analysis/publish.lock") : name === "preparedComplete" ? path.join(path.dirname(f.inputFile), "preparation-complete.json")
    : path.join(f.dataDir, "keyword_monthly_analysis/refresh-receipts", name + "-" + source + ".json"); await save(file, {});
  await assert.rejects(R.retryFailedCalculation(f.options, f.dependencies), { code: "KEYWORD_FAILED_RETRY_PUBLICATION_OR_LOCK_PRESENT" });
});
test("unchanged guard requires explicit controlled diagnostic purpose for a prior generic child failure", async t => {
  const f = await fixture(t); f.proof.guardSha256 = (await A.codeIdentity()).guardSha256; await save(f.proofFile, f.proof);
  await assert.rejects(R.retryFailedCalculation(f.options, f.dependencies), { code: "KEYWORD_FAILED_RETRY_CODE_UNCHANGED" });
  assert.equal((await R.retryFailedCalculation({ ...f.options, diagnosticPurpose: "diagnose_prior_generic_child_failure" }, f.dependencies)).status, "review_required");
});
test("unknown runtime preflight or final idle state cannot queue a retry", async t => {
  for (const failAt of [1, 3]) { const f = await fixture(t), approved = await f.approved(), before = await fs.readFile(f.jobFile); let n = 0;
    await assert.rejects(R.retryFailedCalculation(approved, { fixture: true, admit: async () => ({ idle: ++n !== failAt, authenticatedLoopbackOnly: true }) }), { code: "KEYWORD_FAILED_RETRY_RUNTIME_UNVERIFIED" });
    assert.deepEqual(await fs.readFile(f.jobFile), before); await absent(path.join(f.namespace, M.MAINTENANCE_FILE)); }
});
test("strict scope refuses altered max, prior one-shot, different error, wrong version and unknown options", async t => {
  for (const mutate of [r => { r.maxAttempts = 4; }, r => { r.attempts = 2; }, r => { r.oneShotRetry = {}; }, r => { r.reasonCode = "KEYWORD_INCREMENTAL_WORKER_LOCKED"; }, r => { r.intent.refreshVersion = "keyword-monthly-incremental-v4"; }]) {
    const f = await fixture(t); mutate(f.row); await save(f.jobFile, f.row); f.options.expectedJobSha256 = hash(await fs.readFile(f.jobFile)); await assert.rejects(R.retryFailedCalculation(f.options, f.dependencies), { code: "KEYWORD_FAILED_RETRY_JOB_NOT_ELIGIBLE" }); }
  const f = await fixture(t); await assert.rejects(R.retryFailedCalculation({ ...f.options, resetAttempts: true }, f.dependencies), { code: "KEYWORD_FAILED_RETRY_OPTIONS_INVALID" });
});
test("ordinary exhausted record remains rejected before execution without explicit one-shot contract", async t => {
  const f = await fixture(t); await save(f.jobFile, { ...f.row, status: "queued", nextAttemptAt: NOW }); const q = queue(f, async () => assert.fail("ordinary exhausted job")); t.after(() => q.close());
  const r = await q.runOnce(); assert.equal(r.status, "needs_verification"); assert.equal(r.errorCode, "KEYWORD_REFRESH_RECORD_INVALID");
});
