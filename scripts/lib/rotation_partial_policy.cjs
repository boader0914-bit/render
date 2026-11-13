"use strict";

// A continuation decision never changes quality, admits partial observations to
// derived data, retries a request, or enables a paused scheduler.
const path = require("node:path");
const { inspectManifest, inspectProductCoverage } = require("../daily_collection_quality.cjs");

const PARTIAL_POLICY = Object.freeze({
  policyVersion: "rotation-partial-v2"
});
const MAIN_RESPONSE_REASONS = new Set(["no_main_results", "naver_main_request_failed"]);
const RESPONSE_REASONS = new Set(["booking_schedule_responses_incomplete", "booking_results_incomplete", "auxiliary_ota_incomplete",
  "no_successful_booking_results", ...MAIN_RESPONSE_REASONS]);
const REASONS = new Set([
  "ROTATION_PARTIAL_CONTINUED", "ROTATION_PARTIAL_REPEATED", "ROTATION_PARTIAL_TOO_MANY_FAILURES",
  "ROTATION_PARTIAL_EVIDENCE_UNVERIFIED", "ROTATION_PARTIAL_PROVIDER_PROTECTED",
  "ROTATION_PARTIAL_WORKER_UNVERIFIED", "ROTATION_PARTIAL_STORAGE_UNVERIFIED",
  "ROTATION_PARTIAL_HISTORY_UNVERIFIED"
]);
const count = value => Number.isSafeInteger(value) && value >= 0;
const runId = value => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,239}$/.test(value);

function sanitizePartialContinuation(value) {
  if (!value || !["rotation-partial-v1", PARTIAL_POLICY.policyVersion].includes(value.policyVersion) || !["continue", "pause"].includes(value.decision)
    || !REASONS.has(value.reasonCode) || !["failedSchedules", "requestedSchedules", "affectedCompanies", "consecutivePartialRuns"]
      .every(key => count(value[key])) || value.failedSchedules > value.requestedSchedules
    || value.decision === "continue" && value.reasonCode !== "ROTATION_PARTIAL_CONTINUED") return null;
  if (value.policyVersion === "rotation-partial-v1") {
    if (value.decision === "continue" && (value.failedSchedules < 1 || value.failedSchedules > 3
      || value.failedSchedules * 1000 > value.requestedSchedules || value.affectedCompanies !== 1
      || value.consecutivePartialRuns !== 1)) return null;
  } else if (!["missingBookingResults", "failedOtaRequests"].every(key => count(value[key]))
    || value.consecutivePartialRuns !== 0 || value.previousSlotId !== null
    || MAIN_RESPONSE_REASONS.has(value.responseReason) && [value.failedSchedules, value.requestedSchedules, value.affectedCompanies, value.missingBookingResults, value.failedOtaRequests].some(number => number !== 0)
    || ["ROTATION_PARTIAL_REPEATED", "ROTATION_PARTIAL_TOO_MANY_FAILURES", "ROTATION_PARTIAL_HISTORY_UNVERIFIED"].includes(value.reasonCode)
    || (value.responseReason !== null && !RESPONSE_REASONS.has(value.responseReason))
    || value.decision === "continue" && (!RESPONSE_REASONS.has(value.responseReason)
      || !MAIN_RESPONSE_REASONS.has(value.responseReason) && ![value.failedSchedules, value.missingBookingResults, value.failedOtaRequests].some(number => number > 0)
      || value.failedSchedules > 0 && (value.affectedCompanies < 1 || value.affectedCompanies > value.failedSchedules))) return null;
  const clean = { policyVersion: value.policyVersion, decision: value.decision, reasonCode: value.reasonCode,
    failedSchedules: value.failedSchedules, requestedSchedules: value.requestedSchedules,
    affectedCompanies: value.affectedCompanies, consecutivePartialRuns: value.consecutivePartialRuns,
    previousSlotId: typeof value.previousSlotId === "string" && /^rotation_20\d{2}-\d{2}-\d{2}_\d{1,3}$/.test(value.previousSlotId)
      ? value.previousSlotId : null };
  if (value.policyVersion === PARTIAL_POLICY.policyVersion) Object.assign(clean, { responseReason: value.responseReason,
    missingBookingResults: value.missingBookingResults, failedOtaRequests: value.failedOtaRequests });
  return clean;
}

