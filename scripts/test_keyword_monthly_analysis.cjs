"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { buildKeywordMonthlyProjection, createKeywordMonthlyAnalysis, sourceForKeywordMonthlyRequest } = require("./lib/keyword_monthly_analysis.cjs");
const { buildMonthlyReportSnapshot } = require("./lib/monthly_reports.cjs");
const { buildMonthlyComparison, previousMonthlyReportRequest } = require("./lib/monthly_report_comparison.cjs");
const { recoveryRowDigest } = require("./lib/saved_product_recovery.cjs");
const NOW = "2026-10-30T03:00:00.000Z";
const KEYWORD = "가평글램핑";
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const row = (runId, stayDate, collectedAt, more = {}) => ({ observationId: `${runId}:${stayDate}`, companyId: "a", runId, keyword: KEYWORD,
  productType: "lodging", stayDate, collectedAt, inventoryEvidenceVersion: 4, supply: 10, sold: 2, publicBookings: 2, phoneBookings: 0,
  publicRevenue: 200, phoneRevenue: 0, estimatedRevenue: 200, sharedDayUseExcluded: 0, explicitBlockedBookings: 0,
  phoneMissingPriceBookings: 0, partial: false, missing: false, unknownUnavailable: 0,
  dayUsePresence: "absent", dayUseSharingStatus: "not_shared", capacityBasis: { count: 10, source: "db_correction" }, ...more });
function sourceFixture() {
  const times = { old: "2026-09-10T01:00:00.000Z", newest: "2026-09-10T02:00:00.000Z", invalid: "2026-09-10T03:00:00.000Z",
    post: "2026-09-12T01:00:00.000Z", cutoff: "2026-09-20T01:00:00.000Z", previous: "2026-08-10T02:00:00.000Z",
    partial: "2026-09-11T01:00:00.000Z", failed: "2026-10-29T01:00:00.000Z", ranks: "2026-09-10T01:00:00.000Z" };
  const runs = Object.entries(times).map(([id, collectedAt]) => ({ id, keyword: KEYWORD, collectedAt,
    collectionQuality: { status: id === "failed" ? "failed" : id === "partial" ? "partial" : "complete" }, ...(id === "failed" ? { errorCode: "PROVIDER_BLOCKED" } : {}) }));
  return { companies: [{ companyId: "a", primaryName: "A", capacity: 10, capacitySource: "db_correction" }, { companyId: "rank-only", primaryName: "Rank Only" }], runs,
    observations: [row("old", "2026-09-10", times.old), row("newest", "2026-09-10", times.newest, { sold: 4, publicBookings: 4, publicRevenue: 400, estimatedRevenue: 400 }),
      row("newest", "2026-09-10", times.newest, { sold: 4, publicBookings: 4, publicRevenue: 400, estimatedRevenue: 400 }),
      row("invalid", "2026-09-10", times.invalid, { missing: true, sold: 99 }), row("post", "2026-09-10", times.post, { sold: 8, publicBookings: 8 }),
      row("cutoff", "2026-09-22", times.cutoff), row("previous", "2026-08-10", times.previous),
      row("partial", "2026-09-11", times.partial, { partial: true, explicitBlockedRevenue: 0 }),
      row("failed", "2026-09-10", times.failed, { missing: true })],
    rankObservations: [{ companyId: "rank-only", runId: "ranks", keyword: KEYWORD, rank: 5, collectedAt: times.ranks }], warnings: [], sourceDiagnostics: {} };
}
async function setup(t, source = sourceFixture(), extra = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "keyword-monthly-"));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("keyword-monthly-"));
    return fs.rm(root, { recursive: true, force: true });
  });
  const outputDir = path.join(root, "projection");
  const sourceFingerprint = hash(JSON.stringify(source));
  const published = await buildKeywordMonthlyProjection({ source, sourceFingerprint, outputDir, now: () => NOW, ...extra });
  return { root, outputDir, published, source, service: createKeywordMonthlyAnalysis({ projectionDir: outputDir, now: () => NOW }) };
}
async function tree(directory) {
  const out = [];
  for (const item of await fs.readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, item.name);
    if (item.isDirectory()) out.push(...await tree(file));
    else { const stat = await fs.stat(file); out.push({ file, sha256: hash(await fs.readFile(file)), size: stat.size, mtime: stat.mtimeMs, ctime: stat.ctimeMs, ino: stat.ino }); }
  }
  return out;
}
async function rewriteIndex(outputDir, edit) {
  const file = path.join(outputDir, "index.json"), value = JSON.parse(await fs.readFile(file, "utf8"));
  await edit(value); await fs.writeFile(file, JSON.stringify(value));
}

