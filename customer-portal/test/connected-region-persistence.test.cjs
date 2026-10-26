'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {createConnectedServer,configuration}=require('../connected-server.cjs');
const origin='https://insight-persistence.example',backend='https://central-persistence.example';
const regional='/api/customer/v1/regions/region_one/analysis?month=2026-09';
async function fixture(t){
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'insight-bff-persistence-'));
 const state={allowed:true,identityStatus:200,sourceStatus:200,version:1,hold:null},calls=[];let server=null;
 const identity=()=>({customer:{customerId:'cus_private_fixture',accountStatus:'active',revision:1,relations:[],regions:[]},companies:[],regions:state.allowed?[{id:'region_one',label:'복원 지역'}]:[],csrfToken:'private-fixture-csrf'});
 const source=()=>({region:{id:'region_one',label:'복원 지역'},month:'2026-09',window:{start:'2025-10',end:'2026-09',months:12},source:'datalab_saved',networkAttempted:false,sources:[{key:'visitors',label:'방문자',rows:[{key:'total',label:'방문자',value:state.version,unit:'명'},{key:'missing',label:'미확인',value:null,unit:'명'}]}],availableSources:1,warnings:[],refreshAvailable:false,token:'private-fixture-token',customer:{id:'private-fixture-account'}});
 const fetchImpl=async(url,options)=>{
  const u=new URL(url),isSource=u.pathname.endsWith('/analysis');calls.push({path:u.pathname,method:options.method});
  if(isSource&&state.hold)await state.hold;
  const status=isSource?state.sourceStatus:state.identityStatus;
  return {ok:status===200,status,headers:new Headers(),json:async()=>status===200?(isSource?source():identity()):{error:{code:'FIXTURE_'+status,message:'fixture response'}}};
 };
 const start=async()=>{server=createConnectedServer({origin,backend,serviceToken:'private-fixture-service-credential-not-real',fetchImpl,regionCacheDirectory:directory});await server.prepareRegionSnapshots();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));};
 const close=async()=>{if(server){const previous=server;server=null;await previous.flushRegionSnapshots();previous.closeAllConnections();await new Promise(resolve=>previous.close(resolve));}};
 t.after(async()=>{await close();const resolved=path.resolve(directory),temp=path.resolve(os.tmpdir())+path.sep;assert.ok(resolved.startsWith(temp)&&path.basename(resolved).startsWith('insight-bff-persistence-'));await fs.rm(resolved,{recursive:true,force:true});});
 const request=(route,admin=false,refresh=false)=>new Promise((resolve,reject)=>{
  const req=http.request({hostname:'127.0.0.1',port:server.address().port,path:route,headers:{Host:new URL(origin).host,Cookie:admin?'__Host-sabun_insight_admin=private-fixture-admin-session':'__Host-sabun_insight_session=private-fixture-session',...(refresh?{'X-Insight-Refresh':'1'}:{})}},res=>{const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>resolve({status:res.statusCode,data:JSON.parse(Buffer.concat(chunks).toString('utf8')),headers:res.headers}));});req.on('error',reject);req.end();
 });
 await start();return {directory,state,calls,start,close,request,sourceCalls:()=>calls.filter(c=>c.path.endsWith('/analysis')).length};
}

