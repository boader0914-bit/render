"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs/promises"), native = require("node:fs"), path = require("node:path"), os = require("node:os");
const { installReadOnlyOutputs } = require("./lib/keyword_monthly_readonly_outputs.cjs"), { installScratchBudget } = require("./lib/keyword_monthly_scratch_budget.cjs"), { stamp } = require("./lib/keyword_monthly_source_copy.cjs");
const { installGuards } = require("./reconstruct_keyword_monthly_source_copy.cjs");
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "keyword-reference-test-")); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const original = path.join(root, "original"), copy = path.join(root, "copy"); await fs.mkdir(original); await fs.mkdir(copy); await fs.mkdir(path.join(original, "run"));
  const file = path.join(original, "run/manifest.json"); await fs.writeFile(file, '{"keyword":"fixture"}');
  const stat = await fs.lstat(file, { bigint: true }); return { root, original, copy, file, files: [{ relative: "run/manifest.json", bytes: Number(stat.size), stamp: stamp(stat) }] };
}
test("read-only originals are metadata-bound, nofollow and SHA verified without copying bodies", async t => {
  const f = await fixture(t), guard = installGuards(f.copy, { originalOutputs: { root: f.original, files: f.files } }), view = installReadOnlyOutputs({ root: f.original, files: f.files });
  try {
    await view.assertInventoryCurrent(); assert.equal(await fs.readFile(f.file, "utf8"), '{"keyword":"fixture"}'); assert.equal(native.readFileSync(f.file, "utf8"), '{"keyword":"fixture"}');
    const handle = await fs.open(f.file, "r"); await assert.rejects(handle.writeFile("no"), { code: "KEYWORD_OUTPUT_WRITE_DENIED" }); await handle.close();
    await fs.mkdir(f.original, { recursive: true }); // checked read-only no-op, not an original mkdir syscall
    const proof = await view.verify(); assert.equal(proof.originalWrites, 0); assert.equal(proof.bodies.length, 1); assert.equal(proof.bodies[0].sha256, proof.bodies[0].afterSha256);
    assert.ok(proof.metrics.consumerFdChecks >= 2);
    await assert.rejects(fs.readFile(path.join(f.original, "run/optional-missing.json")), { code: "ENOENT" }); assert.equal(view.metrics.expectedMissingReads, 1); assert.equal(view.metrics.uncapturedReadAttempts, 0);
    assert.equal(proof.metrics.nonMutatingExistingDirectoryChecks, 1); assert.equal(proof.originalOutputBodiesCopied, false);
    assert.throws(() => native.openSync(f.file, "w"), { code: "KEYWORD_OUTPUT_WRITE_DENIED" });
  } finally { view.restore(); guard.restore(); }
  assert.equal(await fs.readFile(f.file, "utf8"), '{"keyword":"fixture"}'); assert.deepEqual(await fs.readdir(f.copy), []);
});
test("new, changed and symlinked original files fail instead of becoming captured evidence", async t => {
  const f = await fixture(t), view = installReadOnlyOutputs({ root: f.original, files: f.files });
  try { await fs.writeFile(f.file, "changed"); await assert.rejects(fs.readFile(f.file), { code: "KEYWORD_OUTPUT_CHANGED" }); await assert.rejects(view.verify(), { code: "KEYWORD_OUTPUT_CHANGED" }); }
  finally { view.restore(); }
  const g = await fixture(t), view2 = installReadOnlyOutputs({ root: g.original, files: g.files });
  try { await fs.writeFile(path.join(g.original, "new.json"), "{}"); await assert.rejects(view2.assertInventoryCurrent(), { code: "KEYWORD_OUTPUT_NOT_CAPTURED" }); }
  finally { view2.restore(); }
});
test("a scratch reservation rejects an oversized file before any body is written", async t => {
  const f = await fixture(t), budget = installScratchBudget(f.copy, 128 * 1024);
  try {
    const file = path.join(f.copy, "small.json"); await fs.writeFile(file, "{}");
    await assert.rejects(fs.writeFile(path.join(f.copy, "oversized.json"), Buffer.alloc(256 * 1024)), { code: "KEYWORD_SCRATCH_HARD_BOUND" });
    await assert.rejects(fs.stat(path.join(f.copy, "oversized.json")), { code: "ENOENT" });
    const handle = await fs.open(path.join(f.copy, "handle.bin"), "wx");
    try {
      await assert.rejects(handle.writeFile(Buffer.alloc(256 * 1024)), { code: "KEYWORD_SCRATCH_HARD_BOUND" });
      await assert.rejects(handle.write(Buffer.from("x"), 0, 1, 1024 * 1024), { code: "KEYWORD_SCRATCH_HARD_BOUND" });
      assert.throws(() => handle.write(Buffer.from("x"), { position: 1024 * 1024 }), { code: "KEYWORD_SCRATCH_UNSUPPORTED_WRITE_SIGNATURE" });
      assert.throws(() => handle.createWriteStream(), { code: "KEYWORD_SCRATCH_UNSUPPORTED_WRITER" });
    } finally { await handle.close(); }
    assert.equal((await fs.stat(path.join(f.copy, "handle.bin"))).size, 0); assert.ok(budget.status().peakReservedAndAllocatedBytes <= 128 * 1024);
    assert.throws(() => native.writeFileSync(path.join(f.copy, "unreviewed"), "no"), { code: "KEYWORD_SCRATCH_UNSUPPORTED_WRITER" });
    await assert.rejects(fs.copyFile(file, path.join(f.copy, "unreviewed-copy")), { code: "KEYWORD_SCRATCH_UNSUPPORTED_WRITER" });
  } finally { budget.restore(); }
});
test("the combined copy write guard, reference view and budget permit only reviewed private writes", async t => {
  const f = await fixture(t), guard = installGuards(f.copy, { originalOutputs: { root: f.original, files: f.files } }), view = installReadOnlyOutputs({ root: f.original, files: f.files }), budget = installScratchBudget(f.copy, 256 * 1024);
  try { await fs.mkdir(f.original, { recursive: true }); const value = await fs.readFile(f.file); await fs.mkdir(path.join(f.copy, "derived")); await fs.writeFile(path.join(f.copy, "derived/source.json"), value); assert.equal((await view.verify()).bodies.length, 1); assert.equal(guard.metrics.outsideCopyWriteAttempts, 0); }
  finally { budget.restore(); view.restore(); guard.restore(); }
});