test("offline projection preserves existing monthly pure selection, missing coverage and paired comparison exactly", async t => {
  const { service, source } = await setup(t);
  const query = { keyword: KEYWORD, month: "2026-09", cutoffDate: "2026-09-15" };
  const actual = await service.analyze(query);
  assert.equal(actual.status, "available");
  const request = { type: "keyword", targetId: KEYWORD, month: query.month, cutoffDate: query.cutoffDate };
  const expected = buildMonthlyReportSnapshot(request, source, NOW);
  expected.comparison = buildMonthlyComparison(expected, buildMonthlyReportSnapshot(previousMonthlyReportRequest(request), source, NOW), { productType: "lodging" });
  expected.comparisonByProduct = { lodging: expected.comparison, dayuse: null };
  assert.deepEqual(actual.snapshot, expected);
  assert.equal(actual.snapshot.summary.lodging.sold, 4);
  assert.equal(actual.snapshot.sources.observations.length, 1);
  assert.equal(actual.snapshot.quality.knownPartialCompanyDays, 1);
  assert.equal(actual.snapshot.summary.dayuse.sold, null);
  assert.equal(actual.snapshot.comparison.common.matched.deltas.sold, 2);
  assert.equal(actual.snapshot.quality.companyCount, 2);
  assert.equal(actual.snapshot.sources.targetMembership.rankOnlyCompanyIds[0], "rank-only");
  assert.equal(actual.latestAttempt.status, "failed");
  assert.equal(actual.latestAttempt.errorCode, "PROVIDER_BLOCKED");
  assert.equal(actual.lastSuccessfulAttempt.status, "complete");
  assert.ok(actual.diagnostics.includes("LATEST_ATTEMPT_FAILED_LAST_VALID_RETAINED"));
});

test("options show actual stay/rank month and exact-keyword collection-month counts, not historical registration", async t => {
  const source = sourceFixture();
  source.companies[0].keywords = { "전주글램핑": true };
  source.runs.push({ id: "other", keyword: "가평", collectedAt: "2026-10-29T02:00:00Z", collectionQuality: "complete" });
  const { service } = await setup(t, source);
  const options = await service.options();
  assert.equal(options.currentDay, "2026-10-30");
  assert.equal(options.currentMonth, "2026-10");
  assert.deepEqual(options.keywords.map(item => item.keyword), [KEYWORD]);
  assert.deepEqual(options.keywords[0].stayMonths, ["2026-08", "2026-09"]);
  assert.deepEqual(options.keywords[0].collectionMonths, ["2026-08", "2026-09", "2026-10"]);
  const result = await service.analyze({ keyword: KEYWORD, month: "2026-09" });
  assert.equal(result.activity.rows.find(row => row.month === "2026-10").failedRunCount, 1);
  assert.equal(result.activity.rows.reduce((n, row) => n + row.runCount, 0), 9);
  assert.equal(result.provenance.originalFreshnessVerified, false);
  assert.equal(result.snapshot.context, null);
});

test("unobserved keyword/month and missing projection remain missing with null snapshot and no fabricated zero", async t => {
  const { root, service } = await setup(t);
  for (const query of [{ keyword: "가평", month: "2026-09" }, { keyword: KEYWORD, month: "2027-01" }]) {
    const result = await service.analyze(query); assert.equal(result.status, "missing"); assert.equal(result.snapshot, null);
  }
  const absent = createKeywordMonthlyAnalysis({ projectionDir: path.join(root, "absent"), now: () => NOW });
  assert.equal((await absent.options()).status, "missing");
  assert.equal((await absent.analyze({ keyword: KEYWORD, month: "2026-09" })).snapshot, null);
  assert.deepEqual(await fs.readdir(root), ["projection"]);
});

test("runtime options/analyze are stable reads: no writes, utimes, raw history scan, queue, context or provider calls", async t => {
  const { outputDir, service } = await setup(t);
  const before = await tree(outputDir);
  const mutations = ["writeFile", "appendFile", "mkdir", "utimes", "rename", "unlink", "rm"];
  const originals = Object.fromEntries(mutations.map(key => [key, fs[key]]));
  const oldRead = fs.readFile;
  try {
    for (const key of mutations) fs[key] = async () => { throw new Error(`forbidden ${key}`); };
    fs.readFile = async () => { throw new Error("runtime must not raw-scan readFile"); };
    for (let i = 0; i < 2; i++) {
      assert.equal((await service.options()).status, "available");
      assert.equal((await service.analyze({ keyword: KEYWORD, month: "2026-09" })).status, "available");
    }
  } finally { Object.assign(fs, originals); fs.readFile = oldRead; }
  assert.deepEqual(await tree(outputDir), before);
});

