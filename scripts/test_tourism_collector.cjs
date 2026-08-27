const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");
const {
  createCollector,
  dataGoKrServiceKey,
  monthDateRange,
  normalizeYearMonth
} = require("./tourism_collector.cjs");

const SERVICE_KEY_ENV_NAMES = [
  "DATA_GO_KR_SERVICE_KEY",
  "KTO_DATA_GO_KR_SERVICE_KEY",
  "KTO_TOURISM_SERVICE_KEY"
];

function withoutServiceKeyEnv() {
  const previous = Object.fromEntries(SERVICE_KEY_ENV_NAMES.map((name) => [name, process.env[name]]));
  SERVICE_KEY_ENV_NAMES.forEach((name) => delete process.env[name]);
  return () => {
    SERVICE_KEY_ENV_NAMES.forEach((name) => {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    });
  };
}

function visitorRowsForMonth(yearMonth, regions) {
  const { expectedDays } = monthDateRange(yearMonth);
  const labels = { "1": "현지인(a)", "2": "외지인(b)", "3": "외국인(c)" };
  return regions.flatMap((region) => Array.from({ length: expectedDays }, (_, index) => {
    const baseYmd = `${yearMonth}${String(index + 1).padStart(2, "0")}`;
    return ["1", "2", "3"].map((touDivCd) => ({
      baseYmd,
      signguCode: region.code,
      signguNm: region.name,
      daywkDivCd: String((index % 7) + 1),
      daywkDivNm: "",
      touDivCd,
      touDivNm: labels[touDivCd],
      touNum: String(region.values[touDivCd])
    }));
  }).flat());
}

