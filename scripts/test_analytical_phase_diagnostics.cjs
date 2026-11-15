"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { AsyncResource } = require("node:async_hooks");
const { createAnalyticalPhaseDiagnostics } = require("./lib/analytical_phase_diagnostics.cjs");

const usage = (heapUsed = 100) => ({ heapUsed, heapTotal: 200, rss: 300, external: 40, arrayBuffers: 10 });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const turn = () => new Promise(resolve => setImmediate(resolve));
const fixture = options => createAnalyticalPhaseDiagnostics({ memoryUsage: usage, heapStatistics: () => ({ heap_size_limit: 1000 }), now: () => 10, ...options });

test("configuration has hard positive bounds for completed records, phases and active runs", () => {
  const defaults = fixture().status();
  assert.deepEqual(defaults.limits, { maxRecords: 64, maxPhases: 32, maxActive: 64 });
  for (const value of [0, -1, 1.5, 65, Infinity, NaN, "2", null]) {
    assert.throws(() => fixture({ maxRecords: value }), RangeError);
  }
  for (const value of [0, -1, 1.5, 33, Infinity, NaN, "2", null]) {
    assert.throws(() => fixture({ maxPhases: value }), RangeError);
  }
  assert.deepEqual(fixture({ maxRecords: 1, maxPhases: 1 }).status().limits, { maxRecords: 1, maxPhases: 1, maxActive: 1 });
});

test("sync measurements preserve identity and emit a memory checkpoint before allocation", async () => {
  let heapUsed = 100, at = 1;
  const events = [], result = { secretPayload: "must-not-be-serialized" }, metadata = { inputBytes: 45, rowCount: 0 };
  const diagnostics = fixture({ now: () => at, memoryUsage: () => usage(heapUsed), onRecord: event => events.push(event) });
  const returned = await diagnostics.run("keyword_monthly", () => diagnostics.measure("partition_parse", metadata, () => {
    assert.equal(events.at(-1).event, "phase_start");
    assert.equal(events.at(-1).memory.heapUsed, 100);
    heapUsed = 180; at = 11; metadata.rowCount = 4;
    return result;
  }));
  assert.strictEqual(returned, result);
  const state = diagnostics.status(), record = state.records[0], phase = record.phases[0];
  assert.deepEqual(events.map(event => event.event), ["run_start", "phase_start", "phase_end", "run_end"]);
  assert.equal(record.elapsedMs, 10); assert.equal(phase.elapsedMs, 10);
  assert.equal(record.before.heapUsed, 100); assert.equal(record.after.heapUsed, 180); assert.equal(record.peak.heapUsed, 180);
  assert.equal(phase.before.heapUsed, 100); assert.equal(phase.after.heapUsed, 180); assert.equal(phase.peak.heapUsed, 180);
  assert.equal(record.peak.external, 40); assert.equal(record.peak.arrayBuffers, 10);
  assert.equal(record.peak.heapSizeLimit, 1000);
  assert.deepEqual(phase.metadata, { inputBytes: 45, rowCount: 4 });
  assert.equal(state.active.length, 0);
  assert.ok(!JSON.stringify({ state, events }).includes("must-not-be-serialized"));
  assert.match(state.interpretation, /already included in external/);
});

test("async interleaving keeps each phase attached to its own outer run", async () => {
  const first = deferred(), second = deferred(), events = [];
  const diagnostics = fixture({ onRecord: event => events.push(event) });
  const a = diagnostics.run("company_read", async () => {
    return diagnostics.measure("company_parse", { rowCount: 1 }, async () => { await first.promise; return "first"; });
  });
  const b = diagnostics.run("keyword_monthly", async () => {
    return diagnostics.measure("keyword_parse", { rowCount: 2 }, async () => { await second.promise; return "second"; });
  });
  assert.equal(diagnostics.status().active.length, 2);
  second.resolve(); assert.equal(await b, "second");
  first.resolve(); assert.equal(await a, "first");
  const records = diagnostics.status().records;
  assert.deepEqual(records.map(record => [record.kind, record.phases[0].phase, record.phases[0].metadata.rowCount]),
    [["keyword_monthly", "keyword_parse", 2], ["company_read", "company_parse", 1]]);
  for (const record of records) assert.ok(events.filter(event => event.id === record.id).every(event => event.kind === record.kind));
});

