"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs/promises"), native = require("node:fs"),
  path = require("node:path"), os = require("node:os"), crypto = require("node:crypto");
const { LIMITS, metadataInventory, verifyInventory, seedDependencies, verifyDependencies } = require("./lib/keyword_monthly_incremental_inputs.cjs");
const { installReadOnlyOutputs } = require("./lib/keyword_monthly_readonly_outputs.cjs");
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "keyword-incremental-inputs-"));
  t.after(async () => { assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); await fs.rm(root, { recursive: true, force: true }); });
  const dataDir = path.join(root, "source"), workDataDir = path.join(root, "private-job/data");
  for (const relative of ["company_master", "history", "outputs/run", "history/kosis", "config"])
    await fs.mkdir(path.join(dataDir, relative), { recursive: true });
  await fs.mkdir(workDataDir, { recursive: true });
  await fs.writeFile(path.join(dataDir, "company_master/companies.json"), '{"companies":{}}');
  await fs.writeFile(path.join(dataDir, "history/observations.jsonl"), "{}");
  await fs.writeFile(path.join(dataDir, "outputs/run/manifest.json"), '{"keyword":"fixture"}');
  await fs.writeFile(path.join(dataDir, "history/kosis/forbidden.json"), '{"not":"an input"}');
  await fs.writeFile(path.join(dataDir, "config/forbidden.json"), '{"not":"an input"}');
  return { root, dataDir, workDataDir };
}
function denyBodies(dataDir) {
  const paths = [path.join(dataDir, "company_master/companies.json"), path.join(dataDir, "history/observations.jsonl")];
  const outputRoot = path.join(dataDir, "outputs") + path.sep, restore = []; let attempts = 0;
  for (const [object, name] of [[fs, "open"], [fs, "readFile"], [native, "readFileSync"], [native, "createReadStream"]]) {
    const original = object[name]; object[name] = (...args) => {
      if (typeof args[0] === "string" && (paths.includes(args[0]) || args[0].startsWith(outputRoot))) { attempts++; assert.fail("metadata path opened a source body"); }
      return original.apply(object, args);
    }; restore.push(() => { object[name] = original; });
  }
  return { attempts: () => attempts, restore: () => { for (const operation of restore.reverse()) operation(); } };
}

test("metadata inventory pins the exact output view without source bodies or unrelated traversal", async t => {
  const f = await fixture(t), guard = denyBodies(f.dataDir), original = fs.readdir, traversed = [];
  fs.readdir = async (file, ...args) => { traversed.push(file); return original(file, ...args); };
  let inventory;
  try {
    inventory = await metadataInventory({ dataDir: f.dataDir });
    assert.equal((await verifyInventory({ dataDir: f.dataDir, expected: inventory })).preserved, true);
    assert.equal(guard.attempts(), 0);
    assert.ok(traversed.every(directory => directory === path.join(f.dataDir, "outputs") || directory.startsWith(path.join(f.dataDir, "outputs") + path.sep)));
  } finally { fs.readdir = original; guard.restore(); }
  assert.deepEqual(inventory.outputs.files.map(row => row.relative), ["run/manifest.json"]);
  assert.deepEqual(inventory.outputs.directories.map(row => row.relative), ["", "run"]);
  assert.equal(inventory.sourceFiles.length, 2);
  for (const source of inventory.sourceFiles) for (const key of ["dev", "ino", "size", "mtimeNs", "ctimeNs", "nlink"]) assert.equal(typeof source.stamp[key], "string");
  const view = installReadOnlyOutputs(inventory.outputs);
  try { assert.equal(JSON.parse(await fs.readFile(path.join(f.dataDir, "outputs/run/manifest.json"), "utf8")).keyword, "fixture"); }
  finally { view.restore(); }
});

test("growing source history above 512 MiB remains metadata-only and does not raise output copy bounds", async t => {
  const f = await fixture(t), file = path.join(f.dataDir, "history/observations.jsonl"), bytes = 513 * 1024 ** 2;
  await fs.truncate(file, bytes);
  const guard = denyBodies(f.dataDir);
  try {
    const inventory = await metadataInventory({ dataDir: f.dataDir });
    assert.equal(inventory.sourceFiles.find(row => row.relative === "history/observations.jsonl").bytes, bytes);
    assert.equal(guard.attempts(), 0);
    assert.equal(LIMITS.fileBytes, 512 * 1024 ** 2);
    assert.equal(LIMITS.bytes, 4 * 1024 ** 3);
  } finally { guard.restore(); }
});

test("metadata verification rejects changed source files, output bodies and directory membership", async t => {
  const f = await fixture(t);
  let inventory = await metadataInventory({ dataDir: f.dataDir });
  await fs.appendFile(path.join(f.dataDir, "history/observations.jsonl"), "\n{}");
  await assert.rejects(verifyInventory({ dataDir: f.dataDir, expected: inventory }), { code: "KEYWORD_INCREMENTAL_INPUTS_CHANGED" });
  inventory = await metadataInventory({ dataDir: f.dataDir });
  await fs.writeFile(path.join(f.dataDir, "outputs/run/manifest.json"), '{"keyword":"changed"}');
  await assert.rejects(verifyInventory({ dataDir: f.dataDir, expected: inventory }), { code: "KEYWORD_INCREMENTAL_INPUTS_CHANGED" });
  inventory = await metadataInventory({ dataDir: f.dataDir });
  await fs.writeFile(path.join(f.dataDir, "outputs/run/new.json"), "{}");
  await assert.rejects(verifyInventory({ dataDir: f.dataDir, expected: inventory }), { code: "KEYWORD_INCREMENTAL_INPUTS_CHANGED" });
});

