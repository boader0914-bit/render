"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), crypto = require("node:crypto");
const { reviewHistoricalJobs } = require("./lib/keyword_monthly_historical_review.cjs");
const OLD = "keyword-monthly-refresh-v1", CURRENT = "keyword-monthly-incremental-v5", LATER = "keyword-monthly-incremental-v4";
const hash = value => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
function job(version = OLD, status = "needs_verification", changes = {}) {
  const intent = { runId: "saved_run_1", keyword: "경남글램핑", manifestSha256: "a".repeat(64), scheduleOccurrenceId: "rotation_2026-11-15_1", scope: "경남글램핑", refreshVersion: version, ...changes.intent };
  return { schemaVersion: 1, jobId: hash([version, intent.runId, intent.manifestSha256, intent.keyword, intent.scope, intent.scheduleOccurrenceId]), intent,
    status, reasonCode: status === "needs_verification" ? "KEYWORD_MONTHLY_REFRESH_SOURCE_COPY_BOUND" : status === "deferred" ? "KEYWORD_REFRESH_COLLECTION_BUSY" : null,
    createdAt: "2026-11-14T01:00:00.000Z", updatedAt: "2026-11-15T01:00:00.000Z",
    finishedAt: ["complete", "needs_verification"].includes(status) ? "2026-11-15T01:00:00.000Z" : null,
    result: status === "complete" ? { status: "published", pointerSha256: "b".repeat(64), providerCalls: 0, networkAttempted: false } : null,
    ...Object.fromEntries(Object.entries(changes).filter(([key]) => key !== "intent")) };
}
function review(rows, allRowsCoverage = true) { return reviewHistoricalJobs(rows, CURRENT, { allRowsCoverage }); }
function freeze(value) { if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }

test("exact later source completion is linked without changing failed rows or certifying current scope", () => {
  const rows = freeze([job(), job(CURRENT, "complete", { finishedAt: "2026-11-16T01:00:00.000Z" })]), before = JSON.stringify(rows), out = review(rows);
  assert.equal(out.sameEventLaterCompleted, 1); assert.equal(out.notCovered, 0); assert.equal(out.unknown, 0);
  assert.equal(out.groups[0].reasonCode, "KEYWORD_MONTHLY_REFRESH_SOURCE_COPY_BOUND"); assert.equal(out.groups[0].sameEventLaterCompleted, 1);
  assert.equal(out.currentScopeFreshnessVerified, false); assert.equal(out.originalJournalRowsChanged, false); assert.equal(out.retryAuthorized, false);
  assert.equal(JSON.stringify(rows), before); assert.equal(rows[0].status, "needs_verification");
});

for (const [field, value] of Object.entries({ runId: "saved_run_2", keyword: "가평글램핑", manifestSha256: "c".repeat(64), scheduleOccurrenceId: "rotation_2026-11-15_2", scope: "경남글램핑:2026-11" })) {
  test(`a different ${field} never links a completion`, () => {
    const out = review([job(), job(CURRENT, "complete", { intent: { [field]: value } })]);
    assert.equal(out.sameEventLaterCompleted, 0); assert.equal(out.priorExactComplete, 0); assert.equal(out.notCovered, 1);
  });
}

test("null slot matches only an explicit null slot, never a different or omitted slot", () => {
  const old = job(OLD, "deferred", { intent: { scheduleOccurrenceId: null } });
  assert.equal(review([old, job(CURRENT, "complete", { intent: { scheduleOccurrenceId: null } })]).sameEventLaterCompleted, 1);
  assert.equal(review([old, job(CURRENT, "complete")]).notCovered, 1);
  const missing = job(CURRENT, "complete"); delete missing.intent.scheduleOccurrenceId;
  assert.equal(review([old, missing]).unknown, 1);
});

test("an earlier exact completion is distinguished from a later completion and missing work", () => {
  const out = review([job(), job(LATER, "complete", { finishedAt: "2026-11-14T23:00:00.000Z" })]);
  assert.equal(out.priorExactComplete, 1); assert.equal(out.sameEventLaterCompleted, 0); assert.equal(out.notCovered, 0); assert.equal(out.unknown, 0);
  assert.equal(out.groups[0].priorExactComplete, 1);
});

