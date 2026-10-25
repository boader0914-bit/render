'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const view=require('../web/regional-context-view.js');
const copy=value=>JSON.parse(JSON.stringify(value));
function source(key='tourism_visitors',values=[10,0,null,25]){
  const months=['2026-06','2026-07','2026-08','2026-09'],latest=values.map((value,i)=>({month:months[i],value})).filter(p=>p.value!==null).at(-1)||null;
  return {key,label:key==='naver_search_trend'?'검색 트렌드':'지역 방문자',provider:'제공기관',status:'partial',period:'2025-10 ~ 2026-09',periodType:'M',keyword:'지역 숙소',normalizationPeriod:'2025-10-01 ~ 2026-09-30',metrics:[{key:'value',label:'방문자',unit:'명',observedMonths:values.filter(v=>v!==null).length,latest,mom:{value:5,kind:'percent'}}],series:months.map((month,i)=>({month,status:values[i]===null?'missing':'observed',rows:[{key:'value',label:'방문자',value:values[i],unit:'명',status:values[i]===null?'missing':'observed'}]}))};
}
function fixture(){
  const state={customer:{accountStatus:'active',relations:[{companyId:'own',kind:'own',status:'active'},{companyId:'same',kind:'competitor',status:'active'},{companyId:'cross',kind:'competitor',status:'active'},{companyId:'hidden',kind:'competitor',status:'active'},{companyId:'pending',kind:'competitor',status:'pending'}],regions:[{regionKey:'interest',status:'active'},{regionKey:'pending_interest',status:'pending'}]},companies:[{companyId:'own',name:'내 매장'},{companyId:'same',name:'같은 지역 업체'},{companyId:'cross',name:'다른 지역 업체'},{companyId:'hidden',name:'선택하지 않은 업체'},{companyId:'pending',name:'미승인 업체'}],regions:[{id:'r1',label:'기준지역'},{id:'interest',label:'관심지역'}]};
  const selection={ownCompanyId:'own',comparisonIds:['same','cross'],regionMonth:'2026-09'};
  const data={schemaVersion:1,mode:'comparison_region_summary',ownId:'own',month:'2026-09',source:'datalab_saved',networkAttempted:false,access:{summaryOnly:true,fullAnalysis:false,preparation:false},bindings:[['own','own','r1'],['same','competitor','r1'],['cross','competitor','r2'],['hidden','competitor','hidden_region'],['pending','competitor','pending_region']].map(([companyId,kind,regionKey])=>({companyId,kind,relationStatus:companyId==='pending'?'pending':'active',regionKey,analysisRegionKey:regionKey,regionLabel:regionKey,hierarchyApplied:false})),groups:[{region:{id:'r1',label:'기준지역'},companyIds:['own','same'],kinds:['own','competitor'],relationToOwn:'same',status:'partial',summary:{sources:[source()],sourceIssues:[]}},{region:{id:'r2',label:'다른지역'},companyIds:['cross'],kinds:['competitor'],relationToOwn:'cross',status:'ready',summary:{sources:[source('naver_search_trend')],sourceIssues:[]}},{region:{id:'interest',label:'관심지역'},companyIds:[],kinds:['interest'],relationToOwn:'cross',status:'unavailable',summary:{sources:[],sourceIssues:[]}},{region:{id:'hidden_region',label:'비선택지역'},companyIds:['hidden'],kinds:['competitor'],relationToOwn:'cross',status:'ready',summary:{sources:[source()],sourceIssues:[]}},{region:{id:'pending_interest',label:'미승인관심지역'},companyIds:[],kinds:['interest'],relationToOwn:'unknown',status:'ready',summary:{sources:[source()],sourceIssues:[]}}],unresolved:[]};
  return {data,options:{state,selection}};
}
test('UMD render remains DOM independent and exposes stable view slots without a collector or preparation button',()=>{
  const scope={};vm.runInNewContext(fs.readFileSync(require.resolve('../web/regional-context-view.js'),'utf8'),scope);
  assert.equal(typeof scope.InsightRegionalContextView.render,'function');const f=fixture(),html=view.panel(f.options.state,f.options.selection);
  assert.match(html,/id="regional-context-output"/);assert.match(html,/id="regional-context-status"/);assert.doesNotMatch(html,/<button|지역 자료 갱신|수집/);
});
test('same-region companies share one canonical region and mixed competitors retain distinct backgrounds',()=>{
  const f=fixture(),m=view.model(f.data,f.options),html=view.render(f.data,f.options);
  assert.equal(m.groups.length,3);assert.deepEqual(m.groups[0].companyIds,['own','same']);assert.equal(m.groups[0].own,true);assert.equal(m.groups[0].competitor,true);
  assert.match(html,/내 매장<\/span><span>경쟁업체/);assert.match(html,/다른 지역 · 참고 비교/);assert.match(html,/타지역 경쟁업체/);
  assert.doesNotMatch(html,/비선택지역|선택하지 않은 업체|미승인관심지역/);
});
test('deselecting a competitor removes that region while keeping own and active interest regions',()=>{
  const f=fixture();f.options.selection.comparisonIds=[];const m=view.model(f.data,f.options);
  assert.deepEqual(m.groups.map(g=>g.region.id),['r1','interest']);assert.deepEqual(m.groups[0].companyIds,['own']);
});
test('pending competitors retain explicitly pending saved summaries while pending interests remain unavailable',()=>{
  const f=fixture();f.options.selection.comparisonIds=['pending'];f.data.groups.push({region:{id:'pending_region',label:'대기업체지역'},companyIds:['pending'],kinds:['competitor'],relationToOwn:'cross',summary:{sources:[source()]}});
  const html=view.render(f.data,f.options);assert.match(html,/대기업체지역/);assert.match(html,/연결 확인 대기 · 저장요약/);assert.doesNotMatch(html,/미승인관심지역/);
});
test('a pending own registration can read its saved summary without being promoted to active',()=>{
  const f=fixture();f.options.state.customer.relations[0].status='pending';f.data.bindings[0].relationStatus='pending';
  const model=view.model(f.data,f.options);assert.equal(model.valid,true);assert.equal(model.groups[0].pending,true);assert.match(view.render(f.data,f.options),/연결 확인 대기 · 저장요약/);
});
test('full detail links require an explicit full-analysis region in the current authorized state',()=>{
  const f=fixture(),html=view.render(f.data,f.options);
  assert.match(html,/href="#regions=r1"/);assert.match(html,/href="#regions=interest"/);assert.doesNotMatch(html,/href="#regions=r2"|data-history-refresh|preparation|수집하기/);
});
for(const [name,mutate] of [
  ['foreign own store',f=>{f.data.ownId='other';}],['wrong month',f=>{f.data.month='2026-08';}],['network source',f=>{f.data.networkAttempted=true;}],['wrong schema',f=>{f.data.schemaVersion=2;}],['full-analysis escalation',f=>{f.data.access.fullAnalysis=true;}],['preparation escalation',f=>{f.data.access.preparation=true;}],['missing active own registration',f=>{f.options.state.customer.relations[0].status='archived';}]
])test(`scope mismatch ${name} withholds all regional numbers`,()=>{
  const f=fixture();mutate(f);const html=view.render(f.data,f.options);assert.match(html,/이전 조건의 지표를 표시하지 않습니다/);assert.doesNotMatch(html,/<svg|regional-context-value/);
});
test('all four source categories are explicit and unfamiliar keys do not become invented tourism metrics',()=>{
  const f=fixture();f.data.groups[0].summary.sources.push(source('tourism_resource'),source('tourism_diversity'),{key:'kosis_population',label:'주민등록 인구',provider:'KOSIS',period:'2026-08',periodType:'M',status:'ready',rows:[{key:'population',label:'총인구',value:200,unit:'명',status:'observed'}]},source('foreign_score'));
  const html=view.render(f.data,f.options);for(const label of ['수요 흐름','관심 흐름','수요 배경','관광 구성'])assert.match(html,new RegExp('aria-label="'+label+'"'));
  assert.match(html,/주민등록 인구/);assert.doesNotMatch(html,/foreign_score/);
});
test('normal zero remains a value and a missing month breaks the chart without a zero booking substitute',()=>{
  const f=fixture(),points=view.metricPoints(f.data.groups[0].summary.sources[0],{key:'value'},'2026-09'),html=view.chart(points,'지역 <방문자>','명');
  assert.equal(points[1].value,0);assert.equal(points[2].value,null);assert.equal((html.match(/<polyline/g)||[]).length,2);assert.equal((html.match(/<circle/g)||[]).length,3);
  assert.match(html,/cy="102"/);assert.match(html,/2026-07: 0 명/);assert.match(html,/2026-08 · 자료 없음/);assert.doesNotMatch(html,/<방문자>/);
});
test('latest confirmed month closes the visible chart while unconfirmed trailing months remain in the evidence',()=>{
  const f=fixture();f.data.groups[0].summary.sources=[source('tourism_visitors',[10,12,20,null])];const html=view.render(f.data,f.options);
  assert.match(html,/최신 확보 2026-08/);assert.match(html,/실제 표시 2026-06 ~ 2026-08 · 3개월/);assert.match(html,/미확인 1개월/);assert.match(html,/미확인 월: 2026-09/);assert.match(html,/3\/4개월 확보/);
});
test('eleven confirmed months stay eleven and actual publication dates never become the requested month',()=>{
  const f=fixture(),s=source();s.series=Array.from({length:12},(_,i)=>({month:i<3?'2025-'+String(i+10).padStart(2,'0'):'2026-'+String(i-2).padStart(2,'0'),status:i===11?'publication_pending':'observed',rows:[{key:'value',value:i===11?null:i,unit:'명',status:i===11?'publication_pending':'observed'}]}));s.metrics[0].latest={month:'2026-08',value:10};f.data.groups[0].summary.sources=[s];const html=view.render(f.data,f.options);
  assert.match(html,/11\/12개월 확보/);assert.match(html,/실제 표시 2025-10 ~ 2026-08 · 11개월/);assert.match(html,/2026-09 \(공표 대기\)/);
});
test('annual industry statistics retain their annual vintage and are never spread across twelve months',()=>{
  const f=fixture();f.data.groups[0].summary.sources=[{key:'kosis_establishments',label:'사업체 수',provider:'KOSIS',period:'2024',periodType:'Y',status:'ready',rows:[{key:'establishments',label:'사업체 수',value:100,unit:'개',status:'observed'},{key:'employees',label:'종사자',value:null,unit:'명',status:'missing'}]}];const html=view.render(f.data,f.options);
  assert.match(html,/실제 공표기간 2024/);assert.match(html,/연간 통계 · 월별 값으로 환산하지 않습니다/);assert.match(html,/100 <small>개/);assert.match(html,/미확인 명/);
});
test('actual KOSIS source states remain understandable and suppressed values never become normal zero',()=>{
  const f=fixture();f.data.groups[0].summary.sources=[{key:'kosis_population',label:'인구',provider:'KOSIS',status:'stale',period:'2026-08',rows:[{key:'total',label:'전체',unit:'명',value:10,status:'stale'},{key:'private',label:'비공개항목',unit:'명',value:0,status:'suppressed'},{key:'unmapped',label:'연결항목',unit:'명',value:null,status:'mapping_missing'},{key:'unread',label:'미수집항목',unit:'명',value:null,status:'not_collected'}]}];
  const html=view.render(f.data,f.options);assert.match(html,/이전 저장 자료/);assert.match(html,/지역 연결 필요/);assert.match(html,/미수집/);assert.match(html,/미확인 명<\/td><td>비공개/);assert.doesNotMatch(html,/비공개항목<\/th><td>0 명/);
});
test('secondary source metrics keep their own confirmed month and zero visible outside folded evidence',()=>{
  const f=fixture(),s=source('tourism_stay_spend');s.metrics.push({key:'spend',label:'소비 지수',unit:'지수',latest:{month:'2026-08',value:0},observedMonths:3});
  for(const p of s.series){if(p.month==='2026-08')p.status='observed';p.rows.push({key:'spend',value:p.month==='2026-09'?null:0,status:p.month==='2026-09'?'missing':'observed'});}
  f.data.groups[0].summary.sources=[s];const html=view.render(f.data,f.options),before=html.slice(0,html.indexOf('<details class="regional-context-evidence">'));
  assert.match(before,/소비 지수<\/dt><dd>0 지수<small>2026-08/);
});
test('search normalization and keywords stay explicit and differently normalized regions are not ranked',()=>{
  const f=fixture();const s=source('naver_search_trend');s.normalizationPeriod='2024-10-01 ~ 2025-09-30';f.data.groups[0].summary.sources.push(s);const html=view.render(f.data,f.options);
  assert.match(html,/검색지수 산정기간이 달라/);assert.match(html,/산정기간 2024-10-01 ~ 2025-09-30/);assert.match(html,/다른 지역·산정기간과 직접 비교하지 않습니다/);assert.match(html,/검색어 지역 숙소/);
});
test('an entirely empty source stays unconfirmed rather than showing zero or connecting a chart',()=>{
  const f=fixture();f.data.groups[0].summary.sources=[source('tourism_visitors',[null,null,null,null])];const html=view.render(f.data,f.options);
  assert.match(html,/확보월 미확인/);assert.match(html,/0\/4개월 확보/);assert.match(html,/표시할 월별 수치가 없습니다/);assert.doesNotMatch(html,/<strong>0 <small>명/);
});
test('duplicate or failed monthly rows with numeric payloads remain unknown and future points are excluded',()=>{
  const s=source();s.series.push(copy(s.series[0]),{month:'2026-10',status:'observed',rows:[{key:'value',value:999,status:'observed'}]});s.series[1].status='failed';const p=view.metricPoints(s,{key:'value'},'2026-09');
  assert.equal(p[0].value,null);assert.equal(p[0].status,'conflict');assert.equal(p[1].value,null);assert.equal(p.some(v=>v.month==='2026-10'),false);
});
test('a missing month omitted from a sparse stored series becomes an explicit gap and never a connected line',()=>{
  const s=source();s.series=s.series.filter(p=>['2026-06','2026-09'].includes(p.month));const points=view.metricPoints(s,{key:'value'},'2026-09'),html=view.chart(points,'방문자','명');
  assert.deepEqual(points.map(p=>p.value),[10,null,null,25]);assert.equal((html.match(/<polyline/g)||[]).length,2);assert.match(html,/2026-07 · 자료 없음/);
});
test('duplicate canonical groups deduplicate equal values but withhold conflicting summaries',()=>{
  const f=fixture();f.data.groups.push(copy(f.data.groups[0]));assert.equal(view.model(f.data,f.options).groups.length,3);
  f.data.groups.at(-1).summary.sources[0].series[0].rows[0].value=999;const m=view.model(f.data,f.options);assert.equal(m.groups[0].status,'unavailable');assert.equal(m.groups[0].summary.sources.length,0);assert.match(view.render(f.data,f.options),/같은 지역의 요약 값이 달라/);
});
test('selected unresolved companies and source issues are useful, escaped, and unrelated issues are omitted',()=>{
  const f=fixture();f.data.unresolved=[{companyId:'cross',reason:'주소 <검토> 필요'},{companyId:'hidden',reason:'숨긴 사유'}];f.data.groups[0].summary.sourceIssues=[{reason:'저장 자료 <실패>'}];const html=view.render(f.data,f.options);
  assert.match(html,/주소 &lt;검토&gt; 필요/);assert.match(html,/저장 자료 &lt;실패&gt;/);assert.doesNotMatch(html,/숨긴 사유|<검토>|<실패>/);
});
test('an interest region works without an own company and does not invent a baseline or reservation totals',()=>{
  const f=fixture();f.options.selection.ownCompanyId=null;f.options.selection.comparisonIds=[];f.data.ownId=null;const m=view.model(f.data,f.options),html=view.render(f.data,f.options);
  assert.equal(m.groups.length,1);assert.equal(m.groups[0].interest,true);assert.doesNotMatch(html,/내 매장 기준 지역|예약 0|매출 0/);
});
test('unregistered regions never appear solely because the server labels them as an interest region',()=>{
  const f=fixture();f.data.groups.push({region:{id:'unregistered',label:'임의지역'},companyIds:[],kinds:['interest'],relationToOwn:'unknown',summary:{sources:[source()]}});assert.doesNotMatch(view.render(f.data,f.options),/임의지역/);
});
test('zero-baseline percentages and index changes retain their correct units',()=>{
  assert.equal(view.delta({value:null,kind:'zero_baseline'}),'비교 불가 · 기준값 0');assert.equal(view.delta({value:0,kind:'percent'}),'0%');assert.equal(view.delta({value:-3.5,kind:'index_difference'}),'-3.5 지수');assert.equal(view.delta({value:10,kind:'other'}),'비교 자료 없음');
});
test('a change statistic is held when its latest value disagrees with the monthly evidence',()=>{
  const f=fixture();f.options.selection.comparisonIds=[];f.data.groups[0].summary.sources[0].metrics[0].latest.value=99;const html=view.render(f.data,f.options);
  assert.match(html,/전월 대비<\/span><b>비교 자료 없음/);assert.doesNotMatch(html,/전월 대비<\/span><b>\+5%/);
});
