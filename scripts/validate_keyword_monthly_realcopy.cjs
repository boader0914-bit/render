"use strict";
// Local evidence only: uses an explicitly supplied normalized public copy.
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const assert = require("node:assert/strict");
const { run: publish } = require("./build_keyword_monthly_projection.cjs");
const { createKeywordMonthlyAnalysis, buildKeywordMonthlyProjection } = require("./lib/keyword_monthly_analysis.cjs");
const { buildMonthlyReportSnapshot } = require("./lib/monthly_reports.cjs");
const NOW = "2026-10-30T00:00:00.000Z", THROUGH = "2026-10-22T10:32:41.525Z";
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const id = row => row.companyId || row.id || row.companyKey;
async function read(file) { const bytes = await fs.readFile(file); return { file, bytes: bytes.length, sha256: hash(bytes), value: JSON.parse(bytes) }; }
async function write(file, value) { await fs.writeFile(file, JSON.stringify(value, null, 2) + "\n", { flag: "wx" }); }
async function tree(dir) {
  const rows = [];
  for (const item of await fs.readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, item.name);
    if (item.isDirectory()) rows.push(...await tree(file));
    else { const stat = await fs.stat(file); rows.push({ file, size: stat.size, mtimeMs: stat.mtimeMs, sha256: hash(await fs.readFile(file)) }); }
  }
  return rows.sort((a, b) => a.file.localeCompare(b.file));
}
function merge(values) {
  const source = { companies: [], runs: [], observations: [], rankObservations: [], savedProductRecoveries: [], sourceDiagnostics: {} };
  for (const key of ["companies", "runs"]) {
    const seen = new Map();
    for (const value of values) for (const row of value[key]) {
      const keyId = key === "companies" ? id(row) : row.id || row.runId;
      if (seen.has(keyId)) assert.deepEqual(seen.get(keyId), row, `Conflicting copied ${key} identity`);
      else { seen.set(keyId, row); source[key].push(row); }
    }
  }
  for (const key of ["observations", "rankObservations", "savedProductRecoveries"]) source[key] = values.flatMap(value => value[key] || []);
  return source;
}
function concise(result) {
  const snapshot = result.snapshot;
  return { status: result.status, request: result.request, diagnostics: result.diagnostics, provenance: result.provenance,
    summary: snapshot?.summary, quality: snapshot ? { status: snapshot.quality.status, companyCount: snapshot.quality.companyCount,
      coverageRate: snapshot.quality.coverageRate } : null,
    comparison: snapshot?.comparison ? { status: snapshot.comparison.status, commonCompanies: snapshot.comparison.common.companyCount,
      matchedDays: snapshot.comparison.common.matched.companyDays, exclusions: snapshot.comparison.common.matched.exclusions,
      deltas: snapshot.comparison.common.matched.deltas } : null, activity: result.activity };
}
async function main(input, output, version = "v3") {
  input = path.resolve(input); output = path.resolve(output);
  assert.ok(!output.startsWith(input + path.sep) && input !== output, "Output must be separate from source");
  await fs.mkdir(output, { recursive: false });
  assert.ok(["v2", "v3"].includes(version));
  const inputs = await Promise.all([`selected-gapyeong-source-${version}.json`, `selected-gyeongnam-source-${version}.json`, "normalized-company-multirun-actual-source.json"].map(file => read(path.join(input, file))));
  const sourceA = merge(inputs.slice(0, 2).map(row => row.value));
  const sourceFile = path.join(output, "selected-combined-source.json"), provenanceFile = path.join(output, "selected-provenance.json");
  await write(sourceFile, sourceA);
  await write(provenanceFile, { observationScope: "selected_only", selectionCutoffs: { "2026-09": "2026-09-22", "2026-10": "2026-10-22" } });
  const projectionA = path.join(output, "projection-selected"), projectionB = path.join(output, "projection-multirun");
  const publications = [];
  publications.push(await publish(["--source", sourceFile, "--provenance", provenanceFile, "--output", projectionA, "--now", NOW, "--data-through", THROUGH]));
  const provenanceB = path.join(output, "multirun-provenance.json");
  await write(provenanceB, { observationScope: "normalized_multirun" });
  publications.push(await publish(["--source", inputs[2].file, "--provenance", provenanceB, "--output", projectionB, "--now", NOW, "--data-through", THROUGH]));
  const before = await tree(projectionA), beforeB = await tree(projectionB);
  const serviceA = createKeywordMonthlyAnalysis({ projectionDir: projectionA, now: () => NOW });
  const serviceB = createKeywordMonthlyAnalysis({ projectionDir: projectionB, now: () => NOW });
  const optionsA = await serviceA.options(), optionsB = await serviceB.options();
  assert.deepEqual(optionsA.keywords.map(row => row.keyword).sort(), ["가평글램핑", "경남글램핑"]);
  const results = [], checks = [];
  for (const keyword of optionsA.keywords) for (const month of ["2026-09", "2026-10"]) {
    const query = { keyword: keyword.keyword, month, cutoffDate: `${month}-22` };
    const result = await serviceA.analyze(query);
    assert.equal(result.status, "available");
    assert.deepEqual(await serviceA.analyze(query), result, "Repeated GET must not accumulate");
    const selected = result.snapshot.sources.observations;
    const keys = selected.map(row => `${row.companyId}|${row.date}|${row.productType}`);
    assert.equal(new Set(keys).size, keys.length, "One canonical company/stay date/product per aggregate");
    const pure = buildMonthlyReportSnapshot({ type: "keyword", targetId: query.keyword, month, cutoffDate: query.cutoffDate }, sourceA, NOW);
    assert.deepEqual(result.snapshot.summary, pure.summary);
    assert.deepEqual(result.snapshot.daily, pure.daily);
    assert.equal(result.snapshot.sources.digest, pure.sources.digest, "Exact selected company/date/product/run/time evidence digest");
    results.push(concise(result));
    checks.push({ test: "exact_pure_engine_and_repeat_get", query, passed: true, selectedUniqueKeys: keys.length });
  }
  const doubled = { ...sourceA, observations: [...sourceA.observations, ...sourceA.observations], rankObservations: [...sourceA.rankObservations, ...sourceA.rankObservations] };
  const duplicatedDir = path.join(output, "projection-duplicate-proof");
  await buildKeywordMonthlyProjection({ source: doubled, sourceFingerprint: hash(JSON.stringify(doubled)), outputDir: duplicatedDir,
    sourceProvenance: { observationScope: "selected_only", selectionCutoffs: { "2026-09": "2026-09-22", "2026-10": "2026-10-22" } }, materializedAt: NOW, dataThrough: THROUGH, now: () => NOW });
  const duplicateService = createKeywordMonthlyAnalysis({ projectionDir: duplicatedDir, now: () => NOW });
  for (const original of results) {
    const duplicate = await duplicateService.analyze(original.request);
    assert.deepEqual(duplicate.snapshot.summary, original.summary, "Duplicated copied observations cannot inflate totals");
    const first = await serviceA.analyze(original.request);
    assert.deepEqual(duplicate.snapshot.daily, first.snapshot.daily);
    assert.equal(duplicate.snapshot.sources.digest, first.snapshot.sources.digest);
    for (const product of ["lodging", "dayuse"]) {
      const beforeComparison = first.snapshot.comparisonByProduct[product], afterComparison = duplicate.snapshot.comparisonByProduct[product];
      if (!beforeComparison) assert.equal(afterComparison, null);
      else for (const key of ["status", "all", "common", "newlyObservedCompanyIds", "noLongerObservedCompanyIds"]) {
        assert.deepEqual(afterComparison[key], beforeComparison[key], `Stable ${product} comparison ${key}; duplicate diagnostics may increase`);
      }
    }
  }
  checks.push({ test: "actual_copy_observations_and_rank_rows_doubled_totals_daily_comparison_unchanged", passed: true });
  for (const query of [{ keyword: "경남글램핑", month: "2026-11" }, { keyword: "경남", month: "2026-10" }, { keyword: "경남글램핑", month: "2026-10", cutoffDate: "2026-10-15" }]) {
    const result = await serviceA.analyze(query); assert.equal(result.status, "missing"); assert.equal(result.snapshot, null);
    checks.push({ test: "missing_or_unreconstructible_not_zero", query, diagnostics: result.diagnostics, passed: true });
  }
  const multirun = [];
  for (const keyword of optionsB.keywords) for (const month of keyword.stayMonths) {
    const query = { keyword: keyword.keyword, month, cutoffDate: month === "2026-09" ? "2026-09-22" : "2026-10-22" };
    const result = await serviceB.analyze(query); assert.equal(result.status, "available");
    assert.equal(result.activity.runInventoryComplete, false);
    assert.equal(result.provenance.intermediateObservationsComplete, false);
    const earlyQuery = { ...query, cutoffDate: month === "2026-09" ? "2026-09-20" : "2026-10-01" };
    const earliest = await serviceB.analyze(earlyQuery);
    assert.equal(earliest.status, "available");
    assert.deepEqual(earliest.request, earlyQuery);
    const pureEarly = buildMonthlyReportSnapshot({ type: "keyword", targetId: query.keyword, month, cutoffDate: earlyQuery.cutoffDate }, inputs[2].value, NOW);
    assert.deepEqual(earliest.snapshot.summary, pureEarly.summary);
    assert.deepEqual(earliest.snapshot.daily, pureEarly.daily);
    assert.equal(earliest.snapshot.sources.digest, pureEarly.sources.digest);
    const identity = rows => rows.map(row => [row.companyId, row.date, row.productType, row.runId, row.collectedAt, row.supply, row.sold, row.estimatedRevenue]);
    assert.deepEqual(identity(earliest.snapshot.sources.observations), identity(pureEarly.sources.observations));
    const a = earliest.snapshot.sources.observations, b = result.snapshot.sources.observations;
    for (const row of a) assert.ok(new Date(Date.parse(row.collectedAt) + 9 * 3600000).toISOString().slice(0, 10) <= earlyQuery.cutoffDate);
    assert.equal(new Set(b.map(row => `${row.companyId}|${row.date}|${row.productType}`)).size, b.length);
    multirun.push({ ...concise(result), earlySelectedCount: a.length, latestSelectedCount: b.length,
      selectedEvidenceChanged: hash(JSON.stringify(a)) !== hash(JSON.stringify(b)) });
  }
  assert.ok(multirun.some(row => row.selectedEvidenceChanged), "Actual copied multirun cutoff must change saved observations");
  checks.push({ test: "actual_multirun_intermediate_cutoff_and_unique_key_accumulation", passed: true, scope: "one_canonical_company_three_exact_keywords" });
  const stale = createKeywordMonthlyAnalysis({ projectionDir: projectionA, now: () => "2026-11-01T00:00:00.000Z" });
  assert.equal((await stale.options()).status, "stale");
  assert.equal((await stale.analyze({ keyword: "경남글램핑", month: "2026-10", cutoffDate: "2026-10-22" })).status, "stale");
  checks.push({ test: "stale_projection_not_current_success", passed: true });
  assert.deepEqual(await tree(projectionA), before); assert.deepEqual(await tree(projectionB), beforeB);
  for (const inputRead of inputs) assert.equal(hash(await fs.readFile(inputRead.file)), inputRead.sha256);
  const receipt = { schemaVersion: 1, status: "passed", observedAt: new Date().toISOString(), validationClock: NOW, copiedDataThrough: THROUGH,
    productionAccess: 0, providerCalls: 0, kosisReadOrChanged: false, sourceAndProjectionsUnchanged: true,
    inputs: inputs.map(({ value, ...row }) => row), publications, checks, options: { selected: optionsA, multirun: optionsB }, selectedResults: results, multirunResults: multirun,
    limits: ["Selected copy reproduces declared cutoffs only, not full intermediate history or complete failed-run inventory.", "Multirun source covers one actual canonical company, not three full keyword markets.", "Historical copy through October 22 is not current production or whole-month completion.", "Missing source identities were excluded rather than guessed."] };
  await write(path.join(output, "realcopy-validation.json"), receipt);
  console.log(JSON.stringify({ status: receipt.status, output, checks: checks.length, selectedScopes: results.length, multirunScopes: multirun.length, projectionA, projectionB }));
}
if (require.main === module) main(process.argv[2], process.argv[3], process.argv[4]).catch(error => { console.error(JSON.stringify({ code: error.code || "VALIDATION_FAILED", message: String(error.message).slice(0, 1000), location: error.stack?.split("\n").find(row => row.includes("validate_keyword_monthly_realcopy.cjs")) })); process.exitCode = 1; });
module.exports = { main };
