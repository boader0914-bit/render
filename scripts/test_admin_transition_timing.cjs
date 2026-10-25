"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const { test } = require("node:test");
const source = fs.readFileSync(path.join(__dirname, "../web/admin-transition-timing.js"), "utf8");

function fixture({ raf = true, cancel = true, performance = true } = {}) {
  let now = 1000, wall = 1700000001000, nextFrame = 0;
  const frames = new Map(), roles = new Set(["role-admin"]);
  const element = () => ({ dataset: {}, hidden: false, isConnected: true, rects: 1, getClientRects() { return Array(this.rects).fill({}); }, getAttribute() { return null; } });
  const main = element(), document = { visibilityState: "visible", body: { classList: { contains: name => roles.has(name) } }, getElementById: name => name === "appMain" ? main : null };
  const context = { module: { exports: {} }, document, Date: { now: () => wall },
    getComputedStyle: target => target.computedStyle || { display: "block", visibility: "visible", opacity: "1" } };
  if (performance) context.performance = { now: () => now, timeOrigin: wall - now };
  if (raf) context.requestAnimationFrame = callback => { const id = ++nextFrame; frames.set(id, callback); return id; };
  if (cancel) context.cancelAnimationFrame = id => frames.delete(id);
  vm.createContext(context); vm.runInContext(source, context);
  return { api: context.module.exports, context, main, document, roles, frames,
    advance(ms) { now += ms; wall += ms; }, wall(value) { wall = value; }, monotonic(value) { now = value; },
    frame(ms = 16) { now += ms; wall += ms; const entry = frames.entries().next().value; assert.ok(entry, "a frame must be pending"); frames.delete(entry[0]); entry[1](now); },
    token(values = {}) { return context.module.exports.begin({ tab: "admin", section: "overview", source: "primary:summary", ...values }); } };
}

test("each destination records handler, synchronous DOM work and two-frame readiness separately", () => {
  const f = fixture(), token = f.token({ inputTimeStamp: 988 });
  assert.equal(Object.isFrozen(token), true);
  assert.equal(f.main.dataset.appTransitionDestination, "admin:overview");
  assert.equal(f.main.dataset.appTransitionStatus, "pending");
  assert.equal(f.main.dataset.appTransitionStartedAt, "1700000001000");
  assert.equal(f.main.dataset.appTransitionInputWaitMs, "12");
  assert.equal(f.main.dataset.appTransitionSyncMs, undefined);
  assert.equal(f.main.dataset.appTransitionDisplayMs, undefined);
  f.advance(7); assert.equal(f.api.rendered(token, { isCurrent: () => true }), true);
  assert.equal(f.main.dataset.appTransitionSyncMs, "7");
  f.frame(); assert.equal(f.main.dataset.appTransitionStatus, "pending");
  assert.equal(f.main.dataset.appTransitionDisplayMs, undefined);
  f.frame(); assert.equal(f.main.dataset.appTransitionStatus, "ready");
  assert.equal(f.main.dataset.appTransitionDisplayMs, "39");
  assert.equal(f.main.dataset.appTransitionSeq, String(token.seq));
});

test("a later navigation clears old timings immediately and an obsolete token cannot complete it", () => {
  const f = fixture(), first = f.token(); f.api.rendered(first); f.frame();
  const next = f.token({ section: "database" });
  assert.ok(next.seq > first.seq); assert.equal(f.main.dataset.appTransitionDestination, "admin:database");
  assert.equal(f.main.dataset.appTransitionSyncMs, undefined); assert.equal(f.main.dataset.appTransitionDisplayMs, undefined);
  assert.equal(f.api.rendered(first), false); assert.equal(f.main.dataset.appTransitionStatus, "pending");
  f.api.rendered(next); f.frame(); f.frame();
  assert.equal(f.main.dataset.appTransitionStatus, "ready"); assert.equal(f.main.dataset.appTransitionSeq, String(next.seq));
});

