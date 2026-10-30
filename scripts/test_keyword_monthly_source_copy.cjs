"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs/promises"), path = require("node:path"), os = require("node:os"), crypto = require("node:crypto");
const { inventory, inspect, copy } = require("./lib/keyword_monthly_source_copy.cjs");
const { args, run } = require("./export_keyword_monthly_source_copy.cjs");
const sha = b => crypto.createHash("sha256").update(b).digest("hex");
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "keyword-source-test-")); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, "source");
  const bodies = { "company_master/companies.json": '{"companies":{"cmp_place_1":{"companyId":"cmp_place_1"}}}', "history/observations.jsonl": '{"companyKey":"cmp_place_1","stayDate":"2026-10-01"}\n',
    "company_integrated/capacity-bases.json": '{"schemaVersion":1,"companies":{}}', "outputs/saved_run/manifest.json": '{"id":"saved_run"}',
    "history/indexes/observations.sqlite": "do-not-copy-existing-index", "history/kosis/private.json": "do-not-read-kosis", "config/auth.json": "do-not-copy-auth", "customer_db/ledger.json": "do-not-copy-customers" };
  for (const [name, body] of Object.entries(bodies)) { const file = path.join(source, ...name.split("/")); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, body); }
  return { root, source, bodies };
}
test("inspection inventories exact saved inputs and never copies indexes, KOSIS, config or customer data", async t => {
  const f = await fixture(t), result = await inspect({ sourceDataDir: f.source, scratchParent: f.root, includePrepared: false });
  assert.equal(result.fileCount, 4); assert.equal(result.sourceWrites, 0); assert.equal(result.copiedFiles, 0);
  assert.deepEqual(result.files.map(x => x.relative).sort(), ["company_integrated/capacity-bases.json", "company_master/companies.json", "history/observations.jsonl", "outputs/saved_run/manifest.json"]);
  assert.equal(result.canCopyWithReserve, true); assert.equal(result.historyIndexCopied, false);
});
test("capture uses new physical files, verifies independent readback and preserves every source byte", async t => {
  const f = await fixture(t), inspection = await inspect({ sourceDataDir: f.source, scratchParent: f.root, includePrepared: false });
  const destination = path.join(f.root, "keyword-monthly-source-12345678"), result = await copy({ sourceDataDir: f.source, includePrepared: false, inspection, copyRoot: destination });
  assert.equal(result.state, "complete"); assert.equal(result.sourcePreserved, true); assert.equal(result.fileCount, 4);
  const manifest = JSON.parse(await fs.readFile(path.join(destination, "control/capture-complete.json")));
  for (const row of manifest.inputFiles) {
    const source = path.join(f.source, ...row.relative.split("/")), target = path.join(destination, "data", ...row.relative.split("/"));
    assert.equal(sha(await fs.readFile(source)), row.sha256); assert.equal(sha(await fs.readFile(target)), row.sha256);
    assert.notEqual((await fs.stat(source)).ino, (await fs.stat(target)).ino); assert.equal(row.physicalCopy, true);
    // Keep fixture cleanup possible on Windows after the read-only capture assertion.
    await fs.chmod(target, 0o600);
  }
  for (const [name, body] of Object.entries(f.bodies)) assert.equal(await fs.readFile(path.join(f.source, ...name.split("/")), "utf8"), body);
  await assert.rejects(fs.stat(path.join(destination, "data/history/indexes/observations.sqlite")), { code: "ENOENT" });
  await assert.rejects(copy({ sourceDataDir: f.source, includePrepared: false, inspection, copyRoot: destination }), { code: "EEXIST" });
});
test("an edit after inspection fails before target creation and never replaces the original", async t => {
  const f = await fixture(t), inspection = await inspect({ sourceDataDir: f.source, includePrepared: false });
  await fs.appendFile(path.join(f.source, "history/observations.jsonl"), "{}\n");
  const destination = path.join(f.root, "keyword-monthly-source-abcdefgh");
  await assert.rejects(copy({ sourceDataDir: f.source, includePrepared: false, inspection, copyRoot: destination }), { code: "KEYWORD_COPY_SOURCE_CHANGED" });
  await assert.rejects(fs.stat(destination), { code: "ENOENT" });
});
test("active temporary publications fail closed instead of omitting a possibly changing run", async t => {
  const f = await fixture(t); await fs.writeFile(path.join(f.source, "outputs/saved_run/manifest.json.tmp"), "partial");
  await assert.rejects(inventory({ sourceDataDir: f.source, includePrepared: false }), { code: "KEYWORD_COPY_SOURCE_PUBLICATION_IN_PROGRESS" });
});
test("source symlinks and non-private target scopes are rejected", async t => {
  const f = await fixture(t), destination = path.join(f.root, "keyword-monthly-source-abcdefgh");
  await fs.symlink(path.join(f.source, "history"), path.join(f.source, "outputs/link"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(inventory({ sourceDataDir: f.source, includePrepared: false }), { code: "KEYWORD_COPY_SYMLINK_DENIED" });
  await fs.unlink(path.join(f.source, "outputs/link")); const inspection = await inspect({ sourceDataDir: f.source, includePrepared: false });
  await assert.rejects(copy({ sourceDataDir: f.source, includePrepared: false, inspection, copyRoot: path.join(f.source, "operations/keyword-monthly-source-abcdefgh") }), { code: "KEYWORD_COPY_TARGET_INVALID" });
  assert.equal((await fs.stat(f.source)).isDirectory(), true); await assert.rejects(fs.stat(destination), { code: "ENOENT" });
});
test("strict resource limits and malformed prepared pointers stop without a fallback mutation", async t => {
  const f = await fixture(t);
  await assert.rejects(inventory({ sourceDataDir: f.source, includePrepared: false, limits: { bytes: 1 } }), { code: "KEYWORD_COPY_TOTAL_BOUND" });
  const pointer = path.join(f.source, "monthly_reports/company_sources/current.json"); await fs.mkdir(path.dirname(pointer), { recursive: true }); await fs.writeFile(pointer, '{"generation":"../../config"}');
  await assert.rejects(inventory({ sourceDataDir: f.source }), { code: "KEYWORD_COPY_PREPARED_POINTER_INVALID" });
});
test("CLI inspect requires absolute scope and cannot create a receipt in original source namespaces", async t => {
  const f = await fixture(t); assert.throws(() => args(["--mode", "copy", "--source-data", f.source]), /INSPECTION/);
  await assert.rejects(run(["--mode", "inspect", "--source-data", f.source, "--include-prepared", "false", "--output", path.join(f.source, "outputs/new-receipt.json")]), /RECEIPT_PATH/);
  await assert.rejects(fs.stat(path.join(f.source, "outputs/new-receipt.json")), { code: "ENOENT" });
});
