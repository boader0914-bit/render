"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createMonthlyReportService } = require("./lib/monthly_reports.cjs");

const copy = value => JSON.parse(JSON.stringify(value));
const request = { type: "region", targetId: "region-a", month: "2026-09", cutoffDate: "2026-09-30" };
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
};

function storedSources(month, sold = 2) {
  const runId = `saved-${month}`;
  const collectedAt = `${month}-01T00:00:00Z`;
  return {
    companies: [
      { companyId: "company-a", primaryName: "검수 업체 A", regionKey: "region-a", regionLabel: "지역 A", capacity: 16 },
      { companyId: "company-b", primaryName: "검수 업체 B", regionKey: "region-b", regionLabel: "지역 B", capacity: 10 }
    ],
    regions: [{ id: "region-a", label: "지역 A" }, { id: "region-b", label: "지역 B" }],
    runs: [{ id: runId, collectedAt, keyword: "저장 키워드", collectionQuality: { status: "complete" } }],
    observations: ["company-a", "company-b"].map(companyId => ({ companyId, runId, collectedAt,
      stayDate: `${month}-02`, productType: "lodging", inventoryEvidenceVersion: 4,
      supply: companyId === "company-a" ? 16 : 10, sold, publicBookings: 1, phoneBookings: sold - 1,
      estimatedRevenue: sold * 100000, publicRevenue: 100000, phoneRevenue: (sold - 1) * 100000,
      sharedDayUseExcluded: 0, explicitBlockedBookings: 0 })),
    rankObservations: [], context: { sources: [], warnings: [], networkAttempted: false }
  };
}

async function fixture(t, { cached = true } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "monthly-materialization-"));
  t.after(async () => {
    const resolved = path.resolve(directory);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith("monthly-materialization-"));
    await fs.rm(resolved, { recursive: true, force: true });
  });
  const state = {
    now: "2026-10-16T02:00:00Z", revision: "source-r1", sold: 2, contextVersion: 1,
    evaluationVersion: 1, sourceCalls: [], revisionCalls: [], contextCalls: [], evaluationCalls: [],
    loadBehavior: null, revisionBehavior: null, contextBehavior: null, evaluationBehavior: null
  };
  const loadSources = async (input, options) => {
    state.sourceCalls.push({ request: copy(input), options: copy(options || {}) });
    if (state.loadBehavior) await state.loadBehavior(input, options);
    return storedSources(input.month, state.sold);
  };
  const readSourceRevision = async input => {
    state.revisionCalls.push(copy(input));
    return state.revisionBehavior ? state.revisionBehavior(input) : state.revision;
  };
  const readReportContext = async (input, roster) => {
    state.contextCalls.push({ request: copy(input), roster: copy(roster) });
    if (state.contextBehavior) return state.contextBehavior(input, roster);
    return { sources: [{ id: `local-context-${state.contextVersion}` }], warnings: [], networkAttempted: false };
  };
  const readOutlookEvaluations = async (input, roster, options) => {
    state.evaluationCalls.push({ request: copy(input), roster: copy(roster), options: copy(options) });
    if (state.evaluationBehavior) return state.evaluationBehavior(input, roster, options);
    return { status: "pending", version: state.evaluationVersion, networkAttempted: false,
      regions: [{ regionKey: input.targetId, rows: [{ actualValue: null }] }] };
  };
  const make = (options = {}) => createMonthlyReportService({ dataDir: directory, loadSources,
    ...(cached ? { readSourceRevision } : {}), readReportContext, readOutlookEvaluations,
    now: () => new Date(state.now), ...options });
  return { directory, state, make, service: make() };
}

function snapshotOnly(preview) {
  const { previewToken, generation, ...snapshot } = preview;
  return snapshot;
}

