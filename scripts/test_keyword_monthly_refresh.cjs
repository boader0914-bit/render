"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs/promises"), path = require("node:path"), os = require("node:os"), crypto = require("node:crypto");
const { createKeywordMonthlyRefresh } = require("./lib/keyword_monthly_refresh.cjs");
const intent = (n = 1, extra = {}) => ({ runId: "fresh_run_" + n, keyword: "경남글램핑", manifestSha256: String(n % 10).repeat(64), scheduleOccurrenceId: "rotation_2026-10-31_" + n, ...extra });
const proof = i => ({ ...i, status: "complete", quality: "complete", postprocessStatus: "complete" });
const digest = b => crypto.createHash("sha256").update(b).digest("hex");
const published = { status: "published", generation: "a".repeat(32), pointerSha256: "b".repeat(64), scopeCount: 3, providerCalls: 0, networkAttempted: false };
async function fixture(t, options = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "keyword-refresh-test-")); let time = Date.parse("2026-10-31T01:00:00.000Z");
  const q = createKeywordMonthlyRefresh({ dataDir, readCompletedEvidence: async i => proof(i), refresh: async () => published, now: () => new Date(time), ...options });
  t.after(async () => { await q.close(); await fs.rm(dataDir, { recursive: true, force: true }); });
  return { q, dataDir, advance: ms => { time += ms; }, now: () => new Date(time) };
}

test("cold GET status does not mkdir, recover, enqueue or start work", async t => {
  let calls = 0; const f = await fixture(t, { readCompletedEvidence: async () => { calls++; }, refresh: async () => { calls++; } });
  const result = await f.q.status(); assert.equal(result.status, "available"); assert.equal(result.readOnly, true); assert.equal(result.initialized, false); assert.deepEqual(result.items, []); assert.equal(calls, 0);
  await assert.rejects(fs.lstat(path.join(f.dataDir, "keyword_monthly_refresh")), { code: "ENOENT" });
});

test("activation is durable once and cold status cannot backdate or reactivate it", async t => {
  const f = await fixture(t), first = f.now().toISOString(); await f.q.start(); const a = path.join(f.q.directory, "activation.json");
  assert.equal((await f.q.status()).activatedAt, first); const bytes = await fs.readFile(a); await f.q.close(); f.advance(86400000);
  const resumed = createKeywordMonthlyRefresh({ dataDir: f.dataDir, now: f.now, readCompletedEvidence: async i => proof(i), refresh: async () => published }); t.after(() => resumed.close());
  assert.equal((await resumed.status()).activatedAt, first); assert.equal(digest(await fs.readFile(a)), digest(bytes)); await resumed.start(); assert.equal((await resumed.status()).activatedAt, first); assert.equal(digest(await fs.readFile(a)), digest(bytes));
});

test("object admission preserves a controlled guard reason without clearing protection", async t => {
  let calls = 0, allowed = false; const f = await fixture(t, { canProcess: async () => ({ allowed, reasonCode: "COLLECTOR_REVIEW_HOLD_ACTIVE" }), readCompletedEvidence: async i => { calls++; return proof(i); } });
  await f.q.enqueue(intent()); const held = await f.q.runOnce(); assert.equal(held.status, "deferred"); assert.equal(held.reasonCode, "COLLECTOR_REVIEW_HOLD_ACTIVE"); assert.equal(calls, 0);
  allowed = true; f.advance(2001); assert.equal((await f.q.runOnce()).status, "complete"); assert.equal(calls, 1);
});

test("late reconciliation can safely revalidate and recover a failed independent enqueue", async t => {
  let diskFailed = true; const injectedFs = { ...fs, open: async (file, ...rest) => { if (diskFailed && typeof file === "string" && file.endsWith(".tmp")) throw Object.assign(Error(), { code: "ENOSPC" }); return fs.open(file, ...rest); } };
  const f = await fixture(t, { fileSystem: injectedFs }); const failed = await f.q.enqueue(intent()); assert.equal(failed.status, "needs_verification"); assert.equal(failed.errorCode, "ENOSPC"); assert.equal(failed.collectionPostprocessUnaffected, true);
  diskFailed = false; const late = await f.q.enqueue(intent()); assert.equal(late.status, "queued"); assert.equal((await f.q.runOnce()).status, "complete"); assert.equal((await f.q.enqueue(intent())).status, "complete");
});

