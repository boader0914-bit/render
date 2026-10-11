"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { buildIndustryAnalysis, createIndustryAnalysisService } = require("./lib/industry_analysis.cjs");
const { createIndustryAnalysisHttpHandler } = require("./lib/industry_analysis_http.cjs");
const { createMonthlyReportSources } = require("./lib/monthly_report_sources.cjs");
const { createMonthlyCompanyRecalculation } = require("./lib/monthly_company_recalculation.cjs");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const NOW = new Date("2026-10-11T00:00:00Z");
const REQUEST = { industry: "glamping", month: "2026-08", region: "all" };
const REGIONS = [{ id: "pocheon", label: "경기도 포천시", level: "local" }, { id: "kr_gyeongnam_sacheon", label: "경상남도 사천시", level: "local" }];
function company(id, industry = "glamping", region = "pocheon") {
  return { companyId: id, primaryName: id, industryIds: [industry], regionKey: region, regionLabel: REGIONS.find(item => item.id === region)?.label || "지역 확인 전", capacity: 10 };
}
function run(id, extra = {}) { return { id, keyword: "포천글램핑", collectedAt: "2026-08-01T00:00:00Z", searchMode: "keyword", collectionQuality: { status: "complete" }, ...extra }; }
function rank(companyId, runId = "r1", extra = {}) { return { companyId, runId, rank: 1, collectedAt: "2026-08-01T00:00:00Z", ...extra }; }
function observation(companyId, runId = "r1", extra = {}) {
  return { companyId, runId, productType: "lodging", stayDate: "2026-08-01", collectedAt: "2026-08-01T00:00:00Z", inventoryEvidenceVersion: 4,
    supply: 10, sold: 5, publicBookings: 3, phoneBookings: 2, estimatedRevenue: 500, publicRevenue: 300, phoneRevenue: 200, ...extra };
}
function source(extra = {}) { return { companies: [company("a")], rankObservations: [rank("a")], observations: [observation("a")], runs: [run("r1")], regions: REGIONS, ...extra }; }
function build(input, request = {}) { return buildIndustryAnalysis(input, { ...REQUEST, ...request }, { now: NOW }); }

test("top20 membership is explicit saved rank: rank21, unknown rank, company search and future observations do not enter", () => {
  const fixture = source({ companies: ["a", "b", "c", "d", "e", "f"].map(id => company(id)),
    runs: [run("r1"), run("company", { searchMode: "company" }), run("future"), run("bad", { collectionQuality: { status: "blocked" } })],
    rankObservations: [rank("a", "r1", { rank: 20 }), rank("b", "r1", { rank: 21 }), rank("c", "r1", { rank: null }), rank("d", "company"), rank("e", "future", { collectedAt: "2026-09-01T00:00:00Z" }), rank("f", "bad")],
    observations: ["a", "b", "c", "d", "e", "f"].map(id => observation(id)) });
  const output = build(fixture);
  assert.deepEqual(output.companies.map(item => item.companyId), ["a"]);
  assert.equal(output.summary.coveredCompanyDays, 1);
  assert.equal(output.summary.expectedCompanyDays, 31);
  assert.equal(output.quality.rankExcludedByReason.outside_top20, 1);
  assert.equal(output.quality.excludedCompanies, 5);
  assert.equal(output.features.scaleGroups, false);
  assert.equal(output.features.performanceTiers, false);
  assert.equal(build(source({ rankObservations: [rank("a", "r1", { overallRank: 21, rank: 2 })] })).summary.companyCount, 0);
  assert.equal(build(source({ rankObservations: [rank("a", "r1", { overallRank: 21, rank: 2 })], observations: [observation("a", "r1", { rank: 2 })] })).summary.companyCount, 0,
    "Inventory fallback regional rank cannot override the authoritative overall rank for the same run");
});

