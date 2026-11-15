"use strict";
// Transaction tests use an explicitly injected fixture-only child. They do not
// claim kernel isolation or production publication; the bundle publisher and
// public saved-analysis reader are the real implementations on synthetic data.
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs/promises"), path = require("node:path"), os = require("node:os"), zlib = require("node:zlib");
const H = require("./lib/keyword_monthly_refresh_preparation.cjs"), B = require("./lib/keyword_monthly_bundle.cjs");
const R = require("./refresh_keyword_monthly_incremental.cjs"), { createStore } = require("./lib/keyword_monthly_incremental_state.cjs");
const { createKeywordMonthlySourceDelta } = require("./lib/keyword_monthly_source_delta.cjs"), { events } = require("./lib/keyword_monthly_incremental_context.cjs");
const { metadataInventory, seedDependencies } = require("./lib/keyword_monthly_incremental_inputs.cjs");
const { buildKeywordMonthlyProjection } = require("./lib/keyword_monthly_analysis.cjs");
const NOW = "2026-11-15T00:00:00.000Z", A = "fixture-keyword-a", OTHER = "fixture-keyword-b";
async function json(file, value) { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, JSON.stringify(value)); }
function source(keyword, sold = 1) {
  const runs = [], observations = [];
  for (const month of ["2026-10", "2026-11"]) {
    const collectedAt = `${month}-14T00:00:00.000Z`, runId = `${keyword}_${month}`;
    runs.push({ id: runId, keyword, collectedAt, collectionQuality: { status: "complete" } });
    observations.push({ companyId: "cmp_1", runId, keyword, productType: "lodging", stayDate: month + "-20", collectedAt,
      inventoryEvidenceVersion: 4, supply: 5, sold, publicBookings: sold, phoneBookings: 0,
      publicRevenue: sold * 100, phoneRevenue: 0, estimatedRevenue: sold * 100 });
  }
  return { companies: [{ companyId: "cmp_1", primaryName: "Synthetic fixture", capacity: 5 }], runs, observations,
    rankObservations: [], savedProductRecoveries: [], warnings: [], sourceDiagnostics: {} };
}
async function fixture(t, variant = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "keyword-incremental-transaction-"));
  t.after(async () => { assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); await fs.rm(root, { recursive: true, force: true }); });
  const dataDir = path.join(root, "data"), codeRoot = path.resolve(__dirname, ".."), liveDir = path.join(dataDir, "keyword_monthly_analysis");
  await fs.mkdir(dataDir);
  await json(path.join(dataDir, "company_master/companies.json"), { companies: { cmp_1: { companyId: "cmp_1", primaryName: "Synthetic fixture", keywords: {}, inventory: {} } } });
  await fs.mkdir(path.join(dataDir, "history")); await fs.writeFile(path.join(dataDir, "history/observations.jsonl"), "");
  const manifestFile = path.join(dataDir, "outputs/run_new/manifest.json");
  await json(manifestFile, { keyword: A, checkIn: "2026-11-20", checkOut: "2026-11-21", bookingRangeDays: 1,
    collectedAt: "2026-11-14T00:00:00.000Z", collectionQuality: { status: "complete" }, naverAttemptedQueries: [{ status: 200 }],
    counts: { naverOverall: 1, naverBookingStockChecked: 1, naverBookingStockSucceeded: 1, naverOtaObservationChecked: 0, naverOtaBlocked: 0, naverOtaFailed: 0 } });
  const evidence = { runId: "run_new", keyword: A, manifestSha256: H.hash(await fs.readFile(manifestFile)), scheduleOccurrenceId: null,
    status: "complete", quality: "complete", postprocessStatus: "complete", finishedAt: "2026-11-14T00:01:00.000Z" };
  const initialA = path.join(root, "initial-a"), initialB = path.join(root, "initial-b");
  await buildKeywordMonthlyProjection({ source: source(A), sourceFingerprint: "a".repeat(64), outputDir: initialA, materializedAt: NOW, dataThrough: NOW });
  await buildKeywordMonthlyProjection({ source: source(OTHER, 4), sourceFingerprint: "b".repeat(64), outputDir: initialB, materializedAt: NOW, dataThrough: NOW, publishMonths: ["2026-11"] });
  await B.publishKeywordMonthlyBundle({ inputs: [{ directory: initialA }, { directory: initialB }], outputDir: liveDir, now: NOW });
  const store = createStore({ dataDir, now: () => NOW }), lockFile = path.join(store.directory, "worker-lock.json");
  let executions = 0, publications = 0, lastJob = null, lastChildOptions = null;
  const execute = async (_command, args, childOptions) => {
    assert.equal(childOptions.receiptOnly, true, "the strict launcher must inherit /dev/null stdio rather than Node socket pairs");
    lastChildOptions = childOptions;
    executions++; const flag = name => args[args.indexOf(name) + 1], jobRoot = flag("--job-root"), proofFile = flag("--proof");
    const job = JSON.parse(await fs.readFile(flag("--input"))), outbox = createKeywordMonthlySourceDelta({ dataDir }), inventory = await events(outbox); lastJob = job;
    await store.initialize(); let current = await store.load();
    if (!current) current = await store.bootstrap({ eventIds: inventory.descriptors.map(item => item.eventId) });
    const workDataDir = path.join(jobRoot, "data"); await fs.mkdir(workDataDir);
    const before = await metadataInventory({ dataDir }), seeded = await seedDependencies({ dataDir, workDataDir });
    const directory = path.join(jobRoot, "fixture-projection"), updated = source(A, 2);
    await buildKeywordMonthlyProjection({ source: updated, sourceFingerprint: H.hash(JSON.stringify(updated)), outputDir: directory,
      materializedAt: NOW, dataThrough: NOW, publishMonths: ["2026-11"] });
    const pid = process.pid + 100, proof = { mode: "seccomp", fixtureOnly: true, noNewPrivs: true, seccompMode: 2,
      networkFdsClosed: true, expectedRoot: jobRoot, preflightOnly: false, environmentSanitizedForExec: true, unrestrictedFallbackAllowed: false, providerCalls: 0,
      guardSha256: variant.wrongGuardPin ? "0".repeat(64) : flag("--guard-sha256"), nodeSha256: variant.wrongNodePin ? "0".repeat(64) : flag("--node-sha256"), pid: variant.wrongProofPid ? pid + 1 : pid,
      kernelProbe: { tcpSocketDenied: true, udpSocketDenied: true, ipv6SocketDenied: true,
        syscallsDeniedWithEperm: Object.fromEntries(["socket", "socketpair", "connect", "sendto", "sendmsg"].map(name => [name, true])) },
      nonStandardFdsClosedBeforeExec: true, nonStandardFdsRemainingBeforeExec: 0 };
    if (!variant.missingProof) await json(proofFile, proof);
    const scopes = [{ keyword: A, month: "2026-11", cutoffDate: "2026-11-15" }];
    const prepared = { schemaVersion: 1, version: R.VERSION, status: "complete", fixtureOnly: true, executionBasis: R.BASIS,
      capturedAt: variant.wrongCapturedAt ? "2026-11-14T00:00:00.000Z" : NOW, bootstrap: true, stateSha256: current.stateSha256, statePointerSha256: current.pointerSha256,
      inputsFingerprint: "c".repeat(64), outboxInventorySha256: inventory.inventory,
      inputs: [{ directory, exposeScopes: [{ keyword: A, month: "2026-11" }] }], parts: scopes, plan: { scopes }, metrics: { fixtureOnly: true },
      isolation: { pid: variant.wrongPreparedPid ? pid + 1 : pid, proofSha256: variant.wrongProofSha ? "0".repeat(64) : H.hash(Buffer.from(JSON.stringify(proof))) },
      sourceMetadata: before, staticDependencies: seeded, providerCalls: 0, sourceWrites: 0, appEntryExecutions: 0, kosisReadOrChanged: false };
    const bytes = Buffer.from(JSON.stringify(prepared));
    if (!variant.missingPreparation) await fs.writeFile(path.join(jobRoot, "preparation-complete.json"), bytes);
    if (variant.mutateSource) await fs.appendFile(path.join(dataDir, "history/observations.jsonl"), "{}\n");
    return { exitCode: 0, stderrBytes: variant.pipedProtocol ? 0 : null, pid, receiptOnly: !variant.pipedProtocol,
      stdout: variant.pipedProtocol || variant.unexpectedStdout ? { status: "complete", isolationVerified: true, resultSha256: H.hash(bytes) } : null };
  };
  const deps = { fixture: true, execute, publish: async input => { publications++; return B.publishKeywordMonthlyBundle(input); } };
  const call = { dataDir, codeRoot, evidence, mode: "live", now: () => NOW, canPublish: async () => true,
    readDeltaEvidence: async runId => ({ ...evidence, runId }) };
  return { root, dataDir, codeRoot, liveDir, manifestFile, evidence, call, deps, store, lockFile,
    executions: () => executions, publications: () => publications, lastJob: () => lastJob, lastChildOptions: () => lastChildOptions,
    pointer: () => fs.readFile(path.join(liveDir, "current.json")) };
}
async function absent(file) { await assert.rejects(fs.access(file), { code: "ENOENT" }); }
async function value(f, keyword, month) {
  const service = B.createKeywordMonthlyBundleAnalysis({ projectionDir: f.liveDir, now: () => NOW }), options = await service.options();
  return service.analyze({ keyword, month, cutoffDate: options.keywords.find(item => item.keyword === keyword).defaultCutoffs[month] });
}

