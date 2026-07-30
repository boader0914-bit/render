"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  INSIGHTS_PROVIDER_ID,
  INSIGHTS_SIGNAL_KINDS,
  normalizeLiveSignalObservation,
  normalizeSignalObservation
} = require("./integration/contracts/insights.cjs");
const {
  SIGNAL_CONNECTOR_DIRECTORY,
  classifyProviderError
} = require("./integration/contracts/signal_connector.cjs");
const {
  createSignalConnectorRepository
} = require("./integration/repositories/signal_connector_store.cjs");
const {
  createSignalConnectorService
} = require("./integration/services/signal_connector_service.cjs");
const {
  createDeterministicInsightsFixtureProvider
} = require("./integration/services/insights_fixture_provider.cjs");

const actor = { type: "account", id: "account_stage231_admin", role: "admin" };
const roots = [];
let networkCalls = 0;
const originalFetch = global.fetch;

function temporaryRoot(label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `stage231-signal-${label}-`));
  roots.push(root);
  return root;
}

function request(overrides = {}) {
  return {
    clientRequestId: "signal-request-0001",
    mode: "real",
    providerId: "provider-search-live",
    companyId: "company-stage231-one",
    tenantCompanyId: "tenant-stage231-one",
    region: "강원 홍천",
    periodMonth: "2026-07",
    signalKinds: ["search.volume", "trend.index", "sns.mentions"],
    dailyCallCap: 20,
    monthlyCallCap: 200,
    callsPerRun: 1,
    costPerCall: 0.01,
    dailyCostCap: 1,
    monthlyCostCap: 10,
    maxAttempts: 3,
    timeoutMs: 500,
    ...overrides
  };
}

function liveSignals(input, options = {}) {
  const observedAt = options.observedAt || "2026-07-30T00:00:00.000Z";
  return input.signalKinds.map((kind, index) => ({
    kind,
    index: 60 + index,
    observedAt,
    sourceUrl: `https://api.provider.example.test/signals/${encodeURIComponent(kind)}`,
    provenance: {
      adapterVersion: "test-real-v1",
      providerRequestId: `request-${index + 1}`,
      targetHash: "public-target-digest",
      externalNetworkCalls: options.externalNetworkCalls || 0
    }
  }));
}

function realAdapter(id, collect, extras = {}) {
  return { id, kind: "real", collect, secret: "must-never-enter-diagnostics", ...extras };
}

async function assertContractReuse() {
  const live = normalizeLiveSignalObservation({
    companyId: "company-contract-one",
    runId: "signal-run-contract-one",
    observedAt: "2026-07-30T00:00:00.000Z",
    periodMonth: "2026-07",
    region: "서울",
    kind: "search.volume",
    index: 72,
    source: "provider-contract-live",
    sourceUrl: "https://api.provider.example.test/signals/search",
    synthetic: false,
    dataMode: "live",
    provenance: { adapterVersion: "contract-v1", externalNetworkCalls: 0 }
  });
  assert.equal(live.schemaVersion, 1);
  assert.equal(live.synthetic, false);
  assert.equal(live.dataMode, "live");
  assert.ok(INSIGHTS_SIGNAL_KINDS.includes(live.kind));
  assert.equal(live.provenance.synthetic, false);
  assert.equal(live.provenance.dataMode, "live");
  await assert.rejects(async () => normalizeLiveSignalObservation({ ...live, synthetic: true }), /synthetic=false/);
  await assert.rejects(async () => normalizeLiveSignalObservation({ ...live, sourceUrl: "https://api.provider.test/?api_key=secret" }), /credentials/);
  await assert.rejects(async () => normalizeSignalObservation({ ...live, synthetic: false }), /explicitly synthetic/);
}

