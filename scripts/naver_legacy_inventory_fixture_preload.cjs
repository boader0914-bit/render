"use strict";

const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const { apolloHtml, createApolloFixture } = require("./naver_collector_fixture_factory.cjs");

const auditFile = String(process.env.NAVER_INVENTORY_FIXTURE_AUDIT_FILE || "").trim();
const fixtureRoot = path.resolve(String(process.env.NAVER_INVENTORY_FIXTURE_ROOT || ""));
const mode = String(process.env.NAVER_INVENTORY_FIXTURE_MODE || "success").trim();
const calls = [];

function assertFixturePath(filePath, label) {
  const resolved = path.resolve(String(filePath || ""));
  const relative = path.relative(fixtureRoot, resolved);
  if (
    !fixtureRoot
    || !relative
    || relative === ".."
    || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative)
  ) {
    throw new Error(`${label} must stay inside the fixture root`);
  }
  return resolved;
}

if (!String(process.env.NAVER_INVENTORY_FIXTURE_ROOT || "").trim()) {
  throw new Error("fixture root is required");
}
assertFixturePath(auditFile, "fixture audit file");

const originalModuleLoad = Module._load;
Module._load = function inventoryFixtureModuleLoad(request, parent, isMain) {
  if (request === "./workbook_export.cjs" && String(parent?.filename || "").endsWith("gyeongnam_glamping_crawl.cjs")) {
    return {
      buildWorkbook: async (filePath) => {
        await fs.promises.writeFile(
          assertFixturePath(filePath, "fixture workbook"),
          "synthetic inventory fixture workbook",
          "utf8"
        );
      }
    };
  }
  return originalModuleLoad.call(this, request, parent, isMain);
};

function record(operation, method) {
  calls.push({ ordinal: calls.length + 1, operation, method });
  if (!auditFile) throw new Error("fixture audit file is required");
  fs.writeFileSync(assertFixturePath(auditFile, "fixture audit file"), JSON.stringify({
    callCount: calls.length,
    calls,
    operationCounts: calls.reduce((result, call) => {
      result[call.operation] = (result[call.operation] || 0) + 1;
      return result;
    }, {})
  }), "utf8");
}

function jsonResponse(value, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...extraHeaders }
  });
}

function mainFixture(query) {
  const items = Array.from({ length: 50 }, (_, index) => {
    const item = {
      id: String(1001 + index),
      name: `Synthetic Inventory Lodge ${index + 1}`,
      category: "Synthetic lodging",
      roadAddress: `Synthetic road ${index + 1}`,
      placeReviewCount: index + 1,
      placeReviewScore: 4.5,
      hasBooking: mode === "zero_two" ? index === 2 : index < 3
    };
    if (mode === "has_booking_omitted" && index === 0) delete item.hasBooking;
    return item;
  });
  return apolloHtml(createApolloFixture({ query, display: 50, items, total: 50 }).state);
}

function parsedBody(init) {
  try {
    return JSON.parse(String(init.body || "{}"));
  } catch {
    throw new Error("fixture request body is not JSON");
  }
}

function fixtureBlock(operation) {
  if (mode === `http_403_${operation}`) return new Response("", { status: 403, headers: { "content-type": "text/html" } });
  if (mode === `http_429_${operation}`) return new Response("", { status: 429, headers: { "retry-after": "900" } });
  if (mode === `challenge_${operation}`) {
    return new Response("<html><h1>보안 확인</h1><p>자동입력 방지</p></html>", {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" }
    });
  }
  return null;
}

