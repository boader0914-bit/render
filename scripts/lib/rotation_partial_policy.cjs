"use strict";

// A continuation decision never changes quality, admits partial observations to
// derived data, retries a request, or enables a paused scheduler.
const path = require("node:path");
const { inspectManifest, inspectProductCoverage } = require("../daily_collection_quality.cjs");

const PARTIAL_POLICY = Object.freeze({
  policyVersion: "rotation-partial-v1",
  maxFailedSchedules: 3,
  maxFailurePermille: 1,
  maxAffectedCompanies: 1,
  pauseAfterConsecutivePartials: 2
});
const REASONS = new Set([
  "ROTATION_PARTIAL_CONTINUED", "ROTATION_PARTIAL_REPEATED", "ROTATION_PARTIAL_TOO_MANY_FAILURES",
  "ROTATION_PARTIAL_EVIDENCE_UNVERIFIED", "ROTATION_PARTIAL_PROVIDER_PROTECTED",
  "ROTATION_PARTIAL_WORKER_UNVERIFIED", "ROTATION_PARTIAL_STORAGE_UNVERIFIED",
  "ROTATION_PARTIAL_HISTORY_UNVERIFIED"
]);
const count = value => Number.isSafeInteger(value) && value >= 0;
const runId = value => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,239}$/.test(value);

function sanitizePartialContinuation(value) {
  if (!value || value.policyVersion !== PARTIAL_POLICY.policyVersion || !["continue", "pause"].includes(value.decision)
    || !REASONS.has(value.reasonCode) || !["failedSchedules", "requestedSchedules", "affectedCompanies", "consecutivePartialRuns"]
      .every(key => count(value[key])) || value.failedSchedules > value.requestedSchedules
    || value.decision === "continue" && (value.reasonCode !== "ROTATION_PARTIAL_CONTINUED"
      || value.failedSchedules < 1 || value.failedSchedules > PARTIAL_POLICY.maxFailedSchedules
      || value.failedSchedules * 1000 > value.requestedSchedules * PARTIAL_POLICY.maxFailurePermille
      || value.affectedCompanies !== 1 || value.consecutivePartialRuns !== 1)) return null;
  return { policyVersion: value.policyVersion, decision: value.decision, reasonCode: value.reasonCode,
    failedSchedules: value.failedSchedules, requestedSchedules: value.requestedSchedules,
    affectedCompanies: value.affectedCompanies, consecutivePartialRuns: value.consecutivePartialRuns,
    previousSlotId: typeof value.previousSlotId === "string" && /^rotation_20\d{2}-\d{2}-\d{2}_\d{1,3}$/.test(value.previousSlotId)
      ? value.previousSlotId : null };
}

