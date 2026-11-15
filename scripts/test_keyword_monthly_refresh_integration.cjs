"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs/promises"), path = require("node:path"), os = require("node:os"), crypto = require("node:crypto");
const { readCompletedKeywordEvidence, readStoredCollectionAdmission, holdActive, createKeywordMonthlyRefreshIntegration } = require("./lib/keyword_monthly_refresh_integration.cjs");
const at = "2026-10-30T10:00:00.000Z", hash = b => crypto.createHash("sha256").update(b).digest("hex");
async function fixture(t, { checkpoint = false } = {}) {
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
  // Reconciliation only checks this pointer's metadata. Full checkpoint-body
  // validation belongs to the independent worker/state tests.
  if (checkpoint) await write("keyword_monthly_incremental/source-current.json", { schemaVersion: 1, fixtureOnly: true });
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

test("secondary delta DB failures retain the existing failure gate instead of becoming an endless normal wait", async t => {
  for (const status of ["failed", "held", "queued", "running", "complete"]) await t.test(status, async st => {
    const f = await fixture(st); let callbacks, observed;
    const row = { runId: "run_1", scheduleOccurrenceId: f.intent.scheduleOccurrenceId, status, finishedAt: at, result: { sourceManifestSha256: f.intent.manifestSha256 } };
    const integration = createKeywordMonthlyRefreshIntegration({ dataDir: f.root, codeRoot: f.root, now: () => new Date(at), isCollectionIdle: () => true,
      readPostprocess: async () => row, readPostprocessList: async () => ({ items: [] }), allowsDerivedUpdates: () => true, runWork: async work => work(),
      createQueue: options => { callbacks = options; return { close: async () => {}, status: async () => ({}) }; },
      refresh: async options => { observed = await options.readDeltaEvidence("run_1"); return { status: "staged" }; } });
    try {
      if (["failed", "held"].includes(status)) await assert.rejects(callbacks.refresh({}, {}), { code: "KEYWORD_REFRESH_DB_NOT_COMPLETE" });
      else { await callbacks.refresh({}, {}); assert.equal(observed.status, status === "complete" ? "complete" : "waiting"); }
    } finally { await integration.close(); }
  });
});
test("current protections, pending work and unknown guards defer; expired hold remains history", async t => {
  const f = await fixture(t); assert.equal((await readStoredCollectionAdmission(f.root, at)).allowed, true);
  await f.write("collector/jobs.json", { version: 1, jobs: [], halted: null, reviewHold: { holdThrough: "2026-10-10" } });
  assert.equal((await readStoredCollectionAdmission(f.root, at)).allowed, true);
  for (const patch of [{ halted: { code: "NAVER_CAPTCHA" } }, { reviewHold: { holdThrough: "2026-10-30" } }, { reviewHold: false }, { reviewHold: 0 }, { reviewHold: "" }, { reviewHold: [] }, { reviewHold: { holdThrough: "unknown" } }, { reviewHold: { holdThrough: "2026-02-30" } }, { jobs: [{ id: "collector_00000000-0000-4000-8000-000000000001", status: "leased" }] }, { jobs: [{ id: "collector_00000000-0000-4000-8000-000000000001", status: "completed", leaseHash: "presence-only-never-output" }] }, { jobs: [{ id: "one", status: "completed" }] }, { jobs: [{ status: "mystery" }] }, { jobs: [{ id: "collector_00000000-0000-4000-8000-000000000001", status: "completed" }, { id: "collector_00000000-0000-4000-8000-000000000001", status: "completed" }] }, { halted: false }]) {
    await f.write("collector/jobs.json", { version: 1, jobs: [], halted: null, ...patch }); assert.equal((await readStoredCollectionAdmission(f.root, at)).allowed, false);
  }
  await fs.unlink(path.join(f.root, "collector/jobs.json")); assert.equal((await readStoredCollectionAdmission(f.root, at)).allowed, false);
  assert.equal(holdActive(null, "2026-10-30"), false);
});
test("fresh preparation receives an advancing clock callback rather than a frozen start timestamp", async t => {
  const f = await fixture(t); let callbacks, instant = Date.parse(at), observedClock;
  const integration = createKeywordMonthlyRefreshIntegration({ dataDir: f.root, codeRoot: f.root,
    now: () => new Date(instant), isCollectionIdle: () => true, readPostprocess: async () => null,
    readPostprocessList: async () => ({ items: [] }), allowsDerivedUpdates: () => true, runWork: async work => work(),
    createQueue: options => { callbacks = options; return { close: async () => {}, status: async () => ({}) }; },
    refresh: async options => { assert.equal(typeof options.now, "function"); assert.equal(options.mode, "live"); instant += 5000; observedClock = options.now(); return { status: "staged" }; }
  });
  assert.equal(callbacks.refreshVersion, "keyword-monthly-incremental-v3");
  await callbacks.refresh({}, {}); assert.equal(observedClock, "2026-10-30T10:00:05.000Z"); await integration.close();
});

test("a reused source receipt is historical metadata and never authorizes cleanup of its old pointer", async t => {
  const f = await fixture(t); let callbacks, refreshes = 0;
  const original = Object.freeze({ status: "published", pointerSha256: "a".repeat(64), generation: "b".repeat(32), repeatedSource: true, operatingPointerChanged: true });
  const integration = createKeywordMonthlyRefreshIntegration({ dataDir: f.root, codeRoot: f.root, now: () => new Date(at), isCollectionIdle: () => true,
    readPostprocess: async () => null, readPostprocessList: async () => ({ items: [] }), allowsDerivedUpdates: () => true, runWork: async work => work(),
    createQueue: options => { callbacks = options; return { close: async () => {}, status: async () => ({ status: "available" }) }; },
    refresh: async () => { refreshes++; return original; }
  }); t.after(() => integration.close());
  // There is deliberately no bundle/current.json. Any retention attempt would
  // fail and incorrectly create a new cleanup warning for a past publication.
  const value = await callbacks.refresh({}, {}); assert.equal(refreshes, 1); assert.equal(value.repeatedSource, true); assert.equal(value.operatingPointerChanged, false);
  assert.equal(value.pointerSha256, original.pointerSha256); assert.equal(original.operatingPointerChanged, true); assert.equal((await integration.status()).cleanup, null);
  await assert.rejects(fs.lstat(path.join(f.root, "keyword_monthly_analysis")), { code: "ENOENT" });
});

test("malformed optional reuse metadata fails before any cleanup or successful normalization", async t => {
  for (const invalid of [{ repeatedSource: "true" }, { repeatedSource: true, operatingPointerChanged: "true" }]) await t.test(JSON.stringify(invalid), async st => {
    const f = await fixture(st); let callbacks;
    const integration = createKeywordMonthlyRefreshIntegration({ dataDir: f.root, codeRoot: f.root, now: () => new Date(at), isCollectionIdle: () => true,
      readPostprocess: async () => null, readPostprocessList: async () => ({ items: [] }), allowsDerivedUpdates: () => true, runWork: async work => work(),
      createQueue: options => { callbacks = options; return { close: async () => {}, status: async () => ({}) }; },
      refresh: async () => ({ status: "published", pointerSha256: "a".repeat(64), ...invalid })
    }); st.after(() => integration.close());
    await assert.rejects(callbacks.refresh({}, {}), { code: "KEYWORD_REFRESH_RESULT_INVALID" }); assert.equal((await integration.status()).cleanup, null);
  });
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

test("incremental reconciliation preserves equal-finish postprocess order and future signals share its queue", async t => {
  const f = await fixture(t), signals = [], activatedAt = "2026-10-30T09:00:00.000Z"; let callbacks;
  for (const n of [2, 3]) await f.write(`outputs/run_${n}/manifest.json`, f.m);
  const integration = createKeywordMonthlyRefreshIntegration({ dataDir: f.root, codeRoot: f.root, readPostprocess: async () => null,
    readPostprocessList: async () => ({ items: [3, 2, 1].map(n => ({ runId: `run_${n}`, status: "complete", finishedAt: at, scheduleOccurrenceId: `rotation_2026-10-30_${n}` })) }),
    allowsDerivedUpdates: () => true, runWork: async work => work(),
    createQueue: options => { callbacks = options; return { enqueue: async value => { signals.push(value); return { status: "queued" }; }, status: async () => ({ activatedAt }), close: async () => {} }; }
  }); t.after(() => integration.close());
  await integration.reconcile(); assert.equal(callbacks.refreshVersion, "keyword-monthly-incremental-v3"); assert.deepEqual(signals.map(value => value.runId), ["run_3", "run_2", "run_1"]);
  const value = await integration.signalCompletedRun("run_1", { historyPayload: { keyword: f.m.keyword }, manifestSha256: f.intent.manifestSha256, scheduleOccurrenceId: f.intent.scheduleOccurrenceId });
  assert.equal(value.status, "queued"); assert.equal(signals.at(-1).runId, "run_1"); assert.equal(signals.at(-1).manifestSha256, f.intent.manifestSha256);
});

test("unsupported output namespaces report unknown cohort counts without activating any worker", async t => {
  const f = await fixture(t); let starts = 0;
  const integration = createKeywordMonthlyRefreshIntegration({ dataDir: f.root, codeRoot: f.root, outputsDir: path.join(f.root, "not-the-output-namespace"),
    readPostprocess: async () => null, readPostprocessList: async () => ({ items: [] }), allowsDerivedUpdates: () => true, runWork: async work => work(),
    createQueue: () => ({ start: async () => { starts++; }, close: async () => {}, status: async () => { throw Error("not called"); } })
  }); t.after(() => integration.close());
  const state = await integration.status(); assert.equal(state.status, "needs_verification"); assert.equal(state.errorCode, "KEYWORD_REFRESH_OUTPUT_NAMESPACE_UNSUPPORTED");
  for (const name of ["counts", "items", "currentVersionCounts", "historicalCountsByVersion", "currentVersionNeedsVerification", "historicalNeedsVerification"]) assert.equal(state[name], null);
  assert.equal(state.refreshVersion, "keyword-monthly-incremental-v3"); await integration.start(); assert.equal(starts, 0);
});

function completedMetadata(intent, patch = {}) {
  const normalized = { ...intent, scope: intent.scope ?? intent.keyword, scheduleOccurrenceId: intent.scheduleOccurrenceId ?? null, refreshVersion: intent.refreshVersion ?? "keyword-monthly-refresh-v1" };
  return { jobId: hash(JSON.stringify([normalized.refreshVersion, normalized.runId, normalized.manifestSha256, normalized.keyword, normalized.scope, normalized.scheduleOccurrenceId])),
    intent: normalized, status: "complete", finishedAt: at, result: { status: "published", pointerSha256: "a".repeat(64) }, ...patch };
}
function reconcileReader(f, items, overrides = {}) {
  const signals = [], statusCalls = [];
  const integration = createKeywordMonthlyRefreshIntegration({ dataDir: f.root, codeRoot: f.root,
    readPostprocess: async () => null, readPostprocessList: async () => ({ items: [{ runId: "run_1", status: "complete", finishedAt: at, scheduleOccurrenceId: f.intent.scheduleOccurrenceId }] }),
    allowsDerivedUpdates: () => true, runWork: async work => work(),
    createQueue: () => ({ enqueue: async value => { signals.push(value); return { status: "queued" }; }, close: async () => {},
      status: async options => { statusCalls.push(options); return { activatedAt: "2026-10-30T09:00:00.000Z", refreshVersion: "keyword-monthly-incremental-v3", status: "needs_verification", errorCode: null, items, ...overrides }; } })
  });
  return { integration, signals, statusCalls };
}

test("reconciliation skips only exact historical source events while retaining all 20 failed events in current order", async t => {
  const f = await fixture(t), items = [], completions = [], signals = [];
  for (let n = 1; n <= 72; n++) {
    if (n > 1) await f.write(`outputs/run_${n}/manifest.json`, f.m);
    const intent = { ...f.intent, runId: `run_${n}`, scheduleOccurrenceId: `rotation_2026-10-30_${n}` };
    items.push(completedMetadata(intent, n <= 52 ? {} : { status: "needs_verification", result: null }));
    completions.unshift({ runId: intent.runId, scheduleOccurrenceId: intent.scheduleOccurrenceId, status: "complete", finishedAt: at });
  }
  let bound;
  const integration = createKeywordMonthlyRefreshIntegration({ dataDir: f.root, codeRoot: f.root, readPostprocess: async () => null,
    readPostprocessList: async () => ({ items: completions }), allowsDerivedUpdates: () => true, runWork: async work => work(),
    createQueue: () => ({ close: async () => {}, enqueue: async value => signals.push(value), status: async options => { bound = options; return { activatedAt: "2026-10-30T09:00:00.000Z", refreshVersion: "keyword-monthly-incremental-v3", status: "needs_verification", errorCode: null, items }; } })
  }); t.after(() => integration.close());
  const originalMetadata = JSON.stringify(items); await integration.reconcile();
  assert.deepEqual(bound, { limit: 512 }); assert.deepEqual(signals.map(value => value.runId), Array.from({ length: 20 }, (_, i) => `run_${72 - i}`));
  assert.equal(JSON.stringify(items), originalMetadata); assert.equal(signals.length, 20);
});

test("prior completion optimization never guesses missing or changed source identity", async t => {
  const cases = [
    ["run", item => { item.intent.runId = "other_run"; }],
    ["manifest", item => { item.intent.manifestSha256 = "f".repeat(64); }],
    ["keyword", item => { item.intent.keyword = "경남 글램핑"; }],
    ["slot", item => { item.intent.scheduleOccurrenceId = "rotation_2026-10-30_5"; }],
    ["null_slot", item => { item.intent.scheduleOccurrenceId = null; }],
    ["missing_slot", item => { delete item.intent.scheduleOccurrenceId; }],
    ["scope", item => { item.intent.scope = "경남글램핑:2026-10"; }],
    ["missing_scope", item => { delete item.intent.scope; }],
    ["missing_version", item => { delete item.intent.refreshVersion; }],
    ["current_version_with_stale_job_hash", item => { item.intent.refreshVersion = "keyword-monthly-incremental-v3"; }],
    ["unknown_valid_version", item => { Object.assign(item, completedMetadata({ ...item.intent, refreshVersion: "keyword-monthly-refresh-v9" })); }],
    ["queued", item => { item.status = "queued"; }], ["running", item => { item.status = "running"; }],
    ["deferred", item => { item.status = "deferred"; }], ["needs_verification", item => { item.status = "needs_verification"; }],
    ["no_result", item => { item.result = null; }], ["unknown_result", item => { item.result.status = "unknown"; }],
    ["bad_pointer", item => { item.result.pointerSha256 = "unknown"; }], ["no_finish", item => { item.finishedAt = null; }],
    ["bad_job_identity", item => { item.jobId = "not-a-sha"; }]
  ];
  for (const [name, mutate] of cases) await t.test(name, async st => {
    const f = await fixture(st, { checkpoint: true }), item = completedMetadata(f.intent); mutate(item); const view = reconcileReader(f, [item]); st.after(() => view.integration.close());
    await view.integration.reconcile(); assert.equal(view.signals.length, 1); assert.deepEqual(view.signals[0], f.intent);
  });
});

test("unseen completions beyond the 512 item window or errored metadata use normal enqueue", async t => {
  for (const kind of ["outside_window", "missing_items", "unreadable_items", "status_error"]) await t.test(kind, async st => {
    const f = await fixture(st, { checkpoint: true }), target = completedMetadata(f.intent);
    let items = [target], overrides = {};
    if (kind === "outside_window") items = Array.from({ length: 512 }, (_, n) => completedMetadata({ ...f.intent, runId: `unrelated_run_${n}` }));
    if (kind === "missing_items") items = undefined;
    if (kind === "unreadable_items") items = null;
    if (kind === "status_error") overrides = { errorCode: "KEYWORD_REFRESH_JOURNAL_BOUND" };
    const view = reconcileReader(f, items, overrides); st.after(() => view.integration.close()); await view.integration.reconcile();
    assert.equal(view.signals.length, 1); assert.deepEqual(view.statusCalls, [{ limit: 512 }]);
  });
});

test("exact null occurrence and default keyword scope may reuse a validated prior completion", async t => {
  const f = await fixture(t, { checkpoint: true }); f.intent.scheduleOccurrenceId = null; const view = reconcileReader(f, [completedMetadata(f.intent)]); t.after(() => view.integration.close());
  await view.integration.reconcile(); assert.deepEqual(view.signals, []); assert.deepEqual(view.statusCalls, [{ limit: 512 }]);
});

for (const version of ["keyword-monthly-refresh-compressed-v2", "keyword-monthly-incremental-v3"]) test(`an existing checkpoint skips a valid ${version} completion`, async t => {
  const f = await fixture(t, { checkpoint: true }), completed = completedMetadata({ ...f.intent, refreshVersion: version });
  const before = JSON.stringify(completed), view = reconcileReader(f, [completed]); t.after(() => view.integration.close());
  await view.integration.reconcile(); assert.deepEqual(view.signals, []); assert.equal(JSON.stringify(completed), before);
  await assert.rejects(fs.access(path.join(f.root, "keyword_monthly_analysis")), { code: "ENOENT" });
});

test("missing checkpoint requests only the newest consumed completion for bootstrap and preserves activation", async t => {
  const f = await fixture(t), signals = [], activation = "2026-10-30T09:00:00.000Z";
  for (const n of [2, 3, 4]) await f.write(`outputs/run_${n}/manifest.json`, f.m);
  const versions = ["keyword-monthly-refresh-v1", "keyword-monthly-refresh-compressed-v2", "keyword-monthly-incremental-v3"];
  const items = [1, 2, 3].map((n, i) => completedMetadata({ ...f.intent, runId: `run_${n}`, scheduleOccurrenceId: null, refreshVersion: versions[i] }));
  const original = JSON.stringify(items), rows = [
    { runId: "run_1", status: "complete", finishedAt: "2026-10-30T09:30:00.000Z" },
    { runId: "run_3", status: "complete", finishedAt: "2026-10-30T10:00:00.000Z" },
    { runId: "run_2", status: "complete", finishedAt: "2026-10-30T10:05:00.000Z" },
    { runId: "run_4", status: "complete", finishedAt: "2026-10-30T08:59:59.000Z" }
  ];
  const integration = createKeywordMonthlyRefreshIntegration({ dataDir: f.root, codeRoot: f.root, readPostprocess: async () => null,
    readPostprocessList: async () => ({ items: rows }), allowsDerivedUpdates: () => true, runWork: async work => work(),
    createQueue: () => ({ close: async () => {}, enqueue: async intent => signals.push(intent), status: async () => ({ activatedAt: activation, items }) }) });
  t.after(() => integration.close());
  await integration.reconcile();
  assert.deepEqual(signals.map(intent => intent.runId), ["run_2"], "old completed cohorts are not replayed en masse to initialize one source checkpoint");
  assert.equal(JSON.stringify(items), original); assert.equal((await integration.status()).activatedAt, activation);
  await assert.rejects(fs.access(path.join(f.root, "keyword_monthly_incremental")), { code: "ENOENT" });
});

test("an existing checkpoint skips the real historical v1 journal without creating a v3 job or certifying a bundle", async t => {
  const f = await fixture(t, { checkpoint: true }), { createKeywordMonthlyRefresh } = require("./lib/keyword_monthly_refresh.cjs");
  const legacy = createKeywordMonthlyRefresh({ dataDir: f.root, now: () => new Date(at), readCompletedEvidence: async intent => ({ ...intent, status: "complete", quality: "complete", postprocessStatus: "complete" }),
    refresh: async () => ({ status: "published", pointerSha256: "a".repeat(64) }) });
  const job = await legacy.enqueue(f.intent); await legacy.runOnce(); await legacy.close();
  const file = path.join(legacy.directory, "jobs", job.jobId + ".json"), original = await fs.readFile(file);
  const integration = createKeywordMonthlyRefreshIntegration({ dataDir: f.root, codeRoot: f.root, now: () => new Date(at), readPostprocess: async () => null,
    readPostprocessList: async () => ({ items: [{ runId: f.intent.runId, scheduleOccurrenceId: f.intent.scheduleOccurrenceId, status: "complete", finishedAt: at }] }),
    allowsDerivedUpdates: () => true, runWork: async work => work() }); t.after(() => integration.close());
  await integration.reconcile(); assert.deepEqual(await fs.readFile(file), original); assert.deepEqual(await fs.readdir(path.dirname(file)), [job.jobId + ".json"]);
  const state = await integration.status(); assert.deepEqual(state.currentVersionCounts, {}); assert.deepEqual(state.historicalCountsByVersion["keyword-monthly-refresh-v1"], { complete: 1 }); assert.equal(state.cleanup, null);
  await assert.rejects(fs.lstat(path.join(f.root, "keyword_monthly_analysis")), { code: "ENOENT" });
});
