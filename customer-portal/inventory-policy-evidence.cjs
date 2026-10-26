'use strict';

// A safe projection of the central calculator's policy evidence. Insight never
// allocates rooms or prices itself and never persists arbitrary source objects.
const fields=keys=>Object.fromEntries(keys.split(' ').map(key=>[key,true]));
const allocationKeys=['phoneAllocatedBookings','phoneAllocatedRevenue','phoneRevenueLow','phoneRevenueHigh'];
const schemas={
  inventoryEvidenceVersion:true,phoneValuationPolicy:true,
  priceRecoveryPolicy:true,
  priceUnknownCauses:[{...fields('code channel quantity'),productKeys:[true]}],
  priceUnknownCauseCoverage:fields('classifiedCompanyDays unclassifiedCompanyDays'),
  phoneValuation:{...fields('policy quantityPolicy roundingPolicy unroundedRevenue completePriceCoverage'),allocationRanges:[fields('quantity lowRevenue highRevenue completePriceCoverage')],recoveryPolicies:[{...fields('policy quantity revenue estimatedQuantity sourceDate unitPrice'),productKeys:[true]}]},
  sharedDayUseEvidence:{...fields('policy publicSessions physicalRoomBookings excludedBookings'),groups:[{...fields('groupKey lunchBookings dinnerBookings physicalRoomBookings reusedBookings classificationSource'),productIds:[true]}],warnings:[true]},
  productCapacityEvidence:[fields('productKey count source sourceDate runId observedAt')]
};
schemas.capacityWitnesses=schemas.productCapacityEvidence;
const nonnegative=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0;
const count=value=>nonnegative(value)&&Number.isSafeInteger(value);
const reference=value=>typeof value==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,179}$/.test(value);
const boundedText=value=>typeof value==='string'&&value.length>0&&value.length<=180&&!/[\u0000-\u001f\u007f]/.test(value);
const day=value=>typeof value==='string'&&/^20\d{2}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(value)&&new Date(value+'T00:00:00Z').toISOString().slice(0,10)===value;
const stamp=value=>typeof value==='string'&&Number.isFinite(Date.parse(value));
const priceCauseCodes=new Set(['explicit_product_price_missing','inferred_product_price_missing','product_maxima_exceed_company_capacity',
  'proportional_price_evidence_incomplete','company_capacity_unallocated_to_products','public_product_price_missing','dayuse_unverified','invalid_product_response']);
