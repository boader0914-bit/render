"use strict";

// Rebuildable indexes only. observations.jsonl remains the authoritative input.
// Keep physical rows: monthly reports and legacy detail readers deliberately
// have different duplicate-ID, BOM, date and company-identity contracts.
const fs = require("node:fs/promises"), native = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");
const VERSION = "history-observation-index-v1";
const EMPTY_CHAIN = crypto.createHash("sha256").update(VERSION).digest("hex");
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const clone = value => JSON.parse(JSON.stringify(value));
const fault = (code, cause) => Object.assign(new Error(code, cause ? { cause } : undefined), { code, statusCode: 503 });
const token = value => String(value || "").normalize("NFKC").replace(/\s+/g, "").toLowerCase();
const object = value => value && typeof value === "object" && !Array.isArray(value);
const monthValid = value => /^\d{4}-(0[1-9]|1[0-2])$/.test(value || "");
const signature = stat => `${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}:${stat.ino}:${stat.dev}`;
function sourceOf(stat) {
  const size = Number(stat.size);
  if (!Number.isSafeInteger(size) || size < 0) throw fault("HISTORY_OBSERVATION_SOURCE_TOO_LARGE");
  return { signature: signature(stat), size, dev: String(stat.dev), ino: String(stat.ino), mtimeNs: String(stat.mtimeNs), ctimeNs: String(stat.ctimeNs) };
}
function typedId(value) {
  if (!value) return null;
  if (typeof value === "string") return "s:" + value;
  if (typeof value === "number") return "n:" + String(value);
  if (typeof value === "boolean") return "b:" + String(value);
  // Parsed object/array IDs are distinct JS references on every physical row.
  // They cannot equal a caller's object by content and must never be merged.
  return null;
}
function parseLine(line, ordinal, mode) {
  if (!line.trim()) return { blank: true, row: null, validJson: false, validObject: false };
  const text = mode === "monthly" || mode === "append" && ordinal === 1 ? line.replace(/^\uFEFF/, "") : line;
  try { const row = JSON.parse(text); return { blank: false, row, validJson: true, validObject: Boolean(object(row)) }; }
  catch { return { blank: false, row: null, validJson: false, validObject: false }; }
}

