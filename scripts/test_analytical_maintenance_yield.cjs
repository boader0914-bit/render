"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { createAnalyticalWorkScheduler } = require("./lib/analytical_work_scheduler.cjs");
const { cooperativeWorkCheckpoint, setCooperativeWorkPhase, runNonInterruptibleCooperativeWork, runCooperativeCheckpointReads } = require("./lib/cooperative_work_checkpoint.cjs");
const turn = () => new Promise(resolve => setImmediate(resolve)), flush = async () => { for (let n = 0; n < 6; n++) await turn(); };
const gate = () => { let resolve, reject; const promise = new Promise((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; };
function clock() { let at = 0; const timers = new Map(); return { now: () => at,
  setTimeoutImpl(fn, ms) { const handle = { unref() {} }; timers.set(handle, { fn, due: at + ms }); return handle; }, clearTimeoutImpl: handle => timers.delete(handle),
  async advance(ms) { at += ms; for (const [handle, value] of [...timers]) if (value.due <= at) { timers.delete(handle); value.fn(); } await flush(); }, timers: () => timers.size }; }
const industry = { priority: "background", kind: "industry-build" }, company = { priority: "background", kind: "company-month" };

for (const [name, scope] of [["industry", industry], ["company", company]]) test(`active ${name} yields to maintenance only after its finally cleanup and resumes the original promise`, async () => {
  const c = clock(), entered = gate(), resume = gate(), cleaning = gate(), cleaned = gate(); let hold = false, checks = 0, attempts = 0, owners = 0, settled = false;
  const scheduler = createAnalyticalWorkScheduler({ ...c, cooperativeYield: true, cooperativeCompanyMonthYield: true, cooperativeMinRunMs: 10000,
    externalAdmission: async () => { checks++; return { allowed: !hold, reasonCode: "KEYWORD_INCREMENTAL_PREPARED_CONVERSION_ACTIVE" }; } });
  const work = scheduler.run(async () => { const attempt = ++attempts; owners++;
    try { if (attempt === 1) { for (let n = 0; n < 20; n++) cooperativeWorkCheckpoint(); entered.resolve(); await resume.promise; cooperativeWorkCheckpoint(); } return "latest"; }
    finally { if (attempt === 1) { cleaning.resolve(); await cleaned.promise; } owners--; }
  }, scope).then(value => { settled = true; return value; });
  await entered.promise; assert.equal(checks, 1); hold = true;
  await c.advance(999); assert.equal(checks, 1); await c.advance(1); assert.equal(checks, 2);
  assert.equal(scheduler.status().maintenance.paused, true); assert.equal(scheduler.status().active, true);
  resume.resolve(); await cleaning.promise; await flush(); assert.equal(owners, 1); assert.equal(scheduler.status().active, true); assert.equal(settled, false);
  cleaned.resolve(); await flush(); assert.equal(owners, 0); assert.equal(scheduler.status().active, false); assert.equal(scheduler.status().queuedBackground, 1); assert.equal(attempts, 1); assert.equal(settled, false);
  hold = false; await c.advance(1000); assert.equal(await work, "latest"); assert.equal(attempts, 2);
  assert.equal(scheduler.status().timing.yielded, 1); assert.equal(scheduler.status().timing.failed, 0); await scheduler.close(); assert.equal(c.timers(), 0);
});

test("maintenance detected inside an atomic publication waits for the existing whole publication", async () => {
  const c = clock(), entered = gate(), resume = gate(); let hold = false, attempts = 0, publications = 0, foregroundRan = false;
  const scheduler = createAnalyticalWorkScheduler({ ...c, cooperativeYield: true, cooperativeMinRunMs: 0, externalAdmission: async () => ({ allowed: !hold }) });
  const work = scheduler.run(() => runNonInterruptibleCooperativeWork(async () => { attempts++; entered.resolve(); await resume.promise;
    cooperativeWorkCheckpoint(); await turn(); cooperativeWorkCheckpoint(); publications++; return "published"; }), industry);
  await entered.promise; hold = true; await c.advance(1000); const foreground = scheduler.run(() => { foregroundRan = true; });
  await flush(); assert.equal(scheduler.status().maintenance.paused, true); assert.equal(scheduler.status().active, true); resume.resolve();
  assert.equal(await work, "published"); await flush(); assert.equal(publications, 1); assert.equal(attempts, 1); assert.equal(foregroundRan, false); assert.equal(scheduler.status().timing.yielded, 0);
  hold = false; await c.advance(1000); await foreground; assert.equal(foregroundRan, true); await scheduler.close();
});

test("a hung active-owner admission check is single-owned, yields safely on timeout, and rejects its late allow", async () => {
  const c = clock(), entered = gate(), resume = gate(), admission = gate(); let checks = 0, attempts = 0;
  const scheduler = createAnalyticalWorkScheduler({ ...c, cooperativeYield: true, cooperativeMinRunMs: 0, externalAdmissionTimeoutMs: 50,
    externalAdmission: () => ++checks === 2 ? admission.promise : { allowed: true } });
  const work = scheduler.run(async () => { if (++attempts === 1) { entered.resolve(); await resume.promise; cooperativeWorkCheckpoint(); } return "done"; }, industry);
  await entered.promise; await c.advance(1000); assert.equal(checks, 2); await c.advance(50);
  assert.equal(scheduler.status().maintenance.paused, true); assert.equal(scheduler.status().maintenance.checking, true);
  resume.resolve(); await flush(); assert.equal(scheduler.status().active, false); assert.equal(attempts, 1);
  await c.advance(10000); assert.equal(checks, 2); admission.resolve({ allowed: true }); await flush(); assert.equal(attempts, 1);
  await c.advance(1000); assert.equal(await work, "done"); assert.equal(checks, 3); await scheduler.close(); assert.equal(c.timers(), 0);
});

test("ordinary owners and disabled cooperative kinds are never polled or interrupted while active", async () => {
  for (const scope of [{ priority: "foreground", kind: "industry-build" }, { priority: "background", kind: "company-bootstrap" }, company]) {
    const c = clock(), entered = gate(), resume = gate(); let checks = 0;
    const scheduler = createAnalyticalWorkScheduler({ ...c, cooperativeYield: true, externalAdmission: async () => { checks++; return { allowed: true }; } });
    const work = scheduler.run(async () => { entered.resolve(); await resume.promise; cooperativeWorkCheckpoint(); return 1; }, scope);
    await entered.promise; await c.advance(5000); assert.equal(checks, 1); resume.resolve(); assert.equal(await work, 1); await scheduler.close(); assert.equal(c.timers(), 0);
  }
});

test("closing with an active check aborts the owner and no late allow can restart it", async () => {
  const c = clock(), entered = gate(), admission = gate(); let checks = 0, attempts = 0;
  const scheduler = createAnalyticalWorkScheduler({ ...c, cooperativeYield: true, externalAdmission: () => ++checks === 2 ? admission.promise : { allowed: true } });
  const work = scheduler.run(info => new Promise((resolve, reject) => { attempts++; entered.resolve(); info.signal.addEventListener("abort", () => reject(Object.assign(Error("aborted"), { code: "ANALYTICAL_WORK_ABORTED" })), { once: true }); }), industry);
  const rejected = assert.rejects(work, { code: "ANALYTICAL_WORK_ABORTED" }); await entered.promise; await c.advance(1000); assert.equal(scheduler.status().maintenance.checking, true);
  await scheduler.close(); await rejected; assert.equal(c.timers(), 0); admission.resolve({ allowed: true }); await flush(); assert.equal(attempts, 1); assert.equal(scheduler.status().maintenance.checking, false);
});

test("a maintenance hold during one borrowed read waits its cleanup but prevents the next borrowed read", async () => {
  const c = clock(), entered = gate(), resume = gate(), firstRead = gate(), finishFirst = gate(); let hold = false, secondStarted = false, attempts = 0;
  const scheduler = createAnalyticalWorkScheduler({ ...c, cooperativeYield: true, cooperativeMinRunMs: 0, externalAdmission: async () => ({ allowed: !hold }) });
  const work = scheduler.run(async () => { if (++attempts === 1) { entered.resolve(); await resume.promise; await runCooperativeCheckpointReads(); cooperativeWorkCheckpoint(); } return "done"; }, industry);
  await entered.promise;
  const first = scheduler.runCheckpointRead(async () => { firstRead.resolve(); await finishFirst.promise; return "first"; });
  const second = scheduler.runCheckpointRead(() => { secondStarted = true; return "second"; });
  resume.resolve(); await firstRead.promise; hold = true; await c.advance(1000);
  assert.equal(scheduler.status().maintenance.paused, true); assert.equal(scheduler.status().activeCheckpointReadKind, "company-month-cached-verification");
  finishFirst.resolve(); assert.equal(await first, "first"); await flush();
  assert.equal(secondStarted, false); assert.equal(scheduler.status().active, false); assert.equal(scheduler.status().queuedCheckpointReads, 1);
  hold = false; await c.advance(1000); assert.equal(await second, "second"); assert.equal(await work, "done"); await scheduler.close();
});

test("maintenance can stop an early replay without lowering its prior foreground fairness fence", async () => {
  const c = clock(), entries = [gate(), gate(), gate()], resumes = [gate(), gate(), gate()]; let hold = false, attempts = 0, passedEarly = false;
  const scheduler = createAnalyticalWorkScheduler({ ...c, cooperativeYield: true, cooperativeMinRunMs: 0, externalAdmission: async () => ({ allowed: !hold }) });
  const work = scheduler.run(async () => { const attempt = attempts++; if (attempt < 3) {
    setCooperativeWorkPhase(attempt === 0 ? 70 : attempt === 1 ? 10 : 20); cooperativeWorkCheckpoint(); entries[attempt].resolve(); await resumes[attempt].promise;
    cooperativeWorkCheckpoint(); if (attempt === 2) { passedEarly = true; setCooperativeWorkPhase(80); cooperativeWorkCheckpoint(); }
  } return "done"; }, industry);
  for (let n = 0; n < 2; n++) { await entries[n].promise; hold = true; await c.advance(1000); resumes[n].resolve(); await flush(); assert.equal(scheduler.status().active, false);
    hold = false; await c.advance(1000); }
  await entries[2].promise; const foreground = scheduler.run(() => assert.equal(passedEarly, true)); resumes[2].resolve(); await foreground; assert.equal(await work, "done");
  assert.equal(attempts, 4); assert.equal(scheduler.status().timing.yielded, 3); await scheduler.close();
});
