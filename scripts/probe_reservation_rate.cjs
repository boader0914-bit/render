const fs = require("node:fs/promises");
const path = require("node:path");

const KEYWORD = process.argv[2] || "산청글램핑";
const CHECK_IN = process.env.CHECK_IN || "2026-06-14";
const CHECK_OUT = process.env.CHECK_OUT || "2026-06-15";
const ADULTS = Number(process.env.ADULTS || 2);
const OUTPUT_DIR = path.resolve("outputs", "reservation_rate_probe");

const headers = {
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36",
  "accept-language": "ko-KR,ko;q=0.9",
};

function compactKeyword(value) {
  return String(value || "").replace(/\s+/g, "");
}

function spacedGlampingKeyword(value) {
  const normalized = compactKeyword(value).replace(/글램핑$/, "");
  return `${normalized} 글램핑`.trim();
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

function pickFields(object, pattern) {
  const result = {};
  for (const [key, value] of Object.entries(object || {})) {
    if (pattern.test(key)) result[key] = value;
  }
  return result;
}

function inspectKeys(object, pattern) {
  return Object.keys(object || {}).filter((key) => pattern.test(key)).sort();
}

function availabilityFromPrice(price) {
  const text = String(price || "");
  if (/예약마감|마감|매진|품절|sold\s*out/i.test(text)) return false;
  return /[\d,]+\s*원/.test(text) || /\d+/.test(text);
}

function monthParam(date) {
  return String(date || "").slice(0, 7).replace("-", "");
}

function accommodationIdFromUrl(url) {
  const match = String(url || "").match(/[?&]accommodationId=(\d+)/);
  return match ? match[1] : "";
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  const { res, text } = await fetchText(url, options);
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = { parseError: true, text: text.slice(0, 500) };
  }
  return { res, data, text };
}

async function probeNaver() {
  const query = spacedGlampingKeyword(KEYWORD);
  const url = `https://pcmap.place.naver.com/accommodation/list?query=${encodeURIComponent(query)}`;
  const { res, text } = await fetchText(url);
  const state = extractApolloState(text);
  const key = pickNaverSearchKey(state, query);
  const refs = key ? state.ROOT_QUERY[key]?.business?.items || [] : [];
  const items = refs
    .map((ref) => state[ref.__ref])
    .filter(Boolean)
    .slice(0, 20);
  const rows = items.map((item, index) => {
    const rooms = (item.roomImages || []).map((ref) => state[ref.__ref]).filter(Boolean);
    const pricedRooms = rooms.filter((room) => availabilityFromPrice(room.minPrice || room.maxPrice));
    return {
      rank: index + 1,
      name: item.name || "",
      hasBooking: Boolean(item.hasBooking),
      roomCount: rooms.length,
      pricedRoomCount: pricedRooms.length,
      availabilityProxy: rooms.length ? Number((pricedRooms.length / rooms.length).toFixed(3)) : null,
      bookingFields: pickFields(item, /booking|Booking|book|Book|예약|reservation|Reservation|room|Room/),
      itemKeys: inspectKeys(item, /booking|Booking|book|Book|예약|reservation|Reservation|room|Room|sold|Sold|avail|Avail|stock|Stock/),
      roomKeys: Array.from(new Set(rooms.flatMap((room) => inspectKeys(room, /price|Price|sold|Sold|avail|Avail|stock|Stock|예약|booking|room|Room/)))).sort(),
    };
  });
  const available = rows.filter((row) => row.hasBooking && (row.roomCount === 0 || row.pricedRoomCount > 0)).length;
  return {
    channel: "네이버",
    status: res.status,
    url,
    collected: rows.length,
    metric: "예약버튼 보유율 + 노출 객실 가격 보유율",
    reservationRateProxy: rows.length ? Number((available / rows.length).toFixed(3)) : null,
    rows,
    verdict:
      "실제 예약 전환율은 없음. hasBooking, 객실 노출 수, 객실 가격 노출 여부로 예약 가능률 대체지표는 계산 가능.",
  };
}