test("stale projections are explicitly stale while retaining last valid snapshot separately", async t => {
  const { outputDir } = await setup(t);
  const service = createKeywordMonthlyAnalysis({ projectionDir: outputDir, now: () => "2026-11-01T03:00:00Z" });
  assert.equal((await service.options()).status, "stale");
  const result = await service.analyze({ keyword: KEYWORD, month: "2026-09" });
  assert.equal(result.status, "stale"); assert.ok(result.snapshot); assert.ok(result.diagnostics.includes("PROJECTION_EXPIRED"));
});

test("invalid selection including future cutoff rejects before reading projection", async t => {
  const { root } = await setup(t);
  const service = createKeywordMonthlyAnalysis({ projectionDir: path.join(root, "none"), now: () => NOW });
  for (const query of [{ keyword: KEYWORD, month: "2026-13" }, { keyword: " 가평", month: "2026-09" },
    { keyword: KEYWORD, month: "2026-09", cutoffDate: "2026-02-30" }, { keyword: KEYWORD, month: "2026-09", cutoffDate: "2026-10-31" },
    { keyword: KEYWORD, month: "2026-09", rebuild: true }]) await assert.rejects(service.analyze(query), error => error.statusCode === 400);
});

test("tampered scope/hash/schema is a verification error, never missing, success or zero", async t => {
  const { outputDir, service } = await setup(t);
  await rewriteIndex(outputDir, value => { value.keywords[0].scopes[0].scopeKey = "../escape"; });
  assert.equal((await service.options()).status, "needs_verification");
  const result = await service.analyze({ keyword: KEYWORD, month: "2026-09" });
  assert.equal(result.status, "needs_verification"); assert.equal(result.snapshot, null);
});

test("missing selected file differs from valid missing scope: pointer loss is verification failure", async t => {
  const { outputDir, service } = await setup(t);
  const index = JSON.parse(await fs.readFile(path.join(outputDir, "index.json"), "utf8"));
  const scope = index.keywords[0].scopes.find(scope => scope.month === "2026-09");
  await fs.unlink(path.join(outputDir, "projections", `${scope.scopeKey}.json`));
  const result = await service.analyze({ keyword: KEYWORD, month: "2026-09" });
  assert.equal(result.status, "needs_verification");
});

test("index hardlink and symlink parents are rejected without following target", async t => {
  const { outputDir, root } = await setup(t);
  await fs.link(path.join(outputDir, "index.json"), path.join(root, "index-link.json"));
  const result = await createKeywordMonthlyAnalysis({ projectionDir: outputDir, now: () => NOW }).options();
  assert.equal(result.status, "needs_verification");
  await fs.unlink(path.join(root, "index-link.json"));
  const linked = path.join(root, "linked");
  await fs.symlink(outputDir, linked, process.platform === "win32" ? "junction" : "dir");
  assert.equal((await createKeywordMonthlyAnalysis({ projectionDir: linked, now: () => NOW }).options()).status, "needs_verification");
});

test("explicit builder refuses existing target, forged provenance, duplicate run IDs and recovery certificates", async t => {
  const { outputDir, source, root } = await setup(t);
  await assert.rejects(buildKeywordMonthlyProjection({ source, sourceFingerprint: hash(JSON.stringify(source)), outputDir, now: () => NOW }), error => error.code === "EEXIST");
  await assert.rejects(buildKeywordMonthlyProjection({ source, sourceFingerprint: "a".repeat(64), sourceProvenance: { inputSha256: "b".repeat(64) }, outputDir: path.join(root, "bad1"), now: () => NOW }));
  const duplicate = structuredClone(source); duplicate.runs.push(duplicate.runs[0]);
  await assert.rejects(buildKeywordMonthlyProjection({ source: duplicate, sourceFingerprint: "a".repeat(64), outputDir: path.join(root, "bad2"), now: () => NOW }));
  await assert.rejects(buildKeywordMonthlyProjection({ source: { ...source, savedProductRecoveries: [{}] }, sourceFingerprint: "a".repeat(64), outputDir: path.join(root, "bad3"), now: () => NOW }));
  assert.deepEqual(await fs.readdir(root), ["projection"]);
});

test("late projection mutation is detected by pointer recheck", async t => {
  const { outputDir, service } = await setup(t);
  const original = fs.open; let calls = 0;
  fs.open = async (...args) => {
    calls += 1;
    if (calls === 3) await rewriteIndex(outputDir, value => { value.provenance.inputBytes = 999; });
    return original(...args);
  };
  try {
    const result = await service.analyze({ keyword: KEYWORD, month: "2026-09" });
    assert.equal(result.status, "needs_verification"); assert.ok(result.diagnostics.includes("KEYWORD_MONTHLY_EVIDENCE_CHANGED"));
  } finally { fs.open = original; }
});