test("late and concurrent repeated same-run signals refresh exactly once", async t => {
  let refreshes = 0; const f = await fixture(t, { refresh: async () => { refreshes++; return published; } });
  const signals = await Promise.all(Array.from({ length: 12 }, () => f.q.enqueue(intent())));
  assert.equal(new Set(signals.map(x => x.jobId)).size, 1); assert.ok(signals.every(x => x.status === "queued"));
  const runs = await Promise.all(Array.from({ length: 8 }, () => f.q.runOnce())); assert.ok(runs.every(x => x.status === "complete"));
  assert.equal(refreshes, 1); assert.equal((await f.q.enqueue(intent())).status, "complete"); assert.equal(await f.q.runOnce(), null); assert.equal(refreshes, 1);
  const state = await f.q.status(); assert.deepEqual(state.counts, { complete: 1 }); assert.equal(state.items[0].attempts, 1); assert.equal(state.items[0].result.providerCalls, 0);
});

test("run manifest, scope and calculation version form distinct durable identities", async t => {
  const f = await fixture(t); const a = await f.q.enqueue(intent()), b = await f.q.enqueue(intent(1, { manifestSha256: "e".repeat(64) })), c = await f.q.enqueue(intent(1, { scope: "경남글램핑:2026-10" }));
  assert.equal(new Set([a.jobId, b.jobId, c.jobId]).size, 3);
  const v2 = createKeywordMonthlyRefresh({ dataDir: f.dataDir, refreshVersion: "keyword-monthly-refresh-v2", readCompletedEvidence: async i => proof(i), refresh: async () => published }); t.after(() => v2.close());
  const d = await v2.enqueue(intent()); assert.notEqual(d.jobId, a.jobId);
});

test("collection complete before durable DB postprocess complete defers without refreshing", async t => {
  let ready = false, count = 0; const f = await fixture(t, { readCompletedEvidence: async i => ({ ...proof(i), postprocessStatus: ready ? "complete" : "running" }), refresh: async () => { count++; return published; } });
  await f.q.enqueue(intent()); const waiting = await f.q.runOnce(); assert.equal(waiting.status, "deferred"); assert.equal(waiting.reasonCode, "KEYWORD_REFRESH_POSTPROCESS_NOT_COMPLETE"); assert.equal(waiting.attempts, 0); assert.equal(count, 0);
  ready = true; f.advance(2001); assert.equal((await f.q.runOnce()).status, "complete"); assert.equal(count, 1);
});

test("background admission and unknown evidence do not become success or zero", async t => {
  let admitted = false, reads = 0; const f = await fixture(t, { canProcess: async () => admitted, readCompletedEvidence: async () => { reads++; return null; } });
  await f.q.enqueue(intent()); const a = await f.q.runOnce(); assert.equal(a.status, "deferred"); assert.equal(a.reasonCode, "KEYWORD_REFRESH_BACKGROUND_DEFERRED"); assert.equal(reads, 0);
  admitted = true; f.advance(2001); const b = await f.q.runOnce(); assert.equal(b.reasonCode, "KEYWORD_REFRESH_POSTPROCESS_NOT_COMPLETE"); assert.equal(b.result, null); assert.equal(reads, 1);
});

test("an older unfinished DB receipt cannot starve a later verified collection", async t => {
  const f = await fixture(t, { readCompletedEvidence: async i => i.runId === "fresh_run_1" ? { pending: true } : proof(i) });
  await f.q.enqueue(intent()); f.advance(1); await f.q.enqueue(intent(2)); assert.equal((await f.q.runOnce()).reasonCode, "KEYWORD_REFRESH_POSTPROCESS_NOT_COMPLETE");
  f.advance(2001); const later = await f.q.runOnce(); assert.equal(later.intent.runId, "fresh_run_2"); assert.equal(later.status, "complete");
});

test("wrong same-run/manifest/keyword/schedule evidence is held independently", async t => {
  for (const field of ["runId", "manifestSha256", "keyword", "scheduleOccurrenceId"]) await t.test(field, async st => {
    let refreshed = false; const f = await fixture(st, { readCompletedEvidence: async i => ({ ...proof(i), [field]: "wrong" }), refresh: async () => { refreshed = true; return published; } });
    await f.q.enqueue(intent()); const r = await f.q.runOnce(); assert.equal(r.status, "needs_verification"); assert.equal(r.reasonCode, "KEYWORD_REFRESH_EVIDENCE_MISMATCH"); assert.equal(refreshed, false); assert.equal(r.attempts, 0);
  });
});

