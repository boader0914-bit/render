const fs = require("node:fs/promises");
const path = require("node:path");
let XLSX = null;
let ArtifactWorkbook = null;
let ArtifactSpreadsheetFile = null;

try {
  XLSX = require("xlsx");
} catch {
  ({ Workbook: ArtifactWorkbook, SpreadsheetFile: ArtifactSpreadsheetFile } = require("@oai/artifact-tool"));
}

const PRODUCT_MODES = {
  all: "전체",
  lodging: "숙박",
  campnic: "캠프닉"
};

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

function boundedInteger(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(number)));
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

const CHECK_IN = process.env.CHECK_IN || kstDate(0);
const CHECK_OUT = process.env.CHECK_OUT || kstDate(6);
const ADULTS = Number(process.env.ADULTS || 2);
const PRODUCT_MODE = normalizeProductMode(process.env.PRODUCT_MODE || "all");
const PRODUCT_MODE_LABEL = PRODUCT_MODES[PRODUCT_MODE];
const BOOKING_RANGE_DAYS = boundedInteger(process.env.BOOKING_RANGE_DAYS, 7, 1, 31);
const BOOKING_RANGE_PLACE_LIMIT = boundedInteger(process.env.BOOKING_RANGE_PLACE_LIMIT, BOOKING_RANGE_DAYS > 1 ? 10 : 0, 0, 20);
const RAW_KEYWORD = process.argv[2] || "경남글램핑";

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

function spacedGlampingKeyword(value) {
  const normalized = compactKeyword(value).replace(/글램핑$/, "");
  return `${normalized} 글램핑`.trim();
}

function detectProvince(keyword) {
  const compact = compactKeyword(keyword);
  return provinceConfigs.find((config) => config.aliases.some((alias) => compact.startsWith(alias)));
}

