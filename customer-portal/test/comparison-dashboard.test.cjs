'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm');
const dashboard = require('../web/comparison-dashboard.js');
const {evaluateComparison, summarizeCompany, projectReservationSeries} = require('../../scripts/lib/insight_comparison.cjs');
const {projectComparison} = require('../comparison-projection.cjs');
const DAY = 86400000, START = '2026-10-30', END = '2026-11-28';
const clone = value => JSON.parse(JSON.stringify(value));

function fixture({zero = false, missing = false, unconfirmed = false, pending = false, reviewed = true, short = false, extraSame = false, missingPeer = false, firstOwnSold = null} = {}) {
  const policy = {mode: 'current', asOf: START, period: {start: START, end: END}, observationPolicy: {confirmed: !unconfirmed, maxSkewMs: 7200000}};
  const make = (companyId, kind, regionKey, rooms, sold, industry = 'glamping') => ({companyId, kind, regionKey, rooms,
    name: companyId === 'own' ? '시즌글램핑' : companyId === 'same' ? '같은 지역 글램핑' : companyId === 'mixed' ? '같은 지역 펜션' : '다른 지역 글램핑',
    regionLabel: regionKey === 'sancheong' ? '산청군' : '가평군', industryTags: [industry], comparisonPurpose: 'direct',
    relationStatus: kind === 'own' && pending ? 'pending' : 'active', capacityReviewRequired: !reviewed, capacityStatus: reviewed ? 'reviewed' : 'review_required',
    days: Array.from({length: short ? 6 : 30}, (_, i) => ({date: new Date(Date.parse(START) + i * DAY).toISOString().slice(0, 10),
      total: rooms, sold: zero ? 0 : kind === 'own' && i === 0 && firstOwnSold !== null ? firstOwnSold : sold,
      publicBookings: zero ? 0 : (kind === 'own' && i === 0 && firstOwnSold !== null ? firstOwnSold : sold) - 1, phoneBookings: zero ? 0 : 1,
      missing: missing && i === 3 || missingPeer && companyId === 'same' && i === 0,
      missingReason: missing && i === 3 || missingPeer && companyId === 'same' && i === 0 ? 'partial_inventory' : null,
      collectedAt: START + 'T01:00:00Z', estimatedRevenue: zero ? 0 : sold * 200000}))});
  const own = make('own', 'own', 'sancheong', 10, 2), same = make('same', 'competitor', 'sancheong', 20, 10),
    cross = make('cross', 'competitor', 'gapyeong', 30, 27), mixed = make('mixed', 'competitor', 'sancheong', 12, 12, 'pension');
  const raw = [own, same, cross, mixed];
  if (extraSame) raw.push(make('same2', 'competitor', 'sancheong', 30, 24));
  const report = {mode: 'current_briefing', published: false, ownId: 'own', asOf: START, selection: {stayMode: 'upcoming30'},
    period: {start: START, end: END, days: 30}, generatedAt: START + 'T02:00:00Z', dataQuality: {status: 'complete', issues: []},
    companies: raw.map(c => {const out = {...c, sourceStatus: 'ready', sourceIssues: [], ...summarizeCompany(c, policy), reservationSeries: projectReservationSeries(c, policy)};
      delete out.days; out.summaryQuality.mode = 'current'; return out;}), comparisons: raw.slice(1).map(c => projectComparison(evaluateComparison(own, c, policy)))};
  return {report, selection: {ownCompanyId: 'own', comparisonIds: raw.slice(1).map(c => c.companyId), stayMode: 'upcoming30', stayStart: START, stayEnd: END, asOfDate: START, selectedView: 'flow'},
    catalog: raw.map(c => ({companyId: c.companyId, name: c.name, rooms: c.rooms}))};
}
const project = (f, filters) => dashboard.project(f.report, f.selection, f.catalog, filters);
const metric = (value, key) => value.metrics.find(row => row.id === key);

