"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), { EventEmitter } = require("node:events"), zlib = require("node:zlib");
const { createBoundedCompanyResponse, boundedJsonBuffer, stringBytes } = require("./lib/bounded_company_response.cjs");
const { createAnalyticalWorkScheduler } = require("./lib/analytical_work_scheduler.cjs");
const tick = () => new Promise(resolve => setImmediate(resolve));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
class Response extends EventEmitter {
  constructor({ blocked = false, synchronousDrain = false, writeError = null } = {}) {
    super(); this.blocked = blocked; this.synchronousDrain = synchronousDrain; this.writeError = writeError;
    this.headersSent = false; this.writableEnded = false; this.writableFinished = false; this.destroyed = false; this.closed = false;
    this.chunks = []; this.headCount = 0; this.endCount = 0; this.maxChunk = 0;
  }
  writeHead(status, headers) { this.headCount++; this.statusCode = status; this.headers = headers; this.headersSent = true; }
  write(chunk) {
    if (this.writeError) throw this.writeError;
    this.chunks.push(Buffer.from(chunk)); this.maxChunk = Math.max(this.maxChunk, chunk.length);
    if (this.synchronousDrain) this.emit("drain");
    return !this.blocked;
  }
  end(payload) { if (payload !== undefined) this.chunks.push(Buffer.from(payload)); this.endCount++; this.writableEnded = true; queueMicrotask(() => { if (!this.destroyed) { this.writableFinished = true; this.emit("finish"); } }); }
  destroy() { if (this.destroyed) return; this.destroyed = true; this.closed = true; this.emit("close"); }
  body() { return Buffer.concat(this.chunks); }
}
const options = extra => ({ maxResponseBytes: 1024, maxReservedBytes: 2048, chunkBytes: 16, timeoutMs: 500, ...extra });
function noOwnedListeners(res) { for (const name of ["finish", "close", "error", "drain"]) assert.equal(res.listenerCount(name), 0, name); }

function observeSenderRace(onFulfilled = () => {}) {
  // Only this isolated VM substitutes Promise. Observe the real module's race
  // participants/results without adding a runtime hook or asserting GC timing.
  const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm"), records = [];
  class ObservedPromise extends Promise {
    static race(iterable) {
      const participants = Array.from(iterable), record = { fulfilled: [], rejected: [], settled: false };
      for (const item of participants) Promise.resolve(item).then(value => record.fulfilled.push(value), error => record.rejected.push(error));
      const raced = super.race(participants); records.push(record);
      raced.then(value => { record.settled = true; record.value = value; onFulfilled(value); }, error => { record.settled = true; record.error = error; });
      return raced;
    }
  }
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "lib/bounded_company_response.cjs"), "utf8"), {
    module, exports: module.exports, require, Buffer, Promise: ObservedPromise, AbortController, setTimeout, clearTimeout
  }, { filename: "bounded_company_response.race-fixture.cjs" });
  return { create: module.exports.createBoundedCompanyResponse, records };
}

test("production and the completion race publish only primitives while a real body awaits drain", async () => {
  const observed = observeSenderRace(), sender = observed.create(options()), res = new Response({ blocked: true });
  const body = { value: "한글😀".repeat(12), nested: { nullable: null } }, descriptor = { status: 201, body, extraHeaders: { "X-Exact": "kept" } };
  const sending = sender.send(res, () => descriptor); await tick();
  assert.equal(res.chunks.length, 1); assert.equal(res.endCount, 0);
  assert.equal(observed.records.length, 1); const race = observed.records[0];
  assert.equal(race.settled, true); assert.equal(race.value, true);
  assert.deepEqual(race.fulfilled, [true], "production's fulfilled result cannot be the descriptor/body graph");
  assert.equal(sender.status().reservedBytes, 1024);
  res.blocked = false; res.emit("drain"); assert.equal(await sending, true); await tick();
  assert.deepEqual(race.fulfilled, [true, false], "the losing completion branch also fulfills with a primitive");
  assert.deepEqual(res.body(), Buffer.from(JSON.stringify(body))); assert.equal(res.statusCode, 201); assert.equal(res.headers["X-Exact"], "kept");
  assert.equal(sender.status().reservedBytes, 0); noOwnedListeners(res);
});

