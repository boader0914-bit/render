"use strict";

// Login/company-list metadata is a separate read model. It must never acquire
// an analytical lease, enumerate runs, or reconstruct inventory/capacity.
const fs = require("node:fs/promises");
const native = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { StringDecoder } = require("node:string_decoder");
const { readCompanyMasterProjection } = require("./company_master_stream.cjs");

const sha = value => crypto.createHash("sha256").update(value).digest("hex");
const clone = value => JSON.parse(JSON.stringify(value));
const signature = stat => [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].map(String).join(":");
const token = value => String(value || "").normalize("NFKC").replace(/\s+/g, "").toLowerCase();
const positive = value => ["number", "string"].includes(typeof value) && String(value).trim() !== ""
  && Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : null;
const text = (value, limit = 2000) => typeof value === "string" && value.length <= limit
  && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value) ? value.trim() : "";
const object = value => value && typeof value === "object" && !Array.isArray(value);
const VERSION = "insight-public-catalog-v1:" + sha(native.readFileSync(__filename));
function fault(code = "INSIGHT_CATALOG_SOURCE_UNAVAILABLE") {
  return Object.assign(new Error("업체 기본자료를 확인하지 못했습니다. 잠시 후 다시 확인해 주세요."), { code, statusCode: 503 });
}
const need = (value, code = "INSIGHT_CATALOG_SOURCE_INVALID") => { if (!value) throw fault(code); };
const checksum = entry => { const { checksum: _ignored, ...body } = entry; return sha(JSON.stringify(body)); };

// Keep the existing monthly catalog's exact region rules, including an
// invalid explicit override remaining unknown rather than guessing a fallback.
function regionMatcher(regionMaster) {
  need(object(regionMaster) && Array.isArray(regionMaster.units));
  const units = regionMaster.units.filter(unit => unit?.active && unit.selectable && ["local", "broad"].includes(unit.level));
  const keys = new Set(), idIndex = new Map(), aliases = [];
  for (const unit of units) {
    need(text(unit.regionKey, 300) && !keys.has(unit.regionKey) && text(unit.fullName || unit.name));
    keys.add(unit.regionKey);
    for (const id of [unit.regionKey, unit.regionId].filter(Boolean)) {
      const rows = idIndex.get(id) || []; rows.push(unit); idIndex.set(id, rows);
    }
    for (const alias of new Set([unit.fullName, unit.name, ...(Array.isArray(unit.aliases) ? unit.aliases : [])].map(token).filter(Boolean))) aliases.push({ alias, unit });
  }
  const unique = rows => [...new Map(rows.map(unit => [unit.regionKey, unit])).values()];
  function exactRegion(value, address = false) {
    const normalized = token(value); if (!normalized) return null;
    if (idIndex.has(value)) { const rows = unique(idIndex.get(value)); return rows.length === 1 ? rows[0] : null; }
    let rows = aliases.filter(row => address ? normalized.startsWith(row.alias) : normalized === row.alias);
    if (address && rows.length) { const longest = Math.max(...rows.map(row => row.alias.length)); rows = rows.filter(row => row.alias.length === longest); }
    const matches = unique(rows.map(row => row.unit)); return matches.length === 1 ? matches[0] : null;
  }
  return {
    regions: units.map(unit => ({ id: unit.regionKey, label: unit.fullName || unit.name, level: unit.level })),
    resolve(company) {
      if (company.manualCorrection?.active !== false && company.manualCorrection?.regionOverrideInvalid === true) return null;
      const override = company.manualCorrection?.active === false ? null : company.manualCorrection?.regionOverride;
      let region = override ? exactRegion(override) : null;
      if (!override) {
        for (const address of company.addresses) { region = exactRegion(address, true); if (region) break; }
        if (!region) {
          const matches = unique(company.regions.map(value => exactRegion(value)).filter(Boolean));
          if (matches.length === 1) region = matches[0];
          else if (matches.length > 1) {
            const local = matches.filter(item => item.level === "local");
            if (local.length === 1 && matches.every(item => item.regionKey === local[0].regionKey || item.regionKey === local[0].provinceRegionKey)) region = local[0];
          }
        }
      }
      return region;
    }
  };
}

