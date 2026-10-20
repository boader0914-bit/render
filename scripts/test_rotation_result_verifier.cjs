"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs/promises"), os = require("node:os"), path = require("node:path"), crypto = require("node:crypto");
const native = require("node:fs");
const { test } = require("node:test");
const { createRotationResultVerifier } = require("./lib/rotation_result_verifier.cjs");
const { inspectManifest } = require("./daily_collection_quality.cjs");
const sha = value => crypto.createHash("sha256").update(value).digest("hex");
const copy = value => JSON.parse(JSON.stringify(value));
async function fixture(t, { signed = false } = {}) {
  const temporary = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "rotation-verifier-")), dataDir = path.join(temporary, "data"), outputs = path.join(dataDir, "outputs");
  t.after(async () => { assert.ok(path.resolve(temporary).startsWith(path.resolve(await fs.realpath(os.tmpdir())) + path.sep)); await fs.rm(temporary, { recursive: true, force: true }); });
  const token = "abcdefghijklmnopabcdefgh", runId = `daegu_manual_${token}_glamping_20261019_150050`, base = path.join(outputs, runId), jobId = "collector_4b834f03-a176-49c8-b00b-04bca8a5d259";
  await fs.mkdir(base, { recursive: true }); await fs.mkdir(path.join(dataDir, "collector"));
  const slot = { id: "rotation_2026-10-19_2", day: "2026-10-19" }, receipt = { id: slot.id, workerKey: "manual", keyword: "대구글램핑", day: slot.day, acceptedAt: "2026-10-19T06:00:38.000Z" };
  const conditions = { searchMode: "keyword", checkIn: "2026-10-19", checkOut: "2026-11-08", bookingRangeDays: 21, bookingRangePlaceLimit: 20,
    adults: 2, collectionMode: "precision", collectionPurpose: "revenue_detail", productMode: "all", dayUseMode: "inspect", detailRankRanges: "1-20" };
  const expected = { workerKey: "manual", keyword: "대구글램핑", trigger: "scheduled", conditions, receiptSha256: sha(JSON.stringify(receipt)) };
  const days = Array.from({ length: 21 }, (_, index) => ({ date: new Date(Date.parse("2026-10-19T00:00:00Z") + index * 86400000).toISOString().slice(0, 10), eligible: 2, queried: 2, succeeded: 2, failed: 0, truncated: 0 }));
  const manifest = { ...conditions, schemaVersion: 2, workerKey: "manual", keyword: expected.keyword, trigger: "scheduled", scheduledCollection: true,
    workerCollection: true, collectorEngine: "current-manual-v2", jobId, collectorRunToken: token, startedAt: "2026-10-19T06:00:50.000Z",
    files: ["overall.csv"], detailJsonFiles: [{ file: "details.json" }], naverAttemptedQueries: [{ status: 200 }],
    counts: { naverOverall: 1, naverBookingStockChecked: 1, naverBookingStockSucceeded: 1, naverOtaObservationChecked: 1, naverOtaBlocked: 0, naverOtaFailed: 0,
      naverScheduleRequested: 42, naverScheduleSucceeded: 42, naverScheduleFailed: 0, naverScheduleBlocked: 0 },
    productCoverage: { version: 1, discovered: 2, eligible: 2, excluded: 0, queried: 2, truncated: 0,
      targets: [{ discovered: 2, eligible: 2, excluded: 0, queried: 2, truncated: 0, productListComplete: true, expectedDays: 21, days }] },
    collectionQuality: { status: "complete" }, ...(signed ? { schedulingReceipt: { scheduleOccurrenceId: slot.id, jobId } } : {}) };
  assert.equal(inspectManifest(manifest).status, "complete", "fixture passes the real quality inspector");
  await fs.writeFile(path.join(base, "overall.csv"), "place_id,name\n1,fixture\n"); await fs.writeFile(path.join(base, "details.json"), JSON.stringify({ available: 0, missing: null }));
  const job = { id: jobId, status: "completed", runId, workerKey: "manual", keyword: expected.keyword, trigger: "scheduled", createdAt: "2026-10-19T06:00:39.000Z",
    startedAt: "2026-10-19T06:00:40.000Z", finishedAt: "2026-10-19T06:20:00.000Z", leaseReleasedAt: "2026-10-19T06:20:01.000Z",
    ...(signed ? { scheduleOccurrenceId: slot.id } : {}), completion: {} };
  async function save({ extraFiles = [] } = {}) {
    await fs.writeFile(path.join(base, "manifest.json"), JSON.stringify(manifest));
    const descriptors = [];
    for (const file of ["manifest.json", ...manifest.files, ...manifest.detailJsonFiles.map(item => item.file)]) {
      if (extraFiles.some(item => item.path === file)) { descriptors.push(extraFiles.find(item => item.path === file)); continue; }
      const bytes = await fs.readFile(path.join(base, file)); descriptors.push({ path: file, size: bytes.length, sha256: sha(bytes) });
    }
    job.manifest = copy(manifest); job.completion.publishedFiles = descriptors;
    await fs.writeFile(path.join(dataDir, "collector/jobs.json"), JSON.stringify({ jobs: [job] }));
  }
  await save(); const verifier = createRotationResultVerifier({ dataDir });
  const context = { runId, expected, slot, receipt };
  return { temporary, dataDir, outputs, base, token, runId, jobId, manifest, job, context, verifier, save,
    async saveJob() { await fs.writeFile(path.join(dataDir, "collector/jobs.json"), JSON.stringify({ jobs: [job] })); } };
}

