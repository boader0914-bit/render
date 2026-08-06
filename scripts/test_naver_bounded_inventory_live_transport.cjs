"use strict";

const assert = require("node:assert/strict");
const { installFixtureNetworkGuard } = require("./fixture_network_guard.cjs");
const {
  GRAPHQL_DOCUMENTS,
  TOTAL_CALL_BUDGET,
  createNaverBoundedInventoryLiveTransport
} = require("./naver_bounded_inventory_live_transport.cjs");

const guard = installFixtureNetworkGuard({ label: "NAVER bounded inventory transport fixtures" });

function businessRequest(index = 1) {
  return {
    providerId: "naver_place_search",
    bookingDate: "2026-08-06",
    bookingAdults: 2,
    operation: "naver_booking_business",
    companyOrdinal: index,
    placeId: String(1000 + index),
    body: {
      operationName: "naverBookingBusiness",
      query: GRAPHQL_DOCUMENTS.naver_booking_business,
      variables: { id: String(1000 + index), isNx: false }
    }
  };
}

function itemsRequest(index = 1) {
  return {
    providerId: "naver_place_search",
    bookingDate: "2026-08-06",
    bookingAdults: 2,
    operation: "naver_booking_items",
    companyOrdinal: index,
    businessId: String(2000 + index),
    body: {
      operationName: "searchBizItem",
      query: GRAPHQL_DOCUMENTS.naver_booking_items,
      variables: { bizItemSearchParams: { businessId: String(2000 + index) } }
    }
  };
}

function scheduleRequest(companyOrdinal = 1, itemOrdinal = 1) {
  const businessId = String(2000 + companyOrdinal);
  const bizItemId = String(companyOrdinal * 100 + itemOrdinal);
  return {
    providerId: "naver_place_search",
    bookingDate: "2026-08-06",
    bookingAdults: 2,
    operation: "naver_booking_schedule",
    companyOrdinal,
    businessId,
    date: "2026-08-06",
    body: {
      operationName: "dailySchedule",
      query: GRAPHQL_DOCUMENTS.naver_booking_schedule,
      variables: {
        scheduleParams: {
          businessId,
          businessTypeId: 3,
          startDateTime: "2026-08-06T00:00:00",
          endDateTime: "2026-08-06T00:00:00",
          bizItemId
        }
      }
    }
  };
}

