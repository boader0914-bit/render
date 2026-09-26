"use strict";

const assert = require("node:assert/strict");
const { buildMonthlyReportSnapshot } = require("./lib/monthly_reports.cjs");

const companies = [
  { companyId: "a", primaryName: "동쪽 숙소", regionKey: "real-east", regionLabel: "실제 동쪽", keywords: ["서쪽여행"], capacity: 10 },
  { companyId: "b", primaryName: "북쪽 숙소", regionKey: "real-north", regionLabel: "실제 북쪽", keywords: ["서쪽여행"], capacity: 2 },
  { companyId: "c", primaryName: "미확인 숙소", keywords: ["서쪽여행"] }
];
const request = { month: "2026-09", type: "keyword", targetId: "서쪽여행", cutoffDate: "2026-09-30" };
const run = (id, status = "complete") => ({ id, keyword: "서쪽여행", collectionQuality: { status }, collectedAt: "2026-08-01T00:00:00Z" });
const make = (date, lead, publicBookings, phoneBookings, extra = {}) => {
  const collected = new Date(Date.parse(`${date}T00:00:00Z`) - lead * 86400000).toISOString();
  const { revenue, ...rest } = extra;
  const sold = publicBookings + phoneBookings;
  return { companyId: "a", companyKey: "a", companyName: "동쪽 숙소", productType: "lodging", keyword: "서쪽여행",
    stayDate: date, collectedAt: collected, runId: `r${date}_${lead}`, inventoryEvidenceVersion: 4,
    supply: 10, sold, publicBookings, phoneBookings,
    publicRevenue: publicBookings * 100, phoneRevenue: phoneBookings * 100, estimatedRevenue: revenue ?? sold * 100,
    phonePricedBookings: phoneBookings, phoneMissingPriceBookings: 0, sharedDayUseExcluded: 0,
    explicitBlockedBookings: 0, capacityBasis: { count: 10, source: "db_correction", observedMaximum: 9 },
    phoneValuationPolicy: "same_product_observed_price_v1", ...rest };
};
const rows = [
  make("2026-09-20", 14, 1, 1),
  make("2026-09-20", 7, 3, 2),
  make("2026-09-20", 3, 2, 3),
  make("2026-09-20", 1, 4, 2),
  // Identical observation copied from a second run is not an extra pickup.
  make("2026-09-20", 7, 3, 2, { runId: "same-time-copy" }),
  // A failed response must not create a false positive after a fabricated zero.
  make("2026-09-20", 4, 0, 0, { runId: "failed" }),
  make("2026-09-20", 5, 0, 0, { missing: true }),
  // Room count changes break comparison even when the calendar pair matches.
  make("2026-09-21", 14, 1, 0),
  make("2026-09-21", 7, 2, 0, { supply: 12, capacityBasis: { count: 12, source: "db_correction" } }),
  // Shared exclusion and evidence changes also break inferred pickup.
  make("2026-09-22", 7, 1, 1),
  make("2026-09-22", 3, 3, 1, { sharedDayUseExcluded: 1 }),
  make("2026-09-23", 7, 1, 1),
  make("2026-09-23", 3, 3, 1, { inventoryEvidenceVersion: 3 }),
  make("2026-09-24", 7, 1, 1),
  make("2026-09-24", 3, 2, 1, { capacityBasis: { count: 10, source: "observed_maximum" } }),
  // Changes to raw maximum do not invalidate an unchanged effective basis.
  make("2026-09-25", 7, 0, 0),
  make("2026-09-25", 3, 1, 0, { capacityBasis: { count: 10, source: "db_correction", observedMaximum: 10, currentObservedMaximum: 10 } }),
  // Another company on the same Sunday proves weighted rates, not mean rates.
  make("2026-09-20", 0, 1, 0, { companyId: "b", companyKey: "b", supply: 2, capacityBasis: { count: 2, source: "db_correction" } }),
  // This unpriced row cannot enter either pricing numerator or denominator.
  make("2026-09-27", 0, 2, 2, { companyId: "b", companyKey: "b", publicRevenue: 200, phoneRevenue: 0, revenue: 200, phonePricedBookings: 0, phoneMissingPriceBookings: 2 }),
  make("2026-09-20", 0, 2, 0, { productType: "dayuse", supply: 3, publicRevenue: 80, phoneRevenue: 0, revenue: 80, dayUseScheduleStatus: "requested" }),
  // An observed zero is eligible but does not divide by zero sold rooms.
  make("2026-09-26", 0, 0, 0)
];
const runMap = new Map(rows.map(row => [row.runId, run(row.runId)]));
runMap.set("failed", run("failed", "failed"));
runMap.set("blocked", run("blocked", "blocked"));
for (const id of ["rank1", "rank2", "rank3", "rank-old", "rankfuture", "rankzero"]) runMap.set(id, run(id));
const ranks = [
  { companyId: "a", runId: "rank1", keyword: "서쪽여행", rank: 20, collectedAt: "2026-09-01T00:00:00Z" },
  { companyId: "a", runId: "rank2", keyword: "서쪽여행", rank: 2, collectedAt: "2026-09-01T05:00:00Z" },
  { companyId: "a", runId: "rank3", keyword: "서쪽여행", rank: 8, collectedAt: "2026-09-02T00:00:00Z" },
  { companyId: "a", runId: "rank-old", keyword: "서쪽여행", rank: 1, collectedAt: "2026-08-31T00:00:00Z" },
  { companyId: "a", runId: "rankfuture", keyword: "서쪽여행", rank: 1, collectedAt: "2026-10-01T00:00:00Z" },
  { companyId: "a", runId: "rankzero", keyword: "서쪽여행", rank: 0, collectedAt: "2026-09-03T00:00:00Z" },
  { companyId: "a", runId: "rankzero", keyword: "서쪽여행", rank: null, collectedAt: "2026-09-03T00:00:00Z" },
  { companyId: "a", runId: "rankzero", keyword: "서쪽여행", rank: true, collectedAt: "2026-09-03T00:00:00Z" },
  { companyId: "a", runId: "blocked", keyword: "서쪽여행", rank: 1, collectedAt: "2026-09-03T00:00:00Z" },
  { companyId: "c", runId: "rank3", keyword: "서쪽여행", rank: 12, collectedAt: "2026-09-02T00:00:00Z" }
];
const source = { companies, observations: rows, rankObservations: ranks, runs: [...runMap.values()],
  specialDays: { years: [{ year: 2026, status: "ready", updatedAt: "2026-08-01T00:00:00Z", holidays: [{ date: "2026-09-25", name: "검증 공휴일" }, { date: "2026-09-26", name: "연속 공휴일" }] }] } };
