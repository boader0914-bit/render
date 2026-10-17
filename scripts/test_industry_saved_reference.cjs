"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createIndustryAnalysisStore } = require("./lib/industry_analysis_store.cjs");
const { createIndustryAnalysisService, industryCompanyReference } = require("./lib/industry_analysis.cjs");
const NOW = new Date("2026-10-17T00:00:00Z");
const REQUEST = { industry: "glamping", region: "pocheon", month: "2026-09", cutoffDate: "2026-09-30" };
const result = request => ({ request, summary: { sold: 0, estimatedRevenue: 0 }, period: { monthClosed: true }, review: { schemaVersion: 1 } });
const storeAt = (dataDir, extra = {}) => createIndustryAnalysisStore({ dataDir, calculate: async request => result(request), now: () => NOW, autoStart: false, ...extra });
async function directory(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "industry-saved-reference-"));
  t.after(async () => { assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)); await fs.rm(root, { recursive: true, force: true }); });
  return root;
}
async function seed(t, extra = {}) {
  const dataDir = await directory(t), store = storeAt(dataDir, extra);
  await store.get(REQUEST); await store.drain(); await store.stop();
  const queueFile = path.join(dataDir, "industry_analysis", "queue.json");
  const queue = JSON.parse(await fs.readFile(queueFile, "utf8")), key = Object.keys(queue.jobs)[0];
  const resultFile = path.join(dataDir, "industry_analysis", "results", `${key}.json`);
  return { dataDir, queueFile, queue, key, resultFile };
}

test("a saved-reference miss creates no directories, queue or calculation even with automatic workers enabled", async t => {
  const dataDir = await directory(t); let calls = 0;
  const store = storeAt(dataDir, { autoStart: true, calculate: async () => { calls++; throw Error("must not calculate"); } });
  const value = await store.readSaved(REQUEST);
  assert.equal(value.storage.status, "pending"); assert.equal(value.storage.hasSnapshot, false); assert.equal(value.summary, undefined);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 0); assert.deepEqual(await fs.readdir(dataDir), []);
  await store.stop();
});

test("saved read preserves genuine zero and stable result identity without initializing or rewriting queue", async t => {
  const fixture = await seed(t), before = await fs.readFile(fixture.queueFile, "utf8"); let calls = 0;
  const store = storeAt(fixture.dataDir, { autoStart: true, calculate: async () => { calls++; throw Error("must not calculate"); } });
  const first = await store.readSaved(REQUEST), second = await store.readSaved(REQUEST);
  assert.equal(first.summary.sold, 0); assert.equal(first.summary.estimatedRevenue, 0);
  assert.equal(first.storage.status, "ready"); assert.equal(first.storage.sourceRevisionMatches, true);
  assert.match(first.storage.resultVersion, /^[a-f0-9]{64}$/); assert.equal(first.storage.resultVersion, second.storage.resultVersion);
  assert.equal(first.storage.key, fixture.key); assert.equal(await fs.readFile(fixture.queueFile, "utf8"), before); assert.equal(calls, 0);
  const otherCutoff = await store.readSaved({ ...REQUEST, cutoffDate: "2026-09-20" });
  assert.equal(otherCutoff.storage.hasSnapshot, false); assert.equal(otherCutoff.summary, undefined);
  await store.stop();
});

test("normal analysis and saved-only references identify the identical stored result, then detect replacement", async t => {
  const fixture = await seed(t), store = storeAt(fixture.dataDir);
  const analysis = await store.get(REQUEST), reference = await store.readSaved(REQUEST);
  assert.equal(analysis.storage.key, reference.storage.key);
  assert.equal(analysis.storage.resultVersion, reference.storage.resultVersion);
  assert.equal(analysis.storage.resultRevision, reference.storage.resultRevision);
  const saved = JSON.parse(await fs.readFile(fixture.resultFile, "utf8")); saved.result.summary.sold = 1;
  await fs.writeFile(fixture.resultFile, JSON.stringify(saved));
  const changed = await store.readSaved(REQUEST);
  assert.notEqual(changed.storage.resultVersion, reference.storage.resultVersion);
  assert.equal(changed.storage.resultVersion, (await store.get(REQUEST)).storage.resultVersion);
  await store.stop();
});

