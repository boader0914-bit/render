'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { sourcePeriod, regionPeriod, projectResponse } = require('../lib/region-period.cjs');
const ui = require('../web/region-history.js');
const { createConnectedServer } = require('../connected-server.cjs');
const month = i => new Date(Date.UTC(2024, 9 + i, 1)).toISOString().slice(0, 7);
function source(key = 'tourism_resource') {
  return { key, label: '지역 지표', provider: '출처', metrics: [{ key: 'value', label: '지표', unit: '지수' }],
    series: Array.from({ length: 24 }, (_, i) => ({ month: month(i), status: i === 23 ? 'partial' : 'observed',
      rows: [{ key: 'value', label: '지표', unit: '지수', value: i === 23 ? null : i, status: i === 23 ? 'missing' : 'observed' }] })) };
}
function region(sources = [source()]) { return { region: { id: 'r0', label: '지역' }, window: { start: '2025-10', end: '2026-09', months: 12 }, sources, warnings: [], refreshAvailable: true }; }

test('uses twelve consecutive saved months ending at the last normal month without changing evidence', () => {
  const original = source(), before = JSON.stringify(original), value = sourcePeriod(original, '2026-09');
  assert.deepEqual(value.confirmedPeriod, { status: 'confirmed', start: '2025-09', end: '2026-08', months: 12,
    observedMonths: 12, latestConfirmedMonth: '2026-08', requestedEnd: '2026-09', excludedRecentMonths: ['2026-09'] });
  assert.deepEqual(value.metrics[0].mom, { value: 1, kind: 'index_difference' });
  assert.deepEqual(value.metrics[0].yoy, { value: 12, kind: 'index_difference' });
  assert.equal(value.metrics[0].observedMonths, 12); assert.equal(JSON.stringify(original), before);
  const html = ui.source(value, region().window);
  assert.match(html, /최근 12개월 · 확인 완료/); assert.match(html, /2025-09 ~ 2026-08/);
  assert.match(html, /2026-09은 미확인으로 기준 기간에서 제외/);
  assert.equal((html.match(/<circle/g) || []).length, 12);
});

test('eleven consecutive months are accepted but an internal gap is never joined or marked complete', () => {
  const original = source(); original.series = original.series.slice(12);
  const eleven = sourcePeriod(original, '2026-09');
  assert.equal(eleven.confirmedPeriod.months, 11); assert.equal(eleven.confirmedPeriod.status, 'confirmed');
  assert.equal(eleven.confirmedPeriod.start, '2025-10');
  assert.match(ui.source(eleven, region().window), /최근 11개월 추이/);
  const gap = source(); gap.series = gap.series.filter(row => row.month !== '2026-03');
  const incomplete = sourcePeriod(gap, '2026-09');
  assert.equal(incomplete.confirmedPeriod.status, 'insufficient');
  const html = ui.source(incomplete, region().window);
  assert.doesNotMatch(html, /확인 완료/); assert.equal((html.match(/<polyline/g) || []).length, 2);
});

test('cutoff, zero, duplicate months, invalid values and partial evidence retain their meaning', () => {
  const s = source();
  const historic = sourcePeriod(s, '2025-10');
  assert.equal(historic.confirmedPeriod.end, '2025-10'); assert.equal(historic.metrics[0].latest.value, 12);
  const zero = sourcePeriod(s, '2025-09');
  assert.equal(zero.metrics[0].low.value, 0);
  for (const invalid of [null, -1, NaN, Infinity, '3']) {
    const value = source(); value.series[19].rows[0].value = invalid;
    assert.equal(sourcePeriod(value, '2026-09').confirmedPeriod.status, 'insufficient');
  }
  const dup = source(); dup.series.push(structuredClone(dup.series[19]));
  assert.equal(sourcePeriod(dup, '2026-09').confirmedPeriod.status, 'insufficient');
  const partial = source(); partial.series[19].status = 'partial';
  assert.equal(sourcePeriod(partial, '2026-09').series.find(row => row.month === month(19)).rows[0].value, null);
});

test('sources have independent confirmed periods and search normalization and annual statistics are preserved', () => {
  const search = source('naver_search_trend'); search.normalizationPeriod = '2024-10-01 ~ 2026-09-30';
  search.series[23] = { ...search.series[23], status: 'observed', rows: [{ key: 'value', value: 42, status: 'observed' }] };
  const annual = { key: 'kosis_employment', period: '2024', rows: [{ key: 'employees', value: 100 }] };
  const result = regionPeriod(region([source(), search, annual]));
  assert.equal(result.sources[0].confirmedPeriod.end, '2026-08');
  assert.equal(result.sources[1].confirmedPeriod.end, '2026-09');
  assert.equal(result.sources[1].normalizationPeriod, search.normalizationPeriod);
  assert.equal(result.sources[2], annual);
  const outside = { untouched: true }; assert.equal(projectResponse('/companies/x/collection', outside), outside);
});

test('stored confirmed periods stay available when the old preparation job reports zero successful months', () => {
  const r = regionPeriod(region()), job = { status: 'partial', progress: { completed: 1, total: 1 },
    steps: [{ key: 'resourceDemand', label: '관광자원 수요', status: 'partial', observedMonths: 0, expectedMonths: 24, errorCode: 'PROVIDER_FAILED' }] };
  const html = ui.preparation(job, r);
  assert.match(html, /준비 처리 1\/1 항목 종료 · 기준 자료 1\/1종 확보/);
  assert.match(html, /최근 12개월 · 2025-09 ~ 2026-08/);
  assert.doesNotMatch(html, /0\/24|자료 연결 확인 필요/);
  assert.match(html, /마지막 갱신 기록/); assert.match(html, /일부 월 응답을 확보하지 못함/);
});

test('Insight customer and administrator reads share the period projection without extra upstream calls', async t => {
  let calls = 0;
  const upstream = region(), server = createConnectedServer({ origin: 'http://127.0.0.1:57997', backend: 'https://example.test', serviceToken: 'x'.repeat(40),
    fetchImpl: async url => { calls++; return { ok: true, status: 200, json: async () => url.includes('/reports/') ? { regions: [upstream] } : upstream }; } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const prefix of ['/api/customer/v1', '/api/insight-admin/v1/customer-view']) {
    for (const route of ['/regions/r0/analysis?month=2026-09', '/reports/briefing']) {
      const res = await new Promise((resolve, reject) => http.get(base + prefix + route, { headers: { Host: '127.0.0.1:57997' } }, response => {
        let body = ''; response.setEncoding('utf8'); response.on('data', chunk => { body += chunk; });
        response.on('end', () => resolve({ status: response.statusCode, data: JSON.parse(body) }));
      }).on('error', reject));
      assert.equal(res.status, 200); const data = res.data, r = data.regions?.[0] || data;
      assert.equal(r.sources[0].confirmedPeriod.end, '2026-08');
    }
  }
  assert.equal(calls, 4); assert.equal(upstream.sources[0].confirmedPeriod, undefined);
});
