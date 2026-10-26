"use strict";

// The finite, operator-enabled daily fill is separate from the weekly queue.
// All provider work uses the application's existing KOSIS object and budget.
const fs = require("node:fs/promises"), { constants } = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const { collectionSummary } = require("./regional_market_missing.cjs");
const DIRECTORY = "regional_market_bootstrap", MAX_BYTES = 2 * 1024 * 1024, KST = 9 * 3600000, DAY_MS = 86400000;
const KEYS = ["population", "households", "establishments", "employment", "manufacturing_establishments", "manufacturing_employment"];
const ID = /^[A-Za-z0-9_:-]{1,120}$/, HASH = /^[a-f0-9]{64}$/, UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const DAY = /^20\d{2}-\d{2}-\d{2}$/, PHASES = new Set(["active", "complete", "needs_verification"]), PROGRESS = new Set(["pending", "checking", "available", "needs_verification"]);
const JOBS = new Set(["claimed", "running", "partial", "gated", "complete", "needs_verification"]);
const object = x => x !== null && typeof x === "object" && !Array.isArray(x);
const exact = (x, keys) => object(x) && Object.keys(x).every(key => keys.includes(key)) && keys.every(key => Object.hasOwn(x, key));
const stamp = x => typeof x === "string" && Number.isFinite(Date.parse(x)) && new Date(x).toISOString() === x;
const validDay = x => DAY.test(x || "") && Number.isFinite(Date.parse(x + "T00:00:00Z")) && new Date(x + "T00:00:00Z").toISOString().slice(0, 10) === x;
const dayOf = x => new Date(Number(x) + KST).toISOString().slice(0, 10), dueFor = day => Date.parse(day + "T03:10:00.000Z");
const nextDay = day => new Date(Date.parse(day + "T00:00:00Z") + DAY_MS).toISOString().slice(0, 10);
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex"), copy = x => structuredClone(x);
const fault = (code, statusCode = 503) => Object.assign(new Error(code), { code, statusCode });
const integer = x => Number.isSafeInteger(x) && x >= 0;
const samePath = (a, b) => process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
const inode = s => `${s.dev}:${s.ino}`, identity = s => `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`;
const safeCode = (code, fallback = "BOOTSTRAP_SOURCE_UNAVAILABLE") => typeof code === "string" && /^(?:BOOTSTRAP_|REGIONAL_MARKET_|AUTH_ERROR$|MISSING_KEY$|QUOTA_EXCEEDED$|CACHE_|EVIDENCE_|TIMEOUT$|NETWORK_ERROR$|REFRESH_INCOMPLETE$|COOLDOWN$)[A-Z0-9_]{0,80}$/.test(code) ? code : fallback;
function list(value, length) { return Array.isArray(value) && value.length === length && value.every(key => KEYS.includes(key)) && new Set(value).size === length; }
function normalizeBaseline(bytes, expected, now) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 2 || bytes.length > MAX_BYTES || hash(bytes) !== expected.sha256) throw fault("BOOTSTRAP_BASELINE_HASH_MISMATCH");
  let value; try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { throw fault("BOOTSTRAP_BASELINE_INVALID"); }
  const job = value?.job;
  if (!exact(value, ["schemaVersion", "job"]) || value.schemaVersion !== 1 || !object(job) || job.id !== expected.jobId || job.status !== "blocked" || job.stopReason !== "QUOTA_EXCEEDED"
    || !Array.isArray(job.regions) || job.regions.length !== 95 || job.inventory?.eligibleRegionCount !== 95 || job.inventory?.uniqueRegionCount !== 95
    || job.inventory?.unknownRegionCount !== 0 || job.inventory?.excludedCount !== 0 || job.regions.some(x => !ID.test(x?.regionKey || "")) || new Set(job.regions.map(x => x.regionKey)).size !== 95) throw fault("BOOTSTRAP_BASELINE_INVALID");
  const pending = job.regions.filter(x => x.status === "not_checked" && x.summary === null), complete = job.regions.filter(x => x.status === "complete" && x.projected === true && x.summary?.remaining?.length === 0);
  const held = job.regions.filter(x => x.status === "blocked" && x.summary?.stopReason === "QUOTA_EXCEEDED");
  if (pending.length !== 86 || complete.length !== 8 || held.length !== 1 || !Array.isArray(held[0].summary.remaining) || held[0].summary.remaining.length !== 4) throw fault("BOOTSTRAP_BASELINE_INVALID");
  const keys = held[0].summary.remaining.map(x => x.datasetKey);
  if (!list(keys, 4) || held[0].summary.remaining.some(x => x.status !== "blocked" || x.reasonCode !== "QUOTA_EXCEEDED") || !list(held[0].summary.collectedDatasetKeys, 2)
    || held[0].summary.collectedDatasetKeys.some(key => keys.includes(key)) || new Set([...keys, ...held[0].summary.collectedDatasetKeys]).size !== 6) throw fault("BOOTSTRAP_BASELINE_INVALID");
  return { schemaVersion: 1, sourceJobId: expected.jobId, sourceSha256: expected.sha256, frozenAt: now,
    totalRegionCount: 95, pendingRegionKeys: pending.map(x => x.regionKey), completedRegionKeys: complete.map(x => x.regionKey), initialHeld: { regionKey: held[0].regionKey, datasetKeys: keys } };
}
function validBaseline(value, expected) {
  if (!exact(value, ["schemaVersion", "sourceJobId", "sourceSha256", "frozenAt", "totalRegionCount", "pendingRegionKeys", "completedRegionKeys", "initialHeld"])
    || value.schemaVersion !== 1 || value.sourceJobId !== expected.jobId || value.sourceSha256 !== expected.sha256 || !stamp(value.frozenAt) || value.totalRegionCount !== 95
    || !Array.isArray(value.pendingRegionKeys) || value.pendingRegionKeys.length !== 86 || !Array.isArray(value.completedRegionKeys) || value.completedRegionKeys.length !== 8
    || !exact(value.initialHeld, ["regionKey", "datasetKeys"]) || !ID.test(value.initialHeld.regionKey || "") || !list(value.initialHeld.datasetKeys, 4)) throw fault("BOOTSTRAP_BASELINE_INVALID");
  const all = [...value.pendingRegionKeys, ...value.completedRegionKeys, value.initialHeld.regionKey];
  if (all.some(key => !ID.test(key)) || new Set(all).size !== 95) throw fault("BOOTSTRAP_BASELINE_INVALID"); return value;
}
function summaryOf(value, allowed, currentDay) {
  const summary = collectionSummary(value);
  if (typeof value.localBudgetExhausted !== "boolean" || typeof value.budgetResumeReviewApplied !== "boolean" || value.budgetDay !== null && !validDay(value.budgetDay)
    || value.localBudgetExhausted && (![null, "QUOTA_EXCEEDED"].includes(summary.stopReason) || value.budgetDay !== currentDay)
    || !value.localBudgetExhausted && value.budgetDay !== null || summary.attemptedDatasetKeys.some(key => !allowed.includes(key)) || summary.collectedDatasetKeys.some(key => !allowed.includes(key))) throw fault("BOOTSTRAP_COLLECTION_CONTRACT_INVALID");
  return { ...summary, localBudgetExhausted: value.localBudgetExhausted, budgetDay: value.budgetDay, budgetResumeReviewApplied: value.budgetResumeReviewApplied };
}
function validateState(value, baseline) {
  if (!exact(value, ["schemaVersion", "baselineSha256", "policy", "heldReview", "progress", "latestJob"]) || value.schemaVersion !== 1 || value.baselineSha256 !== hash(JSON.stringify(baseline))
    || !exact(value.policy, ["enabled", "phase", "configuredAt", "firstEligibleDay", "completedAt", "errorCode"]) || typeof value.policy.enabled !== "boolean" || !PHASES.has(value.policy.phase)
    || !stamp(value.policy.configuredAt) || !validDay(value.policy.firstEligibleDay) || value.policy.completedAt !== null && !stamp(value.policy.completedAt)
    || value.policy.errorCode !== null && typeof value.policy.errorCode !== "string" || value.policy.phase !== "active" && value.policy.enabled
    || !exact(value.heldReview, ["consumed", "receiptSha256"]) || typeof value.heldReview.consumed !== "boolean" || value.heldReview.receiptSha256 !== null && !HASH.test(value.heldReview.receiptSha256)
    || !Array.isArray(value.progress) || value.progress.length !== 87) throw fault("BOOTSTRAP_STATE_INVALID");
  const pending = new Set(baseline.pendingRegionKeys);
  for (const item of value.progress) {
    if (!exact(item, ["regionKey", "kind", "allowedDatasetKeys", "status", "summary", "projected", "checkedAt", "reasonCode"])
      || !PROGRESS.has(item.status) || typeof item.projected !== "boolean" || item.checkedAt !== null && !stamp(item.checkedAt) || item.reasonCode !== null && typeof item.reasonCode !== "string"
      || item.kind === "pending_region" && (!pending.has(item.regionKey) || !list(item.allowedDatasetKeys, 6))
      || item.kind === "initial_held" && (item.regionKey !== baseline.initialHeld.regionKey || !list(item.allowedDatasetKeys, 4) || item.allowedDatasetKeys.some(key => !baseline.initialHeld.datasetKeys.includes(key)))
      || !["pending_region", "initial_held"].includes(item.kind)) throw fault("BOOTSTRAP_STATE_INVALID");
    if (item.summary !== null) {
      summaryOf(item.summary, item.allowedDatasetKeys, item.summary.budgetDay || dayOf(Date.parse(item.checkedAt)));
      if (item.status === "available" && (item.summary.remaining.length || !item.projected)) throw fault("BOOTSTRAP_STATE_INVALID");
    } else if (item.status === "available") throw fault("BOOTSTRAP_STATE_INVALID");
  }
  if (new Set(value.progress.map(x => x.regionKey)).size !== 87 || value.progress.filter(x => x.kind === "initial_held").length !== 1) throw fault("BOOTSTRAP_STATE_INVALID");
  const job = value.latestJob;
  if (job !== null && (!exact(job, ["schemaVersion", "id", "day", "status", "claimedAt", "startedAt", "finishedAt", "currentRegionKey", "counts", "stopReason"])
    || job.schemaVersion !== 1 || !UUID.test(job.id || "") || !validDay(job.day) || !JOBS.has(job.status) || !stamp(job.claimedAt)
    || job.startedAt !== null && !stamp(job.startedAt) || job.finishedAt !== null && !stamp(job.finishedAt)
    || job.currentRegionKey !== null && !ID.test(job.currentRegionKey) || job.stopReason !== null && typeof job.stopReason !== "string"
    || !exact(job.counts, ["checkedRegions", "networkAttemptedRegions", "unknownAttemptRegions", "collectedDatasets", "projectedRegions"]) || Object.values(job.counts).some(x => !integer(x)))) throw fault("BOOTSTRAP_STATE_INVALID");
  if (value.policy.phase === "complete" && value.progress.some(x => x.status !== "available" || !x.projected || x.summary?.remaining.length)) throw fault("BOOTSTRAP_STATE_INVALID");
  return value;
}

