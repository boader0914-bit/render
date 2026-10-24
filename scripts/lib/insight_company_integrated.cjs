'use strict';

// This is a field projection only. All selection, revenue and pickup calculations
// belong to the shared company DB. No raw paths, source payloads or admin notes.
const number = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
const count = value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
const nonnegative = value => number(value) !== null && value >= 0 ? value : null;
const text = value => typeof value === 'string' ? value.slice(0, 180) : '';
const day = value => /^\d{4}-\d{2}-\d{2}$/.test(value || '') ? value : null;
const month = value => /^20\d{2}-(0[1-9]|1[0-2])$/.test(value || '') ? value : null;
const stamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;
const reference = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,179}$/.test(value) ? value : null;
const priceCauseCodes = new Set(['explicit_product_price_missing', 'inferred_product_price_missing', 'product_maxima_exceed_company_capacity',
  'proportional_price_evidence_incomplete', 'company_capacity_unallocated_to_products', 'public_product_price_missing', 'dayuse_unverified', 'invalid_product_response']);
function priceUnknownEvidence(row) {
  const value = row?.priceUnknownCauses, coverage = row?.priceUnknownCauseCoverage;
  if (!Array.isArray(value) || !value.every(cause => cause && priceCauseCodes.has(cause.code)
    && ['public', 'other'].includes(cause.channel) && count(cause.quantity) > 0
    && Array.isArray(cause.productKeys) && cause.productKeys.every(key => reference(key)))) return {};
  return { priceUnknownCauses: value.map(cause => ({ code: cause.code, channel: cause.channel, quantity: cause.quantity,
    productKeys: [...new Set(cause.productKeys)] })),
  ...(count(coverage?.classifiedCompanyDays) !== null && count(coverage?.unclassifiedCompanyDays) !== null ? {
    priceUnknownCauseCoverage: { classifiedCompanyDays: coverage.classifiedCompanyDays, unclassifiedCompanyDays: coverage.unclassifiedCompanyDays } } : {}) };
}
function valuationEvidence(row) {
  const value = row?.phoneValuation, shared = row?.sharedDayUseEvidence;
  const recoveries = value?.recoveryPolicies;
  const recoveryPolicies = Array.isArray(recoveries) && recoveries.every(item => item
    && ['catalog_single_room_identity_v1', 'uniform_current_catalog_price_v1'].includes(item.policy)
    && count(item.quantity) > 0 && count(item.revenue) > 0 && item.estimatedQuantity === true && typeof item.sourceDate === 'string' && /^20\d{2}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(item.sourceDate)
    && new Date(item.sourceDate + 'T00:00:00Z').toISOString().slice(0, 10) === item.sourceDate
    && Array.isArray(item.productKeys) && item.productKeys.length > 0 && item.productKeys.every(key => reference(key)) && new Set(item.productKeys).size === item.productKeys.length
    && (item.unitPrice === undefined || nonnegative(item.unitPrice) > 0))
    ? recoveries.map(item => ({ policy: item.policy, quantity: item.quantity, revenue: item.revenue,
      productKeys: [...new Set(item.productKeys)], estimatedQuantity: true, sourceDate: item.sourceDate,
      ...(nonnegative(item.unitPrice) > 0 ? { unitPrice: item.unitPrice } : {}) })) : null;
  return {
    ...priceUnknownEvidence(row),
    ...(row?.priceRecoveryPolicy === 'inventory_price_recovery_v1' ? { priceRecoveryPolicy: row.priceRecoveryPolicy } : {}),
    ...(number(row?.inventoryEvidenceVersion) >= 5 ? { inventoryEvidenceVersion: row.inventoryEvidenceVersion } : {}),
    ...(reference(row?.phoneValuationPolicy) ? { phoneValuationPolicy: row.phoneValuationPolicy } : {}),
    ...(Array.isArray(row?.capacityWitnesses) ? { capacityWitnesses: row.capacityWitnesses.slice(0, 1000)
      .filter(value => reference(value.productKey) && count(value.count) !== null)
      .map(value => ({ productKey: value.productKey, count: value.count, source: reference(value.source),
        ...(day(value.sourceDate) ? { sourceDate: value.sourceDate } : {}),
        ...(stamp(value.observedAt) ? { observedAt: value.observedAt } : {}),
        ...(reference(value.runId) ? { runId: value.runId } : {}) })) } : {}),
    ...(value && reference(value.policy) ? { phoneValuation: { policy: value.policy,
      quantityPolicy: reference(value.quantityPolicy), roundingPolicy: reference(value.roundingPolicy),
      unroundedRevenue: nonnegative(value.unroundedRevenue),
      ...(recoveryPolicies !== null ? { recoveryPolicies } : {}),
      ...(typeof value.completePriceCoverage === 'boolean' ? { completePriceCoverage: value.completePriceCoverage } : {}) } } : {}),
    ...(shared && reference(shared.policy) ? { sharedDayUseEvidence: { policy: shared.policy,
      publicSessions: count(shared.publicSessions), physicalRoomBookings: count(shared.physicalRoomBookings), excludedBookings: count(shared.excludedBookings),
      groups: (Array.isArray(shared.groups) ? shared.groups : []).slice(0, 1000).map(group => ({
        groupKey: text(group.groupKey), lunchBookings: count(group.lunchBookings), dinnerBookings: count(group.dinnerBookings),
        physicalRoomBookings: count(group.physicalRoomBookings), reusedBookings: count(group.reusedBookings),
        productIds: (Array.isArray(group.productIds) ? group.productIds : []).map(reference).filter(Boolean),
        classificationSource: reference(group.classificationSource) })) } } : {})
  };
}
function sourceRecovery(row) {
  const proof = row?.sourceRecovery;
  if (!proof || proof.kind !== 'saved_product_recovery_v1' || proof.originalRunQuality !== 'unknown'
    || row.runQuality !== 'unknown' || proof.companyId !== row.companyId || proof.runId !== row.runId
    || proof.date !== row.date || proof.productType !== row.productType || proof.collectedAt !== row.collectedAt
    || ![proof.receiptId, proof.sourceDigest, proof.rowDigest].every(value => /^[a-f0-9]{64}$/.test(value || ''))) return null;
  return { kind: proof.kind, companyId: row.companyId, runId: row.runId, date: row.date, productType: row.productType,
    collectedAt: row.collectedAt, originalRunQuality: 'unknown', receiptId: proof.receiptId, sourceDigest: proof.sourceDigest, rowDigest: proof.rowDigest };
}
const sourceObservation = row => row && reference(row.companyId) && reference(row.runId) && day(row.date) && row.productType === 'lodging'
  ? { companyId: row.companyId, runId: row.runId, date: row.date, productType: 'lodging', collectedAt: stamp(row.collectedAt), collectedDate: day(row.collectedDate), runQuality: ['complete', 'reused', 'partial'].includes(row.runQuality) ? row.runQuality : 'unknown',
    ...valuationEvidence(row), ...(sourceRecovery(row) ? { sourceRecovery: sourceRecovery(row) } : {}) } : null;
