'use strict';
// Loopback HTTP only: actual report lifecycle, Insight integration/SQLite and
// connected BFF. No app-server import, collector, provider or production data.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createMonthlyReportService } = require('./lib/monthly_reports.cjs');
const { createMonthlyReportHttpHandler } = require('./lib/monthly_report_http.cjs');
const { renderMonthlyReportPdf } = require('./lib/monthly_report_pdf.cjs');
const { createInsightIntegration } = require('./lib/insight_integration.cjs');
const { listMonthlyReportActionEvidence } = require('./lib/monthly_report_actions.cjs');
const { createConnectedServer } = require('../customer-portal/connected-server.cjs');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const listen = server => new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve(server.address().port)); });
const close = server => new Promise(resolve => { server.closeAllConnections?.(); server.close(resolve); });
const key = () => crypto.randomUUID();
function send(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' });
  res.end(JSON.stringify(value));
}
async function parse(req) { const chunks = []; for await (const chunk of req) chunks.push(chunk); return JSON.parse(Buffer.concat(chunks)); }
async function fixture(t, { enabled = true, onRender = null } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'monthly-delivery-http-'));
  const sentinels = ['schedule.json', 'raw-observation.json', 'reservation-history.json', 'protection.json'];
  const preserved = new Map();
  for (const [i, name] of sentinels.entries()) {
    const file = path.join(root, name), bytes = Buffer.from(JSON.stringify({ fixtureOnly: true, original: i, value: 'preserve' }));
    await fs.writeFile(file, bytes); preserved.set(file, hash(bytes));
  }
  let sourceReads = 0, rendered = 0, integration;
  const reportDir = path.join(root, 'monthly_reports'), request = { type: 'company', targetId: 'cmp_test', month: '2026-09', cutoffDate: '2026-09-30' };
  const reports = createMonthlyReportService({ dataDir: reportDir, now: () => new Date('2026-10-25T12:00:00.000Z'),
    loadSources: async () => { sourceReads++; return { companies: [{ companyId: 'cmp_test', primaryName: '로컬 검수 숙소', regionKey: 'r1' }],
      regions: [{ id: 'r1', label: '로컬 지역', level: 'local' }], observations: [], runs: [] }; } });
  const requireAdmin = (session, req, res) => {
    if (session?.role === 'admin') return true;
    send(res, 403, { error: { code: 'ADMIN_REQUIRED' } }); return false;
  };
  const monthly = createMonthlyReportHttpHandler({ service: reports, sources: { options: async () => ({ companies: [] }) },
    renderPdf: async report => { rendered++; if (onRender) await onRender(report); return renderMonthlyReportPdf(report); },
    dataDir: reportDir, requireAdmin, parseJsonBody: parse, send,
    getDelivery: () => integration?.reportDelivery, deliveryCustomers: () => integration?.store.list() || [] });
  const members = [{ memberId: 'member-a', username: 'customer-a', role: 'b2b', status: 'active' },
    { memberId: 'member-b', username: 'customer-b', role: 'b2b', status: 'active' }];
  integration = createInsightIntegration({ dataDir: root, monthlyReports: reports, renderReportPdf: monthly.pdfFor, requireAdmin,
    readCatalog: async () => ({ companies: [], regions: [], rawCompanies: new Map() }), readMembers: async () => ({ members }),
    authenticateMember: async username => members.find(row => row.username === username),
    env: { INSIGHT_CONNECTION_ENABLED: '1', INSIGHT_SERVICE_TOKEN: 'local-only-service-token-at-least-32-characters',
      INSIGHT_METADATA_READ_ENABLED: '0', ...(enabled ? { INSIGHT_REPORT_DELIVERY_ENABLED: '1' } : {}) } });
  const a = integration.store.ensure(members[0]), b = integration.store.ensure(members[1]);
  const sessionA = integration.store.session(a.customerId), sessionB = integration.store.session(b.customerId);
  const backend = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://fixture');
      if (await integration.internal(req, res, url)) return;
      const session = req.headers['x-local-test-role'] === 'admin' ? { role: 'admin', memberId: 'local-admin' } : { role: 'b2b', memberId: 'member-a' };
      if (await monthly(req, res, url, session)) return;
      send(res, 404, { error: { code: 'NOT_FOUND' } });
    } catch (error) { send(res, error.statusCode || 503, { error: { code: error.code || 'SERVICE_UNAVAILABLE', message: error.statusCode ? error.message : 'local fixture failed' } }); }
  });
  const backendOrigin = 'http://127.0.0.1:' + await listen(backend);
  // Reserve an ephemeral public origin for the BFF's real Host/Origin checks.
  const reservation = net.createServer(), publicPort = await listen(reservation); await close(reservation);
  const publicOrigin = 'http://127.0.0.1:' + publicPort;
  const routes = [];
  const bff = createConnectedServer({ origin: publicOrigin, backend: backendOrigin,
    serviceToken: 'local-only-service-token-at-least-32-characters', fetchImpl: async (url, options) => {
      assert.equal(new URL(url).origin, backendOrigin, 'only this fixture backend may be contacted');
      assert.equal(options.redirect, 'error'); routes.push(new URL(url).pathname);
      return fetch(url, options);
    } });
  await new Promise((resolve, reject) => { bff.once('error', reject); bff.listen(publicPort, '127.0.0.1', resolve); });
  t.after(async () => {
    await close(bff); await close(backend); integration.store.close(); integration.adminStore.close();
    try { for (const [file, sha] of preserved) assert.equal(hash(await fs.readFile(file)), sha, path.basename(file) + ' must stay unchanged'); }
    finally { assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith('monthly-delivery-http-')); await fs.rm(root, { recursive: true, force: true }); }
  });
  async function admin(route, method = 'GET', payload, options = {}) {
    return fetch(backendOrigin + '/api/monthly-reports' + route, { method,
      headers: { 'Content-Type': 'application/json', Origin: options.origin || backendOrigin,
        'X-Local-Test-Role': options.role || 'admin' }, ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) });
  }
  const customer = (route, token = sessionA, method = 'GET') => fetch(publicOrigin + '/api/customer/v1' + route,
    { method, headers: { Cookie: 'insight_local_session=' + token, Origin: publicOrigin } });
  async function issued() {
    const previewResponse = await admin('/preview', 'POST', request); assert.equal(previewResponse.status, 200);
    const preview = await previewResponse.json(), ref = listMonthlyReportActionEvidence(preview)[0];
    const plan = { schemaVersion: 1, summary: '확보 범위를 보고 판단합니다.', items: [{ id: 'check', title: '누락일 점검', owner: '담당자',
      dueDate: '2026-11-01', status: 'planned', evidenceRefs: [ref.id], outcome: '작성자 메모' }] };
    const draftResponse = await admin('', 'POST', { ...request, previewToken: preview.previewToken, actionPlan: plan });
    assert.equal(draftResponse.status, 201); const draft = await draftResponse.json();
    const reviewResponse = await admin('/' + draft.id, 'PATCH', { revision: draft.revision, status: 'review' });
    assert.equal(reviewResponse.status, 200); const review = await reviewResponse.json();
    const publishedResponse = await admin('/' + draft.id + '/publish', 'POST', { revision: review.revision, acknowledgeQuality: true });
    assert.equal(publishedResponse.status, 200); const published = await publishedResponse.json();
    return { published, draft, preview, plan };
  }
  async function assign(reportId, customerId = a.customerId, requestKey = key()) {
    return admin('/' + reportId + '/assign', 'POST', { customerId, requestKey });
  }
  return { root, reportDir, integration, reports, monthly, a, b, sessionA, sessionB, members, admin, customer, issued, assign, routes,
    sourceReads: () => sourceReads, rendered: () => rendered };
}

