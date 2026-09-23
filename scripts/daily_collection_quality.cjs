const fs = require("node:fs/promises");
const path = require("node:path");

// Acceptance receipt for collection counts, not a guarantee of every date/product value.
// This module only reads artifacts; the crawler writes its immutable receipt once.
function count(value) {
  return ["number", "string"].includes(typeof value) && String(value).trim() !== ""
    && Number.isInteger(Number(value)) && Number(value) >= 0 ? Number(value) : null;
}

function receipt(status, reason, counts = {}, extra = {}) {
  return { status, reason, counts, ...extra };
}

function inspectProductCoverage(coverage, bookingExpected) {
  if (!coverage || coverage.version !== 1 || !Array.isArray(coverage.targets)) return "product_coverage_missing";
  if (bookingExpected && !coverage.targets.length) return "product_coverage_missing";
  const keys = ["discovered", "eligible", "excluded", "queried", "truncated"];
  if (keys.some(key => count(coverage[key]) === null)) return "product_coverage_invalid";
  for (const target of coverage.targets) {
    if (keys.some(key => count(target[key]) === null) || target.discovered !== target.eligible + target.excluded
      || target.queried > target.eligible || target.truncated > target.eligible
      || !Array.isArray(target.days) || !target.days.length || count(target.expectedDays) !== target.days.length
      || new Set(target.days.map(day => day.date)).size !== target.days.length) return "product_coverage_invalid";
    if (target.truncated > 0) return "product_targets_truncated";
    if (target.queried < target.eligible) return "product_targets_incomplete";
    for (const day of target.days) {
      if (["eligible", "queried", "succeeded", "failed", "truncated"].some(key => count(day[key]) === null)
        || day.eligible !== target.eligible || day.succeeded + day.failed !== day.queried
        || day.queried + day.truncated > day.eligible) return "product_coverage_invalid";
      if (day.truncated) return "product_targets_truncated";
      if (day.queried < day.eligible || day.failed) return "product_day_targets_incomplete";
    }
  }
  if (keys.some(key => coverage.targets.reduce((sum, target) => sum + target[key], 0) !== coverage[key])) return "product_coverage_invalid";
  return null;
}

