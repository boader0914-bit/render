"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { buildRegionalIndicatorManagement } = require("./lib/regional_indicator_management.cjs");
const scope = { regionKey: "pocheon", label: "경기도 포천시", month: "2026-09", months: 13 };
const shift = (month, offset) => new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5)) - 1 + offset, 1)).toISOString().slice(0, 7);
const rows = (end = scope.month) => Array.from({ length: 13 }, (_, i) => ({ period: shift(end, i - 12), status: "observed", value: i,
  retrievedAt: "2026-10-01T00:00:00Z", reasonCode: "", reasonEvidence: "recorded" }));
function snapshot(end = scope.month) {
  return { scope, resultId: "result-test", generatedAt: "2026-10-15T00:00:00Z", status: "ready", groups: [{ key: "visitors", label: "지역 방문자", category: "tourism",
    periodType: "M", status: "ready", requestedThrough: scope.month, metrics: [{ key: "daily", label: "일평균 방문자", unit: "명", rows: rows(end),
      latestPeriod: end, latestValue: 12 }] }] };
}
const providerJob = (sequence, overrides = {}) => ({ id: `provider-${sequence}`, sequence, collectMissing: true, scope, status: "completed",
  queuedAt: `2026-10-${String(sequence).padStart(2, "0")}T00:00:00Z`, startedAt: `2026-10-${String(sequence).padStart(2, "0")}T00:01:00Z`,
  finishedAt: `2026-10-${String(sequence).padStart(2, "0")}T00:02:00Z`, refreshDiagnostics: { status: "completed", steps: [
    { key: "visitors", status: "ready", networkAttempted: true, errorCode: "" }, { key: "searchTrend", status: "ready", networkAttempted: true, errorCode: "" }] }, ...overrides });
const build = options => buildRegionalIndicatorManagement({ snapshot: snapshot(), scope, now: new Date("2026-10-16T00:00:00Z"), ...options });

test("projects saved monthly coverage, normal zeros and source timestamps without mutating inputs", () => {
  const input = snapshot(), before = JSON.stringify(input), result = build({ snapshot: input });
  const metric = result.groups[0].metrics[0];
  assert.equal(result.schemaVersion, 1); assert.equal(metric.coverage.observed, 13); assert.equal(metric.coverage.expected, 13);
  assert.equal(metric.coverage.ratioPct, 100); assert.equal(metric.observedZeroMonths, 1);
  assert.equal(metric.requested.status, "observed"); assert.equal(metric.lagMonths, 0); assert.deepEqual(metric.gaps, []);
  assert.equal(metric.sourceRetrievedAt, "2026-10-01T00:00:00.000Z");
  assert.equal(result.result.generatedAt, "2026-10-15T00:00:00.000Z");
  assert.equal(result.summary.completeMonthlyMetrics, 1); assert.equal(result.summary.reviewMetrics, 0);
  assert.equal(JSON.stringify(input), before);
});

test("13/13 latest-normal coverage does not imply the requested completed month is available", () => {
  const input = snapshot("2026-08"), metric = input.groups[0].metrics[0];
  metric.requestedPoint = { period: "2026-09", status: "publication_pending", value: null, reasonCode: "PUBLICATION_PENDING", reasonEvidence: "recorded" };
  const result = build({ snapshot: input }), group = result.groups[0];
  assert.equal(group.metrics[0].coverage.observed, 13); assert.equal(group.metrics[0].coverage.endPeriod, "2026-08");
  assert.equal(group.metrics[0].lagMonths, 1); assert.equal(group.metrics[0].requested.status, "publication_pending");
  assert.equal(group.status, "partial"); assert.equal(group.stale, false); assert.equal(group.requested.reasonCode, "PUBLICATION_PENDING");
  assert.equal(result.summary.completeMonthlyMetrics, 1); assert.equal(result.summary.reviewMetrics, 1);
});

test("legacy missing requested month remains unknown, never inferred as unpublished or zero", () => {
  const result = build({ snapshot: snapshot("2026-08") }), requested = result.groups[0].metrics[0].requested;
  assert.equal(requested.status, "missing"); assert.equal(requested.reasonCode, "UNRECORDED_REASON"); assert.equal(requested.reasonEvidence, "unknown");
  assert.equal(result.groups[0].metrics[0].latestValue, 12);
});

test("safe legacy group requested diagnostics bind only to their exact month", () => {
  const input = snapshot("2026-08");
  Object.assign(input.groups[0], { latestRequestedPeriod: "202609", latestRequestedStatus: "failed", latestRequestedErrorCode: "AUTH_ERROR" });
  assert.equal(build({ snapshot: input }).groups[0].metrics[0].requested.reasonCode, "AUTH_ERROR");
  input.groups[0].latestRequestedPeriod = "202608";
  assert.equal(build({ snapshot: input }).groups[0].metrics[0].requested.reasonCode, "UNRECORDED_REASON");
});

