"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { normalizeKeyword } = require("./lib/search_demand_model.cjs");
const { createSearchDemandScheduler } = require("./lib/search_demand_scheduler.cjs");
const { createSearchDemandActivation, SCHEDULE_VERSION } = require("./lib/search_demand_activation.cjs");
const scopeId = "sdscope_" + "a".repeat(64);
async function fixture(t, overrides = {}) {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "search-demand-scheduler-test-")), rootDir = path.join(parent, "demand");
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const state = { now: Date.parse("2026-11-02T00:31:00.000Z"), calls: [], snapshots: [], hooks: [], keywords: ["경남글램핑", "경남 글램핑", "가평글램핑"],
    scopes: { searchad: { configured: true, scopeId }, datalab: { configured: true, scopeId } } };
  const result = (provider, input) => {
    const identity = normalizeKeyword(input.keyword), observedAt = new Date(state.now).toISOString();
    return { status: "complete", networkAttempted: true, requestCount: 1, observedAt,
      snapshot: { schemaVersion: 1, snapshotId: "sd_" + crypto.createHash("sha256").update(provider + identity.keywordId + observedAt).digest("hex"),
        provider, keyword: identity.keyword, keywordId: identity.keywordId, scopeId: input.scopeId, observedAt, status: "ready" } };
  };
  const options = { rootDir, enabled: true, clock: () => state.now, readRegisteredKeywords: async () => state.keywords,
    store: { saveSnapshot: async snapshot => { state.snapshots.push(snapshot); return { snapshotId: snapshot.snapshotId, created: true }; } },
    providers: { credentialScope: async provider => state.scopes[provider],
      searchad: async input => { state.calls.push({ provider: "searchad", input }); return result("searchad", input); },
      datalab: async input => { state.calls.push({ provider: "datalab", input }); return result("datalab", input); } },
    onSnapshotCommitted: async (snapshot, metadata) => { state.hooks.push({ snapshotId: snapshot.snapshotId, metadata }); return { status: "complete" }; }, ...overrides };
  const create = changes => createSearchDemandScheduler({ ...options, ...changes });
  return { rootDir, parent, state, options, create, scheduler: create(), result };
}

test("disabled is inert: tick and start create no files, read no keys, and call no provider", async t => {
  let reads = 0;
  const f = await fixture(t, { enabled: false, readRegisteredKeywords: async () => { reads++; return []; } });
  assert.equal((await f.scheduler.tick()).lastReason, "DISABLED"); assert.equal(f.scheduler.start().enabled, false);
  assert.equal(reads, 0); assert.equal(f.state.calls.length, 0); await assert.rejects(fs.stat(f.rootDir), { code: "ENOENT" });
});

test("injected missing policy overrides a true fallback flag without reads or namespace creation", async t => {
  let reads = 0;
  const f = await fixture(t, { enabled: true, getEnabled: async () => ({ enabled: false, status: "missing", reasonCode: "SEARCH_DEMAND_ACTIVATION_MISSING", secret: "must-not-leak" }),
    readRegisteredKeywords: async () => { reads++; return []; } });
  const result = await f.scheduler.tick(); assert.equal(result.enabled, false); assert.equal(result.lastReason, "SEARCH_DEMAND_ACTIVATION_MISSING");
  assert.equal(result.running, false);
  assert.equal(reads, 0); assert.equal(f.state.calls.length, 0); assert.equal(JSON.stringify(result).includes("must-not-leak"), false);
  await assert.rejects(fs.stat(f.rootDir), { code: "ENOENT" });
});

test("an authoritative approval can activate a false fallback only on its KST not-before day", async t => {
  const f = await fixture(t, { enabled: false }); f.state.now = Date.parse("2026-11-01T11:00:00.000Z");
  await fs.mkdir(f.rootDir); await fs.writeFile(path.join(f.rootDir, "activation.json"), JSON.stringify({ enabled: true, approvedAt: "2026-11-01T10:00:00.000Z", notBeforeDay: "2026-11-02", scheduleVersion: SCHEDULE_VERSION }));
  const reader = createSearchDemandActivation({ rootDir: f.rootDir, clock: () => f.state.now }), scheduler = f.create({ getEnabled: () => reader.read() });
  t.after(() => scheduler.stop());
  scheduler.start(); await scheduler.tick(); assert.equal(f.state.calls.length, 0); assert.equal(scheduler.status().activation.status, "waiting");
  assert.deepEqual(await fs.readdir(f.rootDir), ["activation.json"]);
  f.state.now = Date.parse("2026-11-02T00:31:00.000Z"); const result = await scheduler.tick();
  assert.equal(result.enabled, true); assert.equal(f.state.calls.length, 4);
});