async function assertDefaultClosedAndLiveFlow() {
  let now = Date.parse("2026-07-30T00:00:00.000Z");
  const clock = () => now;
  assert.throws(() => createSignalConnectorRepository({}), (error) => error.code === "SIGNAL_CONNECTOR_ROOT_REQUIRED");
  const overlapRoot = temporaryRoot("legacy-overlap");
  assert.throws(() => createSignalConnectorRepository({
    integrationRoot: overlapRoot,
    legacyPaths: [path.join(overlapRoot, SIGNAL_CONNECTOR_DIRECTORY)]
  }), (error) => error.code === "SIGNAL_CONNECTOR_LEGACY_PATH_FORBIDDEN");
  const root = temporaryRoot("live");
  const repository = createSignalConnectorRepository({ integrationRoot: root, clock });
  const closed = createSignalConnectorService({ repository, env: { NODE_ENV: "production" }, clock });
  const closedDiagnostics = await closed.diagnostics();
  assert.equal(closedDiagnostics.adapterInvocations, 0);
  assert.equal(closedDiagnostics.externalNetworkCalls, 0);
  assert.equal(closedDiagnostics.fallbackAdapterInvocations, 0);
  await assert.rejects(closed.enqueue(request(), { actor }), (error) => error.code === "SIGNAL_CONNECTOR_ADAPTER_REQUIRED");
  assert.deepEqual(await repository.listJobs(), []);
  const fixtureCannotFallback = createSignalConnectorService({
    repository,
    fixtureAdapter: createDeterministicInsightsFixtureProvider(),
    env: { NODE_ENV: "production" },
    clock
  });
  await assert.rejects(fixtureCannotFallback.enqueue(request(), { actor }), (error) => error.code === "SIGNAL_CONNECTOR_ADAPTER_REQUIRED");
  assert.equal((await fixtureCannotFallback.diagnostics()).fallbackAdapterInvocations, 0);

  let adapterCalls = 0;
  let reservationSeenBeforeTransport = false;
  const adapter = realAdapter("provider-search-live", async (input) => {
    adapterCalls += 1;
    const state = await repository.snapshot();
    reservationSeenBeforeTransport = state.reservations.some((row) => row.jobId === input.runId && row.transportStarted);
    return { signals: liveSignals(input), externalNetworkCalls: 0 };
  });
  const service = createSignalConnectorService({
    repository,
    adapters: { [adapter.id]: adapter },
    env: { NODE_ENV: "production" },
    clock
  });
  const first = await service.enqueue(request(), { actor });
  const replay = await service.enqueue(request(), { actor });
  assert.equal(first.idempotent, false);
  assert.equal(replay.idempotent, true);
  assert.equal(first.job.jobId, replay.job.jobId);
  await assert.rejects(service.enqueue(request({ region: "서울" }), { actor }), (error) => error.code === "SIGNAL_CONNECTOR_IDEMPOTENCY_CONFLICT");
  const result = await service.runNext({}, { actor });
  assert.equal(result.claimed, true);
  assert.equal(result.job.status, "completed");
  assert.equal(result.job.attempts, 1);
  assert.equal(adapterCalls, 1);
  assert.equal(reservationSeenBeforeTransport, true);
  const rows = await repository.listSignals({ companyId: "company-stage231-one" });
  assert.equal(rows.length, 3);
  assert.ok(rows.every((row) => row.synthetic === false && row.dataMode === "live"));
  assert.deepEqual(rows.map((row) => row.kind).sort(), ["search.volume", "sns.mentions", "trend.index"]);
  const events = (await repository.audits()).map((row) => row.event);
  for (const expected of ["signal.job.queued", "signal.job.running", "signal.quota.reserved", "signal.transport.started", "signal.rows.appended", "signal.job.completed"]) {
    assert.ok(events.includes(expected), `missing audit ${expected}`);
  }
  const metrics = (await service.providerMetrics("provider-search-live"))[0];
  assert.equal(metrics.successRate, 100);
  assert.equal(metrics.coverage, 100);
  assert.equal(metrics.freshness, "fresh");
  const usage = (await repository.quotaUsage("provider-search-live"))[0];
  assert.equal(usage.daily.calls, 1);
  assert.equal(usage.monthly.calls, 1);
  assert.equal(usage.daily.callCap, 20);
  assert.equal(usage.transportAttempts, 1);
  assert.equal(usage.externalNetworkCalls, 0);
  const diagnostics = await service.diagnostics();
  assert.equal(JSON.stringify(diagnostics).includes("must-never-enter-diagnostics"), false);
  assert.equal(diagnostics.store.legacyRuntimeReads, 0);
  assert.equal(diagnostics.store.legacyRuntimeCopies, 0);
  assert.equal(diagnostics.store.migrationRows, 0);
  assert.equal(diagnostics.store.backfillRows, 0);
  assert.equal(diagnostics.store.dualWriteRows, 0);

  const restarted = createSignalConnectorRepository({ integrationRoot: root, clock });
  assert.equal((await restarted.getJob(first.job.jobId)).status, "completed");
  assert.equal((await restarted.listSignals()).length, 3);
  assert.deepEqual(fs.readdirSync(root), [SIGNAL_CONNECTOR_DIRECTORY]);
  now += 8 * 24 * 60 * 60 * 1000;
  assert.equal((await restarted.providerMetrics("provider-search-live"))[0].freshness, "stale");
}

