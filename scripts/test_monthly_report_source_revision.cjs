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

test("reuses unchanged directory inventories while checking every source file and directory again", async t => {
  const { write, options } = await fixture(t);
  const stock = await write("outputs/run/details/stock.json", '{"stock":1}');
  const company = await write("company_master/companies.json");
  let listings = 0; const checked = [];
  const fileSystem = { ...fs, readdir: async (...args) => { listings++; return fs.readdir(...args); },
    lstat: async (...args) => { checked.push(args[0]); return fs.lstat(...args); } };
  const revision = createMonthlyReportSourceRevision({ ...options, fileSystem });
  const before = await revision(); assert.ok(listings >= 3);
  listings = 0; checked.length = 0;
  assert.equal(await revision({ month: "2026-09" }), before);
  assert.equal(listings, 0, "cached path lists remove repeated readdir operations");
  assert.equal(checked.filter(file => file === stock).length, 1, "file metadata is never cached");
  assert.equal(checked.filter(file => file === company).length, 1);
  assert.equal(checked.filter(file => file === path.dirname(stock)).length, 2, "directory is checked before and after its entries");
  await fs.writeFile(stock, '{"stock":2}');
  assert.notEqual(await revision(), before, "same-size body edits inside an unchanged cached directory are detected");
  assert.equal(listings, 0, "file edits do not require re-listing the directory");
});

test("cached inventories re-list changed directories for added, deleted, replaced and temporary entries", async t => {
  const { root, write, options } = await fixture(t);
  await write("outputs/run/manifest.json");
  let listings = 0;
  const fileSystem = { ...fs, readdir: async (...args) => { listings++; return fs.readdir(...args); } };
  const revision = createMonthlyReportSourceRevision({ ...options, fileSystem });
  const before = await revision(); listings = 0;
  await write("outputs/run/snapshot.json.tmp");
  assert.equal(await revision(), before); assert.ok(listings > 0, "temporary files still cause a safe inventory refresh");
  listings = 0; assert.equal(await revision(), before); assert.equal(listings, 0);
  const newFile = await write("outputs/run/new-deep/product/stock.csv", "stock\n1");
  const added = await revision(); assert.notEqual(added, before);
  await fs.unlink(newFile);
  const deleted = await revision(); assert.notEqual(deleted, added);
  await write("outputs/run/replacement.tmp", '{"replaced":true}');
  await fs.rename(path.join(root, "outputs/run/replacement.tmp"), path.join(root, "outputs/run/manifest.json"));
  assert.notEqual(await revision(), deleted);
});

test("restoring a cached directory's mtime does not hide a new source or a directory replacement", async t => {
  const { root, write, options } = await fixture(t);
  const source = await write("outputs/run/stock.json");
  const directory = path.dirname(source), initial = await fs.stat(directory);
  const revision = createMonthlyReportSourceRevision(options), before = await revision();
  await write("outputs/run/extra.json", '{"stock":2}');
  await fs.utimes(directory, initial.atime, initial.mtime);
  const added = await revision(); assert.notEqual(added, before, "directory ctime still requires re-enumeration");
  await fs.rename(directory, path.join(root, "outputs/moved-run"));
  await write("outputs/run/stock.json", '{"replacement":true}');
  await fs.utimes(directory, initial.atime, initial.mtime);
  assert.notEqual(await revision(), added, "new directory identity does not inherit the old name's entries");
});

test("cached inventories do not bypass metadata failures, unsafe replacements or changed directory permissions", async t => {
  const { write, options } = await fixture(t);
  const source = await write("outputs/run/stock.json");
  const directory = path.dirname(source);
  let failFile = false, linkedFile = false, denyDirectory = false, listings = 0;
  const fileSystem = { ...fs, lstat: async (file, input) => {
    if (file === source && failFile) throw Object.assign(new Error("permission"), { code: "EACCES" });
    const value = await fs.lstat(file, input);
    if (file === source && linkedFile) return { ...value, isFile: () => false, isSymbolicLink: () => true };
    // A permission change updates directory metadata before readdir becomes
    // unavailable; matching only its name or mtime would incorrectly reuse it.
    if (file === directory && denyDirectory) return Object.assign(Object.create(value), { mode: value.mode ^ 1n });
    return value;
  }, readdir: async (file, input) => {
    listings++;
    if (file === directory && denyDirectory) throw Object.assign(new Error("permission"), { code: "EACCES" });
    return fs.readdir(file, input);
  } };
  const revision = createMonthlyReportSourceRevision({ ...options, fileSystem });
  const before = await revision();
  failFile = true;
  await assert.rejects(revision(), error => error.code === "MONTHLY_SOURCE_REVISION_UNAVAILABLE");
  failFile = false; listings = 0;
  assert.equal(await revision(), before); assert.ok(listings > 0, "failure discards inventories before recovery");
  linkedFile = true;
  await assert.rejects(revision(), error => error.code === "MONTHLY_SOURCE_REVISION_UNAVAILABLE");
  linkedFile = false; assert.equal(await revision(), before);
  denyDirectory = true;
  await assert.rejects(revision(), error => error.code === "MONTHLY_SOURCE_REVISION_UNAVAILABLE");
});

