"use strict";

// A single, explicitly requested weekly job. Construction and get() never start
// provider work. Only the application's shared KOSIS instance may collect.
const fs = require("node:fs/promises");
const constants = require("node:fs").constants;
const path = require("node:path");
const crypto = require("node:crypto");
const DIRECTORY = "regional_market_missing", WEEK_MS = 7 * 24 * 3600000;
const MAX_REGIONS = 250, MAX_TARGETS = 10000, MAX_STATE_BYTES = 1024 * 1024;
const REGION = /^[A-Za-z0-9_:-]{1,120}$/, UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const DATASETS = new Set(["population", "households", "establishments", "employment", "manufacturing_establishments", "manufacturing_employment"]);
const METRICS = new Set(["population", "registered_households", "establishments", "employees", "manufacturing_establishments", "manufacturing_employees"]);
const JOB_STATUS = new Set(["queued", "running", "complete", "partial", "failed", "blocked", "needs_verification"]);
const REGION_STATUS = new Set(["pending", "running", "not_checked", "not_needed", "complete", "partial", "blocked", "shared_inflight", "needs_verification"]);
const COLLECTION_STATUS = new Set(["not_needed", "complete", "partial", "blocked", "shared_inflight"]);
const REASONS = new Set(["MISSING_KEY", "NOT_COLLECTED", "INVALID_REGION", "AMBIGUOUS_REGION", "MAPPING_MISSING", "INVALID_RESPONSE", "PERIOD_MISMATCH", "AUTH_ERROR", "QUOTA_EXCEEDED", "TIMEOUT", "NETWORK_ERROR", "CACHE_READ_ERROR", "CACHE_WRITE_ERROR", "EVIDENCE_WRITE_ERROR", "COOLDOWN", "REFRESH_INCOMPLETE", "NO_DATA", "MISSING_VALUES", "REGION_MISMATCH", "SOURCE_UNAVAILABLE", "AVAILABLE", "MISSING", "SUPPRESSED", "UNVERIFIED", "NOT_COLLECTED", "RAW_RESPONSE_NOT_RETAINED", "KOSIS_ORIGINAL_RESPONSE_NOT_FOUND", "STORED_EVIDENCE_UNVERIFIED", "PROVIDER_INFLIGHT", "SHARED_INFLIGHT", "INVALID_TARGET", "INACTIVE_REGION", "UNSUPPORTED_REGION", "INVENTORY_TOO_LARGE", "TARGET_READ_FAILED", "REGION_RESOLUTION_FAILED", "COLLECTION_CONTRACT_INVALID", "COLLECTION_FAILED", "CACHE_PROJECTION_FAILED", "INTERRUPTED_JOB", "JOB_STOPPED"]);
const copy = value => structuredClone(value);
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const only = (value, keys) => object(value) && Object.keys(value).every(key => keys.includes(key));
const exact = (value, keys) => only(value, keys) && keys.every(key => Object.hasOwn(value, key));
const samePath = (a, b) => process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
const inode = stat => [stat.dev, stat.ino].join(":");
const identity = stat => [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(":");
const fault = (code, statusCode = 503) => Object.assign(new Error(code), { code, statusCode });
const safeReason = (value, fallback = "COLLECTION_FAILED") => REASONS.has(value) ? value : fallback;
const stamp = value => typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const integer = value => Number.isSafeInteger(value) && value >= 0;

function datasetList(value) {
  if (!Array.isArray(value) || value.length > 6 || value.some(key => !DATASETS.has(key)) || new Set(value).size !== value.length) throw fault("REGIONAL_MARKET_MISSING_CONTRACT_INVALID");
  return [...value];
}
function itemList(value) {
  if (!Array.isArray(value) || value.length > 6) throw fault("REGIONAL_MARKET_MISSING_CONTRACT_INVALID");
  return value.map(item => {
    if (!object(item) || !DATASETS.has(item.datasetKey) || item.metricKey !== undefined && !METRICS.has(item.metricKey)
      || item.status !== undefined && !["available", "missing", "unverified", "suppressed", "blocked", "not_attempted"].includes(item.status)) throw fault("REGIONAL_MARKET_MISSING_CONTRACT_INVALID");
    return { datasetKey: item.datasetKey, ...(item.metricKey ? { metricKey: item.metricKey } : {}), ...(item.status ? { status: item.status } : {}), reasonCode: item.reasonCode ? safeReason(item.reasonCode, "UNVERIFIED") : null };
  });
}
function collectionSummary(value) {
  if (!object(value) || value.schemaVersion !== 1 || value.mode !== "missing_only" || !COLLECTION_STATUS.has(value.status)
    || typeof value.changed !== "boolean" || typeof value.networkAttempted !== "boolean" || value.stopReason !== null && typeof value.stopReason !== "string") throw fault("REGIONAL_MARKET_MISSING_CONTRACT_INVALID");
  const summary = { schemaVersion: 1, mode: "missing_only", status: value.status,
    attemptedDatasetKeys: datasetList(value.attemptedDatasetKeys), collectedDatasetKeys: datasetList(value.collectedDatasetKeys), eligibleDatasetKeys: datasetList(value.eligibleDatasetKeys),
    skipped: itemList(value.skipped), remaining: itemList(value.remaining),
    changed: value.changed, networkAttempted: value.networkAttempted, stopReason: value.stopReason ? safeReason(value.stopReason) : null };
  if (summary.collectedDatasetKeys.some(key => !summary.attemptedDatasetKeys.includes(key)) || summary.attemptedDatasetKeys.some(key => !summary.eligibleDatasetKeys.includes(key))
    || summary.attemptedDatasetKeys.length > 0 && !summary.networkAttempted || summary.changed && !summary.attemptedDatasetKeys.length || summary.collectedDatasetKeys.length > 0 && !summary.changed
    || summary.status === "not_needed" && (summary.changed || summary.networkAttempted || summary.attemptedDatasetKeys.length || summary.eligibleDatasetKeys.length || summary.remaining.length)) throw fault("REGIONAL_MARKET_MISSING_CONTRACT_INVALID");
  return summary;
}
function validateJob(job) {
  if (!exact(job, ["schemaVersion", "id", "kind", "mode", "status", "queuedAt", "startedAt", "finishedAt", "nextEligibleAt", "inventory", "regions", "excluded", "counts", "stopReason"])
    || job.schemaVersion !== 1 || !UUID.test(job.id || "") || job.kind !== "weekly_missing_market" || job.mode !== "missing_only" || !JOB_STATUS.has(job.status)
    || !stamp(job.queuedAt) || !stamp(job.nextEligibleAt) || Date.parse(job.nextEligibleAt) - Date.parse(job.queuedAt) !== WEEK_MS
    || job.startedAt !== null && !stamp(job.startedAt) || job.finishedAt !== null && !stamp(job.finishedAt)
    || job.stopReason !== null && !REASONS.has(job.stopReason)
    || !exact(job.inventory, ["inputCount", "uniqueRegionCount", "eligibleRegionCount", "unknownRegionCount", "excludedCount"])
    || Object.values(job.inventory).some(value => !integer(value))
    || !Array.isArray(job.regions) || job.regions.length > MAX_REGIONS || !Array.isArray(job.excluded) || job.excluded.length > MAX_REGIONS
    || !exact(job.counts, ["inspectedRegions", "networkAttemptedRegions", "unknownAttemptRegions", "changedRegions", "collectedDatasets", "missingDatasets", "heldDatasets"])
    || Object.values(job.counts).some(value => !integer(value))) throw fault("REGIONAL_MARKET_MISSING_STATE_INVALID");
  for (const item of job.regions) {
    if (!exact(item, ["regionKey", "status", "reasonCode", "summary", "projected"] ) || !REGION.test(item.regionKey || "") || !REGION_STATUS.has(item.status)
      || item.reasonCode !== null && !REASONS.has(item.reasonCode) || typeof item.projected !== "boolean") throw fault("REGIONAL_MARKET_MISSING_STATE_INVALID");
    if (item.summary !== null) collectionSummary(item.summary);
  }
  if (new Set(job.regions.map(item => item.regionKey)).size !== job.regions.length || job.excluded.some(item => !only(item, ["regionKey", "reasonCode"]) || !REGION.test(item.regionKey || "") || !REASONS.has(item.reasonCode))) throw fault("REGIONAL_MARKET_MISSING_STATE_INVALID");
  return job;
}

function createRegionalMarketMissingService({ dataDir, readTargets, resolveRegion, kosisService, onRegionChanged = null, now = () => new Date() } = {}) {
  if (typeof dataDir !== "string" || !dataDir || typeof readTargets !== "function" || typeof resolveRegion !== "function"
    || typeof kosisService?.refreshMissingMarketRegion !== "function" || onRegionChanged !== null && typeof onRegionChanged !== "function" || typeof now !== "function") throw new TypeError("Invalid regional market missing service options");
  const base = path.resolve(dataDir), directory = path.join(base, DIRECTORY), stateFile = path.join(directory, "latest-job.json"), lockFile = path.join(directory, "request.lock");
  let serial = Promise.resolve(), stateIO = Promise.resolve(), worker = null, ownedJobId = null, closed = false;
  const timestamp = () => { const value = new Date(now()); if (!Number.isFinite(value.getTime())) throw fault("REGIONAL_MARKET_MISSING_CLOCK_INVALID"); return value.toISOString(); };
  function locked(fn) { const result = serial.then(fn); serial = result.catch(() => {}); return result; }
  // Reads must not race this instance's own atomic pointer replacement. This
  // gate is separate from request admission and does not hide outside changes.
  function stateLocked(fn) { const result = stateIO.then(fn); stateIO = result.catch(() => {}); return result; }
  async function checkDirectory(create = false) {
    const baseStat = await fs.lstat(base);
    if (!baseStat.isDirectory() || baseStat.isSymbolicLink() || !samePath(await fs.realpath(base), base)) throw fault("REGIONAL_MARKET_MISSING_UNSAFE_PATH");
    let stat;
    try { stat = await fs.lstat(directory); }
    catch (error) {
      if (error.code !== "ENOENT") throw error;
      if (!create) return null;
      try { await fs.mkdir(directory, { mode: 0o700 }); } catch (mkdirError) { if (mkdirError.code !== "EEXIST") throw mkdirError; }
      stat = await fs.lstat(directory);
    }
    if (!stat.isDirectory() || stat.isSymbolicLink() || !samePath(await fs.realpath(directory), directory)) throw fault("REGIONAL_MARKET_MISSING_UNSAFE_PATH");
    return { base: inode(baseStat), directory: inode(stat) };
  }
  async function recheck(checked) {
    const current = await checkDirectory(false);
    if (!current || current.base !== checked.base || current.directory !== checked.directory) throw fault("REGIONAL_MARKET_MISSING_UNSAFE_PATH");
  }
  async function rawRead() {
    const checked = await checkDirectory(false); if (!checked) return null;
    let handle;
    try {
      const before = await fs.lstat(stateFile);
      if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size < 2 || before.size > MAX_STATE_BYTES || !samePath(await fs.realpath(stateFile), stateFile)) throw fault("REGIONAL_MARKET_MISSING_STATE_INVALID");
      handle = await fs.open(stateFile, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
      if (identity(await handle.stat()) !== identity(before)) throw fault("REGIONAL_MARKET_MISSING_STATE_CHANGED");
      const bytes = Buffer.alloc(before.size + 1); let length = 0;
      while (length < bytes.length) { const next = await handle.read(bytes, length, bytes.length - length, length); if (!next.bytesRead) break; length += next.bytesRead; }
      if (length !== before.size || identity(await handle.stat()) !== identity(before) || identity(await fs.lstat(stateFile)) !== identity(before)) throw fault("REGIONAL_MARKET_MISSING_STATE_CHANGED");
      await recheck(checked);
      let value; try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length))); } catch { throw fault("REGIONAL_MARKET_MISSING_STATE_INVALID"); }
      if (!exact(value, ["schemaVersion", "job"]) || value.schemaVersion !== 1) throw fault("REGIONAL_MARKET_MISSING_STATE_INVALID");
      return validateJob(value.job);
    } catch (error) { if (error.code === "ENOENT" && !handle) return null; throw error; }
    finally { await handle?.close(); }
  }
  async function rawSave(job) {
    validateJob(job);
    const checked = await checkDirectory(false); if (!checked) throw fault("REGIONAL_MARKET_MISSING_UNSAFE_PATH");
    try { const existing = await fs.lstat(stateFile); if (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1 || !samePath(await fs.realpath(stateFile), stateFile)) throw fault("REGIONAL_MARKET_MISSING_UNSAFE_PATH"); } catch (error) { if (error.code !== "ENOENT") throw error; }
    const bytes = JSON.stringify({ schemaVersion: 1, job }); if (Buffer.byteLength(bytes) > MAX_STATE_BYTES) throw fault("REGIONAL_MARKET_MISSING_STATE_INVALID");
    const temporary = path.join(directory, `job-${crypto.randomUUID()}.tmp`); let handle;
    try {
      handle = await fs.open(temporary, "wx", 0o600); await handle.writeFile(bytes); await handle.sync(); await handle.close(); handle = null;
      await recheck(checked);
      // Windows can temporarily deny replacement while a cache-only reader has
      // the previous file open. Retrying this rename never replays collection.
      for (let attempt = 0; ; attempt++) {
        try { await fs.rename(temporary, stateFile); break; }
        catch (error) { if (attempt >= 3 || !["EACCES", "EPERM", "EBUSY"].includes(error.code)) throw error; await new Promise(resolve => setTimeout(resolve, 10 * (attempt + 1))); await recheck(checked); }
      }
      await recheck(checked);
    } finally { await handle?.close(); await fs.unlink(temporary).catch(() => {}); }
  }
  function read() { return stateLocked(rawRead); }
  function save(job) { const snapshot = copy(job); return stateLocked(() => rawSave(snapshot)); }
  function visible(job) {
    const result = copy(job);
    if (result && ["queued", "running"].includes(result.status) && result.id !== ownedJobId) {
      result.status = "needs_verification"; result.stopReason = "INTERRUPTED_JOB";
    }
    return result;
  }
  async function acquire() {
    const checked = await checkDirectory(true); let handle;
    try {
      handle = await fs.open(lockFile, "wx", 0o600); await handle.writeFile(JSON.stringify({ schemaVersion: 1, createdAt: timestamp() })); await handle.sync();
      const stat = await handle.stat(); await recheck(checked);
      return async () => {
        try { await recheck(checked); const current = await fs.lstat(lockFile); if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1 || inode(current) !== inode(stat)) throw fault("REGIONAL_MARKET_MISSING_UNSAFE_PATH"); await fs.unlink(lockFile); }
        finally { await handle.close(); }
      };
    } catch (error) { await handle?.close(); if (error.code === "EEXIST") throw fault("REGIONAL_MARKET_MISSING_LOCKED", 409); throw error; }
  }
  function count(job) {
    const summaries = job.regions.map(item => item.summary).filter(Boolean);
    job.counts = { inspectedRegions: summaries.length, networkAttemptedRegions: summaries.filter(item => item.networkAttempted).length,
      unknownAttemptRegions: job.regions.filter(item => item.summary === null && ["running", "needs_verification"].includes(item.status)).length,
      changedRegions: summaries.filter(item => item.changed).length, collectedDatasets: summaries.reduce((sum, item) => sum + item.collectedDatasetKeys.length, 0),
      missingDatasets: summaries.reduce((sum, item) => sum + item.remaining.filter(value => value.status === "missing").length, 0),
      heldDatasets: summaries.reduce((sum, item) => sum + new Set([...item.skipped, ...item.remaining].filter(value => ["unverified", "suppressed", "blocked"].includes(value.status)).map(value => value.datasetKey)).size, 0) };
  }
  async function run(job, release) {
    try {
      job.status = "running"; job.startedAt = timestamp(); await save(job);
      let targets; try { targets = await readTargets(); } catch { throw fault("TARGET_READ_FAILED"); }
      if (!Array.isArray(targets) || targets.length > MAX_TARGETS) throw fault("INVENTORY_TOO_LARGE");
      const valid = targets.filter(key => typeof key === "string" && REGION.test(key)), unique = [...new Set(valid)].sort();
      job.inventory.inputCount = targets.length; job.inventory.uniqueRegionCount = unique.length; job.inventory.unknownRegionCount = targets.length - valid.length;
      if (unique.length > MAX_REGIONS) throw fault("INVENTORY_TOO_LARGE");
      for (const regionKey of unique) {
        let region; try { region = await resolveRegion(regionKey); } catch { throw fault("REGION_RESOLUTION_FAILED"); }
        if (!object(region) || region.regionKey !== regionKey) { job.excluded.push({ regionKey, reasonCode: "INVALID_REGION" }); continue; }
        if (region.active !== true || region.selectable !== true) { job.excluded.push({ regionKey, reasonCode: "INACTIVE_REGION" }); continue; }
        if (region.level !== "local" || region.unitType === "general_district" || !/^\d{5}(?:\d{5})?$/.test(String(region.officialCode || ""))) { job.excluded.push({ regionKey, reasonCode: "UNSUPPORTED_REGION" }); continue; }
        job.regions.push({ regionKey, status: "pending", reasonCode: null, summary: null, projected: false });
      }
      job.inventory.eligibleRegionCount = job.regions.length; job.inventory.excludedCount = job.excluded.length; await save(job);
      for (const item of job.regions) {
        item.status = "running"; count(job); await save(job);
        let value; try { value = await kosisService.refreshMissingMarketRegion(item.regionKey); } catch (error) { item.status = "needs_verification"; item.reasonCode = safeReason(error?.code); throw fault(item.reasonCode); }
        try { item.summary = collectionSummary(value?.marketCollection); } catch { item.status = "needs_verification"; item.reasonCode = "COLLECTION_CONTRACT_INVALID"; throw fault(item.reasonCode); }
        item.status = item.summary.status; item.reasonCode = item.summary.stopReason; count(job); await save(job);
        if (item.summary.stopReason || item.status === "shared_inflight") { job.stopReason = item.summary.stopReason || "SHARED_INFLIGHT"; break; }
        if (onRegionChanged) {
          try { await onRegionChanged(item.regionKey, copy(item.summary)); item.projected = true; await save(job); }
          catch { item.reasonCode = "CACHE_PROJECTION_FAILED"; throw fault(item.reasonCode); }
        }
      }
      for (const item of job.regions) if (item.status === "pending") { item.status = "not_checked"; item.reasonCode = job.stopReason || "JOB_STOPPED"; }
      count(job);
      const held = job.inventory.unknownRegionCount || job.excluded.length || job.regions.some(item => !["complete", "not_needed"].includes(item.status) || item.summary?.remaining.length || item.summary?.skipped.some(value => value.status !== "available"));
      job.status = job.stopReason ? "blocked" : held ? "partial" : "complete";
      job.finishedAt = timestamp(); await save(job);
    } catch (error) {
      job.stopReason = safeReason(error?.code, "COLLECTION_FAILED");
      job.status = ["COLLECTION_CONTRACT_INVALID", "CACHE_PROJECTION_FAILED", "REGION_RESOLUTION_FAILED", "TARGET_READ_FAILED"].includes(job.stopReason) ? "needs_verification" : "failed";
      job.finishedAt = timestamp();
      for (const item of job.regions) if (["pending", "running"].includes(item.status)) { item.status = "not_checked"; item.reasonCode = job.stopReason; }
      count(job); await save(job).catch(() => {});
    } finally { await release().catch(() => {}); ownedJobId = null; }
  }
  return {
    async get() { return { schemaVersion: 1, intervalHours: 168, maxRegions: MAX_REGIONS, job: visible(await read()) }; },
    async request(input = {}) {
      if (!only(input, []) || closed) throw fault(closed ? "REGIONAL_MARKET_MISSING_CLOSED" : "REGIONAL_MARKET_MISSING_INVALID_REQUEST", closed ? 503 : 400);
      return locked(async () => {
        const prior = await read();
        if (prior && (["queued", "running"].includes(prior.status) || Date.parse(timestamp()) < Date.parse(prior.nextEligibleAt))) return { job: visible(prior), reused: true };
        const release = await acquire(); let started = false;
        try {
          const latest = await read();
          if (latest && (["queued", "running"].includes(latest.status) || Date.parse(timestamp()) < Date.parse(latest.nextEligibleAt))) return { job: visible(latest), reused: true };
          const queuedAt = timestamp(), job = { schemaVersion: 1, id: crypto.randomUUID(), kind: "weekly_missing_market", mode: "missing_only", status: "queued", queuedAt, startedAt: null, finishedAt: null,
            nextEligibleAt: new Date(Date.parse(queuedAt) + WEEK_MS).toISOString(), inventory: { inputCount: 0, uniqueRegionCount: 0, eligibleRegionCount: 0, unknownRegionCount: 0, excludedCount: 0 }, regions: [], excluded: [],
            counts: { inspectedRegions: 0, networkAttemptedRegions: 0, unknownAttemptRegions: 0, changedRegions: 0, collectedDatasets: 0, missingDatasets: 0, heldDatasets: 0 }, stopReason: null };
          await save(job); ownedJobId = job.id; started = true;
          worker = new Promise(resolve => setImmediate(resolve)).then(() => run(job, release)).finally(() => { worker = null; });
          return { job: copy(job), reused: false };
        } finally { if (!started) await release(); }
      });
    },
    async idle() { await serial; await worker; },
    async close() { closed = true; await serial; await worker; }
  };
}
module.exports = { createRegionalMarketMissingService, WEEK_MS, MAX_REGIONS, MAX_STATE_BYTES, collectionSummary };
