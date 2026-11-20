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
      daily: [{ date: "2026-11-01", lodging: { sold: 0, estimatedRevenue: null, coveredCompanyDays: 1 } }], companies: [], summary: {}, sources: { observations: [] } } };
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
  for (const mutate of [entry => { entry.storedAt = NOW + 1; }, entry => { entry.expiresAt = NOW; }, entry => { entry.schema = 3; }, entry => { entry.contentSha256 = "bad"; }]) {
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
test("cache projection rejection reports only a fixed reason code without source values or paths", async () => {
  const cases = [
    ["RESPONSE_SCHEMA_INVALID", f => { f.payload.schemaVersion = 2; }],
    ["SNAPSHOT_SCHEMA_INVALID", f => { f.payload.snapshot.schemaVersion = 2; }],
    ["RESPONSE_STATUS_INVALID", f => { f.payload.status = "stale"; }],
    ["READ_ONLY_INVALID", f => { f.payload.readOnly = false; }],
    ["NETWORK_ATTEMPTED_INVALID", f => { f.payload.networkAttempted = true; }],
    ["PREPARED_STATUS_INVALID", f => { f.payload.preparedResult.status = "missing"; }],
    ["PROVENANCE_INVALID", f => { f.payload.provenance.inputSha256 = "not a hash"; }],
    ["SCOPE_INVALID", f => { f.payload.request.keyword = "private\nraw"; }],
    ["CATALOGUE_POINTER_MISMATCH", f => { f.catalogue.provenance.currentPointerSha256 = B; }],
    ["CATALOGUE_UNAVAILABLE", f => { f.catalogue.status = "missing"; }],
    ["CATALOGUE_DAY_MISMATCH", f => { f.catalogue.currentDay = "2026-11-17"; }],
    ["SCOPE_NOT_IN_CATALOGUE", f => { f.catalogue.keywords = []; }],
    ["RESULT_UNUSABLE", f => { f.payload.snapshot.request.targetId = "another scope"; }],
    ["UNSAFE_FIELD", f => { f.payload.snapshot.extra = { guestPhoneNumber: "MUST_NOT_LEAK" }; }],
    ["VALUE_INVALID", f => { f.payload.snapshot.extra = NaN; }],
    ["STRING_LIMIT", f => { f.payload.snapshot.extra = "x".repeat(32769); }],
    ["DEPTH_LIMIT", f => { let value = {}; f.payload.snapshot.extra = value; for (let i = 0; i < 25; i++) value = value.child = {}; }],
    ["NODE_LIMIT", f => { f.payload.snapshot.extra = Array(150001).fill(null); }],
    ["SIZE_LIMIT", f => { f.payload.snapshot.extra = Array(80).fill("x".repeat(30000)); }]
  ];
  for (const [reason, change] of cases) {
    const f = fixture(); change(f); const result = await f.store.writeResult(f.payload, f.catalogue);
    assert.deepEqual(result, { stored: false, reasonCode: `KEYWORD_MONTHLY_CACHE_${reason}` }, reason);
    assert.deepEqual(Object.keys(result).sort(), ["reasonCode", "stored"]); assert.equal(f.entries.has(RESULT_KEY), false);
    assert.ok(!JSON.stringify(result).includes("MUST_NOT_LEAK"));
  }
});
test("authentication, quota, denial, missing storage and crypto failures have distinct fixed codes", async () => {
  const denied = fixture({ blockedStorage: true });
  assert.deepEqual(await denied.store.writeResult(denied.payload, denied.catalogue), { stored: false, reasonCode: "KEYWORD_MONTHLY_CACHE_STORAGE_DENIED" });
  const quota = fixture(); quota.storage.setItem = () => { throw Object.assign(new Error("MUST_NOT_LEAK"), { name: "QuotaExceededError" }); };
  assert.deepEqual(await quota.store.writeResult(quota.payload, quota.catalogue), { stored: false, reasonCode: "KEYWORD_MONTHLY_CACHE_STORAGE_QUOTA" });
  const absent = fixture(); absent.storage.setItem = undefined;
  assert.deepEqual(await absent.store.writeResult(absent.payload, absent.catalogue), { stored: false, reasonCode: "KEYWORD_MONTHLY_CACHE_STORAGE_UNAVAILABLE" });
  const unauthenticated = fixture(); unauthenticated.setAuthorization(null);
  assert.deepEqual(await unauthenticated.store.writeResult(unauthenticated.payload, unauthenticated.catalogue), { stored: false, reasonCode: "KEYWORD_MONTHLY_CACHE_AUTH_REQUIRED" });
  for (const [reason, digest] of [["DIGEST_UNAVAILABLE", async () => { throw Error("MUST_NOT_LEAK"); }], ["DIGEST_INVALID", async () => "bad"]]) {
    const f = fixture({ digest }); assert.deepEqual(await f.store.writeResult(f.payload, f.catalogue), { stored: false, reasonCode: `KEYWORD_MONTHLY_CACHE_${reason}` });
  }
});
test("a stalled digest is a truthful cache timeout with the original250ms bound and no late write", async () => {
  let release; const gate = new Promise(resolve => { release = resolve; }), f = fixture({ digest: () => gate });
  assert.deepEqual(await f.store.writeResult(f.payload, f.catalogue), { stored: false, reasonCode: "KEYWORD_MONTHLY_CACHE_DIGEST_TIMEOUT" });
  release(A); await new Promise(resolve => setImmediate(resolve)); assert.equal(f.entries.has(RESULT_KEY), false);
});
test("a successful cache write returns no failure reason or sensitive diagnostic fields", async () => {
  const f = fixture(); assert.deepEqual(await f.store.writeResult(f.payload, f.catalogue), { stored: true, reasonCode: null });
});

// Production-shaped synthetic evidence, not a copy of the failed live response.
// In particular, the live CACHE_RESPONSE_INVALID predicate remains unconfirmed.
function historicalFixture(options) {
  const f = fixture(options);
  Object.assign(f.payload, { status: "stale", diagnostics: ["PROJECTION_EXPIRED"], supportedCutoffDate: selection.cutoffDate });
  Object.assign(f.payload.provenance, { materializedAt: "2026-11-16T00:00:00.000Z", dataThrough: "2026-11-17T23:59:59.000Z" });
  Object.assign(f.payload.preparedResult, { calculationFingerprint: B, sha256: A, sourceRevalidated: false });
  f.payload.snapshot.summary = { lodging: { coveredCompanyDays: 1, sold: 0, supply: 5, estimatedRevenue: null,
    priceConfirmedPartialSubtotal: 1200, revenuePartial: true, revenueSample: { coveredCompanyDays: 0 } }, dayuse: null };
  f.payload.snapshot.sources = { observations: [{ companyId: "synthetic-company", date: "2026-11-01", productType: "lodging", sold: 0, supply: 5 }],
    partialEvidence: { priceConfirmed: [{ companyId: "synthetic-partial", sold: null, supply: null, partial: true, subtotal: 1200 }] }, runIds: ["synthetic-run"] };
  return f;
}
test("valid expired prepared evidence round trips unchanged as historical, preserving null zero partial and provenance", async () => {
  const f = historicalFixture(), original = clone(f.payload);
  assert.equal(await f.store.write(f.payload, f.catalogue), true);
  const restored = await f.store.read(selection);
  assert.deepEqual(restored.payload, original); assert.deepEqual(f.payload, original);
  const { buildViewModel } = require("../web/keyword-monthly-analysis.js");
  const view = buildViewModel(restored.payload, selection, "2026-11");
  assert.equal(view.usable, true); assert.equal(view.historicalSnapshot, true); assert.equal(view.status, "stale");
  assert.equal(restored.payload.snapshot.summary.lodging.sold, 0);
  assert.equal(restored.payload.snapshot.summary.lodging.estimatedRevenue, null);
  assert.equal(restored.payload.snapshot.summary.dayuse, null);
  assert.equal(restored.payload.snapshot.sources.partialEvidence.priceConfirmed[0].partial, true);
  assert.equal(restored.catalogue.financialResultValidated, false); assert.equal(restored.catalogue.refreshStatus, null);
});
test("historical cache eligibility rejects cutoff and freshness failures before retaining any new body", async () => {
  for (const mutate of [v => { v.diagnostics = []; }, v => { v.diagnostics.push("CUTOFF_AFTER_DATA_THROUGH"); },
    v => { v.provenance.dataThrough = "invalid"; }, v => { v.provenance.dataThrough = "2026-11-16T00:00:00Z"; },
    v => { v.status = "partial"; }, v => { v.status = "needs_verification"; }]) {
    const f = historicalFixture(); await f.store.write(f.payload, f.catalogue); const before = f.entries.get(RESULT_KEY), bad = clone(f.payload); mutate(bad);
    assert.deepEqual(await f.store.writeResult(bad, f.catalogue), { stored: false, reasonCode: "KEYWORD_MONTHLY_CACHE_RESPONSE_STATUS_INVALID" });
    assert.equal(f.entries.get(RESULT_KEY), before);
  }
});
test("historical evidence still needs prepared provenance matching query and bounded safe content", async () => {
  const cases = [["PREPARED_STATUS_INVALID", v => { v.preparedResult.status = "missing"; }],
    ["PROVENANCE_INVALID", v => { v.provenance.originalFreshnessVerified = true; }],
    ["RESULT_UNUSABLE", v => { v.snapshot.request.targetId = "different"; }],
    ["RESULT_UNUSABLE", v => { v.snapshot.daily.push(v.snapshot.daily[0]); }],
    ["UNSAFE_FIELD", v => { v.snapshot.extra = { guestPhoneNumber: "SENSITIVE" }; }],
    ["STRING_LIMIT", v => { v.snapshot.extra = "x".repeat(32769); }],
    ["SIZE_LIMIT", v => { v.snapshot.extra = Array(80).fill("x".repeat(30000)); }]];
  for (const [reason, mutate] of cases) {
    const f = historicalFixture(); mutate(f.payload);
    assert.deepEqual(await f.store.writeResult(f.payload, f.catalogue), { stored: false, reasonCode: `KEYWORD_MONTHLY_CACHE_${reason}` });
    assert.equal(f.entries.has(RESULT_KEY), false);
  }
});
test("historical evidence cannot outlive its same-day session TTL or authoritative scope invalidation", async () => {
  const f = historicalFixture(); await f.store.write(f.payload, f.catalogue);
  f.setNow(NOW + 12 * 3600000); assert.equal(await f.store.read(selection), null);
  const day = historicalFixture(); day.setNow(Date.parse("2026-11-18T14:00:00Z"));
  day.setAuthorization({ authenticated: true, scope: A, expiresAt: Date.parse("2026-11-19T02:00:00Z") });
  await day.store.write(day.payload, day.catalogue); day.setNow(Date.parse("2026-11-18T15:00:00Z"));
  assert.equal(await day.store.read(selection), null);
  const invalidated = historicalFixture(); await invalidated.store.write(invalidated.payload, invalidated.catalogue);
  assert.equal(invalidated.store.invalidateScope(selection), true); assert.equal(await invalidated.store.read(selection), null);
});
test("historical pending writes cannot survive scope invalidation or logout", async () => {
  for (const invalidate of [f => f.store.invalidateScope(selection), f => { f.setAuthorization(null); f.store.clear(); }]) {
    let release; const gate = new Promise(resolve => { release = resolve; });
    const f = historicalFixture({ digest: content => gate.then(() => digest(content)) });
    const writing = f.store.write(f.payload, f.catalogue); invalidate(f); release();
    assert.equal(await writing, false); assert.equal(f.entries.has(RESULT_KEY), false);
  }
});
test("validation exceptions have a fixed cache code without exposing a field or exception message", async () => {
  const f = fixture(); Object.defineProperty(f.payload, "schemaVersion", { get() { throw Error("SENSITIVE_EXCEPTION"); } });
  assert.deepEqual(await f.store.writeResult(f.payload, f.catalogue), { stored: false, reasonCode: "KEYWORD_MONTHLY_CACHE_VALIDATION_FAILED" });
  assert.equal(f.entries.has(RESULT_KEY), false);
});
const evidenceRow = () => ({ companyId: "synthetic-company", date: "2026-11-01", productType: "lodging", runId: "synthetic-run",
  supply: 5, sold: 0, publicBookings: 0, phoneBookings: 0, revenueEligible: false, estimatedRevenue: null,
  capacityWitnesses: [{ productKey: "synthetic-product", count: 5 }], phonePriceEstimates: [], phoneValuation: { policy: "synthetic" }, sharedDayUseEvidence: null });
function projectionFixture() {
  const f = historicalFixture(); f.payload.snapshot.sources.observations = [evidenceRow()];
  f.payload.snapshot.companies = [{ companyId: "synthetic-company", primaryName: "합성 업체", summary: clone(f.payload.snapshot.summary), daily: [{ date: "2026-11-01", lodging: { sold: 0 } }] }];
  for (const key of ["changes", "ranks", "insights", "context", "definitions"]) f.payload.snapshot[key] = { synthetic: true };
  f.payload.snapshot.comparison = { productType: "lodging", all: { previous: { coveredCompanyDays: 1 } }, previousSources: { runIds: ["synthetic-previous"], observations: [evidenceRow()] } };
  f.payload.snapshot.comparisonByProduct = { lodging: clone(f.payload.snapshot.comparison), dayuse: { productType: "dayuse", previousSources: { observations: [{ ...evidenceRow(), productType: "dayuse" }] } } };
  return f;
}
test("display projection is versioned, preserves originals and lineage, and omits only explicit display-unused branches", async () => {
  const f = projectionFixture(), original = clone(f.payload); f.payload.snapshot.futureSafeField = { value: 7 };
  assert.equal(await f.store.write(f.payload, f.catalogue), true);
  const entry = JSON.parse(f.entries.get(RESULT_KEY)), restored = await f.store.read(selection), snapshot = restored.payload.snapshot;
  assert.equal(entry.schema, 2); assert.equal(entry.projectionVersion, 1); assert.equal(restored.projectionVersion, 1);
  assert.equal(entry.contentSha256, await digest(JSON.stringify({ projectionVersion: 1, payload: entry.payload, catalogue: entry.catalogue })));
  assert.deepEqual(f.payload, { ...original, snapshot: { ...original.snapshot, futureSafeField: { value: 7 } } });
  assert.deepEqual(snapshot.futureSafeField, { value: 7 }); assert.deepEqual(snapshot.summary, original.snapshot.summary);
  assert.deepEqual(restored.payload.provenance, original.provenance); assert.deepEqual(restored.payload.preparedResult, original.preparedResult);
  assert.deepEqual(snapshot.sources.partialEvidence, original.snapshot.sources.partialEvidence);
  assert.equal(Object.hasOwn(snapshot.companies[0], "daily"), false);
  for (const key of ["changes", "ranks", "insights", "context", "definitions"]) assert.equal(Object.hasOwn(snapshot, key), false, key);
  for (const key of ["capacityWitnesses", "phonePriceEstimates", "phoneValuation", "sharedDayUseEvidence"]) assert.equal(Object.hasOwn(snapshot.sources.observations[0], key), false, key);
  assert.deepEqual(snapshot.comparison.previousSources.observations, [{ productType: "lodging" }]);
  assert.deepEqual(snapshot.comparison.previousSources.runIds, ["synthetic-previous"]);
});
test("whole original-row conflicts cannot be canonicalized away in current or any previous observation array", async () => {
  for (const target of [s => s.sources.observations, s => s.comparison.previousSources.observations,
    s => s.comparisonByProduct.lodging.previousSources.observations, s => s.comparisonByProduct.dayuse.previousSources.observations]) {
    for (const variant of ["omitted_value", "property_order"]) {
      const f = projectionFixture(), rows = target(f.payload.snapshot), first = rows[0];
      const changed = variant === "omitted_value" ? { ...clone(first), capacityWitnesses: [{ productKey: "different", count: 5 }] }
        : Object.fromEntries(Object.entries(first).reverse());
      rows.push(changed);
      assert.deepEqual(await f.store.writeResult(f.payload, f.catalogue), { stored: false, reasonCode: "KEYWORD_MONTHLY_CACHE_OBSERVATION_CONFLICT" });
      assert.equal(f.entries.has(RESULT_KEY), false);
    }
  }
});
test("identical duplicate counts and original order survive projection in current and previous arrays", async () => {
  const f = projectionFixture(), rows = f.payload.snapshot.sources.observations;
  rows.push(clone(rows[0]), { ...clone(rows[0]), date: "2026-11-02" });
  const previous = f.payload.snapshot.comparison.previousSources.observations; previous.push(clone(previous[0]), { ...clone(previous[0]), productType: "dayuse" });
  assert.equal(await f.store.write(f.payload, f.catalogue), true); const result = await f.store.read(selection);
  assert.deepEqual(result.payload.snapshot.sources.observations.map(row => row.date), ["2026-11-01", "2026-11-01", "2026-11-02"]);
  assert.deepEqual(result.payload.snapshot.comparison.previousSources.observations, [{ productType: "lodging" }, { productType: "lodging" }, { productType: "dayuse" }]);
});
test("omission cannot hide private fields getters custom serializers or unknown future errors", async () => {
  for (const target of [s => s.sources.observations[0].capacityWitnesses[0], s => s.context,
    s => s.changes, s => s.ranks, s => s.insights, s => s.definitions, s => s.companies[0].daily[0]]) {
    for (const kind of ["secret", "getter", "toJSON"]) {
      const f = projectionFixture(), value = target(f.payload.snapshot); let invoked = 0;
      if (kind === "secret") value.secret = "MUST_NOT_LEAK";
      else if (kind === "getter") Object.defineProperty(value, "synthetic", { enumerable: true, get() { invoked++; return "MUST_NOT_LEAK"; } });
      else value.toJSON = () => { invoked++; return {}; };
      const result = await f.store.writeResult(f.payload, f.catalogue);
      assert.equal(result.stored, false, kind); assert.equal(invoked, 0, kind); assert.equal(f.entries.has(RESULT_KEY), false);
      assert.ok(!JSON.stringify(result).includes("MUST_NOT_LEAK"));
    }
  }
  const unknown = projectionFixture(); unknown.payload.snapshot.futureField = { guestPhoneNumber: "MUST_NOT_LEAK" };
  assert.deepEqual(await unknown.store.writeResult(unknown.payload, unknown.catalogue), { stored: false, reasonCode: "KEYWORD_MONTHLY_CACHE_UNSAFE_FIELD" });
});
test("versioned cache reads cannot reproject a wrong representation into checksum acceptance", async () => {
  for (const mutate of [e => { e.projectionVersion = 2; }, e => { e.payload.snapshot.context = {}; },
    e => { e.payload.snapshot.companies[0].daily = []; }, e => { e.payload.snapshot.sources.observations[0].capacityWitnesses = []; },
    e => { e.payload.snapshot.comparison.previousSources.observations[0].companyId = "injected"; },
    e => { e.payload.snapshot.sources.observations.push({ ...e.payload.snapshot.sources.observations[0], sold: 1 }); }]) {
    const f = projectionFixture(); await f.store.write(f.payload, f.catalogue); const entry = JSON.parse(f.entries.get(RESULT_KEY)); mutate(entry);
    entry.contentSha256 = await digest(JSON.stringify({ projectionVersion: entry.projectionVersion, payload: entry.payload, catalogue: entry.catalogue }));
    f.entries.set(RESULT_KEY, JSON.stringify(entry)); assert.equal(await f.store.read(selection), null); assert.equal(f.entries.has(RESULT_KEY), false);
  }
});
test("legacy schema1 content remains verified and schema2 is not silently downgraded", async () => {
  const f = fixture(); await f.store.write(f.payload, f.catalogue); const current = JSON.parse(f.entries.get(RESULT_KEY));
  assert.equal(current.schema, 2); assert.equal(Object.hasOwn(current, "projectionVersion"), true);
  const content = { payload: current.payload, catalogue: current.catalogue };
  const legacy = { schema: 1, scope: A, storedAt: NOW, expiresAt: NOW + 3600000, contentSha256: await digest(JSON.stringify(content)), ...content };
  f.entries.set(RESULT_KEY, JSON.stringify(legacy)); const result = await f.store.read(selection);
  assert.deepEqual(result.payload, f.payload); assert.equal(Object.hasOwn(result, "projectionVersion"), false);
  f.entries.set(RESULT_KEY, JSON.stringify({ ...current, schema: 1 })); assert.equal(await f.store.read(selection), null);
});
test("async hashing stores the captured projection rather than a later mutation of caller-owned values", async () => {
  let release; const gate = new Promise(resolve => { release = resolve; });
  const f = projectionFixture(); const writingStore = createLastGoodStorage({ storage: f.storage, authorization: () => ({ authenticated: true, scope: A, expiresAt: NOW + 3600000 }),
    now: () => NOW, digest: content => gate.then(() => digest(content)) });
  const writing = writingStore.write(f.payload, f.catalogue); f.payload.snapshot.summary.lodging.sold = 99; f.payload.snapshot.sources.observations[0].sold = 99;
  release(); assert.equal(await writing, true); const result = await f.store.read(selection);
  assert.equal(result.payload.snapshot.summary.lodging.sold, 0); assert.equal(result.payload.snapshot.sources.observations[0].sold, 0);
});
test("inherited flags and names cannot disappear into an apparently valid JSON display projection", async () => {
  for (const company of [false, true]) {
    const f = projectionFixture(), parent = Object.assign(Object.create(null), company ? { primaryName: "HIDDEN_NAME" } : { partial: true });
    if (company) f.payload.snapshot.companies[0] = Object.assign(Object.create(parent), { companyId: "synthetic-company", summary: f.payload.snapshot.summary });
    else f.payload.snapshot.sources.observations[0] = Object.assign(Object.create(parent), evidenceRow());
    assert.deepEqual(await f.store.writeResult(f.payload, f.catalogue), { stored: false, reasonCode: "KEYWORD_MONTHLY_CACHE_PROJECTION_INVALID" });
    assert.equal(f.entries.has(RESULT_KEY), false);
  }
});
