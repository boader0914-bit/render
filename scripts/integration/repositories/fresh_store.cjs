"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const {
  FRESH_DATA_IDENTITY_RULE,
  FRESH_DATA_LAYERS,
  FRESH_DATA_SCHEMA_VERSION,
  FRESH_DATA_STORE_KIND,
  FRESH_RUN_STATUSES,
  assertExampleInvalidUrl,
  assertSyntheticPayload,
  businessSafeProjection,
  cleanId,
  cleanText,
  clone,
  deriveCompanyQuality,
  deterministicCompanyId,
  duplicateCandidateKey,
  freshError,
  normalizeCompanyIdentity,
  normalizeObservation,
  normalizeRawEvidence,
  normalizeVerifiedProfile,
  stableHash
} = require("../contracts/fresh_data.cjs");

const STATE_FILES = Object.freeze({
  manifest: "manifest.json",
  identity: "identity/state.json",
  operations: "operations/runs.json",
  verified: "verified/profiles.json",
  derived: "derived/profiles.json",
  businessSafe: "business-safe/profiles.json",
  indexes: "indexes/append-keys.json"
});
const CHUNK_LAYERS = Object.freeze(["raw", "observation", "audit"]);
const LOCK_FILE = ".fresh-store.lock";
const SNAPSHOT_MANIFEST = "snapshot.json";
const LOCK_TIMEOUT_MS = 10_000;
// Snapshotting a mature append store can legitimately exceed one minute. A
// conservative stale window avoids stealing a live writer's lock.
const LOCK_STALE_MS = 15 * 60_000;

function nowIso(clock) {
  return new Date(Number(clock())).toISOString();
}

