"use strict";

// Integration tests use the real global/local schedulers and bootstrap store.
// Only tiny temporary fixtures are written; no application server is started.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createHeavyWorkScheduler } = require("./lib/heavy_work_scheduler.cjs");
const { createSourceReadScheduler, configureSourceReadHeavyWork } = require("./lib/source_read_scheduler.cjs");
const { createCompanyBootstrapStore } = require("./lib/company_bootstrap.cjs");
const { createCompanyDetailRunProjectionStore } = require("./lib/company_detail_run_projection.cjs");
const { createCompanyIntegratedDb } = require("./lib/company_integrated_db.cjs");

const MiB = 1024 * 1024;
const turn = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
async function bounded(promise, message, timeoutMs = 1500) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message || "integration fixture did not settle")), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}
async function waitFor(predicate, message) {
  return bounded((async () => { while (!predicate()) await turn(); })(), message);
}
function scheduler() {
  return createHeavyWorkScheduler({ maxWaitMs: 2000, pollIntervalMs: 5,
    memoryProbe: async () => ({ rssBytes: 64 * MiB, heapUsedBytes: 16 * MiB, externalBytes: MiB, arrayBufferBytes: MiB,
      cgroup: { currentBytes: 96 * MiB, limitBytes: 2048 * MiB, anonBytes: 64 * MiB,
        fileBytes: 24 * MiB, nonFileBytes: 72 * MiB } }) });
}
async function occupied(heavy, label = "fixture_blocker") {
  const entered = deferred(), release = deferred();
  const pending = heavy.run(async () => { entered.resolve(); await release.promise; }, { label });
  await bounded(entered.promise);
  return { release: release.resolve, pending };
}
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "analysis-heavy-admission-"));
  const absoluteRoot = path.resolve(root), tempRoot = path.resolve(os.tmpdir());
  t.after(async () => {
    assert.ok(absoluteRoot !== tempRoot && absoluteRoot.startsWith(tempRoot + path.sep));
    await fs.rm(absoluteRoot, { recursive: true, force: true });
  });
  const sourceFile = path.join(root, "companies.json"), cacheFile = path.join(root, "bootstrap.json");
  let writes = 0;
  const replace = async amount => {
    const next = path.join(root, `source-${++writes}.json`);
    await fs.writeFile(next, JSON.stringify({ companies: { one: { companyId: "one", amount } } }));
    await fs.rename(next, sourceFile);
  };
  await replace(16);
  return { root, sourceFile, cacheFile, replace,
    options: { sourceFile, cacheFile, projectionVersion: "independent-admission-v1",
      emptyMaster: () => ({ companies: {} }), project: master => ({ companies: Object.values(master.companies) }) } };
}

test("global admission precedes the local source slot so a heavy owner can safely request that source", async () => {
  const heavy = scheduler(), source = createSourceReadScheduler({ runHeavy: heavy.run });
  const entered = deferred(), nestedMayStart = deferred(), order = [];
  const owner = heavy.run(async () => {
    order.push("owner"); entered.resolve(); await nestedMayStart.promise;
    return source.run(async () => { order.push("owner-source"); return 41; });
  }, { label: "detail_recovery" });
  await bounded(entered.promise);
  const unrelated = source.run(async () => { order.push("unrelated-source"); return 42; }, { priority: "background" });
  try {
    await waitFor(() => heavy.status().queued === 1);
    assert.deepEqual(source.status(), { active: false, queuedForeground: 0, queuedBackground: 0 },
      "a request awaiting global admission must not own or enter the local source queue");
    nestedMayStart.resolve();
    assert.deepEqual(await bounded(Promise.all([owner, unrelated]), "global/local lock inversion deadlocked"), [41, 42]);
    assert.deepEqual(order, ["owner", "owner-source", "unrelated-source"]);
    assert.ok(heavy.status().counts.nested >= 1);
  } finally { nestedMayStart.resolve(); }
  await turn();
  assert.deepEqual(source.status(), { active: false, queuedForeground: 0, queuedBackground: 0 });
  assert.equal(heavy.status().active, null);
});

test("configured default source admission shares the application heavy slot without occupying its local queue", async t => {
  const heavy = scheduler();
  configureSourceReadHeavyWork(heavy.run);
  t.after(() => configureSourceReadHeavyWork(action => action()));
  const source = createSourceReadScheduler(), blocker = await occupied(heavy), order = [];
  const pending = source.run(() => { order.push("source"); return 0; });
  try {
    await waitFor(() => heavy.status().queued === 1);
    assert.deepEqual(source.status(), { active: false, queuedForeground: 0, queuedBackground: 0 });
    assert.deepEqual(order, []);
    blocker.release();
    assert.equal(await bounded(pending), 0, "a successful real zero survives global admission");
    await blocker.pending;
  } finally { blocker.release(); }
  assert.deepEqual(order, ["source"]);
});

