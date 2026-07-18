const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const SERVER = path.join(ROOT, "scripts", "glamping_app_server.cjs");
const TARGET_COMPANY_ID = "cmp_guard_target";
const COMPARABLE_COMPANY_ID = "cmp_guard_peer";
const TARGET_MONTH = "2026-08";

function collection(name, items = [], extras = {}) {
  return {
    version: 1,
    name,
    updatedAt: "2026-07-18T00:00:00.000Z",
    ...extras,
    items
  };
}

async function writeJson(filePath, data) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), "utf8");
}

async function seedDataDir() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "glamping-business-guardrails-"));
  const dbDir = path.join(dataDir, "db");
  const now = "2026-07-18T00:00:00.000Z";

  await writeJson(path.join(dbDir, "company_master.json"), collection("company_master", [
    {
      companyId: TARGET_COMPANY_ID,
      canonicalName: "Guard Target Stay",
      region: "Pocheon",
      category: "glamping",
      b2bVisibility: "eligible",
      autoConfidence: "B",
      createdAt: now,
      updatedAt: now
    },
    {
      companyId: COMPARABLE_COMPANY_ID,
      canonicalName: "Guard Peer Camp",
      region: "Pocheon",
      category: "glamping",
      b2bVisibility: "eligible",
      autoConfidence: "B",
      createdAt: now,
      updatedAt: now
    }
  ]));

  await writeJson(path.join(dbDir, "company_verified_profile.json"), collection("company_verified_profile", [
    {
      companyId: TARGET_COMPANY_ID,
      canonicalName: "Guard Target Stay",
      region: "Pocheon",
      category: "glamping",
      b2bVisibility: "eligible",
      verifiedStatus: "verified",
      finalConfidence: "A",
      overrides: {
        roomTotal: 10,
        dayUseTotal: 0,
        channelUrls: ["https://booking.example.test/guard-target"]
      },
      updatedAt: now,
      updatedBy: "test"
    },
    {
      companyId: COMPARABLE_COMPANY_ID,
      canonicalName: "Guard Peer Camp",
      region: "Pocheon",
      category: "glamping",
      b2bVisibility: "eligible",
      verifiedStatus: "verified",
      finalConfidence: "B",
      overrides: {
        roomTotal: 12,
        dayUseTotal: 0,
        channelUrls: ["https://booking.example.test/guard-peer"]
      },
      updatedAt: now,
      updatedBy: "test"
    }
  ]));

  await writeJson(path.join(dbDir, "property_observations.json"), collection("property_observations", [
    {
      observationId: "obs_target_detail",
      companyId: TARGET_COMPANY_ID,
      canonicalName: "Guard Target Stay",
      region: "Pocheon",
      category: "glamping",
      collectionMode: "detailed_search",
      searchScope: "company_detail",
      channel: "naver",
      targetDate: "2026-08-15",
      observedAt: "2026-07-18T01:00:00.000Z",
      price: "249000원",
      totalRooms: 10,
      availableRooms: 4,
      reservationRate: 0.6,
      rank: 7
    },
    {
      observationId: "obs_target_ota",
      companyId: TARGET_COMPANY_ID,
      canonicalName: "Guard Target Stay",
      region: "Pocheon",
      category: "glamping",
      collectionMode: "ota_exposure",
      searchScope: "company_detail",
      channel: "naver",
      targetDate: "2026-08-15",
      observedAt: "2026-07-18T01:10:00.000Z",
      price: "249000원",
      totalRooms: 10,
      availableRooms: 4,
      reservationRate: 0.6,
      exposureScore: 88,
      otaExposure: {
        exposed: true,
        exposureScore: 88
      }
    },
    {
      observationId: "obs_peer_detail",
      companyId: COMPARABLE_COMPANY_ID,
      canonicalName: "Guard Peer Camp",
      region: "Pocheon",
      category: "glamping",
      collectionMode: "detailed_search",
      searchScope: "company_detail",
      channel: "naver",
      targetDate: "2026-08-15",
      observedAt: "2026-07-18T01:00:00.000Z",
      price: "279000원",
      totalRooms: 12,
      availableRooms: 2,
      reservationRate: 0.83,
      rank: 3
    },
    {
      observationId: "obs_peer_ota",
      companyId: COMPARABLE_COMPANY_ID,
      canonicalName: "Guard Peer Camp",
      region: "Pocheon",
      category: "glamping",
      collectionMode: "ota_exposure",
      searchScope: "company_detail",
      channel: "naver",
      targetDate: "2026-08-15",
      observedAt: "2026-07-18T01:15:00.000Z",
      price: "279000원",
      totalRooms: 12,
      availableRooms: 2,
      reservationRate: 0.83,
      exposureScore: 94,
      otaExposure: {
        exposed: true,
        exposureScore: 94
      }
    }
  ]));

  await writeJson(path.join(dbDir, "leadtime_patterns.json"), collection("leadtime_patterns", [
    {
      patternId: "ltp_target",
      companyId: TARGET_COMPANY_ID,
      canonicalName: "Guard Target Stay",
      region: "Pocheon",
      category: "glamping",
      channel: "naver",
      productKey: "standard",
      targetDate: "2026-08-15",
      targetMonth: TARGET_MONTH,
      sampleCount: 3,
      observedSpanDays: 14,
      bookingRateStart: 0.2,
      bookingRateLatest: 0.42,
      bookingRateDelta: 0.22,
      projectedArrivalBookingRate: 0.42,
      bookingPaceScore: 42,
      confidenceScore: 82,
      confidenceGrade: "A",
      series: []
    },
    {
      patternId: "ltp_peer",
      companyId: COMPARABLE_COMPANY_ID,
      canonicalName: "Guard Peer Camp",
      region: "Pocheon",
      category: "glamping",
      channel: "naver",
      productKey: "standard",
      targetDate: "2026-08-15",
      targetMonth: TARGET_MONTH,
      sampleCount: 3,
      observedSpanDays: 14,
      bookingRateStart: 0.45,
      bookingRateLatest: 0.74,
      bookingRateDelta: 0.29,
      projectedArrivalBookingRate: 0.74,
      bookingPaceScore: 74,
      confidenceScore: 84,
      confidenceGrade: "A",
      series: []
    }
  ], {
    segments: [
      {
        segmentId: "lts_pocheon_glamping",
        region: "Pocheon",
        category: "glamping",
        channel: "naver",
        productKey: "standard",
        targetMonth: TARGET_MONTH,
        companyCount: 2,
        patternCount: 2,
        sampleCount: 6,
        avgProjectedArrivalBookingRate: 0.58,
        bookingPaceScore: 58,
        confidenceScore: 86,
        confidenceGrade: "A"
      }
    ]
  }));

  await writeJson(path.join(dbDir, "interest_signals.json"), collection("interest_signals", [
    {
      signalId: "sig_target_trend",
      companyId: TARGET_COMPANY_ID,
      region: "Pocheon",
      scope: "property_keyword",
      signalType: "naver_trend",
      keyword: "Guard Target Stay",
      score: 82,
      status: "verified",
      observedAt: now,
      reviewedBy: "test"
    },
    {
      signalId: "sig_target_search",
      companyId: TARGET_COMPANY_ID,
      region: "Pocheon",
      scope: "property_keyword",
      signalType: "search_volume",
      keyword: "Guard Target Stay glamping",
      score: 76,
      status: "verified",
      observedAt: now,
      reviewedBy: "test"
    },
    {
      signalId: "sig_target_sns",
      companyId: TARGET_COMPANY_ID,
      region: "Pocheon",
      scope: "property_keyword",
      signalType: "sns_mentions",
      keyword: "Guard Target Stay review",
      score: 68,
      status: "verified",
      observedAt: now,
      reviewedBy: "test"
    },
    {
      signalId: "sig_region_search",
      region: "Pocheon",
      scope: "region_keyword",
      signalType: "search_volume",
      keyword: "Pocheon glamping",
      score: 66,
      status: "verified",
      observedAt: now,
      reviewedBy: "test"
    },
    {
      signalId: "sig_region_sns",
      region: "Pocheon",
      scope: "region_keyword",
      signalType: "sns_mentions",
      keyword: "Pocheon travel",
      score: 60,
      status: "verified",
      observedAt: now,
      reviewedBy: "test"
    },
    {
      signalId: "sig_peer_search",
      companyId: COMPARABLE_COMPANY_ID,
      region: "Pocheon",
      scope: "property_keyword",
      signalType: "search_volume",
      keyword: "Guard Peer Camp",
      score: 54,
      status: "verified",
      observedAt: now,
      reviewedBy: "test"
    }
  ]));

  await writeJson(path.join(dbDir, "company_subscriptions.json"), collection("company_subscriptions", [
    {
      subscriptionId: "sub_guard_target",
      companyId: TARGET_COMPANY_ID,
      plan: "pro",
      status: "active",
      currentPeriodEndsAt: "2026-08-31",
      updatedAt: now,
      updatedBy: "test"
    }
  ]));

  return dataDir;
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

