const fs = require("node:fs/promises");
const path = require("node:path");

const PLACE_ID = process.argv[2] || "1188470596";
const CHECK_IN = process.env.CHECK_IN || "2026-06-14";
const CHECK_OUT = process.env.CHECK_OUT || "2026-06-15";
const OUTPUT_DIR = path.resolve("outputs", "reservation_rate_probe");

const headers = {
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36",
  "accept-language": "ko-KR,ko;q=0.9",
};

function jsonEnd(s, start) {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i += 1) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') {
      inStr = true;
    } else if (c === "{") {
      depth += 1;
    } else if (c === "}") {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

function extractApolloState(html) {
  const marker = "window.__APOLLO_STATE__ = ";
  const markerIndex = html.indexOf(marker);
  if (markerIndex < 0) throw new Error("Apollo state was not found.");
  const start = markerIndex + marker.length;
  const end = jsonEnd(html, start);
  if (end < 0) throw new Error("Apollo state JSON did not terminate.");
  return JSON.parse(html.slice(start, end));
}

function parseRootKey(key) {
  const start = key.indexOf("(");
  const end = key.lastIndexOf(")");
  if (start < 0 || end < 0) return null;
  try {
    return JSON.parse(key.slice(start + 1, end));
  } catch {
    return null;
  }
}

function pickKeys(object, pattern) {
  return Object.keys(object || {}).filter((key) => pattern.test(key)).sort();
}

function shallowPick(object, pattern) {
  const picked = {};
  for (const [key, value] of Object.entries(object || {})) {
    if (!pattern.test(key)) continue;
    picked[key] = Array.isArray(value) ? `Array(${value.length})` : value && typeof value === "object" ? "Object" : value;
  }
  return picked;
}

function sampleValue(value) {
  if (Array.isArray(value)) {
    return value.slice(0, 5).map(sampleValue);
  }
  if (value && typeof value === "object") {
    const result = {};
    for (const [key, child] of Object.entries(value).slice(0, 25)) {
      result[key] = sampleValue(child);
    }
    return result;
  }
  return value;
}

async function fetchState(route) {
  const url = `https://pcmap.place.naver.com/accommodation/${PLACE_ID}/${route}?checkin=${CHECK_IN}&checkout=${CHECK_OUT}`;
  const res = await fetch(url, { headers });
  const text = await res.text();
  const state = extractApolloState(text);
  return { url, status: res.status, state };
}

async function main() {
  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  const pattern = /booking|Booking|예약|reservation|Reservation|room|Room|객실|stock|Stock|remain|Remain|available|Available|avail|Avail|qty|Qty|count|Count|sold|Sold|price|Price/i;
  const routes = ["home", "room", "booking"];
  const result = {
    placeId: PLACE_ID,
    checkIn: CHECK_IN,
    checkOut: CHECK_OUT,
    collectedAt: new Date().toLocaleString("ko-KR", { timeZone: "Asia/Seoul" }),
    routes: [],
  };

  for (const route of routes) {
    try {
      const { url, status, state } = await fetchState(route);
      const rootKeys = pickKeys(state.ROOT_QUERY, pattern);
      const objectEntries = Object.entries(state)
        .filter(([key, value]) => key !== "ROOT_QUERY" && (pattern.test(key) || pickKeys(value, pattern).length))
        .slice(0, 80)
        .map(([key, value]) => ({
          key,
          matchedKeys: pickKeys(value, pattern),
          picked: shallowPick(value, pattern),
        }));
      const roomObjects = Object.entries(state)
        .filter(([key]) => /Room|room/i.test(key))
        .slice(0, 20)
        .map(([key, value]) => ({ key, value: sampleValue(value) }));
      const rootSamples = rootKeys.slice(0, 30).map((key) => ({
        key,
        args: parseRootKey(key),
        value: sampleValue(state.ROOT_QUERY[key]),
      }));
      result.routes.push({
        route,
        url,
        status,
        stateKeys: Object.keys(state).length,
        rootKeys,
        rootSamples,
        objectEntries,
        roomObjects,
      });
    } catch (error) {
      result.routes.push({ route, error: error.message || String(error) });
    }
  }

  const filePath = path.join(OUTPUT_DIR, `naver_booking_structure_${PLACE_ID}_${Date.now()}.json`);
  await fs.writeFile(filePath, JSON.stringify(result, null, 2), "utf8");
  console.log(JSON.stringify({
    filePath,
    summary: result.routes.map((route) => ({
      route: route.route,
      status: route.status,
      rootKeyCount: route.rootKeys?.length || 0,
      roomObjectCount: route.roomObjects?.length || 0,
      sampleRootKeys: route.rootKeys?.slice(0, 12) || [],
      error: route.error,
    })),
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
