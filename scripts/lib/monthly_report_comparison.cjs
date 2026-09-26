"use strict";

// Compare saved observations only. Keep changing market membership separate from
// changes within a cohort; a missing observation is never a zero sale or an exit.
const DAYS = 86400000;
const fields = ["supply", "sold", "publicBookings", "phoneBookings"];
const revenueFields = ["estimatedRevenue", "publicRevenue", "phoneRevenue"];
const known = value => value !== null && value !== undefined && Number.isFinite(value);
const total = (rows, field) => rows.length && rows.every(row => known(row[field])) ? rows.reduce((sum, row) => sum + row[field], 0) : null;
const divide = (a, b) => known(a) && b > 0 ? a / b : null;
const monthDays = month => new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate();
function precedingMonth(month) {
  const [year, part] = month.split("-").map(Number);
  return new Date(Date.UTC(year, part - 2, 1)).toISOString().slice(0, 7);
}
function priorRequest(request) {
  const month = precedingMonth(request.month);
  const cutoffMonth = precedingMonth(request.cutoffDate.slice(0, 7));
  const shifted = `${cutoffMonth}-${String(Math.min(Number(request.cutoffDate.slice(8)), monthDays(cutoffMonth))).padStart(2, "0")}`;
  return { ...request, month, cutoffDate: [shifted, `${month}-${monthDays(month)}`].sort()[0] };
}
function observations(snapshot) {
  return (snapshot.sources?.observations || []).filter(row => row.productType === "lodging");
}
function summarize(rows, ids, month) {
  const valued = rows.filter(row => row.revenueEligible && revenueFields.every(field => known(row[field])));
  const expectedCompanyDays = ids.size * monthDays(month);
  const sums = Object.fromEntries(fields.map(field => [field, total(rows, field)]));
  return { companyCount: ids.size, monthDays: monthDays(month), coveredCompanyDays: rows.length,
    expectedCompanyDays, coverageRate: divide(rows.length, expectedCompanyDays), ...sums,
    reservationRate: divide(sums.sold, sums.supply),
    ...Object.fromEntries(revenueFields.map(field => [field, total(valued, field)])),
    revenueCoveredCompanyDays: valued.length, revenueCoverageRate: divide(valued.length, expectedCompanyDays) };
}
function signature(value) {
  if (!value) return "";
  return JSON.stringify([value.count ?? null, value.source || ""]);
}
const lead = row => known(row.observationLeadTimeDays) ? row.observationLeadTimeDays
  : Math.round((Date.parse(`${row.date}T00:00:00Z`) - Date.parse(`${row.collectedDate}T00:00:00Z`)) / DAYS);
