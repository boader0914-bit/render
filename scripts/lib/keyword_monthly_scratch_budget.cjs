"use strict";
// This normalization mode has no SQLite/native writer. Reserve every allowed
// JS write before it happens; unsupported writer APIs fail before mutation.
const native = require("node:fs"), fs = require("node:fs/promises"), path = require("node:path");
const { OWN_SCRATCH_HARD_BYTES } = require("./keyword_monthly_source_copy.cjs");
const base = Object.fromEntries(["lstatSync", "readdirSync", "realpathSync"].map(name => [name, native[name].bind(native)]));
const inside = (root, file) => file === root || file.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
function need(value, code) { if (!value) throw Object.assign(new Error(code), { code }); }
const allocation = size => Math.ceil(size / 4096) * 4096;
function installScratchBudget(root, maximumBytes = OWN_SCRATCH_HARD_BYTES, options = {}) {
  root = path.resolve(root); need(Number.isSafeInteger(maximumBytes) && maximumBytes > 0 && maximumBytes <= OWN_SCRATCH_HARD_BYTES, "KEYWORD_SCRATCH_BUDGET_INVALID");
  need(options && typeof options === "object" && !Array.isArray(options) && Object.keys(options).every(key => key === "externalWriteRoots")
    && (options.externalWriteRoots === undefined || Array.isArray(options.externalWriteRoots) && options.externalWriteRoots.length <= 16), "KEYWORD_SCRATCH_EXTERNAL_ROOTS_INVALID");
  const externalRoots = [...new Set(options.externalWriteRoots || [])];
  need(externalRoots.every(file => typeof file === "string" && path.isAbsolute(file) && path.resolve(file) === file && file !== path.parse(file).root), "KEYWORD_SCRATCH_EXTERNAL_ROOTS_INVALID");
  externalRoots.sort((a, b) => b.length - a.length);
  const map = new Map(), restore = []; let used = 0, reserved = 0, peak = 0, checks = 0, deniedOperations = 0, externalOperations = 0;
  const gate = (value, code) => { if (!value) { deniedOperations++; need(false, code); } };
  function externalPath(file, requireDirectory = false) {
    let current = path.parse(file).root, final = null;
    for (const part of file.slice(current.length).split(path.sep).filter(Boolean)) {
      current = path.join(current, part); let stat;
      try { stat = base.lstatSync(current); } catch (error) { if (error.code === "ENOENT" && !requireDirectory) break; throw error; }
      gate(!stat.isSymbolicLink() && (current === file || stat.isDirectory()) && (!stat.isFile() || stat.nlink === 1), "KEYWORD_SCRATCH_EXTERNAL_PATH_UNSAFE");
      const real = base.realpathSync(current); gate(process.platform === "win32" ? real.toLowerCase() === current.toLowerCase() : real === current, "KEYWORD_SCRATCH_EXTERNAL_PATH_UNSAFE");
      if (current === file) final = stat;
    }
    if (requireDirectory) gate(final?.isDirectory() && (process.platform === "win32" || final.uid === process.getuid() && (final.mode & 0o022) === 0), "KEYWORD_SCRATCH_EXTERNAL_ROOT_UNSAFE");
  }
  for (const approved of externalRoots) externalPath(approved, true);
  function scope(file) {
    gate(typeof file === "string", "KEYWORD_SCRATCH_PATH_INVALID"); file = path.resolve(file);
    // A namespace may contain the job root. Job writes always keep the original
    // scratch accounting, even when a broader private namespace is approved.
    if (inside(root, file)) return { file, owner: root, external: false };
    const owner = externalRoots.find(approved => inside(approved, file)); gate(owner, "KEYWORD_SCRATCH_PATH_INVALID"); externalPath(file);
    return { file, owner, external: true };
  }
  function destructiveExternal(entry) { gate(!inside(entry.file, root), "KEYWORD_SCRATCH_CROSS_SCOPE_DENIED"); }
  function size(file) { const value = base.lstatSync(file); gate(!value.isSymbolicLink(), "KEYWORD_SCRATCH_SYMLINK_DENIED"); return value.isDirectory() ? Math.max(4096, Number(value.blocks || 0) * 512) : Math.max(allocation(value.size), Number(value.blocks || 0) * 512); }
  function own(file) { gate(typeof file === "string" && inside(root, path.resolve(file)), "KEYWORD_SCRATCH_PATH_INVALID"); return path.resolve(file); }
  function refresh(file) { file = own(file); const before = map.get(file) || 0; let after = 0; try { after = size(file); } catch (error) { if (error.code !== "ENOENT") throw error; } used += after - before; if (after) map.set(file, after); else map.delete(file); peak = Math.max(peak, used + reserved); gate(used + reserved <= maximumBytes, "KEYWORD_SCRATCH_HARD_BOUND"); }
  function parents(file) { let current = path.dirname(own(file)); while (inside(root, current)) { refresh(current); if (current === root) break; current = path.dirname(current); } }
  function walk(directory, depth = 0) { need(depth <= 15 && map.size <= 25000, "KEYWORD_SCRATCH_INVENTORY_BOUND"); refresh(directory); for (const entry of base.readdirSync(directory, { withFileTypes: true })) { const file = path.join(directory, entry.name); need(!entry.isSymbolicLink(), "KEYWORD_SCRATCH_SYMLINK_DENIED"); if (entry.isDirectory()) walk(file, depth + 1); else refresh(file); } }
  walk(root);
  function replace(object, key, value) { const old = object[key]; object[key] = value; restore.push(() => { object[key] = old; }); }
  function bytes(value) { if (typeof value === "string") return Buffer.byteLength(value); if (Buffer.isBuffer(value) || ArrayBuffer.isView(value)) return value.byteLength; need(false, "KEYWORD_SCRATCH_UNSUPPORTED_WRITE"); }
  function reserve(file, additional) {
    file = own(file); refresh(file); checks++; gate(Number.isSafeInteger(additional) && additional >= 0, "KEYWORD_SCRATCH_UNSUPPORTED_WRITE");
    // Reserve directory allocation slack before publishing a new entry too.
    const delta = allocation(additional) + 64 * 1024; gate(used + reserved + delta <= maximumBytes, "KEYWORD_SCRATCH_HARD_BOUND"); reserved += delta; peak = Math.max(peak, used + reserved);
    let complete = false; return () => { if (complete) return; complete = true; parents(file); reserved -= delta; refresh(file); };
  }
  async function wrote(file, additional, operation) { const finish = reserve(file, additional); try { return await operation(); } finally { finish(); } }
  for (const name of ["writeFile", "appendFile"]) { const old = fs[name], originalBudgeted = (file, value, ...options) => wrote(file, bytes(value), () => old(file, value, ...options));
    replace(fs, name, !externalRoots.length ? originalBudgeted : async (file, value, ...options) => {
      const entry = scope(file); if (entry.external) { externalOperations++; return old(entry.file, value, ...options); }
      return originalBudgeted(file, value, ...options);
    }); }
  const mkdir = fs.mkdir; replace(fs, "mkdir", (file, ...options) => {
    if (typeof file === "string" && !inside(root, path.resolve(file))) {
      // Preserve the pre-existing default mkdir behavior. Explicit external mode
      // validates its outside directories too; outer write guards still apply.
      if (!externalRoots.length) return mkdir(file, ...options);
      return (async () => { const entry = scope(file); externalOperations++; return mkdir(entry.file, ...options); })();
    }
    return wrote(file, 15 * 4096, async () => { const value = await mkdir(file, ...options); let current = own(file); while (inside(root, current)) { refresh(current); if (current === root) break; current = path.dirname(current); } return value; });
  });
  const rename = fs.rename; replace(fs, "rename", async (source, target) => {
    if (externalRoots.length) { const from = scope(source), to = scope(target); gate(from.external === to.external && from.owner === to.owner, "KEYWORD_SCRATCH_CROSS_SCOPE_DENIED");
      if (from.external) { destructiveExternal(from); gate(!inside(to.file, root), "KEYWORD_SCRATCH_CROSS_SCOPE_DENIED"); externalOperations++; return rename(from.file, to.file); } }
    own(source); own(target); const result = await rename(source, target); for (const key of [...map.keys()]) if (key === source || key.startsWith(source + path.sep)) { used -= map.get(key); map.delete(key); } try { if (base.lstatSync(target).isDirectory()) walk(target); else refresh(target); } catch (error) { if (error.code !== "ENOENT") throw error; } parents(source); parents(target); return result;
  });
  for (const name of ["unlink", "rm", "rmdir"]) { const old = fs[name]; replace(fs, name, async (file, ...options) => {
    if (externalRoots.length) { const entry = scope(file); if (entry.external) { destructiveExternal(entry); externalOperations++; return old(entry.file, ...options); } }
    file = own(file); const result = await old(file, ...options); for (const key of [...map.keys()]) if (key === file || key.startsWith(file + path.sep)) { used -= map.get(key); map.delete(key); } parents(file); return result;
  }); }
  const open = fs.open; replace(fs, "open", async (file, flags, ...options) => {
    const writing = typeof flags === "number" ? Boolean(flags & (native.constants.O_WRONLY | native.constants.O_RDWR | native.constants.O_CREAT | native.constants.O_TRUNC | native.constants.O_APPEND)) : /[wa+]/.test(String(flags));
    if (!writing) return open(file, flags, ...options);
    if (externalRoots.length) { const entry = scope(file); if (entry.external) { externalOperations++; return open(entry.file, flags, ...options); } }
    file = own(file); const handle = await wrote(file, 0, () => open(file, flags, ...options));
    const writeFile = handle.writeFile.bind(handle), write = handle.write.bind(handle), writev = handle.writev.bind(handle), truncate = handle.truncate.bind(handle);
    const growth = (length, position) => { gate(Number.isSafeInteger(length) && length >= 0 && (position == null || Number.isSafeInteger(position) && position >= 0), "KEYWORD_SCRATCH_UNSUPPORTED_WRITE"); const oldSize = base.lstatSync(file).size; const end = position == null ? oldSize + length : position + length; gate(Number.isSafeInteger(end), "KEYWORD_SCRATCH_UNSUPPORTED_WRITE"); return Math.max(length, end - oldSize); };
    handle.writeFile = (value, ...rest) => wrote(file, bytes(value), () => writeFile(value, ...rest));
    handle.appendFile = handle.writeFile;
    handle.write = (...args) => { gate(typeof args[0] === "string" || args[1] === undefined || typeof args[1] === "number", "KEYWORD_SCRATCH_UNSUPPORTED_WRITE_SIGNATURE"); return wrote(file, growth(typeof args[0] === "string" ? bytes(args[0]) : args[2] ?? args[0]?.byteLength, typeof args[0] === "string" ? args[1] : args[3]), () => write(...args)); };
    handle.writev = (values, ...rest) => wrote(file, growth(values.reduce((sum, value) => sum + bytes(value), 0), rest[0]), () => writev(values, ...rest));
    handle.truncate = length => wrote(file, length || 0, () => truncate(length));
    handle.createWriteStream = () => gate(false, "KEYWORD_SCRATCH_UNSUPPORTED_WRITER");
    return handle;
  });
  // The reviewed normalization path uses promises/file handles above. A new
  // native synchronous, callback or stream writer must be reviewed explicitly.
  for (const name of ["writeFile", "writeFileSync", "appendFile", "appendFileSync", "createWriteStream", "copyFile", "copyFileSync", "write", "writeSync", "writev", "writevSync", "truncate", "truncateSync", "ftruncate", "ftruncateSync", "mkdir", "mkdirSync", "rename", "renameSync", "unlink", "unlinkSync", "rm", "rmSync", "rmdir", "rmdirSync", "cp", "cpSync", "link", "linkSync", "symlink", "symlinkSync", "mkdtemp", "mkdtempSync"]) if (typeof native[name] === "function") replace(native, name, () => gate(false, "KEYWORD_SCRATCH_UNSUPPORTED_WRITER"));
  for (const name of ["copyFile", "cp", "link", "symlink", "mkdtemp"]) if (typeof fs[name] === "function") replace(fs, name, async () => gate(false, "KEYWORD_SCRATCH_UNSUPPORTED_WRITER"));
  for (const name of ["open", "openSync"]) { const old = native[name]; replace(native, name, (file, flags, ...options) => { gate(!(typeof flags === "number" ? flags & (native.constants.O_WRONLY | native.constants.O_RDWR | native.constants.O_CREAT | native.constants.O_TRUNC | native.constants.O_APPEND) : /[wa+]/.test(String(flags))), "KEYWORD_SCRATCH_UNSUPPORTED_WRITER"); return old(file, flags, ...options); }); }
  return { status() { return { maximumBytes, allocatedBytes: used, reservedBytes: reserved, peakReservedAndAllocatedBytes: peak, trackedPaths: map.size, reservationChecks: checks, deniedOperations, sqliteWriterEnabled: false,
    ...(externalRoots.length ? { externalWriteRootCount: externalRoots.length, externalDelegatedOperations: externalOperations } : {}) }; },
    assertCurrent() { need(used + reserved <= maximumBytes, "KEYWORD_SCRATCH_HARD_BOUND"); return this.status(); }, restore() { for (const operation of restore.reverse()) operation(); } };
}
module.exports = { installScratchBudget };
