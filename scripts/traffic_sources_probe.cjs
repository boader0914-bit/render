const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const OUTPUT_DIR = path.join(ROOT, "outputs", "traffic_probe");
const TRAFFIC_KEYS_FILE = path.join(ROOT, "config", "traffic_api_keys.local.json");

const keywords = process.argv.slice(2).length ? process.argv.slice(2) : ["포천글램핑", "경북글램핑"];

function compactKeyword(keyword) {
  return String(keyword || "").replace(/\s+/g, "");
}

function spacedGlampingKeyword(keyword) {
  return compactKeyword(keyword).replace(/글램핑$/, " 글램핑").trim();
}

function normalizeApiKey(value) {
  return String(value || "").replace(/\s+/g, "").trim();
}

function yyyyMmDd(date) {
  return date.toISOString().slice(0, 10);
}

function dateDaysAgo(days) {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return date;
}

async function requestJson(url, options) {
  const response = await fetch(url, options);
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  return { ok: response.ok, status: response.status, data };
}

async function collectDatalab(keyword) {
  const keys = await readTrafficKeys();
  const clientId = normalizeApiKey(process.env.NAVER_CLIENT_ID || keys.naverClientId);
  const clientSecret = normalizeApiKey(process.env.NAVER_CLIENT_SECRET || keys.naverClientSecret);
  if (!clientId || !clientSecret) {
    return {
      source: "naver_datalab",
      keyword,
      configured: false,
      collectable: true,
      reason: "NAVER_CLIENT_ID / NAVER_CLIENT_SECRET 환경변수가 필요합니다.",
    };
  }

  const body = {
    startDate: yyyyMmDd(dateDaysAgo(90)),
    endDate: yyyyMmDd(dateDaysAgo(1)),
    timeUnit: "date",
    keywordGroups: [
      {
        groupName: keyword,
        keywords: [compactKeyword(keyword), spacedGlampingKeyword(keyword)],
      },
    ],
  };

  const result = await requestJson("https://openapi.naver.com/v1/datalab/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Naver-Client-Id": clientId,
      "X-Naver-Client-Secret": clientSecret,
    },
    body: JSON.stringify(body),
  });

  return {
    source: "naver_datalab",
    keyword,
    configured: true,
    collectable: result.ok,
    status: result.status,
    note: "검색량 절대값이 아니라 기간 내 상대 트렌드 ratio입니다.",
    data: result.data,
  };
}

function searchAdSignature(timestamp, method, uri, secretKey) {
  return crypto
    .createHmac("sha256", secretKey)
    .update(`${timestamp}.${method}.${uri}`)
    .digest("base64");
}

async function collectSearchAdKeyword(keyword) {
  const keys = await readTrafficKeys();
  const apiKey = normalizeApiKey(process.env.NAVER_SEARCHAD_API_KEY || keys.searchadApiKey);
  const secretKey = normalizeApiKey(process.env.NAVER_SEARCHAD_SECRET_KEY || keys.searchadSecretKey);
  const customerId = normalizeApiKey(process.env.NAVER_SEARCHAD_CUSTOMER_ID || keys.searchadCustomerId);
  if (!apiKey || !secretKey || !customerId) {
    return {
      source: "naver_searchad_keywordstool",
      keyword,
      configured: false,
      collectable: true,
      reason: "NAVER_SEARCHAD_API_KEY / NAVER_SEARCHAD_SECRET_KEY / NAVER_SEARCHAD_CUSTOMER_ID 환경변수가 필요합니다.",
    };
  }

  const method = "GET";
  const uri = "/keywordstool";
  const timestamp = Date.now().toString();
  const hintKeyword = compactKeyword(keyword);
  const url = `https://api.searchad.naver.com${uri}?hintKeywords=${encodeURIComponent(hintKeyword)}&showDetail=1`;
  const result = await requestJson(url, {
    method,
    headers: {
      "X-Timestamp": timestamp,
      "X-API-KEY": apiKey,
      "X-Customer": customerId,
      "X-Signature": searchAdSignature(timestamp, method, uri, secretKey),
    },
  });

  return {
    source: "naver_searchad_keywordstool",
    keyword,
    configured: true,
    collectable: result.ok,
    status: result.status,
    note: "월간 PC/모바일 검색수, 클릭수, CTR, 경쟁도 계열 데이터 확인용입니다.",
    data: result.data,
  };
}

async function readTrafficKeys() {
  try {
    return JSON.parse((await fs.readFile(TRAFFIC_KEYS_FILE, "utf8")).replace(/^\uFEFF/, ""));
  } catch {
    return {};
  }
}

async function main() {
  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  const rows = [];

  for (const keyword of keywords) {
    rows.push(await collectDatalab(keyword));
    rows.push(await collectSearchAdKeyword(keyword));
  }

  const report = {
    createdAt: new Date().toISOString(),
    keywords,
    sources: rows,
  };
  const filePath = path.join(OUTPUT_DIR, `traffic_probe_${Date.now()}.json`);
  await fs.writeFile(filePath, JSON.stringify(report, null, 2), "utf8");
  console.log(JSON.stringify({ filePath, report }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