test("actual saved recovery certificates are preserved without quality promotion; forged row digest is rejected", async t => {
  const source = sourceFixture(), collectedAt = "2026-09-10T04:00:00.000Z";
  source.runs.push({ id: "recovered", keyword: KEYWORD, collectedAt, collectionQuality: { status: "unknown" } });
  const recovered = row("recovered", "2026-09-10", collectedAt, { sold: 5, publicBookings: 5, publicRevenue: 500, estimatedRevenue: 500, savedNormalization: "preserve-exact-row" });
  const certificate = { kind: "saved_product_recovery_v1", originalRunQuality: "unknown", companyId: "a", runId: "recovered", date: "2026-09-10", productType: "lodging", collectedAt,
    sourceDigest: "a".repeat(64), rowDigest: recoveryRowDigest(recovered), receiptId: "b".repeat(64) };
  source.savedProductRecoveries = [{ row: recovered, certificate }];
  const { service, root } = await setup(t, source);
  const result = await service.analyze({ keyword: KEYWORD, month: "2026-09" });
  assert.equal(result.status, "available"); assert.equal(result.snapshot.summary.lodging.sold, 7);
  const selected = result.snapshot.sources.observations.find(row => row.runId === "recovered");
  assert.equal(selected.runQuality, "unknown"); assert.equal(selected.sourceRecovery.rowDigest, certificate.rowDigest);
  assert.equal(result.snapshot.quality.recoveredCompanyDays, 1);
  source.savedProductRecoveries[0].row.sold = 9;
  await assert.rejects(buildKeywordMonthlyProjection({ source, sourceFingerprint: "a".repeat(64), outputDir: path.join(root, "forged"), now: () => NOW }), error => error.code === "KEYWORD_MONTHLY_INVALID_RECOVERY");
});

test("latest failed attempt without collectedAt remains visible and last success is the actual selected observation", async t => {
  const source = sourceFixture();
  source.runs.push({ id: "latest-failed", keyword: KEYWORD, finishedAt: "2026-10-30T02:00:00.000Z", collectionQuality: "failed", errorCode: "RATE_LIMITED" });
  const { service } = await setup(t, source);
  const result = await service.analyze({ keyword: KEYWORD, month: "2026-09", cutoffDate: "2026-09-15" });
  assert.equal(result.latestAttempt.status, "failed"); assert.equal(result.latestAttempt.observedAt, "2026-10-30T02:00:00.000Z");
  assert.equal(result.lastSuccessfulAttempt.observedAt, "2026-09-10T02:00:00.000Z");
  assert.equal(result.activity.unknownTimeRunCount, 1);
});

test("index metadata uses a strict allowlist and reconciles activity count totals", async t => {
  const mutations = [value => { value.provenance.internalNote = "private"; }, value => { value.keywords[0].latestAttempt.debug = "private"; },
    value => { value.keywords[0].activity.rows[0].runCount = 999; }, value => { value.keywords[0].inventoryStayMonths = ["../x"]; }];
  for (const mutation of mutations) {
    const { outputDir, service } = await setup(t);
    await rewriteIndex(outputDir, mutation);
    assert.equal((await service.options()).status, "needs_verification");
    assert.equal((await service.analyze({ keyword: KEYWORD, month: "2026-09" })).snapshot, null);
  }
});

test("nested evidence is safely projected; source copies containing secret/contact/raw fields are rejected", async t => {
  const source = sourceFixture();
  source.observations[1].phoneValuation = { policy: "same_product", quantityPolicy: "observed", internalMemo: "do-not-output" };
  source.observations[1].capacityWitnesses = [{ productKey: "p1", count: 10, source: "observed", internalMemo: "do-not-output" }];
  const { service, root } = await setup(t, source);
  const result = await service.analyze({ keyword: KEYWORD, month: "2026-09" });
  assert.doesNotMatch(JSON.stringify(result), /do-not-output|internalMemo/);
  source.observations[1].phoneValuation.privateToken = "should-never-persist";
  await assert.rejects(buildKeywordMonthlyProjection({ source, sourceFingerprint: "a".repeat(64), outputDir: path.join(root, "unsafe"), now: () => NOW }), error => error.code === "KEYWORD_MONTHLY_UNSAFE_SOURCE_FIELDS");
});

test("equal-time deterministic source tie remains identical to the shared engine", async t => {
  const source = sourceFixture();
  source.observations.push(row("newest", "2026-09-10", "2026-09-10T02:00:00.000Z", { sold: 6, publicBookings: 6, publicRevenue: 600, estimatedRevenue: 600, normalizedEvidenceMarker: "retained-in-input-hash" }));
  const { service } = await setup(t, source);
  const request = { type: "keyword", targetId: KEYWORD, month: "2026-09", cutoffDate: "2026-09-15" };
  const expected = buildMonthlyReportSnapshot(request, source, NOW);
  const result = await service.analyze({ keyword: KEYWORD, month: "2026-09", cutoffDate: "2026-09-15" });
  assert.equal(result.snapshot.summary.lodging.sold, expected.summary.lodging.sold);
  assert.equal(result.snapshot.sources.digest, expected.sources.digest);
});