function inspectManifest(manifest, options = {}) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) return receipt("failed", "manifest_missing");
  const expected = options.expected || options.payload || options;
  const guardedCollection = manifest.scheduledCollection || manifest.workerCollection || manifest.webCollection;
  const manualWorker = (manifest.workerCollection || manifest.webCollection) && !manifest.scheduledCollection;
  const counts = {};
  for (const key of ["naverOverall", "naverBookingStockChecked", "naverBookingStockSucceeded", "naverOtaObservationChecked", "naverOtaBlocked", "naverOtaFailed"]) {
    counts[key] = count(manifest.counts?.[key]);
  }
  if (guardedCollection) {
    for (const key of ["naverScheduleRequested", "naverScheduleSucceeded", "naverScheduleFailed", "naverScheduleBlocked"]) {
      counts[key] = count(manifest.counts?.[key]);
    }
  }
  const attempts = Array.isArray(manifest.naverAttemptedQueries) ? manifest.naverAttemptedQueries : [];
  const requestBlockedStatus = count(manifest.requestPacing?.blockedStatus);
  // Legacy paced manifests used enabled for both throttling and the block latch.
  // New worker manifests can retain the latch while request pacing is disabled.
  const requestGuardEnabled = manifest.requestPacing?.guardEnabled === true || manifest.requestPacing?.enabled === true;
  if (guardedCollection && manifest.requestPacing?.blockedCode === "BookingAPITooManyRequests") {
    return receipt("blocked", "naver_request_blocked", counts, { blockedReason: "naver_booking_api_too_many_requests" });
  }
  if (guardedCollection && requestGuardEnabled && [403, 429].includes(requestBlockedStatus)) {
    return receipt("blocked", "naver_request_blocked", counts, { blockedReason: `naver_request_http_${requestBlockedStatus}` });
  }
  if (guardedCollection && manifest.requestPacing?.blockedCode === "NAVER_CAPTCHA") {
    return receipt("blocked", "naver_request_blocked", counts, { blockedReason: "naver_captcha" });
  }
  const blockedAttempt = attempts.find((attempt) => [403, 429].includes(count(attempt?.status)));
  if (blockedAttempt) {
    const status = Number(blockedAttempt.status);
    return receipt("blocked", status === 429 ? "naver_main_rate_limited" : "naver_main_access_blocked", counts, { blockedReason: `naver_main_http_${status}` });
  }
  const bookingBlockedStatus = count(manifest.naverBookingBlockedStatus);
  if (guardedCollection && [403, 429].includes(bookingBlockedStatus)) {
    return receipt("blocked", "naver_booking_blocked", counts, { blockedReason: `naver_booking_http_${bookingBlockedStatus}` });
  }
  if (counts.naverScheduleBlocked > 0) {
    return receipt("blocked", "naver_schedule_blocked", counts, { blockedReason: "naver_schedule_http_403_or_429" });
  }
  if (manifest.collectionFailed) return receipt("failed", "collection_execution_failed", counts);
  if (attempts.some((attempt) => count(attempt?.status) !== null && (Number(attempt.status) < 200 || Number(attempt.status) >= 300))) {
    return receipt("failed", "naver_main_request_failed", counts);
  }
  const compact = (value) => String(value || "").replace(/\s+/g, "").toLowerCase();
  if (expected.keyword && compact(expected.keyword) !== compact(manifest.keyword)) return receipt("failed", "keyword_mismatch", counts);
  for (const key of ["collectionMode", "collectionPurpose", "productMode", "checkIn", "checkOut"]) {
    if (expected[key] !== undefined && String(expected[key]) !== String(manifest[key] ?? "")) return receipt("failed", `${key}_mismatch`, counts);
  }
  if (expected.detailRankRanges && compact(expected.detailRankRanges) !== compact(manifest.detailRankRanges)) return receipt("failed", "detail_rank_range_mismatch", counts);
  const expectedDays = count(expected.bookingRangeDays ?? expected.bookingDays);
  if (expectedDays !== null && count(manifest.bookingRangeDays) !== expectedDays) return receipt("failed", "booking_days_mismatch", counts);
  if (counts.naverOverall === 0) return receipt("failed", "no_main_results", counts);
  let bookingExpected = true;
  if (manualWorker) {
    const enabled = manifest.collectionProfileFlags?.collectBookingStock;
    if (typeof enabled !== "boolean") return receipt("partial", "collection_profile_missing", counts);
    counts.naverBookingStockEligible = count(manifest.counts?.naverBookingStockEligible);
    bookingExpected = enabled && counts.naverBookingStockEligible !== 0;
  }
  if (bookingExpected && (counts.naverBookingStockChecked === 0 || counts.naverBookingStockSucceeded === 0)) return receipt("failed", "no_successful_booking_results", counts);
  if (bookingExpected && counts.naverScheduleRequested === 0) return receipt("failed", "no_booking_schedule_requests", counts);
  if (Object.values(counts).some((value) => value === null) || !attempts.length || attempts.some((attempt) => count(attempt?.status) === null)) {
    return receipt("partial", "quality_metadata_missing", counts);
  }
  if (counts.naverBookingStockSucceeded > counts.naverBookingStockChecked) return receipt("failed", "inconsistent_booking_counts", counts);
  if (manualWorker && counts.naverBookingStockChecked !== counts.naverBookingStockEligible) return receipt("partial", "booking_targets_incomplete", counts);
  if (counts.naverOtaBlocked + counts.naverOtaFailed > counts.naverOtaObservationChecked) return receipt("failed", "inconsistent_ota_counts", counts);
  if (guardedCollection) {
    if (counts.naverScheduleSucceeded + counts.naverScheduleFailed !== counts.naverScheduleRequested || counts.naverScheduleBlocked > counts.naverScheduleFailed) {
      return receipt("failed", "inconsistent_schedule_counts", counts);
    }
    if (counts.naverScheduleFailed > 0) return receipt("partial", "booking_schedule_responses_incomplete", counts);
  }
  if (counts.naverBookingStockSucceeded < counts.naverBookingStockChecked) return receipt("partial", "booking_results_incomplete", counts);
  if (counts.naverOtaBlocked || counts.naverOtaFailed) return receipt("partial", "auxiliary_ota_incomplete", counts);
  if (guardedCollection && manifest.schemaVersion >= 2) {
    const coverageReason = inspectProductCoverage(manifest.productCoverage, bookingExpected);
    if (coverageReason) return receipt("partial", coverageReason, counts);
  }
  // Requested rank count is an upper bound. Fewer available places is valid.
  return receipt("complete", "manifest_checks_passed", counts);
}

function allowsDerivedUpdates(manifest) {
  return !(manifest?.scheduledCollection || manifest?.workerCollection || manifest?.webCollection) || inspectManifest(manifest).status === "complete";
}

async function inspectResult(result, payload = {}) {
  const output = result?.output;
  if (!output || typeof output !== "object" || !output.outputDir) return receipt("failed", "result_artifacts_missing");
  try {
    const base = await fs.realpath(output.outputDir);
    if (!result.runId || path.basename(base) !== result.runId) return receipt("failed", "run_id_mismatch");
    const manifestPath = await fs.realpath(path.join(base, "manifest.json"));
    if (path.dirname(manifestPath) !== base) return receipt("failed", "manifest_outside_run");
    const manifest = JSON.parse((await fs.readFile(manifestPath, "utf8")).replace(/^\uFEFF/, ""));
    return inspectManifest(manifest, payload);
  } catch {
    // No raw error/path output: acceptance receipts contain no account or file contents.
    return receipt("failed", "manifest_unreadable");
  }
}

module.exports = { inspectManifest, inspectResult, allowsDerivedUpdates, inspectProductCoverage };
