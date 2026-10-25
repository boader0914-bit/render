"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { performance } = require("node:perf_hooks");
const { gzipSync, gunzipSync, constants: zlibConstants } = require("node:zlib");

const digest = value => crypto.createHash("sha256").update(value).digest("hex");
const copy = value => JSON.parse(JSON.stringify(value));
const changed = () => Object.assign(new Error("집계 중 저장 자료가 변경되었습니다. 기존 저장본은 보존했으며, 다시 미리보기해 주세요."), { code: "MONTHLY_SOURCE_CHANGED", statusCode: 409 });

// Derived calculations only. Issued reports and approved preview tokens never
// read this cache. A failed replacement must leave the last complete file intact.
function createMonthlyReportMaterializedCache({ directory, maxEntries = 64, maxBytes = 64 * 1024 * 1024,
  maxEntryBytes = Math.min(32 * 1024 * 1024, maxBytes), compression = null } = {}) {
  if (!directory) throw new TypeError("A materialized cache directory is required");
  if (![maxEntries, maxBytes, maxEntryBytes].every(value => Number.isSafeInteger(value) && value > 0) || maxEntryBytes > maxBytes) throw new TypeError("Invalid materialized cache limits");
  if (compression !== null && compression !== "gzip") throw new TypeError("Invalid materialized cache compression");
  const suffix = compression === "gzip" ? ".json.gz" : ".json";
  // A compressed namespace also accounts for its old derived JSON units during
  // migration, so enabling compression cannot temporarily double its budget.
  const entryName = compression === "gzip" ? /^[a-f0-9]{64}\.json(?:\.gz)?$/ : /^[a-f0-9]{64}\.json$/;
  const inFlight = new Map();
  async function revision(readRevision) {
    const value = await readRevision();
    if (typeof value !== "string" || !value || value.length > 512) throw Object.assign(new Error("저장 자료의 변경 여부를 확인하지 못했습니다."), { code: "MONTHLY_SOURCE_REVISION_UNAVAILABLE", statusCode: 503 });
    return value;
  }
  async function read(file, key) {
    try {
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxEntryBytes) return null;
      let serialized;
      if (compression === "gzip") {
        const encoded = await fs.readFile(file);
        if (encoded.length > maxEntryBytes) return null;
        // The decoded bound is independent of the disk compression ratio. A
        // corrupt or oversized compressed file is a miss, never trusted data.
        serialized = gunzipSync(encoded, { maxOutputLength: maxEntryBytes }).toString("utf8");
      } else serialized = await fs.readFile(file, "utf8");
      const entry = JSON.parse(serialized);
      if (entry.schemaVersion !== 1 || entry.key !== key
        || typeof entry.sourceRevision !== "string" || !entry.sourceRevision || entry.sourceRevision.length > 512
        || !entry.value || entry.valueHash !== digest(JSON.stringify(entry.value))) return null;
      return entry;
    } catch { return null; } // An invalid derived file is a miss, never a zero.
  }
  async function trim(keep) {
    const names = (await fs.readdir(directory)).filter(name => entryName.test(name));
    const rows = (await Promise.all(names.map(async name => {
      const file = path.join(directory, name), stat = await fs.lstat(file).catch(() => null);
      return stat?.isFile() && !stat.isSymbolicLink() ? { file, bytes: stat.size, time: stat.mtimeMs } : null;
    }))).filter(Boolean).sort((a, b) => a.file === keep ? -1 : b.file === keep ? 1 : b.time - a.time);
    let count = 0, bytes = 0;
    for (const row of rows) {
      if (count + 1 > maxEntries || bytes + row.bytes > maxBytes) await fs.unlink(row.file).catch(() => {});
      else { count++; bytes += row.bytes; }
    }
  }
  async function write(file, entry) {
    const serialized = JSON.stringify(entry);
    if (Buffer.byteLength(serialized) > maxEntryBytes) return "too_large";
    const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
      const encoded = compression === "gzip" ? gzipSync(serialized, { level: zlibConstants.Z_BEST_SPEED }) : serialized;
      if (compression === "gzip" && encoded.length > maxEntryBytes) return "too_large";
      await fs.mkdir(directory, { recursive: true });
      const handle = await fs.open(temp, "wx");
      try { await handle.writeFile(encoded, "utf8"); await handle.sync(); }
      finally { await handle.close(); }
      await fs.rename(temp, file);
      await trim(file).catch(() => {});
      return "saved";
    } catch { return "failed"; }
    finally { await fs.unlink(temp).catch(() => {}); }
  }
  async function getOrBuild({ key, readRevision, build }) {
    const started = performance.now(), keyHash = digest(key), file = path.join(directory, `${keyHash}${suffix}`);
    if (inFlight.has(keyHash)) {
      const result = await inFlight.get(keyHash);
      if (await revision(readRevision) !== result.sourceRevision) throw changed();
      return { ...result, value: copy(result.value), status: "coalesced", timings: { sharedWaitMs: performance.now() - started } };
    }
    // Include the disk lookup and revision scan in the flight. Otherwise a slow
    // miss can resume just after a fast build failed and accidentally start it
    // again, even though both callers requested the same work concurrently.
    const work = (async () => {
      const reading = performance.now(), saved = await read(file, key);
      const cacheReadMs = performance.now() - reading;
      // A saved value is independent of the current source read: first validate
      // its complete payload, then inspect sources afresh. Matching that saved
      // revision is enough to reuse it; no pre-read scan can add freshness to
      // the required scan after the payload was read. A miss still uses this
      // revision as the build's precondition and verifies it again afterward.
      const checking = performance.now(), sourceRevision = await revision(readRevision);
      const revisionCheckMs = performance.now() - checking;
      if (saved?.sourceRevision === sourceRevision) {
        await fs.utimes(file, new Date(), new Date()).catch(() => {});
        return { value: saved.value, sourceRevision, status: "reused", calculatedAt: saved.calculatedAt,
          storage: "saved", timings: { revisionCheckMs, cacheReadMs } };
      }
      const value = await build();
      if (await revision(readRevision) !== sourceRevision) throw changed();
      const calculatedAt = new Date().toISOString();
      const entry = { schemaVersion: 1, key, sourceRevision, calculatedAt, value: copy(value), valueHash: digest(JSON.stringify(value)) };
      const writing = performance.now(), storage = await write(file, entry);
      // The shared flight owns this value. Copy only at the caller boundary,
      // so a leader cannot mutate it while followers verify their own revision.
      return { value: entry.value, sourceRevision, status: "calculated", calculatedAt, storage,
        timings: { revisionCheckMs, cacheReadMs, cacheWriteMs: performance.now() - writing } };
    })();
    inFlight.set(keyHash, work);
    try { const result = await work; return { ...result, value: copy(result.value) }; }
    finally { if (inFlight.get(keyHash) === work) inFlight.delete(keyHash); }
  }
  return { getOrBuild };
}

module.exports = { createMonthlyReportMaterializedCache };