async function assertAtomicQuotaAcrossRestartAndConcurrency() {
  const root = temporaryRoot("quota");
  const clock = () => Date.parse("2026-07-30T10:00:00.000Z");
  const firstRepository = createSignalConnectorRepository({ integrationRoot: root, clock });
  const secondRepository = createSignalConnectorRepository({ integrationRoot: root, clock });
  const first = await firstRepository.createJob(request({
    clientRequestId: "quota-request-first",
    dailyCallCap: 1,
    monthlyCallCap: 1,
    dailyCostCap: 0,
    monthlyCostCap: 0,
    costPerCall: 0
  }), { actor });
  const second = await secondRepository.createJob(request({
    clientRequestId: "quota-request-second",
    companyId: "company-stage231-two",
    tenantCompanyId: "tenant-stage231-two",
    dailyCallCap: 1,
    monthlyCallCap: 1,
    dailyCostCap: 0,
    monthlyCostCap: 0,
    costPerCall: 0
  }), { actor });
  const caps = first.job.quota;
  const concurrent = await Promise.allSettled([
    firstRepository.reserveQuota({ reservationKey: "quota-reservation-first", jobId: first.job.jobId, providerId: first.job.providerId, calls: 1, cost: 0, caps }, actor),
    secondRepository.reserveQuota({ reservationKey: "quota-reservation-second", jobId: second.job.jobId, providerId: second.job.providerId, calls: 1, cost: 0, caps }, actor)
  ]);
  assert.equal(concurrent.filter((row) => row.status === "fulfilled").length, 1);
  assert.equal(concurrent.filter((row) => row.status === "rejected" && row.reason.code === "SIGNAL_CONNECTOR_QUOTA_EXCEEDED").length, 1);
  assert.equal((await createSignalConnectorRepository({ integrationRoot: root, clock }).snapshot()).reservations.length, 1);
  const concurrentUsage = (await secondRepository.quotaUsage("provider-search-live"))[0];
  assert.equal(concurrentUsage.daily.calls, 1);
  assert.equal(concurrentUsage.daily.callCap, 1);

  let monthNow = Date.parse("2026-07-30T10:00:00.000Z");
  const monthRoot = temporaryRoot("monthly-quota");
  const monthRepository = createSignalConnectorRepository({ integrationRoot: monthRoot, clock: () => monthNow });
  const monthFirst = await monthRepository.createJob(request({
    clientRequestId: "monthly-quota-first",
    dailyCallCap: 1,
    monthlyCallCap: 1,
    costPerCall: 0,
    dailyCostCap: 0,
    monthlyCostCap: 0
  }), { actor });
  const monthSecond = await monthRepository.createJob(request({
    clientRequestId: "monthly-quota-second",
    companyId: "company-stage231-month-two",
    tenantCompanyId: "tenant-stage231-month-two",
    dailyCallCap: 1,
    monthlyCallCap: 1,
    costPerCall: 0,
    dailyCostCap: 0,
    monthlyCostCap: 0
  }), { actor });
  await monthRepository.reserveQuota({
    reservationKey: "monthly-reservation-first",
    jobId: monthFirst.job.jobId,
    providerId: monthFirst.job.providerId,
    calls: 1,
    cost: 0,
    caps: monthFirst.job.quota
  }, actor);
  monthNow += 24 * 60 * 60 * 1000;
  await assert.rejects(monthRepository.reserveQuota({
    reservationKey: "monthly-reservation-second",
    jobId: monthSecond.job.jobId,
    providerId: monthSecond.job.providerId,
    calls: 1,
    cost: 0,
    caps: monthSecond.job.quota
  }, actor), (error) => error.code === "SIGNAL_CONNECTOR_QUOTA_EXCEEDED");
}

