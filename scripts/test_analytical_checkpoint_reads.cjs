"use strict";
const assert = require("node:assert/strict"), test = require("node:test"), { AsyncLocalStorage } = require("node:async_hooks");
const { createAnalyticalWorkScheduler } = require("./lib/analytical_work_scheduler.cjs");
const { createSourceReadScheduler } = require("./lib/source_read_scheduler.cjs");
const { cooperativeWorkCheckpoint, setCooperativeWorkPhase, runNonInterruptibleCooperativeWork } = require("./lib/cooperative_work_checkpoint.cjs");
const gate = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const turn = () => new Promise(resolve => setImmediate(resolve));
const background = { priority: "background", kind: "industry-build" };
const create = () => createAnalyticalWorkScheduler({ cooperativeYield: true, cooperativeMinRunMs: 0 });

test("a cached proof is served during a replay prefix without restarting the owner or crossing its allocation boundary", async () => {
  const scheduler = create(), source = createSourceReadScheduler(), entered = [gate(), gate()], proceed = [gate(), gate()];
  let attempts = 0, allocations = 0; const order = [];
  const work = scheduler.run(() => source.run(async () => {
    const attempt = attempts++; allocations++;
    try {
      if (!attempt) { setCooperativeWorkPhase(60); entered[0].resolve(); await proceed[0].promise; await source.checkpoint(background); }
      else {
        setCooperativeWorkPhase(42, 1); entered[1].resolve(); await proceed[1].promise;
        await source.checkpoint(background); order.push("background-after-proof");
        setCooperativeWorkPhase(70); await source.checkpoint(background);
      }
      return "complete";
    } finally { allocations--; }
  }, background), background);
  await entered[0].promise;
  const initial = scheduler.run(() => { assert.equal(allocations, 0); return "foreground"; });
  proceed[0].resolve(); assert.equal(await initial, "foreground"); await entered[1].promise;
  const proof = scheduler.runCheckpointRead(async () => { assert.equal(allocations, 1); assert.equal(source.status().active, true); order.push("proof"); await turn(); return { unchanged: true }; });
  proceed[1].resolve(); assert.deepEqual(await proof, { unchanged: true }); assert.equal(await work, "complete");
  assert.deepEqual(order, ["proof", "background-after-proof"]); assert.equal(attempts, 2);
  const state = scheduler.status(); assert.equal(state.timing.yielded, 1); assert.equal(state.timing.checkpointReadCompleted, 1);
  const row = state.timing.recent.find(row => row.checkpointRead); assert.equal(row.borrowed, true); assert.ok(row.parentId); assert.equal(row.outcome, "completed");
  await scheduler.close();
});

test("continuous bounded readers let every background checkpoint advance and never enter atomic publication", async () => {
  const scheduler = create(), source = createSourceReadScheduler(), entered = gate(), proceed = gate();
  let atomic = false, checkpoints = 0, callbacks = 0; const proofs = [];
  const enqueue = () => proofs.push(scheduler.runCheckpointRead(() => { assert.equal(atomic, false); callbacks++; return callbacks; }));
  const work = scheduler.run(async () => {
    entered.resolve(); await proceed.promise;
    await runNonInterruptibleCooperativeWork(async () => { atomic = true; await source.checkpoint(background); assert.equal(callbacks, 0); atomic = false; });
    for (let index = 0; index < 5; index++) { await source.checkpoint(background); checkpoints++; assert.equal(callbacks, Math.min(20, checkpoints * 4)); }
    return "finished";
  }, background);
  await entered.promise; for (let index = 0; index < 20; index++) enqueue(); proceed.resolve(); assert.equal(await work, "finished"); await Promise.all(proofs);
  assert.equal(checkpoints, 5); assert.equal(callbacks, 20); assert.equal(scheduler.status().timing.restarted, 0); await scheduler.close();
});

