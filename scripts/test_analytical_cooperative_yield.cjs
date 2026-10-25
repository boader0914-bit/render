"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { createAnalyticalWorkScheduler } = require("./lib/analytical_work_scheduler.cjs");
const { createSourceReadScheduler } = require("./lib/source_read_scheduler.cjs");
const { cooperativeWorkCheckpoint, setCooperativeWorkPhase, assertCooperativeWorkActive,
  runNonInterruptibleCooperativeWork, YIELD_CODE } = require("./lib/cooperative_work_checkpoint.cjs");
const gate = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const turn = () => new Promise(resolve => setImmediate(resolve));
const options = { priority: "background", kind: "industry-build" };
const create = extra => createAnalyticalWorkScheduler({ cooperativeYield: true, cooperativeMinRunMs: 0, ...extra });

test("foreground admission follows complete source cleanup and the original industry promise survives retry", async () => {
  const scheduler = create(), source = createSourceReadScheduler(), started = gate(), proceed = gate(), cleaning = gate(), cleaned = gate();
  const order = []; let attempts = 0, allocations = 0, finished = false;
  const industry = scheduler.run(async () => {
    const attempt = ++attempts;
    return source.run(async () => {
      allocations++; order.push(`source-${attempt}`);
      try {
        if (attempt === 1) { started.resolve(); await proceed.promise; }
        await source.checkpoint({ priority: "background" });
        return "final-result";
      } finally {
        if (attempt === 1) { cleaning.resolve(); await cleaned.promise; }
        allocations--; order.push(`clean-${attempt}`);
      }
    }, { priority: "background" });
  }, options).then(value => { finished = true; return value; });
  await started.promise;
  const foreground = scheduler.run(() => {
    assert.equal(allocations, 0); assert.equal(source.status().active, false);
    assert.equal(finished, false); order.push("foreground"); return 17;
  }, { kind: "company-read" });
  proceed.resolve(); await cleaning.promise; await turn();
  assert.deepEqual(order, ["source-1"]); assert.equal(scheduler.status().activeKind, "industry-build");
  assert.equal(finished, false); assert.equal(source.status().active, true);
  cleaned.resolve(); assert.equal(await foreground, 17); assert.equal(await industry, "final-result");
  assert.deepEqual(order, ["source-1", "clean-1", "foreground", "source-2", "clean-2"]);
  const status = scheduler.status();
  assert.equal(status.timing.yielded, 1); assert.equal(status.timing.restarted, 1); assert.equal(status.timing.failed, 0);
  const industryRows = status.timing.recent.filter(row => row.kind === "industry-build");
  assert.equal(industryRows.length, 2); assert.equal(industryRows[0].id, industryRows[1].id);
  assert.deepEqual(industryRows.map(row => [row.attempt, row.outcome]), [[1, "yielded"], [2, "completed"]]);
  await scheduler.close();
});

test("repeated foreground arrivals require increasing progress before each retry and cannot starve completion", async () => {
  const scheduler = create(), entered = Array.from({ length: 5 }, gate), proceed = Array.from({ length: 5 }, gate);
  let attempts = 0;
  const industry = scheduler.run(async () => {
    const attempt = attempts++;
    entered[attempt].resolve(); await proceed[attempt].promise;
    for (let step = 0; step < 4; step++) cooperativeWorkCheckpoint();
    return "complete";
  }, options);
  for (let attempt = 0; attempt < 4; attempt++) {
    await entered[attempt].promise;
    const foreground = scheduler.run(() => attempt);
    proceed[attempt].resolve(); assert.equal(await foreground, attempt);
  }
  await entered[4].promise; proceed[4].resolve(); assert.equal(await industry, "complete");
  const status = scheduler.status(), rows = status.timing.recent.filter(row => row.outcome === "yielded");
  assert.deepEqual(rows.map(row => row.checkpoints), [1, 2, 3, 4]);
  assert.equal(attempts, 5); assert.equal(status.timing.failed, 0); assert.equal(status.timing.restarted, 4);
  await scheduler.close();
});