test("sync and async operation errors preserve the exact original error without logging it", async () => {
  const diagnostics = fixture();
  const syncError = new Error("COOKIE_PRIVATE_VALUE"), asyncError = new Error("TOKEN_PRIVATE_VALUE");
  Object.defineProperty(syncError, "code", { get() { throw new Error("never inspect operation errors"); } });
  let original;
  try {
    await diagnostics.run("company_read", () => diagnostics.measure("parse", {}, () => { throw syncError; }));
  } catch (error) { original = error; }
  assert.strictEqual(original, syncError);
  await assert.rejects(diagnostics.run("keyword_monthly", () => diagnostics.measure("decompress", {}, async () => { throw asyncError; })), error => error === asyncError);
  const state = diagnostics.status();
  assert.equal(state.counters.failed, 2);
  assert.ok(state.records.every(record => record.errorCode === "ANALYTICAL_OPERATION_FAILED"));
  assert.ok(state.records.every(record => record.phases[0].errorCode === "ANALYTICAL_PHASE_FAILED"));
  assert.ok(!JSON.stringify(state).includes("PRIVATE_VALUE"));
});

test("sampling, clock and observer exceptions never replace successful values or errors", async () => {
  const diagnostics = fixture({ memoryUsage: () => { throw new Error("memory failed"); }, heapStatistics: () => { throw new Error("statistics failed"); },
    now: () => { throw new Error("clock failed"); }, onRecord: () => { throw new Error("logger failed"); } });
  assert.equal(await diagnostics.run("read", () => diagnostics.measure("parse", {}, () => 42)), 42);
  const original = new Error("business error");
  await assert.rejects(diagnostics.run("read", () => diagnostics.measure("parse", {}, async () => { throw original; })), error => error === original);
  const state = diagnostics.status();
  assert.equal(state.counters.completed, 1); assert.equal(state.counters.failed, 1);
  assert.equal(state.counters.observerErrors, 8);
  assert.ok(state.counters.samplingErrors > 0);
  assert.ok(Object.values(state.records[0].before).every(value => value === null));
  assert.equal(state.records[0].elapsedMs, null);
});

test("async observer rejections are consumed and mutation cannot change stored records", async () => {
  const events = [];
  const diagnostics = fixture({ onRecord: event => {
    events.push(event.event);
    event.memory.heapUsed = 9999;
    event.metadata.token = "OBSERVER_SECRET";
    return Promise.reject(new Error("unavailable log sink"));
  } });
  assert.equal(await diagnostics.run("read", () => diagnostics.measure("parse", { rowCount: 2 }, () => true)), true);
  await turn();
  const state = diagnostics.status();
  assert.deepEqual(events, ["run_start", "phase_start", "phase_end", "run_end"]);
  assert.equal(state.counters.observerErrors, 4);
  assert.equal(state.records[0].before.heapUsed, 100);
  assert.deepEqual(state.records[0].phases[0].metadata, { rowCount: 2 });
  assert.ok(!JSON.stringify(state).includes("OBSERVER_SECRET"));
  state.records[0].kind = "changed"; state.records[0].phases[0].metadata.rowCount = 99;
  assert.equal(diagnostics.status().records[0].kind, "read");
  assert.equal(diagnostics.status().records[0].phases[0].metadata.rowCount, 2);
});

