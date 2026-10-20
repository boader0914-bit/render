"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs/promises"), os = require("node:os"), path = require("node:path");
const { DatabaseSync } = require("node:sqlite"), { test } = require("node:test");
const { createCollectionRotationScheduler, defaultConfig, MIN_FREE_BYTES } = require("./collection_rotation_scheduler.cjs");
const clone = value => JSON.parse(JSON.stringify(value));
const readDb = (file, sql, ...args) => { const db = new DatabaseSync(file, { readOnly: true }); try { return db.prepare(sql).all(...args).map(row => ({ ...row })); } finally { db.close(); } };
const writeDb = (file, sql, ...args) => { const db = new DatabaseSync(file); try { return db.prepare(sql).run(...args); } finally { db.close(); } };
function goodProof({ expected }) {
  return { verified: true, status: "complete", runId: expected.runId, workerKey: expected.workerKey, keyword: expected.keyword, trigger: "scheduled", nonEmpty: true,
    executionStartedAt: "2026-10-16T02:00:50.000Z", finishedAt: "2026-10-16T02:05:00.000Z", conditions: clone(expected.conditions),
    collectionQuality: { status: "complete", reason: "manifest_checks_passed", counts: { naverOverall: 20, naverScheduleSucceeded: 120, naverScheduleFailed: 0, naverScheduleBlocked: 0 } },
    proof: { manifestSha256: "a".repeat(64), scheduleOccurrenceId: expected.slotId } };
}
function legacyProof(context) {
  const value = goodProof(context); delete value.proof.scheduleOccurrenceId;
  value.proof.jobId = "collector_4b834f03-a176-49c8-b00b-04bca8a5d259"; value.proof.runTokenSha256 = "b".repeat(64);
  value.proof.legacyReview = { slotId: context.expected.slotId, acceptedAt: context.expected.acceptedAt, receiptSha256: context.expected.receiptSha256,
    uniqueCandidateCount: 1, method: "administrator-reviewed-legacy-job" };
  return value;
}
async function fixture(t, overrides = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "rotation-reconcile-")); let now = new Date("2026-10-16T00:00:00.000Z"), requests = 0, inspections = 0, verifier = goodProof;
  let freeBytes = 1024 * 1024 * 1024;
  const options = { dataDir: directory, now: () => now, executeSlot: async () => { requests++; return { runId: "initial_complete", collectionQuality: { status: "complete" } }; },
    getFreeBytes: async () => freeBytes, getWorkerState: async () => ({ ready: true, active: false, halted: false }),
    verifyPersistedResult: async context => { inspections++; return verifier(context); }, ...overrides };
  const scheduler = createCollectionRotationScheduler(options);
  t.after(async () => { scheduler.close(); assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep)); await fs.rm(directory, { recursive: true, force: true }); });
  await scheduler.updateConfig({ ...defaultConfig(now), collection: { ...defaultConfig(now).collection, bookingDays: 21 } });
  await scheduler.setEnabled(true); await scheduler.tick(); await scheduler.setEnabled(false);
  const slotId = "rotation_2026-10-16_2", runId = "daegu_glamping_20261016_110050", acceptedAt = "2026-10-16T02:00:38.000Z";
  const target = readDb(scheduler.storePath, "SELECT * FROM rotation_slots WHERE id=?", slotId)[0];
  const receipt = { version: 1, id: slotId, workerKey: target.worker_key, keyword: target.keyword, day: target.day, acceptedAt };
  writeDb(scheduler.storePath, "UPDATE rotation_slots SET status='uncertain',started_at=?,finished_at=?,error_code=?,receipt_json=?,result_json=? WHERE id=?",
    acceptedAt, "2026-10-16T02:06:00.000Z", "COLLECTOR_RESULT_TIMEOUT", JSON.stringify(receipt), JSON.stringify({ status: "uncertain", errorCode: "COLLECTOR_RESULT_TIMEOUT", originalEvidence: "preserve me" }), slotId);
  now = new Date("2026-10-16T03:00:00.000Z");
  const protectionFile = path.join(directory, "collector/jobs.json"); await fs.mkdir(path.dirname(protectionFile), { recursive: true });
  await fs.writeFile(protectionFile, JSON.stringify({ halted: true, reviewHold: { reason: "retained provider protection" } }));
  const snapshot = () => ({ state: readDb(scheduler.storePath, "SELECT * FROM rotation_state"), slots: readDb(scheduler.storePath, "SELECT * FROM rotation_slots ORDER BY slot_index"),
    events: readDb(scheduler.storePath, "SELECT * FROM rotation_events ORDER BY id"), revisions: readDb(scheduler.storePath, "SELECT * FROM rotation_revisions"), days: readDb(scheduler.storePath, "SELECT * FROM rotation_days") });
  return { directory, scheduler, slotId, runId, acceptedAt, receipt, protectionFile, snapshot, options,
    get requests() { return requests; }, get inspections() { return inspections; }, setVerifier(value) { verifier = value; }, setFree(value) { freeBytes = value; },
    mutate(sql, ...args) { return writeDb(scheduler.storePath, sql, ...args); } };
}

