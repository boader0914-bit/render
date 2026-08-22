"use strict";

const assert = require("node:assert/strict");
const fsp = require("node:fs/promises");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

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
        resolve({
          statusCode: res.statusCode,
          cookies: (res.headers["set-cookie"] || []).map((value) => value.split(";")[0]),
          body: parsed
        });
      });
    });
    req.once("error", reject);
    req.setTimeout(15000, () => req.destroy(new Error(`request timeout: ${method} ${pathname}`)));
    if (payload) req.write(payload);
    req.end();
  });
}

async function waitForServer(child) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("server start timeout")), 20000);
    const onData = (chunk) => {
      if (!String(chunk || "").includes("Lodging datalab beta app running")) return;
      clearTimeout(timer);
      resolve();
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited before ready: ${code}`));
    });
  });
}

async function stopChild(child) {
  if (!child || child.exitCode !== null) return;
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 5000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill();
  });
}

async function readTextIfExists(filePath) {
  try {
    return await fsp.readFile(filePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return "";
    throw error;
  }
}

function csvCell(value) {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

async function writeRun(outputsDir, config) {
  const runDir = path.join(outputsDir, config.runId);
  const overallFile = `${config.runId}_overall_place_rank.csv`;
  const platformFile = `${config.runId}_glamping_crawl_test.csv`;
  const placeId = String(config.placeId || "987654321");
  const companyName = config.companyName || "채널 관측 테스트 펜션";
  const address = config.address || "경남 산청군 테스트로 1";
  const category = config.category || "펜션";
  const lodgingType = config.lodgingType || "펜션";
  const placeUrl = `https://pcmap.place.naver.com/accommodation/${placeId}`;
  await fsp.mkdir(runDir, { recursive: true });
  const channels = config.channels || [];
  const headers = [
    "query",
    "overall_rank",
    "place_id",
    "업체명",
    "카테고리",
    "숙박유형클러스터",
    "주소",
    "예약",
    "url",
    "네이버OTA관측상태",
    "네이버OTA관측라벨",
    "네이버OTA관측시각",
    "네이버OTA근거URL",
    "네이버OTA관측방식",
    "네이버OTA관측메모",
    "네이버OTA노출JSON",
    "네이버예약노출상태",
    "네이버페이노출",
    "네이버예약대행사명",
    "네이버예약대행사ID",
    "네이버예약운영신호"
  ];
  const values = [
    config.keyword || "테스트펜션",
    String(config.rank || 1),
    placeId,
    companyName,
    category,
    lodgingType,
    address,
    "N",
    placeUrl,
    config.status,
    config.statusLabel,
    config.observedAt,
    `${placeUrl}/room`,
    config.method || "graphql",
    config.note || "네이버 공개 예약 정보 관측",
    JSON.stringify(channels),
    "미노출",
    "N",
    config.agencyName || "",
    config.agencyId || "",
    config.operationSignal || "네이버 예약 운영 신호 미확인"
  ];
  for (const [key, value] of Object.entries(config.inventory || {})) {
    headers.push(key);
    values.push(value && typeof value === "object" ? JSON.stringify(value) : value);
  }
  await fsp.writeFile(path.join(runDir, overallFile), `${headers.map(csvCell).join(",")}\n${values.map(csvCell).join(",")}\n`, "utf8");
  await fsp.writeFile(
    path.join(runDir, platformFile),
    `channel,name,price,url\n${["네이버", companyName, "", placeUrl].map(csvCell).join(",")}\n`,
    "utf8"
  );
  await fsp.writeFile(path.join(runDir, "manifest.json"), JSON.stringify({
    keyword: config.keyword || "테스트펜션",
    searchMode: "keyword",
    searchIntent: config.searchIntent || "typed_lodging",
    searchRegion: config.searchRegion || "경남",
    searchScope: config.searchScope || "lodging_type:펜션",
    searchScopeLabel: config.searchScopeLabel || "펜션",
    collectionMode: "precision",
    collectionPurpose: config.collectionPurpose || "basic_db",
    collectionPurposeLabel: config.collectionPurposeLabel || "기본 DB 수집",
    collectionProfile: config.collectionProfile || "basic_db_light",
    collectionProfileLabel: config.collectionProfileLabel || "기본 DB 중심",
    detailRankRanges: "1-40",
    checkIn: config.checkIn || "2026-08-22",
    checkOut: config.checkOut || "2026-08-23",
    bookingRangeDays: config.bookingRangeDays || 1,
    ...(config.omitCollectionTimestamp ? {} : { completedAt: config.completedAt || config.observedAt || "" }),
    adults: 2,
    fileRoles: { overall: overallFile, platform: platformFile },
    files: [overallFile, platformFile],
    counts: { naverOverall: 1 }
  }, null, 2), "utf8");
}

