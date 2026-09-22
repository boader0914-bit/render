"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { applyInventoryEvidence } = require("./inventory_estimation.cjs");

const source = fs.readFileSync(path.join(__dirname, "../web/app.js"), "utf8").replace(/\r\n/g, "\n");
const names = ["inventoryAssessment", "salesStats", "summarizeSales", "salesObservationNote", "weeklyRows",
  "finiteNumber", "optionalNumber", "parseDate", "monthDay", "bookingDays", "escapeHtml", "fmtRate", "fmtNumber", "fmtWon",
  "analysisRunPeriod", "analysisRunPeriodLabel", "dateRangeLabel", "b2bLongDateLabel", "b2bDateRangeLabel", "renderReport", "b2bSimpleSummaryModel",
  "b2bRegionMapModel", "renderLocationCandidateEvidence", "locationRequestEvidenceText"];
const context = vm.createContext({
  state: { data: { run: { checkIn: "2026-09-20", checkOut: "2026-09-21", bookingRangeDays: 3 }, regions: [] } },
  els: { reportBody: { innerHTML: "" } },
  isAdminRole: () => true, targetEntries: () => [], activeKeyword: () => "검증글램핑",
  reportPlatformStats: () => ({ names: [], counts: {}, otaCounts: {}, otaCheckCount: 0, missingYeogi: 0, missingYanolja: 0, missingDdnayo: 0 }),
  reportMarketScore: () => 80, reportDecision: () => ({ tone: "strong", label: "집중 공략", summary: "시장 판단" }),
  B2B_HIGH_RESERVATION_RATE: 0.6, B2B_LOW_RESERVATION_RATE: 0.25,
  b2bAnalysisDays: () => 3, b2bReservationBasisText: () => "예약 관측", demandTrendSource: () => ({}),
  demandTrendStats: () => ({}), demandTrafficAggregate: () => ({}), demandNextMonthProjection: () => ({})
});
for (const name of names) {
  const declaration = source.match(new RegExp(`^function ${name}\\([^]*?^}`, "m"))?.[0];
  assert.ok(declaration, name);
  vm.runInContext(declaration, context);
}

const row = (date, extra = {}) => ({ date, name: "객실", stock: 5, bookingCount: 1, price: 100000, ...extra });
const incomplete = applyInventoryEvidence({ weeklyDays: 3, weeklyProductDetails: [row("2026-09-20")] });
const original = JSON.stringify(incomplete);
const partial = context.summarizeSales([incomplete]);
assert.equal(partial.supply, 15, "Fixed maximum capacity must remain 5 rooms across all three dates");
assert.equal(partial.sold, 1, "Keep observed bookings without inventing missing-date sales");
assert.equal(partial.complete, false);
assert.ok(Number.isNaN(context.salesStats(incomplete).rate));
assert.ok(Number.isNaN(partial.rate), "One observed day must not become a 1/15 full-period rate");
assert.equal(partial.observedRate, 0.2);
assert.equal(partial.observedDays, 1);
assert.equal(partial.expectedDays, 3);
assert.match(context.salesObservationNote(partial), /20%.*1\/3일 확보/);
assert.equal(JSON.stringify(incomplete), original, "UI aggregation must preserve source inventory");

context.state.data.availability = { items: [incomplete], stats: { weightedSoldOutRate: 1 / 15 } };
context.renderReport();
assert.match(context.els.reportBody.innerHTML, /전체 기간 판매율 미확인/);
assert.match(context.els.reportBody.innerHTML, /판단 보류/);
assert.match(context.els.reportBody.innerHTML, /기간 총량 15객실·박/);
assert.match(context.els.reportBody.innerHTML, /20%.*1\/3일 확보/);
assert.doesNotMatch(context.els.reportBody.innerHTML, /<strong>7%<\/strong>|집중 공략/,
  "A stale server weighted rate cannot override missing-date evidence");

const complete = applyInventoryEvidence({ weeklyDays: 3,
  weeklyProductDetails: [row("2026-09-20"), row("2026-09-21"), row("2026-09-22")] });
