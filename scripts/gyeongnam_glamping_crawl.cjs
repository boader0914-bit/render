const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const {
  collectionContextFromEnv,
  decorateLodgingResult,
  evaluateLodgingRelevance
} = require("./lodging_collection_context.cjs");
const { buildWorkbook } = require("./workbook_export.cjs");
const {
  extractApolloState,
  looksLikeAccessBlock,
  naverPlaceAddress,
  parseRootKey,
  selectNaverOrganicResult
} = require("./naver_place_apollo_parser.cjs");
const {
  createCrawlFailure,
  serializeCollectorFailure
} = require("./crawl_failure_contract.cjs");

const PRODUCT_MODES = {
  all: "전체",
  lodging: "숙박",
  campnic: "캠프닉"
};
const SEARCH_MODES = {
  keyword: "키워드/권역",
  company: "업체명"
};
const COLLECTION_MODES = {
  precision: "정밀 분석",
  fast: "빠른 순위"
};
const COLLECTION_PURPOSES = {
  basic_db: "기본 DB 수집",
  revenue_detail: "상세 매출 수집",
  demand_location: "수요·입지 정밀 분석"
};
const COLLECTOR_VERSION = "lodging-collector-v2-observation-fields-1";

function kstDate(offsetDays = 0) {
  const now = new Date();
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  kst.setUTCDate(kst.getUTCDate() + offsetDays);
  return kst.toISOString().slice(0, 10);
}

function normalizeProductMode(value) {
  const text = String(value || "").trim();
  if (PRODUCT_MODES[text]) return text;
  if (text === "숙박") return "lodging";
  if (text === "캠프닉" || text === "데이유즈" || text.toLowerCase() === "dayuse") return "campnic";
  return "all";
}

function normalizeSearchMode(value) {
  const text = String(value || "").trim();
  if (SEARCH_MODES[text]) return text;
  if (text === "업체명" || text.toLowerCase() === "company") return "company";
  return "keyword";
}

function normalizeCollectionMode(value) {
  const text = String(value || "").trim();
  if (COLLECTION_MODES[text]) return text;
  if (text === "빠른 순위" || text.toLowerCase() === "fast") return "fast";
  return "precision";
}

function normalizeCollectionPurpose(value) {
  const text = String(value || "").trim();
  if (COLLECTION_PURPOSES[text]) return text;
  if (/basic|master|db|기본/.test(text)) return "basic_db";
  if (/demand|location|cluster|입지|수요/.test(text)) return "demand_location";
  return "revenue_detail";
}

function collectionPurposeDefaultRange(value) {
  const purpose = normalizeCollectionPurpose(value);
  if (purpose === "basic_db") return "1-50";
  if (purpose === "demand_location") return "1-20";
  return "1-10";
}

function collectionExecutionProfile(purposeValue, modeValue = "precision") {
  const purpose = normalizeCollectionPurpose(purposeValue);
  const mode = normalizeCollectionMode(modeValue);
  if (mode === "fast") {
    return {
      key: "fast_rank",
      label: "빠른 순위 확인",
      note: "순위 중심으로 빠르게 확인하고 상세 수집은 생략합니다.",
      collectRegional: false,
      collectOta: false,
      collectBookingStock: false,
      collectWeeklyRange: false,
      regionalSkipNote: "빠른 순위 모드에서 지역별 반복 수집 생략",
      otaSkipNote: "빠른 순위 모드에서 보조 채널 수집 생략"
    };
  }
  if (purpose === "basic_db") {
    return {
      key: "basic_db_light",
      label: "기본 DB 중심",
      note: "순위, 예약 연결, 상품 구성과 대표 가격을 넓게 확인하고 기간별 매출은 생략합니다.",
      collectRegional: false,
      collectOta: false,
      collectBookingStock: true,
      collectWeeklyRange: false,
      regionalSkipNote: "기본 DB 수집에서는 지역 반복 수집을 생략",
      otaSkipNote: "기본 DB 수집에서는 OTA 보조 수집을 생략"
    };
  }
  if (purpose === "demand_location") {
    return {
      key: "demand_location_signal",
      label: "수요·입지 중심",
      note: "지역 노출, 클러스터, 검색수요 신호를 우선하고 기간별 매출은 상세 매출 수집에서 확인합니다.",
      collectRegional: true,
      collectOta: false,
      collectBookingStock: true,
      collectWeeklyRange: false,
      regionalSkipNote: "",
      otaSkipNote: "수요·입지 정밀 분석에서는 OTA 보조 수집을 생략"
    };
  }
  return {
    key: "revenue_detail_deep",
    label: "상세 매출 중심",
    note: "예약 수량, 요일별 가격, 기간별 예상 매출과 보조 채널을 함께 확인합니다.",
    collectRegional: true,
    collectOta: true,
    collectBookingStock: true,
    collectWeeklyRange: true,
    regionalSkipNote: "",
    otaSkipNote: ""
  };
}

function boundedInteger(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(number)));
}

function parseRankRanges(value, fallback = "1-20") {
  const text = String(value ?? "").trim();
  const source = (!text || /^(none|skip|없음)$/i.test(text)) ? fallback : text;
  if (!source || /^(none|skip|없음)$/i.test(source)) return [];
  if (/^(all|전체)$/i.test(source)) return [{ from: 1, to: 100 }];
  const ranges = [];
  for (const part of source.split(/[,\s]+/).map((item) => item.trim()).filter(Boolean)) {
    const match = part.match(/^(\d{1,3})(?:\s*[-~]\s*(\d{1,3}))?$/);
    if (!match) continue;
    const left = boundedInteger(match[1], 0, 1, 100);
    const right = boundedInteger(match[2] || match[1], left, 1, 100);
    const from = Math.min(left, right);
    const to = Math.max(left, right);
    ranges.push({ from, to });
  }
  return ranges.length || !fallback || source === fallback ? ranges : parseRankRanges(fallback, "");
}

function rankRangeLabel(ranges = []) {
  return ranges.length
    ? ranges.map((range) => (range.from === range.to ? `${range.from}` : `${range.from}-${range.to}`)).join(",")
    : "없음";
}

function rankRangePlaceLimit(ranges = []) {
  const ranks = new Set();
  for (const range of ranges) {
    const from = boundedInteger(range.from, 0, 1, 100);
    const to = boundedInteger(range.to, from, 1, 100);
    for (let rank = Math.min(from, to); rank <= Math.max(from, to); rank += 1) {
      ranks.add(rank);
      if (ranks.size >= 20) return 20;
    }
  }
  return Math.max(0, Math.min(20, ranks.size));
}

function rankInRanges(rank, ranges = []) {
  const number = Number(rank);
  return Number.isFinite(number) && ranges.some((range) => number >= range.from && number <= range.to);
}

function addDays(dateString, offsetDays) {
  const date = new Date(`${dateString}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + offsetDays);
  return date.toISOString().slice(0, 10);
}

function shortDate(dateString) {
  return String(dateString || "").slice(5).replace("-", "/");
}

function formatRate(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "";
  return `${Math.round(number * 100)}%`;
}

function safeFilePart(value, fallback = "검색") {
  const cleaned = String(value || "")
    .normalize("NFKC")
    .replace(/[\\/:*?"<>|]/g, " ")
    .replace(/\s+/g, "_")
    .replace(/^_+|_+$/g, "");
  return (cleaned || fallback).slice(0, 80);
}

function detailJsonRelativePath(meta = {}, jsonText = "") {
  const field = safeFilePart(meta.field || "detail", "detail").slice(0, 42);
  const place = safeFilePart(meta.placeId || meta.bookingBusinessId || meta.name || "item", "item").slice(0, 42);
  const hash = crypto.createHash("sha1").update(`${field}:${jsonText}`).digest("hex").slice(0, 12);
  return `${DETAIL_JSON_DIR_NAME}/${place}_${field}_${hash}.json`;
}

const CHECK_IN = process.env.CHECK_IN || kstDate(0);
const CHECK_OUT = process.env.CHECK_OUT || kstDate(6);
const ADULTS = Number(process.env.ADULTS || 2);
const PRODUCT_MODE = normalizeProductMode(process.env.PRODUCT_MODE || "all");
const PRODUCT_MODE_LABEL = PRODUCT_MODES[PRODUCT_MODE];
const BOOKING_RANGE_DAYS = boundedInteger(process.env.BOOKING_RANGE_DAYS, 7, 1, 31);
const RAW_KEYWORD = process.argv[2] || "경남글램핑";
const COLLECTION_SEARCH_CONTEXT = collectionContextFromEnv(process.env, RAW_KEYWORD);
const HAS_COLLECTION_SEARCH_CONTEXT = Boolean(COLLECTION_SEARCH_CONTEXT.intent);
const SEARCH_MODE = normalizeSearchMode(process.env.SEARCH_MODE || "keyword");
const SEARCH_MODE_LABEL = SEARCH_MODES[SEARCH_MODE];
const COLLECTION_MODE = normalizeCollectionMode(process.env.COLLECTION_MODE || "precision");
const COLLECTION_MODE_LABEL = COLLECTION_MODES[COLLECTION_MODE];
const COLLECTION_PURPOSE = normalizeCollectionPurpose(process.env.COLLECTION_PURPOSE || "revenue_detail");
const COLLECTION_PURPOSE_LABEL = COLLECTION_PURPOSES[COLLECTION_PURPOSE];
const COLLECTION_PROFILE = collectionExecutionProfile(COLLECTION_PURPOSE, COLLECTION_MODE);
const DETAIL_RANK_RANGES = parseRankRanges(process.env.DETAIL_RANK_RANGES, COLLECTION_MODE === "fast" ? "" : collectionPurposeDefaultRange(COLLECTION_PURPOSE));
const DETAIL_RANK_RANGE_LABEL = rankRangeLabel(DETAIL_RANK_RANGES);
const DETAIL_RANGE_PLACE_LIMIT = COLLECTION_MODE === "fast" ? 0 : (rankRangePlaceLimit(DETAIL_RANK_RANGES) || 10);
const BOOKING_RANGE_PLACE_LIMIT = COLLECTION_PROFILE.collectWeeklyRange
  ? boundedInteger(process.env.BOOKING_RANGE_PLACE_LIMIT, BOOKING_RANGE_DAYS > 1 ? DETAIL_RANGE_PLACE_LIMIT : 0, 0, 20)
  : 0;
const SOURCE_ROLE = String(process.env.SOURCE_ROLE || "admin").trim() || "admin";
const COLLECTION_SOURCE = String(process.env.COLLECTION_SOURCE || (SOURCE_ROLE === "b2b" ? "b2b_search" : "admin_search")).trim();
const COLLECTION_SOURCE_LABEL = String(process.env.COLLECTION_SOURCE_LABEL || (COLLECTION_SOURCE === "b2b_search" ? "B2B 검색" : "관리자 수집")).trim();

const regionSlugMap = {
  거제: "geoje",
  통영: "tongyeong",
  고성: "goseong",
  창원: "changwon",
  김해: "gimhae",
  밀양: "miryang",
  양산: "yangsan",
  남해: "namhae",
  사천: "sacheon",
  진주: "jinju",
  산청: "sancheong",
  하동: "hadong",
  함안: "haman",
  의령: "uiryeong",
  창녕: "changnyeong",
  함양: "hamyang",
  거창: "geochang",
  합천: "hapcheon",
  포항: "pohang",
  경주: "gyeongju",
  김천: "gimcheon",
  안동: "andong",
  구미: "gumi",
  영주: "yeongju",
  영천: "yeongcheon",
  상주: "sangju",
  문경: "mungyeong",
  경산: "gyeongsan",
  의성: "uiseong",
  청송: "cheongsong",
  영양: "yeongyang",
  영덕: "yeongdeok",
  청도: "cheongdo",
  고령: "goryeong",
  성주: "seongju",
  칠곡: "chilgok",
  예천: "yecheon",
  봉화: "bonghwa",
  울진: "uljin",
  울릉: "ulleung",
  포천: "pocheon",
  전주: "jeonju",
  군산: "gunsan",
  익산: "iksan",
  정읍: "jeongeup",
  남원: "namwon",
  김제: "gimje",
  완주: "wanju",
  진안: "jinan",
  무주: "muju",
  장수: "jangsu",
  임실: "imsil",
  순창: "sunchang",
  고창: "gochang",
  부안: "buan",
  천안: "cheonan",
  공주: "gongju",
  보령: "boryeong",
  아산: "asan",
  서산: "seosan",
  논산: "nonsan",
  계룡: "gyeryong",
  당진: "dangjin",
  금산: "geumsan",
  부여: "buyeo",
  서천: "seocheon",
  청양: "cheongyang",
  홍성: "hongseong",
  예산: "yesan",
  태안: "taean",
  청주: "cheongju",
  충주: "chungju",
  제천: "jecheon",
  보은: "boeun",
  옥천: "okcheon",
  영동: "yeongdong",
  증평: "jeungpyeong",
  진천: "jincheon",
  괴산: "goesan",
  음성: "eumseong",
  단양: "danyang",
  안성: "anseong",
  이천: "icheon",
  용인: "yongin",
  여주: "yeoju",
  평택: "pyeongtaek",
  화성: "hwaseong",
  오산: "osan",
  경기광주: "gwangju_gyeonggi",
  양평: "yangpyeong",
};

const provinceConfigs = [
  {
    slug: "gyeongnam",
    short: "경남",
    full: "경상남도",
    aliases: ["경남", "경상남도"],
    tourismClusters: {
      "남해안/오션뷰권": ["거제", "통영", "고성", "사천", "남해"],
      "지리산/산악권": ["산청", "함양", "하동", "거창"],
      "내륙/호수권": ["합천", "의령", "함안", "창녕"],
      "동부/부산근교권": ["김해", "양산", "밀양", "창원"],
      진주생활권: ["진주"],
    },
    regions: [
      "거제",
      "통영",
      "고성",
      "창원",
      "김해",
      "밀양",
      "양산",
      "남해",
      "사천",
      "진주",
      "산청",
      "하동",
      "함안",
      "의령",
      "창녕",
      "함양",
      "거창",
      "합천",
    ],
  },
  {
    slug: "gyeongbuk",
    short: "경북",
    full: "경상북도",
    aliases: ["경북", "경상북도"],
    tourismClusters: {
      "동해안/오션뷰권": ["포항", "경주", "영덕", "울진", "울릉"],
      "북부/백두대간권": ["안동", "영주", "문경", "봉화", "예천", "청송", "영양", "의성"],
      "중서부/내륙권": ["김천", "구미", "상주", "칠곡", "성주"],
      "남부/대구근교권": ["경산", "영천", "청도", "고령"],
    },
    regions: [
      "포항",
      "경주",
      "김천",
      "안동",
      "구미",
      "영주",
      "영천",
      "상주",
      "문경",
      "경산",
      "의성",
      "청송",
      "영양",
      "영덕",
      "청도",
      "고령",
      "성주",
      "칠곡",
      "예천",
      "봉화",
      "울진",
      "울릉",
    ],
  },
  {
    slug: "jeonbuk",
    short: "전북",
    full: "전북특별자치도",
    aliases: ["전북", "전라북도", "전북특별자치도"],
    tourismClusters: {
      "전주/완주 생활관광권": ["전주", "완주", "익산", "김제"],
      "서해안/해양권": ["군산", "부안", "고창"],
      "무주/진안/장수 산악권": ["무주", "진안", "장수"],
      "남원/임실/순창 내륙권": ["남원", "임실", "순창", "정읍"],
    },
    regions: ["전주", "군산", "익산", "정읍", "남원", "김제", "완주", "진안", "무주", "장수", "임실", "순창", "고창", "부안"],
  },
  {
    slug: "chungnam",
    short: "충남",
    full: "충청남도",
    aliases: ["충남", "충청남도"],
    tourismClusters: {
      "천안/아산 생활권": ["천안", "아산", "공주"],
      "서해안/해양권": ["태안", "보령", "서산", "당진", "서천"],
      "내륙/역사관광권": ["부여", "논산", "계룡", "금산"],
      "충남도청/예산권": ["홍성", "예산", "청양"],
    },
    regions: ["천안", "공주", "보령", "아산", "서산", "논산", "계룡", "당진", "금산", "부여", "서천", "청양", "홍성", "예산", "태안"],
  },
  {
    slug: "chungbuk",
    short: "충북",
    full: "충청북도",
    aliases: ["충북", "충청북도"],
    tourismClusters: {
      "청주/진천 생활권": ["청주", "진천", "증평", "음성"],
      "충주/제천 호수권": ["충주", "제천", "단양"],
      "속리산/남부권": ["보은", "옥천", "영동", "괴산"],
    },
    regions: ["청주", "충주", "제천", "보은", "옥천", "영동", "증평", "진천", "괴산", "음성", "단양"],
  },
  {
    slug: "gyeonggi_south",
    short: "경기남부",
    full: "경기남부",
    aliases: ["경기남부", "경기도남부", "안성이천권", "안성이천"],
    mainQuery: "안성 글램핑",
    naverQuery: "안성 글램핑",
    ddnayoQuery: "안성 글램핑",
    regionalPrefix: "",
    tourismClusters: {
      "안성/이천 핵심권": ["안성", "이천"],
      "용인/여주 흡수권": ["용인", "여주", "양평"],
      "평택/화성 생활권": ["평택", "화성", "오산"],
      "경기광주 인접권": ["경기광주"],
    },
    regions: ["안성", "이천", "용인", "여주", "평택", "화성", "오산", "경기광주", "양평"],
  },
];

function compactKeyword(value) {
  return String(value || "").replace(/\s+/g, "");
}

const LODGING_SEARCH_SUFFIXES = [
  "글램핑장",
  "오토캠핑장",
  "캠핑장",
  "야영장",
  "풀빌라",
  "카라반",
  "글램핑",
  "펜션",
  "리조트",
  "호텔",
  "모텔",
  "캠핑",
  "스테이",
  "숙소"
];

function lodgingSearchSuffix(value = "") {
  const compact = compactKeyword(value);
  return LODGING_SEARCH_SUFFIXES.find((suffix) => compact.endsWith(suffix)) || "";
}

function lodgingSearchSuffixInKeyword(value = "") {
  const compact = compactKeyword(value);
  return LODGING_SEARCH_SUFFIXES.find((suffix) => compact.includes(suffix)) || "";
}

function stripLodgingSearchSuffix(value = "") {
  const compact = compactKeyword(value);
  const suffix = lodgingSearchSuffix(compact);
  return suffix ? compact.slice(0, -suffix.length) : compact;
}

function normalizedLodgingKeyword(value = "", fallbackSuffix = "글램핑") {
  const compact = compactKeyword(value);
  if (!compact) return "";
  return lodgingSearchSuffix(compact) ? compact : `${compact}${fallbackSuffix}`;
}

function spacedLodgingKeyword(value = "", fallbackSuffix = "글램핑") {
  const normalized = normalizedLodgingKeyword(value, fallbackSuffix);
  const suffix = lodgingSearchSuffix(normalized);
  if (!normalized || !suffix) return normalized;
  const base = normalized.slice(0, -suffix.length);
  return `${base} ${suffix}`.trim();
}

function spacedGlampingKeyword(value) {
  return spacedLodgingKeyword(value, "글램핑");
}

function uniqueNonEmpty(values) {
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];
}

function compactName(value) {
  return compactKeyword(value)
    .toLowerCase()
    .replace(/[(){}\[\]<>·ㆍ._,\-–—/\\|"'`~!@#$%^&*+=:;?]/g, "");
}

function companySearchQueries(keyword) {
  const raw = String(keyword || "").trim();
  const compact = compactKeyword(raw);
  const suffix = lodgingSearchSuffixInKeyword(compact) || "글램핑";
  const hasLodging = Boolean(lodgingSearchSuffixInKeyword(compact));
  const base = stripLodgingSearchSuffix(compact);
  return uniqueNonEmpty([
    raw,
    compact,
    hasLodging ? spacedLodgingKeyword(compact, suffix) : "",
    !hasLodging ? `${raw} ${suffix}` : "",
    !hasLodging ? `${compact}${suffix}` : "",
    hasLodging && base.length >= 3 ? base : "",
  ]);
}

function companyNameMatchScore(name, keyword = RAW_KEYWORD) {
  const candidate = compactName(name);
  const target = compactName(keyword);
  if (!candidate || !target) return 0;
  if (candidate === target) return 100;
  if (target.includes(candidate) && candidate.length >= 3) return 90;

  const rawTokens = String(keyword || "")
    .trim()
    .split(/\s+/)
    .map(compactName)
    .filter((token) => token.length >= 2);
  const genericTokens = new Set(["글램핑", "카라반", "펜션", "캠핑", "캠핑장", "리조트", "스테이"]);
  const identityTokens = rawTokens.filter((token) => !genericTokens.has(token));
  if (identityTokens.length >= 2) {
    return identityTokens.every((token) => candidate.includes(token)) ? 80 : 0;
  }
  if (rawTokens.length >= 2 && identityTokens.some((token) => token.length >= 3)) {
    return rawTokens.every((token) => candidate.includes(token)) ? 80 : 0;
  }

  if (candidate.includes(target)) return 50;

  const lodgingBase = stripLodgingSearchSuffix(target);
  const lodgingSuffix = lodgingSearchSuffix(target);
  return lodgingBase.length >= 3 && candidate.includes(lodgingBase) && (!lodgingSuffix || candidate.includes(lodgingSuffix)) ? 40 : 0;
}

function companyNameMatches(name, keyword = RAW_KEYWORD) {
  return companyNameMatchScore(name, keyword) > 0;
}

function filterCompanyRows(rows, getName = (row) => row.name || row.업체명 || "") {
  if (!province.isCompany) return rows;
  const scored = rows
    .map((row) => ({ row, score: companyNameMatchScore(getName(row), RAW_KEYWORD) }))
    .filter((item) => item.score > 0);
  const strong = scored.filter((item) => item.score >= 80);
  return (strong.length ? strong : scored).map((item) => item.row);
}

function detectProvince(keyword) {
  const compact = compactKeyword(keyword);
  return provinceConfigs.find((config) => config.aliases.some((alias) => compact.startsWith(alias)));
}

function localNameFromKeyword(keyword) {
  return stripLodgingSearchSuffix(keyword) || compactKeyword(keyword);
}

function slugForRegion(region) {
  return regionSlugMap[region] || `local_${Buffer.from(region).toString("hex").slice(0, 12)}`;
}

function parentProvinceForRegion(region) {
  return provinceConfigs.find((config) => config.regions.includes(region));
}

function makeLocalConfig(keyword) {
  const localName = localNameFromKeyword(keyword);
  const parent = parentProvinceForRegion(localName);
  const isPocheon = localName === "포천";
  const isGyeonggiSouth = ["안성", "이천", "용인", "여주", "평택", "화성", "오산", "경기광주", "양평"].includes(localName);
  return {
    slug: slugForRegion(localName),
    short: localName,
    full: localName,
    aliases: [localName],
    regions: [localName],
    tourismClusters: parent?.tourismClusters || (isPocheon || isGyeonggiSouth ? { "수도권근교/자연관광권": [localName] } : { 지역형: [localName] }),
    isLocal: true,
    parentProvinceKey: isPocheon ? "gyeonggi" : parent?.slug || (isGyeonggiSouth ? "gyeonggi_south" : "local"),
  };
}

function makeCompanyConfig(keyword) {
  const companyName = String(keyword || "").trim() || "업체명";
  const compact = compactKeyword(companyName);
  return {
    slug: `company_${Buffer.from(compact || companyName).toString("hex").slice(0, 16)}`,
    short: companyName,
    full: companyName,
    aliases: [companyName],
    regions: [],
    tourismClusters: { 업체명검색: [companyName] },
    isCompany: true,
    isLocal: false,
    parentProvinceKey: "local",
  };
}

const province = SEARCH_MODE === "company" ? makeCompanyConfig(RAW_KEYWORD) : (detectProvince(RAW_KEYWORD) || makeLocalConfig(RAW_KEYWORD));
const RAW_KEYWORD_SUFFIX = lodgingSearchSuffixInKeyword(RAW_KEYWORD) || "글램핑";
const LEGACY_QUERY = province.mainQuery || (province.isCompany ? RAW_KEYWORD.trim() : (province.isLocal ? spacedLodgingKeyword(RAW_KEYWORD, RAW_KEYWORD_SUFFIX) : `${province.short} ${RAW_KEYWORD_SUFFIX}`));
const QUERY = HAS_COLLECTION_SEARCH_CONTEXT ? COLLECTION_SEARCH_CONTEXT.primaryQuery : LEGACY_QUERY;
const NAVER_QUERY = HAS_COLLECTION_SEARCH_CONTEXT
  ? (COLLECTION_SEARCH_CONTEXT.platformQueries.naver[0] || QUERY)
  : (province.naverQuery || (province.isCompany ? QUERY : (province.isLocal ? QUERY : `${province.full} ${RAW_KEYWORD_SUFFIX}`)));
const DDNAYO_QUERY_EXACT = HAS_COLLECTION_SEARCH_CONTEXT
  ? COLLECTION_SEARCH_CONTEXT.platformQueries.ddnayo.exact
  : (province.ddnayoQuery || (province.isCompany ? QUERY : spacedLodgingKeyword(RAW_KEYWORD, RAW_KEYWORD_SUFFIX)));
const DDNAYO_QUERY_NORMALIZED = HAS_COLLECTION_SEARCH_CONTEXT
  ? COLLECTION_SEARCH_CONTEXT.platformQueries.ddnayo.normalized
  : compactKeyword(province.ddnayoQuery || (province.isCompany ? QUERY : normalizedLodgingKeyword(RAW_KEYWORD, RAW_KEYWORD_SUFFIX)));
const RUN_DATE = CHECK_IN.replaceAll("-", "");
const RUN_TIME = new Date().toLocaleTimeString("en-GB", { timeZone: "Asia/Seoul", hour12: false }).replaceAll(":", "");
const RUN_STAMP = process.env.RUN_STAMP || `${RUN_DATE}_${RUN_TIME}`;
const OUTPUT_ROOT = process.env.OUTPUTS_DIR || process.env.DATA_DIR || "outputs";
const OUTPUT_DIR = path.resolve(OUTPUT_ROOT, `${province.slug}_glamping_${RUN_STAMP}`);
const DETAIL_JSON_DIR_NAME = "details";
const DETAIL_JSON_INLINE_LIMIT = 28000;
const detailJsonFiles = [];
const REGIONAL_LIMIT = Number(process.env.REGIONAL_LIMIT || 10);
const REGIONAL_SEARCH_CONCURRENCY = boundedInteger(process.env.REGIONAL_SEARCH_CONCURRENCY, 4, 1, 8);
const NAVER_BOOKING_STOCK_LIMIT = Number(process.env.NAVER_BOOKING_STOCK_LIMIT || 20);
const NAVER_BOOKING_DETAIL_CONCURRENCY = boundedInteger(process.env.NAVER_BOOKING_DETAIL_CONCURRENCY, 2, 1, 4);
const NAVER_SCHEDULE_CONCURRENCY = boundedInteger(process.env.NAVER_SCHEDULE_CONCURRENCY, 4, 1, 8);
const NAVER_SCHEDULE_DELAY_MS = boundedInteger(process.env.NAVER_SCHEDULE_DELAY_MS, 35, 0, 500);
const NAVER_BOOKING_GRAPHQL_URL = "https://m.booking.naver.com/graphql";
const NAVER_BOOKING_ID_FALLBACK = String(process.env.NAVER_BOOKING_ID_FALLBACK || "1") !== "0";
const NAVER_COUPON_PAGE_FALLBACK = String(process.env.NAVER_COUPON_PAGE_FALLBACK || "1") !== "0";

const headers = {
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36",
  "accept-language": "ko-KR,ko;q=0.9",
};

const regions = province.regions;

function csvEscape(value) {
  if (value === null || value === undefined) return "";
  const s = String(value);
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

async function writeCsv(filePath, rows, columns) {
  const lines = [
    columns.join(","),
    ...rows.map((row) => columns.map((column) => csvEscape(row[column])).join(",")),
  ];
  await fs.writeFile(filePath, `\uFEFF${lines.join("\n")}`, "utf8");
}

function parseCsvLine(line) {
  const values = [];
  let current = "";
  let inQuotes = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') {
      if (inQuotes && line[index + 1] === '"') {
        current += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === "," && !inQuotes) {
      values.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  values.push(current);
  return values;
}

function parseCsvRows(text) {
  const lines = String(text || "")
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .filter((line) => line.trim());
  if (!lines.length) return [];
  const headers = parseCsvLine(lines[0]);
  return lines.slice(1).map((line) => {
    const values = parseCsvLine(line);
    return Object.fromEntries(headers.map((header, index) => [header, values[index] || ""]));
  });
}

let historicalNaverBookingBusinessMap = null;

async function loadHistoricalNaverBookingBusinessMap() {
  if (historicalNaverBookingBusinessMap) return historicalNaverBookingBusinessMap;
  const map = new Map();
  if (!NAVER_BOOKING_ID_FALLBACK) {
    historicalNaverBookingBusinessMap = map;
    return map;
  }

  const root = path.resolve(OUTPUT_ROOT);
  let directories = [];
  try {
    directories = await fs.readdir(root, { withFileTypes: true });
  } catch {
    historicalNaverBookingBusinessMap = map;
    return map;
  }

  for (const directory of directories) {
    if (!directory.isDirectory()) continue;
    const dirPath = path.join(root, directory.name);
    let files = [];
    try {
      files = await fs.readdir(dirPath);
    } catch {
      continue;
    }
    const overallFile = files.find((file) => file.endsWith("_네이버전체순위.csv"));
    if (!overallFile) continue;
    let rows = [];
    try {
      rows = parseCsvRows(await fs.readFile(path.join(dirPath, overallFile), "utf8"));
    } catch {
      continue;
    }
    for (const row of rows) {
      const placeId = String(row.place_id || "").trim();
      const bookingBusinessId = String(row.네이버예약사업자ID || "").trim();
      if (!placeId || !bookingBusinessId) continue;
      map.set(placeId, {
        bookingBusinessId,
        bookingUrl: row.네이버예약URL || `https://m.booking.naver.com/booking/3/bizes/${bookingBusinessId}/search`,
        source: "historical",
        sourceRun: directory.name,
      });
    }
  }

  historicalNaverBookingBusinessMap = map;
  return map;
}

async function getHistoricalNaverBookingBusiness(placeId) {
  const map = await loadHistoricalNaverBookingBusinessMap();
  return map.get(String(placeId || "")) || null;
}

async function fetchText(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: { ...headers, ...(options.headers || {}) },
  });
  const text = await res.text();
  return { res, text };
}

async function fetchJson(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: { ...headers, ...(options.headers || {}) },
  });
  const text = await res.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = { parseError: true, text };
  }
  return { res, data, text };
}

