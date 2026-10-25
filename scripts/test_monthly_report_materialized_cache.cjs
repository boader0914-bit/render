"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { gzipSync, gunzipSync } = require("node:zlib");
const { createMonthlyReportMaterializedCache } = require("./lib/monthly_report_materialized_cache.cjs");
const keyFile = (directory, key) => path.join(directory, `${crypto.createHash("sha256").update(key).digest("hex")}.json`);
const gate = () => { let release; return { promise: new Promise(resolve => { release = resolve; }), release: value => release(value) }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
const value = amount => ({ snapshot: { summary: { lodging: { sold: amount, revenue: amount === null ? null : amount * 100000 } } }, comparison: { previousSold: 0 } });

async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "monthly-materialized-cache-")), directory = path.join(root, "cache");
  t.after(async () => {
    const resolved = path.resolve(root);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith("monthly-materialized-cache-"));
    await fs.rm(resolved, { recursive: true, force: true });
  });
  const cache = createMonthlyReportMaterializedCache({ directory, ...options });
  return { cache, root, directory };
}

test("durable monthly aggregates survive a new cache instance without reading calculation sources", async t => {
  const { cache, directory } = await fixture(t);
  let builds = 0, checks = 0;
  const request = { key: "region|sancheong|2026-09|2026-09-30", readRevision: async () => { checks++; return "source-v1"; }, build: async () => { builds++; return value(0); } };
  const first = await cache.getOrBuild(request);
  assert.equal(first.status, "calculated"); assert.equal(first.storage, "saved");
  assert.equal(checks, 2, "new calculations retain fresh source validation before and after building");
  checks = 0;
  const restarted = createMonthlyReportMaterializedCache({ directory });
  const saved = await restarted.getOrBuild({ ...request, build: async () => { throw Error("saved calculation must bypass source reconstruction"); } });
  assert.equal(saved.status, "reused"); assert.equal(saved.calculatedAt, first.calculatedAt);
  assert.deepEqual(saved.value, value(0)); assert.equal(builds, 1);
  assert.equal(checks, 1, "a saved independent payload needs one fresh source inspection after it is read");
});

test("source revision failure cannot serve a previously saved aggregate as current", async t => {
  const { cache, directory } = await fixture(t);
  const key = "company|a|2026-09", request = { key, readRevision: async () => "r1", build: async () => value(3) };
  await cache.getOrBuild(request); const original = await fs.readFile(keyFile(directory, key), "utf8");
  const failure = Object.assign(new Error("source unavailable"), { code: "MONTHLY_SOURCE_UNAVAILABLE" });
  await assert.rejects(cache.getOrBuild({ ...request, readRevision: async () => { throw failure; } }), error => error === failure);
  for (const revision of [null, "", {}, "x".repeat(513)]) {
    await assert.rejects(cache.getOrBuild({ ...request, readRevision: async () => revision }), error => error.code === "MONTHLY_SOURCE_REVISION_UNAVAILABLE" && error.statusCode === 503);
  }
  assert.equal(await fs.readFile(keyFile(directory, key), "utf8"), original);
});

test("malformed or hash-mismatched derived files are misses and preserve genuine missing values", async t => {
  const { cache, directory } = await fixture(t), key = "region|a|2026-09";
  const request = { key, readRevision: async () => "r1", build: async () => value(null) };
  await cache.getOrBuild(request); const file = keyFile(directory, key);
  const original = JSON.parse(await fs.readFile(file, "utf8"));
  for (const damaged of ["not JSON", JSON.stringify({ ...original, schemaVersion: 99 }),
    JSON.stringify({ ...original, key: "wrong" }), JSON.stringify({ ...original, value: value(99) }),
    ...[null, "", {}, "x".repeat(513)].map(sourceRevision => JSON.stringify({ ...original, sourceRevision }))]) {
    await fs.writeFile(file, damaged);
    const fresh = await cache.getOrBuild(request);
    assert.equal(fresh.status, "calculated"); assert.equal(fresh.value.snapshot.summary.lodging.sold, null);
  }
});

