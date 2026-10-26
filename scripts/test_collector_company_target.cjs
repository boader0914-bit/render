'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {normalizeTargetPlaceId,filterTargetPlaceRows,assertCompanyTargetPresent}=require('./collector_company_target.cjs');
const {validateJob}=require('./collector_worker.cjs');
const {scope,covers}=require('./collection_reuse.cjs');
const crawler=fs.readFileSync(path.join(__dirname,'gyeongnam_glamping_crawl.cjs'),'utf8');
test('target IDs are optional for legacy collection and strict company-only identifiers for new requests',()=>{
  assert.equal(normalizeTargetPlaceId(undefined,'keyword'),'');assert.equal(normalizeTargetPlaceId('','keyword'),'');assert.equal(normalizeTargetPlaceId('123','company'),'123');
  for(const [value,mode] of [['0123','company'],[123,'company'],['12/3','company'],['123','keyword'],['123',undefined],['9'.repeat(31),'company']])assert.throws(()=>normalizeTargetPlaceId(value,mode),{code:'COLLECTION_TARGET_INVALID'});
  const job={id:'safe-job',keyword:'동명 업체',leaseToken:'a'.repeat(30),leaseMs:1000,env:{SEARCH_MODE:'company',NAVER_TARGET_PLACE_ID:'123'}};
  validateJob(job);assert.throws(()=>validateJob({...job,env:{SEARCH_MODE:'keyword',NAVER_TARGET_PLACE_ID:'123'}}),{code:'COLLECTOR_JOB_INVALID'});
});
test('actual company search selects only the approved ID even when another identical name ranks first',async()=>{
  const fn=crawler.slice(crawler.indexOf('async function collectNaverMain()'),crawler.indexOf('async function collectNaverRegional()'));
  const rows=[{place_id:'456',업체명:'동명 업체',overall_rank:1},{place_id:'123',업체명:'이름이 변경된 업체',overall_rank:9}];
  const state={ROOT_QUERY:{'search':{business:{items:[{__ref:'a'},{__ref:'b'}],total:2}}},a:rows[0],b:rows[1]};
  const context={province:{isCompany:true},companySearchQueries:()=>['동명 업체'],RAW_KEYWORD:'동명 업체',NAVER_QUERY:'동명 업체',naverMainAttempts:[],getNaverState:async()=>({state,status:200,url:'https://example.invalid'}),pickNaverSearchKey:()=> 'search',pickNaverPlaceListKey:()=>'',pickNaverAdKey:()=>'',mapNaverItem:(_state,item)=>item,TARGET_PLACE_ID:'123',filterTargetPlaceRows,filterCompanyRows:()=>{throw Error('Name matching must not override a trusted target');},collectionFailure:()=>({})};
  vm.createContext(context);vm.runInContext(fn,context);const result=await context.collectNaverMain();assert.deepEqual(result.overall,[rows[1]]);assert.equal(result.overall[0].overall_rank,9,'preserve original search position');assert.equal(result.ads.length,0);
});
test('a missing target stops before any channel or reservation-detail calls',async()=>{
  const start=crawler.indexOf('async function main()'),end=crawler.indexOf('console.log(`Collection profile:',start);
  const prefix=crawler.slice(start,end)+'}';let calls=0;
  const context={fs:{mkdir:async()=>{}},OUTPUT_DIR:'unused',process:{env:{}},console:{log(){}},collectionPhase:'',TARGET_PLACE_ID:'123',assertCompanyTargetPresent,collectNaverMain:async()=>{calls++;return {status:200,overall:[{place_id:'456'}],ads:[]};}};
  vm.createContext(context);vm.runInContext(prefix,context);await assert.rejects(context.main(),{code:'COLLECTION_TARGET_PLACE_NOT_FOUND'});assert.equal(calls,1);
  assertCompanyTargetPresent({overall:[{place_id:'123'}]},'123');
});
test('same-name companies cannot reuse each other and untargeted legacy scope remains compatible',()=>{
  const base={keyword:'동명 업체',searchMode:'company',checkIn:'2026-10-26',checkOut:'2026-10-27',bookingRangeDays:30,detailRankRanges:'1-1'};
  assert.equal(covers(scope({...base,targetPlaceId:'123'}),scope({...base,targetPlaceId:'456'})),false);
  assert.equal(covers(scope(base),scope({...base,targetPlaceId:'123'})),false);
  const old=scope(base);delete old.targetPlaceId;assert.equal(covers(old,scope(base)),true);
});
