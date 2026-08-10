"use strict";

// The worker calls this adapter exactly once.  It deliberately delegates all
// collection decisions to the existing V2 child rather than duplicating the
// main-place, Booking, pricing, or revenue algorithms in the worker layer.
const {
  executeV2Top20Collector
} = require("./collection_worker_v2_top20_collector.cjs");
const {
  V2_COLLECTION_EXECUTION_PROFILE,
  buildV2CollectionPlan,
  normalizeV2CollectionRequest
} = require("./v2_collection_request.cjs");

const V2_COLLECTOR_SINGLE_SOURCE_SCHEMA_VERSION = "v2-collector-single-source-adapter.v1";

function v2CollectorProviderPolicy(input = {}) {
  const mainPlace = input.mainPlace && typeof input.mainPlace === "object" ? input.mainPlace : {};
  const detail = input.bookingDetail && typeof input.bookingDetail === "object" ? input.bookingDetail : {};
  const retryAtElapsed = (state) => !state.retryAt || Date.parse(state.retryAt) <= Date.parse(input.now || new Date().toISOString());
  const mainAllowed = mainPlace.state === "closed" || (mainPlace.state === "open" && retryAtElapsed(mainPlace));
  const detailLiveCallsAllowed = detail.state === "closed" || (detail.state === "open" && retryAtElapsed(detail));
  return Object.freeze({
    mainAllowed,
    mainRecoveryInNormalJob: mainPlace.state === "open" && mainAllowed,
    detailLiveCallsAllowed,
    detailRecoveryInNormalJob: detail.state === "open" && detailLiveCallsAllowed,
    detailCooldown: detail.state === "open" && !detailLiveCallsAllowed
  });
}

async function executeV2CollectorSingleSource(input = {}) {
  const request = normalizeV2CollectionRequest({
    ...input.contract,
    clientRequestId: input.contract?.clientRequestId || input.clientRequestId || "fixture-v2-single-source"
  });
  const policy = v2CollectorProviderPolicy({
    mainPlace: input.mainPlaceProvider,
    bookingDetail: input.bookingDetailProvider,
    now: input.now
  });
  if (!policy.mainAllowed) {
    const error = Object.assign(new Error("main Place provider cooldown is active"), {
      code: "NAVER_PROVIDER_COOLDOWN_ACTIVE",
      statusCode: 503,
      retryable: false
    });
    throw error;
  }
  const collector = await executeV2Top20Collector({
    ...input,
    contract: {
      keyword: request.keyword,
      searchMode: request.searchMode,
      collectionMode: request.collectionMode,
      collectionPurpose: request.collectionPurpose,
      productMode: request.productMode,
      checkIn: request.checkIn,
      checkOut: request.checkOut,
      bookingRangeDays: request.bookingRangeDays,
      rankStart: request.rankStart,
      rankEnd: request.rankEnd,
      detailRankStart: request.detailRankStart,
      detailRankEnd: request.detailRankEnd
    },
    detailLiveCallsAllowed: policy.detailLiveCallsAllowed,
    bookingIdFallback: input.bookingIdFallback === true
  });
  return Object.freeze({
    ...collector,
    schemaVersion: V2_COLLECTOR_SINGLE_SOURCE_SCHEMA_VERSION,
    executionProfile: V2_COLLECTION_EXECUTION_PROFILE,
    request,
    plan: buildV2CollectionPlan(request),
    providerPolicy: policy
  });
}

module.exports = {
  V2_COLLECTOR_SINGLE_SOURCE_SCHEMA_VERSION,
  executeV2CollectorSingleSource,
  v2CollectorProviderPolicy
};