test("busy preflight creates no namespace, receipt or lock", async t => {
  const f = await fixture(t), pointer = await f.pointer();
  await assert.rejects(R.refreshKeywordMonthlyIncremental({ ...f.call, canPublish: async () => false }, f.deps), { code: "KEYWORD_INCREMENTAL_DEFERRED", deferred: true });
  assert.equal(f.executions(), 0); await absent(f.store.directory); await absent(path.join(f.liveDir, "refresh-receipts"));
  assert.deepEqual(await f.pointer(), pointer);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(R.refreshKeywordMonthlyIncremental({ ...f.call, signal: controller.signal }, f.deps), { code: "KEYWORD_INCREMENTAL_DEFERRED", deferred: true });
  await absent(f.store.directory); await absent(path.join(f.liveDir, "refresh-receipts"));
});

test("unknown existing worker lock is preserved and blocks child execution", async t => {
  const f = await fixture(t); await f.store.initialize(); await fs.writeFile(f.lockFile, "foreign-lock-preserve");
  const pointer = await f.pointer();
  await assert.rejects(R.refreshKeywordMonthlyIncremental(f.call, f.deps), { code: "KEYWORD_INCREMENTAL_WORKER_LOCKED" });
  assert.equal(f.executions(), 0); assert.equal(await fs.readFile(f.lockFile, "utf8"), "foreign-lock-preserve");
  assert.deepEqual(await f.pointer(), pointer);
});