test("explicit dry-run is read-only; apply CAS preserves original errors/events and never restarts scheduling or protection", async t => {
  const f = await fixture(t), before = f.snapshot(), protectedBytes = await fs.readFile(f.protectionFile);
  const preview = await f.scheduler.reconcileCompleted({ slotId: f.slotId, runId: f.runId });
  assert.equal(preview.dryRun, true); assert.equal(preview.applied, false); assert.match(preview.expectedVersion, /^[a-f0-9]{64}$/); assert.deepEqual(f.snapshot(), before);
  const applied = await f.scheduler.reconcileCompleted({ slotId: f.slotId, runId: f.runId, dryRun: false, expectedVersion: preview.expectedVersion });
  assert.equal(applied.applied, true); assert.equal(applied.item.status, "complete"); assert.equal(applied.item.runId, f.runId);
  assert.equal(applied.item.acceptedAt, f.acceptedAt); assert.equal(applied.item.startedAt, "2026-10-16T02:00:50.000Z"); assert.equal(applied.item.finishedAt, "2026-10-16T02:05:00.000Z");
  const after = f.snapshot(); assert.deepEqual(after.state, before.state); assert.deepEqual(after.days, before.days); assert.deepEqual(after.revisions, before.revisions);
  assert.deepEqual(after.slots.filter(row => row.id !== f.slotId), before.slots.filter(row => row.id !== f.slotId)); assert.deepEqual(after.events.slice(0, -1), before.events);
  assert.equal(after.events.at(-1).kind, "reconciled_complete");
  const audit = readDb(f.scheduler.storePath, "SELECT * FROM rotation_reconciliations")[0]; assert.deepEqual(JSON.parse(audit.previous_row_json), before.slots.find(row => row.id === f.slotId));
  assert.equal(JSON.parse(audit.proof_json).bindingMode, "persisted_execution_identity");
  assert.deepEqual(await fs.readFile(f.protectionFile), protectedBytes); assert.equal(f.requests, 1); assert.equal(f.scheduler.status().enabled, false);
  const again = await f.scheduler.reconcileCompleted({ slotId: f.slotId, runId: f.runId, dryRun: false, expectedVersion: preview.expectedVersion });
  assert.equal(again.alreadyApplied, true); assert.equal(again.applied, false); assert.equal(again.evidenceRechecked, false); assert.deepEqual(f.snapshot(), after);
  await assert.rejects(f.scheduler.reconcileCompleted({ slotId: f.slotId, runId: "another_run", dryRun: false, expectedVersion: preview.expectedVersion }), { code: "ROTATION_RECONCILE_ALREADY_DIFFERENT" });
});

