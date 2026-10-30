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
  async function execute(executable, values, childOptions) {
    calls.push({ executable, values });
    if (executable === python) {
      assert.equal(values.includes("--local-stdio-parent"), false); assert.equal(childOptions.receiptOnly, true);
      if (options.failNormalization) return { exitCode: 1, stderrBytes: 0, stdout: { state: "failed" }, pid: 4321 };
      const keyword = valueOf(values, "--keyword"), month = valueOf(values, "--month"), cutoffDate = valueOf(values, "--cutoff"), output = valueOf(values, "--output"), proofFile = valueOf(values, "--proof");
      await fs.mkdir(output);
      const src = source(keyword, keyword !== options.notObserved);
      if (options.previousFutureRanks) { src.observations = src.observations.filter(r => !r.stayDate.startsWith("2026-09")); src.rankObservations = Array.from({ length: 40 }, (_, i) => ({ companyId: "c", runId: "r1", keyword, rank: 3, collectedAt: `2026-10-05T01:${String(i).padStart(2, "0")}:00.000Z` })); }
      const bytes = Buffer.from(JSON.stringify(src)), sourceFile = path.join(output, "source.json"); await fs.writeFile(sourceFile, bytes, { flag: "wx" });
      const proof = { mode: "seccomp", noNewPrivs: true, seccompMode: 2, networkFdsClosed: true, nonStandardFdsClosedBeforeExec: true, nonStandardFdsRemainingBeforeExec: 0, expectedRoot: copy, preflightOnly: false, environmentSanitizedForExec: true, unrestrictedFallbackAllowed: false, providerCalls: 0, guardSha256: guardSha, nodeSha256: nodeSha, pid: 4321,
        kernelProbe: { tcpSocketDenied: true, udpSocketDenied: true, ipv6SocketDenied: true, syscallsDeniedWithEperm: Object.fromEntries(["socket", "socketpair", "connect", "sendto", "sendmsg"].map(k => [k, true])) } }; await json(proofFile, proof);
      const current = { type: "keyword", targetId: keyword, month, cutoffDate }, requests = [previousMonthlyReportRequest(current), current];
      const records = requests.map(request => ({ request, scopedCounts: { observations: src.observations.filter(r => r.stayDate.startsWith(request.month)).length, rankObservations: src.rankObservations.length, savedProductRecoveries: 0 }, sameSourceFinancialAndDiagnosticParity: true, snapshotFingerprint: prep.fingerprint(prep.snapshotCore(buildMonthlyReportSnapshot(request, sourceForKeywordMonthlyRequest(src, request), CAPTURE))) }));
      if (options.tamperParity) records[1].snapshotFingerprint = "0".repeat(64);
      if (options.recordMutation === "duplicate") records[0] = { ...records[1] };
      if (options.recordMutation === "month") records[0].request = { ...records[0].request, month: "2026-08" };
      if (options.recordMutation === "keyword") records[0].request = { ...records[0].request, targetId: "다른글램핑" };
      const complete = { state: "complete", currentRequest: current, captureManifestSha256: captureSha, sourceInventorySha256: capture.sourceInventorySha256, dataThrough: CAPTURE, snapshotCapturedAt: CAPTURE, copiedAt: CAPTURE,
        captureMode: capture.captureMode, observationIndexMode: "exact_application_streaming_fallback", sourceFile, sourceSha256: sha(bytes), sourceBytes: bytes.length, sourceWrites: 0, operatingMutations: 0, appEntryExecutions: 0, providerFactories: 0,
        guardMetrics: { ...ZERO_GUARD, ...(options.denial ? { outsideReadAttempts: 1 } : {}) }, sourceMetrics: { deniedRequires: 0 }, scratch: { ...SCRATCH }, copyInputsBefore: { preserved: true }, immutableCopyInputsAfter: { preserved: true }, originalOutputVerification: OUTPUT_VERIFY,
        isolation: { proofSha256: sha(await fs.readFile(proofFile)), pid: 4321, tcpKernelDenied: true, udpKernelDenied: true }, records, counts: Object.fromEntries(["companies", "runs", "observations", "rankObservations", "savedProductRecoveries"].map(k => [k, src[k].length])) };
      await json(path.join(output, "reconstruction-complete.json"), complete); await json(path.join(output, "provenance.json"), { inputSha256: sha(bytes), inputBytes: bytes.length, copiedAt: CAPTURE, observationScope: "normalized_multirun", normalizationCutoffs: Object.fromEntries(requests.map(r => [r.month, r.cutoffDate])) });
      return { exitCode: 0, stderrBytes: null, pid: 4321, stdout: null, receiptOnly: true };
    }
    if (values.includes("--verify-child")) {
      const p = values.slice(values.indexOf("--verify-child") + 1), result = await prep.verifyProjection({ projection: p[0], completeFile: p[1], output: p[2], now: p[3], keyword: p[4], month: p[5], cutoffDate: p[6] });
      return { exitCode: 0, stderrBytes: 0, stdout: result };
    }
    const result = await builder.run(values.slice(2)); if (options.changeSourceAfterBuild) await fs.appendFile(valueOf(values, "--source"), " ");
    if (options.dropTargetDescriptor) { const file = path.join(result.projectionDir, "index.json"), index = JSON.parse(await fs.readFile(file)); for (const item of index.keywords) { for (const key of ["stayMonths", "inventoryStayMonths", "rankMonths"]) item[key] = item[key].filter(month => month !== "2026-10"); item.scopes = item.scopes.filter(scope => scope.month !== "2026-10"); } await fs.writeFile(file, JSON.stringify(index)); result.indexSha256 = sha(await fs.readFile(file)); result.scopeCount = index.keywords.reduce((n, item) => n + item.scopes.length, 0); }
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
test("forty future rank rows in a previous record are empty only after exact source replay and zero eligible evidence proof", async t => {
  const f = await fixture(t, { previousFutureRanks: true, candidates: [{ keyword: "가평글램핑", month: "2026-10" }] }), result = await prep.run(f.argv, f.deps);
  assert.equal(result.preparedCount, 1); const part = path.dirname(result.prepared[0].directory), verification = JSON.parse(await fs.readFile(path.join(part, "factory-verification.json"))), complete = JSON.parse(await fs.readFile(path.join(part, "reconstruction-complete.json")));
  const previous = complete.records.find(r => r.request.month === "2026-09"); assert.equal(previous.scopedCounts.rankObservations, 40); assert.equal(verification.checks.length, 1); assert.equal(verification.checks[0].month, "2026-10");
  assert.equal(verification.emptyProofs.length, 1); const proof = verification.emptyProofs[0]; assert.equal(proof.month, "2026-09"); assert.equal(proof.exact, true); assert.equal(proof.actualFingerprint, previous.snapshotFingerprint); assert.ok(Object.values(proof.counts).every(value => value === 0));
});
test("absent-record replay refuses changed source SHA and source path outside its complete receipt directory", async t => {
  const f = await fixture(t), sourceFile = path.join(f.ops, "source.json"); await json(sourceFile, source("가평글램핑"));
  const complete = { sourceFile, sourceSha256: "0".repeat(64), sourceBytes: (await fs.stat(sourceFile)).size, snapshotCapturedAt: CAPTURE }, request = { type: "keyword", targetId: "가평글램핑", month: "2026-09", cutoffDate: "2026-09-30" };
  await assert.rejects(prep.verifyAbsentRecords(path.join(f.ops, "complete.json"), complete, [{ request }]), { code: "KEYWORD_PREP_SOURCE_BINDING" });
  await assert.rejects(prep.verifyAbsentRecords(path.join(f.copy, "complete.json"), complete, [{ request }]), { code: "KEYWORD_PREP_SOURCE_BINDING" });
});
test("restoring only guard company order must reproduce the unchanged entire original core fingerprint", () => {
  const core = { summary: { lodging: { estimatedRevenue: 100 }, dayuse: { sold: null } }, daily: [{ date: "2026-10-01", value: 1 }],
    companies: [{ companyId: "a", summary: { lodging: { sold: 1 } }, daily: [{ date: "2026-10-01", sold: 1 }] }, { companyId: "b", summary: { lodging: { sold: 2 } }, daily: [{ date: "2026-10-01", sold: 2 }] }],
    selectedDigest: "a".repeat(64), partialEvidence: [{ companyId: "a", knownPartialRevenue: 10 }], ranks: { rows: [{ companyId: "a", firstRank: 2 }] }, quality: { companyCount: 2, warnings: ["unchanged"] } };
  const record = { snapshotFingerprint: prep.fingerprint(core), companyOrderIds: ["a", "b"] }, originalBytes = JSON.stringify(core), exact = prep.verifyCoreFingerprint(core, record);
  assert.equal(exact.rawExact, true); assert.equal(exact.orderRestored, false); assert.equal(exact.restoredFingerprint, record.snapshotFingerprint);
  const reordered = structuredClone(core); reordered.companies.reverse(); const before = JSON.stringify(reordered), restored = prep.verifyCoreFingerprint(reordered, record);
  assert.equal(restored.rawExact, false); assert.equal(restored.orderRestored, true); assert.equal(restored.comparisonBasis, "original_snapshot_core_after_restoring_company_order");
  assert.notEqual(restored.rawActualFingerprint, record.snapshotFingerprint); assert.equal(restored.restoredFingerprint, record.snapshotFingerprint); assert.equal(restored.expectedFingerprint, record.snapshotFingerprint);
  assert.equal(JSON.stringify(reordered), before); assert.equal(JSON.stringify(core), originalBytes);
  const changes = [c => { c.companies[0].summary.lodging.sold++; }, c => { c.companies[0].daily[0].sold++; }, c => { c.summary.lodging.estimatedRevenue++; }, c => { c.daily[0].value++; }, c => { c.selectedDigest = "b".repeat(64); }, c => { c.partialEvidence[0].knownPartialRevenue++; }, c => { c.ranks.rows[0].firstRank++; }, c => { c.quality.warnings.push("changed"); }, c => { c.companies[0].companyId = c.companies[1].companyId; }, c => { c.companies.pop(); }, c => { c.companies[0].companyId = "foreign"; }];
  for (const change of changes) { const changed = structuredClone(reordered); change(changed); assert.throws(() => prep.verifyCoreFingerprint(changed, record), { code: "KEYWORD_PREP_FINANCIAL_PARITY_FAILED" }); }
  assert.throws(() => prep.verifyCoreFingerprint(reordered, { ...record, companyOrderIds: ["a", "a"] }), { code: "KEYWORD_PREP_FINANCIAL_PARITY_FAILED" });
  assert.throws(() => prep.verifyCoreFingerprint(reordered, { snapshotFingerprint: record.snapshotFingerprint }), { code: "KEYWORD_PREP_FINANCIAL_PARITY_FAILED" });
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
test("failed child exposes only one namespaced JSON diagnostic code and preserves failure artifacts", async t => {
  assert.equal(prep.childFailureDiagnostic(Buffer.from('{"code":"ISOLATION_SOCKET_FD_INHERITED","message":"never return this"}\n')), "ISOLATION_SOCKET_FD_INHERITED");
  assert.equal(prep.childFailureDiagnostic(Buffer.from('{"code":"SECRET_VALUE"}\n')), null);
  assert.equal(prep.childFailureDiagnostic(Buffer.from('{"code":"ISOLATION_ONE"}\n{"code":"KEYWORD_TWO"}\n')), null);
  await assert.rejects(prep.runChild(process.execPath, ["-e", "process.stderr.write(JSON.stringify({status:'blocked',code:'ISOLATION_SOCKET_FD_INHERITED',message:'do not return this'}));process.exit(2)"]), e => e.code === "KEYWORD_PREP_CHILD_FAILED" && e.childCode === "ISOLATION_SOCKET_FD_INHERITED" && !e.message.includes("do not return this"));
  const f = await fixture(t); f.deps.runChild = async (exe, argv) => { const output = valueOf(argv, "--output"); await fs.mkdir(output); await json(path.join(output, "reconstruction-failed.json"), { state: "failed", code: "KEYWORD_RECONSTRUCT_SIDE_EFFECT_ATTEMPTED" }); throw Object.assign(Error("arbitrary private original text"), { code: "KEYWORD_PREP_CHILD_FAILED", exitCode: 2 }); };
  await assert.rejects(prep.run(f.argv, f.deps), e => e.code === "KEYWORD_PREP_CHILD_FAILED" && e.childCode === "KEYWORD_RECONSTRUCT_SIDE_EFFECT_ATTEMPTED" && !e.message.includes("private"));
  const failed = JSON.parse(await fs.readFile(path.join(f.preparedRoot, "preparation-failed.json"))); assert.equal(failed.childCode, "KEYWORD_RECONSTRUCT_SIDE_EFFECT_ATTEMPTED"); assert.equal(failed.childExitCode, 2); assert.equal(failed.partialNewArtifactsRetained, true); assert.equal(failed.noSuccessPlan, true);
});
test("coordinator requires original strict no-network/no-inherited-fd proof and rejects an IPC relaxation", () => {
  const copy = path.resolve("fixture-copy"), input = { "guard-sha": "a".repeat(64), "node-sha": "b".repeat(64) }, proof = { mode: "seccomp", noNewPrivs: true, seccompMode: 2, networkFdsClosed: true, expectedRoot: copy,
    preflightOnly: false, environmentSanitizedForExec: true, unrestrictedFallbackAllowed: false, providerCalls: 0, guardSha256: input["guard-sha"], nodeSha256: input["node-sha"], pid: 4321, nonStandardFdsClosedBeforeExec: true, nonStandardFdsRemainingBeforeExec: 0,
    kernelProbe: { tcpSocketDenied: true, udpSocketDenied: true, ipv6SocketDenied: true, syscallsDeniedWithEperm: Object.fromEntries(["socket", "socketpair", "connect", "sendto", "sendmsg"].map(k => [k, true])) } };
  prep.isolation(proof, copy, input);
  for (const change of [p => { p.networkFdsClosed = false; }, p => { p.nonStandardFdsClosedBeforeExec = false; }, p => { p.nonStandardFdsRemainingBeforeExec = 1; }, p => { p.stdioLocalIPC = { mode: "verified_parent_unix_socketpair" }; }, p => { p.kernelProbe.tcpSocketDenied = false; }]) { const invalid = structuredClone(proof); change(invalid); assert.throws(() => prep.isolation(invalid, copy, input), { code: "KEYWORD_PREP_ISOLATION_GATE" }); }
});
test("normalizer receiptOnly child ignores stdout/stderr and binds a fresh real receipt to actual child PID", async t => {
  const f = await fixture(t), receipt = path.join(f.ops, "actual-child-receipt.json");
  const result = await prep.runChild(process.execPath, ["-e", "require('node:fs').writeFileSync(process.argv[1],JSON.stringify({state:'complete',pid:process.pid}),{flag:'wx'});process.stdout.write('not JSON');process.stderr.write('not a protocol');", receipt], { receiptOnly: true });
  assert.equal(result.receiptOnly, true); assert.equal(result.stdout, null); assert.equal(result.stderrBytes, null); const value = JSON.parse(await fs.readFile(receipt)); assert.equal(value.pid, result.pid); assert.equal(value.state, "complete");
  await assert.rejects(prep.runChild(process.execPath, ["-e", "process.exit(2)"], { receiptOnly: true }), e => e.code === "KEYWORD_PREP_CHILD_FAILED" && e.childCode === null);
  assert.equal(await prep.normalizerFailureCode(path.join(f.copy, "not-created"), f.copy), null);
  const empty = await fixture(t); empty.deps.runChild = async () => ({ exitCode: 0, pid: 4321, stdout: null, stderrBytes: null, receiptOnly: true });
  await assert.rejects(prep.run(empty.argv, empty.deps), { code: "ENOENT" }); await assert.rejects(fs.stat(path.join(empty.preparedRoot, "bundle-plan.json")), { code: "ENOENT" });
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
