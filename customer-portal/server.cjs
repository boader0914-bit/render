'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { createPreviewStore, PreviewError } = require('./lib/preview-store.cjs');
const { createPreviewSessions } = require('./lib/preview-sessions.cjs');

const MAX_BODY = 16 * 1024;
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);
const FONT_NAMES = new Set(['Pretendard-Regular.otf', 'Pretendard-Bold.otf', 'MaruBuri-Regular.otf']);
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.otf': 'font/otf', '.woff2': 'font/woff2', '.ico': 'image/x-icon' };

function previewConfiguration(env = process.env, argv = process.argv.slice(2)) {
  const hosted = env.INSIGHT_HOSTED_PREVIEW === '1';
  if (env.NODE_ENV === 'production' && !hosted) throw new Error('production 환경의 예시 배포는 INSIGHT_HOSTED_PREVIEW=1을 명시해야 합니다.');
  if (env.INSIGHT_PREVIEW !== '1' && !argv.includes('--preview')) throw new Error('INSIGHT_PREVIEW=1 또는 --preview로 예시 미리보기를 명시해 주세요.');
  const port = env.PORT === undefined ? 57831 : Number(env.PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT는 1~65535 사이여야 합니다.');
  if (!hosted) return { host: '127.0.0.1', port };
  const renderHost = String(env.RENDER_EXTERNAL_HOSTNAME || '').toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]*\.onrender\.com$/.test(renderHost)) throw new Error('호스팅 검수는 Render 서비스 주소가 필요합니다.');
  return { host: '0.0.0.0', port, hosted: true, allowedHosts: [renderHost, 'insight.sabun.co.kr'], buildCommit: /^[a-f0-9]{40}$/.test(env.RENDER_GIT_COMMIT || '') ? env.RENDER_GIT_COMMIT : null };
}

