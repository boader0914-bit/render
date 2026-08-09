"use strict";

const { NAVER_PROVIDER_ID } = require("./naver_provider_resilience.cjs");
const {
  FIXED_LEGACY_HEADERS,
  readBoundedBody,
  safeResponseHeaders
} = require("./naver_legacy_canary_live_transport.cjs");

const PCMAP_GRAPHQL_URL = "https://pcmap-api.place.naver.com/graphql";
const BOOKING_GRAPHQL_URL = "https://m.booking.naver.com/graphql";
const DEFAULT_TIMEOUT_MS = 25_000;
const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const OPERATION_LIMITS = Object.freeze({
  naver_booking_business: 3,
  naver_booking_items: 3,
  naver_booking_schedule: 24
});
const TOP20_OPERATION_LIMITS = Object.freeze({
  naver_booking_business: 20,
  naver_booking_items: 20,
  naver_booking_schedule: 160
});
const BOUNDED_INVENTORY_PROFILES = Object.freeze({
  top3_v1: Object.freeze({
    profileId: "top3_v1",
    operationLimits: OPERATION_LIMITS,
    totalCallBudget: 30,
    maxCompanies: 3,
    maxProductsPerCompany: 8,
    strictCompanyOrder: false
  }),
  top20_v1: Object.freeze({
    profileId: "top20_v1",
    operationLimits: TOP20_OPERATION_LIMITS,
    totalCallBudget: 240,
    maxCompanies: 20,
    maxProductsPerCompany: 8,
    strictCompanyOrder: true
  })
});
const GRAPHQL_DOCUMENTS = Object.freeze({
  naver_booking_business: `
  query naverBookingBusiness($id: String!, $isNx: Boolean) {
    business: placeDetail(input: { id: $id, isNx: $isNx, deviceType: "mobile" }) {
      base {
        id
        name
      }
      naverBooking {
        bookingBusinessId
        naverBookingUrl
        naverBookingHubUrl
      }
    }
  }
`,
  naver_booking_items: `
  query searchBizItem($bizItemSearchParams: BizItemSearchParams) {
    searchBizItem(input: $bizItemSearchParams) {
      id
      bizItems {
        id
        businessId
        bizItemId
        bizItemType
        bizItemSubType
        name
        isClosedBooking
        isClosedBookingUser
        isImp
        price
        minBookingCount
        maxBookingCount
        bookableSettingJson
        bookingCountSettingJson
        priceByDates
        minMaxPrice {
          minPrice
          maxPrice
          isSinglePrice
        }
        typeValues {
          bizItemId
          code
          codeValue
        }
      }
    }
  }
`,
  naver_booking_schedule: `
  query dailySchedule($scheduleParams: ScheduleParams) {
    schedule(input: $scheduleParams) {
      bizItemSchedule {
        daily {
          date
        }
      }
    }
  }
`
});
const GRAPHQL_OPERATION_NAMES = Object.freeze({
  naver_booking_business: "naverBookingBusiness",
  naver_booking_items: "searchBizItem",
  naver_booking_schedule: "dailySchedule"
});
const TOTAL_CALL_BUDGET = 30;
const MAX_COMPANIES = 3;
const MAX_PRODUCTS_PER_COMPANY = 8;
const REGISTERED_TRANSPORTS = new WeakSet();

class NaverBoundedInventoryTransportError extends Error {
  constructor(code, message, statusCode = 502) {
    super(message);
    this.name = "NaverBoundedInventoryTransportError";
    this.code = code;
    this.statusCode = statusCode;
    this.retryable = false;
  }
}

function transportError(code, message, statusCode = 502) {
  return new NaverBoundedInventoryTransportError(code, message, statusCode);
}

function boundedPositiveInteger(value, fallback, maximum) {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw transportError("NAVER_BOUNDED_INVENTORY_TRANSPORT_INVALID", "The NAVER inventory transport limit is invalid", 400);
  }
  return parsed;
}

function safeIdentifier(value, field) {
  const text = String(value || "").trim();
  if (!/^\d{1,30}$/u.test(text)) {
    throw transportError("NAVER_BOUNDED_INVENTORY_REQUEST_INVALID", `The NAVER inventory ${field} is invalid`, 400);
  }
  return text;
}

