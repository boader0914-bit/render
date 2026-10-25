"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createAnalyticalWorkScheduler } = require("./lib/analytical_work_scheduler.cjs");
const { setCooperativeWorkRevision, setCooperativeWorkPhase, cooperativeWorkCheckpoint } = require("./lib/cooperative_work_checkpoint.cjs");
const gate = () => { let resolve; return { promise: new Promise(done => { resolve = done; }), resolve: () => resolve() }; };

for (const changed of [false, true]) test(`a ${changed ? "changed" : "stable"} original revision ${changed ? "resets" : "retains"} retry progress without exposing source identities`, async () => {
  const scheduler = createAnalyticalWorkScheduler({ cooperativeYield: true, cooperativeMinRunMs: 0 });
  const entered = [gate(), gate(), gate()], resume = [gate(), gate(), gate()]; let attempts = 0;
  const industry = scheduler.run(async () => {
    const attempt = attempts++;
    setCooperativeWorkRevision(attempt > 0 && changed ? "new-original" : "initial-original");
    setCooperativeWorkPhase(attempt === 0 ? 70 : 10);
    entered[attempt].resolve(); await resume[attempt].promise;
    cooperativeWorkCheckpoint();
    if (attempt > 0 && !changed) {
      assert.equal(scheduler.status().cooperative.yieldRequested, false);
      setCooperativeWorkPhase(70, 1); cooperativeWorkCheckpoint();
    }
    return "complete";
  }, { priority: "background", kind: "industry-build" });
  for (let attempt = 0; attempt < 2; attempt++) {
    await entered[attempt].promise;
    const foreground = scheduler.run(() => attempt);
    resume[attempt].resolve(); assert.equal(await foreground, attempt);
  }
  await entered[2].promise; resume[2].resolve(); assert.equal(await industry, "complete");
  const status = scheduler.status();
  const yields = status.timing.recent.filter(row => row.outcome === "yielded");
  assert.deepEqual(yields.map(row => row.phaseIndex), changed ? [70, 10] : [70, 70]);
  assert.equal(status.timing.progressRevisionResets, changed ? 1 : 0);
  assert.equal(status.timing.failed, 0); assert.equal(attempts, 3);
  assert.doesNotMatch(JSON.stringify(status), /initial-original|new-original/);
  await scheduler.close();
});

test("progress revision validation applies outside an active owner as well", () => {
  for (const invalid of [null, "", 7, "x".repeat(513)]) assert.throws(() => setCooperativeWorkRevision(invalid), TypeError);
  assert.doesNotThrow(() => setCooperativeWorkRevision("a-current-source"));
});
