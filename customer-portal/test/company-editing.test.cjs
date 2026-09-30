'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createPreviewStore } = require('../lib/preview-store.cjs');
const mutate = (store, action, payload, profile = 'owner') => store.act({ profile, revision: store.read(profile).revision, action, payload });
function edit(store, companyId = 'demo-yunseul') {
  const c = store.read().companies.find(x => x.id === companyId);
  return { companyId, nickname: '내 별칭', note: '예시 검토 메모', reason: '', proposed: { name: c.name, address: c.address, category: c.category, rooms: c.rooms, dayUse: c.dayUse || 'unknown', facilities: c.facilities || '' } };
}
function rejectsUnchanged(store, payload, code = 'validation') {
  const before = store.read();
  assert.throws(() => mutate(store, 'edit-company', payload), e => e.code === code);
  assert.deepEqual(store.read(), before);
}
test('personal edits are customer-scoped and never replace canonical names, inventory, or reports', () => {
  const store = createPreviewStore(), initial = store.read(), other = store.read('planning');
  let updated = mutate(store, 'edit-company', edit(store));
  assert.equal(updated.companySettings['demo-yunseul'].nickname, '내 별칭');
  assert.deepEqual(updated.companies, initial.companies);
  assert.deepEqual(updated.reports, initial.reports);
  assert.equal(updated.correctionRequests.length, 0);
  assert.deepEqual(store.read('planning'), other);
  const next = edit(store); next.nickname = '';
  updated = mutate(store, 'edit-company', next);
  assert.equal(updated.companySettings['demo-yunseul'].nickname, '');
  assert.equal(updated.audit.at(-1).previousPersonalSettings.nickname, '내 별칭');
});
test('own and competitor corrections preserve original evidence and remain pending without changing metrics', () => {
  const store = createPreviewStore(), before = store.read();
  for (const id of ['demo-yunseul', 'demo-dalbit']) {
    const payload = edit(store, id); payload.proposed.rooms = 61; payload.proposed.dayUse = 'shared'; payload.reason = '예시 객실 안내 확인';
    const updated = mutate(store, 'edit-company', payload), request = updated.correctionRequests.at(-1);
    assert.equal(request.status, 'pending');
    assert.equal(request.relationship, id === 'demo-yunseul' ? 'own' : 'competitor');
    assert.equal(request.baseValues.rooms, before.companies.find(c => c.id === id).rooms);
    assert.deepEqual(request.proposed, { rooms: 61, dayUse: 'shared' });
    assert.deepEqual(updated.companies, before.companies);
    assert.deepEqual(updated.reports, before.reports);
  }
});
test('changed requests supersede previous requests while identical saves do not duplicate them', () => {
  const store = createPreviewStore(), payload = edit(store); payload.proposed.rooms = 17; payload.reason = '예시 근거';
  mutate(store, 'edit-company', payload); mutate(store, 'edit-company', payload);
  assert.equal(store.read().correctionRequests.length, 1);
  payload.proposed.rooms = 18;
  mutate(store, 'edit-company', payload);
  let requests = store.read().correctionRequests;
  assert.deepEqual(requests.map(x => x.status), ['superseded', 'pending']);
  assert.equal(requests[0].proposed.rooms, 17);
  const cancelled = mutate(store, 'withdraw-company-correction', { requestId: requests[1].id });
  assert.deepEqual(cancelled.correctionRequests.map(x => x.status), ['superseded', 'withdrawn']);
  assert.equal(cancelled.companies[0].rooms, 16);
});
test('requests require a registered target and evidence; identities, review flags and metrics cannot be edited', () => {
  const store = createPreviewStore();
  const payload = edit(store); payload.proposed.rooms = 17;
  rejectsUnchanged(store, payload);
  payload.reason = '예시 근거';
  for (const room of [0, -1, 1.5, '17', null]) rejectsUnchanged(store, { ...payload, proposed: { ...payload.proposed, rooms: room } });
  rejectsUnchanged(store, { ...payload, proposed: { ...payload.proposed, dayUse: 'maybe' } });
  rejectsUnchanged(store, { ...payload, proposed: { ...payload.proposed, placeId: 'another-place' } });
  rejectsUnchanged(store, { ...payload, approved: true });
  rejectsUnchanged(store, { ...payload, proposed: { ...payload.proposed, metrics: { estimatedRevenue: 999 } } });
  rejectsUnchanged(store, edit(store, 'demo-solbyeol'), 'not_found');
  mutate(store, 'set-targets', { competitorIds: [], interestRegionCodes: [] });
  rejectsUnchanged(store, edit(store, 'demo-dalbit'), 'not_found');
});
test('stale edits cannot discard newer corrections and restoring current baseline withdraws only the pending request', () => {
  const store = createPreviewStore(), payload = edit(store), revision = store.read().revision;
  payload.proposed.rooms = 17; payload.reason = '예시 근거';
  mutate(store, 'edit-company', payload);
  assert.throws(() => store.act({ profile: 'owner', revision, action: 'edit-company', payload }), e => e.code === 'stale_revision');
  const restored = mutate(store, 'edit-company', edit(store));
  assert.equal(restored.correctionRequests[0].status, 'withdrawn');
  assert.equal(restored.correctionRequests[0].proposed.rooms, 17);
});
test('private settings and correction history survive relation removal and re-registration', () => {
  const store = createPreviewStore(), payload = edit(store, 'demo-dalbit'); payload.proposed.rooms = 20; payload.reason = '예시 근거';
  mutate(store, 'edit-company', payload);
  mutate(store, 'set-targets', { competitorIds: [], interestRegionCodes: [] });
  const state = mutate(store, 'set-targets', { competitorIds: ['demo-dalbit'], interestRegionCodes: [] });
  assert.equal(state.companySettings['demo-dalbit'].nickname, '내 별칭');
  assert.equal(state.correctionRequests[0].status, 'pending');
});
