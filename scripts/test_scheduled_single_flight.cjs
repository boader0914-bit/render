"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createScheduledSingleFlight } = require("./lib/scheduled_single_flight.cjs");
const { createAnalyticalWorkScheduler } = require("./lib/analytical_work_scheduler.cjs");
const gate = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

test("a queued caller never makes its owner await that caller's admission", { timeout: 3000 }, async () => {
  const scheduler = createAnalyticalWorkScheduler(), entered = gate(), nested = gate(), value = { real: 0 };
  const flight = createScheduledSingleFlight({ runWork: (operation, options) => scheduler.run(operation, options), kind: "fixture" });
  let calls = 0;
  const load = () => { calls++; return value; };
  const owner = scheduler.run(async () => { entered.resolve(); await nested.promise; return flight.run("one", load); });
  await entered.promise;
  const queued = flight.run("one", load);
  assert.equal(calls, 0); assert.equal(scheduler.status().queuedForeground, 1);
  nested.resolve();
  assert.equal(await owner, value); assert.equal(await queued, value); assert.equal(calls, 1);
  assert.equal(flight.has("one"), false); await scheduler.close();
});

test("a settled group is hidden from new callers while an old caller is still queued", { timeout: 3000 }, async () => {
  const scheduler = createAnalyticalWorkScheduler(), entered = gate(), nested = gate(), built = gate(), release = gate();
  const flight = createScheduledSingleFlight({ runWork: (operation, options) => scheduler.run(operation, options) });
  let revision = 1, calls = 0;
  const load = () => { calls++; return { revision }; };
  const owner = scheduler.run(async () => {
    entered.resolve(); await nested.promise;
    const value = await flight.run("one", load); built.resolve(value); await release.promise; return value;
  });
  await entered.promise;
  const oldQueued = flight.run("one", load); nested.resolve();
  const oldValue = await built.promise;
  assert.equal(flight.has("one"), false); revision = 2;
  const newQueued = flight.run("one", load);
  assert.equal(scheduler.status().queuedForeground, 2); release.resolve();
  assert.equal(await owner, oldValue); assert.equal(await oldQueued, oldValue);
  assert.deepEqual(await newQueued, { revision: 2 }); assert.equal(calls, 2);
  await scheduler.close();
});

test("reentrant callers share the original rejection and a later group can succeed", { timeout: 3000 }, async () => {
  const scheduler = createAnalyticalWorkScheduler(), entered = gate(), nested = gate(), failure = Error("same load failure");
  const flight = createScheduledSingleFlight({ runWork: (operation, options) => scheduler.run(operation, options) });
  let calls = 0;
  const load = () => { calls++; throw failure; };
  const owner = scheduler.run(async () => {
    entered.resolve(); await nested.promise;
    return flight.run("one", load).then(() => assert.fail("expected failure"), error => error);
  });
  await entered.promise;
  const queued = flight.run("one", load).then(() => assert.fail("expected failure"), error => error);
  nested.resolve();
  assert.equal(await owner, failure); assert.equal(await queued, failure); assert.equal(calls, 1);
  assert.equal(flight.has("one"), false); assert.equal(await flight.run("one", () => 17), 17);
  await scheduler.close();
});

test("different keys are admitted sequentially and a nested read reenters", { timeout: 3000 }, async () => {
  const scheduler = createAnalyticalWorkScheduler(), entered = gate(), release = gate();
  const flight = createScheduledSingleFlight({ runWork: (operation, options) => scheduler.run(operation, options) });
  let active = 0, peak = 0;
  const first = flight.run("one", async () => {
    peak = Math.max(peak, ++active); entered.resolve(); await release.promise;
    assert.equal(await scheduler.run(() => 9), 9); active--; return "one";
  });
  await entered.promise;
  const second = flight.run("two", () => { peak = Math.max(peak, ++active); active--; return "two"; });
  assert.equal(scheduler.status().queuedForeground, 1); release.resolve();
  assert.deepEqual(await Promise.all([first, second]), ["one", "two"]); assert.equal(peak, 1);
  await scheduler.close();
});

test("abort before callback start leaves no load or abandoned group", { timeout: 3000 }, async () => {
  const scheduler = createAnalyticalWorkScheduler(), entered = gate(), release = gate();
  let controller = new AbortController(), calls = 0;
  const flight = createScheduledSingleFlight({ runWork: (operation, options) => scheduler.run(operation, { ...options, signal: controller.signal }) });
  const owner = scheduler.run(async () => { entered.resolve(); await release.promise; }); await entered.promise;
  const pending = flight.run("one", () => ++calls);
  const rejected = assert.rejects(pending, { code: "ANALYTICAL_WORK_ABORTED" }); controller.abort(); await rejected;
  assert.equal(calls, 0); assert.equal(flight.has("one"), false);
  release.resolve(); await owner; controller = new AbortController();
  assert.equal(await flight.run("one", () => ++calls), 1); await scheduler.close();
});

test("synchronous admission failure clears a never-started group", async () => {
  const failure = Error("admission failed"); let calls = 0;
  const flight = createScheduledSingleFlight({ runWork: () => { throw failure; } });
  await assert.rejects(flight.run("one", () => ++calls), error => error === failure);
  assert.equal(calls, 0); assert.equal(flight.has("one"), false);
});

test("default unhooked operation preserves same-flight values, errors, and cleanup", async () => {
  const flight = createScheduledSingleFlight(), value = { amount: 0 }, failure = Error("sync load"); let calls = 0;
  const result = await Promise.all([1, 2, 3].map(() => flight.run("one", () => { calls++; return value; })));
  assert.equal(calls, 1); result.forEach(row => assert.equal(row, value));
  const errors = await Promise.all([1, 2, 3].map(() => flight.run("one", () => { throw failure; }).catch(error => error)));
  errors.forEach(error => assert.equal(error, failure)); assert.equal(flight.has("one"), false);
  assert.equal(await flight.run("one", () => 23), 23);
});

test("construction does not invoke admission or load and rejects only invalid hooks", () => {
  let calls = 0;
  const flight = createScheduledSingleFlight({ runWork: () => { calls++; } });
  assert.equal(calls, 0); assert.equal(flight.has("one"), false);
  assert.throws(() => createScheduledSingleFlight({ runWork: null }), TypeError);
});
