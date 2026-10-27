'use strict';
// Local review of an explicitly supplied, already-projected saved-source copy.
// There is no network adapter, collector, scheduler, write path or disk cache.
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {createConnectedServer}=require('../../connected-server.cjs');
const {createInsightAnalysis,readableRegionIds}=require('../../../scripts/lib/insight_analysis.cjs');
const {comparisonRegionBindings}=require('../../../scripts/lib/insight_region_summary.cjs');
const clone=value=>JSON.parse(JSON.stringify(value));
const error=(code,message,status=400)=>Object.assign(Error(message),{code,statusCode:status});
const usableId=value=>typeof value==='string'&&/^[a-zA-Z0-9_-]{1,180}$/.test(value);
const month=value=>typeof value==='string'&&/^20\d{2}-(0[1-9]|1[0-2])$/.test(value);

function loadSource(sourceFile){
  if(!sourceFile||!path.isAbsolute(sourceFile))throw error('SOURCE_FILE_REQUIRED','검수할 저장 자료 사본의 절대 경로가 필요합니다.');
  const stat=fs.statSync(sourceFile);
  if(!stat.isFile()||stat.size>64*1024*1024)throw error('SOURCE_FILE_INVALID','저장 자료 사본의 파일 형식 또는 크기를 확인하세요.');
  const source=JSON.parse(fs.readFileSync(sourceFile,'utf8'));
  if(source?.source!=='datalab_saved_integrated'||!Number.isFinite(Date.parse(source.capturedAt))||!Array.isArray(source.companies)||!Array.isArray(source.relations)||!Array.isArray(source.records))throw error('SOURCE_FILE_INVALID','데이터랩 저장 통합자료 사본이 필요합니다.');
  const ids=new Set();
  for(const company of source.companies){if(!usableId(company?.companyId)||ids.has(company.companyId))throw error('SOURCE_COMPANY_INVALID','업체 번호가 유효하고 중복되지 않아야 합니다.');ids.add(company.companyId);}
  if(!source.relations.some(row=>row.kind==='own'&&['active','pending'].includes(row.status)))throw error('SOURCE_OWN_REQUIRED','등록된 내 매장 연결이 필요합니다.');
  for(const relation of source.relations)if(!ids.has(relation?.companyId)||!['own','competitor'].includes(relation.kind)||!['active','pending'].includes(relation.status))throw error('SOURCE_RELATION_INVALID','저장된 업체 연결 범위를 확인하세요.');
  const seen=new Set();
  for(const record of source.records){const key=JSON.stringify([record?.companyId,record?.month]);if(!ids.has(record?.companyId)||!month(record.month)||seen.has(key)||record.integrated?.companyId!==record.companyId||record.integrated?.selectedMonth!==record.month)throw error('SOURCE_RECORD_INVALID','업체·숙박월별 저장 자료의 대상을 확인하세요.');seen.add(key);}
  return source;
}

