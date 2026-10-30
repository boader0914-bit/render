"use strict";
// Independent derived-data work AFTER exact collection + DB completion. This
// module never imports the application, starts a collector, or reads KOSIS.
// HTTP GETs must not call it. A failed refresh leaves the previous bundle active.
const fs = require("node:fs/promises"), path = require("node:path"), crypto = require("node:crypto");
const H = require("./lib/keyword_monthly_refresh_preparation.cjs");
const prep = require("./prepare_keyword_monthly_release.cjs");
const capture = require("./lib/keyword_monthly_source_copy.cjs");
const bundle = require("./lib/keyword_monthly_bundle.cjs");
const { inspectManifest, allowsDerivedUpdates } = require("./daily_collection_quality.cjs");
const JOB_MS = 60 * 60 * 1000, RESERVE_BYTES = 128 * 1024 * 1024;
const safeCause = error => /^(?:KEYWORD_|ISOLATION_)[A-Z0-9_]{1,150}$/.test(error?.code || "") ? error.code : "KEYWORD_MONTHLY_REFRESH_PREPARATION_FAILED";
async function maybeRead(file, maximum) { try { return await H.read(file, maximum); } catch (e) { if (e.code === "ENOENT") return null; throw e; } }
function currentIso(now) { const value = new Date(typeof now === "function" ? now() : now ?? Date.now()); H.need(Number.isFinite(value.getTime()), "KEYWORD_MONTHLY_REFRESH_CLOCK_INVALID"); return value.toISOString(); }
function kstDay(iso) { return new Date(Date.parse(iso) + 9 * 3600000).toISOString().slice(0, 10); }
async function manifestEvidence(dataDir, evidence) {
  const file = path.join(dataDir, "outputs", evidence.runId, "manifest.json"), saved = await H.read(file, H.LIMITS.manifestBytes);
  H.need(saved.sha256 === evidence.manifestSha256 && saved.value.keyword === evidence.keyword && saved.value.collectionQuality?.status === "complete"
    && inspectManifest(saved.value).status === "complete" && allowsDerivedUpdates(saved.value), "KEYWORD_MONTHLY_REFRESH_MANIFEST_NOT_COMPLETE");
  return { ...saved, range: H.rangeFromManifest(saved.value, evidence) };
}
async function planCatalog(inputs, now) {
  const parts = new Map(), scopes = [], seen = new Set();
  for (const input of inputs) {
    const index = await H.read(path.join(input.directory, "index.json"), 1024 * 1024);
    H.need(Array.isArray(input.exposeScopes) && input.exposeScopes.length > 0, "KEYWORD_MONTHLY_REFRESH_PREPARATION_INVALID");
    if (!parts.has(index.sha256)) parts.set(index.sha256, { key: index.sha256, indexSha256: index.sha256, indexBytes: index.bytes.length });
    for (const scope of input.exposeScopes) { const id = H.scopeId(scope); H.need(!seen.has(id), "KEYWORD_MONTHLY_REFRESH_DUPLICATE_SCOPE"); seen.add(id); scopes.push({ keyword: scope.keyword, month: scope.month, partition: index.sha256 }); }
  }
  const value = bundle.validateCatalog({ schemaVersion: 1, kind: "keyword_monthly_partition_bundle", createdAt: new Date(now).toISOString(), partitions: [...parts.values()], scopes: scopes.sort((a, b) => H.scopeId(a).localeCompare(H.scopeId(b))) });
  return { value, sha256: H.hash(Buffer.from(JSON.stringify(value))), scopeCount: scopes.length };
}
async function verifyPublished(outputDir, expectedCatalogSha256, wantedScopes, now) {
  const loaded = await bundle.loadBundle(outputDir);
  H.need(loaded.catalogRead.sha256 === expectedCatalogSha256, "KEYWORD_MONTHLY_REFRESH_PUBLICATION_NEEDS_READBACK");
  let publicationReceipt;
  try { publicationReceipt = await H.read(path.join(loaded.generationDir, "publication-receipt.json")); }
  catch (error) { throw H.fault("KEYWORD_MONTHLY_REFRESH_PUBLICATION_NEEDS_READBACK", safeCause(error)); }
  H.need(publicationReceipt.value.status === "published" && publicationReceipt.value.generation === loaded.pointer.generation && publicationReceipt.value.pointerSha256 === loaded.pointerRead.sha256
    && publicationReceipt.value.catalogSha256 === loaded.catalogRead.sha256, "KEYWORD_MONTHLY_REFRESH_PUBLICATION_NEEDS_READBACK");
  const service = bundle.createKeywordMonthlyBundleAnalysis({ projectionDir: outputDir, now: () => now }), options = await service.options();
  H.need(["available", "stale"].includes(options.status) && options.bundle.unavailablePartitions.length === 0, "KEYWORD_MONTHLY_REFRESH_PUBLICATION_NEEDS_READBACK");
  const scopes = [];
  for (const wanted of wantedScopes) {
    const row = options.keywords.find(k => k.keyword === wanted.keyword), query = { ...wanted, cutoffDate: row?.defaultCutoffs[wanted.month] };
    H.need(query.cutoffDate, "KEYWORD_MONTHLY_REFRESH_PUBLICATION_NEEDS_READBACK");
    const result = await service.analyze(query);
    H.need(["available", "stale"].includes(result.status) && result.snapshot && result.request.keyword === wanted.keyword && result.request.month === wanted.month && H.SHA.test(result.snapshot.sources?.digest || ""), "KEYWORD_MONTHLY_REFRESH_PUBLICATION_NEEDS_READBACK");
    scopes.push({ ...query, resultId: result.resultId, inputSha256: result.provenance.inputSha256, dataThrough: result.provenance.dataThrough, selectedDigest: result.snapshot.sources.digest, status: result.status });
  }
  return { generation: loaded.pointer.generation, pointerSha256: loaded.pointerRead.sha256, catalogSha256: loaded.catalogRead.sha256, publicationReceiptSha256: publicationReceipt.sha256, scopeCount: loaded.catalog.scopes.length, scopes };
}
async function removeOwnedTree(root, owner, expectedToken, expectedSourceKey) {
  H.absolute(root); H.need(/^(?:refresh-job-[a-f0-9-]{36}|refresh-copy-[a-f0-9-]{36}|keyword-monthly-source-[a-f0-9-]{36})$/.test(path.basename(root)) && owner === path.join(root, "refresh-owner.json"), "KEYWORD_MONTHLY_REFRESH_CLEANUP_OWNERSHIP");
  const marker = await H.read(owner, 16384), rootStamp = await H.checked(root, true);
  H.need(marker.value.token === expectedToken && marker.value.sourceKey === expectedSourceKey && marker.value.root === root
    && (process.platform === "win32" || (rootStamp.mode & 0o777) === 0o700) && (typeof process.getuid !== "function" || rootStamp.uid === process.getuid()), "KEYWORD_MONTHLY_REFRESH_CLEANUP_OWNERSHIP");
  await prep.treeBytes(root, H.LIMITS.scratchBytes);
  let count = 0;
  async function remove(directory, depth) {
    H.need(depth <= 32 && ++count <= 200000 && H.inside(root, directory), "KEYWORD_MONTHLY_REFRESH_CLEANUP_BOUND"); const parent = await H.checked(directory, true);
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name); if (file === owner) continue;
      const before = await H.checked(file, entry.isDirectory());
      if (before.isDirectory()) await remove(file, depth + 1);
      else { H.need(before.isFile() && before.nlink === 1 && H.same(before, await H.checked(file)) && H.identity(parent, await H.checked(directory, true)), "KEYWORD_MONTHLY_REFRESH_CLEANUP_OWNERSHIP");
        // A copied input is readonly. Windows requires clearing only this owned
        // file's readonly bit before unlink; canonical inputs are never touched.
        if (process.platform === "win32" && !(before.mode & 0o200)) { await fs.chmod(file, 0o600); const changed = await H.checked(file); H.need(H.identity(before, changed) && changed.nlink === 1 && changed.size === before.size, "KEYWORD_MONTHLY_REFRESH_CLEANUP_OWNERSHIP"); }
        await fs.unlink(file); }
    }
    H.need(H.identity(parent, await H.checked(directory, true)), "KEYWORD_MONTHLY_REFRESH_CLEANUP_OWNERSHIP");
    if (directory !== root) await fs.rmdir(directory);
  }
  await remove(root, 0); H.need((await H.read(owner, 16384)).sha256 === marker.sha256 && H.identity(rootStamp, await H.checked(root, true)), "KEYWORD_MONTHLY_REFRESH_CLEANUP_OWNERSHIP");
  await fs.unlink(owner); await fs.rmdir(root); return { removed: true, privateOwnedPathOnly: true, sourceKey: expectedSourceKey };
}
async function copyInDedicatedProcess({ codeRoot, nodePath, sourceDataDir, scratchParent, copyRoot, inspectionFile, execute = prep.runChild }) {
  const exporter = path.join(codeRoot, "scripts/export_keyword_monthly_source_copy.cjs"), reviewedFiles = [exporter, path.join(codeRoot, "scripts/lib/keyword_monthly_source_copy.cjs"), path.join(codeRoot, "scripts/lib/keyword_monthly_scratch_budget.cjs")];
  const pins = await Promise.all(reviewedFiles.map(file => prep.fileHash(file)));
  // capture.copy installs process-global fs guards while copying. It MUST run
  // in this disposable process, never in the live web process owning the queue.
  const child = await execute(nodePath, ["--no-warnings", "--max-old-space-size=256", exporter, "--mode", "copy", "--source-data", sourceDataDir,
    "--scratch-parent", scratchParent, "--inspection", inspectionFile, "--copy-root", copyRoot, "--include-prepared", "false"], { cwd: codeRoot });
  H.need(child.exitCode === 0 && prep.childStderrSafe(child) && child.stdout?.state === "complete" && child.stdout.sourceWrites === 0 && child.stdout.sourcePreserved === true
    && child.stdout.copyRoot === copyRoot && child.stdout.originalOutputBodiesCopied === 0 && child.stdout.ownScratchHardBytes === H.LIMITS.scratchBytes, "KEYWORD_MONTHLY_REFRESH_COPY_CHILD_INVALID");
  for (const pin of pins) { const after = await prep.fileHash(pin.file); H.need(after.sha256 === pin.sha256 && H.same(after.stat, pin.stat), "KEYWORD_MONTHLY_REFRESH_COPY_CODE_CHANGED"); }
  return child.stdout;
}
async function defaultPrepare({ options, evidence, manifest, initial, jobDir, copyRoot, operationsDir, admission, startedAt }, dependencies = {}) {
  const codeRoot = options.codeRoot, nodePath = options.nodePath || await fs.realpath(process.execPath), pythonPath = options.pythonPath || "/usr/bin/python3.11";
  const guardPath = path.join(codeRoot, "scripts/reconstruct_keyword_monthly_source_copy.cjs"), launcherPath = path.join(codeRoot, "scripts/launch_keyword_monthly_isolated.py");
  const pins = { node: await prep.fileHash(nodePath), guard: await prep.fileHash(guardPath), launcher: await prep.fileHash(launcherPath) };
  const inputPins = { "node-sha": pins.node.sha256, "guard-sha": pins.guard.sha256 };
  const execute = async (executable, argv, childOptions = {}) => {
    await admission(); const elapsed = Date.now() - startedAt; H.need(elapsed < JOB_MS, "KEYWORD_MONTHLY_REFRESH_JOB_TIME_BOUND");
    return prep.runChild(executable, argv, { ...childOptions, signal: options.signal, timeout: Math.min(prep.LIMITS.timeout, JOB_MS - elapsed) });
  };
  await admission();
  const inspection = await capture.inspect({ sourceDataDir: options.dataDir, scratchParent: options.scratchParent, includePrepared: false });
  H.need(inspection.canCopyWithReserve && inspection.copyBytes <= capture.CORE_COPY_MAX_BYTES && inspection.ownScratchHardBytes === H.LIMITS.scratchBytes, "KEYWORD_MONTHLY_REFRESH_SOURCE_COPY_BOUND");
  const inspectionFile = path.join(jobDir, "capture-inspection.json"); await prep.writeNew(inspectionFile, inspection);
  const copied = await copyInDedicatedProcess({ codeRoot, nodePath, sourceDataDir: options.dataDir, scratchParent: options.scratchParent, copyRoot, inspectionFile, execute });
  await H.writeNew(path.join(copyRoot, "refresh-owner.json"), { schemaVersion: 1, token: options.ownerToken, sourceKey: H.sourceKey(evidence), root: copyRoot });
  H.need(copied.state === "complete" && copied.sourceWrites === 0 && copied.sourcePreserved === true, "KEYWORD_MONTHLY_REFRESH_SOURCE_COPY_INVALID");
  const captured = await prep.read(path.join(copyRoot, "control/capture-complete.json"));
  H.need(captured.sha256 === copied.captureManifestSha256, "KEYWORD_MONTHLY_REFRESH_SOURCE_COPY_INVALID");
  const output = path.join(copyRoot, "refresh-discovery"), proofFile = path.join(copyRoot, "control/refresh-discovery-proof.json");
  const normalized = await execute(pythonPath, [launcherPath, "--copy-root", copyRoot, "--proof", proofFile, "--code-root", codeRoot, "--guard-sha256", pins.guard.sha256, "--node-sha256", pins.node.sha256, "--", nodePath, guardPath,
    "--mode", "discover", "--copy-root", copyRoot, "--code-root", codeRoot, "--isolation-proof", proofFile, "--expected-capture-sha", copied.captureManifestSha256, "--output", output], { cwd: codeRoot, receiptOnly: true });
  const proof = await prep.read(proofFile, 65536), discoveryFile = path.join(output, "discovery-complete.json"), discovery = await prep.read(discoveryFile);
  prep.isolation(proof.value, copyRoot, inputPins); prep.validateDiscovery(discovery.value, copied.captureManifestSha256);
  H.need(normalized.exitCode === 0 && normalized.receiptOnly === true && normalized.stdout === null && normalized.pid === proof.value.pid && discovery.value.isolation?.pid === normalized.pid && discovery.value.isolation.proofSha256 === proof.sha256, "KEYWORD_MONTHLY_REFRESH_DISCOVERY_ISOLATION_INVALID");
  const selection = H.selectCandidates(discovery.value, evidence.keyword, manifest.range, initial.catalog), filteredFile = path.join(copyRoot, "control/refresh-filtered-discovery.json");
  await prep.writeNew(filteredFile, { ...discovery.value, candidates: selection.candidates, filteredFromDiscoverySha256: discovery.sha256,
    refreshScopeSelection: { runId: evidence.runId, manifestSha256: evidence.manifestSha256, keyword: evidence.keyword, ...selection, basis: "recorded_run_stay_range_and_collection_month_plus_existing_successor_comparison" } });
  const prepDate = currentIso(options.now); H.need(Date.parse(prepDate) >= Date.parse(captured.value.capturedAt), "KEYWORD_MONTHLY_REFRESH_CLOCK_BEFORE_CAPTURE");
  const preparedRoot = path.join(jobDir, "prepared"), argv = ["--code-root", codeRoot, "--copy-root", copyRoot, "--prepared-root", preparedRoot, "--budget-root", operationsDir,
    "--discovery-complete", filteredFile, "--capture-sha", copied.captureManifestSha256, "--node-path", nodePath, "--node-sha", pins.node.sha256, "--guard-sha", pins.guard.sha256, "--launcher-path", launcherPath, "--python-path", pythonPath, "--prep-date", prepDate];
  const completed = await prep.run(argv, { runChild: execute, progress: options.onProgress || (() => {}) });
  H.need(completed.state === "complete" && completed.candidatesReconciled === true && completed.candidateCount === selection.candidates.length && completed.preparedCount === selection.candidates.length && completed.notObservedCount === 0
    && completed.providerCalls === 0 && completed.sourceWrites === 0 && completed.operatingMutations === 0 && completed.pointerPublished === false, "KEYWORD_MONTHLY_REFRESH_PREPARATION_INCOMPLETE");
  const plan = await H.read(completed.planFile, 1024 * 1024);
  H.need(plan.sha256 === completed.planSha256 && plan.value.inputs.length === selection.candidates.length && plan.value.inputs.every(input => input.exposeScopes?.length === 1 && selection.candidates.some(c => H.scopeId(c) === H.scopeId(input.exposeScopes[0]))), "KEYWORD_MONTHLY_REFRESH_PREPARATION_INVALID");
  return { inputs: plan.value.inputs, selection, preparedRoot, planFile: completed.planFile, planSha256: completed.planSha256, capturedAt: captured.value.capturedAt, captureSha256: captured.sha256,
    sourceInventorySha256: captured.value.sourceInventorySha256, prepDate, preparedCount: completed.preparedCount, scopeProofDigest: completed.scopeProofDigest,
    sourceWrites: 0, providerCalls: 0, originalOutputBodiesCopied: 0, strictIsolationVerified: true,
    parts: completed.prepared.map(part => ({ keyword: part.keyword, month: part.month, cutoffDate: part.cutoffDate, sourceSha256: part.sourceSha256, indexSha256: part.indexSha256, completeSha256: part.completeSha256, verificationSha256: part.verificationSha256 })) };
}
async function refreshKeywordMonthlyFromCompletedRun(supplied = {}, dependencies = {}) {
  const allowed = new Set(["dataDir", "codeRoot", "scratchParent", "evidence", "mode", "now", "nodePath", "pythonPath", "signal", "canPublish", "onProgress"]);
  H.need(supplied && typeof supplied === "object" && Object.keys(supplied).every(k => allowed.has(k)), "KEYWORD_MONTHLY_REFRESH_OPTIONS_INVALID");
  H.need(dependencies.fixture === true || process.platform === "linux", "KEYWORD_MONTHLY_REFRESH_LINUX_REQUIRED");
  const options = { ...supplied, mode: supplied.mode || "stage", now: supplied.now || (() => new Date()), scratchParent: supplied.scratchParent || "/tmp" };
  for (const key of ["dataDir", "codeRoot", "scratchParent"]) { H.absolute(options[key]); await H.checked(options[key], true); }
  H.need(["stage", "live"].includes(options.mode) && typeof options.canPublish === "function", "KEYWORD_MONTHLY_REFRESH_OPTIONS_INVALID");
  const evidence = H.validateEvidence(options.evidence), sourceKey = H.sourceKey(evidence), startedAt = Date.now(), liveDir = path.join(options.dataDir, "keyword_monthly_analysis");
  const admission = async () => {
    if (options.signal?.aborted) throw Object.assign(H.fault("KEYWORD_MONTHLY_REFRESH_ABORTED"), { deferred: true });
    H.need(Date.now() - startedAt < JOB_MS, "KEYWORD_MONTHLY_REFRESH_JOB_TIME_BOUND");
    if (await options.canPublish(evidence) !== true) throw Object.assign(H.fault("KEYWORD_MONTHLY_REFRESH_DEFERRED"), { deferred: true });
  };
  await admission(); const manifest = await manifestEvidence(options.dataDir, evidence), initial = await bundle.loadBundle(liveDir);
  // Original manifests and prior derived generations are read-only inputs. Only
  // the dedicated refresh receipt namespace can record this source key.
  let receiptDir = null, completeFile = null, intentFile = null;
  if (options.mode === "live") {
    receiptDir = path.join(liveDir, "refresh-receipts"); await H.ensurePrivateDirectory(receiptDir, { fixture: dependencies.fixture === true });
    completeFile = path.join(receiptDir, "complete-" + sourceKey + ".json"); intentFile = path.join(receiptDir, "intent-" + sourceKey + ".json");
    const complete = await maybeRead(completeFile);
    if (complete) { H.need(complete.value.sourceKey === sourceKey && complete.value.runId === evidence.runId && complete.value.manifestSha256 === evidence.manifestSha256 && complete.value.status === "published"
      && complete.value.mode === "live" && complete.value.generatedBy === "keyword_monthly_completed_run_refresh" && complete.value.refreshVersion === H.VERSION
      && ["pointerSha256", "catalogSha256", "publicationReceiptSha256"].every(k => H.SHA.test(complete.value[k] || "")), "KEYWORD_MONTHLY_REFRESH_RECEIPT_INVALID"); return { ...complete.value, repeatedSource: true }; }
    const intent = await maybeRead(intentFile);
    if (intent) {
      H.need(intent.value.sourceKey === sourceKey && intent.value.runId === evidence.runId && intent.value.manifestSha256 === evidence.manifestSha256 && H.SHA.test(intent.value.expectedCatalogSha256 || "") && Array.isArray(intent.value.scopes)
        && intent.value.mode === "live" && intent.value.generatedBy === "keyword_monthly_completed_run_refresh" && intent.value.refreshVersion === H.VERSION
        && /^[a-f0-9-]{36}$/.test(intent.value.ownerToken || "") && intent.value.jobId === intent.value.ownerToken && H.SHA.test(intent.value.previousPointerSha256 || ""), "KEYWORD_MONTHLY_REFRESH_RECEIPT_INVALID");
      // Never retry an uncertain promotion. Exact current catalog + validated
      // affected scopes is the only automatic recovery admitted here.
      if (initial.catalogRead.sha256 !== intent.value.expectedCatalogSha256) throw H.fault("KEYWORD_MONTHLY_REFRESH_PRIOR_INTENT_REQUIRES_READBACK");
      const publication = await verifyPublished(liveDir, intent.value.expectedCatalogSha256, intent.value.scopes, currentIso(options.now));
      const recovered = { schemaVersion: 1, status: "published", mode: "live", generatedBy: "keyword_monthly_completed_run_refresh", refreshVersion: H.VERSION, trigger: "completed_collection_postprocess", jobId: intent.value.ownerToken,
        sourceKey, runId: evidence.runId, keyword: evidence.keyword, manifestSha256: evidence.manifestSha256, scheduleOccurrenceId: evidence.scheduleOccurrenceId,
        ...publication, recoveredAfterPromotion: true, repeatedSource: false, dataThrough: intent.value.dataThrough, finishedAt: currentIso(options.now), providerCalls: 0, sourceWrites: 0, operatingPointerChanged: false, previousPointerSha256: intent.value.previousPointerSha256,
        strictIsolationVerified: intent.value.strictIsolationVerified === true, fixtureOnly: intent.value.fixtureOnly === true, executionBasis: intent.value.executionBasis };
      await H.writeNew(completeFile, recovered); return recovered;
    }
  }
  await prep.treeBytes(liveDir, H.LIMITS.bundleNamespaceBytes - H.LIMITS.generationBytes - RESERVE_BYTES);
  const operationsParent = path.join(options.dataDir, "operations");
  // The pre-existing operations parent may be shared by other read-only audits.
  // Do not chmod it or infer ownership of its contents. Only this date's exact
  // private budget directory and fresh UUID child must be private to this job.
  try { await H.checked(operationsParent, true); } catch (error) { if (error.code !== "ENOENT") throw error; await fs.mkdir(operationsParent, { mode: 0o700 }); await H.checked(operationsParent, true); }
  const operationsDir = path.join(operationsParent, "monthly-keyword-production-" + kstDay(currentIso(options.now)).replaceAll("-", ""));
  await H.ensurePrivateDirectory(operationsDir, { fixture: dependencies.fixture === true }); await prep.treeBytes(operationsDir, H.LIMITS.operationsBytes - RESERVE_BYTES);
  // A prior private copy from another preparation is never deleted or ignored.
  const other = (await fs.readdir(options.scratchParent, { withFileTypes: true })).filter(e => e.name.startsWith("keyword-monthly-source-") || e.name.startsWith("refresh-copy-"));
  H.need(other.length === 0, "KEYWORD_MONTHLY_REFRESH_OTHER_PREPARATION_PRESENT");
  const token = crypto.randomUUID(), jobDir = path.join(operationsDir, "refresh-job-" + token), copyContainer = path.join(options.scratchParent, "refresh-copy-" + token), copyRoot = path.join(copyContainer, "keyword-monthly-source-" + token);
  options.ownerToken = token; await fs.mkdir(jobDir, { mode: 0o700 }); await H.checked(jobDir, true);
  await H.writeNew(path.join(jobDir, "refresh-owner.json"), { schemaVersion: 1, token, sourceKey, root: jobDir });
  const source = { sourceKey, runId: evidence.runId, keyword: evidence.keyword, manifestSha256: evidence.manifestSha256, scheduleOccurrenceId: evidence.scheduleOccurrenceId };
  await H.writeNew(path.join(jobDir, "refresh-input.json"), { schemaVersion: 1, ...source, mode: options.mode, startedAt: currentIso(options.now), previousPointerSha256: initial.pointerRead.sha256, recordedRange: manifest.range,
    workBounds: H.LIMITS, applicationExplicitWritesOutsideDerivedOperations: 0, providerCalls: 0 });
  let prepared = null, promoted = false, result = null;
  try {
    // Own the private parent before the exporter can create even one partial
    // copy file. Killing a copying child therefore never leaves unowned work.
    await fs.mkdir(copyContainer, { mode: 0o700 }); await H.checked(copyContainer, true);
    await H.writeNew(path.join(copyContainer, "refresh-owner.json"), { schemaVersion: 1, token, sourceKey, root: copyContainer, copyRoot });
    await admission();
    const prepare = dependencies.fixture === true && dependencies.prepare ? dependencies.prepare : defaultPrepare;
    prepared = await prepare({ options, evidence, manifest, initial, jobDir, copyRoot, operationsDir, admission, startedAt });
    H.need(prepared && Array.isArray(prepared.inputs) && prepared.inputs.length > 0 && prepared.providerCalls === 0 && prepared.sourceWrites === 0 && prepared.strictIsolationVerified === true
      && H.SHA.test(prepared.captureSha256 || "") && H.SHA.test(prepared.sourceInventorySha256 || "") && H.validIso(prepared.capturedAt) && H.validIso(prepared.prepDate), "KEYWORD_MONTHLY_REFRESH_PREPARATION_INVALID");
    const expectedScopes = prepared.inputs.flatMap(row => row.exposeScopes);
    H.need(expectedScopes.every(s => s.keyword === evidence.keyword) && new Set(expectedScopes.map(H.scopeId)).size === expectedScopes.length, "KEYWORD_MONTHLY_REFRESH_PREPARATION_INVALID");
    const wanted = H.selectCandidates({ candidates: expectedScopes }, evidence.keyword, manifest.range, initial.catalog);
    H.need(expectedScopes.length === wanted.candidates.length, "KEYWORD_MONTHLY_REFRESH_PREPARATION_INVALID");
    const inputs = H.mergeInputs(initial, prepared.inputs), planned = await planCatalog(inputs, prepared.prepDate);
    const remaining = initial.catalog.scopes.filter(s => !expectedScopes.some(r => H.scopeId(r) === H.scopeId(s)));
    H.need(planned.value.scopes.length === remaining.length + expectedScopes.length && remaining.every(s => planned.value.scopes.some(r => H.scopeId(r) === H.scopeId(s) && r.partition === s.partition)), "KEYWORD_MONTHLY_REFRESH_UNCHANGED_SCOPE_LOST");
    const outputDir = options.mode === "live" ? liveDir : path.join(jobDir, "staged-bundle");
    if (options.mode === "stage") { await fs.mkdir(outputDir, { mode: 0o700 }); receiptDir = path.join(jobDir, "receipts"); await fs.mkdir(receiptDir, { mode: 0o700 }); intentFile = path.join(receiptDir, "intent-" + sourceKey + ".json"); completeFile = path.join(receiptDir, "complete-" + sourceKey + ".json"); }
    await admission(); await manifestEvidence(options.dataDir, evidence);
    H.need((await bundle.loadBundle(liveDir)).pointerRead.sha256 === initial.pointerRead.sha256, "KEYWORD_MONTHLY_REFRESH_POINTER_CHANGED");
    const intent = { schemaVersion: 1, ...source, mode: options.mode, generatedBy: "keyword_monthly_completed_run_refresh", refreshVersion: H.VERSION, trigger: "completed_collection_postprocess", jobId: token,
      expectedCatalogSha256: planned.sha256, previousPointerSha256: initial.pointerRead.sha256, scopes: expectedScopes,
      dataThrough: prepared.capturedAt, preparedPlanSha256: prepared.planSha256, captureSha256: prepared.captureSha256, sourceInventorySha256: prepared.sourceInventorySha256, scopeProofDigest: prepared.scopeProofDigest,
      jobDir, copyRoot, copyContainer, ownerToken: token, createdAt: currentIso(options.now), strictIsolationVerified: dependencies.fixture !== true, fixtureOnly: dependencies.fixture === true,
      executionBasis: dependencies.fixture === true ? "injected_preparation_fixture_not_fresh_kernel_validation" : "fresh_physical_capture_and_strict_isolated_normalization", providerCalls: 0, sourceWrites: 0 };
    const publish = dependencies.fixture === true && dependencies.publish ? dependencies.publish : bundle.publishKeywordMonthlyBundle;
    const publication = await publish({ inputs, outputDir, now: prepared.prepDate, expectedCurrentSha256: options.mode === "live" ? initial.pointerRead.sha256 : null, maxTotalBytes: H.LIMITS.generationBytes,
      beforePromote: async () => { await admission(); await manifestEvidence(options.dataDir, evidence); H.need((await planCatalog(inputs, prepared.prepDate)).sha256 === planned.sha256, "KEYWORD_MONTHLY_REFRESH_PLAN_CHANGED"); H.need((await bundle.loadBundle(liveDir)).pointerRead.sha256 === initial.pointerRead.sha256, "KEYWORD_MONTHLY_REFRESH_POINTER_CHANGED");
        // Record an uncertain-promotion intent only at the last safe point,
        // after the publisher's expensive input validation and admission check.
        await admission(); await H.writeNew(intentFile, intent); } });
    promoted = true; H.need(publication.status === "published" && publication.catalogSha256 === planned.sha256 && publication.providerCalls === 0 && publication.kosisReadOrChanged === false, "KEYWORD_MONTHLY_REFRESH_PUBLICATION_NEEDS_READBACK");
    const verified = await verifyPublished(outputDir, planned.sha256, expectedScopes, prepared.prepDate);
    if (options.mode === "stage") H.need((await bundle.loadBundle(liveDir)).pointerRead.sha256 === initial.pointerRead.sha256, "KEYWORD_MONTHLY_REFRESH_STAGING_CHANGED_LIVE_POINTER");
    result = { schemaVersion: 1, status: options.mode === "live" ? "published" : "staged", ...source, mode: options.mode, generatedBy: "keyword_monthly_completed_run_refresh", refreshVersion: H.VERSION,
      trigger: "completed_collection_postprocess", jobId: token, ...verified, affectedScopeCount: expectedScopes.length,
      unchangedScopeCount: remaining.length, unchangedScopePartitionBindingsPreserved: true, previousPointerSha256: initial.pointerRead.sha256, dataThrough: prepared.capturedAt,
      captureSha256: prepared.captureSha256, sourceInventorySha256: prepared.sourceInventorySha256, scopeProofDigest: prepared.scopeProofDigest, preparedParts: prepared.parts,
      finishedAt: currentIso(options.now), providerCalls: 0, sourceWrites: 0, collectorStarted: false, kosisReadOrChanged: false, strictIsolationVerified: dependencies.fixture !== true,
      operatingPointerChanged: options.mode === "live", stagingBundleDir: options.mode === "stage" ? outputDir : null, fullSourceAudit: false, repeatedSource: false,
      executionBasis: dependencies.fixture === true ? "injected_preparation_fixture_not_fresh_kernel_validation" : "fresh_physical_capture_and_strict_isolated_normalization", fixtureOnly: dependencies.fixture === true };
    if (options.mode === "stage") result.retainedValidationWork = { jobDir, copyRoot, copyContainer, ownerToken: token, sourceKey, cleanupHelper: "removeOwnedTree_copyContainer_then_jobDir_after_explicit_validation" };
    await H.writeNew(completeFile, result);
    // Only an acknowledged live publication may clean generated work. Stage
    // artifacts remain isolated for the explicitly requested real-copy audit.
    if (options.mode === "live") {
      const cleanup = [];
      try {
        cleanup.push(await removeOwnedTree(copyContainer, path.join(copyContainer, "refresh-owner.json"), token, sourceKey));
        cleanup.push(await removeOwnedTree(jobDir, path.join(jobDir, "refresh-owner.json"), token, sourceKey));
        await H.writeNew(path.join(receiptDir, "cleanup-" + sourceKey + ".json"), { schemaVersion: 1, sourceKey, status: "complete", cleanup, finishedAt: currentIso(options.now) });
      } catch (error) { result.cleanupNeedsVerification = true; result.cleanupCode = safeCause(error);
        try { await H.writeNew(path.join(receiptDir, "cleanup-needs-review-" + sourceKey + ".json"), { schemaVersion: 1, sourceKey, status: "needs_verification", code: result.cleanupCode, publicationAlreadyVerified: true, observedAt: currentIso(options.now) }); } catch {}
      }
    }
    return result;
  } catch (error) {
    // Once a promotion intent exists, even an AbortSignal is not permission to
    // discard proof or retry. A publisher may have renamed the pointer before
    // the exception reached us. Missing/unreadable intent proof is also a hold.
    let intentUncertain = false;
    if (intentFile !== null) { try { intentUncertain = Boolean(await maybeRead(intentFile)); } catch { intentUncertain = true; } }
    const publicationUncertain = Boolean(error.publicationState || promoted || intentUncertain);
    const abortBeforePromotion = ["KEYWORD_MONTHLY_REFRESH_ABORTED", "KEYWORD_PREP_CHILD_ABORTED"].includes(error.code), deferred = error.deferred === true || abortBeforePromotion;
    const causeCode = safeCause(error), code = publicationUncertain ? "KEYWORD_MONTHLY_REFRESH_PUBLICATION_NEEDS_READBACK" : abortBeforePromotion ? "KEYWORD_MONTHLY_REFRESH_ABORTED" : /^KEYWORD_MONTHLY_REFRESH_/.test(error.code || "") ? error.code : "KEYWORD_MONTHLY_REFRESH_PREPARATION_FAILED";
    const failure = { schemaVersion: 1, ...source, mode: options.mode, code, causeCode, pointerMayHaveBeenPromoted: publicationUncertain,
      previousBundlePreservedWhenNotPromoted: !publicationUncertain, failedAt: currentIso(options.now), generatedWorkRetained: true, providerCalls: 0, sourceWrites: 0 };
    try { await H.writeNew(path.join(jobDir, "refresh-failed.json"), failure); } catch {}
    // Ordinary admission deferral is not an uncertain acknowledgement. Only
    // when the same old pointer is still active AND no promotion intent exists
    // can this process discard its own fresh UUID work for a later clean retry.
    // Preserve compact durable evidence outside that owned job before cleanup.
    let deferredCleanupVerified = false;
    if (deferred && !publicationUncertain) {
      try {
        H.need((await bundle.loadBundle(liveDir)).pointerRead.sha256 === initial.pointerRead.sha256 && (intentFile === null || !await maybeRead(intentFile)), "KEYWORD_MONTHLY_REFRESH_DEFERRED_CLEANUP_UNCERTAIN");
        const compactReceiptDir = options.mode === "live" ? receiptDir : operationsDir;
        await H.writeNew(path.join(compactReceiptDir, "deferred-" + sourceKey + "-" + token + ".json"), { ...failure, cleanupRequested: true, oldPointerReadbackVerified: true, noPromotionIntentVerified: true });
        const cleanup = [];
        cleanup.push(await removeOwnedTree(copyContainer, path.join(copyContainer, "refresh-owner.json"), token, sourceKey));
        cleanup.push(await removeOwnedTree(jobDir, path.join(jobDir, "refresh-owner.json"), token, sourceKey));
        await H.writeNew(path.join(compactReceiptDir, "deferred-cleanup-" + sourceKey + "-" + token + ".json"), { schemaVersion: 1, sourceKey, status: "complete", cleanup, finishedAt: currentIso(options.now) });
        deferredCleanupVerified = true;
      } catch (cleanupError) { throw Object.assign(H.fault("KEYWORD_MONTHLY_REFRESH_DEFERRED_CLEANUP_NEEDS_REVIEW", safeCause(cleanupError)), { deferred: false }); }
    }
    throw Object.assign(H.fault(code, causeCode), { ...(deferredCleanupVerified ? { deferred: true } : {}), ...(publicationUncertain ? { publicationState: "pointer_was_promoted_verify_current" } : {}) });
  }
}
module.exports = { refreshKeywordMonthlyFromCompletedRun, manifestEvidence, planCatalog, verifyPublished, defaultPrepare, copyInDedicatedProcess, removeOwnedTree, JOB_MS };
if (require.main === module) {
  // Admission and the exact durable completion reader belong to the trusted
  // host adapter. A bare CLI cannot silently skip those callback contracts.
  process.stderr.write(JSON.stringify({ code: "KEYWORD_MONTHLY_REFRESH_EXPLICIT_ADAPTER_REQUIRED" }) + "\n");
  process.exitCode = 1;
}
