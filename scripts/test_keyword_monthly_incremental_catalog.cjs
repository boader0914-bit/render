"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs/promises"), path = require("node:path"), os = require("node:os");
const { createIncrementalCatalog } = require("./lib/keyword_monthly_incremental_catalog.cjs");
const { compactMonthlyCapacityCompany } = require("./lib/monthly_company_source_catalog.cjs");
const { createMonthlyReportSources } = require("./lib/monthly_report_sources.cjs");
const { buildMonthlyReportSnapshot } = require("./lib/monthly_reports.cjs");
const clone = value => JSON.parse(JSON.stringify(value));
const regions = [{ active: true, selectable: true, level: "local", regionKey: "region-a", regionId: "ra", name: "모의시", fullName: "모의도 모의시", aliases: ["모의시"] }];
const runs = [1, 2, 3].map(index => ({ id: `r${index}`, keyword: "모의글램핑", collectedAt: `2026-11-0${index}T00:00:00Z`, collectionQuality: { status: index === 2 ? "partial" : "complete" } }));
function row(runId, date, extra = {}) {
  return { runId, companyId: "b", companyKey: "b", keyword: "모의글램핑", productType: "lodging", stayDate: date,
    collectedAt: runs.find(run => run.id === runId).collectedAt, inventoryEvidenceVersion: 4,
    supply: 5, sold: 2, publicBookings: 1, phoneBookings: 1, publicRevenue: 100, phoneRevenue: 100, estimatedRevenue: 200, ...extra };
}
function companies() {
  return [
    { companyId: "a", primaryName: "순위만 있는 업체", addresses: ["모의도 모의시 모의로"], placeIds: ["11"],
      keywords: { k: { keyword: "모의글램핑", runs: [{ runId: "r1", rank: 2, collectedAt: runs[0].collectedAt }] } } },
    { companyId: "b", primaryName: "재고 업체", regions: ["region-a"], placeIds: ["22"],
      inventory: { latest: { runId: "r1", collectedAt: runs[0].collectedAt, productSnapshot: { inventoryEvidenceVersion: 4,
        daily: [row("r1", "2026-11-04", { rawTotal: 5 })] } } } },
    { companyId: "deleted", primaryName: "삭제 보존 업체", deletedAt: "2026-11-01T00:00:00Z" },
    { companyId: "merged", primaryName: "병합 보존 업체", mergedIntoCompanyId: "b" }
  ];
}
const prepare = async values => Object.fromEntries(Object.entries(values).map(([id, company]) => [id, company.deletedAt || company.mergedIntoCompanyId ? company : {
  ...company, _integratedCapacity: { capacity: 5, count: 5, source: "observed_locked", revision: 1, label: "고정 기준" },
  manualCorrection: { active: true, lodgingBasisTotal: 5, source: "integrated_observed_basis" }
}]));
const capacityForCompany = company => company._integratedCapacity?.capacity || null;

async function providerFixture(overrides = {}) {
  const raw = companies(), prepared = await prepare(Object.fromEntries(raw.map(company => [company.companyId, company])));
  let reads = 0;
  const entries = raw.map((company, orderIndex) => ({ companyId: company.companyId, orderIndex, rawSha256: "1".repeat(64), compact: compactMonthlyCapacityCompany(prepared[company.companyId]) }));
  const provider = await createIncrementalCatalog({ entries: entries.slice().reverse(), runs, regions, revision: "private-generation-1",
    readRawCompany: async id => { reads++; return clone(raw.find(company => company.companyId === id)); }, capacityForCompany, ...overrides });
  return { provider, entries, reads: () => reads, raw, prepared };
}

test("pinned catalog keeps master order and prepared fields without reading raw bodies", async () => {
  const { provider, reads, entries } = await providerFixture();
  const first = await provider.readCatalog();
  assert.equal(reads(), 0);
  assert.deepEqual(first.companies.map(company => company.companyId), ["a", "b"]);
  assert.deepEqual([...first.rawCompanies.keys()], ["a", "b"]);
  assert.equal(first.rawCompanies.get("b")._monthlySourceFallbackMonths["2026-11"], 1);
  assert.equal(first.companies[0].capacity, 5);
  assert.equal((await provider.readCatalog({ prepareCapacity: false })).companies[0].capacity, null);
  const company = await first._companySource.readCompany("b");
  assert.equal(reads(), 1);
  assert.equal(company._integratedCapacity.source, "observed_locked");
  assert.equal(company.manualCorrection.lodgingBasisTotal, 5);
  assert.equal(company.inventory.latest.productSnapshot.daily[0].stayDate, "2026-11-04");
  company.inventory.latest.productSnapshot.daily[0].sold = 999;
  assert.equal((await first._companySource.readCompany("b")).inventory.latest.productSnapshot.daily[0].sold, 2);
  first.rawCompanies.clear();
  assert.deepEqual([...(await provider.readCatalog()).rawCompanies.keys()], ["a", "b"]);
  entries[1].compact.primaryName = "외부 변경";
  assert.equal((await provider.readCatalog()).companies[1].primaryName, "재고 업체");
});

