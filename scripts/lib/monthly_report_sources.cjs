"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const readline = require("node:readline");
const { monthlyReportKeywordMembership } = require("./monthly_reports.cjs");

const token = value => String(value || "").normalize("NFKC").replace(/\s+/g, "").toLowerCase();
function sourceError() { return Object.assign(new Error("월간 집계에 필요한 저장자료를 읽지 못했습니다. 원본 상태를 확인해 주세요."), { statusCode: 503, code: "MONTHLY_SOURCE_UNAVAILABLE" }); }
async function readJson(file, fallback) {
  try { return JSON.parse((await fsp.readFile(file, "utf8")).replace(/^\uFEFF/, "")); }
  catch (error) { if (error.code === "ENOENT") return fallback; throw sourceError(); }
}

function createMonthlyReportSources({ dataDir, regionMasterFile, listRuns, projectObservation = row => row, capacityForCompany = () => null, readContext = async () => ({ sources: [], networkAttempted: false }) }) {
  const companyFile = path.join(dataDir, "company_master", "companies.json");
  const historyFile = path.join(dataDir, "history", "observations.jsonl");
  async function catalog() {
    const [master, regionMaster, runs] = await Promise.all([readJson(companyFile, { companies: {} }), readJson(regionMasterFile, { units: [] }), listRuns()]);
    if (!master.companies || typeof master.companies !== "object" || Array.isArray(master.companies)) throw sourceError();
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
      const override = company.manualCorrection?.regionOverride;
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
        capacity: capacityForCompany(company), capacitySource: company.manualCorrection ? "DB 검토값 우선 · 저장 관측 기준" : "최대 관측 객실 수" };
    });
    return { companies, rawCompanies, runs, regions: units.map(unit => ({ id: unit.regionKey, label: unit.fullName || unit.name, level: unit.level })) };
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
  async function options() {
    const data = await catalog();
    const months = new Set();
    const addMonth = value => { const month = String(value || "").slice(0, 7); if (/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) months.add(month); };
    await readHistory(row => addMonth(row.stayDate || row.date));
    for (const run of data.runs) { addMonth(run.checkIn); addMonth(run.checkOut); }
    const today = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
    const current = today.slice(0, 7);
    const previous = new Date(Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)) - 2, 1)).toISOString().slice(0, 7);
    months.add(current);
    const available = [...months].sort().reverse();
    return { companies: data.companies.map(company => ({ id: company.companyId, label: `${company.primaryName} · ${company.regionLabel}`, regionKey: company.regionKey })),
      keywords: [...new Set(data.runs.filter(run => run.searchMode !== "company").map(run => run.keyword).filter(Boolean))].sort().map(keyword => ({ id: keyword, label: keyword })),
      regions: data.regions, months: available, defaultMonth: months.has(previous) ? previous : current, today };
  }
  async function loadSources(request) {
    const data = await catalog();
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
    const names = new Map();
    for (const company of data.rawCompanies.values()) {
      for (const prior of company.duplicateNotes || []) if (prior.mergedCompanyId) ids.set(token(prior.mergedCompanyId), company.companyId);
      for (const name of [company.primaryName, ...(company.aliases || [])]) {
        const key = token(name);
        if (!key) continue;
        if (!names.has(key)) names.set(key, company.companyId);
        else if (names.get(key) !== company.companyId) names.set(key, null);
      }
    }
    function canonical(row, allowConflicting = false) {
      const key = token(row.companyKey || row.companyId);
      if (ids.has(key)) return !allowConflicting && conflictingCompanyIds.has(ids.get(key)) ? null : ids.get(key);
      const place = String(row.placeId || row.place_id || key.match(/^cmp_place_(.+)$/)?.[1] || "");
      if (place) return places.get(place) || null;
      if (/^\d+$/.test(key)) return places.get(key) || null;
      if (key.startsWith("cmp_")) return null;
      const byName = names.get(key) || names.get(token(row.companyName)) || null;
      return !allowConflicting && conflictingCompanyIds.has(byName) ? null : byName;
    }
    const observations = new Map();
    const diagnosticInventoryRows = [], unmatchedRows = [];
    function addRow(row, fallback = false) {
      if (!String(row.stayDate || row.date || "").startsWith(request.month + "-")) return;
      const id = canonical(row);
      // Keep rejected identity evidence separate so a relevant duplicate can be
      // diagnosed without adding its quantities to the report.
      const candidateId = id || canonical(row, true) || `unresolved-report-row-${unmatchedRows.length}`;
      diagnosticInventoryRows.push({ ...row, companyId: candidateId, companyKey: candidateId });
      if (!id) { unmatchedRows.push({ row, candidateId }); return; }
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
          diagnosticRankRows.push(row);
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
    const scopeIds = request.type === "keyword"
      ? monthlyReportKeywordMembership(request, { observations: diagnosticInventoryRows, rankObservations: diagnosticRankRows, runs: data.runs }).members
      : new Set(data.companies.filter(company => request.type === "company" ? company.companyId === request.targetId
        : company.regionKey === request.targetId || company.regionKeys.includes(request.targetId)).map(company => company.companyId));
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
    let context;
    try { context = await readContext(request, data); }
    catch (error) {
      if (error.message === "MONTHLY_CONTEXT_MUST_BE_CACHE_ONLY") throw error;
      context = { sources: [], networkAttempted: false, warnings: ["저장된 지역 보조지표를 불러오지 못했습니다."] };
    }
    return { companies: data.companies, regions: data.regions, runs: data.runs, observations: [...observations.values()], rankObservations,
      warnings, sourceDiagnostics: { unmatchedCompanyRows, duplicatePlaceCompanies },
      globalWarnings, globalDiagnostics: { malformedHistoryLines, unmatchedCompanyRows: globalUnmatchedCompanyRows, duplicatePlaceCompanies: globalDuplicatePlaceCompanies,
        ...(request.type === "region" ? { unmappedRegionCompanies } : {}) }, context };
  }
  return { options, loadSources };
}

module.exports = { createMonthlyReportSources };
