"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { buildIndustryAnalysis, createIndustryAnalysisService, compactIndustrySources, industryCompanyReference } = require("./lib/industry_analysis.cjs");
const { createIndustryAnalysisHttpHandler } = require("./lib/industry_analysis_http.cjs");
const { createMonthlyReportSources } = require("./lib/monthly_report_sources.cjs");
const { createMonthlyCompanyRecalculation } = require("./lib/monthly_company_recalculation.cjs");
const { buildMonthlyReportSnapshot } = require("./lib/monthly_reports.cjs");
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
const flushTasks = () => new Promise(resolve => setImmediate(resolve));

test("industry selector and fallback catalog maintenance use background source priority", async () => {
  const calls = [], fixture = source();
  const service = createIndustryAnalysisService({ now: () => NOW, sources: {
    options: async options => { calls.push(["options", options]); return { regions: REGIONS, months: ["2026-08"], defaultMonth: "2026-08" }; },
    catalog: async options => { calls.push(["catalog", options]); return { rawCompanies: new Map([["a", company("a")]]), runs: fixture.runs, regions: REGIONS }; },
    loadSources: async (input, options) => { calls.push(["sources", options]); return fixture; }
  } });
  await service.options(); await service.analyze(REQUEST);
  assert.ok(calls.some(([kind]) => kind === "options"));
  assert.ok(calls.some(([kind]) => kind === "sources"));
  assert.ok(calls.every(([, options]) => options.priority === "background"));
});

test("review keeps observed zero, retained valid inventory and detailed gaps within selected industry and actual region", () => {
  const a = { ...company("a"), capacityBasis: { source: "db_review", revision: 4, count: 10, warnings: ["확인 필요"], unused: "private metadata" } };
  const fixture = source({ companies: [a, company("pension", "pension"), company("sacheon", "glamping", "kr_gyeongnam_sacheon"), company("outside")],
    runs: [run("r1"), run("r2", { collectedAt: "2026-08-02T00:00:00Z" }), run("blocked", { collectionQuality: { status: "blocked" } })],
    rankObservations: [rank("a"), rank("pension"), rank("sacheon"), rank("outside", "r1", { rank: 21 })],
    observations: [
      ...Array.from({ length: 120 }, (_, i) => observation("pension", "r1", { failed: true, observationId: `p${i}` })),
      observation("sacheon", "blocked"),
      observation("a", "r1", { sold: 0, publicBookings: 0, phoneBookings: 0, estimatedRevenue: 0, publicRevenue: 0, phoneRevenue: 0 }),
      observation("a", "r1", { stayDate: "2026-08-02" }),
      observation("a", "r2", { stayDate: "2026-08-02", collectedAt: "2026-08-02T00:00:00Z", failed: true, error: "sensitive detail 010-1111-2222" }),
      observation("a", "blocked", { stayDate: "2026-08-03" }),
      observation("a", "r1", { stayDate: "2026-08-04", missing: true }),
      observation("a", "r1", { stayDate: "2026-08-05", partial: true, sharedDayUseIncomplete: true }),
      observation("a", "r1", { stayDate: "2026-08-06", supply: null }),
      observation("a", "r1", { stayDate: "2026-08-07", publicRevenue: 0, phoneRevenue: 0, estimatedRevenue: 0 }),
      observation("a", "r1", { stayDate: "2026-08-08", recalculationUnavailable: true }),
      observation("a", "r1", { stayDate: "2026-08-09", failed: true, responseStatus: "blocked", collectionErrorCode: "NAVER_RATE_LIMITED" }),
      observation("a", "r1", { stayDate: "2026-08-10", failed: true, responseStatus: "200" })
    ] });
  const result = build(fixture, { region: "pocheon" }), review = result.review;
  assert.equal(review.schemaVersion, 1); assert.equal(review.companyCount, 1); assert.equal(review.expectedCompanyDays, 31);
  assert.equal(review.observedCompanyDays, 3); assert.equal(review.missingCompanyDays, 28);
  assert.deepEqual(review.companies.map(row => row.companyId), ["a"]);
  const cells = review.companies[0].dates, codes = index => cells[index].reasons.map(row => row.code);
  assert.equal(cells.length, 31); assert.equal(cells[0].observedZero, true); assert.equal(cells[0].reservationCount, 0); assert.equal(cells[0].status, "observed");
  assert.equal(cells[1].status, "observed"); assert.equal(cells[1].reservationCount, 5); assert.equal(cells[1].runId, "r1");
  assert.equal(cells[1].latestAttemptRunId, "r2"); assert.equal(cells[1].latestAttemptStatus, "excluded");
  assert.deepEqual(cells[1].latestAttemptReasons.map(row => row.code), ["collection_error"]);
  assert.ok(codes(2).includes("run_blocked")); assert.ok(codes(3).includes("response_missing"));
  assert.equal(cells[4].status, "partial"); assert.ok(codes(4).includes("dayuse_incomplete"));
  assert.ok(codes(5).includes("missing_quantity")); assert.equal(cells[6].reservationEligible, true); assert.equal(cells[6].priceEligible, false);
  assert.ok(codes(6).includes("unpriced_bookings")); assert.ok(codes(7).includes("capacity_recalculation_unavailable"));
  assert.ok(codes(8).includes("collection_blocked")); assert.ok(!codes(8).includes("collection_error"));
  assert.ok(codes(9).includes("collection_error")); assert.ok(!codes(9).includes("collection_blocked"));
  assert.deepEqual(codes(10), ["no_saved_observation"]); assert.equal(cells[10].reservationCount, null);
  assert.equal(review.daily[4].partialCompanies, 1); assert.equal(review.daily[4].missingCompanies, 1);
  assert.equal(review.daily[2].excludedCompanies, 1); assert.equal(review.daily[6].priceUnavailableCompanies, 1);
  assert.equal(result.quality.discardedByReason.missing_response, 4, "other industry/region excluded observations do not enter the selected quality counters");
  assert.ok(result.quality.warnings.some(text => text.includes("3/31 업체·일")));
  assert.ok(!result.quality.warnings.some(text => /\/62 |\/93 /.test(text)));
  assert.equal(result.quality.rankExcludedByReason.outside_top20, 1);
  assert.equal(review.companies[0].capacityBasis.revision, 4); assert.equal(review.companies[0].capacityBasis.unused, undefined);
  assert.ok(!JSON.stringify(review).includes("010-1111-2222"));
  assert.equal(review.reasonsSummary.find(row => row.code === "collection_error" && row.type === "latest_attempt").companyDays, 1);
});