test("a warm short catalog can yield in the next logical phase after a cold ten-thousand-checkpoint attempt", async () => {
  const scheduler = create(), entered = [gate(), gate(), gate()], proceed = [gate(), gate(), gate()]; let attempts = 0;
  const industry = scheduler.run(async () => {
    const attempt = attempts++;
    setCooperativeWorkPhase(10);
    if (attempt === 0) for (let index = 0; index < 10000; index++) cooperativeWorkCheckpoint();
    else for (let index = 0; index < 10; index++) cooperativeWorkCheckpoint();
    entered[attempt].resolve(); await proceed[attempt].promise;
    if (attempt === 0) cooperativeWorkCheckpoint();
    else {
      setCooperativeWorkPhase(10); setCooperativeWorkPhase(0);
      assert.equal(scheduler.status().cooperative.activePhaseIndex, 10);
      cooperativeWorkCheckpoint();
      assert.equal(scheduler.status().cooperative.yieldRequested, false);
      setCooperativeWorkPhase(20); cooperativeWorkCheckpoint();
    }
    return "complete";
  }, options);
  for (let attempt = 0; attempt < 2; attempt++) {
    await entered[attempt].promise; const foreground = scheduler.run(() => attempt);
    proceed[attempt].resolve(); assert.equal(await foreground, attempt);
  }
  await entered[2].promise; proceed[2].resolve(); assert.equal(await industry, "complete");
  const rows = scheduler.status().timing.recent.filter(row => row.outcome === "yielded");
  assert.deepEqual(rows.map(row => [row.phaseIndex, row.checkpointsInPhase, row.checkpoints]), [[10, 10001, 10001], [20, 1, 12]]);
  assert.deepEqual(rows[1].progressHighWater, { phaseIndex: 10, unitIndex: 0, checkpoints: 10001 });
  assert.equal(attempts, 3); await scheduler.close();
});

test("a cached run's short retry yields at the next stable run unit after a thousand cold checkpoints", async () => {
  const scheduler = create(), entered = [gate(), gate(), gate()], proceed = [gate(), gate(), gate()]; let attempts = 0;
  const industry = scheduler.run(async () => {
    const attempt = attempts++;
    setCooperativeWorkPhase(42, 1);
    for (let index = 0; index < (attempt === 0 ? 1000 : 1); index++) cooperativeWorkCheckpoint();
    entered[attempt].resolve(); await proceed[attempt].promise;
    if (attempt === 0) cooperativeWorkCheckpoint();
    else {
      setCooperativeWorkPhase(42); setCooperativeWorkPhase(41, 100);
      assert.equal(scheduler.status().cooperative.activeUnitIndex, 1);
      cooperativeWorkCheckpoint();
      assert.equal(scheduler.status().cooperative.yieldRequested, false);
      setCooperativeWorkPhase(42, 2); cooperativeWorkCheckpoint();
    }
    return "complete";
  }, options);
  for (let attempt = 0; attempt < 2; attempt++) {
    await entered[attempt].promise; const foreground = scheduler.run(() => attempt);
    proceed[attempt].resolve(); assert.equal(await foreground, attempt);
  }
  await entered[2].promise; proceed[2].resolve(); assert.equal(await industry, "complete");
  const rows = scheduler.status().timing.recent.filter(row => row.outcome === "yielded");
  assert.deepEqual(rows.map(row => [row.phaseIndex, row.unitIndex, row.checkpointsInUnit, row.checkpoints]), [[42, 1, 1001, 1001], [42, 2, 1, 3]]);
  assert.deepEqual(rows[1].progressHighWater, { phaseIndex: 42, unitIndex: 1, checkpoints: 1001 });
  assert.equal(rows[1].checkpointsInPhase, 3); assert.equal(attempts, 3); await scheduler.close();
});

test("translated or swallowed checkpoint failures cannot publish false completion, including nested work", async () => {
  for (const mode of ["swallow", "translate", "nested"]) {
    const scheduler = create(), entered = gate(), proceed = gate(); let attempts = 0;
    const industry = scheduler.run(async () => {
      if (++attempts > 1) return "verified";
      entered.resolve(); await proceed.promise;
      const read = () => { try { cooperativeWorkCheckpoint(); } catch {
        if (mode === "translate") throw Object.assign(Error("source unavailable"), { code: "MONTHLY_SOURCE_UNAVAILABLE" });
        return "false-success";
      } };
      try { return mode === "nested" ? await scheduler.run(read, { kind: "source-read" }) : read(); }
      catch { return "also-false-success"; }
    }, options);
    await entered.promise;
    const foreground = scheduler.run(() => 1); proceed.resolve(); await foreground;
    assert.equal(await industry, "verified"); assert.equal(attempts, 2);
    assert.equal(scheduler.status().timing.failed, 0); assert.equal(scheduler.status().timing.yielded, 1);
    if (mode === "nested") {
      assert.equal(scheduler.status().timing.reentrantFailed, 0);
      assert.equal(scheduler.status().timing.reentrantYielded, 1);
    }
    await scheduler.close();
  }
});