const full = context.summarizeSales([complete]);
assert.equal(full.complete, true);
assert.equal(full.rate, 3 / 15);
assert.equal(full.observedRate, full.rate);
const mixed = context.summarizeSales([complete, incomplete]);
assert.equal(mixed.supply, 30);
assert.equal(mixed.sold, 4);
assert.ok(Number.isNaN(mixed.rate), "A complete company cannot hide another company's missing dates");
assert.equal(mixed.observedRate, 4 / 20);
for (const status of ["partial", "blocked", "failed", "interrupted"]) {
  context.state.data.run.collectionQuality = { status };
  const incompleteScope = context.summarizeSales([complete]);
  assert.ok(Number.isNaN(incompleteScope.rate), "Successful items cannot hide an incomplete or blocked collection scope");
  assert.equal(incompleteScope.supply, 15);
  assert.equal(incompleteScope.observedRate, 0.2);
}
context.state.data.run.collectionQuality = { status: "complete" };
assert.equal(context.summarizeSales([complete]).rate, 0.2);
delete context.state.data.run.collectionQuality;

const closed = applyInventoryEvidence({ weeklyDays: 3, weeklyProductDetails: [
  row("2026-09-20"), row("2026-09-21", { stock: 0, bookingCount: 0, open: false }), row("2026-09-22")
] });
const closedSummary = context.summarizeSales([closed]);
assert.equal(closedSummary.complete, true, "A successfully observed closed date differs from a missing response");
assert.equal(closedSummary.rate, 7 / 15, "Existing phone-booking inference remains intact");
const shared = applyInventoryEvidence({ weeklyDays: 1, inventoryCapacityBaseline: { lodging: 5 }, weeklyProductDetails: [
  row("2026-09-20", { stock: 2 }), row("2026-09-20", { name: "데이유즈", saleType: "데이유즈", stock: 1, bookingCount: 1 })
] });
assert.equal(context.summarizeSales([shared]).sold, 3, "Shared day-use blocks remain excluded from phone booking estimates");
const conflict = applyInventoryEvidence({ weeklyDays: 1, weeklyProductDetails: [row("2026-09-20", { stock: 0, bookingCount: 2 })] });
assert.ok(Number.isNaN(context.summarizeSales([conflict]).rate));
assert.ok(Number.isNaN(context.summarizeSales([]).rate));
assert.equal(context.summarizeSales([]).complete, false, "No observations cannot mean complete");
const rankOnly = { name: "순위만 확보", rank: 1 };
assert.equal(context.summarizeSales([rankOnly]).complete, false);
assert.equal(context.summarizeSales([complete, rankOnly]).complete, false,
  "A company with no booking evidence must not become an observed zero-booking company");
context.state.data.availability = { items: [rankOnly], stats: { weightedSoldOutRate: 0.8 } };
context.renderReport();
assert.match(context.els.reportBody.innerHTML, /판단 보류/);
assert.match(context.els.reportBody.innerHTML, /확보된 예약 표본 없음/);
assert.doesNotMatch(context.els.reportBody.innerHTML, /집중 공략|<strong>80%<\/strong>/);
context.state.data.availability = { items: [] };
context.renderReport();
assert.match(context.els.reportBody.innerHTML, /요약할 수집 결과가 없습니다/);
assert.doesNotMatch(context.els.reportBody.innerHTML, /시장 판단|공략 매력도/);

const pendingBrief = { salesComplete: false, score: NaN, rate: NaN, itemCount: 2, run: {},
  decision: { tone: "watch", label: "판단 보류", summary: "미확보 자료로 경쟁강도 판단을 보류합니다." } };
const summary = context.b2bSimpleSummaryModel(pendingBrief,
  { decision: { tone: "strong", label: "집중 공략", summary: "높은 경쟁" } },
  { revenueRows: [], priceCoverage: NaN },
  { rankModel: { rows: [{}, {}], hotRows: [], gapRows: [], rate: 0.9 } });
