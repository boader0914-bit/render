"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { resolveFreshIntegrationDataDir } = require("./fresh_store.cjs");
const {
  INSIGHTS_ALGORITHM_VERSION,
  INSIGHTS_FIXTURE_VERSION,
  INSIGHTS_SCHEMA_VERSION,
  INSIGHTS_STORE_KIND,
  assertLifecycleTransition,
  canonicalJson,
  cleanId,
  cleanText,
  clone,
  insightsError,
  normalizeSignalObservation,
  stableHash
} = require("../contracts/insights.cjs");

const INSIGHTS_DIRECTORY = "stage229-insights";
const INSIGHTS_LOCK_FILE = ".stage229-insights.lock";
const INSIGHTS_STATE_FILES = Object.freeze({
  manifest: "manifest.json",
  cards: "state/location-cards.json",
  reports: "state/monthly-reports.json",
  indexes: "indexes/append-keys.json"
});
const INSIGHTS_CHUNK_LAYERS = Object.freeze(["signals", "evidence", "audit"]);
const SNAPSHOT_MANIFEST = "snapshot.json";

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

function emptyManifest(clock, idFactory, freshStoreId) {
  const at = nowIso(clock);
  return {
    schemaVersion: INSIGHTS_SCHEMA_VERSION,
    storeKind: INSIGHTS_STORE_KIND,
    storeId: `insights_${cleanText(idFactory(), 80).replace(/[^A-Za-z0-9_-]/g, "")}`,
    parentFreshStoreId: cleanText(freshStoreId, 160),
    algorithmVersion: INSIGHTS_ALGORITHM_VERSION,
    fixtureVersion: INSIGHTS_FIXTURE_VERSION,
    dataBoundary: "fresh-integration-stage229-only",
    createdAt: at,
    updatedAt: at,
    revision: 0,
    appendSequences: { signals: 0, evidence: 0, audit: 0 },
    externalProviderCalls: 0,
    credentialReads: 0,
    legacyRuntimeReads: 0,
    legacyRuntimeCopies: 0,
    productionMutations: 0
  };
}

function emptyCards() {
  return { schemaVersion: INSIGHTS_SCHEMA_VERSION, cards: [] };
}

function emptyReports() {
  return { schemaVersion: INSIGHTS_SCHEMA_VERSION, reports: [] };
}

function emptyIndexes() {
  return {
    schemaVersion: INSIGHTS_SCHEMA_VERSION,
    signalIds: [],
    evidenceSnapshotIds: [],
    cardRequestKeys: [],
    reportRequestKeys: []
  };
}

function assertSchema(value, label) {
  if (!value || value.schemaVersion !== INSIGHTS_SCHEMA_VERSION) {
    throw insightsError(`Unsupported ${label} schema version`, "INSIGHTS_SCHEMA_UNSUPPORTED", 500);
  }
  return value;
}

function assertManifest(value, freshStoreId = "") {
  assertSchema(value, "insights manifest");
  if (value.storeKind !== INSIGHTS_STORE_KIND) {
    throw insightsError("Configured directory is not a Stage 229 insights store", "INSIGHTS_STORE_KIND_INVALID", 500);
  }
  if (value.algorithmVersion !== INSIGHTS_ALGORITHM_VERSION || value.fixtureVersion !== INSIGHTS_FIXTURE_VERSION) {
    throw insightsError("Stage 229 algorithm or fixture version mismatch", "INSIGHTS_VERSION_MISMATCH", 500);
  }
  if (freshStoreId && value.parentFreshStoreId && value.parentFreshStoreId !== freshStoreId) {
    throw insightsError("Stage 229 store belongs to a different fresh store", "INSIGHTS_PARENT_STORE_MISMATCH", 409);
  }
  if (!INSIGHTS_CHUNK_LAYERS.every((layer) => Number.isInteger(value.appendSequences?.[layer]))) {
    throw insightsError("Stage 229 append sequences are invalid", "INSIGHTS_STORE_CORRUPT", 500);
  }
  return value;
}

function normalizeActor(actor) {
  if (!actor || typeof actor !== "object") return { id: cleanText(actor || "system", 160), role: "", type: "system" };
  return {
    id: cleanText(actor.accountId || actor.actorAccountId || actor.id || "system", 160),
    role: cleanText(actor.role || actor.actorRole, 48),
    type: cleanText(actor.type || "account", 48)
  };
}

