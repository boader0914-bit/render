"use strict";

const fs = require("node:fs/promises");
const { constants } = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { normalizeKeyword } = require("./search_demand_model.cjs");

const SAFE_CODE = /^[A-Z][A-Z0-9_]{1,99}$/;
const SCOPE = /^sdscope_[a-f0-9]{64}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const MAX_JSON = 64 * 1024;
const clone = value => JSON.parse(JSON.stringify(value));
const problem = code => Object.assign(new Error("검색 수요 수집 기록을 확인해 주세요."), { code });
const safeCode = error => SAFE_CODE.test(error?.code || "") ? error.code : "SEARCH_DEMAND_STORAGE_UNAVAILABLE";
const sha = value => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
function kstParts(instant) {
  const value = new Date(new Date(instant).getTime() + 9 * 3600000).toISOString();
  return { day: value.slice(0, 10), month: value.slice(0, 7), date: Number(value.slice(8, 10)), time: value.slice(11, 16) };
}
function nextDay(day) { return new Date(Date.parse(`${day}T00:00:00.000Z`) + 86400000).toISOString().slice(0, 10); }
function trendRange(month) {
  const [year, value] = month.split("-").map(Number), end = new Date(Date.UTC(year, value - 1, 0));
  return { startDate: new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - 11, 1)).toISOString().slice(0, 10),
    endDate: end.toISOString().slice(0, 10), timeUnit: "month" };
}
function sameStat(first, second) { return ["dev", "ino", "size", "mtimeMs", "ctimeMs"].every(key => first[key] === second[key]); }
function validIso(value) { return typeof value === "string" && ISO.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value; }
function validJob(record) {
  try {
    return Boolean(record && record.schemaVersion === 1 && /^sdjob_[a-f0-9]{64}$/.test(record.jobId || "")
      && ["searchad", "datalab"].includes(record.provider) && SCOPE.test(record.scopeId || "") && /^kw_[a-f0-9]{64}$/.test(record.keywordId || "")
      && normalizeKeyword(record.keyword).keywordId === record.keywordId && validIso(record.createdAt) && validIso(record.updatedAt)
      && (!record.observedAt || validIso(record.observedAt)) && (!record.lastAttemptDay || /^20\d{2}-\d{2}-\d{2}$/.test(record.lastAttemptDay))
      && typeof record.period === "string" && /^20\d{2}-\d{2}(?:-\d{2})?$/.test(record.period)
      && ["scheduledAt", "startedAt", "finishedAt"].every(field => record[field] == null || validIso(record[field]))
      && Number.isSafeInteger(record.attempts) && record.attempts >= 0 && record.attempts <= (record.provider === "searchad" ? 1 : 3)
      && (record.requestCount == null || Number.isSafeInteger(record.requestCount) && record.requestCount >= 0 && record.requestCount <= record.attempts)
      && (record.lastRequestCount == null || [0, 1].includes(record.lastRequestCount))
      && ["queued", "running", "complete", "held", "failed", "blocked", "needs_verification"].includes(record.status)
      && (!record.errorCode || SAFE_CODE.test(record.errorCode)) && (!record.postprocessErrorCode || SAFE_CODE.test(record.postprocessErrorCode))
      && (record.postprocessStatus == null || ["complete", "held"].includes(record.postprocessStatus))
      && (record.snapshotId == null || /^sd_[a-f0-9]{64}$/.test(record.snapshotId))
      && (record.status !== "complete" || /^sd_[a-f0-9]{64}$/.test(record.snapshotId || "")));
  } catch { return false; }
}