test("directory inventory cache is bounded and can be disabled without changing revisions", async t => {
  const { write, options } = await fixture(t);
  await write("outputs/run/details/stock.json");
  const expected = await createMonthlyReportSourceRevision({ ...options, maxCachedDirectories: 0 })();
  for (const limits of [{ maxCachedDirectories: 1 }, { maxCachedEntries: 1 }, { maxCachedEntries: 0 }]) {
    let listings = 0;
    const revision = createMonthlyReportSourceRevision({ ...options, ...limits,
      fileSystem: { ...fs, readdir: async (...args) => { listings++; return fs.readdir(...args); } } });
    assert.equal(await revision(), expected); listings = 0;
    assert.equal(await revision(), expected); assert.ok(listings > 0, "bounded or disabled cache falls back to fresh listings");
  }
  assert.throws(() => createMonthlyReportSourceRevision({ ...options, maxCachedDirectories: -1 }), TypeError);
  assert.throws(() => createMonthlyReportSourceRevision({ ...options, maxCachedEntries: 0.5 }), TypeError);
});

test("a directory mutation during a warm inventory scan is rejected without trusting cached entries", async t => {
  const { write, options } = await fixture(t);
  const source = await write("outputs/run/stock.json");
  const directory = path.dirname(source);
  let mutate = false, listings = 0;
  const fileSystem = { ...fs, lstat: async (file, input) => {
    const value = await fs.lstat(file, input);
    if (file === directory && mutate) {
      mutate = false;
      await fs.writeFile(path.join(directory, "arrived-during-inspection.json"), "{}");
    }
    return value;
  }, readdir: async (...args) => { listings++; return fs.readdir(...args); } };
  const revision = createMonthlyReportSourceRevision({ ...options, fileSystem });
  const before = await revision(); listings = 0;
  mutate = true;
  await assert.rejects(revision(), error => error.code === "MONTHLY_SOURCE_REVISION_UNAVAILABLE");
  assert.equal(listings, 0, "the post-scan metadata check detects mutation even when no readdir was needed");
  assert.notEqual(await revision(), before, "retry enumerates the new source and returns its changed revision");
});

test("same-batch readers share an inspection but callers arriving during it receive a later fresh scan", async t => {
  const { write, options } = await fixture(t);
  const source = await write("outputs/run/stock.json", '{"stock":1}');
  let hold = false, release, entered;
  let inspected = 0;
  const atSource = new Promise(resolve => { entered = resolve; });
  const sourceGate = new Promise(resolve => { release = resolve; });
  const fileSystem = { ...fs, lstat: async (file, input) => {
    const value = await fs.lstat(file, input);
    if (file === source) {
      inspected++;
      if (hold) { hold = false; entered(); await sourceGate; }
    }
    return value;
  } };
  const revision = createMonthlyReportSourceRevision({ ...options, fileSystem });
  const before = await revision(); inspected = 0;
  const initial = await Promise.all([revision(), revision(), revision()]);
  assert.deepEqual(initial, [before, before, before]);
  assert.equal(inspected, 1, "readers present before scan start share the filesystem work");
  hold = true; inspected = 0;
  const early = revision(); await atSource;
  await fs.writeFile(source, '{"stock":22}');
  const late = revision(); release();
  assert.equal(await early, before, "first scan retains the metadata already observed");
  assert.notEqual(await late, before, "late reader cannot inherit pre-request metadata");
  assert.equal(inspected, 2);
});

test("failed inspections drain pending metadata before a new reader starts and recover without stale lists", async t => {
  const { write, options } = await fixture(t);
  const first = await write("outputs/first/stock.json");
  const second = await write("outputs/second/stock.json");
  let shouldFail = true, firstFailed, secondEntered, releaseSecond, callsAfterFailure = 0;
  const atFailure = new Promise(resolve => { firstFailed = resolve; });
  const atSecond = new Promise(resolve => { secondEntered = resolve; });
  const secondGate = new Promise(resolve => { releaseSecond = resolve; });
  const fileSystem = { ...fs, lstat: async (file, input) => {
    if (file === first && shouldFail) { firstFailed(); throw Object.assign(new Error("denied"), { code: "EACCES" }); }
    if (file === second && shouldFail) { secondEntered(); await secondGate; }
    if (!shouldFail && file === second) callsAfterFailure++;
    return fs.lstat(file, input);
  } };
  const revision = createMonthlyReportSourceRevision({ ...options, fileSystem });
  const firstRead = revision();
  const failure = assert.rejects(firstRead, error => error.code === "MONTHLY_SOURCE_REVISION_UNAVAILABLE");
  await Promise.all([atFailure, atSecond]);
  const nextRead = revision();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(callsAfterFailure, 0);
  shouldFail = false; releaseSecond();
  await failure;
  assert.match(await nextRead, /^[a-f0-9]{64}$/);
  assert.equal(callsAfterFailure, 2, "pending first-scan metadata finishes before the later inspection");
});
