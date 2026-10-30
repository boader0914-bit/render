'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {createHash}=require('node:crypto');
const {VERSION,CALCULATION_VERSION,LIMITS,validatePublicBookingLedger,computePublicBookingPickup}=require('../lib/public-booking-pickup.cjs');
const companyId='cmp_place_1460523479',placeId='1460523479';
const previous='2026-10-27T04:20:05.714Z',current='2026-10-28T06:03:04.516Z';
const options={companyId,placeId,asOf:'2026-10-30',dates:['2026-10-30','2026-10-31']};
function source(runId,collectedAt){
  const products=['one','two'].map(bizItemId=>({bizItemId,productType:'lodging',listType:'객실 종류별 리스트',availabilityUnit:'재고수량'}));
  return {runId,collectedAt,sourceDigest:createHash('sha256').update(runId).digest('hex'),products,
    rows:options.dates.flatMap(date=>products.map(product=>({companyId,placeId,runId,collectedAt,...product,date,
      stock:10,bookingCount:1,responseStatus:200,collectionFailed:false,errorCode:null,stockObserved:true,inventoryObserved:true,inventoryConflict:false,salesEvidence:'bookingCount'})))};
}
function fixture(){return {version:VERSION,companyId,placeId,sources:[source('previous',previous),source('current',current)]};}
const calculate=(value,opts=options)=>computePublicBookingPickup(value,opts);