globalThis.fetch = async (input, init = {}) => {
  const url = input instanceof URL ? input : new URL(String(input));
  const method = String(init.method || "GET").toUpperCase();
  if (url.hostname === "pcmap.place.naver.com" && url.pathname === "/accommodation/list") {
    record("main_place", method);
    if (method !== "GET" || init.redirect !== "manual") throw new Error("unexpected main fixture request");
    return new Response(mainFixture(url.searchParams.get("query") || ""), {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" }
    });
  }

  const body = parsedBody(init);
  const operationName = String(body.operationName || "");
  const operation = operationName === "naverBookingBusiness"
    ? "booking_business"
    : operationName === "searchBizItem"
      ? "booking_items"
      : operationName === "dailySchedule"
        ? "daily_schedule"
        : "unknown";
  record(operation, method);
  if (method !== "POST" || init.redirect !== "manual") throw new Error("unexpected inventory fixture request method");
  const blocked = fixtureBlock(operation);
  if (blocked) return blocked;
  if (mode === `malformed_${operation}`) {
    return new Response("{broken", { status: 200, headers: { "content-type": "application/json" } });
  }
  if (mode === `graphql_error_${operation}`) {
    return jsonResponse({ errors: [{ message: "synthetic" }], data: null });
  }

  if (operation === "booking_business") {
    if (url.hostname !== "pcmap-api.place.naver.com" || url.pathname !== "/graphql") throw new Error("unexpected business endpoint");
    const placeId = String(body.variables?.id || "");
    if (mode === "business_booking_omitted") {
      return jsonResponse({ data: { business: { base: { id: placeId, name: "Synthetic" } } } });
    }
    return jsonResponse({
      data: {
        business: {
          naverBooking: {
            bookingBusinessId: String(2000 + Number(placeId) - 1000),
            naverBookingUrl: ""
          }
        }
      }
    });
  }
  if (operation === "booking_items") {
    if (url.hostname !== "m.booking.naver.com" || url.pathname !== "/graphql") throw new Error("unexpected items endpoint");
    const businessId = String(body.variables?.bizItemSearchParams?.businessId || "2001");
    const fixtureItems = mode === "nine_items"
      ? Array.from({ length: 9 }, (_, index) => ({
          id: `item-${businessId}-${index + 1}`,
          businessId,
          bizItemId: String(Number(businessId) * 100 + index + 1),
          bizItemSubType: "ACCOMMODATION_NIGHT",
          name: `Synthetic night ${index + 1}`,
          isClosedBooking: false,
          isClosedBookingUser: false,
          isImp: true,
          price: 100000,
          minMaxPrice: { minPrice: 100000, maxPrice: 100000, isSinglePrice: true },
          typeValues: []
        }))
      : [
          {
            id: `item-${businessId}-night`,
            businessId,
            bizItemId: String(Number(businessId) * 10 + 1),
            bizItemSubType: "ACCOMMODATION_NIGHT",
            name: "Synthetic night",
            isClosedBooking: false,
            isClosedBookingUser: false,
            isImp: true,
            price: 100000,
            minMaxPrice: { minPrice: 100000, maxPrice: 100000, isSinglePrice: true },
            typeValues: []
          },
          {
            id: `item-${businessId}-day`,
            businessId,
            bizItemId: String(Number(businessId) * 10 + 2),
            bizItemSubType: "ACCOMMODATION_DAY_USE",
            name: "Synthetic day use",
            isClosedBooking: false,
            isClosedBookingUser: false,
            isImp: true,
            price: 50000,
            minMaxPrice: { minPrice: 50000, maxPrice: 50000, isSinglePrice: true },
            typeValues: []
          }
        ];
    return jsonResponse({
      data: {
        searchBizItem: {
          bizItems: fixtureItems
        }
      }
    });
  }
  if (operation === "daily_schedule") {
    if (url.hostname !== "m.booking.naver.com" || url.pathname !== "/graphql") throw new Error("unexpected schedule endpoint");
    const params = body.variables?.scheduleParams || {};
    const date = String(params.startDateTime || "").slice(0, 10);
    if (mode === "schedule_empty_object") {
      return jsonResponse({ data: { schedule: { bizItemSchedule: { daily: { date: { [date]: {} } } } } } });
    }
    const price = String(params.bizItemId || "").endsWith("2") ? 50000 : 100000;
    return jsonResponse({
      data: {
        schedule: {
          bizItemSchedule: {
            daily: {
              date: {
                [date]: {
                  stock: 2,
                  bookingCount: 1,
                  occupiedBookingCount: 0,
                  isBusinessDay: true,
                  isSaleDay: true,
                  prices: [{ price }]
                }
              }
            }
          }
        }
      }
    });
  }
  throw new Error("unexpected fixture provider operation");
};