test("basic ranking establishes cohort only; missing and blocked inventory never become zero", () => {
  const output = build(source({ runs: [run("r1", { collectionMode: "basic", collectionPurpose: "rank_only" }), run("blocked", { collectionQuality: { status: "blocked" } })],
    observations: [observation("a", "r1", { inventoryEvidenceVersion: 1 }), observation("a", "blocked", { sold: 0, publicBookings: 0, phoneBookings: 0 })] }));
  assert.equal(output.summary.companyCount, 1);
  assert.equal(output.summary.observedCompanies, 0);
  assert.equal(output.summary.reservationRate, null);
  assert.equal(output.summary.estimatedRevenue, null);
  assert.equal(output.summary.coverageRate, 0);
  assert.equal(output.summary.availability, "missing");
  const zero = build(source({ observations: [observation("a", "r1", { sold: 0, publicBookings: 0, phoneBookings: 0, estimatedRevenue: 0, publicRevenue: 0, phoneRevenue: 0 })] }));
  assert.equal(zero.summary.reservationRate, 0);
  assert.equal(zero.summary.estimatedRevenue, 0);
  assert.equal(zero.summary.averageBookedPrice, null);
});

test("hybrid tags, duplicate keywords and repeated runs deduplicate by stable ID and latest valid stay date", () => {
  const hybrid = { ...company("a"), industryIds: ["glamping", "campground", "glamping"] };
  const fixture = source({ companies: [hybrid, hybrid], runs: [run("r1"), run("r2", { keyword: "서울근교글램핑" }), run("bad", { collectionQuality: { status: "blocked" } })],
    rankObservations: [rank("a"), rank("a", "r2"), rank("a", "r2")],
    observations: [observation("a"), observation("a", "r2", { collectedAt: "2026-08-01T02:00:00Z", sold: 6, publicBookings: 4, estimatedRevenue: 600, publicRevenue: 400 }),
      observation("a", "bad", { collectedAt: "2026-08-01T03:00:00Z", sold: 0, publicBookings: 0, phoneBookings: 0 })] });
  const output = build(fixture);
  assert.equal(output.summary.companyCount, 1);
  assert.equal(output.summary.coveredCompanyDays, 1);
  assert.equal(output.summary.sold, 6);
  assert.equal(output.summary.estimatedRevenue, 600);
  assert.equal(output.companies[0].rankEvidence.length, 2);
  assert.equal(build(fixture, { industry: "campground" }).summary.sold, 6);
  assert.equal(output.industryComparison.status, "ready");
  assert.deepEqual(output.industryComparison.rows.filter(item => item.comparisonStatus === "comparable").map(item => item.id), ["glamping", "campground"]);
});

test("equal company/date means prevent large sites and densely observed companies dominating", () => {
  const fixture = source({ companies: [company("a"), company("b")], rankObservations: [rank("a"), rank("b")], observations: [
    observation("a", "r1", { supply: 100, sold: 100, publicBookings: 100, phoneBookings: 0, estimatedRevenue: 10000, publicRevenue: 10000, phoneRevenue: 0 }),
    observation("b", "r1", { sold: 0, publicBookings: 0, phoneBookings: 0, estimatedRevenue: 0, publicRevenue: 0, phoneRevenue: 0 }),
    observation("b", "r1", { stayDate: "2026-08-02", sold: 0, publicBookings: 0, phoneBookings: 0, estimatedRevenue: 0, publicRevenue: 0, phoneRevenue: 0 })] });
  const output = build(fixture);
  assert.equal(output.daily[0].reservationRate, 0.5);
  assert.equal(output.summary.reservationRate, 0.25);
  assert.equal(output.summary.expectedCompanyDays, 62);
  assert.equal(output.summary.coveredCompanyDays, 3);
  assert.equal(output.daily[2].reservationRate, null);
});

