"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { createStoredTourismEvidenceRestorer, markUnstoredOperations, VERSION } = require("./lib/tourism_stored_spatial_evidence.cjs");
const { createCollector, monthDateRange, shiftYearMonth, VISITOR_ADAPTER_VERSION } = require("./tourism_collector.cjs");
const month = "202608", range = monthDateRange(month);
const regions = [
  { regionKey: "new_alpha", sigungu: "새로운군", ktoSggCd: "48001", sido: "경남", sidoKey: "gyeongnam" },
  { regionKey: "new_beta", sigungu: "미래시", ktoSggCd: "48002", sido: "경남", sidoKey: "gyeongnam" }
];
const regionMap = { version: "stored-fixture-v1", regions, provinceAliases: { gyeongnam: { ktoSidoCd: "48", aliases: ["경남"] } } };
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const clone = value => JSON.parse(JSON.stringify(value));
async function fixture(t, mutation = () => {}, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "tourism-stored-proof-"));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith("tourism-stored-proof-"));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const tourismDataDir = path.join(directory, "tourism_data"), evidenceDir = path.join(tourismDataDir, "evidence", "visitors");
  await fs.mkdir(evidenceDir, { recursive: true });
  const raw = { schemaVersion: 1, source: "visitors", adapter: VISITOR_ADAPTER_VERSION, yearMonth: month,
    request: { operation: "locgoRegnVisitrDDList", requestGrain: "month_all_regions", startYmd: range.startYmd, endYmd: range.endYmd },
    response: { rows: regions.flatMap((region, index) => Array.from({ length: range.expectedDays }, (_, day) => ["1", "2", "3"].map(category => ({
      baseYmd: `${month}${String(day + 1).padStart(2, "0")}`, signguCode: region.ktoSggCd, signguNm: region.sigungu,
      touDivCd: category, touNum: String(index * 10)
    }))).flat()) } };
  mutation(raw);
  raw.response.totalCount = raw.response.rows.length; raw.response.receivedRowCount = raw.response.rows.length;
  const sha256 = hash(JSON.stringify(raw)), evidenceId = `visitor-${month}-${sha256.slice(0, 16)}`;
  const filename = path.join(evidenceDir, `${evidenceId}.json`);
  await fs.writeFile(filename, JSON.stringify(raw, null, 2));
  const snapshot = { status: "ok", adapter: VISITOR_ADAPTER_VERSION, regionMapVersion: regionMap.version, yearMonth: month,
    evidence: { status: "stored", evidenceId, sha256, relativePath: `evidence/visitors/${evidenceId}.json`, rowCount: raw.response.rows.length },
    allRegions: regions.map((region, index) => ({ regionKey: region.regionKey, signguCode: region.ktoSggCd,
      yearMonth: month, expectedDays: range.expectedDays, observedDays: range.expectedDays,
      averageDailyVisitors: index * 30, visitorDays: index * 30 * range.expectedDays,
      categoryVisitorDays: { "1": index * 10 * range.expectedDays, "2": index * 10 * range.expectedDays, "3": index * 10 * range.expectedDays },
      quality: { status: "complete" } })) };
  const restorer = createStoredTourismEvidenceRestorer({ tourismDataDir, now: () => new Date("2026-10-17T00:00:00Z"), ...options });
  const invoke = (value = snapshot, map = regionMap) => restorer.restoreVisitorSnapshot({ snapshot: value, regionMap: map, range, adapter: VISITOR_ADAPTER_VERSION });
  return { directory, tourismDataDir, filename, raw, snapshot, restorer, invoke };
}
function status(result, expected, reasonCode = "", index = 0) {
  assert.equal(result.allRegions[index].quality.storedEvidenceVerification.status, expected);
  assert.equal(result.allRegions[index].quality.storedEvidenceVerification.reasonCode, reasonCode);
}

