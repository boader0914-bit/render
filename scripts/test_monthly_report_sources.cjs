"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { createMonthlyReportSources } = require("./lib/monthly_report_sources.cjs");
const { createMonthlyReportContext } = require("./lib/monthly_report_context.cjs");
const { buildMonthlyReportSnapshot } = require("./lib/monthly_reports.cjs");

test("canonical IDs, merged IDs, ambiguous names, exact regions and strict source errors", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "monthly-sources-"));
  t.after(async () => { assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)); await fs.rm(root, { recursive: true, force: true }); });
  await fs.mkdir(path.join(root, "company_master")); await fs.mkdir(path.join(root, "history"));
  const companyFile = path.join(root, "company_master", "companies.json");
  const historyFile = path.join(root, "history", "observations.jsonl");
  const companies = {
    cmp_a: { companyId: "cmp_a", primaryName: "같은숙소", addresses: ["경기도 포천시 모의로"], duplicateNotes: [{ mergedCompanyId: "cmp_old" }] },
    cmp_b: { companyId: "cmp_b", primaryName: "같은숙소", addresses: ["경상남도 고성군 모의로"] }
  };
  await fs.writeFile(companyFile, JSON.stringify({ companies }));
  const common = { runId: "r1", stayDate: "2026-08-15", productType: "lodging", total: 10, publicBookings: 0 };
  await fs.writeFile(historyFile, [
    { ...common, companyKey: "cmp_a" }, { ...common, companyKey: "cmp_old", stayDate: "2026-08-16" },
    { ...common, companyKey: "같은숙소", companyName: "같은숙소" },
    { ...common, companyKey: "cmp_foreign", companyName: "같은숙소" },
    { ...common, companyKey: "cmp_a", stayDate: "2026-09-01" }
  ].map(JSON.stringify).join("\n") + "\n{bad\n");
  let projected = 0;
  const source = createMonthlyReportSources({ dataDir: root, regionMasterFile: path.join(__dirname, "../web/data/region_master.json"),
    listRuns: async () => [{ id: "r1", keyword: "포천글램핑", checkIn: "2026-08-01", checkOut: "2026-09-01" }],
    projectObservation: row => { projected++; return { ...row, projected: true }; },
    readContext: async () => ({ sources: [], networkAttempted: false }) });
  const value = await source.loadSources({ month: "2026-08", type: "company", targetId: "cmp_a" });
  assert.equal(value.observations.length, 2);
  assert.equal(projected, 2);
  assert.equal(value.observations[1].companyKey, "cmp_a");
  assert.equal(value.sourceDiagnostics.unmatchedCompanyRows, 0, "unidentified rows cannot be attributed to this company");
  assert.equal(value.globalDiagnostics.unmatchedCompanyRows, 2);
  assert.equal(value.globalDiagnostics.malformedHistoryLines, 1);
  const company = value.companies.find(item => item.companyId === "cmp_a");
  assert.equal(company.regionKey, "kr_gyeonggi_pocheon");
  assert.ok(company.regionKeys.includes("kr_admin_4100000000"));
  assert.equal(value.companies.find(item => item.companyId === "cmp_b").regionKey, "kr_admin_4882000000");
  const opts = await source.options();
  assert.ok(opts.months.includes("2026-08"));
  assert.deepEqual(opts.keywords, [{ id: "포천글램핑", label: "포천글램핑" }]);
  companies.cmp_a.addresses = [];
  companies.cmp_a.regions = ["경기도", "포천"];
  await fs.writeFile(companyFile, JSON.stringify({ companies }));
  assert.equal((await source.loadSources({ month: "2026-08", type: "region", targetId: "kr_gyeonggi_pocheon" })).companies[0].regionKey, "kr_gyeonggi_pocheon");
  companies.cmp_a.placeIds = ["1001"];
  companies.cmp_b.placeIds = ["1001"];
  await fs.writeFile(companyFile, JSON.stringify({ companies }));
  const duplicates = await source.loadSources({ month: "2026-08", type: "region", targetId: "kr_gyeonggi_pocheon" });
  assert.equal(duplicates.observations.length, 0, "unresolved same-place duplicates must not be summed twice");
  assert.equal(duplicates.sourceDiagnostics.duplicatePlaceCompanies, 1, "only the duplicate in the selected region affects its quality");
  assert.equal(duplicates.globalDiagnostics.duplicatePlaceCompanies, 1);
  companies.cmp_b.placeIds = ["1002"];
  companies.cmp_a.primaryName = "고유숙소";
  await fs.writeFile(companyFile, JSON.stringify({ companies }));
  await fs.appendFile(historyFile, JSON.stringify({ ...common, stayDate: "2026-08-17", companyKey: "9999999", companyName: "고유숙소" }) + "\n");
  const strongId = await source.loadSources({ month: "2026-08", type: "company", targetId: "cmp_a" });
  assert.equal(strongId.observations.filter(row => row.companyKey === "cmp_a").length, 2, "unknown numeric provider ID must not fall back to a display name");
  await fs.writeFile(companyFile, "{bad");
  await assert.rejects(source.options(), error => error.code === "MONTHLY_SOURCE_UNAVAILABLE");
});

