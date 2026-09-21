const fs = require("node:fs/promises");
const path = require("node:path");
const { KEYWORDS } = require("./daily_keyword_collection_scheduler.cjs");
const { inspectManifest } = require("./daily_collection_quality.cjs");

const STATUSES = ["completed", "partial", "failed", "blocked", "interrupted", "pending", "running"];
const TERMINAL = new Set(STATUSES.slice(0, 5));
const SCOPE_FIELDS = ["searchMode", "collectionMode", "collectionPurpose", "productMode", "detailRankRanges", "bookingRangeDays", "bookingRangePlaceLimit"];
const SCHEDULE_FIELDS = ["naverScheduleRequested", "naverScheduleSucceeded", "naverScheduleFailed", "naverScheduleBlocked"];
const COUNT_FIELDS = ["naverOverall", "naverBookingStockChecked", "naverBookingStockSucceeded", ...SCHEDULE_FIELDS];
const STOP_REASONS = new Set(["cancel_requested", "disk_full", "naver_main_http_403", "naver_main_http_429", "naver_schedule_http_403", "naver_schedule_http_429", "naver_schedule_http_403_or_429", "naver_booking_http_403", "naver_booking_http_429", "naver_request_http_403", "naver_request_http_429", "rate_limited", "collection_blocked", "same_day_configuration_changed", "disk_check_failed", "insufficient_disk_space"]);
const finite = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
const instant = (value) => typeof value === "string" && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const keywordKey = (value) => String(value || "").replace(/\s+/g, "");

function validDate(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && instant(`${value}T00:00:00Z`)?.slice(0, 10) === value;
}

async function readJson(file) {
  return JSON.parse((await fs.readFile(file, "utf8")).replace(/^\uFEFF/, ""));
}

function numericFields(value, allowed) {
  return Object.fromEntries(allowed.flatMap((key) => finite(value?.[key]) === null ? [] : [[key, value[key]]]));
}

// Emit only known non-secret receipt fields, never arbitrary state errors, URLs or environment data.
function pacingFields(value) {
  if (!value || typeof value !== "object") return null;
  const output = numericFields(value, ["maxConcurrent", "maxConcurrentRequests", "maxConcurrency", "concurrency", "minIntervalMs", "requestIntervalMs", "bookingConcurrency", "placeConcurrency", "detailConcurrency", "scheduleConcurrency", "otaConcurrency", "started", "completed", "failed", "requests", "requestCount", "httpRequests", "waitMs", "totalWaitMs", "maxInFlight", "minObservedStartIntervalMs", "failedRequests", "cancelledBeforeStart", "queued", "inFlight", "blockedStatus", "cacheHits", "cacheMisses"]);
  for (const key of ["enabled", "stopped"]) if (typeof value[key] === "boolean") output[key] = value[key];
  for (const key of ["profile", "mode", "name", "version"]) {
    if (typeof value[key] === "string" && /^[a-zA-Z0-9_.-]{1,80}$/.test(value[key])) output[key] = value[key];
    else if (finite(value[key]) !== null) output[key] = value[key];
  }
  return Object.keys(output).length ? output : null;
}

async function loadManifest(dataDir, runId) {
  if (!runId || !/^[a-zA-Z0-9_-]{1,240}$/.test(runId)) return { status: runId ? "invalid_run_id" : "not_recorded", manifest: null };
  try {
    const outputs = await fs.realpath(path.join(dataDir, "outputs"));
    const runDir = await fs.realpath(path.join(outputs, runId));
    const file = await fs.realpath(path.join(runDir, "manifest.json"));
    if (path.dirname(runDir) !== outputs || path.dirname(file) !== runDir) return { status: "outside_outputs", manifest: null };
    const manifest = await readJson(file);
    if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) return { status: "invalid", manifest: null };
    return { status: "read", manifest };
  } catch (error) {
    return { status: error.code === "ENOENT" ? "missing" : "unreadable", manifest: null };
  }
}

function scopeFor(manifest, date, keyword) {
  if (!manifest || keywordKey(manifest.keyword) !== keywordKey(keyword) || manifest.checkIn !== date) return null;
  const scope = {};
  for (const key of SCOPE_FIELDS) {
    const value = manifest[key];
    if (key.startsWith("booking")) {
      if (!Number.isSafeInteger(value) || value < 1) return null;
    } else if (typeof value !== "string" || !/^[a-zA-Z0-9_, -]{1,80}$/.test(value)) return null;
    scope[key] = typeof value === "string" ? value.replace(/\s+/g, "") : value;
  }
  const expectedEnd = new Date(`${date}T00:00:00Z`);
  expectedEnd.setUTCDate(expectedEnd.getUTCDate() + scope.bookingRangeDays - 1);
  return manifest.checkOut === expectedEnd.toISOString().slice(0, 10) ? scope : null;
}

