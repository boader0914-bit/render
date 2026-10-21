"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");

const RUN_DIRECTORY = /_glamping_\d{8}(?:_\d{6})?$/;
const MAX_SCANNED_ENTRIES = 100000;
const DEFAULT_CACHE_ENTRIES = 2048;
const DEFAULT_CACHE_BYTES = 16 * 1024 * 1024;
const fault = code => Object.assign(new Error(code), { code, statusCode: 503 });
// Callbacks used by the server's isolated VM tests can return ordinary objects
// from another realm. Object identity against this realm's prototype rejects
// those valid JSON projections; the tag plus constructor name accepts them.
const plain = value => value !== null && typeof value === "object" && !Array.isArray(value)
  && Object.prototype.toString.call(value) === "[object Object]"
  && (Object.getPrototypeOf(value) === null || Object.getPrototypeOf(value)?.constructor?.name === "Object");
const signature = stat => [stat.size, stat.mtimeNs ?? stat.mtimeMs, stat.ctimeNs ?? stat.ctimeMs, stat.ino, stat.dev, stat.mode].join(":");

// Read-only, process-local catalog. Every lookup checks the shallow inventory
// and directory/manifest identities. Only unchanged projections are reused;
// reads never start a collector, update originals or run derived processing.
// A scan error is thrown, not converted to an empty or silently stale catalog.
function createRunCatalog({ outputsDir, readManifest, projectRun, isIncompleteRunDirectory,
  fileSystem = fs, concurrency = 8, maxCacheEntries = DEFAULT_CACHE_ENTRIES,
  maxCacheBytes = DEFAULT_CACHE_BYTES } = {}) {
  if (typeof outputsDir !== "string" || !outputsDir || typeof readManifest !== "function"
    || typeof projectRun !== "function" || typeof isIncompleteRunDirectory !== "function") throw new TypeError("Run catalog inputs are required");
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 32
    || !Number.isSafeInteger(maxCacheEntries) || maxCacheEntries < 0 || maxCacheEntries > MAX_SCANNED_ENTRIES
    || !Number.isSafeInteger(maxCacheBytes) || maxCacheBytes < 0 || maxCacheBytes > 64 * 1024 * 1024) throw new TypeError("Invalid run catalog limits");
  const root = path.resolve(outputsDir);
  let cache = new Map(), cacheBytes = 0, epoch = 0, pending = null;
  const counters = { scans: 0, reusedEntries: 0, changedEntries: 0, manifestReads: 0, directoryReads: 0, failures: 0, clears: 0 };

  async function stat(file, optional = false) {
    try { return await fileSystem.lstat(file, { bigint: true }); }
    catch (error) {
      if (optional && error.code === "ENOENT") return null;
      throw fault("RUN_CATALOG_SOURCE_UNAVAILABLE");
    }
  }
  function requireDirectory(value) {
    if (!value?.isDirectory() || value.isSymbolicLink()) throw fault("RUN_CATALOG_SOURCE_INVALID");
  }
  function requireManifest(value) {
    if (value && (!value.isFile() || value.isSymbolicLink())) throw fault("RUN_CATALOG_MANIFEST_INVALID");
  }
  function same(before, after) { return before === null ? after === null : after !== null && signature(before) === signature(after); }
  async function inspectEntry(entry, previous) {
    const directory = path.join(root, entry.name), manifestFile = path.join(directory, "manifest.json");
    const beforeDirectory = await stat(directory);
    requireDirectory(beforeDirectory);
    const beforeManifest = await stat(manifestFile, true);
    requireManifest(beforeManifest);
    const stamp = signature(beforeDirectory) + "|" + (beforeManifest ? signature(beforeManifest) : "missing");
    // Legacy visibility depends on direct output names, and a cached null row
    // can become visible as files arrive. Windows can report identical parent
    // metadata for a rapid create/delete, so never certify those cases from
    // metadata alone. Re-read their shallow file list on every lookup.
    if (beforeManifest && previous?.stamp === stamp && previous.json !== "null") {
      counters.reusedEntries++;
      return previous;
    }
    counters.changedEntries++;
    let files;
    try { files = await fileSystem.readdir(directory); counters.directoryReads++; }
    catch { throw fault("RUN_CATALOG_SOURCE_UNAVAILABLE"); }
    if (!Array.isArray(files) || files.length > MAX_SCANNED_ENTRIES || files.some(name => typeof name !== "string")) throw fault("RUN_CATALOG_SOURCE_INVALID");
    let manifest = null;
    if (beforeManifest) {
      try { manifest = await readManifest(directory); counters.manifestReads++; }
      catch { throw fault("RUN_CATALOG_MANIFEST_UNREADABLE"); }
      // Missing legacy manifests are valid. A present unreadable/corrupt file
      // must not silently downgrade recorded collection quality to legacy.
      if (!plain(manifest)) throw fault("RUN_CATALOG_MANIFEST_UNREADABLE");
    }
    let row = null;
    if ((manifest || files.length) && !isIncompleteRunDirectory(manifest, files)) {
      row = await projectRun({ id: entry.name, manifest, files: [...files], stat: beforeDirectory });
      if (row !== null && row !== undefined && (!plain(row) || row.id !== entry.name)) throw fault("RUN_CATALOG_PROJECTION_INVALID");
    }
    const afterManifest = await stat(manifestFile, true), afterDirectory = await stat(directory);
    requireManifest(afterManifest); requireDirectory(afterDirectory);
    if (!same(beforeManifest, afterManifest) || !same(beforeDirectory, afterDirectory)) throw fault("RUN_CATALOG_CHANGED_DURING_SCAN");
    let json;
    try { json = JSON.stringify(row ?? null); }
    catch { throw fault("RUN_CATALOG_PROJECTION_INVALID"); }
    // Keep only the compact public projection, never a manifest/product body.
    return { stamp, json, bytes: Buffer.byteLength(json) + Buffer.byteLength(entry.name) + Buffer.byteLength(stamp) };
  }
  async function scan() {
    counters.scans++;
    const scanEpoch = epoch, before = await stat(root);
    requireDirectory(before);
    let all;
    try { all = await fileSystem.readdir(root, { withFileTypes: true }); }
    catch { throw fault("RUN_CATALOG_SOURCE_UNAVAILABLE"); }
    if (!Array.isArray(all) || all.length > MAX_SCANNED_ENTRIES) throw fault("RUN_CATALOG_SOURCE_INVALID");
    const entries = all.filter(entry => {
      if (!RUN_DIRECTORY.test(entry.name)) return false;
      if (entry.isSymbolicLink()) throw fault("RUN_CATALOG_SOURCE_INVALID");
      return entry.isDirectory();
    }).sort((a, b) => a.name.localeCompare(b.name));
    const inspected = new Array(entries.length);
    let next = 0;
    const workers = Array.from({ length: Math.min(concurrency, entries.length) }, async () => {
      while (next < entries.length) {
        const index = next++, entry = entries[index];
        inspected[index] = await inspectEntry(entry, cache.get(entry.name));
      }
    });
    // Finish the bounded workers before releasing the single flight even if
    // one fails, so a second scan cannot overlap abandoned first-scan work.
    const finished = await Promise.allSettled(workers);
    const failure = finished.find(result => result.status === "rejected");
    if (failure) throw failure.reason;
    const after = await stat(root);
    requireDirectory(after);
    if (!same(before, after) || scanEpoch !== epoch) throw fault("RUN_CATALOG_CHANGED_DURING_SCAN");
    const nextCache = new Map();
    let bytes = 0;
    for (let index = 0; index < entries.length; index++) {
      const value = inspected[index];
      if (nextCache.size < maxCacheEntries && bytes + value.bytes <= maxCacheBytes) {
        nextCache.set(entries[index].name, value); bytes += value.bytes;
      }
    }
    cache = nextCache; cacheBytes = bytes;
    // Per-call parsing below means consumers can never mutate these strings.
    return inspected.map(value => value.json).filter(json => json !== "null");
  }
  function list() {
    if (!pending) pending = scan().catch(error => {
      counters.failures++;
      if (/^RUN_CATALOG_/.test(error?.code || "")) throw error;
      throw fault("RUN_CATALOG_SOURCE_UNAVAILABLE");
    }).finally(() => { pending = null; });
    return pending.then(values => values.map(value => JSON.parse(value)).sort((a, b) =>
      String(b.collectedAt || "").localeCompare(String(a.collectedAt || ""))
      || String(b.id || "").localeCompare(String(a.id || ""))));
  }
  function clear(runId) {
    epoch++; counters.clears++;
    if (runId === undefined) { cache = new Map(); cacheBytes = 0; }
    else if (cache.has(runId)) { cacheBytes -= cache.get(runId).bytes; cache.delete(runId); }
  }
  return { list, clear, stats: () => ({ ...counters, cacheEntries: cache.size, cacheBytes, scanning: Boolean(pending) }) };
}

module.exports = { createRunCatalog };
