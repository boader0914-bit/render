'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createPreviewStore } = require('../lib/preview-store.cjs');

function mutate(store, action, payload, profile = 'owner') {
  return store.act({ profile, revision: store.read(profile).revision, action, payload });
}
function expectFailure(store, action, payload, code, status = 400, profile = 'owner') {
  const before = store.read(profile);
  assert.throws(() => mutate(store, action, payload, profile), (error) => error.code === code && error.status === status);
  assert.deepEqual(store.read(profile), before, 'failed changes must not mutate any state');
}

test('invented fixtures have stable identities, consistent counts, and independent customer state', () => {
  const store = createPreviewStore();
  const owner = store.read('owner');
  const planning = store.read('planning');
  assert.equal(owner.mode, 'preview');
  assert.equal(owner.companies.length, 6);
  assert.equal(owner.regions.length, 5);
  for (const company of owner.companies) {
    assert.match(company.id, /^demo-/);
    assert.equal(company.metrics.supply, company.rooms * 30);
    assert.ok(company.metrics.publicBookings + company.metrics.inferredBookings <= company.metrics.supply);
  }
  owner.companies[0].rooms = 999;
  owner.reports[0].title = 'external mutation';
  assert.equal(store.read('owner').companies[0].rooms, 16);
  assert.notEqual(store.read('owner').reports[0].title, 'external mutation');
  mutate(store, 'set-limits', { competitorLimit: 5, interestRegionLimit: 3 });
  assert.deepEqual(store.read('planning'), planning);
  assert.equal(planning.customer.ownedCompanyId, null);
});

test('revision protects against lost updates and cannot be reset to an older revision', () => {
  const store = createPreviewStore();
  const revision = store.read().revision;
  mutate(store, 'set-limits', { competitorLimit: 4, interestRegionLimit: 2 });
  const committed = store.read();
  assert.throws(() => store.act({ profile: 'owner', revision, action: 'set-targets', payload: { competitorIds: [], interestRegionCodes: [] } }), (error) => error.code === 'stale_revision' && error.status === 409);
  assert.deepEqual(store.read(), committed);
  const reset = mutate(store, 'reset', {});
  assert.equal(reset.revision, committed.revision + 1);
  assert.equal(reset.limits.competitorLimit, 3);
});

test('reducing limits requires explicit keep selection and preserves immutable published reports', () => {
  const store = createPreviewStore();
  const initial = store.read();
  expectFailure(store, 'set-limits', { competitorLimit: 1, interestRegionLimit: 0 }, 'requires_selection', 409);
  const result = mutate(store, 'set-limits', { competitorLimit: 1, interestRegionLimit: 0, keepCompetitorIds: ['demo-dalbit'], keepInterestRegionCodes: [] });
  assert.deepEqual(result.competitorIds, ['demo-dalbit']);
  assert.deepEqual(result.interestRegionCodes, []);
  assert.deepEqual(result.archived.competitorIds, ['demo-onyu']);
  assert.deepEqual(result.archived.interestRegionCodes, ['41820']);
  assert.deepEqual(result.reports, initial.reports);
  assert.equal(result.audit.at(-1).action, 'set-limits');
  expectFailure(store, 'set-targets', { competitorIds: ['demo-dalbit'], interestRegionCodes: ['41650'] }, 'limit_exceeded');
});

test('zero disables new registrations and explicit zero reduction archives all selected targets', () => {
  const store = createPreviewStore();
  const result = mutate(store, 'set-limits', { competitorLimit: 0, interestRegionLimit: 0, keepCompetitorIds: [], keepInterestRegionCodes: [] });
  assert.deepEqual(result.competitorIds, []);
  assert.equal(result.archived.competitorIds.length, 2);
  expectFailure(store, 'set-targets', { competitorIds: ['demo-dalbit'], interestRegionCodes: [] }, 'limit_exceeded');
  const noTargets = mutate(store, 'set-targets', { competitorIds: [], interestRegionCodes: [] });
  assert.deepEqual(noTargets.reports, result.reports);
});