test("simultaneous identical requests build once and return isolated objects", async t => {
  const { cache, directory } = await fixture(t), key = "keyword|경남글램핑|2026-09", entered = gate(), release = gate();
  let builds = 0; const originalValue = value(16);
  const request = { key, readRevision: async () => "r1", build: async () => { builds++; entered.release(); await release.promise; return originalValue; } };
  const first = cache.getOrBuild(request); await entered.promise;
  const second = cache.getOrBuild(request);
  // Complete the real filesystem miss before letting the active builder finish.
  await tick(); await tick(); release.release();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(builds, 1); assert.equal(a.status, "calculated"); assert.equal(b.status, "coalesced");
  a.value.snapshot.summary.lodging.sold = 1000; originalValue.snapshot.summary.lodging.sold = 2000;
  assert.equal(b.value.snapshot.summary.lodging.sold, 16);
  const saved = await cache.getOrBuild(request);
  assert.equal(saved.value.snapshot.summary.lodging.sold, 16);
  assert.equal(JSON.parse(await fs.readFile(keyFile(directory, key), "utf8")).value.snapshot.summary.lodging.sold, 16);
});

test("the first caller cannot mutate a shared result while a follower verifies its revision", async t => {
  const { cache } = await fixture(t), entered = gate(), buildRelease = gate(), verifying = gate(), verifyRelease = gate();
  let checks = 0;
  const request = { key: "early-mutation", readRevision: async () => {
    checks++;
    if (checks === 3) { verifying.release(); await verifyRelease.promise; }
    return "r1";
  }, build: async () => { entered.release(); await buildRelease.promise; return value(16); } };
  const first = cache.getOrBuild(request); await entered.promise;
  const second = cache.getOrBuild(request); buildRelease.release();
  const a = await first; await verifying.promise;
  a.value.snapshot.summary.lodging.sold = 999;
  verifyRelease.release();
  assert.equal((await second).value.snapshot.summary.lodging.sold, 16);
});

test("shared failed builds reject all callers and a later retry can rebuild", async t => {
  const { cache } = await fixture(t), entered = gate(), release = gate();
  let builds = 0; const failure = Object.assign(new Error("source missing"), { code: "MONTHLY_SOURCE_UNAVAILABLE" });
  const request = { key: "failure", readRevision: async () => "r1", build: async () => { builds++; entered.release(); await release.promise; throw failure; } };
  const first = cache.getOrBuild(request); await entered.promise;
  const second = cache.getOrBuild(request); await tick(); await tick();
  const firstRejected = assert.rejects(first, error => error === failure), secondRejected = assert.rejects(second, error => error === failure);
  release.release(); await Promise.all([firstRejected, secondRejected]); assert.equal(builds, 1);
  const retry = await cache.getOrBuild({ ...request, build: async () => { builds++; return value(4); } });
  assert.equal(retry.status, "calculated"); assert.equal(builds, 2);
});

test("identical callers share the initial file read so a delayed miss cannot restart finished work", async t => {
  const { cache, directory } = await fixture(t), key = "single-flight-file-read", file = keyFile(directory, key);
  const lstat = fs.lstat, readEntered = gate(), releaseRead = gate(); let reads = 0, builds = 0;
  let first, second;
  try {
    fs.lstat = async (...args) => {
      if (args[0] === file) { reads++; if (reads === 1) { readEntered.release(); await releaseRead.promise; } }
      return lstat(...args);
    };
    const request = { key, readRevision: async () => "r1", build: async () => { builds++; return value(5); } };
    first = cache.getOrBuild(request); await readEntered.promise;
    second = cache.getOrBuild(request); await tick(); await tick();
    assert.equal(reads, 1, "joining a running key must precede its cache file read");
    releaseRead.release();
    const [a, b] = await Promise.all([first, second]);
    assert.equal(builds, 1); assert.equal(a.status, "calculated"); assert.equal(b.status, "coalesced");
  } finally { releaseRead.release(); await Promise.allSettled([first, second].filter(Boolean)); fs.lstat = lstat; }
});

test("invalid cache limits are rejected instead of silently disabling the bounds", () => {
  for (const options of [{ maxEntries: 0 }, { maxEntries: -1 }, { maxBytes: 0 }, { maxEntryBytes: 0 }, { maxBytes: 100, maxEntryBytes: 101 }]) {
    assert.throws(() => createMonthlyReportMaterializedCache({ directory: "unused", ...options }), TypeError);
  }
});

