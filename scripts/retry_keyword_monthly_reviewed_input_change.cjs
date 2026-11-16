"use strict";
// One explicitly reviewed, saved-source retry within the existing attempt
// budget. This tool never executes a collector, publisher, provider, API,
// application entry or credential/environment reader. It does not clear locks.
const fs = require("node:fs/promises"), native = require("node:fs"), C = native.constants, path = require("node:path"), crypto = require("node:crypto");
const STAGED_FILE = "/var/data/operations/monthly-queue-normalization-20261116/retry-reviewed-input-change-v2.cjs", STAGED = __filename === STAGED_FILE;
const CODE_ROOT = STAGED ? "/opt/render/project/src/scripts" : __dirname;
function stagedPathStatAllowed(file, st, uid, gid) {
  if (st.isSymbolicLink() || st.uid !== 0 && st.uid !== uid) return false;
  // Render's reviewed, fixed persistent mount is root-owned and setgid to this
  // service's primary group. This exact mount exception never applies to an
  // operations directory, a code directory, a different group or a tool file.
  const reviewedMount = file === "/var/data" && st.uid === 0 && st.gid === gid && (st.mode & 0o7777) === 0o2775 && st.isDirectory();
  if ((st.mode & 0o022) !== 0 && !reviewedMount) return false;
  return file === STAGED_FILE ? st.isFile() && st.nlink === 1 && (st.mode & 0o7777) === 0o600 && st.size > 0 && st.size <= 65536 : st.isDirectory();
}
function stagedPathIdentity() {
  if (!STAGED) return [];
  let current = path.parse(STAGED_FILE).root; const pins = [];
  for (const part of STAGED_FILE.slice(current.length).split(path.sep)) { current = path.join(current, part); const st = native.lstatSync(current);
    if (!stagedPathStatAllowed(current, st, process.getuid(), process.getgid()) || native.realpathSync(current) !== current) throw Object.assign(Error("KEYWORD_REVIEWED_INPUT_RETRY_STAGED_SCOPE"), { code: "KEYWORD_REVIEWED_INPUT_RETRY_STAGED_SCOPE" });
    pins.push({ file: current, dev: String(st.dev), ino: String(st.ino), mode: st.mode & 0o7777, uid: st.uid, gid: st.gid });
  }
  return pins;
}
if (STAGED) stagedPathIdentity();
const H = require(path.join(CODE_ROOT, "lib/keyword_monthly_refresh_preparation.cjs")), F = require(path.join(CODE_ROOT, "lib/keyword_monthly_incremental_failure.cjs")), S = require(path.join(CODE_ROOT, "verify_keyword_monthly_production_preservation.cjs"));
const VERSION = "keyword-monthly-incremental-v5", REASON = "KEYWORD_INCREMENTAL_REVIEWED_INPUT_CHANGE_RETRY", UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const TARGET = Object.freeze({ jobId: "6dd14a6faef3e1503651fece7f7807f3d22df246dfd4c7f0eaf343ab11e84dff", runId: "chungnam_web_eobkmcclglalekgdolalokbc_glamping_20261116_090007", keyword: "충남글램핑", slotId: "rotation_2026-11-16_1", manifestSha256: "383ee821d50014c99ace84b3e53fefa1fc3d1715fb15ef2a2feb90bf36ada5b6", inputSha256: "74be3842caf0edf095ba3e56944aaa2e014d28e521bf61e88562d30022717047", failureSha256: "b073840e0f69742f32684a9dcb34c0563eab2c101405a97da1b26c9f885c79c5" });
const CODE_FILES = Object.freeze(["retry_keyword_monthly_reviewed_input_change.cjs", "reconstruct_keyword_monthly_incremental.cjs", "reconstruct_keyword_monthly_source_copy.cjs", "refresh_keyword_monthly_incremental.cjs", "launch_keyword_monthly_isolated.py", "verify_keyword_monthly_production_preservation.cjs", ...["keyword_monthly_refresh_preparation.cjs", "keyword_monthly_incremental_inputs.cjs", "keyword_monthly_source_copy.cjs", "keyword_monthly_incremental_failure.cjs", "keyword_monthly_readonly_outputs.cjs", "keyword_monthly_maintenance.cjs", "keyword_monthly_worker_lock.cjs", "keyword_monthly_refresh.cjs", "keyword_monthly_failed_retry_authorization.cjs", "keyword_monthly_historical_review.cjs"].map(x => "lib/" + x)]);
const bytes = v => Buffer.from(JSON.stringify(v)), need = (v, c = "KEYWORD_REVIEWED_INPUT_RETRY_HOLD") => H.need(v, c);
const exact = (v, ks) => v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === ks.length && ks.every(k => Object.hasOwn(v, k));
async function read(file, maximum = 8192) {
  const stat = await H.checked(file); need(stat.size > 0 && stat.size <= maximum, "KEYWORD_REVIEWED_INPUT_RETRY_READ_BOUND");
  const h = await fs.open(file, C.O_RDONLY | (C.O_NOFOLLOW || 0)); let raw;
  try { need(H.same(stat, await h.stat()), "KEYWORD_REVIEWED_INPUT_RETRY_CHANGED"); const b = Buffer.alloc(stat.size + 1); let at = 0;
    while (at < b.length) { const r = await h.read(b, at, b.length - at, at); if (!r.bytesRead) break; at += r.bytesRead; }
    need(at === stat.size && H.same(stat, await h.stat()), "KEYWORD_REVIEWED_INPUT_RETRY_CHANGED"); raw = b.subarray(0, at);
  } finally { await h.close(); }
  need(H.same(stat, await H.checked(file)), "KEYWORD_REVIEWED_INPUT_RETRY_CHANGED"); let value;
  try { value = JSON.parse(raw); } catch { throw H.fault("KEYWORD_REVIEWED_INPUT_RETRY_JSON_INVALID"); }
  return { file, stat, bytes: raw, value, sha256: H.hash(raw) };
}
async function absent(file) { try { await fs.lstat(file); return false; } catch (e) { if (e.code === "ENOENT") return true; throw e; } }
async function privateDir(file, fixture, create = false) {
  if (create) try { await fs.mkdir(file, { mode: 0o700 }); } catch (e) { if (e.code !== "EEXIST") throw e; }
  const st = await H.checked(file, true); need(fixture && process.platform === "win32" || st.uid === process.getuid() && (st.mode & 0o777) === 0o700, "KEYWORD_REVIEWED_INPUT_RETRY_PRIVATE_SCOPE"); return st;
}
async function syncDir(file) { if (process.platform !== "win32") { const h = await fs.open(file, C.O_RDONLY); try { await h.sync(); } finally { await h.close(); } } }
async function archiveExact(file, destination, expectedSha256, maximum) {
  const original = await read(file, maximum); need(original.sha256 === expectedSha256, "KEYWORD_REVIEWED_INPUT_RETRY_CHANGED");
  const h = await fs.open(destination, "wx", 0o600); try { await h.writeFile(original.bytes); await h.sync(); } finally { await h.close(); }
  need((await read(destination, maximum)).sha256 === expectedSha256, "KEYWORD_REVIEWED_INPUT_RETRY_AUDIT_READBACK");
}
async function codeIdentity() {
  const root = path.resolve(CODE_ROOT), pins = [];
  for (const relative of CODE_FILES) { const file = relative === CODE_FILES[0] ? __filename : path.join(root, ...relative.split("/")), st = await H.checked(file); need(st.size > 0 && st.size <= 2 * 1024 * 1024, "KEYWORD_REVIEWED_INPUT_RETRY_CODE_BOUND");
    const raw = await fs.readFile(file); need(H.same(st, await H.checked(file)), "KEYWORD_REVIEWED_INPUT_RETRY_CODE_CHANGED"); pins.push({ file: relative, sha256: H.hash(raw.toString("utf8").replace(/\r\n/g, "\n")) }); }
  const self = await H.checked(__filename), raw = await fs.readFile(__filename); need(H.same(self, await H.checked(__filename)), "KEYWORD_REVIEWED_INPUT_RETRY_CODE_CHANGED");
  return { fingerprint: H.hash(bytes(pins)), executedToolSha256: H.hash(raw), stagedPathIdentity: stagedPathIdentity(), pins };
}
function optionsFor(o, fixture) {
  need(o && Object.keys(o).every(k => ["mode", "dataDir", "jobId", "failureId", "expectedJobSha256", "expectedInputSha256", "expectedFailureSha256", "expectedPublicPointerSha256", "expectedSourcePointerSha256", "expectedCodeFingerprint", "reviewSha256", "now"].includes(k)), "KEYWORD_REVIEWED_INPUT_RETRY_OPTIONS");
  H.absolute(o.dataDir); need(fixture || process.platform === "linux" && o.dataDir === "/var/data", "KEYWORD_REVIEWED_INPUT_RETRY_CONTEXT");
  need(fixture || o.now === undefined, "KEYWORD_REVIEWED_INPUT_RETRY_CONTEXT");
  need(["inspect", "commit"].includes(o.mode) && UUID.test(o.failureId || "") && ["jobId", "expectedJobSha256", "expectedInputSha256", "expectedFailureSha256", "expectedPublicPointerSha256", "expectedSourcePointerSha256", "expectedCodeFingerprint"].every(k => H.SHA.test(o[k] || ""))
    && (o.mode === "inspect" ? o.reviewSha256 === undefined : H.SHA.test(o.reviewSha256 || "")), "KEYWORD_REVIEWED_INPUT_RETRY_OPTIONS");
  if (!fixture) need(o.jobId === TARGET.jobId && o.expectedInputSha256 === TARGET.inputSha256 && o.expectedFailureSha256 === TARGET.failureSha256, "KEYWORD_REVIEWED_INPUT_RETRY_TARGET");
}
function validateJob(row, jobId, fixture) {
  need(exact(row, ["schemaVersion", "jobId", "intent", "status", "reasonCode", "createdAt", "updatedAt", "startedAt", "finishedAt", "nextAttemptAt", "recoveredAt", "attempts", "maxAttempts", "result"])
    && row.schemaVersion === 1 && row.jobId === jobId && row.status === "needs_verification" && row.reasonCode === "KEYWORD_RECONSTRUCT_OUTSIDE_READ_DENIED" && row.attempts === 1 && row.maxAttempts === 3 && row.result === null && row.nextAttemptAt === null
    && ["createdAt", "updatedAt", "startedAt", "finishedAt"].every(k => H.validIso(row[k])) && (row.recoveredAt === null || H.validIso(row.recoveredAt)), "KEYWORD_REVIEWED_INPUT_RETRY_JOB_INELIGIBLE");
  const i = row.intent;
  need(exact(i, ["runId", "keyword", "manifestSha256", "scheduleOccurrenceId", "scope", "refreshVersion"]) && i.refreshVersion === VERSION && /^[A-Za-z0-9][A-Za-z0-9_-]{0,239}$/.test(i.runId || "") && typeof i.keyword === "string" && i.keyword.length > 0 && i.keyword.length <= 160 && i.scope === i.keyword && H.SHA.test(i.manifestSha256 || "")
    && /^[A-Za-z0-9][A-Za-z0-9_-]{0,239}$/.test(i.scheduleOccurrenceId || "") && H.hash(bytes([VERSION, i.runId, i.manifestSha256, i.keyword, i.scope, i.scheduleOccurrenceId])) === jobId, "KEYWORD_REVIEWED_INPUT_RETRY_JOB_INELIGIBLE");
  if (!fixture) need(i.runId === TARGET.runId && i.keyword === TARGET.keyword && i.manifestSha256 === TARGET.manifestSha256 && i.scheduleOccurrenceId === TARGET.slotId, "KEYWORD_REVIEWED_INPUT_RETRY_TARGET");
  return H.hash(bytes([VERSION, i.runId, i.manifestSha256, i.keyword]));
}
async function diskIdle(dataDir, targetJobId) {
  const cold = require(path.join(CODE_ROOT, "lib/keyword_monthly_refresh.cjs")).createKeywordMonthlyRefresh({ dataDir, refreshVersion: VERSION, readCompletedEvidence: async () => { throw H.fault("KEYWORD_REVIEWED_INPUT_RETRY_EXECUTION_DENIED"); }, refresh: async () => { throw H.fault("KEYWORD_REVIEWED_INPUT_RETRY_EXECUTION_DENIED"); } });
  let status; try { status = await cold.status({ limit: 0 }); } finally { await cold.close(); }
  need(status.readOnly === true && status.initialized === false && status.started === false && status.activeJobId === null && status.errorCode === null && status.counts && typeof status.counts === "object", "KEYWORD_REVIEWED_INPUT_RETRY_QUEUE_UNKNOWN");
  const pins = [], queue = path.join(dataDir, "keyword_monthly_refresh/jobs"), before = await H.checked(queue, true), names = await fs.readdir(queue, { withFileTypes: true }); let total = 0;
  need(names.length <= 4096, "KEYWORD_REVIEWED_INPUT_RETRY_QUEUE_BOUND");
  for (const e of names.sort((a, b) => a.name.localeCompare(b.name))) {
    need(e.isFile() && !e.isSymbolicLink() && /^[a-f0-9]{64}\.json$/.test(e.name), "KEYWORD_REVIEWED_INPUT_RETRY_QUEUE_UNKNOWN"); const r = await read(path.join(queue, e.name)); total += r.bytes.length;
    need(total <= 8 * 1024 * 1024 && r.value.jobId === e.name.slice(0, -5) && typeof r.value.intent?.refreshVersion === "string" && /^keyword-monthly-[A-Za-z0-9_.-]{1,100}$/.test(r.value.intent.refreshVersion) && ["queued", "running", "deferred", "complete", "needs_verification"].includes(r.value.status), "KEYWORD_REVIEWED_INPUT_RETRY_QUEUE_UNKNOWN");
    need(r.value.status !== "running" && (r.value.intent?.refreshVersion !== VERSION || !["queued", "deferred"].includes(r.value.status)), "KEYWORD_REVIEWED_INPUT_RETRY_QUEUE_ACTIVE"); pins.push([e.name, r.sha256]);
  }
  need(H.same(before, await H.checked(queue, true)) && names.some(e => e.name === targetJobId + ".json"), "KEYWORD_REVIEWED_INPUT_RETRY_CHANGED");
  const day = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
  for (const [relative, maximum, broker] of [["collector/jobs.json", 16 * 1024 * 1024, true], ["collector-scheduled/jobs.json", 16 * 1024 * 1024, true], ["collector-web/state.json", 1024 * 1024, false]]) {
    const r = await read(path.join(dataDir, ...relative.split("/")), maximum), v = r.value;
    const summary = broker ? S.brokerSummary(v, day) : S.webSummary(v, day);
    need(summary.halted === false && summary.reviewHoldActive === false, "KEYWORD_REVIEWED_INPUT_RETRY_COLLECTION_PROTECTED");
    if (broker) { need(summary.pendingCount === 0, "KEYWORD_REVIEWED_INPUT_RETRY_COLLECTION_BUSY");
      need(v.workerLastSeenAt === undefined || v.workerLastSeenAt === null || H.validIso(v.workerLastSeenAt), "KEYWORD_REVIEWED_INPUT_RETRY_COLLECTION_UNKNOWN"); const state = { ...v }; delete state.workerLastSeenAt; pins.push([relative, H.hash(bytes({ workerLastSeenAtPresent: Object.hasOwn(v, "workerLastSeenAt"), state }))]); }
    else { need(summary.active === null, "KEYWORD_REVIEWED_INPUT_RETRY_COLLECTION_BUSY"); pins.push([relative, r.sha256]); }
  }
  const post = await read(path.join(dataDir, "history/collection_postprocess/queue.json"), 2 * 1024 * 1024), v = post.value;
  need(S.queueSummary(v).activeCount === 0, "KEYWORD_REVIEWED_INPUT_RETRY_DB_BUSY"); pins.push(["postprocess", post.sha256]);
  return { fingerprint: H.hash(bytes(pins)), basis: "bounded_saved_journals_and_absent_publication_locks", inMemoryAnalyticalIdleVerified: false };
}
async function inspect(options, deps = {}) {
  const fixture = deps.fixture === true; optionsFor(options, fixture); const { dataDir, jobId, failureId } = options, namespace = path.join(dataDir, "keyword_monthly_incremental"), jobRoot = path.join(namespace, "jobs", "refresh-job-" + failureId), receipts = path.join(dataDir, "keyword_monthly_analysis/refresh-receipts");
  await privateDir(namespace, fixture); await privateDir(path.join(dataDir, "keyword_monthly_refresh/jobs"), fixture); await privateDir(jobRoot, fixture);
  const job = await read(path.join(dataDir, "keyword_monthly_refresh/jobs", jobId + ".json")); need(job.sha256 === options.expectedJobSha256, "KEYWORD_REVIEWED_INPUT_RETRY_CHANGED"); const sourceKey = validateJob(job.value, jobId, fixture), i = job.value.intent;
  need(fixture && process.platform === "win32" || job.stat.uid === process.getuid() && (job.stat.mode & 0o777) === 0o600, "KEYWORD_REVIEWED_INPUT_RETRY_PRIVATE_SCOPE");
  const input = await read(path.join(jobRoot, "job-input.json"), 1024 * 1024), child = await read(path.join(jobRoot, "preparation-failed.json")), failure = await read(path.join(receipts, "failed-incremental-" + sourceKey + "-" + failureId + ".json"), 32768), f = failure.value;
  need(input.sha256 === options.expectedInputSha256 && child.sha256 === options.expectedFailureSha256 && input.value.dataDir === dataDir && input.value.version === VERSION, "KEYWORD_REVIEWED_INPUT_RETRY_SOURCE_MISMATCH");
  const e = H.validateEvidence(input.value.evidence); need(e.runId === i.runId && e.keyword === i.keyword && e.manifestSha256 === i.manifestSha256 && e.scheduleOccurrenceId === i.scheduleOccurrenceId, "KEYWORD_REVIEWED_INPUT_RETRY_SOURCE_MISMATCH");
  const binding = await F.captureBinding({ jobRoot, inputSha256: input.sha256, sourceKey, version: VERSION, pid: child.value.pid });
  const verifiedFailure = await F.readFailure(binding), frames = verifiedFailure.frames;
  need(verifiedFailure.receiptSha256 === child.sha256 && verifiedFailure.code === job.value.reasonCode && verifiedFailure.progress.phase === "final_verification" && verifiedFailure.progress.scopeIndex === null && verifiedFailure.progress.plannedScopes === 99 && verifiedFailure.progress.completedParts === 99
    && frames.length === 6 && frames[0].file === "reconstruct_keyword_monthly_source_copy.cjs" && frames[1].file === frames[0].file && frames[2].file === frames[0].file && frames[3].file === "lib/keyword_monthly_source_copy.cjs" && frames[4].file === "lib/keyword_monthly_incremental_inputs.cjs" && frames[5].file === frames[4].file
    && [15, 75, 135, 25, 37, 61].every((line, n) => frames[n].line === line), "KEYWORD_REVIEWED_INPUT_RETRY_FAILURE_UNVERIFIED");
  need(f.schemaVersion === 1 && f.sourceKey === sourceKey && f.jobRoot === jobRoot && f.code === job.value.reasonCode && f.publicationIntentAbsent === true && f.operatingPointerChanged === false && f.sourceCacheRetained === true && H.validIso(f.observedAt)
    && f.childPid === binding.pid && Number.isSafeInteger(f.childExitCode) && f.childExitCode !== 0 && f.childExitSignal === null && f.childFailure?.status === "verified" && f.childFailure.receiptSha256 === child.sha256 && f.childFailure.code === job.value.reasonCode, "KEYWORD_REVIEWED_INPUT_RETRY_FAILURE_UNVERIFIED");
  const proof = await read(path.join(jobRoot, "control/isolation.json"), 65536), p = proof.value;
  need(proof.sha256 === binding.proofSha256 && p.guardName === "reconstruct_keyword_monthly_incremental.cjs" && p.guardRequiredBeforeNormalization === true && p.applicationStarted === false && p.fixtureOnly !== true && ["tcpSocketDenied", "udpSocketDenied", "ipv6SocketDenied"].every(k => p.kernelProbe?.[k] === true) && ["socket", "socketpair", "connect", "sendto", "sendmsg"].every(k => p.kernelProbe?.syscallsDeniedWithEperm?.[k] === true) && p.nonStandardFdsClosedBeforeExec === true && p.nonStandardFdsRemainingBeforeExec === 0 && p.stdioLocalIPC === undefined, "KEYWORD_REVIEWED_INPUT_RETRY_ISOLATION_UNVERIFIED");
  const proc = fixture && deps.processReader ? deps.processReader : require(path.join(CODE_ROOT, "lib/keyword_monthly_worker_lock.cjs")).createLinuxProcessReader();
  need(await proc.process(binding.pid) === null, "KEYWORD_REVIEWED_INPUT_RETRY_CHILD_NOT_DEAD"); const context = await proc.context();
  const manifest = await read(path.join(dataDir, "outputs", i.runId, "manifest.json"), 1024 * 1024), db = await read(path.join(dataDir, "history/collection_postprocess/runs", H.hash(Buffer.from(i.runId)) + ".json"), 128 * 1024);
  need(manifest.sha256 === i.manifestSha256 && manifest.value.keyword === i.keyword && manifest.value.collectionQuality?.status === "complete" && manifest.value.collectionFailed !== true && db.value.runId === i.runId && db.value.status === "complete" && db.value.result?.sourceManifestSha256 === i.manifestSha256 && db.value.finishedAt === e.finishedAt
    && (db.value.scheduleOccurrenceId ?? db.value.context?.scheduleOccurrenceId ?? null) === i.scheduleOccurrenceId, "KEYWORD_REVIEWED_INPUT_RETRY_SOURCE_MISMATCH");
  for (const file of [path.join(namespace, "worker-lock.json"), path.join(namespace, "worker-lock-recovery-claim.json"), path.join(dataDir, "keyword_monthly_analysis/publish.lock"), path.join(jobRoot, "preparation-complete.json"), ...["intent-", "complete-"].map(prefix => path.join(receipts, prefix + sourceKey + ".json"))]) need(await absent(file), "KEYWORD_REVIEWED_INPUT_RETRY_PUBLICATION_OR_LOCK_PRESENT");
  const publicPointer = await read(path.join(dataDir, "keyword_monthly_analysis/current.json"), 16384), sourcePointer = await read(path.join(namespace, "source-current.json"), 16384), pp = publicPointer.value, sp = sourcePointer.value;
  need(publicPointer.sha256 === options.expectedPublicPointerSha256 && pp.schemaVersion === 1 && /^[a-f0-9]{32}$/.test(pp.generation || "") && H.SHA.test(pp.catalogSha256 || "") && input.value.initialBundle?.generation === pp.generation && input.value.initialBundle.pointerSha256 === publicPointer.sha256 && input.value.initialBundle.catalogSha256 === pp.catalogSha256, "KEYWORD_REVIEWED_INPUT_RETRY_PUBLIC_CHANGED");
  need(sourcePointer.sha256 === options.expectedSourcePointerSha256 && sp.schemaVersion === 1 && sp.version === "keyword-monthly-incremental-state-v1" && sp.compression === "gzip" && H.SHA.test(sp.stateSha256 || "") && H.SHA.test(sp.storageSha256 || ""), "KEYWORD_REVIEWED_INPUT_RETRY_SOURCE_CHANGED");
  const code = await codeIdentity(); need(code.fingerprint === options.expectedCodeFingerprint, "KEYWORD_REVIEWED_INPUT_RETRY_CODE_CHANGED"); const idle = await diskIdle(dataDir, jobId);
  need((await read(job.file)).sha256 === job.sha256, "KEYWORD_REVIEWED_INPUT_RETRY_CHANGED");
  const snapshot = { schemaVersion: 1, jobId, sourceKey, refreshVersion: VERSION, originalJobSha256: job.sha256, originalJobBytes: job.bytes.length, originalJobIdentity: Object.fromEntries(["dev", "ino", "size", "nlink", "mtimeMs", "ctimeMs"].map(k => [k, String(job.stat[k])])), attempts: job.value.attempts, maxAttempts: job.value.maxAttempts,
    failureId, childFailureSha256: child.sha256, parentFailureSha256: failure.sha256, jobInputSha256: input.sha256, proofSha256: proof.sha256, ownerSha256: binding.ownerSha256, manifestSha256: manifest.sha256, dbReceiptSha256: db.sha256, sourcePointerSha256: sourcePointer.sha256, sourceStateSha256: sp.stateSha256, publicPointerSha256: publicPointer.sha256, publicGeneration: pp.generation, catalogSha256: pp.catalogSha256, codeFingerprint: code.fingerprint, executedToolSha256: code.executedToolSha256, stagedPathIdentity: code.stagedPathIdentity, persistentIdleSha256: idle.fingerprint, currentProcessContextSha256: H.hash(bytes(context)), failureChildAbsent: true };
  return { status: "review_required", snapshot, reviewSha256: H.hash(bytes(snapshot)), changed: false, restartRequired: true, runtimeAdmission: idle, providerCalls: 0, sourceWrites: 0, credentialOrEnvironmentReads: 0 };
}
async function retryReviewedInputChange(options, deps = {}) {
  const first = await inspect(options, deps); if (options.mode === "inspect") return first; need(first.reviewSha256 === options.reviewSha256, "KEYWORD_REVIEWED_INPUT_RETRY_REVIEW_MISMATCH");
  const fixture = deps.fixture === true, operationId = crypto.randomUUID(), M = require(path.join(CODE_ROOT, "lib/keyword_monthly_maintenance.cjs")), lease = await M.acquirePreparedConversionLease({ dataDir: options.dataDir, mode: "publish", operationId });
  let result, failed, mutated = false;
  try {
    const maintenance = await read(path.join(options.dataDir, "keyword_monthly_incremental", M.MAINTENANCE_FILE), 16384); need(maintenance.value.operationId === operationId && maintenance.value.mode === "publish", "KEYWORD_REVIEWED_INPUT_RETRY_MAINTENANCE_CHANGED");
    need((await inspect(options, deps)).reviewSha256 === first.reviewSha256, "KEYWORD_REVIEWED_INPUT_RETRY_CHANGED");
    const now = new Date(typeof options.now === "function" ? options.now() : Date.now()).toISOString(), operations = path.join(options.dataDir, "operations");
    try { await fs.mkdir(operations, { mode: 0o700 }); } catch (e) { if (e.code !== "EEXIST") throw e; } const op = await H.checked(operations, true); need(fixture && process.platform === "win32" || op.uid === process.getuid() && (op.mode & 0o022) === 0, "KEYWORD_REVIEWED_INPUT_RETRY_PRIVATE_SCOPE");
    const parent = path.join(operations, "keyword-reviewed-input-change-retry"); await privateDir(parent, fixture, true); const auditDir = path.join(parent, options.jobId); await fs.mkdir(auditDir, { mode: 0o700 }); await privateDir(auditDir, fixture);
    await H.writeNew(path.join(auditDir, "owner.json"), { schemaVersion: 1, operationId, jobId: options.jobId, reviewSha256: first.reviewSha256, createdAt: now });
    const jobFile = path.join(options.dataDir, "keyword_monthly_refresh/jobs", options.jobId + ".json"), original = await read(jobFile); need(original.sha256 === options.expectedJobSha256, "KEYWORD_REVIEWED_INPUT_RETRY_CHANGED");
    const archive = await fs.open(path.join(auditDir, "original-job.json"), "wx", 0o600); try { await archive.writeFile(original.bytes); await archive.sync(); } finally { await archive.close(); } need((await read(path.join(auditDir, "original-job.json"))).sha256 === original.sha256, "KEYWORD_REVIEWED_INPUT_RETRY_AUDIT_READBACK");
    const failedRoot = path.join(options.dataDir, "keyword_monthly_incremental/jobs", "refresh-job-" + options.failureId);
    await archiveExact(path.join(failedRoot, "job-input.json"), path.join(auditDir, "original-job-input.json"), first.snapshot.jobInputSha256, 1024 * 1024);
    await archiveExact(path.join(failedRoot, "preparation-failed.json"), path.join(auditDir, "original-child-failure.json"), first.snapshot.childFailureSha256, 8192);
    await archiveExact(path.join(failedRoot, "control/isolation.json"), path.join(auditDir, "original-isolation-proof.json"), first.snapshot.proofSha256, 65536);
    await archiveExact(path.join(options.dataDir, "keyword_monthly_analysis/refresh-receipts", "failed-incremental-" + first.snapshot.sourceKey + "-" + options.failureId + ".json"), path.join(auditDir, "original-parent-failure.json"), first.snapshot.parentFailureSha256, 32768);
    await H.writeNew(path.join(auditDir, "reviewed-preflight.json"), { ...first, operationId, reviewedAt: now });
    const next = { ...original.value, status: "queued", reasonCode: REASON, updatedAt: now, startedAt: null, finishedAt: null, nextAttemptAt: now, recoveredAt: now, result: null }, nextBytes = bytes(next); need(nextBytes.length <= 8192 && next.attempts === 1 && next.maxAttempts === 3, "KEYWORD_REVIEWED_INPUT_RETRY_JOB_INELIGIBLE");
    await H.writeNew(path.join(auditDir, "planned-job.json"), next);
    need((await inspect(options, deps)).reviewSha256 === first.reviewSha256, "KEYWORD_REVIEWED_INPUT_RETRY_CHANGED");
    const temporary = path.join(path.dirname(jobFile), options.jobId + "." + operationId + ".tmp"), identity = await H.checked(path.dirname(jobFile), true), h = await fs.open(temporary, "wx", 0o600); try { await h.writeFile(nextBytes); await h.sync(); } finally { await h.close(); }
    const last = await read(jobFile); need(last.sha256 === original.sha256 && H.same(last.stat, original.stat) && H.identity(identity, await H.checked(path.dirname(jobFile), true)), "KEYWORD_REVIEWED_INPUT_RETRY_CHANGED");
    const currentMaintenance = await read(maintenance.file, 16384); need(currentMaintenance.sha256 === maintenance.sha256 && H.same(currentMaintenance.stat, maintenance.stat), "KEYWORD_REVIEWED_INPUT_RETRY_MAINTENANCE_CHANGED");
    // Atomic rename under the existing exclusion; never described as a hostile-
    // writer compare-and-swap syscall. A restart is required for queue reload.
    await fs.rename(temporary, jobFile); mutated = true; await syncDir(path.dirname(jobFile)); need((await read(jobFile)).sha256 === H.hash(nextBytes), "KEYWORD_REVIEWED_INPUT_RETRY_NEEDS_READBACK");
    const receipt = { schemaVersion: 1, status: "queued", action: "reviewed_one_saved_source_input_change_retry", operationId, jobId: options.jobId, sourceKey: first.snapshot.sourceKey, refreshVersion: VERSION, reviewSha256: first.reviewSha256, originalJobSha256: original.sha256, queuedJobSha256: H.hash(nextBytes), originalBytesPreserved: true, failureEvidenceRetained: true, attemptsPreserved: true, attempts: next.attempts, maxAttempts: next.maxAttempts, collectorStarted: false, providerCalls: 0, sourceWrites: 0, credentialOrEnvironmentReads: 0, restartRequired: true, queuedAt: now };
    await H.writeNew(path.join(auditDir, "retry-complete.json"), receipt); await syncDir(auditDir); result = { ...receipt, auditDir };
  } catch (e) { failed = mutated ? Object.assign(H.fault("KEYWORD_REVIEWED_INPUT_RETRY_NEEDS_READBACK"), { mutationState: "job_changed_verify_audit" }) : e; }
  try { await lease.release(); } catch (e) { if (!failed) failed = e; else failed.maintenanceReleaseNeedsReview = true; } if (failed) throw failed; return result;
}
function args(values) {
  const out = {}, keys = { mode: "mode", "job-id": "jobId", "failure-id": "failureId", "job-sha": "expectedJobSha256", "input-sha": "expectedInputSha256", "failure-sha": "expectedFailureSha256", "public-sha": "expectedPublicPointerSha256", "source-sha": "expectedSourcePointerSha256", "code-fingerprint": "expectedCodeFingerprint", "review-sha": "reviewSha256" };
  for (let i = 0; i < values.length; i += 2) { const k = values[i]?.replace(/^--/, ""); need(Object.hasOwn(keys, k) && !Object.hasOwn(out, keys[k]) && values[i + 1], "KEYWORD_REVIEWED_INPUT_RETRY_OPTIONS"); out[keys[k]] = values[i + 1]; } return { dataDir: "/var/data", ...out };
}
if (require.main === module) retryReviewedInputChange(args(process.argv.slice(2))).then(v => console.log(JSON.stringify(v))).catch(e => { console.log(JSON.stringify({ status: "hold", code: /^KEYWORD_[A-Z0-9_]{1,120}$/.test(e.code || "") ? e.code : "KEYWORD_REVIEWED_INPUT_RETRY_HOLD", ...(e.mutationState ? { mutationState: e.mutationState } : {}) })); process.exitCode = 1; });
module.exports = { inspectReviewedInputChangeRetry: inspect, retryReviewedInputChange, codeIdentity, validateJob, diskIdle, stagedPathStatAllowed, args, VERSION, REASON, TARGET };
