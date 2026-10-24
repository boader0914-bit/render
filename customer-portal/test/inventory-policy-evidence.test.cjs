'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {policyEvidence}=require('../inventory-policy-evidence.cjs');
test('policy evidence retains unknown price ranges as unknown and rejects arbitrary or inconsistent payloads',()=>{
  const valuation={policy:'proportional_product_shortfall_v2',quantityPolicy:'residual_product_shortfall_proportional',roundingPolicy:'round_each_stay_date_krw',unroundedRevenue:0,completePriceCoverage:false,
    allocationRanges:[{quantity:2,lowRevenue:null,highRevenue:null,completePriceCoverage:false,private:'discard'}]};
  assert.deepEqual(policyEvidence({phoneValuation:valuation}).phoneValuation.allocationRanges,[{quantity:2,lowRevenue:null,highRevenue:null,completePriceCoverage:false}]);
  for(const value of [{...valuation,policy:'untrusted'}, {...valuation,unroundedRevenue:-1},{...valuation,allocationRanges:[{quantity:2,lowRevenue:100,highRevenue:50}]}])assert.deepEqual(policyEvidence({phoneValuation:value}),{});
  for(const value of [{policy:'lunch_dinner_room_reuse_v1',publicSessions:0,physicalRoomBookings:1,excludedBookings:1,groups:[]},
    {policy:'lunch_dinner_room_reuse_v1',publicSessions:2,physicalRoomBookings:1,excludedBookings:2,groups:[]}])assert.deepEqual(policyEvidence({sharedDayUseEvidence:value}),{});
  assert.deepEqual(policyEvidence({productCapacityEvidence:[{productKey:'101',count:16,source:'claimed_by_customer'}]}),{});
});

test('price diagnosis and saved-product recovery stay explicit in safe archive projections',()=>{
  const input={priceUnknownCauses:[{code:'company_capacity_unallocated_to_products',channel:'other',quantity:2,productKeys:['101'],private:'discard'}],
    priceUnknownCauseCoverage:{classifiedCompanyDays:1,unclassifiedCompanyDays:2,private:'discard'},priceRecoveryPolicy:'inventory_price_recovery_v1',
    phoneValuation:{policy:'proportional_product_shortfall_v2',quantityPolicy:'residual_product_shortfall_proportional',roundingPolicy:'round_each_stay_date_krw',unroundedRevenue:200000,
      recoveryPolicies:[{policy:'catalog_single_room_identity_v1',quantity:2,revenue:200000,estimatedQuantity:true,sourceDate:'2027-02-14',productKeys:['101','102'],private:'discard'}]}};
  const evidence=policyEvidence(input);
  assert.deepEqual(evidence.priceUnknownCauses,[{code:'company_capacity_unallocated_to_products',channel:'other',quantity:2,productKeys:['101']}]);
  assert.deepEqual(evidence.priceUnknownCauseCoverage,{classifiedCompanyDays:1,unclassifiedCompanyDays:2});
  assert.equal(evidence.priceRecoveryPolicy,'inventory_price_recovery_v1');
  assert.equal(evidence.phoneValuation.recoveryPolicies[0].estimatedQuantity,true);
  assert.equal(evidence.phoneValuation.recoveryPolicies[0].private,undefined);
  assert.equal(JSON.stringify(input).includes('private'),true,'source object is untouched');
  for(const quantity of [-1,0,1.5,null])assert.equal(policyEvidence({priceUnknownCauses:[{code:'price_missing',channel:'other',quantity,productKeys:[]}]}).priceUnknownCauses,undefined);
  assert.equal(policyEvidence({priceUnknownCauses:[{code:'price_missing',channel:'other',quantity:1,productKeys:['101','101']}]}).priceUnknownCauses,undefined);
  assert.equal(policyEvidence({priceUnknownCauseCoverage:{classifiedCompanyDays:1,unclassifiedCompanyDays:null}}).priceUnknownCauseCoverage,undefined);
  assert.deepEqual(policyEvidence({priceUnknownCauses:[]}).priceUnknownCauses,[]);
  assert.equal(policyEvidence({}).priceUnknownCauses,undefined,'old records are not declared fully classified');
  const bad=structuredClone(input);bad.phoneValuation.recoveryPolicies[0].estimatedQuantity=false;
  assert.equal(policyEvidence(bad).phoneValuation.recoveryPolicies,undefined);
});
