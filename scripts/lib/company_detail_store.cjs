"use strict";

// A rebuildable, company-scoped read model. Neither raw input nor integrated
// monthly aggregates are written here. Cached detail is usable only while all
// of the saved inputs that produced it still have the same verified identity.
const fs = require("node:fs/promises");
const native = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const readline = require("node:readline");
const { readCompanyMasterProjection } = require("./company_master_stream.cjs");
const VERSION = "company-detail-read-model-v1";
const hash = value => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
const fault = (code = "COMPANY_DETAIL_SOURCE_UNAVAILABLE") => Object.assign(
  new Error("업체 상세 자료를 확인하지 못했습니다. 잠시 후 다시 조회해 주세요."), { code, statusCode: 503 });
const need = (condition, code) => { if (!condition) throw fault(code); };
const stamp = stat => [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].map(String).join(":");

// Preserve the detail reader's selected-company/rank-peer projection while
// sharing complete JSON validation with other low-memory saved-data readers.
async function readScopedCompanyMaster(file, companyId, options = {}) {
  try {
    return await readCompanyMasterProjection(file, { ...options,
      projectCompany: (value, key) => key === companyId ? value : { keywords: value.keywords || {} } });
  } catch { throw fault("COMPANY_DETAIL_MASTER_INVALID"); }
}

async function readScopedCompanyHistory(file, company, matches, { stream = filename => native.createReadStream(filename, { encoding: "utf8", highWaterMark: 64 * 1024 }) } = {}) {
  const rows = new Map();
  const input = readline.createInterface({ input: stream(file), crlfDelay: Infinity });
  try {
    for await (const line of input) {
      if (!line.trim()) continue;
      let row;
      try { row = JSON.parse(line); } catch { continue; } // Existing append-only history tolerates a partial line.
      if (!row?.observationId) continue;
      if (matches(row, company)) rows.set(row.observationId, row);
      // Global history de-duplicates before selecting a company. A later row
      // for another company with the same observation id must remove the old
      // selected row as well, rather than retaining a stale observation.
      else rows.delete(row.observationId);
    }
  } finally { input.close(); input.input.destroy?.(); }
  return [...rows.values()];
}

