'use strict';
// Synthetic review data only. Never an observation, sale or customer record.
const {buildComparisonSet,summarizeCompany}=require('../../../scripts/lib/insight_comparison.cjs');
const TODAY='2026-10-25';
const shift=(day,n)=>new Date(Date.parse(day+'T00:00:00Z')+n*86400000).toISOString().slice(0,10);
const definitions=[
  {companyId:'own-sc',name:'내 매장 · 산청',regionKey:'r-sc',regionLabel:'경남 산청군',industryTags:['glamping'],industryLabel:'글램핑',rooms:16,kind:'own'},
  {companyId:'own-gp',name:'내 매장 · 가평',regionKey:'r-gp',regionLabel:'경기 가평군',industryTags:['glamping'],industryLabel:'글램핑',rooms:20,kind:'own'},
  {companyId:'sc-forest',name:'산청숲 글램핑',regionKey:'r-sc',regionLabel:'경남 산청군',industryTags:['glamping'],industryLabel:'글램핑',rooms:18,comparisonPurpose:'direct'},
  {companyId:'sc-hill',name:'산청언덕 글램핑',regionKey:'r-sc',regionLabel:'경남 산청군',industryTags:['glamping'],industryLabel:'글램핑',rooms:12,comparisonPurpose:'direct'},
  {companyId:'sc-river',name:'산청강 글램핑',regionKey:'r-sc',regionLabel:'경남 산청군',industryTags:['glamping','pension'],industryLabel:'글램핑·펜션',rooms:24,comparisonPurpose:'reference',priceMissing:true},
  {companyId:'gp-forest',name:'가평숲 글램핑',regionKey:'r-gp',regionLabel:'경기 가평군',industryTags:['glamping'],industryLabel:'글램핑',rooms:20,comparisonPurpose:'reference'},
  {companyId:'pc-forest',name:'포천마루 글램핑',regionKey:'r-pc',regionLabel:'경기 포천시',industryTags:['glamping'],industryLabel:'글램핑',rooms:28,comparisonPurpose:'reference'},
  {companyId:'ys-coast',name:'여수바다 글램핑',regionKey:'r-ys',regionLabel:'전남 여수시',industryTags:['glamping'],industryLabel:'글램핑',rooms:22,comparisonPurpose:'reference',priceMissing:true},
  {companyId:'sc-pool',name:'산청온 풀빌라',regionKey:'r-sc',regionLabel:'경남 산청군',industryTags:['poolVilla'],industryLabel:'풀빌라',rooms:10,comparisonPurpose:'reference',priceMissing:true},
  {companyId:'gp-hill',name:'가평언덕 글램핑',regionKey:'r-gp',regionLabel:'경기 가평군',industryTags:['glamping'],industryLabel:'글램핑',rooms:14,comparisonPurpose:'direct'},
  {companyId:'gp-river',name:'가평강 글램핑',regionKey:'r-gp',regionLabel:'경기 가평군',industryTags:['glamping','pension'],industryLabel:'글램핑·펜션',rooms:24,comparisonPurpose:'reference',priceMissing:true},
  {companyId:'gp-pool',name:'가평온 풀빌라',regionKey:'r-gp',regionLabel:'경기 가평군',industryTags:['poolVilla'],industryLabel:'풀빌라',rooms:10,comparisonPurpose:'reference',priceMissing:true}
];
const scenarios={same:['sc-forest','sc-hill','sc-river'],cross:['gp-forest','pc-forest','ys-coast'],mixed:['sc-forest','gp-forest','sc-pool']};
const byOwn=(scenario)=>({'own-sc':scenarios[scenario],'own-gp':{same:['gp-forest','gp-hill','gp-river'],cross:['sc-forest','pc-forest','ys-coast'],mixed:['gp-forest','sc-forest','gp-pool']}[scenario]});
const checkDay=value=>typeof value==='string'&&/^20\d{2}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(value)&&new Date(value+'T00:00:00Z').toISOString().slice(0,10)===value;
function fixtureCompany(def,{start,end,asOf}){
  const seed=definitions.indexOf(def),days=[];
  for(let date=start,i=0;date<=end;date=shift(date,1),i++){
    if(i>92)throw Error('PERIOD_TOO_LONG');
    const weekend=[5,6].includes(new Date(date+'T00:00:00Z').getUTCDay());
    const sold=def.kind==='own'&&i===3?0:Math.min(def.rooms,Math.round(def.rooms*(weekend?.86:.32)+((i+seed*3)%5)-1+seed*.4));
    const publicBookings=Math.max(0,sold-Math.max(1,Math.floor(sold*.29))),phoneBookings=sold-publicBookings;
    const missing=def.kind==='own'&&i===8;
    const revenuePartial=Boolean(def.priceMissing&&i%5===1);
    const observedDate=date<asOf?date:asOf;
    days.push({date,total:missing?null:def.rooms,sold:missing?null:sold,publicBookings:missing?null:publicBookings,phoneBookings:missing?null:phoneBookings,
      estimatedRevenue:missing||revenuePartial?null:sold*(weekend?290000:190000),revenuePartial,missing,partial:false,inventoryConflict:false,
      collectedAt:observedDate+'T08:'+String((seed*4)%60).padStart(2,'0')+':00.000Z'});
  }
  return {...def,capacityStatus:'reviewed',capacityVersion:'fixture-capacity-v1',relationStatus:'active',days};
}
function getScenario({scenario='mixed',ownId='own-sc',start=TODAY,end=shift(TODAY,29),asOf=TODAY}={}){
  if(!Object.hasOwn(scenarios,scenario)||!['own-sc','own-gp'].includes(ownId)||!checkDay(start)||!checkDay(end)||!checkDay(asOf)||start>end||asOf>TODAY||Date.parse(end)-Date.parse(start)>92*86400000)throw Error('INVALID_REVIEW_SELECTION');
  const options={start,end,asOf},own=fixtureCompany(definitions.find(c=>c.companyId===ownId),options);
  const competitors=byOwn(scenario)[ownId].map(id=>fixtureCompany(definitions.find(c=>c.companyId===id),options));
  if(scenario==='same')for(const company of competitors)if(company.industryTags.length===1)company.comparisonPurpose='direct';
  const mode=end<asOf||end<TODAY?'historical':'current';
  const policy={mode,asOf,period:{start,end},observationPolicy:{confirmed:true,maxSkewMs:2*60*60*1000}};
  const comparisons=buildComparisonSet(own,competitors,policy);
  return {fixture:true,label:'개발 검수용 가상 자료',today:TODAY,scenario,own,ownSummary:summarizeCompany(own,policy),competitors,comparisonSet:comparisons,
    selectionContext:{scope:'stage1-local-review',permissionSignature:'review-v1:'+scenario,authorizedOwnCompanyIds:['own-sc','own-gp'],authorizedComparisonIds:[...new Set(Object.values(byOwn(scenario)).flat())],
      authorizedComparisonIdsByOwn:byOwn(scenario),companies:definitions.map(c=>({...c}))},
    rules:{version:comparisons.rulesVersion,mode,asOf,minCommonDays:7,maxObservationSkewMinutes:120,confirmed:true,
      note:'시안 검수를 위한 2시간 조건입니다. 운영 자동 제안의 허용시차는 아직 확정하지 않았습니다.'}};
}
module.exports={getScenario,definitions,scenarios,TODAY};