async function summarizeDay(state, date, dataDir) {
  const day = state.days[date];
  if (day && (!Array.isArray(day.items) || day.items.length !== KEYWORDS.length
    || day.items.some((item, index) => item?.keyword !== KEYWORDS[index] || !STATUSES.includes(item.status)))) {
    throw new Error("invalid_daily_collection_day");
  }
  const sources = day?.items || KEYWORDS.map((keyword) => ({ keyword, status: "pending" }));
  const items = await Promise.all(sources.map(async (source) => {
    const { status: manifestStatus, manifest } = await loadManifest(dataDir, source.runId);
    const scope = scopeFor(manifest, date, source.keyword);
    const quality = manifest ? inspectManifest(manifest) : null;
    const startedAt = instant(source.startedAt);
    const endedAt = instant(source.endedAt);
    const timed = startedAt && endedAt && Date.parse(endedAt) >= Date.parse(startedAt);
    // Interrupted endedAt is the recovery time, not proof that the crawler ran until then.
    const durationMs = TERMINAL.has(source.status) && source.status !== "interrupted" && timed ? Date.parse(endedAt) - Date.parse(startedAt) : null;
    const recordedDurationMs = finite(source.durationMs);
    const verified = source.status === "completed" && source.quality?.status === "complete"
      && quality?.status === "complete" && scope !== null && durationMs !== null;
    const item = { keyword: source.keyword, status: source.status,
      runId: /^[a-zA-Z0-9_-]{1,240}$/.test(source.runId || "") ? source.runId : null,
      startedAt, endedAt, durationMs, manifestStatus,
      quality: quality?.status || null, qualityReason: quality?.reason || null, verified, scope };
    if (recordedDurationMs !== null && recordedDurationMs !== durationMs) item.recordedDurationMs = recordedDurationMs;
    if (manifest) {
      item.counts = numericFields(manifest.counts, COUNT_FIELDS);
      item.requestPacing = pacingFields(manifest.requestPacing);
      item.requestDiagnostics = pacingFields(manifest.requestDiagnostics);
      item.codeVersion = [manifest.gitCommit, manifest.buildVersion, manifest.commit].find((value) => typeof value === "string" && /^[a-f0-9]{7,40}$/i.test(value)) || null;
    }
    return item;
  }));
  const counts = Object.fromEntries(STATUSES.map((status) => [status, items.filter((item) => item.status === status).length]));
  const allTerminal = items.every((item) => TERMINAL.has(item.status));
  const allCompletedVerified = allTerminal && items.every((item) => item.verified);
  const starts = items.map((item) => item.startedAt).filter(Boolean).sort();
  const ends = items.map((item) => item.endedAt).filter(Boolean).sort();
  const startedAt = starts[0] || null;
  const finishedAt = instant(day?.finishedAt);
  const stoppedAt = instant(day?.stoppedAt);
  const endedAt = allTerminal ? finishedAt || ends.at(-1) || null : stoppedAt;
  const wallMs = startedAt && endedAt && Date.parse(endedAt) >= Date.parse(startedAt) ? Date.parse(endedAt) - Date.parse(startedAt) : null;
  const measured = items.filter((item) => item.durationMs !== null);
  const totals = Object.fromEntries(COUNT_FIELDS.map((field) => [field, {
    total: items.reduce((sum, item) => sum + (item.counts?.[field] || 0), 0),
    manifests: items.filter((item) => finite(item.counts?.[field]) !== null).length
  }]));
  const measuredRequests = items.filter((item) => item.requestPacing?.enabled === true && finite(item.requestPacing.requestCount) !== null);
  const actualNaverRequests = { total: measuredRequests.length ? measuredRequests.reduce((sum, item) => sum + item.requestPacing.requestCount, 0) : null,
    manifests: measuredRequests.length };
  return { date, stateExists: Boolean(day), status: !day ? "not_started" : allCompletedVerified ? "completed"
    : allTerminal ? "terminal_with_issues" : stoppedAt || day.blockedReason ? "stopped" : counts.running ? "in_progress" : "pending",
  counts, allTerminal, allCompletedVerified, startedAt, endedAt, finishedAt, stoppedAt,
  blockedReason: STOP_REASONS.has(day?.blockedReason) ? day.blockedReason : day?.blockedReason ? "other_recorded_stop" : null,
  wallMs, summedDurationMs: measured.length ? measured.reduce((sum, item) => sum + item.durationMs, 0) : null,
  timedItems: measured.length, lastObservedAt: ends.at(-1) || startedAt,
  freeBytesAtLastCheck: finite(day?.lastFreeBytes), diskCheckedAt: instant(day?.diskCheckedAt),
  countsFromManifests: totals, actualNaverRequests, items };
}

