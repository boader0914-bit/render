"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname, "../web/app.js"), "utf8");
function harness() {
  const context = vm.createContext({
    adminDbChartSafeId: value => String(value).replace(/[^a-z0-9]/gi, ""),
    adminDbChartDateLabel: value => String(value).slice(0, 10),
    adminDbReferenceDateLabel: value => value,
    adminDbReferenceResolvedSalesHistory: model => model.history,
    adminDbReferenceDeltaTag: () => "<mark>관측</mark>",
    adminDbReferenceRankKeywordControlHtml: () => "",
    adminDbReferenceWeekdayRate: (rows, label) => ({ label, rate: NaN, observedDays: 0 }),
    adminDbReferencePeriodRateChartHtml: () => "<figure>예약율 관측</figure>"
  });
  for (const name of ["escapeHtml", "fmtNumber", "fmtWon", "fmtRate", "finiteNumber", "optionalNumber", "adminDbChartRate",
    "adminDbChartClamp", "adminDbTrendPoints", "adminDbPerformanceChartModel", "adminDbPerformanceChartHtml",
    "sheetBookingRevenueBreakdown", "adminDbReferenceCurrentSection"]) {
    const declaration = source.match(new RegExp(`^function ${name}\\([^]*?^}`, "m"))?.[0];
    assert.ok(declaration, name); vm.runInContext(declaration, context);
  }
  return context;
}

test("the actual C current-observation section displays both colored amounts", () => {
  const c = harness();
  const html = c.adminDbReferenceCurrentSection({ company: { companyId: "fixture" } }, { history: {
    today: "2026-09-24", currentEnd: "2026-10-21", currentRows: [], current: {
      observedDays: 28, estimatedRevenue: 52304000, publicRevenue: 32264000, phoneRevenue: 20040000,
      publicBookings: 100, phoneBookings: 60, phoneMissingPriceBookings: 0, explicitBlockedDayUseUnverified: true
    }
  } });
  assert.match(html, /최근 운영 관측/);
  assert.match(html, /class="booking-public"[^]*?공개예약 추정매출[^]*?3,226만원/);
  assert.match(html, /class="booking-blocked"[^]*?방막기 추정매출[^]*?2,004만원/);
  assert.match(html, /데이유즈 미확인/);
});

test("D matches revenue components only to the identical run and never labels an old total public", () => {
  const c = harness();
  const detail = { company: { inventory: { latest: { runId: "latest", revenue: { lodging: { publicRevenue: 200000, phoneRevenue: 100000 } } } } },
    performanceTrend: { points: [{ runId: "old", collectedAt: "2026-09-21", estimatedRevenue: 400000, reservationRate: 0.4 },
      { runId: "latest", collectedAt: "2026-09-24", estimatedRevenue: 300000, reservationRate: null, partial: true }] } };
  const model = c.adminDbPerformanceChartModel({}, detail);
  assert.equal(model.points[0].revenueBreakdownAvailable, false);
  assert.equal(model.points[1].revenueBreakdownAvailable, true);
  assert.ok(Number.isNaN(model.points[1].reservationRate));
  const html = c.adminDbPerformanceChartHtml({}, model);
  assert.match(html, /admin-company-chart-revenue-bar booking-public/);
  assert.match(html, /admin-company-chart-revenue-bar booking-blocked/);
  assert.match(html, /admin-company-chart-revenue-bar booking-unavailable/);
  assert.match(html, /합계 · 구분자료 없음/);
  assert.match(html, /공개예약 20만원/);
  assert.match(html, /방막기 10만원/);
  assert.equal((html.match(/<circle class="admin-company-chart-rate-point/g) || []).length, 1, "an unknown rate is not plotted as zero");
  assert.doesNotMatch(html, /<line class="admin-company-chart-rate-line/);
});

test("incomplete or mismatching decomposition keeps the whole bar neutral", () => {
  const c = harness();
  for (const fields of [{ publicRevenue: 100000 }, { publicRevenue: 100000, phoneRevenue: 100000 }]) {
    const model = c.adminDbPerformanceChartModel({}, { performanceTrend: { points: [{ runId: "fixture", estimatedRevenue: 300000,
      reservationRate: 0.5, ...fields }] } });
    assert.equal(model.points[0].revenueBreakdownAvailable, false);
    const html = c.adminDbPerformanceChartHtml({}, model);
    assert.match(html, /booking-unavailable/);
    assert.doesNotMatch(html, /class="admin-company-chart-revenue-bar booking-public"/);
    assert.doesNotMatch(html, /class="admin-company-chart-revenue-bar booking-blocked"/);
  }
});