test("new history events wait for exact durable DB evidence and reject failed evidence", async t => {
  for (const status of ["waiting", "failed"]) await t.test(status, async st => {
    const f = await fixture(st), outbox = createKeywordMonthlySourceDelta({ dataDir: f.dataDir });
    assert.equal((await outbox.recordHistoryDelta({ runId: "run_new", rows: [{ companyId: "cmp_1", runId: "run_new" }],
      sourceStamp: { before: null, after: null }, indexUpdated: true })).status, "complete");
    const pointer = await f.pointer();
    await assert.rejects(R.refreshKeywordMonthlyIncremental({ ...f.call, readDeltaEvidence: async () => ({ ...f.evidence, status }) }, f.deps),
      { code: status === "waiting" ? "KEYWORD_INCREMENTAL_DELTA_DB_PENDING" : "KEYWORD_INCREMENTAL_DELTA_DB_NOT_VERIFIED" });
    assert.equal(f.executions(), 0); await absent(f.lockFile); assert.deepEqual(await f.pointer(), pointer);
  });
});

async function secondaryDelta(f) {
  const file = path.join(f.dataDir, "outputs/run_secondary/manifest.json"); await json(file, JSON.parse(await fs.readFile(f.manifestFile, "utf8")));
  const evidence = { ...f.evidence, runId: "run_secondary", manifestSha256: H.hash(await fs.readFile(file)) }, outbox = createKeywordMonthlySourceDelta({ dataDir: f.dataDir });
  assert.equal((await outbox.recordHistoryDelta({ runId: evidence.runId, rows: [{ companyId: "cmp_1", runId: evidence.runId }],
    sourceStamp: { before: null, after: null }, indexUpdated: true })).status, "complete");
  return { file, evidence };
}

