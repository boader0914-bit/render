"use strict";

// A bounded reader of one exact saved derived scope. It deliberately does not
// construct regional_analysis_store, whose initialization can recover jobs.
const fs = require("node:fs/promises");
const constants = require("node:fs").constants;
const path = require("node:path");
const crypto = require("node:crypto");
const { buildRegionalMarketSnapshot, validateRegionalMarketSnapshot, fault } = require("./regional_market.cjs");
const MAX_POINTER_BYTES = 64 * 1024, MAX_RESULT_BYTES = 8 * 1024 * 1024;
const STORE_VERSION = "regional-analysis-v1", UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const keyFor = scope => crypto.createHash("sha256").update(JSON.stringify([STORE_VERSION, scope.regionKey, scope.months, scope.month])).digest("hex");
const samePath = (a, b) => process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
const identity = stat => [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(":");
const directoryIdentity = stat => [stat.dev, stat.ino].join(":");
const completedMonth = value => { const now = new Date(new Date(value).getTime() + 9 * 3600000); return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)).toISOString().slice(0, 7); };
async function safePath(base, segments) {
  let target = path.resolve(base), stat = await fs.lstat(target);
  if (stat.isSymbolicLink() || !samePath(await fs.realpath(target), target) || !stat.isDirectory()) throw fault("REGIONAL_MARKET_UNSAFE_PATH", 503);
  const parents = [{ filename: target, identity: directoryIdentity(stat) }];
  for (let i = 0; i < segments.length; i++) {
    if (typeof segments[i] !== "string" || !/^[A-Za-z0-9_.-]{1,120}$/.test(segments[i]) || [".", ".."].includes(segments[i])) throw fault("REGIONAL_MARKET_UNSAFE_PATH", 503);
    target = path.join(target, segments[i]);
    stat = await fs.lstat(target);
    if (stat.isSymbolicLink() || !samePath(await fs.realpath(target), target) || i < segments.length - 1 && !stat.isDirectory()) throw fault("REGIONAL_MARKET_UNSAFE_PATH", 503);
    if (i < segments.length - 1) parents.push({ filename: target, identity: directoryIdentity(stat) });
  }
  return { filename: target, identity: identity(stat), parents };
}
async function revalidatePath(checked) {
  for (const parent of checked.parents) {
    const stat = await fs.lstat(parent.filename);
    if (!stat.isDirectory() || stat.isSymbolicLink() || directoryIdentity(stat) !== parent.identity || !samePath(await fs.realpath(parent.filename), parent.filename)) throw fault("REGIONAL_MARKET_UNSAFE_PATH", 503);
  }
  const stat = await fs.lstat(checked.filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || identity(stat) !== checked.identity || !samePath(await fs.realpath(checked.filename), checked.filename)) throw fault("REGIONAL_MARKET_EVIDENCE_CHANGED", 503);
}
async function readBounded(base, segments, limit) {
  let checked, handle;
  try {
    checked = await safePath(base, segments);
    handle = await fs.open(checked.filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1) throw fault("REGIONAL_MARKET_UNSAFE_PATH", 503);
    if (identity(before) !== checked.identity) throw fault("REGIONAL_MARKET_EVIDENCE_CHANGED", 503);
    if (before.size < 2 || before.size > limit) throw fault("REGIONAL_MARKET_SOURCE_TOO_LARGE", 503);
    const bytes = Buffer.alloc(before.size + 1); let length = 0;
    while (length < bytes.length) { const next = await handle.read(bytes, length, bytes.length - length, length); if (!next.bytesRead) break; length += next.bytesRead; }
    const after = await handle.stat();
    if (length !== before.size || identity(before) !== identity(after) || !after.isFile() || after.nlink !== 1) throw fault("REGIONAL_MARKET_EVIDENCE_CHANGED", 503);
    await revalidatePath(checked);
    const actual = bytes.subarray(0, length);
    let value;
    try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(actual)); }
    catch { throw fault("REGIONAL_MARKET_SOURCE_INVALID", 503); }
    return { value, sha256: crypto.createHash("sha256").update(actual).digest("hex"), filename: checked.filename, identity: identity(after), checked };
  } catch (error) {
    if (error.code === "ENOENT") { if (handle) throw fault("REGIONAL_MARKET_EVIDENCE_CHANGED", 503); return null; }
    if (/^REGIONAL_MARKET_/.test(error.code || "")) throw error;
    throw fault("REGIONAL_MARKET_SOURCE_UNAVAILABLE", 503);
  } finally { await handle?.close(); }
}
function createRegionalMarketService({ dataDir, resolveRegion, now = () => new Date() } = {}) {
  if (typeof dataDir !== "string" || !dataDir || typeof resolveRegion !== "function" || typeof now !== "function") throw new TypeError("dataDir, resolveRegion and now are required");
  const base = path.resolve(dataDir);
  return {
    async get(input = {}) {
      if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(k => !["regionKey", "month", "months"].includes(k))
        || !/^[A-Za-z0-9_:-]{1,120}$/.test(input.regionKey || "") || input.months !== undefined && ![13, 24].includes(Number(input.months))) throw fault("REGIONAL_MARKET_INVALID_SCOPE");
      const instant = new Date(now()), scope = { regionKey: input.regionKey, month: input.month || completedMonth(instant), months: input.months === undefined ? 13 : Number(input.months) };
      const currentMonth = new Date(instant.getTime() + 9 * 3600000).toISOString().slice(0, 7);
      if (typeof input.month !== "undefined" && (typeof input.month !== "string" || !input.month) || !/^20\d{2}-(0[1-9]|1[0-2])$/.test(scope.month) || scope.month > currentMonth) throw fault("REGIONAL_MARKET_INVALID_SCOPE");
      const region = await resolveRegion(scope.regionKey), key = keyFor(scope);
      // Validate the canonical selected region before reading any filesystem.
      buildRegionalMarketSnapshot({ region, scope, now: () => instant });
      const pointer = await readBounded(base, ["regional_analysis", "latest", key + ".json"], MAX_POINTER_BYTES);
      if (!pointer) return validateRegionalMarketSnapshot(buildRegionalMarketSnapshot({ region, scope, now: () => instant }), { asOfAt: instant.toISOString() });
      if (pointer.value?.schemaVersion !== 1 || pointer.value.scopeKey !== key || !UUID.test(pointer.value.resultId || "")
        || !Array.isArray(pointer.value.revisions) || pointer.value.revisions.length > 8 || pointer.value.revisions.some(id => !UUID.test(id))) throw fault("REGIONAL_MARKET_SOURCE_INVALID", 503);
      const record = await readBounded(base, ["regional_analysis", "results", key, pointer.value.resultId + ".json"], MAX_RESULT_BYTES);
      if (!record) throw fault("REGIONAL_MARKET_SOURCE_MISSING", 503);
      await revalidatePath(pointer.checked);
      if (record.value?.schemaVersion !== 1 || record.value.calculationVersion !== STORE_VERSION || record.value.resultId !== pointer.value.resultId
        || keyFor(record.value.scope || {}) !== key) throw fault("REGIONAL_MARKET_SOURCE_INVALID", 503);
      return validateRegionalMarketSnapshot(buildRegionalMarketSnapshot({ region, scope, savedSnapshot: record.value, source: { resultSha256: record.sha256 }, now: () => instant }), { asOfAt: instant.toISOString() });
    }
  };
}
module.exports = { createRegionalMarketService, MAX_POINTER_BYTES, MAX_RESULT_BYTES, keyFor, completedMonth };
