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
  const placeUrl = `https://pcmap.place.naver.com/accommodation/${placeId}`;
  await fsp.mkdir(runDir, { recursive: true });
  const channels = config.channels || [];
  const headers = [
    "query",
    "overall_rank",
    "place_id",
    "업체명",
    "카테고리",
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
    "테스트펜션",
    "1",
    placeId,
    companyName,
    "펜션",
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
  await fsp.writeFile(path.join(runDir, overallFile), `${headers.map(csvCell).join(",")}\n${values.map(csvCell).join(",")}\n`, "utf8");
  await fsp.writeFile(
    path.join(runDir, platformFile),
    `channel,name,price,url\n${["네이버", companyName, "", placeUrl].map(csvCell).join(",")}\n`,
    "utf8"
  );
  await fsp.writeFile(path.join(runDir, "manifest.json"), JSON.stringify({
    keyword: config.keyword || "테스트펜션",
    searchMode: "keyword",
    collectionMode: "precision",
    collectionPurpose: "basic_db",
    collectionPurposeLabel: "기본 DB 수집",
    collectionProfile: "basic_db_light",
    collectionProfileLabel: "기본 DB 중심",
    detailRankRanges: "1-40",
    checkIn: config.checkIn || "2026-08-22",
    checkOut: config.checkOut || "2026-08-23",
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

    let summary = await request(baseUrl, "GET", "/api/company-master/summary", null, cookies);
    assert.equal(summary.statusCode, 200);
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
