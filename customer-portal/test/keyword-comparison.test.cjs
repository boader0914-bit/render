'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
const api=import(pathToFileURL(path.join(__dirname,'../analysis/keyword-comparison/compare.mjs')).href);
const clone=x=>JSON.parse(JSON.stringify(x));
function row(extra={}){return {runId:'current',companyId:'own',placeId:'35644668',date:'2026-09-22',supply:10,publicBookings:2,inferredBookings:1,sold:3,available:7,dayUseExcluded:0,quantityStatus:'valid',priceValues:[100000],productPrices:[{id:'room',name:'객실',price:100000}],productCount:1,productSignature:'room',capacityRevision:'basis-v1',sourceRefs:['saved:row'],reasons:[],...extra};}
function snapshot(){return {meta:{ownerPlaceId:'35644668',defaultRunId:'current',defaultPreviousRunId:'previous',defaultStart:'2026-09-22',defaultEnd:'2026-09-22',archiveDirectoryDate:'2026-10-22'},runs:[{id:'previous',observedAt:'2026-09-21T05:00:00Z',members:['own','peer'],start:'2026-09-21',end:'2026-10-21'},{id:'current',observedAt:'2026-09-22T05:00:00Z',members:['own','peer'],start:'2026-09-22',end:'2026-10-22'}],companies:[{id:'own',placeId:'35644668',name:'월명',capacity:{rooms:10,reviewed:true},ranks:{previous:1,current:1}},{id:'peer',placeId:'2',name:'비교업체',capacity:{rooms:10,reviewed:false},ranks:{previous:2,current:2}}],daily:[row({runId:'previous',publicBookings:4,inferredBookings:1,sold:5,available:5}),row({runId:'previous',companyId:'peer',placeId:'2',publicBookings:0,inferredBookings:0,sold:0,available:10}),row(),row({companyId:'peer',placeId:'2',publicBookings:0,inferredBookings:0,sold:0,available:10})],provenance:{}};}

test('weighted reservation rate uses summed bookings over supply and preserves public/inferred components',async()=>{
  const {aggregateRows}=await api;
  const result=aggregateRows([row({supply:1,publicBookings:1,inferredBookings:0,sold:1,available:0}),row({supply:9,publicBookings:0,inferredBookings:0,sold:0,available:9})],2);
  assert.equal(result.rate,0.1);assert.equal(result.supply,10);assert.equal(result.publicBookings,1);assert.equal(result.inferredBookings,0);assert.equal(result.publicRate+result.inferredRate,result.rate);
});
test('price median is calculated from all positive product-date prices rather than daily medians',async()=>{
  const {aggregateRows}=await api;
  const result=aggregateRows([row({priceValues:[10000,10000,10000],productCount:3}),row({priceValues:[200000],productCount:1})]);
  assert.equal(result.medianProductPrice,10000);assert.equal(result.priceCount,4);assert.equal(result.priceCoverage,1);
});
test('missing, zero and invalid price never become a free-room price and quantity remains independently valid',async()=>{
  const {aggregateRows}=await api;
  const result=aggregateRows([row({priceValues:[null,0,-1,NaN],productCount:4})]);
  assert.equal(result.medianProductPrice,null);assert.equal(result.priceCount,0);assert.equal(result.priceCoverage,0);assert.equal(result.rate,0.3);
});
test('confirmed zero bookings differ from legacy or missing quantity while known prices remain available',async()=>{
  const {aggregateRows}=await api;
  const zero=aggregateRows([row({publicBookings:0,inferredBookings:0,sold:0,available:10})]);
  assert.equal(zero.rate,0);assert.equal(zero.sold,0);
  for(const quantityStatus of ['legacy_unverified','missing']){const unknown=aggregateRows([row({quantityStatus})]);assert.equal(unknown.rate,null);assert.equal(unknown.sold,null);assert.equal(unknown.publicBookings,null);assert.equal(unknown.medianProductPrice,100000);}
});
test('negative or fractional booking quantities cannot enter a reservation rate',async()=>{
  const {aggregateRows}=await api;
  for(const invalid of [row({publicBookings:-1,inferredBookings:2,sold:1}),row({publicBookings:0.5,inferredBookings:0.5,sold:1})])assert.equal(aggregateRows([invalid]).rate,null);
});
test('negative reservation net changes remain negative and source data is not mutated',async()=>{
  const {computeComparison}=await api;const input=snapshot(),before=JSON.stringify(input);const result=computeComparison(input);
  assert.equal(result.owner.change.publicNetChange,-2);assert.equal(result.owner.change.inferredNetChange,0);assert.equal(result.owner.change.soldNetChange,-2);assert.equal(result.owner.change.comparableDays,1);assert.ok(Math.abs(result.owner.change.rateChangePp+20)<1e-10);assert.equal(JSON.stringify(input),before);assert.equal(result.quality.liveConnected,false);assert.equal(result.quality.collectionEnabled,false);
});
test('capacity or product-set changes hold booking deltas instead of turning them into new bookings',async()=>{
  const {computeComparison}=await api;
  for(const change of [{capacityRevision:'new-basis'},{productSignature:'different-room'}]){const input=snapshot();Object.assign(input.daily.find(r=>r.runId==='current'&&r.companyId==='own'),change);const result=computeComparison(input);assert.equal(result.owner.change.publicNetChange,null);assert.equal(result.owner.change.comparableDays,0);assert.equal(result.owner.change.excludedPairs,1);}
});
test('missing capacity revisions or product signatures do not establish comparable booking evidence',async()=>{
  const {computeComparison}=await api;
  for(const field of ['capacityRevision','productSignature']){const input=snapshot();for(const item of input.daily)delete item[field];const result=computeComparison(input);assert.equal(result.owner.change.publicNetChange,null);assert.equal(result.owner.change.comparableDays,0);}
});
test('absent previous rows do not make a zero change or fabricated rate',async()=>{
  const {computeComparison}=await api;const input=snapshot();input.daily=input.daily.filter(r=>r.runId==='current');const result=computeComparison(input);
  assert.equal(result.owner.change.publicNetChange,null);assert.equal(result.owner.change.rateChangePp,null);assert.equal(result.owner.change.comparableDays,0);
});
test('same or later comparison runs cannot masquerade as an earlier observation',async()=>{
  const {computeComparison}=await api;
  for(const options of [{runId:'previous',previousRunId:'current'},{runId:'current',previousRunId:'current'}]){const result=computeComparison(snapshot(),options);assert.equal(result.selection.previousRunId,null);assert.equal(result.owner.change.publicNetChange,null);assert.equal(result.selection.observationGapDays,null);}
});
test('a fixed cohort keeps missing members in expected coverage without imputing a zero rate',async()=>{
  const {computeComparison}=await api;const input=snapshot();input.daily=input.daily.filter(r=>r.companyId!=='peer');const result=computeComparison(input);
  assert.equal(result.benchmark.companyCount,2);assert.equal(result.benchmark.expectedDays,2);assert.equal(result.benchmark.coveredDays,1);assert.equal(result.benchmark.quantityCoverage,0.5);assert.equal(result.companies.find(c=>c.id==='peer').rate,null);assert.equal(result.quality.missingCompanyDays,1);
});
test('membership inclusion language agrees with an owner displayed outside the selected cohort',async()=>{
  const {computeComparison}=await api;const input=snapshot();input.runs[1].members=['peer'];const result=computeComparison(input);
  assert.equal(result.benchmark.includingOwner,false);assert.ok(result.cards[0].evidence.every(text=>!text.includes('월명 포함')));assert.equal(result.owner.id,'own');
});
test('date scope rejects impossible or reversed dates instead of rolling into another month',async()=>{
  const {datesBetween}=await api;assert.deepEqual(datesBetween('2026-02-31','2026-03-05'),[]);assert.deepEqual(datesBetween('2026-09-23','2026-09-22'),[]);assert.equal(datesBetween('2026-09-22','2026-10-20').length,29);
});