function policyEvidence(row){
  const result={},valuation=row?.phoneValuation,shared=row?.sharedDayUseEvidence;
  // These are central calculation diagnostics, never extra reservations or a
  // customer-entered verification. Missing legacy diagnostics remain absent.
  const causes=row?.priceUnknownCauses;
  if(Array.isArray(causes)&&causes.length<=1000&&causes.every(value=>priceCauseCodes.has(value?.code)&&['public','other'].includes(value.channel)
    &&count(value.quantity)&&value.quantity>0&&Array.isArray(value.productKeys)&&value.productKeys.length<=1000
    &&value.productKeys.every(reference)&&new Set(value.productKeys).size===value.productKeys.length)){
    result.priceUnknownCauses=causes.map(value=>({code:value.code,channel:value.channel,quantity:value.quantity,productKeys:[...value.productKeys]}));
  }
  const coverage=row?.priceUnknownCauseCoverage;
  if(coverage&&count(coverage.classifiedCompanyDays)&&count(coverage.unclassifiedCompanyDays))result.priceUnknownCauseCoverage={classifiedCompanyDays:coverage.classifiedCompanyDays,unclassifiedCompanyDays:coverage.unclassifiedCompanyDays};
  if(row?.priceRecoveryPolicy==='inventory_price_recovery_v1')result.priceRecoveryPolicy=row.priceRecoveryPolicy;
  if(count(row?.inventoryEvidenceVersion)&&row.inventoryEvidenceVersion>=5)result.inventoryEvidenceVersion=row.inventoryEvidenceVersion;
  if(row?.phoneValuationPolicy==='proportional_product_shortfall_v2')result.phoneValuationPolicy=row.phoneValuationPolicy;
  if(valuation?.policy==='proportional_product_shortfall_v2'
    &&valuation.quantityPolicy==='residual_product_shortfall_proportional'
    &&valuation.roundingPolicy==='round_each_stay_date_krw'
    &&nonnegative(valuation.unroundedRevenue)&&(valuation.allocationRanges===undefined||Array.isArray(valuation.allocationRanges)&&valuation.allocationRanges.length<=500
    &&valuation.allocationRanges.every(value=>nonnegative(value?.quantity)&&(nonnegative(value?.lowRevenue)&&nonnegative(value?.highRevenue)&&value.highRevenue>=value.lowRevenue||value.completePriceCoverage===false&&value.lowRevenue===null&&value.highRevenue===null)))){
    result.phoneValuation={policy:valuation.policy,quantityPolicy:valuation.quantityPolicy,roundingPolicy:valuation.roundingPolicy,unroundedRevenue:valuation.unroundedRevenue,
      ...(typeof valuation.completePriceCoverage==='boolean'?{completePriceCoverage:valuation.completePriceCoverage}:{}),
      ...(valuation.allocationRanges===undefined?{}:{allocationRanges:valuation.allocationRanges.map(value=>({quantity:value.quantity,lowRevenue:value.lowRevenue,highRevenue:value.highRevenue,...(typeof value.completePriceCoverage==='boolean'?{completePriceCoverage:value.completePriceCoverage}:{})}))})};
    const recoveries=valuation.recoveryPolicies;
    if(Array.isArray(recoveries)&&recoveries.length<=500&&recoveries.every(value=>['catalog_single_room_identity_v1','uniform_current_catalog_price_v1'].includes(value?.policy)
      &&count(value.quantity)&&value.quantity>0&&count(value.revenue)&&value.revenue>0&&value.estimatedQuantity===true&&day(value.sourceDate)
      &&Array.isArray(value.productKeys)&&value.productKeys.length>0&&value.productKeys.length<=1000&&value.productKeys.every(reference)
      &&new Set(value.productKeys).size===value.productKeys.length&&(value.unitPrice===undefined||nonnegative(value.unitPrice)&&value.unitPrice>0))){
      result.phoneValuation.recoveryPolicies=recoveries.map(value=>({policy:value.policy,quantity:value.quantity,revenue:value.revenue,estimatedQuantity:true,sourceDate:value.sourceDate,productKeys:[...value.productKeys],...(value.unitPrice===undefined?{}:{unitPrice:value.unitPrice})}));
    }
  }
  if(shared?.policy==='lunch_dinner_room_reuse_v1'&&[shared.publicSessions,shared.physicalRoomBookings,shared.excludedBookings].every(count)
    &&shared.physicalRoomBookings<=shared.publicSessions&&shared.excludedBookings<=shared.physicalRoomBookings
    &&Array.isArray(shared.groups)&&shared.groups.length<=500&&shared.groups.every(value=>boundedText(value?.groupKey)
      &&[value.lunchBookings,value.dinnerBookings,value.physicalRoomBookings,value.reusedBookings].every(count)
      &&reference(value.classificationSource)&&Array.isArray(value.productIds)&&value.productIds.length<=500&&value.productIds.every(reference))){
    result.sharedDayUseEvidence={policy:shared.policy,publicSessions:shared.publicSessions,physicalRoomBookings:shared.physicalRoomBookings,excludedBookings:shared.excludedBookings,
      groups:shared.groups.map(value=>({groupKey:value.groupKey,lunchBookings:value.lunchBookings,dinnerBookings:value.dinnerBookings,physicalRoomBookings:value.physicalRoomBookings,reusedBookings:value.reusedBookings,productIds:[...value.productIds],classificationSource:value.classificationSource})),
      warnings:Array.isArray(shared.warnings)?shared.warnings.filter(reference).slice(0,100):[]};
  }
  for(const key of ['productCapacityEvidence','capacityWitnesses']){
  const products=row?.[key];
  if(Array.isArray(products)&&products.length<=500&&products.every(value=>boundedText(value?.productKey)&&count(value.count)
    &&['db_product_correction','historical_product_maximum','current_run_product_maximum'].includes(value.source)
    &&(value.sourceDate===undefined||day(value.sourceDate))&&(value.runId===undefined||reference(value.runId))&&(value.observedAt===undefined||stamp(value.observedAt)))){
    result[key]=products.map(value=>({productKey:value.productKey,count:value.count,source:value.source,
      ...(value.sourceDate===undefined?{}:{sourceDate:value.sourceDate}),...(value.runId===undefined?{}:{runId:value.runId}),...(value.observedAt===undefined?{}:{observedAt:value.observedAt})}));
  }
  }
  return result;
}
module.exports={allocationKeys,schemas,policyEvidence};
