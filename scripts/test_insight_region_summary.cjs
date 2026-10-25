'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),http=require('node:http'),crypto=require('node:crypto');
const {createInsightAnalysis,regionIds,readableRegionIds}=require('./lib/insight_analysis.cjs');
const {createInsightStore,fault}=require('./lib/insight_store.cjs');
const {createInsightHttp}=require('./lib/insight_http.cjs');
const {monthsEnding}=require('./lib/insight_region_history.cjs');
const {comparisonRegionBindings,buildRegionSummarySelection,projectRegionSummary,REGION_SUMMARY_REASONS}=require('./lib/insight_region_summary.cjs');
const clone=value=>JSON.parse(JSON.stringify(value));
const catalog=()=>({companies:[{companyId:'own_a',name:'내 매장',regionKey:'home',rooms:16},{companyId:'own_b',name:'다른 내 매장',regionKey:'other',rooms:10},{companyId:'same',name:'같은 지역',regionKey:'home'},{companyId:'cross',name:'다른 지역',regionKey:'other'},{companyId:'unknown',name:'이름으로는 산청 글램핑',regionKey:'',address:'home'},{companyId:'district',name:'일반구 업체',regionKey:'district_a'},{companyId:'broad_company',name:'광역만 연결',regionKey:'province'}],regions:[{id:'home',label:'내 지역',level:'local'},{id:'other',label:'다른 지역',level:'local'},{id:'interest',label:'관심 지역',level:'local'},{id:'city',label:'공식 분석 시',level:'local'},{id:'province',label:'광역',level:'broad'}],regionHierarchy:{district_a:'city',district_b:'city'}});
const customer=()=>({customerId:'fixture_customer',accountStatus:'active',revision:1,relations:[{relationId:'rel_own',companyId:'own_a',kind:'own',status:'pending'},{relationId:'rel_same',companyId:'same',kind:'competitor',status:'active'},{relationId:'rel_cross',companyId:'cross',kind:'competitor',status:'active'}],regions:[{relationId:'rel_interest',regionKey:'home',status:'active'}],entitlements:{competitorLimit:3,interestRegionLimit:1}});
const context=()=>({networkAttempted:false,window:{currentMonth:'2026-10'},location:{secret:'PRIVATE_LOCATION'},sources:[{key:'tourism_visitors',label:'지역 방문자',provider:'한국관광공사',status:'ready',period:'2025-10 ~ 2026-09',periodType:'M',sourceUrl:'https://example.org/public',secret:'PRIVATE_SOURCE',rows:[{key:'visitors',label:'일평균 방문자',unit:'명',value:0,status:'observed',secret:'PRIVATE_ROW'}],series:monthsEnding('2026-09',24).map((month,i)=>({month,status:'observed',rows:[{key:'visitors',label:'일평균 방문자',unit:'명',value:i===23?0:i,status:'observed'}]}))},{key:'kosis_population',label:'인구',provider:'국가데이터처',status:'ready',period:'2025',periodType:'Y',rows:[{key:'population',label:'인구',unit:'명',value:100,status:'observed'}]}]});
function service(data=catalog(),read=async()=>context()) {
  const reads=[],prepares=[],locations=[];
  const analysis=createInsightAnalysis({catalog:async()=>clone(data),now:()=>Date.parse('2026-10-25T00:00:00Z'),readRegionContext:async input=>{reads.push(clone(input));return read(input);},readRegionLocation:async key=>{locations.push(key);return {secret:'PRIVATE_LOCATION'};},regionPreparation:{get:async input=>{prepares.push(input);return null;},start:async input=>{prepares.push(input);return null;}}});
  return {analysis,data,reads,prepares,locations,async summary(c=customer(),ownId='own_a',month='2026-09'){return analysis.comparisonRegionSummary(analysis.comparisonRegionSelection(c,ownId,month,clone(data)),clone(data));}};
}
test('selected own and registered competitors share each official analysis-region read once, including a same-region interest',async()=>{
  const c=customer(),before=clone(c),s=service(),value=await s.summary(c);
  assert.equal(value.mode,'comparison_region_summary');assert.equal(value.ownId,'own_a');assert.equal(value.groups.length,2);assert.deepEqual(s.reads.map(r=>r.targetId),['home','other']);
  assert.deepEqual(value.groups[0].kinds,['own','competitor','interest']);assert.deepEqual(value.groups[0].companyIds,['own_a','same']);assert.equal(value.groups[0].relationToOwn,'same');assert.equal(value.groups[1].relationToOwn,'cross');
  assert.deepEqual(value.access,{summaryOnly:true,fullAnalysis:false,preparation:false});assert.equal(value.networkAttempted,false);assert.equal(s.prepares.length,0);assert.equal(s.locations.length,0);assert.deepEqual(c,before);
});
test('same-only, cross-only and mixed competition remain distinct without treating a province as one market',async()=>{
  for(const [competitors,expected] of [[['same'],['same']],[['cross'],['same','cross']],[['same','cross'],['same','cross']]]) {
    const c=customer();c.relations=c.relations.filter(r=>r.kind==='own'||competitors.includes(r.companyId));c.regions=[];
    const s=service(),value=await s.summary(c);assert.deepEqual(value.groups.map(g=>g.relationToOwn),expected);
  }
});
test('omitting own explicitly means an unanchored reference even if an own store is registered; an invalid explicit own is rejected',async()=>{
  const s=service(),value=await s.summary(customer(),null);assert.equal(value.ownId,null);assert.ok(value.bindings.every(r=>r.kind==='competitor'));assert.ok(value.groups.every(r=>r.relationToOwn==='unknown'));assert.deepEqual(s.reads.map(r=>r.targetId),['home','other']);
  const empty={...customer(),relations:[],regions:[]},unregistered=await s.summary(empty,null);assert.deepEqual(unregistered.groups,[]);assert.deepEqual(unregistered.bindings,[]);
  const before=s.reads.length;await assert.rejects(s.summary(customer(),'cross'),{code:'NOT_FOUND'});await assert.rejects(s.summary(customer(),'unregistered'),{code:'NOT_FOUND'});assert.equal(s.reads.length,before);
});
test('all-own state bindings and selected-own response bindings are separate, while pending own grants no preparation',async()=>{
  const c=customer();c.relations.push({companyId:'own_b',kind:'own',status:'active'});const data=catalog(),all=comparisonRegionBindings(c,data),selection=buildRegionSummarySelection(c,data,{ownId:'own_a',month:'2026-09'});
  assert.ok(all.some(r=>r.companyId==='own_b'));assert.ok(!selection.value.bindings.some(r=>r.companyId==='own_b'));assert.deepEqual([...regionIds({...c,relations:c.relations.filter(r=>r.companyId==='own_a'),regions:[]},data)],[]);
  const s=service();await s.summary({...c,regions:[]});await assert.rejects(s.analysis.preparation({...c,relations:c.relations.filter(r=>r.companyId==='own_a'),regions:[]},'home','2026-09',true),{code:'NOT_FOUND'});assert.equal(s.prepares.length,0);
});
test('competitor-derived access never grants full analysis or preparation or consumes an interest slot',async()=>{
  const c=customer();c.regions=[];const s=service(),before=clone(c);await s.summary(c);
  assert.deepEqual([...readableRegionIds(c,s.data)],['home']);await assert.rejects(s.analysis.region(c,'other','2026-09'),{code:'NOT_FOUND'});await assert.rejects(s.analysis.preparation(c,'other','2026-09',true),{code:'NOT_FOUND'});assert.equal(s.prepares.length,0);assert.deepEqual(c,before);
});
test('official general districts group once under their active local parent; broad, address and unknown names do not grant reads',async()=>{
  const data=catalog();data.companies.find(r=>r.companyId==='own_a').regionKey='district_b';
  const c=customer();c.relations=c.relations.filter(r=>r.kind==='own');c.relations.push(...['district','unknown','broad_company'].map(companyId=>({companyId,kind:'competitor',status:'active'})));c.regions=[{regionKey:'district_a',status:'active'}];
  const s=service(data),value=await s.summary(c);assert.deepEqual(s.reads.map(r=>r.targetId),['city']);assert.ok(value.bindings.find(r=>r.companyId==='district').hierarchyApplied);assert.equal(value.groups[0].relationToOwn,'same');
  assert.deepEqual(value.unresolved.map(r=>r.code),['COMPANY_REGION_UNKNOWN','COMPANY_REGION_UNKNOWN','INTEREST_REGION_UNKNOWN']);assert.ok(value.unresolved.every(r=>r.reason===REGION_SUMMARY_REASONS[r.code]));
});
test('runtime-added official local regions work without hardcoded geography and removed/missing registrations remain unresolved',async()=>{
  const data=catalog(),c=customer();c.relations=c.relations.filter(r=>r.kind==='own');c.regions=[];data.regions.push({id:'new_city',label:'새 공식 지역',level:'local'});data.companies.find(r=>r.companyId==='own_a').regionKey='new_city';
  c.relations.push({companyId:'missing_company',kind:'competitor',status:'pending'},{companyId:'cross',kind:'competitor',status:'archived'});
  const s=service(data),value=await s.summary(c);assert.deepEqual(s.reads.map(r=>r.targetId),['new_city']);assert.equal(value.groups[0].region.label,'새 공식 지역');assert.equal(value.unresolved[0].code,'COMPANY_METADATA_UNAVAILABLE');assert.ok(!value.bindings.some(r=>r.companyId==='cross'));
});
test('conflicting duplicate roles cannot authorize a guessed region while identical duplicates do not create duplicate reads',async()=>{
  const c=customer();c.relations.push({...c.relations[1]});const same=await service().summary(c);assert.equal(same.groups.find(g=>g.region.id==='home').companyIds.filter(id=>id==='same').length,1);
  c.relations.push({companyId:'cross',kind:'own',status:'pending'});const value=await service().summary(c);assert.equal(value.bindings.find(r=>r.companyId==='cross').analysisRegionKey,null);assert.ok(value.unresolved.some(r=>r.code==='COMPANY_RELATION_CONFLICT'));
});
test('only twelve displayed months and safe source fields survive, keeping annual periods, actual latest months and genuine zero',async()=>{
  const value=await service().summary(),group=value.groups[0],visitors=group.summary.sources[0],annual=group.summary.sources[1];
  assert.equal(group.status,'ready');assert.equal(visitors.series.length,12);assert.equal(visitors.series[0].month,'2025-10');assert.equal(visitors.metrics[0].latest.month,'2026-09');assert.equal(visitors.metrics[0].latest.value,0);assert.equal(visitors.rows[0].value,0);assert.equal(annual.period,'2025');assert.equal(annual.periodType,'Y');assert.equal(annual.metrics,undefined);
  assert.doesNotMatch(JSON.stringify(value),/PRIVATE_|location|customers|password|cookie|refreshAvailable/);
});
test('a latest confirmed month is labelled honestly and a missing current publication does not become an observed zero',async()=>{
  const s=service(catalog(),async()=>{const source=context();source.sources[0].status='partial';source.sources[0].series.at(-1).status='publication_pending';source.sources[0].series.at(-1).rows[0]={...source.sources[0].series.at(-1).rows[0],status:'publication_pending',value:0};source.sources[0].rows[0]={...source.sources[0].rows[0],status:'missing',value:0};return source;});
  const value=await s.summary(),source=value.groups[0].summary.sources[0];assert.equal(source.metrics[0].latest.month,'2026-08');assert.equal(source.metrics[0].observedMonths,11);assert.equal(source.series.at(-1).rows[0].value,null);assert.equal(value.groups[0].status,'partial');
});
test('stored series or metrics remain available when current summary rows are absent',()=>{
  const region={id:'home',label:'내 지역'},base={region,networkAttempted:false,sources:[{key:'visitors',status:'partial',rows:[],series:[{month:'2026-08',status:'observed',rows:[{key:'visitors',value:0,status:'observed'}]}]}]};
  assert.equal(projectRegionSummary(base,'2026-09').availableSources,1);assert.equal(projectRegionSummary(base,'2026-09').sourceStatus,'partial');
  base.sources[0].series=[];base.sources[0].metrics=[{key:'v',observedMonths:1,latest:{month:'2026-08',value:0}}];assert.equal(projectRegionSummary(base,'2026-09').availableSources,1);
});
test('missing and failed regional data explain only the affected group and never hide a normal different group',async()=>{
  const s=service(catalog(),async input=>{if(input.targetId==='other')throw Object.assign(Error('PRIVATE_PROVIDER_TOKEN'),{code:'PRIVATE_FAILURE'});return context();}),value=await s.summary();
  assert.equal(value.groups[0].status,'ready');assert.equal(value.groups[1].status,'unavailable');assert.equal(value.groups[1].summary.sourceIssues[0].code,'REGION_SOURCE_UNAVAILABLE');assert.doesNotMatch(JSON.stringify(value),/PRIVATE_/);
  const empty=await service(catalog(),async()=>({networkAttempted:false,sources:[]})).summary();assert.equal(empty.groups[0].summary.sourceIssues[0].code,'REGION_INDICATOR_UNAVAILABLE');
});
test('cache-only violations stop the summary immediately without continuing to another regional adapter',async()=>{
  const s=service(catalog(),async()=>({networkAttempted:true,sources:[]}));await assert.rejects(s.summary(),{code:'READ_ONLY_SOURCE_REQUIRED'});assert.equal(s.reads.length,1);
});
for(const violation of ['INSIGHT_HISTORY_MUST_BE_CACHE_ONLY','MONTHLY_CONTEXT_MUST_BE_CACHE_ONLY','missing-proof'])test(`cache-only ${violation} cannot be disguised as a missing regional statistic`,async()=>{
  const s=service(catalog(),async()=>{if(violation==='missing-proof')return {sources:[]};throw Error(violation);});
  await assert.rejects(s.summary(),{code:'READ_ONLY_SOURCE_REQUIRED'});assert.equal(s.reads.length,1);
});
test('actual KOSIS not-collected, stale and suppressed values remain truthful partial background without a false zero',async()=>{
  for(const status of ['not_collected','stale','mapping_missing']) {
    const s=service(catalog(),async()=>{const value=context();value.sources[1].status=status;value.sources[1].rows[0].status='suppressed';value.sources[1].rows[0].value=0;return value;}),value=await s.summary();
    assert.equal(value.groups[0].status,'partial');assert.equal(value.groups[0].summary.sources[1].status,status);assert.equal(value.groups[0].summary.sources[1].rows[0].status,'suppressed');assert.equal(value.groups[0].summary.sources[1].rows[0].value,null);
  }
});
test('summary projection drops credential links and replaces arbitrary failure text with controlled reasons',()=>{
  const value=projectRegionSummary({region:{id:'home',label:'내 지역'},networkAttempted:false,sources:[{key:'v',status:'error',sourceUrl:'https://example.org/?apiKey=PRIVATE_KEY',rows:[{key:'v',value:0,status:'error'}],privatePayload:'PRIVATE_BODY'}],sourceIssues:[{scope:'region',regionId:'foreign',name:'PRIVATE_NAME',month:'2026-09',period:{start:'2026-09-01',end:'2026-09-30'},code:'arbitrary',reason:'PRIVATE_ERROR'}]},'2026-09');
  assert.equal(value.sources[0].sourceUrl,null);assert.equal(value.sources[0].rows[0].value,null);assert.equal(value.sourceIssues[0].regionId,'home');assert.equal(value.sourceIssues[0].code,'REGION_SOURCE_UNAVAILABLE');assert.doesNotMatch(JSON.stringify(value),/PRIVATE_/);
});
test('a truncated issue list preserves its real twenty-four-month diagnostic period without expanding displayed series',async()=>{
  const s=service(catalog(),async()=>{
    const value=context();value.sources=value.sources.slice(0,1);
    for(const key of ['first','second'])value.sources.push({key,label:key,status:'error',rows:[],series:monthsEnding('2026-09',24).map(month=>({month,status:'error',rows:[]}))});
    return value;
  }),value=await s.summary(),summary=value.groups[0].summary,additional=summary.sourceIssues.find(row=>row.code==='REGION_ADDITIONAL_ISSUES');
  assert.equal(summary.sourceStatus,'partial');assert.equal(summary.sourceIssues.length,32);assert.equal(additional.month,'2026-09');
  assert.deepEqual(additional.period,{start:'2024-10-01',end:'2026-09-30'});assert.ok(summary.sources.every(source=>!source.series||source.series.length<=12));
  assert.ok(summary.sourceIssues.filter(row=>row.code!=='REGION_ADDITIONAL_ISSUES').every(row=>row.period.start.startsWith(row.month)&&row.period.end.startsWith(row.month)));
});
async function httpFixture(t,{gateRead=false,admin=false}={}) {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'insight-region-summary-')),store=createInsightStore({file:path.join(dir,'state.sqlite')}),data=catalog();
  const c=store.ensure({memberId:admin?'insight-admin:fixture_admin':'member',username:'fixture',role:'b2b',accountKind:admin?'admin_preview':'customer'});
  const command=(action,payload)=>({revision:store.get(c.customerId).revision,requestKey:crypto.randomUUID(),action,payload});
  for(const [kind,companyId] of [['own','own_a'],['competitor','cross']])store.update(c.customerId,command('add-company',{kind,companyId}),data);
  store.update(c.customerId,command('add-region',{regionKey:'interest'}),data);
  const token=admin?'test-admin-session':store.session(c.customerId),serviceToken=crypto.randomUUID(),reads=[],prepares=[],gate={};
  let release,entered;gate.promise=new Promise(done=>{release=done;});gate.entered=new Promise(done=>{entered=done;});let blocked=gateRead,memberEnabled=true,adminEnabled=true,catalogCalls=0;
  const analysis=createInsightAnalysis({catalog:async()=>clone(data),now:()=>Date.parse('2026-10-25T00:00:00Z'),readRegionContext:async input=>{reads.push(input);if(blocked){blocked=false;entered();await gate.promise;}return context();},regionPreparation:{start:async()=>{prepares.push('start');return null;},get:async()=>{prepares.push('get');return null;}}});
  const handlers=createInsightHttp({store,serviceToken,memberActive:async()=>memberEnabled,requireAdmin:()=>false,catalog:async()=>{catalogCalls++;return clone(data);},analysis,adminStore:admin?{authenticate(value){if(!adminEnabled||value!==token)throw fault('ADMIN_LOGIN_REQUIRED','관리자 로그인이 필요합니다.',401);return {adminId:'fixture_admin',username:'fixture'};}}:null});
  const server=http.createServer((req,res)=>handlers.internal(req,res,new URL(req.url,'http://local')));await new Promise(done=>server.listen(0,'127.0.0.1',done));
  t.after(async()=>{release();server.closeAllConnections();await new Promise(done=>server.close(done));store.close();assert.equal(path.dirname(path.resolve(dir)),path.resolve(os.tmpdir()));assert.ok(path.basename(dir).startsWith('insight-region-summary-'));await fs.rm(dir,{recursive:true,force:true});});
  const request=async(tail,{authorized=true,method='GET'}={})=>{const reply=await fetch(`http://127.0.0.1:${server.address().port}/api/insight/v1${admin?'/admin/customer-view':''}${tail}`,{method,headers:{Authorization:'Bearer '+serviceToken,...(authorized?{[admin?'X-Insight-Admin-Session':'X-Insight-Session']:token}:{})}});return {status:reply.status,data:await reply.json()};};
  return {store,data,customerId:c.customerId,request,command,reads,prepares,token,gate,release,disableMember(){memberEnabled=false;},disableAdmin(){adminEnabled=false;},get catalogCalls(){return catalogCalls;}};
}
test('fresh HTTP state supplies separate company bindings while full regions, interest quota and stored relations stay unchanged',async t=>{
  const f=await httpFixture(t),before=f.store.get(f.customerId),history=f.store.history(f.customerId),state=await f.request('/me');
  assert.equal(state.status,200);assert.deepEqual(state.data.regions.map(r=>r.id),['home','interest']);assert.deepEqual(state.data.comparisonRegionBindings.map(r=>r.companyId),['own_a','cross']);
  const reply=await f.request('/regions/comparison-summary?ownId=own_a&month=2026-09');assert.equal(reply.status,200);assert.deepEqual(f.reads.map(r=>r.targetId),['home','other','interest']);assert.equal(f.prepares.length,0);assert.deepEqual(f.store.get(f.customerId),before);assert.deepEqual(f.store.history(f.customerId),history);
  assert.equal((await f.request('/regions/other/analysis?month=2026-09')).status,404);assert.equal((await f.request('/regions/other/preparation?month=2026-09')).status,404);assert.equal(f.prepares.length,0);
});
test('summary GET is strict, authenticated, defaults to the last closed month, and does not accept arbitrary regions or prepare flags',async t=>{
  const f=await httpFixture(t);
  assert.equal((await f.request('/regions/comparison-summary',{authorized:false})).status,401);
  for(const query of ['?regionKey=other','?force=1','?refresh=1','?ownId=own_a&ownId=own_a','?month=2026-09&month=2026-09','?month=2026-10','?month=2026-13','?month=2026-09&companyIds=cross','?ownId=unregistered','?ownId=cross'])assert.ok([400,404].includes((await f.request('/regions/comparison-summary'+query)).status),query);
  assert.equal(f.reads.length,0);const reply=await f.request('/regions/comparison-summary');assert.equal(reply.status,200);assert.equal(reply.data.month,'2026-09');assert.equal(reply.data.ownId,null);assert.ok(reply.data.bindings.every(r=>r.kind==='competitor'));assert.ok(reply.data.groups.every(r=>r.relationToOwn==='unknown'));assert.equal(f.prepares.length,0);
});
for(const change of ['logout','competitor','own','interest','location','hierarchy','member','account'])test(`late ${change} changes revoke the completed summary before serialization`,async t=>{
  const f=await httpFixture(t,{gateRead:true});
  if(change==='hierarchy')f.data.companies.find(r=>r.companyId==='cross').regionKey='district_a';
  const pending=f.request('/regions/comparison-summary?ownId=own_a&month=2026-09');await f.gate.entered;
  if(change==='logout')f.store.logout(f.token);
  if(['competitor','own'].includes(change)){const rel=f.store.get(f.customerId).relations.find(r=>r.kind===(change==='own'?'own':'competitor'));f.store.update(f.customerId,f.command('archive-company',{relationId:rel.relationId}),f.data);}
  if(change==='interest'){const rel=f.store.get(f.customerId).regions[0];f.store.update(f.customerId,f.command('archive-region',{relationId:rel.relationId}),f.data);}
  if(change==='location')f.data.companies.find(r=>r.companyId==='cross').regionKey='home';
  if(change==='hierarchy')f.data.regionHierarchy.district_a='other';
  if(change==='member')f.disableMember();
  if(change==='account')f.store.adminUpdate(f.customerId,f.command('account-status',{status:'disabled',reason:'fixture'}),'fixture',f.data);
  f.release();const reply=await pending;assert.ok([401,403,404,409].includes(reply.status));assert.equal(reply.data.groups,undefined);assert.equal(reply.data.bindings,undefined);assert.equal(f.prepares.length,0);
});
test('administrator customer preview receives the same narrow summary and a revoked administrator cannot get a late result',async t=>{
  const f=await httpFixture(t,{admin:true,gateRead:true}),pending=f.request('/regions/comparison-summary?ownId=own_a&month=2026-09');await f.gate.entered;f.disableAdmin();f.release();const denied=await pending;assert.equal(denied.status,401);assert.equal(denied.data.groups,undefined);
});