test("review receives all common-engine diagnostics beyond its bounded sample without changing monthly values", () => {
  const fixture = source({ observations: Array.from({ length: 130 }, (_, index) => observation("a", "r1", { failed: true, observationId: `f${index}` })) });
  const request = { type: "company", targetId: "a", month: "2026-08", cutoffDate: "2026-08-31" };
  const events = [], original = buildMonthlyReportSnapshot(request, fixture, NOW.toISOString());
  const withCallback = buildMonthlyReportSnapshot(request, fixture, NOW.toISOString(), { onDiscard: (reason, row) => events.push([reason, row.companyId]) });
  assert.deepEqual(withCallback, original); assert.equal(events.length, 130); assert.equal(original.quality.discardedSamples.length, 100);
  const result = build(fixture);
  assert.equal(result.quality.discardedByReason.missing_response, 130);
  assert.equal(result.review.reasonsSummary.find(row => row.code === "collection_error").companyDays, 1, "day-based review counts do not multiply repeated failed attempts");
});

test("review cutoff excludes future attempt metadata and rank exclusion counters obey industry and actual region", () => {
  const fixture = source({ companies: [company("a"), company("b", "pension"), company("c", "glamping", "kr_gyeongnam_sacheon")],
    rankObservations: [rank("a"), rank("b", "r1", { rank: 21 }), rank("c", "r1", { rank: 21 })],
    observations: [observation("a", "r1", { stayDate: "2026-08-03" }), observation("a", "r1", { stayDate: "2026-08-03", collectedAt: "2026-08-02T00:00:00Z", failed: true })] });
  const result = build(fixture, { region: "pocheon", cutoffDate: "2026-08-01" });
  assert.equal(result.quality.rankExcludedByReason.outside_top20, undefined); assert.equal(result.quality.excludedCompanies, 0);
  const cell = result.review.companies[0].dates[2];
  assert.equal(cell.status, "observed"); assert.equal(cell.latestAttemptCollectedAt, "2026-08-01T00:00:00Z");
  assert.equal(cell.latestAttemptStatus, "observed"); assert.deepEqual(cell.latestAttemptReasons, []);
});

