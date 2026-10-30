"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { buildKeywordMonthlyProjection, createKeywordMonthlyAnalysis } = require("./lib/keyword_monthly_analysis.cjs");
const { args, run } = require("./build_keyword_monthly_projection.cjs");
const NOW = "2026-11-20T03:00:00.000Z", keyword = "공개 검증 글램핑";
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
function fixture() {
  const rows = [
    ["r-oct", "2026-10-10", "2026-09-29T01:00:00.000Z"],
    ["r-nov", "2026-11-10", "2026-10-30T01:00:00.000Z"]
  ];
  return { companies: [{ companyId: "a", primaryName: "공개 검증 A", capacity: 10 }],
    runs: rows.map(([id, , collectedAt]) => ({ id, keyword, collectedAt, collectionQuality: { status: "complete" } })),
    observations: rows.map(([runId, stayDate, collectedAt]) => ({ companyId: "a", runId, observationId: runId, keyword, stayDate, collectedAt, rank: 1,
      productType: "lodging", inventoryEvidenceVersion: 4, supply: 10, sold: 2, publicBookings: 2, phoneBookings: 0,
      publicRevenue: 200, phoneRevenue: 0, estimatedRevenue: 200, sharedDayUseExcluded: 0, explicitBlockedBookings: 0,
      phoneMissingPriceBookings: 0, partial: false, missing: false, unknownUnavailable: 0, dayUsePresence: "absent",
      dayUseSharingStatus: "not_shared", capacityBasis: { count: 10, source: "db_correction" } })), rankObservations: [],
    monthlySourceMetadata: Object.fromEntries(["2026-09", "2026-10", "2026-11"].map(month => [month,
      { warnings: [], sourceDiagnostics: { unmatchedObservations: 7 }, globalWarnings: [], globalDiagnostics: {} }])) };
}
async function temporary(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "keyword-publish-months-"));
  t.after(() => { assert.equal(path.dirname(root), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith("keyword-publish-months-")); return fs.rm(root, { recursive: true, force: true }); });
  return root;
}
const cutoffs = { "2026-10": "2026-10-20", "2026-11": "2026-11-20" };

test("explicit preparation window retains older rank evidence and exact current/prior financial snapshots without advertising an unprepared month", async t => {
  const root = await temporary(t), source = fixture(), original = JSON.stringify(source), sourceFingerprint = hash(original);
  const common = { source, sourceFingerprint, dataThrough: NOW, now: () => NOW, sourceProvenance: { observationScope: "normalized_multirun", normalizationCutoffs: cutoffs } };
  await assert.rejects(buildKeywordMonthlyProjection({ ...common, outputDir: path.join(root, "default-rejected") }), error => error.code === "KEYWORD_MONTHLY_NORMALIZATION_CUTOFF_REQUIRED");
  await assert.rejects(fs.stat(path.join(root, "default-rejected")), error => error.code === "ENOENT");
  const baseline = path.join(root, "baseline"), bounded = path.join(root, "bounded");
  await buildKeywordMonthlyProjection({ ...common, sourceProvenance: { observationScope: "normalized_multirun", normalizationCutoffs: { "2026-09": "2026-09-20", ...cutoffs } }, outputDir: baseline });
  const prepared = await buildKeywordMonthlyProjection({ ...common, publishMonths: ["2026-11", "2026-10"], outputDir: bounded });
  const fullIndex = JSON.parse(await fs.readFile(path.join(baseline, "index.json"))), index = JSON.parse(await fs.readFile(path.join(bounded, "index.json")));
  assert.deepEqual(fullIndex.keywords[0].stayMonths, ["2026-09", "2026-10", "2026-11"]);
  assert.deepEqual(prepared.publishMonths, ["2026-10", "2026-11"]);
  assert.equal(prepared.scopeCount, 2);
  for (const key of ["stayMonths", "inventoryStayMonths"]) assert.deepEqual(index.keywords[0][key], ["2026-10", "2026-11"]);
  assert.deepEqual(index.keywords[0].rankMonths, ["2026-10"]);
  assert.deepEqual(index.keywords[0].scopes.map(scope => scope.month), ["2026-10", "2026-11"]);
  assert.deepEqual(index.keywords[0].collectionMonths, fullIndex.keywords[0].collectionMonths);
  const baselineScope = fullIndex.keywords[0].scopes.find(scope => scope.month === "2026-11"), boundedScope = index.keywords[0].scopes.find(scope => scope.month === "2026-11");
  const a = JSON.parse(await fs.readFile(path.join(baseline, "projections", `${baselineScope.scopeKey}.json`)));
  const b = JSON.parse(await fs.readFile(path.join(bounded, "projections", `${boundedScope.scopeKey}.json`)));
  assert.equal(b.sourceFingerprint, sourceFingerprint); assert.equal(b.sourceDigest, a.sourceDigest);
  assert.equal(JSON.stringify(b.source), JSON.stringify(a.source));
  assert.deepEqual(b.source.observations, source.observations); assert.deepEqual(b.source.runs, source.runs);
  const query = { keyword, month: "2026-11", cutoffDate: "2026-11-20" };
  const originalResult = await createKeywordMonthlyAnalysis({ projectionDir: baseline, now: () => NOW }).analyze(query);
  const boundedResult = await createKeywordMonthlyAnalysis({ projectionDir: bounded, now: () => NOW }).analyze(query);
  assert.equal(boundedResult.status, "available"); assert.deepEqual(boundedResult.snapshot, originalResult.snapshot);
  assert.equal(boundedResult.snapshot.summary.lodging.publicRevenue, 200);
  assert.ok(boundedResult.snapshot.comparison);
  assert.equal(JSON.stringify(source), original); assert.equal(hash(JSON.stringify(source)), sourceFingerprint);
});