test("close immediately after publication clears the slot before descriptor access or encoding", async () => {
  const res = new Response(), observed = observeSenderRace(value => { if (value === true) res.destroy(); });
  const sender = observed.create(options()); let bodyReads = 0;
  const sending = sender.send(res, () => ({ get body() { bodyReads++; return { mustNotEncode: true }; } }));
  assert.equal(await sending, false); await tick();
  assert.equal(observed.records[0].value, true); assert.equal(bodyReads, 0);
  assert.equal(res.headCount, 0); assert.equal(res.chunks.length, 0); assert.equal(sender.status().reservedBytes, 0); noOwnedListeners(res);
});

test("a closed caller's late shared rejection stays shared and releases its retained admission once", async () => {
  const shared = deferred(), sentinel = { sameLateError: true }, observed = observeSenderRace(), sender = observed.create(options()), res = new Response();
  const other = shared.promise.then(() => assert.fail("must reject"), error => error);
  const sending = sender.send(res, () => shared.promise); await tick(); res.destroy();
  assert.equal(await sending, false); assert.equal(sender.status().reservedBytes, 1024);
  shared.reject(sentinel); assert.equal(await other, sentinel); await tick();
  assert.equal(observed.records[0].value, false); assert.deepEqual(observed.records[0].fulfilled, [false, false]);
  assert.equal(sender.status().reservedBytes, 0); assert.equal(sender.status().activeResponses, 0); assert.equal(res.headCount, 0); noOwnedListeners(res);
});

test("an active asynchronous producer rejection preserves its original identity through the primitive race", async () => {
  const shared = deferred(), sentinel = { originalAsyncError: true }, observed = observeSenderRace(), sender = observed.create(options()), res = new Response();
  const sending = sender.send(res, () => shared.promise), rejected = assert.rejects(sending, error => error === sentinel);
  shared.reject(sentinel); await rejected; await tick();
  assert.equal(observed.records[0].error, sentinel); assert.deepEqual(observed.records[0].rejected, [sentinel]);
  assert.equal(res.headCount, 0); assert.equal(sender.status().reservedBytes, 0); noOwnedListeners(res);
});

test("native JSON bytes preserve all escapes, unicode, undefined/holes and property order", () => {
  const value = { "2": 2, "10": 10, "": "empty key", 'a"\n': "\0\b\t\n\v\f\r\"\\/한글😀\ud800\udc00\ud800x\udc00\u2028", missing: undefined,
    noFunction() {}, noSymbol: Symbol("none"), values: [undefined, null, false, 0, -0, NaN, Infinity, , ""] };
  const expected = Buffer.from(JSON.stringify(value));
  assert.deepEqual(boundedJsonBuffer(value, expected.length), expected);
  assert.throws(() => boundedJsonBuffer(value, expected.length - 1), { code: "COMPANY_RESPONSE_TOO_LARGE", statusCode: 503 });
  for (const s of ["", "plain", "\n\u0001", "😀", "\ud800", "\udc00", '"\\한글']) assert.equal(stringBytes(s, 1000), Buffer.byteLength(JSON.stringify(s)));
});
test("toJSON/getter receivers, invocation order, boxed conversions and prototypes match native", () => {
  function fixture() {
    const events = [], boxed = new String("old"); boxed.toString = function () { events.push(this === boxed ? "boxed-this" : "wrong"); return "다른😀"; };
    const object = Object.create({ inherited: "not serialized" });
    object.toJSON = function (key) { events.push(this === object ? "toJSON:" + key : "wrong"); return { get field() { events.push(this ? "getter-this" : "wrong"); return "value"; }, boxed, number: new Number(7), boolean: new Boolean(false), symbol: Object(Symbol("s")) }; };
    return { value: { object, date: new Date("2026-01-01T00:00:00Z") }, events };
  }
  const a = fixture(), b = fixture(); assert.equal(boundedJsonBuffer(a.value).toString(), JSON.stringify(b.value)); assert.deepEqual(a.events, b.events);
});
test("native errors and user-thrown identities are preserved; very large string stops before later getters", () => {
  const original = { marker: "same object" }; let later = 0;
  assert.throws(() => boundedJsonBuffer({ get value() { throw original; } }), e => e === original);
  const circular = {}; circular.self = circular;
  assert.throws(() => boundedJsonBuffer(circular), TypeError); assert.throws(() => boundedJsonBuffer(1n), TypeError);
  const value = { large: "x".repeat(10000), get after() { later++; return "not reached"; } };
  assert.throws(() => boundedJsonBuffer(value, 128), { code: "COMPANY_RESPONSE_TOO_LARGE" }); assert.equal(later, 0);
});
test("shared object references are valid while omitted root yields the prior empty end body", () => {
  const shared = { x: 1 }, value = { first: shared, second: shared, array: [shared] };
  assert.equal(boundedJsonBuffer(value).toString(), JSON.stringify(value));
  for (const v of [undefined, () => {}, Symbol("x")]) assert.equal(boundedJsonBuffer(v).length, 0);
});

