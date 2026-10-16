"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createMonthlyReportSelectorRevision } = require("./lib/monthly_report_selector_revision.cjs");

const runName = "gyeongnam_glamping_20261016_090000";
const isUnavailable = error => error.code === "MONTHLY_SOURCE_REVISION_UNAVAILABLE" && error.statusCode === 503;
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "monthly-selector-revision-"));
  t.after(async () => {
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
    await fs.rm(root, { recursive: true, force: true });
  });
  const write = async (name, contents = "{}") => {
    const file = path.join(root, name);
    await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, contents);
    return file;
  };
  return { root, write, options: { dataDir: root, regionMasterFile: path.join(root, "regions.json") } };
}

test("selector checks never read bodies, stat booking files or descend into unrelated output directories", async t => {
  const { root, write, options } = await fixture(t);
  const master = await write("company_master/companies.json", '{"companies":{}}');
  await write("history/observations.jsonl", '{"stayDate":"2026-09-01","sold":0}\n{bad\n');
  const manifest = await write("outputs/" + runName + "/manifest.json", '{"keyword":"경남글램핑"}');
  const booking = await write("outputs/" + runName + "/booking.json", '{"stock":1}');
  const nested = await write("outputs/" + runName + "/details/product/stock.json", '{"stock":1}');
  await write("outputs/unrelated-archive/manifest.json");
  await write("history/special_days/2026.json");
  const checked = [], listed = [];
  const fileSystem = { ...fs, readFile: async () => assert.fail("selector revision must never parse source bodies"),
    lstat: async (...args) => { checked.push(args[0]); return fs.lstat(...args); },
    readdir: async (...args) => { listed.push(args[0]); return fs.readdir(...args); } };
  const revision = createMonthlyReportSelectorRevision({ ...options, fileSystem });
  const before = await revision(); assert.match(before, /^[a-f0-9]{64}$/);
  checked.length = 0; listed.length = 0;
  assert.equal(await revision(), before);
  assert.deepEqual(listed.sort(), [path.join(root, "outputs"), path.join(root, "outputs", runName)].sort(),
    "every call rechecks only the two shallow catalog directories");
  assert.equal(checked.filter(file => file === master).length, 1);
  assert.equal(checked.filter(file => file === manifest).length, 1, "manifest metadata is never cached");
  assert.equal(checked.filter(file => file === path.dirname(manifest)).length, 2);
  assert.ok(!checked.includes(booking)); assert.ok(!checked.includes(nested));
  assert.ok(!checked.some(file => file.includes("unrelated-archive") || file.includes("special_days")));
  await fs.writeFile(booking, '{"stock":2}'); await fs.writeFile(nested, '{"stock":2}');
  assert.equal(await revision(), before, "booking bodies do not change company/keyword/month selectors");
  await write("outputs/" + runName + "/replacement.tmp", '{"stock":3}');
  await fs.rename(path.join(root, "outputs/" + runName + "/replacement.tmp"), booking);
  assert.equal(await revision(), before, "same-name booking replacement does not invalidate selector data");
});

test("company corrections, history months and region references invalidate selectors without parsing their contents", async t => {
  const { write, options } = await fixture(t);
  const revision = createMonthlyReportSelectorRevision(options);
  let before = await revision();
  for (const name of ["company_master/companies.json", "history/observations.jsonl", "regions.json"]) {
    const file = await write(name, JSON.stringify({ added: name }));
    const added = await revision(); assert.notEqual(added, before, "new " + name); before = added;
    await fs.writeFile(file, JSON.stringify({ review: name }));
    const changed = await revision(); assert.notEqual(changed, before, "edited " + name); before = changed;
    await fs.unlink(file);
    const removed = await revision(); assert.notEqual(removed, before, "removed " + name); before = removed;
  }
});

test("manifest edits under an unchanged parent, atomic replacements, removals and late additions are detected", async t => {
  const { root, write, options } = await fixture(t);
  const file = await write("outputs/" + runName + "/manifest.json", '{"keyword":"A"}');
  const directory = path.dirname(file), initialDirectory = await fs.stat(directory), fixed = new Date("2020-01-01T00:00:00Z");
  await fs.utimes(file, fixed, fixed);
  const revision = createMonthlyReportSelectorRevision(options), before = await revision();
  await new Promise(resolve => setTimeout(resolve, 5));
  await fs.writeFile(file, '{"keyword":"B"}'); await fs.utimes(file, fixed, fixed);
  await fs.utimes(directory, initialDirectory.atime, initialDirectory.mtime);
  const edited = await revision(); assert.notEqual(edited, before, "ctime detects same-length edit with restored mtime");
  await write("outputs/" + runName + "/replacement.tmp", '{"keyword":"C"}');
  await fs.rename(path.join(directory, "replacement.tmp"), file);
  const replaced = await revision(); assert.notEqual(replaced, edited);
  await fs.unlink(file);
  const removed = await revision(); assert.notEqual(removed, replaced);
  assert.equal(await revision(), removed, "missing manifests are valid catalog fallback dependencies");
  await write("outputs/" + runName + "/manifest.json", '{"keyword":"D"}');
  assert.notEqual(await revision(), removed, "a previously absent manifest is checked on every call");
  assert.ok(file.startsWith(path.resolve(root) + path.sep));
});