test("failed, partial, missing and publication-pending zeros never count as normal observed zeros", () => {
  const input = snapshot(), list = input.groups[0].metrics[0].rows;
  ["failed", "partial", "missing", "publication_pending"].forEach((status, i) => Object.assign(list[i], { status, value: 0, reasonCode: status === "publication_pending" ? "PUBLICATION_PENDING" : "", reasonEvidence: "unknown" }));
  const metric = build({ snapshot: input }).groups[0].metrics[0];
  assert.equal(metric.coverage.observed, 9); assert.equal(metric.observedZeroMonths, 0); assert.equal(metric.gaps.length, 4);
  assert.equal(metric.coverage.failed, 1); assert.equal(metric.coverage.partial, 1); assert.equal(metric.coverage.missing, 1); assert.equal(metric.coverage.publicationPending, 1);
});

test("unknown errors and unsafe source strings are not exposed as monthly diagnostic evidence", () => {
  const input = snapshot(); input.groups[0].metrics[0].rows[2] = { period: "2025-11", status: "failed", value: 0, reasonCode: "SECRET=https://unsafe.invalid/key", errorCode: "RAW_TOKEN" };
  input.groups[0].errorCode = "RAW_TOKEN";
  const result = build({ snapshot: input });
  assert.equal(result.groups[0].metrics[0].gaps[0].reasonCode, "UNRECORDED_REASON");
  assert.doesNotMatch(JSON.stringify(result), /RAW_TOKEN|SECRET=|unsafe\.invalid/);
});

test("duplicate monthly rows do not supply a latest value, source timestamp, zero count, or normal request status", () => {
  const input = snapshot(), metric = input.groups[0].metrics[0];
  metric.rows.push({ period: "2026-09", status: "observed", value: 0, retrievedAt: "2026-10-15T00:00:00Z" });
  const result = build({ snapshot: input }).groups[0].metrics[0];
  assert.equal(result.latestPeriod, "2026-08"); assert.equal(result.latestValue, 11);
  assert.equal(result.sourceRetrievedAt, "2026-10-01T00:00:00.000Z"); assert.equal(result.observedZeroMonths, 1);
  assert.equal(result.requested.status, "failed"); assert.equal(result.requested.reasonCode, "INVALID_RESPONSE");
});

test("KOSIS preserves dataset periods and item coverage without manufacturing13 monthly observations", () => {
  const input = snapshot(); input.groups.push({ key: "kosis", label: "인구·산업", category: "background", periodType: "mixed", status: "partial", latestPeriod: "2024 · 2026-08", metrics: [
    { key: "industry", label: "사업체", unit: "개", periodType: "Y", latestPeriod: "2024", latestValue: 0, rows: [{ period: "2024", value: 0, status: "observed" }] },
    { key: "population", label: "인구", unit: "명", periodType: "M", latestPeriod: "2026-08", latestValue: 100, rows: [{ period: "2026-08", value: 100, status: "observed" }] }
  ] });
  const result = build({ snapshot: input }), kosis = result.groups[1];
  assert.equal(kosis.coverage.kind, "items"); assert.equal(kosis.coverage.observed, 2); assert.equal(kosis.coverage.expected, 2);
  assert.equal(kosis.metrics[0].latestPeriod, "2024"); assert.equal(kosis.metrics[0].latestValue, 0);
  assert.equal(kosis.metrics[0].requested, null); assert.equal(kosis.metrics[1].lagMonths, null);
  assert.equal(result.summary.monthlyMetrics, 1);
});

test("local build completion is separate from the last provider-capable refresh attempt", () => {
  const provider = providerJob(10), local = { id: "local", sequence: 11, status: "completed", collectMissing: false, finishedAt: "2026-10-11T00:00:00Z" };
  const result = build({ job: local, refreshHistory: [provider] });
  assert.equal(result.refresh.current.kind, "local"); assert.equal(result.refresh.lastProvider.kind, "provider");
  assert.equal(result.refresh.lastProvider.jobId, provider.id); assert.equal(result.refresh.lastProvider.status, "completed");
  assert.equal(result.refresh.lastSuccessAt, "2026-10-10T00:02:00.000Z");
});

test("latest global provider failure wins over an older successful group step", () => {
  const old = providerJob(10), failed = providerJob(11, { status: "failed", errorCode: "AUTH_ERROR", refreshDiagnostics: null });
  const result = build({ refreshHistory: [old, failed], job: failed });
  assert.equal(result.groups[0].refresh.jobId, failed.id); assert.equal(result.groups[0].refresh.status, "failed");
  assert.equal(result.groups[0].refresh.scope, "regional_bundle");
  assert.equal(result.groups[0].refresh.lastSuccessAt, "2026-10-10T00:02:00.000Z");
});