test("industry comparison matches regions and dates and uses equal regional weights", () => {
  const companies = [company("g1"), company("g2", "glamping", "kr_gyeongnam_sacheon"), company("p1", "poolVilla"), company("p2", "poolVilla", "kr_gyeongnam_sacheon")];
  const fixture = source({ companies, rankObservations: companies.map(item => rank(item.companyId)), observations: [
    observation("g1", "r1", { sold: 10, publicBookings: 10, phoneBookings: 0, estimatedRevenue: 1000, publicRevenue: 1000, phoneRevenue: 0 }),
    observation("g1", "r1", { stayDate: "2026-08-02", sold: 10, publicBookings: 10, phoneBookings: 0, estimatedRevenue: 1000, publicRevenue: 1000, phoneRevenue: 0 }),
    observation("g1", "r1", { stayDate: "2026-08-03" }), // no common date: excluded
    observation("p1"), observation("p1", "r1", { stayDate: "2026-08-02" }),
    observation("g2", "r1", { sold: 0, publicBookings: 0, phoneBookings: 0, estimatedRevenue: 0, publicRevenue: 0, phoneRevenue: 0 }), observation("p2") ] });
  const output = build(fixture), comparison = output.industryComparison;
  assert.equal(comparison.status, "ready");
  assert.deepEqual(comparison.commonDates, ["2026-08-01", "2026-08-02"]);
  assert.equal(comparison.rows.find(item => item.id === "glamping").reservationRate, 0.5);
  assert.equal(comparison.rows.find(item => item.id === "glamping").expectedCompanyDays, 3);
  assert.equal(comparison.rows.find(item => item.id === "glamping").coverageRate, 1);
  assert.equal(comparison.rows.find(item => item.id === "glamping").availability, "observed");
  assert.equal(comparison.rows.find(item => item.id === "glamping").revenuePartial, false);
  assert.equal(comparison.rows.find(item => item.id === "poolVilla").reservationRate, 0.5);
  assert.equal(comparison.metricCommonPairs.averageBookedPrice, 2);
  const separated = source({ companies: [company("a"), company("b", "poolVilla", "kr_gyeongnam_sacheon")], rankObservations: [rank("a"), rank("b")], observations: [observation("a"), observation("b")] });
  assert.equal(build(separated).industryComparison.status, "insufficient");
  assert.ok(build(separated).industryComparison.rows.every(item => item.reservationRate === null));
});

test("unpriced bookings preserve observed reservations but omit price; prior valid inventory survives failed attempt", () => {
  const result = build(source({ runs: [run("r1"), run("r2")], observations: [observation("a", "r1", { estimatedRevenue: 300, phoneRevenue: 0, phoneMissingPriceBookings: 2 }), observation("a", "r2", { collectedAt: "2026-08-01T02:00:00Z", missing: true })] }));
  assert.equal(result.summary.reservationRate, 0.5);
  assert.equal(result.summary.averageBookedPrice, null);
  assert.equal(result.summary.revenuePerAvailableUnitDay, null);
  assert.equal(result.summary.estimatedRevenue, 300);
  assert.equal(result.summary.revenuePartial, true);
  assert.equal(result.quality.discardedByReason.missing_response, 1);
});

test("service resolves actual addresses, ignores search-region tags, includes Sacheon and reads only cached context", async () => {
  const fixture = source({ companies: [company("a"), company("b")], rankObservations: [rank("a"), rank("b")], observations: [observation("a"), observation("b")] });
  let sourceReads = 0, contextReads = 0;
  const rawCompanies = new Map([["a", { companyId: "a", primaryName: "a", lodgingTypes: ["글램핑"], addresses: ["경남 사천시 모의 주소"], regions: ["포천"] }],
    ["b", { companyId: "b", primaryName: "b", lodgingTypes: ["글램핑"], regionKey: "broad", regions: ["포천"] }]]);
  const sources = { options: async () => ({ regions: REGIONS, months: ["2026-08"], defaultMonth: "2026-08" }), catalog: async () => ({ rawCompanies, regions: [...REGIONS, { id: "broad", label: "경기도", level: "broad" }] }),
    loadSources: async () => { sourceReads++; return structuredClone(fixture); } };
  const service = createIndustryAnalysisService({ sources, now: () => NOW, readContext: async request => { contextReads++; assert.equal(request.targetId, "kr_gyeongnam_sacheon"); return { sources: [{ key: "visitors", period: "202608", rows: [] }], networkAttempted: false }; } });
  const options = await service.options();
  assert.equal(options.regions.find(item => item.id === "kr_gyeongnam_sacheon").coast, "남해안");
  const [all, sacheon] = await Promise.all([service.analyze(REQUEST), service.analyze({ ...REQUEST, region: "kr_gyeongnam_sacheon" })]);
  assert.equal(sourceReads, 1);
  assert.equal(contextReads, 1);
  assert.equal(all.quality.unknownRegionCompanies, 1);
  assert.equal(all.companies.find(item => item.companyId === "b").regionKey, "");
  assert.equal(sacheon.summary.companyCount, 1);
  assert.equal(sacheon.companies[0].companyId, "a");
  assert.equal(sacheon.context.sources[0].key, "visitors");
  const invalid = createIndustryAnalysisService({ sources, now: () => NOW, readContext: async () => ({ networkAttempted: true }) });
  await assert.rejects(invalid.analyze({ ...REQUEST, region: "kr_gyeongnam_sacheon" }), { code: "INDUSTRY_CONTEXT_MUST_BE_CACHE_ONLY" });
});

