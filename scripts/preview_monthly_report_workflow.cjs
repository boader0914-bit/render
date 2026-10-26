'use strict';
// Explicit isolated UI/PDF demonstration. No application entry point, real
// DATA_DIR, credentials, collection, provider API or scheduler is loaded.
const fs=require('node:fs/promises'),path=require('node:path'),http=require('node:http'),os=require('node:os');
const {createPdfFixture}=require('./test_monthly_report_pdf.cjs');
const {renderMonthlyReportPdf}=require('./lib/monthly_report_pdf.cjs');
const {normalizeDataset,calculateCatchment}=require('./lib/regional_catchment.cjs');
const {listMonthlyReportActionEvidence,normalizeMonthlyReportActionPlan}=require('./lib/monthly_report_actions.cjs');
const {createMonthlyReportDelivery}=require('./lib/monthly_report_delivery.cjs');
async function main() {
  const output=process.argv[2];if(!output||!path.isAbsolute(output))throw Error('Use a new absolute output directory');
  await fs.mkdir(output);const root=path.resolve(__dirname,'..'),report=createPdfFixture();report.id='mr_10000000-0000-4000-8000-000000000001';report.schemaVersion=1;report.publishedAt=new Date(report.publishedAt).toISOString();
  report.snapshot.request.cutoffDate=report.snapshot.period.cutoffDate='2026-08-31';
  const center={latitude:36.5,longitude:127.8,label:'합성 검수 기준점',sourceUrl:'https://www.data.go.kr/',confirmed:true},metric=value=>({status:'observed_public',value});
  const dataset=normalizeDataset({id:'synthetic-grid-only',provider:'SGIS',sourceUrl:'https://sgis.mods.go.kr/view/pss/openDataIntrcn',sourceYear:2024,boundaryYear:2025,crs:'EPSG:4326',gridSizeM:1000,sourceSha256:'a'.repeat(64),boundarySha256:'b'.repeat(64),industryClassification:'TEST-KSIC-11:all',coverageBBox:[125,33,131,39],completeFrame:true,units:{population:'명',establishments:'개',workers:'명'},cells:[36.5,37.2].map((latitude,i)=>({id:'test-'+i,latitude,longitude:127.8,population:i?metric(123):{status:'protected_zero',value:0},establishments:metric(3+i),workers:metric(20+i)}))});
  const catchment={...await calculateCatchment({regionKey:'fixture_region',label:'합성 지역',center,dataset,now:()=>new Date('2026-10-25T01:00:00Z')}),resultId:'10000000-0000-4000-8000-000000000001'};
  report.snapshot.context.catchment={schemaVersion:1,reportMonth:'2026-08',cutoffDate:'2026-08-31',asOfAt:'2026-10-25T02:00:00Z',status:'partial',networkAttempted:false,warnings:[],entries:[{regionKey:'fixture_region',regionLabel:'합성 검수 지역',status:'partial',reasonLabel:'보호된 인구 격자가 있어 공개 부분합과 전체 미확정을 구분합니다.',snapshot:catchment}]};
  report.snapshot.actionEvidence=listMonthlyReportActionEvidence(report.snapshot);
  report.snapshot.actionPlan=normalizeMonthlyReportActionPlan({summary:'같은 관측 조건으로 주말 판매 구성을 점검하고 다음 발행본에서 결과를 검토합니다.',items:[{title:'주말 상품 구성과 가격 근거 확인',owner:'검수 운영자',dueDate:'2026-10-31',status:'planned',evidenceRefs:[report.snapshot.actionEvidence[0].id],outcome:'실행 전 · 모의 자료이며 성과를 뜻하지 않습니다.'}]},report.snapshot);
  report.snapshotHash=require('node:crypto').createHash('sha256').update(JSON.stringify(report.snapshot)).digest('hex');
  const customer={customerId:'cus_fixture',accountStatus:'active'},directory=await fs.mkdtemp(path.join(os.tmpdir(),'report-workflow-preview-'));
  const delivery=createMonthlyReportDelivery({dataDir:directory,reports:{get:async()=>structuredClone(report)},customers:{get:()=>customer}});
  await delivery.assign({customerId:customer.customerId,reportId:report.id,actorId:'fixture-admin',requestKey:'fixture-delivery-intent-0001'});
  const dto=await delivery.detail(customer.customerId,report.id,{verifyAccess:async()=>customer});
  await fs.writeFile(path.join(output,'monthly-workflow-demo.pdf'),await renderMonthlyReportPdf(report),{flag:'wx'});
  await fs.writeFile(path.join(output,'fixture.json'),JSON.stringify({report,customer:dto},null,2),{flag:'wx'});
  const assets={'/monthly.js':['web/monthly-reports.js','text/javascript'],'/monthly.css':['web/monthly-reports.css','text/css'],'/styles.css':['customer-portal/web/styles.css','text/css'],'/connected.css':['customer-portal/web/connected.css','text/css'],'/reports.js':['customer-portal/web/reports.js','text/javascript']};
  const html=mode=>`<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>격리 검수 · ${mode==='customer'?'고객 발행본':'관리자 월간 리포트'}</title><link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/connected.css"><link rel="stylesheet" href="/monthly.css"><style>body{padding:24px;background:#f4f6f3}main{max-width:1180px;margin:auto}.qa-banner{padding:16px;background:#fff3ce;border:1px solid #dfc979;margin-bottom:20px}h1{font-size:25px}</style><main><div class="qa-banner"><strong>격리 모의자료 · 운영 미반영</strong><br>운영 일정·원본·예약 이력과 연결하지 않은 개발 검수입니다.</div><h1>${mode==='customer'?'인사이트 · 받은 월간 발행본':'월간 리포트 · 분석 근거와 실행 계획'}</h1><div id="demo"></div></main><script src="/${mode==='customer'?'reports':'monthly'}.js"></script><script src="/fixture-view.js?mode=${mode}"></script></html>`;
  const js=`fetch('/fixture.json').then(r=>r.json()).then(v=>{const q=new URLSearchParams(location.search),customer=location.pathname==='/customer',node=document.querySelector('#demo');node.innerHTML=customer?InsightReports.detailView(v.customer,'/api/customer/v1'):MonthlyReports.renderSnapshot(v.report.snapshot);});`;
  const server=http.createServer(async(req,res)=>{try{const url=new URL(req.url,'http://127.0.0.1');let data,type='text/html; charset=utf-8';if(assets[url.pathname]){const [f,t]=assets[url.pathname];data=await fs.readFile(path.join(root,f));type=t;}else if(url.pathname==='/fixture.json'){data=await fs.readFile(path.join(output,'fixture.json'));type='application/json';}else if(url.pathname==='/fixture-view.js'){data=js;type='text/javascript';}else if(['/','/customer'].includes(url.pathname)){data=html(url.pathname==='/customer'?'customer':'admin');}else{res.writeHead(404);res.end();return;}res.writeHead(200,{'Content-Type':type,'Cache-Control':'no-store'});res.end(data);}catch{res.writeHead(500);res.end('Preview unavailable');}});
  server.listen(18793,'127.0.0.1',()=>console.log(JSON.stringify({origin:'http://127.0.0.1:18793',output,pdf:'monthly-workflow-demo.pdf'})));
}
if(require.main===module)main().catch(e=>{console.error(e);process.exitCode=1;});