test("explicit invalidation and delayed callbacks never certify an abandoned screen", () => {
  const f = fixture({ cancel: false }), token = f.token(); f.api.rendered(token);
  f.api.invalidate(); assert.equal(f.main.dataset.appTransitionStatus, "invalidated");
  f.frame(); assert.equal(f.main.dataset.appTransitionStatus, "invalidated");
  assert.equal(f.main.dataset.appTransitionDisplayMs, undefined); assert.equal(f.api.rendered(token), false);
});

test("the current-destination callback is checked again after both frames", () => {
  const f = fixture(); let current = true;
  const token = f.token(); f.api.rendered(token, { isCurrent: () => current }); f.frame(); current = false; f.frame();
  assert.equal(f.main.dataset.appTransitionStatus, "invalidated"); assert.equal(f.main.dataset.appTransitionDisplayMs, undefined);
});

test("role changes invalidate pending display timing even without a new navigation token", () => {
  const f = fixture(), token = f.token(); f.api.rendered(token); f.frame();
  f.roles.delete("role-admin"); f.roles.add("role-b2b"); f.frame();
  assert.equal(f.main.dataset.appTransitionStatus, "invalidated"); assert.equal(f.main.dataset.appTransitionDisplayMs, undefined);
});

test("a hidden document, hidden target or caller visibility failure cannot become ready", () => {
  for (const hide of [f => { f.document.visibilityState = "hidden"; }, f => { f.main.hidden = true; }, f => { f.main.rects = 0; }, f => { f.main.isConnected = false; },
    f => { f.main.computedStyle = { display: "none" }; }, f => { f.main.computedStyle = { visibility: "hidden" }; },
    f => { f.main.computedStyle = { visibility: "collapse" }; }, f => { f.main.computedStyle = { opacity: "0" }; }]) {
    const f = fixture(), token = f.token(); f.api.rendered(token); f.frame(); hide(f); f.frame();
    assert.equal(f.main.dataset.appTransitionStatus, "hidden"); assert.equal(f.main.dataset.appTransitionDisplayMs, undefined);
  }
  const f = fixture(), token = f.token();
  assert.equal(f.api.rendered(token, { isVisible: () => false }), false);
  assert.equal(f.main.dataset.appTransitionStatus, "hidden"); assert.equal(f.frames.size, 0);
});

test("replacing appMain while a transition waits invalidates the old element measurement", () => {
  const f = fixture(), token = f.token(); f.api.rendered(token); f.frame();
  f.document.getElementById = () => ({ dataset: {}, getClientRects: () => [{}] }); f.frame();
  assert.equal(f.main.dataset.appTransitionStatus, "invalidated"); assert.equal(f.main.dataset.appTransitionDisplayMs, undefined);
});

test("waiting and application-error results remain distinct from a ready transition", () => {
  for (const status of ["waiting", "error"]) {
    const f = fixture(), token = f.token(); f.api.rendered(token, { status }); f.frame(); f.frame();
    assert.equal(f.main.dataset.appTransitionStatus, status);
    assert.equal(f.main.dataset.appTransitionSyncMs, "0"); assert.equal(f.main.dataset.appTransitionDisplayMs, "32");
  }
});

test("a waiting DB can complete later under the same token without restarting the navigation clock", () => {
  const f = fixture(), token = f.token({ section: "database" });
  f.advance(4); f.api.rendered(token, { status: "waiting" }); f.frame(); f.frame();
  assert.equal(f.main.dataset.appTransitionStatus, "waiting"); assert.equal(f.main.dataset.appTransitionDisplayMs, "36");
  f.advance(64); assert.equal(f.api.rendered(token, { status: "ready" }), true);
  assert.equal(f.main.dataset.appTransitionStatus, "pending"); assert.equal(f.main.dataset.appTransitionDisplayMs, undefined);
  assert.equal(f.main.dataset.appTransitionSyncMs, "100"); f.frame(); f.frame();
  assert.equal(f.main.dataset.appTransitionStatus, "ready"); assert.equal(f.main.dataset.appTransitionDisplayMs, "132");
  assert.equal(f.main.dataset.appTransitionSeq, String(token.seq)); assert.equal(f.main.dataset.appTransitionStartedAt, "1700000001000");
  assert.equal(f.api.rendered(token), false, "a completed result cannot later rewrite the measurement");
});