test("a second delta manifest changed after DB admission is rejected even when the child captures its new metadata", async t => {
  const f = await fixture(t), secondary = await secondaryDelta(f), pointer = await f.pointer();
  let evidenceReads = 0;
  const call = { ...f.call, readDeltaEvidence: async runId => {
    assert.equal(runId, secondary.evidence.runId); evidenceReads++;
    return { ...secondary.evidence, manifestSha256: H.hash(await fs.readFile(secondary.file)) };
  } };
  const deps = { ...f.deps, execute: async (...args) => {
    await fs.appendFile(secondary.file, " "); // Happens before the fixture child freezes output metadata.
    return f.deps.execute(...args);
  } };
  await assert.rejects(R.refreshKeywordMonthlyIncremental(call, deps), { code: "KEYWORD_INCREMENTAL_DELTA_DB_CHANGED" });
  assert.deepEqual(f.lastJob().admittedEvidence, [secondary.evidence]);
  assert.equal(evidenceReads, 2); assert.equal(f.publications(), 0); assert.deepEqual(await f.pointer(), pointer); await absent(f.lockFile);
});

test("a second delta DB completion tuple is rechecked again at the final before-promote boundary", async t => {
  const f = await fixture(t), secondary = await secondaryDelta(f), pointer = await f.pointer();
  let changed = false, evidenceReads = 0;
  const call = { ...f.call, readDeltaEvidence: async runId => {
    assert.equal(runId, secondary.evidence.runId); evidenceReads++;
    return { ...secondary.evidence, ...(changed ? { finishedAt: "2026-11-14T00:02:00.000Z" } : {}) };
  } };
  const deps = { ...f.deps, publish: async input => { changed = true; return B.publishKeywordMonthlyBundle(input); } };
  await assert.rejects(R.refreshKeywordMonthlyIncremental(call, deps), { code: "KEYWORD_INCREMENTAL_DELTA_DB_CHANGED" });
  assert.equal(evidenceReads, 3); assert.deepEqual(await f.pointer(), pointer); await absent(f.lockFile);
  await absent(path.join(f.liveDir, "refresh-receipts", "intent-" + R.keyFor(f.evidence) + ".json"));
});

test("successful fixture transaction preserves untouched public bindings and repeat is a historical no-op", async t => {
  const f = await fixture(t), before = await B.loadBundle(f.liveDir), result = await R.refreshKeywordMonthlyIncremental(f.call, f.deps);
  assert.equal(result.status, "published"); assert.equal(result.fixtureOnly, true); assert.equal(result.refreshedScopeCount, 1);
  assert.equal(f.lastChildOptions().receiptOnly, true);
  assert.equal(result.unchangedScopeCount, 2); assert.equal(result.strictIsolationVerified, true);
  assert.equal((await value(f, A, "2026-11")).snapshot.summary.lodging.sold, 2);
  assert.equal((await value(f, A, "2026-10")).snapshot.summary.lodging.sold, 1);
  assert.equal((await value(f, OTHER, "2026-11")).snapshot.summary.lodging.sold, 4);
  const after = await B.loadBundle(f.liveDir);
  for (const scope of before.catalog.scopes.filter(scope => scope.keyword !== A || scope.month !== "2026-11"))
    assert.equal(after.catalog.scopes.find(current => H.scopeId(current) === H.scopeId(scope)).partition, scope.partition);
  assert.match(result.publicationReceiptSha256, /^[a-f0-9]{64}$/); assert.match(result.preparationEvidenceSha256, /^[a-f0-9]{64}$/);
  const pointer = await f.pointer(), repeated = await R.refreshKeywordMonthlyIncremental(f.call, f.deps);
  assert.equal(repeated.repeatedSource, true); assert.equal(repeated.operatingPointerChanged, false);
  assert.equal(f.executions(), 1); assert.equal(f.publications(), 1); assert.deepEqual(await f.pointer(), pointer); await absent(f.lockFile);
});