const snapshot = buildMonthlyReportSnapshot(request, source, "2026-10-01T00:00:00Z");
const insights = snapshot.insights;
assert.deepEqual(insights.overview, { companyCount: 3, knownCapacityCompanyCount: 2, totalRooms: 12, capacityComplete: false,
  collectionDateCount: 16, publicBookingShare: 0.72, blockedBookingShare: 0.28 }, "capacity counts each selected company once, including unobserved roster companies without inventing rooms");
assert.equal(insights.pickup.lodging.public.increase, 5);
assert.equal(insights.pickup.lodging.public.decrease, 1);
assert.equal(insights.pickup.lodging.public.net, 4);
assert.equal(insights.pickup.lodging.blocked.increase, 2);
assert.equal(insights.pickup.lodging.blocked.decrease, 1);
assert.equal(insights.pickup.lodging.comparableIntervals, 4);
assert.equal(insights.pickup.lodging.offsettingChannelChangeIntervals, 1);
assert.equal(insights.pickup.lodging.public.leadTime.averageDays, 3.8);
assert.equal(insights.pickup.lodging.public.leadTime.medianDays, 3);
assert.equal(insights.pickup.lodging.public.leadTime.averageMaxDays, 8.2);
assert.equal(insights.pickup.lodging.public.actualBookingLeadTime, false);
assert.equal(insights.pickup.lodging.public.leadTime.intervalCrossingPickup, 3);
assert.equal(insights.pickup.lodging.public.leadTime.bins.find(row => row.key === "d0_3").pickup, 3);
assert.equal(insights.pickup.lodging.rejectedByReason.capacity_changed, 1);
assert.equal(insights.pickup.lodging.rejectedByReason.shared_exclusion_changed, 1);
assert.equal(insights.pickup.lodging.rejectedByReason.evidence_version_changed, 1);
assert.equal(insights.pickup.lodging.rejectedByReason.capacity_basis_changed, 1);
assert.equal(insights.pickup.dayuse.public.increase, null, "one observation never invents an initial pickup");
assert.equal(insights.pickup.dayuse.public.status, "insufficient");
assert.equal(insights.pace.lodging.find(row => row.leadDays === 14).coveredCompanyDays, 2);
assert.equal(insights.pace.lodging.find(row => row.leadDays === 14).expectedCompanyDays, 90);
assert.equal(insights.pace.lodging.find(row => row.leadDays === 1).coveredCompanyDays, 1);
assert.equal(insights.pace.dayuse.find(row => row.leadDays === 14).sold, null, "D-day pace never interpolates from another observation day");
const sunday = insights.weekdays.lodging.find(row => row.dayOfWeek === 0);
assert.equal(sunday.supply, 22);
assert.equal(sunday.sold, 11);
assert.equal(sunday.reservationRate, 0.5, "weekday rates use summed supply as denominator");
assert.equal(sunday.coveredCompanyDays, 3);
assert.equal(insights.weekdays.lodging.reduce((total, row) => total + (row.estimatedRevenue || 0), 0), snapshot.summary.lodging.estimatedRevenue, "weekday monetary subtotals reconcile to the same monthly evidence policy");
assert.equal(insights.geography.rows.reduce((total, row) => total + (row.lodging.estimatedRevenue || 0), 0), snapshot.summary.lodging.estimatedRevenue, "actual region subtotals reconcile to monthly revenue");
assert.equal(insights.pricing.lodging.excludedPriceCompanyDays, 1);
const valued = snapshot.sources.observations.filter(row => row.productType === "lodging" && row.revenueEligible && !row.revenuePartial);
const valuedSold = valued.reduce((total, row) => total + row.sold, 0), valuedSupply = valued.reduce((total, row) => total + row.supply, 0), valuedRevenue = valued.reduce((total, row) => total + row.estimatedRevenue, 0);
assert.equal(insights.pricing.lodging.pricedSold, valuedSold);
assert.equal(insights.pricing.lodging.pricedSupply, valuedSupply);
assert.equal(insights.pricing.lodging.estimatedPerSoldUnit, 100, "unpriced quantities do not dilute observed estimated per-sold value");
assert.equal(insights.pricing.lodging.estimatedPerSupplyUnit, Number((valuedRevenue / valuedSupply).toFixed(2)));
assert.equal(insights.pricing.dayuse.estimatedPerSoldUnit, 40, "day-use money and units remain separate");
assert.equal(insights.pricing.lodging.companyDistribution.companyCount, 2);
assert.equal(insights.pricing.lodging.companyDistribution.medianUnitPrice, 100, "partially priced days do not dilute a company's unit price");
assert.deepEqual(insights.geography.rows.map(row => row.regionKey).sort(), ["real-east", "real-north", "unmapped"]);
assert.equal(insights.geography.rows.find(row => row.regionKey === "unmapped").lodging.sold, null);
const rankA = insights.rankVisibility.rows.find(row => row.companyId === "a");
assert.equal(rankA.observedDays, 2);
assert.equal(rankA.meanRank, 5, "rank analysis deduplicates the same KST observation day");
assert.equal(rankA.bestRank, 2);
assert.equal(rankA.worstRank, 8);
assert.equal(rankA.top3ObservedShare, 0.5);
assert.equal(rankA.top10ObservedShare, 1, "missing ranks never become exits from top ten");
assert.equal(rankA.missingDays, 28);
assert.equal(insights.rankVisibility.rows.find(row => row.companyId === "b").meanRank, null);
assert.equal(insights.calendarGroups.status, "ready");
assert.equal(insights.calendarGroups.rows.find(row => row.key === "holiday").calendarDays, 2);
assert.equal(insights.calendarGroups.rows.find(row => row.key === "holiday_eve").calendarDays, 1, "consecutive holiday does not also count as its next holiday's eve");
assert.ok(insights.sourceRunIds.includes("rank2"));
assert.ok(!insights.sourceRunIds.includes("failed"));
assert.ok(!insights.sourceRunIds.includes("blocked"));
assert.ok(insights.definitions.pace.includes("집합이 다를 수"));

