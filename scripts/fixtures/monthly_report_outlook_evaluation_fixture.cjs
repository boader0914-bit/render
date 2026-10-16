"use strict";

// Isolated synthetic evaluation files for the monthly-report HTTP integration
// test. Only the local saved-result store is used; no provider or crawler runs.
const { createRegionalAnalysisStore } = require("../lib/regional_analysis_store.cjs");
const { buildRegionalOutlookEvaluation } = require("../lib/regional_outlook_evaluation.cjs");

const currentKstMonth = value => new Date(new Date(value).getTime() + 9 * 3600000).toISOString().slice(0, 7);
const shiftMonth = (value, offset) => new Date(Date.UTC(Number(value.slice(0, 4)), Number(value.slice(5)) - 1 + offset, 1)).toISOString().slice(0, 7);

function forecast(regionKey, { id, issueMonth, kind = "current", targetPeriod = "2026-08", groupKey = "visitors", metricKey = "averageDailyVisitors", unit = "명", value = 10 }) {
  const generatedAt = `${issueMonth}-02T00:00:00.000Z`;
  return { resultId: id, generatedAt, asOfDate: `${issueMonth}-02`, asOfMonth: issueMonth, modelVersion: "monthly-fixture-v1",
    scope: { regionKey, month: issueMonth }, sourceScope: { regionKey, month: shiftMonth(issueMonth, -1) },
    publication: { status: "published", publishedAt: generatedAt, proof: "journal", coverage: "recorded" },
    metrics: [{ groupKey, metricKey, label: "모의 지표", unit, provider: "한국관광공사", latestPeriod: shiftMonth(issueMonth, -1),
      forecasts: [{ period: targetPeriod, kind, status: "forecast", value }] }] };
}

async function seedMonthlyReportOutlookEvaluation(dataDir, regionKey, { actualValue = 0, now = new Date() } = {}) {
  const regionLabel = "경기도 포천시", evaluatedAt = new Date(now).toISOString();
  const forecasts = [
    forecast(regionKey, { id: "monthly-july-next", issueMonth: "2026-07", kind: "next", value: 15 }),
    forecast(regionKey, { id: "monthly-august-current", issueMonth: "2026-08" }),
    forecast(regionKey, { id: "monthly-pending", issueMonth: "2026-08", groupKey: "demandStrength", metricKey: "stayOverall", unit: "지수", value: 80 }),
    forecast(regionKey, { id: "monthly-excluded", issueMonth: "2026-08", groupKey: "resourceDemand", metricKey: "culture", unit: "지수", value: 30 }),
    forecast(regionKey, { id: "monthly-unrelated-september", issueMonth: "2026-09", targetPeriod: "2026-09", value: 999 })
  ];
  const observations = [{ scope: { regionKey, month: "2026-08" }, builtAt: evaluatedAt, sourceFingerprint: `monthly-fixture-actual-${actualValue}`,
    groups: [
      { key: "visitors", provider: "한국관광공사", periodType: "M", metrics: [{ key: "averageDailyVisitors", unit: "명", rows: [{ period: "2026-08", value: actualValue, status: "observed", retrievedAt: evaluatedAt }] }] },
      { key: "demandStrength", provider: "한국관광공사", periodType: "M", metrics: [{ key: "stayOverall", unit: "지수", rows: [{ period: "2026-08", value: 0, status: "publication_pending", retrievedAt: evaluatedAt }] }] },
      { key: "resourceDemand", provider: "한국관광공사", periodType: "M", metrics: [{ key: "culture", unit: "명", rows: [{ period: "2026-08", value: 0, status: "observed", retrievedAt: evaluatedAt }] }] }
    ] }];
  const store = createRegionalAnalysisStore({ dataDir, autoStart: false, now: () => new Date(now),
    directoryName: "regional_outlook_evaluation", calculationVersion: "regional-outlook-evaluation-storage-v1", defaultMonth: currentKstMonth,
    resolveRegion: async key => key === regionKey ? { regionKey, label: regionLabel } : null,
    buildSnapshot: async () => ({ ...buildRegionalOutlookEvaluation({ forecastSnapshots: forecasts, observationSnapshots: observations, asOfAt: evaluatedAt }),
      availableIssueMonths: ["2026-09", "2026-08", "2026-07"], cacheOnly: true }) });
  try {
    await store.request({ regionKey }, { collectMissing: false, reason: "test" });
    await store.waitForIdle();
    const saved = await store.get({ regionKey });
    if (saved.job?.status !== "completed" || !saved.snapshot) throw new Error("Synthetic saved evaluation fixture was not published");
    return saved.snapshot;
  } finally { await store.close(); }
}

module.exports = { seedMonthlyReportOutlookEvaluation };
