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

function csvCell(value) {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

async function writeRun(outputsDir, config) {
  const runDir = path.join(outputsDir, config.runId);
  const overallFile = `${config.runId}_overall_place_rank.csv`;
  const placeId = String(config.placeId || "987654321");
  const companyName = config.companyName || "채널 관측 테스트 펜션";
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
    "경남 산청군 테스트로 1",
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
  await fsp.writeFile(path.join(runDir, "manifest.json"), JSON.stringify({
    keyword: "테스트펜션",
    searchMode: "keyword",
    collectionMode: "precision",
    collectionPurpose: "basic_db",
    collectionPurposeLabel: "기본 DB 수집",
    collectionProfile: "basic_db_light",
    collectionProfileLabel: "기본 DB 중심",
    detailRankRanges: "1-40",
    checkIn: "2026-08-22",
    checkOut: "2026-08-23",
    adults: 2,
    fileRoles: { overall: overallFile },
    files: [overallFile],
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

    const firstRun = await request(baseUrl, "GET", `/api/runs/${firstRunId}`, null, cookies);
    assert.equal(firstRun.statusCode, 200);
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