test("review same-attempt partial and failed evidence has an order-independent exclusion status", () => {
  const records = [observation("a", "r1", { partial: true }), observation("a", "r1", { failed: true })];
  for (const observations of [records, [...records].reverse()]) {
    const cell = build(source({ observations })).review.companies[0].dates[0];
    assert.equal(cell.status, "excluded"); assert.equal(cell.latestAttemptStatus, "excluded");
    assert.equal(cell.reservationCount, null); assert.equal(cell.observedZero, false);
    assert.deepEqual(cell.latestAttemptReasons.map(row => row.code).sort(), ["collection_error", "partial_inventory"]);
  }
});

test("compact cached metadata preserves complete analysis output, original-row ties and rank identity", t => {
  const heavy = "UNUSED_SAVED_PRODUCT_PAYLOAD".repeat(10000);
  const companies = [
    { ...company("a"), industryIds: ["glamping", "poolVilla"], capacityBasis: { source: "db_review", revision: 4, warnings: ["검토된 객실 기준"] } },
    company("b", "pension", "kr_gyeongnam_sacheon"), company("c", "poolVilla"),
    { id: "alias", name: "별칭 글램핑", industryIds: [], regionKey: "pocheon", regionLabel: REGIONS[0].label },
    { ...company("deleted"), deletedAt: "2026-08-02" }, { ...company("merged"), mergedIntoCompanyId: "a" },
    { ...company("keywordsOnly"), keywords: { search: { keyword: "포천글램핑", runs: [rank("keywordsOnly")] } } },
    company("outside"), company("unknown", "glamping", "")
  ].map(row => ({ ...row, regionKeys: row.regionKey ? [row.regionKey] : [], inventory: { productSnapshot: heavy } }));
  const id = row => row.companyId || row.id;
  const rawCompanies = new Map(companies.map(row => [id(row), { ...row, lodgingTypes: [],
    addresses: row.regionKey ? [REGIONS.find(region => region.id === row.regionKey).label + " 모의로"] : [] }]));
  const observations = [
    ...companies.map(row => observation(id(row))),
    observation("a", "r1", { decoration: "same timestamp distinct hash 1" }),
    observation("a", "r1", { sold: 4, publicBookings: 2, publicRevenue: 200, estimatedRevenue: 400, decoration: "same timestamp distinct hash 2" }),
    observation("a", "r1", { productType: "day-use", decoration: "legacy spelling" }),
    observation("a", "r1", { productType: "dayuse", decoration: "normalized spelling" }),
    observation("a", "r2", { collectedAt: "2026-08-02T00:00:00Z", failed: true }),
    observation("b", "r1", { stayDate: "2026-08-02", sold: 0, publicBookings: 0, phoneBookings: 0, publicRevenue: 0, phoneRevenue: 0, estimatedRevenue: 0 }),
    observation("c", "r1", { stayDate: "2026-08-02", partial: true, unknownUnavailable: 1, sharedDayUseIncomplete: true }),
    observation("b", "r1", { stayDate: "2026-08-03", inventoryConflict: true, capacityConflict: true }),
    observation("c", "r1", { stayDate: "2026-08-03", phonePriceEstimates: [{ sourceDate: "2026-09-01", sourceType: "lodging", bookings: 2, estimatedPrice: 100 }],
      dayUsePresence: "present", dayUseScheduleStatus: "unknown", explicitBlockedDayUseUnverified: true }),
    observation("outside", "r1", { rank: 2 })
  ];
  observations.push(observations[0]);
  const full = source({ companies, observations,
    rankObservations: companies.filter(row => !["keywordsOnly", "alias"].includes(id(row))).map(row => rank(id(row), "r1", {
      overallRank: id(row) === "outside" ? 21 : 1, unusedPayload: heavy
    })).concat([{ id: "alias", runId: "r1", rank: 8, collectedAt: "2026-08-01T00:00:00Z" }]),
    runs: [run("r1", { rawProducts: heavy, collectionQuality: { status: "complete", report: heavy } }), run("r2")]
  });
  const catalog = { rawCompanies, companies, regions: REGIONS, runs: full.runs };
  const originalJson = JSON.stringify(full);
  const compact = compactIndustrySources(full, catalog);
  for (const industry of ["glamping", "pension", "poolVilla"]) for (const region of ["all", "pocheon", "kr_gyeongnam_sacheon"]) {
    assert.deepEqual(build(compact.source, { industry, region }), build(full, { industry, region }), `${industry}/${region}`);
  }
  assert.equal(compact.source.observations, full.observations, "original row bytes and duplicate identity remain unchanged");
  assert.equal(compact.source.companies.find(row => row.companyId === "a").capacityBasis, companies[0].capacityBasis);
  assert.deepEqual(Object.keys(compact.catalog).sort(), ["companies", "regions"]);
  assert.ok(compact.source.companies.every(row => !Object.hasOwn(row, "inventory")));
  assert.ok(compact.source.runs.every(row => !Object.hasOwn(row, "rawProducts")));
  assert.equal(JSON.stringify(compact).includes("UNUSED_SAVED_PRODUCT_PAYLOAD"), false, "no retained path points into unused raw inventory or run payloads");
  const originalBytes = Buffer.byteLength(JSON.stringify({ source: full, catalog: { ...catalog, rawCompanies: [...rawCompanies] } }));
  const compactBytes = Buffer.byteLength(JSON.stringify(compact));
  assert.ok(compactBytes < originalBytes * 0.05, `${compactBytes} bytes must be below 5% of padded metadata's ${originalBytes} bytes`);
  t.diagnostic(`Synthetic metadata retention: ${originalBytes} -> ${compactBytes} serialized bytes; unchanged observation rows retained.`);
  assert.equal(JSON.stringify(full), originalJson, "projection does not mutate saved-source objects");
  const result = build(compact.source);
  assert.ok(result.companies.some(row => row.companyId === "alias"), "id-only saved ranking keeps the canonical membership alias");
  assert.ok(!result.companies.some(row => ["deleted", "merged", "keywordsOnly", "outside"].includes(row.companyId)));
});

