"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), crypto = require("node:crypto");
const { snapshotCore, snapshotReceiptFields } = require("./reconstruct_keyword_monthly_source_copy.cjs");
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const fingerprint = value => crypto.createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
function snapshot() {
  return { summary: { lodging: { estimatedRevenue: 600, sold: 3 } }, daily: [{ date: "2026-10-01", sold: 3 }],
    companies: [{ companyId: "b", primaryName: "공개 B", summary: { sold: 2, estimatedRevenue: 400 }, daily: [{ date: "2026-10-01", sold: 2 }] },
      { companyId: "a", primaryName: "공개 A", summary: { sold: 1, estimatedRevenue: 200 }, daily: [{ date: "2026-10-01", sold: 1 }] }],
    sources: { digest: "a".repeat(64), partialEvidence: [{ companyId: "a", knownPartialRevenue: 50 }] },
    ranks: { rows: [{ companyId: "a", firstRank: 3, lastRank: 2 }] }, quality: { companyCount: 2, sourceDiagnostics: { unmatched: 1 } } };
}
test("receipt contains exact fingerprints for every core field and no financial values or extra company metadata", () => {
  const core = snapshotCore(snapshot()), before = JSON.stringify(core), result = snapshotReceiptFields(core);
  assert.deepEqual(Object.keys(result.snapshotFieldFingerprints), Object.keys(core));
  for (const [key, value] of Object.entries(core)) assert.equal(result.snapshotFieldFingerprints[key], fingerprint(value));
  assert.deepEqual(result.companyOrderIds, ["b", "a"]);
  assert.equal(result.canonicalCompanyFingerprint, fingerprint([core.companies[1], core.companies[0]]));
  assert.equal(JSON.stringify(core), before);
  assert.deepEqual(Object.keys(result).sort(), ["canonicalCompanyFingerprint", "companyOrderIds", "snapshotFieldFingerprints"]);
});
test("company-only ordering difference changes original/full and field fingerprints while canonical financial proof remains exact", () => {
  const a = snapshotCore(snapshot()), b = structuredClone(a); b.companies.reverse();
  const left = snapshotReceiptFields(a), right = snapshotReceiptFields(b);
  assert.notEqual(fingerprint(a), fingerprint(b));
  assert.notEqual(left.snapshotFieldFingerprints.companies, right.snapshotFieldFingerprints.companies);
  assert.equal(left.canonicalCompanyFingerprint, right.canonicalCompanyFingerprint);
  for (const key of Object.keys(a).filter(key => key !== "companies")) assert.equal(left.snapshotFieldFingerprints[key], right.snapshotFieldFingerprints[key]);
  assert.deepEqual(a.companies.map(company => company.companyId), ["b", "a"]);
});
test("a changed company value or cohort cannot pass the canonical financial proof", () => {
  const original = snapshotCore(snapshot()), proof = snapshotReceiptFields(original);
  for (const change of [core => { core.companies[0].summary.sold++; }, core => { core.companies[0].daily[0].sold++; }, core => { core.companies.pop(); }]) {
    const modified = structuredClone(original); change(modified);
    assert.notEqual(snapshotReceiptFields(modified).canonicalCompanyFingerprint, proof.canonicalCompanyFingerprint);
  }
});