function json(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
}
function requestUrl(req, allowedHosts) {
  if (!req.headers.host) throw new PreviewError('forbidden_origin', '로컬 미리보기 주소로 접속해 주세요.', 403);
  let base;
  try { base = new URL(`${allowedHosts ? 'https' : 'http'}://${req.headers.host}`); } catch { throw new PreviewError('forbidden_origin', '올바른 미리보기 주소로 접속해 주세요.', 403); }
  const allowed = allowedHosts ? allowedHosts.includes(base.hostname) && !base.port : LOOPBACK.has(base.hostname);
  if (!allowed || base.username || base.password || base.pathname !== '/' || base.search || base.hash) throw new PreviewError('forbidden_origin', '허용된 미리보기 주소로 접속해 주세요.', 403);
  const url = new URL(req.url, base);
  if (url.origin !== base.origin) throw new PreviewError('forbidden_origin', '요청 주소가 올바르지 않습니다.', 403);
  return url;
}
function requireSameOrigin(req, url) {
  if (req.headers['sec-fetch-site'] === 'cross-site') throw new PreviewError('forbidden_origin', '다른 사이트에서 설정을 변경할 수 없습니다.', 403);
  if (!req.headers.origin || req.headers.origin !== url.origin) throw new PreviewError('forbidden_origin', '같은 미리보기 화면에서 설정을 변경해 주세요.', 403);
  const contentType = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (contentType !== 'application/json') throw new PreviewError('unsupported_media_type', 'JSON 형식만 지원합니다.', 415);
}
async function readBody(req) {
  if (Number(req.headers['content-length']) > MAX_BODY) { req.resume(); throw new PreviewError('payload_too_large', '요청 내용이 너무 큽니다.', 413); }
  return new Promise((resolve, reject) => {
    let bytes = 0;
    let rejected = false;
    const chunks = [];
    req.on('data', (chunk) => {
      if (rejected) return;
      bytes += chunk.length;
      if (bytes > MAX_BODY) {
        rejected = true;
        chunks.length = 0;
        // Drain the remaining request without destroying the response socket.
        reject(new PreviewError('payload_too_large', '요청 내용이 너무 큽니다.', 413));
      } else chunks.push(chunk);
    });
    req.on('end', () => {
      if (rejected) return;
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new PreviewError('validation', '올바른 JSON 요청을 보내 주세요.')); }
    });
    req.on('error', () => reject(new PreviewError('validation', '요청을 읽지 못했습니다.')));
    req.on('aborted', () => reject(new PreviewError('validation', '요청이 중단되었습니다.')));
  });
}
function staticFile(urlPath, webDir, fontsDir) {
  if (['/', '/app', '/signup', '/login'].includes(urlPath)) return path.join(webDir, 'index.html');
  if (urlPath.startsWith('/fonts/')) {
    const name = urlPath.slice('/fonts/'.length);
    return FONT_NAMES.has(name) ? path.join(fontsDir, name) : null;
  }
  // Only frontend asset extensions, with no dot segments or hidden files.
  const relative = urlPath.replace(/^\//, '').replace(/^assets\//, '');
  if (!relative || relative.split('/').some((part) => !part || part.startsWith('.')) || relative.includes('\\') || !/^[A-Za-z0-9_./-]+$/.test(relative)) return null;
  if (!['.js', '.css', '.svg', '.png', '.ico'].includes(path.extname(relative))) return null;
  const candidate = path.resolve(webDir, relative);
  return candidate.startsWith(`${path.resolve(webDir)}${path.sep}`) ? candidate : null;
}

function createPreviewServer({ store = createPreviewStore(), webDir = path.join(__dirname, 'web'), fontsDir = path.join(__dirname, '..', 'web', 'fonts'), hosted = false, allowedHosts = [], buildCommit = null, sessions = createPreviewSessions() } = {}) {
  if (hosted && !allowedHosts.length) throw new Error('호스팅 주소를 지정해야 합니다.');
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      const url = requestUrl(req, hosted ? allowedHosts : null);
      if (req.method === 'GET' && url.pathname === '/api/health') return json(res, 200, { status: 'ok', mode: 'preview', domain: 'insight.sabun.co.kr', ...(hosted ? { hosted: true, buildCommit, data: 'fictional', persistence: 'temporary-session' } : {}) });
      if (req.method === 'GET' && url.pathname === '/api/preview/state') return json(res, 200, (hosted ? sessions.resolve(req, res, true) : store).read(url.searchParams.get('profile') || 'owner'));
      if (req.method === 'POST' && url.pathname === '/api/preview/action') {
        requireSameOrigin(req, url);
        const visitorStore = hosted ? sessions.resolve(req, res) : store;
        return json(res, 200, visitorStore.act(await readBody(req)));
      }
      if (url.pathname.startsWith('/api/')) throw new PreviewError('not_found', '미리보기에서 제공하지 않는 기능입니다.', 404);
      if (!['GET', 'HEAD'].includes(req.method)) throw new PreviewError('method_not_allowed', '지원하지 않는 요청 방식입니다.', 405);
      if (url.pathname === '/robots.txt') {
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end(req.method === 'HEAD' ? undefined : 'User-agent: *\nDisallow: /\n');
      }
      const file = staticFile(url.pathname, webDir, fontsDir);
      if (!file) throw new PreviewError('not_found', '화면을 찾을 수 없습니다.', 404);
      let stat;
      try { stat = await fs.promises.stat(file); } catch { throw new PreviewError('not_found', '화면을 찾을 수 없습니다.', 404); }
      if (!stat.isFile()) throw new PreviewError('not_found', '화면을 찾을 수 없습니다.', 404);
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Content-Length': stat.size });
      if (req.method === 'HEAD') return res.end();
      const stream = fs.createReadStream(file);
      stream.on('error', () => res.destroy());
      stream.pipe(res);
    } catch (error) {
      if (res.headersSent || res.destroyed) return;
      const safe = error instanceof PreviewError ? error : new PreviewError('internal_error', '예시 상태를 처리하지 못했습니다.', 500);
      json(res, safe.status, { error: { code: safe.code, message: safe.message, details: safe.details } });
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  return server;
}

if (require.main === module) {
  try {
    const { host, port, ...options } = previewConfiguration();
    const server = createPreviewServer(options);
    server.on('error', (error) => { console.error(`미리보기 서버 시작 실패: ${error.code || 'ERROR'}`); process.exitCode = 1; });
    server.listen(port, host, () => console.log(`SABUN INSIGHT 예시 미리보기: http://${host}:${port} (운영 데이터 미연결)`));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}

module.exports = { createPreviewServer, previewConfiguration, MAX_BODY };
