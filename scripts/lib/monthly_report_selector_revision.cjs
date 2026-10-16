"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");

function unavailable() {
  return Object.assign(new Error("선택 목록 원본의 변경 여부를 확인하지 못했습니다. 저장자료 상태를 확인해 주세요."), {
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

// Selector data uses company labels/regions, history months and the public run
// catalog. Booking-detail bodies, capacity calculations and API context are not
// selector inputs. Keep this instance independent of the full report scanner so
// a saved selector lookup does not wait for a large booking-file inspection.
function createMonthlyReportSelectorRevision({ dataDir, outputsDir, regionMasterFile, metadataConcurrency = 16,
  fileSystem = fs } = {}) {
  if (!dataDir) throw new TypeError("Monthly selector data directory is required");
  if (!Number.isSafeInteger(metadataConcurrency) || metadataConcurrency < 1 || metadataConcurrency > 32) throw new TypeError("Invalid metadata concurrency");
  const root = path.resolve(dataDir), outputs = path.resolve(outputsDir || path.join(root, "outputs"));
  const metadata = boundedIo(metadataConcurrency);
  const files = [
    ["company-master", path.join(root, "company_master", "companies.json")],
    ["observation-history", path.join(root, "history", "observations.jsonl")],
    ...(regionMasterFile ? [["region-reference", path.resolve(regionMasterFile)]] : [])
  ];
  let scanRunning = false;
  const pendingReaders = [];
  const signature = stat => [stat.size, stat.mtimeNs, stat.ctimeNs, stat.ino, stat.dev].join(":");
  const directorySignature = stat => signature(stat) + ":" + stat.mode;
  // Must match listRuns in glamping_app_server.cjs. Nonmatching output folders
  // cannot supply a keyword or stay month to monthly_report_sources.options.
  const runDirectoryPattern = /_glamping_\d{8}(?:_\d{6})?$/;

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
    const rows = ["monthly-report-selector-revision-v1"];
    let entriesSeen = 0;
    async function fileRevision(label, file) {
      const value = await stat(file);
      if (!value) { rows.push(label + ":missing"); return; }
      if (!value.isFile() || value.isSymbolicLink()) throw unavailable();
      rows.push(label + ":" + signature(value));
    }
    async function directory(label, directoryPath, isRoot = false) {
      const before = await stat(directoryPath);
      if (!before) { rows.push(label + ":missing"); return; }
      if (!before.isDirectory() || before.isSymbolicLink()) throw unavailable();
      const beforeSignature = directorySignature(before);
      let entries;
      // A shallow inventory is cheap compared with all booking-file metadata.
      // Read it on every scan: some filesystems can add an entry without an
      // immediately distinguishable parent timestamp, so metadata alone cannot
      // certify that a saved path list is complete.
      try {
        const listed = await metadata(() => fileSystem.readdir(directoryPath, { withFileTypes: true }));
        entries = listed.map(entry => ({ name: entry.name, kind: entry.isSymbolicLink() ? "link"
          : entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other" }));
      } catch { throw unavailable(); }
      entriesSeen += entries.length;
      if (entriesSeen > 100000) throw unavailable();
      rows.push(label + ":directory");
      if (isRoot) {
        await inspectAll(entries.map(async entry => {
          if (!runDirectoryPattern.test(entry.name)) return;
          if (entry.kind === "link") throw unavailable();
          if (entry.kind === "directory") return directory(label + "/" + entry.name, path.join(directoryPath, entry.name));
        }));
      } else {
        for (const entry of entries) {
          if (entry.name.endsWith(".tmp")) continue;
          if (entry.kind === "link") throw unavailable();
          // listRuns only tests direct names for visible CSV/XLSX/MD/HTML/PNG
          // outputs. Conservatively retain all direct names/kinds, but never
          // inspect raw-file metadata or descend into booking-detail folders.
          rows.push(label + "/" + entry.name + ":entry:" + entry.kind);
        }
        // A manifest may be edited in place without changing its parent. Check
        // it every time, including when the inventory says it is absent.
        await fileRevision(label + "/manifest.json", path.join(directoryPath, "manifest.json"));
      }
      const after = await stat(directoryPath);
      if (!after || !after.isDirectory() || after.isSymbolicLink() || beforeSignature !== directorySignature(after)) throw unavailable();
    }
    await inspectAll([
      ...files.map(([label, file]) => fileRevision(label, file)),
      directory("saved-runs", outputs, true)
    ]);
    return crypto.createHash("sha256").update(rows.sort().join("\n")).digest("hex");
  }
  function drainReaders() {
    if (scanRunning || !pendingReaders.length) return;
    scanRunning = true;
    // Only callers queued before inspection begins may share its metadata.
    // Post-read verification arriving mid-scan must observe a later inspection.
    const batch = pendingReaders.splice(0);
    Promise.resolve().then(scan).then(
      value => { for (const reader of batch) reader.resolve(value); },
      error => {
        const failure = error.code === "MONTHLY_SOURCE_REVISION_UNAVAILABLE" ? error : unavailable();
        for (const reader of batch) reader.reject(failure);
      }
    ).finally(() => { scanRunning = false; if (pendingReaders.length) queueMicrotask(drainReaders); });
  }
  return function readMonthlyReportSelectorRevision() {
    return new Promise((resolve, reject) => {
      pendingReaders.push({ resolve, reject }); queueMicrotask(drainReaders);
    });
  };
}

module.exports = { createMonthlyReportSelectorRevision };
