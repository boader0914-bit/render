const assert = require("node:assert/strict");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const {
  STATE_VERSION,
  DEFAULT_DAILY_CALL_BUDGET,
  CALLS_PER_WORK_ITEM,
  MAX_DISTINCT_DAY_ATTEMPTS,
  DEFAULT_CHECK_INTERVAL_MS,
  DEFAULT_STARTUP_DELAY_MS,
  SANCHEONG_LATEST_RECOVERY_ID,
  SANCHEONG_PUBLICATION_LAG_RECOVERY_ID,
  SANCHEONG_LATEST_RECOVERY_NORMALIZER_VERSION,
  kstDateKey,
  latestClosedYearMonth,
  eligibleRegions,
  initialWorkItems,
  createDemandStrengthBackfillScheduler
} = require("./tourism_demand_strength_backfill_scheduler.cjs");

const SANCHEONG = { regionKey: "kr_gyeongnam_sancheong", sidoKey: "gyeongnam", sigungu: "산청군", ktoSggCd: "48860" };
const NAMHAE = { regionKey: "kr_gyeongnam_namhae", sidoKey: "gyeongnam", sigungu: "남해군", ktoSggCd: "48840" };
const PENDING = { regionKey: "kr_pending", sidoKey: "pending", sigungu: "코드대기", ktoSggCd: "42000", codeStatus: "verify-before-api-call" };
const INVALID = { regionKey: "kr_invalid", sidoKey: "gyeongnam", sigungu: "잘못된코드", ktoSggCd: "48" };
const PROVINCE_ALIASES = {
  gyeongnam: { ktoSidoCd: "48" },
  pending: { ktoSidoCd: "42" }
};

function snapshot(input = {}, complete = false, reason = "monthly_cache_missing", operationCalls = 0) {
  const yearMonth = String(input.yearMonth || "");
  return {
    ok: complete,
    status: complete ? "ok" : "unavailable",
    reason: complete ? "" : reason,
    yearMonth,
    region: { regionKey: input.regionKey || "", sigungu: "" },
    stay: { status: complete ? "ok" : "unavailable", reason: complete ? "" : reason, overallValue: complete ? 1 : null },
    spend: { status: complete ? "ok" : "unavailable", reason: complete ? "" : reason, overallValue: complete ? 1 : null },
    collection: {
      mode: input.cacheOnly ? "cache_only" : "collect",
      operationCallsAttempted: Number(operationCalls || 0)
    },
    cache: { hit: Boolean(input.cacheOnly && complete) }
  };
}

function fakeCollector({
  regions = [SANCHEONG],
  cachedKeys = [],
  networkResult,
  regionMapVersion = "fixture-region-map-v1",
  adapter = "fixture-demand-strength-v1",
  normalizerVersion = "fixture-normalizer-v1"
} = {}) {
  const cache = new Set(cachedKeys);
  const inspections = [];
  const network = [];
  const calls = { status: 0, readRegionMap: 0 };
  return {
    cache,
    inspections,
    network,
    calls,
    status: async () => {
      calls.status += 1;
      return {
        sources: [{
          key: "demandStrength",
          status: "ready",
          adapter,
          normalizerVersion,
          serviceKeyConfigured: true,
          endpointConfigured: true
        }]
      };
    },
    readRegionMap: async () => {
      calls.readRegionMap += 1;
      return { version: regionMapVersion, regions, provinceAliases: PROVINCE_ALIASES };
    },
    collectDemandStrength: async (input) => {
      const key = `${input.regionKey}__${input.yearMonth}`;
      if (input.cacheOnly) {
        inspections.push({ key, input: { ...input } });
        return snapshot(input, cache.has(key), "monthly_cache_missing", 0);
      }
      network.push({ key, input: { ...input } });
      const result = typeof networkResult === "function"
        ? await networkResult({ key, input, attempt: network.filter((entry) => entry.key === key).length })
        : { complete: true };
      if (result?.throwError) throw new Error(result.throwError);
      if (result?.complete !== false) cache.add(key);
      return snapshot(
        input,
        result?.complete !== false,
        result?.reason || "fixture_partial",
        result?.operationCallsAttempted ?? 2
      );
    }
  };
}

function cachedInitialKeys(regions, targetYearMonth = "202607") {
  return initialWorkItems(regions, targetYearMonth).map((item) => item.key);
}

