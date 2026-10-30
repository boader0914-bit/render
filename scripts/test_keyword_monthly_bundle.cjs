"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs/promises"), os = require("node:os"), path = require("node:path"), crypto = require("node:crypto");
const { buildKeywordMonthlyProjection, createKeywordMonthlyAnalysis } = require("./lib/keyword_monthly_analysis.cjs");
const { createKeywordMonthlyBundleAnalysis, publishKeywordMonthlyBundle, loadBundle, composeOptions, KEYWORD_MONTHLY_BUNDLE_LIMITS } = require("./lib/keyword_monthly_bundle.cjs");
const { args } = require("./build_keyword_monthly_bundle.cjs");
const NOW = "2026-10-30T00:00:00.000Z", A = "가평글램핑", B = "경남글램핑", sha = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
function fixture(keyword, sold, marker) {
  const runs = [], observations = [];
  for (const [month, collectedAt] of [["2026-09", "2026-09-20T01:00:00Z"], ["2026-10", "2026-10-20T01:00:00Z"]]) {
    const id = `${marker}-${month}`; runs.push({ id, keyword, collectedAt, collectionQuality: { status: "complete" } });
    observations.push({ observationId: id, companyId: "canonical-a", runId: id, keyword, productType: "lodging", stayDate: `${month}-20`, collectedAt, inventoryEvidenceVersion: 4,
      supply: 5, sold, publicBookings: sold, phoneBookings: 0, publicRevenue: sold * 100, phoneRevenue: 0, estimatedRevenue: sold * 100,
      explicitBlockedBookings: 0, sharedDayUseExcluded: 0, phoneMissingPriceBookings: 0, partial: false, missing: false,
      dayUsePresence: "absent", dayUseSharingStatus: "not_shared", capacityBasis: { count: 5, source: "db_correction" } });
  }
  const metadata = month => ({ warnings: [`${marker} ${month}`], sourceDiagnostics: { scopedDiagnostic: marker === "a" ? 1 : 2 }, globalWarnings: [], globalDiagnostics: {} });
  return { companies: [{ companyId: "canonical-a", primaryName: "공개 업체", capacity: 5, capacitySource: "db_correction" }], runs, observations, rankObservations: [], savedProductRecoveries: [], warnings: [], sourceDiagnostics: {},
    monthlySourceMetadata: { "2026-09": metadata("2026-09"), "2026-10": metadata("2026-10") } };
}
async function setup(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "keyword-monthly-bundle-"));
  t.after(async () => { assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith("keyword-monthly-bundle-")); await fs.rm(root, { recursive: true, force: true }); });
  const prepare = async (name, keyword, sold, marker = name, at = NOW) => { const source = fixture(keyword, sold, marker), directory = path.join(root, name);
    await buildKeywordMonthlyProjection({ source, sourceFingerprint: sha(JSON.stringify(source)), outputDir: directory, materializedAt: at, now: () => at }); return directory; };
  return { root, prepare, output: path.join(root, "bundle") };
}
const query = keyword => ({ keyword, month: "2026-10", cutoffDate: "2026-10-20" });
async function files(directory) { const result = []; for (const row of await fs.readdir(directory, { withFileTypes: true })) { const file = path.join(directory, row.name); if (row.isDirectory()) result.push(...await files(file)); else result.push({ file, sha256: sha(await fs.readFile(file)) }); } return result.sort((a, b) => a.file.localeCompare(b.file)); }
test("legacy single index remains byte-compatible and introduces no bundle wrapper fields", async t => {
  const { prepare } = await setup(t), directory = await prepare("a", A, 2), legacy = createKeywordMonthlyAnalysis({ projectionDir: directory, now: () => NOW }), bundle = createKeywordMonthlyBundleAnalysis({ projectionDir: directory, now: () => NOW });
  assert.deepEqual(await bundle.options(), await legacy.options()); assert.deepEqual(await bundle.analyze(query(A)), await legacy.analyze(query(A)));
});
test("two independent keywords preserve source provenance, month metadata, values and read-only source files", async t => {
  const { prepare, output } = await setup(t), a = await prepare("a", A, 2), b = await prepare("b", B, 4), beforeA = await files(a), beforeB = await files(b);
  const receipt = await publishKeywordMonthlyBundle({ inputs: [{ directory: a }, { directory: b }], outputDir: output, now: NOW });
  assert.equal(receipt.partitionCount, 2); assert.equal(receipt.scopeCount, 4);
  const service = createKeywordMonthlyBundleAnalysis({ projectionDir: output, now: () => NOW }), options = await service.options();
  assert.deepEqual(options.keywords.map(row => row.keyword), [A, B]);
  for (const [keyword, sold, directory] of [[A, 2, a], [B, 4, b]]) {
    const expected = await createKeywordMonthlyAnalysis({ projectionDir: directory, now: () => NOW }).analyze(query(keyword)), actual = await service.analyze(query(keyword));
    assert.equal(actual.snapshot.summary.lodging.sold, sold); assert.deepEqual(actual.snapshot, expected.snapshot); assert.equal(actual.provenance.inputSha256, expected.provenance.inputSha256);
    assert.match(actual.resultId, /^[a-f0-9]{64}$/); assert.equal(actual.resultId, (await service.analyze(query(keyword))).resultId);
  }
  assert.notEqual((await service.analyze(query(A))).provenance.inputSha256, (await service.analyze(query(B))).provenance.inputSha256);
  assert.deepEqual(await files(a), beforeA); assert.deepEqual(await files(b), beforeB);
});
test("adjacent prepared partitions expose exact subsets without rewriting their indexes or merging month diagnostics", async t => {
  const { prepare, output } = await setup(t), old = await prepare("a", A, 1), recent = await prepare("b", A, 4);
  await publishKeywordMonthlyBundle({ inputs: [{ directory: old, exposeScopes: [{ keyword: A, month: "2026-09" }] }, { directory: recent, exposeScopes: [{ keyword: A, month: "2026-10" }] }], outputDir: output, now: NOW });
  const service = createKeywordMonthlyBundleAnalysis({ projectionDir: output, now: () => NOW });
  const september = await service.analyze({ keyword: A, month: "2026-09", cutoffDate: "2026-09-20" }), october = await service.analyze(query(A));
  assert.equal(september.snapshot.summary.lodging.sold, 1); assert.equal(october.snapshot.summary.lodging.sold, 4);
  assert.notEqual(september.provenance.inputSha256, october.provenance.inputSha256); assert.equal((await service.options()).keywords.length, 1);
});
test("duplicate scope and byte bounds fail before an active bundle is created", async t => {
  const { prepare, output, root } = await setup(t), a = await prepare("a", A, 2), b = await prepare("b", A, 4);
  await assert.rejects(publishKeywordMonthlyBundle({ inputs: [{ directory: a }, { directory: b }], outputDir: output, now: NOW }), /SCOPE_CONFLICT/);
  await assert.rejects(fs.access(output));
  await assert.rejects(publishKeywordMonthlyBundle({ inputs: [{ directory: a }], outputDir: path.join(root, "bounded"), now: NOW, maxTotalBytes: 1 }), /TOTAL_BOUND/);
  await assert.rejects(fs.access(path.join(root, "bounded")));
});
test("pointer promotion requires the old SHA and retains the previous immutable generation", async t => {
  const { prepare, output } = await setup(t), a = await prepare("a", A, 2), b = await prepare("b", A, 4);
  const first = await publishKeywordMonthlyBundle({ inputs: [{ directory: a }], outputDir: output, now: NOW }), before = await fs.readFile(path.join(output, "current.json"));
  await assert.rejects(publishKeywordMonthlyBundle({ inputs: [{ directory: b }], outputDir: output, now: NOW, expectedCurrentSha256: "a".repeat(64) }), /POINTER_CONFLICT/);
  assert.deepEqual(await fs.readFile(path.join(output, "current.json")), before);
  const second = await publishKeywordMonthlyBundle({ inputs: [{ directory: b }], outputDir: output, now: NOW, expectedCurrentSha256: first.pointerSha256 });
  assert.notEqual(first.generation, second.generation); await fs.access(path.join(output, "generations", first.generation, "catalog.json"));
  assert.equal((await createKeywordMonthlyBundleAnalysis({ projectionDir: output, now: () => NOW }).analyze(query(A))).snapshot.summary.lodging.sold, 4);
});
test("stale child provenance is preserved and never refreshed by fresh bundle assembly", async t => {
  const { prepare, output } = await setup(t), a = await prepare("a", A, 2), b = await prepare("b", B, 4, "b", "2026-10-27T00:00:00Z");
  await publishKeywordMonthlyBundle({ inputs: [{ directory: a }, { directory: b }], outputDir: output, now: NOW });
  const service = createKeywordMonthlyBundleAnalysis({ projectionDir: output, now: () => NOW }), options = await service.options(), result = await service.analyze(query(B));
  assert.equal(options.status, "available"); assert.equal(options.keywords.find(row => row.keyword === B).availabilityByMonth["2026-10"], "stale");
  assert.equal(result.status, "stale"); assert.ok(result.snapshot); assert.equal(result.provenance.materializedAt, "2026-10-27T00:00:00Z"); assert.ok(result.diagnostics.includes("PROJECTION_EXPIRED"));
});
test("invalid pointer, changed index and hardlinks cannot silently fall back to an older reader", async t => {
  const { prepare, output, root } = await setup(t), a = await prepare("a", A, 2);
  await publishKeywordMonthlyBundle({ inputs: [{ directory: a }], outputDir: output, now: NOW });
  const service = createKeywordMonthlyBundleAnalysis({ projectionDir: output, now: () => NOW }), pointerFile = path.join(output, "current.json"), original = await fs.readFile(pointerFile);
  const value = JSON.parse(original); value.generation = "../escape"; await fs.writeFile(pointerFile, JSON.stringify(value));
  assert.equal((await service.options()).status, "needs_verification"); await fs.writeFile(pointerFile, original);
  const bundle = await loadBundle(output), index = path.join(bundle.generationDir, "partitions", bundle.catalog.partitions[0].key, "index.json"), linked = path.join(root, "linked-index.json");
  await fs.link(index, linked); const blocked = await service.analyze(query(A)); assert.equal(blocked.status, "needs_verification"); assert.equal(blocked.snapshot, null); await fs.unlink(linked);
  const bytes = await fs.readFile(index), edited = JSON.parse(bytes); edited.provenance.dataThrough = "2026-10-19T00:00:00Z"; await fs.writeFile(index, JSON.stringify(edited));
  assert.equal((await service.analyze(query(A))).status, "needs_verification");
});
test("generation changes during a query discard the old result instead of mixing sources", async t => {
  const { prepare, output } = await setup(t), a = await prepare("a", A, 2), b = await prepare("b", A, 4);
  const first = await publishKeywordMonthlyBundle({ inputs: [{ directory: a }], outputDir: output, now: NOW }), pointerFile = path.join(output, "current.json"), oldPointer = await fs.readFile(pointerFile);
  await publishKeywordMonthlyBundle({ inputs: [{ directory: b }], outputDir: output, now: NOW, expectedCurrentSha256: first.pointerSha256 }); const newPointer = await fs.readFile(pointerFile); await fs.writeFile(pointerFile, oldPointer);
  const original = fs.open; let changed = false;
  fs.open = async function (file, ...rest) { if (!changed && String(file).includes(`${path.sep}projections${path.sep}`)) { changed = true; await fs.writeFile(pointerFile, newPointer); } return original.call(this, file, ...rest); };
  try { const result = await createKeywordMonthlyBundleAnalysis({ projectionDir: output, now: () => NOW }).analyze(query(A)); assert.equal(result.status, "needs_verification"); assert.equal(result.snapshot, null); assert.ok(result.diagnostics.includes("KEYWORD_MONTHLY_BUNDLE_CHANGED_DURING_READ")); }
  finally { fs.open = original; }
});
test("unprepared scopes and invalid dates remain missing/invalid rather than zero", async t => {
  const { prepare, output } = await setup(t), a = await prepare("a", A, 2); await publishKeywordMonthlyBundle({ inputs: [{ directory: a }], outputDir: output, now: NOW });
  const service = createKeywordMonthlyBundleAnalysis({ projectionDir: output, now: () => NOW }), missing = await service.analyze({ keyword: A, month: "2026-11", cutoffDate: "2026-10-20" });
  assert.equal(missing.status, "missing"); assert.equal(missing.snapshot, null); assert.ok(missing.diagnostics.includes("KEYWORD_MONTHLY_SCOPE_NOT_PREPARED"));
  await assert.rejects(service.analyze({ ...query(A), cutoffDate: "2026-02-30" }), error => error.statusCode === 400);
});
test("CLI rejects ambiguous inputs, relative paths, missing clocks and duplicate options", () => {
  const base = ["--input", path.resolve("prepared"), "--output", path.resolve("bundle"), "--now", NOW]; assert.equal(args(base).inputs.length, 1);
  assert.throws(() => args([...base, "--plan", path.resolve("plan.json")]), /REQUIRED_ARGUMENTS/); assert.throws(() => args(["--input", "relative", "--output", path.resolve("bundle"), "--now", NOW]), /ABSOLUTE_PATH_REQUIRED/);
  assert.throws(() => args(base.slice(0, -2)), /REQUIRED_ARGUMENTS/); assert.throws(() => args([...base, "--now", NOW]), /ARGUMENTS/);
  assert.throws(() => args([...base.slice(0, -2), "--now", "2026-02-30T00:00:00Z"]), /FIXED_CLOCK_REQUIRED/);
});
test("monthly provenance uses a fixed small whitelist instead of repeating full selection maps", () => {
  const months = Array.from({ length: 1200 }, (_, index) => `${2000 + Math.floor(index / 12)}-${String(index % 12 + 1).padStart(2, "0")}`), key = "a".repeat(64);
  const options = { status: "available", keywords: [{ keyword: A, stayMonths: months, collectionMonths: months, inventoryStayMonths: months, rankMonths: [], defaultCutoffs: Object.fromEntries(months.map(month => [month, "2026-10-22"])), supportedCutoffs: null }],
    provenance: { inputSha256: "b".repeat(64), materializedAt: NOW, dataThrough: "2026-10-22T10:00:00Z", indexSha256: key, originalFreshnessVerified: false, selectionCutoffs: Object.fromEntries(months.map(month => [month, "2026-10-22"])) } };
  const catalog = { createdAt: NOW, partitions: [{ key }], scopes: months.map(month => ({ keyword: A, month, partition: key })) };
  const result = composeOptions(catalog, new Map([[key, { options }]]), [], {}, { generation: "a".repeat(32), catalogSha256: key, pointerSha256: key });
  assert.equal(Object.hasOwn(result.keywords[0].provenanceByMonth[months[0]], "selectionCutoffs"), false);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < KEYWORD_MONTHLY_BUNDLE_LIMITS.optionsBytes); assert.equal(result.keywords[0].collectionMonths.length, 1200);
});
test("options has an explicit 2MiB response cap across otherwise bounded partitions", () => {
  const months = Array.from({ length: 322 }, (_, index) => `${2000 + Math.floor(index / 12)}-${String(index % 12 + 1).padStart(2, "0")}`), parts = new Map(), catalog = { createdAt: NOW, partitions: [], scopes: [] };
  for (let p = 0; p < 128; p++) {
    const key = p.toString(16).padStart(64, "0"), keywords = [];
    for (let k = 0; k < 8; k++) { const keyword = `관측검색어${p}-${k}`; catalog.scopes.push({ keyword, month: "2026-10", partition: key }); keywords.push({ keyword, collectionMonths: months, inventoryStayMonths: ["2026-10"], rankMonths: [], defaultCutoffs: { "2026-10": "2026-10-22" }, supportedCutoffs: null }); }
    catalog.partitions.push({ key }); parts.set(key, { options: { status: "available", keywords, provenance: { inputSha256: key, materializedAt: NOW, dataThrough: "2026-10-22T10:00:00Z" } } });
  }
  assert.throws(() => composeOptions(catalog, parts, [], {}, { generation: "a".repeat(32), catalogSha256: "a".repeat(64), pointerSha256: "b".repeat(64) }), /OPTIONS_RESPONSE_LIMIT/);
});
test("legacy reads are discarded if the first current pointer appears during that query", async t => {
  const { prepare } = await setup(t), a = await prepare("a", A, 2), b = await prepare("b", A, 4);
  await publishKeywordMonthlyBundle({ inputs: [{ directory: b }], outputDir: a, now: NOW }); const pointerFile = path.join(a, "current.json"), pointer = await fs.readFile(pointerFile); await fs.unlink(pointerFile);
  const original = fs.open; let changed = false;
  fs.open = async function (file, ...rest) { if (!changed && String(file).includes(`${path.sep}projections${path.sep}`)) { changed = true; await fs.writeFile(pointerFile, pointer); } return original.call(this, file, ...rest); };
  try { const result = await createKeywordMonthlyBundleAnalysis({ projectionDir: a, now: () => NOW }).analyze(query(A)); assert.equal(result.status, "needs_verification"); assert.equal(result.snapshot, null); assert.ok(result.diagnostics.includes("KEYWORD_MONTHLY_BUNDLE_CHANGED_DURING_READ")); }
  finally { fs.open = original; }
});
test("a post-promotion receipt failure explicitly reports committed state for readback", async t => {
  const { prepare, output } = await setup(t), a = await prepare("a", A, 2), original = fs.writeFile; let caught;
  fs.writeFile = async function (file, ...rest) { if (String(file).endsWith("publication-receipt.json")) throw Object.assign(new Error("fixture receipt failure"), { code: "EIO" }); return original.call(this, file, ...rest); };
  try { await publishKeywordMonthlyBundle({ inputs: [{ directory: a }], outputDir: output, now: NOW }); }
  catch (error) { caught = error; } finally { fs.writeFile = original; }
  assert.equal(caught.code, "KEYWORD_MONTHLY_BUNDLE_PUBLICATION_NEEDS_READBACK"); assert.equal(caught.publicationState, "pointer_was_promoted_verify_current");
  assert.equal((await loadBundle(output)).pointer.generation, caught.generation);
  assert.equal((await createKeywordMonthlyBundleAnalysis({ projectionDir: output, now: () => NOW }).analyze(query(A))).status, "available");
});
