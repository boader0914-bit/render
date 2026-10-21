"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { AsyncLocalStorage } = require("node:async_hooks");
const { createAnalyticalWorkScheduler } = require("./lib/analytical_work_scheduler.cjs");
const gate = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const turn = () => new Promise(resolve => setImmediate(resolve));
async function flush() { for (let index = 0; index < 4; index++) await turn(); }
test("queued work preserves its collection lane while nested reads retain the shared owner", async () => {
  const scheduler = createAnalyticalWorkScheduler(), lane = new AsyncLocalStorage(), hold = gate(), entered = gate();
  const first = lane.run("manual", () => scheduler.run(async () => { entered.resolve(); await hold.promise; return lane.getStore(); }));
  await entered.promise;
  const jobs = ["web", "get-repair"].map(key => lane.run(key, () => scheduler.run(async info => {
    const nested = await scheduler.run(inner => ({ lane: lane.getStore(), sameOwner: inner.signal === info.signal }));
    return nested;
  })));
  hold.resolve();
  assert.equal(await first, "manual");
  assert.deepEqual(await Promise.all(jobs), [{ lane: "web", sameOwner: true }, { lane: "get-repair", sameOwner: true }]);
  await scheduler.close();
});
function clock() {
  let instant = 1000, sequence = 0; const timers = new Map();
  return { now: () => instant,
    setTimeoutImpl(fn, delay) { const handle = { id: ++sequence, unref() {} }; timers.set(handle, { fn, at: instant + delay }); return handle; },
    clearTimeoutImpl: handle => timers.delete(handle),
    async advance(ms) { instant += ms; const due = [...timers].filter(([, timer]) => timer.at <= instant); for (const [handle, timer] of due) { timers.delete(handle); timer.fn(); } await flush(); },
    timers: () => timers.size };
}

test("one lifetime is active, foreground passes queued background, and burst bounds background starvation", async () => {
  const scheduler = createAnalyticalWorkScheduler({ foregroundBurst: 2 });
  const hold = gate(), entered = gate(), order = []; let active = 0, peak = 0;
  const work = (name, wait = false) => async () => { active++; peak = Math.max(peak, active); order.push(name); if (wait) { entered.resolve(); await hold.promise; } active--; return name; };
  const first = scheduler.run(work("active", true), { priority: "background", kind: "company_month" }); await entered.promise;
  const jobs = [scheduler.run(work("background-1"), { priority: "background" }), scheduler.run(work("background-2"), { priority: "background" }),
    ...[1, 2, 3, 4, 5].map(number => scheduler.run(work(`foreground-${number}`)))];
  assert.equal(scheduler.status().activeKind, "company_month"); hold.resolve(); await Promise.all([first, ...jobs]); await flush();
  assert.equal(peak, 1);
  assert.deepEqual(order, ["active", "foreground-1", "foreground-2", "background-1", "foreground-3", "foreground-4", "background-2", "foreground-5"]);
  assert.equal(scheduler.status().active, false); await scheduler.close();
});

test("an awaited nested source read reenters its owner and failures release only the owner lifetime", async () => {
  const scheduler = createAnalyticalWorkScheduler(), failure = Error("source failed"), order = [];
  const result = await scheduler.run(async outer => {
    assert.equal(outer.priority, "background"); order.push("outer");
    const value = await scheduler.run(async inner => { assert.equal(inner.priority, "background"); assert.equal(inner.signal, outer.signal); order.push("inner"); return 17; }, { kind: "source" });
    assert.equal(value, 17);
    await assert.rejects(scheduler.run(() => { throw failure; }), error => error === failure);
    assert.equal(scheduler.status().active, true); order.push("outer-end"); return value;
  }, { priority: "background" });
  assert.equal(result, 17); assert.deepEqual(order, ["outer", "inner", "outer-end"]);
  await assert.rejects(scheduler.run(() => { throw failure; }), error => error === failure);
  assert.equal(await scheduler.run(() => 23), 23); await scheduler.close();
});

test("an inherited detached async context cannot reenter an expired owner", async () => {
  const scheduler = createAnalyticalWorkScheduler(), detached = gate(), entered = gate(), hold = gate(); let late, ran = false;
  await scheduler.run(() => { late = detached.promise.then(() => scheduler.run(() => { ran = true; return 9; })); }); await flush();
  const active = scheduler.run(async () => { entered.resolve(); await hold.promise; }); await entered.promise;
  detached.resolve(); await flush(); assert.equal(ran, false); assert.equal(scheduler.status().queuedForeground, 1);
  hold.resolve(); await active; assert.equal(await late, 9); await scheduler.close();
});

