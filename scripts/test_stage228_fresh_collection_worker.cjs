"use strict";

const assert = require("node:assert/strict");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const {
  SyntheticProviderError,
  createSyntheticFreshCollectionProvider
} = require("./integration/services/fresh_collection_provider.cjs");
const {
  FreshCollectionError,
  createFreshCollectionService,
  createObservation,
  issueV2CompanyId
} = require("./integration/services/fresh_collection_service.cjs");
const {
  appendObservationBatches,
  createFreshCollectionWorker,
  retryBackoffMs
} = require("./integration/services/fresh_collection_worker.cjs");
const { createFreshIntegrationRepository } = require("./integration/repositories/fresh_store.cjs");
const { createFreshPlatformRuntime } = require("./integration/bootstrap/fresh_platform_runtime.cjs");
const {
  deterministicCompanyId,
  normalizeCompanyIdentity
} = require("./integration/contracts/fresh_data.cjs");

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function createMemoryRepository(options = {}) {
  const clock = options.clock || (() => Date.now());
  const state = {
    targets: new Map(),
    companies: new Map(),
    runs: new Map(),
    raw: new Map(),
    observations: new Map(),
    audit: [],
    sequence: 0
  };

  function nowIso() {
    return new Date(clock()).toISOString();
  }

  function audit(action, runId, actor) {
    state.audit.push({ action, runId, actor: clone(actor), at: nowIso() });
  }

  function mutableRun(runId) {
    const run = state.runs.get(runId);
    if (!run) throw Object.assign(new Error("run not found"), { code: "FRESH_RUN_NOT_FOUND", statusCode: 404 });
    return run;
  }

  function verifyLease(run, leaseId) {
    if (!run.lease || run.lease.leaseId !== leaseId) {
      throw Object.assign(new Error("lease conflict"), { code: "FRESH_LEASE_CONFLICT", statusCode: 409 });
    }
  }

  const repository = {
    async seedTarget(payload, actor) {
      const existing = state.targets.get(payload.targetId);
      if (existing) return { idempotent: true, target: clone(existing) };
      const target = { ...clone(payload), createdAt: nowIso() };
      state.targets.set(target.targetId, target);
      audit("target.seed", "", actor);
      return { idempotent: false, target: clone(target) };
    },
    async createRun(payload, actor) {
      const existing = [...state.runs.values()].find((row) => row.clientRequestId === payload.clientRequestId);
      if (existing) {
        if (existing.requestSignature !== payload.requestSignature) {
          throw Object.assign(new Error("idempotency conflict"), {
            code: "FRESH_RUN_IDEMPOTENCY_CONFLICT",
            statusCode: 409
          });
        }
        return { idempotent: true, run: clone(existing) };
      }
      const createdAt = nowIso();
      const run = {
        ...clone(payload),
        status: "queued",
        createdAt,
        startedAt: "",
        completedAt: "",
        cancelledAt: "",
        failedAt: "",
        lease: null,
        revision: 1
      };
      state.runs.set(run.runId, run);
      audit("run.create", run.runId, actor);
      return { idempotent: false, run: clone(run) };
    },
    async getRun(runId) {
      return clone(state.runs.get(runId) || null);
    },
    async listRuns(filter = {}) {
      let rows = [...state.runs.values()];
      if (filter.clientRequestId) rows = rows.filter((row) => row.clientRequestId === filter.clientRequestId);
      if (filter.actorAccountId) rows = rows.filter((row) => row.actorAccountId === filter.actorAccountId);
      if (Array.isArray(filter.statuses)) rows = rows.filter((row) => filter.statuses.includes(row.status));
      return clone(rows);
    },
    async acquireRunLease(runId, payload, actor) {
      const run = mutableRun(runId);
      const expires = Date.parse(run.lease?.expiresAt || "");
      if (run.lease && expires > clock() && run.lease.workerId !== payload.workerId) {
        throw Object.assign(new Error("lease held"), { code: "FRESH_RUN_LEASE_HELD", statusCode: 409 });
      }
      if (!run.lease || expires <= clock()) {
        state.sequence += 1;
        run.lease = {
          leaseId: `lease_${state.sequence}`,
          workerId: payload.workerId,
          acquiredAt: nowIso(),
          heartbeatAt: nowIso(),
          expiresAt: new Date(clock() + payload.leaseSeconds * 1000).toISOString()
        };
      } else {
        run.lease.expiresAt = new Date(clock() + payload.leaseSeconds * 1000).toISOString();
      }
      run.status = "running";
      run.startedAt ||= nowIso();
      audit("run.lease.acquire", runId, actor);
      return { run: clone(run), lease: clone(run.lease), leaseId: run.lease.leaseId };
    },
    async heartbeatRun(runId, payload, actor) {
      const run = mutableRun(runId);
      verifyLease(run, payload.leaseId);
      run.lease.heartbeatAt = nowIso();
      run.lease.expiresAt = new Date(clock() + payload.leaseSeconds * 1000).toISOString();
      run.progress = payload.progress;
      run.currentStage = payload.currentStage;
      run.companyId = payload.companyId || run.companyId;
      run.checkpoint = clone(payload.checkpoint);
      run.revision += 1;
      audit("run.heartbeat", runId, actor);
      return { run: clone(run), lease: clone(run.lease) };
    },
    async discoverCompany(payload, actor) {
      const existing = state.companies.get(payload.companyId);
      if (existing) return { idempotent: true, company: clone(existing), duplicateCandidates: [] };
      const company = {
        ...clone(payload),
        createdAt: nowIso(),
        externalIdentities: clone(payload.externalIdentities || []),
        duplicateCandidates: clone(payload.duplicateCandidates || [])
      };
      state.companies.set(company.companyId, company);
      audit("company.discover", payload.runId, actor);
      return { idempotent: false, company: clone(company), duplicateCandidates: [] };
    },
    async appendRawEvidence(records, context) {
      let inserted = 0;
      let duplicates = 0;
      for (const row of records) {
        if (state.raw.has(row.rawEvidenceId)) duplicates += 1;
        else {
          state.raw.set(row.rawEvidenceId, clone(row));
          inserted += 1;
        }
      }
      audit("raw.append", context.runId, context.actor);
      return { inserted, duplicates };
    },
    async appendObservations(records, context) {
      let inserted = 0;
      let duplicates = 0;
      for (const row of records) {
        if (state.observations.has(row.observationId)) duplicates += 1;
        else {
          state.observations.set(row.observationId, clone(row));
          inserted += 1;
        }
      }
      audit("observation.append", context.runId, context.actor);
      return { inserted, duplicates };
    },
    async requestRunCancel(runId, payload, actor) {
      const run = mutableRun(runId);
      if (run.status === "cancel-requested" || run.status === "cancelled") {
        return { idempotent: true, run: clone(run) };
      }
      run.status = "cancel-requested";
      run.cancelReason = payload.reason;
      run.cancelRequestedAt = nowIso();
      audit("run.cancel.request", runId, actor);
      return { idempotent: false, run: clone(run) };
    },
    async cancelRun(runId, payload, actor) {
      const run = mutableRun(runId);
      if (run.status === "cancelled") return { idempotent: true, run: clone(run) };
      run.status = "cancelled";
      run.cancelReason = payload.reason;
      run.cancelledAt = nowIso();
      run.checkpoint = clone(payload.checkpoint || run.checkpoint);
      run.lease = null;
      audit("run.cancel", runId, actor);
      return { idempotent: false, run: clone(run) };
    },
    async resumeRun(runId, payload, actor) {
      const run = mutableRun(runId);
      if (run.status === "queued") return { idempotent: true, run: clone(run) };
      run.status = "queued";
      run.lease = null;
      run.nextAttemptAt = "";
      run.cancelRequestedAt = "";
      run.cancelReason = "";
      run.resumeReason = payload.reason;
      audit("run.resume", runId, actor);
      return { idempotent: false, run: clone(run) };
    },
    async completeRun(runId, payload, actor) {
      const run = mutableRun(runId);
      verifyLease(run, payload.leaseId);
      run.status = "completed";
      run.progress = 100;
      run.currentStage = "completed";
      run.companyId = payload.companyId;
      run.checkpoint = clone(payload.checkpoint);
      run.result = clone(payload.result);
      run.completedAt = nowIso();
      run.lease = null;
      audit("run.complete", runId, actor);
      return { run: clone(run) };
    },
    async failRun(runId, payload, actor) {
      const run = mutableRun(runId);
      verifyLease(run, payload.leaseId);
      run.status = payload.terminal ? "failed" : "retry-wait";
      run.currentStage = payload.currentStage;
      run.checkpoint = clone(payload.checkpoint);
      run.nextAttemptAt = payload.nextAttemptAt;
      run.lastError = { code: payload.code, message: payload.message, attempt: payload.attempt };
      run.failedAt = payload.terminal ? nowIso() : "";
      run.lease = null;
      audit(payload.terminal ? "run.fail" : "run.retry.schedule", runId, actor);
      return { run: clone(run) };
    },
    async refreshDerivedProfile(companyId, actor) {
      const company = state.companies.get(companyId);
      const observations = [...state.observations.values()].filter((row) => row.companyId === companyId);
      const kinds = new Set(observations.map((row) => row.kind));
      const expected = ["profile.company-name", "product.price", "product.available-stock", "ota.exposure"];
      const completeness = expected.filter((kind) => kinds.has(kind)).length / expected.length;
      const profile = {
        companyId,
        companyName: company.companyName,
        completeness,
        freshness: observations.length ? "fresh" : "missing",
        confidence: completeness === 1 ? "high" : "review",
        enrichmentCta: completeness === 1 ? null : "collect-missing-fields"
      };
      company.derivedProfile = profile;
      audit("profile.derived.refresh", "", actor);
      return { profile: clone(profile) };
    }
  };

  return {
    repository,
    snapshot() {
      return {
        targets: clone([...state.targets.values()]),
        companies: clone([...state.companies.values()]),
        runs: clone([...state.runs.values()]),
        raw: clone([...state.raw.values()]),
        observations: clone([...state.observations.values()]),
        audit: clone(state.audit)
      };
    }
  };
}

