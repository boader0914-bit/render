'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const view=require('../web/comparison-readiness-view.js');
const dates=Array.from({length:27},(_,i)=>'2026-09-'+String(i+1).padStart(2,'0'));
function fixture(){return {status:'partial',period:{start:'2026-09-01',end:'2026-09-30',days:30},companies:[{companyId:'own',name:'내 매장',kind:'own',rooms:16,capacity:{known:true,label:'DB 검수값'},coverageKnown:true,availableDays:30,quantity:{sold:0},issues:[]},{companyId:'other',name:'비교업체',kind:'competitor',rooms:9,capacity:{known:true,label:'최대 관측'},coverageKnown:true,availableDays:3,quantity:{sold:10},missingDays:dates,issues:dates.flatMap(date=>[{date,code:'QUANTITY_MISSING',label:'예약 수량 미확인',scope:'quantity'},{date,code:'OBSERVATION_UNKNOWN',label:'관측 시각 미확인',scope:'timing'}])}],comparisons:[{companyId:'other',name:'비교업체',commonDays:3,commonDates:['2026-09-28','2026-09-29','2026-09-30'],quantity:{displayable:true,comparable:false},rate:{displayable:false,comparable:false},revenue:{displayable:false,comparable:false},excludedDates:dates.map(date=>({date,side:'competitor',codes:['QUANTITY_MISSING'],label:'예약 수량 미확인'})),reasons:[]}],source:{},issues:[]};}
test('long repeated company and pair reasons are grouped while every exact missing date remains inspectable',()=>{
  const model=fixture(),before=JSON.stringify(model),html=view.renderModel(model);
  assert.equal((html.match(/<li>/g)||[]).length,3);
  assert.equal((html.match(/<span>예약 수량 미확인<\/span>/g)||[]).length,1);
  assert.equal((html.match(/<span>관측 시각 미확인<\/span>/g)||[]).length,1);
  assert.match(html,/27일 · 2026-09-01/);
  const groups=[...html.matchAll(/<li>[\s\S]*?<\/li>/g)].map(match=>match[0]);
  for(const date of dates)for(const group of groups)assert.ok(group.includes(date));
  assert.equal(JSON.stringify(model),before);
});
test('different sides and scopes stay separate and source issue periods retain their exact ranges',()=>{
  const model=fixture();model.companies[1].issues=[{period:{start:'2026-09-01',end:'2026-09-12'},code:'SOURCE_UNAVAILABLE',label:'원본 확인 필요',scope:'company'},{period:{start:'2026-09-13',end:'2026-09-30'},code:'SOURCE_UNAVAILABLE',label:'원본 확인 필요',scope:'company'}];
  model.comparisons[0].excludedDates=[{date:'2026-09-01',side:'own',codes:['QUANTITY_MISSING'],label:'예약 수량 미확인'},{date:'2026-09-02',side:'competitor',codes:['QUANTITY_MISSING'],label:'예약 수량 미확인'}];
  const html=view.renderModel(model);
  assert.match(html,/<time>2026-09-01 ~ 2026-09-12<\/time>/);assert.match(html,/<time>2026-09-13 ~ 2026-09-30<\/time>/);
  assert.match(html,/<span>내 매장 · 예약 수량 미확인<\/span>/);assert.match(html,/<span>비교업체 · 예약 수량 미확인<\/span>/);
});