test("memory and verified saved bootstrap results bypass an occupied heavy slot", async t => {
  const f = await fixture(t), heavy = scheduler();
  let admissions = 0, sourceReads = 0;
  const fileSystem = { ...fs, readFile: (...args) => {
    if (args[0] === f.sourceFile) sourceReads++;
    return fs.readFile(...args);
  } };
  const executeBuild = action => { admissions++; return heavy.run(action, { label: "bootstrap_build" }); };
  const store = createCompanyBootstrapStore({ ...f.options, fileSystem, executeBuild });
  assert.equal((await store.get()).cacheStatus, "calculated");
  assert.equal(admissions, 1); assert.equal(sourceReads, 1);
  const blocker = await occupied(heavy);
  try {
    const reopened = createCompanyBootstrapStore({ ...f.options, fileSystem, executeBuild,
      project: () => { throw Error("saved bootstrap must not project a master"); } });
    const [memory, saved] = await bounded(Promise.all([store.get(), reopened.get()]), "bootstrap cache hit waited on unrelated heavy work");
    assert.equal(memory.cacheStatus, "memory"); assert.equal(saved.cacheStatus, "saved");
    assert.equal(memory.data.companies[0].amount, 16); assert.equal(saved.data.companies[0].amount, 16);
    assert.equal(admissions, 1); assert.equal(sourceReads, 1);
    assert.equal(heavy.status().active.label, "fixture_blocker");
    assert.equal(heavy.status().queued, 0);
  } finally { blocker.release(); await blocker.pending; }
});

test("a queued bootstrap rebuild rechecks its source before reading and publishes only the newest value", async t => {
  const f = await fixture(t), heavy = scheduler();
  let admissions = 0, sourceReads = 0;
  const projected = [];
  const store = createCompanyBootstrapStore({ ...f.options,
    fileSystem: { ...fs, readFile: (...args) => { if (args[0] === f.sourceFile) sourceReads++; return fs.readFile(...args); } },
    project: master => { projected.push(master.companies.one.amount); return f.options.project(master); },
    executeBuild: action => { admissions++; return heavy.run(action, { label: "bootstrap_build" }); } });
  await store.get();
  const previous = await fs.readFile(f.cacheFile);
  sourceReads = 0; projected.length = 0; admissions = 0;
  await f.replace(17);
  const blocker = await occupied(heavy), refreshed = store.get();
  try {
    await waitFor(() => heavy.status().queued === 1);
    assert.equal(sourceReads, 0, "queued work does not allocate the global master early");
    assert.deepEqual(await fs.readFile(f.cacheFile), previous);
    await f.replace(18);
    blocker.release();
    const result = await bounded(refreshed);
    assert.equal(result.cacheStatus, "calculated");
    assert.equal(result.data.companies[0].amount, 18);
    assert.deepEqual(projected, [18], "the stale queued signature must not read/project value 17");
    assert.equal(sourceReads, 1);
    assert.equal(admissions, 2, "stale admission returns without a master read and the current signature is admitted again");
    assert.equal(JSON.parse(await fs.readFile(f.cacheFile, "utf8")).data.companies[0].amount, 18);
  } finally { blocker.release(); await blocker.pending; }
});

test("a source becoming invalid while bootstrap waits fails honestly and preserves its last normal saved result", async t => {
  const f = await fixture(t), heavy = scheduler();
  let sourceReads = 0, projected = 0;
  const store = createCompanyBootstrapStore({ ...f.options,
    fileSystem: { ...fs, readFile: (...args) => { if (args[0] === f.sourceFile) sourceReads++; return fs.readFile(...args); } },
    project: master => { projected++; return f.options.project(master); },
    executeBuild: action => heavy.run(action, { label: "bootstrap_build" }) });
  await store.get(); const previous = await fs.readFile(f.cacheFile);
  sourceReads = 0; projected = 0;
  await f.replace(17);
  const blocker = await occupied(heavy), refreshed = store.get();
  const rejected = assert.rejects(refreshed, SyntaxError);
  try {
    await waitFor(() => heavy.status().queued === 1);
    const corrupt = path.join(f.root, "invalid-source.json");
    await fs.writeFile(corrupt, "{broken"); await fs.rename(corrupt, f.sourceFile);
    blocker.release();
    await bounded(rejected);
    assert.equal(sourceReads, 1); assert.equal(projected, 0);
    assert.deepEqual(await fs.readFile(f.cacheFile), previous);
    assert.equal(await bounded(heavy.run(() => 7, { label: "following_work" })), 7,
      "source parsing failure releases admission for the next operation");
  } finally { blocker.release(); await blocker.pending; }
});