function payload(suffix, overrides = {}) {
  return {
    clientRequestId: `stage228-request-${suffix}`,
    targetName: "합성 바다 글램핑",
    regionCode: "gyeongnam",
    regionLabel: "경남 통영",
    targetDate: "2026-08-15",
    kind: "admin-collection",
    collectionMode: "precision",
    productMode: "all",
    tenantCompanyId: "company_admin",
    ...overrides
  };
}

async function testVerticalSliceAndIdempotency() {
  let now = Date.parse("2026-07-29T00:00:00.000Z");
  const clock = () => now;
  const memory = createMemoryRepository({ clock });
  let idSequence = 0;
  const provider = createSyntheticFreshCollectionProvider({ clock });
  const service = createFreshCollectionService({
    repository: memory.repository,
    clock,
    idFactory: (prefix) => `${prefix}_${++idSequence}`
  });
  const worker = createFreshCollectionWorker({
    repository: memory.repository,
    provider,
    clock,
    workerId: "worker-vertical"
  });
  const actor = { accountId: "admin_1", role: "admin" };
  const originalFetch = global.fetch;
  let networkCalls = 0;
  global.fetch = async () => {
    networkCalls += 1;
    throw new Error("Network must not be called");
  };
  try {
    const submitted = await service.submit(payload("vertical"), actor);
    assert.equal(submitted.idempotent, false);
    assert.equal(submitted.job.kind, "admin-collection");
    assert.equal(submitted.run.actorAccountId, "admin_1");
    const completed = await worker.processRun(submitted.run.runId);
    assert.equal(completed.outcome, "completed");
    const snapshot = memory.snapshot();
    assert.equal(snapshot.targets.length, 1);
    assert.equal(snapshot.companies.length, 1);
    assert.match(snapshot.companies[0].companyId, /^cmp_place_syn\d+$/);
    assert.equal(snapshot.raw.length, 4);
    assert.equal(snapshot.observations.length, 14);
    assert.ok(snapshot.observations.every((row) => (
      row.source && row.runId && row.observedAt && row.targetDate && row.channel && row.productKey
      && row.provenance?.provider && row.provenance?.sourceUrl.endsWith(".invalid/") === false
      && new URL(row.provenance.sourceUrl).hostname.endsWith(".example.invalid")
    )));
    assert.ok(snapshot.observations.every((row) => row.provenance.synthetic === true));
    assert.equal(networkCalls, 0);
    assert.equal(provider.diagnostics().externalNetworkCalls, 0);

    const replay = await service.submit(payload("vertical"), actor);
    assert.equal(replay.idempotent, true);
    assert.equal(replay.run.runId, submitted.run.runId);
    const terminalReplay = await worker.processRun(submitted.run.runId);
    assert.equal(terminalReplay.claimed, false);
    assert.equal(memory.snapshot().observations.length, 14);
    await assert.rejects(
      () => service.submit(payload("vertical", { targetName: "다른 업체" }), actor),
      (error) => error instanceof FreshCollectionError
        && error.code === "FRESH_COLLECTION_IDEMPOTENCY_CONFLICT"
        && error.statusCode === 409
    );
    const lookup = await service.getByClientRequestId(payload("vertical").clientRequestId, actor);
    assert.equal(lookup.run.runId, submitted.run.runId);
    await assert.rejects(
      () => service.cancel(submitted.run.runId, {}, { accountId: "business_other", role: "b2b" }),
      (error) => error.code === "FRESH_RUN_FORBIDDEN" && error.statusCode === 403
    );

    now += 60_000;
    const repeated = await service.submit(payload("repeat"), actor);
    await worker.processRun(repeated.run.runId);
    const repeatedSnapshot = memory.snapshot();
    assert.equal(repeatedSnapshot.observations.length, 28);
    const firstKey = repeatedSnapshot.observations[0];
    assert.ok(repeatedSnapshot.observations.some((row) => (
      row.runId !== firstKey.runId
      && row.companyId === firstKey.companyId
      && row.productKey === firstKey.productKey
      && row.targetDate === firstKey.targetDate
    )));
  } finally {
    global.fetch = originalFetch;
  }
}