assert.equal(summary.headline, "판단 보류", "B2B lower-card strategy must agree with the incomplete report header");
assert.equal(summary.cards[0].value, "판단 보류");
assert.equal(summary.cards[1].value, "확인필요", "A subset's valid rate cannot replace the incomplete full-scope rate");
assert.equal(summary.summary, pendingBrief.decision.summary);
context.locationCardForQuery = () => ({ card: {} });
context.regionRuntimeForMapRegion = () => ({ items: context.state.data.availability.items, sales: context.summarizeSales(context.state.data.availability.items) });
context.regionPrimary = () => "표본 권역";
context.uniqueClusterItems = (items) => items;
context.clusterRevenueMetrics = () => ({ sampleCount: 0, total: 0 });
context.b2bBoundaryBucket = () => "unknown";
context.clusterScoreDetail = () => ({ score: 0, parts: [] });
context.state.data.regions = [{ name: "표본 지역" }];
context.state.data.availability = { items: [incomplete] };
const regionModel = context.b2bRegionMapModel();
assert.ok(Number.isNaN(regionModel.clusters[0].salesRate), "Cluster aggregation must retain missing-date protection");
assert.equal(regionModel.clusters[0].supply, 15);
context.state.data.availability = { items: [complete] };
assert.equal(context.b2bRegionMapModel().clusters[0].salesRate, 0.2);
context.state.data.regions = [];
const pendingEvidence = { salesSupply: 15, salesSold: 1, salesComplete: false, salesRate: null };
assert.match(context.renderLocationCandidateEvidence({ evidence: pendingEvidence }), /판매율<\/span><strong>확인필요/);
assert.match(context.locationRequestEvidenceText(pendingEvidence), /판매 확인필요/);
assert.match(context.locationRequestEvidenceText({ salesSupply: 15, salesSold: 1 }), /판매 확인필요/,
  "Saved legacy candidate totals alone do not prove full-period completeness");
assert.match(context.locationRequestEvidenceText({ salesSupply: 15, salesSold: 3, salesComplete: true, salesRate: 0.2 }), /20%/);
const serverSource = fs.readFileSync(path.join(__dirname, "glamping_app_server.cjs"), "utf8").replace(/\r\n/g, "\n");
for (const name of ["sanitizeLocationRequestText", "sanitizeLocationRequestNumber", "sanitizeLocationRequestEvidence"]) {
  vm.runInContext(serverSource.match(new RegExp(`^function ${name}\\([^]*?^}`, "m"))[0], context);
}
assert.equal(context.sanitizeLocationRequestEvidence(pendingEvidence).salesRate, null);
assert.equal(context.sanitizeLocationRequestEvidence(pendingEvidence).salesComplete, false);
assert.equal(context.sanitizeLocationRequestEvidence({ salesComplete: true, salesRate: 0.2 }).salesRate, 0.2);

const savedRun = { checkIn: "2026-08-30", checkOut: "2026-09-30", bookingRangeDays: 31 };
assert.equal(context.analysisRunPeriod(savedRun).end, "2026-09-29");
assert.equal(context.dateRangeLabel(savedRun), "8/30~9/29 (31일)");
assert.match(context.b2bDateRangeLabel(savedRun), /26\. 09\. 29.*\(31일\)/);
const nextDayCheckout = { checkIn: "2026-09-21", checkOut: "2026-09-22", bookingRangeDays: 31 };
assert.equal(context.dateRangeLabel(nextDayCheckout), "9/21~10/21 (31일)");
assert.equal(context.dateRangeLabel({ ...nextDayCheckout, bookingRangeDays: 1 }), "9/21 기준");
assert.equal(context.dateRangeLabel({ checkIn: "2026-02-30", bookingRangeDays: 31 }), "기간 확인");
assert.equal(context.b2bDateRangeLabel({}), "기간 확인");
context.state.data.run = savedRun;
context.state.data.availability = { items: [complete] };
context.renderReport();
assert.match(context.els.reportBody.innerHTML, /8\/30~9\/29 \(31일\) 숙박일 기준/);
assert.doesNotMatch(context.els.reportBody.innerHTML, /전체 기간 판매율 미확인/);
console.log("Sales observation summary: missing dates, fixed capacity, mixed scope, provider-closed dates, day-use exclusions, conflict, rendered report and consistent stay periods passed");
