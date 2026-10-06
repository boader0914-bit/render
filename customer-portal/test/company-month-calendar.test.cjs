'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function view() {
  const window = {}, context = vm.createContext({ window, URL });
  for (const file of ['company-flow.js', 'company-products.js', 'company-adjustment.js', 'company-view.js']) {
    vm.runInContext(fs.readFileSync(require.resolve('../web/' + file), 'utf8'), context);
  }
  return window.InsightCompanyView;
}
function freeze(value) {
  if (value && typeof value === 'object') { for (const item of Object.values(value)) freeze(item); Object.freeze(value); }
  return value;
}
const day = (date, values = {}) => ({ date, total: 16, sold: 5, publicBookings: 5, phoneBookings: 0, publicRevenue: 500000, phoneRevenue: 0, estimatedRevenue: 500000, ...values });
function fixture(daily) {
  return freeze({
    result: { rooms: 17, roomCountSource: '이번 관측', productCount: 0, products: [], dayUse: {}, days: [], issues: [], range: { start: daily[0]?.date, end: daily.at(-1)?.date, days: daily.length } },
    companyDetail: { basics: { name: '월간 검수 업체', rooms: 16, roomCountSource: 'DB 검수', lodgingTypes: [] }, channels: [], current: { daily, summary: null }, history: null },
  });
}
const cells = html => [...html.matchAll(/<button\b[^>]*data-company-date="([^"]+)"[^>]*>[\s\S]*?<\/button>/g)].map(match => ({ date: match[1], html: match[0] }));
const nav = (html, name) => html.match(new RegExp('<button\\b[^>]*aria-label="' + name + '"[^>]*>'))?.[0];

