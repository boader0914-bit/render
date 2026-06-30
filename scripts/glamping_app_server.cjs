const fs = require("node:fs");
const fsp = require("node:fs/promises");
const crypto = require("node:crypto");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { URL } = require("node:url");
const yeogiImportParser = require("./yeogi_import_parser.cjs");

const ROOT = path.resolve(__dirname, "..");
const WEB_DIR = path.join(ROOT, "web");
const REPO_OUTPUTS_DIR = path.join(ROOT, "outputs");
const RENDER_DISK_DIR = "/var/data";
const IS_RENDER_RUNTIME = Boolean(process.env.RENDER || process.env.RENDER_EXTERNAL_URL);
const HAS_RENDER_DISK = IS_RENDER_RUNTIME && fs.existsSync(RENDER_DISK_DIR);
const isTmpDataPath = (value) => /^\/tmp(?:\/|$)/.test(String(value || "").replace(/\\/g, "/"));
const DATA_DIR = path.resolve(
  HAS_RENDER_DISK && (!process.env.DATA_DIR || isTmpDataPath(process.env.DATA_DIR))
    ? RENDER_DISK_DIR
    : (process.env.DATA_DIR || ROOT)
);
const OUTPUTS_DIR = path.resolve(
  HAS_RENDER_DISK && (!process.env.OUTPUTS_DIR || isTmpDataPath(process.env.OUTPUTS_DIR))
    ? path.join(DATA_DIR, "outputs")
    : (process.env.OUTPUTS_DIR || path.join(DATA_DIR, "outputs"))
);
const CONFIG_DIR = path.resolve(
  HAS_RENDER_DISK && (!process.env.CONFIG_DIR || isTmpDataPath(process.env.CONFIG_DIR))
    ? path.join(DATA_DIR, "config")
    : (process.env.CONFIG_DIR || path.join(DATA_DIR, "config"))
);
// Stable API key storage policy: releases may replace code, but must keep this file path.
const TRAFFIC_KEYS_FILE = path.join(CONFIG_DIR, "traffic_api_keys.local.json");
const HISTORY_DIR = path.join(DATA_DIR, "history");
const HISTORY_OBSERVATIONS_FILE = path.join(HISTORY_DIR, "observations.jsonl");
const COMPANY_MASTER_DIR = path.join(DATA_DIR, "company_master");
const COMPANY_MASTER_FILE = path.join(COMPANY_MASTER_DIR, "companies.json");
const PORT = Number(process.env.PORT || 3210);
const HOST = process.env.HOST || (IS_RENDER_RUNTIME ? "0.0.0.0" : "127.0.0.1");
const IS_PRODUCTION_RUNTIME = process.env.NODE_ENV === "production" || IS_RENDER_RUNTIME;
const ADMIN_USERNAME = String(process.env.GLAMPING_ADMIN_USER || process.env.ADMIN_USER || "admin").trim();
const ADMIN_PASSWORD = String(process.env.GLAMPING_ADMIN_PASSWORD || process.env.ADMIN_PASSWORD || "0914").trim();
const SESSION_COOKIE_NAME = "glamping_datalab_session";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const sessions = new Map();
let activeCrawlPromise = null;
let activeCrawlStartedAt = null;
const DEFAULT_NODE_MODULES = path.join(
  process.env.USERPROFILE || "C:\\Users\\User",
  ".cache",
  "codex-runtimes",
  "codex-primary-runtime",
  "dependencies",
  "node",
  "node_modules"
);
const PRODUCT_MODES = {
  all: "전체",
  lodging: "숙박",
  campnic: "캠프닉"
};
const SEARCH_MODES = {
  keyword: "키워드/권역",
  company: "업체명"
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

function normalizeSearchMode(value) {
  const text = String(value || "").trim();
  if (SEARCH_MODES[text]) return text;
  if (text === "업체명" || text.toLowerCase() === "company") return "company";
  return "keyword";
}

const PROVINCES = {
  gyeongbuk: {
    label: "경북",
    keyword: "경북글램핑",
    mapBounds: { minLon: 127.95, maxLon: 130.95, minLat: 35.55, maxLat: 37.55 },
    profiles: {
      포항: { lat: 36.019, lon: 129.3435, primary: "복합형", secondary: "메인 관광지형, 자연 관광자원형, 생활권·도심 수요형", resources: ["바다"], target: "동해안 관광 수요", note: "동해안 대표 관광지이면서 도심 생활권 수요도 함께 보유" },
      경주: { lat: 35.8562, lon: 129.2247, primary: "복합형", secondary: "메인 관광지형, 자연 관광자원형", resources: ["문화유산", "산"], target: "경주 관광 수요", note: "지역 자체가 강한 여행 목적지" },
      김천: { lat: 36.1398, lon: 128.1136, primary: "생활권·도심 수요형", secondary: "자연 관광자원형", resources: ["산"], target: "김천·구미 생활권", note: "근거리 주말 수요와 일부 산악형 수요" },
      안동: { lat: 36.5684, lon: 128.7294, primary: "복합형", secondary: "메인 관광지형, 자연 관광자원형", resources: ["문화유산", "강"], target: "안동 관광 수요", note: "문화 관광 목적지와 강변·자연 수요가 결합" },
      구미: { lat: 36.1195, lon: 128.3446, primary: "생활권·도심 수요형", secondary: "인접 관광 흡수형", resources: ["도심", "산"], target: "구미·칠곡 생활권", note: "인구 기반의 근교 숙박/체험 수요" },
      영주: { lat: 36.8057, lon: 128.6241, primary: "자연 관광자원형", secondary: "메인 관광지형", resources: ["산", "문화유산"], target: "소백산·부석사 수요", note: "산악 및 역사 관광 수요" },
      영천: { lat: 35.9733, lon: 128.9386, primary: "인접 관광 흡수형", secondary: "생활권·도심 수요형", resources: ["강", "근교"], target: "경주·대구·청도", note: "인접 관광지와 대구 근교 수요 흡수" },
      상주: { lat: 36.4109, lon: 128.1591, primary: "생활권·도심 수요형", secondary: "자연 관광자원형", resources: ["강", "산"], target: "상주·문경 생활권", note: "생활권 기반에 강·산 자연 수요가 보조" },
      문경: { lat: 36.5865, lon: 128.1868, primary: "자연 관광자원형", secondary: "메인 관광지형", resources: ["산", "계곡"], target: "문경새재·산악 관광 수요", note: "자연 체험형 글램핑과 결합성이 높음" },
      경산: { lat: 35.825, lon: 128.7415, primary: "생활권·도심 수요형", secondary: "인접 관광 흡수형", resources: ["도심", "근교"], target: "대구·청도·경주", note: "대구 생활권과 인접 관광 수요를 함께 흡수" },
      의성: { lat: 36.3526, lon: 128.697, primary: "자연 관광자원형", secondary: "인접 관광 흡수형", resources: ["산", "농촌"], target: "안동·군위권", note: "자연·농촌 체류형 수요 중심" },
      청송: { lat: 36.4363, lon: 129.057, primary: "자연 관광자원형", secondary: "메인 관광지형", resources: ["산", "계곡"], target: "주왕산 관광 수요", note: "산악 관광 목적성이 강함" },
      영양: { lat: 36.6667, lon: 129.1125, primary: "자연 관광자원형", secondary: "인접 관광 흡수형", resources: ["산", "숲"], target: "청송·영덕 인접 수요", note: "저밀도 자연 체류형 수요" },
      영덕: { lat: 36.4151, lon: 129.3657, primary: "메인 관광지형", secondary: "자연 관광자원형", resources: ["바다"], target: "영덕 해안 관광 수요", note: "바다 관광 목적 수요가 직접 발생" },
      청도: { lat: 35.6474, lon: 128.734, primary: "인접 관광 흡수형", secondary: "자연 관광자원형, 생활권·도심 수요형", resources: ["산", "근교"], target: "대구·경산·경주", note: "대구 근교와 자연 체험 수요가 결합" },
      고령: { lat: 35.7259, lon: 128.2628, primary: "인접 관광 흡수형", secondary: "생활권·도심 수요형", resources: ["강", "문화"], target: "대구·합천·성주", note: "인접 도시권의 근거리 숙박 대체지" },
      성주: { lat: 35.9192, lon: 128.2829, primary: "인접 관광 흡수형", secondary: "자연 관광자원형", resources: ["산", "계곡"], target: "대구·가야산권", note: "대구 근교와 산악권 수요 흡수" },
      칠곡: { lat: 35.9956, lon: 128.4017, primary: "생활권·도심 수요형", secondary: "인접 관광 흡수형", resources: ["도심", "근교"], target: "대구·구미", note: "대구·구미 사이 생활권 기반 수요" },
      예천: { lat: 36.6577, lon: 128.4529, primary: "자연 관광자원형", secondary: "인접 관광 흡수형", resources: ["강", "산"], target: "안동·문경", note: "북부권 자연·인접 관광 수요" },
      봉화: { lat: 36.8931, lon: 128.7325, primary: "자연 관광자원형", secondary: "메인 관광지형", resources: ["산", "숲"], target: "백두대간·숲 관광 수요", note: "산림 체류형 수요가 뚜렷함" },
      울진: { lat: 36.9931, lon: 129.4005, primary: "메인 관광지형", secondary: "자연 관광자원형", resources: ["바다", "온천"], target: "울진 해안·온천 관광 수요", note: "바다와 온천 기반의 목적지 수요" },
      울릉: { lat: 37.4845, lon: 130.9057, primary: "메인 관광지형", secondary: "자연 관광자원형", resources: ["섬", "바다"], target: "울릉도 관광 수요", note: "섬 목적지형 수요" }
    }
  },
  gyeongnam: {
    label: "경남",
    keyword: "경남글램핑",
    mapBounds: { minLon: 127.55, maxLon: 129.25, minLat: 34.55, maxLat: 35.85 },
    profiles: {
      창원: { lat: 35.227, lon: 128.681, primary: "생활권·도심 수요형", secondary: "인접 관광 흡수형", resources: ["도심", "바다"], target: "마산·진해·부산근교", note: "대도시 생활권 기반의 근교 체류 수요" },
      진주: { lat: 35.18, lon: 128.108, primary: "생활권·도심 수요형", secondary: "인접 관광 흡수형", resources: ["강", "도심"], target: "사천·산청·하동", note: "서부경남 생활권과 주변 관광지 흡수 수요" },
      통영: { lat: 34.854, lon: 128.433, primary: "메인 관광지형", secondary: "자연 관광자원형", resources: ["바다", "섬"], target: "통영 해안·섬 관광 수요", note: "지역 자체가 강한 해양 관광 목적지" },
      사천: { lat: 35.003, lon: 128.064, primary: "인접 관광 흡수형", secondary: "자연 관광자원형", resources: ["바다", "강"], target: "남해·진주·고성", note: "남해안 관광과 서부경남 생활권을 함께 흡수" },
      김해: { lat: 35.228, lon: 128.889, primary: "생활권·도심 수요형", secondary: "인접 관광 흡수형", resources: ["도심", "근교"], target: "부산·창원·양산", note: "부산권 근교 체험형 수요" },
      밀양: { lat: 35.503, lon: 128.747, primary: "자연 관광자원형", secondary: "인접 관광 흡수형", resources: ["산", "계곡"], target: "부산·창원·양산", note: "근교 자연 체류형 수요" },
      거제: { lat: 34.881, lon: 128.621, primary: "메인 관광지형", secondary: "자연 관광자원형", resources: ["바다", "섬"], target: "거제 해양 관광 수요", note: "바다와 섬 목적지형 수요가 강함" },
      양산: { lat: 35.335, lon: 129.037, primary: "생활권·도심 수요형", secondary: "인접 관광 흡수형", resources: ["산", "근교"], target: "부산·울산 생활권", note: "대도시 근교 휴식 수요" },
      의령: { lat: 35.322, lon: 128.262, primary: "자연 관광자원형", secondary: "인접 관광 흡수형", resources: ["강", "농촌"], target: "진주·함안·창녕", note: "저밀도 자연 체류형 수요" },
      함안: { lat: 35.272, lon: 128.406, primary: "생활권·도심 수요형", secondary: "인접 관광 흡수형", resources: ["강", "근교"], target: "창원·진주", note: "창원 인접 생활권과 근교 숙박 수요" },
      창녕: { lat: 35.544, lon: 128.493, primary: "자연 관광자원형", secondary: "메인 관광지형", resources: ["습지", "온천"], target: "우포늪·부곡온천 수요", note: "자연 관광자원 중심 수요" },
      고성: { lat: 34.973, lon: 128.322, primary: "인접 관광 흡수형", secondary: "자연 관광자원형", resources: ["바다"], target: "통영·거제·사천", note: "남해안 주요 관광지 사이의 흡수 입지" },
      남해: { lat: 34.837, lon: 127.893, primary: "메인 관광지형", secondary: "자연 관광자원형", resources: ["바다", "섬"], target: "남해 해안 관광 수요", note: "해양 관광 목적지형 수요" },
      하동: { lat: 35.067, lon: 127.751, primary: "자연 관광자원형", secondary: "메인 관광지형", resources: ["산", "강"], target: "지리산·섬진강 수요", note: "산과 강 기반의 체류형 관광 수요" },
      산청: { lat: 35.415, lon: 127.873, primary: "자연 관광자원형", secondary: "메인 관광지형", resources: ["산", "계곡"], target: "지리산 관광 수요", note: "지리산권 자연 체류형 수요" },
      함양: { lat: 35.52, lon: 127.725, primary: "자연 관광자원형", secondary: "인접 관광 흡수형", resources: ["산", "계곡"], target: "지리산·거창", note: "산악권 자연 수요" },
      거창: { lat: 35.687, lon: 127.909, primary: "자연 관광자원형", secondary: "인접 관광 흡수형", resources: ["산", "계곡"], target: "함양·합천·지리산권", note: "북서부 산악권 체류 수요" },
      합천: { lat: 35.566, lon: 128.166, primary: "자연 관광자원형", secondary: "메인 관광지형", resources: ["호수", "산"], target: "합천호·가야산 수요", note: "호수와 산악 관광 수요" }
    }
  },
  jeonbuk: {
    label: "전북",
    keyword: "전북글램핑",
    mapBounds: { minLon: 126.35, maxLon: 127.85, minLat: 35.25, maxLat: 36.15 },
    profiles: {
      전주: { lat: 35.8242, lon: 127.148, primary: "생활권·도심 수요형", secondary: "인접 관광 흡수형", resources: ["도심", "문화"], target: "전주·완주 생활권", note: "도시 생활권과 한옥마을 관광 수요를 함께 흡수" },
      군산: { lat: 35.9676, lon: 126.736, primary: "메인 관광지형", secondary: "생활권·도심 수요형", resources: ["바다", "근대문화"], target: "군산 관광 수요", note: "서해안과 근대문화 관광 목적성" },
      익산: { lat: 35.9483, lon: 126.957, primary: "생활권·도심 수요형", secondary: "인접 관광 흡수형", resources: ["도심", "문화"], target: "전주·군산·익산 생활권", note: "전북 서북부 생활권 기반" },
      정읍: { lat: 35.5699, lon: 126.856, primary: "자연 관광자원형", secondary: "메인 관광지형", resources: ["산", "내장산"], target: "내장산 관광 수요", note: "내장산권 계절 관광 수요" },
      남원: { lat: 35.4164, lon: 127.39, primary: "메인 관광지형", secondary: "자연 관광자원형", resources: ["지리산", "문화"], target: "지리산·남원 관광 수요", note: "지리산 남부와 문화 관광 수요" },
      김제: { lat: 35.8036, lon: 126.88, primary: "생활권·도심 수요형", secondary: "인접 관광 흡수형", resources: ["농촌", "근교"], target: "전주·군산 인접 수요", note: "평야권 체험형·근교 수요" },
      완주: { lat: 35.9047, lon: 127.162, primary: "인접 관광 흡수형", secondary: "자연 관광자원형", resources: ["산", "계곡"], target: "전주 생활권", note: "전주 수요를 자연 체류형으로 흡수" },
      진안: { lat: 35.7917, lon: 127.424, primary: "자연 관광자원형", secondary: "메인 관광지형", resources: ["산", "마이산"], target: "마이산 관광 수요", note: "산악·자연 관광 목적성" },
      무주: { lat: 36.0068, lon: 127.661, primary: "메인 관광지형", secondary: "자연 관광자원형", resources: ["산", "리조트"], target: "덕유산·무주 관광 수요", note: "전북 대표 산악 체류 수요" },
      장수: { lat: 35.6474, lon: 127.521, primary: "자연 관광자원형", secondary: "인접 관광 흡수형", resources: ["산", "농촌"], target: "무주·남원 인접 수요", note: "저밀도 자연 체류형" },
      임실: { lat: 35.6178, lon: 127.289, primary: "자연 관광자원형", secondary: "인접 관광 흡수형", resources: ["호수", "치즈테마"], target: "전주·남원 인접 수요", note: "체험 관광과 자연 수요" },
      순창: { lat: 35.3745, lon: 127.137, primary: "자연 관광자원형", secondary: "인접 관광 흡수형", resources: ["강", "산"], target: "남원·담양 인접 수요", note: "남부 내륙 자연 수요" },
      고창: { lat: 35.4358, lon: 126.702, primary: "메인 관광지형", secondary: "자연 관광자원형", resources: ["바다", "고인돌"], target: "고창 관광 수요", note: "서해안과 문화유산 관광" },
      부안: { lat: 35.7318, lon: 126.733, primary: "메인 관광지형", secondary: "자연 관광자원형", resources: ["바다", "변산"], target: "변산반도 관광 수요", note: "서해안 목적지형 관광" }
    }
  },
  chungnam: {
    label: "충남",
    keyword: "충남글램핑",
    mapBounds: { minLon: 126.0, maxLon: 127.75, minLat: 35.95, maxLat: 37.05 },
    profiles: {
      천안: { lat: 36.8151, lon: 127.1139, primary: "생활권·도심 수요형", secondary: "인접 관광 흡수형", resources: ["도심", "근교"], target: "천안·아산 생활권", note: "수도권 남부와 충남 생활권 수요" },
      공주: { lat: 36.4465, lon: 127.119, primary: "메인 관광지형", secondary: "인접 관광 흡수형", resources: ["문화유산", "강"], target: "공주 관광 수요", note: "역사문화 관광 목적성" },
      보령: { lat: 36.3334, lon: 126.6128, primary: "메인 관광지형", secondary: "자연 관광자원형", resources: ["바다"], target: "대천·서해안 관광 수요", note: "서해안 해양 관광 수요" },
      아산: { lat: 36.7898, lon: 127.0025, primary: "생활권·도심 수요형", secondary: "인접 관광 흡수형", resources: ["온천", "도심"], target: "천안·아산 생활권", note: "생활권과 온천 관광 수요" },
      서산: { lat: 36.7845, lon: 126.45, primary: "자연 관광자원형", secondary: "인접 관광 흡수형", resources: ["바다", "호수"], target: "태안·당진 인접 수요", note: "서해안 자연 체류 수요" },
      논산: { lat: 36.1871, lon: 127.0987, primary: "생활권·도심 수요형", secondary: "인접 관광 흡수형", resources: ["농촌", "근교"], target: "대전·공주 인접 수요", note: "대전 인접 근교 수요" },
      계룡: { lat: 36.2746, lon: 127.2486, primary: "생활권·도심 수요형", secondary: "인접 관광 흡수형", resources: ["근교"], target: "대전 생활권", note: "대전권 근교 수요" },
      당진: { lat: 36.893, lon: 126.628, primary: "생활권·도심 수요형", secondary: "자연 관광자원형", resources: ["바다", "도심"], target: "서해안·평택 인접 수요", note: "산업도시 생활권과 해안 수요" },
      금산: { lat: 36.1089, lon: 127.488, primary: "자연 관광자원형", secondary: "인접 관광 흡수형", resources: ["산", "강"], target: "대전·무주 인접 수요", note: "대전 근교 자연 수요" },
      부여: { lat: 36.2757, lon: 126.9098, primary: "메인 관광지형", secondary: "자연 관광자원형", resources: ["문화유산", "강"], target: "백제문화 관광 수요", note: "역사문화 목적지" },
      서천: { lat: 36.0803, lon: 126.6917, primary: "자연 관광자원형", secondary: "메인 관광지형", resources: ["바다", "강"], target: "서해안·금강 수요", note: "해안과 금강 자연 수요" },
      청양: { lat: 36.4592, lon: 126.8022, primary: "자연 관광자원형", secondary: "인접 관광 흡수형", resources: ["산"], target: "공주·부여 인접 수요", note: "칠갑산 자연 체류 수요" },
      홍성: { lat: 36.6013, lon: 126.6608, primary: "생활권·도심 수요형", secondary: "자연 관광자원형", resources: ["근교", "바다"], target: "충남도청권", note: "내포 생활권과 해안 접근 수요" },
      예산: { lat: 36.6826, lon: 126.848, primary: "인접 관광 흡수형", secondary: "생활권·도심 수요형", resources: ["호수", "시장"], target: "내포·아산 인접 수요", note: "예당호와 내포권 수요" },
      태안: { lat: 36.7456, lon: 126.2979, primary: "메인 관광지형", secondary: "자연 관광자원형", resources: ["바다"], target: "태안 해안 관광 수요", note: "서해안 대표 목적지형 수요" }
    }
  },
  chungbuk: {
    label: "충북",
    keyword: "충북글램핑",
    mapBounds: { minLon: 127.25, maxLon: 128.65, minLat: 36.0, maxLat: 37.25 },
    profiles: {
      청주: { lat: 36.6424, lon: 127.489, primary: "생활권·도심 수요형", secondary: "인접 관광 흡수형", resources: ["도심", "근교"], target: "청주 생활권", note: "충북 최대 생활권 기반" },
      충주: { lat: 36.991, lon: 127.9259, primary: "자연 관광자원형", secondary: "생활권·도심 수요형", resources: ["호수", "산"], target: "충주호 관광 수요", note: "호수·산악 체류형 수요" },
      제천: { lat: 37.1326, lon: 128.191, primary: "메인 관광지형", secondary: "자연 관광자원형", resources: ["호수", "산"], target: "청풍호·제천 관광 수요", note: "충북 북부 대표 체류형 관광" },
      보은: { lat: 36.4895, lon: 127.7295, primary: "자연 관광자원형", secondary: "메인 관광지형", resources: ["산"], target: "속리산 관광 수요", note: "속리산권 자연 관광" },
      옥천: { lat: 36.3064, lon: 127.5713, primary: "인접 관광 흡수형", secondary: "자연 관광자원형", resources: ["강", "근교"], target: "대전 인접 수요", note: "대전 근교 자연 수요" },
      영동: { lat: 36.175, lon: 127.7834, primary: "자연 관광자원형", secondary: "인접 관광 흡수형", resources: ["강", "산"], target: "대전·무주 인접 수요", note: "남부 산악·강변 수요" },
      증평: { lat: 36.7854, lon: 127.5815, primary: "생활권·도심 수요형", secondary: "인접 관광 흡수형", resources: ["근교"], target: "청주·진천 생활권", note: "청주 인접 생활권 수요" },
      진천: { lat: 36.8554, lon: 127.4356, primary: "생활권·도심 수요형", secondary: "인접 관광 흡수형", resources: ["근교", "호수"], target: "청주·안성 인접 수요", note: "수도권 남부와 청주 사이 수요" },
      괴산: { lat: 36.8153, lon: 127.7867, primary: "자연 관광자원형", secondary: "메인 관광지형", resources: ["계곡", "산"], target: "괴산 자연 관광 수요", note: "계곡·산악 캠핑 수요" },
      음성: { lat: 36.9402, lon: 127.6905, primary: "생활권·도심 수요형", secondary: "인접 관광 흡수형", resources: ["근교"], target: "진천·충주·안성 인접 수요", note: "중부내륙 생활권 수요" },
      단양: { lat: 36.9846, lon: 128.3655, primary: "메인 관광지형", secondary: "자연 관광자원형", resources: ["강", "산"], target: "단양 관광 수요", note: "남한강·산악 목적지형 관광" }
    }
  },
  gyeonggi_south: {
    label: "경기남부",
    keyword: "경기남부글램핑",
    mapBounds: { minLon: 126.8, maxLon: 127.8, minLat: 36.85, maxLat: 37.55 },
    profiles: {
      안성: { lat: 37.008, lon: 127.2797, primary: "인접 관광 흡수형", secondary: "생활권·도심 수요형", resources: ["호수", "근교"], target: "평택·용인·천안 인접 수요", note: "수도권 남부와 충남 북부 사이의 흡수 입지" },
      이천: { lat: 37.2721, lon: 127.435, primary: "인접 관광 흡수형", secondary: "생활권·도심 수요형", resources: ["도자", "근교"], target: "서울동남권·여주·용인", note: "수도권 동남부 근교 체류 수요" },
      용인: { lat: 37.2411, lon: 127.1776, primary: "생활권·도심 수요형", secondary: "인접 관광 흡수형", resources: ["도심", "테마파크"], target: "서울남부·수원 생활권", note: "생활권과 체험형 수요가 결합" },
      여주: { lat: 37.298, lon: 127.637, primary: "인접 관광 흡수형", secondary: "자연 관광자원형", resources: ["강", "아울렛"], target: "이천·원주·서울동남권", note: "남한강과 쇼핑/근교 수요" },
      평택: { lat: 36.9921, lon: 127.1127, primary: "생활권·도심 수요형", secondary: "인접 관광 흡수형", resources: ["도심", "근교"], target: "평택·안성 생활권", note: "인구 기반 생활형 수요" },
      화성: { lat: 37.1996, lon: 126.831, primary: "생활권·도심 수요형", secondary: "자연 관광자원형", resources: ["바다", "도심"], target: "수원·동탄·서해안 수요", note: "대도시 생활권과 서해안 접근 수요" },
      오산: { lat: 37.1498, lon: 127.0772, primary: "생활권·도심 수요형", secondary: "인접 관광 흡수형", resources: ["도심"], target: "수원·화성·평택 생활권", note: "생활권 기반 근교 수요" },
      경기광주: { lat: 37.4294, lon: 127.255, primary: "인접 관광 흡수형", secondary: "자연 관광자원형", resources: ["산", "계곡"], target: "서울동남권·성남", note: "서울 동남권 근교 자연 수요" },
      양평: { lat: 37.4918, lon: 127.4876, primary: "자연 관광자원형", secondary: "인접 관광 흡수형", resources: ["강", "산"], target: "서울동부·남양주 인접 수요", note: "수도권 자연 체류형 대표 지역" }
    }
  },
  gyeonggi: {
    label: "경기",
    keyword: "경기글램핑",
    mapBounds: { minLon: 126.45, maxLon: 127.95, minLat: 36.85, maxLat: 38.35 },
    profiles: {
      포천: { lat: 37.8949, lon: 127.2003, primary: "자연 관광자원형", secondary: "인접 관광 흡수형, 생활권·도심 수요형", resources: ["산", "계곡", "호수"], target: "서울·의정부·남양주", note: "수도권 근교 자연 체류형 수요와 당일/1박 수요를 함께 흡수" }
    }
  },
  local: {
    label: "지역",
    keyword: "지역글램핑",
    mapBounds: { minLon: 126.5, maxLon: 130.5, minLat: 34.5, maxLat: 38.5 },
    profiles: {}
  }
};

const DEMAND_LEVEL_SCORES = {
  "최상": 100,
  "상": 85,
  "중상": 70,
  "중": 55,
  "중하": 40,
  "하": 25
};

const DEMAND_SEGMENTS = [
  {
    name: "대학생 커플",
    group: "커플형",
    weekend: 4,
    weekday: 5,
    conversion: 5,
    weight: 14,
    priority: 5,
    seasons: ["봄", "가을"],
    keywords: ["장박", "가격민감", "불멍"],
    message: "평일에도 부담 적은 입문형 글램핑",
    operation: "평일특가, 감성사진, 불멍 강조",
    caution: "초등 가족",
    status: "유지"
  },
  {
    name: "직장인 커플",
    group: "커플형",
    weekend: 5,
    weekday: 2,
    conversion: 4,
    weight: 18,
    priority: 3,
    seasons: ["봄", "가을", "연말"],
    keywords: ["기념일", "프라이빗"],
    message: "주말에 쉬기 좋은 프라이빗 글램핑",
    operation: "금·토 집중, 기념일형 상품",
    caution: "평일 유입 약함",
    status: "유지"
  },
  {
    name: "대학생 그룹",
    group: "그룹형",
    weekend: 5,
    weekday: 5,
    conversion: 4,
    weight: 9,
    priority: 4,
    seasons: ["여름", "겨울"],
    keywords: ["가성비", "단체", "추억"],
    message: "친구들과 가볍게 즐기는 단체 글램핑",
    operation: "방학 시즌, 단체 사진 강조",
    caution: "소음 관리 필요",
    status: "유지"
  },
  {
    name: "직장인 그룹",
    group: "그룹형",
    weekend: 5,
    weekday: 2,
    conversion: 3,
    weight: 9,
    priority: 2,
    seasons: ["봄", "가을"],
    keywords: ["워크숍", "모임"],
    message: "소규모 모임에 적합한 글램핑",
    operation: "기업/소모임 제안형",
    caution: "일정 제약 큼",
    status: "검토"
  },
  {
    name: "영유아 가족",
    group: "가족형",
    weekend: 4,
    weekday: 3,
    conversion: 4,
    weight: 8,
    priority: 4,
    seasons: ["봄", "여름", "가을"],
    keywords: ["안전", "편의", "가족"],
    message: "부모가 편한 가족형 글램핑",
    operation: "낮시간 체류, 부모 편의 강조",
    caution: "",
    status: "유지"
  },
  {
    name: "초등 가족",
    group: "가족형",
    weekend: 4,
    weekday: 4,
    conversion: 5,
    weight: 15,
    priority: 5,
    seasons: ["봄", "여름", "가을"],
    keywords: ["체험", "안전", "가족"],
    message: "아이와 함께 즐기는 가족형 글램핑",
    operation: "체험, 야외동선, 부모 편의 강조",
    caution: "우천 변수 큼",
    status: "유지"
  },
  {
    name: "중고등 가족",
    group: "가족형",
    weekend: 5,
    weekday: 1,
    conversion: 2,
    weight: 11,
    priority: 1,
    seasons: ["여름", "연휴"],
    keywords: ["연휴", "단기휴가"],
    message: "방학·연휴 한정 가족형 수요",
    operation: "방학/연휴 특화",
    caution: "평시 반응 약함",
    status: "보완"
  },
  {
    name: "자연체류형",
    group: "평일확장형",
    weekend: 3,
    weekday: 5,
    conversion: 5,
    weight: 10,
    priority: 5,
    seasons: ["가을", "겨울", "연중"],
    keywords: ["조용한 쉼", "자연"],
    message: "조용히 쉬기 좋은 자연형 글램핑",
    operation: "평일쉼, 야간 불멍, 산책 강조",
    caution: "화려한 연출보다 안정감",
    status: "유지"
  },
  {
    name: "프리랜서·원격근무",
    group: "평일확장형",
    weekend: 2,
    weekday: 5,
    conversion: 4,
    weight: 4,
    priority: 4,
    seasons: ["연중"],
    keywords: ["워케이션", "장박"],
    message: "평일에도 머물 수 있는 워케이션형 글램핑",
    operation: "와이파이, 테이블, 조용한 공간",
    caution: "장박 운영 기준 필요",
    status: "검토"
  },
  {
    name: "은퇴 시니어",
    group: "시니어형",
    weekend: 2,
    weekday: 5,
    conversion: 3,
    weight: 2,
    priority: 2,
    seasons: ["봄", "가을"],
    keywords: ["평일", "조용함"],
    message: "전 세그먼트",
    operation: "낮시간, 동선 단순화, 조용함",
    caution: "디지털 예약 불편 가능",
    status: "검토"
  }
];

const MONTHLY_DEMAND_MAP = [
  { month: 1, season: "겨울", level: "중상", weekdaySignal: "중고생 겨울캠프", targets: ["커플", "자연체류형", "대학생 커플"], keywords: ["겨울", "불멍", "온기"], operation: "숨은 성수기 관리", action: "리뷰 축적, 겨울 콘텐츠 확보", price: "보합", content: "야간사진, 불멍, 온기", risks: ["장박"], interpretation: "겨울 감성 후기 유지" },
  { month: 2, season: "겨울", level: "중상", weekdaySignal: "중고생 겨울캠프", targets: ["커플", "가족형"], keywords: ["설날", "겨울마감"], operation: "연휴 대응", action: "연휴형 상품 정리", price: "보합", content: "설 연휴, 가족 모임", risks: ["한파", "연휴 집중"], interpretation: "연휴 집중형 운영 유지검토 필요" },
  { month: 3, season: "봄", level: "중하", weekdaySignal: "초등 가족", targets: ["시니어형", "대학생 커플"], keywords: ["봄 시작", "비수기"], operation: "가격 민감 구간", action: "프로모션, 입문형 상품", price: "한정 할인", content: "봄 전환, 자연 회복", risks: ["날씨 불안정"], interpretation: "평일형 타겟 확장 권장" },
  { month: 4, season: "봄", level: "중", weekdaySignal: "직장인 커플", targets: ["초등 가족", "대학생 커플"], keywords: ["벚꽃", "봄나들이"], operation: "야외활동 회복", action: "봄 사진 교체, 가족형 문구 강화", price: "보합", content: "벚꽃, 산책, 가족 체험", risks: ["비", "미세먼지"], interpretation: "초등 가족 반응 증가" },
  { month: 5, season: "봄", level: "상", weekdaySignal: "가족 단위", targets: ["초등 가족", "영유아 가족"], keywords: ["어린이날", "어버이날"], operation: "가족 중심 달", action: "가족 패키지 강화", price: "연휴 중심 단가 유지", content: "가족 체험, 연휴", risks: ["날씨", "행사 집중"], interpretation: "가족 키워드 강화 권장" },
  { month: 6, season: "여름", level: "중", weekdaySignal: "대학엠티", targets: ["소규모 활동", "커플"], keywords: ["초여름", "활동적인 구간"], operation: "장마 전 구간", action: "단체 어트랙션", price: "보합", content: "어트랙션, 액티비티", risks: ["장마"], interpretation: "평일형 메시지 유효" },
  { month: 7, season: "여름", level: "최상", weekdaySignal: "전 세그먼트", targets: ["가족형", "커플형"], keywords: ["여름휴가 시작"], operation: "성수기 운영", action: "단가 최적화", price: "단가 유지", content: "수영/야외, 휴가", risks: ["장마", "폭염"], interpretation: "성수기 단가 방어 우선" },
  { month: 8, season: "여름", level: "최상", weekdaySignal: "전 세그먼트", targets: ["가족형", "그룹형"], keywords: ["여름휴가 절정"], operation: "성수기 운영", action: "리뷰/사진 최대 확보", price: "단가 유지", content: "활동감, 여름 경험", risks: ["폭염"], interpretation: "후기 축적 최우선" },
  { month: 9, season: "가을", level: "중", weekdaySignal: "커플", targets: ["초등 가족", "자연체류형"], keywords: ["가을 시작", "추석"], operation: "회복 구간", action: "가을 콘텐츠 전환", price: "보합", content: "초가을, 가족/커플", risks: ["태풍", "추석 편차"], interpretation: "가을 전환기 콘텐츠 필요" },
  { month: 10, season: "가을", level: "상", weekdaySignal: "전 세그먼트", targets: ["커플형", "가족형"], keywords: ["단풍", "야외활동"], operation: "가을 성수기", action: "대표 시즌 브랜딩 강화", price: "단가 유지", content: "단풍, 산책, 야외경험", risks: ["주말 몰림"], interpretation: "대표 시즌 키워드 강화" },
  { month: 11, season: "가을", level: "중상", weekdaySignal: "커플", targets: ["자연체류형", "프리랜서형"], keywords: ["늦가을", "불멍", "조용한 쉼"], operation: "감성보다 깊게 쉬는 경험", action: "평일쉼 상품, 불멍 강조", price: "보합/패키지", content: "야간사진, 불멍, 온기", risks: ["한파 시작"], interpretation: "평일 반응은 자연체류형이 강함" },
  { month: 12, season: "겨울", level: "중", weekdaySignal: "직장인 모임", targets: ["커플", "자연체류형"], keywords: ["연말", "소모임"], operation: "송년 시즌", action: "소규모 모임형/커플형 운영", price: "보합", content: "연말 감성, 불멍", risks: ["한파", "예약 편차"], interpretation: "연말 소모임 수요 반영" }
];

const DEMAND_AI_SIGNALS = [
  { keyword: "조용한 쉼", segment: "자연체류형", frequency: 12, signal: "조용함, 불멍, 쉬기 좋음", proposal: "11월~2월 자연체류형 메시지 강화" },
  { keyword: "아이와 함께", segment: "초등 가족", frequency: 8, signal: "체험, 안전", proposal: "4~5월 가족형 키워드 보강" }
];

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".geojson": "application/geo+json; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".png": "image/png",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
};

