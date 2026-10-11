"use strict";

const fs = require("node:fs/promises");
const nativeFs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const readline = require("node:readline");

const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const object = value => value && typeof value === "object" && !Array.isArray(value);
const token = value => String(value || "").normalize("NFKC").replace(/\s+/g, "").toLowerCase();
function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (object(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
const omit = (value, keys) => Object.fromEntries(Object.entries(value || {}).filter(([key]) => !keys.includes(key)));
function day(value) {
  const text = String(value || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return "";
  const stamp = Date.parse(`${text}T00:00:00Z`);
  return Number.isFinite(stamp) && new Date(stamp).toISOString().slice(0, 10) === text ? text : "";
}
function collectedMonth(value) {
  const text = String(value || "");
  if (!day(text.slice(0, 10)) || !/T.+(?:Z|[+-]\d{2}:\d{2})$/i.test(text)) return "";
  const stamp = Date.parse(text);
  return Number.isFinite(stamp) ? new Date(stamp + 9 * 3600000).toISOString().slice(0, 7) : "";
}
function add(map, key, value) {
  if (!map.has(key)) map.set(key, new Set());
  map.get(key).add(value);
}
function identities(row) {
  const keys = new Set();
  for (const id of [row.companyId, row.companyKey]) if (id) keys.add(`company:${token(id)}`);
  const company = token(row.companyId || row.companyKey);
  const place = String(row.placeId || row.place_id || company.match(/^cmp_place_(.+)$/)?.[1] || (/^\d+$/.test(company) ? company : ""));
  if (place) keys.add(`place:${place}`);
  return keys;
}
function buckets() { return { months: new Map(), unknown: new Set(), runMonths: new Map(), companyMonths: new Map(), runRows: new Map() }; }
function addRow(result, label, row, keys = identities(row), month = day(row.stayDate || row.date).slice(0, 7)) {
  const digest = `${label}:${hash(stable(row))}`;
  if (month) {
    add(result.months, month, digest);
    for (const key of keys) add(result.companyMonths, key, month);
    if (row.runId) add(result.runMonths, String(row.runId), month);
  } else if (row.runId) add(result.runRows, String(row.runId), digest);
  else result.unknown.add(digest);
}

// Automatic summaries are separated from identity, address, industry and DB
// review. Unknown fields remain in the semantic projection, conservatively.
const COMPANY_DYNAMIC = ["firstSeenAt", "lastSeenAt", "firstRunId", "lastRunId", "runIds", "updatedAt", "keywords", "inventory",
  "sourceRoles", "collectionSources", "sourceStats", "collectionRouteStats", "latestCollection", "collectionRouteHistory",
  "demandSignals", "naverChannelObservation", "naverChannelObservationHistory", "channelExposures", "channelExposureHistory",
  "adminProfileHistory"];
const KEYWORD_SUMMARIES = ["runs", "firstSeenAt", "lastSeenAt", "bestRank", "latestRank", "latestRunId", "runCount", "keywordLayer",
  "keywordLayerLabel", "searchIntent", "searchRegion", "searchScope", "searchScopeLabel", "detailRankRanges", "provinceKey"];
const SNAPSHOT_QUALITY = ["partial", "missing", "inventoryConflict", "capacityConflict", "collectionFailed", "failed", "error",
  "collectionErrorCode", "errors", "sharedDayUseIncomplete", "unknownUnavailable", "responseStatus", "observationStatus", "status",
  "inventoryObserved", "stockObserved", "scheduleObserved", "queryAttempted"];
const pick = (value, keys) => Object.fromEntries(keys.filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]]));

