"use strict";
// An explicit, short-lived derived-publication exclusion. Never a collector
// setting or a time-based permission to reclaim somebody else's work.
const fs = require("node:fs/promises"), native = require("node:fs"), path = require("node:path"), crypto = require("node:crypto"), os = require("node:os");
const H = require("./keyword_monthly_refresh_preparation.cjs");
const FILE = "prepared-conversion-lock.json", KIND = "keyword_prepared_conversion_maintenance", BOUND = 16384;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const fault = code => Object.assign(new Error(code), { code, deferred: true });
const sha = value => crypto.createHash("sha256").update(value).digest("hex");
function location(dataDir) {
  H.absolute(dataDir); return path.join(dataDir, "keyword_monthly_incremental", FILE);
}
const fields = ["schemaVersion", "kind", "token", "pid", "createdAt", "operationId", "mode", "contextSha256"];
function valid(value) {
  return value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === fields.length
    && fields.every(key => Object.hasOwn(value, key)) && value.schemaVersion === 1 && value.kind === KIND
    && UUID.test(value.token || "") && UUID.test(value.operationId || "") && Number.isSafeInteger(value.pid) && value.pid > 0
    && H.validIso(value.createdAt) && ["stage", "publish"].includes(value.mode) && H.SHA.test(value.contextSha256 || "");
}
async function readLease(file) {
  const saved = await H.read(file, BOUND);
  if (!valid(saved.value) || process.platform !== "win32" && ((saved.stat.mode & 0o777) !== 0o600 || saved.stat.uid !== process.getuid())) throw fault("KEYWORD_INCREMENTAL_PREPARED_CONVERSION_UNVERIFIED");
  return saved;
}
async function readPreparedConversionAdmission({ dataDir } = {}) {
  const file = location(dataDir);
  try { await fs.lstat(file); }
  catch (error) { return error.code === "ENOENT" ? { allowed: true, reasonCode: null }
    : { allowed: false, reasonCode: "KEYWORD_INCREMENTAL_PREPARED_CONVERSION_UNVERIFIED" }; }
  try { await readLease(file); return { allowed: false, reasonCode: "KEYWORD_INCREMENTAL_PREPARED_CONVERSION_ACTIVE" }; }
  catch { return { allowed: false, reasonCode: "KEYWORD_INCREMENTAL_PREPARED_CONVERSION_UNVERIFIED" }; }
}
async function acquirePreparedConversionLease({ dataDir, mode, operationId, now = () => new Date(), contextSha256 } = {}) {
  if (!["stage", "publish"].includes(mode) || !UUID.test(operationId || "")) throw TypeError("Explicit prepared conversion identity required");
  const file = location(dataDir), directory = path.dirname(file);
  const parent = await H.checked(directory, true);
  if (process.platform !== "win32" && ((parent.mode & 0o777) !== 0o700 || parent.uid !== process.getuid())) throw fault("KEYWORD_INCREMENTAL_PREPARED_CONVERSION_UNVERIFIED");
  if (contextSha256 === undefined) {
    const context = process.platform === "linux" ? await require("./keyword_monthly_worker_lock.cjs").createLinuxProcessReader().context()
      : { hostname: os.hostname(), pid: process.pid };
    contextSha256 = sha(JSON.stringify(context));
  }
  if (!H.SHA.test(contextSha256 || "")) throw TypeError("Invalid maintenance context");
  const row = { schemaVersion: 1, kind: KIND, token: crypto.randomUUID(), pid: process.pid,
    createdAt: new Date(now()).toISOString(), operationId, mode, contextSha256 };
  if (!valid(row)) throw TypeError("Invalid maintenance clock");
  const bytes = Buffer.from(JSON.stringify(row)); let handle, before, complete = false;
  try {
    try { handle = await fs.open(file, "wx", 0o600); }
    catch (error) { if (error.code === "EEXIST") throw fault("KEYWORD_INCREMENTAL_PREPARED_CONVERSION_ACTIVE"); throw error; }
    before = await handle.stat(); await handle.writeFile(bytes); await handle.sync(); await handle.close(); handle = null;
    const saved = await readLease(file);
    if (saved.sha256 !== sha(bytes) || saved.stat.dev !== before.dev || saved.stat.ino !== before.ino
      || !H.identity(parent, await H.checked(directory, true))) throw fault("KEYWORD_INCREMENTAL_PREPARED_CONVERSION_UNVERIFIED");
    complete = true;
  } finally {
    if (handle) await handle.close().catch(() => {});
    // A partial/changed marker is deliberately retained, never inferred stale.
  }
  let released = false;
  return Object.freeze({ operationId, async release() {
    if (released) return;
    const current = await readLease(file);
    if (!complete || current.sha256 !== sha(bytes) || current.stat.dev !== before.dev || current.stat.ino !== before.ino
      || !H.identity(parent, await H.checked(directory, true))) throw fault("KEYWORD_INCREMENTAL_PREPARED_CONVERSION_UNVERIFIED");
    const final = await fs.lstat(file);
    if (!H.same(current.stat, final)) throw fault("KEYWORD_INCREMENTAL_PREPARED_CONVERSION_UNVERIFIED");
    await fs.unlink(file); released = true;
    if (process.platform !== "win32") { const directoryHandle = await fs.open(directory, native.constants.O_RDONLY); try { await directoryHandle.sync(); } finally { await directoryHandle.close(); } }
  } });
}
module.exports = { readPreparedConversionAdmission, acquirePreparedConversionLease, MAINTENANCE_FILE: FILE };