test("company, region and monthly keyword quality ignore unrelated global defects while retaining scoped exclusions", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "monthly-source-scope-"));
  t.after(async () => { assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)); await fs.rm(root, { recursive: true, force: true }); });
  await fs.mkdir(path.join(root, "company_master")); await fs.mkdir(path.join(root, "history"));
  const companyFile = path.join(root, "company_master", "companies.json");
  const historyFile = path.join(root, "history", "observations.jsonl");
  const regionFile = path.join(root, "regions.json");
  await fs.writeFile(regionFile, JSON.stringify({ units: [
    { regionKey: "region_clean", fullName: "정상시", name: "정상시", active: true, selectable: true, level: "local" },
    { regionKey: "region_other", fullName: "다른시", name: "다른시", active: true, selectable: true, level: "local" }
  ] }));
  const runs = Array.from({ length: 31 }, (_, index) => ({ id: `r${index}`, keyword: "정상키워드", collectedAt: `2026-08-${String(index + 1).padStart(2, "0")}T01:00:00Z`, collectionQuality: { status: "complete" } }));
  runs.push({ id: "other", keyword: "다른키워드", collectedAt: "2026-08-01T01:00:00Z", collectionQuality: { status: "complete" } });
  runs.push({ id: "old", keyword: "정상키워드", collectedAt: "2026-07-01T01:00:00Z", collectionQuality: { status: "complete" } });
  const companies = {
    cmp_clean: { companyId: "cmp_clean", primaryName: "정상숙소", placeIds: ["100"], regions: ["정상시"] },
    cmp_a: { companyId: "cmp_a", primaryName: "중복 A", placeIds: ["200"], regions: ["다른시"], keywords: { old: { keyword: "정상키워드", runs: [{ runId: "old", collectedAt: "2026-07-01T01:00:00Z", rank: 1 }] } } },
    cmp_b: { companyId: "cmp_b", primaryName: "중복 B", placeIds: ["200"], regions: ["다른시"] },
    cmp_unmapped: { companyId: "cmp_unmapped", primaryName: "소재지 미확인", placeIds: ["300"] }
  };
  await fs.writeFile(companyFile, JSON.stringify({ companies }));
  const valid = { productType: "lodging", inventoryEvidenceVersion: 4, supply: 10, sold: 0, publicBookings: 0, phoneBookings: 0, publicRevenue: 0, phoneRevenue: 0, estimatedRevenue: 0 };
  const rows = runs.slice(0, 31).map(run => ({ ...valid, companyKey: "cmp_clean", runId: run.id, stayDate: run.collectedAt.slice(0, 10), collectedAt: run.collectedAt }));
  rows.push({ ...valid, companyKey: "unknown", runId: "other", stayDate: "2026-08-01", collectedAt: "2026-08-01T01:00:00Z" });
  await fs.writeFile(historyFile, rows.map(JSON.stringify).join("\n") + "\n{malformed\n");
  const adapter = createMonthlyReportSources({ dataDir: root, regionMasterFile: regionFile, listRuns: async () => runs });
  for (const [type, targetId] of [["company", "cmp_clean"], ["region", "region_clean"], ["keyword", "정상키워드"]]) {
    const condition = { type, targetId, month: "2026-08", cutoffDate: "2026-08-31" };
    const source = await adapter.loadSources(condition);
    assert.deepEqual(source.warnings, [], `${type}: global problems must not become report warnings`);
    assert.equal(source.sourceDiagnostics.duplicatePlaceCompanies, 0);
    assert.equal(source.sourceDiagnostics.unmatchedCompanyRows, 0);
    assert.equal(source.globalDiagnostics.duplicatePlaceCompanies, 2);
    assert.equal(source.globalDiagnostics.malformedHistoryLines, 1);
    assert.equal(source.globalDiagnostics.unmatchedCompanyRows, 1);
    if (type === "region") assert.equal(source.globalDiagnostics.unmappedRegionCompanies, 1);
    assert.ok(source.globalWarnings.length >= 3);
    const snapshot = buildMonthlyReportSnapshot(condition, source, "2026-09-26T00:00:00Z");
    assert.equal(snapshot.quality.coverageRate, 1);
    assert.equal(snapshot.quality.sameDayObservedCompanyDays, 31);
    assert.equal(snapshot.quality.status, "complete", `${type}: complete evidence remains complete despite unrelated DB issues`);
  }
  const selectedDuplicate = await adapter.loadSources({ type: "company", targetId: "cmp_a", month: "2026-08", cutoffDate: "2026-08-31" });
  assert.equal(selectedDuplicate.sourceDiagnostics.duplicatePlaceCompanies, 1);
  assert.ok(selectedDuplicate.warnings.some(value => value.includes("중복")));
  const selectedRegion = await adapter.loadSources({ type: "region", targetId: "region_other", month: "2026-08", cutoffDate: "2026-08-31" });
  assert.equal(selectedRegion.sourceDiagnostics.duplicatePlaceCompanies, 2);
  companies.cmp_a.keywords.current = { keyword: "정상키워드", runs: [{ runId: "r0", collectedAt: "2026-08-01T01:00:00Z", rank: 1 }] };
  await fs.writeFile(companyFile, JSON.stringify({ companies }));
  const currentKeywordDuplicate = await adapter.loadSources({ type: "keyword", targetId: "정상키워드", month: "2026-08", cutoffDate: "2026-08-31" });
  assert.equal(currentKeywordDuplicate.sourceDiagnostics.duplicatePlaceCompanies, 1, "same-month eligible keyword exposure scopes the duplicate warning");
  assert.equal(currentKeywordDuplicate.globalDiagnostics.duplicatePlaceCompanies, 1);
  await fs.appendFile(historyFile, JSON.stringify({ ...valid, companyKey: "unknown-in-selected-keyword", runId: "r0", stayDate: "2026-08-01", collectedAt: "2026-08-01T01:00:00Z" }) + "\n");
  const unknownInScope = await adapter.loadSources({ type: "keyword", targetId: "정상키워드", month: "2026-08", cutoffDate: "2026-08-31" });
  assert.equal(unknownInScope.sourceDiagnostics.unmatchedCompanyRows, 1, "unresolved identity in an eligible target keyword observation stays actionable");
  assert.equal(unknownInScope.globalDiagnostics.unmatchedCompanyRows, 1);
});