async function calculationFiles(directory) {
  const root = path.join(directory, "calculations");
  let names;
  try { names = await fs.readdir(root); } catch (error) { if (error.code === "ENOENT") return []; throw error; }
  return Promise.all(names.filter(name => /^[a-f0-9]{64}\.json$/.test(name)).sort().map(async name => ({
    name, content: await fs.readFile(path.join(root, name), "utf8")
  })));
}

test("saved attachment readers overlap and receive only freshly inspected source revision", async t => {
  const f = await fixture(t), contextStarted = deferred(), releaseContext = deferred();
  const evaluationStarted = deferred(), industryStarted = deferred(), seen = [];
  const service = f.make({
    readReportContext: async () => { contextStarted.resolve(); await releaseContext.promise; return { sources: [], warnings: [], networkAttempted: false }; },
    readOutlookEvaluations: async () => { evaluationStarted.resolve(); return { networkAttempted: false }; },
    readIndustryContext: async (input, roster, options) => { seen.push(options); industryStarted.resolve(); return { networkAttempted: false, entries: [] }; }
  });
  const preview = service.preview({ ...request, sourceRevision: "browser-forged-revision" });
  await contextStarted.promise;
  // A sequential implementation cannot reach these readers until released.
  await Promise.all([evaluationStarted.promise, industryStarted.promise]);
  assert.equal(seen[0].sourceRevision, f.state.revision);
  releaseContext.resolve();
  const value = await preview;
  assert.equal(value.context.networkAttempted, false);
  assert.ok(value.generation.timings.previewTotalMs >= value.generation.timings.snapshotSerializationMs);
  assert.ok(value.generation.snapshotBytes > 0);
});

test("same conditions reuse saved monthly calculations across service recreation with detached results", async t => {
  const { directory, state, service, make } = await fixture(t);
  const first = await service.preview(request);
  assert.equal(first.generation.cacheStatus, "calculated");
  assert.equal(first.generation.storage, "saved");
  assert.equal(state.sourceCalls.length, 2);
  assert.equal(first.summary.lodging.sold, 2);
  assert.equal((await calculationFiles(directory)).length, 1);
  first.summary.lodging.sold = 999;
  first.context.sources[0].id = "caller-mutation";
  first.companies[0].daily[1].lodging.sold = 999;

  const second = await service.preview(request);
  assert.equal(second.generation.cacheStatus, "reused");
  assert.equal(second.summary.lodging.sold, 2);
  assert.equal(second.companies[0].daily[1].lodging.sold, 2);
  assert.equal(second.context.sources[0].id, "local-context-1");
  assert.equal(state.sourceCalls.length, 2);
  assert.notEqual(second.previewToken, first.previewToken);
  assert.equal(second.generation.calculatedAt, first.generation.calculatedAt);

  const restarted = await make().preview(request);
  assert.equal(restarted.generation.cacheStatus, "reused");
  assert.equal(state.sourceCalls.length, 2, "disk reuse survives loss of the service's in-memory maps");
  assert.equal(restarted.summary.lodging.sold, 2);
  assert.equal(restarted.generation.calculatedAt, first.generation.calculatedAt);
  assert.deepEqual(await service.list(), [], "derived calculations never appear as saved reports");
});

test("source revision, cutoff, target, month and calculation version keep both monthly sources isolated", async t => {
  const { state, service, make } = await fixture(t);
  await service.preview(request);
  let expectedCalls = 2;
  const recalculate = async (input, activeService = service) => {
    const start = state.sourceCalls.length;
    const result = await activeService.preview(input);
    expectedCalls += 2;
    assert.equal(result.generation.cacheStatus, "calculated");
    assert.equal(state.sourceCalls.length, expectedCalls);
    assert.equal(state.sourceCalls.slice(start).length, 2);
    assert.equal(state.sourceCalls[start].request.month, input.month);
    assert.equal(state.sourceCalls[start].request.cutoffDate, input.cutoffDate);
    assert.equal(state.sourceCalls[start + 1].request.month, result.comparison.previousMonth);
    return result;
  };
  state.revision = "source-r2"; state.sold = 3;
  const changed = await recalculate(request);
  assert.equal(changed.summary.lodging.sold, 3);
  const cutoff = await recalculate({ ...request, cutoffDate: "2026-09-15" });
  assert.equal(cutoff.comparison.previousCutoffDate, "2026-08-15", "comparison uses the shifted cutoff rather than the previous month end");
  const target = await recalculate({ ...request, targetId: "region-b" });
  assert.equal(target.companies[0].companyId, "company-b");
  await recalculate({ ...request, month: "2026-08", cutoffDate: "2026-08-31" });
  await recalculate(request, make({ calculationVersion: "monthly-test-next" }));
});

