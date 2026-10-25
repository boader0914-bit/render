'use strict';
// Runs the actual customer UI and BFF against synthetic read-only responses.
// It never opens an external connection or uses real login/customer data.
const crypto=require('node:crypto');
const {createConnectedServer}=require('../../connected-server.cjs');
const {getScenario}=require('./fixtures.cjs');
const {projectReservationSeries,summarizeCompany}=require('../../../scripts/lib/insight_comparison.cjs');
function createReviewConnectedServer({port=58005}={}){
  if(process.env.RENDER||process.env.NODE_ENV==='production')throw Error('LOCAL_REVIEW_ONLY');
  const origin='http://127.0.0.1:'+port;
  function source(ownId='own-sc'){
    const f=getScenario({scenario:'mixed',ownId}),policy={mode:'current',asOf:f.today,period:f.comparisonSet.period};
    const companies=[f.own,...f.competitors].map(c=>({...c,...summarizeCompany(c,policy),kind:c.companyId===ownId?'own':'competitor',reservationSeries:projectReservationSeries(c,policy),days:undefined}));
    return {mode:'current_briefing',published:false,generatedAt:new Date().toISOString(),period:{...f.comparisonSet.period,days:30},ownId,companies,comparisons:f.comparisonSet.comparisons,regions:[],actions:[],definitions:[],dataQuality:{status:'complete',issues:[]}};
  }
  const f=getScenario({scenario:'mixed'}),companies=[f.own,...f.competitors].map(c=>({companyId:c.companyId,name:c.name,rooms:c.rooms,regionKey:c.regionKey,regionLabel:c.regionLabel,address:c.regionLabel,roomCountSource:'로컬 가상 검수값',version:1,dayUse:'unknown',facilities:'가상 자료'}));
  const state={customer:{customerId:'local_comparison_review',username:'가상자료 · 로컬 검수',projectName:'개발 검수용 가상 자료',accountKind:'test',revision:1,settings:{},regions:[],businessStatus:'owned',relations:companies.map((c,i)=>({companyId:c.companyId,relationId:'fixture_'+i,kind:i===0?'own':'competitor',status:'active'})),entitlements:{competitorLimit:3,interestRegionLimit:1}},companies,regions:[],corrections:[],preparations:[],features:{directCollection:false},companyViews:[],regionViews:[],reportViews:[],collectionAllowance:{limit:0,used:0,canRequest:false}};
  function detail(id){
    const raw=[f.own,...f.competitors].find(c=>c.companyId===id);if(!raw)return null;
    const month=f.today.slice(0,7),daily=raw.days.filter(d=>d.date.startsWith(month)),normal=daily.filter(d=>!d.missing),sum=key=>normal.reduce((total,d)=>total+(d[key]||0),0),summary={rangeStart:month+'-01',rangeEnd:month+'-31',observedDays:normal.length,calendarDays:31,sold:sum('sold'),supply:normal.length*raw.rooms,publicBookings:sum('publicBookings'),phoneBookings:sum('phoneBookings'),estimatedRevenue:normal.some(d=>d.revenuePartial)?null:sum('estimatedRevenue'),knownRevenueSubtotal:sum('estimatedRevenue'),publicRevenue:null,phoneRevenue:null,reservationRate:normal.length?sum('sold')/(normal.length*raw.rooms):null,missingDays:31-normal.length,quantityPartial:true};
    return {result:{companyId:id,rooms:raw.rooms,productCount:1,products:[{name:'로컬 검수용 예시 객실',productType:'lodging',days:[{status:'observed',price:190000},{status:'observed',price:290000}]}],quality:{status:'partial',reason:'가상 자료 · 일부 날짜 예시'},dayUse:{presence:'unknown'}},companyDetail:{companyId:id,source:'company_db',basics:{name:raw.name,address:raw.regionLabel,rooms:raw.rooms},channels:[],current:{daily,summary},integrated:{companyId:id,status:'ready',selectedMonth:month,months:[{month}],roomBasis:{count:raw.rooms,label:'가상 객실 기준',source:'db_review',reviewRequired:false},snapshot:{companyId:id,period:{start:month+'-01',end:month+'-31',cutoffDate:f.today},summary,daily,analysis:{collectionDateCount:2,pickup:{status:'ready',intervals:[{date:month+'-28',previousCollectedAt:month+'-23T03:00:00Z',collectedAt:month+'-25T03:00:00Z',previousLeadDays:5,currentLeadDays:3,publicChange:2,blockedChange:-1,netChange:1},{date:month+'-29',previousCollectedAt:month+'-23T03:00:00Z',collectedAt:month+'-25T03:00:00Z',previousLeadDays:6,currentLeadDays:4,publicChange:0,blockedChange:1,netChange:1}]}}}}},request:null,collectionAllowance:state.collectionAllowance};
  }
  const server=createConnectedServer({origin,backend:'https://local-fixture.invalid',serviceToken:crypto.randomBytes(32).toString('hex'),companyDiagnosticsLogger:()=>{},fetchImpl:async(url,options)=>{
    const u=new URL(url);let status=200,data;
    if((options.method||'GET')!=='GET'){status=405;data={error:{code:'LOCAL_READ_ONLY',message:'가상 검수 화면은 저장·수집을 실행하지 않습니다.'}};}
    else if(u.pathname==='/api/insight/v1/me')data=state;
    else if(u.pathname==='/api/insight/v1/config')data={signupEnabled:false};
    else if(u.pathname==='/api/insight/v1/reports/briefing')data=source(u.searchParams.get('ownId')||'own-sc');
    else if(/^\/api\/insight\/v1\/companies\/[^/]+\/collection$/.test(u.pathname)){data=detail(u.pathname.split('/')[5]);if(!data){status=404;data={error:{code:'NOT_FOUND',message:'가상 업체 자료가 없습니다.'}};}}
    else{status=404;data={error:{code:'LOCAL_ROUTE_NOT_FOUND',message:'가상 검수 범위 밖입니다.'}};}
    return {ok:status===200,status,headers:new Headers(),json:async()=>JSON.parse(JSON.stringify(data))};
  }});
  const original=server.listeners('request')[0];server.removeAllListeners('request');
  server.on('request',(req,res)=>{
    const end=res.end,writeHead=res.writeHead;let html=false;
    res.writeHead=function(status,headers,...args){html=String(headers?.['Content-Type']||res.getHeader('Content-Type')||'').includes('text/html');if(html&&headers){headers={...headers};delete headers['Content-Length'];}return writeHead.call(this,status,headers,...args);};
    res.end=function(chunk,...args){
      if(chunk&&html){
        chunk=Buffer.from(Buffer.from(chunk).toString('utf8').replace('<main id="main"','<aside class="admin-view-banner"><div><strong>개발 검수용 가상 자료 · 실제 고객 화면 코드</strong><p>수집·저장·운영 서버 연결 없이 화면을 검수합니다.</p></div></aside><main id="main"'));
      }
      return end.call(this,chunk,...args);
    };
    return original(req,res);
  });
  return server;
}
if(require.main===module){const port=Number(process.env.INSIGHT_COMPARISON_CONNECTED_REVIEW_PORT||58005);if(!Number.isInteger(port)||port<1024||port>65535)throw Error('INVALID_LOCAL_PORT');const server=createReviewConnectedServer({port});server.listen(port,'127.0.0.1',()=>console.log('실제 UI 코드 로컬 검수(가상 자료): http://127.0.0.1:'+port+'/#competitors'));for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>server.close(()=>process.exit(0)));}
module.exports={createReviewConnectedServer};