function createRegionalMarketBootstrapService({ dataDir, readBaseline, expectedBaseline, resolveRegion, kosisService, onRegionChanged, readHeldReview,
  canRun, now = () => new Date(), setIntervalImpl = setInterval, clearIntervalImpl = clearInterval } = {}) {
  if (typeof dataDir !== "string" || !dataDir || [readBaseline, resolveRegion, onRegionChanged, readHeldReview, canRun, now, setIntervalImpl, clearIntervalImpl].some(x => typeof x !== "function")
    || typeof kosisService?.refreshMissingMarketRegion !== "function" || !object(expectedBaseline) || !UUID.test(expectedBaseline.jobId || "") || !HASH.test(expectedBaseline.sha256 || "")) throw new TypeError("Invalid bootstrap options");
  const expected = copy(expectedBaseline), base = path.resolve(dataDir), directory = path.join(base, DIRECTORY);
  let serial = Promise.resolve(), io = Promise.resolve(), worker = null, timer = null, ownedJobId = null, ownedClaimDay = null, ownedLock = false, closed = false, lastGate = null;
  const instant = () => { const result = new Date(now()).getTime(); if (!Number.isFinite(result)) throw fault("BOOTSTRAP_CLOCK_INVALID"); return result; }, timestamp = () => new Date(instant()).toISOString();
  const locked = fn => { const task = serial.then(fn); serial = task.catch(() => {}); return task; }, ioLocked = fn => { const task = io.then(fn); io = task.catch(() => {}); return task; };
  async function inspectDirectory(create = false, days = false) {
    const parent = await fs.lstat(base);
    if (!parent.isDirectory() || parent.isSymbolicLink() || !samePath(await fs.realpath(base), base)) throw fault("BOOTSTRAP_UNSAFE_PATH");
    const checked = [{ file: base, inode: inode(parent) }];
    for (const file of [directory, ...(days ? [path.join(directory, "days")] : [])]) {
      let stat; try { stat = await fs.lstat(file); } catch (error) { if (error.code !== "ENOENT") throw error; if (!create) return null; try { await fs.mkdir(file, { mode: 0o700 }); } catch (creation) { if (creation.code !== "EEXIST") throw creation; } stat = await fs.lstat(file); }
      if (!stat.isDirectory() || stat.isSymbolicLink() || !samePath(await fs.realpath(file), file)) throw fault("BOOTSTRAP_UNSAFE_PATH"); checked.push({ file, inode: inode(stat) });
    }
    return checked;
  }
  async function recheck(checked) { for (const item of checked) { const stat = await fs.lstat(item.file); if (!stat.isDirectory() || stat.isSymbolicLink() || inode(stat) !== item.inode || !samePath(await fs.realpath(item.file), item.file)) throw fault("BOOTSTRAP_UNSAFE_PATH"); } }
  async function syncDirectory(file) {
    let handle;
    try { handle = await fs.open(file, constants.O_RDONLY | (constants.O_DIRECTORY || 0)); await handle.sync(); }
    catch (error) { if (process.platform !== "win32" || !["EINVAL", "EPERM", "EISDIR", "EACCES"].includes(error.code)) throw error; }
    finally { await handle?.close(); }
  }
  async function rawRead(name) {
    const isDay = /^days\/[0-9-]+\.(?:claim|result)\.json$/.test(name); if (!isDay && !["baseline.json", "state.json"].includes(name)) throw fault("BOOTSTRAP_UNSAFE_PATH");
    const checked = await inspectDirectory(false, isDay); if (!checked) return null;
    const file = path.join(directory, ...name.split("/")); let handle;
    try {
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size < 2 || stat.size > MAX_BYTES || !samePath(await fs.realpath(file), file)) throw fault("BOOTSTRAP_FILE_INVALID");
      handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0)); if (identity(await handle.stat()) !== identity(stat)) throw fault("BOOTSTRAP_FILE_CHANGED");
      const bytes = Buffer.alloc(stat.size + 1); let count = 0;
      while (count < bytes.length) { const part = await handle.read(bytes, count, bytes.length - count, count); if (!part.bytesRead) break; count += part.bytesRead; }
      if (count !== stat.size || identity(await handle.stat()) !== identity(stat) || identity(await fs.lstat(file)) !== identity(stat)) throw fault("BOOTSTRAP_FILE_CHANGED"); await recheck(checked);
      try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, count))); } catch { throw fault("BOOTSTRAP_FILE_INVALID"); }
    } catch (error) { if (error.code === "ENOENT" && !handle) return null; throw error; } finally { await handle?.close(); }
  }
  async function rawWrite(name, value, exclusive = false) {
    const isDay = /^days\/[0-9-]+\.(?:claim|result)\.json$/.test(name); if (!isDay && !["baseline.json", "state.json"].includes(name)) throw fault("BOOTSTRAP_UNSAFE_PATH");
    const checked = await inspectDirectory(true, isDay), file = path.join(directory, ...name.split("/")), bytes = JSON.stringify(value);
    if (Buffer.byteLength(bytes) > MAX_BYTES) throw fault("BOOTSTRAP_FILE_INVALID");
    let handle;
    if (exclusive) {
      try { handle = await fs.open(file, "wx", 0o600); await handle.writeFile(bytes); await handle.sync(); await handle.chmod(0o400); await recheck(checked); await syncDirectory(path.dirname(file)); }
      finally { await handle?.close(); } return;
    }
    try { const stat = await fs.lstat(file); if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || !samePath(await fs.realpath(file), file)) throw fault("BOOTSTRAP_UNSAFE_PATH"); } catch (error) { if (error.code !== "ENOENT") throw error; }
    const temporary = path.join(directory, `state-${crypto.randomUUID()}.tmp`);
    try {
      handle = await fs.open(temporary, "wx", 0o600); await handle.writeFile(bytes); await handle.sync(); await handle.close(); handle = null; await recheck(checked);
      for (let attempt = 0; ; attempt++) { try { await fs.rename(temporary, file); break; } catch (error) { if (attempt >= 3 || !["EACCES", "EPERM", "EBUSY"].includes(error.code)) throw error; await new Promise(resolve => setTimeout(resolve, 10 * (attempt + 1))); await recheck(checked); } }
      await recheck(checked); await syncDirectory(path.dirname(file));
    } finally { await handle?.close(); await fs.unlink(temporary).catch(() => {}); }
  }
  const write = (name, value, exclusive = false) => { const snapshot = copy(value); return ioLocked(() => rawWrite(name, snapshot, exclusive)); };
  async function journalIssue(state) {
      const checked = await inspectDirectory(false); if (!checked) return null;
      try {
        const stat = await fs.lstat(path.join(directory, "execution.lock"));
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw fault("BOOTSTRAP_UNSAFE_PATH");
        if (!ownedLock) return "BOOTSTRAP_ORPHAN_LOCK";
      } catch (error) { if (error.code !== "ENOENT") throw error; }
      const days = await inspectDirectory(false, true); if (!days) return null;
      const claims = new Set(), results = new Set(); let count = 0, handle;
      try {
        handle = await fs.opendir(path.join(directory, "days"));
        for await (const entry of handle) {
          if (++count > 800) return "BOOTSTRAP_HISTORY_LIMIT";
          const match = /^(20\d{2}-\d{2}-\d{2})\.(claim|result)\.json$/.exec(entry.name);
          if (!match || !validDay(match[1]) || !entry.isFile() || entry.isSymbolicLink()) return "BOOTSTRAP_HISTORY_INVALID";
          (match[2] === "claim" ? claims : results).add(match[1]);
        }
      } finally { await handle?.close().catch(() => {}); }
      await recheck(days);
      if ([...results].some(day => !claims.has(day)) || [...claims].some(day => !(ownedLock && day === ownedClaimDay) && (!state?.latestJob || day > state.latestJob.day))) return "BOOTSTRAP_ORPHAN_CLAIM";
      if ([...claims].some(day => !results.has(day) && !(ownedLock && day === ownedClaimDay) && !(state?.latestJob?.day === day && ownedJobId === state.latestJob.id))) return "BOOTSTRAP_ORPHAN_CLAIM";
      return null;
  }
  async function load() {
    // Keep both persisted files, journal and in-process ownership in one snapshot.
    // A reader must not compare old state with a writer's later lock transition.
    return ioLocked(async () => {
      const baseline = await rawRead("baseline.json"), state = await rawRead("state.json");
      if (!baseline && !state) return { baseline: null, state: null, issue: await journalIssue(null) };
      if (!baseline || !state) throw fault("BOOTSTRAP_SETUP_INCOMPLETE");
      validBaseline(baseline, expected); validateState(state, baseline);
      const issue = await journalIssue(state) || (state.latestJob && ["claimed", "running"].includes(state.latestJob.status) && state.latestJob.id !== ownedJobId ? "BOOTSTRAP_INTERRUPTED_JOB" : null);
      return { baseline, state, issue };
    });
  }
  async function acquire() {
    return ioLocked(async () => {
    const checked = await inspectDirectory(true), file = path.join(directory, "execution.lock"); let handle;
    try {
      handle = await fs.open(file, "wx", 0o600); await handle.writeFile(JSON.stringify({ schemaVersion: 1, createdAt: timestamp() })); await handle.sync(); const original = await handle.stat(); await recheck(checked); await syncDirectory(directory); ownedLock = true;
      return async () => ioLocked(async () => { try { await recheck(checked); const stat = await fs.lstat(file); if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || inode(stat) !== inode(original)) throw fault("BOOTSTRAP_UNSAFE_PATH"); await fs.unlink(file); await syncDirectory(directory); } finally { ownedLock = false; await handle.close(); } });
    } catch (error) { await handle?.close(); if (error.code === "EEXIST") throw fault("BOOTSTRAP_EXECUTION_LOCKED", 409); throw error; }
    });
  }
  async function gate() {
    try { const value = await canRun(); if (!object(value) || typeof value.allowed !== "boolean" || value.reasonCode !== null && typeof value.reasonCode !== "string") throw Error();
      lastGate = value.allowed ? null : "BOOTSTRAP_EXTERNAL_GATE_HELD"; return value.allowed; }
    catch { lastGate = "BOOTSTRAP_EXTERNAL_GATE_UNKNOWN"; return false; }
  }
  function progressCounts(state) {
    const normal = state.progress.filter(x => x.kind === "pending_region"), held = state.progress.find(x => x.kind === "initial_held"), knownHeld = held.summary && held.summary.status !== "shared_inflight", remaining = knownHeld ? held.summary.remaining : baselineHeldRemaining(held);
    return { initialRegionCount: 86, availableRegions: normal.filter(x => x.status === "available").length, pendingRegions: normal.filter(x => ["pending", "checking"].includes(x.status)).length,
      needsVerificationRegions: normal.filter(x => x.status === "needs_verification").length, initialHeldDatasetCount: 4,
      initialHeldAvailableDatasets: knownHeld ? held.allowedDatasetKeys.filter(key => !remaining.some(x => x.datasetKey === key)).length : 0,
      initialHeldOutstandingDatasets: knownHeld ? remaining.filter(x => held.allowedDatasetKeys.includes(x.datasetKey)).length : 4,
      initialHeldProjectionVerified: held.projected && held.status === "available" };
  }
  function baselineHeldRemaining(item) { return item.allowedDatasetKeys.map(datasetKey => ({ datasetKey })); }
  function presentation(baseline, state, issue = null) {
    if (!state) return { schemaVersion: 1, configured: false, enabled: false, phase: issue ? "needs_verification" : "unconfigured", schedule: { timezone: "Asia/Seoul", hour: 12, minute: 10, tickMs: 30000 }, baseline: null, progress: null, job: null, nextDueAt: null, reasonCode: issue };
    const job = copy(state.latestJob), interrupted = !!issue;
    if (interrupted && job) { job.status = "needs_verification"; job.stopReason = issue || "BOOTSTRAP_INTERRUPTED_JOB"; }
    let next = state.policy.firstEligibleDay; const today = dayOf(instant());
    if (next < today) next = today; if (state.latestJob?.day === today) next = nextDay(today);
    return { schemaVersion: 1, configured: true, enabled: state.policy.enabled && !interrupted, phase: interrupted ? "needs_verification" : state.policy.phase,
      schedule: { timezone: "Asia/Seoul", hour: 12, minute: 10, tickMs: 30000 }, baseline: { sourceJobId: baseline.sourceJobId, sourceSha256: baseline.sourceSha256, totalRegionCount: 95, pendingRegionCount: 86, initialHeldDatasetCount: 4 },
      progress: progressCounts(state), job, nextDueAt: state.policy.enabled && state.policy.phase === "active" && !interrupted ? new Date(dueFor(next)).toISOString() : null,
      reasonCode: issue || (interrupted ? "BOOTSTRAP_INTERRUPTED_JOB" : state.policy.errorCode || lastGate) };
  }
  async function heldReview(baseline) {
    const value = await readHeldReview();
    if (!object(value) || value.schemaVersion !== 1 || value.baselineJobId !== baseline.sourceJobId || value.baselineSha256 !== baseline.sourceSha256
      || value.regionKey !== baseline.initialHeld.regionKey || !list(value.datasetKeys, 4) || value.datasetKeys.some(key => !baseline.initialHeld.datasetKeys.includes(key))
      || value.status !== "reviewed" || !HASH.test(value.reviewReceiptSha256 || "")) throw fault("BOOTSTRAP_HELD_REVIEW_UNVERIFIED");
    const review = value.budgetResumeReview;
    if (!exact(review, ["schemaVersion", "kind", "regionKey", "attemptSha256", "cacheSha256", "datasetKeys", "earliestKstDay", "sourceJobId", "sourceJobSha256", "reviewReceiptSha256"])
      || review.schemaVersion !== 1 || review.kind !== "diagnosed_local_budget" || review.regionKey !== value.regionKey || !HASH.test(review.attemptSha256) || !HASH.test(review.cacheSha256)
      || !list(review.datasetKeys, 4) || review.datasetKeys.some(key => !value.datasetKeys.includes(key)) || !validDay(review.earliestKstDay)
      || review.sourceJobId !== baseline.sourceJobId || review.sourceJobSha256 !== baseline.sourceSha256 || review.reviewReceiptSha256 !== value.reviewReceiptSha256) throw fault("BOOTSTRAP_HELD_REVIEW_UNVERIFIED");
    return copy(value);
  }
  async function run(baseline, state, release) {
    const job = state.latestJob;
    try {
      job.status = "running"; job.startedAt = timestamp(); await write("state.json", state);
      const review = await heldReview(baseline);
      if (state.heldReview.receiptSha256 && state.heldReview.receiptSha256 !== review.reviewReceiptSha256) throw fault("BOOTSTRAP_HELD_REVIEW_CHANGED");
      state.heldReview.receiptSha256 = review.reviewReceiptSha256;
      for (const item of state.progress) {
        if (item.status === "available") continue;
        if (dayOf(instant()) !== job.day) { job.status = "partial"; job.stopReason = "BOOTSTRAP_DAY_CHANGED"; break; }
        if (!await gate()) { job.status = "gated"; job.stopReason = lastGate; break; }
        let region; try { region = await resolveRegion(item.regionKey); } catch { throw fault("BOOTSTRAP_REGION_UNAVAILABLE"); }
        if (!region || region.regionKey !== item.regionKey || region.level !== "local" || region.active !== true || region.selectable !== true || region.unitType === "general_district") throw fault("BOOTSTRAP_REGION_UNAVAILABLE");
        if (item.kind === "initial_held" && dayOf(instant()) < review.budgetResumeReview.earliestKstDay) throw fault("BOOTSTRAP_HELD_REVIEW_TOO_EARLY");
        item.status = "checking"; item.reasonCode = null; job.currentRegionKey = item.regionKey; job.counts.unknownAttemptRegions = 1; await write("state.json", state);
        const options = { allowedDatasetKeys: [...item.allowedDatasetKeys], ...(item.kind === "initial_held" && !state.heldReview.consumed ? { budgetResumeReview: copy(review.budgetResumeReview) } : {}) };
        let value; try { value = await kosisService.refreshMissingMarketRegion(item.regionKey, options); } catch { throw fault("BOOTSTRAP_PROVIDER_ACK_UNKNOWN"); }
        const summary = summaryOf(value?.marketCollection, item.allowedDatasetKeys, job.day);
        item.summary = summary; item.checkedAt = timestamp(); job.counts.checkedRegions++; job.counts.unknownAttemptRegions = 0;
        if (summary.networkAttempted) job.counts.networkAttemptedRegions++; job.counts.collectedDatasets += summary.collectedDatasetKeys.length;
        if (summary.budgetResumeReviewApplied) { if (item.kind !== "initial_held" || state.heldReview.consumed) throw fault("BOOTSTRAP_COLLECTION_CONTRACT_INVALID"); state.heldReview.consumed = true; }
        await write("state.json", state);
        if (summary.status === "shared_inflight") throw fault("BOOTSTRAP_SHARED_INFLIGHT");
        if (summary.changed || !summary.remaining.length) {
          let projected; try { projected = await onRegionChanged(item.regionKey, copy(summary)); } catch { throw fault("BOOTSTRAP_PROJECTION_UNVERIFIED"); }
          if (!object(projected) || projected.verified !== true) throw fault("BOOTSTRAP_PROJECTION_UNVERIFIED"); item.projected = true; job.counts.projectedRegions++;
        }
        if (summary.localBudgetExhausted && summary.budgetDay === job.day) {
          item.status = "pending"; item.reasonCode = "QUOTA_EXCEEDED"; job.status = "partial"; job.stopReason = "BOOTSTRAP_LOCAL_BUDGET_EXHAUSTED"; break;
        }
        if (summary.stopReason) {
          item.status = "pending"; item.reasonCode = summary.stopReason;
          throw fault("BOOTSTRAP_PROVIDER_REQUIRES_REVIEW");
        }
        if (summary.remaining.length || !item.projected || !["complete", "not_needed"].includes(summary.status)) throw fault("BOOTSTRAP_SOURCE_REQUIRES_REVIEW");
        item.status = "available"; item.reasonCode = null; job.currentRegionKey = null; await write("state.json", state);
      }
      if (state.progress.every(item => item.status === "available" && item.projected && item.summary?.remaining.length === 0)) {
        state.policy.phase = "complete"; state.policy.enabled = false; state.policy.completedAt = timestamp(); job.status = "complete"; job.stopReason = null;
      } else if (job.status === "running") throw fault("BOOTSTRAP_INCOMPLETE_WITHOUT_REASON");
    } catch (error) {
      const code = safeCode(error?.code); state.policy.phase = "needs_verification"; state.policy.enabled = false; state.policy.errorCode = code; job.status = "needs_verification"; job.stopReason = code;
      const item = state.progress.find(x => x.regionKey === job.currentRegionKey); if (item) { item.status = "needs_verification"; item.reasonCode = code; }
    }
    try {
      job.finishedAt = timestamp();
      await write(`days/${job.day}.result.json`, { schemaVersion: 1, baselineSha256: state.baselineSha256, job: copy(job), progress: progressCounts(state), heldReviewConsumed: state.heldReview.consumed, phase: state.policy.phase }, true);
      await write("state.json", state);
    } finally { await release().catch(() => {}); ownedJobId = null; ownedClaimDay = null; }
  }
  async function tick() {
    if (closed) return { schemaVersion: 1, phase: "closed", triggered: false };
    return locked(async () => {
      const { baseline, state, issue } = await load(), status = presentation(baseline, state, issue);
      if (!state || !status.enabled || status.phase !== "active" || worker) return { ...status, triggered: false };
      const time = instant(), day = dayOf(time);
      if (day < state.policy.firstEligibleDay || time < dueFor(day) || state.latestJob?.day === day) return { ...status, triggered: false };
      if (state.latestJob && ["claimed", "running"].includes(state.latestJob.status)) return { ...status, triggered: false };
      if (!await gate()) return { ...presentation(baseline, state), triggered: false };
      const release = await acquire(); let started = false;
      try {
        const latest = await load();
        if (latest.issue || latest.state.latestJob?.day === day || ["claimed", "running"].includes(latest.state.latestJob?.status)) return { ...presentation(latest.baseline, latest.state, latest.issue), triggered: false };
        const job = { schemaVersion: 1, id: crypto.randomUUID(), day, status: "claimed", claimedAt: timestamp(), startedAt: null, finishedAt: null, currentRegionKey: null,
          counts: { checkedRegions: 0, networkAttemptedRegions: 0, unknownAttemptRegions: 0, collectedDatasets: 0, projectedRegions: 0 }, stopReason: null };
        ownedClaimDay = day;
        await write(`days/${day}.claim.json`, { schemaVersion: 1, sourceJobId: baseline.sourceJobId, sourceSha256: baseline.sourceSha256, baselineSha256: state.baselineSha256, jobId: job.id, day, claimedAt: job.claimedAt }, true);
        latest.state.latestJob = job; ownedJobId = job.id; await write("state.json", latest.state); started = true;
        worker = new Promise(resolve => setImmediate(resolve)).then(() => run(latest.baseline, latest.state, release)).catch(() => {}).finally(() => { worker = null; });
        return { ...presentation(latest.baseline, latest.state), triggered: true };
      } finally { if (!started) { ownedJobId = null; ownedClaimDay = null; await release(); } }
    });
  }
  return {
    async get() { const { baseline, state, issue } = await load(); return presentation(baseline, state, issue); },
    async configure(input) {
      if (closed || !exact(input, ["enabled"]) || typeof input.enabled !== "boolean") throw fault(closed ? "BOOTSTRAP_CLOSED" : "BOOTSTRAP_INVALID_POLICY", 400);
      return locked(async () => {
        let pair = await load();
        if (pair.issue) throw fault("BOOTSTRAP_OPERATOR_REVIEW_REQUIRED", 409);
        if (worker || ownedJobId || pair.state?.latestJob && ["claimed", "running"].includes(pair.state.latestJob.status)) throw fault("BOOTSTRAP_BUSY", 409);
        if (!pair.state) {
          if (!input.enabled) return presentation(null, null);
          const source = await readBaseline(); if (!exact(source, ["schemaVersion", "bytes"]) || source.schemaVersion !== 1) throw fault("BOOTSTRAP_BASELINE_INVALID");
          const baseline = normalizeBaseline(source.bytes, expected, timestamp());
          await heldReview(baseline);
          const release = await acquire();
          try {
            const state = { schemaVersion: 1, baselineSha256: hash(JSON.stringify(baseline)), policy: { enabled: true, phase: "active", configuredAt: timestamp(), firstEligibleDay: nextDay(dayOf(instant())), completedAt: null, errorCode: null }, heldReview: { consumed: false, receiptSha256: null },
              progress: [{ regionKey: baseline.initialHeld.regionKey, kind: "initial_held", allowedDatasetKeys: [...baseline.initialHeld.datasetKeys], status: "pending", summary: null, projected: false, checkedAt: null, reasonCode: null },
                ...baseline.pendingRegionKeys.map(regionKey => ({ regionKey, kind: "pending_region", allowedDatasetKeys: [...KEYS], status: "pending", summary: null, projected: false, checkedAt: null, reasonCode: null }))], latestJob: null };
            validateState(state, baseline);
            await ioLocked(async () => { await rawWrite("baseline.json", baseline, true); await rawWrite("state.json", state); }); pair = { baseline, state };
          } finally { await release(); }
        } else {
          const shown = presentation(pair.baseline, pair.state, pair.issue);
          if (input.enabled && shown.phase !== "active") throw fault("BOOTSTRAP_OPERATOR_REVIEW_REQUIRED", 409);
          pair.state.policy.enabled = input.enabled; pair.state.policy.configuredAt = timestamp(); await write("state.json", pair.state);
        }
        return presentation(pair.baseline, pair.state);
      });
    },
    tick,
    start() { if (closed || timer !== null) return; timer = setIntervalImpl(() => { void tick().catch(() => {}); }, 30000); timer?.unref?.(); void tick().catch(() => {}); },
    async idle() { await serial; await worker; await io; },
    async close() { closed = true; if (timer !== null) { clearIntervalImpl(timer); timer = null; } await serial; await worker; await io; }
  };
}
module.exports = { createRegionalMarketBootstrapService, normalizeBaseline, MAX_BYTES, DIRECTORY };