test("queued, processing and failed snapshots remain readable without recovering jobs or retrying", async t => {
  const fixture = await seed(t); let calls = 0;
  for (const status of ["queued", "processing", "failed"]) {
    fixture.queue.jobs[fixture.key].status = status;
    fixture.queue.jobs[fixture.key].errorCode = status === "failed" ? "SAVED_SOURCE_UNAVAILABLE" : null;
    const before = JSON.stringify(fixture.queue); await fs.writeFile(fixture.queueFile, before);
    const store = storeAt(fixture.dataDir, { autoStart: true, calculate: async () => { calls++; return result(REQUEST); } });
    const value = await store.readSaved(REQUEST);
    assert.equal(value.storage.status, status); assert.equal(value.storage.stale, true); assert.equal(value.summary.sold, 0);
    assert.equal(await fs.readFile(fixture.queueFile, "utf8"), before);
    await store.stop();
  }
  assert.equal(calls, 0);
});

test("source probe detects only the requested month and never invalidates or enqueues", async t => {
  let revision = { globalToken: "global-v1", months: { "2026-09": "sep1", "2026-10": "oct1" } };
  const readSourceRevision = async () => structuredClone(revision);
  const fixture = await seed(t, { readSourceRevision });
  const before = await fs.readFile(fixture.queueFile, "utf8"), store = storeAt(fixture.dataDir, { readSourceRevision, autoStart: true });
  revision.months["2026-10"] = "oct2";
  assert.equal((await store.readSaved(REQUEST)).storage.status, "ready");
  revision.months["2026-09"] = "sep2";
  const stale = await store.readSaved(REQUEST);
  assert.equal(stale.storage.status, "stale"); assert.equal(stale.storage.sourceRevisionMatches, false);
  assert.equal(stale.storage.sourceTokenMatches, false); assert.equal(stale.summary.sold, 0);
  assert.equal(await fs.readFile(fixture.queueFile, "utf8"), before);
  await store.stop();
});

test("one report shares its source probe across sequential saved references and a new report checks again", async t => {
  let checks = 0;
  const readSourceRevision = async () => { checks++; return "v1"; };
  const fixture = await seed(t, { readSourceRevision }); checks = 0;
  const store = storeAt(fixture.dataDir, { readSourceRevision }), sourceCheckGroup = {};
  for (let index = 0; index < 48; index++) {
    assert.equal((await store.readSaved(REQUEST, { sourceCheckGroup })).storage.status, "ready");
  }
  assert.equal(checks, 1, "a bounded report batch reads shared source revisions once");
  await new Promise(resolve => setImmediate(resolve));
  await store.readSaved(REQUEST, { sourceCheckGroup: {} });
  assert.equal(checks, 2, "a new report does not inherit the preceding report's source result");
  await store.stop();
});

test("a trusted verified input revision shares one probe across reports while revision and Korea-day changes inspect afresh", async t => {
  const fixture = await seed(t, { readSourceRevision: async () => "v1" }); let checks = 0, date = NOW;
  const store = storeAt(fixture.dataDir, { now: () => date, savedReferenceRevisionScope: "full-monthly-inputs-v1",
    readSourceRevision: async () => { checks++; return "v1"; } });
  const options = revision => ({ sourceCheckGroup: {}, verifiedSourceRevision: { scope: "full-monthly-inputs-v1", revision } });
  await store.readSaved(REQUEST, options("source-a"));
  await new Promise(resolve => setImmediate(resolve));
  await store.readSaved(REQUEST, options("source-a"));
  assert.equal(checks, 1, "a newly verified identical input revision reuses the known period revision, without a TTL");
  const sameReport = {};
  await store.readSaved(REQUEST, { ...options("source-b"), sourceCheckGroup: sameReport });
  await store.readSaved(REQUEST, { ...options("source-c"), sourceCheckGroup: sameReport });
  assert.equal(checks, 3, "a changed revision cannot reuse either the preceding tick or the report group");
  date = new Date(NOW.getTime() + 86400000);
  await store.readSaved(REQUEST, options("source-a"));
  assert.equal(checks, 4, "the next Korea day starts a new proof scope");
  await store.stop();
});