test("source change before promote leaves the prior public pointer intact", async t => {
  const f = await fixture(t, { mutateSource: true }), pointer = await f.pointer();
  await assert.rejects(R.refreshKeywordMonthlyIncremental(f.call, f.deps), { code: "KEYWORD_INCREMENTAL_INPUTS_CHANGED" });
  assert.equal(f.publications(), 0); assert.deepEqual(await f.pointer(), pointer); await absent(f.lockFile);
});

test("the final before-promote gate catches a source change after preparation validation", async t => {
  const f = await fixture(t), pointer = await f.pointer();
  const deps = { ...f.deps, publish: async input => {
    await fs.appendFile(path.join(f.dataDir, "history/observations.jsonl"), "{}\n");
    return B.publishKeywordMonthlyBundle(input);
  } };
  await assert.rejects(R.refreshKeywordMonthlyIncremental(f.call, deps), { code: "KEYWORD_INCREMENTAL_INPUTS_CHANGED" });
  assert.deepEqual(await f.pointer(), pointer); await absent(f.lockFile);
  await absent(path.join(f.liveDir, "refresh-receipts", "intent-" + R.keyFor(f.evidence) + ".json"));
});

test("an old completion receipt cannot replace a subsequently published current generation", async t => {
  const f = await fixture(t), completed = await R.refreshKeywordMonthlyIncremental(f.call, f.deps);
  const current = await B.loadBundle(f.liveDir), directory = path.join(f.root, "subsequent-publication"), src = source(OTHER, 5);
  await buildKeywordMonthlyProjection({ source: src, sourceFingerprint: H.hash(JSON.stringify(src)), outputDir: directory,
    materializedAt: NOW, dataThrough: NOW, publishMonths: ["2026-11"] });
  const inputs = H.mergeInputs(current, [{ directory, exposeScopes: [{ keyword: OTHER, month: "2026-11" }] }]);
  const newer = await B.publishKeywordMonthlyBundle({ inputs, outputDir: f.liveDir, now: NOW, expectedCurrentSha256: current.pointerRead.sha256 });
  assert.notEqual(newer.generation, completed.generation); const pointer = await f.pointer();
  const repeated = await R.refreshKeywordMonthlyIncremental(f.call, f.deps);
  assert.equal(repeated.repeatedSource, true); assert.equal(repeated.operatingPointerChanged, false);
  assert.equal(repeated.generation, completed.generation, "the old receipt remains historical evidence");
  assert.deepEqual(await f.pointer(), pointer); assert.equal(f.executions(), 1);
  assert.equal((await value(f, OTHER, "2026-11")).snapshot.summary.lodging.sold, 5);
});

test("a crash after real pointer promotion recovers by exact catalog readback without double calculation", async t => {
  const f = await fixture(t), deps = { ...f.deps, publish: async input => {
    await B.publishKeywordMonthlyBundle(input); throw Object.assign(new Error("fixture crash after promotion"), { code: "KEYWORD_MONTHLY_BUNDLE_PUBLICATION_NEEDS_READBACK" });
  } };
  await assert.rejects(R.refreshKeywordMonthlyIncremental(f.call, deps), { code: "KEYWORD_INCREMENTAL_PUBLICATION_NEEDS_READBACK" });
  const pointer = await f.pointer(); await absent(f.lockFile);
  const recovered = await R.refreshKeywordMonthlyIncremental(f.call, f.deps);
  assert.equal(recovered.recoveredAfterPromotion, true); assert.equal(recovered.fixtureOnly, true);
  assert.equal(recovered.operatingPointerChanged, false); assert.equal(f.executions(), 1);
  assert.deepEqual(await f.pointer(), pointer); await absent(f.lockFile);
});

