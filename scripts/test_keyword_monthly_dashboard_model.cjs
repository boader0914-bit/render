"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const { buildKeywordMonthlyDashboardModel: build } = require("./lib/keyword_monthly_dashboard_model.cjs");
const { buildKeywordMonthlyBenchmark: benchmark } = require("./lib/keyword_monthly_benchmark.cjs");
function row(companyId, supply, publicBookings, phoneBookings = 0, extra = {}) {
  return { companyId, date: "2026-10-01", productType: "lodging", runQuality: "complete", supply, publicBookings, phoneBookings,
    sold: publicBookings + phoneBookings, revenueEligible: true, revenuePartial: false,
    estimatedRevenue: (publicBookings + phoneBookings) * 100, publicRevenue: publicBookings * 100, phoneRevenue: phoneBookings * 100,
    observationLeadTimeDays: 0, inventoryEvidenceVersion: 4, dayUseSharingStatus: "not_shared", phoneValuationPolicy: "observed_product_price", ...extra };
}
function fixture(rows = [row("a", 2, 1, 1), row("b", 8, 2)]) {
  return { request: { month: "2026-10" }, companies: [{ companyId: "a", primaryName: "선택 업체" }, { companyId: "b", primaryName: "다른 업체" }, { companyId: "rank", primaryName: "순위만 있는 업체" }],
    sources: { observations: rows, partialEvidence: [{ companyId: "a", knownPartialRevenue: 999999 }] }, summary: { lodging: { estimatedRevenue: 1357911, actualRevenue: null } } };
}
function close(actual, expected) { assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} != ${expected}`); }
function freeze(value) { if (value && typeof value === "object") { Object.freeze(value); for (const child of Object.values(value)) freeze(child); } return value; }
test("channel stacks use the same eligible supply-weighted cohort as the existing benchmark", () => {
  const value = build(fixture(), { companyId: "a" }), expected = benchmark(fixture(), { companyId: "a" });
  assert.equal(value.status, "available"); assert.equal(value.monthly.includesSelected, true); assert.equal(value.monthly.whole, value.monthly.all);
  close(value.companies[0].publicRate, 0.5); close(value.companies[0].phoneRate, 0.5); close(value.companies[0].totalRate, 1);
  close(value.monthly.whole.publicRate, 0.3); close(value.monthly.whole.phoneRate, 0.1); close(value.monthly.whole.totalRate, 0.4);
  close(value.monthly.peers.totalRate, 0.25); close(value.monthly.equalCompany.all.reservationRate, 0.625);
  assert.equal(value.monthly.whole.publicBookings, 3); assert.equal(value.monthly.whole.phoneBookings, 1);
  assert.equal(value.monthly.whole.reservationRate, expected.monthly.all.reservationRate);
  close(value.monthly.whole.publicRate + value.monthly.whole.phoneRate, value.monthly.whole.totalRate);
});
test("all roster companies remain available in original order without a top-20 cap", () => {
  const source = fixture(); source.companies = Array.from({ length: 42 }, (_, i) => ({ companyId: `c${i}`, primaryName: `업체 ${i}` }));
  source.sources.observations = source.companies.slice(0, 41).map((c, i) => row(c.companyId, 10, i % 5));
  const value = build(source, { companyId: "c40" });
  assert.equal(value.companies.length, 42); assert.deepEqual(value.companies.map(c => c.companyId), source.companies.map(c => c.companyId));
  assert.equal(value.companies[40].selected, true); assert.equal(value.companies[41].quantityKnown, false); assert.equal(value.companies[41].totalRate, null);
  assert.equal(value.monthly.rosterCompanyCount, 42);
});
test("rank-only values stay null while observed zero demand remains zero", () => {
  const value = build(fixture([row("a", 2, 0), row("b", 8, 0)]), { companyId: "rank" });
  const unknown = value.monthly.selected, observed = value.companies[0];
  assert.equal(unknown.supply, null); assert.equal(unknown.sold, null); assert.equal(unknown.publicRate, null); assert.equal(unknown.phoneRate, null);
  assert.equal(unknown.totalRate, null); assert.equal(unknown.coverageRate, 0); assert.equal(unknown.quantityKnown, false);
  assert.equal(observed.totalRate, 0); assert.equal(observed.publicRate, 0); assert.equal(observed.phoneRate, 0); assert.equal(observed.quantityKnown, true);
});
test("zero supply is observed but does not become a made-up zero reservation rate", () => {
  const value = build(fixture([row("a", 0, 0), row("b", 8, 0)]), { companyId: "a" });
  assert.equal(value.monthly.selected.quantityKnown, true); assert.equal(value.monthly.selected.totalRate, null);
  assert.equal(value.monthly.selected.publicRate, null); assert.equal(value.monthly.selected.availability, "observed_no_supply");
  assert.equal(value.daily[0].selectedObserved, true); assert.equal(value.daily[0].selectedRate, null); assert.equal(value.daily[0].canCompare, false);
  assert.equal(value.daily[0].wholeCompanyCount, 2); assert.equal(value.daily[0].wholeCoverageRate, 2 / 3);
});
test("daily coverage uses date-eligible companies over the roster, not the monthly denominator", () => {
  const value = build(fixture(), { companyId: "a" }), day = value.daily[0];
  assert.equal(day.wholeCoverageRate, 2 / 3); assert.equal(day.peerCoverageRate, 1 / 2);
  assert.equal(day.coverageBasis, "eligible_companies_over_roster_on_date");
  assert.equal(day.wholeCompanyCount, 2); assert.equal(day.rosterCompanyCount, 3);
  assert.equal(value.monthly.whole.coverageRate, 2 / (31 * 2));
  assert.equal(value.daily[1].wholeRate, null); assert.equal(value.daily[1].wholeCoverageRate, 0); assert.equal(value.daily[1].wholeSold, null);
});
test("whole month and daily series are invariant under selected-company changes", () => {
  const source = fixture([row("a", 2, 1, 1), row("b", 8, 2), row("b", 8, 4, 0, { date: "2026-10-02" })]);
  const a = build(source, { companyId: "a" }), b = build(source, { companyId: "b" }), unknown = build(source, { companyId: "rank" });
  assert.deepEqual(a.monthly.whole, b.monthly.whole); assert.deepEqual(a.monthly.whole, unknown.monthly.whole);
  for (let i = 0; i < a.daily.length; i++) for (const field of ["wholeRate", "wholePublicRate", "wholePhoneRate", "wholeSupply", "wholeSold", "wholeCompanyCount", "wholeCoverageRate"]) {
    assert.equal(a.daily[i][field], b.daily[i][field]); assert.equal(a.daily[i][field], unknown.daily[i][field]);
  }
  assert.equal(unknown.daily[0].selectedRate, null); assert.equal(unknown.daily[0].difference, null); assert.equal(unknown.daily[0].canCompare, false);
  assert.equal(unknown.daily[0].wholeRate, unknown.daily[0].peerRate);
});
test("a selected-company gap never borrows the whole line or invents a comparison", () => {
  const value = build(fixture([row("a", 2, 1, 0, { date: "2026-10-02" }), row("b", 8, 2)]), { companyId: "a" });
  assert.equal(value.daily[0].selectedRate, null); assert.equal(value.daily[0].selectedSupply, null); assert.equal(value.daily[0].difference, null);
  assert.equal(value.daily[0].wholeRate, 0.25); assert.equal(value.daily[0].selectedObserved, false); assert.equal(value.daily[0].canComparePeers, false);
  assert.equal(value.daily[1].selectedRate, 0.5); assert.equal(value.daily[2].wholeRate, null);
});
test("default selected company is stable even on a day where only another company was observed", () => {
  const value = build(fixture([row("a", 2, 1, 0, { date: "2026-10-02" }), row("b", 8, 2)]));
  assert.equal(value.status, "available"); assert.equal(value.selectedCompanyId, "a"); assert.equal(value.daily[0].selectedRate, null); assert.equal(value.daily[1].selectedRate, 0.5);
});
test("calendar includes every real month date without zero filling gaps, including leap February", () => {
  for (const [month, count] of [["2026-10", 31], ["2026-02", 28], ["2028-02", 29], ["2026-04", 30]]) {
    const source = fixture([row("a", 2, 1, 0, { date: `${month}-01` })]); source.request.month = month;
    const value = build(source); assert.equal(value.daily.length, count); assert.equal(value.fairDaily.length, count);
    assert.equal(value.daily[0].date, `${month}-01`); assert.equal(value.daily.at(-1).date, `${month}-${count}`);
    assert.equal(value.daily.at(-1).selectedRate, null); assert.equal(value.daily.at(-1).wholeRate, null);
  }
});
test("daily whole contribution includes the selected company once regardless of peer count", () => {
  const source = fixture([row("a", 2, 1, 1), row("b", 8, 0), row("c", 10, 0)]); source.companies.push({ companyId: "c", name: "추가 업체" });
  const value = build(source, { companyId: "a" });
  assert.equal(value.daily[0].wholeSupply, 20); assert.equal(value.daily[0].wholeSold, 2); assert.equal(value.daily[0].wholeRate, 0.1);
  assert.equal(value.fairDaily[0].wholeRate, 0.1); assert.equal(value.sameDatesSummary.all.supply, 20);
});
test("same-date fair series is explicit and separate from an unmatched daily whole", () => {
  const source = fixture([row("a", 2, 1, 1), row("b", 8, 2, 0, { observationLeadTimeDays: 1 })]);
  const value = build(source, { companyId: "a" });
  assert.equal(value.daily[0].wholeRate, 0.4); assert.equal(value.daily[0].canCompare, true);
  assert.equal(value.fairDaily[0].paired, false); assert.equal(value.fairDaily[0].wholeRate, null); assert.equal(value.fairDaily[0].selectedRate, null);
  assert.equal(value.sameDatesSummary.exclusions.observation_timing_changed, 1);
});
test("one company can be included in the whole but never creates peer or fair values", () => {
  const source = fixture([row("a", 2, 1)]); source.companies = [source.companies[0]];
  const value = build(source); assert.equal(value.daily[0].wholeRate, 0.5); assert.equal(value.daily[0].peerRate, null);
  assert.equal(value.daily[0].canComparePeers, false); assert.equal(value.daily[0].peerDifference, null); assert.equal(value.fairDaily[0].wholeRate, null);
});
test("duplicate observations never double-count channels and conflicts fail closed", () => {
  const observation = row("a", 2, 1, 1), source = fixture([observation, { ...observation }, row("b", 8, 2)]), value = build(source);
  assert.equal(value.identicalDuplicates, 1); assert.equal(value.monthly.whole.publicBookings, 3); assert.equal(value.monthly.whole.phoneBookings, 1); assert.equal(value.daily[0].wholeSold, 4);
  const conflict = build(fixture([observation, { ...observation, sold: 1, publicBookings: 0 }]));
  assert.equal(conflict.status, "needs_verification"); assert.equal(conflict.code, "BENCHMARK_DUPLICATE_OBSERVATION_CONFLICT");
  assert.deepEqual(conflict.companies, []); assert.deepEqual(conflict.daily, []); assert.equal(conflict.monthly, null);
});
test("partial, invalid and unknown quantities are excluded identically from both channel cohorts", () => {
  for (const extra of [{ partial: true }, { runQuality: "partial" }, { runQuality: undefined }, { runQuality: "blocked" }, { missing: true }, { unknownUnavailable: 1 }, { supply: undefined }, { phoneBookings: undefined }, { publicBookings: 0 }]) {
    const value = build(fixture([row("a", 2, 1, 1, extra), row("b", 8, 0)]), { companyId: "a" });
    assert.equal(value.monthly.selected.quantityKnown, false); assert.equal(value.monthly.selected.publicRate, null); assert.equal(value.daily[0].selectedRate, null);
    assert.equal(value.monthly.whole.publicBookings, 0); assert.equal(value.monthly.whole.phoneBookings, 0); assert.equal(value.daily[0].wholeRate, 0);
  }
});
test("money flags do not alter valid quantity stacks, and original financial totals are not rebuilt", () => {
  const source = freeze(fixture([row("a", 2, 1, 1, { revenuePartial: true }), row("b", 8, 2)])), before = JSON.stringify(source), value = build(source), expected = benchmark(source);
  assert.equal(value.monthly.selected.totalRate, 1); assert.equal(value.monthly.selected.phoneRate, 0.5);
  assert.equal(value.monthly.selected.completePriceCompanyDays, 0); assert.equal(value.monthly.selected.completePriceAmount, null);
  for (const key of ["completePriceCompanyDays", "completePriceAmount", "amountPerCompletePriceCompanyDay"]) assert.equal(value.monthly.whole[key], expected.monthly.all[key]);
  assert.equal(JSON.stringify(source), before); assert.equal(source.summary.lodging.estimatedRevenue, 1357911);
  assert.equal(Object.hasOwn(value.daily[0], "estimatedRevenue"), false); assert.equal(Object.hasOwn(value.daily[0], "actualRevenue"), false);
});
test("foreign company, month and product remain excluded without changing source totals", () => {
  const source = fixture([row("a", 2, 1, 1), row("x", 999, 999), row("b", 999, 999, 0, { date: "2026-09-30" }), row("b", 8, 3, 0, { productType: "dayuse" })]);
  const lodging = build(source, { companyId: "a" }), dayuse = build(source, { productType: "dayuse", companyId: "b" });
  assert.equal(lodging.monthly.whole.supply, 2); assert.equal(lodging.monthly.whole.sold, 2); assert.equal(lodging.exclusions.company_outside_snapshot, 1);
  assert.equal(lodging.exclusions.date_outside_month, 1); assert.equal(dayuse.monthly.whole.supply, 8); assert.equal(dayuse.monthly.whole.publicRate, 3 / 8);
});
test("empty or entirely unobserved rosters expose null lines and explicit coverage counts", () => {
  const missing = build(fixture([]), { companyId: "rank" }); assert.equal(missing.status, "missing"); assert.equal(missing.companies.length, 3);
  assert.equal(missing.daily[0].selectedRate, null); assert.equal(missing.daily[0].wholeRate, null); assert.equal(missing.daily[0].wholeCompanyCount, 0);
  const empty = fixture([]); empty.companies = []; const value = build(empty);
  assert.equal(value.status, "missing"); assert.equal(value.monthly.selected, null); assert.equal(value.daily[0].wholeCoverageRate, null); assert.equal(value.daily[0].selectedSold, null);
});
test("unsafe aggregate integer totals do not become approximate channel counts", () => {
  const maximum = Number.MAX_SAFE_INTEGER, value = build(fixture([row("a", maximum, maximum), row("b", maximum, maximum)]));
  assert.equal(value.monthly.whole.supply, null); assert.equal(value.monthly.whole.sold, null); assert.equal(value.monthly.whole.publicBookings, null);
  assert.equal(value.monthly.whole.totalRate, null); assert.equal(value.monthly.whole.publicRate, null); assert.equal(value.daily[0].wholePublicBookings, null);
  assert.equal(value.monthly.whole.availability, "observed_quantity_unavailable");
});
test("invalid model requests preserve existing benchmark failure semantics", () => {
  assert.equal(build(fixture(), { productType: "all" }).status, "needs_verification");
  const invalidMonth = fixture(); invalidMonth.request.month = "2026-13"; assert.equal(build(invalidMonth).code, "BENCHMARK_SNAPSHOT_EVIDENCE_MISSING");
  const duplicate = fixture(); duplicate.companies.push(duplicate.companies[0]); assert.equal(build(duplicate).code, "BENCHMARK_COMPANY_IDENTITY_CONFLICT");
  assert.equal(build({}).code, "BENCHMARK_SNAPSHOT_EVIDENCE_MISSING");
});
test("browser UMD and CJS share calculations without DOM/network and tolerate dependency load order", () => {
  const modelCode = fs.readFileSync(path.join(__dirname, "../web/keyword-monthly-dashboard-model.js"), "utf8"), benchmarkCode = fs.readFileSync(path.join(__dirname, "../web/keyword-monthly-benchmark.js"), "utf8");
  const context = { window: {} }; vm.runInNewContext(modelCode, context);
  assert.equal(context.window.KeywordMonthlyDashboardModel.buildKeywordMonthlyDashboardModel(fixture()).code, "KEYWORD_MONTHLY_DASHBOARD_BENCHMARK_UNAVAILABLE");
  vm.runInNewContext(benchmarkCode, context);
  assert.deepEqual(JSON.parse(JSON.stringify(context.window.KeywordMonthlyDashboardModel.buildKeywordMonthlyDashboardModel(fixture()))), build(fixture()));
});
test("model reuses existing eligibility API once for the month and once per date", () => {
  let calls = 0; const context = { window: { KeywordMonthlyBenchmark: { buildKeywordMonthlyBenchmark: (...args) => { calls++; return benchmark(...args); } } } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../web/keyword-monthly-dashboard-model.js"), "utf8"), context);
  const value = context.window.KeywordMonthlyDashboardModel.buildKeywordMonthlyDashboardModel(fixture());
  assert.equal(value.status, "available"); assert.equal(calls, 32);
});
test("larger complete month keeps all companies and selection does not alter whole totals", () => {
  const companies = Array.from({ length: 42 }, (_, i) => ({ companyId: `c${i}`, name: `표본${i}` })), rows = [];
  for (let date = 1; date <= 31; date++) for (let company = 0; company < companies.length; company++) rows.push(row(companies[company].companyId, 10, company % 5, 1, { date: `2026-10-${String(date).padStart(2, "0")}` }));
  const source = { ...fixture(rows), companies }, a = build(source, { companyId: "c0" }), b = build(source, { companyId: "c41" });
  assert.equal(a.companies.length, 42); assert.equal(a.monthly.whole.observedCompanyDays, 1302); assert.equal(a.daily.length, 31);
  assert.deepEqual(a.monthly.whole, b.monthly.whole); assert.equal(a.daily.every(day => day.wholeCompanyCount === 42 && day.wholeCoverageRate === 1), true);
});