function exactObjectKeys(value, expectedKeys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function safeCompanyOrdinal(value, maximum = MAX_COMPANIES) {
  const ordinal = Number(value);
  if (!Number.isInteger(ordinal) || ordinal < 1 || ordinal > maximum) {
    throw transportError("NAVER_BOUNDED_INVENTORY_REQUEST_INVALID", "The NAVER inventory company ordinal is invalid", 400);
  }
  return ordinal;
}

function safeProductOrdinal(value, maximum = MAX_PRODUCTS_PER_COMPANY) {
  const ordinal = Number(value);
  if (!Number.isInteger(ordinal) || ordinal < 1 || ordinal > maximum) {
    throw transportError("NAVER_BOUNDED_INVENTORY_REQUEST_INVALID", "The NAVER inventory product ordinal is invalid", 400);
  }
  return ordinal;
}

function safeBookingDate(value) {
  const text = String(value || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(text) || Number.isNaN(Date.parse(`${text}T00:00:00Z`))) {
    throw transportError("NAVER_BOUNDED_INVENTORY_REQUEST_INVALID", "The NAVER inventory booking date is invalid", 400);
  }
  return text;
}

function nextBookingDate(value) {
  const date = new Date(`${safeBookingDate(value)}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

function safeBookingAdults(value) {
  const adults = Number(value);
  if (!Number.isInteger(adults) || adults < 1 || adults > 20) {
    throw transportError("NAVER_BOUNDED_INVENTORY_REQUEST_INVALID", "The NAVER inventory adult count is invalid", 400);
  }
  return adults;
}

function assertGraphqlBody(request, normalized) {
  const body = request.body;
  if (
    !exactObjectKeys(body, ["operationName", "query", "variables"])
    || body.operationName !== GRAPHQL_OPERATION_NAMES[normalized.operation]
    || body.query !== GRAPHQL_DOCUMENTS[normalized.operation]
  ) {
    throw transportError("NAVER_BOUNDED_INVENTORY_REQUEST_INVALID", "The NAVER inventory GraphQL document is invalid", 400);
  }
  if (normalized.operation === "naver_booking_business") {
    if (
      !exactObjectKeys(body.variables, ["id", "isNx"])
      || String(body.variables.id || "") !== normalized.placeId
      || body.variables.isNx !== false
    ) {
      throw transportError("NAVER_BOUNDED_INVENTORY_REQUEST_INVALID", "The NAVER inventory business variables are invalid", 400);
    }
    return;
  }
  if (normalized.operation === "naver_booking_items") {
    if (
      !exactObjectKeys(body.variables, ["bizItemSearchParams"])
      || !exactObjectKeys(body.variables.bizItemSearchParams, ["businessId"])
      || String(body.variables.bizItemSearchParams.businessId || "") !== normalized.businessId
    ) {
      throw transportError("NAVER_BOUNDED_INVENTORY_REQUEST_INVALID", "The NAVER inventory item variables are invalid", 400);
    }
    return;
  }
  if (!exactObjectKeys(body.variables, ["scheduleParams"])) {
    throw transportError("NAVER_BOUNDED_INVENTORY_REQUEST_INVALID", "The NAVER inventory schedule variables are invalid", 400);
  }
  const params = body.variables.scheduleParams;
  const expectedDateTime = `${normalized.date}T00:00:00`;
  if (
    !exactObjectKeys(params, ["businessId", "businessTypeId", "startDateTime", "endDateTime", "bizItemId"])
    || String(params.businessId || "") !== normalized.businessId
    || params.businessTypeId !== 3
    || params.startDateTime !== expectedDateTime
    || params.endDateTime !== expectedDateTime
  ) {
    throw transportError("NAVER_BOUNDED_INVENTORY_REQUEST_INVALID", "The NAVER inventory schedule variables are invalid", 400);
  }
  normalized.bizItemId = safeIdentifier(params.bizItemId, "item ID");
}

function assertRequest(request = {}, budgetProfile = BOUNDED_INVENTORY_PROFILES.top3_v1, expectedProviderId = NAVER_PROVIDER_ID) {
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    throw transportError("NAVER_BOUNDED_INVENTORY_REQUEST_INVALID", "The NAVER inventory request is invalid", 400);
  }
  const operation = String(request.operation || "");
  if (
    request.providerId !== expectedProviderId
    || !Object.prototype.hasOwnProperty.call(budgetProfile.operationLimits, operation)
    || !request.body
    || typeof request.body !== "object"
    || Array.isArray(request.body)
  ) {
    throw transportError("NAVER_BOUNDED_INVENTORY_REQUEST_INVALID", "The NAVER inventory request is invalid", 400);
  }
  const placeId = operation === "naver_booking_business" ? safeIdentifier(request.placeId, "place ID") : "";
  const businessId = operation === "naver_booking_business" ? "" : safeIdentifier(request.businessId, "business ID");
  const date = operation === "naver_booking_schedule" ? String(request.date || "") : "";
  if (date && !/^\d{4}-\d{2}-\d{2}$/u.test(date)) {
    throw transportError("NAVER_BOUNDED_INVENTORY_REQUEST_INVALID", "The NAVER inventory date is invalid", 400);
  }
  const normalized = {
    operation,
    placeId,
    businessId,
    date,
    bookingDate: safeBookingDate(request.bookingDate),
    bookingAdults: safeBookingAdults(request.bookingAdults),
    companyOrdinal: safeCompanyOrdinal(request.companyOrdinal, budgetProfile.maxCompanies),
    productOrdinal: operation === "naver_booking_schedule"
      ? safeProductOrdinal(request.productOrdinal, budgetProfile.maxProductsPerCompany)
      : null,
    bizItemId: ""
  };
  assertGraphqlBody(request, normalized);
  return normalized;
}

async function cancelResponseBody(response) {
  try {
    await response?.body?.cancel?.();
  } catch {
    // Best effort only. A body cancellation error cannot change the result.
  }
}

function createNaverBoundedInventoryLiveTransport(options = {}) {
  if (options.enabled !== true || typeof options.fetchImpl !== "function") {
    throw transportError("NAVER_BOUNDED_INVENTORY_TRANSPORT_DISABLED", "The NAVER inventory transport is disabled", 503);
  }
  const timeoutMs = boundedPositiveInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
  const maxResponseBytes = boundedPositiveInteger(
    options.maxResponseBytes,
    DEFAULT_MAX_RESPONSE_BYTES,
    DEFAULT_MAX_RESPONSE_BYTES
  );
  const allowTextFallback = options.allowTextFallback === true;
  const beforeProviderCall = typeof options.beforeProviderCall === "function"
    ? options.beforeProviderCall
    : null;
  const onProviderCallStarted = typeof options.onProviderCallStarted === "function"
    ? options.onProviderCallStarted
    : null;
  const profileId = String(options.budgetProfileId || "top3_v1");
  const providerId = String(options.providerId || NAVER_PROVIDER_ID);
  if (!/^[a-z0-9_]{3,80}$/u.test(providerId)) {
    throw transportError("NAVER_BOUNDED_INVENTORY_TRANSPORT_INVALID", "The NAVER inventory provider identity is invalid", 400);
  }
  const budgetProfile = BOUNDED_INVENTORY_PROFILES[profileId];
  if (!budgetProfile) {
    throw transportError(
      "NAVER_BOUNDED_INVENTORY_TRANSPORT_INVALID",
      "The NAVER inventory transport budget profile is invalid",
      400
    );
  }
  const counts = {
    naver_booking_business: 0,
    naver_booking_items: 0,
    naver_booking_schedule: 0
  };
  const companyCalls = Object.fromEntries(Array.from({ length: budgetProfile.maxCompanies }, (_, index) => [
    String(index + 1),
    { bookingBusiness: 0, bookingItems: 0, dailySchedule: 0 }
  ]));
  let total = 0;
  let active = false;
  let authorizing = false;
  let maxObservedConcurrency = 0;
  let halted = false;
  let highestBusinessOrdinal = 0;

  function assertCompanyCallAvailable(normalized) {
    const ordinal = normalized.companyOrdinal;
    const state = companyCalls[String(ordinal)];
    if (normalized.operation === "naver_booking_business") {
      if (
        (budgetProfile.strictCompanyOrder
          ? ordinal !== highestBusinessOrdinal + 1
          : ordinal <= highestBusinessOrdinal)
        || state.bookingBusiness !== 0
        || state.bookingItems !== 0
        || state.dailySchedule !== 0
      ) {
        halted = true;
        throw transportError("NAVER_BOUNDED_INVENTORY_CALL_SEQUENCE_INVALID", "The NAVER inventory company call sequence is invalid", 409);
      }
      return;
    }
    if (ordinal !== highestBusinessOrdinal || state.bookingBusiness !== 1) {
      halted = true;
      throw transportError("NAVER_BOUNDED_INVENTORY_CALL_SEQUENCE_INVALID", "The NAVER inventory company call sequence is invalid", 409);
    }
    if (normalized.operation === "naver_booking_items") {
      if (state.bookingItems !== 0 || state.dailySchedule !== 0) {
        halted = true;
        throw transportError("NAVER_BOUNDED_INVENTORY_CALL_SEQUENCE_INVALID", "The NAVER inventory company call sequence is invalid", 409);
      }
      return;
    }
    if (state.bookingItems !== 1 || normalized.productOrdinal !== state.dailySchedule + 1) {
      halted = true;
      throw transportError("NAVER_BOUNDED_INVENTORY_CALL_SEQUENCE_INVALID", "The NAVER inventory product call sequence is invalid", 409);
    }
    if (state.dailySchedule >= budgetProfile.maxProductsPerCompany) {
      halted = true;
      throw transportError("NAVER_BOUNDED_INVENTORY_CALL_BUDGET_EXCEEDED", "The NAVER inventory company call budget was exceeded", 409);
    }
  }

  function reserveCompanyCall(normalized) {
    const ordinal = normalized.companyOrdinal;
    const state = companyCalls[String(ordinal)];
    if (normalized.operation === "naver_booking_business") {
      highestBusinessOrdinal = ordinal;
      state.bookingBusiness += 1;
      return;
    }
    if (normalized.operation === "naver_booking_items") {
      state.bookingItems += 1;
      return;
    }
    state.dailySchedule += 1;
  }

  const transport = async function naverBoundedInventoryLiveTransport(request, context = {}) {
    const normalized = assertRequest(request, budgetProfile, providerId);
    if (halted) {
      throw transportError("NAVER_BOUNDED_INVENTORY_HALTED", "The NAVER inventory transport is halted", 409);
    }
    if (context.signal?.aborted) {
      throw transportError("NAVER_BOUNDED_INVENTORY_ABORTED", "The NAVER inventory request was aborted", 499);
    }
    if (active || authorizing) {
      throw transportError("NAVER_BOUNDED_INVENTORY_CONCURRENCY_EXCEEDED", "The NAVER inventory concurrency limit was exceeded", 409);
    }
    if (
      total >= budgetProfile.totalCallBudget
      || counts[normalized.operation] >= budgetProfile.operationLimits[normalized.operation]
    ) {
      halted = true;
      throw transportError("NAVER_BOUNDED_INVENTORY_CALL_BUDGET_EXCEEDED", "The NAVER inventory call budget was exceeded", 409);
    }

    assertCompanyCallAvailable(normalized);
    if (beforeProviderCall) {
      authorizing = true;
      try {
        await beforeProviderCall(Object.freeze({
          providerId,
          operation: normalized.operation,
          companyOrdinal: normalized.companyOrdinal,
          productOrdinal: normalized.productOrdinal
        }));
      } catch (error) {
        halted = true;
        throw error;
      } finally {
        authorizing = false;
      }
      if (context.signal?.aborted) {
        halted = true;
        throw transportError("NAVER_BOUNDED_INVENTORY_ABORTED", "The NAVER inventory request was aborted", 499);
      }
    }
    reserveCompanyCall(normalized);

    const endpoint = normalized.operation === "naver_booking_business" ? PCMAP_GRAPHQL_URL : BOOKING_GRAPHQL_URL;
    const referer = normalized.operation === "naver_booking_business"
      ? `https://pcmap.place.naver.com/accommodation/${normalized.placeId}`
      : `https://m.booking.naver.com/booking/3/bizes/${normalized.businessId}/search?startDate=${normalized.bookingDate}&endDate=${nextBookingDate(normalized.bookingDate)}&adult=${normalized.bookingAdults}`;
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    context.signal?.addEventListener?.("abort", onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    active = true;
    maxObservedConcurrency = Math.max(maxObservedConcurrency, 1);

    try {
      const responsePromise = Promise.resolve(options.fetchImpl(endpoint, {
        method: "POST",
        headers: {
          ...FIXED_LEGACY_HEADERS,
          accept: "*/*",
          "content-type": "application/json",
          origin: normalized.operation === "naver_booking_business"
            ? "https://pcmap.place.naver.com"
            : "https://m.booking.naver.com",
          referer
        },
        redirect: "manual",
        signal: controller.signal,
        body: JSON.stringify(request.body)
      }));
      counts[normalized.operation] += 1;
      total += 1;
      if (onProviderCallStarted) {
        try {
          await onProviderCallStarted(Object.freeze({
            providerId,
            operation: normalized.operation,
            companyOrdinal: normalized.companyOrdinal,
            productOrdinal: normalized.productOrdinal
          }));
        } catch (error) {
          controller.abort();
          await responsePromise.catch(() => {});
          throw error;
        }
      }
      const response = await responsePromise;
      const status = Number(response?.status);
      if (!Number.isInteger(status) || status < 100 || status > 599) {
        throw transportError("NAVER_BOUNDED_INVENTORY_RESPONSE_INVALID", "The NAVER inventory response is invalid", 502);
      }
      if (status === 403 || status === 429) await cancelResponseBody(response);
      const body = status === 403 || status === 429
        ? ""
        : await readBoundedBody(response, maxResponseBytes, { allowTextFallback });
      return Object.freeze({
        status,
        headers: safeResponseHeaders(response.headers),
        body
      });
    } catch (error) {
      if (error instanceof NaverBoundedInventoryTransportError || error?.code === "V2_TOP20_PROVIDER_CALL_HEARTBEAT_FAILED") throw error;
      if (controller.signal.aborted) {
        halted = true;
        throw transportError(
          context.signal?.aborted ? "NAVER_BOUNDED_INVENTORY_ABORTED" : "NAVER_BOUNDED_INVENTORY_TIMEOUT",
          context.signal?.aborted ? "The NAVER inventory request was aborted" : "The NAVER inventory request timed out",
          context.signal?.aborted ? 499 : 504
        );
      }
      halted = true;
      throw transportError("NAVER_BOUNDED_INVENTORY_TRANSPORT_FAILED", "The NAVER inventory transport failed", 502);
    } finally {
      active = false;
      clearTimeout(timer);
      context.signal?.removeEventListener?.("abort", onAbort);
    }
  };

  Object.defineProperties(transport, {
    callCounts: {
      value: () => Object.freeze({ ...counts, total }),
      enumerable: false
    },
    companyCallCounts: {
      value: () => Object.freeze(Object.fromEntries(Object.entries(companyCalls).map(([key, value]) => [
        key,
        Object.freeze({ ...value })
      ]))),
      enumerable: false
    },
    maxCalls: {
      value: budgetProfile.totalCallBudget,
      enumerable: false
    },
    budgetProfileId: {
      value: budgetProfile.profileId,
      enumerable: false
    },
    maxObservedConcurrency: {
      value: () => maxObservedConcurrency,
      enumerable: false
    },
    halt: {
      value: () => { halted = true; },
      enumerable: false
    },
    isHalted: {
      value: () => halted,
      enumerable: false
    }
  });
  REGISTERED_TRANSPORTS.add(transport);
  return Object.freeze(transport);
}

function isRegisteredNaverBoundedInventoryLiveTransport(value) {
  return typeof value === "function" && REGISTERED_TRANSPORTS.has(value);
}

module.exports = {
  BOUNDED_INVENTORY_PROFILES,
  BOOKING_GRAPHQL_URL,
  DEFAULT_MAX_RESPONSE_BYTES,
  DEFAULT_TIMEOUT_MS,
  GRAPHQL_DOCUMENTS,
  GRAPHQL_OPERATION_NAMES,
  MAX_COMPANIES,
  MAX_PRODUCTS_PER_COMPANY,
  NaverBoundedInventoryTransportError,
  OPERATION_LIMITS,
  TOP20_OPERATION_LIMITS,
  PCMAP_GRAPHQL_URL,
  TOTAL_CALL_BUDGET,
  createNaverBoundedInventoryLiveTransport,
  isRegisteredNaverBoundedInventoryLiveTransport
};
