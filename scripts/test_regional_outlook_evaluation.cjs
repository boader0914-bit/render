"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { buildRegionalOutlookEvaluation, VERSION } = require("./lib/regional_outlook_evaluation.cjs");

const AS_OF = "2026-11-20T00:00:00Z";
function forecast({ id = "forecast-1", value = 100, issue = "2026-10", target = "2026-10", kind = "current", generatedAt = "2026-10-16T01:00:00Z", model = "model-v1",
  groupKey = "visitors", metricKey = "averageDailyVisitors", unit = "명", provider = "한국관광공사", latestPeriod = "2026-09", normalizationPeriod = "", sourceBatchId = "" } = {}) {
  return { resultId: id, generatedAt, asOfDate: new Date(Date.parse(generatedAt) + 9 * 3600000).toISOString().slice(0, 10), asOfMonth: issue, modelVersion: model,
    scope: { regionKey: "pocheon", month: issue }, sourceScope: { regionKey: "pocheon", month: latestPeriod }, sourceFingerprint: "forecast-source",
    publication: { status: "published", publishedAt: generatedAt, proof: "journal", coverage: "recorded" },
    metrics: [{ key: `${groupKey}:${metricKey}`, groupKey, metricKey, label: "테스트", unit, provider, latestPeriod, normalizationPeriod, sourceBatchId,
      forecasts: [{ period: target, kind, status: "forecast", value, method: "seasonal_naive" }] }] };
}
function observation({ value = 120, target = "2026-10", receivedAt = "2026-11-10T00:00:00Z", status = "observed", groupKey = "visitors", metricKey = "averageDailyVisitors",
  unit = "명", provider = "한국관광공사", normalizationPeriod = "", sourceBatchId = "", stale = false } = {}) {
  return { builtAt: receivedAt, sourceFingerprint: "actual-source", scope: { regionKey: "pocheon", month: target },
    groups: [{ key: groupKey, periodType: "M", provider, stale, normalizationPeriod, sourceBatchId, metrics: [{ key: metricKey, label: "공식값", unit,
      historyRows: [{ period: target, value, status, retrievedAt: receivedAt }] }] }] };
}
const evaluate = (forecasts = [forecast()], observations = [observation()], asOfAt = AS_OF) => buildRegionalOutlookEvaluation({ forecastSnapshots: forecasts, observationSnapshots: observations, asOfAt });

test("compares an issued forecast with a later exact official month and preserves provenance", () => {
  const result = evaluate(), row = result.rows[0];
  assert.equal(result.version, VERSION); assert.equal(result.status, "ready"); assert.equal(result.networkAttempted, false);
  assert.deepEqual(result.summaryCounts, { total: 1, compared: 1, pending: 0, excluded: 0 });
  assert.equal(row.forecastValue, 100); assert.equal(row.actualValue, 120); assert.equal(row.difference, 20); assert.equal(row.absoluteError, 20);
  assert.equal(row.errorPct, 16.666667); assert.equal(row.predictionRef.resultId, "forecast-1");
  assert.equal(row.predictionRef.selectionLabel, "보존된 발행본 중 첫 전망");
  assert.equal(row.actualRef.period, "2026-10"); assert.equal(row.actualRef.policy, "latest_official_as_of");
  assert.equal(result.scores[0].sampleCount, 1); assert.equal(result.scores[0].mae, 20); assert.equal(result.scores[0].wapePct, 16.666667);
});

test("normal actual zero is a real outcome with MAE, while WAPE's zero denominator remains unknown", () => {
  const result = evaluate([forecast({ value: 10 })], [observation({ value: 0 })]);
  const row = result.rows[0], score = result.scores[0];
  assert.equal(row.status, "compared"); assert.equal(row.actualValue, 0); assert.equal(row.difference, -10); assert.equal(row.absoluteError, 10);
  assert.equal(row.errorPct, null); assert.equal(row.percentageReasonCode, "ZERO_ACTUAL_DENOMINATOR");
  assert.equal(score.mae, 10); assert.equal(score.wapePct, null); assert.equal(score.wapeReasonCode, "ZERO_ACTUAL_DENOMINATOR"); assert.equal(score.actualZeroCount, 1);
});

test("partial, failed, missing, unpublished and stale zeros cannot masquerade as official outcomes", () => {
  for (const [status, reason] of [["partial", "ACTUAL_OBSERVATION_PARTIAL"], ["error", "ACTUAL_OBSERVATION_ERROR"], ["missing", "ACTUAL_OBSERVATION_MISSING"], ["publication_pending", "OFFICIAL_PUBLICATION_PENDING"]]) {
    const result = evaluate([forecast()], [observation({ status, value: 0 })]);
    assert.equal(result.rows[0].status, "pending"); assert.equal(result.rows[0].reasonCode, reason);
    assert.equal(result.rows[0].actualValue, null); assert.equal(result.rows[0].absoluteError, null); assert.equal(result.scores.length, 0);
  }
  const stale = evaluate([forecast()], [observation({ value: 0, stale: true })]);
  assert.equal(stale.rows[0].reasonCode, "STALE_ACTUAL_OBSERVATION"); assert.equal(stale.rows[0].actualValue, null);
});

