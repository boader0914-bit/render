'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { randomUUID } = require('node:crypto');
const { createInsightStore, fault } = require('./lib/insight_store.cjs');
const { createInsightHttp, csrf } = require('./lib/insight_http.cjs');

const serviceToken = 'fixture-insight-service-credential-32-plus';
const adminToken = 'fixture-admin-session';
const catalog = {
  companies: [{ companyId: 'cmp_fixture', name: '검수 숙소', address: '검수 주소', rooms: 16, placeIds: ['1234'], regionKey: 'region_own' }],
  regions: [{ id: 'region_own', label: '내 매장 지역', level: 'local' }, { id: 'region_interest', label: '관심 지역', level: 'local' }]
};
function gate() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const turn = () => new Promise(resolve => setImmediate(resolve));
async function promptly(promise) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('bootstrap waited for blocked receipt verification')), 1000); })]); }
  finally { clearTimeout(timer); }
}
function fixture(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'insight-login-latency-'));
  const store = createInsightStore({ file: path.join(dir, 'state.sqlite') });
  t.after(() => store.close());
  const member = { memberId: 'fixture-member', username: 'fixture', role: 'b2b', status: 'active' };
  const customer = store.ensure(member), customerId = customer.customerId;
  const command = (action, payload) => ({ revision: store.get(customerId).revision, requestKey: randomUUID(), action, payload });
  store.update(customerId, command('add-company', { kind: 'own', companyId: 'cmp_fixture' }), catalog);
  store.update(customerId, command('add-region', { regionKey: 'region_interest' }), catalog);
  store.preparation(customerId, command('prepare-data', { companyId: 'cmp_fixture' }), catalog.companies[0]);
  const token = store.session(customerId);
  let memberEnabled = true, adminEnabled = true;
  const adminStore = { authenticate(value) {
    if (!adminEnabled || value !== adminToken) throw fault('ADMIN_LOGIN_REQUIRED', '관리자 로그인 필요', 401);
    return { adminId: 'fixture-admin', username: 'fixture-admin' };
  } };
  const handlers = createInsightHttp({ store, serviceToken, catalog: async () => catalog,
    authenticateMember: async () => member, memberActive: async () => memberEnabled,
    requireAdmin: () => false, adminStore, ...options });
  async function request(route = '/me', { method = 'GET', payload, admin = false, session = token } = {}) {
    const req = Readable.from(payload === undefined ? [] : [Buffer.from(JSON.stringify(payload))]);
    req.method = method;
    req.headers = { authorization: `Bearer ${serviceToken}`, 'content-type': 'application/json' };
    if (admin) {
      req.headers['x-insight-admin-session'] = adminToken;
      req.headers['x-csrf-token'] = csrf(adminToken);
    } else {
      req.headers['x-insight-session'] = session;
      req.headers['x-csrf-token'] = csrf(session);
    }
    const headers = {};
    const res = { setHeader(name, value) { headers[name.toLowerCase()] = value; },
      writeHead(status, values) { this.status = status; for (const [key, value] of Object.entries(values)) headers[key.toLowerCase()] = value; },
      end(value) { this.value = JSON.parse(value); this.finished = true; } };
    await handlers.internal(req, res, new URL('/api/insight/v1' + route, 'http://fixture'));
    return { status: res.status, data: res.value, headers };
  }
  return { store, customerId, token, command, request,
    disableMember() { memberEnabled = false; }, disableAdmin() { adminEnabled = false; } };
}

test('me/login/admin start return while receipt verification is blocked, with shared refresh and no dispatch', async t => {
  const blocked = gate(), refreshes = [], dispatches = [];
  t.after(() => blocked.resolve());
  const x = fixture(t, { preparationBridge: {
    refresh: customerId => { refreshes.push(customerId); return blocked.promise; },
    dispatch: (...args) => { dispatches.push(args); throw new Error('bootstrap must not collect'); }
  }, collectionResults: {} });
  const responses = await promptly(Promise.all([
    x.request(), x.request(), x.request('/auth/login', { method: 'POST', payload: { username: 'fixture', password: 'fixture-password' } }),
    x.request('/admin/customer-view/start', { method: 'POST', payload: {}, admin: true })
  ]));
  for (const response of responses) {
    assert.equal(response.status, 200);
    assert.match(response.headers['server-timing'], /^state_catalog;dur=\d+\.\d, state_total;dur=\d+\.\d$/);
    assert.equal(response.headers['cache-control'], 'private, no-store');
    assert.equal(response.data.preparations.some(row => row.status === 'ready'), false);
  }
  assert.equal(responses[0].data.preparations[0].status, 'needs_review');
  assert.equal(responses[2].data.token.length, 43);
  assert.equal(responses[3].data.customer.accountKind, 'admin_preview');
  assert.equal(responses[3].data.registrationAllowance.competitorLimit, null);
  await turn();
  assert.equal(refreshes.filter(id => id === x.customerId).length, 1);
  assert.equal(refreshes.length, 2, 'another customer owns its own verification');
  assert.equal(dispatches.length, 0);
});

