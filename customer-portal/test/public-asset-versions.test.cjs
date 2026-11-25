'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http'),fs=require('node:fs'),path=require('node:path');
const {createPublicAssetVersions}=require('../public-asset-versions.cjs');
const {createConnectedServer}=require('../connected-server.cjs');

function fixture(){
  const files=new Map([['script',Buffer.from('window.example=1;')],['font',Buffer.from('font-one')],['css',Buffer.from('@font-face{src:url("/fonts/Example.otf")}body{color:black}')],['html',Buffer.from('private html')]]);
  const assets=new Map([['/ui.js',{file:'script',type:'text/javascript'}],['/ui.css',{file:'css',type:'text/css'}],['/fonts/Example.otf',{file:'font',type:'font/otf'}],['/private',{file:'html',type:'text/html'}]]);
  const versions=createPublicAssetVersions({assets,readAsset:async file=>({data:files.get(file)})});return {files,versions};
}

test('HTML versions only exact public local assets and never rewrites account or external URLs',async()=>{
  const f=fixture(),source=Buffer.from('<script src="/ui.js"></script><link href="/ui.css"><a href="/private">p</a><a href="/api/customer/v1/me">me</a><script src="https://other.example/ui.js"></script><script src="//other.example/ui.js"></script>');
  const text=(await f.versions.html(source)).toString();assert.match(text,/src="\/ui\.js\?v=[a-f0-9]{64}"/);assert.match(text,/href="\/ui\.css\?v=[a-f0-9]{64}"/);
  for(const original of ['href="/private"','href="/api/customer/v1/me"','src="https://other.example/ui.js"','src="//other.example/ui.js"'])assert.ok(text.includes(original));
  assert.equal(await f.versions.get('/private'),null);
});

test('content updates change the public version automatically and old versions cannot be immutable',async()=>{
  const f=fixture(),first=await f.versions.get('/ui.js');assert.equal(f.versions.immutable(new URL('https://example/ui.js?v='+first.version),first),true);
  f.files.set('script',Buffer.from('window.example=2;'));const next=await f.versions.get('/ui.js');assert.notEqual(next.version,first.version);assert.notEqual(next.etag,first.etag);
  assert.equal(f.versions.immutable(new URL('https://example/ui.js?v='+first.version),next),false);assert.match((await f.versions.html(Buffer.from('<script src="/ui.js"></script>'))).toString(),new RegExp(next.version));
});

test('font changes propagate into CSS and HTML without modifying source files or circular dependencies',async()=>{
  const f=fixture(),first=await f.versions.get('/ui.css'),font=await f.versions.get('/fonts/Example.otf');assert.match(first.data.toString(),new RegExp('/fonts/Example.otf\\?v='+font.version));
  const raw=f.files.get('css').toString();f.files.set('font',Buffer.from('font-two'));const next=await f.versions.get('/ui.css');assert.notEqual(next.version,first.version);assert.equal(f.files.get('css').toString(),raw);
  assert.match((await f.versions.html(Buffer.from('<link href="/ui.css">'))).toString(),new RegExp(next.version));
});

test('missing, wrong, repeated or extra version parameters always fall back to revalidation',async()=>{
  const f=fixture(),asset=await f.versions.get('/ui.js');for(const search of ['','?v=wrong','?v='+asset.version+'&v='+asset.version,'?v='+asset.version+'&private=1'])assert.equal(f.versions.immutable(new URL('https://example/ui.js'+search),asset),false);
});

test('failed fingerprint reads preserve the original resource references without retrying',async()=>{
  const f=fixture(),reads=[];
  const versions=createPublicAssetVersions({assets:new Map([['/missing.js',{file:'missing-script',type:'text/javascript'}],['/ui.css',{file:'css',type:'text/css'}],['/fonts/Example.otf',{file:'missing-font',type:'font/otf'}]]),readAsset:async file=>{reads.push(file);if(file.startsWith('missing-'))throw Object.assign(Error('fixture missing'),{code:'ENOENT'});return {data:f.files.get(file)};}});
  const html=(await versions.html(Buffer.from('<script src="/missing.js"></script><link href="/ui.css">'))).toString();assert.match(html,/src="\/missing\.js"/);assert.match(html,/href="\/ui\.css\?v=[a-f0-9]{64}"/);
  const css=await versions.get('/ui.css');assert.ok(css.data.toString().includes('url("/fonts/Example.otf")'));assert.equal(reads.filter(file=>file==='missing-script').length,1);assert.equal(reads.filter(file=>file==='missing-font').length,2,'one attempt for each independent CSS read, without a retry loop');
  await assert.rejects(versions.get('/missing.js'),{code:'ENOENT'});
});

