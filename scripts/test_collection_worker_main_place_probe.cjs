"use strict";

const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const {
  buildV2Top20MainPlaceProbeEnvironment,
  parseMainPlaceProbeResult
} = require("./collection_worker_v2_top20_collector.cjs");
const { installFixtureNetworkGuard } = require("./fixture_network_guard.cjs");

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

try {
  const environment = buildV2Top20MainPlaceProbeEnvironment({
    contract,
    outputRoot: path.join(os.tmpdir(), "main-place-probe-fixture"),
    baseEnvironment: { NODE_ENV: "test", SECRET: "must-not-pass" }
  });
  assert.equal(environment.NAVER_MAIN_PLACE_RECOVERY_PROBE, "1");
  assert.equal(environment.NAVER_LEGACY_INVENTORY_ACTIVATION, "0");
  assert.equal(environment.NAVER_TOTAL_CALL_BUDGET, "1");
  assert.equal(environment.NAVER_AUTOMATIC_RETRY, "0");
  assert.equal(environment.NAVER_AUTOMATIC_FALLBACK, "0");
  assert.equal(Object.hasOwn(environment, "SECRET"), false);
  const valid = parseMainPlaceProbeResult("safe log\nMAIN_PLACE_RECOVERY_PROBE_RESULT={\"schemaVersion\":\"main-place-recovery-probe-result.v1\",\"organicCount\":50,\"observedRankCount\":50,\"adCount\":0,\"providerSubtype\":\"apollo_success\"}\n");
  assert.equal(valid.organicCount, 50);
  assert.throws(() => parseMainPlaceProbeResult("MAIN_PLACE_RECOVERY_PROBE_RESULT={}"), /invalid/i);
  assert.throws(() => parseMainPlaceProbeResult("MAIN_PLACE_RECOVERY_PROBE_RESULT={\"schemaVersion\":\"main-place-recovery-probe-result.v1\",\"organicCount\":50,\"observedRankCount\":50,\"adCount\":0,\"providerSubtype\":\"apollo_success\"}\nMAIN_PLACE_RECOVERY_PROBE_RESULT={\"schemaVersion\":\"main-place-recovery-probe-result.v1\",\"organicCount\":50,\"observedRankCount\":50,\"adCount\":0,\"providerSubtype\":\"apollo_success\"}"), /invalid/i);
  assert.equal(guard.blockedAttempts(), 0);
  console.log("main-place recovery probe fixtures passed");
} finally {
  guard.restore();
}