test('bootstrap can use the lightweight state catalog while registration search keeps the normal catalog', async t => {
  let normal = 0, lightweight = 0;
  const x = fixture(t, { catalog: async () => { normal++; return catalog; }, stateCatalog: async () => { lightweight++; return catalog; } });
  assert.equal((await x.request()).status, 200);
  assert.equal(normal, 0);
  assert.equal(lightweight, 1);
  assert.equal((await x.request('/catalog/companies?q=검수')).status, 200);
  assert.equal(normal, 1);
});

test('slow identity stages emit bounded diagnostics without account, token, source or private error fields',async t=>{
  const entries=[];let time=0;
  const x=fixture(t,{identityDiagnostics:entry=>entries.push(entry),identityClock:()=>time,
    stateCatalog:async()=>{time+=1500;return catalog;}});
  const response=await x.request();assert.equal(response.status,200);assert.equal(entries.length,1);
  assert.deepEqual(Object.keys(entries[0]).sort(),['elapsedMs','outcome','requestId','route','stage']);
  assert.equal(entries[0].stage,'catalog');assert.equal(entries[0].elapsedMs,1500);assert.equal(entries[0].outcome,'complete');
  assert.match(entries[0].requestId,/^[a-f0-9-]{36}$/);assert.doesNotMatch(JSON.stringify(entries),new RegExp(x.token+'|'+x.customerId+'|fixture-member'));
  const failed=[];const y=fixture(t,{identityDiagnostics:entry=>failed.push(entry),identityClock:()=>time,
    stateCatalog:async()=>{time+=1200;throw Error('private-source-detail');}});
  assert.equal((await y.request()).status,503);assert.equal(failed[0].outcome,'failed');assert.doesNotMatch(JSON.stringify(failed),/private-source-detail/);
});

test('collection GET still awaits the same in-flight verification before reading saved results', async t => {
  const blocked = gate(); t.after(() => blocked.resolve());
  let refreshes = 0, reads = 0;
  const x = fixture(t, { preparationBridge: { refresh: () => { refreshes++; return blocked.promise; } },
    collectionResults: { companyDetail: async () => { reads++; return { companyId: 'cmp_fixture' }; }, read: async () => ({ companyId: 'cmp_fixture', runId: 'fixture-run' }) } });
  assert.equal((await promptly(x.request())).status, 200);
  let completed = false;
  const reading = x.request('/companies/cmp_fixture/collection').then(value => { completed = true; return value; });
  await turn();
  assert.equal(completed, false);
  assert.equal(reads, 0);
  assert.equal(refreshes, 1);
  blocked.resolve();
  const result = await promptly(reading);
  assert.equal(result.status, 200);
  assert.equal(reads, 1);
  assert.equal(result.data.result.runId, 'fixture-run');
  assert.equal(result.data.previousResult, true);
});

test('mutation responses retain the existing receipt-verification wait instead of becoming bootstrap reads', async t => {
  const blocked = gate(); t.after(() => blocked.resolve());
  let refreshes = 0, completed = false;
  const x = fixture(t, { preparationBridge: { refresh: () => { refreshes++; return blocked.promise; } } });
  const response = x.request('/commands', { method: 'POST', payload: x.command('onboarding', { businessStatus: 'owned', projectName: '수정 검수' }) }).then(value => { completed = true; return value; });
  await turn();
  assert.equal(completed, false);
  assert.equal(refreshes, 1);
  blocked.resolve();
  const result = await promptly(response);
  assert.equal(result.status, 200);
  assert.equal(result.data.customer.projectName, '수정 검수');
});

