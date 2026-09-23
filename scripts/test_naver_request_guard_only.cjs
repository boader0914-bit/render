"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { createNaverRequestGate, isNaverBookingRateLimit } = require("./naver_request_pacing.cjs");

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function createGuard(options) {
  return createNaverRequestGate({ enabled: true, pacingEnabled: false,
    // Previous speed settings must not quietly continue to throttle guard-only.
    minIntervalMs: 200, maxConcurrency: 2,
    sleep: async () => { throw new Error("guard-only must not sleep"); },
    ...options,
  });
}

test("guard-only starts more than two downloads immediately and preserves native responses", async () => {
  let time = 0;
  const pending = Array.from({ length: 5 }, deferred);
  const starts = [], calls = [], originals = [];
  const init = { method: "POST", headers: { "x-input": "fixture" }, body: "fixture" };
  const gate = createGuard({ now: () => time, fetchImpl: (input, receivedInit) => {
    starts.push(time);
    calls.push([input, receivedInit]);
    return pending[calls.length - 1].promise;
  } });
  const input = new Request("https://m.booking.naver.com/graphql");
  const results = Array.from({ length: 5 }, () => gate.fetch(input, init));
  assert.deepEqual(starts, [0, 0, 0, 0, 0]);
  assert.equal(gate.diagnostics().inFlight, 5);
  assert.equal(gate.diagnostics().queued, 0);
  for (let i = 0; i < pending.length; i++) {
    originals[i] = new Response(JSON.stringify({ index: i }), { status: 201, headers: { "x-fixture": "preserved" } });
    pending[i].resolve(originals[i]);
  }
  const responses = await Promise.all(results);
  for (let i = 0; i < responses.length; i++) {
    assert.strictEqual(calls[i][0], input);
    assert.strictEqual(calls[i][1], init);
    assert.strictEqual(responses[i], originals[i]);
    assert.equal(responses[i].bodyUsed, false);
    assert.equal(responses[i].status, 201);
    assert.equal(responses[i].headers.get("x-fixture"), "preserved");
    assert.deepEqual(await responses[i].json(), { index: i });
  }
  assert.deepEqual(gate.diagnostics(), {
    enabled: false, guardEnabled: true, pacingEnabled: false,
    minIntervalMs: 0, maxConcurrentRequests: null,
    requestCount: 5, failedRequests: 0, cancelledBeforeStart: 0,
    totalWaitMs: 0, maxInFlight: 5, minObservedStartIntervalMs: 0,
    queued: 0, inFlight: 0, stopped: false,
  });
});

test("403 and 429 stop future starts at headers while already sent requests may finish", async () => {
  for (const status of [403, 429]) {
    const headers = deferred(), blockedBody = deferred(), detected = deferred();
    const pending = Array.from({ length: 3 }, deferred);
    let calls = 0;
    const block = Object.assign(new Error("NAVER_REQUEST_BLOCKED"), { code: "NAVER_REQUEST_BLOCKED", statusCode: status });
    const gate = createGuard({ fetchImpl: () => ++calls === 1 ? headers.promise : pending[calls - 2].promise,
      onResponse: (response, { stop }) => {
        if ([403, 429].includes(response.status)) { stop(block); detected.resolve(); }
      },
    });
    const requests = Array.from({ length: 4 }, (_, i) => gate.fetch(`https://naver.com/${i}`));
    assert.equal(calls, 4);
    headers.resolve(new Response(new ReadableStream({ async start(controller) {
      await blockedBody.promise;
      controller.enqueue(new TextEncoder().encode("limited"));
      controller.close();
    } }), { status }));
    await detected.promise;
    await assert.rejects(gate.fetch("https://static.naver.net/future"), error => error === block);
    assert.equal(calls, 4);
    assert.equal(gate.diagnostics().stopped, true);
    pending.forEach((entry, i) => entry.resolve(new Response(`already sent ${i}`)));
    blockedBody.resolve();
    const responses = await Promise.all(requests);
    assert.equal(responses[0].status, status);
    assert.equal(await responses[0].text(), "limited");
    assert.deepEqual(await Promise.all(responses.slice(1).map(response => response.text())), ["already sent 0", "already sent 1", "already sent 2"]);
    assert.equal(gate.diagnostics().requestCount, 4);
    assert.equal(gate.diagnostics().cancelledBeforeStart, 1);
    assert.equal(gate.diagnostics().inFlight, 0);
  }
});

