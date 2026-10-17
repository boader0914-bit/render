"use strict";

const fs = require("node:fs/promises");
const { constants } = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { performance } = require("node:perf_hooks");
const { savedIndustryRevisionScope } = require("./saved_source_revision_scope.cjs");

function unavailable() {
  return Object.assign(new Error("월간 집계 원본의 변경 여부를 확인하지 못했습니다. 저장자료 상태를 확인해 주세요."), {
    code: "MONTHLY_SOURCE_REVISION_UNAVAILABLE", statusCode: 503
  });
}

function boundedIo(limit) {
  let active = 0;
  const pending = [];
  function drain() {
    while (active < limit && pending.length) {
      const { operation, resolve, reject } = pending.shift();
      active++;
      Promise.resolve().then(operation).then(resolve, reject).finally(() => { active--; drain(); });
    }
  }
  return operation => new Promise((resolve, reject) => { pending.push({ operation, resolve, reject }); drain(); });
}

// This is a change detector, not an observation reader. Every relevant saved
// file is checked on every call, including edits inside an unchanged run folder.
// Directory entries are listed afresh too: on some filesystems a newly created
// child does not immediately change any directory stat field. Reusing entries
// from matching parent metadata could therefore hide a new saved run.
function createMonthlyReportSourceRevision({ dataDir, outputsDir, regionMasterFile, tourismRegionMapFile,
  includeContext = true, metadataConcurrency = 16, extraFiles = [], extraDirectories = [], fileSystem = fs,
  maxCachedDirectories = 4096, maxCachedEntries = 100000 } = {}) {
  if (!dataDir) throw new TypeError("Monthly source data directory is required");
  if (!Number.isSafeInteger(metadataConcurrency) || metadataConcurrency < 1 || metadataConcurrency > 32) throw new TypeError("Invalid metadata concurrency");
  if (!Number.isSafeInteger(maxCachedDirectories) || maxCachedDirectories < 0 ||
    !Number.isSafeInteger(maxCachedEntries) || maxCachedEntries < 0) throw new TypeError("Invalid directory inventory cache limit");
  // Keep validating these former cache options for constructor compatibility.
  // Directory inventories are intentionally no longer reused.
  const root = path.resolve(dataDir), metadata = boundedIo(metadataConcurrency);
  let scanRunning = false;
  const pendingReaders = [];
  const files = [
    ["company-master", path.join(root, "company_master", "companies.json")],
    ["observation-history", path.join(root, "history", "observations.jsonl")],
    ["capacity-bases", path.join(root, "company_integrated", "capacity-bases.json")],
    ...extraFiles.map((file, index) => [`extra-file-${index}`, path.resolve(file)])
  ];
  const references = [regionMasterFile, tourismRegionMapFile].filter(Boolean)
    .map((file, index) => [`region-reference-${index}`, path.resolve(file)]);
  const directories = [
    ["saved-runs", path.resolve(outputsDir || path.join(root, "outputs"))],
    ["special-days", path.join(root, "history", "special_days")],
    ...(includeContext ? [
      ["kosis", path.join(root, "history", "kosis")],
      ["tourism-cache", path.join(root, "tourism_data", "cache")],
      ["search-trends", path.join(root, "regional_search_trends")]
    ] : []),
    ...extraDirectories.map((directory, index) => [`extra-directory-${index}`, path.resolve(directory)])
  ];
  const signature = stat => `${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}:${stat.ino}:${stat.dev}`;
  const directorySignature = stat => `${signature(stat)}:${stat.mode}`;
  const maxReferenceBytes = 4 * 1024 * 1024;
  async function inspectAll(operations) {
    const completed = await Promise.allSettled(operations);
    const failed = completed.find(value => value.status === "rejected");
    if (failed) throw failed.reason;
  }
  async function stat(file) {
    try { return await metadata(() => fileSystem.lstat(file, { bigint: true })); }
    catch (error) { if (error.code === "ENOENT") return null; throw unavailable(); }
  }
  async function scan() {
    const rows = ["monthly-report-source-revision-v1", `context:${Boolean(includeContext)}`];
    const counts = { files: 0, directories: 0, entries: 0 };
    let entriesSeen = 0;
    async function fileRevision(label, file) {
      const value = await stat(file);
      if (!value) { rows.push(`${label}:missing`); return; }
      if (!value.isFile() || value.isSymbolicLink()) throw unavailable();
      counts.files++;
      rows.push(`${label}:${signature(value)}`);
    }
    async function referenceRevision(label, file) {
      const before = await stat(file);
      if (!before) { rows.push(`${label}:missing`); return; }
      if (!before.isFile() || before.isSymbolicLink() || before.size > BigInt(maxReferenceBytes)) throw unavailable();
      let handle;
      try {
        // Deployment paths can acquire new timestamps/inodes with identical
        // reference content. Hash only bounded bytes, but freshly validate the
        // path and opened identity on every scan, including after the read.
        handle = await metadata(() => fileSystem.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0)));
        const opened = await metadata(() => handle.stat({ bigint: true }));
        if (!opened.isFile() || directorySignature(opened) !== directorySignature(before)) throw unavailable();
        const hash = crypto.createHash("sha256"), buffer = Buffer.alloc(64 * 1024);
        let bytes = 0;
        while (true) {
          const { bytesRead } = await metadata(() => handle.read(buffer, 0, Math.min(buffer.length, maxReferenceBytes + 1 - bytes), null));
          if (!bytesRead) break;
          bytes += bytesRead;
          if (bytes > maxReferenceBytes) throw unavailable();
          hash.update(buffer.subarray(0, bytesRead));
        }
        const completed = await metadata(() => handle.stat({ bigint: true })), after = await stat(file);
        if (!after || !after.isFile() || after.isSymbolicLink() || BigInt(bytes) !== before.size
          || directorySignature(completed) !== directorySignature(before)
          || directorySignature(after) !== directorySignature(before)) throw unavailable();
        rows.push(`${label}:sha256:${hash.digest("hex")}`);
        counts.files++;
      } catch { throw unavailable(); }
      finally {
        if (handle) {
          try { await metadata(() => handle.close()); }
          catch { throw unavailable(); }
        }
      }
    }
    async function tree(label, directory, depth = 0) {
      const before = await stat(directory);
      if (!before) { rows.push(`${label}:missing`); return; }
      if (!before.isDirectory() || before.isSymbolicLink() || depth > 16) throw unavailable();
      let entries;
      const beforeSignature = directorySignature(before);
      try {
        const listed = await metadata(() => fileSystem.readdir(directory, { withFileTypes: true }));
        entries = listed.map(entry => ({ name: entry.name, kind: entry.isSymbolicLink() ? "link"
          : entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other" }));
      } catch { throw unavailable(); }
      entriesSeen += entries.length;
      counts.entries += entries.length;
      if (entriesSeen > 100000) throw unavailable();
      // Empty/missing trees are distinct. File rows, not directory mtime, form
      // the revision so creating an unrelated temporary file does not expire it.
      rows.push(`${label}:directory`);
      await inspectAll(entries.map(async entry => {
        if (entry.name.endsWith(".tmp")) return;
        const next = path.join(directory, entry.name), nextLabel = `${label}/${entry.name}`;
        // Legacy runs can become visible/incomplete from these artifact names
        // even without a manifest. Track membership without reading their bodies.
        if (/\.(?:csv|xlsx|md|html|png)$/i.test(entry.name)) rows.push(`${nextLabel}:entry:${entry.kind}`);
        if (entry.kind === "link") throw unavailable();
        if (entry.kind === "directory") return tree(nextLabel, next, depth + 1);
        if (entry.kind === "file" && /\.(?:json|jsonl|csv|md)$/i.test(entry.name)) return fileRevision(nextLabel, next);
      }));
      // A new/deleted file while listing must not validate a partially scanned
      // inventory. The caller can retry; never certify an uncertain revision.
      const after = await stat(directory);
      if (!after || !after.isDirectory() || after.isSymbolicLink() || beforeSignature !== directorySignature(after)) throw unavailable();
      counts.directories++;
    }
    await inspectAll([
      ...files.map(([label, file]) => fileRevision(label, file)),
      ...references.map(([label, file]) => referenceRevision(label, file)),
      ...directories.map(([label, directory]) => tree(label, directory))
    ]);
    return { revision: crypto.createHash("sha256").update(rows.sort().join("\n")).digest("hex"), counts };
  }
  function drainReaders() {
    if (scanRunning || !pendingReaders.length) return;
    scanRunning = true;
    // Readers queued before this inspection starts can share it. A caller that
    // arrives during the scan gets a subsequent scan, never metadata observed
    // before its request. This also bounds overlapping filesystem inventories.
    const batch = pendingReaders.splice(0);
    const startedAt = performance.now();
    Promise.resolve().then(scan).then(
      value => {
        const scanMs = Math.max(0, performance.now() - startedAt);
        for (const reader of batch) reader.resolve(reader.inspect ? {
          revision: value.revision,
          timings: { queueWaitMs: Math.max(0, startedAt - reader.queuedAt), scanMs },
          counts: { ...value.counts }
        } : value.revision);
      },
      error => {
        const failure = error.code === "MONTHLY_SOURCE_REVISION_UNAVAILABLE" ? error : unavailable();
        for (const reader of batch) reader.reject(failure);
      }
    ).finally(() => { scanRunning = false; if (pendingReaders.length) queueMicrotask(drainReaders); });
  }
  function enqueue(inspect) {
    return new Promise((resolve, reject) => {
      pendingReaders.push({ resolve, reject, inspect, queuedAt: performance.now() }); queueMicrotask(drainReaders);
    });
  }
  const readMonthlyReportSourceRevision = function () { return enqueue(false); };
  // Inspection is the same fresh check as read(), with bounded, path-free
  // diagnostics. Only callers queued before a scan starts share its work;
  // queue wait belongs to the caller, while scan duration and counts belong to
  // the inspection. Counts include existing validated target/reference files,
  // validated directories, and every freshly enumerated entry (including .tmp).
  readMonthlyReportSourceRevision.inspect = function () { return enqueue(true); };
  readMonthlyReportSourceRevision.industrySourceScope = fileSystem === fs ? savedIndustryRevisionScope({
    dataDir, outputsDir, regionMasterFile, tourismRegionMapFile
  }) : null;
  return readMonthlyReportSourceRevision;
}

module.exports = { createMonthlyReportSourceRevision };
