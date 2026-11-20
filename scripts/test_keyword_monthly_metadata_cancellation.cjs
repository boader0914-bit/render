"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { createKeywordMonthlyQueryLifecycle } = require("./lib/keyword_monthly_query_lifecycle.cjs");
const { createKeywordMonthlyResponseBudget } = require("./lib/keyword_monthly_response_budget.cjs");
const { createKeywordMonthlyHttpHandler } = require("./lib/keyword_monthly_http.cjs");
const { createKeywordMonthlySavedReadService } = require("./lib/keyword_monthly_saved_read_service.cjs");
const { createKeywordMonthlyBundleAnalysis } = require("./lib/keyword_monthly_bundle.cjs");
const { createKeywordMonthlyRequestDiagnostics } = require("./lib/keyword_monthly_request_diagnostics.cjs");
const { METADATA_FS_PHASES, withKeywordMonthlyMetadataMeasure, captureKeywordMonthlyMetadataFsObserver } = require("./lib/keyword_monthly_metadata_diagnostics.cjs");
const { EventEmitter } = require("node:events"), fs = require("node:fs/promises"), path = require("node:path"), os = require("node:os");
const turn = () => new Promise(resolve => setImmediate(resolve));
async function until(check) { for (let index = 0; index < 200; index++) { if (check()) return; await turn(); } assert.fail("bounded fixture did not settle"); }
function gate() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function metadataClock() {
  let at = 0, sequence = 0;
  const timers = new Map();
  return { now: () => at, setTimeoutImpl(fn, ms) { const handle = { id: ++sequence, unref() {} }; timers.set(handle, { fn, ms, due: at + ms }); return handle; },
    clearTimeoutImpl: handle => timers.delete(handle), timers,
    set(value, fire = true) { at = value; if (fire) for (const [handle, row] of [...timers]) if (row.due <= at) { timers.delete(handle); row.fn(); } } };
}

test("metadata FIFO waits for actual abandoned cleanup then starts the next catalogue within its original deadline", async () => {
  const clock = metadataClock(), cleanup = gate(), abort = new AbortController();
  const lifecycle = createKeywordMonthlyQueryLifecycle({ ...clock, maxInFlight: 1, maxWaiters: 8, timeoutMs: 5000 });
  let calls = 0, oldLifetime, released = false;
  const first = lifecycle.run("version-old", async () => { await cleanup.promise; return 1; },
    { metadataKind: "version", signal: abort.signal, onOperationLifetime(value) { oldLifetime = value; value.then(() => { released = true; }); } });
  await turn(); clock.set(4639); const rejected = assert.rejects(first, { code: "KEYWORD_MONTHLY_QUERY_ABORTED" }); abort.abort(); await rejected;
  clock.set(5481);
  const next = lifecycle.run("catalogue-new", () => { assert.equal(released, true); calls++; return 2; }, { metadataKind: "catalogue" });
  assert.equal(calls, 0); assert.equal(lifecycle.status().queuedMetadataCallers, 1); assert.equal(lifecycle.status().inFlight, 1);
  assert.equal(lifecycle.status().operationDiagnostics.queued[0].deadlineAt, 10481);
  clock.set(5895); cleanup.resolve(); await oldLifetime;
  assert.equal(await next, 2); assert.equal(calls, 1); assert.equal(lifecycle.status().inFlight, 0); assert.equal(clock.timers.size, 0); lifecycle.close();
});

test("metadata queue and operation share one original 5000ms deadline without promotion reset", async () => {
  const clock = metadataClock(), old = gate(), nextDone = gate();
  const lifecycle = createKeywordMonthlyQueryLifecycle({ ...clock, maxInFlight: 1, timeoutMs: 5000 });
  const first = lifecycle.run("generic", () => old.promise); await turn();
  clock.set(100); let calls = 0;
  const next = lifecycle.run("catalogue", () => { calls++; return nextDone.promise; }, { metadataKind: "catalogue" });
  const rejected = assert.rejects(next, { code: "KEYWORD_MONTHLY_QUERY_TIMEOUT" });
  clock.set(600); old.resolve(1); assert.equal(await first, 1); await turn(); assert.equal(calls, 1);
  assert.equal(clock.timers.size, 1); assert.equal([...clock.timers.values()][0].due, 5100); assert.equal([...clock.timers.values()][0].ms, 5000);
  clock.set(5100); await rejected; assert.equal(lifecycle.status().inFlight, 1);
  nextDone.resolve(2); await turn(); assert.equal(lifecycle.status().inFlight, 0); lifecycle.close();
});