const invalidRankDate = buildMonthlyReportSnapshot({ ...request, type: "company", targetId: "a", month: "2026-03", cutoffDate: "2026-03-31" }, {
  ...source, observations: [], rankObservations: [
    { companyId: "a", runId: "rank1", keyword: "서쪽여행", rank: 1, collectedAt: "2026-02-30T00:00:00Z" },
    { companyId: "a", runId: "rank2", keyword: "서쪽여행", rank: 1, collectedAt: "2026-03-01T24:00:00Z" }
  ]
}, "2026-04-01T00:00:00Z");
assert.equal(invalidRankDate.insights.rankVisibility.dailyObservationCount, 0, "invalid calendar dates and rollover hours never enter rank statistics");
assert.equal(invalidRankDate.insights.overview.collectionDateCount, 0);

const decemberRequest = { ...request, month: "2026-12", cutoffDate: "2026-12-31" };
const december = buildMonthlyReportSnapshot(decemberRequest, { ...source, observations: [], rankObservations: [], specialDays: { years: [{ year: 2026, status: "ready", holidays: [] }] } }, "2027-01-02T00:00:00Z");
assert.equal(december.insights.calendarGroups.status, "partial");
assert.deepEqual(december.insights.calendarGroups.missingYears, [2027]);
assert.equal(december.insights.calendarGroups.rows.find(row => row.key === "unclassified").calendarDays, 1);
const withNextYear = buildMonthlyReportSnapshot(decemberRequest, { ...source, observations: [], rankObservations: [], specialDays: { years: [
  { year: 2026, status: "ready", holidays: [] }, { year: 2027, status: "ready", holidays: [{ date: "2027-01-01", name: "새해" }] }
] } }, "2027-01-02T00:00:00Z");
assert.equal(withNextYear.insights.calendarGroups.rows.find(row => row.key === "holiday_eve").dates[0].date, "2026-12-31");
assert.equal(withNextYear.insights.pricing.lodging.estimatedPerSoldUnit, null);
assert.equal(withNextYear.insights.pickup.lodging.public.increase, null);
assert.equal(withNextYear.insights.overview.totalRooms, null, "an empty roster has unknown capacity, not a fabricated zero");
assert.equal(withNextYear.insights.overview.publicBookingShare, null);
assert.equal(withNextYear.insights.pricing.lodging.companyDistribution.medianUnitPrice, null);

