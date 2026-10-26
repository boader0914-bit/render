'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const projection=require('../comparison-projection.cjs');
const {evaluateComparison,buildComparisonSet,summarizeCompany}=require('../../scripts/lib/insight_comparison.cjs');
const {createReportReadCache}=require('../report-read-cache.cjs');
const AT=Date.parse('2026-10-25T00:00:00Z'),START='2026-10-25',END='2026-11-23',DAY=86400000;
const clone=v=>JSON.parse(JSON.stringify(v)),ok=data=>({ok:true,status:200,data});
function company(id,regionKey='r_one',{zero=false,missingPrice=false,quantityMissing=false}={}){
  return {companyId:id,name:id,rooms:10,regionKey,industryTags:['glamping'],relationStatus:'active',comparisonPurpose:'direct',
    days:Array.from({length:30},(_,index)=>({date:new Date(AT+index*DAY).toISOString().slice(0,10),total:10,sold:zero?0:2,publicBookings:zero?0:1,phoneBookings:zero?0:1,
      estimatedRevenue:missingPrice&&index===2?null:zero?0:200000,revenuePartial:missingPrice&&index===2,revenueUnknownRooms:missingPrice&&index===2?2:0,phoneMissingPriceBookings:missingPrice&&index===2?1:0,
      missing:quantityMissing&&index===4,collectedAt:'2026-10-25T00:00:00.000Z',rawError:'PRIVATE-DAY'}))};
}
const policy={mode:'current',asOf:START,period:{start:START,end:END},observationPolicy:{confirmed:true,maxSkewMs:7200000}};
function bundle(mode='same',options={}){
  const own=company('own_a','r_one',options),others=mode==='mixed'?[company('comp_b','r_one',options),company('comp_c','r_two',options)]:[company('comp_b',mode==='cross'?'r_two':'r_one',options)];
  const companies=[{...own,kind:'own'},...others.map(row=>({...row,kind:'competitor'}))];
  const account={customer:{customerId:'cust_a',revision:1,accountStatus:'active',relations:companies.map(row=>({companyId:row.companyId,kind:row.kind,status:'active'})),regions:[]},companies:companies.map(({companyId,name,rooms,regionKey})=>({companyId,name,rooms,regionKey})),regions:[],preparations:[],csrfToken:'PRIVATE-IDENTITY'};
  const set=buildComparisonSet(own,others,policy);
  const report={mode:'current_briefing',published:false,generatedAt:new Date(AT).toISOString(),ownId:'own_a',period:{start:START,end:END,days:30},
    companies:companies.map(row=>({...row,...summarizeCompany(row,policy),sourceStatus:'ready',sourceIssues:[],privateMemo:'PRIVATE-COMPANY'})),
    comparisons:set.comparisons,regions:[],actions:[],definitions:[],accessToken:'PRIVATE-ROOT'};
  return {own,others,account,report,set};
}
function cacheFixture(config={},data=bundle()){
  const cache=createReportReadCache({now:()=>AT,...config});
  const read=(extra={})=>cache.read({scope:'opaque-session',audience:'https://insight.example:customer',ownId:'own_a',readIdentity:async()=>ok(clone(data.account)),readSource:async()=>ok(clone(data.report)),...extra});
  return {cache,read,...data};
}
async function durable(t){
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'insight-comparison-projection-'));
  t.after(async()=>{const resolved=path.resolve(directory);assert.equal(path.dirname(resolved),path.resolve(os.tmpdir()));assert.ok(path.basename(resolved).startsWith('insight-comparison-projection-'));await fs.rm(resolved,{recursive:true,force:true});});
  return {persistenceDirectory:directory,namespace:'https://central.example',directory};
}
for(const mode of ['same','cross','mixed'])test(`new ${mode} comparison contract survives safe report projection and restart`,async t=>{
  const config=await durable(t),f=cacheFixture(config,bundle(mode)),first=await f.read();
  assert.equal(first.status,200);assert.deepEqual(first.data.comparisons,f.report.comparisons);
  assert.equal(first.data.comparisons[0].rulesVersion,'insight-comparison-v1');
  assert.deepEqual(first.data.companies[0].summaryQuality,f.report.companies[0].summaryQuality);
  assert.deepEqual(first.data.companies[0].summary,f.report.companies[0].summary);
  assert.equal(first.data.comparisons.filter(row=>row.regionRelation==='cross').every(row=>row.actionable===false),true);
  await f.cache.flushPersistence();
  const next=cacheFixture(config,bundle(mode)),views=await next.cache.snapshot({scope:'new-session',audience:'https://insight.example:customer',identity:clone(f.account)});
  assert.equal(views.length,1);assert.equal(views[0].data.responseCache.persisted,true);
  assert.deepEqual(views[0].data.comparisons,first.data.comparisons);
  const records=(await Promise.all((await fs.readdir(config.directory)).filter(name=>name.endsWith('.json')).map(name=>fs.readFile(path.join(config.directory,name),'utf8')))).join('');
  assert.doesNotMatch(records,/PRIVATE-|accessToken|csrfToken|privateMemo|rawError|"days":\[/);
});
test('normal zero and unknown revenue remain distinct across real cache persistence',async t=>{
  const config=await durable(t),zero=cacheFixture(config,bundle('same',{zero:true})),first=await zero.read();
  assert.equal(first.status,200);assert.equal(first.data.comparisons[0].own.sold,0);assert.equal(first.data.comparisons[0].own.estimatedRevenue,0);
  assert.equal(first.data.comparisons[0].own.knownRevenueSubtotal,0);assert.equal(first.data.comparisons[0].quality.revenue.status,'ready');
  await zero.cache.flushPersistence();
  const missing=cacheFixture({...config,namespace:'https://different-central.example'},bundle('same',{missingPrice:true})),partial=await missing.read();
  assert.equal(partial.status,200);const row=partial.data.comparisons[0];
  assert.equal(row.own.sold,60);assert.equal(row.own.estimatedRevenue,null);assert.equal(row.own.knownRevenueSubtotal,5800000);
  assert.deepEqual(row.own.revenueUnknownDays,['2026-10-27']);assert.equal(row.own.revenueUnknownRooms,2);assert.equal(row.own.knownMissingPhonePriceRooms,1);
  assert.equal(row.quality.quantity.comparable,true);assert.equal(row.quality.revenue.comparable,false);
  await missing.cache.flushPersistence();const next=cacheFixture({...config,namespace:'https://different-central.example'});
  const views=await next.cache.snapshot({scope:'another',audience:'https://insight.example:customer',identity:missing.account});
  assert.equal(views[0].data.comparisons[0].own.estimatedRevenue,null);assert.equal(views[0].data.comparisons[0].own.knownRevenueSubtotal,5800000);
});
test('quantity gaps retain exact excluded dates without persisting raw day records',async()=>{
  const f=cacheFixture({},bundle('same',{quantityMissing:true})),reply=await f.read();assert.equal(reply.status,200);
  const row=reply.data.comparisons[0];assert.equal(row.commonDays,29);assert.equal(row.quality.quantity.status,'partial');
  assert.deepEqual(row.quality.quantity.ownExcludedDates,[{date:'2026-10-29',codes:['QUANTITY_MISSING']}]);
  assert.equal(row.own.sold,58);assert.equal(reply.data.companies[0].days,undefined);
});
test('unexpected fields are stripped at every new comparison nesting level',()=>{
  const row=bundle().report.comparisons[0];row.token='PRIVATE-TOP';row.reasons.push({code:'REFERENCE_PURPOSE',scope:'action',reason:'Reference',cookie:'PRIVATE-REASON'});
  row.quality.quantity.headers='PRIVATE-QUALITY';row.basisDetail.observationTimes[0].session='PRIVATE-TIME';row.reference.own.products=[{secret:'PRIVATE-PRODUCT'}];row.own.privatePrice='PRIVATE-SUMMARY';
  const result=projection.projectComparison(row);assert.ok(result);assert.doesNotMatch(JSON.stringify(result),/PRIVATE-|token|cookie|headers|session|products|privatePrice/);
});
for(const [label,mutate] of [
  ['unknown rules version',r=>{r.rulesVersion='future-unknown';}],['missing quality',r=>{delete r.quality;}],['missing purpose',r=>{delete r.purpose;}],['malformed quantity status',r=>{r.quality.quantity.status='success';}],
  ['string boolean',r=>{r.displayable='true';}],['missing unknown amount',r=>{delete r.own.knownRevenueSubtotal;}],['fabricated actionable cross-region',r=>{r.regionRelation='cross';r.region.relation='cross';r.actionable=true;}],
  ['unconfirmed timing action',r=>{r.quality.timing.policy={confirmed:false,maxSkewMs:null};r.actionable=true;}],['missing actual times',r=>{r.basisDetail.observationTimes=[];}],
  ['dates beyond period',r=>{r.quality.revenue.unknownDates=['2026-12-01'];}],['malformed reason scope',r=>{r.reasons.push({code:'REFERENCE_PURPOSE',scope:'credential',reason:'bad'});}],
  ['negative unknown rooms',r=>{r.own.revenueUnknownRooms=-1;}],['invalid region relation',r=>{r.regionRelation='same';r.region.relation='cross';}],['duplicate common dates',r=>{r.dates[1]=r.dates[0];}]
])test(`new contract fails closed for ${label}`,async()=>{
  const f=cacheFixture();mutate(f.report.comparisons[0]);const result=await f.read();assert.equal(result.status,503);assert.equal(result.data.comparisons,undefined);
});
test('a partial new contract cannot silently fall back to legacy projection',async()=>{
  const f=cacheFixture();const source=f.report.comparisons[0];f.report.comparisons[0]={companyId:source.companyId,name:source.name,commonDays:source.commonDays,dates:source.dates,own:source.own,competitor:source.competitor,gapPp:source.gapPp,status:source.status,basis:source.basis,displayable:true};
  assert.equal((await f.read()).status,503);
});
test('new metadata cannot cross company, cutoff, period, account or region permissions',async t=>{
  for(const mutate of [r=>{r.comparisons[0].ownId='foreign';},r=>{r.comparisons[0].companyId='foreign';},r=>{r.comparisons[0].basisDetail.asOf='2026-10-24';},r=>{r.comparisons[0].basisDetail.period.end='2026-11-22';},r=>{r.companies[0].summaryQuality.asOf='2026-10-24';}]){
    const f=cacheFixture();mutate(f.report);assert.equal((await f.read()).status,503);
  }
  const config=await durable(t),f=cacheFixture(config);await f.read();await f.cache.flushPersistence();
  const next=cacheFixture(config),account=clone(f.account);account.customer.customerId='different';
  assert.deepEqual(await next.cache.snapshot({scope:'new',audience:'https://insight.example:customer',identity:account}),[]);
  account.customer.customerId='cust_a';account.customer.relations.pop();
  assert.deepEqual(await next.cache.snapshot({scope:'new',audience:'https://insight.example:customer',identity:account}),[]);
});
test('bad revalidation keeps the last normal source and original timestamp without promoting malformed new metadata',async()=>{
  let at=AT;const f=cacheFixture({now:()=>at}),first=await f.read();at+=30000;
  const broken=clone(f.report);delete broken.comparisons[0].quality.timing;
  const during=await f.read({readSource:async()=>ok(broken)});assert.equal(during.status,200);assert.equal(during.data.responseCache.refreshing,true);
  await new Promise(resolve=>setImmediate(resolve));const saved=await f.read();
  assert.equal(saved.data.responseCache.refreshFailed,true);assert.equal(saved.data.responseCache.checkedAt,first.data.responseCache.checkedAt);
  assert.deepEqual(saved.data.comparisons,first.data.comparisons);
});
test('legacy rows remain readable and their new optional summary values must still be well typed',async()=>{
  const f=cacheFixture();for(const row of f.report.comparisons){for(const key of ['rulesVersion','ownId','displayable','comparable','actionable','purpose','requestedPurpose','purposeExplicit','regionRelation','industryRelation','region','industry','reasons','quality','basisDetail','reference'])delete row[key];}
  assert.equal((await f.read()).status,200);
  const bad=cacheFixture();bad.report.companies[0].summary.knownRevenueSubtotal='not-a-number';assert.equal((await bad.read()).status,503);
});
test('room review requirements remain visible and cannot be mislabeled actionable',()=>{
  const data=bundle(),row=evaluateComparison({...data.own,capacityReviewRequired:true},data.others[0],policy),projected=projection.projectComparison(row);
  assert.ok(projected);assert.equal(projected.quality.quantity.capacityReviewRequired,true);assert.equal(projected.comparable,true);assert.equal(projected.actionable,false);
  row.actionable=true;assert.equal(projection.projectComparison(row),null);
});
test('known diagnostic codes persist only canonical text even when provider strings contain credentials',async t=>{
  const config=await durable(t),f=cacheFixture(config,bundle('cross'));
  f.report.comparisons[0].reasons.forEach(reason=>{reason.reason='PRIVATE-PROVIDER-TOKEN-and-stack';});
  const first=await f.read();assert.equal(first.status,200);
  const {REASONS}=require('../../scripts/lib/insight_comparison.cjs');
  for(const reason of first.data.comparisons[0].reasons)assert.equal(reason.reason,REASONS[reason.code]);
  await f.cache.flushPersistence();const records=(await Promise.all((await fs.readdir(config.directory)).filter(name=>name.endsWith('.json')).map(name=>fs.readFile(path.join(config.directory,name),'utf8')))).join('');
  assert.doesNotMatch(records,/PRIVATE-PROVIDER/);
});
test('six common days cannot retain comparable or actionable claims copied from a valid thirty-day contract',async()=>{
  const f=cacheFixture(),row=f.report.comparisons[0],six=row.dates.slice(0,6);
  row.commonDays=6;row.dates=six;row.own.days=6;row.competitor.days=6;row.quality.quantity.commonDays=6;
  row.basisDetail.observationTimes=row.basisDetail.observationTimes.slice(0,6);
  assert.equal(projection.projectComparison(row),null);assert.equal((await f.read()).status,503);
});
test('a quantity-only comparison cannot expose a numeric reservation-rate gap',async()=>{
  const f=cacheFixture(),row=f.report.comparisons[0];row.comparable=false;row.actionable=false;row.status='insufficient';
  row.quality.reservationRate={status:'partial',displayable:false,comparable:false,issues:[]};row.gapPp=0;
  assert.equal(projection.projectComparison(row),null);assert.equal((await f.read()).status,503);
});
test('comparison region keys must join the canonical report company rows',async()=>{
  const f=cacheFixture({},bundle('cross'));const row=f.report.comparisons[0];
  row.region.ownRegionKey='r_one';row.region.competitorRegionKey='r_one';row.region.ownAnalysisRegionKey='r_one';row.region.competitorAnalysisRegionKey='r_one';
  row.region.relation='same';row.regionRelation='same';
  assert.equal((await f.read()).status,503);
  const unknown=cacheFixture();unknown.report.comparisons[0].region.ownRegionKey=null;
  assert.equal((await unknown.read()).status,503);
});
test('industry action claims must match actual shared key sets and analysis-region relations',()=>{
  const row=bundle().report.comparisons[0];row.industry.competitorIndustryKeys=['camping'];row.industry.sharedIndustryKeys=[];
  assert.equal(projection.projectComparison(row),null);
  const region=bundle().report.comparisons[0];region.region.competitorAnalysisRegionKey='different';
  assert.equal(projection.projectComparison(region),null);
  const hierarchy=bundle().report.comparisons[0];hierarchy.region.hierarchyApplied=true;
  assert.equal(projection.projectComparison(hierarchy),null);
});
for(const [label,ownAt,otherAt] of [
  ['future observation','2026-10-26T00:00:00.000Z','2026-10-26T00:00:00.000Z'],
  ['different KST observation dates','2026-10-24T14:59:00.000Z','2026-10-24T15:01:00.000Z'],
  ['stale current observation','2026-10-01T00:00:00.000Z','2026-10-01T00:00:00.000Z']
])test(`canonical timing cannot claim comparability for ${label}`,()=>{
  const row=bundle().report.comparisons[0],at=row.basisDetail.observationTimes[0];
  at.ownObservedAt=ownAt;at.competitorObservedAt=otherAt;at.skewMs=Math.abs(Date.parse(ownAt)-Date.parse(otherAt));row.quality.timing.maximumObservedSkewMs=at.skewMs;
  assert.equal(projection.projectComparison(row),null);
});
const competitiveAction=key=>({key,title:'Provider comparative conclusion',reason:'Provider comparison reason',next:'Provider next step',check:'Provider check',source:'Provider source'});
test('legacy comparative actions become explicit reference guidance while normal quantities and clocks remain unchanged',async()=>{
  const f=cacheFixture();const original=clone(f.report.comparisons[0]);
  f.report.comparisons=f.report.comparisons.map(row=>Object.fromEntries(['companyId','name','commonDays','dates','own','competitor','gapPp','status','basis'].map(key=>[key,row[key]])));
  f.report.actions=[competitiveAction('compare'),competitiveAction('track'),{key:'coverage',title:'Coverage',reason:'Saved observation gaps'}];
  const result=await f.read();assert.equal(result.status,200);
  assert.deepEqual(result.data.comparisons[0].own,original.own);assert.equal(result.data.generatedAt,f.report.generatedAt);
  assert.deepEqual(result.data.actions.map(row=>row.key),['comparison_review','coverage']);
  assert.match(result.data.actions[0].reason,/이전 비교 기준의 참고자료/);assert.doesNotMatch(JSON.stringify(result.data.actions),/Provider comparative conclusion|Provider comparison reason/);
});
test('v1 non-actionable cross-region comparisons cannot retain contaminated compare or track advice',async()=>{
  const f=cacheFixture({},bundle('cross'));f.report.actions=[competitiveAction('compare'),competitiveAction('track')];
  const result=await f.read();assert.equal(result.status,200);assert.deepEqual(result.data.actions.map(row=>row.key),['comparison_review']);
  assert.equal(result.data.comparisons[0].actionable,false);assert.doesNotMatch(JSON.stringify(result.data.actions),/Provider comparative conclusion/);
});
test('comparative action predicates require an actionable negative gap for compare and no negative eligible gap for track',()=>{
  const row=projection.projectComparison(bundle().report.comparisons[0]);assert.equal(row.actionable,true);
  const actions=[competitiveAction('compare'),competitiveAction('track')];
  assert.deepEqual(projection.projectCompetitiveActions(actions,[{...row,gapPp:0}]).map(row=>row.key),['comparison_review','track']);
  assert.deepEqual(projection.projectCompetitiveActions(actions,[{...row,gapPp:-1}]).map(row=>row.key),['compare','comparison_review']);
  assert.deepEqual(projection.projectCompetitiveActions(actions,[{...row,gapPp:-1,actionable:false}]).map(row=>row.key),['comparison_review']);
  const alreadyReview={key:'comparison_review',title:'Existing review'};
  assert.deepEqual(projection.projectCompetitiveActions([...actions,alreadyReview],[]),[alreadyReview]);
});
test('stored legacy competitive advice is revalidated on hydrate without changing snapshot namespace or source time',async t=>{
  const config=await durable(t),f=cacheFixture(config);f.report.comparisons=f.report.comparisons.map(row=>Object.fromEntries(['companyId','name','commonDays','dates','own','competitor','gapPp','status','basis'].map(key=>[key,row[key]])));
  f.report.actions=[competitiveAction('track')];const first=await f.read();await f.cache.flushPersistence();
  // A genuine pre-upgrade cache can contain advice created under the old
  // rules. Reproduce that valid old envelope rather than testing a snapshot
  // already sanitized by the new source projection.
  const filename=(await fs.readdir(config.directory)).find(name=>name.endsWith('.json')),file=path.join(config.directory,filename),envelope=JSON.parse(await fs.readFile(file,'utf8'));
  envelope.core.actions=[competitiveAction('track')];delete envelope.checksum;
  const stable=value=>value&&typeof value==='object'?Array.isArray(value)?value.map(stable):Object.fromEntries(Object.keys(value).sort().map(key=>[key,stable(value[key])])):value;
  envelope.checksum=require('node:crypto').createHash('sha256').update(JSON.stringify(stable(envelope))).digest('hex');await fs.writeFile(file,JSON.stringify(envelope));
  const next=cacheFixture(config),views=await next.cache.snapshot({scope:'new-session',audience:'https://insight.example:customer',identity:f.account});
  assert.equal(views.length,1);assert.deepEqual(views[0].data.actions,first.data.actions);assert.equal(views[0].data.actions[0].key,'comparison_review');
  assert.equal(views[0].data.generatedAt,first.data.generatedAt);assert.equal(views[0].data.responseCache.checkedAt,first.data.responseCache.checkedAt);
});
test('empty or malformed canonical region keys remain unknown without rejecting valid quantities',async()=>{
  for(const [side,regionKey] of [['own',''],['competitor',''],['own',' r_one'],['competitor',null]]){
    const data=bundle(),index=side==='own'?0:1;
    data.account.companies[index].regionKey=regionKey;data.report.companies[index].regionKey=regionKey;
    const own=side==='own'?{...data.own,regionKey}:data.own,other=side==='competitor'?{...data.others[0],regionKey}:data.others[0];
    data.report.comparisons=[evaluateComparison(own,other,policy)];
    const result=await cacheFixture({},data).read();assert.equal(result.status,200);assert.equal(result.data.comparisons[0].regionRelation,'unknown');
    assert.equal(result.data.comparisons[0].actionable,false);assert.equal(result.data.comparisons[0].own.sold,60);
  }
});
test('official region labels and safe room-count source labels survive durable projection without private fields',async t=>{
  const config=await durable(t),f=cacheFixture(config);
  f.report.companies[0].regionLabel='경남 산청군';f.report.companies[0].roomCountSource='DB 검수값';f.report.companies[0].privateRoomEvidence='PRIVATE-ROOM-EVIDENCE';
  f.report.companies[1].regionLabel=null;f.report.companies[1].roomCountSource=null;
  const result=await f.read();assert.equal(result.status,200);assert.equal(result.data.companies[0].regionLabel,'경남 산청군');assert.equal(result.data.companies[0].roomCountSource,'DB 검수값');assert.equal(result.data.companies[1].regionLabel,null);
  await f.cache.flushPersistence();const next=cacheFixture(config),views=await next.cache.snapshot({scope:'new',audience:'https://insight.example:customer',identity:f.account});
  assert.equal(views[0].data.companies[0].roomCountSource,'DB 검수값');assert.doesNotMatch(JSON.stringify(views),/PRIVATE-ROOM-EVIDENCE/);
  const bad=cacheFixture();bad.report.companies[0].regionLabel={token:'bad'};assert.equal((await bad.read()).status,503);
});