test("context uses cache-only exact month, keeps genuine zero and KOSIS vintage", async () => {
  let calls = 0;
  const cache = async input => {
    calls++; assert.equal(input.collectMissing, false); assert.equal(input.refresh, false); assert.equal(input.force, false);
    assert.equal(input.endYearMonth, "202608");
    return { series: [{ yearMonth: "202608", status: "complete", values: { service: 0, culture: 7, visitor: 2, spend: 3, international: 4 }, stayOverall: 5, spendOverall: 6 }], collection: { networkAttemptedMonths: 0 } };
  };
  const read = createMonthlyReportContext({ kosisService: { getRegion: async () => ({ networkAttempted: false, datasets: [{ key: "population", label: "인구", period: "202607", periodType: "M", status: "ready", rows: [{ key: "population", label: "인구", value: 0, unit: "명", status: "observed" }] }] }) },
    tourismCollector: { collectDemandStrengthHistory: cache, collectResourceDemandHistory: cache, collectDiversityHistory: cache,
      collectVisitorHistory: async input => { await cache(input); return { regions: [{ regionKey: "r", series: [{ yearMonth: "202607", status: "complete", averageDailyVisitors: 999 }] }], collection: {} }; } } });
  const result = await read({ type: "region", targetId: "r", month: "2026-08" }, { regions: [{ id: "r", label: "지역", level: "local" }] });
  assert.equal(calls, 4);
  assert.equal(result.sources[0].period, "202607");
  assert.equal(result.sources[0].rows[0].value, 0);
  assert.equal(result.sources.find(item => item.key === "tourism_visitors").rows[0].value, null, "prior month is not relabelled as report month");
  assert.equal(result.sources.find(item => item.key === "tourism_resource").rows[0].value, 0);
  assert.equal(result.sources.find(item => item.key === "tourism_diversity").rows[2].value, 4);
  assert.equal(result.networkAttempted, false);
});