function buildMonthlyComparison(current, previous) {
  const currentMonth = current.request.month, previousMonth = previous.request.month;
  const currentRows = observations(current), previousRows = observations(previous);
  const currentIds = new Set(currentRows.map(row => row.companyId));
  const previousIds = new Set(previousRows.map(row => row.companyId));
  const currentRoster = new Set((current.companies || []).map(company => company.companyId));
  const previousRoster = new Set((previous.companies || []).map(company => company.companyId));
  currentIds.forEach(id => currentRoster.add(id)); previousIds.forEach(id => previousRoster.add(id));
  const commonIds = new Set([...currentIds].filter(id => previousIds.has(id)));
  const currentCommon = currentRows.filter(row => commonIds.has(row.companyId));
  const previousCommon = previousRows.filter(row => commonIds.has(row.companyId));
  const previousByDay = new Map(previousCommon.map(row => [`${row.companyId}|${row.date.slice(8)}`, row]));
  const matchedCurrent = [], matchedPrevious = [], revenueCurrent = [], revenuePrevious = [];
  const exclusions = { missingCorrespondingDay: 0, capacityOrSharingChanged: 0, observationTimingChanged: 0 };
  const matchedPreviousKeys = new Set();
  for (const row of currentCommon) {
    const key = `${row.companyId}|${row.date.slice(8)}`;
    const old = previousByDay.get(key);
    if (!old) { exclusions.missingCorrespondingDay++; continue; }
    if (row.supply !== old.supply || (row.sharedDayUseExcluded || 0) !== (old.sharedDayUseExcluded || 0)
      || row.inventoryEvidenceVersion !== old.inventoryEvidenceVersion || signature(row.capacityBasis) !== signature(old.capacityBasis)
      || String(row.dayUseSharingStatus || "") !== String(old.dayUseSharingStatus || "")
      || String(row.phoneValuationPolicy || "") !== String(old.phoneValuationPolicy || "")) {
      exclusions.capacityOrSharingChanged++; continue;
    }
    if (!known(lead(row)) || lead(row) !== lead(old)) { exclusions.observationTimingChanged++; continue; }
    matchedCurrent.push(row); matchedPrevious.push(old); matchedPreviousKeys.add(key);
    if (row.revenueEligible && old.revenueEligible && !row.revenuePartial && !old.revenuePartial
      && revenueFields.every(field => known(row[field]) && known(old[field]))) {
      revenueCurrent.push(row); revenuePrevious.push(old);
    }
  }
  const pairedIds = new Set(matchedCurrent.map(row => row.companyId));
  const pairedCurrent = summarize(matchedCurrent, pairedIds, currentMonth);
  const pairedPrevious = summarize(matchedPrevious, pairedIds, previousMonth);
  // Money changes must use exactly the same pairs, even if one month alone has
  // more usable prices. The unpaired observed subtotals remain in all/common.
  for (const field of revenueFields) {
    pairedCurrent[field] = total(revenueCurrent, field); pairedPrevious[field] = total(revenuePrevious, field);
  }
  pairedCurrent.revenueCoveredCompanyDays = pairedPrevious.revenueCoveredCompanyDays = revenueCurrent.length;
  pairedCurrent.revenueCoverageRate = divide(revenueCurrent.length, pairedCurrent.expectedCompanyDays);
  pairedPrevious.revenueCoverageRate = divide(revenuePrevious.length, pairedPrevious.expectedCompanyDays);
  const delta = field => known(pairedCurrent[field]) && known(pairedPrevious[field]) ? pairedCurrent[field] - pairedPrevious[field] : null;
  const matched = { companyCount: pairedIds.size, companyDays: matchedCurrent.length,
    excludedCompanyDays: currentCommon.length - matchedCurrent.length,
    previousExcludedCompanyDays: previousCommon.length - matchedPreviousKeys.size,
    exclusions, current: pairedCurrent, previous: pairedPrevious,
    deltas: { sold: delta("sold"), publicBookings: delta("publicBookings"), phoneBookings: delta("phoneBookings"),
      estimatedRevenue: delta("estimatedRevenue"), reservationRatePoints: known(delta("reservationRate")) ? Number((delta("reservationRate") * 100).toFixed(6)) : null,
      estimatedRevenueRate: divide(delta("estimatedRevenue"), pairedPrevious.estimatedRevenue) } };
  const warnings = ["전체 현황은 키워드·지역에서 확보된 표본의 소계이며 지역 전체 시장 규모가 아닙니다.",
    "공통 업체 증감은 양월의 같은 업체·월중 날짜에서 객실·공유 기준과 관측 선행일수가 같은 자료만 비교합니다. 요일·연휴 구성 차이는 남을 수 있습니다.",
    "새로 관측되거나 이번 달 자료가 없는 업체는 신규 개업·폐업·검색 순위 이탈을 뜻하지 않습니다."];
  if (!previousRows.length) warnings.push("전월에 사용할 수 있는 숙박 관측이 없어 증감을 계산하지 않았습니다.");
  else if (!matchedCurrent.length) warnings.push("전월과 객실·관측 시점을 맞춰 비교할 수 있는 업체·숙박일이 없습니다.");
  if (monthDays(currentMonth) !== monthDays(previousMonth)) warnings.push("두 달의 일수가 다릅니다. 대응 날짜가 없는 말일은 증감 비교에서 제외합니다.");
  if (current.quality?.provisional || previous.quality?.provisional) warnings.push("종료되지 않은 달을 포함한 중간 집계입니다.");
  if (current.quality?.warnings?.length || previous.quality?.warnings?.length) warnings.push("관측·가격 누락 또는 사전 관측이 있습니다. 양월의 자료 충족률과 관측 조건을 함께 확인하세요.");
  return { schemaVersion: 1, previousMonth, currentMonth,
    currentCutoffDate: current.request.cutoffDate, previousCutoffDate: previous.request.cutoffDate,
    status: !matchedCurrent.length ? "unavailable" : matched.excludedCompanyDays || matched.previousExcludedCompanyDays
      || current.quality?.status !== "complete" || previous.quality?.status !== "complete" ? "limited" : "ready",
    all: { current: summarize(currentRows, currentRoster, currentMonth), previous: summarize(previousRows, previousRoster, previousMonth) },
    common: { companyIds: [...commonIds].sort(), companyCount: commonIds.size,
      current: summarize(currentCommon, commonIds, currentMonth), previous: summarize(previousCommon, commonIds, previousMonth), matched },
    newlyObservedCompanyIds: [...currentIds].filter(id => !previousIds.has(id)).sort(),
    noLongerObservedCompanyIds: [...previousIds].filter(id => !currentIds.has(id)).sort(),
    warnings, sourceRunIds: [...new Set([...(current.sources?.runIds || []), ...(previous.sources?.runIds || [])])].sort(),
    previousQuality: previous.quality,
    // Freeze the baseline evidence with this issued version, rather than looking
    // up a different report or recomputing the previous month on PDF download.
    previousSources: previous.sources,
    basis: "동일 업체 고유번호·숙박월. 전체 표본과 공통 업체를 구분하고 증감은 동일 조건의 대응 날짜만 계산." };
}

module.exports = { buildMonthlyComparison, previousMonthlyReportRequest: priorRequest };