async function testRetryClassificationAndResume() {
  let now = Date.parse("2026-07-29T01:00:00.000Z");
  const clock = () => now;
  const memory = createMemoryRepository({ clock });
  const provider = createSyntheticFreshCollectionProvider({
    clock,
    failurePlan: {
      detail: [new SyntheticProviderError("synthetic rate limit", {
        code: "PROVIDER_RATE_LIMIT",
        retryable: true,
        retryAfterMs: 2500
      })]
    }
  });
  const service = createFreshCollectionService({ repository: memory.repository, clock, idFactory: () => "fresh_run_retry" });
  const worker = createFreshCollectionWorker({
    repository: memory.repository,
    provider,
    clock,
    workerId: "worker-retry",
    retryBaseMs: 1000
  });
  const submitted = await service.submit(payload("retry"), { accountId: "admin_2", role: "admin" });
  const scheduled = await worker.processRun(submitted.run.runId);
  assert.equal(scheduled.outcome, "retry-scheduled");
  assert.equal(scheduled.run.status, "retry-wait");
  assert.equal(scheduled.run.lastError.code, "PROVIDER_RATE_LIMIT");
  assert.equal(memory.snapshot().observations.length, 5);
  now += 2499;
  assert.equal((await worker.recover()).recovered.length, 0);
  now += 1;
  assert.equal((await worker.recover()).recovered.length, 1);
  const completed = await worker.processRun(submitted.run.runId);
  assert.equal(completed.outcome, "completed");
  assert.equal(memory.snapshot().observations.length, 14);
  assert.equal(worker.diagnostics().retryScheduled, 1);
  assert.equal(retryBackoffMs(3, { baseMs: 1000, maximumMs: 10000 }), 4000);
}