test("industry service consumes the paired source catalog once and retains only compact context metadata", async () => {
  const full = source();
  let pairedReads = 0, contextReads = 0;
  const catalog = { regions: REGIONS, rawCompanies: new Map([["a", { industryIds: ["glamping"], addresses: ["경기도 포천시 모의로"], inventory: { payload: "unused" } }]]) };
  const service = createIndustryAnalysisService({ now: () => NOW, sources: {
    loadSourcesWithCatalog: async (request, options) => { pairedReads++; assert.equal(request.type, "industry"); assert.equal(options.priority, "background", "industry materialization cannot jump ahead of a requested report"); return { source: full, catalog }; },
    loadSources: async () => { throw Error("paired reader must replace the duplicate source call"); },
    catalog: async () => { throw Error("paired reader must replace the duplicate catalog call"); }
  }, readContext: async (request, data) => {
    contextReads++; assert.equal(request.targetId, "pocheon");
    assert.deepEqual(Object.keys(data).sort(), ["companies", "regions"]);
    assert.equal(data.companies[0].regionKey, "pocheon");
    assert.equal(Object.hasOwn(data.companies[0], "inventory"), false);
    return { sources: [], networkAttempted: false };
  } });
  const first = await service.analyze({ ...REQUEST, region: "pocheon" });
  const second = await service.analyze({ ...REQUEST, region: "pocheon" });
  assert.deepEqual(second, first); assert.equal(first.summary.companyCount, 1);
  assert.equal(pairedReads, 1); assert.equal(contextReads, 2);
});

function pendingSourceFixture({ pendingCatalog = false } = {}) {
  let millis = NOW.getTime(), reads = 0;
  const pending = [], catalogs = [];
  const catalog = { rawCompanies: new Map(), regions: REGIONS, runs: [] };
  const service = createIndustryAnalysisService({ now: () => new Date(millis), sources: {
    loadSources: () => { reads++; return new Promise((resolve, reject) => pending.push({ resolve, reject })); },
    catalog: () => pendingCatalog ? new Promise((resolve, reject) => catalogs.push({ resolve, reject })) : Promise.resolve(catalog)
  } });
  return { service, pending, catalogs, catalog, reads: () => reads, advance: milliseconds => { millis += milliseconds; },
    emptySource: () => source({ companies: [], observations: [], rankObservations: [], runs: [] }) };
}

test("slow pending requests share one source read and TTL starts after successful completion", async () => {
  const fixture = pendingSourceFixture();
  const first = fixture.service.analyze(REQUEST);
  fixture.advance(61000);
  const joined = fixture.service.analyze(REQUEST);
  await flushTasks();
  assert.equal(fixture.reads(), 1, "A running calculation cannot expire after 30 seconds");
  fixture.pending[0].resolve(fixture.emptySource());
  await Promise.all([first, joined]);
  await fixture.service.analyze(REQUEST);
  fixture.advance(29000);
  await fixture.service.analyze(REQUEST);
  assert.equal(fixture.reads(), 1, "The full TTL remains available after a slow completion");
  fixture.advance(1001);
  const expired = fixture.service.analyze(REQUEST);
  await flushTasks();
  assert.equal(fixture.reads(), 2, "A completed result expires 30 seconds after completion");
  fixture.pending[1].resolve(fixture.emptySource());
  await expired;
});

