"use strict";
// Pure, conservative evidence resolver for separately reviewing unidentified
// historical observations. It never matches names, mutates a row/catalog,
// fetches a URL, or changes the existing monthly canonical/selection policy.
const crypto = require("node:crypto");
const IDENTITY_RESOLVER_VERSION = "monthly-observation-identity-v1";
const LIMITS = Object.freeze({ companies: 10000, references: 100000, urlLength: 4096, providerIdLength: 24 });
const PLACE_HOSTS = new Set(["m.place.naver.com", "pcmap.place.naver.com", "map.naver.com"]);
const plain = value => value !== null && typeof value === "object" && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
function own(value, key) {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor) return undefined;
  if (!Object.hasOwn(descriptor, "value")) throw TypeError("Identity fields must be stored data values");
  return descriptor.value;
}
const absent = value => value === undefined || value === null || value === "";
function companyToken(value) {
  return typeof value === "string" && /^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,179}$/.test(value.trim()) ? value.trim().toLowerCase() : null;
}
function providerId(value) {
  if (typeof value === "number") { if (!Number.isSafeInteger(value) || value <= 0) return null; value = String(value); }
  if (typeof value !== "string") return null;
  const trimmed = value.trim(); return new RegExp(`^[0-9]{1,${LIMITS.providerIdLength}}$`).test(trimmed) && /[1-9]/.test(trimmed) ? trimmed : null;
}
function recordedUrl(value) {
  if (absent(value)) return { status: "absent" };
  if (typeof value !== "string" || value.length > LIMITS.urlLength || /[\u0000-\u0020\u007f\\]/.test(value)) return { status: "invalid" };
  let url; try { url = new URL(value); } catch { return { status: "invalid" }; }
  if (url.protocol !== "https:" || url.username || url.password || url.port) return { status: "invalid" };
  const recordedPath = value.match(/^https:\/\/[^/?#]+([^?#]*)/i)?.[1] || "";
  if (/(?:^|\/)(?:\.|%2e){1,2}(?:\/|$)/i.test(recordedPath) || /%2f|%5c/i.test(recordedPath)) return { status: "invalid" };
  const pathname = url.pathname;
  if (PLACE_HOSTS.has(url.hostname)) {
    const path = pathname.match(/^\/(?:place|accommodation|camping|pension|hotel|motel)\/([0-9]+)(?:\/|$)/)
      || (url.hostname === "map.naver.com" ? pathname.match(/^\/(?:p\/entry|v5\/entry|entry)\/place\/([0-9]+)(?:\/|$)/) : null);
    if (!path) return { status: "unsupported" };
    const ids = [...pathname.matchAll(/\/(?:place|accommodation|camping|pension|hotel|motel)\/([0-9]+)(?=\/|$)/g)].map(match => providerId(match[1]));
    if (ids.some(id => id === null)) return { status: "invalid" };
    if (new Set(ids).size !== 1) return { status: "conflict" };
    return { status: "identified", placeId: ids[0] };
  }
  if (url.hostname === "booking.naver.com") {
    const path = pathname.match(/^\/(?:booking\/[0-9]+\/)?bizes\/([0-9]+)(?:\/|$)/);
    if (!path) return { status: "unsupported" };
    const ids = [...pathname.matchAll(/\/bizes\/([0-9]+)(?=\/|$)/g)].map(match => providerId(match[1]));
    if (ids.some(id => id === null)) return { status: "invalid" };
    if (new Set(ids).size !== 1) return { status: "conflict" };
    return { status: "identified", bookingBusinessId: ids[0] };
  }
  return { status: "unsupported" };
}
function createMonthlyObservationIdentityResolver({ companies } = {}) {
  let rows;
  if (Array.isArray(companies)) rows = companies;
  else if (companies instanceof Map) rows = [...companies.values()];
  else if (plain(companies)) rows = Object.keys(companies).map(key => own(companies, key));
  else throw TypeError("An explicit current company population is required");
  if (rows.length > LIMITS.companies) throw TypeError("Company identity population exceeds its bound");
  const companyOwners = new Map(), placeOwners = new Map(), bookingOwners = new Map(), direct = new Map(), inactive = new Set(); let referenceCount = 0;
  const add = (index, key, id) => {
    if (++referenceCount > LIMITS.references) throw TypeError("Company identity references exceed their bound");
    const owners = index.get(key) || new Set(); owners.add(id); index.set(key, owners);
  };
  const active = [];
  for (const company of rows) {
    if (!plain(company)) throw TypeError("Company identities must be ordinary stored objects");
    const originalId = own(company, "companyId"), token = companyToken(originalId);
    if (own(company, "deletedAt") || own(company, "mergedIntoCompanyId")) { if (token) inactive.add(token); continue; }
    if (!token || direct.has(token)) throw TypeError("Active company identities must be present and unique");
    const id = originalId.trim(); direct.set(token, id); add(companyOwners, token, id); active.push({ company, id });
  }
  for (const { company, id } of active) {
    // Display aliases deliberately never enter an identity index. This field
    // is the application's persisted administrator merge record, not a name.
    const notes = own(company, "duplicateNotes");
    if (Array.isArray(notes)) for (const note of notes) if (plain(note)) { const alias = companyToken(own(note, "mergedCompanyId")); if (alias) add(companyOwners, alias, id); }
    for (const [field, index] of [["placeIds", placeOwners], ["bookingBusinessIds", bookingOwners]]) {
      const values = own(company, field); if (!Array.isArray(values)) continue;
      for (const value of values) { const parsed = providerId(value); if (parsed) add(index, parsed, id); }
    }
  }
  const entries = map => [...map].map(([key, values]) => [key, [...values].sort()]).sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
  const catalogDigest = crypto.createHash("sha256").update(JSON.stringify([IDENTITY_RESOLVER_VERSION, entries(companyOwners), entries(placeOwners), entries(bookingOwners), [...inactive].sort()])).digest("hex");
  function resolve(row) {
    let safeIds = {};
    const result = (status, companyId, basis, reasonCode) => Object.freeze({ status, companyId, basis, reasonCode,
      ...(Object.keys(safeIds).length ? { providerIds: Object.freeze({ ...safeIds }) } : {}) });
    const hold = code => result("unresolved", null, "none", code);
    if (!plain(row)) return hold("IDENTITY_INVALID_INPUT");
    try {
      const url = recordedUrl(own(row, "sourceUrl"));
      if (url.status === "invalid") return hold("IDENTITY_INVALID_SOURCE_URL");
      if (url.status === "conflict") return hold("IDENTITY_CONFLICTING_SOURCE_URL_IDS");
      const signals = [], bases = [];
      const matchOwner = (index, value, missing, ambiguous, basis) => {
        const owners = index.get(value);
        if (!owners?.size) return missing;
        if (owners.size !== 1) return ambiguous;
        signals.push([...owners][0]); bases.push(basis); return null;
      };
      for (const field of ["companyKey", "companyId"]) {
        const raw = own(row, field); if (absent(raw)) continue;
        const token = companyToken(raw), known = token && companyOwners.has(token);
        if (!known && field === "companyKey" && !(typeof raw === "string" && /^cmp_/i.test(raw.trim()))) continue; // legacy display key has no identity authority
        if (!token) return hold("IDENTITY_INVALID_COMPANY_ID");
        const failure = matchOwner(companyOwners, token, inactive.has(token) ? "IDENTITY_INACTIVE_COMPANY_ID" : "IDENTITY_UNKNOWN_COMPANY_ID", "IDENTITY_AMBIGUOUS_COMPANY_ID",
          direct.has(token) ? "canonical_company_id" : "reviewed_merge_alias");
        if (failure) return hold(failure);
      }
      for (const [kind, fields, urlValue, index, missing, ambiguous] of [
        ["placeId", ["placeId", "place_id"], url.placeId, placeOwners, "IDENTITY_UNKNOWN_PLACE_ID", "IDENTITY_AMBIGUOUS_PLACE_ID"],
        ["bookingBusinessId", ["bookingBusinessId", "booking_business_id"], url.bookingBusinessId, bookingOwners, "IDENTITY_UNKNOWN_BOOKING_ID", "IDENTITY_AMBIGUOUS_BOOKING_ID"]
      ]) {
        const values = []; for (const field of fields) { const raw = own(row, field); if (absent(raw)) continue; const value = providerId(raw); if (!value) return hold("IDENTITY_INVALID_PROVIDER_ID"); values.push(value); }
        if (urlValue) values.push(urlValue);
        if (new Set(values).size > 1) return hold("IDENTITY_CONFLICTING_PROVIDER_IDS");
        if (values.length) {
          safeIds[kind] = values[0]; const failure = matchOwner(index, values[0], missing, ambiguous, kind === "placeId" ? "unique_place_id" : "unique_booking_business_id");
          if (failure) return hold(failure);
        }
      }
      if (!signals.length) return hold(url.status === "unsupported" ? "IDENTITY_UNSUPPORTED_SOURCE_URL" : "IDENTITY_NO_STRONG_ID");
      if (new Set(signals).size !== 1) return hold("IDENTITY_CONFLICTING_STRONG_IDS");
      const distinct = [...new Set(bases)]; return result("resolved", signals[0], distinct.length === 1 ? distinct[0] : "consistent_strong_ids", null);
    } catch { return hold("IDENTITY_INVALID_INPUT"); }
  }
  return Object.freeze({ resolve, catalogDigest });
}
module.exports = { createMonthlyObservationIdentityResolver, IDENTITY_RESOLVER_VERSION };
