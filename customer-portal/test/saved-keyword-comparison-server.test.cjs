'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const crypto=require('node:crypto');
const {createConnectedServer}=require('../connected-server.cjs');
const ORIGIN='https://insight.example',BACKEND='https://datalab.example',ADMIN='A'.repeat(43),CUSTOMER='C'.repeat(43);
const digest=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
async function fixture(t){
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'insight-saved-keyword-'));
  const html=Buffer.from('<!doctype html><title>Saved historical review</title>'),snapshot=Buffer.from('{"classification":"historical_test_fixture"}');
  const snapshotName='snapshot.'+digest(snapshot)+'.json';
  const metadata={schemaVersion:1,kind:'historical_admin_review',liveDataConnection:false,collectionEnabled:false,html:{path:'index.html',bytes:html.length,sha256:digest(html)},snapshot:{path:snapshotName,bytes:snapshot.length,sha256:digest(snapshot)}};
  await Promise.all([fs.writeFile(path.join(directory,'index.html'),html),fs.writeFile(path.join(directory,snapshotName),snapshot),fs.writeFile(path.join(directory,'bundle.json'),JSON.stringify(metadata))]);
  const calls=[],state={status:200,role:'insight_admin',active:true};
  const server=createConnectedServer({origin:ORIGIN,backend:BACKEND,serviceToken:'test-service-token-never-real-secret',savedComparisonDirectory:directory,diagnosticsLogger:()=>{},companyDiagnosticsLogger:()=>{},fetchImpl:async(input,options={})=>{
    const url=new URL(input),headers=new Headers(options.headers);calls.push({path:url.pathname,method:options.method||'GET',session:headers.get('x-insight-admin-session')});
    assert.equal(url.pathname,'/api/insight/v1/admin/me','only existing central administrator identity may be read');
    assert.equal(options.method||'GET','GET');assert.equal(headers.get('x-insight-admin-session'),ADMIN);
    return {status:state.status,ok:state.status>=200&&state.status<300,headers:new Headers(),json:async()=>state.status===200?{admin:{adminId:'iad_fixture',role:state.role,status:state.active?'active':'disabled'}}:{error:{code:'ADMIN_LOGIN_REQUIRED'}}};
  }});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));assert.equal(path.dirname(directory),os.tmpdir());await fs.rm(directory,{recursive:true,force:true});});
  const request=(route,{method='GET',cookie='admin',headers={}}={})=>new Promise((resolve,reject)=>{
    const req=http.request({hostname:'127.0.0.1',port:server.address().port,path:route,method,headers:{Host:new URL(ORIGIN).host,...(cookie==='admin'?{Cookie:'__Host-sabun_insight_admin='+ADMIN}:cookie==='customer'?{Cookie:'__Host-sabun_insight_session='+CUSTOMER}:cookie==='invalid'?{Cookie:'__Host-sabun_insight_admin=invalid'}:{}),...headers}},res=>{const chunks=[];res.on('data',part=>chunks.push(part));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(chunks).toString('utf8')}));});req.on('error',reject);req.end();
  });
  return {directory,request,calls,state,snapshotName,html,snapshot,metadata};
}
test('HTML and sidecar deny unauthenticated and ordinary-customer access without any central data reads',async t=>{
  const f=await fixture(t);
  for(const route of['/saved-keyword-comparison/','/saved-keyword-comparison/'+f.snapshotName]){
    for(const [cookie,status]of[[null,401],['invalid',401],['customer',403]]){const r=await f.request(route,{cookie});assert.equal(r.status,status);assert.match(r.headers['cache-control'],/private.*no-store/);assert.doesNotMatch(r.body,/historical_test_fixture|Saved historical review/);}
  }
  assert.equal(f.calls.length,0);
});
test('GET and HEAD verify active administrator identity on each access and stream only the signed bundle',async t=>{
  const f=await fixture(t);
  for(const [route,content,type]of[['/saved-keyword-comparison/',f.html,'text/html'],['/saved-keyword-comparison/'+f.snapshotName,f.snapshot,'application/json']]){
    const head=await f.request(route,{method:'HEAD'});assert.equal(head.status,200);assert.equal(head.body,'');assert.equal(Number(head.headers['content-length']),content.length);
    const get=await f.request(route);assert.equal(get.status,200);assert.equal(get.body,content.toString());assert.match(get.headers['content-type'],new RegExp(type));
    assert.equal(get.headers['x-frame-options'],'SAMEORIGIN');assert.match(get.headers['content-security-policy'],/frame-ancestors 'self'/);assert.match(get.headers['content-security-policy'],/connect-src 'self'/);assert.match(get.headers['cache-control'],/private.*no-store/);
  }
  assert.equal(f.calls.length,4);assert.ok(f.calls.every(call=>call.path==='/api/insight/v1/admin/me'&&call.method==='GET'));
});
test('expired or revoked administrator sessions cannot reuse a previously loaded bundle',async t=>{
  const f=await fixture(t);assert.equal((await f.request('/saved-keyword-comparison/')).status,200);
  f.state.status=401;const denied=await f.request('/saved-keyword-comparison/'+f.snapshotName);assert.equal(denied.status,401);assert.match(denied.headers['set-cookie'][0],/Max-Age=0/);
  f.state.status=200;f.state.role='customer';assert.equal((await f.request('/saved-keyword-comparison/')).status,403);
  f.state.role='insight_admin';f.state.active=false;assert.equal((await f.request('/saved-keyword-comparison/')).status,403);
});
test('POST, cross-site embedding, unknown files and metadata cannot invoke actions or expose code',async t=>{
  const f=await fixture(t);
  const post=await f.request('/saved-keyword-comparison/',{method:'POST'});assert.equal(post.status,405);assert.equal(post.headers.allow,'GET, HEAD');
  assert.equal((await f.request('/saved-keyword-comparison/',{headers:{'Sec-Fetch-Site':'cross-site'}})).status,403);assert.equal(f.calls.length,0);
  for(const route of['bundle.json','server.cjs','../connected-server.cjs','snapshot.'+'0'.repeat(64)+'.json'])assert.equal((await f.request('/saved-keyword-comparison/'+route)).status,404);
  assert.ok(f.calls.every(call=>call.path.endsWith('/admin/me')&&call.method==='GET'));
});
test('bundle mutation or invalid policy fails closed instead of serving mismatched historical data',async t=>{
  const f=await fixture(t);assert.equal((await f.request('/saved-keyword-comparison/')).status,200);
  await fs.appendFile(path.join(f.directory,f.snapshotName),' ');const failed=await f.request('/saved-keyword-comparison/'+f.snapshotName);assert.equal(failed.status,503);assert.match(failed.body,/SAVED_COMPARISON_UNAVAILABLE/);
  await fs.writeFile(path.join(f.directory,f.snapshotName),f.snapshot);await fs.writeFile(path.join(f.directory,'bundle.json'),JSON.stringify({...f.metadata,collectionEnabled:true}));
  assert.equal((await f.request('/saved-keyword-comparison/')).status,503);
});
test('unrelated portal pages keep their original frame and script restrictions',async t=>{
  const f=await fixture(t);const r=await f.request('/customer-view');assert.equal(r.status,200);assert.match(r.headers['content-security-policy'],/frame-ancestors 'none'/);assert.doesNotMatch(r.headers['content-security-policy'],/unsafe-inline/);assert.equal(f.calls.length,0);
});
test('production historical bundle has the reviewed build hashes and remains offline by policy',async()=>{
  const root=path.resolve(__dirname,'../assets/saved-keyword-comparison'),metadata=JSON.parse(await fs.readFile(path.join(root,'bundle.json'),'utf8'));
  assert.equal(metadata.kind,'historical_admin_review');assert.equal(metadata.ownerCompanyId,'cmp_place_35644668');assert.equal(metadata.keyword,'경남글램핑');assert.equal(metadata.liveDataConnection,false);assert.equal(metadata.collectionEnabled,false);
  assert.deepEqual(metadata.observationDays,['2026-09-20','2026-09-21','2026-09-22']);
  for(const item of[metadata.html,metadata.snapshot]){const bytes=await fs.readFile(path.join(root,item.path));assert.equal(bytes.length,item.bytes);assert.equal(digest(bytes),item.sha256);}
});
