"use strict";

// A small, rebuildable metadata view for saved company-month reads. It never
// retains the complete inventory or enters the raw source scheduler on a hit.
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");

const sha = value => crypto.createHash("sha256").update(value).digest("hex");
const clone = value => JSON.parse(JSON.stringify(value));
const identity = row => String(row?.companyId || row?.companyKey || row?.id || "");
const signature = stat => [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].map(String).join(":");
function fault(code = "COMPANY_CATALOG_SOURCE_UNAVAILABLE") {
  return Object.assign(new Error("업체 기본자료의 준비 상태를 확인하지 못했습니다."), { code, statusCode: 503 });
}
const need = (value, code) => { if (!value) throw fault(code); };

function compactCompanyCatalog(data) {
  need(data && Array.isArray(data.companies) && Array.isArray(data.runs)
    && data.rawCompanies && typeof data.rawCompanies === "object", "COMPANY_CATALOG_INVALID");
  const companies = [], rawCompanies = [];
  for (const company of data.companies) {
    const id = identity(company);
    const raw = data.rawCompanies instanceof Map ? data.rawCompanies.get(id) : data.rawCompanies[id];
    need(id && id.length <= 300 && !/[\x00-\x1f\x7f]/.test(id), "COMPANY_CATALOG_INVALID");
    if (company.deletedAt || company.mergedIntoCompanyId || raw?.deletedAt || raw?.mergedIntoCompanyId) continue;
    companies.push({ companyId: id, primaryName: company.primaryName, capacity: company.capacity,
      capacitySource: company.capacitySource, capacityBasis: company.capacityBasis });
    if (raw) rawCompanies.push([id, { manualCorrection: raw.manualCorrection, _integratedCapacity: raw._integratedCapacity,
      keywords: Object.fromEntries(Object.entries(raw.keywords || {}).map(([key, exposure]) => [key, {
        keyword: exposure.keyword, runs: (exposure.runs || []).map(run => ({
          runId: run.runId, id: run.id, collectedAt: run.collectedAt, rank: run.rank, overallRank: run.overallRank
        }))
      }])) }]);
  }
  need(new Set(companies.map(company => company.companyId)).size === companies.length, "COMPANY_CATALOG_INVALID");
  return clone({ companies, rawCompanies, runs: data.runs.map(run => ({
    id: run.id, runId: run.runId, collectionQuality: { status: run.collectionQuality?.status }
  })) });
}
function validCompact(value) {
  if (!value || !Array.isArray(value.companies) || !Array.isArray(value.rawCompanies) || !Array.isArray(value.runs)) return false;
  const ids = value.companies.map(identity);
  return ids.every(id => id && id.length <= 300 && !/[\x00-\x1f\x7f]/.test(id))
    && new Set(ids).size === ids.length && value.rawCompanies.every(row =>
      Array.isArray(row) && row.length === 2 && ids.includes(row[0]) && row[1] && typeof row[1] === "object");
}
function asCatalog(value) {
  const copied = clone(value);
  return { companies: copied.companies, rawCompanies: new Map(copied.rawCompanies), runs: copied.runs };
}

function createRevisionCheckedCompanyCatalog({ catalog, readRevision, runWork = operation => operation() }) {
  if (typeof catalog !== "function" || typeof readRevision !== "function" || typeof runWork !== "function") throw new TypeError("Catalog source verification inputs are required");
  let active = null;
  async function checkedRevision() {
    let value;
    try { value = await readRevision(); } catch { throw fault(); }
    need(typeof value === "string" && value.length > 0, "COMPANY_CATALOG_SOURCE_UNAVAILABLE");
    return value;
  }
  async function read(options) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const before = await checkedRevision();
      let data;
      try { data = await catalog(options); } catch { throw fault(); }
      if (await checkedRevision() === before) return data;
    }
    throw fault("COMPANY_CATALOG_SOURCE_CHANGED");
  }
  // Install before the original catalog is handed to any consumer. Otherwise
  // its own older in-flight read could predate our first revision inspection.
  function checkedOwned(options) {
    if (active) return active;
    const task = read(options);
    active = task;
    task.finally(() => { if (active === task) active = null; }).catch(() => {});
    return task;
  }
  // An externally queued flight must not exist before it owns the heavy
  // lease: a later lease owner could otherwise join it while it waits on that
  // same owner. Nested reads reenter their owner's lease before sharing work.
  return options => runWork(() => checkedOwned(options), { ...options, kind: "verified-company-catalog" });
}

