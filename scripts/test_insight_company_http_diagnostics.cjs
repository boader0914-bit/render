'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{Readable}=require('node:stream'),crypto=require('node:crypto');
const {createInsightHttp}=require('./lib/insight_http.cjs'),{createInsightStore}=require('./lib/insight_store.cjs');
const gate=()=>{let resolve;const promise=new Promise(done=>resolve=done);return {promise,resolve};};
const turn=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(t,options={}){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'insight-company-diagnostics-')),store=createInsightStore({file:path.join(root,'state.sqlite')});
  t.after(()=>{store.close();assert.equal(path.dirname(path.resolve(root)),path.resolve(os.tmpdir()));fs.rmSync(root,{recursive:true,force:true});});
  const companyId='cmp_private_fixture',catalog={companies:[{companyId,name:'PRIVATE_COMPANY',rooms:16}],regions:[]},c=store.ensure({memberId:'PRIVATE_MEMBER',username:'PRIVATE_USERNAME',role:'b2b'});
  store.update(c.customerId,{revision:c.revision,requestKey:crypto.randomUUID(),action:'add-company',payload:{kind:'own',companyId}},catalog);
  const token=store.session(c.customerId),serviceToken=crypto.randomUUID(),entries=[];let time=0,memberReads=0;
  const detail={companyId,integrated:{roomBasis:{count:16}},current:{summary:null,daily:[]}};
  const handlers=createInsightHttp({store,serviceToken,catalog:async()=>catalog,companyClock:()=>time,companyDiagnostics:entry=>entries.push(entry),
    memberActive:async()=>{memberReads++;return true;},preparationBridge:{refresh:async()=>{}},
    collectionResults:{readView:async()=>({companyDetail:detail,result:null})},savedCollectionResults:{companyDetail:async()=>detail},...options});
  async function request(query='?month=2026-09'){
    const req=Readable.from([]);req.method='GET';req.headers={authorization:'Bearer '+serviceToken,'x-insight-session':token,'x-request-id':'PRIVATE_FORGED_REQUEST_ID'};
    const headers={},res={setHeader(name,value){headers[name]=value;},writeHead(status){this.status=status;},end(value){this.data=JSON.parse(value);}};
    await handlers.internal(req,res,new URL('/api/insight/v1/companies/'+companyId+'/collection'+query,'http://fixture'));
    return {status:res.status,data:res.data,headers};
  }
  return {store,customerId:c.customerId,token,entries,request,time:value=>{time=value;},memberReads:()=>memberReads};
}

test('company HTTP diagnostics expose each pending stage before its await and a matched month/random correlation after response',async t=>{
  const prep=gate(),view=gate(),permission=gate();let checks=0;
  const f=fixture(t,{preparationBridge:{refresh:()=>prep.promise},collectionResults:{readView:()=>view.promise},memberActive:async()=>++checks===1?true:permission.promise});
  const pending=f.request();await turn();assert.deepEqual(f.entries.map(row=>[row.stage,row.outcome]),[['preparation_wait','started']]);
  f.time(100);prep.resolve();await turn();assert.deepEqual(f.entries.at(-1).stage,'view_read');assert.equal(f.entries.at(-1).outcome,'started');
  f.time(125);view.resolve({companyDetail:{companyId:'cmp_private_fixture'},result:null});await turn();assert.equal(f.entries.at(-1).stage,'permission_verify');assert.equal(f.entries.at(-1).outcome,'started');
  f.time(150);permission.resolve(true);const reply=await pending;assert.equal(reply.status,200);assert.equal(f.entries.length,7);
  assert.deepEqual(f.entries.map(row=>[row.stage,row.outcome]),[['preparation_wait','started'],['preparation_wait','complete'],['view_read','started'],['view_read','complete'],['permission_verify','started'],['permission_verify','complete'],['responded','complete']]);
  assert.deepEqual(f.entries.filter(row=>row.outcome==='complete').map(row=>row.elapsedMs),[100,25,25,150]);
  assert.equal(f.entries.at(-1).status,200);const ids=new Set(f.entries.map(row=>row.requestId));assert.equal(ids.size,1);
  assert.match([...ids][0],/^[a-f0-9-]{36}$/);assert.equal(reply.headers['X-Insight-Company-Request-Id'],[...ids][0]);
  assert.ok(f.entries.every(row=>row.requestedMonth==='2026-09'));
  const text=JSON.stringify(f.entries);for(const secret of [f.token,f.customerId,'PRIVATE_','cmp_private_fixture'])assert.equal(text.includes(secret),false);
  assert.deepEqual(Object.keys(f.entries[0]).sort(),['elapsedMs','outcome','requestId','requestedMonth','stage','totalMs']);
  assert.equal(f.store.requests(f.customerId).length,0);
});

test('view failure logs its controlled stage and final JSON status without source errors or payload',async t=>{
  const f=fixture(t,{collectionResults:{readView:async()=>{throw Error('PRIVATE_SOURCE_ERROR');}}}),reply=await f.request('');
  assert.equal(reply.status,503);assert.deepEqual(f.entries.slice(-2).map(row=>[row.stage,row.outcome]),[['view_read','failed'],['responded','failed']]);
  assert.equal(f.entries.at(-1).status,503);assert.ok(f.entries.every(row=>row.requestedMonth==='default'));assert.doesNotMatch(JSON.stringify(f.entries),/PRIVATE_|cmp_private_fixture/);
});

test('logging never bypasses final session checks and a diagnostic callback failure cannot affect a normal response',async t=>{
  const entered=gate(),release=gate();const f=fixture(t,{collectionResults:{async readView(){entered.resolve();await release.promise;return {companyDetail:{companyId:'cmp_private_fixture'},result:null};}}});
  const pending=f.request();await entered.promise;f.store.logout(f.token);release.resolve();const reply=await pending;
  assert.equal(reply.status,401);assert.equal(reply.data.companyDetail,undefined);assert.deepEqual(f.entries.slice(-2).map(row=>[row.stage,row.outcome]),[['permission_verify','failed'],['responded','failed']]);
  assert.equal(f.entries.at(-1).status,401);
  const noisy=fixture(t,{companyDiagnostics:()=>{throw Error('diagnostic unavailable');}});assert.equal((await noisy.request()).status,200);
});

test('saved previews and invalid query values cannot enter normal company diagnostics',async t=>{
  const f=fixture(t);assert.equal((await f.request('?month=2026-09&savedOnly=1')).status,200);assert.deepEqual(f.entries,[]);
  assert.equal((await f.request('?month=PRIVATE_BAD_MONTH')).status,400);assert.deepEqual(f.entries,[]);
});
