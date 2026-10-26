'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { createInsightStore } = require('./lib/insight_store.cjs');
const { createMonthlyReportService } = require('./lib/monthly_reports.cjs');
const { createMonthlyReportDelivery } = require('./lib/monthly_report_delivery.cjs');
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const NOW = '2026-10-25T12:00:00.000Z';
const key = () => crypto.randomBytes(20).toString('hex');
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'monthly-delivery-'));
  const customers = createInsightStore({ file: path.join(root, 'insight.sqlite') });
  t.after(async () => { customers.close(); assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('monthly-delivery-')); await fs.rm(root, { recursive: true, force: true }); });
  const a = customers.ensure({ memberId: 'member-a', username: 'a', role: 'b2b' });
  const b = customers.ensure({ memberId: 'member-b', username: 'b', role: 'b2b' });
  const reportDir = path.join(root, 'monthly_reports'), dataDir = path.join(root, 'delivery');
  await fs.mkdir(reportDir);
  const snapshot = { schemaVersion: 1, target: { type: 'company', id: 'cmp_test', label: '검수 숙소', internalPath: '/private/target' },
    period: { start: '2026-08-01', end: '2026-08-31', days: 31, cutoffDate: '2026-08-31', monthClosed: true, secret: 'period-secret' },
    summary: { lodging: { supply: 10, sold: 3, publicBookings: 2, phoneBookings: 1, publicRevenue: 200, phoneRevenue: null,
      estimatedRevenue: null, actualRevenue: null, knownPartialRevenue: 0, reservationRate: 0.3, coveredCompanyDays: 1,
      missingCompanyDays: 30, partial: true, revenuePartial: true, containsPartialRun: false, runIds: ['private-run'], secret: 'metric-secret' },
    dayuse: { supply: null, sold: null, publicBookings: null, phoneBookings: null } },
    daily: [{ date: '2026-08-01', lodging: { supply: 10, sold: 0, publicBookings: 0, phoneBookings: 0,
      estimatedRevenue: 0, publicRevenue: 0, phoneRevenue: 0, secret: 'day-secret' }, dayuse: { supply: null } }],
    quality: { status: 'partial', provisional: false, missingCompanyDays: 30, warnings: ['/private/credential.json'],
      discardedSamples: [{ raw: 'private-sample' }], sourceDiagnostics: { token: 'private-token' } },
    sources: { path: '/private/source.json', observations: [{ phone: 'private-phone' }], runIds: ['private-run'] },
    context: { sources: [{ token: 'private-context' }], catchment: { schemaVersion: 2, defaultMode: 'administrative_region',
      entries: [{ regionKey: 'private-region', regionSnapshot: { source: { sourceFingerprint: 'private-region-source' } } }],
      preciseEntries: [{ snapshot: { scope: { center: { address: 'private-address', latitude: 36, longitude: 127 } } } }] } }, companies: [{ secret: 'private-company' }],
    unknownFutureField: { credential: 'future-secret' } };
  const seed = { schemaVersion: 1, id: 'mr_' + crypto.randomUUID(), revision: 3, version: 1, status: 'published', type: 'company',
    month: '2026-08', targetId: 'cmp_test', title: '8월 발행본', notes: 'private admin note', publishedAt: '2026-09-01T00:00:00.000Z',
    createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z', snapshot, snapshotHash: digest(snapshot) };
  const save = report => fs.writeFile(path.join(reportDir, report.id + '.json'), JSON.stringify(report));
  await save(seed);
  const reports = createMonthlyReportService({ dataDir: reportDir, loadSources: async () => assert.fail('delivery must never calculate or collect') });
  const make = (extra = {}) => createMonthlyReportDelivery({ dataDir, customers, reports, now: () => NOW, ...extra });
  const delivery = make();
  const session = customers.session(a.customerId);
  const options = { verifyAccess: () => customers.authenticate(session) };
  const assign = (input = {}) => delivery.assign({ customerId: a.customerId, reportId: seed.id, actorId: 'trusted-admin', requestKey: key(), ...input });
  return { root, customers, a, b, dataDir, seed, save, reports, delivery, make, assign, options, session,
    receipt: () => path.join(dataDir, a.customerId + '.json') };
}
test('explicit assignment persists across service restart and does not touch issued reports or customer settings', async t => {
  const f = await fixture(t), before = JSON.stringify(f.customers.get(f.a.customerId));
  const reportFile = path.join(f.root, 'monthly_reports', f.seed.id + '.json'), bytes = await fs.readFile(reportFile);
  assert.deepEqual(await f.delivery.list(f.a.customerId, f.options), { reports: [] });
  assert.equal(await fs.stat(f.dataDir).then(() => true, () => false), false, 'reads must not create receipts');
  const result = await f.assign();
  assert.equal(result.created, true); assert.equal(result.assignment.snapshotHash, f.seed.snapshotHash);
  const restarted = f.make(), listed = await restarted.list(f.a.customerId, f.options);
  assert.equal(listed.reports.length, 1); assert.equal(listed.reports[0].id, f.seed.id);
  assert.equal(listed.reports[0].assignedAt, NOW);
  assert.deepEqual(await fs.readFile(reportFile), bytes);
  assert.equal(JSON.stringify(f.customers.get(f.a.customerId)), before);
});
test('DTO preserves public versus estimated, true zero, null and partial money without leaking raw or future fields', async t => {
  const f = await fixture(t); await f.assign();
  const detail = await f.delivery.detail(f.a.customerId, f.seed.id, f.options), s = detail.snapshot.summary.lodging;
  assert.equal(s.publicBookings, 2); assert.equal(s.phoneBookings, 1); assert.equal(s.estimatedRevenue, null);
  assert.equal(s.knownPartialRevenue, 0); assert.equal(detail.snapshot.daily[0].lodging.sold, 0);
  assert.equal(detail.snapshot.daily[0].lodging.estimatedRevenue, 0); assert.equal(detail.snapshot.summary.dayuse.sold, null);
  assert.equal(detail.snapshot.quality.status, 'partial');
  const publicText = JSON.stringify([detail, await f.delivery.list(f.a.customerId, f.options)]);
  for (const secret of ['private', 'secret', 'credential', 'sourceDiagnostics', 'observations', 'discardedSamples', 'notes', 'actorId', 'snapshotHash', 'runIds']) {
    assert.equal(publicText.includes(secret), false, secret);
  }
  detail.snapshot.summary.lodging.publicBookings = 999;
  assert.equal((await f.delivery.detail(f.a.customerId, f.seed.id, f.options)).snapshot.summary.lodging.publicBookings, 2);
});
test('another customer and arbitrary unassigned report IDs cannot trigger a report read', async t => {
  const f = await fixture(t); await f.assign();
  let reads = 0;
  const guarded = f.make({ reports: { get: async () => { reads++; assert.fail('unassigned report read'); } } });
  await assert.rejects(guarded.detail(f.b.customerId, f.seed.id, { verifyAccess: () => f.b }), { code: 'REPORT_NOT_FOUND', statusCode: 404 });
  await assert.rejects(guarded.authorizedReport(f.a.customerId, 'mr_' + crypto.randomUUID(), f.options), { code: 'REPORT_NOT_FOUND' });
  assert.equal(reads, 0); assert.deepEqual(await guarded.list(f.b.customerId, { verifyAccess: () => f.b }), { reports: [] });
});
test('draft, corrupt snapshot and absent report cannot be assigned', async t => {
  const f = await fixture(t);
  await f.save({ ...f.seed, status: 'review' });
  await assert.rejects(f.assign(), { code: 'PUBLISHED_REPORT_REQUIRED' });
  await f.save({ ...f.seed, snapshot: { ...f.seed.snapshot, changed: true } });
  await assert.rejects(f.assign(), { code: 'corrupt_report' });
  await assert.rejects(f.assign({ reportId: 'mr_' + crypto.randomUUID() }), { code: 'report_not_found' });
  assert.equal(await fs.stat(f.receipt()).then(() => true, () => false), false);
});
test('changed snapshot with recomputed hash or changed issued metadata is rejected by the persisted binding', async t => {
  const f = await fixture(t); await f.assign();
  const changed = { ...f.seed.snapshot, changed: true };
  await f.save({ ...f.seed, snapshot: changed, snapshotHash: digest(changed) });
  await assert.rejects(f.delivery.detail(f.a.customerId, f.seed.id, f.options), { code: 'REPORT_INTEGRITY_CHANGED' });
  await assert.rejects(f.delivery.list(f.a.customerId, f.options), { code: 'REPORT_INTEGRITY_CHANGED' });
  await f.save({ ...f.seed, title: 'silently replaced title' });
  await assert.rejects(f.delivery.authorizedReport(f.a.customerId, f.seed.id, f.options), { code: 'REPORT_INTEGRITY_CHANGED' });
  await assert.rejects(f.assign(), { code: 'REPORT_INTEGRITY_CHANGED' });
});
test('PDF notes and future issued metadata are fixed by assignment even though they are outside snapshotHash', async t => {
  const f = await fixture(t); await f.assign();
  for (const changed of [{ ...f.seed, notes: 'silently replaced PDF notes' }, { ...f.seed, futureInternalMetadata: 'new value' }]) {
    await f.save(changed);
    await assert.rejects(f.delivery.authorizedReport(f.a.customerId, f.seed.id, f.options), { code: 'REPORT_INTEGRITY_CHANGED' });
    await assert.rejects(f.delivery.detail(f.a.customerId, f.seed.id, f.options), { code: 'REPORT_INTEGRITY_CHANGED' });
  }
});
test('request retries are byte-identical and changed assignment input conflicts', async t => {
  const f = await fixture(t), requestKey = key();
  const first = await f.assign({ requestKey }), bytes = await fs.readFile(f.receipt());
  assert.deepEqual(await f.assign({ requestKey }), first);
  assert.deepEqual(await fs.readFile(f.receipt()), bytes);
  await assert.rejects(f.assign({ requestKey, reportId: 'mr_' + crypto.randomUUID() }), { code: 'REQUEST_CONFLICT' });
  await assert.rejects(f.assign({ requestKey, actorId: 'another-admin' }), { code: 'REQUEST_CONFLICT' });
  assert.equal((await f.assign()).created, false);
  assert.equal((await f.delivery.list(f.a.customerId, f.options)).reports.length, 1);
});
test('concurrent independent writers cannot overwrite a held customer lock', async t => {
  const f = await fixture(t); let entered, release;
  const inside = new Promise(resolve => { entered = resolve; }), blocked = new Promise(resolve => { release = resolve; });
  const slow = f.make({ reports: { get: async id => { entered(); await blocked; return f.reports.get(id); } } });
  const work = slow.assign({ customerId: f.a.customerId, reportId: f.seed.id, actorId: 'trusted-admin', requestKey: key() });
  await inside;
  await assert.rejects(f.assign(), { code: 'DELIVERY_BUSY', statusCode: 423 });
  release(); await work;
  assert.equal((await f.delivery.list(f.a.customerId, f.options)).reports.length, 1);
});
test('an old lock never expires automatically and does not block immutable reads', async t => {
  const f = await fixture(t); await f.assign();
  const lockFile = f.receipt() + '.lock'; await fs.writeFile(lockFile, 'preserve stale owner');
  await fs.utimes(lockFile, new Date('2000-01-01'), new Date('2000-01-01'));
  await assert.rejects(f.assign(), { code: 'DELIVERY_BUSY' });
  assert.equal((await f.delivery.detail(f.a.customerId, f.seed.id, f.options)).id, f.seed.id);
  assert.equal(await fs.readFile(lockFile, 'utf8'), 'preserve stale owner');
});
test('failed atomic replacement preserves the old receipt and leaves no half-written assignment', async t => {
  const f = await fixture(t); await f.assign(); const bytes = await fs.readFile(f.receipt());
  const failing = f.make({ fileSystem: { ...fs, rename: async () => { throw Object.assign(Error('disk unavailable'), { code: 'EIO' }); } } });
  await assert.rejects(failing.assign({ customerId: f.a.customerId, reportId: f.seed.id, actorId: 'trusted-admin', requestKey: key() }), { code: 'EIO' });
  assert.deepEqual(await fs.readFile(f.receipt()), bytes);
  assert.deepEqual((await fs.readdir(f.dataDir)).sort(), [f.a.customerId + '.json']);
});
test('session revocation during report I/O is rechecked for detail, list and internal PDF access', async t => {
  const f = await fixture(t); await f.assign();
  for (const operation of ['detail', 'list', 'authorizedReport']) {
    const token = f.customers.session(f.a.customerId); let reads = 0;
    const guarded = f.make({ reports: { get: async id => { reads++; const report = await f.reports.get(id); f.customers.logout(token); return report; } } });
    const options = { verifyAccess: () => f.customers.authenticate(token) };
    await assert.rejects(operation === 'list' ? guarded.list(f.a.customerId, options) : guarded[operation](f.a.customerId, f.seed.id, options), { code: 'LOGIN_REQUIRED' });
    assert.equal(reads, 1);
  }
});
test('disabled account, missing verifier and mismatched verifier fail closed', async t => {
  const f = await fixture(t); await f.assign();
  await assert.rejects(f.delivery.detail(f.a.customerId, f.seed.id), { code: 'CUSTOMER_ACCESS_REQUIRED' });
  await assert.rejects(f.delivery.detail(f.a.customerId, f.seed.id, { verifyAccess: () => f.b }), { code: 'LOGIN_REQUIRED' });
  const options = { verifyAccess: async () => {
    const c = f.customers.get(f.a.customerId);
    f.customers.adminUpdate(c.customerId, { revision: c.revision, requestKey: key(), action: 'account-status', payload: { status: 'disabled', reason: 'isolated test' } }, 'admin', { companies: [], regions: [] });
    return true;
  } };
  await assert.rejects(f.delivery.list(f.a.customerId, options), { code: 'ACCOUNT_DISABLED' });
  await assert.rejects(f.assign(), { code: 'ACCOUNT_DISABLED' });
});
test('invalid paths, damaged persisted receipt and oversized receipt never become empty or accessible', async t => {
  const f = await fixture(t);
  await assert.rejects(f.assign({ customerId: '../escape' }), { code: 'INVALID_CUSTOMER' });
  await assert.rejects(f.assign({ reportId: '../report' }), { code: 'INVALID_ASSIGNMENT' });
  await assert.rejects(f.assign({ unexpected: true }), { code: 'INVALID_FIELDS' });
  await f.assign();
  await fs.writeFile(f.receipt(), '{broken');
  await assert.rejects(f.delivery.list(f.a.customerId, f.options), { code: 'DELIVERY_RECEIPT_INVALID' });
  await fs.writeFile(f.receipt(), Buffer.alloc(4 * 1024 * 1024 + 1));
  await assert.rejects(f.delivery.list(f.a.customerId, f.options), { code: 'DELIVERY_RECEIPT_INVALID' });
});
test('internal PDF access returns only an authorized fixed issued report and is separate from the customer DTO', async t => {
  const f = await fixture(t); await f.assign();
  assert.deepEqual(await f.delivery.authorizedReport(f.a.customerId, f.seed.id, f.options), f.seed);
  assert.equal((await f.delivery.detail(f.a.customerId, f.seed.id, f.options)).notes, undefined);
});
test('saved action plan reaches customers with only its exact opaque evidence labels and no source contents', async t => {
  const f = await fixture(t);
  const { listMonthlyReportActionEvidence } = require('./lib/monthly_report_actions.cjs');
  const ref = listMonthlyReportActionEvidence(f.seed.snapshot).find(row => row.id.startsWith('summary-lodging:'));
  f.seed.snapshot.actionPlan = { schemaVersion: 1, summary: '숙박 추이를 점검하세요.', items: [{ id: 'one', title: '요일별 설명 검토',
    owner: '운영 담당', dueDate: '2026-11-01', status: 'completed', evidenceRefs: [ref.id], outcome: '담당자 작성 메모' }] };
  f.seed.snapshot.actionEvidence = [{ id: ref.id, label: 'private forged label' }];
  f.seed.snapshotHash = digest(f.seed.snapshot); await f.save(f.seed); await f.assign();
  const detail = await f.delivery.detail(f.a.customerId, f.seed.id, f.options);
  assert.deepEqual(detail.snapshot.actionPlan, f.seed.snapshot.actionPlan);
  assert.deepEqual(detail.snapshot.actionEvidence, [ref], 'labels are derived from saved evidence, never an untrusted side list');
  assert.equal(JSON.stringify(detail).includes('private'), false);
  assert.equal(detail.snapshot.actionPlan.items[0].outcome, '담당자 작성 메모', 'completed is author-supplied, not an independently verified outcome');
});
test('action plans cannot bind arbitrary raw paths, another snapshot evidence or explicit null', async t => {
  const f = await fixture(t);
  for (const plan of [null, { schemaVersion: 1, summary: '', items: [{ id: 'one', title: '검토', owner: '', dueDate: null,
    status: 'planned', evidenceRefs: ['/private/raw.json'], outcome: '' }] }]) {
    const snapshot = { ...f.seed.snapshot, actionPlan: plan };
    await f.save({ ...f.seed, snapshot, snapshotHash: digest(snapshot) });
    await assert.rejects(f.assign(), error => ['invalid_action_plan', 'invalid_action_evidence', 'corrupt_report'].includes(error.code));
  }
  assert.equal(await fs.stat(f.receipt()).then(() => true, () => false), false);
});
test('a linked or structurally substituted receipt is refused while the original bytes stay intact', async t => {
  const f = await fixture(t); await f.assign();
  const bytes = await fs.readFile(f.receipt()), link = path.join(f.root, 'receipt-alias.json');
  await fs.link(f.receipt(), link);
  await assert.rejects(f.delivery.list(f.a.customerId, f.options), { code: 'DELIVERY_RECEIPT_INVALID' });
  assert.deepEqual(await fs.readFile(link), bytes); await fs.unlink(link);
  const record = JSON.parse(bytes); record.customerId = f.b.customerId;
  await fs.writeFile(f.receipt(), JSON.stringify(record));
  await assert.rejects(f.delivery.detail(f.a.customerId, f.seed.id, f.options), { code: 'DELIVERY_RECEIPT_INVALID' });
});
test('a receipt disappearing between metadata and open is not mislabeled an empty assignment list', async t => {
  const f = await fixture(t); await f.assign(); let removed = false;
  const racing = f.make({ fileSystem: { ...fs, open: async (file, ...args) => {
    if (file === f.receipt() && !removed) { removed = true; await fs.unlink(file); }
    return fs.open(file, ...args);
  } } });
  await assert.rejects(racing.list(f.a.customerId, f.options), { code: 'DELIVERY_RECEIPT_INVALID' });
});