test("run directory inventory and direct visible files detect catalog additions and deletions", async t => {
  const { root, write, options } = await fixture(t);
  await fs.mkdir(path.join(root, "outputs"));
  const revision = createMonthlyReportSelectorRevision(options), empty = await revision();
  const visible = await write("outputs/" + runName + "/result.csv", "name\n숙소");
  const added = await revision(); assert.notEqual(added, empty, "legacy runs can exist without a manifest");
  const html = await write("outputs/" + runName + "/result.html", "<h1>saved</h1>");
  const supplemented = await revision(); assert.notEqual(supplemented, added);
  await fs.unlink(html); assert.equal(await revision(), added);
  await fs.unlink(visible); const noVisible = await revision(); assert.notEqual(noVisible, added);
  await fs.rmdir(path.dirname(visible)); assert.equal(await revision(), empty, "removed run directory leaves no phantom catalog entry");
  await write("outputs/another_glamping_20261016/manifest.json", '{"keyword":"지역글램핑"}');
  assert.notEqual(await revision(), empty, "date-only legacy run directories match listRuns too");
});

test("capacity, holiday, API context and noncatalog folders are excluded from selector revisions", async t => {
  const { write, options } = await fixture(t);
  await write("outputs/" + runName + "/manifest.json");
  const revision = createMonthlyReportSelectorRevision(options), before = await revision();
  for (const name of ["company_integrated/capacity-bases.json", "history/special_days/2026.json", "history/kosis/region.json",
    "tourism_data/cache/visitor.json", "regional_search_trends/status.json", "tourism-map.json", "outputs/not-a-run/new-file.csv"]) {
    await write(name, '{"value":0}'); assert.equal(await revision(), before, name + " is not a selector input");
  }
  await write("outputs/" + runName + "/pending.json.tmp");
  assert.equal(await revision(), before, "uncommitted temporary names do not expire the saved selector list");
});

test("fresh shallow lists and directory identity prevent restored mtime from hiding entries or replaced runs", async t => {
  const { root, write, options } = await fixture(t);
  const manifest = await write("outputs/" + runName + "/manifest.json");
  const directory = path.dirname(manifest), initial = await fs.stat(directory);
  const revision = createMonthlyReportSelectorRevision(options), before = await revision();
  await write("outputs/" + runName + "/added.csv", "name\n숙소");
  await fs.utimes(directory, initial.atime, initial.mtime);
  const added = await revision(); assert.notEqual(added, before);
  await fs.rename(directory, path.join(root, "outputs/moved-run"));
  await write("outputs/" + runName + "/manifest.json", '{"keyword":"new"}');
  await fs.utimes(directory, initial.atime, initial.mtime);
  assert.notEqual(await revision(), added, "a replacement run cannot inherit old metadata by path alone");
});

test("each lookup fails closed on metadata errors, unsafe file replacements and directory permissions", async t => {
  const { write, options } = await fixture(t);
  const manifest = await write("outputs/" + runName + "/manifest.json"), directory = path.dirname(manifest);
  let deniedFile = false, linkedFile = false, deniedDirectory = false, listings = 0;
  const fileSystem = { ...fs, lstat: async (file, input) => {
    if (file === manifest && deniedFile) throw Object.assign(new Error("denied"), { code: "EACCES" });
    const value = await fs.lstat(file, input);
    if (file === manifest && linkedFile) return { ...value, isFile: () => false, isSymbolicLink: () => true };
    if (file === directory && deniedDirectory) return Object.assign(Object.create(value), { mode: value.mode ^ 1n });
    return value;
  }, readdir: async (file, input) => {
    listings++;
    if (file === directory && deniedDirectory) throw Object.assign(new Error("denied"), { code: "EACCES" });
    return fs.readdir(file, input);
  } };
  const revision = createMonthlyReportSelectorRevision({ ...options, fileSystem }), before = await revision();
  deniedFile = true; await assert.rejects(revision(), isUnavailable);
  deniedFile = false; listings = 0;
  assert.equal(await revision(), before); assert.ok(listings > 0, "recovery uses freshly read inventories");
  linkedFile = true; await assert.rejects(revision(), isUnavailable);
  linkedFile = false; assert.equal(await revision(), before);
  deniedDirectory = true; await assert.rejects(revision(), isUnavailable);
});

