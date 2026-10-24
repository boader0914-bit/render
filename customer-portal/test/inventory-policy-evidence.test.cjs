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