test('invalid limits, unsupported fields, duplicate and arbitrary target identities are rejected atomically', () => {
  const store = createPreviewStore();
  for (const competitorLimit of [-1, 1.5, '3', 1001, null]) expectFailure(store, 'set-limits', { competitorLimit, interestRegionLimit: 1 }, 'validation');
  expectFailure(store, 'set-limits', { competitorLimit: 3, interestRegionLimit: 1, customerId: 'another-customer' }, 'validation');
  expectFailure(store, 'set-targets', { competitorIds: ['demo-dalbit', 'demo-dalbit'], interestRegionCodes: [] }, 'validation');
  expectFailure(store, 'set-targets', { competitorIds: ['real-company'], interestRegionCodes: [] }, 'validation');
  expectFailure(store, 'set-targets', { competitorIds: [], interestRegionCodes: ['arbitrary-region'] }, 'validation');
  expectFailure(store, 'set-limits', { competitorLimit: 1, interestRegionLimit: 1, keepCompetitorIds: ['demo-baram'] }, 'validation');
  assert.throws(() => store.read('customer-production'), (error) => error.code === 'validation');
});

test('own property and included base region cannot consume comparison or interest slots', () => {
  const store = createPreviewStore();
  expectFailure(store, 'set-profile', { businessStage: 'owned', ownedCompanyId: null }, 'validation');
  expectFailure(store, 'set-profile', { businessStage: 'owned' }, 'validation');
  expectFailure(store, 'set-targets', { competitorIds: ['demo-yunseul'], interestRegionCodes: [] }, 'validation');
  expectFailure(store, 'set-targets', { competitorIds: [], interestRegionCodes: ['48860'] }, 'validation');
  const result = mutate(store, 'set-targets', { competitorIds: ['demo-dalbit', 'demo-onyu', 'demo-baram'], interestRegionCodes: ['41650'] });
  assert.equal(result.competitorIds.length, 3);
  assert.equal(result.interestRegionCodes.length, 1);
  assert.equal(result.customer.ownedCompanyId, 'demo-yunseul');
});

test('planning to owned transition archives target overlaps without changing member identity or reports', () => {
  const store = createPreviewStore();
  const initial = store.read('planning');
  const owned = mutate(store, 'set-profile', { businessStage: 'owned', ownedCompanyId: 'demo-baram', projectName: '개업한 나의 매장' }, 'planning');
  assert.equal(owned.customer.id, initial.customer.id);
  assert.deepEqual(owned.competitorIds, ['demo-haedeun']);
  assert.deepEqual(owned.interestRegionCodes, []);
  assert.deepEqual(owned.archived.competitorIds, ['demo-baram']);
  assert.deepEqual(owned.archived.interestRegionCodes, ['41820']);
  assert.deepEqual(owned.reports, initial.reports);
  assert.equal(owned.reports[0].snapshot.companyId, null, 'published planning report must not become an owned report after opening');
  assert.equal(owned.reports[0].snapshot.businessStage, 'planning');
  const planning = mutate(store, 'set-profile', { businessStage: 'planning', projectName: '다음 매장 준비' }, 'planning');
  assert.equal(planning.customer.ownedCompanyId, null);
  assert.equal(planning.customer.id, initial.customer.id);
  assert.deepEqual(planning.reports, initial.reports);
});

test('published report snapshots retain former property and targets after current settings change', () => {
  const store = createPreviewStore();
  const before = store.read();
  const after = mutate(store, 'set-profile', { businessStage: 'owned', ownedCompanyId: 'demo-solbyeol', projectName: '새로운 매장' });
  assert.equal(after.customer.ownedCompanyId, 'demo-solbyeol');
  assert.equal(after.reports[0].snapshot.companyId, 'demo-yunseul');
  assert.deepEqual(after.reports, before.reports);
  assert.equal(after.reports[0].snapshot.metrics.supply, 16 * 31);
  assert.equal(after.reports[1].snapshot.metrics.supply, 16 * 7);
});

test('target removal is archived, reactivation remains in audit history, and baseline stays unchanged', () => {
  const store = createPreviewStore();
  const before = store.read();
  mutate(store, 'set-targets', { competitorIds: ['demo-dalbit'], interestRegionCodes: [] });
  const restored = mutate(store, 'set-targets', { competitorIds: ['demo-dalbit', 'demo-onyu'], interestRegionCodes: ['41820'] });
  assert.deepEqual(restored.archived, { competitorIds: [], interestRegionCodes: [] });
  assert.equal(restored.audit.filter((entry) => entry.action === 'set-targets').length, 2);
  assert.deepEqual(restored.companies, before.companies);
  assert.deepEqual(restored.regions, before.regions);
  assert.deepEqual(restored.reports, before.reports);
});
