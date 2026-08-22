const assert = require("node:assert/strict");
const fsp = require("node:fs/promises");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { spawn } = require("node:child_process");

const CASES = [
  { keyword: "경남펜션", requested: "company", expected: "keyword" },
  { keyword: "경남 펜션", requested: "company", expected: "keyword" },
  { keyword: "경남글램핑", requested: "company", expected: "keyword" },
  { keyword: "경남풀빌라", requested: "company", expected: "keyword" },
  { keyword: "경상남도 펜션", requested: "company", expected: "keyword" },
  { keyword: "경상남펜션", requested: "company", expected: "keyword" },
  { keyword: "전라북펜션", requested: "company", expected: "keyword" },
  { keyword: "산청풀빌라", requested: "company", expected: "keyword" },
  { keyword: "포천오토캠핑장", requested: "company", expected: "keyword" },
  { keyword: "경남카라반캠핑장", requested: "company", expected: "keyword" },
  { keyword: "포천글램핑장", requested: "company", expected: "keyword" },
  { keyword: "가평캠핑장", requested: "company", expected: "keyword" },
  { keyword: "강원야영장", requested: "company", expected: "keyword" },
  { keyword: "제주카라반", requested: "company", expected: "keyword" },
  { keyword: "경남캠핑", requested: "company", expected: "keyword" },
  { keyword: "제주 글램핑", requested: "company", expected: "keyword" },
  { keyword: "경남 숙소", requested: "company", expected: "keyword" },
  { keyword: "경남숙소", requested: "company", expected: "keyword" },
  { keyword: "경남 숙박", requested: "company", expected: "keyword" },
  { keyword: "서울 숙소", requested: "company", expected: "keyword" },
  { keyword: "산청 숙박", requested: "company", expected: "keyword" },
  { keyword: "거제생각속의집펜션", requested: "company", expected: "company" },
  { keyword: "월명글램핑", requested: "company", expected: "company" },
  { keyword: "산청애펜션", requested: "company", expected: "company" },
  { keyword: "경남리조트", requested: "company", expected: "company" },
  { keyword: "경남펜션", requested: "keyword", expected: "keyword" }
];

const BROAD_LODGING_INTENT_CASES = [
  { keyword: "경남 숙소", kind: "broad_lodging", region: "경남", scope: "all_lodging", label: "전체 숙박" },
  { keyword: "경남숙박", kind: "broad_lodging", region: "경남", scope: "all_lodging", label: "전체 숙박" },
  { keyword: "경상남도 숙소", kind: "broad_lodging", region: "경남", scope: "all_lodging", label: "전체 숙박" },
  { keyword: "서울 숙소", kind: "broad_lodging", region: "서울", scope: "all_lodging", label: "전체 숙박" },
  { keyword: "대구 숙소", kind: "broad_lodging", region: "대구", scope: "all_lodging", label: "전체 숙박" },
  { keyword: "대구광역시 숙소", kind: "broad_lodging", region: "대구", scope: "all_lodging", label: "전체 숙박" },
  { keyword: "산청 숙박", kind: "broad_lodging", region: "산청", scope: "all_lodging", label: "전체 숙박" },
  { keyword: "경남펜션", kind: "typed_lodging", region: "경남", scope: "lodging_type:펜션", label: "펜션" },
  { keyword: "경남 숙소 추천", kind: "keyword", region: "", scope: "keyword", label: "키워드 검색" },
  { keyword: "숙소", kind: "missing_region", region: "", scope: "all_lodging", label: "전체 숙박", needsRegion: true },
  { keyword: "숙박", kind: "missing_region", region: "", scope: "all_lodging", label: "전체 숙박", needsRegion: true }
];

const ADDITIONAL_SUPPORTED_REGIONS = [
  "경산", "의성", "청송", "영양", "고령", "예천", "봉화", "울릉", "김제",
  "논산", "계룡", "금산", "서천", "청양", "증평", "진천", "음성", "경기광주"
];

const ACCOMMODATION_TYPE_CASES = [
  { row: { 업체명: "바다빛 풀빌라 펜션" }, expected: "풀빌라" },
  { row: { 카테고리: "글램핑" }, expected: "글램핑" },
  { row: { 업체명: "숲속 오토캠핑장" }, expected: "캠핑·야영장" },
  { row: { 카테고리: "펜션" }, expected: "펜션" },
  { row: { 카테고리: "호텔 리조트" }, expected: "호텔·리조트" },
  { row: { 카테고리: "모텔" }, expected: "모텔" },
  { row: { 카테고리: "농어촌민박" }, expected: "민박·게스트하우스·스테이" },
  { row: { 업체명: "지역 숙박시설" }, expected: "복합·미분류" }
];