function companySummary(master) {
  if (!object(master) || !object(master.companies)) throw Object.assign(new Error("Invalid saved company master"), { code: "INDUSTRY_SOURCE_MASTER_INVALID" });
  const result = buckets();
  result.companies = [];
  result.rootToken = hash(stable(omit(master, ["companies", "updatedAt", "sourceIndex"])));
  for (const [recordId, company] of Object.entries(master.companies)) {
    if (!object(company) || !company.companyId
      || !object(company.keywords || {}) || !object(company.inventory || {})
      || [company.placeIds, company.bookingBusinessIds, company.duplicateNotes, company.runIds, company.inventory?.runIds, company.inventory?.snapshots]
        .some(value => value !== undefined && value !== null && !Array.isArray(value))) {
      result.unknown.add(`company:${recordId}:${hash(stable(company))}`); continue;
    }
    const keys = identities({ companyId: company.companyId });
    keys.add(`company:${token(recordId)}`);
    for (const id of company.placeIds || []) if (id) keys.add(`place:${String(id).trim()}`);
    for (const id of company.bookingBusinessIds || []) if (id) keys.add(`booking:${String(id).trim()}`);
    for (const note of company.duplicateNotes || []) if (note?.mergedCompanyId) keys.add(`company:${token(note.mergedCompanyId)}`);
    if (company.mergedIntoCompanyId) keys.add(`company:${token(company.mergedIntoCompanyId)}`);
    const inventory = company.inventory || {};
    const semantic = { ...omit(company, COMPANY_DYNAMIC), inventoryMetadata: omit(inventory, ["latest", "previousLatest", "snapshots", "runIds", "structureCounts", "confidenceCounts"]) };
    const companyKey = new Set([`company:${token(company.companyId)}`]);
    const runs = new Set([...(company.runIds || []), ...(inventory.runIds || []), company.firstRunId, company.lastRunId].filter(Boolean).map(String));
    for (const [keywordKey, exposure] of Object.entries(company.keywords || {})) {
      if (!object(exposure) || (exposure.runs !== undefined && !Array.isArray(exposure.runs))) {
        result.unknown.add(`keyword:${company.companyId}:${keywordKey}:${hash(stable(exposure))}`); continue;
      }
      for (const row of exposure.runs || []) {
        if (!object(row)) { result.unknown.add(`keyword-row:${hash(stable(row))}`); continue; }
        const month = collectedMonth(row.collectedAt) || day(row.collectedDate).slice(0, 7);
        addRow(result, `keyword:${company.companyId}`, { ...row, keyword: exposure.keyword || "", companyId: company.companyId }, companyKey, month);
        if (row.runId) runs.add(String(row.runId));
      }
      const extra = omit(exposure, [...KEYWORD_SUMMARIES, "keyword", "keywordKey"]);
      if (Object.keys(extra).length) semantic.keywordMetadata = { ...(semantic.keywordMetadata || {}), [keywordKey]: extra };
    }
    for (const snapshot of [inventory.latest, inventory.previousLatest, ...(inventory.snapshots || [])].filter(Boolean)) {
      if (!object(snapshot) || (snapshot.productSnapshot?.daily !== undefined && !Array.isArray(snapshot.productSnapshot.daily))) {
        result.unknown.add(`snapshot:${company.companyId}:${hash(stable(snapshot))}`); continue;
      }
      const product = snapshot.productSnapshot || {};
      if (snapshot.runId) runs.add(String(snapshot.runId));
      for (const row of product.daily || []) {
        if (!object(row)) { result.unknown.add(`snapshot-row:${hash(stable(row))}`); continue; }
        const runId = row.runId || snapshot.runId || product.runId;
        if (runId) runs.add(String(runId));
        // Wrapper rollover/previousLatest duplication is normal: fingerprint
        // the effective daily evidence instead of its position in the master.
        addRow(result, `snapshot:${company.companyId}`, { ...row,
          inventoryEvidenceVersion: row.inventoryEvidenceVersion ?? product.inventoryEvidenceVersion ?? snapshot.inventoryEvidenceVersion,
          companyId: company.companyId, runId,
          collectedAt: row.collectedAt || snapshot.collectedAt || product.collectedAt,
          productType: row.productType || "lodging", supply: row.supply ?? row.total,
          snapshotQuality: pick(snapshot, SNAPSHOT_QUALITY), productQuality: pick(product, SNAPSHOT_QUALITY) }, companyKey);
      }
    }
    const firstMonth = collectedMonth(company.firstSeenAt);
    if (firstMonth) add(result.companyMonths, `company:${token(company.companyId)}`, firstMonth);
    result.companies.push({ id: company.companyId, keys, runs, semantic: hash(stable(semantic)) });
  }
  return result;
}

