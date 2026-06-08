const fs = require("node:fs/promises");
const path = require("node:path");

const BUSINESS_ID = process.argv[2] || "244049";
const CHECK_IN = process.env.CHECK_IN || "2026-06-14";
const CHECK_OUT = process.env.CHECK_OUT || "2026-06-15";
const ADULTS = Number(process.env.ADULTS || 2);
const OUTPUT_DIR = path.resolve("outputs", "reservation_rate_probe");

const headers = {
  "user-agent":
    "Mozilla/5.0 (Linux; Android 14; SM-S918N) AppleWebKit/537.36 Chrome/124 Mobile Safari/537.36",
  "accept-language": "ko-KR,ko;q=0.9",
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
};

function jsonEnd(source, start) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < source.length; i += 1) {
    const char = source[i];
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
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

function extractStateByMarkers(html, markers) {
  for (const marker of markers) {
    const markerIndex = html.indexOf(marker);
    if (markerIndex < 0) continue;
    const start = markerIndex + marker.length;
    const end = jsonEnd(html, start);
    if (end < 0) continue;
    return {
      marker,
      state: JSON.parse(html.slice(start, end)),
    };
  }
  return { marker: "", state: null };
}

function extractApolloState(html) {
  return extractStateByMarkers(html, [
    "window.__APOLLO_STATE__ = ",
    "window.__APOLLO_STATE__=",
    "__APOLLO_STATE__ = ",
    "__APOLLO_STATE__=",
  ]);
}

function extractPreloadedState(html) {
  return extractStateByMarkers(html, [
    "window.__PRELOADED_STATE__ = ",
    "window.__PRELOADED_STATE__=",
    "__PRELOADED_STATE__ = ",
    "__PRELOADED_STATE__=",
    "window.__INITIAL_STATE__ = ",
    "window.__INITIAL_STATE__=",
    "__INITIAL_STATE__ = ",
    "__INITIAL_STATE__=",
  ]);
}

function safeString(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function isRef(value) {
  return value && typeof value === "object" && typeof value.__ref === "string";
}

function deref(state, value) {
  if (!isRef(value)) return value;
  return state[value.__ref] || value;
}

function flattenValue(state, value, depth = 0, seen = new Set()) {
  const resolved = deref(state, value);
  if (!resolved || typeof resolved !== "object" || depth > 3) return resolved;
  if (seen.has(resolved)) return "[Circular]";
  seen.add(resolved);
  if (Array.isArray(resolved)) {
    return resolved.slice(0, 30).map((item) => flattenValue(state, item, depth + 1, seen));
  }
  const result = {};
  for (const [key, child] of Object.entries(resolved)) {
    if (key === "__typename") {
      result[key] = child;
    } else if (isRef(child)) {
      result[key] = flattenValue(state, child, depth + 1, seen);
    } else if (Array.isArray(child)) {
      result[key] = child.slice(0, 30).map((item) => flattenValue(state, item, depth + 1, seen));
    } else if (child && typeof child === "object") {
      result[key] = flattenValue(state, child, depth + 1, seen);
    } else {
      result[key] = child;
    }
  }
  seen.delete(resolved);
  return result;
}

function pickFields(object, pattern) {
  const fields = {};
  for (const [key, value] of Object.entries(object || {})) {
    if (pattern.test(key) || pattern.test(safeString(value))) fields[key] = value;
  }
  return fields;
}

function scoreObject(key, object) {
  const text = `${key} ${safeString(object)}`;
  const patterns = [
    /bizItem|business|item|room|객실|상품/i,
    /stock|remain|count|quantity|qty|수량|잔여|재고|남은/i,
    /bookable|available|예약|판매|마감|가능/i,
    /price|금액|요금|원/i,
  ];
  return patterns.reduce((sum, pattern) => sum + (pattern.test(text) ? 1 : 0), 0);
}

function extractCandidateObjects(state) {
  const pattern = /bizItem|business|item|room|객실|상품|stock|remain|count|quantity|qty|수량|잔여|재고|bookable|available|예약|판매|마감|가능|price|금액|요금/i;
  return Object.entries(state || {})
    .filter(([, value]) => value && typeof value === "object")
    .map(([key, value]) => ({
      key,
      score: scoreObject(key, value),
      fields: pickFields(value, pattern),
      sample: flattenValue(state, value),
    }))
    .filter((entry) => entry.score >= 2 || Object.keys(entry.fields).length >= 2)
    .sort((a, b) => b.score - a.score || a.key.localeCompare(b.key))
    .slice(0, 120);
}

function extractScripts(html) {
  return Array.from(html.matchAll(/<script[^>]+src="([^"]+)"/g))
    .map((match) => match[1])
    .filter((src) => src.includes("/mobile/static/js/"));
}

function summarizeTextMatches(html) {
  const terms = ["bizItems", "stock", "remain", "bookable", "available", "객실", "예약가능", "마감"];
  return Object.fromEntries(
    terms.map((term) => {
      const re = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
      return [term, (html.match(re) || []).length];
    }),
  );
}

function markerSnippets(html) {
  const markers = [
    "__APOLLO_STATE__",
    "__PRELOADED_STATE__",
    "__INITIAL_STATE__",
    "apolloState",
    "Apollo",
    "bizItems",
    "stock",
    "remain",
    "bookable",
  ];
  return Object.fromEntries(
    markers.map((marker) => {
      const index = html.indexOf(marker);
      if (index < 0) return [marker, ""];
      const start = Math.max(0, index - 220);
      const end = Math.min(html.length, index + 520);
      return [marker, html.slice(start, end).replace(/\s+/g, " ")];
    }),
  );
}

async function main() {
  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  const url = `https://m.booking.naver.com/booking/3/bizes/${BUSINESS_ID}/search?startDate=${CHECK_IN}&endDate=${CHECK_OUT}&adult=${ADULTS}`;
  const response = await fetch(url, { headers });
  const html = await response.text();
  const apollo = extractApolloState(html);
  const preloaded = extractPreloadedState(html);
  const apolloState = apollo.state;
  const preloadedState = preloaded.state;
  const candidates = extractCandidateObjects(apolloState || preloadedState || {});
  const output = {
    businessId: BUSINESS_ID,
    checkIn: CHECK_IN,
    checkOut: CHECK_OUT,
    adults: ADULTS,
    status: response.status,
    url,
    htmlLength: html.length,
    apolloStateFound: Boolean(apolloState),
    preloadedStateFound: Boolean(preloadedState),
    apolloMarker: apollo.marker,
    preloadedMarker: preloaded.marker,
    rootKeyCount: Object.keys(apolloState || preloadedState || {}).length,
    textMatches: summarizeTextMatches(html),
    markerSnippets: markerSnippets(html),
    scriptSources: extractScripts(html),
    candidateCount: candidates.length,
    candidates,
  };
  const filePath = path.join(OUTPUT_DIR, `naver_booking_mobile_state_${BUSINESS_ID}_${Date.now()}.json`);
  await fs.writeFile(filePath, JSON.stringify(output, null, 2), "utf8");
  console.log(JSON.stringify({
    filePath,
    status: output.status,
    htmlLength: output.htmlLength,
    apolloStateFound: output.apolloStateFound,
    preloadedStateFound: output.preloadedStateFound,
    apolloMarker: output.apolloMarker,
    preloadedMarker: output.preloadedMarker,
    rootKeyCount: output.rootKeyCount,
    textMatches: output.textMatches,
    topCandidates: output.candidates.slice(0, 12).map((entry) => ({
      key: entry.key,
      score: entry.score,
      fieldKeys: Object.keys(entry.fields).slice(0, 20),
    })),
    scriptCount: output.scriptSources.length,
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
