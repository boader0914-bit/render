'use strict';
// Local visual fixture only. No upstream requests, accounts or stored data.
const http=require('node:http'),fs=require('node:fs'),path=require('node:path');
function payload(companyId='own',month='2026-10'){
 const name=companyId==='own'?'내 매장 검수':'경쟁업체 검수';
 const daily=month==='2026-09'?[
  {date:'2026-09-04',publicBookings:1,publicRevenue:279000,phoneBookings:4,phoneRevenue:0,phoneMissingPriceBookings:4,estimatedRevenue:279000,revenuePartial:true,reservationRate:.5},
  {date:'2026-09-05',publicBookings:0,publicRevenue:0,phoneBookings:0,phoneRevenue:0,phoneMissingPriceBookings:0,estimatedRevenue:0,revenuePartial:false,reservationRate:0},
  {date:'2026-09-06',publicBookings:1,publicRevenue:120000,phoneBookings:3,phoneRevenue:80000,phoneMissingPriceBookings:2,estimatedRevenue:200000,revenuePartial:true,reservationRate:.4}
 ]:[{date:month+'-01',missing:true,publicBookings:0,phoneBookings:0,estimatedRevenue:0}];
 return {request:null,result:{companyId,version:month,products:[{name:'숙박 객실',productType:'lodging',days:[{status:'observed',price:279000}]}],productCount:1,quality:{status:'complete'}},companyDetail:{companyId,basics:{companyId,name,address:'로컬 검수용 예시 주소',rooms:10,roomCountSource:'검수 예시'},channels:[{label:'저장 예약채널',statusLabel:'로컬 예시'}],integrated:{companyId,status:'ready',selectedMonth:month,months:[{month:'2026-10',status:'missing'},{month:'2026-09',status:'partial'},{month:'2026-08',status:'missing'}],snapshot:month==='2026-09'?{}:null,roomBasis:{count:10,label:'검수 예시'}},current:{daily,summary:month==='2026-09'?{rangeStart:'2026-09-01',rangeEnd:'2026-09-30',revenuePartial:true,quantityPartial:true,missingDays:27}:null}}};
}
function html(){return `<!doctype html><html lang="ko" data-theme="light"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>통합관측 숙박월 로컬 검수</title><link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/connected.css"><body class="connected-app"><aside class="sidebar"><a class="brand" href="#"><span><strong>SABUN</strong><small>LOCAL PREVIEW</small></span></a><p>가상 자료만 표시합니다.</p></aside><div class="app-shell"><header class="topbar"><strong>숙박월·금액 표시 검수</strong><div class="connected-tools"><button class="button small" data-fixture-company="own">내 매장</button><button class="button small" data-fixture-company="competitor">경쟁업체</button><button class="button small" id="fixture-theme">화면 테마</button></div></header><main id="main"></main></div><script src="/company-flow.js"></script><script src="/company-view.js"></script><script src="/collection.js"></script><script>
 const makePayload=${payload.toString()};window.fixtureRequests=[];let activeCompany='own';
 window.InsightCollection.setContext('local-fixture',['own','competitor']);
 function request(route,body,options){window.fixtureRequests.push({route,body,options});const url=new URL(route,'https://fixture.invalid'),id=decodeURIComponent(url.pathname.split('/')[2]),month=url.searchParams.get('month')||'2026-10';return new Promise(resolve=>setTimeout(()=>resolve(makePayload(id,month)),250));}
 function show(id){activeCompany=id;window.InsightCollection.stop();const company=makePayload(id).companyDetail.basics;document.querySelector('#main').innerHTML=window.InsightCollection.panel(company,false,null,null);window.InsightCollection.mount(id,request,{company,relationKind:id==='own'?'own':'competitor'});}
 document.addEventListener('click',event=>{const id=event.target.dataset.fixtureCompany;if(id)show(id);if(event.target.id==='fixture-theme')document.documentElement.dataset.theme=document.documentElement.dataset.theme==='dark'?'light':'dark';if(event.target.dataset.action==='refresh-collection')window.InsightCollection.refresh();});show(activeCompany);
 </script></body></html>`;}
function createPreviewServer(){return http.createServer((req,res)=>{
 const pathname=new URL(req.url,'http://localhost').pathname;
 if(pathname==='/'){res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end(html());return;}
 if(!['/styles.css','/connected.css','/company-flow.js','/company-view.js','/collection.js'].includes(pathname)){res.writeHead(404);res.end();return;}
 const file=path.join(__dirname,'../../web',pathname.slice(1));res.writeHead(200,{'Content-Type':pathname.endsWith('.css')?'text/css; charset=utf-8':'text/javascript; charset=utf-8'});fs.createReadStream(file).pipe(res);
 });}
if(require.main===module){const server=createPreviewServer();server.listen(Number(process.env.INSIGHT_PREVIEW_PORT)||8129,'127.0.0.1',()=>process.stdout.write('Local fixture: http://127.0.0.1:'+server.address().port+'\n'));}
module.exports={payload,html,createPreviewServer};
