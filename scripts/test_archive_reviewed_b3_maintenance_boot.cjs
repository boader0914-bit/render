"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs/promises"), path = require("node:path"), os = require("node:os"), crypto = require("node:crypto"), zlib = require("node:zlib"), { EventEmitter } = require("node:events"), A = require("./lib/archive-reviewed-b3-maintenance-boot.cjs");
const OP = "ea380222-d4db-46f4-a924-bc20bee7bdc6", RELEASE = "identity-auto-release-20261116-0e7fbd45-dbee-446c-817a-caebdd01b3ae", sha = bytes => crypto.createHash("sha256").update(bytes).digest("hex"), current = { bootId: "fixture_current_not_printed", hostId: "fixture_host_not_printed" }, old = { bootId: "fixture_old_not_printed" };
const run = A.retireReviewedB3MaintenanceAtBoot;
async function fixture(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "archive-b3-fixture-")), codeRoot = path.join(dataDir, "code"), root = path.join(dataDir, "keyword_monthly_incremental"), release = path.join(dataDir, "operations", RELEASE), publicDir = path.join(dataDir, "keyword_monthly_analysis");
  for (const directory of [root, release, publicDir, codeRoot]) await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  t.after(async () => { assert.equal(path.dirname(path.resolve(dataDir)), path.resolve(os.tmpdir())); assert.ok(path.basename(dataDir).startsWith("archive-b3-fixture-")); await fs.rm(dataDir, { recursive: true, force: true }); });
  const marker = { schemaVersion: 1, kind: "keyword_prepared_conversion_maintenance", token: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", pid: 1798, createdAt: "2026-11-16T04:46:19.629Z", operationId: OP, mode: "stage", contextSha256: sha(JSON.stringify(old)) }, markerBytes = Buffer.from(JSON.stringify(marker)); assert.equal(markerBytes.length, 316);
  const stateBytes = Buffer.from(JSON.stringify({ fixtureDerivedState: true })), state = sha(stateBytes), compressed = zlib.gzipSync(stateBytes);
  const markerFile = path.join(root, "prepared-conversion-lock.json"), requestBytes = Buffer.from(JSON.stringify({ operationId: OP, dataDir, codeRoot: path.join(release, "code") })), runnerBytes = Buffer.from("fixture runner"), publicBytes = Buffer.from(JSON.stringify({ generation: "a".repeat(32) })), sourceBytes = Buffer.from(JSON.stringify({ schemaVersion: 1, compression: "gzip", stateSha256: state, storageSha256: sha(compressed), storageBytes: compressed.length, rawBytes: stateBytes.length }));
  await fs.writeFile(markerFile, markerBytes, { mode: 0o600 }); await fs.writeFile(path.join(release, "b3-request-stage.json"), requestBytes); await fs.writeFile(path.join(release, "rebuild-reviewed-monthly-publish-v4.cjs"), runnerBytes); await fs.writeFile(path.join(publicDir, "current.json"), publicBytes); await fs.writeFile(path.join(root, "source-current.json"), sourceBytes);
  await fs.mkdir(path.join(root, "states"), { mode: 0o700 }); await fs.writeFile(path.join(root, "states", state + ".json.gz"), compressed, { mode: 0o600 });
  const python = path.join(dataDir, "fixture-python"), pythonBytes = Buffer.from("fixture binary never executed"); await fs.writeFile(python, pythonBytes);
  const pins = { ...A.PINS, marker: sha(markerBytes), request: sha(requestBytes), runner: sha(runnerBytes), publicPointer: sha(publicBytes), sourcePointer: sha(sourceBytes), state };
  const opDir = path.join(dataDir, "operations/keyword-identity-prepared-20261116", OP), operationInventory = await A.preChildOperationInventory({ directory: opDir, requestSha256: pins.request, fixture: true });
  const receipt = { schemaVersion: 2, kind: "reviewed_b3_old_instance_retirement", reviewedByOperator: true, reviewedAt: "2026-11-16T06:00:00.000Z", serviceId: "srv-da9q6don74is738t7id0", operationId: OP, markerSha256: pins.marker, markerPid: 1798, markerCreatedAt: marker.createdAt, markerMode: "stage", oldContextSha256: marker.contextSha256, witness: { deploymentId: "dep-witness", commit: "b".repeat(40), contextSha256: sha(JSON.stringify(current)), observedAt: "2026-11-16T05:30:00.000Z", observationReceiptSha256: "a".repeat(64) }, execution: { deploymentId: "dep-fixture", commit: "c".repeat(40) }, operatorReviewedWitnessToRecoveryHandoff: true, providerStopBeforeNewContractSha256: "f".repeat(64), oldRetiredNoLaterThan: "2026-11-16T05:29:00.000Z", providerSingleRuntimePersistentDisk: true, oldStoppedBeforeNew: true, actualNewRuntimeMountedDisk: true, sourceObservationReceiptSha256: "7".repeat(64), providerEvidenceSha256: "8".repeat(64), requestSha256: pins.request, runnerSha256: pins.runner, publicPointerSha256: pins.publicPointer, sourcePointerSha256: pins.sourcePointer, stateSha256: state, preChildOperationInventorySha256: operationInventory.sha256, pythonExecutable: { path: python, sha256: sha(pythonBytes) } };
  const shimFile = path.join(codeRoot, "scripts/lib/fixture-boot-shim.cjs"), shimBytes = Buffer.from("fixture shim never executed"); await fs.mkdir(path.dirname(shimFile), { recursive: true }); await fs.writeFile(shimFile, shimBytes);
  const policy = { schemaVersion: 2, kind: "reviewed-code-policy-next-single-runtime", reviewedBy: "codex_root_operator", reviewedAt: receipt.reviewedAt, serviceId: receipt.serviceId, operationId: OP, marker: { sha256: pins.marker, bytes: 316, pid: marker.pid, createdAt: marker.createdAt, mode: marker.mode, oldContextBinding: "exact_reviewed_marker_sha256" }, fixedPins: { requestSha256: pins.request, requestBindingSha256: "2f4670ecebd619f0439e694737b863cfad95491f20aa82a965ba0b6f1cee2efb", runnerSha256: pins.runner, publicPointerSha256: pins.publicPointer, sourcePointerSha256: pins.sourcePointer, stateSha256: state }, witness: receipt.witness, retirement: { oldRetiredNoLaterThan: receipt.oldRetiredNoLaterThan, providerStopBeforeNewContractSha256: receipt.providerStopBeforeNewContractSha256, providerEvidenceSha256: receipt.providerEvidenceSha256, sourceObservationReceiptSha256: receipt.sourceObservationReceiptSha256, providerSingleRuntimePersistentDisk: true, oldStoppedBeforeNew: true, actualNewRuntimeMountedDisk: true }, preChildPolicy: "exact_frozen_pre_child_whitelist_v1", preChildInventoryPreobserved: false, executionPolicy: "next_single_runtime_approved_code_then_verified_archive_only", codePins: { retirementModuleSha256: sha(await fs.readFile(require.resolve("./lib/archive-reviewed-b3-maintenance-boot.cjs"))), contextModuleSha256: "65bcb1bdae162eda918327e4b31340fb329d7d3600dcc8e1157096ceab81da2b", renameHelperSha256: A.PINS.renameHelper, bootShim: { path: shimFile, sha256: sha(shimBytes) } }, pythonExecutable: { path: python, trustPolicy: "canonical_root_owned_system_python311" } };
  const receiptPath = path.join(release, "reviewed-retirement.json"), setReceipt = async value => { const bytes = Buffer.from(JSON.stringify(value)); await fs.writeFile(receiptPath, bytes, { mode: 0o600 }); return sha(bytes); }, receiptSha256 = await setReceipt(policy);
  const rawStat = await fs.lstat(markerFile, { bigint: true }), expectedStat = Object.fromEntries(["ino", "size", "mtimeNs", "ctimeNs", "nlink", "mode", "uid", "gid"].map(key => [key, String(rawStat[key])]));
  let renames = 0; const dependencies = { fixture: true, pins, expectedStat, contextReader: async () => current, renameNoReplace: async ({ input, source, destination }) => { renames++; assert.equal(input.sourceSha256, pins.marker); try { await fs.lstat(destination); assert.fail("fixture no-replace destination exists"); } catch (error) { if (error.code !== "ENOENT") throw error; } await fs.rename(source, destination); } };
  const options = { dataDir, codeRoot, policyPath: receiptPath, policySha256: receiptSha256, actualCommitRuntimeAudit: { source: "git_metadata", available: false, commit: null } }, archiveDir = path.join(root, "maintenance-retirements", OP), archiveFile = path.join(archiveDir, "retired-original.json"), jobDir = path.join(root, "jobs", "refresh-job-" + OP);
  return { options, dependencies, marker, markerFile, markerBytes, pins, receipt: policy, setReceipt, archiveDir, archiveFile, root, opDir, jobDir, renames: () => renames };
}
test("exact reviewed retired B3 marker is archived unchanged with durable completion, and replay is held", async t => {
  const f = await fixture(t), value = await run(f.options, f.dependencies); assert.equal(value.status, "archived"); assert.equal(value.oldMarkerArchived, true); assert.equal(value.actionReplayAuthorized, false); assert.equal(f.renames(), 1);
  assert.deepEqual(await fs.readFile(f.archiveFile), f.markerBytes); await assert.rejects(fs.lstat(f.markerFile), { code: "ENOENT" }); const completed = JSON.parse(await fs.readFile(path.join(f.archiveDir, "archive-complete.json"), "utf8")); assert.equal(completed.status, "archived"); assert.equal(completed.sourceWrites, 0);
  for (const secret of [f.marker.token, ...Object.values(current)]) assert.equal(JSON.stringify(value).includes(secret), false);
  assert.equal((await run(f.options, f.dependencies)).status, "already_retired"); assert.equal(f.renames(), 1);
});
test("old context equal and missing provider review cannot archive", async t => {
  const f = await fixture(t); await assert.rejects(run(f.options, { ...f.dependencies, contextReader: async () => old }), { code: "B3_ARCHIVE_CONTEXT_NOT_DIFFERENT" });
  f.options.policySha256 = await f.setReceipt({ ...f.receipt, reviewedBy: "unreviewed" }); await assert.rejects(run(f.options, f.dependencies), { code: "B3_ARCHIVE_REVIEW_BINDING" }); assert.equal(f.renames(), 0); assert.deepEqual(await fs.readFile(f.markerFile), f.markerBytes);
});
test("own operation or job directories existing are a hold", async t => {
  const f = await fixture(t); await fs.mkdir(f.jobDir, { recursive: true }); await assert.rejects(run(f.options, f.dependencies), { code: "B3_ARCHIVE_EXPECTED_ABSENT" }); assert.equal(f.renames(), 0);
});
test("changed source pointer immediately before rename retains marker and records private intent only", async t => {
  const f = await fixture(t); await assert.rejects(run(f.options, { ...f.dependencies, beforeFinalCheck: async () => fs.appendFile(path.join(f.root, "source-current.json"), " ") }), { code: "B3_ARCHIVE_PRE_RENAME_CHANGED", mutationState: "intent_or_private_audit_only_marker_not_moved" }); assert.equal(f.renames(), 0); assert.deepEqual(await fs.readFile(f.markerFile), f.markerBytes);
});
test("replacement guard before final CAS is never moved or rewritten", async t => {
  const f = await fixture(t), replacement = Buffer.from(JSON.stringify({ unrelated: "fixture_new_guard" })); await assert.rejects(run(f.options, { ...f.dependencies, beforeFinalCheck: async () => fs.writeFile(f.markerFile, replacement) }), { code: "B3_ARCHIVE_PRE_RENAME_CHANGED" }); assert.equal(f.renames(), 0); assert.deepEqual(await fs.readFile(f.markerFile), replacement);
});
test("kernel no-replace refusal has no fallback and becomes readback hold", async t => {
  const f = await fixture(t); await assert.rejects(run(f.options, { ...f.dependencies, renameNoReplace: async () => { throw Object.assign(new Error("fixture"), { code: "EEXIST" }); } }), { code: "B3_ARCHIVE_NEEDS_READBACK", mutationState: "rename_attempted_uncertain" }); assert.deepEqual(await fs.readFile(f.markerFile), f.markerBytes); await assert.rejects(run(f.options, f.dependencies), { code: "B3_ARCHIVE_PRIOR_AUDIT_NEEDS_READBACK" });
});
test("post-rename completion failure preserves archive and intent, and blocks replay", async t => {
  const f = await fixture(t); await assert.rejects(run(f.options, { ...f.dependencies, beforeComplete: async () => { throw Object.assign(new Error("fixture ENOSPC"), { code: "ENOSPC" }); } }), { code: "B3_ARCHIVE_NEEDS_READBACK" }); assert.deepEqual(await fs.readFile(f.archiveFile), f.markerBytes); await fs.lstat(path.join(f.archiveDir, "archive-intent.json")); await assert.rejects(fs.lstat(f.markerFile), { code: "ENOENT" }); await assert.rejects(run(f.options, f.dependencies), { code: "B3_ARCHIVE_NEEDS_READBACK", mutationState: "guard_absent_archive_chain_unverified" });
});
test("new guard after archive is left unchanged, reported held, and never reversed", async t => {
  const f = await fixture(t), replacement = Buffer.from("new unrelated guard"); await assert.rejects(run(f.options, { ...f.dependencies, afterRename: async () => fs.writeFile(f.markerFile, replacement, { flag: "wx" }) }), { code: "B3_ARCHIVE_NEW_GUARD_PRESENT_HOLD", mutationState: "old_marker_archived_new_guard_untouched" }); assert.deepEqual(await fs.readFile(f.markerFile), replacement); assert.deepEqual(await fs.readFile(f.archiveFile), f.markerBytes); assert.equal(JSON.parse(await fs.readFile(path.join(f.archiveDir, "archive-complete.json"))).status, "archived_new_guard_present_hold");
});
test("approved code policy permits new execution context and records deployment honestly unknown", async t => {
  const f = await fixture(t), value = await run(f.options, { ...f.dependencies, contextReader: async () => ({ otherRuntime: true }) }); assert.equal(value.status, "archived"); assert.equal(value.runtimeDeploymentId, null); assert.deepEqual(value.actualCommitRuntimeAudit, { source: "git_metadata", available: false, commit: null });
});
test("verified archive after later source changes skips all first-retirement baseline/context gates", async t => {
  const f = await fixture(t); await run(f.options, f.dependencies); await fs.writeFile(path.join(f.root, "source-current.json"), "new legitimate checkpoint"); await fs.writeFile(path.join(f.options.dataDir, "keyword_monthly_analysis/current.json"), "new legitimate public bundle");
  const value = await run(f.options, { ...f.dependencies, contextReader: async () => { throw new Error("must not read context again"); } }); assert.equal(value.status, "already_retired"); assert.equal(value.baselineFreshnessRevalidated, false); assert.equal(f.renames(), 1);
});
test("different current guard is untouched and defers to normal maintenance protection", async t => {
  const f = await fixture(t), bytes = Buffer.from("different guard deliberately not JSON"); await fs.writeFile(f.markerFile, bytes); const value = await run(f.options, f.dependencies); assert.equal(value.status, "not_target"); assert.equal(value.normalMaintenanceProtectionRequired, true); assert.deepEqual(await fs.readFile(f.markerFile), bytes); assert.equal(f.renames(), 0); await assert.rejects(fs.lstat(f.archiveDir), { code: "ENOENT" });
});
test("tampered completed archive fails closed rather than authorizing a second retirement", async t => {
  const f = await fixture(t); await run(f.options, f.dependencies); await fs.writeFile(f.archiveFile, "tampered archive"); await assert.rejects(run(f.options, f.dependencies), { code: "B3_ARCHIVE_NEEDS_READBACK" }); assert.equal(f.renames(), 1);
});
test("boot module source code pin mismatch cannot create an archive intent", async t => {
  const f = await fixture(t), policy = { ...f.receipt, codePins: { ...f.receipt.codePins, retirementModuleSha256: "0".repeat(64) } }; f.options.policySha256 = await f.setReceipt(policy); await assert.rejects(run(f.options, f.dependencies), { code: "B3_ARCHIVE_CODE_POLICY_MISMATCH" }); assert.equal(f.renames(), 0);
});
test("own rename timeout waits for actual close after SIGKILL request", async () => {
  const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stdin = new EventEmitter(); child.stdin.end = () => {}; let kills = 0, settled = false; child.kill = signal => { assert.equal(signal, "SIGKILL"); kills++; };
  const result = A.kernelRename({ python: "fixture", helper: "fixture", input: {} }, { milliseconds: 5, spawn: () => child }).then(() => { settled = true; return null; }, error => { settled = true; return error; });
  await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(kills, 1); assert.equal(settled, false); child.emit("close", null); assert.equal((await result).code, "B3_ARCHIVE_RENAME_TIMEOUT");
});
test("own rename output overflow also waits for actual close", async () => {
  const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stdin = new EventEmitter(); child.stdin.end = () => {}; let kills = 0, settled = false; child.kill = () => { kills++; };
  const result = A.kernelRename({ python: "fixture", helper: "fixture", input: {} }, { milliseconds: 1000, spawn: () => child }).then(() => { settled = true; return null; }, error => { settled = true; return error; });
  child.stdout.emit("data", Buffer.alloc(4097, 0x20)); await Promise.resolve(); assert.equal(kills, 1); assert.equal(settled, false); child.emit("close", 2); assert.equal((await result).code, "B3_ARCHIVE_RENAME_OUTPUT_BOUND");
});
async function createPreChild(f) {
  await fs.mkdir(f.opDir, { recursive: true, mode: 0o700 });
  await fs.copyFile(path.join(f.options.dataDir, "operations", RELEASE, "b3-request-stage.json"), path.join(f.opDir, "request.json"));
  const binding = Buffer.from(JSON.stringify({ requestSha256: f.pins.request })); await fs.writeFile(path.join(f.opDir, "request-binding.json"), binding, { mode: 0o600 }); f.dependencies.requestBindingSha256 = sha(binding);
}
test("exact pre-child operation files and seed namespaces are metadata-only preserved", async t => {
  const f = await fixture(t); await createPreChild(f); const seeds = path.join(f.opDir, "stage-seeds"), recoveryDir = path.join(seeds, "history/saved_product_recoveries"); await fs.mkdir(recoveryDir, { recursive: true, mode: 0o700 });
  const original = Buffer.from("unparsed-original-inventory"), seed = Buffer.from("unparsed-seed"); await fs.writeFile(path.join(f.opDir, "originals.json"), original, { mode: 0o600 }); await fs.writeFile(path.join(recoveryDir, "fixture.json"), seed, { mode: 0o600 });
  const inspected = await A.preChildOperationInventory({ directory: f.opDir, requestSha256: f.pins.request, requestBindingSha256: f.dependencies.requestBindingSha256, fixture: true });
  assert.equal(inspected.entries.find(row => row.relative === "originals.json").sha256, null); assert.equal(inspected.entries.find(row => row.relative.endsWith("fixture.json")).sha256, null);
  assert.equal((await run(f.options, f.dependencies)).status, "archived"); assert.deepEqual(await fs.readFile(path.join(f.opDir, "originals.json")), original); assert.deepEqual(await fs.readFile(path.join(recoveryDir, "fixture.json")), seed);
  const intent = JSON.parse(await fs.readFile(path.join(f.archiveDir, "archive-intent.json"))); assert.equal(intent.preChildInventoryPreobserved, false); assert.equal(intent.preChildOperationInventorySha256, inspected.sha256);
});
test("unknown pre-child publish evidence or mismatched binding holds before any rename", async t => {
  const f = await fixture(t); await createPreChild(f); await fs.writeFile(path.join(f.opDir, "publish-intent.json"), "{}"); await assert.rejects(run(f.options, f.dependencies), { code: "B3_ARCHIVE_PRECHILD_UNKNOWN_PATH" }); assert.equal(f.renames(), 0);
});
test("metadata-only seed mutation before rename holds without changing the guard", async t => {
  const f = await fixture(t); await createPreChild(f); const file = path.join(f.opDir, "originals.json"); await fs.writeFile(file, "old", { mode: 0o600 });
  await assert.rejects(run(f.options, { ...f.dependencies, beforeFinalCheck: async () => fs.appendFile(file, "changed") }), { code: "B3_ARCHIVE_PRECHILD_CHANGED" }); assert.equal(f.renames(), 0); assert.deepEqual(await fs.readFile(f.markerFile), f.markerBytes);
});
test("source checkpoint compressed corruption is held before intent or rename", async t => {
  const f = await fixture(t), file = path.join(f.root, "states", f.pins.state + ".json.gz"); await fs.writeFile(file, Buffer.from("corrupt")); await assert.rejects(run(f.options, f.dependencies), { code: "B3_ARCHIVE_STATE_STORAGE_MISMATCH" }); assert.equal(f.renames(), 0); assert.deepEqual(await fs.readFile(f.markerFile), f.markerBytes);
});
test("concurrent reviewed archive helpers permit at most one rename owner", async t => {
  const f = await fixture(t), results = await Promise.allSettled([run(f.options, f.dependencies), run(f.options, f.dependencies)]);
  assert.equal(results.filter(row => row.status === "fulfilled").length, 1); assert.equal(results.filter(row => row.status === "rejected").length, 1); assert.equal(f.renames(), 1); assert.deepEqual(await fs.readFile(f.archiveFile), f.markerBytes);
});
