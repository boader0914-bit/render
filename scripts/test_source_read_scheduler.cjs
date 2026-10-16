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
  const scheduler = createSourceReadScheduler();
  await assert.rejects(scheduler.run(null), TypeError);
  await assert.rejects(scheduler.run(() => 1, { priority: "invalid" }), TypeError);
  assert.deepEqual(scheduler.status(), { active: false, queuedForeground: 0, queuedBackground: 0 });
});
