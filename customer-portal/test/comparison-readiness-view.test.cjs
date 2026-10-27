'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),http=require('node:http');
const model=require('../web/comparison-readiness.js'),view=require('../web/comparison-readiness-view.js');
const {buildComparisonSet,summarizeCompany,projectReservationSeries}=require('../../scripts/lib/insight_comparison.cjs');
const today=()=>new Date(Date.now()+9*3600000).toISOString().slice(0,10);
const shift=(date,n)=>new Date(Date.parse(date+'T00:00:00Z')+n*86400000).toISOString().slice(0,10);
const clone=value=>JSON.parse(JSON.stringify(value));
function fixture(){
  const start=today(),period={start,end:shift(start,29),days:30},policy={mode:'current',asOf:start,period};
  const raw=[['own','r1',0],['same','r1',5],['cross','r2',6]].map(([companyId,regionKey,sold])=>({
    companyId,name:companyId==='own'?'월명글램핑':companyId==='same'?'산청 비교업체':'다른 지역 비교업체',kind:companyId==='own'?'own':'competitor',
    regionKey,rooms:16,capacityStatus:'reviewed',relationStatus:'active',industryTags:['glamping'],comparisonPurpose:companyId==='cross'?'reference':'direct',
    days:Array.from({length:30},(_,i)=>({date:shift(start,i),total:16,sold,publicBookings:sold,phoneBookings:0,estimatedRevenue:sold*100000,collectedAt:start+'T03:00:00.000Z'}))
  }));
  raw[1].days[2]={...raw[1].days[2],sold:null,publicBookings:null,phoneBookings:null,estimatedRevenue:null,missing:true};
  raw[2].days[3]={...raw[2].days[3],estimatedRevenue:null,revenuePartial:true,revenueUnknownRooms:2,phoneMissingPriceBookings:0};
  const companies=raw.map(c=>({...c,...summarizeCompany(c,policy),reservationSeries:projectReservationSeries(c,policy)}));
  const report={mode:'current_briefing',published:false,generatedAt:new Date().toISOString(),ownId:'own',asOf:start,period,companies,
    comparisons:buildComparisonSet(raw[0],raw.slice(1),policy).comparisons,regions:[],actions:[],definitions:[],dataQuality:{status:'partial',issues:[]}};
  return {report,selection:{ownCompanyId:'own',comparisonIds:['same','cross'],stayMode:'upcoming30',stayStart:start,stayEnd:period.end,asOfDate:start,selectedView:'flow'}};
}
function analysisView(){
  const window={InsightComparisonReadiness:model,InsightComparisonReadinessView:view};
  vm.runInNewContext(fs.readFileSync(require.resolve('../web/analysis.js'),'utf8'),{window,document:{addEventListener(){},querySelector(){return null;}}});
  return window.InsightAnalysis;
}

test('readiness UMD renderer uses only the supplied saved report and performs no network, storage or DOM operations',()=>{
  const bad=()=>{throw Error('readiness must remain read only');},window={InsightComparisonReadiness:model},scope={window,fetch:bad,XMLHttpRequest:bad,localStorage:{getItem:bad,setItem:bad},document:new Proxy({},{get:bad})};
  vm.runInNewContext(fs.readFileSync(require.resolve('../web/comparison-readiness-view.js'),'utf8'),scope);
  assert.equal(typeof window.InsightComparisonReadinessView.render,'function');
  const f=fixture(),before=JSON.stringify(f.report),html=window.InsightComparisonReadinessView.render(f.report,f.selection);
  assert.match(html,/data-comparison-readiness/);assert.equal(JSON.stringify(f.report),before);
  assert.doesNotMatch(html,/<form|<button|data-collection|수집하기|예약 재개|정기수집 요청/);
});

test('same-region and cross-region comparisons retain distinct meanings with company evidence links',()=>{
  const f=fixture(),html=view.render(f.report,f.selection);
  assert.match(html,/월명글램핑/);assert.match(html,/같은 지역/);assert.match(html,/다른 지역 · 운영 참고/);
  assert.match(html,/수치 참고는 전략 판단 가능을 뜻하지 않습니다/);
  assert.match(html,/href="#company=same"/);assert.match(html,/href="#company=cross"/);
  assert.equal((html.match(/data-readiness-company=/g)||[]).length,3);
  assert.doesNotMatch(html,/지역 전체 평균|통합 경쟁 순위|매출 총합|NaN|undefined/);
});

test('normal zero remains visible while missing quantity and partial money retain their exact dates and explanations',()=>{
  const f=fixture(),html=view.render(f.report,f.selection);
  assert.match(html,/0실/);assert.match(html,/정상 0실과 미확인은 다르며/);
  assert.match(html,new RegExp(shift(f.report.period.start,2)));assert.match(html,new RegExp(shift(f.report.period.start,3)));
  assert.match(html,/수량 미확인/);assert.match(html,/금액 미확인/);assert.match(html,/확인된 소계 · 전체 매출 아님/);
  assert.match(html,/QUANTITY_MISSING/);assert.match(html,/비교 제외 날짜와 사유/);
});

test('displayability cannot become comparability based on metric status labels alone',()=>{
  assert.equal(view.metricStatus({status:'ready',displayable:true,comparable:false}),'수치 참고 · 비교 보류');
  assert.equal(view.metricStatus({status:'ready',displayable:false,comparable:false}),'미확인 · 비교 보류');
  assert.equal(view.metricStatus({status:'partial',displayable:true,comparable:true}),'비교 가능');
  assert.equal(view.metricStatus(null),'미확인 · 비교 보류');
});