test("fire-and-forget queue dispatch requests a detached lease instead of reentering ingestion", async () => {
  const scheduler = createAnalyticalWorkScheduler(), entered = gate(), release = gate(), order = []; let queued;
  const ingestion = scheduler.run(async () => {
    order.push("ingestion-start");
    // A queue kick must not await this promise while ingestion owns the lease.
    queued = scheduler.run(() => order.push("background"), { priority: "background", kind: "company_month", detached: true });
    entered.resolve(); await release.promise; order.push("ingestion-finish");
  }, { kind: "ingestion" });
  await entered.promise; await flush();
  assert.deepEqual(order, ["ingestion-start"]); assert.equal(scheduler.status().activeKind, "ingestion");
  assert.equal(scheduler.status().queuedBackground, 1);
  release.resolve(); await ingestion; await queued;
  assert.deepEqual(order, ["ingestion-start", "ingestion-finish", "background"]); await scheduler.close();
});

test("queued abort removes work; running abort never releases its heap before it finishes", async () => {
  const scheduler = createAnalyticalWorkScheduler(), entered = gate(), hold = gate(), activeController = new AbortController(), pendingController = new AbortController();
  let signal, nextRan = false;
  const active = scheduler.run(async info => { signal = info.signal; entered.resolve(); await hold.promise; }, { signal: activeController.signal }); await entered.promise;
  const aborted = scheduler.run(() => assert.fail("aborted work ran"), { priority: "background", signal: pendingController.signal });
  const rejected = assert.rejects(aborted, error => error.name === "AbortError" && error.code === "ANALYTICAL_WORK_ABORTED"); pendingController.abort(); await rejected;
  const next = scheduler.run(() => { nextRan = true; }); activeController.abort(); await flush();
  assert.equal(signal.aborted, true); assert.equal(nextRan, false); assert.equal(scheduler.status().queuedBackground, 0);
  hold.resolve(); await Promise.all([active, next]); assert.equal(nextRan, true); await scheduler.close();
});

test("close rejects waiting jobs, aborts its owner, and waits for active work to release", async () => {
  const scheduler = createAnalyticalWorkScheduler(), entered = gate(), hold = gate(); let signal, closed = false;
  const active = scheduler.run(async info => { signal = info.signal; entered.resolve(); await hold.promise; }); await entered.promise;
  const pending = scheduler.run(() => assert.fail("closed work ran"), { priority: "background" });
  const rejected = assert.rejects(pending, { code: "ANALYTICAL_WORK_CLOSED" });
  const closing = scheduler.close().then(() => { closed = true; }); await rejected; await flush();
  assert.equal(signal.aborted, true); assert.equal(closed, false); hold.resolve(); await Promise.all([active, closing]);
  assert.equal(closed, true); assert.equal(scheduler.status().active, false);
  await assert.rejects(scheduler.run(() => 1), { code: "ANALYTICAL_WORK_CLOSED" });
});

test("pressure holds background before ownership and low-water hysteresis resumes FIFO without forced admission", async () => {
  const time = clock(), ratios = [0.8, 0.6, 0.5, 0.5], calls = [], order = [];
  const scheduler = createAnalyticalWorkScheduler({ ...time, sampleIntervalMs: 10, maxSampleAgeMs: 100,
    sampleMemory: async () => { const ratio = ratios.shift() ?? 0.5; calls.push(ratio); return { ratio, sampledAt: time.now() }; } });
  const jobs = [1, 2].map(number => scheduler.run(() => order.push(`background-${number}`), { priority: "background" })); await flush();
  assert.equal(scheduler.status().active, false); assert.equal(scheduler.status().memory.paused, true); assert.equal(scheduler.status().queuedBackground, 2);
  for (let index = 0; index < 7; index++) assert.equal(await scheduler.run(() => 17), 17);
  assert.deepEqual(order, [], "fairness never forces background admission at high pressure");
  await time.advance(10); assert.equal(scheduler.status().memory.lowSamples, 0);
  await time.advance(10); assert.equal(scheduler.status().memory.lowSamples, 1); assert.deepEqual(order, []);
  await time.advance(10); await Promise.all(jobs); assert.deepEqual(order, ["background-1", "background-2"]); assert.deepEqual(calls, [0.8, 0.6, 0.5, 0.5, 0.5]);
  await scheduler.close(); assert.equal(time.timers(), 0);
});