test("only explicitly allowed numeric metadata and bounded internal identifiers are retained", async () => {
  const events = [], metadata = { inputBytes: 1, outputBytes: 2, uncompressedBytes: 3, rowCount: 4,
    partitionCount: 5, cacheHits: 6, readCount: 7, token: "METADATA_SECRET", cookie: "COOKIE_SECRET", path: "/private/path",
    payload: { email: "PRIVATE_EMAIL" } };
  Object.defineProperty(metadata, "dangerous", { get() { throw new Error("must never be read"); } });
  const diagnostics = fixture({ onRecord: event => events.push(event) });
  await diagnostics.run("https://host/SECRET_KIND", () => diagnostics.measure("SECRET_PHASE_COOKIE=value", metadata, () => 0));
  await diagnostics.run("x".repeat(81), () => diagnostics.measure("parse", { inputBytes: "100", outputBytes: -1, uncompressedBytes: Infinity,
    rowCount: 1.5, cacheHits: NaN, readCount: Number.MAX_SAFE_INTEGER + 1 }, () => null));
  const state = diagnostics.status();
  assert.equal(state.records[0].kind, "invalid_kind"); assert.equal(state.records[0].phases[0].phase, "invalid_phase");
  assert.deepEqual(state.records[0].phases[0].metadata, { inputBytes: 1, outputBytes: 2, uncompressedBytes: 3, rowCount: 4, partitionCount: 5, cacheHits: 6, readCount: 7 });
  assert.deepEqual(state.records[1].phases[0].metadata, {});
  assert.equal(state.counters.invalidIdentifiers, 3);
  assert.ok(!/SECRET|PRIVATE|private/.test(JSON.stringify({ state, events })));
});

test("throwing metadata getters are ignored without skipping the operation", async () => {
  const metadata = {};
  Object.defineProperty(metadata, "rowCount", { get() { throw new Error("bad metadata"); } });
  const diagnostics = fixture();
  assert.equal(await diagnostics.run("read", () => diagnostics.measure("parse", metadata, () => "value")), "value");
  assert.deepEqual(diagnostics.status().records[0].phases[0].metadata, {});
});

test("completed record and phase arrays remain bounded without skipping original work", async () => {
  const diagnostics = fixture({ maxRecords: 2, maxPhases: 2 });
  let calls = 0;
  for (let run = 0; run < 5; run++) {
    await diagnostics.run("read", () => {
      for (let phase = 0; phase < 5; phase++) assert.equal(diagnostics.measure("parse", { rowCount: phase }, () => ++calls), run * 5 + phase + 1);
    });
  }
  const state = diagnostics.status();
  assert.equal(calls, 25); assert.equal(state.records.length, 2);
  assert.deepEqual(state.records.map(record => record.id), [4, 5]);
  assert.ok(state.records.every(record => record.phases.length === 2 && record.droppedPhaseCount === 3));
  assert.equal(state.counters.droppedPhases, 15);
});

test("overflow phases retain no phase rows but still capture later memory peaks and checkpoints", async () => {
  let heapUsed = 100;
  const events = [], diagnostics = fixture({ maxPhases: 1, memoryUsage: () => usage(heapUsed), onRecord: event => events.push(event) });
  assert.equal(await diagnostics.run("long_read", () => {
    diagnostics.measure("first_partition", {}, () => 1);
    const value = diagnostics.measure("late_partition", { inputBytes: 200, token: "PRIVATE_METADATA" }, () => { heapUsed = 900; return 2; });
    heapUsed = 100;
    return value;
  }), 2);
  const record = diagnostics.status().records[0];
  assert.equal(record.phases.length, 1); assert.equal(record.droppedPhaseCount, 1);
  assert.equal(record.phases[0].phase, "first_partition");
  assert.equal(record.after.heapUsed, 100); assert.equal(record.peak.heapUsed, 900);
  assert.equal(record.sampleCount, 6);
  const overflow = events.filter(event => event.phase === "late_partition");
  assert.deepEqual(overflow.map(event => event.event), ["phase_start", "phase_end"]);
  assert.ok(overflow.every(event => event.retained === false));
  assert.deepEqual(overflow[0].metadata, { inputBytes: 200 });
  assert.equal(overflow[0].memory.heapUsed, 100); assert.equal(overflow[1].memory.heapUsed, 900);
  assert.ok(!JSON.stringify({ record, overflow }).includes("PRIVATE_METADATA"));
});

