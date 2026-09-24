"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { sanitizeCollectionProgress, parseCollectionProgressLine } = require("./collection_progress.cjs");

const source = fs.readFileSync(path.join(__dirname, "glamping_app_server.cjs"), "utf8");
function harness() {
  let timingStore = { entries: [] };
  const context = vm.createContext({
    Date, Map, sanitizeCollectionProgress, parseCollectionProgressLine,
    CRAWL_RUNTIME_STAGE_DEFS: ["rank_main", "inventory", "save", "uploading", "completing"].map(key => ({ key, estimatedRatio: 0.1 })),
    CRAWL_LOG_STAGE_RULES: [{ key: "completing", pattern: /^Verifying collected outputs\.\.\.$/ }],
    crawlLane: () => ({ activeCrawlEstimate: { estimatedTotalSeconds: 100 } }),
    normalizeSearchMode: value => value || "keyword", normalizeProductMode: value => value || "all",
    normalizeDayUseMode: value => value || "detail", normalizeCollectionMode: value => value || "precision",
    normalizeCollectionPurpose: value => value || "revenue_detail", collectionExecutionProfile: () => ({ key: "fixture" }),
    ADMIN_COLLECTION_RANK_SAFETY_MAX: 100, CRAWL_TIMING_MAX_ENTRIES: 100,
    readCrawlTimingStore: async () => timingStore, writeCrawlTimingStore: async value => { timingStore = value; },
    crypto: require("node:crypto"),
    USER_ROLES: { admin: "admin", b2b: "b2b" }, normalizeUserRole: value => value,
    publicCrawlEstimate: (payload, timingStore) => ({ payload, timingStore })
  });
  for (const name of ["crawlRuntimeStageDef", "crawlRuntimeStageEstimatedSeconds", "ensureCrawlRuntimeState", "finishOpenCrawlRuntimeStage",
    "recordCrawlRuntimeStage", "recordCrawlCollectionProgress", "recordCrawlRuntimeLog", "crawlTimingConditions", "crawlTimingSimilarityScore",
    "crawlTimingErrorSummary", "appendCrawlTimingEntryUnlocked", "selectedWorkerKey", "normalizeDayUseMode", "publicCrawlEstimateForSession"]) {
    const asyncStart = source.indexOf(`async function ${name}(`);
    const start = asyncStart >= 0 ? asyncStart : source.indexOf(`function ${name}(`);
    assert.ok(start >= 0, name);
    const next = /\n\}/.exec(source.slice(start + 1));
    assert.ok(next, `${name} has a function boundary`);
    vm.runInContext(source.slice(start, start + 1 + next.index + 2), context);
  }
  return { context, entries: () => timingStore.entries };
}
const actual = overrides => ({ version: 1, phase: "inventory", completedPlaces: 1, totalPlaces: 2,
  currentPlaceName: "시즌글램핑", updatedAt: "2026-09-22T11:00:00.000Z", ...overrides });
const plain = value => JSON.parse(JSON.stringify(value));

test("actual counts remain separate from stage freshness and do not mark the crawl complete", () => {
  const { context: c } = harness(), job = {};
  assert.equal(c.recordCrawlCollectionProgress(job, actual(), "2026-09-22T11:00:01.000Z"), true);
  assert.equal(job.collectionProgress.source, "actual"); assert.equal(job.collectionProgress.receivedAt, job.lastProgressAt);
  assert.equal(c.recordCrawlCollectionProgress(job, actual(), "2026-09-22T11:00:02.000Z"), false);
  assert.equal(job.lastProgressAt, "2026-09-22T11:00:01.000Z");
  assert.equal(c.recordCrawlCollectionProgress(job, actual({ completedPlaces: 0 }), "2026-09-22T11:00:03.000Z"), false);
  c.recordCrawlCollectionProgress(job, actual({ completedPlaces: 2, currentPlaceName: "", updatedAt: "2026-09-22T11:00:04.000Z" }));
  assert.equal(job.stageEvents.at(-1).key, "inventory"); assert.equal(job.stageEvents.at(-1).status, "active");
  assert.equal(job.completedAt, undefined);
});

