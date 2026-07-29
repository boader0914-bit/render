"use strict";

const crypto = require("node:crypto");
const {
  SYNTHETIC_PROVIDER_ID,
  assertSyntheticSource,
  stableHex
} = require("./fresh_collection_provider.cjs");
const {
  deterministicCompanyId,
  normalizeCompanyIdentity
} = require("../contracts/fresh_data.cjs");

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
  if (!/^\d{4}-\d{2}-\d{2}$/.test(targetDate) || Number.isNaN(Date.parse(`${targetDate}T00:00:00.000Z`))) {
    throw new FreshCollectionError("targetDate must use YYYY-MM-DD", {
      code: "FRESH_TARGET_DATE_INVALID",
      statusCode: 400
    });
  }
  return {
    clientRequestId: cleanClientRequestId(payload.clientRequestId),
    targetName,
    regionCode,
    regionLabel: cleanText(payload.regionLabel || regionCode, 120),
    targetDate,
    collectionMode: cleanText(payload.collectionMode || "precision", 32),
    productMode: cleanText(payload.productMode || "all", 32),
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
    regionCode: normalizeIdentityText(normalized.regionCode),
    targetDate: normalized.targetDate,
    collectionMode: normalized.collectionMode,
    productMode: normalized.productMode,
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
  return `obs_${stableHex([
    input.runId,
    input.companyId,
    input.kind,
    input.targetDate,
    input.channel,
    input.productKey,
    input.sequence || 0
  ].join("|"), 32)}`;
}

function rawEvidenceId(input = {}) {
  return `raw_${stableHex([
    input.runId,
    input.companyId,
    input.stage,
    input.sourceUrl
  ].join("|"), 32)}`;
}

function createRawEvidence(input = {}) {
  const sourceUrl = assertSyntheticSource(input.sourceUrl);
  const row = {
    rawEvidenceId: rawEvidenceId({ ...input, sourceUrl }),
    evidenceId: "",
    runId: cleanText(input.runId, 160),
    companyId: cleanText(input.companyId, 160),
    stage: cleanText(input.stage, 40),
    source: SYNTHETIC_PROVIDER_ID,
    sourceUrl,
    observedAt: cleanText(input.observedAt, 40),
    capturedAt: cleanText(input.observedAt, 40),
    synthetic: true,
    payload: clone(input.payload || {})
  };
  row.evidenceId = row.rawEvidenceId;
  row.contentHash = crypto.createHash("sha256").update(JSON.stringify(row.payload)).digest("hex");
  row.provenance = {
    provider: SYNTHETIC_PROVIDER_ID,
    sourceUrl,
    runId: row.runId,
    observedAt: row.observedAt,
    synthetic: true,
    schemaVersion: 1
  };
  return row;
}

function createObservation(input = {}) {
  const sourceUrl = assertSyntheticSource(input.sourceUrl);
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
    source: SYNTHETIC_PROVIDER_ID,
    runId: cleanText(input.runId, 160),
    observedAt: cleanText(input.observedAt, 40),
    targetDate: cleanText(input.targetDate, 16),
    channel: cleanText(input.channel || "direct", 80),
    productKey: cleanText(input.productKey || "company", 120),
    value: clone(input.value),
    values: clone(input.value),
    unit: cleanText(input.unit, 40),
    rawEvidenceId: cleanText(input.rawEvidenceId, 160),
    evidenceId: cleanText(input.rawEvidenceId, 160),
    sourceUrl,
    synthetic: true,
    provenance: {
      provider: SYNTHETIC_PROVIDER_ID,
      sourceUrl,
      evidenceId: cleanText(input.rawEvidenceId, 160),
      runId: cleanText(input.runId, 160),
      observedAt: cleanText(input.observedAt, 40),
      targetDate: cleanText(input.targetDate, 16),
      channel: cleanText(input.channel || "direct", 80),
      productKey: cleanText(input.productKey || "company", 120),
      collectedBy: "stage228-fresh-collection-worker",
      synthetic: true,
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

function projectStage227Job(run = {}) {
  const internalStatus = cleanText(run.status, 40);
  const input = run.input || run.request || {};
  const status = internalStatus === "completed"
    ? "completed"
    : (internalStatus === "cancelled" ? "cancelled" : (internalStatus === "failed" ? "failed" : "running"));
  return {
    jobId: run.runId || "",
    clientRequestId: run.clientRequestId || "",
    kind: STAGE227_JOB_KINDS.has(run.kind) ? run.kind : "admin-collection",
    status,
    keyword: input.targetName || run.targetName || "",
    tenantCompanyId: input.tenantCompanyId || run.tenantCompanyId || "",
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
    resultSummary: run.resultSummary || {},
    result: run.result || null,
    provisional: false,
    dataBoundary: "fresh-only"
  };
}

function createFreshCollectionService(options = {}) {
  const repository = options.repository;
  const clock = options.clock || (() => Date.now());
  const idFactory = options.idFactory || ((prefix) => `${prefix}_${crypto.randomUUID()}`);
  if (!repository) throw new Error("Fresh collection repository is required");
  const requiredMethods = [
    "seedTarget", "createRun", "getRun", "listRuns", "requestRunCancel", "resumeRun"
  ];
  for (const method of requiredMethods) {
    if (typeof repository[method] !== "function") throw new Error(`Fresh collection repository.${method} is required`);
  }

  async function submit(payload = {}, actor = {}) {
    const input = normalizeRequest(payload);
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

    const targetId = `target_${stableHex(`${normalizeIdentityText(input.regionCode)}|${normalizeIdentityText(input.targetName)}`, 24)}`;
    const seeded = await repository.seedTarget({
      targetId,
      targetName: input.targetName,
      regionCode: input.regionCode,
      regionLabel: input.regionLabel,
      source: "stage228-user-seed",
      synthetic: true
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
      synthetic: true,
      provider: "synthetic-stage228",
      sourceUrl: "https://collector.example.invalid/stage228",
      requestedModes: ["quick", "detail", "ota"],
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
    contract: Object.freeze({
      additive: true,
      kind: FRESH_COLLECTION_KIND,
      stages: FRESH_COLLECTION_STAGES,
      provider: SYNTHETIC_PROVIDER_ID,
      dataBoundary: "fresh-only"
    }),
    now: () => new Date(clock()).toISOString()
  });
}

module.exports = {
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
  observationId,
  projectStage227Job,
  requestSignature,
  v2StableHash
};