test("invalid or throwing runtime approval fails closed even with fallback enabled", async t => {
  for (const getEnabled of [async () => null, async () => ({ enabled: "true" }), async () => { throw new Error("PRIVATE-ACTIVATION"); }]) {
    const f = await fixture(t, { enabled: true, getEnabled }), result = await f.scheduler.tick();
    assert.equal(result.enabled, false); assert.equal(result.lastReason, "SEARCH_DEMAND_ACTIVATION_UNAVAILABLE"); assert.equal(f.state.calls.length, 0);
    assert.equal(JSON.stringify(result).includes("PRIVATE"), false); await assert.rejects(fs.stat(f.rootDir), { code: "ENOENT" });
  }
});

test("revocation during an active request preserves its result and stops all additional dispatches", async t => {
  let allowed = true; const f = await fixture(t, { getEnabled: async () => ({ enabled: allowed, reasonCode: allowed ? "SEARCH_DEMAND_ACTIVATION_APPROVED" : "SEARCH_DEMAND_ACTIVATION_DISABLED" }) });
  const original = f.options.providers.datalab;
  f.options.providers.datalab = async input => { const result = await original(input); allowed = false; return result; };
  const result = await f.scheduler.tick(); assert.equal(f.state.calls.length, 1); assert.equal(f.state.snapshots.length, 1); assert.equal(f.state.hooks.length, 1);
  assert.equal(result.jobs[0].status, "complete"); assert.equal(result.enabled, false); assert.equal(result.lastReason, "SEARCH_DEMAND_ACTIVATION_DISABLED");
  await f.scheduler.tick(); assert.equal(f.state.calls.length, 1);
});

test("revocation after a durable claim records zero dispatch without losing the conservative budget", async t => {
  let checks = 0; const f = await fixture(t, { getEnabled: async () => ++checks < 6 }); f.state.keywords = ["경남글램핑"];
  const result = await f.scheduler.tick(); assert.equal(f.state.calls.length, 0);
  const job = result.jobs[0]; assert.equal(job.status, "held"); assert.equal(job.errorCode, "SEARCH_DEMAND_ACTIVATION_STOPPED"); assert.equal(job.requestCount, 0); assert.equal(job.lastRequestCount, 0);
  const budget = JSON.parse(await fs.readFile(path.join(f.rootDir, "scheduler", "budgets", "datalab_2026-11-02.json"), "utf8")); assert.equal(budget.count, 1);
});

test("revocation before the claim leaves an explicit held receipt without a spent budget", async t => {
  let checks = 0; const f = await fixture(t, { getEnabled: async () => ++checks < 5 }); f.state.keywords = ["경남글램핑"];
  const result = await f.scheduler.tick(); assert.equal(f.state.calls.length, 0);
  const job = result.jobs[0]; assert.equal(job.status, "held"); assert.equal(job.errorCode, "SEARCH_DEMAND_ACTIVATION_STOPPED"); assert.equal(job.requestCount, 0); assert.equal(job.attempts, 0);
  await assert.rejects(fs.stat(path.join(f.rootDir, "scheduler", "budgets")), { code: "ENOENT" });
  await assert.rejects(fs.stat(path.join(f.rootDir, "scheduler", "claims")), { code: "ENOENT" });
});

test("before schedules is quiet without filesystem or provider work", async t => {
  const f = await fixture(t); f.state.now = Date.parse("2026-11-01T00:14:00.000Z");
  assert.equal((await f.scheduler.tick()).lastReason, "WAITING_FOR_SCHEDULE");
  assert.equal(f.scheduler.status().running, false);
  await assert.rejects(fs.stat(f.rootDir), { code: "ENOENT" }); assert.equal(f.state.calls.length, 0);
});

