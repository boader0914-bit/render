"use strict";

const test = require("node:test"), assert = require("node:assert/strict");
const C = require("../web/keyword-monthly-catalogue-cache.js");
const AT = Date.parse("2026-11-17T01:00:00.000Z"), A = "a".repeat(64), B = "b".repeat(64), GEN = "c".repeat(32);
const clone = value => JSON.parse(JSON.stringify(value));
function options() {
  return { schemaVersion: 1, status: "available", readOnly: true, networkAttempted: false, currentDay: "2026-11-17", currentMonth: "2026-11",
    provenance: { currentPointerSha256: A, originalFreshnessVerified: false, dataThrough: "2026-11-16T04:05:55.229Z", inputSha256: B },
    bundle: { generation: GEN, scopeCount: 2 }, keywords: [{ keyword: "합성글램핑", stayMonths: ["2026-10", "2026-11"], collectionMonths: ["2026-11"],
      supportedCutoffs: { "2026-10": "2026-10-31", "2026-11": "2026-11-16" }, defaultCutoffs: { "2026-11": "2026-11-17" },
      provenanceByMonth: { "2026-10": { dataThrough: "2026-11-16T04:05:55.229Z", inputSha256: B }, "2026-11": { dataThrough: "2026-11-16T04:05:55.229Z", originalFreshnessVerified: false } } }] };
}
function version() { return { schemaVersion: 1, status: "available", revision: A, generation: GEN, currentDay: "2026-11-17", publishedAt: "2026-11-16T04:05:55.229Z", readOnly: true, networkAttempted: false, originalFreshnessVerified: false }; }
function memoryStorage() {
  const data = new Map(), calls = [];
  return { data, calls, getItem(key) { calls.push(["get", key]); return data.get(key) ?? null; },
    setItem(key, value) { calls.push(["set", key]); data.set(key, value); }, removeItem(key) { calls.push(["remove", key]); data.delete(key); } };
}
function fixture({ at = AT, storage = memoryStorage(), expiresAt = AT + 3600000 } = {}) {
  let clock = at; const cache = C.createCatalogueCache({ storage, now: () => clock });
  return { cache, storage, setNow(value) { clock = value; }, auth(scope = A, expiry = expiresAt) { return cache.configure({ authenticated: true, scope, expiresAt: expiry }); },
    entry() { return JSON.parse(storage.data.get(C.KEY)); }, replace(value) { storage.data.set(C.KEY, JSON.stringify(value)); } };
}

test("no catalogue is read or persisted before current authenticated scope configuration", () => {
  const f = fixture(); assert.equal(f.cache.read(), null); assert.equal(f.cache.write(options()), false); assert.equal(f.storage.calls.some(c => c[0] === "get" || c[0] === "set"), false);
});

test("a valid catalogue roundtrips one bounded metadata entry with supported cutoffs", () => {
  const f = fixture(); assert.equal(f.auth(), true); assert.equal(f.cache.write(options()), true); const m = f.cache.read();
  assert.equal(f.storage.data.size, 1); assert.ok(Buffer.byteLength(f.storage.data.get(C.KEY)) <= C.MAX_BYTES);
  assert.deepEqual(Object.keys(m).sort(), ["currentDay", "generation", "keywords", "revision"]);
  assert.deepEqual(m.keywords[0].supportedCutoffs, options().keywords[0].supportedCutoffs);
  assert.deepEqual(Object.keys(m.keywords[0]).sort(), ["dataThroughByMonth", "keyword", "stayMonths", "supportedCutoffs"]);
});

test("projection never stores financial payload, customers, raw authentication, refresh status or unrecognized fields", () => {
  const value = options(), before = clone(value);
  value.snapshot = { revenue: null, price: 123456, companies: [{ companyId: "synthetic-company", customer: "synthetic-customer" }] };
  value.username = "synthetic-account"; value.token = "synthetic-token"; value.refreshStatus = { status: "running", jobs: ["synthetic-job"] };
  value.keywords[0].customer = "synthetic-customer"; value.keywords[0].provenanceByMonth["2026-11"].privateField = "synthetic-private";
  const f = fixture(); f.auth(); assert.equal(f.cache.write(value), true); const raw = f.storage.data.get(C.KEY), m = f.cache.read();
  for (const forbidden of ["revenue", "price", "companyId", "synthetic-", "username", "token", "refreshStatus", "privateField", "inputSha256"]) assert.equal(raw.includes(forbidden), false, forbidden);
  assert.equal(Object.hasOwn(m, "snapshot"), false); assert.equal(value.snapshot.revenue, null); assert.deepEqual(before, options(), "source fixtures are not mutated");
});

test("projected and returned metadata do not share mutable source or storage objects", () => {
  const f = fixture(), value = options(), initial = clone(value); f.auth(); f.cache.write(value);
  value.keywords[0].stayMonths.push("2026-12"); value.keywords[0].supportedCutoffs["2026-11"] = "2026-11-17";
  const a = f.cache.read(); a.keywords[0].stayMonths.length = 0;
  assert.deepEqual(f.cache.read(), C.projectCatalogue(initial));
});