async function assertRestartLeaseResume() {
  let now = Date.parse("2026-07-30T00:00:00.000Z");
  const root = temporaryRoot("lease-resume");
  const first = createSignalConnectorRepository({ integrationRoot: root, clock: () => now, leaseMs: 1_000 });
  const created = await first.createJob(request({ clientRequestId: "lease-resume-request" }), { actor });
  assert.equal((await first.claimNext({}, actor)).status, "running");
  const restarted = createSignalConnectorRepository({ integrationRoot: root, clock: () => now, leaseMs: 1_000 });
  await assert.rejects(restarted.resumeJob(created.job.jobId, actor), (error) => error.code === "SIGNAL_CONNECTOR_LEASE_ACTIVE");
  now += 1_001;
  assert.equal((await restarted.resumeJob(created.job.jobId, actor)).status, "queued");
}

async function assertRetryAndCategories() {
  let now = Date.parse("2026-07-30T00:00:00.000Z");
  const clock = () => now;
  const root = temporaryRoot("retry");
  const repository = createSignalConnectorRepository({ integrationRoot: root, clock });
  let calls = 0;
  const adapter = realAdapter("provider-retry-live", async (input) => {
    calls += 1;
    if (calls === 1) {
      const error = new Error("too many requests");
      error.statusCode = 429;
      error.retryAfterSeconds = 120;
      throw error;
    }
    return { signals: liveSignals(input), externalNetworkCalls: 0 };
  });
  const service = createSignalConnectorService({ repository, adapters: { [adapter.id]: adapter }, env: { NODE_ENV: "production" }, clock, retryBaseMs: 1_000 });
  await service.enqueue(request({ clientRequestId: "retry-request-0001", providerId: adapter.id }), { actor });
  const retry = await service.runNext({}, { actor });
  assert.equal(retry.job.status, "retry-wait");
  assert.equal(retry.job.error.category, "429");
  assert.equal(Date.parse(retry.job.nextAttemptAt) - now, 120_000);
  assert.equal((await service.runNext({}, { actor })).claimed, false);
  now += 120_000;
  const completed = await service.runNext({}, { actor });
  assert.equal(completed.job.status, "completed");
  assert.equal(completed.job.attempts, 2);
  assert.equal((await repository.snapshot()).reservations.length, 2);

  const examples = [
    [{ statusCode: 429 }, "429"],
    [{ statusCode: 401 }, "auth"],
    [{ code: "DAILY_QUOTA_EXCEEDED" }, "quota"],
    [{ code: "EMPTY_RESULT" }, "empty"],
    [{ code: "SCHEMA_INVALID" }, "schema"],
    [{ code: "ETIMEDOUT" }, "timeout"]
  ];
  for (const [reason, expected] of examples) assert.equal(classifyProviderError(reason), expected);
}

