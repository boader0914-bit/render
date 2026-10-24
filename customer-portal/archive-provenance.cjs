'use strict';

// Durable archives consume only the safe, shared company-DB projection. This
// module never reads raw collections, recalculates revenue, or claims a human
// review. Unknown quantities and incomplete coverage remain explicit.
const numeric = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
const reference = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,179}$/.test(value) ? value : null;
const validDay = value => typeof value === 'string' && /^20\d{2}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(value)
  && Number.isFinite(Date.parse(value + 'T00:00:00Z')) && new Date(value + 'T00:00:00Z').toISOString().slice(0,10) === value;
const validMonth = value => typeof value === 'string' && /^20\d{2}-(0[1-9]|1[0-2])$/.test(value);
const stamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;
const numbers = (value, keys) => Object.fromEntries(keys.map(key => [key, numeric(value?.[key])]));
const quantityKeys = ['supply','total','sold','publicBookings','phoneBookings','publicRevenue','phoneRevenue','estimatedRevenue','reservationRate','sharedDayUseExcluded','coveredCompanyDays','expectedCompanyDays','missingCompanyDays','revenueCoveredCompanyDays','sameDayObservedCompanyDays','staleDays','maxObservationLeadTimeDays','knownPartialRevenue'];
function savedRecovery(value) {
  const proof = value?.sourceRecovery;
  if (!proof || value.runQuality !== 'unknown' || proof.kind !== 'saved_product_recovery_v1' || proof.originalRunQuality !== 'unknown'
    || proof.companyId !== value.companyId || proof.runId !== value.runId || proof.date !== value.date
    || proof.productType !== value.productType || proof.collectedAt !== value.collectedAt || !stamp(value.collectedAt)
    || new Date(Date.parse(value.collectedAt)+9*3600000).toISOString().slice(0,10) !== value.collectedDate
    || ![proof.receiptId,proof.sourceDigest,proof.rowDigest].every(value => /^[a-f0-9]{64}$/.test(value || ''))) return null;
  return {kind:proof.kind,companyId:value.companyId,runId:value.runId,date:value.date,productType:value.productType,
    collectedAt:value.collectedAt,originalRunQuality:'unknown',receiptId:proof.receiptId,sourceDigest:proof.sourceDigest,rowDigest:proof.rowDigest};
}
const reviewedSource = value => ['complete','reused'].includes(value?.runQuality) || Boolean(savedRecovery(value));
const observation = (value, companyId, month) => value?.companyId === companyId && reference(value.runId) && validDay(value.date)
  && value.date.startsWith(month + '-') && value.productType === 'lodging' && stamp(value.collectedAt) && validDay(value.collectedDate)
  && value.collectedDate <= value.date && (['complete','reused','partial'].includes(value.runQuality) || savedRecovery(value))
  ? { companyId, runId: value.runId, date: value.date, productType: 'lodging', collectedAt: value.collectedAt, collectedDate: value.collectedDate, runQuality: value.runQuality,
    ...(savedRecovery(value) ? {sourceRecovery:savedRecovery(value)} : {}) } : null;
const quantityValid = row => numeric(row.total) > 0 && numeric(row.sold) !== null && row.sold >= 0 && row.sold <= row.total
  && numeric(row.publicBookings) !== null && row.publicBookings >= 0 && numeric(row.phoneBookings) !== null && row.phoneBookings >= 0
  && Math.abs(row.publicBookings + row.phoneBookings - row.sold) < 0.001;

