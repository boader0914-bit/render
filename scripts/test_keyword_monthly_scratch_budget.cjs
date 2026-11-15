"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs/promises"), native = require("node:fs"), path = require("node:path"), os = require("node:os"), crypto = require("node:crypto");
const { installScratchBudget } = require("./lib/keyword_monthly_scratch_budget.cjs");
const { installGuards } = require("./reconstruct_keyword_monthly_source_copy.cjs");
const { createStore, sourceStamp } = require("./lib/keyword_monthly_incremental_state.cjs");
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "keyword-scratch-scope-"));
  t.after(async () => { assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)); await fs.rm(root, { recursive: true, force: true }); });
  const namespace = path.join(root, "namespace"), job = path.join(namespace, "jobs", "owned-job"), external = path.join(namespace, "states"), unapproved = path.join(root, "unapproved");
  for (const dir of [job, external, unapproved]) await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  return { root, namespace, job, external, unapproved };
}
function allocation(status) { return [status.allocatedBytes, status.reservedBytes, status.trackedPaths, status.reservationChecks]; }

test("default hard maximum and outside-file denial remain unchanged", async t => {
  const f = await fixture(t); assert.throws(() => installScratchBudget(f.job, 1024 ** 3 + 1), { code: "KEYWORD_SCRATCH_BUDGET_INVALID" });
  const budget = installScratchBudget(f.job);
  try {
    assert.equal(budget.status().maximumBytes, 1024 ** 3); assert.equal(Object.hasOwn(budget.status(), "externalWriteRootCount"), false);
    await assert.rejects(fs.writeFile(path.join(f.external, "outside"), "x"), { code: "KEYWORD_SCRATCH_PATH_INVALID" });
    await assert.rejects(fs.open(path.join(f.external, "outside"), "wx"), { code: "KEYWORD_SCRATCH_PATH_INVALID" });
    // Preserve the existing default mkdir exception; original write guards are
    // responsible for outside-directory admission in the old physical-copy mode.
    await fs.mkdir(path.join(f.unapproved, "legacy-mkdir"));
    assert.throws(() => native.writeFileSync(path.join(f.job, "native"), "x"), { code: "KEYWORD_SCRATCH_UNSUPPORTED_WRITER" });
  } finally { budget.restore(); }
});

test("approved namespace writes outside the job use their own storage budget while inside writes remain capped", async t => {
  const f = await fixture(t), budget = installScratchBudget(f.job, 128 * 1024, { externalWriteRoots: [f.namespace] });
  try {
    const before = allocation(budget.status()), outside = path.join(f.external, "state.bin");
    await fs.writeFile(outside, Buffer.alloc(256 * 1024)); await fs.appendFile(outside, "tail");
    const handle = await fs.open(path.join(f.external, "handle.bin"), "wx"); try { await handle.writeFile(Buffer.alloc(256 * 1024)); await handle.sync(); } finally { await handle.close(); }
    assert.deepEqual(allocation(budget.status()), before);
    const renamed = path.join(f.external, "renamed.bin"); await fs.rename(outside, renamed); await fs.unlink(renamed);
    const dir = path.join(f.external, "temporary"); await fs.mkdir(dir); await fs.writeFile(path.join(dir, "data"), "private"); await fs.rm(dir, { recursive: true });
    const empty = path.join(f.external, "empty"); await fs.mkdir(empty); await fs.rmdir(empty); assert.deepEqual(allocation(budget.status()), before);
    await assert.rejects(fs.writeFile(path.join(f.job, "too-large"), Buffer.alloc(256 * 1024)), { code: "KEYWORD_SCRATCH_HARD_BOUND" });
    await assert.rejects(fs.open(path.join(f.job, "job-handle"), "wx").then(async h => { try { await h.writeFile(Buffer.alloc(256 * 1024)); } finally { await h.close(); } }), { code: "KEYWORD_SCRATCH_HARD_BOUND" });
    assert.ok(budget.status().externalDelegatedOperations > 0); assert.ok(budget.status().peakReservedAndAllocatedBytes <= 128 * 1024);
  } finally { budget.restore(); }
});

