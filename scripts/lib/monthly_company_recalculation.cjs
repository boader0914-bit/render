"use strict";

const { createMonthlyReportMaterializedCache } = require("./monthly_report_materialized_cache.cjs");

const READ_ONLY_RUN_OPTIONS = Object.freeze({
  skipCompanyMaster: true,
  skipHistory: true,
  skipTraffic: true,
  skipTourismVisitors: true,
  skipTourismVisitorHistory: true,
  skipTourismDemandStrengthHistory: true,
  skipTourismResourceDemandHistory: true,
  skipTourismDiversityHistory: true,
  applyCompanyMaster: false,
  includeRankComparison: false
});

const quality = run => String(typeof run?.collectionQuality === "string" ? run.collectionQuality : run?.collectionQuality?.status || "unknown").toLowerCase();
const positive = value => Number.isFinite(Number(value)) && Number(value) > 0;
const copy = value => JSON.parse(JSON.stringify(value));
function unavailable() {
  return Object.assign(new Error("월간 객실 보정에 필요한 저장 원문을 읽지 못했습니다."), { code: "MONTHLY_RECALCULATION_UNAVAILABLE", statusCode: 503 });
}
function dayKey(value) {
  const text = String(value || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return "";
  const time = Date.parse(`${text}T00:00:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === text ? text : "";
}
function observedDay(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})$/i.test(value) || !dayKey(value.slice(0, 10))) return "";
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time + 9 * 3600000).toISOString().slice(0, 10) : "";
}
function collectionEndsBeforeMonth(run, monthStart) {
  const start = dayKey(run.checkIn);
  const days = Number(run.bookingRangeDays);
  // checkOut is normally one night even for a 31-day inventory query. Only
  // an explicit, valid collection span can rule a saved run out of this month.
  if (!start || !Object.hasOwn(run, "bookingRangeDays") || !Number.isSafeInteger(days) || days < 1 || days > 366) return false;
  const end = new Date(Date.parse(`${start}T00:00:00Z`) + (days - 1) * 86400000).toISOString().slice(0, 10);
  return end < monthStart;
}
function hasInventoryCorrection(company) {
  const correction = company?.manualCorrection;
  if (!correction || correction.active === false) return false;
  return positive(correction.lodgingBasisTotal) || positive(correction.dayUseBasisTotal)
    || (Array.isArray(correction.roomSegments) && correction.roomSegments.some(row => positive(row?.count ?? row?.roomCount)))
    || (Array.isArray(correction.productStockCorrections) && correction.productStockCorrections.length > 0);
}
function companyRunIds(company) {
  const inventory = company.inventory || {};
  return new Set([
    ...(company.runIds || []), ...(inventory.runIds || []), company.firstRunId, company.lastRunId,
    inventory.latest?.runId, inventory.previousLatest?.runId,
    ...(inventory.snapshots || []).map(row => row?.runId),
    ...Object.values(company.keywords || {}).flatMap(exposure => (exposure.runs || []).map(row => row?.runId))
  ].filter(Boolean).map(String));
}
function inScope(request, company, catalogCompany, runs) {
  // Internal saved-evidence read for industry analysis. Public monthly report
  // request validation continues to accept only company/region/keyword.
  if (request.type === "industry") return true;
  if (request.type === "company") return company.companyId === request.targetId;
  if (request.type === "region") return catalogCompany?.regionKey === request.targetId || (catalogCompany?.regionKeys || []).includes(request.targetId);
  if (request.type === "keyword") {
    const exposures = Object.values(company.keywords || {}).filter(exposure => exposure.keyword === request.targetId);
    return exposures.some(exposure => (exposure.runs || []).some(row => runs.has(String(row.runId))))
      || [...companyRunIds(company)].some(id => runs.get(id)?.keyword === request.targetId);
  }
  return false;
}

function createMonthlyCompanyRecalculation({ loadRun, applyCompanyManualCorrection, companyProductAvailabilityMatch, buildHistoryObservations,
  cacheDirectory = null, cacheVersion = "monthly-company-recalculation-v1", maxCachedRunBytes = 6 * 1024 * 1024 }) {
  if ([loadRun, applyCompanyManualCorrection, companyProductAvailabilityMatch, buildHistoryObservations].some(fn => typeof fn !== "function")) throw new TypeError("Monthly recalculation dependencies are required");
  if (!Number.isSafeInteger(maxCachedRunBytes) || maxCachedRunBytes < 128 || maxCachedRunBytes > 6 * 1024 * 1024) throw new TypeError("Invalid compact run row budget");
  const cache = cacheDirectory ? createMonthlyReportMaterializedCache({ directory: cacheDirectory,
    maxEntries: 256, maxBytes: 64 * 1024 * 1024, maxEntryBytes: 8 * 1024 * 1024 }) : null;
  const metrics = { savedRunLoads: 0, runRowBuilds: 0, runRowCacheHits: 0, companyProjectionsRead: 0, runRowOversizeFallbacks: 0, maximumCachedRunBytes: 0 };
  const oversized = new Set();
  async function loadStored(id, capacityCompanies) {
    metrics.savedRunLoads++;
    let stored;
    try { stored = await loadRun(id, { ...READ_ONLY_RUN_OPTIONS, capacityCompanies }); } catch { throw unavailable(); }
    if (!stored?.run || String(stored.run.id || stored.run.runId || "") !== id || !Array.isArray(stored.availability?.items)) throw unavailable();
    return stored;
  }
  function correctedRows(stored, originalRun, company) {
    if (["blocked", "failed", "interrupted"].includes(quality(stored.run))) return [];
    const id = String(originalRun.id || originalRun.runId || "");
    const run = { ...stored.run, id, collectedAt: originalRun.collectedAt,
      keyword: originalRun.keyword || stored.run.keyword || "", collectionQuality: originalRun.collectionQuality };
    const day = observedDay(run.collectedAt);
    const matches = stored.availability.items.filter(item => companyProductAvailabilityMatch(company, item));
    if (matches.length > 1) throw unavailable();
    if (!matches.length) return [];
    const item = applyCompanyManualCorrection(copy(matches[0]), copy(company));
    if (!(Number(item?.inventoryEvidence?.version) >= 4)) return [];
    const rows = buildHistoryObservations({ run, availability: { items: [{ ...item, companyId: company.companyId }] } }, run.collectedAt);
    if (!Array.isArray(rows)) throw unavailable();
    return rows.filter(row => {
      const stayDate = dayKey(row?.stayDate || row?.date);
      return stayDate && stayDate >= day && Number(row.inventoryEvidenceVersion) >= 4;
    }).map(row => ({ ...row, companyId: company.companyId, companyKey: company.companyId, companyName: company.primaryName,
      runId: id, collectedAt: run.collectedAt, collectedDate: day, keyword: run.keyword, stayDate: dayKey(row.stayDate || row.date), readOnlyRecalculated: true }));
  }
  async function cachedRunRows(id, originalRun, data, capacityCompanies, checkpoint) {
    const owner = data._companySource;
    const scopeKey = JSON.stringify([cacheVersion, owner.revision, id]);
    if (oversized.has(scopeKey)) return null;
    const readRevision = async () => {
      await owner.assertCurrent();
      if (typeof owner.revision !== "string" || !owner.revision) throw unavailable();
      return owner.revision;
    };
    let result;
    try { result = await cache.getOrBuild({ key: JSON.stringify([cacheVersion, id]), readRevision, build: async () => {
      metrics.runRowBuilds++;
      // A run contains several companies. Parse its saved product response only
      // once, publish bounded corrected observation rows, then release it. Never
      // keep a full run or complete company master in a long-lived heap cache.
      const stored = await loadStored(id, capacityCompanies), companies = []; let bytes = 256;
      for (const reference of capacityCompanies) {
        if (!reference?.companyId || reference.deletedAt || reference.mergedIntoCompanyId || !hasInventoryCorrection(reference)
          || !companyRunIds(reference).has(id)) continue;
        await checkpoint();
        const company = await owner.readCompany(reference.companyId); metrics.companyProjectionsRead++;
        if (!company || company.companyId !== reference.companyId) throw unavailable();
        let entry;
        try {
          entry = { companyId: company.companyId, rows: correctedRows(stored, originalRun, company) };
        } catch {
          // An unrelated ambiguous company's saved evidence must not fail a
          // valid target. Its failure is retained and raised only for that target.
          entry = { companyId: reference.companyId, error: true };
        }
        bytes += Buffer.byteLength(JSON.stringify(entry)) + 1;
        if (bytes > maxCachedRunBytes) throw Object.assign(new Error("Compact run row budget exceeded"), { code: "MONTHLY_RUN_ROWS_TOO_LARGE" });
        companies.push(entry);
      }
      metrics.maximumCachedRunBytes = Math.max(metrics.maximumCachedRunBytes, bytes);
      return { runId: id, companies };
    } }); } catch (error) {
      if (error?.code !== "MONTHLY_RUN_ROWS_TOO_LARGE") throw error;
      metrics.runRowOversizeFallbacks++;
      oversized.add(scopeKey); if (oversized.size > 256) oversized.delete(oversized.values().next().value);
      return null; // Release the all-company build before target-only fallback.
    }
    if (result.status !== "calculated") metrics.runRowCacheHits++;
    if (result.value.runId !== id || !Array.isArray(result.value.companies)) throw unavailable();
    return result.value;
  }
  async function recalculateCompanyObservations(request, data, { checkpoint = async () => {} } = {}) {
    const monthStart = dayKey(`${request.month}-01`), cutoff = dayKey(request.cutoffDate);
    if (!monthStart || !cutoff || !(data.rawCompanies instanceof Map)) throw unavailable();
    const nextMonth = new Date(`${monthStart}T00:00:00Z`);
    nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1);
    const monthEnd = new Date(nextMonth.getTime() - 86400000).toISOString().slice(0, 10);
    // This catalog already owns the prepared capacity/correction inputs. Share
    // its company references across saved-run reads instead of making each
    // loadRun parse the complete company master again. Keep the entire catalog:
    // narrowing it to report targets could change other items' capacity bases.
    const capacityCompanies = [...data.rawCompanies.values()];
    const eligibleRuns = new Map((data.runs || []).filter(run => {
      const day = observedDay(run.collectedAt);
      return ["complete", "reused", "partial"].includes(quality(run)) && run.collectedAtSource !== "filesystem"
        && day && day <= cutoff && day <= monthEnd && (!dayKey(run.checkIn) || run.checkIn <= monthEnd)
        && !collectionEndsBeforeMonth(run, monthStart);
    }).map(run => [String(run.id || run.runId || ""), run]));
    const catalogCompanies = new Map((data.companies || []).map(company => [company.companyId, company]));
    const targetsByRun = new Map();
    for (const company of capacityCompanies) {
      await checkpoint();
      if (!company?.companyId || company.deletedAt || company.mergedIntoCompanyId || !hasInventoryCorrection(company)
        || !inScope(request, company, catalogCompanies.get(company.companyId), eligibleRuns)) continue;
      for (const id of companyRunIds(company)) {
        const run = eligibleRuns.get(id);
        if (!run || (request.type === "keyword" && run.keyword !== request.targetId)) continue;
        if (!targetsByRun.has(id)) targetsByRun.set(id, []);
        targetsByRun.get(id).push(company);
      }
    }
    const result = [];
    for (const [id, companies] of targetsByRun) {
      await checkpoint();
      const originalRun = eligibleRuns.get(id);
      const useCache = cache && typeof data._companySource?.assertCurrent === "function"
        && typeof data._companySource?.readCompany === "function" && typeof data._companySource.revision === "string";
      const cached = useCache ? await cachedRunRows(id, originalRun, data, capacityCompanies, checkpoint) : null;
      const stored = cached ? null : await loadStored(id, capacityCompanies);
      for (const company of companies) {
        await checkpoint();
        const entry = cached?.companies.find(value => value.companyId === company.companyId);
        if (cached && (!entry || entry.error || !Array.isArray(entry.rows))) throw unavailable();
        const rows = cached ? entry.rows : correctedRows(stored, originalRun, company);
        for (const row of rows) {
          const stayDate = dayKey(row?.stayDate || row?.date);
          if (stayDate >= monthStart && stayDate <= monthEnd) result.push(row);
        }
      }
    }
    return result;
  }
  recalculateCompanyObservations.stats = () => ({ ...metrics });
  return recalculateCompanyObservations;
}

module.exports = { createMonthlyCompanyRecalculation };