function projectDailyReview({ companyId, month, data, reviewedAt } = {}) {
  const detail = data?.companyDetail || data, integrated = detail?.integrated, snapshot = integrated?.snapshot;
  const provenance = snapshot?.provenance;
  if (!reference(companyId) || !validMonth(month) || !stamp(reviewedAt) || detail?.companyId !== companyId
    || integrated?.companyId !== companyId || integrated?.source !== 'company_db_integrated' || integrated?.status !== 'ready'
    || integrated?.selectedMonth !== month || !stamp(integrated?.calculatedAt) || !reference(integrated?.calculationVersion)
    || data?.responseCache?.state === 'preview' || data?.responseCache?.preview === true || data?.calculation?.mode === 'saved_only' || !snapshot || !Array.isArray(snapshot.daily) || !snapshot.daily.length || snapshot.daily.length > 31
    || provenance?.source !== 'company_db_integrated' || provenance.companyId !== companyId || provenance.calculationVersion !== integrated.calculationVersion
    || !['complete','incomplete'].includes(provenance.linkageStatus) || !Array.isArray(provenance.runIds) || provenance.runIds.length > 10000
    || !provenance.runIds.every(reference) || !Array.isArray(provenance.observations) || provenance.observations.length > 31) return null;
  const period=snapshot.period;
  if(!validDay(period?.start)||!validDay(period?.end)||!period.start.startsWith(month+'-')||!period.end.startsWith(month+'-')||period.start>period.end
    ||period.days!==(Date.parse(period.end+'T00:00:00Z')-Date.parse(period.start+'T00:00:00Z'))/86400000+1) return null;
  const runIds = [...new Set(provenance.runIds)].sort(), runSet = new Set(runIds);
  const observations = provenance.observations.map(row => observation(row, companyId, month)).filter(Boolean);
  // A response with no exact normal observation is not promoted to a reviewed
  // archive merely because its HTTP request or monthly calculation succeeded.
  if (!observations.some(row => reviewedSource(row) && runSet.has(row.runId))) return null;
  const byDate = new Map(), duplicateDates = new Set();
  for (const row of observations) { if (byDate.has(row.date)) duplicateDates.add(row.date); else byDate.set(row.date, row); }
  const seenDays = new Set();
  if (snapshot.daily.some(row => !validDay(row?.date) || !row.date.startsWith(month + '-') || row.date<period.start || row.date>period.end || seenDays.has(row.date) || !seenDays.add(row.date))) return null;
  const daily = snapshot.daily.map(row => {
    const candidate = observation(row.sourceObservation, companyId, month), exact = byDate.get(row.date);
    const linked = candidate && exact && !duplicateDates.has(row.date) && runSet.has(candidate.runId)
      && JSON.stringify(candidate) === JSON.stringify(exact) ? candidate : null;
    const quantityReviewed = Boolean(linked && reviewedSource(linked) && quantityValid(row)
      && row.missing !== true && row.partial !== true && row.collectionPartial !== true && row.inventoryConflict !== true);
    const revenueReviewed = quantityReviewed && row.revenuePartial !== true && numeric(row.estimatedRevenue) !== null;
    return { date: row.date, ...numbers(row, quantityKeys), missing: row.missing === true, partial: row.partial === true,
      revenuePartial: row.revenuePartial === true, collectionPartial: row.collectionPartial === true, inventoryConflict: row.inventoryConflict === true,
      collectedAt: stamp(row.collectedAt), collectedDate: validDay(row.collectedDate) ? row.collectedDate : null,
      observationLeadTimeDays: numeric(row.observationLeadTimeDays), sourceObservation: linked,
      review: { status: quantityReviewed && revenueReviewed ? 'reviewed' : 'unresolved', quantityReviewed, revenueReviewed,
        reason: !linked ? 'SOURCE_LINK_MISSING' : !quantityReviewed ? 'QUANTITY_NOT_REVIEWABLE' : !revenueReviewed ? 'REVENUE_NOT_REVIEWABLE' : null } };
  });
  if (!daily.some(row => row.review.quantityReviewed)) return null;
  const normalDays = daily.filter(row => row.review.status === 'reviewed').length;
  const provenanceComplete = provenance.linkageStatus === 'complete' && observations.length === provenance.observations.length && !duplicateDates.size;
  const fullyReviewed = provenanceComplete && normalDays === daily.length && snapshot.summary?.partial !== true
    && snapshot.summary?.revenuePartial !== true && snapshot.summary?.quantityPartial !== true && integrated.roomBasis?.reviewRequired !== true;
  return { schemaVersion: 1, kind: 'daily_review', companyId, month, reviewedAt, calculatedAt: integrated.calculatedAt,
    calculationVersion: integrated.calculationVersion,
    review: { status: fullyReviewed ? 'reviewed' : 'partial', basis: 'automatic_validation', normalDays, unresolvedDays: daily.length - normalDays,
      quantityReviewedDays: daily.filter(row => row.review.quantityReviewed).length, revenueReviewedDays: daily.filter(row => row.review.revenueReviewed).length,
      recoveredDays: daily.filter(row => row.review.quantityReviewed && row.sourceObservation?.sourceRecovery).length },
    roomBasis: { count: numeric(integrated.roomBasis?.count), source: reference(integrated.roomBasis?.source), reviewRequired: integrated.roomBasis?.reviewRequired === true },
    period: { start: validDay(snapshot.period?.start) ? snapshot.period.start : null, end: validDay(snapshot.period?.end) ? snapshot.period.end : null,
      days: numeric(snapshot.period?.days), cutoffDate: validDay(snapshot.period?.cutoffDate) ? snapshot.period.cutoffDate : null, monthClosed: snapshot.period?.monthClosed === true },
    summary: { ...numbers(snapshot.summary, quantityKeys), partial: snapshot.summary?.partial === true, revenuePartial: snapshot.summary?.revenuePartial === true, quantityPartial: snapshot.summary?.quantityPartial === true },
    daily,
    provenance: { source: 'company_db_integrated', companyId, calculationVersion: integrated.calculationVersion, linkageStatus: provenanceComplete ? 'complete' : 'incomplete', runIds,
      selectedRunIds: [...new Set(observations.filter(row => runSet.has(row.runId)).map(row => row.runId))].sort(), observations,
      sourceDigest: /^[a-f0-9]{64}$/i.test(provenance.sourceDigest || '') ? provenance.sourceDigest : null } };
}

function publicationSourceLinks(records) {
  if (!Array.isArray(records)) return [];
  const links = new Map();
  for (const record of records) {
    if (record?.kind !== 'daily_review' || !reference(record.companyId) || !validMonth(record.month) || !stamp(record.calculatedAt)
      || !reference(record.calculationVersion) || record.review?.basis !== 'automatic_validation' || !['reviewed','partial'].includes(record.review.status)) continue;
    const value = projectDailyReview({ companyId: record.companyId, month: record.month, reviewedAt: record.reviewedAt,
      data: { companyId: record.companyId, integrated: { companyId: record.companyId, source: 'company_db_integrated', status: 'ready', selectedMonth: record.month,
        calculatedAt: record.calculatedAt, calculationVersion: record.calculationVersion, snapshot: { ...record, provenance: record.provenance } } } });
    if (!value) continue;
    const link = { companyId: value.companyId, month: value.month, calculationVersion: value.calculationVersion, calculatedAt: value.calculatedAt,
      reviewStatus: value.review.status, ...value.provenance };
    links.set(JSON.stringify([link.companyId,link.month,link.calculationVersion,link.calculatedAt,link.sourceDigest]), link);
  }
  return [...links.values()].sort((a,b) => a.companyId.localeCompare(b.companyId) || a.month.localeCompare(b.month) || a.calculatedAt.localeCompare(b.calculatedAt));
}

module.exports = { projectDailyReview, publicationSourceLinks };
