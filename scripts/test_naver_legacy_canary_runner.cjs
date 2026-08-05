"use strict";

const assert = require("node:assert/strict");
const { installFixtureNetworkGuard } = require("./fixture_network_guard.cjs");
const {
  buildCollectorStrategyPlan
} = require("./naver_collector_strategy.cjs");
const {
  apolloHtml,
  createApolloFixture,
  fixtureProviderReservation,
  staticFixtureTransport
} = require("./naver_collector_fixture_factory.cjs");
const {
  buildCanaryExecutionIdentity
} = require("./naver_legacy_canary_contract.cjs");
const {
  createNaverLegacyCanaryRunner
} = require("./naver_legacy_canary_runner.cjs");

const CONTRACT = Object.freeze({
  keyword: "Synthetic canary lodging",
  searchMode: "keyword",
  rankStart: 1,
  rankEnd: 50,
  regionKey: "kr_fixture_canary",
  categoryKey: "glamping",
  measurementPeriod: Object.freeze({ start: "2026-08-05", end: "2026-08-05" })
});
const BASE_TIME = Date.parse("2026-08-06T01:00:00.000Z");

function collectorPlan(contract = CONTRACT) {
  return buildCollectorStrategyPlan({ contract, strategy: "legacy_candidate", callBudget: 1 });
}

function approvalFor(contract = CONTRACT, approvalId = "fixture-approval-01") {
  const plan = collectorPlan(contract);
  return Object.freeze({
    approvalId,
    externalCallApproved: true,
    fixtureOnly: true,
    resultWriteApproved: false,
    providerHealthWriteApproved: false,
    maxProviderAttempts: 1,
    collectorScope: "main_place_only",
    contractHash: plan.contractHash,
    executionIdentityHash: buildCanaryExecutionIdentity(plan),
    expiresAt: new Date(BASE_TIME + 5 * 60 * 1000).toISOString()
  });
}

function runnerFor(response, options = {}) {
  const transport = staticFixtureTransport(response, {
    maxCalls: 1,
    budgetErrorCode: "NAVER_LEGACY_CANARY_CALL_BUDGET_EXCEEDED"
  });
  let clockTick = 0;
  const runner = createNaverLegacyCanaryRunner({
    releaseEnabled: options.releaseEnabled !== false,
    fixtureExecutionEnabled: options.fixtureExecutionEnabled !== false,
    transport,
    providerReservation: fixtureProviderReservation("2026-08-06T00:59:58.000Z"),
    now: () => new Date(BASE_TIME + clockTick++ * 1000)
  });
  return { runner, transport };
}

async function expectCode(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, code);
    assert.doesNotMatch(String(error.message || ""), /Synthetic canary lodging|https?:|cookie|authorization|query=/iu);
    return true;
  });
}

