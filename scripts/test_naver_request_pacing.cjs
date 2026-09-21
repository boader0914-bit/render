"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { DEFAULT_MIN_INTERVAL_MS, isNaverRequest, createNaverRequestGate } = require("./naver_request_pacing.cjs");

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fakeClock(start = 0) {
  let time = start;
  const waits = [];
  return { now: () => time, sleep: async ms => { waits.push(ms); time += ms; }, advance: ms => { time += ms; }, waits };
}

test("only Naver hostname families are paced, including URL and Request inputs", () => {
  for (const url of ["https://naver.com", "https://m.booking.naver.com/graphql", "https://pcmap-api.place.naver.com/graphql", "https://static.naver.net/file", "https://NAVER.COM./path"]) assert.equal(isNaverRequest(url), true, url);
  assert.equal(isNaverRequest(new URL("https://m.booking.naver.com/graphql")), true);
  assert.equal(isNaverRequest(new Request("https://m.booking.naver.com/graphql")), true);
  for (const url of ["https://naver.com.evil.example", "https://notnaver.com", "https://naver.com@evil.example", "https://api.example.com/naver.com", "file://naver.com/file", "invalid"]) assert.equal(isNaverRequest(url), false, url);
});

test("concurrent callers start serially and at least 500ms apart without changing request or response", async () => {
  const clock = fakeClock();
  const starts = [];
  const inputs = [];
  const responses = [];
  const gate = createNaverRequestGate({ ...clock, fetchImpl: async (input, init) => {
    inputs.push([input, init]);
    starts.push(clock.now());
    clock.advance(80);
    const response = new Response(JSON.stringify({ index: starts.length }), { status: 201, headers: { "content-type": "application/json", "x-fixture": "preserved" } });
    responses.push(response);
    return response;
  } });
  const init = { method: "POST", body: "fixture-body" };
  const results = await Promise.all([0, 1, 2].map(index => gate.fetch(`https://m.booking.naver.com/graphql?i=${index}`, init)));
  assert.deepEqual(starts, [0, 500, 1000]);
  for (let index = 0; index < results.length; index++) {
    assert.strictEqual(inputs[index][1], init);
    assert.strictEqual(results[index], responses[index]);
    assert.equal(results[index].bodyUsed, false);
    assert.equal(results[index].status, 201);
    assert.equal(results[index].headers.get("x-fixture"), "preserved");
    assert.deepEqual(await results[index].json(), { index: index + 1 });
  }
  const metrics = gate.diagnostics();
  assert.equal(metrics.requestCount, 3);
  assert.equal(metrics.maxInFlight, 1);
  assert.equal(metrics.minIntervalMs, DEFAULT_MIN_INTERVAL_MS);
  assert.equal(metrics.minObservedStartIntervalMs, 500);
  assert.equal(metrics.totalWaitMs, 1340); // Queued at 0, 80 and 80; started at 0, 500 and 1000.
  assert.equal(metrics.inFlight, 0);
  assert.equal(metrics.queued, 0);
});

test("a slow response body keeps the Naver slot while other hosts remain unaffected", async () => {
  const body = deferred();
  const firstStarted = deferred();
  const starts = [];
  const gate = createNaverRequestGate({ minIntervalMs: 0, fetchImpl: async input => {
    starts.push(input);
    if (input.endsWith("first")) {
      firstStarted.resolve();
      return new Response(new ReadableStream({ async start(controller) { await body.promise; controller.enqueue(new TextEncoder().encode("complete")); controller.close(); } }));
    }
    return new Response("other");
  } });
  const first = gate.fetch("https://naver.com/first");
  const second = gate.fetch("https://naver.com/second");
  await firstStarted.promise;
  const external = await gate.fetch("https://example.com/unaffected");
  assert.deepEqual(starts, ["https://naver.com/first", "https://example.com/unaffected"]);
  assert.equal(await external.text(), "other");
  body.resolve();
  const [response1, response2] = await Promise.all([first, second]);
  assert.equal(await response1.text(), "complete");
  assert.equal(await response2.text(), "other");
  assert.equal(gate.diagnostics().maxInFlight, 1);
  assert.equal(gate.diagnostics().requestCount, 2);
});

