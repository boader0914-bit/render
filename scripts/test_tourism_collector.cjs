const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");
const {
  createCollector,
  dataGoKrServiceKey,
  sourceServiceKey,
  monthDateRange,
  normalizeYearMonth,
  shiftYearMonth,
  visitorHistoryMonths
} = require("./tourism_collector.cjs");

const SERVICE_KEY_ENV_NAMES = [
  "DATA_GO_KR_VISITOR_SERVICE_KEY",
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

function categoryValues(total) {
  const local = Math.round(total * 0.7);
  const foreign = Math.round(total * 0.05);
  return { "1": local, "2": total - local - foreign, "3": foreign };
}

function visitorHistoryRows(yearMonth) {
  const year = Number(yearMonth.slice(0, 4));
  const month = Number(yearMonth.slice(4, 6));
  const sancheongTotal = 850 + ((year - 2023) * 100) + month;
  const hadongTotal = 550 + ((year - 2023) * 55) + month;
  return visitorRowsForMonth(yearMonth, [
    { code: "48860", name: "산청군", values: categoryValues(sancheongTotal) },
    { code: "48850", name: "하동군", values: categoryValues(hadongTotal) }
  ]);
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
        DATA_GO_KR_VISITOR_SERVICE_KEY: "fixture-visitor-service-key",
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
    assert.equal(configuredStatus.commonServiceKeyConfigured, false);
    assert.equal(visitorStatus.status, "ready");
    assert.equal(visitorStatus.serviceKeyConfigured, true);
    assert.equal(visitorStatus.serviceKeyEnvironment, "DATA_GO_KR_VISITOR_SERVICE_KEY");
    assert.equal(visitorStatus.endpointConfigured, true);
    assert.doesNotMatch(JSON.stringify(configuredStatus), /fixture-visitor-service-key/);

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
      assert.equal(url.searchParams.get("serviceKey"), "fixture-visitor-service-key");
      assert.equal(url.searchParams.has("SGG_CD"), false);
      assert.equal(url.searchParams.has("YM"), false);
    });

    const requestCountBeforeCache = visitorRequests.length;
    const cachedVisitorSnapshot = await visitorCollector.collectVisitorCounts({ yearMonth: "202606", regionNames: ["하동"] });
    assert.equal(cachedVisitorSnapshot.cache.hit, true);
    assert.equal(cachedVisitorSnapshot.regions[0].averageDailyVisitors, 605);
    assert.equal(visitorRequests.length, requestCountBeforeCache);
    assert.doesNotMatch(JSON.stringify(visitorSnapshot), /fixture-visitor-service-key/);

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

    const historyDataDir = path.join(dataDir, "tourism_history_data");
    const historyRequests = [];
    let activeHistoryRequests = 0;
    let maxActiveHistoryRequests = 0;
    let failLatestHistoryMonth = false;
    let repairPartialHistoryMonth = false;
    const historyCollector = createCollector({
      rootDir: tmp,
      webDir,
      dataDir,
      tourismDataDir: historyDataDir,
      env: {
        DATA_GO_KR_VISITOR_SERVICE_KEY: "history-visitor-key",
        KTO_TOURISM_VISITOR_PAGE_SIZE: "10000",
        KTO_TOURISM_VISITOR_HISTORY_CONCURRENCY: "2"
      },
      now: () => new Date("2026-07-15T00:00:00.000Z"),
      fetchImpl: async (requestUrl) => {
        const url = new URL(requestUrl);
        const yearMonth = url.searchParams.get("startYmd").slice(0, 6);
        historyRequests.push(yearMonth);
        activeHistoryRequests += 1;
        maxActiveHistoryRequests = Math.max(maxActiveHistoryRequests, activeHistoryRequests);
        await new Promise((resolve) => setTimeout(resolve, 1));
        activeHistoryRequests -= 1;
        if (yearMonth === "202410" || (failLatestHistoryMonth && yearMonth === "202606")) {
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
        let sourceRows = visitorHistoryRows(yearMonth);
        if (yearMonth === "202511" && !repairPartialHistoryMonth) {
          sourceRows = sourceRows.filter((row) => row.baseYmd !== "20251130");
        }
        const pageNo = Number(url.searchParams.get("pageNo"));
        const pageSize = Number(url.searchParams.get("numOfRows"));
        const offset = (pageNo - 1) * pageSize;
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
                items: { item: sourceRows.slice(offset, offset + pageSize) }
              }
            }
          })
        };
      }
    });

    const emptyHistory = await historyCollector.collectVisitorHistory({
      regionNames: ["산청"],
      months: 36
    });
    assert.equal(emptyHistory.ok, false);
    assert.equal(emptyHistory.status, "unavailable");
    assert.equal(emptyHistory.collection.mode, "cache_only");
    assert.equal(emptyHistory.collection.networkAttemptedMonths, 0);
    assert.equal(emptyHistory.collection.missingCacheMonths, 36);
    assert.equal(emptyHistory.regions[0].coverage.completeMonths, 0);
    assert.equal(emptyHistory.regions[0].series.every((point) => point.status === "missing"), true);
    assert.equal(emptyHistory.regions[0].series.every((point) => point.averageDailyVisitors === null), true);
    assert.equal(historyRequests.length, 0);

    const history = await historyCollector.collectVisitorHistory({
      regionNames: ["산청"],
      months: 36,
      refresh: true
    });
    assert.equal(history.ok, true);
    assert.equal(history.status, "partial");
    assert.deepEqual(history.period, {
      startYearMonth: "202307",
      endYearMonth: "202606",
      months: 36,
      latestClosedYearMonth: "202606"
    });
    assert.equal(history.collection.mode, "backfill_missing");
    assert.equal(history.collection.concurrency, 2);
    assert.equal(history.collection.networkAttemptedMonths, 36);
    assert.equal(history.collection.networkSucceededMonths, 35);
    assert.ok(maxActiveHistoryRequests <= 2);
    const sancheongHistory = history.regions[0];
    assert.equal(sancheongHistory.regionKey, "kr_gyeongnam_sancheong");
    assert.equal(sancheongHistory.series.length, 36);
    assert.equal(sancheongHistory.coverage.completeMonths, 34);
    assert.equal(sancheongHistory.coverage.partialMonths, 1);
    assert.equal(sancheongHistory.coverage.missingMonths, 1);
    assert.equal(sancheongHistory.coverage.coverageRate, 0.9444);
    assert.equal(sancheongHistory.series.find((point) => point.yearMonth === "202410").status, "missing");
    assert.equal(sancheongHistory.series.find((point) => point.yearMonth === "202410").averageDailyVisitors, null);
    assert.equal(sancheongHistory.series.find((point) => point.yearMonth === "202511").status, "partial");
    assert.equal(sancheongHistory.series.find((point) => point.yearMonth === "202511").averageDailyVisitors, null);
    assert.equal(sancheongHistory.latest.yearMonth, "202606");
    assert.equal(sancheongHistory.latest.status, "complete");
    assert.equal(sancheongHistory.latestAvailable.yearMonth, "202606");
    assert.equal(sancheongHistory.yoy.status, "ready");
    assert.ok(sancheongHistory.yoy.changeRate > 0);
    assert.equal(sancheongHistory.recent12VsPrevious12.status, "ready");
    assert.equal(sancheongHistory.recent12VsPrevious12.comparableMonthPairs, 10);
    assert.ok(sancheongHistory.recent12VsPrevious12.changeRate > 0);
    assert.equal(sancheongHistory.visitorOutlookScore.status, "ready");
    assert.equal(sancheongHistory.visitorOutlookScore.eligible, true);
    assert.ok(Number.isFinite(sancheongHistory.visitorOutlookScore.score));
    assert.equal(sancheongHistory.visitorOutlookScore.components.length, 3);
    assert.equal(sancheongHistory.visitorOutlookScore.components[0].key, "latest_peer_percentile");
    assert.equal(sancheongHistory.visitorOutlookScore.components[0].score, 100);
    assert.equal(sancheongHistory.visitorOutlookScore.components[0].source.peerCount, 2);
    assert.equal(history.quality.missingIsNotZero, true);
    assert.equal(history.quality.partialMonthsExcludedFromMetrics, true);
    assert.equal(history.quality.coverageRateUnit, "ratio_0_to_1");
    assert.equal(history.quality.scoreMinimums.minimumCompleteMonths, 24);
    assert.equal(history.quality.scoreMinimums.minimumComparableMonthPairs, 10);
    assert.equal(sancheongHistory.visitorOutlookScore.components[1].source.comparableMonthPairs, 10);
    assert.doesNotMatch(JSON.stringify(history), /history-visitor-key/);

    const requestCountAfterBackfill = historyRequests.length;
    const cachedHistory = await historyCollector.collectVisitorHistory({ regionNames: ["산청"], months: 36 });
    assert.equal(cachedHistory.collection.mode, "cache_only");
    assert.equal(cachedHistory.collection.cacheHitMonths, 35);
    assert.equal(cachedHistory.collection.missingCacheMonths, 1);
    assert.equal(cachedHistory.collection.networkAttemptedMonths, 0);
    assert.equal(historyRequests.length, requestCountAfterBackfill);

    repairPartialHistoryMonth = true;
    const missingOnlyRefresh = await historyCollector.collectVisitorHistory({
      regionNames: ["산청"],
      months: 36,
      collectMissing: true
    });
    assert.equal(missingOnlyRefresh.collection.cacheHitMonths, 34);
    assert.equal(missingOnlyRefresh.collection.networkAttemptedMonths, 2);
    assert.equal(missingOnlyRefresh.collection.networkSucceededMonths, 1);
    assert.equal(missingOnlyRefresh.collection.retriedIncompleteMonths, 1);
    assert.equal(missingOnlyRefresh.regions[0].coverage.completeMonths, 35);
    assert.equal(missingOnlyRefresh.regions[0].coverage.partialMonths, 0);
    assert.equal(historyRequests.length, requestCountAfterBackfill + 2);

    const shortHistory = await historyCollector.collectVisitorHistory({ regionNames: ["산청"], months: 12 });
    assert.equal(shortHistory.regions[0].visitorOutlookScore.status, "insufficient_data");
    assert.equal(shortHistory.regions[0].visitorOutlookScore.score, null);
    assert.ok(shortHistory.regions[0].visitorOutlookScore.reasons.includes("complete_months_below_24"));

    failLatestHistoryMonth = true;
    const preservedHistoryAfterFailedRefresh = await historyCollector.collectVisitorHistory({
      regionNames: ["산청"],
      months: 1,
      force: true
    });
    assert.equal(preservedHistoryAfterFailedRefresh.status, "ok");
    assert.equal(preservedHistoryAfterFailedRefresh.collection.networkFailedMonths, 1);
    assert.equal(preservedHistoryAfterFailedRefresh.collection.refreshErrors[0].yearMonth, "202606");
    assert.equal(preservedHistoryAfterFailedRefresh.regions[0].latest.status, "complete");
    assert.equal(
      preservedHistoryAfterFailedRefresh.regions[0].latest.averageDailyVisitors,
      sancheongHistory.latest.averageDailyVisitors
    );
    const failedForcedLatest = await historyCollector.collectVisitorCounts({
      yearMonth: "202606",
      regionNames: ["산청"],
      force: true
    });
    assert.equal(failedForcedLatest.status, "error");
    const preservedLatest = await historyCollector.collectVisitorCounts({
      yearMonth: "202606",
      regionNames: ["산청"]
    });
    assert.equal(preservedLatest.status, "ok");
    assert.equal(preservedLatest.cache.hit, true);
    assert.equal(preservedLatest.regions[0].averageDailyVisitors, sancheongHistory.latest.averageDailyVisitors);
    failLatestHistoryMonth = false;

    const historyStatus = await historyCollector.status();
    assert.equal(historyStatus.visitorHistory.availableMonthCount, 35);
    assert.equal(historyStatus.visitorHistory.earliestYearMonth, "202307");
    assert.equal(historyStatus.visitorHistory.latestYearMonth, "202606");
    assert.doesNotMatch(JSON.stringify(historyStatus), /history-visitor-key/);

    const unmatchedHistory = await historyCollector.collectVisitorHistory({ regionNames: ["없는지역"], months: 36 });
    assert.equal(unmatchedHistory.status, "region_not_matched");
    assert.equal(unmatchedHistory.regions.length, 0);

    assert.equal(dataGoKrServiceKey({
      DATA_GO_KR_SERVICE_KEY: " canonical-key ",
      KTO_DATA_GO_KR_SERVICE_KEY: "compatibility-key",
      KTO_TOURISM_SERVICE_KEY: "legacy-key"
    }), "canonical-key");
    assert.equal(dataGoKrServiceKey({ KTO_DATA_GO_KR_SERVICE_KEY: "compatibility-key" }), "compatibility-key");
    assert.equal(dataGoKrServiceKey({ KTO_TOURISM_SERVICE_KEY: "legacy-key" }), "legacy-key");
    assert.equal(sourceServiceKey({ serviceKeyEnv: "DATA_GO_KR_VISITOR_SERVICE_KEY" }, {
      DATA_GO_KR_VISITOR_SERVICE_KEY: "visitor-key",
      DATA_GO_KR_SERVICE_KEY: "common-key"
    }), "visitor-key");
    assert.equal(sourceServiceKey({ serviceKeyEnv: "DATA_GO_KR_VISITOR_SERVICE_KEY" }, {
      DATA_GO_KR_SERVICE_KEY: "common-key"
    }), "common-key");

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
      assert.match(contents, /- key: DATA_GO_KR_VISITOR_SERVICE_KEY\r?\n\s+sync: false/);
      assert.doesNotMatch(contents, /- key: DATA_GO_KR_VISITOR_SERVICE_KEY\r?\n\s+value:/);
    }

    assert.equal(normalizeYearMonth("2026.06"), "202606");
    assert.notEqual(normalizeYearMonth("2026.13"), "202613");
    assert.deepEqual(monthDateRange("202402"), {
      yearMonth: "202402",
      startYmd: "20240201",
      endYmd: "20240229",
      expectedDays: 29
    });
    assert.equal(shiftYearMonth("202601", -1), "202512");
    assert.deepEqual(visitorHistoryMonths("202606", 3), ["202604", "202605", "202606"]);
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