test("inside/external and different-external-root renames cannot move files across accounting scopes", async t => {
  const f = await fixture(t), second = path.join(f.namespace, "cache"); await fs.mkdir(second, { mode: 0o700 });
  const a = path.join(f.external, "a"), b = path.join(second, "b"), job = path.join(f.job, "inside"); await fs.writeFile(a, "a"); await fs.writeFile(b, "b"); await fs.writeFile(job, "job");
  const budget = installScratchBudget(f.job, 128 * 1024, { externalWriteRoots: [f.namespace, f.external, second] });
  try {
    for (const [from, to] of [[job, path.join(f.external, "from-job")], [a, path.join(f.job, "from-external")], [a, path.join(second, "from-other-root")]]) {
      await assert.rejects(fs.rename(from, to), { code: "KEYWORD_SCRATCH_CROSS_SCOPE_DENIED" });
    }
    await assert.rejects(fs.rm(f.namespace, { recursive: true }), { code: "KEYWORD_SCRATCH_CROSS_SCOPE_DENIED" });
    await assert.rejects(fs.rename(f.namespace, path.join(f.namespace, "moved")), { code: "KEYWORD_SCRATCH_CROSS_SCOPE_DENIED" });
    assert.equal(await fs.readFile(a, "utf8"), "a"); assert.equal(await fs.readFile(b, "utf8"), "b"); assert.equal(await fs.readFile(job, "utf8"), "job");
  } finally { budget.restore(); }
});

test("unapproved outside writes, directories and deletions remain denied in explicit external mode", async t => {
  const f = await fixture(t), file = path.join(f.unapproved, "preserve"), from = path.join(f.external, "from"); await fs.writeFile(file, "untouched"); await fs.writeFile(from, "from");
  const budget = installScratchBudget(f.job, 128 * 1024, { externalWriteRoots: [f.namespace] });
  try {
    for (const call of [() => fs.writeFile(file, "no"), () => fs.appendFile(file, "no"), () => fs.open(file, "w"), () => fs.unlink(file),
      () => fs.rm(f.unapproved, { recursive: true }), () => fs.rmdir(f.unapproved), () => fs.mkdir(path.join(f.unapproved, "new")), () => fs.rename(from, path.join(f.unapproved, "to"))]) {
      await assert.rejects(call(), { code: "KEYWORD_SCRATCH_PATH_INVALID" });
    }
    assert.equal(await fs.readFile(file, "utf8"), "untouched"); assert.equal(await fs.readFile(from, "utf8"), "from");
  } finally { budget.restore(); }
});

test("standalone approved paths reject symlink parents and hardlinked files before mutation", async t => {
  const f = await fixture(t), original = path.join(f.unapproved, "original"); await fs.writeFile(original, "untouched");
  await fs.link(original, path.join(f.external, "hardlink")); await fs.symlink(f.unapproved, path.join(f.external, "redirect"), process.platform === "win32" ? "junction" : "dir");
  const budget = installScratchBudget(f.job, 128 * 1024, { externalWriteRoots: [f.namespace] });
  try {
    await assert.rejects(fs.writeFile(path.join(f.external, "hardlink"), "no"), { code: "KEYWORD_SCRATCH_EXTERNAL_PATH_UNSAFE" });
    await assert.rejects(fs.open(path.join(f.external, "redirect", "original"), "w"), { code: "KEYWORD_SCRATCH_EXTERNAL_PATH_UNSAFE" });
    await assert.rejects(fs.rm(path.join(f.external, "redirect")), { code: "KEYWORD_SCRATCH_EXTERNAL_PATH_UNSAFE" });
    assert.equal(await fs.readFile(original, "utf8"), "untouched");
  } finally { budget.restore(); }
});

test("invalid or redirected external roots fail before installing any filesystem hooks", async t => {
  const f = await fixture(t), before = fs.writeFile;
  for (const options of [{ externalWriteRoots: ["relative"] }, { externalWriteRoots: [path.parse(f.root).root] }, { externalWriteRoots: "not-array" }, { unknown: [] }]) {
    assert.throws(() => installScratchBudget(f.job, 128 * 1024, options), { code: "KEYWORD_SCRATCH_EXTERNAL_ROOTS_INVALID" }); assert.equal(fs.writeFile, before);
  }
  const link = path.join(f.root, "root-link"); await fs.symlink(f.namespace, link, process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => installScratchBudget(f.job, 128 * 1024, { externalWriteRoots: [link] }), { code: "KEYWORD_SCRATCH_EXTERNAL_PATH_UNSAFE" }); assert.equal(fs.writeFile, before);
});

