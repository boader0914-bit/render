'use strict';

// This is a field projection only. All selection, revenue and pickup calculations
// belong to the shared company DB. No raw paths, source payloads or admin notes.
const number = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
const text = value => typeof value === 'string' ? value.slice(0, 180) : '';
const day = value => /^\d{4}-\d{2}-\d{2}$/.test(value || '') ? value : null;
const month = value => /^20\d{2}-(0[1-9]|1[0-2])$/.test(value || '') ? value : null;
const stamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;
const numbers = (source, keys) => Object.fromEntries(keys.map(key => [key, number(source?.[key])]));
const metrics = source => ({ ...numbers(source, ['supply', 'sold', 'publicBookings', 'phoneBookings', 'publicRevenue', 'phoneRevenue', 'estimatedRevenue', 'reservationRate', 'sharedDayUseExcluded', 'coveredCompanyDays', 'expectedCompanyDays', 'missingCompanyDays', 'revenueCoveredCompanyDays', 'sameDayObservedCompanyDays', 'staleDays', 'maxObservationLeadTimeDays', 'knownPartialRevenue']), partial: source?.partial === true, revenuePartial: source?.revenuePartial === true, containsPartialRun: source?.containsPartialRun === true });

function projectIntegrated(companyId, value, requestedMonth) {
  const valid = value?.companyId === companyId;
  const source = valid ? value : null;
  const result = {
    schemaVersion: number(source?.schemaVersion), source: 'company_db_integrated', companyId,
    status: source?.status === 'refreshing' ? 'updating' : ['ready', 'updating', 'failed', 'pending'].includes(source?.status) ? source.status : 'pending',
    calculatedAt: stamp(source?.calculatedAt), calculationVersion: text(String(source?.calculationVersion || '')),
    selectedMonth: month(requestedMonth) || month(source?.selectedMonth),
    months: (Array.isArray(source?.months) ? source.months : []).filter(row => month(row.month)).map(row => ({ month: row.month, status: text(row.status) })),
    roomBasis: source?.roomBasis ? { count: number(source.roomBasis.capacity ?? source.roomBasis.count), source: text(source.roomBasis.source), label: text(source.roomBasis.label), reviewRequired: source.roomBasis.reviewRequired === true || source.roomBasis.warnings?.length > 0 } : null,
    snapshot: null
  };
  const snapshot = source?.snapshot;
  // Verify scope again at the customer boundary, even though the reader is trusted.
  if (!snapshot || snapshot.target?.type !== 'company' || snapshot.target?.id !== companyId
    || snapshot.request?.type !== 'company' || snapshot.request?.targetId !== companyId
    || !month(snapshot.request?.month) || result.selectedMonth !== snapshot.request.month) {
    if (result.status === 'ready') result.status = snapshot ? 'failed' : 'pending';
    return result;
  }
  const selected = (snapshot.sources?.observations || []).filter(row => row.companyId === companyId && row.productType === 'lodging');
  const byDate = new Map(selected.map(row => [row.date, row]));
  const attempts = new Map((source.latestAttempts || []).filter(row => row.productType === 'lodging').map(row => [row.date, row]));
  const lodging = snapshot.summary?.lodging;
  const daily = (snapshot.daily || []).filter(row => day(row.date) && row.date.startsWith(result.selectedMonth + '-')).map(row => {
    const m = metrics(row.lodging), evidence = byDate.get(row.date), attempt = attempts.get(row.date);
    return { date: row.date, ...m, total: m.supply,
      missing: !(m.coveredCompanyDays > 0), collectedAt: stamp(evidence?.collectedAt), collectedDate: day(evidence?.collectedDate),
      observationLeadTimeDays: number(evidence?.observationLeadTimeDays),
      latestAttemptAt: stamp(attempt?.collectedAt), latestAttemptStatus: ['selected','not_selected','excluded'].includes(attempt?.status) ? attempt.status : null,
      // Earlier valid observations are usable but explicitly dated, not errors.
      partial: m.coveredCompanyDays !== 1, collectionPartial: evidence?.runQuality === 'partial',
      inventoryConflict: false };
  });
  const pickup = snapshot.insights?.pickup?.lodging;
  const publicPickup = pickup?.public;
  result.snapshot = {
    period: { start: day(snapshot.period?.start), end: day(snapshot.period?.end), days: number(snapshot.period?.days), cutoffDate: day(snapshot.period?.cutoffDate), monthClosed: snapshot.period?.monthClosed === true },
    summary: { ...metrics(lodging), rangeStart: day(snapshot.period?.start), rangeEnd: day(snapshot.period?.end), calendarDays: number(snapshot.period?.days), observedDays: number(lodging?.coveredCompanyDays), missingDays: number(lodging?.missingCompanyDays), revenueObservedDays: number(lodging?.revenueCoveredCompanyDays), quantityPartial: daily.some(row=>row.missing||row.partial) },
    daily,
    analysis: {
      collectionDateCount: number(snapshot.insights?.overview?.collectionDateCount),
      pickup: { ...numbers(publicPickup, ['increase', 'decrease', 'net', 'comparableIntervals']), status: text(publicPickup?.status), actualBookingLeadTime: false,
        leadTime: numbers(publicPickup?.leadTime, ['averageDays', 'medianDays', 'averageMinDays', 'averageMaxDays']),
        intervals: (pickup?.recentIntervals || []).filter(row => row.companyId === companyId).map(row => ({ date: day(row.date), previousCollectedAt: stamp(row.previousCollectedAt), collectedAt: stamp(row.collectedAt), ...numbers(row, ['previousLeadDays', 'currentLeadDays', 'publicChange', 'blockedChange', 'netChange']) })) },
      weekdays: (snapshot.insights?.weekdays?.lodging || []).map(row => ({ dayOfWeek: number(row.dayOfWeek), label: text(row.label), ...metrics(row) })),
      pace: (snapshot.insights?.pace?.lodging || []).map(row => ({ leadDays: number(row.leadDays), ...metrics(row) })),
      pricing: numbers(snapshot.insights?.pricing?.lodging, ['estimatedPerSoldUnit', 'estimatedPerSupplyUnit', 'pricedCompanyDays', 'priceCoverageRate'])
    }
  };
  return result;
}

module.exports = { projectIntegrated };
