"use strict";

const test = require("node:test"), assert = require("node:assert/strict");
const { createAnalyticalWorkScheduler } = require("./lib/analytical_work_scheduler.cjs");
const { createSourceReadScheduler } = require("./lib/source_read_scheduler.cjs");
const { beginCooperativeSourceWait, registerCooperativeCheckpointWake, runWithCooperativeWork,
  runNonInterruptibleCooperativeWork, setCooperativeWorkPhase } = require("./lib/cooperative_work_checkpoint.cjs");
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const turn = () => new Promise(resolve => setImmediate(resolve));

test("a saved reader wakes an owner already paused at its safe source checkpoint", { timeout: 3000 }, async () => {
  const work = createAnalyticalWorkScheduler({ cooperativeYield: true, savedReadCheckpointWaitMs: 100,
    readSavedReadTraceId: () => "3ed930fd099504affe9601ad" });
  const sources = createSourceReadScheduler({ maxInteractiveHoldMs: 2500 });
  const entered = deferred(), reachCheckpoint = deferred(), hold = deferred();
  const order = [];
  let permit, preview;
  const background = work.run(() => sources.run(async () => {
    entered.resolve(); await reachCheckpoint.promise;
    await sources.checkpoint({ priority: "background" });
    order.push("source-resumed");
  }, { priority: "background" }), { priority: "background", kind: "industry-build" });
  try {
    await entered.promise;
    preview = sources.runInteractive(() => hold.promise);
    reachCheckpoint.resolve(); await turn(); await turn();
    assert.equal(sources.interactiveStatus().pausedBackground, true);
    permit = work.acquireSavedReadPermit();
    assert.equal(await permit.run(async () => { order.push("saved-reader"); return 7; }), 7);
    assert.deepEqual(order, ["saved-reader"], "the source stays paused through the response lifetime");
    const row = work.status().checkpointWaitDiagnostics.recent.at(-1);
    assert.equal(row.traceId, "3ed930fd099504affe9601ad");
    assert.equal(row.initial.sourceWait.kind, "checkpoint_hold");
    assert.equal(row.outcome, "admitted");
    permit.release(); await permit.waitForRelease();
    assert.equal(sources.interactiveStatus().holdingBackground, true, "a loan cannot reset or cancel the interactive hold");
  } finally {
    try { permit?.release(); } catch {}
    try { await permit?.waitForRelease(); } catch {}
    hold.resolve(); reachCheckpoint.resolve();
    await preview; await background; await work.close();
  }
  assert.deepEqual(order, ["saved-reader", "source-resumed"]);
});

test("a diagnostic I/O cursor never lends an arbitrary await and captures the deadline before cleanup", { timeout: 3000 }, async () => {
  const work = createAnalyticalWorkScheduler({ cooperativeYield: true, savedReadCheckpointWaitMs: 30 });
  const entered = deferred(), hold = deferred();
  let called = false, permit;
  const background = work.run(async () => {
    setCooperativeWorkPhase(42, 3);
    const end = beginCooperativeSourceWait("derived_cache_read", 8 * 1024 * 1024);
    try { entered.resolve(); await hold.promise; } finally { end(); }
  }, { priority: "background", kind: "industry-build" });
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    await entered.promise; permit = work.acquireSavedReadPermit();
    await assert.rejects(permit.run(() => { called = true; }), error => error.readGuard?.reason === "checkpoint_expired");
    const record = work.status().checkpointWaitDiagnostics.recent.at(-1);
    assert.equal(called, false);
    assert.equal(record.outcome, "rejected"); assert.equal(record.reason, "checkpoint_expired");
    assert.equal(record.deadline.ownerMatches, true); assert.equal(record.deadline.atomicWork, false);
    assert.equal(record.deadline.phaseIndex, 42); assert.equal(record.deadline.unitIndex, 3);
    assert.deepEqual(record.deadline.sourceWait, record.initial.sourceWait);
    assert.equal(record.deadline.sourceWait.maxBytes, 8 * 1024 * 1024);
    assert.equal(record.deadline.sourceWait.kind, "derived_cache_read");
    assert.equal(record.checkpointReadId, work.status().timing.recent.find(row => row.checkpointRead).id);
  } finally {
    clearTimeout(keepAlive); permit?.release(); hold.resolve();
    try { await permit?.waitForRelease(); } catch {}
    await background; await work.close();
  }
});