test("long requests need no added wait and configured interval is used", async () => {
  const clock = fakeClock();
  const starts = [];
  const gate = createNaverRequestGate({ ...clock, minIntervalMs: 750, fetchImpl: async () => { starts.push(clock.now()); clock.advance(1000); return new Response(null, { status: 204 }); } });
  await Promise.all([gate.fetch("https://naver.com/a"), gate.fetch("https://naver.com/b")]);
  assert.deepEqual(starts, [0, 1000]);
  assert.deepEqual(clock.waits, []);
  assert.equal(gate.diagnostics().minObservedStartIntervalMs, 1000);
});

test("two concurrent downloads share one 200ms start interval and never open a third slot", async () => {
  const clock = fakeClock();
  const bodies = [deferred(), deferred(), deferred()];
  const began = [deferred(), deferred(), deferred()];
  const starts = [];
  const gate = createNaverRequestGate({ ...clock, minIntervalMs: 200, maxConcurrency: 2, fetchImpl: async () => {
    const index = starts.length;
    starts.push(clock.now());
    began[index].resolve();
    return new Response(new ReadableStream({ async start(controller) {
      await bodies[index].promise;
      controller.enqueue(new TextEncoder().encode(String(index)));
      controller.close();
    } }));
  } });
  const requests = [0, 1, 2].map(index => gate.fetch(`https://naver.com/${index}`));
  await began[1].promise;
  assert.deepEqual(starts, [0, 200]);
  assert.equal(gate.diagnostics().inFlight, 2);
  assert.equal(gate.diagnostics().queued, 1);
  bodies[0].resolve();
  await began[2].promise;
  assert.deepEqual(starts, [0, 200, 400]);
  bodies[1].resolve();
  bodies[2].resolve();
  const responses = await Promise.all(requests);
  assert.deepEqual(await Promise.all(responses.map(response => response.text())), ["0", "1", "2"]);
  assert.equal(gate.diagnostics().maxInFlight, 2);
  assert.equal(gate.diagnostics().maxConcurrentRequests, 2);
  assert.equal(gate.diagnostics().minObservedStartIntervalMs, 200);
});

test("a block hook stops pending calls after preserving the blocked response", async () => {
  let calls = 0;
  const block = Object.assign(new Error("NAVER_REQUEST_BLOCKED HTTP 429"), { statusCode: 429 });
  const gate = createNaverRequestGate({ minIntervalMs: 0,
    fetchImpl: async () => { calls++; return new Response("limited", { status: 429 }); },
    onResponse: (response, { stop }) => { if (response.status === 429) stop(block); },
  });
  const results = await Promise.allSettled([gate.fetch("https://naver.com/a"), gate.fetch("https://naver.com/b"), gate.fetch("https://naver.com/c")]);
  assert.equal(results[0].status, "fulfilled");
  assert.equal(results[0].value.status, 429);
  assert.equal(await results[0].value.text(), "limited");
  assert.equal(results[1].status, "rejected");
  assert.strictEqual(results[1].reason, block);
  assert.strictEqual(results[2].reason, block);
  assert.equal(calls, 1);
  assert.equal(gate.diagnostics().cancelledBeforeStart, 2);
  assert.equal(gate.diagnostics().stopped, true);
});

test("failed fetches do not retry and pending aborted requests never start", async () => {
  const clock = fakeClock();
  const controller = new AbortController();
  const calls = [];
  const gate = createNaverRequestGate({ ...clock, fetchImpl: async input => {
    calls.push(input);
    if (calls.length === 1) { controller.abort(); throw new Error("fixture network failure"); }
    return new Response("ok");
  } });
  const result = await Promise.allSettled([
    gate.fetch("https://naver.com/failed"),
    gate.fetch("https://naver.com/aborted", { signal: controller.signal }),
    gate.fetch("https://naver.com/next"),
  ]);
  assert.equal(result[0].status, "rejected");
  assert.equal(result[1].reason.name, "AbortError");
  assert.equal(result[2].status, "fulfilled");
  assert.deepEqual(calls, ["https://naver.com/failed", "https://naver.com/next"]);
  assert.equal(gate.diagnostics().failedRequests, 1);
  assert.equal(gate.diagnostics().cancelledBeforeStart, 1);
});

