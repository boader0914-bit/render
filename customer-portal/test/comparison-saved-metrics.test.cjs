'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {projectCompany, reasonLabels} = require('../web/comparison-saved-metrics.js');
const companyId = 'cmp_place_123', previous = '2026-10-27T03:00:00.000Z', current = '2026-10-28T03:00:00.000Z';
const options = {companyId, asOf:'2026-10-30', dates:['2026-10-30','2026-10-31']};
const day = (date, price, extra = {}) => ({date, status:'observed', errorCode:null, price, ...extra});
const interval = (date, publicChange, blockedChange = 0, extra = {}) => ({date, previousCollectedAt:previous, collectedAt:current, publicChange, blockedChange, netChange:publicChange+blockedChange, ...extra});
function fixture() {
  return {result:{companyId, runId:'run_20261028', collectedAt:current, range:{start:'2026-10-30',end:'2026-11-01',days:3}, quality:{status:'complete'}, truncated:false,
    products:[{bizItemId:'one', key:'lodging:one', name:'객실A', productType:'lodging', days:[day('2026-10-30',100000),day('2026-10-31',120000),day('2026-11-01',90000)]},
      {bizItemId:'two', key:'lodging:two', name:'객실B', productType:'lodging', days:[day('2026-10-30',200000),day('2026-10-31',220000),day('2026-11-01',190000)]},
      {bizItemId:'day', key:'dayuse:day', name:'런치', productType:'dayuse', days:[day('2026-10-30',1),day('2026-10-31',1)]}]},
    companyDetail:{companyId, basics:{companyId}, integrated:{companyId,status:'ready',selectedMonth:'2026-10',calculationVersion:'company-integrated-v4-product-max-room-reuse',roomBasis:{count:10,reviewRequired:false},
      snapshot:{period:{start:'2026-10-01',end:'2026-10-31',cutoffDate:'2026-10-30'},analysis:{pickup:{status:'ready',comparableIntervals:2,intervals:[interval('2026-10-30',2,1),interval('2026-10-31',-1,0)]}}}}}};
}

