"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { compactIndustrySources, buildIndustryAnalysis, createIndustryAnalysisService } = require("./lib/industry_analysis.cjs");
const { buildMonthlyReportSnapshot } = require("./lib/monthly_reports.cjs");
const { recoveryRowDigest } = require("./lib/saved_product_recovery.cjs");
const NOW = new Date("2026-10-25T01:00:00Z"), MONTH = "2026-09", COMPANY = "cmp_test_recovery", STAMP = "2026-09-01T01:00:00Z";
const QUERY = { industry: "glamping", month: MONTH, region: "all", cutoffDate: "2026-09-30" };
const CERT_FIELDS = ["kind", "companyId", "runId", "date", "productType", "collectedAt", "originalRunQuality", "receiptId", "sourceDigest", "rowDigest"];
function row(day, overrides = {}) {
  return { companyId: COMPANY, companyKey: COMPANY, runId: "legacy", keyword: "검수글램핑", productType: "lodging", stayDate: `${MONTH}-${String(day).padStart(2, "0")}`,
    collectedAt: STAMP, inventoryEvidenceVersion: 5, supply: 10, sold: 3, publicBookings: 1, phoneBookings: 2,
    publicRevenue: 100000, phoneRevenue: 200000, estimatedRevenue: 300000, phoneMissingPriceBookings: 0, ...overrides };
}
function certify(value, changes = {}) {
  return { row: value, certificate: { kind: "saved_product_recovery_v1", companyId: COMPANY, runId: value.runId,
    date: value.stayDate, productType: value.productType, collectedAt: value.collectedAt, originalRunQuality: "unknown",
    receiptId: "a".repeat(64), sourceDigest: "b".repeat(64), rowDigest: recoveryRowDigest(value), ...changes } };
}
function fixture() {
  const regions = [{ id: "pocheon", label: "경기도 포천시", level: "local" }];
  const company = { companyId: COMPANY, primaryName: "검수글램핑", industryIds: ["glamping"], lodgingTypes: ["글램핑"], capacity: 10, regionKey: "pocheon", addresses: ["경기도 포천시 검수로"] };
  const source = { companies: [company], regions,
    runs: [{ id: "normal", keyword: "검수글램핑", searchMode: "keyword", collectedAt: STAMP, collectionQuality: { status: "complete" } },
      { id: "legacy", keyword: "검수글램핑", searchMode: "keyword", collectedAt: STAMP, collectionQuality: { status: "unknown" } }],
    rankObservations: [{ companyId: COMPANY, runId: "normal", keyword: "검수글램핑", rank: 1, collectedAt: STAMP }],
    observations: [row(1, { runId: "normal", sold: 2, publicBookings: 1, phoneBookings: 1, publicRevenue: 100000, phoneRevenue: 100000, estimatedRevenue: 200000 })],
    savedProductRecoveries: [certify(row(2)), certify(row(3, { sold: 0, publicBookings: 0, phoneBookings: 0, publicRevenue: 0, phoneRevenue: 0, estimatedRevenue: 0 })),
      certify(row(4, { publicRevenue: 0, phoneRevenue: 0, estimatedRevenue: 0, phoneMissingPriceBookings: 2 }))] };
  return { source, catalog: { companies: [company], rawCompanies: new Map([[COMPANY, company]]), runs: source.runs, regions } };
}
test("industry compaction and paired service retain verified legacy rows without changing common normalized quantities or money", async () => {
  const pair = fixture(), before = JSON.stringify(pair.source), compact = compactIndustrySources(pair.source, pair.catalog).source;
  assert.equal(compact.savedProductRecoveries.length, 3);
  for (let index = 0; index < 3; index++) {
    assert.equal(compact.savedProductRecoveries[index].row, pair.source.savedProductRecoveries[index].row, "do not copy or trim row before digest validation");
    assert.deepEqual(Object.keys(compact.savedProductRecoveries[index].certificate).sort(), CERT_FIELDS.toSorted());
  }
  const request = { type: "company", targetId: COMPANY, month: MONTH, cutoffDate: "2026-09-30" };
  const common = buildMonthlyReportSnapshot(request, pair.source, NOW.toISOString());
  const projected = buildMonthlyReportSnapshot(request, compact, NOW.toISOString());
  assert.deepEqual(projected.summary, common.summary);
  assert.deepEqual(projected.sources.observations, common.sources.observations);
  assert.equal(projected.sources.observations.length, 4);
  const zero = projected.sources.observations.find(value => value.date === "2026-09-03"), unknown = projected.sources.observations.find(value => value.date === "2026-09-04");
  assert.equal(zero.sold, 0); assert.equal(zero.estimatedRevenue, 0); assert.equal(zero.revenueEligible, true);
  assert.equal(unknown.sold, 3); assert.equal(unknown.estimatedRevenue, null); assert.equal(unknown.revenueEligible, false);
  const service = createIndustryAnalysisService({ now: () => NOW, sources: { loadSourcesWithCatalog: async () => pair }, sourceCacheMaxBytes: 0 });
  const { context: serviceContext, ...serviceResult } = await service.analyze(QUERY);
  const { context: directContext, ...directResult } = buildIndustryAnalysis(compact, QUERY, { now: NOW });
  assert.deepEqual(serviceResult, directResult);
  assert.equal(JSON.stringify(pair.source), before, "projection and analysis leave certified source rows unchanged");
});
test("raw unknown markers and changed certificate scope or row contents never become certified industry observations", () => {
  const pair = fixture(), forged = row(5, { sourceRecovery: { kind: "saved_product_recovery_v1", receiptId: "a".repeat(64) } });
  pair.source.observations.push(forged);
  const tampered = certify(row(6)); tampered.row.sold = 4;
  pair.source.savedProductRecoveries.push(tampered, certify(row(7), { companyId: "another-company" }), certify(row(8), { date: "2026-09-09" }),
    certify(row(9), { collectedAt: "2026-09-02T01:00:00Z" }), certify(row(10), { productType: "dayuse" }));
  const compact = compactIndustrySources(pair.source, pair.catalog).source;
  const snapshot = buildMonthlyReportSnapshot({ type: "company", targetId: COMPANY, month: MONTH, cutoffDate: "2026-09-30" }, compact, NOW.toISOString());
  assert.deepEqual(snapshot.sources.observations.map(value => value.date), ["2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04"]);
  assert.equal(snapshot.quality.discardedByReason.unknown_legacy_run_quality, 1);
  const result = buildIndustryAnalysis(compact, QUERY, { now: NOW });
  assert.equal(result.summary.coveredCompanyDays, 4);
});
test("compaction only retains the existing row and minimal certificate, never reader raw files or an altered run-quality gate", () => {
  const pair = fixture(), entry = pair.source.savedProductRecoveries[0];
  entry.rawSource = { privatePath: "/var/data/outputs/unchanged.json", products: new Array(1000).fill("unneeded") };
  entry.certificate.rawFiles = entry.rawSource;
  const compact = compactIndustrySources(pair.source, pair.catalog).source;
  assert.deepEqual(Object.keys(compact.savedProductRecoveries[0]), ["row", "certificate"]);
  assert.equal(compact.savedProductRecoveries[0].certificate.rawFiles, undefined);
  compact.runs.find(value => value.id === "legacy").collectionQuality.status = "blocked";
  const snapshot = buildMonthlyReportSnapshot({ type: "company", targetId: COMPANY, month: MONTH, cutoffDate: "2026-09-30" }, compact, NOW.toISOString());
  assert.deepEqual(snapshot.sources.observations.map(value => value.date), ["2026-09-01"]);
});
