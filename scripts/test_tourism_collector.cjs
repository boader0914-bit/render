const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");
const { createCollector, normalizeYearMonth } = require("./tourism_collector.cjs");

global.fetch = async (url) => {
  throw new Error(`External requests are forbidden in tourism collector fixtures: ${url}`);
};

async function main() {
  const fixedNow = new Date("2026-08-05T00:00:00.000Z");
  let forbiddenNetworkCalls = 0;
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "tourism-collector-"));
  const webDir = path.join(tmp, "web");
  const dataDir = path.join(tmp, "data");
  await fsp.mkdir(path.join(webDir, "data"), { recursive: true });
  await fsp.copyFile(
    path.join(__dirname, "..", "web", "data", "tourism_region_map.json"),
    path.join(webDir, "data", "tourism_region_map.json")
  );
  await fsp.copyFile(
    path.join(__dirname, "..", "web", "data", "location_region_registry.json"),
    path.join(webDir, "data", "location_region_registry.json")
  );

  const collector = createCollector({
    rootDir: tmp,
    webDir,
    dataDir,
    tourismDataDir: path.join(dataDir, "tourism_data"),
    env: {},
    now: () => fixedNow,
    fetch: async () => {
      forbiddenNetworkCalls += 1;
      throw new Error("Network is forbidden for the unconfigured collector test");
    }
  });

  const status = await collector.status();
  assert.equal(status.ok, true);
  assert.equal(status.schemaVersion, 2);
  assert.equal(status.contractVersion, "location-insight.observation.v2");
  assert.ok(status.regionMap.regionCount >= 40);
  assert.equal(status.regionRegistry.version, "location-region-registry-v1.0.0");
  assert.equal(status.regionRegistry.regionCount, 48);
  assert.equal(status.serviceKeyConfigured, false);

  const match = await collector.resolveRegion({ keyword: "경남 하동풀빌라" });
  assert.equal(match.status, "matched");
  assert.equal(match.reason, "sido_alias_exact");
  assert.equal(match.region.regionKey, "kr_gyeongnam_hadong");
  assert.equal(match.region.ktoSggCd, "48850");

  const standaloneAlias = await collector.resolveRegion({ keyword: "하동풀빌라" });
  assert.equal(standaloneAlias.status, "unmatched");
  assert.equal(standaloneAlias.reason, "sido_context_required");
  assert.equal(standaloneAlias.region, null);

  const ambiguous = await collector.collect({ keyword: "고성", yearMonth: "202606", force: true });
  assert.equal(ambiguous.ok, false);
  assert.equal(ambiguous.status, "region_not_matched");
  assert.equal(ambiguous.matchStatus, "ambiguous");
  assert.equal(ambiguous.reason, "alias_ambiguous");
  assert.deepEqual(
    ambiguous.candidates.map((row) => row.regionKey).sort(),
    ["kr_gangwon_goseong", "kr_gyeongnam_goseong"]
  );

  const unknown = await collector.collect({ keyword: "모르는지역", yearMonth: "202606", force: true });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.matchStatus, "unmatched");
  assert.equal(unknown.reason, "region_unmatched");

  const missingKtoCode = await collector.collect({
    keyword: "경남 고성",
    yearMonth: "202606",
    force: true,
    allowUnverifiedCodes: true
  });
  assert.equal(missingKtoCode.ok, true);
  assert.equal(missingKtoCode.region.regionKey, "kr_gyeongnam_goseong");
  assert.equal(missingKtoCode.sources.visitors.status, "skipped");
  assert.equal(missingKtoCode.sources.visitors.reason, "region_code_missing");

  const snapshot = await collector.collect({ keyword: "경남 하동풀빌라", yearMonth: "202606", force: true });
  assert.equal(snapshot.ok, true);
  assert.equal(snapshot.region.regionKey, "kr_gyeongnam_hadong");
  assert.equal(snapshot.match.status, "matched");
  assert.equal(snapshot.match.matchType, "sido_alias_exact");
  assert.equal(snapshot.match.registryVersion, "location-region-registry-v1.0.0");
  assert.equal(snapshot.yearMonth, "202606");
  assert.equal(Object.keys(snapshot.sources).length, 3);
  assert.equal(snapshot.sources.visitors.status, "skipped");
  assert.equal(snapshot.sources.visitors.reason, "missing_service_key");
  assert.equal(snapshot.sources.visitors.quality.status, "missing");
  assert.equal(snapshot.schemaVersion, 2);
  assert.equal(snapshot.documentType, "tourism-collection-snapshot");
  assert.equal(forbiddenNetworkCalls, 0, "an empty injected environment must never inherit real API credentials");

  const cached = await collector.collect({ keyword: "경남 하동풀빌라", yearMonth: "202606" });
  assert.equal(cached.cache.hit, true);

  assert.equal(normalizeYearMonth("2026.06"), "202606");
  assert.throws(() => normalizeYearMonth("2026-13"), /valid calendar month/, "invalid periods must fail closed instead of silently selecting another month");
  assert.ok(fs.existsSync(path.join(dataDir, "tourism_data", "collections.jsonl")));

  const requestedUrls = [];
  const fixturePayloads = {
    "202606": {
      response: {
        header: { resultCode: "00", resultMsg: "NORMAL SERVICE" },
        body: { pageNo: 1, numOfRows: 2, totalCount: 3, items: { item: [{ value: 1 }, { value: 2 }] } }
      }
    },
    "202607": {
      response: {
        header: { resultCode: "00", resultMsg: "NORMAL SERVICE" },
        body: { pageNo: 1, numOfRows: 100, totalCount: 0, items: {} }
      }
    },
    "202608": {
      response: {
        header: { resultCode: "30", resultMsg: "SERVICE KEY ERROR" },
        body: { pageNo: 1, numOfRows: 100, totalCount: 0, items: {} }
      }
    },
    "202609": {
      response: {
        header: { resultCode: "00", resultMsg: "NORMAL SERVICE" },
        body: { pageNo: 1, numOfRows: 100, items: { item: { value: 0 } } }
      }
    },
    "202610": {
      response: {
        header: { resultCode: "00", resultMsg: "NORMAL SERVICE" },
        body: { pageNo: 1, numOfRows: 2, totalCount: 2, items: { item: [{ value: 0 }, { value: 3 }] } }
      }
    }
  };
  const fixtureCollector = createCollector({
    rootDir: tmp,
    webDir,
    dataDir,
    tourismDataDir: path.join(dataDir, "tourism_fixture_data"),
    env: {
      KTO_TOURISM_SERVICE_KEY: "sentinel-secret-key",
      KTO_TOURISM_VISITOR_ENDPOINT: "https://fixture.invalid/visitors"
    },
    now: () => fixedNow,
    fetch: async (url) => {
      requestedUrls.push(String(url));
      const yearMonth = new URL(String(url)).searchParams.get("YM");
      const payload = fixturePayloads[yearMonth];
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify(payload)
      };
    }
  });

  const collectFixture = (yearMonth) => fixtureCollector.collect({
    regionKey: "kr_gyeongnam_hadong",
    yearMonth,
    sources: ["visitors"],
    force: true
  });
  const partial = await collectFixture("202606");
  assert.equal(partial.status, "partial");
  assert.equal(partial.sources.visitors.quality.status, "partial");
  assert.equal(partial.sources.visitors.responseMeta.coverageRatio, 0.6667);
  assert.equal(partial.sources.visitors.responseMeta.complete, false);

  const zero = await collectFixture("202607");
  assert.equal(zero.status, "zero");
  assert.equal(zero.sources.visitors.rows.length, 0, "an empty items envelope must not become a fake row");
  assert.equal(zero.sources.visitors.quality.status, "zero", "confirmed complete zero is distinct from missing");

  const apiError = await collectFixture("202608");
  assert.equal(apiError.status, "missing");
  assert.equal(apiError.sources.visitors.status, "error", "HTTP 200 must not hide an API-level error code");
  assert.equal(apiError.sources.visitors.quality.status, "missing");

  const unknownCoverage = await collectFixture("202609");
  assert.equal(unknownCoverage.sources.visitors.rows[0].value, 0, "a measured numeric zero must be preserved");
  assert.equal(unknownCoverage.sources.visitors.quality.status, "partial");

  const ready = await collectFixture("202610");
  assert.equal(ready.status, "ready");
  assert.equal(ready.sources.visitors.quality.status, "ready");
  assert.equal(ready.sources.visitors.responseMeta.complete, true);
  assert.equal(requestedUrls.length, 5);
  assert.equal(JSON.stringify([partial, zero, apiError, unknownCoverage, ready]).includes("sentinel-secret-key"), false, "credentials must not enter snapshots");

  await fsp.rm(tmp, { recursive: true, force: true });
  console.log("Tourism collector tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
