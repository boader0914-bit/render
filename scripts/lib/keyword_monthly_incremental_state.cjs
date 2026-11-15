"use strict";
// Private derived source checkpoint. Never edits authoritative company/history
// files. Only explicit bootstrap reads their complete bodies. Normal admission
// follows exact before/after source stamps from immutable writer outbox events.
const fs = require("node:fs/promises"), native = require("node:fs"), path = require("node:path"), zlib = require("node:zlib"), crypto = require("node:crypto"), readline = require("node:readline");
const { PassThrough } = require("node:stream");
const H = require("./keyword_monthly_refresh_preparation.cjs"), history = require("./keyword_monthly_incremental_history.cjs");
const { readCompanyMasterProjection } = require("./company_master_stream.cjs");
const VERSION = "keyword-monthly-incremental-state-v1", MAX_STATE = 24 * 1024 * 1024, MAX_COMPANY = 32 * 1024 * 1024;
const BOOTSTRAP_LIMITS = Object.freeze({ sourceBytes: 2 * 1024 ** 3, milliseconds: 15 * 60 * 1000, reserveBytes: 512 * 1024 * 1024 });
const PERSISTENT_LIMITS = Object.freeze({ bytes: 960 * 1024 * 1024, reserveBytes: 512 * 1024 * 1024, depth: 20, entries: 200000 });
const hash = b => crypto.createHash("sha256").update(b).digest("hex"), need = (v, c = "KEYWORD_INCREMENTAL_STATE_INVALID") => H.need(v, c);
function validStamp(s) { return s === null || s && typeof s === "object" && !Array.isArray(s) && ["dev", "ino", "size", "mtimeNs", "ctimeNs", "nlink"].every(k => typeof s[k] === "string" && /^\d+$/.test(s[k])) && s.nlink === "1"; }
function sourceStamp(s) { if (s === null) return null; const value = Object.fromEntries(["dev", "ino", "size", "mtimeNs", "ctimeNs", "nlink"].map(k => [k, String(s?.[k])])); need(validStamp(value), "KEYWORD_INCREMENTAL_SOURCE_STAMP_INVALID"); return value; }
const sameStamp = (a, b) => JSON.stringify(a) === JSON.stringify(b);
async function stamp(file, optional = false) {
  try { await H.checked(file); return sourceStamp(await fs.lstat(file, { bigint: true })); }
  catch (e) { if (optional && e.code === "ENOENT") return null; throw e; }
}
async function mkdir(directory) {
  try { await H.checked(directory, true); } catch (e) { if (e.code !== "ENOENT") throw e; await H.checked(path.dirname(directory), true); await fs.mkdir(directory, { mode: 0o700 }); }
}
async function saveBytes(file, bytes, maximum, { beforeNewBlob = null } = {}) {
  need(bytes.length <= maximum && (beforeNewBlob === null || typeof beforeNewBlob === "function"), "KEYWORD_INCREMENTAL_WRITE_BOUND");
  try { const before = await H.checked(file); need(before.size === bytes.length && hash(await fs.readFile(file)) === hash(bytes), "KEYWORD_INCREMENTAL_IMMUTABLE_CONFLICT"); }
  catch (e) { if (e.code !== "ENOENT") throw e; if (beforeNewBlob) await beforeNewBlob(file, bytes.length); const h = await fs.open(file, "wx", 0o600); try { await h.writeFile(bytes); await h.sync(); } finally { await h.close(); } }
  need(hash(await fs.readFile(file)) === hash(bytes), "KEYWORD_INCREMENTAL_WRITE_READBACK");
  if (process.platform !== "win32") { const parent = await fs.open(path.dirname(file), native.constants.O_RDONLY); try { await parent.sync(); } finally { await parent.close(); } }
}
async function json(file, maximum = MAX_STATE) { const read = await H.read(file, maximum); return read; }
async function readStateStorage(file) {
  const before = await H.checked(file); need(before.size > 0 && before.size <= MAX_STATE, "KEYWORD_INCREMENTAL_STATE_STORAGE_BOUND");
  const handle = await fs.open(file, native.constants.O_RDONLY | (native.constants.O_NOFOLLOW || 0)); let bytes;
  try {
    need(H.same(before, await handle.stat()), "KEYWORD_INCREMENTAL_STATE_STORAGE_CHANGED"); const buffer = Buffer.alloc(before.size + 1); let count = 0;
    while (count < buffer.length) { const read = await handle.read(buffer, count, buffer.length - count, count); if (!read.bytesRead) break; count += read.bytesRead; }
    need(count === before.size && H.same(before, await handle.stat()), "KEYWORD_INCREMENTAL_STATE_STORAGE_CHANGED"); bytes = buffer.subarray(0, count);
  } finally { await handle.close(); }
  need(H.same(before, await H.checked(file)), "KEYWORD_INCREMENTAL_STATE_STORAGE_CHANGED"); return { bytes, sha256: hash(bytes) };
}
function createStore({ dataDir, directory = path.join(dataDir, "keyword_monthly_incremental"), now = () => new Date(), admission = async () => {} }) {
  H.absolute(dataDir); H.absolute(directory); need(H.inside(dataDir, directory) && directory !== dataDir);
  const masterFile = path.join(dataDir, "company_master/companies.json"), historyFile = path.join(dataDir, "history/observations.jsonl");
  const blobDir = path.join(directory, "companies"), historyDir = path.join(directory, "history"), stateDir = path.join(directory, "states"), pointerFile = path.join(directory, "source-current.json");
  const counters = { originalMasterBodyReads: 0, originalHistoryBodyReads: 0, originalHistoryBytes: 0, adoptedEvents: 0, repeatedEvents: 0, companyBlobReads: 0, companyBlobBytes: 0, companyBlobWrites: 0, deltaHistoryRows: 0,
    storageInventoryPasses: 0, persistentReservedBytes: 0, newReservations: 0 };
  let initializing = null, reservedBytes = 0, reservationSerial = Promise.resolve();
  async function initialize() {
    if (!initializing) initializing = (async () => {
      await mkdir(directory); for (const d of [blobDir, historyDir, stateDir]) await mkdir(d);
      // One metadata inventory per store instance includes old/failed job files.
      // New source blobs reserve bytes individually; no per-blob tree rescans.
      let entries = 0, total = 0; counters.storageInventoryPasses++;
      async function visit(dir, depth) {
        need(depth <= PERSISTENT_LIMITS.depth && ++entries <= PERSISTENT_LIMITS.entries, "KEYWORD_INCREMENTAL_PERSISTENT_INVENTORY_BOUND");
        const before = await H.checked(dir, true), stream = await fs.opendir(dir);
        for await (const entry of stream) {
          need(!entry.isSymbolicLink(), "KEYWORD_INCREMENTAL_PERSISTENT_PATH_UNSAFE"); const file = path.join(dir, entry.name);
          if (entry.isDirectory()) await visit(file, depth + 1);
          else {
            need(++entries <= PERSISTENT_LIMITS.entries && entry.isFile(), "KEYWORD_INCREMENTAL_PERSISTENT_INVENTORY_BOUND");
            const stat = await H.checked(file); need(Number.isSafeInteger(stat.size) && stat.size >= 0, "KEYWORD_INCREMENTAL_PERSISTENT_BOUND");
            total += stat.size; need(total <= PERSISTENT_LIMITS.bytes, "KEYWORD_INCREMENTAL_PERSISTENT_BOUND");
          }
        }
        need(H.same(before, await H.checked(dir, true)), "KEYWORD_INCREMENTAL_PERSISTENT_INVENTORY_CHANGED");
      }
      await visit(directory, 0); reservedBytes = total; counters.persistentReservedBytes = reservedBytes;
    })();
    return initializing;
  }
  function reserveNew(file, bytes) {
    const result = reservationSerial.then(async () => {
      H.absolute(file); need(H.inside(directory, file) && file !== directory && Number.isSafeInteger(bytes) && bytes > 0, "KEYWORD_INCREMENTAL_PERSISTENT_WRITE_PATH");
      try { await H.checked(file); return; } catch (error) { if (error.code !== "ENOENT") throw error; }
      await initialize(); await H.checked(path.dirname(file), true);
      // Initialization could discover a completed immutable file from an earlier
      // process. Reuse it without charging the same bytes again.
      try { await H.checked(file); return; } catch (error) { if (error.code !== "ENOENT") throw error; }
      need(reservedBytes + bytes <= PERSISTENT_LIMITS.bytes, "KEYWORD_INCREMENTAL_PERSISTENT_BOUND");
      const disk = await fs.statfs(dataDir, { bigint: true });
      need(typeof disk.bavail === "bigint" && typeof disk.bsize === "bigint" && disk.bavail >= 0n && disk.bsize > 0n
        && disk.bavail * disk.bsize >= BigInt(PERSISTENT_LIMITS.reserveBytes) + BigInt(bytes), "KEYWORD_INCREMENTAL_PERSISTENT_DISK_RESERVE");
      // A later write/ack failure is uncertain. Never return this reservation to
      // the budget; a new store inventories the actual surviving files instead.
      reservedBytes += bytes; counters.persistentReservedBytes = reservedBytes; counters.newReservations++;
    });
    reservationSerial = result.catch(() => {}); return result;
  }
  async function putCompany(company) {
    const raw = Buffer.from(JSON.stringify(company)); need(raw.length <= MAX_COMPANY, "KEYWORD_INCREMENTAL_COMPANY_BOUND"); const bytes = zlib.gzipSync(raw), sha256 = hash(bytes);
    await saveBytes(path.join(blobDir, sha256 + ".json.gz"), bytes, MAX_COMPANY, { beforeNewBlob: reserveNew }); counters.companyBlobWrites++;
    return { sha256, bytes: bytes.length, rawBytes: raw.length };
  }
  async function readCompany(companyId, descriptor) {
    const item = descriptor; need(item && item.companyId === companyId && H.SHA.test(item.sha256));
    const file = path.join(blobDir, item.sha256 + ".json.gz"), before = await H.checked(file); need(before.size === item.bytes && before.size <= MAX_COMPANY);
    const bytes = await fs.readFile(file); need(H.same(before, await H.checked(file)) && hash(bytes) === item.sha256);
    const raw = zlib.gunzipSync(bytes, { maxOutputLength: MAX_COMPANY }); need(raw.length === item.rawBytes); const value = JSON.parse(raw);
    need(value && typeof value === "object" && !Array.isArray(value) && value.companyId === companyId); counters.companyBlobReads++; counters.companyBlobBytes += bytes.length; return value;
  }
  function validate(state) {
    need(state?.schemaVersion === 1 && state.version === VERSION && Number.isSafeInteger(state.generation) && Array.isArray(state.companies) && state.companies.length <= 10000
      && Array.isArray(state.appliedEvents) && state.appliedEvents.length <= 50000 && Array.isArray(state.dirtyCompanyIds) && Array.isArray(state.dirtyMonths));
    const ids = new Set(); for (const [i, e] of state.companies.entries()) { need(typeof e.companyId === "string" && !ids.has(e.companyId) && e.orderIndex === i && H.SHA.test(e.sha256) && e.bytes > 0 && e.rawBytes <= MAX_COMPANY); ids.add(e.companyId); }
    need(state.sourceStamps && validStamp(state.sourceStamps.company) && validStamp(state.sourceStamps.history), "KEYWORD_INCREMENTAL_SOURCE_STAMP_INVALID");
    need(state.bootstrapSources && ["company", "history"].every(key => {
      const source = state.bootstrapSources[key]; return source && H.SHA.test(source.sha256) && Number.isSafeInteger(source.bytes) && source.bytes >= 0
        && source.bytes <= BOOTSTRAP_LIMITS.sourceBytes && source.sourceStamp !== null && validStamp(source.sourceStamp) && BigInt(source.sourceStamp.size) === BigInt(source.bytes);
    }), "KEYWORD_INCREMENTAL_BOOTSTRAP_SOURCE_INVALID");
    history.validate(state.history); need(Buffer.byteLength(JSON.stringify(state)) <= MAX_STATE); return state;
  }
  async function readCheckpoint(stateSha256, descriptor = null) {
    need(H.SHA.test(stateSha256), "KEYWORD_INCREMENTAL_STATE_ID_INVALID");
    const stored = await readStateStorage(path.join(stateDir, stateSha256 + ".json.gz"));
    if (descriptor) need(stored.bytes.length === descriptor.storageBytes && stored.sha256 === descriptor.storageSha256, "KEYWORD_INCREMENTAL_STATE_STORAGE_MISMATCH");
    let raw; try { raw = zlib.gunzipSync(stored.bytes, { maxOutputLength: MAX_STATE }); } catch { throw H.fault("KEYWORD_INCREMENTAL_STATE_DECOMPRESSION_INVALID"); }
    need((!descriptor || raw.length === descriptor.rawBytes) && hash(raw) === stateSha256, "KEYWORD_INCREMENTAL_STATE_RAW_MISMATCH");
    let value; try { value = JSON.parse(raw); } catch { throw H.fault("KEYWORD_INCREMENTAL_STATE_JSON_INVALID"); }
    return { state: validate(value), stateSha256, storageSha256: stored.sha256, storageBytes: stored.bytes.length, rawBytes: raw.length };
  }
  async function load() {
    try {
      // This checkpoint format is not deployed yet. Legacy plaintext pointers
      // are deliberately unsupported and never become permission to bootstrap.
      const p = await json(pointerFile, 16384), descriptor = p.value;
      need(descriptor.schemaVersion === 1 && descriptor.version === VERSION && H.SHA.test(descriptor.stateSha256)
        && descriptor.compression === "gzip" && H.SHA.test(descriptor.storageSha256)
        && Number.isSafeInteger(descriptor.storageBytes) && descriptor.storageBytes > 0 && descriptor.storageBytes <= MAX_STATE
        && Number.isSafeInteger(descriptor.rawBytes) && descriptor.rawBytes > 0 && descriptor.rawBytes <= MAX_STATE, "KEYWORD_INCREMENTAL_STATE_POINTER_INVALID");
      const checkpoint = await readCheckpoint(descriptor.stateSha256, descriptor);
      return { state: checkpoint.state, stateSha256: checkpoint.stateSha256, pointerSha256: p.sha256 };
    } catch (e) { if (e.code === "ENOENT") { try { await H.checked(pointerFile); } catch (p) { if (p.code === "ENOENT") return null; throw p; } } throw e; }
  }
  async function save(state, expectedPointerSha256 = null) {
    validate(state); await admission(); const bytes = Buffer.from(JSON.stringify(state)), stateSha256 = hash(bytes), compressed = zlib.gzipSync(bytes);
    await saveBytes(path.join(stateDir, stateSha256 + ".json.gz"), compressed, MAX_STATE, { beforeNewBlob: reserveNew });
    const current = await load(); need((current?.pointerSha256 || null) === expectedPointerSha256, "KEYWORD_INCREMENTAL_STATE_POINTER_CHANGED");
    const pointer = Buffer.from(JSON.stringify({ schemaVersion: 1, version: VERSION, stateSha256, compression: "gzip", storageSha256: hash(compressed),
      storageBytes: compressed.length, rawBytes: bytes.length, generation: state.generation, createdAt: new Date(now()).toISOString() }));
    const temporary = path.join(directory, "source-current-" + crypto.randomUUID() + ".tmp"); await saveBytes(temporary, pointer, 16384, { beforeNewBlob: reserveNew });
    await assertSources(state);
    need(((await load())?.pointerSha256 || null) === expectedPointerSha256, "KEYWORD_INCREMENTAL_STATE_POINTER_CHANGED");
    await fs.rename(temporary, pointerFile);
    if (process.platform !== "win32") { const handle = await fs.open(directory, native.constants.O_RDONLY); try { await handle.sync(); } finally { await handle.close(); } }
    const read = await load(); need(read.stateSha256 === stateSha256, "KEYWORD_INCREMENTAL_STATE_READBACK"); return read;
  }
  async function assertSources(state) {
    need(sameStamp(state.sourceStamps.company, await stamp(masterFile)) && sameStamp(state.sourceStamps.history, await stamp(historyFile)), "KEYWORD_INCREMENTAL_SOURCE_DRIFT_REQUIRES_BOOTSTRAP");
  }
  async function bootstrap({ eventIds = [], projectCompany = v => v, checkpoint = async () => {} } = {}) {
    let bootstrapPolicyError = null;
    const started = Date.now(), checkTime = () => {
      if (Date.now() < started || Date.now() - started > BOOTSTRAP_LIMITS.milliseconds) throw (bootstrapPolicyError = H.fault("KEYWORD_INCREMENTAL_BOOTSTRAP_TIME_BOUND"));
    };
    const checkBudget = async () => {
      try {
        checkTime(); const disk = await fs.statfs(dataDir, { bigint: true });
        // Physical free space is a reserve check, not a hosting-service quota.
        need(typeof disk.bavail === "bigint" && typeof disk.bsize === "bigint" && disk.bavail >= 0n && disk.bsize > 0n
          && disk.bavail * disk.bsize >= BigInt(BOOTSTRAP_LIMITS.reserveBytes), "KEYWORD_INCREMENTAL_BOOTSTRAP_DISK_RESERVE");
        await admission(); checkTime();
      } catch (error) { bootstrapPolicyError = error; throw error; }
    };
    await initialize(); need(!await load(), "KEYWORD_INCREMENTAL_BOOTSTRAP_ALREADY_EXISTS"); await admission();
    const sourceStamps = { company: await stamp(masterFile), history: await stamp(historyFile) }, companies = [], measured = {};
    for (const source of Object.values(sourceStamps)) need(source !== null && BigInt(source.size) <= BigInt(BOOTSTRAP_LIMITS.sourceBytes), "KEYWORD_INCREMENTAL_BOOTSTRAP_SOURCE_BOUND");
    await checkBudget();
    function tee(file, name) {
      const expected = Number(sourceStamps[name].size), digest = crypto.createHash("sha256"), meter = { bytes: 0, ended: false }, decoded = new PassThrough();
      measured[name] = meter; decoded.setEncoding("utf8");
      const input = native.createReadStream(file, { highWaterMark: 65536, flags: native.constants.O_RDONLY | (native.constants.O_NOFOLLOW || 0) });
      input.on("data", chunk => {
        try {
          checkTime(); need(Buffer.isBuffer(chunk), "KEYWORD_INCREMENTAL_BOOTSTRAP_RAW_STREAM_INVALID"); meter.bytes += chunk.length;
          need(meter.bytes <= expected && meter.bytes <= BOOTSTRAP_LIMITS.sourceBytes, "KEYWORD_INCREMENTAL_BOOTSTRAP_SOURCE_CHANGED");
          digest.update(chunk); if (name === "history") counters.originalHistoryBytes += chunk.length;
        } catch (error) { bootstrapPolicyError = error; input.destroy(error); decoded.destroy(error); }
      });
      input.on("end", () => { meter.ended = true; meter.sha256 = digest.digest("hex"); });
      input.on("error", error => decoded.destroy(error)); decoded.on("error", () => {}); decoded.once("close", () => input.destroy()); input.pipe(decoded);
      return decoded;
    }
    counters.originalMasterBodyReads++;
    try {
      await readCompanyMasterProjection(masterFile, { projectCompany: null, stream: file => tee(file, "company"), checkpoint: async () => { checkTime(); await checkpoint(); }, onCompany: async (raw, key) => {
        try {
          await checkBudget(); need(raw?.companyId === key, "KEYWORD_INCREMENTAL_COMPANY_KEY_MISMATCH"); const stored = await putCompany(raw); companies.push({ companyId: key, orderIndex: companies.length, ...stored, compact: await projectCompany(raw) });
          if (companies.length % 16 === 0) { await checkpoint(); await checkBudget(); }
        } catch (error) { if (/^KEYWORD_INCREMENTAL_/.test(error?.code || "")) bootstrapPolicyError = error; throw error; }
      } });
    } catch (error) { throw bootstrapPolicyError || error; }
    need(measured.company.ended && measured.company.bytes === Number(sourceStamps.company.size), "KEYWORD_INCREMENTAL_BOOTSTRAP_SOURCE_CHANGED"); await checkBudget();
    let rows = [], bytes = 0, index = history.empty(); const input = tee(historyFile, "history"), lines = readline.createInterface({ input, crlfDelay: Infinity });
    counters.originalHistoryBodyReads++; let streamError = null; input.on("error", e => { streamError = e; lines.close(); });
    try {
      for await (const line of lines) {
        checkTime(); const n = Buffer.byteLength(line); need(n <= 1024 * 1024, "KEYWORD_INCREMENTAL_LINE_BOUND"); rows.push(line); bytes += n + 1;
        if (bytes >= 2 * 1024 * 1024) { await checkBudget(); index = await history.append(historyDir, index, rows, { beforeNewBlob: reserveNew }); rows = []; bytes = 0; await checkpoint(); await checkBudget(); }
      }
      if (streamError) throw streamError; if (rows.length) { await checkBudget(); index = await history.append(historyDir, index, rows, { beforeNewBlob: reserveNew }); }
    } finally { lines.close(); input.destroy(); }
    need(measured.history.ended && measured.history.bytes === Number(sourceStamps.history.size), "KEYWORD_INCREMENTAL_BOOTSTRAP_SOURCE_CHANGED"); await checkBudget();
    const bootstrapSources = Object.fromEntries(Object.entries(measured).map(([name, source]) => [name, { sha256: source.sha256, bytes: source.bytes, sourceStamp: sourceStamps[name] }]));
    const state = { schemaVersion: 1, version: VERSION, generation: 1, bootstrapAt: new Date(now()).toISOString(), updatedAt: new Date(now()).toISOString(), sourceStamps,
      bootstrapSources, companies, history: index, appliedEvents: [...new Set(eventIds)], dirtyCompanyIds: companies.map(c => c.companyId), dirtyMonths: [...new Set(index.partitions.map(p => p.month).filter(Boolean))], prepared: false };
    state.dirtyKeywords = [...new Set(companies.flatMap(c => Object.values(c.compact.keywords || {}).map(k => k.keyword).filter(Boolean)))]; state.globalDiagnosticsDirty = true;
    await assertSources(state); return save(state);
  }
  async function apply({ current, events, projectCompany = v => v }) {
    validate(current.state); need(Array.isArray(events)); const state = structuredClone(current.state), pending = [], applied = new Set(state.appliedEvents), dirtyIds = new Set(state.dirtyCompanyIds), dirtyMonths = new Set(state.dirtyMonths), dirtyKeywords = new Set(state.dirtyKeywords || []);
    const incoming = new Map();
    for (const event of events) {
      need(H.SHA.test(event.eventId)); if (applied.has(event.eventId)) { counters.repeatedEvents++; continue; }
      if (incoming.has(event.eventId)) { need(JSON.stringify(incoming.get(event.eventId)) === JSON.stringify(event), "KEYWORD_INCREMENTAL_EVENT_CONFLICT"); counters.repeatedEvents++; continue; }
      need(validStamp(event.payload?.sourceStamp?.before) && validStamp(event.payload?.sourceStamp?.after), "KEYWORD_INCREMENTAL_SOURCE_STAMP_INVALID");
      incoming.set(event.eventId, event); pending.push(event);
    }
    while (pending.length) {
      await admission(); const candidates = pending.filter(e => {
        const name = e.kind === "companies" ? "company" : e.kind === "history" ? "history" : null; need(name, "KEYWORD_INCREMENTAL_EVENT_KIND_INVALID");
        return sameStamp(e.payload.sourceStamp?.before, state.sourceStamps[name]);
      });
      need(candidates.length > 0, "KEYWORD_INCREMENTAL_DELTA_GAP");
      // Independent company/history events may interleave. Per-source forks are
      // never ordered arbitrarily by hash or timestamp.
      const event = candidates.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.eventId.localeCompare(b.eventId))[0], p = event.payload;
      need(candidates.filter(e => e.kind === event.kind).length === 1, "KEYWORD_INCREMENTAL_DELTA_FORK");
      const kind = event.kind === "companies" ? "company" : "history";
      need(p.sourceStamp && p.sourceStamp.after !== undefined, "KEYWORD_INCREMENTAL_EVENT_STAMP_UNKNOWN");
      if (kind === "company") {
        need(Array.isArray(p.changes) && Array.isArray(p.order)); const entries = new Map(state.companies.map(e => [e.companyId, e]));
        for (const change of p.changes) {
          const id = change.companyId; need(typeof id === "string"); dirtyIds.add(id);
          const old = entries.get(id)?.compact;
          for (const k of Object.values(old?.keywords || {})) if (k.keyword) dirtyKeywords.add(k.keyword);
          const identity = c => c && Object.fromEntries(["companyId", "placeIds", "bookingBusinessIds", "duplicateNotes", "deletedAt", "mergedIntoCompanyId"].filter(k => Object.hasOwn(c, k)).map(k => [k, c[k]]));
          if (JSON.stringify(identity(old)) !== JSON.stringify(identity(change.company))) state.globalDiagnosticsDirty = true;
          if (change.company === null) { entries.delete(id); continue; }
          for (const k of Object.values(change.company.keywords || {})) if (k.keyword) dirtyKeywords.add(k.keyword);
          need(change.company?.companyId === id); entries.set(id, { companyId: id, ...await putCompany(change.company), compact: await projectCompany(change.company) });
        }
        need(new Set(p.order).size === p.order.length && p.order.length === entries.size && p.order.every(id => entries.has(id)), "KEYWORD_INCREMENTAL_COMPANY_ORDER_INCOMPLETE");
        state.companies = p.order.map((id, i) => ({ ...entries.get(id), orderIndex: i }));
      } else {
        need(p.indexUpdated === true && Array.isArray(p.rows), "KEYWORD_INCREMENTAL_HISTORY_NOT_INDEXED");
        state.history = await history.append(historyDir, state.history, p.rows.map(row => JSON.stringify(row)), { beforeNewBlob: reserveNew }); counters.deltaHistoryRows += p.rows.length;
        for (const row of p.rows) { if (row.keyword) dirtyKeywords.add(row.keyword); if (row.companyId || row.companyKey) dirtyIds.add(String(row.companyId || row.companyKey)); const month = String(row.stayDate || row.date || "").slice(0, 7); if (H.MONTH.test(month)) dirtyMonths.add(month); }
      }
      state.sourceStamps[kind] = p.sourceStamp.after; applied.add(event.eventId); pending.splice(pending.indexOf(event), 1); counters.adoptedEvents++;
    }
    state.appliedEvents = [...applied]; state.dirtyCompanyIds = [...dirtyIds]; state.dirtyMonths = [...dirtyMonths]; state.dirtyKeywords = [...dirtyKeywords]; state.generation++; state.updatedAt = new Date(now()).toISOString(); state.prepared = false;
    await assertSources(state); return save(state, current.pointerSha256);
  }
  async function assertPointer(stateSha256) { const p = await json(pointerFile, 16384); need(p.value.version === VERSION && p.value.stateSha256 === stateSha256, "KEYWORD_INCREMENTAL_STATE_CHANGED"); }
  return { initialize, load, save, bootstrap, apply, assertSources, assertPointer, readCompany, validate, putCompany, directory, historyDir, blobDir, counters,
    // Immutable historical recovery does not consult the current pointer/source.
    readCheckpoint: stateSha256 => readCheckpoint(stateSha256),
    createHistoryReader: (state, assertCurrent) => history.createReader({ directory: historyDir, state: state.history, assertCurrent }) };
}
module.exports = { VERSION, MAX_STATE, MAX_COMPANY, BOOTSTRAP_LIMITS, PERSISTENT_LIMITS, sourceStamp, validStamp, sameStamp, stamp, createStore, saveBytes };