function pickNaverAdKey(state, query, businessTypes = ["accommodation"]) {
  const keys = Object.keys(state.ROOT_QUERY || {});
  return keys.find((key) => {
    if (!key.startsWith("adBusinesses(")) return false;
    if (key.includes('"channel":"openingPlace"')) return false;
    const parsed = parseRootKey(key)?.args;
    return parsed?.input?.query === query && businessTypes.includes(parsed?.input?.businessType);
  });
}

function asNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(String(value).replace(/[^0-9.-]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function formatWon(value) {
  const n = asNumber(value);
  if (n === null) return "";
  return `${n.toLocaleString("ko-KR")}원`;
}

function extractLocationCluster(address) {
  const text = String(address || "");
  return regions.find((region) => text.includes(region)) || "";
}

function tourismCluster(locationCluster) {
  for (const [cluster, members] of Object.entries(province.tourismClusters || {})) {
    if (members.includes(locationCluster)) return cluster;
  }
  return locationCluster ? "기타/인접권" : "";
}

function productTypeCluster(row) {
  const text = [
    row.업체명,
    row.name,
    row.카테고리,
    row.category,
    row["객실명(일부)"],
    row.특장점,
  ]
    .filter(Boolean)
    .join(" ");
  if (/키즈|가족/.test(text)) return "키즈/가족형";
  if (/반려|애견|펫/.test(text)) return "반려견 동반형";
  if (/풀빌라|리조트/.test(text)) return "풀빌라/리조트형";
  if (/카라반/.test(text)) return "카라반";
  if (/펜션/.test(text) && /글램핑/.test(text)) return "펜션형 글램핑";
  if (/펜션/.test(text)) return "펜션형";
  if (/캠핑장|오토캠핑|캠핑/.test(text) && !/글램핑/.test(text)) return "캠핑장";
  if (/글램핑/.test(text)) return "글램핑";
  return "확인필요";
}

function isRelevantOtaAccommodation(row) {
  const text = [
    row.name,
    row.category,
    row.location,
    row["상품유형클러스터"],
  ]
    .filter(Boolean)
    .join(" ");
  const hasOutdoorSignal = /글램핑|카라반|캠핑|오토캠핑|야영|펜션|풀빌라|리조트|스테이|camp|glamp/i.test(text);
  const hasHotelOnlySignal = /모텔|호텔|비즈니스호텔|레지던스호텔/i.test(text);
  return hasOutdoorSignal || !hasHotelOnlySignal;
}

function lodgingRelevanceInput(row = {}) {
  return {
    ...row,
    name: row.name || row["\uC5C5\uCCB4\uBA85"] || "",
    category: row.category || row["\uCE74\uD14C\uACE0\uB9AC"] || "",
    location: row.location || row["\uC8FC\uC18C"] || "",
    roomName: row.roomName || row["\uAC1D\uC2E4\uBA85(\uC77C\uBD80)"] || "",
    description: row.description || row["\uD2B9\uC9D5"] || ""
  };
}

function decorateCollectionRow(row = {}, sourceQuery = QUERY) {
  const decorated = decorateLodgingResult(lodgingRelevanceInput(row), COLLECTION_SEARCH_CONTEXT, sourceQuery);
  return {
    ...decorated,
    detectedLodgingCategoryTags: JSON.stringify(decorated.detectedLodgingCategoryTags || []),
    categoryEvidence: JSON.stringify(decorated.categoryEvidence || [])
  };
}

function filterCollectionRows(rows = [], sourceQuery = QUERY, options = {}) {
  if (!HAS_COLLECTION_SEARCH_CONTEXT) {
    return options.legacyOtaFilter ? rows.filter(isRelevantOtaAccommodation) : rows;
  }
  return rows
    .map((row) => decorateCollectionRow(row, sourceQuery))
    .filter((row) => evaluateLodgingRelevance(row, COLLECTION_SEARCH_CONTEXT).relevant);
}

function priceCluster(row) {
  const price = row.금액 ?? row.price ?? "";
  const minPrice = asNumber(String(price).split("~")[0]);
  if (minPrice === null) return "확인불가";
  if (minPrice < 100000) return "저가형";
  if (minPrice < 200000) return "중가형";
  if (minPrice < 350000) return "고가형";
  return "프리미엄";
}

function addClusterFields(row, options = {}) {
  const address = row.주소 ?? row.location ?? "";
  const locationCluster = extractLocationCluster(address);
  const searchKeyword = row.검색키워드 || row.query || options.searchKeyword || QUERY;
  const searchCluster =
    row.지역 ||
    options.searchCluster ||
    extractLocationCluster(searchKeyword) ||
    (searchKeyword.includes(province.full) || searchKeyword.includes(province.short) ? province.short : "");

  row.기준키워드 = RAW_KEYWORD;
  row.검색키워드 = searchKeyword;
  row.검색클러스터 = searchCluster;
  row.소재지클러스터 = locationCluster;
  row.관광권역클러스터 = tourismCluster(locationCluster);
  row.상품유형클러스터 = productTypeCluster(row);
  row.가격대클러스터 = priceCluster(row);
  if (!row.광고집행클러스터) row.광고집행클러스터 = options.adCluster || "확인불가";
  return row;
}

function applyNaverAdClusters(naver, regionalRows) {
  const adNames = new Set(naver.ads.map((row) => row.업체명).filter(Boolean));
  const adIds = new Set(naver.ads.map((row) => row.place_id).filter(Boolean));
  const overallNames = new Set(naver.overall.map((row) => row.업체명).filter(Boolean));
  const overallIds = new Set(naver.overall.map((row) => row.place_id).filter(Boolean));

  for (const row of naver.overall) {
    const inAd = adNames.has(row.업체명) || adIds.has(row.place_id);
    row.광고집행클러스터 = inAd ? "광고+비광고 동시 노출" : "비광고 상위 노출";
    addClusterFields(row, { searchKeyword: NAVER_QUERY, searchCluster: province.short });
  }

  for (const row of naver.ads) {
    const inOverall = overallNames.has(row.업체명) || overallIds.has(row.place_id);
    row.광고집행클러스터 = inOverall ? "광고+비광고 동시 노출" : "광고 집행";
    addClusterFields(row, { searchKeyword: NAVER_QUERY, searchCluster: province.short });
  }

  for (const row of regionalRows) {
    const inAd = adNames.has(row.업체명) || adIds.has(row.place_id);
    row.광고집행클러스터 = inAd ? "광고+비광고 동시 노출" : "비광고 상위 노출";
    addClusterFields(row, { searchKeyword: row.검색키워드, searchCluster: row.지역 });
  }
}

function priceFromRooms(state, item) {
  const rooms = (item.roomImages || []).map((ref) => state[ref.__ref]).filter(Boolean);
  const mins = rooms.map((room) => asNumber(room.minPrice)).filter((n) => n !== null);
  const maxes = rooms.map((room) => asNumber(room.maxPrice)).filter((n) => n !== null);
  if (mins.length === 0 && item.matchRoomMinPrice) return `${formatWon(item.matchRoomMinPrice)}~`;
  if (mins.length === 0) return "";
  const min = Math.min(...mins);
  const max = maxes.length ? Math.max(...maxes) : min;
  if (min === max) return formatWon(min);
  return `${formatWon(min).replace("원", "")}~${formatWon(max)}`;
}

function roomNamesFromItem(state, item) {
  return (item.roomImages || [])
    .map((ref) => state[ref.__ref]?.name)
    .filter(Boolean)
    .slice(0, 4)
    .join(", ");
}

function mapNaverItem(state, item, extras = {}) {
  return {
    ...extras,
    place_id: item.id || "",
    업체명: item.name || "",
    카테고리: item.category || "",
    주소: naverPlaceAddress(item),
    "객실수(노출)": (item.roomImages || []).length,
    "객실명(일부)": roomNamesFromItem(state, item),
    금액: priceFromRooms(state, item),
    특장점: item.microReview || item.promotionTitle || item.adDescription || "",
    총리뷰: item.totalReviewCount || item.blogCafeReviewCount || "",
    방문자리뷰: item.placeReviewCount ?? "",
    평점: item.placeReviewScore ?? "",
    예약: item.hasBooking ? "Y" : "N",
    url: item.id ? `https://pcmap.place.naver.com/accommodation/${item.id}` : "",
  };
}

async function getNaverState(query) {
  const url = `https://pcmap.place.naver.com/accommodation/list?query=${encodeURIComponent(query)}`;
  const { res, text } = await fetchText(url);
  if (res.status === 403 || res.status === 429 || looksLikeAccessBlock(text)) {
    throw createCrawlFailure("NAVER_ACCESS_BLOCKED");
  }
  if (!res.ok) {
    throw createCrawlFailure(res.status >= 500 ? "NAVER_TEMPORARY_UNAVAILABLE" : "NAVER_HTTP_ERROR");
  }
  const state = extractApolloState(text);
  return { status: res.status, state, url };
}

const naverBookingBusinessQuery = `
  query naverBookingBusiness($id: String!, $isNx: Boolean) {
    business: placeDetail(input: { id: $id, isNx: $isNx, deviceType: "mobile" }) {
      base {
        id
        name
      }
      naverBooking {
        bookingBusinessId
        naverBookingUrl
        naverBookingHubUrl
      }
    }
  }
`;

const naverSearchBizItemQuery = `
  query searchBizItem($bizItemSearchParams: BizItemSearchParams) {
    searchBizItem(input: $bizItemSearchParams) {
      id
      bizItems {
        id
        businessId
        bizItemId
        bizItemType
        bizItemSubType
        name
        isClosedBooking
        isClosedBookingUser
        isImp
        price
        minBookingCount
        maxBookingCount
        bookableSettingJson
        bookingCountSettingJson
        priceByDates
        minMaxPrice {
          minPrice
          maxPrice
          isSinglePrice
        }
        typeValues {
          bizItemId
          code
          codeValue
        }
      }
    }
  }
`;

const naverDailyScheduleQuery = `
  query dailySchedule($scheduleParams: ScheduleParams) {
    schedule(input: $scheduleParams) {
      bizItemSchedule {
        daily {
          date
        }
      }
    }
  }
`;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function mapWithConcurrency(items, limit, mapper) {
  const rows = Array.from(items || []);
  const results = new Array(rows.length);
  const workerCount = Math.max(1, Math.min(Math.round(limit) || 1, rows.length || 1));
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < rows.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(rows[index], index);
    }
  }
  await Promise.all(Array.from({ length: workerCount }, worker));
  return results;
}

async function getNaverBookingBusiness(placeId) {
  if (!placeId) return null;
  const endpoint = "https://pcmap-api.place.naver.com/graphql";
  let lastResult = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (attempt) await delay(450);
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        ...headers,
        accept: "*/*",
        "content-type": "application/json",
        origin: "https://pcmap.place.naver.com",
        referer: `https://pcmap.place.naver.com/accommodation/${placeId}`,
      },
      body: JSON.stringify({
        operationName: "naverBookingBusiness",
        query: naverBookingBusinessQuery,
        variables: { id: String(placeId), isNx: false },
      }),
    });
    const text = await response.text();
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
    const isCaptcha = /captcha|WtmCaptcha|ncpt\.naver\.com/i.test(text);
    const booking = data?.data?.business?.naverBooking || {};
    lastResult = {
      bookingBusinessId: booking.bookingBusinessId || "",
      bookingUrl: booking.naverBookingUrl || booking.naverBookingHubUrl || "",
      status: response.status,
      blocked: isCaptcha || response.status === 405 || response.status === 429,
      errors: data?.errors || null,
    };
    if (lastResult.bookingBusinessId || !lastResult.blocked) break;
  }
  return lastResult;
}

