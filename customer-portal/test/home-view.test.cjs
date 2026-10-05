'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { panel, companyCard, operations, regionSummary, selectRegion } = require('../web/home.js');

const text = html => html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
const compact = html => text(html).replace(/\s/g, '');
const company = (companyId = 'cmp_own', regionKey = 'home_region') => ({
  companyId, name: '솔빛 글램핑', address: '경남 산청군 검수로 16', rooms: 16,
  roomCountSource: 'DB 검토값', regionKey, regionLabel: '산청군',
  observedAt: '2026-09-28T04:00:00Z',
});
const relation = (companyId = 'cmp_own', status = 'active', kind = 'own') => ({
  relationId: `rel_${companyId}`, companyId, status, kind,
});
function state({ companies = [company()], relations = [relation()], businessStatus = 'owned', regions = [], interests = [], projectName = '' } = {}) {
  return {
    customer: { username: 'review', businessStatus, projectName, relations, regions: interests, settings: {}, entitlements: {} },
    companies, regions, corrections: [], preparations: [], features: { weeklyReports: false, reportDelivery: false },
  };
}
function report(companies = [], regions = []) {
  return {
    ownId: 'cmp_own', companies, regions, comparisons: [], actions: [], definitions: [], published: false,
    generatedAt: '2026-10-05T00:00:00Z', period: { start: '2026-10-05', end: '2026-11-03', days: 30 },
  };
}
const region = (id, label = id) => ({
  region: { id, label }, month: '2026-09', window: { start: '2025-10', end: '2026-09', months: 12 },
  availableSources: 0, sources: [], warnings: [],
});
const summary = overrides => ({
  days: 30, supply: 480, sold: 0, publicBookings: 0, phoneBookings: 0,
  estimatedRevenue: 0, reservationRate: 0, ...overrides,
});

