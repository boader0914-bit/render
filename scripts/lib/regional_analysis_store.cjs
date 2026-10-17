"use strict";

// Regional analysis is derived data. Reading a saved result never requests a
// provider, queues a calculation, or inventories the underlying source files.
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { buildRegionalIndicatorManagement } = require("./regional_indicator_management.cjs");

const SCHEMA_VERSION = 1;
const CALCULATION_VERSION = "regional-analysis-v1";
const MAX_JOBS = 300;
const MAX_REVISIONS = 8;
const ACTIVE = new Set(["queued", "running"]);
const NORMAL_GROUP = new Set(["ready", "partial", "complete", "completed"]);
const UNAVAILABLE_GROUP = new Set(["missing", "failed", "error", "blocked", "unavailable", "publication_pending"]);
const SAFE_ERRORS = new Set(["SOURCE_UNAVAILABLE", "PROVIDER_FAILED", "RATE_LIMITED", "AUTH_REQUIRED", "REQUEST_LIMITED",
  "REGIONAL_SOURCE_UNAVAILABLE", "REGIONAL_BUILD_FAILED", "REGIONAL_NO_DATA", "REGIONAL_RESULT_INVALID", "NO_DATA", "PUBLICATION_PENDING",
  "PARTIAL_DATA", "MISSING_VALUES", "AUTH_ERROR", "MISSING_KEY", "QUOTA_EXCEEDED", "TIMEOUT", "NETWORK_ERROR", "CACHE_READ_ERROR", "CACHE_WRITE_ERROR", "EVIDENCE_WRITE_ERROR",
  "INVALID_RESPONSE", "REGION_MISMATCH", "PERIOD_MISMATCH", "COOLDOWN", "PROVIDER_UNAVAILABLE", "REGIONAL_SOURCE_BUSY", "MAPPING_MISSING"]);
const copy = value => structuredClone(value);
const fault = (code, statusCode = 503) => Object.assign(new Error(code), { code, statusCode });
const safeError = error => SAFE_ERRORS.has(error?.code) ? error.code : "REGIONAL_BUILD_FAILED";
const validMonth = value => /^20\d{2}-(0[1-9]|1[0-2])$/.test(value || "");
const hash = value => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
const validId = value => /^[a-f0-9]{64}$/.test(value || "");
const validResultId = value => /^[a-f0-9-]{36}$/.test(value || "");
const at = value => new Date(value).toISOString();
const hasObserved = group => Array.isArray(group?.metrics)
  ? group.metrics.some(metric => (metric.rows || []).some(row => ["observed", "complete"].includes(row?.status) && typeof row.value === "number" && Number.isFinite(row.value)))
  : NORMAL_GROUP.has(group?.status) && (group.status !== "partial" || typeof group.value === "number");
const hasScopeMismatch = group => group?.errorCode === "REGION_MISMATCH" || (group?.metrics || []).some(metric =>
  metric.spatialContract?.status === "response_mismatch" || (metric.rows || []).some(row => row.spatialContract?.status === "response_mismatch"));