test("disabled pacing is a transparent passthrough and interval validation is explicit", async () => {
  const response = new Response("untouched");
  const promise = Promise.resolve(response);
  const gate = createNaverRequestGate({ enabled: false, fetchImpl: () => promise });
  assert.strictEqual(gate.fetch("https://naver.com"), promise);
  assert.equal(response.bodyUsed, false);
  assert.equal(gate.diagnostics().requestCount, 0);
  assert.equal(gate.diagnostics().enabled, false);
  for (const value of [-1, NaN, "no"]) assert.throws(() => createNaverRequestGate({ minIntervalMs: value }), /nonnegative/);
  for (const value of [0, 3, 1.5, "no"]) assert.throws(() => createNaverRequestGate({ maxConcurrency: value }), /1 or 2/);
});

function crawlerGate(env, fetchImpl) {
  const source = fs.readFileSync(path.join(__dirname, "gyeongnam_glamping_crawl.cjs"), "utf8");
  const start = source.indexOf("const SCHEDULED_COLLECTION =");
  const end = source.indexOf("const scheduledCollectionDiagnostics =", start);
  assert.ok(start >= 0 && end > start);
  return vm.runInNewContext(`${source.slice(start, end)}\n({ fetch, diagnostics: naverRequestGate.diagnostics, blockedStatus: () => naverRequestBlockedStatus })`, {
    process: { env }, fetch: fetchImpl, createNaverRequestGate,
  });
}

test("crawler opt-in requires both scheduled collection and pacing flags", async () => {
  for (const env of [
    {},
    { SCHEDULED_COLLECTION: "1" },
    { SCHEDULED_COLLECTION: "0", NAVER_REQUEST_PACING_ENABLED: "1", NAVER_REQUEST_MIN_INTERVAL_MS: "invalid" },
  ]) {
    const promise = Promise.resolve(new Response("unchanged"));
    const gate = crawlerGate(env, () => promise);
    assert.strictEqual(gate.fetch("https://naver.com"), promise);
    assert.equal(gate.diagnostics().enabled, false);
  }
  const gate = crawlerGate({ SCHEDULED_COLLECTION: "1", NAVER_REQUEST_PACING_ENABLED: "1", NAVER_REQUEST_MIN_INTERVAL_MS: "200", NAVER_REQUEST_MAX_CONCURRENCY: "2" }, async () => new Response("paced"));
  assert.equal(await (await gate.fetch("https://naver.com")).text(), "paced");
  assert.equal(gate.diagnostics().enabled, true);
  assert.equal(gate.diagnostics().minIntervalMs, 200);
  assert.equal(gate.diagnostics().maxConcurrentRequests, 2);
});

test("crawler gate catches 403 and 429 on every Naver host before a fallback can make another request", async () => {
  for (const status of [403, 429]) {
    let calls = 0;
    const gate = crawlerGate({ SCHEDULED_COLLECTION: "1", NAVER_REQUEST_PACING_ENABLED: "1", NAVER_REQUEST_MIN_INTERVAL_MS: "0", NAVER_REQUEST_MAX_CONCURRENCY: "1" }, async () => { calls++; return new Response("blocked fixture", { status }); });
    const response = await gate.fetch("https://pcmap-api.place.naver.com/graphql");
    assert.equal(response.status, status);
    assert.equal(await response.text(), "blocked fixture");
    assert.equal(gate.blockedStatus(), status);
    await assert.rejects(gate.fetch("https://m.place.naver.com/accommodation/fixture/home"), error => error.code === "NAVER_REQUEST_BLOCKED" && error.statusCode === status);
    assert.equal(calls, 1);
    assert.equal(gate.diagnostics().stopped, true);
  }
});
