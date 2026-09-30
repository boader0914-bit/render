"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { sanitizeCollectionFailure, FAILURE_LABELS, PHASE_LABELS } = require("./collection_failure.cjs");

const STATUSES = new Set(["complete", "partial", "failed", "blocked", "interrupted", "reused", "unknown"]);
const COUNT_KEYS = ["naverOverall", "naverBookingStockEligible", "naverBookingStockChecked", "naverBookingStockSucceeded",
  "naverBookingStockSkippedByMode", "naverBookingStockSkippedByRank", "naverOtaObservationChecked", "naverOtaBlocked", "naverOtaFailed",
  "naverScheduleRequested", "naverScheduleSucceeded", "naverScheduleFailed", "naverScheduleBlocked"];
const REASON_LABELS = {
  manifest_checks_passed: "수집 결과 검증 완료", manifest_missing: "수집 결과 기록 없음", manifest_unreadable: "수집 결과 기록 읽기 실패",
  collection_profile_missing: "수집 조건 기록 부족", quality_metadata_missing: "수집 상태를 판단할 기록 부족",
  booking_targets_incomplete: "일부 업체의 상세 조회 누락", booking_schedule_responses_incomplete: "일부 날짜의 예약 응답 미확보",
  booking_results_incomplete: "일부 업체의 예약 상세 미확보", auxiliary_ota_incomplete: "일부 보조 예약 채널 확인 실패",
  product_coverage_missing: "상품별 조회 범위 기록 없음", product_coverage_invalid: "상품별 조회 범위 기록 불일치",
  product_list_incomplete: "일부 업체의 상품 목록 미확보", product_targets_truncated: "상품 수 제한으로 일부 상세 조회 제외",
  product_targets_incomplete: "일부 상품의 상세 조회 누락", product_day_targets_incomplete: "일부 상품·날짜의 예약 응답 미확보",
  naver_request_blocked: "네이버 접근 제한 감지", naver_main_rate_limited: "네이버 검색 요청량 제한",
  naver_main_access_blocked: "네이버 검색 접근 제한", naver_booking_blocked: "네이버 예약 접근 제한", naver_schedule_blocked: "네이버 예약 일정 접근 제한",
  collection_execution_failed: "수집 실행 실패", naver_main_request_failed: "네이버 검색 응답 실패", no_main_results: "검색 결과 미확보",
  no_successful_booking_results: "정상 예약 상세 응답 없음", no_booking_schedule_requests: "예약 일정 조회 기록 없음",
  inconsistent_booking_counts: "업체 조회 건수 불일치", inconsistent_ota_counts: "보조 채널 조회 건수 불일치", inconsistent_schedule_counts: "예약 일정 조회 건수 불일치",
  keyword_mismatch: "수집 키워드 불일치", collectionMode_mismatch: "수집 방식 불일치", collectionPurpose_mismatch: "수집 목적 불일치",
  productMode_mismatch: "상품 범위 불일치", checkIn_mismatch: "시작 날짜 불일치", checkOut_mismatch: "종료 날짜 불일치",
  dayUseMode_mismatch: "데이유즈 조건 불일치", dayUseMode_invalid: "데이유즈 조건 오류", dayUseMode_coverage_mismatch: "데이유즈 조회 범위 불일치",
  detail_rank_range_mismatch: "상세 순위 범위 불일치", booking_days_mismatch: "수집 기간 불일치", result_artifacts_missing: "결과 파일 기록 없음",
  run_id_mismatch: "결과 번호 불일치", manifest_outside_run: "결과 파일 위치 검증 실패", unrecorded_reason: "상세 원인 기록 없음"
};
const BLOCKED_REASONS = new Set(["naver_booking_api_too_many_requests", "naver_request_http_403", "naver_request_http_429", "naver_captcha",
  "naver_main_http_403", "naver_main_http_429", "naver_booking_http_403", "naver_booking_http_429", "naver_schedule_http_403_or_429"]);