function latestCompletedMonth(value) {
  const kst = new Date(new Date(value).getTime() + 9 * 3600000);
  return new Date(Date.UTC(kst.getUTCFullYear(), kst.getUTCMonth() - 1, 1)).toISOString().slice(0, 7);
}
async function readJson(file) {
  try { return JSON.parse(await fs.readFile(file, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return null; throw fault("REGIONAL_STORE_UNAVAILABLE"); }
}
async function atomicJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  let handle;
  try {
    handle = await fs.open(temporary, "wx", 0o600);
    await handle.writeFile(JSON.stringify(value)); await handle.sync(); await handle.close(); handle = null;
    await fs.rename(temporary, file);
  } finally {
    if (handle) await handle.close().catch(() => {});
    await fs.unlink(temporary).catch(() => {});
  }
}

function createRegionalAnalysisStore({ dataDir, resolveRegion, buildSnapshot, now = () => new Date(), autoStart = true,
  directoryName = "regional_analysis", calculationVersion = CALCULATION_VERSION, defaultMonth = latestCompletedMonth,
  retainFailedGroups = true, rollForward = false, isMutableScope = () => true, onResultSaved = null }) {
  if (!dataDir || typeof resolveRegion !== "function" || typeof buildSnapshot !== "function") throw new TypeError("dataDir, resolveRegion and buildSnapshot are required");
  if (!/^[a-z][a-z0-9_]{1,60}$/.test(directoryName) || !/^[a-z0-9-]{1,100}$/.test(calculationVersion)
    || typeof defaultMonth !== "function" || typeof isMutableScope !== "function") throw new TypeError("Invalid regional storage options");
  const directory = path.resolve(dataDir, directoryName), stateFile = path.join(directory, "queue.json");
  const empty = () => ({ schemaVersion: SCHEMA_VERSION, sequence: 0, jobs: {}, policies: {}, results: {}, sourceRevisions: {}, sourceVersions: {}, dirtyScopes: {} });
  let state = empty(), initialized, serial = Promise.resolve(), worker = null, closed = false, storeError = null, recoveryDirty = false;
  const timestamp = () => at(now());
  const keyFor = scope => hash([calculationVersion, scope.regionKey, scope.months, scope.month]);
  const policyKeyFor = (scope, rolling) => hash([scope.regionKey, scope.months, rolling ? "latest" : scope.month]);
  const pointerFile = key => path.join(directory, "latest", `${key}.json`);
  const resultFile = (key, resultId) => path.join(directory, "results", key, `${resultId}.json`);
  function locked(fn) { const task = serial.then(fn); serial = task.catch(() => {}); return task; }
  async function init() {
    if (!initialized) initialized = (async () => {
      const stored = await readJson(stateFile);
      if (!stored) return;
      if (stored.schemaVersion !== SCHEMA_VERSION || !Number.isSafeInteger(stored.sequence) || stored.sequence < 0
        || !stored.jobs || Array.isArray(stored.jobs) || !stored.policies || Array.isArray(stored.policies)
        || !stored.results || Array.isArray(stored.results)) throw fault("REGIONAL_STORE_INVALID");
      stored.sourceRevisions ||= {}; stored.sourceVersions ||= {}; stored.dirtyScopes ||= {};
      if ([stored.sourceRevisions, stored.sourceVersions, stored.dirtyScopes].some(value => typeof value !== "object" || Array.isArray(value))
        || Object.values(stored.sourceRevisions).some(value => !Number.isSafeInteger(value) || value < 0)) throw fault("REGIONAL_STORE_INVALID");
      for (const [id, job] of Object.entries(stored.jobs)) {
        if (id !== job?.id || !validResultId(id) || !validId(job.scopeKey) || !validMonth(job.scope?.month)
          || typeof job.scope.regionKey !== "string" || typeof job.scope.label !== "string" || typeof job.collectMissing !== "boolean"
          || !["queued", "running", "processing", "completed", "failed", "interrupted", "superseded"].includes(job.status)
          || keyFor(job.scope) !== job.scopeKey || ![13, 24].includes(job.scope.months) || !Number.isSafeInteger(job.sequence)
          || !Number.isFinite(Date.parse(job.queuedAt))) throw fault("REGIONAL_STORE_INVALID");
        if (ACTIVE.has(job.status) || job.status === "processing" || job.status === "interrupted" && !job.collectMissing) {
          if (!isMutableScope(job.scope, now())) {
            job.status = "superseded"; job.errorCode = "REGIONAL_SCOPE_CLOSED"; job.finishedAt = timestamp();
            recoveryDirty = true; continue;
          }
          // Provider work may have happened before a lost acknowledgement. It
          // is never replayed automatically. Pure local work is safe to resume.
          job.status = job.collectMissing ? "interrupted" : "queued";
          job.errorCode = job.collectMissing ? "REGIONAL_REFRESH_INTERRUPTED" : null;
          job.recoveredAt = timestamp();
          if (!job.collectMissing) job.sourceRevision = stored.sourceRevisions[job.scope.regionKey] || 0;
          if (job.collectMissing) job.finishedAt = timestamp();
          recoveryDirty = true;
        }
      }
      for (const [key, policy] of Object.entries(stored.policies)) {
        if (!validId(key) || !policy?.scope || typeof policy.rollingMonth !== "boolean" || !validMonth(policy.scope.month)
          || ![13, 24].includes(policy.scope.months) || typeof policy.scope.regionKey !== "string" || typeof policy.scope.label !== "string"
          || policyKeyFor(policy.scope, policy.rollingMonth) !== key
          || typeof policy.enabled !== "boolean" || !Number.isInteger(policy.hour) || policy.hour < 0 || policy.hour > 23
          || !Number.isInteger(policy.minute) || policy.minute < 0 || policy.minute > 59
          || !Number.isInteger(policy.intervalHours) || policy.intervalHours < 1 || policy.intervalHours > 168
          || (policy.nextRunAt !== null && !Number.isFinite(Date.parse(policy.nextRunAt)))
          || (!policy.enabled && policy.nextRunAt !== null)) throw fault("REGIONAL_STORE_INVALID");
      }
      state = stored;
      for (const [key, dirty] of Object.entries(state.dirtyScopes)) {
        if (!validId(key) || !dirty?.scope || keyFor(dirty.scope) !== key || !Number.isSafeInteger(dirty.revision)) throw fault("REGIONAL_STORE_INVALID");
        if (!isMutableScope(dirty.scope, now())) { delete state.dirtyScopes[key]; recoveryDirty = true; continue; }
        const job = latestJob(key);
        if (!job || !ACTIVE.has(job.status)) { enqueue(dirty.scope, { collectMissing: false, reason: "source_changed" }); recoveryDirty = true; }
      }
    })().catch(error => { storeError = error?.code === "REGIONAL_STORE_INVALID" ? error.code : "REGIONAL_STORE_UNAVAILABLE"; });
    return initialized;
  }
  async function save() {
    if (storeError) throw fault(storeError);
    try { await atomicJson(stateFile, state); recoveryDirty = false; }
    catch (_) { storeError = "REGIONAL_STORE_UNAVAILABLE"; throw fault(storeError); }
  }
  function writable() { if (closed) throw fault("REGIONAL_STORE_CLOSED"); if (storeError) throw fault(storeError); }
  async function normalize(input = {}) {
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(key => !["regionKey", "months", "month"].includes(key))) throw fault("INVALID_REGIONAL_SCOPE", 400);
    const months = input.months === undefined ? 13 : Number(input.months);
    const month = input.month === undefined || input.month === "" ? defaultMonth(now()) : input.month;
    const currentMonth = new Date(new Date(now()).getTime() + 9 * 3600000).toISOString().slice(0, 7);
    if (![13, 24].includes(months) || !validMonth(month) || month > currentMonth || typeof input.regionKey !== "string" || !input.regionKey.trim()
      || input.regionKey.length > 120) throw fault("INVALID_REGIONAL_SCOPE", 400);
    let region;
    try { region = await resolveRegion(input.regionKey.trim()); } catch (_) { throw fault("INVALID_REGIONAL_REGION", 400); }
    if (!region || region.regionKey !== input.regionKey.trim() || typeof region.label !== "string" || !region.label || region.label.length > 300) throw fault("INVALID_REGIONAL_REGION", 400);
    return { regionKey: region.regionKey, label: region.label, month, months };
  }
  function latestJob(key) { return Object.values(state.jobs).filter(job => job.scopeKey === key).sort((a, b) => b.sequence - a.sequence)[0] || null; }
  function policyFor(scope, input) {
    const rolling = !input.month;
    const saved = state.policies[policyKeyFor(scope, rolling)] || state.policies[policyKeyFor(scope, true)];
    return saved || { scope: copy(scope), rollingMonth: rolling, enabled: false, hour: 6, minute: 0, intervalHours: 24, nextRunAt: null, lastRunAt: null };
  }
  async function savedResult(key) {
    let pointer = null, errorCode = null;
    try {
      pointer = await readJson(pointerFile(key));
      if (pointer && (pointer.schemaVersion !== SCHEMA_VERSION || pointer.scopeKey !== key || !validResultId(pointer.resultId)
        || !Array.isArray(pointer.revisions) || pointer.revisions.some(id => !validResultId(id)))) throw fault("REGIONAL_RESULT_INVALID");
    } catch (_) { errorCode = "REGIONAL_RESULT_INVALID"; pointer = null; }
    const known = state.results[key];
    const candidates = [...new Set([pointer?.resultId, ...(pointer?.revisions || []), known?.resultId, ...(known?.revisions || [])].filter(validResultId))].slice(0, MAX_REVISIONS + 1);
    for (const resultId of candidates) {
      try {
        const snapshot = await readJson(resultFile(key, resultId));
        if (!snapshot || snapshot.schemaVersion !== SCHEMA_VERSION || snapshot.calculationVersion !== calculationVersion
          || snapshot.resultId !== resultId || keyFor(snapshot.scope || {}) !== key || !["ready", "partial", "missing"].includes(snapshot.status)
          || !Array.isArray(snapshot.groups)) throw fault("REGIONAL_RESULT_INVALID");
        return { snapshot, errorCode };
      } catch (_) { errorCode = "REGIONAL_RESULT_INVALID"; }
    }
    return { snapshot: null, errorCode };
  }
  async function get(input = {}) {
    const scope = await normalize(input); await init();
    return locked(async () => {
      const { snapshot, errorCode } = await savedResult(keyFor(scope));
      const job = copy(latestJob(keyFor(scope))), policy = copy(policyFor(scope, input));
      // Refresh attempts belong to the region, including the prior month's
      // rolling scope. A later cache-only rebuild must not hide their outcome.
      // Jobs are bounded in queue.json; this read never scans provider files.
      const refreshHistory = directoryName === "regional_analysis" ? Object.values(state.jobs)
        .filter(value => value.collectMissing === true && value.scope?.regionKey === scope.regionKey && value.scope?.months === scope.months)
        .sort((a, b) => b.sequence - a.sequence).slice(0, 30).map(copy) : [];
      const management = directoryName === "regional_analysis"
        ? buildRegionalIndicatorManagement({ snapshot, scope, job, policy, refreshHistory, now: now() }) : null;
      if (management?.result) management.result.storageErrorCode = storeError || errorCode;
      return { status: snapshot?.status || "missing", scope: copy(scope), snapshot: copy(snapshot), job,
        policy, storage: { errorCode: storeError || errorCode }, ...(management ? { management } : {}) };
    });
  }
  function prune() {
    const completed = Object.values(state.jobs).filter(job => !ACTIVE.has(job.status)).sort((a, b) => b.sequence - a.sequence);
    for (const job of completed.slice(MAX_JOBS)) delete state.jobs[job.id];
  }
  function enqueue(scope, options = {}) {
    const key = keyFor(scope), prior = latestJob(key);
    if (prior && ACTIVE.has(prior.status)) return { job: copy(prior), reused: true };
    const reason = ["manual", "scheduled", "source_changed", "rebuild", "retry", "initial", "manual_refresh", "test"].includes(options.reason) ? options.reason : "manual";
    const job = { id: crypto.randomUUID(), scopeKey: key, scope: copy(scope), sequence: ++state.sequence,
      status: "queued", collectMissing: options.collectMissing === true, reason, queuedAt: timestamp(), startedAt: null,
      finishedAt: null, resultId: null, errorCode: null, sourceRevision: state.sourceRevisions[scope.regionKey] || 0 };
    state.jobs[job.id] = job; prune();
    return { job: copy(job), reused: false };
  }
  async function request(input = {}, options = {}) {
    if (!options || typeof options !== "object" || Array.isArray(options) || Object.keys(options).some(key => !["collectMissing", "reason"].includes(key))
      || options.collectMissing !== undefined && typeof options.collectMissing !== "boolean"
      || options.reason !== undefined && typeof options.reason !== "string") throw fault("INVALID_REGIONAL_REQUEST", 400);
    const scope = await normalize(input); await init();
    const response = await locked(async () => { writable(); const value = enqueue(scope, options); if (!value.reused || recoveryDirty) await save(); return value; });
    if (autoStart) kick();
    return response;
  }
  async function sourceChanged(event = {}) {
    if (!event || typeof event !== "object" || Array.isArray(event) || Object.keys(event).some(key => !["regionKey", "sourceKey", "sourceVersion"].includes(key))
      || typeof event.regionKey !== "string" || !event.regionKey.trim()
      || event.regionKey.length > 120 || (event.sourceKey !== undefined && (typeof event.sourceKey !== "string" || event.sourceKey.length > 100))
      || (event.sourceVersion !== undefined && (typeof event.sourceVersion !== "string" || event.sourceVersion.length > 300))) throw fault("INVALID_REGIONAL_SOURCE_EVENT", 400);
    await init();
    const response = await locked(async () => {
      writable();
      const regionKey = event.regionKey.trim(), scopes = new Map();
      for (const value of [...Object.values(state.results), ...Object.values(state.jobs), ...Object.values(state.policies)]) {
        const scope = value?.scope;
        if (scope?.regionKey === regionKey) {
          const current = value.rollingMonth ? { ...scope, month: defaultMonth(now()) } : scope;
          if (!isMutableScope(current, now())) continue;
          scopes.set(keyFor(current), current);
        }
      }
      if (!scopes.size) return { ignored: true, deduped: false, queued: 0 };
      const versionKey = hash([regionKey, event.sourceKey || "all"]), version = event.sourceVersion === undefined ? null : hash(event.sourceVersion);
      if (version && state.sourceVersions[versionKey] === version) return { ignored: false, deduped: true, queued: 0 };
      if (version) state.sourceVersions[versionKey] = version;
      const revision = (state.sourceRevisions[regionKey] || 0) + 1;
      state.sourceRevisions[regionKey] = revision;
      let queued = 0;
      for (const [key, scope] of scopes) {
        state.dirtyScopes[key] = { scope: copy(scope), revision };
        const prior = latestJob(key);
        if (prior?.status === "running") continue;
        if (prior?.status === "queued") { prior.sourceRevision = revision; continue; }
        const result = enqueue(scope, { collectMissing: false, reason: "source_changed" });
        if (!result.reused) queued++;
      }
      await save(); return { ignored: false, deduped: false, queued, revision };
    });
    if (autoStart && !response.ignored) kick();
    return response;
  }
  function firstRun(hour, minute) {
    const current = new Date(now()).getTime(), kst = new Date(current + 9 * 3600000);
    let candidate = Date.UTC(kst.getUTCFullYear(), kst.getUTCMonth(), kst.getUTCDate(), hour - 9, minute);
    if (candidate <= current) candidate += 86400000;
    return at(candidate);
  }
  async function updatePolicy(input = {}, changes = {}) {
    const scope = await normalize(input); await init();
    return locked(async () => {
      writable();
      if (!changes || typeof changes !== "object" || Array.isArray(changes) || Object.keys(changes).some(key => !["enabled", "hour", "minute", "intervalHours"].includes(key))
        || typeof changes.enabled !== "boolean") throw fault("INVALID_REGIONAL_POLICY", 400);
      const rollingMonth = !input.month, key = policyKeyFor(scope, rollingMonth), previous = state.policies[key] || policyFor(scope, input);
      const hour = changes.hour === undefined ? previous.hour : changes.hour;
      const minute = changes.minute === undefined ? previous.minute : changes.minute;
      const intervalHours = changes.intervalHours === undefined ? previous.intervalHours : changes.intervalHours;
      if (!Number.isInteger(hour) || hour < 0 || hour > 23 || !Number.isInteger(minute) || minute < 0 || minute > 59
        || !Number.isInteger(intervalHours) || intervalHours < 1 || intervalHours > 168) throw fault("INVALID_REGIONAL_POLICY", 400);
      const policy = { scope: copy(scope), rollingMonth, enabled: changes.enabled, hour, minute, intervalHours,
        nextRunAt: changes.enabled ? firstRun(hour, minute) : null, lastRunAt: previous.lastRunAt || null, updatedAt: timestamp() };
      state.policies[key] = policy; await save(); return copy(policy);
    });
  }
  async function tick() {
    await init();
    const response = await locked(async () => {
      writable(); let changed = recoveryDirty, queued = 0;
      const current = new Date(now()).getTime();
      if (rollForward) {
        // A known region gets a new monthly local calculation without a page
        // view or an automatic provider request. Published past forecasts stay
        // immutable and are never rebuilt with later observations.
        const latest = defaultMonth(now()), candidates = new Map();
        for (const value of [...Object.values(state.results), ...Object.values(state.jobs)]) {
          const scope = value?.scope;
          if (scope && scope.month < latest) candidates.set(`${scope.regionKey}:${scope.months}`, { ...scope, month: latest });
        }
        for (const scope of candidates.values()) {
          const key = keyFor(scope);
          if (!state.results[key] && !latestJob(key)) { enqueue(scope, { collectMissing: false, reason: "initial" }); queued++; changed = true; }
        }
      }
      for (const policy of Object.values(state.policies)) {
        if (!policy.enabled || !policy.nextRunAt || Date.parse(policy.nextRunAt) > current) continue;
        const scope = policy.rollingMonth ? { ...policy.scope, month: defaultMonth(now()) } : policy.scope;
        if (!isMutableScope(scope, now())) { policy.enabled = false; policy.nextRunAt = null; changed = true; continue; }
        const result = enqueue(scope, { collectMissing: true, reason: "scheduled" });
        if (!result.reused) queued++;
        const due = Date.parse(policy.nextRunAt), step = policy.intervalHours * 3600000;
        policy.lastRunAt = at(due);
        policy.nextRunAt = at(due + (Math.floor((current - due) / step) + 1) * step);
        policy.lastJobId = result.job.id; changed = true;
      }
      if (changed) await save();
      return { queued };
    });
    if (autoStart) kick(); return response;
  }
  async function processQueue() {
    await init();
    while (!closed && !storeError) {
      const selected = await locked(async () => {
        if (closed || storeError) return null;
        let retired = false;
        for (const candidate of Object.values(state.jobs)) if (candidate.status === "queued" && !isMutableScope(candidate.scope, now())) {
          candidate.status = "superseded"; candidate.errorCode = "REGIONAL_SCOPE_CLOSED"; candidate.finishedAt = timestamp();
          delete state.dirtyScopes[candidate.scopeKey]; retired = true;
        }
        if (retired) await save();
        const job = Object.values(state.jobs).filter(value => value.status === "queued").sort((a, b) => a.sequence - b.sequence)[0];
        if (!job) return null;
        job.status = "running"; job.startedAt = timestamp(); await save(); return copy(job);
      });
      if (!selected) return;
      let result, errorCode = null;
      try {
        result = await buildSnapshot(copy(selected.scope), { collectMissing: selected.collectMissing, jobId: selected.id });
        if (!result || !["ready", "partial", "missing"].includes(result.status) || !Array.isArray(result.groups)
          || result.failed === true || result.success === false) throw fault("REGIONAL_RESULT_INVALID");
        // An explicit all-failed source bundle is not a new normal snapshot.
        if (result.groups.length && result.groups.every(group => ["failed", "error", "blocked"].includes(group?.status))
          && !result.groups.some(hasScopeMismatch)) throw fault("REGIONAL_SOURCE_UNAVAILABLE");
      } catch (error) { errorCode = safeError(error); }
      let published = null;
      await locked(async () => {
        const job = state.jobs[selected.id];
        if (closed || !job || job.status !== "running") return;
        if (result?.refreshDiagnostics) job.refreshDiagnostics = copy(result.refreshDiagnostics);
        if (!isMutableScope(selected.scope, now())) {
          job.status = "superseded"; job.finishedAt = timestamp(); job.errorCode = "REGIONAL_SCOPE_CLOSED";
          delete state.dirtyScopes[selected.scopeKey]; await save(); return;
        }
        if ((selected.sourceRevision || 0) !== (state.sourceRevisions[selected.scope.regionKey] || 0)) {
          job.status = "superseded"; job.finishedAt = timestamp(); job.errorCode = null;
          const followup = enqueue(selected.scope, { collectMissing: false, reason: "source_changed" });
          if (job.refreshDiagnostics) state.jobs[followup.job.id].refreshDiagnostics = copy(job.refreshDiagnostics);
          await save(); return;
        }
        if (errorCode) {
          job.status = "failed"; job.errorCode = errorCode; job.finishedAt = timestamp(); await save(); return;
        }
        const resultId = crypto.randomUUID(), key = selected.scopeKey;
        // A failed provider must not turn a previously observed source into a
        // zero or an empty panel. Keep that source's last normal data while
        // making the failed/stale refresh visible to the caller.
        const priorSnapshot = (await savedResult(key)).snapshot;
        let retained = false;
        const priorGroups = new Map((priorSnapshot?.groups || []).filter(group => group?.key).map(group => [group.key, group]));
        const groups = result.groups.map(group => {
          // A confirmed wrong region must stay excluded. A provider outage may
          // reuse its last good data, but must not undo new geographic evidence.
          if (!retainFailedGroups || hasScopeMismatch(group)) return copy(group);
          const previousGroup = priorGroups.get(group?.key);
          if (!previousGroup || !NORMAL_GROUP.has(previousGroup.status) || !hasObserved(previousGroup)
            || (!UNAVAILABLE_GROUP.has(group?.status) && !(group.status === "partial" && !hasObserved(group)))) return copy(group);
          retained = true;
          return { ...copy(previousGroup), stale: true, refresh: { status: group.status,
            errorCode: SAFE_ERRORS.has(group.errorCode) ? group.errorCode : "REGIONAL_SOURCE_UNAVAILABLE", attemptedAt: timestamp() },
          lastRefreshErrorCode: SAFE_ERRORS.has(group.errorCode) ? group.errorCode : "REGIONAL_SOURCE_UNAVAILABLE" };
        });
        const snapshot = { ...copy(result), schemaVersion: SCHEMA_VERSION, calculationVersion,
          resultId, generatedAt: timestamp(), scope: copy(selected.scope), groups, status: retained ? "partial" : result.status };
        if (snapshot.storedEvidence) {
          const rows = groups.filter(group => group.category !== "search").flatMap(group => (group.metrics || []).flatMap(metric => metric.rows || []));
          snapshot.storedEvidence = { ...snapshot.storedEvidence,
            restored: rows.filter(row => row.spatialContract?.storedProvenance && row.spatialContract.status === "matched").length,
            pending: rows.filter(row => row.storedEvidenceVerification?.status === "pending").length,
            rejected: rows.filter(row => row.storedEvidenceVerification?.status === "rejected").length };
        }
        snapshot.summary = { ...snapshot.summary, total: groups.length, ready: groups.filter(group => ["ready", "complete", "completed"].includes(group.status)).length,
          partial: groups.filter(group => group.status === "partial").length, failed: groups.filter(group => ["failed", "error", "blocked"].includes(group.status)).length,
          missing: groups.filter(group => ["missing", "publication_pending", "unavailable"].includes(group.status)).length, stale: groups.filter(group => group.stale).length };
        if (retained) { snapshot.inputFingerprint = result.sourceFingerprint || null; snapshot.sourceFingerprint = hash([selected.scope, result.calculationVersion || CALCULATION_VERSION, groups]); }
        job.hasObservedData = groups.some(hasObserved);
        if (Array.isArray(snapshot.metrics)) job.hasForecastData = snapshot.metrics.some(metric => (metric.forecasts || [])
          .some(row => row.status === "forecast" && typeof row.value === "number" && Number.isFinite(row.value)));
        if (typeof snapshot.sourceFingerprint === "string" && snapshot.sourceFingerprint && priorSnapshot?.sourceFingerprint === snapshot.sourceFingerprint) {
          job.status = "completed"; job.resultStatus = priorSnapshot.status; job.resultId = priorSnapshot.resultId;
          job.unchanged = true; job.finishedAt = timestamp(); job.errorCode = null;
          delete state.dirtyScopes[key]; await save(); published = copy(priorSnapshot); return;
        }
        const previous = state.results[key];
        const revisions = [...new Set([previous?.resultId, ...(previous?.revisions || [])].filter(validResultId))].slice(0, MAX_REVISIONS);
        try {
          // Immutable results are fully durable before publication. A lost
          // acknowledgement can orphan one result, never corrupt the old one.
          await atomicJson(resultFile(key, resultId), snapshot);
          if (!isMutableScope(selected.scope, now())) {
            job.status = "superseded"; job.finishedAt = timestamp(); job.errorCode = "REGIONAL_SCOPE_CLOSED";
            delete state.dirtyScopes[key]; await save(); return;
          }
          await atomicJson(pointerFile(key), { schemaVersion: SCHEMA_VERSION, scopeKey: key, resultId, revisions });
          state.results[key] = { resultId, revisions, scope: copy(selected.scope) };
          job.status = "completed"; job.resultStatus = snapshot.status; job.resultId = resultId; job.finishedAt = timestamp(); job.errorCode = null;
          delete state.dirtyScopes[key];
          await save();
          published = copy(snapshot);
        } catch (_) {
          job.status = "failed"; job.errorCode = "REGIONAL_STORE_UNAVAILABLE"; job.finishedAt = timestamp();
          storeError = "REGIONAL_STORE_UNAVAILABLE";
        }
      });
      if (published && typeof onResultSaved === "function") await Promise.resolve().then(() => onResultSaved(published)).catch(() => {});
    }
  }
  function kick() {
    if (closed || worker || storeError) return worker;
    worker = processQueue().catch(() => { storeError = "REGIONAL_STORE_UNAVAILABLE"; }).finally(() => { worker = null; });
    return worker;
  }
  async function waitForIdle() {
    await init();
    while (!closed && !storeError) {
      await kick(); await serial;
      if (!Object.values(state.jobs).some(job => job.status === "queued")) break;
    }
  }
  async function close() {
    closed = true; if (timer) clearInterval(timer);
    await init();
    await locked(async () => {
      if (storeError) return;
      let changed = recoveryDirty;
      for (const job of Object.values(state.jobs)) if (job.status === "running") {
        job.status = "interrupted"; job.errorCode = "REGIONAL_REFRESH_INTERRUPTED"; job.finishedAt = timestamp(); changed = true;
      }
      if (changed) await save();
    });
  }
  const timer = autoStart ? setInterval(() => { tick().catch(() => {}); }, 30000) : null;
  timer?.unref?.();
  async function trackedRegions() {
    await init();
    return locked(() => [...new Set([...Object.values(state.results), ...Object.values(state.jobs), ...Object.values(state.policies)]
      .map(value => value?.scope?.regionKey).filter(Boolean))]);
  }
  return { get, request, updatePolicy, sourceChanged, tick, waitForIdle, close, trackedRegions };
}

module.exports = { createRegionalAnalysisStore, SCHEMA_VERSION, CALCULATION_VERSION, latestCompletedMonth };
