"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { createRunCatalog } = require("./lib/run_catalog.cjs");

const id = index => `fixture_glamping_20261021_${String(index).padStart(6, "0")}`;
const incomplete = (manifest, files) => !files.some(name => /\.(csv|xlsx|md|html|png)$/i.test(name))
  && !manifest?.files?.some(name => /\.(csv|xlsx|md|html|png)$/i.test(name))
  && !Object.values(manifest?.counts || {}).some(value => Number(value) > 0);
const deferred = () => { let resolve; return { promise: new Promise(done => { resolve = done; }), resolve }; };

async function fixture(t, options = {}) {
  const parent = await fs.realpath(os.tmpdir());
  const root = await fs.mkdtemp(path.join(parent, "run-catalog-test-"));
  t.after(async () => {
    assert.ok(path.resolve(root).startsWith(path.resolve(parent) + path.sep));
    await fs.rm(root, { recursive: true, force: true });
  });
  const reads = { manifests: 0, projections: 0, childDirectories: 0, rootDirectories: 0 };
  const wrapped = {
    ...fs,
    readdir: async (directory, input) => {
      if (directory === root) reads.rootDirectories++;
      else reads.childDirectories++;
      return fs.readdir(directory, input);
    }
  };
  async function readManifest(directory) {
    reads.manifests++;
    return JSON.parse(await fs.readFile(path.join(directory, "manifest.json"), "utf8"));
  }
  async function projectRun({ id: runId, manifest, files, stat }) {
    reads.projections++;
    if (/^\?+$/.test(manifest?.keyword || "")) return null;
    return { id: runId, keyword: manifest?.keyword || "legacy", collectionQuality: manifest?.collectionQuality || null,
      collectedAt: manifest?.completedAt || stat.birthtime.toISOString(), collectedAtSource: manifest?.completedAt ? "recorded" : "filesystem",
      updatedAt: stat.mtime.toISOString(), counts: manifest?.counts || {}, files: manifest?.files || files };
  }
  async function save(index, manifest = { keyword: "one", completedAt: "2026-10-21T01:00:00Z", collectionQuality: { status: "partial" } }, files = ["rows.csv"]) {
    const directory = path.join(root, id(index));
    await fs.mkdir(directory, { recursive: true });
    for (const name of files) await fs.writeFile(path.join(directory, name), "fixture");
    if (manifest !== null) await fs.writeFile(path.join(directory, "manifest.json"), JSON.stringify(manifest));
    return directory;
  }
  const config = { outputsDir: root, readManifest, projectRun, isIncompleteRunDirectory: incomplete, fileSystem: wrapped, ...options };
  const catalog = createRunCatalog(config);
  return { root, reads, save, catalog, config, wrapped, projectRun, readManifest };
}

test("cold catalog preserves recorded/legacy fields and never invents completion", async t => {
  const f = await fixture(t);
  await f.save(1, { keyword: "fixture", completedAt: "2026-10-21T04:00:00Z", collectionQuality: { status: "blocked" }, counts: { succeeded: 0 } });
  await f.save(2, null);
  await f.save(3, null, []);
  await f.save(4, { keyword: "???", counts: { found: 1 } });
  await fs.mkdir(path.join(f.root, "not-a-run"));
  const rows = await f.catalog.list();
  assert.equal(rows.length, 2);
  const recorded = rows.find(row => row.id === id(1)), legacy = rows.find(row => row.id === id(2));
  assert.deepEqual(recorded.collectionQuality, { status: "blocked" });
  assert.equal(recorded.collectedAt, "2026-10-21T04:00:00Z");
  assert.equal(recorded.collectedAtSource, "recorded");
  assert.deepEqual(recorded.counts, { succeeded: 0 });
  assert.equal(legacy.collectionQuality, null); assert.equal(legacy.collectedAtSource, "filesystem");
  assert.ok(Number.isFinite(Date.parse(legacy.collectedAt)));
  assert.deepEqual(rows.map(row => row.id), [...rows].sort((a, b) => b.collectedAt.localeCompare(a.collectedAt) || b.id.localeCompare(a.id)).map(row => row.id));
});