for (const variant of ["tamperedCompressedEvidence", "wrongRawEvidenceHash", "missingHistoricalCheckpoint"]) test(`recovery holds on ${variant} without recalculation or another promotion`, async t => {
  const f = await fixture(t); let publishCalls = 0;
  const deps = { ...f.deps, publish: async input => {
    publishCalls++; await B.publishKeywordMonthlyBundle(input);
    throw Object.assign(new Error("fixture crash after promotion"), { code: "KEYWORD_MONTHLY_BUNDLE_PUBLICATION_NEEDS_READBACK" });
  } };
  await assert.rejects(R.refreshKeywordMonthlyIncremental(f.call, deps), { code: "KEYWORD_INCREMENTAL_PUBLICATION_NEEDS_READBACK" });
  const receiptDir = path.join(f.liveDir, "refresh-receipts"), intentFile = path.join(receiptDir, "intent-" + R.keyFor(f.evidence) + ".json"),
    intent = JSON.parse(await fs.readFile(intentFile)), pointer = await f.pointer();
  if (variant === "tamperedCompressedEvidence") await fs.appendFile(intent.preparationEvidenceFile, Buffer.from([0]));
  else if (variant === "wrongRawEvidenceHash") {
    const original = zlib.gunzipSync(await fs.readFile(intent.preparationEvidenceFile)), changed = Buffer.concat([original, Buffer.from(" ")]), stored = zlib.gzipSync(changed);
    await fs.writeFile(intent.preparationEvidenceFile, stored);
    intent.preparationEvidenceSha256 = H.hash(stored); await json(intentFile, intent);
  } else {
    const file = path.join(f.store.directory, "states", intent.stateSha256 + ".json.gz"); await fs.rename(file, file + ".preserved");
  }
  await assert.rejects(R.refreshKeywordMonthlyIncremental(f.call, deps), { code: "KEYWORD_INCREMENTAL_PUBLICATION_NEEDS_READBACK" });
  assert.equal(f.executions(), 1); assert.equal(publishCalls, 1); assert.deepEqual(await f.pointer(), pointer); await absent(f.lockFile);
  await absent(path.join(receiptDir, "complete-" + R.keyFor(f.evidence) + ".json"));
});

for (const variant of ["pipedProtocol", "unexpectedStdout", "missingPreparation", "wrongCapturedAt", "wrongPreparedPid", "missingProof", "wrongProofPid", "wrongProofSha", "wrongGuardPin", "wrongNodePin"]) test(`${variant} never promotes`, async t => {
  const f = await fixture(t, { [variant]: true }), pointer = await f.pointer();
  await assert.rejects(R.refreshKeywordMonthlyIncremental(f.call, f.deps));
  assert.equal(f.executions(), 1, "the proof/result gate is reached before this rejection");
  assert.equal(f.publications(), 0); assert.deepEqual(await f.pointer(), pointer); await absent(f.lockFile);
});

test("a malformed historical completion receipt is not accepted as a published checkpoint", async t => {
  const f = await fixture(t), directory = path.join(f.liveDir, "refresh-receipts"); await fs.mkdir(directory);
  await json(path.join(directory, "complete-" + R.keyFor(f.evidence) + ".json"), { generatedBy: R.OWNER, refreshVersion: R.VERSION,
    sourceKey: R.keyFor(f.evidence), runId: f.evidence.runId, manifestSha256: f.evidence.manifestSha256,
    status: "published", stateSha256: "d".repeat(64), incrementalValidated: true });
  await assert.rejects(R.refreshKeywordMonthlyIncremental(f.call, f.deps), { code: "KEYWORD_INCREMENTAL_COMPLETE_INVALID" });
  assert.equal(f.executions(), 0);
});
