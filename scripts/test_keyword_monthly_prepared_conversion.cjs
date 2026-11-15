"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs/promises"), path = require("node:path"), os = require("node:os");
const A = require("./lib/keyword_monthly_analysis.cjs"), B = require("./lib/keyword_monthly_bundle.cjs"), H = require("./lib/keyword_monthly_refresh_preparation.cjs");
const K = require("./lib/keyword_monthly_prepared_conversion.cjs"), C = require("./convert_keyword_monthly_prepared.cjs");
const { installGuards } = require("./reconstruct_keyword_monthly_source_copy.cjs"), { installScratchBudget } = require("./lib/keyword_monthly_scratch_budget.cjs");
const NOW = "2026-11-15T03:00:00.000Z", codeRoot = path.resolve(__dirname, "..");
async function json(file, value) { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, JSON.stringify(value)); }
async function fixture(t, variant = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "keyword-conversion-fixture-")), dataDir = path.join(root, "data"); await fs.mkdir(dataDir);
  await fs.mkdir(path.join(dataDir, "keyword_monthly_incremental"), { mode: 0o700 });
  t.after(async () => { assert.equal(path.dirname(root), path.resolve(os.tmpdir())); await fs.rm(root, { recursive: true, force: true }); });
  const inputs = [];
  for (let index = 0; index < 2; index++) {
    const keyword = "synthetic-conversion-" + index, companyId = "synthetic_cmp_" + index;
    const source = { companies: [{ companyId, primaryName: "Synthetic conversion company " + index, capacity: 5 }], runs: [], observations: [], rankObservations: [], savedProductRecoveries: [], warnings: [], sourceDiagnostics: {} };
    for (const month of ["2026-09", "2026-10", "2026-11"]) for (let sequence = 0; sequence < 2; sequence++) {
      const runId = `synthetic_${index}_${month}_${sequence}`, collectedAt = month + `-${sequence ? "14" : "13"}T00:00:00.000Z`;
      source.runs.push({ id: runId, keyword, collectedAt, collectionQuality: { status: "complete" } });
      source.observations.push({ companyId, keyword, runId, productType: "lodging", stayDate: month + "-20", collectedAt, inventoryEvidenceVersion: 4,
        supply: 5, sold: 2 + sequence, publicBookings: 1 + sequence, phoneBookings: 1, publicRevenue: (1 + sequence) * 100000,
        phoneRevenue: month === "2026-10" ? null : 100000, estimatedRevenue: month === "2026-10" ? null : (2 + sequence) * 100000,
        phoneMissingPriceBookings: month === "2026-10" ? 1 : 0, dayUsePresence: "present", dayUseSharingStatus: "not_shared" });
      source.rankObservations.push({ companyId, keyword, runId, collectedAt, rank: index + 1 });
    }
    const directory = path.join(root, "projection-" + index); await A.buildKeywordMonthlyProjection({ source, sourceFingerprint: K.hash(K.bytesFor(source)), outputDir: directory, materializedAt: NOW, now: () => NOW, compression: "gzip" }); inputs.push({ directory });
  }
  const liveDir = path.join(dataDir, "keyword_monthly_analysis"), initial = await B.publishKeywordMonthlyBundle({ inputs, outputDir: liveDir, now: NOW });
  await json(path.join(dataDir, "issued-reports", "keep.json"), { issued: "preserve exact original issue" });
  await json(path.join(dataDir, "customer_insight", "paused.json"), { enabled: false });
  await json(path.join(dataDir, "outputs", "synthetic", "manifest.json"), { original: true });
  const before = { original: await fs.readFile(path.join(dataDir, "outputs", "synthetic", "manifest.json")),
    issued: await fs.readFile(path.join(dataDir, "issued-reports", "keep.json")), paused: await fs.readFile(path.join(dataDir, "customer_insight", "paused.json")) };
  let executions = 0;
  const execute = async (_exe, argv, opts) => {
    executions++; const flag = name => argv[argv.indexOf(name) + 1], jobDir = flag("--job-root"), input = await H.read(flag("--input"), K.LIMITS.inventoryBytes), job = input.value;
    assert.equal(opts.receiptOnly, true); assert.equal(flag("--node-max-old-space-size"), "512");
    const pid = process.pid, proof = { schemaVersion: 1, mode: "fixture_only", pid, expectedRoot: jobDir, guardName: K.GUARD, guardSha256: flag("--guard-sha256"), nodeSha256: flag("--node-sha256") };
    const proofRead = await K.writeNew(flag("--proof"), proof), isolation = { mode: "fixture_only", pid, proofSha256: proofRead.sha256 };
    const guards = installGuards(jobDir, { codeRoot, readOnlyRoots: [path.join(liveDir, "current.json"), path.join(liveDir, "generations", job.source.generation)] }), scratch = installScratchBudget(jobDir, K.LIMITS.scratchBytes);
    const originalPrepare = B.prepareKeywordMonthlyBundle;
    if (variant.encodingSizeFailure) B.prepareKeywordMonthlyBundle = async () => { throw K.fault("KEYWORD_MONTHLY_RESULT_SIZE_LIMIT"); };
    try {
      if (variant.deniedOriginalRead) await fs.readFile(path.join(dataDir, "outputs", "synthetic", "manifest.json"));
      const result = await K.compile(job, { isolation, fixture: true });
      assert.ok(Object.values(guards.metrics).every(value => value === 0));
      if (variant.badParity) result.parity[0].logicalSha256 = "0".repeat(64);
      await K.writeNew(path.join(jobDir, "child-complete.json"), { ...result, guardMetrics: guards.metrics, scratch: scratch.status() });
    } finally { B.prepareKeywordMonthlyBundle = originalPrepare; scratch.restore(); guards.restore(); }
    if (variant.mutateOldGeneration) {
      const loaded = await B.loadBundle(liveDir), part = loaded.catalog.partitions[0], file = path.join(loaded.generationDir, "partitions", part.key, "index.json"); await fs.appendFile(file, " ");
    }
    if (variant.childAbort) throw Object.assign(new Error(), { code: "KEYWORD_PREP_CHILD_ABORTED" });
    return { exitCode: 0, receiptOnly: true, stdout: null, stderrBytes: null, pid };
  };
  const deps = { fixture: true, execute, waitForIdle: async () => ({ fixtureOnly: true }) }, request = { dataDir, codeRoot, now: NOW, expectedCurrentSha256: initial.pointerSha256 };
  return { root, dataDir, liveDir, before, request, deps, executions: () => executions, initial };
}
async function preserve(f) {
  assert.deepEqual(await fs.readFile(path.join(f.dataDir, "outputs", "synthetic", "manifest.json")), f.before.original);
  assert.deepEqual(await fs.readFile(path.join(f.dataDir, "issued-reports", "keep.json")), f.before.issued);
  assert.deepEqual(await fs.readFile(path.join(f.dataDir, "customer_insight", "paused.json")), f.before.paused);
  await assert.rejects(fs.access(path.join(f.dataDir, "keyword_monthly_incremental", "prepared-conversion-lock.json")), { code: "ENOENT" });
}
test("CLI validates exact modes and exposes no fixture or unrestricted option", () => {
  assert.equal(C.args(["--help"]).help, true);
  for (const argv of [[], ["--mode", "stage"], ["--mode", "inspect", "--job-dir", "relative"], ["--mode", "inspect", "--job-dir", path.resolve("fixture"), "--fixture", "true"]]) assert.throws(() => C.args(argv));
});
test("all old scopes convert exactly through guarded fixture child, preserving source and issue bytes", async t => {
  const f = await fixture(t), original = await K.inventory((await B.loadBundle(f.liveDir)).generationDir), staged = await C.stage(f.request, f.deps);
  assert.equal(staged.scopeCount, 6); assert.equal(staged.preparedResultCount, 6); assert.equal(f.executions(), 1);
  const sizesRead = await H.read(path.join(staged.jobDir, "legacy-result-sizes.json"), K.LIMITS.receiptBytes), sizes = sizesRead.value;
  assert.equal(sizes.scopeCount, 6); assert.equal(sizes.results.length, 6);
  const legacy = B.createKeywordMonthlyBundleAnalysis({ projectionDir: f.liveDir, now: () => NOW });
  for (const row of sizes.results) {
    assert.deepEqual(Object.keys(row).sort(), ["memory", "observationCount", "query", "resultJsonBytes"]);
    assert.deepEqual(Object.keys(row.query).sort(), ["cutoffDate", "keyword", "month"]);
    const result = await legacy.analyze(row.query);
    assert.equal(row.resultJsonBytes, Buffer.byteLength(JSON.stringify(result))); assert.equal(row.observationCount, result.snapshot.sources.observations.length);
    assert.ok(Object.values(row.memory).every(value => Number.isSafeInteger(value) && value >= 0));
  }
  assert.equal(sizes.maximumResultJsonBytes, Math.max(...sizes.results.map(row => row.resultJsonBytes)));
  const child = await H.read(path.join(staged.jobDir, "child-complete.json"), K.LIMITS.receiptBytes);
  assert.deepEqual(child.value.legacyResultSizes, { file: "legacy-result-sizes.json", sha256: sizesRead.sha256, bytes: sizesRead.bytes.length });
  assert.equal((await B.loadBundle(f.liveDir)).catalog.schemaVersion, 1); await K.assertInventory(original); await preserve(f);
  const result = await C.publish({ jobDir: staged.jobDir, completionSha256: staged.completionSha256, expectedCurrentSha256: f.request.expectedCurrentSha256 }, f.deps);
  assert.equal(result.status, "published"); assert.equal(result.parentProjectionAnalyses, 0); assert.equal(result.originalFreshnessVerified, false);
  const loaded = await B.loadBundle(f.liveDir); assert.equal(loaded.catalog.schemaVersion, 2); assert.equal(loaded.catalog.scopes.length, 6); await K.assertInventory(original); await preserve(f);
  const checked = await C.readStaged(staged.jobDir, staged.completionSha256, true), service = B.createKeywordMonthlyBundleAnalysis({ projectionDir: f.liveDir, now: () => NOW });
  for (const row of checked.child.value.parity) { const actual = await service.readPrepared(row.query); assert.equal(actual.preparedResult.status, "ready"); assert.equal(K.logicalHash(actual), row.logicalSha256); }
  assert.equal((await C.inspect(staged.jobDir)).status, "published_receipt_exists");
  await assert.rejects(C.stage({ ...f.request, expectedCurrentSha256: loaded.pointerRead.sha256 }, f.deps), /ALREADY_PREPARED/); assert.equal(f.executions(), 1);
});

