'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {createConnectedServer,configuration}=require('../connected-server.cjs');
const origin='https://insight-company-persistence.example',alias='https://insight-company-alias.example',backend='https://central-company-persistence.example';
const own='/api/customer/v1/companies/cmp_own/collection',competitor='/api/customer/v1/companies/cmp_competitor/collection';
const deferred=()=>{let resolve;const promise=new Promise(done=>resolve=done);return {promise,resolve};};
async function fixture(t){
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'insight-company-bff-'));
 const state={customerId:'cus_fixture_private_account',allowed:['cmp_own','cmp_competitor'],identityStatus:200,sourceStatus:200,version:1,catalogVersion:1,hold:null},calls=[];let server=null;
 const identity=()=>({customer:{customerId:state.customerId,accountStatus:'active',revision:1,relations:state.allowed.map(companyId=>({companyId,kind:companyId==='cmp_own'?'own':'competitor',status:'active'}))},companies:state.allowed.map(companyId=>({companyId,name:companyId==='cmp_own'?'검수 내 매장':'검수 경쟁업체',version:state.catalogVersion,rooms:16})),regions:[],preparations:[],collectionAllowance:{limit:1,used:0,canRequest:true},csrfToken:'fixture-private-csrf',corrections:[{note:'fixture-private-correction'}]});
 const source=(companyId,month)=>({result:{companyId,runId:'run_'+state.version,version:'result_'+state.version,products:[],token:'fixture-private-result-token'},companyDetail:{companyId,source:'company_db',basics:{name:companyId==='cmp_own'?'검수 내 매장':'검수 경쟁업체',rooms:16},channels:[],integrated:{status:'ready',selectedMonth:month,roomBasis:{count:16},snapshot:{summary:{sold:state.version,estimatedRevenue:state.version*100000},daily:[{date:month+'-01',total:16,sold:0,estimatedRevenue:null,missing:false}]}},current:{summary:{sold:state.version,estimatedRevenue:state.version*100000},daily:[{date:month+'-01',total:16,sold:0,estimatedRevenue:null,missing:false}]},token:'fixture-private-detail-token'},request:null,collectionAllowance:{limit:1,used:1,canRequest:false},privateEvidence:'fixture-private-evidence',token:'fixture-private-top-token'});
 const fetchImpl=async(url,options)=>{
  const u=new URL(url),match=/\/companies\/([^/]+)\/collection$/.exec(u.pathname),isSource=Boolean(match);calls.push({path:u.pathname,method:options.method});
  if(isSource&&state.hold)await state.hold;
  const status=isSource?state.sourceStatus:state.identityStatus;
  return {ok:status===200,status,headers:new Headers(),json:async()=>status===200?(isSource?source(match[1],u.searchParams.get('month')||new Date(Date.now()+9*3600000).toISOString().slice(0,7)):identity()):{error:{code:'FIXTURE_'+status,message:'fixture response'}}};
 };
 const start=async()=>{server=createConnectedServer({origin,origins:[alias],backend,serviceToken:'fixture-private-service-credential-not-real',fetchImpl,companyCacheDirectory:directory});await server.prepareCompanySnapshots();await server.prepareRegionSnapshots();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));};
 const close=async()=>{if(server){const previous=server;server=null;await previous.flushCompanySnapshots();previous.closeAllConnections();await new Promise(resolve=>previous.close(resolve));}};
 t.after(async()=>{await close();const resolved=path.resolve(directory),temp=path.resolve(os.tmpdir())+path.sep;assert.ok(resolved.startsWith(temp)&&path.basename(resolved).startsWith('insight-company-bff-'));await fs.rm(resolved,{recursive:true,force:true});});
 const request=(route,{admin=false,refresh=false,host=new URL(origin).host}={})=>new Promise((resolve,reject)=>{
  const req=http.request({hostname:'127.0.0.1',port:server.address().port,path:route,headers:{Host:host,Cookie:admin?'__Host-sabun_insight_admin=fixture-private-admin-session':'__Host-sabun_insight_session=fixture-private-session',...(refresh?{'X-Insight-Refresh':'1'}:{})}},res=>{const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>resolve({status:res.statusCode,data:JSON.parse(Buffer.concat(chunks).toString('utf8')),headers:res.headers}));});req.on('error',reject);req.end();
 });
 await start();return {directory,state,calls,start,close,request,sourceCalls:()=>calls.filter(c=>c.path.endsWith('/collection')).length};
}

test('a new BFF process restores both own and competitor results after fresh login checks without expensive source reads',async t=>{
 const f=await fixture(t),first=await f.request(own),second=await f.request(competitor);assert.equal(first.status,200);assert.equal(second.status,200);await f.close();await f.start();
 const boot=await f.request('/api/customer/v1/me');assert.equal(boot.status,200);assert.equal(f.sourceCalls(),2,'bootstrap uses persisted company views without recalculation');assert.equal(boot.data.companyViews.length,2);
 for(const [id,checkedAt] of [['cmp_own',first.data.responseCache.checkedAt],['cmp_competitor',second.data.responseCache.checkedAt]]){
  const view=boot.data.companyViews.find(v=>v.companyId===id);assert.ok(view);assert.equal(view.month,'');assert.equal(view.data.companyDetail.companyId,id);assert.equal(view.data.companyDetail.basics.rooms,16);assert.equal(view.data.companyDetail.integrated.snapshot.daily[0].sold,0);assert.equal(view.data.companyDetail.integrated.snapshot.daily[0].estimatedRevenue,null);
  assert.equal(view.data.responseCache.persisted,true);assert.equal(view.data.responseCache.revalidationRequired,true);assert.equal(view.data.responseCache.checkedAt,checkedAt);assert.equal(view.data.collectionAllowance.used,0,'current quota comes from fresh identity');
 }
 assert.ok(f.calls.filter(c=>c.path==='/api/insight/v1/me').length>=3);assert.ok(f.calls.every(c=>c.method==='GET'),'restoration does not collect or mutate');
 const serialized=await Promise.all((await fs.readdir(f.directory)).filter(file=>file.endsWith('.json')).map(file=>fs.readFile(path.join(f.directory,file),'utf8')));assert.ok(serialized.length>0);
 assert.doesNotMatch(serialized.join('\n'),/fixture-private|cus_fixture_private_account|csrfToken|collectionAllowance|customerId|corrections/,'no credentials, personal account state or quota are serialized');
});