const trafficKeyFields = [
  "naverClientId",
  "naverClientSecret",
  "searchadApiKey",
  "searchadSecretKey",
  "searchadCustomerId"
];

function maskSecret(value) {
  const text = String(value || "");
  if (!text) return "";
  if (text.length <= 6) return "*".repeat(text.length);
  return `${text.slice(0, 3)}${"*".repeat(Math.max(3, text.length - 6))}${text.slice(-3)}`;
}

function normalizeApiKey(value) {
  return String(value || "").replace(/\s+/g, "").trim();
}

async function readTrafficKeys() {
  let saved = {};
  try {
    saved = JSON.parse((await fsp.readFile(TRAFFIC_KEYS_FILE, "utf8")).replace(/^\uFEFF/, ""));
  } catch {
    saved = {};
  }

  return {
    naverClientId: normalizeApiKey(process.env.NAVER_CLIENT_ID || saved.naverClientId || ""),
    naverClientSecret: normalizeApiKey(process.env.NAVER_CLIENT_SECRET || saved.naverClientSecret || ""),
    searchadApiKey: normalizeApiKey(process.env.NAVER_SEARCHAD_API_KEY || saved.searchadApiKey || ""),
    searchadSecretKey: normalizeApiKey(process.env.NAVER_SEARCHAD_SECRET_KEY || saved.searchadSecretKey || ""),
    searchadCustomerId: normalizeApiKey(process.env.NAVER_SEARCHAD_CUSTOMER_ID || saved.searchadCustomerId || "")
  };
}

function trafficKeyStatus(keys) {
  const envFields = {
    naverClientId: Boolean(process.env.NAVER_CLIENT_ID),
    naverClientSecret: Boolean(process.env.NAVER_CLIENT_SECRET),
    searchadApiKey: Boolean(process.env.NAVER_SEARCHAD_API_KEY),
    searchadSecretKey: Boolean(process.env.NAVER_SEARCHAD_SECRET_KEY),
    searchadCustomerId: Boolean(process.env.NAVER_SEARCHAD_CUSTOMER_ID)
  };
  return {
    datalabConfigured: Boolean(keys.naverClientId && keys.naverClientSecret),
    searchadConfigured: Boolean(keys.searchadApiKey && keys.searchadSecretKey && keys.searchadCustomerId),
    storage: {
      configDir: CONFIG_DIR,
      file: TRAFFIC_KEYS_FILE,
      persistent: HAS_RENDER_DISK || !isTmpDataPath(CONFIG_DIR),
      envOverride: Object.values(envFields).some(Boolean),
      envFields
    },
    fields: Object.fromEntries(
      trafficKeyFields.map((field) => [
        field,
        {
          configured: Boolean(keys[field]),
          masked: maskSecret(keys[field])
        }
      ])
    )
  };
}

async function saveTrafficKeys(payload) {
  await fsp.mkdir(CONFIG_DIR, { recursive: true });
  const current = await readTrafficKeys();
  const next = { ...current };

  for (const field of trafficKeyFields) {
    if (Object.prototype.hasOwnProperty.call(payload, field)) {
      const value = normalizeApiKey(payload[field]);
      if (value) next[field] = value;
    }
  }

  await fsp.writeFile(TRAFFIC_KEYS_FILE, JSON.stringify(next, null, 2), "utf8");
  return trafficKeyStatus(next);
}

function summarizeTrafficApiCheck(result, configured) {
  if (!configured) {
    return {
      configured: false,
      ok: false,
      status: null,
      message: "API key is not configured."
    };
  }

  return {
    configured: true,
    ok: Boolean(result?.collectable),
    status: result?.status || null,
    message: result?.collectable
      ? "OK"
      : (result?.reason || result?.message || result?.errorMessage || "API verification failed.")
  };
}

async function verifyTrafficKeys() {
  const keys = await readTrafficKeys();
  const status = trafficKeyStatus(keys);
  const keyword = "글램핑";
  const datalabConfigured = Boolean(keys.naverClientId && keys.naverClientSecret);
  const searchadConfigured = Boolean(keys.searchadApiKey && keys.searchadSecretKey && keys.searchadCustomerId);

  const [datalabResult, searchadResult] = await Promise.all([
    datalabConfigured ? collectDatalabTrend(keyword, keys) : Promise.resolve(null),
    searchadConfigured ? collectSearchAdMetric(keyword, keys) : Promise.resolve(null)
  ]);

  return {
    ...status,
    verification: {
      checkedAt: new Date().toISOString(),
      keyword,
      datalab: summarizeTrafficApiCheck(datalabResult, datalabConfigured),
      searchad: summarizeTrafficApiCheck(searchadResult, searchadConfigured)
    }
  };
}

function timingSafeTextEqual(left, right) {
  const leftBuffer = Buffer.from(String(left || ""));
  const rightBuffer = Buffer.from(String(right || ""));
  if (leftBuffer.length !== rightBuffer.length) return false;
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function parseCookies(req) {
  return Object.fromEntries(
    String(req.headers.cookie || "")
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const index = part.indexOf("=");
        if (index < 0) return [part, ""];
        return [part.slice(0, index), decodeURIComponent(part.slice(index + 1))];
      })
  );
}

function sessionCookie(value, maxAgeSeconds = SESSION_TTL_MS / 1000) {
  return [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(value || "")}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    IS_PRODUCTION_RUNTIME ? "Secure" : "",
    `Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`
  ].filter(Boolean).join("; ");
}

function clearSessionCookie() {
  return sessionCookie("", 0);
}

function cleanupSessions() {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (!session || session.expiresAt <= now) sessions.delete(id);
  }
}

function createSession(username) {
  cleanupSessions();
  const id = crypto.randomBytes(32).toString("base64url");
  sessions.set(id, {
    username,
    createdAt: Date.now(),
    expiresAt: Date.now() + SESSION_TTL_MS
  });
  return id;
}

function getSession(req) {
  cleanupSessions();
  const id = parseCookies(req)[SESSION_COOKIE_NAME];
  if (!id) return null;
  const session = sessions.get(id);
  if (!session || session.expiresAt <= Date.now()) {
    sessions.delete(id);
    return null;
  }
  session.expiresAt = Date.now() + SESSION_TTL_MS;
  return { id, ...session };
}

function isAuthenticated(req) {
  return Boolean(getSession(req));
}

function acceptsHtml(req) {
  return String(req.headers.accept || "").includes("text/html");
}

