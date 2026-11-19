"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), { EventEmitter } = require("node:events");
const { createIndustryReadDiagnostics } = require("./lib/industry_read_diagnostics.cjs");
const { createIndustryAnalysisHttpHandler } = require("./lib/industry_analysis_http.cjs");
function fixture(options = {}) {
  let at = 0; const logs = [], diagnostics = createIndustryReadDiagnostics({ now: () => at, wallNow: () => 100000 + at,
    onLog: value => logs.push(value), ...options });
  return { diagnostics, logs, advance(ms) { at += ms; }, set(value) { at = value; } };
}
function response() { const res = new EventEmitter(); res.headers = {}; res.setHeader = (name, value) => { res.headers[name] = value; };
  res.writeHead = () => {}; res.end = () => {}; return res; }

test("read/admission/serialization/handler and socket completion are measured separately without invented queue waits", async () => {
  const f = fixture(), res = response(), trace = f.diagnostics.begin("saved", res);
  assert.match(res.headers["X-Industry-Read-Trace"], /^[a-f0-9]{24}$/);
  await trace.admission(async work => { f.advance(3); return work(); }, () => trace.measure("read_validation", async () => { f.advance(7); return 0; }));
  assert.equal(trace.measureSync("serialize", () => { f.advance(2); return "encoded"; }), "encoded");
  trace.sent(200); trace.send(() => f.advance(1)); trace.finishHandler();
  let record = f.logs.at(-1); assert.equal(record.handlerTotalMs, 13); assert.equal(record.readValidationMs, 7); assert.equal(record.admissionMs, 3);
  assert.equal(record.preReadMs, 3); assert.equal(record.serializeMs, 2); assert.equal(record.sendCallMs, 1); assert.equal(record.sendInvokedAtMs, 12);
  assert.equal(res.headers["Server-Timing"], "admission;dur=3, read_validation;dur=7, serialize;dur=2, pre_read;dur=3, handler_to_send;dur=12");
  assert.equal(record.queueWaitMs, null); assert.equal(record.preHandlerWaitMs, null); assert.equal(record.socketElapsedMs, null);
  assert.equal(record.socketOutcome, "pending"); f.advance(40); res.emit("finish"); record = f.logs.at(-1);
  assert.equal(record.event, "response_finish"); assert.equal(record.socketElapsedMs, 53); assert.equal(record.handlerTotalMs, 13);
  assert.equal(res.listenerCount("finish"), 0); assert.equal(res.listenerCount("close"), 0); res.emit("close"); assert.equal(f.logs.length, 2);
});

test("socket close before read settlement is recorded honestly and cannot cancel, replace or duplicate the read", async () => {
  const f = fixture(), res = response(), trace = f.diagnostics.begin("catalogue", res); let settle;
  const value = { status: "not-a-log-field", secret: "do-not-log" }, operation = trace.measure("read_validation", () => new Promise(resolve => { settle = resolve; }));
  f.advance(5); res.emit("close"); assert.equal(f.logs[0].readOutcome, "not_observed"); assert.equal(f.logs[0].handlerFinished, false);
  f.advance(30); settle(value); assert.equal(await operation, value); trace.finishHandler();
  const final = f.logs.at(-1); assert.equal(final.readOutcome, "completed"); assert.equal(final.readValidationMs, 35);
  assert.equal(final.socketOutcome, "close"); assert.equal(final.socketElapsedMs, 5); assert.equal(final.responseStatus, null);
  assert.doesNotMatch(JSON.stringify(f.logs), /do-not-log|not-a-log-field/);
});