test('issued report → explicit admin assignment → authenticated BFF list/detail/PDF preserves exact saved content', async t => {
  const f = await fixture(t), { published, plan } = await f.issued();
  const original = await fs.readFile(path.join(f.reportDir, published.id + '.json')), sourceReads = f.sourceReads();
  assert.equal(published.status, 'published'); assert.equal((await f.customer('/reports')).status, 200);
  assert.deepEqual(await (await f.customer('/reports')).json(), { reports: [] }, 'publication is not customer assignment');
  const assign = await f.assign(published.id); assert.equal(assign.status, 201);
  const availability = await f.admin('/' + published.id + '/delivery');
  assert.equal((await availability.json()).customers.length, 2);
  const list = await (await f.customer('/reports')).json(); assert.equal(list.reports[0].id, published.id);
  const detailResponse = await f.customer('/reports/' + published.id); assert.equal(detailResponse.status, 200);
  const detail = await detailResponse.json(); assert.equal(detail.snapshot.summary.lodging.sold, null);
  assert.deepEqual(detail.snapshot.actionPlan, plan); assert.equal(detail.snapshot.actionEvidence.length, 1);
  for (const field of ['sources', 'observations', 'sourceDiagnostics', 'discardedSamples', 'notes', 'actorId', 'runIds']) {
    assert.equal(JSON.stringify(detail).includes('"' + field + '"'), false, field);
  }
  const pdf = await f.customer('/reports/' + published.id + '/pdf');
  assert.equal(pdf.status, 200); assert.match(pdf.headers.get('content-type'), /^application\/pdf/);
  assert.match(pdf.headers.get('content-disposition'), /^attachment; filename="monthly-report-2026-09-v1\.pdf"$/);
  assert.equal(pdf.headers.get('cache-control'), 'private, no-store'); assert.equal(pdf.headers.get('x-content-type-options'), 'nosniff');
  const pdfBytes = Buffer.from(await pdf.arrayBuffer()); assert.equal(pdfBytes.subarray(0, 5).toString(), '%PDF-');
  const again = await f.customer('/reports/' + published.id + '/pdf'); assert.deepEqual(Buffer.from(await again.arrayBuffer()), pdfBytes);
  assert.equal(f.rendered(), 1); assert.equal(f.sourceReads(), sourceReads, 'customer reads/PDF must not recalculate saved sources');
  assert.deepEqual(await fs.readFile(path.join(f.reportDir, published.id + '.json')), original);
  assert.ok(f.routes.every(route => !/crawl|collector|collection|preparation/.test(route)), 'no collection dispatch routes');
  assert.equal((await (await f.customer('/me')).json()).features.reportDelivery, true);
});
test('draft cannot be assigned; member, wrong origin and extra assignment fields are denied without a receipt', async t => {
  const f = await fixture(t);
  const draft = await (await f.admin('', 'POST', { type: 'company', targetId: 'cmp_test', month: '2026-09', cutoffDate: '2026-09-30' })).json();
  assert.equal((await f.assign(draft.id)).status, 409);
  const { published } = await f.issued(), route = '/' + published.id + '/assign', payload = { customerId: f.a.customerId, requestKey: key() };
  assert.equal((await f.admin(route, 'POST', payload, { role: 'b2b' })).status, 403);
  assert.equal((await f.admin(route, 'POST', payload, { origin: 'https://untrusted.invalid' })).status, 403);
  assert.equal((await f.admin(route, 'POST', { ...payload, reportId: draft.id })).status, 400);
  assert.deepEqual(await (await f.customer('/reports')).json(), { reports: [] });
});
test('another customer cannot read or download a known assigned ID; route/method/input allowlists remain narrow', async t => {
  const f = await fixture(t), { published } = await f.issued(); assert.equal((await f.assign(published.id)).status, 201);
  assert.deepEqual(await (await f.customer('/reports', f.sessionB)).json(), { reports: [] });
  for (const suffix of ['', '/pdf']) assert.equal((await f.customer('/reports/' + published.id + suffix, f.sessionB)).status, 404);
  assert.equal((await f.customer('/reports', '')).status, 401);
  assert.equal((await f.customer('/reports?customerId=' + f.b.customerId)).status, 400);
  assert.equal((await f.customer('/reports/' + published.id + '?refresh=1')).status, 400);
  assert.equal((await f.customer('/reports', f.sessionA, 'POST')).status, 404);
  assert.equal((await f.customer('/reports/' + published.id + '/publish', f.sessionA, 'POST')).status, 404);
  assert.equal(f.rendered(), 0);
});
test('delivery is opt-in: an omitted flag keeps report routes unavailable and cannot implicitly assign', async t => {
  const f = await fixture(t, { enabled: false }), { published } = await f.issued();
  assert.equal(f.integration.reportDelivery, null);
  assert.equal((await (await f.customer('/me')).json()).features.reportDelivery, false);
  for (const route of ['/reports', '/reports/' + published.id, '/reports/' + published.id + '/pdf']) assert.equal((await f.customer(route)).status, 409);
  assert.equal((await f.assign(published.id)).status, 409); assert.equal(f.rendered(), 0);
});
test('snapshot or issued metadata changes cannot replace the assigned customer copy or PDF', async t => {
  const f = await fixture(t), { published } = await f.issued(); assert.equal((await f.assign(published.id)).status, 201);
  const file = path.join(f.reportDir, published.id + '.json');
  await fs.writeFile(file, JSON.stringify({ ...published, title: 'silently replaced' }));
  for (const suffix of ['', '/pdf']) assert.equal((await f.customer('/reports/' + published.id + suffix)).status, 409);
  const snapshot = { ...published.snapshot, summary: { ...published.snapshot.summary, replaced: true } };
  await fs.writeFile(file, JSON.stringify({ ...published, snapshot, snapshotHash: hash(Buffer.from(JSON.stringify(snapshot))) }));
  assert.equal((await f.customer('/reports')).status, 409); assert.equal(f.rendered(), 0);
});
test('an account disabled before a customer read cannot list or download assigned reports', async t => {
  const f = await fixture(t), { published } = await f.issued(); assert.equal((await f.assign(published.id)).status, 201);
  const c = f.integration.store.get(f.a.customerId);
  f.integration.store.adminUpdate(c.customerId, { revision: c.revision, requestKey: key(), action: 'account-status', payload: { status: 'disabled', reason: 'local isolated test' } }, 'admin', { companies: [], regions: [] });
  for (const route of ['/reports', '/reports/' + published.id + '/pdf']) assert.equal((await f.customer(route)).status, 401);
  assert.equal(f.rendered(), 0);
});
for (const revoke of ['logout', 'member-disabled']) test('PDF generation finishes privately but ' + revoke + ' before return prevents all customer PDF bytes', async t => {
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, { onRender: async () => { entered(); await gate; } });
  t.after(() => release());
  const { published } = await f.issued(); assert.equal((await f.assign(published.id)).status, 201);
  const pending = f.customer('/reports/' + published.id + '/pdf'); await started;
  if (revoke === 'logout') f.integration.store.logout(f.sessionA); else f.members[0].status = 'disabled';
  release(); const response = await pending; assert.equal(response.status, revoke === 'logout' ? 401 : 403);
  assert.match(response.headers.get('content-type'), /^application\/json/);
  const body = await response.text(); assert.doesNotMatch(body, /%PDF-|actionPlan|snapshot|source|token|local-admin/);
  assert.equal(f.rendered(), 1);
});