test("invalid input, cutoff, rank timestamp and capacity conflicts fail closed", () => {
  assert.throws(() => build(source(), { month: "2026-13" }), { code: "invalid_month" });
  assert.throws(() => build(source(), { region: "missing" }), { code: "invalid_region" });
  assert.throws(() => build(source(), { industry: "other" }), { code: "invalid_industry" });
  assert.throws(() => build(source(), { cutoffDate: "2026-12-01" }), { code: "invalid_cutoff" });
  assert.equal(build(source({ rankObservations: [rank("a", "r1", { collectedAt: "2026-08-01T00:00:00" })] })).summary.companyCount, 0);
  assert.equal(build(source({ observations: [observation("a", "r1", { capacityConflict: true })] })).summary.coveredCompanyDays, 0);
});

test("options open the latest saved cohort month and preserve capacity review provenance", async () => {
  const runs = [run("july", { collectedAt: "2026-07-01T00:00:00Z" }), run("august", { collectedAt: "2026-08-01T00:00:00Z" })];
  const rawCompanies = new Map([["a", { companyId: "a", keywords: { k: { keyword: "포천글램핑", runs: [rank("a", "july", { collectedAt: "2026-07-01T00:00:00Z" }), rank("a", "august")] } } }]]);
  const service = createIndustryAnalysisService({ now: () => NOW, sources: {
    options: async () => ({ regions: REGIONS, months: ["2026-10", "2026-09", "2026-08", "2026-07"], defaultMonth: "2026-09", today: "2026-10-11" }),
    catalog: async () => ({ regions: REGIONS, runs, rawCompanies })
  } });
  const options = await service.options();
  assert.equal(options.defaultMonth, "2026-08");
  assert.deepEqual(options.availableEvidenceMonths, ["2026-08", "2026-07"]);
  const capacityBasis = { count: 10, source: "observed_locked", revision: 3, warnings: ["관리자 검토가 필요합니다."], label: "최대 관측 기준 고정 · 미검수" };
  const output = build(source({ companies: [{ ...company("a"), capacityBasis }] }));
  assert.deepEqual(output.companies[0].capacityBasis, capacityBasis);
  assert.notEqual(output.companies[0].capacityBasis, capacityBasis);
});