async function serverFixture(t){
  const calls=[],origin='https://asset-version.example',server=createConnectedServer({origin,backend:'https://central.example',serviceToken:'fixture-service-token-not-real-minimum-32-characters',fetchImpl:async(url,options)=>{
    calls.push({path:new URL(url).pathname,method:options.method});return {ok:true,status:200,headers:{get(){return null;}},json:async()=>({signupEnabled:true})};
  }});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>{server.closeAllConnections();server.close();});
  const request=(url,{method='GET',headers={}}={})=>new Promise((resolve,reject)=>{
    const req=http.request({host:'127.0.0.1',port:server.address().port,path:url,method,headers:{Host:new URL(origin).host,...headers}},res=>{const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(chunks)}));});req.on('error',reject);req.end();
  });return {request,calls};
}

test('connected HTML stays no-store and emits current versioned public script, style and font URLs',async t=>{
  const f=await serverFixture(t),page=await f.request('/');assert.equal(page.status,200);assert.equal(page.headers['cache-control'],'private, no-store');
  const html=page.body.toString(),script=html.match(/src="(\/bootstrap-read\.js\?v=[a-f0-9]{64})"/)[1],style=html.match(/href="(\/styles\.css\?v=[a-f0-9]{64})"/)[1];
  const reportScript=html.match(/src="(\/reports\.js\?v=[a-f0-9]{64})"/)[1];
  const js=await f.request(script),css=await f.request(style),reports=await f.request(reportScript);for(const asset of [js,css,reports]){assert.equal(asset.status,200);assert.equal(asset.headers['cache-control'],'public, max-age=31536000, immutable');assert.match(asset.headers.etag,/^"[a-zA-Z0-9_-]+"$/);assert.equal(asset.headers['set-cookie'],undefined);assert.equal(asset.headers['x-content-type-options'],'nosniff');assert.match(asset.headers['content-security-policy'],/script-src 'self'/);}
  const fontPath=css.body.toString().match(/url\('(\/fonts\/Pretendard-Regular\.otf\?v=[a-f0-9]{64})'\)/)[1],font=await f.request(fontPath);assert.equal(font.status,200);assert.match(font.headers['cache-control'],/immutable/);assert.equal(f.calls.length,0,'public page/assets must not call a protected source');
});

test('versioned and bare static requests preserve ETag, HEAD, 304 and stale URL compatibility',async t=>{
  const f=await serverFixture(t),page=await f.request('/'),url=page.body.toString().match(/src="(\/bootstrap-read\.js\?v=[a-f0-9]{64})"/)[1],asset=await f.request(url);
  const head=await f.request(url,{method:'HEAD'});assert.equal(head.status,200);assert.equal(head.body.length,0);assert.equal(Number(head.headers['content-length']),asset.body.length);assert.equal(head.headers.etag,asset.headers.etag);
  const notModified=await f.request(url,{headers:{'If-None-Match':asset.headers.etag}});assert.equal(notModified.status,304);assert.equal(notModified.body.length,0);assert.match(notModified.headers['cache-control'],/immutable/);
  for(const old of ['/bootstrap-read.js','/bootstrap-read.js?v=old',url+'&other=1']){const reply=await f.request(old);assert.equal(reply.status,200);assert.equal(reply.headers['cache-control'],'private, no-cache');assert.equal(reply.headers.etag,asset.headers.etag);assert.deepEqual(reply.body,asset.body);}
  const bare304=await f.request('/bootstrap-read.js',{headers:{'If-None-Match':'W/'+asset.headers.etag}});assert.equal(bare304.status,304);assert.equal(bare304.headers['cache-control'],'private, no-cache');
});