test("dayuse comparison is product-specific with positive/zero/missing and preserves default lodging output", async t => {
  const source = sourceFixture();
  source.observations.push(row("newest", "2026-09-10", "2026-09-10T02:00:00.000Z", { productType: "dayuse", dayUsePresence: "present", dayUseScheduleStatus: "requested", sold: 3, publicBookings: 3, publicRevenue: 300, estimatedRevenue: 300 }));
  source.observations.push(row("previous", "2026-08-10", "2026-08-10T02:00:00.000Z", { productType: "dayuse", dayUsePresence: "present", dayUseScheduleStatus: "requested", sold: 0, publicBookings: 0, publicRevenue: 0, estimatedRevenue: 0 }));
  const { service } = await setup(t, source);
  const result = await service.analyze({ keyword: KEYWORD, month: "2026-09" });
  assert.equal(result.snapshot.comparisonByProduct.dayuse.productType, "dayuse");
  assert.equal(result.snapshot.comparisonByProduct.dayuse.common.matched.deltas.sold, 3);
  assert.equal(result.snapshot.comparisonByProduct.dayuse.common.matched.deltas.estimatedRevenue, 300);
  assert.equal(result.snapshot.comparisonByProduct.dayuse.common.matched.deltas.estimatedRevenueRate, null);
  assert.equal(result.snapshot.comparisonByProduct.lodging.common.matched.deltas.sold, 2);
  const current = buildMonthlyReportSnapshot({ type: "keyword", targetId: KEYWORD, month: "2026-09", cutoffDate: "2026-09-30" }, source, NOW);
  const previous = buildMonthlyReportSnapshot({ type: "keyword", targetId: KEYWORD, month: "2026-08", cutoffDate: "2026-08-31" }, source, NOW);
  const legacy = buildMonthlyComparison(current, previous), explicit = buildMonthlyComparison(current, previous, { productType: "lodging" });
  assert.equal(Object.hasOwn(legacy, "productType"), false);
  delete explicit.productType; assert.deepEqual(legacy, explicit);
  const missing = await service.analyze({ keyword: KEYWORD, month: "2026-08" });
  assert.equal(missing.snapshot.comparisonByProduct.dayuse, null);
});

test("provided selected-run counts explicitly disclaim whole-month completeness unless independently flagged", async t => {
  const { service } = await setup(t, sourceFixture(), { sourceProvenance: { observationScope: "selected_only", selectionCutoffs: { "2026-08": "2026-08-31", "2026-09": "2026-09-30" } } });
  const value = await service.analyze({ keyword: KEYWORD, month: "2026-09" });
  assert.equal(value.activity.coverageBasis, "provided_unique_run_set");
  assert.equal(value.activity.counterScope, "provided_runs_only"); assert.equal(value.activity.runInventoryComplete, false);
  assert.equal(value.provenance.observationScope, "selected_only"); assert.equal(value.provenance.intermediateObservationsComplete, false);
  const source = sourceFixture(); source.sourceDiagnostics = { runInventoryComplete: 1, intermediateObservationsComplete: 1 };
  const prepared = await setup(t, source);
  const full = await prepared.service.analyze({ keyword: KEYWORD, month: "2026-09" });
  assert.equal(full.activity.runInventoryComplete, true); assert.equal(full.provenance.intermediateObservationsComplete, true);
  assert.equal(Object.hasOwn(full.snapshot.quality.sourceDiagnostics, "runInventoryComplete"), false);
});

test("a cutoff after the last copied data is explicitly stale, even when just materialized", async t => {
  const source = sourceFixture(); source.runs = source.runs.filter(run => run.id !== "failed"); source.observations = source.observations.filter(row => row.runId !== "failed");
  const { service } = await setup(t, source);
  const result = await service.analyze({ keyword: KEYWORD, month: "2026-09", cutoffDate: "2026-09-30" });
  assert.equal(result.status, "stale"); assert.ok(result.diagnostics.includes("CUTOFF_AFTER_DATA_THROUGH"));
  assert.ok(result.snapshot); assert.equal(result.provenance.materializedAt, NOW);
});