test("unchanged lookup inspects inventory and identities but reuses manifest/list/projection", async t => {
  const f = await fixture(t); await f.save(1); await f.save(2);
  const first = await f.catalog.list(), baseline = { ...f.reads };
  assert.deepEqual(await f.catalog.list(), first);
  assert.equal(f.reads.rootDirectories, baseline.rootDirectories + 1);
  assert.equal(f.reads.childDirectories, baseline.childDirectories);
  assert.equal(f.reads.manifests, baseline.manifests);
  assert.equal(f.reads.projections, baseline.projections);
  assert.equal(f.catalog.stats().reusedEntries, 2);
});

test("same-size in-place manifest change with preserved mtime is detected by ctime", async t => {
  const f = await fixture(t), directory = await f.save(1);
  await f.catalog.list();
  const filename = path.join(directory, "manifest.json"), before = await fs.stat(filename), original = await fs.readFile(filename, "utf8");
  const changed = original.replace('"partial"', '"blocked"');
  assert.equal(Buffer.byteLength(changed), Buffer.byteLength(original));
  await fs.writeFile(filename, changed); await fs.utimes(filename, before.atime, before.mtime);
  const rows = await f.catalog.list();
  assert.equal(rows[0].collectionQuality.status, "blocked"); assert.equal(f.reads.manifests, 2);
});

test("atomic same-size manifest replacement is observed", async t => {
  const f = await fixture(t), directory = await f.save(1); await f.catalog.list();
  const filename = path.join(directory, "manifest.json"), before = await fs.stat(filename);
  await fs.writeFile(filename + ".tmp", (await fs.readFile(filename, "utf8")).replace('"one"', '"two"'));
  await fs.utimes(filename + ".tmp", before.atime, before.mtime); await fs.rename(filename + ".tmp", filename);
  assert.equal((await f.catalog.list())[0].keyword, "two");
});

test("root additions/deletions update the list and remove cached deleted folders", async t => {
  const f = await fixture(t), first = await f.save(1); await f.catalog.list();
  await f.save(2); assert.equal((await f.catalog.list()).length, 2);
  await fs.rm(first, { recursive: true });
  assert.deepEqual((await f.catalog.list()).map(row => row.id), [id(2)]);
  assert.equal(f.catalog.stats().cacheEntries, 1);
});

test("a newly published manifest upgrades legacy without hiding its recorded quality", async t => {
  const f = await fixture(t), directory = await f.save(1, null); await f.catalog.list();
  await fs.writeFile(path.join(directory, "manifest.json"), JSON.stringify({ keyword: "published", completedAt: "2026-10-21T05:00:00Z", collectionQuality: { status: "complete" } }));
  const row = (await f.catalog.list())[0];
  assert.equal(row.keyword, "published"); assert.equal(row.collectionQuality.status, "complete"); assert.equal(row.collectedAtSource, "recorded");
});

test("changing a direct file list rechecks incomplete legacy visibility", async t => {
  const f = await fixture(t), directory = await f.save(1, null, []);
  assert.deepEqual(await f.catalog.list(), []);
  await fs.writeFile(path.join(directory, "new.csv"), "fixture");
  assert.deepEqual((await f.catalog.list())[0].files, ["new.csv"]);
});

test("legacy and cached-null visibility follows file additions/deletions even with identical directory metadata", async t => {
  const f = await fixture(t), directory = await f.save(1, null, []);
  const collapsedMetadata = {
    ...f.wrapped,
    lstat: async (filename, options) => {
      const value = await fs.lstat(filename, options);
      if (filename !== directory) return value;
      const masked = Object.create(value);
      for (const field of ["size", "mtimeNs", "ctimeNs"]) Object.defineProperty(masked, field, { value: 1n });
      return masked;
    }
  };
  const catalog = createRunCatalog({ ...f.config, fileSystem: collapsedMetadata });
  assert.deepEqual(await catalog.list(), []);
  await fs.writeFile(path.join(directory, "first.csv"), "fixture");
  assert.deepEqual((await catalog.list())[0].files, ["first.csv"]);
  await fs.writeFile(path.join(directory, "second.csv"), "fixture");
  assert.deepEqual((await catalog.list())[0].files, ["first.csv", "second.csv"]);
  await fs.unlink(path.join(directory, "first.csv"));
  assert.deepEqual((await catalog.list())[0].files, ["second.csv"]);
  await fs.unlink(path.join(directory, "second.csv"));
  assert.deepEqual(await catalog.list(), []);
  // A present manifest with no output/counts is also a cached-null projection.
  await fs.writeFile(path.join(directory, "manifest.json"), JSON.stringify({ keyword: "empty" }));
  assert.deepEqual(await catalog.list(), []);
  await fs.writeFile(path.join(directory, "later.csv"), "fixture");
  assert.deepEqual((await catalog.list())[0].files, ["later.csv", "manifest.json"]);
});