test('restored company data returns while the original-source update is pending and the successful update survives another process restart',async t=>{
 const f=await fixture(t),first=await f.request(own);await f.close();await f.start();const held=deferred();f.state.hold=held.promise;
 const saved=await f.request(own);assert.equal(saved.status,200);assert.equal(saved.data.companyDetail.integrated.snapshot.summary.sold,1);assert.equal(saved.data.responseCache.checkedAt,first.data.responseCache.checkedAt);assert.equal(saved.data.responseCache.refreshing,true);
 f.state.version=2;held.resolve();f.state.hold=null;const fresh=await f.request(own,{refresh:true});assert.equal(fresh.status,200);assert.equal(fresh.data.companyDetail.integrated.snapshot.summary.sold,2);await f.close();await f.start();
 const boot=await f.request('/api/customer/v1/me');assert.equal(boot.data.companyViews[0].data.companyDetail.integrated.snapshot.summary.sold,2);assert.ok(f.calls.every(c=>c.method==='GET'));
});

test('a different account, administrator audience, or public alias cannot restore another partition',async t=>{
 const f=await fixture(t);await f.request(own);await f.close();await f.start();f.state.customerId='cus_different_fixture_account';
 assert.deepEqual((await f.request('/api/customer/v1/me')).data.companyViews,[]);f.state.customerId='cus_fixture_private_account';
 assert.deepEqual((await f.request('/api/insight-admin/v1/customer-view/me',{admin:true})).data.companyViews,[]);
 assert.deepEqual((await f.request('/api/customer/v1/me',{host:new URL(alias).host})).data.companyViews,[]);assert.equal(f.sourceCalls(),1);
 const admin='/api/insight-admin/v1/customer-view/companies/cmp_own/collection';assert.equal((await f.request(admin,{admin:true})).status,200);await f.close();await f.start();
 const adminBoot=await f.request('/api/insight-admin/v1/customer-view/me',{admin:true});assert.equal(adminBoot.data.companyViews.length,1);assert.equal(adminBoot.data.companyViews[0].data.responseCache.persisted,true);assert.ok(f.calls.some(c=>c.path==='/api/insight/v1/admin/customer-view/me'));
});

test('removed company relationships, changed verified catalog values, and expired sessions do not expose saved views',async t=>{
 const f=await fixture(t);await f.request(own);await f.close();await f.start();f.state.allowed=['cmp_competitor'];
 assert.deepEqual((await f.request('/api/customer/v1/me')).data.companyViews,[]);assert.equal((await f.request(own)).status,404);assert.equal(f.sourceCalls(),1);
 f.state.allowed=['cmp_own','cmp_competitor'];f.state.catalogVersion=2;assert.deepEqual((await f.request('/api/customer/v1/me')).data.companyViews,[]);
 f.state.identityStatus=401;const expired=await f.request('/api/customer/v1/me');assert.equal(expired.status,401);assert.equal(expired.data.companyViews,undefined);assert.match(expired.headers['set-cookie'][0],/Max-Age=0/);
});

test('a failed source update leaves the last good company result durable',async t=>{
 const f=await fixture(t),first=await f.request(own);await f.close();await f.start();f.state.sourceStatus=503;assert.equal((await f.request(own,{refresh:true})).status,503);await f.close();await f.start();
 const boot=await f.request('/api/customer/v1/me');assert.equal(boot.data.companyViews[0].data.companyDetail.basics.rooms,16);assert.equal(boot.data.companyViews[0].data.responseCache.checkedAt,first.data.responseCache.checkedAt);
});

test('exact requested months remain distinct and keep the selected stay month on restart',async t=>{
 const f=await fixture(t);await f.request(own+'?month=2026-08');await f.request(own+'?month=2026-09');await f.close();await f.start();
 const boot=await f.request('/api/customer/v1/me');assert.equal(boot.data.companyViews.length,1);assert.equal(boot.data.companyViews[0].month,'2026-09');assert.equal(boot.data.companyViews[0].data.companyDetail.integrated.selectedMonth,'2026-09');
 const august=await f.request(own+'?month=2026-08');assert.equal(august.data.companyDetail.integrated.selectedMonth,'2026-08');assert.equal(august.data.responseCache.persisted,true);
});

test('company snapshots use a dedicated persistent directory and local servers do not write by default',()=>{
 const base={INSIGHT_SERVICE_TOKEN:'fixture-private-service-credential-not-real'};assert.equal(configuration(base).companyCacheDirectory,null);
 assert.equal(configuration({...base,RENDER:'1'}).companyCacheDirectory,path.join('/var/data','insight-company-cache'));
 assert.equal(configuration({...base,DATA_DIR:os.tmpdir()}).companyCacheDirectory,path.join(os.tmpdir(),'insight-company-cache'));
 assert.throws(()=>configuration({...base,INSIGHT_COMPANY_CACHE_DIR:'relative-cache'}),/absolute/);
 assert.throws(()=>configuration({...base,INSIGHT_COMPANY_CACHE_DIR:path.parse(os.tmpdir()).root}),/dedicated/);
});