test("actual shared source and recalculation pipeline preserves reviewed capacity in industry scope", async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "industry-recalculation-"));
  t.after(async () => { await fs.rm(directory, { recursive: true, force: true }); });
  const companyFile = path.join(directory, "company_master", "companies.json");
  const regionFile = path.join(directory, "region.json");
  await fs.mkdir(path.dirname(companyFile), { recursive: true });
  await fs.mkdir(path.join(directory, "history"));
  const raw = { companyId: "a", primaryName: "검수 글램핑", addresses: ["경기도 포천시 모의 주소"], lodgingTypes: ["글램핑"], placeIds: ["1"], runIds: ["r1"],
    manualCorrection: { lodgingBasisTotal: 10 }, keywords: { "포천글램핑": { keyword: "포천글램핑", runs: [rank("a")] } } };
  await fs.writeFile(companyFile, JSON.stringify({ companies: { a: raw } }));
  await fs.writeFile(regionFile, JSON.stringify({ units: [{ active: true, selectable: true, level: "local", regionKey: "pocheon", fullName: "경기도 포천시" }] }));
  await fs.writeFile(path.join(directory, "history", "observations.jsonl"), JSON.stringify(observation("a", "r1", { supply: 6 })) + "\n");
  const savedRun = run("r1", { checkIn: "2026-08-01", bookingRangeDays: 31 });
  let rawReads = 0;
  const recalculate = createMonthlyCompanyRecalculation({
    loadRun: async (id, options) => { rawReads++; assert.equal(options.skipHistory, true); assert.equal(options.skipCompanyMaster, true); assert.equal(options.skipTourismVisitors, true);
      return { run: savedRun, availability: { items: [{ companyId: "a", inventoryEvidence: { version: 4 } }] } }; },
    applyCompanyManualCorrection: (item, company) => ({ ...item, supply: company.manualCorrection.lodgingBasisTotal }),
    companyProductAvailabilityMatch: (company, item) => company.companyId === item.companyId,
    buildHistoryObservations: value => [observation("a", "r1", { supply: value.availability.items[0].supply })]
  });
  const sources = createMonthlyReportSources({ dataDir: directory, regionMasterFile: regionFile, listRuns: async () => [savedRun],
    capacityForCompany: company => company.manualCorrection.lodgingBasisTotal,
    projectObservation: row => ({ ...row, recalculationUnavailable: row.supply !== 10 }), recalculateCompanyObservations: recalculate });
  const output = await createIndustryAnalysisService({ sources, now: () => NOW }).analyze(REQUEST);
  assert.equal(rawReads, 1, "Industry scope reaches the existing saved-evidence recalculation hook");
  assert.equal(output.summary.coveredCompanyDays, 1);
  assert.equal(output.summary.supply, 10);
  assert.equal(output.summary.reservationRate, 0.5);
  assert.equal(output.companies[0].capacity, 10);
});

test("abbreviated metropolitan addresses resolve without using keyword regions", async () => {
  const cities = ["서울", "부산", "대구", "인천", "광주", "대전", "울산"];
  const regions = cities.map((city, index) => ({ id: `r${index}`, label: `${city}${index ? "광역시" : "특별시"} 중구`, level: "local" }));
  const companies = cities.map((_, index) => company(`c${index}`));
  const fixture = source({ companies, regions, rankObservations: companies.map(item => rank(item.companyId)), observations: companies.map(item => observation(item.companyId)) });
  const rawCompanies = new Map(cities.map((city, index) => [`c${index}`, { lodgingTypes: ["글램핑"], addresses: [`${city} 중구 모의 주소`], regions: ["포천"] }]));
  const service = createIndustryAnalysisService({ now: () => NOW, sources: { loadSources: async () => fixture, catalog: async () => ({ rawCompanies, regions }) } });
  const output = await service.analyze(REQUEST);
  assert.equal(output.quality.unknownRegionCompanies, 0);
  assert.deepEqual(output.companies.map(item => item.regionKey), regions.map(item => item.id));
});

test("HTTP endpoints are admin-only read-only, reject duplicate or unknown input and never call service on denial", async () => {
  const calls = [], responses = [];
  const handler = createIndustryAnalysisHttpHandler({ service: { options: async () => { calls.push("options"); return {}; }, analyze: async request => { calls.push(request); return {}; } },
    requireAdmin: session => session?.admin === true, send: (_, status, body) => responses.push({ status, body }) });
  const request = async (pathname, method = "GET", admin = true) => handler({ method }, {}, new URL(pathname, "http://localhost"), { admin });
  assert.equal(await request("/api/unrelated"), false);
  await request("/api/industry-analysis/options", "GET", false);
  assert.equal(calls.length, 0);
  await request("/api/industry-analysis/options");
  assert.equal(calls[0], "options");
  await request("/api/industry-analysis?month=2026-08&industry=glamping&region=all");
  assert.deepEqual(calls[1], { month: "2026-08", industry: "glamping", region: "all" });
  for (const path of ["/api/industry-analysis?month=2026-08&month=2026-09", "/api/industry-analysis?refresh=true", "/api/industry-analysis/options?force=true"]) {
    await request(path); assert.equal(responses.at(-1).status, 400);
  }
  await request("/api/industry-analysis", "POST");
  assert.equal(responses.at(-1).status, 405);
  assert.equal(calls.length, 2);
});
