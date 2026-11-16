"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { createMonthlyObservationIdentityResolver: create, IDENTITY_RESOLVER_VERSION } = require("./lib/monthly_observation_identity.cjs");
const clone = value => JSON.parse(JSON.stringify(value));
function population() { return [
  { companyId: "cmp_a", primaryName: "동명이름", aliases: ["이름별칭"], placeIds: ["101"], bookingBusinessIds: ["201"] },
  { companyId: "cmp_b", primaryName: "동명이름", placeIds: ["102"], bookingBusinessIds: ["202"] }
]; }
function resolved(row, id = "cmp_a", companies = population()) {
  const result = create({ companies }).resolve(row); assert.equal(result.status, "resolved"); assert.equal(result.companyId, id); assert.equal(result.reasonCode, null); return result;
}
function held(row, reasonCode, companies = population()) {
  const result = create({ companies }).resolve(row); assert.equal(result.status, "unresolved"); assert.equal(result.companyId, null); assert.equal(result.basis, "none");
  if (reasonCode) assert.equal(result.reasonCode, reasonCode); return result;
}
test("a recorded exact accommodation URL identifies a unique owner without using a legacy name", () => {
  const value = resolved({ companyKey: "전혀다른옛이름", sourceUrl: "https://m.place.naver.com/accommodation/101/home?entry=pll" });
  assert.equal(value.basis, "unique_place_id"); assert.deepEqual(value.providerIds, { placeId: "101" });
});
test("an exact booking business route uses bizes, never its product or query numbers", () => {
  const value = resolved({ sourceUrl: "https://booking.naver.com/booking/3/bizes/201/items/102?businessId=202" });
  assert.equal(value.basis, "unique_booking_business_id"); assert.deepEqual(value.providerIds, { bookingBusinessId: "201" });
  resolved({ sourceUrl: "https://booking.naver.com/bizes/201" });
});
test("supported map entry and pcmap routes preserve exact provider ownership", () => {
  for (const sourceUrl of ["https://map.naver.com/p/entry/place/101", "https://map.naver.com/v5/entry/place/101", "https://map.naver.com/entry/place/101", "https://pcmap.place.naver.com/place/101"]) resolved({ sourceUrl });
});
test("a current canonical company key is independent evidence", () => {
  assert.equal(resolved({ companyKey: "cmp_a" }).basis, "canonical_company_id"); resolved({ companyKey: " CMP_A " });
});
test("a legacy name companyKey does not hide a separate valid companyId", () => resolved({ companyKey: "옛숙소명", companyId: "cmp_a" }));
test("same names and display aliases alone never identify an owner", () => {
  held({ companyKey: "동명이름", companyName: "동명이름" }, "IDENTITY_NO_STRONG_ID"); held({ companyKey: "이름별칭" }, "IDENTITY_NO_STRONG_ID");
});
test("consistent canonical, place and booking evidence agrees without voting", () => {
  const value = resolved({ companyId: "cmp_a", placeId: 101, place_id: "101", bookingBusinessId: "201", booking_business_id: "201", sourceUrl: "https://m.place.naver.com/place/101" });
  assert.equal(value.basis, "consistent_strong_ids"); assert.deepEqual(value.providerIds, { placeId: "101", bookingBusinessId: "201" });
});
test("explicit provider fields and recorded URLs cannot disagree", () => {
  held({ placeId: "102", sourceUrl: "https://m.place.naver.com/place/101" }, "IDENTITY_CONFLICTING_PROVIDER_IDS");
  held({ bookingBusinessId: "202", sourceUrl: "https://booking.naver.com/bizes/201" }, "IDENTITY_CONFLICTING_PROVIDER_IDS");
  held({ placeId: "101", place_id: "102" }, "IDENTITY_CONFLICTING_PROVIDER_IDS");
});
test("a canonical owner and a different provider owner are a hard conflict", () => {
  held({ companyId: "cmp_b", sourceUrl: "https://m.place.naver.com/place/101" }, "IDENTITY_CONFLICTING_STRONG_IDS");
  held({ placeId: "101", bookingBusinessId: "202" }, "IDENTITY_CONFLICTING_STRONG_IDS");
});
test("two explicit canonical company identities cannot be combined", () => held({ companyKey: "cmp_a", companyId: "cmp_b" }, "IDENTITY_CONFLICTING_STRONG_IDS"));
test("an unknown explicit cmp identifier cannot be rescued with a name or URL", () => {
  held({ companyKey: "cmp_unknown", companyName: "동명이름", sourceUrl: "https://m.place.naver.com/place/101" }, "IDENTITY_UNKNOWN_COMPANY_ID");
  held({ companyKey: "옛이름", companyId: "cmp_unknown", placeId: "101" }, "IDENTITY_UNKNOWN_COMPANY_ID");
});
test("a shared place ID remains ambiguous even if another signal is unique", () => {
  const companies = population(); companies[1].placeIds.push("101");
  held({ placeId: "101", bookingBusinessId: "201", companyId: "cmp_a" }, "IDENTITY_AMBIGUOUS_PLACE_ID", companies);
});
test("a shared booking business ID cannot silently pick the first company", () => {
  const companies = population(); companies[1].bookingBusinessIds.push("201"); held({ booking_business_id: "201" }, "IDENTITY_AMBIGUOUS_BOOKING_ID", companies);
});
test("an otherwise valid but unregistered provider ID stays unresolved", () => held({ sourceUrl: "https://m.place.naver.com/place/999" }, "IDENTITY_UNKNOWN_PLACE_ID"));
test("reviewed merge aliases belong only to their active target while deleted provider duplicates are excluded", () => {
  const companies = population(); companies[0].duplicateNotes = [{ mergedCompanyId: "cmp_old", reason: "관리자 병합" }];
  companies.push({ companyId: "cmp_old", placeIds: ["101"], bookingBusinessIds: ["201"], deletedAt: "2026-11-01T00:00:00Z" });
  const value = resolved({ companyKey: "cmp_old" }, "cmp_a", companies); assert.equal(value.basis, "reviewed_merge_alias"); resolved({ placeId: "101" }, "cmp_a", companies);
});
test("deleted or merged records without a reviewed active alias are not active owners", () => {
  const companies = population(); companies.push({ companyId: "cmp_deleted", deletedAt: "2026-11-01" }, { companyId: "cmp_merged", mergedIntoCompanyId: "cmp_a" });
  held({ companyId: "cmp_deleted" }, "IDENTITY_INACTIVE_COMPANY_ID", companies); held({ companyKey: "cmp_merged" }, "IDENTITY_INACTIVE_COMPANY_ID", companies);
});
test("two active owners claiming one reviewed alias produce a conflict", () => {
  const companies = population(); for (const c of companies) c.duplicateNotes = [{ mergedCompanyId: "cmp_old" }];
  held({ companyId: "cmp_old", placeId: "101" }, "IDENTITY_AMBIGUOUS_COMPANY_ID", companies);
});
test("URL spoofing, non-HTTPS, userinfo, unexpected ports, short links and embedded redirects supply no evidence", () => {
  for (const sourceUrl of ["https://m.place.naver.com.evil.example/place/101", "https://evil.example/?next=https://m.place.naver.com/place/101",
    "http://m.place.naver.com/place/101", "https://user:secret@m.place.naver.com/place/101", "https://m.place.naver.com@evil.example/place/101",
    "https://m.place.naver.com:444/place/101", "https://naver.me/101", "https://m.booking.naver.com/bizes/201", "https://m.place.naver.com/./place/101",
    "https://m.place.naver.com/%2e%2e/place/101", "https://m.place.naver.com/place%2f101", "https://m.place.naver.com\\place\\101", " https://m.place.naver.com/place/101",
    "https://m.place.naver.com/place/" + "1".repeat(4100)]) held({ sourceUrl });
});
test("query-only numbers, product routes and wrong route positions are not provider identities", () => {
  for (const sourceUrl of ["https://m.place.naver.com/?placeId=101", "https://booking.naver.com/booking/3/items/201", "https://m.place.naver.com/items/101",
    "https://m.place.naver.com/fake/place/101", "https://m.place.naver.com/place/%31%30%31", "https://map.naver.com/p/entry?place=101"]) held({ sourceUrl });
});
test("multiple route IDs or alias provider fields cannot hide disagreement", () => {
  held({ sourceUrl: "https://m.place.naver.com/place/101/place/102" }, "IDENTITY_CONFLICTING_SOURCE_URL_IDS");
  held({ sourceUrl: "https://booking.naver.com/bizes/201/bizes/202" }, "IDENTITY_CONFLICTING_SOURCE_URL_IDS");
  held({ bookingBusinessId: "201", booking_business_id: "202" }, "IDENTITY_CONFLICTING_PROVIDER_IDS");
});
test("malformed explicit provider IDs remain unknown, while a non-provider URL does not override a valid direct ID", () => {
  for (const placeId of [true, {}, "1e2", "101.0", "0", -1, Number.MAX_SAFE_INTEGER + 1]) held({ placeId }, "IDENTITY_INVALID_PROVIDER_ID");
  resolved({ companyId: "cmp_a", sourceUrl: "https://example.com/101" });
});
test("catalog digest is stable across order and names but changes with identity ownership", () => {
  const companies = population(), a = create({ companies }), reverse = clone(companies).reverse(); reverse[0].primaryName = "새표시명"; reverse[1].aliases = ["새이름"];
  assert.equal(a.catalogDigest, create({ companies: reverse }).catalogDigest); assert.match(a.catalogDigest, /^[a-f0-9]{64}$/);
  const changed = clone(companies); changed[0].bookingBusinessIds.push("203"); assert.notEqual(a.catalogDigest, create({ companies: changed }).catalogDigest);
  companies[0].placeIds[0] = "999"; assert.equal(a.resolve({ placeId: "101" }).companyId, "cmp_a", "constructor snapshots identity primitives");
  assert.match(IDENTITY_RESOLVER_VERSION, /^monthly-observation-identity-v\d+$/);
});
test("resolution is immutable, does not read name accessors, and never exposes source URLs or input payloads", () => {
  const companies = population(); Object.defineProperty(companies[0], "primaryName", { get() { throw Error("name must not be consulted"); } });
  const resolver = create({ companies }), row = Object.freeze({ companyKey: "legacy", sourceUrl: "https://m.place.naver.com/place/101?secret=DO_NOT_EMIT", payload: "DO_NOT_EMIT" });
  const value = resolver.resolve(row); assert.equal(value.status, "resolved"); assert.equal(Object.isFrozen(value), true); assert.equal(Object.isFrozen(value.providerIds), true);
  assert.equal(/DO_NOT_EMIT|sourceUrl|payload/.test(JSON.stringify(value)), false);
  let called = false; const accessor = {}; Object.defineProperty(accessor, "sourceUrl", { get() { called = true; return row.sourceUrl; } });
  assert.equal(resolver.resolve(accessor).reasonCode, "IDENTITY_INVALID_INPUT"); assert.equal(called, false);
});
test("invalid catalog and row contracts fail closed without returning arbitrary exception text", () => {
  assert.throws(() => create({ companies: [...population(), population()[0]] }), TypeError); assert.throws(() => create({ companies: null }), TypeError);
  for (const row of [null, [], "name"]) held(row, "IDENTITY_INVALID_INPUT");
});
