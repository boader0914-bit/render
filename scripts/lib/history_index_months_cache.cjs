"use strict";

// A bounded derived selector cache, never an observation/index substitute.
// The owner verifies the live index and original source before AND after this
// call. A cache miss still runs the exact existing read-only month query.
const fs = require("node:fs/promises"), native = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const VERSION = "history-index-exact-months-cache-v1", LIMIT = 2 * 1024 * 1024;
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const signature = stat => `${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}:${stat.ino}:${stat.dev}:${stat.nlink}`;
const validMonths = values => {
  if (!Array.isArray(values) || values.length > 120000) return false;
  for (let index = 0; index < values.length; index++) if (!Object.hasOwn(values, index) || typeof values[index] !== "string"
    || !/^\d{4}-(0[1-9]|1[0-2])$/.test(values[index]) || index > 0 && values[index - 1] <= values[index]) return false;
  return true;
};
const plain = value => value !== null && typeof value === "object" && !Array.isArray(value);
const inputKey = input => hash(JSON.stringify([VERSION, input.expectedSignature, input.sourceFingerprint, input.queryFingerprint]));

function createHistoryIndexMonthsCache({ fileSystem = fs } = {}) {
  const counters = { hits: 0, misses: 0, saved: 0, writeFailures: 0 };
  const samePath = (a, b) => process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
  async function destinationSafe(file, sourceFile) {
    // This cache must never occupy the authoritative source name, including
    // an alias through a parent directory. Unknown paths disable caching.
    try {
      if (samePath(file, sourceFile)) return false;
      const parent = path.dirname(file), parentStat = await fileSystem.lstat(parent);
      if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) return false;
      const realParent = await fileSystem.realpath(parent), sourceParent = await fileSystem.realpath(path.dirname(sourceFile));
      if (!samePath(realParent, parent) || samePath(path.join(realParent, path.basename(file)), path.join(sourceParent, path.basename(sourceFile)))) return false;
      let realSource = path.join(sourceParent, path.basename(sourceFile));
      try { realSource = await fileSystem.realpath(sourceFile); } catch (error) { if (error.code !== "ENOENT") return false; }
      if (samePath(path.join(realParent, path.basename(file)), realSource)) return false;
      try { if (samePath(await fileSystem.realpath(file), realSource)) return false; } catch (error) { if (error.code !== "ENOENT") return false; }
      return true;
    } catch { return false; }
  }
  async function read(file, key) {
    let handle;
    try {
      const before = await fileSystem.lstat(file, { bigint: true });
      if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size > BigInt(LIMIT)) return null;
      handle = await fileSystem.open(file, native.constants.O_RDONLY | (native.constants.O_NOFOLLOW || 0));
      const opened = await handle.stat({ bigint: true });
      if (!opened.isFile() || signature(opened) !== signature(before)) return null;
      const bytes = Buffer.alloc(Number(before.size) + 1);
      let length = 0;
      while (length < bytes.length) {
        const part = await handle.read(bytes, length, bytes.length - length, null);
        if (!part.bytesRead) break;
        length += part.bytesRead;
      }
      const completed = await handle.stat({ bigint: true }), after = await fileSystem.lstat(file, { bigint: true });
      if (BigInt(length) !== before.size || signature(completed) !== signature(before) || signature(after) !== signature(before)
        || !after.isFile() || after.isSymbolicLink()) return null;
      const entry = JSON.parse(bytes.subarray(0, length).toString("utf8"));
      if (!plain(entry) || Object.keys(entry).sort().join(",") !== "key,months,monthsSha256,version" || entry.version !== VERSION
        || entry.key !== key || !validMonths(entry.months) || entry.monthsSha256 !== hash(JSON.stringify(entry.months))) return null;
      return entry.months;
    } catch { return null; }
    finally { if (handle) await handle.close().catch(() => {}); }
  }
  async function write(file, key, months) {
    const bytes = Buffer.from(JSON.stringify({ version: VERSION, key, months, monthsSha256: hash(JSON.stringify(months)) }));
    if (bytes.length > LIMIT) return;
    const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
    let created = false;
    try {
      // Rename replaces a cache entry, never follows a prior symlink/hardlink.
      // A failed replacement leaves the last complete selector intact.
      const handle = await fileSystem.open(temp, "wx", 0o600); created = true;
      try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
      await fileSystem.rename(temp, file); created = false; counters.saved++;
    } catch { counters.writeFailures++; }
    finally { if (created) await fileSystem.unlink(temp).catch(() => {}); }
  }
  async function getOrRead({ indexFile, sourceFile, expectedSignature, sourceFingerprint, queryFingerprint, query } = {}) {
    if (typeof indexFile !== "string" || !path.isAbsolute(indexFile) || path.resolve(indexFile) !== indexFile
      || typeof sourceFile !== "string" || !path.isAbsolute(sourceFile) || path.resolve(sourceFile) !== sourceFile
      || typeof expectedSignature !== "string" || !expectedSignature || expectedSignature.length > 300
      || !/^[a-f0-9]{64}$/.test(sourceFingerprint || "") || !/^[a-f0-9]{64}$/.test(queryFingerprint || "")
      || typeof query !== "function") throw TypeError("Invalid exact month cache input");
    const file = indexFile + ".months-v1.json", key = inputKey({ expectedSignature, sourceFingerprint, queryFingerprint });
    const safe = await destinationSafe(file, sourceFile);
    const saved = safe ? await read(file, key) : null;
    if (saved !== null) { counters.hits++; return saved.slice(); }
    counters.misses++;
    const months = await query();
    if (!validMonths(months)) throw Object.assign(Error("HISTORY_OBSERVATION_INDEX_INVALID"), { code: "HISTORY_OBSERVATION_INDEX_INVALID", statusCode: 503 });
    if (safe && await destinationSafe(file, sourceFile)) await write(file, key, months);
    return months.slice();
  }
  return Object.freeze({ getOrRead, status: () => ({ ...counters }) });
}

module.exports = { createHistoryIndexMonthsCache };