test("explicit legacy review checks every published file and returns safe digest-based attribution", async t => {
  const f = await fixture(t), source = await fs.readFile(path.join(f.base, "manifest.json"));
  await assert.rejects(f.verifier(f.context), { code: "ROTATION_RESULT_LEGACY_REVIEW_REQUIRED" });
  const result = await f.verifier({ ...f.context, reviewLegacy: true });
  assert.equal(result.verified, true); assert.equal(result.collectionQuality.status, "complete"); assert.deepEqual(result.conditions, f.context.expected.conditions);
  assert.equal(result.proof.verifiedFiles, 3); assert.equal(result.proof.manifestSha256, sha(source)); assert.equal(result.proof.runTokenSha256, sha(f.token));
  assert.equal(result.proof.legacyReview.uniqueCandidateCount, 1); assert.equal(result.proof.legacyReview.receiptSha256, f.context.expected.receiptSha256);
  assert.equal(result.proof.scheduleOccurrenceId, undefined); assert.equal(result.proof.collectorRunToken, undefined); assert.equal(result.proof.runToken, undefined);
  assert.equal(result.manifest, undefined); assert.deepEqual(await fs.readFile(path.join(f.base, "manifest.json")), source);
});

test("persisted schedulingReceipt and broker occurrence must both match without a legacy override", async t => {
  const f = await fixture(t, { signed: true }), result = await f.verifier(f.context);
  assert.equal(result.proof.scheduleOccurrenceId, f.context.slot.id); assert.equal(result.proof.legacyReview, undefined);
  f.manifest.schedulingReceipt.scheduleOccurrenceId = "rotation_2026-10-19_4"; await f.save();
  await assert.rejects(f.verifier({ ...f.context, reviewLegacy: true }), { code: "ROTATION_RESULT_OCCURRENCE_MISMATCH" });
});

test("a published-only scheduling identity cannot fall through to a legacy override", async t => {
  const f = await fixture(t);
  f.manifest.schedulingReceipt = { scheduleOccurrenceId: "rotation_2026-10-19_4", jobId: f.jobId };
  await f.save(); delete f.job.manifest.schedulingReceipt; await f.saveJob();
  await assert.rejects(f.verifier({ ...f.context, reviewLegacy: true }), { code: "ROTATION_RESULT_OCCURRENCE_MISMATCH" });
  f.manifest.schedulingReceipt.scheduleOccurrenceId = f.context.slot.id; await f.save();
  delete f.job.manifest.schedulingReceipt; await f.saveJob();
  const verified = await f.verifier({ ...f.context, reviewLegacy: true });
  assert.equal(verified.proof.scheduleOccurrenceId, f.context.slot.id);
  assert.equal(verified.proof.legacyReview, undefined, "present identities are not certified as absent legacy metadata");
});

test("no matching scheduling copy masks another copy's occurrence or job identity conflict", async t => {
  const f = await fixture(t, { signed: true });
  const conflicts = [
    job => { job.scheduleOccurrenceId = "rotation_2026-10-19_4"; },
    job => { job.manifest.schedulingReceipt.scheduleOccurrenceId = "rotation_2026-10-19_4"; },
    job => { job.manifest.schedulingReceipt.jobId = "collector_00000000-0000-4000-8000-000000000000"; },
    job => { job.scheduleOccurrenceId = ""; },
    job => { job.manifest.schedulingReceipt = null; }
  ];
  for (const change of conflicts) {
    f.job.scheduleOccurrenceId = f.context.slot.id;
    await f.save(); change(f.job); await f.saveJob();
    await assert.rejects(f.verifier({ ...f.context, reviewLegacy: true }), { code: "ROTATION_RESULT_OCCURRENCE_MISMATCH" });
  }
});