test("successful source step in a partial batch records individual success but not whole-batch success", () => {
  const partial = providerJob(11, { refreshDiagnostics: { status: "partial", steps: [
    { key: "visitors", status: "ready", networkAttempted: true }, { key: "searchTrend", status: "failed", networkAttempted: true, errorCode: "AUTH_ERROR" }
  ] } });
  const result = build({ refreshHistory: [partial] });
  assert.equal(result.refresh.lastProvider.status, "partial"); assert.equal(result.refresh.lastSuccessAt, null);
  assert.equal(result.groups[0].refresh.status, "ready"); assert.equal(result.groups[0].refresh.lastSuccessAt, "2026-10-11T00:02:00.000Z");
});

test("completed jobs alone and cache reuse cannot fabricate an external success timestamp", () => {
  const jobs = [providerJob(12, { refreshDiagnostics: null }), providerJob(11, { refreshDiagnostics: { status: "completed", steps: [{ key: "visitors", status: "ready", networkAttempted: false }] } })];
  const result = build({ refreshHistory: jobs });
  assert.equal(result.refresh.lastSuccessAt, null); assert.equal(result.groups[0].refresh.lastSuccessAt, null);
  assert.equal(result.refresh.lastProvider.networkAttempted, null);
  assert.equal(build({ refreshHistory: [jobs[1]] }).refresh.lastProvider.networkAttempted, false);
});

test("policy due time is distinct from actual execution and disabled schedules have no next run", () => {
  const policy = { enabled: true, lastRunAt: "2026-10-15T21:00:00Z", nextRunAt: "2026-10-15T23:00:00Z" };
  const schedule = build({ policy }).refresh.schedule;
  assert.equal(schedule.status, "due"); assert.equal(schedule.scope, "regional_bundle");
  assert.equal(schedule.nextRunAt, "2026-10-15T23:00:00.000Z"); assert.equal(schedule.lastDueAt, "2026-10-15T21:00:00.000Z");
  assert.equal(build({ policy: { ...policy, nextRunAt: "2026-10-17T00:00:00Z" } }).refresh.schedule.status, "scheduled");
  const disabled = build({ policy: { ...policy, enabled: false } }).refresh.schedule;
  assert.equal(disabled.status, "disabled"); assert.equal(disabled.nextRunAt, null);
  assert.equal(build({ policy: { enabled: true } }).refresh.schedule.status, "unknown");
});

test("legacy snapshots without monthly rows do not infer13/13 from metadata alone", () => {
  const input = snapshot(); input.groups[0].metrics[0] = { key: "daily", label: "방문자", unit: "명", latestPeriod: scope.month, latestValue: 0, availableMonths: 13 };
  const metric = build({ snapshot: input }).groups[0].metrics[0];
  assert.equal(metric.latestValue, 0); assert.equal(metric.requested.status, "observed");
  assert.equal(metric.coverage.observed, 0); assert.equal(metric.sourceRetrievedAt, null);
});

test("an empty saved state is not six successful providers or an automatic refresh", () => {
  const result = build({ snapshot: null, job: null, policy: null });
  assert.equal(result.groups.length, 0); assert.equal(result.summary.monthlyMetrics, 0); assert.equal(result.summary.ready, 0);
  assert.equal(result.refresh.current.status, "never"); assert.equal(result.refresh.lastProvider.status, "never");
  assert.equal(result.refresh.schedule.enabled, false); assert.equal(result.result.generatedAt, null);
});

test("future rows and future legacy latest metadata cannot move a historical cutoff or its13-month coverage", () => {
  const input = snapshot(), metric = input.groups[0].metrics[0];
  metric.rows.push({ period: "2026-10", status: "observed", value: 999, retrievedAt: "2026-10-15T00:00:00Z" });
  metric.latestPeriod = "2026-10"; metric.latestValue = 999;
  let projected = build({ snapshot: input }).groups[0].metrics[0];
  assert.equal(projected.latestPeriod, "2026-09"); assert.equal(projected.latestValue, 12);
  assert.equal(projected.coverage.endPeriod, "2026-09"); assert.equal(projected.coverage.startPeriod, "2025-09");
  assert.equal(projected.coverage.observed, 13); assert.equal(projected.sourceRetrievedAt, "2026-10-01T00:00:00.000Z");
  metric.rows = [];
  projected = build({ snapshot: input }).groups[0].metrics[0];
  assert.equal(projected.latestPeriod, ""); assert.equal(projected.latestValue, null); assert.equal(projected.coverage.observed, 0);
});
