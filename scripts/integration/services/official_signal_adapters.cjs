"use strict";

const crypto = require("node:crypto");
const {
  connectorError
} = require("../contracts/signal_connector.cjs");
const {
  cleanText,
  stableHash
} = require("../contracts/insights.cjs");

const OFFICIAL_SIGNAL_ADAPTER_VERSION = "stage231-official-signal-v1";
const NAVER_TREND_ORIGIN = "https://openapi.naver.com";
const NAVER_TREND_PATH = "/v1/datalab/search";
const NAVER_SEARCHAD_ORIGIN = "https://api.searchad.naver.com";
const NAVER_SEARCHAD_PATH = "/keywordstool";
const TOURISM_ORIGIN = "https://apis.data.go.kr";

const TOURISM_ENDPOINTS = Object.freeze({
  "tourism.visitors": Object.freeze({
    path: "/B551011/DataLabService/metcoRegnVisitrDDList",
    valueKey: "touNum"
  }),
  "tourism.resource-demand": Object.freeze({
    path: "/B551011/AreaTarResDemService/areaTarSvcDemList",
    valueKey: "tarSvcDemIxVal"
  }),
  "tourism.diversity": Object.freeze({
    path: "/B551011/AreaTarDivService/areaTouDivList",
    valueKey: "touDivIxVal"
  })
});

const REGION_CODES = Object.freeze([
  [/(?:서울특별시|서울)/, "1"], [/(?:인천광역시|인천)/, "2"],
  [/(?:대전광역시|대전)/, "3"], [/(?:대구광역시|대구)/, "4"],
  [/(?:광주광역시|광주)/, "5"], [/(?:부산광역시|부산)/, "6"],
  [/(?:울산광역시|울산)/, "7"], [/(?:세종특별자치시|세종)/, "8"],
  [/(?:경기도|경기)/, "31"], [/(?:강원특별자치도|강원도|강원)/, "32"],
  [/(?:충청북도|충북)/, "33"], [/(?:충청남도|충남)/, "34"],
  [/(?:경상북도|경북)/, "35"], [/(?:경상남도|경남)/, "36"],
  [/(?:전북특별자치도|전라북도|전북)/, "37"], [/(?:전라남도|전남)/, "38"],
  [/(?:제주특별자치도|제주도|제주)/, "39"]
]);

function providerError(message, code, statusCode, category, externalNetworkCalls = 0) {
  return connectorError(message, code, statusCode, { category, externalNetworkCalls });
}

function requiredCredential(value, label) {
  const credential = String(value || "").trim();
  if (!credential) {
    throw providerError(`${label} is not configured`, "SIGNAL_CONNECTOR_CREDENTIAL_REQUIRED", 503, "auth", 0);
  }
  return credential;
}

function requiredTransport(transport) {
  if (typeof transport !== "function") {
    throw providerError("Official provider transport is disabled", "SIGNAL_CONNECTOR_TRANSPORT_DISABLED", 503, "provider", 0);
  }
  return transport;
}

function periodRange(periodMonth) {
  if (!/^\d{4}-\d{2}$/.test(String(periodMonth || ""))) {
    throw providerError("Provider period is invalid", "SIGNAL_PROVIDER_SCHEMA", 400, "schema", 0);
  }
  const [year, month] = periodMonth.split("-").map(Number);
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return {
    month: `${year}${String(month).padStart(2, "0")}`,
    start: `${year}-${String(month).padStart(2, "0")}-01`,
    end: `${year}-${String(month).padStart(2, "0")}-${String(last).padStart(2, "0")}`,
    startCompact: `${year}${String(month).padStart(2, "0")}01`,
    endCompact: `${year}${String(month).padStart(2, "0")}${String(last).padStart(2, "0")}`
  };
}

function responseStatus(response) {
  return Number(response?.status || response?.statusCode || 0);
}