test("navigation away while a waiting DB loads prevents its late completion from becoming ready", () => {
  const f = fixture(), token = f.token(); f.api.rendered(token, { status: "waiting" }); f.frame(); f.frame();
  f.api.invalidate(); assert.equal(f.api.rendered(token, { status: "ready" }), false);
  assert.equal(f.main.dataset.appTransitionStatus, "invalidated"); assert.equal(f.main.dataset.appTransitionDisplayMs, undefined);
  assert.equal(f.frames.size, 0);
});

test("missing frame support records synchronous work without fabricating display timing", () => {
  const f = fixture({ raf: false }), token = f.token();
  assert.equal(f.api.rendered(token), false);
  assert.equal(f.main.dataset.appTransitionStatus, "unavailable");
  assert.equal(f.main.dataset.appTransitionSyncMs, "0"); assert.equal(f.main.dataset.appTransitionDisplayMs, undefined);
});

test("callback and scheduling failures become safe error diagnostics without thrown data", () => {
  for (const options of [{ isCurrent() { throw new Error("private detail"); } }, { isVisible() { throw new Error("private detail"); } }]) {
    const f = fixture(), token = f.token();
    assert.doesNotThrow(() => f.api.rendered(token, options)); assert.equal(f.main.dataset.appTransitionStatus, "error");
    assert.equal(f.main.dataset.appTransitionDisplayMs, undefined); assert.ok(!JSON.stringify(f.main.dataset).includes("private detail"));
  }
  const f = fixture(); f.context.requestAnimationFrame = () => { throw new Error("private frame detail"); };
  assert.doesNotThrow(() => f.api.rendered(f.token())); assert.equal(f.main.dataset.appTransitionStatus, "error");
  assert.equal(f.main.dataset.appTransitionDisplayMs, undefined);
});

test("a callback failure in a later animation frame is an error rather than a ready display", () => {
  const f = fixture(); let fail = false;
  const token = f.token(); f.api.rendered(token, { isCurrent() { if (fail) throw new Error("private detail"); return true; } });
  f.frame(); fail = true;
  assert.doesNotThrow(() => f.frame()); assert.equal(f.main.dataset.appTransitionStatus, "error");
  assert.equal(f.main.dataset.appTransitionDisplayMs, undefined);
});

test("invalid status and callback arguments cannot silently certify a ready transition", () => {
  for (const options of [{ status: "complete" }, { isCurrent: false }, { isVisible: null }]) {
    const f = fixture(); assert.equal(f.api.rendered(f.token(), options), false);
    assert.equal(f.main.dataset.appTransitionStatus, "error"); assert.equal(f.main.dataset.appTransitionDisplayMs, undefined);
    assert.equal(f.frames.size, 0);
  }
});

test("input wait accepts verified relative or epoch clocks and omits invalid values", () => {
  for (const [input, expected] of [[1000, "0"], [995, "5"], [1700000000990, "10"], [1001, undefined], [0, "1000"], [-1, undefined], [NaN, undefined], [Infinity, undefined], ["995", undefined], [1700000001001, undefined], [1699999000000, undefined]]) {
    const f = fixture(); f.token({ inputTimeStamp: input }); assert.equal(f.main.dataset.appTransitionInputWaitMs, expected, String(input));
  }
  const f = fixture(); f.context.performance.timeOrigin += 50000; f.token({ inputTimeStamp: 995 });
  assert.equal(f.main.dataset.appTransitionInputWaitMs, undefined, "a relative clock with a mismatched origin is not certified");
  f.token({ inputTimeStamp: 1700000000990 }); assert.equal(f.main.dataset.appTransitionInputWaitMs, "10");
});

