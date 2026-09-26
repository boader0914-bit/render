"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { buildMonthlyComparison, previousMonthlyReportRequest } = require("./lib/monthly_report_comparison.cjs");
const row = (month, id, day = "10", sold = 2, more = {}) => ({ companyId: id, productType: "lodging", date: `${month}-${day}`,
  collectedDate: `${month}-${day}`, observationLeadTimeDays: 0, supply: 10, sold, publicBookings: sold, phoneBookings: 0,
  estimatedRevenue: sold * 100, publicRevenue: sold * 100, phoneRevenue: 0, revenueEligible: true, inventoryEvidenceVersion: 4, ...more });
const snap = (month, rows) => ({ request: { month, cutoffDate: `${month}-${month.endsWith("09") ? 30 : 31}` }, quality: { status: "complete", warnings: [] },
  sources: { runIds: [month], observations: rows } });
test("changing membership never drives common-company change and weighted rates use room counts", () => {
  const current = snap("2026-09", [row("2026-09", "a", "10", 4), row("2026-09", "a", "11", 1, { supply: 2 }), row("2026-09", "new", "10", 80, { supply: 100 })]);
  const previous = snap("2026-08", [row("2026-08", "a"), row("2026-08", "a", "11", 0, { supply: 2 }), row("2026-08", "old", "10", 1)]);
  const value = buildMonthlyComparison(current, previous);
  assert.equal(value.all.current.sold, 85);
  assert.deepEqual(value.common.companyIds, ["a"]);
  assert.equal(value.common.matched.deltas.sold, 3);
  assert.equal(value.common.matched.current.reservationRate, 5 / 12);
  assert.deepEqual(value.newlyObservedCompanyIds, ["new"]);
  assert.deepEqual(value.noLongerObservedCompanyIds, ["old"]);
  assert.deepEqual(value.sourceRunIds, ["2026-08", "2026-09"]);
});
test("absence remains unavailable while a genuine zero denominator has no growth percentage", () => {
  const missing = buildMonthlyComparison(snap("2026-09", [row("2026-09", "a")]), snap("2026-08", []));
  assert.equal(missing.status, "unavailable");
  assert.equal(missing.all.previous.sold, null);
  assert.equal(missing.common.matched.deltas.estimatedRevenue, null);
  const zero = buildMonthlyComparison(snap("2026-09", [row("2026-09", "a")]), snap("2026-08", [row("2026-08", "a", "10", 0)]));
  assert.equal(zero.common.matched.deltas.estimatedRevenue, 200);
  assert.equal(zero.common.matched.deltas.estimatedRevenueRate, null);
  assert.equal(zero.common.matched.deltas.reservationRatePoints, 20);
});
test("capacity, sharing and timing changes are excluded; prices require symmetric coverage", () => {
  const old = [row("2026-08", "a", "10"), row("2026-08", "a", "11"), row("2026-08", "a", "12"), row("2026-08", "a", "13"), row("2026-08", "a", "31")];
  const now = [row("2026-09", "a", "10", 4, { supply: 11 }), row("2026-09", "a", "11", 4, { sharedDayUseExcluded: 1 }),
    row("2026-09", "a", "12", 4, { observationLeadTimeDays: 1 }), row("2026-09", "a", "13", 4, { revenueEligible: false, estimatedRevenue: null })];
  const value = buildMonthlyComparison(snap("2026-09", now), snap("2026-08", old));
  assert.equal(value.common.matched.companyDays, 1);
  assert.equal(value.common.matched.deltas.sold, 2);
  assert.equal(value.common.matched.deltas.estimatedRevenue, null);
  assert.equal(value.common.matched.previous.estimatedRevenue, null);
  assert.equal(value.common.matched.exclusions.capacityOrSharingChanged, 2);
  assert.equal(value.common.matched.exclusions.observationTimingChanged, 1);
  assert.equal(value.common.matched.previousExcludedCompanyDays, 4);
});
test("actual active capacity basis is stable despite changed observed stock annotations", () => {
  const old = row("2026-08", "a", "10", 2, { capacityBasis: { count: 10, source: "db_correction", currentObservedMaximum: 6 } });
  const now = row("2026-09", "a", "10", 4, { capacityBasis: { count: 10, source: "db_correction", currentObservedMaximum: 8 } });
  const value = buildMonthlyComparison(snap("2026-09", [now]), snap("2026-08", [old]));
  assert.equal(value.common.matched.companyDays, 1);
  now.capacityBasis.source = "observed_maximum";
  assert.equal(buildMonthlyComparison(snap("2026-09", [now]), snap("2026-08", [old])).common.matched.companyDays, 0);
});
test("prior month request aligns cutoff elapsed date with short months and year boundaries", () => {
  const r = { type: "keyword", targetId: "서울근교글램핑", month: "2026-03", cutoffDate: "2026-03-31" };
  assert.deepEqual(previousMonthlyReportRequest(r), { ...r, month: "2026-02", cutoffDate: "2026-02-28" });
  assert.equal(previousMonthlyReportRequest({ ...r, month: "2024-03", cutoffDate: "2024-03-31" }).cutoffDate, "2024-02-29");
  assert.equal(previousMonthlyReportRequest({ ...r, month: "2026-01", cutoffDate: "2026-01-20" }).month, "2025-12");
  assert.equal(previousMonthlyReportRequest({ ...r, cutoffDate: "2026-03-15" }).cutoffDate, "2026-02-15");
});

test("partial prices never imply comparable revenue and rank-only members stay in full market coverage", () => {
  const current = snap("2026-09", [row("2026-09", "a", "10", 2, { revenuePartial: true, estimatedRevenue: 100 })]);
  current.companies = [{ companyId: "a" }, { companyId: "rank-only" }];
  const previous = snap("2026-08", [row("2026-08", "a")]);
  const result = buildMonthlyComparison(current, previous);
  assert.equal(result.all.current.companyCount, 2);
  assert.equal(result.all.current.expectedCompanyDays, 60);
  assert.equal(result.common.companyCount, 1);
  assert.equal(result.common.matched.deltas.sold, 0);
  assert.equal(result.common.matched.deltas.estimatedRevenue, null);
  assert.equal(result.common.matched.current.revenueCoveredCompanyDays, 0);
});