test("an expired queued caller resolves its resource lifetime without starting filesystem work", async () => {
  const clock = metadataClock(), old = gate(); let calls = 0, lifetime;
  const lifecycle = createKeywordMonthlyQueryLifecycle({ ...clock, maxInFlight: 1, timeoutMs: 5000 });
  const first = lifecycle.run("generic", () => old.promise); const firstReject = assert.rejects(first, { code: "KEYWORD_MONTHLY_QUERY_TIMEOUT" }); await turn();
  const queued = lifecycle.run("catalogue", () => { calls++; }, { metadataKind: "catalogue", onOperationLifetime(value) { lifetime = value; } });
  const queuedReject = assert.rejects(queued, { code: "KEYWORD_MONTHLY_QUERY_TIMEOUT" });
  clock.set(5000); await Promise.all([firstReject, queuedReject, lifetime]);
  assert.equal(calls, 0); assert.equal(lifecycle.status().queuedMetadataCallers, 0); assert.equal(lifecycle.status().inFlight, 1);
  old.resolve(); await turn(); assert.equal(lifecycle.status().inFlight, 0); assert.equal(clock.timers.size, 0); lifecycle.close();
});

test("queued metadata abort and close drop only their caller and never promote canceled work", async () => {
  const old = gate(), abort = new AbortController(); let calls = 0, lifetimeA, lifetimeB;
  const lifecycle = createKeywordMonthlyQueryLifecycle({ maxInFlight: 1, timeoutMs: 5000 });
  const first = lifecycle.run("generic", () => old.promise); const firstReject = assert.rejects(first, { code: "KEYWORD_MONTHLY_QUERY_CLOSED" });
  const a = lifecycle.run("a", () => { calls++; }, { metadataKind: "version", signal: abort.signal, onOperationLifetime(p) { lifetimeA = p; } });
  const aReject = assert.rejects(a, { code: "KEYWORD_MONTHLY_QUERY_ABORTED" });
  const b = lifecycle.run("b", () => { calls++; }, { metadataKind: "catalogue", onOperationLifetime(p) { lifetimeB = p; } });
  const bReject = assert.rejects(b, { code: "KEYWORD_MONTHLY_QUERY_CLOSED" });
  abort.abort(); await aReject; assert.equal(lifecycle.status().queuedMetadataCallers, 1);
  lifecycle.close(); await Promise.all([firstReject, bReject, lifetimeA, lifetimeB]);
  assert.equal(calls, 0); assert.equal(lifecycle.status().waitingCallers, 0); old.resolve(); await turn(); assert.equal(lifecycle.status().inFlight, 0);
});

test("the shared status caller bound counts generic active plus all queued metadata and never queues refresh status", async () => {
  const old = gate(), lifecycle = createKeywordMonthlyQueryLifecycle({ maxInFlight: 1, maxWaiters: 8, timeoutMs: 5000 });
  let starts = 0; const first = lifecycle.run("refresh", () => old.promise, { metadataKind: "refresh_status" }); await turn();
  const controllers = Array.from({ length: 7 }, () => new AbortController());
  const pending = controllers.map((controller, index) => lifecycle.run(`metadata-${index}`, () => { starts++; }, { metadataKind: "catalogue", signal: controller.signal }));
  const rejections = pending.map(p => assert.rejects(p, { code: "KEYWORD_MONTHLY_QUERY_ABORTED" }));
  assert.equal(lifecycle.status().waitingCallers, 8); assert.equal(lifecycle.status().queuedMetadataCallers, 7);
  await assert.rejects(lifecycle.run("ninth", () => assert.fail("over cap"), { metadataKind: "version" }), { code: "KEYWORD_MONTHLY_QUERY_BUSY" });
  await assert.rejects(lifecycle.run("refresh-peer", () => assert.fail("refresh queued"), { metadataKind: "refresh_status" }), { code: "KEYWORD_MONTHLY_QUERY_BUSY" });
  await assert.rejects(lifecycle.run("refresh", () => assert.fail("refresh joined over cap"), { metadataKind: "refresh_status" }), { code: "KEYWORD_MONTHLY_QUERY_BUSY" });
  assert.equal(lifecycle.status().queuedMetadataCallers, 7); controllers.forEach(controller => controller.abort()); await Promise.all(rejections);
  assert.equal(starts, 0); old.resolve(1); assert.equal(await first, 1); lifecycle.close();
});

