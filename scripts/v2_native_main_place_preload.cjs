"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const captureRoot = path.resolve(String(process.env.V2_NATIVE_CAPTURE_ROOT || ""));
const captureFile = path.join(captureRoot, "sanitized-capture.json");
let captureCount = 0;

function fail(message) {
  const error = new Error(message);
  error.code = "V2_NATIVE_MAIN_PLACE_PRELOAD_INVALID";
  throw error;
}

function assertInsideRoot(filePath) {
  const resolved = path.resolve(filePath);
  const relative = path.relative(captureRoot, resolved);
  if (
    !String(process.env.V2_NATIVE_CAPTURE_ROOT || "").trim()
    || !relative
    || relative === ".."
    || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative)
  ) fail("capture path must stay inside the isolated capture root");
  return resolved;
}

const expectedEnvironment = {
  NAVER_MAIN_PLACE_RECOVERY_PROBE: "1",
  NAVER_LEGACY_INVENTORY_ACTIVATION: "0",
  V2_TOP20_WORKER_ACTIVATION: "0",
  NAVER_PROVIDER_CALL_BUDGET: "1",
  NAVER_INVENTORY_CALL_BUDGET: "0",
  NAVER_TOTAL_CALL_BUDGET: "1",
  NAVER_DETAIL_LIVE_CALLS_ALLOWED: "0",
  NAVER_AUTOMATIC_RETRY: "0",
  NAVER_AUTOMATIC_FALLBACK: "0"
};
for (const [name, value] of Object.entries(expectedEnvironment)) {
  if (process.env[name] !== value) fail("main-place probe environment is not fail-closed");
}
assertInsideRoot(captureFile);

const originalModuleLoad = Module._load;
Module._load = function nativeMainPlaceModuleLoad(request, parent, isMain) {
  if (request === "./workbook_export.cjs" && String(parent?.filename || "").endsWith("gyeongnam_glamping_crawl.cjs")) {
    return {
      buildWorkbook: async () => fail("main-place probe reached a forbidden workbook write")
    };
  }
  return originalModuleLoad.call(this, request, parent, isMain);
};

function headerValue(headers, name) {
  if (typeof headers?.get === "function") return String(headers.get(name) || "");
  return "";
}

async function readCloneBounded(response) {
  const clone = response?.clone?.();
  if (!clone?.body || typeof clone.body.getReader !== "function") {
    fail("capture response body is unavailable");
  }
  const contentLength = Number(headerValue(clone.headers, "content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
    await clone.body.cancel().catch(() => {});
    fail("capture response exceeded the bounded size");
  }
  const reader = clone.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      total += chunk.length;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => {});
        fail("capture response exceeded the bounded size");
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock?.();
  }
  return Buffer.concat(chunks, total).toString("utf8");
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function sanitizedItems(items) {
  return (items || []).map((item, index) => {
    const placeId = String(item?.id || item?.placeId || "");
    if (!/^\d{1,30}$/u.test(placeId)) fail("capture item has no stable numeric place ID");
    return {
      rank: index + 1,
      placeId,
      fields: {
        name: typeof item?.name === "string" && item.name.length > 0,
        category: typeof item?.category === "string" && item.category.length > 0,
        address: [item?.roadAddress, item?.jibunAddress, item?.address, item?.commonAddress]
          .some((value) => typeof value === "string" && value.length > 0),
        placeReviewCount: Number.isFinite(Number(item?.placeReviewCount)),
        placeReviewScore: Number.isFinite(Number(item?.placeReviewScore)),
        hasBooking: typeof item?.hasBooking === "boolean"
      }
    };
  });
}

async function writeSanitizedCapture(url, init, response) {
  const query = String(url.searchParams.get("query") || "").normalize("NFC").trim().replace(/\s+/gu, " ");
  const capture = {
    schemaVersion: "v2-native-main-place-sanitized-capture.v1",
    request: {
      method: String(init?.method || "GET").toUpperCase(),
      origin: url.origin,
      path: url.pathname,
      queryHash: sha256(query)
    },
    response: {
      status: Number(response.status),
      contentType: headerValue(response.headers, "content-type").slice(0, 160)
    },
    parseStatus: "not_attempted",
    organic: null,
    rawProviderResponseStored: false
  };
  if (Number(response.status) >= 200 && Number(response.status) < 300) {
    try {
      const body = await readCloneBounded(response);
      const parserPath = path.join(process.cwd(), "scripts", "naver_place_apollo_parser.cjs");
      const { extractApolloState, selectNaverOrganicResult } = require(parserPath);
      const state = extractApolloState(body);
      const selected = selectNaverOrganicResult(state, query, { allowPlaceList: true });
      capture.parseStatus = "parsed";
      capture.organic = {
        operation: String(selected.operation || selected.type || ""),
        total: Number(selected.total || 0),
        items: sanitizedItems(selected.items)
      };
    } catch (error) {
      capture.parseStatus = "unavailable";
      capture.parseCode = String(error?.code || "V2_NATIVE_CAPTURE_UNAVAILABLE").slice(0, 80);
    }
  }
  await fs.promises.mkdir(captureRoot, { recursive: true });
  const temporary = assertInsideRoot(`${captureFile}.${process.pid}.tmp`);
  await fs.promises.writeFile(temporary, `${JSON.stringify(capture, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  await fs.promises.rename(temporary, assertInsideRoot(captureFile));
}

const originalFetch = globalThis.fetch;
if (typeof originalFetch !== "function") fail("fetch is unavailable");
globalThis.fetch = async function capturedMainPlaceFetch(input, init = {}) {
  const url = input instanceof URL ? input : new URL(String(input));
  const method = String(init.method || "GET").toUpperCase();
  if (
    url.origin !== "https://pcmap.place.naver.com"
    || url.pathname !== "/accommodation/list"
    || method !== "GET"
    || init.redirect !== "manual"
  ) fail("main-place probe attempted an unapproved request");
  if (captureCount !== 0) fail("capture call budget exceeded");
  captureCount += 1;
  const response = await originalFetch.call(this, input, init);
  await writeSanitizedCapture(url, init, response);
  return response;
};
