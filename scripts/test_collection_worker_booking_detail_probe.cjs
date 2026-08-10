"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const {
  assertV2Top20BookingDetailProbeEnvironment,
  buildV2Top20BookingDetailProbeEnvironment,
  executeV2Top20BookingDetailRecoveryProbe,
  parseBookingDetailProbeResult
} = require("./collection_worker_v2_top20_collector.cjs");
const { installFixtureNetworkGuard } = require("./fixture_network_guard.cjs");

const ROOT = path.resolve(__dirname, "..");
const NETWORK_PRELOAD = path.join(__dirname, "fixture_network_guard_preload.cjs");
const INVENTORY_PRELOAD = path.join(__dirname, "naver_legacy_inventory_fixture_preload.cjs");
const guard = installFixtureNetworkGuard({ label: "booking-detail recovery probe fixtures" });
const contract = Object.freeze({
  keyword: "Synthetic regional lodging",
  searchMode: "keyword",
  collectionMode: "precision",
  collectionPurpose: "revenue_detail",
  productMode: "all",
  checkIn: "2026-08-23",
  checkOut: "2026-08-23",
  bookingRangeDays: 1,
  rankStart: 1,
  rankEnd: 50,
  detailRankStart: 1,
  detailRankEnd: 20
});

function target() {
  const raw = {
    placeId: "1001",
    historicalBookingBusinessId: "2001",
    sourceRunId: "synthetic-verified-run",
    verifiedAt: "2026-08-20T00:00:00.000Z",
    knownBookingItems: true,
    knownDailySchedule: true
  };
  return Object.freeze({
    ...raw,
    targetIdentityHash: crypto.createHash("sha256").update(JSON.stringify({
      historicalBookingBusinessId: raw.historicalBookingBusinessId,
      knownDailySchedule: true,
      knownBookingItems: true,
      placeId: raw.placeId,
      sourceRunId: raw.sourceRunId,
      verifiedAt: raw.verifiedAt
    })).digest("hex")
  });
}

function environment(root, auditFile, mode) {
  return {
    NODE_ENV: "test",
    NODE_OPTIONS: [NETWORK_PRELOAD, INVENTORY_PRELOAD].map((file) => `--require=${file}`).join(" "),
    NAVER_INVENTORY_FIXTURE_ROOT: root,
    NAVER_INVENTORY_FIXTURE_MODE: mode,
    NAVER_INVENTORY_FIXTURE_AUDIT_FILE: auditFile,
    SEARCH_INTENT: "",
    SEARCH_INTENT_CONFIDENCE: "0"
  };
}

async function readAudit(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function execute(root, mode) {
  const auditFile = path.join(root, `${mode}.json`);
  const calls = [];
  const result = await executeV2Top20BookingDetailRecoveryProbe({
    contract,
    target: target(),
    cwd: ROOT,
    tempBase: root,
    baseEnvironment: environment(root, auditFile, mode),
    heartbeat: async () => {},
    onProviderAuthorize: async (metadata) => calls.push({ phase: "authorize", ...metadata }),
    onProviderCall: async (metadata) => calls.push({ phase: "started", ...metadata }),
    maxRuntimeMs: 120_000
  });
  return { audit: await readAudit(auditFile), calls, result };
}

(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "booking-detail-probe-fixture-"));
  try {
    const probeEnvironment = buildV2Top20BookingDetailProbeEnvironment({
      contract,
      target: target(),
      outputRoot: path.join(root, "unused-output"),
      baseEnvironment: { NODE_ENV: "test", UNRELATED_ENV_SENTINEL: "must-not-pass" }
    });
    assertV2Top20BookingDetailProbeEnvironment(probeEnvironment);
    assert.equal(probeEnvironment.NAVER_COLLECTOR_SCOPE, "booking_detail_recovery");
    assert.equal(probeEnvironment.NAVER_PROVIDER_CALL_BUDGET, "0");
    assert.equal(probeEnvironment.NAVER_INVENTORY_CALL_BUDGET, "3");
    assert.equal(probeEnvironment.NAVER_TOTAL_CALL_BUDGET, "3");
    assert.equal(probeEnvironment.NAVER_BOOKING_ID_FALLBACK, "0");
    assert.equal(probeEnvironment.NAVER_COUPON_PAGE_FALLBACK, "0");
    assert.equal(probeEnvironment.NAVER_DETAIL_LIVE_CALLS_ALLOWED, "1");
    assert.equal(Object.hasOwn(probeEnvironment, "UNRELATED_ENV_SENTINEL"), false);
    assert.throws(
      () => assertV2Top20BookingDetailProbeEnvironment({ ...probeEnvironment, NAVER_TOTAL_CALL_BUDGET: "4" }),
      (error) => error?.code === "BOOKING_DETAIL_PROBE_CONTRACT_INVALID"
    );
    assert.equal(parseBookingDetailProbeResult("BOOKING_DETAIL_RECOVERY_PROBE_RESULT={\"schemaVersion\":\"booking-detail-recovery-probe-result.v1\",\"status\":\"ready\",\"providerSubtype\":\"booking_detail_success\",\"businessValidated\":true,\"overnightItemValidated\":true,\"scheduleStatus\":\"zero\"}").scheduleStatus, "zero");

    const success = await execute(root, "success");
    assert.equal(success.result.status, "ready");
    assert.equal(success.result.providerCallCount, 3);
    assert.equal(success.result.scheduleStatus, "ready");
    assert.deepEqual(success.audit.operationCounts, { booking_business: 1, booking_items: 1, daily_schedule: 1 });
    assert.equal(success.audit.callCount, 3);
    assert.equal(success.audit.maxConcurrentCalls, 1);
    assert.deepEqual(success.calls.filter((call) => call.phase === "started").map((call) => call.operation), ["booking_business_graphql", "booking_items", "daily_schedule"]);
    assert.deepEqual(success.calls.filter((call) => call.phase === "started").map((call) => call.requestOrdinal), [1, 2, 3]);
    assert.equal(JSON.stringify(success.calls).match(/(?:placeId|businessId|url|query|body)/iu), null);

    const stale = await execute(root, "business_booking_omitted");
    assert.equal(stale.result.status, "target_stale");
    assert.equal(stale.result.providerCallCount, 1);
    assert.deepEqual(stale.audit.operationCounts, { booking_business: 1 });

    const blockedAudit = path.join(root, "blocked.json");
    await assert.rejects(
      () => executeV2Top20BookingDetailRecoveryProbe({
        contract,
        target: target(),
        cwd: ROOT,
        tempBase: root,
        baseEnvironment: environment(root, blockedAudit, "challenge_booking_items"),
        heartbeat: async () => {},
        onProviderCall: async () => {},
        maxRuntimeMs: 120_000
      }),
      (error) => error?.code === "NAVER_ACCESS_BLOCKED"
    );
    assert.deepEqual((await readAudit(blockedAudit)).operationCounts, { booking_business: 1, booking_items: 1 });
    assert.equal((await fs.readdir(root)).some((name) => name.startsWith("v2-top20-booking-detail-probe-")), false);
    assert.equal(guard.blockedAttempts(), 0);
    console.log("booking-detail recovery probe fixtures passed");
  } finally {
    guard.restore();
    await fs.rm(root, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
