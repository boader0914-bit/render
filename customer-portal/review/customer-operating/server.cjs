'use strict';
// Local synthetic customer UI review. All upstream calls terminate in this fixture.
const crypto=require('node:crypto');
const {createConnectedServer}=require('../../connected-server.cjs');
const {getScenario}=require('../comparison/fixtures.cjs');
const {buildComparisonSet,projectReservationSeries,summarizeCompany}=require('../../../scripts/lib/insight_comparison.cjs');
const DAY=86400000;
function createCustomerOperatingReview({port=58021,scenario='mixed'}={}){
  if(process.env.RENDER||process.env.NODE_ENV==='production')throw Error('LOCAL_REVIEW_ONLY');
  const today=new Date(Date.now()+9*3600000).toISOString().slice(0,10);
  const source=getScenario({scenario});
  const offset=(Date.parse(today)-Date.parse(source.today))/DAY;
  const shift=value=>new Date(Date.parse(value)+offset*DAY).toISOString();
  const moved=company=>({...company,days:company.days.map(day=>({...day,date:shift(day.date+'T00:00:00Z').slice(0,10),collectedAt:shift(day.collectedAt)}))});
  const own=moved(source.own),competitors=source.competitors.map(moved);
  const period={start:today,end:new Date(Date.parse(today)+29*DAY).toISOString().slice(0,10),days:30};
  const policy={mode:'current',asOf:today,period,observationPolicy:{confirmed:true,maxSkewMs:2*60*60*1000}};
  const comparisons=buildComparisonSet(own,competitors,policy);
  const raw=[own,...competitors];
  const companies=raw.map((company,index)=>({companyId:company.companyId,name:company.name,rooms:company.rooms,roomCountSource:'가상 검수값',regionKey:company.regionKey,regionLabel:company.regionLabel,industryTags:company.industryTags,version:'synthetic-v1',dayUse:'unknown'}));
  const state={customer:{customerId:'fixture_customer_operating_'+scenario,username:'로컬 검수',accountStatus:'active',revision:1,settings:{},regions:[],businessStatus:'owned',relations:companies.map((company,index)=>({companyId:company.companyId,relationId:'fixture_'+index,kind:index===0?'own':'competitor',status:'active',comparisonPurpose:index===0?undefined:raw[index].comparisonPurpose})),entitlements:{competitorLimit:3,interestRegionLimit:1}},companies,regions:[],corrections:[],preparations:[],features:{directCollection:false},companyViews:[],regionViews:[],reportViews:[],collectionAllowance:{limit:0,used:0,canRequest:false}};
  const report={mode:'current_briefing',published:false,generatedAt:new Date().toISOString(),period,ownId:own.companyId,companies:raw.map((company,index)=>({...company,...summarizeCompany(company,policy),kind:index===0?'own':'competitor',reservationSeries:projectReservationSeries(company,policy),days:undefined})),comparisons:comparisons.comparisons,regions:[],actions:[],definitions:[],dataQuality:{status:'complete',issues:[]}};
  const calls=[];
  const server=createConnectedServer({origin:'http://127.0.0.1:'+port,backend:'https://local-fixture.invalid',serviceToken:crypto.randomBytes(32).toString('hex'),companyDiagnosticsLogger:()=>{},diagnosticsLogger:()=>{},fetchImpl:async(input,options={})=>{
    const url=new URL(input),method=options.method||'GET';calls.push({path:url.pathname,method});
    let status=200,data;
    if(method!=='GET'){status=405;data={error:{code:'LOCAL_READ_ONLY',message:'로컬 검수는 저장·수집을 하지 않습니다.'}};}
    else if(url.pathname==='/api/insight/v1/me')data=state;
    else if(url.pathname==='/api/insight/v1/config')data={signupEnabled:false};
    else if(url.pathname==='/api/insight/v1/reports/briefing'&&url.searchParams.get('ownId')===own.companyId)data=report;
    else if(/\/recurring-collection$/.test(url.pathname))data={recurringCollection:{status:'paused',nextRunAt:null}};
    else{status=404;data={error:{code:'LOCAL_ROUTE_NOT_FOUND',message:'가상 검수 범위 밖의 자료입니다.'}};}
    return {status,ok:status===200,headers:new Headers(),json:async()=>JSON.parse(JSON.stringify(data))};
  }});
  const original=server.listeners('request')[0];server.removeAllListeners('request');
  server.on('request',(req,res)=>{
    const end=res.end,writeHead=res.writeHead;let html=false;
    res.writeHead=function(status,headers,...args){html=String(headers?.['Content-Type']||res.getHeader('Content-Type')||'').includes('text/html');if(html&&headers){headers={...headers};delete headers['Content-Length'];}return writeHead.call(this,status,headers,...args);};
    res.end=function(chunk,...args){if(html&&chunk)chunk=Buffer.from(Buffer.from(chunk).toString('utf8').replace('<main id="main"','<aside class="admin-view-banner"><strong>개발 검수용 가상 자료 · 저장·수집·운영 서버 연결 없음</strong></aside><main id="main"'));return end.call(this,chunk,...args);};
    return original(req,res);
  });
  server.reviewCalls=calls;
  return server;
}
if(require.main===module){const port=Number(process.env.INSIGHT_CUSTOMER_OPERATING_REVIEW_PORT||58021);if(!Number.isInteger(port)||port<1024||port>65535)throw Error('INVALID_LOCAL_PORT');const server=createCustomerOperatingReview({port,scenario:process.argv[2]||'mixed'});server.listen(port,'127.0.0.1',()=>console.log('고객별 운영 제안 로컬 검수(가상 자료): http://127.0.0.1:'+port+'/#competitors'));}
module.exports={createCustomerOperatingReview};