test("all persisted conditions, worker, keyword, trigger, KST day, strong identity, nonempty and full completion must agree", async t => {
  const f = await fixture(t), before = f.snapshot();
  const rejected = [
    [proof => { proof.workerKey = "web"; }, "ROTATION_RECONCILE_RESULT_NOT_VERIFIED_COMPLETE"],
    [proof => { proof.keyword = "경남글램핑"; }, "ROTATION_RECONCILE_RESULT_NOT_VERIFIED_COMPLETE"],
    [proof => { proof.trigger = "manual"; }, "ROTATION_RECONCILE_RESULT_NOT_VERIFIED_COMPLETE"],
    [proof => { proof.nonEmpty = false; }, "ROTATION_RECONCILE_RESULT_NOT_VERIFIED_COMPLETE"],
    [proof => { proof.collectionQuality.status = "partial"; }, "ROTATION_RECONCILE_RESULT_NOT_VERIFIED_COMPLETE"],
    [proof => { proof.collectionQuality.status = "blocked"; }, "ROTATION_RECONCILE_RESULT_NOT_VERIFIED_COMPLETE"],
    [proof => { proof.collectionQuality.counts.naverScheduleFailed = 1; }, "ROTATION_RECONCILE_RESULT_NOT_VERIFIED_COMPLETE"],
    [proof => { proof.collectionQuality.failure = { code: "test" }; }, "ROTATION_RECONCILE_RESULT_NOT_VERIFIED_COMPLETE"],
    [proof => { proof.proof.scheduleOccurrenceId = "rotation_2026-10-16_1"; }, "ROTATION_RECONCILE_IDENTITY_CONFLICT"],
    [proof => { delete proof.proof.scheduleOccurrenceId; }, "ROTATION_RECONCILE_STRONG_ID_REQUIRED"],
    [proof => { proof.proof.manifestSha256 = "unverified"; }, "ROTATION_RECONCILE_PROOF_MISSING"],
    [proof => { proof.executionStartedAt = "2026-10-15T14:59:00.000Z"; }, "ROTATION_RECONCILE_OBSERVATION_TIME_MISMATCH"],
    [proof => { proof.finishedAt = "2026-10-17T03:00:00.000Z"; }, "ROTATION_RECONCILE_OBSERVATION_TIME_MISMATCH"]
  ];
  for (const key of ["searchMode", "checkIn", "checkOut", "bookingRangeDays", "bookingRangePlaceLimit", "adults", "collectionMode", "collectionPurpose", "productMode", "dayUseMode", "detailRankRanges"]) {
    rejected.push([proof => { proof.conditions[key] = typeof proof.conditions[key] === "number" ? proof.conditions[key] + 1 : "different"; }, "ROTATION_RECONCILE_CONDITIONS_MISMATCH"]);
  }
  for (const [mutate, code] of rejected) {
    f.setVerifier(context => { const proof = goodProof(context); mutate(proof); return proof; });
    await assert.rejects(f.scheduler.reconcileCompleted({ slotId: f.slotId, runId: f.runId }), { code }); assert.deepEqual(f.snapshot(), before);
  }
  assert.equal(readDb(f.scheduler.storePath, "SELECT COUNT(*) AS count FROM rotation_reconciliations")[0].count, 0); assert.equal(f.requests, 1);
});

test("preview token binds manifest proof as well as slot state and requires explicit apply", async t => {
  const f = await fixture(t), before = f.snapshot();
  await assert.rejects(f.scheduler.reconcileCompleted({ slotId: f.slotId, runId: f.runId, dryRun: false }), { code: "ROTATION_RECONCILE_PREVIEW_REQUIRED" });
  const preview = await f.scheduler.reconcileCompleted({ slotId: f.slotId, runId: f.runId });
  f.setVerifier(context => { const value = goodProof(context); value.proof.manifestSha256 = "c".repeat(64); return value; });
  await assert.rejects(f.scheduler.reconcileCompleted({ slotId: f.slotId, runId: f.runId, dryRun: false, expectedVersion: preview.expectedVersion }), { code: "ROTATION_RECONCILE_PROOF_CHANGED" });
  assert.deepEqual(f.snapshot(), before);
  f.setVerifier(goodProof); f.setFree(MIN_FREE_BYTES);
  await assert.rejects(f.scheduler.reconcileCompleted({ slotId: f.slotId, runId: f.runId, dryRun: false, expectedVersion: preview.expectedVersion }), { code: "ROTATION_DISK_SPACE_UNAVAILABLE" }); assert.deepEqual(f.snapshot(), before);
});