(async () => {
  try {
    const calls = [];
    const transport = createNaverBoundedInventoryLiveTransport({
      enabled: true,
      fetchImpl: async (url, init) => {
        calls.push({ hostname: new URL(url).hostname, method: init.method, referer: init.headers.referer });
        return new Response(JSON.stringify({ data: {} }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
    });
    for (let companyOrdinal = 1; companyOrdinal <= 3; companyOrdinal += 1) {
      await transport(businessRequest(companyOrdinal));
      await transport(itemsRequest(companyOrdinal));
      for (let itemOrdinal = 1; itemOrdinal <= 8; itemOrdinal += 1) {
        await transport(scheduleRequest(companyOrdinal, itemOrdinal));
      }
    }
    assert.equal(calls.length, TOTAL_CALL_BUDGET);
    assert.deepEqual(transport.callCounts(), {
      naver_booking_business: 3,
      naver_booking_items: 3,
      naver_booking_schedule: 24,
      total: 30
    });
    assert.deepEqual(transport.companyCallCounts(), {
      1: { bookingBusiness: 1, bookingItems: 1, dailySchedule: 8 },
      2: { bookingBusiness: 1, bookingItems: 1, dailySchedule: 8 },
      3: { bookingBusiness: 1, bookingItems: 1, dailySchedule: 8 }
    });
    assert.equal(transport.maxObservedConcurrency(), 1);
    assert.equal(
      calls.find((call) => call.hostname === "m.booking.naver.com")?.referer,
      "https://m.booking.naver.com/booking/3/bizes/2001/search?startDate=2026-08-06&endDate=2026-08-07&adult=2"
    );
    await assert.rejects(() => transport(scheduleRequest(3, 9)), { code: "NAVER_BOUNDED_INVENTORY_CALL_BUDGET_EXCEEDED" });
    assert.equal(calls.length, TOTAL_CALL_BUDGET, "a budget rejection must not start fetch");

    let releaseFirst;
    const firstPending = new Promise((resolve) => { releaseFirst = resolve; });
    const concurrency = createNaverBoundedInventoryLiveTransport({
      enabled: true,
      fetchImpl: async () => {
        await firstPending;
        return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
      }
    });
    const first = concurrency(businessRequest(1));
    await assert.rejects(() => concurrency(businessRequest(2)), { code: "NAVER_BOUNDED_INVENTORY_CONCURRENCY_EXCEEDED" });
    releaseFirst();
    await first;
    assert.equal(concurrency.callCounts().total, 1);

    const invalidBody = createNaverBoundedInventoryLiveTransport({
      enabled: true,
      fetchImpl: async () => { throw new Error("must not fetch"); }
    });
    const mismatchedQuery = businessRequest(1);
    mismatchedQuery.body.query = GRAPHQL_DOCUMENTS.naver_booking_items;
    await assert.rejects(() => invalidBody(mismatchedQuery), { code: "NAVER_BOUNDED_INVENTORY_REQUEST_INVALID" });
    const mismatchedVariable = businessRequest(1);
    mismatchedVariable.body.variables.id = "9999";
    await assert.rejects(() => invalidBody(mismatchedVariable), { code: "NAVER_BOUNDED_INVENTORY_REQUEST_INVALID" });
    assert.equal(invalidBody.callCounts().total, 0);

    const invalidSequence = createNaverBoundedInventoryLiveTransport({
      enabled: true,
      fetchImpl: async () => new Response("{}", { status: 200 })
    });
    await assert.rejects(() => invalidSequence(itemsRequest(1)), { code: "NAVER_BOUNDED_INVENTORY_CALL_SEQUENCE_INVALID" });
    assert.equal(invalidSequence.callCounts().total, 0);

    const companyCap = createNaverBoundedInventoryLiveTransport({
      enabled: true,
      fetchImpl: async () => new Response("{}", { status: 200 })
    });
    await companyCap(businessRequest(1));
    await companyCap(itemsRequest(1));
    for (let itemOrdinal = 1; itemOrdinal <= 8; itemOrdinal += 1) {
      await companyCap(scheduleRequest(1, itemOrdinal));
    }
    await assert.rejects(
      () => companyCap(scheduleRequest(1, 9)),
      { code: "NAVER_BOUNDED_INVENTORY_CALL_BUDGET_EXCEEDED" }
    );
    assert.equal(companyCap.callCounts().total, 10, "the ninth company schedule must not start fetch");

    let textRead = false;
    const blocked = createNaverBoundedInventoryLiveTransport({
      enabled: true,
      fetchImpl: async () => ({
        status: 403,
        headers: new Headers({ "content-type": "text/html" }),
        body: { cancel: async () => {} },
        text: async () => { textRead = true; return "forbidden"; }
      })
    });
    const blockedResponse = await blocked(businessRequest(1));
    assert.equal(blockedResponse.status, 403);
    assert.equal(blockedResponse.body, "");
    assert.equal(textRead, false, "403 body must not be read");

    const disabledError = () => createNaverBoundedInventoryLiveTransport({ enabled: false, fetchImpl: async () => {} });
    assert.throws(disabledError, { code: "NAVER_BOUNDED_INVENTORY_TRANSPORT_DISABLED" });
    assert.equal(guard.blockedAttempts(), 0);
    console.log("NAVER bounded inventory transport fixtures passed.");
  } finally {
    guard.restore();
  }
})().catch((error) => {
  guard.restore();
  console.error(error);
  process.exitCode = 1;
});