async function responseBody(response) {
  if (response && typeof response.json === "function") return response.json();
  if (typeof response?.body === "string") {
    try { return JSON.parse(response.body); } catch {
      throw providerError("Provider response schema is invalid", "SIGNAL_PROVIDER_SCHEMA", 502, "schema", 1);
    }
  }
  return response?.body ?? response?.data ?? response;
}

function headerValue(response, name) {
  const headers = response?.headers;
  if (headers?.get) return cleanText(headers.get(name), 200);
  const target = String(name).toLowerCase();
  for (const [key, value] of Object.entries(headers || {})) {
    if (String(key).toLowerCase() === target) return cleanText(value, 200);
  }
  return "";
}

function validateRequest(request, specification) {
  let parsed;
  try { parsed = new URL(request.url); } catch {
    throw providerError("Provider request URL is invalid", "SIGNAL_PROVIDER_REQUEST_FORBIDDEN", 500, "schema", 0);
  }
  if (
    parsed.protocol !== "https:"
    || parsed.origin !== specification.origin
    || !specification.paths.includes(parsed.pathname)
    || String(request.method || "GET").toUpperCase() !== specification.method
    || parsed.username
    || parsed.password
    || parsed.hash
  ) {
    throw providerError("Provider request is outside the exact HTTPS allowlist", "SIGNAL_PROVIDER_REQUEST_FORBIDDEN", 500, "schema", 0);
  }
  const allowedHeaders = new Set(specification.headers.map((row) => row.toLowerCase()));
  if (Object.keys(request.headers || {}).some((key) => !allowedHeaders.has(key.toLowerCase()))) {
    throw providerError("Provider request header is outside the allowlist", "SIGNAL_PROVIDER_REQUEST_FORBIDDEN", 500, "schema", 0);
  }
  if (specification.query) {
    const allowedQuery = new Set(specification.query);
    if ([...parsed.searchParams.keys()].some((key) => !allowedQuery.has(key))) {
      throw providerError("Provider request query is outside the allowlist", "SIGNAL_PROVIDER_REQUEST_FORBIDDEN", 500, "schema", 0);
    }
  } else if (parsed.search) {
    throw providerError("Provider request query is not allowed", "SIGNAL_PROVIDER_REQUEST_FORBIDDEN", 500, "schema", 0);
  }
  return request;
}

function classifyHttp(status, calls = 1) {
  if (status >= 200 && status < 300) return;
  if (status === 429) throw providerError("Provider rate limit", "SIGNAL_PROVIDER_RATE_LIMIT", 429, "429", calls);
  if (status === 401 || status === 403) throw providerError("Provider authentication failed", "SIGNAL_PROVIDER_AUTH", status, "auth", calls);
  throw providerError("Provider request failed", "SIGNAL_PROVIDER_HTTP", 502, "provider", calls);
}

async function invoke(transport, request, callsBefore = 0) {
  validateRequest(request, request.specification);
  try {
    const response = await transport({
      url: request.url,
      method: request.method,
      headers: request.headers,
      body: request.body,
      signal: request.signal,
      timeoutMs: request.timeoutMs
    });
    classifyHttp(responseStatus(response), callsBefore + 1);
    return { response, body: await responseBody(response), calls: callsBefore + 1 };
  } catch (reason) {
    if (reason?.code && String(reason.code).startsWith("SIGNAL_PROVIDER_")) {
      if (reason.externalNetworkCalls === undefined) reason.externalNetworkCalls = callsBefore + 1;
      throw reason;
    }
    const timeout = reason?.name === "AbortError" || reason?.code === "ABORT_ERR";
    throw providerError(
      timeout ? "Provider timeout" : "Provider transport failed",
      timeout ? "SIGNAL_PROVIDER_TIMEOUT" : "SIGNAL_PROVIDER_TRANSPORT",
      timeout ? 504 : 502,
      timeout ? "timeout" : "provider",
      callsBefore + 1
    );
  }
}

function nowIso(clock) {
  const value = typeof clock === "function" ? clock() : Date.now();
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : new Date().toISOString();
}