test("malformed nested evidence arrays or strings cannot bypass the safe response projection", async t => {
  const source = sourceFixture();
  for (const entry of source.observations.filter(row => row.runId === "newest")) Object.assign(entry, {
    phoneValuation: [{ payload: "/var/data/internal" }], capacityBasis: "/var/data/internal", sharedDayUseEvidence: [{ payload: "internal-only" }] });
  const { service } = await setup(t, source);
  const result = await service.analyze({ keyword: KEYWORD, month: "2026-09" });
  assert.equal(result.status, "available"); assert.doesNotMatch(JSON.stringify(result), /var\/data|internal-only/);
  const selected = result.snapshot.sources.observations.find(row => row.runId === "newest");
  assert.equal(selected.phoneValuation, null); assert.equal(selected.capacityBasis, null); assert.equal(selected.sharedDayUseEvidence, null);
});

test("default cutoff stops at copied data-through for multirun sources, so fresh copies remain usable", async t => {
  const source = { companies: [{ companyId: "a", primaryName: "A" }],
    runs: [{ id: "current", keyword: KEYWORD, collectedAt: "2026-10-10T01:00:00Z", collectionQuality: "complete" }],
    observations: [row("current", "2026-10-20", "2026-10-10T01:00:00Z")], rankObservations: [] };
  const { service } = await setup(t, source, { sourceProvenance: { observationScope: "normalized_multirun" } });
  const options = await service.options();
  assert.equal(options.keywords[0].defaultCutoffs["2026-10"], "2026-10-10");
  assert.equal(options.keywords[0].supportedCutoffs, null);
  const result = await service.analyze({ keyword: KEYWORD, month: "2026-10" });
  assert.equal(result.status, "available"); assert.equal(result.request.cutoffDate, "2026-10-10");
  assert.equal(result.snapshot.summary.lodging.sold, 2);
  const beyond = await service.analyze({ keyword: KEYWORD, month: "2026-10", cutoffDate: "2026-10-22" });
  assert.equal(beyond.status, "stale"); assert.ok(beyond.diagnostics.includes("CUTOFF_AFTER_DATA_THROUGH"));
});

test("selected-only copies replay only declared cutoff per month, including reference beyond last observation", async t => {
  const source = { companies: [{ companyId: "a", primaryName: "A" }], runs: [
    { id: "current", keyword: KEYWORD, collectedAt: "2026-10-10T01:00:00Z", collectionQuality: "complete" },
    { id: "prior", keyword: KEYWORD, collectedAt: "2026-09-10T01:00:00Z", collectionQuality: "complete" }],
  observations: [row("current", "2026-10-20", "2026-10-10T01:00:00Z"), row("prior", "2026-09-20", "2026-09-10T01:00:00Z")], rankObservations: [] };
  const selectionCutoffs = { "2026-09": "2026-09-22", "2026-10": "2026-10-22" };
  const { service, root } = await setup(t, source, { sourceProvenance: { observationScope: "selected_only", selectionCutoffs } });
  const options = await service.options(); assert.deepEqual(options.keywords[0].defaultCutoffs, selectionCutoffs);
  assert.deepEqual(options.keywords[0].supportedCutoffs, selectionCutoffs);
  const result = await service.analyze({ keyword: KEYWORD, month: "2026-10" });
  assert.equal(result.status, "available"); assert.equal(result.request.cutoffDate, "2026-10-22");
  assert.equal(result.snapshot.comparisonByProduct.lodging.previousCutoffDate, "2026-09-22");
  for (const cutoffDate of ["2026-10-10", "2026-10-21", "2026-10-23"]) {
    const unsupported = await service.analyze({ keyword: KEYWORD, month: "2026-10", cutoffDate });
    assert.equal(unsupported.status, "missing"); assert.equal(unsupported.snapshot, null); assert.equal(unsupported.supportedCutoffDate, "2026-10-22");
    assert.deepEqual(unsupported.diagnostics, ["CUTOFF_NOT_RECONSTRUCTIBLE"]);
  }
  const badSource = { observationScope: "selected_only", selectionCutoffs: { "2026-09": "2026-09-30", "2026-10": "2026-10-22" } };
  const other = await setup(t, source, { sourceProvenance: badSource });
  const unsupportedComparison = await other.service.analyze({ keyword: KEYWORD, month: "2026-10" });
  assert.equal(unsupportedComparison.snapshot.comparison, null); assert.ok(unsupportedComparison.diagnostics.includes("PREVIOUS_CUTOFF_NOT_RECONSTRUCTIBLE"));
  await assert.rejects(buildKeywordMonthlyProjection({ source, sourceFingerprint: "a".repeat(64), sourceProvenance: { observationScope: "selected_only", selectionCutoffs: { "2026-10": "2026-10-22" } }, outputDir: path.join(root, "no-prior-reference"), now: () => NOW }), error => error.code === "KEYWORD_MONTHLY_SELECTION_CUTOFF_REQUIRED");
});