test("missing, mismatched or malformed verified scope falls back to the existing fresh-probe contract", async t => {
  const fixture = await seed(t, { readSourceRevision: async () => "v1" }); let checks = 0;
  const store = storeAt(fixture.dataDir, { savedReferenceRevisionScope: "trusted", readSourceRevision: async () => { checks++; return "v1"; } });
  const invalid = [undefined, { scope: "other", revision: "a" }, { scope: "trusted", revision: "" },
    { scope: "trusted", revision: "  " }, { scope: "trusted", revision: 1 }, { scope: "trusted", revision: "a\nb" },
    { scope: "trusted", revision: "a".repeat(513) }, ["trusted", "a"]];
  for (const verifiedSourceRevision of invalid) {
    await new Promise(resolve => setImmediate(resolve));
    await store.readSaved(REQUEST, { sourceCheckGroup: {}, verifiedSourceRevision });
  }
  assert.equal(checks, invalid.length);
  await store.stop();
  const unscoped = storeAt(fixture.dataDir, { readSourceRevision: async () => { checks++; return "v1"; } });
  await unscoped.readSaved(REQUEST, { verifiedSourceRevision: { scope: "trusted", revision: "a" } });
  await new Promise(resolve => setImmediate(resolve));
  await unscoped.readSaved(REQUEST, { verifiedSourceRevision: { scope: "trusted", revision: "a" } });
  assert.equal(checks, invalid.length + 2, "a caller cannot opt an unconfigured store into proof reuse");
  await unscoped.stop();
});

test("failed verified probes are evicted and retry in a later report preserves the normal snapshot", async t => {
  const fixture = await seed(t, { readSourceRevision: async () => "v1" }); let checks = 0, fail = true;
  const store = storeAt(fixture.dataDir, { savedReferenceRevisionScope: "trusted", readSourceRevision: async () => {
    checks++; if (fail) throw Object.assign(Error("unavailable"), { code: "SOURCE_UNAVAILABLE" }); return "v1";
  } });
  const options = () => ({ sourceCheckGroup: {}, verifiedSourceRevision: { scope: "trusted", revision: "a" } });
  const failed = await store.readSaved(REQUEST, options());
  assert.equal(failed.storage.status, "failed"); assert.equal(failed.summary.sold, 0);
  fail = false;
  const ready = await store.readSaved(REQUEST, options());
  assert.equal(checks, 2); assert.equal(ready.storage.status, "ready");
  await store.stop();
});

test("verified proof reuse never caches queue state or result content and remains bounded to sixteen proofs", async t => {
  const fixture = await seed(t, { readSourceRevision: async () => "v1" }); let checks = 0;
  const store = storeAt(fixture.dataDir, { savedReferenceRevisionScope: "trusted", readSourceRevision: async () => { checks++; return "v1"; } });
  const options = revision => ({ sourceCheckGroup: {}, verifiedSourceRevision: { scope: "trusted", revision } });
  const first = await store.readSaved(REQUEST, options("a"));
  const saved = JSON.parse(await fs.readFile(fixture.resultFile, "utf8")); saved.result.summary.sold = 1;
  await fs.writeFile(fixture.resultFile, JSON.stringify(saved));
  const changed = await store.readSaved(REQUEST, options("a"));
  assert.equal(checks, 1); assert.equal(changed.summary.sold, 1); assert.notEqual(changed.storage.resultVersion, first.storage.resultVersion);
  fixture.queue.jobs[fixture.key].status = "failed"; fixture.queue.jobs[fixture.key].errorCode = "LATEST_BUILD_FAILED";
  await fs.writeFile(fixture.queueFile, JSON.stringify(fixture.queue));
  const failed = await store.readSaved(REQUEST, options("a"));
  assert.equal(checks, 1); assert.equal(failed.storage.status, "failed"); assert.equal(failed.storage.errorCode, "LATEST_BUILD_FAILED");
  for (let index = 0; index < 16; index++) await store.readSaved(REQUEST, options(`new-${index}`));
  assert.equal(checks, 17);
  await store.readSaved(REQUEST, options("a"));
  assert.equal(checks, 18, "the oldest proof is evicted after sixteen newer input revisions");
  await store.stop();
});

