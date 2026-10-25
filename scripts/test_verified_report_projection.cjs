'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { createVerifiedReportProjectionReader } = require('./lib/verified_report_projection.cjs');
const { createMonthlyReportService } = require('./lib/monthly_reports.cjs');
const { createMonthlyReportDelivery } = require('./lib/monthly_report_delivery.cjs');

const NOW = '2026-10-25T12:00:00.000Z';
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const copy = value => structuredClone(value);
const pause = () => new Promise(resolve => setTimeout(resolve, 2));

async function directoryFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'verified-report-projection-'));
  const directory = path.join(root, 'reports'); await fs.mkdir(directory);
  t.after(async () => {
    const absolute = path.resolve(root);
    assert.equal(path.dirname(absolute), path.resolve(os.tmpdir()));
    assert.ok(path.basename(absolute).startsWith('verified-report-projection-'));
    await fs.rm(absolute, { recursive: true, force: true });
  });
  const file = id => path.join(directory, id + '.json');
  const write = (id, value) => fs.writeFile(file(id), JSON.stringify(value));
  const make = (extra = {}) => createVerifiedReportProjectionReader({ directory, fileFor: file,
    parse: JSON.parse, project: value => ({ value: value.value }), ...extra });
  return { root, directory, file, write, make };
}