async function testCancelResumeAndRestartRecovery() {
  let now = Date.parse("2026-07-29T02:00:00.000Z");
  const clock = () => now;
  const memory = createMemoryRepository({ clock });
  let sequence = 0;
  const provider = createSyntheticFreshCollectionProvider({ clock });
  const service = createFreshCollectionService({
    repository: memory.repository,
    clock,
    idFactory: () => `fresh_run_recovery_${++sequence}`
  });

  const cancelRun = await service.submit(payload("cancel"), { accountId: "admin_3", role: "admin" });
  const cancelWorker = createFreshCollectionWorker({
    repository: memory.repository,
    provider,
    clock,
    workerId: "worker-cancel",
    leaseSeconds: 5
  });
  await cancelWorker.processRun(cancelRun.run.runId, { stageBudget: 1 });
  assert.equal(memory.snapshot().raw.length, 1);
  await service.cancel(cancelRun.run.runId, { reason: "test-cancel" }, { accountId: "admin_3" });
  const cancelled = await cancelWorker.processRun(cancelRun.run.runId);
  assert.equal(cancelled.outcome, "cancelled");
  assert.equal(memory.snapshot().observations.length, 0);
  await service.resume(cancelRun.run.runId, { reason: "test-resume" }, { accountId: "admin_3" });
  const resumed = await cancelWorker.processRun(cancelRun.run.runId);
  assert.equal(resumed.outcome, "completed");
  assert.equal(memory.snapshot().observations.length, 14);
  assert.equal(memory.snapshot().raw.length, 4);

  now += 60_000;
  const restartRun = await service.submit(payload("restart"), { accountId: "admin_3", role: "admin" });
  const firstProcess = createFreshCollectionWorker({
    repository: memory.repository,
    provider,
    clock,
    workerId: "worker-before-restart",
    leaseSeconds: 5
  });
  const interrupted = await firstProcess.processRun(restartRun.run.runId, { stageBudget: 2 });
  assert.equal(interrupted.outcome, "stage-budget-exhausted");
  assert.equal(interrupted.run.checkpoint.nextStage, "detail");
  const observationsBeforeRestart = memory.snapshot().observations.length;
  now += 5001;
  const afterRestart = createFreshCollectionWorker({
    repository: memory.repository,
    provider,
    clock,
    workerId: "worker-after-restart",
    leaseSeconds: 5
  });
  const recovery = await afterRestart.recover();
  assert.equal(recovery.recovered.length, 1);
  const completed = await afterRestart.processRun(restartRun.run.runId);
  assert.equal(completed.outcome, "completed");
  assert.equal(memory.snapshot().observations.length - observationsBeforeRestart, 9);
  assert.equal(afterRestart.diagnostics().recoveredRuns, 1);
}

