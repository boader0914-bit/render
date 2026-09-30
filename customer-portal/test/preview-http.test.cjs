'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createPreviewServer, previewConfiguration, MAX_BODY } = require('../server.cjs');

async function withServer(callback) {
  const server = createPreviewServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try { await callback(origin); } finally { await new Promise((resolve) => server.close(resolve)); }
}
async function post(origin, body, extraHeaders = {}) {
  return fetch(`${origin}/api/preview/action`, { method: 'POST', headers: { origin, 'content-type': 'application/json', ...extraHeaders }, body: typeof body === 'string' ? body : JSON.stringify(body) });
}

test('startup requires explicit preview opt-in, refuses production, and binds loopback', () => {
  assert.throws(() => previewConfiguration({}, []), /INSIGHT_PREVIEW/);
  assert.throws(() => previewConfiguration({ NODE_ENV: 'production', INSIGHT_PREVIEW: '1' }, ['--preview']), /production/);
  assert.deepEqual(previewConfiguration({}, ['--preview']), { host: '127.0.0.1', port: 57831 });
  assert.deepEqual(previewConfiguration({ INSIGHT_PREVIEW: '1', PORT: '57832', HOST: '0.0.0.0' }, []), { host: '127.0.0.1', port: 57832 });
  assert.throws(() => previewConfiguration({ INSIGHT_PREVIEW: '1', PORT: 'no-port' }, []), /PORT/);
});

test('health, isolated profiles, updates and stale revisions work through real HTTP', async () => withServer(async (origin) => {
  const health = await (await fetch(`${origin}/api/health`)).json();
  assert.deepEqual(health, { status: 'ok', mode: 'preview', domain: 'insight.sabun.co.kr' });
  const initialResponse = await fetch(`${origin}/api/preview/state?profile=owner`);
  assert.equal(initialResponse.headers.get('cache-control'), 'no-store');
  const initial = await initialResponse.json();
  const update = { profile: 'owner', revision: initial.revision, action: 'set-limits', payload: { competitorLimit: 6, interestRegionLimit: 2 } };
  const updated = await post(origin, update);
  assert.equal(updated.status, 200);
  assert.equal((await updated.json()).limits.competitorLimit, 6);
  const stale = await post(origin, update);
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).error.code, 'stale_revision');
  const planning = await (await fetch(`${origin}/api/preview/state?profile=planning`)).json();
  assert.equal(planning.limits.competitorLimit, 3);
  assert.equal(planning.customer.ownedCompanyId, null);
}));

test('cross-origin, missing origin and wrong media type cannot change example settings', async () => withServer(async (origin) => {
  const action = { profile: 'owner', revision: 1, action: 'reset', payload: {} };
  for (const headers of [{ origin: 'https://evil.example' }, { origin: 'null' }, { 'sec-fetch-site': 'cross-site' }]) {
    const response = await post(origin, action, headers);
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error.code, 'forbidden_origin');
  }
  const missing = await fetch(`${origin}/api/preview/action`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(action) });
  assert.equal(missing.status, 403);
  const media = await post(origin, action, { 'content-type': 'text/plain' });
  assert.equal(media.status, 415);
  assert.equal((await (await fetch(`${origin}/api/preview/state`)).json()).revision, 1);
}));

test('company edit HTTP preserves public source data and reports while storing private settings and a pending request', async () => withServer(async (origin) => {
  const initial = await (await fetch(`${origin}/api/preview/state?profile=owner`)).json();
  const c = initial.companies[0];
  const response = await post(origin, { profile: 'owner', revision: initial.revision, action: 'edit-company', payload: {
    companyId: c.id, nickname: '나의 숙소', note: '예시 검토', reason: '객실 안내 예시 확인',
    proposed: { name: c.name, address: c.address, category: c.category, rooms: 17, dayUse: 'shared', facilities: '' },
  } });
  assert.equal(response.status, 200);
  const saved = await response.json();
  assert.equal(saved.companySettings[c.id].nickname, '나의 숙소');
  assert.equal(saved.correctionRequests[0].status, 'pending');
  const reread = await (await fetch(`${origin}/api/preview/state?profile=owner`)).json();
  assert.deepEqual(reread.correctionRequests, saved.correctionRequests);
  assert.deepEqual(reread.companies, initial.companies);
  assert.deepEqual(reread.reports, initial.reports);
  const planning = await (await fetch(`${origin}/api/preview/state?profile=planning`)).json();
  assert.deepEqual(planning.companySettings, {});
  assert.deepEqual(planning.correctionRequests, []);
}));

test('oversized, malformed and unrecognized payloads return safe errors without mutation', async () => withServer(async (origin) => {
  const oversized = await post(origin, JSON.stringify({ ignored: 'x'.repeat(MAX_BODY) }));
  assert.equal(oversized.status, 413);
  const malformed = await post(origin, '{');
  assert.equal(malformed.status, 400);
  const unknown = await post(origin, { profile: 'owner', revision: 1, action: 'reset', payload: {}, productionDataDir: '/var/data' });
  assert.equal(unknown.status, 400);
  const state = await (await fetch(`${origin}/api/preview/state`)).json();
  assert.equal(state.revision, 1);
  const collect = await fetch(`${origin}/api/crawl`, { method: 'POST' });
  assert.equal(collect.status, 404);
}));

test('shrinking limits returns actionable keep selection and then archives without rewriting reports', async () => withServer(async (origin) => {
  const initial = await (await fetch(`${origin}/api/preview/state`)).json();
  const request = { profile: 'owner', revision: 1, action: 'set-limits', payload: { competitorLimit: 0, interestRegionLimit: 0 } };
  const blocked = await post(origin, request);
  assert.equal(blocked.status, 409);
  const error = (await blocked.json()).error;
  assert.equal(error.code, 'requires_selection');
  assert.deepEqual(error.details.competitorIds, initial.competitorIds);
  request.payload.keepCompetitorIds = [];
  request.payload.keepInterestRegionCodes = [];
  const committed = await (await post(origin, request)).json();
  assert.deepEqual(committed.reports, initial.reports);
  assert.deepEqual(committed.archived.competitorIds, initial.competitorIds);
}));

test('static exposure is restricted to frontend files and three font names', async () => withServer(async (origin) => {
  const font = await fetch(`${origin}/fonts/Pretendard-Regular.otf`);
  assert.equal(font.status, 200);
  assert.equal(font.headers.get('content-type'), 'font/otf');
  await font.arrayBuffer();
  for (const pathname of ['/server.cjs', '/lib/preview-store.cjs', '/fonts/README.md', '/.env', '/package.json']) {
    const response = await fetch(`${origin}${pathname}`);
    assert.equal(response.status, 404, pathname);
  }
}));

test('host header DNS rebinding is refused even for read-only state', async () => withServer(async (origin) => {
  const status = await new Promise((resolve, reject) => {
    http.get(`${origin}/api/preview/state`, { headers: { host: 'attacker.example' } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); }).on('error', reject);
  });
  assert.equal(status, 403);
}));

test('chunked oversized request is rejected with a readable 413 response', async () => withServer(async (origin) => {
  const result = await new Promise((resolve, reject) => {
    const request = http.request(`${origin}/api/preview/action`, { method: 'POST', headers: { origin, 'content-type': 'application/json', 'transfer-encoding': 'chunked' } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
    });
    request.on('error', reject);
    request.write('{"data":"');
    request.write('x'.repeat(MAX_BODY + 100));
    request.end('"}');
  });
  assert.equal(result.status, 413);
  assert.equal(result.body.error.code, 'payload_too_large');
}));
