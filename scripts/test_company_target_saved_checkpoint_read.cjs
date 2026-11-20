"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { createAnalyticalWorkScheduler } = require("./lib/analytical_work_scheduler.cjs");
const { createCompanyIntegratedTargets } = require("./lib/company_integrated_targets.cjs");
const { runNonInterruptibleCooperativeWork } = require("./lib/cooperative_work_checkpoint.cjs");
const { createKeywordMonthlySavedReadService } = require("./lib/keyword_monthly_saved_read_service.cjs");
const { createKeywordMonthlyMemoryAdmission } = require("./lib/keyword_monthly_memory_admission.cjs");
const { EventEmitter } = require("node:events");
const gate = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const turn = () => new Promise(resolve => setImmediate(resolve));
async function until(condition) { for (let n = 0; n < 100; n++) { if (condition()) return; await turn(); } assert.fail("bounded fixture did not settle"); }
function clock() {
  let at = 0; const timers = new Map();
  return { now: () => at, timers,
    setTimeoutImpl(fn, ms) { const handle = { unref() {} }; timers.set(handle, { fn, at: at + ms }); return handle; },
    clearTimeoutImpl: handle => timers.delete(handle),
    async advance(ms) { at += ms; for (const [handle, timer] of [...timers]) if (timer.at <= at) { timers.delete(handle); timer.fn(); } for (let n = 0; n < 8; n++) await turn(); } };
}
function socket() { const response = new EventEmitter(); response.writeHead = response.end = () => {}; response.finish = () => response.emit("finish"); return response; }
function reader(scheduler, runMemoryAdmission = operation => operation(), savedRead = () => ({ status: "available", snapshot: { actualZero: 0, unobserved: null } })) {
  let reads = 0;
  const service = createKeywordMonthlySavedReadService({ saved: { options: () => ({}), analyze: () => assert.fail("no source fallback"),
    readPrepared: () => { reads++; return savedRead(); } }, runWork: (operation, options) => scheduler.run(operation, options),
    acquirePermit: () => scheduler.acquireSavedReadPermit(), assertReadAdmission: async () => {}, runMemoryAdmission });
  return { service, reads: () => reads, run(response = {}) {
    return service.withResponse("synthetic-target-scope", response, async () => {
      const lifecycle = service.lifecycleOptions();
      try { return await service.withProducer(() => service.readPrepared({})); } finally { lifecycle.onOperationSettled(); }
    });
  } };
}
function discovery() {
  const entered = gate(), proceed = gate(); let headers = 0;
  const targets = createCompanyIntegratedTargets({ dataDir: "/synthetic-unused", readRevision: async () => "frozen-revision",
    catalog: async () => ({ rawCompanies: new Map([["company-1", { companyId: "company-1", placeIds: ["place-1"] }]]), runs: [] }),
    observationIndex: { readRows() { assert.fail("header-only discovery must not parse full rows"); },
      async readHeaders(_options, consume) {
        entered.resolve(); await proceed.promise;
        for (let index = 0; index < 40; index++) {
          headers++; await consume({ companyId: "company-1", date: "2026-11-01", runId: "synthetic-run" });
        }
      } } });
  return { targets, entered, proceed, headers: () => headers };
}

