"use strict";

const crypto = require("node:crypto");
const {
  FRESH_COLLECTION_STAGES,
  createObservation,
  createRawEvidence,
  issueV2CompanyId
} = require("./fresh_collection_service.cjs");
const {
  createSyntheticFreshCollectionProvider
} = require("./fresh_collection_provider.cjs");

const STAGE_PROGRESS = Object.freeze({
  discovery: 15,
  quick: 40,
  detail: 70,
  ota: 90,
  finalize: 100
});

const RETRYABLE_CODES = new Set([
  "ETIMEDOUT",
  "ECONNRESET",
  "ECONNREFUSED",
  "PROVIDER_RATE_LIMIT",
  "PROVIDER_TIMEOUT",
  "PROVIDER_UNAVAILABLE",
  "SYNTHETIC_TRANSIENT"
]);

function cleanText(value, maximum = 240) {
  return String(value || "").normalize("NFKC").replace(/\s+/g, " ").trim().slice(0, maximum);
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function unwrap(value, key) {
  if (value && typeof value === "object" && value[key]) return value[key];
  return value;
}

function classifyCollectionFailure(error) {
  const code = cleanText(error?.code || "FRESH_COLLECTION_STAGE_FAILED", 80);
  const retryable = error?.retryable === true || RETRYABLE_CODES.has(code);
  return {
    code,
    message: cleanText(error?.message || "Fresh collection stage failed", 300),
    retryable,
    retryAfterMs: Math.max(0, Number(error?.retryAfterMs || 0) || 0),
    statusCode: Number(error?.statusCode || (retryable ? 503 : 422))
  };
}

function retryBackoffMs(attempt, options = {}) {
  const baseMs = Math.max(1, Number(options.baseMs || 1000));
  const maximumMs = Math.max(baseMs, Number(options.maximumMs || 60000));
  return Math.min(maximumMs, baseMs * (2 ** Math.max(0, Number(attempt || 1) - 1)));
}

async function appendObservationBatches(repository, records, options = {}) {
  const rows = Array.isArray(records) ? records : [];
  const batchSize = Math.max(1, Math.min(5000, Number(options.batchSize || 1000)));
  const result = { requested: rows.length, inserted: 0, duplicates: 0, batches: 0 };
  for (let offset = 0; offset < rows.length; offset += batchSize) {
    const batch = rows.slice(offset, offset + batchSize);
    const written = await repository.appendObservations(batch, {
      actor: options.actor,
      runId: options.runId
    });
    result.batches += 1;
    result.inserted += Number(written?.inserted ?? written?.insertedCount ?? batch.length) || 0;
    result.duplicates += Number(written?.duplicates ?? written?.duplicateCount ?? 0) || 0;
  }
  return result;
}

function profileObservations(run, companyId, raw, response) {
  const common = {
    runId: run.runId,
    companyId,
    observedAt: response.collectedAt,
    targetDate: (run.input || run.request || {}).targetDate,
    channel: "naver-search",
    productKey: "company",
    rawEvidenceId: raw.rawEvidenceId,
    sourceUrl: response.source,
    provider: response.provider,
    synthetic: response.synthetic,
    dataMode: response.dataMode
  };
  return [
    ["profile.company-name", response.profile.companyName, "text"],
    ["profile.region", response.profile.regionLabel, "text"],
    ["profile.category", response.profile.category, "text"],
    ["profile.rank", response.profile.rank, "rank"],
    ["profile.review-count", response.profile.reviewCount, "count"],
    ["profile.location", { latitude: response.profile.latitude, longitude: response.profile.longitude }, "coordinate"]
  ].filter(([kind, value]) => {
    if (value === null || value === undefined || value === "") return false;
    if (kind === "profile.location") {
      return value.latitude !== null && value.latitude !== undefined && value.latitude !== ""
        && value.longitude !== null && value.longitude !== undefined && value.longitude !== ""
        && Number.isFinite(Number(value.latitude)) && Number.isFinite(Number(value.longitude));
    }
    return true;
  }).map(([kind, value, unit], sequence) => createObservation({
    ...common,
    kind,
    value,
    unit,
    sequence,
    requestKey: kind === "profile.rank" ? response.profile.rankingCondition?.requestKey : "",
    conditionHash: kind === "profile.rank" ? response.profile.rankingCondition?.conditionHash : ""
  }));
}

function detailObservations(run, companyId, raw, response) {
  const observations = [];
  for (const [productIndex, product] of (response.products || []).entries()) {
    const common = {
      runId: run.runId,
      companyId,
      observedAt: response.collectedAt,
      targetDate: product.targetDate || (run.input || run.request || {}).targetDate,
      channel: "direct",
      productKey: product.productKey,
      rawEvidenceId: raw.rawEvidenceId,
      sourceUrl: response.source,
      provider: response.provider,
      synthetic: response.synthetic,
      dataMode: response.dataMode
    };
    for (const [offset, kind, value, unit] of [
      [0, "product.price", product.price, "KRW"],
      [1, "product.total-stock", product.totalStock, "room"],
      [2, "product.available-stock", product.availableStock, "room"]
    ]) {
      if (value === null || value === undefined || value === "") continue;
      observations.push(createObservation({ ...common, kind, value, unit, sequence: productIndex * 3 + offset }));
    }
  }
  return observations;
}

function otaObservations(run, companyId, raw, response) {
  return (response.channels || []).filter((row) => typeof row.exposed === "boolean").map((row, sequence) => createObservation({
    runId: run.runId,
    companyId,
    observedAt: response.collectedAt,
    targetDate: row.targetDate || (run.input || run.request || {}).targetDate,
    channel: row.channel,
    productKey: row.productKey,
    kind: "ota.exposure",
    value: Boolean(row.exposed),
    unit: "boolean",
    rawEvidenceId: raw.rawEvidenceId,
    sourceUrl: row.sourceUrl || response.source,
    provider: row.provider || response.provider,
    requestKey: row.requestKey || "",
    synthetic: response.synthetic,
    dataMode: response.dataMode,
    sequence
  }));
}

function leaseFrom(value, run) {
  const lease = value?.lease || run?.lease || {};
  return {
    leaseId: value?.leaseId || lease.leaseId || run?.leaseId || "",
    expiresAt: value?.expiresAt || lease.expiresAt || run?.leaseExpiresAt || ""
  };
}

function runRows(value) {
  return Array.isArray(value) ? value : (Array.isArray(value?.runs) ? value.runs : []);
}

function executionStagesForRun(run = {}) {
  const configured = Array.isArray(run.executionStages)
    ? run.executionStages
    : (Array.isArray(run.collectionPlan?.executionStages) ? run.collectionPlan.executionStages : null);
  const fallbackModes = Array.isArray(run.requestedModes) ? run.requestedModes : ["quick", "detail", "ota"];
  const stages = configured || [
    "discovery",
    ...["quick", "detail", "ota"].filter((stage) => fallbackModes.includes(stage)),
    "finalize"
  ];
  if (!stages.length
    || stages[0] !== "discovery"
    || stages.at(-1) !== "finalize"
    || stages.some((stage) => !FRESH_COLLECTION_STAGES.includes(stage))
    || new Set(stages).size !== stages.length) {
    throw Object.assign(new Error("Persisted collection executionStages are invalid"), {
      code: "FRESH_EXECUTION_STAGES_INVALID",
      retryable: false
    });
  }
  return stages;
}

function detailTargetDates(run = {}) {
  const input = run.input || run.request || {};
  const plan = run.collectionPlan || {};
  const single = cleanText(input.targetDate || plan.checkIn, 16);
  if (plan.collectWeeklyRange !== true) {
    if (single) return [single];
    throw Object.assign(new Error("Persisted detail targetDate is missing"), {
      code: "FRESH_DETAIL_DATE_RANGE_INVALID",
      retryable: false
    });
  }
  const start = cleanText(plan.checkIn || input.checkIn || single, 16);
  const end = cleanText(plan.checkOut || input.checkOut || start, 16);
  const startMs = Date.parse(`${start}T00:00:00.000Z`);
  const endMs = Date.parse(`${end}T00:00:00.000Z`);
  const canonicalStart = Number.isFinite(startMs) ? new Date(startMs).toISOString().slice(0, 10) : "";
  const canonicalEnd = Number.isFinite(endMs) ? new Date(endMs).toISOString().slice(0, 10) : "";
  if (canonicalStart !== start || canonicalEnd !== end || endMs < startMs) {
    throw Object.assign(new Error("Persisted detail collection date range is invalid"), {
      code: "FRESH_DETAIL_DATE_RANGE_INVALID",
      retryable: false
    });
  }
  const dates = [];
  for (let cursor = startMs; cursor <= endMs && dates.length < 31; cursor += 86_400_000) {
    dates.push(new Date(cursor).toISOString().slice(0, 10));
  }
  return dates;
}

function isDue(value, now) {
  const timestamp = Date.parse(value || "");
  return !Number.isFinite(timestamp) || timestamp <= now;
}

function isLeaseExpired(run, now) {
  const expiresAt = run?.lease?.expiresAt || run?.leaseExpiresAt || "";
  const timestamp = Date.parse(expiresAt);
  return Number.isFinite(timestamp) && timestamp <= now;
}

function hasActiveLease(run, now) {
  const expiresAt = run?.lease?.expiresAt || run?.leaseExpiresAt || "";
  const timestamp = Date.parse(expiresAt);
  return Boolean(run?.lease?.leaseId || run?.leaseId) && Number.isFinite(timestamp) && timestamp > now;
}

function leaseOwner(run) {
  return cleanText(run?.lease?.workerId || run?.lease?.owner || run?.leaseOwner, 120);
}

function createFreshCollectionWorker(options = {}) {
  const repository = options.repository;
  const provider = options.provider || createSyntheticFreshCollectionProvider({ clock: options.clock });
  const clock = options.clock || (() => Date.now());
  const workerId = cleanText(options.workerId || `fresh-worker-${process.pid}`, 120);
  const leaseSeconds = Math.max(5, Number(options.leaseSeconds || 30));
  const maxAttempts = Math.max(1, Number(options.maxAttempts || 4));
  const batchSize = Math.max(1, Math.min(5000, Number(options.batchSize || 1000)));
  const backoff = {
    baseMs: Number(options.retryBaseMs || 1000),
    maximumMs: Number(options.retryMaximumMs || 60000)
  };
  const actor = Object.freeze({
    type: "worker",
    id: workerId,
    actorType: "worker",
    actorId: workerId
  });
  const metrics = {
    claimedRuns: 0,
    completedRuns: 0,
    cancelledRuns: 0,
    failedRuns: 0,
    retryScheduled: 0,
    recoveredRuns: 0,
    rawEvidenceInserted: 0,
    observationsInserted: 0,
    observationDuplicates: 0
  };

  if (!repository) throw new Error("Fresh collection repository is required");
  for (const method of [
    "getRun", "listRuns", "acquireRunLease", "heartbeatRun", "discoverCompany",
    "appendRawEvidence", "appendObservations", "cancelRun", "resumeRun", "completeRun",
    "failRun", "refreshDerivedProfile"
  ]) {
    if (typeof repository[method] !== "function") throw new Error(`Fresh collection repository.${method} is required`);
  }
  for (const method of ["discover", "collectQuick", "collectDetail", "collectOta", "diagnostics"]) {
    if (typeof provider?.[method] !== "function") throw new Error(`Fresh collection provider.${method} is required`);
  }
  if (!cleanText(provider.id, 120) || !["synthetic", "live", "disabled"].includes(cleanText(provider.kind, 40))) {
    throw new Error("Fresh collection provider must declare an id and synthetic, live, or disabled kind");
  }

  function normalizeResponse(response = {}) {
    const expectedSynthetic = provider.kind === "synthetic";
    const synthetic = response.synthetic === true;
    const dataMode = synthetic ? "synthetic-test" : cleanText(response.dataMode, 32).toLowerCase();
    if (
      !response
      || cleanText(response.provider, 120) !== provider.id
      || synthetic !== expectedSynthetic
      || dataMode !== (expectedSynthetic ? "synthetic-test" : "live")
    ) {
      throw Object.assign(new Error("Provider response provenance does not match the configured provider"), {
        code: "FRESH_PROVIDER_PROVENANCE_INVALID",
        retryable: false,
        statusCode: 502
      });
    }
    return { ...response, synthetic, dataMode };
  }

  async function invokeProvider(stage, method, input) {
    const before = provider.diagnostics();
    try {
      return normalizeResponse(await provider[method](input));
    } finally {
      const after = provider.diagnostics();
      const beforeCalls = Number(before?.externalNetworkCalls || before?.externalRequests || 0);
      const afterCalls = Number(after?.externalNetworkCalls || after?.externalRequests || 0);
      const calls = Math.max(0, afterCalls - beforeCalls);
      if (calls && provider.durableQuota !== true && typeof repository.recordProviderUsage === "function") {
        await repository.recordProviderUsage({
          provider: provider.id,
          stage,
          runId: input.runId,
          calls
        }, actor);
      }
    }
  }

  async function appendStageData(run, companyId, stage, response, observations, appendOptions = {}) {
    const raw = createRawEvidence({
      runId: run.runId,
      companyId,
      stage,
      sourceUrl: response.source,
      observedAt: response.collectedAt,
      provider: response.provider,
      synthetic: response.synthetic,
      dataMode: response.dataMode,
      evidenceKey: appendOptions.evidenceKey || "",
      payload: response
    });
    const rawResult = await repository.appendRawEvidence([raw], { actor, runId: run.runId });
    metrics.rawEvidenceInserted += Number(rawResult?.inserted ?? rawResult?.insertedCount ?? 1) || 0;
    const rows = observations(raw);
    const appended = await appendObservationBatches(repository, rows, {
      actor,
      runId: run.runId,
      batchSize
    });
    metrics.observationsInserted += appended.inserted;
    metrics.observationDuplicates += appended.duplicates;
    return { raw, observations: rows, append: appended };
  }

  async function appendOtaStageData(run, companyId, response) {
    const rows = [];
    let firstRawEvidenceId = "";
    for (const channel of (response.channels || [])) {
      const channelResponse = {
        ...response,
        provider: channel.provider || response.provider,
        source: channel.sourceUrl || response.source,
        sources: [channel.sourceUrl || response.source],
        channels: [channel]
      };
      const raw = createRawEvidence({
        runId: run.runId,
        companyId,
        stage: "ota",
        sourceUrl: channelResponse.source,
        observedAt: response.collectedAt,
        provider: channelResponse.provider,
        synthetic: response.synthetic,
        dataMode: response.dataMode,
        evidenceKey: `ota:${channel.provider || response.provider}:${channel.requestKey || channel.channel || "channel"}`,
        payload: channelResponse
      });
      const rawResult = await repository.appendRawEvidence([raw], { actor, runId: run.runId });
      metrics.rawEvidenceInserted += Number(rawResult?.inserted ?? rawResult?.insertedCount ?? 1) || 0;
      if (!firstRawEvidenceId) firstRawEvidenceId = raw.rawEvidenceId;
      rows.push(...otaObservations(run, companyId, raw, channelResponse));
    }
    const appended = await appendObservationBatches(repository, rows, { actor, runId: run.runId, batchSize });
    metrics.observationsInserted += appended.inserted;
    metrics.observationDuplicates += appended.duplicates;
    return { rawEvidenceId: firstRawEvidenceId, observationCount: rows.length };
  }

  async function executeStage(run, stage) {
    const persistedInput = run.input || run.request || {};
    const input = { ...persistedInput, companyId: run.companyId || run.checkpoint?.companyId || "" };
    if (stage === "discovery") {
      const response = await invokeProvider(stage, "discover", { ...input, runId: run.runId });
      const issuedCompanyId = issueV2CompanyId(response.candidate);
      const discovered = await repository.discoverCompany({
        companyId: issuedCompanyId,
        runId: run.runId,
        targetId: run.targetId,
        tenantCompanyId: persistedInput.tenantCompanyId || run.tenantCompanyId || "",
        actorAccountId: run.actorAccountId || persistedInput.actorAccountId || "",
        ...response.candidate,
        source: response.provider,
        sourceUrl: response.source,
        observedAt: response.collectedAt,
        synthetic: response.synthetic,
        dataMode: response.dataMode
      }, actor);
      const company = unwrap(discovered, "company") || { companyId: issuedCompanyId };
      const companyId = company.companyId || issuedCompanyId;
      const raw = createRawEvidence({
        runId: run.runId,
        companyId,
        stage,
        sourceUrl: response.source,
        observedAt: response.collectedAt,
        provider: response.provider,
        synthetic: response.synthetic,
        dataMode: response.dataMode,
        payload: response
      });
      const rawResult = await repository.appendRawEvidence([raw], { actor, runId: run.runId });
      metrics.rawEvidenceInserted += Number(rawResult?.inserted ?? rawResult?.insertedCount ?? 1) || 0;
      return { companyId, rawEvidenceId: raw.rawEvidenceId, observationCount: 0 };
    }
    const companyId = run.companyId || run.checkpoint?.companyId;
    if (!companyId) throw Object.assign(new Error("Discovery checkpoint is missing companyId"), {
      code: "FRESH_COMPANY_CHECKPOINT_MISSING",
      retryable: false
    });
    if (stage === "quick") {
      const response = await invokeProvider(stage, "collectQuick", { ...input, companyId, runId: run.runId });
      const written = await appendStageData(run, companyId, stage, response, (raw) => (
        profileObservations(run, companyId, raw, response)
      ));
      return { companyId, rawEvidenceId: written.raw.rawEvidenceId, observationCount: written.observations.length };
    }
    if (stage === "detail") {
      let rawEvidenceId = "";
      let observationCount = 0;
      const targetDates = detailTargetDates(run);
      for (const targetDate of targetDates) {
        const response = await invokeProvider(stage, "collectDetail", {
          ...input,
          companyId,
          runId: run.runId,
          targetDate
        });
        const written = await appendStageData(run, companyId, stage, response, (raw) => (
          detailObservations({ ...run, input: { ...(run.input || run.request || {}), targetDate } }, companyId, raw, response)
        ), { evidenceKey: `detail:${targetDate}` });
        rawEvidenceId ||= written.raw.rawEvidenceId;
        observationCount += written.observations.length;
      }
      return { companyId, rawEvidenceId, observationCount, targetDates };
    }
    if (stage === "ota") {
      const response = await invokeProvider(stage, "collectOta", { ...input, companyId, runId: run.runId });
      const written = await appendOtaStageData(run, companyId, response);
      return { companyId, rawEvidenceId: written.rawEvidenceId, observationCount: written.observationCount };
    }
    if (stage === "finalize") {
      const derived = await repository.refreshDerivedProfile(companyId, actor);
      return { companyId, derived: unwrap(derived, "profile") || derived };
    }
    throw Object.assign(new Error(`Unsupported collection stage: ${stage}`), {
      code: "FRESH_STAGE_INVALID",
      retryable: false
    });
  }

  async function terminalCancel(run, leaseId) {
    const cancelled = await repository.cancelRun(run.runId, {
      leaseId,
      reason: run.cancelReason || "cancel-requested",
      checkpoint: run.checkpoint || {}
    }, actor);
    metrics.cancelledRuns += 1;
    return { claimed: true, terminal: true, run: unwrap(cancelled, "run"), outcome: "cancelled" };
  }

  async function processRun(runId, processOptions = {}) {
    const current = await repository.getRun(runId);
    if (!current) return { claimed: false, terminal: false, run: null, outcome: "not-found" };
    if (["completed", "cancelled", "failed"].includes(current.status)) {
      return { claimed: false, terminal: true, run: current, outcome: current.status };
    }
    if (current.status === "cancel-requested") {
      const cancelled = await repository.cancelRun(current.runId, {
        reason: current.cancelReason || "cancel-requested",
        checkpoint: current.checkpoint || {}
      }, actor);
      metrics.cancelledRuns += 1;
      return { claimed: true, terminal: true, run: unwrap(cancelled, "run"), outcome: "cancelled" };
    }
    if (current.status === "retry-wait" && !isDue(current.nextAttemptAt, clock())) {
      return { claimed: false, terminal: false, run: current, outcome: "retry-wait" };
    }

    let acquired;
    const continuingOwnedLease = current.status === "running"
      && leaseOwner(current) === workerId
      && hasActiveLease(current, clock());
    if (continuingOwnedLease) {
      acquired = { run: current, lease: current.lease || null, leaseId: current.leaseId || current.lease?.leaseId || "" };
    } else {
      try {
        acquired = await repository.acquireRunLease(runId, { workerId, leaseSeconds }, actor);
      } catch (error) {
        if (["FRESH_RUN_LEASE_HELD", "FRESH_LEASE_CONFLICT", "FRESH_RUN_NOT_LEASEABLE"].includes(error?.code)) {
          return { claimed: false, terminal: false, run: current, outcome: "lease-held" };
        }
        throw error;
      }
    }
    let run = unwrap(acquired, "run") || await repository.getRun(runId);
    const lease = leaseFrom(acquired, run);
    if (!lease.leaseId) throw new Error("Repository did not return a durable collection leaseId");
    if (!continuingOwnedLease) metrics.claimedRuns += 1;
    const stageBudget = Number.isFinite(Number(processOptions.stageBudget))
      ? Math.max(0, Number(processOptions.stageBudget))
      : Number.POSITIVE_INFINITY;
    let stagesProcessed = 0;

    while (stagesProcessed < stageBudget) {
      run = await repository.getRun(runId);
      if (run.status === "cancel-requested") {
        return terminalCancel(run, lease.leaseId);
      }
      const checkpoint = clone(run.checkpoint || {});
      const stage = checkpoint.nextStage || run.currentStage || "discovery";
      const executionStages = executionStagesForRun(run);
      const stageIndex = executionStages.indexOf(stage);
      if (stageIndex < 0) throw new Error(`Invalid persisted collection stage: ${stage}`);
      const attempts = { ...(checkpoint.attempts || {}) };
      attempts[stage] = Number(attempts[stage] || 0) + 1;
      checkpoint.attempts = attempts;

      try {
        const stageResult = await executeStage(run, stage);
        const nextStage = executionStages[stageIndex + 1] || "completed";
        checkpoint.companyId = stageResult.companyId || checkpoint.companyId || run.companyId || "";
        checkpoint.completedStages = Array.from(new Set([...(checkpoint.completedStages || []), stage]));
        checkpoint.nextStage = nextStage;
        checkpoint.lastStageResult = {
          stage,
          rawEvidenceId: stageResult.rawEvidenceId || "",
          observationCount: Number(stageResult.observationCount || 0)
        };

        if (stage === "finalize") {
          const completed = await repository.completeRun(runId, {
            leaseId: lease.leaseId,
            companyId: checkpoint.companyId,
            progress: 100,
            currentStage: "completed",
            checkpoint,
            result: {
              companyId: checkpoint.companyId,
              derivedProfile: stageResult.derived || null,
              dataBoundary: "fresh-only",
              provider: provider.id,
              dataMode: provider.kind === "synthetic" ? "synthetic-test" : "live"
            }
          }, actor);
          metrics.completedRuns += 1;
          return { claimed: true, terminal: true, run: unwrap(completed, "run"), outcome: "completed" };
        }

        const heartbeated = await repository.heartbeatRun(runId, {
          leaseId: lease.leaseId,
          leaseSeconds,
          companyId: checkpoint.companyId,
          progress: STAGE_PROGRESS[stage],
          currentStage: nextStage,
          checkpoint
        }, actor);
        run = unwrap(heartbeated, "run") || await repository.getRun(runId);
        stagesProcessed += 1;
      } catch (error) {
        const failure = classifyCollectionFailure(error);
        const attempt = attempts[stage];
        const retryable = failure.retryable && attempt < maxAttempts;
        const delayMs = Math.max(failure.retryAfterMs, retryBackoffMs(attempt, backoff));
        const failed = await repository.failRun(runId, {
          leaseId: lease.leaseId,
          code: failure.code,
          message: failure.message,
          retryable,
          terminal: !retryable,
          attempt,
          currentStage: stage,
          checkpoint,
          nextAttemptAt: retryable ? new Date(clock() + delayMs).toISOString() : ""
        }, actor);
        if (retryable) metrics.retryScheduled += 1;
        else metrics.failedRuns += 1;
        return {
          claimed: true,
          terminal: !retryable,
          run: unwrap(failed, "run"),
          outcome: retryable ? "retry-scheduled" : "failed",
          failure
        };
      }
    }
    return {
      claimed: true,
      terminal: false,
      run: await repository.getRun(runId),
      outcome: "stage-budget-exhausted"
    };
  }

  async function recover() {
    const now = clock();
    const rows = runRows(await repository.listRuns({
      statuses: ["running", "retry-wait", "cancel-requested"]
    }));
    const recovered = [];
    for (const run of rows) {
      if (run.status === "cancel-requested") {
        const value = await repository.cancelRun(run.runId, {
          reason: run.cancelReason || "cancel-requested-during-recovery",
          checkpoint: run.checkpoint || {}
        }, actor);
        recovered.push(unwrap(value, "run"));
        metrics.cancelledRuns += 1;
        continue;
      }
      if (run.status === "retry-wait" && isDue(run.nextAttemptAt, now)) {
        const value = await repository.resumeRun(run.runId, {
          reason: "retry-backoff-elapsed",
          preserveCheckpoint: true
        }, actor);
        recovered.push(unwrap(value, "run"));
        metrics.recoveredRuns += 1;
        continue;
      }
      if (run.status === "running" && isLeaseExpired(run, now)) {
        // acquireRunLease owns the atomic expired-lease takeover. Keeping the
        // status here avoids an unlock-then-claim race between two workers.
        recovered.push(run);
        metrics.recoveredRuns += 1;
      }
    }
    return { ok: true, recovered };
  }

  async function processNext(processOptions = {}) {
    await recover();
    const rows = runRows(await repository.listRuns({ statuses: ["queued", "running"] }));
    const candidate = rows.find((run) => run.status === "running" && leaseOwner(run) === workerId && hasActiveLease(run, clock()))
      || rows.find((run) => run.status === "running" && !hasActiveLease(run, clock()))
      || rows.find((run) => run.status === "queued");
    if (!candidate) return { claimed: false, terminal: false, run: null, outcome: "idle" };
    return processRun(candidate.runId, processOptions);
  }

  async function nextWakeDelayMs(options = {}) {
    const now = clock();
    const maximumMs = Math.max(1, Math.min(2_147_483_647, Number(options.maximumMs || 60_000)));
    const rows = runRows(await repository.listRuns({
      statuses: ["queued", "running", "retry-wait", "cancel-requested"]
    }));
    if (!rows.length) return null;
    let earliestDelay = Number.POSITIVE_INFINITY;
    for (const run of rows) {
      if (run.status === "queued" || run.status === "cancel-requested") return 0;
      if (run.status === "running") {
        if (!hasActiveLease(run, now) || leaseOwner(run) === workerId) return 0;
        const expiresAt = Date.parse(run?.lease?.expiresAt || run?.leaseExpiresAt || "");
        if (Number.isFinite(expiresAt)) earliestDelay = Math.min(earliestDelay, Math.max(0, expiresAt - now));
        continue;
      }
      if (run.status === "retry-wait") {
        const dueAt = Date.parse(run.nextAttemptAt || "");
        if (!Number.isFinite(dueAt) || dueAt <= now) return 0;
        earliestDelay = Math.min(earliestDelay, dueAt - now);
      }
    }
    return Number.isFinite(earliestDelay) ? Math.min(maximumMs, Math.max(1, earliestDelay)) : maximumMs;
  }

  async function drain(options = {}) {
    const maximumRuns = Math.max(1, Number(options.maximumRuns || 100));
    const outcomes = [];
    for (let index = 0; index < maximumRuns; index += 1) {
      const outcome = await processNext(options);
      outcomes.push(outcome);
      if (!outcome.claimed) break;
    }
    return { ok: true, outcomes, idle: outcomes.at(-1)?.outcome === "idle" };
  }

  return Object.freeze({
    workerId,
    providerId: provider.id,
    providerKind: provider.kind,
    providerEnabled: provider.enabled !== false && provider.kind !== "disabled",
    dataMode: provider.kind === "synthetic" ? "synthetic-test" : "live",
    processRun,
    processNext,
    drain,
    recover,
    nextWakeDelayMs,
    diagnostics() {
      return {
        ...clone(metrics),
        workerId,
        leaseSeconds,
        maxAttempts,
        observationBatchSize: batchSize,
        providerId: provider.id,
        providerKind: provider.kind,
        providerEnabled: provider.enabled !== false && provider.kind !== "disabled",
        dataMode: provider.kind === "synthetic" ? "synthetic-test" : "live",
        provider: provider.diagnostics()
      };
    }
  });
}

module.exports = {
  RETRYABLE_CODES,
  STAGE_PROGRESS,
  appendObservationBatches,
  classifyCollectionFailure,
  createFreshCollectionWorker,
  detailObservations,
  detailTargetDates,
  executionStagesForRun,
  otaObservations,
  profileObservations,
  retryBackoffMs
};
