"use strict";

const ALLOWED_OPERATIONS = new Set(["accommodationSearch", "placeList"]);
const APOLLO_MARKERS = [
  "window.__APOLLO_STATE__ = ",
  "window.__APOLLO_STATE__=",
  "__APOLLO_STATE__ = ",
  "__APOLLO_STATE__="
];

const PUBLIC_MESSAGES = Object.freeze({
  NAVER_APOLLO_STATE_MISSING: "네이버 검색 응답을 확인하지 못해 수집을 중단했습니다.",
  NAVER_APOLLO_STATE_INVALID: "네이버 검색 응답 형식이 올바르지 않아 수집을 중단했습니다.",
  NAVER_SEARCH_CONTRACT_UNAVAILABLE: "네이버 검색 결과 형식이 변경되어 수집을 시작하지 못했습니다.",
  NAVER_SEARCH_AMBIGUOUS: "네이버 검색 결과를 안전하게 구분할 수 없어 수집을 중단했습니다."
});

class NaverPlaceParseError extends Error {
  constructor(code) {
    super(PUBLIC_MESSAGES[code] || PUBLIC_MESSAGES.NAVER_SEARCH_CONTRACT_UNAVAILABLE);
    this.name = "NaverPlaceParseError";
    this.code = code;
    this.publicMessage = this.message;
    this.retryable = false;
  }
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function jsonObjectEnd(source, start) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
    } else if (char === '"') {
      inString = true;
    } else if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
  }
  return -1;
}

function extractApolloState(html) {
  const source = String(html || "");
  for (const marker of APOLLO_MARKERS) {
    const markerIndex = source.indexOf(marker);
    if (markerIndex < 0) continue;
    const start = markerIndex + marker.length;
    const end = jsonObjectEnd(source, start);
    if (end < 0) throw new NaverPlaceParseError("NAVER_APOLLO_STATE_INVALID");
    try {
      const state = JSON.parse(source.slice(start, end));
      if (!isObject(state) || !isObject(state.ROOT_QUERY)) {
        throw new NaverPlaceParseError("NAVER_APOLLO_STATE_INVALID");
      }
      return state;
    } catch (error) {
      if (error instanceof NaverPlaceParseError) throw error;
      throw new NaverPlaceParseError("NAVER_APOLLO_STATE_INVALID");
    }
  }
  throw new NaverPlaceParseError("NAVER_APOLLO_STATE_MISSING");
}

function parseRootKey(key) {
  const match = /^([A-Za-z][A-Za-z0-9_]*)\(([\s\S]*)\)$/.exec(String(key || ""));
  if (!match) return null;
  try {
    const args = JSON.parse(match[2]);
    return isObject(args) ? { operation: match[1], args } : null;
  } catch {
    return null;
  }
}

function normalizeQuery(value) {
  return String(value || "").normalize("NFC").trim().replace(/\s+/gu, " ");
}

function naverPlaceAddress(item = {}) {
  if (!isObject(item)) return "";
  for (const value of [item.roadAddress, item.jibunAddress, item.address, item.commonAddress]) {
    if (typeof value !== "string") continue;
    const address = value.normalize("NFC").trim().replace(/\s+/gu, " ").slice(0, 320);
    if (address) return address;
  }
  return "";
}

function containsForbiddenArgument(value) {
  if (Array.isArray(value)) return value.some(containsForbiddenArgument);
  if (!isObject(value)) return false;
  return Object.entries(value).some(([key, nested]) => key === "filterOpening" || containsForbiddenArgument(nested));
}

function finiteInteger(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isInteger(number) ? number : null;
}

function dereference(state, value) {
  if (!isObject(value)) return value;
  if (typeof value.__ref !== "string") return value;
  return isObject(state[value.__ref]) ? state[value.__ref] : null;
}

function resultDescriptor(state, rootValue, operation) {
  const root = dereference(state, rootValue);
  if (!isObject(root)) return null;
  const preferredContainers = operation === "placeList" ? ["businesses", "business"] : ["business", "businesses"];
  for (const containerKey of preferredContainers) {
    const container = dereference(state, root[containerKey]);
    if (!isObject(container) || !Array.isArray(container.items)) continue;
    const items = [];
    let malformedItemCount = 0;
    for (const entry of container.items) {
      const item = dereference(state, entry);
      if (isObject(item)) items.push(item);
      else malformedItemCount += 1;
    }
    if (malformedItemCount > 0) continue;
    const parsedTotal = Number(container.total);
    const totalKnown = Number.isFinite(parsedTotal) && parsedTotal >= 0;
    return {
      containerKey,
      items,
      malformedItemCount,
      total: totalKnown ? parsedTotal : items.length,
      totalKnown
    };
  }
  return null;
}