test("metadata producer FIFO preserves order and coalesces same-key queued peers only after promotion", async () => {
  const old = gate(), aDone = gate(), order = [], lifecycle = createKeywordMonthlyQueryLifecycle({ maxInFlight: 1, timeoutMs: 5000 });
  const first = lifecycle.run("generic", () => old.promise); await turn();
  const a = lifecycle.run("a", () => { order.push("a"); return aDone.promise; }, { metadataKind: "catalogue" });
  const b = lifecycle.run("b", () => { order.push("b"); return 2; }, { metadataKind: "version" });
  const peer = lifecycle.run("a", () => assert.fail("same key duplicate"), { metadataKind: "catalogue" });
  old.resolve(); await first; await turn(); assert.deepEqual(order, ["a"]); assert.equal(lifecycle.status().waitingCallers, 3); assert.equal(lifecycle.status().queuedMetadataCallers, 1);
  aDone.resolve(1); assert.deepEqual(await Promise.all([a, peer, b]), [1, 1, 2]); assert.deepEqual(order, ["a", "b"]); lifecycle.close();
});

test("a metadata owner's pre-microtask abort cannot suppress its still-live shared peer's single producer", async () => {
  const abort = new AbortController(), lifecycle = createKeywordMonthlyQueryLifecycle({ maxInFlight: 1, timeoutMs: 5000 });
  let calls = 0, signal;
  const first = lifecycle.run("same", context => { calls++; signal = context.signal; return 9; }, { metadataKind: "version", signal: abort.signal });
  const rejected = assert.rejects(first, { code: "KEYWORD_MONTHLY_QUERY_ABORTED" });
  const peer = lifecycle.run("same", () => assert.fail("shared producer duplicated"), { metadataKind: "version" });
  abort.abort(); await rejected; assert.equal(await peer, 9); assert.equal(calls, 1); assert.equal(signal.aborted, false); lifecycle.close();
});

test("a metadata owner's pre-microtask deadline cannot suppress a newer still-live peer", async () => {
  const clock = metadataClock(), lifecycle = createKeywordMonthlyQueryLifecycle({ ...clock, maxInFlight: 1, timeoutMs: 5000 }); let calls = 0;
  const first = lifecycle.run("same", () => { calls++; return 11; }, { metadataKind: "catalogue" });
  const rejected = assert.rejects(first, { code: "KEYWORD_MONTHLY_QUERY_TIMEOUT" });
  clock.set(100, false); const peer = lifecycle.run("same", () => assert.fail("duplicate"), { metadataKind: "catalogue" });
  clock.set(5000); await rejected; assert.equal(await peer, 11); assert.equal(calls, 1); lifecycle.close();
});

test("queued promotion catches a throwing admission clock without leaving a caller, timer, or producer", async () => {
  const clock = metadataClock(), old = gate(), abort = new AbortController(); let reads = 0, throwAt = Infinity, calls = 0, lifetime;
  const lifecycle = createKeywordMonthlyQueryLifecycle({ ...clock, now() { if (++reads === throwAt) throw Error("private clock"); return clock.now(); }, maxInFlight: 1, timeoutMs: 5000 });
  const first = lifecycle.run("old", () => old.promise, { metadataKind: "version", signal: abort.signal }); await turn();
  const firstReject = assert.rejects(first, { code: "KEYWORD_MONTHLY_QUERY_ABORTED" }); abort.abort(); await firstReject;
  const next = lifecycle.run("next", () => { calls++; }, { metadataKind: "catalogue", onOperationLifetime(value) { lifetime = value; } });
  const rejected = assert.rejects(next, { code: "KEYWORD_MONTHLY_QUERY_CLOCK_INVALID" });
  throwAt = reads + 3; old.resolve(); await rejected; await lifetime; throwAt = Infinity;
  assert.equal(calls, 0); assert.equal(clock.timers.size, 0); assert.equal(lifecycle.status().inFlight, 0); assert.equal(lifecycle.status().waitingCallers, 0); lifecycle.close();
});

test("expired queued metadata cannot start when its timer callback is delayed", async () => {
  const clock = metadataClock(), old = gate(), lifecycle = createKeywordMonthlyQueryLifecycle({ ...clock, maxInFlight: 1, timeoutMs: 5000 }); let starts = 0;
  const first = lifecycle.run("generic", () => old.promise); await turn();
  const next = lifecycle.run("next", () => { starts++; }, { metadataKind: "version" }); const rejected = assert.rejects(next, { code: "KEYWORD_MONTHLY_QUERY_TIMEOUT" });
  clock.set(5100, false); old.resolve(); await first; await rejected;
  assert.equal(starts, 0); assert.equal(lifecycle.status().inFlight, 0); assert.equal(clock.timers.size, 0); lifecycle.close();
});

test("metadata cannot adopt a response after the total deadline when its timer is delayed", async () => {
  const clock = metadataClock(), done = gate(), lifecycle = createKeywordMonthlyQueryLifecycle({ ...clock, maxInFlight: 1, timeoutMs: 5000 });
  const next = lifecycle.run("next", () => done.promise, { metadataKind: "catalogue" }); const rejected = assert.rejects(next, { code: "KEYWORD_MONTHLY_QUERY_TIMEOUT" }); await turn();
  clock.set(5000, false); done.resolve({ status: "available" }); await rejected; assert.equal(lifecycle.status().inFlight, 0); assert.equal(clock.timers.size, 0); lifecycle.close();
});