async function probeNol() {
  const query = spacedGlampingKeyword(KEYWORD);
  const body = {
    keyword: query,
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
      query,
    )}&verticalCategory=PRODUCT_CATEGORY_KOREA_ACCOMMODATION&checkInDate=${CHECK_IN}&checkOutDate=${CHECK_OUT}&capacityAdults=${ADULTS}`,
  };
  const count = await fetchJson("https://nol.yanolja.com/discovery/api/list/universal-search/v1/count", {
    method: "POST",
    headers: commonHeaders,
    body: JSON.stringify(body),
  });
  const list = await fetchJson("https://nol.yanolja.com/discovery/api/list/universal-search/v1/list", {
    method: "POST",
    headers: commonHeaders,
    body: JSON.stringify(body),
  });
  const items = Array.isArray(list.data?.items) ? list.data.items.filter((item) => item.type === "PRODUCT_ITEM") : [];
  const rows = items.slice(0, 20).map((entry, index) => {
    const data = entry.data || {};
    const price = data.prices?.[0];
    const statusText = [
      data.status,
      data.badge,
      data.soldOutText,
      data.unavailableReason,
      JSON.stringify(data.badges || ""),
    ]
      .filter(Boolean)
      .join(" ");
    const hasPrice = Boolean(price?.discountPrice || price?.sellingPrice || price?.price);
    const soldOut = /마감|매진|품절|sold\s*out|unavailable/i.test(statusText);
    return {
      rank: index + 1,
      name: data.title || "",
      hasPrice,
      soldOut,
      availabilityProxy: hasPrice && !soldOut ? 1 : 0,
      statusFields: pickFields(data, /sold|Sold|avail|Avail|stock|Stock|status|Status|예약|booking|room|Room|price|Price/),
      dataKeys: inspectKeys(data, /sold|Sold|avail|Avail|stock|Stock|status|Status|예약|booking|room|Room|price|Price/),
    };
  });
  const available = rows.filter((row) => row.availabilityProxy === 1).length;
  return {
    channel: "야놀자/NOL",
    status: list.res.status,
    countStatus: count.res.status,
    total: count.data?.count ?? null,
    collected: rows.length,
    metric: "날짜·인원 조건 검색 결과 중 가격 노출/매진 미표시 비율",
    reservationRateProxy: rows.length ? Number((available / rows.length).toFixed(3)) : null,
    rows,
    verdict:
      "검색 API가 날짜·인원 조건을 받으므로 예약 가능률 대체지표 산출 가능. 실제 예약 전환율은 없음.",
  };
}

async function probeYeogi() {
  const query = spacedGlampingKeyword(KEYWORD);
  const url = `https://www.goodchoice.kr/product/result?keyword=${encodeURIComponent(query)}`;
  const { res, text } = await fetchText(url);
  const blocked = res.status === 403 || text.includes("Sorry, you have been blocked");
  return {
    channel: "여기어때",
    status: res.status,
    finalUrl: res.url,
    collected: 0,
    reservationRateProxy: null,
    verdict: blocked
      ? "Cloudflare/WAF 차단. 직접 수집 불가. 사용자 브라우저 세션에서 DOM/CSV 가져오기 방식으로 가격/매진 문구를 추출해야 함."
      : "응답은 받았으나 별도 파서 필요. 가격/매진 문구 기반 예약 가능률 대체지표로 접근.",
  };
}

