"use strict";

const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const { calculationFingerprint } = require("./lib/keyword_monthly_prepared_results.cjs");
const { buildMonthlyReportSnapshot } = require("./lib/monthly_reports.cjs");
const { buildMonthlyReportIndustryProjection } = require("./lib/industry_monthly_snapshot.cjs");
const { markSavedMonthlyJsonSource, registerIndustryDiscard, withIndustryEvidenceScope } = require("./lib/monthly_snapshot_owned_inputs.cjs");
const sha = text => crypto.createHash("sha256").update(text).digest("hex");

// Release contract, not a permanent restriction on future public mathematics:
// this release optimizes the private industry path while existing prepared
// keyword results remain served by their exact f4b2c72 public engine. A future
// intentional public-engine change needs its own generation migration and an
// explicitly updated release fixture; changing a stored fingerprint is invalid.
const PUBLIC_F4B = [
  ["keyword_monthly_prepared_results.cjs", "3b3507b26c82203a886f0fbb57c79ef021b4e06f1a7de458eaae5d4573ede865"],
  ["keyword_monthly_analysis.cjs", "92cac57e605750f90cd565bd4674068257943f62c299f28d50f6aa0b9cfca42f"],
  ["monthly_reports.cjs", "5eb21c49a6014092f07566c6199b202105b545c3adb0d750562f27132f1d3319"],
  ["monthly_report_comparison.cjs", "c18e1680ae9444f4c6e399d2eda9c67bb7a8cedf244e3f71650419883dc6c8dc"],
  ["monthly_report_insights.cjs", "a039548c51dc68735c24638c2844c55e4be35adf30c2039a00dbfeda76ab022c"],
  ["saved_product_recovery.cjs", "1749386d62494f5dfd9944c5bc5985e3eccf71d68f926f3cecbca010a586bbbb"],
  ["monthly_report_actions.cjs", "b6376bec0c5141e26594d86d522629399fcae06257159f8ed23eef8aca314bc2"]
];
const EXPECTED = "8cd94ef4b4ebb682265d6147f44b1fe5afc9beaf1fa81bbbd56e01c06b8ee7d2";

test("this release preserves all seven canonical public-engine files and the genuine existing prepared fingerprint", () => {
  const actual = PUBLIC_F4B.map(([name]) => [name, sha(fs.readFileSync(path.join(__dirname, "lib", name), "utf8").replace(/\r\n/g, "\n"))]);
  assert.deepEqual(actual, PUBLIC_F4B);
  assert.equal(sha(JSON.stringify(["keyword-monthly-prepared-result-v1", ...actual])), EXPECTED);
  assert.equal(calculationFingerprint(), EXPECTED, "the actual unchanged reader computes this value; no override or forged stored fingerprint is used");
  assert.equal(require("./lib/monthly_reports.cjs").buildMonthlyReportIndustryProjection, undefined, "the optimization is isolated behind a private industry module");
});

test("private industry projection matches the public full kernel for observed zero, unknown amount, partial evidence and independent metadata", () => {
  const at = "2026-11-01T00:00:00.000Z", request = { type: "company", targetId: "synthetic", month: "2026-10", cutoffDate: "2026-10-31" };
  const basis = { count: 10, source: "synthetic", nested: { value: 1 } }, witnesses = [{ nested: { value: 2 } }];
  const base = { companyId: "synthetic", keyword: "fixture", inventoryEvidenceVersion: 4, productType: "lodging",
    supply: 10, sold: 0, publicBookings: 0, phoneBookings: 0, publicRevenue: 0, phoneRevenue: 0, estimatedRevenue: 0,
    phonePriceEstimates: [], phoneValuation: { nested: { value: 3 } }, sharedDayUseEvidence: { nested: { value: 4 } }, capacityBasis: basis, capacityWitnesses: witnesses };
  const zero = { ...base, runId: "zero", stayDate: "2026-10-15", collectedAt: "2026-10-14T03:00:00.000Z" };
  const unknownPrice = { ...base, runId: "unpriced", stayDate: "2026-10-16", collectedAt: zero.collectedAt,
    sold: 2, publicBookings: 1, phoneBookings: 1, publicRevenue: null, phoneRevenue: null, estimatedRevenue: null };
  const partial = { ...base, runId: "partial", stayDate: "2026-10-17", collectedAt: zero.collectedAt,
    partial: true, sold: 1, publicBookings: 1, phoneBookings: 0, publicRevenue: 80, phoneRevenue: 0, estimatedRevenue: 80 };
  const dayuse = { ...zero, productType: "dayuse", supply: 3, dayUsePresence: "present", dayUseScheduleStatus: "requested" };
  const source = { companies: [{ companyId: "synthetic", primaryName: "Synthetic", capacity: 10 }], regions: [], rankObservations: [],
    observations: [partial, unknownPrice, dayuse, zero], runs: ["zero", "unpriced", "partial"].map(id => ({ id, keyword: "fixture", collectedAt: zero.collectedAt,
      collectionQuality: { status: id === "partial" ? "partial" : "complete" } })) };
  const before = JSON.stringify(source), full = buildMonthlyReportSnapshot(request, source, at);
  markSavedMonthlyJsonSource(source);
  const discard = registerIndustryDiscard(() => {});
  const projected = withIndustryEvidenceScope(source, source, discard, () => buildMonthlyReportIndustryProjection(request, source, at, { onDiscard: discard }));
  const expected = { period: full.period, daily: full.daily.map(({ date }) => ({ date })), sources: {
    observations: full.sources.observations.map(({ phonePriceEstimates, phoneValuation, sharedDayUseEvidence, capacityWitnesses, ...row }) => row),
    partialEvidence: full.sources.partialEvidence, runIds: full.sources.runIds, observationPolicy: full.sources.observationPolicy } };
  assert.equal(JSON.stringify(projected), JSON.stringify(expected));
  const rows = projected.sources.observations;
  assert.equal(rows.find(row => row.productType === "lodging" && row.runId === "zero").sold, 0);
  assert.equal(rows.find(row => row.productType === "lodging" && row.runId === "zero").estimatedRevenue, 0);
  assert.equal(rows.find(row => row.runId === "unpriced").estimatedRevenue, null);
  assert.equal(rows.find(row => row.productType === "dayuse").sold, 0);
  assert.equal(projected.sources.partialEvidence[0].knownPartialRevenue, 80);
  assert.equal(projected.sources.partialEvidence[0].includedInPartialSubtotal, true);
  assert.deepEqual(projected.sources.runIds, ["partial", "unpriced", "zero"]);
  assert.equal(JSON.stringify(source), before);
  for (const row of rows) assert.notStrictEqual(row.capacityBasis, basis);
  assert.notStrictEqual(rows[0].capacityBasis, rows[1].capacityBasis);
  rows[0].capacityBasis.nested.value = 99;
  assert.equal(JSON.stringify(source), before);
  assert.equal(full.sources.observations[0].capacityBasis.nested.value, 1);
});