test("metadata queued lifetime hook failures never allocate work, leak waiters, or disturb the old cleanup owner", async () => {
  const old = gate(), lifecycle = createKeywordMonthlyQueryLifecycle({ maxInFlight: 1, timeoutMs: 5000 });
  const first = lifecycle.run("generic", () => old.promise); await turn();
  for (const hook of [() => { throw Error("private"); }, () => true, async () => { throw Error("private async"); }]) {
    await assert.rejects(lifecycle.run("queued", () => assert.fail("failed lifetime queued work started"), { metadataKind: "catalogue", onOperationLifetime: hook }), { code: "KEYWORD_MONTHLY_RESPONSE_LIFETIME_UNAVAILABLE" });
    assert.equal(lifecycle.status().queuedMetadataCallers, 0); assert.equal(lifecycle.status().waitingCallers, 1); assert.equal(lifecycle.status().inFlight, 1);
  }
  await turn(); old.resolve(); await first; lifecycle.close();
});

test("queued producer promotion preserves its original asynchronous request context", async () => {
  const { AsyncLocalStorage } = require("node:async_hooks"), context = new AsyncLocalStorage(), old = gate();
  const lifecycle = createKeywordMonthlyQueryLifecycle({ maxInFlight: 1, timeoutMs: 5000 });
  const first = context.run("old-trace", () => lifecycle.run("generic", () => old.promise)); await turn();
  const next = context.run("new-trace", () => lifecycle.run("next", () => context.getStore(), { metadataKind: "catalogue" }));
  old.resolve(); await first; assert.equal(await next, "new-trace"); lifecycle.close();
});

test("a generic producer cannot overtake already queued metadata in the old completion callback", async () => {
  const old = gate(), lifecycle = createKeywordMonthlyQueryLifecycle({ maxInFlight: 1, timeoutMs: 5000 }); let attempted;
  const first = lifecycle.run("generic", () => old.promise, { onOperationSettled() { attempted = assert.rejects(lifecycle.run("refresh", () => assert.fail("FIFO overtaken"), { metadataKind: "refresh_status" }), { code: "KEYWORD_MONTHLY_QUERY_BUSY" }); } }); await turn();
  const next = lifecycle.run("next", () => 3, { metadataKind: "version" }); old.resolve(); await first; await attempted; assert.equal(await next, 3); lifecycle.close();
});

test("only an explicitly opted-in metadata producer is canceled after its final waiter leaves, and owns its cleanup until settled", async () => {
  const lifecycle = createKeywordMonthlyQueryLifecycle({ maxInFlight: 1, timeoutMs: 5000 }), caller = new AbortController(), cleanup = gate();
  let producerSignal, retained;
  const pending = lifecycle.run("version", async context => { producerSignal = context?.signal; await cleanup.promise; return 1; },
    { signal: caller.signal, metadataKind: "version", ownerTraceId: "8af7c66bb20501b9e7e23ad1", onOperationLifetime: promise => { retained = promise; } });
  try {
    await turn(); const rejected = assert.rejects(pending, error => error.code === "KEYWORD_MONTHLY_QUERY_ABORTED"); caller.abort(); await rejected;
    assert.equal(producerSignal?.aborted, true);
    assert.equal(lifecycle.status().inFlight, 1); assert.equal(lifecycle.status().abandonedInFlight, 1);
    let released = false; retained.then(() => { released = true; }); await turn(); assert.equal(released, false);
    await assert.rejects(lifecycle.run("catalogue", () => assert.fail("cannot overlap unresolved cleanup")), error => error.code === "KEYWORD_MONTHLY_QUERY_BUSY");
    cleanup.resolve(); await retained; await turn(); assert.equal(lifecycle.status().inFlight, 0);
    const record = lifecycle.status().operationDiagnostics.recent.at(-1);
    assert.equal(record.kind, "version"); assert.equal(record.ownerTraceId, "8af7c66bb20501b9e7e23ad1");
    assert.equal(record.outcome, "aborted"); assert.equal(typeof record.settledAt, "number");
  } finally { cleanup.resolve(); await pending.catch(() => {}); lifecycle.close(); }
});

