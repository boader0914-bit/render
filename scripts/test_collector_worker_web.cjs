"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { startWorkerWeb } = require("./collector_worker_web.cjs");

const enabledEnv = { COLLECTOR_WORKER_ENABLED: "1", COLLECTOR_SERVER_URL: "https://example.test",
  COLLECTOR_WORKER_TOKEN: "mock-only-no-network-token-123456789012345", COLLECTOR_WORKER_KEY: "scheduled" };
const base = runtime => `http://127.0.0.1:${runtime.server.address().port}`;

test("disarmed web worker is healthy and cannot accept work or reveal configuration", async () => {
  let runs = 0;
  const runtime = await startWorkerWeb({ env: {}, port: 0, host: "127.0.0.1", run: async () => { runs++; } });
  try {
    const response = await fetch(`${base(runtime)}/api/health`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, service: "collector-worker", state: "disarmed" });
    for (const route of ["/api/crawl", "/api/collector-worker/claim", "/outputs", "/api/env"]) {
      assert.equal((await fetch(`${base(runtime)}${route}`, { method: "POST" })).status, 404);
    }
    assert.equal(runs, 0);
  } finally { await runtime.close(); }
});

test("healthy polling shuts down gracefully through the worker abort signal", async () => {
  let stopped = false;
  const runtime = await startWorkerWeb({ env: enabledEnv, port: 0, host: "127.0.0.1", run: async options => {
    assert.equal(options.workerKey, "scheduled");
    await new Promise(resolve => options.signal.addEventListener("abort", resolve, { once: true }));
    stopped = true;
    return { stopped: true };
  } });
  assert.equal((await fetch(`${base(runtime)}/health`)).status, 200);
  await runtime.close();
  assert.equal(stopped, true);
});

test("acknowledged protection halt remains healthy without starting another worker loop", async () => {
  let runs = 0;
  const runtime = await startWorkerWeb({ env: enabledEnv, port: 0, host: "127.0.0.1",
    run: async () => { runs++; return { halted: true, code: "COLLECTOR_PROVIDER_BLOCKED" }; } });
  try {
    await new Promise(resolve => setImmediate(resolve));
    const response = await fetch(`${base(runtime)}/health`);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).state, "halted");
    assert.equal(runs, 1);
  } finally { await runtime.close(); }
});

test("unexpected worker-loop return or rejection cannot leave health green", async () => {
  for (const run of [async () => ({ jobs: 0 }), async () => { throw new Error("secret details"); }]) {
    const runtime = await startWorkerWeb({ env: enabledEnv, port: 0, host: "127.0.0.1", run });
    try {
      await assert.rejects(runtime.done, { code: "COLLECTOR_LOOP_STOPPED" });
      const response = await fetch(`${base(runtime)}/api/health`);
      assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), { ok: false, service: "collector-worker", state: "failed" });
    } finally { await runtime.close(); }
  }
});