test("malformed published scheduling metadata is not treated as missing legacy metadata", async t => {
  const f = await fixture(t);
  for (const receipt of [null, {}, { jobId: f.jobId }, { scheduleOccurrenceId: "", jobId: f.jobId }]) {
    f.manifest.schedulingReceipt = receipt; await f.save();
    await assert.rejects(f.verifier({ ...f.context, reviewLegacy: true }), { code: "ROTATION_RESULT_OCCURRENCE_MISMATCH" });
  }
});

test("a same-size published data mutation cannot pass the durable broker hashes", async t => {
  const f = await fixture(t), filename = path.join(f.base, "details.json"), bytes = await fs.readFile(filename, "utf8");
  await fs.writeFile(filename, bytes.replace('"available":0', '"available":1'));
  await assert.rejects(f.verifier({ ...f.context, reviewLegacy: true }), { code: "ROTATION_RESULT_FILE_HASH_MISMATCH" });
});

test("an already-hashed data file changing while later files are checked invalidates the whole evidence", async t => {
  const f = await fixture(t), original = native.createReadStream, earlier = path.join(f.base, "overall.csv"); let changed = false;
  native.createReadStream = (filename, ...args) => {
    const stream = original(filename, ...args);
    if (filename === path.join(f.base, "details.json")) stream.once("end", () => { native.writeFileSync(earlier, native.readFileSync(earlier, "utf8").replace("fixture", "mutated")); changed = true; });
    return stream;
  };
  try {
    await assert.rejects(f.verifier({ ...f.context, reviewLegacy: true }), error => /^ROTATION_RESULT_(?:CHANGED|FILE_HASH_MISMATCH)$/.test(error.code));
    assert.equal(changed, true);
  } finally { native.createReadStream = original; }
});

test("the completed broker receipt cannot change while the published evidence is being verified", async t => {
  const f = await fixture(t), original = native.createReadStream; let changed = false;
  native.createReadStream = (filename, ...args) => {
    const stream = original(filename, ...args);
    if (filename === path.join(f.base, "details.json")) stream.once("end", () => {
      f.job.status = "cancelled"; native.writeFileSync(path.join(f.dataDir, "collector/jobs.json"), JSON.stringify({ jobs: [f.job] })); changed = true;
    });
    return stream;
  };
  try {
    await assert.rejects(f.verifier({ ...f.context, reviewLegacy: true }), error => /^ROTATION_RESULT_(?:CHANGED|BROKER_PROOF_MISMATCH|BROKER_PROOF_CHANGED)$/.test(error.code));
    assert.equal(changed, true);
  } finally { native.createReadStream = original; }
});

test("a changed manifest, an incomplete published set and broker identity conflicts stay fail-closed", async t => {
  const f = await fixture(t);
  await fs.appendFile(path.join(f.base, "manifest.json"), " ");
  await assert.rejects(f.verifier({ ...f.context, reviewLegacy: true }), { code: "ROTATION_RESULT_MANIFEST_HASH_MISMATCH" });
  await f.save(); f.job.completion.publishedFiles.pop(); await f.saveJob();
  await assert.rejects(f.verifier({ ...f.context, reviewLegacy: true }), { code: "ROTATION_RESULT_FILE_SET_MISMATCH" });
  await f.save(); f.job.manifest.collectorRunToken = "p".repeat(24); await f.saveJob();
  await assert.rejects(f.verifier({ ...f.context, reviewLegacy: true }), { code: "ROTATION_RESULT_BROKER_PROOF_MISMATCH" });
});

test("partial/block quality and wrong worker/keyword/period/rank/product conditions cannot be relabelled complete", async t => {
  const f = await fixture(t), original = copy(f.manifest);
  const changes = [
    [manifest => { manifest.counts.naverScheduleSucceeded = 41; manifest.counts.naverScheduleFailed = 1; }, "ROTATION_RESULT_NOT_COMPLETE"],
    [manifest => { manifest.requestPacing = { blockedCode: "BookingAPITooManyRequests" }; }, "ROTATION_RESULT_NOT_COMPLETE"],
    [manifest => { manifest.collectionQuality.status = "partial"; }, "ROTATION_RESULT_NOT_COMPLETE"],
    [manifest => { manifest.workerKey = "web"; }, "ROTATION_RESULT_SCOPE_MISMATCH"],
    [manifest => { manifest.keyword = "경남글램핑"; }, "ROTATION_RESULT_SCOPE_MISMATCH"],
    [manifest => { manifest.checkOut = "2026-11-09"; }, "ROTATION_RESULT_SCOPE_MISMATCH"],
    [manifest => { manifest.bookingRangeDays = 22; }, "ROTATION_RESULT_SCOPE_MISMATCH"],
    [manifest => { manifest.detailRankRanges = "1-21"; }, "ROTATION_RESULT_SCOPE_MISMATCH"],
    [manifest => { manifest.dayUseMode = "detail"; }, "ROTATION_RESULT_SCOPE_MISMATCH"],
    [manifest => { manifest.productMode = "lodging"; }, "ROTATION_RESULT_SCOPE_MISMATCH"]
  ];
  for (const [change, code] of changes) {
    for (const key of Object.keys(f.manifest)) delete f.manifest[key]; Object.assign(f.manifest, copy(original)); change(f.manifest); await f.save();
    await assert.rejects(f.verifier({ ...f.context, reviewLegacy: true }), { code });
  }
});