test("another account or login-created session scope cannot reuse an existing catalogue", () => {
  const f = fixture(); f.auth(); f.cache.write(options()); assert.equal(f.auth(B), true); assert.equal(f.cache.read(), null); assert.equal(f.storage.data.size, 0);
  f.auth(A); f.cache.write(options()); const other = fixture({ storage: f.storage }); other.auth(B); assert.equal(other.cache.read(), null);
});

test("invalid authorization and expiry revoke memory and persisted catalogue", () => {
  for (const invalid of [null, {}, { authenticated: false, scope: A, expiresAt: AT + 1000 }, { authenticated: true, scope: [A], expiresAt: AT + 1000 },
    { authenticated: true, scope: A, expiresAt: AT }, { authenticated: true, scope: A, expiresAt: Infinity },
    { authenticated: true, scope: A, expiresAt: AT + 1000, username: "synthetic-account" }]) {
    const f = fixture(); f.auth(); f.cache.write(options()); assert.equal(f.cache.configure(invalid), false); assert.equal(f.cache.read(), null); assert.equal(f.storage.data.size, 0);
  }
  const f = fixture(); f.auth(A, AT + 1000); f.cache.write(options()); f.setNow(AT + 1000); assert.equal(f.cache.read(), null); assert.equal(f.cache.write(options()), false);
});

test("same scope cannot reuse an entry past its currently authenticated shorter expiry", () => {
  const f = fixture(); f.auth(); f.cache.write(options()); f.auth(A, AT + 1000); assert.equal(f.cache.read(), null);
});

test("five-minute TTL, entry expiry and backward clock are strict boundaries", () => {
  const f = fixture(); f.auth(); f.cache.write(options()); f.setNow(AT + C.TTL_MS - 1); assert.ok(f.cache.read()); f.setNow(AT + C.TTL_MS); assert.equal(f.cache.read(), null);
  const back = fixture(); back.auth(); back.cache.write(options()); back.setNow(AT - 1); assert.equal(back.cache.read(), null);
  const early = fixture(); early.auth(); early.cache.write(options()); const e = early.entry(); e.expiresAt = AT + 100; early.replace(e); early.setNow(AT + 100); assert.equal(early.cache.read(), null);
});

test("Korean midnight invalidates the prior date even inside TTL", () => {
  const at = Date.parse("2026-11-16T14:59:00.000Z"), f = fixture({ at, expiresAt: at + 3600000 }), value = options();
  value.currentDay = "2026-11-16"; f.auth(A, at + 3600000); assert.equal(f.cache.write(value), true); assert.ok(f.cache.read());
  f.setNow(Date.parse("2026-11-16T15:00:00.000Z")); assert.equal(f.cache.read(), null); assert.equal(f.cache.write(value), false);
  value.currentDay = "2026-11-17"; assert.equal(f.cache.write(value), true);
});

test("tampered envelope, schemas, scopes, future timestamps and excessive expiry are discarded", () => {
  const changes = [e => ({ ...e, schema: 2 }), e => ({ ...e, scope: B }), e => ({ ...e, storedAt: AT + 1 }),
    e => ({ ...e, expiresAt: AT + C.TTL_MS + 1 }), e => ({ ...e, storedAt: "2026-11-17" }), e => ({ ...e, extra: null }),
    e => { delete e.metadata.generation; return e; }, e => { e.metadata.extra = { price: null }; return e; }];
  for (const change of changes) { const f = fixture(); f.auth(); f.cache.write(options()); f.replace(change(f.entry())); assert.equal(f.cache.read(), null); assert.equal(f.storage.data.size, 0); }
});

test("invalid JSON, oversized persisted bytes and invalid metadata fail closed", () => {
  for (const raw of ["{broken", "x".repeat(C.MAX_BYTES + 1), "한".repeat(Math.ceil(C.MAX_BYTES / 3) + 1), "null", "[]"]) {
    const f = fixture(); f.auth(); f.storage.data.set(C.KEY, raw); assert.equal(f.cache.read(), null); assert.equal(f.storage.data.size, 0);
  }
});

test("metadata rejects coercible hashes or months, invalid dates, duplicate words and unknown nested fields", () => {
  const bad = [m => { m.revision = [A]; }, m => { m.generation = [GEN]; }, m => { m.currentDay = "2026-02-30"; },
    m => { m.keywords[0].stayMonths[0] = ["2026-10"]; }, m => { m.keywords[0].stayMonths.push("2026-10"); },
    m => { m.keywords.push(clone(m.keywords[0])); }, m => { m.keywords[0].extra = null; },
    m => { m.keywords[0].supportedCutoffs["2026-12"] = "2026-11-16"; }, m => { m.keywords[0].supportedCutoffs["2026-11"] = "2026-11-18"; },
    m => { m.keywords[0].dataThroughByMonth["2026-11"] = "2026-02-30T01:00:00Z"; },
    m => { m.keywords[0].dataThroughByMonth["2026-11"] = "2026-11-16T24:00:00Z"; }, m => { m.keywords[0].keyword = "bad\nkeyword"; }];
  for (const change of bad) { const m = C.projectCatalogue(options()); change(m); assert.equal(C.validMetadata(m), false); }
});