test("symbolic roots, matching run directories and direct entries are not certified as safe selector sources", async t => {
  const { root, write, options } = await fixture(t);
  await write("outputs/" + runName + "/manifest.json");
  for (const linked of [path.join(root, "outputs"), path.join(root, "outputs", runName)]) {
    const fileSystem = { ...fs, lstat: async (file, input) => {
      const value = await fs.lstat(file, input);
      return file === linked ? { ...value, isDirectory: () => false, isSymbolicLink: () => true } : value;
    } };
    await assert.rejects(createMonthlyReportSelectorRevision({ ...options, fileSystem })(), isUnavailable);
  }
  for (const containingDirectory of [path.join(root, "outputs"), path.join(root, "outputs", runName)]) {
    const fileSystem = { ...fs, readdir: async (file, input) => {
      const entries = await fs.readdir(file, input);
      return file === containingDirectory ? [...entries, { name: file.endsWith(runName) ? "linked.csv" : "linked_glamping_20261016",
        isSymbolicLink: () => true, isDirectory: () => false, isFile: () => false }] : entries;
    } };
    await assert.rejects(createMonthlyReportSelectorRevision({ ...options, fileSystem })(), isUnavailable);
  }
});

test("metadata concurrency is bounded and directory mutations during inspection are rejected", async t => {
  const { write, options } = await fixture(t);
  for (let index = 0; index < 20; index++) await write("outputs/run" + index + "_glamping_20261016/manifest.json");
  let active = 0, maximum = 0;
  const boundedFs = Object.fromEntries(["lstat", "readdir"].map(method => [method, async (...args) => {
    active++; maximum = Math.max(maximum, active);
    try { await new Promise(resolve => setImmediate(resolve)); return await fs[method](...args); }
    finally { active--; }
  }]));
  await createMonthlyReportSelectorRevision({ ...options, fileSystem: boundedFs, metadataConcurrency: 3 })();
  assert.ok(maximum <= 3); assert.ok(maximum > 1);
  let mutateCold = true;
  const changedFs = { ...fs, readdir: async (file, input) => {
    const entries = await fs.readdir(file, input);
    if (mutateCold && file.endsWith("run0_glamping_20261016")) {
      mutateCold = false; await fs.writeFile(path.join(file, "during.csv"), "name\n숙소");
      await fs.utimes(file, new Date("2020-01-01T00:00:00Z"), new Date("2020-01-01T00:00:00Z"));
    }
    return entries;
  } };
  await assert.rejects(createMonthlyReportSelectorRevision({ ...options, fileSystem: changedFs })(), isUnavailable);
  let mutateWarm = false, listings = 0;
  const warmFs = { ...fs, lstat: async (file, input) => {
    const value = await fs.lstat(file, input);
    if (mutateWarm && file.endsWith("run0_glamping_20261016")) {
      mutateWarm = false; await fs.writeFile(path.join(file, "warm.csv"), "name\n숙소");
      await fs.utimes(file, new Date("2021-01-01T00:00:00Z"), new Date("2021-01-01T00:00:00Z"));
    }
    return value;
  }, readdir: async (...args) => { listings++; return fs.readdir(...args); } };
  const warm = createMonthlyReportSelectorRevision({ ...options, fileSystem: warmFs }), before = await warm();
  listings = 0; mutateWarm = true; await assert.rejects(warm(), isUnavailable);
  assert.ok(listings > 0, "later scans still re-list the shallow inventory");
  assert.notEqual(await warm(), before);
});

test("metadata scheduling does not change revisions and validation enforces work limits", async t => {
  const { write, options } = await fixture(t);
  await write("outputs/" + runName + "/manifest.json");
  await write("outputs/" + runName + "/result.csv");
  const expected = await createMonthlyReportSelectorRevision(options)();
  for (const metadataConcurrency of [1, 3, 32]) {
    let listings = 0;
    const revision = createMonthlyReportSelectorRevision({ ...options, metadataConcurrency,
      fileSystem: { ...fs, readdir: async (...args) => { listings++; return fs.readdir(...args); } } });
    assert.equal(await revision(), expected); listings = 0;
    assert.equal(await revision(), expected); assert.ok(listings > 0);
  }
  for (const input of [{ metadataConcurrency: 0 }, { metadataConcurrency: 33 }, { metadataConcurrency: 1.5 }]) {
    assert.throws(() => createMonthlyReportSelectorRevision({ ...options, ...input }), TypeError);
  }
  const oversizedFs = { ...fs, readdir: async () => Array.from({ length: 100001 }, (_, index) => ({ name: "irrelevant-" + index,
    isSymbolicLink: () => false, isDirectory: () => false, isFile: () => true })) };
  await assert.rejects(createMonthlyReportSelectorRevision({ ...options, fileSystem: oversizedFs })(), isUnavailable);
});

