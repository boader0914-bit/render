"use strict";
// Cleanup is restricted to immutable generations proved by this refresh's own
// completed live receipts. No original, manual generation or proof is removed.
const fs = require("node:fs/promises"), native = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const { validateCatalog, validatePointer } = require("./keyword_monthly_bundle.cjs");
const SHA = /^[a-f0-9]{64}$/, GEN = /^[a-f0-9]{32}$/, UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const VERSION = "keyword-monthly-completed-run-v1", OWNER = "keyword_monthly_completed_run_refresh";
const LIMITS = Object.freeze({ receiptEntries: 16384, receipts: 4096, receiptBytes: 256 * 1024, catalogBytes: 1024 * 1024,
  indexBytes: 1024 * 1024, projectionBytes: 32 * 1024 * 1024, generationBytes: 144 * 1024 * 1024, generationFiles: 16384, auditedAutoBytes: 1024 ** 3 });
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const same = (a, b) => ["dev", "ino", "size", "nlink", "mtimeMs", "ctimeMs"].every(k => a[k] === b[k]);
const identity = (a, b) => a.dev === b.dev && a.ino === b.ino;
const iso = value => typeof value === "string" && /^20\d{2}-\d\d-\d\dT.*Z$/.test(value) && Number.isFinite(Date.parse(value));
const need = (value, code) => { if (!value) throw Object.assign(new Error(code), { code: "KEYWORD_MONTHLY_RETENTION_" + code }); };
const samePath = (a, b) => process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
async function checked(file, directory = false) {
  need(typeof file === "string" && path.isAbsolute(file) && path.resolve(file) === file, "PATH_INVALID");
  let current = path.parse(file).root;
  for (const part of file.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part); const stat = await fs.lstat(current);
    need(!stat.isSymbolicLink() && (current === file || stat.isDirectory()) && samePath(await fs.realpath(current), current), "PATH_UNSAFE");
  }
  const stat = await fs.lstat(file); need(directory ? stat.isDirectory() : stat.isFile() && stat.nlink === 1, "PATH_UNSAFE");
  if (process.platform === "linux") need(stat.uid === process.getuid() && (stat.mode & 0o022) === 0, "PATH_OWNER"); return stat;
}
async function read(file, maximum) {
  const stat = await checked(file); need(stat.size > 0 && stat.size <= maximum, "READ_BOUND");
  const handle = await fs.open(file, native.constants.O_RDONLY | (native.constants.O_NOFOLLOW || 0)); let bytes;
  try { need(same(stat, await handle.stat()), "EVIDENCE_CHANGED"); bytes = await handle.readFile(); need(bytes.length === stat.size && same(stat, await handle.stat()), "EVIDENCE_CHANGED"); }
  finally { await handle.close(); }
  need(same(stat, await checked(file)), "EVIDENCE_CHANGED"); return { file, bytes, sha256: hash(bytes), stat };
}
function json(read) { try { return JSON.parse(read.bytes); } catch { need(false, "JSON_INVALID"); } }
function ownReceipt(value, name, fixture) {
  if (value?.generatedBy !== OWNER) return null;
  const source = [VERSION, value.runId, value.manifestSha256, value.keyword];
  need(value.schemaVersion === 1 && value.status === "published" && value.mode === "live" && value.refreshVersion === VERSION
    && value.trigger === "completed_collection_postprocess" && UUID.test(value.jobId || "") && SHA.test(value.sourceKey || "")
    && name === `complete-${value.sourceKey}.json` && /^[A-Za-z0-9][A-Za-z0-9_-]{0,239}$/.test(value.runId || "")
    && typeof value.keyword === "string" && value.keyword === value.keyword.trim() && value.keyword.length > 0 && value.keyword.length <= 160 && !/[\u0000-\u001f\u007f]/.test(value.keyword)
    && SHA.test(value.manifestSha256 || "") && hash(JSON.stringify(source)) === value.sourceKey && GEN.test(value.generation || "")
    && ["pointerSha256", "catalogSha256", "publicationReceiptSha256", "previousPointerSha256"].every(k => SHA.test(value[k] || "")) && iso(value.finishedAt)
    && value.providerCalls === 0 && value.sourceWrites === 0
    && (fixture === true || value.fixtureOnly === false && value.strictIsolationVerified === true && value.executionBasis === "fresh_physical_capture_and_strict_isolated_normalization"), "RECEIPT_INVALID");
  return Object.fromEntries(["sourceKey", "generation", "pointerSha256", "catalogSha256", "publicationReceiptSha256", "previousPointerSha256", "finishedAt"].map(k => [k, value[k]]));
}
async function completedReceipts(directory, fixture) {
  const parent = await checked(directory, true), result = []; let entries = 0, completedEntries = 0;
  const stream = await fs.opendir(directory);
  for await (const entry of stream) {
    need(++entries <= LIMITS.receiptEntries, "RECEIPT_INVENTORY_BOUND");
    if (!/^complete-[a-f0-9]{64}\.json$/.test(entry.name)) continue;
    need(++completedEntries <= LIMITS.receipts, "RECEIPT_INVENTORY_BOUND");
    const saved = await read(path.join(directory, entry.name), LIMITS.receiptBytes), own = ownReceipt(json(saved), entry.name, fixture);
    if (own) result.push({ ...own, receiptFile: saved.file, receiptSha256: saved.sha256 });
  }
  need(identity(parent, await checked(directory, true)), "EVIDENCE_CHANGED"); return result;
}
async function auditGeneration(directory, receipt) {
  let stamp; try { stamp = await checked(directory, true); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
  const files = new Map(), directories = new Map([["", stamp]]); let totalBytes = 0;
  const add = async (relative, maximum, expectedHash, expectedBytes) => {
    need(!files.has(relative), "GENERATION_DUPLICATE_FILE");
    const saved = await read(path.join(directory, relative), maximum);
    need(!expectedHash || saved.sha256 === expectedHash, "GENERATION_HASH_MISMATCH");
    need(expectedBytes === undefined || saved.bytes.length === expectedBytes, "GENERATION_SIZE_MISMATCH");
    totalBytes += saved.bytes.length; need(totalBytes <= LIMITS.generationBytes && files.size < LIMITS.generationFiles, "GENERATION_BOUND");
    files.set(relative, { stat: saved.stat, sha256: saved.sha256, bytes: saved.bytes.length }); return saved;
  };
  const publicationRead = await add("publication-receipt.json", LIMITS.receiptBytes, receipt.publicationReceiptSha256), publication = json(publicationRead);
  need(publication.schemaVersion === 1 && publication.status === "published" && publication.generation === receipt.generation
    && publication.pointerSha256 === receipt.pointerSha256 && publication.catalogSha256 === receipt.catalogSha256
    && SHA.test(publication.previousPointerSha256 || "") && publication.previousPointerSha256 === receipt.previousPointerSha256
    && publication.bundleDir === path.dirname(path.dirname(directory)) && publication.sourceProvenancePreserved === true
    && publication.originalEnvelopesRewritten === false && publication.providerCalls === 0 && publication.collectorStarted === false
    && publication.kosisReadOrChanged === false && iso(publication.fixedValidationClock), "PUBLICATION_MISMATCH");
  const catalogRead = await add("catalog.json", LIMITS.catalogBytes, receipt.catalogSha256), catalog = validateCatalog(json(catalogRead));
  const pointer = { schemaVersion: 1, generation: receipt.generation, catalogSha256: receipt.catalogSha256, catalogBytes: catalogRead.bytes.length, publishedAt: publication.fixedValidationClock };
  need(hash(JSON.stringify(pointer)) === receipt.pointerSha256, "PUBLICATION_MISMATCH");
  const dir = async relative => { need(!directories.has(relative), "GENERATION_DUPLICATE_DIRECTORY"); directories.set(relative, await checked(path.join(directory, relative), true)); };
  await dir("partitions");
  for (const part of catalog.partitions) {
    const prefix = path.join("partitions", part.key); await dir(prefix); await dir(path.join(prefix, "projections"));
    const index = json(await add(path.join(prefix, "index.json"), LIMITS.indexBytes, part.indexSha256, part.indexBytes));
    need(index.schemaVersion === 1 && index.calculationVersion === "keyword-monthly-v1" && Array.isArray(index.keywords) && index.keywords.length <= 4096, "INDEX_INVALID");
    for (const keyword of index.keywords) {
      need(Array.isArray(keyword.scopes) && keyword.scopes.length <= 4096, "INDEX_INVALID");
      for (const scope of keyword.scopes) {
        need(SHA.test(scope.scopeKey || "") && SHA.test(scope.sha256 || "") && Number.isSafeInteger(scope.bytes) && scope.bytes > 0
          && scope.bytes <= LIMITS.projectionBytes && [undefined, "gzip"].includes(scope.encoding), "INDEX_INVALID");
        await add(path.join(prefix, "projections", `${scope.scopeKey}.json${scope.encoding === "gzip" ? ".gz" : ""}`), LIMITS.projectionBytes, scope.sha256, scope.bytes);
      }
    }
  }
  async function visit(relative) {
    const target = path.join(directory, relative), before = await checked(target, true), entries = await fs.readdir(target, { withFileTypes: true });
    need(entries.length <= LIMITS.generationFiles, "GENERATION_BOUND");
    for (const entry of entries) {
      const child = path.join(relative, entry.name);
      need(!entry.isSymbolicLink() && (files.has(child) && entry.isFile() || directories.has(child) && entry.isDirectory()), "GENERATION_UNKNOWN_ENTRY");
      if (entry.isDirectory()) await visit(child); else need(same(files.get(child).stat, await checked(path.join(directory, child))), "EVIDENCE_CHANGED");
    }
    need(same(before, await checked(target, true)) && same(directories.get(relative), before), "EVIDENCE_CHANGED");
  }
  await visit(""); return { generation: receipt.generation, directory, files, directories, totalBytes, publicationClock: publication.fixedValidationClock };
}
async function pruneKeywordMonthlyRefreshGenerations({ projectionDir, expectedCurrentPointerSha256, keepSuccessfulAuto = 2, assertLeaseHeld, fixture = false } = {}) {
  need(typeof projectionDir === "string" && path.isAbsolute(projectionDir) && path.resolve(projectionDir) === projectionDir
    && path.basename(projectionDir) === "keyword_monthly_analysis" && SHA.test(expectedCurrentPointerSha256 || "")
    && Number.isSafeInteger(keepSuccessfulAuto) && keepSuccessfulAuto >= 2 && keepSuccessfulAuto <= 4 && typeof assertLeaseHeld === "function", "OPTIONS_INVALID");
  need(process.platform === "linux" || fixture === true, "LINUX_REQUIRED"); need(await assertLeaseHeld() === true, "LEASE_NOT_HELD");
  const rootStamp = await checked(projectionDir, true), generations = path.join(projectionDir, "generations"), generationsStamp = await checked(generations, true);
  const pointerFile = path.join(projectionDir, "current.json"), receiptDir = path.join(projectionDir, "refresh-receipts"), lockFile = path.join(projectionDir, "publish.lock");
  const token = crypto.randomUUID(), lockBytes = Buffer.from(JSON.stringify({ schemaVersion: 1, kind: "keyword_monthly_auto_retention", token }));
  let lock; try { lock = await fs.open(lockFile, "wx", 0o600); } catch (error) { if (error.code === "EEXIST") need(false, "PUBLICATION_LOCKED"); throw error; }
  let lockStamp;
  try {
    await lock.writeFile(lockBytes); await lock.sync(); lockStamp = await lock.stat();
    const initial = await read(pointerFile, 16384), current = validatePointer(json(initial));
    need(initial.sha256 === expectedCurrentPointerSha256, "POINTER_CHANGED");
    const catalogRead = await read(path.join(generations, current.generation, "catalog.json"), LIMITS.catalogBytes);
    need(catalogRead.sha256 === current.catalogSha256 && catalogRead.bytes.length === current.catalogBytes, "CURRENT_CATALOG_MISMATCH"); validateCatalog(json(catalogRead));
    const receipts = await completedReceipts(receiptDir, fixture), seen = new Map(), plans = [], alreadyAbsent = []; let auditedAutoBytes = 0;
    for (const receipt of receipts) {
      need(!seen.has(receipt.generation), "GENERATION_OWNERSHIP_CONFLICT"); seen.set(receipt.generation, receipt);
      const plan = await auditGeneration(path.join(generations, receipt.generation), receipt);
      if (plan) { auditedAutoBytes += plan.totalBytes; need(auditedAutoBytes <= LIMITS.auditedAutoBytes, "GENERATION_BOUND"); plans.push(plan); } else alreadyAbsent.push(receipt.generation);
    }
    plans.sort((a, b) => Date.parse(b.publicationClock) - Date.parse(a.publicationClock) || b.generation.localeCompare(a.generation));
    const keep = new Set(plans.slice(0, keepSuccessfulAuto).map(plan => plan.generation)); keep.add(current.generation);
    const remove = plans.filter(plan => !keep.has(plan.generation)), deleted = [];
    const guard = async () => {
      need(await assertLeaseHeld() === true, "LEASE_NOT_HELD");
      need(identity(rootStamp, await checked(projectionDir, true)) && identity(generationsStamp, await checked(generations, true)), "PARENT_CHANGED");
      need((await read(pointerFile, 16384)).sha256 === initial.sha256, "POINTER_CHANGED");
      const held = await read(lockFile, 16384); need(identity(lockStamp, held.stat) && held.sha256 === hash(lockBytes), "LOCK_CHANGED");
    };
    await guard();
    // Linux uses open directory descriptors as deletion anchors; no pathname
    // supplied by a receipt is followed, and fs.rm({recursive:true}) is not used.
    const opened = [];
    const openDir = async (absolute, expected, parentHandle, basename) => {
      need(identity(expected, await checked(absolute, true)), "EVIDENCE_CHANGED");
      if (process.platform !== "linux") return null; // Explicit, local fixtures only.
      const file = parentHandle ? `/proc/self/fd/${parentHandle.fd}/${basename}` : absolute;
      const handle = await fs.open(file, native.constants.O_RDONLY | native.constants.O_DIRECTORY | native.constants.O_NOFOLLOW);
      opened.push(handle); need(identity(expected, await handle.stat()), "EVIDENCE_CHANGED"); return handle;
    };
    const anchor = (handle, absolute, name) => handle ? `/proc/self/fd/${handle.fd}/${name}` : path.join(absolute, name);
    let generationHandle;
    try {
      generationHandle = await openDir(generations, generationsStamp);
      for (const plan of remove) {
        await guard(); need(plan.generation !== current.generation && GEN.test(plan.generation), "CURRENT_GENERATION_FORBIDDEN");
        const rootHandle = await openDir(plan.directory, plan.directories.get(""), generationHandle, plan.generation);
        async function removeDirectory(relative, handle) {
          const absolute = path.join(plan.directory, relative), entries = await fs.readdir(handle ? `/proc/self/fd/${handle.fd}` : absolute, { withFileTypes: true });
          need(entries.every(entry => !entry.isSymbolicLink() && (entry.isDirectory() && plan.directories.has(path.join(relative, entry.name)) || entry.isFile() && plan.files.has(path.join(relative, entry.name)))), "GENERATION_UNKNOWN_ENTRY");
          for (const entry of entries) {
            const child = path.join(relative, entry.name), target = path.join(plan.directory, child), targetAnchor = anchor(handle, absolute, entry.name);
            if (entry.isDirectory()) {
              const expected = plan.directories.get(child), childHandle = await openDir(target, expected, handle, entry.name);
              await removeDirectory(child, childHandle); need(identity(expected, await checked(target, true)), "EVIDENCE_CHANGED");
              if (childHandle) { await childHandle.close(); opened.splice(opened.indexOf(childHandle), 1); }
              await guard(); await fs.rmdir(targetAnchor);
            } else {
              const expected = plan.files.get(child); need(same(expected.stat, await checked(target)), "EVIDENCE_CHANGED");
              const handleFile = await fs.open(targetAnchor, native.constants.O_RDONLY | native.constants.O_NOFOLLOW);
              try { need(same(expected.stat, await handleFile.stat()), "EVIDENCE_CHANGED"); } finally { await handleFile.close(); }
              await guard(); need(same(expected.stat, await fs.lstat(targetAnchor)), "EVIDENCE_CHANGED"); await fs.unlink(targetAnchor);
            }
          }
          need(identity(plan.directories.get(relative), await checked(absolute, true)), "EVIDENCE_CHANGED");
        }
        await removeDirectory("", rootHandle);
        if (rootHandle) { await rootHandle.close(); opened.splice(opened.indexOf(rootHandle), 1); }
        await guard(); need(identity(plan.directories.get(""), await checked(plan.directory, true)), "EVIDENCE_CHANGED");
        await fs.rmdir(anchor(generationHandle, generations, plan.generation)); deleted.push({ generation: plan.generation, bytes: plan.totalBytes });
      }
    } finally { for (const handle of opened.reverse()) await handle.close().catch(() => {}); }
    await guard();
    return { schemaVersion: 1, status: "complete", currentGeneration: current.generation, currentPointerSha256: initial.sha256,
      keptSuccessfulAuto: plans.filter(plan => keep.has(plan.generation)).map(plan => plan.generation), keepSuccessfulAuto, deleted,
      alreadyAbsent, deletedBytes: deleted.reduce((total, row) => total + row.bytes, 0), ownCompletedReceiptCount: receipts.length,
      manualAndForeignGenerationsPreserved: true, completionProofReceiptsRemoved: 0, operatingPointerChanged: false, originalWrites: 0, providerCalls: 0 };
  } finally {
    await lock.close();
    if (lockStamp) { const saved = await read(lockFile, 16384); need(identity(lockStamp, saved.stat) && saved.sha256 === hash(lockBytes), "LOCK_CHANGED"); await fs.unlink(lockFile); }
  }
}
module.exports = { pruneKeywordMonthlyRefreshGenerations, KEYWORD_MONTHLY_RETENTION_LIMITS: LIMITS };
