"use strict";

const crypto = require("node:crypto");
const {
  assertFreshSourceUrl,
  deterministicCompanyId,
  normalizeCompanyIdentity,
  stableHash
} = require("../contracts/fresh_data.cjs");
const { createV2CollectionPlan } = require("../contracts/v2_collection_plan.cjs");

const DEFAULT_SYNTHETIC_PROVIDER = Object.freeze({
  id: "stage228-synthetic-fresh-collection",
  kind: "synthetic",
  enabled: true,
  synthetic: true,
  dataMode: "synthetic-test",
  seedSourceUrl: "https://collector.example.invalid/stage228"
});

const FRESH_COLLECTION_KIND = "fresh-company-vertical-slice";
const FRESH_COLLECTION_STAGES = Object.freeze([
  "discovery",
  "quick",
  "detail",
  "ota",
  "finalize"
]);
const STAGE227_JOB_KINDS = new Set(["business-search", "business-my-lodge", "admin-collection"]);

class FreshCollectionError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "FreshCollectionError";
    this.code = options.code || "FRESH_COLLECTION_ERROR";
    this.statusCode = Number(options.statusCode || 500);
    this.retryable = Boolean(options.retryable);
    this.details = options.details || null;
  }
}

function cleanText(value, maximum = 240) {
  return String(value || "").normalize("NFKC").replace(/\s+/g, " ").trim().slice(0, maximum);
}

function normalizeIdentityText(value) {
  return cleanText(value, 240)
    .replace(/[^\p{L}\p{N}]+/gu, "")
    .toLowerCase();
}

function v2StableHash(value) {
  return crypto.createHash("sha1").update(String(value || "")).digest("hex").slice(0, 16);
}

function normalizeProviderDescriptor(provider = DEFAULT_SYNTHETIC_PROVIDER) {
  const kind = cleanText(provider.kind || (provider.synthetic === true ? "synthetic" : "disabled"), 40).toLowerCase();
  const enabled = provider.enabled !== false && kind !== "disabled";
  if (!enabled) {
    return Object.freeze({
      id: cleanText(provider.id || "fresh-provider-disabled", 120),
      kind: "disabled",
      enabled: false,
      synthetic: false,
      dataMode: "live",
      seedSourceUrl: ""
    });
  }
  const synthetic = provider.synthetic === true || kind === "synthetic";
  const descriptor = {
    id: cleanText(provider.id, 120),
    kind,
    enabled: true,
    synthetic,
    dataMode: synthetic ? "synthetic-test" : "live",
    seedSourceUrl: cleanText(provider.seedSourceUrl || provider.sourceUrl, 2048)
  };
  if (typeof provider.assertRequestScope === "function") {
    descriptor.assertRequestScope = provider.assertRequestScope.bind(provider);
  }
  if (!descriptor.id || !descriptor.seedSourceUrl) {
    throw new FreshCollectionError("Fresh collection provider identity and seedSourceUrl are required", {
      code: "FRESH_PROVIDER_CONTRACT_INVALID",
      statusCode: 500
    });
  }
  descriptor.seedSourceUrl = assertFreshSourceUrl(descriptor.seedSourceUrl, descriptor);
  return Object.freeze(descriptor);
}

// This is the bounded Stage 228 extraction of V2's canonical issuance rule:
// place identity wins; otherwise stable normalized identity fields issue cmp_<sha1:16>.
function issueV2CompanyId(candidate = {}) {
  try {
    return deterministicCompanyId(normalizeCompanyIdentity(candidate));
  } catch (error) {
    throw new FreshCollectionError(error.message, {
      code: error.code || "FRESH_COMPANY_IDENTITY_INVALID",
      statusCode: Number(error.statusCode || 422)
    });
  }
}

function cleanClientRequestId(value) {
  const id = cleanText(value, 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(id)) {
    throw new FreshCollectionError("clientRequestId must be 8-128 URL-safe characters", {
      code: "FRESH_CLIENT_REQUEST_ID_INVALID",
      statusCode: 400
    });
  }
  return id;
}