function partialContinuationEvidence(value, quality, expected) {
  const decision = { policyVersion: PARTIAL_POLICY.policyVersion, decision: "pause",
    reasonCode: "ROTATION_PARTIAL_EVIDENCE_UNVERIFIED", failedSchedules: 0,
    requestedSchedules: 0, affectedCompanies: 0, consecutivePartialRuns: 0, previousSlotId: null };
  try {
    const manifest = value?.output;
    if (!runId(value?.runId) || value.reused || value.reusedResult || value.cacheHit || value.blocked || value.providerBlocked
      || value.halted || value.protected || value.errorCode || value.failure
      || !manifest || !Number.isSafeInteger(manifest.schemaVersion) || manifest.schemaVersion < 2 || typeof manifest.outputDir !== "string"
      || path.basename(manifest.outputDir) !== value.runId || manifest.scheduledCollection !== true
      || manifest.collectionFailed || manifest.collectionFailure || quality?.failure || quality?.blockedReason
      || manifest.collectionQuality?.blockedReason || manifest.collectionQuality?.failure
      || (manifest.collectionQuality && manifest.collectionQuality.status !== "partial")
      || quality?.status !== "partial" || quality.reason !== "booking_schedule_responses_incomplete") return decision;
    const inspected = inspectManifest(manifest, expected);
    if (inspected.status !== quality.status || inspected.reason !== quality.reason
      || Object.entries(inspected.counts).some(([key, number]) => quality.counts?.[key] !== number)) return decision;
    const rawQualityCounts = manifest.collectionQuality?.counts;
    if (rawQualityCounts !== undefined && (!rawQualityCounts || typeof rawQualityCounts !== "object" || Array.isArray(rawQualityCounts)
      || Object.entries(inspected.counts).some(([key, number]) => rawQualityCounts[key] !== number))) return decision;
    const totals = inspected.counts, pacing = manifest.requestPacing, timeline = pacing?.requestTimeline;
    if (!pacing || pacing.guardEnabled !== true || pacing.stopped !== false || pacing.blockedCode
      || pacing.blockedStatus || manifest.naverBookingBlockedStatus || manifest.naverScheduleBlockedStatus
      || pacing.inFlight !== 0 || pacing.queued !== 0 || !timeline || timeline.complete !== true
      || timeline.snapshotInFlight !== 0 || timeline.snapshotQueued !== 0 || timeline.restrictionEventsTruncated !== false
      || !Array.isArray(timeline.restrictionEvents) || timeline.restrictionEvents.length) {
      decision.reasonCode = "ROTATION_PARTIAL_PROVIDER_PROTECTED";
      return decision;
    }
    if (!Object.values(totals).every(count) || totals.naverOverall < 1 || totals.naverBookingStockChecked < 1
      || totals.naverBookingStockChecked !== totals.naverBookingStockSucceeded
      || totals.naverOtaBlocked !== 0 || totals.naverOtaFailed !== 0 || totals.naverScheduleBlocked !== 0
      || totals.naverScheduleSucceeded < 1 || totals.naverScheduleFailed < 1
      || totals.naverScheduleRequested !== totals.naverScheduleSucceeded + totals.naverScheduleFailed
      || inspectProductCoverage(manifest.productCoverage, true, { allowFailedDays: true }) !== null) return decision;
    const days = manifest.bookingRangeDays, start = Date.parse(manifest.checkIn + "T00:00:00Z");
    if (!Number.isSafeInteger(days) || days < 1 || days > 31 || !Number.isFinite(start)) return decision;
    const expectedDates = Array.from({ length: days }, (_, index) => new Date(start + index * 86400000).toISOString().slice(0, 10));
    const companies = new Set();
    let requested = 0, succeeded = 0, failed = 0, affected = 0;
    for (const target of manifest.productCoverage.targets) {
      if (typeof target.businessId !== "string" || !/^[1-9]\d{0,29}$/.test(target.businessId)
        || companies.has(target.businessId) || target.productListComplete !== true
        || target.expectedDays !== days || target.days.length !== days) return decision;
      companies.add(target.businessId);
      let targetFailed = 0;
      for (const [index, day] of target.days.entries()) {
        if (day.date !== expectedDates[index]) return decision;
        requested += day.queried; succeeded += day.succeeded; failed += day.failed; targetFailed += day.failed;
      }
      if (targetFailed) affected++;
    }
    if (requested !== totals.naverScheduleRequested || succeeded !== totals.naverScheduleSucceeded
      || failed !== totals.naverScheduleFailed) return decision;
    Object.assign(decision, { failedSchedules: failed, requestedSchedules: requested, affectedCompanies: affected });
    if (failed > PARTIAL_POLICY.maxFailedSchedules || failed * 1000 > requested * PARTIAL_POLICY.maxFailurePermille
      || affected > PARTIAL_POLICY.maxAffectedCompanies) {
      decision.reasonCode = "ROTATION_PARTIAL_TOO_MANY_FAILURES";
      return decision;
    }
    return { ...decision, decision: "continue", reasonCode: "ROTATION_PARTIAL_CONTINUED", consecutivePartialRuns: 1 };
  } catch {
    return { ...decision, decision: "pause", reasonCode: "ROTATION_PARTIAL_EVIDENCE_UNVERIFIED" };
  }
}

module.exports = { PARTIAL_POLICY, partialContinuationEvidence, sanitizePartialContinuation };
