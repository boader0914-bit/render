"use strict";
// Pure scope planning and bounded saved-file helpers for the independent
// monthly projection refresh. No application, provider or collector imports.
const fs = require("node:fs/promises"), native = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const SHA = /^[a-f0-9]{64}$/, MONTH = /^20\d{2}-(?:0[1-9]|1[0-2])$/;
const VERSION = "keyword-monthly-completed-run-v1";
const LIMITS = Object.freeze({ manifestBytes: 1024 * 1024, receiptBytes: 256 * 1024, candidates: 8, bookingDays: 93,
  scratchBytes: 1024 ** 3, operationsBytes: 1024 ** 3, bundleNamespaceBytes: 1024 ** 3, generationBytes: 128 * 1024 ** 2 });
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const scopeId = value => JSON.stringify([value.keyword, value.month]);
const same = (a, b) => ["dev", "ino", "size", "nlink", "mtimeMs", "ctimeMs"].every(key => a[key] === b[key]);
const identity = (a, b) => a.dev === b.dev && a.ino === b.ino;
function fault(code, causeCode) { return Object.assign(new Error(code), { code, ...(causeCode ? { causeCode } : {}) }); }
function need(value, code) { if (!value) throw fault(code); }
function validDay(value) { return typeof value === "string" && /^20\d{2}-\d\d-\d\d$/.test(value) && Number.isFinite(Date.parse(value + "T00:00:00Z")) && new Date(value + "T00:00:00Z").toISOString().slice(0, 10) === value; }
function validIso(value) { return typeof value === "string" && /^20\d{2}-\d\d-\d\dT.*Z$/.test(value) && Number.isFinite(Date.parse(value)) && validDay(value.slice(0, 10)); }
function nextMonth(month) { need(MONTH.test(month), "KEYWORD_MONTHLY_REFRESH_MONTH_INVALID"); const [year, m] = month.split("-").map(Number); const result = new Date(Date.UTC(year, m, 1)).toISOString().slice(0, 7); need(MONTH.test(result), "KEYWORD_MONTHLY_REFRESH_MONTH_INVALID"); return result; }
function absolute(value) { need(typeof value === "string" && path.isAbsolute(value) && path.resolve(value) === value, "KEYWORD_MONTHLY_REFRESH_PATH_INVALID"); return value; }
function inside(parent, file) { const r = path.relative(parent, file); return r === "" || r !== ".." && !r.startsWith(".." + path.sep) && !path.isAbsolute(r); }
async function checked(file, directory = false) {
  absolute(file); let current = path.parse(file).root;
  for (const part of file.slice(current.length).split(path.sep).filter(Boolean)) { current = path.join(current, part); const s = await fs.lstat(current); need(!s.isSymbolicLink() && (current === file || s.isDirectory()), "KEYWORD_MONTHLY_REFRESH_PATH_UNSAFE"); }
  const s = await fs.lstat(file); need(directory ? s.isDirectory() : s.isFile() && s.nlink === 1, "KEYWORD_MONTHLY_REFRESH_PATH_UNSAFE");
  need(await fs.realpath(file) === file, "KEYWORD_MONTHLY_REFRESH_PATH_UNSAFE"); return s;
}
async function read(file, maximum = LIMITS.receiptBytes) {
  const before = await checked(file); need(before.size > 0 && before.size <= maximum, "KEYWORD_MONTHLY_REFRESH_READ_BOUND");
  const handle = await fs.open(file, native.constants.O_RDONLY | (native.constants.O_NOFOLLOW || 0)); let bytes;
  try { need(same(before, await handle.stat()), "KEYWORD_MONTHLY_REFRESH_EVIDENCE_CHANGED"); bytes = await handle.readFile(); need(bytes.length === before.size && same(before, await handle.stat()), "KEYWORD_MONTHLY_REFRESH_EVIDENCE_CHANGED"); } finally { await handle.close(); }
  need(same(before, await checked(file)), "KEYWORD_MONTHLY_REFRESH_EVIDENCE_CHANGED"); let value; try { value = JSON.parse(bytes); } catch { throw fault("KEYWORD_MONTHLY_REFRESH_JSON_INVALID"); }
  return { file, bytes, value, sha256: hash(bytes), stat: before };
}
async function writeNew(file, value) {
  const before = await checked(path.dirname(file), true), bytes = Buffer.from(JSON.stringify(value)); need(bytes.length <= LIMITS.receiptBytes, "KEYWORD_MONTHLY_REFRESH_RECEIPT_BOUND");
  const handle = await fs.open(file, "wx", 0o600); try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  need(identity(before, await checked(path.dirname(file), true)), "KEYWORD_MONTHLY_REFRESH_PARENT_CHANGED"); const saved = await read(file); need(saved.sha256 === hash(bytes), "KEYWORD_MONTHLY_REFRESH_WRITE_READBACK"); return saved;
}
async function ensurePrivateDirectory(directory, { fixture = false } = {}) {
  try { await checked(directory, true); } catch (error) { if (error.code !== "ENOENT") throw error; await checked(path.dirname(directory), true); await fs.mkdir(directory, { mode: 0o700 }); }
  const stat = await checked(directory, true);
  if (!fixture || process.platform !== "win32") need((stat.mode & 0o777) === 0o700 && (typeof process.getuid !== "function" || stat.uid === process.getuid()), "KEYWORD_MONTHLY_REFRESH_DIRECTORY_OWNER");
  return stat;
}
function validateEvidence(value) {
  need(value && typeof value === "object" && !Array.isArray(value) && /^[A-Za-z0-9][A-Za-z0-9_-]{0,239}$/.test(value.runId || "")
    && typeof value.keyword === "string" && value.keyword === value.keyword.trim() && value.keyword.length > 0 && value.keyword.length <= 160 && !/[\u0000-\u001f\u007f]/.test(value.keyword)
    && SHA.test(value.manifestSha256 || "") && value.status === "complete" && value.quality === "complete" && value.postprocessStatus === "complete" && validIso(value.finishedAt)
    && (value.scheduleOccurrenceId == null || typeof value.scheduleOccurrenceId === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,239}$/.test(value.scheduleOccurrenceId)), "KEYWORD_MONTHLY_REFRESH_COMPLETION_EVIDENCE_REQUIRED");
  const out = Object.fromEntries(["runId", "keyword", "manifestSha256", "scheduleOccurrenceId", "status", "quality", "postprocessStatus", "finishedAt", "stayStartDate", "stayEndDate"].filter(k => Object.hasOwn(value, k)).map(k => [k, value[k]]));
  out.scheduleOccurrenceId ??= null; return out;
}
function sourceKey(evidence) { const value = validateEvidence(evidence); return hash(JSON.stringify([VERSION, value.runId, value.manifestSha256, value.keyword])); }
function rangeFromManifest(manifest, evidence) {
  need(manifest?.keyword === evidence.keyword && manifest.collectionQuality?.status === "complete" && manifest.collectionFailed !== true && validDay(manifest.checkIn), "KEYWORD_MONTHLY_REFRESH_MANIFEST_SCOPE_MISMATCH");
  const days = Number(manifest.bookingRangeDays);
  need((typeof manifest.bookingRangeDays === "number" || typeof manifest.bookingRangeDays === "string" && /^\d+$/.test(manifest.bookingRangeDays)) && Number.isSafeInteger(days) && days >= 1 && days <= LIMITS.bookingDays, "KEYWORD_MONTHLY_REFRESH_RECORDED_STAY_RANGE_REQUIRED");
  const start = Date.parse(manifest.checkIn + "T00:00:00Z"), dates = Array.from({ length: days }, (_, i) => new Date(start + i * 86400000).toISOString().slice(0, 10));
  need(dates.every(validDay) && (!evidence.stayStartDate || evidence.stayStartDate === dates[0]) && (!evidence.stayEndDate || evidence.stayEndDate === dates.at(-1)), "KEYWORD_MONTHLY_REFRESH_MANIFEST_SCOPE_MISMATCH");
  for (const id of [manifest.scheduleOccurrenceId, manifest.schedulingReceipt?.scheduleOccurrenceId].filter(v => v !== undefined)) need(id === evidence.scheduleOccurrenceId, "KEYWORD_MONTHLY_REFRESH_OCCURRENCE_MISMATCH");
  const observedAt = [manifest.collectedAt, manifest.completedAt, manifest.startedAt].find(validIso);
  need(observedAt && Date.parse(observedAt) <= Date.parse(evidence.finishedAt), "KEYWORD_MONTHLY_REFRESH_RECORDED_COLLECTION_TIME_REQUIRED");
  const collectionMonth = new Date(Date.parse(observedAt) + 9 * 3600000).toISOString().slice(0, 7);
  return { firstStayDate: dates[0], lastStayDate: dates.at(-1), recordedBookingDays: days, stayMonths: [...new Set(dates.map(d => d.slice(0, 7)))].sort(), collectionMonth, collectionObservedAt: observedAt };
}
function selectCandidates(discovery, keyword, range, catalog) {
  const direct = new Set([...range.stayMonths, range.collectionMonth]), wanted = new Set(direct), existing = new Set(catalog.scopes.filter(s => s.keyword === keyword).map(s => s.month));
  for (const month of direct) { const next = nextMonth(month); if (existing.has(next)) wanted.add(next); }
  const candidates = discovery.candidates.filter(row => row.keyword === keyword && wanted.has(row.month));
  need(candidates.length > 0 && candidates.length <= LIMITS.candidates && wanted.size <= LIMITS.candidates && [...wanted].every(month => candidates.some(c => c.month === month)), "KEYWORD_MONTHLY_REFRESH_AFFECTED_SCOPE_NOT_DISCOVERED");
  need(new Set(candidates.map(scopeId)).size === candidates.length, "KEYWORD_MONTHLY_REFRESH_DUPLICATE_SCOPE");
  return { candidates, directMonths: [...direct].sort(), successorMonths: [...wanted].filter(month => !direct.has(month)).sort(), wantedMonths: [...wanted].sort() };
}
function mergeInputs(bundle, replacements) {
  need(Array.isArray(replacements) && replacements.length > 0 && replacements.every(r => Array.isArray(r.exposeScopes) && r.exposeScopes.length === 1), "KEYWORD_MONTHLY_REFRESH_PREPARATION_INVALID");
  const replaceIds = new Set(replacements.flatMap(row => row.exposeScopes.map(scopeId))); need(replaceIds.size === replacements.length, "KEYWORD_MONTHLY_REFRESH_DUPLICATE_SCOPE");
  const kept = new Map();
  for (const scope of bundle.catalog.scopes) if (!replaceIds.has(scopeId(scope))) {
    const row = kept.get(scope.partition) || { directory: path.join(bundle.generationDir, "partitions", scope.partition), exposeScopes: [] };
    row.exposeScopes.push({ keyword: scope.keyword, month: scope.month }); kept.set(scope.partition, row);
  }
  return [...kept.values(), ...replacements];
}
module.exports = { VERSION, LIMITS, SHA, MONTH, hash, scopeId, same, identity, fault, need, validDay, validIso, nextMonth, absolute, inside, checked, read, writeNew, ensurePrivateDirectory, validateEvidence, sourceKey, rangeFromManifest, selectCandidates, mergeInputs };
