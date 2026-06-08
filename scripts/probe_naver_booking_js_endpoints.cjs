const fs = require("node:fs/promises");
const path = require("node:path");

const BUSINESS_ID = process.argv[2] || "244049";
const CHECK_IN = process.env.CHECK_IN || "2026-06-14";
const CHECK_OUT = process.env.CHECK_OUT || "2026-06-15";
const ADULTS = Number(process.env.ADULTS || 2);
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

function unique(values) {
  return Array.from(new Set(values.filter(Boolean)));
}

function snippetsAround(text, patterns, limit = 20) {
  const snippets = [];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const index = match.index || 0;
      const start = Math.max(0, index - 320);
      const end = Math.min(text.length, index + 620);
      snippets.push({
        pattern: String(pattern),
        snippet: text.slice(start, end).replace(/\s+/g, " "),
      });
      if (snippets.length >= limit) return snippets;
    }
  }
  return snippets;
}

function findLiteralPaths(text) {
  const paths = [];
  const patterns = [
    /["'`]((?:https?:)?\/\/[^"'`]+)["'`]/g,
    /["'`](\/(?:api|graphql|booking|mobile|v\d|business|biz|resources|schedules|stock|stocks)[^"'`]+)["'`]/gi,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const value = match[1];
      if (/booking|graphql|api|biz|business|stock|schedule|item|resource/i.test(value)) paths.push(value);
    }
  }
  return unique(paths).slice(0, 200);
}

function findOperationNames(text) {
  return unique([
    ...Array.from(text.matchAll(/operationName\s*:\s*["'`]([^"'`]+)["'`]/g)).map((match) => match[1]),
    ...Array.from(text.matchAll(/query\s+([A-Za-z0-9_]+)\s*\(/g)).map((match) => match[1]),
    ...Array.from(text.matchAll(/mutation\s+([A-Za-z0-9_]+)\s*\(/g)).map((match) => match[1]),
  ]).filter((name) => /biz|business|item|stock|schedule|calendar|booking|accommodation|resource|price/i.test(name));
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
  const pageUrl = `${BASE}/booking/3/bizes/${BUSINESS_ID}/search?startDate=${CHECK_IN}&endDate=${CHECK_OUT}&adult=${ADULTS}`;
  const page = await fetchText(pageUrl, BASE);
  const scripts = extractScripts(page.text);
  const importantPatterns = [
    /bizItems/gi,
    /businessBizItems/gi,
    /stock/gi,
    /remain/gi,
    /bookable/gi,
    /available/gi,
    /schedule/gi,
    /accommodation/gi,
    /BusinessItem/gi,
    /Resource/gi,
  ];
  const results = [];
  for (const src of scripts) {
    const url = src.startsWith("http") ? src : `${BASE}${src}`;
    const script = await fetchText(url, pageUrl);
    const text = script.text;
    const termCounts = Object.fromEntries(
      ["bizItems", "businessBizItems", "stock", "remain", "bookable", "available", "schedule", "accommodation", "BusinessItem", "Resource"].map((term) => {
        const re = new RegExp(term, "gi");
        return [term, (text.match(re) || []).length];
      }),
    );
    const score = Object.values(termCounts).reduce((sum, count) => sum + count, 0);
    if (score === 0) continue;
    results.push({
      src,
      status: script.response.status,
      length: text.length,
      score,
      termCounts,
      operationNames: findOperationNames(text),
      literalPaths: findLiteralPaths(text),
      snippets: snippetsAround(text, importantPatterns, 18),
    });
  }
  results.sort((a, b) => b.score - a.score);
  const output = {
    businessId: BUSINESS_ID,
    checkIn: CHECK_IN,
    checkOut: CHECK_OUT,
    adults: ADULTS,
    pageStatus: page.response.status,
    scriptCount: scripts.length,
    matchedScriptCount: results.length,
    results,
  };
  const filePath = path.join(OUTPUT_DIR, `naver_booking_js_endpoints_${BUSINESS_ID}_${Date.now()}.json`);
  await fs.writeFile(filePath, JSON.stringify(output, null, 2), "utf8");
  console.log(JSON.stringify({
    filePath,
    pageStatus: output.pageStatus,
    scriptCount: output.scriptCount,
    matchedScriptCount: output.matchedScriptCount,
    topResults: results.slice(0, 8).map((result) => ({
      src: result.src,
      score: result.score,
      operationNames: result.operationNames.slice(0, 20),
      literalPaths: result.literalPaths.slice(0, 20),
      termCounts: result.termCounts,
    })),
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
