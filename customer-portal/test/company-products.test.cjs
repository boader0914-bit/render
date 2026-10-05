'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const products = require('../web/company-products.js');
const day = (date, price, total = 3, status = 'observed') => ({ date, price, total, status });

test('normal dated observations form four separate weekday price ranges without changing the source', () => {
  const result = { products: [{ key: 'lodging:a', name: 'A동', productType: 'lodging', days: [day('2026-10-05', 100000), day('2026-10-08', 150000, 4), day('2026-10-09', 190000), day('2026-10-10', 230000), day('2026-10-11', 110000)] }] };
  const before = JSON.stringify(result), model = products.summarize(result);
  assert.deepEqual(model.products[0].prices, { weekday: { min: 100000, max: 150000, days: 2 }, friday: { min: 190000, max: 190000, days: 1 }, saturday: { min: 230000, max: 230000, days: 1 }, sunday: { min: 110000, max: 110000, days: 1 } });
  assert.equal(model.products[0].maxRooms, 4);
  assert.equal(model.products[0].observedDays, 5);
  assert.equal(JSON.stringify(result), before);
  const html = products.render(result);
  assert.match(html, /100,000 ~ 150,000원/);
  assert.match(html, /요일별 관측 판매가격 · 공휴일 요금 구분 없음/);
  assert.match(html, /평일 \(월~목\)/);
});

test('normal zero prices and room counts are preserved while errors and missing responses are excluded', () => {
  const result = { products: [{ name: '제로', productType: 'lodging', days: [day('2026-10-05', 0, 0), day('2026-10-06', 900000, 90, 'error'), day('2026-10-07', 900000, 91, 'missing'), day('2026-10-08', 900000, 92, 'not_requested'), day('2026-10-09', null, null)] }] };
  const product = products.summarize(result).products[0];
  assert.equal(product.maxRooms, 0);
  assert.deepEqual(product.prices.weekday, { min: 0, max: 0, days: 1 });
  assert.equal(product.prices.friday, null);
  const html = products.render(result);
  assert.match(html, /0실/);
  assert.match(html, /0원/);
  assert.doesNotMatch(html, /900,000|9[012]실/);
});

test('invalid calendar days and invalid numeric data cannot become displayed evidence', () => {
  const result = { products: [{ days: [day('2026-02-30', 900000, 99), day('2026-10-05', '', '5'), day('2026-10-06', NaN, -1), day('2026-10-07', Infinity, 1.5), day('2026-10-08', -50, null), day('no-date', 900000, 99), { date: '2026-10-09', price: 999, total: 3 }] }] };
  const product = products.summarize(result).products[0];
  assert.equal(product.maxRooms, null);
  assert.ok(Object.values(product.prices).every(value => value === null));
  assert.doesNotMatch(products.render(result), /900,000|99실|NaN|Infinity/);
});

test('dayuse stays separate from lodging and no product maximums are added into company capacity', () => {
  const model = products.summarize({ products: [{ name: '숙박', productType: 'lodging', days: [day('2026-10-05', 100, 8)] }, { name: '데이유즈', productType: 'dayuse', days: [day('2026-10-05', 20, 8)] }] });
  assert.equal(model.productCount, 2);
  assert.deepEqual(model.products.map(product => [product.typeLabel, product.maxRooms]), [['숙박', 8], ['데이유즈', 8]]);
  assert.equal(model.rooms, undefined);
});

test('empty or malformed results stay safe, and untrusted product fields cannot create links or markup', () => {
  for (const result of [undefined, null, {}, { products: null }, { products: {} }, { products: [null, false, 'bad'] }]) {
    assert.equal(products.summarize(result).productCount, 0);
    assert.match(products.render(result), /저장된 상품 자료가 없습니다/);
  }
  const html = products.render({ products: [{ name: '<img src=x onerror="alert(1)">', productType: '__proto__', key: '" onclick="bad', url: 'javascript:alert(1)', days: [] }] });
  assert.match(html, /&lt;img/);
  assert.match(html, /구분 확인 전/);
  assert.doesNotMatch(html, /<img|href=|onclick=/);
});

test('browser script exports the same public module without CommonJS globals', () => {
  const context = { window: {} };
  vm.runInNewContext(fs.readFileSync(require.resolve('../web/company-products.js'), 'utf8'), context);
  assert.equal(typeof context.window.InsightCompanyProducts.render, 'function');
  assert.equal(typeof context.window.InsightCompanyProducts.summarize, 'function');
  assert.match(context.window.InsightCompanyProducts.render(null), /cp-empty/);
});
