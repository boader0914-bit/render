"use strict";
// Explicit saved-source capture only. No application, database, collector,
// provider, source/catalog factory or operating configuration is imported.
const fs = require("node:fs/promises"), native = require("node:fs"), path = require("node:path"), os = require("node:os"), crypto = require("node:crypto");
const LIMITS = Object.freeze({ files: 15000, bytes: 4 * 1024 ** 3, fileBytes: 512 * 1024 ** 2, historyBytes: 512 * 1024 ** 2,
  depth: 10, reserveBytes: 256 * 1024 ** 2, copyChunkBytes: 1024 * 1024, milliseconds: 15 * 60 * 1000 });
// statfs reports host capacity, not the service's /tmp quota. Never infer the
// application quota from it. Keep this complete workflow below one GiB.
const OWN_SCRATCH_HARD_BYTES = 1024 ** 3, CORE_COPY_MAX_BYTES = 512 * 1024 ** 2;
const SHA = /^[a-f0-9]{64}$/, GENERATION = /^generation-[a-f0-9]{32}$/;
const hash = () => crypto.createHash("sha256"), canonical = value => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const digest = value => hash().update(JSON.stringify(canonical(value))).digest("hex");
function fault(code) { return Object.assign(new Error(code), { code }); }
function need(value, code) { if (!value) throw fault(code); }
const contained = (parent, file) => file === parent || file.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);
const stamp = value => Object.fromEntries(["dev", "ino", "size", "mtimeNs", "ctimeNs", "mode", "nlink"].map(key => [key, String(value[key])]));
const same = (a, b) => JSON.stringify(stamp(a)) === JSON.stringify(stamp(b));
async function checkedPath(filename, directory = false) {
  need(path.isAbsolute(filename) && path.normalize(filename) === filename, "KEYWORD_COPY_ABSOLUTE_PATH_REQUIRED");
  const root = path.parse(filename).root; let current = root;
  for (const name of filename.slice(root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, name); const value = await fs.lstat(current, { bigint: true });
    need(!value.isSymbolicLink() && (current === filename || value.isDirectory()), "KEYWORD_COPY_SYMLINK_DENIED");
  }
  const value = await fs.lstat(filename, { bigint: true });
  need(directory ? value.isDirectory() : value.isFile() && value.nlink === 1n, "KEYWORD_COPY_PATH_INVALID");
  need(await fs.realpath(filename) === filename, "KEYWORD_COPY_PATH_INVALID"); return value;
}
function validateLimits(value = {}) {
  const out = { ...LIMITS, ...value };
  need(Object.keys(out).every(key => Object.hasOwn(LIMITS, key)) && Object.values(out).every(x => Number.isSafeInteger(x) && x > 0), "KEYWORD_COPY_INVALID_LIMITS");
  need(out.copyChunkBytes <= 1024 ** 2 && out.fileBytes <= LIMITS.fileBytes && out.historyBytes <= LIMITS.historyBytes
    && out.files <= LIMITS.files && out.bytes <= LIMITS.bytes && out.depth <= LIMITS.depth && out.milliseconds <= LIMITS.milliseconds,
  "KEYWORD_COPY_INVALID_LIMITS"); return out;
}
async function available(directory) { const value = await fs.statfs(directory, { bigint: true }); return value.bavail * value.bsize; }
async function safeJson(filename, maximum) {
  const before = await checkedPath(filename); need(before.size <= BigInt(maximum), "KEYWORD_COPY_POINTER_BOUND");
  const handle = await fs.open(filename, native.constants.O_RDONLY | (native.constants.O_NOFOLLOW || 0));
  try {
    need(same(before, await handle.stat({ bigint: true })), "KEYWORD_COPY_SOURCE_CHANGED");
    const bytes = await handle.readFile(); need(same(before, await handle.stat({ bigint: true })) && same(before, await checkedPath(filename)), "KEYWORD_COPY_SOURCE_CHANGED");
    return { value: JSON.parse(bytes), sha256: hash().update(bytes).digest("hex"), bytes: bytes.length };
  } finally { await handle.close(); }
}
async function inventory({ sourceDataDir, includePrepared = false, limits: suppliedLimits } = {}) {
  const limits = validateLimits(suppliedLimits), root = path.resolve(sourceDataDir || "");
  need(typeof sourceDataDir === "string" && path.isAbsolute(sourceDataDir), "KEYWORD_COPY_ABSOLUTE_PATH_REQUIRED");
  await checkedPath(root, true); const files = [], directories = [], roots = [], started = Date.now(); let bytes = 0;
  async function add(relative, optional = false) {
    const filename = path.join(root, relative); let value;
    try { value = await fs.lstat(filename, { bigint: true }); }
    catch (error) { if (optional && error.code === "ENOENT") { roots.push({ relative, present: false }); return; } throw error; }
    need(!value.isSymbolicLink(), "KEYWORD_COPY_SYMLINK_DENIED"); roots.push({ relative, present: true, directory: value.isDirectory() });
    async function visit(file, depth) {
      need(Date.now() - started <= limits.milliseconds && depth <= limits.depth, "KEYWORD_COPY_TIME_OR_DEPTH_BOUND");
      const st = await fs.lstat(file, { bigint: true }); need(!st.isSymbolicLink(), "KEYWORD_COPY_SYMLINK_DENIED");
      if (st.isDirectory()) {
        directories.push({ relative: path.relative(root, file).split(path.sep).join("/"), stamp: stamp(st) });
        const entries = await fs.readdir(file, { withFileTypes: true });
        for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
          // An unfinished publication cannot be silently omitted from a capture.
          need(!entry.name.endsWith(".tmp") && !entry.name.endsWith(".incomplete"), "KEYWORD_COPY_SOURCE_PUBLICATION_IN_PROGRESS");
          await visit(path.join(file, entry.name), depth + 1);
        }
      } else {
        need(st.isFile() && st.nlink === 1n, "KEYWORD_COPY_PATH_INVALID");
        const name = path.relative(root, file).split(path.sep).join("/");
        need(st.size <= BigInt(name === "history/observations.jsonl" ? limits.historyBytes : limits.fileBytes), "KEYWORD_COPY_FILE_BOUND");
        bytes += Number(st.size); need(files.length < limits.files && bytes <= limits.bytes, "KEYWORD_COPY_TOTAL_BOUND");
        files.push({ relative: name, bytes: Number(st.size), stamp: stamp(st) });
      }
    }
    await visit(filename, 0);
  }
  await add("company_master/companies.json"); await add("history/observations.jsonl");
  await add("company_integrated/capacity-bases.json", true); await add("company_integrated/capacity-history-index.json", true);
  await add("history/saved_product_recoveries", true); await add("history/special_days", true); await add("outputs");
  let prepared = null;
  if (includePrepared) {
    const relative = "monthly_reports/company_sources/current.json", filename = path.join(root, relative);
    try {
      const pointer = await safeJson(filename, 16 * 1024), p = pointer.value;
      need(p?.schemaVersion === 1 && GENERATION.test(p.generation || "") && SHA.test(p.catalogSha256 || "") && SHA.test(p.sourceRevision || "")
        && SHA.test(p.calculationVersion || ""), "KEYWORD_COPY_PREPARED_POINTER_INVALID");
      await add(relative); await add("monthly_reports/company_sources/" + p.generation);
      prepared = { ...pointer, value: { ...p }, freshness: "not_inferred_from_pointer; exact normalizer revision must validate this saved generation" };
    } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  const body = { schemaVersion: 1, sourceDataDir: root, files, directories, roots, fileCount: files.length, directoryCount: directories.length, bytes, prepared,
    historyIndexCopied: false, kosisCopied: false, tourismCopied: false, customerDatabaseCopied: false, configurationCopied: false };
  return { ...body, inventorySha256: digest(body), inspectedAt: new Date().toISOString(), sourceWrites: 0 };
}
async function inspect(options = {}) {
  const capture = await inventory(options), scratchParent = path.resolve(options.scratchParent || os.tmpdir());
  await checkedPath(scratchParent, true); const free = await available(scratchParent), limits = validateLimits(options.limits);
  const core = capture.files.filter(row => !row.relative.startsWith("outputs/") && !row.relative.startsWith("monthly_reports/company_sources/")), copyBytes = core.reduce((sum, row) => sum + row.bytes, 0);
  return { ...capture, captureMode: "core_physical_copy_with_readonly_original_outputs", copyFileCount: core.length, copyBytes,
    referencedOutputFiles: capture.files.filter(row => row.relative.startsWith("outputs/")).length,
    scratchParent, scratchAvailableBytes: String(free), ownScratchHardBytes: OWN_SCRATCH_HARD_BYTES, coreCopyMaxBytes: CORE_COPY_MAX_BYTES,
    conservativeRequiredBytes: String(BigInt(copyBytes) + BigInt(limits.reserveBytes)),
    canCopyWithReserve: copyBytes <= CORE_COPY_MAX_BYTES && free > BigInt(copyBytes) + BigInt(limits.reserveBytes),
    copiedFiles: 0, sourceBodiesRead: "prepared_pointer_only_if_present", operatingMutations: 0 };
}
async function copy(options = {}) {
  const limits = validateLimits(options.limits), prior = options.inspection;
  need(prior?.schemaVersion === 1 && SHA.test(prior.inventorySha256 || ""), "KEYWORD_COPY_INSPECTION_REQUIRED");
  const fresh = await inventory(options); need(fresh.inventorySha256 === prior.inventorySha256, "KEYWORD_COPY_SOURCE_CHANGED");
  const coreFiles = fresh.files.filter(row => !row.relative.startsWith("outputs/") && !row.relative.startsWith("monthly_reports/company_sources/")), coreBytes = coreFiles.reduce((sum, row) => sum + row.bytes, 0);
  need(coreBytes <= CORE_COPY_MAX_BYTES, "KEYWORD_COPY_CORE_WORKING_SET_BOUND");
  const target = path.resolve(options.copyRoot || ""), parent = path.dirname(target);
  need(typeof options.copyRoot === "string" && path.isAbsolute(options.copyRoot) && !contained(fresh.sourceDataDir, target)
    && !contained(target, fresh.sourceDataDir) && /^keyword-monthly-source-[A-Za-z0-9_-]{8,120}$/.test(path.basename(target)), "KEYWORD_COPY_TARGET_INVALID");
  await checkedPath(parent, true); need(await available(parent) > BigInt(coreBytes) + BigInt(limits.reserveBytes), "KEYWORD_COPY_DISK_RESERVE");
  await fs.mkdir(target, { mode: 0o700 }); const data = path.join(target, "data"), control = path.join(target, "control");
  await fs.mkdir(data, { mode: 0o700 }); await fs.mkdir(control, { mode: 0o700 });
  const scratch = require("./keyword_monthly_scratch_budget.cjs").installScratchBudget(target);
  const started = Date.now(), copied = [], journal = path.join(control, "copy-progress.jsonl");
  async function checkBudget() {
    scratch.assertCurrent();
    need(Date.now() - started <= limits.milliseconds, "KEYWORD_COPY_TIME_BOUND");
    need(await available(target) > BigInt(limits.reserveBytes), "KEYWORD_COPY_DISK_RESERVE");
  }
  async function hashCopyFile(row) {
    await checkBudget(); const source = path.join(fresh.sourceDataDir, ...row.relative.split("/")), output = path.join(data, ...row.relative.split("/"));
    const before = await checkedPath(source); need(JSON.stringify(stamp(before)) === JSON.stringify(row.stamp), "KEYWORD_COPY_SOURCE_CHANGED");
    await fs.mkdir(path.dirname(output), { recursive: true, mode: 0o700 });
    const input = await fs.open(source, native.constants.O_RDONLY | (native.constants.O_NOFOLLOW || 0)), out = await fs.open(output, "wx", 0o600);
    const first = hash(), buffer = Buffer.alloc(limits.copyChunkBytes); let position = 0;
    try {
      need(same(before, await input.stat({ bigint: true })), "KEYWORD_COPY_SOURCE_CHANGED");
      while (true) {
        await checkBudget(); const r = await input.read(buffer, 0, buffer.length, position); if (!r.bytesRead) break;
        first.update(buffer.subarray(0, r.bytesRead)); let written = 0;
        while (written < r.bytesRead) { const w = await out.write(buffer, written, r.bytesRead - written, position + written); need(w.bytesWritten > 0, "KEYWORD_COPY_WRITE_FAILED"); written += w.bytesWritten; }
        position += r.bytesRead; need(position <= row.bytes, "KEYWORD_COPY_SOURCE_CHANGED");
      }
      await out.sync(); need(position === row.bytes && same(before, await input.stat({ bigint: true })) && same(before, await checkedPath(source)), "KEYWORD_COPY_SOURCE_CHANGED");
    } finally { await input.close(); await out.close(); }
    // Hash destination independently with bounded buffers. Never use hardlinks.
    const second = hash(), readback = await fs.open(output, "r"); let readPosition = 0;
    try { while (true) { await checkBudget(); const r = await readback.read(buffer, 0, buffer.length, readPosition); if (!r.bytesRead) break; second.update(buffer.subarray(0, r.bytesRead)); readPosition += r.bytesRead; } }
    finally { await readback.close(); }
    const sha256 = first.digest("hex"); need(readPosition === position && second.digest("hex") === sha256, "KEYWORD_COPY_READBACK_FAILED");
    await fs.chmod(output, 0o400);
    const result = { relative: row.relative, bytes: position, sha256, sourceStamp: row.stamp, sourceUnchanged: true, physicalCopy: true };
    copied.push(result); await fs.appendFile(journal, JSON.stringify({ relative: result.relative, bytes: position, sha256 }) + "\n", { mode: 0o600 });
  }
  try {
    await fs.writeFile(path.join(control, "capture-inspection.json"), JSON.stringify(fresh), { flag: "wx", mode: 0o600 });
    for (const row of coreFiles) await hashCopyFile(row);
    const after = await inventory(options); need(after.inventorySha256 === fresh.inventorySha256, "KEYWORD_COPY_SOURCE_CHANGED");
    const manifest = { schemaVersion: 1, state: "complete", sourceDataDir: fresh.sourceDataDir, copyRoot: target, dataDir: data,
      sourceInventorySha256: fresh.inventorySha256, sourcePreserved: true, inputFiles: copied, fileCount: copied.length,
      bytes: copied.reduce((sum, row) => sum + row.bytes, 0), capturedAt: new Date().toISOString(), startedAt: new Date(started).toISOString(), elapsedMs: Date.now() - started,
      captureMode: "core_physical_copy_with_readonly_original_outputs", ownScratchHardBytes: OWN_SCRATCH_HARD_BYTES, observationIndexMode: "exact_streaming_fallback",
      wholeSourcePhysicallyCopied: false, physicalCoreCopiesOnly: true, scratch: scratch.status(),
      originalOutputs: { root: path.join(fresh.sourceDataDir, "outputs"), fileCount: fresh.files.filter(row => row.relative.startsWith("outputs/")).length,
        files: fresh.files.filter(row => row.relative.startsWith("outputs/")).map(row => ({ ...row, relative: row.relative.slice(8) })), bodyReadsDuringCopy: 0, copied: false, writeAllowed: false },
      sourceWrites: 0, physicalCopiesOnly: true, originalHistoryIndexTouched: false, kosisCopied: false, tourismCopied: false, customerDatabaseCopied: false, configurationCopied: false };
    manifest.originalOutputs.directories = fresh.directories.filter(row => row.relative === "outputs" || row.relative.startsWith("outputs/")).map(row => ({ relative: row.relative === "outputs" ? "" : row.relative.slice(8), stamp: row.stamp }));
    manifest.originalOutputs.directoryCount = manifest.originalOutputs.directories.length;
    const bytes = JSON.stringify(manifest); await fs.writeFile(path.join(control, "capture-complete.json"), bytes, { flag: "wx", mode: 0o600 });
    return { state: "complete", copyRoot: target, dataDir: data, fileCount: copied.length, bytes: manifest.bytes, sourceInventorySha256: fresh.inventorySha256,
      captureManifestSha256: hash().update(bytes).digest("hex"), sourcePreserved: true, sourceWrites: 0, elapsedMs: manifest.elapsedMs,
      captureMode: manifest.captureMode, originalOutputBodiesCopied: 0, originalOutputFileCount: manifest.originalOutputs.fileCount, ownScratchHardBytes: OWN_SCRATCH_HARD_BYTES };
  } catch (error) {
    await fs.writeFile(path.join(control, "capture-failed.json"), JSON.stringify({ state: "failed", code: error.code || "KEYWORD_COPY_FAILED", copiedFiles: copied.length,
      startedAt: new Date(started).toISOString(), finishedAt: new Date().toISOString(), sourceWrites: 0, incompleteCopyRetained: true }), { flag: "wx", mode: 0o600 }).catch(() => {});
    throw error;
  } finally { scratch.restore(); }
}
module.exports = { LIMITS, OWN_SCRATCH_HARD_BYTES, CORE_COPY_MAX_BYTES, inventory, inspect, copy, checkedPath, safeJson, digest, stamp };