test("company-job-prepare loans only its existing target checkpoint while retaining exclusive source ownership", async () => {
  const scheduler = createAnalyticalWorkScheduler({ cooperativeYield: true, cooperativeCompanyMonthYield: true });
  const source = discovery(); let sourceAlive = false, sourceFinished = false, peerRan = false, permit;
  const work = scheduler.run(async () => {
    sourceAlive = true;
    try { return await source.targets({ companyIds: ["company-1"] }); }
    finally { sourceAlive = false; sourceFinished = true; }
  }, { kind: "company-job-prepare", priority: "background" });
  let peer;
  try {
    await source.entered.promise;
    permit = scheduler.acquireSavedReadPermit();
    const reading = permit.run(() => {
      assert.equal(sourceAlive, true); assert.equal(sourceFinished, false); assert.equal(peerRan, false);
      return { actualZero: 0, unobserved: null };
    });
    peer = scheduler.run(() => { assert.equal(sourceAlive, false); peerRan = true; });
    await turn(); assert.equal(scheduler.status().timing.checkpointReadStarted, 0, "an arbitrary header-read await cannot lend");
    source.proceed.resolve();
    assert.deepEqual(await reading, { actualZero: 0, unobserved: null });
    assert.equal(sourceFinished, false); assert.equal(peerRan, false);
    assert.equal(scheduler.status().cooperative.activeEligible, false, "discovery has loan authority, never yield/restart authority");
    permit.release(); await permit.waitForRelease();
    assert.deepEqual(await work, [{ companyId: "company-1", months: ["2026-11"] }]); await peer;
    assert.equal(scheduler.status().timing.restarted, 0); assert.equal(scheduler.status().timing.yielded, 0);
    assert.equal(scheduler.status().checkpointWaitDiagnostics.recent.at(-1).ownerKind, "company-job-prepare");
  } finally {
    source.proceed.resolve(); try { permit?.release(); } catch {}
    try { await permit?.waitForRelease(); } catch {}
    await work; await peer; await scheduler.close();
  }
});

test("unknown, foreground and explicitly disabled target owners still cannot reserve a saved read", async () => {
  for (const option of [{ kind: "company-bootstrap" }, { kind: "source-targets" }, { kind: "company-job-prepare", priority: "foreground" },
    { kind: "company-job-prepare", sourceMetadataSavedReads: false }]) {
    const scheduler = createAnalyticalWorkScheduler({ cooperativeYield: true, sourceMetadataSavedReads: option.sourceMetadataSavedReads ?? true });
    const entered = gate(), leave = gate();
    const work = scheduler.run(async () => { entered.resolve(); await leave.promise; }, { kind: option.kind, priority: option.priority || "background" });
    try {
      await entered.promise;
      assert.throws(() => scheduler.acquireSavedReadPermit(), error => error.readGuard?.reason === "ineligible_owner");
      assert.equal(scheduler.status().queuedCheckpointReads, 0);
    } finally { leave.resolve(); await work; await scheduler.close(); }
  }
});

test("target discovery still honors the original 1500ms deadline and cannot release a started loan by that clock", async () => {
  for (const elapsed of [1499, 1500]) {
    const time = clock(), scheduler = createAnalyticalWorkScheduler({ ...time, sourceMetadataSavedReads: true }), source = discovery();
    const work = scheduler.run(() => source.targets({}), { kind: "company-job-prepare", priority: "background" });
    let permit, calls = 0;
    try {
      await source.entered.promise; permit = scheduler.acquireSavedReadPermit();
      const request = permit.run(() => { calls++; return 0; });
      if (elapsed === 1500) {
        const rejected = assert.rejects(request, error => error.readGuard?.reason === "checkpoint_expired" && error.readGuard.activeKind === "company-job-prepare");
        await time.advance(elapsed); await rejected; assert.equal(calls, 0); source.proceed.resolve();
      } else {
        await time.advance(elapsed); assert.equal(calls, 0); source.proceed.resolve(); assert.equal(await request, 0);
        await time.advance(10000); assert.equal(scheduler.status().savedRead.active, true);
        permit.release(); await permit.waitForRelease(); assert.equal(calls, 1);
      }
      await work; assert.equal(scheduler.status().timing.restarted, 0);
    } finally {
      source.proceed.resolve(); try { permit?.release(); } catch {}
      try { await permit?.waitForRelease(); } catch {}
      await work; await scheduler.close(); assert.equal(time.timers.size, 0);
    }
  }
});

test("a target checkpoint inside atomic work cannot lend and atomic exit is not a generic await loan", async () => {
  const scheduler = createAnalyticalWorkScheduler({ sourceMetadataSavedReads: true }), source = discovery();
  const atomicFinished = gate(), laterBoundary = gate(); let permit, calls = 0;
  const work = scheduler.run(async () => {
    await runNonInterruptibleCooperativeWork(() => source.targets({})); atomicFinished.resolve();
    await laterBoundary.promise;
    return source.targets({ runId: "synthetic-run" });
  }, { kind: "company-job-prepare", priority: "background" });
  try {
    await source.entered.promise; permit = scheduler.acquireSavedReadPermit();
    const request = permit.run(() => { calls++; return 1; }); source.proceed.resolve();
    await atomicFinished.promise; await turn(); assert.equal(calls, 0);
    assert.equal(scheduler.status().savedRead.checkpointPending, true);
    laterBoundary.resolve(); assert.equal(await request, 1); permit.release(); await permit.waitForRelease(); await work;
  } finally {
    source.proceed.resolve(); laterBoundary.resolve(); try { permit?.release(); } catch {}
    try { await permit?.waitForRelease(); } catch {}
    await work; await scheduler.close();
  }
});

