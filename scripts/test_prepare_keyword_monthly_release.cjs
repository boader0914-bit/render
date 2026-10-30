"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs/promises"), os = require("node:os"), path = require("node:path"), crypto = require("node:crypto");
const prep = require("./prepare_keyword_monthly_release.cjs"), builder = require("./build_keyword_monthly_projection.cjs");
const { buildMonthlyReportSnapshot } = require("./lib/monthly_reports.cjs"), { previousMonthlyReportRequest } = require("./lib/monthly_report_comparison.cjs"), { sourceForKeywordMonthlyRequest } = require("./lib/keyword_monthly_analysis.cjs");
const sha = b => crypto.createHash("sha256").update(b).digest("hex"), NOW = "2026-10-30T04:00:00.000Z", CAPTURE = "2026-10-30T03:00:00.000Z";
const ZERO_GUARD = { networkAttempts: 0, childProcessAttempts: 0, outsideCopyWriteAttempts: 0, outsideReadAttempts: 0, appEntryExecutions: 0, providerFactories: 0 };
const OUTPUT_VERIFY = { inventoryPreserved: true, originalWrites: 0, metrics: { originalWriteAttempts: 0, uncapturedReadAttempts: 0, validationDenials: 0 } };
const SCRATCH = { maximumBytes: 1024 ** 3, peakReservedAndAllocatedBytes: 10000, deniedOperations: 0 };
const valueOf = (argv, key) => argv[argv.indexOf(key) + 1];
async function json(file, value) { await fs.writeFile(file, JSON.stringify(value), { flag: "wx" }); }
function source(keyword, observed = true) {
  const runs = ["2026-09", "2026-10"].map((month, i) => ({ id: "r" + i, keyword, collectedAt: month + "-05T01:00:00.000Z", collectionQuality: { status: "complete" } }));
  const observations = runs.flatMap((run, i) => (!observed && i === 1 ? [] : ["lodging", "dayuse"].map(productType => ({ companyId: "c", runId: run.id, keyword, collectedAt: run.collectedAt,
    stayDate: run.collectedAt.slice(0, 10), productType, inventoryEvidenceVersion: 4, supply: 10, sold: i + 2, publicBookings: i + 2, phoneBookings: 0, publicRevenue: 100 * (i + 2), phoneRevenue: 0, estimatedRevenue: 100 * (i + 2),
    sharedDayUseExcluded: 0, explicitBlockedBookings: 0, phoneMissingPriceBookings: 0, partial: false, missing: false, unknownUnavailable: 0, dayUsePresence: "present", dayUseSharingStatus: "not_shared", capacityBasis: { count: 10, source: "db_correction" } }))));
  return { companies: [{ companyId: "c", primaryName: "Fixture", capacity: 10, capacitySource: "db_correction" }], runs, observations, rankObservations: [], savedProductRecoveries: [], warnings: [], sourceDiagnostics: {},
    monthlySourceMetadata: Object.fromEntries(["2026-09", "2026-10"].map(month => [month, { warnings: [], sourceDiagnostics: {}, globalWarnings: [], globalDiagnostics: {} }])) };
}
async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "keyword-release-coordinator-"));
  t.after(async () => { assert.equal(path.dirname(root), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith("keyword-release-coordinator-")); await fs.rm(root, { recursive: true, force: true }); });
  const code = path.join(root, "code"), copy = path.join(root, "keyword-monthly-source-12345678"), original = path.join(root, "original"), ops = options.durableOps ? path.join(original, "operations", "monthly-keyword-production-20261030") : path.join(root, "ops");
  for (const dir of [path.join(code, "scripts"), path.join(copy, "control"), path.join(copy, "data"), path.join(copy, "discovery"), ops, original]) await fs.mkdir(dir, { recursive: true });
  if (options.durableOps) await fs.chmod(ops, 0o700);
  const files = ["reconstruct_keyword_monthly_source_copy.cjs", "build_keyword_monthly_projection.cjs", "prepare_keyword_monthly_release.cjs", "launch_keyword_monthly_isolated.py"];
  for (const name of files) await fs.writeFile(path.join(code, "scripts", name), "fixture pin " + name);
  const node = path.join(root, "node"), python = path.join(root, "python3"); await fs.writeFile(node, "fixture-node"); await fs.writeFile(python, "fixture-python");
  const capture = { state: "complete", copyRoot: copy, dataDir: path.join(copy, "data"), capturedAt: CAPTURE, sourceWrites: 0, sourcePreserved: true, sourceInventorySha256: "d".repeat(64), physicalCopiesOnly: true, wholeSourcePhysicallyCopied: false,
    captureMode: "core_physical_copy_with_readonly_original_outputs", sourceDataDir: original, originalOutputs: { root: path.join(original, "outputs"), copied: false, writeAllowed: false } };
  const captureFile = path.join(copy, "control/capture-complete.json"); await json(captureFile, capture); const captureSha = sha(await fs.readFile(captureFile));
  const candidates = options.candidates || [{ keyword: "가평글램핑", month: "2026-10" }, { keyword: "경남글램핑", month: "2026-10" }];
  const discovery = { schemaVersion: 1, state: "complete", mode: "discover", copiedAt: CAPTURE, captureManifestSha256: captureSha, candidates, malformedHistoryLines: 0, syntheticCurrentMonthNotTreatedAsEvidence: true,
    observationIndexMode: "exact_application_streaming_fallback", providerCalls: 0, sourceWrites: 0, appEntryExecutions: 0, operatingMutations: 0, guardMetrics: { ...ZERO_GUARD }, scratch: { ...SCRATCH }, immutableCopyInputsAfter: { preserved: true }, originalOutputVerification: OUTPUT_VERIFY };
  const discoveryFile = path.join(copy, "discovery/discovery-complete.json"); await json(discoveryFile, discovery);
  const guardSha = sha(await fs.readFile(path.join(code, "scripts", files[0]))), nodeSha = sha(await fs.readFile(node)), preparedRoot = path.join(ops, "prepared"), progress = [], calls = [];
  const argv = ["--code-root", code, "--copy-root", copy, "--prepared-root", preparedRoot, "--discovery-complete", discoveryFile, "--capture-sha", captureSha, "--node-path", node, "--node-sha", nodeSha, "--guard-sha", guardSha,
    "--launcher-path", path.join(code, "scripts", files[3]), "--python-path", python, "--prep-date", NOW];
  async function execute(executable, values) {
    calls.push({ executable, values });
    if (executable === python) {
      if (options.failNormalization) return { exitCode: 1, stderrBytes: 0, stdout: { state: "failed" }, pid: 4321 };
      const keyword = valueOf(values, "--keyword"), month = valueOf(values, "--month"), cutoffDate = valueOf(values, "--cutoff"), output = valueOf(values, "--output"), proofFile = valueOf(values, "--proof");
      await fs.mkdir(output);
      const src = source(keyword, keyword !== options.notObserved), bytes = Buffer.from(JSON.stringify(src)), sourceFile = path.join(output, "source.json"); await fs.writeFile(sourceFile, bytes, { flag: "wx" });
      const proof = { mode: "seccomp", noNewPrivs: true, seccompMode: 2, networkFdsClosed: true, expectedRoot: copy, preflightOnly: false, environmentSanitizedForExec: true, unrestrictedFallbackAllowed: false, providerCalls: 0, guardSha256: guardSha, nodeSha256: nodeSha, pid: 4321,
        kernelProbe: { tcpSocketDenied: true, udpSocketDenied: true, ipv6SocketDenied: true, syscallsDeniedWithEperm: Object.fromEntries(["socket", "socketpair", "connect", "sendto", "sendmsg"].map(k => [k, true])) } }; await json(proofFile, proof);
      const current = { type: "keyword", targetId: keyword, month, cutoffDate }, requests = [previousMonthlyReportRequest(current), current];
      const records = requests.map(request => ({ request, scopedCounts: { observations: src.observations.filter(r => r.stayDate.startsWith(request.month)).length, rankObservations: 0, savedProductRecoveries: 0 }, sameSourceFinancialAndDiagnosticParity: true, snapshotFingerprint: prep.fingerprint(prep.snapshotCore(buildMonthlyReportSnapshot(request, sourceForKeywordMonthlyRequest(src, request), CAPTURE))) }));
      if (options.tamperParity) records[1].snapshotFingerprint = "0".repeat(64);
      if (options.recordMutation === "duplicate") records[0] = { ...records[1] };
      if (options.recordMutation === "month") records[0].request = { ...records[0].request, month: "2026-08" };
      if (options.recordMutation === "keyword") records[0].request = { ...records[0].request, targetId: "다른글램핑" };
      const complete = { state: "complete", currentRequest: current, captureManifestSha256: captureSha, sourceInventorySha256: capture.sourceInventorySha256, dataThrough: CAPTURE, snapshotCapturedAt: CAPTURE, copiedAt: CAPTURE,
        captureMode: capture.captureMode, observationIndexMode: "exact_application_streaming_fallback", sourceFile, sourceSha256: sha(bytes), sourceBytes: bytes.length, sourceWrites: 0, operatingMutations: 0, appEntryExecutions: 0, providerFactories: 0,
        guardMetrics: { ...ZERO_GUARD, ...(options.denial ? { outsideReadAttempts: 1 } : {}) }, sourceMetrics: { deniedRequires: 0 }, scratch: { ...SCRATCH }, copyInputsBefore: { preserved: true }, immutableCopyInputsAfter: { preserved: true }, originalOutputVerification: OUTPUT_VERIFY,
        isolation: { proofSha256: sha(await fs.readFile(proofFile)), pid: 4321, tcpKernelDenied: true, udpKernelDenied: true }, records, counts: Object.fromEntries(["companies", "runs", "observations", "rankObservations", "savedProductRecoveries"].map(k => [k, src[k].length])) };
      await json(path.join(output, "reconstruction-complete.json"), complete); await json(path.join(output, "provenance.json"), { inputSha256: sha(bytes), inputBytes: bytes.length, copiedAt: CAPTURE, observationScope: "normalized_multirun", normalizationCutoffs: Object.fromEntries(requests.map(r => [r.month, r.cutoffDate])) });
      return { exitCode: 0, stderrBytes: 0, pid: 4321, stdout: { state: "complete", sourceSha256: sha(bytes), sourceBytes: bytes.length } };
    }
    if (values.includes("--verify-child")) {
      const p = values.slice(values.indexOf("--verify-child") + 1), result = await prep.verifyProjection({ projection: p[0], completeFile: p[1], output: p[2], now: p[3], keyword: p[4], month: p[5], cutoffDate: p[6] });
      return { exitCode: 0, stderrBytes: 0, stdout: result };
    }
    const result = await builder.run(values.slice(2)); if (options.changeSourceAfterBuild) await fs.appendFile(valueOf(values, "--source"), " ");
    if (options.dropTargetDescriptor) { const file = path.join(result.projectionDir, "index.json"), index = JSON.parse(await fs.readFile(file)); for (const item of index.keywords) { for (const key of ["stayMonths", "inventoryStayMonths", "rankMonths"]) item[key] = item[key].filter(month => month !== "2026-10"); item.scopes = item.scopes.filter(scope => scope.month !== "2026-10"); } await fs.writeFile(file, JSON.stringify(index)); result.indexSha256 = sha(await fs.readFile(file)); }
    return { exitCode: 0, stderrBytes: 0, stdout: result };
  }
  return { root, code, copy, ops, original, argv, preparedRoot, captureFile, discoveryFile, progress, calls, execute, deps: { fixture: true, runChild: execute, progress: row => progress.push(row) } };
}
test("fixed cutoffs use KST date, month end and capture date, including future and leap months", () => {
  assert.equal(prep.cutoffFor("2026-10", NOW, "2026-10-22T23:00:00.000Z"), "2026-10-23");
  assert.equal(prep.cutoffFor("2026-09", NOW, CAPTURE), "2026-09-30");
  assert.equal(prep.cutoffFor("2026-11", NOW, CAPTURE), "2026-10-30");
  assert.equal(prep.cutoffFor("2024-02", NOW, CAPTURE), "2024-02-29");
  assert.throws(() => prep.cutoffFor("2026-13", NOW, CAPTURE), { code: "KEYWORD_PREP_MONTH" });
});
test("argument parser rejects unknown, duplicate, relative and invalid-clock arguments", async t => {
  const f = await fixture(t);
  assert.equal(prep.args(f.argv)["budget-root"], f.ops);
  assert.throws(() => prep.args([...f.argv, "--prep-date", NOW]), { code: "KEYWORD_PREP_ARGUMENTS" });
  assert.throws(() => prep.args([...f.argv, "--publish", "yes"]), { code: "KEYWORD_PREP_ARGUMENTS" });
  const bad = [...f.argv]; bad[bad.indexOf("--code-root") + 1] = "relative"; assert.throws(() => prep.args(bad), { code: "KEYWORD_PREP_ABSOLUTE_PATH" });
});
test("complete fixture runs real gzip builder/factory parity, reconciles notObserved, prepares exact scopes and deletes only owned sources", async t => {
  const f = await fixture(t, { notObserved: "경남글램핑" }), original = await fs.readFile(f.captureFile), discovery = await fs.readFile(f.discoveryFile), result = await prep.run(f.argv, f.deps);
  assert.equal(result.state, "complete"); assert.equal(result.preparedCount, 1); assert.equal(result.notObservedCount, 1); assert.equal(result.pointerPublished, false); assert.equal(result.candidatesReconciled, true);
  const plan = JSON.parse(await fs.readFile(result.planFile)); assert.equal(plan.inputs.length, 1); assert.deepEqual(plan.inputs[0].exposeScopes, [{ keyword: "가평글램핑", month: "2026-10" }]);
  assert.equal(f.calls.length, 6); assert.deepEqual(f.progress.map(r => r.stage), ["normalizing", "building", "prepared", "normalizing", "building", "notObserved", "complete"]);
  const part = path.dirname(plan.inputs[0].directory), verify = JSON.parse(await fs.readFile(path.join(part, "factory-verification.json"))); assert.equal(verify.checks.length, 2); assert.ok(verify.checks.every(r => r.exact));
  const complete = JSON.parse(await fs.readFile(path.join(part, "reconstruction-complete.json"))); await assert.rejects(fs.stat(complete.sourceFile), { code: "ENOENT" });
  assert.deepEqual(await fs.readFile(f.captureFile), original); assert.deepEqual(await fs.readFile(f.discoveryFile), discovery);
  await assert.rejects(fs.stat(path.join(f.ops, "current.json")), { code: "ENOENT" });
  const index = JSON.parse(await fs.readFile(path.join(plan.inputs[0].directory, "index.json"))); assert.ok(index.keywords[0].scopes.every(r => r.encoding === "gzip"));
  await assert.rejects(prep.run(f.argv, f.deps), { code: "KEYWORD_PREP_ALREADY_EXISTS" });
});
test("failed candidate stops immediately without a success plan, next scope or pointer", async t => {
  const f = await fixture(t, { failNormalization: true }); await assert.rejects(prep.run(f.argv, f.deps), { code: "KEYWORD_PREP_NORMALIZE_CHILD_FAILED" }); assert.equal(f.calls.length, 1);
  await assert.rejects(fs.stat(path.join(f.preparedRoot, "bundle-plan.json")), { code: "ENOENT" });
  const failed = JSON.parse(await fs.readFile(path.join(f.preparedRoot, "preparation-failed.json"))); assert.equal(failed.state, "failed"); assert.equal(failed.pointerPublished, false); assert.equal(failed.noSuccessPlan, true);
});
test("financial mismatch is a real failure and source remains for diagnosis", async t => {
  const f = await fixture(t, { tamperParity: true }); await assert.rejects(prep.run(f.argv, f.deps), { code: "KEYWORD_PREP_FINANCIAL_PARITY_FAILED" }); assert.equal(f.calls.length, 3);
  const scratch = (await fs.readdir(f.copy)).find(name => name.startsWith("prepare-release-")); const scope = (await fs.readdir(path.join(f.copy, scratch))).find(name => name !== "owner.json");
  assert.ok((await fs.stat(path.join(f.copy, scratch, scope, "source.json"))).size > 0); await assert.rejects(fs.stat(path.join(f.preparedRoot, "bundle-plan.json")), { code: "ENOENT" });
});
test("zero-denial receipt gate stops before build and never turns denial into notObserved", async t => {
  const f = await fixture(t, { denial: true }); await assert.rejects(prep.run(f.argv, f.deps), { code: "KEYWORD_PREP_SIDE_EFFECT_GATE" }); assert.equal(f.calls.length, 1);
});
test("a lost descriptor with actual current observations fails instead of being classified notObserved", async t => {
  const f = await fixture(t, { dropTargetDescriptor: true }); await assert.rejects(prep.run(f.argv, f.deps), { code: "KEYWORD_PREP_OBSERVED_DESCRIPTOR_MISSING" });
  await assert.rejects(fs.stat(path.join(f.preparedRoot, "bundle-plan.json")), { code: "ENOENT" });
  const scratch = (await fs.readdir(f.copy)).find(name => name.startsWith("prepare-release-")), scope = (await fs.readdir(path.join(f.copy, scratch))).find(name => name !== "owner.json"); assert.ok((await fs.stat(path.join(f.copy, scratch, scope, "source.json"))).size > 0);
});
test("duplicate current records, third month and wrong previous keyword fail exact two-request coverage", async t => {
  for (const recordMutation of ["duplicate", "month", "keyword"]) { const f = await fixture(t, { recordMutation }); await assert.rejects(prep.run(f.argv, f.deps), { code: "KEYWORD_PREP_RECORDS_INVALID" }); assert.equal(f.calls.length, 1); }
});
test("authorized durable OPS under DATA_DIR is accepted only at the date-specific private owner namespace", async t => {
  const f = await fixture(t, { durableOps: true }), capture = JSON.parse(await fs.readFile(f.captureFile)), input = prep.args(f.argv);
  const authorization = await prep.storageScope(capture, input); assert.equal(authorization.basis, "dedicated_durable_operations_namespace");
  const result = await prep.run(f.argv, f.deps); assert.equal(result.state, "complete"); assert.ok(result.planFile.startsWith(f.ops + path.sep)); assert.equal(result.pointerPublished, false);
  for (const bad of [f.original, path.join(f.original, "history"), path.join(f.original, "operations", "arbitrary"), path.join(f.original, "operations", "monthly-keyword-production-20261029"), os.tmpdir()]) {
    await assert.rejects(prep.storageScope(capture, { ...input, "budget-root": bad, "prepared-root": path.join(bad, "prepared") }), { code: "KEYWORD_PREP_OPS_SCOPE" });
  }
  if (typeof process.getuid === "function") { await fs.chmod(f.ops, 0o755); await assert.rejects(prep.storageScope(capture, input), { code: "KEYWORD_PREP_OPS_PERMISSIONS" }); }
  const directory = { isDirectory: () => true, mode: 0o40700, uid: 1000 }; prep.privateOpsStat(directory, 1000);
  assert.throws(() => prep.privateOpsStat({ ...directory, uid: 1001 }, 1000), { code: "KEYWORD_PREP_OPS_PERMISSIONS" });
  assert.throws(() => prep.privateOpsStat({ ...directory, mode: 0o40750 }, 1000), { code: "KEYWORD_PREP_OPS_PERMISSIONS" });
});
test("durable OPS rejects capture input overlap without reading any original body", async t => {
  const f = await fixture(t, { durableOps: true }), capture = JSON.parse(await fs.readFile(f.captureFile)); capture.inputFiles = [{ relative: "operations/monthly-keyword-production-20261030/source.json" }];
  await assert.rejects(prep.storageScope(capture, prep.args(f.argv)), { code: "KEYWORD_PREP_OPS_INPUT_OVERLAP" });
});
test("source mutation after build refuses cleanup and final plan", async t => {
  const f = await fixture(t, { changeSourceAfterBuild: true }); await assert.rejects(prep.run(f.argv, f.deps), { code: "KEYWORD_PREP_SOURCE_CHANGED_BEFORE_DELETE" });
  await assert.rejects(fs.stat(path.join(f.preparedRoot, "bundle-plan.json")), { code: "ENOENT" });
});
test("capture SHA mismatch and existing destinations fail before launching any child", async t => {
  const f = await fixture(t), bad = [...f.argv]; bad[bad.indexOf("--capture-sha") + 1] = "0".repeat(64); await assert.rejects(prep.run(bad, f.deps), { code: "KEYWORD_PREP_CAPTURE_INVALID" }); assert.equal(f.calls.length, 0);
  await fs.mkdir(f.preparedRoot); await assert.rejects(prep.run(f.argv, f.deps), { code: "KEYWORD_PREP_ALREADY_EXISTS" });
});
test("persistent preflight counts existing logical sparse bytes and cannot begin above the hard reserve", async t => {
  const f = await fixture(t), sparse = path.join(f.ops, "existing.bin"); await fs.writeFile(sparse, "x"); await fs.truncate(sparse, 1024 ** 3 - 1024);
  await assert.rejects(prep.run(f.argv, f.deps), { code: "KEYWORD_PREP_STORAGE_BOUND" }); assert.equal(f.calls.length, 0); await assert.rejects(fs.stat(f.preparedRoot), { code: "ENOENT" });
});
test("path reader rejects hardlinks and deletion ownership cannot target existing originals", async t => {
  const f = await fixture(t), original = path.join(f.original, "keep.json"); await fs.writeFile(original, "important"); const linked = path.join(f.ops, "linked.json"); await fs.link(original, linked);
  await assert.rejects(prep.read(linked), { code: "KEYWORD_PREP_UNSAFE_PATH" }); await fs.unlink(linked);
  await assert.rejects(prep.deleteOwnedSource(original, {}, { normalization: path.join(f.copy, "made"), scratchRoot: f.copy }), { code: "KEYWORD_PREP_DELETE_OWNERSHIP" }); assert.equal(await fs.readFile(original, "utf8"), "important");
});
test("discovery duplicates and malformed history cannot become a partial success catalog", () => {
  const base = { state: "complete", mode: "discover", captureManifestSha256: "f".repeat(64), malformedHistoryLines: 0, syntheticCurrentMonthNotTreatedAsEvidence: true, observationIndexMode: "exact_application_streaming_fallback",
    providerCalls: 0, sourceWrites: 0, appEntryExecutions: 0, operatingMutations: 0, guardMetrics: ZERO_GUARD, scratch: SCRATCH, immutableCopyInputsAfter: { preserved: true }, originalOutputVerification: OUTPUT_VERIFY };
  const row = { keyword: "가평글램핑", month: "2026-10" };
  assert.throws(() => prep.validateDiscovery({ ...base, candidates: [row, row] }, "f".repeat(64)), { code: "KEYWORD_PREP_DUPLICATE_CANDIDATE" });
  assert.throws(() => prep.validateDiscovery({ ...base, candidates: [row], malformedHistoryLines: 1 }, "f".repeat(64)), { code: "KEYWORD_PREP_DISCOVERY_INVALID" });
});
test("subprocess protocol bounds raw output, timeout and nonzero exit without surfacing stderr", async () => {
  await assert.rejects(prep.runChild(process.execPath, ["-e", "process.stdout.write('x'.repeat(10000))"], { outputBound: 100 }), { code: "KEYWORD_PREP_CHILD_OUTPUT_BOUND" });
  await assert.rejects(prep.runChild(process.execPath, ["-e", "setInterval(()=>{},1000)"], { timeout: 50 }), { code: "KEYWORD_PREP_CHILD_TIMEOUT" });
  await assert.rejects(prep.runChild(process.execPath, ["-e", "process.stderr.write('do not print this'); process.exit(2)" ]), e => e.code === "KEYWORD_PREP_CHILD_FAILED" && !e.message.includes("do not print this"));
});
test("only exact same-PID SQLite warning on exit zero is accepted; real stderr and mixed errors remain rejected", async () => {
  const text = pid => `(node:${pid}) ExperimentalWarning: SQLite is an experimental feature and might change at any time\n(Use \`node --trace-warnings ...\` to show where the warning was created)\n`;
  assert.deepEqual(prep.stderrPolicy(Buffer.from(text(4321)), 4321), { stderrAccepted: true, knownSqliteExperimentalWarnings: 1 });
  assert.equal(prep.stderrPolicy(Buffer.from(text(4321)), 9999).stderrAccepted, false);
  assert.equal(prep.stderrPolicy(Buffer.from(text(4321) + "Error: actual failure\n"), 4321).stderrAccepted, false);
  assert.equal(prep.stderrPolicy(Buffer.from("ExperimentalWarning: Something else\n"), 4321).stderrAccepted, false);
  const warning = await prep.runChild(process.execPath, ["-e", "process.stderr.write('(node:'+process.pid+') ExperimentalWarning: SQLite is an experimental feature and might change at any time\\n'); process.stdout.write('{}')"]);
  assert.equal(prep.childStderrSafe(warning), true); assert.equal(warning.knownSqliteExperimentalWarnings, 1);
  const actualSqliteImport = await prep.runChild(process.execPath, ["-e", "require('node:sqlite'); process.stdout.write('{}')"]);
  assert.equal(prep.childStderrSafe(actualSqliteImport), true); assert.equal(actualSqliteImport.exitCode, 0);
  const mixed = await prep.runChild(process.execPath, ["-e", "process.stderr.write('(node:'+process.pid+') ExperimentalWarning: SQLite is an experimental feature and might change at any time\\nError: failed\\n'); process.stdout.write('{}')"]);
  assert.equal(prep.childStderrSafe(mixed), false);
  await assert.rejects(prep.runChild(process.execPath, ["-e", "process.stderr.write('(node:'+process.pid+') ExperimentalWarning: SQLite is an experimental feature and might change at any time\\n'); process.exit(2)"]), { code: "KEYWORD_PREP_CHILD_FAILED" });
});