test("overflow async and synchronous errors preserve their original identities and safe events", async () => {
  const events = [], diagnostics = fixture({ maxPhases: 1, onRecord: event => events.push(event) });
  const syncError = new Error("PRIVATE_SYNC"), asyncError = new Error("PRIVATE_ASYNC");
  await assert.rejects(diagnostics.run("sync_read", () => {
    diagnostics.measure("first", {}, () => 1);
    return diagnostics.measure("later", {}, () => { throw syncError; });
  }), error => error === syncError);
  await assert.rejects(diagnostics.run("async_read", async () => {
    diagnostics.measure("first", {}, () => 1);
    return diagnostics.measure("later", {}, async () => { throw asyncError; });
  }), error => error === asyncError);
  const endings = events.filter(event => event.event === "phase_end" && event.retained === false);
  assert.equal(endings.length, 2);
  assert.ok(endings.every(event => event.status === "failed" && event.errorCode === "ANALYTICAL_PHASE_FAILED"));
  assert.ok(diagnostics.status().records.every(record => record.phases.length === 1 && record.droppedPhaseCount === 1));
  assert.ok(!JSON.stringify({ state: diagnostics.status(), events }).includes("PRIVATE_"));
});

test("an unawaited overflow phase cannot mutate completed records or emit late checkpoints", async () => {
  const events = [], gate = deferred(), diagnostics = fixture({ maxPhases: 1, onRecord: event => events.push(event) });
  let late;
  await diagnostics.run("read", () => {
    diagnostics.measure("first", {}, () => 1);
    late = diagnostics.measure("later", {}, async () => { await gate.promise; return 2; });
  });
  const before = diagnostics.status(), eventCount = events.length;
  gate.resolve(); assert.equal(await late, 2);
  assert.deepEqual(diagnostics.status(), before);
  assert.equal(events.length, eventCount);
});

test("active run tracking has the same hard bound and overflow still executes independently", async () => {
  const gate = deferred(), diagnostics = fixture({ maxRecords: 1 });
  const first = diagnostics.run("first", async () => { await gate.promise; return 1; });
  assert.equal(diagnostics.status().active.length, 1);
  assert.equal(await diagnostics.run("second", () => diagnostics.measure("parse", {}, () => 2)), 2);
  const pendingState = diagnostics.status();
  assert.equal(pendingState.active.length, 1); assert.equal(pendingState.records.length, 0);
  assert.equal(pendingState.counters.droppedRecords, 1);
  gate.resolve(); assert.equal(await first, 1);
  const state = diagnostics.status();
  assert.equal(state.counters.started, 2); assert.equal(state.counters.completed, 2);
  assert.equal(state.records.length, 1); assert.equal(state.records[0].kind, "first");
});

test("nested run uses the original context and never logs its inner label", async () => {
  const events = [], diagnostics = fixture({ onRecord: event => events.push(event) });
  const result = await diagnostics.run("root_read", async () => diagnostics.run("PRIVATE_RAW_CUSTOMER_LABEL", async () => {
    return diagnostics.measure("parse", { rowCount: 1 }, async () => "kept");
  }));
  assert.equal(result, "kept");
  await diagnostics.run("next_read", () => diagnostics.measure("read", {}, () => 1));
  const state = diagnostics.status(), first = state.records[0];
  assert.equal(state.records.length, 2); assert.equal(state.counters.nestedRuns, 1);
  assert.deepEqual(first.phases.map(phase => phase.phase), ["nested_run", "parse"]);
  assert.ok(events.filter(event => event.id === first.id).every(event => event.kind === "root_read"));
  assert.equal(state.records[1].kind, "next_read");
  assert.ok(!JSON.stringify({ state, events }).includes("PRIVATE_RAW_CUSTOMER_LABEL"));
});

test("detached queued work inheriting a completed context starts a new root record", async () => {
  const diagnostics = fixture();
  let followup;
  assert.equal(await diagnostics.run("initial", () => {
    followup = AsyncResource.bind(() => diagnostics.run("queued_next", () => diagnostics.measure("read", { readCount: 1 }, () => 2)));
    return 1;
  }), 1);
  assert.equal(await followup(), 2);
  const state = diagnostics.status();
  assert.deepEqual(state.records.map(record => [record.id, record.kind]), [[1, "initial"], [2, "queued_next"]]);
  assert.deepEqual(state.records[1].phases.map(phase => phase.phase), ["read"]);
  assert.equal(state.counters.nestedRuns, 0);
});