test('customer properties, four KPI cards and common same-region same-industry supply weighting use saved facts only', () => {
  const f = fixture({extraSame: true}), before = JSON.stringify(f), value = project(f);
  assert.equal(value.contextValid, true); assert.equal(value.own.name, '시즌글램핑'); assert.equal(value.own.rooms, 10);
  assert.equal(value.own.summary.days, 30); assert.equal(value.own.summary.sold, 60); assert.equal(value.own.summary.supply, 300);
  assert.equal(metric(value, 'own_rate').value, .2); assert.equal(metric(value, 'peer_rate').value, 34 / 50);
  assert.deepEqual(value.peers.companyIds, ['same', 'same2']); assert.equal(value.peers.companies, 2); assert.equal(value.peers.supply, 1500);
  assert.notEqual(value.peers.rate, (.5 + .8) / 2); assert.equal(value.companies.find(c => c.companyId === 'cross').regionRelation, 'cross');
  assert.equal(value.companies.find(c => c.companyId === 'mixed').industryRelation, 'mixed');
  assert.equal(value.daily[0].peerPublicRate, 32 / 50); assert.equal(value.daily[0].peerInferredRate, 2 / 50);
  assert.equal(value.metrics.length, 4); assert.equal(value.judgments.length, 3); assert.equal(value.executionAllowed, false);
  assert.equal(JSON.stringify(f), before);
});

test('a partial date range and weekday filter affect every subtotal, company chart and daily point together', () => {
  const f = fixture(), value = project(f, {start: '2026-11-01', end: '2026-11-14', dayFilter: 'weekday'});
  assert.deepEqual(value.dates, ['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12']);
  assert.equal(value.period.days, 8); assert.equal(value.period.selectedDays, 8); assert.equal(value.period.baseStart, START);
  assert.equal(value.sourcePeriod.days, 30); assert.equal(value.sourcePeriod.end, END);
  assert.equal(value.own.summary.sold, 16); assert.equal(value.own.summary.supply, 80); assert.equal(value.peers.sold, 80); assert.equal(value.peers.supply, 160);
  assert.ok(value.companies.every(c => c.points.length === 8 && c.summary.days === 8)); assert.equal(value.daily.length, 8);
  assert.equal(value.daily[0].ownRate, .2); assert.equal(value.daily[0].peerRate, .5);
});

test('Friday, Saturday and Sunday are distinct; normal zero is not a missing observation', () => {
  for (const [dayFilter, day] of [['friday', 5], ['saturday', 6], ['sunday', 0]]) {
    const value = project(fixture({zero: true}), {dayFilter});
    assert.ok(value.dates.length > 0); assert.ok(value.dates.every(d => new Date(d + 'T00:00:00Z').getUTCDay() === day));
    assert.equal(metric(value, 'own_rate').value, 0); assert.equal(value.own.summary.sold, 0); assert.equal(value.own.summary.publicBookings, 0);
    assert.equal(value.daily[0].ownRate, 0); assert.equal(value.daily[0].peerRate, 0); assert.equal(value.own.points[0].status, 'ready');
  }
});

test('empty weekday ranges and invalid filters do not reuse another range or invent zero bookings', () => {
  const f = fixture(), value = project(f, {start: START, end: START, dayFilter: 'weekday'});
  assert.equal(value.contextValid, true); assert.equal(value.period.days, 0); assert.deepEqual(value.dates, []);
  assert.equal(value.own.summary.sold, null); assert.equal(metric(value, 'own_rate').value, null); assert.equal(value.peers.rate, null);
  for (const filters of [{start: '2026-10-29'}, {end: '2026-11-29'}, {start: '2026-11-03', end: '2026-11-02'},
    {start: '2026-02-30'}, {start: null}, {dayFilter: 'holiday'}]) {
    const normalized = dashboard.normalizeFilters(f.report, filters), bad = project(f, filters);
    assert.equal(normalized.valid, false); assert.deepEqual(normalized.dates, []); assert.ok(normalized.reason);
    assert.equal(bad.contextValid, true); assert.equal(bad.status, 'unavailable'); assert.deepEqual(bad.daily, []);
    assert.equal(metric(bad, 'own_rate').value, null); assert.equal(bad.quality.issues[0].code, 'INVALID_FILTER');
  }
});

test('short source samples and filtered samples never promote a central comparison hold', () => {
  const short = project(fixture({short: true}));
  assert.equal(short.own.summary.days, 6); assert.equal(short.peers.rate, null); assert.equal(short.judgments[0].status, 'hold');
  const filtered = project(fixture(), {start: START, end: '2026-11-01'});
  assert.equal(filtered.peers.rate, .5); assert.equal(filtered.judgments[0].status, 'hold'); assert.equal(filtered.quality.actionable, false);
  assert.ok(filtered.daily.every(d => d.comparable === false && d.actionable === false && d.status === 'reference'));
  assert.match(filtered.judgments[0].reason, /최소 7일/);
});

test('measured quantities survive while pending ownership, capacity review and unknown time policy keep actions held', () => {
  for (const options of [{pending: true}, {reviewed: false}, {unconfirmed: true}]) {
    const value = project(fixture(options)); assert.equal(metric(value, 'own_rate').value, .2);
    assert.equal(value.judgments[0].status, 'hold'); assert.equal(value.quality.actionable, false); assert.equal(value.executionAllowed, false);
  }
});