const ERROR_LABELS = {
  ...FAILURE_LABELS,
  TIMEOUT: "예약 응답 시간 초과", NETWORK_ERROR: "예약 서버 통신 실패", HTTP_ERROR: "예약 서버 오류 응답",
  PROVIDER_BLOCKED: "예약 접근 제한", GRAPHQL_ERROR: "예약 API 오류 응답", MISSING_SCHEDULE: "요청 날짜의 예약 응답 없음",
  INVALID_STOCK: "예약 응답의 객실 수량 확인 불가", UNKNOWN_ERROR: "예약 요청 오류",
  SCHEDULE_RESPONSE_UNRECORDED: "예약 응답 미확보", PRODUCT_LIST_INCOMPLETE: "상품 목록 미확보",
  PRODUCT_TARGETS_TRUNCATED: "상품 수 제한으로 상세 조회 제외", PRODUCT_TARGETS_INCOMPLETE: "상품·날짜 상세 조회 누락",
  BOOKING_ID_MISSING: "네이버 예약 사업자 번호 미확보", BOOKING_DETAIL_UNRECORDED: "업체 예약 상세 미확보",
  OTA_OBSERVATION_INCOMPLETE: "보조 예약 채널 확인 실패", DIAGNOSTIC_DETAILS_UNAVAILABLE: "상세 원인 기록 없음"
};
const PRODUCT_KEYS = [
  ["네이버상품상세JSON", "itemDetailsJson", "itemDetails"],
  ["네이버요일별상품상세JSON", "weeklyProductDetailsJson", "weeklyProductDetails"],
  ["dayUseWeeklyProductDetailsJson"]
];
const MAX_ISSUES = 300;
const count = value => (typeof value === "number" || typeof value === "string") && String(value).trim() !== ""
  && Number.isSafeInteger(Number(value)) && Number(value) >= 0 && Number(value) <= 1e9 ? Number(value) : null;
const identifier = value => /^[A-Za-z0-9_-]{1,120}$/.test(String(value || "")) ? String(value) : "";
const label = value => typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 160) : "";
const date = value => /^\d{4}-\d{2}-\d{2}$/.test(String(value || "")) && Number.isFinite(Date.parse(`${value}T00:00:00Z`))
  && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value ? value : "";

function sanitizeCollectionQuality(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const result = { status: STATUSES.has(value.status) ? value.status : "unknown" };
  if (value.reason !== undefined) result.reason = Object.hasOwn(REASON_LABELS, value.reason) ? value.reason : "unrecorded_reason";
  if (value.counts && typeof value.counts === "object" && !Array.isArray(value.counts)) {
    result.counts = {};
    for (const key of COUNT_KEYS) if (Object.hasOwn(value.counts, key)) result.counts[key] = count(value.counts[key]);
  }
  if (BLOCKED_REASONS.has(value.blockedReason)) result.blockedReason = value.blockedReason;
  const failure = sanitizeCollectionFailure(value.failure);
  if (failure) result.failure = failure;
  return result;
}

function inlineProducts(row) {
  const output = [];
  for (const keys of PRODUCT_KEYS) for (const key of keys) {
    const value = row[key];
    if (Array.isArray(value)) { output.push(...value); break; }
    if (typeof value !== "string" || value.length > 8 * 1024 * 1024 || !value.trim().startsWith("[")) continue;
    try { const parsed = JSON.parse(value); if (Array.isArray(parsed)) { output.push(...parsed); break; } } catch { /* Legacy detail is absent. */ }
  }
  return output;
}

