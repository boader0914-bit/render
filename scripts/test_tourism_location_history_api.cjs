const assert = require("node:assert/strict");
const fsp = require("node:fs/promises");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { once } = require("node:events");

const ROOT = path.resolve(__dirname, "..");
const SERVER_PATH = path.join(__dirname, "glamping_app_server.cjs");
const TEST_ADMIN_USER = "tourism-cache-admin";
const TEST_ADMIN_PASSWORD = "tourism-cache-admin-password";
const TEST_B2B_USER = "tourism-cache-b2b";
const TEST_B2B_PASSWORD = "tourism-cache-b2b-password";
const SANCHEONG_REGION_KEY = "kr_gyeongnam_sancheong";
const SANCHEONG_RUN_ID = "gyeongnam_glamping_20260627_111220";
const NEWER_UNRELATED_RUN_ID = "chungnam_glamping_20260704_003030";
const LODGING_SEARCH_SUFFIXES = [
  "글램핑장", "오토캠핑장", "캠핑장", "야영장", "풀빌라", "카라반", "글램핑",
  "펜션", "리조트", "호텔", "모텔", "캠핑", "스테이", "숙박", "숙소"
];

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function csvCell(value) {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function csvText(columns, rows) {
  return [
    columns.map(csvCell).join(","),
    ...rows.map((row) => columns.map((column) => csvCell(row[column])).join(","))
  ].join("\n");
}

async function trafficKeywordFunctionUnderTest() {
  const source = await fsp.readFile(SERVER_PATH, "utf8");
  const functionSource = source.match(/function trafficKeywordForRegion\(keyword, region\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(functionSource, "trafficKeywordForRegion 함수를 찾지 못했습니다.");
  const compactKeyword = (keyword) => String(keyword || "").replace(/\s+/g, "");
  const lodgingSearchSuffix = (keyword) => {
    const compact = compactKeyword(keyword);
    return LODGING_SEARCH_SUFFIXES.find((suffix) => compact.endsWith(suffix)) || "";
  };
  const lodgingSearchSuffixInKeyword = (keyword) => {
    const compact = compactKeyword(keyword);
    return LODGING_SEARCH_SUFFIXES.find((suffix) => compact.includes(suffix)) || "";
  };
  const normalizeSearchKeyword = (keyword) => {
    const compact = compactKeyword(keyword);
    if (!compact) return "";
    return lodgingSearchSuffix(compact) ? compact : `${compact}글램핑`;
  };
  const adminRegionToken = (value) => compactKeyword(value)
    .normalize("NFKC")
    .replace(/(특별자치도|특별자치시|특별시|광역시|자치시|자치구|도|시|군|구)$/u, "");
  return Function(
    "compactKeyword",
    "adminRegionToken",
    "lodgingSearchSuffixInKeyword",
    "normalizeSearchKeyword",
    `return (${functionSource});`
  )(compactKeyword, adminRegionToken, lodgingSearchSuffixInKeyword, normalizeSearchKeyword);
}

async function writeRunFixture(outputRoot, runId, manifest, regionalFile, rows, traffic) {
  const dirPath = path.join(outputRoot, runId);
  await fsp.mkdir(dirPath, { recursive: true });
  await Promise.all([
    fsp.writeFile(path.join(dirPath, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8"),
    fsp.writeFile(path.join(dirPath, regionalFile), csvText([
      "기준키워드",
      "검색키워드",
      "검색클러스터",
      "소재지클러스터",
      "지역",
      "순위",
      "place_id",
      "업체명",
      "카테고리",
      "주소",
      "객실수(노출)",
      "객실명(일부)",
      "금액",
      "총리뷰",
      "방문자리뷰",
      "평점",
      "예약",
      "네이버예약재고수집상태",
      "예약최저가",
      "url"
    ], rows), "utf8"),
    fsp.writeFile(path.join(dirPath, "traffic_metrics.json"), JSON.stringify(traffic, null, 2), "utf8")
  ]);
}

async function writeSnapshotFixtures(tempRoot) {
  const outputRoot = path.join(tempRoot, "outputs");
  const sancheongRegionalFile = "경남글램핑_네이버지역별순위.csv";
  const sancheongRows = Array.from({ length: 10 }, (_, index) => {
    const rank = index + 1;
    return {
      기준키워드: "경남글램핑",
      검색키워드: "경남 산청 글램핑",
      검색클러스터: "산청",
      소재지클러스터: "산청",
      지역: "산청",
      순위: rank,
      place_id: `sancheong-${rank}`,
      업체명: rank === 1 ? "월명 글램핑" : `산청 숙소 ${rank}`,
      카테고리: "캠핑",
      주소: "경남 산청군",
      "객실수(노출)": rank === 1 ? 5 : 3,
      "객실명(일부)": `글램핑 ${rank}`,
      금액: `${100000 + rank * 10000}~${200000 + rank * 10000}원`,
      총리뷰: rank * 10,
      방문자리뷰: rank * 20,
      평점: rank === 1 ? 4.81 : rank === 7 ? 4.89 : 0,
      예약: "Y",
      네이버예약재고수집상태: rank === 1 ? "성공" : rank <= 4 ? "성공(과거ID)" : "미수집(상위 20개 제한)",
      예약최저가: rank <= 4 ? `${200000 + rank * 10000}원` : "",
      url: `https://example.test/sancheong-${rank}`
    };
  });
  await writeRunFixture(
    outputRoot,
    SANCHEONG_RUN_ID,
    {
      keyword: "경남글램핑",
      provinceKey: "gyeongnam",
      searchKeyword: "경남 글램핑",
      checkIn: "2026-06-27",
      fileRoles: { regional: sancheongRegionalFile },
      files: [sancheongRegionalFile],
      counts: { naverRegional: 10 }
    },
    sancheongRegionalFile,
    sancheongRows,
    {
      source: "naver_searchad_keywordstool",
      updatedAt: "2026-06-27T02:17:37.940Z",
      metrics: {
        산청글램핑: {
          keyword: "산청글램핑",
          relKeyword: "산청글램핑",
          collectable: true,
          status: 200,
          monthlyPc: 380,
          monthlyMobile: 2060,
          totalSearchVolume: 2440,
          monthlyPcClicks: 0.6,
          monthlyMobileClicks: 21,
          totalClicks: 21.6,
          pcCtr: 0.17,
          mobileCtr: 1.07,
          combinedCtr: 0.89,
          competition: "높음"
        }
      }
    }
  );

  const unrelatedRegionalFile = "충남글램핑_네이버지역별순위.csv";
  await writeRunFixture(
    outputRoot,
    NEWER_UNRELATED_RUN_ID,
    {
      keyword: "충남글램핑",
      provinceKey: "chungnam",
      searchKeyword: "충남 글램핑",
      collectedAt: "2026-07-04T03:30:30.000Z",
      fileRoles: { regional: unrelatedRegionalFile },
      files: [unrelatedRegionalFile],
      counts: { naverRegional: 1 }
    },
    unrelatedRegionalFile,
    [{
      기준키워드: "충남글램핑",
      검색키워드: "충남 태안 글램핑",
      검색클러스터: "태안",
      소재지클러스터: "태안",
      지역: "태안",
      순위: 1,
      place_id: "taean-1",
      업체명: "태안 최신 숙소",
      카테고리: "캠핑",
      주소: "충남 태안군",
      "객실수(노출)": 5,
      "객실명(일부)": "태안 글램핑",
      금액: "180000~280000원",
      총리뷰: 100,
      방문자리뷰: 200,
      평점: 4.9,
      예약: "Y",
      네이버예약재고수집상태: "성공",
      예약최저가: "200000원",
      url: "https://example.test/taean-1"
    }],
    {
      source: "naver_searchad_keywordstool",
      updatedAt: "2026-07-04T03:30:30.000Z",
      metrics: {
        태안글램핑: {
          keyword: "태안글램핑",
          collectable: true,
          status: 200,
          monthlyPc: 100,
          monthlyMobile: 900,
          totalSearchVolume: 1000,
          competition: "높음"
        }
      }
    }
  );
}

async function freePort() {
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  const port = Number(address?.port || 0);
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForServer(baseUrl, child, output) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`서버가 준비 전에 종료됐습니다.\n${output.join("")}`);
    }
    try {
      const response = await fetch(`${baseUrl}/api/health`, {
        headers: { Accept: "application/json" }
      });
      if (response.ok) return;
    } catch {
      // Server startup is still in progress.
    }
    await delay(50);
  }
  throw new Error(`서버 시작 시간이 초과됐습니다.\n${output.join("")}`);
}

async function login(baseUrl, username, password) {
  const response = await fetch(`${baseUrl}/api/login`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ username, password })
  });
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  const cookie = String(response.headers.get("set-cookie") || "").split(";")[0];
  assert.match(cookie, /^glamping_datalab_session=/);
  return cookie;
}

