"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const { createKeywordMonthlyAnalysis } = require("./lib/keyword_monthly_analysis.cjs");
const { safeInput } = require("./build_keyword_monthly_projection.cjs");
const CLI = path.join(__dirname, "build_keyword_monthly_projection.cjs");
const NOW = "2026-10-30T00:00:00.000Z";
const KEYWORD = "가평글램핑";
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const row = (id, valueMonth) => ({ companyId: "a", runId: id, observationId: id, keyword: KEYWORD, productType: "lodging", stayDate: `${valueMonth}-20`,
  collectedAt: `${valueMonth}-10T01:00:00.000Z`, inventoryEvidenceVersion: 4, supply: 10, sold: 2, publicBookings: 2, phoneBookings: 0,
  estimatedRevenue: 200, publicRevenue: 200, phoneRevenue: 0, phoneMissingPriceBookings: 0, partial: false, missing: false, sharedDayUseExcluded: 0 });
async function setup(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "keyword-monthly-cli-"));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("keyword-monthly-cli-"));
    return fs.rm(root, { recursive: true, force: true });
  });
  const source = { companies: [{ companyId: "a", primaryName: "A" }], runs: ["2026-09", "2026-10"].map(valueMonth => ({ id: valueMonth, keyword: KEYWORD,
    collectedAt: `${valueMonth}-10T01:00:00.000Z`, collectionQuality: { status: "complete" } })), observations: [row("2026-09", "2026-09"), row("2026-10", "2026-10")], rankObservations: [] };
  const sourceFile = path.join(root, "source.json"), provenanceFile = path.join(root, "provenance.json"), output = path.join(root, "projection");
  const bytes = Buffer.from(JSON.stringify(source));
  const provenance = { inputSha256: hash(bytes), inputBytes: bytes.length, copiedAt: "2026-10-29T12:00:00.000Z", observationScope: "selected_only",
    selectionCutoffs: { "2026-09": "2026-09-22", "2026-10": "2026-10-22" } };
  await fs.writeFile(sourceFile, bytes, { flag: "wx" });
  await fs.writeFile(provenanceFile, JSON.stringify(provenance), { flag: "wx" });
  return { root, sourceFile, provenanceFile, output, provenance };
}
function invoke(f, extra = []) {
  const result = spawnSync(process.execPath, [CLI, "--source", f.sourceFile, "--output", f.output, "--provenance", f.provenanceFile, "--now", NOW, ...extra], { encoding: "utf8", timeout: 10000 });
  assert.equal(result.signal, null, result.stderr);
  return { code: result.status, result: result.stdout.trim() ? JSON.parse(result.stdout) : null, error: result.stderr.trim() ? JSON.parse(result.stderr) : null };
}
async function identity(file) {
  const [bytes, stat] = await Promise.all([fs.readFile(file), fs.stat(file)]);
  return { sha256: hash(bytes), size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, ino: stat.ino, dev: stat.dev };
}

test("CLI forwards exact multirun normalization cutoffs and rejects malformed dates", async t => {
  const f = await setup(t), normalizationCutoffs = { "2026-09": "2026-09-22", "2026-10": "2026-10-22" };
  const provenance = { ...f.provenance, observationScope: "normalized_multirun", normalizationCutoffs }; delete provenance.selectionCutoffs;
  await fs.writeFile(f.provenanceFile, JSON.stringify(provenance)); const actual = invoke(f);
  assert.equal(actual.code, 0, JSON.stringify(actual.error)); assert.deepEqual(actual.result.provenance.normalizationCutoffs, normalizationCutoffs);
  const invalid = await setup(t); await fs.writeFile(invalid.provenanceFile, JSON.stringify({ ...provenance, normalizationCutoffs: { "2026-10": "2026-02-30" } }));
  assert.equal(invoke(invalid).error.code, "KEYWORD_MONTHLY_CLI_PROVENANCE_INVALID");
});
async function tree(directory) {
  const rows = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) rows.push(...await tree(file));
    else rows.push({ file, ...await identity(file) });
  }
  return rows;
}

