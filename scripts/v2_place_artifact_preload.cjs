"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const Module = require("node:module");
const path = require("node:path");

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const allowedRootText = String(process.env.V2_PLACE_ARTIFACT_ALLOWED_ROOT || "").trim();
const allowedRoot = path.resolve(allowedRootText || ".");
const providerAuditFileText = String(process.env.V2_PLACE_ARTIFACT_PROVIDER_AUDIT_FILE || "").trim();
const workbookAuditFileText = String(process.env.V2_PLACE_ARTIFACT_WORKBOOK_AUDIT_FILE || "").trim();
const captureFileText = String(process.env.V2_PLACE_ARTIFACT_CAPTURE_FILE || "").trim();
const providerAuditFile = path.resolve(providerAuditFileText || ".");
const workbookAuditFile = path.resolve(workbookAuditFileText || ".");
const captureFile = path.resolve(captureFileText || ".");
const replayFile = String(process.env.V2_PLACE_ARTIFACT_REPLAY_FILE || "").trim();
const transportMode = String(process.env.V2_PLACE_ARTIFACT_TRANSPORT_MODE || "offline").trim();
const scenario = String(process.env.V2_PLACE_ARTIFACT_FIXTURE_SCENARIO || "success").trim();
const workbookMode = String(process.env.V2_PLACE_ARTIFACT_WORKBOOK_MODE || "projection").trim();
const workbookFailAt = Number(process.env.V2_PLACE_ARTIFACT_WORKBOOK_FAIL_AT || 0);

const original = Object.freeze({
  fetch: globalThis.fetch,
  writeFile: fsp.writeFile.bind(fsp),
  mkdir: fsp.mkdir.bind(fsp),
  rename: fsp.rename.bind(fsp),
  rm: fsp.rm.bind(fsp),
  writeFileSync: fs.writeFileSync.bind(fs),
  mkdirSync: fs.mkdirSync.bind(fs),
  renameSync: fs.renameSync.bind(fs),
  rmSync: fs.rmSync.bind(fs)
});

let providerCalls = 0;
const workbookCalls = [];

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function sha256(value) {
  return crypto.createHash("sha256").update(Buffer.isBuffer(value) ? value : Buffer.from(String(value))).digest("hex");
}

function relativeInside(filePath, label) {
  const resolved = path.resolve(String(filePath || ""));
  const relative = path.relative(allowedRoot, resolved);
  if (
    !allowedRootText
    || relative === ".."
    || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative)
  ) fail("V2_PLACE_ARTIFACT_OUTPUT_ESCAPE", `${label} escaped the isolated root`);
  return resolved;
}

if (!allowedRootText || !providerAuditFileText || !workbookAuditFileText || !captureFileText) {
  fail("V2_PLACE_ARTIFACT_PATH_REQUIRED", "Isolated root and audit output paths are required");
}

for (const [filePath, label] of [
  [providerAuditFile, "provider audit"],
  [workbookAuditFile, "workbook audit"],
  [captureFile, "sanitized capture"]
]) relativeInside(filePath, label);
if (replayFile) relativeInside(replayFile, "sanitized replay");