test("concurrent identical previews share current and previous reads but have independent approval tokens", async t => {
  const { state, service } = await fixture(t);
  const started = deferred(), release = deferred();
  let gated = false;
  state.loadBehavior = async input => {
    if (!gated && input.month === request.month) { gated = true; started.resolve(); await release.promise; }
  };
  const previews = [service.preview(request), service.preview(request), service.preview(request)];
  await started.promise;
  release.resolve();
  const results = await Promise.all(previews);
  assert.equal(state.sourceCalls.filter(call => call.request.month === "2026-09").length, 1);
  assert.equal(state.sourceCalls.filter(call => call.request.month === "2026-08").length, 1);
  assert.equal(new Set(results.map(result => result.previewToken)).size, 3);
  assert.equal(results.filter(result => result.generation.cacheStatus === "calculated").length, 1);
  assert.ok(results.every(result => ["calculated", "coalesced", "reused"].includes(result.generation.cacheStatus)));
  assert.equal(state.contextCalls.length, 3);
  assert.equal(state.evaluationCalls.length, 3);
  results[0].summary.lodging.sold = 999;
  assert.equal(results[1].summary.lodging.sold, 2, "coalesced callers do not share mutable results");
});

test("cached lodging calculations receive latest local context and saved evaluation on each new preview", async t => {
  const { state, service } = await fixture(t);
  const first = await service.preview(request);
  state.contextVersion = 2; state.evaluationVersion = 2;
  state.now = "2026-10-17T02:00:00Z";
  const second = await service.preview(request);
  assert.equal(second.generation.cacheStatus, "reused");
  assert.equal(state.sourceCalls.length, 2);
  assert.equal(second.context.sources[0].id, "local-context-2");
  assert.equal(second.context.outlookEvaluations.version, 2);
  assert.equal(first.context.outlookEvaluations.version, 1);
  assert.equal(second.generatedAt, state.now.replace("Z", ".000Z"));
  assert.equal(state.evaluationCalls.at(-1).options.asOfAt, second.generatedAt);
  assert.deepEqual(state.contextCalls.at(-1).roster.companies, [{ companyId: "company-a", regionKey: "region-a", regionLabel: "지역 A" }]);
  assert.deepEqual(state.evaluationCalls.at(-1).roster, state.contextCalls.at(-1).roster);
  assert.ok(state.sourceCalls.every(call => call.options.priority === "foreground" && call.options.includeContext === false));
});

test("generation metadata separates a newly calculated base from a reused base without entering stored snapshots", async t => {
  const { state, service } = await fixture(t);
  const calculated = await service.preview(request);
  const reused = await service.preview(request);
  const measured = ["revisionCheckMs", "cacheReadMs", "contextMs", "evaluationMs", "totalMs"];
  for (const result of [calculated, reused]) {
    assert.ok(Number.isFinite(Date.parse(result.generation.calculatedAt)));
    for (const phase of measured) assert.ok(Number.isFinite(result.generation.timings[phase]) && result.generation.timings[phase] >= 0, phase);
  }
  for (const phase of ["buildQueueWaitMs", "currentSourceMs", "currentAggregateMs", "previousSourceMs", "previousAggregateMs", "comparisonMs", "cacheWriteMs"]) {
    assert.ok(Number.isFinite(calculated.generation.timings[phase]) && calculated.generation.timings[phase] >= 0, phase);
    assert.equal(reused.generation.timings[phase], undefined, `${phase} must not look like work repeated on a hit`);
  }
  const calls = state.sourceCalls.length;
  const draft = await service.create({ ...request, previewToken: reused.previewToken });
  assert.equal(draft.snapshot.generation, undefined);
  assert.equal(draft.snapshot.previewToken, undefined);
  assert.equal(state.sourceCalls.length, calls);
});