function publicProjection(company, reviewedCapacity) {
  need(object(company));
  if (company.deletedAt || company.mergedIntoCompanyId || !company.companyId) return undefined;
  const id = text(company.companyId, 300); need(id && id === company.companyId && !/[\x00-\x1f\x7f]/.test(id));
  const correction = object(company.manualCorrection) ? company.manualCorrection : {};
  const regionOverride = text(correction.regionOverride, 300);
  const profile = company.adminProfile?.active === true ? company.adminProfile : null;
  // The callback sees the original one-company record only. Its result is
  // copied before the stream discards that record and all of its inventory.
  const reviewed = positive(reviewedCapacity(company));
  return {
    companyId: id, primaryName: text(company.primaryName) || id, reviewed,
    addresses: (Array.isArray(company.addresses) ? company.addresses : []).map(value => text(typeof value === "string" ? value : value?.address)).filter(Boolean),
    placeIds: [...new Set((Array.isArray(company.placeIds) ? company.placeIds : []).map(value => text(String(value ?? ""), 300)).filter(Boolean))],
    regions: (Array.isArray(company.regions) ? company.regions : []).map(value => text(value, 300)).filter(Boolean),
    manualCorrection: { active: correction.active !== false,
      facilityTags: (Array.isArray(correction.facilityTags) ? correction.facilityTags : []).map(value => text(value, 300)).filter(Boolean),
      regionOverride, regionOverrideInvalid: Boolean(correction.regionOverride) && !regionOverride,
      updatedAt: text(correction.updatedAt, 100) || null },
    ...(profile ? { adminProfile: { active: true, primaryName: text(profile.primaryName), address: text(profile.address) } } : {}),
    observedAt: text(company.inventory?.latest?.collectedAt, 100) || null
  };
}

function buildValue(master, regionMaster, capacityStore) {
  const matcher = regionMatcher(regionMaster), companies = [], rawCompanies = [], ids = new Set();
  for (const company of Object.values(master.companies)) {
    const id = company.companyId; need(!ids.has(id)); ids.add(id);
    const saved = capacityStore.companies[id];
    const observed = saved?.source === "observed_locked" ? positive(saved.count) : null;
    const count = company.reviewed || observed;
    const source = company.reviewed ? "db_review" : observed ? "observed_locked" : "unknown";
    const label = company.reviewed ? "관리자 검수값" : observed ? "최대 관측 기준 고정 · 미검수" : "객실 기준 확인 필요";
    const region = matcher.resolve(company);
    companies.push({ companyId: id, primaryName: company.primaryName, placeIds: company.placeIds,
      regionKey: region?.regionKey || "", regionKeys: [...new Set([region?.regionKey, region?.provinceRegionKey].filter(Boolean))],
      regionLabel: region?.fullName || "지역 확인 전", capacity: count, capacitySource: label,
      capacityBasis: { capacity: count, count, source, label, warnings: count ? [] : ["객실 기준 확인 필요"] } });
    rawCompanies.push([id, { addresses: company.addresses, manualCorrection: company.manualCorrection,
      ...(company.adminProfile ? { adminProfile: company.adminProfile } : {}), inventory: { latest: { collectedAt: company.observedAt } } }]);
  }
  return { companies, rawCompanies, regions: matcher.regions, runs: [] };
}
function asCatalog(value) {
  const result = clone(value); result.rawCompanies = new Map(result.rawCompanies); return result;
}
function validValue(value) {
  if (!object(value) || !Array.isArray(value.companies) || !Array.isArray(value.rawCompanies)
    || !Array.isArray(value.regions) || !Array.isArray(value.runs) || value.runs.length !== 0) return false;
  const ids = value.companies.map(row => row?.companyId);
  const idSet = new Set(ids), rawIds = new Set(value.rawCompanies.map(row => row?.[0]));
  return ids.every(id => typeof id === "string" && text(id, 300) === id && id.length > 0)
    && idSet.size === ids.length && rawIds.size === ids.length && value.rawCompanies.length === ids.length
    && value.rawCompanies.every(row => Array.isArray(row) && row.length === 2 && idSet.has(row[0]) && object(row[1]));
}

