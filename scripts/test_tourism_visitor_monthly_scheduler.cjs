const assert = require("node:assert/strict");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const {
  kstDateKey,
  latestClosedYearMonth,
  eligibleRegionKeys,
  createMonthlyVisitorScheduler
} = require("./tourism_visitor_monthly_scheduler.cjs");

function history({ complete = false, network = false } = {}) {
  return {
    ok: complete,
    status: complete ? "ok" : "partial",
    reason: complete ? "" : "incomplete_history_coverage",
    period: {
      startYearMonth: "202508",
      endYearMonth: "202607",
      months: 12,
      latestClosedYearMonth: "202607"
    },
    coverage: {
      expectedRegionMonths: 12,
      completeRegionMonths: complete ? 12 : 10,
      partialRegionMonths: complete ? 0 : 1,
      missingRegionMonths: complete ? 0 : 1,
      coverageRate: complete ? 1 : 0.8333
    },
    collection: {
      requestedMonths: 12,
      cacheHitMonths: complete ? 12 : 10,
      missingCacheMonths: complete ? 0 : 2,
      networkAttemptedMonths: network ? 2 : 0,
      networkSucceededMonths: network ? 2 : 0,
      networkFailedMonths: 0
    }
  };
}

async function main() {
  const fixedNow = new Date("2026-08-28T02:00:00.000Z");
  assert.equal(kstDateKey(fixedNow), "2026-08-28");
  assert.equal(latestClosedYearMonth(fixedNow), "202607");
  assert.deepEqual(eligibleRegionKeys({
    regions: [
      { regionKey: "ready", ktoSggCd: "48860" },
      { regionKey: "pending", ktoSggCd: "42000", codeStatus: "verify" },
      { regionKey: "invalid", ktoSggCd: "48" },
      { regionKey: "ready", ktoSggCd: "48860" }
    ]
  }), ["ready"]);

  const temporaryRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "tourism-monthly-scheduler-"));
  try {
    const stateFile = path.join(temporaryRoot, "maintenance", "state.json");
    const calls = [];
    let cacheComplete = false;
    const collector = {
      readRegionMap: async () => ({
        regions: [
          { regionKey: "kr_gyeongnam_sancheong", ktoSggCd: "48860" },
          { regionKey: "kr_pending", ktoSggCd: "42000", codeStatus: "verify-before-api-call" }
        ]
      }),
      collectVisitorHistory: async (input) => {
        calls.push({ ...input });
        if (input.collectMissing) {
          cacheComplete = true;
          return history({ complete: true, network: true });
        }
        return history({ complete: cacheComplete, network: false });
      }
    };
    const scheduler = createMonthlyVisitorScheduler({
      collector,
      stateFile,
      now: () => fixedNow,
      enabled: true,
      // A legacy caller cannot expand the current 12-month policy.
      months: 36,
      concurrency: 2
    });

    const refreshed = await scheduler.runOnce({ trigger: "test" });
    assert.equal(refreshed.ok, true);
    assert.equal(refreshed.status, "complete");
    assert.equal(refreshed.targetYearMonth, "202607");
    assert.equal(calls.length, 2);
    assert.equal(calls[0].collectMissing, false);
    assert.equal(calls[1].collectMissing, true);
    assert.deepEqual(calls[1].regionKeys, ["kr_gyeongnam_sancheong"]);
    assert.equal(calls[1].months, 12);
    assert.equal(calls[1].endYearMonth, "202607");

    const state = JSON.parse(await fsp.readFile(stateFile, "utf8"));
    assert.equal(state.version, "tourism-visitor-monthly-sync-v1");
    assert.equal(state.policyMonths, 12);
    assert.equal(state.lastResultStatus, "complete");
    assert.equal(state.eligibleRegionCount, 1);
    assert.equal(state.result.coverage.coverageRate, 1);
    assert.doesNotMatch(JSON.stringify(state), /serviceKey|fixture-key/i);

    const upToDate = await scheduler.runOnce({ trigger: "test" });
    assert.equal(upToDate.ok, true);
    assert.equal(upToDate.status, "up_to_date");
    assert.equal(calls.length, 3, "완전 캐시 확인 후 네트워크 갱신을 다시 실행하지 않아야 합니다.");

    const schedulerStatus = await scheduler.status();
    assert.equal(schedulerStatus.enabled, true);
    assert.equal(schedulerStatus.running, false);
    assert.equal(schedulerStatus.months, 12);
    assert.equal(schedulerStatus.state.policyMonths, 12);
    assert.equal(schedulerStatus.policy.pageOrCompanyRequestTriggersNetwork, false);

    let releaseInspection;
    const inspectionGate = new Promise((resolve) => {
      releaseInspection = resolve;
    });
    const concurrentScheduler = createMonthlyVisitorScheduler({
      collector: {
        readRegionMap: async () => ({
          regions: [{ regionKey: "kr_gyeongnam_sancheong", ktoSggCd: "48860" }]
        }),
        collectVisitorHistory: async () => {
          await inspectionGate;
          return history({ complete: true });
        }
      },
      stateFile: path.join(temporaryRoot, "concurrent.json"),
      now: () => fixedNow,
      enabled: true
    });
    const firstConcurrentRun = concurrentScheduler.runOnce({ trigger: "test" });
    assert.throws(
      () => concurrentScheduler.runOnce({ trigger: "admin", rejectIfRunning: true }),
      (error) => error?.statusCode === 409 && error?.code === "tourism_visitor_monthly_sync_busy"
    );
    releaseInspection();
    assert.equal((await firstConcurrentRun).status, "up_to_date");

    let failedCollectionCalls = 0;
    const failedScheduler = createMonthlyVisitorScheduler({
      collector: {
        readRegionMap: async () => ({
          regions: [{ regionKey: "kr_gyeongnam_sancheong", ktoSggCd: "48860" }]
        }),
        collectVisitorHistory: async (input) => {
          failedCollectionCalls += 1;
          return history({ complete: false, network: Boolean(input.collectMissing) });
        }
      },
      stateFile: path.join(temporaryRoot, "failed.json"),
      now: () => fixedNow,
      enabled: true
    });
    const failedAttempt = await failedScheduler.runOnce({ trigger: "test" });
    assert.equal(failedAttempt.status, "partial");
    assert.equal(failedCollectionCalls, 2);
    const cooldownAttempt = await failedScheduler.runOnce({ trigger: "test" });
    assert.equal(cooldownAttempt.status, "cooldown");
    assert.equal(cooldownAttempt.reason, "network_attempt_already_made_today");
    assert.equal(failedCollectionCalls, 3, "cooldown 확인은 캐시 검사만 하고 네트워크 수집을 반복하면 안 됩니다.");

    const policyTransitionFile = path.join(temporaryRoot, "policy-transition.json");
    await fsp.writeFile(policyTransitionFile, JSON.stringify({
      version: "tourism-visitor-monthly-sync-v1",
      lastAttemptKstDate: "2026-08-28",
      targetYearMonth: "202607",
      policyMonths: 36
    }), "utf8");
    let policyTransitionCalls = 0;
    const policyTransitionScheduler = createMonthlyVisitorScheduler({
      collector: {
        readRegionMap: async () => ({
          regions: [{ regionKey: "kr_gyeongnam_sancheong", ktoSggCd: "48860" }]
        }),
        collectVisitorHistory: async (input) => {
          policyTransitionCalls += 1;
          return history({ complete: false, network: Boolean(input.collectMissing) });
        }
      },
      stateFile: policyTransitionFile,
      now: () => fixedNow,
      enabled: true,
      months: 12
    });
    const policyTransitionAttempt = await policyTransitionScheduler.runOnce({ trigger: "policy_transition" });
    assert.equal(policyTransitionAttempt.status, "partial");
    assert.equal(policyTransitionCalls, 2, "36개월 정책의 당일 기록은 새 12개월 수집을 막지 않아야 합니다.");
    const transitionedState = JSON.parse(await fsp.readFile(policyTransitionFile, "utf8"));
    assert.equal(transitionedState.policyMonths, 12);

    let disabledCalls = 0;
    const disabled = createMonthlyVisitorScheduler({
      collector: {
        readRegionMap: async () => ({ regions: [] }),
        collectVisitorHistory: async () => {
          disabledCalls += 1;
          return history();
        }
      },
      stateFile: path.join(temporaryRoot, "disabled.json"),
      now: () => fixedNow,
      enabled: false
    });
    const disabledResult = await disabled.runOnce();
    assert.equal(disabledResult.status, "disabled");
    assert.equal(disabledCalls, 0);

    process.stdout.write("tourism visitor monthly scheduler tests passed\n");
  } finally {
    const expectedPrefix = path.join(os.tmpdir(), "tourism-monthly-scheduler-");
    if (path.resolve(temporaryRoot).startsWith(path.resolve(expectedPrefix))) {
      await fsp.rm(temporaryRoot, { recursive: true, force: true });
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