test("owner completion cannot transfer the target reservation to an idle or replacement owner", async () => {
  const scheduler = createAnalyticalWorkScheduler({ sourceMetadataSavedReads: true }), entered = gate(), finish = gate();
  const work = scheduler.run(async () => { entered.resolve(); await finish.promise; }, { kind: "company-job-prepare", priority: "background" });
  let permit, replacement, calls = 0;
  try {
    await entered.promise; permit = scheduler.acquireSavedReadPermit(); const request = permit.run(() => { calls++; });
    const rejected = assert.rejects(request, error => error.readGuard?.reason === "owner_changed");
    replacement = scheduler.run(() => { assert.equal(calls, 0); return 1; }, { kind: "company-job-prepare", priority: "background" });
    finish.resolve(); await work; await rejected; permit.release(); assert.equal(await replacement, 1); assert.equal(calls, 0);
  } finally { finish.resolve(); try { permit?.release(); } catch {} try { await permit?.waitForRelease(); } catch {} await work; await replacement; await scheduler.close(); }
});

test("canceling a target reservation removes it without canceling or replaying the discovery", async () => {
  const scheduler = createAnalyticalWorkScheduler({ sourceMetadataSavedReads: true }), source = discovery();
  const work = scheduler.run(() => source.targets({}), { kind: "company-job-prepare", priority: "background" });
  let permit, calls = 0;
  try {
    await source.entered.promise; permit = scheduler.acquireSavedReadPermit(); const request = permit.run(() => { calls++; });
    const rejected = assert.rejects(request, error => error.readGuard?.reason === "checkpoint_aborted");
    permit.release(); await rejected; assert.equal(scheduler.status().queuedCheckpointReads, 0);
    source.proceed.resolve(); assert.deepEqual(await work, [{ companyId: "company-1", months: ["2026-11"] }]);
    assert.equal(calls, 0); assert.equal(scheduler.status().timing.restarted, 0);
  } finally { source.proceed.resolve(); try { permit?.release(); } catch {} try { await permit?.waitForRelease(); } catch {} await work; await scheduler.close(); }
});

test("an aborted target owner cannot admit the reserved read at a later discovery checkpoint", async () => {
  const scheduler = createAnalyticalWorkScheduler({ sourceMetadataSavedReads: true }), source = discovery(), cancel = new AbortController();
  const work = scheduler.run(() => source.targets({}), { kind: "company-job-prepare", priority: "background", signal: cancel.signal });
  let permit, calls = 0;
  try {
    await source.entered.promise; permit = scheduler.acquireSavedReadPermit(); const request = permit.run(() => { calls++; });
    const rejected = assert.rejects(request, error => error.readGuard?.reason === "owner_aborted");
    cancel.abort(); source.proceed.resolve(); await rejected; permit.release(); await permit.waitForRelease().catch(() => {}); await work;
    assert.equal(calls, 0); assert.equal(scheduler.status().timing.restarted, 0);
  } finally { source.proceed.resolve(); try { permit?.release(); } catch {} try { await permit?.waitForRelease(); } catch {} await work; await scheduler.close(); }
});

