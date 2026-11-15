"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs/promises"), path = require("node:path"), os = require("node:os"), crypto = require("node:crypto");
const F = require("./lib/keyword_monthly_incremental_failure.cjs"), H = require("./lib/keyword_monthly_refresh_preparation.cjs"), prep = require("./prepare_keyword_monthly_release.cjs");
const version = "keyword-monthly-incremental-v5";
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "keyword-failure-protocol-")), jobId = crypto.randomUUID(), jobRoot = path.join(root, "keyword_monthly_incremental", "jobs", "refresh-job-" + jobId);
  t.after(async () => { const resolved = await fs.realpath(root); assert.equal(path.dirname(resolved), await fs.realpath(os.tmpdir()));
    assert.match(path.basename(resolved), /^keyword-failure-protocol-/); await fs.rm(resolved, { recursive: true, force: true }); });
  await fs.mkdir(path.join(jobRoot, "control"), { recursive: true, mode: 0o700 }); if (process.platform !== "win32") await fs.chmod(jobRoot, 0o700);
  const evidence = { runId: "synthetic_run", keyword: "synthetic_keyword", manifestSha256: "a".repeat(64), status: "complete", quality: "complete", postprocessStatus: "complete", finishedAt: "2026-11-15T00:00:00.000Z" };
  const sourceKey = H.hash(JSON.stringify([version, evidence.runId, evidence.manifestSha256, evidence.keyword]));
  await H.writeNew(path.join(jobRoot, "refresh-owner.json"), { schemaVersion: 1, token: jobId, sourceKey, root: jobRoot });
  const input = await H.writeNew(path.join(jobRoot, "job-input.json"), { version, dataDir: root, evidence });
  const proof = await H.writeNew(path.join(jobRoot, "control", "isolation.json"), { mode: "seccomp", pid: process.pid, expectedRoot: jobRoot, noNewPrivs: true, seccompMode: 2,
    networkFdsClosed: true, preflightOnly: false, environmentSanitizedForExec: true, unrestrictedFallbackAllowed: false, providerCalls: 0, guardSha256: "b".repeat(64), nodeSha256: "c".repeat(64) });
  const options = { jobRoot, inputSha256: input.sha256, sourceKey, version, pid: process.pid, proofSha256: proof.sha256, guardSha256: "b".repeat(64), nodeSha256: "c".repeat(64) };
  return { root, jobRoot, options, binding: await F.captureBinding(options), progress: { phase: "scope_normalize", scopeIndex: 12, plannedScopes: 73, completedParts: 12 }, codeRoot: path.resolve(__dirname, "..") };
}
async function write(f, error = Object.assign(new RangeError("DO_NOT_PERSIST customer phone token payload"), { code: "KEYWORD_INCREMENTAL_SYNTHETIC_FAILURE" })) {
  error.stack = error.name + ": DO_NOT_PERSIST\n    at controlled (" + path.join(f.codeRoot, "scripts", "lib", "keyword_monthly_incremental_normalize.cjs") + ":44:12)\n    at unknown (C:/private/customer.cjs:1:1)";
  return F.writeFailure({ binding: f.binding, error, codeRoot: f.codeRoot, progress: f.progress, startedAt: Date.now() - 10 });
}
test("controlled failures persist only bounded fields and exact ownership, input, proof and child identity", async t => {
  const f = await fixture(t), saved = await write(f), value = await F.readFailure(f.options), raw = await fs.readFile(F.failureFile(f.jobRoot), "utf8");
  assert.equal(saved.sha256, value.receiptSha256); assert.equal(value.code, "KEYWORD_INCREMENTAL_SYNTHETIC_FAILURE"); assert.equal(value.errorType, "RangeError");
  assert.equal(value.progress.scopeIndex, 12); assert.equal(value.memory.heapSizeLimit > 0, true); assert.equal(value.pid, process.pid);
  assert.deepEqual(value.frames, [{ file: "lib/keyword_monthly_incremental_normalize.cjs", line: 44, column: 12 }]);
  assert.equal(/DO_NOT_PERSIST|phone|token|payload|private\/customer/.test(raw), false); assert.equal(Buffer.byteLength(raw) < F.MAX_BYTES, true);
  if (process.platform !== "win32") assert.equal((await fs.stat(F.failureFile(f.jobRoot))).mode & 0o777, 0o600);
  await assert.rejects(write(f), { code: "EEXIST" }); assert.equal(await fs.readFile(F.failureFile(f.jobRoot), "utf8"), raw);
});
for (const variant of ["pid", "input", "owner", "proof", "guard", "source", "oversized", "private-field", "memory", "progress", "symlink"]) test("failure evidence rejects " + variant + " without adopting its code", async t => {
  const f = await fixture(t); await write(f); let options = { ...f.options };
  if (variant === "pid") options.pid++;
  if (variant === "guard") options.guardSha256 = "d".repeat(64);
  if (variant === "source") options.sourceKey = "d".repeat(64);
  if (["input", "owner", "proof"].includes(variant)) {
    const file = path.join(f.jobRoot, variant === "input" ? "job-input.json" : variant === "owner" ? "refresh-owner.json" : "control/isolation.json"); await fs.appendFile(file, " ");
  }
  const file = F.failureFile(f.jobRoot);
  if (variant === "oversized") await fs.writeFile(file, "x".repeat(F.MAX_BYTES + 1));
  if (["private-field", "memory", "progress"].includes(variant)) { const v = JSON.parse(await fs.readFile(file));
    if (variant === "private-field") v.password = "DO_NOT_PERSIST"; else if (variant === "memory") v.memory.heapUsed = -1; else v.progress.scopeIndex = 100000;
    await fs.writeFile(file, JSON.stringify(v)); }
  if (variant === "symlink") { await fs.rename(file, file + ".kept"); try { await fs.symlink(file + ".kept", file); } catch (e) { if (process.platform === "win32" && ["EPERM", "EACCES"].includes(e.code)) { t.skip("Windows fixture has no symlink permission"); return; } throw e; } }
  await assert.rejects(F.readFailure(options));
});
test("missing failure evidence is explicit and cannot replace the process exit observation", async t => {
  const f = await fixture(t); assert.equal(await F.readFailure(f.options), null);
  assert.deepEqual(F.termination({ pid: 123, exitCode: null, exitSignal: "SIGKILL", message: "DO_NOT_PERSIST" }), { childPid: 123, childExitCode: null, childExitSignal: "SIGKILL" });
  assert.deepEqual(F.termination({ pid: -1, exitCode: Infinity, exitSignal: "DO_NOT_PERSIST" }), { childPid: null, childExitCode: null, childExitSignal: null });
});
test("numeric scope markers stay inside the same guarded private namespace and scratch budget", async t => {
  const f = await fixture(t), { installGuards } = require("./reconstruct_keyword_monthly_source_copy.cjs"), { installScratchBudget } = require("./lib/keyword_monthly_scratch_budget.cjs");
  const guards = installGuards(path.join(f.root, "keyword_monthly_incremental"), { codeRoot: f.codeRoot }), scratch = installScratchBudget(f.jobRoot);
  try {
    for (const phase of F.SCOPE_PHASES) await F.writePhase({ binding: f.binding, phase, scopeIndex: 12, startedAt: Date.now() });
    const files = (await fs.readdir(f.jobRoot)).filter(name => name.startsWith("phase-")); assert.equal(files.length, 4);
    for (const name of files) { const value = JSON.parse(await fs.readFile(path.join(f.jobRoot, name))); assert.equal(value.scopeIndex, 12); assert.equal(value.pid, process.pid);
      assert.equal(value.memory.heapUsed > 0, true); assert.equal(value.jobInputSha256, f.binding.inputSha256); assert.equal(Buffer.byteLength(JSON.stringify(value)) <= 4096, true); }
    assert.equal(Object.values(guards.metrics).some(Boolean), false); assert.equal(scratch.status().deniedOperations, 0);
  } finally { scratch.restore(); guards.restore(); }
  await assert.rejects(F.writePhase({ binding: f.binding, phase: "normalize_before", scopeIndex: 12, startedAt: Date.now() }), { code: "EEXIST" });
  await assert.rejects(F.writePhase({ binding: f.binding, phase: "normalize_before", scopeIndex: 128, startedAt: Date.now() }), { code: "KEYWORD_INCREMENTAL_FAILURE_EVIDENCE_INVALID" });
});
test("receipt-only runner keeps dev/null and reports the actual closed child termination", async () => {
  await assert.rejects(prep.runChild(process.execPath, ["-e", "process.stderr.write('DO_NOT_PERSIST');process.exit(7)"], { receiptOnly: true }), e =>
    e.code === "KEYWORD_PREP_CHILD_FAILED" && e.exitCode === 7 && e.exitSignal === null && e.pid > 0 && e.childCode === null && !e.message.includes("DO_NOT_PERSIST"));
  await assert.rejects(prep.runChild(process.execPath, ["-e", "setInterval(()=>{},1000)"], { receiptOnly: true, timeout: 100 }), e =>
    e.code === "KEYWORD_PREP_CHILD_TIMEOUT" && e.pid > 0 && e.exitCode === null && e.exitSignal === "SIGKILL");
});
test("scope diagnostics select exactly one original plan index while the default retains all indexes", () => {
  const { args, selectedScopeIndexes } = require("./reconstruct_keyword_monthly_incremental.cjs"), plan = { scopes: Array.from({ length: 73 }, (_, i) => ({ position: i })) };
  assert.deepEqual(selectedScopeIndexes(plan), Array.from({ length: 73 }, (_, i) => i)); assert.deepEqual(selectedScopeIndexes(plan, "12"), [12]);
  for (const invalid of ["73", "128", "-1", "01", "12;secret", "1.5"]) assert.throws(() => selectedScopeIndexes(plan, invalid), { code: "KEYWORD_INCREMENTAL_DIAGNOSTIC_SCOPE_INVALID" });
  const root = path.resolve(os.tmpdir()), base = ["--input", path.join(root, "job-input.json"), "--input-sha", "a".repeat(64), "--job-root", root, "--code-root", root, "--isolation-proof", path.join(root, "control/isolation.json")];
  assert.equal(args(base)["diagnostic-scope"], undefined); assert.equal(args([...base, "--diagnostic-scope", "12"])["diagnostic-scope"], "12");
  assert.throws(() => args([...base, "--diagnostic-scope", "128"]), { code: "KEYWORD_INCREMENTAL_DIAGNOSTIC_SCOPE_INVALID" });
});
test("diagnostic expectations bind the actual newly calculated plan before normalization and leave normal work unchanged", () => {
  const { planScopes } = require("./lib/keyword_monthly_incremental_plan.cjs"), { assertDiagnosticExpectation } = require("./reconstruct_keyword_monthly_incremental.cjs");
  const plan = planScopes({ state: { globalDiagnosticsDirty: true, runs: [], history: { partitions: [] } },
    catalog: { scopes: [{ keyword: "경남글램핑", month: "2026-10" }, { keyword: "경남글램핑", month: "2026-11" }] },
    evidence: { keyword: "경주글램핑" }, range: { stayMonths: ["2026-11"], collectionMonth: "2026-11" }, capturedAt: "2026-11-15T00:00:00.000Z", inputsFingerprint: "a".repeat(64) });
  const index = plan.scopes.findIndex(scope => scope.keyword === "경남글램핑" && scope.month === "2026-11"); assert.ok(index >= 0);
  const expected = { scopeIndex: index, keyword: "경남글램핑", month: "2026-11" }; assert.doesNotThrow(() => assertDiagnosticExpectation(plan, String(index), expected));
  for (const changed of [undefined, null, { ...expected, scopeIndex: index + 1 }, { ...expected, keyword: "경주글램핑" }, { ...expected, month: "2026-10" }, { ...expected, extra: true }])
    assert.throws(() => assertDiagnosticExpectation(plan, String(index), changed), { code: "KEYWORD_INCREMENTAL_DIAGNOSTIC_EXPECTATION_MISMATCH" });
  assert.doesNotThrow(() => assertDiagnosticExpectation(plan, undefined, undefined)); assert.doesNotThrow(() => assertDiagnosticExpectation(plan, undefined, { invalid: "ignored by normal mode" }));
});
test("one-scope diagnostics run real current/previous semantic validation without a publication or normal completion artifact", async t => {
  const f = await fixture(t), { buildKeywordMonthlyProjection, createKeywordMonthlyAnalysis } = require("./lib/keyword_monthly_analysis.cjs"), { prepareDiagnosticProjection } = require("./reconstruct_keyword_monthly_incremental.cjs");
  const capturedAt = "2026-11-15T12:00:00.000Z", keyword = "synthetic_keyword", directory = path.join(f.jobRoot, "part-012"), source = {
    companies: [{ companyId: "cmp_synthetic", primaryName: "Synthetic diagnostic", capacity: 5 }], runs: [], observations: [], rankObservations: [], savedProductRecoveries: [], warnings: [], sourceDiagnostics: {} };
  for (const [month, sold] of [["2026-10", 1], ["2026-11", 2]]) { const runId = "synthetic_" + month, collectedAt = month + "-14T00:00:00.000Z";
    source.runs.push({ id: runId, keyword, collectedAt, collectionQuality: { status: "complete" } });
    source.observations.push({ companyId: "cmp_synthetic", runId, keyword, productType: "lodging", stayDate: month + "-20", collectedAt, inventoryEvidenceVersion: 4,
      supply: 5, sold, publicBookings: sold, phoneBookings: 0, publicRevenue: sold * 100, phoneRevenue: 0, estimatedRevenue: sold * 100 }); }
  const built = await buildKeywordMonthlyProjection({ source, sourceFingerprint: H.hash(JSON.stringify(source)), outputDir: directory, materializedAt: capturedAt, dataThrough: capturedAt,
    now: () => capturedAt, publishMonths: ["2026-11"] }), indexBefore = await fs.readFile(path.join(directory, "index.json"));
  const result = await prepareDiagnosticProjection({ binding: f.binding, scopeIndex: 12, inputs: [{ directory, exposeScopes: [{ keyword, month: "2026-11" }] }], capturedAt });
  const original = await createKeywordMonthlyAnalysis({ projectionDir: directory, now: () => capturedAt }).analyze({ keyword, month: "2026-11", cutoffDate: "2026-11-15" });
  assert.equal(built.scopeCount, 1); assert.ok(original.snapshot.comparison, "the previous-month calculation is included");
  assert.equal(result.selectedDigest, original.snapshot.sources.digest); assert.equal(result.diagnosticOnly, true); assert.equal(result.scopeIndex, 12); assert.equal(result.preparationCompleteCreated, false);
  assert.equal(result.operatingPointerChanged, false); assert.equal(result.queueChanged, false); assert.equal(result.resultBytes > 0, true);
  assert.deepEqual(await fs.readFile(path.join(directory, "index.json")), indexBefore);
  for (const file of ["preparation-complete.json", "current.json", "diagnostic-complete.json"]) await assert.rejects(fs.lstat(path.join(f.jobRoot, file)), { code: "ENOENT" });
  assert.equal((await fs.readdir(path.join(f.jobRoot, "diagnostic-results"))).length, 1);
});