test("new shallow entries are detected even if directory timestamps are identical across calls", async t => {
  const { root, write, options } = await fixture(t);
  await fs.mkdir(path.join(root, "outputs"));
  const outputs = path.join(root, "outputs"), original = await fs.lstat(outputs, { bigint: true });
  const fileSystem = { ...fs, lstat: async (file, input) => {
    const value = await fs.lstat(file, input);
    return value.isDirectory() ? Object.assign(Object.create(value), {
      mtimeNs: original.mtimeNs, ctimeNs: original.ctimeNs, size: original.size
    }) : value;
  } };
  const revision = createMonthlyReportSelectorRevision({ ...options, fileSystem }), before = await revision();
  const file = await write("outputs/" + runName + "/result.csv", "name\n숙소");
  const addedRun = await revision(); assert.notEqual(addedRun, before, "root inventory cannot depend on parent timestamps alone");
  const extra = await write("outputs/" + runName + "/supplement.csv", "name\n숙소");
  const addedFile = await revision(); assert.notEqual(addedFile, addedRun, "run inventory cannot depend on parent timestamps alone");
  await fs.unlink(extra); assert.equal(await revision(), addedRun);
  await fs.unlink(file); await fs.rmdir(path.dirname(file)); assert.equal(await revision(), before);
});

test("missing and empty directories remain distinct, and an alternate outputs path is checked", async t => {
  const { root, write, options } = await fixture(t);
  const revision = createMonthlyReportSelectorRevision(options), missing = await revision();
  await fs.mkdir(path.join(root, "outputs")); const empty = await revision(); assert.notEqual(empty, missing);
  await fs.mkdir(path.join(root, "outputs", runName)); const emptyRun = await revision(); assert.notEqual(emptyRun, empty);
  await fs.rmdir(path.join(root, "outputs", runName)); assert.equal(await revision(), empty);
  const alternate = createMonthlyReportSelectorRevision({ ...options, outputsDir: path.join(root, "custom") });
  const absentAlternate = await alternate();
  await write("outputs/ignored_glamping_20261016/manifest.json"); assert.equal(await alternate(), absentAlternate);
  await write("custom/accepted_glamping_20261016/manifest.json"); assert.notEqual(await alternate(), absentAlternate);
});

test("same-batch readers share work but a later request cannot inherit metadata checked before it arrived", async t => {
  const { write, options } = await fixture(t);
  const manifest = await write("outputs/" + runName + "/manifest.json", '{"keyword":"A"}');
  let hold = false, release, entered, inspected = 0;
  const atManifest = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const fileSystem = { ...fs, lstat: async (file, input) => {
    const value = await fs.lstat(file, input);
    if (file === manifest) {
      inspected++;
      if (hold) { hold = false; entered(); await gate; }
    }
    return value;
  } };
  const revision = createMonthlyReportSelectorRevision({ ...options, fileSystem }), before = await revision();
  inspected = 0;
  assert.deepEqual(await Promise.all([revision(), revision(), revision()]), [before, before, before]);
  assert.equal(inspected, 1);
  inspected = 0; hold = true;
  const early = revision(); await atManifest;
  await fs.writeFile(manifest, '{"keyword":"CHANGED"}');
  const late = revision(); release();
  assert.equal(await early, before, "the first caller retains metadata already inspected");
  assert.notEqual(await late, before, "post-read verification is a genuinely newer scan");
  assert.equal(inspected, 2);
});

test("failed scans drain remaining metadata before a waiting reader starts and recover using fresh inventories", async t => {
  const { write, options } = await fixture(t);
  const first = await write("company_master/companies.json"), second = await write("history/observations.jsonl");
  let shouldFail = true, firstFailed, secondEntered, releaseSecond, laterCalls = 0;
  const atFailure = new Promise(resolve => { firstFailed = resolve; });
  const atSecond = new Promise(resolve => { secondEntered = resolve; });
  const gate = new Promise(resolve => { releaseSecond = resolve; });
  const fileSystem = { ...fs, lstat: async (file, input) => {
    if (file === first && shouldFail) { firstFailed(); throw Object.assign(new Error("denied"), { code: "EACCES" }); }
    if (file === second && shouldFail) { secondEntered(); await gate; }
    if (file === second && !shouldFail) laterCalls++;
    return fs.lstat(file, input);
  } };
  const revision = createMonthlyReportSelectorRevision({ ...options, fileSystem });
  const failure = assert.rejects(revision(), isUnavailable);
  await Promise.all([atFailure, atSecond]);
  const next = revision(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(laterCalls, 0);
  shouldFail = false; releaseSecond(); await failure;
  assert.match(await next, /^[a-f0-9]{64}$/); assert.equal(laterCalls, 2, "the held first scan finishes before a fresh second scan");
});
