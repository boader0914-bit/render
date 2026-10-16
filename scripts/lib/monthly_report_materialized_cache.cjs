"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { performance } = require("node:perf_hooks");

const digest = value => crypto.createHash("sha256").update(value).digest("hex");
const copy = value => JSON.parse(JSON.stringify(value));
const changed = () => Object.assign(new Error("집계 중 저장 자료가 변경되었습니다. 기존 저장본은 보존했으며, 다시 미리보기해 주세요."), { code: "MONTHLY_SOURCE_CHANGED", statusCode: 409 });

// Derived calculations only. Issued reports and approved preview tokens never
// read this cache. A failed replacement must leave the last complete file intact.
function createMonthlyReportMaterializedCache({ directory, maxEntries = 64, maxBytes = 64 * 1024 * 1024, maxEntryBytes = Math.min(32 * 1024 * 1024, maxBytes) } = {}) {
  if (!directory) throw new TypeError("A materialized cache directory is required");
  if (![maxEntries, maxBytes, maxEntryBytes].every(value => Number.isSafeInteger(value) && value > 0) || maxEntryBytes > maxBytes) throw new TypeError("Invalid materialized cache limits");
  const inFlight = new Map();
  async function revision(readRevision) {
    const value = await readRevision();
    if (typeof value !== "string" || !value || value.length > 512) throw Object.assign(new Error("저장 자료의 변경 여부를 확인하지 못했습니다."), { code: "MONTHLY_SOURCE_REVISION_UNAVAILABLE", statusCode: 503 });
    return value;
  }
  async function read(file, key, sourceRevision) {
    try {
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxEntryBytes) return null;
      const entry = JSON.parse(await fs.readFile(file, "utf8"));
      if (entry.schemaVersion !== 1 || entry.key !== key || entry.sourceRevision !== sourceRevision
        || !entry.value || entry.valueHash !== digest(JSON.stringify(entry.value))) return null;
      return entry;
    } catch { return null; } // An invalid derived file is a miss, never a zero.
  }
  async function trim(keep) {
    const names = (await fs.readdir(directory)).filter(name => /^[a-f0-9]{64}\.json$/.test(name));
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
      await fs.mkdir(directory, { recursive: true });
      const handle = await fs.open(temp, "wx");
      try { await handle.writeFile(serialized, "utf8"); await handle.sync(); }
      finally { await handle.close(); }
      await fs.rename(temp, file);
      await trim(file).catch(() => {});
      return "saved";
    } catch { return "failed"; }
    finally { await fs.unlink(temp).catch(() => {}); }
  }
  async function getOrBuild({ key, readRevision, build }) {
    const started = performance.now(), keyHash = digest(key), file = path.join(directory, `${keyHash}.json`);
    if (inFlight.has(keyHash)) {
      const result = await inFlight.get(keyHash);
      if (await revision(readRevision) !== result.sourceRevision) throw changed();
      return { ...result, value: copy(result.value), status: "coalesced", timings: { sharedWaitMs: performance.now() - started } };
    }
    // Include the revision scan and disk lookup in the flight. Otherwise a slow
    // miss can resume just after a fast build failed and accidentally start it
    // again, even though both callers requested the same work concurrently.
    const work = (async () => {
      const sourceRevision = await revision(readRevision), revisionCheckMs = performance.now() - started;
      const reading = performance.now(), saved = await read(file, key, sourceRevision);
      const cacheReadMs = performance.now() - reading;
      if (saved) {
        if (await revision(readRevision) !== sourceRevision) throw changed();
        await fs.utimes(file, new Date(), new Date()).catch(() => {});
        return { value: copy(saved.value), sourceRevision, status: "reused", calculatedAt: saved.calculatedAt,
          storage: "saved", timings: { revisionCheckMs, cacheReadMs } };
      }
      const value = await build();
      if (await revision(readRevision) !== sourceRevision) throw changed();
      const calculatedAt = new Date().toISOString();
      const entry = { schemaVersion: 1, key, sourceRevision, calculatedAt, value: copy(value), valueHash: digest(JSON.stringify(value)) };
      const writing = performance.now(), storage = await write(file, entry);
      return { value: copy(entry.value), sourceRevision, status: "calculated", calculatedAt, storage,
        timings: { revisionCheckMs, cacheReadMs, cacheWriteMs: performance.now() - writing } };
    })();
    inFlight.set(keyHash, work);
    try { const result = await work; return { ...result, value: copy(result.value) }; }
    finally { if (inFlight.get(keyHash) === work) inFlight.delete(keyHash); }
  }
  return { getOrBuild };
}

module.exports = { createMonthlyReportMaterializedCache };
