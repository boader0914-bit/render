"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const { createController, createCache, createSavedResults, savedResults } = require("../web/regional-analysis.js");
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const scope = (extra = {}) => ({ accountKey: "admin-one", regionKey: "sancheong", month: "2026-09", months: 13, ...extra });
const payload = (input = scope(), resultId = "saved-1") => ({ status: "ready", scope: { regionKey: input.regionKey, month: input.month, months: 13 },
  snapshot: { resultId, sourceFingerprint: "same-input", status: "ready", generatedAt: "2026-10-15T00:00:00Z", scope: { regionKey: input.regionKey, month: input.month, months: 13 },
    groups: [{ key: "visitors", status: "ready", metrics: [{ key: "daily", unit: "명", rows: [{ period: "2026-09", status: "observed", value: 0 }] }] }], },
  job: null, policy: { enabled: false } });
const host = () => ({ innerHTML: "", dataset: {}, isConnected: true, listeners: new Map(), addEventListener(name, fn) { this.listeners.set(name, fn); } });

test("shared saved reader and summary coalesce the exact account, region and explicit period GET", async () => {
  const cache = createCache(), reader = createSavedResults({ cache }), pending = deferred(), requests = [];
  const fetchJson = async (url, options) => { requests.push({ url, options }); return pending.promise; };
  const controller = createController({ cache, fetchJson }), element = host();
  const reading = reader.get({ ...scope(), fetchJson });
  const mounting = controller.mount(element, { ...scope(), regionLabel: "산청군" });
  await tick(); assert.equal(requests.length, 1); assert.equal(requests[0].options, undefined);
  assert.equal(requests[0].url, "/api/regional-analysis?regionKey=sancheong&month=2026-09&months=13");
  const value = payload(); pending.resolve(value); await Promise.all([reading, mounting]);
  assert.equal(reader.read(scope()), value); assert.equal(controller.state.snapshot, value.snapshot);
  assert.equal(controller.state.snapshot.groups[0].metrics[0].rows[0].value, 0);
  assert.ok(Number.isFinite(reader.info(scope()).checkedAt)); controller.stop();
  assert.equal(typeof savedResults.read, "function"); assert.equal(typeof savedResults.get, "function");
});

test("mismatched region, month or window never replaces the last valid cached result", async () => {
  let clock = 1000; const cache = createCache({ now: () => clock }), reader = createSavedResults({ cache }), good = payload();
  await reader.get({ ...scope(), fetchJson: async () => good }); const checkedAt = reader.info(scope()).checkedAt;
  const cases = [
    value => { value.scope.regionKey = "other"; }, value => { value.scope.month = "2026-08"; }, value => { value.scope.months = 24; },
    value => { value.snapshot.scope.regionKey = "other"; }, value => { value.snapshot.scope.month = "2026-08"; }, value => { value.snapshot.scope.months = 24; },
    value => { value.management = { scope: { ...value.scope, month: "2026-08" } }; },
    value => { value.job = { scope: { ...value.scope, regionKey: "other" } }; },
    value => { delete value.scope; }, value => { delete value.snapshot.scope; }
  ];
  for (const change of cases) {
    clock++; const invalid = structuredClone(good); change(invalid);
    await assert.rejects(reader.get({ ...scope(), force: true, fetchJson: async () => invalid }));
    assert.equal(reader.read(scope()), good); assert.equal(reader.info(scope()).checkedAt, checkedAt);
  }
  await assert.rejects(reader.get({ ...scope(), force: true, fetchJson: async () => { throw Error("offline"); } }), /offline/);
  assert.equal(reader.read(scope()), good);
  await assert.rejects(reader.get({ ...scope(), force: true, fetchJson: async () => ({ scope: good.scope, snapshot: null, storage: { errorCode: "REGIONAL_RESULT_INVALID" } }) }), /마지막 정상/);
  assert.equal(reader.read(scope()), good);
});

test("saved reader separates accounts, regions and months and refuses unsupported windows", async () => {
  const reader = createSavedResults({ cache: createCache() }); const calls = [];
  const fetchJson = async url => { calls.push(url); const query = new URL(url, "http://local").searchParams; return payload(scope({ regionKey: query.get("regionKey"), month: query.get("month") })); };
  for (const input of [scope(), scope({ accountKey: "admin-two" }), scope({ regionKey: "pocheon" }), scope({ month: "2026-08" })]) await reader.get({ ...input, fetchJson });
  assert.equal(calls.length, 4); await reader.get({ ...scope(), fetchJson }); assert.equal(calls.length, 4);
  assert.throws(() => reader.get({ ...scope(), months: 24, fetchJson }), /13개월/);
  assert.throws(() => reader.get({ ...scope(), month: "2026-13", fetchJson }), /기준기간/);
  reader.invalidate(scope()); await reader.get({ ...scope(), fetchJson }); assert.equal(calls.length, 5);
  reader.clear(); assert.equal(reader.read(scope()), null);
});