test("one canceled metadata peer cannot cancel its surviving shared waiter", async () => {
  const lifecycle = createKeywordMonthlyQueryLifecycle({ maxInFlight: 1 }), caller = new AbortController(), done = gate();
  let signal, calls = 0;
  const first = lifecycle.run("catalogue", async context => { signal = context.signal; calls++; await done.promise; return 7; }, { signal: caller.signal, metadataKind: "catalogue" });
  const peer = lifecycle.run("catalogue", () => assert.fail("shared producer duplicated"), { metadataKind: "catalogue" });
  await turn(); const rejected = assert.rejects(first, error => error.code === "KEYWORD_MONTHLY_QUERY_ABORTED"); caller.abort(); await rejected;
  assert.equal(signal.aborted, false); assert.equal(lifecycle.status().waitingCallers, 1);
  done.resolve(); assert.equal(await peer, 7); assert.equal(calls, 1); assert.equal(lifecycle.status().inFlight, 0); lifecycle.close();
});

test("the last shared metadata peer requests producer abort exactly once and cannot revive canceled work", async () => {
  const lifecycle = createKeywordMonthlyQueryLifecycle({ maxInFlight: 1 }), firstCancel = new AbortController(), peerCancel = new AbortController(), done = gate();
  let aborts = 0, calls = 0;
  const first = lifecycle.run("version", async ({signal}) => { calls++; signal.addEventListener("abort", () => { aborts++; }); await done.promise; }, { signal:firstCancel.signal, metadataKind:"version" });
  const peer = lifecycle.run("version", () => assert.fail("duplicate"), {signal:peerCancel.signal,metadataKind:"version"});
  await turn(); const a = assert.rejects(first, {code:"KEYWORD_MONTHLY_QUERY_ABORTED"}); firstCancel.abort(); await a; assert.equal(aborts,0);
  const b = assert.rejects(peer, {code:"KEYWORD_MONTHLY_QUERY_ABORTED"}); peerCancel.abort(); await b; assert.equal(aborts,1);
  const queuedCancel=new AbortController(),queued=lifecycle.run("version",()=>assert.fail("revived before cleanup"),{metadataKind:"version",signal:queuedCancel.signal});
  const queuedRejected=assert.rejects(queued,{code:"KEYWORD_MONTHLY_QUERY_ABORTED"});queuedCancel.abort();await queuedRejected;
  done.resolve(); await until(() => lifecycle.status().inFlight===0); assert.equal(aborts,1); assert.equal(calls,1); lifecycle.close();
});

test("generic and financial flight defaults retain their original noncancelling shared-work contract", async () => {
  const lifecycle = createKeywordMonthlyQueryLifecycle({ maxInFlight: 1 }), caller = new AbortController(), done = gate();
  let context, calls = 0;
  const first = lifecycle.run("financial", async value => { context = value; calls++; await done.promise; return 8; }, { signal: caller.signal });
  await turn(); const rejected = assert.rejects(first, error => error.code === "KEYWORD_MONTHLY_QUERY_ABORTED"); caller.abort(); await rejected;
  assert.equal(context, undefined); assert.equal(lifecycle.status().abandonedInFlight, 1);
  const peer = lifecycle.run("financial", () => assert.fail("duplicate financial work")); done.resolve(); assert.equal(await peer, 8);
  assert.equal(calls, 1); lifecycle.close();
});

test("metadata lifetime registration fails closed before a producer starts or a shared owner is disturbed", async () => {
  const lifecycle = createKeywordMonthlyQueryLifecycle({ maxInFlight: 1 }), done = gate(); let calls = 0;
  await assert.rejects(lifecycle.run("version", () => { calls++; }, { metadataKind: "version", onOperationLifetime() { throw Error("private lifetime error"); } }),
    error => error.code === "KEYWORD_MONTHLY_RESPONSE_LIFETIME_UNAVAILABLE");
  assert.equal(calls, 0); assert.equal(lifecycle.status().inFlight, 0);
  const first = lifecycle.run("version", async () => { calls++; await done.promise; return 3; }, { metadataKind: "version" }); await turn();
  await assert.rejects(lifecycle.run("version", () => assert.fail("shared duplicate"), { metadataKind: "version", onOperationLifetime() { throw Error("private"); } }),
    error => error.code === "KEYWORD_MONTHLY_RESPONSE_LIFETIME_UNAVAILABLE");
  assert.equal(lifecycle.status().waitingCallers, 1); done.resolve(); assert.equal(await first, 3); assert.equal(calls, 1);
  assert.ok(!JSON.stringify(lifecycle.status()).includes("private")); lifecycle.close();
});

test("non-void or asynchronous lifetime hooks fail closed and rejected hook promises are absorbed", async () => {
  for (const hook of [() => true, () => ({}), async () => {}, async () => { throw Error("private async hook"); }]) {
    const lifecycle = createKeywordMonthlyQueryLifecycle({ maxInFlight: 1 }); let calls = 0;
    await assert.rejects(lifecycle.run("version", () => { calls++; }, { metadataKind: "version", onOperationLifetime: hook }),
      error => error.code === "KEYWORD_MONTHLY_RESPONSE_LIFETIME_UNAVAILABLE");
    await turn(); assert.equal(calls, 0); assert.equal(lifecycle.status().inFlight, 0); lifecycle.close();
  }
});