test("a source checkpoint wake still waits for a sibling atomic section and complete response cleanup", { timeout: 3000 }, async () => {
  const work = createAnalyticalWorkScheduler({ cooperativeYield: true, savedReadCheckpointWaitMs: 300 });
  const source = createSourceReadScheduler({ maxInteractiveHoldMs: 2500 });
  const entered = deferred(), go = deferred(), atomicEntered = deferred(), atomicDone = deferred(), hold = deferred();
  let atomic = false, called = false, ownerResumed = false, permit, preview;
  const background = work.run(() => source.run(async () => {
    entered.resolve(); await go.promise;
    const parked = source.checkpoint({ priority: "background" });
    await turn(); await turn();
    await runNonInterruptibleCooperativeWork(async () => { atomic = true; atomicEntered.resolve(); await atomicDone.promise; atomic = false; });
    await parked; ownerResumed = true;
  }, { priority: "background" }), { priority: "background", kind: "industry-build" });
  try {
    await entered.promise; preview = source.runInteractive(() => hold.promise); go.resolve(); await atomicEntered.promise;
    permit = work.acquireSavedReadPermit();
    const read = permit.run(() => { assert.equal(atomic, false); called = true; return 9; });
    await turn(); assert.equal(called, false);
    atomicDone.resolve(); assert.equal(await read, 9);
    hold.resolve(); await preview; await turn(); assert.equal(ownerResumed, false, "HTTP response lifetime retains the loan even after hold ends");
    permit.release(); await permit.waitForRelease(); await background;
    assert.equal(ownerResumed, true);
    const row = work.status().checkpointWaitDiagnostics.recent.at(-1);
    assert.equal(row.initial.atomicWork, true); assert.equal(row.final.atomicWork, false);
  } finally {
    atomicDone.resolve(); go.resolve(); hold.resolve();
    try { permit?.release(); } catch {}
    await permit?.waitForRelease(); await preview; await background; await work.close();
  }
});

test("wait observations have bounded transitions, records and bytes and return independent scalar copies", async () => {
  const work = createAnalyticalWorkScheduler({ cooperativeYield: true, readSavedReadTraceId: () => "bad/path/secret" });
  const entered = deferred(), makeTransitions = deferred(), transitionsDone = deferred(), hold = deferred();
  const background = work.run(async () => {
    entered.resolve(); await makeTransitions.promise;
    for (let index = 0; index < 100; index++) {
      const end = beginCooperativeSourceWait("derived_cache_read", 8); end();
    }
    transitionsDone.resolve(); await hold.promise;
  }, { priority: "background", kind: "industry-build" });
  try {
    await entered.promise;
    const permit = work.acquireSavedReadPermit(); makeTransitions.resolve(); await transitionsDone.promise;
    let diagnostics = work.status().checkpointWaitDiagnostics;
    assert.equal(diagnostics.active.transitions.length, 8);
    assert.ok(diagnostics.active.droppedTransitions > 0);
    assert.equal(diagnostics.active.traceId, null);
    permit.release();
    for (let index = 0; index < 40; index++) work.acquireSavedReadPermit().release();
    diagnostics = work.status().checkpointWaitDiagnostics;
    assert.ok(diagnostics.recent.length <= 32); assert.ok(diagnostics.droppedRecords > 0);
    assert.ok(Buffer.byteLength(JSON.stringify(diagnostics)) <= 64 * 1024);
    diagnostics.recent[0].initial.activeKind = "tampered";
    assert.equal(work.status().checkpointWaitDiagnostics.recent[0].initial.activeKind, "industry-build");
    assert.doesNotMatch(JSON.stringify(work.status().checkpointWaitDiagnostics), /bad\/path|secret|tampered/);
  } finally { hold.resolve(); makeTransitions.resolve(); await background; await work.close(); }
});

