"use strict";

const test = require("node:test"), assert = require("node:assert/strict");
const { createAnalyticalWorkScheduler } = require("./lib/analytical_work_scheduler.cjs");
const { createSourceReadScheduler } = require("./lib/source_read_scheduler.cjs");
const { setCooperativeWorkStage, setCooperativeWorkPhase, setCooperativeWorkRevision,
  cooperativeWorkCheckpoint, assertCooperativeWorkActive, runNonInterruptibleCooperativeWork,
  YIELD_CODE } = require("./lib/cooperative_work_checkpoint.cjs");
const gate = () => { let resolve; return { promise: new Promise(done => { resolve = done; }), resolve: () => resolve() }; };
const turn = () => new Promise(resolve => setImmediate(resolve));
const company = { priority: "background", kind: "company-month" };
const create = options => createAnalyticalWorkScheduler({ cooperativeCompanyMonthYield: true, cooperativeMinRunMs: 0, ...options });

test("company-month yielding is an explicit opt-in and never applies to foreground repair or unrelated maintenance", async () => {
  for (const [enabled, priority, kind] of [[false, "background", "company-month"], [true, "foreground", "company-month"],
    [true, "foreground", "company-month-repair"], [true, "background", "company-job-prepare"], [true, "background", "company-bootstrap"]]) {
    const scheduler = create({ cooperativeCompanyMonthYield: enabled }), entered = gate(), resume = gate(); let attempts = 0;
    const work = scheduler.run(async () => { attempts++; entered.resolve(); await resume.promise; cooperativeWorkCheckpoint(); return 5; }, { priority, kind });
    await entered.promise; const foreground = scheduler.run(() => 7); resume.resolve();
    assert.equal(await work, 5); assert.equal(await foreground, 7); assert.equal(attempts, 1);
    assert.equal(scheduler.status().timing.yielded, 0); await scheduler.close();
  }
  assert.throws(() => create({ cooperativeCompanyMonthYield: "yes" }), TypeError);
});

test("current and comparison month stages maintain stable progress across short cached source replays", async () => {
  const scheduler = create(), entered = [gate(), gate(), gate()], resume = [gate(), gate(), gate()]; let attempts = 0;
  const work = scheduler.run(async () => {
    const attempt = attempts++; setCooperativeWorkRevision("private-original-and-review");
    setCooperativeWorkStage(1); setCooperativeWorkPhase(70, 4);
    for (let index = 0; index < (attempt === 0 ? 1000 : 1); index++) cooperativeWorkCheckpoint();
    entered[attempt].resolve(); await resume[attempt].promise;
    if (attempt === 0) cooperativeWorkCheckpoint();
    else {
      cooperativeWorkCheckpoint(); assert.equal(scheduler.status().cooperative.yieldRequested, false);
      setCooperativeWorkStage(2); setCooperativeWorkPhase(10);
      assert.equal(scheduler.status().cooperative.activePhaseIndex, 10);
      setCooperativeWorkStage(1); setCooperativeWorkStage(2); setCooperativeWorkPhase(0);
      assert.equal(scheduler.status().cooperative.activeStageIndex, 2);
      assert.equal(scheduler.status().cooperative.activePhaseIndex, 10);
      cooperativeWorkCheckpoint();
    }
    return "complete";
  }, company);
  for (let index = 0; index < 2; index++) {
    await entered[index].promise; const foreground = scheduler.run(() => index); resume[index].resolve(); assert.equal(await foreground, index);
  }
  await entered[2].promise; resume[2].resolve(); assert.equal(await work, "complete");
  const status = scheduler.status(), yields = status.timing.recent.filter(row => row.outcome === "yielded");
  assert.deepEqual(yields.map(row => [row.stageIndex, row.phaseIndex]), [[1, 70], [2, 10]]);
  assert.deepEqual(yields[1].progressHighWater, { stageIndex: 1, phaseIndex: 70, unitIndex: 4, checkpoints: 1001 });
  assert.equal(attempts, 3); assert.equal(status.timing.failed, 0); assert.equal(status.cooperative.companyMonthEnabled, true);
  assert.equal(status.cooperative.enabled, true); assert.equal(status.cooperative.industryEnabled, false);
  assert.doesNotMatch(JSON.stringify(status), /private-original-and-review/); await scheduler.close();
});