test("real zero durations remain zero while missing or reversed clocks never become zero successes", () => {
  const zero = fixture(), token = zero.token(); zero.api.rendered(token); zero.frame(0); zero.frame(0);
  assert.equal(zero.main.dataset.appTransitionSyncMs, "0"); assert.equal(zero.main.dataset.appTransitionDisplayMs, "0");
  const bad = fixture(); const old = bad.token(); bad.monotonic(900); bad.api.rendered(old);
  assert.equal(bad.main.dataset.appTransitionStatus, "error"); assert.equal(bad.main.dataset.appTransitionSyncMs, undefined);
  const none = fixture({ performance: false }); none.context.Date.now = () => NaN;
  none.api.rendered(none.token()); assert.equal(none.main.dataset.appTransitionStatus, "error");
  assert.equal(none.main.dataset.appTransitionStartedAt, undefined); assert.equal(none.main.dataset.appTransitionDisplayMs, undefined);
  const epochMissing = fixture(); epochMissing.context.Date.now = () => NaN;
  epochMissing.api.rendered(epochMissing.token());
  assert.equal(epochMissing.main.dataset.appTransitionStatus, "error", "a required start timestamp cannot be fabricated from a missing clock");
  assert.equal(epochMissing.main.dataset.appTransitionStartedAt, undefined);
});

test("wall-clock duration fallback stays honest when a monotonic clock is absent", () => {
  const f = fixture({ performance: false }), token = f.token({ inputTimeStamp: 1700000000995 });
  f.advance(9); f.api.rendered(token); f.frame(); f.frame();
  assert.equal(f.main.dataset.appTransitionSyncMs, "9"); assert.equal(f.main.dataset.appTransitionDisplayMs, "41");
  assert.equal(f.main.dataset.appTransitionInputWaitMs, "5");
});

test("rapid navigation retains only one frame request and uses two frames of the newest result", () => {
  const f = fixture({ cancel: false }); let last;
  for (let i = 0; i < 1000; i++) { last = f.token(); f.api.rendered(last); assert.equal(f.frames.size, 1); }
  f.frame(); assert.equal(f.main.dataset.appTransitionStatus, "pending"); assert.equal(f.frames.size, 1);
  f.frame(); assert.equal(f.main.dataset.appTransitionStatus, "ready"); assert.equal(f.frames.size, 0);
  assert.equal(f.main.dataset.appTransitionSeq, String(last.seq));
});

test("absent targets and invalid destinations cannot break application navigation", () => {
  const f = fixture(); f.document.getElementById = () => null;
  assert.doesNotThrow(() => f.api.rendered(f.token())); assert.equal(f.frames.size, 0);
  const next = fixture(); const token = next.token({ tab: "bad destination" });
  assert.equal(next.main.dataset.appTransitionStatus, "error"); assert.equal(next.api.rendered(token), false);
  assert.equal(next.main.dataset.appTransitionDisplayMs, undefined);
});

test("malformed instrumentation arguments are contained rather than interrupting app handlers", () => {
  const f = fixture(); assert.doesNotThrow(() => f.api.begin(null));
  assert.equal(f.main.dataset.appTransitionStatus, "error");
  const token = f.token(); assert.doesNotThrow(() => f.api.rendered(token, null));
  assert.equal(f.main.dataset.appTransitionStatus, "error");
  const next = f.token();
  assert.doesNotThrow(() => f.api.rendered(next, { get status() { throw new Error("private argument"); } }));
  assert.equal(f.main.dataset.appTransitionStatus, "error");
  assert.equal(f.main.dataset.appTransitionDisplayMs, undefined); assert.equal(f.frames.size, 0);
});

