"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs/promises"), os = require("node:os"), path = require("node:path"), crypto = require("node:crypto");
const H = require("./lib/keyword_monthly_refresh_preparation.cjs");
const R = require("./refresh_keyword_monthly_from_completed_run.cjs");
const B = require("./lib/keyword_monthly_bundle.cjs");
const { buildKeywordMonthlyProjection } = require("./lib/keyword_monthly_analysis.cjs");
const NOW = "2026-10-30T00:00:00.000Z", KEYWORD = "경남글램핑", OTHER = "가평글램핑", SHA = "a".repeat(64);
async function json(file, value) { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, JSON.stringify(value)); }
function source(keyword, octoberSold = 1, repeat = false) {
  const runs = [], observations = [];
  for (const month of ["2026-09", "2026-10", "2026-11"]) {
    const collectedAt = (month === "2026-09" ? "2026-09-20" : "2026-10-20") + "T00:00:00.000Z", runId = "saved_" + keyword + "_" + month, sold = month === "2026-10" ? octoberSold : 1;
    runs.push({ id: runId, keyword, collectedAt, collectionQuality: { status: "complete" } });
    observations.push({ observationId: runId, companyId: "cmp_place_1", runId, keyword, productType: "lodging", stayDate: month + "-20", collectedAt,
      inventoryEvidenceVersion: 4, supply: 5, sold, publicBookings: sold, phoneBookings: 0, publicRevenue: sold * 100, phoneRevenue: 0, estimatedRevenue: sold * 100,
      explicitBlockedBookings: 0, sharedDayUseExcluded: 0, phoneMissingPriceBookings: 0, partial: false, missing: false, dayUsePresence: "absent", dayUseSharingStatus: "not_shared", capacityBasis: { count: 5, source: "db_correction" } });
  }
  return { companies: [{ companyId: "cmp_place_1", primaryName: "공개 업체", capacity: 5, capacitySource: "db_correction" }], runs, observations: repeat ? [...observations, ...structuredClone(observations)] : observations,
    rankObservations: [], savedProductRecoveries: [], warnings: [], sourceDiagnostics: {} };
}
function manifest() { return { keyword: KEYWORD, checkIn: "2026-10-20", checkOut: "2026-10-21", bookingRangeDays: 1, collectedAt: "2026-10-20T00:00:00.000Z", collectionQuality: { status: "complete" },
  naverAttemptedQueries: [{ status: 200 }], counts: { naverOverall: 1, naverBookingStockChecked: 1, naverBookingStockSucceeded: 1, naverOtaObservationChecked: 0, naverOtaBlocked: 0, naverOtaFailed: 0 } }; }
