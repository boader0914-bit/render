"use strict";

// A pinned, private source generation. Raw company bodies are loaded only when
// the unchanged source normalizer needs a fallback inventory or company view.
// Capacity preparation belongs to the delta adopter: a lossy capacity compact
// must never be fed back into the original raw-company preparation algorithm.
const { projectMonthlyCatalog } = require("./monthly_report_sources.cjs");
const { compactMonthlyCapacityCompany } = require("./monthly_company_source_catalog.cjs");
const clone = value => JSON.parse(JSON.stringify(value));
const object = value => value && typeof value === "object" && !Array.isArray(value);
const fail = code => { throw Object.assign(new Error(code), { code, statusCode: 503 }); };
const need = (value, code = "KEYWORD_INCREMENTAL_CATALOG_INVALID") => { if (!value) fail(code); };

function freeze(value) {
  const pending = [value];
  while (pending.length) {
    const item = pending.pop();
    if (!object(item) && !Array.isArray(item) || Object.isFrozen(item)) continue;
    Object.freeze(item); for (const child of Object.values(item)) pending.push(child);
  }
  return value;
}

async function createIncrementalCatalog({ entries, runs, regions, revision, readRawCompany,
  prepareCompanies = async companies => companies, projectCapacityCompany = compactMonthlyCapacityCompany,
  capacityForCompany = () => null, assertCurrent = async () => {}, checkpoint = async () => {} } = {}) {
  need(Array.isArray(entries) && Array.isArray(runs) && Array.isArray(regions)
    && typeof revision === "string" && revision.length > 0 && revision.length <= 1024
    && [readRawCompany, prepareCompanies, projectCapacityCompany, capacityForCompany, assertCurrent, checkpoint].every(value => typeof value === "function"));
  const ordered = [...entries].sort((a, b) => a.orderIndex - b.orderIndex), ids = new Set(), orders = new Set(), byId = new Map();
  const inputs = Object.create(null);
  for (const entry of ordered) {
    need(object(entry) && typeof entry.companyId === "string" && entry.companyId.length > 0
      && Number.isSafeInteger(entry.orderIndex) && entry.orderIndex >= 0 && !orders.has(entry.orderIndex)
      && !ids.has(entry.companyId) && object(entry.compact) && entry.compact.companyId === entry.companyId);
    ids.add(entry.companyId); orders.add(entry.orderIndex);
    byId.set(entry.companyId, { companyId: entry.companyId, orderIndex: entry.orderIndex,
      rawSha256: entry.rawSha256, rawPath: entry.rawPath });
    inputs[entry.companyId] = clone(entry.compact);
  }
  await assertCurrent(); await checkpoint();
  // This optional callback can enrich already prepared references. Production
  // passes the identity callback; raw preparation was completed at admission.
  const prepared = await prepareCompanies(inputs, { runs: clone(runs), checkpoint, shareReadOnlyInventory: true });
  need(object(prepared));
  const compact = new Map();
  for (const entry of ordered) {
    const company = prepared[entry.companyId];
    need(object(company) && company.companyId === entry.companyId);
    // Recompacting an existing compact would erase fallback-month metadata:
    // compact snapshots deliberately contain only capacity witnesses.
    const reference = company._monthlySourceCompact ? clone(company) : projectCapacityCompany(company);
    need(object(reference) && reference.companyId === entry.companyId);
    compact.set(entry.companyId, reference);
  }
  const full = await projectMonthlyCatalog({ preparedCompanies: compact, runs: clone(runs), regionMaster: { units: clone(regions) },
    capacityForCompany, checkpoint });
  const metadata = freeze({ companies: full.companies, runs: full.runs, regions: full.regions,
    rawCompanies: [...full.rawCompanies].map(([id, company]) => [id, freeze(company)]) });
  const withoutCapacity = freeze({ ...metadata, companies: metadata.companies.map(company => ({ ...company, capacity: null, capacityBasis: null })) });
  await assertCurrent();
  const counters = { metadataReads: 0, companyBodyReads: 0, retainedFullCompanies: 0, originalMasterReads: 0 };

  async function readCompany(id) {
    const reference = compact.get(id);
    need(reference && !reference.deletedAt && !reference.mergedIntoCompanyId, "MONTHLY_COMPANY_SOURCE_COMPANY_NOT_FOUND");
    await assertCurrent(); await checkpoint();
    const raw = await readRawCompany(id, byId.get(id));
    need(object(raw) && raw.companyId === id, "KEYWORD_INCREMENTAL_COMPANY_IDENTITY_MISMATCH");
    const company = clone(raw);
    for (const key of ["_integratedCapacity", "manualCorrection"]) if (Object.hasOwn(reference, key)) company[key] = clone(reference[key]);
    counters.companyBodyReads++;
    await assertCurrent();
    return company;
  }
  async function acquire(id, options = {}) {
    await assertCurrent(); await checkpoint(); counters.metadataReads++;
    const selected = options.prepareCapacity === false ? withoutCapacity : metadata;
    const data = { companies: selected.companies, runs: selected.runs, regions: selected.regions, rawCompanies: new Map(selected.rawCompanies) };
    if (id !== null && data.rawCompanies.has(id)) data.rawCompanies.set(id, await readCompany(id));
    Object.defineProperty(data, "_companySource", { enumerable: false,
      value: Object.freeze({ revision, readCompany, assertCurrent }) });
    return data;
  }
  async function read(id, options) { const data = await acquire(id, options); await assertCurrent(); return data; }
  async function consume(id, callback) {
    if (typeof callback !== "function") throw new TypeError("A company-source continuation is required");
    const data = await acquire(id), result = await callback(data);
    // Keep the private validator even if the consumer replaces public fields.
    await assertCurrent(); return result;
  }
  return Object.freeze({ readCatalog: options => read(null, options), readCompanyCatalog: (id, options) => read(String(id), options),
    withCatalog: callback => consume(null, callback), withCompanyCatalog: (id, callback) => consume(String(id), callback),
    stats: () => ({ ...counters, incremental: true, companyCount: metadata.companies.length }) });
}

module.exports = { createIncrementalCatalog };