test("trace getter failures and diagnostic observations do not consume the admission clock or memory sampler", async () => {
  const options = { cooperativeYield: true, savedReadCheckpointWaitMs: 100 };
  async function run(readSavedReadTraceId, observations = false) {
    let nowCalls = 0, memoryCalls = 0;
    const work = createAnalyticalWorkScheduler({ ...options, now: () => { nowCalls++; return 100; },
      sampleMemory: () => { memoryCalls++; return { ratio: 0.1, sampledAt: 100 }; }, readSavedReadTraceId });
    const source = createSourceReadScheduler(), entered = deferred(), go = deferred();
    const background = work.run(async () => {
      entered.resolve(); await go.promise;
      if (observations) for (let index = 0; index < 20; index++) {
        const end = beginCooperativeSourceWait("derived_cache_read", 8); work.status(); end();
      }
      await source.checkpoint({ priority: "background" });
    }, { priority: "background", kind: "industry-build" });
    await entered.promise; const permit = work.acquireSavedReadPermit();
    const read = permit.run(() => 1); go.resolve(); assert.equal(await read, 1);
    permit.release(); await permit.waitForRelease(); await background;
    const row = work.status().checkpointWaitDiagnostics.recent.at(-1);
    const counts = { nowCalls, memoryCalls }; await work.close(); return { counts, row };
  }
  const normal = await run(null), throwing = await run(() => { throw new Error("secret"); }, true);
  assert.deepEqual(normal.counts, throwing.counts); assert.equal(throwing.row.traceId, null);
  assert.equal(throwing.row.outcome, "admitted");
  assert.throws(() => createAnalyticalWorkScheduler({ readSavedReadTraceId: "invalid" }), TypeError);
});

test("waking for a saved reader never extends the original interactive hold deadline", { timeout: 3000 }, async () => {
  const work = createAnalyticalWorkScheduler({ cooperativeYield: true, savedReadCheckpointWaitMs: 100 });
  const source = createSourceReadScheduler({ maxInteractiveHoldMs: 70 });
  const entered = deferred(), go = deferred(), hold = deferred();
  let permit, preview, resumed = false;
  const background = work.run(() => source.run(async () => {
    entered.resolve(); await go.promise; await source.checkpoint({ priority: "background" }); resumed = true;
  }, { priority: "background" }), { priority: "background", kind: "industry-build" });
  try {
    await entered.promise; preview = source.runInteractive(() => hold.promise); go.resolve();
    await new Promise(resolve => setTimeout(resolve, 40));
    permit = work.acquireSavedReadPermit(); assert.equal(await permit.run(() => 1), 1);
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.equal(source.interactiveStatus().activeLeases, 1);
    assert.equal(source.interactiveStatus().holdingBackground, false, "the 70ms timer started with the original cohort, not the later loan");
    assert.equal(resumed, false, "expired hold still cannot release an HTTP loan");
    permit.release(); await permit.waitForRelease(); await background; assert.equal(resumed, true);
  } finally {
    go.resolve(); hold.resolve(); try { permit?.release(); } catch {}
    await permit?.waitForRelease(); await preview; await background; await work.close();
  }
});

test("fully populated transition records are trimmed by the 64KiB budget before the 32 record ceiling", async () => {
  const work = createAnalyticalWorkScheduler({ cooperativeYield: true });
  const entered = deferred(), hold = deferred();
  const steps = Array.from({ length: 40 }, () => ({ begin: deferred(), done: deferred() }));
  const background = work.run(async () => {
    entered.resolve();
    for (const step of steps) {
      await step.begin.promise;
      for (let index = 0; index < 12; index++) {
        const end = beginCooperativeSourceWait("derived_cache_decode", 32 * 1024 * 1024); end();
      }
      step.done.resolve();
    }
    await hold.promise;
  }, { priority: "background", kind: "industry-build" });
  try {
    await entered.promise;
    for (const step of steps) {
      const permit = work.acquireSavedReadPermit(); step.begin.resolve(); await step.done.promise;
      const activeView = work.status().checkpointWaitDiagnostics;
      assert.ok(activeView.recent.length + 1 <= 32);
      assert.ok(Buffer.byteLength(JSON.stringify(activeView)) <= 64 * 1024, "active transition growth also stays within the complete budget");
      permit.release();
    }
    const diagnostics = work.status().checkpointWaitDiagnostics;
    assert.ok(diagnostics.recent.length < 32, "the byte budget, not only record count, must trim full records");
    assert.ok(Buffer.byteLength(JSON.stringify(diagnostics)) <= 64 * 1024);
    assert.ok(diagnostics.recent.every(row => row.transitions.length === 8 && row.droppedTransitions > 0));
  } finally { for (const step of steps) step.begin.resolve(); hold.resolve(); await background; await work.close(); }
});

