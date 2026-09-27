"use strict";

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
  if (request.type === "company") return company.companyId === request.targetId;
  if (request.type === "region") return catalogCompany?.regionKey === request.targetId || (catalogCompany?.regionKeys || []).includes(request.targetId);
  if (request.type === "keyword") {
    const exposures = Object.values(company.keywords || {}).filter(exposure => exposure.keyword === request.targetId);
    return exposures.some(exposure => (exposure.runs || []).some(row => runs.has(String(row.runId))))
      || [...companyRunIds(company)].some(id => runs.get(id)?.keyword === request.targetId);
  }
  return false;
}

function createMonthlyCompanyRecalculation({ loadRun, applyCompanyManualCorrection, companyProductAvailabilityMatch, buildHistoryObservations }) {
  if ([loadRun, applyCompanyManualCorrection, companyProductAvailabilityMatch, buildHistoryObservations].some(fn => typeof fn !== "function")) throw new TypeError("Monthly recalculation dependencies are required");
  return async function recalculateCompanyObservations(request, data) {
    const monthStart = dayKey(`${request.month}-01`), cutoff = dayKey(request.cutoffDate);
    if (!monthStart || !cutoff || !(data.rawCompanies instanceof Map)) throw unavailable();
    const nextMonth = new Date(`${monthStart}T00:00:00Z`);
    nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1);
    const monthEnd = new Date(nextMonth.getTime() - 86400000).toISOString().slice(0, 10);
    const eligibleRuns = new Map((data.runs || []).filter(run => {
      const day = observedDay(run.collectedAt);
      return ["complete", "reused", "partial"].includes(quality(run)) && run.collectedAtSource !== "filesystem"
        && day && day <= cutoff && day <= monthEnd && (!dayKey(run.checkIn) || run.checkIn <= monthEnd);
    }).map(run => [String(run.id || run.runId || ""), run]));
    const catalogCompanies = new Map((data.companies || []).map(company => [company.companyId, company]));
    const targetsByRun = new Map();
    for (const company of data.rawCompanies.values()) {
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
      const originalRun = eligibleRuns.get(id);
      let stored;
      try { stored = await loadRun(id, { ...READ_ONLY_RUN_OPTIONS }); } catch { throw unavailable(); }
      if (!stored?.run || String(stored.run.id || stored.run.runId || "") !== id || !Array.isArray(stored.availability?.items)) throw unavailable();
      // A provider failure found in the loaded run cannot be promoted by the
      // correction. Missing legacy metadata is still gated by the run catalog.
      if (["blocked", "failed", "interrupted"].includes(quality(stored.run))) continue;
      const run = { ...stored.run, id, collectedAt: originalRun.collectedAt,
        keyword: originalRun.keyword || stored.run.keyword || "", collectionQuality: originalRun.collectionQuality };
      const day = observedDay(run.collectedAt);
      for (const company of companies) {
        const matches = stored.availability.items.filter(item => companyProductAvailabilityMatch(company, item));
        if (matches.length > 1) throw unavailable();
        // Ranking-only and legacy summaries may not contain reconstructable
        // product evidence. Keep their existing excluded rows unchanged.
        if (!matches.length) continue;
        const item = applyCompanyManualCorrection(copy(matches[0]), copy(company));
        if (!(Number(item?.inventoryEvidence?.version) >= 4)) continue;
        const rows = buildHistoryObservations({ run, availability: { items: [{ ...item, companyId: company.companyId }] } }, run.collectedAt);
        if (!Array.isArray(rows)) throw unavailable();
        for (const row of rows) {
          const stayDate = dayKey(row?.stayDate || row?.date);
          if (!stayDate || stayDate < monthStart || stayDate > monthEnd || stayDate < day || !(Number(row.inventoryEvidenceVersion) >= 4)) continue;
          result.push({ ...row, companyId: company.companyId, companyKey: company.companyId, companyName: company.primaryName,
            runId: id, collectedAt: run.collectedAt, collectedDate: day, keyword: run.keyword, stayDate, readOnlyRecalculated: true });
        }
      }
    }
    return result;
  };
}

module.exports = { createMonthlyCompanyRecalculation };
