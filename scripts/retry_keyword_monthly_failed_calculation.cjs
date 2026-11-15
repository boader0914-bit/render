"use strict";
// An explicit reviewed retry of saved-source derived work, never a collection.
const fs = require("node:fs/promises"), C = require("node:fs").constants, path = require("node:path"), crypto = require("node:crypto");
const H = require("./lib/keyword_monthly_refresh_preparation.cjs"), A = require("./lib/keyword_monthly_failed_retry_authorization.cjs");
const VERSION = A.VERSION, UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/, RUN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,239}$/;
const bytes = v => Buffer.from(JSON.stringify(v)), need = (v, c = "KEYWORD_FAILED_RETRY_HOLD") => H.need(v, c);
const exact = (v, keys) => v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
async function read(file, maximum = 8192) {
  const stat = await H.checked(file); need(stat.size > 0 && stat.size <= maximum, "KEYWORD_FAILED_RETRY_READ_BOUND");
  const handle = await fs.open(file, C.O_RDONLY | (C.O_NOFOLLOW || 0)); let raw;
  try { need(H.same(stat, await handle.stat()), "KEYWORD_FAILED_RETRY_CHANGED"); const b = Buffer.alloc(stat.size + 1); let offset = 0;
    while (offset < b.length) { const r = await handle.read(b, offset, b.length - offset, offset); if (!r.bytesRead) break; offset += r.bytesRead; }
    need(offset === stat.size && H.same(stat, await handle.stat()), "KEYWORD_FAILED_RETRY_CHANGED"); raw = b.subarray(0, offset);
  } finally { await handle.close(); }
  need(H.same(stat, await H.checked(file)), "KEYWORD_FAILED_RETRY_CHANGED"); let value;
  try { value = JSON.parse(raw); } catch { throw H.fault("KEYWORD_FAILED_RETRY_JSON_INVALID"); }
  return { file, stat, bytes: raw, value, sha256: H.hash(raw) };
}
async function absent(file) { try { await fs.lstat(file); return false; } catch (e) { if (e.code === "ENOENT") return true; throw e; } }
async function privateDirectory(file, fixture, create = false) {
  if (create) try { await fs.mkdir(file, { mode: 0o700 }); } catch (e) { if (e.code !== "EEXIST") throw e; }
  const st = await H.checked(file, true); need(fixture && process.platform === "win32" || st.uid === process.getuid() && (st.mode & 0o777) === 0o700, "KEYWORD_FAILED_RETRY_PRIVATE_SCOPE_REQUIRED"); return st;
}
async function syncDirectory(file) { if (process.platform !== "win32") { const h = await fs.open(file, C.O_RDONLY); try { await h.sync(); } finally { await h.close(); } } }
async function streamIntegrity(file, expectedSha256, expectedBytes) {
  const before = await H.checked(file); need(Number.isSafeInteger(expectedBytes) && expectedBytes > 0 && expectedBytes <= 32 * 1024 * 1024
    && before.size === expectedBytes && H.SHA.test(expectedSha256 || ""), "KEYWORD_FAILED_RETRY_LEGACY_INTEGRITY_INVALID");
  const handle = await fs.open(file, C.O_RDONLY | (C.O_NOFOLLOW || 0)), hash = crypto.createHash("sha256"); let offset = 0;
  try { need(H.same(before, await handle.stat()), "KEYWORD_FAILED_RETRY_CHANGED"); const buffer = Buffer.alloc(1024 * 1024);
    while (true) { const r = await handle.read(buffer, 0, Math.min(buffer.length, expectedBytes - offset + 1), offset); if (!r.bytesRead) break;
      offset += r.bytesRead; need(offset <= expectedBytes, "KEYWORD_FAILED_RETRY_CHANGED"); hash.update(buffer.subarray(0, r.bytesRead)); }
    need(offset === expectedBytes && H.same(before, await handle.stat()), "KEYWORD_FAILED_RETRY_CHANGED");
  } finally { await handle.close(); }
  need(H.same(before, await H.checked(file)) && hash.digest("hex") === expectedSha256, "KEYWORD_FAILED_RETRY_LEGACY_INTEGRITY_INVALID");
}
async function legacyPublicationIntegrity(dataDir, base, catalog, receipt) {
  const fields = ["schemaVersion", "status", "generation", "bundleDir", "totalStoredBytes", "pointerSha256", "previousPointerSha256", "catalogSha256", "partitionCount", "scopeCount", "fixedValidationClock", "partitions",
    "sourceProvenancePreserved", "originalEnvelopesRewritten", "providerCalls", "collectorStarted", "kosisReadOrChanged", "freshnessPolicy"];
  need(exact(receipt, fields) && catalog.schemaVersion === 1 && receipt.bundleDir === path.join(dataDir, "keyword_monthly_analysis")
    && Number.isSafeInteger(receipt.totalStoredBytes) && receipt.totalStoredBytes > 0 && receipt.totalStoredBytes <= 8 * 1024 ** 3
    && (receipt.previousPointerSha256 === null || H.SHA.test(receipt.previousPointerSha256))
    && receipt.freshnessPolicy === "Original child materializedAt/dataThrough/status retained; bundle assembly never refreshes historical source provenance.", "KEYWORD_FAILED_RETRY_LEGACY_RECEIPT_INVALID");
  require("./lib/keyword_monthly_bundle.cjs").validateCatalog(catalog);
  need(receipt.partitionCount === catalog.partitions.length && receipt.scopeCount === catalog.scopes.length && receipt.fixedValidationClock === catalog.createdAt
    && Array.isArray(receipt.partitions) && receipt.partitions.length > 0 && receipt.partitions.length <= 512, "KEYWORD_FAILED_RETRY_LEGACY_RECEIPT_INVALID");
  const indexes = new Map(), inventory = []; let checkedBytes = 0, projectionCount = 0;
  for (const part of catalog.partitions) {
    const directory = path.join(base, "partitions", part.key), index = await read(path.join(directory, "index.json"), 1024 * 1024), value = index.value;
    need(index.sha256 === part.indexSha256 && index.bytes.length === part.indexBytes && value.schemaVersion === 1 && value.calculationVersion === "keyword-monthly-v1"
      && H.SHA.test(value.sourceFingerprint || "") && value.provenance?.inputSha256 === value.sourceFingerprint && H.validIso(value.provenance.dataThrough)
      && Array.isArray(value.keywords) && value.keywords.length > 0 && value.keywords.length <= 4096, "KEYWORD_FAILED_RETRY_LEGACY_INTEGRITY_INVALID");
    indexes.set(part.key, { index, scopes: new Map() }); checkedBytes += index.bytes.length; inventory.push([part.key, "index.json", index.sha256, index.bytes.length]);
    const names = new Set(), itemKeys = new Set();
    for (const item of value.keywords) {
      need(typeof item.keyword === "string" && item.keyword.length > 0 && item.keyword.length <= 300 && !itemKeys.has(item.keyword) && Array.isArray(item.scopes) && item.scopes.length <= 4096,
        "KEYWORD_FAILED_RETRY_LEGACY_INTEGRITY_INVALID"); itemKeys.add(item.keyword);
      for (const scope of item.scopes) {
        need(H.MONTH.test(scope.month || "") && scope.scopeKey === H.hash(bytes(["keyword-monthly-v1", item.keyword, scope.month])) && H.SHA.test(scope.sha256 || "")
          && (scope.encoding === undefined || scope.encoding === "gzip") && ++projectionCount <= 8192, "KEYWORD_FAILED_RETRY_LEGACY_INTEGRITY_INVALID");
        const name = scope.scopeKey + ".json" + (scope.encoding === "gzip" ? ".gz" : ""), id = JSON.stringify([item.keyword, scope.month]);
        need(!names.has(name) && !indexes.get(part.key).scopes.has(id), "KEYWORD_FAILED_RETRY_LEGACY_INTEGRITY_INVALID"); names.add(name); indexes.get(part.key).scopes.set(id, scope);
        await streamIntegrity(path.join(directory, "projections", name), scope.sha256, scope.bytes); checkedBytes += scope.bytes;
        need(checkedBytes <= receipt.totalStoredBytes, "KEYWORD_FAILED_RETRY_LEGACY_INTEGRITY_INVALID"); inventory.push([part.key, name, scope.sha256, scope.bytes]);
      }
    }
    const declared = await fs.readdir(path.join(directory, "projections"), { withFileTypes: true });
    need(declared.length === names.size && declared.every(entry => entry.isFile() && !entry.isSymbolicLink() && names.has(entry.name)), "KEYWORD_FAILED_RETRY_LEGACY_INTEGRITY_INVALID");
    need((await read(index.file, 1024 * 1024)).sha256 === index.sha256, "KEYWORD_FAILED_RETRY_CHANGED");
  }
  const validations = new Set(), usedParts = new Set();
  for (const part of receipt.partitions) {
    const saved = indexes.get(part.inputIndexSha256);
    need(exact(part, ["inputIndexSha256", "inputIndexBytes", "validation"]) && saved && part.inputIndexBytes === saved.index.bytes.length
      && Array.isArray(part.validation) && part.validation.length > 0 && part.validation.length <= 4096, "KEYWORD_FAILED_RETRY_LEGACY_RECEIPT_INVALID"); usedParts.add(part.inputIndexSha256);
    for (const row of part.validation) {
      const q = row?.query, id = JSON.stringify([q?.keyword, q?.month]);
      need(exact(row, ["query", "status", "selectedDigest", "inputSha256", "dataThrough"]) && exact(q, ["keyword", "month", "cutoffDate"])
        && H.validDay(q.cutoffDate) && ["available", "stale"].includes(row.status) && H.SHA.test(row.selectedDigest || "")
        && row.inputSha256 === saved.index.value.sourceFingerprint && row.dataThrough === saved.index.value.provenance.dataThrough
        && saved.scopes.has(id) && !validations.has(id) && catalog.scopes.some(scope => scope.partition === part.inputIndexSha256 && scope.keyword === q.keyword && scope.month === q.month),
      "KEYWORD_FAILED_RETRY_LEGACY_RECEIPT_INVALID"); validations.add(id);
    }
  }
  need(usedParts.size === catalog.partitions.length && validations.size === catalog.scopes.length && checkedBytes === receipt.totalStoredBytes, "KEYWORD_FAILED_RETRY_LEGACY_INTEGRITY_INVALID");
  return { basis: "legacy_writer_receipt_and_exact_saved_partition_bytes", partitionCount: indexes.size, projectionCount, checkedBytes, integritySha256: H.hash(bytes(inventory)) };
}
function optionsFor(o, fixture) {
  need(o && Object.keys(o).every(k => ["mode", "dataDir", "jobId", "expectedJobSha256", "failureId", "expectedFailureSha256", "expectedPublicPointerSha256", "expectedSourcePointerSha256", "reviewSha256", "diagnosticPurpose", "now"].includes(k)), "KEYWORD_FAILED_RETRY_OPTIONS_INVALID");
  H.absolute(o.dataDir); need(fixture || process.platform === "linux" && o.dataDir === "/var/data", "KEYWORD_FAILED_RETRY_CONTEXT_INVALID");
  need(["inspect", "commit"].includes(o.mode) && UUID.test(o.failureId || "") && ["jobId", "expectedJobSha256", "expectedFailureSha256", "expectedPublicPointerSha256", "expectedSourcePointerSha256"].every(k => H.SHA.test(o[k] || ""))
    && (o.mode === "inspect" ? o.reviewSha256 === undefined : H.SHA.test(o.reviewSha256 || ""))
    && [undefined, "diagnose_prior_generic_child_failure"].includes(o.diagnosticPurpose), "KEYWORD_FAILED_RETRY_OPTIONS_INVALID");
}
function failedJob(row, jobId) {
  need(exact(row, ["schemaVersion", "jobId", "intent", "status", "reasonCode", "createdAt", "updatedAt", "startedAt", "finishedAt", "nextAttemptAt", "recoveredAt", "attempts", "maxAttempts", "result"])
    && row.schemaVersion === 1 && row.jobId === jobId && row.status === "needs_verification" && A.FAILED_CODES.has(row.reasonCode) && row.result === null && row.nextAttemptAt === null
    && row.attempts === 3 && row.maxAttempts === 3 && ["createdAt", "updatedAt", "startedAt", "finishedAt"].every(k => H.validIso(row[k]))
    && (row.recoveredAt === null || H.validIso(row.recoveredAt)), "KEYWORD_FAILED_RETRY_JOB_NOT_ELIGIBLE");
  const i = row.intent;
  need(exact(i, ["runId", "keyword", "manifestSha256", "scheduleOccurrenceId", "scope", "refreshVersion"]) && i.refreshVersion === VERSION
    && RUN.test(i.runId || "") && typeof i.keyword === "string" && i.keyword.length > 0 && i.keyword.length <= 300 && i.scope === i.keyword
    && H.SHA.test(i.manifestSha256 || "") && (i.scheduleOccurrenceId === null || RUN.test(i.scheduleOccurrenceId || ""))
    && H.hash(bytes([VERSION, i.runId, i.manifestSha256, i.keyword, i.scope, i.scheduleOccurrenceId])) === jobId, "KEYWORD_FAILED_RETRY_JOB_NOT_ELIGIBLE");
  return H.hash(bytes([VERSION, i.runId, i.manifestSha256, i.keyword]));
}
async function publication(dataDir, generation, expectedPointerSha256) {
  need(/^[a-f0-9]{32}$/.test(generation || ""), "KEYWORD_FAILED_RETRY_PUBLICATION_INVALID");
  const base = path.join(dataDir, "keyword_monthly_analysis/generations", generation), catalog = await read(path.join(base, "catalog.json"), 1024 * 1024), receipt = await read(path.join(base, "publication-receipt.json"), 256 * 1024), r = receipt.value;
  need(r.schemaVersion === 1 && r.status === "published" && r.generation === generation && r.pointerSha256 === expectedPointerSha256 && r.catalogSha256 === catalog.sha256
    && r.sourceProvenancePreserved === true && r.originalEnvelopesRewritten === false && r.providerCalls === 0 && r.collectorStarted === false && r.kosisReadOrChanged === false
    && H.validIso(r.fixedValidationClock), "KEYWORD_FAILED_RETRY_PUBLICATION_INVALID");
  need([1, 2].includes(catalog.value.schemaVersion) && catalog.value.kind === "keyword_monthly_partition_bundle" && Array.isArray(catalog.value.scopes), "KEYWORD_FAILED_RETRY_PUBLICATION_INVALID");
  let verification;
  if (Object.hasOwn(r, "semanticPrevalidationSha256")) {
    need(H.SHA.test(r.semanticPrevalidationSha256 || "") && (!Object.hasOwn(r, "publicationProjectionAnalyses") || r.publicationProjectionAnalyses === 0), "KEYWORD_FAILED_RETRY_PUBLICATION_INVALID");
    verification = { basis: "semantic_prevalidation_receipt", integritySha256: null };
  } else verification = await legacyPublicationIntegrity(dataDir, base, catalog.value, r);
  need((await read(receipt.file, 256 * 1024)).sha256 === receipt.sha256 && (await read(catalog.file, 1024 * 1024)).sha256 === catalog.sha256, "KEYWORD_FAILED_RETRY_CHANGED");
  return { catalog, receipt, verification };
}
async function inspect(options, dependencies = {}, ownedAudit = null) {
  const fixture = dependencies.fixture === true; optionsFor(options, fixture);
  const { dataDir, jobId, failureId } = options, namespace = path.join(dataDir, "keyword_monthly_incremental"), jobs = path.join(dataDir, "keyword_monthly_refresh/jobs");
  await privateDirectory(namespace, fixture); await privateDirectory(jobs, fixture);
  const job = await read(path.join(jobs, jobId + ".json")); need(job.sha256 === options.expectedJobSha256, "KEYWORD_FAILED_RETRY_CHANGED"); const sourceKey = failedJob(job.value, jobId), i = job.value.intent;
  need(options.diagnosticPurpose === undefined || job.value.reasonCode === "KEYWORD_PREP_CHILD_FAILED", "KEYWORD_FAILED_RETRY_DIAGNOSTIC_PURPOSE_INVALID");
  need(fixture && process.platform === "win32" || job.stat.uid === process.getuid() && (job.stat.mode & 0o777) === 0o600, "KEYWORD_FAILED_RETRY_PRIVATE_SCOPE_REQUIRED");
  const jobRoot = path.join(namespace, "jobs", "refresh-job-" + failureId), failure = await read(path.join(dataDir, "keyword_monthly_analysis/refresh-receipts", "failed-incremental-" + sourceKey + "-" + failureId + ".json"), 32768), f = failure.value;
  need(failure.sha256 === options.expectedFailureSha256 && f.schemaVersion === 1 && f.sourceKey === sourceKey && f.jobRoot === jobRoot && f.code === job.value.reasonCode
    && f.publicationIntentAbsent === true && f.operatingPointerChanged === false && f.sourceCacheRetained === true && H.validIso(f.observedAt), "KEYWORD_FAILED_RETRY_FAILURE_UNVERIFIED");
  const input = await read(path.join(jobRoot, "job-input.json"), 1024 * 1024), e = input.value.evidence;
  need(input.value.schemaVersion === 1 && input.value.version === VERSION && input.value.dataDir === dataDir && e && e.runId === i.runId && e.keyword === i.keyword
    && e.manifestSha256 === i.manifestSha256 && (e.scheduleOccurrenceId || null) === i.scheduleOccurrenceId && H.validIso(e.finishedAt), "KEYWORD_FAILED_RETRY_SOURCE_MISMATCH");
  const proof = await read(path.join(jobRoot, "control/isolation.json"), 65536), p = proof.value;
  need(p.mode === "seccomp" && p.noNewPrivs === true && p.seccompMode === 2 && p.networkFdsClosed === true && p.expectedRoot === jobRoot
    && p.preflightOnly === false && p.environmentSanitizedForExec === true && p.unrestrictedFallbackAllowed === false && p.providerCalls === 0
    && H.SHA.test(p.guardSha256 || "") && H.SHA.test(p.nodeSha256 || "") && Number.isSafeInteger(p.pid) && p.pid > 0
    && ["tcpSocketDenied", "udpSocketDenied", "ipv6SocketDenied"].every(k => p.kernelProbe?.[k] === true)
    && ["socket", "socketpair", "connect", "sendto", "sendmsg"].every(k => p.kernelProbe?.syscallsDeniedWithEperm?.[k] === true)
    && p.nonStandardFdsClosedBeforeExec === true && p.nonStandardFdsRemainingBeforeExec === 0 && p.stdioLocalIPC === undefined
    && (f.childPid === undefined || f.childPid === p.pid), "KEYWORD_FAILED_RETRY_ISOLATION_UNVERIFIED");
  const identity = await A.codeIdentity(); need(identity.guardSha256 !== p.guardSha256 || options.diagnosticPurpose === "diagnose_prior_generic_child_failure", "KEYWORD_FAILED_RETRY_CODE_UNCHANGED");
  const manifest = await read(path.join(dataDir, "outputs", i.runId, "manifest.json"), 1024 * 1024), db = await read(path.join(dataDir, "history/collection_postprocess/runs", H.hash(Buffer.from(i.runId)) + ".json"), 128 * 1024);
  need(manifest.sha256 === i.manifestSha256 && manifest.value.keyword === i.keyword && manifest.value.collectionQuality?.status === "complete"
    && db.value.runId === i.runId && db.value.status === "complete" && db.value.result?.sourceManifestSha256 === i.manifestSha256 && db.value.finishedAt === e.finishedAt
    && (db.value.scheduleOccurrenceId ?? db.value.context?.scheduleOccurrenceId ?? null) === i.scheduleOccurrenceId, "KEYWORD_FAILED_RETRY_SOURCE_MISMATCH");
  for (const file of [path.join(namespace, "worker-lock.json"), path.join(namespace, "worker-lock-recovery-claim.json"), path.join(dataDir, "keyword_monthly_analysis/publish.lock"), path.join(jobRoot, "preparation-complete.json"),
    ...["intent-", "complete-"].map(prefix => path.join(dataDir, "keyword_monthly_analysis/refresh-receipts", prefix + sourceKey + ".json"))]) need(await absent(file), "KEYWORD_FAILED_RETRY_PUBLICATION_OR_LOCK_PRESENT");
  const publicPointer = await read(path.join(dataDir, "keyword_monthly_analysis/current.json"), 16384), pp = publicPointer.value;
  need(publicPointer.sha256 === options.expectedPublicPointerSha256 && pp.schemaVersion === 1 && H.SHA.test(pp.catalogSha256 || "")
    && input.value.initialBundle?.pointerSha256 === publicPointer.sha256 && input.value.initialBundle.generation === pp.generation && input.value.initialBundle.catalogSha256 === pp.catalogSha256,
  "KEYWORD_FAILED_RETRY_PUBLIC_POINTER_CHANGED");
  const pub = await publication(dataDir, pp.generation, publicPointer.sha256); need(pub.catalog.sha256 === pp.catalogSha256 && pub.catalog.bytes.length === pp.catalogBytes, "KEYWORD_FAILED_RETRY_PUBLICATION_INVALID");
  const sourcePointer = await read(path.join(namespace, "source-current.json"), 16384); need(sourcePointer.sha256 === options.expectedSourcePointerSha256, "KEYWORD_FAILED_RETRY_SOURCE_POINTER_CHANGED");
  const source = await require("./lib/keyword_monthly_incremental_state.cjs").createStore({ dataDir }).load(), last = source?.state.lastPublished;
  need(source && source.pointerSha256 === sourcePointer.sha256 && H.SHA.test(source.stateSha256) && last && H.SHA.test(last.stateSha256 || "") && H.SHA.test(last.sourceKey || "")
    && H.SHA.test(last.pointerSha256 || ""), "KEYWORD_FAILED_RETRY_SOURCE_CHECKPOINT_INVALID");
  const lastPublication = await publication(dataDir, last.generation, last.pointerSha256);
  const auditDir = A.authorizationDirectory(dataDir, jobId, identity.fingerprint);
  if (ownedAudit) need(ownedAudit.file === auditDir && H.identity(ownedAudit.stat, await privateDirectory(auditDir, fixture)), "KEYWORD_FAILED_RETRY_AUDIT_CHANGED");
  else need(await absent(auditDir), "KEYWORD_FAILED_RETRY_ALREADY_REVIEWED");
  const current = await read(job.file); need(current.sha256 === job.sha256 && H.same(current.stat, job.stat), "KEYWORD_FAILED_RETRY_CHANGED");
  const snapshot = { schemaVersion: 1, jobId, sourceKey, refreshVersion: VERSION, originalJobSha256: job.sha256, originalJobBytes: job.bytes.length,
    originalJobIdentity: Object.fromEntries(["dev", "ino", "size", "nlink", "mtimeMs", "ctimeMs"].map(k => [k, String(job.stat[k])])), attempts: 3, maxAttempts: 3, authorizedAttempt: 4,
    failureId, failureReceiptSha256: failure.sha256, jobInputSha256: input.sha256, failedIsolationSha256: proof.sha256, failedGuardSha256: p.guardSha256,
    currentGuardSha256: identity.guardSha256, codeFingerprint: identity.fingerprint, manifestSha256: manifest.sha256, dbReceiptSha256: db.sha256,
    publicPointerSha256: publicPointer.sha256, publicPublicationSha256: pub.receipt.sha256, sourcePointerSha256: sourcePointer.sha256, sourceStateSha256: source.stateSha256,
    lastPublishedPointerSha256: last.pointerSha256, lastPublishedReceiptSha256: lastPublication.receipt.sha256,
    publicPublicationVerification: pub.verification, lastPublishedVerification: lastPublication.verification, diagnosticPurpose: options.diagnosticPurpose ?? null };
  return { status: "review_required", snapshot, reviewSha256: H.hash(bytes(snapshot)), restartRequired: true, changed: false };
}
async function retryFailedCalculation(options, dependencies = {}) {
  const fixture = dependencies.fixture === true, first = await inspect(options, dependencies); if (options.mode === "inspect") return first;
  need(first.reviewSha256 === options.reviewSha256, "KEYWORD_FAILED_RETRY_REVIEW_MISMATCH");
  const { acquirePreparedConversionLease, MAINTENANCE_FILE } = require("./lib/keyword_monthly_maintenance.cjs"), operationId = crypto.randomUUID();
  const lease = await acquirePreparedConversionLease({ dataDir: options.dataDir, mode: "publish", operationId }), admission = fixture && dependencies.admit ? dependencies.admit : require("./lib/keyword_monthly_conversion_admission.cjs").waitForConversionIdle;
  let failed, result, mutated = false;
  try {
    const marker = await read(path.join(options.dataDir, "keyword_monthly_incremental", MAINTENANCE_FILE), 16384);
    need(marker.value.operationId === operationId && marker.value.mode === "publish", "KEYWORD_FAILED_RETRY_MAINTENANCE_CHANGED");
    const before = await admission(); need(before?.idle === true && before.authenticatedLoopbackOnly === true, "KEYWORD_FAILED_RETRY_RUNTIME_UNVERIFIED");
    const current = await inspect(options, dependencies); need(current.reviewSha256 === first.reviewSha256, "KEYWORD_FAILED_RETRY_CHANGED");
    const now = new Date(typeof options.now === "function" ? options.now() : Date.now()).toISOString(), operations = path.join(options.dataDir, "operations");
    try { await fs.mkdir(operations, { mode: 0o700 }); } catch (e) { if (e.code !== "EEXIST") throw e; }
    const op = await H.checked(operations, true); need(fixture && process.platform === "win32" || op.uid === process.getuid() && (op.mode & 0o022) === 0, "KEYWORD_FAILED_RETRY_PRIVATE_SCOPE_REQUIRED");
    const parent = path.join(operations, "keyword-failed-calculation-retry"); await privateDirectory(parent, fixture, true);
    const byJob = path.join(parent, options.jobId); await privateDirectory(byJob, fixture, true);
    const auditDir = A.authorizationDirectory(options.dataDir, options.jobId, first.snapshot.codeFingerprint); await fs.mkdir(auditDir, { mode: 0o700 }); const auditIdentity = await privateDirectory(auditDir, fixture);
    const jobFile = path.join(options.dataDir, "keyword_monthly_refresh/jobs", options.jobId + ".json"), original = await read(jobFile); need(original.sha256 === options.expectedJobSha256, "KEYWORD_FAILED_RETRY_CHANGED");
    const h0 = await fs.open(path.join(auditDir, "original-job.json"), "wx", 0o600); try { await h0.writeFile(original.bytes); await h0.sync(); } finally { await h0.close(); }
    need((await read(path.join(auditDir, "original-job.json"))).sha256 === original.sha256, "KEYWORD_FAILED_RETRY_AUDIT_READBACK");
    const reviewedPreflight = await H.writeNew(path.join(auditDir, "reviewed-preflight.json"), { ...first, operationId, reviewedAt: now });
    // The directory is now intentionally claimed. Recheck every evidence pin
    // except that exclusive directory before writing its authorization.
    const admitted = await admission(); need(admitted?.idle === true && admitted.authenticatedLoopbackOnly === true, "KEYWORD_FAILED_RETRY_RUNTIME_UNVERIFIED");
    const final = await inspect(options, dependencies, { file: auditDir, stat: auditIdentity });
    need(final.reviewSha256 === first.reviewSha256, "KEYWORD_FAILED_RETRY_CHANGED");
    const authorization = { schemaVersion: 1, kind: A.KIND, action: "authorize_one_derived_attempt", reason: "operator_reviewed_derived_failure_retry", jobId: options.jobId,
      refreshVersion: VERSION, codeFingerprint: first.snapshot.codeFingerprint, currentGuardSha256: first.snapshot.currentGuardSha256, failedGuardSha256: first.snapshot.failedGuardSha256,
      reviewSha256: first.reviewSha256, reviewedPreflightSha256: reviewedPreflight.sha256, originalJobSha256: original.sha256, intent: original.value.intent, attempts: 3, maxAttempts: 3, authorizedAttempt: 4, authorizedAt: now, diagnosticPurpose: first.snapshot.diagnosticPurpose };
    await H.writeNew(path.join(auditDir, "authorization.json"), authorization);
    const next = { ...original.value, status: "queued", reasonCode: A.REASON, updatedAt: now, startedAt: null, finishedAt: null, nextAttemptAt: now, recoveredAt: now, result: null,
      oneShotRetry: { schemaVersion: 1, kind: A.KIND, codeFingerprint: first.snapshot.codeFingerprint, reviewSha256: first.reviewSha256, originalJobSha256: original.sha256, authorizationSha256: H.hash(bytes(authorization)) } };
    const nextBytes = bytes(next); need(nextBytes.length <= 8192 && A.validRow(next), "KEYWORD_FAILED_RETRY_JOB_NOT_ELIGIBLE");
    await H.writeNew(path.join(auditDir, "planned-job.json"), next); await A.verifyAuthorization({ dataDir: options.dataDir, row: next });
    const finalAdmission = await admission(); need(finalAdmission?.idle === true && finalAdmission.authenticatedLoopbackOnly === true, "KEYWORD_FAILED_RETRY_RUNTIME_UNVERIFIED");
    need((await inspect(options, dependencies, { file: auditDir, stat: auditIdentity })).reviewSha256 === first.reviewSha256, "KEYWORD_FAILED_RETRY_CHANGED");
    const temporary = path.join(path.dirname(jobFile), options.jobId + "." + operationId + ".tmp"), parentIdentity = await H.checked(path.dirname(jobFile), true);
    const h = await fs.open(temporary, "wx", 0o600); try { await h.writeFile(nextBytes); await h.sync(); } finally { await h.close(); }
    const last = await read(jobFile), currentMarker = await read(marker.file, 16384);
    need(last.sha256 === original.sha256 && H.same(last.stat, original.stat) && H.identity(parentIdentity, await H.checked(path.dirname(jobFile), true)), "KEYWORD_FAILED_RETRY_CHANGED");
    need(currentMarker.sha256 === marker.sha256 && H.same(currentMarker.stat, marker.stat), "KEYWORD_FAILED_RETRY_MAINTENANCE_CHANGED");
    await fs.rename(temporary, jobFile); mutated = true; await syncDirectory(path.dirname(jobFile)); need((await read(jobFile)).sha256 === H.hash(nextBytes), "KEYWORD_FAILED_RETRY_NEEDS_READBACK");
    const receipt = { schemaVersion: 1, status: "queued", action: "reviewed_derived_failure_retry", reason: authorization.reason, operationId, jobId: options.jobId, refreshVersion: VERSION,
      sourceKey: first.snapshot.sourceKey, codeFingerprint: first.snapshot.codeFingerprint, reviewSha256: first.reviewSha256, originalJobSha256: original.sha256, queuedJobSha256: H.hash(nextBytes),
      authorizationSha256: next.oneShotRetry.authorizationSha256, attemptsPreserved: true, attempts: 3, maxAttempts: 3, authorizedAttempt: 4, originalBytesPreserved: true,
      collectorStarted: false, sourceWrites: 0, providerCalls: 0, restartRequired: true, queuedAt: now };
    await H.writeNew(path.join(auditDir, "retry-complete.json"), receipt); await syncDirectory(auditDir); result = { ...receipt, auditDir };
  } catch (e) { failed = mutated ? Object.assign(H.fault("KEYWORD_FAILED_RETRY_NEEDS_READBACK"), { mutationState: "job_changed_verify_audit" }) : e; }
  try { await lease.release(); } catch (e) { if (!failed) failed = e; else failed.maintenanceReleaseNeedsReview = true; }
  if (failed) throw failed; return result;
}
function args(values) {
  const out = {}; for (let n = 0; n < values.length; n += 2) { const key = values[n]?.replace(/^--/, ""); need(["mode", "job-id", "expected-job-sha", "failure-id", "expected-failure-sha", "expected-public-pointer-sha", "expected-source-pointer-sha", "review-sha", "diagnostic-purpose"].includes(key) && !Object.hasOwn(out, key) && values[n + 1], "KEYWORD_FAILED_RETRY_OPTIONS_INVALID"); out[key] = values[n + 1]; }
  return { mode: out.mode, dataDir: "/var/data", jobId: out["job-id"], expectedJobSha256: out["expected-job-sha"], failureId: out["failure-id"], expectedFailureSha256: out["expected-failure-sha"],
    expectedPublicPointerSha256: out["expected-public-pointer-sha"], expectedSourcePointerSha256: out["expected-source-pointer-sha"], ...(out["review-sha"] ? { reviewSha256: out["review-sha"] } : {}), ...(out["diagnostic-purpose"] ? { diagnosticPurpose: out["diagnostic-purpose"] } : {}) };
}
if (require.main === module) Promise.resolve().then(() => retryFailedCalculation(args(process.argv.slice(2)))).then(v => console.log(JSON.stringify(v))).catch(e => { console.log(JSON.stringify({ status: "hold", code: /^KEYWORD_[A-Z0-9_]{1,120}$/.test(e.code || "") ? e.code : "KEYWORD_FAILED_RETRY_HOLD", ...(e.mutationState ? { mutationState: e.mutationState } : {}) })); process.exitCode = 1; });
module.exports = { VERSION, inspectFailedCalculationRetry: inspect, retryFailedCalculation, failedJob, args };