test("actual offline CLI preserves source/provenance, forwards exact cutoff provenance and creates an immutable new projection", async t => {
  const f = await setup(t), sourceBefore = await identity(f.sourceFile), provenanceBefore = await identity(f.provenanceFile);
  const execution = invoke(f);
  assert.equal(execution.code, 0, JSON.stringify(execution.error));
  assert.equal(execution.result.sourceFingerprint, sourceBefore.sha256);
  assert.equal(execution.result.provenance.inputSha256, sourceBefore.sha256);
  assert.equal(execution.result.provenance.inputBytes, sourceBefore.size);
  assert.equal(execution.result.provenance.observationScope, "selected_only");
  assert.deepEqual(execution.result.provenance.selectionCutoffs, f.provenance.selectionCutoffs);
  assert.equal(execution.result.provenanceFileSha256, provenanceBefore.sha256);
  assert.equal(execution.result.provenanceUnchanged, true);
  assert.equal(execution.result.providerCalls, 0); assert.equal(execution.result.kosisReadOrChanged, false);
  assert.deepEqual(await identity(f.sourceFile), sourceBefore);
  assert.deepEqual(await identity(f.provenanceFile), provenanceBefore);
  const before = await tree(f.output);
  const service = createKeywordMonthlyAnalysis({ projectionDir: f.output, now: () => NOW });
  const options = await service.options();
  assert.deepEqual(options.keywords[0].defaultCutoffs, f.provenance.selectionCutoffs);
  const current = await service.analyze({ keyword: KEYWORD, month: "2026-10" });
  assert.equal(current.status, "available"); assert.equal(current.request.cutoffDate, "2026-10-22");
  assert.equal(current.snapshot.summary.lodging.sold, 2);
  assert.equal(current.snapshot.summary.dayuse.sold, null);
  assert.equal(current.snapshot.comparison.previousCutoffDate, "2026-09-22");
  const historical = await service.analyze({ keyword: KEYWORD, month: "2026-10", cutoffDate: "2026-10-10" });
  assert.equal(historical.status, "missing"); assert.equal(historical.snapshot, null);
  assert.deepEqual(historical.diagnostics, ["CUTOFF_NOT_RECONSTRUCTIBLE"]);
  assert.equal(historical.supportedCutoffDate, "2026-10-22");
  assert.deepEqual(await tree(f.output), before);
  assert.deepEqual(await identity(f.sourceFile), sourceBefore);
  assert.deepEqual(await identity(f.provenanceFile), provenanceBefore);
});

test("existing output directory cannot be overwritten and existing artifacts stay identical", async t => {
  const f = await setup(t);
  assert.equal(invoke(f).code, 0);
  const before = await tree(f.root);
  const again = invoke(f);
  assert.equal(again.code, 1); assert.equal(again.error.code, "EEXIST");
  assert.deepEqual(await tree(f.root), before);
});

test("invalid or conflicting provenance fails before any output is created", async t => {
  const cases = [
    [value => ({ ...value, inputSha256: "b".repeat(64) }), "KEYWORD_MONTHLY_CLI_PROVENANCE_CONFLICT"],
    [value => ({ ...value, inputBytes: value.inputBytes + 1 }), "KEYWORD_MONTHLY_CLI_PROVENANCE_CONFLICT"],
    [value => ({ ...value, inputBytes: "1" }), "KEYWORD_MONTHLY_CLI_PROVENANCE_INVALID"],
    [value => ({ ...value, observationScope: "all_observations_assumed" }), "KEYWORD_MONTHLY_CLI_PROVENANCE_INVALID"],
    [value => ({ ...value, runInventoryComplete: true }), "KEYWORD_MONTHLY_CLI_PROVENANCE_INVALID"],
    [value => ({ ...value, selectionCutoffs: { "../source": "2026-10-22" } }), "KEYWORD_MONTHLY_CLI_PROVENANCE_INVALID"],
    [value => ({ ...value, selectionCutoffs: { "2026-10": "2026-02-30" } }), "KEYWORD_MONTHLY_CLI_PROVENANCE_INVALID"],
    [value => ({ ...value, selectionCutoffs: { "2026-10": "2026-10-22" } }), "KEYWORD_MONTHLY_SELECTION_CUTOFF_REQUIRED"]
  ];
  for (const [edit, code] of cases) {
    const f = await setup(t);
    await fs.writeFile(f.provenanceFile, JSON.stringify(edit(f.provenance)));
    const before = await identity(f.provenanceFile), sourceBefore = await identity(f.sourceFile);
    const execution = invoke(f);
    assert.equal(execution.code, 1); assert.equal(execution.error.code, code);
    await assert.rejects(fs.stat(f.output), error => error.code === "ENOENT");
    assert.deepEqual(await identity(f.provenanceFile), before); assert.deepEqual(await identity(f.sourceFile), sourceBefore);
  }
});

