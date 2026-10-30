'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),http=require('node:http'),crypto=require('node:crypto');
const {createConnectedServer,configuration}=require('../connected-server.cjs');
const {VERSION}=require('../lib/public-booking-pickup.cjs');
const ORIGIN='https://insight-public-pickup.test',BACKEND='https://central-public-pickup.test';
const PIKA='cmp_place_1460523479',ANDER='cmp_place_2092754761',SANGAWON='cmp_place_1421792055';
const previous='2026-10-27T04:20:05.714Z',current='2026-10-28T06:03:04.516Z';
function ledger(companyId=PIKA){
  const placeId=companyId.slice('cmp_place_'.length),products=[{bizItemId:'room_one',productType:'lodging',listType:'객실 종류별 리스트',availabilityUnit:'재고수량'}];
  return {version:VERSION,companyId,placeId,sources:[['previous',previous,1],['current',current,3]].map(([runId,collectedAt,bookingCount])=>({runId:companyId+'_'+runId,collectedAt,sourceDigest:crypto.createHash('sha256').update(companyId+runId).digest('hex'),products,
    rows:['2026-10-30','2026-10-31'].map(date=>({companyId,placeId,runId:companyId+'_'+runId,collectedAt,...products[0],date,stock:10,bookingCount:date==='2026-10-30'?bookingCount:0,responseStatus:200,collectionFailed:false,errorCode:null,stockObserved:true,inventoryObserved:true,inventoryConflict:false,salesEvidence:'bookingCount'}))}))};
}
function source(companyId,month){
  const date=month+'-01';
  const daily={date,missing:true,total:null,sold:null,publicBookings:null,phoneBookings:null,estimatedRevenue:null,missingReason:'shared_dayuse_unverified'};
  return {result:{companyId,runId:companyId+'_current',collectedAt:current,rooms:null,roomCountSource:'unknown',quality:{status:'partial'},dayUse:{presence:'present',sharing:'unknown'},products:[]},
    companyDetail:{companyId,basics:{companyId,name:'공개예약 검수 업체',rooms:null},current:{summary:{sold:null,publicBookings:null,phoneBookings:null,quantityPartial:true},daily:[daily]},
      integrated:{companyId,status:'ready',selectedMonth:month,calculationVersion:'company-integrated-v4-product-max-room-reuse',roomBasis:{count:38,source:'unknown',reviewRequired:true},snapshot:{period:{start:month+'-01',end:month+'-31',days:31,cutoffDate:'2026-10-30'},daily:[daily],analysis:{pickup:{status:'insufficient',comparableIntervals:0,intervals:[]}}}}}};
}
async function fixture(t,{persistent=true}={}){
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'insight-public-pickup-http-'));
  const state={allowed:[PIKA,ANDER,SANGAWON],identityStatus:200,sourceStatus:200,sourceCompanyOverride:null},calls=[];
  const identity=()=>({customer:{customerId:'cus_public-pickup',accountStatus:'active',revision:1,relations:state.allowed.map(companyId=>({companyId,kind:companyId===PIKA?'own':'competitor',status:'active'}))},companies:state.allowed.map(companyId=>({companyId,name:'검수 업체'})),csrfToken:'fixture-csrf'});
  const fetchImpl=async(url,options)=>{
    const parsed=new URL(url),headers=new Headers(options.headers),authenticated=headers.get('X-Insight-Session')||headers.get('X-Insight-Admin-Session');
    calls.push({path:parsed.pathname,query:parsed.search,method:options.method});
    const match=/\/companies\/([^/]+)\/collection$/.exec(parsed.pathname),status=!authenticated?401:match?state.sourceStatus:state.identityStatus;
    return {status,ok:status===200,headers:new Headers(),json:async()=>status===200?(match?source(state.sourceCompanyOverride||match[1],parsed.searchParams.get('month')||'2026-10'):identity()):{error:{code:'FIXTURE_'+status,message:'fixture'}}};
  };
  const server=createConnectedServer({origin:ORIGIN,backend:BACKEND,serviceToken:'fixture-service-token-32-characters-long',fetchImpl,...(persistent?{publicBookingDirectory:path.join(directory,'private-ledgers')}:{ }),companyDiagnosticsLogger:()=>{},diagnosticsLogger:()=>{}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const request=(route,{cookie=true,admin=false,customerId}={})=>new Promise((resolve,reject)=>{
    const req=http.request({hostname:'127.0.0.1',port:server.address().port,path:route,method:'GET',headers:{Host:new URL(ORIGIN).host,...(cookie?{Cookie:admin?'__Host-sabun_insight_admin=fixture-admin-session':'__Host-sabun_insight_session=fixture-session'}:{}),...(customerId?{'X-Insight-Customer-Id':customerId}:{})}},res=>{const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>{const text=Buffer.concat(chunks).toString('utf8');let data;try{data=JSON.parse(text);}catch{data=null;}resolve({status:res.statusCode,data,text});});});req.on('error',reject);req.end();
  });
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));const target=path.resolve(directory);assert.equal(path.dirname(target),path.resolve(os.tmpdir()));assert.ok(path.basename(target).startsWith('insight-public-pickup-http-'));await fs.rm(target,{recursive:true,force:true});});
  return {server,state,calls,directory,request,route:(companyId=PIKA)=>'/api/customer/v1/companies/'+companyId+'/collection?month=2026-10'};
}
test('Render public evidence has its own dedicated private persistent directory',()=>{
  const config=configuration({RENDER:'true',INSIGHT_SERVICE_TOKEN:'x'.repeat(32),DATA_DIR:'/var/data/legacy'});
  assert.equal(config.publicBookingDirectory.replaceAll('\\','/'),'/var/data/insight-public-bookings');
  assert.throws(()=>configuration({INSIGHT_SERVICE_TOKEN:'x'.repeat(32),INSIGHT_PUBLIC_BOOKING_DIR:'/'}),/dedicated/);
});
test('authorized existing company GET adds public-only reference despite unknown full inventory, leaving all source quantities intact',async t=>{
  const f=await fixture(t);await f.server.publicBookingPickupStore.importLedger(ledger());
  const reply=await f.request(f.route());assert.equal(reply.status,200);
  const evidence=reply.data.publicBookingPickup;
  assert.equal(evidence.status,'reference');assert.equal(evidence.companyId,PIKA);assert.equal(evidence.publicChange,2);assert.equal(evidence.days,2);
  assert.equal(evidence.publicOnly,true);assert.equal(evidence.wholeReservationRestored,false);assert.equal(evidence.inferredChange,null);assert.equal(evidence.actionable,false);
  assert.equal(evidence.source.currentRunId,PIKA+'_current');assert.equal(evidence.source.currentObservedAt,current);
  assert.ok(evidence.rows.every(row=>!Object.hasOwn(row,'productEvidence')),'normalized raw evidence is private; public daily provenance stays visible');
  assert.equal(reply.data.companyDetail.current.daily[0].missing,true);assert.equal(reply.data.companyDetail.current.daily[0].publicBookings,null);
  assert.equal(reply.data.companyDetail.integrated.roomBasis.reviewRequired,true);assert.equal(reply.data.companyDetail.integrated.snapshot.analysis.pickup.comparableIntervals,0);
  assert.equal(reply.data.result.rooms,null);assert.equal(reply.data.result.quality.status,'partial');
  assert.ok(f.calls.every(call=>call.method==='GET'));assert.ok(f.calls.every(call=>/\/(?:me|companies\/[a-zA-Z0-9_-]+\/collection)$/.test(call.path)));
});
test('an authorized company with no imported pair stays unknown instead of receiving another company reference or false zero',async t=>{
  const f=await fixture(t);await f.server.publicBookingPickupStore.importLedger(ledger(PIKA));
  const reply=await f.request(f.route(SANGAWON));assert.equal(reply.status,200);assert.equal(reply.data.publicBookingPickup,undefined);
  assert.equal(reply.data.companyDetail.integrated.snapshot.analysis.pickup.status,'insufficient');assert.equal(reply.data.companyDetail.integrated.snapshot.analysis.pickup.intervals.length,0);
});
test('401, identity403, unregistered404 and upstream404 cannot leak locally retained reference data',async t=>{
  const f=await fixture(t);await f.server.publicBookingPickupStore.importLedger(ledger());
  let reply=await f.request(f.route(),{cookie:false});assert.equal(reply.status,401);assert.equal(reply.data.publicBookingPickup,undefined);
  f.state.identityStatus=403;reply=await f.request(f.route());assert.equal(reply.status,403);assert.equal(reply.data.publicBookingPickup,undefined);
  f.state.identityStatus=200;f.state.allowed=[];reply=await f.request(f.route());assert.equal(reply.status,404);assert.equal(reply.data.publicBookingPickup,undefined);
  const notFound=await fixture(t);await notFound.server.publicBookingPickupStore.importLedger(ledger());notFound.state.sourceStatus=404;
  reply=await notFound.request(notFound.route());assert.equal(reply.status,404);assert.equal(reply.data.publicBookingPickup,undefined);
});
test('registration revocation is checked again even after an earlier enriched cached read',async t=>{
  const f=await fixture(t);await f.server.publicBookingPickupStore.importLedger(ledger());assert.equal((await f.request(f.route())).data.publicBookingPickup.publicChange,2);
  f.state.allowed=[];const reply=await f.request(f.route());assert.equal(reply.status,404);assert.equal(reply.data.publicBookingPickup,undefined);
});
test('a mismatched central company response cannot be enriched using the requested company private ledger',async t=>{
  const f=await fixture(t);await f.server.publicBookingPickupStore.importLedger(ledger());f.state.sourceCompanyOverride=ANDER;
  const reply=await f.request(f.route());assert.notEqual(reply.status,200);assert.equal(reply.data.publicBookingPickup,undefined);
});
test('administrator customer-view uses the same registered-company authorization and never broadens private ledger access',async t=>{
  const f=await fixture(t);await f.server.publicBookingPickupStore.importLedger(ledger());
  const route='/api/insight-admin/v1/customer-view/companies/'+PIKA+'/collection?month=2026-10';
  const reply=await f.request(route,{admin:true,customerId:'cus_public-pickup'});assert.equal(reply.status,200);assert.equal(reply.data.publicBookingPickup.publicChange,2);
  f.state.allowed=[];const denied=await f.request(route,{admin:true,customerId:'cus_public-pickup'});assert.equal(denied.status,404);assert.equal(denied.data.publicBookingPickup,undefined);
});
test('public evidence enrichment causes no extra central requests, no new endpoint and no POST',async t=>{
  const baseline=await fixture(t,{persistent:false}),enriched=await fixture(t);
  await enriched.server.publicBookingPickupStore.importLedger(ledger());
  await baseline.request(baseline.route());await enriched.request(enriched.route());
  assert.deepEqual(enriched.calls,baseline.calls);
  assert.ok(enriched.calls.every(call=>call.method==='GET'));
  assert.ok(enriched.calls.every(call=>!/(crawl|collect-request|rotation|recurring|public-booking)/.test(call.path)));
});
test('private ledger files and backend modules are not served as public static assets',async t=>{
  const f=await fixture(t);await f.server.publicBookingPickupStore.importLedger(ledger());
  const targets=['/public-booking-pickup-store.cjs','/lib/public-booking-pickup.cjs','/private-ledgers/index.json','/insight-public-bookings/index.json','/data/public-bookings/index.json'];
  for(const route of targets){const reply=await f.request(route,{cookie:false});assert.equal(reply.status,404,route);assert.equal(reply.data?.publicBookingPickup,undefined);assert.equal(reply.text.includes('sourceDigest'),false);}
  assert.equal(f.calls.length,0,'private static paths are not forwarded to central APIs');
});