test("publication months are strict, unique real months and omitted behavior is unchanged", async t => {
  const root = await temporary(t), source = fixture();
  for (const [i, publishMonths] of [[], ["2026-00"], ["2026-13"], ["2026-1"], ["2026-10", "2026-10"], "2026-10", [null]].entries()) {
    await assert.rejects(buildKeywordMonthlyProjection({ source, sourceFingerprint: hash(JSON.stringify(source)), publishMonths, outputDir: path.join(root, `bad-${i}`), now: () => NOW }), error => error.code === "KEYWORD_MONTHLY_INVALID_PUBLISH_MONTHS");
  }
  for (const value of ["2026-10,2026-10", "2026-13,2026-11", "2026-10,", "2026-10, 2026-11"]) assert.throws(() => args(["--source", "x", "--output", "y", "--publish-months", value]), /KEYWORD_MONTHLY_CLI_PUBLISH_MONTHS/);
  assert.deepEqual(args(["--source", "x", "--output", "y", "--publish-months", "2026-10,2026-11"]).publishMonths, ["2026-10", "2026-11"]);
});

test("offline CLI forwards the explicit window while binding and preserving exact source bytes", async t => {
  const root = await temporary(t), source = fixture(), bytes = Buffer.from(JSON.stringify(source));
  const sourceFile = path.join(root, "source.json"), provenanceFile = path.join(root, "provenance.json"), output = path.join(root, "projection");
  await fs.writeFile(sourceFile, bytes, { flag: "wx" });
  await fs.writeFile(provenanceFile, JSON.stringify({ inputSha256: hash(bytes), inputBytes: bytes.length, observationScope: "normalized_multirun", normalizationCutoffs: cutoffs }), { flag: "wx" });
  const result = await run(["--source", sourceFile, "--output", output, "--provenance", provenanceFile, "--now", NOW, "--publish-months", "2026-10,2026-11"]);
  assert.deepEqual(result.publishMonths, ["2026-10", "2026-11"]); assert.equal(result.scopeCount, 2);
  assert.equal(result.sourceFingerprint, hash(bytes)); assert.equal(result.sourceUnchanged, true); assert.equal(result.providerCalls, 0);
  assert.deepEqual(await fs.readFile(sourceFile), bytes);
});