function comparisonFor(baseline, trial) {
  const items = baseline.items.map((before, index) => {
    const after = trial.items[index];
    const sameScope = before.scope !== null && after.scope !== null && JSON.stringify(before.scope) === JSON.stringify(after.scope);
    const comparable = before.verified && after.verified && sameScope;
    const deltaMs = comparable ? after.durationMs - before.durationMs : null;
    return { keyword: before.keyword, comparable,
      reason: comparable ? "same_scope_complete_quality" : !before.verified || !after.verified ? "not_both_verified_complete" : "scope_changed",
      baselineDurationMs: before.durationMs, trialDurationMs: after.durationMs,
      deltaMs, changePercent: comparable && before.durationMs > 0 ? Math.round(deltaMs / before.durationMs * 10000) / 100 : null };
  });
  const allComparable = items.every((item) => item.comparable);
  return { comparableKeywords: items.filter((item) => item.comparable).length,
    allComparable, wallDeltaMs: allComparable && baseline.wallMs !== null && trial.wallMs !== null ? trial.wallMs - baseline.wallMs : null,
    summedDurationDeltaMs: allComparable ? trial.summedDurationMs - baseline.summedDurationMs : null, items };
}

async function compareDailyCollection({ dataDir, baseline, trial }) {
  if (!dataDir || !validDate(baseline) || !validDate(trial) || baseline >= trial) throw new Error("invalid_comparison_arguments");
  let state;
  try { state = await readJson(path.join(path.resolve(dataDir), "history", "daily_keyword_collection_state.json")); }
  catch (error) { if (error.code === "ENOENT") state = { version: 1, days: {} }; else throw new Error("daily_collection_state_unreadable"); }
  if (state?.version !== 1 || !state.days || typeof state.days !== "object" || Array.isArray(state.days)) throw new Error("invalid_daily_collection_state");
  const [before, after] = await Promise.all([summarizeDay(state, baseline, dataDir), summarizeDay(state, trial, dataDir)]);
  const comparison = comparisonFor(before, after);
  // Scope/pacing are usually shared by all keywords. Store them once with small numeric references.
  const scopes = [], pacingProfiles = [], diagnostics = [];
  for (const day of [before, after]) for (const item of day.items) {
    for (const [key, pool] of [["scope", scopes], ["requestPacing", pacingProfiles], ["requestDiagnostics", diagnostics]]) {
      const value = item[key];
      if (value) {
        let index = pool.findIndex((entry) => JSON.stringify(entry) === JSON.stringify(value));
        if (index < 0) index = pool.push(value) - 1;
        item[`${key}Index`] = index;
      }
      delete item[key];
    }
  }
  return { baseline: before, trial: after, comparison, scopes, pacingProfiles, diagnostics,
    interpretation: {
      duration: "wallMs is first item start to recorded batch finish/stop; summedDurationMs is terminal item start/end durations, including failures but excluding interrupted recovery intervals",
      scheduleCounts: "naverSchedule* are schedule observation attempts/results; do not treat them as all HTTP request counts",
      pacingCounts: "requestPacing.requestCount is actual gated Naver HTTP starts; totalWaitMs is summed per-request queue delay, not added wall-clock time",
      running: "running is stored ledger state, not proof that a server process is currently active",
      causality: "Different code, weekday, inventory content and response conditions may change duration; this comparison alone does not prove the pacing effect",
      unrecordedCode: "A null codeVersion means the manifest did not record a commit; verify deployment history separately"
    } };
}

function parseArgs(args) {
  const result = {};
  const names = { "--data-dir": "dataDir", "--baseline": "baseline", "--trial": "trial" };
  for (let index = 0; index < args.length; index += 2) {
    const name = names[args[index]];
    if (!name || result[name] || !args[index + 1] || args[index + 1].startsWith("--")) throw new Error("invalid_comparison_arguments");
    result[name] = args[index + 1];
  }
  return result;
}

async function main(args = process.argv.slice(2)) {
  const result = await compareDailyCollection(parseArgs(args));
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (require.main === module) main().catch(() => { process.stderr.write("daily_collection_comparison_failed: check dates, data directory and saved state\n"); process.exitCode = 1; });
module.exports = { compareDailyCollection, parseArgs };
