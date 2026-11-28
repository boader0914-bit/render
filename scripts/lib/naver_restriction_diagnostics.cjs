"use strict";

// Optional, bounded diagnostics only. Never return a URL, query, header value,
// provider body or request contents, and never consume a Request body stream.
const MAX_INPUT_URL_LENGTH = 4096;
const MAX_REQUEST_BODY_BYTES = 64 * 1024;
const MAX_RETRY_AFTER_SECONDS = 7 * 24 * 60 * 60;
const PLACE_OPERATIONS = new Set(["naverPlaceChannelObservation", "naverBookingBusiness"]);
const BOOKING_OPERATIONS = new Set(["searchBizItem", "dailySchedule"]);
const CATEGORIES = new Set(["place_search", "place_graphql", "place_document", "booking_graphql"]);
const PUBLIC_PLACE_ID = /^[1-9]\d{0,29}$/;
const PUBLIC_COMPANY_ID = /^cmp_place_[1-9]\d{0,29}$/;

function describeNaverRequest(input, init) {
  try {
    let raw = typeof input === "string" ? input : null;
    if (input instanceof URL) raw = Object.getOwnPropertyDescriptor(URL.prototype, "href").get.call(input);
    else if (typeof Request === "function" && input instanceof Request) {
      raw = Object.getOwnPropertyDescriptor(Request.prototype, "url").get.call(input);
    } else if (input && typeof input === "object") {
      const descriptor = Object.getOwnPropertyDescriptor(input, "url");
      if (descriptor && "value" in descriptor) raw = descriptor.value;
    }
    if (typeof raw !== "string" || raw.length > MAX_INPUT_URL_LENGTH) return {};
    const url = new URL(raw);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return {};
    const host = url.hostname.toLowerCase().replace(/\.$/, ""), pathname = url.pathname;
    if (host === "pcmap.place.naver.com" && pathname === "/accommodation/list") {
      return { endpointCategory: "place_search" };
    }
    if (["pcmap.place.naver.com", "m.place.naver.com"].includes(host)) {
      const place = /^\/accommodation\/([1-9]\d{0,29})(?:\/(?:home|room))?\/?$/.exec(pathname);
      if (place) return { endpointCategory: "place_document", targetCompanyId: `cmp_place_${place[1]}` };
    }
    const endpointCategory = host === "pcmap-api.place.naver.com" && pathname === "/graphql" ? "place_graphql"
      : host === "m.booking.naver.com" && pathname === "/graphql" ? "booking_graphql" : null;
    if (!endpointCategory) return {};
    const result = { endpointCategory };
    // A Request's stream is deliberately not inspected. Existing crawler calls
    // supply a string init.body; unknown/large bodies retain endpoint-only data.
    const descriptor = init && typeof init === "object" ? Object.getOwnPropertyDescriptor(init, "body") : null;
    const body = descriptor && "value" in descriptor ? descriptor.value : null;
    if (typeof body !== "string" || body.length > MAX_REQUEST_BODY_BYTES
      || Buffer.byteLength(body, "utf8") > MAX_REQUEST_BODY_BYTES) return result;
    let request;
    try { request = JSON.parse(body); } catch { return result; }
    const operation = request?.operationName;
    const known = endpointCategory === "place_graphql" ? PLACE_OPERATIONS : BOOKING_OPERATIONS;
    if (!known.has(operation)) return result;
    result.operationName = operation;
    const placeId = endpointCategory === "place_graphql" ? request?.variables?.id : null;
    if (typeof placeId === "string" && PUBLIC_PLACE_ID.test(placeId)) result.targetCompanyId = `cmp_place_${placeId}`;
    return result;
  } catch { return {}; }
}

function parseRetryAfterSeconds(value, now = Date.now) {
  try {
    if (typeof value !== "string" || value.length > 64) return null;
    const text = value.trim();
    if (/^\d{1,7}$/.test(text)) {
      const seconds = Number(text);
      return Number.isSafeInteger(seconds) && seconds <= MAX_RETRY_AFTER_SECONDS ? seconds : null;
    }
    // Date.parse alone accepts unrelated date-like strings. Accept only an
    // exact IMF-fixdate, with a matching calendar and weekday, in UTC.
    if (!/^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(text)) return null;
    const target = Date.parse(text);
    if (!Number.isFinite(target) || new Date(target).toUTCString() !== text) return null;
    const observed = typeof now === "function" ? now() : now;
    if (!Number.isFinite(observed) || target < observed) return null;
    const seconds = Math.ceil((target - observed) / 1000);
    return Number.isSafeInteger(seconds) && seconds >= 0 && seconds <= MAX_RETRY_AFTER_SECONDS ? seconds : null;
  } catch { return null; }
}

function sanitizeRestrictionDetails(metadata) {
  const result = {};
  try {
    const category = metadata?.endpointCategory;
    if (CATEGORIES.has(category)) {
      result.endpointCategory = category;
      const operation = metadata?.operationName;
      if ((category === "place_graphql" && PLACE_OPERATIONS.has(operation))
        || (category === "booking_graphql" && BOOKING_OPERATIONS.has(operation))) result.operationName = operation;
      const company = metadata?.targetCompanyId;
      if ((category === "place_document" || category === "place_graphql" && result.operationName)
        && typeof company === "string" && PUBLIC_COMPANY_ID.test(company)) result.targetCompanyId = company;
    }
    const seconds = metadata?.retryAfterSeconds;
    if (Number.isSafeInteger(seconds) && seconds >= 0 && seconds <= MAX_RETRY_AFTER_SECONDS) result.retryAfterSeconds = seconds;
  } catch { /* A broken optional field must not affect guard or core telemetry. */ }
  return result;
}

module.exports = { describeNaverRequest, parseRetryAfterSeconds, sanitizeRestrictionDetails, MAX_RETRY_AFTER_SECONDS };