function strictDate(value, label = "targetDate") {
  const text = cleanText(value, 16);
  const timestamp = Date.parse(`${text}T00:00:00.000Z`);
  const canonical = Number.isFinite(timestamp) ? new Date(timestamp).toISOString().slice(0, 10) : "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || canonical !== text) {
    throw new FreshCollectionError(`${label} must use YYYY-MM-DD`, {
      code: "FRESH_TARGET_DATE_INVALID",
      statusCode: 400
    });
  }
  return text;
}

function normalizeRequest(payload = {}) {
  const targetName = cleanText(payload.targetName || payload.keyword || payload.companyName, 180);
  const regionCode = cleanText(payload.regionCode || payload.regionLabel || "", 80);
  const targetDate = cleanText(payload.targetDate, 16);
  if (!targetName) {
    throw new FreshCollectionError("targetName is required", {
      code: "FRESH_TARGET_NAME_REQUIRED",
      statusCode: 400
    });
  }
  strictDate(targetDate);
  return {
    clientRequestId: cleanClientRequestId(payload.clientRequestId),
    targetName,
    discoveryQuery: cleanText(payload.discoveryQuery || targetName, 180),
    rankingQuery: cleanText(payload.rankingQuery, 180),
    regionCode,
    regionLabel: cleanText(payload.regionLabel || regionCode, 120),
    targetDate,
    checkIn: cleanText(payload.checkIn || targetDate, 16),
    checkOut: cleanText(payload.checkOut, 16),
    collectionMode: cleanText(payload.collectionMode || "precision", 32),
    collectionPurpose: cleanText(payload.collectionPurpose || "revenue_detail", 40),
    productMode: cleanText(payload.productMode || "all", 32),
    detailRankRanges: cleanText(payload.detailRankRanges, 80),
    bookingRangePlaceLimit: Number.isFinite(Number(payload.bookingRangePlaceLimit))
      ? Math.max(0, Math.min(20, Math.floor(Number(payload.bookingRangePlaceLimit))))
      : null,
    tenantCompanyId: cleanText(payload.tenantCompanyId, 160),
    kind: STAGE227_JOB_KINDS.has(cleanText(payload.kind, 48))
      ? cleanText(payload.kind, 48)
      : "admin-collection"
  };
}

