"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const readline = require("node:readline");
const { performance } = require("node:perf_hooks");
const { monthlyReportKeywordMembership } = require("./monthly_reports.cjs");
const { createSourceReadScheduler } = require("./source_read_scheduler.cjs");
const { createMonthlyReportMaterializedCache } = require("./monthly_report_materialized_cache.cjs");

const token = value => String(value || "").normalize("NFKC").replace(/\s+/g, "").toLowerCase();
function sourceError() { return Object.assign(new Error("월간 집계에 필요한 저장자료를 읽지 못했습니다. 원본 상태를 확인해 주세요."), { statusCode: 503, code: "MONTHLY_SOURCE_UNAVAILABLE" }); }
async function readJson(file, fallback) {
  try { return JSON.parse((await fsp.readFile(file, "utf8")).replace(/^\uFEFF/, "")); }
  catch (error) { if (error.code === "ENOENT") return fallback; throw sourceError(); }
}

function createMonthlyReportSources({ dataDir, regionMasterFile, listRuns, prepareCompanies = null, projectObservation = row => row, capacityForCompany = () => null, recalculateCompanyObservations = null, readContext = async () => ({ sources: [], networkAttempted: false }), readSpecialDays = async () => null, readRevision = null, readOptionsRevision = null, selectorCacheVersion = "monthly-selector-v1", now = () => new Date() }) {
  const companyFile = path.join(dataDir, "company_master", "companies.json");
  const historyFile = path.join(dataDir, "history", "observations.jsonl");
  let catalogInFlight = null, optionsInFlight = null;
  const sourceReadScheduler = createSourceReadScheduler();
  const selectorCache = typeof readOptionsRevision === "function" ? createMonthlyReportMaterializedCache({
    directory: path.join(dataDir, "monthly_reports", "selector_cache"), maxEntries: 1,
    maxBytes: 8 * 1024 * 1024, maxEntryBytes: 8 * 1024 * 1024
  }) : null;
  async function readCatalog({ prepareCapacity = true } = {}) {
    const [master, regionMaster, runs] = await Promise.all([readJson(companyFile, { companies: {} }), readJson(regionMasterFile, { units: [] }), listRuns()]);
    if (!master.companies || typeof master.companies !== "object" || Array.isArray(master.companies)) throw sourceError();
    if (prepareCapacity && prepareCompanies) master.companies = await prepareCompanies(master.companies, { runs });
    const units = (regionMaster.units || []).filter(unit => unit.active && unit.selectable && ["local", "broad"].includes(unit.level));
    const idIndex = new Map(units.flatMap(unit => [unit.regionKey, unit.regionId].filter(Boolean).map(key => [key, unit])));
    const aliases = units.flatMap(unit => [...new Set([unit.fullName, unit.name, ...(unit.aliases || [])].map(token).filter(Boolean))].map(alias => ({ alias, unit })));
    function exactRegion(value, address = false) {
      const text = token(value);
      if (!text) return null;
      if (idIndex.has(value)) return idIndex.get(value);
      let candidates = aliases.filter(row => address ? text.startsWith(row.alias) : text === row.alias);
      if (address && candidates.length) {
        const length = Math.max(...candidates.map(row => row.alias.length));
        candidates = candidates.filter(row => row.alias.length === length);
      }
      const unique = [...new Map(candidates.map(row => [row.unit.regionKey, row.unit])).values()];
      return unique.length === 1 ? unique[0] : null;
    }
    const rawCompanies = new Map();
    const companies = Object.values(master.companies).filter(company => company && company.companyId && !company.mergedIntoCompanyId && !company.deletedAt).map(company => {
      rawCompanies.set(company.companyId, company);
      const override = company.manualCorrection?.active === false ? null : company.manualCorrection?.regionOverride;
      let region = override ? exactRegion(override) : null;
      if (!override) {
        for (const address of company.addresses || []) { region = exactRegion(typeof address === "string" ? address : address.address, true); if (region) break; }
        if (!region) {
          const matches = [...new Map((company.regions || []).map(value => exactRegion(value)).filter(Boolean).map(item => [item.regionKey, item])).values()];
          if (matches.length === 1) region = matches[0];
          else if (matches.length > 1) {
            const local = matches.filter(item => item.level === "local");
            if (local.length === 1 && matches.every(item => item.regionKey === local[0].regionKey || item.regionKey === local[0].provinceRegionKey)) region = local[0];
          }
        }
      }
      return { companyId: company.companyId, primaryName: company.primaryName || company.companyId,
        regionKey: region?.regionKey || "", regionKeys: [...new Set([region?.regionKey, region?.provinceRegionKey].filter(Boolean))],
        regionLabel: region?.fullName || "지역 확인 전", keywords: Object.values(company.keywords || {}).map(item => item.keyword).filter(Boolean),
        placeIds: [...new Set((company.placeIds || []).map(value => String(value).trim()).filter(Boolean))],
        capacity: prepareCapacity ? capacityForCompany(company) : null, capacityBasis: prepareCapacity ? company._integratedCapacity || null : null,
        capacitySource: company._integratedCapacity?.label || (company.manualCorrection ? "DB 검토값 우선 · 저장 관측 기준" : "최대 관측 객실 수") };
    });
    return { companies, rawCompanies, runs, regions: units.map(unit => ({ id: unit.regionKey, label: unit.fullName || unit.name, level: unit.level })) };
  }
  async function catalog(options = {}) {
    if (catalogInFlight) return catalogInFlight;
    // A public metadata lookup reconstructs the same complete master as a
    // source read. Admit it through the shared scheduler too. Internal readers
    // use readCatalog directly while they already own the scheduler slot.
    const task = sourceReadScheduler.run(() => readCatalog(), options);
    catalogInFlight = task;
    try { return await task; }
    finally { if (catalogInFlight === task) catalogInFlight = null; }
  }
  async function readHistory(consume) {
    try { await fsp.access(historyFile); } catch (error) { if (error.code === "ENOENT") return 0; throw sourceError(); }
    let malformed = 0;
    try {
      const input = readline.createInterface({ input: fs.createReadStream(historyFile, { encoding: "utf8" }), crlfDelay: Infinity });
      for await (const line of input) {
        if (!line.trim()) continue;
        let row;
        try { row = JSON.parse(line.replace(/^\uFEFF/, "")); } catch { malformed++; continue; }
        if (row && typeof row === "object" && !Array.isArray(row)) consume(row);
        else malformed++;
      }
    } catch { throw sourceError(); }
    return malformed;
  }
  async function optionCatalog() {
    // Selectors do not need capacity preparation, a second history pass or a
    // cloned full inventory. Only cold builds enter the shared raw-read queue.
    const data = await readCatalog({ prepareCapacity: false });
    // Only these compact selector fields may survive the history scan below.
    // Do not retain a complete rawCompanies inventory merely to list months.
    return {
      companies: data.companies.map(company => ({ id: company.companyId, label: `${company.primaryName} · ${company.regionLabel}`, regionKey: company.regionKey })),
      keywords: [...new Set(data.runs.filter(run => run.searchMode !== "company").map(run => run.keyword).filter(Boolean))].sort().map(keyword => ({ id: keyword, label: keyword })),
      regions: data.regions,
      runMonths: data.runs.flatMap(run => [run.checkIn, run.checkOut]).map(value => String(value || "").slice(0, 7))
    };
  }
  async function readOptionData() {
    const data = await optionCatalog();
    const months = new Set();
    const addMonth = value => { const month = String(value || "").slice(0, 7); if (/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) months.add(month); };
    await readHistory(row => addMonth(row.stayDate || row.date));
    for (const month of data.runMonths) addMonth(month);
    return { companies: data.companies, keywords: data.keywords, regions: data.regions, observedMonths: [...months].sort().reverse() };
  }
  function datedOptions(data, selectorMetadata = null) {
    // Today and the synthetic current month are response fields, not saved
    // evidence. A restart-free KST day/month rollover must update them too.
    const today = new Date(new Date(now()).getTime() + 9 * 3600000).toISOString().slice(0, 10);
    const current = today.slice(0, 7);
    const previous = new Date(Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)) - 2, 1)).toISOString().slice(0, 7);
    const months = new Set([...data.observedMonths, current]);
    const available = [...months].sort().reverse();
    return { companies: data.companies, keywords: data.keywords,
      regions: data.regions, months: available, defaultMonth: months.has(previous) ? previous : current, today,
      ...(selectorMetadata ? { selectorCache: selectorMetadata } : {}) };
  }
  async function options(scheduling = {}) {
    if (selectorCache) {
      const started = performance.now();
      // Reuse bypasses the expensive source queue. Cache misses still serialize
      // with raw readers, and the persistent cache validates before/after reads
      // and builds, so concurrent source edits never publish a stale list.
      const result = await selectorCache.getOrBuild({ key: String(selectorCacheVersion),
        readRevision: readOptionsRevision, build: () => sourceReadScheduler.run(readOptionData, scheduling) });
      return datedOptions(result.value, { status: result.status, storage: result.storage,
        calculatedAt: result.calculatedAt, checkedAt: new Date(now()).toISOString(),
        timings: { ...result.timings, totalMs: performance.now() - started } });
    }
    if (optionsInFlight) return optionsInFlight;
    // Coalesce simultaneous selector requests without retaining a stale result
    // or placing a second raw master beside an active source reconstruction.
    const task = sourceReadScheduler.run(async () => datedOptions(await readOptionData()), scheduling);
    optionsInFlight = task;
    try { return await task; }
    finally { if (optionsInFlight === task) optionsInFlight = null; }
  }
  async function readSources(request, includeCatalog, { includeContext = true } = {}) {
    const data = await readCatalog();
    const byId = new Map(data.companies.map(company => [company.companyId, company]));
    const ids = new Map(data.companies.map(company => [token(company.companyId), company.companyId]));
    const places = new Map(), conflictingCompanyIds = new Set();
    for (const company of data.companies) {
      for (const place of company.placeIds) {
        if (!places.has(place)) places.set(place, company.companyId);
        else if (places.get(place) !== company.companyId) {
          if (places.get(place)) conflictingCompanyIds.add(places.get(place));
          conflictingCompanyIds.add(company.companyId); places.set(place, null);
        }
      }
    }
    for (const company of data.rawCompanies.values()) {
      for (const prior of company.duplicateNotes || []) if (prior.mergedCompanyId) ids.set(token(prior.mergedCompanyId), company.companyId);
    }
    function canonical(row, allowConflicting = false) {
      const key = token(row.companyKey || row.companyId);
      if (ids.has(key)) return !allowConflicting && conflictingCompanyIds.has(ids.get(key)) ? null : ids.get(key);
      const place = String(row.placeId || row.place_id || key.match(/^cmp_place_(.+)$/)?.[1] || "");
      if (place) return places.get(place) || null;
      if (/^\d+$/.test(key)) return places.get(key) || null;
      if (key.startsWith("cmp_")) return null;
      // Names are display fields, not identity. A matching name alone cannot
      // safely merge an old row into a reviewed company's historical totals.
      return null;
    }
    const observations = new Map();
    const diagnosticInventoryRows = [], unmatchedRows = [];
    // Only keyword membership needs discarded full rows. Company/region/
    // industry sources need identity counts, so do not retain replaced raw
    // history payloads throughout saved-evidence recalculation.
    const needsMembershipEvidence = request.type === "keyword";
    function addRow(row, fallback = false) {
      if (!String(row.stayDate || row.date || "").startsWith(request.month + "-")) return;
      const id = canonical(row);
      // Keep rejected identity evidence separate so a relevant duplicate can be
      // diagnosed without adding its quantities to the report.
      const candidateId = id || canonical(row, true) || `unresolved-report-row-${unmatchedRows.length}`;
      if (needsMembershipEvidence) diagnosticInventoryRows.push({ ...row, companyId: candidateId, companyKey: candidateId });
      if (!id) { unmatchedRows.push({ candidateId }); return; }
      const company = byId.get(id);
      const original = data.rawCompanies.get(id);
      const normalized = projectObservation({ ...row, companyKey: id }, original);
      const key = `${id}|${row.runId || ""}|${row.productType}|${row.stayDate || row.date}`;
      if (fallback && observations.has(key)) return;
      observations.set(key, { ...normalized, companyKey: id, companyId: id, companyName: company.primaryName,
        regionKey: company.regionKey, regionKeys: company.regionKeys, stayDate: row.stayDate || row.date });
    }
    const malformedHistoryLines = await readHistory(row => addRow(row));
    const rankObservations = [], diagnosticRankRows = [];
    for (const [id, company] of data.rawCompanies) {
      for (const exposure of Object.values(company.keywords || {})) {
        for (const run of exposure.runs || []) {
          const row = { ...run, companyKey: id, companyId: id, companyName: company.primaryName, keyword: exposure.keyword };
          if (needsMembershipEvidence) diagnosticRankRows.push(row);
          if (!conflictingCompanyIds.has(id)) rankObservations.push(row);
        }
      }
      // Some recovered runs have only a persisted company snapshot. Their run
      // quality is still independently validated by the report aggregation.
      for (const snapshot of [company.inventory?.latest, company.inventory?.previousLatest, ...(company.inventory?.snapshots || [])].filter(Boolean)) {
        for (const row of snapshot.productSnapshot?.daily || []) addRow({ ...row,
          inventoryEvidenceVersion: row.inventoryEvidenceVersion ?? snapshot.productSnapshot.inventoryEvidenceVersion ?? snapshot.inventoryEvidenceVersion,
          companyKey: id, companyName: company.primaryName, runId: row.runId || snapshot.runId || snapshot.productSnapshot.runId,
          collectedAt: row.collectedAt || snapshot.collectedAt || snapshot.productSnapshot.collectedAt,
          productType: row.productType || "lodging", supply: row.supply ?? row.total }, true);
      }
    }
    // This optional hook must only read saved collection evidence: never collect
    // again or refresh an external API. Current calculations replace the same
    // company/run/product/date row, while report quality and time gates remain.
    if (recalculateCompanyObservations !== null) {
      try {
        const recalculated = await recalculateCompanyObservations(request, data);
        if (!Array.isArray(recalculated) || recalculated.some(row => !row || typeof row !== "object" || Array.isArray(row))) throw sourceError();
        for (const row of recalculated) addRow(row);
      } catch { throw sourceError(); }
    }
    const scopeIds = request.type === "keyword"
      ? monthlyReportKeywordMembership(request, { observations: diagnosticInventoryRows, rankObservations: diagnosticRankRows, runs: data.runs }).members
      : new Set(data.companies.filter(company => request.type === "industry" || (request.type === "company" ? company.companyId === request.targetId
        : company.regionKey === request.targetId || company.regionKeys.includes(request.targetId))).map(company => company.companyId));
    const unmatchedCompanyRows = unmatchedRows.filter(({ candidateId }) => scopeIds.has(candidateId)).length;
    const duplicatePlaceCompanies = [...conflictingCompanyIds].filter(id => scopeIds.has(id)).length;
    const warnings = [], globalWarnings = [];
    if (unmatchedCompanyRows) warnings.push(`리포트 대상에서 업체 고유번호를 확정하지 못한 관측 ${unmatchedCompanyRows}건을 제외했습니다.`);
    if (duplicatePlaceCompanies) warnings.push(`리포트 대상 중 플레이스 번호가 중복 연결된 업체 DB ${duplicatePlaceCompanies}개는 합산에서 제외했습니다. DB 중복 검토가 필요합니다.`);
    const globalUnmatchedCompanyRows = unmatchedRows.length - unmatchedCompanyRows;
    const globalDuplicatePlaceCompanies = conflictingCompanyIds.size - duplicatePlaceCompanies;
    const unmappedRegionCompanies = data.companies.filter(company => !company.regionKey).length;
    if (malformedHistoryLines) globalWarnings.push(`전체 DB 참고: 읽을 수 없는 수집 이력 ${malformedHistoryLines}줄은 대상 범위를 확인할 수 없어 이 리포트의 품질 평가와 분리했습니다.`);
    if (globalUnmatchedCompanyRows) globalWarnings.push(`전체 DB 참고: 대상 밖이거나 관련성을 확정할 수 없는 업체 미식별 관측 ${globalUnmatchedCompanyRows}건이 있습니다.`);
    if (globalDuplicatePlaceCompanies) globalWarnings.push(`전체 DB 참고: 이 리포트 대상 밖에 플레이스 번호가 중복 연결된 업체 ${globalDuplicatePlaceCompanies}개가 있습니다.`);
    if (request.type === "region" && unmappedRegionCompanies) globalWarnings.push(`전체 DB 참고: 소재지가 미확정인 업체 ${unmappedRegionCompanies}개는 선택 지역에 포함되는지 알 수 없어 이 리포트의 품질 평가와 분리했습니다.`);
    let context = null;
    if (includeContext) {
      try { context = await readContext(request, { ...data, companies: data.companies.filter(company => scopeIds.has(company.companyId) && !conflictingCompanyIds.has(company.companyId)) }); }
      catch (error) {
        if (error.message === "MONTHLY_CONTEXT_MUST_BE_CACHE_ONLY") throw error;
        context = { sources: [], networkAttempted: false, warnings: ["저장된 지역 보조지표를 불러오지 못했습니다."] };
      }
    }
    const year = Number(request.month.slice(0, 4));
    const holidayYears = [...new Set([year, request.month.endsWith("-12") ? year + 1 : year])];
    const specialDays = { years: [] };
    for (const holidayYear of holidayYears) {
      try {
        const result = await readSpecialDays(holidayYear);
        if (result?.networkAttempted) throw new Error("MONTHLY_CONTEXT_MUST_BE_CACHE_ONLY");
        const holidays = result?.categories?.holidays;
        specialDays.years.push({ year: holidayYear, status: holidays?.status === "ready" ? "ready" : "missing",
          updatedAt: holidays?.updatedAt || result?.updatedAt || "", source: result?.source || null,
          holidays: holidays?.status === "ready" ? (holidays.items || []).filter(item => item.isHoliday).map(item => ({ date: item.date, name: item.name })) : [] });
      } catch (error) {
        if (error.message === "MONTHLY_CONTEXT_MUST_BE_CACHE_ONLY") throw error;
        specialDays.years.push({ year: holidayYear, status: "missing", updatedAt: "", holidays: [] });
      }
    }
    const source = { companies: data.companies, regions: data.regions, runs: data.runs, observations: [...observations.values()], rankObservations, specialDays,
      warnings, sourceDiagnostics: { unmatchedCompanyRows, duplicatePlaceCompanies },
      globalWarnings, globalDiagnostics: { malformedHistoryLines, unmatchedCompanyRows: globalUnmatchedCompanyRows, duplicatePlaceCompanies: globalDuplicatePlaceCompanies,
        ...(request.type === "region" ? { unmappedRegionCompanies } : {}) }, context };
    return includeCatalog ? { source, catalog: data } : source;
  }
  function queueSourceRead(request, includeCatalog = false, options = {}) {
    // All consumers (including background company materialization) share this
    // queue. Separate UI/service queues cannot protect the shared heap alone.
    return sourceReadScheduler.run(() => readSources(request, includeCatalog, options), options);
  }
  return { options, loadSources: (request, options) => queueSourceRead(request, false, options), catalog,
    loadSourcesWithCatalog: (request, options) => queueSourceRead(request, true, options),
    ...(typeof readRevision === "function" ? { readRevision } : {}), sourceReadStatus: sourceReadScheduler.status };
}

module.exports = { createMonthlyReportSources };