test("observation failures and invalid clocks preserve values and even false-like rejections", async () => {
  const f = fixture({ onLog() { throw Error("private failure"); } }), trace = f.diagnostics.begin("options", { setHeader() { throw Error("private header"); } });
  const value = { untouched: true }; assert.equal(await trace.measure("read_validation", async () => value), value);
  for (const reason of [false, null, undefined, 0]) await trace.measure("read_validation", () => Promise.reject(reason)).then(() => assert.fail("rejection changed"), error => assert.equal(error, reason));
  f.set(NaN); trace.sent(503); trace.finishHandler(); const record = f.diagnostics.status().records.at(-1);
  assert.equal(record.handlerTotalMs, null); assert.equal(record.sendInvokedAtMs, null); assert.ok(f.diagnostics.status().observerErrors > 0);
  const unavailable = createIndustryReadDiagnostics({ now() { throw Error("clock"); }, wallNow() { throw Error("wall"); }, onLog: null });
  const bad = unavailable.begin("catalogue", {}); assert.equal(bad.measureSync("serialize", () => 17), 17); bad.finishHandler();
  assert.equal(unavailable.status().records[0].handlerTotalMs, null);
});

test("only fixed routes and scalar numeric fields are retained and records/log emissions remain bounded", async () => {
  const f = fixture({ maxRecords: 2, maxEventsPerWindow: 2 });
  for (let i = 0; i < 10; i++) { const trace = f.diagnostics.begin("saved", {}); await trace.measure("read_validation", async () => ({ payload: "/secret?token=private" })); trace.sent(200); trace.finishHandler(); }
  const unknown = f.diagnostics.begin("/api/industry-analysis/private-path?password=secret", {}); assert.equal(await unknown.measure("ignored", async () => 5), 5); unknown.finishHandler();
  const state = f.diagnostics.status(); assert.equal(state.records.length, 2); assert.equal(f.logs.length, 2); assert.equal(state.dropped, 8);
  assert.doesNotMatch(JSON.stringify(state), /password|token|secret|payload|private-path/);
  for (const record of state.records) assert.deepEqual(Object.keys(record).sort(), ["event", "traceId", "processId", "route", "startedAtUnixMs", "queueWaitMs", "preHandlerWaitMs", "preReadMs", "admissionMs", "readValidationMs", "readOutcome", "serializeMs", "sendCallMs", "sendInvokedAtMs", "responseStatus", "errorCode", "responseErrorCode", "readGuard", "handlerTotalMs", "handlerFinished", "socketOutcome", "socketElapsedMs"].sort());
});

test("HTTP tracing preserves service/admission/budget call order and safe responses for all three routes", async () => {
  const f = fixture(), calls = [], payload = { public: "same response" };
  const handler = createIndustryAnalysisHttpHandler({ service: { catalogue: async () => { calls.push("catalogue"); f.advance(7); return payload; },
    saved: async () => { calls.push("saved"); f.advance(7); return payload; }, options: async () => { calls.push("options"); f.advance(7); return payload; } },
    requireAdmin: session => session?.admin, parseJsonBody: () => assert.fail("no body"), readDiagnostics: f.diagnostics,
    savedResponseBudget: { run: async (res, work) => { calls.push("budget"); return work({ nativeResponse: false, maxResponseBytes: 2 * 1024 * 1024 }); } },
    runMemoryAdmission: async work => { calls.push("memory"); f.advance(1); return work(); },
    send(res, status, value) { calls.push("send"); res.status = status; res.value = value; } });
  for (const route of ["catalogue", "saved", "options"]) {
    calls.length = 0; const res = {}, req = { method: "GET", headers: { Cookie: "private-cookie" } }, url = new URL(`https://local/api/industry-analysis/${route}`);
    await handler(req, res, url, { admin: true, username: "private-user", password: "private-password" });
    assert.equal(res.status, 200); assert.equal(res.value, payload);
    assert.deepEqual(calls, route === "options" ? ["options", "send"] : ["budget", "memory", route, "memory", "send"]);
    const record = f.logs.at(-1); assert.equal(record.route, route); assert.equal(record.readValidationMs, 7); assert.equal(record.responseStatus, 200);
    if (route === "options") { assert.equal(record.serializeMs, null); assert.equal(record.admissionMs, null); } else assert.ok(record.serializeMs !== null);
  }
  const count = f.logs.length; await handler({ method: "GET", headers: {} }, {}, new URL("https://local/api/industry-analysis/options"), { admin: false });
  assert.equal(f.logs.length, count); assert.doesNotMatch(JSON.stringify(f.logs), /private-cookie|private-user|private-password|same response/);
});

