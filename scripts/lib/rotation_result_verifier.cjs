"use strict";

// Reads published results and the broker's completed receipt. This verifier
// never submits a crawl, rewrites a manifest, or changes provider protection.
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { inspectManifest } = require("../daily_collection_quality.cjs");
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const need = (value, code) => { if (!value) throw Object.assign(new Error(code), { code, statusCode: 409 }); };
const day = value => new Date(Date.parse(value) + 9 * 3600000).toISOString().slice(0, 10);
const stableStat = (a, b) => ["size", "mtimeNs", "ctimeNs", "ino", "dev"].every(key => a[key] === b[key]);

function createRotationResultVerifier({ dataDir, outputsDir = path.join(dataDir, "outputs") }) {
  const data = path.resolve(dataDir), outputs = path.resolve(outputsDir);
  async function regular(filename, limit = Infinity) {
    const value = await fs.lstat(filename, { bigint: true });
    need(value.isFile() && !value.isSymbolicLink() && Number(value.size) <= limit, "ROTATION_RESULT_FILE_UNSAFE");
    return value;
  }
  async function json(filename, limit) {
    const before = await regular(filename, limit), bytes = await fs.readFile(filename);
    need(stableStat(before, await regular(filename, limit)), "ROTATION_RESULT_CHANGED");
    let value; try { value = JSON.parse(bytes); } catch { need(false, "ROTATION_RESULT_JSON_INVALID"); }
    return { value, sha256: hash(bytes) };
  }
  async function directory(filename) {
    const value = await fs.lstat(filename);
    need(value.isDirectory() && !value.isSymbolicLink(), "ROTATION_RESULT_DIRECTORY_UNSAFE");
    need(path.resolve(await fs.realpath(filename)) === path.resolve(filename), "ROTATION_RESULT_DIRECTORY_UNSAFE");
  }
  async function fileHash(base, descriptor) {
    const name = descriptor?.path;
    need(typeof name === "string" && name.length <= 240 && !path.isAbsolute(name) && !/[\\\x00-\x1f\x7f:]/.test(name)
      && name.split("/").every(part => part && part !== "." && part !== ".."), "ROTATION_RESULT_FILE_UNSAFE");
    need(Number.isSafeInteger(descriptor.size) && descriptor.size >= 0 && descriptor.size <= 64 * 1024 * 1024
      && /^[a-f0-9]{64}$/.test(descriptor.sha256 || ""), "ROTATION_RESULT_DESCRIPTOR_INVALID");
    let parent = base;
    for (const part of name.split("/").slice(0, -1)) { parent = path.join(parent, part); await directory(parent); }
    const filename = path.join(base, name), before = await regular(filename, 64 * 1024 * 1024);
    need(Number(before.size) === descriptor.size, "ROTATION_RESULT_FILE_LENGTH_MISMATCH");
    const digest = crypto.createHash("sha256"), stream = require("node:fs").createReadStream(filename, { highWaterMark: 64 * 1024 });
    for await (const chunk of stream) digest.update(chunk);
    need(digest.digest("hex") === descriptor.sha256 && stableStat(before, await regular(filename)), "ROTATION_RESULT_FILE_HASH_MISMATCH");
    return { filename, stat: before };
  }
  const scopeMatches = (manifest, expected) => ["keyword", "workerKey", "trigger", "checkIn", "checkOut", "adults", "searchMode",
    "collectionMode", "collectionPurpose", "detailRankRanges", "productMode", "dayUseMode", "bookingRangeDays", "bookingRangePlaceLimit"]
    .every(key => String(manifest[key] ?? "").normalize("NFKC").trim() === String(expected[key] ?? "").normalize("NFKC").trim());

  return async function verifyPersistedResult({ runId, expected, slot, receipt, reviewLegacy = false }) {
    need(typeof runId === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,239}$/.test(runId), "ROTATION_RESULT_RUN_INVALID");
    need(expected?.workerKey === "manual" && expected.trigger === "scheduled", "ROTATION_RESULT_WORKER_UNSUPPORTED");
    const wanted = { ...expected.conditions, keyword: expected.keyword, workerKey: expected.workerKey, trigger: expected.trigger };
    await directory(data); await directory(outputs);
    const base = path.join(outputs, runId); await directory(base);
    const stored = await json(path.join(base, "manifest.json"), 1024 * 1024), manifest = stored.value;
    need(scopeMatches(manifest, wanted) && manifest.scheduledCollection === true && manifest.workerCollection === true
      && manifest.collectorEngine === "current-manual-v2" && manifest.collectionFailed !== true, "ROTATION_RESULT_SCOPE_MISMATCH");
    const quality = inspectManifest(manifest);
    need(quality.status === "complete" && manifest.collectionQuality?.status === "complete"
      && Number(manifest.counts?.naverOverall) > 0, "ROTATION_RESULT_NOT_COMPLETE");
    need(typeof manifest.jobId === "string" && /^collector_[a-f0-9-]{36}$/.test(manifest.jobId)
      && /^[a-p]{24}$/.test(manifest.collectorRunToken || "")
      && runId.includes(`_manual_${manifest.collectorRunToken}_glamping_`), "ROTATION_RESULT_PROVENANCE_INVALID");
    const accepted = Date.parse(receipt?.acceptedAt), started = Date.parse(manifest.startedAt);
    need(Number.isFinite(accepted) && Number.isFinite(started) && started >= accepted && day(manifest.startedAt) === slot.day,
      "ROTATION_RESULT_TIME_MISMATCH");
    const brokerDir = path.join(data, "collector"); await directory(brokerDir);
    const ledger = await json(path.join(brokerDir, "jobs.json"), 16 * 1024 * 1024);
    let job = ledger.value.jobs?.find(item => item.id === manifest.jobId), receiptHash;
    if (job) receiptHash = hash(JSON.stringify(job));
    else {
      await directory(path.join(brokerDir, "receipts"));
      const archived = await json(path.join(brokerDir, "receipts", manifest.jobId + ".json"), 4 * 1024 * 1024);
      job = archived.value; receiptHash = hash(JSON.stringify(job));
    }
    need(job?.id === manifest.jobId && job.status === "completed" && job.runId === runId && job.workerKey === "manual"
      && job.trigger === "scheduled" && job.keyword === manifest.keyword && job.leaseReleasedAt
      && job.manifest?.collectorRunToken === manifest.collectorRunToken && job.manifest?.jobId === manifest.jobId,
      "ROTATION_RESULT_BROKER_PROOF_MISMATCH");
    need(Date.parse(job.createdAt) >= accepted && started >= Date.parse(job.startedAt) && Number.isFinite(Date.parse(job.finishedAt))
      && Date.parse(job.finishedAt) >= started, "ROTATION_RESULT_TIME_MISMATCH");
    const files = job.completion?.publishedFiles;
    need(Array.isArray(files) && files.length >= 2 && files.length <= 2048
      && new Set(files.map(file => String(file.path).toLowerCase())).size === files.length
      && files.reduce((sum, file) => sum + Number(file.size), 0) <= 256 * 1024 * 1024,
      "ROTATION_RESULT_DESCRIPTOR_INVALID");
    need(files.find(file => file.path === "manifest.json")?.sha256 === stored.sha256, "ROTATION_RESULT_MANIFEST_HASH_MISMATCH");
    const referenced = ["manifest.json", ...(manifest.files || []), ...(manifest.detailJsonFiles || []).map(item => item.file)];
    need(referenced.length === files.length && new Set(referenced.map(name => String(name).toLowerCase())).size === referenced.length
      && referenced.every(name => files.some(file => file.path === name)), "ROTATION_RESULT_FILE_SET_MISMATCH");
    const observed = [];
    for (const descriptor of files) observed.push(await fileHash(base, descriptor));
    const proof = { manifestSha256: stored.sha256, jobId: job.id, runTokenSha256: hash(manifest.collectorRunToken),
      jobReceiptSha256: receiptHash, descriptorsSha256: hash(JSON.stringify(files)), verifiedFiles: files.length };
    const schedulingReceipts = [manifest.schedulingReceipt, job.manifest?.schedulingReceipt]
      .filter(value => value !== undefined);
    if (job.scheduleOccurrenceId !== undefined || schedulingReceipts.length) {
      // A conflicting or malformed persisted identity is never a legacy receipt.
      // Check every copy instead of allowing one matching copy to mask another.
      need((job.scheduleOccurrenceId === undefined || job.scheduleOccurrenceId === slot.id)
        && schedulingReceipts.every(value => value && typeof value === "object" && !Array.isArray(value)
          && value.scheduleOccurrenceId === slot.id && value.jobId === job.id)
        && manifest.schedulingReceipt?.scheduleOccurrenceId === slot.id
        && manifest.schedulingReceipt.jobId === job.id, "ROTATION_RESULT_OCCURRENCE_MISMATCH");
      proof.scheduleOccurrenceId = slot.id;
    } else {
      need(reviewLegacy === true && started <= accepted + 5 * 60000, "ROTATION_RESULT_LEGACY_REVIEW_REQUIRED");
      let matches = 0;
      for (const entry of await fs.readdir(outputs, { withFileTypes: true })) {
        const suffix = /_manual_[a-p]{24}_glamping_(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})$/.exec(entry.name);
        if (!suffix) continue;
        const guessed = Date.parse(`${suffix[1]}-${suffix[2]}-${suffix[3]}T${suffix[4]}:${suffix[5]}:${suffix[6]}+09:00`);
        if (!Number.isFinite(guessed) || guessed < accepted - 1000 || guessed > accepted + 5 * 60000) continue;
        need(entry.isDirectory() && !entry.isSymbolicLink(), "ROTATION_RESULT_DIRECTORY_UNSAFE");
        const other = (await json(path.join(outputs, entry.name, "manifest.json"), 1024 * 1024)).value;
        if (other.workerKey === "manual" && other.trigger === "scheduled" && other.keyword === expected.keyword) {
          need(scopeMatches(other, wanted), "ROTATION_RESULT_LEGACY_SCOPE_CONFLICT"); matches++;
        }
      }
      need(matches === 1, "ROTATION_RESULT_LEGACY_AMBIGUOUS");
      proof.legacyReview = { slotId: slot.id, acceptedAt: receipt.acceptedAt,
        receiptSha256: expected.receiptSha256, uniqueCandidateCount: matches, method: "administrator-reviewed-legacy-job" };
    }
    need((await json(path.join(base, "manifest.json"), 1024 * 1024)).sha256 === stored.sha256, "ROTATION_RESULT_CHANGED");
    for (const item of observed) {
      await directory(path.dirname(item.filename));
      need(stableStat(item.stat, await regular(item.filename)), "ROTATION_RESULT_CHANGED");
    }
    const finalLedger = await json(path.join(brokerDir, "jobs.json"), 16 * 1024 * 1024);
    const finalJob = finalLedger.value.jobs?.find(item => item.id === manifest.jobId)
      || (await json(path.join(brokerDir, "receipts", manifest.jobId + ".json"), 4 * 1024 * 1024)).value;
    need(hash(JSON.stringify(finalJob)) === receiptHash, "ROTATION_RESULT_BROKER_PROOF_CHANGED");
    return { verified: true, runId, workerKey: manifest.workerKey, keyword: manifest.keyword, trigger: manifest.trigger,
      executionStartedAt: manifest.startedAt, finishedAt: job.finishedAt,
      conditions: Object.fromEntries(Object.keys(expected.conditions).map(key => [key, manifest[key]])),
      collectionQuality: quality, requestPacing: manifest.requestPacing, nonEmpty: true, proof };
  };
}

module.exports = { createRotationResultVerifier };
