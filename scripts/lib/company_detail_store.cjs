"use strict";

// A rebuildable, company-scoped read model. Neither raw input nor integrated
// monthly aggregates are written here. Cached detail is usable only while all
// of the saved inputs that produced it still have the same verified identity.
const fs = require("node:fs/promises");
const native = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const readline = require("node:readline");
const VERSION = "company-detail-read-model-v1";
const hash = value => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
const fault = (code = "COMPANY_DETAIL_SOURCE_UNAVAILABLE") => Object.assign(
  new Error("업체 상세 자료를 확인하지 못했습니다. 잠시 후 다시 조회해 주세요."), { code, statusCode: 503 });
const need = (condition, code) => { if (!condition) throw fault(code); };
const stamp = stat => [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].map(String).join(":");

function jsonStructureValidator() {
  const stack = []; let root = "value", quoted = false, escape = false, unicode = 0, scalar = "", first = true;
  const valid = value => need(value, "COMPANY_DETAIL_MASTER_INVALID");
  const expectsValue = () => stack.length ? ["value", "valueOrEnd"].includes(stack.at(-1).state) : root === "value";
  function complete() {
    valid(expectsValue());
    if (stack.length) stack.at(-1).state = "commaOrEnd"; else root = "end";
  }
  function scalarEnd() {
    if (!scalar) return;
    valid(/^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)$/.test(scalar)); scalar = ""; complete();
  }
  function push(chunk) {
    for (let index = 0; index < chunk.length; index++) {
      const ch = chunk[index];
      if (first) { first = false; if (ch === "\uFEFF") continue; }
      if (quoted) {
        if (unicode) { valid(/[0-9a-f]/i.test(ch)); unicode--; }
        else if (escape) { valid('"\\/bfnrtu'.includes(ch)); escape = false; if (ch === "u") unicode = 4; }
        else if (ch === "\\") escape = true;
        else if (ch === '"') {
          quoted = false;
          const frame = stack.at(-1);
          if (frame?.kind === "object" && ["keyOrEnd", "key"].includes(frame.state)) frame.state = "colon";
          else complete();
        } else valid(ch.charCodeAt(0) >= 0x20);
        continue;
      }
      if (scalar) {
        if (!/[\x20\x09\x0a\x0d,}\]]/.test(ch)) { scalar += ch; valid(scalar.length <= 1024); continue; }
        scalarEnd();
      }
      if (/[\x20\x09\x0a\x0d]/.test(ch)) continue;
      const frame = stack.at(-1);
      if (ch === '"') { valid(expectsValue() || frame?.kind === "object" && ["keyOrEnd", "key"].includes(frame.state)); quoted = true; }
      else if (ch === "{" || ch === "[") { valid(expectsValue()); stack.push({ kind: ch === "{" ? "object" : "array", state: ch === "{" ? "keyOrEnd" : "valueOrEnd" }); }
      else if (ch === "}" || ch === "]") {
        valid(frame && frame.kind === (ch === "}" ? "object" : "array") && ["keyOrEnd", "valueOrEnd", "commaOrEnd"].includes(frame.state)); stack.pop(); complete();
      } else if (ch === ",") { valid(frame?.state === "commaOrEnd"); frame.state = frame.kind === "object" ? "key" : "value"; }
      else if (ch === ":") { valid(frame?.kind === "object" && frame.state === "colon"); frame.state = "value"; }
      else { valid(expectsValue() && /[-\dtnf]/.test(ch)); scalar = ch; }
    }
  }
  return { push, end() { scalarEnd(); valid(root === "end" && stack.length === 0 && !quoted && !escape && !unicode); } };
}