test("wide empty and shared containers preserve exact bytes and the response limit", () => {
  const shared = Object.freeze({ items: Object.freeze([]), keep: null }), value = {
    empty: Array.from({ length: 12000 }, () => Object.freeze({})),
    shared: Array.from({ length: 6000 }, () => shared), final: { zero: 0, missing: undefined }
  };
  const expected = Buffer.from(JSON.stringify(value));
  assert.deepEqual(boundedJsonBuffer(value, expected.length), expected);
  assert.throws(() => boundedJsonBuffer(value, expected.length - 1), { code: "COMPANY_RESPONSE_TOO_LARGE" });
  assert.equal(value.shared[0], value.shared.at(-1)); assert.equal(Object.isFrozen(shared), true);
});

test("mixed ancestor depths and later shared revisits do not reuse a prior comma count", () => {
  const shared = { empty: {}, array: [null, undefined, {}, []], value: "한글😀" };
  let nested = shared;
  for (let depth = 0; depth < 96; depth++) nested = depth % 2 ? { before: shared, child: nested, after: shared } : [shared, nested, shared];
  const value = { nested, after: [shared, { shallow: true }, shared], last: shared }, expected = Buffer.from(JSON.stringify(value));
  assert.deepEqual(boundedJsonBuffer(value, expected.length), expected);
  assert.throws(() => boundedJsonBuffer(value, expected.length - 1), { code: "COMPANY_RESPONSE_TOO_LARGE" });
});

test("revisited toJSON containers, primitive returns and getter receivers match native traversal", () => {
  function fixture() {
    const events = [], shared = { toJSON(key) {
      events.push(["toJSON", key, this === shared]);
      if (key === "primitive") return 7;
      const item = { get value() { events.push(["getter", key, this === item]); return key || "root"; }, empty: {}, omitted: undefined };
      return key === "array" ? [item, item, undefined] : item;
    } };
    return { events, value: { first: shared, primitive: shared, array: shared, last: shared } };
  }
  const a = fixture(), b = fixture(); assert.equal(boundedJsonBuffer(a.value).toString(), JSON.stringify(b.value)); assert.deepEqual(a.events, b.events);
});

test("getter mutation and nested serialization keep native holder order", () => {
  function fixture() {
    const events = [], sibling = { retained: "same" }, value = { first: sibling,
      get change() { events.push(this === value); delete this.later; this.addedAfterEnumeration = "ignored"; return { nested: boundedJsonBuffer([{}, sibling, {}]).toString() }; },
      later: sibling, final: sibling };
    return { value, events };
  }
  const a = fixture(), b = fixture(); assert.equal(boundedJsonBuffer(a.value).toString(), JSON.stringify(b.value)); assert.deepEqual(a.events, b.events);
});

test("native cycle and original getter errors survive ancestor unwinding", () => {
  const root = { before: [{}, { sibling: [] }] }; root.after = { child: root };
  const nativeCycle = (() => { try { JSON.stringify(root); } catch (error) { return error; } })();
  assert.throws(() => boundedJsonBuffer(root), error => error instanceof TypeError && error.message === nativeCycle.message);
  const sentinel = { sameError: true }, value = { before: [[], {}, { deep: [{}, {}] }], after: { get failing() { throw sentinel; } } };
  assert.throws(() => boundedJsonBuffer(value), error => error === sentinel);
  assert.equal(boundedJsonBuffer({ afterFailure: [{}, {}, []] }).toString(), JSON.stringify({ afterFailure: [{}, {}, []] }));
});