const numbers = (source, keys) => Object.fromEntries(keys.map(key => [key, number(source?.[key])]));
const metrics = source => ({ ...numbers(source, ['supply', 'sold', 'publicBookings', 'phoneBookings', 'publicRevenue', 'phoneRevenue', 'estimatedRevenue', 'reservationRate', 'sharedDayUseExcluded', 'coveredCompanyDays', 'expectedCompanyDays', 'missingCompanyDays', 'revenueCoveredCompanyDays', 'sameDayObservedCompanyDays', 'staleDays', 'maxObservationLeadTimeDays', 'knownPartialRevenue']),
  ...priceUnknownEvidence(source),
  phoneMissingPriceBookings: count(source?.phoneMissingPriceBookings), phoneFallbackBookings: count(source?.phoneFallbackBookings),
  phoneFallbackRevenue: nonnegative(source?.phoneFallbackRevenue),
  phoneAllocatedBookings: count(source?.phoneAllocatedBookings), phoneAllocatedRevenue: nonnegative(source?.phoneAllocatedRevenue),
  phoneRevenueLow: nonnegative(source?.phoneRevenueLow), phoneRevenueHigh: nonnegative(source?.phoneRevenueHigh),
  partial: source?.partial === true, revenuePartial: source?.revenuePartial === true, containsPartialRun: source?.containsPartialRun === true });

