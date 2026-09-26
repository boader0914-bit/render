"use strict";

const PRODUCTS = ["lodging", "dayuse"];
const PACE_DAYS = [14, 7, 3, 1];
const LEAD_BINS = [
  { key: "d0_3", label: "0~3일 전", min: 0, max: 3 },
  { key: "d4_7", label: "4~7일 전", min: 4, max: 7 },
  { key: "d8_14", label: "8~14일 전", min: 8, max: 14 },
  { key: "d15_plus", label: "15일 이상 전", min: 15, max: null }
];
const ratio = (value, denominator, digits = 6) => denominator > 0 ? Number((value / denominator).toFixed(digits)) : null;
const sum = (rows, field) => rows.length ? rows.reduce((total, row) => total + row[field], 0) : null;
const ids = rows => [...new Set(rows.map(row => row.runId).filter(Boolean))].sort();
const keyOf = row => JSON.stringify([row.companyId, row.date, row.productType]);
const timeOf = row => Number.isFinite(row.time) ? row.time : Date.parse(row.collectedAt);
const compare = (left, right) => timeOf(left) - timeOf(right) || String(left.tie || left.runId).localeCompare(String(right.tie || right.runId));
const leadOf = row => row.observationLeadTimeDays;
const fullPrice = row => row.revenueEligible === true && !row.revenuePartial
  && [row.estimatedRevenue, row.publicRevenue, row.phoneRevenue].every(value => typeof value === "number" && Number.isFinite(value) && value >= 0);
