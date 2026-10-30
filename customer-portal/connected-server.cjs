'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { body, json } = require('../scripts/lib/insight_http.cjs');
const { fault } = require('../scripts/lib/insight_store.cjs');
const { createCompanyReadCache } = require('./company-read-cache.cjs');
const { createRegionReadCache } = require('./region-read-cache.cjs');
const { createReportReadCache } = require('./report-read-cache.cjs');
const {selection:reportSelection}=require('./report-period-projection.cjs');
const { createComparisonRegionReadCache } = require('./comparison-region-read-cache.cjs');
const { createUpstreamReader } = require('./upstream-request.cjs');
const { createPublicAssetVersions } = require('./public-asset-versions.cjs');
const { createArchiveService } = require('./archive-service.cjs');
const { createBootstrapSnapshots } = require('./bootstrap-snapshots.cjs');
const { createSavedKeywordComparison } = require('./lib/saved-keyword-comparison.cjs');
function validatedOrigin(value) {
  const u = new URL(value);
  if (u.username || u.password || u.pathname !== '/' || u.search || u.hash || /[?#]/.test(String(value)) || (u.protocol !== 'https:' && !(u.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(u.hostname)))) throw new Error('Insight origins require HTTPS or local development addresses');
  return u;
}
function publicOrigins(origin, aliases = []) {
  const canonical = validatedOrigin(origin);
  const values = typeof aliases === 'string' ? aliases.split(/[,\r\n]+/).map(value => value.trim()).filter(Boolean) : aliases;
  if (!Array.isArray(values)) throw new Error('Invalid Insight public origins');
  return [...new Set([canonical.origin, ...values.map(value => {
    const alias = validatedOrigin(value);
    if (alias.protocol !== canonical.protocol) throw new Error('Insight public origins must use the canonical protocol');
    return alias.origin;
  })])];
}
function configuration(env = process.env) {
  const origin = validatedOrigin(env.INSIGHT_PUBLIC_ORIGIN || 'http://127.0.0.1:57951');
  const backend = validatedOrigin(env.INSIGHT_DATALAB_ORIGIN || 'http://127.0.0.1:57950');
  const origins = publicOrigins(origin.origin, env.INSIGHT_PUBLIC_ORIGINS || []);
  const serviceToken = env.INSIGHT_SERVICE_TOKEN;
  if (!serviceToken || serviceToken.length < 32) throw new Error('INSIGHT_SERVICE_TOKEN must be configured');
  const port = Number(env.PORT || origin.port || 57951);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid port');
  const cacheDirectory=env.INSIGHT_REGION_CACHE_DIR || (env.DATA_DIR ? path.join(env.DATA_DIR,'insight-region-cache') : env.RENDER ? path.join('/var/data','insight-region-cache') : null);
  if(cacheDirectory&&(!path.isAbsolute(cacheDirectory)||path.resolve(cacheDirectory)===path.parse(path.resolve(cacheDirectory)).root))throw new Error('Insight regional cache requires an absolute, dedicated directory');
  const companyCacheDirectory=env.INSIGHT_COMPANY_CACHE_DIR || (env.DATA_DIR ? path.join(env.DATA_DIR,'insight-company-cache') : env.RENDER ? path.join('/var/data','insight-company-cache') : null);
  if(companyCacheDirectory&&(!path.isAbsolute(companyCacheDirectory)||path.resolve(companyCacheDirectory)===path.parse(path.resolve(companyCacheDirectory)).root))throw new Error('Insight company cache requires an absolute, dedicated directory');
  const reportCacheDirectory=env.INSIGHT_REPORT_CACHE_DIR || (env.DATA_DIR ? path.join(env.DATA_DIR,'insight-report-cache') : env.RENDER ? path.join('/var/data','insight-report-cache') : null);
  if(reportCacheDirectory&&(!path.isAbsolute(reportCacheDirectory)||path.resolve(reportCacheDirectory)===path.parse(path.resolve(reportCacheDirectory)).root))throw new Error('Insight report cache requires an absolute, dedicated directory');
  const comparisonRegionCacheDirectory=env.INSIGHT_COMPARISON_REGION_CACHE_DIR || (env.DATA_DIR ? path.join(env.DATA_DIR,'insight-comparison-region-cache') : env.RENDER ? path.join('/var/data','insight-comparison-region-cache') : null);
  if(comparisonRegionCacheDirectory&&(!path.isAbsolute(comparisonRegionCacheDirectory)||path.resolve(comparisonRegionCacheDirectory)===path.parse(path.resolve(comparisonRegionCacheDirectory)).root))throw new Error('Insight comparison regional cache requires an absolute, dedicated directory');
  const archiveRoot=env.RENDER?'/var/data':env.DATA_DIR||null;
  const archiveDirectory=env.INSIGHT_ARCHIVE_DIR||(archiveRoot?path.join(archiveRoot,'insight-archive'):null);
  if(archiveDirectory&&(!path.isAbsolute(archiveDirectory)||path.resolve(archiveDirectory)===path.parse(path.resolve(archiveDirectory)).root))throw new Error('Insight archive requires an absolute, dedicated directory');
  return { origin: origin.origin, origins, backend: backend.origin, serviceToken, port, host: env.RENDER ? '0.0.0.0' : '127.0.0.1',regionCacheDirectory:cacheDirectory,companyCacheDirectory,reportCacheDirectory,comparisonRegionCacheDirectory,archiveDirectory };
}
function createConnectedServer({ origin, origins = [], backend, serviceToken, fetchImpl = fetch, regionCacheDirectory=null,companyCacheDirectory=null,reportCacheDirectory=null,comparisonRegionCacheDirectory=null,archiveDirectory=null,savedComparisonDirectory,diagnosticsLogger,companyDiagnosticsLogger=entry=>console.warn('insight_company_read',JSON.stringify(entry)) }) {
  const trustedOrigins = new Map(publicOrigins(origin, origins).map(value => [new URL(value).host, value]));
  const archives=createArchiveService({directory:archiveDirectory,namespace:backend});
  const savedComparison=createSavedKeywordComparison({...(savedComparisonDirectory?{directory:savedComparisonDirectory}:{})});
  const companyReads = createCompanyReadCache({persistenceDirectory:companyCacheDirectory,namespace:backend,onStage:companyDiagnosticsLogger,...(archiveDirectory?{onVerifiedSource:context=>archives.capture(context)}:{})}), regionReads = createRegionReadCache({persistenceDirectory:regionCacheDirectory,namespace:backend}), scopeSecret = crypto.randomBytes(32), staticAssets = new Map();
  const reportReads = createReportReadCache({persistenceDirectory:reportCacheDirectory,namespace:backend});
  const comparisonRegionReads=createComparisonRegionReadCache({persistenceDirectory:comparisonRegionCacheDirectory,namespace:backend});
  const bootstrapSnapshots=createBootstrapSnapshots({companyReads,regionReads,reportReads:{...reportReads,snapshot:options=>reportReads.snapshot({...options,selection:{stayMode:'all_available'}})},comparisonRegionReads});
  const scopeFor = (requestOrigin, mode, session, customerId='') => crypto.createHmac('sha256', scopeSecret).update(JSON.stringify([requestOrigin,mode,session,customerId])).digest('hex');
  const viewTarget=headers=>headers?.['X-Insight-Customer-Id']||'';
  const audienceFor = (requestOrigin,mode,customerId='') => JSON.stringify([requestOrigin,mode==='admin'&&customerId?'customer':mode]);
  const invalidateReads = scope => { companyReads.invalidate(scope); regionReads.invalidate(scope); reportReads.invalidate(scope); comparisonRegionReads.invalidate(scope); };
  // Historical source recalculation can take longer than a login or command.
  // Extend only these read endpoints; collection dispatch retains its timeout.
  const readTimeout = (method, route, {background=false}={}) => background&&method==='GET'&&/\/companies\/[a-zA-Z0-9_-]+\/collection$/.test(route)?600000:method === 'GET' && /\/(?:companies\/[a-zA-Z0-9_-]+\/collection|reports\/briefing)$/.test(route) ? 180000 : 20000;
  const identityRoutes=new Set(['/me','/auth/login','/admin/me','/admin/auth/login','/admin/customer-view/me','/admin/customer-view/start']);
  function timings(){
    const started=performance.now(),values=new Map([['upstream_headers',0],['upstream_body',0],['snapshot',0]]);
    const add=(name,duration)=>{if(Number.isFinite(duration)&&duration>=0)values.set(name,(values.get(name)||0)+duration);};
    return {requestId:crypto.randomUUID(),add,central(header){
      if(typeof header!=='string'||header.length>8192)return;
      for(const item of header.split(',')){
        const [name,...parameters]=item.trim().split(';');if(!['state_catalog','state_total'].includes(name))continue;
        const duration=parameters.map(value=>/^\s*dur\s*=\s*(\d+(?:\.\d+)?)\s*$/.exec(value)).find(Boolean);
        if(duration&&Number(duration[1])<=3600000)add(name,Number(duration[1]));
      }
    },header(){return [...values,['total',performance.now()-started]].map(([name,duration])=>`${name};dur=${duration.toFixed(1)}`).join(', ');}};
  }
  const upstreamReader=createUpstreamReader({backend,fetchImpl,readTimeout,...(diagnosticsLogger?{logger:diagnosticsLogger}:{})});
  const readUpstream=(route,search,headers,options={})=>upstreamReader(route,search,headers,{stage:identityRoutes.has(route)?'identity':'source',...options});
  async function archiveRequest(mode,requestOrigin,headers,req,url,route,timing){
    const tail=mode==='admin'?route.replace(/^\/customer-view/,''):route;
    if(!/^\/archives(?:\/[a-zA-Z0-9_-]+)?$/.test(tail))return null;
    const identityRoute=mode==='admin'?'/admin/customer-view/me':'/me';
    const checked=await readUpstream(identityRoute,'',headers,{stage:'identity',timing});
    if(!checked.ok)return checked;
    const identity=checked.data,audience=audienceFor(requestOrigin,mode,viewTarget(headers)),context={identity,audience};
    archives.scope(identity,audience);
    if(req.method==='POST'){
      const expected=String(identity.csrfToken||''),received=String(req.headers['x-csrf-token']||'');
      if(!expected||expected.length>512||Buffer.byteLength(received)!==Buffer.byteLength(expected)||!crypto.timingSafeEqual(Buffer.from(expected),Buffer.from(received)))throw fault('CSRF_REQUIRED','현재 로그인 화면에서 다시 요청해 주세요.',403);
    }
    try{
      let data;
      if(req.method==='GET'&&tail==='/archives'){
        if([...url.searchParams.keys()].some(key=>!['kind','limit','offset'].includes(key))||['kind','limit','offset'].some(key=>url.searchParams.getAll(key).length>1))throw fault('ARCHIVE_INVALID_FIELDS','보관 목록 조건을 확인해 주세요.');
        data=await archives.list({...context,kind:url.searchParams.get('kind')||undefined,limit:url.searchParams.has('limit')?Number(url.searchParams.get('limit')):100,offset:url.searchParams.has('offset')?Number(url.searchParams.get('offset')):0});
      }else if(req.method==='GET'&&/^\/archives\/[a-f0-9]{64}$/.test(tail)){
        if(url.search)throw fault('ARCHIVE_INVALID_FIELDS','보관 번호만 지정해 주세요.');
        data=await archives.get({...context,id:tail.split('/')[2]});
      }else if(req.method==='POST'&&tail==='/archives/reviews'){
        if(url.search)throw fault('ARCHIVE_INVALID_FIELDS','보관 요청 항목을 확인해 주세요.');
        const input=await body(req);
        if(!input||Object.keys(input).some(key=>!['companyId','month'].includes(key))||!/^\w[\w-]{0,179}$/.test(input.companyId||'')||!/^20\d{2}-(0[1-9]|1[0-2])$/.test(input.month||''))throw fault('ARCHIVE_INVALID_FIELDS','업체와 숙박월을 확인해 주세요.');
        if(!archives.scope(identity,audience).companies.has(input.companyId))throw fault('NOT_FOUND','등록한 업체의 자료를 찾지 못했습니다.',404);
        const prefix=mode==='admin'?'/admin/customer-view':'',source=await readUpstream(prefix+'/companies/'+input.companyId+'/collection','?month='+input.month,headers,{stage:'source',timing});
        if(!source.ok)return source;
        const current=await readUpstream(identityRoute,'',headers,{stage:'identity',timing});if(!current.ok)return current;
        if(current.data.customer?.customerId!==identity.customer.customerId)throw fault('ARCHIVE_SCOPE_CHANGED','로그인 상태를 다시 확인해 주세요.',409);
        data=await archives.capture({identity:current.data,audience,companyId:input.companyId,month:input.month,data:source.data});
        if(data.status!=='stored')throw fault(data.reason||'ARCHIVE_DISABLED',data.status==='disabled'?'장기 보관 저장소 연결이 필요합니다.':'업체·기간·수집 근거를 확인한 정상 자료가 필요합니다.',409);
      }else if(req.method==='POST'&&tail==='/archives/reports'){
        if(url.search)throw fault('ARCHIVE_INVALID_FIELDS','발행 조건만 지정해 주세요.');
        data=await archives.publish({...context,input:await body(req)});
      }else throw fault('NOT_FOUND','요청한 보관 기능을 찾을 수 없습니다.',404);
      if(req.method==='GET'&&mode==='admin'&&viewTarget(headers)){
        const current=await readUpstream(identityRoute,'',headers,{stage:'identity',timing});
        if(!current.ok)return current;
        const boundary=value=>JSON.stringify([value.customer?.customerId,value.customer?.memberId,value.customer?.accountStatus,(value.customer?.relations||[]).filter(row=>['active','pending'].includes(row.status)),(value.customer?.regions||[]).filter(row=>['active','pending'].includes(row.status)),value.customer?.entitlements,[...archives.scope(value,audience).companies.keys()].sort()]);
        if(boundary(current.data)!==boundary(identity))throw fault('CUSTOMER_VIEW_SCOPE_CHANGED','고객의 등록 정보가 변경되었습니다. 다시 조회해 주세요.',409);
      }
      return {ok:true,status:200,data};
    }catch(error){if(error.statusCode)throw error;const low=error.code==='ARCHIVE_LOW_SPACE';throw fault(/^ARCHIVE_[A-Z_]+$/.test(error.code||'')?error.code:'ARCHIVE_STORAGE_FAILED',low?'보관 디스크의 여유 공간이 부족합니다. 이전 자료는 유지됩니다.':'보관 자료의 저장 또는 무결성을 확인하지 못했습니다. 이전 자료는 유지됩니다.',low?507:503);}
  }
  async function companyRead(requestOrigin, mode, session, headers, route, url, force, timing) {
    const match=/^\/(?:customer-view\/)?companies\/([a-zA-Z0-9_-]+)\/collection$/.exec(route);
    if(!match)return null;
    const prefix=mode==='admin'?'/admin':'', month=url.searchParams.get('month')||'';
    const valid=[...url.searchParams.keys()].every(key=>key==='month')&&url.searchParams.getAll('month').length<=1&&(!url.searchParams.has('month')||/^20\d{2}-(0[1-9]|1[0-2])$/.test(month));
    // Invalid input still follows the central authentication/validation path.
    if(!session||!valid)return readUpstream(prefix+route,url.search,headers,{timing});
    const savedQuery=new URLSearchParams(url.search);savedQuery.set('month',month||new Date(Date.now()+9*3600000).toISOString().slice(0,7));savedQuery.set('savedOnly','1');
    return companyReads.read({scope:scopeFor(requestOrigin,mode,session,viewTarget(headers)),audience:audienceFor(requestOrigin,mode,viewTarget(headers)),route:'/companies/'+match[1]+'/collection',companyId:match[1],month,force,requestId:timing?.requestId,
      readIdentity:()=>readUpstream(prefix+(mode==='admin'?'/customer-view/me':'/me'),'',headers,{stage:'identity',timing}),
      readSavedSource:()=>readUpstream(prefix+route,'?'+savedQuery.toString(),headers,{stage:'saved_preview',timing,timeoutMs:3000}),
      readSource:({background=false}={})=>readUpstream(prefix+route,url.search,headers,{stage:'source',timing,background})});
  }
  async function regionRead(requestOrigin, mode, session, headers, route, url, force, timing) {
    const match=/^\/(?:customer-view\/)?regions\/([a-zA-Z0-9_-]+)\/analysis$/.exec(route);
    if(!match)return null;
    const prefix=mode==='admin'?'/admin':'',month=url.searchParams.get('month')||'';
    const valid=[...url.searchParams.keys()].every(key=>key==='month')&&url.searchParams.getAll('month').length===1&&/^20\d{2}-(0[1-9]|1[0-2])$/.test(month);
    // Invalid/default-month reads keep central validation; only an exact period
    // may select a cached regional response or a bootstrap snapshot.
    if(!session||!valid)return readUpstream(prefix+route,url.search,headers,{timing});
    return regionReads.read({scope:scopeFor(requestOrigin,mode,session,viewTarget(headers)),regionKey:match[1],month,force,
      readIdentity:()=>readUpstream(prefix+(mode==='admin'?'/customer-view/me':'/me'),'',headers,{stage:'identity',timing}),
      readSource:()=>readUpstream(prefix+route,url.search,headers,{stage:'source',timing})});
  }
  async function reportRead(requestOrigin,mode,session,headers,route,url,force,timing) {
    if(!/^\/(?:customer-view\/)?reports\/briefing$/.test(route))return null;
    const prefix=mode==='admin'?'/admin':'',ownId=url.searchParams.get('ownId')||'';
    const keys=['ownId','stayMode','month','start','end'],valid=[...url.searchParams.keys()].every(key=>keys.includes(key))&&keys.every(key=>url.searchParams.getAll(key).length<=1)&&(!ownId||/^[a-zA-Z0-9_-]+$/.test(ownId));
    const selection=valid?reportSelection(Object.fromEntries(['stayMode','month','start','end'].filter(key=>url.searchParams.has(key)).map(key=>[key,url.searchParams.get(key)]))):null;
    if(!session)return readUpstream(prefix+route,url.search,headers,{timing});
    if(!valid||!selection)return {status:400,ok:false,data:{error:{code:'INVALID_REPORT_SELECTION',message:'숙박기간 조건을 확인해 주세요.'}}};
    const query=new URLSearchParams();if(ownId)query.set('ownId',ownId);for(const [key,value] of Object.entries(selection))if(value!==null)query.set(key,value);
    const savedQuery=new URLSearchParams(query);savedQuery.set('savedOnly','1');
    return reportReads.read({scope:scopeFor(requestOrigin,mode,session,viewTarget(headers)),audience:audienceFor(requestOrigin,mode,viewTarget(headers)),ownId,force,selection,
      readIdentity:()=>readUpstream(prefix+(mode==='admin'?'/customer-view/me':'/me'),'',headers,{stage:'identity',timing}),
      readSavedSource:()=>readUpstream(prefix+route,'?'+savedQuery.toString(),headers,{stage:'saved_preview',timing,timeoutMs:3000}),
      readSource:()=>readUpstream(prefix+route,'?'+query.toString(),headers,{stage:'source',timing})});
  }
  async function comparisonRegionRead(requestOrigin,mode,session,headers,route,url,force,timing) {
    if(!/^\/(?:customer-view\/)?regions\/comparison-summary$/.test(route))return null;
    const prefix=mode==='admin'?'/admin':'',ownId=url.searchParams.get('ownId')||'',month=url.searchParams.get('month')||'';
    const valid=[...url.searchParams.keys()].every(key=>['ownId','month'].includes(key))&&url.searchParams.getAll('ownId').length<=1&&url.searchParams.getAll('month').length===1&&/^20\d{2}-(0[1-9]|1[0-2])$/.test(month)&&(!ownId||/^[a-zA-Z0-9_-]{1,180}$/.test(ownId));
    if(!session||!valid)return readUpstream(prefix+route,url.search,headers,{timing});
    return comparisonRegionReads.read({scope:scopeFor(requestOrigin,mode,session,viewTarget(headers)),audience:audienceFor(requestOrigin,mode,viewTarget(headers)),ownId,month,force,
      readIdentity:()=>readUpstream(prefix+(mode==='admin'?'/customer-view/me':'/me'),'',headers,{stage:'identity',timing}),
      readSource:()=>readUpstream(prefix+route,url.search,headers,{stage:'source',timing})});
  }
  async function staticAsset(file) {
    const stat=await fs.promises.stat(file),previous=staticAssets.get(file);
    if(previous?.mtimeMs===stat.mtimeMs&&previous.size===stat.size)return previous;
    const data=await fs.promises.readFile(file),entry={data,mtimeMs:stat.mtimeMs,size:stat.size,etag:'"'+crypto.createHash('sha256').update(data).digest('base64url')+'"'};
    staticAssets.set(file,entry);return entry;
  }
  const secure = new URL(origin).protocol === 'https:';
  const cookieName = secure ? '__Host-sabun_insight_session' : 'insight_local_session';
  const cookie = (token, expire = false) => `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${expire ? 0 : 43200}${secure ? '; Secure' : ''}`;
  const adminCookieName = secure ? '__Host-sabun_insight_admin' : 'insight_local_admin';
  const adminCookie = (token, expire = false) => `${adminCookieName}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${expire ? 0 : 28800}${secure ? '; Secure' : ''}`;
  const staticMap = { '/company-flow.js':['company-flow.js','text/javascript'], '/region-history.js':['region-history.js','text/javascript'], '/analysis.js':['analysis.js','text/javascript'], '/': ['connected.html', 'text/html'], '/app': ['connected.html', 'text/html'], '/login': ['connected.html', 'text/html'], '/signup': ['connected.html', 'text/html'], '/terms': ['connected.html', 'text/html'], '/privacy': ['connected.html', 'text/html'], '/company-view.js': ['company-view.js', 'text/javascript'], '/collection.js': ['collection.js', 'text/javascript'], '/connected.js': ['connected.js', 'text/javascript'], '/styles.css': ['styles.css', 'text/css'], '/connected.css': ['connected.css', 'text/css'], '/favicon.svg': ['favicon.svg', 'image/svg+xml'] };
  staticMap['/bootstrap-read.js']=['bootstrap-read.js','text/javascript'];
  staticMap['/comparison-selection.js']=['comparison-selection.js','text/javascript'];
  staticMap['/comparison-view.js']=['comparison-view.js','text/javascript'];
  for(const name of ['comparison-saved-metrics.js','comparison-dashboard.js','comparison-dashboard-view.js','comparison-dashboard.css'])staticMap['/'+name]=[name,name.endsWith('.css')?'text/css':'text/javascript'];
  for(const name of ['customer-operating-actions.js','customer-operating-actions-view.js','customer-operating-actions.css'])staticMap['/'+name]=[name,name.endsWith('.css')?'text/css':'text/javascript'];
  staticMap['/comparison-readiness.js']=['comparison-readiness.js','text/javascript'];
  staticMap['/comparison-readiness-view.js']=['comparison-readiness-view.js','text/javascript'];
  for(const name of ['operating-strategy.js','operating-strategy-view.js','operating-strategy.css'])staticMap['/'+name]=[name,name.endsWith('.css')?'text/css':'text/javascript'];
  staticMap['/comparison.css']=['comparison.css','text/css'];
  for(const name of ['regional-context.js','regional-context-view.js','regional-context.css','home-context-view.js','home-context.css','context-workspace.js'])staticMap['/'+name]=[name,name.endsWith('.css')?'text/css':'text/javascript'];
  staticMap['/archive.js']=['archive.js','text/javascript'];
  staticMap['/saved-keyword-comparison.js']=['saved-keyword-comparison.js','text/javascript'];
  staticMap['/saved-keyword-comparison.css']=['saved-keyword-comparison.css','text/css'];
  const adminAssets = { '/admin': ['admin.html', 'text/html'], '/admin.js': ['admin.js', 'text/javascript'], '/admin.css': ['admin.css', 'text/css'] };
  const publicAssets=new Map([...Object.entries({...staticMap,...adminAssets,'/auth.js':['auth.js','text/javascript']})].filter(([,item])=>item[1]!=='text/html').map(([url,item])=>[url,{file:path.join(__dirname,'web',item[0]),type:item[1]}]));
  for(const name of ['Pretendard-Regular','Pretendard-Bold','MaruBuri-Regular'])publicAssets.set(`/fonts/${name}.otf`,{file:path.join(__dirname,'..','web','fonts',`${name}.otf`),type:'font/otf'});
  const assetVersions=createPublicAssetVersions({assets:publicAssets,readAsset:staticAsset});
  const server = http.createServer(async (req, res) => {
    const timing=timings();let observed=false;
    const respond=(status,value)=>{if(observed)res.setHeader('Server-Timing',timing.header());res.setHeader('X-Insight-Request-Id',timing.requestId);json(res,status,value);};
    res.setHeader('Cache-Control', 'private, no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    res.setHeader('Referrer-Policy', 'no-referrer'); res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    try {
      const requestOrigin = trustedOrigins.get(req.headers.host);
      if (!requestOrigin) throw fault('INVALID_HOST', '올바른 인사이트 주소로 접속해 주세요.', 403);
      const url = new URL(req.url, requestOrigin);
      if (url.origin !== requestOrigin) throw fault('INVALID_HOST', '올바른 인사이트 주소로 접속해 주세요.', 403);
      if (req.method === 'GET' && url.pathname === '/api/health') { respond(200, { status: 'ok', mode: 'connected', buildCommit: process.env.RENDER_GIT_COMMIT?.slice(0, 12) || null }); return; }
      if(savedComparison.matches(url.pathname)){
        savedComparison.frameHeaders(res);
        if(!['GET','HEAD'].includes(req.method)){res.setHeader('Allow','GET, HEAD');throw fault('METHOD_NOT_ALLOWED','저장 비교 화면은 조회만 가능합니다.',405);}
        if(req.headers['sec-fetch-site']==='cross-site')throw fault('INVALID_ORIGIN','현재 인사이트 화면에서 열어 주세요.',403);
        const cookies=String(req.headers.cookie||'').split(';').map(value=>value.trim().split('='));
        const session=cookies.find(([name])=>name===adminCookieName)?.[1]||'';
        if(!/^[A-Za-z0-9_-]{43}$/.test(session)){savedComparison.denied(req,res,cookies.some(([name])=>name===cookieName)?403:401);return;}
        // Existing central identity validation only: no company, report, collection or schedule calls.
        const checked=await readUpstream('/admin/me','',{Authorization:`Bearer ${serviceToken}`,Accept:'application/json','X-Insight-Admin-Session':session},{stage:'identity',timing});
        if(!checked.ok){if(checked.status===401)res.setHeader('Set-Cookie',adminCookie('',true));if([401,403].includes(checked.status)){savedComparison.denied(req,res,checked.status);return;}respond(checked.status,checked.data);return;}
        if(checked.data?.admin?.role!=='insight_admin'||checked.data.admin.status!=='active'||!checked.data.admin.adminId){savedComparison.denied(req,res,403);return;}
        await savedComparison.serve(req,res,url.pathname);return;
      }
      if (url.pathname.startsWith('/api/insight-admin/v1/')) {
        const route = url.pathname.slice('/api/insight-admin/v1'.length);
        const target=req.headers['x-insight-customer-id'];
        if(target!==undefined&&(typeof target!=='string'||!/^cus_[a-zA-Z0-9-]{1,180}$/.test(target)||!route.startsWith('/customer-view/')))throw fault('INVALID_CUSTOMER_VIEW','고객 화면에서 올바른 고객을 선택해 주세요.');
        const session = String(req.headers.cookie || '').split(';').map(s => s.trim().split('=')).find(([name]) => name === adminCookieName)?.[1] || '';
        const headers = { Authorization: `Bearer ${serviceToken}`, Accept: 'application/json', 'X-Insight-Admin-Session': session, 'X-CSRF-Token': req.headers['x-csrf-token'] || '',...(target!==undefined?{'X-Insight-Customer-Id':target}:{}) };
        if(target!==undefined&&req.method!=='GET'){
          if(req.headers.origin!==requestOrigin)throw fault('INVALID_ORIGIN','현재 관리자 화면에서 요청해 주세요.',403);
          const identity=await readUpstream('/admin/customer-view/me','',headers,{stage:'identity',timing});
          if(!identity.ok){if(identity.status===401)res.setHeader('Set-Cookie',adminCookie('',true));respond(identity.status,identity.data);return;}
          throw fault('CUSTOMER_VIEW_READ_ONLY','아이디별 고객 화면은 조회 전용입니다. 변경은 관리자 화면에서 처리해 주세요.',403);
        }
        observed=identityRoutes.has('/admin'+route)||req.method==='GET'&&(route==='/customer-view/config'||/^\/customer-view\/(?:companies\/[a-zA-Z0-9_-]+\/collection|regions\/[a-zA-Z0-9_-]+\/analysis|regions\/comparison-summary|reports\/briefing)$/.test(route));
        const methods = { '/me': 'GET', '/customers': 'GET', '/auth/login': 'POST', '/auth/logout': 'POST', '/customer-view/start': 'POST', '/customer-view/me': 'GET', '/customer-view/config': 'GET', '/customer-view/policies/terms': 'GET', '/customer-view/policies/privacy': 'GET', '/customer-view/commands': 'POST', '/customer-view/catalog/companies': 'GET', '/customer-view/catalog/regions': 'GET', '/recurring-collections':'GET', '/recurring-collections/review':'POST' };
        const match = /^\/customers\/cus_[a-zA-Z0-9-]+(\/commands)?$/.exec(route);
        const regionalPreparation=/^\/customer-view\/regions\/[a-zA-Z0-9_-]+\/preparation$/.test(route)&&['GET','POST'].includes(req.method);
        const archiveRoute=/^\/customer-view\/archives(?:\/[a-zA-Z0-9_-]+)?$/.test(route)&&['GET','POST'].includes(req.method);
        const recurringRoute=/^\/customer-view\/companies\/[a-zA-Z0-9_-]+\/recurring-collection$/.test(route)&&['GET','POST'].includes(req.method);
        if (!recurringRoute&&!archiveRoute&&!regionalPreparation && (methods[route] || (/^\/customer-view\/(?:companies\/[a-zA-Z0-9_-]+\/collection|regions\/[a-zA-Z0-9_-]+\/analysis|regions\/comparison-summary|reports\/briefing)$/.test(route) ? 'GET' : '') || (match ? (match[1] ? 'POST' : 'GET') : '')) !== req.method) throw fault('NOT_FOUND', '지원하지 않는 관리자 기능입니다.', 404);
        if (req.method === 'POST' && req.headers.origin !== requestOrigin) throw fault('INVALID_ORIGIN', '현재 관리자 화면에서 요청해 주세요.', 403);
        if(archiveRoute){const saved=await archiveRequest('admin',requestOrigin,headers,req,url,route,timing);if(saved.status===401)res.setHeader('Set-Cookie',adminCookie('',true));respond(saved.status,saved.data);return;}
        let payload;
        if (req.method === 'POST') { payload = JSON.stringify(await body(req)); headers['Content-Type'] = 'application/json'; }
        if(req.method==='POST'&&route!=='/customer-view/start')invalidateReads(scopeFor(requestOrigin,'admin',session,target||''));
        if(req.method==='GET') {
          const saved=await comparisonRegionRead(requestOrigin,'admin',session,headers,route,url,req.headers['x-insight-refresh']==='1',timing)||await companyRead(requestOrigin,'admin',session,headers,route,url,req.headers['x-insight-refresh']==='1',timing)||await regionRead(requestOrigin,'admin',session,headers,route,url,req.headers['x-insight-refresh']==='1',timing)||await reportRead(requestOrigin,'admin',session,headers,route,url,req.headers['x-insight-refresh']==='1',timing);
          if(saved){if(saved.status===401)res.setHeader('Set-Cookie',adminCookie('',true));respond(saved.status,saved.data);return;}
        }
        const response=await readUpstream('/admin'+route,url.search,headers,{method:req.method,body:payload,stage:identityRoutes.has('/admin'+route)?'identity':req.method==='GET'?'source':null,timing}),data=response.data;
        if(response.ok&&['/customer-view/me','/customer-view/start'].includes(route)){const started=performance.now(),scope=scopeFor(requestOrigin,'admin',session,target||'');Object.assign(data,await bootstrapSnapshots({headers:req.headers,scope,audience:audienceFor(requestOrigin,'admin',target||''),identity:data,timing}));timing.add('snapshot',performance.now()-started);}
        if(req.method==='POST'&&route!=='/customer-view/start'||[401,403].includes(response.status))invalidateReads(scopeFor(requestOrigin,'admin',session,target||''));
        if (response.ok && route === '/auth/login') {
          if (!/^[A-Za-z0-9_-]{43}$/.test(data.token || '')) throw new Error('Missing administrator session');
          res.setHeader('Set-Cookie', adminCookie(data.token)); delete data.token;
        }
        if ((response.ok && route === '/auth/logout') || response.status === 401) res.setHeader('Set-Cookie', adminCookie('', true));
        respond(response.status, data); return;
      }
      if (url.pathname.startsWith('/api/customer/v1/')) {
        if(req.headers['x-insight-customer-id']!==undefined)throw fault('INVALID_CUSTOMER_VIEW','고객별 화면 선택은 관리자 로그인 후 사용할 수 있습니다.');
        const route = url.pathname.slice('/api/customer/v1'.length);
        observed=identityRoutes.has(route)||req.method==='GET'&&(route==='/config'||/^\/(?:companies\/[a-zA-Z0-9_-]+\/collection|regions\/[a-zA-Z0-9_-]+\/analysis|regions\/comparison-summary|reports\/briefing)$/.test(route));
        const allowed = { '/config': 'GET', '/me': 'GET', '/auth/username': 'GET', '/policies/terms': 'GET', '/policies/privacy': 'GET', '/auth/login': 'POST', '/auth/signup': 'POST', '/auth/logout': 'POST', '/commands': 'POST', '/catalog/companies': 'GET', '/catalog/regions': 'GET' };
        const regionalPreparation=/^\/regions\/[a-zA-Z0-9_-]+\/preparation$/.test(route)&&['GET','POST'].includes(req.method);
        const archiveRoute=/^\/archives(?:\/[a-zA-Z0-9_-]+)?$/.test(route)&&['GET','POST'].includes(req.method);
        const recurringRoute=/^\/companies\/[a-zA-Z0-9_-]+\/recurring-collection$/.test(route)&&['GET','POST'].includes(req.method);
        if (!recurringRoute&&!archiveRoute&&!regionalPreparation && (allowed[route] || (/^\/(?:companies\/[a-zA-Z0-9_-]+\/collection|regions\/[a-zA-Z0-9_-]+\/analysis|regions\/comparison-summary|reports\/briefing)$/.test(route) ? 'GET' : '')) !== req.method) throw fault('NOT_FOUND', '요청한 기능을 찾을 수 없습니다.', 404);
        if (req.method === 'POST' && req.headers.origin !== requestOrigin) throw fault('INVALID_ORIGIN', '현재 인사이트 화면에서 요청해 주세요.', 403);
        const cookies = String(req.headers.cookie || '').split(';').map(s => s.trim().split('='));
        const session = cookies.find(([name]) => name === cookieName)?.[1] || '';
        const headers = { Authorization: `Bearer ${serviceToken}`, Accept: 'application/json', 'X-Insight-Session': session, 'X-CSRF-Token': req.headers['x-csrf-token'] || '' };
        if(archiveRoute){const saved=await archiveRequest('customer',requestOrigin,headers,req,url,route,timing);if(saved.status===401)res.setHeader('Set-Cookie',cookie('',true));respond(saved.status,saved.data);return;}
        let payload;
        if (req.method === 'POST') { payload = JSON.stringify(await body(req)); headers['Content-Type'] = 'application/json'; }
        if(req.method==='POST')invalidateReads(scopeFor(requestOrigin,'customer',session));
        if(req.method==='GET') {
          const saved=await comparisonRegionRead(requestOrigin,'customer',session,headers,route,url,req.headers['x-insight-refresh']==='1',timing)||await companyRead(requestOrigin,'customer',session,headers,route,url,req.headers['x-insight-refresh']==='1',timing)||await regionRead(requestOrigin,'customer',session,headers,route,url,req.headers['x-insight-refresh']==='1',timing)||await reportRead(requestOrigin,'customer',session,headers,route,url,req.headers['x-insight-refresh']==='1',timing);
          if(saved){if(saved.status===401)res.setHeader('Set-Cookie',cookie('',true));respond(saved.status,saved.data);return;}
        }
        const response=await readUpstream(route,url.search,headers,{method:req.method,body:payload,stage:identityRoutes.has(route)?'identity':req.method==='GET'?'source':null,timing}),data=response.data;
        if(response.ok&&req.method==='GET'&&route==='/me'){const started=performance.now(),scope=scopeFor(requestOrigin,'customer',session);Object.assign(data,await bootstrapSnapshots({headers:req.headers,scope,audience:audienceFor(requestOrigin,'customer'),identity:data,timing}));timing.add('snapshot',performance.now()-started);}
        if(req.method==='POST'||[401,403].includes(response.status))invalidateReads(scopeFor(requestOrigin,'customer',session));
        if (response.ok && ['/auth/login', '/auth/signup'].includes(route)) {
          if (!/^[A-Za-z0-9_-]{43}$/.test(data.token || '')) throw new Error('Missing session');
          res.setHeader('Set-Cookie', cookie(data.token)); delete data.token;
        }
        if ((route === '/auth/logout' && response.ok) || response.status === 401) res.setHeader('Set-Cookie', cookie('', true));
        respond(response.status, data); return;
      }
      if (!['GET', 'HEAD'].includes(req.method)) throw fault('NOT_FOUND', '요청한 화면을 찾을 수 없습니다.', 404);
      let item = adminAssets[url.pathname] || (url.pathname === '/customer-view' ? staticMap['/app'] : url.pathname === '/auth.js' ? ['auth.js', 'text/javascript'] : staticMap[url.pathname]); let file;
      if (item) file = path.join(__dirname, 'web', item[0]);
      else if (/^\/fonts\/(Pretendard-Regular|Pretendard-Bold|MaruBuri-Regular)\.otf$/.test(url.pathname)) { file = path.join(__dirname, '..', 'web', 'fonts', path.basename(url.pathname)); item = ['', 'font/otf']; }
      else throw fault('NOT_FOUND', '요청한 화면을 찾을 수 없습니다.', 404);
      const asset=item[1]==='text/html'?await staticAsset(file):await assetVersions.get(url.pathname),data=item[1]==='text/html'?await assetVersions.html(asset.data):asset.data;
      if(item[1]!=='text/html'){
        res.setHeader('Cache-Control',assetVersions.immutable(url,asset)?'public, max-age=31536000, immutable':'private, no-cache');res.setHeader('ETag',asset.etag);
        if(String(req.headers['if-none-match']||'').split(',').some(value=>value.trim()==='*'||value.trim().replace(/^W\//,'')===asset.etag)){
          res.writeHead(304);res.end();return;
        }
      }
      res.writeHead(200, { 'Content-Type': `${item[1]}; charset=utf-8`, 'Content-Length': data.length }); res.end(req.method === 'HEAD' ? undefined : data);
    } catch (error) {
      if (res.headersSent) { res.destroy(); return; }
      respond(error.statusCode || 503, { error: { code: error.code && error.statusCode ? error.code : 'CONNECTION_UNAVAILABLE', message: error.statusCode ? error.message : '데이터랩 연결을 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.' } });
    }
  });
  server.requestTimeout = 30000; server.headersTimeout = 10000;
  server.prepareRegionSnapshots=async()=>{await regionReads.ready();return regionReads.persistenceStatus();};
  server.flushRegionSnapshots=()=>regionReads.flushPersistence();
  server.prepareCompanySnapshots=async()=>{await companyReads.ready();return companyReads.persistenceStatus();};
  server.flushCompanySnapshots=()=>companyReads.flushPersistence();
  server.prepareReportSnapshots=async()=>{await reportReads.ready();return reportReads.persistenceStatus();};
  server.flushReportSnapshots=()=>reportReads.flushPersistence();
  server.prepareComparisonRegionSnapshots=async()=>{await comparisonRegionReads.ready();return comparisonRegionReads.persistenceStatus();};
  server.flushComparisonRegionSnapshots=()=>comparisonRegionReads.flushPersistence();
  server.prepareArchives=async()=>{await archives.ready();return archives.status();};
  server.flushArchives=()=>archives.flush();
  return server;
}
if (require.main === module) {
  (async()=>{
    try { const c=configuration(),server=createConnectedServer(c);const [regionStatus,companyStatus,reportStatus,comparisonRegionStatus,archiveStatus]=await Promise.all([server.prepareRegionSnapshots(),server.prepareCompanySnapshots(),server.prepareReportSnapshots(),server.prepareComparisonRegionSnapshots(),server.prepareArchives()]);console.log('regional_snapshot_cache_prepared',JSON.stringify(regionStatus));console.log('company_snapshot_cache_prepared',JSON.stringify(companyStatus));console.log('report_snapshot_cache_prepared',JSON.stringify(reportStatus));console.log('comparison_region_snapshot_cache_prepared',JSON.stringify(comparisonRegionStatus));console.log('long_term_archive_prepared',JSON.stringify(archiveStatus));server.listen(c.port,c.host,()=>console.log(`SABUN INSIGHT 연결 서버: ${c.origin}`)); }
    catch(error){console.error(error.message);process.exitCode=1;}
  })();
}
module.exports = { configuration, createConnectedServer };
