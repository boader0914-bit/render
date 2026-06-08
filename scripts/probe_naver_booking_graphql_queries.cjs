const fs = require("node:fs/promises");
const path = require("node:path");

const BUSINESS_ID = process.argv[2] || "244049";
const OUTPUT_DIR = path.resolve("outputs", "reservation_rate_probe");
const BASE = "https://m.booking.naver.com";

const headers = {
  "user-agent":
    "Mozilla/5.0 (Linux; Android 14; SM-S918N) AppleWebKit/537.36 Chrome/124 Mobile Safari/537.36",
  "accept-language": "ko-KR,ko;q=0.9",
};

function extractScripts(html) {
  return Array.from(html.matchAll(/<script[^>]+src="([^"]+)"/g))
    .map((match) => match[1])
    .filter((src) => src.includes("/mobile/static/js/"));
}

function snippet(text, term, before = 1400, after = 2200) {
  const index = text.indexOf(term);
  if (index < 0) return "";
  return text.slice(Math.max(0, index - before), Math.min(text.length, index + after)).replace(/\s+/g, " ");
}

function snippets(text, terms) {
  return Object.fromEntries(terms.map((term) => [term, snippet(text, term)]));
}

function extractGraphqlBodies(text) {
  const bodies = [];
  const re = /(?:query|mutation)\s+[A-Za-z0-9_]+\s*\([^`"]+/g;
  for (const match of text.matchAll(re)) {
    const value = match[0].replace(/\\n/g, "\n").replace(/\\"/g, '"');
    if (/bizItem|schedule|stock|bookable|available|accommodation|booking/i.test(value)) bodies.push(value.slice(0, 4000));
  }
  return Array.from(new Set(bodies)).slice(0, 80);
}

async function fetchText(url, referer) {
  const response = await fetch(url, {
    headers: {
      ...headers,
      referer,
      accept: "*/*",
    },
  });
  const text = await response.text();
  return { response, text };
}

async function main() {
  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  const pageUrl = `${BASE}/booking/3/bizes/${BUSINESS_ID}/search`;
  const page = await fetchText(pageUrl, BASE);
  const scripts = extractScripts(page.text);
  const selected = scripts.filter((src) =>
    /main\.|shared_utils|useBizItems|BookingList|Accommodation/.test(src),
  );
  const results = [];
  for (const src of selected) {
    const url = src.startsWith("http") ? src : `${BASE}${src}`;
    const script = await fetchText(url, pageUrl);
    const text = script.text;
    results.push({
      src,
      length: text.length,
      endpointSnippets: snippets(text, [
        "prod-m-booking.io.naver.com",
        "graphql",
        "createUploadLink",
        "HttpLink",
        "uri:",
        "operationName",
      ]),
      querySnippets: snippets(text, [
        "query bizItems",
        "query searchBizItem",
        "query schedule",
        "query accommodationBookingDetails",
        "query bookingDetailsForChange",
        "bookableOptionIds",
        "timeSlotAvailabilityDailySummaries",
      ]),
      graphqlBodies: extractGraphqlBodies(text),
    });
  }
  const output = {
    businessId: BUSINESS_ID,
    pageStatus: page.response.status,
    selected,
    results,
  };
  const filePath = path.join(OUTPUT_DIR, `naver_booking_graphql_queries_${BUSINESS_ID}_${Date.now()}.json`);
  await fs.writeFile(filePath, JSON.stringify(output, null, 2), "utf8");
  console.log(JSON.stringify({
    filePath,
    pageStatus: output.pageStatus,
    selectedCount: selected.length,
    results: results.map((result) => ({
      src: result.src,
      length: result.length,
      endpointTerms: Object.entries(result.endpointSnippets).filter(([, value]) => value).map(([key]) => key),
      queryTerms: Object.entries(result.querySnippets).filter(([, value]) => value).map(([key]) => key),
      graphqlBodyCount: result.graphqlBodies.length,
    })),
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