test("daily and monthly runs deduplicate registered keywords and retain12 completed months", async t => {
  const f = await fixture(t), result = await f.scheduler.tick();
  assert.equal(f.state.calls.length, 4); assert.equal(f.state.snapshots.length, 4); assert.equal(f.state.hooks.length, 4);
  assert.equal(result.jobs.every(row => row.status === "complete"), true);
  assert.equal(result.jobs.every(row => row.requestCount === 1 && row.lastRequestCount === 1 && row.startedAt && row.finishedAt), true);
  assert.equal(f.state.calls.filter(call => call.provider === "searchad").length, 2);
  for (const call of f.state.calls.filter(call => call.provider === "datalab")) {
    assert.equal(call.input.startDate, "2025-11-01"); assert.equal(call.input.endDate, "2026-10-31");
  }
  assert.equal(result.jobs.find(row => row.provider === "datalab").scheduledAt, "2026-11-01T23:30:00.000Z");
  assert.equal(result.jobs.find(row => row.provider === "searchad").scheduledAt, "2026-11-02T00:30:00.000Z");
  assert.equal(JSON.stringify(result).includes("sdscope_"), false);
  assert.equal(JSON.stringify(result).includes("credential"), false);
});

test("same-process overlapping ticks share the run and completed jobs survive a clean restart", async t => {
  const f = await fixture(t); await Promise.all([f.scheduler.tick(), f.scheduler.tick()]);
  assert.equal(f.state.calls.length, 4);
  await f.create().tick(); assert.equal(f.state.calls.length, 4); assert.equal(f.state.hooks.length, 4);
});

test("monthly occurs from the2nd at08:30 and daily only from09:30 in Korea", async t => {
  const f = await fixture(t); f.state.keywords = ["경남글램핑"];
  f.state.now = Date.parse("2026-11-01T00:30:00.000Z"); await f.scheduler.tick();
  assert.deepEqual(f.state.calls.map(call => call.provider), ["searchad"]);
  f.state.now = Date.parse("2026-11-01T23:29:00.000Z"); await f.scheduler.tick(); assert.equal(f.state.calls.length, 1);
  f.state.now = Date.parse("2026-11-01T23:30:00.000Z"); await f.scheduler.tick(); assert.equal(f.state.calls[1].provider, "datalab");
  f.state.now = Date.parse("2026-11-02T00:30:00.000Z"); await f.scheduler.tick(); assert.equal(f.state.calls[2].provider, "searchad");
});

test("separate provider budgets stop additional calls without weakening or spending the other budget", async t => {
  const f = await fixture(t, { dailyLimits: { searchad: 1, datalab: 2 } });
  const result = await f.scheduler.tick();
  assert.equal(f.state.calls.filter(call => call.provider === "searchad").length, 1);
  assert.equal(f.state.calls.filter(call => call.provider === "datalab").length, 2);
  assert.equal(result.jobs.filter(row => row.errorCode === "SEARCH_DEMAND_LOCAL_BUDGET_EXHAUSTED").length, 1);
});

test("AUTH and429 persist protection per credential scope and do not stop the other host", async t => {
  const f = await fixture(t); f.state.keywords = ["경남글램핑"];
  f.options.providers.searchad = async input => { f.state.calls.push({ provider: "searchad", input }); return { status: "blocked", errorCode: "QUOTA_EXCEEDED", observedAt: new Date(f.state.now).toISOString() }; };
  const first = await f.scheduler.tick(); assert.equal(first.providers.searchad.protected, true);
  f.state.now += 86400000; await f.create().tick();
  assert.equal(f.state.calls.filter(call => call.provider === "searchad").length, 1);
  assert.equal(f.state.calls.filter(call => call.provider === "datalab").length, 1, "successful monthly trend remains reused");
  f.state.scopes.searchad = { configured: true, scopeId: "sdscope_" + "b".repeat(64) };
  await f.create().tick(); assert.equal(f.state.calls.filter(call => call.provider === "searchad").length, 2, "a changed credential scope is distinct; no old protection is deleted");
});

