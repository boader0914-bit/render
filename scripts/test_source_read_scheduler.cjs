"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { createSourceReadScheduler } = require("./lib/source_read_scheduler.cjs");
const gate = () => { let release; return { promise: new Promise(resolve => { release = resolve; }), release: () => release() }; };

test("foreground reads pass waiting maintenance without overlapping or interrupting the active read", async () => {
  const scheduler = createSourceReadScheduler(), activeGate = gate(), entered = gate();
  const order = [];
  let active = 0, peak = 0;
  const operation = (name, wait) => async () => {
    active++; peak = Math.max(peak, active); order.push(name);
    if (wait) { entered.release(); await activeGate.promise; }
    active--; return name;
  };
  const first = scheduler.run(operation("active-background", true), { priority: "background" });
  await entered.promise;
  const background = scheduler.run(operation("queued-background"), { priority: "background" });
  const currentMonth = scheduler.run(operation("requested-current"));
  const previousMonth = currentMonth.then(() => scheduler.run(operation("requested-previous")));
  assert.deepEqual(order, ["active-background"]);
  assert.deepEqual(scheduler.status(), { active: true, queuedForeground: 1, queuedBackground: 1 });
  activeGate.release();
  await Promise.all([first, background, currentMonth, previousMonth]);
  assert.deepEqual(order, ["active-background", "requested-current", "requested-previous", "queued-background"]);
  assert.equal(peak, 1, "the complete source heap is reconstructed by only one reader at a time");
});

test("a bounded foreground burst still advances waiting background work", async () => {
  const scheduler = createSourceReadScheduler({ foregroundBurst: 2 }), hold = gate(), entered = gate(), order = [];
  const first = scheduler.run(async () => { order.push("active"); entered.release(); await hold.promise; }, { priority: "background" });
  await entered.promise;
  const jobs = [scheduler.run(async () => order.push("background-1"), { priority: "background" }),
    scheduler.run(async () => order.push("background-2"), { priority: "background" }),
    ...[1, 2, 3, 4, 5].map(number => scheduler.run(async () => order.push(`foreground-${number}`)))];
  hold.release(); await Promise.all([first, ...jobs]);
  assert.deepEqual(order, ["active", "foreground-1", "foreground-2", "background-1", "foreground-3", "foreground-4", "background-2", "foreground-5"]);
});

test("failed reads reject their caller and release the serial queue", async () => {
  const scheduler = createSourceReadScheduler(), failure = Object.assign(new Error("unavailable"), { code: "MONTHLY_SOURCE_UNAVAILABLE" });
  const failed = scheduler.run(() => { throw failure; });
  const following = scheduler.run(async () => 17, { priority: "background" });
  await assert.rejects(failed, error => error === failure);
  assert.equal(await following, 17);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(scheduler.status(), { active: false, queuedForeground: 0, queuedBackground: 0 });
});

test("invalid scheduling options cannot leave a queued operation behind", async () => {
  assert.throws(() => createSourceReadScheduler({ foregroundBurst: 0 }), TypeError);
  assert.throws(() => createSourceReadScheduler({ maxInteractiveHoldMs: 0 }), TypeError);
  const scheduler = createSourceReadScheduler();
  await assert.rejects(scheduler.run(null), TypeError);
  await assert.rejects(scheduler.run(() => 1, { priority: "invalid" }), TypeError);
  assert.deepEqual(scheduler.status(), { active: false, queuedForeground: 0, queuedBackground: 0 });
});

test("interactive reads defer a new background source read while allowing foreground source reads", async () => {
  const scheduler = createSourceReadScheduler(), hold = gate(), entered = gate(), order = [];
  const preview = scheduler.runInteractive(async () => { entered.release(); await hold.promise; return "saved-preview"; });
  await entered.promise;
  const background = scheduler.run(async () => { order.push("background"); return 1; }, { priority: "background" });
  const foreground = scheduler.run(async () => { order.push("foreground"); return 2; });
  assert.equal(await foreground, 2);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(order, ["foreground"]);
  assert.equal(scheduler.interactiveStatus().activeLeases, 1);
  hold.release();
  assert.equal(await preview, "saved-preview"); assert.equal(await background, 1);
  assert.deepEqual(order, ["foreground", "background"]);
});

