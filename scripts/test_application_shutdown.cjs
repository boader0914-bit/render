"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), { EventEmitter } = require("node:events");
const { installApplicationShutdown } = require("./lib/application_shutdown.cjs");
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const gate = () => { let resolve, reject; const promise = new Promise((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; };
const turn = () => new Promise(resolve => setImmediate(resolve));
function fixture({ httpError, derivedError, loggerError = false } = {}) {
  const processControl = new EventEmitter(), exits = [], logs = [], derived = gate();
  let httpDone, timeout, closes = 0, idleCloses = 0, derivedCloses = 0, cleared = 0;
  processControl.exit = code => exits.push(code);
  const server = { close(done) { closes++; httpDone = done; }, closeIdleConnections() { idleCloses++; } };
  const options = { server, processControl, closeDerivedWork: async () => { derivedCloses++; if (derivedError) throw derivedError; await derived.promise; },
    logger: { info: (...args) => { if (loggerError) throw Error("private log sink"); logs.push(args); } },
    setTimeoutImpl(callback, delay) { assert.equal(delay, 20000); timeout = callback; return 1; },
    clearTimeoutImpl(value) { assert.equal(value, 1); cleared++; } };
  const host = installApplicationShutdown(options);
  return { host, options, processControl, exits, logs, derived, finishHttp: () => httpDone(httpError), timeout: () => timeout(),
    counts: () => ({ closes, idleCloses, derivedCloses, cleared }) };
}

test("SIGTERM stops HTTP admission and waits both worker drain and active HTTP before exiting once", async () => {
  const f = fixture(); f.processControl.emit("SIGTERM"); await turn();
  assert.deepEqual(f.counts(), { closes: 1, idleCloses: 1, derivedCloses: 1, cleared: 0 });
  assert.deepEqual(f.exits, []);
  f.derived.resolve(); await turn(); assert.deepEqual(f.exits, []);
  f.finishHttp(); await turn();
  assert.deepEqual(f.exits, [0]); assert.equal(f.processControl.listenerCount("SIGTERM"), 0);
  assert.equal(f.processControl.listenerCount("SIGINT"), 0); assert.equal(f.host.status().finished, true);
  assert.equal(f.logs.length, 2); assert.deepEqual(f.counts(), { closes: 1, idleCloses: 1, derivedCloses: 1, cleared: 1 });
});

test("duplicate install and repeated signals share the same cleanup without early forced termination", async () => {
  const f = fixture(); assert.equal(installApplicationShutdown(f.options), f.host);
  f.processControl.emit("SIGINT"); f.processControl.emit("SIGTERM"); f.processControl.emit("SIGINT"); await turn();
  assert.equal(f.counts().derivedCloses, 1); assert.equal(f.counts().closes, 1); assert.deepEqual(f.exits, []);
  const pending = f.host.begin("SIGTERM"); f.finishHttp(); f.derived.resolve();
  assert.deepEqual(await pending, { status: "complete" }); assert.deepEqual(f.exits, [0]);
});

test("grace timeout reports uncertainty and never pretends an unresolved worker finished", async () => {
  const f = fixture(); const pending = f.host.begin("SIGTERM"); await turn(); f.finishHttp(); f.timeout();
  assert.deepEqual(await pending, { status: "timeout" }); assert.deepEqual(f.exits, [1]);
  assert.ok(f.logs.at(-1)[1].includes('"status":"timeout"'));
  f.derived.resolve(); await turn(); assert.deepEqual(f.exits, [1], "late cleanup cannot exit twice");
});

test("cleanup failures are safely reported and no private exception data is logged", async () => {
  const secret = Object.assign(new Error("private account token and source path"), { code: "PRIVATE_PATH" });
  const f = fixture({ derivedError: secret, httpError: secret }); const pending = f.host.begin("SIGTERM"); f.finishHttp();
  assert.deepEqual(await pending, { status: "failed" }); assert.deepEqual(f.exits, [1]);
  assert.doesNotMatch(JSON.stringify(f.logs), /private|PRIVATE_PATH|token|source path/);
});

test("already stopped HTTP and failing log sink still permit the explicit worker cleanup", async () => {
  const f = fixture({ httpError: { code: "ERR_SERVER_NOT_RUNNING" }, loggerError: true });
  const pending = f.host.begin("SIGTERM"); f.finishHttp(); f.derived.resolve();
  assert.deepEqual(await pending, { status: "complete" }); assert.deepEqual(f.exits, [0]);
});

test("invalid lifecycle inputs cannot install hidden handlers or unbounded shutdown timers", () => {
  for (const options of [{}, { server: {}, closeDerivedWork() {} }, { server: { close() {} }, closeDerivedWork: null },
    { server: { close() {} }, closeDerivedWork() {}, graceMs: 30001 }, { server: { close() {} }, closeDerivedWork() {}, graceMs: 0 }]) {
    assert.throws(() => installApplicationShutdown(options), TypeError);
  }
});

test("the actual appserver explicitly installs its refresh drain on the HTTP server", () => {
  const source = fs.readFileSync(path.join(__dirname, "glamping_app_server.cjs"), "utf8");
  const start = source.indexOf("const server = http.createServer("), end = source.indexOf("\nfunction localNetworkUrls", start);
  assert.ok(start > 0 && end > start); let supplied, calls = 0;
  const server = new EventEmitter();
  vm.runInNewContext(source.slice(start, end), { http: { createServer: () => server }, route() {},
    insightIntegration: null, searchDemandScheduler: { stop() {} },
    keywordMonthlyRefreshIntegration: { close: () => { calls++; return Promise.resolve(); } },
    installApplicationShutdown: options => { supplied = options; } });
  assert.equal(supplied.server, server); assert.equal(calls, 0);
  supplied.closeDerivedWork(); assert.equal(calls, 1);
});