test("only a recognized readonly offline options DTO can populate the cache", () => {
  for (const patch of [{ schemaVersion: 2 }, { status: "running" }, { status: "stale" }, { readOnly: false }, { networkAttempted: true },
    { provenance: { currentPointerSha256: A, originalFreshnessVerified: true } }, { provenance: { currentPointerSha256: A } },
    { keywords: [] }, { keywords: Array.from({ length: 129 }, (_, i) => ({ ...options().keywords[0], keyword: `synthetic-${i}` })) }]) {
    assert.equal(C.projectCatalogue({ ...options(), ...patch }), null);
  }
  assert.ok(C.projectCatalogue(options()));
});

test("partial catalogues and diagnostics use the uncached path so their warnings cannot disappear", () => {
  for (const change of [v => { v.diagnostics = ["KEYWORD_MONTHLY_BUNDLE_SOME_PARTITIONS_UNAVAILABLE"]; },
    v => { v.diagnostics = {}; }, v => { v.bundle.unavailablePartitions = ["synthetic-partition"]; },
    v => { v.bundle.unavailablePartitions = {}; }, v => { v.keywords[0].availabilityByMonth = { "2026-11": "needs_verification" }; },
    v => { v.keywords[0].availabilityByMonth = { "2026-11": "stale" }; }]) {
    const value = options(), f = fixture(); change(value); f.auth(); assert.equal(C.projectCatalogue(value), null); assert.equal(f.cache.write(value), false); assert.equal(f.storage.data.size, 0);
  }
  const value = options(); value.diagnostics = []; value.bundle.unavailablePartitions = []; value.keywords[0].availabilityByMonth = { "2026-10": "available", "2026-11": "available" };
  assert.ok(C.projectCatalogue(value));
});

test("malformed optional raw provenance is omitted while required metadata stays strict", () => {
  const v = options(); v.keywords[0].supportedCutoffs = null; v.keywords[0].provenanceByMonth["2026-11"].dataThrough = "invalid";
  const m = C.projectCatalogue(v); assert.deepEqual(m.keywords[0].supportedCutoffs, {}); assert.equal(Object.hasOwn(m.keywords[0].dataThroughByMonth, "2026-11"), false);
});

test("UTF8 write cap and scope cardinality limits cannot be bypassed", () => {
  const f = fixture(); f.auth(); const v = options(), months = ["2026-08", "2026-09", "2026-10", "2026-11"];
  v.keywords = Array.from({ length: 128 }, (_, i) => ({ keyword: `${String(i).padStart(3, "0")}${"한".repeat(290)}`, stayMonths: months,
    supportedCutoffs: Object.fromEntries(months.map(m => [m, "2026-11-16"])), provenanceByMonth: Object.fromEntries(months.map(m => [m, { dataThrough: "2026-11-16T04:05:55.229Z" }])) }));
  assert.ok(C.projectCatalogue(v)); assert.equal(f.cache.write(v), false); assert.equal(f.storage.data.size, 0);
  v.keywords[0].stayMonths.push("2026-12"); assert.equal(C.projectCatalogue(v), null);
});

test("storage exceptions and missing browser storage degrade to a miss without exposing payloads", () => {
  for (const storage of [undefined, { getItem() { throw new Error("synthetic-denied"); }, setItem() { throw new Error("synthetic-full"); }, removeItem() { throw new Error("synthetic-denied"); } }]) {
    const c = C.createCatalogueCache({ storage, now: () => AT }); assert.equal(c.configure({ authenticated: true, scope: A, expiresAt: AT + 10000 }), true);
    assert.equal(c.read(), null); assert.equal(c.write(options()), false); assert.doesNotThrow(() => c.revoke());
  }
});

test("clear and revoke have distinct current-session semantics", () => {
  const f = fixture(); f.auth(); f.cache.write(options()); f.cache.clear(); assert.equal(f.cache.read(), null); assert.equal(f.cache.write(options()), true);
  f.cache.revoke(); assert.equal(f.cache.read(), null); assert.equal(f.cache.write(options()), false);
});

test("a live revision, generation and Korean date must all match before metadata becomes options", () => {
  const m = C.projectCatalogue(options());
  for (const patch of [{ revision: B }, { generation: "d".repeat(32) }, { currentDay: "2026-11-18" }, { schemaVersion: 2 }, { status: "stale" },
    { readOnly: false }, { networkAttempted: true }, { originalFreshnessVerified: true }]) assert.equal(C.catalogueForVersion(m, { ...version(), ...patch }), null);
  const adapted = C.catalogueForVersion(m, version()); assert.ok(adapted); assert.equal(adapted.provenance.originalFreshnessVerified, false);
  assert.deepEqual(adapted.keywords[0].defaultCutoffs, options().keywords[0].supportedCutoffs); assert.equal(adapted.refreshStatus, null); assert.equal(Object.hasOwn(adapted, "snapshot"), false);
  adapted.keywords[0].supportedCutoffs["2026-11"] = "2026-11-17"; assert.equal(m.keywords[0].supportedCutoffs["2026-11"], "2026-11-16");
});
