const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
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
  "DATA_GO_KR_DEMAND_STRENGTH_SERVICE_KEY",
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

function demandStrengthRows(yearMonth, operation, options = {}) {
  const base = {
    baseYm: yearMonth,
    areaCd: options.areaCd || "48",
    areaNm: options.areaNm || "경상남도",
    signguCd: options.signguCd || "48860",
    signguNm: options.signguNm || "산청군"
  };
  const yearOffset = Number(yearMonth.slice(0, 4)) - 2023;
  const monthOffset = Number(yearMonth.slice(4, 6)) / 100;
  if (operation === "areaTarSjrnDsList") {
    const values = {
      "21": 60 + (yearOffset * 4) + monthOffset,
      "2101": 61 + yearOffset,
      "2102": 62 + yearOffset,
      "2103": 63 + yearOffset,
      "2104": 64 + yearOffset,
      "2105": 65 + yearOffset
    };
    const labels = {
      "21": "관광 체류 강도 전체",
      "2101": "타권역 방문자 비중",
      "2102": "숙박 비중",
      "2103": "1박 방문자수",
      "2104": "2박 방문자수",
      "2105": "3박 방문자수"
    };
    return Object.entries(values)
      .filter(([code]) => !(options.omitCodes || []).includes(code))
      .map(([tarSjrnDsIxCd, tarSjrnDsIxVal]) => ({
        ...base,
        tarSjrnDsIxCd,
        tarSjrnDsIxNm: labels[tarSjrnDsIxCd],
        tarSjrnDsIxVal: String(tarSjrnDsIxVal)
      }));
  }
  const values = {
    "22": 55 + (yearOffset * 3) + monthOffset,
    "2201": 56 + yearOffset,
    "2202": 57 + yearOffset,
    "2203": 58 + yearOffset
  };
  const labels = {
    "22": "관광 소비 강도 전체",
    "2201": "외지인 소비액",
    "2202": "전체 대비 외지인 소비액 비중",
    "2203": "방문량 대비 방문 소비액"
  };
  return Object.entries(values)
    .filter(([code]) => !(options.omitCodes || []).includes(code))
    .map(([tarExpDsIxCd, tarExpDsIxVal]) => ({
      ...base,
      tarExpDsIxCd,
      tarExpDsIxNm: labels[tarExpDsIxCd],
      tarExpDsIxVal: String(tarExpDsIxVal)
    }));
}