test("provenance JSON must be a bounded small ordinary file and cannot escape through links", async t => {
  for (const contents of ["{", "[]", JSON.stringify({ padding: "x".repeat(65536) })]) {
    const f = await setup(t); await fs.writeFile(f.provenanceFile, contents);
    const execution = invoke(f);
    assert.equal(execution.code, 1);
    assert.ok(["KEYWORD_MONTHLY_CLI_PROVENANCE_JSON", "KEYWORD_MONTHLY_CLI_PROVENANCE_INVALID", "KEYWORD_MONTHLY_CLI_INPUT_BOUND"].includes(execution.error.code));
    await assert.rejects(fs.stat(f.output), error => error.code === "ENOENT");
  }
  const hard = await setup(t); await fs.link(hard.provenanceFile, path.join(hard.root, "hardlink.json"));
  assert.equal(invoke(hard).error.code, "KEYWORD_MONTHLY_CLI_UNSAFE_INPUT");
  const linked = await setup(t), target = path.join(linked.root, "actual-provenance.json");
  await fs.rename(linked.provenanceFile, target);
  // Directory junctions work without the Windows developer-mode file-symlink permission.
  const directory = path.join(linked.root, "linked-parent");
  await fs.symlink(linked.root, directory, process.platform === "win32" ? "junction" : "dir");
  linked.provenanceFile = path.join(directory, "actual-provenance.json");
  assert.equal(invoke(linked).error.code, "KEYWORD_MONTHLY_CLI_UNSAFE_INPUT");
});

test("source/output boundary and explicit copied-at conflicts are rejected without changing inputs", async t => {
  const f = await setup(t), before = await tree(f.root);
  const insideSource = invoke({ ...f, output: f.root });
  assert.equal(insideSource.error.code, "KEYWORD_MONTHLY_CLI_OUTPUT_CONTAINS_SOURCE");
  const driveRoot = invoke({ ...f, output: path.parse(f.root).root });
  assert.equal(driveRoot.error.code, "KEYWORD_MONTHLY_CLI_OUTPUT_CONTAINS_SOURCE");
  const conflict = invoke(f, ["--copied-at", "2026-10-28T12:00:00.000Z"]);
  assert.equal(conflict.error.code, "KEYWORD_MONTHLY_CLI_PROVENANCE_CONFLICT");
  assert.deepEqual(await tree(f.root), before);
});

test("stable input reader detects replacement while the bounded file is being read", async t => {
  const f = await setup(t), originalOpen = fs.open;
  fs.open = async (...arguments_) => {
    const handle = await originalOpen(...arguments_);
    const originalRead = handle.read.bind(handle); let changed = false;
    handle.read = async (...readArguments) => {
      const result = await originalRead(...readArguments);
      if (!changed) {
        changed = true;
        await fs.writeFile(f.provenanceFile, JSON.stringify({ ...f.provenance, copiedAt: "2026-10-28T00:00:00.000Z" }));
      }
      return result;
    };
    return handle;
  };
  try { await assert.rejects(safeInput(f.provenanceFile, 64 * 1024), error => error.message === "KEYWORD_MONTHLY_CLI_SOURCE_CHANGED"); }
  finally { fs.open = originalOpen; }
});
