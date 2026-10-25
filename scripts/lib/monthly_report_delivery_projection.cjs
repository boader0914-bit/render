'use strict';
const crypto = require('node:crypto');
const { normalizeMonthlyReportActionPlan, listMonthlyReportActionEvidence } = require('./monthly_report_actions.cjs');
const HASH = /^[a-f0-9]{64}$/;
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = (code, message, statusCode = 400) => Object.assign(new Error(message), { code, statusCode });
function need(condition, code, message, status = 400) { if (!condition) throw fail(code, message, status); }
const stamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const number = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
const text = (value, max = 200) => typeof value === 'string' ? value.slice(0, max) : '';
const safe = (value, expression) => typeof value === 'string' && expression.test(value);
const METRICS = ['supply', 'sold', 'publicBookings', 'phoneBookings', 'sharedDayUseExcluded', 'explicitBlockedBookings',
  'phoneMissingPriceBookings', 'estimatedRevenue', 'publicRevenue', 'phoneRevenue', 'phoneFallbackRevenue', 'phoneFallbackBookings',
  'phoneAllocatedBookings', 'phoneAllocatedRevenue', 'phoneRevenueLow', 'phoneRevenueHigh', 'actualRevenue', 'reservationRate',
  'coveredSupply', 'coveredCompanyDays', 'expectedCompanyDays', 'missingCompanyDays', 'coverageRate', 'revenueCoveredCompanyDays',
  'revenueCoverageRate', 'sameDayObservedCompanyDays', 'staleDays', 'minObservationLeadTimeDays', 'maxObservationLeadTimeDays',
  'medianObservationLeadTimeDays', 'knownPartialRevenue', 'knownPartialPublicRevenue', 'knownPartialBlockedRevenue', 'knownPartialCompanyDays'];
function aggregate(value = {}) {
  return { ...Object.fromEntries(METRICS.map(key => [key, number(value?.[key])])),
    partial: typeof value?.partial === 'boolean' ? value.partial : null,
    revenuePartial: typeof value?.revenuePartial === 'boolean' ? value.revenuePartial : null,
    containsPartialRun: typeof value?.containsPartialRun === 'boolean' ? value.containsPartialRun : null,
    rateDenominator: value?.rateDenominator === 'covered_supply' ? 'covered_supply' : null };
}
const summary = value => ({ lodging: aggregate(value?.lodging), dayuse: aggregate(value?.dayuse) });
function quality(value = {}) {
  const fields = ['companyCount', 'expectedCompanyDays', 'coveredCompanyDays', 'coverageRate', 'missingCompanyDays',
    'sameDayObservedCompanyDays', 'staleDays', 'minObservationLeadTimeDays', 'maxObservationLeadTimeDays',
    'medianObservationLeadTimeDays', 'revenueCoveredCompanyDays', 'revenueExcludedCompanyDays', 'discardedObservationCount',
    'partialRunObservationCount', 'knownPartialCompanyDays', 'recoveredCompanyDays'];
  return { status: ['complete', 'partial', 'insufficient'].includes(value?.status) ? value.status : 'unknown',
    provisional: typeof value?.provisional === 'boolean' ? value.provisional : null,
    ...Object.fromEntries(fields.map(key => [key, number(value?.[key])])) };
}
function reportBinding(report) {
  // snapshotHash binds the snapshot separately. Bind every other issued field
  // too: notes are rendered in the original PDF and must not change unnoticed.
  const { snapshot, ...metadata } = report;
  return metadata;
}
function published(report, id) {
  need(report && report.id === id && report.status === 'published', 'PUBLISHED_REPORT_REQUIRED', '발행된 보고서만 배정할 수 있습니다.', 409);
  need(report.schemaVersion === 1 && HASH.test(report.snapshotHash || '') && report.snapshot && typeof report.snapshot === 'object'
    && !Array.isArray(report.snapshot) && hash(report.snapshot) === report.snapshotHash
    && Number.isSafeInteger(report.revision) && report.revision > 0 && Number.isSafeInteger(report.version) && report.version > 0
    && stamp(report.publishedAt) && ['company', 'keyword', 'region'].includes(report.type)
    && safe(report.month, /^20\d{2}-(0[1-9]|1[0-2])$/) && typeof report.targetId === 'string' && typeof report.title === 'string',
  'REPORT_INTEGRITY_CHANGED', '발행본의 고정된 내용을 확인하지 못했습니다.', 409);
  if (report.snapshot.actionPlan !== undefined) normalizeMonthlyReportActionPlan(report.snapshot.actionPlan, report.snapshot);
  return report;
}
function metadata(report, assignment) {
  return { id: report.id, title: text(report.title), type: report.type, month: report.month, status: 'published',
    version: report.version, publishedAt: report.publishedAt, assignedAt: assignment.assignedAt,
    target: { type: report.type, id: text(report.snapshot.target?.id), label: text(report.snapshot.target?.label) },
    summary: summary(report.snapshot.summary), quality: quality(report.snapshot.quality) };
}
function project(report, assignment) {
  const snapshot = report.snapshot, period = snapshot.period || {};
  const actionPlan = snapshot.actionPlan === undefined ? undefined : normalizeMonthlyReportActionPlan(snapshot.actionPlan, snapshot);
  const refs = new Set(actionPlan?.items.flatMap(item => item.evidenceRefs) || []);
  return { ...metadata(report, assignment), snapshot: {
    period: { start: text(period.start, 10), end: text(period.end, 10), days: number(period.days),
      cutoffDate: text(period.cutoffDate, 10), monthClosed: typeof period.monthClosed === 'boolean' ? period.monthClosed : null },
    summary: summary(snapshot.summary),
    daily: Array.isArray(snapshot.daily) ? snapshot.daily.filter(row => row && /^20\d{2}-\d{2}-\d{2}$/.test(row.date || ''))
      .map(row => ({ date: row.date, ...summary(row) })) : [],
    quality: quality(snapshot.quality),
    ...(actionPlan === undefined ? {} : { actionPlan, actionEvidence: listMonthlyReportActionEvidence(snapshot)
      .filter(row => refs.has(row.id)).map(row => ({ id: row.id, label: text(row.label) })) }),
    definitions: { estimates: '공개 예약과 전화·타채널 예약 추정은 구분하며, 실제 결제 매출을 뜻하지 않습니다.',
      missing: '자료 없음·미확인 값은 0으로 바꾸지 않습니다. 부분 금액은 정상 예상매출과 별도입니다.' }
  } };
}
function projectIssuedList(report, id) {
  published(report, id);
  const value = metadata(report, {});
  delete value.assignedAt;
  return { snapshotHash: report.snapshotHash, reportBindingHash: hash(reportBinding(report)), version: report.version, metadata: value };
}
module.exports = { HASH, hash, fail, need, stamp, safe, reportBinding, published, metadata, project, projectIssuedList };
