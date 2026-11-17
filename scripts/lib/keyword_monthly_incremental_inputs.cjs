"use strict";

// Bounded metadata over the exact saved-input namespaces. Only the explicitly
// whitelisted small dependency seeds are copied; master/history/output bodies
// are never opened by metadataInventory or verifyInventory.
const fs = require("node:fs/promises"), native = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const { checkedPath, stamp } = require("./keyword_monthly_source_copy.cjs");
const H = require("./keyword_monthly_refresh_preparation.cjs");
const LIMITS = Object.freeze({ files: 15000, directories: 15000, depth: 10, fileBytes: 512 * 1024 ** 2,
  bytes: 4 * 1024 ** 3, sourceMetadataBytes: 8 * 1024 ** 3, manifestBytes: 1024 ** 2, seedBytes: 64 * 1024 ** 2, seedFileBytes: 8 * 1024 ** 2 });
const SOURCES = ["company_master/companies.json", "history/observations.jsonl"];
const SEEDS = ["company_integrated/capacity-bases.json", "history/special_days", "history/saved_product_recoveries"];
const CAPACITY_BASES = "company_integrated/capacity-bases.json";
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const digest = value => hash(JSON.stringify(value));
const need = (value, code = "KEYWORD_INCREMENTAL_INPUTS_INVALID") => H.need(value, code);
const slash = value => value.split(path.sep).join("/");
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
function globalSeedContentHash(relative, bytes) {
  if (relative !== CAPACITY_BASES) return hash(bytes);
  // Individual basis entries already participate in each company's exact
  // preparation key. A single reviewed company must not dirty every keyword.
  // Unknown top-level fields remain global dependencies; source byte/stamp
  // checks below still pin the complete file, including all company entries.
  let value; try { value = JSON.parse(bytes.toString("utf8")); } catch { need(false, "KEYWORD_INCREMENTAL_CAPACITY_SEED_INVALID"); }
  need(value && typeof value === "object" && !Array.isArray(value) && value.schemaVersion === 1
    && value.companies && typeof value.companies === "object" && !Array.isArray(value.companies), "KEYWORD_INCREMENTAL_CAPACITY_SEED_INVALID");
  return digest(Object.fromEntries(Object.entries(value).filter(([key]) => key !== "companies")));
}
function limits(input = {}) {
  need(input && typeof input === "object" && !Array.isArray(input) && Object.entries(input).every(([key, value]) => Object.hasOwn(LIMITS, key)
    && Number.isSafeInteger(value) && value > 0 && value <= LIMITS[key]), "KEYWORD_INCREMENTAL_INPUT_LIMITS_INVALID");
  return { ...LIMITS, ...input };
}
async function optional(file, directory) {
  try { return await checkedPath(file, directory); }
  catch (error) {
    if (error.code !== "ENOENT") throw error;
    // Missing leaves do not excuse an unsafe existing ancestor.
    let parent = path.dirname(file);
    while (true) {
      try { await checkedPath(parent, true); break; }
      catch (failure) { if (failure.code !== "ENOENT") throw failure; const next = path.dirname(parent); need(next !== parent); parent = next; }
    }
    return null;
  }
}
async function fileMetadata(root, relative, bounds, optionalFile = false) {
  const filename = path.join(root, ...relative.split("/")), value = optionalFile ? await optional(filename, false) : await checkedPath(filename);
  if (!value) return { relative, present: false, bytes: null, stamp: null };
  need(value.size <= BigInt(bounds.fileBytes), "KEYWORD_INCREMENTAL_INPUT_FILE_BOUND");
  if (path.basename(filename).toLowerCase() === "manifest.json") need(value.size <= BigInt(bounds.manifestBytes), "KEYWORD_INCREMENTAL_MANIFEST_BOUND");
  return { relative, present: true, bytes: Number(value.size), stamp: stamp(value) };
}
async function treeMetadata(root, bounds, { optionalRoot = false, maxBytes = bounds.bytes, maxFileBytes = bounds.fileBytes, directoryStamps = null } = {}) {
  const first = optionalRoot ? await optional(root, true) : await checkedPath(root, true);
  if (!first) return { present: false, files: [], directories: [], bytes: 0 };
  const files = [], directories = []; let bytes = 0;
  async function visit(directory, depth) {
    need(depth <= bounds.depth, "KEYWORD_INCREMENTAL_INPUT_DEPTH_BOUND");
    const before = await checkedPath(directory, true), relative = slash(path.relative(root, directory));
    // Detect changed captured parents before following a newly listed path. The
    // strict output view correctly denies unknown paths; an external inventory
    // change is an input conflict, not an exemption from that read protection.
    if (directoryStamps) need(same(stamp(before), directoryStamps.get(relative)), "KEYWORD_INCREMENTAL_INPUTS_CHANGED");
    need(directories.length < bounds.directories, "KEYWORD_INCREMENTAL_INPUT_DIRECTORY_BOUND");
    directories.push({ relative, stamp: stamp(before) });
    const entries = await fs.readdir(directory, { withFileTypes: true });
    need(same(stamp(before), stamp(await checkedPath(directory, true))), "KEYWORD_INCREMENTAL_INPUTS_CHANGED");
    need(entries.length <= bounds.files + bounds.directories, "KEYWORD_INCREMENTAL_INPUT_ENTRY_BOUND");
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      need(depth + 1 <= bounds.depth, "KEYWORD_INCREMENTAL_INPUT_DEPTH_BOUND");
      need(!entry.name.endsWith(".tmp") && !entry.name.endsWith(".incomplete"), "KEYWORD_INCREMENTAL_INPUT_PUBLICATION_IN_PROGRESS");
      const filename = path.join(directory, entry.name);
      need(!entry.isSymbolicLink() && (entry.isDirectory() || entry.isFile()), "KEYWORD_INCREMENTAL_INPUT_PATH_UNSAFE");
      if (entry.isDirectory()) await visit(filename, depth + 1);
      else {
        const item = await fileMetadata(root, slash(path.relative(root, filename)), { ...bounds, fileBytes: maxFileBytes });
        bytes += item.bytes; need(files.length < bounds.files && bytes <= maxBytes, "KEYWORD_INCREMENTAL_INPUT_TOTAL_BOUND");
        const { present, ...captured } = item; files.push(captured);
      }
    }
    need(same(stamp(before), stamp(await checkedPath(directory, true))), "KEYWORD_INCREMENTAL_INPUTS_CHANGED");
  }
  await visit(root, 0);
  // A file may have changed without touching its containing directory mtime.
  for (const row of files) {
    const current = await checkedPath(path.join(root, ...row.relative.split("/")));
    need(same(row.stamp, stamp(current)), "KEYWORD_INCREMENTAL_INPUTS_CHANGED");
  }
  for (const row of directories) {
    const current = await checkedPath(path.join(root, ...row.relative.split("/")), true);
    need(same(row.stamp, stamp(current)), "KEYWORD_INCREMENTAL_INPUTS_CHANGED");
  }
  return { present: true, files, directories, bytes };
}
async function metadataInventory({ dataDir, limits: input } = {}, expectedOutputDirectories = null) {
  H.absolute(dataDir); await checkedPath(dataDir, true); const bounds = limits(input), sourceFiles = [];
  need(expectedOutputDirectories === null || Array.isArray(expectedOutputDirectories) && expectedOutputDirectories.length > 0
    && expectedOutputDirectories.length <= bounds.directories, "KEYWORD_INCREMENTAL_INPUT_EXPECTED_REQUIRED");
  // This is a metadata ceiling, not a copy/body-read allowance. A growing
  // authoritative history may exceed the old physical-copy chunk budget.
  const sourceBounds = { ...bounds, fileBytes: bounds.sourceMetadataBytes };
  for (const relative of SOURCES) sourceFiles.push(await fileMetadata(dataDir, relative, sourceBounds, true));
  const outputRoot = path.join(dataDir, "outputs"), captured = await treeMetadata(outputRoot, bounds, {
    directoryStamps: expectedOutputDirectories && new Map(expectedOutputDirectories.map(row => [row.relative, row.stamp])) });
  for (const row of sourceFiles) need(same(row, await fileMetadata(dataDir, row.relative, sourceBounds, true)), "KEYWORD_INCREMENTAL_INPUTS_CHANGED");
  const body = { schemaVersion: 1, dataDir, sourceFiles, outputs: { root: outputRoot, files: captured.files, directories: captured.directories } };
  return { ...body, inventorySha256: digest(body), fileCount: captured.files.length, directoryCount: captured.directories.length,
    outputBytes: captured.bytes, masterBodyReads: 0, historyBodyReads: 0, outputBodyReads: 0 };
}
async function verifyInventory({ expected, dataDir, limits: input } = {}) {
  need(expected?.schemaVersion === 1 && H.SHA.test(expected.inventorySha256 || "") && expected.dataDir === dataDir
    && expected.outputs?.root === path.join(dataDir, "outputs") && Array.isArray(expected.outputs.directories), "KEYWORD_INCREMENTAL_INPUT_EXPECTED_REQUIRED");
  const fresh = await metadataInventory({ dataDir, limits: input }, expected.outputs.directories);
  need(fresh.inventorySha256 === expected.inventorySha256, "KEYWORD_INCREMENTAL_INPUTS_CHANGED");
  return { preserved: true, inventorySha256: fresh.inventorySha256, fileCount: fresh.fileCount, outputBytes: fresh.outputBytes,
    masterBodyReads: 0, historyBodyReads: 0, outputBodyReads: 0 };
}
async function seedMetadata(dataDir, bounds) {
  const roots = [], files = [], directories = []; let bytes = 0;
  for (const relative of SEEDS) {
    const filename = path.join(dataDir, ...relative.split("/")), directory = !relative.endsWith(".json");
    if (!directory) {
      const row = await fileMetadata(dataDir, relative, { ...bounds, fileBytes: bounds.seedFileBytes }, true);
      roots.push({ relative, present: row.present, directory: false });
      if (row.present) { const { present, ...captured } = row; files.push(captured); bytes += row.bytes; }
    } else {
      const captured = await treeMetadata(filename, bounds, { optionalRoot: true, maxBytes: bounds.seedBytes, maxFileBytes: bounds.seedFileBytes });
      roots.push({ relative, present: captured.present, directory: true });
      for (const row of captured.files) files.push({ ...row, relative: `${relative}/${row.relative}` });
      for (const row of captured.directories) directories.push({ ...row, relative: row.relative ? `${relative}/${row.relative}` : relative });
      bytes += captured.bytes;
    }
    need(files.length <= bounds.files && directories.length <= bounds.directories && bytes <= bounds.seedBytes, "KEYWORD_INCREMENTAL_SEED_TOTAL_BOUND");
  }
  return { roots, files, directories, bytes };
}
async function ensureChildDirectories(root, directory) {
  need(H.inside(root, directory)); let current = root;
  for (const part of path.relative(root, directory).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try { await checkedPath(current, true); }
    catch (error) { if (error.code !== "ENOENT") throw error; await checkedPath(path.dirname(current), true); await fs.mkdir(current, { mode: 0o700 }); await checkedPath(current, true); }
  }
}
async function seedDependencies({ dataDir, workDataDir, limits: input } = {}) {
  H.absolute(dataDir); H.absolute(workDataDir); const bounds = limits(input);
  need(dataDir !== workDataDir && !H.inside(workDataDir, dataDir), "KEYWORD_INCREMENTAL_SEED_TARGET_INVALID");
  await checkedPath(dataDir, true); const work = await checkedPath(workDataDir, true);
  const before = await seedMetadata(dataDir, bounds), copied = [], globalFiles = [];
  for (const row of before.directories) await ensureChildDirectories(workDataDir, path.join(workDataDir, ...row.relative.split("/")));
  for (const row of before.files) {
    const source = path.join(dataDir, ...row.relative.split("/")), target = path.join(workDataDir, ...row.relative.split("/"));
    need(source !== target && !H.inside(source, workDataDir), "KEYWORD_INCREMENTAL_SEED_TARGET_INVALID");
    await ensureChildDirectories(workDataDir, path.dirname(target));
    need(same(row.stamp, stamp(await checkedPath(source))), "KEYWORD_INCREMENTAL_INPUTS_CHANGED");
    const reader = await fs.open(source, native.constants.O_RDONLY | (native.constants.O_NOFOLLOW || 0)); let bytes;
    try {
      need(same(row.stamp, stamp(await reader.stat({ bigint: true }))), "KEYWORD_INCREMENTAL_INPUTS_CHANGED");
      bytes = await reader.readFile();
      need(bytes.length === row.bytes && bytes.length <= bounds.seedFileBytes && same(row.stamp, stamp(await reader.stat({ bigint: true }))), "KEYWORD_INCREMENTAL_INPUTS_CHANGED");
    } finally { await reader.close(); }
    need(same(row.stamp, stamp(await checkedPath(source))), "KEYWORD_INCREMENTAL_INPUTS_CHANGED");
    const writer = await fs.open(target, "wx", 0o600);
    try { await writer.writeFile(bytes); await writer.sync(); } finally { await writer.close(); }
    const saved = await checkedPath(target), sourceHash = hash(bytes);
    need(Number(saved.size) === bytes.length && hash(await fs.readFile(target)) === sourceHash, "KEYWORD_INCREMENTAL_SEED_READBACK_FAILED");
    copied.push({ relative: row.relative, bytes: bytes.length, sha256: sourceHash, sourceStamp: row.stamp, copyStamp: stamp(saved) });
    globalFiles.push(row.relative === CAPACITY_BASES
      ? { relative: row.relative, sha256: globalSeedContentHash(row.relative, bytes) }
      : { relative: row.relative, bytes: row.bytes, sha256: sourceHash, sourceStamp: row.stamp });
  }
  const after = await seedMetadata(dataDir, bounds);
  need(same(before, after), "KEYWORD_INCREMENTAL_INPUTS_CHANGED");
  const workAfter = await checkedPath(workDataDir, true);
  need(work.dev === workAfter.dev && work.ino === workAfter.ino, "KEYWORD_INCREMENTAL_SEED_TARGET_CHANGED");
  return { schemaVersion: 1, dataDir, workDataDir, roots: before.roots, sourceDirectories: before.directories, copied,
    bytes: copied.reduce((sum, row) => sum + row.bytes, 0), sourceInventorySha256: digest(before), preserved: true,
    globalDependencySha256: digest({ kind: "keyword_monthly_global_seed_dependencies_v1", roots: before.roots,
      directories: before.directories, files: globalFiles }),
    sourceWrites: 0, masterBodyReads: 0, historyBodyReads: 0, kosisCopied: false };
}
async function verifyDependencies({ seeded, dataDir, limits: input } = {}) {
  H.absolute(dataDir);
  need(seeded?.schemaVersion === 1 && seeded.dataDir === dataDir && H.SHA.test(seeded.sourceInventorySha256 || "")
    && Array.isArray(seeded.roots) && Array.isArray(seeded.copied) && Array.isArray(seeded.sourceDirectories), "KEYWORD_INCREMENTAL_SEED_EXPECTED_REQUIRED");
  const current = await seedMetadata(dataDir, limits(input));
  need(digest(current) === seeded.sourceInventorySha256, "KEYWORD_INCREMENTAL_INPUTS_CHANGED");
  return { preserved: true, sourceInventorySha256: seeded.sourceInventorySha256, fileCount: current.files.length,
    bytes: current.bytes, sourceBodyReads: 0 };
}

module.exports = { LIMITS, metadataInventory, verifyInventory, seedDependencies, verifyDependencies };
