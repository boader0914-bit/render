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
  return { origin: origin.origin, origins, backend: backend.origin, serviceToken, port, host: env.RENDER ? '0.0.0.0' : '127.0.0.1',regionCacheDirectory:cacheDirectory,companyCacheDirectory,reportCacheDirectory };
}
function createConnectedServer({ origin, origins = [], backend, serviceToken, fetchImpl = fetch, regionCacheDirectory=null,companyCacheDirectory=null,reportCacheDirectory=null }) {
  const trustedOrigins = new Map(publicOrigins(origin, origins).map(value => [new URL(value).host, value]));
  const companyReads = createCompanyReadCache({persistenceDirectory:companyCacheDirectory,namespace:backend}), regionReads = createRegionReadCache({persistenceDirectory:regionCacheDirectory,namespace:backend}), scopeSecret = crypto.randomBytes(32), staticAssets = new Map();
  const reportReads = createReportReadCache({persistenceDirectory:reportCacheDirectory,namespace:backend});
  const scopeFor = (requestOrigin, mode, session) => crypto.createHmac('sha256', scopeSecret).update(JSON.stringify([requestOrigin,mode,session])).digest('hex');
  const audienceFor = (requestOrigin,mode) => JSON.stringify([requestOrigin,mode]);
  const invalidateReads = scope => { companyReads.invalidate(scope); regionReads.invalidate(scope); reportReads.invalidate(scope); };
  // Historical source recalculation can take longer than a login or command.
  // Extend only these read endpoints; collection dispatch retains its timeout.
  const readTimeout = (method, route) => method === 'GET' && /\/(?:companies\/[a-zA-Z0-9_-]+\/collection|reports\/briefing)$/.test(route) ? 180000 : 20000;
  const identityRoutes=new Set(['/me','/auth/login','/admin/me','/admin/auth/login','/admin/customer-view/me','/admin/customer-view/start']);
  function timings(){
    const started=performance.now(),values=new Map([['upstream_headers',0],['upstream_body',0],['snapshot',0]]);
    const add=(name,duration)=>{if(Number.isFinite(duration)&&duration>=0)values.set(name,(values.get(name)||0)+duration);};
    return {add,central(header){
      if(typeof header!=='string'||header.length>8192)return;
      for(const item of header.split(',')){
        const [name,...parameters]=item.trim().split(';');if(!['state_catalog','state_total'].includes(name))continue;
        const duration=parameters.map(value=>/^\s*dur\s*=\s*(\d+(?:\.\d+)?)\s*$/.exec(value)).find(Boolean);
        if(duration&&Number(duration[1])<=3600000)add(name,Number(duration[1]));
      }
    },header(){return [...values,['total',performance.now()-started]].map(([name,duration])=>`${name};dur=${duration.toFixed(1)}`).join(', ');}};
  }
  async function readUpstream(route, search, headers, {method='GET',body,stage=identityRoutes.has(route)?'identity':'source',timing}={}) {
    const signal=AbortSignal.timeout(readTimeout(method,route));let phase='upstream_headers',started=performance.now();
    try{
      const response=await fetchImpl(`${backend}/api/insight/v1${route}${search}`,{method,headers,body,redirect:'error',signal});
      timing?.add(phase,performance.now()-started);phase='upstream_body';started=performance.now();
      timing?.central(response.headers?.get?.('server-timing'));
      const data=await response.json();timing?.add(phase,performance.now()-started);phase=null;
      return {status:response.status,ok:response.ok,data};
    }catch(error){
      if(phase)timing?.add(phase,performance.now()-started);
      if(stage&&(error?.name==='TimeoutError'||signal.aborted&&signal.reason?.name==='TimeoutError'))return {status:504,ok:false,data:{error:{code:'UPSTREAM_TIMEOUT',stage,message:stage==='identity'?'로그인 확인이 지연되어 연결하지 못했습니다. 잠시 후 다시 열어 주세요.':'자료 조회가 지연되어 연결하지 못했습니다. 잠시 후 다시 열어 주세요.'}}};
      throw error;
    }
  }
  async function companyRead(requestOrigin, mode, session, headers, route, url, force, timing) {
    const match=/^\/(?:customer-view\/)?companies\/([a-zA-Z0-9_-]+)\/collection$/.exec(route);
    if(!match)return null;
    const prefix=mode==='admin'?'/admin':'', month=url.searchParams.get('month')||'';
    const valid=[...url.searchParams.keys()].every(key=>key==='month')&&url.searchParams.getAll('month').length<=1&&(!url.searchParams.has('month')||/^20\d{2}-(0[1-9]|1[0-2])$/.test(month));
    // Invalid input still follows the central authentication/validation path.
    if(!session||!valid)return readUpstream(prefix+route,url.search,headers,{timing});
    return companyReads.read({scope:scopeFor(requestOrigin,mode,session),audience:audienceFor(requestOrigin,mode),route:'/companies/'+match[1]+'/collection',companyId:match[1],month,force,
      readIdentity:()=>readUpstream(prefix+(mode==='admin'?'/customer-view/me':'/me'),'',headers,{stage:'identity',timing}),
      readSource:()=>readUpstream(prefix+route,url.search,headers,{stage:'source',timing})});
  }
  async function regionRead(requestOrigin, mode, session, headers, route, url, force, timing) {
    const match=/^\/(?:customer-view\/)?regions\/([a-zA-Z0-9_-]+)\/analysis$/.exec(route);
    if(!match)return null;
    const prefix=mode==='admin'?'/admin':'',month=url.searchParams.get('month')||'';
    const valid=[...url.searchParams.keys()].every(key=>key==='month')&&url.searchParams.getAll('month').length===1&&/^20\d{2}-(0[1-9]|1[0-2])$/.test(month);
    // Invalid/default-month reads keep central validation; only an exact period
    // may select a cached regional response or a bootstrap snapshot.
    if(!session||!valid)return readUpstream(prefix+route,url.search,headers,{timing});
    return regionReads.read({scope:scopeFor(requestOrigin,mode,session),regionKey:match[1],month,force,
      readIdentity:()=>readUpstream(prefix+(mode==='admin'?'/customer-view/me':'/me'),'',headers,{stage:'identity',timing}),
      readSource:()=>readUpstream(prefix+route,url.search,headers,{stage:'source',timing})});
  }
  async function reportRead(requestOrigin,mode,session,headers,route,url,force,timing) {
    if(!/^\/(?:customer-view\/)?reports\/briefing$/.test(route))return null;
    const prefix=mode==='admin'?'/admin':'',ownId=url.searchParams.get('ownId')||'';
    const valid=[...url.searchParams.keys()].every(key=>key==='ownId')&&url.searchParams.getAll('ownId').length<=1&&(!ownId||/^[a-zA-Z0-9_-]+$/.test(ownId));
    if(!session||!valid)return readUpstream(prefix+route,url.search,headers,{timing});
    return reportReads.read({scope:scopeFor(requestOrigin,mode,session),audience:audienceFor(requestOrigin,mode),ownId,force,
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
  const server = http.createServer(async (req, res) => {
    const timing=timings();let observed=false;
    const respond=(status,value)=>{if(observed)res.setHeader('Server-Timing',timing.header());json(res,status,value);};
    res.setHeader('Cache-Control', 'private, no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    res.setHeader('Referrer-Policy', 'no-referrer'); res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    try {
      const requestOrigin = trustedOrigins.get(req.headers.host);
      if (!requestOrigin) throw fault('INVALID_HOST', '올바른 인사이트 주소로 접속해 주세요.', 403);
      const url = new URL(req.url, requestOrigin);
      if (url.origin !== requestOrigin) throw fault('INVALID_HOST', '올바른 인사이트 주소로 접속해 주세요.', 403);
      if (req.method === 'GET' && url.pathname === '/api/health') { respond(200, { status: 'ok', mode: 'connected', buildCommit: process.env.RENDER_GIT_COMMIT?.slice(0, 12) || null }); return; }
      if (url.pathname.startsWith('/api/insight-admin/v1/')) {
        const route = url.pathname.slice('/api/insight-admin/v1'.length);
        observed=identityRoutes.has('/admin'+route)||req.method==='GET'&&/^\/customer-view\/(?:companies\/[a-zA-Z0-9_-]+\/collection|regions\/[a-zA-Z0-9_-]+\/analysis|reports\/briefing)$/.test(route);
        const methods = { '/me': 'GET', '/customers': 'GET', '/auth/login': 'POST', '/auth/logout': 'POST', '/customer-view/start': 'POST', '/customer-view/me': 'GET', '/customer-view/config': 'GET', '/customer-view/policies/terms': 'GET', '/customer-view/policies/privacy': 'GET', '/customer-view/commands': 'POST', '/customer-view/catalog/companies': 'GET', '/customer-view/catalog/regions': 'GET' };
        const match = /^\/customers\/cus_[a-zA-Z0-9-]+(\/commands)?$/.exec(route);
        const regionalPreparation=/^\/customer-view\/regions\/[a-zA-Z0-9_-]+\/preparation$/.test(route)&&['GET','POST'].includes(req.method);
        if (!regionalPreparation && (methods[route] || (/^\/customer-view\/(?:companies\/[a-zA-Z0-9_-]+\/collection|regions\/[a-zA-Z0-9_-]+\/analysis|reports\/briefing)$/.test(route) ? 'GET' : '') || (match ? (match[1] ? 'POST' : 'GET') : '')) !== req.method) throw fault('NOT_FOUND', '지원하지 않는 관리자 기능입니다.', 404);
        if (req.method === 'POST' && req.headers.origin !== requestOrigin) throw fault('INVALID_ORIGIN', '현재 관리자 화면에서 요청해 주세요.', 403);
        const session = String(req.headers.cookie || '').split(';').map(s => s.trim().split('=')).find(([name]) => name === adminCookieName)?.[1] || '';
        const headers = { Authorization: `Bearer ${serviceToken}`, Accept: 'application/json', 'X-Insight-Admin-Session': session, 'X-CSRF-Token': req.headers['x-csrf-token'] || '' };
        let payload;
        if (req.method === 'POST') { payload = JSON.stringify(await body(req)); headers['Content-Type'] = 'application/json'; }
        if(req.method==='POST'&&route!=='/customer-view/start')invalidateReads(scopeFor(requestOrigin,'admin',session));
        if(req.method==='GET') {
          const saved=await companyRead(requestOrigin,'admin',session,headers,route,url,req.headers['x-insight-refresh']==='1',timing)||await regionRead(requestOrigin,'admin',session,headers,route,url,req.headers['x-insight-refresh']==='1',timing)||await reportRead(requestOrigin,'admin',session,headers,route,url,req.headers['x-insight-refresh']==='1',timing);
          if(saved){if(saved.status===401)res.setHeader('Set-Cookie',adminCookie('',true));respond(saved.status,saved.data);return;}
        }
        const response=await readUpstream('/admin'+route,url.search,headers,{method:req.method,body:payload,stage:identityRoutes.has('/admin'+route)?'identity':req.method==='GET'?'source':null,timing}),data=response.data;
        if(response.ok&&['/customer-view/me','/customer-view/start'].includes(route)){const started=performance.now(),scope=scopeFor(requestOrigin,'admin',session);[data.companyViews,data.regionViews,data.reportViews]=await Promise.all([companyReads.snapshot({scope,audience:audienceFor(requestOrigin,'admin'),identity:data}),regionReads.snapshot({scope,identity:data}),reportReads.snapshot({scope,audience:audienceFor(requestOrigin,'admin'),identity:data})]);timing.add('snapshot',performance.now()-started);}
        if(req.method==='POST'&&route!=='/customer-view/start'||[401,403].includes(response.status))invalidateReads(scopeFor(requestOrigin,'admin',session));
        if (response.ok && route === '/auth/login') {
          if (!/^[A-Za-z0-9_-]{43}$/.test(data.token || '')) throw new Error('Missing administrator session');
          res.setHeader('Set-Cookie', adminCookie(data.token)); delete data.token;
        }
        if ((response.ok && route === '/auth/logout') || response.status === 401) res.setHeader('Set-Cookie', adminCookie('', true));
        respond(response.status, data); return;
      }
      if (url.pathname.startsWith('/api/customer/v1/')) {
        const route = url.pathname.slice('/api/customer/v1'.length);
        observed=identityRoutes.has(route)||req.method==='GET'&&/^\/(?:companies\/[a-zA-Z0-9_-]+\/collection|regions\/[a-zA-Z0-9_-]+\/analysis|reports\/briefing)$/.test(route);
        const allowed = { '/config': 'GET', '/me': 'GET', '/auth/username': 'GET', '/policies/terms': 'GET', '/policies/privacy': 'GET', '/auth/login': 'POST', '/auth/signup': 'POST', '/auth/logout': 'POST', '/commands': 'POST', '/catalog/companies': 'GET', '/catalog/regions': 'GET' };
        const regionalPreparation=/^\/regions\/[a-zA-Z0-9_-]+\/preparation$/.test(route)&&['GET','POST'].includes(req.method);
        if (!regionalPreparation && (allowed[route] || (/^\/(?:companies\/[a-zA-Z0-9_-]+\/collection|regions\/[a-zA-Z0-9_-]+\/analysis|reports\/briefing)$/.test(route) ? 'GET' : '')) !== req.method) throw fault('NOT_FOUND', '요청한 기능을 찾을 수 없습니다.', 404);
        if (req.method === 'POST' && req.headers.origin !== requestOrigin) throw fault('INVALID_ORIGIN', '현재 인사이트 화면에서 요청해 주세요.', 403);
        const cookies = String(req.headers.cookie || '').split(';').map(s => s.trim().split('='));
        const session = cookies.find(([name]) => name === cookieName)?.[1] || '';
        const headers = { Authorization: `Bearer ${serviceToken}`, Accept: 'application/json', 'X-Insight-Session': session, 'X-CSRF-Token': req.headers['x-csrf-token'] || '' };
        let payload;
        if (req.method === 'POST') { payload = JSON.stringify(await body(req)); headers['Content-Type'] = 'application/json'; }
        if(req.method==='POST')invalidateReads(scopeFor(requestOrigin,'customer',session));
        if(req.method==='GET') {
          const saved=await companyRead(requestOrigin,'customer',session,headers,route,url,req.headers['x-insight-refresh']==='1',timing)||await regionRead(requestOrigin,'customer',session,headers,route,url,req.headers['x-insight-refresh']==='1',timing)||await reportRead(requestOrigin,'customer',session,headers,route,url,req.headers['x-insight-refresh']==='1',timing);
          if(saved){if(saved.status===401)res.setHeader('Set-Cookie',cookie('',true));respond(saved.status,saved.data);return;}
        }
        const response=await readUpstream(route,url.search,headers,{method:req.method,body:payload,stage:identityRoutes.has(route)?'identity':req.method==='GET'?'source':null,timing}),data=response.data;
        if(response.ok&&req.method==='GET'&&route==='/me'){const started=performance.now(),scope=scopeFor(requestOrigin,'customer',session);[data.companyViews,data.regionViews,data.reportViews]=await Promise.all([companyReads.snapshot({scope,audience:audienceFor(requestOrigin,'customer'),identity:data}),regionReads.snapshot({scope,identity:data}),reportReads.snapshot({scope,audience:audienceFor(requestOrigin,'customer'),identity:data})]);timing.add('snapshot',performance.now()-started);}
        if(req.method==='POST'||[401,403].includes(response.status))invalidateReads(scopeFor(requestOrigin,'customer',session));
        if (response.ok && ['/auth/login', '/auth/signup'].includes(route)) {
          if (!/^[A-Za-z0-9_-]{43}$/.test(data.token || '')) throw new Error('Missing session');
          res.setHeader('Set-Cookie', cookie(data.token)); delete data.token;
        }
        if ((route === '/auth/logout' && response.ok) || response.status === 401) res.setHeader('Set-Cookie', cookie('', true));
        respond(response.status, data); return;
      }
      if (!['GET', 'HEAD'].includes(req.method)) throw fault('NOT_FOUND', '요청한 화면을 찾을 수 없습니다.', 404);
      const adminAssets = { '/admin': ['admin.html', 'text/html'], '/admin.js': ['admin.js', 'text/javascript'], '/admin.css': ['admin.css', 'text/css'] };
      let item = adminAssets[url.pathname] || (url.pathname === '/customer-view' ? staticMap['/app'] : url.pathname === '/auth.js' ? ['auth.js', 'text/javascript'] : staticMap[url.pathname]); let file;
      if (item) file = path.join(__dirname, 'web', item[0]);
      else if (/^\/fonts\/(Pretendard-Regular|Pretendard-Bold|MaruBuri-Regular)\.otf$/.test(url.pathname)) { file = path.join(__dirname, '..', 'web', 'fonts', path.basename(url.pathname)); item = ['', 'font/otf']; }
      else throw fault('NOT_FOUND', '요청한 화면을 찾을 수 없습니다.', 404);
      const asset=await staticAsset(file),data=asset.data;
      if(item[1]!=='text/html'){
        res.setHeader('Cache-Control','private, no-cache');res.setHeader('ETag',asset.etag);
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
  return server;
}
if (require.main === module) {
  (async()=>{
    try { const c=configuration(),server=createConnectedServer(c);const [regionStatus,companyStatus,reportStatus]=await Promise.all([server.prepareRegionSnapshots(),server.prepareCompanySnapshots(),server.prepareReportSnapshots()]);console.log('regional_snapshot_cache_prepared',JSON.stringify(regionStatus));console.log('company_snapshot_cache_prepared',JSON.stringify(companyStatus));console.log('report_snapshot_cache_prepared',JSON.stringify(reportStatus));server.listen(c.port,c.host,()=>console.log(`SABUN INSIGHT 연결 서버: ${c.origin}`)); }
    catch(error){console.error(error.message);process.exitCode=1;}
  })();
}
module.exports = { configuration, createConnectedServer };