async function main() {
  const fixedNow = new Date("2026-08-29T01:00:00.000Z");
  assert.equal(kstDateKey(fixedNow), "2026-08-29");
  assert.equal(latestClosedYearMonth(fixedNow), "202607");
  assert.equal(DEFAULT_DAILY_CALL_BUDGET, 800);
  assert.equal(CALLS_PER_WORK_ITEM, 2);
  assert.equal(MAX_DISTINCT_DAY_ATTEMPTS, 3);
  assert.equal(DEFAULT_STARTUP_DELAY_MS, 120_000);
  assert.equal(DEFAULT_CHECK_INTERVAL_MS, 6 * 60 * 60 * 1000);

  assert.deepEqual(
    eligibleRegions({ regions: [NAMHAE, PENDING, INVALID, SANCHEONG, NAMHAE], provinceAliases: PROVINCE_ALIASES }).map((region) => region.regionKey),
    [SANCHEONG.regionKey, NAMHAE.regionKey]
  );
  const ordered = initialWorkItems([SANCHEONG, NAMHAE], "202607");
  assert.equal(ordered.length, 72);
  assert.equal(new Set(ordered.map((item) => item.key)).size, ordered.length);
  assert.deepEqual(
    ordered.slice(0, 4).map((item) => item.key),
    [
      "kr_gyeongnam_sancheong__202607",
      "kr_gyeongnam_sancheong__202606",
      "kr_gyeongnam_sancheong__202605",
      "kr_gyeongnam_sancheong__202604"
    ]
  );
  assert.equal(ordered[35].key, "kr_gyeongnam_sancheong__202308");
  assert.equal(ordered[36].key, "kr_gyeongnam_namhae__202607");
  assert.equal(ordered[37].key, "kr_gyeongnam_namhae__202606");

  const fixture198 = [SANCHEONG, ...Array.from({ length: 197 }, (_, index) => ({
    regionKey: `kr_fixture_${String(index + 1).padStart(3, "0")}`,
    sidoKey: "gyeongnam",
    sigungu: `검증군${index + 1}`,
    ktoSggCd: String(10000 + index)
  }))];
  const fixture198Items = initialWorkItems(eligibleRegions({ regions: fixture198, provinceAliases: PROVINCE_ALIASES }), "202607");
  assert.equal(fixture198Items.length, 198 * 36);
  assert.equal(fixture198Items.length, 7_128);
  assert.equal(new Set(fixture198Items.map((item) => item.key)).size, fixture198Items.length);

  const productionRegionMap = JSON.parse(await fsp.readFile(
    path.join(__dirname, "..", "web", "data", "tourism_region_map.json"),
    "utf8"
  ));
  const productionEligibleRegions = eligibleRegions(productionRegionMap);
  const productionInitialItems = initialWorkItems(productionEligibleRegions, "202607");
  assert.equal(productionEligibleRegions.length, 198);
  assert.equal(productionInitialItems.length, 7_128);
  assert.equal(new Set(productionInitialItems.map((item) => item.key)).size, productionInitialItems.length);

  const temporaryRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "tourism-demand-backfill-"));
  try {
    const budgetStateFile = path.join(temporaryRoot, "budget", "state.json");
    const budgetCollector = fakeCollector({ regions: [NAMHAE, PENDING, SANCHEONG] });
    let budgetNow = new Date(fixedNow);
    const firstScheduler = createDemandStrengthBackfillScheduler({
      collector: budgetCollector,
      stateFile: budgetStateFile,
      now: () => budgetNow,
      dailyCallBudget: 8
    });
    const budgetRun = await firstScheduler.runOnce({ trigger: "test" });
    assert.equal(budgetRun.status, "budget_exhausted");
    assert.deepEqual(
      budgetCollector.network.map((entry) => entry.key),
      [
        "kr_gyeongnam_sancheong__202607",
        "kr_gyeongnam_sancheong__202606",
        "kr_gyeongnam_sancheong__202605",
        "kr_gyeongnam_sancheong__202604"
      ]
    );
    assert.ok(budgetCollector.network.every((entry) => entry.input.force === false));
    assert.ok(budgetCollector.network.every((entry) => entry.input.maxPagesPerOperation === 1));
    const budgetState = JSON.parse(await fsp.readFile(budgetStateFile, "utf8"));
    assert.equal(budgetState.version, STATE_VERSION);
    assert.equal(budgetState.dailyBudget.usedCalls, 8);
    assert.equal(budgetState.dailyBudget.reservedCalls, 0);
    assert.equal(budgetState.dailyBudget.reservedWorkItems, 0);
    assert.equal(budgetState.plan.cursor, 4);
    assert.equal(budgetState.plan.totalItems, 72);
    assert.equal(JSON.parse(await fsp.readFile(`${budgetStateFile}.bak`, "utf8")).version, STATE_VERSION);
    assert.equal((await firstScheduler.runOnce({ trigger: "same-day" })).status, "budget_exhausted");
    assert.equal(budgetCollector.network.length, 4, "같은 날 예산을 초과해 외부 호출하면 안 됩니다.");

    const recoveryState = (overrides = {}) => ({
      version: STATE_VERSION,
      phase: "initial_backfill",
      initialTargetYearMonth: "202607",
      initialCompletedAt: "",
      monthlyCompletedThrough: "",
      eligibleRegionCount: 1,
      planFingerprint: {
        regionMapVersion: "fixture-region-map-v1",
        demandStrengthAdapter: "fixture-demand-strength-v1",
        demandStrengthNormalizer: "demand-strength-row-normalizer-v2"
      },
      plan: null,
      failures: {},
      terminalMissing: {},
      dailyBudget: {
        kstDate: "2026-08-29",
        limitCalls: 800,
        usedCalls: 800,
        reservedCalls: 0,
        reservedWorkItems: 0
      },
      ...overrides
    });
    const recoveryMissingKeys = new Set([
      `${SANCHEONG.regionKey}__202607`,
      `${SANCHEONG.regionKey}__202606`
    ]);
    const recoveryCachedKeys = cachedInitialKeys([SANCHEONG])
      .filter((key) => !recoveryMissingKeys.has(key));
    const recoveryStateFile = path.join(temporaryRoot, "recovery", "state.json");
    await fsp.mkdir(path.dirname(recoveryStateFile), { recursive: true });
    await fsp.writeFile(recoveryStateFile, JSON.stringify(recoveryState()), "utf8");
    const recoveryCollector = fakeCollector({
      regions: [SANCHEONG],
      cachedKeys: recoveryCachedKeys,
      normalizerVersion: SANCHEONG_LATEST_RECOVERY_NORMALIZER_VERSION
    });
    const recoveryScheduler = createDemandStrengthBackfillScheduler({
      collector: recoveryCollector,
      stateFile: recoveryStateFile,
      now: () => fixedNow,
      dailyCallBudget: 800
    });
    const recoveryRun = await recoveryScheduler.runOnce({ trigger: "authorized-latest-recovery" });
    assert.equal(recoveryRun.status, "budget_exhausted");
    assert.deepEqual(recoveryCollector.network.map((entry) => entry.key), [
      `${SANCHEONG.regionKey}__202607`
    ]);
    assert.ok(recoveryCollector.network.every((entry) => entry.input.force === false));
    assert.deepEqual(recoveryCollector.inspections.slice(0, 2).map((entry) => entry.key), [
      `${SANCHEONG.regionKey}__202607`,
      `${SANCHEONG.regionKey}__202606`
    ]);
    assert.equal(recoveryRun.progress.networkAttemptedItems, 1);
    assert.equal(recoveryRun.progress.networkCompletedItems, 1);
    assert.equal(recoveryRun.todayUsedCalls, 800);
    assert.equal(recoveryRun.recoveryStatus, "succeeded");
    assert.equal(recoveryRun.recoveryCallsUsed, 2);
    assert.equal(recoveryRun.recoveryCallAllowance, 2);
    assert.equal(recoveryRun.recoveryRegionKey, SANCHEONG.regionKey);
    assert.equal(recoveryRun.recoveryYearMonth, "202607");
    const persistedRecovery = JSON.parse(await fsp.readFile(recoveryStateFile, "utf8"));
    assert.equal(persistedRecovery.dailyBudget.usedCalls, 800);
    assert.equal(persistedRecovery.dailyBudget.reservedCalls, 0);
    assert.equal(persistedRecovery.dailyBudget.reservedWorkItems, 0);
    assert.equal(persistedRecovery.plan.cursor, 1);
    assert.equal(persistedRecovery.recoveryPermit.id, SANCHEONG_LATEST_RECOVERY_ID);
    assert.equal(persistedRecovery.recoveryPermit.status, "succeeded");
    assert.equal(persistedRecovery.recoveryPermit.usedCalls, 2);
    assert.equal((await recoveryScheduler.runOnce({ trigger: "same-day-recovery-reuse" })).status, "budget_exhausted");
    assert.equal(recoveryCollector.network.length, 1, "복구 허가는 같은 날 다시 사용할 수 없습니다.");
    const restartedRecoveryScheduler = createDemandStrengthBackfillScheduler({
      collector: recoveryCollector,
      stateFile: recoveryStateFile,
      now: () => fixedNow,
      dailyCallBudget: 800
    });
    assert.equal((await restartedRecoveryScheduler.runOnce({ trigger: "restart-recovery-reuse" })).status, "budget_exhausted");
    assert.equal(recoveryCollector.network.length, 1, "재시작 후에도 복구 허가를 다시 사용할 수 없습니다.");
    const recoveryClaimFile = `${recoveryStateFile}.${SANCHEONG_LATEST_RECOVERY_ID}.claimed`;
    assert.ok((await fsp.stat(recoveryClaimFile)).isFile());
    recoveryCollector.cache.delete(`${SANCHEONG.regionKey}__202607`);
    await fsp.writeFile(recoveryStateFile, JSON.stringify(recoveryState()), "utf8");
    const rollbackRecoveryScheduler = createDemandStrengthBackfillScheduler({
      collector: recoveryCollector,
      stateFile: recoveryStateFile,
      now: () => fixedNow,
      dailyCallBudget: 800
    });
    assert.equal((await rollbackRecoveryScheduler.runOnce({ trigger: "rollback-recovery-reuse" })).status, "budget_exhausted");
    assert.equal(recoveryCollector.network.length, 1, "이전 상태 복원 뒤에도 claim이 복구 호출 재사용을 막아야 합니다.");
    assert.equal((await rollbackRecoveryScheduler.status()).recoveryStatus, "consumed");

    const recoveryCacheSatisfiedStateFile = path.join(temporaryRoot, "recovery-cache", "state.json");
    await fsp.mkdir(path.dirname(recoveryCacheSatisfiedStateFile), { recursive: true });
    await fsp.writeFile(
      recoveryCacheSatisfiedStateFile,
      JSON.stringify(recoveryState()),
      "utf8"
    );
    const recoveryCacheCollector = fakeCollector({
      regions: [SANCHEONG],
      cachedKeys: cachedInitialKeys([SANCHEONG]).filter((key) => !key.endsWith("__202606")),
      normalizerVersion: SANCHEONG_LATEST_RECOVERY_NORMALIZER_VERSION
    });
    const recoveryCacheScheduler = createDemandStrengthBackfillScheduler({
      collector: recoveryCacheCollector,
      stateFile: recoveryCacheSatisfiedStateFile,
      now: () => fixedNow,
      dailyCallBudget: 800
    });
    const recoveryCacheRun = await recoveryCacheScheduler.runOnce({ trigger: "recovery-cache-satisfied" });
    assert.equal(recoveryCacheRun.status, "budget_exhausted");
    assert.equal(recoveryCacheCollector.network.length, 0, "정상 최신 캐시는 복구 호출로 다시 수집하면 안 됩니다.");
    assert.equal(recoveryCacheRun.recoveryStatus, "satisfied_from_cache");
    assert.equal(recoveryCacheRun.recoveryCallsUsed, 0);

    for (const budgetCase of [
      { name: "recovery-799", limitCalls: 800, usedCalls: 799 },
      { name: "recovery-custom-limit", limitCalls: 400, usedCalls: 400 }
    ]) {
      const guardedStateFile = path.join(temporaryRoot, budgetCase.name, "state.json");
      await fsp.mkdir(path.dirname(guardedStateFile), { recursive: true });
      await fsp.writeFile(guardedStateFile, JSON.stringify(recoveryState({
        dailyBudget: {
          kstDate: "2026-08-29",
          limitCalls: budgetCase.limitCalls,
          usedCalls: budgetCase.usedCalls,
          reservedCalls: 0,
          reservedWorkItems: 0
        }
      })), "utf8");
      const guardedCollector = fakeCollector({
        regions: [SANCHEONG],
        cachedKeys: recoveryCachedKeys,
        normalizerVersion: SANCHEONG_LATEST_RECOVERY_NORMALIZER_VERSION
      });
      const guardedScheduler = createDemandStrengthBackfillScheduler({
        collector: guardedCollector,
        stateFile: guardedStateFile,
        now: () => fixedNow,
        dailyCallBudget: budgetCase.limitCalls
      });
      const guardedRun = await guardedScheduler.runOnce({ trigger: budgetCase.name });
      assert.equal(guardedRun.status, "budget_exhausted");
      assert.equal(guardedCollector.network.length, 0, `${budgetCase.name}에서는 복구 예외를 사용하면 안 됩니다.`);
      assert.equal(guardedRun.recoveryStatus, "available");
      await assert.rejects(fsp.stat(`${guardedStateFile}.${SANCHEONG_LATEST_RECOVERY_ID}.claimed`), { code: "ENOENT" });
    }

    const recoveryFailureStateFile = path.join(temporaryRoot, "recovery-failure", "state.json");
    await fsp.mkdir(path.dirname(recoveryFailureStateFile), { recursive: true });
    await fsp.writeFile(
      recoveryFailureStateFile,
      JSON.stringify(recoveryState()),
      "utf8"
    );
    const recoveryFailureCollector = fakeCollector({
      regions: [SANCHEONG],
      cachedKeys: recoveryCachedKeys,
      normalizerVersion: SANCHEONG_LATEST_RECOVERY_NORMALIZER_VERSION,
      networkResult: () => ({ complete: false, reason: "fixture_partial", operationCallsAttempted: 2 })
    });
    const recoveryFailureScheduler = createDemandStrengthBackfillScheduler({
      collector: recoveryFailureCollector,
      stateFile: recoveryFailureStateFile,
      now: () => fixedNow,
      dailyCallBudget: 800
    });
    const recoveryFailureRun = await recoveryFailureScheduler.runOnce({ trigger: "recovery-failure" });
    assert.equal(recoveryFailureRun.status, "budget_exhausted");
    assert.equal(recoveryFailureRun.recoveryStatus, "consumed");
    assert.equal(recoveryFailureRun.recoveryOutcome, "incomplete");
    assert.equal(recoveryFailureRun.recoveryReason, "fixture_partial");
    assert.equal(recoveryFailureRun.recoveryReportedActualCalls, 2);
    assert.equal(recoveryFailureRun.activeFailureCount, 1);
    assert.equal(recoveryFailureRun.latestFailureRegionKey, SANCHEONG.regionKey);
    assert.equal(recoveryFailureRun.latestFailureYearMonth, "202607");
    assert.equal(recoveryFailureRun.latestFailureReason, "fixture_partial");
    assert.equal(recoveryFailureCollector.network.length, 1);
    assert.equal(recoveryFailureCollector.cache.has(`${SANCHEONG.regionKey}__202607`), false);
    const missingAfterFailure = await recoveryFailureCollector.collectDemandStrength({
      regionKey: SANCHEONG.regionKey,
      yearMonth: "202607",
      cacheOnly: true
    });
    assert.equal(missingAfterFailure.stay.overallValue, null);
    assert.equal(missingAfterFailure.spend.overallValue, null);
    assert.equal((await recoveryFailureScheduler.runOnce({ trigger: "recovery-failure-reuse" })).status, "budget_exhausted");
    assert.equal(recoveryFailureCollector.network.length, 1, "실패한 복구 허가도 다시 사용할 수 없습니다.");

    const publicationLagStateFile = path.join(temporaryRoot, "publication-lag-recovery", "state.json");
    await fsp.mkdir(path.dirname(publicationLagStateFile), { recursive: true });
    await fsp.writeFile(publicationLagStateFile, JSON.stringify(recoveryState()), "utf8");
    const publicationLagCollector = fakeCollector({
      regions: [SANCHEONG],
      normalizerVersion: SANCHEONG_LATEST_RECOVERY_NORMALIZER_VERSION,
      networkResult: ({ key }) => key.endsWith("__202607")
        ? { complete: false, reason: "no_observation", operationCallsAttempted: 2 }
        : { complete: true, operationCallsAttempted: 2 }
    });
    const publicationLagScheduler = createDemandStrengthBackfillScheduler({
      collector: publicationLagCollector,
      stateFile: publicationLagStateFile,
      now: () => fixedNow,
      dailyCallBudget: 800
    });
    const publicationLagReady = await publicationLagScheduler.runOnce({ trigger: "latest-no-observation" });
    assert.equal(publicationLagReady.status, "budget_exhausted");
    assert.deepEqual(publicationLagCollector.network.map((entry) => entry.key), [
      `${SANCHEONG.regionKey}__202607`
    ]);
    const publicationLagReadyState = JSON.parse(await fsp.readFile(publicationLagStateFile, "utf8"));
    assert.equal(publicationLagReadyState.plan.cursor, 1);
    assert.equal(publicationLagReadyState.recoveryPermit.status, "consumed");
    assert.equal(publicationLagReadyState.recoveryPermit.reason, "no_observation");
    const publicationLagRun = await publicationLagScheduler.runOnce({ trigger: "publication-lag-recovery" });
    assert.equal(publicationLagRun.status, "budget_exhausted");
    assert.deepEqual(publicationLagCollector.network.map((entry) => entry.key), [
      `${SANCHEONG.regionKey}__202607`,
      `${SANCHEONG.regionKey}__202606`
    ]);
    assert.ok(publicationLagCollector.network.every((entry) => entry.input.force === false));
    assert.ok(publicationLagCollector.network.every((entry) => entry.input.maxPagesPerOperation === 1));
    assert.equal(publicationLagCollector.cache.has(`${SANCHEONG.regionKey}__202607`), false);
    assert.equal(publicationLagCollector.cache.has(`${SANCHEONG.regionKey}__202606`), true);
    assert.equal(publicationLagRun.todayUsedCalls, 800);
    assert.equal(publicationLagRun.recoveryStatus, "succeeded");
    assert.equal(publicationLagRun.recoveryCallsUsed, 4);
    assert.equal(publicationLagRun.recoveryCallAllowance, 4);
    assert.equal(publicationLagRun.recoveryYearMonth, "202606");
    assert.equal(publicationLagRun.activeFailureCount, 1);
    assert.equal(publicationLagRun.latestFailureYearMonth, "202607");
    assert.equal(publicationLagRun.latestFailureReason, "no_observation");
    const persistedPublicationLag = JSON.parse(await fsp.readFile(publicationLagStateFile, "utf8"));
    assert.equal(persistedPublicationLag.plan.cursor, 2);
    assert.equal(persistedPublicationLag.failures[`${SANCHEONG.regionKey}__202607`].reason, "no_observation");
    assert.equal(persistedPublicationLag.recoveryPermit.id, SANCHEONG_PUBLICATION_LAG_RECOVERY_ID);
    assert.equal(persistedPublicationLag.recoveryPermit.status, "succeeded");
    assert.equal(persistedPublicationLag.recoveryHistory.length, 1);
    assert.equal(persistedPublicationLag.recoveryHistory[0].id, SANCHEONG_LATEST_RECOVERY_ID);
    assert.equal(persistedPublicationLag.dailyBudget.usedCalls, 800);
    const publicationLagClaimFile = `${publicationLagStateFile}.${SANCHEONG_PUBLICATION_LAG_RECOVERY_ID}.claimed`;
    assert.ok((await fsp.stat(publicationLagClaimFile)).isFile());
    assert.equal((await publicationLagScheduler.runOnce({ trigger: "publication-lag-reuse" })).status, "budget_exhausted");
    assert.equal(publicationLagCollector.network.length, 2, "발행 지연 복구는 같은 상태에서 재사용하면 안 됩니다.");
    await fsp.writeFile(publicationLagStateFile, JSON.stringify(publicationLagReadyState), "utf8");
    const rollbackPublicationLagScheduler = createDemandStrengthBackfillScheduler({
      collector: publicationLagCollector,
      stateFile: publicationLagStateFile,
      now: () => fixedNow,
      dailyCallBudget: 800
    });
    assert.equal((await rollbackPublicationLagScheduler.runOnce({ trigger: "publication-lag-rollback" })).status, "budget_exhausted");
    assert.equal(publicationLagCollector.network.length, 2, "상태 롤백 뒤에도 발행 지연 복구를 재호출하면 안 됩니다.");

    const publicationLagMissingFile = path.join(temporaryRoot, "publication-lag-missing", "state.json");
    await fsp.mkdir(path.dirname(publicationLagMissingFile), { recursive: true });
    await fsp.writeFile(publicationLagMissingFile, JSON.stringify(publicationLagReadyState), "utf8");
    const publicationLagMissingCollector = fakeCollector({
      regions: [SANCHEONG],
      normalizerVersion: SANCHEONG_LATEST_RECOVERY_NORMALIZER_VERSION,
      networkResult: () => ({ complete: false, reason: "no_observation", operationCallsAttempted: 2 })
    });
    const publicationLagMissingScheduler = createDemandStrengthBackfillScheduler({
      collector: publicationLagMissingCollector,
      stateFile: publicationLagMissingFile,
      now: () => fixedNow,
      dailyCallBudget: 800
    });
    const publicationLagMissingRun = await publicationLagMissingScheduler.runOnce({ trigger: "publication-lag-missing" });
    assert.equal(publicationLagMissingRun.status, "budget_exhausted");
    assert.deepEqual(publicationLagMissingCollector.network.map((entry) => entry.key), [
      `${SANCHEONG.regionKey}__202606`
    ]);
    assert.equal(publicationLagMissingRun.recoveryStatus, "consumed");
    assert.equal(publicationLagMissingRun.recoveryReason, "no_observation");
    assert.equal(publicationLagMissingRun.activeFailureCount, 2);
    const missingJuneSnapshot = await publicationLagMissingCollector.collectDemandStrength({
      regionKey: SANCHEONG.regionKey,
      yearMonth: "202606",
      cacheOnly: true
    });
    assert.equal(missingJuneSnapshot.stay.overallValue, null);
    assert.equal(missingJuneSnapshot.spend.overallValue, null);
    await publicationLagMissingScheduler.runOnce({ trigger: "no-third-recovery" });
    assert.equal(publicationLagMissingCollector.network.length, 1, "6월도 미제공이면 세 번째 예외 호출을 만들면 안 됩니다.");

    const publicationLagCacheFile = path.join(temporaryRoot, "publication-lag-cache", "state.json");
    await fsp.mkdir(path.dirname(publicationLagCacheFile), { recursive: true });
    await fsp.writeFile(publicationLagCacheFile, JSON.stringify(publicationLagReadyState), "utf8");
    const publicationLagCacheCollector = fakeCollector({
      regions: [SANCHEONG],
      cachedKeys: [`${SANCHEONG.regionKey}__202606`],
      normalizerVersion: SANCHEONG_LATEST_RECOVERY_NORMALIZER_VERSION
    });
    const publicationLagCacheScheduler = createDemandStrengthBackfillScheduler({
      collector: publicationLagCacheCollector,
      stateFile: publicationLagCacheFile,
      now: () => fixedNow,
      dailyCallBudget: 800
    });
    const publicationLagCacheRun = await publicationLagCacheScheduler.runOnce({ trigger: "publication-lag-cache" });
    assert.equal(publicationLagCacheRun.status, "budget_exhausted");
    assert.equal(publicationLagCacheCollector.network.length, 0);
    assert.equal(publicationLagCacheRun.recoveryStatus, "satisfied_from_cache");
    assert.equal(publicationLagCacheRun.recoveryCallsUsed, 2);

    for (const guard of [
      { name: "wrong-reason", recoveryPermit: { ...publicationLagReadyState.recoveryPermit, reason: "fixture_partial" } },
      { name: "wrong-actual-calls", recoveryPermit: { ...publicationLagReadyState.recoveryPermit, reportedActualCalls: 1 } },
      { name: "wrong-status", recoveryPermit: { ...publicationLagReadyState.recoveryPermit, status: "succeeded", outcome: "complete", reason: "" } },
      { name: "wrong-cursor", plan: { ...publicationLagReadyState.plan, cursor: 0 } },
      {
        name: "wrong-failure-date",
        failures: {
          [`${SANCHEONG.regionKey}__202607`]: {
            ...publicationLagReadyState.failures[`${SANCHEONG.regionKey}__202607`],
            lastAttemptKstDate: "2026-08-28"
          }
        }
      },
      {
        name: "fingerprint-mismatch",
        planFingerprint: { ...publicationLagReadyState.planFingerprint, demandStrengthAdapter: "different-adapter" }
      },
      {
        name: "budget-not-exhausted",
        dailyBudget: { kstDate: "2026-08-29", limitCalls: 800, usedCalls: 799, reservedCalls: 0, reservedWorkItems: 0 }
      },
      {
        name: "custom-budget",
        dailyBudget: { kstDate: "2026-08-29", limitCalls: 400, usedCalls: 400, reservedCalls: 0, reservedWorkItems: 0 }
      }
    ]) {
      const guardedPublicationLagFile = path.join(temporaryRoot, `publication-lag-${guard.name}`, "state.json");
      await fsp.mkdir(path.dirname(guardedPublicationLagFile), { recursive: true });
      await fsp.writeFile(
        guardedPublicationLagFile,
        JSON.stringify({ ...structuredClone(publicationLagReadyState), ...guard }),
        "utf8"
      );
      const guardedPublicationLagCollector = fakeCollector({
        regions: [SANCHEONG],
        normalizerVersion: SANCHEONG_LATEST_RECOVERY_NORMALIZER_VERSION
      });
      const guardedPublicationLagScheduler = createDemandStrengthBackfillScheduler({
        collector: guardedPublicationLagCollector,
        stateFile: guardedPublicationLagFile,
        now: () => fixedNow,
        dailyCallBudget: guard.name === "custom-budget" ? 400 : 800
      });
      const guardedPublicationLagRun = await guardedPublicationLagScheduler.runOnce({ trigger: guard.name });
      assert.equal(guardedPublicationLagRun.status, "budget_exhausted");
      assert.equal(guardedPublicationLagCollector.network.length, 0, `${guard.name}에서는 발행 지연 복구를 허용하면 안 됩니다.`);
      await assert.rejects(
        fsp.stat(`${guardedPublicationLagFile}.${SANCHEONG_PUBLICATION_LAG_RECOVERY_ID}.claimed`),
        { code: "ENOENT" }
      );
    }

    budgetNow = new Date("2026-08-30T01:00:00.000Z");
    const resumedScheduler = createDemandStrengthBackfillScheduler({
      collector: budgetCollector,
      stateFile: budgetStateFile,
      now: () => budgetNow,
      dailyCallBudget: 2
    });
    const resumed = await resumedScheduler.runOnce({ trigger: "restart" });
    assert.equal(resumed.status, "budget_exhausted");
    assert.equal(budgetCollector.network.at(-1).key, "kr_gyeongnam_sancheong__202603");
    assert.equal(JSON.parse(await fsp.readFile(budgetStateFile, "utf8")).plan.cursor, 5);

    const monthlyStateFile = path.join(temporaryRoot, "monthly", "state.json");
    let monthlyNow = new Date(fixedNow);
    const monthlyCollector = fakeCollector({
      regions: [PENDING, SANCHEONG],
      cachedKeys: cachedInitialKeys([SANCHEONG])
    });
    const monthlyScheduler = createDemandStrengthBackfillScheduler({
      collector: monthlyCollector,
      stateFile: monthlyStateFile,
      now: () => monthlyNow
    });
    const initialComplete = await monthlyScheduler.runOnce({ trigger: "cache-reuse" });
    assert.equal(initialComplete.status, "initial_complete");
    assert.equal(monthlyCollector.network.length, 0);
    assert.equal(initialComplete.progress.cacheReusedItems, 36);
    assert.equal(initialComplete.phase, "complete");
    assert.equal(initialComplete.completedThrough, "202607");

    monthlyNow = new Date("2026-09-01T01:00:00.000Z");
    const supplemented = await monthlyScheduler.runOnce({ trigger: "monthly" });
    assert.equal(supplemented.status, "monthly_complete");
    assert.equal(monthlyCollector.network.at(-1).key, "kr_gyeongnam_sancheong__202608");
    assert.equal(supplemented.completedThrough, "202608");
    const upToDate = await monthlyScheduler.runOnce({ trigger: "monthly" });
    assert.equal(upToDate.status, "up_to_date");
    assert.equal(monthlyCollector.network.length, 1);

    const failureStateFile = path.join(temporaryRoot, "failure", "state.json");
    let failureNow = new Date(fixedNow);
    const failureCache = cachedInitialKeys([SANCHEONG]).filter((key) => !key.endsWith("__202607"));
    const failureCollector = fakeCollector({
      regions: [SANCHEONG],
      cachedKeys: failureCache,
      networkResult: ({ attempt }) => ({ complete: attempt > 1, reason: "fixture_partial" })
    });
    const failureScheduler = createDemandStrengthBackfillScheduler({
      collector: failureCollector,
      stateFile: failureStateFile,
      now: () => failureNow,
      dailyCallBudget: 10
    });
    const partial = await failureScheduler.runOnce({ trigger: "test" });
    assert.equal(partial.status, "partial");
    assert.equal(failureCollector.network.length, 1);
    assert.equal(partial.plan.retryOnly, true);
    assert.equal(Object.hasOwn(partial, "state"), false);
    assert.equal(JSON.stringify(partial).includes('"failures"'), false);
    const cooldown = await failureScheduler.runOnce({ trigger: "test" });
    assert.equal(cooldown.status, "cooldown");
    assert.equal(failureCollector.network.length, 1, "부분/실패 항목은 같은 날 다시 호출하면 안 됩니다.");
    failureNow = new Date("2026-08-30T01:00:00.000Z");
    const retrySuccess = await failureScheduler.runOnce({ trigger: "next-day" });
    assert.equal(retrySuccess.status, "initial_complete");
    assert.equal(failureCollector.network.length, 2);
    assert.ok(failureCollector.network.every((entry) => entry.input.force === false));

    const terminalStateFile = path.join(temporaryRoot, "terminal", "state.json");
    let terminalNow = new Date(fixedNow);
    const terminalCollector = fakeCollector({
      regions: [SANCHEONG],
      cachedKeys: failureCache,
      networkResult: () => ({ complete: false, reason: "fixture_no_observation", operationCallsAttempted: 2 })
    });
    const terminalScheduler = createDemandStrengthBackfillScheduler({
      collector: terminalCollector,
      stateFile: terminalStateFile,
      now: () => terminalNow,
      dailyCallBudget: 2
    });
    assert.equal((await terminalScheduler.runOnce({ trigger: "terminal-day-1" })).status, "partial");
    terminalNow = new Date("2026-08-30T01:00:00.000Z");
    assert.equal((await terminalScheduler.runOnce({ trigger: "terminal-day-2" })).status, "partial");
    terminalNow = new Date("2026-08-31T01:00:00.000Z");
    const terminalComplete = await terminalScheduler.runOnce({ trigger: "terminal-day-3" });
    assert.equal(terminalComplete.status, "initial_complete");
    assert.equal(terminalComplete.terminalMissingPairCount, 1);
    assert.equal(terminalCollector.network.length, 3);
    const terminalState = JSON.parse(await fsp.readFile(terminalStateFile, "utf8"));
    assert.deepEqual(
      terminalState.terminalMissing[`${SANCHEONG.regionKey}__202607`],
      {
        reason: "fixture_no_observation",
        attempts: 3,
        lastAt: terminalNow.toISOString()
      }
    );
    assert.equal((await terminalScheduler.runOnce({ trigger: "terminal-no-retry" })).status, "up_to_date");
    assert.equal(terminalCollector.network.length, 3, "terminalMissing 항목을 자동으로 무한 재호출하면 안 됩니다.");
    const terminalPublicStatus = await terminalScheduler.status();
    assert.equal(terminalPublicStatus.terminalMissingPairCount, 1);
    assert.equal(JSON.stringify(terminalPublicStatus).includes("fixture_no_observation"), false);
    terminalNow = new Date("2026-09-01T01:00:00.000Z");
    const terminalManual = await terminalScheduler.beginManualReservation({ months: 1, maxPagesPerOperation: 1 });
    const terminalManualFinish = await terminalScheduler.finishManualReservation({
      reservationId: terminalManual.reservationId,
      actualCalls: 2,
      completedPairs: [{ regionKey: SANCHEONG.regionKey, yearMonth: "202607" }]
    });
    assert.equal(terminalManualFinish.clearedTerminalMissingPairCount, 1);
    assert.equal(terminalManualFinish.terminalMissingPairCount, 0);

    let scheduledDelay = null;
    let clearedTimer = null;
    const timerHandle = { unref() {} };
    const timerScheduler = createDemandStrengthBackfillScheduler({
      collector: fakeCollector({ regions: [SANCHEONG] }),
      stateFile: path.join(temporaryRoot, "timer", "state.json"),
      now: () => fixedNow,
      setTimeoutFn: (_callback, delay) => {
        scheduledDelay = delay;
        return timerHandle;
      },
      clearTimeoutFn: (handle) => {
        clearedTimer = handle;
      }
    });
    const started = timerScheduler.start();
    assert.equal(scheduledDelay, 120_000);
    assert.ok(started.nextCheckAt);
    timerScheduler.stop();
    assert.equal(clearedTimer, timerHandle);
    const schedulerStatus = await timerScheduler.status();
    assert.equal(schedulerStatus.policy.callsPerRegionMonth, 2);
    assert.equal(schedulerStatus.policy.cacheInspectedBeforeBudgetReservation, true);
    assert.equal(schedulerStatus.budget.limitCalls, 800);
    assert.equal(schedulerStatus.source.adapter, "fixture-demand-strength-v1");
    assert.equal(schedulerStatus.phase, "priority_sancheong");
    assert.equal(schedulerStatus.eligibleRegionCount, 1);
    assert.equal(schedulerStatus.completedPairCount, 0);
    assert.equal(schedulerStatus.totalPairCount, 36);
    assert.equal(schedulerStatus.todayUsedCalls, 0);
    assert.equal(schedulerStatus.dailyCallBudget, 800);
    assert.equal(schedulerStatus.nextCheckAt, "");
    assert.equal(schedulerStatus.lastResultStatus, "");
    assert.equal(schedulerStatus.lastReason, "");
    assert.equal(schedulerStatus.running, false);
    assert.equal(Object.hasOwn(schedulerStatus, "stateFile"), false);
    assert.equal(Object.hasOwn(schedulerStatus, "state"), false);

    const projectionStateFile = path.join(temporaryRoot, "projection", "state.json");
    const projectionCollector = fakeCollector({ regions: fixture198 });
    const projectionScheduler = createDemandStrengthBackfillScheduler({
      collector: projectionCollector,
      stateFile: projectionStateFile,
      now: () => fixedNow
    });
    const projectionState = (cursor, patch = {}) => ({
      version: STATE_VERSION,
      phase: "initial_backfill",
      initialTargetYearMonth: "202607",
      eligibleRegionCount: 198,
      plan: {
        id: "projection-fixture",
        kind: "initial_backfill",
        startYearMonth: "202308",
        endYearMonth: "202607",
        cursor,
        totalItems: 7_128,
        retryOnly: false,
        pass: 1
      },
      failures: {},
      dailyBudget: {
        kstDate: "2026-08-29",
        limitCalls: 800,
        usedCalls: 5,
        reservedCalls: 2,
        reservedWorkItems: 1
      },
      ...patch
    });
    await fsp.mkdir(path.dirname(projectionStateFile), { recursive: true });
    await fsp.writeFile(projectionStateFile, JSON.stringify(projectionState(35)), "utf8");
    let projected = await projectionScheduler.status();
    assert.equal(projected.phase, "priority_sancheong");
    assert.equal(projected.todayUsedCalls, 7);
    assert.equal(projected.completedPairCount, 35);
    await fsp.writeFile(projectionStateFile, JSON.stringify(projectionState(36)), "utf8");
    projected = await projectionScheduler.status();
    assert.equal(projected.phase, "recent_12");
    const historyBoundary = 36 + (197 * 12);
    await fsp.writeFile(projectionStateFile, JSON.stringify(projectionState(historyBoundary - 1)), "utf8");
    assert.equal((await projectionScheduler.status()).phase, "recent_12");
    await fsp.writeFile(projectionStateFile, JSON.stringify(projectionState(historyBoundary)), "utf8");
    assert.equal((await projectionScheduler.status()).phase, "history_24");
    await fsp.writeFile(projectionStateFile, JSON.stringify(projectionState(7_128, {
      phase: "monthly_maintenance",
      initialCompletedAt: fixedNow.toISOString(),
      plan: {
        id: "monthly-fixture",
        kind: "monthly_maintenance",
        startYearMonth: "202608",
        endYearMonth: "202608",
        cursor: 17,
        totalItems: 198,
        retryOnly: false,
        pass: 1
      }
    })), "utf8");
    assert.equal((await projectionScheduler.status()).phase, "monthly");
    await fsp.writeFile(projectionStateFile, JSON.stringify(projectionState(7_128, {
      phase: "monthly_maintenance",
      initialCompletedAt: fixedNow.toISOString(),
      monthlyCompletedThrough: "202607",
      plan: null
    })), "utf8");
    projected = await projectionScheduler.status();
    assert.equal(projected.phase, "complete");
    assert.equal(projected.completedPairCount, 7_128);
    assert.equal(projected.totalPairCount, 7_128);

    const manualStateFile = path.join(temporaryRoot, "manual", "state.json");
    let manualNow = new Date(fixedNow);
    const manualCollector = fakeCollector({ regions: [SANCHEONG] });
    const manualScheduler = createDemandStrengthBackfillScheduler({
      collector: manualCollector,
      stateFile: manualStateFile,
      now: () => manualNow
    });
    const manualReservation = await manualScheduler.beginManualReservation({ months: 36, maxPagesPerOperation: 1 });
    assert.equal(manualReservation.status, "manual_reserved");
    assert.equal(manualReservation.requestedCalls, 72);
    assert.equal(manualReservation.todayUsedCalls, 72);
    assert.equal(manualReservation.budget.usedCalls, 0);
    assert.equal(manualReservation.budget.reservedCalls, 72);
    assert.equal(
      JSON.parse(await fsp.readFile(`${manualStateFile}.bak`, "utf8")).manualReservation.id,
      manualReservation.reservationId
    );
    const manualStatus = await manualScheduler.status();
    assert.equal(manualStatus.manualActive, true);
    assert.equal(manualStatus.todayUsedCalls, 72);
    assert.equal(JSON.stringify(manualStatus).includes(manualReservation.reservationId), false);
    assert.equal(Object.hasOwn(manualStatus, "stateFile"), false);
    assert.throws(
      () => manualScheduler.start(),
      (error) => error?.statusCode === 409 && error?.code === "tourism_demand_strength_manual_active"
    );
    assert.throws(
      () => manualScheduler.runOnce({ trigger: "manual-conflict" }),
      (error) => error?.statusCode === 409 && error?.code === "tourism_demand_strength_manual_active"
    );
    await assert.rejects(
      () => manualScheduler.beginManualReservation({ requestedCalls: 2 }),
      (error) => error?.statusCode === 409 && error?.code === "tourism_demand_strength_manual_active"
    );
    const restartedManualScheduler = createDemandStrengthBackfillScheduler({
      collector: manualCollector,
      stateFile: manualStateFile,
      now: () => manualNow
    });
    await assert.rejects(
      restartedManualScheduler.runOnce({ trigger: "manual-persisted-conflict" }),
      (error) => error?.statusCode === 409 && error?.code === "tourism_demand_strength_manual_active"
    );
    await assert.rejects(
      () => manualScheduler.finishManualReservation({ reservationId: "wrong-token", actualCalls: 1 }),
      (error) => error?.statusCode === 409 && error?.code === "tourism_demand_strength_manual_reservation_not_found"
    );
    const manualSettled = await manualScheduler.finishManualReservation({
      reservationId: manualReservation.reservationId,
      actualCalls: 70
    });
    assert.equal(manualSettled.status, "manual_settled");
    assert.equal(manualSettled.todayUsedCalls, 70);
    assert.equal(manualSettled.budget.reservedCalls, 0);
    await assert.rejects(
      () => manualScheduler.beginManualReservation({ requestedCalls: 732 }),
      (error) => error?.statusCode === 429 && error?.code === "tourism_demand_strength_daily_quota_exceeded"
    );
    await assert.rejects(
      () => manualScheduler.beginManualReservation({ requestedCalls: 3 }),
      (error) => error?.statusCode === 400 && error?.code === "tourism_demand_strength_manual_requested_calls_invalid"
    );
    const failedManual = await manualScheduler.beginManualReservation({ months: 1 });
    const failedManualSettled = await manualScheduler.finishManualReservation({
      reservationId: failedManual.reservationId,
      failed: true
    });
    assert.equal(failedManualSettled.status, "manual_failed_settled");
    assert.equal(failedManualSettled.actualCalls, 2);
    assert.equal(failedManualSettled.todayUsedCalls, 72);

    const crossDayStateFile = path.join(temporaryRoot, "manual-cross-day", "state.json");
    let crossDayNow = new Date("2026-08-29T14:59:00.000Z");
    const crossDayCollector = fakeCollector({
      regions: [SANCHEONG],
      cachedKeys: cachedInitialKeys([SANCHEONG])
    });
    const crossDayScheduler = createDemandStrengthBackfillScheduler({
      collector: crossDayCollector,
      stateFile: crossDayStateFile,
      now: () => crossDayNow,
      dailyCallBudget: 10
    });
    const crossDayReservation = await crossDayScheduler.beginManualReservation({ months: 2 });
    assert.equal(crossDayReservation.todayUsedCalls, 4);
    crossDayNow = new Date("2026-08-29T15:01:00.000Z");
    assert.throws(
      () => crossDayScheduler.runOnce({ trigger: "same-process-manual-date-rollover" }),
      (error) => error?.statusCode === 409 && error?.code === "tourism_demand_strength_manual_active"
    );
    const sameProcessRolloverStatus = await crossDayScheduler.status();
    assert.equal(sameProcessRolloverStatus.manualActive, true);
    assert.equal(sameProcessRolloverStatus.staleManualReservationCount, 1);
    const lateSettlement = await crossDayScheduler.finishManualReservation({
      reservationId: crossDayReservation.reservationId,
      actualCalls: 3
    });
    assert.equal(lateSettlement.status, "manual_late_settled");
    assert.equal(lateSettlement.todayUsedCalls, 3);
    assert.equal(lateSettlement.staleManualReservationCount, 0);
    const allowedAfterSettlement = await crossDayScheduler.runOnce({ trigger: "after-late-settlement" });
    assert.equal(allowedAfterSettlement.status, "initial_complete");
    assert.equal(JSON.stringify(await crossDayScheduler.status()).includes(crossDayReservation.reservationId), false);

    const restartCrossDayStateFile = path.join(temporaryRoot, "manual-cross-day-restart", "state.json");
    let restartCrossDayNow = new Date("2026-08-29T14:59:00.000Z");
    const restartCrossDayCollector = fakeCollector({
      regions: [SANCHEONG],
      cachedKeys: cachedInitialKeys([SANCHEONG])
    });
    const preRestartScheduler = createDemandStrengthBackfillScheduler({
      collector: restartCrossDayCollector,
      stateFile: restartCrossDayStateFile,
      now: () => restartCrossDayNow,
      dailyCallBudget: 10
    });
    const preRestartReservation = await preRestartScheduler.beginManualReservation({ months: 2 });
    restartCrossDayNow = new Date("2026-08-29T15:01:00.000Z");
    const postRestartScheduler = createDemandStrengthBackfillScheduler({
      collector: restartCrossDayCollector,
      stateFile: restartCrossDayStateFile,
      now: () => restartCrossDayNow,
      dailyCallBudget: 10
    });
    const allowedAfterRestart = await postRestartScheduler.runOnce({ trigger: "restart-releases-stale-manual" });
    assert.equal(allowedAfterRestart.status, "initial_complete");
    assert.equal(allowedAfterRestart.manualActive, false);
    assert.equal(allowedAfterRestart.staleManualReservationCount, 1);
    const restartLateSettlement = await postRestartScheduler.finishManualReservation({
      reservationId: preRestartReservation.reservationId,
      actualCalls: 3
    });
    assert.equal(restartLateSettlement.status, "manual_late_settled");
    assert.equal(restartLateSettlement.todayUsedCalls, 3);

    const rolloverStateFile = path.join(temporaryRoot, "run-rollover", "state.json");
    let rolloverNow = new Date(fixedNow);
    let rolloverTriggered = false;
    const rolloverCollector = fakeCollector({
      regions: [SANCHEONG],
      networkResult: () => {
        if (!rolloverTriggered) {
          rolloverTriggered = true;
          rolloverNow = new Date("2026-08-30T01:00:00.000Z");
        }
        return { complete: true, operationCallsAttempted: 2 };
      }
    });
    const rolloverScheduler = createDemandStrengthBackfillScheduler({
      collector: rolloverCollector,
      stateFile: rolloverStateFile,
      now: () => rolloverNow,
      dailyCallBudget: 4
    });
    const rolloverResult = await rolloverScheduler.runOnce({ trigger: "date-rollover" });
    assert.equal(rolloverResult.status, "date_rollover");
    assert.equal(rolloverResult.reason, "kst_daily_budget_date_changed");
    assert.equal(rolloverCollector.network.length, 1);
    assert.equal((await rolloverScheduler.status()).todayUsedCalls, 0);

    const actualCallsStateFile = path.join(temporaryRoot, "actual-calls", "state.json");
    const actualCallsCollector = fakeCollector({
      regions: [SANCHEONG],
      cachedKeys: cachedInitialKeys([SANCHEONG]).filter((key) => !key.endsWith("__202607")),
      networkResult: () => ({ complete: true, operationCallsAttempted: 1 })
    });
    const actualCallsScheduler = createDemandStrengthBackfillScheduler({
      collector: actualCallsCollector,
      stateFile: actualCallsStateFile,
      now: () => fixedNow,
      dailyCallBudget: 2
    });
    const actualCallsResult = await actualCallsScheduler.runOnce({ trigger: "actual-call-accounting" });
    assert.equal(actualCallsResult.status, "initial_complete");
    assert.equal(actualCallsResult.budget.usedCalls, 1);
    assert.equal(actualCallsResult.budget.reservedCalls, 0);
    assert.equal(actualCallsResult.budget.remainingCalls, 1);
    assert.equal(actualCallsCollector.network.length, 1);

    const blockedCollector = fakeCollector({ regions: [SANCHEONG] });
    blockedCollector.status = () => ({
      sources: [{ key: "demandStrength", status: "missing_service_key", serviceKeyConfigured: false, endpointConfigured: true }]
    });
    const blockedScheduler = createDemandStrengthBackfillScheduler({
      collector: blockedCollector,
      stateFile: path.join(temporaryRoot, "blocked", "state.json"),
      now: () => fixedNow
    });
    const blocked = await blockedScheduler.runOnce({ trigger: "source-gate" });
    assert.equal(blocked.status, "blocked");
    assert.equal(blocked.reason, "demand_strength_source_missing_service_key");
    assert.equal(blocked.plan, null);
    assert.equal(blockedCollector.inspections.length, 0);
    assert.equal(blockedCollector.network.length, 0);
    assert.equal((await blockedScheduler.status()).source.status, "missing_service_key");

    let releaseCollection;
    const gate = new Promise((resolve) => {
      releaseCollection = resolve;
    });
    const concurrentCollector = fakeCollector({
      regions: [SANCHEONG],
      cachedKeys: cachedInitialKeys([SANCHEONG]).filter((key) => !key.endsWith("__202607")),
      networkResult: async () => {
        await gate;
        return { complete: true, operationCallsAttempted: 2 };
      }
    });
    const concurrentScheduler = createDemandStrengthBackfillScheduler({
      collector: concurrentCollector,
      stateFile: path.join(temporaryRoot, "concurrent", "state.json"),
      now: () => fixedNow
    });
    const running = concurrentScheduler.runOnce({ trigger: "test" });
    await assert.rejects(
      () => concurrentScheduler.beginManualReservation({ months: 1 }),
      (error) => error?.statusCode === 409 && error?.code === "tourism_demand_strength_scheduler_active"
    );
    await assert.rejects(
      () => concurrentScheduler.finishManualReservation({ reservationId: "not-active", actualCalls: 0 }),
      (error) => error?.statusCode === 409 && error?.code === "tourism_demand_strength_scheduler_active"
    );
    assert.throws(
      () => concurrentScheduler.runOnce({ trigger: "admin", rejectIfRunning: true }),
      (error) => error?.statusCode === 409 && error?.code === "tourism_demand_strength_backfill_busy"
    );
    releaseCollection();
    assert.equal((await running).status, "initial_complete");

    const fingerprintStateFile = path.join(temporaryRoot, "fingerprint", "state.json");
    await fsp.mkdir(path.dirname(fingerprintStateFile), { recursive: true });
    await fsp.writeFile(fingerprintStateFile, JSON.stringify({
      version: STATE_VERSION,
      phase: "monthly_maintenance",
      initialTargetYearMonth: "202607",
      initialCompletedAt: fixedNow.toISOString(),
      monthlyCompletedThrough: "202607",
      eligibleRegionCount: 1,
      planFingerprint: {
        regionMapVersion: "fixture-region-map-v1",
        demandStrengthAdapter: "fixture-demand-strength-v1"
      },
      plan: null,
      failures: {},
      terminalMissing: {
        [`${SANCHEONG.regionKey}__202607`]: {
          reason: "old_adapter_no_observation",
          attempts: 3,
          lastAt: fixedNow.toISOString()
        }
      },
      dailyBudget: {
        kstDate: "2026-08-29",
        limitCalls: 800,
        usedCalls: 0,
        reservedCalls: 0,
        reservedWorkItems: 0
      }
    }), "utf8");
    const fingerprintCollector = fakeCollector({
      regions: [SANCHEONG],
      cachedKeys: cachedInitialKeys([SANCHEONG]),
      regionMapVersion: "fixture-region-map-v2",
      adapter: "fixture-demand-strength-v2"
    });
    const fingerprintScheduler = createDemandStrengthBackfillScheduler({
      collector: fingerprintCollector,
      stateFile: fingerprintStateFile,
      now: () => fixedNow
    });
    const fingerprintRefresh = await fingerprintScheduler.runOnce({ trigger: "fingerprint-change" });
    assert.equal(fingerprintRefresh.status, "initial_complete");
    assert.equal(fingerprintRefresh.terminalMissingPairCount, 0);
    assert.equal(fingerprintCollector.inspections.length, 36);
    assert.equal(fingerprintCollector.inspections[0].key, `${SANCHEONG.regionKey}__202607`);
    const fingerprintState = JSON.parse(await fsp.readFile(fingerprintStateFile, "utf8"));
    assert.deepEqual(fingerprintState.planFingerprint, {
      regionMapVersion: "fixture-region-map-v2",
      demandStrengthAdapter: "fixture-demand-strength-v2",
      demandStrengthNormalizer: "fixture-normalizer-v1",
      authorizedRecoveryId: SANCHEONG_LATEST_RECOVERY_ID
    });
    const adapterOnlyCollector = fakeCollector({
      regions: [SANCHEONG],
      cachedKeys: cachedInitialKeys([SANCHEONG]),
      regionMapVersion: "fixture-region-map-v2",
      adapter: "fixture-demand-strength-v3"
    });
    const adapterOnlyScheduler = createDemandStrengthBackfillScheduler({
      collector: adapterOnlyCollector,
      stateFile: fingerprintStateFile,
      now: () => fixedNow
    });
    assert.equal((await adapterOnlyScheduler.runOnce({ trigger: "adapter-only-change" })).status, "initial_complete");
    assert.equal(adapterOnlyCollector.inspections.length, 36);
    const normalizerOnlyCollector = fakeCollector({
      regions: [SANCHEONG],
      cachedKeys: cachedInitialKeys([SANCHEONG]),
      regionMapVersion: "fixture-region-map-v2",
      adapter: "fixture-demand-strength-v3",
      normalizerVersion: "fixture-normalizer-v2"
    });
    const normalizerOnlyScheduler = createDemandStrengthBackfillScheduler({
      collector: normalizerOnlyCollector,
      stateFile: fingerprintStateFile,
      now: () => fixedNow
    });
    assert.equal((await normalizerOnlyScheduler.runOnce({ trigger: "normalizer-only-change" })).status, "initial_complete");
    assert.equal(normalizerOnlyCollector.inspections.length, 36);
    const regionMapOnlyCollector = fakeCollector({
      regions: [SANCHEONG],
      cachedKeys: cachedInitialKeys([SANCHEONG]),
      regionMapVersion: "fixture-region-map-v3",
      adapter: "fixture-demand-strength-v3",
      normalizerVersion: "fixture-normalizer-v2"
    });
    const regionMapOnlyScheduler = createDemandStrengthBackfillScheduler({
      collector: regionMapOnlyCollector,
      stateFile: fingerprintStateFile,
      now: () => fixedNow
    });
    assert.equal((await regionMapOnlyScheduler.runOnce({ trigger: "region-map-only-change" })).status, "initial_complete");
    assert.equal(regionMapOnlyCollector.inspections.length, 36);

    await fsp.writeFile(budgetStateFile, "{broken-primary", "utf8");
    const recoveredScheduler = createDemandStrengthBackfillScheduler({
      collector: budgetCollector,
      stateFile: budgetStateFile,
      now: () => budgetNow,
      dailyCallBudget: 2
    });
    const recoveredStatus = await recoveredScheduler.status();
    assert.equal(recoveredStatus.todayUsedCalls, 2);
    assert.equal(recoveredStatus.plan.cursor, 5);
    assert.equal(JSON.parse(await fsp.readFile(budgetStateFile, "utf8")).plan.cursor, 5);
    assert.equal(JSON.parse(await fsp.readFile(`${budgetStateFile}.bak`, "utf8")).version, STATE_VERSION);

    const corruptStateFile = path.join(temporaryRoot, "corrupt", "state.json");
    await fsp.mkdir(path.dirname(corruptStateFile), { recursive: true });
    await fsp.writeFile(corruptStateFile, "{broken-primary", "utf8");
    await fsp.writeFile(`${corruptStateFile}.bak`, "{broken-backup", "utf8");
    const corruptCollector = fakeCollector({ regions: [SANCHEONG] });
    const corruptScheduler = createDemandStrengthBackfillScheduler({
      collector: corruptCollector,
      stateFile: corruptStateFile,
      now: () => fixedNow
    });
    const corruptRun = await corruptScheduler.runOnce({ trigger: "corrupt-state" });
    assert.equal(corruptRun.status, "blocked");
    assert.equal(corruptRun.reason, "scheduler_state_unavailable");
    assert.equal(corruptRun.todayUsedCalls, null);
    assert.equal(corruptCollector.calls.status, 0);
    assert.equal(corruptCollector.calls.readRegionMap, 0);
    assert.equal(corruptCollector.inspections.length, 0);
    assert.equal(corruptCollector.network.length, 0);
    const corruptStatus = await corruptScheduler.status();
    assert.equal(corruptStatus.status, "blocked");
    assert.equal(corruptStatus.stateIntegrity, "unavailable");
    assert.equal(Object.hasOwn(corruptStatus, "stateFile"), false);
    assert.equal(corruptCollector.calls.status, 0);
    assert.equal(await fsp.readFile(corruptStateFile, "utf8"), "{broken-primary");

    const disabledCollector = fakeCollector({ regions: [SANCHEONG] });
    const disabled = createDemandStrengthBackfillScheduler({
      collector: disabledCollector,
      stateFile: path.join(temporaryRoot, "disabled", "state.json"),
      now: () => fixedNow,
      enabled: false
    });
    assert.equal((await disabled.runOnce()).status, "disabled");
    assert.equal(disabledCollector.inspections.length, 0);
    assert.equal(disabledCollector.network.length, 0);

    process.stdout.write("tourism demand strength backfill scheduler tests passed\n");
  } finally {
    const expectedPrefix = path.join(os.tmpdir(), "tourism-demand-backfill-");
    if (path.resolve(temporaryRoot).startsWith(path.resolve(expectedPrefix))) {
      await fsp.rm(temporaryRoot, { recursive: true, force: true });
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