test("publication scopes never yield between writes and reject entry after a yield was already requested", async () => {
  const scheduler = create(), entered = gate(), proceed = gate(), order = []; let attempts = 0;
  const industry = scheduler.run(async () => {
    if (++attempts > 1) return "ready";
    entered.resolve(); await proceed.promise;
    await runNonInterruptibleCooperativeWork(async () => {
      order.push("write-first"); cooperativeWorkCheckpoint();
      await runNonInterruptibleCooperativeWork(async () => { cooperativeWorkCheckpoint(); order.push("write-second"); });
      assertCooperativeWorkActive(); order.push("published");
    });
    assert.throws(cooperativeWorkCheckpoint, { code: YIELD_CODE });
    assert.throws(assertCooperativeWorkActive, { code: YIELD_CODE });
    await assert.rejects(runNonInterruptibleCooperativeWork(() => assert.fail("publication after cancellation")), { code: YIELD_CODE });
    return "false-ready";
  }, options);
  await entered.promise;
  const foreground = scheduler.run(() => order.push("foreground")); proceed.resolve();
  await foreground; assert.equal(await industry, "ready");
  assert.deepEqual(order, ["write-first", "write-second", "published", "foreground"]);
  await scheduler.close();
});

test("only explicitly enabled background industry ownership is interruptible; arbitrary yield codes never retry", async () => {
  for (const [enabled, priority, kind] of [[false, "background", "industry-build"], [true, "background", "company-month"], [true, "foreground", "industry-build"]]) {
    const scheduler = create({ cooperativeYield: enabled }), entered = gate(), proceed = gate(); let attempts = 0;
    const work = scheduler.run(async () => { attempts++; entered.resolve(); await proceed.promise; cooperativeWorkCheckpoint(); return 7; }, { priority, kind });
    await entered.promise; const foreground = scheduler.run(() => 9); proceed.resolve();
    assert.equal(await work, 7); assert.equal(await foreground, 9); assert.equal(attempts, 1);
    assert.equal(scheduler.status().timing.yielded, 0); await scheduler.close();
  }
  const scheduler = create();
  await assert.rejects(scheduler.run(() => { throw Object.assign(Error("caller supplied"), { code: YIELD_CODE }); }, options), { code: YIELD_CODE });
  assert.equal(scheduler.status().timing.restarted, 0);
  assert.equal(scheduler.status().timing.yielded, 0); assert.equal(scheduler.status().timing.failed, 1);
  await scheduler.close();
});

test("minimum wall time and checkpoint progress both constrain preemption", async () => {
  let time = 1000; const scheduler = create({ now: () => time, cooperativeMinRunMs: 250, cooperativeMinProgress: 2 });
  const entered = gate(), proceed = gate(); let attempts = 0;
  const industry = scheduler.run(async () => {
    if (++attempts > 1) return 8;
    entered.resolve(); await proceed.promise;
    cooperativeWorkCheckpoint(); time += 249; cooperativeWorkCheckpoint();
    assert.equal(scheduler.status().cooperative.yieldRequested, false);
    time++; cooperativeWorkCheckpoint(); return "unreachable";
  }, options);
  await entered.promise; const foreground = scheduler.run(() => 3); proceed.resolve();
  assert.equal(await foreground, 3); assert.equal(await industry, 8);
  const row = scheduler.status().timing.recent.find(item => item.outcome === "yielded");
  assert.equal(row.checkpoints, 3); assert.equal(row.leaseMs, 250);
  assert.equal(scheduler.status().timing.maximumCheckpointGapMs, 249);
  await scheduler.close();
});

test("abort during yielded cleanup does not retry or admit foreground before the source heap releases", async () => {
  const scheduler = create(), source = createSourceReadScheduler(), controller = new AbortController();
  const entered = gate(), proceed = gate(), cleaning = gate(), release = gate(); let attempts = 0, foregroundRan = false;
  const industry = scheduler.run(() => source.run(async () => {
    attempts++; entered.resolve(); await proceed.promise;
    try { await source.checkpoint({ priority: "background" }); }
    finally { cleaning.resolve(); await release.promise; }
  }, { priority: "background" }), { ...options, signal: controller.signal });
  const rejected = assert.rejects(industry, { code: "ANALYTICAL_WORK_ABORTED" });
  await entered.promise;
  const foreground = scheduler.run(() => { assert.equal(source.status().active, false); foregroundRan = true; });
  proceed.resolve(); await cleaning.promise; controller.abort(); await turn();
  assert.equal(foregroundRan, false); assert.equal(scheduler.status().active, true);
  release.resolve(); await rejected; await foreground;
  assert.equal(attempts, 1); assert.equal(scheduler.status().timing.restarted, 0);
  assert.equal(scheduler.status().timing.aborted, 1); await scheduler.close();
});

