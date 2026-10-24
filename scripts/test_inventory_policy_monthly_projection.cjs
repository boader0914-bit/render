'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {buildMonthlyReportSnapshot}=require('./lib/monthly_reports.cjs');
const {projectIntegrated}=require('./lib/insight_company_integrated.cjs');
const companyId='cmp_policy';
const request={type:'company',targetId:companyId,month:'2026-09',cutoffDate:'2026-09-30'};
function source(overrides={}) {return {companies:[{companyId,primaryName:'재사용 검수업체',capacity:10}],runs:[{id:'run-policy',collectedAt:'2026-09-01T02:00:00Z',collectionQuality:{status:'complete'}}],observations:[{companyId,runId:'run-policy',collectedAt:'2026-09-01T02:00:00Z',stayDate:'2026-09-04',productType:'lodging',inventoryEvidenceVersion:5,supply:10,sold:4,publicBookings:2,phoneBookings:2,publicRevenue:200000,phoneRevenue:320000,estimatedRevenue:520000,sharedDayUseExcluded:1,explicitBlockedBookings:0,phoneMissingPriceBookings:0,phoneAllocatedBookings:2,phoneAllocatedRevenue:320000,phoneRevenueLow:300000,phoneRevenueHigh:340000,phonePriceEstimates:[{productKey:'p1',quantity:1.5,unitPrice:160000,source:'same_product_same_date',sourceDate:'2026-09-04',quantitySource:'proportional_product_shortfall',estimatedQuantity:true}],phoneValuationPolicy:'proportional_product_shortfall_v2',phoneValuation:{policy:'proportional_product_shortfall_v2',quantityPolicy:'residual_product_shortfall_proportional',roundingPolicy:'round_each_stay_date_krw',unroundedRevenue:320000,allocationRanges:[{privateToken:'private-token'}]},capacityWitnesses:[{productKey:'p1',count:6,source:'historical_product_maximum',runId:'run-capacity',sourceDate:'2026-09-04',observedAt:'2026-09-01T01:00:00Z',privatePath:'/var/data/private'}],sharedDayUseEvidence:{policy:'lunch_dinner_room_reuse_v1',publicSessions:2,physicalRoomBookings:1,excludedBookings:1,groups:[{groupKey:'same-room',lunchBookings:1,dinnerBookings:1,physicalRoomBookings:1,reusedBookings:1,productIds:['lunch','dinner'],classificationSource:'name_time_slot',rawPayload:'private-token'}]},...overrides}]};}
function snapshot(overrides) {return buildMonthlyReportSnapshot(request,source(overrides),'2026-10-24T03:00:00Z');}
test('monthly totals retain allocated revenue and reuse evidence without double addition',()=>{
 const value=snapshot(),m=value.summary.lodging,row=value.sources.observations[0];
 assert.equal(m.estimatedRevenue,520000);assert.equal(m.phoneRevenue,320000);
 assert.equal(m.phoneAllocatedRevenue,320000);assert.equal(m.phoneAllocatedBookings,2);
 assert.equal(m.phoneRevenueLow,300000);assert.equal(m.phoneRevenueHigh,340000);
 assert.equal(row.priceEvidenceType,'product_shortfall_allocated_price');
 assert.equal(row.sharedDayUseEvidence.excludedBookings,1);
 assert.equal(row.capacityWitnesses[0].count,6);
 assert.equal(row.phonePriceEstimates[0].estimatedQuantity,true);
 assert.equal(value.summary.dayuse.estimatedRevenue,null);
});
test('customer projection preserves safe policy and capacity provenance and never raw internals',()=>{
 const value=snapshot(),revision='a'.repeat(64),projected=projectIntegrated(companyId,{schemaVersion:1,companyId,status:'ready',selectedMonth:'2026-09',calculationVersion:'policy-v5',sourceRevision:revision,snapshot:value},'2026-09');
 const d=projected.snapshot.daily.find(d=>d.date==='2026-09-04');
 assert.equal(projected.sourceRevision,revision);assert.equal(projected.snapshot.provenance.sourceRevision,revision);
 assert.equal(d.phoneAllocatedRevenue,320000);assert.equal(d.phoneRevenueLow,300000);
 assert.equal(d.phoneValuation.quantityPolicy,'residual_product_shortfall_proportional');
 assert.equal(d.sharedDayUseEvidence.groups[0].reusedBookings,1);
 assert.equal(d.capacityWitnesses[0].runId,'run-capacity');
 assert.equal(d.sourceObservation.inventoryEvidenceVersion,5);
 assert.doesNotMatch(JSON.stringify(projected),/private-token|privatePath|rawPayload|allocationRanges|\/var\/data/);
 assert.equal(projected.snapshot.daily.find(d=>d.date==='2026-09-05').estimatedRevenue,null);
});
test('invalid allocation or monetary bounds remain unavailable rather than a successful zero',()=>{
 for(const overrides of [{phoneAllocatedBookings:3},{phoneAllocatedRevenue:330000},{phoneRevenueLow:330000},{phoneRevenueHigh:310000},{phoneAllocatedBookings:1.5}]){
  const value=snapshot(overrides);assert.equal(value.summary.lodging.estimatedRevenue,null);
  assert.equal(value.sources.observations[0].revenueEligible,false);
  assert.equal(value.sources.observations[0].revenueMissingReason,'inconsistent_revenue');
 }
});
test('explicit v5 zero and unknown legacy allocation stay distinct',()=>{
 const z=snapshot({sold:0,publicBookings:0,phoneBookings:0,publicRevenue:0,phoneRevenue:0,estimatedRevenue:0,phoneAllocatedBookings:0,phoneAllocatedRevenue:0,phoneRevenueLow:0,phoneRevenueHigh:0,phonePriceEstimates:[]});
 assert.equal(z.summary.lodging.estimatedRevenue,0);assert.equal(z.summary.lodging.phoneAllocatedRevenue,0);
 const legacy=source();for(const field of ['phoneAllocatedBookings','phoneAllocatedRevenue','phoneRevenueLow','phoneRevenueHigh'])delete legacy.observations[0][field];legacy.observations[0].inventoryEvidenceVersion=4;
 const old=buildMonthlyReportSnapshot(request,legacy,'2026-10-24T03:00:00Z');
 assert.equal(old.summary.lodging.estimatedRevenue,520000);assert.equal(old.summary.lodging.phoneAllocatedRevenue,null);
});
test('company UI labels allocated amounts and lunch dinner reuse alongside the unchanged total',()=>{
 const ui=require('../web/company-integrated.js');
 const value=snapshot(),model=ui.buildViewModel({companyId,status:'ready',selectedMonth:'2026-09',snapshot:value,roomBasis:{capacity:10}});
 const html=ui.render(model,{tab:'settlement',view:'table',selectedDate:'2026-09-04',error:'',loading:false});
 assert.match(html,/상품 배분 추정/);assert.match(html,/런치·디너 재사용 반영/);
 assert.equal(model.summary.estimatedRevenue,520000);assert.equal(model.summary.phoneRevenue,320000);
});

