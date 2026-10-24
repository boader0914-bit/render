"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createIndustryAnalysisStore } = require("./lib/industry_analysis_store.cjs");
const { createIndustryAnalysisService } = require("./lib/industry_analysis.cjs");
const NOW = new Date("2030-05-12T00:00:00Z");
const SEP = { industry: "glamping", region: "all", month: "2030-03", cutoffDate: "2030-03-31" };
const OCT = { ...SEP, month: "2030-04", cutoffDate: "2030-04-30" };
const A = "a".repeat(64), B = "b".repeat(64);
const result = (request, sold) => ({ request, summary: { sold }, period: { monthClosed: true } });
async function temporary(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "industry-code-revision-"));
  t.after(async () => {
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
    await fs.rm(root, { recursive: true, force: true });
  });
  return root;
}
function storeAt(dataDir, options = {}) {
  return createIndustryAnalysisStore({ dataDir, now: () => NOW, autoStart: false,
    calculate: async request => result(request, 0),
    readSourceRevision: async () => ({ globalToken: "raw-inputs-stable", months: { "2030-03": "march", "2030-04": "april" } }), ...options });
}
async function seed(dataDir, options = {}, requests = [SEP]) {
  const store = storeAt(dataDir, options);
  for (const request of requests) await store.get(request);
  await store.drain(); await store.stop();
}

test("code-only upgrade keeps old results readable, invalidates all stored months, and preserves issued reports", async t => {
  const dataDir = await temporary(t);
  await seed(dataDir, { calculate: async request => result(request, 4) }, [SEP, OCT]);
  const queueFile = path.join(dataDir, "industry_analysis", "queue.json");
  const originalQueue = await fs.readFile(queueFile);
  const beforeQueue = JSON.parse(originalQueue);
  const originalKeys = Object.keys(beforeQueue.jobs).sort();
  const issued = path.join(dataDir, "monthly_reports", "mr_published.json");
  const issuedBytes = JSON.stringify({ status: "published", version: 1, snapshot: { sold: 4 } });
  await fs.mkdir(path.dirname(issued), { recursive: true }); await fs.writeFile(issued, issuedBytes);
  let calls = 0;
  const store = storeAt(dataDir, { calculationFingerprint: A, calculate: async request => result(request, ++calls + 10) });
  const saved = await store.readSaved(SEP);
  assert.equal(saved.storage.status, "stale"); assert.equal(saved.summary.sold, 4);
  assert.equal(saved.storage.sourceTokenMatches, false);
  assert.deepEqual(await fs.readFile(queueFile), originalQueue, "saved-only references never enqueue or rewrite the queue");
  await store.bootstrap();
  const pending = await store.get(SEP);
  assert.equal(pending.storage.status, "queued"); assert.equal(pending.storage.stale, true); assert.equal(pending.summary.sold, 4);
  assert.equal(pending.storage.key, saved.storage.key, "code change must not hide the previous result under a new key");
  await store.drain();
  assert.equal(calls, 2);
  assert.equal((await store.get(SEP)).storage.status, "ready");
  assert.equal((await store.get(OCT)).storage.status, "ready");
  assert.deepEqual(Object.keys(JSON.parse(await fs.readFile(queueFile, "utf8")).jobs).sort(), originalKeys);
  assert.equal((await fs.readdir(path.join(dataDir, "industry_analysis", "revisions"))).length, 2, "previous closed-month snapshots are retained");
  assert.equal(await fs.readFile(issued, "utf8"), issuedBytes);
  await store.stop();
});

test("identical code restart reuses snapshots and ordinary source changes still invalidate only their month", async t => {
  const dataDir = await temporary(t);
  let revision = { globalToken: "global", months: { "2030-03": "march", "2030-04": "april" } };
  const readSourceRevision = async () => structuredClone(revision);
  await seed(dataDir, { calculationFingerprint: A, readSourceRevision }, [SEP, OCT]);
  const calls = [];
  let store = storeAt(dataDir, { calculationFingerprint: A, readSourceRevision,
    calculate: async request => { calls.push(request.month); return result(request, 7); } });
  await store.bootstrap(); await store.drain(); assert.deepEqual(calls, []);
  assert.equal((await store.readSaved(SEP)).storage.status, "ready");
  revision.months["2030-04"] = "april-new-raw";
  await store.notifySourceChanged({ reason: "new_observation" }); await store.drain();
  assert.deepEqual(calls, ["2030-04"]);
  assert.equal((await store.readSaved(SEP)).summary.sold, 0);
  await store.stop();
  calls.length = 0;
  store = storeAt(dataDir, { calculationFingerprint: B, readSourceRevision,
    calculate: async request => { calls.push(request.month); return result(request, 8); } });
  await store.bootstrap(); await store.drain();
  assert.deepEqual(calls.sort(), ["2030-03", "2030-04"]);
  assert.deepEqual(revision, { globalToken: "global", months: { "2030-03": "march", "2030-04": "april-new-raw" } }, "code tokens never mutate the upstream source descriptor");
  await store.stop();
});

test("a code upgrade calculation failure preserves the exact previous result and a genuine zero", async t => {
  const dataDir = await temporary(t);
  await seed(dataDir, { calculationFingerprint: A });
  const resultDir = path.join(dataDir, "industry_analysis", "results");
  const [name] = await fs.readdir(resultDir), original = await fs.readFile(path.join(resultDir, name));
  const store = storeAt(dataDir, { calculationFingerprint: B,
    calculate: async () => { throw Object.assign(Error("saved evidence unavailable"), { code: "SAVED_INPUT_UNAVAILABLE" }); } });
  await store.bootstrap(); await store.drain();
  const failed = await store.get(SEP);
  assert.equal(failed.storage.status, "failed"); assert.equal(failed.storage.errorCode, "SAVED_INPUT_UNAVAILABLE");
  assert.equal(failed.storage.stale, true); assert.equal(failed.summary.sold, 0);
  assert.deepEqual(await fs.readFile(path.join(resultDir, name)), original);
  await store.stop();
});

test("legacy scalar source readers receive code invalidation without allowing malformed scoped evidence", async t => {
  const dataDir = await temporary(t);
  await seed(dataDir, { readSourceRevision: async () => "raw" });
  const store = storeAt(dataDir, { calculationFingerprint: A, readSourceRevision: async () => "raw" });
  assert.equal((await store.readSaved(SEP)).storage.status, "stale");
  await store.bootstrap(); await store.drain(); assert.equal((await store.readSaved(SEP)).storage.status, "ready");
  await store.stop();
  const invalid = storeAt(dataDir, { calculationFingerprint: B, readSourceRevision: async () => ({ globalToken: "raw", months: [] }) });
  assert.equal((await invalid.readSaved(SEP)).storage.errorCode, "INDUSTRY_SOURCE_REVISION_INVALID");
  await invalid.stop();
  assert.throws(() => storeAt(dataDir, { calculationFingerprint: "not-a-code-hash" }), /fingerprint/);
});

test("the industry service passes its configured calculator fingerprint to durable storage", async t => {
  const dataDir = await temporary(t);
  assert.throws(() => createIndustryAnalysisService({ dataDir, sources: {}, calculationFingerprint: "invalid" }), /fingerprint/);
});
