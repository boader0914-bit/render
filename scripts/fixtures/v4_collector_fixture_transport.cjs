const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { NETWORK_ERROR_CODE } = require("./v4_network_blocker.cjs");

const TRACE_SCHEMA = "datalab-v4-parity-network-trace.v1";
const SCENARIOS = new Set([
  "success",
  "empty",
  "duplicate",
  "missing-field",
  "booking",
  "provider-error",
  "timeout"
]);
const scenario = String(process.env.V4_PARITY_FIXTURE_SCENARIO || "").trim();
const configRoot = path.resolve(String(process.env.CONFIG_DIR || ""));
const traceFile = path.resolve(String(process.env.V4_PARITY_TRACE_FILE || ""));

function isContained(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

if (!SCENARIOS.has(scenario)) {
  throw Object.assign(new Error("Offline collector parity scenario is invalid."), { code: "V4_PARITY_FIXTURE_INVALID" });
}
if (!process.env.CONFIG_DIR || !process.env.V4_PARITY_TRACE_FILE || !isContained(configRoot, traceFile)) {
  throw Object.assign(new Error("Parity trace path must stay inside CONFIG_DIR."), { code: "V4_PARITY_TRACE_PATH_INVALID" });
}
if (globalThis.__DATALAB_V4_NETWORK_BLOCKED__ !== true) {
  throw Object.assign(new Error("The lower-level network blocker was not loaded."), { code: "V4_PARITY_NETWORK_BLOCKER_REQUIRED" });
}

const trace = {
  schemaVersion: TRACE_SCHEMA,
  scenario,
  networkBlockerLoaded: true,
  lowerNetworkErrorCode: NETWORK_ERROR_CODE,
  fixtureRequestCount: 0,
  actualExternalRequests: 0,
  routes: []
};
let naverListCalls = 0;

function writeTrace() {
  fs.mkdirSync(path.dirname(traceFile), { recursive: true });
  fs.writeFileSync(traceFile, `${JSON.stringify(trace, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

process.once("exit", writeTrace);

function digest(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

function routeLabel(target) {
  return `${target.hostname}${target.pathname}`;
}

function record(target, options, outcome) {
  trace.fixtureRequestCount += 1;
  trace.routes.push({
    method: String(options?.method || "GET").toUpperCase(),
    route: routeLabel(target),
    queryHash: digest(target.search).slice(0, 16),
    outcome
  });
  writeTrace();
}

function fixtureResponse(target, status, value, raw = false) {
  const body = raw ? String(value) : JSON.stringify(value);
  return {
    status,
    ok: status >= 200 && status < 300,
    url: target.href,
    headers: { get: () => null },
    async text() {
      return body;
    },
    async json() {
      return JSON.parse(body);
    }
  };
}

function naverItem(id, options = {}) {
  if (scenario === "missing-field") {
    return { id, roomImages: [], hasBooking: false };
  }
  return {
    id,
    name: options.ad ? `Fixture Ad Glamping ${id}` : `Fixture Glamping ${id}`,
    category: "글램핑,캠핑장",
    commonAddress: "경상남도 Fixture시 Fixture로 1",
    roomImages: [{ __ref: `Room:${id}:1` }],
    microReview: "Synthetic offline fixture",
    totalReviewCount: 12,
    placeReviewCount: 7,
    placeReviewScore: 4.7,
    hasBooking: options.hasBooking === true,
    adId: options.ad ? `ad-${id}` : undefined,
    adDescription: options.ad ? "Synthetic advertisement" : undefined
  };
}

function naverApolloState(query) {
  naverListCalls += 1;
  const suffix = digest(query).slice(0, 10);
  const itemRef = `Accommodation:${suffix}:main`;
  const adRef = `Accommodation:${suffix}:ad`;
  const empty = scenario === "empty";
  const duplicate = scenario === "duplicate";
  const hasBooking = scenario === "booking" && naverListCalls === 1;
  const overallRefs = empty ? [] : duplicate
    ? [{ __ref: itemRef }, { __ref: itemRef }]
    : [{ __ref: itemRef }];
  const adRefs = empty ? [] : [{ __ref: adRef }];
  const searchKey = `accommodationSearch(${JSON.stringify({ input: { query, display: 50 } })})`;
  const adKey = `adBusinesses(${JSON.stringify({ input: { query, businessType: "accommodation" } })})`;
  const state = {
    ROOT_QUERY: {
      [searchKey]: { business: { total: overallRefs.length, items: overallRefs } },
      [adKey]: { total: adRefs.length, items: adRefs }
    }
  };
  if (!empty) {
    state[itemRef] = naverItem(`${suffix}-main`, { hasBooking });
    state[adRef] = naverItem(`${suffix}-ad`, { ad: true });
    state[`Room:${suffix}-main:1`] = { name: "Fixture Room", minPrice: 120000, maxPrice: 150000 };
    state[`Room:${suffix}-ad:1`] = { name: "Fixture Ad Room", minPrice: 130000, maxPrice: 130000 };
  }
  return state;
}

function naverHtml(target) {
  const query = target.searchParams.get("query") || "fixture";
  return `<!doctype html><script>window.__APOLLO_STATE__ = ${JSON.stringify(naverApolloState(query))};</script>`;
}

function nolList() {
  if (scenario === "empty") return { items: [] };
  const entry = {
    type: "PRODUCT_ITEM",
    data: {
      title: scenario === "missing-field" ? "" : "Fixture NOL Glamping",
      category: "글램핑",
      locationDetails: ["경상남도", "Fixture시"],
      review: { score: 4.6, count: 9 },
      prices: [{ discountPrice: 110000, discountPriceUnit: "원" }],
      action: { web: "https://fixture.invalid/nol" }
    },
    serverLogMeta: {}
  };
  return { items: scenario === "duplicate" ? [entry, entry] : [entry] };
}

function ddnayoResult() {
  if (scenario === "empty") return { data: { totalSize: 0, contents: [] } };
  const entry = {
    accommodationName: scenario === "missing-field" ? "" : "Fixture DDNayo Glamping",
    address: "경상남도 Fixture시",
    price: 99000,
    productUrl: "https://fixture.invalid/ddnayo"
  };
  const contents = scenario === "duplicate" ? [entry, entry] : [entry];
  return { data: { totalSize: contents.length, contents } };
}

function parseBody(options) {
  try {
    return JSON.parse(String(options?.body || "{}"));
  } catch {
    return {};
  }
}

async function fixtureFetch(input, options = {}) {
  const target = new URL(typeof input === "string" || input instanceof URL ? input : input?.url);
  if (scenario === "timeout") {
    record(target, options, "fixture-timeout");
    return new Promise(() => {
      setInterval(() => {}, 1000);
    });
  }
  if (scenario === "provider-error") {
    record(target, options, "fixture-error");
    throw Object.assign(new Error("Synthetic provider failure."), { code: "V4_PARITY_PROVIDER_ERROR" });
  }

  if (target.hostname === "pcmap.place.naver.com" && target.pathname === "/accommodation/list") {
    record(target, options, "naver-apollo-html");
    return fixtureResponse(target, 200, naverHtml(target), true);
  }
  if (target.hostname === "pcmap-api.place.naver.com" && target.pathname === "/graphql") {
    record(target, options, "naver-booking-business");
    const body = parseBody(options);
    const naverBooking = scenario === "booking"
      ? {
          bookingBusinessId: "9001001",
          naverBookingUrl: "https://m.booking.naver.com/booking/3/bizes/9001001/search",
          naverBookingHubUrl: ""
        }
      : {};
    return fixtureResponse(target, 200, { data: { business: { base: { id: body.variables?.id || "" }, naverBooking } } });
  }
  if (target.hostname === "m.booking.naver.com" && target.pathname === "/graphql") {
    const body = parseBody(options);
    record(target, options, `naver-booking-${body.operationName || "graphql"}`);
    if (body.operationName === "searchBizItem") {
      return fixtureResponse(target, 200, { data: { searchBizItem: { id: "fixture", bizItems: [] } } });
    }
    return fixtureResponse(target, 200, { data: { schedule: { bizItemSchedule: { daily: { date: {} } } } } });
  }
  if (target.hostname === "m.booking.naver.com" && target.pathname.startsWith("/booking/3/bizes/")) {
    record(target, options, "naver-booking-page");
    return fixtureResponse(target, 200, "<html><body>Offline booking fixture</body></html>", true);
  }
  if (target.hostname === "nol.yanolja.com" && target.pathname.endsWith("/count")) {
    const count = scenario === "empty" ? 0 : scenario === "duplicate" ? 2 : 1;
    record(target, options, "nol-count");
    return fixtureResponse(target, 200, { count });
  }
  if (target.hostname === "nol.yanolja.com" && target.pathname.endsWith("/list")) {
    record(target, options, "nol-list");
    return fixtureResponse(target, 200, nolList());
  }
  if (target.hostname === "www.goodchoice.kr" && target.pathname === "/product/result") {
    record(target, options, "yeogi-blocked-fixture");
    return fixtureResponse(target, 403, "Sorry, you have been blocked", true);
  }
  if (target.hostname === "trip.ddnayo.com" && target.pathname === "/web-api/total-search") {
    record(target, options, "ddnayo-search");
    return fixtureResponse(target, 200, ddnayoResult());
  }

  record(target, options, "blocked-unhandled-route");
  throw Object.assign(new Error("Fixture transport blocked an unhandled URL."), {
    code: "V4_PARITY_FIXTURE_UNHANDLED_URL"
  });
}

globalThis.fetch = fixtureFetch;
Object.defineProperty(globalThis, "__DATALAB_V4_PARITY_FIXTURE__", {
  value: true,
  configurable: false,
  enumerable: false,
  writable: false
});

module.exports = { SCENARIOS, TRACE_SCHEMA };