function liveSignal(input, kind, index, sourceUrl, externalNetworkCalls, providerRequestId, clock) {
  return {
    synthetic: false,
    dataMode: "live",
    companyId: input.companyId,
    runId: input.runId,
    region: input.region,
    periodMonth: input.periodMonth,
    observedAt: nowIso(clock),
    kind,
    index: Math.round(Math.max(0, Math.min(100, Number(index))) * 100) / 100,
    sourceUrl,
    provenance: {
      adapterVersion: OFFICIAL_SIGNAL_ADAPTER_VERSION,
      providerRequestId: providerRequestId || `provider_request_${stableHash(`${input.runId}|${kind}`, 32)}`,
      targetHash: stableHash(`${input.companyId}|${input.region}|${input.periodMonth}|${kind}`, 48),
      externalNetworkCalls
    }
  };
}

function finiteValues(rows, key) {
  return rows.map((row) => Number(row?.[key])).filter(Number.isFinite);
}

function responseItems(payload) {
  const response = payload?.response || payload;
  const header = response?.header || {};
  if (header.resultCode && String(header.resultCode) !== "00") {
    const resultCode = String(header.resultCode);
    if (["03", "NODATA_ERROR"].includes(resultCode)) {
      throw providerError("Provider returned no data", "SIGNAL_PROVIDER_EMPTY", 502, "empty", 1);
    }
    throw providerError("Provider returned an error envelope", "SIGNAL_PROVIDER_SCHEMA", 502, "schema", 1);
  }
  const item = response?.body?.items?.item;
  if (Array.isArray(item)) return item;
  if (item && typeof item === "object") return [item];
  throw providerError("Provider returned no data", "SIGNAL_PROVIDER_EMPTY", 502, "empty", 1);
}

function provinceCode(region) {
  const text = cleanText(region, 160);
  return REGION_CODES.find(([pattern]) => pattern.test(text))?.[1] || "";
}

function provinceMatches(region, name) {
  const code = provinceCode(region);
  const nameCode = provinceCode(name);
  return Boolean(code && nameCode && code === nameCode);
}

function createNaverTrendAdapter(options = {}) {
  const transport = requiredTransport(options.transport);
  const clientId = requiredCredential(options.clientId, "NAVER DataLab client id");
  const clientSecret = requiredCredential(options.clientSecret, "NAVER DataLab client secret");
  const clock = options.clock;
  return Object.freeze({
    id: "naver-trend",
    kind: "real",
    async collect(input = {}) {
      const range = periodRange(input.periodMonth);
      const keyword = cleanText(`${input.region} 숙박`, 40);
      if (!keyword) throw providerError("Provider keyword is empty", "SIGNAL_PROVIDER_SCHEMA", 400, "schema", 0);
      const request = {
        url: `${NAVER_TREND_ORIGIN}${NAVER_TREND_PATH}`,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "X-Naver-Client-Id": clientId,
          "X-Naver-Client-Secret": clientSecret
        },
        body: JSON.stringify({
          startDate: range.start,
          endDate: range.end,
          timeUnit: "date",
          keywordGroups: [{ groupName: "lodging-region", keywords: [keyword] }]
        }),
        signal: input.signal,
        timeoutMs: input.timeoutMs,
        specification: { origin: NAVER_TREND_ORIGIN, paths: [NAVER_TREND_PATH], method: "POST", headers: ["content-type", "accept", "x-naver-client-id", "x-naver-client-secret"] }
      };
      const { response, body } = await invoke(transport, request);
      const ratios = (body?.results || []).flatMap((row) => row?.data || []).map((row) => Number(row?.ratio)).filter(Number.isFinite);
      if (!ratios.length) throw providerError("Provider returned no trend data", "SIGNAL_PROVIDER_EMPTY", 502, "empty", 1);
      const index = ratios.reduce((sum, value) => sum + value, 0) / ratios.length;
      const requestId = headerValue(response, "x-transaction-id") || headerValue(response, "x-request-id");
      return {
        externalNetworkCalls: 1,
        signals: [liveSignal(input, "trend.index", index, `${NAVER_TREND_ORIGIN}${NAVER_TREND_PATH}`, 1, requestId, clock)]
      };
    }
  });
}