function extractNaverBookingBusinessIds(text) {
  const raw = String(text || "");
  const normalized = raw
    .replace(/\\u002[fF]/g, "/")
    .replace(/\\\//g, "/");
  const ids = new Set();
  for (const source of [raw, normalized]) {
    for (const pattern of [
      /booking\/3\/bizes\/(\d+)/g,
      /bookingBusinessId["'\\]*\s*[:=]\s*["'\\]*(\d+)/g,
      /naverBooking(?:Url|HubUrl)[\s\S]{0,500}?bizes\/(\d+)/g,
    ]) {
      let match = null;
      while ((match = pattern.exec(source))) {
        if (match[1]) ids.add(match[1]);
      }
    }
  }
  return Array.from(ids);
}

async function getNaverBookingBusinessFromPlacePage(placeId) {
  if (!placeId || !NAVER_BOOKING_ID_FALLBACK) return null;
  const routes = [
    { label: "pc", url: `https://pcmap.place.naver.com/accommodation/${placeId}` },
    { label: "pc/room", url: `https://pcmap.place.naver.com/accommodation/${placeId}/room` },
    { label: "m/home", url: `https://m.place.naver.com/accommodation/${placeId}/home` },
    { label: "m/room", url: `https://m.place.naver.com/accommodation/${placeId}/room` },
  ];

  for (const route of routes) {
    try {
      const { res, text } = await fetchText(route.url, {
        headers: {
          accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          referer: `https://pcmap.place.naver.com/accommodation/${placeId}`,
        },
      });
      const bookingBusinessId = extractNaverBookingBusinessIds(text)[0] || "";
      if (bookingBusinessId) {
        return {
          bookingBusinessId,
          bookingUrl: `https://m.booking.naver.com/booking/3/bizes/${bookingBusinessId}/search`,
          status: res.status,
          blocked: false,
          errors: null,
          source: "place_html",
          sourceRoute: route.label,
        };
      }
    } catch {
      // Keep the fallback best-effort. The original GraphQL status remains authoritative.
    }
    await delay(120);
  }
  return null;
}

async function postNaverBookingGraphql(operationName, query, variables, businessId, date = CHECK_IN) {
  const checkOut = addDays(date, 1);
  const response = await fetch(NAVER_BOOKING_GRAPHQL_URL, {
    method: "POST",
    headers: {
      ...headers,
      accept: "*/*",
      "content-type": "application/json",
      origin: "https://m.booking.naver.com",
      referer: `https://m.booking.naver.com/booking/3/bizes/${businessId}/search?startDate=${date}&endDate=${checkOut}&adult=${ADULTS}`,
    },
    body: JSON.stringify({ operationName, query, variables }),
  });
  const data = await response.json().catch(() => null);
  return { status: response.status, data };
}

async function getNaverBookingItems(bookingBusinessId) {
  const result = await postNaverBookingGraphql(
    "searchBizItem",
    naverSearchBizItemQuery,
    { bizItemSearchParams: { businessId: String(bookingBusinessId) } },
    bookingBusinessId,
  );
  return {
    status: result.status,
    items: result.data?.data?.searchBizItem?.bizItems || [],
    errors: result.data?.errors || null,
  };
}

async function getNaverDailySchedule(bookingBusinessId, bizItemId, date = CHECK_IN) {
  const scheduleParams = {
    businessId: String(bookingBusinessId),
    businessTypeId: 3,
    startDateTime: `${date}T00:00:00`,
    endDateTime: `${date}T00:00:00`,
    bizItemId: String(bizItemId),
  };
  const result = await postNaverBookingGraphql(
    "dailySchedule",
    naverDailyScheduleQuery,
    { scheduleParams },
    bookingBusinessId,
    date,
  );
  return {
    status: result.status,
    day: result.data?.data?.schedule?.bizItemSchedule?.daily?.date?.[date] || null,
    errors: result.data?.errors || null,
  };
}

function asStockNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function naverBookingSaleType(item) {
  const subtype = String(item?.bizItemSubType || "").toUpperCase();
  const name = String(item?.name || "");
  if (
    subtype === "ACCOMMODATION_DAY_USE" ||
    subtype.includes("DAY_USE") ||
    subtype.includes("CAMPNIC") ||
    subtype.includes("CAMP_NIC") ||
    /데이유즈|캠프닉|캠핑닉|피크닉|대실|당일|day\s*use/i.test(name)
  ) return "데이유즈";
  if (subtype === "ACCOMMODATION_NIGHT" || /숙박|1박|글램핑|카라반|펜션|풀빌라/i.test(name)) return "숙박";
  return "미분류";
}

const COUPON_SIGNAL_PATTERN = /coupon|benefit|promotion|discount|쿠폰|혜택|할인|프로모션|즉시할인/i;
const COUPON_NEGATIVE_PATTERN = /쿠폰\s*(없음|미제공|사용\s*불가|불가)|혜택\s*(없음|미제공)|할인\s*(없음|미제공|불가)/i;
const COUPON_GENERIC_PATTERN = /^(coupon|coupons|benefit|benefits|promotion|promotions|discount|discounts|쿠폰|쿠폰\s*(받기|다운로드|적용|적용시|사용|정보|안내|혜택|노출|확인)?|혜택|할인|프로모션|즉시할인|네이버|네이버\s*상품|네이버\s*쿠폰|네이버\s*예약\s*쿠폰|네이버\s*예약페이지|상품|일정|숙박상품|데이유즈상품|숙박일정|데이유즈일정|예약페이지)$/i;

function parseJsonLike(value) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!/^[\[{]/.test(text)) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function decodeCouponText(value) {
  return String(value || "")
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, code) => String.fromCharCode(parseInt(code, 16)))
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

function normalizeCouponText(value) {
  const text = decodeCouponText(value)
    .replace(/<[^>]+>/g, " ")
    .replace(/["'`]/g, "")
    .replace(/[\[\]{}()<>]/g, " ")
    .replace(/\b(__typename|graphql|apollo|webpack|script|stylesheet|bookingBusinessId|bizItemId)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text || text.length < 2 || text.length > 80) return "";
  if (/^(있음|없음|확인불가|Y|N|true|false)$/i.test(text)) return "";
  if (COUPON_NEGATIVE_PATTERN.test(text)) return "";
  if (COUPON_GENERIC_PATTERN.test(text)) return "";
  if (/^[\d,\s원%~.-]+$/.test(text)) return "";
  if (/^[A-Za-z0-9_.$:/?\-=#&]+$/.test(text)) return "";
  if (/[{}\[\];=]/.test(text) && !/[가-힣]/.test(text)) return "";
  return text;
}

function couponTextFragments(text) {
  const source = decodeCouponText(text).replace(/\s+/g, " ").trim();
  if (!source) return [];
  const simpleParts = source.length <= 600
    ? source.split(/\s*(?:,|\/|\||·|ㆍ|\n|\r)\s*/).map(normalizeCouponText).filter(Boolean)
    : [];
  const windowMatches = Array.from(source.matchAll(/.{0,28}(?:쿠폰|혜택|할인|프로모션|즉시할인|coupon|benefit|promotion|discount).{0,42}/gi))
    .map((match) => normalizeCouponText(match[0]))
    .filter(Boolean);
  return uniqueNonEmpty([...simpleParts, ...windowMatches]).slice(0, 5);
}

function collectCouponTexts(value, path = [], depth = 0, output = []) {
  if (depth > 5 || value === null || value === undefined) return output;
  const pathText = path.join(".");
  const keyHit = COUPON_SIGNAL_PATTERN.test(pathText);
  if (typeof value === "string") {
    const parsed = parseJsonLike(value);
    if (parsed) {
      collectCouponTexts(parsed, path, depth + 1, output);
      return output;
    }
    const textHit = COUPON_SIGNAL_PATTERN.test(value);
    if (keyHit || textHit) {
      const fragments = couponTextFragments(value);
      if (fragments.length) output.push(...fragments);
      else {
        const normalized = normalizeCouponText(value);
        if (normalized) output.push(normalized);
      }
    }
    return output;
  }
  if (typeof value !== "object") return output;
  if (Array.isArray(value)) {
    value.slice(0, 30).forEach((item, index) => collectCouponTexts(item, [...path, String(index)], depth + 1, output));
    return output;
  }
  Object.entries(value).slice(0, 80).forEach(([key, child]) => {
    collectCouponTexts(child, [...path, key], depth + 1, output);
  });
  return output;
}

function hasCouponPresenceSignal(value, path = [], depth = 0) {
  if (depth > 5 || value === null || value === undefined) return false;
  const pathText = path.join(".");
  const keyHit = COUPON_SIGNAL_PATTERN.test(pathText);
  if (typeof value === "boolean") return keyHit && value === true;
  if (typeof value === "string") {
    const parsed = parseJsonLike(value);
    if (parsed) return hasCouponPresenceSignal(parsed, path, depth + 1);
    const text = decodeCouponText(value).replace(/\s+/g, " ").trim();
    if (!text || /^(없음|미제공|사용\s*불가|불가|N|false)$/i.test(text)) return false;
    if (COUPON_NEGATIVE_PATTERN.test(text)) return false;
    return Boolean(keyHit || COUPON_SIGNAL_PATTERN.test(text));
  }
  if (typeof value !== "object") return false;
  if (Array.isArray(value)) {
    return value.slice(0, 30).some((item, index) => hasCouponPresenceSignal(item, [...path, String(index)], depth + 1));
  }
  return Object.entries(value).slice(0, 80).some(([key, child]) => hasCouponPresenceSignal(child, [...path, key], depth + 1));
}

function couponSource(label, value) {
  return { __couponSource: true, label, value };
}

function splitCouponNames(value) {
  return uniqueNonEmpty(String(value || "")
    .split(/\s*(?:·|ㆍ|\||,|\n|\r)\s*/)
    .map(normalizeCouponText)
    .filter(Boolean));
}

function summarizeNaverCouponExposure(sources = []) {
  const records = [];
  const presenceLabels = [];
  for (const source of sources) {
    const label = source && source.__couponSource ? String(source.label || "").trim() : "";
    const value = source && source.__couponSource ? source.value : source;
    if (hasCouponPresenceSignal(value) && label) presenceLabels.push(label);
    for (const text of collectCouponTexts(value)) {
      records.push({ text, label });
    }
  }
  const names = uniqueNonEmpty(records.map((record) => record.text)).slice(0, 5);
  const labels = uniqueNonEmpty(records
    .filter((record) => names.includes(record.text))
    .map((record) => record.label)
    .filter(Boolean))
    .slice(0, 4);
  const signalLabels = uniqueNonEmpty([...labels, ...presenceLabels]).slice(0, 4);
  const visible = Boolean(names.length || signalLabels.length);
  return {
    couponStatus: visible ? "있음" : "없음",
    couponNames: names.join(" · "),
    couponChannel: signalLabels.length ? `네이버(${signalLabels.join(", ")})` : "네이버",
    couponDetail: names.length
      ? `네이버 공개 노출 쿠폰 ${names.length}건${signalLabels.length ? ` · 근거 ${signalLabels.join(", ")}` : ""}`
      : (visible
        ? `네이버 쿠폰 노출 신호 확인 · 쿠폰명 미확인${signalLabels.length ? ` · 근거 ${signalLabels.join(", ")}` : ""}`
        : "네이버 공개 노출 쿠폰 없음"),
  };
}

function mergeNaverCouponSignals(signals = []) {
  const validSignals = signals.filter(Boolean);
  const names = uniqueNonEmpty(validSignals.flatMap((signal) => splitCouponNames(signal.couponNames))).slice(0, 5);
  const channels = uniqueNonEmpty(validSignals.map((signal) => normalizeCouponText(signal.couponChannel)).filter(Boolean)).slice(0, 4);
  const visible = names.length || validSignals.some((signal) => String(signal.couponStatus || "").trim() === "있음");
  const details = uniqueNonEmpty(validSignals.map((signal) => normalizeCouponText(signal.couponDetail)).filter(Boolean)).slice(0, 3);
  return {
    couponStatus: visible ? "있음" : "없음",
    couponNames: names.join(" · "),
    couponChannel: channels.join(" · ") || "네이버",
    couponDetail: visible
      ? (details.join(" · ") || `네이버 공개 노출 쿠폰 ${names.length || 1}건`)
      : (details.join(" · ") || "네이버 공개 노출 쿠폰 없음"),
  };
}

function naverBookingSearchUrl(bookingBusinessId, bookingUrl = "", date = CHECK_IN) {
  const checkOut = addDays(date, 1);
  const fallback = `https://m.booking.naver.com/booking/3/bizes/${bookingBusinessId}/search`;
  let url = null;
  try {
    url = new URL(/^https?:\/\//i.test(String(bookingUrl || "")) ? bookingUrl : fallback);
  } catch {
    url = new URL(fallback);
  }
  if (!/\/search(?:\/)?$/i.test(url.pathname)) {
    url = new URL(fallback);
  }
  url.searchParams.set("startDate", date);
  url.searchParams.set("endDate", checkOut);
  url.searchParams.set("adult", String(ADULTS));
  return url.toString();
}

async function getNaverBookingPageCouponSignal(bookingBusinessId, bookingUrl = "", date = CHECK_IN) {
  if (!NAVER_COUPON_PAGE_FALLBACK || !bookingBusinessId) return null;
  const url = naverBookingSearchUrl(bookingBusinessId, bookingUrl, date);
  try {
    const { res, text } = await fetchText(url, {
      headers: {
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        referer: url,
      },
    });
    const signal = summarizeNaverCouponExposure([couponSource("예약페이지", text)]);
    const hasPageCouponName = Boolean(signal.couponNames);
    return {
      ...signal,
      couponStatus: hasPageCouponName ? "있음" : "없음",
      couponChannel: hasPageCouponName ? signal.couponChannel : "네이버 예약페이지",
      couponDetail: hasPageCouponName
        ? `${signal.couponDetail} · 예약페이지 ${res.status}`
        : `예약페이지 보조 확인(${res.status}) · 쿠폰명 미노출`,
    };
  } catch (error) {
    return {
      couponStatus: "없음",
      couponNames: "",
      couponChannel: "네이버 예약페이지",
      couponDetail: `예약페이지 쿠폰 보조 확인 실패(${String(error?.message || error).slice(0, 60)})`,
    };
  }
}

function naverGroupedRoomCount(value) {
  const text = String(value || "");
  const match = text.match(/(?:^|[^0-9])(?:[A-Za-z가-힣]+[_-]?)?(\d+)\s*[~～-]\s*(\d+)(?:[^0-9]|$)/);
  if (!match) return 0;
  const start = Number(match[1]);
  const end = Number(match[2]);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return 0;
  return end - start + 1;
}

function classifyNaverBookingList(items, schedules) {
  const totalStock = schedules.reduce((sum, item) => sum + Math.max(0, asStockNumber(item.stock) || 0), 0);
  const names = items.map((item) => String(item.name || ""));
  const unitNameCount = names.filter((name) => /\d+\s*(호|번|동)|[A-Z]-?\d+/i.test(name)).length;
  if (names.some((name) => naverGroupedRoomCount(name) > 1)) return "객실 묶음 상품리스트";
  if (totalStock > items.length) return "객실 종류별 리스트";
  if (unitNameCount >= Math.max(1, Math.ceil(items.length * 0.4))) return "객실별 예약리스트";
  if (schedules.length && schedules.every((item) => (asStockNumber(item.stock) || 0) <= 1)) return "객실별 예약리스트";
  return "객실 종류별 리스트";
}

function scheduleQuantityProfile(schedule, listType) {
  const stock = asStockNumber(schedule.stock);
  const bookingCount = Math.max(0, asStockNumber(schedule.bookingCount) || 0);
  const occupiedBookingCount = Math.max(0, asStockNumber(schedule.occupiedBookingCount) || 0);
  const usedCount = bookingCount + occupiedBookingCount;
  const price = asStockNumber(schedule.price);
  const open = schedule.isBusinessDay !== false && schedule.isSaleDay !== false;
  const groupedProductList = listType === "객실 묶음 상품리스트";
  let total = 1;
  let available = 0;

  if (listType === "객실별 예약리스트") {
    total = 1;
    available = stock === null
      ? (open && price !== null ? 1 : 0)
      : (open && Math.max(0, stock - usedCount) > 0 ? 1 : 0);
  } else if (groupedProductList && stock === null) {
    total = 1;
    available = open && price !== null ? 1 : 0;
  } else if (stock !== null && stock >= 0) {
    total = stock;
    available = Math.max(0, stock - usedCount);
  } else {
    total = 1;
    available = open && price !== null ? 1 : 0;
  }

  const soldOut = Math.max(0, total - available);
  return {
    total,
    available,
    soldOut,
    price,
    open
  };
}

function scheduleProductKey(schedule) {
  const id = String(schedule?.bizItemId || "").trim();
  if (id) return `id:${id}`;
  return `name:${String(schedule?.name || "상품").trim().replace(/\s+/g, " ")}`;
}

function scheduleProductLabel(schedule) {
  const text = String(schedule?.name || "상품").trim().replace(/\s+/g, " ");
  return text.length > 22 ? `${text.slice(0, 22)}...` : text;
}

function compactNaverScheduleDetail(schedule, listType = "", date = CHECK_IN, availabilityUnit = "") {
  const quantity = scheduleQuantityProfile(schedule, listType);
  return {
    date,
    key: scheduleProductKey(schedule),
    bizItemId: schedule.bizItemId || "",
    name: String(schedule.name || "").trim(),
    saleType: schedule.saleType || "",
    bizItemSubType: schedule.bizItemSubType || "",
    listType,
    availabilityUnit,
    total: quantity.total,
    available: quantity.available,
    soldOut: quantity.soldOut,
    stock: schedule.stock,
    bookingCount: schedule.bookingCount,
    occupiedBookingCount: schedule.occupiedBookingCount,
    price: quantity.price,
    open: quantity.open,
    couponStatus: schedule.couponStatus || "",
    couponNames: schedule.couponNames || ""
  };
}

async function jsonCell(value, meta = {}) {
  if (!value || (Array.isArray(value) && !value.length)) return "";
  const jsonText = JSON.stringify(value);
  if (jsonText.length <= DETAIL_JSON_INLINE_LIMIT) return jsonText;
  const relativePath = detailJsonRelativePath(meta, jsonText);
  const filePath = path.join(OUTPUT_DIR, ...relativePath.split("/"));
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(value, null, 2), "utf8");
  detailJsonFiles.push({
    field: meta.field || "",
    name: meta.name || "",
    placeId: meta.placeId || "",
    bookingBusinessId: meta.bookingBusinessId || "",
    file: relativePath,
    itemCount: Array.isArray(value) ? value.length : 1,
    originalLength: jsonText.length
  });
  return `@json-file:${relativePath}`;
}

function revenueProjectionFields(estimatedRevenue = 0, pricedSoldOut = 0, missingPriceSoldOut = 0) {
  const revenue = Math.max(0, Number(estimatedRevenue) || 0);
  const priced = Math.max(0, Number(pricedSoldOut) || 0);
  const missing = Math.max(0, Number(missingPriceSoldOut) || 0);
  const avg = priced ? Math.round(revenue / priced) : null;
  const missingPriceEstimatedRevenue = avg && missing ? missing * avg : 0;
  const adjustedEstimatedRevenue = revenue + missingPriceEstimatedRevenue;
  const sold = priced + missing;
  return {
    adjustedEstimatedRevenue,
    missingPriceEstimatedRevenue,
    revenuePrecisionRate: sold ? Number((priced / sold).toFixed(3)) : null,
  };
}

function summarizeNaverScheduleRevenue(schedules, listType) {
  let estimatedRevenue = 0;
  let pricedSoldOut = 0;
  let missingPriceSoldOut = 0;
  let minSoldPrice = null;
  let maxSoldPrice = null;

  for (const schedule of schedules) {
    const quantity = scheduleQuantityProfile(schedule, listType);
    if (!quantity.soldOut) continue;
    if (quantity.price !== null && quantity.price > 0) {
      estimatedRevenue += quantity.soldOut * quantity.price;
      pricedSoldOut += quantity.soldOut;
      minSoldPrice = minSoldPrice === null ? quantity.price : Math.min(minSoldPrice, quantity.price);
      maxSoldPrice = maxSoldPrice === null ? quantity.price : Math.max(maxSoldPrice, quantity.price);
    } else {
      missingPriceSoldOut += quantity.soldOut;
    }
  }

  return {
    estimatedRevenue,
    pricedSoldOut,
    missingPriceSoldOut,
    avgSoldUnitPrice: pricedSoldOut ? Math.round(estimatedRevenue / pricedSoldOut) : null,
    minSoldPrice,
    maxSoldPrice,
    ...revenueProjectionFields(estimatedRevenue, pricedSoldOut, missingPriceSoldOut),
  };
}

function summarizeNaverScheduleGroup(items, schedules, listType) {
  let totalStock = 0;
  let availableStock = 0;
  let rawTotalStock = 0;
  let rawAvailableStock = 0;
  let groupedRoomCount = 0;
  let minPrice = null;
  let knownStockCount = 0;
  const groupedProductList = listType === "객실 묶음 상품리스트";

  for (const schedule of schedules) {
    const stock = asStockNumber(schedule.stock);
    const bookingCount = Math.max(0, asStockNumber(schedule.bookingCount) || 0);
    const occupiedBookingCount = Math.max(0, asStockNumber(schedule.occupiedBookingCount) || 0);
    const usedCount = bookingCount + occupiedBookingCount;
    const price = asStockNumber(schedule.price);
    const open = schedule.isBusinessDay !== false && schedule.isSaleDay !== false;
    if (price !== null && price > 0) minPrice = minPrice === null ? price : Math.min(minPrice, price);
    groupedRoomCount += naverGroupedRoomCount(schedule.name);
    if (stock !== null && stock >= 0) {
      rawTotalStock += stock;
      rawAvailableStock += open ? Math.max(0, stock - usedCount) : 0;
    }

    if (listType === "객실별 예약리스트") {
      knownStockCount += stock !== null && stock >= 0 ? 1 : 0;
      totalStock += 1;
      const available = stock === null
        ? open && price !== null
        : open && Math.max(0, stock - usedCount) > 0;
      if (available) availableStock += 1;
      continue;
    }

    if (groupedProductList && stock === null) {
      totalStock += 1;
      if (open && price !== null) availableStock += 1;
      continue;
    }

    if (stock !== null && stock >= 0) {
      knownStockCount += 1;
      totalStock += stock;
      availableStock += Math.max(0, stock - usedCount);
      continue;
    }

    totalStock += 1;
    if (open && price !== null) availableStock += 1;
  }

  return {
    productCount: items.length,
    scheduleCount: schedules.length,
    availableStock,
    totalStock,
    rate: totalStock ? Number((availableStock / totalStock).toFixed(3)) : null,
    soldOutStock: totalStock ? Math.max(0, totalStock - availableStock) : 0,
    soldOutRate: totalStock ? Number(((totalStock - availableStock) / totalStock).toFixed(3)) : null,
    rawAvailableStock,
    rawTotalStock,
    groupedRoomCount,
    minPrice,
    knownStockCount,
    ...summarizeNaverScheduleRevenue(schedules, listType),
  };
}

function summarizeNaverBookingAvailability(items, schedules, bookingBusinessId, bookingUrl, itemCounts = {}, extra = {}) {
  const listType = schedules.length ? classifyNaverBookingList(items, schedules) : "";
  const nightSummary = summarizeNaverScheduleGroup(items, schedules, listType);
  const dayUseItems = extra.dayUseItems || [];
  const dayUseSchedules = extra.dayUseSchedules || [];
  const dayUseListType = dayUseSchedules.length ? classifyNaverBookingList(dayUseItems, dayUseSchedules) : "";
  const dayUseSummary = summarizeNaverScheduleGroup(dayUseItems, dayUseSchedules, dayUseListType || "객실 종류별 리스트");
  const coupon = mergeNaverCouponSignals([
    extra.couponSeed || summarizeNaverCouponExposure([
      couponSource("숙박상품", items),
      couponSource("데이유즈상품", dayUseItems),
      couponSource("숙박일정", schedules),
      couponSource("데이유즈일정", dayUseSchedules),
    ]),
    extra.pageCouponSignal,
  ]);
  const minPrices = [nightSummary.minPrice, dayUseSummary.minPrice].filter((value) => value !== null && value !== undefined);
  const minPrice = minPrices.length ? Math.min(...minPrices) : null;
  const evidence = !nightSummary.totalStock
    ? "날짜별 객실 재고 확인불가"
    : listType === "객실 묶음 상품리스트"
      ? `${listType}: ${CHECK_IN} 기준 네이버 숙박 묶음 상품의 내부 stock 수량을 합산 (${nightSummary.knownStockCount}/${schedules.length}개 상품 stock 확인). 전체 보유 객실수 아님.`
    : listType === "객실별 예약리스트"
      ? `${listType}: ${CHECK_IN} 기준 네이버 숙박 예약가능 상품 수 / 노출 객실 상품 수 (${nightSummary.knownStockCount}/${schedules.length}개 상품 stock 확인). 전체 보유 객실수 아님.`
      : `${listType}: ${CHECK_IN} 기준 네이버 숙박 상품별 stock - bookingCount - occupiedBookingCount 수량 합산 (${nightSummary.knownStockCount}/${schedules.length}개 상품 stock 확인). 전체 보유 객실수 아님.`;
  const availabilityUnit = listType === "객실 묶음 상품리스트"
    ? "재고수량"
    : listType === "객실별 예약리스트"
      ? "객실상품"
      : "재고수량";
  const rawStockNote = nightSummary.rawTotalStock && nightSummary.rawTotalStock !== nightSummary.totalStock
    ? `원시stock ${nightSummary.rawAvailableStock}/${nightSummary.rawTotalStock}`
    : "";
  const productTypeSummary = [
    `숙박상품 ${itemCounts.night || 0}종`,
    nightSummary.totalStock ? `예약가능 ${nightSummary.availableStock}/${nightSummary.totalStock}${availabilityUnit ? ` ${availabilityUnit}` : ""}` : "",
    nightSummary.soldOutStock || nightSummary.totalStock ? `판매완료/마감 ${nightSummary.soldOutStock}/${nightSummary.totalStock}${availabilityUnit ? ` ${availabilityUnit}` : ""}` : "",
    rawStockNote,
    `데이유즈상품 ${itemCounts.dayUse || 0}종`,
    dayUseSummary.totalStock ? `데이유즈재고 ${dayUseSummary.availableStock}/${dayUseSummary.totalStock}` : "",
    `미분류 ${itemCounts.unknown || 0}종`,
  ].filter(Boolean).join(" · ");
  const inventoryMemo = [
    "네이버예약 날짜/채널 기준 재고",
    "실제 전체 객실수와 다를 수 있음",
    listType === "객실 묶음 상품리스트" ? "객실번호 범위형 묶음 상품은 내부 stock 수량 합산" : "",
    dayUseSummary.totalStock ? `데이유즈는 숙박 예약가능률 계산에서 제외(${dayUseSummary.availableStock}/${dayUseSummary.totalStock})` : "",
  ].filter(Boolean).join(" · ");
  return {
    bookingBusinessId,
    bookingUrl,
    listType,
    availableRooms: nightSummary.availableStock,
    totalRooms: nightSummary.totalStock,
    rate: nightSummary.rate,
    minPrice,
    evidence,
    nightItemCount: itemCounts.night || 0,
    dayUseItemCount: itemCounts.dayUse || 0,
    unknownItemCount: itemCounts.unknown || 0,
    countedItemCount: schedules.length,
    productTypeSummary,
    nightAvailableStock: nightSummary.availableStock,
    nightTotalStock: nightSummary.totalStock,
    nightAvailabilityRate: nightSummary.rate,
    nightSoldOutStock: nightSummary.soldOutStock,
    nightSoldOutRate: nightSummary.soldOutRate,
    nightRawAvailableStock: nightSummary.rawAvailableStock,
    nightRawTotalStock: nightSummary.rawTotalStock,
    groupedRoomCount: nightSummary.groupedRoomCount,
    availabilityUnit,
    nightEstimatedRevenue: nightSummary.estimatedRevenue,
    nightAdjustedEstimatedRevenue: nightSummary.adjustedEstimatedRevenue,
    nightMissingPriceEstimatedRevenue: nightSummary.missingPriceEstimatedRevenue,
    nightRevenuePrecisionRate: nightSummary.revenuePrecisionRate,
    nightPricedSoldOut: nightSummary.pricedSoldOut,
    nightMissingPriceSoldOut: nightSummary.missingPriceSoldOut,
    nightAvgSoldUnitPrice: nightSummary.avgSoldUnitPrice,
    nightMinSoldPrice: nightSummary.minSoldPrice,
    nightMaxSoldPrice: nightSummary.maxSoldPrice,
    dayUseEstimatedRevenue: dayUseSummary.estimatedRevenue,
    dayUseAdjustedEstimatedRevenue: dayUseSummary.adjustedEstimatedRevenue,
    dayUseMissingPriceEstimatedRevenue: dayUseSummary.missingPriceEstimatedRevenue,
    dayUseRevenuePrecisionRate: dayUseSummary.revenuePrecisionRate,
    dayUsePricedSoldOut: dayUseSummary.pricedSoldOut,
    dayUseMissingPriceSoldOut: dayUseSummary.missingPriceSoldOut,
    dayUseAvgSoldUnitPrice: dayUseSummary.avgSoldUnitPrice,
    dayUseMinSoldPrice: dayUseSummary.minSoldPrice,
    dayUseMaxSoldPrice: dayUseSummary.maxSoldPrice,
    dayUseAvailableStock: dayUseSummary.availableStock,
    dayUseTotalStock: dayUseSummary.totalStock,
    dayUseAvailabilityRate: dayUseSummary.rate,
    dayUseCountedItemCount: dayUseSchedules.length,
    naverCouponStatus: coupon.couponStatus,
    naverCouponNames: coupon.couponNames,
    naverCouponChannel: coupon.couponChannel,
    naverCouponDetail: coupon.couponDetail,
    inventoryScope: "네이버예약 채널/날짜 기준 재고",
    inventoryMemo,
    itemDetails: [
      ...schedules.map((item) => compactNaverScheduleDetail(item, listType, item.date || CHECK_IN, availabilityUnit)),
      ...dayUseSchedules.map((item) => compactNaverScheduleDetail(item, dayUseListType || "객실 종류별 리스트", item.date || CHECK_IN, "회")),
    ],
  };
}

function dayTypeLabel(dateString) {
  const day = new Date(`${dateString}T00:00:00Z`).getUTCDay();
  if (day === 5) return "금요일";
  if (day === 6) return "토요일";
  if (day === 0) return "일요일";
  return "평일";
}

function summarizeRevenueByDayType(rows = [], unitLabel = "개") {
  const order = ["평일", "금요일", "토요일", "일요일"];
  const buckets = new Map(order.map((label) => [label, {
    label,
    revenue: 0,
    pricedSoldOut: 0,
    missingPriceSoldOut: 0,
    offlineReserved: 0,
    days: 0
  }]));
  for (const row of rows) {
    const label = dayTypeLabel(row.date);
    const bucket = buckets.get(label);
    if (!bucket) continue;
    bucket.days += 1;
    bucket.revenue += Number(row.estimatedRevenue || 0);
    bucket.pricedSoldOut += Number(row.pricedSoldOut || 0);
    bucket.missingPriceSoldOut += Number(row.missingPriceSoldOut || 0);
    bucket.offlineReserved += Number(row.offlineReserved || 0);
  }
  return order
    .map((label) => buckets.get(label))
    .filter((bucket) => bucket.days > 0)
    .map((bucket) => {
      const offline = bucket.offlineReserved ? ` · 오프라인 ${bucket.offlineReserved}${unitLabel}` : "";
      const missing = bucket.missingPriceSoldOut ? ` · 가격누락 ${bucket.missingPriceSoldOut}${unitLabel}` : "";
      return `${bucket.label} ${formatWon(bucket.revenue)}(${bucket.pricedSoldOut}${unitLabel}${offline}${missing})`;
    })
    .join(", ");
}

function buildProductStockBasis(summaries = []) {
  const basis = new Map();
  for (const summary of summaries) {
    for (const schedule of summary.schedules || []) {
      const key = scheduleProductKey(schedule);
      const quantity = scheduleQuantityProfile(schedule, summary.listType);
      const previous = basis.get(key);
      if (!previous || quantity.total > previous.total) {
        basis.set(key, {
          key,
          total: quantity.total,
          name: scheduleProductLabel(schedule),
        });
      }
    }
  }
  return basis;
}

function summarizeOfflineProductRevenue(summary, productBasis, offlineReserved, unitLabel = "개") {
  let remaining = Math.max(0, Number(offlineReserved || 0));
  if (!remaining) {
    return {
      estimatedRevenue: 0,
      pricedSoldOut: 0,
      missingPriceSoldOut: 0,
      detail: "",
    };
  }

  const candidates = [];
  for (const schedule of summary.schedules || []) {
    const key = scheduleProductKey(schedule);
    const basis = productBasis.get(key);
    if (!basis) continue;
    const quantity = scheduleQuantityProfile(schedule, summary.listType);
    const hidden = Math.max(0, Number(basis.total || 0) - Number(quantity.total || 0));
    if (!hidden) continue;
    candidates.push({
      name: scheduleProductLabel(schedule),
      hidden,
      price: quantity.price,
    });
  }

  let estimatedRevenue = 0;
  let pricedSoldOut = 0;
  let missingPriceSoldOut = 0;
  const detailParts = [];

  for (const candidate of candidates) {
    if (!remaining) break;
    const quantity = Math.min(candidate.hidden, remaining);
    remaining -= quantity;
    if (candidate.price !== null && candidate.price > 0) {
      estimatedRevenue += quantity * candidate.price;
      pricedSoldOut += quantity;
      detailParts.push(`${candidate.name} ${quantity}${unitLabel}×${formatWon(candidate.price)}`);
    } else {
      missingPriceSoldOut += quantity;
      detailParts.push(`${candidate.name} ${quantity}${unitLabel}×가격확인필요`);
    }
  }

  if (remaining > 0) {
    missingPriceSoldOut += remaining;
    detailParts.push(`상품미배정 ${remaining}${unitLabel}×가격확인필요`);
  }

  return {
    estimatedRevenue,
    pricedSoldOut,
    missingPriceSoldOut,
    detail: detailParts.join("; "),
  };
}

async function collectNaverSchedulesForItems(bookingBusinessId, items, limit = 40, date = CHECK_IN) {
  return mapWithConcurrency(items.slice(0, limit), NAVER_SCHEDULE_CONCURRENCY, async (item, index) => {
    if (NAVER_SCHEDULE_DELAY_MS) await delay(NAVER_SCHEDULE_DELAY_MS * (index % NAVER_SCHEDULE_CONCURRENCY));
    const schedule = await getNaverDailySchedule(bookingBusinessId, item.bizItemId, date);
    const day = schedule.day || {};
    const stock = asStockNumber(day.stock);
    const bookingCount = Math.max(0, asStockNumber(day.bookingCount) || 0);
    const occupiedBookingCount = Math.max(0, asStockNumber(day.occupiedBookingCount) || 0);
    const price = asStockNumber(day.prices?.[0]?.price ?? item.minMaxPrice?.minPrice ?? item.price);
    const coupon = summarizeNaverCouponExposure([
      couponSource("상품", item),
      couponSource("일정", day),
    ]);
    return {
      date,
      bizItemId: item.bizItemId,
      name: item.name,
      bizItemSubType: item.bizItemSubType || "",
      saleType: naverBookingSaleType(item),
      stock,
      bookingCount,
      occupiedBookingCount,
      available: stock === null ? null : Math.max(0, stock - bookingCount - occupiedBookingCount),
      price,
      couponStatus: coupon.couponStatus,
      couponNames: coupon.couponNames,
      couponChannel: coupon.couponChannel,
      couponDetail: coupon.couponDetail,
      isBusinessDay: day.isBusinessDay,
      isSaleDay: day.isSaleDay,
      errors: schedule.errors,
    };
  });
}

function operatingTotalBasisFromTotals(totals = [], basisTotal = 0) {
  const validTotals = totals
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value > 0);
  if (!validTotals.length || !basisTotal) {
    return {
      operatingTotal: basisTotal || 0,
      operatingTotalDays: 0,
      structuralBlockedTotal: 0,
      stockBasisType: "no_basis"
    };
  }
  const frequency = new Map();
  validTotals.forEach((value) => frequency.set(value, (frequency.get(value) || 0) + 1));
  const maxTotalDays = frequency.get(basisTotal) || 0;
  const candidates = [...frequency.entries()]
    .filter(([value]) => value > 0 && value < basisTotal)
    .sort((left, right) => {
      if (right[1] !== left[1]) return right[1] - left[1];
      return right[0] - left[0];
    });
  const stableLower = candidates.find(([, count]) => (
    count >= Math.max(2, Math.ceil(validTotals.length * 0.5)) &&
    count > maxTotalDays
  ));
  const operatingTotal = stableLower ? stableLower[0] : basisTotal;
  const operatingTotalDays = stableLower ? stableLower[1] : maxTotalDays;
  const structuralBlockedTotal = Math.max(0, basisTotal - operatingTotal);
  return {
    operatingTotal,
    operatingTotalDays,
    structuralBlockedTotal,
    stockBasisType: structuralBlockedTotal > 0 ? "operating_reduced" : "max_total"
  };
}

async function collectWeeklyNaverAvailability(bookingBusinessId, items, firstSchedules, days, unitLabel = "개") {
  if (!items.length || days <= 1) return null;
  const summaries = [];

  for (let index = 0; index < days; index += 1) {
    const date = addDays(CHECK_IN, index);
    const schedules = index === 0
      ? firstSchedules
      : await collectNaverSchedulesForItems(bookingBusinessId, items, 40, date);
    const listType = schedules.length ? classifyNaverBookingList(items, schedules) : "";
    const summary = summarizeNaverScheduleGroup(items, schedules, listType);
    const availabilityUnit = listType === "객실 묶음 상품리스트"
      ? "묶음상품"
      : listType === "객실별 예약리스트"
        ? "객실상품"
        : "재고수량";
    summaries.push({
      date,
      listType,
      availabilityUnit,
      schedules,
      available: summary.availableStock,
      total: summary.totalStock,
      soldOut: summary.soldOutStock,
      rate: summary.rate,
      estimatedRevenue: summary.estimatedRevenue,
      pricedSoldOut: summary.pricedSoldOut,
      missingPriceSoldOut: summary.missingPriceSoldOut,
      avgSoldUnitPrice: summary.avgSoldUnitPrice,
    });
  }

  const rawValid = summaries.filter((item) => item.total > 0);
  const totals = rawValid.map((item) => item.total || 0).filter((value) => value > 0);
  const minTotal = totals.length ? Math.min(...totals) : 0;
  const maxTotal = totals.length ? Math.max(...totals) : 0;
  const basisTotal = maxTotal;
  const maxTotalDays = maxTotal ? totals.filter((value) => value === maxTotal).length : 0;
  const operatingBasis = operatingTotalBasisFromTotals(totals, basisTotal);
  const operatingTotal = operatingBasis.operatingTotal || basisTotal;
  const operatingTotalDays = operatingBasis.operatingTotalDays || 0;
  const structuralBlockedTotal = operatingBasis.structuralBlockedTotal || 0;
  const stockBasisType = operatingBasis.stockBasisType;
  const totalVarianceGap = Math.max(0, maxTotal - minTotal);
  const hasVariableTotal = minTotal > 0 && maxTotal > minTotal;
  const productBasis = buildProductStockBasis(rawValid);
  const valid = rawValid.map((item) => {
    const rawTotal = item.total;
    const total = Math.max(operatingTotal, rawTotal);
    const available = Math.min(Math.max(0, item.available || 0), total);
    const offlineReserved = Math.max(0, operatingTotal - rawTotal);
    const offlineRevenue = summarizeOfflineProductRevenue(item, productBasis, offlineReserved, unitLabel);
    const soldOut = Math.max(0, total - available);
    const rate = total > 0 ? soldOut / total : null;
    const productDetails = (item.schedules || [])
      .map((schedule) => compactNaverScheduleDetail(schedule, item.listType, item.date, item.availabilityUnit))
      .slice(0, 80);
    return {
      ...item,
      schedules: undefined,
      productDetails,
      rawAvailable: item.available,
      rawTotal,
      available,
      total,
      soldOut,
      offlineReserved,
      rate,
      estimatedRevenue: Number(item.estimatedRevenue || 0) + offlineRevenue.estimatedRevenue,
      pricedSoldOut: Number(item.pricedSoldOut || 0) + offlineRevenue.pricedSoldOut,
      missingPriceSoldOut: Number(item.missingPriceSoldOut || 0) + offlineRevenue.missingPriceSoldOut,
      offlineEstimatedRevenue: offlineRevenue.estimatedRevenue,
      offlinePricedSoldOut: offlineRevenue.pricedSoldOut,
      offlineMissingPriceSoldOut: offlineRevenue.missingPriceSoldOut,
      offlineProductDetail: offlineRevenue.detail,
      avgSoldUnitPrice: null,
      totalChanged: hasVariableTotal,
    };
  });
  if (!valid.length) return null;
  const avgAvailable = Number((valid.reduce((sum, item) => sum + item.available, 0) / valid.length).toFixed(1));
  const minAvailable = Math.min(...valid.map((item) => item.available));
  const soldOutDays = valid.filter((item) => item.available <= 0).length;
  const totalSoldOut = valid.reduce((sum, item) => sum + item.soldOut, 0);
  const totalStock = valid.reduce((sum, item) => sum + item.total, 0);
  const totalOfflineReserved = valid.reduce((sum, item) => sum + Number(item.offlineReserved || 0), 0);
  const totalEstimatedRevenue = valid.reduce((sum, item) => sum + Number(item.estimatedRevenue || 0), 0);
  const totalPricedSoldOut = valid.reduce((sum, item) => sum + Number(item.pricedSoldOut || 0), 0);
  const totalMissingPriceSoldOut = valid.reduce((sum, item) => sum + Number(item.missingPriceSoldOut || 0), 0);
  const avgSoldUnitPrice = totalPricedSoldOut ? Math.round(totalEstimatedRevenue / totalPricedSoldOut) : null;
  const projectedRevenue = revenueProjectionFields(totalEstimatedRevenue, totalPricedSoldOut, totalMissingPriceSoldOut);
  const avgReservationRate = Number((valid.reduce((sum, item) => {
    const reservationRate = item.total > 0 ? item.soldOut / item.total : 0;
    return sum + reservationRate;
  }, 0) / valid.length).toFixed(3));
  const detail = valid.map((item) => `${shortDate(item.date)} ${item.available}/${item.total}`).join(", ");
  const reservationRateDetail = valid
    .map((item) => {
      const reservationRate = item.total > 0 ? item.soldOut / item.total : null;
      return `${shortDate(item.date)} ${formatRate(reservationRate)}(${item.soldOut}/${item.total})`;
    })
    .join(", ");
  const revenueDetail = valid
    .map((item) => {
      const offline = item.offlineReserved ? ` · 오프라인 ${item.offlineReserved}${unitLabel}` : "";
      const missing = item.missingPriceSoldOut ? ` · 가격누락 ${item.missingPriceSoldOut}` : "";
      const products = item.offlineProductDetail ? ` [${item.offlineProductDetail}]` : "";
      return `${shortDate(item.date)} ${formatWon(item.estimatedRevenue)}(${item.pricedSoldOut}${unitLabel}${offline}${missing ? `${missing}${unitLabel}` : ""})${products}`;
    })
    .join(", ");
  const revenueByDayTypeDetail = summarizeRevenueByDayType(valid, unitLabel);
  const offlineReservationDetail = valid
    .filter((item) => item.offlineReserved)
    .map((item) => `${shortDate(item.date)} 오프라인예약추정 ${item.offlineReserved}${unitLabel}${item.offlineProductDetail ? `: ${item.offlineProductDetail}` : ""}`)
    .join(", ");
  const totalVarianceDetail = hasVariableTotal
    ? valid.map((item) => `${shortDate(item.date)} 원시 ${item.rawAvailable}/${item.rawTotal}${item.offlineReserved ? ` 오프라인예약 ${item.offlineReserved}${unitLabel}` : ""}${item.rawTotal > operatingTotal ? ` 운영상회 ${item.rawTotal - operatingTotal}${unitLabel}` : ""}${item.offlineProductDetail ? ` (${item.offlineProductDetail})` : ""}`).join(", ")
    : "";
  const basisRule = basisTotal
    ? `전체객실수후보=${basisTotal}${unitLabel}(날짜별 총량 최대값${maxTotalDays ? `, ${maxTotalDays}일 확인` : ""})${structuralBlockedTotal ? ` · 운영판매기준=${operatingTotal}${unitLabel} · 상시차단/운영축소 ${structuralBlockedTotal}${unitLabel}` : ""}${totalOfflineReserved ? ` · 운영기준 미만 ${totalOfflineReserved}${unitLabel} 오프라인/차단 추정` : ""}`
    : "";
  return {
    days: valid.length,
    basisTotal,
    operatingTotal,
    operatingTotalDays,
    structuralBlockedTotal,
    stockBasisType,
    minTotal,
    maxTotal,
    maxTotalDays,
    totalVarianceGap,
    hasVariableTotal,
    totalOfflineReserved,
    basisRule,
    avgAvailable,
    minAvailable,
    soldOutDays,
    totalSoldOut,
    totalStock,
    totalEstimatedRevenue,
    totalAdjustedEstimatedRevenue: projectedRevenue.adjustedEstimatedRevenue,
    totalMissingPriceEstimatedRevenue: projectedRevenue.missingPriceEstimatedRevenue,
    revenuePrecisionRate: projectedRevenue.revenuePrecisionRate,
    totalPricedSoldOut,
    totalMissingPriceSoldOut,
    avgSoldUnitPrice,
    avgReservationRate,
    detail,
    reservationRateDetail,
    revenueDetail,
    revenueByDayTypeDetail,
    offlineReservationDetail,
    totalVarianceDetail,
    summary: `${valid.length}일 날짜별 잔여`,
    dates: valid,
    productDetails: valid.flatMap((item) => item.productDetails || []),
  };
}

async function collectNaverBookingAvailability(placeId, cache, options = {}) {
  if (!placeId) return { status: "place_id 없음" };
  if (cache.has(placeId)) return cache.get(placeId);

  let booking = await getNaverBookingBusiness(placeId);
  let pageBooking = null;
  if (!booking?.bookingBusinessId) {
    pageBooking = await getNaverBookingBusinessFromPlacePage(placeId);
    if (pageBooking?.bookingBusinessId) {
      booking = {
        ...booking,
        ...pageBooking,
      };
    }
  }
  let fallbackBooking = null;
  if (!booking?.bookingBusinessId) {
    fallbackBooking = await getHistoricalNaverBookingBusiness(placeId);
    if (fallbackBooking?.bookingBusinessId) {
      booking = {
        ...booking,
        ...fallbackBooking,
        lookupStatus: booking?.blocked
          ? `네이버예약 ID 조회 차단(${booking.status || "응답오류"})`
          : `네이버예약 ID 과거값 재사용`,
      };
    }
  }

  if (!booking?.bookingBusinessId) {
    const status = booking?.blocked
      ? `네이버예약 ID 조회 차단(${booking.status || "응답오류"})`
      : booking?.errors
        ? `네이버예약 ID 조회 오류(${booking.status || "응답오류"})`
        : "네이버예약 사업자ID 없음";
    const result = {
      status,
      bookingBusinessId: "",
      bookingUrl: booking?.bookingUrl || "",
    };
    cache.set(placeId, result);
    return result;
  }

  await delay(120);
  const itemResult = await getNaverBookingItems(booking.bookingBusinessId);
  const allItems = itemResult.items.filter((item) => item.isImp !== false && item.isClosedBooking !== true && item.isClosedBookingUser !== true);
  const nightItems = allItems.filter((item) => naverBookingSaleType(item) === "숙박");
  const dayUseItems = allItems.filter((item) => naverBookingSaleType(item) === "데이유즈");
  const unknownItems = allItems.filter((item) => naverBookingSaleType(item) === "미분류");
  const items = nightItems.length ? nightItems : unknownItems;
  const schedules = await collectNaverSchedulesForItems(booking.bookingBusinessId, items, 40);
  const dayUseSchedules = await collectNaverSchedulesForItems(booking.bookingBusinessId, dayUseItems, 20);
  const couponSeed = summarizeNaverCouponExposure([
    couponSource("숙박상품", items),
    couponSource("데이유즈상품", dayUseItems),
    couponSource("숙박일정", schedules),
    couponSource("데이유즈일정", dayUseSchedules),
  ]);
  const pageCouponSignal = couponSeed.couponStatus === "있음"
    ? null
    : await getNaverBookingPageCouponSignal(booking.bookingBusinessId, booking.bookingUrl);
  const weekly = options.collectRange
    ? await collectWeeklyNaverAvailability(booking.bookingBusinessId, items, schedules, BOOKING_RANGE_DAYS)
    : null;
  const dayUseWeekly = options.collectRange
    ? await collectWeeklyNaverAvailability(booking.bookingBusinessId, dayUseItems, dayUseSchedules, BOOKING_RANGE_DAYS, "회")
    : null;

  const result = {
    status: itemResult.errors
      ? "객실목록 일부 오류"
      : !nightItems.length && dayUseItems.length && !unknownItems.length
        ? "숙박상품 없음(데이유즈만)"
        : fallbackBooking?.bookingBusinessId
          ? "성공(과거ID)"
          : pageBooking?.bookingBusinessId
            ? "성공(URL추출)"
            : "성공",
    ...summarizeNaverBookingAvailability(items, schedules, booking.bookingBusinessId, booking.bookingUrl, {
      night: nightItems.length,
      dayUse: dayUseItems.length,
      unknown: unknownItems.length,
    }, {
      dayUseItems,
      dayUseSchedules,
      couponSeed,
      pageCouponSignal,
    }),
    weekly,
    dayUseWeekly,
  };
  if (fallbackBooking?.bookingBusinessId) {
    result.inventoryMemo = [
      result.inventoryMemo,
      `네이버예약 ID 실시간 조회 실패로 과거 확인 ID 재사용(${fallbackBooking.sourceRun || "기존 결과"})`,
    ].filter(Boolean).join(" · ");
  }
  if (pageBooking?.bookingBusinessId) {
    result.inventoryMemo = [
      result.inventoryMemo,
      `네이버예약 ID를 플레이스 페이지 URL에서 추출(${pageBooking.sourceRoute || "place"})`,
    ].filter(Boolean).join(" · ");
  }
  cache.set(placeId, result);
  return result;
}

async function enrichNaverRowsWithBookingAvailability(rows) {
  const cache = new Map();
  let collected = 0;
  let successful = 0;
  let skippedByMode = 0;
  let skippedByRank = 0;
  const uniquePlaceIds = new Set();
  const bookingTasks = [];
  const bookingResultPromises = new Map();

  for (const row of rows) {
    if (!row.place_id || row.예약 !== "Y") {
      row.네이버예약재고수집상태 = row.예약 === "Y" ? "place_id 없음" : "네이버예약 미노출";
      continue;
    }
    const alreadyKnown = uniquePlaceIds.has(row.place_id);
    const overallRank = asNumber(row.overall_rank);
    const adRank = asNumber(row.ad_order);
    const detailEligible = COLLECTION_MODE !== "fast" && (
      rankInRanges(overallRank, DETAIL_RANK_RANGES) ||
      (!overallRank && rankInRanges(adRank, DETAIL_RANK_RANGES))
    );
    if (!alreadyKnown && COLLECTION_MODE === "fast") {
      row.네이버예약재고수집상태 = "미수집(빠른 순위 모드)";
      skippedByMode += 1;
      continue;
    }
    if (!alreadyKnown && !detailEligible) {
      row.네이버예약재고수집상태 = `미수집(상세 분석 범위 ${DETAIL_RANK_RANGE_LABEL} 제외)`;
      skippedByRank += 1;
      continue;
    }
    if (!alreadyKnown && uniquePlaceIds.size >= NAVER_BOOKING_STOCK_LIMIT) {
      row.네이버예약재고수집상태 = `미수집(상위 ${NAVER_BOOKING_STOCK_LIMIT}개 제한)`;
      continue;
    }
    uniquePlaceIds.add(row.place_id);
    const collectRange = COLLECTION_PROFILE.collectWeeklyRange &&
      BOOKING_RANGE_DAYS > 1 &&
      BOOKING_RANGE_PLACE_LIMIT > 0 &&
      !alreadyKnown &&
      uniquePlaceIds.size <= BOOKING_RANGE_PLACE_LIMIT;
    bookingTasks.push({ row, alreadyKnown, collectRange });
  }

  async function collectBookingTaskResult(placeId, collectRange) {
    const key = String(placeId || "");
    if (!key) return { status: "place_id 없음" };
    if (!bookingResultPromises.has(key)) {
      bookingResultPromises.set(key, collectNaverBookingAvailability(placeId, cache, { collectRange }));
    }
    return bookingResultPromises.get(key);
  }

  await mapWithConcurrency(bookingTasks, NAVER_BOOKING_DETAIL_CONCURRENCY, async ({ row, alreadyKnown, collectRange }) => {
    try {
      const result = await collectBookingTaskResult(row.place_id, collectRange);
      if (!alreadyKnown) collected += 1;
      if (!alreadyKnown && String(result.status || "").startsWith("성공")) successful += 1;

      row.네이버예약재고수집상태 = result.status || "확인불가";
      row.네이버예약사업자ID = result.bookingBusinessId || "";
      row.네이버예약URL = result.bookingUrl || row.url;
      row.예약리스트유형 = result.listType || "";
      row.네이버상품구성 = result.productTypeSummary || "";
      row.숙박상품수 = result.nightItemCount ?? "";
      row.데이유즈상품수 = result.dayUseItemCount ?? "";
      row.미분류상품수 = result.unknownItemCount ?? "";
      row.예약계산대상상품수 = result.countedItemCount ?? "";
      row.예약가능객실수 = result.availableRooms ?? "";
      row.확인객실수 = result.totalRooms ?? "";
      row.예약가능률 = result.rate === null || result.rate === undefined ? "" : result.rate;
      row.숙박예약가능수 = result.nightAvailableStock ?? "";
      row.숙박확인재고수 = result.nightTotalStock ?? "";
      row.숙박예약가능률 = result.nightAvailabilityRate === null || result.nightAvailabilityRate === undefined ? "" : result.nightAvailabilityRate;
      row.숙박판매완료수 = result.nightSoldOutStock ?? "";
      row.숙박판매완료율 = result.nightSoldOutRate === null || result.nightSoldOutRate === undefined ? "" : result.nightSoldOutRate;
      row.숙박기준일예상매출 = result.nightEstimatedRevenue ?? "";
      row.basisLodgingAdjustedRevenue = result.nightAdjustedEstimatedRevenue ?? "";
      row.basisLodgingMissingPriceEstimatedRevenue = result.nightMissingPriceEstimatedRevenue ?? "";
      row.basisLodgingRevenuePrecisionRate = result.nightRevenuePrecisionRate ?? "";
      row.숙박기준일가격확인판매수량 = result.nightPricedSoldOut ?? "";
      row.숙박기준일가격누락판매수량 = result.nightMissingPriceSoldOut ?? "";
      row.숙박기준일평균판매단가 = result.nightAvgSoldUnitPrice ?? "";
      row.네이버원시예약가능재고 = result.nightRawAvailableStock ?? "";
      row.네이버원시전체재고 = result.nightRawTotalStock ?? "";
      row.네이버묶음객실범위수 = result.groupedRoomCount ?? "";
      row.예약계산단위 = result.availabilityUnit || "";
      row.데이유즈예약가능수 = result.dayUseAvailableStock ?? "";
      row.데이유즈확인재고수 = result.dayUseTotalStock ?? "";
      row.데이유즈예약가능률 = result.dayUseAvailabilityRate === null || result.dayUseAvailabilityRate === undefined ? "" : result.dayUseAvailabilityRate;
      row.데이유즈계산대상상품수 = result.dayUseCountedItemCount ?? "";
      row.네이버쿠폰노출상태 = result.naverCouponStatus || "";
      row.네이버쿠폰명 = result.naverCouponNames || "";
      row.네이버쿠폰확인채널 = result.naverCouponChannel || "";
      row.네이버쿠폰상세 = result.naverCouponDetail || "";
      const jsonMeta = {
        name: row.업체명 || row.name || "",
        placeId: row.place_id || "",
        bookingBusinessId: result.bookingBusinessId || ""
      };
      row.네이버상품상세JSON = await jsonCell(result.itemDetails || [], { ...jsonMeta, field: "naver_item_details" });
      row.네이버요일별상품상세JSON = await jsonCell(result.weekly?.productDetails || [], { ...jsonMeta, field: "weekly_product_details" });
      row.dayUseWeeklyProductDetailsJson = await jsonCell(result.dayUseWeekly?.productDetails || [], { ...jsonMeta, field: "dayuse_weekly_product_details" });
      row.데이유즈기준일예상매출 = result.dayUseEstimatedRevenue ?? "";
      row.basisDayUseAdjustedRevenue = result.dayUseAdjustedEstimatedRevenue ?? "";
      row.basisDayUseMissingPriceEstimatedRevenue = result.dayUseMissingPriceEstimatedRevenue ?? "";
      row.basisDayUseRevenuePrecisionRate = result.dayUseRevenuePrecisionRate ?? "";
      row.데이유즈기준일가격확인판매수량 = result.dayUsePricedSoldOut ?? "";
      row.데이유즈기준일가격누락판매수량 = result.dayUseMissingPriceSoldOut ?? "";
      row.데이유즈기준일평균판매단가 = result.dayUseAvgSoldUnitPrice ?? "";
      row.네이버재고범위 = result.inventoryScope || "";
      row.객실수검증메모 = result.inventoryMemo || "";
      row.예약최저가 = result.minPrice ? formatWon(result.minPrice) : "";
      row.예약가능근거 = result.evidence || "";
      row.주간재고수집일수 = result.weekly?.days ?? "";
      row.주간잔여요약 = result.weekly?.summary || "";
      row.주간평균잔여수 = result.weekly?.avgAvailable ?? "";
      row.주간최소잔여수 = result.weekly?.minAvailable ?? "";
      row.주간마감일수 = result.weekly?.soldOutDays ?? "";
      row.주간판매수량합계 = result.weekly?.totalSoldOut ?? "";
      row.주간전체수량합계 = result.weekly?.totalStock ?? "";
      row.주간기준재고수 = result.weekly?.basisTotal ?? "";
      row.주간운영판매기준수 = result.weekly?.operatingTotal ?? "";
      row.주간운영판매기준확인일수 = result.weekly?.operatingTotalDays ?? "";
      row.주간상시차단추정수 = result.weekly?.structuralBlockedTotal ?? "";
      row.주간총량판단유형 = result.weekly?.stockBasisType || "";
      row.주간총량최소값 = result.weekly?.minTotal ?? "";
      row.주간총량최대값 = result.weekly?.maxTotal ?? "";
      row.주간최대총량확인일수 = result.weekly?.maxTotalDays ?? "";
      row.주간총량편차 = result.weekly?.totalVarianceGap ?? "";
      row.주간숙박오프라인예약추정수 = result.weekly?.totalOfflineReserved ?? "";
      row.주간숙박총량기준 = result.weekly?.basisRule || "";
      row.주간숙박예상매출 = result.weekly?.totalEstimatedRevenue ?? "";
      row.weeklyAdjustedRevenue = result.weekly?.totalAdjustedEstimatedRevenue ?? "";
      row.weeklyMissingPriceEstimatedRevenue = result.weekly?.totalMissingPriceEstimatedRevenue ?? "";
      row.weeklyRevenuePrecisionRate = result.weekly?.revenuePrecisionRate ?? "";
      row.주간숙박가격확인판매수량 = result.weekly?.totalPricedSoldOut ?? "";
      row.주간숙박가격누락판매수량 = result.weekly?.totalMissingPriceSoldOut ?? "";
      row.주간숙박평균판매단가 = result.weekly?.avgSoldUnitPrice ?? "";
      row.주간숙박매출상세 = result.weekly?.revenueDetail || "";
      row.주간숙박요일매출 = result.weekly?.revenueByDayTypeDetail || "";
      row.주간숙박오프라인예약상세 = result.weekly?.offlineReservationDetail || "";
      row.주간원시재고변동 = result.weekly?.totalVarianceDetail || "";
      row.주간잔여상세 = result.weekly?.detail || "";
      row.주간평균예약률 = result.weekly?.avgReservationRate ?? "";
      row.주간예약률상세 = result.weekly?.reservationRateDetail || "";
      row.dayUseWeeklyDays = result.dayUseWeekly?.days ?? "";
      row.dayUseWeeklySummary = result.dayUseWeekly?.summary || "";
      row.dayUseWeeklyAvgAvailable = result.dayUseWeekly?.avgAvailable ?? "";
      row.dayUseWeeklyMinAvailable = result.dayUseWeekly?.minAvailable ?? "";
      row.dayUseWeeklySoldOutDays = result.dayUseWeekly?.soldOutDays ?? "";
      row.dayUseWeeklyTotalSoldOut = result.dayUseWeekly?.totalSoldOut ?? "";
      row.dayUseWeeklyTotalStock = result.dayUseWeekly?.totalStock ?? "";
      row.dayUseWeeklyBasisTotal = result.dayUseWeekly?.basisTotal ?? "";
      row.dayUseWeeklyOperatingTotal = result.dayUseWeekly?.operatingTotal ?? "";
      row.dayUseWeeklyOperatingTotalDays = result.dayUseWeekly?.operatingTotalDays ?? "";
      row.dayUseWeeklyStructuralBlockedTotal = result.dayUseWeekly?.structuralBlockedTotal ?? "";
      row.dayUseWeeklyStockBasisType = result.dayUseWeekly?.stockBasisType || "";
      row.dayUseWeeklyMinTotal = result.dayUseWeekly?.minTotal ?? "";
      row.dayUseWeeklyMaxTotal = result.dayUseWeekly?.maxTotal ?? "";
      row.dayUseWeeklyMaxTotalDays = result.dayUseWeekly?.maxTotalDays ?? "";
      row.dayUseWeeklyTotalVarianceGap = result.dayUseWeekly?.totalVarianceGap ?? "";
      row.dayUseWeeklyOfflineReservedTotal = result.dayUseWeekly?.totalOfflineReserved ?? "";
      row.dayUseWeeklyBasisRule = result.dayUseWeekly?.basisRule || "";
      row.dayUseWeeklyEstimatedRevenue = result.dayUseWeekly?.totalEstimatedRevenue ?? "";
      row.dayUseWeeklyAdjustedRevenue = result.dayUseWeekly?.totalAdjustedEstimatedRevenue ?? "";
      row.dayUseWeeklyMissingPriceEstimatedRevenue = result.dayUseWeekly?.totalMissingPriceEstimatedRevenue ?? "";
      row.dayUseWeeklyRevenuePrecisionRate = result.dayUseWeekly?.revenuePrecisionRate ?? "";
      row.dayUseWeeklyPricedSoldOut = result.dayUseWeekly?.totalPricedSoldOut ?? "";
      row.dayUseWeeklyMissingPriceSoldOut = result.dayUseWeekly?.totalMissingPriceSoldOut ?? "";
      row.dayUseWeeklyAvgSoldUnitPrice = result.dayUseWeekly?.avgSoldUnitPrice ?? "";
      row.dayUseWeeklyRevenueDetail = result.dayUseWeekly?.revenueDetail || "";
      row.dayUseWeeklyRevenueByDayType = result.dayUseWeekly?.revenueByDayTypeDetail || "";
      row.dayUseWeeklyOfflineReservationDetail = result.dayUseWeekly?.offlineReservationDetail || "";
      row.dayUseWeeklyRawStockVariance = result.dayUseWeekly?.totalVarianceDetail || "";
      row.dayUseWeeklyDetail = result.dayUseWeekly?.detail || "";
      row.dayUseWeeklyAvgReservationRate = result.dayUseWeekly?.avgReservationRate ?? "";
      row.dayUseWeeklyReservationRateDetail = result.dayUseWeekly?.reservationRateDetail || "";
    } catch (error) {
      if (!alreadyKnown) collected += 1;
      row.네이버예약재고수집상태 = `실패: ${error.message || error}`;
    }
  });

  rows.forEach(setNaverInventoryAuditFields);
  return {
    limit: NAVER_BOOKING_STOCK_LIMIT,
    collected,
    successful,
    skippedByMode,
    skippedByRank,
    detailRankRanges: DETAIL_RANK_RANGE_LABEL,
    collectionMode: COLLECTION_MODE,
    collectionPurpose: COLLECTION_PURPOSE,
    collectionProfile: COLLECTION_PROFILE.key,
    collectionProfileLabel: COLLECTION_PROFILE.label,
    collectWeeklyRange: COLLECTION_PROFILE.collectWeeklyRange,
    bookingRangePlaceLimit: BOOKING_RANGE_PLACE_LIMIT
  };
}

async function collectNaverMain() {
  const queries = HAS_COLLECTION_SEARCH_CONTEXT
    ? COLLECTION_SEARCH_CONTEXT.platformQueries.naver
    : (province.isCompany ? companySearchQueries(RAW_KEYWORD) : [NAVER_QUERY]);
  const attemptedQueries = [];
  let lastStatus = 0;
  let lastUrl = "";

  for (const query of queries) {
    const { state, status, url } = await getNaverState(query);
    lastStatus = status;
    lastUrl = url;
    const organicResult = selectNaverOrganicResult(state, query, { allowPlaceList: true, required: false });
    const searchKey = organicResult?.key || "";
    const adKey = pickNaverAdKey(state, query, province.isCompany ? ["accommodation", "place"] : ["accommodation"]);
    const isPlaceList = organicResult?.type === "placeList";
    const attempt = {
      query,
      status,
      searchKey: Boolean(searchKey),
      searchType: isPlaceList ? "placeList" : (searchKey ? "accommodationSearch" : ""),
      adKey: Boolean(adKey),
      matched: 0,
      filteredOut: 0,
    };
    attemptedQueries.push(attempt);

    if (!searchKey && (!province.isCompany || !adKey)) {
      continue;
    }

    const overallItems = organicResult?.items || [];
    const adRefs = adKey ? state.ROOT_QUERY[adKey].items || [] : [];

    let overall = overallItems.map((item, index) => {
      return mapNaverItem(state, item, {
        query,
        overall_rank: index + 1,
        구분: "비광고",
      });
    });

    let ads = adRefs.map((ref, index) => {
      const item = state[ref.__ref];
      return mapNaverItem(state, item, {
        query,
        ad_order: index + 1,
        구분: "광고",
        ad_id: item.adId || "",
        ad_description: item.adDescription || "",
      });
    });

    if (province.isCompany) {
      const beforeFilter = overall.length + ads.length;
      overall = filterCompanyRows(overall, (row) => row.업체명);
      ads = filterCompanyRows(ads, (row) => row.업체명);
      attempt.matched = overall.length + ads.length;
      attempt.filteredOut = beforeFilter - attempt.matched;
      if (!attempt.matched) continue;
    }

    overall = filterCollectionRows(overall, query);
    ads = filterCollectionRows(ads, query);
    attempt.relevanceMatched = overall.length + ads.length;

    return {
      status,
      url,
      total: organicResult?.total || 0,
      adTotal: adKey ? state.ROOT_QUERY[adKey].total : 0,
      overall,
      ads,
      usedQuery: query,
      attemptedQueries,
    };
  }

  if (province.isCompany) {
    return {
      status: lastStatus,
      url: lastUrl,
      total: 0,
      adTotal: 0,
      overall: [],
      ads: [],
      warning: "Company search produced no exact place match.",
      usedQuery: "",
      attemptedQueries,
    };
  }
  throw createCrawlFailure("NAVER_SEARCH_CONTRACT_UNAVAILABLE");
}

async function collectNaverRegional() {
  const rows = [];
  const summaries = [];
  if (province.isCompany) {
    return {
      rows,
      summaries: [
        {
          region: province.short,
          query: NAVER_QUERY,
          status: "skipped",
          total: 0,
          collected: 0,
          note: "업체명 모드는 지역별 키워드 반복 수집을 제외",
        },
      ],
    };
  }
  const regionalResults = await mapWithConcurrency(regions, REGIONAL_SEARCH_CONCURRENCY, async (region) => {
    const regionalPrefix = province.regionalPrefix === undefined ? province.short : province.regionalPrefix;
    const query = province.isLocal ? QUERY : [regionalPrefix, region, RAW_KEYWORD_SUFFIX].filter(Boolean).join(" ");
    const { state, status } = await getNaverState(query);
    const result = selectNaverOrganicResult(state, query, { allowPlaceList: true, required: false });
    if (!result) {
      return {
        rows: [],
        summary: { region, query, status, total: 0, collected: 0, note: "검색 결과 구조 없음" }
      };
    }
    const items = result.items || [];
    const regionRows = filterCollectionRows(items.slice(0, REGIONAL_LIMIT).map((item, index) => {
      return mapNaverItem(state, item, {
        지역: region,
        검색키워드: query,
        순위: index + 1,
        구분: "비광고",
      });
    }), query);
    return {
      rows: regionRows,
      summary: {
        region,
        query,
        status,
        total: result.total,
        collected: regionRows.length,
        filteredOut: Math.min(items.length, REGIONAL_LIMIT) - regionRows.length,
        note: ""
      }
    };
  });
  for (const item of regionalResults) {
    rows.push(...(item?.rows || []));
    if (item?.summary) summaries.push(item.summary);
  }
  return { rows, summaries };
}

function skippedRegional(note = "빠른 순위 모드에서 지역별 반복 수집 생략") {
  return {
    rows: [],
    summaries: regions.map((region) => ({
      region,
      query: [province.short, region, RAW_KEYWORD_SUFFIX].filter(Boolean).join(" "),
      status: "skipped",
      total: 0,
      collected: 0,
      note
    }))
  };
}

function skippedNol(note = "빠른 순위 모드에서 보조 OTA 수집 생략") {
  return {
    status: "skipped",
    total: 0,
    rawFirstPage: 0,
    firstPage: 0,
    filteredOut: 0,
    companyFilteredOut: 0,
    note,
    rows: []
  };
}

function skippedYeogi(note = "빠른 순위 모드에서 여기어때 자동 확인 생략") {
  return {
    status: "skipped",
    attemptedUrl: "",
    finalUrl: "",
    blocked: true,
    reason: note,
    collectionDirection: "필요 시 수동 보완으로 확인",
    rows: []
  };
}

function skippedDdnayo(note = "빠른 순위 모드에서 떠나요 수집 생략") {
  return {
    exactTotal: 0,
    normalizedTotal: 0,
    usedQuery: "skipped",
    rawFirstPage: 0,
    firstPage: 0,
    filteredOut: 0,
    note,
    rows: []
  };
}

async function collectNol() {
  const url = "https://nol.yanolja.com/discovery/api/list/universal-search/v1/list";
  const countUrl = "https://nol.yanolja.com/discovery/api/list/universal-search/v1/count";
  const body = {
    keyword: QUERY,
    category: "LOCAL_ACCOMMODATION",
    filters: [],
    sort: "RECOMMEND",
    userLocation: {
      latitude: 37.5665,
      longitude: 126.978,
      locationType: "DEFAULT",
      locationTime: 0,
    },
    localAccommodation: {
      checkInDate: CHECK_IN,
      checkOutDate: CHECK_OUT,
      capacityAdults: ADULTS,
      childrenAges: [],
    },
    page: 1,
  };
  const commonHeaders = {
    accept: "application/json, text/plain, */*",
    "content-type": "application/json",
    origin: "https://nol.yanolja.com",
    referer: `https://nol.yanolja.com/discovery/s/results?keyword=${encodeURIComponent(
      QUERY,
    )}&verticalCategory=PRODUCT_CATEGORY_KOREA_ACCOMMODATION&checkInDate=${CHECK_IN}&checkOutDate=${CHECK_OUT}&capacityAdults=${ADULTS}`,
  };
  const [count, list] = await Promise.all([
    fetchJson(countUrl, {
      method: "POST",
      headers: commonHeaders,
      body: JSON.stringify(body),
    }),
    fetchJson(url, {
      method: "POST",
      headers: commonHeaders,
      body: JSON.stringify(body),
    })
  ]);

  const items = Array.isArray(list.data?.items) ? list.data.items.filter((item) => item.type === "PRODUCT_ITEM") : [];
  const rawRows = items.map((entry, index) => {
    const data = entry.data || {};
    const meta = entry.serverLogMeta || {};
    const price = data.prices?.[0];
    const isAd = Boolean(data.adText || meta.adSeq || meta.adTags);
    return {
      channel: "야놀자/NOL",
      section: isAd ? "광고" : "비광고",
      rank_or_order: index + 1,
      name: data.title || "",
      category: data.category || "",
      location: (data.locationDetails || []).join(", "),
      rating: data.review?.score || "",
      reviews: data.review?.count || "",
      price: price ? `${price.discountPrice || ""}${price.discountPriceUnit || ""}` : "",
      ad_flag: isAd ? "Y" : "N",
      url: data.action?.web || "",
    };
  });
  const relevantRows = filterCollectionRows(rawRows, QUERY, { legacyOtaFilter: true });
  const matchedRows = province.isCompany
    ? filterCompanyRows(relevantRows, (row) => row.name)
    : relevantRows;
  const rows = matchedRows.map((row, index) => ({
    ...row,
    rank_or_order: index + 1,
  }));

  return {
    status: list.res.status,
    total: count.data?.count ?? "",
    rawFirstPage: rawRows.length,
    firstPage: rows.length,
    filteredOut: rawRows.length - rows.length,
    companyFilteredOut: province.isCompany ? relevantRows.length - matchedRows.length : 0,
    rows,
  };
}

async function collectYeogi() {
  const url = `https://www.goodchoice.kr/product/result?keyword=${encodeURIComponent(QUERY)}`;
  const { res, text } = await fetchText(url);
  const blocked = res.status === 403 || text.includes("Sorry, you have been blocked");
  const reason = blocked
    ? "Cloudflare/WAF 403 차단: Node.js 직접 요청은 브라우저 검증(JS 챌린지, 쿠키, 브라우저 지문)을 통과하지 못했습니다."
    : "";
  const collectionDirection = blocked
    ? "제휴 API는 현실성 낮은 장기 옵션으로 두고, 단기는 사용자가 정상 접속한 브라우저 세션 기반 확인 또는 수동 CSV/HTML 가져오기로 보완합니다. 자동 차단 우회는 제외합니다."
    : "";
  return {
    status: res.status,
    attemptedUrl: url,
    finalUrl: res.url,
    blocked,
    reason,
    collectionDirection,
    rows: [],
  };
}

async function collectDdnayo() {
  async function search(query, pageSize = 24) {
    const url = `https://trip.ddnayo.com/web-api/total-search?searchKeyword=${encodeURIComponent(
      query,
    )}&pageNumber=1&pageSize=${pageSize}&orderBy=recommend`;
    return fetchJson(url, {
      headers: {
        accept: "application/json, text/plain, */*",
        referer: `https://trip.ddnayo.com/searchResult?searchKeyword=${encodeURIComponent(query)}`,
      },
    });
  }

  const [exact, normalized] = await Promise.all([
    search(DDNAYO_QUERY_EXACT, 10),
    search(DDNAYO_QUERY_NORMALIZED, 24)
  ]);
  const source = normalized.data?.data?.totalSize > 0 ? normalized : exact;
  const usedQuery = source === normalized ? DDNAYO_QUERY_NORMALIZED : DDNAYO_QUERY_EXACT;
  const contents = source.data?.data?.contents || [];
  const rawRows = contents.map((item, index) => ({
    channel: "떠나요",
    section: usedQuery === DDNAYO_QUERY_NORMALIZED ? "검색결과(공백제거 키워드)" : "검색결과",
    rank_or_order: index + 1,
    name: item.accommodationName || "",
    category: item.categoryName || item.accommodationType || item.category || "",
    location: item.address || "",
    rating: "",
    reviews: "",
    price: item.price ? `${Number(item.price).toLocaleString("ko-KR")}원부터` : "",
    ad_flag: "확인불가",
    url: item.productUrl || "",
  }));
  const relevantRows = filterCollectionRows(rawRows, usedQuery, { legacyOtaFilter: false });
  const rows = province.isCompany
    ? filterCompanyRows(relevantRows, (row) => row.name).map((row, index) => ({ ...row, rank_or_order: index + 1 }))
    : relevantRows;

  return {
    exactTotal: exact.data?.data?.totalSize ?? 0,
    normalizedTotal: normalized.data?.data?.totalSize ?? 0,
    usedQuery,
    rawFirstPage: rawRows.length,
    companyFilteredOut: province.isCompany ? rawRows.length - rows.length : 0,
    rows,
  };
}

function setNaverInventoryAuditFields(row) {
  row.핵심분석채널 = "핵심";
  row.채널재고해석 = "네이버예약은 ONDA/떠나요 등 전 채널 연동 재고와 분리 운영될 수 있어 네이버 날짜별 재고를 독립 기준으로 확인";
  row.전체객실수확인상태 = row.숙박확인재고수 || row.확인객실수
    ? `${row.숙박확인재고수 || row.확인객실수}개(${row.예약계산단위 || "네이버 숙박재고"} 기준, 전체 객실수 아님)`
    : row.네이버예약재고수집상태 || "미확인";
  row.채널수확인상태 = row.네이버예약사업자ID ? "네이버예약 채널 단독 확인" : "네이버예약 채널 미확인";
  row.네이버분리확인 = "네이버 분리 가능성 있음";
}

function platformInventoryAuditFields(channel, row = {}) {
  if (channel === "네이버") {
    return {
      핵심분석채널: "핵심",
      채널재고해석: "네이버예약은 ONDA/떠나요 등 전 채널 연동 재고와 분리 운영될 수 있어 네이버 날짜별 재고를 독립 기준으로 확인",
      전체객실수확인상태: row["숙박확인재고수"] || row["확인객실수"]
        ? `${row["숙박확인재고수"] || row["확인객실수"]}개(${row["예약계산단위"] || "네이버 숙박재고"} 기준, 전체 객실수 아님)`
        : "미확인",
      채널수확인상태: row["네이버예약사업자ID"] ? "네이버예약 채널 단독 확인" : "네이버예약 채널 미확인",
      네이버분리확인: "네이버 분리 가능성 있음",
    };
  }
  if (channel === "야놀자/NOL") {
    return {
      핵심분석채널: "핵심",
      채널재고해석: "야놀자/NOL 검색 노출·가격 기준. 전체 객실수와 채널별 배정수는 상세 재고 확인 필요",
      전체객실수확인상태: "목록 단계 미확인",
      채널수확인상태: "야놀자/NOL 채널 노출 확인, 전체 연동 채널수 미확인",
      네이버분리확인: "네이버 재고와 별도 비교 필요",
    };
  }
  if (channel === "떠나요") {
    return {
      핵심분석채널: "핵심(떠나요/ONDA)",
      채널재고해석: "떠나요/ONDA 계열 전 채널 연동 후보. 전체 객실수와 채널별 배정수 확인 필요, 네이버는 별도일 수 있음",
      전체객실수확인상태: "목록 단계 미확인",
      채널수확인상태: "전 채널 연동 가능성 있음, 채널수 상세 미확인",
      네이버분리확인: "네이버 재고와 별도 비교 필요",
    };
  }
  return {
    핵심분석채널: "보조",
    채널재고해석: "보조/수동 보완 채널. 핵심 재고 판단에서 제외",
    전체객실수확인상태: "미확인",
    채널수확인상태: "미확인",
    네이버분리확인: "비교 대상 아님",
  };
}

function naverRevenueFields(row = {}) {
  return {
    "숙박기준일예상매출": row.숙박기준일예상매출 ?? "",
    basisLodgingAdjustedRevenue: row.basisLodgingAdjustedRevenue ?? "",
    basisLodgingMissingPriceEstimatedRevenue: row.basisLodgingMissingPriceEstimatedRevenue ?? "",
    basisLodgingRevenuePrecisionRate: row.basisLodgingRevenuePrecisionRate ?? "",
    "숙박기준일가격확인판매수량": row.숙박기준일가격확인판매수량 ?? "",
    "숙박기준일가격누락판매수량": row.숙박기준일가격누락판매수량 ?? "",
    "숙박기준일평균판매단가": row.숙박기준일평균판매단가 ?? "",
    "데이유즈기준일예상매출": row.데이유즈기준일예상매출 ?? "",
    "데이유즈기준일가격확인판매수량": row.데이유즈기준일가격확인판매수량 ?? "",
    "데이유즈기준일가격누락판매수량": row.데이유즈기준일가격누락판매수량 ?? "",
    "데이유즈기준일평균판매단가": row.데이유즈기준일평균판매단가 ?? "",
    basisDayUseAdjustedRevenue: row.basisDayUseAdjustedRevenue ?? "",
    basisDayUseMissingPriceEstimatedRevenue: row.basisDayUseMissingPriceEstimatedRevenue ?? "",
    basisDayUseRevenuePrecisionRate: row.basisDayUseRevenuePrecisionRate ?? "",
    "주간숙박예상매출": row.주간숙박예상매출 ?? "",
    weeklyAdjustedRevenue: row.weeklyAdjustedRevenue ?? "",
    weeklyMissingPriceEstimatedRevenue: row.weeklyMissingPriceEstimatedRevenue ?? "",
    weeklyRevenuePrecisionRate: row.weeklyRevenuePrecisionRate ?? "",
    "주간숙박가격확인판매수량": row.주간숙박가격확인판매수량 ?? "",
    "주간숙박가격누락판매수량": row.주간숙박가격누락판매수량 ?? "",
    "주간숙박평균판매단가": row.주간숙박평균판매단가 ?? "",
    "주간숙박매출상세": row.주간숙박매출상세 || "",
    "주간숙박요일매출": row.주간숙박요일매출 || "",
    "주간숙박오프라인예약상세": row.주간숙박오프라인예약상세 || "",
    dayUseWeeklyEstimatedRevenue: row.dayUseWeeklyEstimatedRevenue ?? "",
    dayUseWeeklyAdjustedRevenue: row.dayUseWeeklyAdjustedRevenue ?? "",
    dayUseWeeklyMissingPriceEstimatedRevenue: row.dayUseWeeklyMissingPriceEstimatedRevenue ?? "",
    dayUseWeeklyRevenuePrecisionRate: row.dayUseWeeklyRevenuePrecisionRate ?? "",
    dayUseWeeklyPricedSoldOut: row.dayUseWeeklyPricedSoldOut ?? "",
    dayUseWeeklyMissingPriceSoldOut: row.dayUseWeeklyMissingPriceSoldOut ?? "",
    dayUseWeeklyAvgSoldUnitPrice: row.dayUseWeeklyAvgSoldUnitPrice ?? "",
    dayUseWeeklyRevenueDetail: row.dayUseWeeklyRevenueDetail || "",
    dayUseWeeklyRevenueByDayType: row.dayUseWeeklyRevenueByDayType || "",
    dayUseWeeklyOfflineReservationDetail: row.dayUseWeeklyOfflineReservationDetail || "",
  };
}

function toPlatformRows(naver, nol, yeogi, ddnayo) {
  const rows = [
    ...naver.overall.slice(0, 20).map((row) => ({
      channel: "네이버",
      section: "비광고",
      rank_or_order: row.overall_rank,
      name: row.업체명,
      category: row.카테고리,
      location: row.주소,
      rating: row.평점,
      reviews: row.총리뷰,
      price: row.금액,
      ad_flag: "N",
      url: row.url,
      "네이버예약사업자ID": row.네이버예약사업자ID || "",
      "예약리스트유형": row.예약리스트유형 || "",
      "네이버상품구성": row.네이버상품구성 || "",
      "숙박상품수": row.숙박상품수 ?? "",
      "데이유즈상품수": row.데이유즈상품수 ?? "",
      "예약계산대상상품수": row.예약계산대상상품수 ?? "",
      "예약가능객실수": row.예약가능객실수 ?? "",
      "확인객실수": row.확인객실수 ?? "",
      "예약가능률": row.예약가능률 ?? "",
      "숙박예약가능수": row.숙박예약가능수 ?? "",
      "숙박확인재고수": row.숙박확인재고수 ?? "",
      "숙박예약가능률": row.숙박예약가능률 ?? "",
      "숙박판매완료수": row.숙박판매완료수 ?? "",
      "숙박판매완료율": row.숙박판매완료율 ?? "",
      ...naverRevenueFields(row),
      "예약계산단위": row.예약계산단위 || "",
      "네이버원시예약가능재고": row.네이버원시예약가능재고 ?? "",
      "네이버원시전체재고": row.네이버원시전체재고 ?? "",
      "네이버묶음객실범위수": row.네이버묶음객실범위수 ?? "",
      "데이유즈예약가능수": row.데이유즈예약가능수 ?? "",
      "데이유즈확인재고수": row.데이유즈확인재고수 ?? "",
      "데이유즈예약가능률": row.데이유즈예약가능률 ?? "",
      "데이유즈계산대상상품수": row.데이유즈계산대상상품수 ?? "",
      "네이버쿠폰노출상태": row.네이버쿠폰노출상태 || "",
      "네이버쿠폰명": row.네이버쿠폰명 || "",
      "네이버쿠폰확인채널": row.네이버쿠폰확인채널 || "",
      "네이버쿠폰상세": row.네이버쿠폰상세 || "",
      "네이버재고범위": row.네이버재고범위 || "",
      "객실수검증메모": row.객실수검증메모 || "",
      "주간재고수집일수": row.주간재고수집일수 ?? "",
      "주간잔여요약": row.주간잔여요약 || "",
      "주간평균잔여수": row.주간평균잔여수 ?? "",
      "주간최소잔여수": row.주간최소잔여수 ?? "",
      "주간마감일수": row.주간마감일수 ?? "",
      "주간판매수량합계": row.주간판매수량합계 ?? "",
      "주간전체수량합계": row.주간전체수량합계 ?? "",
      "주간기준재고수": row.주간기준재고수 ?? "",
      "주간운영판매기준수": row.주간운영판매기준수 ?? "",
      "주간운영판매기준확인일수": row.주간운영판매기준확인일수 ?? "",
      "주간상시차단추정수": row.주간상시차단추정수 ?? "",
      "주간총량판단유형": row.주간총량판단유형 || "",
      "주간총량최소값": row.주간총량최소값 ?? "",
      "주간총량최대값": row.주간총량최대값 ?? "",
      "주간최대총량확인일수": row.주간최대총량확인일수 ?? "",
      "주간총량편차": row.주간총량편차 ?? "",
      "주간숙박오프라인예약추정수": row.주간숙박오프라인예약추정수 ?? "",
      "주간숙박총량기준": row.주간숙박총량기준 || "",
      "주간원시재고변동": row.주간원시재고변동 || "",
      "주간잔여상세": row.주간잔여상세 || "",
      "주간평균예약률": row.주간평균예약률 ?? "",
      "주간예약률상세": row.주간예약률상세 || "",
      dayUseWeeklyDays: row.dayUseWeeklyDays ?? "",
      dayUseWeeklySummary: row.dayUseWeeklySummary || "",
      dayUseWeeklyAvgAvailable: row.dayUseWeeklyAvgAvailable ?? "",
      dayUseWeeklyMinAvailable: row.dayUseWeeklyMinAvailable ?? "",
      dayUseWeeklySoldOutDays: row.dayUseWeeklySoldOutDays ?? "",
      dayUseWeeklyTotalSoldOut: row.dayUseWeeklyTotalSoldOut ?? "",
      dayUseWeeklyTotalStock: row.dayUseWeeklyTotalStock ?? "",
      dayUseWeeklyBasisTotal: row.dayUseWeeklyBasisTotal ?? "",
      dayUseWeeklyOperatingTotal: row.dayUseWeeklyOperatingTotal ?? "",
      dayUseWeeklyOperatingTotalDays: row.dayUseWeeklyOperatingTotalDays ?? "",
      dayUseWeeklyStructuralBlockedTotal: row.dayUseWeeklyStructuralBlockedTotal ?? "",
      dayUseWeeklyStockBasisType: row.dayUseWeeklyStockBasisType || "",
      dayUseWeeklyMinTotal: row.dayUseWeeklyMinTotal ?? "",
      dayUseWeeklyMaxTotal: row.dayUseWeeklyMaxTotal ?? "",
      dayUseWeeklyMaxTotalDays: row.dayUseWeeklyMaxTotalDays ?? "",
      dayUseWeeklyTotalVarianceGap: row.dayUseWeeklyTotalVarianceGap ?? "",
      dayUseWeeklyOfflineReservedTotal: row.dayUseWeeklyOfflineReservedTotal ?? "",
      dayUseWeeklyBasisRule: row.dayUseWeeklyBasisRule || "",
      dayUseWeeklyRawStockVariance: row.dayUseWeeklyRawStockVariance || "",
      dayUseWeeklyDetail: row.dayUseWeeklyDetail || "",
      dayUseWeeklyAvgReservationRate: row.dayUseWeeklyAvgReservationRate ?? "",
      dayUseWeeklyReservationRateDetail: row.dayUseWeeklyReservationRateDetail || "",
      "예약가능근거": row.예약가능근거 || "",
    })),
    ...naver.ads.map((row) => ({
      channel: "네이버",
      section: "광고",
      rank_or_order: row.ad_order,
      name: row.업체명,
      category: row.카테고리,
      location: row.주소,
      rating: row.평점,
      reviews: row.총리뷰,
      price: row.금액,
      ad_flag: "Y",
      url: row.url,
      "네이버예약사업자ID": row.네이버예약사업자ID || "",
      "예약리스트유형": row.예약리스트유형 || "",
      "네이버상품구성": row.네이버상품구성 || "",
      "숙박상품수": row.숙박상품수 ?? "",
      "데이유즈상품수": row.데이유즈상품수 ?? "",
      "예약계산대상상품수": row.예약계산대상상품수 ?? "",
      "예약가능객실수": row.예약가능객실수 ?? "",
      "확인객실수": row.확인객실수 ?? "",
      "예약가능률": row.예약가능률 ?? "",
      "숙박예약가능수": row.숙박예약가능수 ?? "",
      "숙박확인재고수": row.숙박확인재고수 ?? "",
      "숙박예약가능률": row.숙박예약가능률 ?? "",
      "숙박판매완료수": row.숙박판매완료수 ?? "",
      "숙박판매완료율": row.숙박판매완료율 ?? "",
      ...naverRevenueFields(row),
      "예약계산단위": row.예약계산단위 || "",
      "네이버원시예약가능재고": row.네이버원시예약가능재고 ?? "",
      "네이버원시전체재고": row.네이버원시전체재고 ?? "",
      "네이버묶음객실범위수": row.네이버묶음객실범위수 ?? "",
      "데이유즈예약가능수": row.데이유즈예약가능수 ?? "",
      "데이유즈확인재고수": row.데이유즈확인재고수 ?? "",
      "데이유즈예약가능률": row.데이유즈예약가능률 ?? "",
      "데이유즈계산대상상품수": row.데이유즈계산대상상품수 ?? "",
      "네이버쿠폰노출상태": row.네이버쿠폰노출상태 || "",
      "네이버쿠폰명": row.네이버쿠폰명 || "",
      "네이버쿠폰확인채널": row.네이버쿠폰확인채널 || "",
      "네이버쿠폰상세": row.네이버쿠폰상세 || "",
      "네이버재고범위": row.네이버재고범위 || "",
      "객실수검증메모": row.객실수검증메모 || "",
      "주간재고수집일수": row.주간재고수집일수 ?? "",
      "주간잔여요약": row.주간잔여요약 || "",
      "주간평균잔여수": row.주간평균잔여수 ?? "",
      "주간최소잔여수": row.주간최소잔여수 ?? "",
      "주간마감일수": row.주간마감일수 ?? "",
      "주간판매수량합계": row.주간판매수량합계 ?? "",
      "주간전체수량합계": row.주간전체수량합계 ?? "",
      "주간기준재고수": row.주간기준재고수 ?? "",
      "주간운영판매기준수": row.주간운영판매기준수 ?? "",
      "주간운영판매기준확인일수": row.주간운영판매기준확인일수 ?? "",
      "주간상시차단추정수": row.주간상시차단추정수 ?? "",
      "주간총량판단유형": row.주간총량판단유형 || "",
      "주간총량최소값": row.주간총량최소값 ?? "",
      "주간총량최대값": row.주간총량최대값 ?? "",
      "주간최대총량확인일수": row.주간최대총량확인일수 ?? "",
      "주간총량편차": row.주간총량편차 ?? "",
      "주간숙박오프라인예약추정수": row.주간숙박오프라인예약추정수 ?? "",
      "주간숙박총량기준": row.주간숙박총량기준 || "",
      "주간원시재고변동": row.주간원시재고변동 || "",
      "주간잔여상세": row.주간잔여상세 || "",
      "주간평균예약률": row.주간평균예약률 ?? "",
      "주간예약률상세": row.주간예약률상세 || "",
      dayUseWeeklyDays: row.dayUseWeeklyDays ?? "",
      dayUseWeeklySummary: row.dayUseWeeklySummary || "",
      dayUseWeeklyAvgAvailable: row.dayUseWeeklyAvgAvailable ?? "",
      dayUseWeeklyMinAvailable: row.dayUseWeeklyMinAvailable ?? "",
      dayUseWeeklySoldOutDays: row.dayUseWeeklySoldOutDays ?? "",
      dayUseWeeklyTotalSoldOut: row.dayUseWeeklyTotalSoldOut ?? "",
      dayUseWeeklyTotalStock: row.dayUseWeeklyTotalStock ?? "",
      dayUseWeeklyBasisTotal: row.dayUseWeeklyBasisTotal ?? "",
      dayUseWeeklyOperatingTotal: row.dayUseWeeklyOperatingTotal ?? "",
      dayUseWeeklyOperatingTotalDays: row.dayUseWeeklyOperatingTotalDays ?? "",
      dayUseWeeklyStructuralBlockedTotal: row.dayUseWeeklyStructuralBlockedTotal ?? "",
      dayUseWeeklyStockBasisType: row.dayUseWeeklyStockBasisType || "",
      dayUseWeeklyMinTotal: row.dayUseWeeklyMinTotal ?? "",
      dayUseWeeklyMaxTotal: row.dayUseWeeklyMaxTotal ?? "",
      dayUseWeeklyMaxTotalDays: row.dayUseWeeklyMaxTotalDays ?? "",
      dayUseWeeklyTotalVarianceGap: row.dayUseWeeklyTotalVarianceGap ?? "",
      dayUseWeeklyOfflineReservedTotal: row.dayUseWeeklyOfflineReservedTotal ?? "",
      dayUseWeeklyBasisRule: row.dayUseWeeklyBasisRule || "",
      dayUseWeeklyRawStockVariance: row.dayUseWeeklyRawStockVariance || "",
      dayUseWeeklyDetail: row.dayUseWeeklyDetail || "",
      dayUseWeeklyAvgReservationRate: row.dayUseWeeklyAvgReservationRate ?? "",
      dayUseWeeklyReservationRateDetail: row.dayUseWeeklyReservationRateDetail || "",
      "예약가능근거": row.예약가능근거 || "",
    })),
    ...nol.rows,
    ...(yeogi.blocked
      ? [
          {
            channel: "여기어때",
            section: "차단",
            rank_or_order: "",
            name: "Cloudflare 403 차단",
            category: "WAF/Cloudflare",
            location: "브라우저 검증 필요",
            rating: "",
            reviews: "",
            price: "수집불가",
            ad_flag: "확인불가",
            url: yeogi.finalUrl,
            "실패 원인": yeogi.reason,
            "수집 방향": yeogi.collectionDirection,
          },
        ]
      : yeogi.rows),
    ...ddnayo.rows,
  ];
  for (const row of rows) {
    const isAd = row.ad_flag === "Y";
    const adCluster =
      row.channel === "떠나요" || row.channel === "여기어때"
        ? "확인불가"
        : isAd
          ? "광고 집행"
          : "비광고 상위 노출";
    addClusterFields(row, {
      searchKeyword: row.channel === "네이버" ? NAVER_QUERY : QUERY,
      searchCluster: row.channel === "네이버" ? province.short : "",
      adCluster,
    });
    Object.assign(row, platformInventoryAuditFields(row.channel, row));
  }
  return rows;
}

async function main() {
  const collectionStartedAt = new Date().toISOString();
  await fs.mkdir(OUTPUT_DIR, { recursive: true });

  console.log("Collecting Naver main...");
  const naver = await collectNaverMain();

  console.log(`Collection profile: ${COLLECTION_PROFILE.label} - ${COLLECTION_PROFILE.note}`);

  console.log(COLLECTION_PROFILE.collectRegional ? "Collecting Naver regional clusters..." : `Skipping Naver regional clusters: ${COLLECTION_PROFILE.regionalSkipNote || COLLECTION_PROFILE.note}`);
  const regional = COLLECTION_PROFILE.collectRegional ? await collectNaverRegional() : skippedRegional(COLLECTION_PROFILE.regionalSkipNote || COLLECTION_PROFILE.note);

  console.log(COLLECTION_PROFILE.collectOta ? "Collecting NOL..." : `Skipping NOL: ${COLLECTION_PROFILE.otaSkipNote || COLLECTION_PROFILE.note}`);
  const nol = COLLECTION_PROFILE.collectOta ? await collectNol() : skippedNol(COLLECTION_PROFILE.otaSkipNote || COLLECTION_PROFILE.note);

  console.log(COLLECTION_PROFILE.collectOta ? "Checking Yeogi..." : `Skipping Yeogi: ${COLLECTION_PROFILE.otaSkipNote || COLLECTION_PROFILE.note}`);
  const yeogi = COLLECTION_PROFILE.collectOta ? await collectYeogi() : skippedYeogi(COLLECTION_PROFILE.otaSkipNote || COLLECTION_PROFILE.note);

  console.log(COLLECTION_PROFILE.collectOta ? "Collecting DDNayo..." : `Skipping DDNayo: ${COLLECTION_PROFILE.otaSkipNote || COLLECTION_PROFILE.note}`);
  const ddnayo = COLLECTION_PROFILE.collectOta ? await collectDdnayo() : skippedDdnayo(COLLECTION_PROFILE.otaSkipNote || COLLECTION_PROFILE.note);

  applyNaverAdClusters(naver, regional.rows);
  console.log("Checking Naver booking stock...");
  const naverBookingStock = await enrichNaverRowsWithBookingAvailability([
    ...naver.overall,
    ...naver.ads,
    ...regional.rows,
  ]);
  const platformRows = toPlatformRows(naver, nol, yeogi, ddnayo);

  const revenueColumns = [
    "숙박기준일예상매출",
    "basisLodgingAdjustedRevenue",
    "basisLodgingMissingPriceEstimatedRevenue",
    "basisLodgingRevenuePrecisionRate",
    "숙박기준일가격확인판매수량",
    "숙박기준일가격누락판매수량",
    "숙박기준일평균판매단가",
    "데이유즈기준일예상매출",
    "데이유즈기준일가격확인판매수량",
    "데이유즈기준일가격누락판매수량",
    "데이유즈기준일평균판매단가",
    "basisDayUseAdjustedRevenue",
    "basisDayUseMissingPriceEstimatedRevenue",
    "basisDayUseRevenuePrecisionRate",
    "주간숙박예상매출",
    "weeklyAdjustedRevenue",
    "weeklyMissingPriceEstimatedRevenue",
    "weeklyRevenuePrecisionRate",
    "주간숙박가격확인판매수량",
    "주간숙박가격누락판매수량",
    "주간숙박평균판매단가",
    "주간숙박매출상세",
    "주간숙박요일매출",
    "주간숙박오프라인예약상세",
    "dayUseWeeklyEstimatedRevenue",
    "dayUseWeeklyAdjustedRevenue",
    "dayUseWeeklyMissingPriceEstimatedRevenue",
    "dayUseWeeklyRevenuePrecisionRate",
    "dayUseWeeklyPricedSoldOut",
    "dayUseWeeklyMissingPriceSoldOut",
    "dayUseWeeklyAvgSoldUnitPrice",
    "dayUseWeeklyRevenueDetail",
    "dayUseWeeklyRevenueByDayType",
    "dayUseWeeklyOfflineReservationDetail",
  ];

  const lodgingSearchDiagnosticColumns = [
    "requestedLodgingCategoryKey",
    "detectedLodgingCategoryKey",
    "detectedLodgingCategoryTags",
    "categoryConfidence",
    "categoryEvidence",
    "relevanceScore",
    "relevanceStatus",
    "relevanceRejectionReason",
    "searchIntent",
    "searchRegionKey",
    "searchRegionQuery",
    "searchCompanyName",
    "sourceQuery"
  ];
  const platformColumns = [
    "기준키워드",
    "검색키워드",
    "검색클러스터",
    "소재지클러스터",
    "관광권역클러스터",
    "상품유형클러스터",
    "가격대클러스터",
    "광고집행클러스터",
    "핵심분석채널",
    "채널재고해석",
    "전체객실수확인상태",
    "채널수확인상태",
    "네이버분리확인",
    "channel",
    "section",
    "rank_or_order",
    "name",
    "category",
    "location",
    "rating",
    "reviews",
    "price",
    "ad_flag",
    "url",
    ...lodgingSearchDiagnosticColumns,
    "예약리스트유형",
    "네이버상품구성",
    "숙박상품수",
    "데이유즈상품수",
    "예약계산대상상품수",
    "예약가능객실수",
    "확인객실수",
    "예약가능률",
    "숙박예약가능수",
    "숙박확인재고수",
    "숙박예약가능률",
    "숙박판매완료수",
    "숙박판매완료율",
    "예약계산단위",
    "네이버원시예약가능재고",
    "네이버원시전체재고",
    "네이버묶음객실범위수",
    "데이유즈예약가능수",
    "데이유즈확인재고수",
    "데이유즈예약가능률",
    "데이유즈계산대상상품수",
    "네이버쿠폰노출상태",
    "네이버쿠폰명",
    "네이버쿠폰확인채널",
    "네이버쿠폰상세",
    "네이버상품상세JSON",
    "네이버요일별상품상세JSON",
    "dayUseWeeklyProductDetailsJson",
    "네이버재고범위",
    "객실수검증메모",
    "주간재고수집일수",
    "주간잔여요약",
    "주간평균잔여수",
    "주간최소잔여수",
    "주간마감일수",
    "주간판매수량합계",
    "주간전체수량합계",
    "주간기준재고수",
    "주간운영판매기준수",
    "주간운영판매기준확인일수",
    "주간상시차단추정수",
    "주간총량판단유형",
    "주간총량최소값",
    "주간총량최대값",
    "주간최대총량확인일수",
    "주간총량편차",
    "주간숙박오프라인예약추정수",
    "주간숙박총량기준",
    "주간원시재고변동",
    "주간잔여상세",
    "주간평균예약률",
    "주간예약률상세",
    "dayUseWeeklyDays",
    "dayUseWeeklySummary",
    "dayUseWeeklyAvgAvailable",
    "dayUseWeeklyMinAvailable",
    "dayUseWeeklySoldOutDays",
    "dayUseWeeklyTotalSoldOut",
    "dayUseWeeklyTotalStock",
    "dayUseWeeklyBasisTotal",
    "dayUseWeeklyOperatingTotal",
    "dayUseWeeklyOperatingTotalDays",
    "dayUseWeeklyStructuralBlockedTotal",
    "dayUseWeeklyStockBasisType",
    "dayUseWeeklyMinTotal",
    "dayUseWeeklyMaxTotal",
    "dayUseWeeklyMaxTotalDays",
    "dayUseWeeklyTotalVarianceGap",
    "dayUseWeeklyOfflineReservedTotal",
    "dayUseWeeklyBasisRule",
    "dayUseWeeklyRawStockVariance",
    "dayUseWeeklyDetail",
    "dayUseWeeklyAvgReservationRate",
    "dayUseWeeklyReservationRateDetail",
    ...revenueColumns,
    "예약가능근거",
    "실패 원인",
    "수집 방향",
  ];
  const overallColumns = [
    "기준키워드",
    "검색키워드",
    "검색클러스터",
    "소재지클러스터",
    "관광권역클러스터",
    "상품유형클러스터",
    "가격대클러스터",
    "광고집행클러스터",
    "핵심분석채널",
    "채널재고해석",
    "전체객실수확인상태",
    "채널수확인상태",
    "네이버분리확인",
    "query",
    ...lodgingSearchDiagnosticColumns,
    "overall_rank",
    "구분",
    "place_id",
    "업체명",
    "카테고리",
    "주소",
    "객실수(노출)",
    "객실명(일부)",
    "금액",
    "특장점",
    "총리뷰",
    "방문자리뷰",
    "평점",
    "예약",
    "네이버예약재고수집상태",
    "네이버예약사업자ID",
    "네이버예약URL",
    "예약리스트유형",
    "네이버상품구성",
    "숙박상품수",
    "데이유즈상품수",
    "미분류상품수",
    "예약계산대상상품수",
    "예약가능객실수",
    "확인객실수",
    "예약가능률",
    "숙박예약가능수",
    "숙박확인재고수",
    "숙박예약가능률",
    "숙박판매완료수",
    "숙박판매완료율",
    "예약계산단위",
    "네이버원시예약가능재고",
    "네이버원시전체재고",
    "네이버묶음객실범위수",
    "데이유즈예약가능수",
    "데이유즈확인재고수",
    "데이유즈예약가능률",
    "데이유즈계산대상상품수",
    "네이버쿠폰노출상태",
    "네이버쿠폰명",
    "네이버쿠폰확인채널",
    "네이버쿠폰상세",
    "네이버상품상세JSON",
    "네이버요일별상품상세JSON",
    "dayUseWeeklyProductDetailsJson",
    "네이버재고범위",
    "객실수검증메모",
    "주간재고수집일수",
    "주간잔여요약",
    "주간평균잔여수",
    "주간최소잔여수",
    "주간마감일수",
    "주간판매수량합계",
    "주간전체수량합계",
    "주간기준재고수",
    "주간운영판매기준수",
    "주간운영판매기준확인일수",
    "주간상시차단추정수",
    "주간총량판단유형",
    "주간총량최소값",
    "주간총량최대값",
    "주간최대총량확인일수",
    "주간총량편차",
    "주간숙박오프라인예약추정수",
    "주간숙박총량기준",
    "주간원시재고변동",
    "주간잔여상세",
    "주간평균예약률",
    "주간예약률상세",
    "dayUseWeeklyDays",
    "dayUseWeeklySummary",
    "dayUseWeeklyAvgAvailable",
    "dayUseWeeklyMinAvailable",
    "dayUseWeeklySoldOutDays",
    "dayUseWeeklyTotalSoldOut",
    "dayUseWeeklyTotalStock",
    "dayUseWeeklyBasisTotal",
    "dayUseWeeklyOperatingTotal",
    "dayUseWeeklyOperatingTotalDays",
    "dayUseWeeklyStructuralBlockedTotal",
    "dayUseWeeklyStockBasisType",
    "dayUseWeeklyMinTotal",
    "dayUseWeeklyMaxTotal",
    "dayUseWeeklyMaxTotalDays",
    "dayUseWeeklyTotalVarianceGap",
    "dayUseWeeklyOfflineReservedTotal",
    "dayUseWeeklyBasisRule",
    "dayUseWeeklyRawStockVariance",
    "dayUseWeeklyDetail",
    "dayUseWeeklyAvgReservationRate",
    "dayUseWeeklyReservationRateDetail",
    ...revenueColumns,
    "예약최저가",
    "예약가능근거",
    "url",
  ];
  const adColumns = [
    "기준키워드",
    "검색키워드",
    "검색클러스터",
    "소재지클러스터",
    "관광권역클러스터",
    "상품유형클러스터",
    "가격대클러스터",
    "광고집행클러스터",
    "핵심분석채널",
    "채널재고해석",
    "전체객실수확인상태",
    "채널수확인상태",
    "네이버분리확인",
    "query",
    ...lodgingSearchDiagnosticColumns,
    "ad_order",
    "구분",
    "ad_id",
    "ad_description",
    "place_id",
    "업체명",
    "카테고리",
    "주소",
    "객실수(노출)",
    "객실명(일부)",
    "금액",
    "특장점",
    "총리뷰",
    "방문자리뷰",
    "평점",
    "예약",
    "네이버예약재고수집상태",
    "네이버예약사업자ID",
    "네이버예약URL",
    "예약리스트유형",
    "네이버상품구성",
    "숙박상품수",
    "데이유즈상품수",
    "미분류상품수",
    "예약계산대상상품수",
    "예약가능객실수",
    "확인객실수",
    "예약가능률",
    "숙박예약가능수",
    "숙박확인재고수",
    "숙박예약가능률",
    "숙박판매완료수",
    "숙박판매완료율",
    "예약계산단위",
    "네이버원시예약가능재고",
    "네이버원시전체재고",
    "네이버묶음객실범위수",
    "데이유즈예약가능수",
    "데이유즈확인재고수",
    "데이유즈예약가능률",
    "데이유즈계산대상상품수",
    "네이버쿠폰노출상태",
    "네이버쿠폰명",
    "네이버쿠폰확인채널",
    "네이버쿠폰상세",
    "네이버상품상세JSON",
    "네이버요일별상품상세JSON",
    "dayUseWeeklyProductDetailsJson",
    "네이버재고범위",
    "객실수검증메모",
    "주간재고수집일수",
    "주간잔여요약",
    "주간평균잔여수",
    "주간최소잔여수",
    "주간마감일수",
    "주간판매수량합계",
    "주간전체수량합계",
    "주간기준재고수",
    "주간운영판매기준수",
    "주간운영판매기준확인일수",
    "주간상시차단추정수",
    "주간총량판단유형",
    "주간총량최소값",
    "주간총량최대값",
    "주간최대총량확인일수",
    "주간총량편차",
    "주간숙박오프라인예약추정수",
    "주간숙박총량기준",
    "주간원시재고변동",
    "주간잔여상세",
    "주간평균예약률",
    "주간예약률상세",
    "dayUseWeeklyDays",
    "dayUseWeeklySummary",
    "dayUseWeeklyAvgAvailable",
    "dayUseWeeklyMinAvailable",
    "dayUseWeeklySoldOutDays",
    "dayUseWeeklyTotalSoldOut",
    "dayUseWeeklyTotalStock",
    "dayUseWeeklyBasisTotal",
    "dayUseWeeklyOperatingTotal",
    "dayUseWeeklyOperatingTotalDays",
    "dayUseWeeklyStructuralBlockedTotal",
    "dayUseWeeklyStockBasisType",
    "dayUseWeeklyMinTotal",
    "dayUseWeeklyMaxTotal",
    "dayUseWeeklyMaxTotalDays",
    "dayUseWeeklyTotalVarianceGap",
    "dayUseWeeklyOfflineReservedTotal",
    "dayUseWeeklyBasisRule",
    "dayUseWeeklyRawStockVariance",
    "dayUseWeeklyDetail",
    "dayUseWeeklyAvgReservationRate",
    "dayUseWeeklyReservationRateDetail",
    ...revenueColumns,
    "예약최저가",
    "예약가능근거",
    "url",
  ];
  const regionalColumns = [
    ...lodgingSearchDiagnosticColumns,
    "기준키워드",
    "검색키워드",
    "검색클러스터",
    "소재지클러스터",
    "관광권역클러스터",
    "상품유형클러스터",
    "가격대클러스터",
    "광고집행클러스터",
    "핵심분석채널",
    "채널재고해석",
    "전체객실수확인상태",
    "채널수확인상태",
    "네이버분리확인",
    "지역",
    "순위",
    "구분",
    "place_id",
    "업체명",
    "카테고리",
    "주소",
    "객실수(노출)",
    "객실명(일부)",
    "금액",
    "특장점",
    "총리뷰",
    "방문자리뷰",
    "평점",
    "예약",
    "네이버예약재고수집상태",
    "네이버예약사업자ID",
    "네이버예약URL",
    "예약리스트유형",
    "네이버상품구성",
    "숙박상품수",
    "데이유즈상품수",
    "미분류상품수",
    "예약계산대상상품수",
    "예약가능객실수",
    "확인객실수",
    "예약가능률",
    "숙박예약가능수",
    "숙박확인재고수",
    "숙박예약가능률",
    "숙박판매완료수",
    "숙박판매완료율",
    "예약계산단위",
    "네이버원시예약가능재고",
    "네이버원시전체재고",
    "네이버묶음객실범위수",
    "데이유즈예약가능수",
    "데이유즈확인재고수",
    "데이유즈예약가능률",
    "데이유즈계산대상상품수",
    "네이버쿠폰노출상태",
    "네이버쿠폰명",
    "네이버쿠폰확인채널",
    "네이버쿠폰상세",
    "네이버상품상세JSON",
    "네이버요일별상품상세JSON",
    "dayUseWeeklyProductDetailsJson",
    "네이버재고범위",
    "객실수검증메모",
    "주간재고수집일수",
    "주간잔여요약",
    "주간평균잔여수",
    "주간최소잔여수",
    "주간마감일수",
    "주간판매수량합계",
    "주간전체수량합계",
    "주간기준재고수",
    "주간운영판매기준수",
    "주간운영판매기준확인일수",
    "주간상시차단추정수",
    "주간총량판단유형",
    "주간총량최소값",
    "주간총량최대값",
    "주간최대총량확인일수",
    "주간총량편차",
    "주간숙박오프라인예약추정수",
    "주간숙박총량기준",
    "주간원시재고변동",
    "주간잔여상세",
    "주간평균예약률",
    "주간예약률상세",
    "dayUseWeeklyDays",
    "dayUseWeeklySummary",
    "dayUseWeeklyAvgAvailable",
    "dayUseWeeklyMinAvailable",
    "dayUseWeeklySoldOutDays",
    "dayUseWeeklyTotalSoldOut",
    "dayUseWeeklyTotalStock",
    "dayUseWeeklyBasisTotal",
    "dayUseWeeklyOperatingTotal",
    "dayUseWeeklyOperatingTotalDays",
    "dayUseWeeklyStructuralBlockedTotal",
    "dayUseWeeklyStockBasisType",
    "dayUseWeeklyMinTotal",
    "dayUseWeeklyMaxTotal",
    "dayUseWeeklyMaxTotalDays",
    "dayUseWeeklyTotalVarianceGap",
    "dayUseWeeklyOfflineReservedTotal",
    "dayUseWeeklyBasisRule",
    "dayUseWeeklyRawStockVariance",
    "dayUseWeeklyDetail",
    "dayUseWeeklyAvgReservationRate",
    "dayUseWeeklyReservationRateDetail",
    ...revenueColumns,
    "예약최저가",
    "예약가능근거",
    "url",
  ];
  const underfilledRegions = province.isCompany
    ? "업체명 모드는 지역별 키워드 반복 수집 제외"
    : regional.summaries
        .filter((item) => item.collected < REGIONAL_LIMIT)
        .map((item) => `${item.region} ${item.collected}건`)
        .join(", ");
  const bookingConditionText = `상품범위 ${PRODUCT_MODE_LABEL}, 기준 ${ADULTS}명, ${BOOKING_RANGE_DAYS}일 기준, 체크인 ${CHECK_IN}, 종료일 ${CHECK_OUT}`;
  const bookingRangeCollectionText = COLLECTION_PROFILE.collectWeeklyRange
    ? (BOOKING_RANGE_DAYS > 1 ? `${BOOKING_RANGE_DAYS}일 테스트, 상세 대상 중 최대 ${BOOKING_RANGE_PLACE_LIMIT}개 업체 날짜별 상세` : "1일 기준")
    : "기간별 매출 수집 제외";
  const summaryRows = [
    { 항목: "수집일시", 값: new Date().toLocaleString("ko-KR", { timeZone: "Asia/Seoul" }) },
    { 항목: "수집 모드", 값: SEARCH_MODE_LABEL },
    { 항목: "수집 목적", 값: COLLECTION_PURPOSE_LABEL },
    { 항목: "수집 방식", 값: COLLECTION_MODE_LABEL },
    { 항목: "조건", 값: bookingConditionText },
    { 항목: "상세 분석 순위", 값: COLLECTION_MODE === "fast" ? "빠른 순위 모드: 상세 분석 생략" : `${DETAIL_RANK_RANGE_LABEL}위` },
    { 항목: "예약재고 기간", 값: BOOKING_RANGE_DAYS > 1 ? `${BOOKING_RANGE_DAYS}일 테스트, 상세 대상 중 최대 ${BOOKING_RANGE_PLACE_LIMIT}개 업체 날짜별 상세` : "1일 기준" },
    { 항목: "네이버 전체", 값: `${naver.total}건 중 첫 페이지 ${naver.overall.length}건 수집` },
    { 항목: "네이버 광고", 값: `${naver.adTotal}건 수집` },
    { 항목: "네이버 지역별", 값: `${regional.rows.length}건 수집 (${regions.length}개 지역, 지역별 최대 ${REGIONAL_LIMIT}개)` },
    { 항목: "네이버 예약재고", 값: `상세 범위 ${naverBookingStock.detailRankRanges} / ${naverBookingStock.collected}개 확인 / 성공 ${naverBookingStock.successful}건 / 범위 제외 ${naverBookingStock.skippedByRank}건` },
    { 항목: "5건 미만 지역", 값: underfilledRegions || "없음" },
    { 항목: "야놀자/NOL", 값: `전체 ${nol.total}건 / 1페이지 원본 ${nol.rawFirstPage}건 중 캠핑형 ${nol.firstPage}건 수집, 제외 ${nol.filteredOut}건` },
    {
      항목: "여기어때",
      값: yeogi.blocked
        ? `Cloudflare 차단: HTTP ${yeogi.status}, 최종 URL ${yeogi.finalUrl}, 원인 ${yeogi.reason}`
        : `HTTP ${yeogi.status}`,
    },
    {
      항목: "떠나요",
      값: `정확 키워드 ${ddnayo.exactTotal}건 / 공백 제거 키워드 ${ddnayo.normalizedTotal}건 / 사용 키워드 ${ddnayo.usedQuery}`,
    },
    {
      항목: "ONDA",
      값: "핵심 분석 채널. 직접 자동수집기는 미구현, 떠나요/ONDA 계열 후보와 추가 API/수동 확인으로 보완",
    },
  ];

  const prefix = safeFilePart(RAW_KEYWORD || QUERY || province.keyword || province.short);
  const naverAttemptText = (naver.attemptedQueries || [])
    .map((item) => `${item.query}:${item.matched || 0}`)
    .join(", ");
  const fileRoles = {
    platform: `${prefix}_플랫폼통합.csv`,
    report: `${prefix}_수집리포트.md`,
    overall: `${prefix}_네이버전체순위.csv`,
    ads: `${prefix}_네이버광고순위.csv`,
    regional: `${prefix}_네이버지역별순위.csv`,
    ddnayo: `${prefix}_떠나요검색결과.csv`,
    workbook: `${prefix}_전체수집결과.xlsx`,
    naverWorkbook: `${prefix}_네이버순위통합.xlsx`
  };
  await writeCsv(path.join(OUTPUT_DIR, fileRoles.platform), platformRows, platformColumns);
  await writeCsv(path.join(OUTPUT_DIR, fileRoles.overall), naver.overall, overallColumns);
  await writeCsv(path.join(OUTPUT_DIR, fileRoles.ads), naver.ads, adColumns);
  await writeCsv(
    path.join(OUTPUT_DIR, fileRoles.regional),
    regional.rows,
    regionalColumns,
  );
  await writeCsv(path.join(OUTPUT_DIR, fileRoles.ddnayo), ddnayo.rows, platformColumns);

  const report = `# ${province.short} 글램핑 자동수집 테스트

- 수집일시: ${new Date().toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })}
- 입력 키워드: ${RAW_KEYWORD}
- 검색 키워드: ${QUERY}
- 네이버 전체 키워드: ${naver.usedQuery || NAVER_QUERY}
- 네이버 업체명 후보: ${naverAttemptText || "해당없음"}
- 수집 모드: ${SEARCH_MODE_LABEL}
- 수집 목적: ${COLLECTION_PURPOSE_LABEL}
- 수집 방식: ${COLLECTION_MODE_LABEL}
- 상세 분석 순위: ${COLLECTION_MODE === "fast" ? "빠른 순위 모드: 상세 분석 생략" : `${DETAIL_RANK_RANGE_LABEL}위`}
- 판단 유형: ${province.isCompany ? "업체명" : province.isLocal ? "지역형" : "광역형"}
- OTA 기준 조건: ${bookingConditionText}
- 예약재고 기간: ${BOOKING_RANGE_DAYS > 1 ? `${BOOKING_RANGE_DAYS}일 테스트, 상세 대상 중 최대 ${BOOKING_RANGE_PLACE_LIMIT}개 업체 날짜별 상세` : "1일 기준"}
- 상품상세 JSON: ${detailJsonFiles.length ? `긴 상품 상세 ${detailJsonFiles.length}개는 ${DETAIL_JSON_DIR_NAME}/ 별도 파일로 저장` : "XLSX 셀 한도 내 직접 저장"}
- 핵심 분석 채널: 네이버, 야놀자/NOL, ONDA, 떠나요
- 보조 채널: 여기어때(자동수집 차단 시 수동 보완만 사용)

## 객실수/채널수 해석 원칙
- ONDA·떠나요처럼 전 채널 연동이 가능한 구조라도 네이버예약은 별도 재고로 분리 운영될 수 있다.
- 예약가능률은 채널 통합 재고로 단정하지 않고, 네이버/야놀자/NOL/ONDA/떠나요의 채널별 노출·재고 기준을 분리해 기록한다.
- 네이버의 "숙박상품수"는 상품종류 수이고, "숙박확인재고수"는 예약리스트 유형에 따라 객실상품/묶음상품/재고수량 단위로 계산한다. 실제 전체 보유 객실수로 단정하지 않는다.
- 객실번호 범위형 묶음 상품(예: 1~3, 4~7)은 내부 stock 합계를 전체상품수량으로 표시하지 않고 상품 단위 예약가능률과 원시 stock 검증값을 분리 기록한다.
- "숙박예약가능률"은 판매율이 아니라 예약가능률이며, 판매완료/마감 비율은 "숙박판매완료율"로 별도 기록한다.
- 데이유즈/캠프닉 상품은 1박 예약가능률 계산에서 제외하고, "데이유즈상품수/데이유즈확인재고수"로 같은 당일상품 카테고리에 별도 기록한다.
- 숙박 전체객실수 후보는 날짜별 네이버 숙박 총량의 최대값으로 잡되, 반복적으로 낮은 총량은 현재 운영 판매 기준으로 분리한다.
- 전체객실수 후보와 운영 판매 기준의 차이는 상시 차단/운영 축소로 보고, 운영 기준보다 작게 수집된 날짜의 부족분만 오프라인 예약/일시 차단/미오픈 추정으로 본다.
- 상품별 오프라인 추정은 상품별 운영 기준 stock 대비 해당일 stock 부족분으로 배분한다.
- 오프라인 예약 추정 수량도 해당 날짜·상품의 가격이 확인되면 예상 매출에 포함하고, 상품 배정 또는 가격이 불명확한 수량만 가격누락으로 분리한다.
- 실제 전체객실수는 네이버 노출 재고, 야놀자/NOL, ONDA/떠나요, 사업자 직접 정보가 서로 다를 수 있으므로 검증 메모에 분리 기록한다.
- 채널수는 목록 검색에서 확인되지 않으면 "미확인"으로 남기고, 전 채널 연동 여부와 네이버 분리 가능성을 별도 메모한다.

## 네이버
- 상태: 성공
- 전체 순위: ${naver.total}건 중 첫 페이지 ${naver.overall.length}건 수집
- 광고 집행 순위: ${naver.adTotal}건 수집
- 지역별 키워드: ${regions.length}개 지역, 지역별 최대 ${REGIONAL_LIMIT}개 = ${regional.rows.length}건 수집
- 5건 미만 지역: ${underfilledRegions || "없음"}
- 광고/비광고 분리: 가능
- 예약재고: 상세 범위 ${naverBookingStock.detailRankRanges}, ${naverBookingStock.collected}개 확인, ${naverBookingStock.successful}건 성공, 범위 제외 ${naverBookingStock.skippedByRank}건
- 입력기간 예약재고 테스트: ${BOOKING_RANGE_DAYS > 1 ? `${BOOKING_RANGE_DAYS}일, 상세 대상 중 최대 ${BOOKING_RANGE_PLACE_LIMIT}개 업체만 날짜별 잔여 반복 확인` : "비활성"}
- 예약가능률 산식: 객실별 예약리스트는 예약가능 객실상품 수 / 노출 객실상품 수, 객실 묶음 상품리스트와 객실 종류별 리스트는 숙박 상품에 한해 \`sum(stock - bookingCount - occupiedBookingCount) / sum(stock)\`
- 네이버 상품 구분: 1박 조건은 \`ACCOMMODATION_NIGHT\` 숙박 상품만 예약가능률에 반영하고, \`ACCOMMODATION_DAY_USE\` 또는 상품명에 캠프닉/당일 이용 신호가 있는 상품은 데이유즈/캠프닉 상품종류와 재고합계를 별도 카운트로 분리
- 네이버 분리 기준: ONDA/떠나요 등 전 채널 연동 재고와 섞지 않고 네이버예약 재고를 독립 확인

## 클러스터 구분 기준
- 검색클러스터: 검색 키워드 기준 노출 지역
- 소재지클러스터: 업체 주소 기준 실제 시군
- 관광권역클러스터: ${Object.keys(province.tourismClusters || {}).join(", ")}
- 상품유형클러스터: 글램핑/카라반/캠핑장/펜션형/풀빌라·리조트형/키즈·가족형/반려견 동반형
- 가격대클러스터: 저가형(<10만원), 중가형(10만~20만원), 고가형(20만~35만원), 프리미엄(35만원 이상)
- 광고집행클러스터: 광고 집행, 비광고 상위 노출, 광고+비광고 동시 노출, 확인불가

## 야놀자/NOL
- 상태: ${nol.status === "skipped" ? "생략" : "성공"}
- 결과: 전체 ${nol.total}건 / 1페이지 원본 ${nol.rawFirstPage}건 중 캠핑형 ${nol.firstPage}건 수집
- 제외: 모텔/호텔 등 글램핑·카라반·캠핑·펜션 신호가 약한 결과 ${nol.filteredOut}건 제외
- 광고/비광고 분리: 가능
- 재고 해석: 검색 노출·가격은 수집하되 전체객실수와 채널별 배정수는 상세 재고 확인 필요

## 여기어때
- 상태: ${yeogi.blocked ? "차단" : "응답"}
- 결과: HTTP ${yeogi.status}
- 요청 URL: ${yeogi.attemptedUrl}
- 최종 URL: ${yeogi.finalUrl}
- 실패 원인: ${yeogi.reason || "응답은 받았으나 아직 파싱 로직 미구현"}
- 수집 방향: ${yeogi.collectionDirection || "응답 HTML/JSON 구조 확인 후 파서 구현 필요"}

## 떠나요
- 상태: ${ddnayo.usedQuery === "skipped" ? "생략" : "성공"}
- 정확 키워드 "${DDNAYO_QUERY_EXACT}": ${ddnayo.exactTotal}건
- 공백 제거 키워드 "${DDNAYO_QUERY_NORMALIZED}": ${ddnayo.normalizedTotal}건
- 사용 데이터: ${ddnayo.usedQuery}
- 참고: 떠나요 검색 API는 날짜/인원 조건을 목록 검색 파라미터로 받지 않아 검색 노출 순위와 기본가 중심으로 수집했다.
- 재고 해석: 떠나요/ONDA 계열은 전 채널 연동 후보로 보되, 전체객실수·채널수·네이버 분리 여부는 별도 확인 필요

## ONDA
- 상태: 핵심 분석 채널로 지정
- 현재 자동수집: 별도 ONDA 직접 수집기는 미구현
- 수집 방향: 떠나요/ONDA 계열 결과와 수동/추가 API 확인을 통해 전체객실수, 채널수, 네이버 분리 여부를 보완

## 판단
- 네이버: 자동수집 가능, 광고/비광고 분리 가능, 네이버예약 사업자ID가 있는 곳은 날짜별 객실 재고 수량까지 산출 가능.
- 야놀자/NOL: API 호출 방식으로 자동수집 가능, 광고/비광고 분리 가능.
- 여기어때: 현재 네트워크에서는 Cloudflare/WAF 차단. 제휴 API는 현실성 낮은 장기 옵션으로 두고, 단기는 사용자 브라우저 세션 기반 확인 또는 수동 CSV/HTML 가져오기 방식으로 검토 필요.
- ONDA/떠나요: 핵심 분석 채널. 전 채널 연동 가능성이 있어도 네이버예약은 분리될 수 있으므로 전체객실수와 채널수를 별도 확인한다.
- 떠나요: 자동수집 가능. 단, 띄어쓰기 키워드와 공백 제거 키워드의 결과 수가 다를 수 있어 둘 다 확인했다.
`;
  console.log("Writing outputs...");
  await fs.writeFile(path.join(OUTPUT_DIR, fileRoles.report), report, "utf8");

  const allWorkbook = path.join(OUTPUT_DIR, fileRoles.workbook);
  await buildWorkbook(allWorkbook, [
    { name: "요약", rows: summaryRows, columns: ["항목", "값"] },
    { name: "플랫폼테스트", rows: platformRows, columns: platformColumns },
    { name: "네이버전체순위", rows: naver.overall, columns: overallColumns },
    { name: "네이버광고순위", rows: naver.ads, columns: adColumns },
    { name: "네이버지역별상위5", rows: regional.rows, columns: regionalColumns },
    { name: "떠나요", rows: ddnayo.rows, columns: platformColumns },
  ]);

  const naverWorkbook = path.join(OUTPUT_DIR, fileRoles.naverWorkbook);
  await buildWorkbook(naverWorkbook, [
    { name: "요약", rows: summaryRows.slice(0, 5), columns: ["항목", "값"] },
    { name: "지역별상위5", rows: regional.rows, columns: regionalColumns },
    { name: "전체순위", rows: naver.overall, columns: overallColumns },
    { name: "광고순위", rows: naver.ads, columns: adColumns },
  ]);

  const collectionCompletedAt = new Date().toISOString();
  const manifest = {
    documentType: "lodging-collection-manifest",
    schemaVersion: 2,
    collectorVersion: COLLECTOR_VERSION,
    collectionStartedAt,
    collectionCompletedAt,
    dataAvailableAt: collectionCompletedAt,
    timezone: "Asia/Seoul",
    outputDir: OUTPUT_DIR,
    keyword: RAW_KEYWORD,
    keywordType: province.isCompany ? "company" : (province.isLocal ? "local" : "province"),
    searchMode: SEARCH_MODE,
    searchModeLabel: SEARCH_MODE_LABEL,
    searchIntent: COLLECTION_SEARCH_CONTEXT.intent,
    searchIntentConfidence: Number(process.env.SEARCH_INTENT_CONFIDENCE || 0),
    lodgingCategoryKey: COLLECTION_SEARCH_CONTEXT.categoryKey,
    searchRegionKey: COLLECTION_SEARCH_CONTEXT.regionKey,
    searchRegionQuery: COLLECTION_SEARCH_CONTEXT.regionQuery,
    searchCompanyName: COLLECTION_SEARCH_CONTEXT.companyName,
    searchCandidate: COLLECTION_SEARCH_CONTEXT.selectedCandidate,
    searchQueryEvidence: COLLECTION_SEARCH_CONTEXT.queryEvidence,
    collectionMode: COLLECTION_MODE,
    collectionModeLabel: COLLECTION_MODE_LABEL,
    collectionPurpose: COLLECTION_PURPOSE,
    collectionPurposeLabel: COLLECTION_PURPOSE_LABEL,
    collectionProfile: COLLECTION_PROFILE.key,
    collectionProfileLabel: COLLECTION_PROFILE.label,
    collectionProfileNote: COLLECTION_PROFILE.note,
    collectionProfileFlags: {
      collectRegional: COLLECTION_PROFILE.collectRegional,
      collectOta: COLLECTION_PROFILE.collectOta,
      collectBookingStock: COLLECTION_PROFILE.collectBookingStock,
      collectWeeklyRange: COLLECTION_PROFILE.collectWeeklyRange,
    },
    sourceRole: SOURCE_ROLE,
    collectionSource: COLLECTION_SOURCE,
    collectionSourceLabel: COLLECTION_SOURCE_LABEL,
    detailRankRanges: DETAIL_RANK_RANGE_LABEL,
    provinceKey: province.parentProvinceKey || province.slug,
    regionSlug: province.slug,
    searchKeyword: QUERY,
    naverKeyword: naver.usedQuery || NAVER_QUERY,
    naverAttemptedQueries: naver.attemptedQueries || [],
    checkIn: CHECK_IN,
    checkOut: CHECK_OUT,
    adults: ADULTS,
    productMode: PRODUCT_MODE,
    productModeLabel: PRODUCT_MODE_LABEL,
    bookingRangeDays: BOOKING_RANGE_DAYS,
    bookingRangePlaceLimit: BOOKING_RANGE_PLACE_LIMIT,
    bookingRangeCollectionText,
    fileRoles,
    files: Object.values(fileRoles),
    detailJsonFiles,
    counts: {
      naverOverall: naver.overall.length,
      naverAds: naver.ads.length,
      naverRegional: regional.rows.length,
      naverBookingStockChecked: naverBookingStock.collected,
      naverBookingStockSucceeded: naverBookingStock.successful,
      naverBookingStockSkippedByMode: naverBookingStock.skippedByMode,
      naverBookingStockSkippedByRank: naverBookingStock.skippedByRank,
      nolFirstPage: nol.firstPage,
      nolRawFirstPage: nol.rawFirstPage,
      nolFilteredOut: nol.filteredOut,
      ddnayo: ddnayo.rows.length,
      detailJsonFiles: detailJsonFiles.length,
    },
  };
  await fs.writeFile(path.join(OUTPUT_DIR, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
  console.log(JSON.stringify(manifest, null, 2));
}

main().catch((error) => {
  console.error(serializeCollectorFailure(error));
  process.exit(1);
});