function createHistoryObservationIndex({ file, indexFile, checkpoint = async () => {}, fileSystem = fs,
  maxLineBytes = 32 * 1024 * 1024, onBeforePublish = null, busyTimeoutMs = 1000 } = {}) {
  if (typeof file !== "string" || !file || typeof indexFile !== "string" || !indexFile || path.resolve(file) === path.resolve(indexFile)) throw new TypeError("Distinct file and indexFile are required");
  if (typeof checkpoint !== "function" || !Number.isSafeInteger(maxLineBytes) || maxLineBytes < 1) throw new TypeError("Invalid index options");
  file = path.resolve(file); indexFile = path.resolve(indexFile);
  let db = null, closed = false, serial = Promise.resolve(), last = null;
  const counters = { sourceReads: 0, bytesReadOriginal: 0, rebuilt: 0, incremental: 0, unchanged: 0, rowsRead: 0, headersRead: 0, idLookups: 0,
    partitionsRehashed: 0, partitionRowsRead: 0 };
  const schedule = work => {
    const pending = serial.then(() => { if (closed) throw fault("HISTORY_OBSERVATION_INDEX_CLOSED"); return work(); });
    serial = pending.catch(() => {}); return pending;
  };
  async function sourceStat() {
    try {
      const stat = await fileSystem.lstat(file, { bigint: true });
      if (!stat.isFile() || stat.isSymbolicLink()) throw fault("HISTORY_OBSERVATION_SOURCE_INVALID");
      return sourceOf(stat);
    } catch (error) { if (error.code === "ENOENT") return null; throw error?.code?.startsWith("HISTORY_OBSERVATION_") ? error : fault("HISTORY_OBSERVATION_SOURCE_UNAVAILABLE", error); }
  }
  const sameSource = (a, b) => a?.signature === b?.signature && Boolean(a) === Boolean(b);
  async function connect() {
    if (db) return;
    await fileSystem.mkdir(path.dirname(indexFile), { recursive: true });
    let existing = null;
    try { existing = await fileSystem.lstat(indexFile, { bigint: true }); }
    catch (error) { if (error.code !== "ENOENT") throw fault("HISTORY_OBSERVATION_INDEX_UNAVAILABLE", error); }
    if (existing && (!existing.isFile() || existing.isSymbolicLink() || existing.size === 0n)) throw fault("HISTORY_OBSERVATION_INDEX_INVALID");
    try {
      db = new DatabaseSync(indexFile);
      db.exec(`PRAGMA busy_timeout=${Math.max(0, Math.min(5000, Number(busyTimeoutMs) || 0))}; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA cache_size=-4096; PRAGMA mmap_size=0; PRAGMA temp_store=FILE;`);
      if (existing) {
        const check = db.prepare("PRAGMA quick_check").get();
        if (!check || Object.values(check)[0] !== "ok") throw fault("HISTORY_OBSERVATION_INDEX_INVALID");
        const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name);
        if (!tables.includes("metadata") || !tables.includes("physical_rows") || !tables.includes("raw_partitions")) throw fault("HISTORY_OBSERVATION_INDEX_INVALID");
      } else {
        db.exec(`CREATE TABLE IF NOT EXISTS metadata (id INTEGER PRIMARY KEY CHECK(id=1), payload TEXT NOT NULL, checksum TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS physical_rows (
            ordinal INTEGER PRIMARY KEY, start_offset INTEGER NOT NULL, end_offset INTEGER NOT NULL,
            rawline TEXT NOT NULL, line_hash TEXT NOT NULL, chain_hash TEXT NOT NULL, header TEXT NOT NULL, header_hash TEXT NOT NULL,
            monthly_object INTEGER NOT NULL, append_json INTEGER NOT NULL, detail_object INTEGER NOT NULL,
            blank INTEGER NOT NULL, monthly_month TEXT, options_month TEXT, run_id TEXT,
            company_key TEXT, company_id TEXT, place_id TEXT, alternate_place_id TEXT, inferred_place TEXT, append_id TEXT, revision_key TEXT);
          CREATE TABLE IF NOT EXISTS raw_partitions (partition_key TEXT PRIMARY KEY, identity_header TEXT NOT NULL, month TEXT NOT NULL,
            digest TEXT NOT NULL, row_count INTEGER NOT NULL, run_ids TEXT NOT NULL, checksum TEXT NOT NULL);
          CREATE INDEX IF NOT EXISTS history_month ON physical_rows(monthly_month,ordinal);
          CREATE INDEX IF NOT EXISTS history_offsets ON physical_rows(start_offset,ordinal);
          CREATE INDEX IF NOT EXISTS history_option_month ON physical_rows(options_month);
          CREATE INDEX IF NOT EXISTS history_run ON physical_rows(run_id,ordinal);
          CREATE INDEX IF NOT EXISTS history_company_key ON physical_rows(company_key,monthly_month,ordinal);
          CREATE INDEX IF NOT EXISTS history_company_id ON physical_rows(company_id,monthly_month,ordinal);
          CREATE INDEX IF NOT EXISTS history_place ON physical_rows(place_id,monthly_month,ordinal);
          CREATE INDEX IF NOT EXISTS history_alternate_place ON physical_rows(alternate_place_id,monthly_month,ordinal);
          CREATE INDEX IF NOT EXISTS history_inferred_place ON physical_rows(inferred_place,monthly_month,ordinal);
          CREATE INDEX IF NOT EXISTS history_append_id ON physical_rows(append_id);
          CREATE INDEX IF NOT EXISTS history_revision_partition ON physical_rows(revision_key,ordinal);`);
        await fileSystem.chmod?.(indexFile, 0o600);
      }
    } catch (error) {
      try { db?.close(); } catch {} db = null;
      throw error?.code?.startsWith("HISTORY_OBSERVATION_") ? error : fault("HISTORY_OBSERVATION_INDEX_INVALID", error);
    }
  }
  function readMetadata() {
    try {
      const stored = db.prepare("SELECT payload,checksum FROM metadata WHERE id=1").get();
      if (!stored) return null;
      if (hash(stored.payload) !== stored.checksum) throw fault("HISTORY_OBSERVATION_INDEX_INVALID");
      const value = JSON.parse(stored.payload);
      if (value.version !== VERSION || !Number.isSafeInteger(value.rows) || value.rows < 0 || !Number.isSafeInteger(value.generation)
        || !/^[a-f0-9]{64}$/.test(value.chain || "") || !Number.isSafeInteger(value.tailStart) || value.tailStart < 0
        || !Number.isSafeInteger(value.malformedLines) || !Number.isSafeInteger(value.blankLines)
        || typeof value.endsWithCR !== "boolean" || !Number.isSafeInteger(value.lastRowStart) || value.lastRowStart < 0
        || value.source && (typeof value.source.signature !== "string" || !Number.isSafeInteger(value.source.size) || value.tailStart > value.source.size || value.lastRowStart > value.source.size)
        || !value.source && value.rows !== 0) throw fault("HISTORY_OBSERVATION_INDEX_INVALID");
      return value;
    } catch (error) { throw error?.code?.startsWith("HISTORY_OBSERVATION_") ? error : fault("HISTORY_OBSERVATION_INDEX_INVALID", error); }
  }
  function publish(value) {
    const encoded = JSON.stringify(value);
    db.prepare("INSERT INTO metadata(id,payload,checksum) VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,checksum=excluded.checksum").run(encoded, hash(encoded));
  }
  function describeMeta(value, mode) {
    return { ...clone(value), contentDigest: hash(JSON.stringify([VERSION, value.source ? "present" : "missing", value.chain])),
      contentDigestKind: "ordered-normalized-lines-v1", malformedHistoryLines: value.malformedLines, mode, stats: { ...counters } };
  }
  async function assertSource(expected) {
    if (!sameSource(expected, await sourceStat())) throw fault("HISTORY_OBSERVATION_SOURCE_CHANGED");
  }
  async function scanRange(start, consume, localCheckpoint) {
    const handle = await fileSystem.open(file, native.constants.O_RDONLY | (native.constants.O_NOFOLLOW || 0));
    counters.sourceReads++;
    let offset = start, pending = Buffer.alloc(0), pendingStart = start, ordinal = 0, linesSinceCheckpoint = 0;
    const buffer = Buffer.allocUnsafe(64 * 1024);
    try {
      const opened = sourceOf(await handle.stat({ bigint: true }));
      await assertSource(opened);
      while (true) {
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
        if (!bytesRead) break;
        counters.bytesReadOriginal += bytesRead; offset += bytesRead;
        pending = pending.length ? Buffer.concat([pending, buffer.subarray(0, bytesRead)]) : Buffer.from(buffer.subarray(0, bytesRead));
        let cursor = 0;
        while (cursor < pending.length) {
          const lf = pending.indexOf(10, cursor), cr = pending.indexOf(13, cursor);
          const end = lf < 0 ? cr : cr < 0 ? lf : Math.min(lf, cr);
          if (end < 0 || pending[end] === 13 && end + 1 === pending.length) break;
          if (end - cursor > maxLineBytes) throw fault("HISTORY_OBSERVATION_LINE_TOO_LARGE");
          const next = end + (pending[end] === 13 && pending[end + 1] === 10 ? 2 : 1);
          await consume(pending.subarray(cursor, end).toString("utf8"), pendingStart + cursor, pendingStart + next, false,
            pending[end] === 13 ? next - end === 2 ? "\r\n" : "\r" : "\n");
          ordinal++; linesSinceCheckpoint++;
          if (linesSinceCheckpoint >= 256) { linesSinceCheckpoint = 0; await new Promise(resolve => setImmediate(resolve)); await localCheckpoint(); }
          cursor = next;
        }
        if (cursor) { pending = Buffer.from(pending.subarray(cursor)); pendingStart += cursor; }
        if (pending.length > maxLineBytes + 1) throw fault("HISTORY_OBSERVATION_LINE_TOO_LARGE");
      }
      if (pending.length) {
        const terminated = pending[pending.length - 1] === 13;
        const line = terminated ? pending.subarray(0, -1) : pending;
        if (line.length > maxLineBytes) throw fault("HISTORY_OBSERVATION_LINE_TOO_LARGE");
        await consume(line.toString("utf8"), pendingStart, offset, !terminated, terminated ? "\r" : ""); ordinal++;
      }
      if (!sameSource(opened, sourceOf(await handle.stat({ bigint: true })))) throw fault("HISTORY_OBSERVATION_SOURCE_CHANGED");
      await assertSource(opened);
      return { source: opened, scannedLines: ordinal };
    } finally { await handle.close(); }
  }
  function writer(startOrdinal, chain) {
    const insert = db.prepare(`INSERT INTO physical_rows VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    let ordinal = startOrdinal, tailStart = 0, needsSeparator = false, endsWithCR = false, lastRowStart = 0;
    const partitions = new Map(); let added = 0, blanks = 0, malformed = 0;
    const put = async (rawline, start, end, unterminated, terminator) => {
      ordinal++;
      const monthly = parseLine(rawline, ordinal, "monthly"), append = parseLine(rawline, ordinal, "append"), detail = parseLine(rawline, ordinal, "detail");
      const row = monthly.validObject ? monthly.row : {}, value = String(row.stayDate || row.date || ""), candidateMonth = value.slice(0, 7);
      const monthlyMonth = monthValid(candidateMonth) && value.startsWith(candidateMonth + "-") ? candidateMonth : null;
      const header = Object.fromEntries(["companyKey", "companyId", "placeId", "place_id", "stayDate", "date", "runId"].filter(key => Object.prototype.hasOwnProperty.call(row, key)).map(key => [key, row[key]]));
      // Even an invalid/missing day can change a month's discarded evidence or
      // latest-attempt diagnostics. Follow the report's month-prefix scope.
      const revisionMonth = monthlyMonth;
      const identityHeader = Object.fromEntries(["companyKey", "companyId", "placeId", "place_id"].filter(key => Object.prototype.hasOwnProperty.call(row, key)).map(key => [key, row[key]]));
      // Capacity evidence is valid without a stay date. Retain an empty-month
      // partition for every such object; monthly revision consumers skip it.
      const revisionKey = monthly.validObject ? hash(JSON.stringify([identityHeader, revisionMonth || ""])) : null;
      if (revisionKey) partitions.set(revisionKey, { header: identityHeader, month: revisionMonth || "" });
      added++; if (monthly.blank) blanks++; else if (!monthly.validObject) malformed++;
      const lineHash = hash(rawline + "\n"); chain = hash(chain + lineHash);
      const encodedHeader = JSON.stringify(header), key = token(row.companyKey || row.companyId), inferredPlace = key.match(/^cmp_place_(.+)$/)?.[1] || (/^\d+$/.test(key) ? key : "");
      insert.run(ordinal, start, end, rawline, lineHash, chain, encodedHeader, hash(encodedHeader), Number(monthly.validObject), Number(append.validJson), Number(detail.validObject),
        Number(monthly.blank), monthlyMonth, monthValid(candidateMonth) ? candidateMonth : null, String(row.runId || ""),
        token(row.companyKey), token(row.companyId), token(row.placeId), token(row.place_id), inferredPlace, append.validJson ? typedId(append.row?.observationId) : null, revisionKey);
      tailStart = unterminated ? start : end; needsSeparator = unterminated; endsWithCR = terminator === "\r"; lastRowStart = start;
    };
    return { put, finish: () => ({ ordinal, chain, tailStart, needsSeparator, endsWithCR, lastRowStart, added, blanks, malformed, partitions }) };
  }
  function bodyFromRows(source, generation, state, prefix = { rows: 0, malformedLines: 0, blankLines: 0 }) {
    return { version: VERSION, generation, source, rows: prefix.rows + state.added, lastOrdinal: state.ordinal,
      chain: state.chain, malformedLines: prefix.malformedLines + state.malformed, blankLines: prefix.blankLines + state.blanks,
      tailStart: state.needsSeparator ? state.tailStart : source?.size || 0, needsSeparator: state.needsSeparator,
      endsWithCR: state.endsWithCR, lastRowStart: state.lastRowStart };
  }
  async function updatePartitions(changed, localCheckpoint) {
    const getOld = db.prepare("SELECT identity_header,month FROM raw_partitions WHERE partition_key=?");
    const rows = db.prepare("SELECT ordinal,rawline,header FROM physical_rows WHERE revision_key=? ORDER BY ordinal");
    const insert = db.prepare("INSERT INTO raw_partitions VALUES(?,?,?,?,?,?,?) ON CONFLICT(partition_key) DO UPDATE SET identity_header=excluded.identity_header,month=excluded.month,digest=excluded.digest,row_count=excluded.row_count,run_ids=excluded.run_ids,checksum=excluded.checksum");
    let scanned = 0;
    for (const [key, information] of changed) {
      counters.partitionsRehashed++;
      const old = information || getOld.get(key), digest = crypto.createHash("sha256"), runIds = new Set(); let count = 0;
      for (const entry of rows.iterate(key)) {
        counters.partitionRowsRead++;
        digest.update(String(entry.ordinal) + ":" + entry.rawline + "\n");
        const header = JSON.parse(entry.header); if (header.runId) runIds.add(String(header.runId)); count++;
        if (++scanned % 256 === 0) { await new Promise(resolve => setImmediate(resolve)); await localCheckpoint(); }
      }
      if (!count) { db.prepare("DELETE FROM raw_partitions WHERE partition_key=?").run(key); continue; }
      if (!old) throw fault("HISTORY_OBSERVATION_INDEX_INVALID");
      const encoded = old.header ? JSON.stringify(old.header) : old.identity_header;
      const payload = [key, encoded, old.month, digest.digest("hex"), count, JSON.stringify([...runIds].sort())];
      insert.run(...payload, hash(JSON.stringify(payload)));
    }
  }
  async function rebuild(old, current, localCheckpoint) {
    let transaction = false;
    try {
      db.exec("BEGIN IMMEDIATE"); transaction = true;
      // Another index instance may have completed the same rebuild while this
      // instance was waiting for the SQLite writer lock.
      const latest = readMetadata();
      if (latest && sameSource(latest.source, current)) { db.exec("COMMIT"); transaction = false; counters.unchanged++; return describeMeta(latest, "unchanged"); }
      await assertSource(current);
      db.exec("DELETE FROM physical_rows; DELETE FROM raw_partitions");
      const output = writer(0, EMPTY_CHAIN);
      if (current) {
        const scanned = await scanRange(0, output.put, localCheckpoint);
        if (!sameSource(current, scanned.source)) throw fault("HISTORY_OBSERVATION_SOURCE_CHANGED");
      }
      const state = output.finish(); await updatePartitions(state.partitions, localCheckpoint);
      const value = bodyFromRows(current, (latest?.generation || old?.generation || 0) + 1, state);
      if (onBeforePublish) await onBeforePublish({ mode: "rebuilt", source: clone(current), rows: value.rows });
      await assertSource(current); publish(value); db.exec("COMMIT"); transaction = false;
      counters.rebuilt++; return describeMeta(value, "rebuilt");
    } catch (error) {
      if (transaction) { try { db.exec("ROLLBACK"); } catch {} }
      throw error?.code?.startsWith("HISTORY_OBSERVATION_") ? error : fault("HISTORY_OBSERVATION_INDEX_WRITE_FAILED", error);
    }
  }
  async function ensureOwned(localCheckpoint = checkpoint) {
    await connect();
    const old = readMetadata(), current = await sourceStat();
    if (old?.source && !current) throw fault("HISTORY_OBSERVATION_SOURCE_MISSING");
    let result;
    if (old && sameSource(old.source, current)) { counters.unchanged++; result = describeMeta(old, "unchanged"); }
    else result = await rebuild(old, current, localCheckpoint);
    last = result; return clone(result);
  }
  function queryParts(query = {}) {
    const mode = query.parseMode || "monthly";
    if (!["monthly", "append", "detail"].includes(mode)) throw new TypeError("Invalid parseMode");
    const where = [mode === "monthly" ? "monthly_object=1" : mode === "detail" ? "detail_object=1" : "append_json=1"], args = [];
    if (query.partitionKey !== undefined) {
      if (typeof query.partitionKey !== "string" || !/^[a-f0-9]{64}$/.test(query.partitionKey)) throw new TypeError("Invalid partitionKey");
      where.push("revision_key=?"); args.push(query.partitionKey);
    }
    if (query.month !== undefined) { if (!monthValid(query.month)) throw new TypeError("Invalid month"); where.push("monthly_month=?"); args.push(query.month); }
    if (query.runId !== undefined) { where.push("run_id=?"); args.push(String(query.runId)); }
    if (query.refs !== undefined) {
      const input = Array.isArray(query.refs) || query.refs instanceof Set ? [...query.refs]
        : object(query.refs) ? Object.values(query.refs).flatMap(value => Array.isArray(value) || value instanceof Set ? [...value] : [value]) : null;
      if (!input) throw new TypeError("Invalid refs");
      const refs = [...new Set(input.map(token).filter(Boolean))];
      if (refs.length > 4000) throw new TypeError("Too many refs");
      if (!refs.length) where.push("0");
      else { const placeholders = refs.map(() => "?").join(",");
        // A common month can contain the complete database. Force each narrow
        // identity index before applying month/run conditions, rather than let
        // SQLite choose a full-month scan for the OR across identity columns.
        const choices = [["company_key", "history_company_key"], ["company_id", "history_company_id"], ["place_id", "history_place"], ["alternate_place_id", "history_alternate_place"], ["inferred_place", "history_inferred_place"]];
        where.push("ordinal IN (" + choices.map(([key, index]) => `SELECT ordinal FROM physical_rows INDEXED BY ${index} WHERE ${key} IN (${placeholders})`).join(" UNION ") + ")");
        for (let index = 0; index < choices.length; index++) args.push(...refs); }
    }
    return { mode, where: where.join(" AND "), args, indexHint: query.partitionKey === undefined ? "" : " INDEXED BY history_revision_partition" };
  }
  async function readOwned(query, consume, kind) {
    if (typeof consume !== "function") throw new TypeError("consume is required");
    const descriptor = await ensureOwned(), { mode, where, args, indexHint } = queryParts(query);
    const columns = kind === "headers" ? "ordinal,header,header_hash" : "ordinal,rawline,line_hash";
    let count = 0;
    try {
      for (const entry of db.prepare(`SELECT ${columns} FROM physical_rows${indexHint} WHERE ${where} ORDER BY ordinal`).iterate(...args)) {
        if (kind === "headers") { if (hash(entry.header) !== entry.header_hash) throw fault("HISTORY_OBSERVATION_INDEX_INVALID"); counters.headersRead++; await consume(JSON.parse(entry.header), Number(entry.ordinal)); }
        else {
          if (hash(entry.rawline + "\n") !== entry.line_hash) throw fault("HISTORY_OBSERVATION_INDEX_INVALID");
          const parsed = parseLine(entry.rawline, Number(entry.ordinal), mode);
          if (!parsed.validJson || mode !== "append" && !parsed.validObject) throw fault("HISTORY_OBSERVATION_INDEX_INVALID");
          counters.rowsRead++;
          if (kind === "lines") await consume(entry.rawline, parsed.row, Number(entry.ordinal)); else await consume(parsed.row, Number(entry.ordinal));
        }
        if (++count % 256 === 0) { await new Promise(resolve => setImmediate(resolve)); await checkpoint(); }
      }
      await assertSource(descriptor.source);
      return { ...descriptor, selectedRows: count, stats: { ...counters } };
    } catch (error) { throw error?.code?.startsWith("HISTORY_OBSERVATION_") ? error : fault("HISTORY_OBSERVATION_INDEX_READ_FAILED", error); }
  }
  async function findOwned({ observationIds, checkpoint: localCheckpoint = checkpoint } = {}) {
    if (!Array.isArray(observationIds) && !(observationIds instanceof Set) || typeof localCheckpoint !== "function") throw new TypeError("observationIds and checkpoint are required");
    const candidates = new Set(observationIds), existingIds = new Set();
    if (!candidates.size) return { existingIds, stats: { candidateCount: 0, scannedLines: 0, skippedEmptyCandidates: true }, needsSeparator: false };
    const descriptor = await ensureOwned(localCheckpoint), lookup = db.prepare("SELECT 1 AS present FROM physical_rows WHERE append_id=? LIMIT 1");
    let inspected = 0;
    for (const id of candidates) { const key = typedId(id); if (key && lookup.get(key)) existingIds.add(id); if (++inspected % 256 === 0) await localCheckpoint(); }
    counters.idLookups += inspected;
    await assertSource(descriptor.source);
    return { existingIds, stats: { candidateCount: candidates.size, scannedLines: 0, indexedRows: descriptor.rows, matchedRows: existingIds.size,
      retainedIdCount: existingIds.size, maxRetainedIds: existingIds.size, missingFile: !descriptor.source, skippedEmptyCandidates: false,
      indexed: true, bytesReadOriginal: counters.bytesReadOriginal }, needsSeparator: descriptor.needsSeparator };
  }
  async function appendOwned(payload, { checkpoint: localCheckpoint = checkpoint } = {}) {
    if (!Buffer.isBuffer(payload) && typeof payload !== "string" || typeof localCheckpoint !== "function") throw new TypeError("payload must be a Buffer or string");
    const bytes = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, "utf8");
    const before = await ensureOwned(localCheckpoint);
    if (!bytes.length) return { indexed: true, appendedBytes: 0, source: before.source, stats: { ...counters } };
    let transaction = false, sourceWriteAttempted = false, sourceDurable = false, handle = null;
    try {
      db.exec("BEGIN IMMEDIATE"); transaction = true;
      const latest = readMetadata();
      if (!latest || !sameSource(latest.source, before.source)) throw fault("HISTORY_OBSERVATION_SOURCE_CHANGED");
      await assertSource(before.source);
      await fileSystem.mkdir(path.dirname(file), { recursive: true });
      handle = await fileSystem.open(file, native.constants.O_WRONLY | native.constants.O_APPEND | native.constants.O_CREAT | (native.constants.O_NOFOLLOW || 0), 0o600);
      const opened = sourceOf(await handle.stat({ bigint: true }));
      if (before.source ? !sameSource(opened, before.source) : opened.size !== 0) throw fault("HISTORY_OBSERVATION_SOURCE_CHANGED");
      if (!sameSource(opened, await sourceStat())) throw fault("HISTORY_OBSERVATION_SOURCE_CHANGED");
      sourceWriteAttempted = true;
      await handle.writeFile(bytes); await handle.sync(); await handle.close(); handle = null; sourceDurable = true;
      const current = await sourceStat();
      if (!current || current.size !== (before.source?.size || 0) + bytes.length || current.ino !== opened.ino || current.dev !== opened.dev) throw fault("HISTORY_OBSERVATION_SOURCE_CHANGED");
      // A terminal CR followed by a newly appended LF is one old delimiter,
      // not a new blank row. Re-read that last physical line at this boundary.
      const start = before.needsSeparator ? before.tailStart : before.endsWithCR ? before.lastRowStart : before.source?.size || 0;
      const prefix = db.prepare("SELECT ordinal,chain_hash FROM physical_rows INDEXED BY history_offsets WHERE start_offset < ? ORDER BY start_offset DESC,ordinal DESC LIMIT 1").get(start);
      const deleted = db.prepare("SELECT COUNT(*) AS rows, SUM(blank) AS blanks, SUM(CASE WHEN blank=0 AND monthly_object=0 THEN 1 ELSE 0 END) AS malformed FROM physical_rows INDEXED BY history_offsets WHERE start_offset>=?").get(start);
      const touched = new Map(db.prepare("SELECT DISTINCT revision_key FROM physical_rows INDEXED BY history_offsets WHERE start_offset>=? AND revision_key IS NOT NULL").all(start).map(row => [row.revision_key, null]));
      db.prepare("DELETE FROM physical_rows INDEXED BY history_offsets WHERE start_offset>=?").run(start);
      const output = writer(Number(prefix?.ordinal || 0), prefix?.chain_hash || EMPTY_CHAIN);
      const scanned = await scanRange(start, output.put, localCheckpoint);
      if (!sameSource(scanned.source, current)) throw fault("HISTORY_OBSERVATION_SOURCE_CHANGED");
      const state = output.finish(); for (const [key, value] of state.partitions) touched.set(key, value);
      await updatePartitions(touched, localCheckpoint);
      const value = bodyFromRows(current, latest.generation + 1, state, { rows: latest.rows - Number(deleted.rows),
        malformedLines: latest.malformedLines - Number(deleted.malformed || 0), blankLines: latest.blankLines - Number(deleted.blanks || 0) });
      if (onBeforePublish) await onBeforePublish({ mode: "incremental", source: clone(current), rows: value.rows });
      await assertSource(current); publish(value); db.exec("COMMIT"); transaction = false;
      counters.incremental++; last = describeMeta(value, "incremental");
      return { indexed: true, appendedBytes: bytes.length, source: clone(current), descriptor: clone(last), stats: { ...counters } };
    } catch (error) {
      if (handle) await handle.close().catch(() => {});
      if (transaction) { try { db.exec("ROLLBACK"); } catch {} }
      // Never append source a second time to retry a failed derived write.
      // The next ensure sees its old source stamp and safely rebuilds.
      if (sourceDurable) return { indexed: false, appendedBytes: bytes.length, source: await sourceStat().catch(() => null),
        errorCode: error?.code?.startsWith("HISTORY_OBSERVATION_") ? error.code : "HISTORY_OBSERVATION_INDEX_WRITE_FAILED", stats: { ...counters } };
      if (sourceWriteAttempted) throw fault("HISTORY_OBSERVATION_SOURCE_APPEND_UNCERTAIN", error);
      throw error?.code?.startsWith("HISTORY_OBSERVATION_") ? error : fault("HISTORY_OBSERVATION_SOURCE_APPEND_FAILED", error);
    }
  }
  return {
    ensure: () => schedule(() => ensureOwned()),
    readRows: (query, consume) => schedule(() => readOwned(query || {}, consume, "rows")),
    readLines: (query, consume) => schedule(() => readOwned(query || {}, consume, "lines")),
    readHeaders: (query, consume) => schedule(() => readOwned(query || {}, consume, "headers")),
    revisionPartitions: () => schedule(async () => { const descriptor = await ensureOwned();
      const partitions = db.prepare("SELECT * FROM raw_partitions ORDER BY partition_key").all().map(row => {
        if (hash(JSON.stringify([row.partition_key, row.identity_header, row.month, row.digest, Number(row.row_count), row.run_ids])) !== row.checksum) throw fault("HISTORY_OBSERVATION_INDEX_INVALID");
        return { key: row.partition_key, ...JSON.parse(row.identity_header), month: row.month, digest: row.digest, count: Number(row.row_count), runIds: JSON.parse(row.run_ids) }; });
      await assertSource(descriptor.source); return { source: descriptor.source, contentDigest: descriptor.contentDigest,
        malformedLines: descriptor.malformedLines, malformedHistoryLines: descriptor.malformedLines, partitions }; }),
    listMonths: () => schedule(async () => { const descriptor = await ensureOwned(); const result = db.prepare("SELECT DISTINCT options_month AS month FROM physical_rows WHERE monthly_object=1 AND options_month IS NOT NULL ORDER BY options_month DESC").all().map(row => row.month); await assertSource(descriptor.source); return result; }),
    findObservationIds: options => schedule(() => findOwned(options)),
    append: (payload, options) => schedule(() => appendOwned(payload, options)),
    describe: () => last ? clone({ ...last, stats: { ...counters } }) : { version: VERSION, ready: false, stats: { ...counters } },
    stats: () => ({ ...counters }),
    close: () => schedule(() => { db?.close(); db = null; closed = true; })
  };
}

module.exports = { createHistoryObservationIndex, VERSION };