test("a coalesced caller rechecks the source version instead of returning an older shared result", async t => {
  const { cache } = await fixture(t), entered = gate(), release = gate(); let builds = 0;
  const first = cache.getOrBuild({ key: "coalesced-revision", readRevision: async () => "r1", build: async () => { builds++; entered.release(); await release.promise; return value(6); } });
  await entered.promise;
  const second = cache.getOrBuild({ key: "coalesced-revision", readRevision: async () => "r2", build: async () => { throw Error("coalesced caller must not build concurrently"); } });
  const rejected = assert.rejects(second, error => error.code === "MONTHLY_SOURCE_CHANGED" && error.statusCode === 409);
  release.release();
  assert.equal((await first).value.snapshot.summary.lodging.sold, 6); await rejected; assert.equal(builds, 1);
});

test("a source edit during the actual saved-file read cannot return the old cached value", async t => {
  const { cache, root, directory } = await fixture(t), key = "changed-during-saved-read";
  const source = path.join(root, "source-version.json"), file = keyFile(directory, key);
  await fs.writeFile(source, "r1");
  const readRevision = async () => fs.readFile(source, "utf8");
  await cache.getOrBuild({ key, readRevision, build: async () => value(7) });
  const originalReadFile = fs.readFile;
  let readFinished = false, changedWhileReading = false, checks = 0, builds = 0;
  try {
    fs.readFile = async (...args) => {
      const result = await originalReadFile(...args);
      if (args[0] === file) {
        await fs.writeFile(source, "r2");
        changedWhileReading = true; readFinished = true;
      }
      return result;
    };
    const fresh = await cache.getOrBuild({ key, readRevision: async () => {
      assert.equal(readFinished, true, "source validation must begin after the candidate payload read has completed");
      checks++; return readRevision();
    }, build: async () => { builds++; return value(8); } });
    assert.equal(changedWhileReading, true); assert.equal(checks, 2);
    assert.equal(builds, 1); assert.equal(fresh.status, "calculated");
    assert.equal(fresh.sourceRevision, "r2"); assert.deepEqual(fresh.value, value(8));
    const saved = JSON.parse(await originalReadFile(file, "utf8"));
    assert.equal(saved.sourceRevision, "r2"); assert.deepEqual(saved.value, value(8));
  } finally { fs.readFile = originalReadFile; }
});

test("a source failure after a saved payload is read preserves the last complete cache", async t => {
  const { cache, directory } = await fixture(t), key = "failed-after-saved-read", file = keyFile(directory, key);
  await cache.getOrBuild({ key, readRevision: async () => "r1", build: async () => value(7) });
  const originalReadFile = fs.readFile, original = await fs.readFile(file, "utf8");
  let readFinished = false;
  try {
    fs.readFile = async (...args) => { const result = await originalReadFile(...args); if (args[0] === file) readFinished = true; return result; };
    await assert.rejects(cache.getOrBuild({ key, readRevision: async () => {
      assert.equal(readFinished, true);
      throw Object.assign(new Error("source metadata unavailable"), { code: "MONTHLY_SOURCE_REVISION_UNAVAILABLE", statusCode: 503 });
    }, build: async () => { throw Error("a failed source check cannot start a replacement"); } }),
    error => error.code === "MONTHLY_SOURCE_REVISION_UNAVAILABLE" && error.statusCode === 503);
    assert.equal(await originalReadFile(file, "utf8"), original);
  } finally { fs.readFile = originalReadFile; }
});

test("a later caller cannot inherit a saved-cache source inspection already in progress", async t => {
  const { cache, root } = await fixture(t), key = "late-saved-reader", source = path.join(root, "source-version.json");
  await fs.writeFile(source, "r1");
  const readRevision = async () => fs.readFile(source, "utf8");
  await cache.getOrBuild({ key, readRevision, build: async () => value(7) });
  const entered = gate(), release = gate();
  let leader, follower;
  try {
    leader = cache.getOrBuild({ key, readRevision: async () => {
      const seen = await readRevision(); entered.release(); await release.promise; return seen;
    }, build: async () => { throw Error("saved value must reuse"); } });
    await entered.promise;
    await fs.writeFile(source, "r2");
    let followerChecks = 0;
    follower = cache.getOrBuild({ key, readRevision: async () => { followerChecks++; return readRevision(); },
      build: async () => { throw Error("a follower must not start a concurrent replacement"); } });
    const rejected = assert.rejects(follower, error => error.code === "MONTHLY_SOURCE_CHANGED" && error.statusCode === 409);
    release.release();
    assert.equal((await leader).status, "reused"); await rejected;
    assert.equal(followerChecks, 1, "the later caller requires its own fresh validation after joining the shared result");
  } finally { release.release(); await Promise.allSettled([leader, follower].filter(Boolean)); }
});