test("a projection waiting for global admission cannot hold the local build tail needed by the active owner", async t => {
  const f = await fixture(t), heavy = scheduler(), outputs = path.join(f.root, "outputs");
  for (const runId of ["owner-run", "outside-run"]) {
    await fs.mkdir(path.join(outputs, runId), { recursive: true });
    await fs.writeFile(path.join(outputs, runId, "manifest.json"), JSON.stringify({ runId }));
  }
  const store = createCompanyDetailRunProjectionStore({ dataDir: f.root, outputsDir: outputs,
    executeBuild: action => heavy.run(action, { label: "run_projection_build" }) });
  const request = runId => ({ company: { companyId: "one" }, runId,
    build: async () => ({ run: { id: runId }, availability: { items: [] } }) });
  const entered = deferred(), nestedMayStart = deferred(), nestedRequested = deferred(), ownerMayFinish = deferred();
  let ownedProjection;
  const owner = heavy.run(async () => {
    entered.resolve(); await nestedMayStart.promise;
    ownedProjection = store.get(request("owner-run"));
    ownedProjection.catch(() => {}); nestedRequested.resolve();
    // Keep admission held independently so a failed lock-order assertion can
    // release the owner and drain both requests without leaking a deadlock.
    await ownerMayFinish.promise;
  }, { label: "detail_owner" });
  await bounded(entered.promise);
  const outside = store.get(request("outside-run")); outside.catch(() => {});
  try {
    await waitFor(() => heavy.status().queued === 1, "outside projection did not await global admission");
    nestedMayStart.resolve(); await bounded(nestedRequested.promise);
    const result = await bounded(ownedProjection, "projection local-tail/global lock inversion blocked its current owner");
    assert.equal(result.data.run.id, "owner-run");
    assert.equal(heavy.status().active.label, "detail_owner");
  } finally {
    nestedMayStart.resolve(); ownerMayFinish.resolve();
    await bounded(Promise.allSettled([owner, outside, ...(ownedProjection ? [ownedProjection] : [])]), "projection fixture did not release its queues");
  }
});

test("a detached heavy descendant completes before its parent's next sibling starts", async () => {
  const heavy = scheduler(), childStarted = deferred(), childMayFinish = deferred(), order = [];
  let leaves = 0, peak = 0, secondStarted = false;
  const owner = heavy.run(() => Promise.all([
    heavy.run(() => {
      void heavy.run(async () => {
        peak = Math.max(peak, ++leaves); order.push("child-start"); childStarted.resolve();
        await childMayFinish.promise; order.push("child-end"); leaves--;
      }, { label: "detached_grandchild" });
      return "spawned";
    }, { label: "first_sibling" }),
    heavy.run(() => {
      peak = Math.max(peak, ++leaves); secondStarted = true; order.push("second"); leaves--; return "second";
    }, { label: "second_sibling" })
  ]), { label: "outer" });
  try {
    await bounded(childStarted.promise); await turn(); await turn();
    assert.equal(secondStarted, false, "a detached descendant cannot overlap the next sibling's heavy action");
  } finally { childMayFinish.resolve(); await bounded(owner); }
  assert.equal(peak, 1);
  assert.deepEqual(order, ["child-start", "child-end", "second"]);
});

