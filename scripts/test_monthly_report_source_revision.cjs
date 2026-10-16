"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createMonthlyReportSourceRevision } = require("./lib/monthly_report_source_revision.cjs");

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "monthly-source-revision-"));
  t.after(async () => {
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
    await fs.rm(root, { recursive: true, force: true });
  });
  const write = async (name, contents = "{}") => {
    const file = path.join(root, name);
    await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, contents);
    return file;
  };
  return { root, write, options: { dataDir: root, regionMasterFile: path.join(root, "region-master.json"), tourismRegionMapFile: path.join(root, "tourism-map.json") } };
}

test("unchanged saved files have a stable revision without reading large observation bodies", async t => {
  const { write, options } = await fixture(t);
  await write("history/observations.jsonl", '{"publicBookings":0}\n{bad\n');
  await write("outputs/odd-recovered-company-run/deep/details/product.json", '{"count":0}');
  let reads = 0;
  const fileSystem = { ...fs, readFile: async () => { reads++; throw new Error("not allowed"); } };
  const revision = createMonthlyReportSourceRevision({ ...options, fileSystem });
  const before = await revision({ month: "2026-09" });
  assert.match(before, /^[a-f0-9]{64}$/);
  assert.equal(await revision({ month: "2026-10" }), before, "request scope belongs to the aggregate key, not the source token");
  assert.equal(reads, 0, "revision metadata does not parse, alter, or replace unknown/zero observations");
});

test("DB review, history, capacity bases and reference edits invalidate saved aggregates", async t => {
  const { write, options } = await fixture(t);
  const revision = createMonthlyReportSourceRevision(options);
  const paths = ["company_master/companies.json", "history/observations.jsonl", "company_integrated/capacity-bases.json",
    "region-master.json", "tourism-map.json", "history/special_days/special-days-2026.json"];
  let before = await revision();
  for (const name of paths) {
    await write(name, JSON.stringify({ changed: name }));
    const after = await revision();
    assert.notEqual(after, before, `new ${name} is included`); before = after;
    await write(name, JSON.stringify({ edited: name }));
    const edited = await revision();
    assert.notEqual(edited, before, `edit ${name} is included`); before = edited;
  }
});

test("checks edited run body inside an unchanged parent folder, replacements and deletions", async t => {
  const { root, write, options } = await fixture(t);
  const file = await write("outputs/legacy-run/details/stock.json", '{"stock":1}');
  const directory = path.dirname(file), initialDirectory = await fs.stat(directory);
  const fixed = new Date("2020-01-01T00:00:00Z");
  await fs.utimes(file, fixed, fixed);
  const revision = createMonthlyReportSourceRevision(options), before = await revision();
  await new Promise(resolve => setTimeout(resolve, 5));
  await fs.writeFile(file, '{"stock":2}'); await fs.utimes(file, fixed, fixed);
  await fs.utimes(directory, initialDirectory.atime, initialDirectory.mtime);
  const changed = await revision();
  assert.notEqual(changed, before, "same length and restored mtime still changes ctime");
  await write("outputs/legacy-run/details/replacement.tmp", '{"stock":3}');
  await fs.rename(path.join(directory, "replacement.tmp"), file);
  const replaced = await revision(); assert.notEqual(replaced, changed, "atomic replacement is checked");
  await fs.unlink(file); assert.notEqual(await revision(), replaced, "removed body is not reused");
  assert.ok(path.resolve(file).startsWith(path.resolve(root) + path.sep));
});

test("saved API context changes are checked by default and can be read fresh outside the aggregate cache", async t => {
  const { write, options } = await fixture(t);
  const full = createMonthlyReportSourceRevision(options), lodgingOnly = createMonthlyReportSourceRevision({ ...options, includeContext: false });
  let fullBefore = await full(); const housingBefore = await lodgingOnly();
  for (const name of ["history/kosis/region-attempt.json", "tourism_data/cache/visitor.json", "regional_search_trends/cache/keyword.json", "regional_search_trends/status.json"]) {
    await write(name);
    const after = await full(); assert.notEqual(after, fullBefore, name); fullBefore = after;
    assert.equal(await lodgingOnly(), housingBefore, "fresh context attachment avoids invalidating lodging calculations");
  }
  await write("history/special_days/special-days-2026.json");
  assert.notEqual(await lodgingOnly(), housingBefore, "holidays affect lodging calendar classification and remain in the base revision");
});

test("new files are detected in existing directories and temporary writes are not stored-source changes", async t => {
  const { write, options } = await fixture(t);
  await write("outputs/run/manifest.json");
  const revision = createMonthlyReportSourceRevision(options), before = await revision();
  await write("outputs/run/details-uncommitted.json.tmp"); assert.equal(await revision(), before);
  await write("outputs/run/new-source.csv", "a,b\n1,2"); assert.notEqual(await revision(), before);
});

test("metadata errors or unsafe symlinks do not certify that cached values are current", async t => {
  const { write, options } = await fixture(t);
  await write("company_master/companies.json");
  const failedFs = { ...fs, lstat: async (file, input) => {
    if (file.endsWith("companies.json")) throw Object.assign(new Error("mock permission"), { code: "EACCES" });
    return fs.lstat(file, input);
  } };
  await assert.rejects(createMonthlyReportSourceRevision({ ...options, fileSystem: failedFs })(),
    error => error.code === "MONTHLY_SOURCE_REVISION_UNAVAILABLE" && error.statusCode === 503);
  const linkedFs = { ...fs, lstat: async (file, input) => {
    const value = await fs.lstat(file, input);
    return file.endsWith("companies.json") ? { ...value, isFile: () => false, isSymbolicLink: () => true } : value;
  } };
  await assert.rejects(createMonthlyReportSourceRevision({ ...options, fileSystem: linkedFs })(),
    error => error.code === "MONTHLY_SOURCE_REVISION_UNAVAILABLE");
});

test("filesystem metadata work is bounded and directory mutation during inspection is rejected", async t => {
  const { write, options } = await fixture(t);
  for (let index = 0; index < 20; index++) await write(`outputs/run${index}/details/stock.json`);
  let active = 0, maximum = 0;
  const boundedFs = Object.fromEntries(["lstat", "readdir"].map(method => [method, async (...args) => {
    active++; maximum = Math.max(maximum, active);
    try { await new Promise(resolve => setImmediate(resolve)); return await fs[method](...args); } finally { active--; }
  }]));
  await createMonthlyReportSourceRevision({ ...options, fileSystem: boundedFs, metadataConcurrency: 3 })();
  assert.ok(maximum <= 3); assert.ok(maximum > 1);
  let altered = false;
  const changingFs = { ...fs, readdir: async (directory, input) => {
    const rows = await fs.readdir(directory, input);
    if (!altered && directory.endsWith(`${path.sep}run0`)) { altered = true; await fs.writeFile(path.join(directory, "arrived.json"), "{}"); }
    return rows;
  } };
  await assert.rejects(createMonthlyReportSourceRevision({ ...options, fileSystem: changingFs })(),
    error => error.code === "MONTHLY_SOURCE_REVISION_UNAVAILABLE");
});