function loginPage(message = "") {
  const escapedMessage = String(message || "").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>글램핑데이터랩 로그인</title>
  <style>
    :root { color-scheme: light; font-family: Arial, "Malgun Gothic", sans-serif; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f4f6f8; color: #101828; }
    main { width: min(100% - 32px, 420px); padding: 30px; border: 1px solid #e4e7ec; border-radius: 24px; background: #fff; box-shadow: 0 18px 48px rgba(16, 24, 40, .10); }
    h1 { margin: 0 0 8px; font-size: 28px; font-weight: 900; letter-spacing: 0; }
    p { margin: 0 0 22px; color: #667085; line-height: 1.45; }
    label { display: grid; gap: 8px; margin-top: 14px; font-size: 13px; font-weight: 800; color: #344054; }
    input { width: 100%; min-height: 52px; padding: 0 14px; border: 1px solid #d0d5dd; border-radius: 14px; font: inherit; font-size: 17px; outline: none; }
    input:focus { border-color: #3182f6; box-shadow: 0 0 0 4px rgba(49, 130, 246, .12); }
    button { width: 100%; min-height: 54px; margin-top: 20px; border: 0; border-radius: 16px; background: #3182f6; color: #fff; font: inherit; font-size: 17px; font-weight: 900; cursor: pointer; }
    button:disabled { opacity: .6; cursor: wait; }
    .error { min-height: 20px; margin-top: 14px; color: #f04438; font-size: 13px; font-weight: 800; }
  </style>
</head>
<body>
  <main>
    <h1>글램핑데이터랩</h1>
    <p>계정 정보를 입력하면 분석 화면으로 이동합니다.</p>
    <form method="post" action="/login">
      <label>아이디<input name="username" autocomplete="username" autofocus required></label>
      <label>비밀번호<input name="password" type="password" autocomplete="current-password" required></label>
      <button type="submit">로그인</button>
      <div class="error">${escapedMessage}</div>
    </form>
  </main>
</body>
</html>`;
}

function sendLogin(res, status = 200, message = "") {
  return send(res, status, loginPage(message), "text/html; charset=utf-8");
}

function requireLogin(req, res, reqUrl) {
  if (isAuthenticated(req)) return true;
  if (req.method === "GET" && acceptsHtml(req)) {
    sendLogin(res, 200);
  } else if (req.method === "HEAD") {
    sendHead(res, 401);
  } else {
    send(res, 401, { error: "로그인이 필요합니다." });
  }
  return false;
}

function securityHeaders() {
  const headers = {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "X-Robots-Tag": "noindex, nofollow",
    "Referrer-Policy": "same-origin",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    "Content-Security-Policy": [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "connect-src 'self'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'"
    ].join("; ")
  };

  if (IS_PRODUCTION_RUNTIME) {
    headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains";
  }

  return headers;
}

function send(res, status, body, contentType = "application/json; charset=utf-8", extraHeaders = {}) {
  const payload = typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, {
    ...securityHeaders(),
    "Content-Type": contentType,
    "Cache-Control": "no-store",
    ...extraHeaders
  });
  res.end(payload);
}

function sendHead(res, status, contentType = "application/json; charset=utf-8", extraHeaders = {}) {
  res.writeHead(status, {
    ...securityHeaders(),
    "Content-Type": contentType,
    "Cache-Control": "no-store",
    ...extraHeaders
  });
  res.end();
}

function notFound(res) {
  send(res, 404, { error: "Not found" });
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        req.destroy();
        reject(new Error("Request body is too large"));
      }
    });
    req.on("end", () => {
      resolve(body);
    });
  });
}

async function parseJsonBody(req) {
  const body = await readRequestBody(req);
  if (!body.trim()) return {};
  return JSON.parse(body);
}

async function parseLoginBody(req) {
  const body = await readRequestBody(req);
  if (!body.trim()) return {};
  if (String(req.headers["content-type"] || "").includes("application/json")) {
    return JSON.parse(body);
  }
  return Object.fromEntries(new URLSearchParams(body));
}

function safeJoin(base, requestPath) {
  const decoded = decodeURIComponent(requestPath);
  const resolvedBase = path.resolve(base);
  const resolved = path.resolve(resolvedBase, decoded.replace(/^[/\\]+/, ""));
  const relative = path.relative(resolvedBase, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return resolved;
}

function detectProvince(idOrName) {
  if (idOrName.includes("gyeonggi_south")) return "gyeonggi_south";
  if (idOrName.includes("jeonbuk")) return "jeonbuk";
  if (idOrName.includes("chungnam")) return "chungnam";
  if (idOrName.includes("chungbuk")) return "chungbuk";
  if (idOrName.includes("gyeongbuk")) return "gyeongbuk";
  if (idOrName.includes("gyeongnam")) return "gyeongnam";
  if (idOrName.includes("gyeonggi") || idOrName.includes("pocheon")) return "gyeonggi";
  return "local";
}

function provinceKeyForRun(dirName, manifest) {
  return manifest?.provinceKey && PROVINCES[manifest.provinceKey] ? manifest.provinceKey : detectProvince(dirName);
}

function displayNameForRun(dirName, manifest = null) {
  const province = PROVINCES[provinceKeyForRun(dirName, manifest)] || PROVINCES.local;
  const keyword = manifest?.keyword || province.keyword;
  const modePrefix = manifest?.searchMode === "company" || manifest?.keywordType === "company" ? "업체명 · " : "";
  const date = dirName.match(/(\d{8})/)?.[1] || "";
  return `${modePrefix}${keyword}${date ? ` · ${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6)}` : ""}`;
}

async function readRunConditions(dirPath, manifest, reportFile) {
  const result = {
    checkIn: manifest?.checkIn || "",
    checkOut: manifest?.checkOut || "",
    adults: manifest?.adults || "",
    productMode: manifest?.productMode || ""
  };
  if ((result.checkIn && result.checkOut && result.adults) || !reportFile) return result;

  try {
    const report = await fsp.readFile(path.join(dirPath, reportFile), "utf8");
    const match = report.match(/성인\s*(\d+)명,\s*1박,\s*체크인\s*(\d{4}-\d{2}-\d{2})\s*\/\s*체크아웃\s*(\d{4}-\d{2}-\d{2})/);
    if (match) {
      result.adults ||= Number(match[1]);
      result.checkIn ||= match[2];
      result.checkOut ||= match[3];
    }
  } catch {
    // Older runs may not have a report file; keep form defaults in that case.
  }
  return result;
}

async function readManifest(dirPath) {
  try {
    return JSON.parse(await fsp.readFile(path.join(dirPath, "manifest.json"), "utf8"));
  } catch {
    return null;
  }
}

function manifestFile(manifest, role, files, legacyMatcher) {
  const candidate = manifest?.fileRoles?.[role];
  if (candidate && files.includes(candidate)) return candidate;
  return files.find(legacyMatcher);
}

function safeFilePart(value, fallback = "검색") {
  const cleaned = String(value || "")
    .normalize("NFKC")
    .replace(/[\\/:*?"<>|]/g, " ")
    .replace(/\s+/g, "_")
    .replace(/^_+|_+$/g, "");
  return (cleaned || fallback).slice(0, 80);
}

function downloadLabelForFile(file, manifest = {}) {
  const roles = manifest.fileRoles || {};
  const role = Object.entries(roles).find(([, name]) => name === file)?.[0];
  const labels = {
    platform: "플랫폼 통합 결과",
    report: "수집 리포트",
    overall: "네이버 전체 순위",
    ads: "네이버 광고 순위",
    regional: "네이버 지역별 순위",
    ddnayo: "떠나요 검색 결과",
    workbook: "전체 수집 결과",
    naverWorkbook: "네이버 순위 통합",
    yeogiManual: "여기어때 수동 보완"
  };
  if (role && labels[role]) return labels[role];
  if (/_glamping_crawl_test_report\.md$/i.test(file)) return "수집 리포트";
  if (/_glamping_crawl_test\.csv$/i.test(file)) return "플랫폼 통합 결과";
  if (/_overall_place_rank\.csv$/i.test(file)) return "네이버 전체 순위";
  if (/_ad_place_list\.csv$/i.test(file)) return "네이버 광고 순위";
  if (/_naver_place_glamping_clusters\.csv$/i.test(file)) return "네이버 지역별 순위";
  if (/_ddnayo_search_results\.csv$/i.test(file)) return "떠나요 검색 결과";
  if (/_glamping_crawl_results\.xlsx$/i.test(file)) return "전체 수집 결과";
  if (/_naver_place_glamping_clusters_with_overall\.xlsx$/i.test(file)) return "네이버 순위 통합";
  if (/_yeogi_manual_import\.csv$/i.test(file)) return "여기어때 수동 보완";
  return file;
}

async function listRuns() {
  await fsp.mkdir(OUTPUTS_DIR, { recursive: true });
  const entries = await fsp.readdir(OUTPUTS_DIR, { withFileTypes: true });
  const runs = [];

  for (const entry of entries) {
    if (!entry.isDirectory() || !/_glamping_\d{8}(?:_\d{6})?$/.test(entry.name)) continue;
    const dirPath = path.join(OUTPUTS_DIR, entry.name);
    const files = await fsp.readdir(dirPath).catch(() => []);
    const manifest = await readManifest(dirPath);
    if (!manifest && files.length === 0) continue;
    if (manifest && /^\?+$/.test(String(manifest.keyword || "").trim())) continue;
    const stat = await fsp.stat(dirPath);
    const provinceKey = provinceKeyForRun(entry.name, manifest);

    runs.push({
      id: entry.name,
      label: displayNameForRun(entry.name, manifest),
      province: provinceKey,
      provinceLabel: (PROVINCES[provinceKey] || PROVINCES.local).label,
      updatedAt: stat.mtime.toISOString(),
      counts: manifest?.counts || {},
      files: manifest?.files || files
    });
  }

  return runs.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

async function seedOutputsFromRepo() {
  const source = path.resolve(REPO_OUTPUTS_DIR);
  const target = path.resolve(OUTPUTS_DIR);
  if (process.env.SEED_OUTPUTS_FROM_REPO === "0" || source === target || !fs.existsSync(source)) return;

  await fsp.mkdir(target, { recursive: true });
  const entries = await fsp.readdir(source, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || !/_glamping_\d{8}(?:_\d{6})?$/.test(entry.name)) continue;
    const from = path.join(source, entry.name);
    const to = path.join(target, entry.name);
    if (fs.existsSync(to)) continue;
    await fsp.cp(from, to, { recursive: true });
  }
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];

    if (char === '"') {
      if (quoted && next === '"') {
        field += '"';
        i += 1;
      } else {
        quoted = !quoted;
      }
      continue;
    }

    if (char === "," && !quoted) {
      row.push(field);
      field = "";
      continue;
    }

    if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && next === "\n") i += 1;
      row.push(field);
      if (row.some((value) => value.length > 0)) rows.push(row);
      row = [];
      field = "";
      continue;
    }

    field += char;
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  const headers = rows.shift() || [];
  return rows.map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index] || ""])));
}

function csvEscape(value) {
  if (value === null || value === undefined) return "";
  const text = String(value);
  if (/[",\r\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

async function writeCsv(filePath, rows, columns) {
  const lines = [
    columns.join(","),
    ...rows.map((row) => columns.map((column) => csvEscape(row[column])).join(","))
  ];
  await fsp.writeFile(filePath, `\uFEFF${lines.join("\n")}`, "utf8");
}

function csvHeaderLine(text) {
  return String(text || "")
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/, 1)[0]
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function orderedColumns(rows, preferred = []) {
  const seen = new Set();
  const columns = [];
  for (const column of preferred) {
    if (!seen.has(column)) {
      seen.add(column);
      columns.push(column);
    }
  }
  for (const row of rows) {
    for (const column of Object.keys(row)) {
      if (!seen.has(column)) {
        seen.add(column);
        columns.push(column);
      }
    }
  }
  return columns;
}

function decodeHtmlEntities(text) {
  return String(text || "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

function htmlToLines(text) {
  const cleaned = decodeHtmlEntities(String(text || ""))
    .replace(/<script[\s\S]*?<\/script>/gi, "\n")
    .replace(/<style[\s\S]*?<\/style>/gi, "\n")
    .replace(/<(br|p|li|div|article|section|a|span|strong|em|h[1-6])\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, "\n")
    .replace(/\r/g, "\n");
  return cleaned
    .split(/\n+/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

const YEOGI_CATEGORY_RE = /(?:풀빌라\s*펜션|비즈니스\s*호텔|레지던스\s*호텔|관광\s*호텔|모텔|호텔|펜션|캠핑|리조트|게스트하우스|한옥|카라반)/i;
const YEOGI_CATEGORY_START_RE = /^(?:풀빌라\s*펜션|비즈니스\s*호텔|레지던스\s*호텔|관광\s*호텔|모텔|호텔|펜션|캠핑|리조트|게스트하우스|한옥|카라반)\s*/i;
const YEOGI_PRICE_RE = /(?:\d{1,3},)*\d{1,3}\s*원\s*~?|(?:\d{1,3},)+\d{3}/g;

function yeogiTextLines(text) {
  const categoryBreakRe = /(원|개|확인|마감|매진)(풀빌라\s*펜션|비즈니스\s*호텔|레지던스\s*호텔|관광\s*호텔|모텔|호텔|펜션|캠핑|리조트|게스트하우스|한옥|카라반)(?=[가-힣A-Za-z0-9★\[])/g;
  return htmlToLines(text)
    .flatMap((line) => line.replace(categoryBreakRe, "$1\n$2").split(/\n+/))
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function yeogiLowestPrice(text) {
  const matches = String(text || "").match(YEOGI_PRICE_RE) || [];
  const values = matches
    .map((item) => Number(String(item).replace(/[^\d]/g, "")))
    .filter((value) => Number.isFinite(value) && value >= 10000);
  if (!values.length) return matches[0] || "";
  return `${Math.min(...values).toLocaleString("ko-KR")}원`;
}

function yeogiLocationFromText(text) {
  const match = String(text || "").match(/[가-힣]{2,20}(?:시|군|구|읍|면|동)/);
  if (!match) return { value: "", index: -1 };
  const raw = match[0];
  const afterLodgingWord = raw.match(/.*(?:글램핑|캠핑|카라반|펜션|풀빌라|리조트|스파|호텔|빌라)([가-힣]{2,6}(?:시|군|구|읍|면|동))$/)?.[1];
  const suffix = afterLodgingWord || raw.match(/[가-힣]{2,4}(?:시|군|구|읍|면|동)$/)?.[0] || raw;
  return { value: suffix, index: (match.index || 0) + raw.lastIndexOf(suffix) };
}

function cleanYeogiName(value) {
  return String(value || "")
    .replace(YEOGI_CATEGORY_START_RE, "")
    .replace(/^(?:Image|이미지|대표 사진|광고)\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function parseYeogiCompactLine(line) {
  const text = String(line || "").replace(/\s+/g, " ").trim();
  if (!YEOGI_CATEGORY_RE.test(text)) return null;
  if (!/글램핑|캠핑|카라반|펜션|풀빌라|리조트|호텔|스테이|빌리지|캠프|camp|glamp/i.test(text)) return null;

  const category = text.match(YEOGI_CATEGORY_RE)?.[0] || "숙박";
  const body = text.replace(YEOGI_CATEGORY_START_RE, "");
  const locationInfo = yeogiLocationFromText(body);
  const location = locationInfo.value;
  const price = yeogiLowestPrice(text);
  const ratingMatch = text.match(/(\d(?:\.\d)?)(?:\s*)?([\d,]+)명\s*평가/);
  const rating = ratingMatch?.[1] || "";
  const reviews = ratingMatch?.[2] ? `${ratingMatch[2]}명 평가` : "";

  let nameSource = body;
  if (location && locationInfo.index > 0) nameSource = body.slice(0, locationInfo.index);
  else {
    const stop = body.search(/(?:\d(?:\.\d)?\s*[\d,]+명\s*평가|반짝특가|타임특가|쿠폰|숙박|대실|다른 날짜 확인|[\d,]+\s*원)/);
    if (stop > 0) nameSource = body.slice(0, stop);
  }

  const name = cleanYeogiName(nameSource);
  if (!name || name.length < 2 || name.length > 80) return null;

  const soldOut = /예약마감|예약완료|마감|매진|품절|sold\s*out|unavailable|다른 날짜 확인/i.test(text);
  return {
    rank: "",
    name,
    category,
    location,
    rating,
    reviews,
    price,
    url: "",
    section: /^광고$|광고\s|^AD$/i.test(text) ? "광고" : "수동수집",
    adFlag: /^광고$|광고\s|^AD$/i.test(text) ? "Y" : "확인불가",
    reservationAvailable: soldOut ? "N" : price ? "Y" : "확인불가",
    availabilityStatus: soldOut ? "예약마감/매진 문구 감지" : price ? "가격 노출" : "가격/매진 문구 미확인",
    raw: text.slice(0, 500)
  };
}

function findRowValue(row, keys) {
  for (const key of keys) {
    const foundKey = Object.keys(row).find((item) => item.replace(/^\uFEFF/, "").trim().toLowerCase() === key.toLowerCase());
    if (foundKey && String(row[foundKey] || "").trim()) return String(row[foundKey]).trim();
  }
  return "";
}

function normalizeImportedAd(value, section = "") {
  const text = `${value || ""} ${section || ""}`;
  if (/\bY\b|광고/.test(text) && !/비광고/.test(text)) return "Y";
  if (/\bN\b|비광고/.test(text)) return "N";
  return "확인불가";
}

function normalizeImportedSection(value, adFlag) {
  const text = String(value || "");
  if (text.includes("광고") && !text.includes("비광고")) return "광고";
  if (text.includes("비광고")) return "비광고";
  if (adFlag === "Y") return "광고";
  if (adFlag === "N") return "비광고";
  return "수동수집";
}

function normalizeReservationAvailable(value, price = "", raw = "") {
  const text = `${value || ""} ${price || ""} ${raw || ""}`;
  if (/예약마감|예약완료|마감|매진|품절|sold\s*out|unavailable|\bN\b/i.test(text)) return "N";
  if (/예약가능|가능|available|\bY\b/i.test(text)) return "Y";
  if (/[\d,]+\s*원/.test(text) || /\d+/.test(String(price || ""))) return "Y";
  return "확인불가";
}

function parseYeogiCsvImport(text) {
  const rows = parseCsv(String(text || "").replace(/^\uFEFF/, ""));
  return rows
    .map((row, index) => {
      const section = findRowValue(row, ["section", "구분", "상태", "수집상태"]);
      const adFlag = normalizeImportedAd(findRowValue(row, ["ad_flag", "ad", "광고여부", "광고 여부"]), section);
      const price = findRowValue(row, ["price", "가격", "최저가"]);
      const raw = findRowValue(row, ["raw", "원문"]);
      const reservationAvailable = normalizeReservationAvailable(
        findRowValue(row, ["reservation_available", "예약가능", "예약 가능", "예약가능추정"]),
        price,
        raw,
      );
      return {
        rank: findRowValue(row, ["rank", "rank_or_order", "순위"]) || String(index + 1),
        name: findRowValue(row, ["name", "업체명", "숙소명", "상품명", "title"]),
        category: findRowValue(row, ["category", "카테고리", "유형"]),
        location: findRowValue(row, ["location", "주소", "지역"]),
        rating: findRowValue(row, ["rating", "평점"]),
        reviews: findRowValue(row, ["reviews", "리뷰", "후기"]),
        price,
        url: findRowValue(row, ["url", "상품 URL", "링크"]),
        section: normalizeImportedSection(section, adFlag),
        adFlag,
        reservationAvailable,
        availabilityStatus: findRowValue(row, ["availability_status", "예약상태", "예약 상태", "판매상태"]) ||
          (reservationAvailable === "N" ? "예약마감/매진 문구 감지" : reservationAvailable === "Y" ? "가격 노출" : "확인불가"),
        raw
      };
    })
    .filter((row) => row.name);
}

function looksLikeYeogiCsvHeader(line) {
  const cells = String(line || "")
    .split(",")
    .map((cell) => cell.replace(/^\uFEFF/, "").trim().toLowerCase())
    .filter(Boolean);
  if (cells.length < 2) return false;
  const hasName = cells.some((cell) => /^(name|업체명|숙소명|상품명|title)$/.test(cell));
  const hasPrice = cells.some((cell) => /^(price|가격|최저가)$/.test(cell));
  const hasRank = cells.some((cell) => /^(rank|rank_or_order|순위)$/.test(cell));
  const hasUrl = cells.some((cell) => /^(url|상품 url|링크)$/.test(cell));
  return hasName && (hasPrice || hasRank || hasUrl);
}

function isLikelyPlaceName(line) {
  const text = String(line || "").trim();
  if (text.length < 2 || text.length > 70) return false;
  if (!/[가-힣A-Za-z0-9]/.test(text)) return false;
  if (/원|예약|쿠폰|할인|로그인|회원|검색|필터|지도|정렬|성인|아동|입실|퇴실|후기|리뷰|평점|무료취소/.test(text)) return false;
  return /글램핑|캠핑|카라반|펜션|풀빌라|리조트|호텔|스테이|빌리지|캠프|camp|glamp/i.test(text);
}

function parseYeogiTextImport(text) {
  const lines = yeogiTextLines(text);
  const rows = [];
  const seen = new Set();
  const pricePattern = /(?:\d{1,3},)*\d{1,3}\s*원\s*~?|(?:\d{1,3},)+\d{3}/;

  const addRow = (row) => {
    if (!row?.name) return;
    const key = `${row.name}|${row.price || ""}`.replace(/\s+/g, "").toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    rows.push({ ...row, rank: row.rank || String(rows.length + 1) });
  };

  lines.forEach((line, index) => {
    const compactRow = parseYeogiCompactLine(line);
    if (compactRow) {
      addRow(compactRow);
      return;
    }

    if (!pricePattern.test(line)) return;
    const start = Math.max(0, index - 8);
    const end = Math.min(lines.length, index + 5);
    const windowLines = lines.slice(start, end);
    const before = lines.slice(start, index).reverse();
    const name = before.find(isLikelyPlaceName) || windowLines.find(isLikelyPlaceName) || "";
    if (!name) return;
    const price = line.match(pricePattern)?.[0] || line;
    const raw = windowLines.join(" / ");
    const adFlag = windowLines.some((item) => /^광고$|광고\s*$|^AD$/i.test(item)) ? "Y" : "확인불가";
    const soldOut = windowLines.some((item) => /예약마감|예약완료|마감|매진|품절|sold\s*out|unavailable/i.test(item));
    addRow({
      rank: String(rows.length + 1),
      name,
      category: "숙박/글램핑",
      location: windowLines.find((item) => /(시|군|구|읍|면|동)\b|경기|강원|충북|충남|전북|전남|경북|경남|제주|부산|울산|대구|인천|서울/.test(item) && !pricePattern.test(item)) || "",
      rating: windowLines.find((item) => /^(\d\.\d|\d점)$/.test(item)) || "",
      reviews: windowLines.find((item) => /후기|리뷰/.test(item)) || "",
      price,
      url: "",
      section: adFlag === "Y" ? "광고" : "수동수집",
      adFlag,
      reservationAvailable: soldOut ? "N" : "Y",
      availabilityStatus: soldOut ? "예약마감/매진 문구 감지" : "가격 노출",
      raw
    });
  });

  if (!rows.length) {
    for (const line of lines) {
      if (!isLikelyPlaceName(line)) continue;
      const key = line;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({
        rank: String(rows.length + 1),
        name: line,
        category: "숙박/글램핑",
        location: "",
        rating: "",
        reviews: "",
        price: "",
        url: "",
        section: "수동수집",
        adFlag: "확인불가",
        reservationAvailable: "확인불가",
        availabilityStatus: "가격/매진 문구 미확인",
        raw: line
      });
      if (rows.length >= 50) break;
    }
  }

  return rows.slice(0, 80);
}

function parseYeogiImport(text) {
  const source = String(text || "").trim();
  if (!source) return [];
  const firstLine = source.replace(/^\uFEFF/, "").split(/\r?\n/, 1)[0] || "";
  const csvLike = looksLikeYeogiCsvHeader(firstLine);
  const rows = csvLike ? parseYeogiCsvImport(source) : parseYeogiTextImport(source);
  return rows.filter((row) => row.name);
}

function cleanYeogiManualName(value) {
  return String(value || "")
    .replace(/\s*,\s*[^,]*(?:여기어때|특가).*$/i, "")
    .replace(/\s*[-–—]\s*.*(?:여기어때|특가).*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isYeogiManualNoiseName(value) {
  const text = cleanYeogiManualName(value);
  if (!text || text.length < 2) return true;
  return /^(제공용품|서비스|위의 정보|수영장 운영|숙소소개|이용 안내|객실 이용|공지사항|안내사항|환불|취소|예약 안내|추가요금)/.test(text) ||
    /(변경될 수 있습니다|사정에 따라|날씨 또는|부탄가스|그릇세트|무료취소|쿠폰|로그인|회원가입)/.test(text);
}

function normalizeYeogiManualRows(rows) {
  const seen = new Set();
  const normalized = [];
  for (const row of rows) {
    const platform = String(row.channel || row["플랫폼"] || "");
    if (!platform.includes("여기")) {
      normalized.push(row);
      continue;
    }

    const next = { ...row, name: cleanYeogiManualName(row.name || row["업체명"] || "") };
    if (row["업체명"]) next["업체명"] = next.name;
    if (isYeogiManualNoiseName(next.name || next["업체명"] || "")) continue;

    const key = `${platform}:${companyPlatformKey(next.name || next["업체명"] || "")}`;
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(next);
  }
  return normalized;
}

async function importYeogiSupplement(payload) {
  const runId = String(payload.runId || "").trim();
  const sourceText = String(payload.sourceText || "").trim();
  const dirPath = resolveRunDir(runId);
  if (!runId || !dirPath || !fs.existsSync(dirPath)) throw new Error("선택한 실행 결과를 찾을 수 없습니다.");
  if (!sourceText) throw new Error("붙여넣기 데이터가 비어 있습니다.");

  const files = await fsp.readdir(dirPath);
  const manifest = (await readManifest(dirPath)) || {};
  const platformFile = manifestFile(manifest, "platform", files, (file) => file.endsWith("_glamping_crawl_test.csv"));
  if (!platformFile) throw new Error("플랫폼 결과 CSV를 찾을 수 없습니다.");

  const platformPath = path.join(dirPath, platformFile);
  const platformText = (await fsp.readFile(platformPath, "utf8")).replace(/^\uFEFF/, "");
  const originalRows = parseCsv(platformText);
  const originalHeaders = csvHeaderLine(platformText);
  const parsedRows = yeogiImportParser.parseYeogiImport(sourceText);
  if (!parsedRows.length) {
    throw new Error("여기어때 숙소 행을 찾지 못했습니다. CSV 헤더 또는 페이지 텍스트를 다시 확인하세요.");
  }

  const importedAt = new Date().toLocaleString("ko-KR", { timeZone: "Asia/Seoul" });
  const importedRows = normalizeYeogiManualRows(parsedRows.map((row, index) => ({
    channel: "여기어때",
    section: row.section,
    rank_or_order: row.rank || index + 1,
    name: row.name,
    category: row.category,
    location: row.location,
    rating: row.rating,
    reviews: row.reviews,
    price: row.price,
    ad_flag: row.adFlag,
    url: row.url,
    "실패 원인": "",
    "수집 방향": "사용자 브라우저 세션 또는 수동 가져오기 기반 보완 수집",
    "수집방식": "브라우저/수동 가져오기",
    "수집일시": importedAt,
    "예약가능추정": row.reservationAvailable || "확인불가",
    "예약가능근거": row.availabilityStatus || "",
    "예약가능률대체지표": row.reservationAvailable === "Y" ? 1 : row.reservationAvailable === "N" ? 0 : "",
    "원문": row.raw || ""
  })));
  if (!importedRows.length) {
    throw new Error("여기어때 숙소 행을 찾지 못했습니다. 안내문이 아닌 실제 숙소명/가격이 포함된 결과 텍스트를 붙여넣으세요.");
  }

  const remainingRows = originalRows.filter((row) => String(row.channel || row["플랫폼"] || "") !== "여기어때");
  const mergedRows = [...remainingRows, ...importedRows];
  const columns = orderedColumns(mergedRows, originalHeaders);
  await writeCsv(platformPath, mergedRows, columns);

  const prefix = safeFilePart(manifest.keyword || manifest.searchKeyword || platformFile.replace(/\.[^.]+$/, ""));
  const importFile = `${prefix}_여기어때수동보완.csv`;
  await writeCsv(path.join(dirPath, importFile), importedRows, orderedColumns(importedRows, columns));

  manifest.files = Array.from(new Set([...(manifest.files || []), importFile]));
  manifest.fileRoles = { ...(manifest.fileRoles || {}), yeogiManual: importFile };
  manifest.counts = { ...(manifest.counts || {}), yeogiManual: importedRows.length };
  manifest.yeogiImport = { importedAt, count: importedRows.length, method: "browser_or_manual" };
  await fsp.writeFile(path.join(dirPath, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
  await appendHistoryForRun(runId).catch((error) => {
    console.warn(`Could not append history for ${runId}: ${error.message || error}`);
  });

  return { importedCount: importedRows.length, data: await loadRun(runId) };
}

function minPrice(value) {
  const match = String(value || "").match(/[\d,]+/);
  if (!match) return null;
  const parsed = Number(match[0].replace(/,/g, ""));
  return parsed > 0 ? parsed : null;
}

function increment(map, key, by = 1) {
  const safeKey = normalizeClusterName(key);
  map[safeKey] = (map[safeKey] || 0) + by;
}

function incrementRaw(map, key, by = 1) {
  const safeKey = String(key || "").trim();
  if (!safeKey) return;
  map[safeKey] = (map[safeKey] || 0) + by;
}

function topKey(map) {
  return Object.entries(map).sort((a, b) => b[1] - a[1])[0]?.[0] || "확인불가";
}

function topRawKey(map) {
  return Object.entries(map).sort((a, b) => b[1] - a[1])[0]?.[0] || "";
}

function compactKeyword(keyword) {
  return String(keyword || "").replace(/\s+/g, "");
}

const REGIONAL_KEYWORD_ALIASES = {
  gyeongnam: ["경남", "경상남도"],
  gyeongbuk: ["경북", "경상북도"],
  gyeonggi: ["경기", "경기도"],
  jeonbuk: ["전북", "전라북도"],
  jeonnam: ["전남", "전라남도"],
  chungnam: ["충남", "충청남도"],
  chungbuk: ["충북", "충청북도"],
  gangwon: ["강원", "강원도"],
  jeju: ["제주", "제주도"],
  seoul: ["서울", "서울시", "서울특별시"],
  busan: ["부산", "부산시", "부산광역시"],
  daegu: ["대구", "대구시", "대구광역시"],
  incheon: ["인천", "인천시", "인천광역시"],
  gwangju: ["광주", "광주시", "광주광역시"],
  daejeon: ["대전", "대전시", "대전광역시"],
  ulsan: ["울산", "울산시", "울산광역시"],
  sejong: ["세종", "세종시", "세종특별자치시"]
};

function keywordLayerCore(keyword) {
  return compactKeyword(keyword)
    .normalize("NFKC")
    .replace(/[·ㆍ|].*$/u, "")
    .replace(/\d{4}-?\d{2}-?\d{2}.*/u, "")
    .replace(/(글램핑|캠핑|카라반|펜션)$/u, "")
    .toLowerCase();
}

function keywordLayerFromRunLike(value = {}) {
  const searchMode = String(value.searchMode || "").trim();
  const keywordType = String(value.keywordType || "").trim();
  if (searchMode === "company" || keywordType === "company") {
    return { type: "company", label: "업체명 확인", note: "업체명 검색 기준" };
  }
  const core = keywordLayerCore(value.keyword || value.label || "");
  if (!core) return { type: "unknown", label: "분류 대기", note: "키워드 확인 필요" };
  for (const aliases of Object.values(REGIONAL_KEYWORD_ALIASES)) {
    if (aliases.map((alias) => keywordLayerCore(alias)).includes(core)) {
      return { type: "regional", label: "광역 노출", note: "권역 키워드 기준" };
    }
  }
  return { type: "local", label: "로컬 노출", note: "지역 키워드 기준" };
}

function companyPlatformKey(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}]+/gu, "")
    .toLowerCase();
}

function normalizeSearchKeyword(keyword) {
  const compact = compactKeyword(keyword);
  if (!compact) return "";
  return compact.endsWith("글램핑") ? compact : `${compact}글램핑`;
}

function uniqueTexts(values) {
  return Array.from(new Set(values.map((value) => String(value || "").trim()).filter(Boolean)));
}

function normalizeCompanyIdentityName(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/\(주\)|㈜|주식회사|유한회사|농업회사법인|영농조합법인|사단법인|재단법인/gu, "")
    .replace(/[^\p{L}\p{N}]+/gu, "")
    .toLowerCase();
}

function normalizeCompanyLooseName(value) {
  return normalizeCompanyIdentityName(value)
    .replace(/글램핑장|오토캠핑장|카라반캠핑장|야영장|캠핑장|글램핑|카라반|캠핑|펜션|리조트|호텔|스테이|빌리지|지점|본점/gu, "");
}

function normalizeAddressKey(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/\([^)]*\)/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, "")
    .toLowerCase();
}

function extractNaverPlaceId(value = {}) {
  const explicit = value.placeId || value.place_id || value["place_id"] || value.naverPlaceId;
  if (explicit) return String(explicit).trim();
  const text = `${value.url || ""} ${value["url"] || ""} ${value.naverUrl || ""} ${value["네이버예약URL"] || ""}`;
  return text.match(/\/accommodation\/(\d+)/)?.[1] || text.match(/[?&]entry=pll[^0-9]*(\d+)/)?.[1] || "";
}

function extractBookingBusinessId(value = {}) {
  const explicit = value.bookingBusinessId || value.businessId || value.naverBookingBusinessId;
  if (explicit) return String(explicit).trim();
  const text = `${value.url || ""} ${value["url"] || ""} ${value.naverBookingUrl || ""} ${value["네이버예약URL"] || ""}`;
  return text.match(/\/bizes\/(\d+)/)?.[1] || "";
}

function boundedUnique(values = [], limit = 20) {
  return uniqueTexts(values).slice(0, limit);
}

function datalabKeywordVariants(keyword) {
  const raw = String(keyword || "").trim();
  const compact = compactKeyword(raw);
  return uniqueTexts([
    raw,
    compact,
    compact.replace(/글램핑$/u, " 글램핑")
  ]).slice(0, 5);
}

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

function dateDaysAgo(days) {
  const date = new Date();
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() - days);
  return date;
}

function datalabTrendRange(monthCount = 12) {
  const end = dateDaysAgo(1);
  const start = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - Math.max(1, monthCount - 1), 1));
  return { startDate: isoDate(start), endDate: isoDate(end), timeUnit: "month" };
}

function demandKeywordForRun(manifest, conditions, regions) {
  const raw = manifest?.keyword || conditions?.keyword || regions?.[0]?.trafficKeyword || "";
  if (!raw) return "";
  const searchMode = manifest?.searchMode || (manifest?.keywordType === "company" ? "company" : "keyword");
  return searchMode === "company" ? compactKeyword(raw) : normalizeSearchKeyword(raw);
}

function trafficKeywordForRegion(keyword, region) {
  const compact = compactKeyword(keyword);
  const regionName = compactKeyword(region);
  if (regionName && compact.includes(regionName)) return `${regionName}글램핑`;
  return normalizeSearchKeyword(compact || `${regionName}글램핑`);
}

function normalizeClusterName(value) {
  const name = String(value || "").trim();
  if (!name) return "확인불가";
  if (name === "프리미엄") return "프리미엄형";
  return name;
}

function normalizeInventoryMemo(memo, listType = "") {
  const text = String(memo || "");
  if (!text) return "";
  if (!String(listType || "").includes("객실 묶음 상품리스트")) return text;
  return text.replace(
    "객실번호 범위형 묶음 상품은 상품 단위로 계산",
    "객실번호 범위형 묶음 상품은 내부 stock 수량 합산"
  );
}

function inventoryConfidenceLabel(grade) {
  return {
    A: "A 신뢰",
    B: "B 양호",
    C: "C 참고",
    D: "D 검증",
    E: "E 수동확인"
  }[grade] || "C 참고";
}

function inventoryStructureMeta(type) {
  return {
    room_unit: {
      label: "객실별 노출형",
      tone: "good",
      summary: "객실/상품이 개별로 노출되어 기준일 재고 해석이 비교적 단순합니다."
    },
    room_type_stock: {
      label: "종류별 수량형",
      tone: "watch",
      summary: "객실 종류별 stock 합산값입니다. 판매 가능 수량으로 보되 실제 전체 보유 객실수와 구분합니다."
    },
    grouped_stock: {
      label: "묶음·범위형",
      tone: "bad",
      summary: "객실번호 범위나 묶음 상품의 내부 stock 합산값입니다. 상품명 구조 검증이 필요합니다."
    },
    stock_only: {
      label: "재고 합산형",
      tone: "watch",
      summary: "예약 상품의 stock 합산값입니다. 객실 단위인지 상품 단위인지 추가 확인이 필요합니다."
    },
    dayuse_only: {
      label: "당일상품 중심",
      tone: "watch",
      summary: "숙박보다 데이유즈/캠프닉 상품 수량 해석이 중요합니다."
    },
    unknown: {
      label: "구조 확인필요",
      tone: "bad",
      summary: "예약 리스트 구조가 명확하지 않아 수동 검증이 필요합니다."
    }
  }[type] || {
    label: "구조 확인필요",
    tone: "bad",
    summary: "예약 리스트 구조가 명확하지 않아 수동 검증이 필요합니다."
  };
}

function evaluateInventoryStructure(context = {}) {
  const listType = String(context.listType || "");
  const memo = String(context.inventoryMemo || "");
  const flags = [];
  const notes = [];
  let type = "unknown";

  if (listType.includes("객실별")) {
    type = "room_unit";
    notes.push("객실별 예약리스트");
  } else if (listType.includes("객실 종류별")) {
    type = "room_type_stock";
    notes.push("객실 종류별 stock 합산");
  } else if (listType.includes("묶음")) {
    type = "grouped_stock";
    notes.push("객실 범위/묶음 상품");
  } else if (context.totalRooms > 0) {
    type = "stock_only";
    notes.push("예약 stock 합산");
  }

  if (!context.totalRooms && context.dayUseTotalStock > 0) {
    type = "dayuse_only";
  }

  if (context.dayUseTotalStock > 0 || context.dayUseItemCount > 0) {
    flags.push("dayuse_rotation");
    notes.push("데이유즈/캠프닉 별도 분리");
  }

  if (context.weeklyRawStockVariance || context.dayUseWeeklyRawStockVariance) {
    flags.push("dynamic_capacity");
    notes.push("날짜별 총량 변동");
  }

  if (context.rawTotalStock && context.totalRooms && context.rawTotalStock !== context.totalRooms) {
    flags.push("raw_calc_gap");
    notes.push("원시 stock과 계산값 차이");
  }

  if (context.groupedRoomCount > 0 || memo.includes("묶음 상품")) {
    if (!flags.includes("grouped_range")) flags.push("grouped_range");
  }

  if (memo.includes("과거 확인 ID 재사용")) {
    flags.push("booking_id_reused");
    notes.push("예약ID 과거값 재사용");
  }

  if (memo.includes("전체 객실수와 다를 수 있음")) {
    flags.push("not_total_rooms");
  }

  const meta = inventoryStructureMeta(type);
  const action = flags.includes("booking_id_reused")
    ? "네이버 예약ID 재확인"
    : flags.includes("dynamic_capacity")
      ? "전화예약·정비·채널조정 확인"
      : type === "grouped_stock"
        ? "상품명 범위와 stock 대조"
        : type === "room_type_stock"
          ? "종류별 수량과 실제 객실수 구분"
          : "표본 날짜 재검증";

  return {
    type,
    label: meta.label,
    tone: meta.tone,
    summary: meta.summary,
    flags,
    notes: [...new Set(notes)].slice(0, 5),
    action
  };
}

function evaluateInventoryConfidence(context = {}) {
  const reasons = [];
  const alerts = [];
  const structure = evaluateInventoryStructure(context);
  let score = 45;

  if (context.totalRooms > 0 && context.availableRooms >= 0) {
    score += 16;
    reasons.push("기준일 전체/잔여 수량 확인");
  } else {
    score -= 24;
    alerts.push("기준 수량 확인 불가");
  }

  if (context.weeklyDays >= 6 && context.weeklyDetail) {
    score += 22;
    reasons.push("기간 대부분 날짜별 재고 확인");
  } else if (context.weeklyDays >= 2 && context.weeklyDetail) {
    score += 12;
    reasons.push("일부 날짜별 재고 확인");
  } else {
    score -= 12;
    alerts.push("날짜별 상세 부족");
  }

  if (context.countedItemCount > 0) {
    score += 6;
    reasons.push("예약 상품 단위 확인");
  }

  const listType = String(context.listType || "");
  if (listType.includes("객실별")) {
    score += 8;
    reasons.push("객실별 노출형");
  } else if (listType.includes("객실 종류별")) {
    score += 3;
    reasons.push("종류별 수량형");
  } else if (listType.includes("묶음")) {
    score -= 7;
    alerts.push("묶음/범위형 상품 해석 필요");
  } else if (!listType) {
    score -= 8;
    alerts.push("예약 리스트 유형 미확인");
  }

  if (context.weeklyRawStockVariance) {
    score -= 8;
    alerts.push("날짜별 총량 변동");
  }

  if (context.rawTotalStock && context.totalRooms && context.rawTotalStock !== context.totalRooms) {
    score -= 4;
    alerts.push("원시 재고와 계산 재고 차이");
  }

  if (context.dayUseTotalStock > 0) {
    reasons.push("당일 회전형 별도 분리");
  }

  if (structure.flags.includes("booking_id_reused")) {
    score -= 8;
    alerts.push("예약ID 과거값 재사용");
  }

  if (structure.flags.includes("dynamic_capacity")) {
    reasons.push("전화예약/정비/채널조정 가능성");
  }

  if (alerts.length) score = Math.min(score, 86);
  if (structure.type === "room_unit" && !alerts.length) score += 3;
  const grade = score >= 88 ? "A" : score >= 74 ? "B" : score >= 58 ? "C" : score >= 42 ? "D" : "E";
  const summary = alerts.length
    ? `${inventoryConfidenceLabel(grade)} · ${alerts[0]}`
    : `${inventoryConfidenceLabel(grade)} · ${structure.label}`;

  return {
    grade,
    score: Math.max(0, Math.min(100, Math.round(score))),
    label: inventoryConfidenceLabel(grade),
    summary,
    structure,
    reasons: reasons.slice(0, 4),
    alerts: alerts.slice(0, 4)
  };
}

function metricNumber(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  const text = String(value || "").replace(/,/g, "").trim();
  if (!text) return 0;
  if (/^<\s*10$/.test(text)) return 5;
  const parsed = Number(text.replace(/[^\d.-]/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function searchAdSignature(timestamp, method, uri, secretKey) {
  return crypto
    .createHmac("sha256", secretKey)
    .update(`${timestamp}.${method}.${uri}`)
    .digest("base64");
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeSearchAdRow(keyword, row, status = 200) {
  if (!row) {
    return {
      keyword,
      collectable: false,
      status,
      reason: "검색광고 키워드 도구에 일치 데이터가 없습니다."
    };
  }

  const monthlyPc = metricNumber(row.monthlyPcQcCnt);
  const monthlyMobile = metricNumber(row.monthlyMobileQcCnt);
  const monthlyPcClicks = metricNumber(row.monthlyAvePcClkCnt);
  const monthlyMobileClicks = metricNumber(row.monthlyAveMobileClkCnt);
  const totalSearchVolume = monthlyPc + monthlyMobile;
  const totalClicks = monthlyPcClicks + monthlyMobileClicks;

  return {
    keyword,
    relKeyword: row.relKeyword || keyword,
    collectable: true,
    status,
    monthlyPc,
    monthlyMobile,
    totalSearchVolume,
    monthlyPcClicks,
    monthlyMobileClicks,
    totalClicks,
    pcCtr: metricNumber(row.monthlyAvePcCtr),
    mobileCtr: metricNumber(row.monthlyAveMobileCtr),
    combinedCtr: totalSearchVolume ? Number(((totalClicks / totalSearchVolume) * 100).toFixed(2)) : null,
    competition: row.compIdx || "확인불가"
  };
}

async function collectSearchAdMetric(keyword, keys, attempt = 0) {
  if (!keys.searchadApiKey || !keys.searchadSecretKey || !keys.searchadCustomerId) {
    return {
      keyword,
      collectable: false,
      configured: false,
      reason: "검색광고 API 키가 필요합니다."
    };
  }

  const method = "GET";
  const uri = "/keywordstool";
  const timestamp = Date.now().toString();
  const url = `https://api.searchad.naver.com${uri}?hintKeywords=${encodeURIComponent(keyword)}&showDetail=1`;
  const result = await requestJson(url, {
    method,
    headers: {
      "X-Timestamp": timestamp,
      "X-API-KEY": keys.searchadApiKey,
      "X-Customer": keys.searchadCustomerId,
      "X-Signature": searchAdSignature(timestamp, method, uri, keys.searchadSecretKey)
    }
  });

  if (result.status === 429 && attempt < 2) {
    await sleep(1200 * (attempt + 1));
    return collectSearchAdMetric(keyword, keys, attempt + 1);
  }

  if (!result.ok) {
    return {
      keyword,
      collectable: false,
      configured: true,
      status: result.status,
      reason: result.data?.message || result.data?.title || result.data?.errorMessage || "검색광고 API 호출 실패"
    };
  }

  const list = Array.isArray(result.data?.keywordList) ? result.data.keywordList : [];
  const exact = list.find((row) => compactKeyword(row.relKeyword) === compactKeyword(keyword));
  const close = exact || list[0] || null;
  return normalizeSearchAdRow(keyword, close, result.status);
}

function normalizeDatalabTrend(keyword, result, range) {
  const group = Array.isArray(result?.results) ? result.results[0] : null;
  const rows = Array.isArray(group?.data) ? group.data : [];
  const series = rows.map((row) => {
    const ratio = Number(row.ratio);
    return {
      period: row.period || "",
      month: row.period || "",
      ratio: Number.isFinite(ratio) ? ratio : null,
      value: Number.isFinite(ratio) ? ratio : null
    };
  });

  return {
    source: "naver_datalab_search",
    keyword,
    configured: true,
    collectable: series.some((entry) => Number.isFinite(entry.ratio)),
    status: 200,
    startDate: range.startDate,
    endDate: range.endDate,
    timeUnit: range.timeUnit,
    note: "Naver DataLab returns relative trend ratios, not absolute search volume.",
    series,
    rawTitle: group?.title || keyword,
    collectedAt: new Date().toISOString()
  };
}

async function collectDatalabTrend(keyword, keys, attempt = 0) {
  const compact = compactKeyword(keyword);
  if (!compact) return null;

  if (!keys.naverClientId || !keys.naverClientSecret) {
    return {
      source: "naver_datalab_search",
      keyword: compact,
      configured: false,
      collectable: false,
      reason: "Naver DataLab API keys are not configured.",
      series: []
    };
  }

  const range = datalabTrendRange(12);
  const result = await requestJson("https://openapi.naver.com/v1/datalab/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Naver-Client-Id": keys.naverClientId,
      "X-Naver-Client-Secret": keys.naverClientSecret
    },
    body: JSON.stringify({
      ...range,
      keywordGroups: [
        {
          groupName: compact,
          keywords: datalabKeywordVariants(compact)
        }
      ]
    })
  });

  if (result.status === 429 && attempt < 2) {
    await sleep(1200 * (attempt + 1));
    return collectDatalabTrend(keyword, keys, attempt + 1);
  }

  if (!result.ok) {
    return {
      source: "naver_datalab_search",
      keyword: compact,
      configured: true,
      collectable: false,
      status: result.status,
      startDate: range.startDate,
      endDate: range.endDate,
      timeUnit: range.timeUnit,
      reason: result.data?.errorMessage || result.data?.message || result.data?.title || "Naver DataLab API request failed.",
      series: [],
      collectedAt: new Date().toISOString()
    };
  }

  return normalizeDatalabTrend(compact, result.data, range);
}

function createTrafficAggregate() {
  return {
    keywordCount: 0,
    collectableCount: 0,
    monthlyPc: 0,
    monthlyMobile: 0,
    totalSearchVolume: 0,
    totalClicks: 0,
    combinedCtr: null
  };
}

function addTrafficMetric(aggregate, metric) {
  aggregate.keywordCount += 1;
  if (!metric?.collectable) return aggregate;
  aggregate.collectableCount += 1;
  aggregate.monthlyPc += metric.monthlyPc || 0;
  aggregate.monthlyMobile += metric.monthlyMobile || 0;
  aggregate.totalSearchVolume += metric.totalSearchVolume || 0;
  aggregate.totalClicks += metric.totalClicks || 0;
  aggregate.combinedCtr = aggregate.totalSearchVolume
    ? Number(((aggregate.totalClicks / aggregate.totalSearchVolume) * 100).toFixed(2))
    : null;
  return aggregate;
}

async function readTrafficCache(cachePath) {
  try {
    return JSON.parse((await fsp.readFile(cachePath, "utf8")).replace(/^\uFEFF/, ""));
  } catch {
    return { source: "naver_traffic_sources", metrics: {}, trends: {} };
  }
}

async function enrichRegionsWithTraffic(regions, dirPath, demandKeyword = "") {
  const keys = await readTrafficKeys();
  const cachePath = path.join(dirPath, "traffic_metrics.json");
  const cache = await readTrafficCache(cachePath);
  const metrics = cache.metrics || {};
  const trends = cache.trends || {};
  let changed = false;

  for (const region of regions) {
    const keyword = normalizeSearchKeyword(region.trafficKeyword || region.region);
    region.trafficKeyword = keyword;

    if (!metrics[keyword]?.collectable) {
      const metric = await collectSearchAdMetric(keyword, keys);
      metrics[keyword] = metric;
      changed = true;
      await sleep(350);
    }

    region.traffic = metrics[keyword];
  }

  const datalabKeyword = compactKeyword(demandKeyword || regions[0]?.trafficKeyword || "");
  let datalabTrend = datalabKeyword ? trends[datalabKeyword] : null;
  if (datalabKeyword && !datalabTrend?.collectable) {
    datalabTrend = await collectDatalabTrend(datalabKeyword, keys);
    if (datalabTrend) {
      trends[datalabKeyword] = datalabTrend;
      changed = true;
      await sleep(350);
    }
  }

  const canPersistTraffic = keys.searchadApiKey && keys.searchadSecretKey && keys.searchadCustomerId;
  const canPersistTrend = keys.naverClientId && keys.naverClientSecret;
  if (changed && (canPersistTraffic || canPersistTrend)) {
    await fsp.writeFile(
      cachePath,
      JSON.stringify({ source: "naver_traffic_sources", updatedAt: new Date().toISOString(), metrics, trends }, null, 2),
      "utf8"
    );
  }

  return datalabTrend || null;
}

function defaultProfile(region, provinceKey, index) {
  const province = PROVINCES[provinceKey] || PROVINCES.local;
  const bounds = province.mapBounds;
  const angle = (index / 12) * Math.PI * 2;
  return {
    lat: (bounds.minLat + bounds.maxLat) / 2 + Math.sin(angle) * 0.3,
    lon: (bounds.minLon + bounds.maxLon) / 2 + Math.cos(angle) * 0.3,
    primary: "복합형",
    secondary: "확인필요",
    resources: ["확인필요"],
    target: "확인필요",
    note: `${region} 지역의 본질 클러스터 기준 보정 필요`
  };
}

function summarizeRegionalRows(rows, provinceKey) {
  const province = PROVINCES[provinceKey] || PROVINCES.local;
  const regions = new Map();
  let unknownIndex = 0;

  for (const row of rows) {
    const region = row["지역"] || row["검색클러스터"] || row["소재지클러스터"] || "기타";
    if (!regions.has(region)) {
      const profile = province.profiles[region] || defaultProfile(region, provinceKey, unknownIndex++);
      regions.set(region, {
        region,
        ...profile,
        count: 0,
        adCount: 0,
        dualCount: 0,
        organicCount: 0,
        priceSum: 0,
        priceCount: 0,
        priceBuckets: {},
        typeBuckets: {},
        adBuckets: {},
        keywordBuckets: {},
        places: []
      });
    }

    const item = regions.get(region);
    item.count += 1;
    incrementRaw(
      item.keywordBuckets,
      trafficKeywordForRegion(row["검색키워드"] || row["기준키워드"] || `${region}글램핑`, region)
    );
    increment(item.priceBuckets, row["가격대클러스터"]);
    increment(item.typeBuckets, row["상품유형클러스터"]);
    increment(item.adBuckets, row["광고집행클러스터"]);

    const adCluster = normalizeClusterName(row["광고집행클러스터"]);
    if (adCluster.includes("광고+비광고")) item.dualCount += 1;
    else if (adCluster.includes("광고")) item.adCount += 1;
    else if (adCluster.includes("비광고")) item.organicCount += 1;

    const price = minPrice(row["금액"] || row["가격"]);
    if (price) {
      item.priceSum += price;
      item.priceCount += 1;
    }

    item.places.push({
      rank: Number(row["순위"] || 999),
      name: row["업체명"] || "",
      category: row["카테고리"] || "",
      address: row["주소"] || row["주소 또는 지역"] || "",
      price: row["금액"] || row["가격"] || "",
      ad: normalizeClusterName(row["광고집행클러스터"]),
      type: normalizeClusterName(row["상품유형클러스터"]),
      productTypeSummary: row["네이버상품구성"] || "",
      nightItemCount: row["숙박상품수"] || "",
      dayUseItemCount: row["데이유즈상품수"] || "",
      countedItemCount: row["예약계산대상상품수"] || "",
      availableRooms: row["숙박예약가능수"] || row["예약가능객실수"] || "",
      totalRooms: row["숙박확인재고수"] || row["확인객실수"] || "",
      availabilityRate: row["숙박예약가능률"] || row["예약가능률"] || "",
      nightAvailableStock: row["숙박예약가능수"] || row["예약가능객실수"] || "",
      nightTotalStock: row["숙박확인재고수"] || row["확인객실수"] || "",
      dayUseAvailableStock: row["데이유즈예약가능수"] || "",
      dayUseTotalStock: row["데이유즈확인재고수"] || "",
      inventoryScope: row["네이버재고범위"] || "네이버예약 채널/날짜 기준 재고",
      inventoryMemo: normalizeInventoryMemo(row["객실수검증메모"], row["예약리스트유형"]),
      availabilityBasis: row["예약가능근거"] || row["네이버예약재고수집상태"] || "",
      url: row["url"] || row["상품 URL"] || ""
    });
  }

  return [...regions.values()]
    .map((item) => ({
      ...item,
      avgPrice: item.priceCount ? Math.round(item.priceSum / item.priceCount) : null,
      dominantPrice: topKey(item.priceBuckets),
      dominantType: topKey(item.typeBuckets),
      dominantAd: topKey(item.adBuckets),
      trafficKeyword: normalizeSearchKeyword(topRawKey(item.keywordBuckets) || `${item.region}글램핑`),
      places: item.places.sort((a, b) => a.rank - b.rank).slice(0, 10)
    }))
    .sort((a, b) => a.region.localeCompare(b.region, "ko"));
}

function summarizeStats(regions) {
  const stats = {
    totalRegionalRows: 0,
    byCore: {},
    byType: {},
    byPrice: {},
    byAd: {},
    byCoreTraffic: {},
    traffic: createTrafficAggregate(),
    maxRegionCount: 0,
    avgPrice: null
  };
  let priceSum = 0;
  let priceCount = 0;

  for (const region of regions) {
    stats.totalRegionalRows += region.count;
    stats.maxRegionCount = Math.max(stats.maxRegionCount, region.count);
    increment(stats.byCore, region.primary, region.count);
    if (!stats.byCoreTraffic[region.primary]) stats.byCoreTraffic[region.primary] = createTrafficAggregate();
    addTrafficMetric(stats.byCoreTraffic[region.primary], region.traffic);
    addTrafficMetric(stats.traffic, region.traffic);

    for (const [key, value] of Object.entries(region.typeBuckets)) increment(stats.byType, key, value);
    for (const [key, value] of Object.entries(region.priceBuckets)) increment(stats.byPrice, key, value);
    for (const [key, value] of Object.entries(region.adBuckets)) increment(stats.byAd, key, value);

    if (region.priceCount) {
      priceSum += region.priceSum;
      priceCount += region.priceCount;
    }
  }

  stats.avgPrice = priceCount ? Math.round(priceSum / priceCount) : null;
  return stats;
}

function clampScore(value, min = 0, max = 100) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.max(min, Math.min(max, Math.round(number)));
}

function demandMonthFromConditions(conditions = {}) {
  const dateText = conditions.checkIn || kstDate(0);
  const match = String(dateText).match(/^\d{4}-(\d{1,2})-/);
  const month = match ? Number(match[1]) : new Date().getMonth() + 1;
  return Number.isFinite(month) && month >= 1 && month <= 12 ? month : new Date().getMonth() + 1;
}

function demandSegmentMatches(segment, monthInfo) {
  const targets = (monthInfo.targets || []).join(" ");
  const keywords = [...(monthInfo.keywords || []), monthInfo.weekdaySignal || "", monthInfo.content || ""].join(" ");
  if (targets.includes(segment.name) || targets.includes(segment.group)) return true;
  if (segment.keywords.some((keyword) => keywords.includes(keyword))) return true;
  if ((monthInfo.season && segment.seasons.includes(monthInfo.season)) && segment.priority >= 4) return true;
  return false;
}

function demandTopSegments(monthInfo, limit = 3) {
  return DEMAND_SEGMENTS
    .map((segment) => ({
      ...segment,
      fitScore:
        (demandSegmentMatches(segment, monthInfo) ? 42 : 0) +
        segment.priority * 8 +
        segment.conversion * 6 +
        segment.weight * 0.8 +
        (segment.seasons.includes(monthInfo.season) || segment.seasons.includes("연중") ? 12 : 0)
    }))
    .sort((a, b) => b.fitScore - a.fitScore)
    .slice(0, limit);
}

function demandTrendMomentum(datalabTrend) {
  const series = (datalabTrend?.series || datalabTrend?.data || [])
    .map((entry) => Number(entry.ratio ?? entry.value ?? entry.score))
    .filter(Number.isFinite);
  if (series.length < 2) return { score: 50, label: "트렌드 확인필요", change: null };
  const first = series[0] || 0;
  const last = series[series.length - 1] || 0;
  const change = first ? (last - first) / first : 0;
  const score = clampScore(55 + change * 100);
  return {
    score,
    change,
    label: change >= 0.15 ? "트렌드 상승" : change <= -0.15 ? "트렌드 하락" : "트렌드 보합"
  };
}

function demandRiskScore(monthInfo, regions = []) {
  const riskCount = (monthInfo.risks || []).length;
  const weatherRisk = (monthInfo.risks || []).some((risk) => /장마|폭염|태풍|한파|날씨|비/.test(risk));
  const naturalShare = regions.length
    ? regions.filter((region) => /자연|메인 관광/.test(region.primary || "")).length / regions.length
    : 0.5;
  const raw = 100 - riskCount * 10 - (weatherRisk ? 8 : 0) + naturalShare * 8;
  return clampScore(raw, 35, 95);
}

function demandContentScore(monthInfo, topSegments, datalabTrend) {
  const aiFrequency = DEMAND_AI_SIGNALS
    .filter((signal) => topSegments.some((segment) => segment.name === signal.segment || segment.group === signal.segment))
    .reduce((sum, signal) => sum + signal.frequency, 0);
  const trend = demandTrendMomentum(datalabTrend);
  return clampScore(58 + Math.min(18, aiFrequency) + (trend.score - 50) * 0.25);
}

function demandPriceDefenseScore(monthInfo, availability) {
  const base = DEMAND_LEVEL_SCORES[monthInfo.level] || 55;
  const soldRate = Number(availability?.stats?.weightedSoldOutRate);
  const saleSignal = Number.isFinite(soldRate) ? soldRate * 22 : 8;
  const priceSignal = /단가 유지|단가 최적화|보합/.test(monthInfo.price || "") ? 9 : -4;
  return clampScore(base * 0.72 + saleSignal + priceSignal);
}

function buildDemandStructure({ manifest, conditions, regions, availability, datalabTrend }) {
  const month = demandMonthFromConditions(conditions);
  const monthInfo = MONTHLY_DEMAND_MAP.find((entry) => entry.month === month) || MONTHLY_DEMAND_MAP[0];
  const topSegments = demandTopSegments(monthInfo, 3);
  const demandScore = DEMAND_LEVEL_SCORES[monthInfo.level] || 55;
  const targetFitScore = clampScore(
    topSegments.reduce((sum, segment) => sum + Math.min(100, segment.fitScore), 0) / Math.max(1, topSegments.length)
  );
  const weekdayScore = clampScore(
    topSegments.reduce((sum, segment) => sum + segment.weekday * 20, 0) / Math.max(1, topSegments.length)
  );
  const priceScore = demandPriceDefenseScore(monthInfo, availability);
  const contentScore = demandContentScore(monthInfo, topSegments, datalabTrend);
  const riskScore = demandRiskScore(monthInfo, regions);
  const aiSignalScore = clampScore(50 + Math.min(30, DEMAND_AI_SIGNALS.reduce((sum, signal) => sum + signal.frequency, 0)));
  const overallScore = clampScore(
    demandScore * 0.25 +
    targetFitScore * 0.20 +
    weekdayScore * 0.15 +
    priceScore * 0.15 +
    contentScore * 0.10 +
    riskScore * 0.10 +
    aiSignalScore * 0.05
  );
  const overallLabel = overallScore >= 82
    ? "강한 수요"
    : overallScore >= 68
      ? "선별 공략"
      : overallScore >= 55
        ? "보통 수요"
        : "주의 필요";
  const targetKeywords = Array.from(new Set([
    ...(monthInfo.keywords || []),
    ...topSegments.flatMap((segment) => segment.keywords || [])
  ])).slice(0, 8);

  return {
    source: "숙박업 메인터넌스",
    sourceVersion: "2026-03-08 사전 기준",
    keyword: manifest?.keyword || conditions?.keyword || "",
    month,
    monthLabel: `${month}월`,
    season: monthInfo.season,
    overallScore,
    overallLabel,
    summary: `${monthInfo.month || month}월은 ${monthInfo.level} 수요 구간이며 ${topSegments.map((item) => item.name).join(", ")} 중심으로 판단합니다.`,
    metrics: [
      { key: "monthlyDemand", label: "월 수요강도", score: demandScore, value: monthInfo.level, note: `${monthInfo.season} · ${monthInfo.operation}` },
      { key: "targetFit", label: "핵심타겟 적합도", score: targetFitScore, value: topSegments.map((item) => item.group).join("·"), note: topSegments.map((item) => item.name).join(" · ") },
      { key: "weekday", label: "평일 확장성", score: weekdayScore, value: weekdayScore >= 70 ? "높음" : weekdayScore >= 50 ? "보통" : "낮음", note: monthInfo.weekdaySignal },
      { key: "price", label: "가격 방어력", score: priceScore, value: priceScore >= 80 ? "높음" : priceScore >= 60 ? "보통" : "낮음", note: monthInfo.price },
      { key: "content", label: "콘텐츠 반응", score: contentScore, value: contentScore >= 75 ? "강함" : contentScore >= 55 ? "보통" : "약함", note: monthInfo.content },
      { key: "risk", label: "운영 리스크 보정", score: riskScore, value: riskScore >= 75 ? "안정" : riskScore >= 55 ? "주의" : "위험", note: (monthInfo.risks || []).join(" · ") || "특이 리스크 없음" },
      { key: "aiSignal", label: "AI 신호 반영", score: aiSignalScore, value: `${DEMAND_AI_SIGNALS.length}개 신호`, note: DEMAND_AI_SIGNALS.map((signal) => signal.keyword).join(" · ") }
    ],
    radar: [
      { label: "월수요", score: demandScore },
      { label: "타겟", score: targetFitScore },
      { label: "평일", score: weekdayScore },
      { label: "가격", score: priceScore },
      { label: "콘텐츠", score: contentScore },
      { label: "리스크", score: riskScore }
    ],
    topSegments: topSegments.map((segment) => ({
      name: segment.name,
      group: segment.group,
      score: clampScore(segment.fitScore),
      priority: segment.priority,
      operation: segment.operation,
      caution: segment.caution,
      message: segment.message,
      keywords: segment.keywords
    })),
    recommendedOperations: [
      monthInfo.action,
      monthInfo.interpretation,
      ...topSegments.map((segment) => segment.operation)
    ].filter(Boolean).slice(0, 5),
    contentKeywords: targetKeywords,
    risks: monthInfo.risks || [],
    priceStrategy: monthInfo.price,
    interpretation: monthInfo.interpretation,
    aiSignals: DEMAND_AI_SIGNALS
  };
}

function numericField(row, keys) {
  for (const key of keys) {
    const value = row[key];
    if (value === null || value === undefined || value === "") continue;
    const parsed = Number(String(value).replace(/,/g, ""));
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function dateDiffDays(startDate, endDate) {
  const start = new Date(`${startDate}T00:00:00Z`);
  const end = new Date(`${endDate}T00:00:00Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return 0;
  return Math.round((end - start) / 86400000);
}

function bookingDaysFromRange(checkIn, checkOut) {
  const diff = dateDiffDays(checkIn, checkOut);
  return diff > 1 ? Math.min(31, diff + 1) : 1;
}

function resolveBookingRangePlaceLimit(value, bookingRangeDays) {
  const text = String(value ?? "").trim();
  if (!text) return Number(bookingRangeDays) > 1 ? 10 : 0;
  const number = Number(text);
  if (!Number.isFinite(number)) return Number(bookingRangeDays) > 1 ? 10 : 0;
  return Math.max(0, Math.min(20, Math.floor(number)));
}

function formatRate(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "";
  return `${Math.round(number * 100)}%`;
}

function parseWeeklyReservationRates(detail) {
  const matches = String(detail || "").matchAll(/(\d{2}\/\d{2})\s+(\d+)\/(\d+)/g);
  const rows = [];
  for (const match of matches) {
    const date = match[1];
    const available = Number(match[2]);
    const total = Number(match[3]);
    if (!Number.isFinite(available) || !Number.isFinite(total) || total <= 0) continue;
    const soldOut = Math.max(0, total - available);
    const rate = soldOut / total;
    rows.push({ date, soldOut, total, rate });
  }
  if (!rows.length) return { average: null, detail: "", totalSoldOut: null, totalStock: null };
  const average = Number((rows.reduce((sum, row) => sum + row.rate, 0) / rows.length).toFixed(3));
  const totalSoldOut = rows.reduce((sum, row) => sum + row.soldOut, 0);
  const totalStock = rows.reduce((sum, row) => sum + row.total, 0);
  const rateDetail = rows.map((row) => `${row.date} ${formatRate(row.rate)}(${row.soldOut}/${row.total})`).join(", ");
  return { average, detail: rateDetail, totalSoldOut, totalStock };
}

function stableHash(value) {
  return crypto.createHash("sha1").update(String(value || "")).digest("hex").slice(0, 16);
}

function runDateFromId(runId) {
  const match = String(runId || "").match(/(\d{4})(\d{2})(\d{2})/);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : "";
}

function normalizeObservationNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function dateFromMonthDay(label, checkIn) {
  const match = String(label || "").match(/(\d{1,2})\/(\d{1,2})/);
  if (!match) return "";
  const base = String(checkIn || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const year = base ? Number(base[1]) : new Date().getFullYear();
  const baseMonth = base ? Number(base[2]) : Number(match[1]);
  const month = Number(match[1]);
  const day = Number(match[2]);
  const resolvedYear = month < baseMonth && baseMonth >= 11 ? year + 1 : year;
  return `${resolvedYear}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function parseAvailabilityDetail(detail, checkIn) {
  const rows = [];
  const matches = String(detail || "").matchAll(/(\d{1,2}\/\d{1,2})\s+(\d+)\/(\d+)/g);
  for (const match of matches) {
    const available = Number(match[2]);
    const total = Number(match[3]);
    if (!Number.isFinite(available) || !Number.isFinite(total) || total <= 0) continue;
    rows.push({
      stayDate: dateFromMonthDay(match[1], checkIn),
      label: match[1],
      available,
      total
    });
  }
  return rows.filter((row) => row.stayDate);
}

function parseReservationRateDetail(detail, checkIn) {
  const rows = [];
  const matches = String(detail || "").matchAll(/(\d{1,2}\/\d{1,2})\s+\d+%\((\d+)\/(\d+)\)/g);
  for (const match of matches) {
    const sold = Number(match[2]);
    const total = Number(match[3]);
    if (!Number.isFinite(sold) || !Number.isFinite(total) || total <= 0) continue;
    rows.push({
      stayDate: dateFromMonthDay(match[1], checkIn),
      label: match[1],
      available: Math.max(0, total - sold),
      total
    });
  }
  return rows.filter((row) => row.stayDate);
}

function applyOfflineReservationBasis(rows, basisTotal) {
  const resolvedBasis = Number(basisTotal);
  if (!Number.isFinite(resolvedBasis) || resolvedBasis <= 0) return rows;
  return rows.map((row) => {
    const rawTotal = Number(row.total || 0);
    if (!Number.isFinite(rawTotal) || rawTotal <= 0 || rawTotal >= resolvedBasis) return row;
    return {
      ...row,
      rawTotal,
      offlineReserved: resolvedBasis - rawTotal,
      total: resolvedBasis,
      available: Math.min(Math.max(0, Number(row.available || 0)), resolvedBasis)
    };
  });
}

function singleAvailabilityRow(stayDate, available, total) {
  const resolvedAvailable = normalizeObservationNumber(available);
  const resolvedTotal = normalizeObservationNumber(total);
  if (resolvedAvailable === null || resolvedTotal === null || resolvedTotal <= 0) return [];
  return [{
    stayDate,
    label: stayDate,
    available: Math.max(0, resolvedAvailable),
    total: resolvedTotal
  }];
}

function historySeriesForItem(item, productType, checkIn) {
  if (productType === "dayuse") {
    const rows = parseAvailabilityDetail(item.dayUseWeeklyDetail, checkIn)
      .concat(parseReservationRateDetail(item.dayUseWeeklyReservationRateDetail, checkIn))
      .reduce((rows, row) => rows.some((itemRow) => itemRow.stayDate === row.stayDate) ? rows : [...rows, row], [])
      .concat(
        !item.dayUseWeeklyDetail && !item.dayUseWeeklyReservationRateDetail
          ? singleAvailabilityRow(checkIn, item.dayUseAvailableStock, item.dayUseTotalStock)
          : []
      );
    return applyOfflineReservationBasis(rows, item.dayUseWeeklyBasisTotal);
  }

  const rows = parseAvailabilityDetail(item.weeklyDetail, checkIn)
    .concat(parseReservationRateDetail(item.weeklyReservationRateDetail, checkIn))
    .reduce((rows, row) => rows.some((itemRow) => itemRow.stayDate === row.stayDate) ? rows : [...rows, row], [])
    .concat(
      !item.weeklyDetail && !item.weeklyReservationRateDetail
        ? singleAvailabilityRow(checkIn, item.nightAvailableStock ?? item.availableRooms, item.nightTotalStock ?? item.totalRooms)
        : []
    );
  return applyOfflineReservationBasis(rows, item.weeklyBasisTotal);
}

function dayOfWeekFromDate(dateText) {
  const match = String(dateText || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  const day = date.getUTCDay();
  return Number.isFinite(day) ? day : null;
}

function toNullableRate(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Number(number.toFixed(3)) : null;
}

function normalizeSignalRows(rows = []) {
  return rows
    .map((row) => {
      const total = Number(row.total);
      const available = Number(row.available);
      if (!Number.isFinite(total) || total <= 0 || !Number.isFinite(available)) return null;
      const resolvedAvailable = Math.max(0, Math.min(available, total));
      const sold = Math.max(0, total - resolvedAvailable);
      return {
        stayDate: row.stayDate || "",
        dayOfWeek: dayOfWeekFromDate(row.stayDate),
        total,
        available: resolvedAvailable,
        sold,
        rate: total ? sold / total : 0
      };
    })
    .filter(Boolean);
}

function averageSignalRate(rows = []) {
  const valid = rows.filter((row) => Number.isFinite(row.rate));
  if (!valid.length) return null;
  return toNullableRate(valid.reduce((sum, row) => sum + row.rate, 0) / valid.length);
}

function summarizeProductSalesSignal(rows = []) {
  const normalized = normalizeSignalRows(rows);
  const byDay = (day) => normalized.filter((row) => row.dayOfWeek === day);
  const weekdayRows = normalized.filter((row) => row.dayOfWeek >= 1 && row.dayOfWeek <= 4);
  const totals = normalized.map((row) => row.total).filter((value) => value > 0);
  const minTotal = totals.length ? Math.min(...totals) : null;
  const maxTotal = totals.length ? Math.max(...totals) : null;
  const fridayRate = averageSignalRate(byDay(5));
  const saturdayRate = averageSignalRate(byDay(6));
  const sundayRate = averageSignalRate(byDay(0));
  const weekdayRate = averageSignalRate(weekdayRows);
  const overallRate = averageSignalRate(normalized);
  const anchorRate = saturdayRate ?? overallRate ?? null;
  return {
    days: normalized.length,
    totalSupply: normalized.reduce((sum, row) => sum + row.total, 0),
    totalSold: normalized.reduce((sum, row) => sum + row.sold, 0),
    averageRate: overallRate,
    fridayRate,
    saturdayRate,
    sundayRate,
    weekdayRate,
    fridayWeak: fridayRate !== null && (fridayRate <= 0.25 || (anchorRate !== null && anchorRate >= 0.55 && fridayRate + 0.25 < anchorRate)),
    sundayWeak: sundayRate !== null && (sundayRate <= 0.22 || (anchorRate !== null && anchorRate >= 0.55 && sundayRate + 0.28 < anchorRate)),
    weekdayWeak: weekdayRows.length >= 2 && weekdayRate !== null && (weekdayRate <= 0.22 || (anchorRate !== null && anchorRate >= 0.55 && weekdayRate + 0.30 < anchorRate)),
    stockVariance: minTotal !== null && maxTotal !== null && maxTotal > minTotal,
    stockVarianceRatio: minTotal ? toNullableRate(maxTotal / minTotal) : null,
    minTotal,
    maxTotal
  };
}

function companySalesSignalFromItem(item = {}, run = {}) {
  const checkIn = run.checkIn || runDateFromId(run.id) || kstDate(0);
  const lodging = summarizeProductSalesSignal(historySeriesForItem(item, "lodging", checkIn));
  const dayUse = summarizeProductSalesSignal(historySeriesForItem(item, "dayuse", checkIn));
  const structureFlags = Array.isArray(item.inventoryStructureFlags) ? item.inventoryStructureFlags : [];
  const confidenceGrade = String(item.inventoryConfidenceGrade || "").toUpperCase();
  const structureWeak = Boolean(confidenceGrade && !["A", "B"].includes(confidenceGrade));
  const dayUseHasSupply = dayUse.totalSupply > 0 || Number(item.dayUseTotalStock || 0) > 0 || Number(item.dayUseItemCount || 0) > 0;
  return {
    checkIn,
    lodging,
    dayUse,
    lodgingDays: lodging.days,
    dayUseDays: dayUse.days,
    dayUseMissing: !dayUseHasSupply,
    structureWeak,
    stockVariance: Boolean(lodging.stockVariance || dayUse.stockVariance || structureFlags.includes("dynamic_capacity")),
    bookingIdReused: structureFlags.includes("booking_id_reused"),
    groupedStock: structureFlags.includes("grouped_range") || ["grouped_stock", "stock_only", "unknown"].includes(String(item.inventoryStructureType || "")),
    structureFlags: boundedUnique(structureFlags, 10)
  };
}

function emptyCompanyMaster() {
  return {
    schemaVersion: 1,
    updatedAt: "",
    companies: {},
    sourceIndex: {},
    duplicateResolutions: {}
  };
}

async function readCompanyMaster() {
  try {
    const parsed = JSON.parse((await fsp.readFile(COMPANY_MASTER_FILE, "utf8")).replace(/^\uFEFF/, ""));
    return {
      ...emptyCompanyMaster(),
      ...parsed,
      companies: parsed.companies || {},
      sourceIndex: parsed.sourceIndex || {},
      duplicateResolutions: parsed.duplicateResolutions || {}
    };
  } catch {
    return emptyCompanyMaster();
  }
}

async function writeCompanyMaster(master) {
  await fsp.mkdir(COMPANY_MASTER_DIR, { recursive: true });
  const next = { ...master, updatedAt: new Date().toISOString() };
  master.updatedAt = next.updatedAt;
  const tempPath = `${COMPANY_MASTER_FILE}.${process.pid}.tmp`;
  await fsp.writeFile(tempPath, JSON.stringify(next, null, 2), "utf8");
  await fsp.rename(tempPath, COMPANY_MASTER_FILE);
}

function companySourceKeys(entity = {}) {
  const keys = [];
  if (entity.placeId) keys.push(`place:${entity.placeId}`);
  if (entity.bookingBusinessId) keys.push(`booking:${entity.bookingBusinessId}`);
  if (entity.nameKey && entity.addressKey) keys.push(`name_addr:${entity.nameKey}:${entity.addressKey}`);
  if (entity.nameKey && entity.regionKey) keys.push(`name_region:${entity.nameKey}:${entity.regionKey}`);
  return boundedUnique(keys, 10);
}

function companyEntityFromItem(item = {}, run = {}, collectedAt = "") {
  const name = String(item.name || "").trim();
  const region = String(item.region || "").trim();
  const address = String(item.address || "").trim();
  const placeId = extractNaverPlaceId(item);
  const bookingBusinessId = extractBookingBusinessId(item);
  const nameKey = normalizeCompanyIdentityName(name);
  const looseNameKey = normalizeCompanyLooseName(name);
  const addressKey = normalizeAddressKey(address);
  const regionKey = normalizeCompanyIdentityName(region);
  const sourceKeys = companySourceKeys({ placeId, bookingBusinessId, nameKey, addressKey, regionKey });
  const keywordLayer = keywordLayerFromRunLike(run);
  const salesSignal = companySalesSignalFromItem(item, run);
  return {
    name,
    nameKey,
    looseNameKey,
    region,
    regionKey,
    address,
    addressKey,
    placeId,
    bookingBusinessId,
    sourceKeys,
    url: item.url || "",
    rank: item.rank ?? null,
    keyword: run.keyword || run.label || "",
    keywordKey: compactKeyword(run.keyword || run.label || "").toLowerCase(),
    keywordLayer: keywordLayer.type,
    keywordLayerLabel: keywordLayer.label,
    keywordLayerNote: keywordLayer.note,
    provinceKey: run.province || "",
    searchMode: run.searchMode || "",
    productMode: run.productMode || "",
    runId: run.id || "",
    collectedAt,
    collectedDate: String(collectedAt || "").slice(0, 10),
    listType: item.listType || "",
    inventoryStructureType: item.inventoryStructureType || "",
    inventoryStructureLabel: item.inventoryStructureLabel || "",
    inventoryConfidenceGrade: item.inventoryConfidenceGrade || "",
    inventoryStructureFlags: Array.isArray(item.inventoryStructureFlags) ? item.inventoryStructureFlags : [],
    salesSignal,
    price: item.price || ""
  };
}

function createCompanyRecord(companyId, entity) {
  const now = entity.collectedAt || new Date().toISOString();
  return {
    companyId,
    primaryName: entity.name || "업체명 확인",
    nameKey: entity.nameKey || "",
    looseNameKey: entity.looseNameKey || "",
    aliases: boundedUnique([entity.name]),
    placeIds: boundedUnique([entity.placeId]),
    bookingBusinessIds: boundedUnique([entity.bookingBusinessId]),
    regions: boundedUnique([entity.region]),
    addresses: boundedUnique([entity.address]),
    urls: boundedUnique([entity.url]),
    firstSeenAt: now,
    lastSeenAt: now,
    firstRunId: entity.runId || "",
    lastRunId: entity.runId || "",
    runIds: boundedUnique([entity.runId], 120),
    keywords: {},
    inventory: {
      latest: {},
      structureCounts: {},
      confidenceCounts: {}
    },
    manualCorrection: null,
    duplicateNotes: []
  };
}

function mergeCompanyFieldArrays(company, entity) {
  company.aliases = boundedUnique([...(company.aliases || []), entity.name], 30);
  company.placeIds = boundedUnique([...(company.placeIds || []), entity.placeId], 20);
  company.bookingBusinessIds = boundedUnique([...(company.bookingBusinessIds || []), entity.bookingBusinessId], 20);
  company.regions = boundedUnique([...(company.regions || []), entity.region], 20);
  company.addresses = boundedUnique([...(company.addresses || []), entity.address], 20);
  company.urls = boundedUnique([...(company.urls || []), entity.url], 30);
  company.runIds = boundedUnique([...(company.runIds || []), entity.runId], 120);
  if (!company.primaryName || company.primaryName === "업체명 확인") company.primaryName = entity.name || company.primaryName;
  if (!company.nameKey) company.nameKey = entity.nameKey || "";
  if (!company.looseNameKey) company.looseNameKey = entity.looseNameKey || "";
}

function upsertCompanyKeywordExposure(company, entity) {
  if (!entity.keywordKey) return;
  const keyword = company.keywords[entity.keywordKey] || {
    keyword: entity.keyword || entity.keywordKey,
    keywordKey: entity.keywordKey,
    firstSeenAt: entity.collectedAt,
    lastSeenAt: entity.collectedAt,
    bestRank: null,
    latestRank: null,
    latestRunId: "",
    runs: []
  };
  const existingIndex = keyword.runs.findIndex((row) => row.runId === entity.runId);
  const exposure = {
    runId: entity.runId,
    collectedAt: entity.collectedAt,
    collectedDate: entity.collectedDate,
    rank: Number(entity.rank) || null,
    searchMode: entity.searchMode || "",
    productMode: entity.productMode || "",
    keywordLayer: entity.keywordLayer || "",
    keywordLayerLabel: entity.keywordLayerLabel || "",
    provinceKey: entity.provinceKey || ""
  };
  if (existingIndex >= 0) keyword.runs[existingIndex] = { ...keyword.runs[existingIndex], ...exposure };
  else keyword.runs.push(exposure);
  keyword.runs = keyword.runs
    .filter((row) => row.runId)
    .sort((a, b) => String(b.collectedAt || "").localeCompare(String(a.collectedAt || "")))
    .slice(0, 80);
  keyword.firstSeenAt = [keyword.firstSeenAt, entity.collectedAt].filter(Boolean).sort()[0] || entity.collectedAt;
  keyword.lastSeenAt = [keyword.lastSeenAt, entity.collectedAt].filter(Boolean).sort().at(-1) || entity.collectedAt;
  keyword.latestRank = exposure.rank;
  keyword.latestRunId = entity.runId;
  keyword.keywordLayer = entity.keywordLayer || keyword.keywordLayer || "";
  keyword.keywordLayerLabel = entity.keywordLayerLabel || keyword.keywordLayerLabel || "";
  keyword.provinceKey = entity.provinceKey || keyword.provinceKey || "";
  const ranks = keyword.runs.map((row) => Number(row.rank)).filter((rank) => Number.isFinite(rank) && rank > 0);
  keyword.bestRank = ranks.length ? Math.min(...ranks) : null;
  keyword.runCount = keyword.runs.length;
  company.keywords[entity.keywordKey] = keyword;
}

function updateCompanyInventory(company, entity) {
  const inventory = company.inventory || { latest: {}, structureCounts: {}, confidenceCounts: {}, runIds: [] };
  const alreadyCounted = entity.runId && (inventory.runIds || []).includes(entity.runId);
  inventory.latest = {
    runId: entity.runId,
    collectedAt: entity.collectedAt,
    listType: entity.listType,
    structureType: entity.inventoryStructureType,
    structureLabel: entity.inventoryStructureLabel,
    confidenceGrade: entity.inventoryConfidenceGrade,
    structureFlags: boundedUnique(entity.inventoryStructureFlags || [], 10),
    salesSignal: entity.salesSignal || {},
    price: entity.price
  };
  if (!alreadyCounted && entity.inventoryStructureLabel) {
    inventory.structureCounts[entity.inventoryStructureLabel] = (inventory.structureCounts[entity.inventoryStructureLabel] || 0) + 1;
  }
  if (!alreadyCounted && entity.inventoryConfidenceGrade) {
    inventory.confidenceCounts[entity.inventoryConfidenceGrade] = (inventory.confidenceCounts[entity.inventoryConfidenceGrade] || 0) + 1;
  }
  inventory.runIds = boundedUnique([...(inventory.runIds || []), entity.runId], 120);
  company.inventory = inventory;
}

function keywordExposureLayer(keyword = {}) {
  const latestRun = (keyword.runs || [])[0] || {};
  if (keyword.keywordLayer) {
    return {
      type: keyword.keywordLayer,
      label: keyword.keywordLayerLabel || keywordLayerFromRunLike(keyword).label,
      note: keywordLayerFromRunLike(keyword).note
    };
  }
  if (latestRun.keywordLayer) {
    return {
      type: latestRun.keywordLayer,
      label: latestRun.keywordLayerLabel || keywordLayerFromRunLike({ ...keyword, ...latestRun }).label,
      note: keywordLayerFromRunLike({ ...keyword, ...latestRun }).note
    };
  }
  return keywordLayerFromRunLike({
    keyword: keyword.keyword,
    searchMode: latestRun.searchMode || keyword.searchMode || "",
    keywordType: keyword.keywordType || ""
  });
}

function companyExposureLayerFromKeywords(keywords = []) {
  const regional = keywords.filter((row) => row.layer?.type === "regional");
  const local = keywords.filter((row) => row.layer?.type === "local");
  const company = keywords.filter((row) => row.layer?.type === "company");
  if (regional.length && local.length) {
    return {
      type: "regional_local",
      label: "광역+로컬 장악형",
      note: "권역 키워드와 지역 키워드에 동시에 노출"
    };
  }
  if (local.length && !regional.length) {
    return {
      type: "local_only",
      label: "로컬 전용형",
      note: "지역 키워드에는 노출되나 광역 키워드 노출은 미확인"
    };
  }
  if (regional.length && !local.length) {
    return {
      type: "local_match_pending",
      label: "로컬 매칭 대기",
      note: "광역 노출 업체이며, 대응 로컬 키워드 수집/매칭이 필요"
    };
  }
  if (company.length) {
    return {
      type: "company_only",
      label: "업체명 확인형",
      note: "업체명 검색으로 확인, 키워드 노출 구조 검증 필요"
    };
  }
  return {
    type: "unknown",
    label: "분류 대기",
    note: "노출 키워드 추가 수집 필요"
  };
}

function companyRecordSummary(company = {}, activeKeywordKey = "") {
  const keywords = Object.values(company.keywords || {})
    .sort((a, b) => (a.bestRank || 9999) - (b.bestRank || 9999) || String(b.lastSeenAt || "").localeCompare(String(a.lastSeenAt || "")))
    .map((row) => {
      const layer = keywordExposureLayer(row);
      return {
        keyword: row.keyword,
        keywordKey: row.keywordKey,
        runCount: row.runCount || row.runs?.length || 0,
        bestRank: row.bestRank,
        latestRank: row.latestRank,
        lastSeenAt: row.lastSeenAt,
        latestRunId: row.latestRunId,
        layer
      };
    });
  const best = keywords.find((row) => row.bestRank) || keywords[0] || null;
  const activeKeyword = activeKeywordKey ? keywords.find((row) => row.keywordKey === activeKeywordKey) : null;
  const exposureLayer = companyExposureLayerFromKeywords(keywords);
  return {
    companyId: company.companyId,
    primaryName: company.primaryName,
    aliases: (company.aliases || []).slice(0, 6),
    placeIds: company.placeIds || [],
    bookingBusinessIds: company.bookingBusinessIds || [],
    regions: company.regions || [],
    addresses: (company.addresses || []).slice(0, 3),
    firstSeenAt: company.firstSeenAt,
    lastSeenAt: company.lastSeenAt,
    runCount: (company.runIds || []).length,
    keywordCount: keywords.length,
    keywords: keywords.slice(0, 8),
    bestRank: best?.bestRank || null,
    bestKeyword: best?.keyword || "",
    latestKeyword: keywords.sort((a, b) => String(b.lastSeenAt || "").localeCompare(String(a.lastSeenAt || "")))[0]?.keyword || "",
    activeKeyword,
    exposureLayer,
    inventory: company.inventory || {},
    manualCorrection: company.manualCorrection || null,
    identityConfidence: companyIdentityConfidence(company)
  };
}

function findCompanyDuplicateCandidates(master) {
  const buckets = new Map();
  for (const company of Object.values(master.companies || {})) {
    const loose = company.looseNameKey || normalizeCompanyLooseName(company.primaryName);
    const region = normalizeCompanyIdentityName((company.regions || [])[0] || "");
    if (!loose || loose.length < 2) continue;
    const key = `${loose}:${region}`;
    const bucket = buckets.get(key) || [];
    bucket.push(company);
    buckets.set(key, bucket);
  }
  return [...buckets.entries()]
    .filter(([key, companies]) => companies.length > 1 && master.duplicateResolutions?.[key] !== "separate")
    .map(([candidateKey, companies]) => ({
      candidateKey,
      reason: "유사 업체명 + 지역",
      companies: companies.map((company) => companyRecordSummary(company)).slice(0, 6)
    }))
    .slice(0, 20);
}

function summarizeCompanyCrossKeyword(master) {
  const companies = Object.values(master.companies || {}).map((company) => companyRecordSummary(company));
  const byLayer = (type) => companies.filter((company) => company.exposureLayer?.type === type);
  const regionalLocalCompanies = byLayer("regional_local")
    .sort((a, b) => (a.bestRank || 9999) - (b.bestRank || 9999) || (b.keywordCount || 0) - (a.keywordCount || 0));
  const localOnlyCompanies = byLayer("local_only")
    .sort((a, b) => (a.bestRank || 9999) - (b.bestRank || 9999) || (b.runCount || 0) - (a.runCount || 0));
  const pendingCompanies = byLayer("local_match_pending")
    .sort((a, b) => (a.bestRank || 9999) - (b.bestRank || 9999) || (b.runCount || 0) - (a.runCount || 0));
  const companyOnlyCompanies = byLayer("company_only")
    .sort((a, b) => (b.runCount || 0) - (a.runCount || 0));
  const confidenceCounts = companies.reduce((acc, company) => {
    const label = company.identityConfidence?.label || "검토 필요";
    acc[label] = (acc[label] || 0) + 1;
    return acc;
  }, {});
  const layerCounts = companies.reduce((acc, company) => {
    const type = company.exposureLayer?.type || "unknown";
    acc[type] = (acc[type] || 0) + 1;
    return acc;
  }, {});
  const mapCompany = (company) => ({
    companyId: company.companyId,
    primaryName: company.primaryName,
    runCount: company.runCount,
    keywordCount: company.keywordCount,
    bestRank: company.bestRank,
    bestKeyword: company.bestKeyword,
    exposureLayer: company.exposureLayer,
    identityConfidence: company.identityConfidence,
    keywords: (company.keywords || []).slice(0, 8)
  });
  return {
    totalCompanies: companies.length,
    regionalLocalCompanyCount: regionalLocalCompanies.length,
    localOnlyCompanyCount: localOnlyCompanies.length,
    localMatchPendingCompanyCount: pendingCompanies.length,
    companyOnlyCompanyCount: companyOnlyCompanies.length,
    regionalExposureCompanyCount: companies.filter((company) => (company.keywords || []).some((row) => row.layer?.type === "regional")).length,
    localExposureCompanyCount: companies.filter((company) => (company.keywords || []).some((row) => row.layer?.type === "local")).length,
    keywordLinks: companies.reduce((sum, company) => sum + Number(company.keywordCount || 0), 0),
    confidenceCounts,
    layerCounts,
    regionalLocalCompanies: regionalLocalCompanies.slice(0, 12).map(mapCompany),
    localOnlyCompanies: localOnlyCompanies.slice(0, 12).map(mapCompany),
    localMatchPendingCompanies: pendingCompanies.slice(0, 12).map(mapCompany),
    companyOnlyCompanies: companyOnlyCompanies.slice(0, 12).map(mapCompany),
    reviewNeededCompanies: companies
      .filter((company) => company.identityConfidence?.level === "review" || company.identityConfidence?.level === "medium")
      .sort((a, b) => (b.runCount || 0) - (a.runCount || 0))
      .slice(0, 12)
      .map((company) => ({
        companyId: company.companyId,
        primaryName: company.primaryName,
        runCount: company.runCount,
        keywordCount: company.keywordCount,
        exposureLayer: company.exposureLayer,
        identityConfidence: company.identityConfidence,
        keywords: (company.keywords || []).slice(0, 4)
      }))
  };
}

function salesTargetRankScore(bestRank) {
  const rank = Number(bestRank);
  if (!Number.isFinite(rank) || rank <= 0) return 6;
  if (rank <= 5) return 20;
  if (rank <= 10) return 16;
  if (rank <= 20) return 12;
  return 7;
}

function companySalesTargetSignals(company = {}) {
  const latestInventory = company.inventory?.latest || {};
  const signal = latestInventory.salesSignal || {};
  const lodging = signal.lodging || {};
  const dayUse = signal.dayUse || {};
  const latestFlags = Array.isArray(latestInventory.structureFlags) ? latestInventory.structureFlags : [];
  const signalFlags = Array.isArray(signal.structureFlags) ? signal.structureFlags : [];
  const structureFlags = boundedUnique([
    ...latestFlags,
    ...signalFlags
  ], 12);
  const confidenceGrade = String(latestInventory.confidenceGrade || "").toUpperCase();
  const structureWeak = Boolean(
    signal.structureWeak ||
    (confidenceGrade && !["A", "B"].includes(confidenceGrade)) ||
    signal.groupedStock ||
    structureFlags.includes("grouped_range")
  );
  const stockVariance = Boolean(signal.stockVariance || structureFlags.includes("dynamic_capacity"));
  const bookingIdReused = Boolean(signal.bookingIdReused || structureFlags.includes("booking_id_reused"));
  const productNamingReview = Boolean(structureWeak || bookingIdReused || signal.groupedStock);
  const dayUseMissing = Boolean(signal.dayUseMissing && (lodging.totalSupply || lodging.days));
  const otaReviewNeeded = Boolean(structureWeak || stockVariance || bookingIdReused);
  return {
    fridayWeak: Boolean(lodging.fridayWeak),
    sundayWeak: Boolean(lodging.sundayWeak),
    weekdayWeak: Boolean(lodging.weekdayWeak),
    dayUseMissing,
    structureWeak,
    stockVariance,
    bookingIdReused,
    productNamingReview,
    otaReviewNeeded,
    lodgingRate: lodging.averageRate ?? null,
    dayUseRate: dayUse.averageRate ?? null,
    fridayRate: lodging.fridayRate ?? null,
    saturdayRate: lodging.saturdayRate ?? null,
    sundayRate: lodging.sundayRate ?? null,
    weekdayRate: lodging.weekdayRate ?? null,
    lodgingDays: lodging.days || 0,
    dayUseDays: dayUse.days || 0
  };
}

function companySalesTargetSignalReasons(signals = {}) {
  const reasons = [];
  const tags = [];
  const scoreParts = [];
  const add = (flag, score, tag, reason) => {
    if (!flag) return;
    scoreParts.push(score);
    tags.push(tag);
    reasons.push(reason);
  };
  add(signals.fridayWeak, 8, "금요일 약함", "토요일 대비 금요일 판매 공백이 보여 금요일 상품/가격 개선 여지");
  add(signals.sundayWeak, 8, "일요일 약함", "주말 이후 일요일 판매가 약해 연박/퇴실일 상품 개선 여지");
  add(signals.weekdayWeak, 5, "평일 약함", "월~목 평균 판매가 낮아 평일 패키지/타깃 보완 여지");
  add(signals.dayUseMissing, 5, "당일상품 공백", "데이유즈/캠프닉 확인 수량이 없어 당일상품 확장 검토");
  add(signals.structureWeak, 6, "수량구조 확인", "객실 수량 구조가 흔들려 총량/상품 단위 검증 필요");
  add(signals.stockVariance, 5, "오프라인예약 반영", "날짜별 총량 변동이 있어 전화예약/비연동 채널 수량조절 가능성");
  add(signals.bookingIdReused, 5, "예약ID 확인", "예약ID 또는 상품 구조 재사용 가능성이 있어 네이버 상품 구조 재확인 필요");
  add(signals.productNamingReview, 4, "상품명 검토", "네이버 예약 상품명/구성이 고객 관점에서 재정리될 여지");
  add(signals.otaReviewNeeded, 4, "OTA 확인", "판단이 흔들리는 업체로 OTA/채널 비교 확인 필요");
  return {
    score: scoreParts.reduce((sum, value) => sum + Number(value || 0), 0),
    tags: boundedUnique(tags, 8),
    reasons: boundedUnique(reasons, 8)
  };
}

function companySalesTargetProfile(company = {}) {
  const layerType = company.exposureLayer?.type || "unknown";
  const scoreParts = [];
  const reasons = [];
  let category = "exclude";
  let categoryLabel = "제외 후보";

  if (layerType === "local_only") {
    scoreParts.push(48);
    reasons.push("로컬 키워드에는 노출되지만 광역 키워드 노출은 미확인");
    category = "contact";
    categoryLabel = "컨택 후보";
  } else if (layerType === "company_only") {
    scoreParts.push(34);
    reasons.push("업체명 검색으로만 확인되어 키워드 노출 구조 검증 필요");
    category = "observe";
    categoryLabel = "관찰 후보";
  } else if (layerType === "local_match_pending") {
    scoreParts.push(24);
    reasons.push("광역 노출 업체로 로컬 매칭 수집이 먼저 필요");
    category = "verify";
    categoryLabel = "검증 후보";
  } else if (layerType === "regional_local") {
    scoreParts.push(10);
    reasons.push("광역과 로컬에 함께 노출되는 권역 강자");
    category = "benchmark";
    categoryLabel = "벤치마크";
  }

  const rankScore = salesTargetRankScore(company.bestRank);
  scoreParts.push(rankScore);
  if (company.bestRank) reasons.push(`최고 노출 ${company.bestRank}위`);

  const localKeywordCount = (company.keywords || []).filter((row) => row.layer?.type === "local").length;
  const regionalKeywordCount = (company.keywords || []).filter((row) => row.layer?.type === "regional").length;
  if (localKeywordCount) {
    scoreParts.push(Math.min(12, localKeywordCount * 4));
    reasons.push(`로컬 키워드 ${localKeywordCount}개 확인`);
  }
  if (regionalKeywordCount) {
    reasons.push(`광역 키워드 ${regionalKeywordCount}개 확인`);
  }

  if (company.manualCorrection) {
    scoreParts.push(4);
    reasons.push("수동 보정값 보유");
  }
  if (company.identityConfidence?.level === "certain" || company.identityConfidence?.level === "high") {
    scoreParts.push(6);
    reasons.push(company.identityConfidence.reason || "고유키 신뢰도 높음");
  }

  const latestInventory = company.inventory?.latest || {};
  if (latestInventory.structureLabel) reasons.push(`수량 구조: ${latestInventory.structureLabel}`);
  if (latestInventory.confidenceGrade && !["A", "B"].includes(String(latestInventory.confidenceGrade).toUpperCase())) {
    scoreParts.push(5);
    reasons.push("수량 구조 검증 여지");
  }
  const signals = companySalesTargetSignals(company);
  const signalProfile = companySalesTargetSignalReasons(signals);
  if (signalProfile.score) scoreParts.push(signalProfile.score);
  reasons.push(...signalProfile.reasons);

  let score = Math.min(100, Math.max(0, Math.round(scoreParts.reduce((sum, value) => sum + Number(value || 0), 0))));
  if (category === "contact" && score < 58) {
    category = "observe";
    categoryLabel = "관찰 후보";
  }
  if (category === "benchmark") score = Math.min(score, 45);
  if (category === "verify") score = Math.min(score, 55);

  return {
    ...company,
    salesTarget: {
      score,
      category,
      categoryLabel,
      signals,
      priorityTags: signalProfile.tags,
      reasons: boundedUnique(reasons, 8),
      recommendation: category === "contact"
        ? "광역 진입 여지가 있는 로컬 전용 업체로 우선 컨택"
        : category === "verify"
          ? "주소/지역 기준 로컬 키워드 수집 후 재판정"
          : category === "benchmark"
            ? "상품/리뷰/가격 벤치마크 대상으로 관찰"
            : "추가 수집 후 관찰"
    }
  };
}

function summarizeCompanySalesTargets(companies = []) {
  const profiled = companies.map((company) => company.salesTarget ? company : companySalesTargetProfile(company));
  const byCategory = (category) => profiled
    .filter((company) => company.salesTarget.category === category)
    .sort((a, b) => (b.salesTarget.score || 0) - (a.salesTarget.score || 0) || (a.bestRank || 9999) - (b.bestRank || 9999));
  const contactCandidates = byCategory("contact");
  const observeCandidates = byCategory("observe");
  const verificationQueue = byCategory("verify");
  const benchmarkCompanies = byCategory("benchmark");
  return {
    totalCompanies: profiled.length,
    contactCandidateCount: contactCandidates.length,
    observeCandidateCount: observeCandidates.length,
    verificationQueueCount: verificationQueue.length,
    benchmarkCount: benchmarkCompanies.length,
    topTargets: contactCandidates.slice(0, 20),
    observeCandidates: observeCandidates.slice(0, 12),
    verificationQueue: verificationQueue.slice(0, 12),
    benchmarkCompanies: benchmarkCompanies.slice(0, 12)
  };
}

function applyCompanyManualCorrection(item, company) {
  const correction = company?.manualCorrection;
  if (!correction || correction.active === false) return item;
  const next = { ...item, companyManualCorrection: correction, manualCorrectionApplied: true };
  const lodgingBasis = Number(correction.lodgingBasisTotal);
  const dayUseBasis = Number(correction.dayUseBasisTotal);
  if (Number.isFinite(lodgingBasis) && lodgingBasis > 0) {
    next.weeklyBasisTotal = Math.max(Number(next.weeklyBasisTotal || 0), lodgingBasis);
    next.nightTotalStock = Math.max(Number(next.nightTotalStock || 0), lodgingBasis);
  }
  if (Number.isFinite(dayUseBasis) && dayUseBasis > 0) {
    next.dayUseWeeklyBasisTotal = Math.max(Number(next.dayUseWeeklyBasisTotal || 0), dayUseBasis);
    next.dayUseTotalStock = Math.max(Number(next.dayUseTotalStock || 0), dayUseBasis);
  }
  return next;
}

function companyIdentityConfidence(company = {}) {
  if ((company.placeIds || []).length) {
    return { level: "certain", label: "확실", reason: "네이버 place_id 기준" };
  }
  if ((company.bookingBusinessIds || []).length) {
    return { level: "high", label: "높음", reason: "네이버 예약ID 기준" };
  }
  if ((company.addresses || []).length) {
    return { level: "medium", label: "보통", reason: "업체명+주소 기준" };
  }
  return { level: "review", label: "검토 필요", reason: "업체명+지역 보조 기준" };
}

function upsertCompanyRecord(master, entity) {
  const sourceKeys = entity.sourceKeys || [];
  const matchedIds = boundedUnique(sourceKeys.map((key) => master.sourceIndex[key]).filter(Boolean), 10);
  let companyId = matchedIds[0];
  if (!companyId) {
    companyId = entity.placeId
      ? `cmp_place_${entity.placeId}`
      : `cmp_${stableHash([entity.nameKey, entity.addressKey, entity.regionKey, entity.bookingBusinessId].filter(Boolean).join("|"))}`;
  }
  let company = master.companies[companyId];
  if (!company) {
    company = createCompanyRecord(companyId, entity);
    master.companies[companyId] = company;
  }
  if (matchedIds.length > 1) {
    company.duplicateNotes = [
      ...(company.duplicateNotes || []),
      {
        at: entity.collectedAt,
        reason: "하나의 수집 업체가 여러 기존 companyId와 연결됨",
        matchedIds
      }
    ].slice(-20);
  }
  company.lastSeenAt = [company.lastSeenAt, entity.collectedAt].filter(Boolean).sort().at(-1) || entity.collectedAt;
  company.lastRunId = entity.runId || company.lastRunId;
  mergeCompanyFieldArrays(company, entity);
  upsertCompanyKeywordExposure(company, entity);
  updateCompanyInventory(company, entity);
  for (const key of sourceKeys) master.sourceIndex[key] = companyId;
  return company;
}

function mergeCompanyKeyword(targetKeyword = {}, sourceKeyword = {}) {
  const runsById = new Map();
  for (const row of [...(targetKeyword.runs || []), ...(sourceKeyword.runs || [])]) {
    if (!row?.runId) continue;
    runsById.set(row.runId, { ...(runsById.get(row.runId) || {}), ...row });
  }
  const runs = [...runsById.values()]
    .sort((a, b) => String(b.collectedAt || "").localeCompare(String(a.collectedAt || "")))
    .slice(0, 80);
  const ranks = runs.map((row) => Number(row.rank)).filter((rank) => Number.isFinite(rank) && rank > 0);
  const latest = runs[0] || {};
  return {
    ...targetKeyword,
    ...sourceKeyword,
    keyword: targetKeyword.keyword || sourceKeyword.keyword || "",
    keywordKey: targetKeyword.keywordKey || sourceKeyword.keywordKey || "",
    firstSeenAt: [targetKeyword.firstSeenAt, sourceKeyword.firstSeenAt].filter(Boolean).sort()[0] || "",
    lastSeenAt: [targetKeyword.lastSeenAt, sourceKeyword.lastSeenAt].filter(Boolean).sort().at(-1) || "",
    bestRank: ranks.length ? Math.min(...ranks) : null,
    latestRank: latest.rank || null,
    latestRunId: latest.runId || "",
    keywordLayer: targetKeyword.keywordLayer || sourceKeyword.keywordLayer || latest.keywordLayer || "",
    keywordLayerLabel: targetKeyword.keywordLayerLabel || sourceKeyword.keywordLayerLabel || latest.keywordLayerLabel || "",
    provinceKey: targetKeyword.provinceKey || sourceKeyword.provinceKey || latest.provinceKey || "",
    runCount: runs.length,
    runs
  };
}

function mergeCompanyInventory(targetInventory = {}, sourceInventory = {}) {
  const merged = {
    latest: targetInventory.latest || sourceInventory.latest || {},
    structureCounts: { ...(targetInventory.structureCounts || {}) },
    confidenceCounts: { ...(targetInventory.confidenceCounts || {}) },
    runIds: boundedUnique([...(targetInventory.runIds || []), ...(sourceInventory.runIds || [])], 120)
  };
  for (const [key, count] of Object.entries(sourceInventory.structureCounts || {})) {
    merged.structureCounts[key] = (merged.structureCounts[key] || 0) + Number(count || 0);
  }
  for (const [key, count] of Object.entries(sourceInventory.confidenceCounts || {})) {
    merged.confidenceCounts[key] = (merged.confidenceCounts[key] || 0) + Number(count || 0);
  }
  if (
    sourceInventory.latest?.collectedAt
    && String(sourceInventory.latest.collectedAt).localeCompare(String(merged.latest?.collectedAt || "")) > 0
  ) {
    merged.latest = sourceInventory.latest;
  }
  return merged;
}

function mergeCompanyRecords(master, companyIds = [], candidateKey = "") {
  const ids = boundedUnique(companyIds, 20).filter((id) => master.companies?.[id]);
  if (ids.length < 2) {
    const error = new Error("병합할 업체를 2개 이상 선택해야 합니다.");
    error.statusCode = 400;
    throw error;
  }
  const targetId = ids[0];
  const target = master.companies[targetId];
  for (const sourceId of ids.slice(1)) {
    const source = master.companies[sourceId];
    if (!source) continue;
    target.aliases = boundedUnique([...(target.aliases || []), ...(source.aliases || []), source.primaryName], 40);
    target.placeIds = boundedUnique([...(target.placeIds || []), ...(source.placeIds || [])], 30);
    target.bookingBusinessIds = boundedUnique([...(target.bookingBusinessIds || []), ...(source.bookingBusinessIds || [])], 30);
    target.regions = boundedUnique([...(target.regions || []), ...(source.regions || [])], 30);
    target.addresses = boundedUnique([...(target.addresses || []), ...(source.addresses || [])], 30);
    target.urls = boundedUnique([...(target.urls || []), ...(source.urls || [])], 40);
    target.runIds = boundedUnique([...(target.runIds || []), ...(source.runIds || [])], 160);
    target.firstSeenAt = [target.firstSeenAt, source.firstSeenAt].filter(Boolean).sort()[0] || target.firstSeenAt || "";
    target.lastSeenAt = [target.lastSeenAt, source.lastSeenAt].filter(Boolean).sort().at(-1) || target.lastSeenAt || "";
    target.keywords = target.keywords || {};
    for (const [keywordKey, sourceKeyword] of Object.entries(source.keywords || {})) {
      target.keywords[keywordKey] = mergeCompanyKeyword(target.keywords[keywordKey], sourceKeyword);
    }
    target.inventory = mergeCompanyInventory(target.inventory || {}, source.inventory || {});
    if (!target.manualCorrection && source.manualCorrection) target.manualCorrection = source.manualCorrection;
    target.duplicateNotes = [
      ...(target.duplicateNotes || []),
      {
        at: new Date().toISOString(),
        reason: "관리자 병합",
        mergedCompanyId: sourceId,
        candidateKey
      },
      ...(source.duplicateNotes || [])
    ].slice(-40);
    for (const [sourceKey, indexedCompanyId] of Object.entries(master.sourceIndex || {})) {
      if (indexedCompanyId === sourceId) master.sourceIndex[sourceKey] = targetId;
    }
    delete master.companies[sourceId];
  }
  if (candidateKey) master.duplicateResolutions[candidateKey] = `merged:${targetId}`;
  return target;
}

async function resolveCompanyMasterDuplicate(payload = {}) {
  const action = String(payload.action || "").trim();
  const candidateKey = String(payload.candidateKey || "").trim();
  const companyIds = Array.isArray(payload.companyIds) ? payload.companyIds.map((value) => String(value || "").trim()) : [];
  const master = await readCompanyMaster();
  if (action === "separate") {
    if (!candidateKey) {
      const error = new Error("분리 유지할 후보 키가 없습니다.");
      error.statusCode = 400;
      throw error;
    }
    master.duplicateResolutions[candidateKey] = "separate";
    await writeCompanyMaster(master);
    return { ...(await summarizeCompanyMaster()), resolved: { action, candidateKey } };
  }
  if (action === "merge") {
    const target = mergeCompanyRecords(master, companyIds, candidateKey);
    await writeCompanyMaster(master);
    return { ...(await summarizeCompanyMaster()), resolved: { action, candidateKey, companyId: target.companyId } };
  }
  const error = new Error("지원하지 않는 중복 처리 방식입니다.");
  error.statusCode = 400;
  throw error;
}

async function saveCompanyManualCorrection(payload = {}) {
  const companyId = String(payload.companyId || "").trim();
  const master = await readCompanyMaster();
  const company = master.companies?.[companyId];
  if (!company) {
    const error = new Error("수동 보정할 업체를 찾지 못했습니다.");
    error.statusCode = 404;
    throw error;
  }
  if (payload.active === false) {
    company.manualCorrection = null;
  } else {
    const lodgingBasisTotal = Number(payload.lodgingBasisTotal);
    const dayUseBasisTotal = Number(payload.dayUseBasisTotal);
    company.manualCorrection = {
      active: true,
      lodgingBasisTotal: Number.isFinite(lodgingBasisTotal) && lodgingBasisTotal > 0 ? Math.round(lodgingBasisTotal) : null,
      dayUseBasisTotal: Number.isFinite(dayUseBasisTotal) && dayUseBasisTotal > 0 ? Math.round(dayUseBasisTotal) : null,
      note: String(payload.note || "").trim(),
      source: "admin",
      updatedAt: new Date().toISOString()
    };
  }
  company.duplicateNotes = [
    ...(company.duplicateNotes || []),
    {
      at: new Date().toISOString(),
      reason: payload.active === false ? "수동 보정 해제" : "수동 보정 저장"
    }
  ].slice(-40);
  await writeCompanyMaster(master);
  return {
    ...(await summarizeCompanyMaster()),
    company: companyRecordSummary(company),
    resolved: { action: payload.active === false ? "clearManualCorrection" : "saveManualCorrection", companyId }
  };
}

async function upsertCompanyMasterForRun(data, collectedAt) {
  const master = await readCompanyMaster();
  const run = data?.run || {};
  const keywordKey = compactKeyword(run.keyword || run.label || "").toLowerCase();
  const items = data?.availability?.items || [];
  const beforeSnapshot = JSON.stringify({
    companies: master.companies,
    sourceIndex: master.sourceIndex,
    duplicateResolutions: master.duplicateResolutions
  });
  let touched = 0;

  for (let index = 0; index < items.length; index += 1) {
    const entity = companyEntityFromItem(items[index], run, collectedAt);
    if (!entity.nameKey || !entity.sourceKeys.length) continue;
    const company = upsertCompanyRecord(master, entity);
    touched += 1;
    const correctedItem = applyCompanyManualCorrection(items[index], company);
    items[index] = {
      ...correctedItem,
      companyId: company.companyId,
      companyProfile: companyRecordSummary(company, keywordKey)
    };
  }

  const afterSnapshot = JSON.stringify({
    companies: master.companies,
    sourceIndex: master.sourceIndex,
    duplicateResolutions: master.duplicateResolutions
  });
  if (touched && beforeSnapshot !== afterSnapshot) await writeCompanyMaster(master);
  const duplicateCandidates = findCompanyDuplicateCandidates(master);
  return {
    file: "company_master/companies.json",
    totalCompanies: Object.keys(master.companies || {}).length,
    currentRunCompanies: touched,
    duplicateCandidateCount: duplicateCandidates.length,
    duplicateCandidates,
    updatedAt: master.updatedAt || "",
    principle: "네이버 place_id/예약ID 우선, 그 다음 업체명+주소/지역으로 동일 업체를 병합"
  };
}

async function summarizeCompanyMaster() {
  const master = await readCompanyMaster();
  const duplicateCandidates = findCompanyDuplicateCandidates(master);
  const companies = Object.values(master.companies || {})
    .map((company) => companyRecordSummary(company))
    .sort((a, b) => String(b.lastSeenAt || "").localeCompare(String(a.lastSeenAt || "")));
  const profiledCompanies = companies.map(companySalesTargetProfile);
  const salesTargets = summarizeCompanySalesTargets(profiledCompanies);
  return {
    file: "company_master/companies.json",
    totalCompanies: Object.keys(master.companies || {}).length,
    sourceKeyCount: Object.keys(master.sourceIndex || {}).length,
    duplicateCandidateCount: duplicateCandidates.length,
    duplicateCandidates,
    crossKeyword: summarizeCompanyCrossKeyword(master),
    salesTargets,
    updatedAt: master.updatedAt || "",
    principle: "네이버 place_id/예약ID 우선, 그 다음 업체명+주소/지역으로 동일 업체를 병합",
    companies: profiledCompanies.slice(0, 300)
  };
}

async function backfillCompanyMasterFromRuns(payload = {}) {
  const requestedRunIds = Array.isArray(payload.runIds)
    ? new Set(payload.runIds.map((value) => String(value || "").trim()).filter(Boolean))
    : null;
  const limit = Number(payload.limit);
  const runs = (await listRuns())
    .filter((run) => !requestedRunIds || requestedRunIds.has(run.id))
    .sort((a, b) => String(a.updatedAt || "").localeCompare(String(b.updatedAt || "")))
    .slice(0, Number.isFinite(limit) && limit > 0 ? Math.min(500, Math.round(limit)) : undefined);
  const startedAt = new Date().toISOString();
  const processed = [];
  const failed = [];
  let touchedCompanies = 0;

  for (const run of runs) {
    try {
      const data = await loadRun(run.id, { skipHistory: true });
      const currentRunCompanies = Number(data?.companyMaster?.currentRunCompanies || 0);
      touchedCompanies += currentRunCompanies;
      processed.push({
        runId: run.id,
        label: run.label || run.id,
        updatedAt: run.updatedAt,
        currentRunCompanies,
        totalCompanies: data?.companyMaster?.totalCompanies || 0
      });
    } catch (error) {
      failed.push({
        runId: run.id,
        label: run.label || run.id,
        message: error.message || String(error)
      });
    }
  }

  return {
    ...(await summarizeCompanyMaster()),
    backfill: {
      startedAt,
      finishedAt: new Date().toISOString(),
      requestedRuns: runs.length,
      processedRuns: processed.length,
      failedRuns: failed.length,
      touchedCompanies,
      runs: processed.slice(-30).reverse(),
      failed
    }
  };
}

function buildHistoryObservations(data, collectedAt) {
  const run = data?.run || {};
  const checkIn = run.checkIn || runDateFromId(run.id) || kstDate(0);
  const collectedDate = String(collectedAt || "").slice(0, 10) || runDateFromId(run.id) || kstDate(0);
  const keyword = run.keyword || run.label || "";
  const keywordKey = compactKeyword(keyword).toLowerCase();
  const items = data?.availability?.items || [];
  const observations = [];

  for (const item of items) {
    const companyKey = item.companyId || compactKeyword(item.name || "").toLowerCase();
    if (!companyKey) continue;

    for (const productType of ["lodging", "dayuse"]) {
      const series = historySeriesForItem(item, productType, checkIn);
      for (const row of series) {
        const total = normalizeObservationNumber(row.total);
        const available = normalizeObservationNumber(row.available);
        if (total === null || available === null || total <= 0) continue;
        const sold = Math.max(0, total - Math.max(0, available));
        const leadTimeDays = dateDiffDays(collectedDate, row.stayDate);
        const observationId = stableHash([
          run.id,
          keywordKey,
          companyKey,
          productType,
          row.stayDate
        ].join("|"));

        observations.push({
          schemaVersion: 1,
          observationId,
          runId: run.id,
          runLabel: run.label || "",
          keyword,
          keywordKey,
          searchMode: run.searchMode || "",
          productMode: run.productMode || "",
          collectedAt,
          collectedDate,
          stayDate: row.stayDate,
          leadTimeDays,
          companyName: item.name || "",
          companyKey,
          region: item.region || "",
          rank: item.rank ?? null,
          productType,
          supply: total,
          available: Math.max(0, available),
          sold,
          saleRate: total ? Number((sold / total).toFixed(4)) : null,
          price: item.price || "",
          listType: item.listType || "",
          inventoryScope: item.inventoryScope || "",
          inventoryMemo: item.inventoryMemo || "",
          inventoryConfidenceGrade: item.inventoryConfidenceGrade || "",
          inventoryConfidenceScore: item.inventoryConfidenceScore ?? null,
          inventoryAlerts: item.inventoryAlerts || [],
          sourceUrl: item.url || "",
          rawLabel: row.label || ""
        });
      }
    }
  }

  return observations;
}

async function readHistoryObservations() {
  try {
    const text = await fsp.readFile(HISTORY_OBSERVATIONS_FILE, "utf8");
    const deduped = new Map();
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line);
        if (row?.observationId) deduped.set(row.observationId, row);
      } catch {
        // Keep reading even if one historical line was partially written.
      }
    }
    return [...deduped.values()];
  } catch {
    return [];
  }
}

async function appendHistoryForRun(runId) {
  const dirPath = resolveRunDir(runId);
  if (!dirPath || !fs.existsSync(dirPath)) return { appended: 0, reason: "run_not_found" };
  const stat = await fsp.stat(dirPath);
  const collectedAt = stat.mtime.toISOString();
  const data = await loadRun(runId, { skipHistory: true });
  const observations = buildHistoryObservations(data, collectedAt);
  if (!observations.length) return { appended: 0, reason: "no_observations" };
  await fsp.mkdir(HISTORY_DIR, { recursive: true });
  await fsp.appendFile(
    HISTORY_OBSERVATIONS_FILE,
    `${observations.map((row) => JSON.stringify(row)).join("\n")}\n`,
    "utf8"
  );
  return { appended: observations.length, file: "history/observations.jsonl" };
}

function historyDayIndex(dateText) {
  const date = new Date(`${dateText}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? null : date.getUTCDay();
}

function createHistoryBucket(label = "") {
  return {
    label,
    observations: 0,
    sold: 0,
    supply: 0,
    available: 0,
    runIds: new Set(),
    companyKeys: new Set()
  };
}

function addHistoryObservation(bucket, row) {
  const supply = Number(row.supply || 0);
  if (!Number.isFinite(supply) || supply <= 0) return;
  bucket.observations += 1;
  bucket.sold += Number(row.sold || 0);
  bucket.supply += supply;
  bucket.available += Number(row.available || 0);
  if (row.runId) bucket.runIds.add(row.runId);
  if (row.companyKey) bucket.companyKeys.add(row.companyKey);
}

function finalizeHistoryBucket(bucket) {
  return {
    label: bucket.label,
    observations: bucket.observations,
    sold: bucket.sold,
    supply: bucket.supply,
    available: bucket.available,
    saleRate: bucket.supply ? Number((bucket.sold / bucket.supply).toFixed(4)) : null,
    runCount: bucket.runIds.size,
    companyCount: bucket.companyKeys.size
  };
}

function summarizeHistoryBenchmarks(observations) {
  const dayLabels = ["일", "월", "화", "수", "목", "금", "토"];
  const lodgingRows = observations.filter((row) => row.productType === "lodging");
  const weekdayBucket = createHistoryBucket("누적 평일");
  const allBucket = createHistoryBucket("누적 전체");
  const dayBuckets = new Map();
  const companyBuckets = new Map();

  for (const row of lodgingRows) {
    const dayIndex = historyDayIndex(row.stayDate);
    if (dayIndex === null) continue;
    addHistoryObservation(allBucket, row);

    if (!dayBuckets.has(dayIndex)) dayBuckets.set(dayIndex, createHistoryBucket(dayLabels[dayIndex]));
    addHistoryObservation(dayBuckets.get(dayIndex), row);

    if (dayIndex >= 1 && dayIndex <= 4) {
      addHistoryObservation(weekdayBucket, row);
      const key = row.companyKey || "";
      if (key) {
        if (!companyBuckets.has(key)) {
          companyBuckets.set(key, {
            companyName: row.companyName || "",
            weekday: createHistoryBucket("누적 평일"),
            all: createHistoryBucket("누적 전체")
          });
        }
        addHistoryObservation(companyBuckets.get(key).weekday, row);
      }
    }

    const key = row.companyKey || "";
    if (key) {
      if (!companyBuckets.has(key)) {
        companyBuckets.set(key, {
          companyName: row.companyName || "",
          weekday: createHistoryBucket("누적 평일"),
          all: createHistoryBucket("누적 전체")
        });
      }
      addHistoryObservation(companyBuckets.get(key).all, row);
    }
  }

  const companyBenchmarks = {};
  for (const [key, buckets] of companyBuckets.entries()) {
    companyBenchmarks[key] = {
      companyName: buckets.companyName,
      weekday: finalizeHistoryBucket(buckets.weekday),
      all: finalizeHistoryBucket(buckets.all)
    };
  }

  return {
    all: finalizeHistoryBucket(allBucket),
    weekday: finalizeHistoryBucket(weekdayBucket),
    byDay: [...dayBuckets.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([dayIndex, bucket]) => ({
        dayIndex,
        ...finalizeHistoryBucket(bucket)
      })),
    companyBenchmarks
  };
}

function summarizeHistoryTimeline(observations) {
  const dateBuckets = new Map();
  const lodgingRows = observations.filter((row) => row.productType === "lodging");

  for (const row of lodgingRows) {
    const collectedDate = String(row.collectedDate || row.collectedAt || "").slice(0, 10);
    if (!collectedDate) continue;
    const bucket = dateBuckets.get(collectedDate) || {
      collectedDate,
      observations: 0,
      sold: 0,
      supply: 0,
      available: 0,
      runIds: new Set(),
      companyKeys: new Set()
    };
    bucket.observations += 1;
    bucket.sold += Number(row.sold || 0);
    bucket.supply += Number(row.supply || 0);
    bucket.available += Number(row.available || 0);
    if (row.runId) bucket.runIds.add(row.runId);
    if (row.companyKey) bucket.companyKeys.add(row.companyKey);
    dateBuckets.set(collectedDate, bucket);
  }

  return [...dateBuckets.values()]
    .sort((a, b) => a.collectedDate.localeCompare(b.collectedDate))
    .map((bucket) => ({
      collectedDate: bucket.collectedDate,
      observations: bucket.observations,
      sold: bucket.sold,
      supply: bucket.supply,
      available: bucket.available,
      saleRate: bucket.supply ? Number((bucket.sold / bucket.supply).toFixed(4)) : null,
      runCount: bucket.runIds.size,
      companyCount: bucket.companyKeys.size
    }));
}

function summarizeHistoryOpsForKeyword(keywordBucket) {
  const timeline = [...keywordBucket.dateBuckets.values()]
    .sort((a, b) => a.collectedDate.localeCompare(b.collectedDate))
    .map((bucket) => ({
      collectedDate: bucket.collectedDate,
      observations: bucket.observations,
      sold: bucket.sold,
      supply: bucket.supply,
      saleRate: bucket.supply ? Number((bucket.sold / bucket.supply).toFixed(4)) : null,
      runCount: bucket.runIds.size,
      companyCount: bucket.companyKeys.size
    }));

  const latest = timeline.at(-1) || null;
  const previous = timeline.length > 1 ? timeline.at(-2) : null;
  const comparison = latest && previous
    ? {
        previousDate: previous.collectedDate,
        latestDate: latest.collectedDate,
        saleRateDelta: Number(((latest.saleRate || 0) - (previous.saleRate || 0)).toFixed(4)),
        soldDelta: latest.sold - previous.sold,
        supplyDelta: latest.supply - previous.supply,
        companyDelta: latest.companyCount - previous.companyCount
      }
    : null;

  const companyTrends = [...keywordBucket.companyBuckets.values()]
    .map((bucket) => {
      const byDate = [...bucket.dateBuckets.values()]
        .sort((a, b) => a.collectedDate.localeCompare(b.collectedDate))
        .map((dateBucket) => ({
          collectedDate: dateBucket.collectedDate,
          sold: dateBucket.sold,
          supply: dateBucket.supply,
          saleRate: dateBucket.supply ? Number((dateBucket.sold / dateBucket.supply).toFixed(4)) : null,
          observations: dateBucket.observations
        }));
      const rates = byDate.map((row) => row.saleRate).filter((value) => Number.isFinite(value));
      return {
        companyName: bucket.companyName,
        companyKey: bucket.companyKey,
        observations: bucket.observations,
        sold: bucket.sold,
        supply: bucket.supply,
        saleRate: bucket.supply ? Number((bucket.sold / bucket.supply).toFixed(4)) : null,
        runCount: bucket.runIds.size,
        dateCount: bucket.dateBuckets.size,
        latest: byDate.at(-1) || null,
        minRate: rates.length ? Math.min(...rates) : null,
        maxRate: rates.length ? Math.max(...rates) : null,
        volatility: rates.length ? Number((Math.max(...rates) - Math.min(...rates)).toFixed(4)) : null,
        byDate: byDate.slice(-8)
      };
    })
    .sort((a, b) => (b.volatility || 0) - (a.volatility || 0) || b.observations - a.observations)
    .slice(0, 12);

  return {
    keyword: keywordBucket.keyword,
    keywordKey: keywordBucket.keywordKey,
    observations: keywordBucket.observations,
    lodgingObservations: keywordBucket.lodgingObservations,
    dayUseObservations: keywordBucket.dayUseObservations,
    runCount: keywordBucket.runIds.size,
    companyCount: keywordBucket.companyKeys.size,
    dateCount: keywordBucket.dateBuckets.size,
    firstCollectedDate: timeline[0]?.collectedDate || "",
    latestCollectedDate: latest?.collectedDate || "",
    sold: keywordBucket.sold,
    supply: keywordBucket.supply,
    saleRate: keywordBucket.supply ? Number((keywordBucket.sold / keywordBucket.supply).toFixed(4)) : null,
    timeline: timeline.slice(-10),
    comparison,
    companyTrends
  };
}

async function summarizeHistoryOperations() {
  const observations = await readHistoryObservations();
  const keywordBuckets = new Map();
  const runIds = new Set();
  const companyKeys = new Set();

  for (const row of observations) {
    const keywordKey = String(row.keywordKey || compactKeyword(row.keyword || "")).toLowerCase();
    if (!keywordKey) continue;
    runIds.add(row.runId);
    if (row.companyKey) companyKeys.add(row.companyKey);

    if (!keywordBuckets.has(keywordKey)) {
      keywordBuckets.set(keywordKey, {
        keyword: row.keyword || keywordKey,
        keywordKey,
        observations: 0,
        lodgingObservations: 0,
        dayUseObservations: 0,
        sold: 0,
        supply: 0,
        runIds: new Set(),
        companyKeys: new Set(),
        dateBuckets: new Map(),
        companyBuckets: new Map()
      });
    }

    const bucket = keywordBuckets.get(keywordKey);
    bucket.keyword = bucket.keyword || row.keyword || keywordKey;
    bucket.observations += 1;
    if (row.productType === "lodging") bucket.lodgingObservations += 1;
    if (row.productType === "dayuse") bucket.dayUseObservations += 1;
    if (row.runId) bucket.runIds.add(row.runId);
    if (row.companyKey) bucket.companyKeys.add(row.companyKey);

    const supply = Number(row.supply || 0);
    const sold = Number(row.sold || 0);
    if (row.productType === "lodging" && Number.isFinite(supply) && supply > 0) {
      bucket.sold += Number.isFinite(sold) ? sold : 0;
      bucket.supply += supply;
      const collectedDate = String(row.collectedDate || row.collectedAt || "").slice(0, 10) || "unknown";
      const dateBucket = bucket.dateBuckets.get(collectedDate) || {
        collectedDate,
        observations: 0,
        sold: 0,
        supply: 0,
        runIds: new Set(),
        companyKeys: new Set()
      };
      dateBucket.observations += 1;
      dateBucket.sold += Number.isFinite(sold) ? sold : 0;
      dateBucket.supply += supply;
      if (row.runId) dateBucket.runIds.add(row.runId);
      if (row.companyKey) dateBucket.companyKeys.add(row.companyKey);
      bucket.dateBuckets.set(collectedDate, dateBucket);

      if (row.companyKey) {
        const companyBucket = bucket.companyBuckets.get(row.companyKey) || {
          companyName: row.companyName || "",
          companyKey: row.companyKey,
          observations: 0,
          sold: 0,
          supply: 0,
          runIds: new Set(),
          dateBuckets: new Map()
        };
        companyBucket.companyName = companyBucket.companyName || row.companyName || row.companyKey;
        companyBucket.observations += 1;
        companyBucket.sold += Number.isFinite(sold) ? sold : 0;
        companyBucket.supply += supply;
        if (row.runId) companyBucket.runIds.add(row.runId);
        const companyDateBucket = companyBucket.dateBuckets.get(collectedDate) || {
          collectedDate,
          observations: 0,
          sold: 0,
          supply: 0
        };
        companyDateBucket.observations += 1;
        companyDateBucket.sold += Number.isFinite(sold) ? sold : 0;
        companyDateBucket.supply += supply;
        companyBucket.dateBuckets.set(collectedDate, companyDateBucket);
        bucket.companyBuckets.set(row.companyKey, companyBucket);
      }
    }
  }

  const keywords = [...keywordBuckets.values()]
    .map(summarizeHistoryOpsForKeyword)
    .sort((a, b) => (b.latestCollectedDate || "").localeCompare(a.latestCollectedDate || "") || b.observations - a.observations);

  return {
    generatedAt: new Date().toISOString(),
    storage: "jsonl",
    file: "history/observations.jsonl",
    overall: {
      keywordCount: keywords.length,
      observationCount: observations.length,
      runCount: runIds.size,
      companyCount: companyKeys.size,
      latestCollectedAt: observations.map((row) => row.collectedAt).filter(Boolean).sort().at(-1) || ""
    },
    keywords
  };
}

async function summarizeHistoryForRun(data) {
  const run = data?.run || {};
  const keywordKey = compactKeyword(run.keyword || run.label || "").toLowerCase();
  if (!keywordKey) return { enabled: true, observationCount: 0, runCount: 0, currentRunObservationCount: 0 };
  const observations = (await readHistoryObservations()).filter((row) => row.keywordKey === keywordKey);
  const currentRunObservationCount = observations.filter((row) => row.runId === run.id).length;
  const runIds = new Set(observations.map((row) => row.runId).filter(Boolean));
  const companyKeys = new Set(observations.map((row) => row.companyKey).filter(Boolean));
  const leadBuckets = new Map();

  for (const row of observations) {
    if (!Number.isFinite(row.leadTimeDays) || !Number.isFinite(row.supply) || row.supply <= 0) continue;
    const bucket = leadBuckets.get(row.leadTimeDays) || {
      leadTimeDays: row.leadTimeDays,
      observations: 0,
      sold: 0,
      supply: 0,
      available: 0
    };
    bucket.observations += 1;
    bucket.sold += Number(row.sold || 0);
    bucket.supply += Number(row.supply || 0);
    bucket.available += Number(row.available || 0);
    leadBuckets.set(row.leadTimeDays, bucket);
  }

  const leadTime = [...leadBuckets.values()]
    .sort((a, b) => b.leadTimeDays - a.leadTimeDays)
    .map((bucket) => ({
      ...bucket,
      saleRate: bucket.supply ? Number((bucket.sold / bucket.supply).toFixed(4)) : null
    }));
  const benchmarks = summarizeHistoryBenchmarks(observations);
  const timeline = summarizeHistoryTimeline(observations);

  return {
    enabled: true,
    storage: "jsonl",
    file: "history/observations.jsonl",
    keyword: run.keyword || "",
    observationCount: observations.length,
    currentRunObservationCount,
    runCount: runIds.size,
    companyCount: companyKeys.size,
    latestCollectedAt: observations.map((row) => row.collectedAt).filter(Boolean).sort().at(-1) || "",
    canAnalyzeLeadTime: runIds.size >= 2,
    leadTime,
    benchmarks,
    timeline
  };
}

function availabilityPlaceKey(row) {
  const explicit = row.place_id || row["place_id"];
  if (explicit) return `place:${explicit}`;

  const urlText = `${row.url || ""} ${row["네이버예약URL"] || ""}`;
  const placeMatch = urlText.match(/\/accommodation\/(\d+)/);
  if (placeMatch) return `place:${placeMatch[1]}`;

  const bookingMatch = urlText.match(/\/bizes\/(\d+)/);
  if (bookingMatch) return `booking:${bookingMatch[1]}`;

  const name = compactKeyword(row["업체명"] || row.name || "");
  const region = compactKeyword(row["소재지클러스터"] || row["검색클러스터"] || row["지역"] || row["주소"] || row.location || "");
  return name ? `name:${name}:${region}` : "";
}

function availabilityBookingBusinessId(row = {}) {
  return extractBookingBusinessId({
    ...row,
    naverBookingUrl: row["네이버예약URL"] || row.naverBookingUrl || ""
  });
}

function summarizeAvailabilityRows(rows) {
  const byPlace = new Map();
  for (const row of rows) {
    const availableRooms = numericField(row, ["숙박예약가능수", "예약가능객실수", "availableRooms"]);
    const totalRooms = numericField(row, ["숙박확인재고수", "확인객실수", "totalRooms"]);
    const rate = numericField(row, ["숙박예약가능률", "예약가능률", "availabilityRate"]);
    if (availableRooms === null || totalRooms === null || totalRooms <= 0) continue;
    const soldOutRooms = numericField(row, ["숙박판매완료수", "soldOutRooms"]);
    const soldOutRate = numericField(row, ["숙박판매완료율", "soldOutRate"]);
    const resolvedSoldOutRooms = soldOutRooms !== null ? soldOutRooms : Math.max(0, totalRooms - availableRooms);
    const weeklyDays = numericField(row, ["주간재고수집일수", "weeklyDays"]);
    const weeklyDetail = row["주간잔여상세"] || "";
    const weeklySummary = weeklyDetail
      ? (weeklyDays ? `${weeklyDays}일 날짜별 잔여` : "날짜별 잔여")
      : row["주간잔여요약"] || "";
    const derivedWeeklyRates = parseWeeklyReservationRates(weeklyDetail);
    const weeklyAvgReservationRate = numericField(row, ["주간평균예약률", "weeklyAvgReservationRate"]) ?? derivedWeeklyRates.average;
    const weeklyReservationRateDetail = row["주간예약률상세"] || derivedWeeklyRates.detail;
    const weeklyTotalSoldOut = numericField(row, ["주간판매수량합계", "weeklyTotalSoldOut"]) ?? derivedWeeklyRates.totalSoldOut;
    const weeklyTotalStock = numericField(row, ["주간전체수량합계", "weeklyTotalStock"]) ?? derivedWeeklyRates.totalStock;
    const weeklyBasisTotal = numericField(row, ["주간기준재고수", "weeklyBasisTotal"]);
    const weeklyRawStockVariance = row["주간원시재고변동"] || "";
    const dayUseWeeklyDetail = row.dayUseWeeklyDetail || "";
    const derivedDayUseWeeklyRates = parseWeeklyReservationRates(dayUseWeeklyDetail);
    const dayUseWeeklyAvgReservationRate = numericField(row, ["dayUseWeeklyAvgReservationRate"]) ?? derivedDayUseWeeklyRates.average;
    const dayUseWeeklyReservationRateDetail = row.dayUseWeeklyReservationRateDetail || derivedDayUseWeeklyRates.detail;
    const dayUseWeeklyTotalSoldOut = numericField(row, ["dayUseWeeklyTotalSoldOut"]) ?? derivedDayUseWeeklyRates.totalSoldOut;
    const dayUseWeeklyTotalStock = numericField(row, ["dayUseWeeklyTotalStock"]) ?? derivedDayUseWeeklyRates.totalStock;

    const key = availabilityPlaceKey(row);
    if (!key || byPlace.has(key)) continue;
    const placeId = extractNaverPlaceId(row);
    const bookingBusinessId = availabilityBookingBusinessId(row);

    byPlace.set(key, {
      sourceKey: key,
      placeId,
      place_id: placeId,
      bookingBusinessId,
      rank: numericField(row, ["overall_rank", "순위", "rank_or_order"]) || byPlace.size + 1,
      name: row["업체명"] || row.name || "확인불가",
      region: row["소재지클러스터"] || row["검색클러스터"] || row["지역"] || "",
      address: row["주소"] || row.location || "",
      listType: row["예약리스트유형"] || "",
      productTypeSummary: row["네이버상품구성"] || "",
      nightItemCount: numericField(row, ["숙박상품수"]),
      dayUseItemCount: numericField(row, ["데이유즈상품수"]),
      countedItemCount: numericField(row, ["예약계산대상상품수"]),
      availableRooms,
      totalRooms,
      nightAvailableStock: availableRooms,
      nightTotalStock: totalRooms,
      soldOutRooms: resolvedSoldOutRooms,
      soldOutRate: soldOutRate !== null ? soldOutRate : Number((resolvedSoldOutRooms / totalRooms).toFixed(3)),
      availabilityUnit: row["예약계산단위"] || "",
      rawAvailableStock: numericField(row, ["네이버원시예약가능재고", "rawAvailableStock"]),
      rawTotalStock: numericField(row, ["네이버원시전체재고", "rawTotalStock"]),
      groupedRoomCount: numericField(row, ["네이버묶음객실범위수", "groupedRoomCount"]),
      weeklyDays,
      weeklySummary,
      weeklyAvgAvailable: numericField(row, ["주간평균잔여수", "weeklyAvgAvailable"]),
      weeklyMinAvailable: numericField(row, ["주간최소잔여수", "weeklyMinAvailable"]),
      weeklySoldOutDays: numericField(row, ["주간마감일수", "weeklySoldOutDays"]),
      weeklyTotalSoldOut,
      weeklyTotalStock,
      weeklyBasisTotal,
      weeklyRawStockVariance,
      weeklyDetail,
      weeklyAvgReservationRate,
      weeklyReservationRateDetail,
      dayUseAvailableStock: numericField(row, ["데이유즈예약가능수"]),
      dayUseTotalStock: numericField(row, ["데이유즈확인재고수"]),
      dayUseWeeklyDays: numericField(row, ["dayUseWeeklyDays"]),
      dayUseWeeklySummary: row.dayUseWeeklySummary || "",
      dayUseWeeklyAvgAvailable: numericField(row, ["dayUseWeeklyAvgAvailable"]),
      dayUseWeeklyMinAvailable: numericField(row, ["dayUseWeeklyMinAvailable"]),
      dayUseWeeklySoldOutDays: numericField(row, ["dayUseWeeklySoldOutDays"]),
      dayUseWeeklyTotalSoldOut,
      dayUseWeeklyTotalStock,
      dayUseWeeklyBasisTotal: numericField(row, ["dayUseWeeklyBasisTotal"]),
      dayUseWeeklyRawStockVariance: row.dayUseWeeklyRawStockVariance || "",
      dayUseWeeklyDetail,
      dayUseWeeklyAvgReservationRate,
      dayUseWeeklyReservationRateDetail,
      inventoryScope: row["네이버재고범위"] || "네이버예약 채널/날짜 기준 재고",
      inventoryMemo: normalizeInventoryMemo(row["객실수검증메모"], row["예약리스트유형"]),
      rate: rate !== null ? rate : Number((availableRooms / totalRooms).toFixed(3)),
      price: row["예약최저가"] || row["금액"] || row.price || "",
      basis: row["예약가능근거"] || row["네이버예약재고수집상태"] || "",
      url: row.url || row["네이버예약URL"] || ""
    });
  }

  const items = [...byPlace.values()]
    .map((item) => {
      const confidence = evaluateInventoryConfidence({
        availableRooms: item.availableRooms,
        totalRooms: item.totalRooms,
        countedItemCount: item.countedItemCount,
        weeklyDays: item.weeklyDays,
        weeklyDetail: item.weeklyDetail,
        weeklyRawStockVariance: item.weeklyRawStockVariance,
        listType: item.listType,
        rawTotalStock: item.rawTotalStock,
        groupedRoomCount: item.groupedRoomCount,
        dayUseTotalStock: item.dayUseTotalStock,
        dayUseItemCount: item.dayUseItemCount,
        dayUseWeeklyRawStockVariance: item.dayUseWeeklyRawStockVariance,
        inventoryMemo: item.inventoryMemo
      });
      return {
        ...item,
        inventoryConfidence: confidence,
        inventoryStructure: confidence.structure,
        inventoryStructureType: confidence.structure.type,
        inventoryStructureLabel: confidence.structure.label,
        inventoryStructureTone: confidence.structure.tone,
        inventoryStructureSummary: confidence.structure.summary,
        inventoryStructureFlags: confidence.structure.flags,
        inventoryStructureNotes: confidence.structure.notes,
        inventoryStructureAction: confidence.structure.action,
        inventoryConfidenceGrade: confidence.grade,
        inventoryConfidenceLabel: confidence.label,
        inventoryConfidenceScore: confidence.score,
        inventoryConfidenceSummary: confidence.summary,
        inventoryConfidenceReasons: confidence.reasons,
        inventoryAlerts: confidence.alerts
      };
    })
    .sort((a, b) => a.rank - b.rank);
  const totalAvailableRooms = items.reduce((sum, item) => sum + item.availableRooms, 0);
  const totalRooms = items.reduce((sum, item) => sum + item.totalRooms, 0);
  const totalSoldOutRooms = items.reduce((sum, item) => sum + item.soldOutRooms, 0);
  return {
    stats: {
      checkedPlaces: items.length,
      totalAvailableRooms,
      totalSoldOutRooms,
      totalRooms,
      weightedRate: totalRooms ? Number((totalAvailableRooms / totalRooms).toFixed(3)) : null,
      weightedSoldOutRate: totalRooms ? Number((totalSoldOutRooms / totalRooms).toFixed(3)) : null,
      lowAvailabilityCount: items.filter((item) => item.rate < 0.7).length,
      lowConfidenceCount: items.filter((item) => ["D", "E"].includes(item.inventoryConfidenceGrade)).length,
      stockVarianceCount: items.filter((item) => (item.inventoryStructureFlags || []).includes("dynamic_capacity")).length,
      dayUseMixedCount: items.filter((item) => (item.inventoryStructureFlags || []).includes("dayuse_rotation")).length,
      bookingIdReusedCount: items.filter((item) => (item.inventoryStructureFlags || []).includes("booking_id_reused")).length,
      confidenceCounts: items.reduce((acc, item) => {
        const grade = item.inventoryConfidenceGrade || "C";
        acc[grade] = (acc[grade] || 0) + 1;
        return acc;
      }, {}),
      inventoryStructureCounts: items.reduce((acc, item) => {
        const label = item.inventoryStructureLabel || "구조 확인필요";
        acc[label] = (acc[label] || 0) + 1;
        return acc;
      }, {})
    },
    items: items.slice(0, 30)
  };
}

function platformRowGroup(row, platform, statusValue, reasonValue, directionValue, adValue) {
  const failed = statusValue.includes("실패") || statusValue.includes("차단") || reasonValue.length > 0;
  const manual = !failed && (
    statusValue.includes("수동") ||
    String(row["수집방식"] || row.collectionMethod || "").includes("수동") ||
    directionValue.includes("수동")
  );
  const ad = !failed && (
    adValue === "Y" ||
    adValue.includes("광고 집행") ||
    adValue.includes("광고+비광고") ||
    (statusValue.includes("광고") && !statusValue.includes("비광고"))
  );
  const organic = !failed && !manual && !ad && (
    adValue === "N" ||
    statusValue.includes("비광고") ||
    statusValue.includes("검색결과") ||
    platform === "떠나요" ||
    platform === "야놀자/NOL"
  );
  return failed ? "실패" : manual ? "수동" : ad ? "광고" : organic ? "비광고" : "기타";
}

function summarizeCompanyPlatforms(rows) {
  const companies = new Map();

  for (const row of rows) {
    const name = String(row["업체명"] || row.name || "").trim();
    if (!name || name.includes("Cloudflare")) continue;

    const key = companyPlatformKey(name);
    if (!key) continue;

    const platform = row["플랫폼"] || row.channel || "확인불가";
    const statusValue = String(row["수집 상태"] || row.status || row.section || "");
    const rawReasonValue = String(row["실패 원인"] || row.reason || "");
    const inferredYeogiReason =
      platform === "여기어때" && statusValue.includes("차단")
        ? "Cloudflare/WAF 차단"
        : "";
    const reasonValue = rawReasonValue || inferredYeogiReason;
    const directionValue = String(row["수집 방향"] || row.collectionDirection || row.collection_direction || "");
    const adValue = String(row["광고 여부"] || row["광고클러스터"] || row.ad_flag || row["광고집행클러스터"] || "");
    const group = platformRowGroup(row, platform, statusValue, reasonValue, directionValue, adValue);

    if (!companies.has(key)) {
      companies.set(key, {
        key,
        name,
        bestRank: 9999,
        platforms: []
      });
    }

    const company = companies.get(key);
    const rank = numericField(row, ["순위", "rank_or_order", "overall_rank", "ad_order"]);
    if (rank !== null) company.bestRank = Math.min(company.bestRank, rank);

    const available = row["숙박예약가능수"] || row["예약가능객실수"] || "";
    const total = row["숙박확인재고수"] || row["확인객실수"] || "";
    const soldOut = row["숙박판매완료수"] || "";
    const unit = row["예약계산단위"] || "";
    const stock = available && total
      ? `잔여 ${available}/${total}${unit ? ` ${unit}` : ""}${soldOut ? ` · 마감 ${soldOut}/${total}` : ""}`
      : row["전체객실수확인상태"] || "";
    const weeklyDetail = row["주간잔여상세"] || "";
    const weeklyDays = numericField(row, ["주간재고수집일수", "weeklyDays"]);
    const weeklySummary = weeklyDetail
      ? (weeklyDays ? `${weeklyDays}일 날짜별 잔여` : "날짜별 잔여")
      : row["주간잔여요약"] || "";
    const derivedWeeklyRates = parseWeeklyReservationRates(weeklyDetail);
    const weeklyAvgReservationRate = numericField(row, ["주간평균예약률", "weeklyAvgReservationRate"]) ?? derivedWeeklyRates.average;
    const weeklyReservationRateDetail = row["주간예약률상세"] || derivedWeeklyRates.detail;
    const weeklyTotalSoldOut = numericField(row, ["주간판매수량합계", "weeklyTotalSoldOut"]) ?? derivedWeeklyRates.totalSoldOut;
    const weeklyTotalStock = numericField(row, ["주간전체수량합계", "weeklyTotalStock"]) ?? derivedWeeklyRates.totalStock;
    const weeklyBasisTotal = numericField(row, ["주간기준재고수", "weeklyBasisTotal"]);
    const weeklyRawStockVariance = row["주간원시재고변동"] || "";
    const dayUseWeeklyDetail = row.dayUseWeeklyDetail || "";
    const derivedDayUseWeeklyRates = parseWeeklyReservationRates(dayUseWeeklyDetail);
    const dayUseWeeklyAvgReservationRate = numericField(row, ["dayUseWeeklyAvgReservationRate"]) ?? derivedDayUseWeeklyRates.average;
    const dayUseWeeklyReservationRateDetail = row.dayUseWeeklyReservationRateDetail || derivedDayUseWeeklyRates.detail;
    const dayUseWeeklyTotalSoldOut = numericField(row, ["dayUseWeeklyTotalSoldOut"]) ?? derivedDayUseWeeklyRates.totalSoldOut;
    const dayUseWeeklyTotalStock = numericField(row, ["dayUseWeeklyTotalStock"]) ?? derivedDayUseWeeklyRates.totalStock;
    const weeklyStockText = weeklyDetail
      ? `${weeklyTotalSoldOut !== null ? `${weeklyDays || "기간"}일 마감추정 ${weeklyTotalSoldOut}${weeklyTotalStock ? `/${weeklyTotalStock}` : ""} · ` : ""}${weeklyBasisTotal ? `최대재고 ${weeklyBasisTotal} · ` : ""}${weeklyRawStockVariance ? `날짜별 원시재고: ${weeklyRawStockVariance} · ` : ""}${weeklyAvgReservationRate !== null ? `평균 예약률 ${formatRate(weeklyAvgReservationRate)} · ` : ""}${weeklyReservationRateDetail ? `날짜별 예약률: ${weeklyReservationRateDetail} · ` : ""}${weeklySummary ? `${weeklySummary}: ` : ""}${weeklyDetail}`
      : weeklySummary;
    const dayUseWeeklyStockText = dayUseWeeklyDetail
      ? `데이유즈/캠프닉 ${dayUseWeeklyTotalSoldOut !== null ? `${row.dayUseWeeklyDays || "기간"}일 마감추정 ${dayUseWeeklyTotalSoldOut}${dayUseWeeklyTotalStock ? `/${dayUseWeeklyTotalStock}` : ""} · ` : ""}${dayUseWeeklyAvgReservationRate !== null ? `평균 예약률 ${formatRate(dayUseWeeklyAvgReservationRate)} · ` : ""}${dayUseWeeklyReservationRateDetail ? `날짜별 예약률: ${dayUseWeeklyReservationRateDetail} · ` : ""}${dayUseWeeklyDetail}`
      : "";

    company.platforms.push({
      platform,
      rank: rank ?? "",
      group,
      price: row["예약최저가"] || row["가격"] || row.price || row["금액"] || "",
      status: statusValue || group,
      stock: [stock, weeklyStockText, dayUseWeeklyStockText].filter(Boolean).join(" · "),
      inventoryNote: row["네이버상품구성"] || row["채널재고해석"] || "",
      weeklySummary,
      weeklyDetail,
      weeklyAvgReservationRate,
      weeklyReservationRateDetail,
      weeklyTotalSoldOut,
      weeklyTotalStock,
      weeklyBasisTotal,
      weeklyRawStockVariance,
      dayUseWeeklyDays: numericField(row, ["dayUseWeeklyDays"]),
      dayUseWeeklySummary: row.dayUseWeeklySummary || "",
      dayUseWeeklyDetail,
      dayUseWeeklyAvgReservationRate,
      dayUseWeeklyReservationRateDetail,
      dayUseWeeklyTotalSoldOut,
      dayUseWeeklyTotalStock,
      dayUseWeeklyBasisTotal: numericField(row, ["dayUseWeeklyBasisTotal"]),
      dayUseWeeklyRawStockVariance: row.dayUseWeeklyRawStockVariance || "",
      dayUseWeeklyStockText,
      url: row.url || row["상품 URL"] || row["네이버예약URL"] || ""
    });
  }

  return [...companies.values()]
    .map((company) => ({
      ...company,
      bestRank: company.bestRank === 9999 ? null : company.bestRank,
      platforms: company.platforms
        .sort((a, b) => {
          const rankA = Number(a.rank || 9999);
          const rankB = Number(b.rank || 9999);
          if (rankA !== rankB) return rankA - rankB;
          return String(a.platform).localeCompare(String(b.platform), "ko");
        })
        .slice(0, 8)
    }))
    .sort((a, b) => (a.bestRank || 9999) - (b.bestRank || 9999))
    .slice(0, 40);
}

function resolveRunDir(runId) {
  const safeId = path.basename(runId);
  const dirPath = path.join(OUTPUTS_DIR, safeId);
  const relative = path.relative(OUTPUTS_DIR, dirPath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return dirPath;
}

async function loadRun(runId, options = {}) {
  const dirPath = resolveRunDir(runId);
  if (!dirPath || !fs.existsSync(dirPath)) return null;

  const stat = await fsp.stat(dirPath);
  const collectedAt = stat.mtime.toISOString();
  const files = await fsp.readdir(dirPath);
  const manifest = await readManifest(dirPath);
  const provinceKey = provinceKeyForRun(runId, manifest);
  const province = PROVINCES[provinceKey] || PROVINCES.local;
  const regionalFile = manifestFile(manifest, "regional", files, (file) => file.endsWith("_naver_place_glamping_clusters.csv"));
  const overallFile = manifestFile(manifest, "overall", files, (file) => file.endsWith("_overall_place_rank.csv"));
  const adFile = manifestFile(manifest, "ads", files, (file) => file.endsWith("_ad_place_list.csv"));
  const platformFile = manifestFile(manifest, "platform", files, (file) => file.endsWith("_glamping_crawl_test.csv"));
  const yeogiManualFile = manifestFile(manifest, "yeogiManual", files, (file) => file.endsWith("_yeogi_manual_import.csv"));
  const reportFile = manifestFile(manifest, "report", files, (file) => file.endsWith("_glamping_crawl_test_report.md"));
  const conditions = await readRunConditions(dirPath, manifest, reportFile);

  const regionalRows = regionalFile
    ? parseCsv((await fsp.readFile(path.join(dirPath, regionalFile), "utf8")).replace(/^\uFEFF/, ""))
    : [];
  const overallRows = overallFile
    ? parseCsv((await fsp.readFile(path.join(dirPath, overallFile), "utf8")).replace(/^\uFEFF/, ""))
    : [];
  const adRows = adFile
    ? parseCsv((await fsp.readFile(path.join(dirPath, adFile), "utf8")).replace(/^\uFEFF/, ""))
    : [];
  const platformRows = platformFile
    ? parseCsv((await fsp.readFile(path.join(dirPath, platformFile), "utf8")).replace(/^\uFEFF/, ""))
    : [];
  const yeogiManualRows = yeogiManualFile
    ? normalizeYeogiManualRows(parseCsv((await fsp.readFile(path.join(dirPath, yeogiManualFile), "utf8")).replace(/^\uFEFF/, "")))
    : [];
  const displayPlatformRows = yeogiManualRows.length
    ? [
        ...platformRows.filter((row) => String(row.channel || row["플랫폼"] || "") !== "여기어때"),
        ...yeogiManualRows
      ]
    : platformRows;
  const regions = summarizeRegionalRows(regionalRows, provinceKey);
  const datalabTrend = await enrichRegionsWithTraffic(regions, dirPath, demandKeywordForRun(manifest, conditions, regions));
  const stats = summarizeStats(regions);
  if (datalabTrend) stats.datalabTrend = datalabTrend;
  const availability = summarizeAvailabilityRows([...overallRows, ...adRows, ...regionalRows, ...displayPlatformRows]);
  const demandStructure = buildDemandStructure({
    manifest,
    conditions,
    regions,
    availability,
    datalabTrend
  });

  const result = {
    run: {
      id: runId,
      label: displayNameForRun(runId, manifest),
      keyword: manifest?.keyword || conditions.keyword || "",
      keywordType: manifest?.keywordType || "province",
      searchMode: manifest?.searchMode || (manifest?.keywordType === "company" ? "company" : "keyword"),
      searchModeLabel: SEARCH_MODES[manifest?.searchMode] || (manifest?.keywordType === "company" ? SEARCH_MODES.company : SEARCH_MODES.keyword),
      province: provinceKey,
      provinceLabel: province.label,
      mapBounds: province.mapBounds,
      checkIn: conditions.checkIn,
      checkOut: conditions.checkOut,
      adults: conditions.adults,
      productMode: conditions.productMode,
      productModeLabel: PRODUCT_MODES[conditions.productMode] || PRODUCT_MODES.all,
      bookingRangeDays: manifest?.bookingRangeDays || 1,
      bookingRangePlaceLimit: manifest?.bookingRangePlaceLimit || 0,
      counts: manifest?.counts || {},
      files: {
        regional: regionalFile,
        overall: overallFile,
        ads: adFile,
        platform: platformFile,
        yeogiManual: yeogiManualFile,
        report: reportFile,
        all: files
      }
    },
    stats,
    datalabTrend,
    demandStructure,
    regions,
    availability,
    platform: summarizePlatformRows(displayPlatformRows),
    companyPlatforms: summarizeCompanyPlatforms(displayPlatformRows),
    downloads: files
      .filter((file) => /\.(csv|xlsx|md|html|png)$/i.test(file))
      .map((file) => ({
        name: file,
        label: downloadLabelForFile(file, manifest || {}),
        url: `/outputs/${encodeURIComponent(runId)}/${encodeURIComponent(file)}`
      }))
  };

  result.companyMaster = await upsertCompanyMasterForRun(result, collectedAt).catch((error) => ({
    error: error.message || String(error),
    totalCompanies: 0,
    currentRunCompanies: 0,
    duplicateCandidateCount: 0,
    duplicateCandidates: []
  }));

  if (!options.skipHistory) {
    let history = await summarizeHistoryForRun(result);
    if (!history.currentRunObservationCount && availability.items.length) {
      await appendHistoryForRun(runId).catch((error) => {
        console.warn(`Could not backfill history for ${runId}: ${error.message || error}`);
      });
      history = await summarizeHistoryForRun(result);
    }
    result.history = history;
  }

  return result;
}

function summarizePlatformRows(rows) {
  const platformMap = {};
  for (const row of rows) {
    const platform = row["플랫폼"] || row.channel || "확인불가";
    if (!platformMap[platform]) {
      platformMap[platform] = {
        platform,
        count: 0,
        ads: 0,
        organic: 0,
        manual: 0,
        failed: 0,
        other: 0,
        statusCounts: { 광고: 0, 비광고: 0, 수동: 0, 실패: 0, 기타: 0 },
        samples: [],
        samplesByStatus: { 광고: [], 비광고: [], 수동: [], 실패: [], 기타: [] }
      };
    }

    const item = platformMap[platform];
    item.count += 1;
    const adValue = String(row["광고 여부"] || row["광고클러스터"] || row.ad_flag || row["광고집행클러스터"] || "");
    const statusValue = String(row["수집 상태"] || row.status || row.section || "");
    const methodValue = String(row["수집방식"] || row.collectionMethod || "");
    const nameValue = String(row["업체명"] || row.name || "");
    const rawReasonValue = String(row["실패 원인"] || row.reason || "");
    const inferredYeogiReason =
      platform === "여기어때" && (statusValue.includes("차단") || nameValue.includes("Cloudflare"))
        ? "Cloudflare/WAF 403 차단: 직접 HTTP 요청은 브라우저 검증(JS 챌린지, 쿠키, 브라우저 지문)을 통과하지 못했습니다."
        : "";
    const reasonValue = rawReasonValue || inferredYeogiReason;
    const directionValue = String(row["수집 방향"] || row.collectionDirection || row.collection_direction || "") ||
      (inferredYeogiReason
        ? "제휴 API는 현실성 낮은 장기 옵션으로 두고, 단기는 사용자 브라우저 세션 기반 확인 또는 수동 CSV/HTML 가져오기로 보완합니다."
        : "");
    const failed = statusValue.includes("실패") || statusValue.includes("차단") || reasonValue.length > 0;
    const manual = !failed && (
      statusValue.includes("수동") ||
      methodValue.includes("수동") ||
      directionValue.includes("수동")
    );
    const ad = !failed && (
      adValue === "Y" ||
      adValue.includes("광고 집행") ||
      adValue.includes("광고+비광고") ||
      (statusValue.includes("광고") && !statusValue.includes("비광고"))
    );
    const organic = !failed && !manual && !ad && (
      adValue === "N" ||
      statusValue.includes("비광고") ||
      statusValue.includes("검색결과")
    );
    const group = failed ? "실패" : manual ? "수동" : ad ? "광고" : organic ? "비광고" : "기타";
    const fallbackCoreRole =
      platform === "여기어때" ? "보조" : platform === "떠나요" ? "핵심(떠나요/ONDA)" : "핵심";
    const fallbackInventoryNote =
      platform === "네이버"
        ? "네이버예약은 전 채널 연동 재고와 분리 운영될 수 있어 날짜별 숙박재고로 독립 확인"
        : platform === "떠나요"
          ? "떠나요/ONDA 계열 전 채널 연동 후보, 네이버 분리 여부 별도 확인"
          : platform === "야놀자/NOL"
            ? "야놀자/NOL 검색 노출·가격 기준, 전체 객실수와 채널수는 상세 확인 필요"
            : "";
    const fallbackRoomCountStatus =
      platform === "네이버" && (row["숙박확인재고수"] || row["확인객실수"])
        ? `${row["숙박확인재고수"] || row["확인객실수"]}개(네이버 숙박재고, 전체 객실수 아님)`
        : "";
    const fallbackChannelCountStatus =
      platform === "네이버" ? "네이버예약 채널 기준" : platform === "여기어때" ? "" : "목록 단계 미확인";
    const fallbackNaverSplitStatus =
      platform === "여기어때" ? "" : platform === "네이버" ? "네이버 단독 확인" : "네이버 재고와 별도 비교 필요";
    const sample = {
      rank: row["순위"] || row.rank_or_order || "",
      name: nameValue,
      category: row["카테고리"] || row.category || "",
      location: row["주소"] || row.location || "",
      price: row["가격"] || row.price || "",
      status: statusValue || group,
      coreRole: row["핵심분석채널"] || fallbackCoreRole,
      inventoryNote: row["채널재고해석"] || fallbackInventoryNote,
      roomCountStatus: row["전체객실수확인상태"] || fallbackRoomCountStatus,
      channelCountStatus: row["채널수확인상태"] || fallbackChannelCountStatus,
      naverSplitStatus: row["네이버분리확인"] || fallbackNaverSplitStatus,
      reason: reasonValue,
      direction: directionValue,
      adFlag: adValue,
      url: row.url || row["상품 URL"] || ""
    };

    item.statusCounts[group] += 1;
    if (group === "광고") item.ads += 1;
    else if (group === "비광고") item.organic += 1;
    else if (group === "수동") item.manual += 1;
    else if (group === "실패") item.failed += 1;
    else item.other += 1;

    if (item.samples.length < 8) item.samples.push(sample);
    if (item.samplesByStatus[group].length < 6) item.samplesByStatus[group].push(sample);
  }
  return Object.values(platformMap);
}

async function runCrawler(payload) {
  if (activeCrawlPromise) {
    const elapsedSeconds = activeCrawlStartedAt
      ? Math.max(1, Math.round((Date.now() - activeCrawlStartedAt.getTime()) / 1000))
      : 0;
    const error = new Error(`이미 수집이 진행 중입니다${elapsedSeconds ? ` (${elapsedSeconds}초 경과)` : ""}. 완료 후 다시 실행하세요.`);
    error.statusCode = 409;
    throw error;
  }
  activeCrawlStartedAt = new Date();
  activeCrawlPromise = runCrawlerInternal(payload);
  try {
    return await activeCrawlPromise;
  } finally {
    activeCrawlPromise = null;
    activeCrawlStartedAt = null;
  }
}

function currentCrawlStatus() {
  const elapsedSeconds = activeCrawlStartedAt
    ? Math.max(1, Math.round((Date.now() - activeCrawlStartedAt.getTime()) / 1000))
    : 0;
  return {
    active: !!activeCrawlPromise,
    startedAt: activeCrawlStartedAt ? activeCrawlStartedAt.toISOString() : null,
    elapsedSeconds
  };
}

async function runCrawlerInternal(payload) {
  const keyword = String(payload.keyword || "").trim();
  if (!keyword) throw new Error("키워드를 입력해야 합니다.");
  const checkIn = payload.checkIn || process.env.CHECK_IN || kstDate(0);
  const checkOut = payload.checkOut || process.env.CHECK_OUT || kstDate(6);
  const bookingRangeDays = payload.bookingDays || payload.bookingRangeDays || bookingDaysFromRange(checkIn, checkOut) || process.env.BOOKING_RANGE_DAYS || 7;
  const bookingRangePlaceLimit = resolveBookingRangePlaceLimit(
    payload.bookingRangePlaceLimit ?? process.env.BOOKING_RANGE_PLACE_LIMIT,
    bookingRangeDays
  );

  const env = {
    ...process.env,
    CHECK_IN: checkIn,
    CHECK_OUT: checkOut,
    ADULTS: String(payload.adults || process.env.ADULTS || 2),
    SEARCH_MODE: normalizeSearchMode(payload.searchMode || process.env.SEARCH_MODE || "keyword"),
    PRODUCT_MODE: normalizeProductMode(payload.productMode || process.env.PRODUCT_MODE || "all"),
    BOOKING_RANGE_DAYS: String(bookingRangeDays),
    BOOKING_RANGE_PLACE_LIMIT: String(bookingRangePlaceLimit),
    DATA_DIR,
    OUTPUTS_DIR,
    CONFIG_DIR,
    NODE_PATH: process.env.NODE_PATH || (fs.existsSync(DEFAULT_NODE_MODULES) ? DEFAULT_NODE_MODULES : "")
  };

  const scriptPath = path.join(ROOT, "scripts", "gyeongnam_glamping_crawl.cjs");

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath, keyword], {
      cwd: ROOT,
      env,
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", async (code) => {
      if (code !== 0) {
        reject(new Error(stderr || stdout || `수집 실행 실패: ${code}`));
        return;
      }

      try {
        const trimmed = stdout.trim();
        const jsonStart = trimmed.indexOf("{");
        const parsed = jsonStart >= 0 ? JSON.parse(trimmed.slice(jsonStart)) : null;
        const outputDir = parsed?.outputDir || "";
        const runId = outputDir ? path.basename(outputDir) : null;
        const history = runId
          ? await appendHistoryForRun(runId).catch((error) => ({ appended: 0, error: error.message || String(error) }))
          : null;
        resolve({ output: parsed, runId, history });
      } catch {
        resolve({ output: stdout, runId: null });
      }
    });
  });
}

async function serveStatic(reqUrl, res) {
  if (reqUrl.pathname === "/" || reqUrl.pathname === "/view") {
    const html = await fsp.readFile(path.join(WEB_DIR, "index.html"), "utf8");
    const publicHtml = html
      .replace('href="/styles.css"', 'href="/styles.css?v=v2-20260630-sales-signals"')
      .replace('src="/app.js"', 'src="/app.js?v=v2-20260630-sales-signals"');
    return send(res, 200, publicHtml, "text/html; charset=utf-8");
  }
  const filePath = safeJoin(WEB_DIR, reqUrl.pathname);
  if (!filePath || !fs.existsSync(filePath) || (await fsp.stat(filePath)).isDirectory()) return notFound(res);
  const ext = path.extname(filePath).toLowerCase();
  send(res, 200, await fsp.readFile(filePath), MIME_TYPES[ext] || "application/octet-stream");
}

async function serveOutput(reqUrl, res) {
  const relative = reqUrl.pathname.replace(/^\/outputs\//, "");
  const filePath = safeJoin(OUTPUTS_DIR, relative);
  if (!filePath || !fs.existsSync(filePath) || (await fsp.stat(filePath)).isDirectory()) return notFound(res);
  const ext = path.extname(filePath).toLowerCase();
  send(res, 200, await fsp.readFile(filePath), MIME_TYPES[ext] || "application/octet-stream");
}

async function route(req, res) {
  const reqUrl = new URL(req.url, `http://${req.headers.host}`);

  try {
    if ((req.method === "GET" || req.method === "HEAD") && reqUrl.pathname === "/api/health") {
      if (req.method === "HEAD") return sendHead(res, 200);
      return send(res, 200, { ok: true, loginRequired: true, authenticated: isAuthenticated(req) });
    }

    if (req.method === "POST" && (reqUrl.pathname === "/api/login" || reqUrl.pathname === "/login")) {
      const payload = await parseLoginBody(req);
      const username = String(payload.username || "").trim();
      const password = String(payload.password || "").trim();
      if (!timingSafeTextEqual(username, ADMIN_USERNAME) || !timingSafeTextEqual(password, ADMIN_PASSWORD)) {
        if (reqUrl.pathname === "/login") return sendLogin(res, 401, "아이디 또는 비밀번호가 올바르지 않습니다.");
        return send(res, 401, { error: "아이디 또는 비밀번호가 올바르지 않습니다." });
      }
      const sessionId = createSession(username);
      if (reqUrl.pathname === "/login") {
        return send(res, 302, "", "text/plain; charset=utf-8", {
          "Set-Cookie": sessionCookie(sessionId),
          Location: "/"
        });
      }
      return send(res, 200, { ok: true }, "application/json; charset=utf-8", {
        "Set-Cookie": sessionCookie(sessionId)
      });
    }

    if (req.method === "POST" && reqUrl.pathname === "/api/logout") {
      const session = getSession(req);
      if (session?.id) sessions.delete(session.id);
      return send(res, 200, { ok: true }, "application/json; charset=utf-8", {
        "Set-Cookie": clearSessionCookie()
      });
    }

    if (req.method === "GET" && reqUrl.pathname === "/login") {
      if (isAuthenticated(req)) return send(res, 302, "", "text/plain; charset=utf-8", { Location: "/" });
      return sendLogin(res);
    }

    if (!requireLogin(req, res, reqUrl)) return;

    if (req.method === "HEAD" && (reqUrl.pathname === "/" || reqUrl.pathname === "/view")) {
      return sendHead(res, 200, "text/html; charset=utf-8");
    }

    if (req.method === "GET" && reqUrl.pathname === "/api/runs") {
      return send(res, 200, { runs: await listRuns() });
    }

    if (req.method === "GET" && reqUrl.pathname === "/api/crawl-status") {
      return send(res, 200, currentCrawlStatus());
    }

    if (req.method === "GET" && reqUrl.pathname === "/api/history/summary") {
      return send(res, 200, await summarizeHistoryOperations());
    }

    if (req.method === "GET" && reqUrl.pathname === "/api/company-master/summary") {
      return send(res, 200, await summarizeCompanyMaster());
    }

    if (req.method === "POST" && reqUrl.pathname === "/api/company-master/duplicates") {
      const payload = await parseJsonBody(req);
      return send(res, 200, await resolveCompanyMasterDuplicate(payload));
    }

    if (req.method === "POST" && reqUrl.pathname === "/api/company-master/manual-correction") {
      const payload = await parseJsonBody(req);
      return send(res, 200, await saveCompanyManualCorrection(payload));
    }

    if (req.method === "POST" && reqUrl.pathname === "/api/company-master/backfill") {
      const payload = await parseJsonBody(req);
      return send(res, 200, await backfillCompanyMasterFromRuns(payload));
    }

    if (req.method === "GET" && reqUrl.pathname === "/api/settings/traffic-keys") {
      return send(res, 200, trafficKeyStatus(await readTrafficKeys()));
    }

    if (req.method === "POST" && reqUrl.pathname === "/api/settings/traffic-keys") {
      const payload = await parseJsonBody(req);
      return send(res, 200, await saveTrafficKeys(payload));
    }

    if (req.method === "POST" && reqUrl.pathname === "/api/settings/traffic-keys/verify") {
      return send(res, 200, await verifyTrafficKeys());
    }

    if (req.method === "GET" && reqUrl.pathname.startsWith("/api/runs/")) {
      const runId = decodeURIComponent(reqUrl.pathname.replace("/api/runs/", ""));
      const data = await loadRun(runId);
      return data ? send(res, 200, data) : notFound(res);
    }

    if (req.method === "POST" && reqUrl.pathname === "/api/crawl") {
      const payload = await parseJsonBody(req);
      const result = await runCrawler(payload);
      const runs = await listRuns();
      return send(res, 200, { ...result, runs });
    }

    if (req.method === "POST" && reqUrl.pathname === "/api/yeogi-import") {
      const payload = await parseJsonBody(req);
      const result = await importYeogiSupplement(payload);
      const runs = await listRuns();
      return send(res, 200, { ...result, runs });
    }

    if (req.method === "GET" && reqUrl.pathname.startsWith("/outputs/")) {
      return serveOutput(reqUrl, res);
    }

    if (req.method === "GET") {
      return serveStatic(reqUrl, res);
    }

    send(res, 405, { error: "Method not allowed" });
  } catch (error) {
    send(res, error.statusCode || 500, { error: error.message || String(error) });
  }
}

const server = http.createServer((req, res) => {
  route(req, res);
});

function localNetworkUrls() {
  const interfaces = os.networkInterfaces();
  return Object.values(interfaces)
    .flat()
    .filter((item) => item && item.family === "IPv4" && !item.internal)
    .map((item) => `http://${item.address}:${PORT}`);
}

seedOutputsFromRepo()
  .catch((error) => {
    console.warn(`Could not seed outputs from repo: ${error.message || error}`);
  })
  .finally(() => {
    server.listen(PORT, HOST, () => {
      const primaryUrl = HOST === "0.0.0.0" ? `http://127.0.0.1:${PORT}` : `http://${HOST}:${PORT}`;
      console.log(`Glamping cluster app running at ${primaryUrl}`);
      if (HOST === "0.0.0.0") {
        for (const url of localNetworkUrls()) console.log(`Mobile/LAN URL: ${url}`);
      }
    });
  });
