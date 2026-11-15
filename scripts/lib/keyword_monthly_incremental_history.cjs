"use strict";
// Immutable, compressed physical-row batches. Ingestion reads only newly
// committed rows; monthly readers traverse only the requested saved segments.
// Source order and JSON property order are part of the observation contract.
const fs = require("node:fs/promises"), path = require("node:path"), crypto = require("node:crypto"), zlib = require("node:zlib");
const H = require("./keyword_monthly_refresh_preparation.cjs");
const VERSION = "keyword-monthly-incremental-history-v1", MAX_BATCH = 8 * 1024 * 1024, MAX_STATE = 16 * 1024 * 1024;
const hash = b => crypto.createHash("sha256").update(b).digest("hex"), plain = v => v && typeof v === "object" && !Array.isArray(v);
const token = v => String(v || "").normalize("NFKC").replace(/\s+/g, "").toLowerCase();
const need = v => H.need(v, "KEYWORD_INCREMENTAL_HISTORY_INVALID");
function empty() { return { version: VERSION, generation: 0, lastOrdinal: 0, malformedHistoryLines: 0, blankLines: 0, rows: 0, batches: [], partitions: [] }; }
function validate(state) {
  need(state?.version === VERSION && Number.isSafeInteger(state.generation) && state.generation >= 0 && Number.isSafeInteger(state.lastOrdinal) && state.lastOrdinal >= 0
    && Number.isSafeInteger(state.malformedHistoryLines) && state.malformedHistoryLines >= 0 && Number.isSafeInteger(state.rows) && state.rows >= 0
    && Array.isArray(state.batches) && state.batches.length <= 100000 && Array.isArray(state.partitions) && state.partitions.length <= 100000);
  let last = 0; const ids = new Set();
  for (const batch of state.batches) {
    need(batch.firstOrdinal > last && batch.lastOrdinal >= batch.firstOrdinal && Array.isArray(batch.segments)); last = batch.lastOrdinal;
    for (const s of batch.segments) need(H.SHA.test(s.sha256) && H.SHA.test(s.key) && s.bytes > 0 && s.bytes <= MAX_BATCH && s.rawBytes > 0 && s.rawBytes <= MAX_BATCH && Number.isSafeInteger(s.count) && s.count > 0);
  }
  need(last <= state.lastOrdinal);
  for (const p of state.partitions) { need(H.SHA.test(p.key) && H.SHA.test(p.digest) && !ids.has(p.key) && p.count > 0 && Array.isArray(p.runIds)); ids.add(p.key); }
  need(Buffer.byteLength(JSON.stringify(state)) <= MAX_STATE); return state;
}
async function writeBlob(directory, bytes, { beforeNewBlob = null } = {}) {
  need(beforeNewBlob === null || typeof beforeNewBlob === "function");
  const sha256 = hash(bytes), file = path.join(directory, sha256 + ".json.gz");
  try { const old = await H.checked(file); need(old.size === bytes.length); need(hash(await fs.readFile(file)) === sha256); }
  catch (e) { if (e.code !== "ENOENT") throw e; if (beforeNewBlob) await beforeNewBlob(file, bytes.length); const handle = await fs.open(file, "wx", 0o600); try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); } need(hash(await fs.readFile(file)) === sha256); }
  if (process.platform !== "win32") { const parent = await fs.open(directory, require("node:fs").constants.O_RDONLY); try { await parent.sync(); } finally { await parent.close(); } }
  return { sha256, bytes: bytes.length };
}
// lines includes every physical line, including blanks/non-objects. Retry is
// handled by the state event ledger, never by dropping duplicate source rows.
async function append(directory, previous, lines, { beforeNewBlob = null } = {}) {
  need(beforeNewBlob === null || typeof beforeNewBlob === "function");
  validate(previous); need(Array.isArray(lines)); await H.checked(directory, true);
  const state = structuredClone(previous), partitions = new Map(state.partitions.map(p => [p.key, p])), groups = new Map(); let batchBytes = 0, firstOrdinal = 0;
  async function flush() {
    if (!groups.size) return;
    const segments = [];
    for (const [key, rows] of groups) {
      const raw = Buffer.from(JSON.stringify(rows)); need(raw.length <= MAX_BATCH);
      const blob = await writeBlob(directory, zlib.gzipSync(raw), { beforeNewBlob });
      segments.push({ ...blob, rawBytes: raw.length, count: rows.length, key, month: partitions.get(key).month });
    }
    state.batches.push({ firstOrdinal, lastOrdinal: state.lastOrdinal, segments }); groups.clear(); batchBytes = 0; firstOrdinal = 0;
  }
  for (const line of lines) {
    need(typeof line === "string" && Buffer.byteLength(line) <= 1024 * 1024);
    const encodedBytes = Buffer.byteLength(JSON.stringify([state.lastOrdinal + 1, line])) + 2;
    if (batchBytes + encodedBytes > MAX_BATCH - 65536) await flush();
    const ordinal = ++state.lastOrdinal;
    if (!line.trim()) { state.blankLines++; continue; }
    let row; try { row = JSON.parse(line.replace(/^\uFEFF/, "")); } catch { state.malformedHistoryLines++; continue; }
    if (!plain(row)) { state.malformedHistoryLines++; continue; }
    const date = String(row.stayDate || row.date || ""), candidate = date.slice(0, 7), month = /^\d{4}-(0[1-9]|1[0-2])$/.test(candidate) && date.startsWith(candidate + "-") ? candidate : "";
    const header = Object.fromEntries(["companyKey", "companyId", "placeId", "place_id"].filter(k => Object.hasOwn(row, k)).map(k => [k, row[k]]));
    const key = hash(JSON.stringify([header, month]));
    let p = partitions.get(key);
    if (!p) { p = { key, ...header, month, digest: hash(VERSION), count: 0, runIds: [], keywords: [] }; partitions.set(key, p); }
    // This is a versioned chain digest, not the old index's raw SHA digest.
    p.digest = hash(p.digest + String(ordinal) + ":" + line + "\n"); p.count++;
    if (row.runId && !p.runIds.includes(String(row.runId))) p.runIds.push(String(row.runId));
    if (row.keyword && !(p.keywords || (p.keywords = [])).includes(String(row.keyword))) p.keywords.push(String(row.keyword));
    if (!firstOrdinal) firstOrdinal = ordinal;
    const list = groups.get(key) || []; list.push([ordinal, line]); groups.set(key, list); batchBytes += encodedBytes; state.rows++;
  }
  await flush(); state.partitions = [...partitions.values()].map(p => ({ ...p, runIds: p.runIds.sort() })).sort((a, b) => a.key.localeCompare(b.key)); state.generation++;
  return validate(state);
}
function createReader({ directory, state, assertCurrent = async () => {} }) {
  validate(state); const digest = hash(JSON.stringify(state));
  const counters = { sourceReads: 0, bytesReadOriginal: 0, segmentReads: 0, segmentBytes: 0, rowsRead: 0, headersRead: 0 };
  const descriptor = () => ({ ready: true, version: VERSION, generation: state.generation, contentDigest: digest, source: { signature: digest }, malformedHistoryLines: state.malformedHistoryLines, rows: state.rows });
  async function read(query, consume, kind) {
    await assertCurrent(); need(typeof consume === "function"); const q = query || {};
    if (q.parseMode && q.parseMode !== "monthly") throw H.fault("KEYWORD_INCREMENTAL_HISTORY_MODE_DENIED");
    if (q.month !== undefined && !/^\d{4}-(0[1-9]|1[0-2])$/.test(q.month)) throw new TypeError("Invalid month");
    if (q.partitionKey !== undefined && !H.SHA.test(q.partitionKey)) throw new TypeError("Invalid partitionKey");
    const refs = q.refs === undefined ? null : new Set((Array.isArray(q.refs) || q.refs instanceof Set ? [...q.refs] : Object.values(q.refs).flatMap(v => Array.isArray(v) || v instanceof Set ? [...v] : [v])).map(token));
    if (refs && refs.size > 4000) throw new TypeError("Too many refs");
    const matching = row => {
      if (q.runId !== undefined && String(row.runId || "") !== String(q.runId)) return false;
      if (!refs) return true;
      const key = token(row.companyKey || row.companyId), inferred = key.match(/^cmp_place_(.+)$/)?.[1] || (/^\d+$/.test(key) ? key : "");
      return [row.companyKey, row.companyId, row.placeId, row.place_id, inferred].map(token).some(x => refs.has(x));
    };
    let selectedRows = 0;
    for (const batch of state.batches) {
      const rows = [];
      for (const s of batch.segments) {
        if (q.month !== undefined && s.month !== q.month || q.partitionKey !== undefined && s.key !== q.partitionKey) continue;
        const file = path.join(directory, s.sha256 + ".json.gz"), before = await H.checked(file); need(before.size === s.bytes);
        const bytes = await fs.readFile(file); need(hash(bytes) === s.sha256 && H.same(before, await H.checked(file)));
        const raw = zlib.gunzipSync(bytes, { maxOutputLength: MAX_BATCH }); need(raw.length === s.rawBytes); const parsed = JSON.parse(raw); need(Array.isArray(parsed) && parsed.length === s.count);
        rows.push(...parsed); counters.segmentReads++; counters.segmentBytes += bytes.length;
      }
      rows.sort((a, b) => a[0] - b[0]);
      for (const [ordinal, line] of rows) {
        const row = JSON.parse(line.replace(/^\uFEFF/, "")); if (!matching(row)) continue;
        if (kind === "headers") { const h = Object.fromEntries(["companyKey", "companyId", "placeId", "place_id", "stayDate", "date", "runId"].filter(k => Object.hasOwn(row, k)).map(k => [k, row[k]])); await consume(h, ordinal); counters.headersRead++; }
        else if (kind === "lines") await consume(line, row, ordinal); else await consume(row, ordinal);
        counters.rowsRead++; selectedRows++;
      }
    }
    await assertCurrent(); return { ...descriptor(), selectedRows, stats: { ...counters } };
  }
  return { ensure: async () => { await assertCurrent(); return descriptor(); }, readRows: (q, c) => read(q, c, "rows"), readLines: (q, c) => read(q, c, "lines"), readHeaders: (q, c) => read(q, c, "headers"),
    revisionPartitions: async () => { await assertCurrent(); return { ...descriptor(), partitions: structuredClone(state.partitions) }; },
    listMonths: async () => [...new Set(state.partitions.map(p => p.month).filter(Boolean))].sort().reverse(), stats: () => ({ ...counters }), close: async () => {} };
}
module.exports = { VERSION, MAX_BATCH, MAX_STATE, empty, validate, append, createReader, writeBlob };