test('missing quantities remain null and only ready dates enter company and shared-peer subtotals', () => {
  const value = project(fixture({missing: true}));
  assert.equal(value.own.summary.days, 29); assert.equal(value.own.summary.missingDays, 1); assert.equal(value.own.summary.sold, 58);
  assert.equal(value.own.points[3].status, 'unavailable'); assert.equal(value.own.points[3].sold, null); assert.equal(value.daily[3].ownRate, null);
  assert.equal(value.daily[3].peerRate, null); assert.equal(value.peers.days, 29); assert.deepEqual(value.quality.missingDates, ['2026-11-02']);
  assert.notEqual(value.own.points[3].rate, 0); assert.match(value.own.points[3].reasons.join(' '), /미확인/);
});

test('reservation-level judgments compare the same common dates rather than the owners larger individual subtotal', () => {
  const value = project(fixture({missingPeer: true, firstOwnSold: 8}));
  assert.equal(value.own.summary.days, 30); assert.equal(value.own.summary.sold, 66); assert.equal(metric(value, 'own_rate').value, .22);
  assert.equal(value.peers.days, 29); assert.equal(value.peers.rate, .5); assert.equal(value.judgments[0].commonOwnRate, .2);
  assert.equal(value.judgments[0].gapPp, -30); assert.equal(value.daily[0].ownRate, .8); assert.equal(value.daily[0].peerRate, null);
});

test('verified partial money is shown separately and never fills missing quantity or a rate', () => {
  const f = fixture({missing: true}), company = f.report.companies[1], point = company.reservationSeries.points[3];
  Object.assign(point, {partialConfirmedRevenue: 149000, partialRevenueEvidence: {companyId: company.companyId, date: point.date, productType: 'lodging',
    runId: 'saved-partial-run', collectedAt: START + 'T03:00:00Z', collectedDate: START, reason: 'partial_inventory', amount: 149000}});
  const value = project(f), same = value.companies.find(c => c.companyId === 'same');
  assert.equal(same.partialRevenue.amount, 149000); assert.equal(same.partialRevenue.days, 1); assert.equal(same.summary.days, 29);
  assert.equal(same.points[3].partialRevenue.amount, 149000); assert.equal(same.points[3].sold, null); assert.equal(value.daily[3].peerRate, null);
  point.partialRevenueEvidence.companyId = 'foreign'; assert.equal(project(f).companies.find(c => c.companyId === 'same').partialRevenue.amount, null);
  point.partialRevenueEvidence.companyId = 'same'; point.partialRevenueEvidence.amount = 0; point.partialConfirmedRevenue = 0;
  assert.equal(project(f).companies.find(c => c.companyId === 'same').partialRevenue.amount, 0);
});

test('saved stale normal data is reference only, with no reuse of its quantities in the current totals', () => {
  const f = fixture({missing: true}), row = f.report.companies[1].reservationSeries.points[3];
  Object.assign(row, {codes: ['OBSERVATION_STALE'], missingReason: null, storedReference: {source: 'stored_normal_observation', date: row.date,
    total: 20, sold: 10, publicBookings: 9, phoneBookings: 1, collectedAt: '2026-10-01T01:00:00Z', collectedDate: '2026-10-01', reservationRate: .5, reason: 'OBSERVATION_STALE'}});
  const value = project(f), same = value.companies.find(c => c.companyId === 'same');
  assert.equal(same.storedReference.days, 1); assert.equal(same.points[3].storedReference.sold, 10); assert.equal(same.points[3].rate, null);
  assert.equal(same.summary.days, 29); assert.equal(same.summary.sold, 290); assert.equal(value.quality.storedReferenceDays, 1);
  assert.equal(project(f, {start: '2026-11-03'}).quality.storedReferenceDays, 0);
});