function createSavedReadinessServer({sourceFile,port=58027}={}){
  if(process.env.RENDER||process.env.NODE_ENV==='production')throw error('LOCAL_REVIEW_ONLY','운영 환경에서 검수 서버를 실행할 수 없습니다.');
  if(!Number.isInteger(port)||port<1024||port>65535)throw error('INVALID_LOCAL_PORT','로컬 검수 포트를 확인하세요.');
  const source=loadSource(sourceFile),capturedAt=Date.parse(source.capturedAt),capturedDay=new Date(capturedAt+9*3600000).toISOString().slice(0,10),origin='http://127.0.0.1:'+port;
  const companies=clone(source.companies),relations=clone(source.relations).map((row,index)=>({...row,relationId:'local_saved_relation_'+index}));
  const regionMap=new Map(companies.filter(row=>usableId(row.regionKey)).map(row=>[row.regionKey,{id:row.regionKey,label:row.regionLabel||row.regionKey,level:'local'}]));
  const catalog={companies,regions:[...regionMap.values()],regionHierarchy:{}};
  const allowance={limit:0,used:0,canRequest:false};
  const state={customer:{customerId:'local_saved_source_review',username:'로컬저장자료검수',projectName:'저장 자료 검수',accountKind:'test',accountStatus:'active',revision:1,settings:{},regions:[],businessStatus:'owned',relations,entitlements:{competitorLimit:relations.filter(row=>row.kind==='competitor').length,interestRegionLimit:0}},companies,regions:[],corrections:[],preparations:[],features:{directCollection:false},companyViews:[],regionViews:[],reportViews:[],collectionAllowance:allowance,view:{readOnly:true,mode:'local_saved_review'}};
  state.regions=catalog.regions.filter(row=>readableRegionIds(state.customer,catalog).has(row.id));
  state.comparisonRegionBindings=comparisonRegionBindings(state.customer,catalog);
  const recordMap=new Map(source.records.map(row=>[JSON.stringify([row.companyId,row.month]),row.integrated]));
  const companyMonths=async id=>source.records.filter(row=>row.companyId===id).map(row=>row.month).sort();
  async function companyDetail(id,{month:selectedMonth}={}){
    if(!companies.some(company=>company.companyId===id))throw error('NOT_FOUND','등록한 업체의 저장 자료가 없습니다.',404);
    const months=await companyMonths(id),resolved=selectedMonth||months.at(-1),integrated=recordMap.get(JSON.stringify([id,resolved]));
    if(!integrated)throw error('month_not_observed','해당 숙박월의 저장 자료가 없습니다.',404);
    const company=companies.find(row=>row.companyId===id),copy=clone(integrated);
    return {companyId:id,source:'company_db',basics:{companyId:id,name:company.name,address:company.address||company.regionLabel||'',rooms:company.rooms,roomCountSource:company.roomCountSource},channels:[],integrated:copy,current:{daily:copy.snapshot?.daily||[],summary:copy.snapshot?.summary||null}};
  }
  const reader={companyMonths,companyDetail};
  const regionContext=async({month})=>({networkAttempted:false,warnings:['로컬 저장 자료 사본에는 지역 지표가 포함되어 있지 않습니다.'],sources:[{key:'saved_review_region_unavailable',label:'지역 지표',provider:'저장 자료 사본',status:'unavailable',period:month,rows:[]}]});
  const analysis=createInsightAnalysis({catalog:async()=>clone(catalog),collectionResults:reader,savedCollectionResults:reader,readRegionContext:regionContext,now:()=>capturedAt});
  const safeResponse=(status,data)=>({ok:status>=200&&status<300,status,headers:new Headers(),json:async()=>clone(data)});
  const localBackend='https://local-saved-review.invalid';
  const fetchImpl=async(url,options={})=>{
    const u=new URL(url);
    if(u.origin!==localBackend)return safeResponse(403,{error:{code:'EXTERNAL_CONNECTION_FORBIDDEN',message:'외부 연결은 허용되지 않습니다.'}});
    if((options.method||'GET')!=='GET')return safeResponse(405,{error:{code:'LOCAL_READ_ONLY',message:'저장 자료 검수 화면은 수집·예약·저장을 변경할 수 없습니다.'}});
    try{
      let data;
      if(u.pathname==='/api/insight/v1/me')data=state;
      else if(u.pathname==='/api/insight/v1/config')data={signupEnabled:false};
      else if(u.pathname==='/api/insight/v1/reports/briefing'){
        const selection=Object.fromEntries(['stayMode','month','start','end'].filter(key=>u.searchParams.has(key)).map(key=>[key,u.searchParams.get(key)]));
        data=await analysis.briefing(state.customer,u.searchParams.get('ownId')||undefined,selection);
      }else if(u.pathname==='/api/insight/v1/regions/comparison-summary'){
        const selection=analysis.comparisonRegionSelection(state.customer,u.searchParams.get('ownId')||undefined,u.searchParams.get('month')||undefined,catalog);
        data=await analysis.comparisonRegionSummary(selection,catalog);
      }else if(/^\/api\/insight\/v1\/companies\/[a-zA-Z0-9_-]+\/collection$/.test(u.pathname)){
        const id=u.pathname.split('/')[5],detail=await companyDetail(id,{month:u.searchParams.get('month')||undefined});
        data={result:null,companyDetail:detail,request:null,collectionAllowance:allowance};
      }else if(/^\/api\/insight\/v1\/regions\/[a-zA-Z0-9_-]+\/analysis$/.test(u.pathname))data=await analysis.region(state.customer,u.pathname.split('/')[5],u.searchParams.get('month')||undefined);
      else if(/^\/api\/insight\/v1\/companies\/[a-zA-Z0-9_-]+\/recurring-collection$/.test(u.pathname))data={request:null,subscription:null,lastCollectedDay:null,nextRunAt:null};
      else return safeResponse(404,{error:{code:'LOCAL_ROUTE_NOT_FOUND',message:'저장 자료 검수 범위 밖의 기능입니다.'}});
      return safeResponse(200,data);
    }catch(err){return safeResponse(err.statusCode||400,{error:{code:err.code||'LOCAL_SOURCE_UNAVAILABLE',message:err.statusCode?err.message:'저장 자료를 확인하지 못했습니다.'}});}
  };
  const server=createConnectedServer({origin,backend:localBackend,serviceToken:crypto.randomBytes(32).toString('hex'),fetchImpl,companyDiagnosticsLogger:()=>{}});
  const original=server.listeners('request')[0];server.removeAllListeners('request');
  server.on('request',(req,res)=>{
    if(!['GET','HEAD'].includes(req.method)){res.writeHead(405,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','Allow':'GET, HEAD'});res.end(JSON.stringify({error:{code:'LOCAL_READ_ONLY',message:'로컬 저장 자료 검수는 수집·예약·저장을 변경할 수 없습니다.'}}));return;}
    const end=res.end,writeHead=res.writeHead;let html=false;
    res.writeHead=function(status,headers,...args){html=String(headers?.['Content-Type']||res.getHeader('Content-Type')||'').includes('text/html');if(html&&headers){headers={...headers};for(const key of Object.keys(headers))if(key.toLowerCase()==='content-length')delete headers[key];}return writeHead.call(this,status,headers,...args);};
    res.end=function(chunk,...args){if(chunk&&html){chunk=Buffer.from(Buffer.from(chunk).toString('utf8').replace('<main id="main"',`<aside class="admin-view-banner"><div><strong>로컬 검수 · ${capturedDay} 저장 자료 사본 · 수집·예약 변경 불가</strong><p>월명글램핑과 등록 경쟁업체의 실제 저장 자료입니다. 운영 서버 연결·신규 수집 없이 확인합니다.</p></div></aside><main id="main"`));}return end.call(this,chunk,...args);};
    return original(req,res);
  });
  const listen=server.listen.bind(server);
  server.listen=function(...args){const first=args[0],host=typeof first==='object'?first?.host:typeof args[1]==='string'?args[1]:'127.0.0.1',callback=args.find(value=>typeof value==='function');if(host&&host!=='127.0.0.1')throw error('LOCAL_BIND_REQUIRED','127.0.0.1에서만 실행할 수 있습니다.');if(typeof first==='object')return listen({...first,host:'127.0.0.1'},callback);return listen(first||port,'127.0.0.1',callback);};
  return server;
}
if(require.main===module){const args=process.argv.slice(2),sourceFile=args[0],port=args[1]===undefined?58027:Number(args[1]);if(args.length>2)throw error('INVALID_ARGUMENTS','저장 자료 사본 경로와 선택 포트만 지정하세요.');const server=createSavedReadinessServer({sourceFile,port});server.listen(port,()=>console.log('저장 자료 로컬 검수: http://127.0.0.1:'+port+'/#competitors'));for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>server.close(()=>process.exit(0)));}
module.exports={createSavedReadinessServer};