test("two parked checkpoint branches cannot spin or overlap an existing proof reader", { timeout: 3000 }, async () => {
  const work = createAnalyticalWorkScheduler({ cooperativeYield: true }), source = createSourceReadScheduler();
  const entered = deferred(), go = deferred(), hold = deferred(), proofEntered = deferred(), proofDone = deferred();
  let preview, calls = 0;
  const background = work.run(() => source.run(async () => {
    entered.resolve(); await go.promise;
    await Promise.all([source.checkpoint({ priority: "background" }), source.checkpoint({ priority: "background" })]);
  }, { priority: "background" }), { priority: "background", kind: "industry-build" });
  try {
    await entered.promise; preview = source.runInteractive(() => hold.promise); go.resolve(); await turn(); await turn();
    const first = work.runCheckpointRead(async () => { calls++; proofEntered.resolve(); await proofDone.promise; return 1; });
    const second = work.runCheckpointRead(() => { assert.equal(calls, 1); calls++; return 2; });
    await proofEntered.promise; await turn(); assert.equal(calls, 1);
    proofDone.resolve(); assert.deepEqual(await Promise.all([first, second]), [1, 2]);
    assert.equal(calls, 2); assert.equal(source.interactiveStatus().holdingBackground, true);
  } finally { go.resolve(); hold.resolve(); proofDone.resolve(); await preview; await background; await work.close(); }
});

test("a maintenance pause prevents wake spin and resuming maintenance wakes only the parked checkpoint", { timeout: 3000 }, async () => {
  let held = false;
  const work = createAnalyticalWorkScheduler({ cooperativeYield: true, sampleIntervalMs: 5,
    externalAdmission: () => ({ allowed: !held, reasonCode: "SYNTHETIC_HOLD" }) });
  const source = createSourceReadScheduler(), entered = deferred(), go = deferred(), hold = deferred();
  let preview, calls = 0;
  const background = work.run(() => source.run(async () => {
    entered.resolve(); await go.promise; await source.checkpoint({ priority: "background" });
  }, { priority: "background" }), { priority: "background", kind: "industry-build" });
  try {
    await entered.promise; preview = source.runInteractive(() => hold.promise); go.resolve(); await turn(); await turn();
    held = true;
    for (let index = 0; index < 30 && !work.status().maintenance.paused; index++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(work.status().maintenance.paused, true);
    const proof = work.runCheckpointRead(() => { calls++; return 1; });
    await turn(); assert.equal(calls, 0);
    held = false; assert.equal(await proof, 1);
    assert.equal(source.interactiveStatus().holdingBackground, true);
  } finally { held = false; go.resolve(); hold.resolve(); await preview; await background; await work.close(); }
});

test("optional observation and wake hook failures cannot replace the original operation error", async () => {
  const expected = new Error("original operation");
  const owner = { enabled: true, isCurrent: () => true, nonInterruptibleDepth: 0,
    beginSourceWait: () => { throw new Error("diagnostic only"); },
    registerCheckpointWake: () => { throw new Error("wake only"); },
    notifyCheckpointWake: () => { throw new Error("wake only"); } };
  await runWithCooperativeWork(owner, async () => {
    assert.doesNotThrow(() => beginCooperativeSourceWait("derived_cache_read", 8)());
    assert.doesNotThrow(() => registerCooperativeCheckpointWake(() => {})());
    await assert.rejects(runNonInterruptibleCooperativeWork(() => { throw expected; }), error => error === expected);
  });
  assert.equal(owner.nonInterruptibleDepth, 0);
});