test("partial, reused, failed and incomplete quality never overwrite prior bundle", async t => {
  for (const status of ["partial", "reused", "failed", "complete"]) await t.test(status, async st => {
    let called = false; const f = await fixture(st, { readCompletedEvidence: async i => ({ ...proof(i), status, quality: status === "complete" ? "partial" : "complete" }), refresh: async () => { called = true; } });
    const oldBundle = path.join(f.dataDir, "old-bundle.json"), body = Buffer.from('{"generation":"saved-good"}'); await fs.writeFile(oldBundle, body);
    await f.q.enqueue(intent()); const r = await f.q.runOnce(); assert.equal(r.status, "needs_verification"); assert.equal(r.reasonCode, "KEYWORD_REFRESH_COMPLETION_NOT_VERIFIED"); assert.equal(called, false); assert.equal(digest(await fs.readFile(oldBundle)), digest(body));
  });
});

test("refresh error never rejects completion path, touches DB/history/protection or starts a provider", async t => {
  const f = await fixture(t, { refresh: async () => { throw Object.assign(Error("private error text not persisted"), { code: "KEYWORD_MONTHLY_SOURCE_CHANGED" }); } });
  const sentinels = ["collection-rotation.sqlite", "observations.jsonl", "protection.json", "kosis.json"]; for (const n of sentinels) await fs.writeFile(path.join(f.dataDir, n), "original-" + n);
  await f.q.enqueue(intent()); const r = await f.q.runOnce(); assert.equal(r.status, "needs_verification"); assert.equal(r.reasonCode, "KEYWORD_MONTHLY_SOURCE_CHANGED"); assert.equal(await f.q.runOnce(), null);
  assert.equal((await f.q.status()).status, "needs_verification"); assert.equal((await f.q.status()).unresolvedNeedsVerification, 1);
  for (const n of sentinels) assert.equal(await fs.readFile(path.join(f.dataDir, n), "utf8"), "original-" + n);
  const files = await fs.readdir(path.join(f.q.directory, "jobs")); assert.equal(files.length, 1); assert.ok(!(await fs.readFile(path.join(f.q.directory, "jobs", files[0]), "utf8")).includes("private error text"));
});

test("only explicitly retryable derived errors retry with finite backoff", async t => {
  let count = 0; const f = await fixture(t, { maxAttempts: 2, retryBaseMs: 5000, refresh: async () => { count++; throw Object.assign(Error(), { code: "KEYWORD_MONTHLY_SOURCE_CHANGED", retryable: true }); } });
  await f.q.enqueue(intent()); const first = await f.q.runOnce(); assert.equal(first.status, "deferred"); assert.equal(first.attempts, 1); assert.equal(await f.q.runOnce(), null);
  f.advance(5001); const second = await f.q.runOnce(); assert.equal(second.status, "needs_verification"); assert.equal(second.attempts, 2); assert.equal(count, 2); f.advance(1000000); assert.equal(await f.q.runOnce(), null);
});

test("runner re-admission deferral does not consume attempts or become verification failure", async t => {
  let busy = true, calls = 0; const f = await fixture(t, { maxAttempts: 1, refresh: async () => { calls++; if (busy) throw Object.assign(Error(), { code: "KEYWORD_REFRESH_COLLECTION_BUSY", deferred: true }); return published; } });
  await f.q.enqueue(intent()); const waiting = await f.q.runOnce(); assert.equal(waiting.status, "deferred"); assert.equal(waiting.attempts, 0); assert.equal(waiting.startedAt, null); assert.equal(waiting.reasonCode, "KEYWORD_REFRESH_COLLECTION_BUSY");
  assert.equal(await f.q.runOnce(), null); busy = false; f.advance(2001); const success = await f.q.runOnce(); assert.equal(success.status, "complete"); assert.equal(success.attempts, 1); assert.equal(calls, 2);
});