test("metadata timeout remains 5000ms and cannot recycle an ignored producer cleanup", async () => {
  const timers = new Map(), done = gate(); let signal, lifetime;
  const lifecycle = createKeywordMonthlyQueryLifecycle({ maxInFlight: 1, timeoutMs: 5000,
    setTimeoutImpl(fn, ms) { const handle = { unref() {} }; timers.set(handle, { fn, ms }); return handle; }, clearTimeoutImpl: handle => timers.delete(handle) });
  const first = lifecycle.run("version", async context => { signal = context.signal; await done.promise; return 0; },
    { metadataKind: "version", onOperationLifetime: promise => { lifetime = promise; } });
  await turn(); const timer = [...timers.values()][0]; assert.equal(timer.ms, 5000);
  const rejected = assert.rejects(first, error => error.code === "KEYWORD_MONTHLY_QUERY_TIMEOUT"); timer.fn(); await rejected;
  assert.equal(signal.aborted, true); assert.equal(lifecycle.status().inFlight, 1);
  const queuedCancel=new AbortController(),queued=lifecycle.run("version",()=>assert.fail("canceled producer revived"),{metadataKind:"version",signal:queuedCancel.signal});
  const queuedRejected=assert.rejects(queued,{code:"KEYWORD_MONTHLY_QUERY_ABORTED"});queuedCancel.abort();await queuedRejected;
  done.resolve(); await lifetime; assert.equal(lifecycle.status().inFlight, 0); lifecycle.close();
});

test("response byte reservations outlive an early waiter failure until the actual metadata producer settles", async () => {
  const lifecycle = createKeywordMonthlyQueryLifecycle({ maxInFlight: 1 }), budget = createKeywordMonthlyResponseBudget({ maxResponseBytes: 10, maxReservedBytes: 10 });
  const caller = new AbortController(), done = gate(), response = new EventEmitter(); response.writeHead = response.end = () => {};
  const producing = budget.run(response, context => lifecycle.run("catalogue", () => done.promise,
    { signal: caller.signal, metadataKind: "catalogue", onOperationLifetime: context.retainUntil }));
  await turn(); const rejected = assert.rejects(producing, error => error.code === "KEYWORD_MONTHLY_QUERY_ABORTED"); caller.abort(); await rejected;
  assert.equal(budget.status().reservedBytes, 10); assert.equal(lifecycle.status().inFlight, 1);
  await assert.rejects(budget.run(response, () => assert.fail("recycled bytes")), error => error.code === "KEYWORD_MONTHLY_RESPONSE_BUSY");
  done.resolve(); await turn(); await turn(); assert.equal(budget.status().reservedBytes, 0); assert.equal(lifecycle.status().inFlight, 0); lifecycle.close();
});

test("a native metadata HTTP timeout is returned at the existing deadline while producer bytes remain reserved", async () => {
  let expire,signal;const done=gate(),lifecycle=createKeywordMonthlyQueryLifecycle({maxInFlight:1,timeoutMs:5000,
    setTimeoutImpl(callback,ms){assert.equal(ms,5000);expire=callback;return {unref(){}};},clearTimeoutImpl(){}});
  const budget=createKeywordMonthlyResponseBudget({maxResponseBytes:2048,maxReservedBytes:4096});
  const req=new EventEmitter(),res=new EventEmitter();req.method="GET";req.headers={};res.setHeader=()=>{};res.writeHead=res.end=()=>{};
  const handler=createKeywordMonthlyHttpHandler({service:{options:async()=>({}),analyze:async()=>({}),version:async context=>{signal=context.signal;await done.promise;return {status:"available"};}},
    statusLifecycle:lifecycle,statusResponseBudget:budget,requireAdmin:()=>true,send:(_res,status,body)=>{res.status=status;res.body=body;res.writableEnded=true;res.emit("finish");}});
  const request=handler(req,res,new URL("https://fixture.test/api/keyword-monthly/version"),{});await turn();expire();await request;
  assert.equal(res.status,503);assert.equal(res.body.code,"KEYWORD_MONTHLY_QUERY_TIMEOUT");assert.equal(signal.aborted,true);
  assert.equal(lifecycle.status().inFlight,1);assert.equal(budget.status().reservedBytes,2048);
  done.resolve();await until(()=>lifecycle.status().inFlight===0&&budget.status().reservedBytes===0);lifecycle.close();
});