test("output bounds, hardlinks and mid-list publication fail closed", async t => {
  const f = await fixture(t);
  await assert.rejects(metadataInventory({ dataDir: f.dataDir, limits: { manifestBytes: 1 } }), { code: "KEYWORD_INCREMENTAL_MANIFEST_BOUND" });
  await assert.rejects(metadataInventory({ dataDir: f.dataDir, limits: { depth: 1 } }), { code: "KEYWORD_INCREMENTAL_INPUT_DEPTH_BOUND" });
  await assert.rejects(metadataInventory({ dataDir: f.dataDir, limits: { fileBytes: LIMITS.fileBytes + 1 } }), { code: "KEYWORD_INCREMENTAL_INPUT_LIMITS_INVALID" });
  const manifest = path.join(f.dataDir, "outputs/run/manifest.json"), link = path.join(f.dataDir, "outputs/run/linked.json");
  await fs.link(manifest, link);
  await assert.rejects(metadataInventory({ dataDir: f.dataDir }), { code: "KEYWORD_COPY_PATH_INVALID" });
  await fs.unlink(link);
  const original = fs.readdir; let changed = false;
  fs.readdir = async (directory, ...args) => {
    const rows = await original(directory, ...args);
    if (!changed && directory === path.join(f.dataDir, "outputs/run")) { changed = true; await fs.writeFile(path.join(directory, "during-list.json"), "{}"); }
    return rows;
  };
  try { await assert.rejects(metadataInventory({ dataDir: f.dataDir }), { code: "KEYWORD_INCREMENTAL_INPUTS_CHANGED" }); }
  finally { fs.readdir = original; }
});

test("seed copies only exact oracle dependencies, preserves bytes and never overwrites a prior job seed", async t => {
  const f = await fixture(t);
  for (const relative of ["company_integrated", "history/special_days", "history/saved_product_recoveries/nested"]) await fs.mkdir(path.join(f.dataDir, relative), { recursive: true });
  const values = { "company_integrated/capacity-bases.json": '{"schemaVersion":1,"companies":{}}',
    "history/special_days/2026.json": '{"year":2026}', "history/saved_product_recoveries/nested/proof.json": '{"verified":true}' };
  for (const [relative, body] of Object.entries(values)) await fs.writeFile(path.join(f.dataDir, relative), body);
  const guard = denyBodies(f.dataDir); let result;
  try { result = await seedDependencies(f); assert.equal(guard.attempts(), 0); }
  finally { guard.restore(); }
  assert.deepEqual(result.copied.map(row => row.relative).sort(), Object.keys(values).sort());
  assert.equal(result.preserved, true); assert.equal(result.sourceWrites, 0);
  const originalOpen = fs.open, originalRead = fs.readFile;
  const rejectSourceBody = original => (file, ...args) => {
    if (typeof file === "string" && file.startsWith(f.dataDir + path.sep)) assert.fail("verification opened an original dependency body");
    return original(file, ...args);
  };
  fs.open = rejectSourceBody(originalOpen); fs.readFile = rejectSourceBody(originalRead);
  try { assert.equal((await verifyDependencies({ seeded: result, dataDir: f.dataDir })).preserved, true); }
  finally { fs.open = originalOpen; fs.readFile = originalRead; }
  for (const row of result.copied) {
    assert.equal(row.sha256, hash(Buffer.from(values[row.relative])));
    assert.equal(await fs.readFile(path.join(f.dataDir, row.relative), "utf8"), values[row.relative]);
    assert.equal(await fs.readFile(path.join(f.workDataDir, row.relative), "utf8"), values[row.relative]);
  }
  await assert.rejects(fs.access(path.join(f.workDataDir, "history/kosis")), { code: "ENOENT" });
  await assert.rejects(fs.access(path.join(f.workDataDir, "company_master")), { code: "ENOENT" });
  await assert.rejects(seedDependencies(f), { code: "EEXIST" });
  assert.equal(await fs.readFile(path.join(f.workDataDir, "history/special_days/2026.json"), "utf8"), values["history/special_days/2026.json"]);
  await fs.appendFile(path.join(f.dataDir, "history/special_days/2026.json"), " ");
  await assert.rejects(verifyDependencies({ seeded: result, dataDir: f.dataDir }), { code: "KEYWORD_INCREMENTAL_INPUTS_CHANGED" });
});

test("seed absence and byte bounds are explicit and source files remain untouched", async t => {
  const f = await fixture(t), absent = await seedDependencies(f);
  assert.equal(absent.copied.length, 0);
  assert.ok(absent.roots.every(row => row.present === false));
  await fs.mkdir(path.join(f.dataDir, "company_integrated"));
  await fs.writeFile(path.join(f.dataDir, "company_integrated/capacity-bases.json"), "12345");
  await assert.rejects(verifyDependencies({ seeded: absent, dataDir: f.dataDir }), { code: "KEYWORD_INCREMENTAL_INPUTS_CHANGED" });
  await assert.rejects(seedDependencies({ ...f, limits: { seedFileBytes: 4 } }), { code: "KEYWORD_INCREMENTAL_INPUT_FILE_BOUND" });
  await assert.rejects(seedDependencies({ ...f, limits: { seedBytes: 4 } }), { code: "KEYWORD_INCREMENTAL_SEED_TOTAL_BOUND" });
  assert.equal(await fs.readFile(path.join(f.dataDir, "company_integrated/capacity-bases.json"), "utf8"), "12345");
  await assert.rejects(seedDependencies({ dataDir: f.dataDir, workDataDir: f.dataDir }), { code: "KEYWORD_INCREMENTAL_SEED_TARGET_INVALID" });
});