test("a source change during build cannot replace the previous complete file", async t => {
  const { cache, directory } = await fixture(t), key = "changed-during-build";
  await cache.getOrBuild({ key, readRevision: async () => "r1", build: async () => value(1) });
  const original = await fs.readFile(keyFile(directory, key), "utf8"); let revision = "r2";
  await assert.rejects(cache.getOrBuild({ key, readRevision: async () => revision, build: async () => { revision = "r3"; return value(3); } }), error => error.code === "MONTHLY_SOURCE_CHANGED");
  assert.equal(await fs.readFile(keyFile(directory, key), "utf8"), original);
  const latest = await cache.getOrBuild({ key, readRevision: async () => revision, build: async () => value(3) });
  assert.equal(latest.status, "calculated"); assert.equal(latest.value.snapshot.summary.lodging.sold, 3);
});

test("a cache rename failure returns the new calculation while preserving the old complete file", async t => {
  const { cache, directory } = await fixture(t), key = "write-failure";
  await cache.getOrBuild({ key, readRevision: async () => "r1", build: async () => value(1) });
  const file = keyFile(directory, key), original = await fs.readFile(file, "utf8"), rename = fs.rename;
  try {
    fs.rename = async (from, to) => { if (to === file) throw Object.assign(new Error("disk failure"), { code: "EIO" }); return rename(from, to); };
    const fresh = await cache.getOrBuild({ key, readRevision: async () => "r2", build: async () => value(2) });
    assert.equal(fresh.status, "calculated"); assert.equal(fresh.storage, "failed"); assert.equal(fresh.value.snapshot.summary.lodging.sold, 2);
    assert.equal(await fs.readFile(file, "utf8"), original);
    assert.ok((await fs.readdir(directory)).every(name => !name.endsWith(".tmp")), "failed replacements remove only their temporary file");
  } finally { fs.rename = rename; }
});

test("an oversized derived result is returned without replacing an existing complete entry", async t => {
  const { cache, directory } = await fixture(t, { maxEntryBytes: 1000 }), key = "oversized";
  await cache.getOrBuild({ key, readRevision: async () => "r1", build: async () => value(1) });
  const original = await fs.readFile(keyFile(directory, key), "utf8");
  const fresh = await cache.getOrBuild({ key, readRevision: async () => "r2", build: async () => ({ ...value(null), note: "x".repeat(2000) }) });
  assert.equal(fresh.storage, "too_large"); assert.equal(fresh.value.snapshot.summary.lodging.sold, null);
  assert.equal(await fs.readFile(keyFile(directory, key), "utf8"), original);
});

test("entry bounds evict only old derived files while preserving adjacent reports and directories", async t => {
  const { cache, root, directory } = await fixture(t, { maxEntries: 2 });
  await fs.mkdir(directory, { recursive: true });
  const foreign = path.join(directory, "issued-report.json"), outside = path.join(root, "published.json");
  const hashDirectory = path.join(directory, `${"a".repeat(64)}.json`);
  await fs.writeFile(foreign, "approved"); await fs.writeFile(outside, "published"); await fs.mkdir(hashDirectory);
  for (const [index, key] of ["old", "middle", "new"].entries()) {
    await cache.getOrBuild({ key, readRevision: async () => "r1", build: async () => value(index) });
    await fs.utimes(keyFile(directory, key), new Date(`2026-01-0${index + 1}T00:00:00Z`), new Date(`2026-01-0${index + 1}T00:00:00Z`));
  }
  const entries = [];
  for (const name of await fs.readdir(directory)) if (/^[a-f0-9]{64}\.json$/.test(name) && (await fs.lstat(path.join(directory, name))).isFile()) entries.push(name);
  assert.deepEqual(entries.sort(), [path.basename(keyFile(directory, "middle")), path.basename(keyFile(directory, "new"))].sort());
  assert.equal(await fs.readFile(foreign, "utf8"), "approved"); assert.equal(await fs.readFile(outside, "utf8"), "published");
  assert.equal((await fs.lstat(hashDirectory)).isDirectory(), true);
});

