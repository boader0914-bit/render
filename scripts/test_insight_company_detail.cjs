'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {projectCompanyDetail}=require('./lib/insight_company_detail.cjs');
test('company DB projection uses reviewed identity, verifies channel publication and omits private admin fields',()=>{
  const company={companyId:'cmp_a',name:'검수명',address:'검수 주소',rooms:16,roomCountSource:'DB 검토값',placeIds:['123']};
  const detail={company:{companyId:'cmp_a',salesContact:{secret:'private'},adminProfile:{secret:'private'},channelExposures:{tteonayo:{status:'directly_verified',appliedToSummary:true,url:'https://booking.ddnayo.com/booking-calendar?accommodationId=1'},yanolja:{status:'candidate',appliedToSummary:false,url:'https://nol.com/1'},yeogi:{status:'directly_verified',appliedToSummary:true,url:'javascript:alert(1)'}},runCount:5},salesHistory:{current:{summary:{observedDays:0,estimatedRevenue:null}},past:{years:[]}},leadTime:{status:'insufficient_observations',averageDays:null}};
  const r=projectCompanyDetail(company,detail);
  assert.equal(r.basics.rooms,16);assert.equal(r.basics.name,'검수명');assert.equal(r.channels.length,3);assert.equal(r.channels[2].url,null);assert.equal(r.current.summary.estimatedRevenue,null);assert.equal(r.current.summary.observedDays,0);assert.equal(JSON.stringify(r).includes('private'),false);
  assert.equal(projectCompanyDetail({...company,companyId:'cmp_b'},detail),null);
});