function createTourismAdapter(options = {}) {
  const transport = requiredTransport(options.transport);
  const serviceKey = requiredCredential(options.serviceKey, "Korea Tourism Organization service key");
  const clock = options.clock;
  return Object.freeze({
    id: "tourism",
    kind: "real",
    async collect(input = {}) {
      const range = periodRange(input.periodMonth);
      const areaCd = provinceCode(input.region);
      if (!areaCd) throw providerError("Fresh company region has no approved TourAPI area code", "SIGNAL_CONNECTOR_REGION_UNSUPPORTED", 422, "schema", 0);
      const requestedKinds = (input.signalKinds || []).filter((kind) => TOURISM_ENDPOINTS[kind]);
      if (!requestedKinds.length) throw providerError("No supported tourism signal kind", "SIGNAL_PROVIDER_SCHEMA", 400, "schema", 0);
      const signals = [];
      let calls = 0;
      for (const kind of requestedKinds) {
        const endpoint = TOURISM_ENDPOINTS[kind];
        const query = new URLSearchParams({
          serviceKey,
          numOfRows: "1000",
          pageNo: "1",
          MobileOS: "ETC",
          MobileApp: "LodgingDatalabV2",
          _type: "json"
        });
        if (kind === "tourism.visitors") {
          query.set("startYmd", range.startCompact);
          query.set("endYmd", range.endCompact);
        } else {
          query.set("baseYm", range.month);
          query.set("areaCd", areaCd);
        }
        const request = {
          url: `${TOURISM_ORIGIN}${endpoint.path}?${query.toString()}`,
          method: "GET",
          headers: { Accept: "application/json" },
          signal: input.signal,
          timeoutMs: input.timeoutMs,
          specification: {
            origin: TOURISM_ORIGIN,
            paths: [endpoint.path],
            method: "GET",
            headers: ["accept"],
            query: kind === "tourism.visitors"
              ? ["serviceKey", "numOfRows", "pageNo", "MobileOS", "MobileApp", "_type", "startYmd", "endYmd"]
              : ["serviceKey", "numOfRows", "pageNo", "MobileOS", "MobileApp", "_type", "baseYm", "areaCd", "signguCd"]
          }
        };
        let invoked;
        try { invoked = await invoke(transport, request, calls); } catch (reason) {
          reason.externalNetworkCalls = Math.max(calls + 1, Number(reason.externalNetworkCalls || 0));
          throw reason;
        }
        calls = invoked.calls;
        let rows;
        try { rows = responseItems(invoked.body); } catch (reason) {
          reason.externalNetworkCalls = calls;
          throw reason;
        }
        let index;
        if (kind === "tourism.visitors") {
          const totals = new Map();
          for (const row of rows) {
            const name = cleanText(row?.areaNm, 80);
            const value = Number(row?.touNum);
            if (name && Number.isFinite(value)) totals.set(name, (totals.get(name) || 0) + value);
          }
          const target = [...totals.entries()].filter(([name]) => provinceMatches(input.region, name)).reduce((sum, row) => sum + row[1], 0);
          const maximum = Math.max(0, ...totals.values());
          if (!maximum || !target) throw providerError("Provider returned no matching visitor data", "SIGNAL_PROVIDER_EMPTY", 502, "empty", calls);
          index = (target / maximum) * 100;
        } else {
          const values = finiteValues(rows, endpoint.valueKey);
          if (!values.length) throw providerError("Provider returned no matching tourism index", "SIGNAL_PROVIDER_EMPTY", 502, "empty", calls);
          index = values.reduce((sum, value) => sum + value, 0) / values.length;
        }
        signals.push(liveSignal(input, kind, index, `${TOURISM_ORIGIN}${endpoint.path}`, calls, "", clock));
      }
      return { externalNetworkCalls: calls, signals };
    }
  });
}

