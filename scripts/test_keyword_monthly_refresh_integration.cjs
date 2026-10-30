"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs/promises"), path = require("node:path"), os = require("node:os"), crypto = require("node:crypto");
const { readCompletedKeywordEvidence, readStoredCollectionAdmission, holdActive, createKeywordMonthlyRefreshIntegration } = require("./lib/keyword_monthly_refresh_integration.cjs");
const at = "2026-10-30T10:00:00.000Z", hash = b => crypto.createHash("sha256").update(b).digest("hex");
async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "monthly-refresh-integration-")));
  const temporaryParent = await fs.realpath(os.tmpdir());
  assert.equal(path.dirname(root), temporaryParent); assert.match(path.basename(root), /^monthly-refresh-integration-/);
  t.after(async () => { assert.equal(await fs.realpath(root), root); assert.equal(path.dirname(root), temporaryParent); await fs.rm(root, { recursive: true, force: true }); });
  const write = async (name, value) => { const file = path.join(root, name); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, JSON.stringify(value)); };
  await write("collector/jobs.json", { version: 1, jobs: [], halted: null });
  await write("collector-scheduled/jobs.json", { version: 1, jobs: [], halted: null });
  await write("collector-web/state.json", { version: 1, active: null, halted: null });
  const m = { keyword: "경남글램핑", checkIn: "2026-10-30", checkOut: "2026-10-31", bookingRangeDays: 21, searchMode: "keyword", collectionQuality: { status: "complete" } };
  await write("outputs/run_1/manifest.json", m); const manifestSha256 = hash(await fs.readFile(path.join(root, "outputs/run_1/manifest.json")));
  return { root, write, m, intent: { runId: "run_1", keyword: m.keyword, manifestSha256, scheduleOccurrenceId: "rotation_2026-10-30_4" } };
}
test("exact source and same durable DB completion are both required", async t => {
  const f = await fixture(t), completed = { runId: "run_1", scheduleOccurrenceId: f.intent.scheduleOccurrenceId, status: "complete", finishedAt: at, result: { sourceManifestSha256: f.intent.manifestSha256 } };
  const args = { dataDir: f.root, intent: f.intent, readPostprocess: async () => completed, allowsDerivedUpdates: () => true };
  const evidence = await readCompletedKeywordEvidence(args); assert.equal(evidence.postprocessStatus, "complete"); assert.equal(evidence.bookingRangeDays, 21);
  assert.equal((await readCompletedKeywordEvidence({ ...args, readPostprocess: async () => ({ ...completed, status: "running" }) })).status, "waiting");
  await assert.rejects(readCompletedKeywordEvidence({ ...args, readPostprocess: async () => ({ ...completed, scheduleOccurrenceId: "other" }) }), { code: "KEYWORD_REFRESH_DB_IDENTITY_CHANGED" });
  await assert.rejects(readCompletedKeywordEvidence({ ...args, intent: { ...f.intent, manifestSha256: "0".repeat(64) } }), { code: "KEYWORD_REFRESH_COMPLETED_EVIDENCE_CHANGED" });
  await assert.rejects(readCompletedKeywordEvidence({ ...args, readPostprocess: async () => ({ ...completed, status: "failed" }) }), { code: "KEYWORD_REFRESH_DB_NOT_COMPLETE" });
  await assert.rejects(readCompletedKeywordEvidence({ ...args, readPostprocess: async () => ({ ...completed, result: {} }) }), { code: "KEYWORD_REFRESH_DB_MANIFEST_HASH_UNKNOWN" });
  await assert.rejects(readCompletedKeywordEvidence({ ...args, readPostprocess: async () => ({ ...completed, result: { sourceManifestSha256: "f".repeat(64) } }) }), { code: "KEYWORD_REFRESH_DB_MANIFEST_HASH_CHANGED" });
});
test("partial, company-mode, changed source and traversal cannot trigger refresh", async t => {
  const f = await fixture(t), read = async () => ({ runId: "run_1", scheduleOccurrenceId: f.intent.scheduleOccurrenceId, status: "complete", finishedAt: at });
  const call = intent => readCompletedKeywordEvidence({ dataDir: f.root, intent, readPostprocess: read, allowsDerivedUpdates: () => true });
  for (const patch of [{ collectionQuality: { status: "partial" } }, { searchMode: "company" }]) {
    await f.write("outputs/run_1/manifest.json", { ...f.m, ...patch }); const bytes = await fs.readFile(path.join(f.root, "outputs/run_1/manifest.json"));
    await assert.rejects(call({ ...f.intent, manifestSha256: hash(bytes) }), e => /^KEYWORD_REFRESH_/.test(e.code));
  }
  await assert.rejects(call({ ...f.intent, runId: "../other" }), { code: "KEYWORD_REFRESH_INPUT_INVALID" });
});
test("current protections, pending work and unknown guards defer; expired hold remains history", async t => {
  const f = await fixture(t); assert.equal((await readStoredCollectionAdmission(f.root, at)).allowed, true);
  await f.write("collector/jobs.json", { version: 1, jobs: [], halted: null, reviewHold: { holdThrough: "2026-10-10" } });
  assert.equal((await readStoredCollectionAdmission(f.root, at)).allowed, true);
  for (const patch of [{ halted: { code: "NAVER_CAPTCHA" } }, { reviewHold: { holdThrough: "2026-10-30" } }, { reviewHold: { holdThrough: "unknown" } }, { reviewHold: { holdThrough: "2026-02-30" } }, { jobs: [{ status: "leased" }] }, { jobs: [{ status: "mystery" }] }, { halted: false }]) {
    await f.write("collector/jobs.json", { version: 1, jobs: [], halted: null, ...patch }); assert.equal((await readStoredCollectionAdmission(f.root, at)).allowed, false);
  }
  await fs.unlink(path.join(f.root, "collector/jobs.json")); assert.equal((await readStoredCollectionAdmission(f.root, at)).allowed, false);
  assert.equal(holdActive(null, "2026-10-30"), false);
});
test("a failed independent enqueue cannot fail the original postprocess caller", async t => {
  const f = await fixture(t), logs = [];
  const integration = createKeywordMonthlyRefreshIntegration({ dataDir: f.root, codeRoot: f.root,
    readPostprocess: async () => null, readPostprocessList: async () => ({ items: [] }), allowsDerivedUpdates: () => true,
    runWork: async work => work(), createQueue: () => ({ enqueue: async () => { throw Error("do not expose raw detail"); }, status: async () => ({}), close: async () => {} }),
    logger: { error: (...x) => logs.push(x) } });
  const result = await integration.signalCompletedRun("run_1", { historyPayload: { keyword: f.m.keyword }, manifestSha256: f.intent.manifestSha256 });
  assert.equal(result.status, "needs_verification"); assert.equal(logs[0][1], "KEYWORD_REFRESH_INTEGRATION_UNAVAILABLE"); await integration.close();
});
test("reconciliation ignores historical records and only signals newly completed keyword runs", async t => {
  const f = await fixture(t), signals = [], activatedAt = "2026-10-30T09:00:00.000Z";
  const integration = createKeywordMonthlyRefreshIntegration({ dataDir: f.root, codeRoot: f.root,
    readPostprocess: async () => null, readPostprocessList: async () => ({ items: [
      { runId: "old", status: "complete", finishedAt: "2026-10-29T09:00:00.000Z" },
      { runId: "pending", status: "running", finishedAt: null },
      { runId: "run_1", status: "complete", finishedAt: at, scheduleOccurrenceId: f.intent.scheduleOccurrenceId }
    ] }), allowsDerivedUpdates: () => true, runWork: async work => work(),
    createQueue: () => ({ enqueue: async x => signals.push(x), status: async () => ({ activatedAt }), close: async () => {} }) });
  await integration.reconcile(); assert.equal(signals.length, 1); assert.deepEqual(signals[0], f.intent); await integration.close();
});