test("the first actual count bundled with upload or validation never reopens inventory", () => {
  for (const stage of ["save", "uploading", "completing"]) {
    const { context: c } = harness(), job = {};
    c.recordCrawlRuntimeStage(job, stage);
    c.recordCrawlCollectionProgress(job, actual({ completedPlaces: 2, currentPlaceName: "" }));
    assert.equal(job.collectionProgress.completedPlaces, 2);
    assert.equal(job.stageEvents.at(-1).key, stage); assert.equal(job.stageEvents.at(-1).status, "active");
    assert.equal(job.stageEvents.some(event => event.key === "inventory"), false);
  }
});

test("ETA uses same-worker and day-use conditions while accepting compatible legacy history", () => {
  const { context: c } = harness();
  const plan = { workerKey: "manual", dayUseMode: "detail", bookingRangeDays: 31, detailRankRanges: "1-20" };
  const conditions = plain(c.crawlTimingConditions(plan));
  const entry = { success: true, durationSeconds: 120, conditions };
  const exact = c.crawlTimingSimilarityScore(plan, entry);
  assert.ok(exact > 0);
  assert.equal(c.crawlTimingSimilarityScore(plan, { ...entry, conditions: { ...conditions, workerKey: "scheduled" } }), 0);
  assert.equal(c.crawlTimingSimilarityScore(plan, { ...entry, conditions: { ...conditions, dayUseMode: "inspect" } }), 0);
  const legacy = { ...conditions }; delete legacy.workerKey; delete legacy.dayUseMode;
  const legacyScore = c.crawlTimingSimilarityScore(plan, { ...entry, conditions: legacy });
  assert.ok(legacyScore > 0 && legacyScore < exact);
  assert.equal(c.crawlTimingSimilarityScore({ ...plan, dayUseMode: "inspect" }, { ...entry, conditions: legacy }), 0);
});

test("partial, blocked, failed and reused results cannot train successful ETA samples", async () => {
  const { context: c, entries } = harness();
  const plan = { workerKey: "scheduled", dayUseMode: "inspect" };
  for (const status of ["complete", "partial", "blocked", "failed"]) {
    const reply = await c.appendCrawlTimingEntryUnlocked({ plan, startedAt: new Date("2026-09-22T11:00:00Z"),
      endedAt: new Date("2026-09-22T11:01:00Z"), result: { collectionQuality: { status } } });
    assert.equal(reply.success, status === "complete");
  }
  const reused = await c.appendCrawlTimingEntryUnlocked({ plan, startedAt: new Date("2026-09-22T11:00:00Z"),
    endedAt: new Date("2026-09-22T11:00:01Z"), result: { reused: true, collectionQuality: { status: "complete" } } });
  assert.equal(reused.success, false);
  assert.ok(entries().every(entry => entry.conditions.workerKey === "scheduled" && entry.conditions.dayUseMode === "inspect"));
});

test("admin ETA previews use the same worker and day-use defaults as a new collection", async () => {
  const { context: c } = harness(), timingStore = { entries: [] };
  const preview = await c.publicCrawlEstimateForSession({ keyword: "가평글램핑" }, timingStore, { role: "admin" });
  assert.deepEqual(plain(preview.payload), { keyword: "가평글램핑", workerKey: "manual", dayUseMode: "inspect" });
  assert.equal(preview.timingStore, timingStore);
  const selected = await c.publicCrawlEstimateForSession({ workerKey: "scheduled", dayUseMode: "lodging_only" }, null, { role: "admin" });
  assert.deepEqual(plain(selected.payload), { workerKey: "scheduled", dayUseMode: "lodging_only" });
  await assert.rejects(c.publicCrawlEstimateForSession({ workerKey: "invalid" }, null, { role: "admin" }), { statusCode: 400 });
});