test("cooperative background pause retains the serial slot and a foreground cache miss releases it without deadlock", async () => {
  const scheduler = createSourceReadScheduler(), backgroundEntered = gate(), reachCheckpoint = gate(), cacheMiss = gate();
  const order = []; let sourceActive = 0, peak = 0;
  const background = scheduler.run(async () => {
    sourceActive++; peak = Math.max(peak, sourceActive); order.push("background-start"); backgroundEntered.release();
    await reachCheckpoint.promise;
    await scheduler.checkpoint({ priority: "background" });
    order.push("background-complete"); sourceActive--;
  }, { priority: "background" });
  await backgroundEntered.promise;
  const preview = scheduler.runInteractive(async () => {
    await cacheMiss.promise;
    return scheduler.run(async () => {
      sourceActive++; peak = Math.max(peak, sourceActive); order.push("foreground-source"); sourceActive--; return "built-preview";
    });
  });
  reachCheckpoint.release();
  await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve));
  assert.equal(scheduler.interactiveStatus().pausedBackground, true);
  assert.deepEqual(scheduler.status(), { active: true, queuedForeground: 0, queuedBackground: 0 });
  assert.deepEqual(order, ["background-start"], "the background reader keeps its heap and waits only at the explicit checkpoint");
  cacheMiss.release();
  assert.equal(await preview, "built-preview"); await background;
  assert.deepEqual(order, ["background-start", "background-complete", "foreground-source"]);
  assert.equal(peak, 1, "the interactive miss never overlaps two complete source heaps");
});

test("background checkpoints yield an event-loop turn even before an interactive request exists", async () => {
  const scheduler = createSourceReadScheduler(), order = [];
  const work = scheduler.run(async () => {
    order.push("source"); await scheduler.checkpoint({ priority: "background" }); order.push("after-checkpoint");
  }, { priority: "background" });
  const external = new Promise(resolve => setImmediate(() => { order.push("incoming-request-turn"); resolve(); }));
  await Promise.all([work, external]);
  assert.deepEqual(order, ["source", "incoming-request-turn", "after-checkpoint"]);
});

test("nested and failed interactive operations release only their own lease and unblock queued maintenance", async () => {
  const scheduler = createSourceReadScheduler(), entered = gate(), hold = gate(), failure = Error("preview failed"), order = [];
  const outer = scheduler.runInteractive(async () => {
    await assert.rejects(scheduler.runInteractive(() => { throw failure; }), error => error === failure);
    assert.equal(scheduler.interactiveStatus().activeLeases, 1, "the outer request still owns its lease after an inner failure");
    entered.release(); await hold.promise; throw failure;
  });
  const observed = assert.rejects(outer, error => error === failure);
  await entered.promise;
  const maintenance = scheduler.run(async () => order.push("maintenance"), { priority: "background" });
  await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(order, []);
  hold.release(); await observed; await maintenance;
  assert.deepEqual(order, ["maintenance"]); assert.equal(scheduler.interactiveStatus().activeLeases, 0);
  await assert.rejects(scheduler.runInteractive(null), TypeError);
  await assert.rejects(scheduler.checkpoint({ priority: "invalid" }), TypeError);
});

test("a continuous interactive cohort cannot extend its maximum hold or starve maintenance", async () => {
  const scheduler = createSourceReadScheduler({ maxInteractiveHoldMs: 20 }), hold = gate(), started = gate(), order = [];
  const first = scheduler.runInteractive(() => hold.promise);
  const background = scheduler.run(async () => { order.push("first-background"); started.release(); }, { priority: "background" });
  await started.promise;
  assert.equal(scheduler.interactiveStatus().activeLeases, 1);
  assert.equal(scheduler.interactiveStatus().holdingBackground, false, "the maximum hold expires while the request is still pending");
  const overlapping = scheduler.runInteractive(() => hold.promise);
  await scheduler.run(async () => order.push("second-background"), { priority: "background" });
  assert.equal(scheduler.interactiveStatus().activeLeases, 2);
  assert.equal(scheduler.interactiveStatus().holdingBackground, false, "an overlapping request cannot restart the expired hold");
  hold.release(); await Promise.all([first, overlapping, background]);
  assert.deepEqual(order, ["first-background", "second-background"]);
});

test("the foreground burst bound still admits waiting maintenance during an interactive lease", async () => {
  const scheduler = createSourceReadScheduler({ foregroundBurst: 2 }), hold = gate(), order = [];
  const preview = scheduler.runInteractive(() => hold.promise);
  const background = scheduler.run(async () => order.push("background"), { priority: "background" });
  const foreground = [1, 2, 3].map(number => scheduler.run(async () => order.push(`foreground-${number}`)));
  await Promise.all([background, ...foreground]);
  assert.deepEqual(order, ["foreground-1", "foreground-2", "background", "foreground-3"]);
  assert.equal(scheduler.interactiveStatus().activeLeases, 1);
  hold.release(); await preview;
});
