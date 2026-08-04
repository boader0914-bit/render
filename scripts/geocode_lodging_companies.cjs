"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const {
  MAPPABLE_LOCATION_STATUSES,
  createFixtureGeocoder,
  effectiveCompanyLocation,
  geocodeAddress,
  normalizeAddress,
  normalizeLocationContract
} = require("./lodging_geocoding_contract.cjs");
const { atomicWriteJson } = require("./secure_json_store.cjs");
const { acquireCompanyMasterSharedLock } = require("./company_master_shared_lock.cjs");

const APPLY_TOKEN = "APPLY_LODGING_GEOCODING";
const ROLLBACK_TOKEN = "ROLLBACK_LODGING_GEOCODING";
const KNOWN_PREVIEW_ROOT = "/var/data/v2-preview-runtime";
const WORKSPACE_COMPANY_MASTER = path.resolve(__dirname, "..", "company_master");
const KOREA_BOUNDS = Object.freeze({ minLat: 32, maxLat: 39.5, minLon: 124, maxLon: 132 });
const APPLY_RECEIPT_KIND = "lodging-geocoding-apply-receipt";

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hashBuffer(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function jsonBuffer(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function validateCompanyMaster(value) {
  if (!isPlainObject(value)) throw new Error("company master must be a JSON object");
  if (!isPlainObject(value.companies)) throw new Error("company master companies must be an object");
  for (const [key, company] of Object.entries(value.companies)) {
    if (!isPlainObject(company)) throw new Error(`company ${key} must be an object`);
  }
  return true;
}

function requiredSha256(value, label) {
  const hash = String(value || "").trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error(`${label} must be a 64-character SHA-256 hash`);
  return hash;
}

function validateApplyReceipt(value) {
  if (!isPlainObject(value) || value.kind !== APPLY_RECEIPT_KIND || value.schemaVersion !== 1) {
    throw new Error("invalid lodging geocoding apply receipt");
  }
  for (const field of ["inputPath", "outputPath", "backupPath", "receiptPath"]) {
    if (!path.isAbsolute(String(value[field] || ""))) throw new Error(`apply receipt ${field} must be absolute`);
  }
  for (const field of ["inputHash", "fixtureHash", "outputHash", "backupHash"]) {
    requiredSha256(value[field], `apply receipt ${field}`);
  }
  return true;
}

function invariantSnapshot(master) {
  validateCompanyMaster(master);
  return Object.fromEntries(Object.entries(master.companies).map(([key, company]) => [key, {
    companyId: company.companyId,
    createdAt: company.createdAt,
    manualCorrection: company.manualCorrection
  }]));
}

function assertMigrationInvariants(before, after) {
  validateCompanyMaster(after);
  const beforeKeys = Object.keys(before.companies).sort();
  const afterKeys = Object.keys(after.companies).sort();
  if (JSON.stringify(beforeKeys) !== JSON.stringify(afterKeys)) {
    throw new Error("company key set changed during geocoding");
  }
  const expected = invariantSnapshot(before);
  const actual = invariantSnapshot(after);
  if (JSON.stringify(expected) !== JSON.stringify(actual)) {
    throw new Error("companyId, createdAt, or manualCorrection changed during geocoding");
  }
  return true;
}

function pathInside(candidate, root) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function portablePosixPath(value) {
  return String(value || "").trim().replace(/\\/g, "/").replace(/\/{2,}/g, "/");
}

function assertNotProtectedPath(candidate, label, env = process.env) {
  const portable = portablePosixPath(candidate);
  if (/^\/var\/data(?:\/|$)/i.test(portable)) {
    throw new Error(`${label} must not access the Render persistent disk`);
  }
  if (portable === KNOWN_PREVIEW_ROOT || portable.startsWith(`${KNOWN_PREVIEW_ROOT}/`)) {
    throw new Error(`${label} must not access the Preview data root`);
  }
  if (pathInside(candidate, WORKSPACE_COMPANY_MASTER)) {
    throw new Error(`${label} must not access the workspace company master`);
  }
  const protectedPaths = [env.V2_PREVIEW_DATA_ROOT, env.COMPANY_MASTER_FILE]
    .map((value) => String(value || "").trim())
    .filter((value) => path.isAbsolute(value));
  for (const protectedPath of protectedPaths) {
    if (pathInside(candidate, protectedPath) || path.resolve(candidate) === path.resolve(protectedPath)) {
      throw new Error(`${label} must not access configured Preview data`);
    }
  }
}

function explicitJsonPath(value, label, env = process.env) {
  const rawValue = String(value || "").trim();
  // Check the portable spelling before Windows path.resolve can translate a
  // POSIX Render path such as /var/data into C:\\var\\data.
  assertNotProtectedPath(rawValue, label, env);
  if (!rawValue || !path.isAbsolute(rawValue)) {
    throw new Error(`${label} must be an explicit absolute JSON path`);
  }
  const resolved = path.resolve(rawValue);
  if (path.extname(resolved).toLowerCase() !== ".json") {
    throw new Error(`${label} must reference a JSON file`);
  }
  assertNotProtectedPath(resolved, label, env);
  return resolved;
}

async function nearestExistingRealPath(target) {
  let current = path.resolve(target);
  while (true) {
    try {
      return { existingPath: current, realPath: await fsp.realpath(current) };
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      current = parent;
    }
  }
}

async function assertSafeResolvedPath(target, label, env = process.env) {
  const resolved = explicitJsonPath(target, label, env);
  try {
    const entry = await fsp.lstat(resolved);
    if (entry.isSymbolicLink()) {
      try {
        await fsp.realpath(resolved);
      } catch (error) {
        if (error?.code === "ENOENT") throw new Error(`${label} must not be a dangling symbolic link`);
        throw error;
      }
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const nearest = await nearestExistingRealPath(resolved);
  const relative = path.relative(nearest.existingPath, resolved);
  const realTarget = path.resolve(nearest.realPath, relative);
  assertNotProtectedPath(realTarget, label, env);

  const protectedPaths = [env.V2_PREVIEW_DATA_ROOT, env.COMPANY_MASTER_FILE]
    .map((value) => String(value || "").trim())
    .filter((value) => path.isAbsolute(value));
  for (const protectedPath of protectedPaths) {
    try {
      const protectedRealPath = await fsp.realpath(protectedPath);
      if (pathInside(realTarget, protectedRealPath) || path.resolve(realTarget) === path.resolve(protectedRealPath)) {
        throw new Error(`${label} must not access configured Preview data through a symbolic link`);
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return { target: resolved, realTarget };
}

async function readJsonDocument(filePath, label, env = process.env) {
  const { target, realTarget: safeRealTarget } = await assertSafeResolvedPath(filePath, label, env);
  const realTarget = await fsp.realpath(target);
  const raw = await fsp.readFile(realTarget);
  let value;
  try {
    value = JSON.parse(raw.toString("utf8").replace(/^\uFEFF/, ""));
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
  return {
    target,
    realTarget: path.resolve(realTarget || safeRealTarget),
    raw,
    value,
    hash: hashBuffer(raw),
    semanticHash: hashBuffer(jsonBuffer(value))
  };
}

function sameResolvedPath(left, right) {
  return path.resolve(left) === path.resolve(right);
}

async function assertStableSafePath(initial, target, label, env) {
  const current = await assertSafeResolvedPath(target, label, env);
  if (!sameResolvedPath(initial.realTarget, current.realTarget)) {
    throw new Error(`${label} resolved target changed while acquiring the exclusive lock`);
  }
  return current;
}

function addressesForCompany(company = {}) {
  const values = [
    ...(Array.isArray(company.addresses) ? company.addresses : []),
    company.address || "",
    company.resolvedAddress || ""
  ];
  const rows = [];
  const seen = new Set();
  for (const value of values) {
    const normalized = normalizeAddress(value);
    if (!normalized.normalizedAddress || seen.has(normalized.fingerprint)) continue;
    seen.add(normalized.fingerprint);
    rows.push(normalized);
  }
  return rows;
}

function isKoreaLocation(location = {}) {
  const latitude = location.latitude;
  const longitude = location.longitude;
  return typeof latitude === "number" && Number.isFinite(latitude)
    && typeof longitude === "number" && Number.isFinite(longitude)
    && latitude >= KOREA_BOUNDS.minLat && latitude <= KOREA_BOUNDS.maxLat
    && longitude >= KOREA_BOUNDS.minLon && longitude <= KOREA_BOUNDS.maxLon;
}

function isMappableLocation(location = {}) {
  return MAPPABLE_LOCATION_STATUSES.has(location.status) && isKoreaLocation(location);
}

function emptyStats() {
  return {
    totalCompanies: 0,
    withAddress: 0,
    missingAddress: 0,
    multipleAddressReview: 0,
    existingMappable: 0,
    verifiedLocations: 0,
    resolvedLocations: 0,
    automaticLocations: 0,
    legacyLocations: 0,
    manualLocations: 0,
    manualLocationReview: 0,
    coordinateRangeErrors: 0,
    fingerprintMismatches: 0,
    eligibleCompanies: 0,
    attemptedCompanies: 0,
    fixtureLookups: 0,
    resolvedCompanies: 0,
    approximateCompanies: 0,
    ambiguousCompanies: 0,
    notFoundCompanies: 0,
    invalidCompanies: 0,
    errorCompanies: 0,
    changedCompanies: 0,
    unchangedCompanies: 0,
    statusCounts: {
      verified: 0,
      resolved: 0,
      approximate: 0,
      ambiguous: 0,
      not_found: 0,
      invalid: 0,
      pending: 0,
      error: 0
    }
  };
}

function incrementStatus(stats, status) {
  if (Object.prototype.hasOwnProperty.call(stats.statusCounts, status)) stats.statusCounts[status] += 1;
}

function locationForReview(status, address, source = "none") {
  return normalizeLocationContract({
    status,
    source,
    resolvedAddress: address.normalizedAddress,
    addressFingerprint: address.fingerprint
  }, { address: address.normalizedAddress, defaultStatus: status, defaultSource: source });
}

function withLocation(company, location) {
  const previous = isPlainObject(company.location) ? company.location : {};
  return { ...company, location: { ...previous, ...location } };
}

async function planCompanyMasterGeocoding(master, options = {}) {
  validateCompanyMaster(master);
  const mode = options.mode || "dry-run";
  const applyPlan = mode !== "inspect";
  const stats = emptyStats();
  const next = { ...master, companies: { ...master.companies } };
  const baseAdapter = typeof options.adapter === "function" ? options.adapter : null;
  const adapter = baseAdapter ? async (request) => {
    stats.fixtureLookups += 1;
    return baseAdapter(request);
  } : null;

  for (const [key, company] of Object.entries(master.companies)) {
    stats.totalCompanies += 1;
    const addresses = addressesForCompany(company);
    const current = effectiveCompanyLocation(company);
    incrementStatus(stats, current.status);
    if (current.status === "verified") stats.verifiedLocations += 1;
    if (current.status === "resolved") stats.resolvedLocations += 1;
    if (current.source === "provider") stats.automaticLocations += 1;
    if (current.source === "legacy") stats.legacyLocations += 1;
    const locationPoints = [company.location, ...(Array.isArray(company.coordinates) ? company.coordinates : [])].filter(isPlainObject);
    if (locationPoints.some((point) => (
      typeof (point.latitude ?? point.lat) === "number"
      && typeof (point.longitude ?? point.lon ?? point.lng) === "number"
      && !isKoreaLocation({ latitude: point.latitude ?? point.lat, longitude: point.longitude ?? point.lon ?? point.lng })
    ))) stats.coordinateRangeErrors += 1;
    if (
      addresses[0]?.fingerprint
      && company.location?.addressFingerprint
      && company.location.addressFingerprint !== addresses[0].fingerprint
      && company.location.source !== "manual"
    ) stats.fingerprintMismatches += 1;

    if (addresses.length) stats.withAddress += 1;
    else stats.missingAddress += 1;

    if (current.source === "manual") {
      stats.manualLocations += 1;
      if (!isMappableLocation(current)) stats.manualLocationReview += 1;
      stats.unchangedCompanies += 1;
      continue;
    }
    if (isMappableLocation(current)) {
      stats.existingMappable += 1;
      stats.unchangedCompanies += 1;
      continue;
    }
    if (!addresses.length) {
      stats.invalidCompanies += 1;
      stats.unchangedCompanies += 1;
      continue;
    }

    stats.eligibleCompanies += 1;
    let result;
    if (addresses.length > 1) {
      stats.multipleAddressReview += 1;
      stats.ambiguousCompanies += 1;
      result = locationForReview("ambiguous", addresses[0]);
    } else if (!applyPlan) {
      stats.unchangedCompanies += 1;
      continue;
    } else {
      stats.attemptedCompanies += 1;
      result = await geocodeAddress({
        originalAddress: addresses[0].originalAddress,
        requestId: company.companyId || key
      }, {
        enabled: Boolean(adapter),
        adapter,
        timeoutMs: options.timeoutMs,
        signal: options.signal
      });
      result = normalizeLocationContract({
        ...result,
        addressFingerprint: addresses[0].fingerprint
      }, {
        address: addresses[0].normalizedAddress,
        defaultSource: result.source || "provider",
        defaultStatus: result.status || "pending"
      });
      if (MAPPABLE_LOCATION_STATUSES.has(result.status) && !isKoreaLocation(result)) {
        result = locationForReview("invalid", addresses[0], result.source || "provider");
      }
      if (result.status === "resolved" || result.status === "verified") stats.resolvedCompanies += 1;
      else if (result.status === "approximate") stats.approximateCompanies += 1;
      else if (result.status === "ambiguous") stats.ambiguousCompanies += 1;
      else if (result.status === "not_found") stats.notFoundCompanies += 1;
      else if (result.status === "invalid") stats.invalidCompanies += 1;
      else if (result.status === "error") stats.errorCompanies += 1;
    }

    // A transient provider error or a disabled adapter must not rewrite a
    // previously reviewed company record. Other deterministic review states
    // are useful dry-run/apply output and remain idempotent.
    if (!applyPlan || result.status === "error" || result.status === "pending") {
      stats.unchangedCompanies += 1;
      continue;
    }
    const updated = withLocation(company, result);
    if (JSON.stringify(updated) === JSON.stringify(company)) {
      stats.unchangedCompanies += 1;
    } else {
      next.companies[key] = updated;
      stats.changedCompanies += 1;
    }
  }

  assertMigrationInvariants(master, next);
  return { master: next, stats };
}

function fixturesFromDocument(value) {
  const source = isPlainObject(value?.fixtures) ? value.fixtures : value;
  if (Array.isArray(source)) {
    return Object.fromEntries(source.map((row, index) => {
      if (!isPlainObject(row) || !row.address) throw new Error(`fixture row ${index} requires an address`);
      return [row.address, row.results ?? row.result ?? row.location ?? []];
    }));
  }
  if (!isPlainObject(source)) throw new Error("fixture JSON must be an address map or fixture row array");
  return source;
}

async function loadFixtureAdapter(fixturePath, env = process.env) {
  if (!fixturePath) throw new Error("dry-run and apply require an explicit --fixture JSON path");
  const fixture = await readJsonDocument(fixturePath, "--fixture", env);
  return {
    adapter: createFixtureGeocoder(fixturesFromDocument(fixture.value)),
    fixtureHash: fixture.hash,
    fixturePath: fixture.target,
    fixtureRealPath: fixture.realTarget
  };
}

async function exists(filePath) {
  try {
    await fsp.access(filePath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function syncDirectory(directory) {
  let handle;
  try {
    handle = await fsp.open(directory, "r");
    await handle.sync();
  } catch {
    // The file commit already completed. Directory fsync is best effort on
    // platforms that do not allow directory handles.
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function atomicWriteBuffer(filePath, raw, options = {}) {
  const target = path.resolve(filePath);
  const directory = path.dirname(target);
  await fsp.mkdir(directory, { recursive: true, mode: 0o700 });
  const tempPath = path.join(directory, `.${path.basename(target)}.${process.pid}.${crypto.randomBytes(12).toString("hex")}.tmp`);
  let handle;
  try {
    handle = await fsp.open(tempPath, "wx", 0o600);
    await handle.writeFile(raw);
    await handle.sync();
    await handle.close();
    handle = null;
    await fsp.chmod(tempPath, 0o600).catch((error) => {
      if (!["ENOSYS", "ENOTSUP", "EPERM", "EACCES"].includes(error?.code)) throw error;
    });
    if (options.noReplace === true) {
      await fsp.link(tempPath, target);
      // The hard link is the commit point; temp-link cleanup is best effort.
      await fsp.rm(tempPath, { force: true }).catch(() => {});
    } else {
      await fsp.rename(tempPath, target);
    }
    await syncDirectory(directory);
  } catch (error) {
    await handle?.close().catch(() => {});
    await fsp.rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
}

async function acquireLock(target) {
  const lockPath = `${target}.geocoding.lock`;
  let handle;
  try {
    handle = await fsp.open(lockPath, "wx", 0o600);
  } catch (error) {
    if (error?.code === "EEXIST") throw new Error(`geocoding lock already exists: ${lockPath}`);
    throw error;
  }
  return async () => {
    await handle.close().catch(() => {});
    await fsp.rm(lockPath, { force: true }).catch(() => {});
  };
}

async function acquireLocks(targets = []) {
  const releases = [];
  const ordered = [...new Set(targets.map((target) => path.resolve(target)))].sort();
  try {
    for (const target of ordered) releases.push(await acquireLock(target));
  } catch (error) {
    for (const release of releases.reverse()) await release();
    throw error;
  }
  return async () => {
    for (const release of releases.reverse()) await release();
  };
}

async function companyMasterLockRoot(target, options = {}) {
  const requested = String(options.companyMasterRoot || "").trim();
  const lexicalRoot = requested ? path.resolve(requested) : path.dirname(path.resolve(target));
  if (requested && !path.isAbsolute(requested)) {
    throw new Error("--company-master-root must be an explicit absolute directory");
  }
  let entry;
  try {
    entry = await fsp.lstat(lexicalRoot);
  } catch (error) {
    if (error?.code === "ENOENT") throw new Error("company master lock root must already exist");
    throw error;
  }
  if (entry.isSymbolicLink() || !entry.isDirectory()) {
    throw new Error("company master lock root must be a real directory");
  }
  const realRoot = path.resolve(await fsp.realpath(lexicalRoot));
  if (!sameResolvedPath(lexicalRoot, realRoot) || !pathInside(target, realRoot)) {
    throw new Error("company master target must stay within its real lock root");
  }
  return realRoot;
}

async function withGeocodingWriteLocks(target, auxiliaryTargets, options, task) {
  if (typeof task !== "function") throw new TypeError("geocoding write lock task must be a function");
  const canonicalTarget = path.resolve(target);
  await fsp.mkdir(path.dirname(canonicalTarget), { recursive: true, mode: 0o700 });
  const allowedRoot = await companyMasterLockRoot(canonicalTarget, options);
  const sharedLock = await acquireCompanyMasterSharedLock(canonicalTarget, {
    allowedRoot,
    allowMissingTarget: options.allowMissingTarget === true,
    purpose: options.purpose || "geocoding-company-master-write",
    timeoutMs: Number.isInteger(options.lockTimeoutMs) ? options.lockTimeoutMs : 0,
    pollIntervalMs: Number.isInteger(options.lockPollIntervalMs) ? options.lockPollIntervalMs : 100
  });

  let releaseAuxiliary = null;
  let value;
  let taskError;
  try {
    releaseAuxiliary = await acquireLocks(auxiliaryTargets);
    value = await task(sharedLock);
  } catch (error) {
    taskError = error;
  }

  const releaseErrors = [];
  if (releaseAuxiliary) {
    try {
      await releaseAuxiliary();
    } catch (error) {
      releaseErrors.push(error);
    }
  }
  try {
    await sharedLock.release();
  } catch (error) {
    releaseErrors.push(error);
  }
  if (taskError && releaseErrors.length) {
    throw new AggregateError([taskError, ...releaseErrors], "geocoding task and lock release both failed");
  }
  if (taskError) throw taskError;
  if (releaseErrors.length === 1) throw releaseErrors[0];
  if (releaseErrors.length > 1) throw new AggregateError(releaseErrors, "geocoding lock release failed");
  return value;
}

function booleanOption(value) {
  return value === true || /^(?:1|true|yes)$/i.test(String(value || ""));
}

function baseReport(mode, source, result, fixture = {}) {
  const output = jsonBuffer(result.master);
  return {
    mode,
    input: source.target,
    inputHash: source.hash,
    semanticInputHash: source.semanticHash,
    outputHash: hashBuffer(output),
    fixture: fixture.fixturePath || "",
    fixtureHash: fixture.fixtureHash || "",
    externalProviderCalls: 0,
    rollbackPossible: false,
    ...result.stats
  };
}

async function runRollback(options = {}) {
  const env = options.env || process.env;
  if (options.confirm !== ROLLBACK_TOKEN) {
    throw new Error(`rollback requires --confirm ${ROLLBACK_TOKEN}`);
  }
  const target = explicitJsonPath(options.input, "--input", env);
  const backupPath = explicitJsonPath(options.backup, "--backup", env);
  const receiptPath = explicitJsonPath(options.receipt, "--receipt", env);
  const expectedCurrentHash = requiredSha256(options.expectedCurrentHash, "--expected-current-hash");
  const expectedBackupHash = requiredSha256(options.expectedBackupHash, "--expected-backup-hash");
  const expectedReceiptHash = requiredSha256(options.expectedReceiptHash, "--expected-receipt-hash");
  const targetSafe = await assertSafeResolvedPath(target, "--input", env);
  const backupSafe = await assertSafeResolvedPath(backupPath, "--backup", env);
  const receiptSafe = await assertSafeResolvedPath(receiptPath, "--receipt", env);
  if (new Set([targetSafe.realTarget, backupSafe.realTarget, receiptSafe.realTarget]
    .map((candidate) => path.resolve(candidate))).size !== 3) {
    throw new Error("rollback target, backup, and receipt must differ");
  }
  return withGeocodingWriteLocks(targetSafe.realTarget, [backupSafe.realTarget, receiptSafe.realTarget], {
    ...options,
    allowMissingTarget: false,
    purpose: "geocoding-company-master-rollback"
  }, async () => {
    await assertStableSafePath(targetSafe, target, "--input", env);
    await assertStableSafePath(backupSafe, backupPath, "--backup", env);
    await assertStableSafePath(receiptSafe, receiptPath, "--receipt", env);
    const receipt = await readJsonDocument(receiptPath, "--receipt", env);
    validateApplyReceipt(receipt.value);
    if (receipt.hash !== expectedReceiptHash) throw new Error("rollback receipt hash does not match the approved apply receipt");
    const backup = await readJsonDocument(backupPath, "--backup", env);
    const current = await readJsonDocument(target, "--input", env);
    validateCompanyMaster(backup.value);
    validateCompanyMaster(current.value);
    const targetReal = (await assertSafeResolvedPath(target, "--input", env)).realTarget;
    const backupReal = (await assertSafeResolvedPath(backupPath, "--backup", env)).realTarget;
    const receiptReal = (await assertSafeResolvedPath(receiptPath, "--receipt", env)).realTarget;
    if (path.resolve(receipt.value.outputPath) !== path.resolve(targetReal)) throw new Error("rollback target does not match the apply receipt");
    if (path.resolve(receipt.value.backupPath) !== path.resolve(backupReal)) throw new Error("rollback backup does not match the apply receipt");
    if (path.resolve(receipt.value.receiptPath) !== path.resolve(receiptReal)) throw new Error("rollback receipt path does not match the apply receipt");
    if (current.hash !== expectedCurrentHash || current.hash !== receipt.value.outputHash) {
      throw new Error("rollback target changed after apply; refusing restore");
    }
    if (backup.hash !== expectedBackupHash || backup.hash !== receipt.value.backupHash) {
      throw new Error("rollback backup hash does not match the apply receipt");
    }
    await atomicWriteBuffer(targetSafe.realTarget, backup.raw);
    const restored = await readJsonDocument(targetSafe.realTarget, "--input", env);
    if (restored.hash !== backup.hash || restored.semanticHash !== backup.semanticHash) throw new Error("rollback hash verification failed");
    return {
      mode: "rollback",
      input: target,
      backup: backupPath,
      receipt: receiptPath,
      backupHash: backup.hash,
      targetHash: restored.hash,
      semanticHash: restored.semanticHash,
      rollbackApplied: true,
      externalProviderCalls: 0
    };
  });
}

async function runGeocoding(options = {}) {
  const mode = String(options.mode || "inspect").toLowerCase();
  if (mode === "rollback") return runRollback(options);
  if (!["inspect", "dry-run", "apply"].includes(mode)) {
    throw new Error("mode must be inspect, dry-run, apply, or rollback");
  }
  const env = options.env || process.env;
  const source = await readJsonDocument(options.input, "--input", env);
  validateCompanyMaster(source.value);
  const fixture = mode === "inspect" ? {} : await loadFixtureAdapter(options.fixture, env);

  if (mode === "inspect") {
    const result = await planCompanyMasterGeocoding(source.value, { mode: "inspect" });
    return baseReport(mode, source, result);
  }
  if (mode === "dry-run") {
    const result = await planCompanyMasterGeocoding(source.value, {
      mode,
      adapter: fixture.adapter,
      timeoutMs: options.timeoutMs
    });
    return baseReport(mode, source, result, fixture);
  }

  if (options.confirm !== APPLY_TOKEN) throw new Error(`apply requires --confirm ${APPLY_TOKEN}`);
  const expectedInputHash = requiredSha256(options.expectedInputHash, "--expected-input-hash reported by dry-run");
  const expectedFixtureHash = requiredSha256(options.expectedFixtureHash, "--expected-fixture-hash reported by dry-run");
  const expectedOutputHash = requiredSha256(options.expectedOutputHash, "--expected-output-hash reported by dry-run");
  if (source.hash !== expectedInputHash) {
    throw new Error("input hash does not match the approved dry-run; apply aborted");
  }
  if (fixture.fixtureHash !== expectedFixtureHash) {
    throw new Error("fixture hash does not match the approved dry-run; apply aborted");
  }
  const output = explicitJsonPath(options.output, "--output", env);
  const backup = explicitJsonPath(options.backup, "--backup", env);
  const receipt = explicitJsonPath(options.receipt, "--receipt", env);
  const outputSafe = await assertSafeResolvedPath(output, "--output", env);
  const backupSafe = await assertSafeResolvedPath(backup, "--backup", env);
  const receiptSafe = await assertSafeResolvedPath(receipt, "--receipt", env);
  const canonicalPaths = [source.realTarget, outputSafe.realTarget, backupSafe.realTarget, receiptSafe.realTarget]
    .map((candidate) => path.resolve(candidate));
  const inPlace = sameResolvedPath(source.realTarget, outputSafe.realTarget);
  if (new Set(canonicalPaths).size !== 4 && !inPlace) {
    throw new Error("input, output, backup, and receipt paths must be distinct");
  }
  if (sameResolvedPath(backupSafe.realTarget, source.realTarget)
    || sameResolvedPath(backupSafe.realTarget, outputSafe.realTarget)
    || sameResolvedPath(receiptSafe.realTarget, source.realTarget)
    || sameResolvedPath(receiptSafe.realTarget, outputSafe.realTarget)
    || sameResolvedPath(receiptSafe.realTarget, backupSafe.realTarget)) {
    throw new Error("backup and receipt paths must differ from input and output");
  }
  if ([source.realTarget, outputSafe.realTarget, backupSafe.realTarget, receiptSafe.realTarget]
    .some((candidate) => sameResolvedPath(candidate, fixture.fixtureRealPath))) {
    throw new Error("fixture path must differ from input, output, backup, and receipt");
  }
  if (inPlace && !booleanOption(options.inPlace)) throw new Error("in-place apply requires --in-place true");
  if (await exists(backup)) throw new Error("backup path already exists");
  if (await exists(receipt)) throw new Error("receipt path already exists");
  if (!inPlace && await exists(output)) {
    throw new Error("existing output cannot be overwritten; choose a new output path");
  }

  // Provider/fixture evaluation is deliberately outside the company-master
  // write lock. The approved source, fixture, and output hashes bind this
  // immutable plan; the lock protects only reread/CAS through receipt commit.
  const plannedResult = await planCompanyMasterGeocoding(source.value, {
    mode,
    adapter: fixture.adapter,
    timeoutMs: options.timeoutMs
  });
  assertMigrationInvariants(source.value, plannedResult.master);
  const plannedReport = baseReport(mode, source, plannedResult, fixture);
  if (plannedReport.outputHash !== expectedOutputHash) {
    throw new Error("output plan does not match the approved dry-run; apply aborted");
  }

  const auxiliaryLocks = [backupSafe.realTarget, receiptSafe.realTarget];
  if (!inPlace) auxiliaryLocks.push(source.realTarget);
  return withGeocodingWriteLocks(outputSafe.realTarget, auxiliaryLocks, {
    ...options,
    allowMissingTarget: !inPlace,
    purpose: "geocoding-company-master-apply"
  }, async () => {
    await assertStableSafePath({ target: source.target, realTarget: source.realTarget }, source.target, "--input", env);
    await assertStableSafePath(outputSafe, output, "--output", env);
    await assertStableSafePath(backupSafe, backup, "--backup", env);
    await assertStableSafePath(receiptSafe, receipt, "--receipt", env);
    if (await exists(backupSafe.realTarget)) throw new Error("backup path already exists after acquiring the exclusive lock");
    if (await exists(receiptSafe.realTarget)) throw new Error("receipt path already exists after acquiring the exclusive lock");
    if (!inPlace && await exists(outputSafe.realTarget)) {
      throw new Error("existing output cannot be overwritten after acquiring the exclusive lock");
    }
    const lockedSource = await readJsonDocument(source.target, "--input", env);
    if (lockedSource.hash !== source.hash || lockedSource.hash !== expectedInputHash) {
      throw new Error("input changed after the approved dry-run; apply aborted");
    }
    validateCompanyMaster(lockedSource.value);
    const lockedFixture = await loadFixtureAdapter(options.fixture, env);
    if (lockedFixture.fixtureHash !== fixture.fixtureHash || lockedFixture.fixtureHash !== expectedFixtureHash) {
      throw new Error("fixture changed after the approved dry-run; apply aborted");
    }
    const result = plannedResult;
    assertMigrationInvariants(lockedSource.value, result.master);
    const report = baseReport(mode, lockedSource, result, lockedFixture);
    if (report.outputHash !== expectedOutputHash) {
      throw new Error("output plan does not match the approved dry-run; apply aborted");
    }

    let backupCreated = false;
    let outputCommitted = false;
    let committedOutputHash = "";
    try {
      // Preserve the approved source bytes exactly. This backup is also the
      // compensation image if a later output or receipt commit fails.
      await atomicWriteBuffer(backupSafe.realTarget, lockedSource.raw, { noReplace: true });
      backupCreated = true;
      const persistedBackup = await readJsonDocument(backupSafe.realTarget, "--backup", env);
      if (persistedBackup.hash !== lockedSource.hash || persistedBackup.semanticHash !== lockedSource.semanticHash) {
        throw new Error("backup hash verification failed");
      }

      await atomicWriteJson(outputSafe.realTarget, result.master, { validator: validateCompanyMaster, noReplace: !inPlace });
      outputCommitted = true;
      const persistedOutput = await readJsonDocument(outputSafe.realTarget, "--output", env);
      if (persistedOutput.semanticHash !== report.outputHash) throw new Error("output hash verification failed");
      committedOutputHash = persistedOutput.hash;
      assertMigrationInvariants(lockedSource.value, persistedOutput.value);
      const inputReal = source.realTarget;
      const outputReal = outputSafe.realTarget;
      const backupReal = backupSafe.realTarget;
      const receiptReal = receiptSafe.realTarget;
      const receiptValue = {
        kind: APPLY_RECEIPT_KIND,
        schemaVersion: 1,
        appliedAt: new Date().toISOString(),
        inputPath: inputReal,
        outputPath: outputReal,
        backupPath: backupReal,
        receiptPath: receiptReal,
        inputHash: lockedSource.hash,
        fixtureHash: lockedFixture.fixtureHash,
        outputHash: persistedOutput.hash,
        backupHash: persistedBackup.hash
      };
      if (typeof options.beforeReceiptCommit === "function") {
        await options.beforeReceiptCommit({
          receiptPath: receiptSafe.realTarget,
          outputPath: outputSafe.realTarget,
          backupPath: backupSafe.realTarget
        });
      }
      await atomicWriteJson(receiptSafe.realTarget, receiptValue, { validator: validateApplyReceipt, noReplace: true });
      const receiptHash = hashBuffer(jsonBuffer(receiptValue));
      return {
        ...report,
        output,
        backup,
        receipt,
        receiptHash,
        backupHash: persistedBackup.hash,
        backupSemanticHash: persistedBackup.semanticHash,
        persistedOutputHash: persistedOutput.hash,
        rollbackPossible: true
      };
    } catch (error) {
      let compensationError = null;
      if (outputCommitted) {
        try {
          const currentOutput = await readJsonDocument(outputSafe.realTarget, "--output", env);
          if (!committedOutputHash || currentOutput.hash !== committedOutputHash) {
            throw new Error("output changed before compensation; refusing to overwrite another writer");
          }
          if (inPlace) {
            await atomicWriteBuffer(outputSafe.realTarget, lockedSource.raw);
            const restored = await readJsonDocument(outputSafe.realTarget, "--output", env);
            if (restored.hash !== lockedSource.hash) throw new Error("in-place compensation hash verification failed");
          } else {
            await fsp.rm(outputSafe.realTarget, { force: true });
          }
        } catch (rollbackError) {
          compensationError = rollbackError;
        }
      }
      if (!compensationError && backupCreated) {
        await fsp.rm(backupSafe.realTarget, { force: true }).catch((cleanupError) => {
          compensationError = cleanupError;
        });
      }
      if (compensationError) {
        throw new AggregateError(
          [error, compensationError],
          `geocoding apply failed and compensation was incomplete; verified backup preserved at ${backupSafe.realTarget}`
        );
      }
      throw error;
    }
  });
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith("--")) continue;
    const option = key.slice(2).replace(/-([a-z])/g, (_, char) => char.toUpperCase());
    const next = argv[index + 1];
    options[option] = next && !next.startsWith("--") ? argv[++index] : true;
  }
  return options;
}

if (require.main === module) {
  runGeocoding(parseArgs(process.argv.slice(2)))
    .then((report) => process.stdout.write(`${JSON.stringify(report, null, 2)}\n`))
    .catch((error) => {
      process.stderr.write(`Geocoding blocked: ${error.message}\n`);
      process.exitCode = 1;
    });
}

module.exports = {
  APPLY_TOKEN,
  KOREA_BOUNDS,
  ROLLBACK_TOKEN,
  assertMigrationInvariants,
  assertSafeResolvedPath,
  explicitJsonPath,
  fixturesFromDocument,
  isKoreaLocation,
  planCompanyMasterGeocoding,
  runGeocoding,
  validateCompanyMaster
};
