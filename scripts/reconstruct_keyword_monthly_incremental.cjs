"use strict";
// Dedicated, kernel-network-denied compiler. No application entry execution,
// provider, collector, settings or source writer is imported.
const fs = require("node:fs/promises"), path = require("node:path"), crypto = require("node:crypto");
const H = require("./lib/keyword_monthly_refresh_preparation.cjs");
const { kernelIsolation, installGuards } = require("./reconstruct_keyword_monthly_source_copy.cjs");
const { installReadOnlyOutputs } = require("./lib/keyword_monthly_readonly_outputs.cjs");
const { installScratchBudget } = require("./lib/keyword_monthly_scratch_budget.cjs");
const { metadataInventory, verifyInventory, seedDependencies, verifyDependencies } = require("./lib/keyword_monthly_incremental_inputs.cjs");
const { createContext } = require("./lib/keyword_monthly_incremental_context.cjs");
const { normalizePair } = require("./lib/keyword_monthly_incremental_normalize.cjs");
const { planScopes, VERSION } = require("./lib/keyword_monthly_incremental_plan.cjs");
const { buildKeywordMonthlyProjection } = require("./lib/keyword_monthly_analysis.cjs");
const { saveBytes, createStore } = require("./lib/keyword_monthly_incremental_state.cjs");
const bundle = require("./lib/keyword_monthly_bundle.cjs");
function args(values) {
  const out = {}, allowed = new Set(["input", "input-sha", "job-root", "code-root", "isolation-proof", "fixture-root"]);
  for (let i = 0; i < values.length; i += 2) { const key = values[i]?.replace(/^--/, ""); H.need(values[i]?.startsWith("--") && allowed.has(key) && values[i + 1] && !Object.hasOwn(out, key), "KEYWORD_INCREMENTAL_ARGUMENTS"); out[key] = values[i + 1]; }
  for (const name of ["job-root", "code-root", "isolation-proof"]) H.absolute(out[name]);
  H.need(out["fixture-root"] || out.input && H.SHA.test(out["input-sha"] || ""), "KEYWORD_INCREMENTAL_ARGUMENTS"); return out;
}
async function run(values) {
  const input = args(values), jobRoot = input["job-root"], codeRoot = input["code-root"];
  await H.checked(jobRoot, true); await H.checked(codeRoot, true);
  H.need(path.dirname(input["isolation-proof"]) === path.join(jobRoot, "control"), "KEYWORD_INCREMENTAL_ISOLATION_SCOPE_INVALID");
  const isolation = await kernelIsolation(input["isolation-proof"], jobRoot);
  if (input["fixture-root"]) {
    const fixtureRoot = H.absolute(input["fixture-root"]);
    H.need(/^keyword-monthly-incremental-plan-\d{8}-[a-f0-9]{32}$/.test(path.basename(fixtureRoot)) && path.dirname(fixtureRoot) === "/sandbox" && H.inside(fixtureRoot, jobRoot), "KEYWORD_INCREMENTAL_FIXTURE_SCOPE_INVALID");
    const guards = installGuards(fixtureRoot, { codeRoot });
    try {
      const result = await require("./verify_keyword_monthly_incremental_realcopy.cjs").executeContextReplay({ codeRoot, fixtureRoot,
        capturedAt: (await H.read(path.join(fixtureRoot, "frozen-capture-metadata.json"), 16 * 1024 * 1024)).value.capturedAt });
      H.need(!Object.values(guards.metrics).some(Boolean), "KEYWORD_INCREMENTAL_FIXTURE_SIDE_EFFECT");
      const raw = Buffer.from(JSON.stringify(result)), compressed = require("node:zlib").gzipSync(raw), evidenceFile = path.join(jobRoot, "fixture-proof-full.json.gz");
      await saveBytes(evidenceFile, compressed, 16 * 1024 * 1024);
      const proof = { status: result.status, resultFile: result.resultFile, evidenceFile, evidenceSha256: H.hash(compressed), resultSha256: H.hash(raw), rawBytes: raw.length,
        isolation, guardMetrics: guards.metrics, providerCalls: 0, sourceOperatingWrites: 0, fixtureOnly: true };
      await H.writeNew(path.join(jobRoot, "fixture-verification-complete.json"), proof); return proof;
    } finally { guards.restore(); }
  }
  H.need(H.inside(jobRoot, H.absolute(input.input)), "KEYWORD_INCREMENTAL_INPUT_SCOPE_INVALID");
  const read = await H.read(input.input, 1024 * 1024); H.need(read.sha256 === input["input-sha"], "KEYWORD_INCREMENTAL_INPUT_CHANGED");
  const job = read.value, dataDir = H.absolute(job.dataDir), namespace = path.join(dataDir, "keyword_monthly_incremental");
  H.need(job.version === VERSION && H.inside(path.join(namespace, "jobs"), jobRoot) && /^refresh-job-[a-f0-9-]{36}$/.test(path.basename(jobRoot))
    && H.validIso(job.capturedAt) && Array.isArray(job.catalog?.scopes) && Array.isArray(job.admittedRunIds) && Array.isArray(job.admittedEvidence), "KEYWORD_INCREMENTAL_JOB_INVALID");
  const evidence = H.validateEvidence(job.evidence), workDataDir = path.join(jobRoot, "data"); await fs.mkdir(workDataDir, { mode: 0o700 });
  const liveDir = path.join(dataDir, "keyword_monthly_analysis"), initial = await bundle.loadBundle(liveDir);
  H.need(job.initialBundle && Object.keys(job.initialBundle).length === 3 && job.initialBundle.generation === initial.pointer.generation
    && job.initialBundle.pointerSha256 === initial.pointerRead.sha256 && job.initialBundle.catalogSha256 === initial.catalogRead.sha256
    && JSON.stringify(job.catalog) === JSON.stringify(initial.catalog), "KEYWORD_INCREMENTAL_INITIAL_BUNDLE_CHANGED");
  const before = await metadataInventory({ dataDir }), seeded = await seedDependencies({ dataDir, workDataDir });
  H.need(job.admittedEvidence.length === job.admittedRunIds.length && new Set(job.admittedRunIds).size === job.admittedRunIds.length, "KEYWORD_INCREMENTAL_DELTA_EVIDENCE_INVALID");
  for (const supplied of job.admittedEvidence) {
    const pinned = H.validateEvidence(supplied); H.need(job.admittedRunIds.includes(pinned.runId), "KEYWORD_INCREMENTAL_DELTA_EVIDENCE_INVALID");
    await require("./refresh_keyword_monthly_from_completed_run.cjs").manifestEvidence(dataDir, pinned);
  }
  const expectedState = await createStore({ dataDir }).load();
  H.need((expectedState?.stateSha256 || null) === job.expectedSourceStateSha256, "KEYWORD_INCREMENTAL_STATE_CHANGED");
  const bootstrap = !await fs.lstat(path.join(namespace, "source-current.json")).catch(e => { if (e.code === "ENOENT") return null; throw e; });
  const core = [path.join(dataDir, "company_master/companies.json"), path.join(dataDir, "history/observations.jsonl")];
  const guards = installGuards(namespace, { codeRoot, originalOutputs: before.outputs,
    readOnlyRoots: [initial.generationDir, path.join(liveDir, "current.json"), path.join(dataDir, "keyword_monthly_source_delta"), ...["company_integrated/capacity-bases.json", "history/special_days", "history/saved_product_recoveries"].map(p => path.join(dataDir, p)), ...(bootstrap ? core : [])], metadataOnlyFiles: bootstrap ? [] : core });
  const outputView = installReadOnlyOutputs(before.outputs), scratch = installScratchBudget(jobRoot, undefined, { externalWriteRoots: [namespace] });
  const started = Date.now(), admission = async () => H.need(Date.now() - started < 55 * 60000, "KEYWORD_INCREMENTAL_TIME_BOUND");
  try {
    // readCatalog metadata is acquired from the application's inert run catalog.
    // It reads saved manifest metadata only, with original outputs readonly.
    const { buildSourceWiring } = require("./lib/keyword_monthly_source_wiring.cjs");
    const metadataWiring = buildSourceWiring({ codeRoot, copyDataDir: workDataDir, now: job.capturedAt, readOnlyOriginalOutputs: before.outputs.root,
      incremental: { observationIndex: Object.fromEntries(["ensure", "readRows", "revisionPartitions"].map(name => [name, async () => { throw H.fault("KEYWORD_INCREMENTAL_INITIAL_INDEX_UNUSED"); }])), revision: "initial-metadata", catalog: null } });
    const runs = await metadataWiring.listRuns(), regions = JSON.parse(await fs.readFile(path.join(codeRoot, "web/data/region_master.json"), "utf8")).units || [];
    const context = await createContext({ dataDir, codeRoot, workDataDir, capturedAt: job.capturedAt, outputs: before.outputs, runs, regions, admission,
      expectedOutboxInventorySha256: job.outboxInventorySha256, admittedRunIds: job.admittedRunIds });
    const available = await fs.statfs(dataDir, { bigint: true });
    H.need(available.bavail * available.bsize >= 512n * 1024n * 1024n + BigInt(H.LIMITS.scratchBytes) + 64n * 1024n * 1024n, "KEYWORD_INCREMENTAL_JOB_DISK_RESERVE");
    const inputsFingerprint = H.hash(JSON.stringify([seeded.sourceInventorySha256, context.wiring.bindings.codeFingerprint, H.hash(JSON.stringify(regions))]));
    const plan = planScopes({ state: context.state, catalog: job.catalog, evidence, range: job.range, capturedAt: job.capturedAt, inputsFingerprint });
    const parts = [], inputs = [];
    for (let i = 0; i < plan.scopes.length; i++) {
      await context.assertCurrent(); const scope = plan.scopes[i], normalized = await normalizePair({ wiring: context.wiring, ...scope, capturedAt: job.capturedAt, checkpoint: admission });
      const directory = path.join(jobRoot, "part-" + String(i).padStart(3, "0"));
      const built = await buildKeywordMonthlyProjection({ source: normalized.source, sourceFingerprint: normalized.inputSha256, sourceProvenance: normalized.provenance,
        materializedAt: job.capturedAt, dataThrough: job.capturedAt, outputDir: directory, now: () => new Date(job.capturedAt), compression: "gzip", publishMonths: [scope.month] });
      if (built.scopeCount === 0 && !job.catalog.scopes.some(s => H.scopeId(s) === H.scopeId(scope))) {
        parts.push({ ...scope, status: "not_observed", sourceSha256: normalized.inputSha256, inputBytes: normalized.inputBytes }); continue;
      }
      H.need(built.scopeCount === 1 && built.keywordCount === 1 && H.SHA.test(built.indexSha256), "KEYWORD_INCREMENTAL_PARTITION_NOT_OBSERVED");
      inputs.push({ directory, exposeScopes: [{ keyword: scope.keyword, month: scope.month }] });
      parts.push({ ...scope, sourceSha256: normalized.inputSha256, inputBytes: normalized.inputBytes, indexSha256: built.indexSha256,
        observationCount: normalized.source.observations.length, newRunObservationCount: normalized.source.observations.filter(r => r.runId === evidence.runId).length });
      await fs.writeFile(path.join(jobRoot, "part-" + String(i).padStart(3, "0") + "-normalization.json"), JSON.stringify({ ...scope, records: normalized.records, inputSha256: normalized.inputSha256 }), { flag: "wx", mode: 0o600 });
    }
    // Financial semantic validation stays in this bounded, disposable child.
    // The web parent later checks exact bytes and this attested descriptor only.
    const publicationPreparation = await bundle.prepareKeywordMonthlyBundle({ inputs: H.mergeInputs(initial, inputs), now: job.capturedAt, maxTotalBytes: H.LIMITS.generationBytes });
    H.need((await bundle.loadBundle(liveDir)).pointerRead.sha256 === initial.pointerRead.sha256, "KEYWORD_INCREMENTAL_INITIAL_BUNDLE_CHANGED");
    await context.assertCurrent(); await verifyInventory({ expected: before, dataDir }); await verifyDependencies({ seeded, dataDir });
    const verifiedOutputs = await outputView.verify(); context.wiring.assertCodeCurrent(); scratch.assertCurrent();
    H.need(!Object.values(guards.metrics).some(Boolean) && context.wiring.metrics.deniedRequires === 0 && outputView.metrics.originalWriteAttempts === 0 && outputView.metrics.uncapturedReadAttempts === 0 && outputView.metrics.validationDenials === 0, "KEYWORD_INCREMENTAL_SIDE_EFFECT_ATTEMPTED");
    const result = { schemaVersion: 1, version: VERSION, status: "complete", executionBasis: "verified_incremental_source_checkpoint_and_dirty_partition_rebuild", capturedAt: job.capturedAt,
      bootstrap: context.bootstrap, stateSha256: context.current.stateSha256, statePointerSha256: context.current.pointerSha256, sourceInventorySha256: before.inventorySha256,
      inputsFingerprint, outboxInventorySha256: context.outboxInventorySha256, inputs, parts, plan, metrics: context.metrics(), isolation,
      initialBundle: job.initialBundle, publicationPreparation, publicationPreparationSha256: H.hash(JSON.stringify(publicationPreparation)),
      originalOutputVerification: verifiedOutputs, staticDependencies: seeded, providerCalls: 0, sourceWrites: 0, appEntryExecutions: 0, kosisReadOrChanged: false,
      guardMetrics: guards.metrics, sourceMetadata: before, scratch: scratch.status(), elapsedMs: Date.now() - started };
    await saveBytes(path.join(jobRoot, "preparation-complete.json"), Buffer.from(JSON.stringify(result)), 16 * 1024 * 1024);
    return { status: "complete", version: VERSION, resultFile: path.join(jobRoot, "preparation-complete.json"), resultSha256: H.hash(Buffer.from(JSON.stringify(result))), scopeCount: parts.length, providerCalls: 0, sourceWrites: 0, isolationVerified: true };
  } finally { scratch.restore(); outputView.restore(); guards.restore(); }
}
if (require.main === module) run(process.argv.slice(2)).then(r => console.log(JSON.stringify(r))).catch(e => {
  const code = /^[A-Z][A-Z0-9_]{1,150}$/.test(e.code || "") ? e.code : "KEYWORD_INCREMENTAL_RECONSTRUCTION_FAILED";
  const frames = String(e.stack || "").split("\n").slice(1).map(line => line.match(/scripts[\\/]([A-Za-z0-9_./\\-]+\.cjs):(\d+):(\d+)/)).filter(Boolean).slice(0, 6).map(m => ({ file: m[1].replaceAll("\\", "/"), line: Number(m[2]), column: Number(m[3]) }));
  console.error(JSON.stringify({ code, errorType: /^[A-Za-z]+Error$/.test(e.name || "") ? e.name : "Error", frames })); process.exitCode = 1;
});
module.exports = { args, run };