test("whole-navigation timing waits for real saved data and two frames, including time before a transition handler", () => {
  const f = fixture(); let saved = false;
  const options = { hasSavedMonth: () => saved, isCurrent: () => true, isVisible: () => true };
  assert.equal(f.api.navigationRendered(options), false); assert.equal(f.main.dataset.appNavigationDisplayMs, undefined); assert.equal(f.frames.size, 0);
  f.advance(2000); saved = true;
  assert.equal(f.api.navigationRendered(options), true); assert.equal(f.main.dataset.appNavigationDisplayMs, undefined);
  f.frame(); assert.equal(f.main.dataset.appNavigationDisplayMs, undefined);
  f.frame(); assert.equal(f.main.dataset.appNavigationDisplayMs, "3032"); assert.equal(f.main.dataset.appNavigationStatus, "ready");
  const recorded = f.main.dataset.appNavigationDisplayMs; f.advance(500);
  const token = f.token({ section: "database" }); f.api.rendered(token); f.frame(); f.frame();
  assert.equal(f.api.navigationRendered(options), false); assert.equal(f.main.dataset.appNavigationDisplayMs, recorded, "later redraws and transition tokens cannot reset the whole-document measurement");
});

test("whole-navigation timing rejects hidden, abandoned, role-changed or no-longer-saved displays", () => {
  for (const change of [f => { f.document.visibilityState = "hidden"; }, f => { f.main.hidden = true; }, f => { f.main.rects = 0; }, f => { f.roles.delete("role-admin"); }]) {
    const f = fixture(); f.api.navigationRendered({ hasSavedMonth: () => true, isCurrent: () => true, isVisible: () => true });
    f.frame(); change(f); f.frame(); assert.equal(f.main.dataset.appNavigationDisplayMs, undefined); assert.equal(f.main.dataset.appNavigationStatus, "invalidated");
  }
  for (const field of ["saved", "current", "visible"]) {
    const f = fixture(), valid = { saved: true, current: true, visible: true };
    f.api.navigationRendered({ hasSavedMonth: () => valid.saved, isCurrent: () => valid.current, isVisible: () => valid.visible });
    f.frame(); valid[field] = false; f.frame(); assert.equal(f.main.dataset.appNavigationDisplayMs, undefined);
  }
});

test("whole-navigation timing never fabricates a zero without a document navigation clock or frame support", () => {
  for (const settings of [{ performance: false }, { raf: false }]) {
    const f = fixture(settings);
    f.api.navigationRendered({ hasSavedMonth: () => true, isCurrent: () => true, isVisible: () => true });
    if (settings.raf !== false) { f.frame(); f.frame(); }
    assert.equal(f.main.dataset.appNavigationDisplayMs, undefined); assert.equal(f.main.dataset.appNavigationStatus, "unavailable");
  }
});

test("navigation stages buffer only two early numbers and expose them only after the fresh initial-route guard", () => {
  const f = fixture();
  assert.equal(f.api.markNavigationStage("scriptReady"), true); f.advance(15);
  assert.equal(f.api.markNavigationStage("sessionStart"), true); f.advance(25);
  assert.equal(f.api.markNavigationStage("sessionReady"), false); assert.deepEqual(f.main.dataset, {});
  assert.equal(f.api.configureNavigationStages({ companyId: "private-company", isCurrent: () => false }), false); assert.deepEqual(f.main.dataset, {});
  assert.equal(f.api.configureNavigationStages({ companyId: "private-company", isCurrent: () => true }), true);
  assert.equal(f.main.dataset.appNavigationScriptReadyMs, "1000"); assert.equal(f.main.dataset.appNavigationSessionStartMs, "1015");
  assert.equal(f.api.markNavigationStage("sessionReady"), true); assert.equal(f.main.dataset.appNavigationSessionReadyMs, "1040");
  f.advance(80); assert.equal(f.api.markNavigationStage("scriptReady"), false); assert.equal(f.main.dataset.appNavigationScriptReadyMs, "1000");
  for (const name of ["private-company", "csrfToken", "savedParsed", null, {}, Symbol("private")]) assert.equal(f.api.markNavigationStage(name), false);
  assert.doesNotMatch(JSON.stringify(f.main.dataset), /private|csrf|token|companyId|sessionId/);
  assert.ok(Object.values(f.main.dataset).every(value => /^\d+(?:\.\d)?$/.test(value)));
});