function monthMetadata(warning, count, globalCount) {
  return { warnings: [warning], sourceDiagnostics: { unmatchedCompanyRows: count }, globalWarnings: [`전체 참고 ${warning}`], globalDiagnostics: { malformedHistoryLines: globalCount } };
}
function monthlyMetadataFixture() {
  const source = JSON.parse(JSON.stringify(sourceFixture()).replace(/2026-09/g, "2026-10").replace(/2026-08/g, "2026-09"));
  source.monthlySourceMetadata = { "2026-09": monthMetadata("9월 범위 경고", 516, 3), "2026-10": monthMetadata("10월 범위 경고", 980, 4),
    "2026-11": monthMetadata("범위 밖 경고", 999, 5) };
  return source;
}

test("monthly metadata keeps current and previous diagnostics/warnings separate without changing quantities or source rows", async t => {
  const source = monthlyMetadataFixture(), before = JSON.stringify(source);
  const { service, outputDir } = await setup(t, source);
  const request = { type: "keyword", targetId: KEYWORD, month: "2026-10", cutoffDate: "2026-10-15" };
  const current = sourceForKeywordMonthlyRequest(source, request), priorRequest = previousMonthlyReportRequest(request), prior = sourceForKeywordMonthlyRequest(source, priorRequest);
  assert.strictEqual(current.observations, source.observations); assert.strictEqual(prior.observations, source.observations);
  assert.strictEqual(current.runs, source.runs); assert.strictEqual(prior.runs, source.runs);
  assert.equal(current.sourceDiagnostics.unmatchedCompanyRows, 980); assert.equal(prior.sourceDiagnostics.unmatchedCompanyRows, 516);
  const result = await service.analyze({ keyword: KEYWORD, month: request.month, cutoffDate: request.cutoffDate });
  assert.equal(result.status, "available");
  assert.equal(result.snapshot.quality.sourceDiagnostics.unmatchedCompanyRows, 980);
  assert.ok(result.snapshot.quality.warnings.includes("10월 범위 경고")); assert.ok(!result.snapshot.quality.warnings.includes("9월 범위 경고"));
  assert.deepEqual(result.snapshot.quality.globalWarnings, ["전체 참고 10월 범위 경고"]);
  assert.equal(result.snapshot.quality.globalDiagnostics.malformedHistoryLines, 4);
  const previous = result.snapshot.comparison.previousQuality;
  assert.equal(previous.sourceDiagnostics.unmatchedCompanyRows, 516);
  assert.ok(previous.warnings.includes("9월 범위 경고")); assert.ok(!previous.warnings.includes("10월 범위 경고"));
  assert.deepEqual(previous.globalWarnings, ["전체 참고 9월 범위 경고"]); assert.equal(previous.globalDiagnostics.malformedHistoryLines, 3);
  const legacy = { ...source }; delete legacy.monthlySourceMetadata;
  const pureLegacy = buildMonthlyReportSnapshot(request, legacy, NOW);
  assert.deepEqual(result.snapshot.summary, pureLegacy.summary); assert.deepEqual(result.snapshot.daily, pureLegacy.daily);
  assert.equal(result.snapshot.sources.digest, pureLegacy.sources.digest);
  const projectionBefore = await tree(outputDir), originals = { writeFile: fs.writeFile, mkdir: fs.mkdir, utimes: fs.utimes };
  try {
    for (const key of Object.keys(originals)) fs[key] = async () => { throw Error(`Unexpected runtime ${key}`); };
    assert.deepEqual(await service.analyze({ keyword: KEYWORD, month: request.month, cutoffDate: request.cutoffDate }), result);
  } finally { Object.assign(fs, originals); }
  assert.deepEqual(await tree(outputDir), projectionBefore); assert.equal(JSON.stringify(source), before);
  const index = JSON.parse(await fs.readFile(path.join(outputDir, "index.json"), "utf8"));
  const scope = index.keywords[0].scopes.find(row => row.month === "2026-10");
  const projection = JSON.parse(await fs.readFile(path.join(outputDir, "projections", `${scope.scopeKey}.json`), "utf8"));
  assert.deepEqual(Object.keys(projection.source.monthlySourceMetadata), ["2026-10", "2026-09"]);
});

