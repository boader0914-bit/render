"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const readline = require("node:readline");
const { performance } = require("node:perf_hooks");
const { monthlyReportKeywordMembership } = require("./monthly_reports.cjs");
const { industryCompanyReference } = require("./industry_analysis.cjs");
const { createSourceReadScheduler } = require("./source_read_scheduler.cjs");
const { createMonthlyReportMaterializedCache } = require("./monthly_report_materialized_cache.cjs");
const { readCompanyMasterProjection } = require("./company_master_stream.cjs");
const { createMonthlyCompanySourceCatalog } = require("./monthly_company_source_catalog.cjs");
const { assertCooperativeWorkActive, runNonInterruptibleCooperativeWork, setCooperativeWorkPhase } = require("./cooperative_work_checkpoint.cjs");

const token = value => String(value || "").normalize("NFKC").replace(/\s+/g, "").toLowerCase();
function sourceError() { return Object.assign(new Error("월간 집계에 필요한 저장자료를 읽지 못했습니다. 원본 상태를 확인해 주세요."), { statusCode: 503, code: "MONTHLY_SOURCE_UNAVAILABLE" }); }
async function readJson(file, fallback, checkpoint = async () => {}) {
  try {
    const text = await fsp.readFile(file, "utf8");
    await checkpoint();
    return JSON.parse(text.replace(/^\uFEFF/, ""));
  }
  catch (error) { if (error.code === "ENOENT") return fallback; throw sourceError(); }
}

