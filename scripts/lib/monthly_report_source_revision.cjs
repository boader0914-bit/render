"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");

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
// It deliberately does not retain a TTL or trust only directory timestamps.
function createMonthlyReportSourceRevision({ dataDir, outputsDir, regionMasterFile, tourismRegionMapFile,
  includeContext = true, metadataConcurrency = 16, extraFiles = [], extraDirectories = [], fileSystem = fs } = {}) {
  if (!dataDir) throw new TypeError("Monthly source data directory is required");
  if (!Number.isSafeInteger(metadataConcurrency) || metadataConcurrency < 1 || metadataConcurrency > 32) throw new TypeError("Invalid metadata concurrency");
  const root = path.resolve(dataDir), metadata = boundedIo(metadataConcurrency);
  const files = [
    ["company-master", path.join(root, "company_master", "companies.json")],
    ["observation-history", path.join(root, "history", "observations.jsonl")],
    ["capacity-bases", path.join(root, "company_integrated", "capacity-bases.json")],
    ...[regionMasterFile, tourismRegionMapFile].filter(Boolean).map((file, index) => [`region-reference-${index}`, path.resolve(file)]),
    ...extraFiles.map((file, index) => [`extra-file-${index}`, path.resolve(file)])
  ];
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
  async function stat(file) {
    try { return await metadata(() => fileSystem.lstat(file, { bigint: true })); }
    catch (error) { if (error.code === "ENOENT") return null; throw unavailable(); }
  }
  async function scan() {
    const rows = ["monthly-report-source-revision-v1", `context:${Boolean(includeContext)}`];
    let entriesSeen = 0;
    async function fileRevision(label, file) {
      const value = await stat(file);
      if (!value) { rows.push(`${label}:missing`); return; }
      if (!value.isFile() || value.isSymbolicLink()) throw unavailable();
      rows.push(`${label}:${signature(value)}`);
    }
    async function tree(label, directory, depth = 0) {
      const before = await stat(directory);
      if (!before) { rows.push(`${label}:missing`); return; }
      if (!before.isDirectory() || before.isSymbolicLink() || depth > 16) throw unavailable();
      let entries;
      try { entries = await metadata(() => fileSystem.readdir(directory, { withFileTypes: true })); }
      catch { throw unavailable(); }
      entriesSeen += entries.length;
      if (entriesSeen > 100000) throw unavailable();
      // Empty/missing trees are distinct. File rows, not directory mtime, form
      // the revision so creating an unrelated temporary file does not expire it.
      rows.push(`${label}:directory`);
      await Promise.all(entries.map(async entry => {
        if (entry.name.endsWith(".tmp")) return;
        const next = path.join(directory, entry.name), nextLabel = `${label}/${entry.name}`;
        if (entry.isSymbolicLink()) throw unavailable();
        if (entry.isDirectory()) return tree(nextLabel, next, depth + 1);
        if (entry.isFile() && /\.(?:json|jsonl|csv|md)$/i.test(entry.name)) return fileRevision(nextLabel, next);
      }));
      // A new/deleted file while listing must not validate a partially scanned
      // inventory. The caller can retry; never certify an uncertain revision.
      const after = await stat(directory);
      if (!after || signature(before) !== signature(after)) throw unavailable();
    }
    await Promise.all([
      ...files.map(([label, file]) => fileRevision(label, file)),
      ...directories.map(([label, directory]) => tree(label, directory))
    ]);
    return crypto.createHash("sha256").update(rows.sort().join("\n")).digest("hex");
  }
  return async function readMonthlyReportSourceRevision() {
    try { return await scan(); }
    catch (error) { if (error.code === "MONTHLY_SOURCE_REVISION_UNAVAILABLE") throw error; throw unavailable(); }
  };
}

module.exports = { createMonthlyReportSourceRevision };