function createCompanyIntegratedCatalogRevision({ dataDir, readSelectorRevision, fileSystem = fs }) {
  if (!dataDir || typeof readSelectorRevision !== "function") throw new TypeError("Company metadata revision inputs are required");
  async function stamp(file, required = false) {
    let stat;
    try { stat = await fileSystem.lstat(file, { bigint: true }); }
    catch (error) { if (error.code === "ENOENT" && !required) return "missing"; throw fault(); }
    need(stat.isFile() && !stat.isSymbolicLink(), "COMPANY_CATALOG_SOURCE_UNAVAILABLE");
    return signature(stat);
  }
  return async function readCompanyCatalogRevision() {
    try {
      // The selector reader checks saved run manifests, shallow run membership,
      // master/history metadata and the region reference; never booking bodies.
      const [selector, master, capacity] = await Promise.all([
        readSelectorRevision(),
        stamp(path.join(dataDir, "company_master", "companies.json"), true),
        stamp(path.join(dataDir, "company_integrated", "capacity-bases.json"))
      ]);
      need(typeof selector === "string" && selector.length > 0, "COMPANY_CATALOG_SOURCE_UNAVAILABLE");
      return sha(JSON.stringify(["company-catalog-source-v1", selector, master, capacity]));
    } catch { throw fault(); }
  };
}

