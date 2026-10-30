'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {VERSION,fromImportedLedger,fromCollection}=require('../lib/public-booking-pickup-adapter.cjs');
const {computePublicBookingPickup}=require('../lib/public-booking-pickup.cjs');
const companyId='cmp_place_1460523479',placeId='1460523479',scope={companyId,placeId},clone=value=>JSON.parse(JSON.stringify(value));
function ledger(){
  return {version:VERSION,companyId,placeId,sources:[27,28].map((day,index)=>{
    const runId='run_202610'+day,collectedAt='2026-10-'+day+'T04:00:00Z';
    return {runId,collectedAt,sourceDigest:String(index+1).repeat(64),products:[{bizItemId:'room_a',productType:'lodging',listType:'객실 종류별 리스트',availabilityUnit:'재고수량'}],rows:[{companyId,placeId,runId,collectedAt,bizItemId:'room_a',productType:'lodging',listType:'객실 종류별 리스트',availabilityUnit:'재고수량',date:'2026-10-30',stock:4,bookingCount:index,responseStatus:200,collectionFailed:false,errorCode:null,stockObserved:true,inventoryObserved:true,inventoryConflict:false,salesEvidence:'bookingCount'}]};})};
}
function projection(){return {result:{companyId,runId:'run_20261028',collectedAt:'2026-10-28T04:00:00Z',quality:{status:'complete'},products:[{key:'lodging:id:room_a',bizItemId:'room_a',name:'객실 A',productType:'lodging',days:[{date:'2026-10-30',status:'observed',errorCode:null,total:4,available:3,publicBookings:1,price:149000,saleStatus:'unknown'}],original:[{date:'2026-10-30',status:'observed',total:4,publicBookings:0}]}]},companyDetail:{companyId,basics:{companyId}}};}
test('ordinary current company projection cannot manufacture the missing raw proof or turn same-run original into a prior observation',()=>{
  const data=projection(),before=clone(data),result=fromCollection(data,scope);
  assert.equal(result.status,'unavailable');assert.equal(result.reasonCode,'PUBLIC_PRODUCT_PROOF_UNAVAILABLE');assert.equal(result.ledger,null);assert.deepEqual(data,before);
});
test('verified imported ledger reuses the pure validator, preserves exact units and returns a whitelisted independent copy',()=>{
  const input=ledger();input.privateNote='do not persist';input.sources[0].accessToken='do not persist';input.sources[0].rows[0].customerName='do not persist';const before=clone(input);
  const result=fromImportedLedger(input,scope);assert.equal(result.status,'ready');assert.match(result.ledgerDigest,/^[a-f0-9]{64}$/);assert.equal(result.ledger.sources[0].products[0].availabilityUnit,'재고수량');assert.equal(result.ledger.sources[0].rows[0].bookingCount,0);assert.doesNotMatch(JSON.stringify(result.ledger),/do not persist|privateNote|accessToken|customerName/);assert.deepEqual(input,before);
  result.ledger.sources[0].rows[0].bookingCount=3;assert.equal(input.sources[0].rows[0].bookingCount,0);
});
test('explicit room-product unit labels are preserved without replacing them with assumed room units',()=>{
  const input=ledger();for(const source of input.sources){source.products[0].listType='객실별 예약리스트';source.products[0].availabilityUnit='객실상품';source.rows[0].listType='객실별 예약리스트';source.rows[0].availabilityUnit='객실상품';}
  const result=fromImportedLedger(input,scope);assert.equal(result.status,'ready');assert.equal(result.ledger.sources[1].products[0].availabilityUnit,'객실상품');
});
test('import rejects missing proof flags rather than supplying response success defaults',()=>{
  for(const field of ['responseStatus','collectionFailed','errorCode','stockObserved','inventoryObserved','inventoryConflict','salesEvidence','stock','bookingCount']){
    const input=ledger();delete input.sources[0].rows[0][field];const result=fromImportedLedger(input,scope);assert.equal(result.status,'unavailable',field);assert.equal(result.ledger,null,field);
  }
});
test('declared failures remain failures and cannot be calculated as normal zero reservations',()=>{
  const input=ledger();Object.assign(input.sources[0].rows[0],{responseStatus:429,collectionFailed:true,errorCode:'HTTP_429',stockObserved:false,inventoryObserved:false,stock:null,bookingCount:null});
  const adapted=fromImportedLedger(input,scope);assert.equal(adapted.status,'ready');assert.equal(adapted.ledger.sources[0].rows[0].responseStatus,429);assert.equal(adapted.ledger.sources[0].rows[0].bookingCount,null);
  const result=computePublicBookingPickup(adapted.ledger,{...scope,asOf:'2026-10-30',dates:['2026-10-30']});assert.equal(result.status,'unavailable');assert.equal(result.publicChange,null);assert.equal(result.reasonCode,'PUBLIC_RESPONSE_UNVERIFIED');
});
test('malformed proof types are rejected without numeric or boolean coercion',()=>{
  for(const [field,value] of [['responseStatus','200'],['collectionFailed','false'],['stockObserved',1],['inventoryObserved','true'],['inventoryConflict',0],['salesEvidence','available_delta'],['stock','4'],['bookingCount','0']]){
    const input=ledger();input.sources[0].rows[0][field]=value;assert.equal(fromImportedLedger(input,scope).status,'unavailable',field);
  }
});
test('company/place bindings are required and any cross-company row or source-run substitution is rejected',()=>{
  assert.equal(fromImportedLedger(ledger()).reasonCode,'PUBLIC_LEDGER_SCOPE_MISMATCH');
  for(const change of [input=>input.companyId='other',input=>input.placeId='1',input=>input.sources[0].rows[0].companyId='other',input=>input.sources[0].rows[0].runId='substitute']){
    const input=ledger();change(input);assert.equal(fromImportedLedger(input,scope).status,'unavailable');
  }
});
test('an explicit future augmentation requires the current result to match an actual declared source',()=>{
  const data=projection();data.publicBookingPickupLedger=ledger();assert.equal(fromCollection(data,scope).status,'ready');
  for(const change of [input=>input.result.runId='other_run',input=>input.result.collectedAt='2026-10-29T04:00:00Z',input=>input.companyDetail.companyId='other']){
    const input=clone(data);change(input);const result=fromCollection(input,scope);assert.equal(result.status,'unavailable');assert.equal(result.reasonCode,'PUBLIC_LEDGER_SCOPE_MISMATCH');
  }
});
test('tampered normalized or ledger digest is rejected by the shared calculator validator',()=>{
  for(const change of [input=>input.ledgerDigest='0'.repeat(64),input=>input.sources[0].normalizedDigest='0'.repeat(64)]){
    const input=ledger();change(input);assert.equal(fromImportedLedger(input,scope).reasonCode,'SOURCE_DIGEST_MISMATCH');
  }
});
test('an empty import cannot masquerade as a verified replacement for stored source evidence',()=>{
  const empty=ledger();empty.sources=[];assert.equal(fromImportedLedger(empty,scope).status,'unavailable');
  const emptyRows=ledger();emptyRows.sources[0].rows=[];assert.equal(fromImportedLedger(emptyRows,scope).status,'unavailable');
});
test('the valid zero baseline contributes a signed public change while inferred values remain absent',()=>{
  const adapted=fromImportedLedger(ledger(),scope),result=computePublicBookingPickup(adapted.ledger,{...scope,asOf:'2026-10-30',dates:['2026-10-30']});
  assert.equal(result.status,'reference');assert.equal(result.previousPublic,0);assert.equal(result.publicChange,1);assert.equal(result.inferredChange,null);assert.equal(result.estimatedRevenue,null);
});