test("stored original restores actual normal zero and generic new regions without mutating source objects or bytes", async t => {
  const f = await fixture(t), original = JSON.stringify(f.snapshot), bytes = await fs.readFile(f.filename);
  const result = await f.invoke();
  for (let index = 0; index < 2; index++) {
    status(result, "restored", "", index);
    const evidence = result.allRegions[index].quality.spatialEvidence;
    assert.equal(evidence.verified, true); assert.equal(evidence.regionCode, regions[index].ktoSggCd);
    assert.equal(evidence.storedProvenance.version, VERSION); assert.equal(evidence.storedProvenance.period, "2026-08");
    assert.equal(evidence.storedProvenance.sha256, f.snapshot.evidence.sha256);
    assert.equal(evidence.storedProvenance.relativePath.startsWith("evidence/visitors/"), true);
    assert.equal(JSON.stringify(evidence).includes(f.directory), false);
  }
  assert.equal(result.allRegions[0].averageDailyVisitors, 0);
  assert.equal(JSON.stringify(f.snapshot), original); assert.deepEqual(await fs.readFile(f.filename), bytes);
});

test("concurrent regions and repeated reads share one compact original summary", async t => {
  const f = await fixture(t);
  const results = await Promise.all(Array.from({ length: 6 }, () => f.invoke()));
  results.forEach(result => status(result, "restored"));
  assert.equal(f.restorer.stats().originalReads, 1); assert.equal(f.restorer.stats().memoHits, 5);
  results[0].allRegions[0].quality.spatialEvidence.storedProvenance.checks.push("consumer_edit");
  assert.equal((await f.invoke()).allRegions[0].quality.spatialEvidence.storedProvenance.checks.includes("consumer_edit"), false);
});

test("a full 36-month history followed by another region reuses summaries without cyclic eviction", async t => {
  const f = await fixture(t), cases = [];
  for (let index = 0; index < 36; index++) {
    const yearMonth = shiftYearMonth(month, -index), monthlyRange = monthDateRange(yearMonth), raw = clone(f.raw);
    raw.yearMonth = yearMonth; raw.request.startYmd = monthlyRange.startYmd; raw.request.endYmd = monthlyRange.endYmd;
    raw.response.rows = regions.flatMap((region, regionIndex) => Array.from({ length: monthlyRange.expectedDays }, (_, day) => ["1", "2", "3"].map(category => ({
      baseYmd: `${yearMonth}${String(day + 1).padStart(2, "0")}`, signguCode: region.ktoSggCd,
      signguNm: region.sigungu, touDivCd: category, touNum: String(regionIndex * 10)
    }))).flat());
    raw.response.totalCount = raw.response.rows.length; raw.response.receivedRowCount = raw.response.rows.length;
    const sha256 = hash(JSON.stringify(raw)), evidenceId = `visitor-${yearMonth}-${sha256.slice(0, 16)}`, snapshot = clone(f.snapshot);
    snapshot.yearMonth = yearMonth;
    snapshot.evidence = { status: "stored", evidenceId, sha256, rowCount: raw.response.rows.length, relativePath: `evidence/visitors/${evidenceId}.json` };
    snapshot.allRegions.forEach((row, regionIndex) => {
      row.yearMonth = yearMonth; row.observedDays = monthlyRange.expectedDays; row.expectedDays = monthlyRange.expectedDays;
      row.visitorDays = regionIndex * 30 * monthlyRange.expectedDays;
      row.categoryVisitorDays = Object.fromEntries(["1", "2", "3"].map(key => [key, regionIndex * 10 * monthlyRange.expectedDays]));
    });
    await fs.writeFile(path.join(f.tourismDataDir, snapshot.evidence.relativePath), JSON.stringify(raw));
    cases.push({ snapshot, range: monthlyRange, regionMap, adapter: VISITOR_ADAPTER_VERSION });
  }
  for (const input of cases) status(await f.restorer.restoreVisitorSnapshot(input), "restored");
  for (const input of cases) status(await f.restorer.restoreVisitorSnapshot(input), "restored", "", 1);
  assert.equal(f.restorer.stats().originalReads, 36); assert.equal(f.restorer.stats().memoHits, 36);
  assert.ok(f.restorer.stats().memoEntries <= 36);
});

test("changed original is rechecked rather than using previous successful proof", async t => {
  const f = await fixture(t); status(await f.invoke(), "restored");
  f.raw.response.rows[0].touNum = "333";
  await fs.writeFile(f.filename, JSON.stringify(f.raw));
  status(await f.invoke(), "rejected", "VISITOR_ORIGINAL_HASH_MISMATCH");
  assert.equal(f.restorer.stats().originalReads, 2);
});