async function probeDdnayo() {
  const exact = spacedGlampingKeyword(KEYWORD);
  const normalized = compactKeyword(KEYWORD);
  const url = `https://trip.ddnayo.com/web-api/total-search?searchKeyword=${encodeURIComponent(
    normalized,
  )}&pageNumber=1&pageSize=24&orderBy=recommend`;
  const { res, data } = await fetchJson(url, {
    headers: {
      accept: "application/json, text/plain, */*",
      referer: `https://trip.ddnayo.com/searchResult?searchKeyword=${encodeURIComponent(exact)}`,
    },
  });
  const contents = data?.data?.contents || [];
  const rows = [];
  for (const [index, item] of contents.slice(0, 10).entries()) {
    const statusText = JSON.stringify(pickFields(item, /sold|Sold|avail|Avail|stock|Stock|status|Status|예약|booking|room|Room/));
    const hasPrice = Boolean(item.price);
    const soldOut = /마감|매진|품절|sold\s*out|unavailable/i.test(statusText);
    const accommodationId = accommodationIdFromUrl(item.productUrl);
    const row = {
      rank: index + 1,
      name: item.accommodationName || "",
      accommodationId,
      hasPrice,
      soldOut,
      availabilityProxy: hasPrice && !soldOut ? 1 : 0,
      roomReservableCount: null,
      roomTotalCount: null,
      roomAvailabilityProxy: null,
      itemKeys: inspectKeys(item, /sold|Sold|avail|Avail|stock|Stock|status|Status|예약|booking|room|Room|price|Price/),
      statusFields: pickFields(item, /sold|Sold|avail|Avail|stock|Stock|status|Status|예약|booking|room|Room|price|Price/),
    };
    if (accommodationId) {
      try {
        await sleep(index === 0 ? 0 : 350);
        const calendar = await fetchJson(
          `https://booking.ddnayo.com/booking-calendar-api/calendar/v2/accommodation/${accommodationId}/reservation-calendar?month=${monthParam(CHECK_IN)}`,
          {
            headers: {
              accept: "application/json, text/plain, */*",
              referer: item.productUrl || `https://booking.ddnayo.com/booking-calendar?accommodationId=${accommodationId}`,
            },
          },
        );
        const day = (calendar.data?.data?.rowDtos || [])
          .flatMap((week) => week.columnDtos || [])
          .find((column) => column.date === CHECK_IN);
        const details = day?.detailDtos || [];
        row.dayAvailable = day?.available ?? null;
        row.roomTotalCount = details.length;
        row.roomReservableCount = details.filter((detail) => detail.isReservable).length;
        row.roomAvailabilityProxy = details.length
          ? Number((row.roomReservableCount / details.length).toFixed(3))
          : (day?.available ? 1 : null);
        row.availabilityProxy = row.roomAvailabilityProxy ?? row.availabilityProxy;
      } catch (error) {
        row.calendarError = error.message || String(error);
      }
    }
    rows.push(row);
  }
  const available = rows.filter((row) => Number(row.availabilityProxy) > 0).length;
  const roomRates = rows
    .map((row) => row.roomAvailabilityProxy)
    .filter((value) => typeof value === "number");
  const roomWeightedTotal = rows.reduce((sum, row) => sum + (row.roomTotalCount || 0), 0);
  const roomWeightedAvailable = rows.reduce((sum, row) => sum + (row.roomReservableCount || 0), 0);
  return {
    channel: "떠나요/ONDA",
    status: res.status,
    total: data?.data?.totalSize ?? null,
    collected: rows.length,
    metric: "예약 달력 detailDtos 기준 객실 단위 isReservable 비율",
    reservationRateProxy: roomWeightedTotal
      ? Number((roomWeightedAvailable / roomWeightedTotal).toFixed(3))
      : rows.length
        ? Number((available / rows.length).toFixed(3))
        : null,
    listingAvailabilityProxy: rows.length ? Number((available / rows.length).toFixed(3)) : null,
    averageRoomAvailabilityProxy: roomRates.length
      ? Number((roomRates.reduce((sum, value) => sum + value, 0) / roomRates.length).toFixed(3))
      : null,
    rows,
    verdict:
      "예약 달력 API에서 날짜별 detailDtos와 isReservable이 확인됨. 객실 단위 예약 가능률 대체지표 산출 가능.",
  };
}

async function main() {
  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  const results = [];
  for (const probe of [probeNaver, probeNol, probeYeogi, probeDdnayo]) {
    try {
      results.push(await probe());
    } catch (error) {
      results.push({ channel: probe.name.replace(/^probe/, ""), error: error.message || String(error) });
    }
  }

  const output = {
    keyword: KEYWORD,
    checkIn: CHECK_IN,
    checkOut: CHECK_OUT,
    adults: ADULTS,
    collectedAt: new Date().toLocaleString("ko-KR", { timeZone: "Asia/Seoul" }),
    interpretation:
      "플랫폼이 실제 예약 전환율/예약율을 공개하지 않으면, 여기 값은 예약율이 아니라 예약 가능률 또는 판매가능률 대체지표입니다.",
    results,
  };
  const filePath = path.join(OUTPUT_DIR, `reservation_rate_probe_${Date.now()}.json`);
  await fs.writeFile(filePath, JSON.stringify(output, null, 2), "utf8");
  console.log(JSON.stringify({ filePath, summary: results.map((item) => ({
    channel: item.channel,
    status: item.status,
    collected: item.collected,
    reservationRateProxy: item.reservationRateProxy,
    verdict: item.verdict || item.error,
  })) }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