function requestSignature(payload = {}) {
  const normalized = normalizeRequest(payload);
  const canonical = {
    targetName: normalizeIdentityText(normalized.targetName),
    discoveryQuery: normalizeIdentityText(normalized.discoveryQuery),
    rankingQuery: normalizeIdentityText(normalized.rankingQuery),
    regionCode: normalizeIdentityText(normalized.regionCode),
    targetDate: normalized.targetDate,
    checkIn: normalized.checkIn,
    checkOut: normalized.checkOut,
    collectionMode: normalized.collectionMode,
    collectionPurpose: normalized.collectionPurpose,
    productMode: normalized.productMode,
    detailRankRanges: normalized.detailRankRanges,
    bookingRangePlaceLimit: normalized.bookingRangePlaceLimit,
    tenantCompanyId: normalized.tenantCompanyId,
    kind: normalized.kind
  };
  return crypto.createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

function unwrap(value, key) {
  if (value && typeof value === "object" && value[key]) return value[key];
  return value;
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function collectionError(error) {
  if (error instanceof FreshCollectionError) return error;
  if (error?.code === "FRESH_RUN_IDEMPOTENCY_CONFLICT" || error?.code === "FRESH_IDEMPOTENCY_CONFLICT") {
    return new FreshCollectionError("clientRequestId is already bound to a different request", {
      code: "FRESH_COLLECTION_IDEMPOTENCY_CONFLICT",
      statusCode: 409
    });
  }
  return error;
}

function assertRunOwnership(run = {}, actor = {}) {
  const accountId = cleanText(actor.accountId || actor.actorAccountId || actor.id, 160);
  const ownerId = cleanText(run.actorAccountId || run.request?.actorAccountId, 160);
  const role = cleanText(actor.role || actor.actorRole || actor.account?.role, 48);
  if (!accountId || role === "admin") return;
  if (!ownerId || ownerId !== accountId) {
    throw new FreshCollectionError("Fresh collection run belongs to another account", {
      code: "FRESH_RUN_FORBIDDEN",
      statusCode: 403
    });
  }
}

function observationId(input = {}) {
  return `obs_${stableHash([
    input.runId,
    input.companyId,
    input.kind,
    input.targetDate,
    input.channel,
    input.productKey,
    input.sequence || 0
  ].join("|"), 32, "sha256")}`;
}

function rawEvidenceId(input = {}) {
  return `raw_${stableHash([
    input.runId,
    input.companyId,
    input.stage,
    input.sourceUrl,
    input.evidenceKey || input.targetDate || ""
  ].join("|"), 32, "sha256")}`;
}

function createRawEvidence(input = {}) {
  const synthetic = input.synthetic !== false;
  const dataMode = synthetic ? "synthetic-test" : cleanText(input.dataMode, 32).toLowerCase();
  const sourceUrl = assertFreshSourceUrl(input.sourceUrl, { synthetic, dataMode });
  const provider = cleanText(input.provider || input.source || (synthetic ? DEFAULT_SYNTHETIC_PROVIDER.id : ""), 120);
  if (!provider) throw new FreshCollectionError("Raw evidence provider is required", {
    code: "FRESH_PROVIDER_PROVENANCE_REQUIRED",
    statusCode: 500
  });
  const row = {
    rawEvidenceId: rawEvidenceId({ ...input, sourceUrl }),
    evidenceId: "",
    runId: cleanText(input.runId, 160),
    companyId: cleanText(input.companyId, 160),
    stage: cleanText(input.stage, 40),
    evidenceKey: cleanText(input.evidenceKey || input.targetDate, 160),
    source: provider,
    sourceUrl,
    observedAt: cleanText(input.observedAt, 40),
    capturedAt: cleanText(input.observedAt, 40),
    synthetic,
    dataMode,
    payload: clone(input.payload || {})
  };
  row.evidenceId = row.rawEvidenceId;
  row.contentHash = crypto.createHash("sha256").update(JSON.stringify(row.payload)).digest("hex");
  row.provenance = {
    provider,
    sourceUrl,
    runId: row.runId,
    observedAt: row.observedAt,
    synthetic,
    dataMode,
    schemaVersion: 1
  };
  return row;
}

function createObservation(input = {}) {
  const synthetic = input.synthetic !== false;
  const dataMode = synthetic ? "synthetic-test" : cleanText(input.dataMode, 32).toLowerCase();
  const sourceUrl = assertFreshSourceUrl(input.sourceUrl, { synthetic, dataMode });
  const provider = cleanText(input.provider || input.source || (synthetic ? DEFAULT_SYNTHETIC_PROVIDER.id : ""), 120);
  if (!provider) throw new FreshCollectionError("Observation provider is required", {
    code: "FRESH_PROVIDER_PROVENANCE_REQUIRED",
    statusCode: 500
  });
  const kind = cleanText(input.kind, 80);
  const mode = cleanText(input.mode || (
    kind.startsWith("profile.") ? "quick" : (kind.startsWith("ota.") ? "ota" : "detail")
  ), 32).toLowerCase();
  const row = {
    observationId: "",
    kind,
    mode,
    observationType: kind,
    companyId: cleanText(input.companyId, 160),
    source: provider,
    runId: cleanText(input.runId, 160),
    observedAt: cleanText(input.observedAt, 40),
    targetDate: cleanText(input.targetDate, 16),
    channel: cleanText(input.channel || "direct", 80),
    productKey: cleanText(input.productKey || "company", 120),
    requestKey: cleanText(input.requestKey, 160),
    conditionHash: cleanText(input.conditionHash, 128),
    value: clone(input.value),
    values: clone(input.value),
    unit: cleanText(input.unit, 40),
    rawEvidenceId: cleanText(input.rawEvidenceId, 160),
    evidenceId: cleanText(input.rawEvidenceId, 160),
    sourceUrl,
    synthetic,
    dataMode,
    provenance: {
      provider,
      sourceUrl,
      evidenceId: cleanText(input.rawEvidenceId, 160),
      runId: cleanText(input.runId, 160),
      observedAt: cleanText(input.observedAt, 40),
      targetDate: cleanText(input.targetDate, 16),
      channel: cleanText(input.channel || "direct", 80),
      productKey: cleanText(input.productKey || "company", 120),
      requestKey: cleanText(input.requestKey, 160),
      conditionHash: cleanText(input.conditionHash, 128),
      collectedBy: "stage228-fresh-collection-worker",
      synthetic,
      dataMode,
      schemaVersion: 1
    }
  };
  const required = ["kind", "companyId", "runId", "observedAt", "targetDate", "channel", "productKey", "rawEvidenceId"];
  if (required.some((key) => !row[key])) {
    throw new FreshCollectionError(`Observation is missing required provenance field: ${required.find((key) => !row[key])}`, {
      code: "FRESH_OBSERVATION_PROVENANCE_INVALID",
      statusCode: 500
    });
  }
  row.observationId = observationId({ ...row, sequence: input.sequence });
  return row;
}

function opaqueJobRef(runId) {
  const value = cleanText(runId, 160);
  return value ? `job-ref-${stableHash(`fresh-job:${value}`, 24, "sha256")}` : "";
}

function opaqueCompanyRef(companyId) {
  const value = cleanText(companyId, 160);
  return value ? `company-ref-${stableHash(`fresh-exploration:${value}`, 24, "sha256")}` : "";
}

function publicResultSummary(value = {}) {
  const summary = {};
  for (const key of [
    "exposureSampleCount",
    "companyCount",
    "observationCount",
    "revenueSampleCount",
    "averageRevenue",
    "soldOutRate"
  ]) {
    if (value[key] === null || value[key] === undefined || value[key] === "") continue;
    const number = Number(value[key]);
    if (Number.isFinite(number)) summary[key] = number;
  }
  return summary;
}

function publicCollectionResult(run = {}, options = {}) {
  if (!run.result || typeof run.result !== "object") return null;
  const companyId = cleanText(run.result.companyId || run.companyId || run.checkpoint?.companyId, 160);
  const result = {
    companyRef: opaqueCompanyRef(companyId),
    dataBoundary: "fresh-only",
    dataMode: run.result.dataMode === "live" ? "live" : "synthetic-test"
  };
  if (options.role === "admin" && companyId) result.companyId = companyId;
  return result;
}

function projectStage227Job(run = {}, options = {}) {
  const internalStatus = cleanText(run.status, 40);
  const input = run.input || run.request || {};
  const status = internalStatus === "completed"
    ? "completed"
    : (internalStatus === "cancelled" ? "cancelled" : (internalStatus === "failed" ? "failed" : "running"));
  const projection = {
    jobRef: opaqueJobRef(run.runId),
    clientRequestId: run.clientRequestId || "",
    kind: STAGE227_JOB_KINDS.has(run.kind) ? run.kind : "admin-collection",
    status,
    keyword: input.targetName || run.targetName || "",
    collectionMode: input.collectionMode || run.collectionMode || "precision",
    productMode: input.productMode || run.productMode || "all",
    detailRankRanges: run.detailRankRanges || "1-10",
    progress: Number(run.progress || 0),
    estimatedProgress: Number(run.progress || 0),
    estimatedTotalSeconds: Number(run.estimatedTotalSeconds || 0) || null,
    remainingSeconds: status === "running" ? (Number(run.remainingSeconds || 0) || null) : 0,
    estimatedCompleteAt: run.estimatedCompleteAt || "",
    currentStage: run.currentStage || run.checkpoint?.nextStage || "",
    cancelling: internalStatus === "cancel-requested",
    cancelReason: run.cancelReason || "",
    createdAt: run.createdAt || "",
    startedAt: run.startedAt || "",
    completedAt: run.completedAt || "",
    cancelledAt: run.cancelledAt || "",
    resultSummary: publicResultSummary(run.resultSummary),
    result: publicCollectionResult(run, options),
    provisional: false,
    dataBoundary: "fresh-only"
  };
  if (options.role === "admin") {
    projection.tenantCompanyId = cleanText(input.tenantCompanyId || run.tenantCompanyId, 160);
  }
  return projection;
}

function createFreshCollectionService(options = {}) {
  const repository = options.repository;
  const clock = options.clock || (() => Date.now());
  const idFactory = options.idFactory || ((prefix) => `${prefix}_${crypto.randomUUID()}`);
  const provider = normalizeProviderDescriptor(options.provider || options.providerDescriptor);
  if (!repository) throw new Error("Fresh collection repository is required");
  const requiredMethods = [
    "seedTarget", "createRun", "getRun", "listRuns", "requestRunCancel", "resumeRun"
  ];
  for (const method of requiredMethods) {
    if (typeof repository[method] !== "function") throw new Error(`Fresh collection repository.${method} is required`);
  }

  async function submit(payload = {}, actor = {}) {
    if (!provider.enabled) {
      throw new FreshCollectionError("실제 수집 provider가 아직 구성되지 않았습니다.", {
        code: "FRESH_PROVIDER_NOT_CONFIGURED",
        statusCode: 503
      });
    }
    const input = normalizeRequest(payload);
    const collectionPlan = createV2CollectionPlan({
      ...input,
      keyword: input.targetName,
      checkIn: input.checkIn || input.targetDate,
      checkOut: input.checkOut || undefined
    }, { now: clock() });
    if (typeof provider.assertRequestScope === "function") {
      provider.assertRequestScope(input, collectionPlan.executionStages, collectionPlan);
    }
    const signature = requestSignature(input);
    const actorAccountId = cleanText(actor.accountId || actor.actorAccountId || actor.id, 160);
    const existingRows = await repository.listRuns({
      clientRequestId: input.clientRequestId,
      actorAccountId
    });
    const existing = (Array.isArray(existingRows) ? existingRows : existingRows?.runs || [])
      .find((row) => row.clientRequestId === input.clientRequestId && (
        !actorAccountId || row.actorAccountId === actorAccountId
      ));
    if (existing) {
      if (existing.requestSignature !== signature) {
        throw new FreshCollectionError("clientRequestId is already bound to a different request", {
          code: "FRESH_COLLECTION_IDEMPOTENCY_CONFLICT",
          statusCode: 409
        });
      }
      return { ok: true, idempotent: true, run: clone(existing), job: projectStage227Job(existing) };
    }

    const targetId = `target_${stableHash(`${provider.id}|${normalizeIdentityText(input.regionCode)}|${normalizeIdentityText(input.targetName)}`, 24, "sha256")}`;
    const seeded = await repository.seedTarget({
      targetId,
      targetName: input.targetName,
      regionCode: input.regionCode,
      regionLabel: input.regionLabel,
      source: provider.id,
      seedSource: "v2-user-request",
      sourceUrl: provider.seedSourceUrl,
      synthetic: provider.synthetic,
      dataMode: provider.dataMode
    }, actor);
    const target = unwrap(seeded, "target") || { targetId };
    const runPayload = {
      runId: idFactory("fresh_run"),
      clientRequestId: input.clientRequestId,
      requestSignature: signature,
      kind: input.kind,
      collectionKind: FRESH_COLLECTION_KIND,
      actorAccountId,
      actorRole: cleanText(actor.role || actor.actorRole || actor.account?.role, 48),
      synthetic: provider.synthetic,
      dataMode: provider.dataMode,
      provider: provider.id,
      sourceUrl: provider.seedSourceUrl,
      requestedModes: collectionPlan.executionStages.filter((stage) => ["quick", "detail", "ota"].includes(stage)),
      executionStages: collectionPlan.executionStages,
      estimatedTotalSeconds: collectionPlan.estimatedTotalSeconds,
      estimatedCompleteAt: collectionPlan.estimatedCompleteAt,
      detailRankRanges: collectionPlan.detailRankRanges,
      collectionPlan,
      targetId: target.targetId || targetId,
      companyId: "",
      status: "queued",
      currentStage: "discovery",
      progress: 0,
      input,
      request: input,
      checkpoint: {
        nextStage: "discovery",
        completedStages: ["target-seed"],
        attempts: {}
      }
    };
    let created;
    try {
      created = await repository.createRun(runPayload, actor);
    } catch (error) {
      throw collectionError(error);
    }
    const run = unwrap(created, "run");
    return {
      ok: true,
      idempotent: Boolean(created?.idempotent),
      run: clone(run),
      job: projectStage227Job(run)
    };
  }

  async function get(runId) {
    const run = await repository.getRun(cleanText(runId, 160));
    if (!run) {
      throw new FreshCollectionError("Fresh collection run was not found", {
        code: "FRESH_RUN_NOT_FOUND",
        statusCode: 404
      });
    }
    return { ok: true, run: clone(run), job: projectStage227Job(run) };
  }

  async function getByClientRequestId(clientRequestId, actor = {}) {
    const id = cleanClientRequestId(clientRequestId);
    const rows = await repository.listRuns({
      clientRequestId: id,
      actorAccountId: cleanText(actor.accountId || actor.actorAccountId || actor.id, 160)
    });
    const accountId = cleanText(actor.accountId || actor.actorAccountId || actor.id, 160);
    const run = (Array.isArray(rows) ? rows : rows?.runs || []).find((row) => (
      row.clientRequestId === id && (!accountId || (row.actorAccountId || row.request?.actorAccountId) === accountId)
    ));
    if (!run) {
      throw new FreshCollectionError("Fresh collection run was not found", {
        code: "FRESH_RUN_NOT_FOUND",
        statusCode: 404
      });
    }
    return { ok: true, run: clone(run), job: projectStage227Job(run) };
  }

  async function cancel(runId, payload = {}, actor = {}) {
    assertRunOwnership(await repository.getRun(cleanText(runId, 160)), actor);
    const value = await repository.requestRunCancel(cleanText(runId, 160), {
      reason: cleanText(payload.reason || "user-requested", 160)
    }, actor);
    const run = unwrap(value, "run");
    return { ok: true, idempotent: Boolean(value?.idempotent), run, job: projectStage227Job(run) };
  }

  async function resume(runId, payload = {}, actor = {}) {
    assertRunOwnership(await repository.getRun(cleanText(runId, 160)), actor);
    const value = await repository.resumeRun(cleanText(runId, 160), {
      reason: cleanText(payload.reason || "manual-resume", 160),
      preserveCheckpoint: true
    }, actor);
    const run = unwrap(value, "run");
    return { ok: true, idempotent: Boolean(value?.idempotent), run, job: projectStage227Job(run) };
  }

  return Object.freeze({
    submit,
    get,
    getByClientRequestId,
    cancel,
    resume,
    projectStage227Job,
    provider,
    contract: Object.freeze({
      additive: true,
      kind: FRESH_COLLECTION_KIND,
      stages: FRESH_COLLECTION_STAGES,
      provider: provider.id,
      providerKind: provider.kind,
      dataMode: provider.dataMode,
      dataBoundary: "fresh-only"
    }),
    now: () => new Date(clock()).toISOString()
  });
}

module.exports = {
  DEFAULT_SYNTHETIC_PROVIDER,
  FRESH_COLLECTION_KIND,
  FRESH_COLLECTION_STAGES,
  FreshCollectionError,
  assertRunOwnership,
  cleanClientRequestId,
  createFreshCollectionService,
  createObservation,
  createRawEvidence,
  issueV2CompanyId,
  normalizeIdentityText,
  normalizeRequest,
  normalizeProviderDescriptor,
  observationId,
  projectStage227Job,
  requestSignature,
  v2StableHash
};