async function main() {
  const guard = installFixtureNetworkGuard({ label: "NAVER legacy canary runner fixtures" });
  try {
    const fixture = createApolloFixture({
      query: CONTRACT.keyword,
      items: [
        { id: "fixture-place-a", name: "Fixture Lodge A", roadAddress: "Fixture Road A" },
        { id: "fixture-place-b", name: "Fixture Lodge B", address: "Fixture Lot B" }
      ]
    });
    const successResponse = { status: 200, body: apolloHtml(fixture.state) };

    const disabled = runnerFor(successResponse, { releaseEnabled: false });
    await expectCode(disabled.runner.execute({}), "NAVER_LEGACY_CANARY_DISABLED");
    assert.equal(disabled.transport.fixtureCallCount(), 0);
    assert.deepEqual(disabled.runner.status(), {
      strategy: "legacy_candidate",
      phase: "naver_place_rank_main",
      collectorScope: "main_place_only",
      enabled: false,
      actualCallsEnabled: false,
      externalCallApproved: false,
      providerHealthWriteApproved: false,
      resultWriteApproved: false,
      maxProviderAttempts: 1,
      authorizedCallCount: 0,
      executedCallCount: 0,
      blocker: "feature_gate_disabled",
      planVersion: "naver-legacy-preview-canary.v1"
    });

    const gateOnly = runnerFor(successResponse, { fixtureExecutionEnabled: false });
    await expectCode(gateOnly.runner.execute({ fixtureMode: true }), "NAVER_LEGACY_CANARY_APPROVAL_REQUIRED");
    assert.equal(gateOnly.transport.fixtureCallCount(), 0);

    const mismatched = runnerFor(successResponse);
    await expectCode(
      mismatched.runner.execute({
        fixtureMode: true,
        contract: CONTRACT,
        approval: { ...approvalFor(), contractHash: "0".repeat(64) }
      }),
      "NAVER_LEGACY_CANARY_CONTRACT_MISMATCH"
    );
    assert.equal(mismatched.transport.fixtureCallCount(), 0);

    const success = runnerFor(successResponse);
    const executionInput = Object.freeze({
      fixtureMode: true,
      contract: CONTRACT,
      approval: approvalFor()
    });
    const [first, second, third] = await Promise.all([
      success.runner.execute(executionInput),
      success.runner.execute(executionInput),
      success.runner.execute(executionInput)
    ]);
    assert.deepEqual(second, first);
    assert.deepEqual(third, first);
    assert.equal(success.transport.fixtureCallCount(), 1, "same-identity requests must share one fixture transport");
    assert.deepEqual(Object.keys(first), [
      "status",
      "strategyVersion",
      "executionIdentityHash",
      "organicCount",
      "adCount",
      "observedRankCount",
      "providerResponseSubtype",
      "diagnosticId",
      "startedAt",
      "completedAt"
    ]);
    assert.equal(first.status, "ready");
    assert.equal(first.organicCount, 2);
    assert.equal(first.adCount, 0);
    assert.equal(first.observedRankCount, 2);
    assert.match(first.executionIdentityHash, /^[a-f0-9]{64}$/u);
    assert.match(first.diagnosticId, /^canary-[a-f0-9]{16}$/u);
    assert.doesNotMatch(JSON.stringify(first), /Synthetic canary lodging|Fixture Lodge|fixture-place|Fixture Road|https?:|cookie|authorization/iu);
    assert.equal(success.runner.status().authorizedCallCount, 1);
    assert.equal(success.runner.status().executedCallCount, 1);
    await expectCode(success.runner.execute(executionInput), "NAVER_LEGACY_CANARY_APPROVAL_USED");
    await expectCode(success.transport({ requestOrdinal: 2 }), "NAVER_LEGACY_CANARY_CALL_BUDGET_EXCEEDED");
    assert.equal(success.transport.fixtureCallCount(), 1);

    for (const scenario of [
      { response: { status: 403, body: "forbidden" }, subtype: "http_403" },
      { response: { status: 429, headers: { "retry-after": "60" }, body: "limited" }, subtype: "http_429" },
      { response: { status: 200, body: "<html><body>CAPTCHA security check</body></html>" }, subtype: "challenge_html" }
    ]) {
      const blocked = runnerFor(scenario.response);
      await assert.rejects(
        blocked.runner.execute({
          fixtureMode: true,
          contract: CONTRACT,
          approval: approvalFor(CONTRACT, `fixture-block-${scenario.subtype}`)
        }),
        (error) => {
          assert.equal(error.code, "NAVER_ACCESS_BLOCKED");
          assert.equal(error.providerFailureSubtype, scenario.subtype);
          return true;
        }
      );
      assert.equal(blocked.transport.fixtureCallCount(), 1, "blocked response must not retry");
    }

    assert.equal(guard.blockedAttempts(), 0);
  } finally {
    guard.restore();
  }
  console.log("NAVER legacy canary runner, single-flight, one-call budget, and safe summary tests passed.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
