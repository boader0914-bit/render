'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {projectCompany}=require('../web/comparison-saved-metrics.js');
const view=require('../web/comparison-dashboard-view.js');
const options={companyId:'cmp_place_fixture',asOf:'2026-10-30',dates:['2026-10-30','2026-10-31']};
const previous='2026-10-27T04:20:05.714Z',current='2026-10-28T06:03:04.516Z',clone=v=>JSON.parse(JSON.stringify(v));
function fixture(){
  return {publicBookingPickup:{companyId:options.companyId,status:'reference',calculationVersion:'public-booking-pickup-v1',publicChange:999999,inferredChange:999999,
    source:{previousRunId:'run_previous',currentRunId:'run_current',previousObservedAt:previous,currentObservedAt:current,sourceDigests:{previous:'a'.repeat(64),current:'b'.repeat(64)},ledgerDigest:'c'.repeat(64)},
    rows:[{date:'2026-10-30',previousPublic:1,currentPublic:3,publicChange:2,productCount:2,matchedProductIds:['room-one','room-two']},
      {date:'2026-10-31',previousPublic:0,currentPublic:0,publicChange:0,productCount:2,matchedProductIds:['room-one','room-two']}]}};
}
function integrated(payload,{at=current,before=previous,change=1,status='ready'}={}){
  payload.companyDetail={companyId:options.companyId,integrated:{companyId:options.companyId,status,selectedMonth:'2026-10',calculationVersion:'integrated-fixture-v1',
    snapshot:{period:{start:'2026-10-01',end:'2026-10-31',cutoffDate:'2026-10-30'},analysis:{pickup:{status:'ready',comparableIntervals:1,
      intervals:[{date:'2026-10-30',previousCollectedAt:before,collectedAt:at,publicChange:change,blockedChange:5,netChange:change+5}]}}}}};
  return payload;
}
test('validated raw public-only ledger is independent of missing or partial integrated total quantity and never assumes phone zero',()=>{
  for(const payload of [fixture(),integrated(fixture(),{status:'partial'})]){
    const before=JSON.stringify(payload),model=projectCompany(payload,options).pickup;
    assert.equal(model.value,2);assert.equal(model.publicChange,2);assert.equal(model.inferredChange,null);assert.equal(model.days,2);assert.equal(model.status,'reference');
    assert.equal(model.reasonCode,'PICKUP_PUBLIC_ONLY_REFERENCE');assert.match(model.reason,/공개예약만 비교/);assert.equal(model.rows[0].previousPublic,1);
    assert.equal(model.source.previousRunId,'run_previous');assert.equal(model.source.currentRunId,'run_current');assert.equal(model.source.sourceDigests.current,'b'.repeat(64));
    assert.match(model.limitations.join(' '),/전체 예약수량·예약률·타채널 추정·전화예약·매출/);assert.equal(JSON.stringify(payload),before);
  }
});
test('selected dates preserve genuine public zero and exclude another day without deriving a total or inferred quantity',()=>{
  const source=fixture(),zero=projectCompany(source,{...options,dates:['2026-10-31']}).pickup;
  assert.equal(zero.value,0);assert.equal(zero.days,1);assert.equal(zero.inferredChange,null);assert.equal(zero.rows[0].date,'2026-10-31');
  const absent=projectCompany(source,{...options,dates:['2026-11-01']}).pickup;assert.equal(absent.value,null);assert.equal(absent.reasonCode,'PICKUP_OUTSIDE_SELECTED_DATES');
});
test('identical monthly ledgers and repeated rows are idempotent, but inconsistent duplicate dates are excluded',()=>{
  const source=fixture(),copy=clone(source);copy.publicBookingPickup.rows.reverse();copy.publicBookingPickup.rows[1].matchedProductIds.reverse();
  assert.equal(projectCompany([source,copy],options).pickup.value,2);assert.equal(projectCompany([source,copy],options).pickup.days,2);
  copy.publicBookingPickup.rows.find(row=>row.date==='2026-10-30').currentPublic=4;copy.publicBookingPickup.rows.find(row=>row.date==='2026-10-30').publicChange=3;
  let result=projectCompany([source,copy],options).pickup;assert.equal(result.value,0);assert.equal(result.days,1);assert.ok(result.reasonCodes.includes('PICKUP_INVALID_EVIDENCE'));
  copy.publicBookingPickup.rows.find(row=>row.date==='2026-10-31').currentPublic=1;copy.publicBookingPickup.rows.find(row=>row.date==='2026-10-31').publicChange=1;
  assert.equal(projectCompany([source,copy],options).pickup.value,null);
});
test('newer public-only evidence replaces older integrated changes and a matching latest pair prefers independently verified public rows',()=>{
  let source=integrated(fixture(),{at:'2026-10-26T03:00:00Z',before:'2026-10-25T03:00:00Z',change:99});
  assert.equal(projectCompany(source,options).pickup.value,2);assert.equal(projectCompany(source,options).pickup.inferredChange,null);
  source=integrated(fixture(),{change:99});assert.equal(projectCompany(source,options).pickup.value,2);
  source=integrated(fixture(),{at:'2026-10-29T03:00:00Z',before:current,change:1});
  const latest=projectCompany(source,options).pickup;assert.equal(latest.value,1);assert.equal(latest.inferredChange,5);assert.equal(latest.reasonCode,'PICKUP_REFERENCE_ONLY');
});
test('public observations from different pairs are never summed and equal-time different source runs are ambiguous',()=>{
  const source=fixture(),older=clone(source);older.publicBookingPickup.source.previousRunId='old_previous';older.publicBookingPickup.source.currentRunId='old_current';
  older.publicBookingPickup.source.previousObservedAt='2026-10-25T03:00:00Z';older.publicBookingPickup.source.currentObservedAt='2026-10-26T03:00:00Z';
  older.publicBookingPickup.rows[0].currentPublic=101;older.publicBookingPickup.rows[0].publicChange=100;
  assert.equal(projectCompany([source,older],options).pickup.value,2);
  older.publicBookingPickup.source.previousObservedAt=previous;older.publicBookingPickup.source.currentObservedAt=current;
  assert.equal(projectCompany([source,older],options).pickup.value,null);
});
test('source run identities, independent digests and timestamp order are mandatory and future/post-stay evidence remains unknown',()=>{
  for(const mutate of [source=>source.previousRunId=source.currentRunId,source=>source.previousRunId='bad run',source=>source.sourceDigests.previous='not-a-digest',
    source=>source.ledgerDigest='bad',source=>source.previousObservedAt=current,source=>source.currentObservedAt='2026-10-31T01:00:00Z',
    source=>source.previousObservedAt='2026-10-30T01:00:00Z']){
    const input=fixture();mutate(input.publicBookingPickup.source);const model=projectCompany(input,options).pickup;
    assert.equal(model.value,null);assert.equal(model.inferredChange,null);assert.equal(model.reasonCode,'PICKUP_INVALID_EVIDENCE');
  }
  const input=fixture();input.publicBookingPickup.rows=[{...input.publicBookingPickup.rows[0],date:'2026-10-27'}];
  assert.equal(projectCompany(input,{...options,dates:['2026-10-27']}).pickup.value,null);
});
test('noninteger counts, incorrect arithmetic and mismatching product sets cannot become a normal public zero',()=>{
  for(const mutate of [row=>row.currentPublic=-1,row=>row.previousPublic=0.5,row=>row.publicChange=999,row=>row.productCount=0,
    row=>row.productCount=3,row=>row.matchedProductIds=['room-one','room-one'],row=>delete row.matchedProductIds]){
    const input=fixture();input.publicBookingPickup.rows=input.publicBookingPickup.rows.slice(0,1);mutate(input.publicBookingPickup.rows[0]);
    const result=projectCompany(input,options).pickup;assert.equal(result.value,null);assert.equal(result.reasonCode,'PICKUP_INVALID_EVIDENCE');
  }
});
test('foreign ledger identity is rejected, unknown prior observation remains unknown and an invalid public supplement does not erase valid integrated evidence',()=>{
  const input=fixture();input.publicBookingPickup.companyId='foreign';assert.equal(projectCompany(input,options).pickup.value,null);assert.equal(projectCompany(input,options).pickup.reasonCode,'SOURCE_CONTEXT_MISMATCH');
  const absent={publicBookingPickup:{companyId:options.companyId,status:'unavailable',reasonCode:'PICKUP_NO_PREVIOUS_OBSERVATION',rows:[]}};
  assert.equal(projectCompany(absent,options).pickup.value,null);assert.equal(projectCompany(absent,options).pickup.reasonCode,'PICKUP_NO_PREVIOUS_OBSERVATION');
  const valid=integrated(fixture(),{change:1});valid.publicBookingPickup.source.sourceDigests.current='bad';const result=projectCompany(valid,options).pickup;
  assert.equal(result.value,1);assert.equal(result.reasonCode,'PICKUP_REFERENCE_ONLY');
});
test('duplicate monthly responses cannot disagree on the raw source digest for the same run pair',()=>{
  const one=fixture(),two=clone(one);two.publicBookingPickup.source.sourceDigests.current='d'.repeat(64);
  const result=projectCompany([one,two],options).pickup;assert.equal(result.value,null);assert.equal(result.reasonCode,'PICKUP_INVALID_EVIDENCE');
});
test('public-only change has an explicit UI label and displays source proof without presenting phone or total changes',()=>{
  const saved=projectCompany(fixture(),options),html=view.savedMetrics({companies:[{companyId:options.companyId,name:'검수용 업체',kind:'competitor',regionRelation:'same',savedMetrics:saved}]});
  assert.match(html,/공개예약만 비교 · 참고/);assert.match(html,/>\+2실<\/strong>/);assert.match(html,/run_previous/);assert.match(html,/run_current/);assert.match(html,/원본 지문 aaaaaaaaaaaa/);
  assert.doesNotMatch(html,/전화예약 0|타채널 0|전체 예약.*\+2/);
});
test('browser UMD projection agrees with CommonJS and does not fetch, store, repair or mutate source data',()=>{
  const source=fixture(),before=JSON.stringify(source),context={window:{},fetch:()=>assert.fail('fetch'),setTimeout:()=>assert.fail('timer'),localStorage:{setItem:()=>assert.fail('storage')}};
  vm.runInNewContext(fs.readFileSync(require.resolve('../web/comparison-saved-metrics.js'),'utf8'),context);
  assert.equal(JSON.stringify(context.window.InsightComparisonSavedMetrics.projectCompany(source,options)),JSON.stringify(projectCompany(source,options)));
  assert.equal(JSON.stringify(source),before);
});