const expectedEnvironment = Object.freeze({
  NAVER_LEGACY_LIMITED_ACTIVATION: "1",
  NAVER_LEGACY_INVENTORY_ACTIVATION: "0",
  V2_COLLECTOR_COMPATIBILITY_ACTIVATION: "0",
  V2_TOP20_WORKER_ACTIVATION: "0",
  NAVER_MAIN_PLACE_RECOVERY_PROBE: "0",
  NAVER_BOOKING_DETAIL_RECOVERY_PROBE: "0",
  NAVER_COLLECTOR_STRATEGY: "legacy_candidate",
  NAVER_COLLECTOR_SCOPE: "main_place_only",
  NAVER_LIMITED_ACTIVATION_PROFILE: "preview-admin-keyword-fast-main-place.v1",
  NAVER_PROVIDER_CALL_BUDGET: "1",
  NAVER_INVENTORY_CALL_BUDGET: "0",
  NAVER_TOTAL_CALL_BUDGET: "1",
  NAVER_INVENTORY_PLACE_LIMIT: "0",
  NAVER_INVENTORY_ITEM_LIMIT: "0",
  NAVER_BOOKING_STOCK_LIMIT: "0",
  NAVER_BOOKING_ID_FALLBACK: "0",
  NAVER_COUPON_PAGE_FALLBACK: "0",
  NAVER_DETAIL_LIVE_CALLS_ALLOWED: "0",
  NAVER_AUTOMATIC_RETRY: "0",
  NAVER_AUTOMATIC_FALLBACK: "0",
  SEARCH_MODE: "keyword",
  COLLECTION_MODE: "fast",
  COLLECTION_PURPOSE: "basic_db",
  SOURCE_ROLE: "admin",
  COLLECTION_SOURCE: "admin_search"
});
for (const [name, value] of Object.entries(expectedEnvironment)) {
  if (process.env[name] !== value) {
    fail("V2_PLACE_ARTIFACT_ENVIRONMENT_INVALID", "Place artifact environment is not fail-closed");
  }
}
if (!new Set(["offline", "live", "replay"]).has(transportMode)) {
  fail("V2_PLACE_ARTIFACT_TRANSPORT_INVALID", "Place artifact transport mode is invalid");
}
if (transportMode === "replay" && !replayFile) {
  fail("V2_PLACE_ARTIFACT_REPLAY_INVALID", "Sanitized replay file is required");
}
if (transportMode !== "replay" && replayFile) {
  fail("V2_PLACE_ARTIFACT_REPLAY_INVALID", "Sanitized replay is only allowed in replay mode");
}
if (!Number.isInteger(workbookFailAt) || workbookFailAt < 0 || workbookFailAt > 2) {
  fail("V2_PLACE_ARTIFACT_WORKBOOK_FAILURE_INVALID", "Workbook failure injection is invalid");
}
if (!new Set(["native", "projection"]).has(workbookMode)) {
  fail("V2_PLACE_ARTIFACT_WORKBOOK_MODE_INVALID", "Workbook mode is invalid");
}

function atomicJsonSync(filePath, value) {
  const target = relativeInside(filePath, "audit output");
  original.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = relativeInside(`${target}.${process.pid}.tmp`, "audit temporary output");
  original.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "w" });
  original.renameSync(temporary, target);
}

function assertWritePath(filePath, label) {
  return relativeInside(filePath, label);
}

fsp.writeFile = async function isolatedWriteFile(filePath, ...args) {
  return original.writeFile(assertWritePath(filePath, "writeFile"), ...args);
};
fsp.mkdir = async function isolatedMkdir(filePath, ...args) {
  return original.mkdir(assertWritePath(filePath, "mkdir"), ...args);
};
fsp.rename = async function isolatedRename(source, target, ...args) {
  return original.rename(assertWritePath(source, "rename source"), assertWritePath(target, "rename target"), ...args);
};
fsp.rm = async function isolatedRm(filePath, ...args) {
  return original.rm(assertWritePath(filePath, "rm"), ...args);
};
fs.writeFileSync = function isolatedWriteFileSync(filePath, ...args) {
  return original.writeFileSync(assertWritePath(filePath, "writeFileSync"), ...args);
};
fs.mkdirSync = function isolatedMkdirSync(filePath, ...args) {
  return original.mkdirSync(assertWritePath(filePath, "mkdirSync"), ...args);
};
fs.renameSync = function isolatedRenameSync(source, target, ...args) {
  return original.renameSync(assertWritePath(source, "renameSync source"), assertWritePath(target, "renameSync target"), ...args);
};
fs.rmSync = function isolatedRmSync(filePath, ...args) {
  return original.rmSync(assertWritePath(filePath, "rmSync"), ...args);
};

