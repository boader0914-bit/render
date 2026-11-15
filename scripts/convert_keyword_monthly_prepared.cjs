"use strict";
// Two explicit operations: stage a strictly isolated conversion, then publish
// its exact attested bytes. No current-source normalization or collection.
const fs = require("node:fs/promises"), path = require("node:path"), crypto = require("node:crypto");
const H = require("./lib/keyword_monthly_refresh_preparation.cjs"), B = require("./lib/keyword_monthly_bundle.cjs");
const P = require("./prepare_keyword_monthly_release.cjs"), K = require("./lib/keyword_monthly_prepared_conversion.cjs");
const { calculationFingerprint } = require("./lib/keyword_monthly_prepared_results.cjs");
const { queryId } = require("./lib/keyword_monthly_prepared_results.cjs");
const { createAnalyticalMemorySampler } = require("./lib/analytical_memory.cjs");
const { acquirePreparedConversionLease } = require("./lib/keyword_monthly_maintenance.cjs");
const { waitForConversionIdle } = require("./lib/keyword_monthly_conversion_admission.cjs");
const USAGE = "node scripts/convert_keyword_monthly_prepared.cjs --mode stage --data-dir <absolute> --code-root <absolute> --expected-current-sha <64hex> --now <fixedISO> | --mode publish --job-dir <absolute> --completion-sha <64hex> --expected-current-sha <64hex> | --mode inspect --job-dir <absolute>";
function args(values) {
  if (values.length === 1 && values[0] === "--help") return { help: true };
  const out = {}; for (let n = 0; n < values.length; n += 2) { const key = values[n]?.replace(/^--/, ""); K.need(["mode", "data-dir", "code-root", "expected-current-sha", "now", "job-dir", "completion-sha"].includes(key)
    && !Object.hasOwn(out, key) && values[n + 1], "KEYWORD_PREPARED_CONVERSION_ARGUMENTS"); out[key] = values[n + 1]; }
  const keys = out.mode === "stage" ? ["mode", "data-dir", "code-root", "expected-current-sha", "now"] : out.mode === "publish"
    ? ["mode", "job-dir", "completion-sha", "expected-current-sha"] : out.mode === "inspect" ? ["mode", "job-dir"] : [];
  K.need(keys.length > 0 && Object.keys(out).length === keys.length && keys.every(key => Object.hasOwn(out, key)), "KEYWORD_PREPARED_CONVERSION_ARGUMENTS");
  for (const key of ["data-dir", "code-root", "job-dir"].filter(key => out[key])) H.absolute(out[key]);
  for (const key of ["expected-current-sha", "completion-sha"].filter(key => out[key])) K.need(H.SHA.test(out[key]), "KEYWORD_PREPARED_CONVERSION_ARGUMENTS");
  if (out.now) K.need(H.validIso(out.now), "KEYWORD_PREPARED_CONVERSION_ARGUMENTS"); return out;
}
async function privateDir(directory, fixture) {
  try { await fs.mkdir(directory, { mode: 0o700 }); } catch (error) { if (error.code !== "EEXIST") throw error; }
  const stat = await H.checked(directory, true);
  K.need(fixture && process.platform === "win32" || stat.uid === process.getuid() && (stat.mode & 0o777) === 0o700, "KEYWORD_PREPARED_CONVERSION_PRIVATE_DIRECTORY_REQUIRED");
}
async function pins(codeRoot) {
  const node = await fs.realpath(process.execPath), files = [node, path.join(codeRoot, "scripts", K.GUARD), path.join(codeRoot, "scripts/launch_keyword_monthly_isolated.py"),
    ...["lib/keyword_monthly_prepared_conversion.cjs", "convert_keyword_monthly_prepared.cjs", "lib/keyword_monthly_conversion_admission.cjs", "lib/keyword_monthly_maintenance.cjs",
      "reconstruct_keyword_monthly_source_copy.cjs", "lib/keyword_monthly_scratch_budget.cjs", "lib/keyword_monthly_source_copy.cjs", "prepare_keyword_monthly_release.cjs"].map(name => path.join(codeRoot, "scripts", name)),
    ...["keyword_monthly_bundle.cjs", "keyword_monthly_analysis.cjs", "keyword_monthly_prepared_results.cjs",
      "monthly_reports.cjs", "monthly_report_comparison.cjs", "monthly_report_insights.cjs", "monthly_report_actions.cjs", "saved_product_recovery.cjs"].map(name => path.join(codeRoot, "scripts/lib", name))];
  return Promise.all(files.map(file => P.fileHash(file)));
}
async function verifyPins(expected) { K.need(Array.isArray(expected) && expected.length === 19, "KEYWORD_PREPARED_CONVERSION_CODE_INVALID");
  for (const pin of expected) K.need((await P.fileHash(pin.file)).sha256 === pin.sha256, "KEYWORD_PREPARED_CONVERSION_CODE_CHANGED"); }
