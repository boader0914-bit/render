"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const {
  CollectionWorkerRunTransactionError,
  buildV2RunProjections,
} = require("./collection_worker_run_transaction.cjs");
const { installFixtureNetworkGuard } = require("./fixture_network_guard.cjs");

const guard = installFixtureNetworkGuard({ label: "resilient run projection fixtures" });
const HASH = "a".repeat(64);
const TRANSACTION_ID = "b".repeat(64);
const RUN_ID = "preview-worker-run-0123456789abcdef0123";

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function artifactFile(content) {
  const buffer = Buffer.from(content, "utf8");
  return Object.freeze({
    contentBase64: buffer.toString("base64"),
    size: buffer.length,
    sha256: sha256(buffer),
  });
}

function csvCell(value) {
  const text = String(value ?? "");
  return /[",\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function fixturePlaceId(ordinal) {
  return String(35644667 + ordinal);
}

function fixture(options = {}) {
  const collectionStatus = options.collectionStatus || "complete";
  const statuses = options.statuses || Array.from({ length: 20 }, () => "ready");
  const headers = [
    "overall_rank", "place_id", "업체명", "주소", "숙박상품수", "데이유즈상품수",
    "숙박예약가능수", "데이유즈예약가능수", "숙박기준일평균판매단가", "예약최저가",
    "데이유즈기준일평균판매단가", "숙박기준일예상매출", "데이유즈기준일예상매출",
    "숙박기준일가격확인판매수량", "데이유즈기준일가격확인판매수량",
  ];
  const rows = statuses.map((status, index) => {
    const ordinal = index + 1;
    const ready = status === "ready";
    const includeRevenue = options.incompleteRevenueAt !== ordinal;
    return [
      ordinal,
      fixturePlaceId(ordinal),
      ordinal === 1 ? "월명글램핑" : `Synthetic ${ordinal}`,
      `Synthetic address ${ordinal}`,
      ready ? 1 : "",
      "",
      ready ? 1 : "",
      "",
      ready ? 100000 : "",
      ready ? "100000원" : "",
      "",
      ready && includeRevenue ? 100000 : "",
      ready && includeRevenue ? 0 : "",
      ready && includeRevenue ? 1 : "",
      ready && includeRevenue ? 0 : "",
    ];
  });
  if (options.removeRankingRow === true) rows.pop();
  const csv = options.invalidCsv === true
    ? `${headers.join(",")}\n1,"unterminated\n`
    : `${headers.join(",")}\n${rows.map((row) => row.map(csvCell).join(",")).join("\n")}\n`;
  const checkOut = options.checkOut || "2026-08-10";
  const rangeDates = checkOut === "2026-08-12"
    ? ["2026-08-10", "2026-08-11", "2026-08-12"]
    : [];
  const targetResults = statuses.map((status, index) => ({
    companyOrdinal: index + 1,
    placeId: fixturePlaceId(index + 1),
    detailCollectionStatus: status,
    bookingBusinessIdSource: "none",
    revenueInputValid: status === "ready",
    rangeObservations: status === "ready" ? rangeDates.map((date, dayOffset) => ({
      date,
      availableUnits: 1,
      totalUnits: 2,
      soldOutUnits: 1,
      estimatedRevenue: 100000 + dayOffset,
      estimatedSoldUnits: 1,
      missingPriceSoldUnits: 0
    })) : [],
  }));
  if (options.unsupportedStatusAt) {
    targetResults[options.unsupportedStatusAt - 1].detailCollectionStatus = "unrecognized";
  }
  if (options.identityMismatchAt) {
    targetResults[options.identityMismatchAt - 1].placeId = "99999999";
  }
  if (options.invalidPlaceIdAt) {
    targetResults[options.invalidPlaceIdAt - 1].placeId = "place-invalid";
  }
  return Object.freeze({
    artifactHash: HASH,
    jobId: "job-resilient-run-projection-0001",
    contractHash: "c".repeat(64),
    executionIdentityHash: "d".repeat(64),
    verifiedContents: {
      manifest: {
        collectionCompletedAt: "2026-08-10T00:00:00.000Z",
        checkIn: "2026-08-10",
        checkOut,
        searchRegionKey: "kr_gyeongnam_fixture",
        revenueEstimateBasis: "public_inventory_estimate",
      },
      targetResults,
      summary: {
        collectionStatus,
        detailStatus: collectionStatus === "rank_only" ? "unavailable" : "partial",
      },
    },
    filesByPath: new Map([["run/overall.csv", artifactFile(csv)]]),
  });
}

function expectReason(value, reason, expected = {}) {
  assert.throws(
    () => buildV2RunProjections(value, TRANSACTION_ID, RUN_ID),
    (error) => {
      assert.ok(error instanceof CollectionWorkerRunTransactionError);
      assert.equal(error.code, "COLLECTION_RUN_OUTPUT_PROJECTION_INVALID");
      assert.equal(error.safeMeta?.stage, "run_projection");
      assert.equal(error.safeMeta?.reason, reason);
      for (const [key, expectedValue] of Object.entries(expected)) {
        assert.equal(error.safeMeta?.[key], expectedValue);
      }
      assert.equal(Object.hasOwn(error.safeMeta || {}, "rawRow"), false);
      assert.equal(Object.hasOwn(error.safeMeta || {}, "displayName"), false);
      assert.equal(Object.hasOwn(error.safeMeta || {}, "url"), false);
      return true;
    },
  );
}

try {
  const complete = buildV2RunProjections(fixture(), TRANSACTION_ID, RUN_ID);
  assert.equal(complete.run.collectionStatus, "complete");
  assert.equal(complete.companies.length, 20);
  assert.equal(complete.revenues.length, 20);

  const range = buildV2RunProjections(fixture({ checkOut: "2026-08-12" }), TRANSACTION_ID, RUN_ID);
  assert.equal(range.run.schemaVersion, "collection-worker-v2-top20-derived-projections.v3");
  assert.equal(range.run.bookingRangeDays, 3);
  assert.equal(range.run.dateObservationReadyCount, 60);
  assert.equal(range.revenues.length, 60);
  assert.equal(range.history.length, 60);
  assert.equal(range.history.every((entry) => /^2026-08-1[0-2]$/u.test(entry.observationDate)), true);

  const partial = buildV2RunProjections(fixture({
    collectionStatus: "partial",
    statuses: ["ready", "blocked", "not_collected", ...Array.from({ length: 17 }, () => "missing")],
  }), TRANSACTION_ID, RUN_ID);
  assert.equal(partial.companies.length, 20);
  assert.equal(partial.revenues.length, 1);
  assert.equal(partial.history.length, 1);
  assert.equal(partial.companies.filter((company) => company.status === "missing").length, 17);

  const rankOnly = buildV2RunProjections(fixture({
    collectionStatus: "rank_only",
    statuses: Array.from({ length: 20 }, () => "missing"),
  }), TRANSACTION_ID, RUN_ID);
  assert.equal(rankOnly.companies.length, 20);
  assert.equal(rankOnly.run.mainPlaceStatus, "ready");
  assert.equal(rankOnly.run.collectionStatus, "rank_only");
  assert.equal(rankOnly.companies[0].displayName, "월명글램핑");
  assert.equal(rankOnly.companies[0].placeId, "35644668");
  assert.equal(rankOnly.companies[0].companyKey, "naver-place:35644668");
  assert.equal(rankOnly.companies.every((company) => company.companyKey === `naver-place:${company.placeId}`), true);
  assert.equal(rankOnly.companies.every((company) => company.bookingBusinessIdSource === "none"), true);
  assert.equal(rankOnly.products.length, 0);
  assert.equal(rankOnly.revenues.length, 0);
  assert.equal(rankOnly.history.length, 0);

  expectReason(fixture({ collectionStatus: "partial", unsupportedStatusAt: 2 }), "unsupported_target_status", {
    collectionStatus: "partial", targetStatus: "unrecognized", companyOrdinal: 2,
  });
  expectReason(fixture({ incompleteRevenueAt: 3 }), "ready_revenue_observation_incomplete", {
    collectionStatus: "complete", targetStatus: "ready", companyOrdinal: 3,
  });
  expectReason(fixture({ removeRankingRow: true }), "ranking_incomplete", {
    collectionStatus: "complete",
  });
  expectReason(fixture({ identityMismatchAt: 1 }), "company_identity_mismatch", {
    collectionStatus: "complete", companyOrdinal: 1,
  });
  assert.throws(
    () => buildV2RunProjections(fixture({ invalidPlaceIdAt: 1 }), TRANSACTION_ID, RUN_ID),
    (error) => error instanceof CollectionWorkerRunTransactionError
      && error.code === "COLLECTION_RUN_ARTIFACT_INVALID"
      && /placeId is invalid/u.test(error.message),
  );
  expectReason(fixture({ invalidCsv: true }), "csv_quoting_invalid", { field: "overall" });

  assert.equal(guard.blockedAttempts(), 0);
  console.log(JSON.stringify({
    complete: true,
    boundedDateRange: true,
    partial: true,
    rankOnly: true,
    placeIdPrimaryIdentity: true,
    bookingMappingOptional: true,
    reasons: ["unsupported_target_status", "ready_revenue_observation_incomplete", "ranking_incomplete", "company_identity_mismatch", "invalid_place_id", "csv_quoting_invalid"],
    externalNetworkCalls: 0,
  }));
} finally {
  guard.restore();
}