function cleanEnv(overrides = {}) {
  return {
    ...process.env,
    APP_PIN: "",
    APP_USER: "",
    RENDER: "",
    RENDER_EXTERNAL_URL: "",
    NODE_ENV: "test",
    ...overrides
  };
}

async function startServer(dataDir, overrides = {}) {
  const port = await getFreePort();
  const child = spawn(process.execPath, [SERVER], {
    cwd: ROOT,
    env: cleanEnv({
      DATA_DIR: dataDir,
      PORT: String(port),
      ...overrides
    }),
    stdio: ["ignore", "pipe", "pipe"]
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk.toString(); });
  child.stderr.on("data", (chunk) => { output += chunk.toString(); });

  const baseUrl = `http://127.0.0.1:${port}`;
  const startedAt = Date.now();
  while (Date.now() - startedAt < 8000) {
    if (child.exitCode !== null) {
      throw new Error(`server exited before health check: ${output}`);
    }
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.status === 200) {
        return {
          baseUrl,
          child,
          output: () => output,
          async stop() {
            child.kill();
            await new Promise((resolve) => {
              child.once("exit", resolve);
              setTimeout(resolve, 1500);
            });
          }
        };
      }
    } catch {
      // Server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  child.kill();
  throw new Error(`server did not become healthy: ${output}`);
}