test("byte bounds keep the newest complete result and remove only older cache entries", async t => {
  const { cache, directory } = await fixture(t, { maxBytes: 1000 });
  await cache.getOrBuild({ key: "old", readRevision: async () => "r1", build: async () => ({ ...value(1), note: "x".repeat(300) }) });
  await fs.utimes(keyFile(directory, "old"), new Date("2026-01-01T00:00:00Z"), new Date("2026-01-01T00:00:00Z"));
  await cache.getOrBuild({ key: "new", readRevision: async () => "r1", build: async () => ({ ...value(2), note: "x".repeat(300) }) });
  await assert.rejects(fs.access(keyFile(directory, "old")), error => error.code === "ENOENT");
  const saved = JSON.parse(await fs.readFile(keyFile(directory, "new"), "utf8"));
  assert.equal(saved.value.snapshot.summary.lodging.sold, 2);
});

test("a protected replacement still obeys entry bounds when older files have future timestamps", async t => {
  const { cache, directory } = await fixture(t, { maxEntries: 2 });
  for (const [index, key] of ["future-a", "future-b"].entries()) {
    await cache.getOrBuild({ key, readRevision: async () => "r1", build: async () => value(index) });
    const stamp = new Date(`2099-01-0${index + 1}T00:00:00Z`);
    await fs.utimes(keyFile(directory, key), stamp, stamp);
  }
  await cache.getOrBuild({ key: "replacement", readRevision: async () => "r1", build: async () => value(3) });
  const names = (await fs.readdir(directory)).filter(name => /^[a-f0-9]{64}\.json$/.test(name));
  assert.equal(names.length, 2, "retaining the current complete entry must count against the bound even after a clock correction");
  assert.ok(names.includes(path.basename(keyFile(directory, "replacement"))));
});

