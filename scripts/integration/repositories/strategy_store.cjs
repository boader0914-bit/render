"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { resolveFreshIntegrationDataDir } = require("./fresh_store.cjs");
const {
  ITEM_STATUSES,
  PLAN_STATUSES,
  STRATEGY_RULE_VERSION,
  STRATEGY_SCHEMA_VERSION,
  STRATEGY_STORE_KIND,
  assertBusinessSafe,
  cleanId,
  cleanText,
  clone,
  normalizeChecklist,
  normalizeKpi,
  requiredDate,
  requiredIso,
  requiredMonth,
  stableHash,
  strategyError
} = require("../contracts/strategy_execution.cjs");

const STRATEGY_DIRECTORY = "stage230-strategy";
const STRATEGY_LOCK_FILE = ".stage230-strategy.lock";
const STRATEGY_STATE_FILES = Object.freeze({
  manifest: "manifest.json",
  state: "state/strategy-execution.json"
});

function nowIso(clock) {
  return new Date(Number(clock())).toISOString();
}

function normalizePath(value) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isInsideOrEqual(parent, child) {
  const relative = path.relative(normalizePath(parent), normalizePath(child));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function canonicalizeCandidate(candidate) {
  const resolved = path.resolve(candidate);
  let cursor = resolved;
  const tail = [];
  while (!fs.existsSync(cursor)) {
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    tail.unshift(path.basename(cursor));
    cursor = parent;
  }
  const canonical = fs.existsSync(cursor) ? fs.realpathSync.native(cursor) : cursor;
  return path.resolve(canonical, ...tail);
}

function normalizeActor(actor) {
  if (!actor || typeof actor !== "object") {
    return { id: cleanText(actor || "system", 160), role: "", label: "system", type: "system" };
  }
  return {
    id: cleanText(actor.accountId || actor.actorAccountId || actor.id || "system", 160),
    role: cleanText(actor.role || actor.actorRole, 48),
    label: cleanText(actor.label || actor.displayName || actor.username || actor.role || "system", 120),
    type: cleanText(actor.type || "account", 48)
  };
}

function emptyManifest(clock = Date.now, idFactory = crypto.randomUUID, parentInsightsStoreId = "") {
  const at = nowIso(clock);
  return {
    schemaVersion: STRATEGY_SCHEMA_VERSION,
    storeKind: STRATEGY_STORE_KIND,
    storeId: `strategy_${cleanText(idFactory(), 80).replace(/[^A-Za-z0-9_-]/g, "")}`,
    parentInsightsStoreId: cleanText(parentInsightsStoreId, 160),
    ruleVersion: STRATEGY_RULE_VERSION,
    dataBoundary: "fresh-integration-stage230-only",
    createdAt: at,
    updatedAt: at,
    revision: 0,
    auditSequence: 0,
    externalProviderCalls: 0,
    credentialReads: 0,
    legacyRuntimeReads: 0,
    legacyRuntimeCopies: 0,
    productionMutations: 0
  };
}

function emptyState() {
  return {
    schemaVersion: STRATEGY_SCHEMA_VERSION,
    strategies: [],
    plans: [],
    retrospectives: [],
    candidates: [],
    requestKeys: {}
  };
}

function assertManifest(value, parentInsightsStoreId = "") {
  if (!value || value.schemaVersion !== STRATEGY_SCHEMA_VERSION || value.storeKind !== STRATEGY_STORE_KIND) {
    throw strategyError("Configured directory is not a Stage 230 strategy store", "STRATEGY_STORE_KIND_INVALID", 500);
  }
  if (value.ruleVersion !== STRATEGY_RULE_VERSION) {
    throw strategyError("Stage 230 deterministic rule version mismatch", "STRATEGY_RULE_VERSION_MISMATCH", 500);
  }
  if (parentInsightsStoreId && value.parentInsightsStoreId && value.parentInsightsStoreId !== parentInsightsStoreId) {
    throw strategyError("Stage 230 store belongs to a different Stage 229 insights store", "STRATEGY_PARENT_STORE_MISMATCH", 409);
  }
  if (!Number.isInteger(value.revision) || !Number.isInteger(value.auditSequence)) {
    throw strategyError("Stage 230 manifest is corrupt", "STRATEGY_STORE_CORRUPT", 500);
  }
  return value;
}

function assertState(value) {
  if (!value || value.schemaVersion !== STRATEGY_SCHEMA_VERSION) {
    throw strategyError("Unsupported Stage 230 state schema", "STRATEGY_SCHEMA_UNSUPPORTED", 500);
  }
  for (const key of ["strategies", "plans", "retrospectives", "candidates"]) {
    if (!Array.isArray(value[key])) throw strategyError(`Stage 230 ${key} state is corrupt`, "STRATEGY_STORE_CORRUPT", 500);
  }
  if (!value.requestKeys || typeof value.requestKeys !== "object" || Array.isArray(value.requestKeys)) {
    throw strategyError("Stage 230 idempotency index is corrupt", "STRATEGY_STORE_CORRUPT", 500);
  }
  return value;
}

function requestKey(kind, tenantCompanyId, clientRequestId) {
  return `${kind}|${tenantCompanyId}|${clientRequestId}`;
}

function assertPlanTransition(from, to) {
  if (from === to) return;
  const allowed = {
    draft: ["active", "cancelled"],
    active: ["completed", "cancelled"],
    completed: [],
    cancelled: []
  };
  if (!allowed[from]?.includes(to)) {
    throw strategyError(`Invalid plan status transition: ${from} -> ${to}`, "STRATEGY_PLAN_STATUS_INVALID", 409);
  }
}

function assertEntitlementLimit(actual, configuredMaximum, label) {
  const maximum = Number(configuredMaximum);
  if (!Number.isFinite(maximum)) return;
  if (maximum < 0 || Number(actual) >= maximum) {
    throw strategyError(`${label} entitlement limit exceeded (${actual}/${maximum})`, "STRATEGY_ENTITLEMENT_LIMIT", 403);
  }
}

function assertEntitlementCapacity(selected, configuredMaximum, label) {
  const maximum = Number(configuredMaximum);
  if (!Number.isFinite(maximum)) return;
  if (maximum < 0 || Number(selected) > maximum) {
    throw strategyError(`${label} entitlement capacity exceeded (${selected}/${maximum})`, "STRATEGY_ENTITLEMENT_LIMIT", 403);
  }
}

function createStrategyRepository(options = {}) {
  const env = options.env || process.env;
  const clock = options.clock || Date.now;
  const idFactory = options.idFactory || crypto.randomUUID;
  const projectRoot = path.resolve(options.projectRoot || path.resolve(__dirname, "../../.."));
  let parentInsightsStoreId = cleanText(options.parentInsightsStoreId, 160);
  const resolveInsightsStoreId = typeof options.resolveInsightsStoreId === "function" ? options.resolveInsightsStoreId : null;
  const boundary = resolveFreshIntegrationDataDir({
    env,
    projectRoot,
    dataDir: options.dataDir,
    legacyPaths: options.legacyPaths
  });
  const freshRoot = boundary.configured;
  const root = path.join(freshRoot, STRATEGY_DIRECTORY);
  const initialCanonical = canonicalizeCandidate(root);
  if (!isInsideOrEqual(freshRoot, root) || !isInsideOrEqual(boundary.canonical, initialCanonical)) {
    throw strategyError("Stage 230 store escaped the fresh integration root", "STRATEGY_PATH_ESCAPE", 500);
  }
  const metrics = {
    repositoryFileReads: 0,
    repositoryFileWrites: 0,
    repositoryFileCopies: 0,
    externalProviderCalls: 0,
    credentialReads: 0,
    legacyRuntimeReads: 0,
    legacyRuntimeCopies: 0,
    productionMutations: 0
  };
  let cache = null;
  let initialized = false;
  let initializePromise = null;
  let queue = Promise.resolve();

  function absolute(relative) {
    const target = path.resolve(root, ...String(relative || "").replace(/\\/g, "/").split("/").filter(Boolean));
    if (!isInsideOrEqual(root, target)) throw strategyError("Stage 230 repository path escaped its root", "STRATEGY_PATH_ESCAPE", 500);
    const rootCanonical = canonicalizeCandidate(root);
    const targetCanonical = canonicalizeCandidate(target);
    if (!isInsideOrEqual(boundary.canonical, rootCanonical) || !isInsideOrEqual(rootCanonical, targetCanonical)) {
      throw strategyError("Stage 230 repository path escaped through a link", "STRATEGY_PATH_ESCAPE", 500);
    }
    return target;
  }

  async function atomicWrite(relative, content, mode = 0o600) {
    const target = absolute(relative);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    const temp = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
    const handle = await fsp.open(temp, "wx", mode);
    try {
      await handle.writeFile(content, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fsp.rename(temp, target);
    metrics.repositoryFileWrites += 1;
  }

  async function writeJson(relative, value) {
    await atomicWrite(relative, `${JSON.stringify(value, null, 2)}\n`);
  }

  async function readJson(relative) {
    metrics.repositoryFileReads += 1;
    return JSON.parse((await fsp.readFile(absolute(relative), "utf8")).replace(/^\uFEFF/, ""));
  }

  async function withLock(work) {
    await fsp.mkdir(root, { recursive: true });
    const lockPath = absolute(STRATEGY_LOCK_FILE);
    const started = Date.now();
    let handle;
    while (!handle) {
      try {
        handle = await fsp.open(lockPath, "wx", 0o600);
        await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }), "utf8");
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        try {
          const stat = await fsp.stat(lockPath);
          if (Date.now() - stat.mtimeMs > 10 * 60_000) await fsp.unlink(lockPath);
        } catch (statError) {
          if (statError.code !== "ENOENT") throw statError;
        }
        if (Date.now() - started > 10_000) throw strategyError("Stage 230 store lock timed out", "STRATEGY_LOCK_TIMEOUT", 503);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    try {
      return await work();
    } finally {
      await handle.close();
      await fsp.unlink(lockPath).catch(() => undefined);
    }
  }

  function serialize(work) {
    const next = queue.then(work, work);
    queue = next.then(() => undefined, () => undefined);
    return next;
  }

  async function readAudit() {
    const directory = absolute("audit/chunks");
    if (!fs.existsSync(directory)) return [];
    const files = (await fsp.readdir(directory)).filter((name) => /^\d{8}\.jsonl$/.test(name)).sort();
    const rows = [];
    for (const name of files) {
      metrics.repositoryFileReads += 1;
      const content = await fsp.readFile(absolute(`audit/chunks/${name}`), "utf8");
      for (const line of content.split(/\r?\n/).filter(Boolean)) rows.push(JSON.parse(line));
    }
    return rows;
  }

  async function loadAll() {
    cache = {
      manifest: assertManifest(await readJson(STRATEGY_STATE_FILES.manifest), parentInsightsStoreId),
      state: assertState(await readJson(STRATEGY_STATE_FILES.state)),
      audit: await readAudit()
    };
    return cache;
  }

  async function appendAudit(event, actor, details) {
    const actorValue = normalizeActor(actor);
    const sequence = cache.manifest.auditSequence + 1;
    const row = {
      schemaVersion: STRATEGY_SCHEMA_VERSION,
      auditId: `strategy_audit_${stableHash(`${sequence}|${event}|${nowIso(clock)}|${idFactory()}`, 28)}`,
      event: cleanText(event, 120),
      actor: actorValue.id,
      actorRole: actorValue.role,
      actorType: actorValue.type,
      at: nowIso(clock),
      details: clone(details || {})
    };
    assertBusinessSafe(row.details);
    await atomicWrite(`audit/chunks/${String(sequence).padStart(8, "0")}.jsonl`, `${JSON.stringify(row)}\n`);
    cache.manifest.auditSequence = sequence;
    cache.audit.push(row);
    return row;
  }

  function summary() {
    return {
      storeKind: cache.manifest.storeKind,
      schemaVersion: cache.manifest.schemaVersion,
      storeId: cache.manifest.storeId,
      parentInsightsStoreId: cache.manifest.parentInsightsStoreId,
      ruleVersion: cache.manifest.ruleVersion,
      revision: cache.manifest.revision,
      counts: {
        strategies: cache.state.strategies.length,
        plans: cache.state.plans.length,
        retrospectives: cache.state.retrospectives.length,
        candidates: cache.state.candidates.length,
        audit: cache.audit.length
      }
    };
  }

  async function initializeInsideLock() {
    if (!parentInsightsStoreId && resolveInsightsStoreId) {
      parentInsightsStoreId = cleanText(await resolveInsightsStoreId(), 160);
    }
    if (!parentInsightsStoreId) {
      throw strategyError("Stage 230 requires an initialized Stage 229 insights store", "STRATEGY_PARENT_STORE_REQUIRED", 500);
    }
    await fsp.mkdir(absolute("state"), { recursive: true });
    await fsp.mkdir(absolute("audit/chunks"), { recursive: true });
    if (!fs.existsSync(absolute(STRATEGY_STATE_FILES.manifest))) {
      cache = {
        manifest: emptyManifest(clock, idFactory, parentInsightsStoreId),
        state: emptyState(),
        audit: []
      };
      await writeJson(STRATEGY_STATE_FILES.state, cache.state);
      await appendAudit("strategy.store.bootstrap", "system", {
        storeId: cache.manifest.storeId,
        parentInsightsStoreId,
        dataBoundary: cache.manifest.dataBoundary
      });
      cache.manifest.revision = 1;
      cache.manifest.updatedAt = nowIso(clock);
      await writeJson(STRATEGY_STATE_FILES.manifest, cache.manifest);
    } else {
      await loadAll();
    }
    initialized = true;
    return summary();
  }

  async function initialize() {
    if (initialized) return summary();
    if (!initializePromise) {
      initializePromise = serialize(() => withLock(initializeInsideLock)).finally(() => { initializePromise = null; });
    }
    return initializePromise;
  }

  async function ensureReady() {
    if (!initialized) await initialize();
  }

  async function mutation(event, actor, work) {
    await initialize();
    return serialize(() => withLock(async () => {
      await loadAll();
      const result = await work(cache.state);
      if (result?.changed === false) return clone(result.value);
      assertBusinessSafe(cache.state);
      await writeJson(STRATEGY_STATE_FILES.state, cache.state);
      await appendAudit(event, actor, result?.details || {});
      cache.manifest.revision += 1;
      cache.manifest.updatedAt = nowIso(clock);
      await writeJson(STRATEGY_STATE_FILES.manifest, cache.manifest);
      return clone(result?.value);
    }));
  }

  function requestRecord(state, kind, tenantCompanyId, clientRequestId, signature) {
    const key = requestKey(kind, tenantCompanyId, clientRequestId);
    const existing = state.requestKeys[key];
    if (existing && existing.signature !== signature) {
      throw strategyError("Stage 230 idempotency key was reused with a different request", "STRATEGY_IDEMPOTENCY_CONFLICT", 409);
    }
    return { key, existing };
  }

  async function createStrategySet(payload = {}, actor = "system") {
    const companyId = cleanId(payload.companyId, "companyId");
    const tenantCompanyId = cleanId(payload.tenantCompanyId, "tenantCompanyId");
    const clientRequestId = cleanId(payload.clientRequestId, "clientRequestId");
    const reportId = cleanId(payload.reportId, "reportId");
    const month = requiredMonth(payload.month);
    const cards = clone(payload.strategies || []);
    if (!cards.length || cards.length > 5) throw strategyError("A deterministic strategy set must contain one to five cards", "STRATEGY_SET_INVALID");
    cards.forEach(assertBusinessSafe);
    const signature = stableHash({ companyId, tenantCompanyId, reportId, month, ruleVersion: STRATEGY_RULE_VERSION, ids: cards.map((row) => row.strategyId).sort() }, 64);
    return mutation("strategy.generated", actor, async (state) => {
      const request = requestRecord(state, "strategy-set", tenantCompanyId, clientRequestId, signature);
      if (request.existing) {
        return { changed: false, value: { idempotent: true, strategies: state.strategies.filter((row) => request.existing.entityIds.includes(row.strategyId)) } };
      }
      const existingCards = cards.map((card) => state.strategies.find((row) => row.strategyId === card.strategyId)).filter(Boolean);
      if (existingCards.length && existingCards.length !== cards.length) {
        throw strategyError("Strategy set partially conflicts with an existing deterministic set", "STRATEGY_DUPLICATE_CONFLICT", 409);
      }
      if (!existingCards.length) {
        for (const card of cards) {
          if (card.companyId !== companyId || card.month !== month || card.reportId !== reportId) {
            throw strategyError("Strategy lineage does not match the requested report", "STRATEGY_LINEAGE_INVALID", 409);
          }
          state.strategies.push({ ...card, tenantCompanyId });
        }
      }
      state.requestKeys[request.key] = { signature, entityIds: cards.map((row) => row.strategyId), createdAt: nowIso(clock) };
      return {
        value: { idempotent: Boolean(existingCards.length), strategies: existingCards.length ? existingCards : cards.map((card) => ({ ...card, tenantCompanyId })) },
        details: { companyId, tenantCompanyId, reportId, month, strategyIds: cards.map((row) => row.strategyId) }
      };
    });
  }

  async function getStrategy(strategyId) {
    await ensureReady();
    return clone(cache.state.strategies.find((row) => row.strategyId === cleanId(strategyId, "strategyId")) || null);
  }

  async function listStrategies(filter = {}) {
    await ensureReady();
    return clone(cache.state.strategies.filter((row) => {
      if (filter.companyId && row.companyId !== filter.companyId) return false;
      if (filter.tenantCompanyId && row.tenantCompanyId !== filter.tenantCompanyId) return false;
      if (filter.month && row.month !== filter.month) return false;
      if (filter.reportId && row.reportId !== filter.reportId) return false;
      if (filter.domain && row.domain !== filter.domain) return false;
      return true;
    }).sort((left, right) => String(left.domain).localeCompare(String(right.domain))));
  }

  async function createPlan(payload = {}, actor = "system") {
    const companyId = cleanId(payload.companyId, "companyId");
    const tenantCompanyId = cleanId(payload.tenantCompanyId, "tenantCompanyId");
    const clientRequestId = cleanId(payload.clientRequestId, "clientRequestId");
    const month = requiredMonth(payload.month);
    const strategyIds = [...new Set((payload.strategyIds || []).map((id) => cleanId(id, "strategyId")))].sort();
    const candidateIds = [...new Set((payload.candidateIds || []).map((id) => cleanId(id, "candidateId")))].sort();
    if (!strategyIds.length && !candidateIds.length) throw strategyError("A plan requires at least one strategy or next-month candidate", "STRATEGY_PLAN_EMPTY");
    const signature = stableHash({ companyId, tenantCompanyId, month, strategyIds, candidateIds, title: cleanText(payload.title, 160) }, 64);
    return mutation("strategy.plan.created", actor, async (state) => {
      const request = requestRecord(state, "plan", tenantCompanyId, clientRequestId, signature);
      if (request.existing) {
        const existing = state.plans.find((row) => row.planId === request.existing.entityIds[0]);
        return { changed: false, value: { idempotent: true, plan: existing } };
      }
      const planCount = state.plans.filter((row) => (
        row.companyId === companyId
        && row.tenantCompanyId === tenantCompanyId
        && row.month === month
      )).length;
      assertEntitlementLimit(planCount, payload.maximumPlansPerMonth, "monthly plan");
      const candidates = state.candidates.filter((row) => candidateIds.includes(row.candidateId));
      if (
        candidates.length !== candidateIds.length
        || candidates.some((row) => row.companyId !== companyId || row.tenantCompanyId !== tenantCompanyId || row.targetMonth !== month)
      ) {
        throw strategyError("Plan candidates must belong to the same tenant, company and target month", "STRATEGY_LINEAGE_INVALID", 409);
      }
      if (candidates.some((row) => row.status === "planned")) {
        throw strategyError("A next-month candidate is already linked to a plan", "STRATEGY_CANDIDATE_ALREADY_PLANNED", 409);
      }
      const selectedStrategyIds = [...new Set([...strategyIds, ...candidates.map((row) => row.strategyId)])].sort();
      assertEntitlementCapacity(selectedStrategyIds.length, payload.maximumItemsPerPlan, "selected strategy");
      const candidateStrategyIds = new Set(candidates.map((row) => row.strategyId));
      const strategies = state.strategies.filter((row) => selectedStrategyIds.includes(row.strategyId));
      if (
        strategies.length !== selectedStrategyIds.length
        || strategies.some((row) => (
          row.companyId !== companyId
          || row.tenantCompanyId !== tenantCompanyId
          || (row.month !== month && !candidateStrategyIds.has(row.strategyId))
        ))
      ) {
        throw strategyError("Plan strategies must belong to the same tenant, company and month", "STRATEGY_LINEAGE_INVALID", 409);
      }
      const at = nowIso(clock);
      const planId = `plan_${stableHash(`${tenantCompanyId}|${clientRequestId}|${month}`, 28)}`;
      const sourceReports = [...new Map(strategies.map((strategy) => [strategy.reportId, {
        reportId: strategy.reportId,
        version: strategy.lineage?.sourceReportVersion || 1,
        publishedAt: strategy.lineage?.sourceReportPublishedAt || "",
        algorithmVersion: strategy.lineage?.sourceAlgorithmVersion || ""
      }])).values()];
      const plan = {
        schemaVersion: STRATEGY_SCHEMA_VERSION,
        planId,
        companyId,
        tenantCompanyId,
        month,
        title: cleanText(payload.title || `${month} 월간 실행계획`, 160),
        status: "draft",
        owner: cleanText(payload.owner, 120),
        dueDate: payload.dueDate ? requiredDate(payload.dueDate, "dueDate") : `${month}-28`,
        notes: cleanText(payload.notes, 1000),
        strategyIds: selectedStrategyIds,
        candidateIds,
        items: [],
        lineage: {
          strategyIds: selectedStrategyIds,
          candidateIds,
          sourceRetrospectiveIds: [...new Set(candidates.map((row) => row.retrospectiveId))].sort(),
          sourceReports,
          ruleVersion: STRATEGY_RULE_VERSION,
          appliedAt: at,
          appliedBy: normalizeActor(actor).label
        },
        version: 1,
        createdAt: at,
        updatedAt: at
      };
      state.plans.push(plan);
      for (const candidate of candidates) {
        candidate.status = "planned";
        candidate.plannedInPlanId = planId;
        candidate.appliedAt = at;
        candidate.appliedBy = normalizeActor(actor).label;
      }
      state.requestKeys[request.key] = { signature, entityIds: [planId], createdAt: at };
      return { value: { idempotent: false, plan }, details: { companyId, tenantCompanyId, planId, month, strategyIds: selectedStrategyIds, candidateIds, before: null, after: plan } };
    });
  }

  async function getPlan(planId) {
    await ensureReady();
    return clone(cache.state.plans.find((row) => row.planId === cleanId(planId, "planId")) || null);
  }

  async function listPlans(filter = {}) {
    await ensureReady();
    return clone(cache.state.plans.filter((row) => {
      if (filter.companyId && row.companyId !== filter.companyId) return false;
      if (filter.tenantCompanyId && row.tenantCompanyId !== filter.tenantCompanyId) return false;
      if (filter.month && row.month !== filter.month) return false;
      if (filter.status && row.status !== filter.status) return false;
      return true;
    }).sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt))));
  }

  async function updatePlan(planId, payload = {}, actor = "system") {
    const id = cleanId(planId, "planId");
    return mutation("strategy.plan.updated", actor, async (state) => {
      const index = state.plans.findIndex((row) => row.planId === id);
      if (index < 0) throw strategyError("Action plan was not found", "STRATEGY_PLAN_NOT_FOUND", 404);
      const current = state.plans[index];
      const expectedVersion = Number(payload.expectedVersion || current.version);
      if (expectedVersion !== current.version) throw strategyError("Action plan version conflict", "STRATEGY_VERSION_CONFLICT", 409);
      const status = cleanText(payload.status || current.status, 32);
      if (!PLAN_STATUSES.includes(status)) throw strategyError("Unsupported plan status", "STRATEGY_PLAN_STATUS_INVALID");
      assertPlanTransition(current.status, status);
      if (status === "completed" && current.items.some((item) => !["done", "cancelled"].includes(item.status))) {
        throw strategyError("All plan items must be done or cancelled before completion", "STRATEGY_PLAN_INCOMPLETE", 409);
      }
      const before = clone(current);
      const next = {
        ...current,
        title: payload.title === undefined ? current.title : cleanText(payload.title, 160),
        status,
        owner: payload.owner === undefined ? current.owner : cleanText(payload.owner, 120),
        dueDate: payload.dueDate === undefined ? current.dueDate : requiredDate(payload.dueDate, "dueDate"),
        notes: payload.notes === undefined ? current.notes : cleanText(payload.notes, 1000),
        version: current.version + 1,
        updatedAt: nowIso(clock)
      };
      state.plans[index] = next;
      return { value: { idempotent: false, plan: next }, details: { companyId: next.companyId, tenantCompanyId: next.tenantCompanyId, planId: id, before, after: next } };
    });
  }

  async function addPlanItem(planId, payload = {}, actor = "system") {
    const id = cleanId(planId, "planId");
    const clientRequestId = cleanId(payload.clientRequestId, "clientRequestId");
    const strategyId = cleanId(payload.strategyId, "strategyId");
    return mutation("strategy.plan-item.created", actor, async (state) => {
      const plan = state.plans.find((row) => row.planId === id);
      if (!plan) throw strategyError("Action plan was not found", "STRATEGY_PLAN_NOT_FOUND", 404);
      const signature = stableHash({ planId: id, strategyId, title: cleanText(payload.title, 180), dueDate: cleanText(payload.dueDate, 10) }, 64);
      const request = requestRecord(state, `plan-item:${id}`, plan.tenantCompanyId, clientRequestId, signature);
      if (request.existing) {
        const existing = plan.items.find((row) => row.itemId === request.existing.entityIds[0]);
        return { changed: false, value: { idempotent: true, plan, item: existing } };
      }
      if (plan.status === "cancelled" || plan.status === "completed") throw strategyError("Closed plans cannot accept items", "STRATEGY_PLAN_CLOSED", 409);
      assertEntitlementLimit(plan.items.length, payload.maximumItemsPerPlan, "plan item");
      assertEntitlementLimit(0, payload.maximumKpisPerItem, "seed KPI");
      const strategy = state.strategies.find((row) => row.strategyId === strategyId);
      if (!strategy || !plan.strategyIds.includes(strategyId) || strategy.companyId !== plan.companyId || strategy.tenantCompanyId !== plan.tenantCompanyId) {
        throw strategyError("Plan item strategy lineage is invalid", "STRATEGY_LINEAGE_INVALID", 409);
      }
      const at = nowIso(clock);
      const itemId = `item_${stableHash(`${id}|${clientRequestId}|${strategyId}`, 28)}`;
      const checklistSource = payload.checklist || strategy.checklist || [];
      const seededKpiId = `kpi_${stableHash(`${itemId}|${strategyId}|template`, 28)}`;
      const seededKpi = {
        kpiId: seededKpiId,
        ...normalizeKpi(strategy.kpiTemplate),
        lineage: {
          strategyId,
          sourceReportId: strategy.reportId,
          sourceReportVersion: strategy.lineage?.sourceReportVersion || 1,
          sourceReportPublishedAt: strategy.lineage?.sourceReportPublishedAt || "",
          sourceAlgorithmVersion: strategy.lineage?.sourceAlgorithmVersion || "",
          ruleVersion: strategy.ruleVersion,
          seededAt: at,
          seededBy: normalizeActor(actor).label
        },
        version: 1,
        createdAt: at,
        updatedAt: at
      };
      const item = {
        itemId,
        strategyId,
        title: cleanText(payload.title || strategy.title, 180),
        owner: cleanText(payload.owner || plan.owner, 120),
        dueDate: payload.dueDate ? requiredDate(payload.dueDate, "dueDate") : strategy.executionTiming.dueDate,
        status: "planned",
        notes: cleanText(payload.notes, 1000),
        repeatNextMonth: Boolean(payload.repeatNextMonth),
        checklist: normalizeChecklist(checklistSource),
        kpis: [seededKpi],
        lineage: {
          strategyId,
          sourceReportId: strategy.reportId,
          sourceReportVersion: strategy.lineage?.sourceReportVersion || 1,
          sourceReportPublishedAt: strategy.lineage?.sourceReportPublishedAt || "",
          sourceAlgorithmVersion: strategy.lineage?.sourceAlgorithmVersion || "",
          ruleVersion: strategy.ruleVersion,
          appliedAt: at,
          appliedBy: normalizeActor(actor).label
        },
        createdAt: at,
        updatedAt: at
      };
      plan.items.push(item);
      plan.version += 1;
      plan.updatedAt = at;
      state.requestKeys[request.key] = { signature, entityIds: [itemId], createdAt: at };
      return { value: { idempotent: false, plan, item }, details: { companyId: plan.companyId, tenantCompanyId: plan.tenantCompanyId, planId: id, itemId, strategyId, seededKpiId, before: null, after: item } };
    });
  }

  async function updatePlanItem(planId, itemId, payload = {}, actor = "system") {
    const id = cleanId(planId, "planId");
    const targetItemId = cleanId(itemId, "itemId");
    return mutation("strategy.plan-item.updated", actor, async (state) => {
      const plan = state.plans.find((row) => row.planId === id);
      if (!plan) throw strategyError("Action plan was not found", "STRATEGY_PLAN_NOT_FOUND", 404);
      const expectedVersion = Number(payload.expectedVersion || plan.version);
      if (expectedVersion !== plan.version) throw strategyError("Action plan version conflict", "STRATEGY_VERSION_CONFLICT", 409);
      const index = plan.items.findIndex((row) => row.itemId === targetItemId);
      if (index < 0) throw strategyError("Action item was not found", "STRATEGY_ITEM_NOT_FOUND", 404);
      const current = plan.items[index];
      const status = cleanText(payload.status || current.status, 32);
      if (!ITEM_STATUSES.includes(status)) throw strategyError("Unsupported item status", "STRATEGY_ITEM_STATUS_INVALID");
      const checklist = clone(current.checklist);
      for (const update of Array.isArray(payload.checklistUpdates) ? payload.checklistUpdates : []) {
        const checklistId = cleanId(update.checklistId, "checklistId");
        const row = checklist.find((entry) => entry.checklistId === checklistId);
        if (!row) throw strategyError("Checklist item was not found", "STRATEGY_CHECKLIST_NOT_FOUND", 404);
        row.completed = Boolean(update.completed);
        row.completedAt = row.completed ? nowIso(clock) : "";
      }
      const before = clone(current);
      const next = {
        ...current,
        title: payload.title === undefined ? current.title : cleanText(payload.title, 180),
        owner: payload.owner === undefined ? current.owner : cleanText(payload.owner, 120),
        dueDate: payload.dueDate === undefined ? current.dueDate : requiredDate(payload.dueDate, "dueDate"),
        status,
        notes: payload.notes === undefined ? current.notes : cleanText(payload.notes, 1000),
        repeatNextMonth: payload.repeatNextMonth === undefined ? current.repeatNextMonth : Boolean(payload.repeatNextMonth),
        checklist,
        updatedAt: nowIso(clock)
      };
      plan.items[index] = next;
      plan.version += 1;
      plan.updatedAt = next.updatedAt;
      return { value: { idempotent: false, plan, item: next }, details: { companyId: plan.companyId, tenantCompanyId: plan.tenantCompanyId, planId: id, itemId: targetItemId, before, after: next } };
    });
  }

  async function addKpi(planId, itemId, payload = {}, actor = "system") {
    const id = cleanId(planId, "planId");
    const targetItemId = cleanId(itemId, "itemId");
    const clientRequestId = cleanId(payload.clientRequestId, "clientRequestId");
    const normalized = normalizeKpi(payload);
    return mutation("strategy.kpi.created", actor, async (state) => {
      const plan = state.plans.find((row) => row.planId === id);
      if (!plan) throw strategyError("Action plan was not found", "STRATEGY_PLAN_NOT_FOUND", 404);
      const item = plan.items.find((row) => row.itemId === targetItemId);
      if (!item) throw strategyError("Action item was not found", "STRATEGY_ITEM_NOT_FOUND", 404);
      const signature = stableHash({ planId: id, itemId: targetItemId, ...normalized }, 64);
      const request = requestRecord(state, `kpi:${id}:${targetItemId}`, plan.tenantCompanyId, clientRequestId, signature);
      if (request.existing) {
        const existing = item.kpis.find((row) => row.kpiId === request.existing.entityIds[0]);
        return { changed: false, value: { idempotent: true, plan, item, kpi: existing } };
      }
      assertEntitlementLimit(item.kpis.length, payload.maximumKpisPerItem, "KPI");
      const at = nowIso(clock);
      const kpiId = `kpi_${stableHash(`${id}|${targetItemId}|${clientRequestId}`, 28)}`;
      const kpi = { kpiId, ...normalized, version: 1, createdAt: at, updatedAt: at };
      item.kpis.push(kpi);
      item.updatedAt = at;
      plan.version += 1;
      plan.updatedAt = at;
      state.requestKeys[request.key] = { signature, entityIds: [kpiId], createdAt: at };
      return { value: { idempotent: false, plan, item, kpi }, details: { companyId: plan.companyId, tenantCompanyId: plan.tenantCompanyId, planId: id, itemId: targetItemId, kpiId, before: null, after: kpi } };
    });
  }

  async function updateKpi(planId, itemId, kpiId, payload = {}, actor = "system") {
    const id = cleanId(planId, "planId");
    const targetItemId = cleanId(itemId, "itemId");
    const targetKpiId = cleanId(kpiId, "kpiId");
    return mutation("strategy.kpi.updated", actor, async (state) => {
      const plan = state.plans.find((row) => row.planId === id);
      if (!plan) throw strategyError("Action plan was not found", "STRATEGY_PLAN_NOT_FOUND", 404);
      const item = plan.items.find((row) => row.itemId === targetItemId);
      if (!item) throw strategyError("Action item was not found", "STRATEGY_ITEM_NOT_FOUND", 404);
      const index = item.kpis.findIndex((row) => row.kpiId === targetKpiId);
      if (index < 0) throw strategyError("KPI was not found", "STRATEGY_KPI_NOT_FOUND", 404);
      const current = item.kpis[index];
      const expectedVersion = Number(payload.expectedVersion || current.version);
      if (expectedVersion !== current.version) throw strategyError("KPI version conflict", "STRATEGY_VERSION_CONFLICT", 409);
      const normalized = normalizeKpi({ ...current, ...payload });
      const before = clone(current);
      const next = { ...current, ...normalized, version: current.version + 1, updatedAt: nowIso(clock) };
      item.kpis[index] = next;
      item.updatedAt = next.updatedAt;
      plan.version += 1;
      plan.updatedAt = next.updatedAt;
      return { value: { idempotent: false, plan, item, kpi: next }, details: { companyId: plan.companyId, tenantCompanyId: plan.tenantCompanyId, planId: id, itemId: targetItemId, kpiId: targetKpiId, before, after: next } };
    });
  }

  async function createRetrospective(payload = {}, actor = "system") {
    const planId = cleanId(payload.planId, "planId");
    const tenantCompanyId = cleanId(payload.tenantCompanyId, "tenantCompanyId");
    const clientRequestId = cleanId(payload.clientRequestId, "clientRequestId");
    const content = clone(payload.retrospective || {});
    assertBusinessSafe(content);
    const signature = stableHash({ planId, tenantCompanyId, content }, 64);
    return mutation("strategy.retrospective.created", actor, async (state) => {
      const request = requestRecord(state, "retrospective", tenantCompanyId, clientRequestId, signature);
      if (request.existing) {
        const existing = state.retrospectives.find((row) => row.retrospectiveId === request.existing.entityIds[0]);
        return { changed: false, value: { idempotent: true, retrospective: existing } };
      }
      const plan = state.plans.find((row) => row.planId === planId && row.tenantCompanyId === tenantCompanyId);
      if (!plan) throw strategyError("Action plan was not found", "STRATEGY_PLAN_NOT_FOUND", 404);
      const at = nowIso(clock);
      const retrospectiveId = `retro_${stableHash(`${tenantCompanyId}|${clientRequestId}|${planId}`, 28)}`;
      const retrospective = {
        schemaVersion: STRATEGY_SCHEMA_VERSION,
        retrospectiveId,
        planId,
        companyId: plan.companyId,
        tenantCompanyId,
        month: plan.month,
        ...content,
        retrospectiveId,
        planId,
        companyId: plan.companyId,
        tenantCompanyId,
        month: plan.month,
        version: 1,
        createdAt: at,
        updatedAt: at
      };
      state.retrospectives.push(retrospective);
      state.requestKeys[request.key] = { signature, entityIds: [retrospectiveId], createdAt: at };
      return { value: { idempotent: false, retrospective }, details: { companyId: plan.companyId, tenantCompanyId, planId, retrospectiveId, before: null, after: retrospective } };
    });
  }

  async function listRetrospectives(filter = {}) {
    await ensureReady();
    return clone(cache.state.retrospectives.filter((row) => {
      if (filter.companyId && row.companyId !== filter.companyId) return false;
      if (filter.tenantCompanyId && row.tenantCompanyId !== filter.tenantCompanyId) return false;
      if (filter.month && row.month !== filter.month) return false;
      if (filter.planId && row.planId !== filter.planId) return false;
      return true;
    }).sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt))));
  }

  async function getRetrospective(retrospectiveId) {
    await ensureReady();
    return clone(cache.state.retrospectives.find((row) => row.retrospectiveId === cleanId(retrospectiveId, "retrospectiveId")) || null);
  }

  async function createCandidates(payload = {}, actor = "system") {
    const retrospectiveId = cleanId(payload.retrospectiveId, "retrospectiveId");
    const tenantCompanyId = cleanId(payload.tenantCompanyId, "tenantCompanyId");
    const clientRequestId = cleanId(payload.clientRequestId, "clientRequestId");
    const targetMonth = requiredMonth(payload.targetMonth, "targetMonth");
    const candidates = clone(payload.candidates || []);
    candidates.forEach(assertBusinessSafe);
    const signature = stableHash({ retrospectiveId, tenantCompanyId, targetMonth, ids: candidates.map((row) => row.candidateId).sort() }, 64);
    return mutation("strategy.candidates.generated", actor, async (state) => {
      const request = requestRecord(state, `candidates:${retrospectiveId}`, tenantCompanyId, clientRequestId, signature);
      if (request.existing) {
        return { changed: false, value: { idempotent: true, candidates: state.candidates.filter((row) => request.existing.entityIds.includes(row.candidateId)) } };
      }
      const retrospective = state.retrospectives.find((row) => row.retrospectiveId === retrospectiveId && row.tenantCompanyId === tenantCompanyId);
      if (!retrospective) throw strategyError("Retrospective was not found", "STRATEGY_RETROSPECTIVE_NOT_FOUND", 404);
      const existingIds = new Set(state.candidates.map((row) => row.candidateId));
      const payloadLogicalKeys = new Set();
      const added = [];
      let createdCount = 0;
      for (const candidate of candidates) {
        if (candidate.retrospectiveId !== retrospectiveId || candidate.targetMonth !== targetMonth) {
          throw strategyError("Candidate lineage does not match its retrospective", "STRATEGY_LINEAGE_INVALID", 409);
        }
        const logicalKey = `${tenantCompanyId}|${targetMonth}|${cleanId(candidate.strategyId, "strategyId")}`;
        if (payloadLogicalKeys.has(logicalKey)) {
          throw strategyError("Only one next-month candidate is allowed per strategy", "STRATEGY_DUPLICATE_CONFLICT", 409);
        }
        payloadLogicalKeys.add(logicalKey);
        const expectedCandidateId = `candidate_${stableHash(logicalKey, 28)}`;
        if (candidate.candidateId !== expectedCandidateId) {
          throw strategyError("Candidate identifier must use the tenant, target month and strategy logical key", "STRATEGY_LINEAGE_INVALID", 409);
        }
        const existing = state.candidates.find((row) => (
          row.tenantCompanyId === tenantCompanyId
          && row.targetMonth === targetMonth
          && row.strategyId === candidate.strategyId
        ));
        if (existing) {
          added.push(existing);
          continue;
        }
        if (existingIds.has(candidate.candidateId)) throw strategyError("Duplicate candidate identifier", "STRATEGY_DUPLICATE_CONFLICT", 409);
        const stored = { ...candidate, tenantCompanyId };
        state.candidates.push(stored);
        added.push(stored);
        existingIds.add(candidate.candidateId);
        createdCount += 1;
      }
      state.requestKeys[request.key] = { signature, entityIds: added.map((row) => row.candidateId), createdAt: nowIso(clock) };
      return { value: { idempotent: candidates.length > 0 && createdCount === 0, candidates: added }, details: { companyId: retrospective.companyId, tenantCompanyId, retrospectiveId, targetMonth, candidateIds: added.map((row) => row.candidateId), createdCount } };
    });
  }

  async function listCandidates(filter = {}) {
    await ensureReady();
    return clone(cache.state.candidates.filter((row) => {
      if (filter.companyId && row.companyId !== filter.companyId) return false;
      if (filter.tenantCompanyId && row.tenantCompanyId !== filter.tenantCompanyId) return false;
      if (filter.targetMonth && row.targetMonth !== filter.targetMonth) return false;
      if (filter.type && row.type !== filter.type) return false;
      if (filter.retrospectiveId && row.retrospectiveId !== filter.retrospectiveId) return false;
      return true;
    }).sort((left, right) => String(left.type).localeCompare(String(right.type)) || String(left.title).localeCompare(String(right.title))));
  }

  async function listAudit(filter = {}) {
    await ensureReady();
    const limit = Math.max(1, Math.min(10_000, Number(filter.limit || 1000)));
    return clone(cache.audit.filter((row) => {
      if (filter.event && row.event !== filter.event) return false;
      if (filter.companyId && row.details?.companyId !== filter.companyId) return false;
      if (filter.planId && row.details?.planId !== filter.planId) return false;
      if (filter.itemId && row.details?.itemId !== filter.itemId) return false;
      if (filter.kpiId && row.details?.kpiId !== filter.kpiId) return false;
      if (filter.retrospectiveId && row.details?.retrospectiveId !== filter.retrospectiveId) return false;
      return true;
    }).slice(-limit));
  }

  async function diagnostics() {
    await ensureReady();
    return {
      ...summary(),
      ...metrics,
      dataDirectoryFingerprint: stableHash(initialCanonical, 24)
    };
  }

  return Object.freeze({
    initialize,
    createStrategySet,
    getStrategy,
    listStrategies,
    createPlan,
    getPlan,
    listPlans,
    updatePlan,
    addPlanItem,
    updatePlanItem,
    addKpi,
    updateKpi,
    createRetrospective,
    getRetrospective,
    listRetrospectives,
    createCandidates,
    listCandidates,
    listAudit,
    diagnostics
  });
}

module.exports = {
  STRATEGY_DIRECTORY,
  STRATEGY_LOCK_FILE,
  STRATEGY_STATE_FILES,
  assertManifest,
  assertState,
  createStrategyRepository,
  emptyManifest,
  emptyState,
  normalizeActor
};