test("bookingRangePlaceLimit is part of exact persisted collection conditions", async t => {
  const f = await fixture(t); f.manifest.bookingRangePlaceLimit = 19; await f.save();
  await assert.rejects(f.verifier({ ...f.context, reviewLegacy: true }), { code: "ROTATION_RESULT_SCOPE_MISMATCH" });
});

test("legacy reconciliation rejects multiple same-slot candidates even when the requested run itself is valid", async t => {
  const f = await fixture(t), otherName = `daegu_manual_${"p".repeat(24)}_glamping_20261019_150051`, other = path.join(f.outputs, otherName);
  await fs.mkdir(other); await fs.writeFile(path.join(other, "manifest.json"), JSON.stringify(f.manifest));
  await assert.rejects(f.verifier({ ...f.context, reviewLegacy: true }), { code: "ROTATION_RESULT_LEGACY_AMBIGUOUS" });
});

test("descriptor path traversal and duplicate case-insensitive names are rejected before outside files are opened", async t => {
  const f = await fixture(t); f.manifest.files.push("../outside.csv");
  await f.save({ extraFiles: [{ path: "../outside.csv", size: 7, sha256: sha("outside") }] });
  await assert.rejects(f.verifier({ ...f.context, reviewLegacy: true }), { code: "ROTATION_RESULT_FILE_UNSAFE" });
  f.manifest.files.pop(); await f.save(); f.job.completion.publishedFiles.push({ path: "OVERALL.csv", size: 1, sha256: sha("x") }); await f.saveJob();
  await assert.rejects(f.verifier({ ...f.context, reviewLegacy: true }), { code: "ROTATION_RESULT_DESCRIPTOR_INVALID" });
});

test("a linked published file is not followed even when its target content has the expected hash", async t => {
  const f = await fixture(t), filename = path.join(f.base, "details.json"), target = path.join(f.temporary, "outside-details.json");
  await fs.writeFile(target, await fs.readFile(filename)); await fs.unlink(filename);
  try { await fs.symlink(target, filename, "file"); } catch (error) { if (["EPERM", "EACCES"].includes(error.code)) { t.skip("Windows does not permit file symlinks in this session"); return; } throw error; }
  await assert.rejects(f.verifier({ ...f.context, reviewLegacy: true }), { code: "ROTATION_RESULT_FILE_UNSAFE" });
});

test("a linked output run directory is rejected before reading its artifacts", async t => {
  const f = await fixture(t), moved = path.join(f.outputs, "actual-artifacts"); await fs.rename(f.base, moved);
  try { await fs.symlink(moved, f.base, "junction"); } catch (error) { if (["EPERM", "EACCES"].includes(error.code)) { t.skip("Windows does not permit directory links in this session"); return; } throw error; }
  await assert.rejects(f.verifier({ ...f.context, reviewLegacy: true }), { code: "ROTATION_RESULT_DIRECTORY_UNSAFE" });
});

test("archived completed job receipts retain the same proof and unsafe run ids never escape outputs", async t => {
  const f = await fixture(t); await fs.mkdir(path.join(f.dataDir, "collector/receipts"));
  await fs.writeFile(path.join(f.dataDir, "collector/receipts", f.jobId + ".json"), JSON.stringify(f.job)); await fs.writeFile(path.join(f.dataDir, "collector/jobs.json"), JSON.stringify({ jobs: [] }));
  const result = await f.verifier({ ...f.context, reviewLegacy: true }); assert.equal(result.verified, true); assert.equal(result.proof.jobReceiptSha256, sha(JSON.stringify(f.job)));
  await assert.rejects(f.verifier({ ...f.context, runId: "../not-a-run", reviewLegacy: true }), { code: "ROTATION_RESULT_RUN_INVALID" });
});
