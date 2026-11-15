"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { createAnalyticalPhaseRuntime } = require("./lib/analytical_phase_runtime.cjs");
const memoryUsage = () => ({ heapUsed: 4, heapTotal: 10, rss: 12, external: 3, arrayBuffers: 2 });
const heapStatistics = () => ({ heap_size_limit: 20 });

test("logging is bounded, resets per window and does not alter values", async () => {
  let at = 1000; const events = [];
  const runtime = createAnalyticalPhaseRuntime({ now: () => at, memoryUsage, heapStatistics,
    maxEventsPerWindow: 2, windowMs: 1000, onLog: event => events.push(event) });
  const value = { preserved: true };
  assert.equal(await runtime.run("keyword_monthly_options", () => runtime.measure("keyword_index_read", { inputBytes: 42, password: "not recorded" }, () => value)), value);
  assert.equal(events.length, 2); assert.ok(runtime.status().logging.dropped > 0);
  assert.ok(!JSON.stringify(runtime.status()).includes("not recorded"));
  at += 1000; await runtime.run("keyword_monthly_options", () => 1);
  assert.equal(events.length, 4);
});

test("throwing and rejecting log sinks cannot change work or leak errors", async () => {
  for (const onLog of [() => { throw Error("secret log target"); }, () => Promise.reject(Error("secret log target"))]) {
    const runtime = createAnalyticalPhaseRuntime({ memoryUsage, heapStatistics, onLog });
    assert.equal(await runtime.run("safe_kind", () => 123), 123);
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(runtime.status().logging.errors > 0);
    assert.ok(!JSON.stringify(runtime.status()).includes("secret log target"));
  }
});

test("numeric diagnostics survive with logging disabled and invalid budgets reject", async () => {
  const runtime = createAnalyticalPhaseRuntime({ memoryUsage, heapStatistics, onLog: null });
  await runtime.run("safe_kind", () => 1);
  assert.equal(runtime.status().logging.emitted, 0);
  for (const maxEventsPerWindow of [0, 121, Infinity]) assert.throws(() => createAnalyticalPhaseRuntime({ maxEventsPerWindow }), TypeError);
});
