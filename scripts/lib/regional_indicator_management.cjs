"use strict";

// A projection of saved evidence only. No filesystem, timers, providers, or
// recalculation of indicators belong in this module.
const MONTH = /^20\d{2}-(0[1-9]|1[0-2])$/;
const YEAR = /^20\d{2}$/;
const REASONS = new Set(["NO_DATA", "NOT_COLLECTED", "PUBLICATION_PENDING", "PARTIAL_DATA", "MISSING_VALUES", "SUPPRESSED", "AUTH_ERROR", "MISSING_KEY",
  "QUOTA_EXCEEDED", "TIMEOUT", "NETWORK_ERROR", "CACHE_READ_ERROR", "CACHE_WRITE_ERROR", "EVIDENCE_WRITE_ERROR", "INVALID_RESPONSE", "REGION_MISMATCH", "PERIOD_MISMATCH",
  "COOLDOWN", "PROVIDER_FAILED", "PROVIDER_UNAVAILABLE", "REGIONAL_SOURCE_BUSY", "MAPPING_MISSING", "REGIONAL_SOURCE_UNAVAILABLE",
  "REGIONAL_BUILD_FAILED", "REGIONAL_NO_DATA", "REGIONAL_REFRESH_INTERRUPTED", "PREPARATION_INTERRUPTED", "REGIONAL_STORE_UNAVAILABLE", "REGIONAL_SCOPE_CLOSED"]);
const ACTIVE = new Set(["queued", "running", "processing"]);
const GOOD = new Set(["ready", "complete", "completed", "observed"]);
const FAILED = new Set(["failed", "error", "blocked", "interrupted"]);
const numeric = value => typeof value === "number" && Number.isFinite(value) && value >= 0;
const text = value => typeof value === "string" ? value.slice(0, 300) : "";
const stamp = value => typeof value === "string" && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const period = value => typeof value === "string" && MONTH.test(value) ? value : typeof value === "string" && /^20\d{2}(0[1-9]|1[0-2])$/.test(value) ? `${value.slice(0, 4)}-${value.slice(4)}` : "";
const safeReason = value => value === "response_evidence_storage_failed" ? "EVIDENCE_WRITE_ERROR" : REASONS.has(value) ? value : "";
const shift = (value, offset) => new Date(Date.UTC(Number(value.slice(0, 4)), Number(value.slice(5)) - 1 + offset, 1)).toISOString().slice(0, 7);
const distance = (from, to) => (Number(to.slice(0, 4)) - Number(from.slice(0, 4))) * 12 + Number(to.slice(5)) - Number(from.slice(5));
const maxStamp = values => values.map(stamp).filter(Boolean).sort().at(-1) || null;
const normal = row => GOOD.has(row?.status) && numeric(row?.value);
function state(row) {
  if (normal(row)) return "observed";
  if (row?.status === "suppressed") return "suppressed";
  if (row?.status === "publication_pending") return "publication_pending";
  if (row?.status === "partial") return "partial";
  if (FAILED.has(row?.status)) return "failed";
  return "missing";
}
function issue(row) {
  const code = row?.status === "suppressed" ? "SUPPRESSED" : safeReason(row?.reasonCode) || safeReason(row?.errorCode);
  return { reasonCode: code || "UNRECORDED_REASON", reasonEvidence: code ? "recorded" : "unknown" };
}
function safePoint(row, fallbackPeriod) {
  const status = state(row);
  return { period: period(row?.period) || fallbackPeriod, status, value: status === "observed" ? row.value : null,
    ...(status === "observed" ? { reasonCode: "", reasonEvidence: "recorded" } : issue(row)),
    retrievedAt: stamp(row?.retrievedAt), refreshErrorCode: safeReason(row?.refreshErrorCode) };
}
function historyJobs(input, job) {
  const rows = Array.isArray(input) ? input : Array.isArray(input?.jobs) ? input.jobs : [];
  const byId = new Map();
  for (const item of [...rows, job]) if (item && typeof item === "object" && typeof item.id === "string") byId.set(item.id, item);
  return [...byId.values()].sort((a, b) => (Number.isSafeInteger(b.sequence) ? b.sequence : 0) - (Number.isSafeInteger(a.sequence) ? a.sequence : 0)
    || String(stamp(b.queuedAt) || stamp(b.startedAt) || stamp(b.finishedAt) || "").localeCompare(String(stamp(a.queuedAt) || stamp(a.startedAt) || stamp(a.finishedAt) || "")));
}
function stepsOf(job) {
  return Array.isArray(job?.refreshDiagnostics?.steps) ? job.refreshDiagnostics.steps : Array.isArray(job?.steps) ? job.steps : [];
}
function stepFor(job, key) { return stepsOf(job).find(step => step?.key === key) || null; }
function refreshView(job, key) {
  if (!job) return { status: "never", jobId: null, kind: null, scope: "regional_bundle", queuedAt: null, startedAt: null, finishedAt: null, errorCode: "", networkAttempted: null };
  const step = key ? stepFor(job, key) : null;
  const diagnostics = job.refreshDiagnostics;
  const diagnosticState = ["partial", "failed", "interrupted"].includes(diagnostics?.status) ? diagnostics.status : "";
  const status = ACTIVE.has(job.status) ? job.status : step?.status || diagnosticState || text(job.status) || "unknown";
  const network = step && typeof step.networkAttempted === "boolean" ? step.networkAttempted
    : typeof job.networkAttempted === "boolean" ? job.networkAttempted
      : stepsOf(job).some(item => item.networkAttempted === true) ? true
        : stepsOf(job).length && stepsOf(job).every(item => item.networkAttempted === false) ? false : null;
  return { status, jobId: text(job.id) || null, kind: job.collectMissing === true ? "provider" : "local", scope: step ? "indicator_group" : "regional_bundle",
    queuedAt: stamp(job.queuedAt || job.createdAt), startedAt: stamp(step?.startedAt) || stamp(job.startedAt),
    finishedAt: ACTIVE.has(job.status) ? null : stamp(step?.finishedAt) || stamp(job.finishedAt),
    errorCode: safeReason(step?.errorCode) || safeReason(job.errorCode), networkAttempted: network };
}
function successAt(jobs, key) {
  for (const job of jobs) {
    if (job.collectMissing !== true || !GOOD.has(job.status) || !key && ["partial", "failed", "interrupted"].includes(job.refreshDiagnostics?.status)) continue;
    const steps = key ? [stepFor(job, key)].filter(Boolean) : stepsOf(job);
    if (!steps.length || !steps.every(step => GOOD.has(step.status) && !safeReason(step.errorCode)) || !steps.some(step => step.networkAttempted === true)) continue;
    const time = maxStamp(steps.map(step => step.finishedAt)) || stamp(job.finishedAt);
    if (time) return time;
  }
  return null;
}