test("keyword regional background follows distinct actual locations, never the keyword name", async () => {
  const regions = [];
  const read = createMonthlyReportContext({ kosisService: { getRegion: async id => {
    regions.push(id); return { networkAttempted: false, datasets: [{ key: "population", label: "인구", period: "2025", rows: [] }] };
  } }, tourismCollector: {} });
  const value = await read({ type: "keyword", targetId: "서울근교글램핑", month: "2026-08" }, {
    companies: [{ regionKey: "pocheon" }, { regionKey: "gapyeong" }, { regionKey: "pocheon" }, { regionKey: "" }],
    regions: [{ id: "pocheon", level: "local", label: "포천" }, { id: "gapyeong", level: "local", label: "가평" }] });
  assert.deepEqual(regions, ["gapyeong", "pocheon"]);
  assert.equal(value.sources.length, 2);
  assert.deepEqual(value.sources.map(item => item.regionKey), ["gapyeong", "pocheon"]);
  assert.equal(value.networkAttempted, false);
  const violating = createMonthlyReportContext({ kosisService: { getRegion: async () => ({ networkAttempted: true }) }, tourismCollector: {} });
  await assert.rejects(violating({ type: "keyword", month: "2026-08" }, { companies: [{ regionKey: "pocheon" }], regions: [] }), /CACHE_ONLY/);
});

test("holiday classification reads both cache years at year boundary and refuses a provider attempt", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "monthly-special-days-"));
  t.after(async () => { assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)); await fs.rm(root, { recursive: true, force: true }); });
  const input = { dataDir: root, regionMasterFile: path.join(root, "regions.json"), listRuns: async () => [] };
  const years = [];
  const adapter = createMonthlyReportSources({ ...input, readSpecialDays: async year => {
    years.push(year); return { networkAttempted: false, updatedAt: "2026-12-01T00:00:00Z", categories: { holidays: {
      status: "ready", items: [{ date: `${year}-01-01`, name: "신정", isHoliday: true }, { date: `${year}-01-02`, name: "기념일", isHoliday: false }] } } };
  } });
  const result = await adapter.loadSources({ type: "keyword", targetId: "키워드", month: "2026-12", cutoffDate: "2026-12-31" });
  assert.deepEqual(years, [2026, 2027]);
  assert.equal(result.specialDays.years[1].holidays.length, 1);
  const stale = createMonthlyReportSources({ ...input, readSpecialDays: async () => ({ categories: { holidays: { status: "stale", items: [] } } }) });
  assert.equal((await stale.loadSources({ type: "company", targetId: "a", month: "2026-12" })).specialDays.years[0].status, "missing");
  const violating = createMonthlyReportSources({ ...input, readSpecialDays: async () => ({ networkAttempted: true }) });
  await assert.rejects(violating.loadSources({ type: "company", targetId: "a", month: "2026-12" }), /CACHE_ONLY/);
});