test("unchanged source normalizer has exact source and snapshot parity over a private catalog", async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "incremental-monthly-catalog-"));
  t.after(async () => { assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir())); await fs.rm(directory, { recursive: true, force: true }); });
  const fixture = await providerFixture();
  await fs.mkdir(path.join(directory, "company_master")); await fs.mkdir(path.join(directory, "history"));
  await fs.writeFile(path.join(directory, "company_master/companies.json"), JSON.stringify({ companies: Object.fromEntries(fixture.raw.map(company => [company.companyId, company])) }));
  await fs.writeFile(path.join(directory, "regions.json"), JSON.stringify({ units: regions }));
  const rows = [row("r1", "2026-11-05"), row("r3", "2026-11-05", { sold: 3, phoneBookings: 2, phoneRevenue: 200, estimatedRevenue: 300 }),
    row("r2", "2026-11-06", { partial: true, explicitBlockedBookings: 1, explicitBlockedRevenue: 100 })];
  await fs.writeFile(path.join(directory, "history/observations.jsonl"), rows.map(value => JSON.stringify(value)).join("\n") + "\n");
  const options = { dataDir: directory, regionMasterFile: path.join(directory, "regions.json"), listRuns: async () => clone(runs), prepareCompanies: prepare, capacityForCompany };
  const original = createMonthlyReportSources(options);
  const index = { ensure: async () => ({ generation: 1, malformedHistoryLines: 0 }), readRows: async (query, consume) => { for (const value of rows) consume(clone(value)); } };
  const incremental = createMonthlyReportSources({ ...options, dataDir: path.join(directory, "no-original-data"), observationIndex: index,
    preparedCatalogProvider: fixture.provider, useSourceReadValidationBoundary: true });
  const request = { type: "keyword", targetId: "모의글램핑", month: "2026-11", cutoffDate: "2026-11-15" };
  const expected = await original.loadSources(request, { includeContext: false });
  const actual = await incremental.loadSources(request, { includeContext: false });
  assert.deepEqual(actual, expected);
  const generatedAt = "2026-11-15T00:00:00Z";
  const snapshot = buildMonthlyReportSnapshot(request, actual, generatedAt);
  assert.deepEqual(snapshot, buildMonthlyReportSnapshot(request, expected, generatedAt));
  assert.equal(snapshot.quality.companyCount, 2);
  assert.equal(snapshot.quality.expectedCompanyDays, 60);
  assert.equal(snapshot.companies[0].summary.lodging.sold, null);
  assert.equal(snapshot.summary.lodging.knownPartialRevenue, 200);
  assert.equal(snapshot.changes.rows.length, 1);
  assert.equal(snapshot.insights.pickup.lodging.comparableIntervals, 1);
  assert.deepEqual((await incremental.catalog()).companies, (await original.catalog()).companies);
  assert.equal(incremental.sourceReadMetrics().catalogFullReads, 0);
});

test("catalog verification failure never falls back to source files", async () => {
  let valid = true;
  const { provider } = await providerFixture({ assertCurrent: async () => { if (!valid) throw Object.assign(new Error("changed"), { code: "PIN_CHANGED" }); } });
  await assert.rejects(provider.withCatalog(async () => { valid = false; return "unverified"; }), { code: "PIN_CHANGED" });
  await assert.rejects(provider.readCatalog(), { code: "PIN_CHANGED" });
  const source = createMonthlyReportSources({ dataDir: path.join(os.tmpdir(), "unreadable-monthly-original"), listRuns: async () => { throw new Error("original run access"); },
    preparedCatalogProvider: provider, useSourceReadValidationBoundary: true });
  await assert.rejects(source.loadSources({ type: "keyword", targetId: "모의글램핑", month: "2026-11", cutoffDate: "2026-11-15" }), { code: "MONTHLY_SOURCE_UNAVAILABLE" });
});