async function getJson(baseUrl, pathname, cookie = "") {
  const response = await fetch(`${baseUrl}${pathname}`, {
    headers: {
      Accept: "application/json",
      ...(cookie ? { Cookie: cookie } : {})
    }
  });
  const body = await response.json();
  return { response, body };
}

async function postJson(baseUrl, pathname, payload, cookie = "") {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      ...(cookie ? { Cookie: cookie } : {})
    },
    body: JSON.stringify(payload)
  });
  const body = await response.json();
  return { response, body };
}

async function stopChild(child) {
  if (!child || child.exitCode !== null) return;
  child.kill();
  await Promise.race([once(child, "exit"), delay(3000)]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

async function main() {
  const trafficKeywordForRegion = await trafficKeywordFunctionUnderTest();
  assert.equal(trafficKeywordForRegion("경남 산청 글램핑", "산청"), "산청글램핑");
  assert.equal(trafficKeywordForRegion("경남 산청 글램핑", "산청군"), "산청글램핑");
  assert.equal(trafficKeywordForRegion("충남 태안 펜션", "태안"), "태안펜션");
  assert.equal(trafficKeywordForRegion("경남글램핑", "경남"), "경남글램핑");
  assert.equal(trafficKeywordForRegion("경남글램핑", ""), "경남글램핑");

  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "glamping-tourism-location-api-"));
  await writeSnapshotFixtures(tempRoot);
  const output = [];
  let externalRequestCount = 0;
  const trapServer = http.createServer((req, res) => {
    externalRequestCount += 1;
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "external request forbidden in cache-only test", path: req.url }));
  });
  trapServer.listen(0, "127.0.0.1");
  await once(trapServer, "listening");
  const trapPort = Number(trapServer.address()?.port || 0);
  const appPort = await freePort();
  const baseUrl = `http://127.0.0.1:${appPort}`;
  const child = spawn(process.execPath, [SERVER_PATH], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(appPort),
      HOST: "127.0.0.1",
      DATA_DIR: tempRoot,
      OUTPUTS_DIR: path.join(tempRoot, "outputs"),
      CONFIG_DIR: path.join(tempRoot, "config"),
      SEED_OUTPUTS_FROM_REPO: "0",
      GLAMPING_ADMIN_USER: TEST_ADMIN_USER,
      GLAMPING_ADMIN_PASSWORD: TEST_ADMIN_PASSWORD,
      GLAMPING_B2B_USER: TEST_B2B_USER,
      GLAMPING_B2B_PASSWORD: TEST_B2B_PASSWORD,
      GLAMPING_B2B_ENABLED: "1",
      DATA_GO_KR_VISITOR_SERVICE_KEY: "test-visitor-key",
      DATA_GO_KR_DEMAND_STRENGTH_SERVICE_KEY: "test-demand-strength-key",
      KTO_TOURISM_VISITOR_ENDPOINT: `http://127.0.0.1:${trapPort}/visitor`,
      KTO_TOURISM_DEMAND_STRENGTH_ENDPOINT: `http://127.0.0.1:${trapPort}/demand-strength`
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout.on("data", (chunk) => output.push(String(chunk)));
  child.stderr.on("data", (chunk) => output.push(String(chunk)));

  try {
    await waitForServer(baseUrl, child, output);

    const unauthenticated = await getJson(
      baseUrl,
      `/api/tourism-data/location-history?regionKey=${encodeURIComponent(SANCHEONG_REGION_KEY)}`
    );
    assert.equal(unauthenticated.response.status, 401);

    const b2bCookie = await login(baseUrl, TEST_B2B_USER, TEST_B2B_PASSWORD);
    const forbidden = await getJson(
      baseUrl,
      `/api/tourism-data/location-history?regionKey=${encodeURIComponent(SANCHEONG_REGION_KEY)}`,
      b2bCookie
    );
    assert.equal(forbidden.response.status, 403);

    const adminCookie = await login(baseUrl, TEST_ADMIN_USER, TEST_ADMIN_PASSWORD);
    const missingSelector = await getJson(baseUrl, "/api/tourism-data/location-history", adminCookie);
    assert.equal(missingSelector.response.status, 400);

    const duplicateSelector = await getJson(
      baseUrl,
      `/api/tourism-data/location-history?regionKey=${encodeURIComponent(SANCHEONG_REGION_KEY)}&regionName=${encodeURIComponent("산청군")}`,
      adminCookie
    );
    assert.equal(duplicateSelector.response.status, 400);

    const injectedKey = await getJson(
      baseUrl,
      `/api/tourism-data/location-history?regionKey=${encodeURIComponent(SANCHEONG_REGION_KEY)}&serviceKey=forbidden`,
      adminCookie
    );
    assert.equal(injectedKey.response.status, 400);
    assert.match(injectedKey.body.error, /인증키/);

    const injectedVisitorRefresh = await postJson(
      baseUrl,
      "/api/tourism-data/visitors/history",
      { regionKeys: [SANCHEONG_REGION_KEY], serviceKey: "forbidden" },
      adminCookie
    );
    assert.equal(injectedVisitorRefresh.response.status, 400);
    assert.match(injectedVisitorRefresh.body.error, /인증키/);

    const injectedDemandStrengthRefresh = await postJson(
      baseUrl,
      "/api/tourism-data/demand-strength/history",
      { regionKey: SANCHEONG_REGION_KEY, Endpoint: "http://forbidden.invalid" },
      adminCookie
    );
    assert.equal(injectedDemandStrengthRefresh.response.status, 400);
    assert.match(injectedDemandStrengthRefresh.body.error, /API 주소/);

    const provinceOnly = await getJson(
      baseUrl,
      `/api/tourism-data/location-history?regionName=${encodeURIComponent("경남")}`,
      adminCookie
    );
    assert.equal(provinceOnly.response.status, 400);

    const unknownRegion = await getJson(
      baseUrl,
      "/api/tourism-data/location-history?regionKey=kr_unknown_missing",
      adminCookie
    );
    assert.equal(unknownRegion.response.status, 404);

    const byRegionKey = await getJson(
      baseUrl,
      `/api/tourism-data/location-history?regionKey=${encodeURIComponent(SANCHEONG_REGION_KEY)}`,
      adminCookie
    );
    assert.equal(byRegionKey.response.status, 200, JSON.stringify(byRegionKey.body));
    assert.equal(byRegionKey.body.ok, true);
    assert.equal(byRegionKey.body.region.regionKey, SANCHEONG_REGION_KEY);
    assert.equal(byRegionKey.body.region.sigungu, "산청군");
    assert.equal(byRegionKey.body.policy.adminOnly, true);
    assert.equal(byRegionKey.body.policy.cacheOnly, true);
    assert.equal(byRegionKey.body.policy.externalRequestsAllowed, false);
    assert.equal(byRegionKey.body.cache.mode, "cache_only");
    assert.equal(byRegionKey.body.cache.requestedMonths, 36);
    assert.equal(byRegionKey.body.cache.externalRequestsAttempted, 0);
    assert.equal(byRegionKey.body.tourismVisitorHistory.collection.mode, "cache_only");
    assert.equal(byRegionKey.body.tourismVisitorHistory.collection.networkAttemptedMonths, 0);
    assert.deepEqual(
      byRegionKey.body.tourismVisitorHistory.regions.map((region) => region.regionKey),
      [SANCHEONG_REGION_KEY]
    );
    assert.equal(byRegionKey.body.tourismDemandStrengthHistory.collection.mode, "cache_only");
    assert.equal(byRegionKey.body.tourismDemandStrengthHistory.collection.networkAttemptedMonths, 0);
    assert.equal(byRegionKey.body.tourismDemandStrengthHistory.region.regionKey, SANCHEONG_REGION_KEY);
    assert.equal(byRegionKey.body.naverPlace.status, "observed");
    assert.equal(byRegionKey.body.naverPlace.runId, SANCHEONG_RUN_ID);
    assert.notEqual(byRegionKey.body.naverPlace.runId, NEWER_UNRELATED_RUN_ID);
    assert.equal(byRegionKey.body.naverPlace.searchKeyword, "경남 산청 글램핑");
    assert.equal(byRegionKey.body.naverPlace.observedDate, "2026-06-27");
    assert.equal(byRegionKey.body.naverPlace.collectedAt, "2026-06-27T02:17:37.940Z");
    assert.equal(byRegionKey.body.naverPlace.items.length, 10);
    assert.equal(byRegionKey.body.naverPlace.detailCount, 4);
    assert.equal(byRegionKey.body.naverPlace.unobservedDetailCount, 6);
    assert.equal(byRegionKey.body.naverPlace.items[0].name, "월명 글램핑");
    assert.equal(byRegionKey.body.naverPlace.items[0].rating, 4.81);
    assert.equal(byRegionKey.body.naverPlace.items[0].detailObserved, true);
    assert.equal(byRegionKey.body.naverPlace.items[1].rating, null, "평점 0 sentinel은 null이어야 합니다.");
    assert.equal(byRegionKey.body.naverPlace.items[3].detailObserved, true);
    assert.equal(byRegionKey.body.naverPlace.items[4].detailObserved, false);
    assert.equal(byRegionKey.body.naverKeyword.status, "observed");
    assert.equal(byRegionKey.body.naverKeyword.runId, SANCHEONG_RUN_ID);
    assert.notEqual(byRegionKey.body.naverKeyword.runId, NEWER_UNRELATED_RUN_ID);
    assert.equal(byRegionKey.body.naverKeyword.keyword, "산청글램핑");
    assert.equal(byRegionKey.body.naverKeyword.totalSearchVolume, 2440);
    assert.equal(byRegionKey.body.naverKeyword.monthlyPc, 380);
    assert.equal(byRegionKey.body.naverKeyword.monthlyMobile, 2060);
    assert.equal(byRegionKey.body.naverKeyword.competition, "높음");
    assert.equal(byRegionKey.body.naverKeyword.updatedAt, "2026-06-27T02:17:37.940Z");
    assert.equal(byRegionKey.body.naverKeyword.metric.totalSearchVolume, 2440);

    const byRegionName = await getJson(
      baseUrl,
      `/api/tourism-data/location-history?regionName=${encodeURIComponent("산청 글램핑")}`,
      adminCookie
    );
    assert.equal(byRegionName.response.status, 200, JSON.stringify(byRegionName.body));
    assert.equal(byRegionName.body.selector.type, "regionName");
    assert.equal(byRegionName.body.region.regionKey, SANCHEONG_REGION_KEY);
    assert.deepEqual(
      byRegionName.body.tourismVisitorHistory.regions.map((region) => region.regionKey),
      [SANCHEONG_REGION_KEY]
    );
    assert.equal(byRegionName.body.tourismDemandStrengthHistory.region.regionKey, SANCHEONG_REGION_KEY);
    assert.equal(byRegionName.body.naverPlace.items.length, 10);
    assert.equal(byRegionName.body.naverKeyword.totalSearchVolume, 2440);

    await delay(100);
    assert.equal(externalRequestCount, 0, "캐시 조회 GET이 외부 관광 API를 호출했습니다.");
    console.log("tourism location history cache API tests passed");
  } finally {
    await stopChild(child);
    await new Promise((resolve) => trapServer.close(resolve));
    const expectedPrefix = path.join(os.tmpdir(), "glamping-tourism-location-api-");
    if (path.resolve(tempRoot).startsWith(path.resolve(expectedPrefix))) {
      await fsp.rm(tempRoot, { recursive: true, force: true });
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