test("legacy metadata-absent source is a byte-preserving no-op and raw observation duplication does not alter monthly metadata", async t => {
  const legacy = sourceFixture(), legacyBytes = JSON.stringify(legacy);
  assert.strictEqual(sourceForKeywordMonthlyRequest(legacy, { month: "2026-09" }), legacy);
  assert.equal(JSON.stringify(legacy), legacyBytes);
  const source = monthlyMetadataFixture(), doubled = { ...source, observations: [...source.observations, ...source.observations] };
  const normal = await setup(t, source), duplicate = await setup(t, doubled);
  const query = { keyword: KEYWORD, month: "2026-10", cutoffDate: "2026-10-15" };
  const a = await normal.service.analyze(query), b = await duplicate.service.analyze(query);
  assert.deepEqual(a.snapshot.summary, b.snapshot.summary); assert.deepEqual(a.snapshot.daily, b.snapshot.daily);
  assert.equal(a.snapshot.sources.digest, b.snapshot.sources.digest);
  assert.deepEqual(a.snapshot.quality.sourceDiagnostics, b.snapshot.quality.sourceDiagnostics);
  assert.deepEqual(a.snapshot.quality.globalDiagnostics, b.snapshot.quality.globalDiagnostics);
  assert.deepEqual(a.snapshot.comparison.previousQuality.sourceDiagnostics, b.snapshot.comparison.previousQuality.sourceDiagnostics);
  assert.deepEqual(a.snapshot.comparison.previousQuality.globalWarnings, b.snapshot.comparison.previousQuality.globalWarnings);
});

test("monthly metadata rejects malformed, unbounded, private or missing observed-month values before publication", async t => {
  const cases = [null, [], {}, { "2026-13": monthMetadata("경고", 1, 0) },
    { "2026-09": { ...monthMetadata("경고", 1, 0), address: "disallowed" } },
    { "2026-09": { ...monthMetadata("경고", 1, 0), sourceDiagnostics: { unmatchedCompanyRows: "516" } } },
    { "2026-09": { ...monthMetadata("경고", 1, 0), globalDiagnostics: { malformedHistoryLines: -1 } } },
    { "2026-09": { ...monthMetadata("경고", 1, 0), sourceDiagnostics: { privateToken: 1 } } },
    { "2026-09": { ...monthMetadata("경고", 1, 0), warnings: ["/var/data/private"] } },
    { "2026-09": { ...monthMetadata("경고", 1, 0), globalWarnings: ["x".repeat(1001)] } }];
  const { root } = await setup(t);
  for (let i = 0; i < cases.length; i++) {
    const source = sourceFixture(); source.monthlySourceMetadata = cases[i]; const outputDir = path.join(root, `invalid-month-${i}`);
    await assert.rejects(buildKeywordMonthlyProjection({ source, sourceFingerprint: hash(JSON.stringify(source)), outputDir, now: () => NOW }), error => /^KEYWORD_MONTHLY_(?:INVALID|UNSAFE)_MONTH_METADATA$/.test(error.code));
    await assert.rejects(fs.stat(outputDir), error => error.code === "ENOENT");
  }
  const source = monthlyMetadataFixture(); delete source.monthlySourceMetadata["2026-09"];
  await assert.rejects(buildKeywordMonthlyProjection({ source, sourceFingerprint: hash(JSON.stringify(source)), outputDir: path.join(root, "missing-month"), now: () => NOW }), error => error.code === "KEYWORD_MONTHLY_MONTH_METADATA_UNAVAILABLE");
});

test("monthly metadata rejects multiple observed keyword descriptors but allows unrelated run metadata and legacy merged sources", async t => {
  const source = monthlyMetadataFixture();
  source.runs.push({ id: "other-keyword", keyword: "경남글램핑", collectedAt: "2026-10-10T01:00:00Z", collectionQuality: "complete" });
  const { root, service } = await setup(t, source);
  assert.deepEqual((await service.options()).keywords.map(row => row.keyword), [KEYWORD]);
  const second = row("other-keyword", "2026-10-20", "2026-10-10T01:00:00Z", { keyword: "경남글램핑" });
  const multiple = { ...source, observations: [...source.observations, second] };
  await assert.rejects(buildKeywordMonthlyProjection({ source: multiple, sourceFingerprint: hash(JSON.stringify(multiple)), outputDir: path.join(root, "ambiguous"), now: () => NOW }), error => error.code === "KEYWORD_MONTHLY_AMBIGUOUS_METADATA_SCOPE");
  const ranked = { ...source, rankObservations: [...source.rankObservations, { companyId: "a", runId: "other-keyword", keyword: "경남글램핑", rank: 1, collectedAt: "2026-10-10T01:00:00Z" }] };
  await assert.rejects(buildKeywordMonthlyProjection({ source: ranked, sourceFingerprint: hash(JSON.stringify(ranked)), outputDir: path.join(root, "ambiguous-rank"), now: () => NOW }), error => error.code === "KEYWORD_MONTHLY_AMBIGUOUS_METADATA_SCOPE");
  delete multiple.monthlySourceMetadata;
  const merged = await setup(t, multiple);
  assert.equal((await merged.service.options()).keywords.length, 2);
});