function localNameFromKeyword(keyword) {
  return compactKeyword(keyword).replace(/글램핑$/, "") || compactKeyword(keyword);
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

const province = detectProvince(RAW_KEYWORD) || makeLocalConfig(RAW_KEYWORD);
const QUERY = province.mainQuery || (province.isLocal ? spacedGlampingKeyword(RAW_KEYWORD) : `${province.short} 글램핑`);
const NAVER_QUERY = province.naverQuery || (province.isLocal ? QUERY : `${province.full} 글램핑`);
const DDNAYO_QUERY_EXACT = province.ddnayoQuery || spacedGlampingKeyword(RAW_KEYWORD);
const DDNAYO_QUERY_NORMALIZED = compactKeyword(province.ddnayoQuery || RAW_KEYWORD);
const RUN_DATE = CHECK_IN.replaceAll("-", "");
const RUN_TIME = new Date().toLocaleTimeString("en-GB", { timeZone: "Asia/Seoul", hour12: false }).replaceAll(":", "");
const RUN_STAMP = process.env.RUN_STAMP || `${RUN_DATE}_${RUN_TIME}`;
const OUTPUT_ROOT = process.env.OUTPUTS_DIR || process.env.DATA_DIR || "outputs";
const OUTPUT_DIR = path.resolve(OUTPUT_ROOT, `${province.slug}_glamping_${RUN_STAMP}`);
const REGIONAL_LIMIT = Number(process.env.REGIONAL_LIMIT || 10);
const NAVER_BOOKING_STOCK_LIMIT = Number(process.env.NAVER_BOOKING_STOCK_LIMIT || 20);
const NAVER_BOOKING_GRAPHQL_URL = "https://m.booking.naver.com/graphql";

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
  if (markerIndex < 0) throw new Error("Naver Apollo state was not found.");
  const start = markerIndex + marker.length;
  const end = jsonEnd(html, start);
  if (end < 0) throw new Error("Naver Apollo state JSON did not terminate.");
  return JSON.parse(html.slice(start, end));
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

function pickNaverSearchKey(state, query) {
  const keys = Object.keys(state.ROOT_QUERY || {});
  return keys.find((key) => {
    if (!key.startsWith("accommodationSearch(")) return false;
    if (key.includes("filterOpening")) return false;
    const parsed = parseRootKey(key);
    return parsed?.input?.query === query && parsed?.input?.display === 50;
  });
}

function pickNaverAdKey(state, query) {
  const keys = Object.keys(state.ROOT_QUERY || {});
  return keys.find((key) => {
    if (!key.startsWith("adBusinesses(")) return false;
    if (key.includes('"channel":"openingPlace"')) return false;
    const parsed = parseRootKey(key);
    return parsed?.input?.query === query && parsed?.input?.businessType === "accommodation";
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
    주소: item.commonAddress || item.roadAddress || item.address || "",
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

async function getNaverBookingBusiness(placeId) {
  if (!placeId) return null;
  const endpoint = "https://pcmap-api.place.naver.com/graphql";
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
  const data = await response.json().catch(() => null);
  const booking = data?.data?.business?.naverBooking || {};
  return {
    bookingBusinessId: booking.bookingBusinessId || "",
    bookingUrl: booking.naverBookingUrl || booking.naverBookingHubUrl || "",
    status: response.status,
  };
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
  if (subtype === "ACCOMMODATION_DAY_USE" || /데이유즈|대실|당일|day\s*use/i.test(name)) return "데이유즈";
  if (subtype === "ACCOMMODATION_NIGHT" || /숙박|1박|글램핑|카라반|펜션|풀빌라/i.test(name)) return "숙박";
  return "미분류";
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

    if (listType === "객실별 예약리스트" || groupedProductList) {
      knownStockCount += stock !== null && stock >= 0 ? 1 : 0;
      totalStock += 1;
      const available = stock === null
        ? open && price !== null
        : open && Math.max(0, stock - usedCount) > 0;
      if (available) availableStock += 1;
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
  };
}

function summarizeNaverBookingAvailability(items, schedules, bookingBusinessId, bookingUrl, itemCounts = {}, extra = {}) {
  const listType = schedules.length ? classifyNaverBookingList(items, schedules) : "";
  const nightSummary = summarizeNaverScheduleGroup(items, schedules, listType);
  const dayUseItems = extra.dayUseItems || [];
  const dayUseSchedules = extra.dayUseSchedules || [];
  const dayUseListType = dayUseSchedules.length ? classifyNaverBookingList(dayUseItems, dayUseSchedules) : "";
  const dayUseSummary = summarizeNaverScheduleGroup(dayUseItems, dayUseSchedules, dayUseListType || "객실 종류별 리스트");
  const minPrices = [nightSummary.minPrice, dayUseSummary.minPrice].filter((value) => value !== null && value !== undefined);
  const minPrice = minPrices.length ? Math.min(...minPrices) : null;
  const evidence = !nightSummary.totalStock
    ? "날짜별 객실 재고 확인불가"
    : listType === "객실 묶음 상품리스트"
      ? `${listType}: ${CHECK_IN} 기준 네이버 숙박 묶음 상품별 예약가능 여부로 계산 (${nightSummary.knownStockCount}/${schedules.length}개 상품 stock 확인). 내부 stock 합계 ${nightSummary.rawAvailableStock}/${nightSummary.rawTotalStock}는 검증용이며 전체상품수량으로 표시하지 않음.`
    : listType === "객실별 예약리스트"
      ? `${listType}: ${CHECK_IN} 기준 네이버 숙박 예약가능 상품 수 / 노출 객실 상품 수 (${nightSummary.knownStockCount}/${schedules.length}개 상품 stock 확인). 전체 보유 객실수 아님.`
      : `${listType}: ${CHECK_IN} 기준 네이버 숙박 상품별 stock - bookingCount - occupiedBookingCount 수량 합산 (${nightSummary.knownStockCount}/${schedules.length}개 상품 stock 확인). 전체 보유 객실수 아님.`;
  const availabilityUnit = listType === "객실 묶음 상품리스트"
    ? "묶음상품"
    : listType === "객실별 예약리스트"
      ? "객실상품"
      : "재고수량";
  const rawStockNote = nightSummary.rawTotalStock && nightSummary.rawTotalStock !== nightSummary.totalStock
    ? `원시stock ${nightSummary.rawAvailableStock}/${nightSummary.rawTotalStock}`
    : "";
  const productTypeSummary = [
    `숙박상품 ${itemCounts.night || 0}종`,
    nightSummary.totalStock ? `예약가능 ${nightSummary.availableStock}/${nightSummary.totalStock}${availabilityUnit ? ` ${availabilityUnit}` : ""}` : "",
    nightSummary.soldOutStock || nightSummary.totalStock ? `판매완료/마감 ${nightSummary.soldOutStock}/${nightSummary.totalStock}` : "",
    rawStockNote,
    `데이유즈상품 ${itemCounts.dayUse || 0}종`,
    dayUseSummary.totalStock ? `데이유즈재고 ${dayUseSummary.availableStock}/${dayUseSummary.totalStock}` : "",
    `미분류 ${itemCounts.unknown || 0}종`,
  ].filter(Boolean).join(" · ");
  const inventoryMemo = [
    "네이버예약 날짜/채널 기준 재고",
    "실제 전체 객실수와 다를 수 있음",
    listType === "객실 묶음 상품리스트" ? "객실번호 범위형 묶음 상품은 상품 단위로 계산" : "",
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
    dayUseAvailableStock: dayUseSummary.availableStock,
    dayUseTotalStock: dayUseSummary.totalStock,
    dayUseAvailabilityRate: dayUseSummary.rate,
    dayUseCountedItemCount: dayUseSchedules.length,
    inventoryScope: "네이버예약 채널/날짜 기준 재고",
    inventoryMemo,
    itemDetails: [...schedules, ...dayUseSchedules].map((item) => ({
      bizItemId: item.bizItemId,
      name: item.name,
      bizItemSubType: item.bizItemSubType,
      saleType: item.saleType,
      stock: item.stock,
      bookingCount: item.bookingCount,
      occupiedBookingCount: item.occupiedBookingCount,
      available: item.available,
      price: item.price,
    })),
  };
}

async function collectNaverSchedulesForItems(bookingBusinessId, items, limit = 40, date = CHECK_IN) {
  const schedules = [];
  for (const item of items.slice(0, limit)) {
    await delay(90);
    const schedule = await getNaverDailySchedule(bookingBusinessId, item.bizItemId, date);
    const day = schedule.day || {};
    const stock = asStockNumber(day.stock);
    const bookingCount = Math.max(0, asStockNumber(day.bookingCount) || 0);
    const occupiedBookingCount = Math.max(0, asStockNumber(day.occupiedBookingCount) || 0);
    const price = asStockNumber(day.prices?.[0]?.price ?? item.minMaxPrice?.minPrice ?? item.price);
    schedules.push({
      bizItemId: item.bizItemId,
      name: item.name,
      bizItemSubType: item.bizItemSubType || "",
      saleType: naverBookingSaleType(item),
      stock,
      bookingCount,
      occupiedBookingCount,
      available: stock === null ? null : Math.max(0, stock - bookingCount - occupiedBookingCount),
      price,
      isBusinessDay: day.isBusinessDay,
      isSaleDay: day.isSaleDay,
      errors: schedule.errors,
    });
  }
  return schedules;
}

async function collectWeeklyNaverAvailability(bookingBusinessId, items, firstSchedules, days) {
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
      available: summary.availableStock,
      total: summary.totalStock,
      soldOut: summary.soldOutStock,
      rate: summary.rate,
    });
  }

  const valid = summaries.filter((item) => item.total > 0);
  if (!valid.length) return null;
  const avgAvailable = Number((valid.reduce((sum, item) => sum + item.available, 0) / valid.length).toFixed(1));
  const minAvailable = Math.min(...valid.map((item) => item.available));
  const soldOutDays = valid.filter((item) => item.available <= 0).length;
  const totalSoldOut = valid.reduce((sum, item) => sum + item.soldOut, 0);
  const totalStock = valid.reduce((sum, item) => sum + item.total, 0);
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
  return {
    days: valid.length,
    avgAvailable,
    minAvailable,
    soldOutDays,
    totalSoldOut,
    totalStock,
    avgReservationRate,
    detail,
    reservationRateDetail,
    summary: `${valid.length}일 날짜별 잔여`,
    dates: valid,
  };
}

async function collectNaverBookingAvailability(placeId, cache, options = {}) {
  if (!placeId) return { status: "place_id 없음" };
  if (cache.has(placeId)) return cache.get(placeId);

  const booking = await getNaverBookingBusiness(placeId);
  if (!booking?.bookingBusinessId) {
    const result = {
      status: "네이버예약 사업자ID 없음",
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
  const weekly = options.collectRange
    ? await collectWeeklyNaverAvailability(booking.bookingBusinessId, items, schedules, BOOKING_RANGE_DAYS)
    : null;

  const result = {
    status: itemResult.errors
      ? "객실목록 일부 오류"
      : !nightItems.length && dayUseItems.length && !unknownItems.length
        ? "숙박상품 없음(데이유즈만)"
        : "성공",
    ...summarizeNaverBookingAvailability(items, schedules, booking.bookingBusinessId, booking.bookingUrl, {
      night: nightItems.length,
      dayUse: dayUseItems.length,
      unknown: unknownItems.length,
    }, {
      dayUseItems,
      dayUseSchedules,
    }),
    weekly,
  };
  cache.set(placeId, result);
  return result;
}

async function enrichNaverRowsWithBookingAvailability(rows) {
  const cache = new Map();
  let collected = 0;
  let successful = 0;
  const uniquePlaceIds = new Set();

  for (const row of rows) {
    if (!row.place_id || row.예약 !== "Y") {
      row.네이버예약재고수집상태 = row.예약 === "Y" ? "place_id 없음" : "네이버예약 미노출";
      continue;
    }
    const alreadyKnown = uniquePlaceIds.has(row.place_id);
    if (!alreadyKnown && uniquePlaceIds.size >= NAVER_BOOKING_STOCK_LIMIT) {
      row.네이버예약재고수집상태 = `미수집(상위 ${NAVER_BOOKING_STOCK_LIMIT}개 제한)`;
      continue;
    }
    uniquePlaceIds.add(row.place_id);
    try {
      const collectRange = BOOKING_RANGE_DAYS > 1 &&
        BOOKING_RANGE_PLACE_LIMIT > 0 &&
        !alreadyKnown &&
        uniquePlaceIds.size <= BOOKING_RANGE_PLACE_LIMIT;
      const result = await collectNaverBookingAvailability(row.place_id, cache, { collectRange });
      if (!alreadyKnown) collected += 1;
      if (!alreadyKnown && result.status === "성공") successful += 1;

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
      row.네이버원시예약가능재고 = result.nightRawAvailableStock ?? "";
      row.네이버원시전체재고 = result.nightRawTotalStock ?? "";
      row.네이버묶음객실범위수 = result.groupedRoomCount ?? "";
      row.예약계산단위 = result.availabilityUnit || "";
      row.데이유즈예약가능수 = result.dayUseAvailableStock ?? "";
      row.데이유즈확인재고수 = result.dayUseTotalStock ?? "";
      row.데이유즈예약가능률 = result.dayUseAvailabilityRate === null || result.dayUseAvailabilityRate === undefined ? "" : result.dayUseAvailabilityRate;
      row.데이유즈계산대상상품수 = result.dayUseCountedItemCount ?? "";
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
      row.주간잔여상세 = result.weekly?.detail || "";
      row.주간평균예약률 = result.weekly?.avgReservationRate ?? "";
      row.주간예약률상세 = result.weekly?.reservationRateDetail || "";
    } catch (error) {
      if (!alreadyKnown) collected += 1;
      row.네이버예약재고수집상태 = `실패: ${error.message || error}`;
    }
  }

  rows.forEach(setNaverInventoryAuditFields);
  return { limit: NAVER_BOOKING_STOCK_LIMIT, collected, successful };
}

async function collectNaverMain() {
  const { state, status, url } = await getNaverState(NAVER_QUERY);
  const searchKey = pickNaverSearchKey(state, NAVER_QUERY);
  const adKey = pickNaverAdKey(state, NAVER_QUERY);
  if (!searchKey) throw new Error("Naver main search key not found.");

  const overallRefs = state.ROOT_QUERY[searchKey].business.items || [];
  const adRefs = adKey ? state.ROOT_QUERY[adKey].items || [] : [];

  const overall = overallRefs.map((ref, index) => {
    const item = state[ref.__ref];
    return mapNaverItem(state, item, {
      query: NAVER_QUERY,
      overall_rank: index + 1,
      구분: "비광고",
    });
  });

  const ads = adRefs.map((ref, index) => {
    const item = state[ref.__ref];
    return mapNaverItem(state, item, {
      query: NAVER_QUERY,
      ad_order: index + 1,
      구분: "광고",
      ad_id: item.adId || "",
      ad_description: item.adDescription || "",
    });
  });

  return {
    status,
    url,
    total: state.ROOT_QUERY[searchKey].business.total,
    adTotal: adKey ? state.ROOT_QUERY[adKey].total : 0,
    overall,
    ads,
  };
}

async function collectNaverRegional() {
  const rows = [];
  const summaries = [];
  for (const region of regions) {
    const regionalPrefix = province.regionalPrefix === undefined ? province.short : province.regionalPrefix;
    const query = province.isLocal ? QUERY : [regionalPrefix, region, "글램핑"].filter(Boolean).join(" ");
    const { state, status } = await getNaverState(query);
    const key = pickNaverSearchKey(state, query);
    if (!key) {
      summaries.push({ region, query, status, total: 0, collected: 0, note: "검색 상태 키 없음" });
      continue;
    }
    const result = state.ROOT_QUERY[key].business;
    const refs = result.items || [];
    refs.slice(0, REGIONAL_LIMIT).forEach((ref, index) => {
      const item = state[ref.__ref];
      rows.push(
        mapNaverItem(state, item, {
          지역: region,
          검색키워드: query,
          순위: index + 1,
          구분: "비광고",
        }),
      );
    });
    summaries.push({ region, query, status, total: result.total, collected: Math.min(refs.length, REGIONAL_LIMIT), note: "" });
  }
  return { rows, summaries };
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
  const count = await fetchJson(countUrl, {
    method: "POST",
    headers: commonHeaders,
    body: JSON.stringify(body),
  });
  const list = await fetchJson(url, {
    method: "POST",
    headers: commonHeaders,
    body: JSON.stringify(body),
  });

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
  const rows = rawRows.filter(isRelevantOtaAccommodation).map((row, index) => ({
    ...row,
    rank_or_order: index + 1,
  }));

  return {
    status: list.res.status,
    total: count.data?.count ?? "",
    rawFirstPage: rawRows.length,
    firstPage: rows.length,
    filteredOut: rawRows.length - rows.length,
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

  const exact = await search(DDNAYO_QUERY_EXACT, 10);
  const normalized = await search(DDNAYO_QUERY_NORMALIZED, 24);
  const source = normalized.data?.data?.totalSize > 0 ? normalized : exact;
  const usedQuery = source === normalized ? DDNAYO_QUERY_NORMALIZED : DDNAYO_QUERY_EXACT;
  const contents = source.data?.data?.contents || [];
  const rows = contents.map((item, index) => ({
    channel: "떠나요",
    section: usedQuery === DDNAYO_QUERY_NORMALIZED ? "검색결과(공백제거 키워드)" : "검색결과",
    rank_or_order: index + 1,
    name: item.accommodationName || "",
    category: "펜션/글램핑",
    location: item.address || "",
    rating: "",
    reviews: "",
    price: item.price ? `${Number(item.price).toLocaleString("ko-KR")}원부터` : "",
    ad_flag: "확인불가",
    url: item.productUrl || "",
  }));

  return {
    exactTotal: exact.data?.data?.totalSize ?? 0,
    normalizedTotal: normalized.data?.data?.totalSize ?? 0,
    usedQuery,
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
      "예약계산단위": row.예약계산단위 || "",
      "네이버원시예약가능재고": row.네이버원시예약가능재고 ?? "",
      "네이버원시전체재고": row.네이버원시전체재고 ?? "",
      "네이버묶음객실범위수": row.네이버묶음객실범위수 ?? "",
      "데이유즈예약가능수": row.데이유즈예약가능수 ?? "",
      "데이유즈확인재고수": row.데이유즈확인재고수 ?? "",
      "데이유즈예약가능률": row.데이유즈예약가능률 ?? "",
      "데이유즈계산대상상품수": row.데이유즈계산대상상품수 ?? "",
      "네이버재고범위": row.네이버재고범위 || "",
      "객실수검증메모": row.객실수검증메모 || "",
      "주간재고수집일수": row.주간재고수집일수 ?? "",
      "주간잔여요약": row.주간잔여요약 || "",
      "주간평균잔여수": row.주간평균잔여수 ?? "",
      "주간최소잔여수": row.주간최소잔여수 ?? "",
      "주간마감일수": row.주간마감일수 ?? "",
      "주간판매수량합계": row.주간판매수량합계 ?? "",
      "주간전체수량합계": row.주간전체수량합계 ?? "",
      "주간잔여상세": row.주간잔여상세 || "",
      "주간평균예약률": row.주간평균예약률 ?? "",
      "주간예약률상세": row.주간예약률상세 || "",
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
      "예약계산단위": row.예약계산단위 || "",
      "네이버원시예약가능재고": row.네이버원시예약가능재고 ?? "",
      "네이버원시전체재고": row.네이버원시전체재고 ?? "",
      "네이버묶음객실범위수": row.네이버묶음객실범위수 ?? "",
      "데이유즈예약가능수": row.데이유즈예약가능수 ?? "",
      "데이유즈확인재고수": row.데이유즈확인재고수 ?? "",
      "데이유즈예약가능률": row.데이유즈예약가능률 ?? "",
      "데이유즈계산대상상품수": row.데이유즈계산대상상품수 ?? "",
      "네이버재고범위": row.네이버재고범위 || "",
      "객실수검증메모": row.객실수검증메모 || "",
      "주간재고수집일수": row.주간재고수집일수 ?? "",
      "주간잔여요약": row.주간잔여요약 || "",
      "주간평균잔여수": row.주간평균잔여수 ?? "",
      "주간최소잔여수": row.주간최소잔여수 ?? "",
      "주간마감일수": row.주간마감일수 ?? "",
      "주간판매수량합계": row.주간판매수량합계 ?? "",
      "주간전체수량합계": row.주간전체수량합계 ?? "",
      "주간잔여상세": row.주간잔여상세 || "",
      "주간평균예약률": row.주간평균예약률 ?? "",
      "주간예약률상세": row.주간예약률상세 || "",
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

function aoaFromRows(rows, columns) {
  return [columns, ...rows.map((row) => columns.map((column) => row[column] ?? ""))];
}

function colName(index) {
  let name = "";
  let n = index + 1;
  while (n > 0) {
    const rem = (n - 1) % 26;
    name = String.fromCharCode(65 + rem) + name;
    n = Math.floor((n - 1) / 26);
  }
  return name;
}

function safeSheetName(name) {
  return String(name || "Sheet").replace(/[\\/?*[\]:]/g, " ").slice(0, 31) || "Sheet";
}

function writeXlsxSheet(workbook, name, rows, columns) {
  const data = aoaFromRows(rows, columns);
  const sheet = XLSX.utils.aoa_to_sheet(data.length ? data : [columns]);
  XLSX.utils.book_append_sheet(workbook, sheet, safeSheetName(name));
}

async function buildWorkbook(filePath, sheets) {
  if (!XLSX) {
    const workbook = ArtifactWorkbook.create();
    for (const sheet of sheets) {
      const data = aoaFromRows(sheet.rows, sheet.columns);
      const worksheet = workbook.worksheets.add(safeSheetName(sheet.name));
      if (data.length && sheet.columns.length) {
        worksheet.getRange(`A1:${colName(sheet.columns.length - 1)}${data.length}`).values = data;
      }
    }
    const output = await ArtifactSpreadsheetFile.exportXlsx(workbook);
    await output.save(filePath);
    return;
  }

  const workbook = XLSX.utils.book_new();
  for (const sheet of sheets) {
    writeXlsxSheet(workbook, sheet.name, sheet.rows, sheet.columns);
  }
  XLSX.writeFile(workbook, filePath);
}

async function main() {
  await fs.mkdir(OUTPUT_DIR, { recursive: true });

  console.log("Collecting Naver main...");
  const naver = await collectNaverMain();

  console.log("Collecting Naver regional clusters...");
  const regional = await collectNaverRegional();

  console.log("Collecting NOL...");
  const nol = await collectNol();

  console.log("Checking Yeogi...");
  const yeogi = await collectYeogi();

  console.log("Collecting DDNayo...");
  const ddnayo = await collectDdnayo();

  applyNaverAdClusters(naver, regional.rows);
  console.log("Checking Naver booking stock...");
  const naverBookingStock = await enrichNaverRowsWithBookingAvailability([
    ...naver.overall,
    ...naver.ads,
    ...regional.rows,
  ]);
  const platformRows = toPlatformRows(naver, nol, yeogi, ddnayo);

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
    "네이버재고범위",
    "객실수검증메모",
    "주간재고수집일수",
    "주간잔여요약",
    "주간평균잔여수",
    "주간최소잔여수",
    "주간마감일수",
    "주간판매수량합계",
    "주간전체수량합계",
    "주간잔여상세",
    "주간평균예약률",
    "주간예약률상세",
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
    "네이버재고범위",
    "객실수검증메모",
    "주간재고수집일수",
    "주간잔여요약",
    "주간평균잔여수",
    "주간최소잔여수",
    "주간마감일수",
    "주간판매수량합계",
    "주간전체수량합계",
    "주간잔여상세",
    "주간평균예약률",
    "주간예약률상세",
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
    "네이버재고범위",
    "객실수검증메모",
    "주간재고수집일수",
    "주간잔여요약",
    "주간평균잔여수",
    "주간최소잔여수",
    "주간마감일수",
    "주간판매수량합계",
    "주간전체수량합계",
    "주간잔여상세",
    "주간평균예약률",
    "주간예약률상세",
    "예약최저가",
    "예약가능근거",
    "url",
  ];
  const regionalColumns = [
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
    "네이버재고범위",
    "객실수검증메모",
    "주간재고수집일수",
    "주간잔여요약",
    "주간평균잔여수",
    "주간최소잔여수",
    "주간마감일수",
    "주간판매수량합계",
    "주간전체수량합계",
    "주간잔여상세",
    "주간평균예약률",
    "주간예약률상세",
    "예약최저가",
    "예약가능근거",
    "url",
  ];
  const underfilledRegions = regional.summaries
    .filter((item) => item.collected < REGIONAL_LIMIT)
    .map((item) => `${item.region} ${item.collected}건`)
    .join(", ");
  const bookingConditionText = `상품범위 ${PRODUCT_MODE_LABEL}, 기준 ${ADULTS}명, ${BOOKING_RANGE_DAYS}일 기준, 체크인 ${CHECK_IN}, 종료일 ${CHECK_OUT}`;
  const summaryRows = [
    { 항목: "수집일시", 값: new Date().toLocaleString("ko-KR", { timeZone: "Asia/Seoul" }) },
    { 항목: "조건", 값: bookingConditionText },
    { 항목: "예약재고 기간", 값: BOOKING_RANGE_DAYS > 1 ? `${BOOKING_RANGE_DAYS}일 테스트, 상위 ${BOOKING_RANGE_PLACE_LIMIT}개 업체 주간 상세` : "1일 기준" },
    { 항목: "네이버 전체", 값: `${naver.total}건 중 첫 페이지 ${naver.overall.length}건 수집` },
    { 항목: "네이버 광고", 값: `${naver.adTotal}건 수집` },
    { 항목: "네이버 지역별", 값: `${regional.rows.length}건 수집 (${regions.length}개 지역, 지역별 최대 ${REGIONAL_LIMIT}개)` },
    { 항목: "네이버 예약재고", 값: `상위 ${naverBookingStock.limit}개 제한 중 ${naverBookingStock.collected}개 확인 / 성공 ${naverBookingStock.successful}건` },
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
- 네이버 전체 키워드: ${NAVER_QUERY}
- 판단 유형: ${province.isLocal ? "지역형" : "광역형"}
- OTA 기준 조건: ${bookingConditionText}
- 예약재고 기간: ${BOOKING_RANGE_DAYS > 1 ? `${BOOKING_RANGE_DAYS}일 테스트, 상위 ${BOOKING_RANGE_PLACE_LIMIT}개 업체 주간 상세` : "1일 기준"}
- 핵심 분석 채널: 네이버, 야놀자/NOL, ONDA, 떠나요
- 보조 채널: 여기어때(자동수집 차단 시 수동 보완만 사용)

## 객실수/채널수 해석 원칙
- ONDA·떠나요처럼 전 채널 연동이 가능한 구조라도 네이버예약은 별도 재고로 분리 운영될 수 있다.
- 예약가능률은 채널 통합 재고로 단정하지 않고, 네이버/야놀자/NOL/ONDA/떠나요의 채널별 노출·재고 기준을 분리해 기록한다.
- 네이버의 "숙박상품수"는 상품종류 수이고, "숙박확인재고수"는 예약리스트 유형에 따라 객실상품/묶음상품/재고수량 단위로 계산한다. 실제 전체 보유 객실수로 단정하지 않는다.
- 객실번호 범위형 묶음 상품(예: 1~3, 4~7)은 내부 stock 합계를 전체상품수량으로 표시하지 않고 상품 단위 예약가능률과 원시 stock 검증값을 분리 기록한다.
- "숙박예약가능률"은 판매율이 아니라 예약가능률이며, 판매완료/마감 비율은 "숙박판매완료율"로 별도 기록한다.
- 데이유즈 상품은 1박 예약가능률 계산에서 제외하고, "데이유즈상품수/데이유즈확인재고수"로 별도 기록한다.
- 실제 전체객실수는 네이버 노출 재고, 야놀자/NOL, ONDA/떠나요, 사업자 직접 정보가 서로 다를 수 있으므로 검증 메모에 분리 기록한다.
- 채널수는 목록 검색에서 확인되지 않으면 "미확인"으로 남기고, 전 채널 연동 여부와 네이버 분리 가능성을 별도 메모한다.

## 네이버
- 상태: 성공
- 전체 순위: ${naver.total}건 중 첫 페이지 ${naver.overall.length}건 수집
- 광고 집행 순위: ${naver.adTotal}건 수집
- 지역별 키워드: ${regions.length}개 지역, 지역별 최대 ${REGIONAL_LIMIT}개 = ${regional.rows.length}건 수집
- 5건 미만 지역: ${underfilledRegions || "없음"}
- 광고/비광고 분리: 가능
- 예약재고: 상위 ${naverBookingStock.limit}개 제한으로 ${naverBookingStock.collected}개 확인, ${naverBookingStock.successful}건 성공
- 주간 예약재고 테스트: ${BOOKING_RANGE_DAYS > 1 ? `${BOOKING_RANGE_DAYS}일, 상위 ${BOOKING_RANGE_PLACE_LIMIT}개 업체만 날짜별 잔여 반복 확인` : "비활성"}
- 예약가능률 산식: 객실별 예약리스트는 예약가능 상품 수 / 노출 객실 상품 수, 객실 묶음 상품리스트는 예약가능 묶음 상품 수 / 묶음 상품 수, 객실 종류별 리스트는 숙박 상품에 한해 \`sum(stock - bookingCount - occupiedBookingCount) / sum(stock)\`
- 네이버 상품 구분: 1박 조건은 \`ACCOMMODATION_NIGHT\` 숙박 상품만 예약가능률에 반영하고, \`ACCOMMODATION_DAY_USE\` 데이유즈 상품은 점심/저녁 등 상품종류와 재고합계를 별도 카운트로 분리
- 네이버 분리 기준: ONDA/떠나요 등 전 채널 연동 재고와 섞지 않고 네이버예약 재고를 독립 확인

## 클러스터 구분 기준
- 검색클러스터: 검색 키워드 기준 노출 지역
- 소재지클러스터: 업체 주소 기준 실제 시군
- 관광권역클러스터: ${Object.keys(province.tourismClusters || {}).join(", ")}
- 상품유형클러스터: 글램핑/카라반/캠핑장/펜션형/풀빌라·리조트형/키즈·가족형/반려견 동반형
- 가격대클러스터: 저가형(<10만원), 중가형(10만~20만원), 고가형(20만~35만원), 프리미엄(35만원 이상)
- 광고집행클러스터: 광고 집행, 비광고 상위 노출, 광고+비광고 동시 노출, 확인불가

## 야놀자/NOL
- 상태: 성공
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
- 상태: 성공
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

  const manifest = {
    outputDir: OUTPUT_DIR,
    keyword: RAW_KEYWORD,
    keywordType: province.isLocal ? "local" : "province",
    provinceKey: province.parentProvinceKey || province.slug,
    regionSlug: province.slug,
    searchKeyword: QUERY,
    naverKeyword: NAVER_QUERY,
    checkIn: CHECK_IN,
    checkOut: CHECK_OUT,
    adults: ADULTS,
    productMode: PRODUCT_MODE,
    productModeLabel: PRODUCT_MODE_LABEL,
    bookingRangeDays: BOOKING_RANGE_DAYS,
    bookingRangePlaceLimit: BOOKING_RANGE_PLACE_LIMIT,
    fileRoles,
    files: Object.values(fileRoles),
    counts: {
      naverOverall: naver.overall.length,
      naverAds: naver.ads.length,
      naverRegional: regional.rows.length,
      naverBookingStockChecked: naverBookingStock.collected,
      naverBookingStockSucceeded: naverBookingStock.successful,
      nolFirstPage: nol.firstPage,
      nolRawFirstPage: nol.rawFirstPage,
      nolFilteredOut: nol.filteredOut,
      ddnayo: ddnayo.rows.length,
    },
  };
  await fs.writeFile(path.join(OUTPUT_DIR, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
  console.log(JSON.stringify(manifest, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