test("external delegation retains installed original/code read-only guards", async t => {
  const f = await fixture(t), code = path.join(f.root, "code"), originals = path.join(f.root, "originals");
  await fs.mkdir(path.join(code, "scripts", "lib"), { recursive: true, mode: 0o700 }); await fs.mkdir(originals, { mode: 0o700 });
  const codeFile = path.join(code, "scripts", "lib", "inert.cjs"), sourceFile = path.join(originals, "history.jsonl"); await fs.writeFile(codeFile, "module.exports={}"); await fs.writeFile(sourceFile, "original");
  const guard = installGuards(f.namespace, { codeRoot: code, readOnlyRoots: [originals] }), budget = installScratchBudget(f.job, 128 * 1024, { externalWriteRoots: [f.namespace, code, originals] });
  try {
    await assert.rejects(fs.writeFile(codeFile, "no"), { code: "KEYWORD_RECONSTRUCT_OUTSIDE_COPY_WRITE_DENIED" });
    await assert.rejects(fs.open(sourceFile, "w"), { code: "KEYWORD_RECONSTRUCT_OUTSIDE_COPY_WRITE_DENIED" });
    await fs.writeFile(path.join(f.external, "valid.json"), "private"); assert.equal(guard.metrics.outsideCopyWriteAttempts, 2);
    assert.equal(await fs.readFile(codeFile, "utf8"), "module.exports={}"); assert.equal(await fs.readFile(sourceFile, "utf8"), "original");
  } finally { budget.restore(); guard.restore(); }
});

test("the guarded normal delta path persists state outside the job with zero original body reads", async t => {
  const f = await fixture(t), dataDir = path.join(f.root, "data"), masterFile = path.join(dataDir, "company_master", "companies.json"), historyFile = path.join(dataDir, "history", "observations.jsonl");
  await fs.mkdir(path.dirname(masterFile), { recursive: true, mode: 0o700 }); await fs.mkdir(path.dirname(historyFile), { recursive: true, mode: 0o700 });
  await fs.writeFile(masterFile, JSON.stringify({ companies: { a: { companyId: "a", keywords: {}, inventory: {} } } }));
  const row = { companyId: "a", companyKey: "a", runId: "run_1", stayDate: "2026-11-20", sold: 0 }; await fs.writeFile(historyFile, JSON.stringify(row) + "\n");
  const bootstrap = createStore({ dataDir }), current = await bootstrap.bootstrap(), namespace = bootstrap.directory, job = path.join(namespace, "jobs", "owned-job"); await fs.mkdir(job, { recursive: true, mode: 0o700 });
  const before = sourceStamp(await fs.lstat(historyFile, { bigint: true })), nextRow = { ...row, runId: "run_2", sold: 2 }; await fs.appendFile(historyFile, JSON.stringify(nextRow) + "\n");
  const after = sourceStamp(await fs.lstat(historyFile, { bigint: true })), payload = { rows: [nextRow], sourceStamp: { before, after }, indexUpdated: true }, eventId = crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex");
  const store = createStore({ dataDir }), guard = installGuards(namespace, { metadataOnlyFiles: [masterFile, historyFile] }), budget = installScratchBudget(job, 128 * 1024, { externalWriteRoots: [namespace] });
  try {
    const statusBefore = allocation(budget.status()), updated = await store.apply({ current, events: [{ eventId, kind: "history", payload, createdAt: "2026-11-15T00:00:00Z" }] });
    assert.equal(updated.state.history.rows, 2); assert.deepEqual(allocation(budget.status()), statusBefore);
    assert.equal(store.counters.originalMasterBodyReads, 0); assert.equal(store.counters.originalHistoryBodyReads, 0);
    assert.equal(guard.metrics.outsideReadAttempts, 0); assert.equal(guard.metrics.outsideCopyWriteAttempts, 0); assert.equal(budget.status().deniedOperations, 0);
    assert.ok(store.counters.newReservations > 0 && budget.status().externalDelegatedOperations > 0);
  } finally { budget.restore(); guard.restore(); }
});