function createSearchDemandScheduler({ rootDir, store, providers, readRegisteredKeywords, clock = Date.now, enabled = false,
  dailyAt = "09:30", monthlyDay = 2, monthlyAt = "08:30", dailyLimits = { searchad: 50, datalab: 50 }, maxTrendAttempts = 3,
  intervalMs = 60000, maxKeywords = 100, getEnabled = null, onSnapshotCommitted = async () => ({ status: "held", reasonCode: "SEARCH_DEMAND_POSTPROCESS_NOT_CONFIGURED" }) } = {}) {
  if (typeof rootDir !== "string" || !path.isAbsolute(rootDir) || !store || typeof store.saveSnapshot !== "function" || !providers || typeof providers.searchad !== "function"
    || typeof providers.datalab !== "function" || typeof providers.credentialScope !== "function" || typeof readRegisteredKeywords !== "function"
    || typeof clock !== "function" || typeof onSnapshotCommitted !== "function" || typeof enabled !== "boolean" || getEnabled !== null && typeof getEnabled !== "function" || dailyAt !== "09:30"
    || monthlyDay !== 2 || monthlyAt !== "08:30" || !Number.isSafeInteger(maxTrendAttempts) || maxTrendAttempts < 1 || maxTrendAttempts > 3
    || !Number.isSafeInteger(intervalMs) || intervalMs < 1000 || !Number.isSafeInteger(maxKeywords) || maxKeywords < 1 || maxKeywords > 100) throw new TypeError("Invalid search demand scheduler dependencies");
  const limits = {};
  for (const provider of ["searchad", "datalab"]) {
    const value = dailyLimits[provider];
    if (!Number.isSafeInteger(value) || value < 1 || value > 100) throw new TypeError("Invalid search demand daily budget");
    limits[provider] = value;
  }
  const root = path.resolve(rootDir), directory = path.join(root, "scheduler"), lockPath = path.join(directory, "tick.lock");
  let tickPromise = null, timer = null, stopped = false;
  const memory = { enabled: getEnabled ? false : enabled, running: false, lastTickAt: null, lastReason: getEnabled ? "SEARCH_DEMAND_ACTIVATION_NOT_CHECKED" : enabled ? "NOT_STARTED" : "DISABLED", jobs: [],
    activation: getEnabled ? { enabled: false, status: "not_checked", reasonCode: "SEARCH_DEMAND_ACTIVATION_NOT_CHECKED" } : null,
    cohorts: { searchad: null, datalab: null },
    providers: { searchad: { protected: false, errorCode: null }, datalab: { protected: false, errorCode: null } } };
  const now = () => new Date(clock()).toISOString();
  async function runtimeEnabled() {
    if (stopped) return false;
    if (!getEnabled) { memory.enabled = enabled; return enabled; }
    let approval;
    try {
      const value = await getEnabled();
      approval = typeof value === "boolean" ? { enabled: value, status: value ? "ready" : "disabled" } : value;
      if (!approval || typeof approval !== "object" || typeof approval.enabled !== "boolean") throw problem("SEARCH_DEMAND_ACTIVATION_UNVERIFIED");
      const reasonCode = SAFE_CODE.test(approval.reasonCode || "") ? approval.reasonCode
        : approval.enabled ? "SEARCH_DEMAND_ACTIVATION_APPROVED" : "SEARCH_DEMAND_ACTIVATION_DISABLED";
      memory.activation = { enabled: approval.enabled,
        status: ["ready", "disabled", "waiting", "missing", "unavailable"].includes(approval.status) ? approval.status : approval.enabled ? "ready" : "disabled", reasonCode,
        approvedAt: validIso(approval.approvedAt) ? approval.approvedAt : null,
        notBeforeDay: typeof approval.notBeforeDay === "string" && /^20\d{2}-\d{2}-\d{2}$/.test(approval.notBeforeDay) ? approval.notBeforeDay : null,
        scheduleVersion: approval.scheduleVersion === "search-demand-schedule-v1" ? approval.scheduleVersion : null };
      memory.enabled = approval.enabled && !stopped;
      if (!memory.enabled) memory.lastReason = reasonCode;
      return memory.enabled;
    } catch {
      memory.enabled = false;
      memory.activation = { enabled: false, status: "unavailable", reasonCode: "SEARCH_DEMAND_ACTIVATION_UNAVAILABLE" };
      memory.lastReason = memory.activation.reasonCode;
      return false;
    }
  }
  async function ensureDirectory(location) {
    const relative = path.relative(root, location);
    if (relative.startsWith("..") || path.isAbsolute(relative)) throw problem("SEARCH_DEMAND_PATH_UNSAFE");
    const parsed = path.parse(path.resolve(location));
    let current = parsed.root;
    for (const part of path.resolve(location).slice(parsed.root.length).split(path.sep).filter(Boolean)) {
      current = path.join(current, part);
      let metadata;
      try { metadata = await fs.lstat(current); }
      catch (error) {
        if (error.code !== "ENOENT") throw error;
        try { await fs.mkdir(current); } catch (createError) { if (createError.code !== "EEXIST") throw createError; }
        metadata = await fs.lstat(current);
      }
      if (!metadata.isDirectory() || metadata.isSymbolicLink() || await fs.realpath(current) !== path.resolve(current)) throw problem("SEARCH_DEMAND_PATH_UNSAFE");
    }
  }
  async function readParents(file) {
    const relative = path.relative(root, file);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw problem("SEARCH_DEMAND_PATH_UNSAFE");
    const parent = path.dirname(path.resolve(file)), parsed = path.parse(parent), entries = [];
    let current = parsed.root;
    for (const part of ["", ...parent.slice(parsed.root.length).split(path.sep).filter(Boolean)]) {
      if (part) current = path.join(current, part);
      const metadata = await fs.lstat(current), real = await fs.realpath(current);
      if (!metadata.isDirectory() || metadata.isSymbolicLink() || real !== path.resolve(current)) throw problem("SEARCH_DEMAND_PATH_UNSAFE");
      entries.push({ location: current, metadata, real });
    }
    return entries;
  }
  async function verifyParents(entries) {
    for (const entry of entries) {
      let metadata, real;
      try { metadata = await fs.lstat(entry.location); real = await fs.realpath(entry.location); }
      catch { throw problem("SEARCH_DEMAND_EVIDENCE_CHANGED"); }
      if (!metadata.isDirectory() || metadata.isSymbolicLink() || real !== path.resolve(entry.location)) throw problem("SEARCH_DEMAND_PATH_UNSAFE");
      if (real !== entry.real || ["dev", "ino", "mode"].some(field => metadata[field] !== entry.metadata[field])) throw problem("SEARCH_DEMAND_EVIDENCE_CHANGED");
    }
  }
  async function readJson(file, missing = null) {
    let handle, parents = [];
    try {
      parents = await readParents(file);
      const before = await fs.lstat(file);
      if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > MAX_JSON) throw problem("SEARCH_DEMAND_RECORD_UNSAFE");
      handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
      if (!sameStat(before, await handle.stat())) throw problem("SEARCH_DEMAND_EVIDENCE_CHANGED");
      const bytes = await handle.readFile();
      if (bytes.length > MAX_JSON || !sameStat(before, await handle.stat()) || !sameStat(before, await fs.lstat(file))) throw problem("SEARCH_DEMAND_EVIDENCE_CHANGED");
      await verifyParents(parents);
      return JSON.parse(bytes.toString("utf8"));
    } catch (error) { if (error.code === "ENOENT") { await verifyParents(parents); return missing; } throw error; }
    finally { await handle?.close(); }
  }
  async function createJson(file, value) {
    const text = JSON.stringify(value) + "\n";
    if (Buffer.byteLength(text) > MAX_JSON) throw problem("SEARCH_DEMAND_RECORD_TOO_LARGE");
    await ensureDirectory(path.dirname(file));
    const handle = await fs.open(file, "wx", 0o600);
    try { await handle.writeFile(text); await handle.sync(); } finally { await handle.close(); }
  }
  async function replaceJson(file, value) {
    const existing = await readJson(file);
    if (!existing) return createJson(file, value);
    const temp = `${file}.${crypto.randomUUID()}.tmp`;
    try { await createJson(temp, value); await readJson(file); await fs.rename(temp, file); }
    finally { await fs.unlink(temp).catch(() => {}); }
  }
  async function withLock(work) {
    await ensureDirectory(directory);
    const owner = crypto.randomUUID();
    try { await createJson(lockPath, { schemaVersion: 1, owner, createdAt: now() }); }
    catch (error) {
      if (error.code === "EEXIST") {
        const existing = await readJson(lockPath);
        const age = Date.parse(now()) - Date.parse(existing?.createdAt || "");
        return { skipped: true, reason: Number.isFinite(age) && age > 20 * 60000 ? "SEARCH_DEMAND_LOCK_REVIEW_REQUIRED" : "SEARCH_DEMAND_BUSY" };
      }
      throw error;
    }
    try { return await work(); }
    finally {
      const existing = await readJson(lockPath).catch(() => null);
      if (existing?.owner === owner) await fs.unlink(lockPath);
    }
  }
  async function registeredCohort(provider, period) {
    const file = path.join(directory, "cohorts", `${provider}_${period}.json`);
    let cohort = await readJson(file);
    if (!cohort) {
      const raw = await readRegisteredKeywords();
      if (!Array.isArray(raw) || raw.length > maxKeywords) throw problem("SEARCH_DEMAND_KEYWORDS_UNVERIFIED");
      const identities = new Map();
      for (const keyword of raw) { const identity = normalizeKeyword(keyword); identities.set(identity.keywordId, identity); }
      cohort = { schemaVersion: 1, provider, period, capturedAt: now(), keywords: [...identities.values()].map(identity => ({ keyword: identity.keyword, keywordId: identity.keywordId })) };
      cohort.cohortId = "sdcohort_" + sha(["search-demand-cohort-v1", provider, period, cohort.keywords]);
      await createJson(file, cohort);
    }
    if (cohort.schemaVersion !== 1 || cohort.provider !== provider || cohort.period !== period || !validIso(cohort.capturedAt)
      || !Array.isArray(cohort.keywords) || cohort.keywords.length > maxKeywords
      || cohort.keywords.some(identity => !identity || normalizeKeyword(identity.keyword).keywordId !== identity.keywordId)
      || new Set(cohort.keywords.map(identity => identity.keywordId)).size !== cohort.keywords.length
      || cohort.cohortId !== "sdcohort_" + sha(["search-demand-cohort-v1", provider, period, cohort.keywords])) throw problem("SEARCH_DEMAND_COHORT_UNVERIFIED");
    memory.cohorts[provider] = { period, capturedAt: cohort.capturedAt, keywordCount: cohort.keywords.length };
    return cohort.keywords;
  }
  async function verifyStoredSnapshot(record) {
    if (typeof store.readSnapshot !== "function") return;
    const snapshot = await store.readSnapshot({ snapshotId: record.snapshotId });
    if (!snapshot || snapshot.snapshotId !== record.snapshotId || snapshot.provider !== record.provider || snapshot.keywordId !== record.keywordId
      || snapshot.scopeId !== record.scopeId) throw problem("SEARCH_DEMAND_SNAPSHOT_BINDING_UNVERIFIED");
  }
  function publicJob(record) {
    return { jobId: record.jobId, provider: record.provider, keyword: record.keyword, period: record.period, status: record.status,
      attempts: record.attempts, errorCode: record.errorCode || null, snapshotId: record.snapshotId || null,
      observedAt: record.observedAt || null, nextRetryDay: record.nextRetryDay || null,
      createdAt: record.createdAt || null, updatedAt: record.updatedAt || null, lastAttemptDay: record.lastAttemptDay || null,
      scheduledAt: record.scheduledAt || null, startedAt: record.startedAt || null, finishedAt: record.finishedAt || null,
      requestCount: Number.isSafeInteger(record.requestCount) && record.requestCount >= 0 ? record.requestCount : null,
      lastRequestCount: Number.isSafeInteger(record.lastRequestCount) && record.lastRequestCount >= 0 ? record.lastRequestCount : null,
      postprocessStatus: record.postprocessStatus || null, postprocessErrorCode: record.postprocessErrorCode || null };
  }
  async function history({ keyword, day, limit = 100 } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 0 || limit > 200 || day !== undefined && (!/^20\d{2}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(day)
      || new Date(`${day}T00:00:00.000Z`).toISOString().slice(0, 10) !== day)) throw problem("SEARCH_DEMAND_HISTORY_INPUT_INVALID");
    const keywordId = keyword === undefined ? null : normalizeKeyword(keyword).keywordId;
    const jobsDir = path.join(directory, "jobs");
    try {
      const parsed = path.parse(jobsDir); let current = parsed.root;
      for (const part of jobsDir.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
        current = path.join(current, part);
        const metadata = await fs.lstat(current);
        if (!metadata.isDirectory() || metadata.isSymbolicLink() || await fs.realpath(current) !== path.resolve(current)) throw problem("SEARCH_DEMAND_PATH_UNSAFE");
      }
      const all = (await fs.readdir(jobsDir)).filter(name => /^sdjob_[a-f0-9]{64}\.json$/.test(name)).sort();
      const names = all.slice(0, 5000), items = [];
      for (const name of names) {
        const record = await readJson(path.join(jobsDir, name));
        if (!validJob(record) || name !== `${record.jobId}.json`) throw problem("SEARCH_DEMAND_JOB_UNVERIFIED");
        if (keywordId && record.keywordId !== keywordId || day && record.lastAttemptDay !== day) continue;
        items.push(publicJob(record));
      }
      items.sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")) || a.jobId.localeCompare(b.jobId));
      return { status: "ready", items: items.slice(0, limit), scanned: names.length, truncated: all.length > names.length || items.length > limit };
    } catch (error) {
      if (error.code === "ENOENT") return { status: "missing", items: [], scanned: 0, truncated: false };
      return { status: "unavailable", items: [], scanned: 0, truncated: false, errorCode: safeCode(error) };
    }
  }
  async function execute(provider, identity, scope, period, conditions, parts) {
    const jobId = "sdjob_" + sha(["search-demand-job-v1", provider, scope.scopeId, identity.keywordId, conditions, period]);
    if (!await runtimeEnabled()) return { jobId, provider, keyword: identity.keyword, period, status: "held", attempts: 0, errorCode: "SEARCH_DEMAND_ACTIVATION_STOPPED" };
    if (kstParts(now()).day !== parts.day) return { jobId, provider, keyword: identity.keyword, period, status: "held", attempts: 0, errorCode: "SEARCH_DEMAND_DAY_CHANGED" };
    const file = path.join(directory, "jobs", `${jobId}.json`), protectionFile = path.join(directory, "protection", `${provider}_${scope.scopeId}.json`);
    const protection = await readJson(protectionFile);
    if (protection) {
      if (protection.schemaVersion !== 1 || protection.provider !== provider || protection.scopeId !== scope.scopeId
        || !["AUTH_ERROR", "QUOTA_EXCEEDED"].includes(protection.errorCode)) throw problem("SEARCH_DEMAND_PROTECTION_UNVERIFIED");
      memory.providers[provider] = { protected: true, errorCode: protection.errorCode };
      return { jobId, provider, keyword: identity.keyword, period, status: "blocked", attempts: 0, errorCode: protection.errorCode };
    }
    let record = await readJson(file);
    if (record && (!validJob(record) || record.jobId !== jobId || record.provider !== provider || record.scopeId !== scope.scopeId
      || record.keywordId !== identity.keywordId || record.period !== period || record.attempts > (provider === "searchad" ? 1 : maxTrendAttempts))) throw problem("SEARCH_DEMAND_JOB_UNVERIFIED");
    if (record?.status === "running") {
      record = { ...record, status: "needs_verification", errorCode: "SEARCH_DEMAND_INTERRUPTED_CLAIM", updatedAt: now() };
      await replaceJson(file, record); return publicJob(record);
    }
    if (record?.status === "complete") {
      try { await verifyStoredSnapshot(record); }
      catch {
        record = { ...record, status: "needs_verification", errorCode: "SEARCH_DEMAND_SNAPSHOT_BINDING_UNVERIFIED", updatedAt: now() };
        await replaceJson(file, record); return publicJob(record);
      }
    }
    if (record && (record.status === "complete" || record.status === "needs_verification" || record.status === "blocked"
      || record.lastAttemptDay === parts.day || provider === "searchad" || record.attempts >= maxTrendAttempts
      || record.attempts > 0 && record.errorCode !== "INCOMPLETE_DATA"
      || record.nextRetryDay && record.nextRetryDay > parts.day)) return publicJob(record);
    const budgetFile = path.join(directory, "budgets", `${provider}_${parts.day}.json`);
    const budget = await readJson(budgetFile, { schemaVersion: 1, provider, day: parts.day, count: 0 });
    if (budget.schemaVersion !== 1 || budget.provider !== provider || budget.day !== parts.day || !Number.isSafeInteger(budget.count)
      || budget.count < 0 || budget.count > 100) throw problem("SEARCH_DEMAND_BUDGET_UNVERIFIED");
    if (budget.count >= limits[provider]) return { jobId, provider, keyword: identity.keyword, period, status: "held", attempts: record?.attempts || 0, errorCode: "SEARCH_DEMAND_LOCAL_BUDGET_EXHAUSTED" };
    if (!record) {
      record = { schemaVersion: 1, jobId, provider, keywordId: identity.keywordId, keyword: identity.keyword, scopeId: scope.scopeId,
        period, conditions, status: "queued", attempts: 0, createdAt: now(), updatedAt: now(), errorCode: null,
        scheduledAt: new Date(`${provider === "datalab" ? period + "-02" : period}T${provider === "datalab" ? monthlyAt : dailyAt}:00+09:00`).toISOString(),
        startedAt: null, finishedAt: null, requestCount: 0, lastRequestCount: null };
      await createJson(file, record);
    }
    if (!await runtimeEnabled()) {
      record = { ...record, status: "held", errorCode: "SEARCH_DEMAND_ACTIVATION_STOPPED", updatedAt: now(), finishedAt: now(), lastRequestCount: 0 };
      await replaceJson(file, record); return publicJob(record);
    }
    const claimFile = path.join(directory, "claims", `${jobId}_${parts.day}.json`);
    try { await createJson(claimFile, { schemaVersion: 1, jobId, provider, day: parts.day, claimedAt: now() }); }
    catch (error) {
      if (error.code !== "EEXIST") throw error;
      record = { ...record, status: "needs_verification", errorCode: "SEARCH_DEMAND_INTERRUPTED_CLAIM", updatedAt: now() };
      await replaceJson(file, record); return publicJob(record);
    }
    // Charge conservatively before dispatch. A crash never creates a free retry.
    await replaceJson(budgetFile, { ...budget, count: budget.count + 1, updatedAt: now() });
    const priorRequestCount = record.requestCount;
    record = { ...record, status: "running", attempts: record.attempts + 1, lastAttemptDay: parts.day, updatedAt: now(), nextRetryDay: null,
      startedAt: now(), finishedAt: null, requestCount: null, lastRequestCount: null };
    await replaceJson(file, record);
    // A policy changed after the durable claim must not dispatch a new request.
    // Keep the conservative claim/budget and explicitly record a known zero call.
    if (!await runtimeEnabled()) {
      record = { ...record, status: "held", errorCode: "SEARCH_DEMAND_ACTIVATION_STOPPED", updatedAt: now(), finishedAt: now(),
        requestCount: priorRequestCount, lastRequestCount: 0 };
      await replaceJson(file, record); return publicJob(record);
    }
    let result;
    try { result = await providers[provider]({ keyword: identity.keyword, scopeId: scope.scopeId, ...conditions }); }
    catch { result = { status: "failed", errorCode: "SEARCH_DEMAND_PROVIDER_UNAVAILABLE", networkAttempted: false }; }
    if (!["complete", "held", "failed", "blocked"].includes(result?.status)) result = { status: "failed", errorCode: "SEARCH_DEMAND_PROVIDER_RESULT_INVALID" };
    if (result.observedAt && (!ISO.test(result.observedAt) || !Number.isFinite(Date.parse(result.observedAt)))) result = { status: "failed", errorCode: "SEARCH_DEMAND_PROVIDER_RESULT_INVALID" };
    if (result.status === "complete" && !result.snapshot) result = { ...result, status: "needs_verification", errorCode: "SEARCH_DEMAND_SNAPSHOT_MISSING" };
    const lastRequestCount = [0, 1].includes(result.requestCount) ? result.requestCount : null;
    record = { ...record, startedAt: ISO.test(result.requestedAt || "") ? result.requestedAt : record.startedAt,
      finishedAt: result.observedAt || now(), lastRequestCount,
      requestCount: Number.isSafeInteger(priorRequestCount) && lastRequestCount !== null ? priorRequestCount + lastRequestCount : null };
    let saved = null, postprocessStatus = null, postprocessErrorCode = null;
    if (result.snapshot) {
      try {
        if (result.snapshot.provider !== provider || result.snapshot.keywordId !== identity.keywordId || result.snapshot.scopeId !== scope.scopeId) throw problem("SEARCH_DEMAND_SNAPSHOT_SCOPE_MISMATCH");
        saved = await store.saveSnapshot(result.snapshot);
        if (!saved || saved.snapshotId !== result.snapshot.snapshotId) throw problem("SEARCH_DEMAND_SNAPSHOT_STORE_UNVERIFIED");
        await verifyStoredSnapshot({ ...record, snapshotId: saved.snapshotId });
      } catch (error) {
        record = { ...record, status: "needs_verification", errorCode: "SEARCH_DEMAND_SNAPSHOT_STORE_FAILED", updatedAt: now(), postprocessErrorCode: safeCode(error) };
        await replaceJson(file, record); return publicJob(record);
      }
      try {
        const outcome = await onSnapshotCommitted(result.snapshot, { jobId });
        if (["complete", "reused"].includes(outcome?.status)) postprocessStatus = "complete";
        else {
          postprocessStatus = "held";
          postprocessErrorCode = outcome?.status === "held" && SAFE_CODE.test(outcome.reasonCode || "") ? outcome.reasonCode : "SEARCH_DEMAND_POSTPROCESS_RESULT_UNVERIFIED";
        }
      }
      catch (error) { postprocessStatus = "held"; postprocessErrorCode = SAFE_CODE.test(error?.code || "") ? error.code : "SEARCH_DEMAND_POSTPROCESS_FAILED"; }
    }
    const errorCode = SAFE_CODE.test(result.errorCode || "") ? result.errorCode : result.status === "complete" ? null : "SEARCH_DEMAND_PROVIDER_UNAVAILABLE";
    if (["AUTH_ERROR", "QUOTA_EXCEEDED"].includes(errorCode)) {
      await createJson(protectionFile, { schemaVersion: 1, provider, scopeId: scope.scopeId, errorCode, observedAt: result.observedAt || now() });
      memory.providers[provider] = { protected: true, errorCode };
    }
    record = { ...record, status: result.status, errorCode, snapshotId: saved?.snapshotId || result.snapshot?.snapshotId || null,
      observedAt: result.observedAt || now(), updatedAt: now(), postprocessStatus, postprocessErrorCode,
      nextRetryDay: provider === "datalab" && result.status === "held" && errorCode === "INCOMPLETE_DATA" && record.attempts < maxTrendAttempts ? nextDay(parts.day) : null };
    await replaceJson(file, record); return publicJob(record);
  }
  async function doTick() {
    if ((!enabled && !getEnabled) || stopped) return status();
    memory.running = true; memory.lastTickAt = now(); memory.jobs = [];
    try {
      if (!await runtimeEnabled()) { memory.running = false; return status(); }
      const parts = kstParts(memory.lastTickAt), monthlyDue = parts.date >= monthlyDay && parts.time >= monthlyAt, dailyDue = parts.time >= dailyAt;
      if (!monthlyDue && !dailyDue) { memory.lastReason = "WAITING_FOR_SCHEDULE"; memory.running = false; return status(); }
      const result = await withLock(async () => {
        let registeredCount = 0;
        // Monthly and daily hosts have independent budgets and persistent guards.
        for (const provider of ["datalab", "searchad"]) {
          if (!await runtimeEnabled()) return { skipped: true, reason: memory.lastReason };
          if (provider === "datalab" && !monthlyDue || provider === "searchad" && !dailyDue) continue;
          const period = provider === "datalab" ? parts.month : parts.day;
          const identities = await registeredCohort(provider, period);
          registeredCount += identities.length;
          if (!identities.length) continue;
          const scope = await providers.credentialScope(provider);
          if (!scope?.configured || !SCOPE.test(scope.scopeId || "")) {
            memory.providers[provider] = { protected: false, errorCode: "MISSING_KEY" }; continue;
          }
          memory.providers[provider] = { protected: false, errorCode: null };
          const conditions = provider === "datalab" ? trendRange(parts.month) : {};
          for (const identity of identities) {
            if (!await runtimeEnabled()) return { skipped: true, reason: memory.lastReason };
            const row = await execute(provider, identity, scope, period, conditions, parts);
            memory.jobs.push(row);
            if (row.status === "blocked") break;
          }
        }
        return !memory.enabled ? { skipped: true, reason: memory.lastReason } : registeredCount ? { skipped: false } : { skipped: true, reason: "NO_REGISTERED_KEYWORDS" };
      });
      memory.lastReason = result.reason || (memory.jobs.length ? "CHECKED" : "NO_READY_PROVIDER");
    } catch (error) { memory.lastReason = safeCode(error); }
    finally { memory.running = false; }
    return status();
  }
  function tick() { if (tickPromise) return tickPromise; tickPromise = doTick().finally(() => { tickPromise = null; }); return tickPromise; }
  function status() { return { ...clone(memory), enabled: memory.enabled && !stopped, schedule: { dailyAt, monthlyDay, monthlyAt, timeZone: "Asia/Seoul" },
    dailyLimits: { ...limits }, automaticProtectionRelease: false, maxTrendAttempts }; }
  function start() {
    if ((!enabled && !getEnabled) || stopped || timer) return status();
    timer = setInterval(() => { void tick(); }, intervalMs); timer.unref?.(); void tick(); return status();
  }
  function stop() { stopped = true; if (timer) clearInterval(timer); timer = null; return status(); }
  return { tick, start, stop, status, history };
}

module.exports = { createSearchDemandScheduler };