test('home immediately shows registered company identity and capacity before async analysis', () => {
  const html = panel(state());
  assert.match(text(html), /솔빛 글램핑/);
  assert.match(text(html), /경남 산청군 검수로 16/);
  assert.match(compact(html), /16실/);
  assert.match(html, /#company=cmp_own/);
  assert.doesNotMatch(text(html), /발행 완료|최근 발행일|리포트 발행일/);
});

test('home distinguishes missing registration, planning and pending ownership', () => {
  const empty = panel(state({ companies: [], relations: [] }));
  assert.match(text(empty), /매장.*등록|등록.*매장/);
  assert.match(empty, /#property/);
  const planning = panel(state({ companies: [], relations: [], businessStatus: 'planning', projectName: '새 숙소 준비' }));
  assert.match(text(planning), /준비/);
  assert.match(planning, /#regions/);
  const pending = panel(state({ relations: [relation('cmp_own', 'pending')] }));
  assert.match(text(pending), /솔빛 글램핑/);
  assert.match(text(pending), /대기/);
});

test('a retained relation with unavailable company metadata is a connection issue, not silently discarded', () => {
  const html = panel(state({ companies: [] }));
  assert.match(text(html), /연결/);
  assert.match(text(html), /확인/);
  assert.doesNotMatch(compact(html), /객실총량0실|예약합계0실|매출합계0만원/);
});

test('company card preserves unknown rooms and escapes user editable identity', () => {
  const unsafe = { ...company(), name: '<img src=x onerror=alert(1)>', address: '<script>address</script>', rooms: null };
  const html = companyCard(unsafe, relation(), { nickname: '<script>nickname</script>' });
  assert.match(html, /&lt;/);
  assert.doesNotMatch(html, /<img\b|<script\b/i);
  assert.doesNotMatch(compact(html), /0실/);
  assert.match(text(html), /확인/);
});

test('operations selects the exact company and keeps genuine zero values', () => {
  const html = operations(report([
    { companyId: 'cmp_other', kind: 'own', name: '다른 매장', summary: summary({ sold: 987, estimatedRevenue: 98700000 }) },
    { companyId: 'cmp_own', kind: 'own', name: '솔빛 글램핑', lastObservedAt: '2026-09-28T04:00:00Z', summary: summary() },
  ]), 'cmp_own');
  assert.match(compact(html), /0실/);
  assert.match(compact(html), /0(?:\.0)?만원|0원/);
  assert.match(compact(html), /0(?:\.0)?%/);
  assert.doesNotMatch(text(html), /987/);
});

test('missing company or empty summary never becomes another company or zero revenue', () => {
  const r = report([{ companyId: 'cmp_other', kind: 'own', name: '다른 매장', summary: summary({ sold: 987, estimatedRevenue: 98700000 }) }]);
  const missing = operations(r, 'cmp_own');
  assert.doesNotMatch(text(missing), /987/);
  assert.doesNotMatch(compact(missing), /0만원|예약합계0실/);
  const unavailable = operations(report([{ companyId: 'cmp_own', kind: 'own', unavailable: true,
    summary: summary({ days: 0, supply: null, sold: null, publicBookings: null, phoneBookings: null, estimatedRevenue: null, reservationRate: null }) }]), 'cmp_own');
  assert.match(text(unavailable), /확인|자료|보류/);
  assert.doesNotMatch(compact(unavailable), /0만원|예약합계0실|예약률0%/);
});

test('exact active own region takes priority over the first interest region in the API', () => {
  const own = region('home_region', '산청군'), interest = region('interest_region', '가평군');
  const s = state({ regions: [interest.region, own.region], interests: [{ regionKey: 'interest_region', status: 'active' }] });
  const selected = selectRegion(report([], [interest, own]), s, 'cmp_own');
  assert.equal(selected?.region, own);
  assert.match(selected.label, /소재|매장/);
});

test('region fallback follows active registered interest order and rejects unrelated API regions', () => {
  const first = region('first_interest'), second = region('second_interest'), unrelated = region('unrelated');
  const s = state({ interests: [
    { regionKey: 'archived_interest', status: 'archived' },
    { regionKey: 'first_interest', status: 'active' },
    { regionKey: 'second_interest', status: 'active' },
  ] });
  const selected = selectRegion(report([], [unrelated, second, first]), s, 'cmp_own');
  assert.equal(selected?.region, first);
  assert.match(selected.label, /관심/);
  assert.equal(selectRegion(report([], [unrelated]), s, 'cmp_own'), null);
});

test('pending ownership alone does not authorize a home locality summary', () => {
  const own = region('home_region');
  const pending = state({ relations: [relation('cmp_own', 'pending')] });
  assert.equal(selectRegion(report([], [own]), pending, 'cmp_own'), null);
  pending.customer.regions.push({ regionKey: 'home_region', status: 'active' });
  const selected = selectRegion(report([], [own]), pending, 'cmp_own');
  assert.equal(selected?.region, own);
  assert.match(selected.label, /관심/);
});

test('regional summary uses each metric latest month, keeps zero and does not fabricate missing search interest', () => {
  const g = region('home_region', '산청군');
  g.sources = [
    { key: 'tourism_visitors', label: '방문자', metrics: [{ key: 'averageDailyVisitors', label: '일평균 방문자', unit: '명', latest: { month: '2026-07', value: 12345 }, observedMonths: 10 }] },
    { key: 'tourism_stay_spend', label: '체류·소비', metrics: [
      { key: 'stayOverall', label: '체류 지수', unit: '지수', latest: { month: '2026-08', value: 88 }, observedMonths: 11 },
      { key: 'spendOverall', label: '소비 지수', unit: '지수', latest: { month: '2026-08', value: 0 }, observedMonths: 11 },
    ] },
    { key: 'naver_search_trend', label: '검색 관심', metrics: [{ key: 'interest', label: '검색 관심도', unit: '상대지수', latest: null, observedMonths: 0 }] },
  ];
  const rendered = compact(regionSummary(g, '매장 소재지'));
  assert.match(rendered, /12,345/);
  assert.match(rendered, /2026(?:[-./]0?7|년0?7월)/);
  assert.match(rendered, /2026(?:[-./]0?8|년0?8월)/);
  assert.match(rendered, /0지수/);
  assert.match(rendered, /미확인|자료없음|확인전|자료확인|확보전/);
  assert.doesNotMatch(rendered, /검색관심도0(?:상대지수)?/);
});

test('regional summary escapes API labels and interpretation content', () => {
  const g = region('safe_region', '<img src=x onerror=alert(1)>');
  g.location = { interpretation: '<script>unsafe</script>' };
  const html = regionSummary(g, '<svg onload=alert(1)>');
  assert.match(html, /&lt;/);
  assert.doesNotMatch(html, /<img\b|<script\b|<svg\s+onload/i);
});