async function historySummary(file) {
  const result = buckets(), hashes = new Map(), unknown = crypto.createHash("sha256");
  let unknownCount = 0;
  const input = readline.createInterface({ input: nativeFs.createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of input) {
    if (!line.trim()) continue;
    let row;
    try { row = JSON.parse(line.replace(/^\uFEFF/, "")); } catch { unknown.update(line).update("\n"); unknownCount++; continue; }
    const month = object(row) ? day(row.stayDate || row.date).slice(0, 7) : "";
    if (!month) { unknown.update(line).update("\n"); unknownCount++; continue; }
    // Preserve duplicate counts without retaining the large observation rows.
    if (!hashes.has(month)) hashes.set(month, crypto.createHash("sha256"));
    hashes.get(month).update(stable(row)).update("\n");
    for (const key of identities(row)) add(result.companyMonths, key, month);
    if (row.runId) add(result.runMonths, String(row.runId), month);
  }
  if (unknownCount) result.unknown.add(`history-unscoped:${unknownCount}:${unknown.digest("hex")}`);
  for (const [month, digest] of hashes) add(result.months, month, `history:${digest.digest("hex")}`);
  return result;
}

function runScope(manifest) {
  const months = new Set();
  let collection = "";
  for (const key of ["completedAt", "finishedAt", "collectedAt", "startedAt", "createdAt"]) {
    if (!Number.isFinite(Date.parse(String(manifest?.[key] || "")))) continue;
    collection = collectedMonth(manifest[key]); break;
  }
  if (collection) months.add(collection);
  const checkIn = day(manifest?.checkIn), range = Number(manifest?.bookingRangeDays);
  const known = object(manifest) && collection && manifest.collectedAtSource !== "filesystem"
    && checkIn && Number.isSafeInteger(range) && range >= 1 && range <= 366;
  if (known) {
    const start = Date.parse(`${checkIn}T00:00:00Z`);
    for (let index = 0; index < range; index++) months.add(new Date(start + index * 86400000).toISOString().slice(0, 7));
  }
  return { months, collection, known: Boolean(known) };
}

function createIndustrySourceRevision({ dataDir, outputsDir, regionMasterFile, tourismRegionMapFile }) {
  const calendarDir = path.join(dataDir, "history", "special_days");
  const singles = [regionMasterFile, tourismRegionMapFile].filter(Boolean);
  const cache = new Map();
  let inFlight = null;
  async function stamp(file) {
    try { const stat = await fs.stat(file, { bigint: true }); return stat.isFile() ? `${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}` : null; }
    catch (error) { if (error.code === "ENOENT") return null; throw error; }
  }
  async function tree(directory, label, depth = 0, runs = false, includeReports = false) {
    let entries;
    try { entries = await fs.readdir(directory, { withFileTypes: true }); }
    catch (error) { if (error.code === "ENOENT") return []; throw error; }
    const rows = [];
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.endsWith(".tmp") || entry.isSymbolicLink()) continue;
      const file = path.join(directory, entry.name), next = `${label}/${entry.name}`;
      if (entry.isDirectory() && depth < (runs ? 2 : 4)
        && (!runs || (depth === 0 ? /_glamping_\d{8}(?:_\d{6})?$/.test(entry.name) : entry.name === "details"))) rows.push(...await tree(file, next, depth + 1, runs, includeReports));
      else if (entry.isFile() && (/\.(?:json|csv)$/i.test(entry.name) || includeReports && /\.md$/i.test(entry.name))) {
        const revision = await stamp(file);
        if (revision) rows.push({ file, label: next, revision });
      }
    }
    return rows;
  }
  async function cached(file, revision, reader) {
    if (!revision) { cache.delete(file); return null; }
    if (cache.get(file)?.revision === revision) return cache.get(file).value;
    const value = await reader(file);
    if (await stamp(file) !== revision) throw Object.assign(new Error("Saved analysis inputs changed while reading"), { code: "INDUSTRY_SOURCE_CHANGED" });
    cache.set(file, { revision, value }); return value;
  }
  const json = file => fs.readFile(file, "utf8").then(text => JSON.parse(text.replace(/^\uFEFF/, "")));
  async function readIndustrySourceRevision() {
    const rows = outputsDir ? await tree(outputsDir, "runs", 0, true) : [];
    rows.push(...await tree(calendarDir, "calendar"));
    for (let index = 0; index < singles.length; index++) {
      const revision = await stamp(singles[index]);
      if (revision) rows.push({ label: `file${index}`, revision });
    }
    return hash(rows.map(row => `${row.label}:${row.revision}`).sort().join("\n"));
  }
  async function periods() {
    const global = new Set(["industry-period-revisions-v1"]), months = new Map(), runMonths = new Map(), companyMonths = new Map();
    function merge(summary) {
      if (!summary) return;
      for (const [month, values] of summary.months) for (const value of values) add(months, month, value);
      for (const value of summary.unknown) global.add(value);
      for (const [id, values] of summary.runMonths) for (const value of values) add(runMonths, id, value);
      for (const [id, values] of summary.companyMonths) for (const value of values) add(companyMonths, id, value);
    }
    const masterFile = path.join(dataDir, "company_master", "companies.json"), historyFile = path.join(dataDir, "history", "observations.jsonl");
    const master = await cached(masterFile, await stamp(masterFile), async file => {
      const text = (await fs.readFile(file, "utf8")).replace(/^\uFEFF/, "");
      try { return companySummary(JSON.parse(text)); }
      catch (error) {
        if (!(error instanceof SyntaxError) && error.code !== "INDUSTRY_SOURCE_MASTER_INVALID") throw error;
        const result = buckets(); result.companies = []; result.rootToken = hash(text);
        result.unknown.add(`unparsed-master:${hash(text)}`); return result;
      }
    });
    const history = await cached(historyFile, await stamp(historyFile), historySummary);
    if (master) global.add(`master-schema:${master.rootToken}`);
    merge(master); merge(history);
    for (let index = 0; index < singles.length; index++) {
      const revision = await stamp(singles[index]);
      const value = await cached(singles[index], revision, async file => {
        const text = (await fs.readFile(file, "utf8")).replace(/^\uFEFF/, "");
        try { return hash(stable(JSON.parse(text))); }
        catch (error) { if (!(error instanceof SyntaxError)) throw error; return `unparsed:${hash(text)}`; }
      });
      global.add(`file${index}:${value || "missing"}`);
    }
    const runs = new Map(), outputRows = outputsDir ? await tree(outputsDir, "runs", 0, true, true) : [];
    for (const row of outputRows) {
      const id = row.label.split("/")[1];
      if (!runs.has(id)) runs.set(id, { rows: [], scope: runScope(null) });
      const run = runs.get(id); run.rows.push(`${row.label}:${row.revision}`);
      if (path.basename(row.file) === "manifest.json" && path.dirname(row.file) === path.join(outputsDir, id)) {
        const manifest = await cached(row.file, row.revision, async file => { try { return await json(file); } catch { return null; } });
        run.scope = runScope(manifest);
      }
    }
    for (const [id, values] of master?.runRows || []) {
      const collection = runs.get(id)?.scope.collection;
      for (const value of values) { if (collection) add(months, collection, value); else global.add(`unscoped:${id}:${value}`); }
    }
    for (const [id, run] of runs) {
      const affected = new Set([...run.scope.months, ...(runMonths.get(id) || [])]);
      run.months = affected;
      const digest = `run:${id}:${hash(run.rows.sort().join("\n"))}`;
      if (!run.scope.known) global.add(digest);
      else for (const month of affected) add(months, month, digest);
    }
    // Exact identities and merged aliases propagate metadata changes to every
    // connected company's reference month, without touching unrelated periods.
    const groups = new Map();
    for (const company of master?.companies || []) {
      const group = { keys: new Set(), companies: new Set(), months: new Set(), unknown: false };
      for (const key of company.keys) {
        const prior = groups.get(key);
        if (prior) {
          for (const item of prior.keys) group.keys.add(item);
          for (const item of prior.companies) group.companies.add(item);
          for (const item of prior.months) group.months.add(item);
          group.unknown ||= prior.unknown;
        }
        group.keys.add(key);
      }
      group.companies.add(`${company.id}:${company.semantic}`);
      for (const key of group.keys) { for (const month of companyMonths.get(key) || []) group.months.add(month); groups.set(key, group); }
      for (const id of company.runs) {
        const run = runs.get(id);
        for (const month of run?.months || runMonths.get(id) || []) group.months.add(month);
        if (run && !run.scope.known || !run && !runMonths.has(id)) group.unknown = true;
      }
    }
    for (const group of new Set(groups.values())) {
      const digest = `companies:${hash([...group.companies].sort().join("\n"))}`;
      if (!group.months.size || group.unknown) global.add(digest);
      else for (const month of group.months) add(months, month, digest);
    }
    for (const row of await tree(calendarDir, "calendar")) {
      const year = path.basename(row.file).match(/^(?:special-days-)?(\d{4})(?:\.json|\.csv)$/)?.[1];
      const digest = `calendar:${row.label}:${row.revision}`;
      if (!year) global.add(digest);
      else {
        for (let month = 1; month <= 12; month++) add(months, `${year}-${String(month).padStart(2, "0")}`, digest);
        add(months, `${Number(year) - 1}-12`, digest);
      }
    }
    const alive = new Set([masterFile, historyFile, ...singles, ...outputRows.map(row => row.file)]);
    for (const file of cache.keys()) if (!alive.has(file)) cache.delete(file);
    return { globalToken: hash([...global].sort().join("\n")), months: Object.fromEntries([...months].sort(([a], [b]) => a.localeCompare(b)).map(([month, values]) => [month, hash([...values].sort().join("\n"))])) };
  }
  readIndustrySourceRevision.periodRevisions = function periodRevisions() {
    if (inFlight) return inFlight;
    const task = (async () => {
      // Atomic file replacement during collection is normal. Retry a changed
      // read before asking the store to keep its prior result and retry later.
      for (let attempt = 0; attempt < 3; attempt++) {
        try { return await periods(); }
        catch (error) { if (error.code !== "INDUSTRY_SOURCE_CHANGED" || attempt === 2) throw error; }
      }
    })(); inFlight = task;
    task.then(() => { if (inFlight === task) inFlight = null; }, () => { if (inFlight === task) inFlight = null; });
    return task;
  };
  return readIndustrySourceRevision;
}

module.exports = { createIndustrySourceRevision };