test("a deferred flag cannot override uncertain pointer publication", async t => {
  const f = await fixture(t, { refresh: async () => { throw Object.assign(Error(), { code: "KEYWORD_MONTHLY_BUNDLE_PUBLICATION_NEEDS_READBACK", publicationState: "pointer_was_promoted_verify_current", deferred: true }); } });
  await f.q.enqueue(intent()); const result = await f.q.runOnce(); assert.equal(result.status, "needs_verification"); assert.equal(result.attempts, 1); f.advance(999999); assert.equal(await f.q.runOnce(), null);
});

test("old admission deferral timing cannot bypass later retry backoff", async t => {
  let admitted = false, calls = 0; const f = await fixture(t, { canProcess: async () => admitted, retryBaseMs: 10000, refresh: async () => { calls++; throw Object.assign(Error(), { code: "KEYWORD_MONTHLY_SOURCE_CHANGED", retryable: true }); } });
  await f.q.enqueue(intent()); await f.q.runOnce(); admitted = true; f.advance(2001); assert.equal((await f.q.runOnce()).attempts, 1); assert.equal(calls, 1); assert.equal(await f.q.runOnce(), null); f.advance(10001); assert.equal((await f.q.runOnce()).attempts, 2);
});

test("uncertain pointer promotion or lock conflict cannot blind retry", async t => {
  for (const code of ["KEYWORD_MONTHLY_BUNDLE_PUBLICATION_NEEDS_READBACK", "KEYWORD_MONTHLY_BUNDLE_POINTER_CONFLICT", "KEYWORD_MONTHLY_BUNDLE_PUBLICATION_LOCKED"]) await t.test(code, async st => {
    let count = 0; const f = await fixture(st, { refresh: async () => { count++; throw Object.assign(Error(), { code, retryable: true }); } });
    await f.q.enqueue(intent()); const result = await f.q.runOnce(); assert.equal(result.status, "needs_verification"); f.advance(9999999); assert.equal(await f.q.runOnce(), null); assert.equal(count, 1);
  });
});

test("cold status preserves a crashed running record; worker recovery reconciles idempotently", async t => {
  const f = await fixture(t), original = await f.q.enqueue(intent()); const file = path.join(f.q.directory, "jobs", original.jobId + ".json");
  const row = JSON.parse(await fs.readFile(file, "utf8")); Object.assign(row, { status: "running", attempts: 1, startedAt: f.now().toISOString(), nextAttemptAt: null }); await fs.writeFile(file, JSON.stringify(row)); await f.q.close();
  let count = 0; const resumed = createKeywordMonthlyRefresh({ dataDir: f.dataDir, now: f.now, readCompletedEvidence: async i => proof(i), refresh: async (e, i, context) => { count++; assert.equal(context.attempt, 2); assert.ok(context.recoveredAt); return { ...published, status: "unchanged" }; } }); t.after(() => resumed.close());
  const before = digest(await fs.readFile(file)); assert.equal((await resumed.status()).items[0].status, "running"); assert.equal(digest(await fs.readFile(file)), before);
  const completed = await resumed.runOnce(); assert.equal(completed.status, "complete"); assert.equal(completed.result.status, "unchanged"); assert.equal(count, 1);
  assert.equal((await resumed.enqueue(intent())).status, "complete"); assert.equal(await resumed.runOnce(), null);
});

test("exhausted interrupted work is needs_verification instead of a fresh retry", async t => {
  const f = await fixture(t, { maxAttempts: 1 }), original = await f.q.enqueue(intent()), file = path.join(f.q.directory, "jobs", original.jobId + ".json");
  const row = JSON.parse(await fs.readFile(file, "utf8")); Object.assign(row, { status: "running", attempts: 1, startedAt: f.now().toISOString(), nextAttemptAt: null }); await fs.writeFile(file, JSON.stringify(row)); await f.q.close();
  let called = false; const resumed = createKeywordMonthlyRefresh({ dataDir: f.dataDir, now: f.now, readCompletedEvidence: async i => proof(i), refresh: async () => { called = true; } }); t.after(() => resumed.close());
  assert.equal(await resumed.runOnce(), null); const result = (await resumed.status()).items[0]; assert.equal(result.status, "needs_verification"); assert.equal(result.reasonCode, "KEYWORD_REFRESH_INTERRUPTED_EXHAUSTED"); assert.equal(called, false);
});