test("detached work inheriting an untracked context can acquire its own record later", async () => {
  const gate = deferred(), diagnostics = fixture({ maxRecords: 1 });
  let followup;
  const first = diagnostics.run("busy", async () => { await gate.promise; });
  await diagnostics.run("untracked", () => {
    followup = AsyncResource.bind(() => diagnostics.run("queued_next", () => diagnostics.measure("read", {}, () => 3)));
  });
  assert.equal(diagnostics.status().counters.droppedRecords, 1);
  gate.resolve(); await first;
  assert.equal(await followup(), 3);
  const state = diagnostics.status();
  assert.equal(state.records.length, 1);
  assert.equal(state.records[0].kind, "queued_next");
  assert.equal(state.records[0].phases[0].phase, "read");
  assert.equal(state.counters.nestedRuns, 0);
});

test("bounded scheduler kind and phase codes retain their internal classification", async () => {
  const diagnostics = fixture();
  await diagnostics.run("keyword_monthly:DB-Read_V2", () => diagnostics.measure("partition:Read_V2", {}, () => 1));
  const record = diagnostics.status().records[0];
  assert.equal(record.kind, "keyword_monthly:DB-Read_V2");
  assert.equal(record.phases[0].phase, "partition:Read_V2");
  assert.equal(diagnostics.status().counters.invalidIdentifiers, 0);
});

test("outside a run measure preserves synchronous values, thrown errors and opaque thenables", async () => {
  const diagnostics = fixture(), original = new Error("original");
  const value = {};
  Object.defineProperty(value, "then", { get() { throw new Error("must not inspect"); } });
  assert.strictEqual(diagnostics.measure("parse", {}, () => value), value);
  assert.throws(() => diagnostics.measure("parse", {}, () => { throw original; }), error => error === original);
  await diagnostics.run("read", () => {
    assert.strictEqual(diagnostics.measure("parse", {}, () => value), value);
  });
  assert.equal(diagnostics.status().counters.started, 1);
});

test("phase promises left unawaited cannot mutate a completed record later", async () => {
  const gate = deferred(), diagnostics = fixture();
  let late;
  assert.equal(await diagnostics.run("read", () => {
    late = diagnostics.measure("parse", {}, async () => { await gate.promise; return "later"; });
    return "now";
  }), "now");
  const before = diagnostics.status();
  assert.equal(before.records[0].phases[0].status, "unsettled");
  assert.equal(before.records[0].phases[0].errorCode, "ANALYTICAL_PHASE_NOT_SETTLED");
  gate.resolve(); assert.equal(await late, "later");
  assert.deepEqual(diagnostics.status(), before);
});

test("nested checkpoint samples contribute to observed parent peaks and invalid memory stays unknown", async () => {
  let heapUsed = 100;
  const diagnostics = fixture({ memoryUsage: () => ({ ...usage(heapUsed), rss: "secret", external: -1, arrayBuffers: NaN }),
    heapStatistics: () => ({ heap_size_limit: 0 }) });
  await diagnostics.run("read", () => diagnostics.measure("parse", {}, () => {
    heapUsed = 500;
    diagnostics.measure("serialize", {}, () => { heapUsed = 200; });
    heapUsed = 100;
  }));
  const record = diagnostics.status().records[0];
  assert.equal(record.before.rss, null); assert.equal(record.before.external, null);
  assert.equal(record.before.arrayBuffers, null); assert.equal(record.before.heapSizeLimit, null);
  assert.equal(record.after.heapUsed, 100); assert.equal(record.peak.heapUsed, 500);
  assert.equal(record.phases[0].peak.heapUsed, 500);
  assert.equal(record.phases[1].before.heapUsed, 500);
});

test("a rejected async root without measured phases preserves its rejection and safe completion", async () => {
  const events = [], diagnostics = fixture({ onRecord: event => events.push(event) }), original = Object.freeze({ sensitive: "PRIVATE_REASON" });
  await assert.rejects(diagnostics.run("read", async () => { throw original; }), error => error === original);
  assert.deepEqual(events.map(event => event.event), ["run_start", "run_end"]);
  assert.equal(events[1].status, "failed"); assert.equal(events[1].errorCode, "ANALYTICAL_OPERATION_FAILED");
  assert.ok(!JSON.stringify(diagnostics.status()).includes("PRIVATE_REASON"));
});