test("preview binds the complete published-file descriptors and durable job receipt even if manifest bytes remain the same", async t => {
  const f = await fixture(t), before = f.snapshot(); let descriptor = "d".repeat(64), jobReceipt = "e".repeat(64);
  f.setVerifier(context => { const value = goodProof(context); Object.assign(value.proof, { descriptorsSha256: descriptor, jobReceiptSha256: jobReceipt, verifiedFiles: 42 }); return value; });
  const preview = await f.scheduler.reconcileCompleted({ slotId: f.slotId, runId: f.runId });
  assert.equal(preview.proof.descriptorsSha256, descriptor); assert.equal(preview.proof.jobReceiptSha256, jobReceipt); assert.equal(preview.proof.verifiedFiles, 42);
  descriptor = "f".repeat(64);
  await assert.rejects(f.scheduler.reconcileCompleted({ slotId: f.slotId, runId: f.runId, dryRun: false, expectedVersion: preview.expectedVersion }), { code: "ROTATION_RECONCILE_PROOF_CHANGED" });
  descriptor = "d".repeat(64); jobReceipt = "f".repeat(64);
  await assert.rejects(f.scheduler.reconcileCompleted({ slotId: f.slotId, runId: f.runId, dryRun: false, expectedVersion: preview.expectedVersion }), { code: "ROTATION_RECONCILE_PROOF_CHANGED" });
  assert.deepEqual(f.snapshot(), before);
});

test("a slot changed during trusted verification fails CAS without an audit event or completion rewrite", async t => {
  const f = await fixture(t), events = f.snapshot().events;
  f.setVerifier(context => { const proof = goodProof(context); f.mutate("UPDATE rotation_slots SET error_code='ANOTHER_REVIEW' WHERE id=?", f.slotId); return proof; });
  await assert.rejects(f.scheduler.reconcileCompleted({ slotId: f.slotId, runId: f.runId }), { code: "ROTATION_RECONCILE_STATE_CHANGED" });
  assert.equal(f.scheduler.history().items.find(row => row.id === f.slotId).status, "uncertain"); assert.deepEqual(f.snapshot().events, events);
});

test("terminal partial/blocked/failed slots, invalid receipts, enabled plans and unsupported query fields stay fail-closed", async t => {
  const f = await fixture(t);
  for (const status of ["partial", "blocked", "failed", "paused", "queued", "complete"]) {
    f.mutate("UPDATE rotation_slots SET status=? WHERE id=?", status, f.slotId);
    await assert.rejects(f.scheduler.reconcileCompleted({ slotId: f.slotId, runId: f.runId }), { code: "ROTATION_RECONCILE_STATUS_INELIGIBLE" });
  }
  f.mutate("UPDATE rotation_slots SET status='uncertain',receipt_json='{' WHERE id=?", f.slotId);
  await assert.rejects(f.scheduler.reconcileCompleted({ slotId: f.slotId, runId: f.runId }), { code: "ROTATION_RECONCILE_RECEIPT_INVALID" });
  await assert.rejects(f.scheduler.reconcileCompleted({ slotId: f.slotId, runId: f.runId, execute: true }), { code: "ROTATION_RECONCILE_INPUT_INVALID" });
  const state = readDb(f.scheduler.storePath, "SELECT config_json FROM rotation_state")[0], config = JSON.parse(state.config_json); config.enabled = true;
  f.mutate("UPDATE rotation_state SET config_json=?", JSON.stringify(config));
  await assert.rejects(f.scheduler.reconcileCompleted({ slotId: f.slotId, runId: f.runId }), { code: "ROTATION_RECONCILE_PLAN_ACTIVE" });
  assert.equal(f.inspections, 0); assert.equal(f.requests, 1);
});