test("multiple matching records count one old job once, preferring a later completion", () => {
  const out = review([job(), job(LATER, "complete", { finishedAt: "2026-11-14T23:00:00.000Z" }), job(CURRENT, "complete", { finishedAt: "2026-11-16T01:00:00.000Z" })]);
  assert.equal(out.reviewedRows, 1); assert.equal(out.sameEventLaterCompleted, 1); assert.equal(out.priorExactComplete, 0);
});

test("same-version records and status/result-only badges are insufficient completed evidence", () => {
  assert.equal(review([job(), job(OLD, "complete")]).notCovered, 1);
  for (const changes of [{ result: null }, { result: { status: "published" } }, { finishedAt: "unknown" }, { result: { status: "published", pointerSha256: "b".repeat(64), providerCalls: 1 } }]) {
    const out = review([job(), job(CURRENT, "complete", changes)]); assert.equal(out.sameEventLaterCompleted, 0); assert.equal(out.unknown, 1);
  }
});

test("unreadable identity and a truncated input cohort are unknown rather than uncovered or zero", () => {
  const invalid = job(CURRENT, "complete", { jobId: "d".repeat(64), privateError: "password_token_private_path" });
  const out = review([job(), invalid]); assert.equal(out.invalidRows, 1); assert.equal(out.unknown, 1); assert.equal(out.notCovered, 0);
  assert.ok(!JSON.stringify(out).includes("password_token_private_path"));
  const partial = review([job()], false); assert.equal(partial.allRowsCoverage, false); assert.equal(partial.unknown, 1); assert.equal(partial.notCovered, 0);
  assert.equal(reviewHistoricalJobs([job()], CURRENT).allRowsCoverage, false);
});

test("all historical reasons and states remain distinct, and current counts include verified zero states", () => {
  const rows = [job(), job(OLD, "deferred"), job("keyword-monthly-refresh-compressed-v2", "deferred"), job(CURRENT, "complete")];
  const out = review(rows); assert.equal(out.allRowsCoverage, true); assert.equal(out.rowsExamined, 4); assert.equal(out.historicalRows, 3); assert.equal(out.groups.length, 3);
  assert.deepEqual(out.currentVersionCounts, { queued: 0, deferred: 0, running: 0, complete: 1, needs_verification: 0 });
  assert.equal(out.historicalCountsByVersion[OLD].needs_verification, 1); assert.equal(out.historicalCountsByVersion[OLD].deferred, 1);
  assert.deepEqual(out.currentVersionReasonCounts, [{ status: "complete", reasonCode: null, count: 1 }]);
  for (const group of out.groups) assert.equal(group.count, group.sameEventLaterCompleted + group.priorExactComplete + group.notCovered + group.unknown);
});

test("current failures are reported as current reasons and are never relabelled historical", () => {
  const out = review([job(CURRENT)]); assert.equal(out.reviewedRows, 0); assert.equal(out.currentVersionCounts.needs_verification, 1);
  assert.deepEqual(out.currentVersionReasonCounts, [{ status: "needs_verification", reasonCode: "KEYWORD_MONTHLY_REFRESH_SOURCE_COPY_BOUND", count: 1 }]);
});

test("version dictionaries are own properties and invalid invocation fails closed", () => {
  const out = review([job("__proto__", "deferred")]); assert.equal(Object.hasOwn(out.historicalCountsByVersion, "__proto__"), true);
  assert.equal(out.historicalCountsByVersion.__proto__.deferred, 1); assert.equal(Object.getPrototypeOf(out.historicalCountsByVersion), Object.prototype);
  assert.throws(() => reviewHistoricalJobs(null, CURRENT), TypeError); assert.throws(() => reviewHistoricalJobs([], ""), TypeError);
  assert.throws(() => reviewHistoricalJobs(Array(4097).fill(job()), CURRENT), TypeError);
});