test('HTML aliases, API/auth paths and errors never become publicly cacheable via a version query',async t=>{
  const f=await serverFixture(t);for(const path of ['/login?v=anything','/signup?v=anything','/admin?v=anything','/customer-view?v=anything','/api/health?v=anything','/api/customer/v1/config?v=anything','/api/customer/v1/auth/login?v=anything','/unknown.js?v=anything']){
    const reply=await f.request(path);assert.equal(reply.headers['cache-control'],'private, no-store');assert.equal(reply.headers['x-content-type-options'],'nosniff');assert.match(reply.headers['content-security-policy'],/connect-src 'self'/);
    if(path.includes('auth/login')||path.startsWith('/unknown'))assert.equal(reply.status,404);else assert.equal(reply.status,200);
  }
});

for(const resource of [{name:'font',file:path.resolve(__dirname,'../../web/fonts/Pretendard-Regular.otf'),url:'/fonts/Pretendard-Regular.otf'},{name:'script',file:path.resolve(__dirname,'../web/bootstrap-read.js'),url:'/bootstrap-read.js'}])test(`a missing ${resource.name} fails only its resource GET while HTML remains available`,async t=>{
  const originalStat=fs.promises.stat,attempts=[];
  t.mock.method(fs.promises,'stat',async function(file,...args){if(path.resolve(file)===resource.file){attempts.push(file);throw Object.assign(Error('fixture resource missing'),{code:'ENOENT'});}return originalStat.call(this,file,...args);});
  const f=await serverFixture(t),page=await f.request('/');assert.equal(page.status,200);assert.equal(page.headers['cache-control'],'private, no-store');assert.match(page.body.toString(),/SA Insight/);
  if(resource.name==='script')assert.ok(page.body.toString().includes('src="/bootstrap-read.js"'),'the unavailable script keeps its original reference');
  else{const cssPath=page.body.toString().match(/href="(\/styles\.css\?v=[a-f0-9]{64})"/)[1],css=await f.request(cssPath);assert.equal(css.status,200);assert.ok(css.body.toString().includes("url('/fonts/Pretendard-Regular.otf')"));}
  const missing=await f.request(resource.url);assert.equal(missing.status,503);assert.equal(missing.headers['cache-control'],'private, no-store');assert.equal(f.calls.length,0);assert.ok(attempts.length<=3,'unavailable resource fingerprinting must remain bounded');
});

test('SA Insight public identity and install icons are versioned without customer or collection requests',async t=>{
  const f=await serverFixture(t);
  for(const route of ['/login','/signup','/customer-view','/admin']){
    const page=await f.request(route),html=page.body.toString();assert.equal(page.status,200);
    assert.match(html,/<title>SA Insight(?: 관리자)?<\/title>/);
    assert.match(html,/name="application-name" content="SA Insight"/);
    assert.match(html,/rel="apple-touch-icon"[^>]*href="\/icons\/sa-insight-180-20261125\.png\?v=[a-f0-9]{64}"/);
    const manifestUrl=html.match(/rel="manifest" href="([^"]+)"/)[1],manifest=await f.request(manifestUrl);
    assert.equal(manifest.status,200);assert.match(manifest.headers['content-type'],/^application\/manifest\+json/);
    const data=JSON.parse(manifest.body);assert.equal(data.name,'SA Insight');assert.equal(data.short_name,'SA Insight');
    assert.equal(data.start_url,'/');assert.equal(data.display,'standalone');
    for(const icon of data.icons){
      const image=await f.request(icon.src);assert.equal(image.status,200);assert.match(image.headers['content-type'],/^image\/png/);
      assert.equal(image.body.subarray(0,8).toString('hex'),'89504e470d0a1a0a');
      assert.equal(image.body.readUInt32BE(16)+'x'+image.body.readUInt32BE(20),icon.sizes);
    }
    const iconUrl=html.match(/rel="icon"[^>]*href="([^"]+)"/)[1],icon=await f.request(iconUrl),head=await f.request(iconUrl,{method:'HEAD'});
    assert.match(icon.headers['cache-control'],/immutable/);assert.equal(head.status,200);assert.equal(head.body.length,0);assert.equal(head.headers.etag,icon.headers.etag);
    assert.equal((await f.request(iconUrl,{headers:{'If-None-Match':icon.headers.etag}})).status,304);
  }
  const ico=await f.request('/favicon.ico');assert.equal(ico.status,200);assert.equal(ico.body.readUInt16LE(2),1);assert.equal(ico.body.readUInt16LE(4),3);
  assert.equal(f.calls.length,0,'public brand assets must not query the customer DB or dispatch collections');
});