test("completion reconciliation is durable and a repeated apply after restart emits no new execution or audit event", async t => {
  const f = await fixture(t), preview = await f.scheduler.reconcileCompleted({ slotId: f.slotId, runId: f.runId });
  await f.scheduler.reconcileCompleted({ slotId: f.slotId, runId: f.runId, dryRun: false, expectedVersion: preview.expectedVersion });
  const before = f.snapshot(); f.scheduler.close(); const restarted = createCollectionRotationScheduler(f.options);
  try {
    const result = await restarted.reconcileCompleted({ slotId: f.slotId, runId: f.runId, dryRun: false, expectedVersion: preview.expectedVersion });
    assert.equal(result.alreadyApplied, true); assert.equal(result.applied, false); assert.equal(result.item.status, "complete");
    assert.deepEqual(f.snapshot(), before); assert.equal(f.requests, 1);
  } finally { restarted.close(); }
});

test("explicit administrator-reviewed legacy provenance is separate, token-hashed, and never invented as original occurrence metadata", async t => {
  const f = await fixture(t); f.setVerifier(legacyProof);
  await assert.rejects(f.scheduler.reconcileCompleted({ slotId: f.slotId, runId: f.runId }), { code: "ROTATION_RECONCILE_STRONG_ID_REQUIRED" });
  const preview = await f.scheduler.reconcileCompleted({ slotId: f.slotId, runId: f.runId, reviewLegacy: true });
  assert.equal(preview.proof.bindingMode, "administrator_reviewed_legacy"); assert.equal(preview.proof.legacyReview.manifestHadScheduleOccurrenceId, false);
  assert.equal(preview.proof.legacyReview.runTokenSha256, "b".repeat(64)); assert.equal(preview.proof.legacyReview.runToken, undefined);
  const applied = await f.scheduler.reconcileCompleted({ slotId: f.slotId, runId: f.runId, reviewLegacy: true, dryRun: false, expectedVersion: preview.expectedVersion });
  assert.equal(applied.item.reconciliation.bindingMode, "administrator_reviewed_legacy"); assert.equal(applied.item.receipt.scheduleOccurrenceId, undefined);
  assert.equal(f.requests, 1);
});

test("legacy ambiguity, wrong receipt binding, missing job/token hash, broad time window and known identity conflicts cannot be reviewed away", async t => {
  const f = await fixture(t), before = f.snapshot();
  const invalid = [
    proof => { proof.proof.legacyReview.uniqueCandidateCount = 2; }, proof => { proof.proof.legacyReview.receiptSha256 = "0".repeat(64); },
    proof => { proof.proof.legacyReview.slotId = "rotation_2026-10-16_3"; }, proof => { proof.proof.legacyReview.acceptedAt = "2026-10-16T02:00:00.000Z"; },
    proof => { delete proof.proof.jobId; }, proof => { delete proof.proof.runTokenSha256; }, proof => { proof.executionStartedAt = "2026-10-16T02:05:39.000Z"; proof.finishedAt = "2026-10-16T02:10:00.000Z"; }
  ];
  for (const change of invalid) {
    f.setVerifier(context => { const value = legacyProof(context); change(value); return value; });
    await assert.rejects(f.scheduler.reconcileCompleted({ slotId: f.slotId, runId: f.runId, reviewLegacy: true }), { code: "ROTATION_RECONCILE_STRONG_ID_REQUIRED" }); assert.deepEqual(f.snapshot(), before);
  }
  f.setVerifier(context => { const value = legacyProof(context); value.proof.scheduleOccurrenceId = "rotation_2026-10-16_1"; return value; });
  await assert.rejects(f.scheduler.reconcileCompleted({ slotId: f.slotId, runId: f.runId, reviewLegacy: true }), { code: "ROTATION_RECONCILE_IDENTITY_CONFLICT" });
});