test("bootstrap kick work still enters shared admission before a detached source reconstruction", async t => {
  const f = await fixture(t), heavy = scheduler(), source = createSourceReadScheduler({ runHeavy: heavy.run });
  const sourceStarted = deferred(), sourceMayFinish = deferred(), order = [];
  const company = { companyId: "one", primaryName: "fixture one", capacity: 16, capacitySource: "manual" };
  let first = true, outsideStarted = false, readers = 0, peak = 0;
  const db = createCompanyIntegratedDb({ dataDir: f.root, autoStart: true, now: () => new Date("2026-10-19T00:00:00Z"),
    catalog: async () => ({ companies: [company], runs: [] }),
    listTargets: async () => [{ companyId: "one", months: ["2026-09"] }],
    loadSources: (request, options) => source.run(async () => {
      peak = Math.max(peak, ++readers); order.push(`source:${request.month}`);
      try {
        if (first) { first = false; sourceStarted.resolve(); await sourceMayFinish.promise; }
        return { companies: [company], observations: [], runs: [] };
      } finally { readers--; }
    }, options) });
  const startup = heavy.run(() => db.bootstrap(), { label: "company_month_bootstrap", priority: "background" });
  await bounded(sourceStarted.promise);
  const outside = heavy.run(() => {
    peak = Math.max(peak, ++readers); outsideStarted = true; order.push("outside"); readers--;
  }, { label: "outside_heavy" });
  try {
    await turn(); await turn();
    assert.equal(outsideStarted, false, "bootstrap kick cannot orphan a raw source read outside shared admission");
  } finally { sourceMayFinish.resolve(); await bounded(Promise.all([startup, outside, db.drain()])); }
  const status = await db.status();
  assert.equal(status.counts.idle, 1); assert.equal(status.counts.failed || 0, 0);
  assert.equal(peak, 1); assert.ok(order.includes("outside"));
});

test("sampled memory peaks include a short heavy action's final sample", async () => {
  let finished = false;
  const heavy = createHeavyWorkScheduler({ memoryProbe: async () => ({
    rssBytes: (finished ? 128 : 64) * MiB, heapUsedBytes: 16 * MiB, externalBytes: 0, arrayBufferBytes: 0,
    cgroup: { currentBytes: (finished ? 176 : 88) * MiB, limitBytes: 2048 * MiB,
      anonBytes: (finished ? 128 : 64) * MiB, fileBytes: (finished ? 48 : 24) * MiB,
      nonFileBytes: (finished ? 128 : 64) * MiB }
  }) });
  assert.equal(await heavy.run(() => { finished = true; return 0; }, { label: "short_action" }), 0);
  const recent = heavy.status().recent[0];
  assert.equal(recent.after.rssBytes, 128 * MiB);
  assert.equal(recent.sampledPeakRssBytes, 128 * MiB);
  assert.equal(recent.sampledPeakAnonBytes, 128 * MiB);
  assert.equal(recent.sampledPeakFileBytes, 48 * MiB);
});

test("global foreground waiting promptly resumes a paused background source while its interactive lease remains held", async () => {
  const heavy = scheduler(), source = createSourceReadScheduler({ runHeavy: heavy.run,
    maxInteractiveHoldMs: 2500, hasExternalForegroundWaiting: () => heavy.status().queuedForeground > 0 });
  const backgroundStarted = deferred(), checkpointMayStart = deferred(), previewMayFinish = deferred(), order = [];
  let resumedWhileLeaseHeld = false, foreground;
  const background = source.run(async () => {
    backgroundStarted.resolve(); await checkpointMayStart.promise;
    await source.checkpoint({ priority: "background" });
    resumedWhileLeaseHeld = source.interactiveStatus().holdingBackground;
    order.push("background");
  }, { priority: "background" });
  await bounded(backgroundStarted.promise);
  const preview = source.runInteractive(() => previewMayFinish.promise);
  checkpointMayStart.resolve();
  try {
    await waitFor(() => source.interactiveStatus().pausedBackground, "background source did not pause for the interactive preview");
    assert.deepEqual(source.status(), { active: true, queuedForeground: 0, queuedBackground: 0 });
    // This request deliberately bypasses source.run: the local source queue
    // cannot see it and must inspect the independent global foreground queue.
    foreground = heavy.run(() => { order.push("foreground"); }, { label: "independent_foreground" });
    assert.equal(heavy.status().queuedForeground, 1);
    await bounded(Promise.all([background, foreground]),
      "a global foreground waited for the unnecessary 2.5 second interactive hold", 500);
    assert.equal(resumedWhileLeaseHeld, true, "progress came from global foreground detection, not lease expiration");
    assert.equal(source.interactiveStatus().activeLeases, 1);
    assert.equal(source.interactiveStatus().holdingBackground, true);
    assert.deepEqual(order, ["background", "foreground"]);
  } finally {
    previewMayFinish.resolve(); checkpointMayStart.resolve();
    await bounded(Promise.allSettled([background, preview, ...(foreground ? [foreground] : [])]));
  }
  assert.equal(source.interactiveStatus().pausedBackground, false);
  assert.equal(source.interactiveStatus().activeLeases, 0);
});