test("every new background lifetime rechecks a preceding fast allocation before admission", async () => {
  const time = clock(); let ratio = 0.1, calls = 0, secondRan = false;
  const scheduler = createAnalyticalWorkScheduler({ ...time, sampleIntervalMs: 100, maxSampleAgeMs: 1000,
    sampleMemory: async () => { calls++; return { ratio, sampledAt: time.now() }; } });
  const first = scheduler.run(() => { ratio = 0.9; }, { priority: "background" });
  const second = scheduler.run(() => { secondRan = true; }, { priority: "background" });
  const rejected = assert.rejects(second, { code: "ANALYTICAL_WORK_CLOSED" });
  await first; await flush(); assert.equal(calls, 2); assert.equal(secondRan, false); assert.equal(scheduler.status().memory.paused, true);
  await scheduler.close(); await rejected;
});

test("a slow memory sampler owns no lease and does not block foreground work or overlap samplers", async () => {
  const sample = gate(); let calls = 0, backgroundRan = false;
  const scheduler = createAnalyticalWorkScheduler({ sampleMemory: () => { calls++; return sample.promise; } });
  const background = scheduler.run(() => { backgroundRan = true; }, { priority: "background" }); await flush();
  assert.equal(scheduler.status().active, false); assert.equal(scheduler.status().sampling, true);
  assert.equal(await scheduler.run(() => 42), 42); assert.equal(backgroundRan, false); assert.equal(calls, 1);
  sample.resolve({ ratio: 0.1 }); await background; await scheduler.close();
});

test("failed, invalid and stale samples fail closed but keep the queued work recoverable", async () => {
  for (const [value, code] of [[Error("unavailable"), "ANALYTICAL_MEMORY_SAMPLE_FAILED"], [{ ratio: "0.2" }, "ANALYTICAL_MEMORY_SAMPLE_INVALID"],
    [{ ratio: 0.2, sampledAt: 0 }, "ANALYTICAL_MEMORY_SAMPLE_STALE"], [{ ratio: NaN }, "ANALYTICAL_MEMORY_SAMPLE_INVALID"]]) {
    const time = clock(); let attempt = 0, ran = false;
    const scheduler = createAnalyticalWorkScheduler({ ...time, sampleIntervalMs: 10, maxSampleAgeMs: 100,
      sampleMemory: async () => { if (++attempt === 1) { if (value instanceof Error) throw value; return value; } return { ratio: 0.1, sampledAt: time.now() }; } });
    const background = scheduler.run(() => { ran = true; }, { priority: "background" }); await flush();
    assert.equal(scheduler.status().memory.errorCode, code); assert.equal(scheduler.status().queuedBackground, 1); assert.equal(ran, false);
    await time.advance(10); assert.equal(ran, false); await time.advance(10); await background;
    assert.equal(ran, true); assert.equal(scheduler.status().memory.errorCode, null); await scheduler.close();
  }
});

test("checkpoint pressure inspects without waiting while an active owner retains source memory", async () => {
  let ratio = 0.1;
  const scheduler = createAnalyticalWorkScheduler({ sampleMemory: async () => ({ ratio }) });
  await scheduler.run(async () => {
    ratio = 0.9; const pressure = await scheduler.checkpointPressure();
    assert.equal(pressure.paused, true); assert.equal(scheduler.status().active, true);
  }); await scheduler.close();
});

test("memory guard is optional and invalid options never enqueue work", async () => {
  for (const options of [{ foregroundBurst: 0 }, { highWatermark: 0 }, { lowWatermark: 0.9 }, { resumeSamples: 0 }, { sampleMemory: true }, { sampleIntervalMs: 0 }, { maxSampleAgeMs: 1 }]) {
    assert.throws(() => createAnalyticalWorkScheduler(options), TypeError);
  }
  const scheduler = createAnalyticalWorkScheduler();
  for (const [operation, options] of [[null, {}], [() => 1, { priority: "invalid" }], [() => 1, { kind: "unsafe kind" }], [() => 1, { signal: {} }], [() => 1, { detached: 1 }]]) await assert.rejects(scheduler.run(operation, options), TypeError);
  const controller = new AbortController(); controller.abort(); await assert.rejects(scheduler.run(() => 1, { signal: controller.signal }), { name: "AbortError" });
  assert.equal(await scheduler.run(() => 18, { priority: "background" }), 18); assert.equal(scheduler.status().memory.enabled, false);
  await scheduler.close();
});