async function assertKillCancelResumeAndScheduler() {
  const root = temporaryRoot("operations");
  const clock = () => Date.parse("2026-07-30T00:00:00.000Z");
  const repository = createSignalConnectorRepository({ integrationRoot: root, clock });
  let calls = 0;
  let slow = false;
  const adapter = realAdapter("provider-operations-live", async (input) => {
    calls += 1;
    if (slow) {
      await new Promise((resolve, reject) => {
        input.signal.addEventListener("abort", () => {
          const error = new Error("cancelled");
          error.name = "AbortError";
          reject(error);
        }, { once: true });
      });
    }
    return { signals: liveSignals(input), externalNetworkCalls: 0 };
  });
  const service = createSignalConnectorService({ repository, adapters: { [adapter.id]: adapter }, env: { NODE_ENV: "production" }, clock });

  const killed = await service.enqueue(request({ clientRequestId: "kill-request-0001", providerId: adapter.id }), { actor });
  await repository.setKillSwitch(adapter.id, true, actor, "manual-test-stop");
  const blocked = await service.runNext({}, { actor });
  assert.equal(blocked.job.status, "failed");
  assert.equal(blocked.job.error.code, "SIGNAL_CONNECTOR_KILL_SWITCH_OPEN");
  assert.equal(calls, 0);
  assert.equal((await repository.snapshot()).reservations.length, 0);
  await service.resumeProvider(adapter.id, { actor });
  await service.resume(killed.job.jobId, { actor });
  assert.equal((await service.runNext({}, { actor })).job.status, "completed");
  assert.equal(calls, 1);

  slow = true;
  const cancellable = await service.enqueue(request({
    clientRequestId: "cancel-request-0001",
    providerId: adapter.id,
    companyId: "company-stage231-cancel",
    tenantCompanyId: "tenant-stage231-cancel"
  }), { actor });
  const running = service.runNext({}, { actor });
  for (let index = 0; index < 100 && (await repository.getJob(cancellable.job.jobId)).status !== "running"; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  await service.cancel(cancellable.job.jobId, { actor, reason: "operator-stop" });
  assert.equal((await running).job.status, "cancelled");
  slow = false;
  await service.resume(cancellable.job.jobId, { actor });
  assert.equal((await service.runNext({}, { actor })).job.status, "completed");

  const scheduleRequest = request({
    providerId: adapter.id,
    companyId: "company-stage231-scheduled",
    tenantCompanyId: "tenant-stage231-scheduled"
  });
  assert.equal((await service.schedule("2026-07-30", [scheduleRequest], { actor })).stopped, true);
  await service.enableScheduler({ actor });
  const ticks = await Promise.all([
    service.schedule("2026-07-30", [scheduleRequest], { actor }),
    service.schedule("2026-07-30", [scheduleRequest], { actor })
  ]);
  assert.equal(ticks.reduce((sum, row) => sum + row.created, 0), 1);
  assert.equal(ticks.reduce((sum, row) => sum + row.deduplicated, 0), 1);
  const scheduledJobs = (await repository.listJobs()).filter((job) => job.scheduleKey);
  assert.equal(scheduledJobs.length, 1);
  await service.stopScheduler({ actor, reason: "operator-stop" });
  assert.equal((await service.schedule("2026-07-31", [scheduleRequest], { actor })).stopped, true);
}

async function assertFixtureIsolationAndSchemaFailures() {
  const fixtureRoot = temporaryRoot("fixture");
  const fixtureRepository = createSignalConnectorRepository({
    integrationRoot: fixtureRoot,
    clock: () => Date.parse("2026-07-30T00:00:00.000Z"),
    env: { NODE_ENV: "test" }
  });
  const fixtureAdapter = createDeterministicInsightsFixtureProvider();
  const fixtureRequest = request({
    clientRequestId: "fixture-request-0001",
    mode: "fixture",
    providerId: INSIGHTS_PROVIDER_ID,
    signalKinds: INSIGHTS_SIGNAL_KINDS,
    costPerCall: 0,
    dailyCostCap: 0,
    monthlyCostCap: 0
  });
  const production = createSignalConnectorService({ repository: fixtureRepository, fixtureAdapter, env: { NODE_ENV: "production" } });
  await assert.rejects(production.enqueue(fixtureRequest, { actor }), (error) => error.code === "SIGNAL_CONNECTOR_FIXTURE_FORBIDDEN");
  const testService = createSignalConnectorService({ repository: fixtureRepository, fixtureAdapter, env: { NODE_ENV: "test" } });
  await testService.enqueue(fixtureRequest, { actor });
  assert.equal((await testService.runNext({}, { actor })).job.status, "completed");
  const fixtureRows = await fixtureRepository.listSignals();
  assert.equal(fixtureRows.length, INSIGHTS_SIGNAL_KINDS.length);
  assert.ok(fixtureRows.every((row) => row.synthetic === true));
  assert.equal((await testService.diagnostics()).externalNetworkCalls, 0);

  for (const scenario of [
    { id: "provider-empty-live", result: { signals: [], externalNetworkCalls: 0 }, category: "empty" },
    { id: "provider-schema-live", result: { signals: [{ kind: "search.volume", index: 50, observedAt: "2026-07-30T00:00:00.000Z" }], externalNetworkCalls: 0 }, category: "schema" }
  ]) {
    const root = temporaryRoot(scenario.id);
    const repository = createSignalConnectorRepository({ integrationRoot: root, clock: () => Date.parse("2026-07-30T00:00:00.000Z") });
    const adapter = realAdapter(scenario.id, async () => scenario.result);
    const service = createSignalConnectorService({ repository, adapters: { [adapter.id]: adapter }, env: { NODE_ENV: "production" } });
    await service.enqueue(request({ clientRequestId: `${scenario.id}-request`, providerId: adapter.id, maxAttempts: 1 }), { actor });
    const result = await service.runNext({}, { actor });
    assert.equal(result.job.status, "failed");
    assert.equal(result.job.error.category, scenario.category);
  }

  const timeoutRoot = temporaryRoot("timeout");
  const timeoutRepository = createSignalConnectorRepository({ integrationRoot: timeoutRoot, clock: () => Date.parse("2026-07-30T00:00:00.000Z") });
  const timeoutAdapter = realAdapter("provider-timeout-live", async () => new Promise(() => {}));
  const timeoutService = createSignalConnectorService({ repository: timeoutRepository, adapters: { [timeoutAdapter.id]: timeoutAdapter }, env: { NODE_ENV: "production" } });
  await timeoutService.enqueue(request({ clientRequestId: "timeout-request-0001", providerId: timeoutAdapter.id, maxAttempts: 1, timeoutMs: 100 }), { actor });
  const timeout = await timeoutService.runNext({}, { actor });
  assert.equal(timeout.job.status, "failed");
  assert.equal(timeout.job.error.category, "timeout");
}

async function main() {
  global.fetch = async () => {
    networkCalls += 1;
    throw new Error("Unexpected external network call");
  };
  try {
    await assertContractReuse();
    await assertDefaultClosedAndLiveFlow();
    await assertAtomicQuotaAcrossRestartAndConcurrency();
    await assertRestartLeaseResume();
    await assertRetryAndCategories();
    await assertKillCancelResumeAndScheduler();
    await assertFixtureIsolationAndSchemaFailures();
    assert.equal(networkCalls, 0);
    process.stdout.write("Stage 231 signal connector lifecycle, quota, retry, kill, scheduler, live boundary and network-zero tests passed\n");
  } finally {
    global.fetch = originalFetch;
    for (const root of roots) {
      const resolved = path.resolve(root);
      assert.ok(resolved.startsWith(path.resolve(os.tmpdir())), `refusing to remove non-temp path ${resolved}`);
      fs.rmSync(resolved, { recursive: true, force: true });
    }
  }
}

main().catch((error) => {
  global.fetch = originalFetch;
  console.error(error);
  process.exitCode = 1;
});