test("absent original stays pending with numeric cache unchanged", async t => {
  const f = await fixture(t), value = clone(f.snapshot); delete value.evidence;
  const result = await f.invoke(value); status(result, "pending", "VISITOR_ORIGINAL_RESPONSE_NOT_STORED");
  assert.equal(result.allRegions[0].averageDailyVisitors, 0); assert.equal(result.allRegions[0].quality.spatialEvidence, undefined);
  assert.equal(f.restorer.stats().originalReads, 0);
});

test("an existing reference with a missing original file stays pending rather than implying a conflicting response", async t => {
  const f = await fixture(t);
  await fs.unlink(f.filename);
  const result = await f.invoke(); status(result, "pending", "VISITOR_ORIGINAL_RESPONSE_NOT_FOUND");
  assert.equal(result.allRegions[0].averageDailyVisitors, 0);
  assert.equal(result.allRegions[0].quality.spatialEvidence, undefined);
  assert.equal(f.restorer.stats().originalReads, 0);
});

test("normalized operation snapshots and echoed regions do not invent raw proof", () => {
  const snapshot = { region: { signguCd: "48001" }, operations: { stay: { overallValue: 0, quality: { status: "complete" } } } };
  const result = markUnstoredOperations(snapshot);
  assert.equal(result.operations.stay.quality.storedEvidenceVerification.status, "pending");
  assert.equal(result.operations.stay.quality.spatialEvidence, undefined); assert.equal(result.operations.stay.overallValue, 0);
  assert.equal(snapshot.operations.stay.quality.storedEvidenceVerification, undefined);
});

for (const [name, mutate, reason] of [
  ["source", raw => { raw.source = "other"; }, "VISITOR_ORIGINAL_IDENTITY_MISMATCH"],
  ["period", raw => { raw.yearMonth = "202607"; }, "VISITOR_ORIGINAL_IDENTITY_MISMATCH"],
  ["operation", raw => { raw.request.operation = "different"; }, "VISITOR_ORIGINAL_IDENTITY_MISMATCH"],
  ["request end", raw => { raw.request.endYmd = "20260830"; }, "VISITOR_ORIGINAL_IDENTITY_MISMATCH"]
]) test(`valid digest cannot prove a different ${name}`, async t => {
  const f = await fixture(t, mutate); status(await f.invoke(), "rejected", reason);
});

for (const [name, mutate, reason] of [
  ["wrong region name", raw => { raw.response.rows[0].signguNm = "다른군"; }, "VISITOR_RAW_REGION_MISMATCH"],
  ["wrong region code", raw => { raw.response.rows[0].signguCode = "99999"; }, "VISITOR_RAW_INCOMPLETE_DAYS"],
  ["missing daily category", raw => { raw.response.rows.shift(); }, "VISITOR_RAW_INCOMPLETE_DAYS"],
  ["conflicting duplicate", raw => { raw.response.rows.push({ ...raw.response.rows[0], touNum: "1" }); }, "VISITOR_RAW_DUPLICATE_CONFLICT"],
  ["negative value", raw => { raw.response.rows[0].touNum = "-1"; }, "VISITOR_RAW_DATE_CATEGORY_OR_VALUE_INVALID"],
  ["missing is not zero", raw => { delete raw.response.rows[0].touNum; }, "VISITOR_RAW_DATE_CATEGORY_OR_VALUE_INVALID"],
  ["wrong raw month", raw => { raw.response.rows[0].baseYmd = "20260701"; }, "VISITOR_RAW_DATE_CATEGORY_OR_VALUE_INVALID"]
]) test(`rejects ${name} and keeps existing raw-backed cache values`, async t => {
  const f = await fixture(t, mutate), result = await f.invoke(); status(result, "rejected", reason);
  assert.equal(result.allRegions[0].averageDailyVisitors, 0);
  assert.notEqual(result.allRegions[0].quality.spatialEvidence?.verified, true);
  status(result, "restored", "", 1);
});

