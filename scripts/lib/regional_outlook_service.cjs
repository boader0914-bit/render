"use strict";

const { createRegionalAnalysisStore } = require("./regional_analysis_store.cjs");
const { buildRegionalOutlook } = require("./regional_outlook.cjs");
const { loadRegionalOutlookCalendar, requiredRegionalOutlookYears } = require("./regional_outlook_calendar.cjs");
const { shiftMonth } = require("./regional_analysis_snapshot.cjs");
const { createRegionalOutlookEvaluationService } = require("./regional_outlook_evaluation_service.cjs");

const STORAGE_VERSION = "regional-outlook-storage-v1";
const currentKstMonth = value => new Date(new Date(value).getTime() + 9 * 3600000).toISOString().slice(0, 7);
const safeStep = step => ({ key: step.key, status: step.status, errorCode: /^[A-Z0-9_]{1,80}$/.test(step.errorCode || "") ? step.errorCode : "",
  networkAttempted: typeof step.networkAttempted === "boolean" ? step.networkAttempted : null });

function createRegionalOutlookService({ dataDir, resolveRegion, readIndicators, prepareIndicators, specialDays,
  now = () => new Date(), autoStart = true }) {
  if (typeof readIndicators !== "function") throw new TypeError("Cache-only indicator reader required");
  async function buildSnapshot(scope, { collectMissing = false } = {}) {
    const sourceScope = { ...scope, month: shiftMonth(scope.month, -1) };
    let preparation = null;
    if (collectMissing) {
      if (typeof prepareIndicators !== "function") throw Object.assign(new Error("Preparation unavailable"), { code: "REGIONAL_SOURCE_UNAVAILABLE" });
      preparation = await prepareIndicators(sourceScope);
      const relevantSteps = (preparation?.steps || []).filter(step => step.key !== "kosis");
      if (["failed", "interrupted", "error"].includes(preparation?.status)
        || relevantSteps.length && relevantSteps.every(step => ["failed", "error", "blocked"].includes(step.status))) {
        throw Object.assign(new Error("Source refresh failed"), { code: "REGIONAL_SOURCE_UNAVAILABLE" });
      }
    }
    const indicators = await readIndicators(sourceScope, { collectMissing: false });
    if (indicators?.networkAttempted === true || indicators?.refreshRequested === true) {
      throw Object.assign(new Error("Cache-only indicator contract"), { code: "REGIONAL_SOURCE_UNAVAILABLE" });
    }
    if ((indicators?.groups || []).length && indicators.groups.every(group => ["failed", "error", "blocked"].includes(group.status))) {
      throw Object.assign(new Error("Source unavailable"), { code: "REGIONAL_SOURCE_UNAVAILABLE" });
    }
    const observed = (indicators?.groups || []).filter(group => group.key !== "kosis").some(group => (group.metrics || [])
      .some(metric => (metric.historyRows || metric.rows || []).some(row => ["observed", "complete"].includes(row.status)
        && typeof row.value === "number" && Number.isFinite(row.value) && row.value >= 0)));
    if (!observed) throw Object.assign(new Error("No stored observations"), { code: "REGIONAL_NO_DATA" });
    const periods = [...new Set([scope.month, shiftMonth(scope.month, 1), ...(indicators?.groups || [])
      .filter(group => group.key !== "kosis").flatMap(group => (group.metrics || []).flatMap(metric => (metric.historyRows || metric.rows || []).map(row => row.period)))])];
    const calendarAttempts = [];
    if (collectMissing && typeof specialDays?.getYear === "function") {
      // Existing annual cache TTL, shared in-flight request and provider retry
      // cooldown remain in force. No unconditional forced refresh per region.
      for (const year of requiredRegionalOutlookYears(periods)) {
        try {
          const result = await specialDays.getYear(year);
          calendarAttempts.push({ year, status: result?.categories?.holidays?.status || "error", networkAttempted: result?.networkAttempted === true });
        } catch (_) { calendarAttempts.push({ year, status: "error", networkAttempted: null }); }
      }
    }
    const calendar = await loadRegionalOutlookCalendar({ specialDays, periods });
    const today = new Date(new Date(now()).getTime() + 9 * 3600000).toISOString().slice(0, 10);
    const outlook = buildRegionalOutlook({ snapshot: indicators, calendar,
      asOfDate: today.startsWith(scope.month) ? today : `${scope.month}-01` });
    const steps = (preparation?.steps || []).map(safeStep), attempts = [...steps, ...calendarAttempts];
    const incomplete = preparation?.status === "partial" || steps.some(step => ["failed", "error", "blocked", "partial", "missing", "publication_pending", "stale"].includes(step.status))
      || calendarAttempts.some(item => !["ready", "complete", "completed"].includes(item.status));
    const refreshDiagnostics = collectMissing ? { status: incomplete ? "partial" : "completed", steps, calendars: calendarAttempts } : null;
    return { ...outlook, forecastSummary: outlook.summary, sourceScope, calendar, sourceIndicatorFingerprint: indicators?.sourceFingerprint || "",
      sourceIndicatorVersion: indicators?.indicatorVersion || "", refreshRequested: collectMissing,
      networkAttempted: collectMissing ? attempts.some(item => item.networkAttempted === true) ? true : attempts.some(item => item.networkAttempted === null) ? null : false : false,
      refreshDiagnostics, preparation: preparation ? { id: preparation.id, status: preparation.status, finishedAt: preparation.finishedAt, steps, calendars: calendarAttempts } : null };
  }
  const validation = createRegionalOutlookEvaluationService({ dataDir, resolveRegion, readIndicators, now, autoStart });
  const publishing = new Set();
  const store = createRegionalAnalysisStore({ dataDir, resolveRegion, buildSnapshot, now, autoStart,
    directoryName: "regional_outlook", calculationVersion: STORAGE_VERSION, defaultMonth: currentKstMonth,
    retainFailedGroups: false, rollForward: true, isMutableScope: scope => scope.month === currentKstMonth(now()),
    onResultSaved: async snapshot => {
      publishing.add(snapshot.scope.regionKey);
      try { await validation.recordPublication(snapshot); }
      finally { publishing.delete(snapshot.scope.regionKey); }
    } });
  function assertCurrent(input) {
    if (input?.month && input.month !== currentKstMonth(now())) throw Object.assign(new Error("Past outlook is read only"), { code: "REGIONAL_PAST_OUTLOOK_READ_ONLY", statusCode: 400 });
  }
  async function request(input, options) { assertCurrent(input); return store.request(input, options); }
  async function sourceChanged(event) {
    const result = await store.sourceChanged(event);
    await validation.sourceChanged(event);
    return result;
  }
  async function calendarChanged(sourceVersion, year = "all") {
    const sourceKey = `specialDays:${/^20\d{2}$/.test(String(year)) ? year : "all"}`;
    for (const regionKey of await store.trackedRegions()) await sourceChanged({ regionKey, sourceKey, sourceVersion });
  }
  async function get(input) {
    const result = await store.get(input);
    const evaluation = await validation.get({ regionKey: result.scope.regionKey, months: 13 });
    return { ...result, validation: { ...evaluation, publicationPending: publishing.has(result.scope.regionKey) } };
  }
  async function tick() { const result = await store.tick(); await validation.tick(); return result; }
  async function waitForIdle() { await store.waitForIdle(); await validation.waitForIdle(); }
  async function close() { await store.close(); await validation.close(); }
  return { ...store, get, request, sourceChanged, calendarChanged, tick, waitForIdle, close, validation };
}

module.exports = { createRegionalOutlookService, currentKstMonth, STORAGE_VERSION };