test("simultaneous lookups share work but return isolated objects", async t => {
  const gate = deferred(), entered = deferred();
  const f = await fixture(t); await f.save(1);
  const catalog = createRunCatalog({ ...f.config, readManifest: async directory => { entered.resolve(); await gate.promise; return f.readManifest(directory); } });
  const first = catalog.list(); await entered.promise;
  const second = catalog.list(), third = catalog.list(); gate.resolve();
  const values = await Promise.all([first, second, third]);
  assert.equal(f.reads.manifests, 1); assert.equal(catalog.stats().scans, 1);
  values[0][0].collectionQuality.status = "MUTATED"; values[0][0].files.push("MUTATED"); values[0].push({ id: "MUTATED" });
  assert.equal(values[1][0].collectionQuality.status, "partial"); assert.equal(values[2].length, 1);
  assert.equal((await catalog.list())[0].collectionQuality.status, "partial");
});

test("cold scans are parallel and bounded to configured concurrency", async t => {
  const f = await fixture(t); for (let index = 1; index <= 24; index++) await f.save(index);
  let active = 0, maximum = 0;
  function wrap(operation) { return async (...args) => {
    active++; maximum = Math.max(maximum, active);
    try { await new Promise(resolve => setImmediate(resolve)); return await operation(...args); }
    finally { active--; }
  }; }
  const catalog = createRunCatalog({ ...f.config, fileSystem: { ...f.wrapped, lstat: wrap(fs.lstat), readdir: wrap(fs.readdir) } });
  assert.equal((await catalog.list()).length, 24); assert.ok(maximum > 1); assert.ok(maximum <= 8);
});

test("changed-during-read scan does not commit cache and succeeds only on later recheck", async t => {
  const f = await fixture(t); const directory = await f.save(1);
  let mutate = true;
  const catalog = createRunCatalog({ ...f.config, readManifest: async target => {
    const manifest = await f.readManifest(target);
    if (mutate) { mutate = false; await fs.writeFile(path.join(directory, "manifest.json"), JSON.stringify({ ...manifest, keyword: "changed" })); }
    return manifest;
  } });
  await assert.rejects(catalog.list(), { code: "RUN_CATALOG_CHANGED_DURING_SCAN" });
  assert.equal(catalog.stats().cacheEntries, 0);
  assert.equal((await catalog.list())[0].keyword, "changed"); assert.equal(f.reads.manifests, 2);
});

test("a present unreadable/corrupt manifest throws instead of yielding false legacy or empty results", async t => {
  const f = await fixture(t); await f.save(1);
  const catalog = createRunCatalog({ ...f.config, readManifest: async () => null });
  await assert.rejects(catalog.list(), { code: "RUN_CATALOG_MANIFEST_UNREADABLE", statusCode: 503 });
  assert.equal(catalog.stats().cacheEntries, 0);
});

test("failed refresh preserves internal good cache without silently returning stale data", async t => {
  const f = await fixture(t), directory = await f.save(1); let fail = false;
  const catalog = createRunCatalog({ ...f.config, readManifest: async target => { if (fail) throw Error("private path/token"); return f.readManifest(target); } });
  await catalog.list(); const baseline = catalog.stats().cacheEntries;
  await fs.writeFile(path.join(directory, "manifest.json"), JSON.stringify({ keyword: "changed", counts: { found: 1 } }));
  fail = true;
  await assert.rejects(catalog.list(), error => error.code === "RUN_CATALOG_MANIFEST_UNREADABLE" && !error.message.includes("private"));
  assert.equal(catalog.stats().cacheEntries, baseline);
  fail = false; assert.equal((await catalog.list())[0].keyword, "changed");
});