async function testBatchBoundaryAndProvenanceGuard() {
  const records = Array.from({ length: 10000 }, (_, index) => createObservation({
    runId: "fresh_run_benchmark",
    companyId: "cmp_place_syn1234567",
    kind: "benchmark.available-stock",
    observedAt: `2026-07-29T03:${String(Math.floor(index / 60) % 60).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}.000Z`,
    targetDate: "2026-08-15",
    channel: "synthetic-benchmark",
    productKey: `product-${index}`,
    value: index % 8,
    unit: "room",
    rawEvidenceId: `raw_benchmark_${index}`,
    sourceUrl: `https://collector.example.invalid/benchmark/${index}`,
    sequence: index
  }));
  let callCount = 0;
  let rowCount = 0;
  const repository = {
    async appendObservations(batch) {
      callCount += 1;
      rowCount += batch.length;
      return { inserted: batch.length, duplicates: 0 };
    }
  };
  const result = await appendObservationBatches(repository, records, {
    batchSize: 1000,
    runId: "fresh_run_benchmark",
    actor: { type: "test" }
  });
  assert.equal(result.requested, 10000);
  assert.equal(result.inserted, 10000);
  assert.equal(result.batches, 10);
  assert.equal(callCount, 10);
  assert.equal(rowCount, 10000);
  assert.ok(records.every((row) => row.provenance?.provider && row.provenance?.runId));
  assert.throws(() => createObservation({
    runId: "fresh_run_bad",
    companyId: "cmp_bad",
    kind: "bad",
    observedAt: "2026-07-29T00:00:00.000Z",
    targetDate: "2026-08-15",
    channel: "bad",
    productKey: "bad",
    rawEvidenceId: "raw_bad",
    sourceUrl: "https://real-provider.example.com/value"
  }), /example\.invalid/);
  assert.equal(issueV2CompanyId({ placeId: "12345", companyName: "새 업체" }), "cmp_place_12345");
  assert.match(issueV2CompanyId({ companyName: "새 업체", regionLabel: "경남" }), /^cmp_[a-f0-9]{16}$/);
  const legalPrefixCandidate = {
    companyName: "주식회사 바다 글램핑",
    regionLabel: "경남 통영",
    address: "경남 통영시 합성로 1",
    bookingBusinessId: "booking-legal-prefix-1"
  };
  const canonicalLegalIdentity = normalizeCompanyIdentity(legalPrefixCandidate);
  assert.equal(canonicalLegalIdentity.nameKey, "바다글램핑");
  assert.equal(
    issueV2CompanyId(legalPrefixCandidate),
    deterministicCompanyId(canonicalLegalIdentity)
  );
}