test('a new BFF process restores permitted public region data through fresh /me without a source request',async t=>{
 const f=await fixture(t),first=await f.request(regional);assert.equal(first.status,200);const checkedAt=first.data.responseCache.checkedAt;await f.close();await f.start();
 const boot=await f.request('/api/customer/v1/me');assert.equal(boot.status,200);assert.equal(f.sourceCalls(),1,'restart bootstrap only reads local persisted public data');
 assert.equal(boot.data.regionViews.length,1);const recovered=boot.data.regionViews[0];assert.equal(recovered.regionKey,'region_one');assert.equal(recovered.month,'2026-09');assert.equal(recovered.data.sources[0].rows[0].value,1);assert.equal(recovered.data.sources[0].rows[1].value,null);
 assert.equal(recovered.data.responseCache.persisted,true);assert.equal(recovered.data.responseCache.checkedAt,checkedAt);assert.equal(recovered.data.responseCache.revalidationRequired,true);assert.ok(Date.parse(recovered.data.responseCache.validUntil)>Date.parse(checkedAt));
 assert.doesNotMatch(JSON.stringify(boot.data.regionViews),/private-fixture|cus_private_fixture/);
 assert.ok(f.calls.filter(c=>c.path==='/api/insight/v1/me').length>=2,'no persisted authentication shortcut');
 let release;f.state.hold=new Promise(resolve=>release=resolve);const hit=await f.request(regional);assert.equal(hit.status,200);assert.equal(hit.data.sources[0].rows[0].value,1);assert.equal(hit.data.responseCache.refreshing,true,'fresh source verification runs behind the restored response');
 f.state.version=2;release();f.state.hold=null;
 const refreshed=await f.request(regional,false,true);assert.equal(refreshed.data.sources[0].rows[0].value,2);await f.close();await f.start();
 assert.equal((await f.request('/api/customer/v1/me')).data.regionViews[0].data.sources[0].rows[0].value,2,'a successful source update survives another process restart');
});

test('restart restoration still rejects expired sessions and removed region permissions',async t=>{
 const f=await fixture(t);await f.request(regional);await f.close();await f.start();f.state.allowed=false;
 assert.deepEqual((await f.request('/api/customer/v1/me')).data.regionViews,[]);assert.equal((await f.request(regional)).status,404);assert.equal(f.sourceCalls(),1);
 f.state.identityStatus=401;const expired=await f.request('/api/customer/v1/me');assert.equal(expired.status,401);assert.equal(expired.data.regionViews,undefined);assert.match(expired.headers['set-cookie'][0],/Max-Age=0/);
});

test('administrator preview restores the same public result only after its own current identity check',async t=>{
 const f=await fixture(t);await f.request(regional);await f.close();await f.start();
 const boot=await f.request('/api/insight-admin/v1/customer-view/me',true);assert.equal(boot.status,200);assert.equal(boot.data.regionViews.length,1);assert.equal(boot.data.regionViews[0].data.responseCache.persisted,true);assert.equal(f.sourceCalls(),1);
 assert.ok(f.calls.some(c=>c.path==='/api/insight/v1/admin/customer-view/me'));
});

test('a failed current-source read cannot replace the durable last good result',async t=>{
 const f=await fixture(t);const first=await f.request(regional);await f.close();await f.start();f.state.sourceStatus=503;
 assert.equal((await f.request(regional,false,true)).status,503);await f.close();await f.start();
 const boot=await f.request('/api/customer/v1/me'),saved=boot.data.regionViews[0].data;assert.equal(saved.sources[0].rows[0].value,1);assert.equal(saved.responseCache.checkedAt,first.data.responseCache.checkedAt);
});

test('only the dedicated cache directory is configured and local tests do not implicitly write persistence',()=>{
 const token='fixture-service-token-not-a-real-credential',base={INSIGHT_SERVICE_TOKEN:token};
 assert.equal(configuration(base).regionCacheDirectory,null);
 assert.equal(configuration({...base,RENDER:'1'}).regionCacheDirectory,path.join('/var/data','insight-region-cache'));
 assert.equal(configuration({...base,DATA_DIR:os.tmpdir()}).regionCacheDirectory,path.join(os.tmpdir(),'insight-region-cache'));
 assert.throws(()=>configuration({...base,INSIGHT_REGION_CACHE_DIR:'relative-cache'}),/absolute/);
 assert.throws(()=>configuration({...base,INSIGHT_REGION_CACHE_DIR:path.parse(os.tmpdir()).root}),/dedicated/);
});