test("incomplete monthly evidence is stored and retried at most once per day with a total bound", async t => {
  const f = await fixture(t); f.state.keywords = ["경남글램핑"];
  f.options.providers.datalab = async input => { f.state.calls.push({ provider: "datalab", input }); const result = f.result("datalab", input);
    return { ...result, status: "held", errorCode: "INCOMPLETE_DATA", snapshot: { ...result.snapshot, status: "partial" } }; };
  await f.scheduler.tick(); await f.scheduler.tick();
  assert.equal(f.state.calls.filter(call => call.provider === "datalab").length, 1);
  for (let day = 0; day < 4; day++) { f.state.now += 86400000; await f.create().tick(); }
  assert.equal(f.state.calls.filter(call => call.provider === "datalab").length, 3);
  assert.equal(f.state.snapshots.filter(snapshot => snapshot.provider === "datalab").length, 3);
});

test("forecast hook failure leaves the saved snapshot and never causes a provider retry", async t => {
  const f = await fixture(t, { onSnapshotCommitted: async () => { throw Object.assign(new Error("PRIVATE-HOOK-ERROR"), { code: "FORECAST_SOURCE_HELD" }); } });
  const first = await f.scheduler.tick();
  assert.equal(first.jobs.every(row => row.status === "complete" && row.postprocessStatus === "held" && row.postprocessErrorCode === "FORECAST_SOURCE_HELD"), true);
  assert.equal(f.state.snapshots.length, 4); await f.create().tick(); assert.equal(f.state.calls.length, 4);
  assert.equal(JSON.stringify(first).includes("PRIVATE"), false);
});

test("a held forecast return stays held while complete and reused returns confirm postprocessing", async t => {
  for (const outcome of [{ status: "held", reasonCode: "FORECAST_INPUTS_PARTIAL" }, { status: "complete" }, { status: "reused" }, undefined]) {
    const f = await fixture(t, { onSnapshotCommitted: async () => outcome });
    const first = await f.scheduler.tick();
    const completed = ["complete", "reused"].includes(outcome?.status);
    assert.equal(first.jobs.every(row => row.status === "complete" && row.postprocessStatus === (completed ? "complete" : "held")), true);
    if (outcome?.status === "held") assert.equal(first.jobs.every(row => row.postprocessErrorCode === "FORECAST_INPUTS_PARTIAL"), true);
    await f.create().tick(); assert.equal(f.state.calls.length, 4, "a held forecast does not refetch saved provider data");
  }
});

test("a complete provider receipt without its snapshot cannot finish the job", async t => {
  const f = await fixture(t); f.state.keywords = ["경남글램핑"];
  f.options.providers.searchad = async input => { f.state.calls.push({ provider: "searchad", input }); return { status: "complete", requestCount: 1, observedAt: new Date(f.state.now).toISOString() }; };
  const first = await f.scheduler.tick(), row = first.jobs.find(job => job.provider === "searchad");
  assert.equal(row.status, "needs_verification"); assert.equal(row.errorCode, "SEARCH_DEMAND_SNAPSHOT_MISSING");
  assert.equal(row.snapshotId, null); assert.equal(row.requestCount, 1);
  await f.create().tick(); assert.equal(f.state.calls.filter(call => call.provider === "searchad").length, 1);
});

test("subdirectory junctions cannot expose an outside protection record or dispatch a provider", async t => {
  const f = await fixture(t), directory = path.join(f.rootDir, "scheduler"), outside = path.join(f.parent, "outside-protection");
  await fs.mkdir(directory, { recursive: true }); await fs.mkdir(outside);
  for (const provider of ["searchad", "datalab"]) await fs.writeFile(path.join(outside, `${provider}_${scopeId}.json`), JSON.stringify({ schemaVersion: 1, provider, scopeId, errorCode: "AUTH_ERROR" }));
  const alias = path.join(directory, "protection");
  try { await fs.symlink(outside, alias, process.platform === "win32" ? "junction" : "dir"); }
  catch (error) { if (["EPERM", "ENOTSUP"].includes(error.code)) return t.skip("directory link creation unavailable"); throw error; }
  const opened = [], original = fs.open;
  t.mock.method(fs, "open", async function (file, ...rest) { opened.push(String(file)); return original.call(this, file, ...rest); });
  const result = await f.scheduler.tick();
  assert.equal(result.lastReason, "SEARCH_DEMAND_PATH_UNSAFE"); assert.equal(f.state.calls.length, 0);
  assert.equal(opened.some(file => file.startsWith(alias + path.sep)), false, "reject linked parents before opening any target file");
});