test('same-product public counts compute signed change with exact source and product provenance only',()=>{
  const ledger=fixture();ledger.sources[1].rows[0].bookingCount=3;
  const before=JSON.stringify(ledger),model=calculate(ledger);
  assert.equal(model.calculationVersion,CALCULATION_VERSION);assert.equal(model.companyId,companyId);assert.equal(model.status,'reference');
  assert.equal(model.previousPublic,4);assert.equal(model.currentPublic,6);assert.equal(model.publicChange,2);assert.equal(model.days,2);
  assert.equal(model.rows[0].publicChange,2);assert.equal(model.rows[0].productCount,2);assert.deepEqual(model.rows[0].matchedProductIds,['one','two']);
  assert.equal(model.source.previousRunId,'previous');assert.equal(model.source.currentRunId,'current');
  assert.deepEqual(model.source.sourceDigests,{previous:ledger.sources[0].sourceDigest,current:ledger.sources[1].sourceDigest});
  assert.match(model.source.ledgerDigest,/^[a-f0-9]{64}$/);assert.match(model.rows[0].productEvidence[0].previousRowDigest,/^[a-f0-9]{64}$/);
  assert.equal(model.publicOnly,true);assert.equal(model.wholeReservationRestored,false);assert.equal(model.inferredChange,null);assert.equal(model.estimatedRevenue,null);
  assert.equal(model.actionable,false);assert.equal(model.executionAllowed,false);assert.equal(JSON.stringify(ledger),before);
});
test('selected dates are recomputed and genuine zero/negative changes retain signed values',()=>{
  const ledger=fixture();
  assert.equal(calculate(ledger).publicChange,0);
  ledger.sources[1].rows[0].bookingCount=0;
  assert.equal(calculate(ledger).publicChange,-1);
  assert.equal(calculate(ledger,{...options,dates:['2026-10-31']}).publicChange,0);
});
test('price, phone, total-room and sharing verdicts cannot change a direct public-count delta',()=>{
  const ledger=fixture();ledger.sources[1].rows[0].bookingCount=2;
  for(const s of ledger.sources)for(const row of s.rows)Object.assign(row,{phoneBookings:999,estimatedRevenue:1e9,quantityStatus:'unknown',sharedDayUseUnverified:true,capacityConflict:true});
  const model=calculate(ledger);assert.equal(model.publicChange,1);assert.equal(model.inferredChange,null);assert.equal(model.estimatedRevenue,null);
  assert.equal(JSON.stringify(model).includes('phoneBookings'),false);
});
test('company/place/run/observed timestamp boundaries must all match, including hidden unrelated rows',()=>{
  for(const [key,value] of [['companyId','other'],['placeId','999'],['runId','other'],['collectedAt','2026-10-26T00:00:00Z']]){
    const ledger=fixture();ledger.sources[0].rows[0][key]=value;
    assert.equal(calculate(ledger).reasonCode,'SOURCE_CONTEXT_MISMATCH');
  }
  assert.equal(calculate(fixture(),{...options,companyId:'other'}).reasonCode,'SOURCE_CONTEXT_MISMATCH');
  assert.equal(calculate(fixture(),{...options,placeId:'999'}).reasonCode,'SOURCE_CONTEXT_MISMATCH');
});
test('source IDs and row timestamps normalize equivalent timezones without losing identity',()=>{
  const ledger=fixture();ledger.sources[0].collectedAt='2026-10-27T13:20:05.714+09:00';
  assert.equal(calculate(ledger).status,'reference');assert.equal(calculate(ledger).source.previousObservedAt,previous);
});
test('raw digest is mandatory and supplied normalized/ledger digest must verify',()=>{
  const ledger=fixture();assert.equal(validatePublicBookingLedger(ledger).ok,true);
  ledger.sources[0].sourceDigest='bad';assert.equal(calculate(ledger).reasonCode,'LEDGER_INVALID');
  const invalid=fixture();invalid.ledgerDigest='f'.repeat(64);assert.equal(calculate(invalid).reasonCode,'SOURCE_DIGEST_MISMATCH');
  const versioned=fixture();versioned.ledgerDigest=validatePublicBookingLedger(versioned).ledgerDigest;
  assert.equal(calculate(versioned).status,'reference');versioned.sources[1].rows[0].bookingCount=2;
  assert.equal(calculate(versioned).reasonCode,'SOURCE_DIGEST_MISMATCH');
  const normalized=fixture();normalized.sources[0].normalizedDigest='f'.repeat(64);
  assert.equal(calculate(normalized).reasonCode,'SOURCE_DIGEST_MISMATCH');
});
test('full product IDs and inventory units must match; no best-effort smaller product set',()=>{
  for(const mutate of [
    s=>{s.products.pop();s.rows=s.rows.filter(row=>row.bizItemId==='one');},
    s=>{s.products[0].availabilityUnit='객실상품';for(const row of s.rows)if(row.bizItemId==='one')row.availabilityUnit='객실상품';},
    s=>{s.products[0].listType='객실별 예약리스트';for(const row of s.rows)if(row.bizItemId==='one')row.listType='객실별 예약리스트';}
  ]){const ledger=fixture();mutate(ledger.sources[1]);assert.equal(calculate(ledger).reasonCode,'PRODUCT_SET_CHANGED');}
});
test('dayuse products cannot be relabelled as lodging or included in the public lodging ledger',()=>{
  const ledger=fixture();ledger.sources[0].products[0].productType='dayuse';assert.equal(calculate(ledger).status,'unavailable');
  const row=fixture();row.sources[0].rows[0].productType='dayuse';assert.equal(calculate(row).status,'unavailable');
});
test('one missing product response makes its whole day unknown; other full dates remain available',()=>{
  const ledger=fixture();ledger.sources[1].rows.pop();
  const model=calculate(ledger);assert.equal(model.days,1);assert.equal(model.publicChange,0);assert.equal(model.excludedDates[0].date,'2026-10-31');
  assert.equal(model.excludedDates[0].reasonCode,'PUBLIC_RESPONSE_UNVERIFIED');
});
test('all explicit raw response gates are required; an HTTP200 error body is not success',()=>{
  for(const [key,value] of [['responseStatus',429],['collectionFailed',true],['errorCode','BookingAPITooManyRequests'],['stockObserved',false],['inventoryObserved',false],['inventoryConflict',true],['salesEvidence','availableCount']]){
    const ledger=fixture();ledger.sources[1].rows[0][key]=value;
    const model=calculate(ledger);assert.equal(model.days,1,key);assert.equal(model.excludedDates[0].reasonCode,'PUBLIC_RESPONSE_UNVERIFIED',key);
  }
  const missing=fixture();delete missing.sources[1].rows[0].errorCode;
  assert.equal(calculate(missing).days,1);
});
test('same product stock basis must stay equal and bound booking count; unavailable is never zero',()=>{
  for(const [key,value] of [['stock',9],['bookingCount',11],['bookingCount',-1],['bookingCount',1.5]]){
    const ledger=fixture();ledger.sources[1].rows=ledger.sources[1].rows.slice(0,1);ledger.sources[0].rows=ledger.sources[0].rows.slice(0,1);
    ledger.sources[0].products=ledger.sources[0].products.slice(0,1);ledger.sources[1].products=ledger.sources[1].products.slice(0,1);
    ledger.sources[1].rows[0][key]=value;
    const model=calculate(ledger,{...options,dates:['2026-10-30']});assert.equal(model.publicChange,null);
    assert.equal(model.reasonCode,key==='stock'?'STOCK_BASIS_CHANGED':'PUBLIC_RESPONSE_UNVERIFIED');
  }
});
test('identical duplicates dedupe, conflicting product-day duplicates reject that day regardless of order',()=>{
  const ledger=fixture();ledger.sources[1].rows.push(structuredClone(ledger.sources[1].rows[0]));
  assert.equal(calculate(ledger).days,2);assert.equal(calculate(ledger).publicChange,0);
  const conflict=structuredClone(ledger.sources[1].rows[0]);conflict.bookingCount=2;ledger.sources[1].rows.push(conflict);
  assert.equal(calculate(ledger).days,1);assert.equal(calculate(ledger).excludedDates[0].reasonCode,'DUPLICATE_PRODUCT_CONFLICT');
  ledger.sources[1].rows.reverse();assert.equal(calculate(ledger).days,1);
});
test('repeated identical sources dedupe while modified or reused run identities reject the ledger',()=>{
  const ledger=fixture();ledger.sources.push(structuredClone(ledger.sources[1]));assert.equal(calculate(ledger).status,'reference');
  ledger.sources[2].rows[0].bookingCount=2;assert.equal(calculate(ledger).reasonCode,'SOURCE_OBSERVATION_CONFLICT');
  const reused=fixture();reused.sources[1].runId='previous';for(const row of reused.sources[1].rows)row.runId='previous';
  assert.equal(calculate(reused).reasonCode,'SOURCE_OBSERVATION_CONFLICT');
});
test('choose the latest two observations, not an older pair that happens to have nicer coverage',()=>{
  const ledger=fixture(),newest=source('newest','2026-10-29T03:00:00Z');
  newest.rows=newest.rows.map(row=>({...row,date:'2026-11-01'}));ledger.sources.push(newest);
  const model=calculate(ledger);assert.equal(model.publicChange,null);assert.equal(model.reasonCode,'NO_SELECTED_DATE_OVERLAP');
});
test('same-time alternate current or previous runs are ambiguous and cannot fall back to a third run',()=>{
  for(const at of [current,previous]){
    const ledger=fixture();ledger.sources.push(source('alternate',at));
    assert.equal(calculate(ledger).reasonCode,'SOURCE_OBSERVATION_CONFLICT');
  }
});
test('an as-of view excludes future observations; post-stay snapshots cannot validate past public bookings',()=>{
  assert.equal(calculate(fixture(),{...options,asOf:'2026-10-27'}).reasonCode,'NO_PREVIOUS_OBSERVATION');
  const ledger=fixture();for(const source of ledger.sources)for(const row of source.rows)row.date='2026-10-20';
  const model=calculate(ledger,{...options,dates:['2026-10-20']});assert.equal(model.publicChange,null);
});
test('physical-room list supports more than40 products without an arbitrary collection cap',()=>{
  const ledger=fixture();
  for(const source of ledger.sources){source.products=Array.from({length:65},(_,i)=>({bizItemId:'room'+i,productType:'lodging',listType:'객실별 예약리스트',availabilityUnit:'객실상품'}));
    source.rows=source.products.map(product=>({companyId,placeId,runId:source.runId,collectedAt:source.collectedAt,...product,date:'2026-10-30',stock:1,bookingCount:0,responseStatus:200,collectionFailed:false,errorCode:null,stockObserved:true,inventoryObserved:true,inventoryConflict:false,salesEvidence:'bookingCount'}));}
  ledger.sources[1].rows[64].bookingCount=1;
  const model=calculate(ledger,{...options,dates:['2026-10-30']});assert.equal(model.publicChange,1);assert.equal(model.rows[0].productCount,65);
});
test('invalid options, absent ledgers and bounded sources fail safely',()=>{
  assert.equal(calculate(null).reasonCode,'LEDGER_NOT_AVAILABLE');
  assert.equal(calculate(fixture(),null).reasonCode,'LEDGER_INVALID');
  const nested=fixture();nested.sources[0].rows[0].errorCode={unexpected:'raw response'};
  assert.equal(calculate(nested).reasonCode,'LEDGER_INVALID');
  assert.equal(calculate(fixture(),{...options,dates:[]}).reasonCode,'LEDGER_INVALID');
  assert.equal(calculate(fixture(),{...options,dates:['2026-02-30']}).reasonCode,'LEDGER_INVALID');
  assert.equal(calculate(fixture(),{...options,dates:['2026-10-30','2026-10-30']}).reasonCode,'LEDGER_INVALID');
  const ledger=fixture();ledger.sources=Array.from({length:LIMITS.sources+1},()=>ledger.sources[0]);
  assert.equal(calculate(ledger).reasonCode,'LEDGER_INVALID');
});