function buildCollectionDiagnostics({ manifest = null, rows = [], limitations = [] } = {}) {
  const quality = sanitizeCollectionQuality(manifest?.collectionQuality);
  const status = quality?.status || "unknown";
  const reason = quality?.reason || "unrecorded_reason";
  const counts = {};
  for (const key of COUNT_KEYS) if (Object.hasOwn(manifest?.counts || {}, key) || Object.hasOwn(quality?.counts || {}, key)) {
    counts[key] = count(Object.hasOwn(manifest?.counts || {}, key) ? manifest.counts[key] : quality.counts[key]);
  }
  const issueGroups = new Map(), companies = new Map(), failedByDay = new Map(), seenProducts = new Set();
  let observedZeroScheduleCount = 0, failedZeroScheduleCount = 0, productFailures = 0, productsRead = 0, detailTruncated = false;
  const knownLimitations = new Set(limitations.filter(value => ["일부 상세 파일을 읽을 수 없어 저장된 집계만 표시합니다.", "자료 크기 제한으로 일부 상세를 생략했습니다."].includes(value)));
  function add(code, identity = {}, detail = {}) {
    const safeCode = Object.hasOwn(ERROR_LABELS, code) ? code : "DIAGNOSTIC_DETAILS_UNAVAILABLE";
    const phase = ["booking_schedule", "product_list", "booking_detail", "ota", "validation", ...Object.keys(PHASE_LABELS)].includes(detail.phase) ? detail.phase : "booking_schedule";
    const httpStatus = Number.isInteger(detail.httpStatus) && detail.httpStatus >= 100 && detail.httpStatus <= 599 ? detail.httpStatus : null;
    const bizItemId = identifier(detail.bizItemId), productName = label(detail.productName);
    const key = JSON.stringify([safeCode, identity.placeId || "", identity.bookingBusinessId || "", identity.companyName || "", bizItemId, productName, httpStatus]);
    let item = issueGroups.get(key);
    if (!item) {
      const detailStatus = detail.recorded === true ? "recorded" : "unrecorded";
      item = { code: safeCode, label: ERROR_LABELS[safeCode], phase, companyName: identity.companyName || "", placeId: identity.placeId || "",
        bookingBusinessId: identity.bookingBusinessId || "", bizItemId, productName, dates: new Set(), affectedCount: 0, httpStatus, detailStatus,
        countUnit: detail.countUnit || (phase === "product_list" ? "products" : ["booking_detail", "ota"].includes(phase) ? "companies" : phase === "validation" ? "records" : "product_dates"),
        expectedCount: count(detail.expectedCount), queriedCount: count(detail.queriedCount),
        message: detailStatus === "unrecorded" ? "세부 응답 원인은 기록되지 않았습니다." : ERROR_LABELS[safeCode] };
      issueGroups.set(key, item);
    }
    const validDate = date(detail.date);
    if (validDate) item.dates.add(validDate);
    for (const value of Array.isArray(detail.dates) ? detail.dates.slice(0, 366) : []) if (date(value)) item.dates.add(value);
    item.affectedCount += count(detail.affectedCount) ?? 1;
  }
  for (const row of Array.isArray(rows) ? rows.slice(0, 5000) : []) {
    if (!row || typeof row !== "object") continue;
    const identity = { placeId: identifier(row.place_id || row.placeId), bookingBusinessId: identifier(row["네이버예약사업자ID"] || row.bookingBusinessId),
      companyName: label(row["업체명"] || row.name || row.companyName) };
    const companyKey = identity.bookingBusinessId || identity.placeId || identity.companyName;
    if (identity.bookingBusinessId) companies.set(identity.bookingBusinessId, identity);
    const products = inlineProducts(row);
    if (products.length > 30000) detailTruncated = true;
    for (const product of products.slice(0, 30000)) {
      if (++productsRead > 100000) { detailTruncated = true; break; }
      if (!product || typeof product !== "object" || Array.isArray(product)) continue;
      const day = date(product.date || product.stayDate), productId = identifier(product.bizItemId);
      const productName = label(product.name);
      const key = JSON.stringify([companyKey, productId || productName, day, label(product.saleType)]);
      if (seenProducts.has(key)) continue;
      seenProducts.add(key);
      const rawCode = typeof product.collectionErrorCode === "string" && ["TIMEOUT", "NETWORK_ERROR", "HTTP_ERROR", "PROVIDER_BLOCKED", "GRAPHQL_ERROR", "MISSING_SCHEDULE", "INVALID_STOCK", "UNKNOWN_ERROR"].includes(product.collectionErrorCode) ? product.collectionErrorCode : "";
      const responseStatus = Number.isInteger(product.responseStatus) ? product.responseStatus : null;
      const failed = product.collectionFailed === true || Boolean(rawCode) || responseStatus >= 400;
      const stock = count(product.stock);
      if (!failed) { if (stock === 0) observedZeroScheduleCount += 1; continue; }
      productFailures += 1;
      if (stock === 0) failedZeroScheduleCount += 1;
      if (day) { const dayKey = `${identity.bookingBusinessId}:${day}`; failedByDay.set(dayKey, (failedByDay.get(dayKey) || 0) + 1); }
      add(rawCode || "SCHEDULE_RESPONSE_UNRECORDED", identity, { phase: "booking_schedule", date: day, bizItemId: productId,
        productName, httpStatus: responseStatus, recorded: Boolean(rawCode) });
    }
    const bookingStatus = String(row["네이버예약재고수집상태"] || row.bookingStatus || "");
    if (/^(?:실패|네이버예약 ID 조회 (?:오류|차단))/.test(bookingStatus)) add("BOOKING_DETAIL_UNRECORDED", identity, { phase: "booking_detail" });
    else if (bookingStatus === "네이버예약 사업자ID 없음") add("BOOKING_ID_MISSING", identity, { phase: "booking_detail", recorded: true });
    else if (bookingStatus === "객실목록 일부 오류" && !manifest?.productCoverage?.targets?.some(target => String(target?.businessId) === identity.bookingBusinessId && target.productListComplete === false)) {
      add("PRODUCT_LIST_INCOMPLETE", identity, { phase: "product_list", recorded: true, affectedCount: 1, countUnit: "companies" });
    }
    const otaStatus = row["네이버OTA관측상태"] || row.naverOtaStatus;
    if (["blocked", "auto_failed"].includes(otaStatus)) add("OTA_OBSERVATION_INCOMPLETE", identity, { phase: "ota", recorded: false });
  }
  let coverageFailures = 0;
  const productTotals = { productDiscovered: 0, productEligible: 0, productQueried: 0, productTruncated: 0, productExcluded: 0 };
  const seenBusinesses = new Set();
  for (const target of Array.isArray(manifest?.productCoverage?.targets) ? manifest.productCoverage.targets.slice(0, 5000) : []) {
    if (!target || typeof target !== "object") continue;
    const businessId = identifier(target.businessId);
    if (businessId && seenBusinesses.has(businessId)) continue;
    if (businessId) seenBusinesses.add(businessId);
    for (const [key, field] of Object.entries({ productDiscovered: "discovered", productEligible: "eligible", productQueried: "queried", productTruncated: "truncated", productExcluded: "excluded" })) {
      if (count(target[field]) === null) productTotals[key] = null;
      else if (productTotals[key] !== null) productTotals[key] += count(target[field]);
    }
    const identity = companies.get(businessId) || { bookingBusinessId: businessId };
    if (target.productListComplete === false) add("PRODUCT_LIST_INCOMPLETE", identity, { phase: "product_list", recorded: true, affectedCount: 1, countUnit: "companies" });
    if (count(target.truncated) > 0) add("PRODUCT_TARGETS_TRUNCATED", identity, { phase: "product_list", recorded: true,
      affectedCount: count(target.truncated), expectedCount: count(target.eligible), queriedCount: count(target.queried), countUnit: "products",
      dates: (Array.isArray(target.days) ? target.days : []).filter(day => count(day?.truncated) > 0).map(day => day.date) });
    for (const day of Array.isArray(target.days) ? target.days.slice(0, 366) : []) {
      if (!day || typeof day !== "object") continue;
      const failed = count(day.failed) || 0, dayKey = `${businessId}:${date(day.date)}`;
      coverageFailures += failed;
      const unrecorded = Math.max(0, failed - (failedByDay.get(dayKey) || 0));
      if (unrecorded) add("SCHEDULE_RESPONSE_UNRECORDED", identity, { date: day.date, affectedCount: unrecorded });
      const eligible = count(day.eligible), queried = count(day.queried), truncated = count(day.truncated);
      if (eligible !== null && queried !== null && truncated !== null && eligible > queried + truncated) {
        add("PRODUCT_TARGETS_INCOMPLETE", identity, { date: day.date, affectedCount: eligible - queried - truncated, recorded: true });
      }
    }
  }
  if (Array.isArray(manifest?.productCoverage?.targets)) Object.assign(counts, productTotals);
  const missingFailedDetails = Math.max(0, (counts.naverScheduleFailed || 0) - Math.max(coverageFailures, productFailures));
  if (missingFailedDetails) add("SCHEDULE_RESPONSE_UNRECORDED", {}, { affectedCount: missingFailedDetails });
  if (quality?.failure) add(quality.failure.code, {}, { ...quality.failure, recorded: true, affectedCount: 0, countUnit: "records" });
  if (!issueGroups.size && ["partial", "failed", "blocked", "interrupted", "unknown"].includes(status)) {
    add("DIAGNOSTIC_DETAILS_UNAVAILABLE", {}, { phase: "validation", affectedCount: 0 });
  }
  if ([...issueGroups.values()].some(item => item.detailStatus === "unrecorded")) knownLimitations.add("이전 수집은 실패 여부만 저장된 경우가 있어 세부 원인을 확정할 수 없습니다.");
  const allIssues = [...issueGroups.values()];
  const affectedCompanyCount = new Set(allIssues.map(item => item.placeId || item.bookingBusinessId || item.companyName).filter(Boolean)).size;
  const issues = allIssues.slice(0, MAX_ISSUES).map(item => ({ ...item, dates: [...item.dates].sort() }));
  const reasonLabel = quality?.failure ? `${PHASE_LABELS[quality.failure.phase]} · ${FAILURE_LABELS[quality.failure.code]}` : REASON_LABELS[reason];
  return { version: 1, source: "stored_artifacts", status, reason, reasonLabel,
    summary: reasonLabel + (affectedCompanyCount ? ` · 확인 대상 업체 ${affectedCompanyCount}곳` : ""), counts, issues,
    issueCount: allIssues.length, affectedCompanyCount, truncated: allIssues.length > MAX_ISSUES || detailTruncated || rows.length > 5000,
    observedZeroScheduleCount, failedZeroScheduleCount, limitations: [...knownLimitations] };
}