test("invalidating an in-flight read permits a new confirmation and the old response cannot refill cache", async () => {
  const reader = createSavedResults({ cache: createCache() }), old = deferred(), fresh = payload(scope(), "new-result");
  const pending = reader.get({ ...scope(), fetchJson: () => old.promise }); await tick();
  reader.invalidate(scope()); await reader.get({ ...scope(), fetchJson: async () => fresh });
  old.resolve(payload()); await pending; assert.equal(reader.read(scope()).snapshot.resultId, "new-result");
  const second = deferred(), beforeClear = reader.get({ ...scope(), force: true, fetchJson: () => second.promise }); await tick();
  reader.clear(); second.resolve(payload()); await beforeClear; assert.equal(reader.read(scope()), null);
});

test("mutation acceptance survives an older flight and failed confirmation without disturbing another scope", async () => {
  const cache = createCache(), normal = payload(), old = deferred(), other = deferred();
  await cache.get("selected", async () => normal);
  let oldCalls = 0, otherCalls = 0, retryCalls = 0;
  const beforeMutation = cache.get("selected", () => { oldCalls++; return old.promise; }, true);
  const otherFirst = cache.get("other", () => { otherCalls++; return other.promise; }, true);
  await tick();
  cache.invalidate("selected");
  const accepted = { ...normal, job: { status: "queued", scope: normal.scope } };
  cache.set("selected", accepted);
  const confirmation = cache.get("selected", async () => { retryCalls++; throw Error("new confirmation failed"); }, true);
  const otherShared = cache.get("other", async () => { otherCalls++; throw Error("other scope must keep its original flight"); }, true);
  await assert.rejects(confirmation, /new confirmation failed/);
  assert.equal(cache.read("selected"), accepted, "a failed confirmation preserves the accepted mutation and its last normal snapshot");
  old.resolve(normal); await beforeMutation;
  assert.equal(cache.read("selected"), accepted, "the detached old flight cannot erase the queued mutation");
  other.resolve(payload(scope({ regionKey: "pocheon" }), "other-result"));
  const [firstResult, sharedResult] = await Promise.all([otherFirst, otherShared]);
  assert.equal(firstResult, sharedResult); assert.equal(cache.read("other"), firstResult);
  assert.equal(oldCalls, 1); assert.equal(retryCalls, 1); assert.equal(otherCalls, 1);
});

test("first display consumes entry time once and records completion only after a paint boundary", async () => {
  let clock = Date.parse("2026-10-17T00:00:00Z"); const cache = createCache({ now: () => clock }), frames = [], next = deferred();
  const element = host(); element.dataset.raEntryStartedAt = String(clock - 40);
  const controller = createController({ cache, now: () => clock, afterPaint: fn => frames.push(fn), fetchJson: () => next.promise });
  const mounting = controller.mount(element, scope()); await tick();
  assert.equal(element.dataset.raEntryStartedAt, undefined); assert.equal(element.dataset.raDisplayStatus, "loading");
  assert.equal(element.dataset.raDisplayMs, undefined); assert.equal(element.dataset.raVerifiedStatus, "checking");
  clock += 50; next.resolve(payload()); await mounting;
  assert.equal(element.dataset.raDisplayMs, undefined, "a response is not evidence of a completed paint");
  clock += 10; frames.shift()();
  assert.equal(element.dataset.raDisplayStatus, "ready"); assert.equal(element.dataset.raDisplayMs, "100");
  assert.equal(element.dataset.raVerifiedStatus, "ready"); assert.equal(element.dataset.raVerifiedMs, "100");
  const sequence = element.dataset.raDisplaySequence;
  element.dataset.raEntryStartedAt = String(clock - 5); await controller.mount(element, scope()); frames.shift()();
  assert.equal(element.dataset.raDisplaySource, "cache"); assert.equal(element.dataset.raVerifiedStatus, "cached");
  assert.equal(element.dataset.raVerifiedMs, undefined); assert.ok(Number(element.dataset.raDisplaySequence) > Number(sequence)); controller.stop();
});

test("browser timing waits two animation frames and old paints cannot complete a new region", async () => {
  const frames = [], context = vm.createContext({ module: { exports: {} }, URLSearchParams, setTimeout, clearTimeout, queueMicrotask, requestAnimationFrame: fn => frames.push(fn) });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../web/regional-analysis.js"), "utf8"), context);
  const module = context.module.exports, second = deferred(); let clock = Date.parse("2026-10-17T00:00:00Z");
  const element = host(), controller = module.createController({ cache: module.createCache(), now: () => clock,
    fetchJson: url => url.includes("pocheon") ? second.promise : payload() });
  await controller.mount(element, scope()); assert.equal(frames.length, 1);
  assert.equal(element.dataset.raDisplayStatus, "loading"); frames.shift()();
  assert.equal(element.dataset.raDisplayStatus, "loading"); frames.shift()(); assert.equal(element.dataset.raDisplayStatus, "ready");
  await controller.refresh(true); const oldFirstFrame = frames.shift();
  const changed = controller.mount(element, scope({ regionKey: "pocheon" })); await tick(); oldFirstFrame(); frames.shift()();
  assert.equal(element.dataset.raDisplayStatus, "loading"); assert.equal(element.dataset.raDisplaySequence, undefined);
  second.resolve(payload(scope({ regionKey: "pocheon" }))); await changed;
  frames.shift()(); frames.shift()(); assert.equal(element.dataset.raDisplayStatus, "ready");
  assert.equal(element.dataset.raDisplayResultId, "saved-1"); assert.equal(controller.state.regionKey, "pocheon"); controller.stop();
});