function createMonthlyReportSources({ dataDir, regionMasterFile, listRuns, observationIndex = null, prepareCompanies = null, projectCapacityCompany = null, companySourceVersion = "monthly-company-source-v1", useSourceReadValidationBoundary = false, shareFrozenCatalogMetadata = false, projectObservation = row => row, capacityForCompany = () => null, recalculateCompanyObservations = null, readSavedProductRecoveries = null, publishProductCapacityEvidence = null, readContext = async () => ({ sources: [], networkAttempted: false }), readSpecialDays = async () => null, readRevision = null, readOptionsRevision = null, selectorCacheVersion = "monthly-selector-v1", now = () => new Date(), runWork = operation => operation() }) {
  if (typeof useSourceReadValidationBoundary !== "boolean") throw new TypeError("Source-read validation opt-in must be boolean");
  if (typeof shareFrozenCatalogMetadata !== "boolean") throw new TypeError("Frozen catalog sharing opt-in must be boolean");
  if (readSavedProductRecoveries !== null && typeof readSavedProductRecoveries !== "function") throw new TypeError("Saved recovery reader must be a function");
  const companyFile = path.join(dataDir, "company_master", "companies.json");
  const historyFile = path.join(dataDir, "history", "observations.jsonl");
  let catalogInFlight = null, targetCatalogInFlight = null, optionsInFlight = null;
  const sourceMetrics = { catalogFullReads: 0, catalogFullBytes: 0, capacityPreparations: 0, sourceReads: 0, companyProjectionReads: 0,
    preparedCatalogReads: 0, preparedCatalogReadsByScope: { company: 0, region: 0, keyword: 0, industry: 0, other: 0 } };
  const sourceReadScheduler = createSourceReadScheduler();
  const selectorCache = typeof readOptionsRevision === "function" ? createMonthlyReportMaterializedCache({
    directory: path.join(dataDir, "monthly_reports", "selector_cache"), maxEntries: 1,
    maxBytes: 8 * 1024 * 1024, maxEntryBytes: 8 * 1024 * 1024
  }) : null;
  const checkpointFor = ({ priority } = {}) => priority === "background"
    ? () => sourceReadScheduler.checkpoint({ priority: "background" }) : async () => {};
  const companySourceCatalog = typeof readRevision === "function" && typeof projectCapacityCompany === "function"
    ? createMonthlyCompanySourceCatalog({ dataDir, readRevision, projectCapacityCompany, useSourceReadValidationBoundary, shareFrozenCatalogMetadata,
      version: require("node:crypto").createHash("sha256").update(String(companySourceVersion)).update(fs.readFileSync(__filename)).digest("hex"),
      loadFullCatalog: options => readCatalog({ checkpoint: options?.checkpoint }) }) : null;
  async function readCatalog({ prepareCapacity = true, checkpoint = async () => {} } = {}) {
    await checkpoint();
    // Validate the complete document, retaining one parsed company at a time.
    // A full UTF-8 master string must not coexist with its parsed inventories.
    let master;
    try { await fsp.access(companyFile); const size = (await fsp.stat(companyFile)).size;
      sourceMetrics.catalogFullReads++; sourceMetrics.catalogFullBytes += size;
      master = await readCompanyMasterProjection(companyFile, { checkpoint }); }
    catch (error) { if (error.code === "ENOENT") master = { companies: {} }; else throw sourceError(); }
    const [regionMaster, runs] = await Promise.all([readJson(regionMasterFile, { units: [] }, checkpoint), listRuns()]);
    if (!master.companies || typeof master.companies !== "object" || Array.isArray(master.companies)) throw sourceError();
    await checkpoint();
    if (prepareCapacity && prepareCompanies) { sourceMetrics.capacityPreparations++; master.companies = await prepareCompanies(master.companies, { runs, checkpoint, shareReadOnlyInventory: true }); }
    const units = (regionMaster.units || []).filter(unit => unit.active && unit.selectable && ["local", "broad"].includes(unit.level));
    const industryRegions = units.map(unit => ({ id: unit.regionKey, label: unit.fullName || unit.name, level: unit.level, aliases: unit.aliases }));
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
    const companies = []; let companyIndex = 0;
    for (const company of Object.values(master.companies)) {
      if (!company || !company.companyId || company.mergedIntoCompanyId || company.deletedAt) continue;
      if (companyIndex++ % 16 === 0) await checkpoint();
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
      companies.push({ companyId: company.companyId, primaryName: company.primaryName || company.companyId,
        ...industryCompanyReference(company, industryRegions),
        regionKey: region?.regionKey || "", regionKeys: [...new Set([region?.regionKey, region?.provinceRegionKey].filter(Boolean))],
        regionLabel: region?.fullName || "지역 확인 전", keywords: Object.values(company.keywords || {}).map(item => item.keyword).filter(Boolean),
        placeIds: [...new Set((company.placeIds || []).map(value => String(value).trim()).filter(Boolean))],
        capacity: prepareCapacity ? capacityForCompany(company) : null, capacityBasis: prepareCapacity ? company._integratedCapacity || null : null,
        capacitySource: company._integratedCapacity?.label || (company.manualCorrection ? "DB 검토값 우선 · 저장 관측 기준" : "최대 관측 객실 수") });
    }
    return { companies, rawCompanies, runs, regions: units.map(unit => ({ id: unit.regionKey, label: unit.fullName || unit.name, level: unit.level })) };
  }
  async function catalog(options = {}) { return runWork(() => catalogOwned(options), { ...options, kind: "source-catalog" }); }
  async function catalogOwned(options = {}) {
    if (catalogInFlight) return catalogInFlight;
    // A public metadata lookup reconstructs the same complete master as a
    // source read. Admit it through the shared scheduler too. Internal readers
    // use readCatalog directly while they already own the scheduler slot.
    const task = sourceReadScheduler.run(() => readCatalog({ checkpoint: checkpointFor(options) }), options);
    catalogInFlight = task;
    try { return await task; }
    finally { if (catalogInFlight === task) catalogInFlight = null; }
  }
  async function targetCatalog(options = {}) { return runWork(() => targetCatalogOwned(options), { ...options, kind: "source-targets" }); }
  async function targetCatalogOwned(options = {}) {
    if (targetCatalogInFlight) return targetCatalogInFlight;
    // Month discovery needs identities, saved dates and run spans, never a
    // capacity rebuild. Keep this flight distinct from full analytical reads
    // while admitting both through the same memory/foreground scheduler.
    const task = sourceReadScheduler.run(() => readCatalog({ prepareCapacity: false, checkpoint: checkpointFor(options) }), options);
    targetCatalogInFlight = task;
    try { return await task; }
    finally { if (targetCatalogInFlight === task) targetCatalogInFlight = null; }
  }
  async function readHistory(consume, checkpoint = async () => {}) {
    try { await fsp.access(historyFile); } catch (error) { if (error.code === "ENOENT") return 0; throw sourceError(); }
    let malformed = 0;
    try {
      const stream = fs.createReadStream(historyFile, { encoding: "utf8" });
      const input = readline.createInterface({ input: stream, crlfDelay: Infinity });
      let lines = 0;
      try {
      for await (const line of input) {
        if (lines++ % 256 === 0) await checkpoint();
        if (!line.trim()) continue;
        let row;
        try { row = JSON.parse(line.replace(/^\uFEFF/, "")); } catch { malformed++; continue; }
        if (row && typeof row === "object" && !Array.isArray(row)) consume(row);
        else malformed++;
      }
      } finally { input.close(); stream.destroy(); }
    } catch { throw sourceError(); }
    return malformed;
  }
  async function optionCatalog(checkpoint) {
    // Selectors do not need capacity preparation, a second history pass or a
    // cloned full inventory. Only cold builds enter the shared raw-read queue.
    const data = await readCatalog({ prepareCapacity: false, checkpoint });
    // Only these compact selector fields may survive the history scan below.
    // Do not retain a complete rawCompanies inventory merely to list months.
    return {
      companies: data.companies.map(company => ({ id: company.companyId, label: `${company.primaryName} · ${company.regionLabel}`, regionKey: company.regionKey })),
      keywords: [...new Set(data.runs.filter(run => run.searchMode !== "company").map(run => run.keyword).filter(Boolean))].sort().map(keyword => ({ id: keyword, label: keyword })),
      regions: data.regions,
      runMonths: data.runs.flatMap(run => [run.checkIn, run.checkOut]).map(value => String(value || "").slice(0, 7))
    };
  }
  async function readOptionData(scheduling = {}) {
    const checkpoint = checkpointFor(scheduling);
    const data = await optionCatalog(checkpoint);
    const months = new Set();
    const addMonth = value => { const month = String(value || "").slice(0, 7); if (/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) months.add(month); };
    if (observationIndex) {
      for (const month of await observationIndex.listMonths()) addMonth(month);
    } else await readHistory(row => addMonth(row.stayDate || row.date), checkpoint);
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
  async function readOptions(scheduling = {}) {
    if (selectorCache) {
      const started = performance.now();
      // Reuse bypasses the expensive source queue. Cache misses still serialize
      // with raw readers, and the persistent cache validates before/after reads
      // and builds, so concurrent source edits never publish a stale list.
      const result = await selectorCache.getOrBuild({ key: String(selectorCacheVersion),
        readRevision: readOptionsRevision, build: () => runWork(() => sourceReadScheduler.run(() => readOptionData(scheduling), scheduling), { ...scheduling, kind: "source-options" }) });
      return datedOptions(result.value, { status: result.status, storage: result.storage,
        calculatedAt: result.calculatedAt, checkedAt: new Date(now()).toISOString(),
        timings: { ...result.timings, totalMs: performance.now() - started } });
    }
    if (optionsInFlight) return optionsInFlight;
    // Coalesce simultaneous selector requests without retaining a stale result
    // or placing a second raw master beside an active source reconstruction.
    const task = runWork(() => sourceReadScheduler.run(async () => datedOptions(await readOptionData(scheduling)), scheduling), { ...scheduling, kind: "source-options" });
    optionsInFlight = task;
    try { return await task; }
    finally { if (optionsInFlight === task) optionsInFlight = null; }
  }
  const options = readOptions;
  async function readSourceData(request, includeCatalog, options, data, assertAtReturn = true) {
    const { includeContext = true } = options, checkpoint = checkpointFor(options);
    setCooperativeWorkPhase(20);
    // This capability is private to one serial source read, not a timed or
    // global freshness cache. The final fresh assert (here or in the owning
    // catalog continuation) remains mandatory after a cache hit, fallback,
    // no-target read or recovered context error.
    let sourceReadActive = true;
    const sourceReadValidationBoundary = useSourceReadValidationBoundary && data._companySource
      ? Object.freeze({ owner: data._companySource, revision: data._companySource.revision, isActive: () => sourceReadActive }) : null;
    try {
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
    const companyScope = request.type === "company" ? String(request.targetId) : null;
    function addRow(row, fallback = false, recordDiagnostics = true) {
      if (!String(row.stayDate || row.date || "").startsWith(request.month + "-")) return;
      const id = canonical(row);
      // Keep rejected identity evidence separate so a relevant duplicate can be
      // diagnosed without adding its quantities to the report.
      const candidateId = id || canonical(row, true) || `unresolved-report-row-${unmatchedRows.length}`;
      if (needsMembershipEvidence) diagnosticInventoryRows.push({ ...row, companyId: candidateId, companyKey: candidateId });
      if (!id) { if (recordDiagnostics) unmatchedRows.push({ candidateId }); return; }
      // Identity conflicts and global diagnostics are counted above. Retain
      // quantities only for the requested company, before correction/cloning.
      if (companyScope !== null && id !== companyScope) return;
      const company = byId.get(id);
      const original = data.rawCompanies.get(id);
      const normalized = projectObservation({ ...row, companyKey: id }, original);
      const key = `${id}|${row.runId || ""}|${row.productType}|${row.stayDate || row.date}`;
      if (fallback && observations.has(key)) return;
      observations.set(key, { ...normalized, companyKey: id, companyId: id, companyName: company.primaryName,
        regionKey: company.regionKey, regionKeys: company.regionKeys, stayDate: row.stayDate || row.date });
    }
    let malformedHistoryLines;
    if (!observationIndex) malformedHistoryLines = await readHistory(row => addRow(row), checkpoint);
    else {
      try {
        // Raw identities are indexed, not permanently canonicalized. A reviewed
        // merge or place conflict still uses the current master above. Retain
        // global diagnostics without decoding unrelated companies' payloads.
        const before = await observationIndex.ensure();
        if (companyScope !== null) {
          if (typeof observationIndex.revisionPartitions === "function") {
            const diagnostics = await observationIndex.revisionPartitions();
            if (!Array.isArray(diagnostics.partitions)) throw sourceError();
            for (const part of diagnostics.partitions) {
              if (part.month !== request.month) continue;
              if (!Number.isSafeInteger(part.count) || part.count < 1) throw sourceError();
              if (!canonical(part)) unmatchedRows.push({ candidateId: canonical(part, true) || `unresolved-report-row-${unmatchedRows.length}`, count: part.count });
            }
          } else await observationIndex.readHeaders({ month: request.month }, row => {
              if (!canonical(row)) unmatchedRows.push({ candidateId: canonical(row, true) || `unresolved-report-row-${unmatchedRows.length}` });
            });
          const selected = data.rawCompanies.get(companyScope);
          const refs = { companyKeys: [companyScope, ...(selected?.duplicateNotes || []).map(prior => prior.mergedCompanyId).filter(Boolean)],
            companyIds: [companyScope, ...(selected?.duplicateNotes || []).map(prior => prior.mergedCompanyId).filter(Boolean)],
            placeIds: (byId.get(companyScope)?.placeIds || []).flatMap(place => [place, `cmp_place_${place}`]) };
          await observationIndex.readRows({ month: request.month, refs }, row => addRow(row, false, false));
        } else await observationIndex.readRows({ month: request.month }, row => addRow(row));
        const after = await observationIndex.ensure();
        if (before.generation !== after.generation) throw sourceError();
        malformedHistoryLines = after.malformedHistoryLines;
        if (!Number.isSafeInteger(malformedHistoryLines) || malformedHistoryLines < 0) throw sourceError();
      } catch { throw sourceError(); }
    }
    setCooperativeWorkPhase(30);
    const rankObservations = [], diagnosticRankRows = [];
    let companyIndex = 0;
    for (const [id, company] of data.rawCompanies) {
      if (companyIndex++ % 16 === 0) await checkpoint();
      // A company report needs only its own rank rows. Keep broad membership
      // diagnostics complete without allocating rows that would be discarded.
      const needsRankRows = needsMembershipEvidence || (!conflictingCompanyIds.has(id) && (companyScope === null || id === companyScope));
      for (const exposure of Object.values(company.keywords || {})) {
        for (const run of exposure.runs || []) {
          // Still traverse saved metadata so malformed legacy run containers
          // fail under the same rules as a broad read.
          if (!needsRankRows) continue;
          const row = { ...run, companyKey: id, companyId: id, companyName: company.primaryName, keyword: exposure.keyword };
          if (needsMembershipEvidence) diagnosticRankRows.push(row);
          if (!conflictingCompanyIds.has(id) && (companyScope === null || id === companyScope)) rankObservations.push(row);
        }
      }
      // Some recovered runs have only a persisted company snapshot. Their run
      // quality is still independently validated by the report aggregation.
      let fallbackCompany = company;
      if (company._monthlySourceCompact) {
        // Company-only reads can summarize unrelated fallback diagnostics.
        // Broad scopes instead need the complete original fallback rows,
        // including conflicts used by keyword membership diagnostics.
        const resolved = canonical({ companyKey: id });
        if (companyScope === null || resolved === companyScope) {
          // Preserve historical alias overwrite semantics and original company
          // iteration order. An active id can also be a reviewed merged alias;
          // its fallback then belongs to the selected canonical company.
          // Rank metadata was handled above. A source without fallback rows in
          // this month has no daily evidence to load. Broad scopes must still
          // read conflicting identities so keyword membership and global
          // diagnostics preserve every original row and its iteration order.
          if (!(company._monthlySourceFallbackMonths?.[request.month] > 0)) continue;
          try { fallbackCompany = await data._companySource.readCompany(id); }
          catch { throw sourceError(); }
        } else {
          const count = company._monthlySourceFallbackMonths?.[request.month] || 0;
          if (!resolved && count) unmatchedRows.push({ candidateId: canonical({ companyKey: id }, true) || `unresolved-report-row-${unmatchedRows.length}`, count });
          continue;
        }
      }
      for (const snapshot of [fallbackCompany.inventory?.latest, fallbackCompany.inventory?.previousLatest, ...(fallbackCompany.inventory?.snapshots || [])].filter(Boolean)) {
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
    let productCapacityEvidence = [], productCapacityWarnings = [], productCapacityEvidenceRevision = null;
    if (recalculateCompanyObservations !== null) {
      try {
        setCooperativeWorkPhase(40);
        await checkpoint();
        const recalculated = await recalculateCompanyObservations(request, data, { checkpoint,
          ...(sourceReadValidationBoundary ? { sourceReadValidationBoundary } : {}) });
        if (!Array.isArray(recalculated) || recalculated.some(row => !row || typeof row !== "object" || Array.isArray(row))) throw sourceError();
        if (Array.isArray(recalculated.productCapacityEvidence)) productCapacityEvidence = recalculated.productCapacityEvidence;
        if (Array.isArray(recalculated.productCapacityWarnings)) productCapacityWarnings = recalculated.productCapacityWarnings;
        if (/^[a-f0-9]{64}$/.test(recalculated.productCapacityEvidenceRevision || "")) productCapacityEvidenceRevision = recalculated.productCapacityEvidenceRevision;
        for (let index = 0; index < recalculated.length; index++) {
          if (index % 256 === 0) await checkpoint();
          addRow(recalculated[index]);
        }
      } catch { throw sourceError(); }
    }
    let savedProductRecoveries = [], recoveryWarnings = [];
    if (readSavedProductRecoveries !== null && request.type !== "keyword") {
      try {
        setCooperativeWorkPhase(50);
        const recovered = await readSavedProductRecoveries(request, data, { checkpoint, productCapacityEvidence });
        if (!Array.isArray(recovered?.observations) || !Array.isArray(recovered?.warnings)) throw sourceError();
        savedProductRecoveries = recovered.observations;
        if (Array.isArray(recovered.productCapacityEvidence)) productCapacityEvidence = recovered.productCapacityEvidence;
        recoveryWarnings = recovered.warnings.map(value => typeof value === "string" ? value : value?.message).filter(value => typeof value === "string");
      } catch { throw sourceError(); }
    }
    const scopeIds = request.type === "keyword"
      ? monthlyReportKeywordMembership(request, { observations: diagnosticInventoryRows, rankObservations: diagnosticRankRows, runs: data.runs }).members
      : new Set(data.companies.filter(company => request.type === "industry" || (request.type === "company" ? company.companyId === request.targetId
        : company.regionKey === request.targetId || company.regionKeys.includes(request.targetId))).map(company => company.companyId));
    const unmatchedCompanyRows = unmatchedRows.reduce((count, row) => count + (scopeIds.has(row.candidateId) ? row.count || 1 : 0), 0);
    const duplicatePlaceCompanies = [...conflictingCompanyIds].filter(id => scopeIds.has(id)).length;
    const warnings = [...recoveryWarnings, ...new Set(productCapacityWarnings.map(row => row.message).filter(value => typeof value === "string"))], globalWarnings = [];
    if (unmatchedCompanyRows) warnings.push(`리포트 대상에서 업체 고유번호를 확정하지 못한 관측 ${unmatchedCompanyRows}건을 제외했습니다.`);
    if (duplicatePlaceCompanies) warnings.push(`리포트 대상 중 플레이스 번호가 중복 연결된 업체 DB ${duplicatePlaceCompanies}개는 합산에서 제외했습니다. DB 중복 검토가 필요합니다.`);
    const globalUnmatchedCompanyRows = unmatchedRows.reduce((count, row) => count + (row.count || 1), 0) - unmatchedCompanyRows;
    const globalDuplicatePlaceCompanies = conflictingCompanyIds.size - duplicatePlaceCompanies;
    const unmappedRegionCompanies = data.companies.filter(company => !company.regionKey).length;
    if (malformedHistoryLines) globalWarnings.push(`전체 DB 참고: 읽을 수 없는 수집 이력 ${malformedHistoryLines}줄은 대상 범위를 확인할 수 없어 이 리포트의 품질 평가와 분리했습니다.`);
    if (globalUnmatchedCompanyRows) globalWarnings.push(`전체 DB 참고: 대상 밖이거나 관련성을 확정할 수 없는 업체 미식별 관측 ${globalUnmatchedCompanyRows}건이 있습니다.`);
    if (globalDuplicatePlaceCompanies) globalWarnings.push(`전체 DB 참고: 이 리포트 대상 밖에 플레이스 번호가 중복 연결된 업체 ${globalDuplicatePlaceCompanies}개가 있습니다.`);
    if (request.type === "region" && unmappedRegionCompanies) globalWarnings.push(`전체 DB 참고: 소재지가 미확정인 업체 ${unmappedRegionCompanies}개는 선택 지역에 포함되는지 알 수 없어 이 리포트의 품질 평가와 분리했습니다.`);
    setCooperativeWorkPhase(60);
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
    const source = { companies: data.companies, regions: data.regions, runs: data.runs, observations: [...observations.values()], savedProductRecoveries, rankObservations, specialDays,
      ...(productCapacityEvidenceRevision ? { productCapacityEvidenceRevision } : {}),
      warnings, sourceDiagnostics: { unmatchedCompanyRows, duplicatePlaceCompanies },
      globalWarnings, globalDiagnostics: { malformedHistoryLines, unmatchedCompanyRows: globalUnmatchedCompanyRows, duplicatePlaceCompanies: globalDuplicatePlaceCompanies,
        ...(request.type === "region" ? { unmappedRegionCompanies } : {}) }, context };
    if (publishProductCapacityEvidence && data._companySource) Object.defineProperty(source, "_productCapacityPublication", {
      value: { evidence: productCapacityEvidence, companies: data.rawCompanies, sourceRevision: data._companySource.revision,
        assertCurrent: () => data._companySource.assertCurrent() }, configurable: true });
    if (assertAtReturn && data._companySource) { try { await data._companySource.assertCurrent(); } catch { throw sourceError(); } }
    return includeCatalog ? { source, catalog: data } : source;
    } finally { sourceReadActive = false; }
  }
  async function readSources(request, includeCatalog, options = {}) {
    setCooperativeWorkPhase(10);
    const checkpoint = checkpointFor(options);
    sourceMetrics.sourceReads++;
    const acquired = () => {
      sourceMetrics.preparedCatalogReads++;
      sourceMetrics.preparedCatalogReadsByScope[Object.hasOwn(sourceMetrics.preparedCatalogReadsByScope, request.type) ? request.type : "other"]++;
      if (request.type === "company") sourceMetrics.companyProjectionReads++;
    };
    const finish = async result => {
      setCooperativeWorkPhase(70);
      // A translated/handled inner error must not publish an incomplete source
      // after a cooperative retry was requested. Keep publication indivisible.
      assertCooperativeWorkActive();
      const source = includeCatalog ? result.source : result, publication = source?._productCapacityPublication;
      if (publication) {
        delete source._productCapacityPublication;
        try { await runNonInterruptibleCooperativeWork(() => publishProductCapacityEvidence(publication.evidence, publication)); }
        catch (error) {
          if (["MONTHLY_COMPANY_SOURCE_CHANGED", "MONTHLY_COMPANY_SOURCE_REVISION_UNAVAILABLE", "MONTHLY_SOURCE_UNAVAILABLE"].includes(error.code)) throw sourceError();
          // A derived witness cache cannot turn a verified source read into
          // missing or zero data. Its own later reader also validates/falls back.
          source.warnings.push("상품별 최대관측 근거 저장을 완료하지 못했습니다. 현재 검증된 원본 계산은 유지됩니다.");
        }
      }
      assertCooperativeWorkActive();
      return result;
    };
    if (companySourceCatalog && useSourceReadValidationBoundary) {
      // The catalog owns both full freshness boundaries of this one read. Its
      // private acquisition token cannot escape or suppress a later read's
      // assertion. Only caller processing errors keep their original identity;
      // acquisition/final validation failures retain the adapter's error shape.
      let consumerFailed = false, consumerFailure;
      const consume = async data => {
        acquired();
        try { return await readSourceData(request, includeCatalog, options, data, false); }
        catch (error) { consumerFailed = true; consumerFailure = error; throw error; }
      };
      try {
        const result = request.type === "company"
          ? await companySourceCatalog.withCompanyCatalog(request.targetId, consume, { checkpoint })
          : await companySourceCatalog.withCatalog(consume, { checkpoint });
        return await finish(result);
      } catch (error) {
        if (consumerFailed) throw consumerFailure;
        throw sourceError();
      }
    }
    let data;
    if (companySourceCatalog) {
      // The generic path retains its historical immediate catalog assertion.
      try {
        data = request.type === "company"
          ? await companySourceCatalog.readCompanyCatalog(request.targetId, { checkpoint })
          : await companySourceCatalog.readCatalog({ checkpoint });
        acquired();
      } catch { throw sourceError(); }
    } else data = await readCatalog({ checkpoint });
    return finish(await readSourceData(request, includeCatalog, options, data));
  }
  function queueSourceRead(request, includeCatalog = false, options = {}) {
    // All consumers (including background company materialization) share this
    // queue. Separate UI/service queues cannot protect the shared heap alone.
    return runWork(() => sourceReadScheduler.run(() => readSources(request, includeCatalog, options), options), { ...options, kind: "source-read" });
  }
  return { options, loadSources: (request, options) => queueSourceRead(request, false, options), catalog, targetCatalog,
    loadSourcesWithCatalog: (request, options) => queueSourceRead(request, true, options),
    ...(typeof readRevision === "function" ? { readRevision } : {}),
    runInteractiveRead: sourceReadScheduler.runInteractive,
    sourceReadStatus: sourceReadScheduler.status,
    sourceReadMetrics: () => ({ ...sourceMetrics, preparedCatalogReadsByScope: { ...sourceMetrics.preparedCatalogReadsByScope },
      companyCatalog: companySourceCatalog?.stats() || null }) };
}

module.exports = { createMonthlyReportSources };