test("approved previews and issued reports remain frozen while a revised draft can attach newer local evidence", async t => {
  const { state, service } = await fixture(t);
  const preview = await service.preview(request);
  const approved = snapshotOnly(preview);
  state.contextVersion = 2; state.evaluationVersion = 2;
  const draft = await service.create({ ...request, previewToken: preview.previewToken });
  assert.deepEqual(draft.snapshot, approved);
  assert.equal(state.contextCalls.length, 1, "saving an approved token must not fetch replacement evidence");
  const review = await service.update(draft.id, { revision: draft.revision, status: "review" });
  const issued = await service.publish(draft.id, { revision: review.revision, acknowledgeQuality: true });
  const frozen = copy(issued.snapshot);
  const revision = await service.revise(issued.id, { revision: issued.revision });
  assert.deepEqual(revision.snapshot, frozen);
  const rebuilt = await service.rebuild(revision.id, { revision: revision.revision });
  assert.equal(rebuilt.snapshot.context.sources[0].id, "local-context-2");
  assert.equal(rebuilt.snapshot.context.outlookEvaluations.version, 2);
  assert.equal(state.sourceCalls.length, 2, "rebuilding unchanged lodging evidence only refreshes local attachments");
  assert.deepEqual((await service.get(issued.id)).snapshot, frozen);
  await assert.rejects(service.rebuild(issued.id, { revision: issued.revision }), error => error.code === "published_immutable");
});

test("a source change during calculation rejects the mixed result and preserves the last complete calculation", async t => {
  const { directory, state, service } = await fixture(t);
  await service.preview(request);
  const original = await calculationFiles(directory);
  state.revision = "source-r2"; state.sold = 3;
  let changed = false;
  state.loadBehavior = async input => {
    if (!changed && input.month === request.month) { changed = true; state.revision = "source-r3"; }
  };
  await assert.rejects(service.preview(request), error => error.code === "MONTHLY_SOURCE_CHANGED");
  assert.deepEqual(await calculationFiles(directory), original, "failed replacement cannot overwrite the last successful derived file");
  assert.deepEqual(await service.list(), []);
  state.loadBehavior = null; state.sold = 4;
  const retry = await service.preview(request);
  assert.equal(retry.generation.cacheStatus, "calculated");
  assert.equal(retry.summary.lodging.sold, 4);
  assert.notDeepEqual(await calculationFiles(directory), original);
  const cached = await service.preview(request);
  assert.equal(cached.generation.cacheStatus, "reused");
});

test("a failed source read releases in-flight work and can retry without publishing a partial cache", async t => {
  const { directory, state, service } = await fixture(t);
  let fail = true;
  state.loadBehavior = async input => {
    if (fail && input.month === request.month) { fail = false; throw Object.assign(new Error("saved source unavailable"), { code: "MONTHLY_SOURCE_UNAVAILABLE" }); }
  };
  await assert.rejects(service.preview(request), error => error.code === "MONTHLY_SOURCE_UNAVAILABLE");
  assert.deepEqual(await calculationFiles(directory), []);
  const retry = await service.preview(request);
  assert.equal(retry.generation.cacheStatus, "calculated");
  assert.equal(retry.summary.lodging.sold, 2);
  assert.equal(state.sourceCalls.length, 3, "one failed current read is followed by one complete current/previous pair");
  assert.equal((await service.preview(request)).generation.cacheStatus, "reused");
  assert.equal(state.sourceCalls.length, 3);
});

