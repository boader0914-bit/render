"use strict";

// Derived, immutable generations of a prepared company catalog. Only compact
// global metadata stays in memory; full product inventories are read one
// selected company at a time. Original collection/master files are never written.
const fs = require("node:fs/promises"), native = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const sha = value => crypto.createHash("sha256").update(value).digest("hex");
const clone = value => JSON.parse(JSON.stringify(value));
const object = value => value && typeof value === "object" && !Array.isArray(value);
const stamp = value => [value.size, value.mtimeNs, value.ctimeNs, value.ino, value.dev].map(String).join(":");
const fail = code => { throw Object.assign(new Error(code), { code, statusCode: 503 }); };
const need = (value, code = "MONTHLY_COMPANY_SOURCE_INVALID") => { if (!value) fail(code); };
const GENERATION = /^generation-[a-f0-9]{32}$/, RECORD = /^[a-f0-9]{64}[.]json$/;
function capacityNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const normalized = String(value).replace(/,/g, "").replace(/[^\d.-]/g, "");
  if (!normalized || normalized === "-" || normalized === ".") return null;
  const number = Number(normalized); return Number.isFinite(number) ? number : null;
}

// withCompanyInventoryCapacityRecord/companyMaximumRoomCapacity inspect these
// exact snapshot fields. Keep an actual maximum-rawTotal witness, never create
// inferred inventory rows or promote missing evidence to a quantity.
function compactCapacitySnapshot(snapshot) {
  if (!object(snapshot)) return snapshot;
  const selected = Object.fromEntries(["runId", "collectedAt", "inventoryEvidenceVersion", "capacityBasis", "manualCorrectionApplied", "correctionBasis", "stockBasis"]
    .filter(key => Object.hasOwn(snapshot, key)).map(key => [key, snapshot[key]]));
  const product = snapshot.productSnapshot;
  if (object(product)) {
    const daily = Array.isArray(product.daily) ? product.daily : [];
    let witness = null, maximum = -Infinity;
    for (const row of daily) {
      if (!row || row.productType !== "lodging" || row.missing) continue;
      const count = capacityNumber(row.rawTotal);
      if (count !== null && count > maximum) { maximum = count; witness = row; }
    }
    selected.productSnapshot = Object.fromEntries(["runId", "dailyRunId", "collectedAt", "inventoryEvidenceVersion", "capacityBasis"]
      .filter(key => Object.hasOwn(product, key)).map(key => [key, product[key]]));
    selected.productSnapshot.daily = witness ? [Object.fromEntries(["productType", "missing", "rawTotal"].filter(key => Object.hasOwn(witness, key)).map(key => [key, witness[key]]))] : [];
  }
  return selected;
}
function compactMonthlyCapacityCompany(company) {
  need(object(company) && typeof company.companyId === "string");
  const fields = ["companyId", "primaryName", "nameKey", "aliases", "placeIds", "bookingBusinessIds", "lodgingTypes", "manualCorrection", "manualCorrectionRevision", "_integratedCapacity",
    "duplicateNotes", "runIds", "firstRunId", "lastRunId", "deletedAt", "mergedIntoCompanyId"];
  const compact = Object.fromEntries(fields.filter(key => Object.hasOwn(company, key)).map(key => [key, company[key]]));
  compact.keywords = Object.fromEntries(Object.entries(company.keywords || {}).map(([key, exposure]) => {
    need(!exposure?.runs || Array.isArray(exposure.runs));
    return [key, { keyword: exposure?.keyword, runs: (exposure?.runs || []).map(run => Object.fromEntries(["runId", "id", "collectedAt", "rank", "overallRank"].filter(field => Object.hasOwn(run || {}, field)).map(field => [field, run[field]]))) }];
  }));
  const inventory = company.inventory || {};
  compact.inventory = { ...(Object.hasOwn(inventory, "runIds") ? { runIds: inventory.runIds } : {}),
    latest: compactCapacitySnapshot(inventory.latest), previousLatest: compactCapacitySnapshot(inventory.previousLatest),
    snapshots: (Array.isArray(inventory.snapshots) ? inventory.snapshots : []).map(compactCapacitySnapshot) };
  const fallbackMonths = {};
  for (const snapshot of [inventory.latest, inventory.previousLatest, ...(inventory.snapshots || [])].filter(Boolean)) for (const row of snapshot.productSnapshot?.daily || []) {
    const date = String(row.stayDate || row.date || ""), month = date.slice(0, 7);
    if (/^\d{4}-(0[1-9]|1[0-2])$/.test(month) && date.startsWith(month + "-")) fallbackMonths[month] = (fallbackMonths[month] || 0) + 1;
  }
  compact._monthlySourceCompact = true;
  compact._monthlySourceFallbackMonths = fallbackMonths;
  return clone(compact);
}