test("an optional trace getter failure cannot prevent an admitted metadata response", async () => {
  const diagnostics=createKeywordMonthlyRequestDiagnostics({onLog:null}),req=new EventEmitter(),res=new EventEmitter();req.method="GET";req.headers={};res.setHeader=()=>{};
  const handler=createKeywordMonthlyHttpHandler({service:{options:async()=>({}),analyze:async()=>({}),version:async()=>({status:"available"})},
    requestDiagnostics:{...diagnostics,currentTraceId(){throw Error("private trace getter");}},requireAdmin:()=>true,
    send:(_res,status,body)=>{res.status=status;res.body=body;res.writableEnded=true;}});
  await handler(req,res,new URL("https://fixture.test/api/keyword-monthly/version"),{});assert.equal(res.status,200);assert.equal(res.body.status,"available");
});

async function pointerFixture(work) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "staydatalab-metadata-cancel-")), file = path.join(directory, "current.json");
  try {
    await fs.writeFile(file, JSON.stringify({ schemaVersion: 1, generation: "a".repeat(32), catalogSha256: "b".repeat(64), catalogBytes: 10, publishedAt: "2026-11-20T00:00:00.000Z" }));
    return await work(directory, file);
  } finally {
    assert.equal(path.dirname(directory), os.tmpdir()); assert.ok(path.basename(directory).startsWith("staydatalab-metadata-cancel-"));
    await fs.rm(directory, { recursive: true, force: true });
  }
}

test("version and catalogue abort between bounded filesystem stages and await real handle.close without returning success", async () => {
  for (const kind of ["version", "catalogue"]) await pointerFixture(async (directory, file) => {
    const readEntered = gate(), finishRead = gate(), closeEntered = gate(), finishClose = gate(), cancel = new AbortController();
    const originalOpen = fs.open; let opens = 0, settled = false;
    fs.open = async (...args) => {
      const handle = await originalOpen(...args); if (path.resolve(args[0]) !== file) return handle; opens++;
      return { stat: () => handle.stat(), async read(...values) { readEntered.resolve(); await finishRead.promise; return handle.read(...values); },
        async close() { closeEntered.resolve(); await finishClose.promise; return handle.close(); } };
    };
    let pending;
    try {
      const bundle = createKeywordMonthlyBundleAnalysis({ projectionDir: directory });
      pending = bundle[kind]({ signal: cancel.signal }); pending.finally(() => { settled = true; }).catch(() => {});
      const rejected = assert.rejects(pending, error => error.code === "KEYWORD_MONTHLY_QUERY_ABORTED");
      await readEntered.promise; cancel.abort(); await turn(); assert.equal(settled, false);
      finishRead.resolve(); await closeEntered.promise; await turn(); assert.equal(settled, false, "descriptor cleanup remains owned");
      finishClose.resolve(); await rejected; assert.equal(opens, 1, "no canceled pointer revalidation or catalogue opening");
    } finally { finishRead.resolve(); finishClose.resolve(); await pending?.catch(() => {}); fs.open = originalOpen; }
  });
});

test("metadata HTTP cancellation holds bytes through deferred lstat read and real handle cleanup", async () => {
for(const stage of ["lstat","read"])await pointerFixture(async (directory, file) => {
  const readEntered = gate(), finishRead = gate(), closeEntered = gate(), finishClose = gate(), originalOpen = fs.open, originalLstat=fs.lstat;
  const lifecycle = createKeywordMonthlyQueryLifecycle({ maxInFlight: 1 }), budget = createKeywordMonthlyResponseBudget({ maxResponseBytes: 2048, maxReservedBytes: 4096 });
  let opens=0;
  fs.lstat=async(...args)=>{if(stage==="lstat"&&path.resolve(args[0])===file){readEntered.resolve();await finishRead.promise;}return originalLstat(...args);};
  fs.open = async (...args) => {
    const handle = await originalOpen(...args); if (path.resolve(args[0]) !== file) return handle;opens++;
    return { stat: () => handle.stat(), async read(...values) { readEntered.resolve(); await finishRead.promise; return handle.read(...values); },
      async close() { closeEntered.resolve(); await finishClose.promise; return handle.close(); } };
  };
  const service = createKeywordMonthlySavedReadService({ saved: { ...createKeywordMonthlyBundleAnalysis({ projectionDir: directory }), readPrepared: async () => ({}), analyze: async () => ({}) },
    runWork: () => assert.fail("metadata graph scheduler"), acquirePermit: () => assert.fail("metadata graph permit"), assertReadAdmission: async () => {} });
  const req = new EventEmitter(), res = new EventEmitter(); req.method = "GET"; req.headers = {}; res.setHeader = () => {}; res.writeHead = res.end = () => {};
  const handler = createKeywordMonthlyHttpHandler({ service, statusLifecycle: lifecycle, statusResponseBudget: budget, requireAdmin: () => true, send: () => assert.fail("late aborted response") });
  let pending;
  try {
    pending = handler(req, res, new URL("https://fixture.test/api/keyword-monthly/version"), {}); await readEntered.promise;
    res.destroyed = true; res.emit("close"); await pending;
    assert.equal(lifecycle.status().inFlight, 1); assert.equal(budget.status().reservedBytes, 2048);
    finishRead.resolve();if(stage==="read"){await closeEntered.promise; await turn(); assert.equal(budget.status().reservedBytes, 2048);}
    finishClose.resolve(); await until(() => lifecycle.status().inFlight === 0 && budget.status().reservedBytes === 0);
    assert.equal(lifecycle.status().inFlight, 0); assert.equal(budget.status().reservedBytes, 0);
    if(stage==="lstat")assert.equal(opens,0);
  } finally { finishRead.resolve(); finishClose.resolve(); await pending; await until(() => lifecycle.status().inFlight === 0); fs.open = originalOpen;fs.lstat=originalLstat; lifecycle.close(); }
});});