test("failed pending request is shared, then one replacement survives repeated retries", async () => {
  const fixture = pendingSourceFixture();
  const first = fixture.service.analyze(REQUEST);
  fixture.advance(61000);
  const joined = fixture.service.analyze(REQUEST);
  const failures = Promise.allSettled([first, joined]);
  await flushTasks();
  fixture.pending[0].reject(Object.assign(new Error("mock unavailable"), { code: "MOCK_UNAVAILABLE" }));
  assert.ok((await failures).every(result => result.status === "rejected" && result.reason.code === "MOCK_UNAVAILABLE"));
  assert.equal(fixture.reads(), 1);
  const replacement = fixture.service.analyze(REQUEST);
  fixture.advance(61000);
  const retried = fixture.service.analyze(REQUEST);
  await flushTasks();
  assert.equal(fixture.reads(), 2, "Failure cleanup cannot evict a replacement pending calculation");
  fixture.pending[1].resolve(fixture.emptySource());
  await Promise.all([replacement, retried]);
  await fixture.service.analyze(REQUEST);
  assert.equal(fixture.reads(), 2);
});

test("different months read serially; only the latest completed source is reused without evicting pending months", async () => {
  const fixture = pendingSourceFixture();
  const requests = ["2026-08", "2026-09", "2026-10"].map(month => ({ ...REQUEST, month }));
  const jobs = requests.map(request => fixture.service.analyze(request));
  fixture.advance(61000);
  jobs.push(fixture.service.analyze(requests[0]));
  await flushTasks();
  assert.equal(fixture.reads(), 1, "Only the first source reader starts while other months are queued");
  fixture.pending[0].resolve(fixture.emptySource());
  await jobs[0];
  await flushTasks();
  assert.equal(fixture.reads(), 2, "The second month starts only after the first has settled");
  fixture.pending[1].resolve(fixture.emptySource());
  await jobs[1];
  await flushTasks();
  assert.equal(fixture.reads(), 3, "Queued months retain their own shared promises without duplicate reads");
  fixture.pending[2].resolve(fixture.emptySource());
  await Promise.all(jobs);
  await fixture.service.analyze(requests[2]);
  assert.equal(fixture.reads(), 3, "The latest month remains reusable for another region or industry");
  const previous = fixture.service.analyze(requests[1]);
  await flushTasks();
  assert.equal(fixture.reads(), 4, "Loading a third month releases the second completed source");
  fixture.pending[3].resolve(fixture.emptySource());
  await previous;
  await fixture.service.analyze(requests[1]);
  assert.equal(fixture.reads(), 4, "The newly completed month is now the single reusable source");
  const evicted = fixture.service.analyze(requests[0]);
  await flushTasks();
  assert.equal(fixture.reads(), 5, "Older months require their own source after the active month changes");
  fixture.pending[4].resolve(fixture.emptySource());
  await evicted;
});

test("queued months evict a source published after their request and retain the final month only", async () => {
  const fixture = pendingSourceFixture();
  const august = fixture.service.analyze(REQUEST);
  const septemberRequest = { ...REQUEST, month: "2026-09" };
  const september = fixture.service.analyze(septemberRequest);
  await flushTasks();
  assert.equal(fixture.reads(), 1);
  fixture.pending[0].resolve(fixture.emptySource());
  await august;
  await flushTasks();
  assert.equal(fixture.reads(), 2, "September starts after August has published a completed source");
  fixture.pending[1].resolve(fixture.emptySource());
  await september;
  await fixture.service.analyze(septemberRequest);
  assert.equal(fixture.reads(), 2, "The final queued month can serve another request without reading raw data");
  const augustAgain = fixture.service.analyze(REQUEST);
  await flushTasks();
  assert.equal(fixture.reads(), 3, "The later queued read must have removed August's newly published source");
  fixture.pending[2].resolve(fixture.emptySource());
  await augustAgain;
});