function createMonthlyCompanySourceCatalog({ dataDir, readRevision, loadFullCatalog, projectCapacityCompany,
  version = "monthly-company-source-v1", maxCatalogBytes = 24 * 1024 * 1024, maxCompanyBytes = 32 * 1024 * 1024,
  maxGenerationBytes = 512 * 1024 * 1024, maxStoredGenerations = 6, maxStoredBytes = maxGenerationBytes * 6 } = {}) {
  if (!dataDir || [readRevision, loadFullCatalog, projectCapacityCompany].some(fn => typeof fn !== "function") || typeof version !== "string" || !version
    || [maxCatalogBytes, maxCompanyBytes, maxGenerationBytes, maxStoredBytes].some(value => !Number.isSafeInteger(value) || value < 128)
    || !Number.isSafeInteger(maxStoredGenerations) || maxStoredGenerations < 3 || maxStoredGenerations > 64) throw new TypeError("Verified company-source catalog inputs are required");
  const directory = path.join(path.resolve(dataDir), "monthly_reports", "company_sources"), pointerFile = path.join(directory, "current.json");
  const codeVersion = sha(native.readFileSync(__filename)), schemaVersion = 1;
  const calculationVersion = sha(JSON.stringify([version, codeVersion, Function.prototype.toString.call(projectCapacityCompany)]));
  let memory = null, serial = Promise.resolve();
  const counters = { builds: 0, hits: 0, memoryHits: 0, savedHits: 0, revisionReads: 0, buildRetries: 0, fullCatalogReads: 0, companyBodyReads: 0,
    companyBodyBytes: 0, generationWrittenBytes: 0, compactBytes: 0, cleanupFailures: 0, retainedFullCompanies: 0, maximumSelectedCompanyBytes: 0,
    abandonedGenerationsRemoved: 0, abandonedCleanupFailures: 0, storageLimitStops: 0 };
  const schedule = operation => { const pending = serial.then(operation); serial = pending.catch(() => {}); return pending; };
  async function revision() {
    counters.revisionReads++; let value;
    try { value = await readRevision(); } catch { fail("MONTHLY_COMPANY_SOURCE_REVISION_UNAVAILABLE"); }
    need(typeof value === "string" && value.length > 0 && value.length <= 1024, "MONTHLY_COMPANY_SOURCE_REVISION_UNAVAILABLE"); return value;
  }
  async function safeDirectory(file, create = false) {
    if (create) {
      const resolved = path.resolve(file), root = path.parse(resolved).root;
      let current = root;
      for (const part of resolved.slice(root.length).split(path.sep).filter(Boolean)) {
        current = path.join(current, part);
        try { const prior = await fs.lstat(current); need(prior.isDirectory() && !prior.isSymbolicLink(), "MONTHLY_COMPANY_SOURCE_DIRECTORY_INVALID"); }
        catch (error) { if (error.code !== "ENOENT") throw error; await fs.mkdir(current, { mode: 0o700 }); }
        need(path.resolve(await fs.realpath(current)) === path.resolve(current), "MONTHLY_COMPANY_SOURCE_DIRECTORY_INVALID");
      }
    }
    const value = await fs.lstat(file); need(value.isDirectory() && !value.isSymbolicLink() && path.resolve(await fs.realpath(file)) === path.resolve(file), "MONTHLY_COMPANY_SOURCE_DIRECTORY_INVALID");
  }
  async function readBytes(file, limit) {
    const before = await fs.lstat(file, { bigint: true }); need(before.isFile() && !before.isSymbolicLink() && before.size <= BigInt(limit), "MONTHLY_COMPANY_SOURCE_CACHE_INVALID");
    const handle = await fs.open(file, native.constants.O_RDONLY | (native.constants.O_NOFOLLOW || 0));
    try { need(stamp(await handle.stat({ bigint: true })) === stamp(before), "MONTHLY_COMPANY_SOURCE_CACHE_CHANGED");
      const bytes = await handle.readFile(); need(BigInt(bytes.length) === before.size && stamp(await handle.stat({ bigint: true })) === stamp(before)
        && stamp(await fs.lstat(file, { bigint: true })) === stamp(before), "MONTHLY_COMPANY_SOURCE_CACHE_CHANGED"); return { bytes, stat: stamp(before) };
    } finally { await handle.close(); }
  }
  async function writeExclusive(file, bytes) { const handle = await fs.open(file, "wx", 0o600); try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); } }
  function validPointer(pointer) { return pointer?.schemaVersion === schemaVersion && GENERATION.test(pointer.generation) && typeof pointer.sourceRevision === "string"
    && typeof pointer.calculationVersion === "string" && /^[a-f0-9]{64}$/.test(pointer.catalogSha256 || ""); }
  function validCatalog(value, pointer) {
    return value?.schemaVersion === schemaVersion && value.sourceRevision === pointer.sourceRevision && value.calculationVersion === pointer.calculationVersion
      && Array.isArray(value.companies) && Array.isArray(value.regions) && Array.isArray(value.runs) && Array.isArray(value.rawCompanies)
      && object(value.records) && value.companies.every(company => typeof company?.companyId === "string" && object(value.records[company.companyId]))
      && new Set(value.companies.map(company => company.companyId)).size === value.companies.length
      && value.rawCompanies.length === value.companies.length && value.rawCompanies.every(row => Array.isArray(row) && row.length === 2 && object(row[1]) && row[1].companyId === row[0]
        && value.records[row[0]]?.file === sha(row[0]) + ".json" && /^[a-f0-9]{64}$/.test(value.records[row[0]].sha256 || "")
        && Number.isSafeInteger(value.records[row[0]].bytes) && value.records[row[0]].bytes >= 1 && value.records[row[0]].bytes <= maxCompanyBytes);
  }
  async function saved() {
    let pointerRead;
    try { pointerRead = await readBytes(pointerFile, 16 * 1024); }
    catch (error) { if (error.code === "ENOENT" && !memory) return null; throw error; }
    let pointer; try { pointer = JSON.parse(pointerRead.bytes); } catch { fail("MONTHLY_COMPANY_SOURCE_CACHE_INVALID"); }
    need(validPointer(pointer), "MONTHLY_COMPANY_SOURCE_CACHE_INVALID");
    const generationDirectory = path.join(directory, pointer.generation); await safeDirectory(generationDirectory);
    const catalogFile = path.join(generationDirectory, "catalog.json"), stat = await fs.lstat(catalogFile, { bigint: true });
    need(stat.isFile() && !stat.isSymbolicLink() && stat.size <= BigInt(maxCatalogBytes), "MONTHLY_COMPANY_SOURCE_CACHE_INVALID");
    if (memory && memory.pointerStat === pointerRead.stat && memory.catalogStat === stamp(stat) && memory.pointer.catalogSha256 === pointer.catalogSha256) { counters.memoryHits++; return memory; }
    const content = await readBytes(catalogFile, maxCatalogBytes); need(sha(content.bytes) === pointer.catalogSha256, "MONTHLY_COMPANY_SOURCE_CACHE_INVALID");
    let value; try { value = JSON.parse(content.bytes); } catch { fail("MONTHLY_COMPANY_SOURCE_CACHE_INVALID"); }
    need(validCatalog(value, pointer), "MONTHLY_COMPANY_SOURCE_CACHE_INVALID");
    counters.savedHits++; memory = { pointer, pointerStat: pointerRead.stat, catalogStat: content.stat, value }; return memory;
  }
  async function cleanup(keep) {
    // Only known files directly inside our generated directories are removed.
    // Never recurse through a computed path or follow a symlink.
    try {
      const entries = await fs.readdir(directory, { withFileTypes: true });
      for (const entry of entries) {
        if (!GENERATION.test(entry.name) || keep.has(entry.name) || !entry.isDirectory() || entry.isSymbolicLink()) continue;
        const full = path.join(directory, entry.name); await safeDirectory(full);
        const files = await fs.readdir(full, { withFileTypes: true });
        if (files.some(file => !file.isFile() || file.isSymbolicLink() || !(file.name === "catalog.json" || RECORD.test(file.name)))) { counters.cleanupFailures++; continue; }
        for (const file of files) await fs.unlink(path.join(full, file.name));
        await fs.rmdir(full);
      }
    } catch { counters.cleanupFailures++; }
  }
  async function checkStorageBudget() {
    const entries = await fs.readdir(directory, { withFileTypes: true }), generations = entries.filter(entry => GENERATION.test(entry.name));
    let bytes = 0n;
    const limited = () => { counters.storageLimitStops++; fail("MONTHLY_COMPANY_SOURCE_STORAGE_LIMIT"); };
    if (generations.length >= maxStoredGenerations) limited();
    for (const entry of generations) {
      need(entry.isDirectory() && !entry.isSymbolicLink(), "MONTHLY_COMPANY_SOURCE_DIRECTORY_INVALID");
      const full = path.join(directory, entry.name); await safeDirectory(full);
      for (const file of await fs.readdir(full, { withFileTypes: true })) {
        need(file.isFile() && !file.isSymbolicLink(), "MONTHLY_COMPANY_SOURCE_DIRECTORY_INVALID");
        const stat = await fs.lstat(path.join(full, file.name), { bigint: true });
        need(stat.isFile() && !stat.isSymbolicLink(), "MONTHLY_COMPANY_SOURCE_DIRECTORY_INVALID"); bytes += stat.size;
        if (bytes + BigInt(maxGenerationBytes) > BigInt(maxStoredBytes)) limited();
      }
    }
    if (bytes + BigInt(maxGenerationBytes) > BigInt(maxStoredBytes)) limited();
  }
  async function removeAbandonedGeneration(generation) {
    // This is only called for the random generation created by this attempt.
    // A failed build must neither sweep another reader's generation nor remove
    // a pointer published by an uncertain rename result.
    try {
      need(GENERATION.test(generation), "MONTHLY_COMPANY_SOURCE_DIRECTORY_INVALID");
      await safeDirectory(directory);
      try {
        const current = JSON.parse((await readBytes(pointerFile, 16 * 1024)).bytes);
        need(validPointer(current), "MONTHLY_COMPANY_SOURCE_CACHE_INVALID");
        if (current.generation === generation) return;
      } catch (error) { if (error.code !== "ENOENT") throw error; }
      const full = path.join(directory, generation); await safeDirectory(full);
      const files = await fs.readdir(full, { withFileTypes: true });
      need(files.every(file => file.isFile() && !file.isSymbolicLink() && (file.name === "catalog.json" || RECORD.test(file.name))), "MONTHLY_COMPANY_SOURCE_DIRECTORY_INVALID");
      for (const file of files) await fs.unlink(path.join(full, file.name));
      await fs.rmdir(full); counters.abandonedGenerationsRemoved++;
    } catch { counters.cleanupFailures++; counters.abandonedCleanupFailures++; }
  }
  async function build(options, previous) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const before = await revision(), generation = "generation-" + crypto.randomUUID().replace(/-/g, ""), generationDirectory = path.join(directory, generation);
      await safeDirectory(directory, true); await checkStorageBudget(); await fs.mkdir(generationDirectory, { mode: 0o700 });
      let published = false;
      try {
      counters.fullCatalogReads++; const full = await loadFullCatalog(options);
      need(full && Array.isArray(full.companies) && full.rawCompanies instanceof Map && Array.isArray(full.runs) && Array.isArray(full.regions));
      const value = { schemaVersion, calculationVersion, sourceRevision: before, companies: full.companies, regions: full.regions, runs: full.runs, rawCompanies: [], records: Object.create(null) };
      let written = 0;
      for (const company of full.companies) {
        const id = company.companyId, raw = full.rawCompanies.get(id);
        need(typeof id === "string" && id.length > 0 && id.length <= 300 && object(raw) && raw.companyId === id && !Object.hasOwn(value.records, id));
        const compact = projectCapacityCompany(raw); need(object(compact) && compact.companyId === id);
        value.rawCompanies.push([id, compact]);
        const encoded = Buffer.from(JSON.stringify({ companyId: id, company: raw })), file = sha(id) + ".json";
        need(encoded.length <= maxCompanyBytes && written + encoded.length <= maxGenerationBytes, "MONTHLY_COMPANY_SOURCE_TOO_LARGE");
        await writeExclusive(path.join(generationDirectory, file), encoded); written += encoded.length;
        value.records[id] = { file, bytes: encoded.length, sha256: sha(encoded) };
        if (typeof options?.checkpoint === "function") await options.checkpoint();
      }
      const bytes = Buffer.from(JSON.stringify(value)); need(bytes.length <= maxCatalogBytes && written + bytes.length <= maxGenerationBytes, "MONTHLY_COMPANY_SOURCE_TOO_LARGE");
      await writeExclusive(path.join(generationDirectory, "catalog.json"), bytes); written += bytes.length;
      if (await revision() !== before) { counters.buildRetries++; continue; }
      const pointer = { schemaVersion, sourceRevision: before, calculationVersion, generation, catalogSha256: sha(bytes) }, temporary = pointerFile + "." + crypto.randomUUID() + ".tmp";
      try { await writeExclusive(temporary, JSON.stringify(pointer)); if (await revision() !== before) { counters.buildRetries++; continue; } await fs.rename(temporary, pointerFile); published = true; }
      finally { await fs.unlink(temporary).catch(() => {}); }
      counters.builds++; counters.generationWrittenBytes += written; counters.compactBytes = bytes.length;
      memory = { pointer, pointerStat: stamp(await fs.lstat(pointerFile, { bigint: true })), catalogStat: stamp(await fs.lstat(path.join(generationDirectory, "catalog.json"), { bigint: true })), value };
      await cleanup(new Set([generation, previous?.pointer.generation].filter(Boolean))); return memory;
      } finally { if (!published) await removeAbandonedGeneration(generation); }
    }
    fail("MONTHLY_COMPANY_SOURCE_CHANGED");
  }
  async function readCompany(entry, id) {
    const record = entry.value.records[id]; need(record && RECORD.test(record.file), "MONTHLY_COMPANY_SOURCE_COMPANY_NOT_FOUND");
    const generationDirectory = path.join(directory, entry.pointer.generation); await safeDirectory(generationDirectory);
    const content = await readBytes(path.join(generationDirectory, record.file), maxCompanyBytes);
    need(content.bytes.length === record.bytes && sha(content.bytes) === record.sha256, "MONTHLY_COMPANY_SOURCE_CACHE_INVALID");
    let value; try { value = JSON.parse(content.bytes); } catch { fail("MONTHLY_COMPANY_SOURCE_CACHE_INVALID"); }
    need(value?.companyId === id && object(value.company) && value.company.companyId === id, "MONTHLY_COMPANY_SOURCE_CACHE_INVALID");
    counters.companyBodyReads++; counters.companyBodyBytes += content.bytes.length;
    counters.maximumSelectedCompanyBytes = Math.max(counters.maximumSelectedCompanyBytes, content.bytes.length);
    return value.company;
  }
  async function readOwned(companyId, options) {
    const current = await revision(); let entry = await saved();
    if (!entry || entry.pointer.sourceRevision !== current || entry.pointer.calculationVersion !== calculationVersion) entry = await build(options, entry);
    else counters.hits++;
    const assertCurrent = async () => { if (await revision() !== entry.pointer.sourceRevision) fail("MONTHLY_COMPANY_SOURCE_CHANGED"); };
    await assertCurrent();
    const copied = clone({ companies: entry.value.companies, regions: entry.value.regions, runs: entry.value.runs, rawCompanies: entry.value.rawCompanies });
    const data = { companies: copied.companies, regions: copied.regions, runs: copied.runs, rawCompanies: new Map(copied.rawCompanies) };
    if (entry.value.records[companyId]) data.rawCompanies.set(companyId, await readCompany(entry, companyId));
    await assertCurrent();
    Object.defineProperty(data, "_companySource", { enumerable: false, value: { revision: sha(JSON.stringify([calculationVersion, entry.pointer.sourceRevision])),
      readCompany: id => readCompany(entry, id), assertCurrent } });
    return data;
  }
  return { readCompanyCatalog: (companyId, options = {}) => schedule(() => readOwned(String(companyId), options)), stats: () => ({ ...counters }),
    directory, calculationVersion };
}

module.exports = { createMonthlyCompanySourceCatalog, compactMonthlyCapacityCompany };