test('customer scope and period fail closed, without leaking unauthorized or unselected names and source issues', () => {
  const mutations = [f => f.selection.ownCompanyId = 'foreign', f => f.selection.comparisonIds.push('foreign'), f => f.catalog = f.catalog.filter(c => c.companyId !== 'same'),
    f => f.report.companies[0].kind = 'competitor', f => f.report.companies[1].relationStatus = 'removed', f => f.report.ownId = 'foreign',
    f => f.report.published = true, f => f.report.mode = 'published_report', f => f.report.asOf = '2026-10-29', f => f.selection.stayEnd = '2026-11-27'];
  for (const mutate of mutations) {const f = fixture(); mutate(f); const result = project(f); assert.equal(result.contextValid, false); assert.deepEqual(result.companies, []); assert.deepEqual(result.daily, []);}
  const f = fixture(); f.report.companies[2].name = 'PRIVATE-NAME'; f.report.dataQuality.issues.push({scope: 'company', companyId: 'cross', code: 'COMPANY_MONTH_UNAVAILABLE', reason: 'PRIVATE-ERROR'});
  f.selection.comparisonIds = ['same']; const value = project(f); assert.deepEqual(value.companies.map(c => c.companyId), ['own', 'same']); assert.doesNotMatch(JSON.stringify(value), /PRIVATE-/);
  f.selection.comparisonIds = []; const alone = project(f); assert.equal(alone.own.summary.rate, .2); assert.equal(alone.peers.rate, null); assert.equal(alone.peers.companies, 0);
});

test('cross-region and other-industry references never substitute for a same-region industry peer', () => {
  const f = fixture(); f.selection.comparisonIds = ['cross', 'mixed']; const value = project(f);
  assert.equal(value.companies.length, 3); assert.equal(value.peers.expectedCompanies, 0); assert.equal(value.peers.rate, null);
  assert.equal(value.judgments[0].gapPp, null); assert.equal(value.judgments[0].status, 'hold'); assert.ok(value.daily.every(d => d.peerRate === null));
});

test('duplicate dates, capacity conflicts, bad arithmetic and future observation dates remain unknown', () => {
  for (const mutate of [c => c.reservationSeries.points.push(clone(c.reservationSeries.points[0])), c => c.reservationSeries.points[0].total = 11,
    c => c.reservationSeries.points[0].phoneBookings = 9, c => c.reservationSeries.points[0].reservationRate = .9,
    c => c.reservationSeries.points[0].inventoryConflict = true, c => c.reservationSeries.points[0].collectedDate = '2026-10-31']) {
    const f = fixture(); mutate(f.report.companies[0]); const value = project(f);
    assert.equal(value.own.points[0].rate, null); assert.equal(value.daily[0].peerRate, null); assert.equal(value.daily[0].actionable, false);
  }
});

test('a new observation version cannot join an older comparison basis', () => {
  const f = fixture(); f.report.companies[0].reservationSeries.points[0].collectedAt = START + 'T03:00:00Z';
  const value = project(f); assert.equal(value.own.points[0].rate, .2); assert.equal(value.daily[0].peerRate, null); assert.equal(value.daily[1].peerRate, .5);
});

test('prices and reservation changes stay unknown despite revenue or unrelated injected fields', () => {
  const f = fixture(); f.report.priceRows = [{price: 1}]; f.report.previousObservation = {publicNetChange: 9}; f.report.secret = 'PRIVATE-SECRET';
  const value = project(f); assert.equal(metric(value, 'product_price').value, null); assert.equal(metric(value, 'public_change').value, null);
  assert.equal(value.judgments[1].status, 'hold'); assert.equal(value.judgments[2].status, 'hold'); assert.doesNotMatch(JSON.stringify(value), /PRIVATE-SECRET/);
});

test('preview quantities display with central benchmark and action hold intact', () => {
  const f = fixture(); f.report.responseCache = {preview: true}; const value = project(f);
  assert.equal(metric(value, 'own_rate').value, .2); assert.equal(metric(value, 'peer_rate').value, null);
  assert.equal(value.quality.preview, true); assert.equal(value.quality.actionable, false); assert.equal(value.judgments[0].status, 'hold');
});

test('browser UMD is deterministic and has no network, storage, timer or input mutation side effects', () => {
  const context = {window: {}, fetch: () => assert.fail('network'), localStorage: {setItem: () => assert.fail('storage')}, setTimeout: () => assert.fail('timer')};
  for (const name of ['comparison-readiness.js', 'customer-operating-actions.js', 'comparison-saved-metrics.js', 'comparison-dashboard.js']) vm.runInNewContext(fs.readFileSync(require.resolve('../web/' + name), 'utf8'), context);
  const f = fixture(), before = JSON.stringify(f), value = context.window.InsightComparisonDashboard.project(f.report, f.selection, f.catalog, {dayFilter: 'saturday'});
  assert.equal(value.own.name, '시즌글램핑'); assert.ok(value.daily.length > 0); assert.equal(JSON.stringify(f), before);
  assert.equal(JSON.stringify(value), JSON.stringify(project(f, {dayFilter: 'saturday'})));
});