test('pending calculation preview keeps stored amounts visible without promoting stale comparison flags',()=>{
  const f=fixture();f.report.responseCache={state:'preview',preview:true,refreshing:true,refreshFailed:false,calculationStatus:'pending'};
  f.report.calculation={mode:'saved_only',status:'pending'};
  const m=model.build(f.report,f.selection),html=view.render(f.report,f.selection);
  assert.ok(m.comparisons.every(row=>row.comparable===false&&row.actionable===false));
  assert.match(html,/저장 자료 미리보기 · 최종 비교 계산 전/);assert.doesNotMatch(html,/>비교 가능</);
  assert.match(html,/확인된 소계/);
});

test('legacy rows retain a reference display without manufacturing eligible daily evidence',()=>{
  const f=fixture();
  for(const c of f.report.companies){delete c.days;delete c.reservationSeries;delete c.summaryQuality;delete c.reservationPeriods;}
  f.report.comparisons=f.report.comparisons.map(c=>({companyId:c.companyId,name:c.name,commonDays:c.commonDays,own:c.own,competitor:c.competitor,gapPp:c.gapPp,status:'comparable'}));
  const html=view.render(f.report,f.selection),m=model.build(f.report,f.selection);
  assert.ok(m.comparisons.every(row=>row.comparable===false&&row.actionable===false));
  assert.match(html,/확보 범위 미확인|날짜별 근거/);assert.doesNotMatch(html,/>비교 가능</);
});

test('duplicate selected IDs and repeated company rows cannot create duplicate readiness summary rows',()=>{
  const f=fixture();f.selection.comparisonIds=['same','same','own','cross'];f.report.companies.push(clone(f.report.companies[1]));
  const html=view.render(f.report,f.selection);
  assert.equal((html.match(/data-readiness-company="same"/g)||[]).length,1);
  assert.equal((html.match(/data-readiness-company="own"/g)||[]).length,1);
});

test('company names, source labels and unknown error codes are escaped in rows and evidence',()=>{
  const f=fixture(),m=model.build(f.report,f.selection),hostile='<img src=x onerror=alert(1)>';
  m.companies[0].name=hostile;m.companies[0].capacity.label=hostile;m.companies[0].issues=[{date:f.report.period.start,label:hostile,code:'<script>unsafe</script>'}];
  m.comparisons[0].name=hostile;m.comparisons[0].reasons=[{label:hostile,code:'<svg onload=x>'}];
  const html=view.renderModel(m);
  assert.match(html,/&lt;img src=x onerror=alert\(1\)&gt;/);assert.match(html,/&lt;script&gt;unsafe&lt;\/script&gt;/);
  assert.doesNotMatch(html,/<img|<script|<svg onload/);
});

test('competitive comparison and report views share the same saved-evidence readiness section',()=>{
  const f=fixture(),comparison=require('../web/comparison-view.js').render(f.report,f.selection),report=analysisView().reportView(f.report);
  for(const html of [comparison,report]){assert.match(html,/data-comparison-readiness/);assert.match(html,/공통 날짜·미확인·제외 사유/);assert.match(html,/QUANTITY_MISSING/);}
  assert.equal((comparison.match(/data-comparison-readiness/g)||[]).length,1);
  assert.equal((report.match(/data-comparison-readiness/g)||[]).length,1);
});

test('legacy report comparison table cannot contradict readiness by promoting an old comparable status',()=>{
  const f=fixture();
  f.report.comparisons=f.report.comparisons.map(c=>({companyId:c.companyId,name:c.name,commonDays:c.commonDays,own:c.own,competitor:c.competitor,gapPp:c.gapPp,status:'comparable'}));
  const html=analysisView().reportView(f.report),table=html.slice(html.indexOf('<h2>경쟁업체와의 차이</h2>'),html.indexOf('<h2>지역 수요 배경</h2>'));
  assert.doesNotMatch(table,/>비교 가능</);assert.match(table,/이전 기준 참고|비교 보류|판단 보류/);
});

test('current cross-region report comparisons remain explicit operating references rather than actionable local competition',()=>{
  const f=fixture(),html=analysisView().reportView(f.report),table=html.slice(html.indexOf('<h2>경쟁업체와의 차이</h2>'),html.indexOf('<h2>지역 수요 배경</h2>'));
  assert.match(table,/다른 지역|운영 참고/);assert.match(table,/판단 보류/);
  assert.doesNotMatch(table,/>비교 가능</);
});

test('public connected UI versions and serves both readiness assets without enabling collection',async t=>{
  const {createReviewConnectedServer}=require('../review/comparison/connected.cjs');
  const server=createReviewConnectedServer({port:58055});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const read=route=>new Promise((resolve,reject)=>{const req=http.get({host:'127.0.0.1',port:server.address().port,path:route,headers:{Host:'127.0.0.1:58055'}},res=>{let body='';res.on('data',value=>body+=value);res.on('end',()=>resolve({status:res.statusCode,body}));});req.on('error',reject);});
  const page=await read('/');assert.equal(page.status,200);
  for(const name of ['comparison-readiness.js','comparison-readiness-view.js']){
    assert.match(page.body,new RegExp(name.replace('.','\\.')+'\\?v='));
    assert.equal((await read('/'+name)).status,200);
  }
  assert.ok(page.body.indexOf('/comparison-readiness.js')<page.body.indexOf('/comparison-readiness-view.js'));
});