async function main() {
  const restoreServiceKeyEnv = withoutServiceKeyEnv();
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "tourism-collector-"));
  try {
    const webDir = path.join(tmp, "web");
    const dataDir = path.join(tmp, "data");
    await fsp.mkdir(path.join(webDir, "data"), { recursive: true });
    await fsp.copyFile(
      path.join(__dirname, "..", "web", "data", "tourism_region_map.json"),
      path.join(webDir, "data", "tourism_region_map.json")
    );

    const collector = createCollector({
      rootDir: tmp,
      webDir,
      dataDir,
      tourismDataDir: path.join(dataDir, "tourism_data")
    });

    const status = await collector.status();
    assert.equal(status.ok, true);
    assert.ok(status.regionMap.regionCount >= 40);
    assert.equal(status.serviceKeyConfigured, false);

    const match = await collector.resolveRegion({ keyword: "하동풀빌라" });
    assert.equal(match.region.regionKey, "kr_gyeongnam_hadong");
    assert.equal(match.region.ktoSggCd, "48850");

    const snapshot = await collector.collect({ keyword: "하동풀빌라", yearMonth: "202606", force: true });
    assert.equal(snapshot.ok, true);
    assert.equal(snapshot.region.regionKey, "kr_gyeongnam_hadong");
    assert.equal(snapshot.yearMonth, "202606");
    assert.equal(Object.keys(snapshot.sources).length, 3);
    assert.equal(snapshot.sources.visitors.status, "skipped");
    assert.equal(snapshot.sources.visitors.reason, "missing_service_key");

    const cached = await collector.collect({ keyword: "하동풀빌라", yearMonth: "202606" });
    assert.equal(cached.cache.hit, true);

    const visitorRequests = [];
    const visitorRows = visitorRowsForMonth("202606", [
      { code: "48860", name: "산청군", values: { "1": 1000, "2": 200, "3": 10 } },
      { code: "48850", name: "하동군", values: { "1": 500, "2": 100, "3": 5 } }
    ]);
    const partialVisitorRows = visitorRowsForMonth("202605", [
      { code: "48860", name: "산청군", values: { "1": 900, "2": 180, "3": 9 } }
    ]).filter((row) => row.baseYmd !== "20260531");
    const visitorCollector = createCollector({
      rootDir: tmp,
      webDir,
      dataDir,
      tourismDataDir: path.join(dataDir, "tourism_data"),
      env: {
        DATA_GO_KR_SERVICE_KEY: "fixture-service-key",
        KTO_TOURISM_VISITOR_PAGE_SIZE: "100"
      },
      now: () => new Date("2026-07-15T00:00:00.000Z"),
      fetchImpl: async (requestUrl) => {
        const url = new URL(requestUrl);
        visitorRequests.push(url);
        if (url.searchParams.get("startYmd") === "20260401") {
          return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify({
              response: {
                header: { resultCode: "30", resultMsg: "SERVICE_KEY_IS_NOT_REGISTERED_ERROR" },
                body: {}
              }
            })
          };
        }
        const sourceRows = url.searchParams.get("startYmd") === "20260501" ? partialVisitorRows : visitorRows;
        const pageNo = Number(url.searchParams.get("pageNo"));
        const pageSize = Number(url.searchParams.get("numOfRows"));
        const offset = (pageNo - 1) * pageSize;
        const pageRows = sourceRows.slice(offset, offset + pageSize);
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({
            response: {
              header: { resultCode: "0000", resultMsg: "OK" },
              body: {
                pageNo,
                numOfRows: pageSize,
                totalCount: sourceRows.length,
                items: { item: pageRows }
              }
            }
          })
        };
      }
    });

    const configuredStatus = await visitorCollector.status();
    const visitorStatus = configuredStatus.sources.find((source) => source.key === "visitors");
    assert.equal(configuredStatus.serviceKeyConfigured, true);
    assert.equal(visitorStatus.status, "ready");
    assert.equal(visitorStatus.endpointConfigured, true);
    assert.doesNotMatch(JSON.stringify(configuredStatus), /fixture-service-key/);

    const visitorSnapshot = await visitorCollector.collectVisitorCounts({
      yearMonth: "202606",
      regionNames: ["산청"],
      force: true
    });
    assert.equal(visitorSnapshot.ok, true);
    assert.equal(visitorSnapshot.status, "ok");
    assert.equal(visitorSnapshot.regions.length, 1);
    assert.equal(visitorSnapshot.regions[0].regionKey, "kr_gyeongnam_sancheong");
    assert.equal(visitorSnapshot.regions[0].quality.status, "complete");
    assert.equal(visitorSnapshot.regions[0].observedDays, 30);
    assert.equal(visitorSnapshot.regions[0].averageDailyVisitors, 1210);
    assert.equal(visitorSnapshot.policy.scoreApplied, false);
    assert.equal(visitorSnapshot.policy.noSidoSigunguAggregation, true);
    assert.ok(visitorRequests.length >= 2);
    visitorRequests.forEach((url) => {
      assert.equal(url.origin, "https://apis.data.go.kr");
      assert.equal(url.pathname, "/B551011/DataLabService/locgoRegnVisitrDDList");
      assert.equal(url.searchParams.get("MobileOS"), "ETC");
      assert.equal(url.searchParams.get("MobileApp"), "lodging-datalab");
      assert.equal(url.searchParams.get("startYmd"), "20260601");
      assert.equal(url.searchParams.get("endYmd"), "20260630");
      assert.equal(url.searchParams.get("serviceKey"), "fixture-service-key");
      assert.equal(url.searchParams.has("SGG_CD"), false);
      assert.equal(url.searchParams.has("YM"), false);
    });

    const requestCountBeforeCache = visitorRequests.length;
    const cachedVisitorSnapshot = await visitorCollector.collectVisitorCounts({ yearMonth: "202606", regionNames: ["하동"] });
    assert.equal(cachedVisitorSnapshot.cache.hit, true);
    assert.equal(cachedVisitorSnapshot.regions[0].averageDailyVisitors, 605);
    assert.equal(visitorRequests.length, requestCountBeforeCache);
    assert.doesNotMatch(JSON.stringify(visitorSnapshot), /fixture-service-key/);

    const partialVisitorSnapshot = await visitorCollector.collectVisitorCounts({
      yearMonth: "202605",
      regionNames: ["산청"],
      force: true
    });
    assert.equal(partialVisitorSnapshot.status, "ok");
    assert.equal(partialVisitorSnapshot.regions[0].quality.status, "partial");
    assert.equal(partialVisitorSnapshot.regions[0].observedDays, 30);
    assert.equal(partialVisitorSnapshot.regions[0].expectedDays, 31);
    assert.equal(partialVisitorSnapshot.regions[0].averageDailyVisitors, null);

    const apiErrorSnapshot = await visitorCollector.collectVisitorCounts({
      yearMonth: "202604",
      regionNames: ["산청"],
      force: true
    });
    assert.equal(apiErrorSnapshot.ok, false);
    assert.equal(apiErrorSnapshot.status, "error");
    assert.equal(apiErrorSnapshot.reason, "api_error");
    assert.equal(apiErrorSnapshot.regions.length, 0);

    assert.equal(dataGoKrServiceKey({
      DATA_GO_KR_SERVICE_KEY: " canonical-key ",
      KTO_DATA_GO_KR_SERVICE_KEY: "compatibility-key",
      KTO_TOURISM_SERVICE_KEY: "legacy-key"
    }), "canonical-key");
    assert.equal(dataGoKrServiceKey({ KTO_DATA_GO_KR_SERVICE_KEY: "compatibility-key" }), "compatibility-key");
    assert.equal(dataGoKrServiceKey({ KTO_TOURISM_SERVICE_KEY: "legacy-key" }), "legacy-key");

    const renderFiles = [
      "render.yaml",
      "render.persistent.yaml",
      "render.v2.yaml",
      "render.v2.persistent.yaml"
    ];
    for (const renderFile of renderFiles) {
      const contents = await fsp.readFile(path.join(__dirname, "..", renderFile), "utf8");
      assert.match(contents, /- key: DATA_GO_KR_SERVICE_KEY\r?\n\s+sync: false/);
      assert.doesNotMatch(contents, /- key: DATA_GO_KR_SERVICE_KEY\r?\n\s+value:/);
    }

    assert.equal(normalizeYearMonth("2026.06"), "202606");
    assert.notEqual(normalizeYearMonth("2026.13"), "202613");
    assert.deepEqual(monthDateRange("202402"), {
      yearMonth: "202402",
      startYmd: "20240201",
      endYmd: "20240229",
      expectedDays: 29
    });
    assert.ok(fs.existsSync(path.join(dataDir, "tourism_data", "collections.jsonl")));
    console.log("Tourism collector tests passed");
  } finally {
    restoreServiceKeyEnv();
    await fsp.rm(tmp, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
