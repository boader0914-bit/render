"use strict";

const assert = require("node:assert/strict");
const {
  V2_TOP20_RESILIENCE_MAXIMUM_PROVIDER_CALLS,
  normalizeHistoricalBookingHints,
  providerIdForOperation,
  summarizeResilientTop20Collection,
  validateResilientProviderTrace
} = require("./collection_worker_v2_top20_resilience.cjs");

const places = Array.from({ length: 20 }, (_, index) => String(1000 + index));
const targets = (status, count = 20) => places.map((placeId, index) => ({
  placeId,
  detailCollectionStatus: index < count ? status : "not_collected",
  revenueInputValid: index < count && status === "ready"
}));

assert.equal(providerIdForOperation("main_place"), "naver_place_main");
assert.equal(providerIdForOperation("booking_items"), "naver_booking_detail");
assert.equal(V2_TOP20_RESILIENCE_MAXIMUM_PROVIDER_CALLS, 241);

assert.equal(summarizeResilientTop20Collection({ mainPlaceStatus: "ready", targets: targets("ready") }).collectionStatus, "complete");
assert.equal(summarizeResilientTop20Collection({ mainPlaceStatus: "ready", targets: targets("ready", 3), detailCircuitOpen: true }).collectionStatus, "partial");
assert.equal(summarizeResilientTop20Collection({ mainPlaceStatus: "ready", targets: targets("blocked", 0), detailCircuitOpen: true }).collectionStatus, "rank_only");
assert.equal(summarizeResilientTop20Collection({ mainPlaceStatus: "blocked", targets: [] }).resultStored, false);

const hints = normalizeHistoricalBookingHints([
  { placeId: "1000", bookingBusinessId: "9000", sourceRunId: "run-a", verifiedAt: "2026-08-01T00:00:00.000Z", lastSeenAt: "2026-08-02T00:00:00.000Z" }
], { placeIds: new Set(places) });
assert.equal(hints[0].sourceRunId, "run-a");
assert.throws(() => normalizeHistoricalBookingHints([
  { placeId: "1000", bookingBusinessId: "9000", sourceRunId: "run-a", verifiedAt: "2026-08-01T00:00:00.000Z", lastSeenAt: "2026-08-02T00:00:00.000Z" },
  { placeId: "1000", bookingBusinessId: "9001", sourceRunId: "run-b", verifiedAt: "2026-08-01T00:00:00.000Z", lastSeenAt: "2026-08-02T00:00:00.000Z" }
]));

const trace = [
  { requestOrdinal: 1, operation: "main_place" },
  { requestOrdinal: 2, operation: "booking_business_graphql" },
  { requestOrdinal: 3, operation: "booking_business_place_page" },
  { requestOrdinal: 4, operation: "booking_items" },
  { requestOrdinal: 5, operation: "daily_schedule" }
];
assert.equal(validateResilientProviderTrace(trace).total, 5);
assert.throws(() => validateResilientProviderTrace([{ requestOrdinal: 1, operation: "booking_items" }]));

console.log("collection_worker_v2_top20_resilience: ok");