const COLLECTION_RANGE_CASES = [
  {
    label: "basic default",
    payload: { keyword: "경남펜션", searchMode: "keyword", collectionPurpose: "basic_db", collectionMode: "precision" },
    expectedRange: "1-40",
    expectedStockLimit: 40,
    expectedWeeklyLimit: 0
  },
  {
    label: "detail default",
    payload: { keyword: "경남펜션", searchMode: "keyword", collectionPurpose: "revenue_detail", collectionMode: "precision" },
    expectedRange: "1-20",
    expectedStockLimit: 20,
    expectedWeeklyLimit: 20
  },
  {
    label: "basic custom",
    payload: { keyword: "경남펜션", searchMode: "keyword", collectionPurpose: "basic_db", collectionMode: "precision", detailRankRanges: "1-15" },
    expectedRange: "1-15",
    expectedStockLimit: 15,
    expectedWeeklyLimit: 0
  },
  {
    label: "basic custom beyond convenience default",
    payload: { keyword: "경남펜션", searchMode: "keyword", collectionPurpose: "basic_db", collectionMode: "precision", detailRankRanges: "1-75" },
    expectedRange: "1-75",
    expectedStockLimit: 75,
    expectedWeeklyLimit: 0
  },
  {
    label: "detail custom beyond convenience default",
    payload: { keyword: "경남펜션", searchMode: "keyword", collectionPurpose: "revenue_detail", collectionMode: "precision", detailRankRanges: "1-35", bookingRangeDays: 7 },
    expectedRange: "1-35",
    expectedStockLimit: 35,
    expectedWeeklyLimit: 35
  },
  {
    label: "fast safety",
    payload: { keyword: "경남펜션", searchMode: "keyword", collectionPurpose: "basic_db", collectionMode: "fast" },
    expectedRange: "없음",
    expectedStockLimit: 0,
    expectedWeeklyLimit: 0
  }
];

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