test("missing or failing source revision cannot silently reuse saved figures", async t => {
  const { state, service } = await fixture(t);
  await service.preview(request);
  state.revisionBehavior = async () => "";
  await assert.rejects(service.preview(request), error => error.code === "MONTHLY_SOURCE_REVISION_UNAVAILABLE");
  state.revisionBehavior = async () => { throw Object.assign(new Error("revision unavailable"), { code: "REVISION_READ_FAILED" }); };
  await assert.rejects(service.preview(request), error => error.code === "REVISION_READ_FAILED");
  assert.equal(state.sourceCalls.length, 2, "revision failures are not interpreted as an empty valid source");
  state.revisionBehavior = null;
  assert.equal((await service.preview(request)).generation.cacheStatus, "reused");
});

test("closed months reuse calculations across calendar changes while an open-to-closed month gets a new base", async t => {
  const { state, service } = await fixture(t);
  const closed = await service.preview(request);
  assert.equal(closed.period.monthClosed, true);
  const openRequest = { ...request, month: "2026-10", cutoffDate: "2026-10-16" };
  const open = await service.preview(openRequest);
  assert.equal(open.period.monthClosed, false);
  assert.equal(state.sourceCalls.length, 4);
  state.now = "2026-10-31T15:00:01Z";
  const stillClosed = await service.preview(request);
  assert.equal(stillClosed.generation.cacheStatus, "reused");
  assert.equal(stillClosed.generatedAt, "2026-10-31T15:00:01.000Z");
  assert.equal(state.sourceCalls.length, 4);
  const nowClosed = await service.preview(openRequest);
  assert.equal(nowClosed.generation.cacheStatus, "calculated");
  assert.equal(nowClosed.period.monthClosed, true);
  assert.equal(nowClosed.quality.provisional, false);
  assert.equal(state.sourceCalls.length, 6);
});

test("damaged derived cache is recalculated from saved evidence rather than returned as zero or trusted JSON", async t => {
  const { directory, state, service } = await fixture(t);
  await service.preview(request);
  const [stored] = await calculationFiles(directory);
  const damaged = JSON.parse(stored.content);
  damaged.value.snapshot.summary.lodging.sold = 999;
  await fs.writeFile(path.join(directory, "calculations", stored.name), JSON.stringify(damaged));
  const result = await service.preview(request);
  assert.equal(result.generation.cacheStatus, "calculated");
  assert.equal(result.summary.lodging.sold, 2);
  assert.equal(state.sourceCalls.length, 4);
});

test("cache hits still reject network-enabled enrichment and preserve approved previews", async t => {
  const { state, service } = await fixture(t);
  const approved = await service.preview(request);
  state.contextBehavior = async () => ({ sources: [], networkAttempted: true });
  await assert.rejects(service.preview(request), error => error.code === "MONTHLY_CONTEXT_MUST_BE_CACHE_ONLY");
  state.contextBehavior = null;
  state.evaluationBehavior = async () => ({ regions: [], networkAttempted: true });
  await assert.rejects(service.preview(request), error => error.code === "MONTHLY_CONTEXT_MUST_BE_CACHE_ONLY");
  assert.equal(state.sourceCalls.length, 2);
  const draft = await service.create({ ...request, previewToken: approved.previewToken });
  assert.deepEqual(draft.snapshot, snapshotOnly(approved));
});

test("legacy adapters without source revisions keep calculating rather than gaining an unsafe persistent cache", async t => {
  const { directory, state, service } = await fixture(t, { cached: false });
  const first = await service.preview(request);
  const second = await service.preview(request);
  assert.equal(first.generation.cacheStatus, "uncached");
  assert.equal(second.generation.storage, "disabled");
  assert.equal(state.sourceCalls.length, 4);
  assert.deepEqual(await calculationFiles(directory), []);
});