function queryFromArgs(args) {
  if (typeof args?.input?.query === "string") return args.input.query;
  if (typeof args?.query === "string") return args.query;
  return "";
}

function pageRank(args) {
  const value = finiteInteger(args?.input?.start ?? args?.input?.page ?? args?.start ?? args?.page);
  return value === null || value === 0 || value === 1 ? 0 : 1;
}

function displayValue(args) {
  const raw = args?.input?.display ?? args?.display;
  const value = finiteInteger(raw);
  if (raw === null || raw === undefined || raw === "") return null;
  return value !== null && value >= 1 && value <= 100 ? value : Number.NaN;
}

function candidateRank(candidate) {
  const display = candidate.display;
  return [
    candidate.queryExact ? 0 : 1,
    pageRank(candidate.args),
    candidate.items.length ? 0 : 1,
    candidate.operation === "accommodationSearch" ? 0 : 1,
    display === 50 ? 0 : 1,
    display === null ? 101 : -display
  ];
}

function compareRank(left, right) {
  const a = candidateRank(left);
  const b = candidateRank(right);
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}

function candidateFingerprint(candidate) {
  return JSON.stringify({
    operation: candidate.operation,
    containerKey: candidate.containerKey,
    display: candidate.display,
    total: candidate.total,
    itemIds: candidate.items.map((item) => String(item.id || item.placeId || item.__typename || "")).sort()
  });
}

function selectNaverOrganicResult(state, query, options = {}) {
  if (!isObject(state) || !isObject(state.ROOT_QUERY)) {
    throw new NaverPlaceParseError("NAVER_APOLLO_STATE_INVALID");
  }
  const normalizedTarget = normalizeQuery(query);
  if (!normalizedTarget) throw new NaverPlaceParseError("NAVER_SEARCH_CONTRACT_UNAVAILABLE");
  const allowPlaceList = options.allowPlaceList !== false;
  const candidates = [];

  for (const [key, value] of Object.entries(state.ROOT_QUERY)) {
    const parsed = parseRootKey(key);
    if (!parsed || !ALLOWED_OPERATIONS.has(parsed.operation)) continue;
    if (parsed.operation === "placeList" && !allowPlaceList) continue;
    if (key.includes("filterOpening") || containsForbiddenArgument(parsed.args)) continue;
    const sourceQuery = queryFromArgs(parsed.args);
    const normalizedSource = normalizeQuery(sourceQuery);
    if (!normalizedSource || normalizedSource !== normalizedTarget) continue;
    const display = displayValue(parsed.args);
    if (Number.isNaN(display)) continue;
    if (pageRank(parsed.args) !== 0) continue;
    const descriptor = resultDescriptor(state, value, parsed.operation);
    if (!descriptor) continue;
    candidates.push({
      key,
      operation: parsed.operation,
      type: parsed.operation,
      args: parsed.args,
      display,
      queryExact: sourceQuery === query,
      ...descriptor
    });
  }

  if (!candidates.length) {
    if (options.required === false) return null;
    throw new NaverPlaceParseError("NAVER_SEARCH_CONTRACT_UNAVAILABLE");
  }

  candidates.sort((left, right) => compareRank(left, right) || left.key.localeCompare(right.key));
  const best = candidates[0];
  const tied = candidates.filter((candidate) => compareRank(candidate, best) === 0);
  const fingerprints = new Set(tied.map(candidateFingerprint));
  if (fingerprints.size > 1) throw new NaverPlaceParseError("NAVER_SEARCH_AMBIGUOUS");
  return best;
}

function looksLikeAccessBlock(html) {
  const source = String(html || "").slice(0, 20000).toLowerCase();
  if (APOLLO_MARKERS.some((marker) => source.includes(marker.toLowerCase()))) return false;
  return /captcha|access\s*denied|비정상적인\s*접근|자동입력\s*방지|보안\s*확인/.test(source);
}

module.exports = {
  NaverPlaceParseError,
  extractApolloState,
  looksLikeAccessBlock,
  naverPlaceAddress,
  normalizeQuery,
  parseRootKey,
  selectNaverOrganicResult
};
