"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const { EventEmitter } = require("node:events");
const os = require("node:os");
const path = require("node:path");
const {
  assertV2Top20MainPlaceProbeEnvironment,
  buildV2Top20MainPlaceProbeEnvironment,
  executeV2Top20MainPlaceRecoveryProbe,
  parseMainPlaceProbeResult
} = require("./collection_worker_v2_top20_collector.cjs");
const { installFixtureNetworkGuard } = require("./fixture_network_guard.cjs");

const ROOT = path.resolve(__dirname, "..");
const NETWORK_PRELOAD = path.join(__dirname, "fixture_network_guard_preload.cjs");
const INVENTORY_PRELOAD = path.join(__dirname, "naver_legacy_inventory_fixture_preload.cjs");
const guard = installFixtureNetworkGuard({ label: "main-place recovery probe fixtures" });
const contract = Object.freeze({
  keyword: "Synthetic regional lodging",
  searchMode: "keyword",
  collectionMode: "precision",
  collectionPurpose: "revenue_detail",
  productMode: "all",
  checkIn: "2026-08-18",
  checkOut: "2026-08-18",
  rankStart: 1,
  rankEnd: 50,
  detailRankStart: 1,
  detailRankEnd: 20
});

function childPreloadOptions() {
  return [NETWORK_PRELOAD, INVENTORY_PRELOAD]
    .map((filePath) => `--require=${filePath}`)
    .join(" ");
}

async function main() {
  const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "main-place-probe-child-fixture-"));
  try {
    const environment = buildV2Top20MainPlaceProbeEnvironment({
      contract,
      outputRoot: path.join(fixtureRoot, "unused-output"),
      baseEnvironment: { NODE_ENV: "test", SECRET: "must-not-pass" }
    });
    assert.equal(environment.NAVER_LEGACY_LIMITED_ACTIVATION, "1");
    assert.equal(environment.NAVER_COLLECTOR_STRATEGY, "legacy_candidate");
    assert.equal(environment.NAVER_COLLECTOR_SCOPE, "main_place_only");
    assert.equal(environment.NAVER_LIMITED_ACTIVATION_PROFILE, "preview-admin-keyword-fast-main-place.v1");
    assert.equal(environment.COLLECTION_MODE, "fast");
    assert.equal(environment.COLLECTION_PURPOSE, "basic_db");
    assert.equal(environment.DETAIL_RANK_RANGES, "");
    assert.equal(environment.NAVER_LEGACY_INVENTORY_ACTIVATION, "0");
    assert.equal(environment.V2_TOP20_WORKER_ACTIVATION, "0");
    assert.equal(environment.NAVER_MAIN_PLACE_RECOVERY_PROBE, "1");
    assert.equal(environment.NAVER_PROVIDER_CALL_BUDGET, "1");
    assert.equal(environment.NAVER_INVENTORY_CALL_BUDGET, "0");
    assert.equal(environment.NAVER_TOTAL_CALL_BUDGET, "1");
    assert.equal(environment.NAVER_BOOKING_ID_FALLBACK, "0");
    assert.equal(environment.NAVER_COUPON_PAGE_FALLBACK, "0");
    assert.equal(environment.NAVER_DETAIL_LIVE_CALLS_ALLOWED, "0");
    assert.equal(environment.NAVER_AUTOMATIC_RETRY, "0");
    assert.equal(environment.NAVER_AUTOMATIC_FALLBACK, "0");
    assert.equal(Object.hasOwn(environment, "SECRET"), false);
    assertV2Top20MainPlaceProbeEnvironment(environment);
    assert.throws(
      () => assertV2Top20MainPlaceProbeEnvironment({
        ...environment,
        NAVER_COLLECTOR_SCOPE: "main_place_top20_inventory_revenue",
        NAVER_LIMITED_ACTIVATION_PROFILE: "preview-v2-place-top20-inventory-revenue.v1"
      }),
      (error) => error?.code === "V2_TOP20_MAIN_PLACE_PROBE_CONTRACT_INVALID"
    );

    const valid = parseMainPlaceProbeResult("safe log\nMAIN_PLACE_RECOVERY_PROBE_RESULT={\"schemaVersion\":\"main-place-recovery-probe-result.v1\",\"organicCount\":50,\"observedRankCount\":50,\"adCount\":0,\"providerSubtype\":\"apollo_success\"}\n");
    assert.equal(valid.organicCount, 50);
    assert.throws(() => parseMainPlaceProbeResult("MAIN_PLACE_RECOVERY_PROBE_RESULT={}"), /invalid/i);

    await assert.rejects(
      executeV2Top20MainPlaceRecoveryProbe({
        contract,
        tempBase: fixtureRoot,
        heartbeat: async () => {},
        onProviderCall: async () => {},
        spawnImpl() {
          const child = new EventEmitter();
          child.stdout = new EventEmitter();
          child.stderr = new EventEmitter();
          child.kill = () => {};
          process.nextTick(() => child.emit("close", 1));
          return child;
        }
      }),
      (error) => {
        assert.notEqual(error?.name, "ReferenceError");
        return true;
      }
    );

    const auditFile = path.join(fixtureRoot, "provider-audit.json");
    let authorizeMessageCount = 0;
    let startedMessageCount = 0;
    const collected = await executeV2Top20MainPlaceRecoveryProbe({
      contract,
      cwd: ROOT,
      tempBase: fixtureRoot,
      baseEnvironment: {
        NODE_ENV: "test",
        NODE_OPTIONS: childPreloadOptions(),
        NAVER_INVENTORY_FIXTURE_ROOT: fixtureRoot,
        NAVER_INVENTORY_FIXTURE_MODE: "success",
        NAVER_INVENTORY_FIXTURE_AUDIT_FILE: auditFile,
        SEARCH_INTENT: "",
        SEARCH_INTENT_CONFIDENCE: "0"
      },
      heartbeat: async () => {},
      async onProviderAuthorize(metadata) {
        authorizeMessageCount += 1;
        assert.equal(metadata.operation, "main_place");
        assert.equal(metadata.requestOrdinal, 1);
      },
      async onProviderCall(metadata) {
        startedMessageCount += 1;
        assert.equal(metadata.operation, "main_place");
        assert.equal(metadata.requestOrdinal, 1);
      }
    });
    assert.equal(authorizeMessageCount, 1);
    assert.equal(startedMessageCount, 1);
    assert.equal(collected.providerCallCount, 1);
    assert.equal(collected.organicCount, 50);
    assert.equal(collected.observedRankCount, 50);
    assert.equal(collected.providerSubtype, "apollo_success");
    const audit = JSON.parse(await fs.readFile(auditFile, "utf8"));
    assert.equal(audit.callCount, 1);
    assert.equal(audit.operationCounts.main_place, 1);
    assert.equal(Object.keys(audit.operationCounts).some((operation) => operation.startsWith("booking_") || operation === "daily_schedule"), false);
    const entries = await fs.readdir(fixtureRoot);
    assert.equal(entries.some((entry) => entry.startsWith("v2-top20-main-place-probe-")), false);
    assert.equal(guard.blockedAttempts(), 0);
    console.log("main-place recovery probe fixtures passed");
  } finally {
    guard.restore();
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
