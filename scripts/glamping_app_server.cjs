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
const DATA_DIR = path.resolve(process.env.DATA_DIR || ROOT);
const OUTPUTS_DIR = path.resolve(process.env.OUTPUTS_DIR || path.join(DATA_DIR, "outputs"));
const CONFIG_DIR = path.resolve(process.env.CONFIG_DIR || path.join(DATA_DIR, "config"));
const TRAFFIC_KEYS_FILE = path.join(CONFIG_DIR, "traffic_api_keys.local.json");
const PORT = Number(process.env.PORT || 3210);
const HOST = process.env.HOST || (process.env.RENDER || process.env.RENDER_EXTERNAL_URL ? "0.0.0.0" : "127.0.0.1");
const APP_PIN = String(process.env.APP_PIN || "").trim();
const APP_USER = String(process.env.APP_USER || "admin").trim() || "admin";
const IS_PRODUCTION_RUNTIME = process.env.NODE_ENV === "production" || Boolean(process.env.RENDER || process.env.RENDER_EXTERNAL_URL);
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
  return {
    datalabConfigured: Boolean(keys.naverClientId && keys.naverClientSecret),
    searchadConfigured: Boolean(keys.searchadApiKey && keys.searchadSecretKey && keys.searchadCustomerId),
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
      next[field] = normalizeApiKey(payload[field]);
    }
  }

  await fsp.writeFile(TRAFFIC_KEYS_FILE, JSON.stringify(next, null, 2), "utf8");
  return trafficKeyStatus(next);
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