async function main() {
  const restoreServiceKeyEnv = withoutServiceKeyEnv();
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "tourism-collector-"));
  try {
    assert.equal(visitorHistoryMonths("202606", 120).length, 36);
    assert.equal(visitorHistoryMonths("202606", 120)[0], "202307");
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
    assert.equal(Object.keys(snapshot.sources).length, 4);
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
    assert.equal(visitorSnapshot.regions[0].visitorDays, 36300);
    assert.deepEqual(visitorSnapshot.regions[0].categoryVisitorDays, {
      "1": 30000,
      "2": 6000,
      "3": 300
    });
    assert.equal(visitorSnapshot.evidence.status, "stored");
    assert.equal(visitorSnapshot.evidence.serviceKeyStored, false);
    const visitorEvidenceFile = path.join(dataDir, "tourism_data", visitorSnapshot.evidence.relativePath);
    const visitorEvidence = JSON.parse(await fsp.readFile(visitorEvidenceFile, "utf8"));
    assert.equal(visitorEvidence.request.requestGrain, "month_all_regions");
    assert.equal(visitorEvidence.response.totalCount, visitorRows.length);
    assert.equal(visitorEvidence.response.rows.length, visitorRows.length);
    assert.equal(visitorEvidence.security.serviceKeyStored, false);
    assert.equal(visitorEvidence.security.requestUrlStored, false);
    assert.equal(
      crypto.createHash("sha256").update(JSON.stringify(visitorEvidence)).digest("hex"),
      visitorSnapshot.evidence.sha256
    );
    assert.doesNotMatch(JSON.stringify(visitorEvidence), /fixture-visitor-service-key/);
    assert.equal(visitorSnapshot.policy.scoreApplied, false);
    assert.equal(visitorSnapshot.policy.noSidoSigunguAggregation, true);
    assert.equal(visitorSnapshot.policy.monthlyCacheSharedAcrossRegions, true);
    assert.equal(visitorSnapshot.policy.requestGrain, "month_all_regions");
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

    const cacheOnlyMissing = await visitorCollector.collectVisitorCounts({
      yearMonth: "202603",
      regionNames: ["산청"],
      cacheOnly: true
    });
    assert.equal(cacheOnlyMissing.status, "unavailable");
    assert.equal(cacheOnlyMissing.reason, "monthly_cache_missing");
    assert.equal(cacheOnlyMissing.cache.hit, false);
    assert.equal(visitorRequests.length, requestCountBeforeCache, "캐시 전용 조회는 외부 API를 호출하면 안 됩니다.");

    const cacheReaderWithoutKey = createCollector({
      rootDir: tmp,
      webDir,
      dataDir,
      tourismDataDir: path.join(dataDir, "tourism_data"),
      env: {},
      now: () => new Date("2026-07-15T00:00:00.000Z"),
      fetchImpl: async () => {
        throw new Error("cache-only reader attempted a network request");
      }
    });
    const cachedWithoutKey = await cacheReaderWithoutKey.collectVisitorCounts({
      yearMonth: "202606",
      regionNames: ["산청"],
      cacheOnly: true
    });
    assert.equal(cachedWithoutKey.status, "ok");
    assert.equal(cachedWithoutKey.cache.hit, true);
    assert.equal(cachedWithoutKey.regions[0].visitorDays, 36300);

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
    let repairMissingHistoryMonth = false;
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
        if ((yearMonth === "202410" && !repairMissingHistoryMonth) || (failLatestHistoryMonth && yearMonth === "202606")) {
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
    assert.equal(emptyHistory.regions[0].rolling12.target.period.startYearMonth, "202508");
    assert.equal(emptyHistory.regions[0].rolling12.target.period.endYearMonth, "202607");
    assert.equal(emptyHistory.regions[0].rolling12.target.coverage.completeMonths, 0);
    assert.equal(emptyHistory.regions[0].rolling12.target.totalVisitors, null);
    assert.equal(emptyHistory.regions[0].rolling12.confirmed.totalVisitors, null);
    assert.equal(emptyHistory.regions[0].rolling12.comparison.status, "insufficient_data");
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
      latestClosedYearMonth: "202606",
      rollingTargetYearMonth: "202607"
    });
    assert.equal(history.collection.mode, "backfill_missing");
    assert.equal(history.collection.requestGrain, "month_all_regions");
    assert.equal(history.collection.regionRequestsPerMonth, 0);
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
    assert.equal(sancheongHistory.rolling12.target.period.startYearMonth, "202508");
    assert.equal(sancheongHistory.rolling12.target.period.endYearMonth, "202607");
    assert.equal(sancheongHistory.rolling12.target.coverage.completeMonths, 10);
    assert.equal(sancheongHistory.rolling12.target.coverage.partialMonths, 1);
    assert.deepEqual(sancheongHistory.rolling12.target.coverage.missingYearMonths, ["202607"]);
    assert.equal(sancheongHistory.rolling12.target.totalVisitors, null);
    assert.equal(sancheongHistory.rolling12.confirmed.period.startYearMonth, "202507");
    assert.equal(sancheongHistory.rolling12.confirmed.period.endYearMonth, "202606");
    assert.equal(sancheongHistory.rolling12.confirmed.status, "incomplete");
    assert.equal(sancheongHistory.rolling12.confirmed.totalVisitors, null);
    assert.equal(sancheongHistory.rolling12.previous.period.startYearMonth, "202407");
    assert.equal(sancheongHistory.rolling12.previous.period.endYearMonth, "202506");
    assert.equal(sancheongHistory.rolling12.comparison.status, "insufficient_data");
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

    repairMissingHistoryMonth = true;
    const completeHistory = await historyCollector.collectVisitorHistory({
      regionNames: ["산청"],
      months: 36,
      collectMissing: true
    });
    const completeRolling = completeHistory.regions[0].rolling12;
    assert.equal(completeHistory.status, "ok");
    assert.equal(completeHistory.coverage.completeRegionMonths, 36);
    assert.equal(completeRolling.target.status, "incomplete");
    assert.equal(completeRolling.target.coverage.completeMonths, 11);
    assert.equal(completeRolling.target.coverage.missingMonths, 1);
    assert.equal(completeRolling.target.totalVisitors, null);
    assert.equal(completeRolling.latestCompleteYearMonth, "202606");
    assert.equal(completeRolling.confirmed.status, "ready");
    assert.equal(completeRolling.confirmed.coverage.completeMonths, 12);
    assert.ok(Number.isFinite(completeRolling.confirmed.totalVisitors));
    assert.equal(completeRolling.confirmed.categoryTotals.status, "ready");
    assert.equal(
      Object.values(completeRolling.confirmed.categoryTotals.categories)
        .reduce((sum, category) => sum + category.visitorCount, 0),
      completeRolling.confirmed.totalVisitors
    );
    assert.equal(completeRolling.previous.status, "ready");
    assert.equal(completeRolling.previous.coverage.completeMonths, 12);
    assert.equal(completeRolling.comparison.status, "ready");
    assert.ok(Number.isFinite(completeRolling.comparison.changeRate));
    assert.ok(completeRolling.comparison.changePercent > 0);
    assert.equal(completeRolling.policy.completeMonthsRequired, 12);
    assert.equal(completeRolling.policy.incompleteWindowTotalIsNull, true);
    assert.equal(completeRolling.policy.previousWindowNonOverlapping, true);

    const historyRequestCountBeforeSecondRegion = historyRequests.length;
    const cachedHadongHistory = await historyCollector.collectVisitorHistory({ regionNames: ["하동"], months: 36 });
    assert.equal(cachedHadongHistory.regions[0].rolling12.confirmed.status, "ready");
    assert.equal(historyRequests.length, historyRequestCountBeforeSecondRegion);

    const shortHistory = await historyCollector.collectVisitorHistory({ regionNames: ["산청"], months: 12 });
    assert.equal(shortHistory.regions[0].visitorOutlookScore.status, "insufficient_data");
    assert.equal(shortHistory.regions[0].visitorOutlookScore.score, null);
    assert.ok(shortHistory.regions[0].visitorOutlookScore.reasons.includes("complete_months_below_24"));

    const historyEvidenceDir = path.join(historyDataDir, "evidence", "visitors");
    const evidenceCountBeforeFailedRefresh = (await fsp.readdir(historyEvidenceDir)).length;
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
    assert.equal((await fsp.readdir(historyEvidenceDir)).length, evidenceCountBeforeFailedRefresh);
    failLatestHistoryMonth = false;

    const historyStatus = await historyCollector.status();
    assert.equal(historyStatus.visitorHistory.availableMonthCount, 36);
    assert.equal(historyStatus.visitorHistory.earliestYearMonth, "202307");
    assert.equal(historyStatus.visitorHistory.latestYearMonth, "202606");
    assert.doesNotMatch(JSON.stringify(historyStatus), /history-visitor-key/);

    const unmatchedHistory = await historyCollector.collectVisitorHistory({ regionNames: ["없는지역"], months: 36 });
    assert.equal(unmatchedHistory.status, "region_not_matched");
    assert.equal(unmatchedHistory.regions.length, 0);

    const demandDataDir = path.join(dataDir, "tourism_demand_strength_data");
    const demandRequests = [];
    let failDemandMonth = "";
    const demandCollector = createCollector({
      rootDir: tmp,
      webDir,
      dataDir,
      tourismDataDir: demandDataDir,
      env: {
        DATA_GO_KR_DEMAND_STRENGTH_SERVICE_KEY: "fixture-demand-strength-key",
        KTO_TOURISM_DEMAND_STRENGTH_PAGE_SIZE: "100"
      },
      now: () => new Date("2026-07-15T00:00:00.000Z"),
      fetchImpl: async (requestUrl) => {
        const url = new URL(requestUrl);
        const operation = url.pathname.split("/").at(-1);
        const yearMonth = url.searchParams.get("baseYm");
        demandRequests.push({ url, operation, yearMonth });
        const expectedOverallCode = operation === "areaTarSjrnDsList" ? "21" : "22";
        const codeParam = operation === "areaTarSjrnDsList" ? "tarSjrnDsIxCd" : "tarExpDsIxCd";
        if (yearMonth === "202606" && url.searchParams.get(codeParam) !== expectedOverallCode) {
          return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify({
              response: {
                header: { resultCode: "03", resultMsg: "NODATA_ERROR" },
                body: {}
              }
            })
          };
        }
        if (yearMonth === failDemandMonth || (yearMonth === "202605" && operation === "areaTarExpDsList")) {
          return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify({
              response: {
                header: { resultCode: "05", resultMsg: "SERVICETIMEOUT_ERROR" },
                body: {}
              }
            })
          };
        }
        const options = {};
        if (yearMonth === "202603" && operation === "areaTarSjrnDsList") options.omitCodes = ["2105"];
        if (yearMonth === "202602" && operation === "areaTarSjrnDsList") options.omitCodes = ["21"];
        if (yearMonth === "202601") options.areaCd = "47";
        let rows = demandStrengthRows(yearMonth, operation, options);
        if (yearMonth === "202606") {
          const codeField = operation === "areaTarSjrnDsList" ? "tarSjrnDsIxCd" : "tarExpDsIxCd";
          rows = rows.filter((row) => row[codeField] === expectedOverallCode);
        }
        if (yearMonth === "202604") {
          const nameField = operation === "areaTarSjrnDsList" ? "tarSjrnDsIxNm" : "tarExpDsIxNm";
          rows.forEach((row) => {
            delete row.areaNm;
            delete row.signguCd;
            delete row[nameField];
          });
        }
        if (yearMonth === "202512") {
          rows.forEach((row) => {
            delete row.signguCd;
            delete row.signguNm;
          });
        }
        const pageNo = Number(url.searchParams.get("pageNo"));
        const pageSize = Number(url.searchParams.get("numOfRows"));
        const offset = (pageNo - 1) * pageSize;
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({
            response: {
              header: { resultCode: "00", resultMsg: "NORMAL_CODE" },
              body: {
                pageNo,
                numOfRows: pageSize,
                totalCount: rows.length,
                items: { item: rows.slice(offset, offset + pageSize) }
              }
            }
          })
        };
      }
    });

    const demandStatusBefore = await demandCollector.status();
    const demandSourceStatus = demandStatusBefore.sources.find((source) => source.key === "demandStrength");
    assert.equal(demandSourceStatus.status, "ready");
    assert.equal(demandSourceStatus.serviceKeyEnvironment, "DATA_GO_KR_DEMAND_STRENGTH_SERVICE_KEY");
    assert.equal(demandSourceStatus.adapter, "area-tar-dem-ds-v1");
    assert.equal(demandSourceStatus.normalizerVersion, "demand-strength-row-normalizer-v3");
    assert.equal(demandSourceStatus.requestProfile, "overall-index-filter-v1");
    assert.deepEqual(demandSourceStatus.operations, ["areaTarSjrnDsList", "areaTarExpDsList"]);
    assert.doesNotMatch(JSON.stringify(demandStatusBefore), /fixture-demand-strength-key/);

    const demandCacheMiss = await demandCollector.readDemandStrength({ regionName: "산청", yearMonth: "202606" });
    assert.equal(demandCacheMiss.status, "unavailable");
    assert.equal(demandCacheMiss.reason, "monthly_cache_missing");
    assert.equal(demandCacheMiss.collection.mode, "cache_only");
    assert.equal(demandCacheMiss.collection.operationCallsAttempted, 0);
    assert.equal(demandRequests.length, 0);

    const demandSnapshot = await demandCollector.collectDemandStrength({ regionName: "산청", yearMonth: "202606" });
    assert.equal(demandSnapshot.ok, true);
    assert.equal(demandSnapshot.status, "ok");
    assert.equal(demandSnapshot.region.regionKey, "kr_gyeongnam_sancheong");
    assert.equal(demandSnapshot.region.areaCd, "48");
    assert.equal(demandSnapshot.region.signguCd, "48860");
    assert.equal(demandSnapshot.stay.status, "ok");
    assert.equal(demandSnapshot.spend.status, "ok");
    assert.ok(Number.isFinite(demandSnapshot.stay.overallValue));
    assert.ok(Number.isFinite(demandSnapshot.spend.overallValue));
    assert.equal(demandSnapshot.stay.metrics.find((metric) => metric.code === "21").value, demandSnapshot.stay.overallValue);
    assert.equal(demandSnapshot.spend.metrics.find((metric) => metric.code === "22").value, demandSnapshot.spend.overallValue);
    assert.equal(demandSnapshot.quality.completeOperationCount, 2);
    assert.equal(demandSnapshot.quality.detailCompleteOperationCount, 0);
    assert.equal(demandSnapshot.collection.operationCallsAttempted, 2);
    assert.equal(demandSnapshot.collection.maxPagesPerOperation, 10);
    assert.equal(demandSnapshot.policy.missingIsNotZero, true);
    assert.equal(demandRequests.length, 2);
    demandRequests.forEach(({ url, operation }) => {
      assert.equal(url.origin, "https://apis.data.go.kr");
      assert.equal(url.pathname, `/B551011/AreaTarDemDsService/${operation}`);
      assert.equal(url.searchParams.get("serviceKey"), "fixture-demand-strength-key");
      assert.equal(url.searchParams.get("_type"), "json");
      assert.equal(url.searchParams.get("MobileOS"), "ETC");
      assert.equal(url.searchParams.get("MobileApp"), "lodging-datalab");
      assert.equal(url.searchParams.get("baseYm"), "202606");
      assert.equal(url.searchParams.get("areaCd"), "48");
      assert.equal(url.searchParams.get("signguCd"), "48860");
      if (operation === "areaTarSjrnDsList") {
        assert.equal(url.searchParams.get("tarSjrnDsIxCd"), "21");
        assert.equal(url.searchParams.has("tarExpDsIxCd"), false);
      } else {
        assert.equal(url.searchParams.get("tarExpDsIxCd"), "22");
        assert.equal(url.searchParams.has("tarSjrnDsIxCd"), false);
      }
    });
    assert.doesNotMatch(JSON.stringify(demandSnapshot), /fixture-demand-strength-key/);

    const demandRequestCountAfterFirst = demandRequests.length;
    const cachedDemandSnapshot = await demandCollector.readDemandStrength({ regionKey: "kr_gyeongnam_sancheong", yearMonth: "202606" });
    assert.equal(cachedDemandSnapshot.status, "ok");
    assert.equal(cachedDemandSnapshot.cache.hit, true);
    assert.equal(cachedDemandSnapshot.source.requestProfile, "overall-index-filter-v1");
    assert.equal(cachedDemandSnapshot.collection.operationCallsAttempted, 0);
    assert.equal(demandRequests.length, demandRequestCountAfterFirst);

    const demandCacheDirectory = path.join(demandDataDir, "cache");
    const demandCacheFileName = (await fsp.readdir(demandCacheDirectory))
      .find((fileName) => fileName.startsWith("demand-strength__") && fileName.endsWith("__202606.json"));
    assert.ok(demandCacheFileName);
    const demandCacheFilePath = path.join(demandCacheDirectory, demandCacheFileName);
    const currentDemandCache = JSON.parse(await fsp.readFile(demandCacheFilePath, "utf8"));
    const legacyDemandCache = JSON.parse(JSON.stringify(currentDemandCache));
    delete legacyDemandCache.source.requestProfile;
    await fsp.writeFile(demandCacheFilePath, `${JSON.stringify(legacyDemandCache, null, 2)}\n`, "utf8");
    const legacyDemandSnapshot = await demandCollector.readDemandStrength({ regionKey: "kr_gyeongnam_sancheong", yearMonth: "202606" });
    assert.equal(legacyDemandSnapshot.status, "ok");
    assert.equal(legacyDemandSnapshot.cache.hit, true);
    assert.equal(legacyDemandSnapshot.source.requestProfile, "legacy-unfiltered-v1");
    await fsp.writeFile(demandCacheFilePath, `${JSON.stringify(currentDemandCache, null, 2)}\n`, "utf8");

    const genericDemand = await demandCollector.collect({
      keyword: "산청글램핑",
      yearMonth: "202606",
      sources: ["demandStrength"],
      force: true
    });
    assert.equal(genericDemand.sources.demandStrength.status, "ok");
    assert.equal(genericDemand.sources.demandStrength.data.cache.hit, true);
    assert.equal(demandRequests.length, demandRequestCountAfterFirst);

    const demandHistoryCacheOnly = await demandCollector.collectDemandStrengthHistory({
      regionNames: ["산청"],
      endYearMonth: "202606",
      months: 3
    });
    assert.equal(demandHistoryCacheOnly.status, "partial");
    assert.equal(demandHistoryCacheOnly.collection.mode, "cache_only");
    assert.equal(demandHistoryCacheOnly.collection.networkAttemptedMonths, 0);
    assert.equal(demandHistoryCacheOnly.coverage.completeMonths, 1);
    assert.equal(demandHistoryCacheOnly.coverage.missingMonths, 2);
    assert.equal(demandRequests.length, demandRequestCountAfterFirst);

    const demandHistoryFirstMatchedName = await demandCollector.collectDemandStrengthHistory({
      regionNames: ["매핑되지않은지역", "산청"],
      endYearMonth: "202606",
      months: 1
    });
    assert.equal(demandHistoryFirstMatchedName.region.regionKey, "kr_gyeongnam_sancheong");
    assert.equal(demandHistoryFirstMatchedName.collection.networkAttemptedMonths, 0);

    const demandHistoryRegionKeyList = await demandCollector.collectDemandStrengthHistory({
      regionKeys: ["kr_gyeongnam_sancheong"],
      endYearMonth: "202606",
      months: 1
    });
    assert.equal(demandHistoryRegionKeyList.region.regionKey, "kr_gyeongnam_sancheong");
    assert.equal(demandHistoryRegionKeyList.collection.networkAttemptedMonths, 0);

    const demandHistory = await demandCollector.collectDemandStrengthHistory({
      regionNames: ["산청"],
      endYearMonth: "202606",
      months: 3,
      refresh: true
    });
    assert.equal(demandHistory.status, "partial");
    assert.equal(demandHistory.collection.mode, "backfill_missing");
    assert.equal(demandHistory.collection.requestGrain, "sigungu");
    assert.equal(demandHistory.collection.operationsPerMonth, 2);
    assert.equal(demandHistory.collection.maxPagesPerOperation, 10);
    assert.equal(demandHistory.collection.maximumOperationCalls, 60);
    assert.equal(demandHistory.collection.operationCallsAttempted, 4);
    assert.equal(demandHistory.collection.networkAttemptedMonths, 2);
    assert.equal(demandHistory.collection.networkSucceededMonths, 1);
    assert.equal(demandHistory.coverage.completeMonths, 2);
    assert.equal(demandHistory.coverage.partialMonths, 1);
    const mayDemandPoint = demandHistory.series.find((point) => point.yearMonth === "202605");
    assert.equal(mayDemandPoint.status, "partial");
    assert.equal(mayDemandPoint.stayStatus, "ok");
    assert.equal(mayDemandPoint.spendStatus, "error");
    assert.ok(Number.isFinite(mayDemandPoint.stayOverall));
    assert.equal(mayDemandPoint.spendOverall, null);
    const aprilDemandPoint = demandHistory.series.find((point) => point.yearMonth === "202604");
    assert.equal(aprilDemandPoint.status, "complete");
    const optionalNameDemand = await demandCollector.readDemandStrength({ regionName: "산청", yearMonth: "202604" });
    assert.equal(optionalNameDemand.status, "ok");
    assert.equal(optionalNameDemand.stay.quality.invalidRowCount, 0);
    assert.equal(optionalNameDemand.stay.quality.mismatchedRowCount, 0);
    assert.equal(optionalNameDemand.spend.quality.invalidRowCount, 0);
    assert.equal(optionalNameDemand.spend.quality.mismatchedRowCount, 0);
    assert.equal(optionalNameDemand.spend.metrics.find((metric) => metric.code === "22").sourceName, "");
    assert.equal(demandHistory.quality.completeRequiresOverallCodes.join(","), "21,22");
    assert.equal(demandHistory.collection.provinceBulkReuse, false);

    const demandHistoryCachedAgain = await demandCollector.collectDemandStrengthHistory({
      regionName: "산청",
      endYearMonth: "202606",
      months: 3
    });
    assert.equal(demandHistoryCachedAgain.collection.networkAttemptedMonths, 0);
    assert.equal(demandHistoryCachedAgain.coverage.completeMonths, 2);
    assert.equal(demandHistoryCachedAgain.coverage.partialMonths, 0);
    assert.equal(demandHistoryCachedAgain.coverage.missingMonths, 1);

    const detailPartialDemand = await demandCollector.collectDemandStrength({ regionName: "산청", yearMonth: "202603" });
    assert.equal(detailPartialDemand.status, "ok");
    assert.equal(detailPartialDemand.stay.status, "ok");
    assert.equal(detailPartialDemand.stay.quality.status, "detail_partial");
    assert.equal(detailPartialDemand.stay.quality.overallComplete, true);
    assert.equal(detailPartialDemand.stay.quality.detailComplete, false);
    assert.equal(detailPartialDemand.stay.metrics.find((metric) => metric.code === "2105").value, null);

    const missingOverallDemand = await demandCollector.collectDemandStrength({ regionName: "산청", yearMonth: "202602" });
    assert.equal(missingOverallDemand.status, "partial");
    assert.equal(missingOverallDemand.stay.status, "partial");
    assert.equal(missingOverallDemand.stay.overallValue, null);
    assert.equal(missingOverallDemand.spend.status, "ok");

    const wrongRegionDemand = await demandCollector.collectDemandStrength({ regionName: "산청", yearMonth: "202601" });
    assert.equal(wrongRegionDemand.status, "error");
    assert.equal(wrongRegionDemand.stay.quality.status, "region_or_period_mismatch");
    assert.equal(wrongRegionDemand.spend.quality.status, "region_or_period_mismatch");

    const missingSigunguIdentityDemand = await demandCollector.collectDemandStrength({ regionName: "산청", yearMonth: "202512" });
    assert.equal(missingSigunguIdentityDemand.status, "error");
    assert.equal(missingSigunguIdentityDemand.stay.quality.status, "invalid_rows");
    assert.equal(missingSigunguIdentityDemand.spend.quality.status, "invalid_rows");

    failDemandMonth = "202606";
    const preservedDemand = await demandCollector.collectDemandStrength({
      regionName: "산청",
      yearMonth: "202606",
      force: true
    });
    assert.equal(preservedDemand.status, "ok");
    assert.equal(preservedDemand.cache.hit, true);
    assert.equal(preservedDemand.cache.refreshFailed, true);
    assert.equal(preservedDemand.collection.operationCallsAttempted, 2);
    assert.equal(preservedDemand.stay.overallValue, demandSnapshot.stay.overallValue);
    assert.equal(preservedDemand.spend.overallValue, demandSnapshot.spend.overallValue);
    failDemandMonth = "";

    const concurrentDemandRefreshes = await Promise.all([
      demandCollector.collectDemandStrength({ regionName: "산청", yearMonth: "202606", force: true }),
      demandCollector.collectDemandStrength({ regionName: "산청", yearMonth: "202606", force: true })
    ]);
    assert.ok(concurrentDemandRefreshes.every((snapshot) => snapshot.status === "ok"));
    const demandCacheFilesAfterConcurrentRefresh = await fsp.readdir(path.join(demandDataDir, "cache"));
    assert.equal(
      demandCacheFilesAfterConcurrentRefresh.some((fileName) => fileName.endsWith(".tmp")),
      false,
      "동시 Snapshot 저장 후 임시파일이 남으면 안 됩니다."
    );

    const defaultDemandHistoryRequestCount = demandRequests.length;
    const defaultDemandHistory = await demandCollector.collectDemandStrengthHistory({ regionName: "산청" });
    assert.equal(defaultDemandHistory.period.months, 36);
    assert.equal(defaultDemandHistory.collection.mode, "cache_only");
    assert.equal(defaultDemandHistory.collection.operationCallsAttempted, 0);
    assert.equal(demandRequests.length, defaultDemandHistoryRequestCount);

    const blockedDemandWritePath = path.join(dataDir, "tourism_demand_strength_write_blocker");
    await fsp.writeFile(blockedDemandWritePath, "not-a-directory", "utf8");
    let failedWriteRequestCount = 0;
    const failedWriteCollector = createCollector({
      rootDir: tmp,
      webDir,
      dataDir,
      tourismDataDir: blockedDemandWritePath,
      env: {
        DATA_GO_KR_DEMAND_STRENGTH_SERVICE_KEY: "fixture-demand-strength-key",
        KTO_TOURISM_DEMAND_STRENGTH_PAGE_SIZE: "100"
      },
      now: () => new Date("2026-07-15T00:00:00.000Z"),
      fetchImpl: async (requestUrl) => {
        failedWriteRequestCount += 1;
        const url = new URL(requestUrl);
        const operation = url.pathname.split("/").at(-1);
        const yearMonth = url.searchParams.get("baseYm");
        const rows = demandStrengthRows(yearMonth, operation);
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({
            response: {
              header: { resultCode: "00", resultMsg: "NORMAL_CODE" },
              body: {
                pageNo: 1,
                numOfRows: 100,
                totalCount: rows.length,
                items: { item: rows }
              }
            }
          })
        };
      }
    });
    const failedWriteHistory = await failedWriteCollector.collectDemandStrengthHistory({
      regionName: "산청",
      endYearMonth: "202604",
      months: 1,
      refresh: true,
      maxPagesPerOperation: 1
    });
    assert.equal(failedWriteRequestCount, 2);
    assert.equal(failedWriteHistory.status, "unavailable");
    assert.equal(failedWriteHistory.collection.networkFailedMonths, 1);
    assert.equal(failedWriteHistory.collection.operationCallsAttempted, 2);
    assert.equal(failedWriteHistory.collection.operationCallsUncertainMonths, 1);
    assert.equal(failedWriteHistory.collection.maximumOperationCalls, 2);

    const demandStatusAfter = await demandCollector.status();
    assert.equal(demandStatusAfter.demandStrength.snapshotCount, 3);
    assert.equal(demandStatusAfter.demandStrength.earliestYearMonth, "202603");
    assert.equal(demandStatusAfter.demandStrength.latestYearMonth, "202606");
    assert.doesNotMatch(JSON.stringify(demandStatusAfter), /fixture-demand-strength-key/);

    const paginationDataDir = path.join(dataDir, "tourism_demand_strength_pagination_data");
    const paginationRequests = [];
    const paginatedDemandRows = (yearMonth, operation) => {
      const rows = demandStrengthRows(yearMonth, operation);
      const stayOperation = operation === "areaTarSjrnDsList";
      const codeField = stayOperation ? "tarSjrnDsIxCd" : "tarExpDsIxCd";
      const nameField = stayOperation ? "tarSjrnDsIxNm" : "tarExpDsIxNm";
      const valueField = stayOperation ? "tarSjrnDsIxVal" : "tarExpDsIxVal";
      const targetCount = stayOperation ? 25 : 15;
      while (rows.length < targetCount) {
        const sequence = rows.length + 1;
        rows.push({
          ...rows[0],
          [codeField]: `9${String(sequence).padStart(3, "0")}`,
          [nameField]: `추가 지표 ${sequence}`,
          [valueField]: String(100 + sequence)
        });
      }
      return rows;
    };
    const paginationCollector = createCollector({
      rootDir: tmp,
      webDir,
      dataDir,
      tourismDataDir: paginationDataDir,
      env: {
        DATA_GO_KR_DEMAND_STRENGTH_SERVICE_KEY: "fixture-demand-pagination-key",
        KTO_TOURISM_DEMAND_STRENGTH_PAGE_SIZE: "10",
        KTO_TOURISM_DEMAND_STRENGTH_MAX_PAGES: "10"
      },
      now: () => new Date("2026-07-15T00:00:00.000Z"),
      fetchImpl: async (requestUrl) => {
        const url = new URL(requestUrl);
        const operation = url.pathname.split("/").at(-1);
        const yearMonth = url.searchParams.get("baseYm");
        const pageNo = Number(url.searchParams.get("pageNo"));
        const pageSize = Number(url.searchParams.get("numOfRows"));
        paginationRequests.push({ operation, yearMonth, pageNo });
        if (yearMonth === "202602") await new Promise((resolve) => setTimeout(resolve, 2));
        const rows = paginatedDemandRows(yearMonth, operation);
        const offset = (pageNo - 1) * pageSize;
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({
            response: {
              header: { resultCode: "00", resultMsg: "NORMAL_CODE" },
              body: {
                pageNo,
                numOfRows: pageSize,
                totalCount: rows.length,
                items: { item: rows.slice(offset, offset + pageSize) }
              }
            }
          })
        };
      }
    });

    const paginatedDemand = await paginationCollector.collectDemandStrength({
      regionName: "산청",
      yearMonth: "202604"
    });
    assert.equal(paginatedDemand.status, "ok");
    assert.equal(paginatedDemand.stay.quality.pageCount, 3);
    assert.equal(paginatedDemand.stay.requestCount, 3);
    assert.equal(paginatedDemand.spend.quality.pageCount, 2);
    assert.equal(paginatedDemand.spend.requestCount, 2);
    assert.equal(paginatedDemand.collection.operationCallsAttempted, 5);
    assert.equal(paginatedDemand.collection.maxPagesPerOperation, 10);
    assert.equal(paginationRequests.length, 5);

    const paginationCacheDir = path.join(paginationDataDir, "cache");
    const aprilCacheName = (await fsp.readdir(paginationCacheDir)).find((fileName) => fileName.endsWith("__202604.json"));
    assert.ok(aprilCacheName);
    const aprilCachePath = path.join(paginationCacheDir, aprilCacheName);
    const aprilCacheBefore = await fsp.readFile(aprilCachePath);
    const requestCountBeforeLimitedRefresh = paginationRequests.length;
    const limitedRefresh = await paginationCollector.collectDemandStrength({
      regionName: "산청",
      yearMonth: "202604",
      force: true,
      maxPagesPerOperation: 1
    });
    assert.equal(limitedRefresh.status, "ok");
    assert.equal(limitedRefresh.cache.hit, true);
    assert.equal(limitedRefresh.cache.refreshFailed, true);
    assert.equal(limitedRefresh.collection.operationCallsAttempted, 2);
    assert.equal(limitedRefresh.collection.maxPagesPerOperation, 1);
    assert.equal(paginationRequests.length - requestCountBeforeLimitedRefresh, 2);
    assert.deepEqual(await fsp.readFile(aprilCachePath), aprilCacheBefore, "페이지 제한 실패가 정상 캐시를 덮어쓰면 안 됩니다.");

    const requestCountBeforeLimitedMiss = paginationRequests.length;
    const limitedWithoutCache = await paginationCollector.collectDemandStrength({
      regionName: "산청",
      yearMonth: "202605",
      maxPagesPerOperation: 1
    });
    assert.equal(limitedWithoutCache.status, "error");
    assert.equal(limitedWithoutCache.stay.reason, "page_limit_exceeded");
    assert.equal(limitedWithoutCache.spend.reason, "page_limit_exceeded");
    assert.equal(limitedWithoutCache.collection.operationCallsAttempted, 2);
    assert.equal(limitedWithoutCache.collection.maxPagesPerOperation, 1);
    assert.equal(paginationRequests.length - requestCountBeforeLimitedMiss, 2);
    const limitedCacheRead = await paginationCollector.readDemandStrength({ regionName: "산청", yearMonth: "202605" });
    assert.equal(limitedCacheRead.status, "unavailable");
    assert.equal((await fsp.readdir(paginationCacheDir)).some((fileName) => fileName.endsWith("__202605.json")), false);

    const orderedHistory = await paginationCollector.collectDemandStrengthHistory({
      regionName: "산청",
      endYearMonth: "202604",
      months: 3,
      refresh: true,
      concurrency: 2
    });
    assert.deepEqual(orderedHistory.series.map((point) => point.yearMonth), ["202602", "202603", "202604"]);
    assert.equal(orderedHistory.latest.yearMonth, "202604");
    assert.equal(orderedHistory.collection.operationCallsAttempted, 10);
    assert.equal(orderedHistory.collection.maxPagesPerOperation, 10);
    assert.equal(orderedHistory.collection.maximumOperationCalls, 60);

    const limitedHistoryRequestCount = paginationRequests.length;
    const limitedHistory = await paginationCollector.collectDemandStrengthHistory({
      regionName: "산청",
      endYearMonth: "202601",
      months: 1,
      refresh: true,
      maxPagesPerOperation: 1
    });
    assert.equal(limitedHistory.status, "unavailable");
    assert.deepEqual(limitedHistory.series.map((point) => point.yearMonth), ["202601"]);
    assert.equal(limitedHistory.collection.operationCallsAttempted, 2);
    assert.equal(limitedHistory.collection.maxPagesPerOperation, 1);
    assert.equal(limitedHistory.collection.maximumOperationCalls, 2);
    assert.equal(paginationRequests.length - limitedHistoryRequestCount, 2);

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
      assert.match(contents, /- key: DATA_GO_KR_DEMAND_STRENGTH_SERVICE_KEY\r?\n\s+sync: false/);
      assert.doesNotMatch(contents, /- key: DATA_GO_KR_DEMAND_STRENGTH_SERVICE_KEY\r?\n\s+value:/);
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