function cellKind(value) {
  if (value === null || value === undefined) return "empty";
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? "empty" : "date-as-iso-string";
  if (typeof value === "number") return Number.isFinite(value) ? "number" : "nonfinite-as-string";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "string") return "string";
  if (typeof value === "bigint") return "bigint-as-string";
  if (typeof value === "object") return "object-as-json-string";
  return "string";
}

function workbookProjection(filePath, sheets) {
  return {
    fileName: path.basename(relativeInside(filePath, "workbook path")),
    binaryGenerated: workbookMode === "native",
    classification: workbookMode === "native" ? "native-v2-workbook" : "comparison-only-workbook-invocation-contract",
    sheets: (Array.isArray(sheets) ? sheets : []).map((sheet) => {
      const rows = Array.isArray(sheet?.rows) ? sheet.rows : [];
      const columns = Array.isArray(sheet?.columns) ? sheet.columns.map(String) : [];
      return {
        name: String(sheet?.name || ""),
        columns,
        rowCount: rows.length,
        columnCellKinds: Object.fromEntries(columns.map((column) => [
          column,
          [...new Set(rows.map((row) => cellKind(row?.[column])))].sort()
        ]))
      };
    })
  };
}

function writeWorkbookAudit() {
  atomicJsonSync(workbookAuditFile, {
    schemaVersion: "v2-place-artifact-workbook-invocations.v1",
    dependency: {
      name: "write-excel-file",
      version: "4.1.1",
      installed: workbookMode === "native",
      binaryGenerated: workbookMode === "native"
    },
    callCount: workbookCalls.length,
    calls: workbookCalls
  });
}

const originalModuleLoad = Module._load;
Module._load = function placeArtifactModuleLoad(request, parent, isMain) {
  if (request === "./workbook_export.cjs" && String(parent?.filename || "").endsWith("gyeongnam_glamping_crawl.cjs")) {
    const nativeWorkbook = workbookMode === "native"
      ? originalModuleLoad.call(this, request, parent, isMain)
      : null;
    return {
      buildWorkbook: async (filePath, sheets) => {
        workbookCalls.push(workbookProjection(filePath, sheets));
        writeWorkbookAudit();
        if (workbookFailAt > 0 && workbookCalls.length === workbookFailAt) {
          fail("V2_PLACE_ARTIFACT_WORKBOOK_INJECTED_FAILURE", "Injected workbook failure after native partial files");
        }
        if (nativeWorkbook) return nativeWorkbook.buildWorkbook(filePath, sheets);
        return {
          filePath,
          sheetNames: workbookCalls.at(-1).sheets.map((sheet) => sheet.name),
          binaryGenerated: false
        };
      }
    };
  }
  return originalModuleLoad.call(this, request, parent, isMain);
};

function scalar(value, maximum = 2000) {
  if (value === null) return null;
  if (["number", "boolean"].includes(typeof value)) return value;
  if (typeof value === "string") return value.slice(0, maximum);
  return undefined;
}

function setOwn(target, source, field, maximum) {
  if (!Object.prototype.hasOwnProperty.call(source || {}, field)) return;
  const value = scalar(source[field], maximum);
  if (value !== undefined) target[field] = value;
}

function dereference(state, value) {
  if (value && typeof value === "object" && typeof value.__ref === "string") return state[value.__ref] || null;
  return value && typeof value === "object" ? value : null;
}

function sanitizedProviderItem(state, item) {
  const result = {};
  for (const field of [
    "id", "placeId", "name", "category", "roadAddress", "jibunAddress", "address", "commonAddress",
    "matchRoomMinPrice", "microReview", "promotionTitle", "adDescription", "adId", "totalReviewCount",
    "blogCafeReviewCount", "placeReviewCount", "placeReviewScore", "hasBooking"
  ]) setOwn(result, item, field, field === "microReview" || field === "adDescription" ? 2000 : 1000);
  result.rooms = (Array.isArray(item?.roomImages) ? item.roomImages : [])
    .map((entry) => dereference(state, entry))
    .filter(Boolean)
    .slice(0, 100)
    .map((room) => {
      const projected = {};
      for (const field of ["name", "minPrice", "maxPrice"]) setOwn(projected, room, field, 1000);
      return projected;
    });
  return result;
}