async function main() {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "naver-ota-company-master-"));
  const dataDir = path.join(tmp, "data");
  const outputsDir = path.join(dataDir, "outputs");
  const observedAt = "2026-08-22T01:00:00.000Z";
  const firstRunId = "naver_ota_observed_test";
  const secondRunId = "naver_ota_not_observed_test";
  const thirdRunId = "naver_ota_observed_after_manual_test";
  const invalidRunId = "naver_ota_invalid_claim_test";
  const olderSortRunId = "sort_old_glamping_20260820_010000";
  const newerSortRunId = "sort_new_glamping_20260821_010000";
  const checkInDateRunId = "checkin_date_snapshot_20301224_120000";
  const homonymTargetRunId = "yeogi_homonym_target_test";
  const homonymOtherRunId = "yeogi_homonym_other_test";
  const manualProtectedRunId = "yeogi_manual_protected_test";
  const broadLodgingRunId = "broad_all_lodging_test";
  const broadOutOfRangeRunId = "broad_all_lodging_out_of_range_test";
  const detailFirstRunId = "company_detail_snapshot_first_test";
  const detailSecondRunId = "company_detail_snapshot_second_test";
  const detailSparseRunId = "company_detail_snapshot_sparse_test";
  await writeRun(outputsDir, {
    runId: firstRunId,
    status: "observed_on_naver",
    statusLabel: "네이버 화면 외부 예약 채널 노출 확인",
    observedAt,
    agencyName: "예약 운영 파트너",
    operationSignal: "예약 운영 파트너 관측 · 외부 OTA 입점 확정 아님",
    channels: [
      {
        channel: "yanolja",
        label: "야놀자/NOL",
        status: "observed_on_naver",
        url: "https://nol.yanolja.com/stay/domestic/12345",
        evidenceUrl: "https://pcmap.place.naver.com/accommodation/987654321/room",
        source: "naver_place",
        method: "graphql_resrv_url",
        checkedAt: observedAt,
        confidence: 0.98,
        note: "네이버 공개 예약 URL에서 확인"
      },
      {
        channel: "yeogi",
        status: "observed_on_naver",
        url: "https://nol.yanolja.com/stay/domestic/99999",
        source: "naver_place",
        checkedAt: observedAt
      }
    ]
  });
  await writeRun(outputsDir, {
    runId: secondRunId,
    status: "not_observed_on_naver",
    statusLabel: "네이버에서 외부 OTA 노출 미확인",
    observedAt: "2026-08-22T02:00:00.000Z",
    channels: []
  });
  await writeRun(outputsDir, {
    runId: broadOutOfRangeRunId,
    placeId: "800000005",
    companyName: "전체 숙박 범위 밖 호텔 테스트",
    category: "호텔",
    lodgingType: "호텔·리조트",
    rank: 41,
    keyword: "경남 숙소",
    searchIntent: "broad_lodging",
    searchRegion: "경남",
    searchScope: "all_lodging",
    searchScopeLabel: "전체 숙박",
    completedAt: "2026-08-17T05:30:00.000Z",
    status: "not_collected",
    statusLabel: "네이버 OTA 관측 미수집",
    observedAt: "2026-08-17T05:30:00.000Z",
    channels: []
  });
  await writeRun(outputsDir, {
    runId: thirdRunId,
    status: "observed_on_naver",
    statusLabel: "네이버 화면 외부 예약 채널 노출 확인",
    observedAt: "2026-08-22T03:00:00.000Z",
    channels: [{
      channel: "yanolja",
      status: "observed_on_naver",
      url: "https://nol.yanolja.com/stay/domestic/12345",
      source: "naver_place",
      checkedAt: "2026-08-22T03:00:00.000Z"
    }]
  });
  await writeRun(outputsDir, {
    runId: olderSortRunId,
    placeId: "700000001",
    companyName: "정렬 이전 회차 펜션",
    status: "not_observed_on_naver",
    statusLabel: "네이버에서 외부 OTA 노출 미확인",
    observedAt: "2026-08-20T01:00:00.000Z",
    channels: []
  });
  await writeRun(outputsDir, {
    runId: newerSortRunId,
    placeId: "700000002",
    companyName: "정렬 최신 회차 펜션",
    status: "not_observed_on_naver",
    statusLabel: "네이버에서 외부 OTA 노출 미확인",
    observedAt: "2026-08-21T01:00:00.000Z",
    channels: []
  });
  await writeRun(outputsDir, {
    runId: checkInDateRunId,
    placeId: "700000003",
    companyName: "체크인 날짜 구분 펜션",
    checkIn: "2030-12-24",
    checkOut: "2030-12-25",
    omitCollectionTimestamp: true,
    status: "not_observed_on_naver",
    statusLabel: "네이버에서 외부 OTA 노출 미확인",
    observedAt: "2026-08-19T04:59:00.000Z",
    channels: []
  });
  const futureMtime = new Date("2030-01-01T00:00:00.000Z");
  await fsp.utimes(path.join(outputsDir, olderSortRunId), futureMtime, futureMtime);
  await writeRun(outputsDir, {
    runId: invalidRunId,
    placeId: "111222333",
    companyName: "잘못된 채널 주장 테스트 펜션",
    status: "observed_on_naver",
    statusLabel: "네이버 화면 외부 예약 채널 노출 확인",
    observedAt: "2026-08-22T04:00:00.000Z",
    channels: [{
      channel: "yeogi",
      status: "observed_on_naver",
      url: "https://nol.yanolja.com/stay/domestic/99999",
      source: "naver_place",
      checkedAt: "2026-08-22T04:00:00.000Z"
    }]
  });
  await writeRun(outputsDir, {
    runId: homonymTargetRunId,
    placeId: "800000001",
    companyName: "동명이름 펜션",
    address: "경남 산청군 안전로 10",
    completedAt: "2026-08-22T05:00:00.000Z",
    status: "not_observed_on_naver",
    statusLabel: "네이버에서 외부 OTA 노출 미확인",
    observedAt: "2026-08-22T05:00:00.000Z",
    channels: []
  });
  await writeRun(outputsDir, {
    runId: homonymOtherRunId,
    placeId: "800000002",
    companyName: "동명이름 펜션",
    address: "경남 통영시 안전로 20",
    completedAt: "2026-08-22T05:10:00.000Z",
    status: "not_observed_on_naver",
    statusLabel: "네이버에서 외부 OTA 노출 미확인",
    observedAt: "2026-08-22T05:10:00.000Z",
    channels: []
  });
  await writeRun(outputsDir, {
    runId: manualProtectedRunId,
    placeId: "800000003",
    companyName: "관리자 보호 펜션",
    address: "경남 산청군 보호로 30",
    completedAt: "2026-08-22T05:20:00.000Z",
    status: "not_observed_on_naver",
    statusLabel: "네이버에서 외부 OTA 노출 미확인",
    observedAt: "2026-08-22T05:20:00.000Z",
    channels: []
  });
  await writeRun(outputsDir, {
    runId: broadLodgingRunId,
    placeId: "800000004",
    companyName: "전체 숙박 호텔 테스트",
    category: "호텔",
    lodgingType: "호텔·리조트",
    keyword: "경남 숙소",
    searchIntent: "broad_lodging",
    searchRegion: "경남",
    searchScope: "all_lodging",
    searchScopeLabel: "전체 숙박",
    completedAt: "2026-08-18T05:30:00.000Z",
    status: "not_collected",
    statusLabel: "네이버 OTA 관측 미수집",
    observedAt: "2026-08-18T05:30:00.000Z",
    channels: []
  });
  const detailProducts = (secondObservation = false) => [
    {
      date: "2026-08-29",
      bizItemId: "room-a",
      name: "올데이 풀빌라",
      saleType: "숙박",
      listType: "객실 종류별 리스트",
      availabilityUnit: "객실",
      total: 2,
      available: secondObservation ? 1 : 2,
      price: 100000
    },
    {
      date: "2026-08-29",
      bizItemId: "room-b",
      name: "포레스트 B",
      saleType: "숙박",
      listType: "객실 종류별 리스트",
      availabilityUnit: "객실",
      total: 3,
      available: 2,
      price: 100000
    },
    {
      date: "2026-08-30",
      bizItemId: "room-a",
      name: "올데이 풀빌라",
      saleType: "숙박",
      listType: "객실 종류별 리스트",
      availabilityUnit: "객실",
      total: 2,
      available: secondObservation ? 0 : 1,
      price: 100000
    },
    {
      date: "2026-08-30",
      bizItemId: "room-b",
      name: "포레스트 B",
      saleType: "숙박",
      listType: "객실 종류별 리스트",
      availabilityUnit: "객실",
      total: 3,
      available: secondObservation ? 1 : 2,
      price: 100000
    }
  ];
  const detailInventory = (secondObservation = false) => ({
    숙박예약가능수: secondObservation ? 3 : 4,
    숙박확인재고수: 5,
    주간재고수집일수: 2,
    주간잔여상세: secondObservation ? "08/29 3/5, 08/30 1/5" : "08/29 4/5, 08/30 3/5",
    주간평균예약률: secondObservation ? 0.6 : 0.3,
    주간예약률상세: secondObservation ? "08/29 40%(2/5), 08/30 80%(4/5)" : "08/29 20%(1/5), 08/30 40%(2/5)",
    주간판매수량합계: secondObservation ? 6 : 3,
    주간전체수량합계: 10,
    주간기준재고수: 5,
    주간운영판매기준수: 5,
    주간숙박예상매출: secondObservation ? 600000 : 300000,
    weeklyAdjustedRevenue: secondObservation ? 600000 : 300000,
    weeklyRevenuePrecisionRate: 1,
    주간숙박가격확인판매수량: secondObservation ? 6 : 3,
    주간숙박가격누락판매수량: 0,
    주간숙박평균판매단가: 100000,
    주간숙박매출상세: secondObservation
      ? "08/29 200,000원(2개), 08/30 400,000원(4개)"
      : "08/29 100,000원(1개), 08/30 200,000원(2개)",
    예약최저가: 100000,
    예약리스트유형: "객실 종류별 리스트",
    네이버예약재고수집상태: "수집 완료",
    네이버요일별상품상세JSON: detailProducts(secondObservation)
  });
  await writeRun(outputsDir, {
    runId: detailFirstRunId,
    placeId: "900000001",
    companyName: "상세 스냅샷 테스트 글램핑",
    category: "글램핑",
    lodgingType: "글램핑",
    keyword: "경남글램핑",
    searchIntent: "regional_lodging",
    searchRegion: "경남",
    searchScope: "lodging_type:글램핑",
    searchScopeLabel: "글램핑",
    rank: 8,
    checkIn: "2026-08-29",
    checkOut: "2026-08-31",
    bookingRangeDays: 2,
    completedAt: "2026-08-20T01:00:00.000Z",
    observedAt: "2026-08-20T01:00:00.000Z",
    collectionPurpose: "revenue_detail",
    collectionPurposeLabel: "상세 정보 수집",
    collectionProfile: "revenue_detail_deep",
    collectionProfileLabel: "상세 정보 중심",
    status: "not_observed_on_naver",
    statusLabel: "네이버에서 외부 OTA 노출 미확인",
    channels: [],
    inventory: detailInventory(false)
  });
  await writeRun(outputsDir, {
    runId: detailSecondRunId,
    placeId: "900000001",
    companyName: "상세 스냅샷 테스트 글램핑",
    category: "글램핑",
    lodgingType: "글램핑",
    keyword: "경남글램핑",
    searchIntent: "regional_lodging",
    searchRegion: "경남",
    searchScope: "lodging_type:글램핑",
    searchScopeLabel: "글램핑",
    rank: 5,
    checkIn: "2026-08-29",
    checkOut: "2026-08-31",
    bookingRangeDays: 2,
    completedAt: "2026-08-22T01:00:00.000Z",
    observedAt: "2026-08-22T01:00:00.000Z",
    collectionPurpose: "revenue_detail",
    collectionPurposeLabel: "상세 정보 수집",
    collectionProfile: "revenue_detail_deep",
    collectionProfileLabel: "상세 정보 중심",
    status: "not_observed_on_naver",
    statusLabel: "네이버에서 외부 OTA 노출 미확인",
    channels: [],
    inventory: detailInventory(true)
  });
  const sparseDetailInventory = detailInventory(true);
  delete sparseDetailInventory.네이버요일별상품상세JSON;
  await writeRun(outputsDir, {
    runId: detailSparseRunId,
    placeId: "900000001",
    companyName: "상세 스냅샷 테스트 글램핑",
    category: "글램핑",
    lodgingType: "글램핑",
    keyword: "경남글램핑",
    searchIntent: "regional_lodging",
    searchRegion: "경남",
    searchScope: "lodging_type:글램핑",
    searchScopeLabel: "글램핑",
    rank: 4,
    checkIn: "2026-08-29",
    checkOut: "2026-08-31",
    bookingRangeDays: 2,
    completedAt: "2026-08-22T03:00:00.000Z",
    observedAt: "2026-08-22T03:00:00.000Z",
    collectionPurpose: "revenue_detail",
    collectionPurposeLabel: "상세 정보 수집",
    collectionProfile: "revenue_detail_deep",
    collectionProfileLabel: "상세 정보 중심",
    status: "not_observed_on_naver",
    statusLabel: "네이버에서 외부 OTA 노출 미확인",
    channels: [],
    inventory: sparseDetailInventory
  });

  const port = await freePort();
  const child = spawn(process.execPath, [path.join(__dirname, "glamping_app_server.cjs")], {
    cwd: path.resolve(__dirname, ".."),
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      DATA_DIR: dataDir,
      OUTPUTS_DIR: outputsDir,
      CONFIG_DIR: path.join(dataDir, "config"),
      SEED_OUTPUTS_FROM_REPO: "0",
      GLAMPING_ADMIN_USER: "admin",
      GLAMPING_ADMIN_PASSWORD: "0914"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  try {
    await waitForServer(child);
    const baseUrl = `http://127.0.0.1:${port}`;
    const login = await request(baseUrl, "POST", "/api/login", { username: "admin", password: "0914" });
    assert.equal(login.statusCode, 200);
    const cookies = login.cookies;

    const listedRuns = await request(baseUrl, "GET", "/api/runs", null, cookies);
    assert.equal(listedRuns.statusCode, 200);
    assert.deepEqual(
      listedRuns.body.runs.slice(0, 2).map((run) => run.id),
      [newerSortRunId, olderSortRunId],
      "run list must use collection time instead of mutable directory mtime"
    );
    const listedOlderRun = listedRuns.body.runs.find((run) => run.id === olderSortRunId);
    const olderRun = await request(baseUrl, "GET", `/api/runs/${olderSortRunId}`, null, cookies);
    assert.equal(olderRun.statusCode, 200);
    assert.equal(
      olderRun.body.run.collectedAt,
      listedOlderRun.collectedAt,
      "run detail must use the same stable collection time as the run list"
    );
    const checkInDateRun = await request(baseUrl, "GET", `/api/runs/${checkInDateRunId}`, null, cookies);
    assert.equal(checkInDateRun.statusCode, 200);
    assert.equal(checkInDateRun.body.run.checkIn, "2030-12-24");
    assert.ok(
      Math.abs(Date.parse(checkInDateRun.body.run.collectedAt) - Date.now()) < 60_000,
      `check-in date embedded in a run id must not become collection time: ${checkInDateRun.body.run.collectedAt}`
    );
    const legacyFallbackCollectedAt = checkInDateRun.body.run.collectedAt;
    const checkInDateSupplement = await request(baseUrl, "POST", "/api/yeogi-import", {
      runId: checkInDateRunId,
      sourceText: [
        "rank,name,price,location,reservation_available,url,raw",
        "1,체크인 날짜 구분 펜션,100000원,산청군,Y,https://www.yeogi.com/domestic-accommodations/70003,직접 확인"
      ].join("\n")
    }, cookies);
    assert.equal(checkInDateSupplement.statusCode, 200);
    assert.equal(
      checkInDateSupplement.body.data.run.collectedAt,
      legacyFallbackCollectedAt,
      "supplement must persist and reuse a legacy run's fallback collection time"
    );

    const firstRun = await request(baseUrl, "GET", `/api/runs/${firstRunId}`, null, cookies);
    assert.equal(firstRun.statusCode, 200);
    assert.equal(firstRun.body.run.collectedAt, observedAt);
    assert.equal(firstRun.body.companyMaster.currentRunCompanies, 1, "ranking-only company should be saved");
    assert.equal(firstRun.body.ranking?.items?.[0]?.naverOtaExposures?.length, 2, `run exposure parse failed: ${JSON.stringify(firstRun.body.ranking?.items?.[0] || {})}`);
    assert.deepEqual(firstRun.body.ranking?.items?.[0]?.naverChannelObservation?.externalChannels, ["yanolja"]);

    const broadLodgingRun = await request(baseUrl, "GET", `/api/runs/${broadLodgingRunId}`, null, cookies);
    assert.equal(broadLodgingRun.statusCode, 200);
    assert.equal(broadLodgingRun.body.run.searchScope, "all_lodging");
    assert.equal(broadLodgingRun.body.companyMaster.currentRunCompanies, 1, "all-lodging ranking rows must be saved without inventory or OTA evidence");
    const broadOutOfRangeRun = await request(baseUrl, "GET", `/api/runs/${broadOutOfRangeRunId}`, null, cookies);
    assert.equal(broadOutOfRangeRun.statusCode, 200);
    assert.equal(broadOutOfRangeRun.body.companyMaster.currentRunCompanies, 0, "rank 41 must not enter a 1-40 company-master snapshot");

    const detailFirstRun = await request(baseUrl, "GET", `/api/runs/${detailFirstRunId}`, null, cookies);
    const detailSecondRun = await request(baseUrl, "GET", `/api/runs/${detailSecondRunId}`, null, cookies);
    assert.equal(detailFirstRun.statusCode, 200);
    assert.equal(detailSecondRun.statusCode, 200);
    assert.equal(detailFirstRun.body.companyMaster.historyEligible, true);
    assert.equal(detailSecondRun.body.companyMaster.historyEligible, true);

    let summary = await request(baseUrl, "GET", "/api/company-master/summary", null, cookies);
    assert.equal(summary.statusCode, 200);
    const detailCompany = summary.body.companies.find((row) => row.placeIds?.includes("900000001"));
    assert.ok(detailCompany, "detailed collection company must be stored");
    assert.equal(detailCompany.inventory?.latest?.productSnapshot?.summary?.productCount, 2);
    assert.equal(detailCompany.inventory?.latest?.productSnapshot?.products, undefined, "company list must not duplicate product payloads");
    assert.equal(detailCompany.inventory?.snapshots?.[0]?.productSnapshot?.products, undefined, "company list history must stay compact");
    assert.equal(detailCompany.keywords?.[0]?.recentRuns?.length, 2, "summary must expose recent keyword observations");

    const missingCompanyId = await request(baseUrl, "GET", "/api/company-master/detail", null, cookies);
    assert.equal(missingCompanyId.statusCode, 400);
    const companyDetail = await request(
      baseUrl,
      "GET",
      `/api/company-master/detail?companyId=${encodeURIComponent(detailCompany.companyId)}`,
      null,
      cookies
    );
    assert.equal(companyDetail.statusCode, 200);
    assert.equal(companyDetail.body.company.companyId, detailCompany.companyId);
    assert.equal(companyDetail.body.products.length, 2, "product identities must remain distinct even when prices are equal");
    assert.ok(companyDetail.body.products.every((row) => row.productType === "lodging"), "explicit lodging type must win even when a product name contains day text");
    assert.equal(companyDetail.body.priceGroups.length, 1, "same date-price pattern should form one presentation group");
    assert.deepEqual(
      companyDetail.body.daily.filter((row) => row.productType === "lodging").map((row) => [row.date, row.estimatedRevenue]),
      [["2026-08-29", 200000], ["2026-08-30", 400000]]
    );
    assert.ok(companyDetail.body.daily.every((row) => row.actualRevenue === null && row.revenueType === "estimated"));
    assert.deepEqual(companyDetail.body.rankTrend.points.map((row) => row.rank), [8, 5]);
    assert.equal(companyDetail.body.rankTrend.points.at(-1).delta, 3);
    assert.equal(companyDetail.body.rankTrend.points.at(-1).regionalMedianRank, 5);
    const availableRankKeyword = companyDetail.body.rankTrend.availableKeywords.find((row) => row.keyword === "경남글램핑");
    assert.ok(availableRankKeyword, "rank trend must expose every stored keyword as an available scope");
    assert.equal(availableRankKeyword.latestRank, 5, "available keyword must expose the latest stored rank without synthesis");
    assert.equal(availableRankKeyword.previousRank, 8, "available keyword must expose the previous stored rank without synthesis");
    assert.equal(availableRankKeyword.latestRunId, detailSecondRunId);
    assert.equal(availableRankKeyword.latestCollectedAt, "2026-08-22T01:00:00.000Z");
    assert.equal(availableRankKeyword.searchRegion, "경남");
    assert.equal(availableRankKeyword.searchScope, "lodging_type:글램핑");
    assert.equal(availableRankKeyword.searchScopeLabel, "글램핑");
    assert.equal(availableRankKeyword.detailRankRanges, "1-40", "rank position bars must use the stored run range rather than a UI hard cap");
    assert.equal(companyDetail.body.performanceTrend.points.length, 2);
    assert.equal(companyDetail.body.performanceTrend.points.at(-1).estimatedRevenue, 600000);
    assert.equal(companyDetail.body.performanceTrend.points.at(-1).actualRevenue, null);
    assert.equal(companyDetail.body.leadTime.status, "ready");
    assert.equal(companyDetail.body.leadTime.pickupCount, 3);
    assert.equal(companyDetail.body.leadTime.observationCount, 4);
    assert.equal(companyDetail.body.leadTime.averageDays, 7.7);
    assert.equal(companyDetail.body.leadTime.medianDays, 8);
    assert.equal(companyDetail.body.observationBasis.products.collectedAt, "2026-08-22T01:00:00.000Z");
    assert.equal(companyDetail.body.observationBasis.daily.collectedAt, "2026-08-22T01:00:00.000Z");
    assert.equal(companyDetail.body.observationBasis.daily.source, "product_snapshot", "stored product daily data must keep priority over history fallback");
    assert.equal(companyDetail.body.company.lastRunId, detailSecondRunId);
    assert.equal(companyDetail.body.salesHistory.schemaVersion, 1);
    assert.equal(companyDetail.body.salesHistory.current.summary.observedDays, 2, "sales history must aggregate stored dates without the old 64-row presentation limit");
    assert.equal(companyDetail.body.salesHistory.current.summary.calendarDays, 8, "current coverage must count today through the latest stored stay date");
    assert.equal(companyDetail.body.salesHistory.current.daily.length, 2);
    assert.equal(companyDetail.body.salesHistory.definitions.week, "월요일부터 일요일");

    const savedAdminProfile = await request(baseUrl, "POST", "/api/company-master/admin-profile", {
      companyId: detailCompany.companyId,
      primaryName: "관리자 확정 테스트 글램핑",
      aliases: "테스트 별칭, 확정 별칭",
      address: "경남 산청군 확정로 1",
      region: "경남 산청",
      lodgingType: "글램핑",
      lodgingBasisTotal: 12,
      dayUseBasisTotal: 3,
      roomSegments: [{ type: "확정 객실", count: 12, weekdayPrice: 100000 }],
      businessVerificationStatus: "confirmed",
      businessName: "테스트 사업자",
      registrationNumber: "123-45-67890",
      representativeName: "홍길동",
      businessVerifiedAt: "2026-08-23",
      businessVerificationNote: "관리자 서류 확인",
      note: "자동수집과 분리된 고정값"
    }, cookies);
    assert.equal(savedAdminProfile.statusCode, 200);
    assert.equal(savedAdminProfile.body.company.adminProfile.primaryName, "관리자 확정 테스트 글램핑");
    assert.deepEqual(savedAdminProfile.body.company.adminProfile.aliases, ["테스트 별칭", "확정 별칭"]);
    assert.equal(savedAdminProfile.body.company.adminProfile.roomBasis.lodgingBasisTotal, 12);
    assert.equal(savedAdminProfile.body.company.adminProfile.businessVerification.status, "confirmed");
    const adminProfileDetail = await request(
      baseUrl,
      "GET",
      `/api/company-master/detail?companyId=${encodeURIComponent(detailCompany.companyId)}`,
      null,
      cookies
    );
    assert.equal(adminProfileDetail.body.company.adminProfile.registrationNumber, undefined);
    assert.equal(adminProfileDetail.body.company.adminProfile.businessVerification.registrationNumber, "123-45-67890");

    const reopenedOlderDetailRun = await request(baseUrl, "GET", `/api/runs/${detailFirstRunId}`, null, cookies);
    assert.equal(reopenedOlderDetailRun.statusCode, 200);
    let detailAfterReopen = await request(
      baseUrl,
      "GET",
      `/api/company-master/detail?companyId=${encodeURIComponent(detailCompany.companyId)}`,
      null,
      cookies
    );
    assert.equal(detailAfterReopen.body.company.inventory?.latest?.runId, detailSecondRunId, "opening an older run must not replace the latest company snapshot");
    assert.equal(detailAfterReopen.body.company.lastRunId, detailSecondRunId, "opening an older run must not replace the latest company run marker");
    assert.equal(detailAfterReopen.body.company.adminProfile.primaryName, "관리자 확정 테스트 글램핑", "opening or collecting a run must not overwrite administrator-confirmed fixed fields");
    assert.deepEqual(detailAfterReopen.body.rankTrend.points.map((row) => row.rank), [8, 5]);
    assert.equal(detailAfterReopen.body.products.length, 2);

    const sparseDetailRun = await request(baseUrl, "GET", `/api/runs/${detailSparseRunId}`, null, cookies);
    assert.equal(sparseDetailRun.statusCode, 200);
    const importedTimestampMasterFile = path.join(dataDir, "company_master", "companies.json");
    const importedTimestampMaster = JSON.parse(await fsp.readFile(importedTimestampMasterFile, "utf8"));
    const importedTimestampCompany = importedTimestampMaster.companies[detailCompany.companyId];
    const importedTimestampKeyword = Object.values(importedTimestampCompany.keywords || {})
      .find((row) => row.keyword === "경남글램핑");
    const importedTimestampRun = importedTimestampKeyword.runs.find((row) => row.runId === detailSparseRunId);
    assert.ok(importedTimestampRun, "timestamp correction fixture must find the imported master run");
    importedTimestampRun.collectedAt = "2026-08-24T09:00:00.000Z";
    importedTimestampRun.collectedDate = "2026-08-24";
    importedTimestampKeyword.lastSeenAt = importedTimestampRun.collectedAt;
    await fsp.writeFile(importedTimestampMasterFile, JSON.stringify(importedTimestampMaster, null, 2), "utf8");
    detailAfterReopen = await request(
      baseUrl,
      "GET",
      `/api/company-master/detail?companyId=${encodeURIComponent(detailCompany.companyId)}`,
      null,
      cookies
    );
    assert.equal(detailAfterReopen.body.company.inventory?.latest?.runId, detailSparseRunId);
    assert.equal(detailAfterReopen.body.products.length, 2, "a newer sparse observation must preserve the last detailed product identities");
    assert.equal(detailAfterReopen.body.priceGroups.length, 1, "a newer sparse observation must preserve exact price groups");
    assert.equal(detailAfterReopen.body.observationBasis.products.runId, detailSecondRunId, "preserved products must retain their own source run");
    assert.equal(detailAfterReopen.body.observationBasis.products.collectedAt, "2026-08-22T01:00:00.000Z", "preserved products must not be presented as newly observed");
    assert.equal(detailAfterReopen.body.observationBasis.daily.runId, detailSparseRunId, "new daily data must retain its own source run");
    assert.equal(detailAfterReopen.body.observationBasis.daily.collectedAt, "2026-08-22T03:00:00.000Z");
    const latestAvailableRankKeyword = detailAfterReopen.body.rankTrend.availableKeywords.find((row) => row.keyword === "경남글램핑");
    assert.equal(latestAvailableRankKeyword.latestRank, 4, "available keyword scope must follow the latest stored observation");
    assert.equal(latestAvailableRankKeyword.previousRank, 5);
    assert.equal(latestAvailableRankKeyword.latestRunId, detailSparseRunId);
    assert.equal(latestAvailableRankKeyword.latestCollectedAt, "2026-08-22T03:00:00.000Z", "history observation time must override the later master re-import time");
    assert.equal(
      detailAfterReopen.body.rankTrend.points.find((row) => row.runId === detailSparseRunId)?.collectedAt,
      "2026-08-22T03:00:00.000Z",
      "rank timeline point must use the original history observation time"
    );
    const persistedMaster = JSON.parse(await fsp.readFile(path.join(dataDir, "company_master", "companies.json"), "utf8"));
    const persistedDetailCompany = persistedMaster.companies[detailCompany.companyId];
    assert.ok(persistedDetailCompany.inventory.snapshots.every((snapshot) => !Array.isArray(snapshot.productSnapshot?.products)), "archived inventory snapshots must not duplicate full product arrays");

    const fallbackCompanyId = "cmp_place_900000097";
    const fallbackCompanyName = "이력 복원 글램핑";
    persistedMaster.companies[fallbackCompanyId] = {
      ...structuredClone(persistedDetailCompany),
      companyId: fallbackCompanyId,
      primaryName: fallbackCompanyName,
      nameKey: "이력복원글램핑",
      looseNameKey: "이력복원글램핑",
      aliases: [fallbackCompanyName],
      placeIds: ["900000097"],
      bookingBusinessIds: [],
      firstRunId: "history_fallback_master",
      lastRunId: "history_fallback_master",
      runIds: ["history_fallback_master"],
      keywords: {},
      inventory: {
        latest: {
          runId: "history_fallback_master",
          collectedAt: "2026-08-20T00:00:00.000Z",
          productSnapshot: null
        },
        previousLatest: null,
        snapshots: [],
        runIds: ["history_fallback_master"],
        structureCounts: {},
        confidenceCounts: {}
      },
      duplicateNotes: []
    };
    persistedMaster.sourceIndex["place:900000097"] = fallbackCompanyId;
    await fsp.writeFile(path.join(dataDir, "company_master", "companies.json"), JSON.stringify(persistedMaster, null, 2), "utf8");

    const fallbackObservation = (overrides = {}) => {
      const supply = overrides.supply ?? 10;
      const available = overrides.available ?? 7;
      const sold = overrides.sold ?? (supply - available);
      return {
        schemaVersion: 1,
        observationId: overrides.observationId,
        runId: overrides.runId,
        companyKey: overrides.companyKey ?? fallbackCompanyId,
        companyName: overrides.companyName ?? fallbackCompanyName,
        productType: overrides.productType || "lodging",
        stayDate: overrides.stayDate,
        collectedAt: overrides.collectedAt,
        collectedDate: String(overrides.collectedAt || "").slice(0, 10),
        supply,
        available,
        sold,
        saleRate: supply > 0 ? sold / supply : null,
        price: overrides.price ?? "120,000원"
      };
    };
    const fallbackObservations = Array.from({ length: 70 }, (_, index) => {
      const stayDate = new Date(Date.UTC(2026, 7, 1 + index)).toISOString().slice(0, 10);
      const sold = index % 5;
      return fallbackObservation({
        observationId: `fallback-base-${index}`,
        runId: `fallback-run-${index}`,
        stayDate,
        collectedAt: new Date(Date.UTC(2026, 7, 20, 0, index)).toISOString(),
        available: 10 - sold,
        sold
      });
    });
    fallbackObservations.push(
      fallbackObservation({
        observationId: "fallback-latest-lodging-old",
        runId: "fallback-lodging-old",
        stayDate: "2026-10-09",
        collectedAt: "2026-08-21T01:00:00.000Z",
        available: 8,
        sold: 2,
        price: "100,000원"
      }),
      fallbackObservation({
        observationId: "fallback-latest-lodging-new",
        runId: "fallback-lodging-new",
        stayDate: "2026-10-09",
        collectedAt: "2026-08-23T01:00:00.000Z",
        available: 3,
        sold: 7,
        price: "120,000원"
      }),
      fallbackObservation({
        observationId: "fallback-latest-dayuse",
        runId: "fallback-dayuse",
        productType: "dayuse",
        stayDate: "2026-10-09",
        collectedAt: "2026-08-23T02:00:00.000Z",
        supply: 4,
        available: 1,
        sold: 3,
        price: "50,000원"
      }),
      fallbackObservation({
        observationId: "fallback-legacy-name-identity",
        runId: "fallback-name-identity",
        companyKey: "이력복원글램핑",
        stayDate: "2026-10-10",
        collectedAt: "2026-08-24T01:00:00.000Z",
        supply: 6,
        available: 2,
        sold: 4,
        price: "가격 확인 불가"
      }),
      fallbackObservation({
        observationId: "fallback-conflicting-measures",
        runId: "fallback-conflict",
        stayDate: "2026-10-11",
        collectedAt: "2026-08-25T01:00:00.000Z",
        supply: 10,
        available: 3,
        sold: 9,
        price: "130,000원"
      }),
      fallbackObservation({
        observationId: "fallback-same-name-other-company",
        runId: "fallback-contaminant",
        companyKey: "cmp_place_900000096",
        companyName: fallbackCompanyName,
        stayDate: "2026-10-10",
        collectedAt: "2026-08-26T01:00:00.000Z",
        supply: 999,
        available: 0,
        sold: 999,
        price: "999,000원"
      })
    );
    const fallbackHistoryFile = path.join(dataDir, "history", "observations.jsonl");
    await fsp.mkdir(path.dirname(fallbackHistoryFile), { recursive: true });
    await fsp.appendFile(
      fallbackHistoryFile,
      `${fallbackObservations.map((row) => JSON.stringify(row)).join("\n")}\n`,
      "utf8"
    );
    const fallbackDetail = await request(
      baseUrl,
      "GET",
      `/api/company-master/detail?companyId=${encodeURIComponent(fallbackCompanyId)}`,
      null,
      cookies
    );
    assert.equal(fallbackDetail.statusCode, 200);
    assert.equal(fallbackDetail.body.daily.length, 64, "history daily fallback must keep a bounded latest window");
    assert.ok(fallbackDetail.body.salesArchive.daily.length > 64, "sales archive must retain observations beyond the latest detail window");
    assert.equal(fallbackDetail.body.salesArchive.source, "history_observations");
    assert.equal(fallbackDetail.body.observationBasis.daily.source, "history_observations");
    assert.equal(fallbackDetail.body.observationBasis.daily.file, "history/observations.jsonl");
    assert.equal(fallbackDetail.body.observationBasis.daily.runId, "fallback-conflict");
    assert.equal(fallbackDetail.body.observationBasis.daily.collectedAt, "2026-08-25T01:00:00.000Z");
    assert.equal(fallbackDetail.body.observationBasis.daily.dateRange.end, "2026-10-11");
    assert.equal(fallbackDetail.body.observationBasis.daily.rowCount, 64);
    assert.equal(fallbackDetail.body.observationBasis.daily.truncated, true);
    const fallbackLatestLodging = fallbackDetail.body.daily.find((row) => row.date === "2026-10-09" && row.productType === "lodging");
    const fallbackLatestDayUse = fallbackDetail.body.daily.find((row) => row.date === "2026-10-09" && row.productType === "dayuse");
    const fallbackLegacyName = fallbackDetail.body.daily.find((row) => row.date === "2026-10-10" && row.productType === "lodging");
    const fallbackConflict = fallbackDetail.body.daily.find((row) => row.date === "2026-10-11" && row.productType === "lodging");
    assert.deepEqual(
      [fallbackLatestLodging.total, fallbackLatestLodging.available, fallbackLatestLodging.sold, fallbackLatestLodging.saleRate],
      [10, 3, 7, 0.7],
      "the latest observation for one lodging stay date must win"
    );
    assert.equal(fallbackLatestLodging.estimatedRevenue, 840000, "estimated revenue requires both observed price and inferred sold quantity");
    assert.equal(fallbackLatestLodging.actualRevenue, null);
    assert.equal(fallbackLatestLodging.revenueType, "estimated");
    assert.deepEqual(
      [fallbackLatestDayUse.total, fallbackLatestDayUse.available, fallbackLatestDayUse.sold, fallbackLatestDayUse.estimatedRevenue],
      [4, 1, 3, 150000],
      "day-use must stay separate from lodging on the same stay date"
    );
    assert.equal(fallbackLegacyName.total, 6, "legacy name identity may restore the same company when no conflicting canonical id is present");
    assert.equal(fallbackLegacyName.price, null);
    assert.equal(fallbackLegacyName.estimatedRevenue, null, "missing price evidence must not create estimated won revenue");
    assert.equal(fallbackConflict.sold, null, "conflicting sold and available evidence must not create a false sold quantity");
    assert.equal(fallbackConflict.saleRate, null);
    assert.equal(fallbackConflict.estimatedRevenue, null);
    assert.ok(fallbackDetail.body.daily.every((row) => row.total !== 999), "a same-name row with another canonical company id must be excluded");
    assert.ok(fallbackDetail.body.daily.every((row) => row.actualRevenue === null && row.actualRevenueAvailable === false));

    let company = summary.body.companies.find((row) => row.placeIds?.includes("987654321"));
    assert.ok(company, "company without Naver inventory must still be stored");
    assert.equal(company.naverChannelObservation.status, "observed_on_naver");
    assert.ok(company.channelExposures.yanolja, `validated Yanolja exposure missing: ${JSON.stringify(company.channelExposures)}`);
    assert.equal(company.channelExposures.yanolja.status, "observed_on_naver");
    assert.equal(company.channelExposures.yanolja.source, "naver_place");
    assert.equal(company.channelExposures.yanolja.confidence, 98);
    assert.equal(company.channelExposures.yeogi, undefined, "mismatched channel domain must not be stored");
    assert.deepEqual(company.naverChannelObservation.externalChannels, ["yanolja"]);
    assert.equal(company.inventory?.latest?.runId || "", "", "channel observation must not create inventory confidence data");
    const broadCompany = summary.body.companies.find((row) => row.placeIds?.includes("800000004"));
    assert.ok(broadCompany, "broad all-lodging ranking company must be present in the company master");
    assert.ok(broadCompany.lodgingTypes?.includes("호텔·리조트"), "broad all-lodging company type must be preserved");
    assert.equal(broadCompany.inventory?.latest?.runId || "", "", "ranking-only broad lodging must not create inventory confidence data");
    assert.equal(
      summary.body.companies.some((row) => row.placeIds?.includes("800000005")),
      false,
      "out-of-range all-lodging companies must not be stored"
    );
    const companyBeforeSupplement = {
      firstSeenAt: company.firstSeenAt,
      lastSeenAt: company.lastSeenAt,
      runCount: company.runCount,
      inventory: company.inventory,
      naverChannelObservation: company.naverChannelObservation,
      naverChannelObservationHistory: company.naverChannelObservationHistory
    };
    const historyFile = path.join(dataDir, "history", "observations.jsonl");
    const historyBeforeSupplement = await readTextIfExists(historyFile);

    const yeogiImport = await request(baseUrl, "POST", "/api/yeogi-import", {
      runId: firstRunId,
      sourceText: [
        "rank,name,price,location,reservation_available,url,raw",
        `1,"${company.primaryName}","120,000원","산청군","Y","https://www.yeogi.com/domestic-accommodations/12345","직접 확인"`
      ].join("\n")
    }, cookies);
    assert.equal(yeogiImport.statusCode, 200);
    assert.equal(yeogiImport.body.companyMatchedCount, 1);
    assert.equal(yeogiImport.body.companyAmbiguousCount, 0);
    assert.equal(yeogiImport.body.data.run.collectedAt, observedAt, "supplement must preserve original collection time");
    summary = await request(baseUrl, "GET", "/api/company-master/summary", null, cookies);
    company = summary.body.companies.find((row) => row.placeIds?.includes("987654321"));
    assert.equal(company.channelExposures.yeogi.status, "directly_verified");
    assert.equal(company.channelExposures.yeogi.method, "yeogi_bulk_import");
    assert.ok(company.channelExposureHistory.some((entry) => entry.action === "yeogi_bulk_import"));
    assert.deepEqual({
      firstSeenAt: company.firstSeenAt,
      lastSeenAt: company.lastSeenAt,
      runCount: company.runCount,
      inventory: company.inventory,
      naverChannelObservation: company.naverChannelObservation,
      naverChannelObservationHistory: company.naverChannelObservationHistory
    }, companyBeforeSupplement, "Yeogi supplement must not rewrite Naver company/inventory history");
    assert.equal(
      await readTextIfExists(historyFile),
      historyBeforeSupplement,
      "Yeogi supplement must not append market inventory history"
    );

    const homonymTargetRun = await request(baseUrl, "GET", `/api/runs/${homonymTargetRunId}`, null, cookies);
    const homonymOtherRun = await request(baseUrl, "GET", `/api/runs/${homonymOtherRunId}`, null, cookies);
    assert.equal(homonymTargetRun.statusCode, 200);
    assert.equal(homonymOtherRun.statusCode, 200);
    const homonymImport = await request(baseUrl, "POST", "/api/yeogi-import", {
      runId: homonymTargetRunId,
      sourceText: [
        "rank,name,price,location,reservation_available,url,raw",
        "1,동명이름 펜션,130000원,산청군,Y,https://www.yeogi.com/domestic-accommodations/80001,산청 직접 확인"
      ].join("\n")
    }, cookies);
    assert.equal(homonymImport.statusCode, 200);
    assert.equal(homonymImport.body.companyMatchedCount, 1, "target-run company should be matched");
    assert.equal(homonymImport.body.companyAmbiguousCount, 0);
    summary = await request(baseUrl, "GET", "/api/company-master/summary", null, cookies);
    const homonymTargetCompany = summary.body.companies.find((row) => row.placeIds?.includes("800000001"));
    const homonymOtherCompany = summary.body.companies.find((row) => row.placeIds?.includes("800000002"));
    assert.equal(homonymTargetCompany.channelExposures.yeogi.status, "directly_verified");
    assert.equal(
      homonymOtherCompany.channelExposures.yeogi,
      undefined,
      "same-name company outside the target run must not receive the imported exposure"
    );

    const manualProtectedRun = await request(baseUrl, "GET", `/api/runs/${manualProtectedRunId}`, null, cookies);
    assert.equal(manualProtectedRun.statusCode, 200);
    summary = await request(baseUrl, "GET", "/api/company-master/summary", null, cookies);
    const manualProtectedCompany = summary.body.companies.find((row) => row.placeIds?.includes("800000003"));
    assert.ok(manualProtectedCompany);
    const protectedUrl = "https://www.yeogi.com/domestic-accommodations/verified-80003";
    const protectedNote = "관리자가 직접 확인한 연결 오류이며 객실 상품 메모를 유지해야 합니다.";
    const manualYeogi = await request(baseUrl, "POST", "/api/company-master/channel-exposure", {
      companyId: manualProtectedCompany.companyId,
      action: "save",
      channel: "yeogi",
      status: "broken_link",
      url: protectedUrl,
      source: "manual",
      method: "admin_manual",
      note: protectedNote,
      products: [{ productName: "관리자 확인 객실", weekdayPrice: "150,000원", note: "수동 확인 상품" }]
    }, cookies);
    assert.equal(manualYeogi.statusCode, 200);
    const protectedImport = await request(baseUrl, "POST", "/api/yeogi-import", {
      runId: manualProtectedRunId,
      sourceText: [
        "rank,name,price,location,reservation_available,url,raw",
        "1,관리자 보호 펜션,90000원,산청군,Y,https://www.yeogi.com/domestic-accommodations/bulk-80003,일괄 결과"
      ].join("\n")
    }, cookies);
    assert.equal(protectedImport.statusCode, 200);
    assert.equal(protectedImport.body.companyMatchedCount, 1);
    assert.equal(protectedImport.body.companyPreservedCount, 1, "manual decision must be preserved");
    summary = await request(baseUrl, "GET", "/api/company-master/summary", null, cookies);
    const protectedAfterImport = summary.body.companies.find((row) => row.placeIds?.includes("800000003"));
    assert.equal(protectedAfterImport.channelExposures.yeogi.status, "broken_link");
    assert.equal(protectedAfterImport.channelExposures.yeogi.method, "admin_manual");
    assert.equal(protectedAfterImport.channelExposures.yeogi.url, protectedUrl);
    assert.equal(protectedAfterImport.channelExposures.yeogi.note, protectedNote);
    assert.equal(protectedAfterImport.channelExposures.yeogi.products[0].productName, "관리자 확인 객실");
    assert.equal(
      protectedAfterImport.channelExposureHistory.some((entry) => entry.action === "yeogi_bulk_import"),
      false,
      "protected manual decision must not create a misleading bulk-applied history entry"
    );

    const direct = await request(baseUrl, "POST", "/api/company-master/channel-exposure", {
      companyId: company.companyId,
      action: "save",
      channel: "yanolja",
      status: "directly_verified",
      url: "https://nol.yanolja.com/stay/domestic/12345",
      source: "manual",
      method: "admin_manual",
      note: "관리자 직접 확인"
    }, cookies);
    assert.equal(direct.statusCode, 200);

    const secondRun = await request(baseUrl, "GET", `/api/runs/${secondRunId}`, null, cookies);
    assert.equal(secondRun.statusCode, 200);
    summary = await request(baseUrl, "GET", "/api/company-master/summary", null, cookies);
    company = summary.body.companies.find((row) => row.placeIds?.includes("987654321"));
    assert.equal(company.naverChannelObservation.status, "not_observed_on_naver");
    assert.equal(company.channelExposures.yanolja.status, "directly_verified", "Naver non-observation must not erase direct verification");
    assert.equal(company.inventory?.latest?.runId || "", "", "non-observation must not affect inventory confidence");

    const thirdRun = await request(baseUrl, "GET", `/api/runs/${thirdRunId}`, null, cookies);
    assert.equal(thirdRun.statusCode, 200);
    summary = await request(baseUrl, "GET", "/api/company-master/summary", null, cookies);
    company = summary.body.companies.find((row) => row.placeIds?.includes("987654321"));
    assert.equal(company.naverChannelObservation.status, "observed_on_naver");
    assert.equal(company.channelExposures.yanolja.status, "directly_verified", "later Naver observation must not erase direct verification");

    const invalidRun = await request(baseUrl, "GET", `/api/runs/${invalidRunId}`, null, cookies);
    assert.equal(invalidRun.statusCode, 200);
    summary = await request(baseUrl, "GET", "/api/company-master/summary", null, cookies);
    const invalidCompany = summary.body.companies.find((row) => row.placeIds?.includes("111222333"));
    assert.ok(invalidCompany, "invalid observation should remain reviewable as a company record");
    assert.equal(invalidCompany.naverChannelObservation.status, "auto_failed");
    assert.deepEqual(invalidCompany.naverChannelObservation.externalChannels, []);
    assert.deepEqual(invalidCompany.channelExposures, {});

    const masterFile = path.join(dataDir, "company_master", "companies.json");
    const mergeMaster = JSON.parse(await fsp.readFile(masterFile, "utf8"));
    const mergeSource = mergeMaster.companies[detailCompany.companyId];
    const mergeTargetId = "cmp_place_900000099";
    const noPriceMixedId = "cmp_place_900000098";
    const incompleteMixedId = "cmp_place_900000097";
    const incompleteSoldId = "cmp_place_900000096";
    const priceOnlyId = "cmp_place_900000095";
    mergeMaster.companies[mergeTargetId] = {
      ...structuredClone(mergeSource),
      companyId: mergeTargetId,
      primaryName: "상세 스냅샷 병합 대상",
      placeIds: ["900000099"],
      inventory: {
        ...(mergeSource.inventory || {}),
        latest: {
          ...(mergeSource.inventory?.latest || {}),
          runId: "merge_sparse_newer",
          collectedAt: "2026-08-23T01:00:00.000Z",
          productSnapshot: null
        },
        previousLatest: null,
        snapshots: []
      }
    };
    mergeMaster.companies[noPriceMixedId] = {
      ...structuredClone(mergeSource),
      companyId: noPriceMixedId,
      primaryName: "가격 미관측 혼합상품 테스트",
      placeIds: ["900000098"],
      inventory: {
        latest: {
          runId: "mixed_no_price",
          collectedAt: "2026-08-23T00:30:00.000Z",
          salesSignal: {
            checkIn: "2026-08-29",
            lodging: { days: 1, totalSupply: 10, totalSold: 2, averageRate: 0.2 },
            dayUse: { days: 1, totalSupply: 10, totalSold: 8, averageRate: 0.8 }
          },
          revenue: {
            lodging: { revenue: 0, adjustedRevenue: 0, pricedSoldOut: 0, missingPriceSoldOut: 2 },
            dayUse: { revenue: 0, adjustedRevenue: 0, pricedSoldOut: 0, missingPriceSoldOut: 8 }
          },
          productSnapshot: null
        },
        previousLatest: null,
        snapshots: [],
        runIds: ["mixed_no_price"],
        structureCounts: {},
        confidenceCounts: {}
      }
    };
    mergeMaster.companies[incompleteMixedId] = {
      ...structuredClone(mergeSource),
      companyId: incompleteMixedId,
      primaryName: "혼합상품 일부 수량 누락 테스트",
      placeIds: ["900000097"],
      inventory: {
        latest: {
          runId: "mixed_incomplete_quantity",
          collectedAt: "2026-08-23T00:40:00.000Z",
          salesSignal: {
            checkIn: "2026-08-29",
            lodging: { days: 1, totalSupply: 10, totalSold: 2, averageRate: 0.2 },
            dayUse: { days: 1, totalSold: 8, averageRate: 0.8 }
          },
          revenue: {},
          productSnapshot: null
        },
        previousLatest: null,
        snapshots: [],
        runIds: ["mixed_incomplete_quantity"],
        structureCounts: {},
        confidenceCounts: {}
      }
    };
    mergeMaster.companies[incompleteSoldId] = {
      ...structuredClone(mergeSource),
      companyId: incompleteSoldId,
      primaryName: "혼합상품 일부 판매량 누락 테스트",
      placeIds: ["900000096"],
      inventory: {
        latest: {
          runId: "mixed_incomplete_sold",
          collectedAt: "2026-08-23T00:50:00.000Z",
          salesSignal: {
            checkIn: "2026-08-29",
            lodging: { days: 1, totalSupply: 10, totalSold: 2, averageRate: 0.2 },
            dayUse: { days: 1, totalSupply: 10, averageRate: 0.8 }
          },
          revenue: {},
          productSnapshot: null
        },
        previousLatest: null,
        snapshots: [],
        runIds: ["mixed_incomplete_sold"],
        structureCounts: {},
        confidenceCounts: {}
      }
    };
    mergeMaster.companies[priceOnlyId] = {
      ...structuredClone(mergeSource),
      companyId: priceOnlyId,
      primaryName: "가격만 있고 매출산식 없는 테스트",
      placeIds: ["900000095"],
      inventory: {
        latest: {
          runId: "price_only_without_revenue_evidence",
          collectedAt: "2026-08-23T01:00:00.000Z",
          price: 149000,
          salesSignal: {
            checkIn: "2026-08-29",
            lodging: { days: 1, totalSupply: 10, totalSold: 0, averageRate: 0 }
          },
          revenue: { lodging: {} },
          productSnapshot: { summary: { priceGroupCount: 1 } }
        },
        previousLatest: null,
        snapshots: [],
        runIds: ["price_only_without_revenue_evidence"],
        structureCounts: {},
        confidenceCounts: {}
      }
    };
    mergeMaster.sourceIndex["place:900000099"] = mergeTargetId;
    mergeMaster.sourceIndex["place:900000098"] = noPriceMixedId;
    mergeMaster.sourceIndex["place:900000097"] = incompleteMixedId;
    mergeMaster.sourceIndex["place:900000096"] = incompleteSoldId;
    mergeMaster.sourceIndex["place:900000095"] = priceOnlyId;
    await fsp.writeFile(masterFile, JSON.stringify(mergeMaster, null, 2), "utf8");
    const noPriceMixedDetail = await request(
      baseUrl,
      "GET",
      `/api/company-master/detail?companyId=${encodeURIComponent(noPriceMixedId)}`,
      null,
      cookies
    );
    assert.equal(noPriceMixedDetail.statusCode, 200);
    assert.equal(noPriceMixedDetail.body.performanceTrend.points.at(-1).reservationRate, 0.5, "mixed lodging/day-use rate must use the same combined supply basis");
    assert.equal(noPriceMixedDetail.body.performanceTrend.points.at(-1).estimatedRevenue, null, "zero revenue without price evidence must remain unknown");
    assert.equal(noPriceMixedDetail.body.performanceTrend.points.at(-1).priceEvidenceObserved, false);
    const incompleteMixedDetail = await request(
      baseUrl,
      "GET",
      `/api/company-master/detail?companyId=${encodeURIComponent(incompleteMixedId)}`,
      null,
      cookies
    );
    assert.equal(incompleteMixedDetail.statusCode, 200);
    assert.equal(incompleteMixedDetail.body.performanceTrend.points.at(-1).totalSupply, null, "mixed product supply must remain unknown when one observed type is missing its quantity");
    assert.equal(incompleteMixedDetail.body.performanceTrend.points.at(-1).reservationRate, null, "mixed product rate must remain unknown when supply and sold do not share a complete basis");
    const incompleteSoldDetail = await request(
      baseUrl,
      "GET",
      `/api/company-master/detail?companyId=${encodeURIComponent(incompleteSoldId)}`,
      null,
      cookies
    );
    assert.equal(incompleteSoldDetail.statusCode, 200);
    assert.equal(incompleteSoldDetail.body.performanceTrend.points.at(-1).totalSupply, 20);
    assert.equal(incompleteSoldDetail.body.performanceTrend.points.at(-1).totalSold, null, "mixed product sold count must remain unknown when one observed type is missing its quantity");
    assert.equal(incompleteSoldDetail.body.performanceTrend.points.at(-1).reservationRate, null, "mixed product rate must remain unknown when sold counts are incomplete");
    const priceOnlyDetail = await request(
      baseUrl,
      "GET",
      `/api/company-master/detail?companyId=${encodeURIComponent(priceOnlyId)}`,
      null,
      cookies
    );
    assert.equal(priceOnlyDetail.statusCode, 200);
    assert.equal(priceOnlyDetail.body.performanceTrend.points.at(-1).estimatedRevenue, null, "price presence alone must not manufacture zero estimated revenue");
    assert.equal(priceOnlyDetail.body.performanceTrend.points.at(-1).priceEvidenceObserved, false, "price-only snapshots must wait for a revenue calculation basis");
    const mergedCompany = await request(baseUrl, "POST", "/api/company-master/duplicates", {
      action: "merge",
      candidateKey: "product-snapshot-merge-regression",
      companyIds: [mergeTargetId, detailCompany.companyId]
    }, cookies);
    assert.equal(mergedCompany.statusCode, 200);
    const mergedCompanyDetail = await request(
      baseUrl,
      "GET",
      `/api/company-master/detail?companyId=${encodeURIComponent(mergeTargetId)}`,
      null,
      cookies
    );
    assert.equal(mergedCompanyDetail.statusCode, 200);
    assert.equal(mergedCompanyDetail.body.products.length, 2, "company merge must preserve the only detailed product snapshot");
    assert.equal(mergedCompanyDetail.body.observationBasis.products.runId, detailSecondRunId);
  } finally {
    await stopChild(child);
    await fsp.rm(tmp, { recursive: true, force: true });
  }

  console.log("Naver OTA company master tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
