"use strict";
// This view never copies, changes, repairs or discovers a new original file.
// Every body must belong to the frozen, metadata-bound output namespace.
const fs = require("node:fs"), fsp = require("node:fs/promises"), path = require("node:path"), crypto = require("node:crypto");
const { stamp } = require("./keyword_monthly_source_copy.cjs");
const MAX_FILE_BYTES = 64 * 1024 * 1024, MAX_CAPTURED_FILE_BYTES = 512 * 1024 * 1024;
const originals = Object.fromEntries(["lstatSync", "realpathSync", "openSync", "readSync", "readFileSync", "closeSync", "fstatSync", "createReadStream", "readdirSync"].map(key => [key, fs[key].bind(fs)]));
function need(value, code) { if (!value) throw Object.assign(new Error(code), { code }); }
const inside = (root, file) => file === root || file.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
const hash = () => crypto.createHash("sha256"), same = (a, b) => JSON.stringify(stamp(a)) === JSON.stringify(stamp(b));
function installReadOnlyOutputs({ root, files, directories } = {}) {
  need(typeof root === "string" && path.isAbsolute(root) && Array.isArray(files) && files.length <= 15000 && Array.isArray(directories) && directories.length <= 15000, "KEYWORD_OUTPUT_VIEW_INVALID"); root = path.resolve(root);
  const map = new Map(files.map(row => [row.relative, row])), directoryMap = new Map(directories.map(row => [row.relative, row])), receipts = new Map(), restore = [], readonlyDescriptors = new Map();
  need(map.size === files.length && files.every(row => typeof row.relative === "string" && !row.relative.startsWith("/") && !row.relative.split("/").some(part => !part || part === "." || part === "..")
    && Number.isSafeInteger(row.bytes) && row.bytes >= 0 && row.bytes <= MAX_CAPTURED_FILE_BYTES && row.stamp), "KEYWORD_OUTPUT_VIEW_INVALID");
  need(directoryMap.size === directories.length && directoryMap.has("") && directories.every(row => typeof row.relative === "string" && !row.relative.startsWith("/")
    && (row.relative === "" || !row.relative.split("/").some(part => !part || part === "." || part === "..")) && row.stamp), "KEYWORD_OUTPUT_VIEW_INVALID");
  const metrics = { originalBodyFiles: 0, originalBodyBytesHashed: 0, originalBodyReads: 0, originalWriteAttempts: 0, uncapturedReadAttempts: 0, validationDenials: 0, expectedMissingReads: 0, consumerFdChecks: 0, nonMutatingExistingDirectoryChecks: 0 };
  const check = (value, code) => { if (!value) { metrics.validationDenials++; need(false, code); } };
  function replace(object, key, value) { const old = object[key]; object[key] = value; restore.push(() => { object[key] = old; }); }
  function resolve(value) {
    if (typeof value !== "string" && !Buffer.isBuffer(value) && !(value instanceof URL)) return null;
    const file = path.resolve(value instanceof URL ? require("node:url").fileURLToPath(value) : String(value)); return inside(root, file) ? file : null;
  }
  function checked(file, directory = false) {
    let current = path.parse(file).root;
    for (const part of file.slice(current.length).split(path.sep).filter(Boolean)) {
      current = path.join(current, part); const value = originals.lstatSync(current, { bigint: true });
      check(!value.isSymbolicLink() && (current === file || value.isDirectory()), "KEYWORD_OUTPUT_SYMLINK_DENIED");
    }
    const value = originals.lstatSync(file, { bigint: true }); check(directory ? value.isDirectory() : value.isFile() && value.nlink === 1n, "KEYWORD_OUTPUT_PATH_INVALID");
    check(originals.realpathSync(file) === file, "KEYWORD_OUTPUT_PATH_INVALID"); return value;
  }
  function fileEntry(file) {
    const relative = path.relative(root, file).split(path.sep).join("/"), expected = map.get(relative);
    if (!expected) {
      try { checked(file); } catch (error) { if (error.code === "ENOENT") { metrics.expectedMissingReads++; throw error; } throw error; }
      metrics.uncapturedReadAttempts++; need(false, "KEYWORD_OUTPUT_NOT_CAPTURED");
    }
    const value = checked(file); check(JSON.stringify(stamp(value)) === JSON.stringify(expected.stamp), "KEYWORD_OUTPUT_CHANGED"); return { relative, expected, stat: value };
  }
  function hashFile(file) {
    const entry = fileEntry(file); check(entry.expected.bytes <= MAX_FILE_BYTES, "KEYWORD_OUTPUT_BODY_BOUND");
    const fd = originals.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)), h = hash(), buffer = Buffer.alloc(1024 * 1024); let position = 0;
    try {
      need(same(entry.stat, originals.fstatSync(fd, { bigint: true })), "KEYWORD_OUTPUT_CHANGED");
      while (true) { const count = originals.readSync(fd, buffer, 0, buffer.length, position); if (!count) break; position += count; need(position <= entry.expected.bytes, "KEYWORD_OUTPUT_CHANGED"); h.update(buffer.subarray(0, count)); }
      need(position === entry.expected.bytes && same(entry.stat, originals.fstatSync(fd, { bigint: true })) && same(entry.stat, checked(file)), "KEYWORD_OUTPUT_CHANGED");
    } finally { originals.closeSync(fd); }
    metrics.originalBodyBytesHashed += position; return { relative: entry.relative, bytes: position, sha256: h.digest("hex"), sourceStamp: entry.expected.stamp };
  }
  function observe(file) {
    const entry = fileEntry(file); if (!receipts.has(entry.relative)) { receipts.set(entry.relative, hashFile(file)); metrics.originalBodyFiles++; }
    metrics.originalBodyReads++; return entry;
  }
  const writing = flags => typeof flags === "number" ? Boolean(flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_APPEND)) : /[wa+]/.test(String(flags));
  const denied = () => { metrics.originalWriteAttempts++; need(false, "KEYWORD_OUTPUT_WRITE_DENIED"); };
  function consumerFd(fd) { const entry = readonlyDescriptors.get(fd); if (!entry) return; check(same(entry.stat, originals.fstatSync(fd, { bigint: true })) && same(entry.stat, checked(entry.file)), "KEYWORD_OUTPUT_CHANGED"); metrics.consumerFdChecks++; }
  function encoding(options) { return typeof options === "string" ? options : options?.encoding; }
  function readBuffer(file) {
    const before = observe(file), fd = originals.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    try { need(same(before.stat, originals.fstatSync(fd, { bigint: true })), "KEYWORD_OUTPUT_CHANGED"); metrics.consumerFdChecks++; const data = originals.readFileSync(fd); need(data.length === before.expected.bytes && same(before.stat, originals.fstatSync(fd, { bigint: true })) && same(before.stat, checked(file)), "KEYWORD_OUTPUT_CHANGED"); metrics.consumerFdChecks++; need(hash().update(data).digest("hex") === receipts.get(before.relative).sha256, "KEYWORD_OUTPUT_CHANGED"); return data; }
    finally { originals.closeSync(fd); }
  }
  const readSync = fs.readFileSync; replace(fs, "readFileSync", (value, options) => { if (typeof value === "number" && readonlyDescriptors.has(value)) { if (writing(options?.flag || "r")) denied(); consumerFd(value); const data = originals.readFileSync(value, options); consumerFd(value); return data; } const file = resolve(value); if (!file) return readSync(value, options); if (writing(options?.flag || "r")) denied(); const data = readBuffer(file), e = encoding(options); return e ? data.toString(e) : data; });
  const readAsync = fsp.readFile; replace(fsp, "readFile", async (value, options) => { const file = resolve(value); if (!file) return readAsync(value, options); if (writing(options?.flag || "r")) denied(); const data = readBuffer(file), e = encoding(options); return e ? data.toString(e) : data; });
  const readCallback = fs.readFile; replace(fs, "readFile", (value, options, callback) => { const file = resolve(value); if (!file) return readCallback(value, options, callback); if (typeof options === "function") { callback = options; options = undefined; } need(typeof callback === "function", "KEYWORD_OUTPUT_READ_SIGNATURE_INVALID"); try { const data = readBuffer(file), e = encoding(options); queueMicrotask(() => callback(null, e ? data.toString(e) : data)); } catch (error) { queueMicrotask(() => callback(error)); } });
  const openSync = fs.openSync; replace(fs, "openSync", (value, flags, mode) => { const file = resolve(value); if (!file) return openSync(value, flags, mode); if (writing(flags)) denied(); const entry = observe(file), fd = originals.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)); readonlyDescriptors.set(fd, { ...entry, file }); consumerFd(fd); return fd; });
  const closeSync = fs.closeSync; replace(fs, "closeSync", fd => { try { consumerFd(fd); return closeSync(fd); } finally { readonlyDescriptors.delete(fd); } });
  const openCallback = fs.open; replace(fs, "open", (value, flags, mode, callback) => { const file = resolve(value); if (!file) return openCallback(value, flags, mode, callback); if (typeof mode === "function") { callback = mode; mode = undefined; } if (writing(flags)) denied(); const entry = observe(file); return openCallback(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0), mode, (error, fd) => { if (!error) { readonlyDescriptors.set(fd, { ...entry, file }); try { consumerFd(fd); } catch (failure) { originals.closeSync(fd); readonlyDescriptors.delete(fd); callback(failure); return; } } callback(error, fd); }); });
  const closeCallback = fs.close; replace(fs, "close", (fd, callback) => { consumerFd(fd); return closeCallback(fd, error => { readonlyDescriptors.delete(fd); callback(error); }); });
  for (const name of ["writeSync", "writevSync", "ftruncateSync", "fchmodSync", "fchownSync", "futimesSync"]) { const old = fs[name]; if (typeof old === "function") replace(fs, name, (fd, ...args) => { if (readonlyDescriptors.has(fd)) denied(); return old(fd, ...args); }); }
  for (const name of ["write", "writev", "ftruncate", "fchmod", "fchown", "futimes"]) { const old = fs[name]; if (typeof old === "function") replace(fs, name, (fd, ...args) => { if (readonlyDescriptors.has(fd)) denied(); return old(fd, ...args); }); }
  const openAsync = fsp.open; replace(fsp, "open", async (value, flags, mode) => { const file = resolve(value); if (!file) return openAsync(value, flags, mode); if (writing(flags)) denied(); const entry = observe(file), handle = await openAsync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)); readonlyDescriptors.set(handle.fd, { ...entry, file }); consumerFd(handle.fd); const close = handle.close.bind(handle); handle.close = async () => { const fd = handle.fd; try { consumerFd(fd); return await close(); } finally { readonlyDescriptors.delete(fd); } }; for (const name of ["write", "writev", "writeFile", "appendFile", "truncate", "chmod", "chown", "utimes"]) handle[name] = async () => denied(); return handle; });
  const mkdir = fsp.mkdir; replace(fsp, "mkdir", async (value, options) => { const file = resolve(value); if (!file) return mkdir(value, options); if (file === root && options?.recursive === true) { checked(file, true); metrics.nonMutatingExistingDirectoryChecks++; return undefined; } denied(); });
  const createStream = fs.createReadStream; replace(fs, "createReadStream", (value, options = {}) => { const file = resolve(value); if (!file) return createStream(value, options); if (options.fd !== undefined || writing(options.flags || "r")) denied(); observe(file); return originals.createReadStream(file, { ...options, flags: fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) }); });
  async function assertInventoryCurrent() {
    const found = [], foundDirectories = []; function visit(directory, depth) { need(depth <= 10, "KEYWORD_OUTPUT_DEPTH_BOUND"); const relative = path.relative(root, directory).split(path.sep).join("/"), expected = directoryMap.get(relative);
      check(expected && JSON.stringify(stamp(checked(directory, true))) === JSON.stringify(expected.stamp), "KEYWORD_OUTPUT_DIRECTORY_CHANGED"); foundDirectories.push(relative);
      for (const entry of originals.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name); need(!entry.isSymbolicLink(), "KEYWORD_OUTPUT_SYMLINK_DENIED"); if (entry.isDirectory()) visit(file, depth + 1); else { const value = fileEntry(file); found.push(value.relative); need(found.length <= files.length, "KEYWORD_OUTPUT_CHANGED"); }
    } } visit(root, 0); check(found.length === files.length && found.every(relative => map.has(relative)) && foundDirectories.length === directories.length, "KEYWORD_OUTPUT_CHANGED"); return { files: found.length, directories: foundDirectories.length, inventoryPreserved: true };
  }
  return { metrics, async verify() { const inventory = await assertInventoryCurrent(), checked = []; for (const row of receipts.values()) { const after = hashFile(path.join(root, ...row.relative.split("/"))); need(after.sha256 === row.sha256 && after.bytes === row.bytes, "KEYWORD_OUTPUT_CHANGED"); checked.push({ ...row, afterSha256: after.sha256, preserved: true }); } return { ...inventory, originalOutputBodiesCopied: false, originalOutputBodiesReadOnlyReferenced: true, bodies: checked, originalWrites: 0, metrics: { ...metrics } }; },
    assertInventoryCurrent, restore() { for (const operation of restore.reverse()) operation(); } };
}
module.exports = { installReadOnlyOutputs, MAX_FILE_BYTES };