test("native HTTP handler timing includes its original socket budget wait and records close separately", async () => {
  const f = fixture(), res = response(); let calls = 0;
  const handler = createIndustryAnalysisHttpHandler({ service: { saved: async () => { calls++; return { ready: true }; } }, requireAdmin: () => true,
    readDiagnostics: f.diagnostics, runMemoryAdmission: async work => work(), send(target, status, value) { target.status = status; target.value = value; } });
  const pending = handler({ method: "GET", headers: {} }, res, new URL("https://local/api/industry-analysis/saved?month=2026-11"), {});
  await new Promise(resolve => setImmediate(resolve)); assert.equal(calls, 1); assert.ok(Buffer.isBuffer(res.value)); assert.equal(f.logs.length, 0);
  f.advance(123); res.emit("close"); await pending;
  const terminal = f.logs.find(row => row.event === "response_close"), handlerEnd = f.logs.find(row => row.event === "handler_end");
  assert.equal(terminal.socketElapsedMs, 123); assert.equal(terminal.handlerTotalMs, null);
  assert.equal(handlerEnd.handlerTotalMs, 123); assert.equal(handlerEnd.serializeMs, 0); assert.equal(handlerEnd.socketOutcome, "close");
});

test("failure projection retains only fixed codes/guard vocabulary and cannot invoke code or readGuard getters", async () => {
  const f = fixture(), res = response(), trace = f.diagnostics.begin("saved", res); let getterReads = 0;
  const hostile = { get code() { getterReads++; throw Error("private code"); }, get readGuard() { getterReads++; throw Error("private guard"); } };
  trace.failure(hostile, "INDUSTRY_ANALYSIS_UNAVAILABLE"); assert.equal(getterReads, 0);
  trace.failure({ code: "KEYWORD_MONTHLY_MEMORY_DEFERRED", message: "private keyword and path", readGuard: {
    component: "memory", reason: "high_watermark", observedAt: 100000,
    memory: { ratio: .7, paused: true, lowSamples: 0, heapRatio: .7, token: "private-token" }, path: "/private" } }, "INDUSTRY_ANALYSIS_UNAVAILABLE");
  trace.sent(503); trace.finishHandler(); const record = f.logs.at(-1);
  assert.equal(record.errorCode, "KEYWORD_MONTHLY_MEMORY_DEFERRED"); assert.equal(record.responseErrorCode, "INDUSTRY_ANALYSIS_UNAVAILABLE");
  assert.equal(record.readGuard.reason, "high_watermark"); assert.equal(record.readGuard.memory.heapRatio, .7);
  assert.doesNotMatch(JSON.stringify(record), /private|token|path|keyword/);
});

test("HTTP guard observation occurs after response capture and cannot change its status or body", async () => {
  const f = fixture(), error = { statusCode: 503, code: "INDUSTRY_SAVED_READ_BUSY" };
  Object.defineProperty(error, "readGuard", { get() { error.statusCode = 400; error.code = "INDUSTRY_MUTATED"; return null; } });
  const handler = createIndustryAnalysisHttpHandler({ service: { options: async () => { throw error; } }, requireAdmin: () => true,
    readDiagnostics: f.diagnostics, send(res, status, body) { res.status = status; res.body = body; } });
  const res = {}; await handler({ method: "GET", headers: {} }, res, new URL("https://local/api/industry-analysis/options"), {});
  assert.equal(res.status, 503); assert.equal(res.body.code, "INDUSTRY_SAVED_READ_BUSY"); assert.equal(error.statusCode, 503);
  assert.equal(f.logs.at(-1).errorCode, "INDUSTRY_SAVED_READ_BUSY"); assert.equal(f.logs.at(-1).readGuard, null);
});