test("the original company promise stays pending until cleanup and one whole publication complete", async () => {
  const scheduler = create(), source = createSourceReadScheduler(), entered = gate(), resume = gate(), cleaning = gate(), clean = gate();
  let attempts = 0, graphOwners = 0, writerOwners = 0, publications = 0, ready = false; const order = [];
  const work = scheduler.run(async () => {
    const attempt = ++attempts;
    const result = await source.run(async () => {
      graphOwners++; setCooperativeWorkStage(1);
      try {
        if (attempt === 1) { entered.resolve(); await resume.promise; }
        await source.checkpoint({ priority: "background" }); return { valid: true };
      } finally {
        if (attempt === 1) { cleaning.resolve(); await clean.promise; }
        graphOwners--; order.push("source-clean");
      }
    }, { priority: "background" });
    setCooperativeWorkStage(4); assertCooperativeWorkActive();
    return runNonInterruptibleCooperativeWork(async () => {
      writerOwners++;
      try { order.push("index-write"); cooperativeWorkCheckpoint(); order.push("month-write"); publications++; return result; }
      finally { writerOwners--; }
    });
  }, company).then(value => { ready = true; return value; });
  await entered.promise;
  const foreground = scheduler.run(() => {
    assert.equal(graphOwners, 0); assert.equal(writerOwners, 0); assert.equal(source.status().active, false);
    assert.equal(ready, false); assert.equal(publications, 0); order.push("foreground");
  }, { kind: "company-month-proof-read" });
  resume.resolve(); await cleaning.promise; await turn(); assert.equal(ready, false); assert.equal(graphOwners, 1);
  clean.resolve(); await foreground; assert.deepEqual(await work, { valid: true });
  assert.equal(attempts, 2); assert.equal(publications, 1); assert.equal(ready, true);
  assert.deepEqual(order, ["source-clean", "foreground", "source-clean", "index-write", "month-write"]);
  assert.equal(scheduler.status().timing.failed, 0); await scheduler.close();
});

test("a changed revision permits new early company progress without exposing the earlier stage or source identity", async () => {
  const scheduler = create(), entered = [gate(), gate(), gate()], resume = [gate(), gate(), gate()]; let attempts = 0;
  const work = scheduler.run(async () => {
    const attempt = attempts++; setCooperativeWorkRevision(attempt ? "fresh-review" : "old-review");
    setCooperativeWorkStage(attempt ? 1 : 4); setCooperativeWorkPhase(attempt ? 10 : 70);
    entered[attempt].resolve(); await resume[attempt].promise; cooperativeWorkCheckpoint(); return 9;
  }, company);
  for (let index = 0; index < 2; index++) {
    await entered[index].promise; const foreground = scheduler.run(() => index); resume[index].resolve(); await foreground;
  }
  await entered[2].promise; resume[2].resolve(); assert.equal(await work, 9);
  const status = scheduler.status(); assert.equal(status.timing.progressRevisionResets, 1);
  assert.deepEqual(status.timing.recent.filter(row => row.outcome === "yielded").map(row => row.stageIndex), [4, 1]);
  assert.doesNotMatch(JSON.stringify(status), /old-review|fresh-review/); await scheduler.close();
});

test("a company publication that already owns its atomic fence finishes before admitting a reader", async () => {
  const scheduler = create(), entered = gate(), resume = gate(), order = []; let attempts = 0;
  const work = scheduler.run(async () => {
    attempts++; setCooperativeWorkStage(4);
    return runNonInterruptibleCooperativeWork(async () => {
      entered.resolve(); await resume.promise;
      cooperativeWorkCheckpoint(); order.push("index"); await turn(); cooperativeWorkCheckpoint(); order.push("month"); return "ready";
    });
  }, company);
  await entered.promise; const foreground = scheduler.run(() => order.push("foreground")); resume.resolve();
  assert.equal(await work, "ready"); await foreground; assert.equal(attempts, 1);
  assert.deepEqual(order, ["index", "month", "foreground"]); await scheduler.close();
});

test("caller-supplied yield codes do not resubmit company jobs and stage validation is unconditional", async () => {
  const scheduler = create();
  await assert.rejects(scheduler.run(() => { throw Object.assign(Error("ordinary failure"), { code: YIELD_CODE }); }, company), { code: YIELD_CODE });
  assert.equal(scheduler.status().timing.restarted, 0); assert.equal(scheduler.status().timing.failed, 1); await scheduler.close();
  for (const invalid of [null, -1, 0.5, "1", Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => setCooperativeWorkStage(invalid), TypeError);
  assert.doesNotThrow(() => setCooperativeWorkStage(0));
});