test("optional gzip entries survive restart with unchanged payload checksums and missing-value semantics", async t => {
  const { cache, directory } = await fixture(t, { compression: "gzip" });
  const key = "compressed-company", file = keyFile(directory, key) + ".gz", payload = { ...value(null), note: "객실 자료 ".repeat(1000) };
  const first = await cache.getOrBuild({ key, readRevision: async () => "source-v1", build: async () => payload });
  assert.equal(first.storage, "saved");
  const encoded = await fs.readFile(file), serialized = gunzipSync(encoded), saved = JSON.parse(serialized);
  assert.deepEqual([...encoded.subarray(0, 2)], [0x1f, 0x8b]); assert.ok(encoded.length < serialized.length / 4);
  assert.equal(saved.valueHash, crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex"));
  assert.deepEqual(saved.value, payload); await assert.rejects(fs.access(keyFile(directory, key)), { code: "ENOENT" });
  const restarted = createMonthlyReportMaterializedCache({ directory, compression: "gzip" });
  const reused = await restarted.getOrBuild({ key, readRevision: async () => "source-v1", build: () => assert.fail("compressed saved unit rebuilt") });
  assert.equal(reused.status, "reused"); assert.equal(reused.calculatedAt, first.calculatedAt); assert.deepEqual(reused.value, payload);
});

test("corrupt, truncated, invalid-checksum and excessive decoded gzip entries rebuild safely", async t => {
  const limit = 1200, { cache, directory } = await fixture(t, { compression: "gzip", maxEntryBytes: limit });
  const key = "compressed-damaged", file = keyFile(directory, key) + ".gz", request = { key, readRevision: async () => "r1", build: async () => value(null) };
  await cache.getOrBuild(request); const encoded = await fs.readFile(file), original = JSON.parse(gunzipSync(encoded));
  const oversizedDecoded = gzipSync(JSON.stringify({ ...original, note: "x".repeat(limit * 3) }));
  assert.ok(oversizedDecoded.length < limit);
  for (const damaged of [Buffer.from("not gzip"), encoded.subarray(0, encoded.length - 5),
    gzipSync(JSON.stringify({ ...original, value: value(99) })), gzipSync(JSON.stringify({ ...original, key: "wrong" })),
    gzipSync(JSON.stringify({ ...original, sourceRevision: {} })), oversizedDecoded, Buffer.alloc(limit + 1)]) {
    await fs.writeFile(file, damaged);
    const fresh = await cache.getOrBuild(request);
    assert.equal(fresh.status, "calculated"); assert.equal(fresh.storage, "saved"); assert.deepEqual(fresh.value, value(null));
  }
});

test("gzip retains the raw serialized size guard and preserves a complete prior entry on oversized replacement", async t => {
  const { cache, directory } = await fixture(t, { compression: "gzip", maxEntryBytes: 1000 }), key = "compressed-raw-limit", file = keyFile(directory, key) + ".gz";
  await cache.getOrBuild({ key, readRevision: async () => "r1", build: async () => value(1) });
  const previous = await fs.readFile(file);
  const largeValue = { ...value(null), note: "x".repeat(3000) }; assert.ok(gzipSync(JSON.stringify(largeValue)).length < 1000);
  const fresh = await cache.getOrBuild({ key, readRevision: async () => "r2", build: async () => largeValue });
  assert.equal(fresh.status, "calculated"); assert.equal(fresh.storage, "too_large"); assert.deepEqual(fresh.value, largeValue);
  assert.deepEqual(await fs.readFile(file), previous);
});

test("gzip trims physical bytes including legacy derived units without touching adjacent reports", async t => {
  const maxBytes = 1400, { directory } = await fixture(t, { compression: "gzip", maxBytes });
  const plain = createMonthlyReportMaterializedCache({ directory, maxBytes });
  await plain.getOrBuild({ key: "legacy", readRevision: async () => "r1", build: async () => ({ ...value(1), note: "legacy".repeat(110) }) });
  const legacyFile = keyFile(directory, "legacy");
  await fs.utimes(legacyFile, new Date("2026-01-01T00:00:00Z"), new Date("2026-01-01T00:00:00Z"));
  const foreign = path.join(directory, "issued-report.json"), hashDirectory = path.join(directory, "a".repeat(64) + ".json.gz");
  await fs.writeFile(foreign, "issued"); await fs.mkdir(hashDirectory);
  const cache = createMonthlyReportMaterializedCache({ directory, maxBytes, compression: "gzip" });
  let uncompressedBytes = 0;
  for (const key of ["compressed-a", "compressed-b", "compressed-c"]) {
    const result = await cache.getOrBuild({ key, readRevision: async () => "r1", build: async () => ({ ...value(2), note: "rooms".repeat(150) }) });
    assert.equal(result.storage, "saved"); uncompressedBytes += gunzipSync(await fs.readFile(keyFile(directory, key) + ".gz")).length;
  }
  const files = [];
  for (const name of await fs.readdir(directory)) if (/^[a-f0-9]{64}\.json(?:\.gz)?$/.test(name)) {
    const stat = await fs.lstat(path.join(directory, name)); if (stat.isFile()) files.push({ name, size: stat.size });
  }
  assert.ok(uncompressedBytes > maxBytes); assert.ok(files.reduce((sum, row) => sum + row.size, 0) <= maxBytes);
  assert.equal(files.filter(row => row.name.endsWith(".gz")).length, 3, "physical compressed bytes govern retention, not expanded JSON length");
  await assert.rejects(fs.access(legacyFile), { code: "ENOENT" });
  assert.equal(await fs.readFile(foreign, "utf8"), "issued"); assert.equal((await fs.lstat(hashDirectory)).isDirectory(), true);
});

test("default caches keep legacy JSON behavior and cannot evict compressed namespace files", async t => {
  const { directory } = await fixture(t);
  const gzip = createMonthlyReportMaterializedCache({ directory, compression: "gzip" });
  await gzip.getOrBuild({ key: "same-key", readRevision: async () => "r1", build: async () => value(3) });
  const compressedFile = keyFile(directory, "same-key") + ".gz", original = await fs.readFile(compressedFile);
  const plain = createMonthlyReportMaterializedCache({ directory, maxEntries: 1 });
  for (const key of ["same-key", "other-key"]) {
    const result = await plain.getOrBuild({ key, readRevision: async () => "r1", build: async () => value(8) });
    assert.equal(result.status, "calculated"); assert.equal(JSON.parse(await fs.readFile(keyFile(directory, key), "utf8")).value.snapshot.summary.lodging.sold, 8);
  }
  assert.deepEqual(await fs.readFile(compressedFile), original);
  assert.equal((await gzip.getOrBuild({ key: "same-key", readRevision: async () => "r1", build: () => assert.fail("default trim removed compressed entry") })).value.snapshot.summary.lodging.sold, 3);
  for (const compression of [false, true, "brotli", "", 1]) {
    assert.throws(() => createMonthlyReportMaterializedCache({ directory, compression }), TypeError);
  }
});