test("native raw JSON values keep their exact spelling and count their embedded bytes", { skip: typeof JSON.rawJSON !== "function" }, () => {
  const raw = JSON.rawJSON('"' + "x".repeat(80) + '"'), value = { raw, exponent: JSON.rawJSON("1e2") }, expected = JSON.stringify(value);
  assert.equal(boundedJsonBuffer(value, Buffer.byteLength(expected)).toString(), expected);
  assert.throws(() => boundedJsonBuffer(value, 16), { code: "COMPANY_RESPONSE_TOO_LARGE" });
});
test("JSON status, security/content/cache and caller headers remain exact; binary gzip is untouched", async () => {
  const sender = createBoundedCompanyResponse(options({ headers: () => ({ "X-Security": "same", "Cache-Control": "security" }) })), res = new Response();
  const body = { company: { name: "업체😀" }, values: [null, 0] };
  assert.equal(await sender.send(res, () => ({ status: 200, body, extraHeaders: { "X-Company-Detail-Cache": "saved", "X-Company-Detail-Prepared-At": "2026-01-01", "Cache-Control": "no-store" } })), true);
  assert.equal(res.statusCode, 200); assert.deepEqual(res.body(), Buffer.from(JSON.stringify(body)));
  assert.deepEqual(res.headers, { "X-Security": "same", "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Company-Detail-Cache": "saved", "X-Company-Detail-Prepared-At": "2026-01-01" }); noOwnedListeners(res);
  const gzip = zlib.gzipSync(Buffer.from(JSON.stringify(body))), encoded = new Response();
  await sender.send(encoded, () => ({ status: 200, body: gzip, extraHeaders: { "Content-Encoding": "gzip", "Content-Length": gzip.length, "Vary": "Accept-Encoding", "X-Company-Bootstrap-Cache": "memory" } }));
  assert.deepEqual(encoded.body(), gzip); assert.equal(encoded.headers["Content-Length"], gzip.length); assert.equal(encoded.headers["Content-Encoding"], "gzip"); assert.equal(sender.status().reservedBytes, 0);
});
test("full reservation precedes producer admission and a third caller is rejected without reading", async () => {
  const sender = createBoundedCompanyResponse(options()), a = new Response({ blocked: true }), b = new Response({ blocked: true });
  const first = sender.send(a, () => ({ body: "a".repeat(100) })), second = sender.send(b, () => ({ body: "b".repeat(100) })); await tick();
  assert.equal(sender.status().reservedBytes, 2048); let calls = 0;
  await assert.rejects(() => sender.send(new Response(), () => { calls++; }), { code: "COMPANY_RESPONSE_BUSY", statusCode: 503 }); assert.equal(calls, 0);
  a.destroy(); assert.equal(await first, false); assert.equal(sender.status().reservedBytes, 1024);
  await sender.send(new Response(), () => ({ body: "replacement" })); b.destroy(); await second; assert.equal(sender.status().reservedBytes, 0); assert.equal(sender.status().activeResponses, 0);
});
test("slow backpressure holds only response bytes and releases the real analytical lease", async () => {
  const scheduler = createAnalyticalWorkScheduler(), sender = createBoundedCompanyResponse(options({ runWork: (op, o) => scheduler.run(op, o) })), res = new Response({ blocked: true });
  const sending = sender.send(res, () => ({ body: { large: "x".repeat(70) } })); await tick();
  assert.equal(res.chunks.length, 1); assert.equal(res.maxChunk, 16); assert.equal(scheduler.status().active, false);
  assert.equal(await scheduler.run(() => "other analysis", { kind: "test-other" }), "other analysis");
  res.blocked = false; res.emit("drain"); assert.equal(await sending, true); assert.equal(sender.status().reservedBytes, 0); assert.equal(res.maxChunk <= 16, true); noOwnedListeners(res); await scheduler.close();
});
test("synchronous drain and a write returning false do not lose the wakeup", async () => {
  const sender = createBoundedCompanyResponse(options()), res = new Response({ blocked: true, synchronousDrain: true });
  assert.equal(await sender.send(res, () => ({ body: "x".repeat(70) })), true); assert.equal(res.endCount, 1); assert.equal(sender.status().reservedBytes, 0);
});
test("close during shared preparation returns promptly but keeps its reservation until the shared read settles", async () => {
  const shared = deferred(), sender = createBoundedCompanyResponse(options()), res = new Response(); let encodes = 0;
  const body = { get value() { encodes++; return "must not encode"; } }, other = shared.promise.then(x => x);
  const sending = sender.send(res, () => shared.promise); await tick(); res.destroy(); assert.equal(await sending, false); assert.equal(sender.status().reservedBytes, 1024); noOwnedListeners(res);
  const result = { status: 200, body }; shared.resolve(result); assert.equal(await other, result); await tick();
  assert.equal(encodes, 0); assert.equal(res.headCount, 0); assert.equal(res.chunks.length, 0); assert.equal(sender.status().reservedBytes, 0);
});
test("deadline during preparation cannot later encode, transmit, or cancel another shared consumer", async () => {
  const shared = deferred(), sender = createBoundedCompanyResponse(options({ timeoutMs: 10 })), res = new Response(); let reads = 0;
  const other = shared.promise.then(v => v.body), sending = sender.send(res, () => shared.promise);
  await wait(25); assert.equal(await sending, false); assert.equal(res.destroyed, true); assert.equal(sender.status().reservedBytes, 1024);
  shared.resolve({ get body() { reads++; return { keep: "shared" }; } }); assert.deepEqual(await other, { keep: "shared" }); await tick();
  assert.equal(reads, 1, "only the independent consumer accesses the late descriptor"); assert.equal(res.headCount, 0); assert.equal(sender.status().reservedBytes, 0); noOwnedListeners(res);
});
test("disconnect aborts queued JSON admission without canceling the unrelated analytical owner", async () => {
  const scheduler = createAnalyticalWorkScheduler(), gate = deferred(), entered = deferred();
  const owner = scheduler.run(async () => { entered.resolve(); await gate.promise; return "owner complete"; }); await entered.promise;
  let encodes = 0; const sender = createBoundedCompanyResponse(options({ runWork: (op, o) => scheduler.run(op, o) })), res = new Response();
  const sending = sender.send(res, () => ({ body: { get payload() { encodes++; return "late"; } } })); await tick(); res.destroy(); assert.equal(await sending, false);
  assert.equal(encodes, 0); assert.equal(sender.status().reservedBytes, 0); gate.resolve(); assert.equal(await owner, "owner complete"); await scheduler.close();
});
test("slow transmission deadline destroys the response and clears all owned listeners and bytes", async () => {
  const sender = createBoundedCompanyResponse(options({ timeoutMs: 10 })), res = new Response({ blocked: true });
  const sending = sender.send(res, () => ({ body: { text: "x".repeat(70) } })); await wait(25);
  assert.equal(await sending, false); assert.equal(res.destroyed, true); assert.equal(res.endCount, 0); assert.equal(res.chunks.length, 1); assert.equal(sender.status().reservedBytes, 0); noOwnedListeners(res);
});
test("producer/JSON/header failures release admission and preserve active caller error identity", async () => {
  const boom = new Error("original");
  for (const make of [() => { throw boom; }, () => ({ body: { get x() { throw boom; } } })]) {
    const sender = createBoundedCompanyResponse(options()), res = new Response(); await assert.rejects(() => sender.send(res, make), e => e === boom);
    assert.equal(res.headCount, 0); assert.equal(sender.status().reservedBytes, 0); noOwnedListeners(res);
  }
  const sender = createBoundedCompanyResponse(options({ headers: () => { throw boom; } })), res = new Response();
  await assert.rejects(() => sender.send(res, () => ({ body: {} })), e => e === boom); assert.equal(sender.status().reservedBytes, 0); noOwnedListeners(res);
});
test("oversized JSON/string/binary reject before headers and release admission", async () => {
  for (const body of [{ text: "x".repeat(2000) }, "x".repeat(2000), Buffer.alloc(2000)]) {
    const sender = createBoundedCompanyResponse(options()), res = new Response(); await assert.rejects(() => sender.send(res, () => ({ body })), { code: "COMPANY_RESPONSE_TOO_LARGE", statusCode: 503 });
    assert.equal(res.headCount, 0); assert.equal(res.chunks.length, 0); assert.equal(sender.status().reservedBytes, 0); noOwnedListeners(res);
  }
});
test("partial transmission failure closes without a duplicate response or leaking reservation", async () => {
  const sender = createBoundedCompanyResponse(options()), res = new Response({ writeError: new Error("socket failed") });
  assert.equal(await sender.send(res, () => ({ body: { value: "unchanged" } })), false); assert.equal(res.headCount, 1); assert.equal(res.endCount, 0); assert.equal(res.destroyed, true); assert.equal(sender.status().reservedBytes, 0); noOwnedListeners(res);
});
test("responses already committed, ended or closed never invoke a producer", async () => {
  for (const key of ["headersSent", "writableEnded", "writableFinished", "destroyed", "closed"]) {
    const sender = createBoundedCompanyResponse(options()), res = new Response(); res[key] = true; let called = false;
    assert.equal(await sender.send(res, () => { called = true; }), false); assert.equal(called, false); assert.equal(sender.status().reservedBytes, 0);
  }
});
test("external commitment during preparation is not overwritten", async () => {
  const gate = deferred(), sender = createBoundedCompanyResponse(options()), res = new Response(); const sending = sender.send(res, () => gate.promise); await tick();
  res.writeHead(204, { Existing: "kept" }); gate.resolve({ body: { unexpected: true } }); assert.equal(await sending, false); assert.equal(res.headCount, 1); assert.deepEqual(res.headers, { Existing: "kept" }); assert.equal(sender.status().reservedBytes, 0);
});