function buildRegionalIndicatorManagement({ snapshot = null, scope = {}, job = null, policy = null, refreshHistory = [], now = new Date() } = {}) {
  const validScope = scope && typeof scope === "object" ? scope : {};
  const sourceScope = snapshot?.scope || validScope;
  const through = period(validScope.month) || period(sourceScope.month);
  const count = [13, 24].includes(Number(validScope.months || sourceScope.months)) ? Number(validScope.months || sourceScope.months) : 13;
  const effectiveRegion = validScope.regionKey || sourceScope.regionKey;
  const jobs = historyJobs(refreshHistory, job).filter(item => item.collectMissing === true
    && (!item.scope?.regionKey || !effectiveRegion || item.scope.regionKey === effectiveRegion)
    && (!item.scope?.months || Number(item.scope.months) === count)), lastProvider = jobs[0] || null;
  const groups = (Array.isArray(snapshot?.groups) ? snapshot.groups : []).map(group => {
    const monthly = group.periodType === "M" && group.key !== "kosis" && group.category !== "background";
    const requestedThrough = period(group.requestedThrough) || through;
    const metrics = (Array.isArray(group.metrics) ? group.metrics : []).map(metric => {
      const rawRows = Array.isArray(metric.rows) ? metric.rows : [];
      const duplicatePeriods = new Set(rawRows.map(row => period(row.period) || row.period).filter((value, index, values) => values.indexOf(value) !== index));
      const observedRows = rawRows.filter(row => normal(row) && !duplicatePeriods.has(period(row.period) || row.period)
        && (!monthly || !requestedThrough || period(row.period) && period(row.period) <= requestedThrough));
      const latestRow = observedRows.filter(row => monthly ? Boolean(period(row.period)) : Boolean(period(row.period) || YEAR.test(row.period || "")))
        .sort((a, b) => String(a.period).localeCompare(String(b.period))).at(-1);
      const explicitLatest = monthly ? period(metric.latestPeriod) : period(metric.latestPeriod) || (YEAR.test(metric.latestPeriod || "") ? metric.latestPeriod : "");
      const canUseLegacy = !rawRows.length && explicitLatest && (!monthly || !requestedThrough || explicitLatest <= requestedThrough)
        && numeric(metric.latestValue) && !FAILED.has(metric.status) && !["missing", "publication_pending", "suppressed"].includes(metric.status);
      const latestPeriod = latestRow ? monthly ? period(latestRow.period) : latestRow.period : canUseLegacy ? explicitLatest : "";
      const latestValue = latestRow ? latestRow.value : canUseLegacy ? metric.latestValue : null;
      const sourceRetrievedAt = maxStamp(observedRows.map(row => row.retrievedAt));
      let coverage, gaps = [], requested;
      if (monthly) {
        const end = latestPeriod || requestedThrough;
        const wanted = end ? Array.from({ length: count }, (_, index) => shift(end, index + 1 - count)) : [];
        const rows = wanted.map(month => {
          const matches = rawRows.filter(row => period(row.period) === month);
          return matches.length > 1 ? { period: month, status: "failed", value: null, reasonCode: "INVALID_RESPONSE", reasonEvidence: "recorded" }
            : safePoint(matches[0], month);
        });
        const observed = rows.filter(row => row.status === "observed").length;
        gaps = rows.filter(row => row.status !== "observed").map(({ period, status, reasonCode, reasonEvidence }) => ({ period, status, reasonCode, reasonEvidence }));
        coverage = { kind: "months", observed, expected: count, ratioPct: Math.round(observed / count * 1000) / 10,
          startPeriod: wanted[0] || null, endPeriod: end || null, partial: rows.filter(row => row.status === "partial").length,
          failed: rows.filter(row => row.status === "failed").length, missing: rows.filter(row => row.status === "missing").length,
          publicationPending: rows.filter(row => row.status === "publication_pending").length,
          suppressed: rows.filter(row => row.status === "suppressed").length };
        const requestRows = rawRows.filter(row => period(row.period) === requestedThrough);
        const requestPoint = requestRows.length > 1 ? { period: requestedThrough, status: "failed", reasonCode: "INVALID_RESPONSE" }
          : metric.requestedPoint && period(metric.requestedPoint.period) === requestedThrough ? metric.requestedPoint
            : requestRows.length === 1 ? requestRows[0] : canUseLegacy && latestPeriod === requestedThrough ? { period: requestedThrough, status: "observed", value: latestValue } : null;
        requested = safePoint(requestPoint, requestedThrough);
        // Old snapshots kept only the latest-normal-ended window. Their
        // group-level requested-month evidence may still identify the cause.
        if (!requestPoint && period(group.latestRequestedPeriod) === requestedThrough && group.latestRequestedStatus) {
          requested = safePoint({ period: requestedThrough, status: group.latestRequestedStatus,
            reasonCode: safeReason(group.latestRequestedErrorCode) }, requestedThrough);
        }
      } else {
        const observed = numeric(latestValue) ? 1 : 0;
        const suppressed = rawRows.filter(row => row?.status === "suppressed");
        coverage = { kind: "items", observed, expected: 1, ratioPct: observed * 100, startPeriod: null, endPeriod: latestPeriod || null,
          suppressed: suppressed.length };
        gaps = suppressed.map(row => ({ period: period(row.period) || (YEAR.test(row.period || "") ? row.period : ""),
          status: "suppressed", reasonCode: "SUPPRESSED", reasonEvidence: "recorded" }));
        requested = null;
      }
      const lagMonths = monthly && latestPeriod && requestedThrough ? Math.max(0, distance(latestPeriod, requestedThrough)) : null;
      const refreshErrorCode = safeReason(metric.requestedPoint?.refreshErrorCode) || observedRows.map(row => safeReason(row.refreshErrorCode)).find(Boolean) || "";
      const needsReview = coverage.observed < coverage.expected || monthly && requested?.status !== "observed"
        || Boolean(group.stale || group.refresh || refreshErrorCode || safeReason(group.errorCode));
      return { key: text(metric.key), label: text(metric.label), unit: text(metric.unit), periodType: monthly ? "M" : metric.periodType || "mixed",
        latestPeriod, latestValue, sourceRetrievedAt, lagMonths, requestedThrough: monthly ? requestedThrough : null, coverage, gaps,
        requested: requested ? { period: requested.period, status: requested.status, reasonCode: requested.reasonCode, reasonEvidence: requested.reasonEvidence } : null,
        observedZeroMonths: monthly ? observedRows.filter(row => row.value === 0).length : null, refreshErrorCode, needsReview: Boolean(needsReview) };
    });
    const monthlyMetrics = metrics.filter(metric => metric.coverage.kind === "months");
    const hasData = metrics.some(metric => numeric(metric.latestValue));
    const latestPeriods = [...new Set(metrics.map(metric => metric.latestPeriod).filter(Boolean))].sort();
    const observed = monthly ? monthlyMetrics.length ? Math.min(...monthlyMetrics.map(metric => metric.coverage.observed)) : 0
      : metrics.reduce((sum, metric) => sum + metric.coverage.observed, 0);
    const expected = monthly ? count : metrics.reduce((sum, metric) => sum + metric.coverage.expected, 0);
    const requests = monthlyMetrics.map(metric => metric.requested);
    const requestedStatus = requests.length && requests.every(item => item?.status === "observed") ? "observed"
      : requests.some(item => item?.status === "observed") ? "partial" : requests.some(item => item?.status === "failed") ? "failed"
        : requests.some(item => item?.status === "publication_pending") ? "publication_pending"
          : requests.length && requests.every(item => item?.status === "suppressed") ? "suppressed" : "missing";
    const requestedIssue = requests.find(item => item?.reasonEvidence === "recorded" && item.reasonCode) || requests.find(item => item?.reasonCode);
    const needsReview = metrics.some(metric => metric.needsReview) || Boolean(group.stale || group.refresh || safeReason(group.errorCode));
    const status = !hasData ? FAILED.has(group.status) ? "failed" : "missing" : needsReview ? "partial" : "ready";
    const groupJob = lastProvider;
    return { key: text(group.key), label: text(group.label), periodType: group.periodType || "mixed", status, dataStatus: text(group.status),
      latestPeriod: monthly ? latestPeriods.at(-1) || "" : text(group.latestPeriod), latestPeriods,
      requestedThrough: monthly ? requestedThrough : null, lagMonths: monthly && monthlyMetrics.some(metric => metric.lagMonths !== null) ? Math.max(...monthlyMetrics.map(metric => metric.lagMonths || 0)) : null,
      coverage: { kind: monthly ? "months" : "items", observed, expected, ratioPct: expected ? Math.round(observed / expected * 1000) / 10 : null,
        startPeriod: monthlyMetrics.length === 1 ? monthlyMetrics[0].coverage.startPeriod : null,
        endPeriod: monthlyMetrics.length === 1 ? monthlyMetrics[0].coverage.endPeriod : null, perMetricWindows: monthlyMetrics.length > 1 },
      requested: monthly ? { period: requestedThrough, status: requestedStatus, reasonCode: requestedStatus === "observed" ? "" : requestedIssue?.reasonCode || "UNRECORDED_REASON",
        reasonEvidence: requestedStatus === "observed" ? "recorded" : requestedIssue?.reasonEvidence || "unknown" } : null,
      sourceRetrievedAt: maxStamp(metrics.map(metric => metric.sourceRetrievedAt)), stale: group.stale === true,
      errorCode: safeReason(group.lastRefreshErrorCode) || safeReason(group.errorCode) || metrics.map(metric => metric.refreshErrorCode).find(Boolean) || "", needsReview,
      metrics, refresh: { ...refreshView(groupJob, group.key), lastSuccessAt: successAt(jobs, group.key) } };
  });
  const monthlyMetrics = groups.flatMap(group => group.metrics).filter(metric => metric.coverage.kind === "months");
  const checkedAt = stamp(now instanceof Date ? now.toISOString() : typeof now === "function" ? new Date(now()).toISOString() : String(now));
  const nextRunAt = policy?.enabled === true ? stamp(policy.nextRunAt) : null;
  return { schemaVersion: 1, scope: { regionKey: text(validScope.regionKey || sourceScope.regionKey), label: text(validScope.label || sourceScope.label), month: through, months: count },
    result: { resultId: text(snapshot?.resultId) || null, generatedAt: stamp(snapshot?.generatedAt || snapshot?.builtAt), status: text(snapshot?.status) || "missing", stale: groups.some(group => group.stale) },
    groups, summary: { groups: groups.length, ready: groups.filter(group => group.status === "ready").length, partial: groups.filter(group => group.status === "partial").length,
      missing: groups.filter(group => group.status === "missing").length, failed: groups.filter(group => group.status === "failed").length,
      monthlyMetrics: monthlyMetrics.length, completeMonthlyMetrics: monthlyMetrics.filter(metric => metric.coverage.observed === metric.coverage.expected).length,
      unavailableMetrics: monthlyMetrics.filter(metric => !numeric(metric.latestValue)).length, reviewMetrics: monthlyMetrics.filter(metric => metric.needsReview).length },
    refresh: { current: refreshView(job), lastProvider: refreshView(lastProvider), lastSuccessAt: successAt(jobs),
      schedule: { enabled: policy?.enabled === true, nextRunAt,
        status: policy?.enabled !== true ? "disabled" : !nextRunAt || !checkedAt ? "unknown" : nextRunAt <= checkedAt ? "due" : "scheduled",
        lastDueAt: stamp(policy?.lastRunAt), scope: "regional_bundle" } },
    checkedAt };
}

module.exports = { buildRegionalIndicatorManagement };