function partialContinuationEvidence(value, quality, expected) {
  const decision = { policyVersion: PARTIAL_POLICY.policyVersion, decision: "pause",
    reasonCode: "ROTATION_PARTIAL_EVIDENCE_UNVERIFIED", failedSchedules: 0,
    requestedSchedules: 0, affectedCompanies: 0, consecutivePartialRuns: 0, previousSlotId: null,
    responseReason: null, missingBookingResults: 0, failedOtaRequests: 0 };
  try {
    const manifest = value?.output;
    if (value?.postprocess?.state === "failed") return { ...decision, reasonCode: "ROTATION_PARTIAL_STORAGE_UNVERIFIED" };
    if (!runId(value?.runId) || value.reused || value.reusedResult || value.cacheHit || value.blocked || value.providerBlocked
      || value.halted || value.protected || value.errorCode || value.failure
      || !manifest || !Number.isSafeInteger(manifest.schemaVersion) || manifest.schemaVersion < 2 || typeof manifest.outputDir !== "string"
      || path.basename(manifest.outputDir) !== value.runId || manifest.scheduledCollection !== true
      || manifest.collectionFailed || manifest.collectionFailure || quality?.failure || quality?.blockedReason
      || manifest.collectionQuality?.blockedReason || manifest.collectionQuality?.failure
      || (manifest.collectionQuality && manifest.collectionQuality.status !== quality?.status)
      || (manifest.collectionQuality?.reason !== undefined && manifest.collectionQuality.reason !== quality?.reason)
      || !["partial", "failed"].includes(quality?.status) || !RESPONSE_REASONS.has(quality.reason)
      || quality.status === "failed" && quality.reason !== "no_successful_booking_results" && !MAIN_RESPONSE_REASONS.has(quality.reason)) return decision;
    const expectedConditions = expected?.expected || expected?.payload || expected || {};
    const compact = text => String(text || "").replace(/\s+/g, "").toLowerCase();
    if (expectedConditions.keyword && compact(expectedConditions.keyword) !== compact(manifest.keyword)) return decision;
    for (const key of ["collectionMode", "collectionPurpose", "productMode", "checkIn", "checkOut", "dayUseMode", "targetPlaceId"]) {
      if (expectedConditions[key] !== undefined && String(expectedConditions[key]) !== String(manifest[key] ?? "")) return decision;
    }
    if (expectedConditions.detailRankRanges && compact(expectedConditions.detailRankRanges) !== compact(manifest.detailRankRanges)) return decision;
    const expectedDays = expectedConditions.bookingRangeDays ?? expectedConditions.bookingDays;
    if (expectedDays !== undefined && expectedDays !== manifest.bookingRangeDays) return decision;
    const mainUnavailable = MAIN_RESPONSE_REASONS.has(quality.reason);
    if (!Array.isArray(manifest.naverAttemptedQueries) || !manifest.naverAttemptedQueries.length
      || manifest.naverAttemptedQueries.some(attempt => !Number.isInteger(Number(attempt?.status))
        || !((Number(attempt.status) >= 200 && Number(attempt.status) < 300)
          || quality.reason === "naver_main_request_failed" && (Number(attempt.status) === 408 || Number(attempt.status) >= 500 && Number(attempt.status) <= 599)))) return decision;
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
    if (!Object.values(totals).every(count)
      || (mainUnavailable ? Object.values(totals).some(number => number !== 0) || manifest.productCoverage?.targets?.length !== 0
        : totals.naverOverall < 1 || totals.naverBookingStockChecked < 1)
      || totals.naverBookingStockSucceeded > totals.naverBookingStockChecked
      || totals.naverOtaBlocked !== 0 || totals.naverScheduleBlocked !== 0
      || totals.naverOtaFailed > totals.naverOtaObservationChecked
      || totals.naverScheduleRequested !== totals.naverScheduleSucceeded + totals.naverScheduleFailed
      || inspectProductCoverage(manifest.productCoverage, totals.naverBookingStockSucceeded > 0, { allowFailedDays: true }) !== null) return decision;
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
    Object.assign(decision, { failedSchedules: failed, requestedSchedules: requested, affectedCompanies: affected,
      responseReason: quality.reason, missingBookingResults: totals.naverBookingStockChecked - totals.naverBookingStockSucceeded,
      failedOtaRequests: totals.naverOtaFailed });
    if (!mainUnavailable && ![decision.failedSchedules, decision.missingBookingResults, decision.failedOtaRequests].some(number => number > 0)) return decision;
    return { ...decision, decision: "continue", reasonCode: "ROTATION_PARTIAL_CONTINUED" };
  } catch {
    return { ...decision, decision: "pause", reasonCode: "ROTATION_PARTIAL_EVIDENCE_UNVERIFIED" };
  }
}

module.exports = { PARTIAL_POLICY, partialContinuationEvidence, sanitizePartialContinuation };