function createCompanyIntegratedCatalog({ dataDir, catalog, readRevision, readPreviewRevision = null, version = "company-catalog-v1",
  now = () => new Date(), fileSystem = fs, maxBytes = 8 * 1024 * 1024, runWork = operation => operation() } = {}) {
  if (!dataDir || typeof catalog !== "function" || typeof readRevision !== "function"
    || readPreviewRevision !== null && typeof readPreviewRevision !== "function"
    || !Number.isSafeInteger(maxBytes) || maxBytes < 128 || typeof runWork !== "function") throw new TypeError("Company metadata cache inputs are required");
  const file = path.join(dataDir, "company_integrated", "catalog.json");
  let memory = null, memoryPreview = null, building = null, epoch = 0, lastStatus = null;
  async function previewRevision() {
    if (!readPreviewRevision) return null;
    try {
      const value = await readPreviewRevision();
      return typeof value === "string" && value.trim() && value.length <= 512 ? value : null;
    } catch { return null; }
  }
  async function revision() {
    let value;
    try { value = await readRevision(); } catch { throw fault(); }
    need(typeof value === "string" && value.trim().length > 0 && value.length <= 512, "COMPANY_CATALOG_SOURCE_UNAVAILABLE");
    return value;
  }
  async function saved() {
    let handle;
    try {
      const before = await fileSystem.lstat(file, { bigint: true });
      need(before.isFile() && !before.isSymbolicLink(), "COMPANY_CATALOG_CACHE_UNAVAILABLE");
      if (before.size > BigInt(maxBytes)) return null;
      handle = await fileSystem.open(file, "r");
      const opened = await handle.stat({ bigint: true });
      need(signature(opened) === signature(before), "COMPANY_CATALOG_CACHE_UNAVAILABLE");
      const bytes = Buffer.alloc(Number(before.size) + 1);
      let length = 0;
      while (length < bytes.length) {
        const read = await handle.read(bytes, length, bytes.length - length, null);
        if (!read.bytesRead) break;
        length += read.bytesRead;
      }
      const after = await fileSystem.lstat(file, { bigint: true });
      need(signature(after) === signature(before) && BigInt(length) === before.size, "COMPANY_CATALOG_CACHE_UNAVAILABLE");
      let value;
      try { value = JSON.parse(bytes.subarray(0, length).toString("utf8")); } catch { return null; }
      return value.schemaVersion === 1 && value.version === version && validCompact(value.value)
        && value.valueHash === sha(JSON.stringify(value.value)) ? value : null;
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw fault("COMPANY_CATALOG_CACHE_UNAVAILABLE");
    } finally { if (handle) await handle.close(); }
  }
  async function rebuild(options) {
    // Initial capacity preparation can create its own derived basis file.
    // A second stable pass is allowed; continuously changing input fails closed.
    for (let attempt = 0; attempt < 2; attempt++) {
      const startedEpoch = epoch, before = await revision();
      // Drop the complete source catalog before any validation/write await.
      const value = await (async () => {
        let full;
        try { full = await catalog(options); } catch { throw fault(); }
        return compactCompanyCatalog(full);
      })();
      const entry = { schemaVersion: 1, version, sourceRevision: before,
        calculatedAt: new Date(now()).toISOString(), valueHash: sha(JSON.stringify(value)), value };
      const bytes = Buffer.from(JSON.stringify(entry));
      need(bytes.length <= maxBytes, "COMPANY_CATALOG_TOO_LARGE");
      if (startedEpoch !== epoch || await revision() !== before) continue;
      await fileSystem.mkdir(path.dirname(file), { recursive: true });
      const temp = file + "." + process.pid + "." + crypto.randomUUID() + ".tmp";
      try {
        await fileSystem.writeFile(temp, bytes, { mode: 0o600, flag: "wx" });
        if (startedEpoch !== epoch || await revision() !== before) continue;
        await fileSystem.rename(temp, file);
      } finally { await fileSystem.rm(temp, { force: true }).catch(() => {}); }
      memoryPreview = null;
      memory = entry;
      return entry;
    }
    throw fault("COMPANY_CATALOG_SOURCE_CHANGED");
  }
  function ensureBuilt(options) {
    return runWork(async () => {
      // Another lease can fill the compact store while this caller waits.
      // Recheck before constructing any full source or shared build promise.
      if (memory?.sourceRevision === await revision()) return;
      if (!building) {
        const task = rebuild(options);
        building = task;
        task.finally(() => { if (building === task) building = null; }).catch(() => {});
      }
      await building;
    }, { ...options, kind: "company-catalog-build" });
  }
  async function readCatalogValue(options) {
    let builtThisRead = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      const previewBefore = await previewRevision();
      const currentEpoch = epoch, currentRevision = await revision();
      let candidate = memory, storage = "memory";
      if (!candidate) { candidate = await saved(); storage = "saved"; }
      if (candidate?.sourceRevision === currentRevision) {
        // Bind the compact view only while the ORIGINAL master identity stays
        // unchanged. Derived capacity publication may change its normal source
        // revision later, but cannot certify membership, deletions or reviews.
        // Keep the full source check last, before the synchronous acceptance.
        const previewAfter = await previewRevision();
        if (currentEpoch !== epoch || await revision() !== currentRevision) continue;
        memory = candidate;
        memoryPreview = previewBefore && previewAfter === previewBefore
          ? { entry: candidate, epoch: currentEpoch, revision: previewBefore } : null;
        lastStatus = { status: builtThisRead ? "calculated" : "reused", storage: builtThisRead ? "saved" : storage,
          companyCount: candidate.value.companies.length,
          calculatedAt: candidate.calculatedAt, bytes: Buffer.byteLength(JSON.stringify(candidate)) };
        return asCatalog(candidate.value);
      }
      await ensureBuilt(options);
      builtThisRead = true;
      // Always recheck a shared build against this caller's current source.
    }
    throw fault("COMPANY_CATALOG_SOURCE_CHANGED");
  }
  async function readCatalog(options) {
    try { return await readCatalogValue(options); }
    catch (error) {
      const codes = ["COMPANY_CATALOG_SOURCE_UNAVAILABLE", "COMPANY_CATALOG_CACHE_UNAVAILABLE",
        "COMPANY_CATALOG_SOURCE_CHANGED", "COMPANY_CATALOG_TOO_LARGE", "COMPANY_CATALOG_INVALID"];
      throw fault(codes.includes(error.code) ? error.code : "COMPANY_CATALOG_CACHE_UNAVAILABLE");
    }
  }
  async function preview(options) {
    const saved = memoryPreview;
    const current = () => saved && saved === memoryPreview && saved.entry === memory && saved.epoch === epoch;
    if (current()) {
      const before = await previewRevision();
      if (before && before === saved.revision) {
        const after = await previewRevision();
        if (current() && after === before) {
          lastStatus = { status: "preview", storage: "memory", companyCount: saved.entry.value.companies.length,
            calculatedAt: saved.entry.calculatedAt, bytes: Buffer.byteLength(JSON.stringify(saved.entry)) };
          return asCatalog(saved.entry.value);
        }
      }
    }
    // Uninitialized/changed/uncertain originals use the full existing reader.
    // Never return an old company after an original deletion or reviewed merge.
    return readCatalog(options);
  }
  return { catalog: readCatalog, prepare: readCatalog, preview,
    invalidate() { epoch++; memory = null; memoryPreview = null; },
    status: () => lastStatus ? { ...lastStatus } : null };
}

module.exports = { createCompanyIntegratedCatalog, createCompanyIntegratedCatalogRevision,
  createRevisionCheckedCompanyCatalog, compactCompanyCatalog };