test("identical duplicates are tolerated without double counting", async t => {
  const f = await fixture(t, raw => { raw.response.rows.push({ ...raw.response.rows[0] }); });
  status(await f.invoke(), "restored");
});

test("proof cannot be borrowed for a mismatched cache value, category or region", async t => {
  const f = await fixture(t);
  for (const mutate of [value => { value.allRegions[0].averageDailyVisitors = 1; },
    value => { value.allRegions[0].categoryVisitorDays["2"] = 1; },
    value => { value.allRegions[0].signguCode = "48002"; },
    value => { value.allRegions[0].yearMonth = "202607"; }]) {
    const value = clone(f.snapshot); mutate(value);
    const result = await f.invoke(value); status(result, "rejected", "VISITOR_STORED_VALUES_MISMATCH");
    assert.equal(JSON.stringify(result.allRegions[0]).includes('"verified":true'), false);
  }
});

test("unsafe references, excessive files and rows are rejected before promotion", async t => {
  const f = await fixture(t), invalid = clone(f.snapshot); invalid.evidence.relativePath = "../outside.json";
  status(await f.invoke(invalid), "rejected", "VISITOR_ORIGINAL_REFERENCE_INVALID");
  const small = createStoredTourismEvidenceRestorer({ tourismDataDir: f.tourismDataDir, maxBytes: 20 });
  status(await small.restoreVisitorSnapshot({ snapshot: f.snapshot, regionMap, range, adapter: VISITOR_ADAPTER_VERSION }), "rejected", "VISITOR_ORIGINAL_SIZE_INVALID");
  const few = createStoredTourismEvidenceRestorer({ tourismDataDir: f.tourismDataDir, maxRows: 2 });
  status(await few.restoreVisitorSnapshot({ snapshot: f.snapshot, regionMap, range, adapter: VISITOR_ADAPTER_VERSION }), "rejected", "VISITOR_ORIGINAL_ROW_COUNT_INVALID");
});

test("map changes invalidate old proof and ambiguous codes never verify", async t => {
  const f = await fixture(t); status(await f.invoke(), "restored");
  const map = clone(regionMap); map.regions.push({ ...map.regions[0], regionKey: "other_key" });
  status(await f.invoke(f.snapshot, map), "rejected", "VISITOR_REGION_MAPPING_AMBIGUOUS");
});

test("collector only restores on explicit background input and does not write caches or request APIs", async t => {
  const f = await fixture(t), cacheDir = path.join(f.tourismDataDir, "cache"); await fs.mkdir(cacheDir);
  const cacheFile = path.join(cacheDir, `visitors__${VISITOR_ADAPTER_VERSION}__regionmap__${month}.json`);
  const regionMapFile = path.join(f.directory, "regions.json");
  await fs.writeFile(cacheFile, JSON.stringify(f.snapshot)); await fs.writeFile(regionMapFile, JSON.stringify(regionMap));
  const before = hash(await fs.readFile(cacheFile)); let fetches = 0;
  const collector = createCollector({ rootDir: f.directory, dataDir: f.directory, regionMapFile, env: {},
    now: () => new Date("2026-10-17T00:00:00Z"), fetchImpl: async () => { fetches++; throw new Error("NO_PROVIDER_CALL_ALLOWED"); } });
  const input = { regionKeys: regions.map(region => region.regionKey), months: 1, endYearMonth: month, collectMissing: false };
  const normal = await collector.collectVisitorHistory(input);
  assert.equal(normal.regions[0].series[0].spatialEvidence, undefined);
  const restored = await collector.collectVisitorHistory({ ...input, restoreStoredEvidence: true });
  for (const region of restored.regions) {
    assert.equal(region.series[0].spatialEvidence.verified, true);
    assert.equal(region.series[0].storedEvidenceVerification.status, "restored");
  }
  const direct = await collector.collectVisitorCounts({ yearMonth: month, regionKeys: [regions[0].regionKey], cacheOnly: true, restoreStoredEvidence: true });
  assert.equal(direct.regions[0].quality.spatialEvidence.verified, true);
  assert.equal(hash(await fs.readFile(cacheFile)), before); assert.equal(fetches, 0);
  assert.equal((await collector.collectVisitorHistory(input)).regions[0].series[0].spatialEvidence, undefined);
});