function strictTimestamp(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/i.test(value)) return null;
  const day = new Date(`${value.slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(day.getTime()) || day.toISOString().slice(0, 10) !== value.slice(0, 10)) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

function metrics(rows, expectedCompanyDays) {
  const revenueRows = rows.filter(row => row.revenueEligible === true);
  const supply = sum(rows, "supply"), sold = sum(rows, "sold");
  return {
    supply, sold, publicBookings: sum(rows, "publicBookings"), phoneBookings: sum(rows, "phoneBookings"),
    estimatedRevenue: sum(revenueRows, "estimatedRevenue"), publicRevenue: sum(revenueRows, "publicRevenue"), phoneRevenue: sum(revenueRows, "phoneRevenue"),
    reservationRate: ratio(sold, supply), coveredCompanyDays: rows.length, expectedCompanyDays,
    coverageRate: ratio(rows.length, expectedCompanyDays), revenueCoveredCompanyDays: revenueRows.length,
    partial: rows.length < expectedCompanyDays || rows.some(row => row.runQuality === "partial"),
    revenuePartial: revenueRows.length < expectedCompanyDays || revenueRows.some(row => row.revenuePartial || row.runQuality === "partial"),
    sourceRunIds: ids(rows)
  };
}

function basisDifference(previous, current) {
  if (previous.supply !== current.supply) return "capacity_changed";
  if (previous.inventoryEvidenceVersion !== current.inventoryEvidenceVersion) return "evidence_version_changed";
  if (previous.sharedDayUseExcluded !== current.sharedDayUseExcluded) return "shared_exclusion_changed";
  if (String(previous.dayUseSharingStatus || "") !== String(current.dayUseSharingStatus || "")) return "sharing_basis_changed";
  const capacity = row => JSON.stringify([row.capacityBasis?.count ?? row.supply, row.capacityBasis?.source || "unspecified"]);
  if (capacity(previous) !== capacity(current)) return "capacity_basis_changed";
  if (String(previous.phoneValuationPolicy || "") !== String(current.phoneValuationPolicy || "")) return "valuation_policy_changed";
  return "";
}

function weightedMedian(events) {
  const total = events.reduce((value, event) => value + event.quantity, 0);
  if (!total) return null;
  const lower = Math.floor((total + 1) / 2), upper = Math.floor(total / 2) + 1;
  let cumulative = 0, low = null, high = null;
  for (const event of [...events].sort((a, b) => a.minDays - b.minDays)) {
    cumulative += event.quantity;
    if (low === null && cumulative >= lower) low = event.minDays;
    if (cumulative >= upper) { high = event.minDays; break; }
  }
  return (low + high) / 2;
}

function pickupChannel(intervals, field) {
  const events = intervals.filter(interval => interval[field] > 0).map(interval => ({
    quantity: interval[field], minDays: interval.currentLeadDays, maxDays: interval.previousLeadDays,
    previousRunId: interval.previousRunId, runId: interval.runId
  }));
  const increase = intervals.length ? intervals.reduce((total, interval) => total + Math.max(0, interval[field]), 0) : null;
  const decrease = intervals.length ? intervals.reduce((total, interval) => total + Math.max(0, -interval[field]), 0) : null;
  const weighted = key => increase > 0 ? Number((events.reduce((total, event) => total + event.quantity * event[key], 0) / increase).toFixed(2)) : null;
  return {
    status: !intervals.length ? "insufficient" : increase > 0 ? "ready" : "no_increase",
    increase, decrease, net: intervals.length ? increase - decrease : null, comparableIntervals: intervals.length,
    actualBookingLeadTime: false,
    leadTime: {
      averageDays: weighted("minDays"), medianDays: weightedMedian(events),
      averageMinDays: weighted("minDays"), averageMaxDays: weighted("maxDays"),
      intervalCrossingPickup: increase > 0 ? events.filter(event => LEAD_BINS.find(bin => event.minDays >= bin.min && (bin.max === null || event.minDays <= bin.max))?.key
        !== LEAD_BINS.find(bin => event.maxDays >= bin.min && (bin.max === null || event.maxDays <= bin.max))?.key).reduce((total, event) => total + event.quantity, 0) : intervals.length ? 0 : null,
      bins: LEAD_BINS.map(bin => {
        const members = events.filter(event => event.minDays >= bin.min && (bin.max === null || event.minDays <= bin.max));
        const pickup = intervals.length ? members.reduce((total, event) => total + event.quantity, 0) : null;
        return { ...bin, pickup, share: ratio(pickup, increase), intervalCrossingPickup: intervals.length
          ? members.filter(event => bin.max !== null && event.maxDays > bin.max).reduce((total, event) => total + event.quantity, 0) : null };
      })
    },
    sourceRunIds: [...new Set(intervals.flatMap(interval => [interval.previousRunId, interval.runId]))].sort()
  };
}

function pickupFor(product, groups) {
  const intervals = [], rejectedByReason = {};
  let observedCompanyDays = 0, comparableCompanyDays = 0, baselinePublicBookings = 0, baselineBlockedBookings = 0;
  let baselineOnlyCompanyDays = 0, offsettingChannelChangeIntervals = 0;
  for (const group of groups.values()) {
    if (group[0].productType !== product) continue;
    observedCompanyDays += 1;
    baselinePublicBookings += group[0].publicBookings;
    baselineBlockedBookings += group[0].phoneBookings;
    let comparisons = 0;
    for (let i = 1; i < group.length; i += 1) {
      const previous = group[i - 1], current = group[i];
      const reason = basisDifference(previous, current);
      if (reason) { rejectedByReason[reason] = (rejectedByReason[reason] || 0) + 1; continue; }
      const publicChange = current.publicBookings - previous.publicBookings;
      const blockedChange = current.phoneBookings - previous.phoneBookings;
      if (publicChange * blockedChange < 0 && publicChange + blockedChange === 0) offsettingChannelChangeIntervals += 1;
      intervals.push({ companyId: current.companyId, companyName: current.companyName, date: current.date,
        previousCollectedAt: previous.collectedAt, collectedAt: current.collectedAt,
        previousLeadDays: leadOf(previous), currentLeadDays: leadOf(current),
        observationGapDays: Number(((timeOf(current) - timeOf(previous)) / 86400000).toFixed(3)),
        publicChange, blockedChange, netChange: publicChange + blockedChange,
        explicitBlockedChange: current.explicitBlockedBookings - previous.explicitBlockedBookings,
        previousRunId: previous.runId, runId: current.runId,
        partialRun: previous.runQuality === "partial" || current.runQuality === "partial" });
      comparisons += 1;
    }
    if (comparisons) comparableCompanyDays += 1;
    else baselineOnlyCompanyDays += 1;
  }
  intervals.sort((a, b) => Date.parse(b.collectedAt) - Date.parse(a.collectedAt) || a.companyId.localeCompare(b.companyId) || a.date.localeCompare(b.date));
  return {
    public: pickupChannel(intervals, "publicChange"), blocked: pickupChannel(intervals, "blockedChange"),
    comparableIntervals: intervals.length, observedCompanyDays, comparableCompanyDays, baselineOnlyCompanyDays,
    baselinePublicBookings: observedCompanyDays ? baselinePublicBookings : null,
    baselineBlockedBookings: observedCompanyDays ? baselineBlockedBookings : null,
    rejectedByReason, offsettingChannelChangeIntervals,
    includesPartialRuns: intervals.some(interval => interval.partialRun),
    recentIntervals: intervals.slice(0, 60), intervalsTruncated: intervals.length > 60
  };
}

function rankVisibility(request, period, companies, sourceRows, runs) {
  const companyMap = new Map(companies.map(company => [company.companyId, company]));
  const runMap = new Map(runs.map(run => [String(run.id || run.runId || ""), run]));
  const daily = new Map();
  for (const row of sourceRows) {
    const companyId = String(row.companyId || row.companyKey || ""), runId = String(row.runId || "");
    const run = runMap.get(runId);
    const quality = String(typeof run?.collectionQuality === "string" ? run.collectionQuality : run?.collectionQuality?.status || "").toLowerCase();
    if (!companyMap.has(companyId) || !["complete", "reused", "partial"].includes(quality)) continue;
    const keyword = String(row.keyword || run.keyword || "");
    if (!keyword || (request.type === "keyword" && keyword !== request.targetId)) continue;
    if (!row.collectedAt && run.collectedAtSource === "filesystem") continue;
    const collectedAt = String(row.collectedAt || run.collectedAt || "");
    const time = strictTimestamp(collectedAt), rank = row.rank == null || typeof row.rank === "boolean" || String(row.rank).trim() === "" ? NaN : Number(row.rank);
    if (time === null || !Number.isInteger(rank) || rank < 1) continue;
    const day = new Date(time + 9 * 3600000).toISOString().slice(0, 10);
    if (day < period.start || day > period.end || day > request.cutoffDate) continue;
    const key = JSON.stringify([companyId, keyword, day]);
    const next = { companyId, keyword, day, rank, runId, collectedAt, time, tie: runId, runQuality: quality };
    if (!daily.has(key) || compare(next, daily.get(key)) > 0) daily.set(key, next);
  }
  const series = new Map();
  for (const row of daily.values()) {
    const key = JSON.stringify([row.companyId, row.keyword]);
    if (!series.has(key)) series.set(key, []);
    series.get(key).push(row);
  }
  if (request.type === "keyword") for (const company of companies) {
    const key = JSON.stringify([company.companyId, request.targetId]);
    if (!series.has(key)) series.set(key, []);
  }
  const rows = [...series.entries()].map(([key, values]) => {
    const [companyId, keyword] = JSON.parse(key);
    const top3Days = values.filter(row => row.rank <= 3).length, top10Days = values.filter(row => row.rank <= 10).length;
    return { companyId, companyName: companyMap.get(companyId).primaryName, keyword,
      status: values.length ? "observed" : "unobserved", observedDays: values.length, calendarDays: period.days,
      meanRank: values.length ? Number((values.reduce((total, row) => total + row.rank, 0) / values.length).toFixed(2)) : null,
      bestRank: values.length ? Math.min(...values.map(row => row.rank)) : null, worstRank: values.length ? Math.max(...values.map(row => row.rank)) : null,
      top3Days: values.length ? top3Days : null, top10Days: values.length ? top10Days : null,
      top3ObservedShare: ratio(top3Days, values.length), top10ObservedShare: ratio(top10Days, values.length),
      observationCoverageRate: ratio(values.length, period.days), missingDays: period.days - values.length,
      includesPartialRuns: values.some(row => row.runQuality === "partial"), sourceRunIds: ids(values) };
  }).sort((a, b) => a.companyName.localeCompare(b.companyName) || a.keyword.localeCompare(b.keyword));
  return { rows, dailyObservationCount: daily.size, collectionDates: [...new Set([...daily.values()].map(row => row.day))].sort(),
    sourceRunIds: ids([...daily.values()]), basis: "latest_per_company_keyword_kst_day_observed_share" };
}

function companyPriceDistribution(rows) {
  const totals = new Map();
  for (const row of rows) {
    if (!totals.has(row.companyId)) totals.set(row.companyId, { revenue: 0, sold: 0 });
    const company = totals.get(row.companyId);
    company.revenue += row.estimatedRevenue;
    company.sold += row.sold;
  }
  const prices = [...totals.values()].filter(company => company.sold > 0).map(company => company.revenue / company.sold).sort((a, b) => a - b);
  const middle = Math.floor(prices.length / 2);
  const rounded = value => value === null ? null : Number(value.toFixed(2));
  const median = !prices.length ? null : prices.length % 2 ? prices[middle] : (prices[middle - 1] + prices[middle]) / 2;
  const bands = [
    { label: "10만원 미만", min: 0, max: 100000 },
    { label: "10~20만원 미만", min: 100000, max: 200000 },
    { label: "20~30만원 미만", min: 200000, max: 300000 },
    { label: "30만원 이상", min: 300000, max: Infinity }
  ];
  return { companyCount: prices.length, medianUnitPrice: rounded(median), minUnitPrice: rounded(prices[0] ?? null), maxUnitPrice: rounded(prices.at(-1) ?? null),
    bands: bands.map(band => ({ label: band.label, companyCount: prices.filter(price => price >= band.min && price < band.max).length })) };
}

function holidayGroups(dates, selected, companyCount, specialDays) {
  const years = new Map((Array.isArray(specialDays?.years) ? specialDays.years : []).map(year => [Number(year.year), year]));
  const holidayDates = new Map();
  for (const year of years.values()) if (year.status === "ready") {
    for (const holiday of Array.isArray(year.holidays) ? year.holidays : []) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(String(holiday.date || "")) && Number(holiday.date.slice(0, 4)) === Number(year.year)) holidayDates.set(holiday.date, String(holiday.name || "공휴일"));
    }
  }
  const groups = new Map([["holiday", []], ["holiday_eve", []], ["ordinary", []], ["unclassified", []]]);
  const neededYears = new Set();
  for (const date of dates) {
    const next = new Date(Date.parse(`${date}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
    const year = Number(date.slice(0, 4)), nextYear = Number(next.slice(0, 4));
    neededYears.add(year);
    neededYears.add(nextYear);
    if (years.get(year)?.status !== "ready") groups.get("unclassified").push(date);
    else if (holidayDates.has(date)) groups.get("holiday").push(date);
    else if (years.get(nextYear)?.status !== "ready") groups.get("unclassified").push(date);
    else if (holidayDates.has(next)) groups.get("holiday_eve").push(date);
    else groups.get("ordinary").push(date);
  }
  const missingYears = [...neededYears].filter(year => years.get(year)?.status !== "ready").sort();
  const labels = { holiday: "공휴일", holiday_eve: "공휴일 전날", ordinary: "그 외 날짜", unclassified: "달력 근거 미확인" };
  const classifiedDays = dates.length - groups.get("unclassified").length;
  return {
    status: missingYears.length ? classifiedDays ? "partial" : "unavailable" : "ready", classifiedDays, missingYears,
    sourceYears: [...neededYears].sort().map(year => ({ year, status: years.get(year)?.status || "missing", updatedAt: years.get(year)?.updatedAt || null })),
    rows: [...groups].filter(([, values]) => values.length).map(([key, values]) => {
      const days = new Set(values), rows = selected.filter(row => days.has(row.date));
      return { key, label: labels[key], calendarDays: values.length,
        dates: values.map(date => ({ date, name: key === "holiday" ? holidayDates.get(date) : "" })),
        ...Object.fromEntries(PRODUCTS.map(product => [product, metrics(rows.filter(row => row.productType === product), values.length * companyCount)])) };
    })
  };
}