test("close before the producer microtask never starts a shared read", async () => {
  const sender = createBoundedCompanyResponse(options()), res = new Response(); let calls = 0;
  const sending = sender.send(res, () => { calls++; return { body: {} }; }); res.destroy();
  assert.equal(await sending, false); await tick(); assert.equal(calls, 0); assert.equal(sender.status().reservedBytes, 0); noOwnedListeners(res);
});

test("an asynchronous writable error closes once and releases a stalled writer", async () => {
  const sender = createBoundedCompanyResponse(options()), res = new Response({ blocked: true });
  const sending = sender.send(res, () => ({ body: "x".repeat(100) })); await tick(); res.emit("error", new Error("synthetic writable error"));
  assert.equal(await sending, false); assert.equal(res.headCount, 1); assert.equal(res.endCount, 0); assert.equal(res.destroyed, true); assert.equal(sender.status().reservedBytes, 0); noOwnedListeners(res);
});

function routeFixture(overrides = {}) {
  // Extract only the owned two route blocks and small send function. No app
  // module is required and no server, startup task, source or API is started.
  const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm"), source = fs.readFileSync(path.join(__dirname, "glamping_app_server.cjs"), "utf8").replace(/\r\n/g, "\n");
  const security = { "X-Synthetic-Security": "unchanged" }, sender = createBoundedCompanyResponse(options({ headers: () => security }));
  const env = { Buffer, securityHeaders: () => security, responseUnavailable: require("./lib/bounded_company_response.cjs").unavailable,
    companyResponse: sender, requireAdminSession: () => true, acceptsGzip: require("./lib/company_bootstrap.cjs").acceptsGzip,
    companyBootstrapStore: { get: async () => { throw new Error("fixture not supplied"); } }, companyDetailStore: { get: async () => { throw new Error("fixture not supplied"); } }, ...overrides };
  const begin = source.indexOf("function send(res,"), end = source.indexOf("// The byte reservation", begin);
  env.send = vm.runInNewContext("(" + source.slice(begin, end).trim() + ")", env);
  const block = (start, next) => source.slice(source.indexOf(start), source.indexOf(next, source.indexOf(start)));
  const code = block('    if (req.method === "GET" && reqUrl.pathname === "/api/company-master/bootstrap")', '    if (req.method === "GET" && reqUrl.pathname === "/api/company-master/summary")')
    + block('    if (req.method === "GET" && reqUrl.pathname === "/api/company-master/detail")', '    if (req.method === "GET" && reqUrl.pathname === "/api/company-master/integrated")');
  const serverAt = source.indexOf("\nconst server = http.createServer"), catchAt = source.lastIndexOf("\n  } catch (error) {", serverAt);
  assert.ok(catchAt > 0 && serverAt > catchAt);
  const catchCode = source.slice(catchAt, serverAt);
  const route = vm.runInNewContext("(async function(req,res,reqUrl,session){try {" + code + catchCode + ")", env);
  return { sender, send: env.send, request: (url, res, encoding = "identity") => route({ method: "GET", headers: { "accept-encoding": encoding } }, res, new URL(url, "http://fixture.invalid"), {}) };
}
test("actual owned detail route preserves ID validation, missing response, cache headers and exact JSON body", async () => {
  let calls = 0; const data = { company: { companyId: "one", name: "한글😀\ud800" }, nullable: null };
  const f = routeFixture({ companyDetailStore: { async get(id) { calls++; assert.equal(id, "one"); return { data, cacheStatus: "saved", preparedAt: "same-time" }; } } });
  const missingId = new Response(); await f.request("/api/company-master/detail", missingId); assert.equal(missingId.statusCode, 400); assert.equal(calls, 0);
  const good = new Response(); assert.equal(await f.request("/api/company-master/detail?companyId=%20one%20", good), true); assert.deepEqual(good.body(), Buffer.from(JSON.stringify(data))); assert.equal(good.headers["X-Company-Detail-Cache"], "saved"); assert.equal(good.headers["X-Company-Detail-Prepared-At"], "same-time");
  const absent = routeFixture({ companyDetailStore: { get: async () => ({ data: null }) } }), noCompany = new Response(); await absent.request("/api/company-master/detail?companyId=one", noCompany); assert.equal(noCompany.statusCode, 404); assert.equal(noCompany.body().toString(), JSON.stringify({ error: "업체를 찾을 수 없습니다." }));
});
test("actual bootstrap route preserves both encodings, exact length/Vary and source failure mapping", async () => {
  const json = Buffer.from('{"companies":[{"name":"한글😀"}],"totalCompanies":1}'), gzip = zlib.gzipSync(json);
  const f = routeFixture({ companyBootstrapStore: { get: async () => ({ json, gzip, cacheStatus: "memory" }) } });
  for (const [encoding, bytes] of [["identity", json], ["gzip;q=0.5", gzip], ["gzip;q=0", json]]) {
    const res = new Response(); await f.request("/api/company-master/bootstrap", res, encoding); assert.deepEqual(res.body(), bytes); assert.equal(res.headers["Content-Length"], bytes.length); assert.equal(res.headers.Vary, "Accept-Encoding"); assert.equal(res.headers["X-Company-Bootstrap-Cache"], "memory"); assert.equal(res.headers["Content-Encoding"], bytes === gzip ? "gzip" : undefined);
  }
  const failed = routeFixture({ companyBootstrapStore: { get: async () => { throw Object.assign(new Error("source"), { code: "COMPANY_BOOTSTRAP_SOURCE_CHANGED", statusCode: 503 }); } } });
  const errorResponse = new Response(); await failed.request("/api/company-master/bootstrap", errorResponse); assert.equal(errorResponse.statusCode, 503);
  assert.equal(JSON.parse(errorResponse.body()).error, "업체 기본자료가 변경되고 있습니다. 다시 조회해 주세요."); assert.equal(failed.sender.status().reservedBytes, 0);
});
test("actual small send preserves native body/header contract and ignores a second write", () => {
  const f = routeFixture(), res = new Response(), body = { error: "small", retryAfterSeconds: 1 };
  f.send(res, 503, body, "application/json; charset=utf-8", { "Retry-After": "1" });
  assert.equal(res.headCount, 1); assert.equal(res.statusCode, 503); assert.equal(res.headers["Retry-After"], "1");
  // Small generic send uses end(payload), unlike the bounded streaming sink.
  // Capture its argument directly to test exact old native JSON bytes.
  let payload; const plain = new Response(); plain.end = value => { payload = value; plain.writableEnded = true; };
  f.send(plain, 200, body); assert.equal(payload, JSON.stringify(body)); f.send(plain, 500, { unexpected: true }); assert.equal(plain.headCount, 1);
});

