"use strict";

// These tests join the real snapshot, immutable store and comparison policy.
// Raw-file parsing is covered by the collector tests; this fixture injects its
// verified result so the integration does not mirror the raw verifier itself.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { createRegionalAnalysisSnapshotBuilder } = require("./lib/regional_analysis_snapshot.cjs");
const { createRegionalAnalysisStore } = require("./lib/regional_analysis_store.cjs");
const { comparisonModel } = require("../web/regional-comparison.js");
const { storedEvidenceSummary } = require("../web/regional-data-contract.js");

const NOW = new Date("2026-10-17T06:00:00Z");
const MONTH = "2026-09";
const scope = regionKey => ({ regionKey, month: MONTH, months: 13 });
const sha = value => crypto.createHash("sha256").update(value).digest("hex");
const regions = {
  new_county: { regionKey: "new_county", label: "새 도 새 군", officialCode: "1111100000", level: "local", unitType: "county", active: true, selectable: true },
  new_city: { regionKey: "new_city", label: "다른 도 새 시", officialCode: "2222200000", level: "local", unitType: "city", active: true, selectable: true }
};

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "regional-stored-evidence-"));
  t.after(async () => {
    assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const cacheFile = path.join(directory, "source-cache.json"), rawFile = path.join(directory, "source-raw.json");
  const source = { regions: Object.keys(regions).map(regionKey => ({ regionKey, rows: [
    { yearMonth: "202607", status: "complete", averageDailyVisitors: 0, visitorDays: 0 },
    { yearMonth: "202608", status: "complete", averageDailyVisitors: regionKey === "new_county" ? 12 : 24, visitorDays: regionKey === "new_county" ? 372 : 744 },
    { yearMonth: "202609", status: "complete", averageDailyVisitors: regionKey === "new_county" ? 20 : 40, visitorDays: regionKey === "new_county" ? 600 : 1200 }
  ] })) };
  const raw = JSON.stringify({ source: "fixture-raw-not-a-provider", ...source });
  await fs.writeFile(cacheFile, JSON.stringify(source));
  await fs.writeFile(rawFile, raw);
  const originalFiles = { cache: await fs.readFile(cacheFile), raw: await fs.readFile(rawFile) };
  const state = { enabled: false, periods: new Set(["2026-08"]), verifiedAt: NOW.toISOString(), wrongPeriod: false, mismatch: false,
    verificationCalls: 0, builds: 0, providerCalls: 0, tourismInputs: [], kosisOptions: [] };

  const tourismCollector = {
    async collectVisitorHistory(input) {
      state.tourismInputs.push(structuredClone(input));
      assert.equal(input.collectMissing, false); assert.equal(input.force, false); assert.equal(input.refresh, false);
      const row = JSON.parse(await fs.readFile(cacheFile, "utf8")).regions.find(item => item.regionKey === input.regionKey);
      const region = regions[input.regionKey];
      const series = row.rows.map(point => {
        const result = { ...point, collectedAt: "2026-10-01T00:00:00Z" };
        const period = `${point.yearMonth.slice(0, 4)}-${point.yearMonth.slice(4)}`;
        if (input.restoreStoredEvidence !== true || !state.enabled || !state.periods.has(period)) return result;
        state.verificationCalls++;
        result.spatialEvidence = { verified: !state.mismatch, regionKey: region.regionKey,
          regionCode: state.mismatch ? "99999" : region.officialCode.slice(0, 5), level: "sigungu", mappingStatus: "mapped",
          observedRegionCodes: [state.mismatch ? "99999" : region.officialCode.slice(0, 5)], reasonCode: state.mismatch ? "REGION_MISMATCH" : "",
          storedProvenance: { version: "regional-stored-evidence-v1", sourceKind: "stored_raw_response", evidenceId: `fixture-${point.yearMonth}`,
            sha256: sha(raw), period: state.wrongPeriod ? "2026-09" : period, verifiedAt: state.verifiedAt,
            checks: ["hash", "region", "period", "values"], unsafePath: "private-should-not-leave-fixture" } };
        result.storedEvidenceVerification = { status: state.mismatch ? "rejected" : "restored",
          reasonCode: state.mismatch ? "REGION_MISMATCH" : "STORED_RESPONSE_VERIFIED" };
        return result;
      });
      return { regions: [{ regionKey: input.regionKey, level: "local", series }], period: { endYearMonth: input.endYearMonth }, networkAttempted: false };
    }
  };
  for (const method of ["collectDemandStrengthHistory", "collectResourceDemandHistory", "collectDiversityHistory"]) tourismCollector[method] = async input => {
    state.tourismInputs.push(structuredClone(input));
    assert.equal(input.collectMissing, false); assert.equal(input.force, false); assert.equal(input.refresh, false);
    return { region: { regionKey: input.regionKey }, series: [], period: { endYearMonth: input.endYearMonth }, networkAttempted: false };
  };
  const builder = createRegionalAnalysisSnapshotBuilder({ tourismCollector,
    kosisService: { async getRegion(regionKey, options) { state.kosisOptions.push(structuredClone(options)); return { region: { regionKey }, datasets: [], networkAttempted: false }; } },
    searchTrendService: { async get(input) { return { ...input, keyword: "격리된 지역 검색어", partialMonth: false, series: [], networkAttempted: false }; } },
    resolveRegion: async key => regions[key], prepare: async () => { state.providerCalls++; throw Error("Provider preparation is forbidden in these tests"); }, now: () => NOW });
  const buildSnapshot = async (...args) => { state.builds++; return builder(...args); };
  const store = createRegionalAnalysisStore({ dataDir: directory, autoStart: false, now: () => NOW, resolveRegion: async key => regions[key], buildSnapshot });
  t.after(() => store.close());
  async function rebuild(regionKey = "new_county") { await store.request(scope(regionKey), { collectMissing: false }); await store.waitForIdle(); return store.get(scope(regionKey)); }
  async function assertSourcesUnchanged() {
    assert.deepEqual(await fs.readFile(cacheFile), originalFiles.cache);
    assert.deepEqual(await fs.readFile(rawFile), originalFiles.raw);
    assert.equal(state.providerCalls, 0);
  }
  return { directory, state, builder, store, rebuild, assertSourcesUnchanged };
}

const visitor = snapshot => snapshot.groups.find(group => group.key === "visitors");
const rows = snapshot => visitor(snapshot).metrics[0].rows;
const point = (snapshot, period) => rows(snapshot).find(row => row.period === period);
const values = snapshot => visitor(snapshot).metrics.map(metric => metric.rows.map(({ period, status, value }) => ({ period, status, value })));

async function resultBytes(directory) {
  const result = new Map();
  async function walk(folder) {
    for (const entry of await fs.readdir(folder, { withFileTypes: true }).catch(error => { if (error.code === "ENOENT") return []; throw error; })) {
      const full = path.join(folder, entry.name);
      if (entry.isDirectory()) await walk(full); else result.set(path.relative(directory, full), await fs.readFile(full));
    }
  }
  await walk(path.join(directory, "regional_analysis", "results"));
  return result;
}

test("stored response proof creates a new immutable result while preserving zero, values, periods and source bytes", async t => {
  const f = await fixture(t), before = await f.rebuild(), priorFiles = await resultBytes(f.directory);
  assert.equal(point(before.snapshot, "2026-08").spatialContract.status, "scope_unverified");
  assert.equal(point(before.snapshot, "2026-07").value, 0);
  f.state.enabled = true; f.state.periods.add("2026-07");
  const after = await f.rebuild();
  assert.notEqual(after.snapshot.resultId, before.snapshot.resultId);
  assert.notEqual(after.snapshot.sourceFingerprint, before.snapshot.sourceFingerprint);
  assert.deepEqual(values(after.snapshot), values(before.snapshot));
  assert.equal(point(after.snapshot, "2026-08").spatialContract.status, "matched");
  assert.equal(point(after.snapshot, "2026-07").spatialContract.status, "matched");
  assert.equal(point(after.snapshot, "2026-07").availability.observed, true);
  assert.equal(point(after.snapshot, "2026-09").spatialContract.status, "scope_unverified");
  const proof = point(after.snapshot, "2026-08").spatialContract.storedProvenance;
  assert.equal(proof.period, "2026-08"); assert.equal(proof.evidenceId, "fixture-202608"); assert.match(proof.sha256, /^[a-f0-9]{64}$/);
  assert.equal(proof.unsafePath, undefined); assert.equal(storedEvidenceSummary(point(after.snapshot, "2026-08").spatialContract).label, "보관 원본 재검증");
  const filesAfter = await resultBytes(f.directory);
  for (const [name, bytes] of priorFiles) assert.deepEqual(filesAfter.get(name), bytes);
  assert.equal(filesAfter.size, priorFiles.size + 1);
  await f.assertSourcesUnchanged();
});

test("changing verification time alone reuses the same immutable result", async t => {
  const f = await fixture(t); f.state.enabled = true;
  const first = await f.rebuild(), files = await resultBytes(f.directory), inspections = f.state.verificationCalls;
  f.state.verifiedAt = "2026-10-17T07:00:00Z";
  const second = await f.rebuild();
  assert.ok(f.state.verificationCalls > inspections, "The explicit rebuild performed a new inspection");
  assert.equal(second.snapshot.sourceFingerprint, first.snapshot.sourceFingerprint);
  assert.equal(second.snapshot.resultId, first.snapshot.resultId); assert.equal(second.job.unchanged, true);
  assert.deepEqual(await resultBytes(f.directory), files);
  await f.assertSourcesUnchanged();
});

test("two new regions compare only the older month whose own rows have restored proof", async t => {
  const f = await fixture(t); f.state.enabled = true;
  const first = await f.rebuild("new_county"), second = await f.rebuild("new_city");
  const records = [first, second].map(data => ({ key: data.scope.regionKey, label: regions[data.scope.regionKey].label, data }));
  const model = comparisonModel(records).filter(metric => metric.key.startsWith("visitors\u0000"));
  assert.equal(model.length, 2);
  for (const metric of model) {
    assert.equal(metric.commonPeriod, "2026-08"); assert.equal(metric.newerPeriodExcluded, true); assert.equal(metric.excludedPeriod, "2026-09");
    assert.equal(metric.cells.every(cell => cell.scope.matched), true);
  }
  assert.deepEqual(model[0].cells.map(cell => cell.value), [12, 24]);
  assert.equal(point(first.snapshot, "2026-09").spatialContract.status, "scope_unverified");
  assert.equal(point(second.snapshot, "2026-09").spatialContract.status, "scope_unverified");
  await f.assertSourcesUnchanged();
});

test("proof for a different month never promotes an otherwise normal observation", async t => {
  const f = await fixture(t); f.state.enabled = true; f.state.wrongPeriod = true;
  const result = await f.rebuild(), august = point(result.snapshot, "2026-08");
  assert.equal(august.value, 12); assert.equal(august.status, "observed");
  assert.equal(august.spatialContract.status, "scope_unverified"); assert.equal(august.spatialContract.storedProvenance, undefined);
  assert.equal(august.spatialContract.reasonCode, "INVALID_RESPONSE");
  assert.equal(august.storedEvidenceVerification.status, "rejected");
  assert.equal(result.snapshot.storedEvidence.restored, 0); assert.equal(result.snapshot.storedEvidence.rejected, 2);
  const compared = comparisonModel([{ key: "new_county", data: result }]);
  assert.equal(compared[0].commonPeriod, ""); assert.equal(compared[0].cells[0].value, null);
  await f.assertSourcesUnchanged();
});

test("a confirmed response region mismatch is not revived by last-normal group retention", async t => {
  const f = await fixture(t), before = await f.rebuild(), files = await resultBytes(f.directory);
  f.state.enabled = true; f.state.mismatch = true;
  f.state.periods = new Set(["2026-07", "2026-08", "2026-09"]);
  const after = await f.rebuild(), group = visitor(after.snapshot), august = point(after.snapshot, "2026-08");
  assert.notEqual(after.snapshot.resultId, before.snapshot.resultId);
  assert.equal(group.errorCode, "REGION_MISMATCH"); assert.notEqual(group.stale, true);
  assert.equal(august.spatialContract.status, "response_mismatch"); assert.equal(august.status, "error");
  assert.equal(august.value, null); assert.equal(august.referenceValue, 12); assert.equal(august.referenceStatus, "observed");
  assert.equal(rows(after.snapshot).some(row => row.status === "observed"), false);
  assert.equal(after.job.hasObservedData, false);
  const afterFiles = await resultBytes(f.directory);
  for (const [name, bytes] of files) assert.deepEqual(afterFiles.get(name), bytes);
  await f.assertSourcesUnchanged();
});

test("saved-result GET does not inspect original evidence, rebuild or request providers", async t => {
  const f = await fixture(t); f.state.enabled = true;
  const initial = await f.rebuild(), inspections = f.state.verificationCalls, builds = f.state.builds, files = await resultBytes(f.directory);
  await Promise.all(Array.from({ length: 12 }, () => f.store.get(scope("new_county"))));
  const latest = await f.store.get(scope("new_county"));
  assert.equal(latest.snapshot.resultId, initial.snapshot.resultId);
  assert.equal(f.state.verificationCalls, inspections); assert.equal(f.state.builds, builds);
  assert.deepEqual(await resultBytes(f.directory), files);
  await f.assertSourcesUnchanged();
});

test("explicitly disabled stored-evidence inspection reaches both providers without creating proof", async t => {
  const f = await fixture(t); f.state.enabled = true;
  const snapshot = await f.builder(scope("new_county"), { restoreStoredEvidence: false });
  assert.equal(f.state.verificationCalls, 0); assert.equal(snapshot.storedEvidence.requested, false);
  assert.ok(f.state.tourismInputs.length === 4 && f.state.tourismInputs.every(input => input.restoreStoredEvidence === false));
  assert.deepEqual(f.state.kosisOptions, [{ restoreStoredEvidence: false }]);
  assert.equal(point(snapshot, "2026-08").spatialContract.status, "scope_unverified");
  await f.assertSourcesUnchanged();
});