const priceCompanies = ["a", "b", "c", "d", "e", "f"].map(companyId => ({ companyId, primaryName: companyId, regionKey: "price-region", capacity: 10 }));
const priceRow = (companyId, price, sold, date = "2026-09-20") => make(date, 0, sold, 0, {
  companyId, companyKey: companyId, runId: `price-${companyId}-${date}`, publicRevenue: price * sold, revenue: price * sold
});
const priceRows = [priceRow("a", 10000, 1), priceRow("a", 10000, 1, "2026-09-21"), priceRow("b", 100000, 1),
  priceRow("c", 200000, 1), priceRow("d", 400000, 9),
  make("2026-09-20", 0, 0, 1, { companyId: "e", companyKey: "e", runId: "unpriced", phoneRevenue: 0, revenue: 0, phonePricedBookings: 0, phoneMissingPriceBookings: 1 }),
  priceRow("f", 10000, 0)];
const priceSnapshot = buildMonthlyReportSnapshot({ ...request, type: "region", targetId: "price-region" }, {
  companies: priceCompanies, observations: priceRows, runs: priceRows.map(row => run(row.runId))
}, "2026-10-01T00:00:00Z");
assert.deepEqual(priceSnapshot.insights.pricing.lodging.companyDistribution, {
  companyCount: 4, medianUnitPrice: 150000, minUnitPrice: 10000, maxUnitPrice: 400000,
  bands: [{ label: "10만원 미만", companyCount: 1 }, { label: "10~20만원 미만", companyCount: 1 },
    { label: "20~30만원 미만", companyCount: 1 }, { label: "30만원 이상", companyCount: 1 }]
}, "company distribution gives each priced company one vote, keeps band boundaries disjoint and excludes zero/unpriced sold cohorts");
assert.equal(priceSnapshot.insights.overview.totalRooms, 60, "room count never multiplies by repeated stay days");
assert.equal(priceSnapshot.insights.overview.capacityComplete, true);
assert.equal(priceSnapshot.insights.overview.collectionDateCount, 2, "different companies collected on one KST date count as one collection day");
const unknownCapacity = buildMonthlyReportSnapshot({ ...request, type: "company", targetId: "c" }, { companies }, "2026-10-01T00:00:00Z");
assert.equal(unknownCapacity.insights.overview.totalRooms, null);
assert.equal(unknownCapacity.insights.overview.capacityComplete, false);
console.log("Monthly report insights: guarded pickup and lead intervals, exact D-day pace, weighted weekdays, matched pricing cohort and company distribution, unique capacity, actual geography, daily ranks and cached holiday boundaries passed");