function normalizeFsPath(value) {
  const resolved = path.resolve(String(value || ""));
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isInsideOrEqual(parent, child) {
  const relative = path.relative(normalizeFsPath(parent), normalizeFsPath(child));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function pathsOverlap(left, right) {
  return isInsideOrEqual(left, right) || isInsideOrEqual(right, left);
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
  let canonical = cursor;
  if (fs.existsSync(cursor)) canonical = fs.realpathSync.native(cursor);
  return path.resolve(canonical, ...tail);
}

function projectLegacyBoundaries(options = {}) {
  const env = options.env || process.env;
  const projectRoot = path.resolve(options.projectRoot || path.resolve(__dirname, "../../.."));
  const explicit = Array.isArray(options.legacyPaths) ? options.legacyPaths : [];
  return [
    env.DATA_DIR,
    env.CONFIG_DIR,
    env.OUTPUTS_DIR,
    ...explicit,
    path.join(projectRoot, "data"),
    path.join(projectRoot, "db"),
    path.join(projectRoot, "outputs"),
    path.join(projectRoot, "config"),
    path.join(projectRoot, "customer_db"),
    path.join(projectRoot, "web", "data"),
    path.join(projectRoot, "web", "db"),
    path.join(projectRoot, "web", "outputs")
  ].map((value) => String(value || "").trim()).filter(Boolean);
}

function assertFreshAuthStoreBoundary(options = {}) {
  const env = options.env || process.env;
  const configured = String(options.authStorePath || env.V2_INTEGRATION_AUTH_STORE_PATH || "").trim();
  if (!configured) {
    throw freshError(
      "V2_INTEGRATION_AUTH_STORE_PATH is required when the Stage 228 fresh runtime is enabled",
      "FRESH_AUTH_STORE_PATH_REQUIRED",
      500
    );
  }
  if (!path.isAbsolute(configured)) {
    throw freshError(
      "V2_INTEGRATION_AUTH_STORE_PATH must be an absolute path for the Stage 228 fresh runtime",
      "FRESH_AUTH_STORE_PATH_ABSOLUTE_REQUIRED",
      500
    );
  }

  const projectRoot = path.resolve(options.projectRoot || path.resolve(__dirname, "../../.."));
  const explicitLegacyPaths = Array.isArray(options.legacyPaths) ? options.legacyPaths : [];
  const legacyDataDir = path.resolve(String(
    options.legacyDataDir
      || env.DATA_DIR
      || explicitLegacyPaths[0]
      || projectRoot
  ));
  const authStorePath = path.resolve(configured);
  const filesystemRoot = path.parse(authStorePath).root;
  if (authStorePath === filesystemRoot) {
    throw freshError(
      "V2_INTEGRATION_AUTH_STORE_PATH cannot be a filesystem root",
      "FRESH_AUTH_STORE_PATH_UNSAFE",
      500
    );
  }

  const allowedNamespace = path.join(legacyDataDir, "fresh-integration");
  if (normalizeFsPath(authStorePath) === normalizeFsPath(allowedNamespace)) {
    throw freshError(
      "V2_INTEGRATION_AUTH_STORE_PATH must name a file below DATA_DIR/fresh-integration",
      "FRESH_AUTH_STORE_PATH_UNSAFE",
      500
    );
  }

  const dataCanonical = canonicalizeCandidate(legacyDataDir);
  const namespaceCanonical = canonicalizeCandidate(allowedNamespace);
  const authCanonical = canonicalizeCandidate(authStorePath);
  const lexicalInsideData = isInsideOrEqual(legacyDataDir, authStorePath);
  const canonicalInsideData = isInsideOrEqual(dataCanonical, authCanonical);
  const lexicalInsideNamespace = isInsideOrEqual(allowedNamespace, authStorePath);
  const canonicalInsideNamespace = isInsideOrEqual(namespaceCanonical, authCanonical);
  const namespaceStaysInsideData = isInsideOrEqual(dataCanonical, namespaceCanonical);

  if (
    isInsideOrEqual(authStorePath, legacyDataDir)
    || isInsideOrEqual(authCanonical, dataCanonical)
  ) {
    throw freshError(
      "V2_INTEGRATION_AUTH_STORE_PATH must not contain or alias the legacy DATA_DIR boundary",
      "FRESH_AUTH_STORE_PATH_OVERLAP",
      500
    );
  }

  if (
    (lexicalInsideData || canonicalInsideData)
    && !(lexicalInsideNamespace && canonicalInsideNamespace && namespaceStaysInsideData)
  ) {
    throw freshError(
      "V2_INTEGRATION_AUTH_STORE_PATH inside DATA_DIR is allowed only below DATA_DIR/fresh-integration without a symlink escape",
      "FRESH_AUTH_STORE_NAMESPACE_REQUIRED",
      500
    );
  }

  const nestedLegacyNames = [
    "config",
    "outputs",
    "customer_db",
    "history",
    "company_master",
    "tourism_data"
  ];
  const forbiddenBoundaries = [
    env.CONFIG_DIR,
    env.OUTPUTS_DIR,
    ...explicitLegacyPaths,
    ...nestedLegacyNames.map((name) => path.join(legacyDataDir, name)),
    ...projectLegacyBoundaries({ env, projectRoot })
  ]
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    // DATA_DIR itself has the one explicit namespace exception above. All of
    // its sensitive child boundaries remain forbidden.
    .filter((value) => normalizeFsPath(value) !== normalizeFsPath(legacyDataDir));

  for (const boundary of forbiddenBoundaries) {
    const boundaryResolved = path.resolve(boundary);
    const boundaryCanonical = canonicalizeCandidate(boundaryResolved);
    if (
      pathsOverlap(authStorePath, boundaryResolved)
      || pathsOverlap(authCanonical, boundaryCanonical)
    ) {
      throw freshError(
        `V2_INTEGRATION_AUTH_STORE_PATH overlaps a forbidden legacy/runtime boundary: ${path.basename(boundaryResolved) || "root"}`,
        "FRESH_AUTH_STORE_PATH_OVERLAP",
        500
      );
    }
  }

  return Object.freeze({
    configured: authStorePath,
    canonical: authCanonical,
    legacyDataDir,
    allowedNamespace,
    boundaryFingerprints: [...new Set(forbiddenBoundaries.map((value) => (
      stableHash(canonicalizeCandidate(value), 16, "sha256")
    )))]
  });
}

function assertPathBoundaries(dataDir, options = {}) {
  const configured = path.resolve(dataDir);
  const canonical = canonicalizeCandidate(configured);
  const boundaries = projectLegacyBoundaries(options);
  for (const boundary of boundaries) {
    const boundaryResolved = path.resolve(boundary);
    const boundaryCanonical = canonicalizeCandidate(boundaryResolved);
    if (pathsOverlap(configured, boundaryResolved) || pathsOverlap(canonical, boundaryCanonical)) {
      throw freshError(
        `V2_INTEGRATION_DATA_DIR overlaps a forbidden legacy/runtime boundary: ${path.basename(boundaryResolved) || "root"}`,
        "FRESH_DATA_PATH_OVERLAP",
        500
      );
    }
  }
  return {
    configured,
    canonical,
    boundaryFingerprints: boundaries.map((value) => stableHash(canonicalizeCandidate(value), 16, "sha256"))
  };
}

function resolveFreshIntegrationDataDir(options = {}) {
  const env = options.env || process.env;
  const configured = String(options.dataDir || env.V2_INTEGRATION_DATA_DIR || "").trim();
  if (!configured) {
    throw freshError(
      "V2_INTEGRATION_DATA_DIR is required when the Stage 228 integration data store is enabled",
      "FRESH_DATA_DIR_REQUIRED",
      500
    );
  }
  const resolved = path.resolve(configured);
  const root = path.parse(resolved).root;
  if (resolved === root) {
    throw freshError("V2_INTEGRATION_DATA_DIR cannot be a filesystem root", "FRESH_DATA_PATH_UNSAFE", 500);
  }
  return assertPathBoundaries(resolved, options);
}

function emptyManifest(clock = Date.now, idFactory = crypto.randomUUID) {
  const now = nowIso(clock);
  return {
    storeKind: FRESH_DATA_STORE_KIND,
    schemaVersion: FRESH_DATA_SCHEMA_VERSION,
    storeId: `fresh_${cleanText(idFactory(), 80).replace(/[^A-Za-z0-9_-]/g, "")}`,
    createdAt: now,
    updatedAt: now,
    revision: 0,
    layerSchemaVersions: Object.fromEntries(FRESH_DATA_LAYERS.map((layer) => [layer, FRESH_DATA_SCHEMA_VERSION])),
    appendSequences: { raw: 0, observation: 0, audit: 0 },
    dataBoundary: "fresh-integration-only",
    providerCalls: 0,
    legacyRuntimeReads: 0,
    legacyRuntimeCopies: 0
  };
}

function emptyIdentityState() {
  return {
    schemaVersion: FRESH_DATA_SCHEMA_VERSION,
    identityRule: FRESH_DATA_IDENTITY_RULE,
    targets: [],
    companies: {},
    sourceIndex: {},
    sourceIdentities: [],
    discoveries: [],
    duplicateCandidates: [],
    identityLinks: []
  };
}

function emptyOperationsState() {
  return { schemaVersion: FRESH_DATA_SCHEMA_VERSION, runs: [] };
}

function emptyVerifiedState() {
  return { schemaVersion: FRESH_DATA_SCHEMA_VERSION, profiles: {}, reviews: [] };
}

function emptyProjectionState(projection) {
  return { schemaVersion: FRESH_DATA_SCHEMA_VERSION, projection, profiles: {} };
}

function emptyIndexesState() {
  return { schemaVersion: FRESH_DATA_SCHEMA_VERSION, rawEvidenceIds: [], observationIds: [] };
}

function assertSchemaVersion(value, label) {
  if (!value || value.schemaVersion !== FRESH_DATA_SCHEMA_VERSION) {
    throw freshError(`Unsupported ${label} schema version`, "FRESH_SCHEMA_UNSUPPORTED", 500);
  }
  return value;
}

function assertManifest(value) {
  assertSchemaVersion(value, "manifest");
  if (value.storeKind !== FRESH_DATA_STORE_KIND) {
    throw freshError("Configured directory is not a Stage 228 fresh integration store", "FRESH_STORE_KIND_INVALID", 500);
  }
  for (const layer of FRESH_DATA_LAYERS) {
    if (value.layerSchemaVersions?.[layer] !== FRESH_DATA_SCHEMA_VERSION) {
      throw freshError(`Unsupported ${layer} layer schema version`, "FRESH_SCHEMA_UNSUPPORTED", 500);
    }
  }
  if (!value.appendSequences || !["raw", "observation", "audit"].every((key) => Number.isInteger(value.appendSequences[key]))) {
    throw freshError("Fresh store append sequences are invalid", "FRESH_STORE_CORRUPT", 500);
  }
  return value;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function requestSignature(value) {
  return stableHash(canonicalJson(value), 64, "sha256");
}

function normalizeActor(actor) {
  if (!actor || typeof actor !== "object") {
    return { id: cleanText(actor || "system", 160), type: "system", role: "" };
  }
  return {
    id: cleanText(actor.actorAccountId || actor.accountId || actor.actorId || actor.id || actor.workerId || actor.role || "system", 160),
    type: cleanText(actor.type || actor.actorType || (actor.workerId ? "worker" : "account"), 48),
    role: cleanText(actor.role || actor.actorRole, 48)
  };
}

function actorLabel(actor) {
  return normalizeActor(actor).id;
}

function createFreshIntegrationRepository(options = {}) {
  const env = options.env || process.env;
  const clock = options.clock || Date.now;
  const idFactory = options.idFactory || crypto.randomUUID;
  const projectRoot = path.resolve(options.projectRoot || path.resolve(__dirname, "../../.."));
  const pathOptions = { env, projectRoot, legacyPaths: options.legacyPaths };
  const boundary = resolveFreshIntegrationDataDir({ ...pathOptions, dataDir: options.dataDir });
  const dataDir = boundary.configured;
  const initialCanonical = boundary.canonical;
  const metrics = {
    repositoryFileReads: 0,
    repositoryFileWrites: 0,
    repositoryFileCopies: 0,
    legacyRuntimeReads: 0,
    legacyRuntimeCopies: 0,
    providerCalls: 0
  };
  let initialized = false;
  let initializePromise = null;
  let queue = Promise.resolve();
  let cache = null;

  function assertRepositoryTargetSafe(value) {
    const target = path.resolve(value);
    if (!isInsideOrEqual(dataDir, target)) {
      throw freshError("Repository path escaped V2_INTEGRATION_DATA_DIR", "FRESH_REPOSITORY_PATH_ESCAPE", 500);
    }
    if (!fs.existsSync(dataDir)) return target;
    const rootCanonical = fs.realpathSync.native(dataDir);
    if (normalizeFsPath(rootCanonical) !== normalizeFsPath(initialCanonical)) {
      throw freshError("V2_INTEGRATION_DATA_DIR realpath changed after bootstrap", "FRESH_DATA_REALPATH_CHANGED", 500);
    }
    const relative = path.relative(dataDir, target);
    let cursor = dataDir;
    for (const segment of relative.split(path.sep).filter(Boolean)) {
      cursor = path.join(cursor, segment);
      let stat;
      try {
        stat = fs.lstatSync(cursor);
      } catch (error) {
        if (error.code === "ENOENT") break;
        throw error;
      }
      if (stat.isSymbolicLink()) {
        throw freshError(
          "Fresh store managed paths cannot contain a symlink or junction",
          "FRESH_REPOSITORY_SYMLINK_FORBIDDEN",
          500
        );
      }
      const canonical = fs.realpathSync.native(cursor);
      if (!isInsideOrEqual(initialCanonical, canonical)) {
        throw freshError("Repository target realpath escaped the fresh store", "FRESH_REPOSITORY_PATH_ESCAPE", 500);
      }
    }
    return target;
  }

  function absolute(relative) {
    const target = path.resolve(dataDir, relative);
    if (!isInsideOrEqual(dataDir, target)) {
      throw freshError("Repository path escaped V2_INTEGRATION_DATA_DIR", "FRESH_REPOSITORY_PATH_ESCAPE", 500);
    }
    return assertRepositoryTargetSafe(target);
  }

  function assertBoundaryStable() {
    const checked = assertPathBoundaries(dataDir, pathOptions);
    if (normalizeFsPath(checked.canonical) !== normalizeFsPath(initialCanonical)) {
      throw freshError("V2_INTEGRATION_DATA_DIR realpath changed after bootstrap", "FRESH_DATA_REALPATH_CHANGED", 500);
    }
  }

  async function atomicWrite(relative, content, mode = 0o600) {
    assertBoundaryStable();
    const target = absolute(relative);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    assertRepositoryTargetSafe(path.dirname(target));
    const temp = `${target}.${process.pid}.${Date.now()}.${cleanText(idFactory(), 40).replace(/[^A-Za-z0-9]/g, "")}.tmp`;
    assertRepositoryTargetSafe(temp);
    let handle;
    try {
      handle = await fsp.open(temp, "wx", mode);
      await handle.writeFile(content, "utf8");
      await handle.sync();
      await handle.close();
      handle = null;
      assertRepositoryTargetSafe(temp);
      assertRepositoryTargetSafe(target);
      await fsp.rename(temp, target);
      await fsp.chmod(target, mode).catch(() => undefined);
      metrics.repositoryFileWrites += 1;
    } catch (error) {
      await handle?.close().catch(() => undefined);
      try {
        await fsp.unlink(assertRepositoryTargetSafe(temp));
      } catch {}
      throw error;
    }
  }

  async function writeJson(relative, value) {
    await atomicWrite(relative, `${JSON.stringify(value, null, 2)}\n`);
  }

  async function readJson(relative) {
    assertBoundaryStable();
    const text = await fsp.readFile(absolute(relative), "utf8");
    metrics.repositoryFileReads += 1;
    return JSON.parse(text.replace(/^\uFEFF/, ""));
  }

  async function withStoreLock(work) {
    assertBoundaryStable();
    await fsp.mkdir(dataDir, { recursive: true });
    assertRepositoryTargetSafe(dataDir);
    const currentCanonical = fs.realpathSync.native(dataDir);
    if (normalizeFsPath(currentCanonical) !== normalizeFsPath(initialCanonical)) {
      throw freshError("V2_INTEGRATION_DATA_DIR realpath changed before lock acquisition", "FRESH_DATA_REALPATH_CHANGED", 500);
    }
    const lockPath = absolute(LOCK_FILE);
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    let handle;
    while (!handle) {
      try {
        assertRepositoryTargetSafe(lockPath);
        handle = await fsp.open(lockPath, "wx", 0o600);
        await handle.writeFile(JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() }), "utf8");
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        const stat = await fsp.stat(assertRepositoryTargetSafe(lockPath)).catch(() => null);
        if (stat && Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
          await fsp.unlink(assertRepositoryTargetSafe(lockPath)).catch(() => undefined);
          continue;
        }
        if (Date.now() >= deadline) {
          throw freshError("Timed out waiting for fresh store lock", "FRESH_STORE_LOCK_TIMEOUT", 503);
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    try {
      return await work();
    } finally {
      await handle.close().catch(() => undefined);
      await fsp.unlink(assertRepositoryTargetSafe(lockPath)).catch(() => undefined);
    }
  }

  async function listChunkRelatives(layer) {
    const directory = absolute(`${layer}/chunks`);
    const names = await fsp.readdir(directory).catch((error) => error.code === "ENOENT" ? [] : Promise.reject(error));
    return names.filter((name) => /^\d{12}-.+\.jsonl$/.test(name)).sort().map((name) => `${layer}/chunks/${name}`);
  }

  async function readChunks(layer) {
    const rows = [];
    for (const relative of await listChunkRelatives(layer)) {
      const text = await fsp.readFile(absolute(relative), "utf8");
      metrics.repositoryFileReads += 1;
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue;
        rows.push(JSON.parse(line));
      }
    }
    return rows;
  }

  async function loadAll() {
    const manifest = assertManifest(await readJson(STATE_FILES.manifest));
    const identity = assertSchemaVersion(await readJson(STATE_FILES.identity), "identity");
    const operations = assertSchemaVersion(await readJson(STATE_FILES.operations), "operations");
    const verified = assertSchemaVersion(await readJson(STATE_FILES.verified), "verified");
    const derived = assertSchemaVersion(await readJson(STATE_FILES.derived), "derived");
    const businessSafe = assertSchemaVersion(await readJson(STATE_FILES.businessSafe), "business-safe");
    const indexes = assertSchemaVersion(await readJson(STATE_FILES.indexes), "indexes");
    const raw = await readChunks("raw");
    const observations = await readChunks("observation");
    const audit = await readChunks("audit");
    cache = {
      manifest,
      identity,
      operations,
      verified,
      derived,
      businessSafe,
      indexes,
      raw,
      observations,
      audit,
      rawIds: new Set(indexes.rawEvidenceIds || []),
      observationIds: new Set(indexes.observationIds || [])
    };
    return cache;
  }

  async function writeChunk(layer, rows) {
    if (!CHUNK_LAYERS.includes(layer) || !rows.length) return "";
    const next = Number(cache.manifest.appendSequences[layer] || 0) + 1;
    const suffix = cleanText(idFactory(), 80).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32) || String(Date.now());
    const relative = `${layer}/chunks/${String(next).padStart(12, "0")}-${suffix}.jsonl`;
    await atomicWrite(relative, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
    cache.manifest.appendSequences[layer] = next;
    cache[layer === "observation" ? "observations" : layer].push(...clone(rows));
    return relative;
  }

  async function appendAuditLocked(event, actor, details = {}) {
    const normalizedActor = normalizeActor(actor);
    const row = {
      schemaVersion: FRESH_DATA_SCHEMA_VERSION,
      auditId: `audit_${stableHash(`${event}|${cache.manifest.storeId}|${cache.manifest.revision + 1}|${idFactory()}`, 24, "sha256")}`,
      event: cleanText(event, 120),
      actor: normalizedActor.id,
      actorType: normalizedActor.type,
      actorRole: normalizedActor.role,
      at: nowIso(clock),
      storeId: cache.manifest.storeId,
      revision: cache.manifest.revision + 1,
      details: clone(details)
    };
    assertSyntheticPayload(row.details, "audit.details");
    await writeChunk("audit", [row]);
    return row;
  }

  async function finishMutation(event, actor, details) {
    const audit = await appendAuditLocked(event, actor, details);
    cache.manifest.revision += 1;
    cache.manifest.updatedAt = nowIso(clock);
    cache.manifest.providerCalls = 0;
    cache.manifest.legacyRuntimeReads = 0;
    cache.manifest.legacyRuntimeCopies = 0;
    await writeJson(STATE_FILES.manifest, cache.manifest);
    return audit;
  }

  function serialize(work) {
    const pending = queue.then(work, work);
    queue = pending.then(() => undefined, () => undefined);
    return pending;
  }

  async function mutate(event, actor, work) {
    await initialize();
    return serialize(() => withStoreLock(async () => {
      await loadAll();
      const outcome = await work(cache);
      if (!outcome || outcome.changed === false) return clone(outcome?.value);
      await finishMutation(event, actor, outcome.details || {});
      return clone(outcome.value);
    }));
  }

  async function initializeInsideLock() {
    await fsp.mkdir(dataDir, { recursive: true });
    assertRepositoryTargetSafe(dataDir);
    const canonicalAfterCreate = fs.realpathSync.native(dataDir);
    if (normalizeFsPath(canonicalAfterCreate) !== normalizeFsPath(initialCanonical)) {
      throw freshError("V2_INTEGRATION_DATA_DIR resolved through an unexpected symlink", "FRESH_DATA_REALPATH_CHANGED", 500);
    }
    for (const directory of [
      "raw/chunks",
      "observation/chunks",
      "verified",
      "derived",
      "business-safe",
      "identity",
      "operations",
      "indexes",
      "audit/chunks",
      "snapshots"
    ]) {
      const managedDirectory = absolute(directory);
      await fsp.mkdir(managedDirectory, { recursive: true });
      assertRepositoryTargetSafe(managedDirectory);
    }
    const manifestPath = absolute(STATE_FILES.manifest);
    if (!fs.existsSync(manifestPath)) {
      cache = {
        manifest: emptyManifest(clock, idFactory),
        identity: emptyIdentityState(),
        operations: emptyOperationsState(),
        verified: emptyVerifiedState(),
        derived: emptyProjectionState("derived"),
        businessSafe: emptyProjectionState("business-safe"),
        indexes: emptyIndexesState(),
        raw: [],
        observations: [],
        audit: [],
        rawIds: new Set(),
        observationIds: new Set()
      };
      await writeJson(STATE_FILES.identity, cache.identity);
      await writeJson(STATE_FILES.operations, cache.operations);
      await writeJson(STATE_FILES.verified, cache.verified);
      await writeJson(STATE_FILES.derived, cache.derived);
      await writeJson(STATE_FILES.businessSafe, cache.businessSafe);
      await writeJson(STATE_FILES.indexes, cache.indexes);
      await appendAuditLocked("store.bootstrap", "system", {
        dataBoundary: "fresh-integration-only",
        layers: FRESH_DATA_LAYERS,
        legacyRuntimeReads: 0,
        legacyRuntimeCopies: 0,
        providerCalls: 0
      });
      cache.manifest.revision = 1;
      cache.manifest.updatedAt = nowIso(clock);
      await writeJson(STATE_FILES.manifest, cache.manifest);
    } else {
      await loadAll();
      const rawEvidenceIds = [...new Set(cache.raw.map((row) => row.evidenceId).filter(Boolean))];
      const observationIds = [...new Set(cache.observations.map((row) => row.observationId).filter(Boolean))];
      const indexChanged = requestSignature(rawEvidenceIds) !== requestSignature(cache.indexes.rawEvidenceIds || [])
        || requestSignature(observationIds) !== requestSignature(cache.indexes.observationIds || []);
      if (indexChanged) {
        cache.indexes.rawEvidenceIds = rawEvidenceIds;
        cache.indexes.observationIds = observationIds;
        cache.rawIds = new Set(rawEvidenceIds);
        cache.observationIds = new Set(observationIds);
        await writeJson(STATE_FILES.indexes, cache.indexes);
        await finishMutation("store.index.reconciled", "system", {
          rawEvidenceCount: rawEvidenceIds.length,
          observationCount: observationIds.length
        });
      }
    }
    initialized = true;
    return bootstrapSummary();
  }

  function bootstrapSummary() {
    if (!cache) throw freshError("Fresh store is not initialized", "FRESH_STORE_NOT_INITIALIZED", 500);
    return {
      storeKind: cache.manifest.storeKind,
      schemaVersion: cache.manifest.schemaVersion,
      storeId: cache.manifest.storeId,
      revision: cache.manifest.revision,
      dataBoundary: cache.manifest.dataBoundary,
      layers: [...FRESH_DATA_LAYERS],
      counts: {
        targets: cache.identity.targets.length,
        companies: Object.keys(cache.identity.companies).length,
        rawEvidence: cache.raw.length,
        observations: cache.observations.length,
        verifiedProfiles: Object.keys(cache.verified.profiles).length,
        runs: cache.operations.runs.length
      },
      legacyRuntimeReads: 0,
      legacyRuntimeCopies: 0,
      providerCalls: 0
    };
  }

  async function initialize() {
    if (initialized) {
      assertBoundaryStable();
      return clone(bootstrapSummary());
    }
    if (!initializePromise) {
      initializePromise = withStoreLock(initializeInsideLock).catch((error) => {
        initializePromise = null;
        throw error;
      });
    }
    return clone(await initializePromise);
  }

  async function seedTarget(payload = {}, actor = "system") {
    if (payload.synthetic !== true) throw freshError("Stage 228 targets must be synthetic", "FRESH_SYNTHETIC_REQUIRED");
    const name = cleanText(payload.name || payload.companyName || payload.targetName, 180);
    const region = cleanText(payload.region || payload.regionLabel || payload.regionCode, 160);
    if (!name || !region) throw freshError("Target name and region are required", "FRESH_TARGET_INVALID");
    const sourceUrl = assertExampleInvalidUrl(payload.sourceUrl || "https://seed.example.invalid/stage228");
    const targetId = cleanText(payload.targetId, 160)
      ? cleanId(payload.targetId, "targetId")
      : `target_${stableHash(`${name}|${region}|${sourceUrl}`, 20, "sha256")}`;
    const seedSource = cleanText(payload.seedSource || payload.source || "synthetic-seed", 80);
    const signature = requestSignature({ name, region, sourceUrl, seedSource });
    return mutate("target.seeded", actor, async (state) => {
      const existing = state.identity.targets.find((row) => row.targetId === targetId);
      if (existing) {
        if (existing.requestSignature !== signature) {
          throw freshError("Target idempotency conflict", "FRESH_IDEMPOTENCY_CONFLICT", 409);
        }
        return { changed: false, value: { target: existing, idempotent: true } };
      }
      const now = nowIso(clock);
      const target = {
        schemaVersion: FRESH_DATA_SCHEMA_VERSION,
        targetId,
        name,
        region,
        seedSource,
        sourceUrl,
        synthetic: true,
        status: "pending-discovery",
        companyId: "",
        requestSignature: signature,
        createdAt: now,
        updatedAt: now
      };
      state.identity.targets.push(target);
      await writeJson(STATE_FILES.identity, state.identity);
      return { value: { target, idempotent: false }, details: { targetId, name, region } };
    });
  }

  function strongIdSetsDistinct(companies, field) {
    if (!companies.length || !companies.every((company) => (company[field] || []).length)) return false;
    const seen = new Set();
    for (const company of companies) {
      for (const value of company[field]) {
        if (seen.has(value)) return false;
        seen.add(value);
      }
    }
    return true;
  }

  function candidateIsSuppressed(companies) {
    return strongIdSetsDistinct(companies, "placeIds") || strongIdSetsDistinct(companies, "bookingBusinessIds");
  }

  function companyFromIdentity(companyId, identity, payload, at) {
    return {
      schemaVersion: FRESH_DATA_SCHEMA_VERSION,
      companyId,
      identityRule: FRESH_DATA_IDENTITY_RULE,
      primaryName: identity.name,
      nameKey: identity.nameKey,
      looseNameKey: identity.looseNameKey,
      region: identity.region,
      regionKey: identity.regionKey,
      address: identity.address,
      addressKey: identity.addressKey,
      aliases: identity.name ? [identity.name] : [],
      regions: identity.region ? [identity.region] : [],
      addresses: identity.address ? [identity.address] : [],
      placeIds: identity.placeId ? [identity.placeId] : [],
      bookingBusinessIds: identity.bookingBusinessId ? [identity.bookingBusinessId] : [],
      sourceKeys: [...identity.sourceKeys],
      identityConfidence: identity.placeId ? "certain" : identity.bookingBusinessId ? "high" : identity.addressKey ? "medium" : "review",
      synthetic: true,
      source: cleanText(payload.source || "synthetic-discovery", 80),
      firstSeenAt: at,
      lastSeenAt: at,
      firstRunId: cleanText(payload.runId, 160),
      lastRunId: cleanText(payload.runId, 160)
    };
  }

  function mergeUnique(target, field, values, maximum = 80) {
    target[field] = [...new Set([...(target[field] || []), ...values].filter(Boolean))].slice(0, maximum);
  }

  async function discoverCompany(payload = {}, actor = "system") {
    if (payload.synthetic !== true) throw freshError("Stage 228 discovery must be synthetic", "FRESH_SYNTHETIC_REQUIRED");
    const identity = normalizeCompanyIdentity(payload);
    const source = cleanText(payload.source || "synthetic-discovery", 80);
    const sourceUrl = assertExampleInvalidUrl(payload.sourceUrl);
    const observedAt = new Date(Date.parse(cleanText(payload.observedAt, 40)) || Number(clock())).toISOString();
    const targetId = cleanText(payload.targetId, 160) ? cleanId(payload.targetId, "targetId") : "";
    const runId = cleanText(payload.runId, 160) ? cleanId(payload.runId, "runId") : "";
    const discoveryId = cleanText(payload.discoveryId, 160)
      ? cleanId(payload.discoveryId, "discoveryId")
      : `discovery_${stableHash(`${targetId}|${runId}|${identity.sourceKeys.join("|")}|${observedAt}`, 24, "sha256")}`;
    const signature = requestSignature({ identity, source, sourceUrl, targetId, runId, observedAt });
    return mutate("company.discovered", actor, async (state) => {
      const replay = state.identity.discoveries.find((row) => row.discoveryId === discoveryId);
      if (replay) {
        if (replay.requestSignature !== signature) throw freshError("Discovery idempotency conflict", "FRESH_IDEMPOTENCY_CONFLICT", 409);
        const replayCompany = replay.companyId ? state.identity.companies[replay.companyId] || null : null;
        return { changed: false, value: { discovery: replay, company: replayCompany, idempotent: true } };
      }
      if (targetId && !state.identity.targets.some((row) => row.targetId === targetId)) {
        throw freshError("Discovery target was not seeded", "FRESH_TARGET_NOT_FOUND", 404);
      }
      if (runId && !state.operations.runs.some((row) => row.runId === runId)) {
        throw freshError("Discovery run does not exist", "FRESH_RUN_NOT_FOUND", 404);
      }
      const matchedIds = [...new Set(identity.sourceKeys.map((key) => state.identity.sourceIndex[key]).filter(Boolean))];
      if (matchedIds.length > 1) {
        const candidateId = `duplicate_${stableHash(matchedIds.slice().sort().join("|"), 24, "sha256")}`;
        const candidate = {
          candidateId,
          candidateKey: duplicateCandidateKey(identity),
          reason: "multiple-source-keys-resolve-to-different-companies",
          companyIds: matchedIds,
          status: "pending-review",
          createdAt: observedAt
        };
        if (!state.identity.duplicateCandidates.some((row) => row.candidateId === candidateId)) {
          state.identity.duplicateCandidates.push(candidate);
        }
        const discovery = { discoveryId, requestSignature: signature, targetId, runId, companyId: "", duplicateCandidateId: candidateId, observedAt, synthetic: true };
        state.identity.discoveries.push(discovery);
        await writeJson(STATE_FILES.identity, state.identity);
        return {
          value: { discovery, company: null, duplicateCandidate: candidate, idempotent: false },
          details: { discoveryId, duplicateCandidateId: candidateId, matchedCompanyIds: matchedIds }
        };
      }
      const proposedId = matchedIds[0] || deterministicCompanyId(identity);
      if (payload.companyId && cleanId(payload.companyId, "companyId") !== proposedId) {
        throw freshError("Issued companyId does not match the V2 identity rule", "FRESH_COMPANY_ID_COLLISION", 409);
      }
      let company = state.identity.companies[proposedId];
      if (company && !identity.sourceKeys.some((key) => (company.sourceKeys || []).includes(key))) {
        throw freshError(
          `V2 companyId collision detected for ${proposedId}`,
          "FRESH_COMPANY_ID_COLLISION",
          409
        );
      }
      if (!company) {
        company = companyFromIdentity(proposedId, identity, payload, observedAt);
        company.tenantCompanyIds = [];
        company.actorAccountIds = [];
        state.identity.companies[proposedId] = company;
      } else {
        mergeUnique(company, "aliases", [identity.name]);
        mergeUnique(company, "regions", [identity.region]);
        mergeUnique(company, "addresses", [identity.address]);
        mergeUnique(company, "placeIds", [identity.placeId]);
        mergeUnique(company, "bookingBusinessIds", [identity.bookingBusinessId]);
        mergeUnique(company, "sourceKeys", identity.sourceKeys);
        company.lastSeenAt = [company.lastSeenAt, observedAt].filter(Boolean).sort().at(-1);
        company.lastRunId = runId || company.lastRunId;
      }
      const relatedRun = runId ? state.operations.runs.find((row) => row.runId === runId) : null;
      const tenantCompanyId = cleanText(payload.tenantCompanyId || relatedRun?.input?.tenantCompanyId || relatedRun?.tenantCompanyId, 160);
      const actorAccountId = cleanText(payload.actorAccountId || relatedRun?.actorAccountId, 160);
      if (tenantCompanyId) mergeUnique(company, "tenantCompanyIds", [cleanId(tenantCompanyId, "tenantCompanyId")], 40);
      if (actorAccountId) mergeUnique(company, "actorAccountIds", [cleanId(actorAccountId, "actorAccountId")], 80);
      for (const key of identity.sourceKeys) {
        const indexed = state.identity.sourceIndex[key];
        if (indexed && indexed !== proposedId) {
          throw freshError("Source identity collision detected", "FRESH_COMPANY_ID_COLLISION", 409);
        }
        state.identity.sourceIndex[key] = proposedId;
        if (!state.identity.sourceIdentities.some((row) => row.sourceKey === key && row.companyId === proposedId)) {
          state.identity.sourceIdentities.push({
            sourceKey: key,
            companyId: proposedId,
            source,
            firstObservedAt: observedAt,
            synthetic: true
          });
        }
      }
      const discovery = {
        discoveryId,
        requestSignature: signature,
        targetId,
        runId,
        companyId: proposedId,
        observedAt,
        source,
        sourceUrl,
        synthetic: true
      };
      state.identity.discoveries.push(discovery);
      const target = targetId ? state.identity.targets.find((row) => row.targetId === targetId) : null;
      if (target) {
        target.companyId = proposedId;
        target.status = "discovered";
        target.updatedAt = observedAt;
      }
      const candidateKey = duplicateCandidateKey(identity);
      if (candidateKey) {
        const sameBucket = Object.values(state.identity.companies).filter((row) => `${row.looseNameKey}:${row.regionKey}` === candidateKey);
        if (sameBucket.length > 1 && !candidateIsSuppressed(sameBucket)) {
          const ids = sameBucket.map((row) => row.companyId).sort();
          const candidateId = `duplicate_${stableHash(`${candidateKey}|${ids.join("|")}`, 24, "sha256")}`;
          if (!state.identity.duplicateCandidates.some((row) => row.candidateId === candidateId)) {
            state.identity.duplicateCandidates.push({
              candidateId,
              candidateKey,
              reason: "similar-company-name-and-region",
              companyIds: ids,
              status: "pending-review",
              createdAt: observedAt
            });
          }
        }
      }
      await writeJson(STATE_FILES.identity, state.identity);
      return {
        value: { discovery, company, idempotent: false },
        details: { discoveryId, companyId: proposedId, identityRule: FRESH_DATA_IDENTITY_RULE }
      };
    });
  }

  async function linkCompatibleIdentity(payload = {}, actor = "system") {
    const companyId = cleanId(payload.companyId, "companyId");
    const compatibleCompanyId = cleanId(payload.compatibleCompanyId, "compatibleCompanyId");
    if (!/^cmp_(?:place_)?[A-Za-z0-9._:-]+$/.test(compatibleCompanyId)) {
      throw freshError("Compatible companyId must use the V2 cmp_ namespace", "FRESH_COMPATIBLE_ID_INVALID");
    }
    const linkId = `identity_link_${stableHash(`${companyId}|${compatibleCompanyId}`, 24, "sha256")}`;
    return mutate("company.identity-linked", actor, async (state) => {
      if (!state.identity.companies[companyId]) throw freshError("Company not found", "FRESH_COMPANY_NOT_FOUND", 404);
      const other = state.identity.identityLinks.find((row) => row.compatibleCompanyId === compatibleCompanyId && row.companyId !== companyId);
      if (other) throw freshError("Compatible companyId is already linked", "FRESH_COMPANY_ID_COLLISION", 409);
      const replay = state.identity.identityLinks.find((row) => row.linkId === linkId);
      if (replay) return { changed: false, value: { identityLink: replay, idempotent: true } };
      const link = {
        schemaVersion: FRESH_DATA_SCHEMA_VERSION,
        linkId,
        companyId,
        compatibleCompanyId,
        linkKind: "identity-metadata-only",
        importsCompanyDetails: false,
        importsObservations: false,
        createdAt: nowIso(clock),
        actor: actorLabel(actor)
      };
      state.identity.identityLinks.push(link);
      await writeJson(STATE_FILES.identity, state.identity);
      return { value: { identityLink: link, idempotent: false }, details: { companyId, compatibleCompanyId, dataCopied: 0 } };
    });
  }

  function normalizeRunPayload(payload = {}) {
    if (payload.synthetic !== true) throw freshError("Stage 228 runs must use the synthetic provider", "FRESH_SYNTHETIC_REQUIRED");
    const clientRequestId = cleanId(payload.clientRequestId, "clientRequestId");
    const kind = cleanText(payload.kind || "fresh-company-vertical-slice", 80);
    const targetId = cleanText(payload.targetId, 160) ? cleanId(payload.targetId, "targetId") : "";
    const companyId = cleanText(payload.companyId, 160) ? cleanId(payload.companyId, "companyId") : "";
    const sourceUrl = assertExampleInvalidUrl(payload.sourceUrl || "https://collector.example.invalid/stage228");
    const input = clone(payload.input || payload.request || {});
    assertSyntheticPayload(input, "run.input");
    return {
      clientRequestId,
      kind,
      targetId,
      companyId,
      sourceUrl,
      provider: "synthetic-stage228",
      synthetic: true,
      requestedModes: [...new Set((Array.isArray(payload.requestedModes) ? payload.requestedModes : ["quick", "detail", "ota"])
        .map((mode) => cleanText(mode, 20).toLowerCase()))],
      input,
      actorAccountId: cleanText(payload.actorAccountId, 160),
      actorRole: cleanText(payload.actorRole, 48),
      collectionKind: cleanText(payload.collectionKind || "fresh-company-vertical-slice", 80),
      currentStage: cleanText(payload.currentStage || "queued", 120),
      checkpoint: clone(payload.checkpoint || {}),
      request: clone(payload.request || {})
    };
  }

  async function createRun(payload = {}, actor = "system") {
    const normalized = normalizeRunPayload(payload);
    assertSyntheticPayload(normalized.request, "run.request");
    const computedSignature = requestSignature(normalized);
    const signature = /^[a-f0-9]{64}$/i.test(cleanText(payload.requestSignature, 80))
      ? cleanText(payload.requestSignature, 80).toLowerCase()
      : computedSignature;
    const runId = cleanText(payload.runId, 160)
      ? cleanId(payload.runId, "runId")
      : `run_${stableHash(normalized.clientRequestId, 24, "sha256")}`;
    return mutate("run.created", actor, async (state) => {
      const replay = state.operations.runs.find((row) => row.runId === runId || (
        row.clientRequestId === normalized.clientRequestId
        && (row.actorAccountId || "") === (normalized.actorAccountId || "")
      ));
      if (replay) {
        if (replay.requestSignature !== signature) throw freshError("Run idempotency conflict", "FRESH_IDEMPOTENCY_CONFLICT", 409);
        return { changed: false, value: { run: replay, idempotent: true } };
      }
      if (normalized.targetId && !state.identity.targets.some((row) => row.targetId === normalized.targetId)) {
        throw freshError("Run target not found", "FRESH_TARGET_NOT_FOUND", 404);
      }
      if (normalized.companyId && !state.identity.companies[normalized.companyId]) {
        throw freshError("Run company not found", "FRESH_COMPANY_NOT_FOUND", 404);
      }
      const at = nowIso(clock);
      const run = {
        schemaVersion: FRESH_DATA_SCHEMA_VERSION,
        runId,
        ...normalized,
        requestSignature: signature,
        status: "queued",
        progress: 0,
        currentStage: normalized.currentStage || "queued",
        checkpoint: normalized.checkpoint,
        attempts: 0,
        nextAttemptAt: "",
        leaseId: "",
        leaseOwner: "",
        leaseExpiresAt: "",
        cancelRequestedAt: "",
        cancelledAt: "",
        completedAt: "",
        failedAt: "",
        failure: null,
        rawEvidenceCount: 0,
        observationCount: 0,
        createdAt: at,
        updatedAt: at
      };
      state.operations.runs.push(run);
      await writeJson(STATE_FILES.operations, state.operations);
      return { value: { run, idempotent: false }, details: { runId, clientRequestId: normalized.clientRequestId, provider: run.provider } };
    });
  }

  function findRun(state, runId) {
    const id = cleanId(runId, "runId");
    const run = state.operations.runs.find((row) => row.runId === id);
    if (!run) throw freshError("Run not found", "FRESH_RUN_NOT_FOUND", 404);
    return run;
  }

  function leaseActive(run, at = Number(clock())) {
    return run.leaseId && Number.isFinite(Date.parse(run.leaseExpiresAt)) && Date.parse(run.leaseExpiresAt) > at;
  }

  function assertLease(run, leaseId) {
    const requested = cleanId(leaseId, "leaseId");
    if (!run.leaseId || run.leaseId !== requested || !leaseActive(run)) {
      throw freshError("Run lease is missing, expired, or owned by another worker", "FRESH_RUN_LEASE_INVALID", 409);
    }
  }

  async function acquireRunLease(runId, payload = {}, actor = "worker") {
    const workerId = cleanId(payload.workerId, "workerId");
    const leaseSeconds = Math.max(5, Math.min(3600, Number(payload.leaseSeconds || 60)));
    return mutate("run.lease-acquired", actor, async (state) => {
      const run = findRun(state, runId);
      const due = !run.nextAttemptAt || Date.parse(run.nextAttemptAt) <= Number(clock());
      const eligible = ["queued", "retry-wait"].includes(run.status) && due;
      const recoverableExpired = run.status === "running" && !leaseActive(run);
      if (!eligible && !recoverableExpired) {
        throw freshError("Run is not eligible for a lease", "FRESH_RUN_NOT_LEASEABLE", 409);
      }
      run.leaseId = `lease_${cleanText(idFactory(), 80).replace(/[^A-Za-z0-9_-]/g, "")}`;
      run.leaseOwner = workerId;
      run.leaseExpiresAt = new Date(Number(clock()) + leaseSeconds * 1000).toISOString();
      run.status = "running";
      run.attempts = Number(run.attempts || 0) + 1;
      run.startedAt = run.startedAt || nowIso(clock);
      run.nextAttemptAt = "";
      run.updatedAt = nowIso(clock);
      await writeJson(STATE_FILES.operations, state.operations);
      return { value: { run, lease: { leaseId: run.leaseId, expiresAt: run.leaseExpiresAt }, recoveredExpiredLease: recoverableExpired }, details: { runId: run.runId, workerId, attempt: run.attempts, recoveredExpiredLease: recoverableExpired } };
    });
  }

  async function heartbeatRun(runId, payload = {}, actor = "worker") {
    const leaseSeconds = Math.max(5, Math.min(3600, Number(payload.leaseSeconds || 60)));
    return mutate("run.heartbeat", actor, async (state) => {
      const run = findRun(state, runId);
      assertLease(run, payload.leaseId);
      run.progress = Math.max(0, Math.min(100, Math.round(Number(payload.progress ?? run.progress))));
      run.currentStage = cleanText(payload.currentStage || run.currentStage, 120);
      if (payload.companyId) run.companyId = cleanId(payload.companyId, "companyId");
      if (payload.checkpoint !== undefined) {
        assertSyntheticPayload(payload.checkpoint, "run.checkpoint");
        run.checkpoint = clone(payload.checkpoint);
      }
      if (Number.isFinite(Number(payload.attempts))) run.attempts = Math.max(run.attempts, Number(payload.attempts));
      run.nextAttemptAt = cleanText(payload.nextAttemptAt, 40)
        ? new Date(Date.parse(payload.nextAttemptAt)).toISOString()
        : run.nextAttemptAt;
      run.leaseExpiresAt = new Date(Number(clock()) + leaseSeconds * 1000).toISOString();
      run.updatedAt = nowIso(clock);
      await writeJson(STATE_FILES.operations, state.operations);
      return { value: { run }, details: { runId: run.runId, progress: run.progress, currentStage: run.currentStage } };
    });
  }

  async function requestRunCancel(runId, payload = {}, actor = "system") {
    return mutate("run.cancel-requested", actor, async (state) => {
      const run = findRun(state, runId);
      if (["cancelled", "completed", "failed"].includes(run.status)) {
        return { changed: false, value: { run, idempotent: true } };
      }
      if (run.status === "cancel-requested") return { changed: false, value: { run, idempotent: true } };
      run.status = "cancel-requested";
      run.cancelRequestedAt = nowIso(clock);
      run.cancelReason = cleanText(payload.reason || "user-requested", 240);
      run.updatedAt = nowIso(clock);
      await writeJson(STATE_FILES.operations, state.operations);
      return { value: { run, idempotent: false }, details: { runId: run.runId, reason: run.cancelReason } };
    });
  }

  async function cancelRun(runId, payload = {}, actor = "worker") {
    return mutate("run.cancelled", actor, async (state) => {
      const run = findRun(state, runId);
      if (run.status === "cancelled") return { changed: false, value: { run, idempotent: true } };
      if (["completed", "failed"].includes(run.status)) throw freshError("Terminal run cannot be cancelled", "FRESH_RUN_TERMINAL", 409);
      if (payload.leaseId) assertLease(run, payload.leaseId);
      run.status = "cancelled";
      run.progress = Math.min(99, Number(run.progress || 0));
      run.cancelledAt = nowIso(clock);
      run.cancelReason = cleanText(payload.reason || run.cancelReason || "worker-cancelled", 240);
      run.leaseId = "";
      run.leaseOwner = "";
      run.leaseExpiresAt = "";
      run.updatedAt = nowIso(clock);
      await writeJson(STATE_FILES.operations, state.operations);
      return { value: { run, idempotent: false }, details: { runId: run.runId, reason: run.cancelReason } };
    });
  }

  async function resumeRun(runId, payload = {}, actor = "system") {
    return mutate("run.resumed", actor, async (state) => {
      const run = findRun(state, runId);
      const expiredRunning = run.status === "running" && !leaseActive(run);
      if (!["cancelled", "failed", "retry-wait"].includes(run.status) && !expiredRunning) {
        if (run.status === "queued") return { changed: false, value: { run, idempotent: true } };
        throw freshError("Run cannot be resumed from its current state", "FRESH_RUN_NOT_RESUMABLE", 409);
      }
      run.status = "queued";
      run.resumeCount = Number(run.resumeCount || 0) + 1;
      run.nextAttemptAt = cleanText(payload.nextAttemptAt, 40)
        ? new Date(Date.parse(payload.nextAttemptAt)).toISOString()
        : "";
      run.leaseId = "";
      run.leaseOwner = "";
      run.leaseExpiresAt = "";
      run.failure = null;
      run.updatedAt = nowIso(clock);
      await writeJson(STATE_FILES.operations, state.operations);
      return { value: { run, idempotent: false }, details: { runId: run.runId, resumeCount: run.resumeCount, checkpointPreserved: true } };
    });
  }

  async function failRun(runId, payload = {}, actor = "worker") {
    return mutate("run.failed", actor, async (state) => {
      const run = findRun(state, runId);
      if (payload.leaseId) assertLease(run, payload.leaseId);
      const retryable = payload.retryable === true;
      const at = nowIso(clock);
      if (payload.checkpoint !== undefined) {
        assertSyntheticPayload(payload.checkpoint, "run.checkpoint");
        run.checkpoint = clone(payload.checkpoint);
      }
      run.failure = {
        code: cleanText(payload.code || "FRESH_COLLECTION_FAILED", 120),
        message: cleanText(payload.message || "Synthetic collection failed", 500),
        retryable,
        at
      };
      run.status = retryable ? "retry-wait" : "failed";
      run.currentStage = cleanText(payload.currentStage || run.currentStage, 120);
      run.nextAttemptAt = retryable
        ? new Date(Date.parse(payload.nextAttemptAt) || (Number(clock()) + 1000)).toISOString()
        : "";
      run.failedAt = retryable ? "" : at;
      run.leaseId = "";
      run.leaseOwner = "";
      run.leaseExpiresAt = "";
      run.updatedAt = at;
      await writeJson(STATE_FILES.operations, state.operations);
      return { value: { run, terminal: !retryable }, details: { runId: run.runId, retryable, nextAttemptAt: run.nextAttemptAt, checkpointPreserved: true } };
    });
  }

  async function completeRun(runId, payload = {}, actor = "worker") {
    return mutate("run.completed", actor, async (state) => {
      const run = findRun(state, runId);
      if (run.status === "completed") return { changed: false, value: { run, idempotent: true } };
      if (payload.leaseId) assertLease(run, payload.leaseId);
      if (["cancelled", "failed"].includes(run.status)) throw freshError("Terminal run cannot complete", "FRESH_RUN_TERMINAL", 409);
      if (payload.checkpoint !== undefined) {
        assertSyntheticPayload(payload.checkpoint, "run.checkpoint");
        run.checkpoint = clone(payload.checkpoint);
      }
      run.status = "completed";
      if (payload.companyId) run.companyId = cleanId(payload.companyId, "companyId");
      run.progress = 100;
      run.currentStage = cleanText(payload.currentStage || "completed", 120);
      run.completedAt = nowIso(clock);
      run.result = clone(payload.result || run.result || null);
      run.leaseId = "";
      run.leaseOwner = "";
      run.leaseExpiresAt = "";
      run.updatedAt = run.completedAt;
      await writeJson(STATE_FILES.operations, state.operations);
      return { value: { run, idempotent: false }, details: { runId: run.runId, rawEvidenceCount: run.rawEvidenceCount, observationCount: run.observationCount } };
    });
  }

  async function appendRawEvidence(records = [], context = {}) {
    const input = Array.isArray(records) ? records : [records];
    if (!input.length) return { inserted: 0, duplicates: 0, evidence: [] };
    const normalized = input.map((row) => normalizeRawEvidence(row, context));
    return mutate("raw.appended", context.actor || "worker", async (state) => {
      const inserted = [];
      const batchIds = new Set();
      let duplicates = 0;
      for (const row of normalized) {
        const run = findRun(state, row.runId);
        if (row.companyId && !state.identity.companies[row.companyId]) throw freshError("Raw evidence company not found", "FRESH_COMPANY_NOT_FOUND", 404);
        if (state.rawIds.has(row.evidenceId) || batchIds.has(row.evidenceId)) {
          duplicates += 1;
          continue;
        }
        inserted.push(row);
        batchIds.add(row.evidenceId);
        run.rawEvidenceCount = Number(run.rawEvidenceCount || 0) + 1;
        run.updatedAt = nowIso(clock);
      }
      if (!inserted.length) return { changed: false, value: { inserted: 0, duplicates, evidence: [], idempotent: true } };
      await writeChunk("raw", inserted);
      for (const row of inserted) state.rawIds.add(row.evidenceId);
      state.indexes.rawEvidenceIds = [...state.rawIds];
      await writeJson(STATE_FILES.indexes, state.indexes);
      await writeJson(STATE_FILES.operations, state.operations);
      return {
        value: { inserted: inserted.length, duplicates, evidence: inserted, idempotent: false },
        details: { runIds: [...new Set(inserted.map((row) => row.runId))], inserted: inserted.length, duplicates }
      };
    });
  }

  async function appendObservations(records = [], context = {}) {
    const input = Array.isArray(records) ? records : [records];
    if (!input.length) return { inserted: 0, duplicates: 0, observations: [] };
    const normalized = input.map((row) => normalizeObservation(row, context));
    return mutate("observation.appended", context.actor || "worker", async (state) => {
      const inserted = [];
      const batchIds = new Set();
      let duplicates = 0;
      for (const row of normalized) {
        const run = findRun(state, row.runId);
        if (!state.identity.companies[row.companyId]) throw freshError("Observation company not found", "FRESH_COMPANY_NOT_FOUND", 404);
        if (row.evidenceId && !state.rawIds.has(row.evidenceId)) throw freshError("Observation evidenceId not found", "FRESH_EVIDENCE_NOT_FOUND", 404);
        if (state.observationIds.has(row.observationId) || batchIds.has(row.observationId)) {
          duplicates += 1;
          continue;
        }
        inserted.push(row);
        batchIds.add(row.observationId);
        run.observationCount = Number(run.observationCount || 0) + 1;
        run.updatedAt = nowIso(clock);
      }
      if (!inserted.length) return { changed: false, value: { inserted: 0, duplicates, observations: [], idempotent: true } };
      await writeChunk("observation", inserted);
      for (const row of inserted) state.observationIds.add(row.observationId);
      state.indexes.observationIds = [...state.observationIds];
      await writeJson(STATE_FILES.indexes, state.indexes);
      await writeJson(STATE_FILES.operations, state.operations);
      return {
        value: { inserted: inserted.length, duplicates, observations: inserted, idempotent: false },
        details: {
          runIds: [...new Set(inserted.map((row) => row.runId))],
          companyIds: [...new Set(inserted.map((row) => row.companyId))],
          inserted: inserted.length,
          duplicates,
          provenanceComplete: inserted.every((row) => row.provenance && [
            "source", "runId", "observedAt", "targetDate", "channel", "productKey", "sourceUrl"
          ].every((key) => row.provenance[key]))
        }
      };
    });
  }

  async function reviewVerifiedProfile(payload = {}, actor = "admin") {
    const companyId = cleanId(payload.companyId, "companyId");
    const decision = cleanText(payload.decision, 32).toLowerCase();
    if (!["approve", "reject"].includes(decision)) throw freshError("Review decision must be approve or reject", "FRESH_REVIEW_DECISION_INVALID");
    const candidate = normalizeVerifiedProfile(payload.profile || {});
    const reason = cleanText(payload.reason, 1000);
    if (!reason) throw freshError("Manual review reason is required", "FRESH_REVIEW_REASON_REQUIRED");
    const reviewRequestId = cleanText(payload.reviewRequestId, 160)
      ? cleanId(payload.reviewRequestId, "reviewRequestId")
      : `review_${stableHash(`${companyId}|${decision}|${requestSignature(candidate)}|${reason}`, 24, "sha256")}`;
    return mutate(`verified.${decision === "approve" ? "approved" : "rejected"}`, actor, async (state) => {
      if (!state.identity.companies[companyId]) throw freshError("Company not found", "FRESH_COMPANY_NOT_FOUND", 404);
      const replay = state.verified.reviews.find((row) => row.reviewRequestId === reviewRequestId);
      if (replay) return { changed: false, value: { review: replay, profile: state.verified.profiles[companyId] || null, idempotent: true } };
      const before = clone(state.verified.profiles[companyId] || null);
      const expectedVersion = payload.expectedVersion === undefined ? null : Number(payload.expectedVersion);
      if (expectedVersion !== null && Number(before?.version || 0) !== expectedVersion) {
        throw freshError("Verified profile version conflict", "FRESH_VERIFIED_VERSION_CONFLICT", 409);
      }
      const reviewedAt = nowIso(clock);
      const version = Number(before?.version || 0) + 1;
      const next = decision === "approve"
        ? {
          schemaVersion: FRESH_DATA_SCHEMA_VERSION,
          companyId,
          status: "approved",
          version,
          profile: candidate,
          reviewedAt,
          reviewedBy: actorLabel(actor),
          reviewedByType: normalizeActor(actor).type,
          reviewedByRole: normalizeActor(actor).role,
          reason
        }
        : {
          schemaVersion: FRESH_DATA_SCHEMA_VERSION,
          companyId,
          status: "rejected",
          version,
          profile: before?.profile || {},
          rejectedCandidate: candidate,
          reviewedAt,
          reviewedBy: actorLabel(actor),
          reviewedByType: normalizeActor(actor).type,
          reviewedByRole: normalizeActor(actor).role,
          reason
        };
      state.verified.profiles[companyId] = next;
      const review = { reviewRequestId, companyId, decision, reason, before, after: clone(next), reviewedAt, reviewedBy: actorLabel(actor) };
      state.verified.reviews.push(review);
      await writeJson(STATE_FILES.verified, state.verified);
      return { value: { review, profile: next, idempotent: false }, details: { companyId, decision, reason, before, after: next } };
    });
  }

  async function refreshDerivedProfile(companyId, actor = "system") {
    const id = cleanId(companyId, "companyId");
    return mutate("company.projection-refreshed", actor, async (state) => {
      const company = state.identity.companies[id];
      if (!company) throw freshError("Company not found", "FRESH_COMPANY_NOT_FOUND", 404);
      const observations = state.observations.filter((row) => row.companyId === id);
      const verified = state.verified.profiles[id] || null;
      const derived = deriveCompanyQuality(company, observations, verified, clock());
      const changes = state.verified.reviews.filter((row) => row.companyId === id).flatMap((row) => {
        const beforeProfile = row.before?.profile || {};
        const afterProfile = row.after?.profile || {};
        const labels = { primaryName: "업체명", region: "지역", address: "주소", phone: "전화", website: "웹사이트", notes: "검수 메모" };
        return Object.keys(labels).filter((field) => beforeProfile[field] !== afterProfile[field]).map((field) => ({
          changeId: `${row.reviewRequestId}:${field}`,
          fieldLabel: labels[field],
          previousValue: beforeProfile[field] || "",
          currentValue: afterProfile[field] || "",
          changedAt: row.reviewedAt
        }));
      });
      const publicProfile = businessSafeProjection(company, verified, derived, observations, { changes });
      state.derived.profiles[id] = derived;
      state.businessSafe.profiles[id] = publicProfile;
      await writeJson(STATE_FILES.derived, state.derived);
      await writeJson(STATE_FILES.businessSafe, state.businessSafe);
      return {
        value: { companyId: id, derived, businessSafe: publicProfile },
        details: { companyId: id, observationCount: observations.length, completeness: derived.dataCompleteness.score, confidence: derived.confidence.level }
      };
    });
  }

  async function ensureReadReady() {
    await initialize();
    await queue;
    assertBoundaryStable();
  }

  async function getRun(runId) {
    await ensureReadReady();
    return clone(findRun(cache, runId));
  }

  async function listRuns(filter = {}) {
    await ensureReadReady();
    const statuses = Array.isArray(filter.statuses) ? filter.statuses : (filter.status ? [filter.status] : []);
    if (statuses.some((status) => !FRESH_RUN_STATUSES.includes(status))) throw freshError("Run status filter is invalid", "FRESH_RUN_STATUS_INVALID");
    const dueBefore = cleanText(filter.dueBefore, 40) ? Date.parse(filter.dueBefore) : null;
    const leaseExpiredBefore = cleanText(filter.leaseExpiredBefore, 40) ? Date.parse(filter.leaseExpiredBefore) : null;
    return clone(cache.operations.runs.filter((run) => {
      if (statuses.length && !statuses.includes(run.status)) return false;
      if (filter.clientRequestId && run.clientRequestId !== filter.clientRequestId) return false;
      if (filter.actorAccountId && run.actorAccountId !== filter.actorAccountId) return false;
      if (filter.companyId && run.companyId !== filter.companyId) return false;
      if (filter.targetId && run.targetId !== filter.targetId) return false;
      if (dueBefore !== null && run.nextAttemptAt && Date.parse(run.nextAttemptAt) > dueBefore) return false;
      if (leaseExpiredBefore !== null && (!run.leaseExpiresAt || Date.parse(run.leaseExpiresAt) > leaseExpiredBefore)) return false;
      return true;
    }));
  }

  async function listObservations(filter = {}) {
    await ensureReadReady();
    const limit = Math.max(1, Math.min(100_000, Number(filter.limit || 10_000)));
    return clone(cache.observations.filter((row) => {
      if (filter.companyId && row.companyId !== filter.companyId) return false;
      if (filter.runId && row.runId !== filter.runId) return false;
      if (filter.mode && row.mode !== filter.mode) return false;
      if (filter.targetDate && row.targetDate !== filter.targetDate) return false;
      if (filter.productKey && row.productKey !== filter.productKey) return false;
      return true;
    }).slice(-limit));
  }

  async function getCompany(companyId, options = {}) {
    await ensureReadReady();
    const id = cleanId(companyId, "companyId");
    const company = cache.identity.companies[id];
    if (!company) throw freshError("Company not found", "FRESH_COMPANY_NOT_FOUND", 404);
    const projection = cleanText(options.projection || "identity", 40);
    if (projection === "business-safe") {
      const tenantCompanyId = cleanText(options.tenantCompanyId, 160);
      if (tenantCompanyId && !(company.tenantCompanyIds || []).includes(tenantCompanyId)) {
        throw freshError("Business tenant cannot access this company", "FRESH_TENANT_FORBIDDEN", 403);
      }
      return clone(cache.businessSafe.profiles[id]
        || businessSafeProjection(company, cache.verified.profiles[id] || null, cache.derived.profiles[id] || null, cache.observations.filter((row) => row.companyId === id)));
    }
    if (projection === "derived") return clone(cache.derived.profiles[id] || null);
    if (projection === "verified") return clone(cache.verified.profiles[id] || null);
    return clone(company);
  }

  async function listCompanies(options = {}) {
    await ensureReadReady();
    const tenantCompanyId = cleanText(options.tenantCompanyId, 160);
    const companies = Object.values(cache.identity.companies).filter((company) => (
      !tenantCompanyId || (company.tenantCompanyIds || []).includes(tenantCompanyId)
    ));
    const rows = [];
    for (const company of companies) rows.push(await getCompany(company.companyId, options));
    return rows;
  }

  async function getBusinessSafeCompany(companyId, tenantCompanyId) {
    const tenant = cleanId(tenantCompanyId, "tenantCompanyId");
    return getCompany(companyId, { projection: "business-safe", tenantCompanyId: tenant });
  }

  async function listBusinessSafeCompanies(tenantCompanyId) {
    const tenant = cleanId(tenantCompanyId, "tenantCompanyId");
    return listCompanies({ projection: "business-safe", tenantCompanyId: tenant });
  }

  async function listAudit(filter = {}) {
    await ensureReadReady();
    const limit = Math.max(1, Math.min(10_000, Number(filter.limit || 1000)));
    return clone(cache.audit.filter((row) => {
      if (filter.event && row.event !== filter.event) return false;
      if (filter.companyId && row.details?.companyId !== filter.companyId) return false;
      if (filter.runId && row.details?.runId !== filter.runId && !row.details?.runIds?.includes(filter.runId)) return false;
      return true;
    }).slice(-limit));
  }

  async function managedRelatives() {
    const relatives = [];
    async function walk(relative) {
      const directory = absolute(relative || ".");
      const entries = await fsp.readdir(directory, { withFileTypes: true });
      for (const entry of entries) {
        const child = relative ? `${relative}/${entry.name}` : entry.name;
        if (child === LOCK_FILE || child.startsWith("snapshots/") || child === "snapshots") continue;
        if (entry.name.endsWith(".tmp")) continue;
        if (entry.isSymbolicLink()) {
          throw freshError(
            "Fresh store managed paths cannot contain a symlink or junction",
            "FRESH_REPOSITORY_SYMLINK_FORBIDDEN",
            500
          );
        }
        if (entry.isDirectory()) await walk(child);
        else if (entry.isFile()) relatives.push(child.replace(/\\/g, "/"));
      }
    }
    await walk("");
    return relatives.sort();
  }

  async function copyRepositoryFile(sourceRelative, destinationAbsolute) {
    const source = absolute(sourceRelative);
    assertRepositoryTargetSafe(destinationAbsolute);
    await fsp.mkdir(path.dirname(destinationAbsolute), { recursive: true });
    assertRepositoryTargetSafe(path.dirname(destinationAbsolute));
    assertRepositoryTargetSafe(destinationAbsolute);
    await fsp.copyFile(source, destinationAbsolute);
    metrics.repositoryFileCopies += 1;
  }

  async function createSnapshot(actor = "system", label = "manual") {
    await initialize();
    return serialize(() => withStoreLock(async () => {
      await loadAll();
      const snapshotId = `snapshot_${String(cache.manifest.revision).padStart(8, "0")}_${cleanText(idFactory(), 80).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 24)}`;
      const stagingRelative = `snapshots/.${snapshotId}.${process.pid}.tmp`;
      const finalRelative = `snapshots/${snapshotId}`;
      const staging = absolute(stagingRelative);
      const final = absolute(finalRelative);
      const stagingFiles = assertRepositoryTargetSafe(path.join(staging, "files"));
      await fsp.mkdir(stagingFiles, { recursive: true });
      assertRepositoryTargetSafe(stagingFiles);
      const files = [];
      try {
        for (const relative of await managedRelatives()) {
          const destination = path.join(staging, "files", ...relative.split("/"));
          await copyRepositoryFile(relative, destination);
          assertRepositoryTargetSafe(destination);
          const data = await fsp.readFile(destination);
          files.push({ relative, size: data.length, checksum: crypto.createHash("sha256").update(data).digest("hex") });
        }
        const snapshot = {
          snapshotKind: "fresh-integration-store-snapshot",
          schemaVersion: FRESH_DATA_SCHEMA_VERSION,
          snapshotId,
          storeId: cache.manifest.storeId,
          storeRevision: cache.manifest.revision,
          label: cleanText(label, 160),
          createdAt: nowIso(clock),
          createdBy: actorLabel(actor),
          fileCount: files.length,
          files
        };
        const snapshotManifest = assertRepositoryTargetSafe(path.join(staging, SNAPSHOT_MANIFEST));
        await fsp.writeFile(snapshotManifest, `${JSON.stringify(snapshot, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
        assertRepositoryTargetSafe(staging);
        assertRepositoryTargetSafe(final);
        await fsp.rename(staging, final);
        metrics.repositoryFileWrites += 1;
        await finishMutation("snapshot.created", actor, { snapshotId, storeRevision: snapshot.storeRevision, fileCount: files.length, snapshotKind: snapshot.snapshotKind });
        return clone(snapshot);
      } catch (error) {
        try {
          await fsp.rm(assertRepositoryTargetSafe(staging), { recursive: true, force: true });
        } catch {}
        throw error;
      }
    }));
  }

  async function listSnapshots() {
    await ensureReadReady();
    const entries = await fsp.readdir(absolute("snapshots"), { withFileTypes: true });
    const rows = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const relative = `snapshots/${entry.name}/${SNAPSHOT_MANIFEST}`;
      try {
        const value = await readJson(relative);
        if (value.snapshotKind === "fresh-integration-store-snapshot" && value.storeId === cache.manifest.storeId) rows.push(value);
      } catch {}
    }
    return clone(rows.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))));
  }

  async function rollbackSnapshot(snapshotId, actor = "system") {
    const id = cleanId(snapshotId, "snapshotId");
    await initialize();
    return serialize(() => withStoreLock(async () => {
      await loadAll();
      const revisionBeforeRollback = Number(cache.manifest.revision || 0);
      const auditSequenceBeforeRollback = Number(cache.manifest.appendSequences.audit || 0);
      const metadata = await readJson(`snapshots/${id}/${SNAPSHOT_MANIFEST}`);
      if (metadata.snapshotKind !== "fresh-integration-store-snapshot" || metadata.storeId !== cache.manifest.storeId) {
        throw freshError("Snapshot does not belong to this fresh store", "FRESH_SNAPSHOT_INVALID", 409);
      }
      const expected = new Set(metadata.files.map((row) => row.relative));
      for (const file of metadata.files) {
        // Audit is append-only even when mutable data is rolled back. Keeping
        // post-snapshot review events makes the rejected change and rollback
        // independently reconstructable.
        if (file.relative.startsWith("audit/chunks/")) continue;
        const source = absolute(`snapshots/${id}/files/${file.relative}`);
        const data = await fsp.readFile(source);
        metrics.repositoryFileReads += 1;
        const checksum = crypto.createHash("sha256").update(data).digest("hex");
        if (checksum !== file.checksum) throw freshError("Snapshot checksum mismatch", "FRESH_SNAPSHOT_CORRUPT", 500);
        await atomicWrite(file.relative, data.toString("utf8"));
      }
      for (const relative of await managedRelatives()) {
        if (!expected.has(relative) && !relative.startsWith("audit/chunks/")) await fsp.unlink(absolute(relative));
      }
      await loadAll();
      cache.manifest.revision = revisionBeforeRollback;
      cache.manifest.appendSequences.audit = auditSequenceBeforeRollback;
      await finishMutation("snapshot.rolled-back", actor, {
        snapshotId: id,
        restoredRevision: metadata.storeRevision,
        restoredFiles: metadata.fileCount,
        snapshotKind: metadata.snapshotKind
      });
      return { ok: true, snapshotId: id, restoredRevision: metadata.storeRevision, currentRevision: cache.manifest.revision };
    }));
  }

  async function diagnostics() {
    await ensureReadReady();
    return {
      storeKind: cache.manifest.storeKind,
      schemaVersion: cache.manifest.schemaVersion,
      storeId: cache.manifest.storeId,
      revision: cache.manifest.revision,
      dataBoundary: cache.manifest.dataBoundary,
      dataDirectoryFingerprint: stableHash(initialCanonical, 24, "sha256"),
      forbiddenBoundaryFingerprints: boundary.boundaryFingerprints,
      layerCounts: {
        raw: cache.raw.length,
        observation: cache.observations.length,
        verified: Object.keys(cache.verified.profiles).length,
        derived: Object.keys(cache.derived.profiles).length,
        businessSafe: Object.keys(cache.businessSafe.profiles).length
      },
      companyCount: Object.keys(cache.identity.companies).length,
      companyIdCollisions: 0,
      duplicateCandidateCount: cache.identity.duplicateCandidates.length,
      providerCalls: 0,
      legacyRuntimeReads: 0,
      legacyRuntimeCopies: 0,
      repositoryFileReads: metrics.repositoryFileReads,
      repositoryFileWrites: metrics.repositoryFileWrites,
      repositoryFileCopies: metrics.repositoryFileCopies
    };
  }

  return Object.freeze({
    initialize,
    seedTarget,
    discoverCompany,
    linkCompatibleIdentity,
    createRun,
    getRun,
    listRuns,
    acquireRunLease,
    heartbeatRun,
    requestRunCancel,
    cancelRun,
    resumeRun,
    failRun,
    completeRun,
    appendRawEvidence,
    appendObservations,
    listObservations,
    reviewVerifiedProfile,
    refreshDerivedProfile,
    getCompany,
    listCompanies,
    getBusinessSafeCompany,
    listBusinessSafeCompanies,
    createSnapshot,
    listSnapshots,
    rollbackSnapshot,
    listAudit,
    diagnostics
  });
}

module.exports = {
  CHUNK_LAYERS,
  LOCK_FILE,
  STATE_FILES,
  assertFreshAuthStoreBoundary,
  assertManifest,
  assertPathBoundaries,
  canonicalizeCandidate,
  createFreshIntegrationRepository,
  emptyIdentityState,
  emptyIndexesState,
  emptyManifest,
  emptyOperationsState,
  emptyProjectionState,
  emptyVerifiedState,
  normalizeActor,
  pathsOverlap,
  projectLegacyBoundaries,
  resolveFreshIntegrationDataDir
};