async function resourceAdmission(dataDir, fixture) {
  const stat = await fs.statfs(dataDir, { bigint: true }), free = stat.bavail * stat.bsize;
  const required = 512n * 1024n ** 2n + BigInt(K.LIMITS.scratchBytes) + 2n * BigInt(K.LIMITS.generationBytes);
  K.need(free >= required, "KEYWORD_PREPARED_CONVERSION_DISK_RESERVE");
  let memory = null;
  if (!fixture) { memory = await createAnalyticalMemorySampler().sample(); K.need(memory && Number.isFinite(memory.ratio) && memory.ratio <= 0.55
    && Number.isFinite(memory.sampledAt) && Date.now() - memory.sampledAt <= 5000 && memory.sampledAt <= Date.now() + 1000, "KEYWORD_PREPARED_CONVERSION_MEMORY_HOLD"); }
  return { freeBytes: String(free), requiredBytes: String(required), memoryRatio: memory?.ratio ?? null, heapMiB: K.LIMITS.heapMiB };
}
function assertJobLocation(jobDir, job) {
  H.absolute(jobDir); H.absolute(job.dataDir); H.absolute(job.codeRoot);
  const operations = path.join(job.dataDir, "operations");
  K.need(job.version === K.VERSION && job.jobDir === jobDir && /^[a-f0-9]{32}$/.test(job.conversionId || "") && path.basename(jobDir) === job.conversionId
    && /^keyword-prepared-conversion-\d{8}$/.test(path.basename(job.operationsDir || "")) && path.dirname(job.operationsDir) === operations
    && path.dirname(jobDir) === job.operationsDir && H.validIso(job.now) && H.SHA.test(job.expectedCurrentSha256 || "")
    && job.dataDir !== path.parse(job.dataDir).root && job.codeRoot !== path.parse(job.codeRoot).root, "KEYWORD_PREPARED_CONVERSION_JOB_INVALID");
}
async function readStaged(jobDir, completionSha, fixture = false) {
  const input = await H.read(path.join(jobDir, "job-input.json"), K.LIMITS.inventoryBytes), job = input.value; assertJobLocation(jobDir, job);
  const completion = await H.read(path.join(jobDir, "stage-complete.json"), K.LIMITS.receiptBytes);
  K.need(completion.sha256 === completionSha && completion.value.status === "staged" && completion.value.version === K.VERSION
    && completion.value.jobInputSha256 === input.sha256 && completion.value.expectedCurrentSha256 === job.expectedCurrentSha256
    && completion.value.fixtureOnly === fixture, "KEYWORD_PREPARED_CONVERSION_COMPLETION_INVALID");
  const child = await H.read(path.join(jobDir, "child-complete.json"), K.LIMITS.receiptBytes), proof = await H.read(path.join(jobDir, "control/isolation.json"), 65536);
  const result = child.value;
  K.need(child.sha256 === completion.value.childReceiptSha256 && proof.sha256 === completion.value.proofSha256
    && result.status === "staged" && result.version === K.VERSION && result.conversionId === job.conversionId && result.fixedClock === job.now
    && JSON.stringify(result.source) === JSON.stringify(job.source) && result.sourceInventorySha256 === job.sourceInventorySha256
    && result.calculationFingerprint === job.calculationFingerprint && result.calculationFingerprint === calculationFingerprint()
    && result.fixtureOnly === fixture && result.sourceWrites === 0 && result.providerCalls === 0 && result.appEntryExecutions === 0 && result.originalFreshnessVerified === false
    && Array.isArray(result.parity) && result.parity.length === result.scopeCount && result.scopeCount > 0 && result.scopeCount <= K.LIMITS.scopes
    && result.parity.every(row => row.exact === true && H.SHA.test(row.logicalSha256 || "")) && K.hash(K.bytesFor(result.parity)) === result.paritySha256
    && result.preparedResultCount === result.scopeCount && result.guardMetrics && Object.values(result.guardMetrics).every(value => value === 0)
    && result.scratch?.deniedOperations === 0 && result.isolation?.proofSha256 === proof.sha256 && result.isolation.pid === completion.value.childPid,
  "KEYWORD_PREPARED_CONVERSION_CHILD_INVALID");
  if (!fixture) { P.isolation(proof.value, jobDir, { "node-sha": job.codePins[0].sha256, "guard-sha": job.codePins[1].sha256 });
    K.need(proof.value.pid === completion.value.childPid && proof.value.guardName === K.GUARD && proof.value.applicationStarted === false
      && proof.value.nodeMaxOldSpaceSizeMiB === K.LIMITS.heapMiB && proof.value.fixtureOnly !== true, "KEYWORD_PREPARED_CONVERSION_ISOLATION_INVALID"); }
  const preparation = await H.read(path.join(jobDir, "publication-preparation.json"), K.LIMITS.receiptBytes);
  K.need(preparation.sha256 === result.preparationSha256 && preparation.value.schemaVersion === 2 && preparation.value.fixedValidationClock === job.now
    && preparation.value.maxTotalBytes === K.LIMITS.generationBytes && preparation.value.preparedResults?.directory === path.join(jobDir, "prepared-results")
    && preparation.value.preparedResults.descriptors.length === result.scopeCount, "KEYWORD_PREPARED_CONVERSION_PREPARATION_INVALID");
  const parityIds = new Set(result.parity.map(row => queryId(row.query)));
  K.need(parityIds.size === result.scopeCount && preparation.value.preparedResults.descriptors.every(row => parityIds.has(queryId(row))),
    "KEYWORD_PREPARED_CONVERSION_PREPARATION_INVALID");
  const sourceInventory = await H.read(path.join(jobDir, "source-inventory.json"), K.LIMITS.inventoryBytes);
  K.need(sourceInventory.value.sha256 === job.sourceInventorySha256 && sourceInventory.sha256 === completion.value.inventoryReceiptSha256,
    "KEYWORD_PREPARED_CONVERSION_INVENTORY_INVALID");
  return { job, input, completion, child, proof, preparation, sourceInventory };
}
async function stageOwned(options, dependencies = {}) {
  const fixture = dependencies.fixture === true; K.need(fixture || process.platform === "linux", "KEYWORD_PREPARED_CONVERSION_LINUX_REQUIRED");
  const { dataDir, codeRoot, expectedCurrentSha256, now } = options; H.absolute(dataDir); H.absolute(codeRoot); await H.checked(dataDir, true); await H.checked(codeRoot, true);
  K.need(dataDir !== path.parse(dataDir).root && codeRoot !== path.parse(codeRoot).root, "KEYWORD_PREPARED_CONVERSION_JOB_INVALID");
  K.need(H.validIso(now) && Date.parse(now) <= Date.now() + 60000, "KEYWORD_PREPARED_CONVERSION_CLOCK_INVALID");
  await K.assertUnlocked(dataDir); const resources = await resourceAdmission(dataDir, fixture), initial = await K.initialBundle(dataDir, expectedCurrentSha256);
  K.need(initial.catalog.schemaVersion === 1, "KEYWORD_PREPARED_CONVERSION_ALREADY_PREPARED");
  const original = await K.inventory(initial.generationDir), engine = calculationFingerprint(), codePins = await pins(codeRoot);
  const operations = path.join(dataDir, "operations");
  try { await fs.mkdir(operations, { mode: 0o700 }); } catch (error) { if (error.code !== "EEXIST") throw error; }
  const parent = await H.checked(operations, true); K.need(fixture || parent.uid === process.getuid() && (parent.mode & 0o022) === 0, "KEYWORD_PREPARED_CONVERSION_PRIVATE_DIRECTORY_REQUIRED");
  const operationsDir = path.join(operations, "keyword-prepared-conversion-" + new Date(Date.parse(now) + 9 * 3600000).toISOString().slice(0, 10).replaceAll("-", "")); await privateDir(operationsDir, fixture);
  const conversionId = K.hash(K.bytesFor([K.VERSION, expectedCurrentSha256, engine, codePins.map(pin => pin.sha256)])).slice(0, 32), jobDir = path.join(operationsDir, conversionId);
  try { await fs.mkdir(jobDir, { mode: 0o700 }); } catch (error) { if (error.code === "EEXIST") throw K.fault("KEYWORD_PREPARED_CONVERSION_ALREADY_EXISTS"); throw error; }
  await privateDir(path.join(jobDir, "control"), fixture);
  const inventory = await K.writeNew(path.join(jobDir, "source-inventory.json"), original, K.LIMITS.inventoryBytes);
  const job = { schemaVersion: 1, version: K.VERSION, conversionId, jobDir, operationsDir, dataDir, codeRoot, now, expectedCurrentSha256,
    source: K.sourceIdentity(initial), sourceInventorySha256: original.sha256, calculationFingerprint: engine, codePins, maintenanceOperationId: options.maintenanceOperationId };
  const input = await K.writeNew(path.join(jobDir, "job-input.json"), job, K.LIMITS.inventoryBytes), proofFile = path.join(jobDir, "control/isolation.json");
  const execute = fixture && dependencies.execute ? dependencies.execute : P.runChild;
  await K.assertUnlocked(dataDir); const started = Date.now();
  try {
    const child = await execute("/usr/bin/python3.11", [codePins[2].file, "--copy-root", jobDir, "--proof", proofFile, "--code-root", codeRoot,
      "--guard-name", K.GUARD, "--guard-sha256", codePins[1].sha256, "--node-sha256", codePins[0].sha256, "--node-max-old-space-size", String(K.LIMITS.heapMiB),
      "--", codePins[0].file, codePins[1].file, "--input", input.file, "--input-sha", input.sha256, "--job-root", jobDir, "--code-root", codeRoot, "--isolation-proof", proofFile],
    { cwd: codeRoot, timeout: K.LIMITS.timeoutMs, receiptOnly: true, signal: options.signal });
    K.need(child.exitCode === 0 && child.receiptOnly === true && child.stdout === null && child.stderrBytes === null && Number.isSafeInteger(child.pid) && child.pid > 0,
      "KEYWORD_PREPARED_CONVERSION_CHILD_INVALID");
    await verifyPins(codePins); await K.assertInventory(original); await K.initialBundle(dataDir, expectedCurrentSha256); await K.assertUnlocked(dataDir);
    const result = await H.read(path.join(jobDir, "child-complete.json"), K.LIMITS.receiptBytes), proof = await H.read(proofFile, 65536);
    const completion = await K.writeNew(path.join(jobDir, "stage-complete.json"), { schemaVersion: 1, version: K.VERSION, status: "staged", conversionId,
      expectedCurrentSha256, jobInputSha256: input.sha256, inventoryReceiptSha256: inventory.sha256, childReceiptSha256: result.sha256, proofSha256: proof.sha256,
      childPid: child.pid, fixtureOnly: fixture, resources, elapsedMs: Date.now() - started, scopeCount: result.value.scopeCount, preparedResultCount: result.value.preparedResultCount,
      operatingPointerChanged: false, originalFreshnessVerified: false });
    const checked = await readStaged(jobDir, completion.sha256, fixture);
    await B.verifyPrevalidatedKeywordMonthlyBundle({ projectionDir: path.join(jobDir, "candidate"), expectedCatalogSha256: checked.child.value.candidate.catalogSha256,
      preparation: checked.preparation.value, wantedScopes: initial.catalog.scopes.map(({ keyword, month }) => ({ keyword, month })) });
    return { status: "staged", jobDir, completionSha256: completion.sha256, scopeCount: checked.child.value.scopeCount,
      preparedResultCount: checked.child.value.preparedResultCount, source: job.source, fixtureOnly: fixture, operatingPointerChanged: false, providerCalls: 0 };
  } catch (error) {
    let causeCode = null;
    try { const failure = await H.read(path.join(jobDir, "child-failed.json"), 65536);
      if (/^(?:ISOLATION_|KEYWORD_)[A-Z0-9_]{1,150}$/.test(failure.value.code || "")) causeCode = failure.value.code;
    } catch {}
    if (causeCode) try { error.causeCode = causeCode; } catch {}
    try { await K.writeNew(path.join(jobDir, "stage-failed.json"), { status: "needs_verification", code: K.safeCode(error), operatingPointerChanged: false,
      ...(causeCode ? { causeCode } : {}), originalFreshnessVerified: false, observedAt: new Date().toISOString() }); } catch {} throw error;
  }
}
async function publishOwned(options, dependencies = {}) {
  const fixture = dependencies.fixture === true; K.need(fixture || process.platform === "linux", "KEYWORD_PREPARED_CONVERSION_LINUX_REQUIRED");
  const { jobDir, completionSha256, expectedCurrentSha256 } = options, staged = await readStaged(jobDir, completionSha256, fixture), { job, preparation } = staged;
  K.need(expectedCurrentSha256 === job.expectedCurrentSha256, "KEYWORD_PREPARED_CONVERSION_POINTER_CHANGED");
  await verifyPins(job.codePins); await K.assertUnlocked(job.dataDir);
  const liveDir = path.join(job.dataDir, "keyword_monthly_analysis"), inputs = K.inputsFor(await K.initialBundle(job.dataDir, expectedCurrentSha256));
  await K.assertInventory(staged.sourceInventory.value);
  const intentFile = path.join(jobDir, "publish-intent.json"), completeFile = path.join(jobDir, "publish-complete.json");
  // An uncertain prior promotion is never retried. Its exact result is checked
  // by inspect/readback, with no silent pointer restoration or second publish.
  try { await fs.lstat(intentFile); throw K.fault("KEYWORD_PREPARED_CONVERSION_PRIOR_INTENT_REQUIRES_READBACK"); } catch (error) { if (error.code !== "ENOENT") throw error; }
  const publisher = fixture && dependencies.publish ? dependencies.publish : B.publishPrevalidatedKeywordMonthlyBundle;
  let candidate;
  const publication = await publisher({ inputs, outputDir: liveDir, now: job.now, expectedCurrentSha256, maxTotalBytes: K.LIMITS.generationBytes, preparation: preparation.value,
    beforePromote: async value => {
      await K.assertUnlocked(job.dataDir, { publishing: true }); await verifyPins(job.codePins); await K.assertInventory(staged.sourceInventory.value);
      await waitForIdle(dependencies);
      await K.initialBundle(job.dataDir, expectedCurrentSha256);
      K.need(value?.catalogSchemaVersion === 2 && value.preparedResultCount === staged.child.value.scopeCount
        && value.calculationFingerprint === job.calculationFingerprint && value.scopePlanSha256 === staged.child.value.scopePlanSha256,
      "KEYWORD_PREPARED_CONVERSION_CANDIDATE_INVALID"); candidate = value;
      await K.writeNew(intentFile, { schemaVersion: 1, version: K.VERSION, status: "prepared_for_atomic_promotion", source: job.source, conversionId: job.conversionId,
        completionSha256, candidate: value, preparationSha256: preparation.sha256, fixtureOnly: fixture, maintenanceOperationId: options.maintenanceOperationId, createdAt: new Date().toISOString() });
      if (fixture && dependencies.beforePromote) await dependencies.beforePromote(value);
    } });
  K.need(candidate && publication.catalogSha256 === candidate.catalogSha256, "KEYWORD_PREPARED_CONVERSION_PUBLICATION_REQUIRES_READBACK");
  const verified = await B.verifyPrevalidatedKeywordMonthlyBundle({ projectionDir: liveDir, expectedCatalogSha256: publication.catalogSha256,
    preparation: preparation.value, wantedScopes: inputs.flatMap(input => input.exposeScopes) });
  await K.assertInventory(staged.sourceInventory.value);
  const complete = await K.writeNew(completeFile, { schemaVersion: 1, version: K.VERSION, status: "published", conversionId: job.conversionId,
    source: job.source, completionSha256, candidate, publication, verified, paritySha256: staged.child.value.paritySha256,
    scopeCount: staged.child.value.scopeCount, strictIsolatedChild: !fixture, parentProjectionAnalyses: 0, fixtureOnly: fixture,
    oldGenerationPreserved: true, originalFreshnessVerified: false, originalSourcesRewritten: false, issuedReportsChanged: false, providerCalls: 0,
    publishedAt: new Date().toISOString() });
  return { status: "published", jobDir, receiptSha256: complete.sha256, source: job.source, ...verified, fixtureOnly: fixture,
    oldGenerationPreserved: true, originalFreshnessVerified: false, parentProjectionAnalyses: 0, providerCalls: 0 };
}
async function waitForIdle(dependencies) {
  if (dependencies.fixture === true && typeof dependencies.waitForIdle === "function") return dependencies.waitForIdle();
  return waitForConversionIdle();
}
async function withMaintenance(dataDir, mode, dependencies, operation) {
  const fixture = dependencies.fixture === true;
  K.need(fixture || process.platform === "linux", "KEYWORD_PREPARED_CONVERSION_LINUX_REQUIRED");
  const lease = await acquirePreparedConversionLease({ dataDir, mode, operationId: crypto.randomUUID() });
  let primary;
  try { await waitForIdle(dependencies); return await operation(lease); }
  catch (error) { primary = error; throw error; }
  finally {
    try { await lease.release(); }
    catch (error) { if (!primary) throw error; try { primary.maintenanceCleanupCode = K.safeCode(error); } catch {} }
  }
}
async function stage(options, dependencies = {}) {
  H.absolute(options.dataDir);
  return withMaintenance(options.dataDir, "stage", dependencies, lease => stageOwned({ ...options, maintenanceOperationId: lease.operationId }, dependencies));
}
async function publish(options, dependencies = {}) {
  const input = await H.read(path.join(options.jobDir, "job-input.json"), K.LIMITS.inventoryBytes); assertJobLocation(options.jobDir, input.value);
  return withMaintenance(input.value.dataDir, "publish", dependencies, lease => publishOwned({ ...options, maintenanceOperationId: lease.operationId }, dependencies));
}
async function inspect(jobDir) {
  const job = await H.read(path.join(jobDir, "job-input.json"), K.LIMITS.inventoryBytes); assertJobLocation(jobDir, job.value);
  const present = {}; for (const name of ["stage-failed", "stage-complete", "publish-intent", "publish-complete"]) {
    try { const r = await H.read(path.join(jobDir, name + ".json"), K.LIMITS.receiptBytes); present[name] = { sha256: r.sha256, status: r.value.status, ...(r.value.code ? { code: r.value.code } : {}),
      ...(/^(?:ISOLATION_|KEYWORD_)[A-Z0-9_]{1,150}$/.test(r.value.causeCode || "") ? { causeCode: r.value.causeCode } : {}) }; }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  const current = await B.loadBundle(path.join(job.value.dataDir, "keyword_monthly_analysis"));
  return { status: present["publish-complete"] ? "published_receipt_exists" : present["publish-intent"] ? "needs_readback" : present["stage-failed"] ? "needs_verification" : present["stage-complete"] ? "staged" : "incomplete",
    jobDir, source: job.value.source, current: K.sourceIdentity(current), originalStillCurrent: current.pointerRead.sha256 === job.value.expectedCurrentSha256,
    records: present, readOnly: true, providerCalls: 0 };
}
async function run(values) {
  const input = args(values); if (input.help) { console.log(USAGE); return null; }
  const result = input.mode === "stage" ? await stage({ dataDir: input["data-dir"], codeRoot: input["code-root"], expectedCurrentSha256: input["expected-current-sha"], now: input.now })
    : input.mode === "publish" ? await publish({ jobDir: input["job-dir"], completionSha256: input["completion-sha"], expectedCurrentSha256: input["expected-current-sha"] }) : await inspect(input["job-dir"]);
  console.log(JSON.stringify(result)); return result;
}
if (require.main === module) run(process.argv.slice(2)).catch(error => { console.error(JSON.stringify({ status: "needs_verification", code: K.safeCode(error),
  ...(/^(?:ISOLATION_|KEYWORD_)[A-Z0-9_]{1,150}$/.test(error.causeCode || "") ? { causeCode: error.causeCode } : {}),
  ...(error.publicationState ? { publicationState: error.publicationState, generation: error.generation, pointerSha256: error.pointerSha256 } : {}) })); process.exitCode = 1; });
module.exports = { args, stage, publish, inspect, readStaged, resourceAdmission, USAGE };