function createNaverSearchAdAdapter(options = {}) {
  const transport = requiredTransport(options.transport);
  const apiKey = requiredCredential(options.apiKey, "NAVER SearchAd API key");
  const secretKey = requiredCredential(options.secretKey, "NAVER SearchAd secret key");
  const customerId = requiredCredential(options.customerId, "NAVER SearchAd customer id");
  const clock = options.clock;
  return Object.freeze({
    id: "naver-searchad",
    kind: "real",
    async collect(input = {}) {
      const keyword = cleanText(`${input.region} 숙박`, 40).replace(/\s+/g, "");
      if (!keyword) throw providerError("Provider keyword is empty", "SIGNAL_PROVIDER_SCHEMA", 400, "schema", 0);
      const timestamp = String(Number(typeof clock === "function" ? clock() : Date.now()));
      const signature = crypto.createHmac("sha256", secretKey).update(`${timestamp}.GET.${NAVER_SEARCHAD_PATH}`).digest("base64");
      const query = new URLSearchParams({ hintKeywords: keyword, showDetail: "1" });
      const request = {
        url: `${NAVER_SEARCHAD_ORIGIN}${NAVER_SEARCHAD_PATH}?${query.toString()}`,
        method: "GET",
        headers: {
          Accept: "application/json",
          "X-Timestamp": timestamp,
          "X-API-KEY": apiKey,
          "X-Customer": customerId,
          "X-Signature": signature
        },
        signal: input.signal,
        timeoutMs: input.timeoutMs,
        specification: {
          origin: NAVER_SEARCHAD_ORIGIN,
          paths: [NAVER_SEARCHAD_PATH],
          method: "GET",
          headers: ["accept", "x-timestamp", "x-api-key", "x-customer", "x-signature"],
          query: ["hintKeywords", "showDetail"]
        }
      };
      const { response, body } = await invoke(transport, request);
      const rows = Array.isArray(body?.keywordList) ? body.keywordList : [];
      const volumes = rows.map((row) => {
        const parse = (value) => Number(String(value ?? "0").replace(/^<\s*/, "")) || 0;
        return { row, value: parse(row.monthlyPcQcCnt) + parse(row.monthlyMobileQcCnt) };
      }).filter((row) => row.value > 0);
      if (!volumes.length) throw providerError("Provider returned no search volume", "SIGNAL_PROVIDER_EMPTY", 502, "empty", 1);
      const exact = volumes.find(({ row }) => cleanText(row.relKeyword, 80).replace(/\s+/g, "") === keyword) || volumes[0];
      const maximum = Math.max(...volumes.map((row) => row.value));
      const index = maximum ? (exact.value / maximum) * 100 : 0;
      const requestId = headerValue(response, "x-transaction-id") || headerValue(response, "x-request-id");
      return {
        externalNetworkCalls: 1,
        signals: [liveSignal(input, "search.volume", index, `${NAVER_SEARCHAD_ORIGIN}${NAVER_SEARCHAD_PATH}`, 1, requestId, clock)]
      };
    }
  });
}

function createFetchTransport(options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new Error("A fetch implementation is required");
  return async function officialFetchTransport(request) {
    return fetchImpl(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      signal: request.signal
    });
  };
}

module.exports = {
  NAVER_SEARCHAD_ORIGIN,
  NAVER_SEARCHAD_PATH,
  NAVER_TREND_ORIGIN,
  NAVER_TREND_PATH,
  OFFICIAL_SIGNAL_ADAPTER_VERSION,
  TOURISM_ENDPOINTS,
  TOURISM_ORIGIN,
  createFetchTransport,
  createNaverSearchAdAdapter,
  createNaverTrendAdapter,
  createTourismAdapter,
  periodRange,
  provinceCode,
  validateRequest
};