test("payload-free legacy size evidence survives a later prepared encoding rejection without publishing", async t => {
  const f = await fixture(t, { encodingSizeFailure: true }), pointer = await fs.readFile(path.join(f.liveDir, "current.json"));
  await assert.rejects(C.stage(f.request, f.deps), /KEYWORD_MONTHLY_RESULT_SIZE_LIMIT/);
  const operations = path.join(f.dataDir, "operations", "keyword-prepared-conversion-20261115"), entries = await fs.readdir(operations);
  assert.equal(entries.length, 1);
  const jobDir = path.join(operations, entries[0]), sizes = await H.read(path.join(jobDir, "legacy-result-sizes.json"), K.LIMITS.receiptBytes);
  assert.equal(sizes.value.scopeCount, 6); assert.equal(sizes.value.results.length, 6);
  assert.ok(sizes.value.results.every(row => row.resultJsonBytes > 0 && row.observationCount > 0));
  assert.ok(!sizes.bytes.toString("utf8").includes("Synthetic conversion company"));
  await assert.rejects(fs.access(path.join(jobDir, "publication-preparation.json")), { code: "ENOENT" });
  assert.deepEqual(await fs.readFile(path.join(f.liveDir, "current.json")), pointer); await preserve(f);
});
test("stage is exclusive by deterministic operation id and never repeats a completed child", async t => {
  const f = await fixture(t); await C.stage(f.request, f.deps); await assert.rejects(C.stage(f.request, f.deps), /ALREADY_EXISTS/); assert.equal(f.executions(), 1); await preserve(f);
});
for (const name of ["worker-lock.json", "worker-lock-recovery-claim.json"]) test(`existing ${name} holds staging without executing or modifying lock`, async t => {
  const f = await fixture(t), file = path.join(f.dataDir, "keyword_monthly_incremental", name); await json(file, { unknown: "preserve" }); const prior = await fs.readFile(file);
  await assert.rejects(C.stage(f.request, f.deps), /WRITER_BUSY/); assert.equal(f.executions(), 0); assert.deepEqual(await fs.readFile(file), prior); await preserve(f);
});
for (const variant of ["deniedOriginalRead", "mutateOldGeneration", "childAbort", "badParity"]) test(`${variant} fails staging and leaves the original public pointer`, async t => {
  const f = await fixture(t, { [variant]: true }), pointer = await fs.readFile(path.join(f.liveDir, "current.json")); await assert.rejects(C.stage(f.request, f.deps));
  assert.deepEqual(await fs.readFile(path.join(f.liveDir, "current.json")), pointer); await preserve(f);
});
test("pre-promotion source change and copied result corruption preserve the last good pointer", async t => {
  const f = await fixture(t), staged = await C.stage(f.request, f.deps), pointer = await fs.readFile(path.join(f.liveDir, "current.json"));
  await assert.rejects(C.publish({ jobDir: staged.jobDir, completionSha256: staged.completionSha256, expectedCurrentSha256: f.request.expectedCurrentSha256 }, { ...f.deps,
    beforePromote: async candidate => { const file = path.join(f.liveDir, "generations", candidate.generation, "results"), name = (await fs.readdir(file))[0]; await fs.appendFile(path.join(file, name), " "); } }), /RESULT_CHANGED_BEFORE_PROMOTION/);
  assert.deepEqual(await fs.readFile(path.join(f.liveDir, "current.json")), pointer); await preserve(f); assert.equal((await C.inspect(staged.jobDir)).status, "needs_readback");
});
test("stage completion SHA, current pointer and result bytes are mandatory publication bindings", async t => {
  const f = await fixture(t), staged = await C.stage(f.request, f.deps), request = { jobDir: staged.jobDir, completionSha256: staged.completionSha256, expectedCurrentSha256: f.request.expectedCurrentSha256 };
  await assert.rejects(C.publish({ ...request, completionSha256: "0".repeat(64) }, f.deps), /COMPLETION_INVALID/);
  await assert.rejects(C.publish({ ...request, expectedCurrentSha256: "0".repeat(64) }, f.deps), /POINTER_CHANGED/);
  const p = await H.read(path.join(staged.jobDir, "publication-preparation.json"), K.LIMITS.receiptBytes), descriptor = p.value.preparedResults.descriptors[0];
  await fs.appendFile(path.join(p.value.preparedResults.directory, descriptor.sha256 + ".json" + (descriptor.encoding === "gzip" ? ".gz" : "")), " ");
  await assert.rejects(C.publish(request, f.deps), /RESULT_COPY_MISMATCH/); assert.equal((await B.loadBundle(f.liveDir)).pointerRead.sha256, f.request.expectedCurrentSha256); await preserve(f);
});
