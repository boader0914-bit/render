'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {pathToFileURL} = require('node:url');
const path = require('node:path');
const load = () => import(pathToFileURL(path.resolve(__dirname,'../review/keyword-comparison/src/content/dashboard/action-ui-state.mjs')));

test('blank scenario costs, rates, baseline and quota remain unknown while explicit zero is preserved', async () => {
  const {scenarioNumber} = await load();
  for (const missing of ['', '   ', null, undefined, NaN, Infinity, 'not a number']) assert.equal(scenarioNumber(missing), null);
  assert.equal(scenarioNumber('0'), 0);
  assert.equal(scenarioNumber(0), 0);
  assert.equal(scenarioNumber('5.5'), 5.5);
  assert.equal(scenarioNumber('199000'), 199000);
});

test('priority list preserves saved rows, puts conditional date reviews before held days and filters without filling gaps', async () => {
  const {actionRows} = await load();
  const days = [
    {date:'2026-09-22',leadDays:0,action:'hold'},
    {date:'2026-09-26',leadDays:4,action:'maintain_price'},
    {date:'2026-09-24',leadDays:2,action:'limited_coupon_review'},
    {date:'2026-09-23',leadDays:1,action:'sales_conditions_review'},
    {date:'2026-09-25',leadDays:3,action:'limited_coupon_review'}
  ];
  const before = JSON.stringify(days);
  assert.deepEqual(actionRows(days).map(day=>day.date),['2026-09-24','2026-09-25','2026-09-23','2026-09-26','2026-09-22']);
  assert.deepEqual(actionRows(days,'hold').map(day=>day.date),['2026-09-22']);
  assert.equal(actionRows(days,'limited_coupon_review').length,2);
  assert.equal(actionRows(days,'unknown_direction').length,0);
  assert.equal(JSON.stringify(days),before);
});

test('changing the common filters cannot leave a removed date selected or invent a selection for an empty result', async () => {
  const {selectedActionDay} = await load();
  const rows=[{date:'2026-09-24',action:'limited_coupon_review'},{date:'2026-10-03',action:'maintain_price'}];
  assert.equal(selectedActionDay(rows,'2026-10-03').date,'2026-10-03');
  assert.equal(selectedActionDay(rows,'2026-09-01').date,'2026-09-24');
  assert.equal(selectedActionDay([], '2026-09-24'),null);
});

test('scenario price selection never converts a missing or zero price into a usable saved product', async () => {
  const {scenarioProduct} = await load();
  const products=[{id:'missing',price:null},{id:'closed',price:0},{id:10,price:199000},{id:'20',price:209000}];
  assert.equal(scenarioProduct(products,'missing').id,10);
  assert.equal(scenarioProduct(products,'20').price,209000);
  assert.equal(scenarioProduct(products.slice(0,2),'missing'),null);
  assert.equal(scenarioProduct([],''),null);
});
