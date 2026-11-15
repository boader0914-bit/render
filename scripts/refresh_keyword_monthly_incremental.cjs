"use strict";
// Independent completed-run worker. Source checkpoint admission is incremental;
// dirty projections use the unchanged pure monthly calculator and atomic bundle.
const fs = require("node:fs/promises"), native = require("node:fs"), path = require("node:path"), crypto = require("node:crypto"), zlib = require("node:zlib");
const H = require("./lib/keyword_monthly_refresh_preparation.cjs"), prep = require("./prepare_keyword_monthly_release.cjs"), bundle = require("./lib/keyword_monthly_bundle.cjs");
const { manifestEvidence, planCatalog, removeOwnedTree } = require("./refresh_keyword_monthly_from_completed_run.cjs");
const { VERSION } = require("./lib/keyword_monthly_incremental_plan.cjs");
const { createStore, saveBytes } = require("./lib/keyword_monthly_incremental_state.cjs");
const { acquireWorkerLock } = require("./lib/keyword_monthly_worker_lock.cjs");
const { inspectWorkerLock, withWorkerLock } = require("./lib/keyword_monthly_incremental_lock.cjs");
const { preparedPublicationCandidate } = require("./lib/keyword_monthly_publication_candidate.cjs");
const { createKeywordMonthlySourceDelta } = require("./lib/keyword_monthly_source_delta.cjs"), { events } = require("./lib/keyword_monthly_incremental_context.cjs");
const { verifyInventory, verifyDependencies } = require("./lib/keyword_monthly_incremental_inputs.cjs");
const failure = require("./lib/keyword_monthly_incremental_failure.cjs");
const OWNER = "keyword_monthly_incremental_refresh", BASIS = "verified_incremental_source_checkpoint_and_dirty_partition_rebuild";
const keyFor = e => H.hash(JSON.stringify([VERSION, e.runId, e.manifestSha256, e.keyword]));
async function maybeRead(file, max) { try { return await H.read(file, max); } catch (e) { if (e.code === "ENOENT") return null; throw e; } }
async function privateDir(file) { await H.ensurePrivateDirectory(file, { fixture: process.platform === "win32" }); }
async function retainedPreparation(intent, receiptDir) {
  const file = path.join(receiptDir, "incremental-evidence-" + intent.sourceKey + ".json.gz");
  H.need(intent.preparationEvidenceFile === file && H.SHA.test(intent.preparationEvidenceSha256 || ""), "KEYWORD_INCREMENTAL_RETAINED_EVIDENCE_INVALID");
  const before = await H.checked(file); H.need(before.size > 0 && before.size <= 16 * 1024 * 1024, "KEYWORD_INCREMENTAL_RETAINED_EVIDENCE_BOUND");
  const handle = await fs.open(file, native.constants.O_RDONLY | (native.constants.O_NOFOLLOW || 0)); let bytes;
  try { H.need(H.same(before, await handle.stat()), "KEYWORD_INCREMENTAL_RETAINED_EVIDENCE_CHANGED"); const buffer = Buffer.alloc(before.size + 1); let offset = 0;
    while (offset < buffer.length) { const r = await handle.read(buffer, offset, buffer.length - offset, offset); if (!r.bytesRead) break; offset += r.bytesRead; }
    H.need(offset === before.size && H.same(before, await handle.stat()), "KEYWORD_INCREMENTAL_RETAINED_EVIDENCE_CHANGED"); bytes = buffer.subarray(0, offset);
  } finally { await handle.close(); }
  H.need(H.same(before, await H.checked(file)) && H.hash(bytes) === intent.preparationEvidenceSha256, "KEYWORD_INCREMENTAL_RETAINED_EVIDENCE_CHANGED");
  const raw = zlib.gunzipSync(bytes, { maxOutputLength: 16 * 1024 * 1024 }); H.need(H.hash(raw) === intent.preparationSha256, "KEYWORD_INCREMENTAL_RETAINED_EVIDENCE_CHANGED");
  const value = JSON.parse(raw); H.need(value.version === VERSION && value.status === "complete" && value.stateSha256 === intent.stateSha256
    && value.providerCalls === 0 && value.sourceWrites === 0 && value.appEntryExecutions === 0 && value.kosisReadOrChanged === false
    && H.SHA.test(value.isolation?.proofSha256 || ""), "KEYWORD_INCREMENTAL_RETAINED_EVIDENCE_INVALID"); return value;
}
async function refreshKeywordMonthlyIncremental(options, dependencies = {}) {
  H.need(options && Object.keys(options).every(k => ["dataDir", "codeRoot", "scratchParent", "mode", "evidence", "now", "signal", "canPublish", "readDeltaEvidence"].includes(k)), "KEYWORD_INCREMENTAL_OPTIONS_INVALID");
  H.need(dependencies.fixture === true || process.platform === "linux", "KEYWORD_INCREMENTAL_LINUX_REQUIRED");
  const { dataDir, codeRoot } = options; H.absolute(dataDir); H.absolute(codeRoot); await H.checked(dataDir, true); await H.checked(codeRoot, true);
  H.need(options.mode === "live" && typeof options.canPublish === "function" && typeof options.readDeltaEvidence === "function", "KEYWORD_INCREMENTAL_ADAPTER_REQUIRED");
  const clock = () => new Date(typeof options.now === "function" ? options.now() : Date.now()).toISOString(), evidence = H.validateEvidence(options.evidence), sourceKey = keyFor(evidence), started = Date.now();
  const admission = async () => {
    if (options.signal?.aborted) throw Object.assign(H.fault("KEYWORD_INCREMENTAL_DEFERRED"), { deferred: true });
    H.need(Date.now() - started < 60 * 60000, "KEYWORD_INCREMENTAL_JOB_TIME_BOUND");
    if (await options.canPublish(evidence) !== true) throw Object.assign(H.fault("KEYWORD_INCREMENTAL_DEFERRED"), { deferred: true });
  };
  await admission(); const manifest = await manifestEvidence(dataDir, evidence), liveDir = path.join(dataDir, "keyword_monthly_analysis"), receiptDir = path.join(liveDir, "refresh-receipts"); await privateDir(receiptDir);
  const completeFile = path.join(receiptDir, "complete-" + sourceKey + ".json"), intentFile = path.join(receiptDir, "intent-" + sourceKey + ".json");
  const complete = await maybeRead(completeFile);
  if (complete) {
    H.need(complete.value.generatedBy === OWNER && complete.value.refreshVersion === VERSION && complete.value.sourceKey === sourceKey && complete.value.runId === evidence.runId && complete.value.manifestSha256 === evidence.manifestSha256
      && complete.value.keyword === evidence.keyword && (complete.value.scheduleOccurrenceId || null) === evidence.scheduleOccurrenceId && complete.value.mode === "live"
      && complete.value.status === "published" && ["stateSha256", "preparationSha256", "pointerSha256", "catalogSha256", "publicationReceiptSha256", "previousPointerSha256"].every(k => H.SHA.test(complete.value[k] || ""))
      && /^[a-f0-9]{32}$/.test(complete.value.generation || "") && complete.value.executionBasis === BASIS && complete.value.strictIsolationVerified === true
      && complete.value.fixtureOnly === (dependencies.fixture === true) && H.validIso(complete.value.finishedAt) && complete.value.providerCalls === 0 && complete.value.sourceWrites === 0
      && complete.value.incrementalValidated === true, "KEYWORD_INCREMENTAL_COMPLETE_INVALID");
    return { ...complete.value, repeatedSource: true, operatingPointerChanged: false };
  }
  const store = createStore({ dataDir, now: clock, admission }); await store.initialize();
  // Keep the already-deployed writer/reviewed recovery format. Diagnostics do
  // not acquire a second lock or rewrite an incompatible owner record.
  let workerLease;
  try { workerLease = await acquireWorkerLock({ directory: store.directory, sourceKey, version: VERSION, now: clock, fixture: dependencies.fixture === true }); }
  catch (error) {
    if (error.code === "KEYWORD_INCREMENTAL_WORKER_LOCKED") {
      try { error.lockDiagnostic = await inspectWorkerLock({ lockFile: path.join(store.directory, "worker-lock.json"), now: clock }); } catch {}
    }
    throw error;
  }
  const token = workerLease.jobId;
  return withWorkerLock(workerLease, async () => {
  let promoted = false, jobRoot = null;
  try {
    const initial = await bundle.loadBundle(liveDir), prior = await maybeRead(intentFile);
    if (prior) {
      const intent = prior.value; H.need(intent.generatedBy === OWNER && intent.refreshVersion === VERSION && intent.sourceKey === sourceKey && intent.runId === evidence.runId
        && intent.manifestSha256 === evidence.manifestSha256 && intent.keyword === evidence.keyword && (intent.scheduleOccurrenceId || null) === evidence.scheduleOccurrenceId && intent.mode === "live"
        && ["expectedCatalogSha256", "stateSha256", "preparationSha256", "previousPointerSha256"].every(k => H.SHA.test(intent[k] || ""))
        && /^[a-f0-9-]{36}$/.test(intent.jobId || "") && intent.executionBasis === BASIS && intent.strictIsolationVerified === true && intent.fixtureOnly === (dependencies.fixture === true)
        && Array.isArray(intent.scopes) && intent.scopes.length > 0 && intent.scopes.length <= 128 && intent.incrementalValidated === true, "KEYWORD_INCREMENTAL_PRIOR_INTENT_INVALID");
      H.need(initial.catalogRead.sha256 === intent.expectedCatalogSha256, "KEYWORD_INCREMENTAL_PUBLICATION_NEEDS_READBACK");
      const retained = await retainedPreparation(intent, receiptDir); await store.readCheckpoint(intent.stateSha256);
      H.need(retained.publicationPreparation && retained.publicationPreparationSha256 === H.hash(JSON.stringify(retained.publicationPreparation)), "KEYWORD_INCREMENTAL_PREVALIDATION_REQUIRED");
      const publication = await bundle.verifyPrevalidatedKeywordMonthlyBundle({ projectionDir: liveDir, expectedCatalogSha256: intent.expectedCatalogSha256,
        preparation: retained.publicationPreparation, wantedScopes: intent.scopes });
      const result = { ...intent, ...publication, status: "published", mode: "live", finishedAt: clock(), recoveredAfterPromotion: true, repeatedSource: false, operatingPointerChanged: false, providerCalls: 0, sourceWrites: 0,
        parentProjectionAnalyses: dependencies.fixture === true ? null : 0, semanticValidationExecution: dependencies.fixture === true ? "fixture_child_protocol" : "strict_isolated_child", semanticPrevalidationSha256: retained.publicationPreparationSha256 };
      delete result.expectedCatalogSha256; await H.writeNew(completeFile, result); return result;
    }
    const free = await fs.statfs(dataDir, { bigint: true }); H.need(free.bavail * free.bsize >= 512n * 1024n * 1024n + BigInt(H.LIMITS.scratchBytes) + 64n * 1024n * 1024n, "KEYWORD_INCREMENTAL_DISK_RESERVE");
    const scratchParent = path.resolve(options.scratchParent || require("node:os").tmpdir()); await H.checked(scratchParent, true);
    const foreignPreparations = (await fs.readdir(scratchParent, { withFileTypes: true })).filter(e => e.name.startsWith("keyword-monthly-source-") || e.name.startsWith("refresh-copy-"));
    H.need(foreignPreparations.length === 0, "KEYWORD_INCREMENTAL_OTHER_PREPARATION_PRESENT");
    await prep.treeBytes(store.directory, 960 * 1024 ** 2); await prep.treeBytes(liveDir, H.LIMITS.bundleNamespaceBytes - H.LIMITS.generationBytes - 128 * 1024 ** 2);
    const outbox = createKeywordMonthlySourceDelta({ dataDir }), inventory = await events(outbox), current = await store.load(), applied = new Set(current?.state.appliedEvents || []), admittedRunIds = new Set(), admittedEvidence = new Map();
    for (const descriptor of inventory.descriptors) if (!applied.has(descriptor.eventId) && descriptor.kind === "history") {
      const r = await outbox.readEvent(descriptor.eventId); H.need(r.status === "complete" && r.eventSha256 === descriptor.eventSha256, "KEYWORD_INCREMENTAL_OUTBOX_CHANGED");
      const runId = r.event.payload.runId; H.need(typeof runId === "string", "KEYWORD_INCREMENTAL_DELTA_RUN_UNKNOWN");
      const proof = await options.readDeltaEvidence(runId);
      if (proof?.status === "waiting") throw Object.assign(H.fault("KEYWORD_INCREMENTAL_DELTA_DB_PENDING"), { deferred: true });
      H.need(proof?.runId === runId && proof.status === "complete" && proof.quality === "complete" && proof.postprocessStatus === "complete" && H.SHA.test(proof.manifestSha256 || ""), "KEYWORD_INCREMENTAL_DELTA_DB_NOT_VERIFIED");
      admittedRunIds.add(runId);
      admittedEvidence.set(runId, H.validateEvidence(proof));
    }
    const jobs = path.join(store.directory, "jobs"); await privateDir(jobs); jobRoot = path.join(jobs, "refresh-job-" + token); await privateDir(jobRoot); await privateDir(path.join(jobRoot, "control"));
    await H.writeNew(path.join(jobRoot, "refresh-owner.json"), { schemaVersion: 1, token, sourceKey, root: jobRoot });
    const initialBundle = { generation: initial.pointer.generation, pointerSha256: initial.pointerRead.sha256, catalogSha256: initial.catalogRead.sha256 };
    const capturedAt = clock(), job = { schemaVersion: 1, version: VERSION, dataDir, evidence, range: manifest.range, catalog: initial.catalog, initialBundle, capturedAt,
      outboxInventorySha256: inventory.inventory, admittedRunIds: [...admittedRunIds], admittedEvidence: [...admittedEvidence.values()], expectedSourceStateSha256: current?.stateSha256 || null };
    const jobInput = path.join(jobRoot, "job-input.json"); await saveBytes(jobInput, Buffer.from(JSON.stringify(job)), 1024 * 1024);
    const node = await fs.realpath(process.execPath), guard = path.join(codeRoot, "scripts/reconstruct_keyword_monthly_incremental.cjs"), launcher = path.join(codeRoot, "scripts/launch_keyword_monthly_isolated.py");
    const pins = await Promise.all([node, guard, launcher, ...["keyword_monthly_bundle.cjs", "keyword_monthly_analysis.cjs", "monthly_reports.cjs", "monthly_report_comparison.cjs", "keyword_monthly_incremental_failure.cjs"].map(file => path.join(codeRoot, "scripts/lib", file))].map(file => prep.fileHash(file))), proofFile = path.join(jobRoot, "control/isolation.json"), preparationFile = path.join(jobRoot, "preparation-complete.json");
    for (const file of [proofFile, preparationFile, failure.failureFile(jobRoot)]) {
      try { await fs.lstat(file); throw H.fault("KEYWORD_INCREMENTAL_CHILD_RECEIPT_PREEXISTING"); }
      catch (e) { if (e.code !== "ENOENT") throw e; }
    }
    const execute = dependencies.fixture === true && dependencies.execute ? dependencies.execute : prep.runChild;
    await admission();
    let child;
    try { child = await execute("/usr/bin/python3.11", [launcher, "--copy-root", jobRoot, "--proof", proofFile, "--code-root", codeRoot,
      "--guard-name", "reconstruct_keyword_monthly_incremental.cjs", "--guard-sha256", pins[1].sha256, "--node-sha256", pins[0].sha256,
      "--node-max-old-space-size", "1024", "--", node, guard, "--input", jobInput, "--input-sha", H.hash(Buffer.from(JSON.stringify(job))),
      "--job-root", jobRoot, "--code-root", codeRoot, "--isolation-proof", proofFile], { cwd: codeRoot, signal: options.signal, timeout: 55 * 60000, receiptOnly: true }); }
    catch (caught) {
      const error = caught && typeof caught === "object" ? caught : H.fault("KEYWORD_PREP_CHILD_FAILED"), ended = failure.termination(error);
      let childFailure = { status: "missing" };
      if (ended.childPid) {
        try {
          const saved = await failure.readFailure({ jobRoot, inputSha256: H.hash(Buffer.from(JSON.stringify(job))), sourceKey, version: VERSION, pid: ended.childPid,
            guardSha256: pins[1].sha256, nodeSha256: pins[0].sha256 });
          if (saved) {
            const proof = await H.read(proofFile, 65536); prep.isolation(proof.value, jobRoot, { "node-sha": pins[0].sha256, "guard-sha": pins[1].sha256 });
            H.need(proof.value.pid === ended.childPid, "KEYWORD_INCREMENTAL_ISOLATION_BINDING_INVALID");
            for (const pin of pins) H.need((await prep.fileHash(pin.file)).sha256 === pin.sha256, "KEYWORD_INCREMENTAL_CODE_CHANGED");
            childFailure = saved; error.childCode = saved.code;
          }
        } catch (invalid) { childFailure = { status: "invalid", reasonCode: prep.safeChildCode(invalid.code) || "KEYWORD_INCREMENTAL_FAILURE_EVIDENCE_INVALID" }; }
      } else childFailure = { status: "unavailable", reasonCode: "KEYWORD_INCREMENTAL_CHILD_PID_UNAVAILABLE" };
      Object.assign(error, ended, { childFailure }); throw error;
    }
    if (options.signal?.aborted || child.code === "KEYWORD_PREP_CHILD_ABORTED") throw Object.assign(H.fault("KEYWORD_INCREMENTAL_DEFERRED"), { deferred: true });
    H.need(child.exitCode === 0 && child.receiptOnly === true && child.stdout === null && child.stderrBytes === null
      && Number.isSafeInteger(child.pid) && child.pid > 0, "KEYWORD_INCREMENTAL_CHILD_INVALID");
    for (const pin of pins) H.need((await prep.fileHash(pin.file)).sha256 === pin.sha256, "KEYWORD_INCREMENTAL_CODE_CHANGED");
    const preparation = await H.read(preparationFile, 16 * 1024 * 1024), prepared = preparation.value;
    H.need(prepared.version === VERSION && prepared.status === "complete" && prepared.executionBasis === BASIS && prepared.capturedAt === capturedAt
      && prepared.providerCalls === 0 && prepared.sourceWrites === 0 && prepared.appEntryExecutions === 0 && prepared.kosisReadOrChanged === false
      && prepared.isolation?.pid === child.pid && H.SHA.test(prepared.stateSha256 || "") && Array.isArray(prepared.inputs) && prepared.inputs.length > 0, "KEYWORD_INCREMENTAL_PREPARATION_INVALID");
    H.need(JSON.stringify(prepared.initialBundle) === JSON.stringify(initialBundle) && prepared.publicationPreparation
      && prepared.publicationPreparationSha256 === H.hash(JSON.stringify(prepared.publicationPreparation))
      && prepared.publicationPreparation.schemaVersion === 2
      && prepared.publicationPreparation.preparedResults?.directory === path.join(jobRoot, "prepared-results")
      && prepared.publicationPreparation.fixedValidationClock === capturedAt && prepared.publicationPreparation.maxTotalBytes === H.LIMITS.generationBytes,
    "KEYWORD_INCREMENTAL_PREVALIDATION_REQUIRED");
    const proof = await H.read(proofFile, 65536); prep.isolation(proof.value, jobRoot, { "node-sha": pins[0].sha256, "guard-sha": pins[1].sha256 });
    H.need(proof.value.pid === child.pid && prepared.isolation.proofSha256 === proof.sha256, "KEYWORD_INCREMENTAL_ISOLATION_BINDING_INVALID");
    const preparationEvidenceFile = path.join(receiptDir, "incremental-evidence-" + sourceKey + ".json.gz"), preparationEvidence = zlib.gzipSync(preparation.bytes);
    await saveBytes(preparationEvidenceFile, preparationEvidence, 16 * 1024 * 1024);
    H.need(H.hash(zlib.gunzipSync(await fs.readFile(preparationEvidenceFile), { maxOutputLength: 16 * 1024 * 1024 })) === preparation.sha256, "KEYWORD_INCREMENTAL_EVIDENCE_READBACK");
    const expectedScopes = prepared.inputs.flatMap(i => i.exposeScopes); H.need(new Set(expectedScopes.map(H.scopeId)).size === expectedScopes.length && expectedScopes.every(s => prepared.plan.scopes.some(p => H.scopeId(p) === H.scopeId(s))), "KEYWORD_INCREMENTAL_SCOPE_PLAN_INVALID");
    const inputs = H.mergeInputs(initial, prepared.inputs), planned = await planCatalog(inputs, capturedAt);
    const validate = async () => {
      await admission(); await manifestEvidence(dataDir, evidence); await verifyInventory({ expected: prepared.sourceMetadata, dataDir }); await verifyDependencies({ seeded: prepared.staticDependencies, dataDir });
      for (const pinned of admittedEvidence.values()) H.need(JSON.stringify(H.validateEvidence(await options.readDeltaEvidence(pinned.runId))) === JSON.stringify(pinned), "KEYWORD_INCREMENTAL_DELTA_DB_CHANGED");
      H.need((await store.load()).stateSha256 === prepared.stateSha256 && (await events(outbox)).inventory === prepared.outboxInventorySha256, "KEYWORD_INCREMENTAL_SOURCE_CHANGED");
      H.need((await bundle.loadBundle(liveDir)).pointerRead.sha256 === initial.pointerRead.sha256, "KEYWORD_INCREMENTAL_POINTER_CHANGED");
    };
    await validate();
    const intent = { schemaVersion: 1, generatedBy: OWNER, refreshVersion: VERSION, executionBasis: BASIS, incrementalValidated: true, strictIsolationVerified: true, fixtureOnly: dependencies.fixture === true,
      trigger: "completed_collection_postprocess", status: "publishing", mode: "live", sourceKey, jobId: token, runId: evidence.runId, keyword: evidence.keyword, manifestSha256: evidence.manifestSha256,
      scheduleOccurrenceId: evidence.scheduleOccurrenceId, expectedCatalogSha256: planned.sha256, previousPointerSha256: initial.pointerRead.sha256, scopes: expectedScopes,
      stateSha256: prepared.stateSha256, preparationSha256: preparation.sha256, preparationEvidenceFile, preparationEvidenceSha256: H.hash(preparationEvidence), inputsFingerprint: prepared.inputsFingerprint, dataThrough: capturedAt,
      preparedParts: prepared.parts, bootstrap: prepared.bootstrap, metrics: prepared.metrics, jobRoot, createdAt: clock(), providerCalls: 0, sourceWrites: 0 };
    const publisher = dependencies.fixture === true && dependencies.publish ? dependencies.publish : bundle.publishPrevalidatedKeywordMonthlyBundle;
    const publication = await publisher({ inputs, outputDir: liveDir, now: capturedAt, expectedCurrentSha256: initial.pointerRead.sha256, maxTotalBytes: H.LIMITS.generationBytes,
      preparation: prepared.publicationPreparation,
      beforePromote: async candidate => { await validate(); H.need((await planCatalog(inputs, capturedAt)).sha256 === planned.sha256, "KEYWORD_INCREMENTAL_PLAN_CHANGED");
        Object.assign(intent, preparedPublicationCandidate(candidate, planned)); await H.writeNew(intentFile, intent); } });
    promoted = true; H.need(publication.status === "published" && publication.catalogSha256 === intent.expectedCatalogSha256 && publication.providerCalls === 0, "KEYWORD_INCREMENTAL_PUBLICATION_NEEDS_READBACK");
    const verified = await bundle.verifyPrevalidatedKeywordMonthlyBundle({ projectionDir: liveDir, expectedCatalogSha256: intent.expectedCatalogSha256,
      preparation: prepared.publicationPreparation, wantedScopes: expectedScopes });
    const result = { ...intent, ...verified, status: "published", finishedAt: clock(), scopeCount: verified.scopeCount, refreshedScopeCount: expectedScopes.length,
      unchangedScopeCount: initial.catalog.scopes.filter(s => !expectedScopes.some(r => H.scopeId(r) === H.scopeId(s))).length, unchangedScopePartitionBindingsPreserved: true,
      repeatedSource: false, operatingPointerChanged: true, networkAttempted: false, collectorStarted: false, kosisReadOrChanged: false,
      parentProjectionAnalyses: dependencies.fixture === true ? null : 0, semanticValidationExecution: dependencies.fixture === true ? "fixture_child_protocol" : "strict_isolated_child", semanticPrevalidationSha256: prepared.publicationPreparationSha256 };
    delete result.expectedCatalogSha256; await H.writeNew(completeFile, result);
    // Clearing pending dependencies is a cache acknowledgement after verified
    // publication. If it fails, the same data is safely recalculated on retry.
    const latest = await store.load();
    if (latest.stateSha256 === prepared.stateSha256) {
      const next = { ...latest.state, dirtyCompanyIds: [], dirtyMonths: [], dirtyKeywords: [], globalDiagnosticsDirty: false, staticInputsFingerprint: prepared.inputsFingerprint,
        lastPublished: { stateSha256: prepared.stateSha256, sourceKey, generation: verified.generation, pointerSha256: verified.pointerSha256 }, generation: latest.state.generation + 1 };
      try { await store.save(next, latest.pointerSha256); } catch { result.cacheAcknowledgementPending = true; }
    }
    try { await removeOwnedTree(jobRoot, path.join(jobRoot, "refresh-owner.json"), token, sourceKey); } catch { result.cleanupNeedsVerification = true; }
    return result;
  } catch (e) {
    const childTermination = failure.termination({ pid: e.childPid ?? e.pid, exitCode: e.childExitCode ?? e.exitCode, exitSignal: e.childExitSignal ?? e.exitSignal });
    const childFailure = e.childFailure || null;
    const intent = await maybeRead(intentFile).catch(() => ({ unknown: true }));
    if (promoted || intent) throw Object.assign(H.fault("KEYWORD_INCREMENTAL_PUBLICATION_NEEDS_READBACK"), { publicationState: "pointer_was_promoted_verify_current" });
    if (options.signal?.aborted || e.code === "KEYWORD_PREP_CHILD_ABORTED") e = Object.assign(H.fault("KEYWORD_INCREMENTAL_DEFERRED"), { deferred: true });
    else if (prep.safeChildCode(e.childCode)) e = Object.assign(H.fault(e.childCode), childTermination, { childFailure });
    if (jobRoot) {
      try { await H.writeNew(path.join(receiptDir, "failed-incremental-" + sourceKey + "-" + token + ".json"), { schemaVersion: 1, sourceKey, code: prep.safeChildCode(e.code) || "KEYWORD_INCREMENTAL_FAILED", publicationIntentAbsent: true, operatingPointerChanged: false, sourceCacheRetained: true, jobRoot, observedAt: clock(),
        ...childTermination, ...(childFailure ? { childFailure } : {}) }); } catch {}
    }
    if (e.deferred === true && jobRoot) {
      await H.writeNew(path.join(receiptDir, "deferred-incremental-" + sourceKey + "-" + token + ".json"), { schemaVersion: 1, sourceKey, code: e.code, publicationIntentAbsent: true, sourceCacheRetained: true, observedAt: clock() });
      try { await removeOwnedTree(jobRoot, path.join(jobRoot, "refresh-owner.json"), token, sourceKey); } catch { throw H.fault("KEYWORD_INCREMENTAL_DEFERRED_CLEANUP_NEEDS_REVIEW"); }
    }
    throw e;
  }
  });
}
module.exports = { VERSION, OWNER, BASIS, keyFor, retainedPreparation, refreshKeywordMonthlyIncremental };