test("initial saved stages require exact current company, request month and sequence and cannot describe a later refresh", () => {
  const f = fixture(); assert.equal(f.api.configureNavigationStages({ companyId: "initial-company", isCurrent: () => true }), true);
  const args = { companyId: "initial-company", month: "2026-09", sequence: 1, isCurrent: () => true };
  assert.equal(f.api.markNavigationCompanyStage("savedParsed", args), false);
  assert.equal(f.api.markNavigationCompanyStage("savedFetchStart", { ...args, companyId: "other-company" }), false);
  assert.equal(f.api.markNavigationCompanyStage("savedFetchStart", args), true); f.advance(20);
  for (const changed of [{ month: "2026-08" }, { sequence: 2 }, { companyId: "other-company" }, { isCurrent: () => false }]) {
    assert.equal(f.api.markNavigationCompanyStage("savedParsed", { ...args, ...changed }), false);
  }
  assert.equal(f.api.markNavigationCompanyStage("savedRendered", args), false);
  assert.equal(f.api.markNavigationCompanyStage("savedParsed", args), true); f.advance(11);
  assert.equal(f.api.markNavigationCompanyStage("savedRendered", args), true);
  assert.equal(f.main.dataset.appNavigationSavedFetchStartMs, "1000"); assert.equal(f.main.dataset.appNavigationSavedParsedMs, "1020");
  assert.equal(f.main.dataset.appNavigationSavedRenderedMs, "1031");
  assert.equal(f.api.markNavigationCompanyStage("savedFetchStart", { ...args, sequence: 2 }), false);
  assert.equal(f.api.markNavigationCompanyStage("savedRendered", args), false); assert.doesNotMatch(JSON.stringify(f.main.dataset), /initial-company|2026-09/);
});

test("stale initial scope, role or target cannot publish successful later stages", () => {
  for (const change of [f => { f.current = false; }, f => { f.roles.delete("role-admin"); }, f => { f.document.getElementById = () => ({ dataset: {} }); }]) {
    const f = fixture(); f.current = true;
    f.api.configureNavigationStages({ companyId: "initial-company", isCurrent: () => f.current }); f.api.markNavigationStage("bootstrapStart");
    change(f); assert.equal(f.api.markNavigationStage("bootstrapParsed"), false);
    assert.equal(f.api.markNavigationCompanyStage("savedFetchStart", { companyId: "initial-company", month: "", sequence: 1, isCurrent: () => true }), false);
    assert.equal(f.main.dataset.appNavigationBootstrapParsedMs, undefined);
  }
});

test("missing clocks and malformed stage options never fabricate zero or interrupt the application", () => {
  const f = fixture({ performance: false }); assert.equal(f.api.markNavigationStage("scriptReady"), false);
  f.api.configureNavigationStages({ companyId: "initial-company", isCurrent: () => true });
  assert.equal(f.api.markNavigationStage("sessionReady"), false); assert.deepEqual(f.main.dataset, {});
  const fresh = fixture(); assert.doesNotThrow(() => fresh.api.configureNavigationStages(null));
  assert.doesNotThrow(() => fresh.api.configureNavigationStages({ get companyId() { throw Error("private"); } }));
  fresh.api.configureNavigationStages({ companyId: "initial-company", isCurrent: () => true });
  assert.doesNotThrow(() => fresh.api.markNavigationCompanyStage("savedFetchStart", { get companyId() { throw Error("private"); } }));
  assert.deepEqual(fresh.main.dataset, {});
});
