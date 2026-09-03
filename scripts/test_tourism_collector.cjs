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
  "DATA_GO_KR_RESOURCE_DEMAND_SERVICE_KEY",
  "DATA_GO_KR_DIVERSITY_SERVICE_KEY",
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

function regionalIndexRows(sourceKey, yearMonth, operation, options = {}) {
  const definitions = {
    resourceDemand: {
      areaTarSvcDemList: {
        codeField: "tarSvcDemIxCd",
        nameField: "tarSvcDemIxNm",
        valueField: "tarSvcDemIxVal",
        metrics: {
          "11": ["관광 서비스 수요 전체", 71.5],
          "1101": ["레포츠 SNS 언급량", 61.1],
          "1102": ["휴식 힐링 SNS 언급량", 62.2],
          "1103": ["미식 SNS 언급량", 63.3],
          "1104": ["체험 SNS 언급량", 64.4],
          "1105": ["쇼핑업 소비액", 65.5],
          "1106": ["식음료 소비액", 66.6],
          "1107": ["숙박업 소비액", 67.7],
          "1108": ["여가 서비스업 소비액", 68.8],
          "1109": ["운송업 소비액", 69.9],
          "1110": ["내비게이션 숙박 검색량", 70.1],
          "1111": ["내비게이션 음식 검색량", 70.2],
          "1112": ["내비게이션 쇼핑 검색량", 70.3]
        }
      },
      areaCulResDemList: {
        codeField: "culResDemIxCd",
        nameField: "culResDemIxNm",
        valueField: "culResDemIxVal",
        metrics: {
          "12": ["문화 자원 수요 전체", 64.25],
          "1201": ["내비게이션 문화 관광 검색량", 60.1],
          "1202": ["내비게이션 레저 스포츠 검색량", 60.2],
          "1203": ["내비게이션 역사 관광 검색량", 60.3],
          "1204": ["내비게이션 체험 관광 검색량", 60.4],
          "1205": ["내비게이션 자연 관광 검색량", 60.5]
        }
      }
    },
    diversity: {
      areaTouDivList: {
        codeField: "touDivIxCd",
        nameField: "touDivIxNm",
        valueField: "touDivIxVal",
        metrics: {
          "31": ["관광객 다양성 전체", 78.1],
          "3101": ["10대 방문객수", 71.1],
          "3102": ["20대 방문객수", 72.2],
          "3103": ["30대 방문객수", 73.3],
          "3104": ["40대 방문객수", 74.4],
          "3105": ["50대 방문객수", 75.5],
          "3106": ["60대 방문객수", 76.6],
          "3107": ["70대 방문객수", 77.7]
        }
      },
      areaExpDivList: {
        codeField: "expDivIxCd",
        nameField: "expDivIxNm",
        valueField: "expDivIxVal",
        metrics: {
          "32": ["관광 소비 다양성 전체", 66.4],
          "3201": ["10대 소비액", 61.1],
          "3202": ["20대 소비액", 62.2],
          "3203": ["30대 소비액", 63.3],
          "3204": ["40대 소비액", 64.4],
          "3205": ["50대 소비액", 65.5],
          "3206": ["60대 소비액", 66.6],
          "3207": ["70대 소비액", 67.7]
        }
      },
      areaIntlDivList: {
        codeField: "intlDivIxCd",
        nameField: "intlDivIxNm",
        valueField: "intlDivIxVal",
        metrics: {
          "33": ["국제적 다양성 전체", 52.75],
          "3301": ["외국인 소비액", 50.1],
          "3302": ["외국인 방문자수", 50.2],
          "3303": ["외국인 방문객 국적 다양성", 50.3]
        }
      }
    }
  };
  const definition = definitions[sourceKey]?.[operation];
  assert.ok(definition, `Unknown regional index fixture: ${sourceKey}/${operation}`);
  const base = {
    baseYm: options.baseYm || yearMonth,
    areaCd: options.areaCd || "48",
    areaNm: options.areaNm || "경상남도",
    signguCd: options.signguCd || "48860",
    signguNm: options.signguNm || "산청군"
  };
  const rows = Object.entries(definition.metrics)
    .filter(([code]) => !(options.omitCodes || []).includes(code))
    .map(([code, [label, value]]) => ({
      ...base,
      [definition.codeField]: code,
      [definition.nameField]: label,
      [definition.valueField]: String(value)
    }));
  if (!options.conflict) return rows;
  const conflictCode = options.conflictCode || Object.keys(definition.metrics)[0];
  const conflictRow = rows.find((row) => row[definition.codeField] === conflictCode);
  return conflictRow
    ? [...rows, { ...conflictRow, [definition.valueField]: String(Number(conflictRow[definition.valueField]) + 1) }]
    : rows;
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
    assert.equal(
      fs.existsSync(path.join(dataDir, "tourism_data", "evidence", "cache_snapshots")),
      false,
      "Shadow callback이 없을 때는 immutable cache Evidence I/O가 생기면 안 됩니다."
    );

    const visitorRequests = [];
    const visitorRows = visitorRowsForMonth("202606", [
      { code: "48860", name: "산청군", values: { "1": 1000, "2": 200, "3": 10 } },
      { code: "48850", name: "하동군", values: { "1": 500, "2": 100, "3": 5 } }
    ]);
    const partialVisitorRows = visitorRowsForMonth("202605", [
      { code: "48860", name: "산청군", values: { "1": 900, "2": 180, "3": 9 } }
    ]).filter((row) => row.baseYmd !== "20260531");
    const storedVisitorSnapshots = [];
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
      onSnapshotStored: (payload) => {
        storedVisitorSnapshots.push(payload);
        throw new Error("fixture shadow writer failure");
      },
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
    assert.equal(storedVisitorSnapshots.length, 1, "완전한 방문자 월 캐시는 저장 직후 Shadow hook을 한 번 호출해야 합니다.");
    assert.equal(storedVisitorSnapshots[0].sourceKey, "visitors");
    assert.equal(fs.existsSync(storedVisitorSnapshots[0].filePath), true);
    assert.equal(fs.existsSync(storedVisitorSnapshots[0].evidencePath), true);
    assert.match(storedVisitorSnapshots[0].sha256, /^[a-f0-9]{64}$/);
    assert.equal(path.basename(storedVisitorSnapshots[0].evidencePath), `${storedVisitorSnapshots[0].sha256}.json`);
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
    assert.equal(emptyHistory.regions[0].rolling12.currentYearMonth, "202607");
    assert.equal(emptyHistory.regions[0].rolling12.latestClosedYearMonth, "202606");
    assert.equal(emptyHistory.regions[0].rolling12.targetYearMonth, "202606");
    assert.equal(emptyHistory.regions[0].rolling12.target.period.startYearMonth, "202507");
    assert.equal(emptyHistory.regions[0].rolling12.target.period.endYearMonth, "202606");
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
      rollingTargetYearMonth: "202606",
      currentYearMonth: "202607"
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
    assert.equal(sancheongHistory.rolling12.target.period.startYearMonth, "202507");
    assert.equal(sancheongHistory.rolling12.target.period.endYearMonth, "202606");
    assert.equal(sancheongHistory.rolling12.target.coverage.completeMonths, 11);
    assert.equal(sancheongHistory.rolling12.target.coverage.partialMonths, 1);
    assert.deepEqual(sancheongHistory.rolling12.target.coverage.missingYearMonths, []);
    assert.deepEqual(sancheongHistory.rolling12.target.coverage.partialYearMonths, ["202511"]);
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
    assert.equal(completeRolling.target.status, "ready");
    assert.equal(completeRolling.target.coverage.completeMonths, 12);
    assert.equal(completeRolling.target.coverage.missingMonths, 0);
    assert.ok(Number.isFinite(completeRolling.target.totalVisitors));
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
    assert.equal(completeRolling.policy.currentMonthIncludedInTarget, false);
    assert.equal(completeRolling.policy.targetEndsAtLatestClosedMonth, true);

    const requestCountBeforeAnalysisRead = historyRequests.length;
    const compactHistoryWithAnalysis = await historyCollector.collectVisitorHistory({
      regionNames: ["산청"],
      months: 12,
      analysisMonths: 36
    });
    assert.equal(compactHistoryWithAnalysis.period.months, 12);
    assert.equal(compactHistoryWithAnalysis.regions[0].series.length, 12);
    assert.equal(compactHistoryWithAnalysis.collection.requestedMonths, 12);
    assert.equal(compactHistoryWithAnalysis.collection.analysisMonths, 36);
    assert.equal(compactHistoryWithAnalysis.collection.analysisCacheOnlyMonths, 24);
    assert.equal(compactHistoryWithAnalysis.collection.networkAttemptedMonths, 0);
    assert.equal(compactHistoryWithAnalysis.regions[0].analysisCoverage.completeMonths, 36);
    assert.equal(compactHistoryWithAnalysis.regions[0].rolling12.confirmed.status, "ready");
    assert.equal(compactHistoryWithAnalysis.regions[0].rolling12.previous.status, "ready");
    assert.equal(compactHistoryWithAnalysis.regions[0].visitorOutlookScore.status, "ready");
    assert.equal(historyRequests.length, requestCountBeforeAnalysisRead);

    const historyCacheDir = path.join(historyDataDir, "cache");
    const visitorCacheFile = (yearMonth) => path.join(
      historyCacheDir,
      `visitors__locgo-regn-visitors-v1__regionmap__${yearMonth}.json`
    );
    const analysisOnlyMissingMonth = "202307";
    const requestedMissingMonth = "202606";
    const analysisOnlyCachePath = visitorCacheFile(analysisOnlyMissingMonth);
    const requestedCachePath = visitorCacheFile(requestedMissingMonth);
    const [analysisOnlyCacheFixture, requestedCacheFixture] = await Promise.all([
      fsp.readFile(analysisOnlyCachePath),
      fsp.readFile(requestedCachePath)
    ]);
    await Promise.all([
      fsp.rm(analysisOnlyCachePath),
      fsp.rm(requestedCachePath)
    ]);
    try {
      const requestCountBeforeAnalysisRefresh = historyRequests.length;
      const refreshedCompactHistory = await historyCollector.collectVisitorHistory({
        regionNames: ["산청"],
        months: 12,
        analysisMonths: 36,
        collectMissing: true
      });
      const refreshRequests = historyRequests.slice(requestCountBeforeAnalysisRefresh);
      assert.deepEqual(refreshRequests, [requestedMissingMonth]);
      assert.equal(refreshRequests.includes(analysisOnlyMissingMonth), false);
      assert.equal(refreshedCompactHistory.collection.networkAttemptedMonths, 1);
      assert.equal(refreshedCompactHistory.collection.networkSucceededMonths, 1);
      assert.equal(refreshedCompactHistory.collection.cacheHitMonths, 11);
      assert.equal(refreshedCompactHistory.collection.missingCacheMonths, 0);
      assert.equal(refreshedCompactHistory.collection.analysisCacheHitMonths, 34);
      assert.equal(refreshedCompactHistory.collection.analysisMissingCacheMonths, 1);
      assert.equal(refreshedCompactHistory.regions[0].series.length, 12);
      assert.equal(refreshedCompactHistory.regions[0].coverage.completeMonths, 12);
      assert.equal(
        refreshedCompactHistory.regions[0].analysisCoverage.completeMonths,
        35
      );

      const requestCountBeforeAnalysisForce = historyRequests.length;
      const forcedCompactHistory = await historyCollector.collectVisitorHistory({
        regionNames: ["산청"],
        months: 12,
        analysisMonths: 36,
        force: true
      });
      const forceRequests = historyRequests.slice(requestCountBeforeAnalysisForce);
      assert.deepEqual(
        [...forceRequests].sort(),
        [...visitorHistoryMonths("202606", 12)].sort()
      );
      assert.equal(forceRequests.includes(analysisOnlyMissingMonth), false);
      assert.equal(forcedCompactHistory.collection.networkAttemptedMonths, 12);
      assert.equal(forcedCompactHistory.collection.networkSucceededMonths, 12);
      assert.equal(forcedCompactHistory.collection.analysisMissingCacheMonths, 1);
    } finally {
      await Promise.all([
        fsp.writeFile(analysisOnlyCachePath, analysisOnlyCacheFixture),
        fsp.writeFile(requestedCachePath, requestedCacheFixture)
      ]);
    }

    const laggedHistoryCollector = createCollector({
      rootDir: tmp,
      webDir,
      dataDir,
      tourismDataDir: historyDataDir,
      env: {},
      now: () => new Date("2026-08-15T00:00:00.000Z"),
      fetchImpl: async () => {
        throw new Error("analysis-only history read attempted a network request");
      }
    });
    const laggedHistory = await laggedHistoryCollector.collectVisitorHistory({
      regionNames: ["산청"],
      months: 12,
      analysisMonths: 36
    });
    const laggedRolling = laggedHistory.regions[0].rolling12;
    assert.equal(laggedHistory.collection.networkAttemptedMonths, 0);
    assert.equal(laggedHistory.regions[0].series.length, 12);
    assert.equal(laggedHistory.regions[0].latest.yearMonth, "202607");
    assert.equal(laggedHistory.regions[0].latest.status, "missing");
    assert.equal(laggedHistory.regions[0].latest.averageDailyVisitors, null);
    assert.equal(laggedHistory.regions[0].latestAvailable.yearMonth, "202606");
    assert.equal(laggedRolling.currentYearMonth, "202608");
    assert.equal(laggedRolling.latestClosedYearMonth, "202607");
    assert.equal(laggedRolling.target.period.endYearMonth, "202607");
    assert.equal(laggedRolling.target.coverage.completeMonths, 11);
    assert.deepEqual(laggedRolling.target.coverage.missingYearMonths, ["202607"]);
    assert.equal(laggedRolling.target.totalVisitors, null);
    assert.equal(laggedRolling.confirmed.period.endYearMonth, "202606");
    assert.equal(laggedRolling.confirmed.status, "ready");
    assert.equal(laggedRolling.confirmed.coverage.completeMonths, 12);
    assert.ok(Number.isFinite(laggedRolling.confirmed.totalVisitors));
    assert.equal(laggedRolling.previous.period.endYearMonth, "202506");
    assert.equal(laggedRolling.previous.status, "ready");
    assert.equal(laggedRolling.comparison.status, "ready");

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
    assert.equal(defaultDemandHistory.period.months, 12);
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

    const regionalIndexDataDir = path.join(dataDir, "tourism_regional_index_data");
    const regionalIndexRequests = [];
    let conflictResourceDemand = false;
    let omitResourceMetricCode = "";
    let errorResourceMetricCode = "";
    let paginatedResourceMetricCode = "";
    let mismatchDiversityMonth = false;
    let mismatchDiversityRegion = false;
    const regionalIndexCollector = createCollector({
      rootDir: tmp,
      webDir,
      dataDir,
      tourismDataDir: regionalIndexDataDir,
      env: {
        DATA_GO_KR_RESOURCE_DEMAND_SERVICE_KEY: "fixture-resource-demand-key",
        DATA_GO_KR_DIVERSITY_SERVICE_KEY: "fixture-diversity-key",
        KTO_TOURISM_RESOURCE_DEMAND_PAGE_SIZE: "10",
        KTO_TOURISM_DIVERSITY_PAGE_SIZE: "10"
      },
      now: () => new Date("2026-07-15T00:00:00.000Z"),
      fetchImpl: async (requestUrl) => {
        const url = new URL(requestUrl);
        const operation = url.pathname.split("/").at(-1);
        const sourceKey = url.pathname.includes("AreaTarResDemService") ? "resourceDemand" : "diversity";
        const yearMonth = url.searchParams.get("baseYm");
        const pageNo = Number(url.searchParams.get("pageNo"));
        const pageSize = Number(url.searchParams.get("numOfRows"));
        const metricDefinition = {
          areaTarSvcDemList: { codeParam: "tarSvcDemIxCd", codeField: "tarSvcDemIxCd" },
          areaCulResDemList: { codeParam: "culResDemIxCd", codeField: "culResDemIxCd" },
          areaTouDivList: { codeParam: "touDivIxCd", codeField: "touDivIxCd" },
          areaExpDivList: { codeParam: "expDivIxCd", codeField: "expDivIxCd" },
          areaIntlDivList: { codeParam: "intlDivIxCd", codeField: "intlDivIxCd" }
        }[operation];
        assert.ok(metricDefinition, `Unknown metric operation: ${operation}`);
        const metricCode = url.searchParams.get(metricDefinition.codeParam);
        regionalIndexRequests.push({ url, operation, sourceKey, yearMonth, metricCode });
        if (errorResourceMetricCode && sourceKey === "resourceDemand" && metricCode === errorResourceMetricCode) {
          return {
            ok: false,
            status: 503,
            text: async () => JSON.stringify({
              response: {
                header: { resultCode: "05", resultMsg: "SERVICETIMEOUT_ERROR" },
                body: { pageNo, numOfRows: pageSize, totalCount: 0, items: { item: [] } }
              }
            })
          };
        }
        let rows = regionalIndexRows(sourceKey, yearMonth, operation, {
          conflict: conflictResourceDemand && sourceKey === "resourceDemand" && operation === "areaTarSvcDemList",
          omitCodes: omitResourceMetricCode && sourceKey === "resourceDemand" && operation === "areaTarSvcDemList"
            ? [omitResourceMetricCode]
            : [],
          baseYm: mismatchDiversityMonth && sourceKey === "diversity" ? "202604" : yearMonth,
          signguCd: mismatchDiversityRegion && sourceKey === "diversity" ? "48850" : undefined,
          signguNm: mismatchDiversityRegion && sourceKey === "diversity" ? "하동군" : undefined
        }).filter((row) => String(row[metricDefinition.codeField]) === metricCode);
        if (paginatedResourceMetricCode && sourceKey === "resourceDemand" && metricCode === paginatedResourceMetricCode && rows[0]) {
          rows = Array.from({ length: 11 }, () => ({ ...rows[0] }));
        }
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

    const resourceCacheDirectory = path.join(regionalIndexDataDir, "cache");
    await fsp.mkdir(resourceCacheDirectory, { recursive: true });
    await fsp.writeFile(
      path.join(resourceCacheDirectory, "resourcedemand__areatarresdemv2__regionmap__krgyeongnamsancheong__202606.json"),
      JSON.stringify({
        schemaVersion: 1,
        adapter: "area-tar-res-dem-v2",
        status: "ok",
        yearMonth: "202606",
        regionMapVersion: "tourism-region-map-v1",
        region: { regionKey: "kr_gyeongnam_sancheong" },
        source: {
          normalizerVersion: "regional-index-row-normalizer-v2",
          requestProfile: "all-metrics-unfiltered-v2"
        }
      }),
      "utf8"
    );
    const resourceCacheMiss = await regionalIndexCollector.readResourceDemand({ regionName: "산청", yearMonth: "202606" });
    assert.equal(resourceCacheMiss.status, "unavailable");
    assert.equal(resourceCacheMiss.reason, "monthly_cache_missing");
    assert.equal(resourceCacheMiss.adapter, "area-tar-res-dem-v3");
    assert.deepEqual(resourceCacheMiss.overall, { service: null, culture: null });
    assert.equal(regionalIndexRequests.length, 0);

    const resourceSnapshot = await regionalIndexCollector.collectResourceDemand({ regionName: "산청", yearMonth: "202606" });
    assert.equal(resourceSnapshot.status, "ok");
    assert.deepEqual(resourceSnapshot.overall, { service: 71.5, culture: 64.25 });
    assert.equal(resourceSnapshot.quality.completeOperationCount, 2);
    assert.equal(resourceSnapshot.quality.detailCompleteOperationCount, 2);
    assert.equal(resourceSnapshot.quality.requiredMetricCount, 19);
    assert.equal(resourceSnapshot.quality.observedMetricCount, 19);
    assert.equal(resourceSnapshot.quality.metricQueryCount, 19);
    assert.equal(resourceSnapshot.quality.metricQuerySucceededCount, 19);
    assert.equal(resourceSnapshot.quality.metricQueryNoObservationCount, 0);
    assert.equal(resourceSnapshot.quality.metricQueryFailedCount, 0);
    assert.equal(Object.values(resourceSnapshot.operations).flatMap((operation) => operation.metrics).length, 19);
    assert.ok(Object.values(resourceSnapshot.operations).every((operation) => (
      operation.quality.detailComplete && operation.metrics.every((metric) => Number.isFinite(metric.value))
    )));
    assert.equal(resourceSnapshot.policy.completeCacheOnly, true);
    assert.equal(resourceSnapshot.policy.completeRequiresAllExpectedMetricCodes, true);
    assert.equal(resourceSnapshot.policy.requiredMetricCount, 19);
    assert.equal(resourceSnapshot.policy.requiredOverallCodes.join(","), "11,12");
    assert.equal(resourceSnapshot.source.requestProfile, "metric-code-filter-v3");
    assert.equal(resourceSnapshot.source.normalizerVersion, "regional-index-row-normalizer-v3");
    assert.equal(resourceSnapshot.collection.endpointOperationsPerMonth, 2);
    assert.equal(resourceSnapshot.collection.operationsPerMonth, 19);
    assert.equal(resourceSnapshot.collection.metricQueriesPerMonth, 19);
    assert.equal(resourceSnapshot.collection.operationCallsAttempted, 19);
    assert.equal(resourceSnapshot.collection.maximumOperationCalls, 190);
    assert.equal(regionalIndexRequests.length, 19);

    const diversitySnapshot = await regionalIndexCollector.collectDiversity({ regionName: "산청", yearMonth: "202606" });
    assert.equal(diversitySnapshot.status, "ok");
    assert.deepEqual(diversitySnapshot.overall, { visitor: 78.1, spend: 66.4, international: 52.75 });
    assert.equal(diversitySnapshot.quality.completeOperationCount, 3);
    assert.equal(diversitySnapshot.quality.detailCompleteOperationCount, 3);
    assert.equal(diversitySnapshot.quality.requiredMetricCount, 20);
    assert.equal(diversitySnapshot.quality.observedMetricCount, 20);
    assert.equal(diversitySnapshot.quality.metricQueryCount, 20);
    assert.equal(diversitySnapshot.quality.metricQuerySucceededCount, 20);
    assert.equal(diversitySnapshot.quality.metricQueryNoObservationCount, 0);
    assert.equal(diversitySnapshot.quality.metricQueryFailedCount, 0);
    assert.equal(Object.values(diversitySnapshot.operations).flatMap((operation) => operation.metrics).length, 20);
    assert.ok(Object.values(diversitySnapshot.operations).every((operation) => (
      operation.quality.detailComplete && operation.metrics.every((metric) => Number.isFinite(metric.value))
    )));
    assert.equal(diversitySnapshot.policy.requiredOverallCodes.join(","), "31,32,33");
    assert.equal(diversitySnapshot.policy.requiredMetricCount, 20);
    assert.equal(diversitySnapshot.source.requestProfile, "metric-code-filter-v3");
    assert.equal(diversitySnapshot.source.normalizerVersion, "regional-index-row-normalizer-v3");
    assert.equal(diversitySnapshot.collection.endpointOperationsPerMonth, 3);
    assert.equal(diversitySnapshot.collection.operationsPerMonth, 20);
    assert.equal(diversitySnapshot.collection.metricQueriesPerMonth, 20);
    assert.equal(diversitySnapshot.collection.operationCallsAttempted, 20);
    assert.equal(diversitySnapshot.collection.maximumOperationCalls, 200);
    assert.equal(regionalIndexRequests.length, 39, "전체 39개 지표는 지표 코드별 39회 호출로 수집해야 합니다.");

    regionalIndexRequests.forEach(({ url, sourceKey, operation }) => {
      assert.equal(url.origin, "https://apis.data.go.kr");
      assert.equal(url.searchParams.get("areaCd"), "48");
      assert.equal(url.searchParams.get("signguCd"), "48860");
      assert.equal(url.searchParams.get("baseYm"), "202606");
      if (sourceKey === "resourceDemand") {
        assert.equal(url.pathname, `/B551011/AreaTarResDemService/${operation}`);
        assert.equal(url.searchParams.get("serviceKey"), "fixture-resource-demand-key");
      } else {
        assert.equal(url.pathname, `/B551011/AreaTarDivService/${operation}`);
        assert.equal(url.searchParams.get("serviceKey"), "fixture-diversity-key");
      }
    });
    const regionalMetricCodeParams = [
      "tarSvcDemIxCd",
      "culResDemIxCd",
      "touDivIxCd",
      "expDivIxCd",
      "intlDivIxCd"
    ];
    const metricParamByOperation = {
      areaTarSvcDemList: "tarSvcDemIxCd",
      areaCulResDemList: "culResDemIxCd",
      areaTouDivList: "touDivIxCd",
      areaExpDivList: "expDivIxCd",
      areaIntlDivList: "intlDivIxCd"
    };
    regionalIndexRequests.forEach(({ url, operation, metricCode }) => {
      const expectedParam = metricParamByOperation[operation];
      assert.equal(url.searchParams.get(expectedParam), metricCode);
      assert.equal(regionalMetricCodeParams.filter((param) => url.searchParams.has(param)).length, 1);
    });
    assert.equal(new Set(regionalIndexRequests.filter((request) => request.sourceKey === "resourceDemand").map((request) => request.metricCode)).size, 19);
    assert.equal(new Set(regionalIndexRequests.filter((request) => request.sourceKey === "diversity").map((request) => request.metricCode)).size, 20);

    const cacheOnlyResourceHistory = await regionalIndexCollector.readResourceDemandHistory({
      regionName: "산청",
      endYearMonth: "202606",
      months: 2
    });
    assert.equal(cacheOnlyResourceHistory.status, "partial");
    assert.equal(cacheOnlyResourceHistory.collection.mode, "cache_only");
    assert.equal(cacheOnlyResourceHistory.collection.networkAttemptedMonths, 0);
    assert.equal(cacheOnlyResourceHistory.coverage.completeMonths, 1);
    assert.equal(cacheOnlyResourceHistory.coverage.missingMonths, 1);
    const missingResourceMonth = cacheOnlyResourceHistory.series.find((point) => point.yearMonth === "202605");
    assert.deepEqual(missingResourceMonth.values, { service: null, culture: null });
    assert.equal(missingResourceMonth.operations.service.label, "관광 서비스 수요");
    assert.equal(missingResourceMonth.operations.service.metrics.length, 13);
    assert.ok(missingResourceMonth.operations.service.metrics.every((metric) => metric.value === null));
    const availableResourceMonth = cacheOnlyResourceHistory.series.find((point) => point.yearMonth === "202606");
    assert.equal(availableResourceMonth.operations.service.overallValue, 71.5);
    assert.ok(Array.isArray(availableResourceMonth.operations.service.metrics));

    const resourceCacheName = (await fsp.readdir(resourceCacheDirectory))
      .find((fileName) => fileName.startsWith("resourcedemand__areatarresdemv3__") && fileName.endsWith("__202606.json"));
    assert.ok(resourceCacheName);
    const resourceCacheFile = path.join(resourceCacheDirectory, resourceCacheName);
    const completeResourceCache = await fsp.readFile(resourceCacheFile);

    omitResourceMetricCode = "1107";
    const incompleteResourceSnapshot = await regionalIndexCollector.collectResourceDemand({
      regionName: "산청",
      yearMonth: "202604"
    });
    assert.equal(incompleteResourceSnapshot.status, "partial");
    assert.equal(incompleteResourceSnapshot.reason, "incomplete_operation_coverage");
    assert.equal(incompleteResourceSnapshot.operations.service.status, "partial");
    assert.equal(incompleteResourceSnapshot.operations.service.reason, "required_detail_metric_missing");
    assert.deepEqual(incompleteResourceSnapshot.operations.service.quality.missingCodes, ["1107"]);
    assert.equal(incompleteResourceSnapshot.operations.service.quality.metricQueryNoObservationCount, 1);
    assert.deepEqual(incompleteResourceSnapshot.operations.service.quality.noObservationMetricCodes, ["1107"]);
    assert.equal(
      incompleteResourceSnapshot.operations.service.metricRequests.find((request) => request.code === "1107").status,
      "no_observation"
    );
    assert.equal(
      incompleteResourceSnapshot.operations.service.metrics.find((metric) => metric.code === "1107").value,
      null
    );
    assert.equal(incompleteResourceSnapshot.operations.culture.status, "ok");
    assert.equal(incompleteResourceSnapshot.collection.operationCallsAttempted, 19);
    assert.equal(
      (await fsp.readdir(resourceCacheDirectory)).some((fileName) => (
        fileName.startsWith("resourcedemand__") && fileName.endsWith("__202604.json")
      )),
      false,
      "세부 지표가 누락된 월은 완전 캐시로 저장하면 안 됩니다."
    );

    const preservedAfterMissing = await regionalIndexCollector.collectResourceDemand({
      regionName: "산청",
      yearMonth: "202606",
      force: true
    });
    assert.equal(preservedAfterMissing.status, "ok");
    assert.equal(preservedAfterMissing.cache.hit, true);
    assert.equal(preservedAfterMissing.cache.refreshFailed, true);
    assert.equal(preservedAfterMissing.collection.operationCallsAttempted, 19);
    assert.equal(preservedAfterMissing.collection.maximumOperationCalls, 190);
    assert.deepEqual(
      await fsp.readFile(resourceCacheFile),
      completeResourceCache,
      "세부 지표가 누락된 새 응답이 기존 완전 캐시를 덮어쓰면 안 됩니다."
    );
    omitResourceMetricCode = "";

    errorResourceMetricCode = "1108";
    const erroredMetricResourceSnapshot = await regionalIndexCollector.collectResourceDemand({
      regionName: "산청",
      yearMonth: "202601"
    });
    assert.equal(erroredMetricResourceSnapshot.status, "partial");
    assert.equal(erroredMetricResourceSnapshot.operations.service.status, "partial");
    assert.equal(erroredMetricResourceSnapshot.operations.service.quality.metricQueryFailedCount, 1);
    assert.deepEqual(erroredMetricResourceSnapshot.operations.service.quality.failedMetricCodes, ["1108"]);
    assert.equal(
      erroredMetricResourceSnapshot.operations.service.metrics.find((metric) => metric.code === "1108").value,
      null
    );
    assert.equal(
      erroredMetricResourceSnapshot.operations.service.metricRequests.find((request) => request.code === "1108").status,
      "error"
    );
    assert.equal(erroredMetricResourceSnapshot.collection.operationCallsAttempted, 19);
    assert.equal(
      (await fsp.readdir(resourceCacheDirectory)).some((fileName) => (
        fileName.startsWith("resourcedemand__areatarresdemv3__") && fileName.endsWith("__202601.json")
      )),
      false,
      "한 지표 호출 오류가 있는 월은 완전 캐시로 저장하면 안 됩니다."
    );
    const preservedAfterMetricError = await regionalIndexCollector.collectResourceDemand({
      regionName: "산청",
      yearMonth: "202606",
      force: true
    });
    assert.equal(preservedAfterMetricError.status, "ok");
    assert.equal(preservedAfterMetricError.cache.hit, true);
    assert.equal(preservedAfterMetricError.cache.refreshFailed, true);
    assert.equal(preservedAfterMetricError.collection.operationCallsAttempted, 19);
    assert.deepEqual(
      await fsp.readFile(resourceCacheFile),
      completeResourceCache,
      "한 지표 호출 오류가 기존 v3 완전 캐시를 덮어쓰면 안 됩니다."
    );
    errorResourceMetricCode = "";

    const resourceCacheBeforeConflict = await fsp.readFile(resourceCacheFile);
    conflictResourceDemand = true;
    const conflictingResourceSnapshot = await regionalIndexCollector.collectResourceDemand({
      regionName: "산청",
      yearMonth: "202603"
    });
    assert.equal(conflictingResourceSnapshot.status, "partial");
    assert.equal(conflictingResourceSnapshot.operations.service.status, "error");
    assert.equal(conflictingResourceSnapshot.operations.service.reason, "duplicate_value_conflict");
    assert.equal(conflictingResourceSnapshot.operations.service.quality.conflictCount, 1);
    assert.equal(
      (await fsp.readdir(resourceCacheDirectory)).some((fileName) => (
        fileName.startsWith("resourcedemand__") && fileName.endsWith("__202603.json")
      )),
      false
    );
    const preservedResourceSnapshot = await regionalIndexCollector.collectResourceDemand({
      regionName: "산청",
      yearMonth: "202606",
      force: true
    });
    assert.equal(preservedResourceSnapshot.status, "ok");
    assert.equal(preservedResourceSnapshot.cache.hit, true);
    assert.equal(preservedResourceSnapshot.cache.refreshFailed, true);
    assert.equal(preservedResourceSnapshot.overall.service, 71.5);
    assert.deepEqual(
      await fsp.readFile(resourceCacheFile),
      resourceCacheBeforeConflict,
      "충돌한 중복값이 정상 자원수요 캐시를 덮어쓰면 안 됩니다."
    );
    conflictResourceDemand = false;

    mismatchDiversityMonth = true;
    const strictMonthDiversity = await regionalIndexCollector.collectDiversity({ regionName: "산청", yearMonth: "202605" });
    assert.equal(strictMonthDiversity.status, "error");
    assert.ok(Object.values(strictMonthDiversity.operations).every((operation) => operation.quality.status === "region_or_period_mismatch"));
    assert.deepEqual(strictMonthDiversity.overall, { visitor: null, spend: null, international: null });
    assert.equal(
      (await fsp.readdir(resourceCacheDirectory)).some((fileName) => fileName.startsWith("diversity__") && fileName.endsWith("__202605.json")),
      false
    );
    mismatchDiversityMonth = false;

    mismatchDiversityRegion = true;
    const strictRegionDiversity = await regionalIndexCollector.collectDiversity({ regionName: "산청", yearMonth: "202604" });
    assert.equal(strictRegionDiversity.status, "error");
    assert.ok(Object.values(strictRegionDiversity.operations).every((operation) => operation.quality.status === "region_or_period_mismatch"));
    assert.deepEqual(strictRegionDiversity.overall, { visitor: null, spend: null, international: null });
    assert.equal(
      (await fsp.readdir(resourceCacheDirectory)).some((fileName) => fileName.startsWith("diversity__") && fileName.endsWith("__202604.json")),
      false
    );
    mismatchDiversityRegion = false;

    const requestCountBeforeGenericRegionalRead = regionalIndexRequests.length;
    const genericRegional = await regionalIndexCollector.collect({
      keyword: "산청글램핑",
      yearMonth: "202606",
      sources: ["resourceDemand", "diversity"],
      force: true
    });
    assert.equal(genericRegional.sources.resourceDemand.status, "ok");
    assert.equal(genericRegional.sources.diversity.status, "ok");
    assert.equal(regionalIndexRequests.length, requestCountBeforeGenericRegionalRead);

    const regionalIndexStatus = await regionalIndexCollector.status();
    const resourceStatus = regionalIndexStatus.sources.find((source) => source.key === "resourceDemand");
    const diversityStatus = regionalIndexStatus.sources.find((source) => source.key === "diversity");
    assert.equal(resourceStatus.status, "ready");
    assert.equal(resourceStatus.adapter, "area-tar-res-dem-v3");
    assert.equal(resourceStatus.normalizerVersion, "regional-index-row-normalizer-v3");
    assert.equal(resourceStatus.requestProfile, "metric-code-filter-v3");
    assert.equal(resourceStatus.endpointOperationsPerMonth, 2);
    assert.equal(resourceStatus.operationsPerMonth, 19);
    assert.equal(resourceStatus.metricQueriesPerMonth, 19);
    assert.equal(resourceStatus.maxPagesPerMetric, 10);
    assert.equal(resourceStatus.maximumOperationCallsPerMonth, 190);
    assert.deepEqual(resourceStatus.requiredOverallCodes, ["11", "12"]);
    assert.equal(resourceStatus.requiredMetricCount, 19);
    assert.deepEqual(Object.values(resourceStatus.requiredMetricCodes).map((codes) => codes.length), [13, 6]);
    assert.equal(resourceStatus.qualityPolicy.completeRequiresAllExpectedMetricCodes, true);
    assert.equal(resourceStatus.cache.snapshotCount, 1);
    assert.equal(diversityStatus.status, "ready");
    assert.equal(diversityStatus.adapter, "area-tar-div-v3");
    assert.equal(diversityStatus.normalizerVersion, "regional-index-row-normalizer-v3");
    assert.equal(diversityStatus.requestProfile, "metric-code-filter-v3");
    assert.equal(diversityStatus.endpointOperationsPerMonth, 3);
    assert.equal(diversityStatus.operationsPerMonth, 20);
    assert.equal(diversityStatus.metricQueriesPerMonth, 20);
    assert.equal(diversityStatus.maxPagesPerMetric, 10);
    assert.equal(diversityStatus.maximumOperationCallsPerMonth, 200);
    assert.deepEqual(diversityStatus.requiredOverallCodes, ["31", "32", "33"]);
    assert.equal(diversityStatus.requiredMetricCount, 20);
    assert.deepEqual(Object.values(diversityStatus.requiredMetricCodes).map((codes) => codes.length), [8, 8, 4]);
    assert.equal(diversityStatus.qualityPolicy.completeRequiresAllExpectedMetricCodes, true);
    assert.equal(diversityStatus.cache.snapshotCount, 1);
    assert.equal(regionalIndexStatus.resourceDemand.snapshotCount, 1);
    assert.equal(regionalIndexStatus.diversity.snapshotCount, 1);
    assert.doesNotMatch(JSON.stringify(regionalIndexStatus), /fixture-(resource-demand|diversity)-key/);

    paginatedResourceMetricCode = "1101";
    const requestsBeforeMetricPagination = regionalIndexRequests.length;
    const paginatedResourceSnapshot = await regionalIndexCollector.collectResourceDemand({
      regionName: "산청",
      yearMonth: "202602",
      maxPagesPerOperation: 2
    });
    assert.equal(paginatedResourceSnapshot.status, "ok");
    assert.equal(paginatedResourceSnapshot.collection.operationsPerMonth, 19);
    assert.equal(paginatedResourceSnapshot.collection.operationCallsAttempted, 20);
    assert.equal(paginatedResourceSnapshot.collection.maximumOperationCalls, 38);
    assert.equal(regionalIndexRequests.length - requestsBeforeMetricPagination, 20);
    const paginatedMetricRequest = paginatedResourceSnapshot.operations.service.metricRequests
      .find((request) => request.code === "1101");
    assert.equal(paginatedMetricRequest.pageCount, 2);
    assert.equal(paginatedMetricRequest.requestCount, 2);
    assert.equal(paginatedResourceSnapshot.operations.service.quality.duplicateRowCount, 10);
    paginatedResourceMetricCode = "";

    const requestsBeforeTwelveMonthHistory = regionalIndexRequests.length;
    const resourceTwelveMonthHistory = await regionalIndexCollector.collectResourceDemandHistory({
      regionName: "산청",
      endYearMonth: "202505",
      months: 12,
      collectMissing: true,
      concurrency: 2,
      maxPagesPerOperation: 1
    });
    assert.equal(resourceTwelveMonthHistory.status, "ok");
    assert.equal(resourceTwelveMonthHistory.coverage.completeMonths, 12);
    assert.equal(resourceTwelveMonthHistory.collection.endpointOperationsPerMonth, 2);
    assert.equal(resourceTwelveMonthHistory.collection.operationsPerMonth, 19);
    assert.equal(resourceTwelveMonthHistory.collection.metricQueriesPerMonth, 19);
    assert.equal(resourceTwelveMonthHistory.collection.operationCallsAttempted, 228);
    assert.equal(resourceTwelveMonthHistory.collection.maximumOperationCalls, 228);
    assert.ok(resourceTwelveMonthHistory.series.every((point) => (
      Object.values(point.operations).flatMap((operation) => operation.metrics).length === 19
      && Object.values(point.operations).flatMap((operation) => operation.metricRequests).length === 19
      && Object.values(point.operations).every((operation) => operation.metrics.every((metric) => Number.isFinite(metric.value)))
    )));
    const requestsAfterResourceHistory = regionalIndexRequests.length;
    assert.equal(requestsAfterResourceHistory - requestsBeforeTwelveMonthHistory, 228);

    const diversityTwelveMonthHistory = await regionalIndexCollector.collectDiversityHistory({
      regionName: "산청",
      endYearMonth: "202505",
      months: 12,
      collectMissing: true,
      concurrency: 2,
      maxPagesPerOperation: 1
    });
    assert.equal(diversityTwelveMonthHistory.status, "ok");
    assert.equal(diversityTwelveMonthHistory.coverage.completeMonths, 12);
    assert.equal(diversityTwelveMonthHistory.collection.endpointOperationsPerMonth, 3);
    assert.equal(diversityTwelveMonthHistory.collection.operationsPerMonth, 20);
    assert.equal(diversityTwelveMonthHistory.collection.metricQueriesPerMonth, 20);
    assert.equal(diversityTwelveMonthHistory.collection.operationCallsAttempted, 240);
    assert.equal(diversityTwelveMonthHistory.collection.maximumOperationCalls, 240);
    assert.ok(diversityTwelveMonthHistory.series.every((point) => (
      Object.values(point.operations).flatMap((operation) => operation.metrics).length === 20
      && Object.values(point.operations).flatMap((operation) => operation.metricRequests).length === 20
      && Object.values(point.operations).every((operation) => operation.metrics.every((metric) => Number.isFinite(metric.value)))
    )));
    assert.equal(regionalIndexRequests.length - requestsAfterResourceHistory, 240);
    assert.equal(
      regionalIndexRequests.length - requestsBeforeTwelveMonthHistory,
      468,
      "산청군 12개월 전체 39개 지표는 지표 코드별 468회 호출이어야 합니다."
    );

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