test("cached paint and server confirmation have separate times and failed confirmation retains its last check", async () => {
  let clock = Date.parse("2026-10-17T00:00:00Z"); const cache = createCache({ now: () => clock }), reader = createSavedResults({ cache }), frames = [], next = deferred();
  await reader.get({ ...scope(), fetchJson: async () => payload() }); const checkedAt = new Date(clock).toISOString(); reader.invalidate(scope());
  let fail = false;
  const element = host(), controller = createController({ cache, now: () => clock, afterPaint: fn => frames.push(fn), fetchJson: () => fail ? Promise.reject(Error("offline")) : next.promise });
  const mounting = controller.mount(element, scope()); await tick(); clock += 5; frames.shift()();
  assert.equal(element.dataset.raDisplaySource, "cache"); assert.equal(element.dataset.raDisplayMs, "5");
  assert.equal(element.dataset.raVerifiedStatus, "checking"); assert.equal(element.dataset.raVerifiedMs, undefined);
  assert.equal(controller.state.checkedAt, checkedAt);
  clock += 100; next.resolve(payload()); await mounting; clock += 5; frames.shift()();
  assert.equal(element.dataset.raDisplayMs, "5", "immediate cached paint is not replaced with the confirmation duration");
  assert.equal(element.dataset.raVerifiedMs, "110"); assert.equal(element.dataset.raVerifiedStatus, "ready");
  assert.notEqual(controller.state.checkedAt, checkedAt);
  const lastConfirmed = controller.state.checkedAt; clock += 10; fail = true;
  const failed = controller.refresh(true); await tick(); await failed;
  while (frames.length) frames.shift()(); assert.equal(controller.state.snapshot.resultId, "saved-1");
  assert.equal(controller.state.checkedAt, lastConfirmed); assert.equal(element.dataset.raVerifiedStatus, "error");
  assert.equal(element.dataset.raDisplayStatus, "error"); assert.equal(element.dataset.raVerifiedMs, undefined); controller.stop();
});

test("a response received before the cached frame is never reported as an earlier cached paint", async () => {
  const cache = createCache(), reader = createSavedResults({ cache }), frames = [];
  await reader.get({ ...scope(), fetchJson: async () => payload() }); reader.invalidate(scope());
  const element = host(), controller = createController({ cache, afterPaint: fn => frames.push(fn), fetchJson: async () => payload(scope(), "new-result") });
  await controller.mount(element, scope()); assert.equal(frames.length, 2);
  frames.shift()(); assert.equal(element.dataset.raDisplayStatus, "loading");
  assert.equal(element.dataset.raDisplayMs, undefined);
  frames.shift()(); assert.equal(element.dataset.raDisplaySource, "server");
  assert.equal(element.dataset.raDisplayResultId, "new-result"); assert.equal(element.dataset.raVerifiedStatus, "ready"); controller.stop();
});

test("unchanged immutable summaries preserve metric DOM while job and failure status update", async () => {
  let next = payload(), html = "", writes = 0, details = null;
  const nodes = { status: { innerHTML: "" }, button: {}, job: { innerHTML: "" } };
  const element = host();
  Object.defineProperty(element, "innerHTML", { get: () => html, set(value) { html = value; writes++; details = { open: false }; } });
  element.querySelector = selector => selector === ".ra-status" ? nodes.status : selector === '[data-ra-action="status"]' ? nodes.button : selector === "[data-ra-job]" ? nodes.job : null;
  const controller = createController({ cache: createCache(), fetchJson: async () => { if (next instanceof Error) throw next; return next; } });
  await controller.mount(element, scope()); const original = details, before = writes; details.open = true;
  next = { ...payload(), job: { status: "running", scope: payload().scope } }; await controller.refresh(true);
  assert.equal(writes, before); assert.equal(details, original); assert.equal(details.open, true); assert.match(nodes.job.innerHTML, /처리 중/);
  next = Error("offline"); await controller.refresh(true);
  assert.equal(writes, before); assert.equal(details, original); assert.match(nodes.status.innerHTML, /마지막 정상 저장 결과/);
  next = payload(scope(), "new-result"); await controller.refresh(true);
  assert.equal(writes, before + 1); assert.notEqual(details, original); controller.stop();
});