test("subdirectory junctions cannot expose outside budget or job records", async t => {
  for (const name of ["budgets", "jobs"]) {
    const f = await fixture(t), directory = path.join(f.rootDir, "scheduler"), outside = path.join(f.parent, "outside-" + name);
    await fs.mkdir(directory, { recursive: true }); await fs.mkdir(outside);
    const alias = path.join(directory, name);
    try { await fs.symlink(outside, alias, process.platform === "win32" ? "junction" : "dir"); }
    catch (error) { if (["EPERM", "ENOTSUP"].includes(error.code)) { t.diagnostic("directory link creation unavailable"); continue; } throw error; }
    const result = await f.scheduler.tick();
    assert.equal(result.lastReason, "SEARCH_DEMAND_PATH_UNSAFE"); assert.equal(f.state.calls.length, 0);
    assert.deepEqual(await fs.readdir(outside), [], "no outside write is introduced while checking the linked namespace");
  }
});

test("a parent replaced by a junction during a read is rejected even when the file identity remains", async t => {
  const f = await fixture(t); await f.scheduler.tick();
  const jobs = path.join(f.rootDir, "scheduler", "jobs"), detached = path.join(f.rootDir, "scheduler", "jobs-detached");
  const originalOpen = fs.open; let replaced = false, blockedCode = null;
  t.mock.method(fs, "open", async function (file, ...rest) {
    const handle = await originalOpen.call(this, file, ...rest);
    if (!replaced && String(file).startsWith(jobs + path.sep)) {
      const read = handle.readFile.bind(handle);
      handle.readFile = async (...arguments_) => {
        const bytes = await read(...arguments_);
        if (!replaced) {
          try {
            await fs.rename(jobs, detached);
            await fs.symlink(detached, jobs, process.platform === "win32" ? "junction" : "dir");
          } catch (error) { blockedCode = error.code; throw error; }
          replaced = true;
        }
        return bytes;
      };
    }
    return handle;
  });
  const result = await f.scheduler.history();
  if (!replaced && ["EPERM", "EACCES", "EBUSY"].includes(blockedCode)) return t.skip("OS prevents replacing a directory containing the open evidence file");
  assert.equal(replaced, true); assert.equal(result.status, "unavailable");
  assert.ok(["SEARCH_DEMAND_PATH_UNSAFE", "SEARCH_DEMAND_EVIDENCE_CHANGED"].includes(result.errorCode));
  assert.equal(result.items.length, 0); assert.equal(f.state.calls.length, 4);
});

test("the parent identity is rechecked after reading even if the evidence file metadata is unchanged", async t => {
  const f = await fixture(t); await f.scheduler.tick();
  const jobs = path.join(f.rootDir, "scheduler", "jobs"), originalOpen = fs.open, originalLstat = fs.lstat;
  let readFinished = false, checkedChangedParent = false;
  t.mock.method(fs, "open", async function (file, ...rest) {
    const handle = await originalOpen.call(this, file, ...rest);
    if (String(file).startsWith(jobs + path.sep)) {
      const read = handle.readFile.bind(handle);
      handle.readFile = async (...arguments_) => { const bytes = await read(...arguments_); readFinished = true; return bytes; };
    }
    return handle;
  });
  t.mock.method(fs, "lstat", async function (file, ...rest) {
    const metadata = await originalLstat.call(this, file, ...rest);
    if (readFinished && String(file) === jobs) {
      const changed = Object.create(metadata); Object.defineProperty(changed, "ino", { value: -1 }); checkedChangedParent = true; return changed;
    }
    return metadata;
  });
  const result = await f.scheduler.history();
  assert.equal(checkedChangedParent, true); assert.equal(result.status, "unavailable"); assert.equal(result.errorCode, "SEARCH_DEMAND_EVIDENCE_CHANGED");
  assert.equal(result.items.length, 0); assert.equal(f.state.calls.length, 4);
});