test("close during yielded cleanup rejects queued peers and waits without restarting the owner", async () => {
  const scheduler = create(), entered = gate(), proceed = gate(), cleaning = gate(), release = gate(); let attempts = 0, closed = false;
  const industry = scheduler.run(async () => {
    attempts++; entered.resolve(); await proceed.promise;
    try { cooperativeWorkCheckpoint(); }
    finally { cleaning.resolve(); await release.promise; }
  }, options);
  const industryRejected = assert.rejects(industry, { code: "ANALYTICAL_WORK_CLOSED" });
  await entered.promise;
  const foreground = scheduler.run(() => assert.fail("closed peer ran"));
  const foregroundRejected = assert.rejects(foreground, { code: "ANALYTICAL_WORK_CLOSED" });
  proceed.resolve(); await cleaning.promise;
  const closing = scheduler.close().then(() => { closed = true; });
  await foregroundRejected; await turn(); assert.equal(closed, false);
  release.resolve(); await Promise.all([industryRejected, closing]);
  assert.equal(attempts, 1); assert.equal(scheduler.status().timing.restarted, 0); assert.equal(scheduler.status().active, false);
});

test("a yielded retry is abortable while queued behind the admitted foreground reader", async () => {
  const scheduler = create(), controller = new AbortController(), entered = gate(), proceed = gate(), foregroundEntered = gate(), foregroundHold = gate();
  let attempts = 0;
  const industry = scheduler.run(async () => {
    attempts++; entered.resolve(); await proceed.promise; cooperativeWorkCheckpoint(); return "unreachable";
  }, { ...options, signal: controller.signal });
  const rejected = assert.rejects(industry, { code: "ANALYTICAL_WORK_ABORTED" });
  await entered.promise;
  const foreground = scheduler.run(async () => { foregroundEntered.resolve(); await foregroundHold.promise; });
  proceed.resolve(); await foregroundEntered.promise;
  assert.equal(scheduler.status().queuedBackground, 1); controller.abort(); await rejected;
  assert.equal(scheduler.status().queuedBackground, 0); foregroundHold.resolve(); await foreground;
  assert.equal(attempts, 1); assert.equal(scheduler.status().timing.aborted, 1); await scheduler.close();
});

test("synchronous timing-observer cancellation never leaks the internal retry code", async () => {
  const controller = new AbortController(), entered = gate(), proceed = gate();
  const scheduler = create({ onTaskTiming(row) { if (row.outcome === "yielded") controller.abort(); } });
  const industry = scheduler.run(async () => { entered.resolve(); await proceed.promise; cooperativeWorkCheckpoint(); }, { ...options, signal: controller.signal });
  const rejected = assert.rejects(industry, { code: "ANALYTICAL_WORK_ABORTED" });
  await entered.promise; const foreground = scheduler.run(() => 5); proceed.resolve();
  await rejected; assert.equal(await foreground, 5); assert.equal(scheduler.status().timing.restarted, 0);
  await scheduler.close();
});

test("detached work and inherited expired contexts cannot checkpoint another active owner", async () => {
  const scheduler = create(), lateGate = gate(), firstEntered = gate(), firstProceed = gate(), order = []; let late, detached;
  const first = scheduler.run(async () => {
    late = lateGate.promise.then(() => { cooperativeWorkCheckpoint(); assertCooperativeWorkActive(); order.push("old-context"); });
    detached = scheduler.run(() => { cooperativeWorkCheckpoint(); order.push("detached"); return 9; }, { priority: "background", kind: "company-month", detached: true });
    firstEntered.resolve(); await firstProceed.promise; return 1;
  }, options);
  await firstEntered.promise; firstProceed.resolve(); assert.equal(await first, 1); assert.equal(await detached, 9);
  const entered = gate(), hold = gate();
  const active = scheduler.run(async () => { entered.resolve(); await hold.promise; return 11; });
  await entered.promise;
  const peer = scheduler.run(() => order.push("peer")); lateGate.resolve(); await late;
  assert.equal(scheduler.status().cooperative.yieldRequested, false); assert.equal(scheduler.status().queuedForeground, 1);
  hold.resolve(); assert.equal(await active, 11); await peer;
  assert.deepEqual(order, ["detached", "old-context", "peer"]); assert.equal(scheduler.status().timing.yielded, 0);
  await scheduler.close();
});

test("invalid cooperative options and helper callbacks fail before scheduling", async () => {
  for (const settings of [{ cooperativeYield: 1 }, { cooperativeMinRunMs: -1 }, { cooperativeMinRunMs: 0.5 }, { cooperativeMinProgress: 0 }]) {
    assert.throws(() => createAnalyticalWorkScheduler(settings), TypeError);
  }
  await assert.rejects(runNonInterruptibleCooperativeWork(null), TypeError);
  for (const phase of [-1, 0.5, "10", NaN]) assert.throws(() => setCooperativeWorkPhase(phase), TypeError);
  for (const unit of [-1, 0.5, "1", NaN]) assert.throws(() => setCooperativeWorkPhase(42, unit), TypeError);
  cooperativeWorkCheckpoint(); assertCooperativeWorkActive();
});
