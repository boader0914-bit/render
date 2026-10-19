"use strict";

// Rebuildable source access index only. Master/history originals, product
// responses and the integrated monthly calculation engine are never written.
const fs = require("node:fs/promises");
const native = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { readScopedCompanyMaster } = require("./company_detail_store.cjs");
const { getCurrentHeavyWorkOwner } = require("./heavy_work_scheduler.cjs");
const VERSION = "company-detail-source-index-v3";
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const jsonHash = value => hash(JSON.stringify(value));
const stamp = stat => [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].map(String).join(":");
const own = (object, key) => Object.hasOwn(object || {}, key);
const object = value => value && typeof value === "object" && !Array.isArray(value);
const fault = (code = "COMPANY_DETAIL_SOURCE_INDEX_PREPARING") => Object.assign(new Error(
  code === "COMPANY_DETAIL_SOURCE_INDEX_PREPARING"
    ? "업체 상세 원본 색인을 준비하고 있습니다. 통합 자료는 유지하며 준비가 끝나면 다시 불러옵니다."
    : "업체 상세 원본 색인을 확인하지 못했습니다. 저장 자료와 연결 상태를 확인해 주세요."
), { code, statusCode: 503 });
const need = (condition, code = "COMPANY_DETAIL_SOURCE_INDEX_INVALID") => { if (!condition) throw fault(code); };
const defaultHistoryIdentity = row => ({ observationId: row.observationId, companyKey: row.companyKey, companyName: row.companyName });
const tick = () => new Promise(resolve => setImmediate(resolve));