test("proof failure and nested analytical work cannot interrupt or deadlock the background owner", async () => {
  const scheduler = create(), source = createSourceReadScheduler(), entered = gate(), proceed = gate();
  const work = scheduler.run(async () => { entered.resolve(); await proceed.promise; await source.checkpoint(background); cooperativeWorkCheckpoint(); return 9; }, background);
  await entered.promise;
  const failed = scheduler.runCheckpointRead(async () => {
    await assert.rejects(scheduler.run(() => assert.fail("heavy nested work")), { code: "ANALYTICAL_CHECKPOINT_READ_NESTED_WORK" });
    await assert.rejects(scheduler.runCheckpointRead(() => 1), { code: "ANALYTICAL_CHECKPOINT_READ_NESTED_WORK" });
    throw Object.assign(Error("bounded proof unavailable"), { code: "PROOF_UNAVAILABLE" });
  });
  const rejection = assert.rejects(failed, { code: "PROOF_UNAVAILABLE" }); proceed.resolve(); await rejection; assert.equal(await work, 9);
  assert.equal(scheduler.status().timing.failed, 0); assert.equal(scheduler.status().timing.checkpointReadFailed, 1); await scheduler.close();
});

test("the borrowed callback restores its caller stores and cannot inherit the background cooperative scope", async () => {
  const scheduler = create(), source = createSourceReadScheduler(), lane = new AsyncLocalStorage(), entered = gate(), proceed = gate();
  let checkpoints;
  const work = lane.run("background", () => scheduler.run(async () => { entered.resolve(); await proceed.promise; await source.checkpoint(background); return lane.getStore(); }, background));
  await entered.promise;
  const proof = lane.run("request", () => scheduler.runCheckpointRead(() => {
    assert.equal(lane.getStore(), "request"); checkpoints = scheduler.status().cooperative.activeCheckpoints;
    cooperativeWorkCheckpoint(); assert.equal(scheduler.status().cooperative.activeCheckpoints, checkpoints); return "proof";
  }));
  proceed.resolve(); assert.equal(await proof, "proof"); assert.equal(await work, "background"); await scheduler.close();
});

test("abort and close wait for a borrowed proof's cleanup before background resumes", async () => {
  for (const mode of ["abort", "close"]) {
    const scheduler = create(), source = createSourceReadScheduler(), entered = gate(), proceed = gate(), proofEntered = gate(), release = gate(), controller = new AbortController();
    let resumed = false, signal;
    const work = scheduler.run(async () => { entered.resolve(); await proceed.promise; await source.checkpoint(background); resumed = true; return 1; }, background);
    await entered.promise;
    const proof = scheduler.runCheckpointRead(async info => { signal = info.signal; proofEntered.resolve(); try { await release.promise; } finally { assert.equal(resumed, false); } }, { signal: controller.signal });
    const rejected = assert.rejects(proof, { code: mode === "close" ? "ANALYTICAL_WORK_CLOSED" : "ANALYTICAL_WORK_ABORTED" });
    proceed.resolve(); await proofEntered.promise;
    let closing, closed = false;
    if (mode === "close") closing = scheduler.close().then(() => { closed = true; }); else controller.abort();
    await turn(); assert.equal(signal.aborted, true); assert.equal(resumed, false); assert.equal(closed, false);
    release.resolve(); await rejected; assert.equal(await work, 1); if (closing) await closing; else await scheduler.close();
  }
});

test("queued cancellation, ordinary owners and unsupported callbacks retain their explicit semantics", async () => {
  const scheduler = create(), entered = gate(), hold = gate(), controller = new AbortController();
  const work = scheduler.run(async () => { entered.resolve(); await hold.promise; return 1; }, { kind: "ordinary-owner" });
  await entered.promise; const pending = scheduler.runCheckpointRead(() => assert.fail("aborted queued read"), { signal: controller.signal });
  const rejection = assert.rejects(pending, { code: "ANALYTICAL_WORK_ABORTED" }); controller.abort(); await rejection; hold.resolve(); await work;
  assert.equal(await scheduler.runCheckpointRead(() => 7), 7);
  assert.equal(await scheduler.run(() => scheduler.runCheckpointRead(() => 8)), 8);
  await assert.rejects(scheduler.runCheckpointRead(() => 1, { kind: "arbitrary-heavy-work" }), TypeError);
  await scheduler.close(); await assert.rejects(scheduler.runCheckpointRead(() => 1), { code: "ANALYTICAL_WORK_CLOSED" });
});