function createInsightCatalog({ dataDir, regionMasterFile, reviewedCapacity = () => null,
  fileSystem = fs, now = () => new Date(), maxBytes = 8 * 1024 * 1024 } = {}) {
  if (!dataDir || !regionMasterFile || typeof reviewedCapacity !== "function" || !Number.isSafeInteger(maxBytes) || maxBytes < 128) throw new TypeError("Insight public catalog inputs are required");
  const masterFile = path.join(dataDir, "company_master", "companies.json");
  const capacityFile = path.join(dataDir, "company_integrated", "capacity-bases.json");
  const cacheFile = path.join(dataDir, "insight_catalog", "catalog.json");
  const version = sha(VERSION + "\n" + reviewedCapacity.toString());
  let memory = null, inFlight = null, lastStatus = null;
  const metrics = { sourceChecks: 0, projectionReads: 0 };
  async function stamp(file, optional = false) {
    try {
      const stat = await fileSystem.lstat(file, { bigint: true });
      need(stat.isFile() && !stat.isSymbolicLink(), "INSIGHT_CATALOG_SOURCE_UNAVAILABLE");
      return signature(stat);
    } catch (error) { if (optional && error.code === "ENOENT") return "missing"; throw fault(); }
  }
  async function revision() {
    metrics.sourceChecks++;
    return Promise.all([stamp(masterFile), stamp(regionMasterFile), stamp(capacityFile, true)]).then(rows => ({ rows, digest: sha(JSON.stringify(rows)) }));
  }
  async function checkedHandle(file, expected) {
    let handle;
    try {
      handle = await fileSystem.open(file, "r");
      const stat = await handle.stat({ bigint: true });
      need(stat.isFile() && signature(stat) === expected, "INSIGHT_CATALOG_SOURCE_CHANGED");
      return handle;
    } catch (error) { if (handle) await handle.close().catch(() => {}); throw error.code?.startsWith("INSIGHT_CATALOG_") ? error : fault(); }
  }
  async function assertUnchanged(handle, file, expected) {
    const opened = await handle.stat({ bigint: true });
    need(signature(opened) === expected && await stamp(file) === expected, "INSIGHT_CATALOG_SOURCE_CHANGED");
  }
  async function readJson(file, expected, limit) {
    if (expected === "missing") return { schemaVersion: 1, companies: {} };
    const handle = await checkedHandle(file, expected);
    try {
      const stat = await handle.stat({ bigint: true }); need(stat.size <= BigInt(limit));
      const bytes = Buffer.alloc(Number(stat.size) + 1); let length = 0;
      while (length < bytes.length) {
        const read = await handle.read(bytes, length, bytes.length - length, null);
        if (!read.bytesRead) break; length += read.bytesRead;
      }
      await assertUnchanged(handle, file, expected); need(BigInt(length) === stat.size, "INSIGHT_CATALOG_SOURCE_CHANGED");
      try { return JSON.parse(bytes.subarray(0, length).toString("utf8").replace(/^\uFEFF/, "")); } catch { throw fault("INSIGHT_CATALOG_SOURCE_INVALID"); }
    } finally { await handle.close(); }
  }
  async function readMaster(expected) {
    const handle = await checkedHandle(masterFile, expected);
    try {
      metrics.projectionReads++;
      const projected = await readCompanyMasterProjection(masterFile, {
        projectCompany: company => publicProjection(company, reviewedCapacity),
        // Own the descriptor through final validation. ReadStream.destroy()
        // closes even a borrowed descriptor on some Node versions; a bounded
        // async iterator lets the shared parser stop without closing it early.
        stream: () => ({
          async *[Symbol.asyncIterator]() {
            const decoder = new StringDecoder("utf8"), buffer = Buffer.alloc(64 * 1024);
            const size = Number(expected.split(":")[2]); let position = 0;
            while (position < size) {
              const result = await handle.read(buffer, 0, Math.min(buffer.length, size - position), position);
              if (!result.bytesRead) break;
              position += result.bytesRead; const chunk = decoder.write(buffer.subarray(0, result.bytesRead)); if (chunk) yield chunk;
            }
            const tail = decoder.end(); if (tail) yield tail;
          }, destroy() {}
        })
      });
      await assertUnchanged(handle, masterFile, expected); return projected;
    } catch (error) {
      // A mid-read truncate may surface as invalid JSON before the parser can
      // finish. Treat a changed source as retryable, never an old cache hit.
      await assertUnchanged(handle, masterFile, expected); throw error;
    } finally { await handle.close(); }
  }
  async function saved() {
    let handle;
    try {
      const stat = await fileSystem.lstat(cacheFile, { bigint: true });
      need(stat.isFile() && !stat.isSymbolicLink(), "INSIGHT_CATALOG_CACHE_UNAVAILABLE");
      if (stat.size > BigInt(maxBytes)) return null;
      const expected = signature(stat); handle = await checkedHandle(cacheFile, expected);
      const bytes = Buffer.alloc(Number(stat.size) + 1); let length = 0;
      while (length < bytes.length) { const read = await handle.read(bytes, length, bytes.length - length, null); if (!read.bytesRead) break; length += read.bytesRead; }
      need(signature(await handle.stat({ bigint: true })) === expected && signature(await fileSystem.lstat(cacheFile, { bigint: true })) === expected
        && BigInt(length) === stat.size, "INSIGHT_CATALOG_CACHE_UNAVAILABLE");
      let entry; try { entry = JSON.parse(bytes.subarray(0, length).toString("utf8")); } catch { return null; }
      return entry?.schemaVersion === 1 && entry.version === version && validValue(entry.value)
        && entry.checksum === checksum(entry) ? entry : null;
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error.code?.startsWith("INSIGHT_CATALOG_") ? error : fault("INSIGHT_CATALOG_CACHE_UNAVAILABLE");
    } finally { if (handle) await handle.close(); }
  }
  async function save(entry, expected) {
    const bytes = Buffer.from(JSON.stringify(entry)); need(bytes.length <= maxBytes, "INSIGHT_CATALOG_TOO_LARGE");
    await fileSystem.mkdir(path.dirname(cacheFile), { recursive: true });
    const temporary = cacheFile + "." + process.pid + "." + crypto.randomUUID() + ".tmp";
    try {
      await fileSystem.writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
      need((await revision()).digest === expected, "INSIGHT_CATALOG_SOURCE_CHANGED");
      await fileSystem.rename(temporary, cacheFile);
    } finally { await fileSystem.unlink(temporary).catch(() => {}); }
  }
  async function readEntry() {
    for (let attempt = 0; attempt < 2; attempt++) {
      const before = await revision();
      let candidate = memory, storage = "memory";
      if (!candidate) { candidate = await saved(); storage = "saved"; }
      if (candidate?.sourceRevision === before.digest) {
        if ((await revision()).digest !== before.digest) continue;
        memory = candidate; lastStatus = { state: "reused", storage, companyCount: candidate.value.companies.length,
          calculatedAt: candidate.calculatedAt, bytes: Buffer.byteLength(JSON.stringify(candidate)) };
        return candidate;
      }
      try {
        // The streaming callback discards private/full company records. Only
        // three authoritative files are read; no output or history discovery.
        const reads = await Promise.allSettled([
          readMaster(before.rows[0]), readJson(regionMasterFile, before.rows[1], 4 * 1024 * 1024),
          readJson(capacityFile, before.rows[2], 32 * 1024 * 1024)
        ]);
        // All handles/streams finish before a changed-source retry starts.
        const failed = reads.find(row => row.status === "rejected"); if (failed) throw failed.reason;
        const [master, regions, capacities] = reads.map(row => row.value);
        need(object(capacities) && capacities.schemaVersion === 1 && object(capacities.companies));
        const value = buildValue(master, regions, capacities);
        need((await revision()).digest === before.digest, "INSIGHT_CATALOG_SOURCE_CHANGED");
        const entry = { schemaVersion: 1, version, sourceRevision: before.digest, calculatedAt: new Date(now()).toISOString(), value };
        entry.checksum = checksum(entry);
        await save(entry, before.digest);
        // Do not publish even the just-built value if the authority changed
        // during the final replace. A second stable read is allowed, not stale.
        need((await revision()).digest === before.digest, "INSIGHT_CATALOG_SOURCE_CHANGED");
        memory = entry; lastStatus = { state: "calculated", storage: "saved", companyCount: value.companies.length,
          calculatedAt: entry.calculatedAt, bytes: Buffer.byteLength(JSON.stringify(entry)) };
        return entry;
      } catch (error) { if (error.code === "INSIGHT_CATALOG_SOURCE_CHANGED") { memory = null; continue; } throw error; }
    }
    throw fault("INSIGHT_CATALOG_SOURCE_CHANGED");
  }
  async function catalog() {
    if (!inFlight) {
      const task = readEntry().catch(error => {
        memory = null;
        const safe = error.code?.startsWith("INSIGHT_CATALOG_") ? error : fault();
        lastStatus = { state: "unavailable", code: safe.code }; throw safe;
      });
      inFlight = task;
      task.finally(() => { if (inFlight === task) inFlight = null; }).catch(() => {});
    }
    return asCatalog((await inFlight).value);
  }
  return { catalog, prepare: catalog, status: () => ({ ...(lastStatus || { state: "unprepared" }), ...metrics }) };
}

module.exports = { createInsightCatalog };
