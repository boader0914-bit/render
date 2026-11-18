"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), crypto = require("node:crypto");
const { createLastGoodStorage, RESULT_KEY, RESULT_LIMIT } = require("../web/keyword-monthly-analysis.js");
const NOW = Date.parse("2026-11-18T00:30:00.000Z"), A = "a".repeat(64), B = "b".repeat(64);
const clone = value => JSON.parse(JSON.stringify(value)), digest = async value => crypto.createHash("sha256").update(value).digest("hex");
const selection = { keyword: "가평글램핑", month: "2026-11", cutoffDate: "2026-11-17" };
function fixture({ blockedStorage = false, digest: customDigest = digest } = {}) {
  let at = NOW, authorization = { authenticated: true, scope: A, expiresAt: NOW + 16 * 3600000 };
  const entries = new Map(), storage = { getItem: key => entries.get(key) ?? null, removeItem: key => entries.delete(key), setItem(key, value) { if (blockedStorage) throw Error("quota"); entries.set(key, value); } };
  const payload = { schemaVersion: 1, status: "available", readOnly: true, networkAttempted: false, request: clone(selection),
    preparedResult: { status: "ready", sourceRevalidated: false }, bundle: { generation: A.slice(0, 32) },
    provenance: { currentPointerSha256: A, inputSha256: B, originalFreshnessVerified: false }, diagnostics: [],
    snapshot: { schemaVersion: 1, request: { type: "keyword", targetId: selection.keyword, month: selection.month, cutoffDate: selection.cutoffDate },
      daily: [{ date: "2026-11-01", lodging: { sold: 0, estimatedRevenue: null, coveredCompanyDays: 1 } }], companies: [], summary: {} } };
  const catalogue = { status: "available", currentDay: "2026-11-18", currentMonth: "2026-11", metadataOnly: true, financialResultValidated: false,
    provenance: { currentPointerSha256: A, originalFreshnessVerified: false }, refreshStatus: { counts: { running: 20 } },
    keywords: [{ keyword: selection.keyword, stayMonths: [selection.month], supportedCutoffs: { "2026-11": "2026-11-17" } }], diagnostics: [] };
  const store = createLastGoodStorage({ storage, authorization: () => authorization, now: () => at, digest: customDigest });
  return { store, payload, catalogue, storage, entries, setAuthorization: value => { authorization = value; }, setNow: value => { at = value; } };
}
test("one normal prepared result is scoped, bounded and keeps unknowns without cached runtime freshness", async () => {
  const f = fixture(); assert.equal(await f.store.write(f.payload, f.catalogue), true);
  const raw = f.entries.get(RESULT_KEY), result = await f.store.read(selection);
  assert.ok(Buffer.byteLength(raw) <= RESULT_LIMIT); assert.equal(result.payload.snapshot.daily[0].lodging.sold, 0);
  assert.equal(result.payload.snapshot.daily[0].lodging.estimatedRevenue, null); assert.equal(result.catalogue.refreshStatus, null);
  assert.equal(result.catalogue.financialResultValidated, false); assert.equal(result.catalogue.metadataOnly, true);
  assert.ok(!raw.includes('"running"')); assert.equal(JSON.parse(raw).scope, A); assert.equal(result.payload.provenance.originalFreshnessVerified, false);
});
test("partial catalogue retains bounded reason codes while a selected normal result remains inspectable", async () => {
  const f = fixture(); f.catalogue.status = "stale"; f.catalogue.diagnostics = [{ code: "KEYWORD_MONTHLY_BUNDLE_STALE_PARTITIONS_PRESENT", message: "untrusted response text" }];
  assert.equal(await f.store.write(f.payload, f.catalogue), true); const result = await f.store.read(selection);
  assert.deepEqual(result.catalogue.diagnostics, ["KEYWORD_MONTHLY_BUNDLE_STALE_PARTITIONS_PRESENT"]);
  assert.ok(!f.entries.get(RESULT_KEY).includes("untrusted response text"));
});
test("wrong query scope never shows another keyword month or cutoff", async () => {
  const f = fixture(); await f.store.write(f.payload, f.catalogue);
  for (const patch of [{ keyword: "경남글램핑" }, { month: "2026-12" }, { cutoffDate: "2026-11-18" }]) assert.equal(await f.store.read({ ...selection, ...patch }), null);
  assert.ok(await f.store.read(selection));
});
test("another session, expired session and revoked role cannot reuse or retain the last administrator result", async () => {
  for (const authorization of [{ authenticated: true, scope: B, expiresAt: NOW + 3600000 }, { authenticated: true, scope: A, expiresAt: NOW }, null]) {
    const f = fixture(); await f.store.write(f.payload, f.catalogue); f.setAuthorization(authorization);
    assert.equal(await f.store.read(selection), null); assert.equal(f.entries.has(RESULT_KEY), false);
  }
});
test("changed content with an old digest is removed instead of being confirmed by a matching pointer", async () => {
  const f = fixture(); await f.store.write(f.payload, f.catalogue); const entry = JSON.parse(f.entries.get(RESULT_KEY));
  entry.payload.snapshot.daily[0].lodging.sold = 99; f.entries.set(RESULT_KEY, JSON.stringify(entry));
  assert.equal(await f.store.read(selection), null); assert.equal(f.entries.has(RESULT_KEY), false);
});
test("failed partial stale unprepared malformed and mismatched response bodies cannot replace normal cache", async () => {
  for (const mutate of [v => { v.status = "stale"; }, v => { v.schemaVersion = 2; }, v => { v.snapshot.schemaVersion = 2; }, v => { v.readOnly = false; },
    v => { v.networkAttempted = true; }, v => { v.preparedResult.status = "missing"; }, v => { v.provenance.inputSha256 = "invalid"; },
    v => { v.provenance.currentPointerSha256 = B; }, v => { v.snapshot.request.targetId = "다른 업체"; }, v => { v.snapshot.daily.push(v.snapshot.daily[0]); },
    v => { v.snapshot.daily[0].date = "2026-12-01"; }, v => { v.snapshot.credentials = { Token: "never store" }; }]) {
    const f = fixture(); await f.store.write(f.payload, f.catalogue); const before = f.entries.get(RESULT_KEY), bad = clone(f.payload); mutate(bad);
    assert.equal(await f.store.write(bad, f.catalogue), false); assert.equal(f.entries.get(RESULT_KEY), before);
  }
});
test("extra wrapper fields are not persisted and storage quota cannot fail the normal result path", async () => {
  const f = fixture(); f.payload.secret = "not a report field"; assert.equal(await f.store.write(f.payload, f.catalogue), true);
  assert.ok(!f.entries.get(RESULT_KEY).includes("not a report field"));
  const quota = fixture({ blockedStorage: true }); assert.equal(await quota.store.write(quota.payload, quota.catalogue), false);
});
test("oversize, future, expired and malformed cache entries are bounded misses", async () => {
  for (const mutate of [entry => { entry.storedAt = NOW + 1; }, entry => { entry.expiresAt = NOW; }, entry => { entry.schema = 2; }, entry => { entry.contentSha256 = "bad"; }]) {
    const f = fixture(); await f.store.write(f.payload, f.catalogue); const entry = JSON.parse(f.entries.get(RESULT_KEY)); mutate(entry); f.entries.set(RESULT_KEY, JSON.stringify(entry));
    assert.equal(await f.store.read(selection), null);
  }
  const f = fixture(); f.entries.set(RESULT_KEY, "x".repeat(RESULT_LIMIT + 1)); assert.equal(await f.store.read(selection), null);
  await f.store.write(f.payload, f.catalogue); f.setNow(NOW + 13 * 3600000); assert.equal(await f.store.read(selection), null);
});
test("late hash work cannot write a result after its administrator session changes", async () => {
  let resolve; const gate = new Promise(done => { resolve = done; }), f = fixture({ digest: () => gate });
  const writing = f.store.write(f.payload, f.catalogue); f.setAuthorization({ authenticated: true, scope: B, expiresAt: NOW + 3600000 });
  resolve(A); assert.equal(await writing, false); assert.equal(f.entries.has(RESULT_KEY), false);
});
test("an older slow digest cannot overwrite a newer successful result in the same session", async () => {
  let release, calls = 0; const gate = new Promise(done => { release = done; });
  const f = fixture({ digest: content => ++calls === 1 ? gate.then(() => digest(content)) : digest(content) });
  const old = f.store.write(f.payload, f.catalogue), newer = clone(f.payload); newer.snapshot.daily[0].lodging.sold = 2;
  assert.equal(await f.store.write(newer, f.catalogue), true); const saved = f.entries.get(RESULT_KEY);
  release(); assert.equal(await old, false); assert.equal(f.entries.get(RESULT_KEY), saved);
  assert.equal((await f.store.read(selection)).payload.snapshot.daily[0].lodging.sold, 2);
});
test("an explicit clear fences pending writes even while the same administrator remains authorized", async () => {
  let release; const gate = new Promise(done => { release = done; }), f = fixture({ digest: content => gate.then(() => digest(content)) });
  const old = f.store.write(f.payload, f.catalogue); f.store.clear(); release();
  assert.equal(await old, false); assert.equal(f.entries.has(RESULT_KEY), false);
});
test("an old asynchronous read cannot erase a new session's newly stored result", async () => {
  let release, delay = false; const gate = new Promise(done => { release = done; });
  const f = fixture({ digest: content => delay ? gate.then(() => digest(content)) : digest(content) });
  await f.store.write(f.payload, f.catalogue); delay = true; const old = f.store.read(selection);
  f.setAuthorization({ authenticated: true, scope: B, expiresAt: NOW + 3600000 }); delay = false;
  assert.equal(await f.store.write(f.payload, f.catalogue), true); const saved = f.entries.get(RESULT_KEY);
  release(); assert.equal(await old, null); assert.equal(f.entries.get(RESULT_KEY), saved);
  assert.ok(await f.store.read(selection));
});
test("authoritative invalidation removes only its scope and fences a same-scope pending write", async () => {
  const f = fixture(); await f.store.write(f.payload, f.catalogue);
  assert.equal(f.store.invalidateScope({ ...selection, keyword: "다른 키워드" }), false); assert.ok(await f.store.read(selection));
  assert.equal(f.store.invalidateScope(selection), true); assert.equal(await f.store.read(selection), null);
  let release; const gate = new Promise(done => { release = done; }), pending = fixture({ digest: content => gate.then(() => digest(content)) });
  const writing = pending.store.write(pending.payload, pending.catalogue); assert.equal(pending.store.invalidateScope(selection), true); release();
  assert.equal(await writing, false); assert.equal(pending.entries.has(RESULT_KEY), false);
});
test("the entry lifetime is rechecked after digest before cached adoption", async () => {
  let release, delay = false; const gate = new Promise(done => { release = done; });
  const f = fixture({ digest: content => delay ? gate.then(() => digest(content)) : digest(content) });
  await f.store.write(f.payload, f.catalogue); delay = true; const reading = f.store.read(selection);
  f.setNow(NOW + 13 * 3600000); release(); assert.equal(await reading, null); assert.equal(f.entries.has(RESULT_KEY), false);
});
test("a fresh identical result renews an expired or removed cache instead of claiming an unwritten ready entry", async () => {
  const f = fixture(); await f.store.write(f.payload, f.catalogue); const original = JSON.parse(f.entries.get(RESULT_KEY));
  f.setNow(NOW + 13 * 3600000); assert.equal(await f.store.write(f.payload, f.catalogue), true);
  const renewed = JSON.parse(f.entries.get(RESULT_KEY)); assert.ok(renewed.storedAt > original.storedAt); assert.ok(await f.store.read(selection));
  f.entries.delete(RESULT_KEY); assert.equal(await f.store.write(f.payload, f.catalogue), true); assert.ok(await f.store.read(selection));
});
