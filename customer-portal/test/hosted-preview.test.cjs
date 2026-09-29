'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createPreviewServer, previewConfiguration } = require('../server.cjs');
const { createPreviewSessions } = require('../lib/preview-sessions.cjs');
const HOST = 'sabun-insight-preview.onrender.com';
const COMMIT = 'a'.repeat(40);

function request(port, { path = '/api/preview/state', method = 'GET', host = HOST, origin, cookie, body, forwardedHost } = {}) {
  return new Promise((resolve, reject) => {
    const headers = { host };
    if (origin) headers.origin = origin;
    if (cookie) headers.cookie = cookie;
    if (forwardedHost) headers['x-forwarded-host'] = forwardedHost;
    if (body) headers['content-type'] = 'application/json';
    const req = http.request({ hostname: '127.0.0.1', port, path, method, headers }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: res.headers['content-type']?.includes('application/json') ? JSON.parse(text) : text }));
    });
    req.on('error', reject);
    req.end(body ? JSON.stringify(body) : undefined);
  });
}

async function withHosted(callback, sessions) {
  const server = createPreviewServer({ hosted: true, allowedHosts: [HOST, 'insight.sabun.co.kr'], buildCommit: COMMIT, ...(sessions ? { sessions } : {}) });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try { await callback(server.address().port); } finally { await new Promise((resolve) => server.close(resolve)); }
}

test('public binding needs explicit preview opt-in and a Render hostname', () => {
  assert.throws(() => previewConfiguration({ INSIGHT_HOSTED_PREVIEW: '1' }, []), /INSIGHT_PREVIEW/);
  assert.throws(() => previewConfiguration({ INSIGHT_HOSTED_PREVIEW: '1', INSIGHT_PREVIEW: '1' }, []), /Render/);
  for (const hostname of ['evil.example', 'https://example.onrender.com', 'example.onrender.com/path']) {
    assert.throws(() => previewConfiguration({ INSIGHT_HOSTED_PREVIEW: '1', INSIGHT_PREVIEW: '1', RENDER_EXTERNAL_HOSTNAME: hostname }, []), /Render/);
  }
  const config = previewConfiguration({ INSIGHT_HOSTED_PREVIEW: '1', INSIGHT_PREVIEW: '1', NODE_ENV: 'production', PORT: '10000', RENDER_EXTERNAL_HOSTNAME: HOST, RENDER_GIT_COMMIT: COMMIT }, []);
  assert.equal(config.host, '0.0.0.0');
  assert.equal(config.buildCommit, COMMIT);
  assert.deepEqual(config.allowedHosts, [HOST, 'insight.sabun.co.kr']);
});

test('hosted visitor settings are isolated and missing or invalid sessions cannot mutate', () => withHosted(async (port) => {
  const first = await request(port);
  const cookie = first.headers['set-cookie'][0].split(';')[0];
  assert.match(first.headers['set-cookie'][0], /HttpOnly; Secure; SameSite=Lax/);
  const action = { profile: 'owner', revision: first.body.revision, action: 'set-limits', payload: { competitorLimit: 6, interestRegionLimit: 2 } };
  const updated = await request(port, { path: '/api/preview/action', method: 'POST', origin: `https://${HOST}`, cookie, body: action });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.limits.competitorLimit, 6);
  assert.equal((await request(port, { cookie })).body.limits.competitorLimit, 6);
  assert.equal((await request(port)).body.limits.competitorLimit, 3);
  for (const invalidCookie of [undefined, '__Host-insight-preview=forged']) {
    assert.equal((await request(port, { path: '/api/preview/action', method: 'POST', origin: `https://${HOST}`, cookie: invalidCookie, body: action })).status, 409);
  }
  assert.equal((await request(port, { path: '/api/preview/action', method: 'POST', origin: 'https://evil.example', cookie, body: action })).status, 403);
}));

test('host allowlist, search exclusion and build provenance are enforced', () => withHosted(async (port) => {
  assert.equal((await request(port, { host: 'evil.example', forwardedHost: HOST })).status, 403);
  const custom = await request(port, { host: 'insight.sabun.co.kr', path: '/api/health' });
  assert.equal(custom.status, 200);
  assert.equal(custom.body.buildCommit, COMMIT);
  assert.equal(custom.body.data, 'fictional');
  assert.match(custom.headers['x-robots-tag'], /noindex/);
  const robots = await request(port, { path: '/robots.txt' });
  assert.equal(robots.body, 'User-agent: *\nDisallow: /\n');
  assert.equal((await request(port, { path: '/api/crawl', method: 'POST' })).status, 404);
}));

test('session memory is bounded and expired visitor updates require reload', async () => {
  let clock = 1000;
  const sessions = createPreviewSessions({ maxSessions: 1, ttlMs: 10000, now: () => clock });
  await withHosted(async (port) => {
    const first = await request(port);
    const cookie = first.headers['set-cookie'][0].split(';')[0];
    assert.equal((await request(port)).status, 503);
    assert.equal((await request(port, { cookie })).status, 200);
    clock += 10001;
    const expired = await request(port, { path: '/api/preview/action', method: 'POST', origin: `https://${HOST}`, cookie, body: { profile: 'owner', revision: 1, action: 'reset', payload: {} } });
    assert.equal(expired.body.error.code, 'preview_expired');
    assert.equal((await request(port)).status, 200);
  }, sessions);
});
