'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { body, json } = require('../scripts/lib/insight_http.cjs');
const { fault } = require('../scripts/lib/insight_store.cjs');
function configuration(env = process.env) {
  const origin = new URL(env.INSIGHT_PUBLIC_ORIGIN || 'http://127.0.0.1:57951');
  const backend = new URL(env.INSIGHT_DATALAB_ORIGIN || 'http://127.0.0.1:57950');
  for (const u of [origin, backend]) if (u.username || u.password || u.pathname !== '/' || u.search || u.hash || (u.protocol !== 'https:' && !(u.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(u.hostname)))) throw new Error('Insight origins require HTTPS or local development addresses');
  const serviceToken = env.INSIGHT_SERVICE_TOKEN;
  if (!serviceToken || serviceToken.length < 32) throw new Error('INSIGHT_SERVICE_TOKEN must be configured');
  const port = Number(env.PORT || origin.port || 57951);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid port');
  return { origin: origin.origin, backend: backend.origin, serviceToken, port, host: env.RENDER ? '0.0.0.0' : '127.0.0.1' };
}
function createConnectedServer({ origin, backend, serviceToken, fetchImpl = fetch }) {
  // Historical source recalculation can take longer than a login or command.
  // Extend only these read endpoints; collection dispatch retains its timeout.
  const readTimeout = (method, route) => method === 'GET' && /\/(?:companies\/[a-zA-Z0-9_-]+\/collection|reports\/briefing)$/.test(route) ? 180000 : 20000;
  const secure = new URL(origin).protocol === 'https:';
  const cookieName = secure ? '__Host-sabun_insight_session' : 'insight_local_session';
  const cookie = (token, expire = false) => `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${expire ? 0 : 43200}${secure ? '; Secure' : ''}`;
  const adminCookieName = secure ? '__Host-sabun_insight_admin' : 'insight_local_admin';
  const adminCookie = (token, expire = false) => `${adminCookieName}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${expire ? 0 : 28800}${secure ? '; Secure' : ''}`;
  const staticMap = { '/analysis.js':['analysis.js','text/javascript'], '/': ['connected.html', 'text/html'], '/app': ['connected.html', 'text/html'], '/login': ['connected.html', 'text/html'], '/signup': ['connected.html', 'text/html'], '/terms': ['connected.html', 'text/html'], '/privacy': ['connected.html', 'text/html'], '/company-view.js': ['company-view.js', 'text/javascript'], '/collection.js': ['collection.js', 'text/javascript'], '/connected.js': ['connected.js', 'text/javascript'], '/styles.css': ['styles.css', 'text/css'], '/connected.css': ['connected.css', 'text/css'], '/favicon.svg': ['favicon.svg', 'image/svg+xml'] };
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'private, no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    res.setHeader('Referrer-Policy', 'no-referrer'); res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    try {
      const url = new URL(req.url, origin);
      if (req.headers.host !== new URL(origin).host || url.origin !== origin) throw fault('INVALID_HOST', '올바른 인사이트 주소로 접속해 주세요.', 403);
      if (req.method === 'GET' && url.pathname === '/api/health') { json(res, 200, { status: 'ok', mode: 'connected', buildCommit: process.env.RENDER_GIT_COMMIT?.slice(0, 12) || null }); return; }
      if (url.pathname.startsWith('/api/insight-admin/v1/')) {
        const route = url.pathname.slice('/api/insight-admin/v1'.length);
        const methods = { '/me': 'GET', '/customers': 'GET', '/auth/login': 'POST', '/auth/logout': 'POST', '/customer-view/start': 'POST', '/customer-view/me': 'GET', '/customer-view/config': 'GET', '/customer-view/policies/terms': 'GET', '/customer-view/policies/privacy': 'GET', '/customer-view/commands': 'POST', '/customer-view/catalog/companies': 'GET', '/customer-view/catalog/regions': 'GET' };
        const match = /^\/customers\/cus_[a-zA-Z0-9-]+(\/commands)?$/.exec(route);
        if ((methods[route] || (/^\/customer-view\/(?:companies\/[a-zA-Z0-9_-]+\/collection|regions\/[a-zA-Z0-9_-]+\/analysis|reports\/briefing)$/.test(route) ? 'GET' : '') || (match ? (match[1] ? 'POST' : 'GET') : '')) !== req.method) throw fault('NOT_FOUND', '지원하지 않는 관리자 기능입니다.', 404);
        if (req.method === 'POST' && req.headers.origin !== origin) throw fault('INVALID_ORIGIN', '현재 관리자 화면에서 요청해 주세요.', 403);
        const session = String(req.headers.cookie || '').split(';').map(s => s.trim().split('=')).find(([name]) => name === adminCookieName)?.[1] || '';
        const headers = { Authorization: `Bearer ${serviceToken}`, Accept: 'application/json', 'X-Insight-Admin-Session': session, 'X-CSRF-Token': req.headers['x-csrf-token'] || '' };
        let payload;
        if (req.method === 'POST') { payload = JSON.stringify(await body(req)); headers['Content-Type'] = 'application/json'; }
        const response = await fetchImpl(`${backend}/api/insight/v1/admin${route}${url.search}`, { method: req.method, headers, body: payload, redirect: 'error', signal: AbortSignal.timeout(readTimeout(req.method,route)) });
        const data = await response.json();
        if (response.ok && route === '/auth/login') {
          if (!/^[A-Za-z0-9_-]{43}$/.test(data.token || '')) throw new Error('Missing administrator session');
          res.setHeader('Set-Cookie', adminCookie(data.token)); delete data.token;
        }
        if ((response.ok && route === '/auth/logout') || response.status === 401) res.setHeader('Set-Cookie', adminCookie('', true));
        json(res, response.status, data); return;
      }
      if (url.pathname.startsWith('/api/customer/v1/')) {
        const route = url.pathname.slice('/api/customer/v1'.length);
        const allowed = { '/config': 'GET', '/me': 'GET', '/auth/username': 'GET', '/policies/terms': 'GET', '/policies/privacy': 'GET', '/auth/login': 'POST', '/auth/signup': 'POST', '/auth/logout': 'POST', '/commands': 'POST', '/catalog/companies': 'GET', '/catalog/regions': 'GET' };
        if ((allowed[route] || (/^\/(?:companies\/[a-zA-Z0-9_-]+\/collection|regions\/[a-zA-Z0-9_-]+\/analysis|reports\/briefing)$/.test(route) ? 'GET' : '')) !== req.method) throw fault('NOT_FOUND', '요청한 기능을 찾을 수 없습니다.', 404);
        if (req.method === 'POST' && req.headers.origin !== origin) throw fault('INVALID_ORIGIN', '현재 인사이트 화면에서 요청해 주세요.', 403);
        const cookies = String(req.headers.cookie || '').split(';').map(s => s.trim().split('='));
        const session = cookies.find(([name]) => name === cookieName)?.[1] || '';
        const headers = { Authorization: `Bearer ${serviceToken}`, Accept: 'application/json', 'X-Insight-Session': session, 'X-CSRF-Token': req.headers['x-csrf-token'] || '' };
        let payload;
        if (req.method === 'POST') { payload = JSON.stringify(await body(req)); headers['Content-Type'] = 'application/json'; }
        const response = await fetchImpl(`${backend}/api/insight/v1${route}${url.search}`, { method: req.method, headers, body: payload, redirect: 'error', signal: AbortSignal.timeout(readTimeout(req.method,route)) });
        const data = await response.json();
        if (response.ok && ['/auth/login', '/auth/signup'].includes(route)) {
          if (!/^[A-Za-z0-9_-]{43}$/.test(data.token || '')) throw new Error('Missing session');
          res.setHeader('Set-Cookie', cookie(data.token)); delete data.token;
        }
        if ((route === '/auth/logout' && response.ok) || response.status === 401) res.setHeader('Set-Cookie', cookie('', true));
        json(res, response.status, data); return;
      }
      if (!['GET', 'HEAD'].includes(req.method)) throw fault('NOT_FOUND', '요청한 화면을 찾을 수 없습니다.', 404);
      const adminAssets = { '/admin': ['admin.html', 'text/html'], '/admin.js': ['admin.js', 'text/javascript'], '/admin.css': ['admin.css', 'text/css'] };
      let item = adminAssets[url.pathname] || (url.pathname === '/customer-view' ? staticMap['/app'] : url.pathname === '/auth.js' ? ['auth.js', 'text/javascript'] : staticMap[url.pathname]); let file;
      if (item) file = path.join(__dirname, 'web', item[0]);
      else if (/^\/fonts\/(Pretendard-Regular|Pretendard-Bold|MaruBuri-Regular)\.otf$/.test(url.pathname)) { file = path.join(__dirname, '..', 'web', 'fonts', path.basename(url.pathname)); item = ['', 'font/otf']; }
      else throw fault('NOT_FOUND', '요청한 화면을 찾을 수 없습니다.', 404);
      const data = await fs.promises.readFile(file);
      res.writeHead(200, { 'Content-Type': `${item[1]}; charset=utf-8`, 'Content-Length': data.length }); res.end(req.method === 'HEAD' ? undefined : data);
    } catch (error) {
      if (res.headersSent) { res.destroy(); return; }
      json(res, error.statusCode || 503, { error: { code: error.code && error.statusCode ? error.code : 'CONNECTION_UNAVAILABLE', message: error.statusCode ? error.message : '데이터랩 연결을 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.' } });
    }
  });
  server.requestTimeout = 30000; server.headersTimeout = 10000;
  return server;
}
if (require.main === module) {
  try { const c = configuration(); createConnectedServer(c).listen(c.port, c.host, () => console.log(`SABUN INSIGHT 연결 서버: ${c.origin}`)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { configuration, createConnectedServer };