test("corrupt saved metadata, wrong conditions and calculation versions cannot expose metrics", async t => {
  const fixture = await seed(t), original = JSON.parse(await fs.readFile(fixture.resultFile, "utf8"));
  for (const mutate of [value => { value.request.cutoffDate = "2026-09-20"; }, value => { value.calculationVersion = "old-version"; },
    value => { value.result.request.region = "another"; }, value => { value.result.summary = []; }]) {
    const damaged = structuredClone(original); mutate(damaged); await fs.writeFile(fixture.resultFile, JSON.stringify(damaged));
    const store = storeAt(fixture.dataDir), value = await store.readSaved(REQUEST);
    assert.equal(value.storage.status, "unavailable"); assert.equal(value.storage.hasSnapshot, false); assert.equal(value.summary, undefined);
    await store.stop();
  }
  await fs.writeFile(fixture.resultFile, "{invalid-json");
  const store = storeAt(fixture.dataDir), value = await store.readSaved(REQUEST);
  assert.equal(value.storage.status, "unavailable"); assert.equal(value.summary, undefined); await store.stop();
});

test("source read failure retains the last normal snapshot as failed and unverified", async t => {
  const fixture = await seed(t, { readSourceRevision: async () => "v1" });
  const store = storeAt(fixture.dataDir, { readSourceRevision: async () => { throw Object.assign(Error("unavailable"), { code: "SOURCE_UNAVAILABLE" }); } });
  const value = await store.readSaved(REQUEST);
  assert.equal(value.storage.status, "failed"); assert.equal(value.storage.sourceRevisionMatches, false);
  assert.equal(value.storage.errorCode, "SOURCE_UNAVAILABLE"); assert.equal(value.storage.stale, true); assert.equal(value.summary.sold, 0);
  await store.stop();
});

test("service attachment reads and classification never prepare source, catalog, context or options", async t => {
  const dataDir = await directory(t); let calls = 0;
  const forbidden = async () => { calls++; throw Error("attachment must not prepare data"); };
  const service = createIndustryAnalysisService({ dataDir, now: () => NOW, autoStart: true,
    sources: { loadSources: forbidden, loadSourcesWithCatalog: forbidden, options: forbidden, catalog: forbidden }, readContext: forbidden,
    readSourceRevision: Object.assign(forbidden, { periodRevisions: async () => "v1" }) });
  const value = await service.readSaved({ ...REQUEST, cutoffDate: "2026-10-17" });
  assert.equal(value.request.cutoffDate, "2026-09-30"); assert.equal(value.storage.hasSnapshot, false);
  assert.deepEqual(service.classifyCompanyIndustryIds({ lodgingTypes: ["글램핑"], primaryName: "휴식 풀빌라" }), ["glamping", "poolVilla"]);
  assert.equal(calls, 0); assert.deepEqual(await fs.readdir(dataDir), []); await service.stop();
});

test("older region-policy snapshots are marked stale without changing their key, creating a job or recalculating", async t => {
  const fixture = await seed(t, { readSourceRevision: async () => "v1" });
  const queueBefore = await fs.readFile(fixture.queueFile, "utf8"); let calls = 0;
  const forbidden = async () => { calls++; throw Error("must not prepare source"); };
  const service = createIndustryAnalysisService({ dataDir: fixture.dataDir, now: () => NOW, autoStart: true,
    sources: { loadSources: forbidden, catalog: forbidden, options: forbidden },
    readSourceRevision: Object.assign(forbidden, { periodRevisions: async () => "v1" }) });
  const value = await service.readSaved(REQUEST);
  assert.equal(value.storage.key, fixture.key); assert.equal(value.storage.status, "stale");
  assert.equal(value.storage.sourceRevisionMatches, false); assert.equal(value.summary.sold, 0);
  assert.equal(await fs.readFile(fixture.queueFile, "utf8"), queueBefore); assert.equal(calls, 0);
  await service.stop();
});

test("industry company references share actual-address and hybrid classification rules only", () => {
  const raw = { primaryName: "휴식 글램핑 풀빌라", addresses: ["경기도 포천시 영북면"], regionKeys: ["산청글램핑"] };
  const regions = [{ id: "pocheon", label: "경기도 포천시", level: "local" }, { id: "sancheong", label: "경상남도 산청군", level: "local" }];
  assert.deepEqual(industryCompanyReference(raw, regions), { industryIds: ["glamping", "poolVilla"], industryRegionKey: "pocheon", industryRegionLabel: "경기도 포천시" });
  assert.deepEqual(Object.keys(industryCompanyReference(raw, regions)).sort(), ["industryIds", "industryRegionKey", "industryRegionLabel"]);
});