async function fetchJson(baseUrl, pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, options);
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: response.status, body };
}

function collectKeys(value, prefix = "", keys = []) {
  if (!value || typeof value !== "object") return keys;
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectKeys(item, `${prefix}[${index}]`, keys));
    return keys;
  }
  for (const [key, child] of Object.entries(value)) {
    const next = prefix ? `${prefix}.${key}` : key;
    keys.push(next);
    collectKeys(child, next, keys);
  }
  return keys;
}

function assertBusinessPayloadHasNoInternalKeys(payload) {
  const blocked = [
    "admin",
    "formula",
    "raw",
    "operator",
    "audit",
    "changelog",
    "log",
    "autoapproval",
    "internal",
    "filepath",
    "diagnostic",
    "failure",
    "quota",
    "calibration",
    "reviewhistory",
    "sourcerow",
    "sla",
    "keyrotation",
    "preflight",
    "postrotationsmoke",
    "recoveryprocedure",
    "authenticationsecurity",
    "commerciallaunchgate",
    "commerciallaunchrc",
    "launchrcrehearsal",
    "rcrehearsal",
    "releaseoperationsevidence",
    "environmentcomparison",
    "releasecandidate",
    "releasesourceparity",
    "expectedreleasecommit",
    "executedreleasecommit",
    "expectedcommit",
    "executedcommit",
    "executionidentity",
    "launchgate",
    "gonogo",
    "releaseapproval",
    "launchevidence",
    "launchsnapshot"
  ];
  const leaked = collectKeys(payload)
    .filter((keyPath) => blocked.some((token) => keyPath.toLowerCase().includes(token)));
  assert.deepEqual(leaked, [], `business payload leaked internal key paths: ${leaked.join(", ")}`);
}

function basicAuth(user, password) {
  return `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;
}

async function testBusinessReportGuardrails(dataDir) {
  const server = await startServer(dataDir);
  try {
    const { status, body } = await fetchJson(
      server.baseUrl,
      `/api/business/report?companyId=${encodeURIComponent(TARGET_COMPANY_ID)}&targetMonth=${TARGET_MONTH}`
    );
    assert.equal(status, 200);
    assert.equal(body.role, "business");
    assert.equal(body.company.companyId, TARGET_COMPANY_ID);
    assertBusinessPayloadHasNoInternalKeys(body);

    assert.equal(body.flows.myProperty.metrics.leadtime.avgBookingPaceScore, 42);
    assert.equal(body.flows.comparables.metrics.leadtime.avgBookingPaceScore, 74);
    assert.equal(body.objectiveIndicators.leadtimePosition.status, "below_baseline");

    assert.equal(body.objectiveIndicators.interestDemand.myScore, 70);
    assert.equal(body.objectiveIndicators.interestDemand.comparableScore, 60);
    assert.equal(body.objectiveIndicators.interestPosition.status, "above_baseline");

    assert.equal(body.strategyRecommendations.length, 5);
    assert.ok(body.strategyRecommendations.every((item) => item.strategyId && item.category && item.action));
    assert.ok(body.strategyRecommendations.every((item) => item.confidenceGrade));
    assert.ok(body.strategyRecommendations.some((item) => item.objectiveMetrics?.leadtime));
  } finally {
    await server.stop();
  }
}

async function testProductionAuthGate(dataDir) {
  const missingPinServer = await startServer(dataDir, {
    RENDER: "true",
    NODE_ENV: "production",
    APP_PIN: ""
  });
  try {
    const health = await fetchJson(missingPinServer.baseUrl, "/api/health");
    assert.equal(health.status, 200);
    const blocked = await fetchJson(missingPinServer.baseUrl, "/api/business/companies");
    assert.equal(blocked.status, 503);
  } finally {
    await missingPinServer.stop();
  }

  const protectedServer = await startServer(dataDir, {
    RENDER: "true",
    NODE_ENV: "production",
    APP_USER: "admin",
    APP_PIN: "audit-pin"
  });
  try {
    const denied = await fetchJson(protectedServer.baseUrl, "/api/business/companies");
    assert.equal(denied.status, 401);

    const allowed = await fetchJson(protectedServer.baseUrl, "/api/business/companies", {
      headers: {
        Authorization: basicAuth("admin", "audit-pin")
      }
    });
    assert.equal(allowed.status, 200);
    assertBusinessPayloadHasNoInternalKeys(allowed.body);
  } finally {
    await protectedServer.stop();
  }
}

(async () => {
  const dataDir = await seedDataDir();
  try {
    await testBusinessReportGuardrails(dataDir);
    await testProductionAuthGate(dataDir);
    console.log("business guardrail tests passed");
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
