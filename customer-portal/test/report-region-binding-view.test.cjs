'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
function view(){
  const window={};
  vm.runInContext(fs.readFileSync(require.resolve('../web/analysis.js'),'utf8'),vm.createContext({window,document:{addEventListener(){},querySelector(){return null;}}}));
  return window.InsightAnalysis;
}
function report(binding={}){
  const now=new Date().toISOString(),start=new Date(Date.now()+9*3600000).toISOString().slice(0,10);
  const end=new Date(Date.parse(start+'T00:00:00Z')+29*86400000).toISOString().slice(0,10);
  return {mode:'current_briefing',published:false,ownId:'own',generatedAt:now,period:{start,end,days:30},companies:[{companyId:'own',kind:'own',relationStatus:'pending',name:'가상 내 매장',regionKey:'raw_town',...binding,rooms:16,summary:{days:0,reservationRate:null,publicBookings:null,phoneBookings:null,estimatedRevenue:null}}],comparisons:[],regions:['raw_town','city_county','interest'].map(id=>({region:{id,label:id},month:'2026-09',availableSources:0,sources:[]})),actions:[],definitions:['내 매장 소유 확인은 대기 상태입니다. 지역 자료는 읽기 전용으로 제공합니다.'],responseCache:{state:'cached',checkedAt:now,persisted:true,validUntil:new Date(Date.now()+86400000).toISOString(),revalidationRequired:true,refreshing:false,refreshFailed:false}};
}
function regionCards(html){return html.match(/<div class="briefing-region-grid">([\s\S]*?)<\/div><\/section>/)[1];}
const card=(label,title)=>new RegExp('<span class="status-pill">'+label+'<\\/span><h3>'+title+'<\\/h3>');

test('a normalized pending own-company region is labelled as the property location without changing other interest regions',()=>{
  const data=report({analysisRegionKey:'city_county'}),html=view().reportView(data),cards=regionCards(html);
  assert.match(cards,card('매장 소재지','city_county'));
  assert.match(cards,card('관심지역','raw_town'));
  assert.match(cards,card('관심지역','interest'));
  assert.match(html,/소유 확인은 대기 상태/);
  assert.equal(data.companies[0].relationStatus,'pending');
  assert.equal(data.companies[0].regionKey,'raw_town');
  assert.match(cards,/href="#regions=city_county"/);
});

test('legacy briefings with no normalized field retain the original property-region badge',()=>{
  const cards=regionCards(view().reportView(report()));
  assert.match(cards,card('매장 소재지','raw_town'));
  assert.match(cards,card('관심지역','city_county'));
});

test('an explicitly unresolved normalized mapping does not silently use the raw town as a property region',()=>{
  const cards=regionCards(view().reportView(report({analysisRegionKey:null})));
  assert.doesNotMatch(cards,/매장 소재지/);
  assert.match(cards,card('관심지역','raw_town'));
});

test('a normalized key survives authenticated browser cache restoration and redraw',()=>{
  const api=view(),data=report({analysisRegionKey:'city_county'});
  api.configureReports({scope:'customer:synthetic',ownIds:['own'],companyIds:['own'],regionKeys:['raw_town','city_county','interest'],permissionVersion:'synthetic-v1'});
  api.restoreReports([{ownId:'own',period:data.period,data}],'customer:synthetic');
  const restored=api.peekCurrentBriefing('own');
  assert.equal(restored.companies[0].analysisRegionKey,'city_county');
  assert.equal(restored.companies[0].relationStatus,'pending');
  assert.match(regionCards(api.reportView(restored)),card('매장 소재지','city_county'));
  restored.companies[0].analysisRegionKey='mutated';
  assert.equal(api.peekCurrentBriefing('own').companies[0].analysisRegionKey,'city_county');
});

test('an explicit null survives browser cache restoration instead of becoming a legacy fallback',()=>{
  const api=view(),data=report({analysisRegionKey:null});
  api.configureReports({scope:'customer:synthetic',ownIds:['own'],companyIds:['own'],regionKeys:['raw_town','city_county','interest'],permissionVersion:'synthetic-v1'});
  api.restoreReports([{ownId:'own',period:data.period,data}],'customer:synthetic');
  const restored=api.peekCurrentBriefing('own');
  assert.ok(Object.hasOwn(restored.companies[0],'analysisRegionKey'));
  assert.equal(restored.companies[0].analysisRegionKey,null);
  assert.doesNotMatch(regionCards(api.reportView(restored)),/매장 소재지/);
});
