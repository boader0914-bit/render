"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const V = require("./verify_keyword_monthly_incremental_realcopy.cjs");
const source = observations => ({ companies: [{ companyId: "a" }], runs: [{ id: "r", keyword: "k", collectedAt: "2026-10-01T00:00:00Z", collectionQuality: { status: "complete" } }],
  observations, rankObservations: [], savedProductRecoveries: [], warnings: [], sourceDiagnostics: {} });
const metric = (revenue = 0, count = 0) => ({ knownPartialRevenue: count ? revenue : null, knownPartialPublicRevenue: count ? revenue : null,
  knownPartialBlockedRevenue: count ? 0 : null, knownPartialCompanyDays: count });
function snapshot(partial = [], normal = []) {
  const included = partial.filter(r => r.includedInPartialSubtotal), n = included.reduce((sum, r) => sum + r.knownPartialRevenue, 0);
  return { summary: { lodging: metric(n, included.length), dayuse: metric() }, daily: [], companies: [],
    sources: { observations: normal, partialEvidence: partial }, insights: { pickup: 3, unknownPrice: null } };
}
test("source comparison preserves duplicate multiplicity, array order and metadata", () => {
  const a = source([{ observationId: "1" }, { observationId: "2" }]);
  assert.equal(V.compareNormalizedSources(a, structuredClone(a)).passed, true);
  assert.equal(V.compareNormalizedSources(source([...a.observations, a.observations[0]]), a).passed, false);
  assert.equal(V.compareNormalizedSources(source([...a.observations].reverse()), a).passed, false);
  assert.equal(V.compareNormalizedSources({ ...a, sourceDiagnostics: { missing: 1 } }, a).passed, false);
  assert.notEqual(V.fingerprint({ x: null }), V.fingerprint({ x: undefined }));
  assert.notEqual(V.fingerprint({ x: null }), V.fingerprint({ x: 0 }));
});
test("snapshot comparison checks insights and independently rejects partial overlap or bad subtotals", () => {
  const row = { companyId: "a", date: "2026-10-01", productType: "lodging", knownPartialRevenue: 7,
    knownPartialPublicRevenue: 7, knownPartialBlockedRevenue: 0, includedInPartialSubtotal: true };
  const a = snapshot([row]);
  assert.equal(V.compareSnapshots(a, structuredClone(a)).passed, true);
  const changed = structuredClone(a); changed.insights.pickup++;
  assert.equal(V.compareSnapshots(changed, a).passed, false);
  assert.equal(V.partialAccounting(snapshot([row], [row])).passed, false);
  const bad = structuredClone(a); bad.summary.lodging.knownPartialRevenue = 0;
  assert.equal(V.partialAccounting(bad).passed, false);
});
test("physical history split keeps exact selected bytes and original ordinals", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "incremental-realcopy-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const first = Buffer.from('{"runId":"a","n":1}\r\n'), unrelated = Buffer.from('{"runId":"b"}\n'), duplicate = Buffer.from('{"runId":"a","n":1}');
  const original = Buffer.concat([first, unrelated, Buffer.from("malformed\n"), duplicate]), file = path.join(root, "observations.jsonl");
  await fs.writeFile(file, original);
  const selected = [], ordinals = [], offsets = [];
  const result = await V.scanHistory(file, new Set(["a"]), r => { selected.push(Buffer.from(r.raw)); ordinals.push(r.ordinal); offsets.push(r.offset); });
  assert.deepEqual(Buffer.concat(selected), Buffer.concat([first, duplicate]));
  assert.deepEqual(ordinals, [1, 4]); assert.deepEqual(offsets, [0, first.length + unrelated.length + 10]);
  assert.equal(result.selectedRows, 2); assert.equal(result.malformedLines, 1);
  assert.deepEqual(await fs.readFile(file), original);
});
test("replay plans expose bounded physical prefixes and never call preparation a Layer B pass", () => {
  const runs = [1, 2, 3].map(n => ({ runId: `r${n}`, collectedAt: `2026-10-0${n}T00:00:00Z`, quality: "complete", sourceRunOrdinal: n, keyword: "k" }));
  const history = { file: "/fixture/history/observations.jsonl", perRun: Object.fromEntries(runs.map((r, n) => [r.runId, { rows: 1, bytes: 20, firstOrdinal: n + 1, lastOrdinal: n + 1 }])) };
  const capture = { capturedAt: "2026-11-15T00:00:00Z", sourceInventorySha256: "f".repeat(64), inputFiles: [{ relative: "company_master/companies.json", bytes: 200 }, { relative: "history/observations.jsonl", bytes: 60 }],
    originalOutputs: { files: [{ relative: "r3/manifest.json", bytes: 80 }, { relative: "r3/private.xlsx", bytes: 500 }, { relative: "r3/traffic_metrics.json", bytes: 500 }] } };
  const plan = V.replayPlan({ capture, captured: { file: "/capture.json", sha256: "e".repeat(64) }, history, keyword: "k", oracles: { runs, summaries: [{ requests: [{ month: "2026-10", cutoffDate: "2026-10-25" }] }] } });
  assert.equal(plan.status, "prepared"); assert.equal(plan.layerBAccepted, false);
  assert.equal(plan.bootstrapRunCount, 2); assert.equal(plan.deltaRunCount, 1);
  assert.deepEqual(plan.arms.delta.runIds, ["r3"]); assert.equal(plan.arms.delta.outputBytes, 80);
  assert.equal(plan.fourConditions.length, 2);
  assert.equal(plan.limitations.some(s => s.includes("latest state")), true);
});
test("physical verifier rejects a normalized-row split without isolated physical-normalization evidence", async () => {
  const noOp = async () => ({});
  await assert.rejects(V.verifyLayerB({ plan: { queries: [{}], arms: { delta: { runIds: ["r"] } } }, fixtures: { before: {}, after: {}, delta: {} }, now: "2026-11-15T00:00:00Z",
    normalizeFull: async () => ({ source: source([]) }), normalizeDelta: noOp, bootstrap: noOp, applyDelta: noOp, readStateSource: noOp, buildSnapshot: noOp }),
  { code: "INCREMENTAL_VERIFY_PHYSICAL_NORMALIZATION_REQUIRED" });
});
test("output ownership rejects input overlap and existing destinations", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "incremental-realcopy-owned-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await assert.rejects(V.createOwnedOutput(path.join(root, "source", "new"), [path.join(root, "source")]), { code: "INCREMENTAL_VERIFY_OUTPUT_OVERLAP" });
  await assert.rejects(V.createOwnedOutput(root), { code: "EEXIST" });
  assert.throws(() => V.args(["--capture-manifest", "/c", "--oracle-complete", "/o", "--keyword", "k", "--output", "/out", "--output", "/other"]), { code: "INCREMENTAL_VERIFY_ARGUMENTS" });
});
test("deep differences distinguish missing/null/zero without publishing business values", () => {
  const result = V.deepDifferences({ financial: { a: 0, b: null }, name: "private-business-value" }, { financial: { a: null, b: undefined }, name: "another-private-value" });
  assert.equal(result.recordedDifferences, 3);
  assert.equal(result.differences.find(d => d.path === "/financial/a").actualType, "number");
  assert.equal(JSON.stringify(result).includes("private-business-value"), false);
  assert.equal(JSON.stringify(result).includes("another-private-value"), false);
  const bounded = V.deepDifferences(Array(1000).fill(0), Array(1000).fill(1), 7);
  assert.equal(bounded.recordedDifferences, 7); assert.equal(bounded.truncated, true);
});
test("an absent partial subtotal stays null while a real zero partial amount stays numeric zero", () => {
  const absent = snapshot(); assert.equal(V.partialAccounting(absent).passed, true);
  absent.summary.lodging.knownPartialRevenue = 0; assert.equal(V.partialAccounting(absent).passed, false);
  const zero = { companyId: "a", date: "2026-10-01", productType: "lodging", knownPartialRevenue: 0,
    knownPartialPublicRevenue: 0, knownPartialBlockedRevenue: 0, includedInPartialSubtotal: true };
  assert.equal(V.partialAccounting(snapshot([zero])).passed, true);
});
test("independent physical copies preserve the same captured run-directory updatedAt", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "incremental-realcopy-mtime-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const first = path.join(root, "first"), second = path.join(root, "second"); await fs.mkdir(first); await fs.mkdir(second);
  await fs.mkdir(path.join(first, "run")); await fs.mkdir(path.join(second, "run"));
  await fs.utimes(path.join(first, "run"), 1700000000, 1700000000); await fs.utimes(path.join(second, "run"), 1800000000, 1800000000);
  const capture = { originalOutputs: { directories: [{ relative: "", stamp: { mtimeNs: "1792907000000000000" } },
    { relative: "run", stamp: { mtimeNs: "1792907123456789000" } }] } };
  for (const outputsRoot of [first, second]) await V.preserveFixtureOutputTimes({ capture, outputsRoot, runIds: ["run"] });
  assert.equal((await fs.stat(path.join(first, "run"))).mtime.toISOString(), (await fs.stat(path.join(second, "run"))).mtime.toISOString());
});