test("the unchanged memory admission runs before target-owner saved DTO allocation", async () => {
  const time = clock(), scheduler = createAnalyticalWorkScheduler({ ...time, sourceMetadataSavedReads: true }), source = discovery();
  const work = scheduler.run(() => source.targets({}), { kind: "company-job-prepare", priority: "background" });
  let ratio = .3;
  const memory = createKeywordMonthlyMemoryAdmission({ now: time.now, sampleMemory: () => ({ ratio, sampledAt: time.now() }) });
  const read = reader(scheduler, memory.run);
  try {
    await source.entered.promise; const request = read.run();
    const rejected = assert.rejects(request, error => error.readGuard?.reason === "high_watermark" && error.code === "KEYWORD_MONTHLY_MEMORY_DEFERRED");
    await until(() => scheduler.status().savedRead.checkpointPending); ratio = .66; source.proceed.resolve(); await rejected;
    assert.equal(read.reads(), 0); await work;
    assert.equal(memory.status().highWatermark, .65); assert.equal(memory.status().lowWatermark, .55); assert.equal(memory.status().resumeSamples, 2);
    ratio = .54;
    await assert.rejects(memory.run(() => assert.fail("one low sample cannot allocate")), error => error.readGuard?.reason === "low_watermark_recovery_pending");
    assert.equal(await memory.run(() => 1), 1);
  } finally { source.proceed.resolve(); await work; await scheduler.close(); }
});

test("every response holder and ignored producer cleanup retains the discovery checkpoint loan", async () => {
  const scheduler = createAnalyticalWorkScheduler({ sourceMetadataSavedReads: true }), source = discovery();
  const work = scheduler.run(() => source.targets({}), { kind: "company-job-prepare", priority: "background" });
  const readEntered = gate(), finishRead = gate();
  const read = reader(scheduler, operation => operation(), async () => { readEntered.resolve(); await finishRead.promise; return { status: "available", snapshot: { actualZero: 0, unobserved: null } }; });
  const first = socket(), second = socket(); let finished = false; work.then(() => { finished = true; });
  try {
    await source.entered.promise; const request = read.run(first); await until(() => scheduler.status().savedRead.checkpointPending);
    source.proceed.resolve(); await readEntered.promise;
    const joined = read.service.withResponse("synthetic-target-scope", second, async () => { await finishRead.promise; return 2; });
    first.finish(); await turn(); assert.equal(finished, false); assert.equal(read.service.status().producers, 1);
    finishRead.resolve(); await request; await joined; await turn();
    assert.equal(finished, false); assert.equal(scheduler.status().savedRead.active, true);
    second.finish(); await work; assert.equal(finished, true); assert.equal(read.reads(), 1);
    assert.equal(read.service.status().responseOwners, 0); assert.equal(read.service.status().producers, 0);
  } finally { source.proceed.resolve(); finishRead.resolve(); first.finish(); second.finish(); await work; await scheduler.close(); }
});

test("catalog revision and a Promise.all index-only wait never become generic loan windows", async () => {
  for (const stage of ["catalog", "revision", "index_sibling"]) {
    const time = clock(), scheduler = createAnalyticalWorkScheduler({ ...time, sourceMetadataSavedReads: true });
    const entered = gate(), proceed = gate(); let permit, calls = 0;
    const empty = { rawCompanies: new Map(), runs: [] };
    const targets = createCompanyIntegratedTargets({ dataDir: "/synthetic-unused", catalog: async () => {
      if (stage === "catalog") { entered.resolve(); await proceed.promise; }
      return empty;
    }, readRevision: async () => {
      if (stage === "revision") { entered.resolve(); await proceed.promise; }
      return "frozen-revision";
    }, observationIndex: { readRows() { assert.fail("no raw row read"); }, async readHeaders() {} } });
    const work = scheduler.run(() => stage === "index_sibling"
      // Shape of targetsFor: after target discovery is complete, a pending
      // independent index read cannot lend merely because Promise.all awaits it.
      ? Promise.all([targets({}).then(result => { entered.resolve(); return result; }), proceed.promise])
      : targets({}), { kind: "company-job-prepare", priority: "background" });
    try {
      await entered.promise; permit = scheduler.acquireSavedReadPermit(); const request = permit.run(() => { calls++; });
      const rejected = assert.rejects(request, error => error.readGuard?.reason === "checkpoint_expired");
      await turn(); assert.equal(calls, 0, stage);
      await time.advance(1500); await rejected; assert.equal(calls, 0, stage);
      permit.release(); proceed.resolve(); await work;
      assert.equal(scheduler.status().timing.checkpointReadStarted, 0, stage);
    } finally {
      proceed.resolve(); try { permit?.release(); } catch {} try { await permit?.waitForRelease(); } catch {}
      await work; await scheduler.close(); assert.equal(time.timers.size, 0);
    }
  }
});