test('signup bootstrap verifies the new member without waiting for background preparation', async t => {
  const blocked = gate(); t.after(() => blocked.resolve());
  const version = 'fixture-v1';
  const x = fixture(t, { preparationBridge: { refresh: () => blocked.promise },
    registerMember: async () => ({ memberId: 'fixture-new-member', username: 'new-fixture', role: 'b2b', status: 'active' }),
    signup: { enabled: true, termsVersion: version, privacyVersion: version, termsUrl: '/terms', privacyUrl: '/privacy' },
    policies: { terms: { version }, privacy: { version } } });
  const result = await promptly(x.request('/auth/signup', { method: 'POST', payload: {
    username: 'new-fixture', password: 'FixturePassword2026!', passwordConfirm: 'FixturePassword2026!',
    phone: '010-0000-0000', email: 'fixture@example.invalid', agreeTerms: true, agreePrivacy: true, confirmAge: true,
    termsVersion: version, privacyVersion: version, businessStatus: 'owned', projectName: '가입 검수'
  } }));
  assert.equal(result.status, 200);
  assert.equal(result.data.customer.memberId, 'fixture-new-member');
  assert.equal(result.data.customer.projectName, '가입 검수');
  assert.equal(result.data.token.length, 43);
});

test('background failures are handled and released; explicit collection refresh failures stay errors', async t => {
  let attempts = 0, reads = 0;
  const x = fixture(t, { preparationBridge: { refresh: async () => { attempts++; throw new Error('fixture verification failed'); } },
    collectionResults: { read: async () => { reads++; return null; } } });
  assert.equal((await x.request()).status, 200);
  await turn(); await turn();
  assert.equal(attempts, 1);
  assert.equal((await x.request()).status, 200);
  await turn(); await turn();
  assert.equal(attempts, 2, 'rejected verification must not pin the customer flight forever');
  const result = await x.request('/companies/cmp_fixture/collection');
  assert.equal(result.status, 503);
  assert.equal(result.data.error.code, 'SERVICE_UNAVAILABLE');
  assert.equal(reads, 0);
  assert.equal(attempts, 3);
});

for (const scenario of ['session', 'account', 'member']) test(`bootstrap rechecks ${scenario} after a slow catalog instead of reusing auth success`, async t => {
  const entered = gate(), blocked = gate(); t.after(() => blocked.resolve(catalog));
  let refreshes = 0;
  const x = fixture(t, { catalog: () => { entered.resolve(); return blocked.promise; }, preparationBridge: { refresh: async () => { refreshes++; } } });
  const response = x.request();
  await entered.promise;
  if (scenario === 'session') x.store.logout(x.token);
  else if (scenario === 'account') x.store.adminUpdate(x.customerId, x.command('account-status', { status: 'disabled', reason: '검수 중 중지' }), 'fixture-admin');
  else x.disableMember();
  blocked.resolve(catalog);
  const result = await response;
  assert.equal(result.status, scenario === 'member' ? 403 : 401);
  assert.equal(result.data.customer, undefined);
  assert.equal(result.data.companies, undefined);
  await turn();
  assert.equal(refreshes, 0);
  assert.throws(() => x.store.authenticate(x.token), { code: 'LOGIN_REQUIRED' });
});

test('bootstrap filters companies and own regions with relationships changed during catalog loading', async t => {
  const entered = gate(), blocked = gate(); t.after(() => blocked.resolve(catalog));
  const x = fixture(t, { catalog: () => { entered.resolve(); return blocked.promise; } });
  const response = x.request();
  await entered.promise;
  const relation = x.store.get(x.customerId).relations[0];
  x.store.update(x.customerId, x.command('archive-company', { relationId: relation.relationId }), catalog);
  blocked.resolve(catalog);
  const result = await response;
  assert.equal(result.status, 200);
  assert.deepEqual(result.data.companies, []);
  assert.deepEqual(result.data.regions.map(row => row.id), ['region_interest']);
  assert.equal(result.data.customer.revision, x.store.get(x.customerId).revision);
  assert.equal(result.data.registrationAllowance.competitorLimit, 3);
});

test('final asynchronous member validation cannot revive a session revoked during that validation', async t => {
  const entered = gate(), blocked = gate(); t.after(() => blocked.resolve(true));
  let checks = 0;
  const x = fixture(t, { memberActive: async () => { if (++checks === 2) { entered.resolve(); return blocked.promise; } return true; } });
  const response = x.request();
  await entered.promise;
  x.store.logout(x.token);
  blocked.resolve(true);
  const result = await response;
  assert.equal(result.status, 401);
  assert.equal(result.data.customer, undefined);
});

test('admin customer bootstrap rechecks the administrator session after slow catalog work', async t => {
  const entered = gate(), blocked = gate(); t.after(() => blocked.resolve(catalog));
  const x = fixture(t, { catalog: () => { entered.resolve(); return blocked.promise; } });
  const response = x.request('/admin/customer-view/start', { method: 'POST', payload: {}, admin: true });
  await entered.promise;
  x.disableAdmin();
  blocked.resolve(catalog);
  const result = await response;
  assert.equal(result.status, 401);
  assert.equal(result.data.customer, undefined);
});
