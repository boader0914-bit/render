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
        const setCookie = res.headers["set-cookie"] || [];
        let parsed = {};
        try {
          parsed = data ? JSON.parse(data) : {};
        } catch {
          parsed = { raw: data };
        }
        resolve({ statusCode: res.statusCode, headers: res.headers, cookies: setCookie.map((item) => item.split(";")[0]), body: parsed });
      });
    });
    req.once("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function waitForServer(child) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("server start timeout")), 20000);
    const onData = (chunk) => {
      const text = String(chunk || "");
      if (text.includes("Lodging datalab beta app running")) {
        clearTimeout(timeout);
        resolve();
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`server exited before ready: ${code}`));
    });
  });
}

async function main() {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "b2b-manual-correction-"));
  const dataDir = path.join(tmp, "data");
  const companyMasterDir = path.join(dataDir, "company_master");
  await fsp.mkdir(companyMasterDir, { recursive: true });
  const companyId = "company-test-1";
  await fsp.writeFile(path.join(companyMasterDir, "companies.json"), JSON.stringify({
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
    companies: {
      [companyId]: {
        companyId,
        primaryName: "검수 테스트 글램핑",
        aliases: ["검수 테스트 글램핑"],
        regions: ["포천"],
        addresses: ["경기 포천시"],
        runIds: [],
        sourceRoles: ["admin"],
        collectionSources: ["test"],
        keywords: {},
        inventory: {
          latest: {
            inventoryEvidenceVersion: 4,
            stockBasis: { lodgingMaxTotal: 10 },
            productSnapshot: {
              inventoryEvidenceVersion: 4,
              capacityBasis: { count: 10, source: "observed_maximum", observedMaximum: 10 },
              products: [{ key: "room", productType: "lodging", name: "기본" }],
              daily: [{ date: "2026-09-26", productType: "lodging", total: 10, rawTotal: 10, available: 5,
                publicBookings: 1, phoneBookings: 4, sold: 5, reservationRate: 0.5,
                publicRevenue: 100000, phoneRevenue: 400000, estimatedRevenue: 500000, inventoryEvidenceVersion: 4 }]
            },
            salesSignal: {
              lodging: { days: 7, totalSupply: 70, totalSold: 14, averageRate: 0.2 },
              dayUse: { days: 0, totalSupply: 0, totalSold: 0 }
            }
          }
        }
      }
    },
    sourceIndex: {},
    duplicateResolutions: {}
  }, null, 2), "utf8");

  const port = await freePort();
  const child = spawn(process.execPath, [path.join(__dirname, "glamping_app_server.cjs")], {
    cwd: path.resolve(__dirname, ".."),
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      DATA_DIR: dataDir,
      OUTPUTS_DIR: path.join(dataDir, "outputs"),
      CONFIG_DIR: path.join(dataDir, "config"),
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
    assert.equal(login.statusCode, 200);
    const cookies = login.cookies;

    const correction = await request(baseUrl, "POST", "/api/company-master/manual-correction", {
      companyId,
      roomSegments: [
        { type: "스탠다드", count: 4, weekdayPrice: 120000, fridayPrice: 160000, saturdayPrice: 220000, sundayPrice: 140000 },
        { type: "프리미엄", count: 2, weekdayPrice: 180000, fridayPrice: 220000, saturdayPrice: 290000, sundayPrice: 200000 }
      ],
      naverBookingStatus: "visible",
      otaChannels: ["여기어때", "야놀자"],
      facilityTags: ["수영장", "바베큐"],
      couponVisible: "visible",
      couponNames: "주중 할인",
      note: "테스트 검수값"
    }, cookies);
    assert.equal(correction.statusCode, 200);
    assert.equal(correction.body.resolved.action, "saveManualCorrection");

    const summary = await request(baseUrl, "GET", "/api/company-master/summary", null, cookies);
    assert.equal(summary.statusCode, 200);
    const company = summary.body.companies.find((row) => row.companyId === companyId);
    assert.ok(company);
    assert.equal(company.manualCorrection.roomSegments.length, 2);
    assert.equal(company.manualCorrection.roomSegments[0].type, "스탠다드");
    assert.equal(company.manualCorrection.roomSegments[0].count, "4");
    assert.equal(company.manualCorrection.naverBookingStatus, "visible");
    assert.deepEqual(company.manualCorrection.otaChannels, ["여기어때", "야놀자"]);
    assert.deepEqual(company.manualCorrection.facilityTags, ["수영장", "바베큐"]);
    assert.equal(company.manualCorrection.couponVisible, "visible");
    assert.equal(company.manualCorrection.couponNames, "주중 할인");
    assert.equal(company.correctionStatus.key, "admin_override");
    assert.match(company.correctionStatus.detail, /숙박 운영 6개/);
    assert.match(company.correctionStatus.detail, /객실종류 2개/);
    assert.match(company.correctionStatus.detail, /OTA 2개/);
    assert.match(company.correctionStatus.detail, /시설 2개/);
    assert.equal(company.inventory.latest.correctionBasis.lodgingBasisTotal, 6);
    assert.equal(company.inventory.latest.correctionBasis.roomSegments.length, 2);
    assert.deepEqual(company.inventory.latest.correctionBasis.otaChannels, ["여기어때", "야놀자"]);
    assert.equal(company.inventory.latest.stockBasis.lodgingBasisTotal, 6);
    const detail = await request(baseUrl, "GET", `/api/company-master/detail?companyId=${companyId}`, null, cookies);
    assert.equal(detail.statusCode, 200);
    assert.equal(detail.body.daily[0].total, 6, "detail uses the lower DB correction immediately");
    assert.equal(detail.body.daily[0].publicBookings, 1);
    assert.equal(detail.body.daily[0].phoneBookings, 0, "snapshot-only correction does not retain stale phone estimates");
    assert.equal(detail.body.daily[0].reservationRate, null);
    assert.equal(detail.body.capacityBasis.source, "db_correction");
    assert.equal(detail.body.capacityReview.required, true);

    const updated = await request(baseUrl, "POST", "/api/company-master/manual-correction", {
      companyId, lodgingBasisTotal: 8
    }, cookies);
    assert.equal(updated.statusCode, 200);
    const reloaded = await request(baseUrl, "GET", `/api/company-master/detail?companyId=${companyId}`, null, cookies);
    assert.equal(reloaded.body.daily[0].total, 8, "updating the DB correction invalidates the previous read view");
    const saved = JSON.parse(await fsp.readFile(path.join(companyMasterDir, "companies.json"), "utf8"));
    assert.equal(saved.companies[companyId].manualCorrection.lodgingBasisTotal, 8);
    assert.equal(saved.companies[companyId].inventory.latest.productSnapshot.daily[0].total, 10, "original stored inventory remains untouched");
    assert.equal(saved.companies[companyId].inventory.latest.productSnapshot.daily[0].phoneBookings, 4);

    const cleared = await request(baseUrl, "POST", "/api/company-master/manual-correction", { companyId, active: false }, cookies);
    assert.equal(cleared.statusCode, 200);
    const afterClear = await request(baseUrl, "GET", `/api/company-master/detail?companyId=${companyId}`, null, cookies);
    assert.equal(afterClear.body.daily[0].total, 10);
    assert.equal(afterClear.body.capacityBasis.source, "observed_maximum");
  } finally {
    child.kill();
    await fsp.rm(tmp, { recursive: true, force: true });
  }

  console.log("B2B manual correction segment tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
