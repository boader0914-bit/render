'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const adjustment = require('../web/company-adjustment.js');
const observation = values => ({ date: '2026-10-09', total: 16, sold: 16, publicBookings: 5, phoneBookings: 11, publicRevenue: 1515000, phoneRevenue: 3389000, estimatedRevenue: 4904000, ...values });

test('preview changes totals without mutating observations or redistributing channel values', () => {
  const row = Object.freeze(observation()), inputs = Object.freeze({ bookings: '12', revenue: '4000000' });
  const before = JSON.stringify(row);
  assert.deepEqual(adjustment.calculate(row, inputs, 16), { bookings: 12, revenue: 4000000, bookingDelta: -4, revenueDelta: -904000 });
  assert.equal(JSON.stringify(row), before);
  assert.deepEqual(Object.keys(adjustment.calculate(row, inputs, 16)), ['bookings', 'revenue', 'bookingDelta', 'revenueDelta']);
});

test('explicit zero is valid while a blank field preserves the original value', () => {
  assert.deepEqual(adjustment.calculate(observation(), { bookings: '', revenue: '0' }, 16), { bookings: 16, revenue: 0, bookingDelta: 0, revenueDelta: -4904000 });
  assert.deepEqual(adjustment.calculate(observation(), { bookings: 0, revenue: ' ' }, 16), { bookings: 0, revenue: 4904000, bookingDelta: -16, revenueDelta: 0 });
  const zero = observation({ sold: 0, publicBookings: 0, phoneBookings: 0, estimatedRevenue: 0 });
  assert.deepEqual(adjustment.calculate(zero, { bookings: '0', revenue: '0' }), { bookings: 0, revenue: 0, bookingDelta: 0, revenueDelta: 0 });
});

test('missing, partial and conflicting observations are not reinterpreted as zero or used for deltas', () => {
  for (const flag of ['missing', 'partial', 'inventoryConflict']) {
    const row = observation({ [flag]: true });
    assert.deepEqual(adjustment.calculate(row, { revenue: '10000' }), { bookings: null, revenue: 10000, bookingDelta: null, revenueDelta: null });
    assert.deepEqual(adjustment.calculate(row, { bookings: '1' }), { bookings: 1, revenue: null, bookingDelta: null, revenueDelta: null });
  }
  assert.deepEqual(adjustment.calculate(null, { revenue: 0 }), { bookings: null, revenue: 0, bookingDelta: null, revenueDelta: null });
  const partialPrice = observation({ revenuePartial: true });
  assert.deepEqual(adjustment.calculate(partialPrice, { bookings: 1 }), { bookings: 1, revenue: null, bookingDelta: -15, revenueDelta: null });
});

test('invalid and contradictory baseline quantities remain unknown', () => {
  for (const values of [{ publicBookings: null }, { phoneBookings: -1 }, { phoneBookings: 1.5 }, { sold: 8 }, { total: 15 }, { publicBookings: Number.MAX_SAFE_INTEGER, phoneBookings: 1, total: null, sold: null }]) {
    const result = adjustment.calculate(observation(values), { revenue: '10000' });
    assert.equal(result.bookings, null); assert.equal(result.bookingDelta, null);
  }
  for (const estimatedRevenue of [null, -1, NaN, Infinity, 1.5, '20000']) {
    const result = adjustment.calculate(observation({ estimatedRevenue }), { bookings: '1' });
    assert.equal(result.revenue, null); assert.equal(result.revenueDelta, null);
  }
});

test('inputs require nonnegative safe integers and at least one change value', () => {
  for (const values of [{}, { bookings: '', revenue: ' ' }, null, []]) assert.throws(() => adjustment.calculate(observation(), values));
  for (const invalid of [-1, 1.1, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1, true, false, {}, [], '1e3', '0x10', '1.0', '1,000', '12실', '<script>1</script>']) {
    assert.throws(() => adjustment.calculate(observation(), { bookings: invalid }));
    assert.throws(() => adjustment.calculate(observation(), { revenue: invalid }));
  }
  assert.equal(adjustment.calculate(observation(), { revenue: ' 12000 ' }).revenue, 12000);
});

test('booking limit follows known capacity without inventing capacity for unknown rooms', () => {
  assert.throws(() => adjustment.calculate(observation(), { bookings: '17' }), /16실/);
  assert.throws(() => adjustment.calculate(observation(), { bookings: '11' }, 10), /10실/);
  assert.equal(adjustment.calculate(observation({ total: null }), { bookings: '50' }).bookings, 50);
  assert.throws(() => adjustment.calculate(observation({ total: null }), { bookings: '1' }, 0), /0실/);
  assert.equal(adjustment.calculate(observation(), { revenue: '6000000' }, 10).bookings, 16);
});

test('prepared editor stays locked for own company and is absent for competitors and invalid dates', () => {
  for (const own of [undefined, false, 'true', 1]) assert.equal(adjustment.render(observation(), { own }), '');
  for (const date of [undefined, '2026-02-30', '<img src=x onerror=alert(1)>', '2026-10-09" onfocus="alert(1)']) assert.equal(adjustment.render(observation({ date }), { own: true }), '');
  const html = adjustment.render(observation(), { own: true, capacity: 16 });
  assert.equal(adjustment.isEnabled(), false);
  assert.match(html, /예약·매출 수정/); assert.match(html, /수집자료 통합 후 이용할 수 있습니다\./);
  assert.match(html, /type="button" disabled>수정 준비 중/);
  assert.doesNotMatch(html, /<form|<input|type="submit"|data-company-adjustment-preview|저장하기|action=|method=|<script| on\w+=/);
  assert.equal(adjustment.render(observation(), { own: true, enabled: true, editingEnabled: true, preview: true }), html);
});

test('browser bundle defines only a pure API and never registers events or accesses storage or network', () => {
  const source = fs.readFileSync(require.resolve('../web/company-adjustment.js'), 'utf8');
  const forbidden = new Proxy({}, { get() { throw new Error('unexpected side effect'); } });
  const context = { window: {}, document: forbidden, localStorage: forbidden, sessionStorage: forbidden, fetch: () => { throw new Error('network'); } };
  vm.runInNewContext(source, context);
  assert.equal(typeof context.window.InsightCompanyAdjustment.calculate, 'function');
  assert.equal(typeof context.window.InsightCompanyAdjustment.render, 'function');
  const result = context.window.InsightCompanyAdjustment.calculate(observation(), { revenue: 0 });
  assert.equal(result.revenue, 0); assert.equal(result.revenueDelta, -4904000);
});