async function testDurableRepositoryVerticalSlice() {
  let now = Date.parse("2026-07-29T04:00:00.000Z");
  const clock = () => now;
  const temporaryRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "glamping-stage228-worker-"));
  const dataDir = path.join(temporaryRoot, "fresh-store");
  let idSequence = 0;
  const repositoryOptions = {
    dataDir,
    env: {},
    projectRoot: path.resolve(__dirname, ".."),
    clock,
    idFactory: () => `durable${++idSequence}`
  };
  try {
    const repository = createFreshIntegrationRepository(repositoryOptions);
    const bootstrap = await repository.initialize();
    assert.equal(bootstrap.counts.observations, 0);
    const provider = createSyntheticFreshCollectionProvider({ clock });
    const service = createFreshCollectionService({
      repository,
      clock,
      idFactory: () => `fresh_run_durable_${++idSequence}`
    });
    const worker = createFreshCollectionWorker({
      repository,
      provider,
      clock,
      workerId: "worker-durable",
      leaseSeconds: 5
    });
    const submitted = await service.submit(payload("durable"), { accountId: "admin_durable", role: "admin" });
    const completed = await worker.processRun(submitted.run.runId);
    assert.equal(completed.outcome, "completed");
    assert.equal((await repository.listObservations({ runId: submitted.run.runId })).length, 14);
    const storedRun = await repository.getRun(submitted.run.runId);
    assert.equal(storedRun.status, "completed");
    assert.equal(storedRun.actorAccountId, "admin_durable");
    assert.equal(storedRun.checkpoint.nextStage, "completed");
    const company = await repository.getCompany(storedRun.checkpoint.companyId, { projection: "business-safe" });
    assert.equal(company.sourceBoundary, "fresh-integration-only");
    assert.equal(company.dataQuality.dataCompleteness.score, 100);

    now += 60_000;
    const restartedRepository = createFreshIntegrationRepository(repositoryOptions);
    const restartedBootstrap = await restartedRepository.initialize();
    assert.equal(restartedBootstrap.counts.observations, 14);
    const recoveredRun = await restartedRepository.getRun(submitted.run.runId);
    assert.equal(recoveredRun.status, "completed");
    const diagnostics = await restartedRepository.diagnostics();
    assert.equal(diagnostics.providerCalls, 0);
    assert.equal(diagnostics.legacyRuntimeReads, 0);
    assert.equal(diagnostics.legacyRuntimeCopies, 0);
    assert.equal(diagnostics.companyIdCollisions, 0);

    const restartService = createFreshCollectionService({
      repository: restartedRepository,
      clock,
      idFactory: () => `fresh_run_process_restart_${++idSequence}`
    });
    const interruptedRun = await restartService.submit(
      payload("durable-restart"),
      { accountId: "admin_durable", role: "admin" }
    );
    const beforeRestartWorker = createFreshCollectionWorker({
      repository: restartedRepository,
      provider: createSyntheticFreshCollectionProvider({ clock }),
      clock,
      workerId: "worker-durable-before-restart",
      leaseSeconds: 5
    });
    const interrupted = await beforeRestartWorker.processRun(interruptedRun.run.runId, { stageBudget: 2 });
    assert.equal(interrupted.outcome, "stage-budget-exhausted");
    assert.equal(interrupted.run.checkpoint.nextStage, "detail");
    now += 5001;
    const processRestartRepository = createFreshIntegrationRepository(repositoryOptions);
    await processRestartRepository.initialize();
    const afterRestartWorker = createFreshCollectionWorker({
      repository: processRestartRepository,
      provider: createSyntheticFreshCollectionProvider({ clock }),
      clock,
      workerId: "worker-durable-after-restart",
      leaseSeconds: 5
    });
    assert.equal((await afterRestartWorker.recover()).recovered.length, 1);
    const recovered = await afterRestartWorker.processRun(interruptedRun.run.runId);
    assert.equal(recovered.outcome, "completed");
    assert.equal((await processRestartRepository.listObservations({ runId: interruptedRun.run.runId })).length, 14);
  } finally {
    const resolvedTemporaryRoot = path.resolve(temporaryRoot);
    if (path.basename(resolvedTemporaryRoot).startsWith("glamping-stage228-worker-")) {
      await fsp.rm(resolvedTemporaryRoot, { recursive: true, force: true });
    }
  }
}