test("malformed persisted snapshot IDs and postprocess states fail closed without reflecting arbitrary text", async t => {
  const f = await fixture(t); await f.scheduler.tick();
  const jobs = path.join(f.rootDir, "scheduler", "jobs"), [name] = await fs.readdir(jobs), file = path.join(jobs, name), original = JSON.parse(await fs.readFile(file, "utf8"));
  for (const fields of [{ snapshotId: "PRIVATE_TEXT_DO_NOT_REFLECT" }, { snapshotId: null }, { postprocessStatus: "PRIVATE_TEXT_DO_NOT_REFLECT" }]) {
    await fs.writeFile(file, JSON.stringify({ ...original, ...fields }));
    const history = await f.scheduler.history(); assert.equal(history.status, "unavailable"); assert.equal(history.errorCode, "SEARCH_DEMAND_JOB_UNVERIFIED");
    assert.equal(JSON.stringify(history).includes("PRIVATE_TEXT"), false);
    assert.equal((await f.create().tick()).lastReason, "SEARCH_DEMAND_JOB_UNVERIFIED"); assert.equal(f.state.calls.length, 4);
  }
});

test("cross-process wx lock prevents a second scheduler instance dispatching the same source", async t => {
  const f = await fixture(t); let release, entered;
  f.state.keywords = ["경남글램핑"];
  const waiting = new Promise(resolve => { entered = resolve; });
  const original = f.options.providers.datalab;
  f.options.providers.datalab = async input => { entered(); await new Promise(resolve => { release = resolve; }); return original(input); };
  const running = f.scheduler.tick(); await waiting;
  const second = await f.create().tick(); assert.equal(second.lastReason, "SEARCH_DEMAND_BUSY");
  release(); await running; assert.equal(f.state.calls.length, 2);
});

test("a crash claim is held for verification rather than repeated after restart", async t => {
  const f = await fixture(t); await f.scheduler.tick();
  const directory = path.join(f.rootDir, "scheduler", "jobs"), names = await fs.readdir(directory);
  const target = path.join(directory, names[0]), record = JSON.parse(await fs.readFile(target, "utf8"));
  await fs.writeFile(target, JSON.stringify({ ...record, status: "running", requestCount: null, lastRequestCount: null, errorCode: null }));
  const after = await f.create().tick();
  assert.equal(after.jobs.some(row => row.errorCode === "SEARCH_DEMAND_INTERRUPTED_CLAIM"), true); assert.equal(f.state.calls.length, 4);
  assert.equal(after.jobs.find(row => row.errorCode === "SEARCH_DEMAND_INTERRUPTED_CLAIM").requestCount, null);
});

test("missing credentials never use another provider or dispatch a request", async t => {
  const f = await fixture(t); f.state.scopes.searchad = { configured: false, scopeId: null };
  const result = await f.scheduler.tick(); assert.equal(result.providers.searchad.errorCode, "MISSING_KEY");
  assert.equal(f.state.calls.every(call => call.provider === "datalab"), true);
});

test("history survives restart and filters saved jobs without credentials, writes or provider requests", async t => {
  const f = await fixture(t);
  assert.equal((await f.create({ enabled: false }).history()).status, "missing");
  await assert.rejects(fs.stat(f.rootDir), { code: "ENOENT" });
  await f.scheduler.tick();
  const jobsDir = path.join(f.rootDir, "scheduler", "jobs"), names = await fs.readdir(jobsDir);
  const before = await Promise.all(names.map(name => fs.readFile(path.join(jobsDir, name), "utf8")));
  const restarted = f.create({ enabled: false }), result = await restarted.history({ keyword: "경남 글램핑", day: "2026-11-02" });
  assert.equal(result.status, "ready"); assert.equal(result.items.length, 2); assert.equal(result.truncated, false);
  assert.equal(JSON.stringify(result).includes(scopeId), false); assert.equal(f.state.calls.length, 4);
  assert.deepEqual(await Promise.all(names.map(name => fs.readFile(path.join(jobsDir, name), "utf8"))), before);
  assert.equal((await restarted.history({ limit: 1 })).truncated, true);
  await assert.rejects(restarted.history({ day: "2026-02-30" }), error => error.code === "SEARCH_DEMAND_HISTORY_INPUT_INVALID");
});