test("actual async route catches busy/oversize as a small 503 response instead of a rejected server promise", async () => {
  let reads = 0; const shared = deferred(), f = routeFixture({ companyDetailStore: { get: () => { reads++; return shared.promise; } } });
  const a = new Response(), b = new Response(), first = f.request("/api/company-master/detail?companyId=one", a), second = f.request("/api/company-master/detail?companyId=one", b); await tick();
  const busy = new Response(); await f.request("/api/company-master/detail?companyId=one", busy); assert.equal(busy.statusCode, 503); assert.equal(busy.headers["Retry-After"], "1"); assert.equal(reads, 2);
  assert.equal(JSON.parse(busy.body()).retryAfterSeconds, 1); a.destroy(); b.destroy(); await Promise.all([first, second]); shared.resolve({ data: {} }); await tick(); assert.equal(f.sender.status().reservedBytes, 0);
  const capped = routeFixture({ companyDetailStore: { get: async () => ({ data: { text: "x".repeat(2000) } }) } }), large = new Response(); await capped.request("/api/company-master/detail?companyId=one", large);
  assert.equal(large.statusCode, 503); assert.equal(large.headers["Retry-After"], "1"); assert.equal(large.headCount, 1); assert.equal(capped.sender.status().reservedBytes, 0);
});