function secureEqualText(left, right) {
  const leftBuffer = Buffer.from(String(left || ""));
  const rightBuffer = Buffer.from(String(right || ""));
  if (leftBuffer.length !== rightBuffer.length) return false;
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function parseBasicAuth(req) {
  const header = String(req.headers.authorization || "");
  if (!header.toLowerCase().startsWith("basic ")) return null;
  try {
    const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
    const separator = decoded.indexOf(":");
    if (separator < 0) return { user: decoded, password: "" };
    return {
      user: decoded.slice(0, separator),
      password: decoded.slice(separator + 1)
    };
  } catch {
    return null;
  }
}

function isPublicPath(pathname) {
  return pathname === "/api/health";
}

function isMissingRequiredAuthConfig(pathname) {
  return IS_PRODUCTION_RUNTIME && !APP_PIN && !isPublicPath(pathname);
}

function isAuthorized(req) {
  if (!APP_PIN) return true;
  const auth = parseBasicAuth(req);
  if (!auth) return false;
  const pinMatches = secureEqualText(auth.password, APP_PIN) || secureEqualText(auth.user, APP_PIN);
  const userMatches = !auth.password || secureEqualText(auth.user, APP_USER) || secureEqualText(auth.password, APP_PIN);
  return pinMatches && userMatches;
}

function unauthorized(res) {
  return send(
    res,
    401,
    { error: "Authentication required" },
    "application/json; charset=utf-8",
    {
      "WWW-Authenticate": 'Basic realm="Glamping Cluster", charset="UTF-8"'
    }
  );
}

function notFound(res) {
  send(res, 404, { error: "Not found" });
}

function parseJsonBody(req) {
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
      if (!body.trim()) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(error);
      }
    });
  });
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
  const date = dirName.match(/(\d{8})/)?.[1] || "";
  return `${keyword}${date ? ` · ${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6)}` : ""}`;
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
    const manifest = await readManifest(dirPath);
    const stat = await fsp.stat(dirPath);
    const provinceKey = provinceKeyForRun(entry.name, manifest);

    runs.push({
      id: entry.name,
      label: displayNameForRun(entry.name, manifest),
      province: provinceKey,
      provinceLabel: (PROVINCES[provinceKey] || PROVINCES.local).label,
      updatedAt: stat.mtime.toISOString(),
      counts: manifest?.counts || {},
      files: manifest?.files || []
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
  const importedRows = parsedRows.map((row, index) => ({
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
  }));

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

function normalizeSearchKeyword(keyword) {
  const compact = compactKeyword(keyword);
  if (!compact) return "";
  return compact.endsWith("글램핑") ? compact : `${compact}글램핑`;
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
    return { source: "naver_searchad_keywordstool", metrics: {} };
  }
}

async function enrichRegionsWithTraffic(regions, dirPath) {
  const keys = await readTrafficKeys();
  const cachePath = path.join(dirPath, "traffic_metrics.json");
  const cache = await readTrafficCache(cachePath);
  const metrics = cache.metrics || {};
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

  if (changed && keys.searchadApiKey && keys.searchadSecretKey && keys.searchadCustomerId) {
    await fsp.writeFile(
      cachePath,
      JSON.stringify({ source: "naver_searchad_keywordstool", updatedAt: new Date().toISOString(), metrics }, null, 2),
      "utf8"
    );
  }
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
      inventoryMemo: row["객실수검증메모"] || "",
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
  if (!rows.length) return { average: null, detail: "" };
  const average = Number((rows.reduce((sum, row) => sum + row.rate, 0) / rows.length).toFixed(3));
  const rateDetail = rows.map((row) => `${row.date} ${formatRate(row.rate)}(${row.soldOut}/${row.total})`).join(", ");
  return { average, detail: rateDetail };
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

    const key = availabilityPlaceKey(row);
    if (!key || byPlace.has(key)) continue;

    byPlace.set(key, {
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
      weeklyDetail,
      weeklyAvgReservationRate,
      weeklyReservationRateDetail,
      dayUseAvailableStock: numericField(row, ["데이유즈예약가능수"]),
      dayUseTotalStock: numericField(row, ["데이유즈확인재고수"]),
      inventoryScope: row["네이버재고범위"] || "네이버예약 채널/날짜 기준 재고",
      inventoryMemo: row["객실수검증메모"] || "",
      rate: rate !== null ? rate : Number((availableRooms / totalRooms).toFixed(3)),
      price: row["예약최저가"] || row["금액"] || row.price || "",
      basis: row["예약가능근거"] || row["네이버예약재고수집상태"] || "",
      url: row.url || row["네이버예약URL"] || ""
    });
  }

  const items = [...byPlace.values()].sort((a, b) => a.rank - b.rank);
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
      lowAvailabilityCount: items.filter((item) => item.rate < 0.7).length
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

    const key = compactKeyword(name);
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
    const weeklyStockText = weeklyDetail
      ? `${weeklyAvgReservationRate !== null ? `평균 예약률 ${formatRate(weeklyAvgReservationRate)} · ` : ""}${weeklyReservationRateDetail ? `날짜별 예약률: ${weeklyReservationRateDetail} · ` : ""}${weeklySummary ? `${weeklySummary}: ` : ""}${weeklyDetail}`
      : weeklySummary;

    company.platforms.push({
      platform,
      rank: rank ?? "",
      group,
      price: row["예약최저가"] || row["가격"] || row.price || row["금액"] || "",
      status: statusValue || group,
      stock: weeklyStockText ? `${stock} · ${weeklyStockText}` : stock,
      inventoryNote: row["네이버상품구성"] || row["채널재고해석"] || "",
      weeklySummary,
      weeklyDetail,
      weeklyAvgReservationRate,
      weeklyReservationRateDetail,
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

async function loadRun(runId) {
  const dirPath = resolveRunDir(runId);
  if (!dirPath || !fs.existsSync(dirPath)) return null;

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
    ? parseCsv((await fsp.readFile(path.join(dirPath, yeogiManualFile), "utf8")).replace(/^\uFEFF/, ""))
    : [];
  const displayPlatformRows = yeogiManualRows.length
    ? [
        ...platformRows.filter((row) => String(row.channel || row["플랫폼"] || "") !== "여기어때"),
        ...yeogiManualRows
      ]
    : platformRows;
  const regions = summarizeRegionalRows(regionalRows, provinceKey);
  await enrichRegionsWithTraffic(regions, dirPath);
  const stats = summarizeStats(regions);

  return {
    run: {
      id: runId,
      label: displayNameForRun(runId, manifest),
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
    regions,
    availability: summarizeAvailabilityRows([...overallRows, ...adRows, ...regionalRows, ...displayPlatformRows]),
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
  const keyword = String(payload.keyword || "").trim();
  if (!keyword) throw new Error("키워드를 입력해야 합니다.");
  const checkIn = payload.checkIn || process.env.CHECK_IN || kstDate(0);
  const checkOut = payload.checkOut || process.env.CHECK_OUT || kstDate(6);
  const bookingRangeDays = payload.bookingDays || payload.bookingRangeDays || bookingDaysFromRange(checkIn, checkOut) || process.env.BOOKING_RANGE_DAYS || 7;

  const env = {
    ...process.env,
    CHECK_IN: checkIn,
    CHECK_OUT: checkOut,
    ADULTS: String(payload.adults || process.env.ADULTS || 2),
    PRODUCT_MODE: normalizeProductMode(payload.productMode || process.env.PRODUCT_MODE || "all"),
    BOOKING_RANGE_DAYS: String(bookingRangeDays),
    BOOKING_RANGE_PLACE_LIMIT: String(payload.bookingRangePlaceLimit || process.env.BOOKING_RANGE_PLACE_LIMIT || ""),
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
        resolve({ output: parsed, runId });
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
      .replace('href="/styles.css"', 'href="/styles.css?v=public-20260610-responsive-polish"')
      .replace('src="/app.js"', 'src="/app.js?v=public-20260610-responsive-polish"');
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
      return send(res, 200, { ok: true, authRequired: Boolean(APP_PIN) });
    }

    if (isMissingRequiredAuthConfig(reqUrl.pathname)) {
      return send(res, 503, { error: "APP_PIN must be configured before using this service in production." });
    }

    if (!isPublicPath(reqUrl.pathname) && !isAuthorized(req)) {
      return unauthorized(res);
    }

    if (req.method === "HEAD" && (reqUrl.pathname === "/" || reqUrl.pathname === "/view")) {
      return sendHead(res, 200, "text/html; charset=utf-8");
    }

    if (req.method === "GET" && reqUrl.pathname === "/api/runs") {
      return send(res, 200, { runs: await listRuns() });
    }

    if (req.method === "GET" && reqUrl.pathname === "/api/settings/traffic-keys") {
      return send(res, 200, trafficKeyStatus(await readTrafficKeys()));
    }

    if (req.method === "POST" && reqUrl.pathname === "/api/settings/traffic-keys") {
      const payload = await parseJsonBody(req);
      return send(res, 200, await saveTrafficKeys(payload));
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
    send(res, 500, { error: error.message || String(error) });
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