test("a complete normalized row and an individual normal metric in a partial group remain usable", () => {
  const input = observation({ status: "complete", value: 0 }); input.groups[0].status = "partial";
  const result = evaluate([forecast({ value: 0 })], [input]);
  assert.equal(result.rows[0].status, "compared"); assert.equal(result.rows[0].actualValue, 0);
});

test("KST month must close before evaluation and a premature actual is not an official completed month", () => {
  const before = evaluate([forecast()], [observation({ value: 999 })], "2026-10-31T14:59:59Z");
  assert.equal(before.rows[0].reasonCode, "TARGET_MONTH_OPEN"); assert.equal(before.rows[0].actualValue, null);
  const premature = observation({ receivedAt: "2026-10-31T14:59:59Z" });
  const atClose = evaluate([forecast()], [premature], "2026-10-31T15:00:00Z");
  assert.equal(atClose.rows[0].reasonCode, "ACTUAL_RECEIVED_BEFORE_MONTH_CLOSED"); assert.equal(atClose.rows[0].status, "excluded");
});

test("future observation snapshots and future source receipt timestamps are never exposed as actuals", () => {
  let input = observation({ value: 999, receivedAt: "2026-11-21T00:00:00Z" });
  assert.equal(evaluate([forecast()], [input]).rows[0].status, "pending");
  input.builtAt = "2026-11-10T00:00:00Z";
  const result = evaluate([forecast()], [input]);
  assert.equal(result.rows[0].actualValue, null); assert.equal(result.rows[0].reasonCode, "OFFICIAL_OBSERVATION_NOT_AVAILABLE");
});

test("actual month, region, metric, unit, and provider must match exactly", () => {
  for (const change of [input => { input.scope.regionKey = "sancheong"; }, input => { input.groups[0].metrics[0].key = "visitorDays"; }, input => { input.groups[0].metrics[0].historyRows[0].period = "2026-09"; }]) {
    const input = observation(); change(input);
    assert.equal(evaluate([forecast()], [input]).rows[0].actualValue, null);
  }
  assert.equal(evaluate([forecast()], [observation({ unit: "인일" })]).rows[0].reasonCode, "UNIT_MISMATCH");
  assert.equal(evaluate([forecast()], [observation({ provider: "다른 제공기관" })]).rows[0].reasonCode, "PROVIDER_MISMATCH");
});

test("genuine issue-time checks reject postdated, replayed, already-observed and unproved forecasts", () => {
  const cases = [
    [input => { input.publication.status = "draft"; }, "PUBLICATION_NOT_PROVEN"],
    [input => { input.publication.proof = "unverified"; }, "PUBLICATION_NOT_PROVEN"],
    [input => { input.generatedAt = "2026-11-01T00:00:00Z"; input.publication.publishedAt = input.generatedAt; }, "ISSUE_TIME_MISMATCH"],
    [input => { input.asOfDate = "2026-09-16"; }, "ISSUE_TIME_MISMATCH"],
    [input => { input.metrics[0].forecasts[0].kind = "next"; }, "TARGET_KIND_MISMATCH"],
    [input => { input.metrics[0].latestPeriod = "2026-10"; }, "INPUT_PERIOD_NOT_VERIFIABLE"],
    [input => { input.sourceScope.month = "2026-10"; }, "INPUT_PERIOD_NOT_VERIFIABLE"],
    [input => { input.metrics[0].forecasts[0].status = "observed"; }, "ALREADY_OBSERVED_AT_ISSUE"],
    [input => { input.metrics[0].forecasts[0].status = "unavailable"; }, "FORECAST_NOT_PRODUCED"]
  ];
  for (const [change, reason] of cases) {
    const input = forecast(); change(input); const row = evaluate([input]).rows[0];
    assert.equal(row.status, "excluded"); assert.equal(row.reasonCode, reason); assert.equal(row.forecastValue, null); assert.equal(row.actualValue, null);
  }
});

test("source history can conservatively supply missing latest metadata, but future input observations cannot be hidden", () => {
  const input = forecast(); delete input.metrics[0].latestPeriod;
  input.metrics[0].historyRows = [{ period: "2026-09", status: "observed", value: 0 }];
  assert.equal(evaluate([input]).rows[0].status, "compared");
  input.metrics[0].historyRows.push({ period: "2026-10", status: "observed", value: 100 });
  assert.equal(evaluate([input]).rows[0].reasonCode, "INPUT_PERIOD_NOT_VERIFIABLE");
});

