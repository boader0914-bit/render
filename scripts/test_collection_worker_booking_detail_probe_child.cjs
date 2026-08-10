"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { executeV2Top20BookingDetailRecoveryProbe } = require("./collection_worker_v2_top20_collector.cjs");
const { installFixtureNetworkGuard } = require("./fixture_network_guard.cjs");

const root = path.resolve(__dirname, "..");
const guard = installFixtureNetworkGuard({ label: "booking-detail probe actual child fixture" });
const contract = Object.freeze({
  keyword: "Synthetic regional lodging", searchMode: "keyword", collectionMode: "precision",
  collectionPurpose: "revenue_detail", productMode: "all", checkIn: "2026-08-23", checkOut: "2026-08-23",
  bookingRangeDays: 1, rankStart: 1, rankEnd: 50, detailRankStart: 1, detailRankEnd: 20
});

function target() {
  const value = { placeId: "1001", historicalBookingBusinessId: "2001", sourceRunId: "synthetic-run", verifiedAt: "2026-08-20T00:00:00.000Z", knownBookingItems: true, knownDailySchedule: true };
  return Object.freeze({
    ...value,
    targetIdentityHash: crypto.createHash("sha256").update(JSON.stringify({
      historicalBookingBusinessId: value.historicalBookingBusinessId, knownDailySchedule: true, knownBookingItems: true,
      placeId: value.placeId, sourceRunId: value.sourceRunId, verifiedAt: value.verifiedAt
    })).digest("hex")
  });
}

(async () => {
  const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "booking-detail-probe-child-"));
  try {
    const auditFile = path.join(fixtureRoot, "audit.json");
    const operations = [];
    const result = await executeV2Top20BookingDetailRecoveryProbe({
      contract,
      target: target(),
      cwd: root,
      tempBase: fixtureRoot,
      baseEnvironment: {
        NODE_ENV: "test",
        NODE_OPTIONS: ["fixture_network_guard_preload.cjs", "naver_legacy_inventory_fixture_preload.cjs"].map((file) => `--require=${path.join(__dirname, file)}`).join(" "),
        NAVER_INVENTORY_FIXTURE_ROOT: fixtureRoot,
        NAVER_INVENTORY_FIXTURE_MODE: "success",
        NAVER_INVENTORY_FIXTURE_AUDIT_FILE: auditFile,
        SEARCH_INTENT: "",
        SEARCH_INTENT_CONFIDENCE: "0"
      },
      heartbeat: async () => {},
      onProviderCall: async (metadata) => operations.push(metadata),
      maxRuntimeMs: 120_000
    });
    const audit = JSON.parse(await fs.readFile(auditFile, "utf8"));
    assert.equal(result.providerCallCount, 3);
    assert.deepEqual(operations.map((entry) => entry.operation), ["booking_business_graphql", "booking_items", "daily_schedule"]);
    assert.equal(operations.every((entry, index) => entry.requestOrdinal === index + 1), true);
    assert.equal(audit.callCount, 3);
    assert.equal(audit.maxConcurrentCalls, 1);
    assert.equal((await fs.readdir(fixtureRoot)).some((name) => name.startsWith("v2-top20-booking-detail-probe-")), false);
    assert.equal(guard.blockedAttempts(), 0);
    console.log("booking-detail probe child fixture passed");
  } finally {
    guard.restore();
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