test("cache entry/byte limits never truncate the actual archive", async t => {
  const f = await fixture(t, { maxCacheEntries: 2, maxCacheBytes: 1024 * 1024 });
  for (let index = 1; index <= 5; index++) await f.save(index);
  assert.equal((await f.catalog.list()).length, 5); assert.equal(f.catalog.stats().cacheEntries, 2);
  assert.equal((await f.catalog.list()).length, 5); assert.equal(f.catalog.stats().reusedEntries, 2);
  const noCache = createRunCatalog({ ...f.config, maxCacheBytes: 1 });
  assert.equal((await noCache.list()).length, 5); assert.equal(noCache.stats().cacheEntries, 0);
});

test("clear invalidates an in-flight scan and callers recheck before reuse", async t => {
  const f = await fixture(t); await f.save(1); const entered = deferred(), release = deferred(); let wait = true;
  const catalog = createRunCatalog({ ...f.config, readManifest: async target => { if (wait) { entered.resolve(); await release.promise; } return f.readManifest(target); } });
  const first = catalog.list(); await entered.promise; catalog.clear(); wait = false; release.resolve();
  await assert.rejects(first, { code: "RUN_CATALOG_CHANGED_DURING_SCAN" });
  assert.equal(catalog.stats().cacheEntries, 0); assert.equal((await catalog.list()).length, 1);
  catalog.clear(id(1)); assert.equal(catalog.stats().cacheEntries, 0);
});

test("missing root and projection failures are errors, not cached zero", async t => {
  const f = await fixture(t);
  const absent = createRunCatalog({ ...f.config, outputsDir: path.join(f.root, "absent") });
  await assert.rejects(absent.list(), { code: "RUN_CATALOG_SOURCE_UNAVAILABLE" });
  assert.equal(absent.stats().cacheEntries, 0);
  await f.save(1);
  const wrong = createRunCatalog({ ...f.config, projectRun: async () => ({ id: "other" }) });
  await assert.rejects(wrong.list(), { code: "RUN_CATALOG_PROJECTION_INVALID" });
});

test("catalog lookups do not modify source bytes, mtimes or directory inventories", async t => {
  const f = await fixture(t), directory = await f.save(1);
  const names = await fs.readdir(directory), before = await Promise.all(names.map(async name => ({ name, bytes: await fs.readFile(path.join(directory, name)), stat: await fs.stat(path.join(directory, name)) })));
  await f.catalog.list(); await f.catalog.list(); await f.catalog.list();
  assert.deepEqual(await fs.readdir(directory), names);
  for (const row of before) {
    assert.deepEqual(await fs.readFile(path.join(directory, row.name)), row.bytes);
    assert.equal((await fs.stat(path.join(directory, row.name))).mtimeMs, row.stat.mtimeMs);
  }
});

test("invalid options are rejected before reading or writing sources", () => {
  assert.throws(() => createRunCatalog({}), TypeError);
  const input = { outputsDir: "unused", readManifest: async () => ({}), projectRun: async () => null, isIncompleteRunDirectory: () => false };
  for (const config of [{ concurrency: 0 }, { concurrency: 33 }, { maxCacheEntries: -1 }, { maxCacheBytes: -1 }]) assert.throws(() => createRunCatalog({ ...input, ...config }), TypeError);
});

test("ordinary manifest/projection objects from another VM realm remain valid", async t => {
  const f = await fixture(t); await f.save(1);
  const foreignManifest = vm.runInNewContext('({ keyword: "foreign", counts: { found: 1 } })');
  const foreignProject = vm.runInNewContext('(input => ({ id: input.id, keyword: input.manifest.keyword, files: input.files }))');
  const catalog = createRunCatalog({ ...f.config, readManifest: async () => foreignManifest, projectRun: foreignProject });
  assert.equal((await catalog.list())[0].keyword, "foreign");
  assert.equal((await catalog.list())[0].keyword, "foreign");
});