test("pending/journal bounds fail closed but repeated existing intent stays deduplicated", async t => {
  const f = await fixture(t, { maxRecords: 2, maxPending: 1 }); const a = await f.q.enqueue(intent()); const b = await f.q.enqueue(intent(2));
  assert.equal(b.status, "needs_verification"); assert.equal(b.errorCode, "KEYWORD_REFRESH_QUEUE_FULL"); assert.equal(b.collectionPostprocessUnaffected, true); assert.equal((await f.q.enqueue(intent())).jobId, a.jobId);
  await f.q.runOnce(); assert.equal((await f.q.enqueue(intent(2))).status, "queued"); await f.q.runOnce(); assert.equal((await f.q.enqueue(intent(3))).errorCode, "KEYWORD_REFRESH_QUEUE_FULL");
});

test("invalid intent/secret-shaped extras do not escape enqueue or create files", async t => {
  const f = await fixture(t);
  for (const bad of [{ ...intent(), runId: "../bad" }, { ...intent(), keyword: "bad\nkeyword" }, { ...intent(), manifestSha256: "wrong" }, { ...intent(), token: "must-not-persist" }, { ...intent(), scope: " " }]) {
    const r = await f.q.enqueue(bad); assert.equal(r.status, "needs_verification"); assert.equal(r.collectionPostprocessUnaffected, true);
  }
  await assert.rejects(fs.lstat(f.q.directory), { code: "ENOENT" });
});

test("symlink/junction journal directory is rejected without reading/writing target", async t => {
  const f = await fixture(t), other = await fs.mkdtemp(path.join(os.tmpdir(), "keyword-refresh-outside-")); t.after(() => fs.rm(other, { recursive: true, force: true }));
  await fs.writeFile(path.join(other, "keep"), "unchanged"); await fs.symlink(other, f.q.directory, process.platform === "win32" ? "junction" : "dir");
  assert.equal((await f.q.status()).status, "needs_verification"); const r = await f.q.enqueue(intent()); assert.equal(r.status, "needs_verification"); assert.equal(r.errorCode, "KEYWORD_REFRESH_UNSAFE_PATH"); assert.deepEqual(await fs.readdir(other), ["keep"]);
});

test("unsafe hardlinked record and corrupt journal never reset to empty success", async t => {
  const f = await fixture(t), job = await f.q.enqueue(intent()), file = path.join(f.q.directory, "jobs", job.jobId + ".json"); await f.q.close();
  const second = path.join(f.dataDir, "alias.json"); await fs.link(file, second);
  const q2 = createKeywordMonthlyRefresh({ dataDir: f.dataDir, readCompletedEvidence: async i => proof(i), refresh: async () => published }); t.after(() => q2.close());
  const s = await q2.status(); assert.equal(s.status, "needs_verification"); assert.equal(s.items, null); assert.equal(s.counts, null); assert.equal((await q2.enqueue(intent())).status, "needs_verification");
});

test("refresh results persist only whitelisted bounded metadata and reject provider use", async t => {
  const f = await fixture(t, { refresh: async () => ({ ...published, originalRows: [{ token: "never persist" }], password: "never persist" }) });
  await f.q.enqueue(intent()); const r = await f.q.runOnce(); assert.equal(r.status, "complete"); assert.equal(r.result.originalRows, undefined); assert.equal(r.result.password, undefined);
  const bad = await fixture(t, { refresh: async () => ({ ...published, providerCalls: 1 }) }); await bad.q.enqueue(intent()); const failed = await bad.q.runOnce(); assert.equal(failed.status, "needs_verification"); assert.equal(failed.reasonCode, "KEYWORD_REFRESH_RESULT_INVALID");
});

test("one scheduled worker is started explicitly and closes without further work", async t => {
  const scheduled = [], cleared = []; let count = 0; const f = await fixture(t, { setTimeoutImpl: fn => { const h = { fn, unref() {} }; scheduled.push(h); return h; }, clearTimeoutImpl: h => cleared.push(h), refresh: async () => { count++; return published; } });
  await f.q.enqueue(intent()); assert.equal(scheduled.length, 0); await f.q.start(); assert.equal(scheduled.length, 1); scheduled[0].fn(); await f.q.runOnce(); assert.equal(count, 1); await f.q.close(); assert.ok(cleared.length >= 1); assert.equal((await f.q.enqueue(intent(2))).errorCode, "KEYWORD_REFRESH_CLOSED");
});