test("stop lets the accepted request finish but prevents every subsequent provider dispatch", async t => {
  const f = await fixture(t); let entered, release;
  const waiting = new Promise(resolve => { entered = resolve; });
  const original = f.options.providers.datalab;
  f.options.providers.datalab = async input => { entered(); await new Promise(resolve => { release = resolve; }); return original(input); };
  const run = f.scheduler.tick(); await waiting; f.scheduler.stop(); release();
  const result = await run;
  assert.equal(result.enabled, false); assert.equal(result.running, false); assert.equal(f.state.calls.length, 1);
  assert.equal(f.state.snapshots.length, 1); await f.scheduler.tick(); assert.equal(f.state.calls.length, 1);
});

test("a captured daily cohort ignores late registration across restarts until the next normal day", async t => {
  const f = await fixture(t); f.state.keywords = ["경남글램핑"];
  await f.scheduler.tick(); assert.equal(f.state.calls.length, 2);
  f.state.keywords.push("가평글램핑"); await f.scheduler.tick(); await f.create().tick();
  assert.equal(f.state.calls.length, 2, "late additions never extend the current daily or monthly cohort");
  f.state.now += 86400000; const next = await f.create().tick();
  assert.equal(f.state.calls.filter(call => call.provider === "searchad").length, 3);
  assert.equal(f.state.calls.filter(call => call.provider === "datalab").length, 1);
  assert.equal(next.cohorts.searchad.keywordCount, 2); assert.equal(next.cohorts.datalab.keywordCount, 1);
  f.state.now = Date.parse("2026-12-02T00:31:00.000Z"); await f.create().tick();
  assert.equal(f.state.calls.filter(call => call.provider === "datalab").length, 3, "the new month takes the then-registered keyword list");
});

test("monthly and daily cohorts capture independently at08:30 and09:30", async t => {
  const f = await fixture(t); f.state.keywords = ["경남글램핑"]; f.state.now = Date.parse("2026-11-01T23:30:00.000Z");
  await f.scheduler.tick(); assert.equal(f.state.calls.length, 1); assert.equal(f.state.calls[0].provider, "datalab");
  f.state.keywords.push("가평글램핑"); f.state.now = Date.parse("2026-11-02T00:30:00.000Z");
  const daily = await f.create().tick();
  assert.equal(f.state.calls.length, 3); assert.equal(daily.cohorts.searchad.keywordCount, 2); assert.equal(daily.cohorts.datalab.keywordCount, 1);
});

test("even an empty cohort freezes the period so afternoon registration waits for the next cycle", async t => {
  const f = await fixture(t); f.state.keywords = []; f.state.now = Date.parse("2026-11-01T00:30:00.000Z");
  assert.equal((await f.scheduler.tick()).lastReason, "NO_REGISTERED_KEYWORDS");
  f.state.keywords.push("경남글램핑"); f.state.now += 3600000; await f.create().tick(); assert.equal(f.state.calls.length, 0);
  f.state.now = Date.parse("2026-11-02T00:30:00.000Z"); await f.create().tick(); assert.equal(f.state.calls.length, 2);
});

test("a missing exact stored snapshot is a verification hold and cannot be replaced by a newer run", async t => {
  const f = await fixture(t); await f.scheduler.tick();
  const restarted = f.create({ store: { ...f.options.store, readSnapshot: async () => null } });
  const result = await restarted.tick();
  assert.equal(result.jobs.every(row => row.status === "needs_verification" && row.errorCode === "SEARCH_DEMAND_SNAPSHOT_BINDING_UNVERIFIED"), true);
  assert.equal(f.state.calls.length, 4);
});