test("issue provenance rejects another region, a later as-of date and source values received after publication", () => {
  let input = forecast(); input.sourceScope.regionKey = "sancheong";
  assert.equal(evaluate([input]).rows[0].reasonCode, "INPUT_REGION_MISMATCH");
  input = forecast(); input.asOfDate = "2026-10-17";
  assert.equal(evaluate([input]).rows[0].reasonCode, "ISSUE_TIME_MISMATCH");
  input = forecast(); input.metrics[0].historyRows = [{ period: "2026-09", status: "observed", value: 0, retrievedAt: "2026-10-17T00:00:00Z" }];
  assert.equal(evaluate([input]).rows[0].reasonCode, "INPUT_RECEIVED_AFTER_PUBLICATION");
});

test("row error percentage is absolute while signed difference retains actual-minus-forecast direction", () => {
  const result = evaluate([forecast({ value: 110 })], [observation({ value: 100 })]);
  assert.equal(result.rows[0].difference, -10); assert.equal(result.rows[0].absoluteError, 10); assert.equal(result.rows[0].errorPct, 10);
});

test("the first retained publication is selected before seeing actual error and a model update does not multiply samples", () => {
  const first = forecast({ id: "first", value: 90, generatedAt: "2026-10-02T01:00:00Z" });
  const later = forecast({ id: "later", value: 119, generatedAt: "2026-10-25T01:00:00Z", model: "model-v2" });
  const result = evaluate([later, first]);
  assert.equal(result.rows.length, 1); assert.equal(result.rows[0].forecastValue, 90); assert.equal(result.rows[0].absoluteError, 30);
  assert.equal(result.rows[0].modelVersion, "model-v1"); assert.equal(result.rows[0].predictionRef.retainedPublicationCount, 2);
  assert.equal(result.scores[0].sampleCount, 1);
});

test("legacy saved references are labelled honestly and exact duplicate references do not add samples", () => {
  const input = forecast(); input.publication.proof = "saved_reference"; input.publication.coverage = "legacy_reference";
  const result = evaluate([input, structuredClone(input)]);
  assert.equal(result.rows.length, 1); assert.equal(result.rows[0].predictionRef.coverage, "legacy_reference");
  assert.equal(result.rows[0].predictionRef.selectionLabel, "보존된 발행본 중 첫 전망"); assert.equal(result.scores[0].sampleCount, 1);
});

test("latest official revision is chosen consistently, never the value most favourable to a forecast", () => {
  const first = observation({ value: 120 }), revision = observation({ value: 150, receivedAt: "2026-11-15T00:00:00Z" });
  revision.sourceFingerprint = "revision-source";
  const result = evaluate([forecast({ value: 119 })], [revision, first]);
  assert.equal(result.rows[0].actualValue, 150); assert.equal(result.rows[0].absoluteError, 31);
  assert.equal(result.rows[0].actualRef.firstObservedValue, 120); assert.equal(result.rows[0].actualRef.revised, true);
});

test("a newer failed or stale observation cannot be replaced by an older convenient normal outcome", () => {
  const first = observation({ value: 100 }), failed = observation({ value: 0, status: "error", receivedAt: "2026-11-15T00:00:00Z" });
  const result = evaluate([forecast()], [first, failed]);
  assert.equal(result.rows[0].status, "pending"); assert.equal(result.rows[0].reasonCode, "ACTUAL_OBSERVATION_ERROR");
  assert.equal(result.rows[0].actualValue, null); assert.equal(result.scores.length, 0);
});

test("duplicate target rows, duplicate metrics and conflicting same-time actuals are excluded", () => {
  let input = observation(); input.groups[0].metrics[0].historyRows.push({ ...input.groups[0].metrics[0].historyRows[0], value: 0 });
  assert.equal(evaluate([forecast()], [input]).rows[0].reasonCode, "DUPLICATE_ACTUAL_OBSERVATION");
  input = observation(); input.groups[0].metrics.push(structuredClone(input.groups[0].metrics[0]));
  assert.equal(evaluate([forecast()], [input]).rows[0].reasonCode, "DUPLICATE_ACTUAL_OBSERVATION");
  const result = evaluate([forecast()], [observation({ value: 100 }), observation({ value: 0 })]);
  assert.equal(result.rows[0].reasonCode, "CONFLICTING_ACTUAL_OBSERVATIONS"); assert.equal(result.rows[0].actualValue, null);
});