test("HTTP 200 BookingAPITooManyRequests guard remains active without consuming caller body", async () => {
  const first = deferred(), others = Array.from({ length: 2 }, deferred);
  let calls = 0;
  const block = new Error("NAVER_REQUEST_BLOCKED");
  const gate = createGuard({ fetchImpl: () => ++calls === 1 ? first.promise : others[calls - 2].promise,
    onResponse: async (response, { stop, readJson }) => {
      if (response.status === 200 && isNaverBookingRateLimit(await readJson())) stop(block);
    },
  });
  const pending = [0, 1, 2].map(i => gate.fetch(`https://m.booking.naver.com/graphql?i=${i}`));
  const body = JSON.stringify({ errors: [{ extensions: { code: "BookingAPITooManyRequests" } }] });
  first.resolve(new Response(body));
  const blocked = await pending[0];
  assert.equal(blocked.bodyUsed, false);
  assert.equal(await blocked.text(), body);
  await assert.rejects(gate.fetch("https://pcmap-api.place.naver.com/fallback"), error => error === block);
  assert.equal(calls, 3);
  others.forEach(entry => entry.resolve(new Response(JSON.stringify({ data: "already sent" }))));
  const responses = await Promise.all(pending.slice(1));
  for (const response of responses) assert.deepEqual(await response.json(), { data: "already sent" });
  assert.equal(gate.diagnostics().stopped, true);
  assert.equal(gate.diagnostics().failedRequests, 0);
  assert.equal(gate.diagnostics().totalWaitMs, 0);
});

test("non-Naver requests remain transparent even after guard stop; disabled mode never hooks", async () => {
  const response = new Response("untouched");
  const promise = Promise.resolve(response);
  let hooks = 0;
  const gate = createGuard({ fetchImpl: () => promise, onResponse: () => { hooks++; } });
  gate.stop("fixture stop");
  assert.strictEqual(gate.fetch("https://example.com/resource"), promise);
  const disabled = createNaverRequestGate({ enabled: false, pacingEnabled: false,
    fetchImpl: () => promise, onResponse: () => { hooks++; },
  });
  disabled.stop("ignored while disabled");
  assert.strictEqual(disabled.fetch("https://naver.com/resource"), promise);
  assert.equal(disabled.diagnostics().guardEnabled, false);
  assert.equal(disabled.diagnostics().enabled, false);
  assert.equal(disabled.diagnostics().pacingEnabled, false);
  assert.equal(disabled.diagnostics().requestCount, 0);
  assert.equal(response.bodyUsed, false);
  assert.equal(hooks, 0);
});

test("aborted Request or init signals never start, and fetch errors are not retried", async () => {
  const controller = new AbortController();
  controller.abort();
  const calls = [];
  const failure = new Error("fixture transport failure");
  const gate = createGuard({ fetchImpl: input => {
    calls.push(input);
    if (new URL(input).pathname === "/sync") throw failure;
    if (new URL(input).pathname === "/async") return Promise.reject(failure);
    return Promise.resolve(new Response("ok"));
  } });
  const request = new Request("https://naver.com/aborted-request", { signal: controller.signal });
  await assert.rejects(gate.fetch(request), { name: "AbortError" });
  await assert.rejects(gate.fetch("https://naver.com/aborted-init", { signal: controller.signal }), { name: "AbortError" });
  await assert.rejects(gate.fetch("https://naver.com/sync"), error => error === failure);
  await assert.rejects(gate.fetch("https://naver.com/async"), error => error === failure);
  assert.equal(await (await gate.fetch("https://naver.com/next")).text(), "ok");
  assert.deepEqual(calls, ["https://naver.com/sync", "https://naver.com/async", "https://naver.com/next"]);
  assert.equal(gate.diagnostics().requestCount, 3);
  assert.equal(gate.diagnostics().failedRequests, 2);
  assert.equal(gate.diagnostics().cancelledBeforeStart, 2);
  assert.equal(gate.diagnostics().inFlight, 0);
  assert.equal(gate.diagnostics().queued, 0);
});

test("in-flight abort reaches the underlying fetch and clears active accounting", async () => {
  const controller = new AbortController();
  const failure = new DOMException("fixture abort", "AbortError");
  let calls = 0;
  const gate = createGuard({ fetchImpl: (input, init) => {
    calls++;
    assert.strictEqual(init.signal, controller.signal);
    return new Promise((resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
    });
  } });
  const request = gate.fetch("https://naver.com/in-flight", { signal: controller.signal });
  const rejected = assert.rejects(request, error => error === failure);
  assert.equal(gate.diagnostics().inFlight, 1);
  controller.abort(failure);
  await rejected;
  assert.equal(calls, 1);
  assert.equal(gate.diagnostics().failedRequests, 1);
  assert.equal(gate.diagnostics().inFlight, 0);
  assert.equal(gate.diagnostics().stopped, false);
});

test("response-hook and body download errors release accounting without retrying", async () => {
  for (const mode of ["hook", "body"]) {
    let calls = 0;
    const failure = new Error(`fixture ${mode} failure`);
    const gate = createGuard({ fetchImpl: async () => {
      calls++;
      if (mode === "body" && calls === 1) return new Response(new ReadableStream({ start(controller) { controller.error(failure); } }));
      return new Response("ok");
    }, onResponse: () => { if (mode === "hook" && calls === 1) throw failure; } });
    await assert.rejects(gate.fetch("https://naver.com/first"), error => error === failure);
    assert.equal(await (await gate.fetch("https://naver.com/second")).text(), "ok");
    assert.equal(calls, 2);
    assert.equal(gate.diagnostics().failedRequests, 1);
    assert.equal(gate.diagnostics().inFlight, 0);
  }
});