const actualFile=process.env.INSIGHT_KEYWORD_COMPARISON_SNAPSHOT;
test('saved archive scope and original-file integrity match the declared comparison', {skip:!actualFile},()=>{
  const fs=require('node:fs'),crypto=require('node:crypto');const input=JSON.parse(fs.readFileSync(actualFile,'utf8'));
  assert.equal(input.meta.keyword,'경남글램핑');assert.equal(input.meta.companyUnion,22);assert.equal(input.runs.length,3);assert.ok(input.runs.every(r=>r.members.length===20));
  assert.ok(input.provenance.capacityHistoricalRunIds.every(id=>id!=='gyeongnam_glamping_20260911_214313'));
  assert.equal(input.daily.length,1860);assert.equal(input.meta.liveConnected,false);assert.equal(input.meta.automaticCollection,false);
  const keys=input.daily.map(r=>[r.runId,r.companyId,r.date].join('|'));assert.equal(new Set(keys).size,keys.length);
  const sourceRoot=path.resolve(input.provenance.inputDirectory);
  for(const item of input.provenance.sourceFiles){const target=path.resolve(sourceRoot,item.path);assert.ok(target.startsWith(sourceRoot+path.sep));assert.equal(crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex'),item.sha256);}
});
test('saved Wolmyeong reference uses 16 rooms and agrees with independently summed public bookings', {skip:!actualFile},async()=>{
  const fs=require('node:fs');const {computeComparison}=await api;const input=JSON.parse(fs.readFileSync(actualFile,'utf8')),result=computeComparison(input);
  assert.equal(result.owner.placeId,'35644668');assert.equal(result.owner.capacity.rooms,16);assert.equal(result.owner.capacity.reviewed,true);assert.equal(result.owner.coveredDays,29);assert.equal(result.owner.supply,464);assert.equal(result.owner.publicBookings,113);assert.equal(result.owner.inferredBookings,26);assert.equal(result.owner.sold,139);assert.equal(result.owner.rate,139/464);assert.equal(result.owner.change.publicNetChange,5);assert.equal(result.owner.change.inferredNetChange,0);assert.equal(result.owner.change.comparableDays,29);assert.equal(result.owner.medianProductPrice,199000);
  const prior=computeComparison(input,{runId:input.runs[1].id});assert.equal(prior.owner.publicBookings,108);assert.equal(prior.owner.sold,134);
});
test('saved legacy quantity stays unknown while shared day-use exclusions retain their reuse policy', {skip:!actualFile},async()=>{
  const fs=require('node:fs');const {computeComparison}=await api;const input=JSON.parse(fs.readFileSync(actualFile,'utf8'));
  const legacy=computeComparison(input,{runId:input.runs[0].id});assert.equal(legacy.owner.rate,null);assert.equal(legacy.owner.publicBookings,null);assert.equal(legacy.owner.change.publicNetChange,null);assert.equal(legacy.benchmark.coveredDays,0);assert.equal(legacy.quality.legacyRows,580);
  const shared=input.daily.filter(r=>r.dayUseExcluded>0);assert.ok(shared.length>0);assert.ok(shared.every(r=>r.dayUseSharingPolicy==='lunch_dinner_room_reuse_v1'));
});