function proxiedHandle(handle, read) {
  return new Proxy(handle, { get(target, key) {
    if (key === 'read') return (...args) => read(target, args);
    const value = Reflect.get(target, key, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
}

test('a cache hit hashes every byte but avoids parsing and returns a detached projection', async t => {
  const f = await directoryFixture(t); const body = { value: { sold: 0, revenue: null }, privatePayload: 'x'.repeat(300000) };
  await f.write('one', body); let parses = 0;
  const reader = f.make({ parse: text => { parses++; return JSON.parse(text); } });
  const first = await reader.read('one'), initial = reader.metrics();
  first.value.sold = 999;
  const second = await reader.read('one'), after = reader.metrics();
  assert.deepEqual(second, { value: { sold: 0, revenue: null } });
  assert.equal(parses, 1); assert.equal(after.cacheHits, 1);
  assert.equal(after.hashedBytes - initial.hashedBytes, Buffer.byteLength(JSON.stringify(body)));
  assert.equal(after.entries, 1); assert.ok(after.serializedBytes < 200);
  assert.equal(JSON.stringify(second).includes('privatePayload'), false);
});

test('same-size edits with restored mtime revalidate bytes rather than reusing stale metadata', async t => {
  const f = await directoryFixture(t); await f.write('one', { value: 'AAAA', privatePayload: 'same' });
  const reader = f.make(); assert.deepEqual(await reader.read('one'), { value: 'AAAA' });
  const before = await fs.stat(f.file('one'));
  await pause(); await f.write('one', { value: 'BBBB', privatePayload: 'same' });
  await fs.utimes(f.file('one'), before.atime, before.mtime);
  assert.equal((await fs.stat(f.file('one'))).size, before.size);
  assert.deepEqual(await reader.read('one'), { value: 'BBBB' });
  assert.equal(reader.metrics().cacheHits, 0); assert.equal(reader.metrics().parsedReports, 2);
});

test('a separate process rewrite is detected and a new reader independently validates disk', async t => {
  const f = await directoryFixture(t); await f.write('one', { value: 'AAAA' });
  const reader = f.make(); await reader.read('one');
  const child = spawnSync(process.execPath, ['-e', "require('node:fs').writeFileSync(process.argv[1],process.argv[2])", f.file('one'), JSON.stringify({ value: 'BBBB' })], { encoding: 'utf8', windowsHide: true });
  assert.equal(child.status, 0, 'isolated child rewrite succeeds');
  assert.deepEqual(await reader.read('one'), { value: 'BBBB' });
  const restarted = f.make(); assert.deepEqual(await restarted.read('one'), { value: 'BBBB' });
  assert.equal(restarted.metrics().parsedReports, 1); assert.equal(restarted.metrics().cacheHits, 0);
});

test('deleted cached reports fail closed and cannot survive through a stale projection', async t => {
  const f = await directoryFixture(t); await f.write('one', { value: 1 }); const reader = f.make(); await reader.read('one');
  await fs.unlink(f.file('one'));
  await assert.rejects(reader.read('one'), { code: 'report_not_found', statusCode: 404 });
  assert.equal(reader.metrics().entries, 0);
  await f.write('one', { value: 2 }); assert.deepEqual(await reader.read('one'), { value: 2 });
});

test('symlink substitution is rejected even after the cache was populated', async t => {
  const f = await directoryFixture(t); await f.write('one', { value: 'safe' }); const reader = f.make(); await reader.read('one');
  const held = path.join(f.root, 'held.json'); await fs.rename(f.file('one'), held);
  try { await fs.symlink(held, f.file('one'), 'file'); }
  catch (error) { if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) { t.skip('host does not grant file symlink creation'); return; } throw error; }
  await assert.rejects(reader.read('one'), { code: 'corrupt_report' });
  assert.equal(reader.metrics().entries, 0);
});

test('a hard link to a previously cached report is rejected independently of symlink permissions', async t => {
  const f = await directoryFixture(t); await f.write('one', { value: 'safe' }); const reader = f.make(); await reader.read('one');
  await fs.link(f.file('one'), path.join(f.root, 'second-link.json'));
  await assert.rejects(reader.read('one'), { code: 'corrupt_report' });
  assert.equal(reader.metrics().entries, 0);
});

test('a linked directory or fileFor path escape cannot use cached report metadata', async t => {
  const f = await directoryFixture(t); await f.write('one', { value: 'safe' });
  const escaped = f.make({ fileFor: () => path.join(f.root, 'outside.json') });
  await assert.rejects(escaped.read('one'), { code: 'corrupt_report' });
  const linkedDirectory = path.join(f.root, 'linked-reports');
  try { await fs.symlink(f.directory, linkedDirectory, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) { t.skip('host does not grant linked directory creation'); return; } throw error; }
  const reader = createVerifiedReportProjectionReader({ directory: linkedDirectory, fileFor: id => path.join(linkedDirectory, id + '.json'), parse: JSON.parse, project: value => value });
  await assert.rejects(reader.read('one'), { code: 'corrupt_report' });
});

test('deletion between lstat and open is an integrity failure, not an empty or missing-result success', async t => {
  const f = await directoryFixture(t); await f.write('one', { value: 'safe' }); let deleted = false;
  const reader = f.make({ fileSystem: { ...fs, open: async (file, ...args) => {
    if (file === f.file('one') && !deleted) { deleted = true; await fs.unlink(file); }
    return fs.open(file, ...args);
  } } });
  await assert.rejects(reader.read('one'), { code: 'corrupt_report' });
  assert.equal(reader.metrics().entries, 0);
});

test('replacement between metadata and open cannot change the file identity silently', async t => {
  const f = await directoryFixture(t); await f.write('one', { value: 'AAAA' }); let replaced = false;
  const reader = f.make({ fileSystem: { ...fs, open: async (file, ...args) => {
    if (file === f.file('one') && !replaced) { replaced = true; await fs.rename(file, file + '.held'); await f.write('one', { value: 'BBBB' }); }
    return fs.open(file, ...args);
  } } });
  await assert.rejects(reader.read('one'), { code: 'corrupt_report' });
  assert.equal(reader.metrics().entries, 0);
});

test('in-place mutation while streaming rejects the entire read and clears prior cache', async t => {
  const f = await directoryFixture(t); await f.write('one', { value: 'AAAA', padding: 'x'.repeat(300000) });
  let armed = false, changed = false;
  const reader = f.make({ fileSystem: { ...fs, open: async (...args) => proxiedHandle(await fs.open(...args), async (handle, args2) => {
    const result = await handle.read(...args2);
    if (armed && !changed && result.bytesRead) { changed = true; await f.write('one', { value: 'BBBB', padding: 'x'.repeat(300000) }); }
    return result;
  }) } });
  await reader.read('one'); armed = true;
  await assert.rejects(reader.read('one'), { code: 'corrupt_report' });
  assert.equal(reader.metrics().entries, 0);
});

test('growth after stream open is rejected and is never truncated to the old byte length', async t => {
  const f = await directoryFixture(t); await f.write('one', { value: 'AAAA' }); let changed = false;
  const reader = f.make({ fileSystem: { ...fs, open: async (...args) => proxiedHandle(await fs.open(...args), async (handle, args2) => {
    const result = await handle.read(...args2);
    if (!changed && result.bytesRead) { changed = true; await fs.appendFile(f.file('one'), ' '); }
    return result;
  }) } });
  await assert.rejects(reader.read('one'), { code: 'corrupt_report' });
  assert.equal(reader.metrics().entries, 0);
});

test('small entry-count and byte budgets evict only projections and can safely reparse later', async t => {
  const f = await directoryFixture(t); for (const id of ['one', 'two', 'three']) await f.write(id, { value: id });
  const reader = f.make({ maxEntries: 2, maxCacheBytes: 60 });
  await reader.read('one'); await reader.read('two'); await reader.read('one'); await reader.read('three');
  assert.equal(reader.metrics().entries, 2); assert.ok(reader.metrics().serializedBytes <= 60);
  const parsed = reader.metrics().parsedReports; await reader.read('two');
  assert.equal(reader.metrics().parsedReports, parsed + 1); assert.ok(reader.metrics().evictions >= 2);
  assert.ok(reader.metrics().serializedBytes <= 60);
  const byteBound = f.make({ maxEntries: 20, maxCacheBytes: 33 });
  await byteBound.read('one'); await byteBound.read('two'); await byteBound.read('three');
  assert.ok(byteBound.metrics().serializedBytes <= 33); assert.ok(byteBound.metrics().evictions >= 1);
});

test('oversized projections are returned detached but never retained; report byte bounds are enforced', async t => {
  const f = await directoryFixture(t); await f.write('one', { value: 'x'.repeat(120) });
  const reader = f.make({ maxCacheBytes: 20 });
  assert.deepEqual(await reader.read('one'), { value: 'x'.repeat(120) }); await reader.read('one');
  assert.equal(reader.metrics().entries, 0); assert.equal(reader.metrics().serializedBytes, 0);
  assert.equal(reader.metrics().oversizedProjections, 2); assert.equal(reader.metrics().parsedReports, 2);
  const bounded = f.make({ maxReportBytes: 32 }); await assert.rejects(bounded.read('one'), { code: 'corrupt_report' });
  await fs.writeFile(f.file('empty'), ''); await assert.rejects(reader.read('empty'), { code: 'corrupt_report' });
});

test('concurrent callers cannot overwrite the shared streaming buffer or exchange projections', async t => {
  const f = await directoryFixture(t); const ids = Array.from({ length: 6 }, (_, i) => 'report-' + i);
  for (const [index, id] of ids.entries()) await f.write(id, { value: { index, padding: String(index).repeat(280000) } });
  let active = 0, maximum = 0;
  const reader = f.make({ maxCacheBytes: 3 * 1024 * 1024, fileSystem: { ...fs, open: async (...args) => proxiedHandle(await fs.open(...args), async (handle, args2) => {
    active++; maximum = Math.max(maximum, active);
    try { await pause(); return await handle.read(...args2); } finally { active--; }
  }) } });
  const values = await Promise.all(ids.map(id => reader.read(id)));
  values.forEach((value, i) => assert.deepEqual(value.value, { index: i, padding: String(i).repeat(280000) }));
  assert.equal(maximum, 1); assert.equal(reader.metrics().parsedReports, ids.length);
  const hits = await Promise.all(ids.map(id => reader.read(id)));
  hits.forEach((value, i) => assert.equal(value.value.index, i)); assert.equal(reader.metrics().cacheHits, ids.length);
});

async function deliveryFixture(t) {
  const f = await directoryFixture(t), id = 'mr_' + crypto.randomUUID();
  const snapshot = { schemaVersion: 1, target: { type: 'company', id: 'cmp_isolated', label: 'Isolated fixture' },
    period: { start: '2026-09-01', end: '2026-09-30', days: 30, cutoffDate: '2026-09-30', monthClosed: true },
    summary: { lodging: { supply: 10, sold: 3, publicBookings: 2, phoneBookings: 1, actualRevenue: null, estimatedRevenue: null,
      publicRevenue: 200, phoneRevenue: null, knownPartialRevenue: 0, partial: true, revenuePartial: true }, dayuse: { supply: null, sold: null } },
    quality: { status: 'partial', provisional: false, missingCompanyDays: 29 }, daily: [],
    sources: { observations: [{ privateOnly: 'not in customer DTO' }] } };
  const seed = { schemaVersion: 1, id, revision: 3, version: 1, status: 'published', type: 'company', month: '2026-09', targetId: 'cmp_isolated',
    title: 'AAAA', notes: 'AAAA', publishedAt: NOW, createdAt: NOW, updatedAt: NOW, snapshot, snapshotHash: hash(snapshot) };
  const reportFile = path.join(f.directory, id + '.json'), save = value => fs.writeFile(reportFile, JSON.stringify(value)); await save(seed);
  const reports = createMonthlyReportService({ dataDir: f.directory, loadSources: async () => assert.fail('list projection must never calculate sources') });
  const customers = new Map([['cus_fixture-a', { customerId: 'cus_fixture-a', accountStatus: 'active' }], ['cus_fixture-b', { customerId: 'cus_fixture-b', accountStatus: 'active' }]]);
  const deliveryDir = path.join(f.root, 'delivery'), make = (extra = {}) => createMonthlyReportDelivery({ dataDir: deliveryDir, reports, customers: { get: key => customers.get(key) }, now: () => NOW, ...extra });
  const delivery = make(), access = { verifyAccess: () => customers.get('cus_fixture-a') };
  await delivery.assign({ customerId: 'cus_fixture-a', reportId: id, actorId: 'isolated-admin', requestKey: 'isolated-test-assignment-0001' });
  return { ...f, id, seed, save, reportFile, reports, customers, delivery, access, make, receiptFile: path.join(deliveryDir, 'cus_fixture-a.json') };
}

test('real service projection preserves list metadata, null/zero and cached return mutation isolation', async t => {
  const f = await deliveryFixture(t); const initial = await f.delivery.list('cus_fixture-a', f.access);
  assert.equal(initial.reports.length, 1); assert.equal(initial.reports[0].summary.lodging.actualRevenue, null);
  assert.equal(initial.reports[0].summary.lodging.knownPartialRevenue, 0); assert.equal(initial.reports[0].quality.status, 'partial');
  const bytes = Buffer.byteLength(await fs.readFile(f.reportFile)), before = f.reports.deliveryListReadMetrics();
  initial.reports[0].summary.lodging.sold = 999; initial.reports[0].title = 'mutated';
  const second = await f.delivery.list('cus_fixture-a', f.access), after = f.reports.deliveryListReadMetrics();
  assert.equal(second.reports[0].summary.lodging.sold, 3); assert.equal(second.reports[0].title, 'AAAA');
  assert.equal(after.cacheHits, before.cacheHits + 1); assert.equal(after.parsedReports, before.parsedReports);
  assert.equal(after.hashedBytes - before.hashedBytes, bytes);
  assert.equal(JSON.stringify(second).includes('privateOnly'), false);
});

test('cached list rejects changed body, recomputed snapshot hash, notes, future metadata and publication state', async t => {
  const f = await deliveryFixture(t); await f.delivery.list('cus_fixture-a', f.access);
  const changedSnapshot = { ...f.seed.snapshot, altered: true };
  const mutations = [
    [{ ...f.seed, snapshot: changedSnapshot }, ['corrupt_report']],
    [{ ...f.seed, snapshot: changedSnapshot, snapshotHash: hash(changedSnapshot) }, ['REPORT_INTEGRITY_CHANGED']],
    [{ ...f.seed, title: 'BBBB' }, ['REPORT_INTEGRITY_CHANGED']],
    [{ ...f.seed, notes: 'BBBB' }, ['REPORT_INTEGRITY_CHANGED']],
    [{ ...f.seed, futureInternalMetadata: 'changed' }, ['REPORT_INTEGRITY_CHANGED']],
    [{ ...f.seed, status: 'draft' }, ['PUBLISHED_REPORT_REQUIRED']],
    [{ ...f.seed, version: 2 }, ['REPORT_INTEGRITY_CHANGED']]
  ];
  for (const [value, codes] of mutations) {
    await f.save(value);
    await assert.rejects(f.delivery.list('cus_fixture-a', f.access), error => codes.includes(error.code));
    await f.save(f.seed); assert.equal((await f.delivery.list('cus_fixture-a', f.access)).reports[0].title, 'AAAA');
  }
});

test('same-size body and metadata tampering remain detected when the old mtime is restored', async t => {
  const f = await deliveryFixture(t); await f.delivery.list('cus_fixture-a', f.access);
  const before = await fs.stat(f.reportFile); const changed = { ...f.seed, notes: 'BBBB' };
  assert.equal(Buffer.byteLength(JSON.stringify(changed)), before.size);
  await f.save(changed); await fs.utimes(f.reportFile, before.atime, before.mtime);
  await assert.rejects(f.delivery.list('cus_fixture-a', f.access), { code: 'REPORT_INTEGRITY_CHANGED' });
});

test('optimized cache hits recheck session and account after report I/O before returning list data', async t => {
  const f = await deliveryFixture(t); await f.delivery.list('cus_fixture-a', f.access);
  let authorized = true, reads = 0;
  const guarded = f.make({ reports: { get: f.reports.get, getPublishedListSummary: async id => {
    const result = await f.reports.getPublishedListSummary(id); reads++; authorized = false; return result;
  } } });
  await assert.rejects(guarded.list('cus_fixture-a', { verifyAccess: () => authorized }), { code: 'LOGIN_REQUIRED' });
  assert.equal(reads, 1);
  const accountGuarded = f.make({ reports: { get: f.reports.get, getPublishedListSummary: async id => {
    const result = await f.reports.getPublishedListSummary(id); f.customers.get('cus_fixture-a').accountStatus = 'disabled'; return result;
  } } });
  await assert.rejects(accountGuarded.list('cus_fixture-a', { verifyAccess: () => true }), { code: 'ACCOUNT_DISABLED' });
});

test('each list reads current assignments; unassigned customers never trigger report projection reads', async t => {
  const f = await deliveryFixture(t); await f.delivery.list('cus_fixture-a', f.access);
  let reads = 0;
  const guarded = f.make({ reports: { get: f.reports.get, getPublishedListSummary: async id => { reads++; return f.reports.getPublishedListSummary(id); } } });
  assert.deepEqual(await guarded.list('cus_fixture-b', { verifyAccess: () => f.customers.get('cus_fixture-b') }), { reports: [] });
  assert.equal(reads, 0);
  const record = JSON.parse(await fs.readFile(f.receiptFile, 'utf8')); record.revision++; record.assignments = []; record.commands = [];
  await fs.writeFile(f.receiptFile, JSON.stringify(record));
  assert.deepEqual(await guarded.list('cus_fixture-a', f.access), { reports: [] }); assert.equal(reads, 0);
});

test('invalid reader limits reject configuration rather than create an unbounded cache', () => {
  const valid = { directory: os.tmpdir(), fileFor: id => path.join(os.tmpdir(), id), parse: JSON.parse, project: x => x };
  for (const key of ['maxEntries', 'maxCacheBytes', 'maxReportBytes']) for (const value of [0, -1, 1.5, Infinity]) {
    assert.throws(() => createVerifiedReportProjectionReader({ ...valid, [key]: value }), TypeError);
  }
});