test('price is the deduplicated lodging product-date median with a bound source, not revenue / bookings', () => {
  const source=fixture(),before=JSON.stringify(source),model=projectCompany(source,options);
  assert.equal(model.price.value,160000);assert.equal(model.price.min,100000);assert.equal(model.price.max,220000);
  assert.equal(model.price.products,2);assert.equal(model.price.days,2);assert.equal(model.price.rowCount,4);assert.equal(model.price.status,'ready');
  assert.equal(model.price.source.runId,'run_20261028');assert.equal(JSON.stringify(source),before);
  assert.ok(model.price.rows.every(row=>row.productId!=='id:day'));
});
test('daily detail price rows expose only verified filtered lodging observations with the exact source identity',()=>{
  const source=fixture();source.result.products[0].privateCookie='PRIVATE-COOKIE';source.result.products[0].days[0].rawResponse={token:'PRIVATE-ROW'};
  source.result.products[0].original=[day('2026-10-30',999999)];
  const model=projectCompany(source,{...options,dates:['2026-10-30']});
  assert.equal(model.price.rows.length,2);assert.deepEqual(model.price.rows.map(row=>row.price),[100000,200000]);
  assert.ok(model.price.rows.every(row=>row.date==='2026-10-30'));
  assert.ok(model.price.rows.every(row=>JSON.stringify(Object.keys(row).sort())===JSON.stringify(['date','price','productId','productName'])));
  assert.equal(model.price.source.runId,'run_20261028');assert.equal(model.price.source.collectedAt,current);
  assert.doesNotMatch(JSON.stringify(model),/PRIVATE-COOKIE|PRIVATE-ROW|999999|런치/);
});
test('price and pickup detail rows do not invent values on selected dates with no validated evidence',()=>{
  const source=fixture(),model=projectCompany(source,{...options,dates:['2026-11-02']});
  assert.equal(model.price.value,null);assert.deepEqual(model.price.rows,[]);assert.equal(model.pickup.value,null);assert.deepEqual(model.pickup.rows,[]);
  assert.equal(model.price.reasonCode,'PRICE_MISSING');assert.equal(model.pickup.reasonCode,'PICKUP_OUTSIDE_SELECTED_DATES');
});
test('selected date filtering recomputes prices and preserves a genuine observed free price', () => {
  const source=fixture();source.result.products=source.result.products.slice(0,1);source.result.products[0].days[0].price=0;
  const model=projectCompany(source,{...options,dates:['2026-10-30']});
  assert.equal(model.price.value,0);assert.equal(model.price.rowCount,1);assert.equal(model.price.status,'ready');
});
test('identical product/date entries across month payloads count once; conflicting prices do not pick an arbitrary value', () => {
  const source=fixture(),copy=structuredClone(source);
  assert.equal(projectCompany([source,copy],options).price.rowCount,4);
  copy.result.products[0].days[0].price=999999;
  const model=projectCompany([source,copy],options);
  assert.equal(model.price.rowCount,3);assert.equal(model.price.status,'partial');
  assert.ok(model.price.reasonCodes.includes('PRICE_DUPLICATE_CONFLICT'));assert.equal(model.price.rows.some(row=>row.productId==='id:one'&&row.date==='2026-10-30'),false);
});
test('error/missing 0 prices do not become free or overwrite a different stored normal price', () => {
  const source=fixture();source.result.products=source.result.products.slice(0,1);
  source.result.products[0].days.push(day('2026-10-30',0,{status:'error',errorCode:'BLOCKED'}));
  const model=projectCompany(source,options);
  assert.equal(model.price.rowCount,1);assert.equal(model.price.value,120000);assert.equal(model.price.status,'partial');
  source.result.products[0].days=[day('2026-10-30',0,{status:'error'})];
  assert.equal(projectCompany(source,options).price.value,null);
});
test('normal rows of a partial run are retained and explicitly marked partial; blocked/failed source is not accepted', () => {
  const source=fixture();source.result.quality.status='partial';
  assert.equal(projectCompany(source,options).price.rowCount,4);assert.equal(projectCompany(source,options).price.status,'partial');
  source.result.quality.status='failed';assert.equal(projectCompany(source,options).price.value,null);
  source.result.quality.status='complete';source.result.truncated=true;
  assert.equal(projectCompany(source,options).price.status,'partial');
});
test('an absent response is not a context mismatch; invalid actual payload remains a context mismatch', () => {
  for(const source of [null,undefined,[]]){
    const model=projectCompany(source,options);
    assert.equal(model.price.reasonCode,'PRICE_NOT_CONNECTED');assert.equal(model.pickup.reasonCode,'PICKUP_NOT_CONNECTED');
  }
  assert.equal(projectCompany('invalid response',options).price.reasonCode,'SOURCE_CONTEXT_MISMATCH');
});
test('a newer invalid source cannot silently fall back to an older positive price', () => {
  const older=fixture(),latest=fixture();
  latest.result.collectedAt='2026-10-29T03:00:00Z';latest.result.runId='newer_failed';latest.result.quality.status='failed';
  const model=projectCompany([older,latest],options).price;
  assert.equal(model.value,null);assert.equal(model.reasonCode,'PRICE_MISSING');
});
test('company, expected run, future observation and conflicting range are held rather than silently mixed', () => {
  const source=fixture();
  assert.equal(projectCompany(source,{...options,companyId:'someone_else'}).price.reasonCode,'SOURCE_CONTEXT_MISMATCH');
  assert.equal(projectCompany(source,{...options,expectedRunId:'other'}).price.value,null);
  assert.equal(projectCompany(source,{...options,expectedCollectedAt:'2026-10-28T05:00:00Z'}).price.value,null);
  source.result.collectedAt='2026-10-31T03:00:00Z';assert.equal(projectCompany(source,options).price.value,null);
  const a=fixture(),b=fixture();b.result.range.end='2026-11-02';
  assert.equal(projectCompany([a,b],options).price.reasonCode,'SOURCE_CONTEXT_MISMATCH');
});
test('single latest exact observation pair yields signed reference pickup with separate inferred change', () => {
  const model=projectCompany(fixture(),options).pickup;
  assert.equal(model.value,1);assert.equal(model.publicChange,1);assert.equal(model.inferredChange,1);assert.equal(model.days,2);assert.equal(model.status,'reference');
  assert.equal(model.source.previousObservedAt,previous);assert.equal(model.source.currentObservedAt,current);
  assert.ok(model.limitations.some(value=>value.includes('新規')||value.includes('신규 예약')));
  assert.ok(model.limitations.some(value=>value.includes('수집번호')));
});
test('zero and negative public pickup are genuine observations; missing prior source remains null', () => {
  const source=fixture(),pickup=source.companyDetail.integrated.snapshot.analysis.pickup;
  pickup.status='no_increase';pickup.intervals=[interval('2026-10-30',0)];
  assert.equal(projectCompany(source,options).pickup.value,0);
  pickup.intervals=[interval('2026-10-30',-3)];assert.equal(projectCompany(source,options).pickup.value,-3);
  pickup.intervals=[];assert.equal(projectCompany(source,options).pickup.value,null);assert.equal(projectCompany(source,options).pickup.reasonCode,'PICKUP_NO_PREVIOUS_OBSERVATION');
});
test('earlier month pickup totals and same-run originals never substitute for selected-date pickup', () => {
  const source=fixture(),pickup=source.companyDetail.integrated.snapshot.analysis.pickup;
  pickup.net=999;pickup.intervals=[interval('2026-10-01',0)];source.result.products[0].original=[{date:'2026-10-30',publicBookings:99}];
  const model=projectCompany(source,options);
  assert.equal(model.pickup.value,null);assert.equal(model.pickup.reasonCode,'PICKUP_OUTSIDE_SELECTED_DATES');
});
test('different observation pairs stay separate and deterministic latest pair wins, without summing older movement', () => {
  const source=fixture(),pickup=source.companyDetail.integrated.snapshot.analysis.pickup;
  pickup.intervals.push(interval('2026-10-30',8,0,{previousCollectedAt:'2026-10-28T03:00:00Z',collectedAt:'2026-10-29T03:00:00Z'}));
  const model=projectCompany(source,options).pickup;
  assert.equal(model.value,8);assert.equal(model.days,1);assert.equal(model.source.currentObservedAt,'2026-10-29T03:00:00.000Z');
  assert.ok(model.limitations.some(value=>value.includes('다른 관측')||value.includes('다른 1개 구간')));
});
test('timestamp pair/date duplicates count once; conflicts exclude that date and do not poison unrelated normal date', () => {
  const source=fixture(),pickup=source.companyDetail.integrated.snapshot.analysis.pickup;
  pickup.intervals.push(structuredClone(pickup.intervals[0]));assert.equal(projectCompany(source,options).pickup.value,1);
  pickup.intervals.push(interval('2026-10-30',3));
  const model=projectCompany(source,options).pickup;
  assert.equal(model.value,-1);assert.equal(model.days,1);assert.ok(model.reasonCodes.includes('PICKUP_INVALID_EVIDENCE'));
});
test('future, post-stay, malformed quantity and status disagreement are not treated as zero pickup', () => {
  for(const mutate of [
    row=>Object.assign(row,{collectedAt:'2026-10-31T03:00:00Z'}),
    row=>Object.assign(row,{previousCollectedAt:current,collectedAt:previous}),
    row=>Object.assign(row,{netChange:100}),
    row=>Object.assign(row,{publicChange:0.5,netChange:1.5})
  ]){
    const source=fixture();source.companyDetail.integrated.snapshot.analysis.pickup.intervals=[interval('2026-10-30',2,1)];mutate(source.companyDetail.integrated.snapshot.analysis.pickup.intervals[0]);
    assert.equal(projectCompany(source,options).pickup.value,null);
  }
  const source=fixture();source.companyDetail.integrated.snapshot.analysis.pickup.status='no_increase';
  assert.equal(projectCompany(source,options).pickup.value,null);
});
test('monthly source scopes must match and recent truncated interval lists are labelled as subsets', () => {
  const source=fixture();source.companyDetail.integrated.snapshot.analysis.pickup.comparableIntervals=999;
  const model=projectCompany(source,options).pickup;
  assert.equal(model.value,1);assert.ok(model.reasonCodes.includes('PICKUP_RECENT_SUBSET'));
  source.companyDetail.integrated.selectedMonth='2026-11';assert.equal(projectCompany(source,options).pickup.reasonCode,'SOURCE_CONTEXT_MISMATCH');
});
test('cross-month pickup combines only the same timestamp pair and selected stay dates; duplicate monthly payload is idempotent', () => {
  const october=fixture(),november=fixture();
  november.companyDetail.integrated.selectedMonth='2026-11';november.companyDetail.integrated.snapshot.period={start:'2026-11-01',end:'2026-11-30',cutoffDate:'2026-10-30'};
  november.companyDetail.integrated.snapshot.analysis.pickup.intervals=[interval('2026-11-01',4,1)];
  const selected={...options,dates:['2026-10-31','2026-11-01']};
  const model=projectCompany([october,november,november],selected).pickup;
  assert.equal(model.publicChange,3);assert.equal(model.inferredChange,1);assert.equal(model.days,2);assert.equal(model.status,'reference');
  november.companyDetail.integrated.calculationVersion='changed';assert.equal(projectCompany([october,november],selected).pickup.reasonCode,'SOURCE_CONTEXT_MISMATCH');
});
test('invalid inputs cannot throw or turn missing selected dates into normal zero', () => {
  for(const payload of [null,undefined,{},[],[{}],{result:null},fixture()]) {
    for(const opts of [{},options,{...options,dates:['2026-02-30']},{...options,dates:['2026-10-30','2026-10-30']},{...options,dates:[]}]) {
      assert.doesNotThrow(()=>projectCompany(payload,opts));
    }
  }
  assert.equal(projectCompany(fixture(),{...options,dates:[]}).price.value,null);
  assert.ok(Object.values(reasonLabels).every(value=>typeof value==='string'&&value.length>0));
});
