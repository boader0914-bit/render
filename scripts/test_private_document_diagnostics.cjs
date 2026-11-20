"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { createPrivateDocumentDiagnostics } = require("./lib/private_document_diagnostics.cjs");
const gate = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
test("trace entropy failure or invalid diagnostic IDs never prevent serving", async () => {
  for (const createTraceId of [() => { throw Error("private entropy failure"); }, () => "private-invalid-id"]) {
    const d = createPrivateDocumentDiagnostics({ createTraceId, onLog: null }), headers = {};
    assert.equal(await d.run("/admin", async t => { t.response({ setHeader: (k,v) => { headers[k] = v; } }, 200); return 42; }), 42);
    assert.equal(d.status().recent[0].traceId, null); assert.equal(headers["X-Document-Trace"], undefined);
    assert.equal(d.status().observerErrors, 1); assert.ok(!JSON.stringify(d.status()).includes("private"));
  }
});

test("document spans and headers measure request-owned preparation without retaining HTML or paths", async () => {
  let at = 0; const logs = [], d = createPrivateDocumentDiagnostics({ now: () => at, onLog: r => logs.push(r) }), headers = {};
  const expected = { result: "private document body" };
  assert.equal(await d.run("/admin", async t => {
    const html = await t.measure("html_read", async () => { at += 5; return "private document body"; });
    await t.measure("html_versions", async () => { at += 7; t.assets({ assetCount: 44, digestReads: 1, digestBytes: 64, digestWorkMs: 7, raw: html, path: "/secret" }); });
    t.response({ setHeader: (k,v) => { headers[k] = v; } }, 200); return expected;
  }), expected);
  assert.match(headers["X-Document-Trace"], /^[a-f0-9]{24}$/);
  assert.equal(headers["Server-Timing"], "html_read;dur=5, html_versions;dur=7, header_ready;dur=12");
  const r = d.status().recent[0]; assert.equal(r.elapsedMs, 12); assert.equal(r.headerReadyMs, 12);
  assert.deepEqual(r.assets, { assetCount: 44, digestReads: 1, digestBytes: 64, digestWorkMs: 7 });
  assert.ok(!JSON.stringify({ r, logs }).includes("private")); assert.ok(!JSON.stringify(r).includes("secret"));
});

test("concurrent documents keep their own asset observations and opaque traces", async () => {
  const d = createPrivateDocumentDiagnostics({ onLog: null }), hold = gate();
  const first = d.run("/admin", async t => { t.assets({ assetCount: 44, digestReads: 2 }); await hold.promise; return 1; });
  assert.equal(await d.run("/b2b", async t => { t.assets({ assetCount: 3, digestReads: 0, digestSharedFlights: 1 }); return 2; }), 2);
  hold.resolve(); assert.equal(await first, 1);
  const rows = d.status().recent; assert.equal(rows.length, 2); assert.notEqual(rows[0].traceId, rows[1].traceId);
  assert.equal(rows[0].route, "b2b"); assert.equal(rows[0].assets.assetCount, 3); assert.equal(rows[1].assets.assetCount, 44);
  assert.equal(rows[0].assets.digestReads, 0); assert.equal(rows[1].assets.digestReads, 2);
});

test("observer failures, getters, invalid numbers, and private routes do not change serving results", async () => {
  let invoked = 0; const payload = { assetCount: 3, digestReadMs: Infinity, digestWorkMs: -1, digestHashMs: NaN };
  Object.defineProperty(payload, "digestBytes", { get() { invoked++; throw Error("secret"); } });
  const d = createPrivateDocumentDiagnostics({ now: () => { throw Error("private clock"); }, onLog: () => { throw Error("private logger"); } });
  assert.equal(await d.run("/private?token=private", async t => {
    t.assets(payload); t.response({ setHeader() { throw Error("private header"); } }, 200);
    return t.measure("html_read", async () => 17);
  }), 17);
  assert.equal(invoked, 0); const r = d.status().recent[0]; assert.equal(r.route, "unknown"); assert.equal(r.elapsedMs, null);
  assert.deepEqual(r.assets, { assetCount: 3 }); assert.ok(!JSON.stringify(r).includes("private"));
});

test("bounded logs and retention are detached snapshots, including failed document operations", async () => {
  const logs = [], d = createPrivateDocumentDiagnostics({ now: () => 1, maxRecords: 2, maxLogsPerMinute: 1, onLog: r => { logs.push(r); r.assets.assetCount = 999; } });
  const sentinel = Error("private filesystem details");
  for (let i = 0; i < 3; i++) await d.run("/admin", async t => { t.assets({ assetCount: i }); });
  await assert.rejects(d.run("/admin", async () => { throw sentinel; }), error => error === sentinel);
  const s = d.status(); assert.equal(s.recent.length, 2); assert.equal(s.started, 4); assert.equal(s.finished, 4);
  assert.equal(logs.length, 1); assert.equal(s.droppedLogs, 3); assert.equal(s.recent[1].outcome, "failed");
  s.recent[0].assets.assetCount = 999; assert.equal(d.status().recent[0].assets.assetCount, 2);
  assert.ok(!JSON.stringify(d.status()).includes("private"));
});
