"use strict";
// Inert until explicitly installed inside a verified isolated physical copy.
// No source, application, provider, configuration or storage writer is loaded.
const native = require("node:fs"), fs = require("node:fs/promises"), path = require("node:path"), crypto = require("node:crypto");
const zlib = require("node:zlib"), { Transform } = require("node:stream"), { pipeline } = require("node:stream/promises"), { fileURLToPath } = require("node:url");
const RELATIVE = "history/observations.jsonl", MAX_HISTORY_BYTES = 512 * 1024 ** 2, SHA = /^[a-f0-9]{64}$/;
let installed = false;
function fault(code) { return Object.assign(new Error(code), { code }); }
function need(value, code) { if (!value) throw fault(code); }
function installCompressedHistory(dataDir, capture) {
  need(!installed && typeof dataDir === "string" && path.isAbsolute(dataDir) && path.resolve(dataDir) === dataDir && capture?.dataDir === dataDir, "KEYWORD_COMPRESSED_HISTORY_SCOPE_INVALID");
  const rows = capture.inputFiles?.filter(row => row.relative === RELATIVE);
  need(capture.historyCompression === "gzip" && rows?.length === 1, "KEYWORD_COMPRESSED_HISTORY_MANIFEST_INVALID");
  const row = { ...rows[0] };
  need(row.compression === "gzip" && row.storageRelative === RELATIVE + ".gz" && Number.isSafeInteger(row.bytes) && row.bytes > 0 && row.bytes <= MAX_HISTORY_BYTES
    && Number.isSafeInteger(row.sourceBytes) && row.sourceBytes >= 0 && row.sourceBytes <= MAX_HISTORY_BYTES && SHA.test(row.sha256 || "") && SHA.test(row.sourceSha256 || ""), "KEYWORD_COMPRESSED_HISTORY_MANIFEST_INVALID");
  const logical = path.join(dataDir, ...RELATIVE.split("/")), storage = logical + ".gz", restorers = [];
  const lstat = native.lstatSync.bind(native), statBefore = lstat(storage);
  need(statBefore.isFile() && !statBefore.isSymbolicLink() && statBefore.nlink === 1 && statBefore.size === row.bytes, "KEYWORD_COMPRESSED_HISTORY_STORAGE_INVALID");
  for (const directory of [dataDir, path.dirname(storage)]) { const st = lstat(directory); need(st.isDirectory() && !st.isSymbolicLink(), "KEYWORD_COMPRESSED_HISTORY_STORAGE_INVALID"); }
  try { lstat(logical); throw fault("KEYWORD_COMPRESSED_HISTORY_RAW_PRESENT"); } catch (e) { if (e.code !== "ENOENT") throw e; }
  let streamsOpened = 0, streamsVerified = 0, failedStreams = 0, activeStreams = 0, restored = false;
  const exact = value => {
    if (typeof value === "number") return false;
    try { const text = value instanceof URL ? fileURLToPath(value) : Buffer.isBuffer(value) ? value.toString() : value; return typeof text === "string" && path.resolve(text) === logical; } catch { return false; }
  };
  const virtualStat = st => Object.assign(Object.create(Object.getPrototypeOf(st)), st, { size: typeof st.size === "bigint" ? BigInt(row.sourceBytes) : row.sourceBytes });
  function replace(object, name, value) { const previous = object[name]; object[name] = value; restorers.push(() => { object[name] = previous; }); }
  for (const name of ["stat", "lstat"]) {
    const previous = fs[name]; replace(fs, name, async (file, ...options) => exact(file) ? virtualStat(await previous(storage, ...options)) : previous(file, ...options));
    const previousSync = native[name + "Sync"]; replace(native, name + "Sync", (file, ...options) => exact(file) ? virtualStat(previousSync(storage, ...options)) : previousSync(file, ...options));
    const previousCallback = native[name]; replace(native, name, (file, ...options) => {
      if (!exact(file)) return previousCallback(file, ...options);
      const callback = options.pop(); need(typeof callback === "function", "KEYWORD_COMPRESSED_HISTORY_READ_UNSUPPORTED");
      return previousCallback(storage, ...options, (error, stat) => callback(error, error ? undefined : virtualStat(stat)));
    });
  }
  const oldAccess = fs.access; replace(fs, "access", (file, mode) => {
    if (!exact(file)) return oldAccess(file, mode);
    need(mode === undefined || mode === native.constants.F_OK || mode === native.constants.R_OK, "KEYWORD_COMPRESSED_HISTORY_READ_UNSUPPORTED"); return oldAccess(storage, mode);
  });
  for (const [object, names] of [[fs, ["readFile", "open"]], [native, ["readFile", "readFileSync", "open", "openSync"]]]) {
    for (const name of names) { const previous = object[name]; replace(object, name, (file, ...options) => { need(!exact(file), "KEYWORD_COMPRESSED_HISTORY_READ_UNSUPPORTED"); return previous(file, ...options); }); }
  }
  const oldStream = native.createReadStream;
  replace(native, "createReadStream", (file, options = {}) => {
    if (!exact(file)) return oldStream(file, options);
    if (typeof options === "string") options = { encoding: options };
    need(options && typeof options === "object" && !["fd", "start", "end"].some(key => Object.hasOwn(options, key)) && (!options.flags || options.flags === "r")
      && (!options.encoding || Buffer.isEncoding(options.encoding)), "KEYWORD_COMPRESSED_HISTORY_READ_UNSUPPORTED");
    const before = lstat(storage);
    need(before.isFile() && !before.isSymbolicLink() && before.nlink === 1 && before.size === row.bytes && before.ino === statBefore.ino && before.dev === statBefore.dev
      && before.mtimeMs === statBefore.mtimeMs && before.ctimeMs === statBefore.ctimeMs, "KEYWORD_COMPRESSED_HISTORY_STORAGE_CHANGED");
    streamsOpened++; activeStreams++; let finished = false, storedBytes = 0, sourceBytes = 0;
    const storedHash = crypto.createHash("sha256"), sourceHash = crypto.createHash("sha256");
    function finish(ok) { if (finished) return; finished = true; activeStreams--; if (ok) streamsVerified++; else failedStreams++; }
    const storedValidator = new Transform({ transform(chunk, encoding, callback) {
      storedBytes += chunk.length; if (storedBytes > row.bytes) return callback(fault("KEYWORD_COMPRESSED_HISTORY_STORED_MISMATCH")); storedHash.update(chunk); callback(null, chunk);
    }, flush(callback) { if (storedBytes !== row.bytes || storedHash.digest("hex") !== row.sha256) callback(fault("KEYWORD_COMPRESSED_HISTORY_STORED_MISMATCH")); else callback(); } });
    const output = new Transform({ transform(chunk, encoding, callback) {
      sourceBytes += chunk.length; if (sourceBytes > row.sourceBytes || sourceBytes > MAX_HISTORY_BYTES) return callback(fault("KEYWORD_COMPRESSED_HISTORY_EXPANDED_BOUND")); sourceHash.update(chunk); callback(null, chunk);
    }, flush(callback) {
      try {
        const after = lstat(storage);
        need(sourceBytes === row.sourceBytes && sourceHash.digest("hex") === row.sourceSha256 && after.size === before.size && after.ino === before.ino && after.dev === before.dev
          && after.mtimeMs === before.mtimeMs && after.ctimeMs === before.ctimeMs && after.nlink === 1 && !after.isSymbolicLink(), "KEYWORD_COMPRESSED_HISTORY_SOURCE_MISMATCH");
        finish(true); callback();
      } catch (error) { callback(error); }
    } });
    if (options.encoding) output.setEncoding(options.encoding);
    const input = oldStream(storage, { highWaterMark: 64 * 1024, ...(options.signal ? { signal: options.signal } : {}) });
    pipeline(input, storedValidator, zlib.createGunzip({ chunkSize: 64 * 1024 }), output).catch(error => { finish(false); if (!output.destroyed) output.destroy(error); });
    return output;
  });
  installed = true;
  return Object.freeze({
    verification() {
      need(!restored && streamsVerified > 0 && activeStreams === 0 && failedStreams === 0, "KEYWORD_COMPRESSED_HISTORY_NOT_VERIFIED");
      return { installed: true, compression: "gzip", logicalRelative: RELATIVE, streamsOpened, streamsVerified, activeStreams, failedStreams, sourceBytes: row.sourceBytes,
        sourceSha256: row.sourceSha256, storedBytes: row.bytes, storedSha256: row.sha256, verified: true };
    },
    restore() { if (restored) return; for (const restore of restorers.reverse()) restore(); restored = true; installed = false; }
  });
}
module.exports = { installCompressedHistory, MAX_HISTORY_BYTES };