async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "keyword-refresh-test-")); t.after(async () => { assert.ok(path.basename(root).startsWith("keyword-refresh-test-") && path.dirname(root) === path.resolve(os.tmpdir())); await fs.rm(root, { recursive: true, force: true }); });
  const dataDir = path.join(root, "data"), scratchParent = path.join(root, "scratch"), codeRoot = path.resolve(__dirname, "..");
  await fs.mkdir(dataDir); await fs.mkdir(scratchParent);
  const initialA = path.join(root, "initial-a"), initialB = path.join(root, "initial-b"), liveDir = path.join(dataDir, "keyword_monthly_analysis");
  await buildKeywordMonthlyProjection({ source: source(KEYWORD), sourceFingerprint: SHA, outputDir: initialA, materializedAt: NOW, dataThrough: NOW, now: () => NOW });
  await buildKeywordMonthlyProjection({ source: source(OTHER, 4), sourceFingerprint: "b".repeat(64), outputDir: initialB, materializedAt: NOW, dataThrough: NOW, now: () => NOW });
  await B.publishKeywordMonthlyBundle({ inputs: [{ directory: initialA }, { directory: initialB }], outputDir: liveDir, now: NOW });
  const manifestFile = path.join(dataDir, "outputs", "saved_run_1", "manifest.json"); await json(manifestFile, manifest());
  const evidence = { runId: "saved_run_1", keyword: KEYWORD, manifestSha256: H.hash(await fs.readFile(manifestFile)), scheduleOccurrenceId: null, status: "complete", quality: "complete", postprocessStatus: "complete", finishedAt: "2026-10-20T00:01:00.000Z" };
  let prepareCalls = 0;
  const injectedPrepare = async ({ jobDir, admission }) => {
    prepareCalls++; await admission();
    const directory = path.join(jobDir, "prepared-projection"), src = source(KEYWORD, 2, options.repeatSource === true);
    await buildKeywordMonthlyProjection({ source: src, sourceFingerprint: H.hash(JSON.stringify(src)), outputDir: directory, materializedAt: NOW, dataThrough: NOW, now: () => NOW });
    const inputs = ["2026-10", "2026-11"].map(month => ({ directory, exposeScopes: [{ keyword: KEYWORD, month }] })), planFile = path.join(jobDir, "prepared-plan.json"); await json(planFile, { schemaVersion: 1, inputs });
    if (options.mutateManifest) await fs.appendFile(manifestFile, " ");
    return { inputs, capturedAt: NOW, prepDate: NOW, captureSha256: "c".repeat(64), sourceInventorySha256: "d".repeat(64), planFile, planSha256: H.hash(await fs.readFile(planFile)), scopeProofDigest: "e".repeat(64), preparedCount: 2,
      sourceWrites: 0, providerCalls: 0, strictIsolationVerified: true, parts: [{ keyword: KEYWORD, month: "2026-10", fixtureOnly: true }] };
  };
  const call = { dataDir, scratchParent, codeRoot, evidence, mode: options.mode || "stage", now: () => NOW, canPublish: async () => true };
  return { root, dataDir, scratchParent, codeRoot, evidence, manifestFile, liveDir, call, deps: { fixture: true, prepare: injectedPrepare }, prepareCalls: () => prepareCalls };
}
async function readValue(directory, keyword, month) {
  const service = B.createKeywordMonthlyBundleAnalysis({ projectionDir: directory, now: () => NOW }), options = await service.options(), row = options.keywords.find(k => k.keyword === keyword);
  return service.analyze({ keyword, month, cutoffDate: row.defaultCutoffs[month] });
}
test("recorded 21-day range crosses the month boundary; checkOut is not the whole collection window", () => {
  const m = { ...manifest(), checkIn: "2026-10-30", checkOut: "2026-10-31", bookingRangeDays: 21 }, e = { keyword: KEYWORD, finishedAt: NOW };
  const r = H.rangeFromManifest(m, e); assert.equal(r.firstStayDate, "2026-10-30"); assert.equal(r.lastStayDate, "2026-11-19"); assert.deepEqual(r.stayMonths, ["2026-10", "2026-11"]);
  assert.throws(() => H.rangeFromManifest({ ...m, bookingRangeDays: undefined }, e), { code: "KEYWORD_MONTHLY_REFRESH_RECORDED_STAY_RANGE_REQUIRED" });
  assert.throws(() => H.rangeFromManifest(m, { ...e, stayEndDate: "2026-10-31" }), { code: "KEYWORD_MONTHLY_REFRESH_MANIFEST_SCOPE_MISMATCH" });
});
test("scope plan adds collection-month evidence and only an existing immediate successor comparison", () => {
  const range = { stayMonths: ["2026-11"], collectionMonth: "2026-10" }, catalog = { scopes: [{ keyword: KEYWORD, month: "2026-12" }, { keyword: OTHER, month: "2027-01" }] };
  const candidates = ["2026-09", "2026-10", "2026-11", "2026-12"].map(month => ({ keyword: KEYWORD, month }));
  const selected = H.selectCandidates({ candidates }, KEYWORD, range, catalog);
  assert.deepEqual(selected.candidates.map(r => r.month), ["2026-10", "2026-11", "2026-12"]); assert.deepEqual(selected.successorMonths, ["2026-12"]);
  assert.throws(() => H.selectCandidates({ candidates: candidates.slice(0, 2) }, KEYWORD, range, catalog), { code: "KEYWORD_MONTHLY_REFRESH_AFFECTED_SCOPE_NOT_DISCOVERED" });
});
test("completion evidence never accepts partial, reused, unknown DB status or unsafe IDs", () => {
  const base = { runId: "valid_1", keyword: KEYWORD, manifestSha256: SHA, status: "complete", quality: "complete", postprocessStatus: "complete", finishedAt: NOW };
  assert.equal(H.sourceKey(base).length, 64);
  for (const change of [{ status: "reused" }, { quality: "partial" }, { postprocessStatus: "running" }, { runId: "../source" }, { keyword: "x\nsecret" }, { finishedAt: null }]) assert.throws(() => H.validateEvidence({ ...base, ...change }), /COMPLETION_EVIDENCE_REQUIRED/);
});
test("isolated stage publishes complete replacement scopes and leaves the live pointer and all other scopes unchanged", async t => {
  const f = await fixture(t), oldPointer = await fs.readFile(path.join(f.liveDir, "current.json")), before = await B.loadBundle(f.liveDir), originalManifest = await fs.readFile(f.manifestFile);
  const r = await R.refreshKeywordMonthlyFromCompletedRun(f.call, f.deps);
  assert.equal(r.status, "staged"); assert.equal(r.operatingPointerChanged, false); assert.equal(r.affectedScopeCount, 2); assert.equal(r.unchangedScopeCount, 4); assert.equal(r.unchangedScopePartitionBindingsPreserved, true);
  assert.deepEqual(await fs.readFile(path.join(f.liveDir, "current.json")), oldPointer); assert.deepEqual(await fs.readFile(f.manifestFile), originalManifest);
  assert.equal((await readValue(r.stagingBundleDir, KEYWORD, "2026-10")).snapshot.summary.lodging.sold, 2);
  assert.equal((await readValue(r.stagingBundleDir, KEYWORD, "2026-09")).snapshot.summary.lodging.sold, 1);
  assert.equal((await readValue(r.stagingBundleDir, OTHER, "2026-10")).snapshot.summary.lodging.sold, 4);
  const staged = await B.loadBundle(r.stagingBundleDir); for (const scope of before.catalog.scopes.filter(s => s.keyword === OTHER || s.month === "2026-09")) assert.equal(staged.catalog.scopes.find(s => H.scopeId(s) === H.scopeId(scope)).partition, scope.partition);
  await assert.rejects(fs.access(path.join(f.liveDir, "refresh-receipts")), { code: "ENOENT" });
});
test("an explicitly live fixture updates only matching scopes and deduplicates repeated run/manifest signals", async t => {
  const f = await fixture(t, { mode: "live", repeatSource: true }), initial = await B.loadBundle(f.liveDir), first = await R.refreshKeywordMonthlyFromCompletedRun(f.call, f.deps), pointer = await fs.readFile(path.join(f.liveDir, "current.json"));
  assert.equal(first.status, "published"); assert.notEqual(first.generation, initial.pointer.generation); assert.equal(first.generatedBy, "keyword_monthly_completed_run_refresh"); assert.equal(first.refreshVersion, H.VERSION);
  assert.equal((await readValue(f.liveDir, KEYWORD, "2026-10")).snapshot.summary.lodging.sold, 2, "duplicate input observations do not double the monthly quantity");
  const repeated = await R.refreshKeywordMonthlyFromCompletedRun(f.call, f.deps); assert.equal(repeated.repeatedSource, true); assert.equal(repeated.generation, first.generation); assert.equal(f.prepareCalls(), 1); assert.deepEqual(await fs.readFile(path.join(f.liveDir, "current.json")), pointer);
  await fs.access(path.join(f.liveDir, "generations", initial.pointer.generation, "catalog.json"));
});
test("manifest change, denied admission and aborted work do not promote a live pointer", async t => {
  const f = await fixture(t, { mode: "live", mutateManifest: true }), pointer = await fs.readFile(path.join(f.liveDir, "current.json"));
  await assert.rejects(R.refreshKeywordMonthlyFromCompletedRun(f.call, f.deps), { code: "KEYWORD_MONTHLY_REFRESH_MANIFEST_NOT_COMPLETE" }); assert.deepEqual(await fs.readFile(path.join(f.liveDir, "current.json")), pointer);
  const blocked = await fixture(t, { mode: "live" }), original = await fs.readFile(path.join(blocked.liveDir, "current.json"));
  await assert.rejects(R.refreshKeywordMonthlyFromCompletedRun({ ...blocked.call, canPublish: async () => false }, blocked.deps), { code: "KEYWORD_MONTHLY_REFRESH_DEFERRED", deferred: true }); assert.equal(blocked.prepareCalls(), 0);
  const controller = new AbortController(); controller.abort(); await assert.rejects(R.refreshKeywordMonthlyFromCompletedRun({ ...blocked.call, signal: controller.signal }, blocked.deps), { code: "KEYWORD_MONTHLY_REFRESH_ABORTED" });
  assert.deepEqual(await fs.readFile(path.join(blocked.liveDir, "current.json")), original);
});
test("a crash after acknowledged pointer promotion is recovered only by exact intended catalog and saved readback", async t => {
  const f = await fixture(t, { mode: "live" }); let calls = 0;
  const deps = { ...f.deps, publish: async input => { calls++; await B.publishKeywordMonthlyBundle(input); throw Object.assign(Error("simulated crash"), { code: "KEYWORD_MONTHLY_BUNDLE_PUBLICATION_NEEDS_READBACK", publicationState: "pointer_was_promoted_verify_current" }); } };
  await assert.rejects(R.refreshKeywordMonthlyFromCompletedRun(f.call, deps), { code: "KEYWORD_MONTHLY_REFRESH_PUBLICATION_NEEDS_READBACK" });
  const p = await fs.readFile(path.join(f.liveDir, "current.json")), recovered = await R.refreshKeywordMonthlyFromCompletedRun(f.call, f.deps);
  assert.equal(recovered.recoveredAfterPromotion, true); assert.equal(recovered.status, "published"); assert.match(recovered.publicationReceiptSha256, /^[a-f0-9]{64}$/); assert.equal(f.prepareCalls(), 1); assert.equal(calls, 1); assert.deepEqual(await fs.readFile(path.join(f.liveDir, "current.json")), p);
});
test("mid-work admission deferral persists compact evidence and removes only this job's owned work for a clean retry", async t => {
  const f = await fixture(t, { mode: "live" }), initial = await B.loadBundle(f.liveDir); let admissions = 0;
  await assert.rejects(R.refreshKeywordMonthlyFromCompletedRun({ ...f.call, canPublish: async () => ++admissions < 4 }, f.deps), { code: "KEYWORD_MONTHLY_REFRESH_DEFERRED", deferred: true });
  assert.equal((await B.loadBundle(f.liveDir)).pointerRead.sha256, initial.pointerRead.sha256);
  const ops = path.join(f.dataDir, "operations", "monthly-keyword-production-20261030"), remains = await fs.readdir(ops);
  assert.ok(!remains.some(name => name.startsWith("refresh-job-")), "own job was removed after a durable deferral receipt");
  const receipts = await fs.readdir(path.join(f.liveDir, "refresh-receipts")); assert.equal(receipts.filter(n => n.startsWith("deferred-") && !n.startsWith("deferred-cleanup-")).length, 1); assert.equal(receipts.filter(n => n.startsWith("deferred-cleanup-")).length, 1); assert.ok(!receipts.some(n => n.startsWith("intent-")));
  const result = await R.refreshKeywordMonthlyFromCompletedRun(f.call, f.deps); assert.equal(result.status, "published"); assert.equal(f.prepareCalls(), 2);
});
test("a promoted catalog without its exact publication receipt is a readback hold, never a reconstructed success", async t => {
  const f = await fixture(t, { mode: "live" });
  const deps = { ...f.deps, publish: async input => { const r = await B.publishKeywordMonthlyBundle(input); await fs.unlink(path.join(f.liveDir, "generations", r.generation, "publication-receipt.json")); return r; } };
  await assert.rejects(R.refreshKeywordMonthlyFromCompletedRun(f.call, deps), { code: "KEYWORD_MONTHLY_REFRESH_PUBLICATION_NEEDS_READBACK" });
  await assert.rejects(R.refreshKeywordMonthlyFromCompletedRun(f.call, f.deps), { code: "KEYWORD_MONTHLY_REFRESH_PUBLICATION_NEEDS_READBACK" }); assert.equal(f.prepareCalls(), 1);
});
test("an uncertain intent whose catalog is not active stops for readback rather than repeating a publication", async t => {
  const f = await fixture(t, { mode: "live" }), before = await B.loadBundle(f.liveDir), dir = path.join(f.liveDir, "refresh-receipts"); await fs.mkdir(dir, { mode: 0o700 });
  const token = crypto.randomUUID(), key = H.sourceKey(f.evidence); await H.writeNew(path.join(dir, "intent-" + key + ".json"), { sourceKey: key, runId: f.evidence.runId, manifestSha256: f.evidence.manifestSha256, mode: "live", generatedBy: "keyword_monthly_completed_run_refresh", refreshVersion: H.VERSION, ownerToken: token, jobId: token, expectedCatalogSha256: "f".repeat(64), previousPointerSha256: before.pointerRead.sha256, scopes: [{ keyword: KEYWORD, month: "2026-10" }] });
  await assert.rejects(R.refreshKeywordMonthlyFromCompletedRun(f.call, f.deps), { code: "KEYWORD_MONTHLY_REFRESH_PRIOR_INTENT_REQUIRES_READBACK" }); assert.equal(f.prepareCalls(), 0); assert.equal((await B.loadBundle(f.liveDir)).pointerRead.sha256, before.pointerRead.sha256);
});
test("foreign preparation directories and caller-supplied output paths are never followed or deleted", async t => {
  const f = await fixture(t, { mode: "live" }), foreign = path.join(f.scratchParent, "keyword-monthly-source-foreign-owner"); await fs.mkdir(foreign); await fs.writeFile(path.join(foreign, "keep"), "untouched");
  await assert.rejects(R.refreshKeywordMonthlyFromCompletedRun(f.call, f.deps), { code: "KEYWORD_MONTHLY_REFRESH_OTHER_PREPARATION_PRESENT" }); assert.equal(await fs.readFile(path.join(foreign, "keep"), "utf8"), "untouched");
  await assert.rejects(R.refreshKeywordMonthlyFromCompletedRun({ ...f.call, outputDir: f.dataDir }, f.deps), { code: "KEYWORD_MONTHLY_REFRESH_OPTIONS_INVALID" });
  await assert.rejects(R.refreshKeywordMonthlyFromCompletedRun({ ...f.call, fixture: true }, f.deps), { code: "KEYWORD_MONTHLY_REFRESH_OPTIONS_INVALID" });
});
test("hardlinks, symlink parents, and unknown cleanup ownership fail closed", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "keyword-refresh-paths-")); t.after(async () => { assert.ok(path.basename(root).startsWith("keyword-refresh-paths-")); await fs.rm(root, { recursive: true, force: true }); });
  const original = path.join(root, "original.json"), link = path.join(root, "linked.json"); await json(original, { keep: true }); await fs.link(original, link); await assert.rejects(H.read(link), { code: "KEYWORD_MONTHLY_REFRESH_PATH_UNSAFE" }); await fs.unlink(link);
  const token = crypto.randomUUID(), owned = path.join(root, "refresh-job-" + token); await fs.mkdir(owned, { mode: 0o700 }); await H.writeNew(path.join(owned, "refresh-owner.json"), { token, sourceKey: SHA, root: owned });
  await assert.rejects(R.removeOwnedTree(owned, path.join(owned, "refresh-owner.json"), "wrong", SHA), { code: "KEYWORD_MONTHLY_REFRESH_CLEANUP_OWNERSHIP" }); await fs.access(owned);
  const junction = path.join(owned, "escape"); await fs.symlink(root, junction, process.platform === "win32" ? "junction" : "dir"); await assert.rejects(R.removeOwnedTree(owned, path.join(owned, "refresh-owner.json"), token, SHA), /UNSAFE_PATH|PATH_UNSAFE/); await fs.unlink(junction); assert.equal(await fs.readFile(original, "utf8"), '{"keep":true}');
});
test("the production preparation retains the original strict sandbox, pins and parity gates", async () => {
  const source = await fs.readFile(path.join(__dirname, "refresh_keyword_monthly_from_completed_run.cjs"), "utf8");
  for (const required of ["prep.isolation", "prep.validateDiscovery", "normalized.pid === proof.value.pid", "receiptOnly: true", "prep.run(argv", "completed.notObservedCount === 0", "capture.copy", "beforePromote", "sourceInventorySha256", "expectedCurrentSha256", "H.LIMITS.generationBytes"]) assert.ok(source.includes(required), required);
  assert.equal(H.LIMITS.scratchBytes, 1024 ** 3); assert.equal(H.LIMITS.operationsBytes, 1024 ** 3); assert.equal(H.LIMITS.bundleNamespaceBytes, 1024 ** 3); assert.equal(H.LIMITS.generationBytes, 128 * 1024 ** 2);
  assert.ok(!source.includes('require("./glamping_app_server.cjs")') && !source.includes('require("./lib/kosis.cjs")') && !source.includes("fetch("));
  assert.ok(source.includes("await copyInDedicatedProcess(") && !source.includes("await capture.copy("), "process-global copy guards stay outside the live app process");
});
test("a bare CLI does not exit successfully without a trusted completion/admission adapter", () => {
  const result = require("node:child_process").spawnSync(process.execPath, [path.join(__dirname, "refresh_keyword_monthly_from_completed_run.cjs")], { encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 1); assert.equal(result.stdout, ""); assert.deepEqual(JSON.parse(result.stderr), { code: "KEYWORD_MONTHLY_REFRESH_EXPLICIT_ADAPTER_REQUIRED" });
});
test("actual tiny core capture runs in a disposable child and never patches or blocks unrelated parent filesystem writes", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "keyword-refresh-copy-child-")); t.after(async () => { assert.ok(path.basename(root).startsWith("keyword-refresh-copy-child-")); await fs.rm(root, { recursive: true, force: true }); });
  const sourceDataDir = path.join(root, "data"); await json(path.join(sourceDataDir, "company_master/companies.json"), { companies: {} });
  await fs.mkdir(path.join(sourceDataDir, "history")); await fs.writeFile(path.join(sourceDataDir, "history/observations.jsonl"), "{}\n"); await fs.mkdir(path.join(sourceDataDir, "outputs"));
  const capture = require("./lib/keyword_monthly_source_copy.cjs"), prep = require("./prepare_keyword_monthly_release.cjs"), inspection = await capture.inspect({ sourceDataDir, scratchParent: root, includePrepared: false }), inspectionFile = path.join(root, "inspection.json"); await json(inspectionFile, inspection);
  const copyRoot = path.join(root, "keyword-monthly-source-12345678-child"), originalOpen = fs.open, originalWrite = fs.writeFile, nativeWrite = require("node:fs").writeFile; let childCalled = 0;
  const result = await R.copyInDedicatedProcess({ codeRoot: path.resolve(__dirname, ".."), nodePath: await fs.realpath(process.execPath), sourceDataDir, scratchParent: root, copyRoot, inspectionFile,
    execute: async (...args) => { childCalled++; const pending = prep.runChild(...args); assert.equal(fs.open, originalOpen); assert.equal(fs.writeFile, originalWrite); assert.equal(require("node:fs").writeFile, nativeWrite); await fs.writeFile(path.join(root, "unrelated-parent-write"), "unblocked"); return pending; } });
  assert.equal(result.state, "complete"); assert.equal(childCalled, 1); assert.equal(result.sourceWrites, 0); assert.equal(await fs.readFile(path.join(root, "unrelated-parent-write"), "utf8"), "unblocked");
  const receipt = JSON.parse(await fs.readFile(path.join(copyRoot, "control/capture-complete.json"))); for (const row of receipt.inputFiles) await fs.chmod(path.join(copyRoot, "data", ...row.relative.split("/")), 0o600);
  assert.equal(fs.open, originalOpen); assert.equal(fs.writeFile, originalWrite); assert.equal(require("node:fs").writeFile, nativeWrite);
});