function request(baseUrl, method, pathname, body, cookies = []) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : "";
    const req = http.request(`${baseUrl}${pathname}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
        Cookie: cookies.join("; ")
      }
    }, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        let parsed = {};
        try {
          parsed = data ? JSON.parse(data) : {};
        } catch {
          parsed = { raw: data };
        }
        const setCookie = res.headers["set-cookie"] || [];
        resolve({
          statusCode: res.statusCode,
          cookies: setCookie.map((item) => item.split(";")[0]),
          body: parsed
        });
      });
    });
    req.once("error", reject);
    req.setTimeout(10000, () => req.destroy(new Error(`request timeout: ${method} ${pathname}`)));
    if (payload) req.write(payload);
    req.end();
  });
}

async function stopChild(child) {
  if (!child || child.exitCode !== null) return;
  await new Promise((resolve) => {
    let timer = null;
    const finish = () => {
      if (timer) clearTimeout(timer);
      resolve();
    };
    child.once("exit", finish);
    child.kill();
    timer = setTimeout(finish, 5000);
  });
}

async function waitForServer(child) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("server start timeout")), 20000);
    const onData = (chunk) => {
      if (!String(chunk || "").includes("Lodging datalab beta app running")) return;
      clearTimeout(timeout);
      resolve();
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`server exited before ready: ${code}`));
    });
  });
}

async function loadClientClassifier() {
  const appPath = path.resolve(__dirname, "..", "web", "app.js");
  const source = await fsp.readFile(appPath, "utf8");
  const start = source.indexOf("const REGIONAL_GLAMPING_BASES");
  const end = source.indexOf("function adminUserViewRequested", start);
  assert.ok(start >= 0 && end > start, "client search-mode classifier source block not found");
  const context = {};
  vm.runInNewContext(
    `${source.slice(start, end)}\nthis.__searchModeTest = { correctedSearchMode, regionalLodgingSearchIntent, companyCollectionTargetNames };`,
    context,
    { filename: appPath }
  );
  return context.__searchModeTest;
}

async function verifyClientClassifier() {
  const classifier = await loadClientClassifier();
  for (const testCase of CASES) {
    assert.equal(
      classifier.correctedSearchMode(testCase.keyword, testCase.requested),
      testCase.expected,
      `client mode mismatch for ${testCase.keyword}`
    );
  }
  for (const testCase of BROAD_LODGING_INTENT_CASES) {
    const intent = classifier.regionalLodgingSearchIntent(testCase.keyword);
    assert.equal(intent.kind, testCase.kind, `client intent mismatch for ${testCase.keyword}`);
    assert.equal(intent.region, testCase.region, `client region mismatch for ${testCase.keyword}`);
    assert.equal(intent.scope, testCase.scope, `client scope mismatch for ${testCase.keyword}`);
    assert.equal(intent.label, testCase.label, `client scope label mismatch for ${testCase.keyword}`);
    assert.equal(
      intent.needsRegion,
      testCase.needsRegion === true,
      `${testCase.keyword} needsRegion mismatch`
    );
  }
  for (const region of ADDITIONAL_SUPPORTED_REGIONS) {
    const intent = classifier.regionalLodgingSearchIntent(`${region} 숙소`);
    assert.equal(intent.kind, "broad_lodging", `${region} 숙소 should be a supported broad lodging search`);
    assert.equal(intent.region, region, `${region} 숙소 should preserve its region`);
    assert.equal(intent.needsRegion, false, `${region} 숙소 should not ask for another region`);
  }
  assert.equal(
    classifier.correctedSearchMode("경남숙소", "company", { recrawlContext: { type: "company", companyIds: ["cmp_1"], companyNames: ["경남숙소"], keyword: "경남숙소" } }),
    "company",
    "an explicit company recrawl must bypass the regional broad-keyword correction"
  );
  assert.equal(
    classifier.correctedSearchMode("경남숙소", "company", { recrawlContext: { type: "company", companyIds: ["cmp_1"], companyNames: ["다른업체"], keyword: "다른업체" } }),
    "keyword",
    "a stale company recrawl context must not bypass broad-keyword correction"
  );
  assert.equal(
    classifier.correctedSearchMode("경남펜션", "keyword", { recrawlContext: { type: "company", companyIds: ["cmp_1"], companyNames: ["산청애펜션"], keyword: "경남펜션" } }),
    "keyword",
    "a regional rank keyword must not become a company-name search just because it belongs to a single-company review context"
  );
  assert.equal(
    classifier.correctedSearchMode("경남숙소", "company", { explicitCompanyTarget: true }),
    "keyword",
    "a boolean company shortcut without stable identity must not bypass broad-keyword correction"
  );
  assert.equal(
    JSON.stringify(classifier.companyCollectionTargetNames({ primaryName: "정식 업체명", aliases: ["경남숙소", " 경남숙소 ", "숙소"] })),
    JSON.stringify(["정식 업체명", "경남숙소", "숙소"]),
    "company recrawl targets must preserve normalized aliases without duplicates"
  );
}

async function verifyClientCollectionRangeHelpers() {
  const appPath = path.resolve(__dirname, "..", "web", "app.js");
  const source = await fsp.readFile(appPath, "utf8");
  const start = source.indexOf("function normalizedRankRangeText");
  const end = source.indexOf("function rankRangeCountFromText", start);
  assert.ok(start >= 0 && end > start, "client collection range helper block not found");
  const context = {};
  vm.runInNewContext(
    `const ADMIN_COLLECTION_RANK_SAFETY_MAX = 1000;\n${source.slice(start, end)}\nthis.__collectionRangeTest = { rankRangeEndFromText, canonicalCrawlFormRange };`,
    context,
    { filename: appPath }
  );
  const helper = context.__collectionRangeTest.rankRangeEndFromText;
  assert.equal(helper("1-40", "1-20"), 40, "basic end rank should stay 40");
  assert.equal(helper("1-20", "1-40"), 20, "detail end rank should stay 20");
  assert.equal(helper("", "1-40"), 40, "empty end rank should restore the purpose default");
  assert.equal(helper("invalid", "1-20"), 20, "invalid end rank should restore the purpose default");
  const canonical = context.__collectionRangeTest.canonicalCrawlFormRange;
  assert.equal(canonical("10-20", "revenue_detail"), "1-20", "detail recrawl ranges must start at rank 1");
  assert.equal(canonical("1-35", "revenue_detail"), "1-35", "detail range 20 must remain a convenience default, not a cap");
  assert.equal(canonical("1-75", "basic_db"), "1-75", "basic range 40 must remain a convenience default, not a cap");
  assert.equal(canonical("1-15", "basic_db"), "1-15", "basic custom ranges must remain editable");
}

async function verifyCrawlerBroadLodgingHelpers() {
  const crawlerPath = path.resolve(__dirname, "gyeongnam_glamping_crawl.cjs");
  const source = await fsp.readFile(crawlerPath, "utf8");
  const suffixStart = source.indexOf("function compactKeyword");
  const suffixEnd = source.indexOf("function uniqueNonEmpty", suffixStart);
  const typeStart = source.indexOf("function accommodationMarketType");
  const typeEnd = source.indexOf("function productTypeCluster", typeStart);
  assert.ok(suffixStart >= 0 && suffixEnd > suffixStart, "crawler lodging suffix helper block not found");
  assert.ok(typeStart >= 0 && typeEnd > typeStart, "crawler accommodation type helper block not found");
  const context = {};
  vm.runInNewContext(
    `${source.slice(suffixStart, suffixEnd)}\n${source.slice(typeStart, typeEnd)}\nthis.__crawlerBroadLodgingTest = { lodgingSearchSuffix, spacedLodgingKeyword, lodgingQueryPlan, lodgingCollectionPolicy, accommodationMarketType };`,
    context,
    { filename: crawlerPath }
  );
  const helpers = context.__crawlerBroadLodgingTest;
  assert.equal(helpers.lodgingSearchSuffix("경남 숙박"), "숙박", "숙박 must not fall back to 글램핑");
  assert.equal(helpers.lodgingSearchSuffix("경남 숙소"), "숙소", "숙소 suffix should remain supported");
  assert.equal(helpers.lodgingSearchSuffix("경남 카라반캠핑장"), "카라반캠핑장", "compound lodging suffixes must remain intact");
  assert.equal(helpers.spacedLodgingKeyword("경남숙박", "글램핑"), "경남 숙박", "the exact broad lodging query should be preserved");
  const broadPlan = helpers.lodgingQueryPlan("경남 숙소", "keyword", "");
  assert.equal(broadPlan.broad, true, "경남 숙소 must execute the crawler broad-lodging branch");
  assert.equal(broadPlan.preserveRaw, false, "a terminal broad suffix does not need the ordinary-keyword escape hatch");
  assert.equal(broadPlan.exactQuery, "경남 숙소", "경남 숙소 must remain the exact Naver query");
  assert.equal(broadPlan.searchIntent, "broad_lodging", "경남 숙소 crawler intent mismatch");
  assert.equal(broadPlan.searchScope, "all_lodging", "경남 숙소 crawler scope mismatch");
  assert.equal(broadPlan.searchScopeLabel, "전체 숙박", "경남 숙소 crawler label mismatch");
  assert.deepEqual(
    { ...helpers.lodgingCollectionPolicy(broadPlan, "fast", "revenue_detail", "1-60") },
    { collectionMode: "precision", collectionPurpose: "basic_db", detailRankRanges: "1-60" },
    "a direct broad-lodging crawler run must keep a manually selected range while using precision/basic"
  );

  const ordinaryPlan = helpers.lodgingQueryPlan("경남 숙소 추천", "keyword", "");
  assert.equal(ordinaryPlan.broad, false, "경남 숙소 추천 must remain an ordinary keyword");
  assert.equal(ordinaryPlan.preserveRaw, true, "embedded lodging words must preserve the raw keyword");
  assert.equal(ordinaryPlan.exactQuery, "경남 숙소 추천", "ordinary lodging phrases must not gain a 글램핑 fallback");
  assert.equal(ordinaryPlan.searchIntent, "keyword", "ordinary lodging phrase intent mismatch");
  assert.equal(ordinaryPlan.searchScope, "keyword", "ordinary lodging phrase scope mismatch");

  const companyPlan = helpers.lodgingQueryPlan("경남 숙소", "company", "");
  assert.equal(companyPlan.broad, false, "an explicit company target must not execute a broad crawl");
  assert.equal(companyPlan.searchIntent, "company", "crawler company intent mismatch");
  assert.equal(companyPlan.searchScope, "company", "crawler company scope mismatch");
  const missingRegionPlan = helpers.lodgingQueryPlan("숙소", "keyword", "", false);
  assert.equal(missingRegionPlan.missingRegion, true, "a direct crawler run must reject a broad term without a region");
  assert.equal(missingRegionPlan.searchIntent, "missing_region", "the direct crawler must expose the missing-region intent");
  for (const testCase of ACCOMMODATION_TYPE_CASES) {
    assert.equal(
      helpers.accommodationMarketType(testCase.row),
      testCase.expected,
      `accommodation type mismatch for ${JSON.stringify(testCase.row)}`
    );
  }
  assert.match(source, /const LODGING_QUERY_PLAN = lodgingQueryPlan\(RAW_KEYWORD, SEARCH_MODE, REQUESTED_SEARCH_SCOPE, directKnownRegion\)/u, "the executable query plan must drive the crawler run");
  assert.match(source, /if \(LODGING_QUERY_PLAN\.missingRegion\)\s*\{\s*throw new Error/u, "the direct crawler must stop before collecting a broad term without a region");
  assert.match(source, /const NAVER_QUERY = IS_BROAD_LODGING_SEARCH \|\| LODGING_QUERY_PLAN\.preserveRaw\s*\? EXACT_LODGING_QUERY/u, "broad and ordinary embedded-suffix searches must use the planned exact Naver query");
  assert.match(source, /searchScope: SEARCH_SCOPE/u, "the manifest must persist the broad lodging scope");
}

async function verifyServerRankComparisonHelpers() {
  const serverPath = path.resolve(__dirname, "glamping_app_server.cjs");
  const source = await fsp.readFile(serverPath, "utf8");
  const rangeStart = source.indexOf("function parseRankRanges(");
  const rangeEnd = source.indexOf("const REGIONAL_GLAMPING_BASES", rangeStart);
  const comparisonStart = source.indexOf("function placeRankComparisonScope(");
  const comparisonEnd = source.indexOf("async function placeRankComparisonForRun", comparisonStart);
  assert.ok(rangeStart >= 0 && rangeEnd > rangeStart, "server rank-range helper block not found");
  assert.ok(comparisonStart >= 0 && comparisonEnd > comparisonStart, "server rank-comparison helper block not found");

  const context = {
    compactKeyword: (value) => String(value || "").replace(/\s+/g, ""),
    normalizeSearchMode: (value) => (String(value || "").trim() === "company" ? "company" : "keyword"),
    extractNaverPlaceId: (item) => String(item?.placeId || ""),
    extractBookingBusinessId: (item) => String(item?.bookingBusinessId || "")
  };
  vm.runInNewContext(
    `const ADMIN_COLLECTION_RANK_SAFETY_MAX = 1000;\n${source.slice(rangeStart, rangeEnd)}\n${source.slice(comparisonStart, comparisonEnd)}\nthis.__rankComparisonTest = { placeRankComparisonScope, rankedPlaceRows, buildPlaceRankComparison };`,
    context,
    { filename: serverPath }
  );
  const helpers = context.__rankComparisonTest;
  const baseRun = { keyword: "경남 숙소", searchMode: "keyword", detailRankRanges: "1-40" };
  const firstScope = helpers.placeRankComparisonScope({ ...baseRun, naverKeyword: "경남 숙소" });
  const secondScope = helpers.placeRankComparisonScope({ ...baseRun, naverKeyword: "경상남도 숙소" });
  assert.notEqual(firstScope, secondScope, "rank history scope must include the actually observed Naver keyword");

  const currentData = {
    run: { ...baseRun, id: "current" },
    ranking: { items: [
      { sourceKey: "a", name: "A", overallRank: 1 },
      { sourceKey: "b", name: "B", overallRank: 40 },
      { sourceKey: "outside-current", name: "Outside current", overallRank: 41 }
    ] }
  };
  const previousData = {
    run: { ...baseRun, id: "previous" },
    ranking: { items: [
      { sourceKey: "a", name: "A", overallRank: 2 },
      { sourceKey: "b", name: "B", overallRank: 40 },
      { sourceKey: "outside-previous", name: "Outside previous", overallRank: 41 }
    ] }
  };
  assert.deepEqual(
    Array.from(helpers.rankedPlaceRows(currentData), (row) => row.rank),
    [1, 40],
    "rank comparison rows must exclude ranks outside the run's 1-40 collection scope"
  );
  const comparison = helpers.buildPlaceRankComparison(currentData, previousData, { id: "previous" });
  assert.equal(comparison.scope.currentCount, 2, "rank comparison current count must respect the stored range");
  assert.equal(comparison.scope.previousCount, 2, "rank comparison previous count must respect the stored range");
  assert.equal(comparison.stats.improved, 1, "in-range rank improvement should be detected");
  assert.equal(comparison.stats.unchanged, 1, "in-range unchanged rank should be detected");
  assert.equal(comparison.stats.newlyRanked, 0, "out-of-range current rows must not become new rankings");
  assert.equal(comparison.stats.droppedOut, 0, "out-of-range previous rows must not become drop-outs");
}

async function verifyServerClassifier() {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "search-mode-classification-"));
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(__dirname, "glamping_app_server.cjs")], {
    cwd: path.resolve(__dirname, ".."),
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      DATA_DIR: path.join(tmp, "data"),
      OUTPUTS_DIR: path.join(tmp, "outputs"),
      CONFIG_DIR: path.join(tmp, "config"),
      GLAMPING_ADMIN_USER: "admin",
      GLAMPING_ADMIN_PASSWORD: "0914",
      GLAMPING_B2B_USER: "b2b",
      GLAMPING_B2B_PASSWORD: "0914"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  try {
    await waitForServer(child);
    const baseUrl = `http://127.0.0.1:${port}`;
    const login = await request(baseUrl, "POST", "/api/login", { username: "admin", password: "0914" });
    assert.equal(login.statusCode, 200, "admin login should succeed");

    for (const testCase of CASES) {
      const estimate = await request(baseUrl, "POST", "/api/crawl-estimate", {
        keyword: testCase.keyword,
        searchMode: testCase.requested,
        collectionMode: "fast",
        collectionPurpose: "basic_db",
        detailRankRanges: "none"
      }, login.cookies);
      assert.equal(estimate.statusCode, 200, `estimate failed for ${testCase.keyword}`);
      assert.equal(estimate.body.searchMode, testCase.expected, `server mode mismatch for ${testCase.keyword}`);
      assert.equal(estimate.body.estimateBasis?.searchMode, testCase.expected, `server basis mismatch for ${testCase.keyword}`);
    }

    for (const testCase of BROAD_LODGING_INTENT_CASES.filter((row) => !row.needsRegion)) {
      const requestedRange = testCase.kind === "broad_lodging" ? "1-60" : "7-9";
      const estimate = await request(baseUrl, "POST", "/api/crawl-estimate", {
        keyword: testCase.keyword,
        searchMode: "keyword",
        collectionMode: "fast",
        collectionPurpose: "revenue_detail",
        detailRankRanges: requestedRange
      }, login.cookies);
      assert.equal(estimate.statusCode, 200, `broad lodging estimate failed for ${testCase.keyword}`);
      assert.equal(estimate.body.searchIntent, testCase.kind, `server intent mismatch for ${testCase.keyword}`);
      assert.equal(estimate.body.searchRegion, testCase.region, `server region mismatch for ${testCase.keyword}`);
      assert.equal(estimate.body.searchScope, testCase.scope, `server scope mismatch for ${testCase.keyword}`);
      if (testCase.kind === "broad_lodging") {
        assert.equal(estimate.body.collectionMode, "precision", `${testCase.keyword} must override a fast API request`);
        assert.equal(estimate.body.collectionPurpose, "basic_db", `${testCase.keyword} should use basic information collection`);
        assert.equal(estimate.body.detailRankRanges, "1-60", `${testCase.keyword} must preserve a custom administrator range`);
        assert.equal(estimate.body.bookingStockPlaceLimit, 60, `${testCase.keyword} should inspect the selected basic-information range`);
        assert.equal(estimate.body.bookingRangePlaceLimit, 0, `${testCase.keyword} should not collect mixed-type sales rates`);
      }
    }

    const broadDefault = await request(baseUrl, "POST", "/api/crawl-estimate", {
      keyword: "경남 숙소",
      searchMode: "keyword",
      collectionMode: "precision",
      collectionPurpose: "basic_db"
    }, login.cookies);
    assert.equal(broadDefault.statusCode, 200, "broad lodging default estimate should succeed");
    assert.equal(broadDefault.body.detailRankRanges, "1-40", "broad lodging should still start from the basic-information convenience default");
    assert.equal(broadDefault.body.bookingStockPlaceLimit, 40, "the basic-information convenience default should still inspect 40 places");

    for (const region of ADDITIONAL_SUPPORTED_REGIONS) {
      const estimate = await request(baseUrl, "POST", "/api/crawl-estimate", {
        keyword: `${region} 숙소`,
        searchMode: "keyword",
        collectionMode: "fast",
        collectionPurpose: "revenue_detail",
        detailRankRanges: "1-3"
      }, login.cookies);
      assert.equal(estimate.statusCode, 200, `${region} 숙소 should be supported by the server`);
      assert.equal(estimate.body.searchIntent, "broad_lodging", `${region} 숙소 intent mismatch`);
      assert.equal(estimate.body.searchRegion, region, `${region} 숙소 region mismatch`);
      assert.equal(estimate.body.collectionMode, "precision", `${region} 숙소 must use precision collection`);
      assert.equal(estimate.body.collectionPurpose, "basic_db", `${region} 숙소 must use basic collection`);
      assert.equal(estimate.body.detailRankRanges, "1-3", `${region} 숙소 must preserve the manually selected range`);
    }

    for (const keyword of ["숙박", "숙소"]) {
      for (const searchMode of ["keyword", "company"]) {
        const invalid = await request(baseUrl, "POST", "/api/crawl-estimate", {
          keyword,
          searchMode,
          collectionMode: "precision",
          collectionPurpose: "basic_db"
        }, login.cookies);
        assert.equal(invalid.statusCode, 400, `${keyword} without a region must be rejected in ${searchMode} mode`);
        assert.match(invalid.body.error || "", /지역명을 함께 입력/u, `${keyword} should explain the missing region`);
      }

      const staleContext = await request(baseUrl, "POST", "/api/crawl-estimate", {
        keyword,
        searchMode: "company",
        collectionMode: "precision",
        collectionPurpose: "revenue_detail",
        recrawlContext: { type: "company", companyIds: ["cmp_stale"], companyNames: ["다른업체"], keyword: "다른업체" }
      }, login.cookies);
      assert.equal(staleContext.statusCode, 400, `${keyword} must reject a mismatched company recrawl context`);

      const booleanShortcut = await request(baseUrl, "POST", "/api/crawl-estimate", {
        keyword,
        searchMode: "company",
        collectionMode: "precision",
        collectionPurpose: "revenue_detail",
        explicitCompanyTarget: true
      }, login.cookies);
      assert.equal(booleanShortcut.statusCode, 400, `${keyword} must reject a company shortcut without stable identity`);

      const nameOnlyContext = await request(baseUrl, "POST", "/api/crawl-estimate", {
        keyword,
        searchMode: "company",
        collectionMode: "precision",
        collectionPurpose: "revenue_detail",
        recrawlContext: { type: "company", companyNames: [keyword], keyword }
      }, login.cookies);
      assert.equal(nameOnlyContext.statusCode, 400, `${keyword} must reject a name-only company context without a stable ID`);
    }

    const bareCompany = await request(baseUrl, "POST", "/api/crawl-estimate", {
      keyword: "숙소",
      searchMode: "company",
      collectionMode: "precision",
      collectionPurpose: "revenue_detail",
      recrawlContext: { type: "company", companyIds: ["cmp_lodging"], companyNames: ["숙소"], keyword: "숙소" }
    }, login.cookies);
    assert.equal(bareCompany.statusCode, 200, "a real matching company recrawl context should allow a bare company name");
    assert.equal(bareCompany.body.searchMode, "company", "bare matching company target should keep company mode");
    assert.equal(bareCompany.body.searchIntent, "company", "bare matching company target should expose company intent");
    assert.equal(bareCompany.body.searchScope, "company", "bare matching company target should expose company scope");
    assert.equal(bareCompany.body.searchScopeLabel, "업체 1곳", "bare matching company target should expose the company label");

    const explicitCompany = await request(baseUrl, "POST", "/api/crawl-estimate", {
      keyword: "경남숙소",
      searchMode: "company",
      collectionMode: "precision",
      collectionPurpose: "revenue_detail",
      recrawlContext: { type: "company", companyIds: ["cmp_1"], companyNames: ["경남숙소"], keyword: "경남숙소" }
    }, login.cookies);
    assert.equal(explicitCompany.statusCode, 200, "explicit company escape hatch estimate should succeed");
    assert.equal(explicitCompany.body.searchMode, "company", "explicit company target should keep company mode");
    assert.equal(explicitCompany.body.searchIntent, "company", "explicit company target should expose company intent");
    assert.equal(explicitCompany.body.searchRegion, "", "explicit company target should not expose a regional scope");
    assert.equal(explicitCompany.body.searchScope, "company", "explicit company target should expose company scope");
    assert.equal(explicitCompany.body.searchScopeLabel, "업체 1곳", "explicit company target should expose the company label");
    assert.equal(explicitCompany.body.collectionPurpose, "revenue_detail", "explicit company target should keep its detail purpose");

    const regionalCompanyReview = await request(baseUrl, "POST", "/api/crawl-estimate", {
      keyword: "경남펜션",
      searchMode: "keyword",
      collectionMode: "precision",
      collectionPurpose: "revenue_detail",
      recrawlContext: { type: "company", companyIds: ["cmp_2"], companyNames: ["산청애펜션"], keyword: "경남펜션" }
    }, login.cookies);
    assert.equal(regionalCompanyReview.statusCode, 200, "a regional single-company review estimate should succeed");
    assert.equal(regionalCompanyReview.body.searchMode, "keyword", "a regional rank keyword must remain keyword mode");
    assert.equal(regionalCompanyReview.body.searchIntent, "typed_lodging", "a regional rank keyword must retain its typed-lodging intent");
    assert.equal(regionalCompanyReview.body.searchScope, "lodging_type:펜션", "a regional rank keyword must retain its lodging-type scope");

    for (const testCase of COLLECTION_RANGE_CASES) {
      const estimate = await request(baseUrl, "POST", "/api/crawl-estimate", testCase.payload, login.cookies);
      assert.equal(estimate.statusCode, 200, `estimate failed for ${testCase.label}`);
      assert.equal(estimate.body.productMode, "all", `${testCase.label} should collect all products`);
      assert.equal(estimate.body.detailRankRanges, testCase.expectedRange, `${testCase.label} range mismatch`);
      assert.equal(estimate.body.bookingStockPlaceLimit, testCase.expectedStockLimit, `${testCase.label} stock limit mismatch`);
      assert.equal(estimate.body.bookingRangePlaceLimit, testCase.expectedWeeklyLimit, `${testCase.label} weekly limit mismatch`);
      assert.equal(estimate.body.estimateBasis?.bookingStockPlaceLimit, testCase.expectedStockLimit, `${testCase.label} basis stock limit mismatch`);
    }

    const b2bLogin = await request(baseUrl, "POST", "/api/login", { username: "b2b", password: "0914" });
    assert.equal(b2bLogin.statusCode, 200, "B2B login should succeed");
    const oversizedB2BEstimate = await request(baseUrl, "POST", "/api/crawl-estimate", {
      keyword: "경남펜션",
      collectionMode: "precision",
      detailRankRanges: "1-100",
      bookingRangePlaceLimit: 100
    }, b2bLogin.cookies);
    assert.equal(oversizedB2BEstimate.statusCode, 403, "B2B expanded accounts must not inherit the administrator's editable range");
    assert.match(oversizedB2BEstimate.body.error || "", /1~20위/u, "B2B range rejection should explain the expanded-account limit");

    const allowedB2BEstimate = await request(baseUrl, "POST", "/api/crawl-estimate", {
      keyword: "경남펜션",
      collectionMode: "precision",
      detailRankRanges: "1-20",
      bookingRangePlaceLimit: 20
    }, b2bLogin.cookies);
    assert.equal(allowedB2BEstimate.statusCode, 200, "B2B expanded accounts should keep their existing 1-20 range");
    assert.equal(allowedB2BEstimate.body.detailRankRanges, "1-20", "B2B estimate must keep the allowed range");
    assert.equal(allowedB2BEstimate.body.bookingStockPlaceLimit, 20, "B2B estimate must cap stock checks to the allowed range");

    const defaultB2BEstimate = await request(baseUrl, "POST", "/api/crawl-estimate", {
      keyword: "경남펜션",
      collectionMode: "precision",
      detailRankRanges: "1-10",
      bookingRangePlaceLimit: 10
    }, b2bLogin.cookies);
    assert.equal(defaultB2BEstimate.statusCode, 200, "B2B expanded accounts must retain the existing 1-10 option");
    assert.equal(defaultB2BEstimate.body.detailRankRanges, "1-10", "B2B default estimate must keep the selected 1-10 range");
    assert.equal(defaultB2BEstimate.body.bookingStockPlaceLimit, 10, "B2B default estimate must keep the selected 10-place limit");
  } finally {
    await stopChild(child);
    await fsp.rm(tmp, { recursive: true, force: true });
  }
}

async function main() {
  await verifyClientClassifier();
  await verifyClientCollectionRangeHelpers();
  await verifyCrawlerBroadLodgingHelpers();
  await verifyServerRankComparisonHelpers();
  await verifyServerClassifier();
  console.log("Search mode classification tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