function createCompanyDetailSourceIndex({ dataDir, projectionVersion = VERSION, masterReader = readScopedCompanyMaster,
  historyIdentity = defaultHistoryIdentity, fileSystem = fs, createReadStream = filename => native.createReadStream(filename, { highWaterMark: 64 * 1024 }),
  yieldControl = tick, maxRecordBytes = 128 * 1024 * 1024, historyReadConcurrency = 8, maxHistoryReadBytes = 32 * 1024 * 1024,
  runHeavy = null } = {}) {
  need(dataDir && typeof masterReader === "function" && typeof historyIdentity === "function");
  need(Number.isInteger(historyReadConcurrency) && historyReadConcurrency > 0 && historyReadConcurrency <= 8
    && Number.isSafeInteger(maxHistoryReadBytes) && maxHistoryReadBytes > 0);
  const root = path.resolve(dataDir), masterFile = path.join(root, "company_master", "companies.json");
  const historyFile = path.join(root, "history", "observations.jsonl");
  const cacheDir = path.join(root, "company_master", "detail_source_index"), currentFile = path.join(cacheDir, "current.json");
  let manifest = null, active = null, peersMemory = null, historyMemory = null, cleanupActive = null, cleanupRequested = false, failedSource = null;
  const pins = new Map(), deferredCleanup = new Set();
  const preparations = new Set();
  let state = { ready: false, phase: "pending", startedAt: null, finishedAt: null, elapsedMs: null, errorCode: null };

  async function regular(file, missingCode = "COMPANY_DETAIL_SOURCE_INDEX_SOURCE_MISSING") {
    try { const stat = await fileSystem.lstat(file, { bigint: true }); need(stat.isFile() && !stat.isSymbolicLink()); return stat; }
    catch (error) { if (error.code === "ENOENT") throw fault(missingCode); throw error.code?.startsWith("COMPANY_DETAIL_") ? error : fault("COMPANY_DETAIL_SOURCE_INDEX_SOURCE_UNAVAILABLE"); }
  }
  async function source() {
    await safeDirectory(path.dirname(masterFile), "COMPANY_DETAIL_SOURCE_INDEX_SOURCE_MISSING");
    await safeDirectory(path.dirname(historyFile), "COMPANY_DETAIL_SOURCE_INDEX_SOURCE_MISSING");
    return { master: stamp(await regular(masterFile)), history: stamp(await regular(historyFile)) };
  }
  const same = (left, right) => Boolean(left && right && left.master === right.master && left.history === right.history);
  function generationDir(value) {
    need(/^generation_[a-f0-9]{32}$/.test(value || ""));
    const directory = path.resolve(cacheDir, value);
    need(directory.startsWith(cacheDir + path.sep)); return directory;
  }
  async function safeDirectory(directory, missingCode = "COMPANY_DETAIL_SOURCE_INDEX_INVALID") {
    let value;
    try { value = await fileSystem.lstat(directory); }
    catch (error) { throw fault(error.code === "ENOENT" ? missingCode : "COMPANY_DETAIL_SOURCE_INDEX_SOURCE_UNAVAILABLE"); }
    need(value.isDirectory() && !value.isSymbolicLink());
  }
  function recordValid(value, filename) { return object(value) && value.file === filename && /^[a-f0-9]{64}$/.test(value.sha256 || "")
    && Number.isSafeInteger(value.bytes) && value.bytes >= 0; }
  function valid(value) {
    if (!object(value) || value.version !== VERSION || value.projectionVersion !== projectionVersion
      || !/^generation_[a-f0-9]{32}$/.test(value.generation || "") || !object(value.source)
      || typeof value.source.master !== "string" || typeof value.source.history !== "string"
      || value.previousGeneration !== null && !/^generation_[a-f0-9]{32}$/.test(value.previousGeneration || "")
      || !object(value.companies) || !recordValid(value.peers, "peers.json") || !recordValid(value.history, "history.json")
      || value.checksum !== jsonHash({ ...value, checksum: undefined })) return false;
    return Object.entries(value.companies).every(([id, record]) => recordValid(record, hash(id) + ".json"));
  }
  async function checkedJson(owner, record, withSignature = false) {
    await safeDirectory(cacheDir); const directory = generationDir(owner.generation); await safeDirectory(directory);
    need(recordValid(record, record.file) && /^[a-z0-9_]+\.json$/.test(record.file));
    const file = path.resolve(directory, record.file); need(file.startsWith(directory + path.sep));
    const before = await regular(file, "COMPANY_DETAIL_SOURCE_INDEX_INVALID");
    const bytes = await fileSystem.readFile(file);
    need(stamp(before) === stamp(await regular(file, "COMPANY_DETAIL_SOURCE_INDEX_INVALID")) && bytes.length === record.bytes && hash(bytes) === record.sha256);
    try { const data = JSON.parse(bytes.toString("utf8")); return withSignature ? { data, signature: stamp(before) } : data; }
    catch { throw fault("COMPANY_DETAIL_SOURCE_INDEX_INVALID"); }
  }
  async function writeJson(directory, filename, value) {
    const bytes = Buffer.from(JSON.stringify(value));
    try { await fileSystem.writeFile(path.join(directory, filename), bytes, { flag: "wx", mode: 0o600 }); }
    catch { throw fault("COMPANY_DETAIL_SOURCE_INDEX_WRITE_FAILED"); }
    return { file: filename, bytes: bytes.length, sha256: hash(bytes) };
  }
  async function persisted(before = null) {
    try {
      await safeDirectory(cacheDir); await regular(currentFile, "COMPANY_DETAIL_SOURCE_INDEX_INVALID");
      const saved = JSON.parse(await fileSystem.readFile(currentFile, "utf8"));
      if (!valid(saved) || before && !same(saved.source, before)) return null;
      await safeDirectory(generationDir(saved.generation)); return saved;
    } catch { return null; }
  }
  async function historyOffsets() {
    // Retain identity transitions as well as the latest byte range. For a
    // selected company A(id1), A(id2), B(id1), A(id1) must end as [id2,id1]:
    // the existing scoped reader deletes on nonmatch and then reinserts.
    // Consecutive equal identities for one id can share an event safely.
    const latest = new Map(), events = []; let offset = 0, tail = Buffer.alloc(0), count = 0;
    const input = createReadStream(historyFile);
    function line(bytes, start) {
      if (!bytes.toString("utf8").trim()) return;
      let row; try { row = JSON.parse(bytes.toString("utf8")); } catch { return; }
      if (!row?.observationId) return; // Tolerate partial history lines as before.
      const projected = historyIdentity(row);
      need(object(projected) && jsonHash(projected.observationId) === jsonHash(row.observationId), "COMPANY_DETAIL_SOURCE_INDEX_PROJECTOR_INVALID");
      // The just-built private cache must have the same JSON representation as
      // a saved/restarted index, including absent rather than undefined fields.
      const encodedIdentity = JSON.stringify(projected), identity = JSON.parse(encodedIdentity);
      const identityHash = hash(encodedIdentity), previous = latest.get(row.observationId);
      if (previous?.identityHash === identityHash) {
        previous.event.offset = start; previous.event.length = bytes.length;
      } else {
        const event = { offset: start, length: bytes.length, identity };
        events.push(event); latest.set(row.observationId, { identityHash, event });
      }
    }
    try {
      for await (const part of input) {
        const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part), buffer = tail.length ? Buffer.concat([tail, chunk]) : chunk;
        let position = 0, end;
        while ((end = buffer.indexOf(10, position)) !== -1) {
          need(end - position <= maxRecordBytes, "COMPANY_DETAIL_SOURCE_INDEX_RECORD_LIMIT");
          line(buffer.subarray(position, end), offset + position); position = end + 1;
          if (++count % 128 === 0) await yieldControl();
        }
        tail = Buffer.from(buffer.subarray(position)); offset += position;
        need(tail.length <= maxRecordBytes, "COMPANY_DETAIL_SOURCE_INDEX_RECORD_LIMIT");
      }
      if (tail.length) line(tail, offset);
    } finally { input.destroy?.(); }
    return { events, uniqueObservationCount: latest.size };
  }
  async function build(before, previous) {
    await fileSystem.mkdir(cacheDir, { recursive: true }); await safeDirectory(cacheDir);
    const generation = "generation_" + crypto.randomBytes(16).toString("hex"), directory = generationDir(generation);
    await fileSystem.mkdir(directory); await safeDirectory(directory);
    const companies = Object.create(null); let visits = 0;
    const peers = await masterReader(masterFile, "", { onCompany: async (id, row) => {
      need(typeof id === "string" && id && object(row) && !own(companies, id));
      companies[id] = await writeJson(directory, hash(id) + ".json", row); visits++;
    } });
    need(object(peers?.companies) && Object.keys(peers.companies).length === visits, "COMPANY_DETAIL_SOURCE_INDEX_BUILDER_CONTRACT");
    for (const row of Object.values(peers.companies)) need(object(row) && Object.keys(row).every(key => key === "keywords"));
    const peersRecord = await writeJson(directory, "peers.json", peers);
    const history = await historyOffsets(), historyRecord = await writeJson(directory, "history.json", history);
    const historySignature = stamp(await regular(path.join(directory, historyRecord.file), "COMPANY_DETAIL_SOURCE_INDEX_INVALID"));
    need(same(before, await source()), "COMPANY_DETAIL_SOURCE_INDEX_SOURCE_CHANGED");
    const body = { version: VERSION, projectionVersion, generation, previousGeneration: previous?.generation || null,
      source: before, preparedAt: new Date().toISOString(),
      companies, peers: peersRecord, history: historyRecord, companyCount: visits, historyRowCount: history.uniqueObservationCount, historyEventCount: history.events.length };
    const next = { ...body, checksum: jsonHash(body) }, temporary = currentFile + "." + crypto.randomBytes(12).toString("hex") + ".tmp";
    try {
      await writeJson(directory, "generation.json", next);
      await fileSystem.writeFile(temporary, JSON.stringify(next), { flag: "wx", mode: 0o600 });
      need(same(before, await source()), "COMPANY_DETAIL_SOURCE_INDEX_SOURCE_CHANGED");
      await fileSystem.rename(temporary, currentFile);
    } catch (error) { await fileSystem.unlink(temporary).catch(() => {}); throw error; }
    return { manifest: next, events: history.events, historySignature };
  }
  async function cleanupGenerations(owner) {
    const report = { checkedAt: new Date().toISOString(), deleted: [], skipped: [], warningCount: 0, errorCode: null };
    const skip = (generation, reason) => { report.warningCount++; if (report.skipped.length < 50) report.skipped.push({ generation, reason }); };
    try {
      await safeDirectory(cacheDir);
      const published = await persisted();
      need(published?.generation === owner.generation, "COMPANY_DETAIL_SOURCE_INDEX_POINTER_CHANGED");
      const keep = new Set([owner.generation, owner.previousGeneration].filter(Boolean));
      for (const entry of await fileSystem.readdir(cacheDir, { withFileTypes: true })) {
        if (entry.name === "current.json" || entry.isFile() && entry.name.startsWith("current.json.")) continue;
        if (!/^generation_[a-f0-9]{32}$/.test(entry.name) || !entry.isDirectory() || entry.isSymbolicLink()) { skip(entry.name, "unmanaged_or_linked_entry"); continue; }
        if (keep.has(entry.name)) continue;
        if (pins.has(entry.name)) { deferredCleanup.add(entry.name); continue; }
        const directory = generationDir(entry.name);
        // Every recursive target is resolved and checked inside this exact
        // derived-cache root. Unknown folders and links are never traversed.
        need(path.isAbsolute(directory) && path.dirname(directory) === cacheDir && directory !== cacheDir && directory.startsWith(cacheDir + path.sep));
        try {
          const before = await fileSystem.lstat(directory, { bigint: true });
          need(before.isDirectory() && !before.isSymbolicLink());
          const generationFile = path.join(directory, "generation.json"), markerStat = await regular(generationFile, "COMPANY_DETAIL_SOURCE_INDEX_INVALID");
          const marker = JSON.parse(await fileSystem.readFile(generationFile, "utf8"));
          need(valid(marker) && marker.generation === entry.name);
          const records = [marker.peers, marker.history, ...Object.values(marker.companies)];
          const expected = new Set(["generation.json", ...records.map(record => record.file)]);
          const files = await fileSystem.readdir(directory, { withFileTypes: true });
          need(files.length === expected.size && files.every(file => expected.has(file.name) && file.isFile() && !file.isSymbolicLink()));
          const checked = [[generationFile, stamp(markerStat)]];
          for (const record of records) {
            const filename = path.resolve(directory, record.file); need(path.dirname(filename) === directory);
            const stat = await regular(filename, "COMPANY_DETAIL_SOURCE_INDEX_INVALID"), bytes = await fileSystem.readFile(filename);
            need(bytes.length === record.bytes && hash(bytes) === record.sha256);
            checked.push([filename, stamp(stat)]);
          }
          for (const [filename, signature] of checked) need(stamp(await regular(filename, "COMPANY_DETAIL_SOURCE_INDEX_INVALID")) === signature);
          need(stamp(await fileSystem.lstat(directory, { bigint: true })) === stamp(before));
          // A reader may pin the generation while proof IO is in progress.
          if (keep.has(entry.name)) continue;
          if (pins.has(entry.name)) { deferredCleanup.add(entry.name); continue; }
          const latest = await persisted();
          need(latest?.generation === owner.generation, "COMPANY_DETAIL_SOURCE_INDEX_POINTER_CHANGED");
          if (pins.has(entry.name)) { deferredCleanup.add(entry.name); continue; }
          await fileSystem.rm(directory, { recursive: true, force: false }); report.deleted.push(entry.name); deferredCleanup.delete(entry.name);
          await yieldControl();
        } catch (error) { skip(entry.name, error.code === "COMPANY_DETAIL_SOURCE_INDEX_POINTER_CHANGED" ? "published_pointer_changed" : "generation_proof_or_cleanup_failed"); }
      }
    } catch (error) { report.errorCode = error.code?.startsWith("COMPANY_DETAIL_") ? error.code : "COMPANY_DETAIL_SOURCE_INDEX_CLEANUP_FAILED"; }
    state = { ...state, cleanup: report }; return report;
  }
  function cleanup(owner = manifest) {
    if (!owner || cleanupActive) return cleanupActive || Promise.resolve(null);
    const pending = typeof runHeavy === "function"
      ? runHeavy(() => cleanupGenerations(owner), { label: "company-detail-index-cleanup", priority: "background", estimatedBytes: 128 * 1024 * 1024 })
      : cleanupGenerations(owner);
    cleanupActive = pending;
    pending.finally(() => { if (cleanupActive === pending) cleanupActive = null; maybeCleanup(); }).catch(() => {});
    return pending;
  }
  function maybeCleanup() {
    if (cleanupRequested && !active && !cleanupActive && state.ready) { cleanupRequested = false; void cleanup().catch(() => {}); }
  }
  function unpin(owner) {
    const count = pins.get(owner.generation) || 0;
    if (count > 1) pins.set(owner.generation, count - 1); else pins.delete(owner.generation);
    if (!pins.has(owner.generation) && deferredCleanup.delete(owner.generation)) { cleanupRequested = true; maybeCleanup(); }
  }
  async function prepareWork(force, task) {
    const started = Date.now(); state = { ...state, ready: false, phase: "preparing", startedAt: new Date(started).toISOString(), finishedAt: null, elapsedMs: null, errorCode: null };
    let before = null;
    try {
      before = await source();
      const previous = valid(manifest) ? manifest : await persisted();
      let saved = !force && same(previous?.source, before) ? previous : null;
      const reused = Boolean(saved);
      let built = null;
      if (!saved) {
        const work = async () => {
          task.phase = "running"; task.owner = getCurrentHeavyWorkOwner();
          state = { ...state, phase: "preparing" };
          // Inputs may have changed while another analytical task owned the
          // slot. Start the build from a fresh revision after admission.
          before = await source();
          const latest = valid(manifest) ? manifest : await persisted();
          if (!force && same(latest?.source, before)) return { manifest: latest, reused: true };
          return build(before, latest);
        };
        if (typeof runHeavy === "function") { task.phase = "waiting"; state = { ...state, phase: "waiting", waitReason: "heavy_work_admission" }; }
        built = typeof runHeavy === "function"
          ? await runHeavy(work, { label: "company-detail-index-build", priority: "background", estimatedBytes: 512 * 1024 * 1024 })
          : await work();
        saved = built.manifest;
      }
      need(same(before, await source()), "COMPANY_DETAIL_SOURCE_INDEX_SOURCE_CHANGED");
      if (manifest?.generation !== saved.generation) { peersMemory = null; historyMemory = null; }
      manifest = saved;
      // No second read/parse of the history index is needed after its initial
      // build. Publish this private generation cache only after source checks;
      // persisted-index reuse still verifies and loads its own saved metadata.
      if (built && !built.reused) historyMemory = { generation: saved.generation, events: built.events, signature: built.historySignature };
      failedSource = null;
      state = { ready: true, phase: "ready", startedAt: state.startedAt, finishedAt: new Date().toISOString(), elapsedMs: Date.now() - started,
        errorCode: null, cacheStatus: reused || built?.reused ? "reused" : "built", companyCount: saved.companyCount, historyRowCount: saved.historyRowCount,
        historyEventCount: saved.historyEventCount, preparedAt: saved.preparedAt };
      // A persisted index is a cheap reuse path. Do not make it wait for a
      // separate queued proof/GC pass when the shared gate is configured.
      if (typeof runHeavy === "function") void cleanup(saved).catch(() => {});
      else await cleanup(saved);
      state = { ...state, finishedAt: new Date().toISOString(), elapsedMs: Date.now() - started };
      return { ...state };
    } catch (error) {
      const admissionFailure = error.code?.startsWith("HEAVY_WORK_");
      failedSource = admissionFailure ? null : before;
      state = { ...state, ready: false, phase: admissionFailure ? "waiting" : "failed", finishedAt: new Date().toISOString(), elapsedMs: Date.now() - started,
        errorCode: error.code?.startsWith("COMPANY_DETAIL_") || error.code?.startsWith("HEAVY_WORK_") ? error.code : "COMPANY_DETAIL_SOURCE_INDEX_PREPARE_FAILED" };
      throw error.code?.startsWith("COMPANY_DETAIL_") || error.code?.startsWith("HEAVY_WORK_") ? error : fault(state.errorCode);
    }
  }
  function prepare(options = {}) {
    const owner = getCurrentHeavyWorkOwner();
    if (active) {
      if (typeof runHeavy === "function" && owner && active.owner === owner && active.phase === "running") return Promise.reject(fault("COMPANY_DETAIL_SOURCE_INDEX_REENTRANT_PREPARE"));
      if (typeof runHeavy !== "function" || !owner || !["initializing", "waiting"].includes(active.phase)) return active.pending;
    }
    const task = { phase: "initializing", owner: null, pending: null };
    const pending = prepareWork(Boolean(options.force), task); task.pending = pending;
    preparations.add(task); if (!active) active = task;
    pending.finally(() => { preparations.delete(task); if (active === task) active = preparations.values().next().value || null; maybeCleanup(); }).catch(() => {});
    return pending;
  }
  const schedule = force => { void prepare({ force }).catch(() => {}); };
  async function current(pinRead = false) {
    let before;
    try { before = await source(); } catch (error) { state = { ...state, ready: false, phase: "failed", errorCode: error.code }; throw error; }
    // A completed failed build is not still preparing. Repeated polling must
    // not rebuild identical broken input or a full derived volume indefinitely.
    // An explicit prepare() retries; changed source metadata starts a new build.
    if (state.phase === "failed" && same(failedSource, before) && state.errorCode) throw fault(state.errorCode);
    if (!state.ready || !valid(manifest) || !same(manifest.source, before)) { schedule(false); throw fault(); }
    if (pinRead) pins.set(manifest.generation, (pins.get(manifest.generation) || 0) + 1);
    return manifest;
  }
  async function stillCurrent(owner) {
    if (!same(owner.source, await source())) { schedule(false); throw fault(); }
  }
  async function derivedFailure(error) {
    if (error.code === "COMPANY_DETAIL_SOURCE_INDEX_INVALID") { state = { ...state, ready: false }; schedule(true); throw fault(); }
    if (error.code === "COMPANY_DETAIL_SOURCE_INDEX_SOURCE_CHANGED") { state = { ...state, ready: false }; schedule(false); throw fault(); }
    throw error.code?.startsWith("COMPANY_DETAIL_") ? error : fault("COMPANY_DETAIL_SOURCE_INDEX_SOURCE_UNAVAILABLE");
  }
  async function readMaster(file, companyId) {
    need(path.resolve(file) === masterFile, "COMPANY_DETAIL_SOURCE_INDEX_PATH_INVALID");
    const id = String(companyId || ""); const owner = await current(true);
    try {
      if (!peersMemory || peersMemory.generation !== owner.generation) peersMemory = { generation: owner.generation, data: await checkedJson(owner, owner.peers) };
      need(object(peersMemory.data?.companies));
      const companies = Object.assign(Object.create(null), structuredClone(peersMemory.data.companies));
      if (own(owner.companies, id)) {
        const selected = await checkedJson(owner, owner.companies[id]); need(object(selected));
        companies[id] = selected;
      }
      await stillCurrent(owner); return { companies };
    } catch (error) { return derivedFailure(error); } finally { unpin(owner); }
  }
  async function readHistory(file, company, matches) {
    need(path.resolve(file) === historyFile && typeof matches === "function", "COMPANY_DETAIL_SOURCE_INDEX_PATH_INVALID");
    const owner = await current(true);
    try {
      await safeDirectory(cacheDir); const historyDirectory = generationDir(owner.generation); await safeDirectory(historyDirectory);
      const historySignature = stamp(await regular(path.join(historyDirectory, owner.history.file), "COMPANY_DETAIL_SOURCE_INDEX_INVALID"));
      if (!historyMemory || historyMemory.generation !== owner.generation || historyMemory.signature !== historySignature) {
        const value = await checkedJson(owner, owner.history, true); need(Array.isArray(value.data?.events));
        historyMemory = { generation: owner.generation, events: value.data.events, signature: value.signature };
      }
      const selectedById = new Map();
      for (const entry of historyMemory.events) {
        need(object(entry) && Number.isSafeInteger(entry.offset) && entry.offset >= 0 && Number.isSafeInteger(entry.length) && entry.length > 0 && object(entry.identity));
        if (matches(entry.identity, company)) selectedById.set(entry.identity.observationId, entry);
        else selectedById.delete(entry.identity.observationId);
      }
      const selected = [...selectedById.values()];
      const handle = await fileSystem.open(historyFile, native.constants.O_RDONLY | (native.constants.O_NOFOLLOW || 0));
      try {
        const before = await handle.stat({ bigint: true }); need(stamp(before) === owner.source.history, "COMPANY_DETAIL_SOURCE_INDEX_SOURCE_CHANGED");
        for (const entry of selected) need(entry.length <= maxRecordBytes && entry.length <= maxHistoryReadBytes
          && entry.offset + entry.length <= Number(before.size), "COMPANY_DETAIL_SOURCE_INDEX_RECORD_LIMIT");
        const rows = new Array(selected.length), waiters = [];
        let cursor = 0, bytesInFlight = 0, failure = null;
        async function permit(length) {
          while (!failure && bytesInFlight + length > maxHistoryReadBytes) await new Promise(resolve => waiters.push(resolve));
          if (failure) return false; bytesInFlight += length; return true;
        }
        async function worker() {
          while (!failure && cursor < selected.length) {
            const index = cursor++, entry = selected[index];
            if (!await permit(entry.length)) return;
            try {
              const buffer = Buffer.alloc(entry.length); let total = 0;
              while (total < buffer.length) {
                const read = await handle.read(buffer, total, buffer.length - total, entry.offset + total);
                need(read.bytesRead > 0, "COMPANY_DETAIL_SOURCE_INDEX_SOURCE_CHANGED"); total += read.bytesRead;
              }
              let row; try { row = JSON.parse(buffer.toString("utf8")); } catch { throw fault("COMPANY_DETAIL_SOURCE_INDEX_SOURCE_CHANGED"); }
              need(jsonHash(historyIdentity(row)) === jsonHash(entry.identity) && matches(row, company), "COMPANY_DETAIL_SOURCE_INDEX_PROJECTOR_INVALID");
              rows[index] = row;
            } catch (error) { failure = failure || error; }
            finally { bytesInFlight -= entry.length; for (const resolve of waiters.splice(0)) resolve(); }
          }
        }
        await Promise.all(Array.from({ length: Math.min(historyReadConcurrency, selected.length) }, worker));
        if (failure) throw failure;
        need(stamp(await handle.stat({ bigint: true })) === owner.source.history, "COMPANY_DETAIL_SOURCE_INDEX_SOURCE_CHANGED");
        await stillCurrent(owner); return rows;
      } finally { await handle.close(); }
    } catch (error) { return derivedFailure(error); } finally { unpin(owner); }
  }
  return { prepare, readMaster, readHistory, status: () => ({ ...state, source: manifest ? { ...manifest.source } : null,
    ...(["preparing", "waiting"].includes(state.phase) && state.startedAt ? { elapsedMs: Date.now() - Date.parse(state.startedAt) } : {}) }) };
}

module.exports = { createCompanyDetailSourceIndex, defaultHistoryIdentity, VERSION };