function parseAdItems(state, query) {
  const { parseRootKey } = require(path.join(process.cwd(), "scripts", "naver_place_apollo_parser.cjs"));
  const keys = Object.keys(state?.ROOT_QUERY || {});
  const key = keys.find((candidate) => {
    if (!candidate.startsWith("adBusinesses(") || candidate.includes('"channel":"openingPlace"')) return false;
    const args = parseRootKey(candidate)?.args;
    return args?.input?.query === query && args?.input?.businessType === "accommodation";
  });
  if (!key) return { contractPresent: false, total: 0, items: [] };
  const root = state.ROOT_QUERY[key] || {};
  return {
    contractPresent: true,
    total: Number.isFinite(Number(root.total)) ? Number(root.total) : 0,
    items: (Array.isArray(root.items) ? root.items : []).map((entry) => dereference(state, entry)).filter(Boolean)
  };
}

async function readResponseClone(response) {
  const clone = response?.clone?.();
  if (!clone) fail("V2_PLACE_ARTIFACT_RESPONSE_INVALID", "Response clone is unavailable");
  const contentLength = Number(clone.headers?.get?.("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
    fail("V2_PLACE_ARTIFACT_RESPONSE_TOO_LARGE", "Response exceeded the approved size");
  }
  const buffer = Buffer.from(await clone.arrayBuffer());
  if (buffer.length > MAX_RESPONSE_BYTES) fail("V2_PLACE_ARTIFACT_RESPONSE_TOO_LARGE", "Response exceeded the approved size");
  return buffer.toString("utf8");
}

async function captureSanitized(url, init, response) {
  const query = String(url.searchParams.get("query") || "").normalize("NFC").trim().replace(/\s+/gu, " ");
  const capture = {
    schemaVersion: "v2-place-artifact-sanitized-capture.v1",
    request: {
      method: String(init?.method || "GET").toUpperCase(),
      origin: url.origin,
      path: url.pathname,
      queryParameterNames: ["query"],
      queryHash: sha256(query)
    },
    response: {
      status: Number(response.status),
      contentType: String(response.headers?.get?.("content-type") || "").slice(0, 160)
    },
    parseStatus: "not_attempted",
    organic: null,
    ads: null,
    rawProviderResponseStored: false,
    requestHeadersStored: false,
    responseHeadersStored: false
  };
  if (response.status >= 200 && response.status < 300) {
    try {
      const body = await readResponseClone(response);
      const { extractApolloState, selectNaverOrganicResult } = require(path.join(process.cwd(), "scripts", "naver_place_apollo_parser.cjs"));
      const state = extractApolloState(body);
      const organic = selectNaverOrganicResult(state, query, { allowPlaceList: true, required: false });
      const ads = parseAdItems(state, query);
      capture.parseStatus = "parsed";
      capture.organic = {
        operation: String(organic?.operation || organic?.type || ""),
        total: Number(organic?.total || 0),
        items: (organic?.items || []).slice(0, 50).map((item, index) => ({
          rank: index + 1,
          source: sanitizedProviderItem(state, item)
        }))
      };
      capture.ads = {
        contractPresent: ads.contractPresent,
        total: ads.total,
        items: ads.items.map((item, index) => ({
          order: index + 1,
          source: sanitizedProviderItem(state, item)
        }))
      };
    } catch (error) {
      capture.parseStatus = "unavailable";
      capture.parseCode = String(error?.code || "V2_PLACE_ARTIFACT_CAPTURE_UNAVAILABLE").slice(0, 100);
    }
  }
  atomicJsonSync(captureFile, capture);
  return capture;
}

function entity(state, item, prefix, index) {
  const projected = { ...item };
  const rooms = Array.isArray(projected.rooms) ? projected.rooms : [];
  delete projected.rooms;
  projected.roomImages = rooms.map((room, roomIndex) => {
    const roomRef = `${prefix}:Room:${index}:${roomIndex}`;
    state[roomRef] = { ...room };
    return { __ref: roomRef };
  });
  const reference = `${prefix}:Place:${index}`;
  state[reference] = projected;
  return { __ref: reference };
}

function fixtureState(query, value) {
  const state = { ROOT_QUERY: {} };
  const organic = Array.isArray(value.organic) ? value.organic : [];
  const ads = Array.isArray(value.ads) ? value.ads : [];
  const organicRefs = organic.map((item, index) => entity(state, item, "Organic", index));
  const organicKey = `accommodationSearch(${JSON.stringify({ input: { query, display: 50 } })})`;
  state.ROOT_QUERY[organicKey] = {
    business: {
      items: organicRefs,
      total: Number.isFinite(Number(value.organicTotal)) ? Number(value.organicTotal) : organic.length
    }
  };
  if (value.includeAds !== false) {
    const adRefs = ads.map((item, index) => entity(state, item, "Ad", index));
    const adKey = `adBusinesses(${JSON.stringify({ input: { query, businessType: "accommodation" } })})`;
    state.ROOT_QUERY[adKey] = {
      items: adRefs,
      total: Number.isFinite(Number(value.adTotal)) ? Number(value.adTotal) : ads.length
    };
  }
  return state;
}

function baseItem(id, index, extras = {}) {
  return {
    id: String(id),
    name: `Synthetic Place ${index}`,
    category: "글램핑",
    roadAddress: `경남 합천군 Synthetic road ${index}`,
    placeReviewCount: index,
    placeReviewScore: 4.5,
    hasBooking: false,
    rooms: [],
    ...extras
  };
}

function generatedScenario(name) {
  if (name === "empty") return { organic: [], ads: [], organicTotal: 0, adTotal: 0 };
  if (name === "no_ads") {
    return {
      organic: [baseItem(2101, 1), baseItem(2102, 2)],
      ads: [],
      organicTotal: 2,
      includeAds: false
    };
  }
  if (name === "duplicates") {
    return {
      organic: [baseItem(3101, 1), baseItem(3101, 2, { name: "Duplicate natural" }), baseItem(3102, 3)],
      ads: [baseItem(3101, 1, { adId: "ad-overlap" }), baseItem(4101, 2, { adId: "ad-repeat-a" }), baseItem(4101, 3, { adId: "ad-repeat-b" })],
      organicTotal: 3,
      adTotal: 3
    };
  }
  if (name === "missing_fields") {
    return {
      organic: [{ id: "5101", rooms: [] }, baseItem(5102, 2, { category: null, roadAddress: "", hasBooking: undefined })],
      ads: [{ id: "6101", adId: "", rooms: [] }],
      organicTotal: 2,
      adTotal: 1
    };
  }
  if (name === "limit") {
    return {
      organic: Array.from({ length: 55 }, (_, index) => baseItem(7001 + index, index + 1)),
      ads: Array.from({ length: 55 }, (_, index) => baseItem(8001 + index, index + 1, { adId: `ad-${index + 1}` })),
      organicTotal: 999,
      adTotal: 777
    };
  }
  if (!["success", "partial_artifact_failure"].includes(name)) {
    fail("V2_PLACE_ARTIFACT_SCENARIO_INVALID", "Fixture scenario is invalid");
  }
  return {
    organic: [
      baseItem(1001, 1, {
        name: '=HYPERLINK("https://fixture.invalid","Synthetic")',
        roadAddress: "경남 합천군 Synthetic road, 1",
        microReview: "Line one\nLine two",
        hasBooking: true,
        rooms: [{ name: "Room A", minPrice: 100000, maxPrice: 120000 }]
      }),
      baseItem(1002, 2, { name: "Shared Place", hasBooking: false }),
      baseItem(1003, 3, { placeReviewCount: 0, placeReviewScore: 0 }),
      baseItem(1004, 4, { jibunAddress: "경남 산청군 Synthetic 4", roadAddress: "" })
    ],
    ads: [
      baseItem(1002, 1, { name: "Shared Place", adId: "ad-shared", adDescription: "Shared advertisement" }),
      baseItem(2001, 2, { name: "Ad Only One", adId: "ad-only-1", adDescription: "Ad, quoted" }),
      baseItem(2002, 3, { name: "Ad Only Two", adId: "ad-only-2" })
    ],
    organicTotal: 401,
    adTotal: 18
  };
}

function replayScenario() {
  let value;
  try {
    value = JSON.parse(fs.readFileSync(relativeInside(replayFile, "sanitized replay"), "utf8"));
  } catch {
    fail("V2_PLACE_ARTIFACT_REPLAY_INVALID", "Sanitized replay could not be read");
  }
  if (value?.schemaVersion !== "v2-place-artifact-sanitized-replay.v1") {
    fail("V2_PLACE_ARTIFACT_REPLAY_INVALID", "Sanitized replay schema is invalid");
  }
  return {
    organic: (value.organic?.items || []).map((entry) => entry.source),
    ads: (value.ads?.items || []).map((entry) => entry.source),
    organicTotal: Number(value.organic?.total || 0),
    adTotal: Number(value.ads?.total || 0),
    includeAds: value.ads?.contractPresent !== false
  };
}

function htmlForFixture(query) {
  const value = transportMode === "replay" ? replayScenario() : generatedScenario(scenario);
  return `<!doctype html><html><body><script>window.__APOLLO_STATE__ = ${JSON.stringify(fixtureState(query, value))};</script></body></html>`;
}

function providerAudit(url, init, response, capture) {
  atomicJsonSync(providerAuditFile, {
    schemaVersion: "v2-place-artifact-provider-audit.v1",
    callCount: providerCalls,
    actualExternalRequestCount: transportMode === "live" ? providerCalls : 0,
    fixtureTransportCallCount: transportMode === "live" ? 0 : providerCalls,
    operationCounts: { main_place: providerCalls },
    forbiddenOperationCounts: {
      booking: 0,
      priceInventory: 0,
      regional: 0,
      ota: 0
    },
    request: {
      method: String(init?.method || "GET").toUpperCase(),
      origin: url.origin,
      path: url.pathname,
      queryParameterNames: [...url.searchParams.keys()].sort(),
      queryHash: sha256(String(url.searchParams.get("query") || "").normalize("NFC").trim().replace(/\s+/gu, " "))
    },
    response: {
      status: Number(response.status),
      contentType: String(response.headers?.get?.("content-type") || "").slice(0, 160),
      parseStatus: capture.parseStatus
    },
    retries: 0,
    fallbacks: 0,
    rawProviderResponseStored: false,
    headersStored: false,
    fullRequestUrlStored: false
  });
}

if (typeof original.fetch !== "function") fail("V2_PLACE_ARTIFACT_FETCH_UNAVAILABLE", "fetch is unavailable");
globalThis.fetch = async function boundedPlaceArtifactFetch(input, init = {}) {
  const url = input instanceof URL ? input : new URL(String(input));
  const method = String(init.method || "GET").toUpperCase();
  if (
    url.origin !== "https://pcmap.place.naver.com"
    || url.pathname !== "/accommodation/list"
    || method !== "GET"
    || init.redirect !== "manual"
    || [...url.searchParams.keys()].some((key) => key !== "query")
    || !String(url.searchParams.get("query") || "").trim()
  ) fail("V2_PLACE_ARTIFACT_REQUEST_FORBIDDEN", "Collector attempted an unapproved Provider request");
  if (providerCalls !== 0) fail("V2_PLACE_ARTIFACT_CALL_BUDGET_EXCEEDED", "Place request budget exceeded");
  providerCalls += 1;
  const response = transportMode === "live"
    ? await original.fetch.call(this, input, init)
    : new Response(htmlForFixture(url.searchParams.get("query") || ""), {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" }
      });
  const capture = await captureSanitized(url, init, response);
  providerAudit(url, init, response, capture);
  return response;
};