test("signal-only fixed filesystem observations preserve values and stay out of no-signal readers", async () => pointerFixture(async directory => {
  const diagnostics=createKeywordMonthlyRequestDiagnostics({onLog:null}),bundle=createKeywordMonthlyBundleAnalysis({projectionDir:directory});
  const signal=new AbortController().signal;
  const first=await diagnostics.run("version",()=>diagnostics.metadata(()=>bundle.version({signal}))());
  assert.equal(first.status,"available");const fields=diagnostics.status().recent[0].metadataFs;
  assert.deepEqual(Object.keys(fields).sort(),[...METADATA_FS_PHASES].sort());
  for(const value of Object.values(fields)){assert.ok(value.count>0);assert.ok(Number.isFinite(value.wallMs)&&value.wallMs>=0);}
  const second=await diagnostics.run("version",()=>diagnostics.metadata(()=>bundle.version())());
  assert.deepEqual(second,first);assert.deepEqual(diagnostics.status().recent[1].metadataFs,{});
  const unchanged=await withKeywordMonthlyMetadataMeasure((_phase,operation)=>operation(),()=>bundle.version({signal}),()=>{throw Error("private observer");});
  assert.deepEqual(unchanged,first);assert.ok(!JSON.stringify(diagnostics.status()).includes(directory));
}));

test("fixed filesystem history including late observations is bounded to 64KiB without new phase authority", async () => {
  const diagnostics=createKeywordMonthlyRequestDiagnostics({onLog:null,maxRecords:64});
  for(let index=0;index<80;index++)await diagnostics.run("version",()=>diagnostics.metadata(async()=>{
    const observe=captureKeywordMonthlyMetadataFsObserver();for(const phase of METADATA_FS_PHASES)for(let count=0;count<10;count++)observe(phase,12345.6);
    observe("private/path",1);return {status:"available"};
  })());
  const state=diagnostics.status();assert.ok(state.recent.length<64);assert.ok(Buffer.byteLength(JSON.stringify(state))<=64*1024);
  assert.ok(state.recent.every(row=>Object.keys(row.metadataFs).length===8));assert.ok(!JSON.stringify(state).includes("private/path"));
  await assert.rejects(diagnostics.measure("path_queue",()=>1),TypeError,"file spans cannot become public request phases");
});

test("diagnostics are bounded fixed scalar metadata and observer clocks cannot alter admission clocks", async () => {
  let calls = 0; const lifecycle = createKeywordMonthlyQueryLifecycle({ now: () => { calls++; return 10; } });
  assert.equal(await lifecycle.run("normal", () => 1, { metadataKind: "version" }), 1);
  const normalCalls = calls; calls = 0;
  const originalNow = Date.now;
  try {
    Date.now = () => { throw Error("private diagnostic clock"); };
    assert.equal(await lifecycle.run("safe", () => 1, { metadataKind: "version", ownerTraceId: "private/path" }), 1);
  } finally { Date.now = originalNow; }
  assert.equal(calls, normalCalls);
  for (let index = 0; index < 40; index++) await lifecycle.run(String(index), () => 1, { metadataKind: "catalogue" });
  const diagnostics = lifecycle.status().operationDiagnostics; assert.equal(diagnostics.recent.length, 32);
  assert.ok(!JSON.stringify(diagnostics).includes("private")); assert.ok(Buffer.byteLength(JSON.stringify(diagnostics)) < 64 * 1024);
  diagnostics.recent[0].kind = "changed"; assert.equal(lifecycle.status().operationDiagnostics.recent[0].kind, "catalogue");
  await assert.rejects(lifecycle.run("unsafe", () => 1, { metadataKind: "private/path" }), TypeError); lifecycle.close();
});