test("an already owned proof shares cancellation but cannot release the enclosing owner before cleanup", async () => {
  const scheduler = create(), controller = new AbortController(), entered = gate(), release = gate(); let resumed = false, signal;
  const work = scheduler.run(async () => {
    const proof = scheduler.runCheckpointRead(async info => { signal = info.signal; entered.resolve(); try { await release.promise; } finally { assert.equal(resumed, false); } }, { signal: controller.signal });
    await assert.rejects(proof, { code: "ANALYTICAL_WORK_ABORTED" }); resumed = true; return 1;
  });
  await entered.promise; controller.abort(); await turn(); assert.equal(signal.aborted, true); assert.equal(resumed, false);
  release.resolve(); assert.equal(await work, 1); await scheduler.close();
});

test("an atomic owner rejects direct proof reentry instead of waiting for its own publication lock", async () => {
  const scheduler = create();
  assert.equal(await scheduler.run(() => runNonInterruptibleCooperativeWork(async () => {
    await assert.rejects(scheduler.runCheckpointRead(() => assert.fail("atomic proof reentry")), { code: "ANALYTICAL_CHECKPOINT_READ_ATOMIC_WORK" });
    return "published";
  }), background), "published");
  assert.equal(scheduler.status().queuedCheckpointReads, 0); await scheduler.close();
});

test("bounded proof timing callbacks receive only the settled controlled record", async () => {
  const scheduler = create(), records = [];
  assert.equal(await scheduler.runCheckpointRead(() => ({ privateValue: "not a diagnostic" }), { onTaskTiming: value => records.push(value) }).then(value => value.privateValue), "not a diagnostic");
  assert.equal(records.length, 1); assert.equal(records[0].checkpointRead, true); assert.equal(records[0].outcome, "completed");
  assert.doesNotMatch(JSON.stringify(records), /privateValue|not a diagnostic/); await scheduler.close();
});

test("a long foreground source can lend safe checkpoints without gaining background yield eligibility", async () => {
  const scheduler = create(), source = createSourceReadScheduler(), entered = gate(), proceed = gate(); let inAtomic = false, proofRan = false;
  const work = scheduler.run(async () => {
    entered.resolve(); await proceed.promise;
    assert.equal(scheduler.status().cooperative.activeEligible, false);
    await runNonInterruptibleCooperativeWork(async () => { inAtomic = true; await source.checkpoint({ priority: "foreground" }); assert.equal(proofRan, false); inAtomic = false; });
    await source.checkpoint({ priority: "foreground" }); assert.equal(proofRan, true);
    cooperativeWorkCheckpoint(); return "foreground-complete";
  }, { kind: "company-detail" });
  await entered.promise;
  const proof = scheduler.runCheckpointRead(() => { assert.equal(inAtomic, false); proofRan = true; return "proof-ready"; });
  const ordinary = scheduler.run(() => "ordinary-next"); proceed.resolve();
  assert.equal(await proof, "proof-ready"); assert.equal(await work, "foreground-complete"); assert.equal(await ordinary, "ordinary-next");
  assert.equal(scheduler.status().timing.yielded, 0); assert.equal(scheduler.status().timing.restarted, 0); await scheduler.close();
});

test("a sibling async publication waits for the borrowed proof while that proof can atomically publish its own bounded certificate", async () => {
  const scheduler = create(), source = createSourceReadScheduler(), entered = gate(), proceed = gate(), proofEntered = gate(), release = gate();
  let proofExited = false, published = false;
  const work = scheduler.run(async () => {
    entered.resolve(); await proceed.promise;
    const checkpoint = source.checkpoint({ priority: "foreground" });
    await proofEntered.promise;
    const publication = runNonInterruptibleCooperativeWork(async () => { assert.equal(proofExited, true); published = true; });
    await turn(); assert.equal(published, false);
    release.resolve(); await Promise.all([checkpoint, publication]); return "complete";
  });
  await entered.promise;
  const proof = scheduler.runCheckpointRead(async () => {
    await runNonInterruptibleCooperativeWork(async () => { proofEntered.resolve(); await release.promise; });
    proofExited = true; return "checked";
  });
  proceed.resolve(); assert.equal(await proof, "checked"); assert.equal(await work, "complete"); assert.equal(published, true); await scheduler.close();
});