test('monthly calendar shows only the chosen month and orders weekdays from Monday', () => {
  const ui = view(), data = fixture([day('2026-10-01'), day('2026-11-01')]);
  const october = ui.currentView(data, { mode: 'calendar', day: '2026-10-01', calendarMonth: '2026-10' });
  assert.deepEqual([...october.matchAll(/<div class="db-weekday[^>]*>([^<]+)<\/div>/g)].map(match => match[1]), ['월', '화', '수', '목', '금', '토', '일']);
  assert.equal(cells(october).length, 31); assert.ok(cells(october).every(cell => cell.date.startsWith('2026-10-')));
  assert.equal((october.match(/class="company-month-calendar"/g) || []).length, 1);
  const beforeFirstDay = october.slice(0, october.indexOf('<button type="button" data-company-date="2026-10-01"'));
  assert.equal((beforeFirstDay.match(/class="company-month-blank"/g) || []).length, 3, 'October 1, 2026 is Thursday, after three Monday-first blanks');
  const november = ui.currentView(data, { mode: 'calendar', day: '2026-10-01', calendarMonth: '2026-11' });
  assert.equal(cells(november).length, 30); assert.ok(cells(november).every(cell => cell.date.startsWith('2026-11-')));
  assert.match(november, /option value="2026-11" selected/);
});

test('previous and next month controls stop at the observed range boundaries', () => {
  const ui = view(), data = fixture([day('2026-10-01'), day('2026-11-01')]);
  const first = ui.currentView(data, { mode: 'calendar', calendarMonth: '2026-10' });
  assert.match(nav(first, '이전 달'), /disabled/); assert.doesNotMatch(nav(first, '다음 달'), /disabled/);
  assert.match(nav(first, '다음 달'), /data-calendar-month="2026-11"/);
  const last = ui.currentView(data, { mode: 'calendar', calendarMonth: '2026-11' });
  assert.doesNotMatch(nav(last, '이전 달'), /disabled/); assert.match(nav(last, '다음 달'), /disabled/);
  assert.match(nav(last, '이전 달'), /data-calendar-month="2026-10"/);
  const only = ui.currentView(fixture([day('2026-10-01')]), { mode: 'calendar' });
  assert.match(nav(only, '이전 달'), /disabled/); assert.match(nav(only, '다음 달'), /disabled/);
});

test('leap-year February has 29 dated cells and a complete Monday-first week grid', () => {
  const ui = view(), data = fixture([day('2024-02-01'), day('2024-02-29')]);
  const html = ui.currentView(data, { mode: 'calendar', day: '2024-02-29', calendarMonth: '2024-02' });
  const dates = cells(html);
  assert.equal(dates.length, 29); assert.equal(dates.at(-1).date, '2024-02-29');
  assert.match(dates.at(-1).html, /aria-pressed="true"/); assert.doesNotMatch(html, /data-company-date="2024-02-30"/);
  assert.equal((html.match(/class="company-month-blank"/g) || []).length, 6, 'three leading and three trailing blanks fill five complete weeks');
});

test('normal zero remains visible and purple requires a positive non-error estimate', () => {
  const ui = view(), data = fixture([
    day('2026-10-01', { sold: 0, publicBookings: 0, phoneBookings: 0, publicRevenue: 0, phoneRevenue: 0, estimatedRevenue: 0 }),
    day('2026-10-02', { sold: 7, phoneBookings: 2, phoneRevenue: 200000, estimatedRevenue: 700000 }),
    day('2026-10-03', { phoneBookings: 5, partial: true }),
    day('2026-10-04', { phoneBookings: 5, inventoryConflict: true }),
    day('2026-10-05', { missing: true }),
  ]);
  const html = ui.currentView(data, { mode: 'calendar', calendarMonth: '2026-10' });
  const byDate = new Map(cells(html).map(cell => [cell.date, cell.html]));
  assert.match(byDate.get('2026-10-01'), /has-public/); assert.match(byDate.get('2026-10-01'), /<b>0실<\/b>/); assert.match(byDate.get('2026-10-01'), /<b>0만원<\/b>/);
  assert.doesNotMatch(byDate.get('2026-10-01'), /타채널·전화/);
  assert.match(byDate.get('2026-10-02'), /has-estimate/); assert.match(byDate.get('2026-10-02'), /타채널·전화 2실 · 20만원/);
  assert.equal((html.match(/has-estimate/g) || []).length, 1);
  for (const date of ['2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06']) {
    assert.match(byDate.get(date), /unobserved/); assert.match(byDate.get(date), /미확인/);
    assert.doesNotMatch(byDate.get(date), /has-estimate|<b>0실<\/b>|<b>0만원<\/b>|타채널·전화 5실/);
  }
});

test('current DB-reviewed rooms take precedence over the older result while corrections remain locked', () => {
  const ui = view(), data = fixture([day('2026-10-09')]);
  const summary = ui.summaryView(data, { day: '2026-10-09' });
  assert.match(summary, /객실 총량<\/span><strong>16실<\/strong>/); assert.doesNotMatch(summary, /17실/);
  const html = ui.render(data, '', { mode: 'calendar', own: true, day: '2026-10-09' });
  assert.match(html, /DB 검수/); assert.doesNotMatch(html, /17실/);
  assert.match(html, /disabled>수정 준비 중/); assert.doesNotMatch(html, /name="bookings"/);
});

test('day detail shows the locked editor only for the own company and preserves unknown observations', () => {
  const ui = view(), data = fixture([day('2026-10-09')]);
  const own = ui.dayDetail(data, { day: '2026-10-09', own: true });
  assert.match(own, /ca-locked/); assert.match(own, /disabled>수정 준비 중/); assert.doesNotMatch(own, /data-company-adjustment-preview/);
  for (const options of [{ day: '2026-10-09' }, { day: '2026-10-09', own: false }, { day: 'period', own: true }]) {
    assert.doesNotMatch(ui.dayDetail(data, options), /ca-locked|data-company-adjustment-preview/);
  }
  const absent = ui.dayDetail(data, { day: '2026-10-10', own: true });
  assert.match(absent, /미확인/); assert.match(absent, /disabled>수정 준비 중/);
  assert.doesNotMatch(absent, /예약<\/span><strong>0실/);
});

test('rendering every presentation preserves the stored data and default view emphasizes the graph', () => {
  const ui = view(), data = fixture([day('2026-10-09'), day('2026-11-01')]), before = JSON.stringify(data);
  for (const mode of ['default', 'graph', 'calendar', 'table', 'list']) {
    ui.render(data, '', { mode, own: true, day: '2026-10-09' });
    ui.currentView(data, { mode, day: '2026-10-09', calendarMonth: '2026-10' });
  }
  const graph = ui.currentView(data, { mode: 'default' });
  assert.match(graph, /data-chart-metric="bookings"/); assert.match(graph, /data-chart-metric="revenue"/);
  assert.doesNotMatch(graph, /class="company-month-calendar"/);
  assert.equal(JSON.stringify(data), before);
});