function runtimeAuthBoundary() {
  return {
    service: {
      assertRequestBoundary() {},
      assertRecentReauthentication() {},
      async assertCompanyAccess() {}
    },
    http: {
      requestContext() { return {}; },
      sessionForRequest() { return null; }
    }
  };
}

function createRuntimeOptions(temporaryRoot, overrides = {}) {
  return {
    env: { V2_INTEGRATION_FRESH_PROVIDER: "synthetic" },
    projectRoot: path.resolve(__dirname, ".."),
    dataDir: path.join(temporaryRoot, "fresh-store"),
    legacyPaths: [path.join(temporaryRoot, "legacy-never-read")],
    authRuntime: runtimeAuthBoundary(),
    send() {},
    async parseBody() { return {}; },
    workerId: "stage228-runtime-worker",
    leaseSeconds: 5,
    pumpStageBudget: 1,
    pumpYieldMs: 5_000,
    ...overrides
  };
}

const RUNTIME_ADMIN_SESSION = Object.freeze({
  accountId: "admin_runtime",
  account: Object.freeze({ role: "admin" }),
  memberships: Object.freeze([])
});

async function waitForTerminalRun(repository, runId, timeoutMs = 4_000) {
  const deadline = Date.now() + timeoutMs;
  const statuses = [];
  while (Date.now() < deadline) {
    const run = await repository.getRun(runId);
    statuses.push(run.status);
    if (["completed", "cancelled", "failed"].includes(run.status)) return { run, statuses };
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for fresh run ${runId}; statuses=${statuses.join(",")}`);
}

async function testRuntimeQueuedProgressCancelAndCleanup() {
  let now = Date.parse("2026-07-29T05:00:00.000Z");
  const temporaryRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "glamping-stage228-runtime-flow-"));
  const runtime = createFreshPlatformRuntime(createRuntimeOptions(temporaryRoot, {
    clock: () => now,
    workerId: "runtime-flow-worker"
  }));
  try {
    await runtime.initialize();
    const submitted = await runtime.service.submitCollection(
      RUNTIME_ADMIN_SESSION,
      payload("runtime-flow", { tenantCompanyId: "" })
    );
    assert.equal(submitted.run.status, "queued", "HTTP service submission must return before collection begins");
    assert.equal(submitted.outcome, "queued");
    assert.equal(submitted.job.status, "running", "Stage 227 projection keeps queued work observable");
    assert.equal(runtime.runner.diagnostics().wakeScheduled, true);

    const firstStage = await runtime.runner.pump("test-first-stage");
    assert.equal(firstStage.outcome, "stage-budget-exhausted");
    const progressing = await runtime.repository.getRun(submitted.run.runId);
    assert.equal(progressing.status, "running");
    assert.equal(progressing.progress, 15);
    assert.equal(progressing.checkpoint.nextStage, "quick");

    const cancelRequested = await runtime.service.cancelJob(
      RUNTIME_ADMIN_SESSION,
      submitted.run.clientRequestId,
      { reason: "runtime-cancel-interleave" }
    );
    assert.equal(cancelRequested.run.status, "cancel-requested");
    await runtime.runner.pump("test-cancel");
    assert.equal((await runtime.repository.getRun(submitted.run.runId)).status, "cancelled");

    const resumed = await runtime.service.resumeJob(
      RUNTIME_ADMIN_SESSION,
      submitted.run.clientRequestId,
      { reason: "runtime-resume" }
    );
    assert.equal(resumed.run.status, "queued");
    for (let index = 0; index < 4; index += 1) {
      await runtime.runner.pump(`test-resumed-stage-${index + 1}`);
    }
    const completed = await runtime.repository.getRun(submitted.run.runId);
    assert.equal(completed.status, "completed");
    assert.equal(completed.progress, 100);
    assert.equal((await runtime.repository.listObservations({ runId: completed.runId })).length, 14);
  } finally {
    const closed = await runtime.close();
    assert.equal(closed.runner.stopped, true);
    assert.equal(closed.runner.wakeScheduled, false, "runtime close must clear the unref timer");
    await fsp.rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function testRuntimeStartupRecoveryAutomaticallyAdvancesExpiredLease() {
  let now = Date.parse("2026-07-29T06:00:00.000Z");
  const temporaryRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "glamping-stage228-runtime-restart-"));
  let beforeRestart;
  let afterRestart;
  try {
    beforeRestart = createFreshPlatformRuntime(createRuntimeOptions(temporaryRoot, {
      clock: () => now,
      workerId: "runtime-before-restart"
    }));
    await beforeRestart.initialize();
    const submitted = await beforeRestart.service.submitCollection(
      RUNTIME_ADMIN_SESSION,
      payload("runtime-restart", { tenantCompanyId: "" })
    );
    await beforeRestart.runner.pump("before-restart-discovery");
    await beforeRestart.runner.pump("before-restart-quick");
    const interrupted = await beforeRestart.repository.getRun(submitted.run.runId);
    assert.equal(interrupted.status, "running");
    assert.equal(interrupted.progress, 40);
    assert.equal(interrupted.checkpoint.nextStage, "detail");
    await beforeRestart.close();
    beforeRestart = null;

    now += 5_001;
    afterRestart = createFreshPlatformRuntime(createRuntimeOptions(temporaryRoot, {
      clock: () => now,
      workerId: "runtime-after-restart"
    }));
    const initialized = await afterRestart.initialize();
    assert.equal(initialized.recovery.recovered.length, 1);
    assert.equal(initialized.startupPump.claimed, true, "initialize must automatically claim recovered work");
    const advanced = await afterRestart.repository.getRun(submitted.run.runId);
    assert.equal(advanced.progress, 70);
    assert.equal(advanced.checkpoint.nextStage, "ota");
    await afterRestart.runner.pump("after-restart-ota");
    await afterRestart.runner.pump("after-restart-finalize");
    assert.equal((await afterRestart.repository.getRun(submitted.run.runId)).status, "completed");
  } finally {
    if (beforeRestart) await beforeRestart.close();
    if (afterRestart) await afterRestart.close();
    await fsp.rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function testRuntimeBackoffTimerAutomaticallyResumesDueRetry() {
  const temporaryRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "glamping-stage228-runtime-retry-"));
  const provider = createSyntheticFreshCollectionProvider({
    failurePlan: {
      detail: [new SyntheticProviderError("bounded runtime retry", {
        code: "SYNTHETIC_TRANSIENT",
        retryable: true,
        retryAfterMs: 40
      })]
    }
  });
  const runtime = createFreshPlatformRuntime(createRuntimeOptions(temporaryRoot, {
    provider,
    workerId: "runtime-retry-worker",
    retryBaseMs: 5,
    pumpYieldMs: 5,
    pumpMaximumTimerMs: 20
  }));
  try {
    await runtime.initialize();
    const submitted = await runtime.service.submitCollection(
      RUNTIME_ADMIN_SESSION,
      payload("runtime-retry", { tenantCompanyId: "" })
    );
    assert.equal(submitted.run.status, "queued");
    const terminal = await waitForTerminalRun(runtime.repository, submitted.run.runId);
    assert.equal(terminal.run.status, "completed");
    assert.ok(terminal.statuses.includes("retry-wait"), "timer acceptance must observe the persisted retry backoff");
    assert.equal(runtime.worker.diagnostics().retryScheduled, 1);
    assert.equal(provider.diagnostics().callsByStage.detail, 2);
    assert.ok(runtime.runner.diagnostics().cycles >= 6);
  } finally {
    await runtime.close();
    assert.equal(runtime.runner.diagnostics().wakeScheduled, false);
    await fsp.rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function main() {
  await testVerticalSliceAndIdempotency();
  await testRetryClassificationAndResume();
  await testCancelResumeAndRestartRecovery();
  await testBatchBoundaryAndProvenanceGuard();
  await testDurableRepositoryVerticalSlice();
  await testRuntimeQueuedProgressCancelAndCleanup();
  await testRuntimeStartupRecoveryAutomaticallyAdvancesExpiredLease();
  await testRuntimeBackoffTimerAutomaticallyResumesDueRetry();
  console.log("Stage 228 fresh collection worker tests passed");
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
