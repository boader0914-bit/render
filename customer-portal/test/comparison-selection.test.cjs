'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const selection = require('../web/comparison-selection.js');
function memoryStorage() {
  const values = new Map();
  return { getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key), values };
}
function options(extra = {}) {
  return {
    storage: memoryStorage(), now: () => new Date('2026-10-25T00:00:00Z'), scope: 'opaque-customer-a', permissionSignature: 'relations-v1',
    ownCompanyId: 'own-a', authorizedOwnCompanyIds: ['own-a', 'own-b'], authorizedComparisonIds: ['same-a', 'same-b', 'other-a', 'unknown-a'],
    authorizedComparisonIdsByOwn: { 'own-a': ['same-a', 'same-b', 'other-a', 'unknown-a'], 'own-b': ['other-a'] },
    companies: [{ companyId: 'own-a', regionKey: 'region-1' }, { companyId: 'own-b', regionKey: 'region-2' }, { companyId: 'same-a', regionKey: 'region-1' },
      { companyId: 'same-b', regionKey: 'region-1' }, { companyId: 'other-a', regionKey: 'region-2' }, { companyId: 'unknown-a' }], ...extra
  };
}
test('KST upcoming period contains exactly thirty inclusive real dates across the month boundary', () => {
  const state = selection.createStore(options({ now: () => new Date('2026-10-24T15:00:00Z') })).getState();
  assert.equal(state.stayStart, '2026-10-25'); assert.equal(state.stayEnd, '2026-11-23');
  assert.equal(state.asOfDate, '2026-10-25'); assert.equal(state.ownCompanyId, 'own-a');
  assert.equal(state.regionContext.ownRegionKey, 'region-1');
});
test('leap dates and month boundaries are validated without silently rolling invalid input', () => {
  assert.equal(selection.validDate('2024-02-29'), true); assert.equal(selection.validDate('2026-02-29'), false);
  assert.equal(selection.validDate('2026-04-31'), false); assert.equal(selection.validDate('2026-2-01'), false);
  assert.deepEqual(selection.monthRange('2024-02'), { start: '2024-02-01', end: '2024-02-29' });
  assert.deepEqual(selection.monthRange('2026-12'), { start: '2026-12-01', end: '2026-12-31' });
  assert.equal(selection.monthRange('2026-13'), null);
  const store = selection.createStore(options()), original = store.getState();
  assert.equal(store.update({ stayMode: 'custom', stayStart: '2026-02-29', stayEnd: '2026-03-10' }).ok, false);
  assert.deepEqual(store.getState(), original);
  assert.equal(store.update({ stayMode: 'custom', stayStart: '2026-10-29', stayEnd: '2026-10-20' }).ok, false);
  assert.equal(store.update({ stayMode: 'month', stayMonth: '2026-13' }).ok, false);
});
test('past-month as-of uses that month end rather than present freshness and never accepts a future cutoff', () => {
  const store = selection.createStore(options());
  const result = store.update({ stayMode: 'month', stayMonth: '2026-09' });
  assert.equal(result.ok, true); assert.equal(result.state.stayStart, '2026-09-01');
  assert.equal(result.state.stayEnd, '2026-09-30'); assert.equal(result.state.asOfDate, '2026-09-30');
  assert.equal(store.update({ asOfDate: '2026-09-26' }).state.asOfDate, '2026-09-26');
  assert.equal(store.update({ selectedView: 'regions' }).state.asOfDate, '2026-09-26');
  assert.equal(store.update({ asOfDate: '2026-10-26' }).ok, false);
  assert.equal(store.update({ stayMode: 'month', stayMonth: '2026-10' }).state.asOfDate, '2026-10-25');
});
test('same, cross, mixed and unknown relationships use actual canonical region keys', () => {
  const store = selection.createStore(options());
  assert.equal(store.update({ comparisonIds: ['same-a', 'same-b'] }).state.regionContext.mode, 'same-region');
  assert.equal(store.getState().regionContext.groups.length, 1, 'one background per distinct region');
  assert.equal(store.update({ comparisonIds: ['other-a'] }).state.regionContext.mode, 'cross-region');
  const mixed = store.update({ comparisonIds: ['same-a', 'other-a'] }).state;
  assert.equal(mixed.regionContext.mode, 'mixed'); assert.equal(mixed.regionContext.groups.length, 2);
  const unknown = store.update({ comparisonIds: ['unknown-a'] }).state;
  assert.equal(unknown.regionContext.mode, 'unknown'); assert.equal(unknown.regionContext.hasUnknown, true);
  assert.deepEqual(unknown.regionContext.missingCompanyIds, ['unknown-a']);
  assert.equal(unknown.regionContext.comparisons[0].regionKey, null);
});
test('unregistered and planned businesses never get a fictitious own company or fallback region', () => {
  const unregistered = selection.createStore(options({ ownCompanyId: null, authorizedOwnCompanyIds: [] })).getState();
  assert.equal(unregistered.ownCompanyId, null); assert.equal(unregistered.regionContext.mode, 'unregistered');
  assert.equal(unregistered.regionContext.ownRegionKey, null); assert.deepEqual(unregistered.comparisonIds, []);
  const planned = selection.createStore(options({ ownCompanyId: null, authorizedOwnCompanyIds: [], businessStatus: 'planned', plannedRegionKey: 'region-3' })).getState();
  assert.equal(planned.regionContext.mode, 'planned'); assert.equal(planned.regionContext.ownRegionKey, null);
  assert.equal(planned.regionContext.plannedRegionKey, 'region-3');
});
test('same-scope reload restores one selection while URL encoding allows selection fields only', () => {
  const input = options(), store = selection.createStore(input);
  store.update({ comparisonIds: ['same-a', 'other-a'], stayMode: 'month', stayMonth: '2026-09', asOfDate: '2026-09-26', selectedView: 'products', password: 'never-write', regionContext: { ownRegionKey: 'wrong' }, role: 'admin' });
  const query = store.toQuery(), restored = selection.createStore(input);
  assert.deepEqual(restored.getState(), store.getState());
  assert.equal(new URLSearchParams(query).get('stayMonth'), '2026-09');
  assert.doesNotMatch(query, /password|role|regionContext|scope|permission/);
  const saved = [...input.storage.values.values()].join('');
  assert.doesNotMatch(saved, /opaque-customer-a|relations-v1|never-write|password|regionLabel/);
  const fromUrl = selection.createStore(options({ url: 'https://insight.example/compare?' + query + '&accessToken=never-write' }));
  assert.deepEqual(fromUrl.getState(), store.getState());
});
test('back navigation restores complete historical period and selected view', () => {
  const store = selection.createStore(options());
  store.update({ comparisonIds: ['same-a'], stayMode: 'month', stayMonth: '2026-09', selectedView: 'flow' }); const old = store.toQuery();
  store.update({ comparisonIds: ['other-a'], stayMode: 'custom', stayStart: '2026-10-10', stayEnd: '2026-10-14', selectedView: 'regions' });
  store.restoreUrl('?' + old);
  assert.equal(store.getState().stayMonth, '2026-09'); assert.equal(store.getState().asOfDate, '2026-09-30');
  assert.deepEqual(store.getState().comparisonIds, ['same-a']); assert.equal(store.getState().selectedView, 'flow');
});
test('own-company changes clear competitor selection and invalidate in-flight requests', () => {
  const store = selection.createStore(options()); store.update({ comparisonIds: ['same-a'] }); const old = store.requestToken();
  store.update({ ownCompanyId: 'own-b' });
  assert.equal(store.isCurrent(old), false); assert.deepEqual(store.getState().comparisonIds, []);
  assert.equal(store.getState().regionContext.ownRegionKey, 'region-2');
  assert.equal(store.update({ comparisonIds: ['same-a'] }).ok, false);
  assert.equal(store.update({ comparisonIds: ['other-a'] }).ok, true);
});
test('permission changes, removal and account changes recheck authority and invalidate late responses', () => {
  const input = options(), store = selection.createStore(input);
  store.update({ comparisonIds: ['same-a', 'other-a'], stayMode: 'month', stayMonth: '2026-09' }); let token = store.requestToken();
  store.configure({ permissionSignature: 'relations-v2', authorizedComparisonIds: ['same-a'] });
  assert.equal(store.isCurrent(token), false); assert.deepEqual(store.getState().comparisonIds, ['same-a']);
  token = store.requestToken(); store.configure({ permissionSignature: 'relations-v3' });
  assert.equal(store.isCurrent(token), false, 'unmodified visible values do not keep old request authorization');
  store.configure({ authorizedOwnCompanyIds: [], ownCompanyId: null });
  assert.equal(store.getState().ownCompanyId, null); assert.deepEqual(store.getState().comparisonIds, []);
  store.configure({ scope: 'other-customer', ownCompanyId: 'own-b', authorizedOwnCompanyIds: ['own-b'] });
  assert.equal(store.getState().stayMode, 'upcoming30'); assert.equal(store.getState().ownCompanyId, 'own-b');
});
test('persisted state cannot cross scope or permission partitions', () => {
  const input = options(), first = selection.createStore(input); first.update({ comparisonIds: ['same-a'], selectedView: 'regions' });
  assert.deepEqual(selection.createStore({ ...input, scope: 'different' }).getState().comparisonIds, []);
  first.update({ selectedView: 'products' });
  assert.equal(selection.createStore({ ...input, permissionSignature: 'new-relations' }).getState().selectedView, 'flow');
});
test('authorization and malformed URL values never introduce unauthorized companies or fake regions', () => {
  const store = selection.createStore(options({ url: '?ownCompanyId=evil&comparisonIds=other-a,secret-company&regionContext=region-9&stayMode=month&stayMonth=2026-02' }));
  assert.equal(store.getState().ownCompanyId, 'own-a'); assert.deepEqual(store.getState().comparisonIds, ['other-a']);
  assert.equal(store.getState().regionContext.ownRegionKey, 'region-1');
  assert.equal(store.update({ ownCompanyId: 'secret-company' }).ok, false);
  assert.equal(store.update({ comparisonIds: ['same-a', 'same-a'] }).ok, false);
  assert.deepEqual(selection.decodeSelection('?stayMonth=2026-09&stayMonth=2026-10&unknown=1'), {});
  assert.deepEqual(selection.decodeSelection('x'.repeat(9000)), {});
});
test('bad caches and blocked or full sessionStorage safely fall back to normal selection', () => {
  const storage = memoryStorage(); storage.setItem(selection.STORAGE_KEY, '{bad-json');
  assert.equal(selection.createStore(options({ storage })).getState().ownCompanyId, 'own-a');
  const blocked = { getItem() { throw Error('blocked'); }, setItem() { throw Error('quota'); }, removeItem() { throw Error('blocked'); } };
  assert.equal(selection.createStore(options({ storage: blocked })).update({ selectedView: 'products' }).ok, true);
  const context = { window: {}, URLSearchParams, URL, Date, Object, Set, Map, JSON, Math };
  Object.defineProperty(context, 'sessionStorage', { get() { throw Error('blocked'); } });
  vm.runInNewContext(fs.readFileSync(require.resolve('../web/comparison-selection.js'), 'utf8'), context);
  assert.equal(context.window.InsightComparisonSelection.createStore(options({ storage: undefined })).getState().ownCompanyId, 'own-a');
});
test('snapshot isolation, optional cache expiry and clear avoid mutation and stale request reuse', () => {
  let instant = '2026-10-25T00:00:00Z'; const input = options({ now: () => new Date(instant) }), store = selection.createStore(input);
  const seen = []; const unsubscribe = store.subscribe(s => seen.push(s.selectedView)); const token = store.requestToken();
  const snapshot = store.getState(); snapshot.comparisonIds.push('secret-company'); snapshot.regionContext.ownRegionKey = 'wrong';
  assert.deepEqual(store.getState().comparisonIds, []); assert.equal(store.getState().regionContext.ownRegionKey, 'region-1');
  store.update({ selectedView: 'products' }); assert.equal(store.isCurrent(token), false); assert.deepEqual(seen, ['products']); unsubscribe();
  instant = '2026-10-26T00:00:00Z';
  assert.equal(selection.createStore(input).getState().stayStart, '2026-10-26');
  const newest = store.requestToken(); store.clear(); assert.equal(store.isCurrent(newest), false);
});
test('registration metadata changes recompute region context without persisting addresses or customer records', () => {
  const input = options(), store = selection.createStore(input); store.update({ comparisonIds: ['same-a'] }); const token = store.requestToken();
  store.configure({ companies: input.companies.map(c => c.companyId === 'same-a' ? { ...c, regionKey: 'region-2', address: 'do-not-store' } : c) });
  assert.equal(store.getState().regionContext.mode, 'cross-region'); assert.equal(store.isCurrent(token), false);
  assert.doesNotMatch([...input.storage.values.values()].join(''), /do-not-store|region-2/);
});
test('invalid views and oversized custom ranges do not change the previous valid state', () => {
  const store = selection.createStore(options()); const before = store.getState();
  assert.equal(store.update({ selectedView: 'admin' }).ok, false);
  assert.equal(store.update({ stayMode: 'custom', stayStart: '2024-01-01', stayEnd: '2026-01-01' }).ok, false);
  assert.deepEqual(store.getState(), before);
});
test('URL restoration is a complete snapshot: omitted competitors never leak from a previous own store', () => {
  const store = selection.createStore(options());
  store.update({ ownCompanyId: 'own-b', comparisonIds: ['other-a'] });
  store.restoreUrl('?ownCompanyId=own-a&stayMode=month&stayMonth=2026-09&asOfDate=2026-09-30&selectedView=flow');
  assert.equal(store.getState().ownCompanyId, 'own-a'); assert.deepEqual(store.getState().comparisonIds, []);
  const empty = store.toQuery(); store.update({ comparisonIds: ['same-a'] }); store.restoreUrl(empty);
  assert.deepEqual(store.getState().comparisonIds, []);
  const input = options(); const previous = selection.createStore(input); previous.update({ comparisonIds: ['same-a'] });
  assert.deepEqual(selection.createStore({ ...input, url: '?ownCompanyId=own-b&selectedView=regions' }).getState().comparisonIds, []);
});
test('KST midnight rolls upcoming dates and invalidates old requests but preserves explicit historical cutoff', () => {
  let instant = '2026-10-25T14:59:59Z'; const store = selection.createStore(options({ now: () => new Date(instant) }));
  store.update({ comparisonIds: ['same-a'] }); const token = store.requestToken();
  instant = '2026-10-25T15:00:00Z';
  assert.equal(store.isCurrent(token), false); assert.equal(store.getState().stayStart, '2026-10-26');
  assert.equal(store.getState().stayEnd, '2026-11-24'); assert.equal(store.getState().asOfDate, '2026-10-26');
  store.update({ stayMode: 'month', stayMonth: '2026-09', asOfDate: '2026-09-26' }); const historical = store.requestToken();
  instant = '2026-10-26T15:00:00Z';
  assert.equal(store.isCurrent(historical), false); assert.equal(store.getState().asOfDate, '2026-09-26');
  assert.equal(store.getState().stayStart, '2026-09-01');
});
test('a provided per-own authorization map denies a missing own key instead of falling back to all competitors', () => {
  const store = selection.createStore(options({ authorizedComparisonIdsByOwn: { 'own-a': ['same-a'] } }));
  store.update({ ownCompanyId: 'own-b' });
  assert.equal(store.update({ comparisonIds: ['same-a'] }).ok, false);
  assert.deepEqual(store.getState().comparisonIds, []);
});
test('canonical comparison-purpose updates invalidate pending results without putting purpose rules in URLs', () => {
  const store = selection.createStore(options({ comparisonPurposes: { 'same-a': 'direct' } })); store.update({ comparisonIds: ['same-a'] });
  const token = store.requestToken(); store.configure({ comparisonPurposes: { 'same-a': 'reference' } });
  assert.equal(store.isCurrent(token), false); assert.doesNotMatch(store.toQuery(), /direct|reference|Purposes/);
  assert.deepEqual(store.getState().comparisonIds, ['same-a']);
});
test('logout clears all company access and invalidates tokens even when old authorized rows remain in caller context', () => {
  const input = options(), store = selection.createStore(input); store.update({ comparisonIds: ['same-a'] }); const token = store.requestToken();
  store.configure({ scope: '' });
  assert.equal(store.getState().ownCompanyId, null); assert.deepEqual(store.getState().comparisonIds, []); assert.equal(store.isCurrent(token), false);
  assert.equal(input.storage.getItem(selection.STORAGE_KEY), null);
});
test('comparison-set and authorization order do not create different selection identities', () => {
  const input = options(), store = selection.createStore(input); store.update({ comparisonIds: ['same-a', 'other-a'] });
  const token = store.requestToken(); store.update({ comparisonIds: ['other-a', 'same-a'] }); assert.equal(store.isCurrent(token), true);
  store.configure({ authorizedComparisonIds: [...input.authorizedComparisonIds].reverse(), authorizedOwnCompanyIds: [...input.authorizedOwnCompanyIds].reverse() });
  assert.equal(store.isCurrent(token), true);
});
test('actual planning registration status is normalized without inventing an own company', () => {
  const store = selection.createStore(options({ businessStatus: 'planning', ownCompanyId: null, authorizedOwnCompanyIds: [], plannedRegionKey: 'region-3' }));
  assert.equal(store.getState().regionContext.mode, 'planned'); assert.equal(store.getState().ownCompanyId, null);
  assert.equal(store.getState().regionContext.plannedRegionKey, 'region-3');
});
test('trusted canonical analysis-region keys take precedence over distinct address-level keys', () => {
  const input = options(); input.companies = input.companies.map(c => c.companyId === 'own-a' ? { ...c, regionKey: 'general-gu-1', analysisRegionKey: 'city-1' }
    : c.companyId === 'same-a' ? { ...c, regionKey: 'general-gu-2', analysisRegionKey: 'city-1' } : c);
  const store = selection.createStore(input); store.update({ comparisonIds: ['same-a'] });
  assert.equal(store.getState().regionContext.mode, 'same-region'); assert.equal(store.getState().regionContext.ownRegionKey, 'city-1');
  assert.equal(store.getState().regionContext.groups[0].regionKey, 'city-1');
});
test('civil-year bounds and December rollover do not return malformed extended ISO dates', () => {
  assert.equal(selection.validDate('0000-01-01'), false); assert.equal(selection.validDate('0001-01-01'), true);
  assert.equal(selection.validDate('9999-12-31'), true);
  assert.deepEqual(selection.monthRange('0099-12'), { start: '0099-12-01', end: '0099-12-31' });
  assert.deepEqual(selection.monthRange('9999-12'), { start: '9999-12-01', end: '9999-12-31' });
});
