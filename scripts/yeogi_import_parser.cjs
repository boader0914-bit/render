const YEOGI_CATEGORY_RE = /(?:풀빌라\s*펜션|비즈니스\s*호텔|레지던스\s*호텔|관광\s*호텔|모텔|호텔|펜션|캠핑|리조트|게스트하우스|한옥|카라반)/i;
const YEOGI_CATEGORY_START_RE = /^(?:풀빌라\s*펜션|비즈니스\s*호텔|레지던스\s*호텔|관광\s*호텔|모텔|호텔|펜션|캠핑|리조트|게스트하우스|한옥|카라반)\s*/i;
const YEOGI_PRICE_RE = /(?:\d{1,3},)*\d{1,3}\s*원\s*~?|(?:\d{1,3},)+\d{3}/g;

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

function htmlToLines(text) {
  return String(text || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|article|section|h\d|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .split(/\n+/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function looksLikeYeogiExtractScript(value) {
  const text = String(value || "");
  return /\(\(\)\s*=>\s*\{/.test(text) &&
    /const\s+priceRe/.test(text) &&
    /navigator\.clipboard|console\.log\(csv\)|headers\s*=/.test(text);
}

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
  if (!source || looksLikeYeogiExtractScript(source)) return [];
  const firstLine = source.replace(/^\uFEFF/, "").split(/\r?\n/, 1)[0] || "";
  const csvLike = looksLikeYeogiCsvHeader(firstLine);
  const rows = csvLike ? parseYeogiCsvImport(source) : parseYeogiTextImport(source);
  return rows.filter((row) => row.name);
}

module.exports = {
  looksLikeYeogiCsvHeader,
  looksLikeYeogiExtractScript,
  parseYeogiCompactLine,
  parseYeogiCsvImport,
  parseYeogiImport,
  parseYeogiTextImport,
  yeogiLocationFromText,
  yeogiLowestPrice,
  yeogiTextLines
};