test("conflicting forecast content sharing a result ID and duplicate forecast targets cannot become a normal pair", () => {
  const one = forecast(), two = forecast({ value: 120 });
  let result = evaluate([one, two]);
  assert.ok(result.rows.every(row => row.reasonCode === "CONFLICTING_FORECAST_REFERENCE" && row.forecastValue === null));
  const duplicate = forecast(); duplicate.metrics[0].forecasts.push(structuredClone(duplicate.metrics[0].forecasts[0]));
  result = evaluate([duplicate]);
  assert.equal(result.scores.length, 0); assert.ok(result.rows.every(row => row.reasonCode === "DUPLICATE_FORECAST_OBSERVATION"));
});

test("search batches and normalization windows are checked as units of relative scale, never stitched", () => {
  const metadata = { groupKey: "searchTrend", metricKey: "interest", unit: "상대지수", provider: "네이버 데이터랩", sourceBatchId: "batch-before", normalizationPeriod: "2024-10-01 ~ 2026-09-30" };
  const prediction = forecast({ ...metadata, value: 50 });
  const actual = observation({ ...metadata, value: 55, sourceBatchId: "batch-after", normalizationPeriod: "2024-11-01 ~ 2026-10-31" });
  const result = evaluate([prediction], [actual]);
  assert.equal(result.rows[0].status, "excluded"); assert.equal(result.rows[0].reasonCode, "SEARCH_NORMALIZATION_NOT_COMPARABLE");
  assert.equal(result.scores.length, 0); assert.equal(result.rows[0].actualValue, null);
  delete prediction.metrics[0].sourceBatchId;
  assert.equal(evaluate([prediction], [actual]).rows[0].reasonCode, "UNSUPPORTED_SEARCH_NORMALIZATION");
});

test("current-month nowcasts and next-month forecasts remain separate cohorts even for the same actual month", () => {
  const nowcast = forecast({ id: "october-current", value: 100 });
  const ahead = forecast({ id: "september-next", issue: "2026-09", target: "2026-10", kind: "next", value: 80,
    generatedAt: "2026-09-16T01:00:00Z", latestPeriod: "2026-08" });
  const result = evaluate([nowcast, ahead]);
  assert.equal(result.rows.length, 2); assert.equal(result.scores.length, 2);
  assert.deepEqual(result.scores.map(score => score.kind).sort(), ["current", "next"]);
  assert.ok(result.scores.every(score => score.sampleCount === 1));
});

test("evaluation is deterministic and receive-time-only changes do not create another calculation fingerprint", () => {
  const input = forecast(), actual = observation(), before = JSON.stringify([input, actual]);
  const first = evaluate([input], [actual]);
  actual.builtAt = "2026-11-15T00:00:00Z"; actual.groups[0].metrics[0].historyRows[0].retrievedAt = actual.builtAt; actual.sourceFingerprint = "timestamp-only-refresh";
  const repeated = evaluate([input], [actual], "2026-11-21T00:00:00Z");
  assert.equal(repeated.sourceFingerprint, first.sourceFingerprint);
  assert.notEqual(repeated.rows[0].actualRef.receivedAt, first.rows[0].actualRef.receivedAt);
  actual.groups[0].metrics[0].historyRows[0].value = 121;
  assert.notEqual(evaluate([input], [actual]).sourceFingerprint, first.sourceFingerprint);
  assert.equal(JSON.stringify([input, observation()]), before);
});

test("KST issue boundaries use the actual instant, and as-of requires an explicit valid ISO timezone", () => {
  const input = forecast({ generatedAt: "2026-09-30T15:01:00Z" }); input.asOfDate = "2026-10-01";
  assert.equal(evaluate([input]).rows[0].status, "compared");
  input.generatedAt = "2026-09-30T14:59:00Z"; input.publication.publishedAt = input.generatedAt;
  assert.equal(evaluate([input]).rows[0].reasonCode, "ISSUE_TIME_MISMATCH");
  for (const asOfAt of [undefined, "2026-11-20", "2026-11-20T00:00:00", "2026-02-30T00:00:00Z"]) {
    assert.throws(() => buildRegionalOutlookEvaluation({ asOfAt }), error => error.code === "INVALID_EVALUATION_AS_OF");
  }
});

test("empty saved inputs stay missing with no fabricated accuracy score and unsafe unknown fields are not copied", () => {
  const empty = evaluate([], []);
  assert.equal(empty.status, "missing"); assert.deepEqual(empty.groups, []); assert.deepEqual(empty.scores, []);
  assert.deepEqual(empty.summaryCounts, { total: 0, compared: 0, pending: 0, excluded: 0 });
  const input = forecast(); input.error = "token=DO_NOT_COPY"; input.credentials = { password: "DO_NOT_COPY" };
  const actual = observation(); actual.groups[0].metrics[0].historyRows[0].error = "DO_NOT_COPY";
  assert.doesNotMatch(JSON.stringify(evaluate([input], [actual])), /DO_NOT_COPY|password|token=/);
});