// Parse one member of the companies map at a time instead of allocating the
// complete company master. Structural characters inside escaped strings do not
// affect the scanner. The retained master contains only selected-company data
// and the small keyword/run fields required by the existing rank benchmark.
async function readScopedCompanyMaster(file, companyId, { stream = filename => native.createReadStream(filename, { encoding: "utf8", highWaterMark: 64 * 1024 }) } = {}) {
  const validator = jsonStructureValidator();
  const companies = Object.create(null);
  let depth = 0, quoted = false, escaped = false, token = "", stringDepth = 0;
  let rootKey = "", memberKey = "", rootWantsKey = false, companyWantsKey = false;
  let companiesDeclared = false;
  const seenCompanyKeys = new Set();
  let companiesSeen = false, inCompanies = false, companiesDone = false;
  let capturing = false, record = [], recordStart = -1, rootEnded = false;
  const input = stream(file);
  try {
    for await (let chunk of input) {
      chunk = String(chunk);
      validator.push(chunk);
      recordStart = capturing ? 0 : -1;
      for (let index = 0; index < chunk.length; index += 1) {
        const ch = chunk[index];
        if (quoted) {
          if (stringDepth <= 2 && !capturing) token += ch;
          if (escaped) escaped = false;
          else if (ch === "\\") escaped = true;
          else if (ch === '"') {
            quoted = false;
            if (stringDepth === 1 && rootWantsKey) {
              rootKey = JSON.parse(token); rootWantsKey = false;
              if (rootKey === "companies") { need(!companiesDeclared, "COMPANY_DETAIL_MASTER_INVALID"); companiesDeclared = true; }
            }
            else if (inCompanies && stringDepth === 2 && companyWantsKey) {
              memberKey = JSON.parse(token); companyWantsKey = false;
              need(!seenCompanyKeys.has(memberKey), "COMPANY_DETAIL_MASTER_INVALID"); seenCompanyKeys.add(memberKey);
            }
            token = "";
          }
          continue;
        }
        if (ch === '"') {
          need(!(inCompanies && depth === 2 && !companyWantsKey) && !(depth === 1 && rootKey === "companies" && !rootWantsKey), "COMPANY_DETAIL_MASTER_INVALID");
          quoted = true; stringDepth = depth; token = '"'; continue;
        }
        if (ch === "{" || ch === "[") {
          need(!rootEnded, "COMPANY_DETAIL_MASTER_INVALID");
          if (depth === 0) { need(ch === "{"); rootWantsKey = true; }
          else if (depth === 1 && rootKey === "companies") {
            need(ch === "{" && !companiesSeen, "COMPANY_DETAIL_MASTER_INVALID");
            companiesSeen = true; inCompanies = true; companyWantsKey = true;
          } else if (inCompanies && depth === 2) {
            need(ch === "{" && memberKey, "COMPANY_DETAIL_MASTER_INVALID");
            capturing = true; recordStart = index; record = [];
          }
          depth += 1;
        } else if (ch === "}" || ch === "]") {
          depth -= 1;
          need(depth >= 0, "COMPANY_DETAIL_MASTER_INVALID");
          if (capturing && depth === 2) {
            record.push(chunk.slice(recordStart, index + 1));
            const value = JSON.parse(record.join(""));
            need(value && typeof value === "object" && !Array.isArray(value), "COMPANY_DETAIL_MASTER_INVALID");
            companies[memberKey] = memberKey === companyId ? value : { keywords: value.keywords || {} };
            capturing = false; record = []; recordStart = -1; memberKey = "";
          } else if (inCompanies && depth === 1) { inCompanies = false; companiesDone = true; }
          else if (depth === 0) rootEnded = true;
        } else if (ch === ",") {
          if (depth === 1) { rootWantsKey = true; rootKey = ""; }
          else if (inCompanies && depth === 2) companyWantsKey = true;
        } else if ((rootEnded || inCompanies && depth === 2 && memberKey || depth === 1 && rootKey === "companies")
          && !/[\x20\x09\x0a\x0d:]/.test(ch)) throw fault("COMPANY_DETAIL_MASTER_INVALID");
      }
      if (capturing && recordStart >= 0) record.push(chunk.slice(recordStart));
    }
  } catch (error) {
    if (error.code?.startsWith("COMPANY_DETAIL_")) throw error;
    throw fault("COMPANY_DETAIL_MASTER_INVALID");
  } finally { input.destroy?.(); }
  validator.end();
  need(rootEnded && depth === 0 && !quoted && !capturing && companiesSeen && companiesDone, "COMPANY_DETAIL_MASTER_INVALID");
  return { companies };
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
  masterReader = readScopedCompanyMaster, historyReader = readScopedCompanyHistory, maxMemoryBytes = 16 * 1024 * 1024 } = {}) {
  need(dataDir && projectionVersion && typeof build === "function" && typeof matchesObservation === "function" && typeof runIdsForCompany === "function");
  const masterFile = path.join(dataDir, "company_master", "companies.json");
  const historyFile = path.join(dataDir, "history", "observations.jsonl");
  const cacheDir = path.join(dataDir, "company_master", "detail_read_models");
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