function buildMonthlyReportInsights({ request, period, companies = [], observations = [], selected = [], rankObservations = [], runs = [], specialDays = null }) {
  const groups = new Map();
  for (const row of observations) {
    if (!PRODUCTS.includes(row.productType) || !Number.isFinite(timeOf(row)) || !Number.isInteger(leadOf(row)) || leadOf(row) < 0) continue;
    const key = keyOf(row);
    if (!groups.has(key)) groups.set(key, new Map());
    const times = groups.get(key), time = timeOf(row);
    // Different keywords can see the same inventory at the same instant. Keep
    // one deterministic observation before forming adjacent changes.
    if (!times.has(time) || compare(row, times.get(time)) > 0) times.set(time, row);
  }
  for (const [key, times] of groups) groups.set(key, [...times.values()].sort(compare));
  const expectedCompanyDays = companies.length * period.days;
  const pickup = Object.fromEntries(PRODUCTS.map(product => [product, pickupFor(product, groups)]));
  const pace = Object.fromEntries(PRODUCTS.map(product => [product, PACE_DAYS.map(leadDays => {
    const rows = [];
    for (const group of groups.values()) {
      if (group[0].productType !== product) continue;
      const exact = group.filter(row => leadOf(row) === leadDays).at(-1);
      if (exact) rows.push(exact);
    }
    return { leadDays, ...metrics(rows, expectedCompanyDays), interpolation: false };
  })]));
  const dates = Array.from({ length: period.days }, (_, i) => `${request.month}-${String(i + 1).padStart(2, "0")}`);
  const weekdayIds = [1, 2, 3, 4, 5, 6, 0], labels = ["일", "월", "화", "수", "목", "금", "토"];
  const weekdayOf = date => new Date(`${date}T00:00:00Z`).getUTCDay();
  const weekdays = Object.fromEntries(PRODUCTS.map(product => [product, weekdayIds.map(dayOfWeek => {
    const monthDays = dates.filter(date => weekdayOf(date) === dayOfWeek).length;
    const rows = selected.filter(row => row.productType === product && weekdayOf(row.date) === dayOfWeek);
    return { dayOfWeek, label: labels[dayOfWeek], calendarDays: monthDays, ...metrics(rows, monthDays * companies.length) };
  })]));
  const pricing = Object.fromEntries(PRODUCTS.map(product => {
    const observed = selected.filter(row => row.productType === product);
    const valued = observed.filter(fullPrice);
    const estimatedRevenue = sum(valued, "estimatedRevenue"), pricedSupply = sum(valued, "supply"), pricedSold = sum(valued, "sold");
    return [product, { pricedCompanyDays: valued.length, expectedCompanyDays, pricedSupply, pricedSold, estimatedRevenue,
      publicRevenue: sum(valued, "publicRevenue"), blockedRevenue: sum(valued, "phoneRevenue"),
      estimatedPerSoldUnit: ratio(estimatedRevenue, pricedSold, 2), estimatedPerSupplyUnit: ratio(estimatedRevenue, pricedSupply, 2),
      priceCoverageRate: ratio(valued.length, expectedCompanyDays), observedPriceCoverageRate: ratio(valued.length, observed.length),
      excludedPriceCompanyDays: observed.length - valued.length,
      containsFallbackPrice: valued.some(row => row.phoneFallbackRevenue > 0), includesPartialRuns: valued.some(row => row.runQuality === "partial"),
      actualRevenue: null, sourceRunIds: ids(valued),
      ...(product === "lodging" ? { companyDistribution: companyPriceDistribution(valued) } : {}) }];
  }));
  const regions = new Map();
  for (const company of companies) {
    const regionKey = company.regionKey || "unmapped";
    if (!regions.has(regionKey)) regions.set(regionKey, { regionKey, regionLabel: company.regionLabel || (company.regionKey ? company.regionKey : "지역 확인 전"), companies: [] });
    regions.get(regionKey).companies.push(company.companyId);
  }
  const geography = { basis: "current_company_region", rows: [...regions.values()].map(region => {
    const memberIds = new Set(region.companies), rows = selected.filter(row => memberIds.has(row.companyId));
    return { regionKey: region.regionKey, regionLabel: region.regionLabel, companyCount: memberIds.size,
      ...Object.fromEntries(PRODUCTS.map(product => [product, metrics(rows.filter(row => row.productType === product), memberIds.size * period.days)])) };
  }).sort((a, b) => a.regionLabel.localeCompare(b.regionLabel)) };
  const ranking = rankVisibility(request, period, companies, rankObservations, runs);
  const sourceRunIds = [...new Set([...ids(observations), ...ranking.sourceRunIds])].sort();
  const capacities = companies.filter(company => Number.isInteger(company.capacity) && company.capacity >= 0);
  const collectionDates = new Set(ranking.collectionDates);
  for (const group of groups.values()) for (const row of group) collectionDates.add(new Date(timeOf(row) + 9 * 3600000).toISOString().slice(0, 10));
  const lodging = selected.filter(row => row.productType === "lodging"), lodgingSold = sum(lodging, "sold");
  const overview = { companyCount: companies.length, knownCapacityCompanyCount: capacities.length,
    totalRooms: capacities.length ? capacities.reduce((total, company) => total + company.capacity, 0) : null,
    capacityComplete: companies.length > 0 && capacities.length === companies.length, collectionDateCount: collectionDates.size,
    publicBookingShare: ratio(sum(lodging, "publicBookings"), lodgingSold), blockedBookingShare: ratio(sum(lodging, "phoneBookings"), lodgingSold) };
  return {
    schemaVersion: 1, overview, pickup, pace, weekdays, pricing, geography, rankVisibility: ranking,
    calendarGroups: holidayGroups(dates, selected, companies.length, specialDays), sourceRunIds,
    definitions: {
      overview: "객실 기준 총량은 업체별 DB 보정값을 우선하고 없으면 최대 관측 추정값을 한 번씩 합산하며 월간 공급 실·박과 구분합니다. 기준값이 없는 업체가 있으면 일부 업체의 소계입니다. 수집일 수는 유효 재고·순위 근거의 서로 다른 한국시간 날짜 수로 투숙 월 이전 관측도 포함합니다. 공개예약·방막기 비중은 숙박의 유효 판매 추정 수량 중 비중이며 실제 예약 채널 점유율이 아닙니다.",
      pickup: "동일 업체·숙박일·상품유형의 연속 유효 관측에서 공개예약과 방막기 추정의 증가·감소를 따로 계산합니다. 감소는 취소 확정 건수가 아니며 서로 상쇄되는 변화는 채널 분류 변화일 수 있습니다.",
      leadTime: "증가를 확인한 시점의 숙박일 전 일수로 가중 평균·중앙값을 계산합니다. 실제 예약 시각은 알 수 없으며 평균 최소~최대는 직전·현재 관측 사이의 발생 가능 구간입니다. 최초 관측에 이미 있던 수량과 마지막 관측 이후 변화는 포함하지 않습니다.",
      leadBins: "리드타임 구간은 증가를 확인한 현재 관측일 기준입니다. 관측 간격이 구간 경계를 넘은 수량은 별도로 표시하며 정확한 예약 구간으로 단정하지 않습니다.",
      basisGuard: "공급 수량·공급 근거·재고 근거 버전·공유 제외 수량·공유 상태·가격 산정 정책이 바뀐 두 관측은 증감 비교에서 제외합니다.",
      pace: "D-14·D-7·D-3·D-1의 한국시간 당일 관측이 있는 업체·숙박일만 사용합니다. 빈 구간을 보간하거나 다른 날짜의 관측으로 채우지 않습니다. D별 관측 업체·숙박일 집합이 다를 수 있으므로 두 지점의 차이를 직접 예약 픽업으로 해석하지 않습니다.",
      weekdays: "월간 숙박일의 요일별 유효 판매 추정 수량 합계 ÷ 동일 관측의 공급 수량 합계입니다. 날짜별 비율을 단순 평균하지 않습니다. 예상액은 월간 합계와 같은 가격 확인 금액 소계이며 부분 가격 근거는 별도로 표시합니다.",
      pricing: "가격 근거가 모두 확인된 동일 업체·숙박일 집합에서 예상액 ÷ 판매 추정 실·박, 예상액 ÷ 관측 공급 실·박을 계산합니다. 가격 미확인 표본은 두 분모에서도 제외하며 실제 ADR·RevPAR가 아닙니다.",
      companyDistribution: "업체별로 가격 근거가 모두 확인된 숙박 관측의 예상액 합계 ÷ 같은 관측의 판매 추정 실·박 합계를 계산하고, 판매가 있는 업체에 같은 가중치를 주어 중앙값·범위·가격대 분포를 표시합니다. 미확인 가격과 판매 0인 업체는 제외합니다. 게시 객실 요금이나 실제 ADR이 아닌 추정 예약 단가입니다.",
      geography: "검색 키워드에 포함된 지명이 아니라 업체 DB의 현재 확인된 지역으로 묶습니다. 지역 미확인 업체는 별도 표시합니다.",
      calendarGroups: "저장된 공휴일 달력으로 공휴일·공휴일 전날·그 외 날짜를 겹치지 않게 구분합니다. 연말 다음 해 달력을 포함해 근거가 없으면 미확인으로 남기며, 공휴일인 날짜는 전날 분류보다 우선합니다.",
      ranks: "동일 업체·키워드·한국시간 날짜마다 마지막 유효 순위를 한 번 사용합니다. 평균·최고·최저 및 3위/10위 이내 비중의 분모는 순위가 관측된 날이며, 미관측은 순위 이탈로 처리하지 않습니다."
    }
  };
}

module.exports = { buildMonthlyReportInsights };