function createInsightsRepository(options = {}) {
  const env = options.env || process.env;
  const clock = options.clock || Date.now;
  const idFactory = options.idFactory || crypto.randomUUID;
  const projectRoot = path.resolve(options.projectRoot || path.resolve(__dirname, "../../.."));
  let freshStoreId = cleanText(options.freshStoreId, 160);
  const resolveFreshStoreId = typeof options.resolveFreshStoreId === "function"
    ? options.resolveFreshStoreId
    : null;
  const boundary = resolveFreshIntegrationDataDir({
    env,
    projectRoot,
    dataDir: options.dataDir,
    legacyPaths: options.legacyPaths
  });
  const freshRoot = boundary.configured;
  const root = path.join(freshRoot, INSIGHTS_DIRECTORY);
  const initialCanonical = canonicalizeCandidate(root);
  if (!isInsideOrEqual(freshRoot, root) || !isInsideOrEqual(boundary.canonical, initialCanonical)) {
    throw insightsError("Stage 229 store escaped the fresh integration root", "INSIGHTS_PATH_ESCAPE", 500);
  }
  const metrics = {
    repositoryFileReads: 0,
    repositoryFileWrites: 0,
    repositoryFileCopies: 0,
    externalRequests: 0,
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
    if (!isInsideOrEqual(root, target)) throw insightsError("Stage 229 repository path escaped its root", "INSIGHTS_PATH_ESCAPE", 500);
    const rootCanonical = canonicalizeCandidate(root);
    const targetCanonical = canonicalizeCandidate(target);
    if (
      !isInsideOrEqual(boundary.canonical, rootCanonical)
      || !isInsideOrEqual(rootCanonical, targetCanonical)
    ) {
      throw insightsError("Stage 229 repository path escaped through a link", "INSIGHTS_PATH_ESCAPE", 500);
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
    // A cold store has no Stage 229 directory yet. Create only the already
    // boundary-checked child directory before opening its lock file.
    await fsp.mkdir(root, { recursive: true });
    const lockPath = absolute(INSIGHTS_LOCK_FILE);
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
        if (Date.now() - started > 10_000) throw insightsError("Stage 229 store lock timed out", "INSIGHTS_LOCK_TIMEOUT", 503);
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

  const restoreItems = Object.freeze(["state", "indexes", "signals", "evidence", INSIGHTS_STATE_FILES.manifest]);

  async function recoverRestoreTransactions() {
    let entries = [];
    try {
      entries = await fsp.readdir(root, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^\.stage229-restore-[A-Za-z0-9_-]+$/.test(entry.name)) continue;
      const transactionRoot = absolute(entry.name);
      let journal = null;
      try {
        journal = JSON.parse(await fsp.readFile(path.join(transactionRoot, "journal.json"), "utf8"));
      } catch {}
      if (journal?.status !== "committed") {
        let restoredAny = false;
        const failedRoot = path.join(transactionRoot, "recovery-discard");
        await fsp.mkdir(failedRoot, { recursive: true });
        for (const item of [...restoreItems].reverse()) {
          const live = absolute(item);
          const backup = path.join(transactionRoot, "backup", ...item.split("/"));
          if (!fs.existsSync(backup)) continue;
          if (fs.existsSync(live)) {
            const discarded = path.join(failedRoot, ...item.split("/"));
            await fsp.mkdir(path.dirname(discarded), { recursive: true });
            await fsp.rm(discarded, { recursive: true, force: true });
            await fsp.rename(live, discarded);
          }
          await fsp.mkdir(path.dirname(live), { recursive: true });
          await fsp.rename(backup, live);
          restoredAny = true;
        }
        if (restoredAny && fs.existsSync(absolute(INSIGHTS_STATE_FILES.manifest))) {
          const manifest = assertManifest(await readJson(INSIGHTS_STATE_FILES.manifest), freshStoreId);
          const auditFiles = await listChunkFiles("audit");
          const maximumAuditSequence = auditFiles.reduce((maximum, relative) => (
            Math.max(maximum, Number.parseInt(path.basename(relative, ".jsonl"), 10) || 0)
          ), 0);
          manifest.appendSequences.audit = maximumAuditSequence;
          manifest.updatedAt = nowIso(clock);
          await writeJson(INSIGHTS_STATE_FILES.manifest, manifest);
        }
      }
      await fsp.rm(transactionRoot, { recursive: true, force: true });
    }
  }

  async function listChunkFiles(layer) {
    const relative = `${layer}/chunks`;
    const directory = absolute(relative);
    try {
      const entries = await fsp.readdir(directory, { withFileTypes: true });
      return entries.filter((entry) => entry.isFile() && /^\d{8}\.jsonl$/.test(entry.name))
        .map((entry) => `${relative}/${entry.name}`).sort();
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
  }

  async function readChunks(layer) {
    const rows = [];
    for (const relative of await listChunkFiles(layer)) {
      metrics.repositoryFileReads += 1;
      const content = await fsp.readFile(absolute(relative), "utf8");
      for (const line of content.split(/\r?\n/).filter(Boolean)) rows.push(JSON.parse(line));
    }
    return rows;
  }

  async function writeChunk(layer, rows) {
    if (!rows.length) return null;
    const sequence = Number(cache.manifest.appendSequences[layer] || 0) + 1;
    const relative = `${layer}/chunks/${String(sequence).padStart(8, "0")}.jsonl`;
    await atomicWrite(relative, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
    cache.manifest.appendSequences[layer] = sequence;
    cache[layer].push(...clone(rows));
    return relative;
  }

  async function loadAll() {
    cache = {
      manifest: assertManifest(await readJson(INSIGHTS_STATE_FILES.manifest), freshStoreId),
      cards: assertSchema(await readJson(INSIGHTS_STATE_FILES.cards), "location cards"),
      reports: assertSchema(await readJson(INSIGHTS_STATE_FILES.reports), "monthly reports"),
      indexes: assertSchema(await readJson(INSIGHTS_STATE_FILES.indexes), "insights indexes"),
      signals: await readChunks("signals"),
      evidence: await readChunks("evidence"),
      audit: await readChunks("audit")
    };
    return cache;
  }

  async function appendAudit(event, actor, details = {}) {
    const actorValue = normalizeActor(actor);
    const row = {
      schemaVersion: INSIGHTS_SCHEMA_VERSION,
      auditId: `insights_audit_${crypto.randomUUID()}`,
      event: cleanText(event, 120),
      actor: actorValue.id,
      actorRole: actorValue.role,
      actorType: actorValue.type,
      at: nowIso(clock),
      details: clone(details)
    };
    await writeChunk("audit", [row]);
    return row;
  }

  async function finishMutation(event, actor, details = {}) {
    const audit = await appendAudit(event, actor, details);
    cache.manifest.revision += 1;
    cache.manifest.updatedAt = nowIso(clock);
    await writeJson(INSIGHTS_STATE_FILES.manifest, cache.manifest);
    return audit;
  }

  async function initializeInsideLock() {
    if (!freshStoreId && resolveFreshStoreId) {
      freshStoreId = cleanText(await resolveFreshStoreId(), 160);
    }
    if (!freshStoreId) {
      throw insightsError("Stage 229 requires an initialized Stage 228 parent store", "INSIGHTS_PARENT_STORE_REQUIRED", 500);
    }
    await fsp.mkdir(root, { recursive: true });
    await recoverRestoreTransactions();
    for (const directory of ["state", "indexes", "signals/chunks", "evidence/chunks", "audit/chunks", "snapshots"]) {
      await fsp.mkdir(absolute(directory), { recursive: true });
    }
    const manifestPath = absolute(INSIGHTS_STATE_FILES.manifest);
    if (!fs.existsSync(manifestPath)) {
      cache = {
        manifest: emptyManifest(clock, idFactory, freshStoreId),
        cards: emptyCards(),
        reports: emptyReports(),
        indexes: emptyIndexes(),
        signals: [],
        evidence: [],
        audit: []
      };
      await writeJson(INSIGHTS_STATE_FILES.manifest, cache.manifest);
      await writeJson(INSIGHTS_STATE_FILES.cards, cache.cards);
      await writeJson(INSIGHTS_STATE_FILES.reports, cache.reports);
      await writeJson(INSIGHTS_STATE_FILES.indexes, cache.indexes);
      await appendAudit("insights.store.bootstrap", "system", {
        storeId: cache.manifest.storeId,
        parentFreshStoreId: freshStoreId,
        dataBoundary: cache.manifest.dataBoundary
      });
      cache.manifest.revision = 1;
      cache.manifest.updatedAt = nowIso(clock);
      await writeJson(INSIGHTS_STATE_FILES.manifest, cache.manifest);
    } else {
      await loadAll();
    }
    initialized = true;
    return summary();
  }

  function summary() {
    return {
      storeKind: cache.manifest.storeKind,
      schemaVersion: cache.manifest.schemaVersion,
      storeId: cache.manifest.storeId,
      parentFreshStoreId: cache.manifest.parentFreshStoreId,
      algorithmVersion: cache.manifest.algorithmVersion,
      fixtureVersion: cache.manifest.fixtureVersion,
      revision: cache.manifest.revision,
      counts: {
        signals: cache.signals.length,
        evidenceSnapshots: cache.evidence.length,
        locationCards: cache.cards.cards.length,
        monthlyReports: cache.reports.reports.length,
        audit: cache.audit.length
      }
    };
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
      const result = await work(cache);
      if (result?.changed === false) return clone(result.value);
      await finishMutation(event, actor, result?.details || {});
      return clone(result?.value);
    }));
  }

  async function appendSignals(records = [], context = {}) {
    const rows = records.map(normalizeSignalObservation);
    return mutation("insights.signals.appended", context.actor || "system", async (state) => {
      const known = new Set(state.indexes.signalIds);
      const inserted = [];
      let duplicates = 0;
      for (const row of rows) {
        if (known.has(row.signalId)) duplicates += 1;
        else {
          known.add(row.signalId);
          inserted.push(row);
        }
      }
      if (!inserted.length) return { changed: false, value: { inserted: 0, duplicates } };
      await writeChunk("signals", inserted);
      state.indexes.signalIds = [...known];
      await writeJson(INSIGHTS_STATE_FILES.indexes, state.indexes);
      return {
        value: { inserted: inserted.length, duplicates },
        details: { companyIds: [...new Set(inserted.map((row) => row.companyId))], inserted: inserted.length, duplicates }
      };
    });
  }

  async function listSignals(filter = {}) {
    await ensureReady();
    const limit = Math.max(1, Math.min(100_000, Number(filter.limit || 10_000)));
    return clone(cache.signals.filter((row) => {
      if (filter.companyId && row.companyId !== filter.companyId) return false;
      if (filter.kind && row.kind !== filter.kind) return false;
      if (filter.periodMonth && row.periodMonth !== filter.periodMonth) return false;
      return true;
    }).slice(-limit));
  }

  async function appendEvidenceSnapshot(payload = {}, actor = "system") {
    const companyId = cleanId(payload.companyId, "companyId");
    const observedAtRange = {
      from: cleanText(payload.observedAtRange?.from, 48),
      to: cleanText(payload.observedAtRange?.to, 48)
    };
    const internal = clone(payload.internal || {});
    const contentHash = stableHash(canonicalJson({ companyId, observedAtRange, internal }), 64);
    const evidenceSnapshotId = cleanText(payload.evidenceSnapshotId, 160)
      ? cleanId(payload.evidenceSnapshotId, "evidenceSnapshotId")
      : `evidence_snapshot_${contentHash.slice(0, 32)}`;
    const row = {
      schemaVersion: INSIGHTS_SCHEMA_VERSION,
      evidenceSnapshotId,
      companyId,
      createdAt: nowIso(clock),
      algorithmVersion: INSIGHTS_ALGORITHM_VERSION,
      fixtureVersion: INSIGHTS_FIXTURE_VERSION,
      observedAtRange,
      observationCount: Number(payload.observationCount || 0),
      signalCount: Number(payload.signalCount || 0),
      contentHash,
      sourceBoundary: "fresh-integration-stage229-only",
      internal
    };
    return mutation("insights.evidence.created", actor, async (state) => {
      const existing = state.evidence.find((entry) => entry.evidenceSnapshotId === evidenceSnapshotId);
      if (existing) {
        if (existing.contentHash !== contentHash) throw insightsError("Evidence snapshot idempotency conflict", "INSIGHTS_IDEMPOTENCY_CONFLICT", 409);
        return { changed: false, value: { idempotent: true, evidence: existing } };
      }
      await writeChunk("evidence", [row]);
      state.indexes.evidenceSnapshotIds.push(evidenceSnapshotId);
      await writeJson(INSIGHTS_STATE_FILES.indexes, state.indexes);
      return { value: { idempotent: false, evidence: row }, details: { evidenceSnapshotId, companyId, contentHash } };
    });
  }

  async function getEvidenceSnapshot(evidenceSnapshotId) {
    await ensureReady();
    const id = cleanId(evidenceSnapshotId, "evidenceSnapshotId");
    return clone(cache.evidence.find((row) => row.evidenceSnapshotId === id) || null);
  }

  async function listEvidenceSnapshots(filter = {}) {
    await ensureReady();
    const limit = Math.max(1, Math.min(10_000, Number(filter.limit || 1000)));
    return clone(cache.evidence.filter((row) => (
      !filter.companyId || row.companyId === filter.companyId
    )).slice(-limit));
  }

  function requestKey(tenantCompanyId, clientRequestId) {
    return `${tenantCompanyId}|${clientRequestId}`;
  }

  async function createLocationCardRequest(payload = {}, actor = "system") {
    const companyId = cleanId(payload.companyId, "companyId");
    const tenantCompanyId = cleanId(payload.tenantCompanyId, "tenantCompanyId");
    const clientRequestId = cleanId(payload.clientRequestId, "clientRequestId");
    const key = requestKey(tenantCompanyId, clientRequestId);
    const synthetic = payload.synthetic !== false;
    const dataMode = !synthetic && cleanText(payload.dataMode, 32) === "live" ? "live" : "test-fixture";
    const signature = stableHash({ companyId, tenantCompanyId, synthetic, dataMode }, 64);
    return mutation("insights.location-card.requested", actor, async (state) => {
      const existing = state.cards.cards.find((row) => row.requestKey === key);
      if (existing) {
        if (existing.requestSignature !== signature) throw insightsError("Location card request idempotency conflict", "INSIGHTS_IDEMPOTENCY_CONFLICT", 409);
        return { changed: false, value: { idempotent: true, card: existing } };
      }
      const at = nowIso(clock);
      const card = {
        schemaVersion: INSIGHTS_SCHEMA_VERSION,
        cardId: `location_card_${stableHash(key, 28)}`,
        requestKey: key,
        requestSignature: signature,
        clientRequestId,
        companyId,
        tenantCompanyId,
        synthetic,
        dataMode,
        requestedByAccountId: normalizeActor(actor).id,
        lifecycle: "requested",
        version: 1,
        requestedAt: at,
        updatedAt: at,
        publishedAt: "",
        evidenceSnapshotId: "",
        analysis: null,
        editorial: { headline: "", summary: "", note: "" },
        review: null
      };
      state.cards.cards.push(card);
      state.indexes.cardRequestKeys.push(key);
      await writeJson(INSIGHTS_STATE_FILES.cards, state.cards);
      await writeJson(INSIGHTS_STATE_FILES.indexes, state.indexes);
      return { value: { idempotent: false, card }, details: { cardId: card.cardId, companyId, tenantCompanyId, before: null, after: card } };
    });
  }

  async function transitionLocationCard(cardId, payload = {}, actor = "system") {
    const id = cleanId(cardId, "cardId");
    const to = cleanText(payload.to, 48);
    return mutation(`insights.location-card.${to}`, actor, async (state) => {
      const index = state.cards.cards.findIndex((row) => row.cardId === id);
      if (index < 0) throw insightsError("Location card was not found", "INSIGHTS_CARD_NOT_FOUND", 404);
      const current = state.cards.cards[index];
      const expectedVersion = Number(payload.expectedVersion || current.version);
      if (expectedVersion !== current.version) throw insightsError("Location card version conflict", "INSIGHTS_VERSION_CONFLICT", 409);
      assertLifecycleTransition(current.lifecycle, to);
      const before = clone(current);
      const next = {
        ...current,
        ...clone(payload.patch || {}),
        cardId: current.cardId,
        requestKey: current.requestKey,
        requestSignature: current.requestSignature,
        companyId: current.companyId,
        tenantCompanyId: current.tenantCompanyId,
        synthetic: current.synthetic,
        dataMode: current.dataMode,
        lifecycle: to,
        version: current.version + 1,
        updatedAt: nowIso(clock),
        publishedAt: to === "published" ? nowIso(clock) : current.publishedAt
      };
      state.cards.cards[index] = next;
      await writeJson(INSIGHTS_STATE_FILES.cards, state.cards);
      return { value: { idempotent: false, card: next }, details: { cardId: id, companyId: next.companyId, before, after: next } };
    });
  }

  async function getLocationCard(cardId) {
    await ensureReady();
    return clone(cache.cards.cards.find((row) => row.cardId === cleanId(cardId, "cardId")) || null);
  }

  async function listLocationCards(filter = {}) {
    await ensureReady();
    return clone(cache.cards.cards.filter((row) => {
      if (filter.companyId && row.companyId !== filter.companyId) return false;
      if (filter.tenantCompanyId && row.tenantCompanyId !== filter.tenantCompanyId) return false;
      if (filter.lifecycle && row.lifecycle !== filter.lifecycle) return false;
      return true;
    }).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))));
  }

  async function createMonthlyReport(payload = {}, actor = "system") {
    const companyId = cleanId(payload.companyId, "companyId");
    const tenantCompanyId = cleanId(payload.tenantCompanyId, "tenantCompanyId");
    const clientRequestId = cleanId(payload.clientRequestId, "clientRequestId");
    const month = cleanText(payload.month, 12);
    if (!/^\d{4}-\d{2}$/.test(month)) throw insightsError("Report month must use YYYY-MM", "INSIGHTS_MONTH_INVALID");
    const key = requestKey(tenantCompanyId, clientRequestId);
    const synthetic = payload.synthetic !== false;
    const dataMode = !synthetic && cleanText(payload.dataMode, 32) === "live" ? "live" : "test-fixture";
    const signature = stableHash({ companyId, tenantCompanyId, month, synthetic, dataMode }, 64);
    return mutation("insights.monthly-report.requested", actor, async (state) => {
      const existing = state.reports.reports.find((row) => row.requestKey === key);
      if (existing) {
        if (existing.requestSignature !== signature) throw insightsError("Monthly report idempotency conflict", "INSIGHTS_IDEMPOTENCY_CONFLICT", 409);
        return { changed: false, value: { idempotent: true, report: existing } };
      }
      const at = nowIso(clock);
      const report = {
        schemaVersion: INSIGHTS_SCHEMA_VERSION,
        reportId: `monthly_report_${stableHash(`${key}|${month}`, 28)}`,
        requestKey: key,
        requestSignature: signature,
        clientRequestId,
        companyId,
        tenantCompanyId,
        synthetic,
        dataMode,
        month,
        lifecycle: "requested",
        version: 1,
        requestedAt: at,
        updatedAt: at,
        publishedAt: "",
        evidenceSnapshotId: "",
        report: null,
        editorial: { headline: "", summary: "", note: "" },
        review: null
      };
      state.reports.reports.push(report);
      state.indexes.reportRequestKeys.push(key);
      await writeJson(INSIGHTS_STATE_FILES.reports, state.reports);
      await writeJson(INSIGHTS_STATE_FILES.indexes, state.indexes);
      return { value: { idempotent: false, report }, details: { reportId: report.reportId, companyId, tenantCompanyId, before: null, after: report } };
    });
  }

  async function transitionMonthlyReport(reportId, payload = {}, actor = "system") {
    const id = cleanId(reportId, "reportId");
    const to = cleanText(payload.to, 48);
    return mutation(`insights.monthly-report.${to}`, actor, async (state) => {
      const index = state.reports.reports.findIndex((row) => row.reportId === id);
      if (index < 0) throw insightsError("Monthly report was not found", "INSIGHTS_REPORT_NOT_FOUND", 404);
      const current = state.reports.reports[index];
      const expectedVersion = Number(payload.expectedVersion || current.version);
      if (expectedVersion !== current.version) throw insightsError("Monthly report version conflict", "INSIGHTS_VERSION_CONFLICT", 409);
      assertLifecycleTransition(current.lifecycle, to);
      const before = clone(current);
      const next = {
        ...current,
        ...clone(payload.patch || {}),
        reportId: current.reportId,
        requestKey: current.requestKey,
        requestSignature: current.requestSignature,
        companyId: current.companyId,
        tenantCompanyId: current.tenantCompanyId,
        synthetic: current.synthetic,
        dataMode: current.dataMode,
        lifecycle: to,
        version: current.version + 1,
        updatedAt: nowIso(clock),
        publishedAt: to === "published" ? nowIso(clock) : current.publishedAt
      };
      state.reports.reports[index] = next;
      await writeJson(INSIGHTS_STATE_FILES.reports, state.reports);
      return { value: { idempotent: false, report: next }, details: { reportId: id, companyId: next.companyId, before, after: next } };
    });
  }

  async function getMonthlyReport(reportId) {
    await ensureReady();
    return clone(cache.reports.reports.find((row) => row.reportId === cleanId(reportId, "reportId")) || null);
  }

  async function listMonthlyReports(filter = {}) {
    await ensureReady();
    return clone(cache.reports.reports.filter((row) => {
      if (filter.companyId && row.companyId !== filter.companyId) return false;
      if (filter.tenantCompanyId && row.tenantCompanyId !== filter.tenantCompanyId) return false;
      if (filter.month && row.month !== filter.month) return false;
      if (filter.lifecycle && row.lifecycle !== filter.lifecycle) return false;
      return true;
    }).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))));
  }

  async function listAudit(filter = {}) {
    await ensureReady();
    const limit = Math.max(1, Math.min(10_000, Number(filter.limit || 1000)));
    return clone(cache.audit.filter((row) => {
      if (filter.event && row.event !== filter.event) return false;
      if (filter.companyId && row.details?.companyId !== filter.companyId) return false;
      if (filter.cardId && row.details?.cardId !== filter.cardId) return false;
      if (filter.reportId && row.details?.reportId !== filter.reportId) return false;
      return true;
    }).slice(-limit));
  }

  async function managedFiles() {
    const rows = [];
    async function walk(relative = "") {
      const directory = absolute(relative);
      const entries = await fsp.readdir(directory, { withFileTypes: true });
      for (const entry of entries) {
        const child = relative ? `${relative}/${entry.name}` : entry.name;
        if (
          child === INSIGHTS_LOCK_FILE
          || child === "snapshots"
          || child.startsWith("snapshots/")
          || child.startsWith(".stage229-restore-")
        ) continue;
        if (entry.isSymbolicLink()) throw insightsError("Stage 229 snapshots refuse symbolic links", "INSIGHTS_PATH_ESCAPE", 500);
        if (entry.isDirectory()) await walk(child);
        else if (entry.isFile() && !entry.name.endsWith(".tmp")) rows.push(child);
      }
    }
    await walk();
    return rows.sort();
  }

  async function createSnapshot(actor = "system", label = "manual") {
    await initialize();
    return serialize(() => withLock(async () => {
      await loadAll();
      const snapshotId = `insights_snapshot_${String(cache.manifest.revision).padStart(8, "0")}_${crypto.randomUUID().slice(0, 8)}`;
      const staging = absolute(`snapshots/.${snapshotId}.${process.pid}.tmp`);
      const final = absolute(`snapshots/${snapshotId}`);
      await fsp.mkdir(path.join(staging, "files"), { recursive: true });
      const files = [];
      try {
        for (const relative of await managedFiles()) {
          const source = absolute(relative);
          const destination = path.join(staging, "files", ...relative.split("/"));
          await fsp.mkdir(path.dirname(destination), { recursive: true });
          const data = await fsp.readFile(source);
          metrics.repositoryFileReads += 1;
          await fsp.writeFile(destination, data, { mode: 0o600 });
          metrics.repositoryFileCopies += 1;
          files.push({ relative, size: data.length, checksum: crypto.createHash("sha256").update(data).digest("hex") });
        }
        const snapshot = {
          schemaVersion: INSIGHTS_SCHEMA_VERSION,
          snapshotKind: "stage229-insights-snapshot",
          snapshotId,
          storeId: cache.manifest.storeId,
          storeRevision: cache.manifest.revision,
          label: cleanText(label, 160),
          createdAt: nowIso(clock),
          createdBy: normalizeActor(actor).id,
          files,
          filesHash: stableHash(files, 64)
        };
        await fsp.writeFile(path.join(staging, SNAPSHOT_MANIFEST), `${JSON.stringify(snapshot, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
        await fsp.rename(staging, final);
        await finishMutation("insights.snapshot.created", actor, { snapshotId, fileCount: files.length });
        return clone(snapshot);
      } catch (error) {
        await fsp.rm(staging, { recursive: true, force: true }).catch(() => undefined);
        throw error;
      }
    }));
  }

  async function listSnapshots() {
    await ensureReady();
    const rows = [];
    for (const entry of await fsp.readdir(absolute("snapshots"), { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      try {
        const snapshot = JSON.parse(await fsp.readFile(absolute(`snapshots/${entry.name}/${SNAPSHOT_MANIFEST}`), "utf8"));
        if (snapshot.snapshotKind === "stage229-insights-snapshot" && snapshot.storeId === cache.manifest.storeId) rows.push(snapshot);
      } catch {}
    }
    return clone(rows.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))));
  }

  async function rollbackSnapshot(snapshotId, actor = "system") {
    const id = cleanId(snapshotId, "snapshotId");
    await initialize();
    return serialize(() => withLock(async () => {
      await loadAll();
      const revision = cache.manifest.revision;
      const auditSequence = cache.manifest.appendSequences.audit;
      const snapshot = JSON.parse(await fsp.readFile(absolute(`snapshots/${id}/${SNAPSHOT_MANIFEST}`), "utf8"));
      if (snapshot.snapshotKind !== "stage229-insights-snapshot" || snapshot.storeId !== cache.manifest.storeId) {
        throw insightsError("Snapshot does not belong to this Stage 229 store", "INSIGHTS_SNAPSHOT_INVALID", 409);
      }
      if (
        !Array.isArray(snapshot.files)
        || !snapshot.filesHash
        || stableHash(snapshot.files, 64) !== snapshot.filesHash
      ) {
        throw insightsError("Snapshot file manifest checksum mismatch", "INSIGHTS_SNAPSHOT_CORRUPT", 500);
      }

      const transactionName = `.stage229-restore-${crypto.randomUUID()}`;
      const transactionRoot = absolute(transactionName);
      const preparedRoot = path.join(transactionRoot, "prepared");
      const backupRoot = path.join(transactionRoot, "backup");
      let swapStarted = false;
      try {
        for (const directory of ["state", "indexes", "signals/chunks", "evidence/chunks", "backup"]) {
          await fsp.mkdir(path.join(preparedRoot, ...directory.split("/")), { recursive: true });
        }
        await fsp.mkdir(backupRoot, { recursive: true });
        const seen = new Set();
        const mandatory = new Set(Object.values(INSIGHTS_STATE_FILES));
        let restoredManifest = null;
        for (const file of snapshot.files) {
          const relative = String(file.relative || "").replace(/\\/g, "/");
          const allowed = Object.values(INSIGHTS_STATE_FILES).includes(relative)
            || /^(?:signals|evidence|audit)\/chunks\/\d{8}\.jsonl$/.test(relative);
          if (
            !allowed
            || path.posix.normalize(relative) !== relative
            || relative.startsWith("../")
            || seen.has(relative)
          ) {
            throw insightsError("Snapshot contains an invalid or duplicate file path", "INSIGHTS_SNAPSHOT_CORRUPT", 500);
          }
          seen.add(relative);
          const data = await fsp.readFile(absolute(`snapshots/${id}/files/${relative}`));
          metrics.repositoryFileReads += 1;
          const checksum = crypto.createHash("sha256").update(data).digest("hex");
          if (checksum !== file.checksum || Number(file.size) !== data.length) {
            throw insightsError("Snapshot checksum mismatch", "INSIGHTS_SNAPSHOT_CORRUPT", 500);
          }
          const content = data.toString("utf8");
          if (relative === INSIGHTS_STATE_FILES.manifest) {
            restoredManifest = assertManifest(JSON.parse(content), freshStoreId);
          } else if (relative === INSIGHTS_STATE_FILES.cards) {
            const value = assertSchema(JSON.parse(content), "snapshot location cards");
            if (!Array.isArray(value.cards)) throw insightsError("Snapshot card state is invalid", "INSIGHTS_SNAPSHOT_CORRUPT", 500);
          } else if (relative === INSIGHTS_STATE_FILES.reports) {
            const value = assertSchema(JSON.parse(content), "snapshot monthly reports");
            if (!Array.isArray(value.reports)) throw insightsError("Snapshot report state is invalid", "INSIGHTS_SNAPSHOT_CORRUPT", 500);
          } else if (relative === INSIGHTS_STATE_FILES.indexes) {
            assertSchema(JSON.parse(content), "snapshot insights indexes");
          } else {
            for (const line of content.split(/\r?\n/).filter(Boolean)) {
              const row = JSON.parse(line);
              if (row.schemaVersion !== INSIGHTS_SCHEMA_VERSION) {
                throw insightsError("Snapshot chunk schema is invalid", "INSIGHTS_SNAPSHOT_CORRUPT", 500);
              }
              if (relative.startsWith("signals/chunks/")) normalizeSignalObservation(row);
            }
          }
          if (!relative.startsWith("audit/chunks/") && relative !== INSIGHTS_STATE_FILES.manifest) {
            await atomicWrite(`${transactionName}/prepared/${relative}`, content);
          }
        }
        for (const relative of mandatory) {
          if (!seen.has(relative)) throw insightsError("Snapshot is missing a required state file", "INSIGHTS_SNAPSHOT_CORRUPT", 500);
        }
        restoredManifest.revision = revision;
        restoredManifest.appendSequences.audit = auditSequence;
        restoredManifest.updatedAt = nowIso(clock);
        await atomicWrite(
          `${transactionName}/prepared/${INSIGHTS_STATE_FILES.manifest}`,
          `${JSON.stringify(restoredManifest, null, 2)}\n`
        );
        await atomicWrite(`${transactionName}/journal.json`, `${JSON.stringify({
          schemaVersion: INSIGHTS_SCHEMA_VERSION,
          status: "swapping",
          snapshotId: id,
          createdAt: nowIso(clock),
          items: restoreItems
        }, null, 2)}\n`);
        swapStarted = true;

        for (const item of restoreItems) {
          const live = absolute(item);
          const prepared = path.join(preparedRoot, ...item.split("/"));
          const backup = path.join(backupRoot, ...item.split("/"));
          await fsp.mkdir(path.dirname(backup), { recursive: true });
          await fsp.rename(live, backup);
          await fsp.rename(prepared, live);
        }
        await loadAll();
        await finishMutation("insights.snapshot.rolled-back", actor, {
          snapshotId: id,
          restoredRevision: snapshot.storeRevision
        });
        await atomicWrite(`${transactionName}/journal.json`, `${JSON.stringify({
          schemaVersion: INSIGHTS_SCHEMA_VERSION,
          status: "committed",
          snapshotId: id,
          committedAt: nowIso(clock)
        }, null, 2)}\n`);
        const result = { ok: true, snapshotId: id, restoredRevision: snapshot.storeRevision, currentRevision: cache.manifest.revision };
        await fsp.rm(transactionRoot, { recursive: true, force: true });
        return result;
      } catch (error) {
        if (swapStarted) {
          await recoverRestoreTransactions();
          await loadAll();
        } else {
          await fsp.rm(transactionRoot, { recursive: true, force: true }).catch(() => undefined);
        }
        throw error;
      }
    }));
  }

  async function diagnostics() {
    await ensureReady();
    return {
      ...summary(),
      providerId: "stage229-deterministic-signal-fixture",
      externalRequests: 0,
      credentialReads: 0,
      legacyRuntimeReads: 0,
      legacyRuntimeCopies: 0,
      productionMutations: 0,
      dataDirectoryFingerprint: stableHash(initialCanonical, 24),
      repositoryFileReads: metrics.repositoryFileReads,
      repositoryFileWrites: metrics.repositoryFileWrites,
      repositoryFileCopies: metrics.repositoryFileCopies
    };
  }

  return Object.freeze({
    initialize,
    appendSignals,
    listSignals,
    appendEvidenceSnapshot,
    getEvidenceSnapshot,
    listEvidenceSnapshots,
    createLocationCardRequest,
    transitionLocationCard,
    getLocationCard,
    listLocationCards,
    createMonthlyReport,
    transitionMonthlyReport,
    getMonthlyReport,
    listMonthlyReports,
    listAudit,
    createSnapshot,
    listSnapshots,
    rollbackSnapshot,
    diagnostics
  });
}

module.exports = {
  INSIGHTS_CHUNK_LAYERS,
  INSIGHTS_DIRECTORY,
  INSIGHTS_LOCK_FILE,
  INSIGHTS_STATE_FILES,
  assertManifest,
  createInsightsRepository,
  emptyCards,
  emptyIndexes,
  emptyManifest,
  emptyReports
};