function createCompanyDetailStore({ dataDir, outputsDir, projectionVersion, build, matchesObservation, runIdsForCompany,
  dayKey = () => new Date(Date.now() + 32400000).toISOString().slice(0, 10), fileSystem = fs,
  masterReader = readScopedCompanyMaster, historyReader = readScopedCompanyHistory, maxMemoryBytes = 16 * 1024 * 1024,
  cacheNamespace = "detail_read_models" } = {}) {
  need(dataDir && projectionVersion && typeof build === "function" && typeof matchesObservation === "function" && typeof runIdsForCompany === "function");
  need(typeof cacheNamespace === "string" && /^[a-z][a-z0-9_-]{0,79}$/.test(cacheNamespace), "COMPANY_DETAIL_CACHE_NAMESPACE_INVALID");
  const masterFile = path.join(dataDir, "company_master", "companies.json");
  const historyFile = path.join(dataDir, "history", "observations.jsonl");
  const cacheDir = path.join(dataDir, "company_master", cacheNamespace);
  const outputs = path.resolve(outputsDir || path.join(dataDir, "outputs"));
  const active = new Map(), memory = new Map(); let memoryBytes = 0;
  function remember(id, entry) {
    if (memory.has(id)) { memoryBytes -= memory.get(id).bytes; memory.delete(id); }
    const bytes = Buffer.byteLength(JSON.stringify(entry));
    if (bytes > maxMemoryBytes) return;
    memory.set(id, { entry, bytes }); memoryBytes += bytes;
    while (memory.size > 8 || memoryBytes > maxMemoryBytes) { const key = memory.keys().next().value; memoryBytes -= memory.get(key).bytes; memory.delete(key); }
  }
  async function stat(file, required = false) {
    try { const value = await fileSystem.lstat(file, { bigint: true }); need(value.isFile() && !value.isSymbolicLink()); return stamp(value); }
    catch (error) { if (error.code === "ENOENT" && !required) return null; throw fault(); }
  }
  async function baseRevision() { return { master: await stat(masterFile, true), history: await stat(historyFile) }; }
  async function runRevision(runIds) {
    const entries = [];
    let count = 0;
    async function visit(directory, relative, depth = 0) {
      need(depth <= 8, "COMPANY_DETAIL_SOURCE_SCAN_LIMIT");
      let dir;
      try {
        const directoryStat = await fileSystem.lstat(directory, { bigint: true });
        need(directoryStat.isDirectory() && !directoryStat.isSymbolicLink());
        entries.push([relative + "/", stamp(directoryStat)]);
        dir = await fileSystem.readdir(directory, { withFileTypes: true });
      }
      catch (error) { if (error.code === "ENOENT") { entries.push([relative, null]); return; } throw fault(); }
      for (const entry of dir.sort((a, b) => a.name.localeCompare(b.name))) {
        need(++count <= 20000 && !entry.isSymbolicLink(), "COMPANY_DETAIL_SOURCE_SCAN_LIMIT");
        const nested = path.join(directory, entry.name), label = relative + "/" + entry.name;
        if (entry.isDirectory()) await visit(nested, label, depth + 1);
        else if (entry.isFile()) entries.push([label, await stat(nested, true)]);
        else throw fault();
      }
    }
    for (const id of runIds) {
      need(typeof id === "string" && id && id !== "." && id !== ".." && path.basename(id) === id && !/[\\/\x00-\x1f]/.test(id));
      const directory = path.resolve(outputs, id);
      need(directory.startsWith(outputs + path.sep));
      await visit(directory, id);
    }
    return hash(entries);
  }
  async function revision(runIds) {
    const before = await baseRevision(), day = dayKey(), runs = await runRevision(runIds);
    need(day === dayKey() && hash(before) === hash(await baseRevision()), "COMPANY_DETAIL_SOURCE_CHANGED");
    return { ...before, runs, day };
  }
  const valid = (entry, id) => entry && entry.version === VERSION && entry.projectionVersion === projectionVersion && entry.source
    && entry.companyId === id && Array.isArray(entry.runIds) && entry.runIds.length <= 120
    && entry.data?.company?.companyId === id && entry.checksum === hash({ ...entry, checksum: undefined });
  async function load(id) {
    need(id && id.length <= 300 && !/[\x00-\x1f\x7f]/.test(id), "COMPANY_DETAIL_ID_INVALID");
    const cacheFile = path.join(cacheDir, hash(id) + ".json");
    let saved = memory.get(id)?.entry, cacheStatus = "memory";
    if (!saved) {
      try { saved = JSON.parse(await fileSystem.readFile(cacheFile, "utf8")); cacheStatus = "saved"; } catch { saved = null; }
    }
    if (valid(saved, id)) {
      const current = await revision(saved.runIds);
      if (saved.source.history && !current.history) throw fault();
      if (hash(current) === hash(saved.source)) { remember(id, saved); return { data: saved.data, cacheStatus, preparedAt: saved.preparedAt }; }
    }
    // Capture the source before and after each bounded read. A racing save can
    // never turn an older detail response into a certified latest result.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const before = await baseRevision();
      const master = await masterReader(masterFile, id);
      const company = master.companies?.[id];
      if (!company) { if (hash(before) !== hash(await baseRevision())) continue; return { data: null, cacheStatus: "missing" }; }
      const runIds = [...new Set(runIdsForCompany(company).map(String))].slice(0, 120);
      const source = { ...before, runs: await runRevision(runIds), day: dayKey() };
      const observations = before.history ? await historyReader(historyFile, company, matchesObservation) : [];
      if (hash(source) !== hash(await revision(runIds))) continue;
      const data = await build(id, { master, observations });
      if (hash(source) !== hash(await revision(runIds))) continue;
      const body = { version: VERSION, projectionVersion, companyId: id, runIds, source, preparedAt: new Date().toISOString(), data };
      const next = { ...body, checksum: hash(body) };
      const temporary = cacheFile + "." + process.pid + "." + crypto.randomBytes(5).toString("hex") + ".tmp";
      try {
        await fileSystem.mkdir(cacheDir, { recursive: true });
        await fileSystem.writeFile(temporary, JSON.stringify(next), { flag: "wx", mode: 0o600 });
        if (hash(source) !== hash(await revision(runIds))) { await fileSystem.unlink(temporary); continue; }
        await fileSystem.rename(temporary, cacheFile);
      } catch (error) {
        await fileSystem.unlink(temporary).catch(() => {});
        throw error.code?.startsWith("COMPANY_DETAIL_") ? error : fault("COMPANY_DETAIL_CACHE_WRITE_FAILED");
      }
      if (hash(source) !== hash(await revision(runIds))) continue;
      remember(id, next);
      return { data, cacheStatus: "calculated", preparedAt: next.preparedAt };
    }
    throw fault("COMPANY_DETAIL_SOURCE_CHANGED");
  }
  return { async get(companyId) {
    const id = String(companyId || "").trim();
    if (active.has(id)) return active.get(id);
    const pending = load(id); active.set(id, pending);
    try { return await pending; } finally { if (active.get(id) === pending) active.delete(id); }
  } };
}

module.exports = { createCompanyDetailStore, readScopedCompanyMaster, readScopedCompanyHistory, VERSION };