async function readCollectionDiagnostics({ runDir, parseCsv }) {
  const base = await fs.realpath(runDir);
  const limitations = new Set();
  let bytesRead = 0;
  async function read(relative, maxBytes) {
    if (typeof relative !== "string" || !relative || relative.includes("\\") || relative.includes(":") || path.isAbsolute(relative)
      || relative.split("/").some(part => !part || part === "." || part === "..")) throw new Error("invalid_artifact");
    const resolved = await fs.realpath(path.join(base, relative));
    const inside = path.relative(base, resolved);
    if (inside.startsWith("..") || path.isAbsolute(inside)) throw new Error("invalid_artifact");
    const stat = await fs.stat(resolved);
    if (!stat.isFile() || stat.size > maxBytes || bytesRead + stat.size > 128 * 1024 * 1024) throw new Error("oversized_artifact");
    bytesRead += stat.size;
    return (await fs.readFile(resolved, "utf8")).replace(/^\uFEFF/, "");
  }
  let manifest = null, rows = [];
  try { manifest = JSON.parse(await read("manifest.json", 4 * 1024 * 1024)); } catch { limitations.add("일부 상세 파일을 읽을 수 없어 저장된 집계만 표시합니다."); }
  const files = await fs.readdir(base);
  const overall = files.includes(manifest?.fileRoles?.overall) ? manifest.fileRoles.overall : files.find(file => file.endsWith("_overall_place_rank.csv"));
  if (overall) {
    try { rows = parseCsv(await read(overall, 64 * 1024 * 1024)); } catch { limitations.add("일부 상세 파일을 읽을 수 없어 저장된 집계만 표시합니다."); }
  }
  const details = new Map();
  for (const row of rows.slice(0, 5000)) for (const keys of PRODUCT_KEYS) for (const key of keys) {
    const value = row[key];
    if (typeof value !== "string" || !value.startsWith("@json-file:")) continue;
    const relative = value.slice("@json-file:".length).trim();
    if (!details.has(relative)) {
      try {
        if (details.size >= 500) throw new Error("too_many_artifacts");
        const parsed = JSON.parse(await read(relative, 8 * 1024 * 1024));
        details.set(relative, Array.isArray(parsed) ? parsed : []);
      } catch { details.set(relative, []); limitations.add("일부 상세 파일을 읽을 수 없어 저장된 집계만 표시합니다."); }
    }
    row[key] = details.get(relative);
  }
  return buildCollectionDiagnostics({ manifest, rows, limitations: [...limitations] });
}

module.exports = { sanitizeCollectionQuality, buildCollectionDiagnostics, readCollectionDiagnostics, REASON_LABELS };
