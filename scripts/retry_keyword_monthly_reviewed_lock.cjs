"use strict";
// Explicit operator-reviewed derived retry only. No collector/application entry,
// provider, protection writer, queue execution or source calculator is imported.
const fs = require("node:fs/promises"), C = require("node:fs").constants, path = require("node:path"), crypto = require("node:crypto");
const H = require("./lib/keyword_monthly_refresh_preparation.cjs");
const VERSION = "keyword-monthly-incremental-v5", REASON = "KEYWORD_INCREMENTAL_REVIEWED_LOCK_RETRY", UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const RUN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,239}$/, bytes = value => Buffer.from(JSON.stringify(value)), digest = value => H.hash(value);
const need = (value, code = "KEYWORD_REVIEWED_RETRY_HOLD") => H.need(value, code);
const exact = (v, keys) => v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
const text = v => typeof v === "string" && v.length > 0 && v.length <= 300 && v === v.trim() && !/[\u0000-\u001f\u007f]/.test(v);
async function read(file, maximum = 8192) {
  const stat = await H.checked(file); need(stat.size > 0 && stat.size <= maximum, "KEYWORD_REVIEWED_RETRY_READ_BOUND");
  const h = await fs.open(file, C.O_RDONLY | (C.O_NOFOLLOW || 0)); let raw;
  try { need(H.same(stat, await h.stat()), "KEYWORD_REVIEWED_RETRY_CHANGED"); const b = Buffer.alloc(stat.size + 1); let offset = 0;
    while (offset < b.length) { const r = await h.read(b, offset, b.length - offset, offset); if (!r.bytesRead) break; offset += r.bytesRead; }
    need(offset === stat.size && H.same(stat, await h.stat()), "KEYWORD_REVIEWED_RETRY_CHANGED"); raw = b.subarray(0, offset);
  } finally { await h.close(); }
  need(H.same(stat, await H.checked(file)), "KEYWORD_REVIEWED_RETRY_CHANGED"); let value;
  try { value = JSON.parse(raw); } catch { throw H.fault("KEYWORD_REVIEWED_RETRY_JSON_INVALID"); }
  return { file, stat, bytes: raw, value, sha256: digest(raw) };
}
async function absent(file) { try { await fs.lstat(file); return false; } catch (e) { if (e.code === "ENOENT") return true; throw e; } }
async function privateDirectory(file, fixture, create = false) {
  if (create) { try { await fs.mkdir(file, { mode: 0o700 }); } catch (e) { if (e.code !== "EEXIST") throw e; } }
  const stat = await H.checked(file, true); need(fixture && process.platform === "win32" || (stat.mode & 0o777) === 0o700 && stat.uid === process.getuid(), "KEYWORD_REVIEWED_RETRY_PRIVATE_SCOPE_REQUIRED"); return stat;
}
async function syncDirectory(directory) { if (process.platform !== "win32") { const h = await fs.open(directory, C.O_RDONLY); try { await h.sync(); } finally { await h.close(); } } }
function validateJob(row, jobId) {
  const fields = ["schemaVersion", "jobId", "intent", "status", "reasonCode", "createdAt", "updatedAt", "startedAt", "finishedAt", "nextAttemptAt", "recoveredAt", "attempts", "maxAttempts", "result", ...(Object.hasOwn(row || {}, "lockDiagnostic") ? ["lockDiagnostic"] : [])];
  need(exact(row, fields) && row.schemaVersion === 1 && row.jobId === jobId && H.SHA.test(jobId)
    && row.status === "needs_verification" && row.reasonCode === "KEYWORD_INCREMENTAL_WORKER_LOCKED" && row.result === null && row.nextAttemptAt === null
    && ["createdAt", "updatedAt", "startedAt", "finishedAt"].every(k => H.validIso(row[k])) && (row.recoveredAt === null || H.validIso(row.recoveredAt))
    && Number.isSafeInteger(row.attempts) && row.attempts >= 1 && Number.isSafeInteger(row.maxAttempts) && row.maxAttempts <= 10 && row.attempts < row.maxAttempts, "KEYWORD_REVIEWED_RETRY_JOB_NOT_ELIGIBLE");
  const i = row.intent;
  need(exact(i, ["runId", "keyword", "manifestSha256", "scheduleOccurrenceId", "scope", "refreshVersion"]) && i.refreshVersion === VERSION
    && RUN.test(i.runId || "") && text(i.keyword) && text(i.scope) && H.SHA.test(i.manifestSha256 || "") && (i.scheduleOccurrenceId === null || RUN.test(i.scheduleOccurrenceId || ""))
    && digest(bytes([i.refreshVersion, i.runId, i.manifestSha256, i.keyword, i.scope, i.scheduleOccurrenceId])) === jobId, "KEYWORD_REVIEWED_RETRY_JOB_NOT_ELIGIBLE");
  return digest(bytes([VERSION, i.runId, i.manifestSha256, i.keyword]));
}
function optionsFor(options, fixture) {
  need(options && Object.keys(options).every(k => ["mode", "dataDir", "jobId", "expectedJobSha256", "recoveryId", "recoveryReceiptSha256", "reviewSha256", "now"].includes(k)));
  const { dataDir, jobId, expectedJobSha256, recoveryId, recoveryReceiptSha256 } = options; H.absolute(dataDir);
  need(fixture || process.platform === "linux" && dataDir === "/var/data", "KEYWORD_REVIEWED_RETRY_CONTEXT_INVALID");
  need(["inspect", "commit"].includes(options.mode) && H.SHA.test(jobId || "") && H.SHA.test(expectedJobSha256 || "") && UUID.test(recoveryId || "") && H.SHA.test(recoveryReceiptSha256 || "")
    && (options.mode === "inspect" ? options.reviewSha256 === undefined : H.SHA.test(options.reviewSha256 || "")), "KEYWORD_REVIEWED_RETRY_OPTIONS_INVALID");
  return options;
}
async function inspect(options, dependencies = {}) {
  const fixture = dependencies.fixture === true; optionsFor(options, fixture);
  const { dataDir, jobId, recoveryId } = options, namespace = path.join(dataDir, "keyword_monthly_incremental"), jobs = path.join(dataDir, "keyword_monthly_refresh/jobs");
  await privateDirectory(namespace, fixture); await privateDirectory(jobs, fixture);
  const job = await read(path.join(jobs, jobId + ".json")); need(job.sha256 === options.expectedJobSha256, "KEYWORD_REVIEWED_RETRY_CHANGED"); const sourceKey = validateJob(job.value, jobId), i = job.value.intent;
  need(fixture && process.platform === "win32" || job.stat.uid === process.getuid() && (job.stat.mode & 0o777) === 0o600, "KEYWORD_REVIEWED_RETRY_PRIVATE_SCOPE_REQUIRED");
  const recoveryDir = path.join(namespace, "lock-recovery", recoveryId); await privateDirectory(recoveryDir, fixture);
  const recovery = await read(path.join(recoveryDir, "recovery-complete.json"), 65536), r = recovery.value;
  need(recovery.sha256 === options.recoveryReceiptSha256 && r.schemaVersion === 1 && r.recoveryId === recoveryId && r.action === "archived_verified_dead_worker_lock"
    && r.originalBytesAndModePreserved === true && r.originalLedgersChanged === false && r.activeLockPathAbsent === true && H.validIso(r.completedAt), "KEYWORD_REVIEWED_RETRY_RECOVERY_UNVERIFIED");
  const preflight = await read(path.join(recoveryDir, "reviewed-preflight.json"), 65536), p = preflight.value, archived = await read(path.join(recoveryDir, "original-lock.json"), 16384), l = archived.value;
  need(preflight.sha256 === r.preflightSha256 && p.schemaVersion === 1 && p.action === "reviewed_dead_worker_lock_recovery" && p.recoveryId === recoveryId && p.snapshotSha256 === r.snapshotSha256
    && digest(bytes(p.snapshot)) === r.snapshotSha256 && p.snapshot.targetJobId === jobId && p.snapshot.sourceKey === sourceKey && p.snapshot.lockSha256 === archived.sha256
    && archived.sha256 === r.lockSha256 && l.schemaVersion === 2 && l.version === VERSION && l.sourceKey === sourceKey && UUID.test(l.jobId || "") && UUID.test(l.token || "")
    && p.snapshot.sourcePointerSha256 === r.sourcePointerSha256 && p.snapshot.publicPointerSha256 === r.publicPointerSha256, "KEYWORD_REVIEWED_RETRY_RECOVERY_UNVERIFIED");
  const input = await read(path.join(namespace, "jobs", "refresh-job-" + l.jobId, "job-input.json"), 1024 * 1024), e = input.value.evidence;
  need(input.sha256 === p.snapshot.jobInputSha256 && input.value.version === VERSION && input.value.dataDir === dataDir && e && e.runId === i.runId && e.keyword === i.keyword
    && e.manifestSha256 === i.manifestSha256 && (e.scheduleOccurrenceId || null) === i.scheduleOccurrenceId, "KEYWORD_REVIEWED_RETRY_SOURCE_MISMATCH");
  const manifest = await read(path.join(dataDir, "outputs", i.runId, "manifest.json"), 1024 * 1024), db = await read(path.join(dataDir, "history/collection_postprocess/runs", digest(Buffer.from(i.runId)) + ".json"), 128 * 1024);
  need(manifest.sha256 === i.manifestSha256 && manifest.sha256 === p.snapshot.sourceManifestSha256 && manifest.value.keyword === i.keyword && manifest.value.collectionQuality?.status === "complete"
    && db.sha256 === p.snapshot.dbReceiptSha256 && db.value.runId === i.runId && db.value.status === "complete" && db.value.result?.sourceManifestSha256 === i.manifestSha256
    && H.validIso(db.value.finishedAt) && db.value.finishedAt === e.finishedAt && (db.value.scheduleOccurrenceId ?? db.value.context?.scheduleOccurrenceId ?? null) === i.scheduleOccurrenceId, "KEYWORD_REVIEWED_RETRY_SOURCE_MISMATCH");
  for (const file of [path.join(namespace, "worker-lock.json"), path.join(namespace, "worker-lock-recovery-claim.json"), path.join(dataDir, "keyword_monthly_analysis/publish.lock"),
    ...["intent-", "complete-"].map(prefix => path.join(dataDir, "keyword_monthly_analysis/refresh-receipts", prefix + sourceKey + ".json"))]) need(await absent(file), "KEYWORD_REVIEWED_RETRY_PUBLICATION_OR_LOCK_PRESENT");
  const current = await read(job.file); need(current.sha256 === job.sha256 && H.same(current.stat, job.stat), "KEYWORD_REVIEWED_RETRY_CHANGED");
  const snapshot = { schemaVersion: 1, jobId, sourceKey, refreshVersion: VERSION, originalJobSha256: job.sha256, originalJobBytes: job.bytes.length,
    originalJobIdentity: Object.fromEntries(["dev", "ino", "size", "nlink", "mtimeMs", "ctimeMs"].map(k => [k, String(job.stat[k])])), attempts: job.value.attempts, maxAttempts: job.value.maxAttempts,
    recoveryId, recoveryReceiptSha256: recovery.sha256, preflightSha256: preflight.sha256, archivedLockSha256: archived.sha256, jobInputSha256: input.sha256, manifestSha256: manifest.sha256, dbReceiptSha256: db.sha256 };
  return { status: "review_required", snapshot, reviewSha256: digest(bytes(snapshot)), restartRequired: true, changed: false };
}
async function retryReviewedLock(options, dependencies = {}) {
  const fixture = dependencies.fixture === true, first = await inspect(options, dependencies); if (options.mode === "inspect") return first;
  need(first.reviewSha256 === options.reviewSha256, "KEYWORD_REVIEWED_RETRY_REVIEW_MISMATCH");
  const { acquirePreparedConversionLease, MAINTENANCE_FILE } = require("./lib/keyword_monthly_maintenance.cjs"), operationId = crypto.randomUUID();
  const lease = await acquirePreparedConversionLease({ dataDir: options.dataDir, mode: "publish", operationId }),
    admission = fixture && dependencies.admit ? dependencies.admit : require("./lib/keyword_monthly_conversion_admission.cjs").waitForConversionIdle;
  let failed, result, auditDir, mutated = false;
  try {
    const maintenance = await read(path.join(options.dataDir, "keyword_monthly_incremental", MAINTENANCE_FILE), 16384);
    need(maintenance.value.operationId === operationId && maintenance.value.mode === "publish", "KEYWORD_REVIEWED_RETRY_MAINTENANCE_CHANGED");
    const initialAdmission = await admission(); need(initialAdmission?.idle === true && initialAdmission.authenticatedLoopbackOnly === true, "KEYWORD_REVIEWED_RETRY_RUNTIME_UNVERIFIED");
    const current = await inspect(options, dependencies); need(current.reviewSha256 === first.reviewSha256, "KEYWORD_REVIEWED_RETRY_CHANGED");
    const now = new Date(typeof options.now === "function" ? options.now() : Date.now()).toISOString(), operations = path.join(options.dataDir, "operations");
    try { await fs.mkdir(operations, { mode: 0o700 }); } catch (e) { if (e.code !== "EEXIST") throw e; }
    const op = await H.checked(operations, true); need(fixture && process.platform === "win32" || op.uid === process.getuid() && (op.mode & 0o022) === 0, "KEYWORD_REVIEWED_RETRY_PRIVATE_SCOPE_REQUIRED");
    const parent = path.join(operations, "keyword-reviewed-lock-retry-" + new Date(Date.parse(now) + 9 * 3600000).toISOString().slice(0, 10).replaceAll("-", "")); await privateDirectory(parent, fixture, true);
    auditDir = path.join(parent, options.jobId); await fs.mkdir(auditDir, { mode: 0o700 }); await privateDirectory(auditDir, fixture);
    await H.writeNew(path.join(auditDir, "owner.json"), { schemaVersion: 1, operationId, jobId: options.jobId, reviewSha256: first.reviewSha256, createdAt: now });
    const jobFile = path.join(options.dataDir, "keyword_monthly_refresh/jobs", options.jobId + ".json"), original = await read(jobFile); need(original.sha256 === options.expectedJobSha256, "KEYWORD_REVIEWED_RETRY_CHANGED");
    const handle = await fs.open(path.join(auditDir, "original-job.json"), "wx", 0o600); try { await handle.writeFile(original.bytes); await handle.sync(); } finally { await handle.close(); }
    need((await read(path.join(auditDir, "original-job.json"))).sha256 === original.sha256, "KEYWORD_REVIEWED_RETRY_AUDIT_READBACK");
    await H.writeNew(path.join(auditDir, "reviewed-preflight.json"), { ...first, operationId, reviewedAt: now });
    const next = { ...original.value, status: "queued", reasonCode: REASON, updatedAt: now, startedAt: null, finishedAt: null, nextAttemptAt: now, recoveredAt: now, result: null }; delete next.lockDiagnostic;
    const nextBytes = bytes(next); need(nextBytes.length <= 8192 && next.attempts < next.maxAttempts, "KEYWORD_REVIEWED_RETRY_JOB_NOT_ELIGIBLE");
    await H.writeNew(path.join(auditDir, "planned-job.json"), next);
    const finalAdmission = await admission(); need(finalAdmission?.idle === true && finalAdmission.authenticatedLoopbackOnly === true, "KEYWORD_REVIEWED_RETRY_RUNTIME_UNVERIFIED");
    const final = await inspect(options, dependencies); need(final.reviewSha256 === first.reviewSha256, "KEYWORD_REVIEWED_RETRY_CHANGED");
    const temporary = path.join(path.dirname(jobFile), options.jobId + "." + operationId + ".tmp"), jobsIdentity = await H.checked(path.dirname(jobFile), true);
    const h = await fs.open(temporary, "wx", 0o600); try { await h.writeFile(nextBytes); await h.sync(); } finally { await h.close(); }
    const last = await read(jobFile); need(last.sha256 === original.sha256 && H.same(last.stat, original.stat) && H.identity(jobsIdentity, await H.checked(path.dirname(jobFile), true)), "KEYWORD_REVIEWED_RETRY_CHANGED");
    const currentMaintenance = await read(maintenance.file, 16384); need(currentMaintenance.sha256 === maintenance.sha256 && H.same(currentMaintenance.stat, maintenance.stat), "KEYWORD_REVIEWED_RETRY_MAINTENANCE_CHANGED");
    // Expected inode+bytes under the shared maintenance exclusion and exact
    // audit owner. Node rename is atomic, not a hostile-writer compare syscall.
    await fs.rename(temporary, jobFile); mutated = true; await syncDirectory(path.dirname(jobFile));
    need((await read(jobFile)).sha256 === digest(nextBytes), "KEYWORD_REVIEWED_RETRY_NEEDS_READBACK");
    const receipt = { schemaVersion: 1, status: "queued", action: "reviewed_derived_lock_retry", operationId, jobId: options.jobId, refreshVersion: VERSION,
      sourceKey: first.snapshot.sourceKey, reviewSha256: first.reviewSha256, originalJobSha256: original.sha256, queuedJobSha256: digest(nextBytes), recoveryReceiptSha256: options.recoveryReceiptSha256,
      attemptsPreserved: true, attempts: next.attempts, maxAttempts: next.maxAttempts, originalBytesPreserved: true, collectorStarted: false, sourceWrites: 0, providerCalls: 0, restartRequired: true, queuedAt: now };
    await H.writeNew(path.join(auditDir, "retry-complete.json"), receipt); await syncDirectory(auditDir); result = { ...receipt, auditDir };
  } catch (error) { failed = error; if (mutated) failed = Object.assign(H.fault("KEYWORD_REVIEWED_RETRY_NEEDS_READBACK"), { mutationState: "job_changed_verify_audit" }); }
  try { await lease.release(); } catch (error) { if (!failed) failed = error; else failed.maintenanceReleaseNeedsReview = true; }
  if (failed) throw failed; return result;
}
function args(values) {
  const out = {}; for (let n = 0; n < values.length; n += 2) { const k = values[n]?.replace(/^--/, ""); need(["mode", "job-id", "expected-job-sha", "recovery-id", "recovery-sha", "review-sha"].includes(k) && !Object.hasOwn(out, k) && values[n + 1], "KEYWORD_REVIEWED_RETRY_OPTIONS_INVALID"); out[k] = values[n + 1]; }
  return { mode: out.mode, dataDir: "/var/data", jobId: out["job-id"], expectedJobSha256: out["expected-job-sha"], recoveryId: out["recovery-id"], recoveryReceiptSha256: out["recovery-sha"], ...(out["review-sha"] ? { reviewSha256: out["review-sha"] } : {}) };
}
if (require.main === module) retryReviewedLock(args(process.argv.slice(2))).then(value => console.log(JSON.stringify(value))).catch(error => { console.log(JSON.stringify({ status: "hold", code: /^KEYWORD_[A-Z0-9_]{1,120}$/.test(error.code || "") ? error.code : "KEYWORD_REVIEWED_RETRY_HOLD", ...(error.mutationState ? { mutationState: error.mutationState } : {}) })); process.exitCode = 1; });
module.exports = { inspectReviewedLockRetry: inspect, retryReviewedLock, validateJob, args, VERSION, REASON };