function projectIntegrated(companyId, value, requestedMonth) {
  const valid = value?.companyId === companyId;
  const source = valid ? value : null;
  const result = {
    schemaVersion: number(source?.schemaVersion), source: 'company_db_integrated', companyId,
    status: source?.status === 'refreshing' ? 'updating' : ['ready', 'updating', 'failed', 'pending'].includes(source?.status) ? source.status : 'pending',
    calculatedAt: stamp(source?.calculatedAt), calculationVersion: text(String(source?.calculationVersion || '')),
    sourceRevision: reference(source?.sourceRevision),
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
  const selected = (snapshot.sources?.observations || []).filter(row => row.companyId === companyId && row.productType === 'lodging' && day(row.date) && row.date.startsWith(result.selectedMonth + '-'));
  // The shared DB has already selected the observation. Do not independently
  // choose a newer run here, or infer linkage from the most recent collection.
  const byDate = new Map(), duplicateDates = new Set();
  for (const row of selected) { if (byDate.has(row.date)) duplicateDates.add(row.date); else byDate.set(row.date, row); }
  const observations = selected.map(sourceObservation).filter(Boolean);
  const suppliedRunIds = Array.isArray(snapshot.sources?.runIds) ? snapshot.sources.runIds : [];
  const runIds = [...new Set(suppliedRunIds.map(reference).filter(Boolean))].sort();
  const linkedRunIds = new Set(runIds);
  const completeLinkage = Boolean(reference(result.calculationVersion)) && selected.length > 0 && observations.length === selected.length
    && duplicateDates.size === 0 && suppliedRunIds.length > 0 && suppliedRunIds.every(value => reference(value))
    && observations.every(row => row.collectedAt && row.collectedDate && linkedRunIds.has(row.runId));
  const attempts = new Map((source.latestAttempts || []).filter(row => row.productType === 'lodging').map(row => [row.date, row]));
  const lodging = snapshot.summary?.lodging;
  const daily = (snapshot.daily || []).filter(row => day(row.date) && row.date.startsWith(result.selectedMonth + '-')).map(row => {
    const m = metrics(row.lodging), evidence = duplicateDates.has(row.date) ? null : byDate.get(row.date), attempt = attempts.get(row.date);
    return { date: row.date, ...m, total: m.supply,
      // Monetary aggregates omit price-ineligible observations. Preserve the
      // selected source's explicit missing-price quantity when that aggregate
      // is unknown, while keeping an observed zero authoritative. No quantity
      // or money is inferred or recalculated at this projection boundary.
      phoneMissingPriceBookings: m.phoneMissingPriceBookings ?? count(evidence?.phoneMissingPriceBookings),
      ...valuationEvidence(evidence),
      missing: !(m.coveredCompanyDays > 0), collectedAt: stamp(evidence?.collectedAt), collectedDate: day(evidence?.collectedDate),
      observationLeadTimeDays: number(evidence?.observationLeadTimeDays),
      sourceObservation: sourceObservation(evidence),
      latestAttemptAt: stamp(attempt?.collectedAt), latestAttemptStatus: ['selected','not_selected','excluded'].includes(attempt?.status) ? attempt.status : null,
      // Earlier valid observations are usable but explicitly dated, not errors.
      partial: m.coveredCompanyDays !== 1, collectionPartial: evidence?.runQuality === 'partial',
      inventoryConflict: false };
  });
  const pickup = snapshot.insights?.pickup?.lodging;
  const publicPickup = pickup?.public;
  result.snapshot = {
    provenance: { source: 'company_db_integrated', companyId, calculationVersion: result.calculationVersion, sourceRevision: result.sourceRevision,
      linkageStatus: completeLinkage ? 'complete' : 'incomplete', runIds,
      selectedRunIds: [...new Set(observations.map(row => row.runId))].sort(), observations,
      sourceDigest: /^[a-f0-9]{64}$/i.test(snapshot.sources?.digest || '') ? snapshot.sources.digest : null },
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