test("invalidation during a source read does not retain old data or duplicate the replacement", async () => {
  const fixture = pendingSourceFixture();
  const obsolete = fixture.service.analyze(REQUEST);
  await flushTasks();
  await fixture.service.invalidate();
  const replacement = fixture.service.analyze(REQUEST);
  const joined = fixture.service.analyze(REQUEST);
  assert.equal(fixture.reads(), 1, "The replacement waits for the previous reader even across invalidation");
  fixture.pending[0].resolve(fixture.emptySource());
  await obsolete;
  await flushTasks();
  assert.equal(fixture.reads(), 2, "Invalidated completion cannot serve the new source epoch");
  fixture.pending[1].resolve(fixture.emptySource());
  await Promise.all([replacement, joined]);
  await fixture.service.analyze(REQUEST);
  assert.equal(fixture.reads(), 2, "The replacement retains same-key sharing and becomes the reusable source");
});

test("one failed parallel reader cannot release the pending key while the other still runs", async () => {
  const fixture = pendingSourceFixture({ pendingCatalog: true });
  const first = fixture.service.analyze(REQUEST);
  const firstResult = first.catch(error => error.code);
  await flushTasks();
  fixture.catalogs[0].reject(Object.assign(new Error("catalog unavailable"), { code: "MOCK_CATALOG_UNAVAILABLE" }));
  await Promise.resolve();
  fixture.advance(61000);
  const joinedResult = fixture.service.analyze(REQUEST).catch(error => error.code);
  assert.equal(fixture.reads(), 1, "The expensive source reader is still pending despite catalog failure");
  fixture.pending[0].resolve(fixture.emptySource());
  assert.deepEqual(await Promise.all([firstResult, joinedResult]), ["MOCK_CATALOG_UNAVAILABLE", "MOCK_CATALOG_UNAVAILABLE"]);
  const retry = fixture.service.analyze(REQUEST);
  await flushTasks();
  assert.equal(fixture.reads(), 2);
  fixture.pending[1].resolve(fixture.emptySource());
  fixture.catalogs[1].resolve(fixture.catalog);
  await retry;
});

test("a failed month releases the serial reader queue for the next month", async () => {
  const fixture = pendingSourceFixture();
  const failed = fixture.service.analyze(REQUEST).catch(error => error.code);
  const next = fixture.service.analyze({ ...REQUEST, month: "2026-09" });
  await flushTasks();
  assert.equal(fixture.reads(), 1);
  fixture.pending[0].reject(Object.assign(new Error("failed month"), { code: "MOCK_FAILED_MONTH" }));
  assert.equal(await failed, "MOCK_FAILED_MONTH");
  await flushTasks();
  assert.equal(fixture.reads(), 2);
  fixture.pending[1].resolve(fixture.emptySource());
  assert.equal((await next).request.month, "2026-09");
});

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

test("inactive region corrections cannot redirect report references or industry membership away from the actual address", async () => {
  const inactive = { companyId: "inactive", primaryName: "모의 글램핑", lodgingTypes: ["글램핑"],
    addresses: ["경기도 포천시 모의 주소"], manualCorrection: { active: false, regionOverride: "kr_gyeongnam_sacheon" } };
  const active = { ...inactive, companyId: "active", manualCorrection: { active: true, regionOverride: "kr_gyeongnam_sacheon" } };
  assert.equal(industryCompanyReference(inactive, REGIONS).industryRegionKey, "pocheon");
  assert.equal(industryCompanyReference(active, REGIONS).industryRegionKey, "kr_gyeongnam_sacheon");
  const fixture = source({ companies: [company("inactive"), company("active")], rankObservations: [rank("inactive"), rank("active")],
    observations: [observation("inactive"), observation("active")] });
  const rawCompanies = new Map([["inactive", inactive], ["active", active]]);
  const sources = { options: async () => ({ regions: REGIONS, months: ["2026-08"], defaultMonth: "2026-08" }),
    catalog: async () => ({ rawCompanies, regions: REGIONS }), loadSources: async () => structuredClone(fixture) };
  const service = createIndustryAnalysisService({ sources, now: () => NOW });
  const pocheon = await service.analyze({ ...REQUEST, region: "pocheon" });
  const sacheon = await service.analyze({ ...REQUEST, region: "kr_gyeongnam_sacheon" });
  assert.deepEqual(pocheon.companies.map(row => row.companyId), ["inactive"]);
  assert.deepEqual(sacheon.companies.map(row => row.companyId), ["active"]);
  assert.equal(pocheon.sources.regionPolicyVersion, "active-manual-region-v2");
  await service.stop();
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
