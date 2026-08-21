"use strict";

const OTA_PROVIDERS = [
  {
    channel: "yanolja",
    label: "야놀자/NOL",
    domains: ["yanolja.com", "nol.yanolja.com", "nol.com"],
  },
  {
    channel: "yeogi",
    label: "여기어때",
    domains: ["goodchoice.kr", "goodchoice.co.kr", "yeogi.com"],
  },
  {
    channel: "tteonayo",
    label: "떠나요",
    domains: ["ddnayo.com", "ddnayo.net", "tteonayo.com"],
  },
  {
    channel: "onda",
    label: "ONDA",
    domains: ["onda.me", "onda.co.kr", "withonda.com"],
  },
  {
    channel: "airbnb",
    label: "Airbnb",
    domains: ["airbnb.com", "airbnb.co.kr"],
  },
];

const STATUS_LABELS = {
  observed_on_naver: "네이버 화면 외부 예약 채널 노출 확인",
  partner_observed: "네이버 예약 파트너 운영 신호",
  not_observed_on_naver: "네이버에서 외부 OTA 노출 미확인",
  blocked: "네이버 관측 차단",
  auto_failed: "네이버 관측 오류",
  not_collected: "미수집",
};

const NAVER_REDIRECT_KEYS = new Set([
  "url",
  "u",
  "target",
  "targeturl",
  "redirect",
  "redirecturl",
  "redirect_url",
  "link",
  "dest",
  "destination",
]);

function normalizeText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function decodeHtml(value) {
  return String(value ?? "")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#(?:x27|39);/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function normalizedHttpUrl(rawUrl, baseUrl = "https://pcmap.place.naver.com/") {
  const raw = decodeHtml(normalizeText(rawUrl));
  if (!raw || /^(?:javascript|data|mailto|tel):/i.test(raw)) return "";
  try {
    const parsed = new URL(raw, baseUrl);
    if (!/^https?:$/.test(parsed.protocol)) return "";
    return parsed.toString();
  } catch {
    return "";
  }
}

function isNaverHost(hostname) {
  const host = String(hostname || "").toLowerCase().replace(/^www\./, "");
  return host === "naver.com" || host.endsWith(".naver.com") || host === "naver.me" || host.endsWith(".naver.me");
}

function decodedUrlCandidate(value) {
  let candidate = normalizeText(value);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (/^https?:\/\//i.test(candidate)) return candidate;
    try {
      const decoded = decodeURIComponent(candidate);
      if (decoded === candidate) break;
      candidate = decoded;
    } catch {
      break;
    }
  }
  return candidate;
}

function unwrapNaverRedirectUrl(rawUrl, baseUrl = "https://pcmap.place.naver.com/", depth = 0) {
  const normalized = normalizedHttpUrl(decodedUrlCandidate(rawUrl), baseUrl);
  if (!normalized || depth >= 4) return normalized;
  let parsed = null;
  try {
    parsed = new URL(normalized);
  } catch {
    return "";
  }
  if (!isNaverHost(parsed.hostname)) return normalized;

  for (const [key, value] of parsed.searchParams.entries()) {
    if (!NAVER_REDIRECT_KEYS.has(String(key || "").toLowerCase())) continue;
    const candidate = decodedUrlCandidate(value);
    if (!/^https?:\/\//i.test(candidate)) continue;
    const unwrapped = unwrapNaverRedirectUrl(candidate, normalized, depth + 1);
    if (unwrapped && unwrapped !== normalized) return unwrapped;
  }
  return normalized;
}

function hostMatchesDomain(hostname, domain) {
  const host = String(hostname || "").toLowerCase().replace(/\.$/, "");
  const expected = String(domain || "").toLowerCase().replace(/\.$/, "");
  return host === expected || host.endsWith(`.${expected}`);
}

function otaProviderFromUrl(rawUrl, baseUrl = "https://pcmap.place.naver.com/") {
  const url = unwrapNaverRedirectUrl(rawUrl, baseUrl);
  if (!url) return null;
  try {
    const hostname = new URL(url).hostname;
    const provider = OTA_PROVIDERS.find((entry) => entry.domains.some((domain) => hostMatchesDomain(hostname, domain)));
    return provider ? { ...provider, url } : null;
  } catch {
    return null;
  }
}

function isLikelyReservationUrl(provider = {}, rawUrl = "") {
  try {
    const parsed = new URL(rawUrl);
    const path = String(parsed.pathname || "").toLowerCase();
    const hasIdentityQuery = [...parsed.searchParams.keys()].some((key) =>
      /^(?:ano|id|idx|hotel|hotelidx|product|productid|accommodation|accommodationid|biz|business|room|roomid)$/i.test(key)
    );
    if (provider.channel === "airbnb") return /\/rooms?\//i.test(path);
    if (provider.channel === "yanolja") return /\/(?:stay|pension|hotel|accommodation|places?|products?)\//i.test(path) || hasIdentityQuery;
    if (provider.channel === "yeogi") return /\/(?:product|accommodation|domestic-accommodations|lodging|stay)\//i.test(path) || hasIdentityQuery;
    if (provider.channel === "tteonayo") return /\/(?:detail|rooms?|booking|reservation|stay|pension)\//i.test(path) || hasIdentityQuery;
    if (provider.channel === "onda") return /\/(?:rooms?|booking|reservation|stay|accommodation)\//i.test(path) || hasIdentityQuery;
    return false;
  } catch {
    return false;
  }
}

function hasRawAgencyId(value) {
  const text = normalizeText(value);
  return Boolean(text && !/^(?:0|null|undefined|none)$/i.test(text));
}

function bookingEvidenceFromSignals(signals = {}) {
  const hasBooking = signals.hasBooking === true || Boolean(normalizeText(signals.bookingBusinessId || signals.bookingUrl));
  const hasNPay = signals.hasNPay === true;
  const agencyId = normalizeText(signals.agencyId);
  const agencyName = normalizeText(signals.agencyName);
  const partnerCandidate = Boolean(agencyName);
  let operationSignal = "네이버 예약 운영 신호 미확인";
  if (agencyName) {
    operationSignal = `네이버 예약 파트너 운영 관측(${agencyName}) · 외부 OTA 입점 확정 아님`;
  } else if (hasRawAgencyId(agencyId)) {
    operationSignal = `네이버 예약 대행사 원시 식별값(ID ${agencyId}) · 채널/운영 주체로 해석하지 않음`;
  } else if (hasBooking) {
    operationSignal = "네이버 예약 노출 확인 · 운영 주체 미확인";
  }
  return {
    hasBooking,
    hasNPay,
    agencyId,
    agencyName,
    partnerCandidate,
    bookingStatus: hasBooking ? "노출 확인" : "네이버 미확인",
    nPayStatus: hasNPay ? "Y" : signals.hasNPay === false ? "N" : "",
    operationSignal,
  };
}

function uniqueChannels(links, options = {}) {
  const checkedAt = options.checkedAt || new Date().toISOString();
  const evidenceUrl = options.evidenceUrl || "";
  const method = options.method || "explicit_link";
  const result = [];
  const seen = new Set();
  for (const item of links || []) {
    const provider = otaProviderFromUrl(item?.url || item, evidenceUrl);
    if (!provider) continue;
    if (options.requireReservationPath && !isLikelyReservationUrl(provider, provider.url)) continue;
    const key = `${provider.channel}:${provider.url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({
      channel: provider.channel,
      label: provider.label,
      status: "observed_on_naver",
      url: provider.url,
      evidenceUrl,
      source: "naver_place",
      method,
      checkedAt,
      confidence: 0.98,
      note: "네이버 플레이스의 공개 예약 링크에서 확인했습니다. 실제 계약·재고 연동 여부는 별도 확인이 필요합니다.",
    });
  }
  return result;
}

function observationStatus(channels, bookingEvidence) {
  if ((channels || []).length) return "observed_on_naver";
  if (bookingEvidence?.partnerCandidate) return "partner_observed";
  return "not_observed_on_naver";
}

function makeObservation(status, options = {}) {
  const normalizedStatus = STATUS_LABELS[status] ? status : "auto_failed";
  const bookingEvidence = bookingEvidenceFromSignals(options.bookingEvidence || {});
  return {
    status: normalizedStatus,
    label: options.label || STATUS_LABELS[normalizedStatus],
    checkedAt: options.checkedAt || "",
    evidenceUrl: options.evidenceUrl || "",
    channels: Array.isArray(options.channels) ? options.channels : [],
    bookingEvidence,
    method: options.method || "",
    note: normalizeText(options.note),
  };
}

function parseNaverPlaceGraphqlObservation(payload, options = {}) {
  const checkedAt = options.checkedAt || new Date().toISOString();
  const evidenceUrl = options.evidenceUrl || "";
  const httpStatus = Number(options.httpStatus || payload?.httpStatus || 200);
  const rawText = String(options.rawText || "");
  const blocked = [403, 405, 429, 503].includes(httpStatus) || /captcha|WtmCaptcha|ncpt\.naver\.com/i.test(rawText);
  const root = payload?.data && payload.data.business !== undefined ? payload.data : payload;
  const business = root?.business;

  if (blocked) {
    return makeObservation("blocked", {
      checkedAt,
      evidenceUrl,
      method: "graphql",
      bookingEvidence: options.bookingEvidence,
      note: `GraphQL 관측이 차단되었습니다${httpStatus ? `(${httpStatus})` : ""}.`,
    });
  }
  const graphErrors = Array.isArray(payload?.errors) ? payload.errors : [];
  const reservationObservationError = graphErrors.some((error) =>
    (Array.isArray(error?.path) ? error.path : [])
      .map((value) => String(value || ""))
      .includes("accommodationBookingDetails")
  );
  if (!business || reservationObservationError || (graphErrors.length && business.accommodationBookingDetails == null)) {
    return makeObservation("auto_failed", {
      checkedAt,
      evidenceUrl,
      method: "graphql",
      bookingEvidence: options.bookingEvidence,
      note: `GraphQL 응답에서 플레이스 정보를 확인하지 못했습니다${httpStatus ? `(${httpStatus})` : ""}.`,
    });
  }

  const details = business.accommodationBookingDetails || {};
  const rooms = Array.isArray(details.rooms) ? details.rooms : [];
  const booking = business.naverBooking || {};
  const roomNPaySignals = rooms
    .map((room) => room?.isNPayUsed)
    .filter((value) => typeof value === "boolean");
  const itemNPaySignal = (options.bookingEvidence || {}).hasNPay;
  const hasNPay = typeof itemNPaySignal === "boolean"
    ? itemNPaySignal
    : roomNPaySignals.includes(true)
      ? true
      : roomNPaySignals.length
        ? false
        : undefined;
  const bookingEvidence = bookingEvidenceFromSignals({
    ...(options.bookingEvidence || {}),
    bookingBusinessId: booking.bookingBusinessId,
    bookingUrl: booking.naverBookingUrl || booking.naverBookingHubUrl,
    hasNPay,
    agencyName: details.agencyName,
  });
  const channels = uniqueChannels(
    rooms.map((room) => ({ url: room?.resrvUrl })).filter((item) => item.url),
    { checkedAt, evidenceUrl, method: "graphql_resrv_url" },
  );
  const status = observationStatus(channels, bookingEvidence);
  return makeObservation(status, {
    checkedAt,
    evidenceUrl,
    channels,
    bookingEvidence,
    method: "graphql",
    note: status === "not_observed_on_naver"
      ? "네이버 플레이스 예약 응답에서 외부 OTA 링크를 확인하지 못했습니다. 미입점 판정이나 신뢰도 감점에는 사용하지 않습니다."
      : bookingEvidence.operationSignal,
  });
}

function anchorHrefs(html) {
  const links = [];
  const anchorPattern = /<a\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*>/gi;
  let match = null;
  while ((match = anchorPattern.exec(String(html || "")))) {
    links.push(match[1] || match[2] || "");
  }
  return links;
}

function parseNaverPlaceHtmlObservation(html, options = {}) {
  const checkedAt = options.checkedAt || new Date().toISOString();
  const evidenceUrl = options.evidenceUrl || "";
  const httpStatus = Number(options.httpStatus || 200);
  const source = String(html || "");
  const blockedStatus = [403, 405, 429, 503].includes(httpStatus);
  const normalPlaceDocument = /window\.__APOLLO_STATE__|<body\b[^>]*class\s*=\s*["'][^"']*place_on_pcm/i.test(source);
  const visibleBlockMessage = /비정상적인\s*접근|자동입력\s*방지|요청이\s*차단|접근이\s*제한|잠시\s*후\s*다시/i.test(source);
  const captchaChallenge = /<(?:div|section|form)\b[^>]*(?:id|class)\s*=\s*["'][^"']*(?:captcha|challenge)[^"']*["']/i.test(source);
  const blocked = blockedStatus || (!normalPlaceDocument && (visibleBlockMessage || captchaChallenge));
  if (blocked) {
    return makeObservation("blocked", {
      checkedAt,
      evidenceUrl,
      method: "html_anchor",
      bookingEvidence: options.bookingEvidence,
      note: `플레이스 화면 관측이 차단되었습니다${httpStatus ? `(${httpStatus})` : ""}.`,
    });
  }
  if (httpStatus < 200 || httpStatus >= 400 || !source.trim()) {
    return makeObservation("auto_failed", {
      checkedAt,
      evidenceUrl,
      method: "html_anchor",
      bookingEvidence: options.bookingEvidence,
      note: `플레이스 화면을 확인하지 못했습니다${httpStatus ? `(${httpStatus})` : ""}.`,
    });
  }

  const bookingEvidence = bookingEvidenceFromSignals(options.bookingEvidence || {});
  const channels = uniqueChannels(anchorHrefs(source), {
    checkedAt,
    evidenceUrl,
    method: "html_anchor",
    requireReservationPath: true,
  });
  if (!normalPlaceDocument && !channels.length) {
    return makeObservation("auto_failed", {
      checkedAt,
      evidenceUrl,
      method: "html_anchor",
      bookingEvidence,
      note: "HTTP 200 응답이지만 정상 네이버 플레이스 문서 표식을 확인하지 못해 외부 OTA 미노출로 판정하지 않았습니다.",
    });
  }
  const status = observationStatus(channels, bookingEvidence);
  return makeObservation(status, {
    checkedAt,
    evidenceUrl,
    channels,
    bookingEvidence,
    method: "html_anchor",
    note: status === "not_observed_on_naver"
      ? "네이버 플레이스 공개 링크에서 외부 OTA를 확인하지 못했습니다. 텍스트 언급과 네이버 예약 링크는 증거로 사용하지 않습니다."
      : bookingEvidence.operationSignal,
  });
}

function notCollectedObservation(options = {}) {
  return makeObservation("not_collected", {
    evidenceUrl: options.evidenceUrl || "",
    bookingEvidence: options.bookingEvidence || {},
    note: options.note || "관측 범위에서 제외되었습니다.",
  });
}

function observationToCsvFields(observation, fallbackBookingEvidence = {}) {
  const source = observation || notCollectedObservation({ bookingEvidence: fallbackBookingEvidence });
  const bookingEvidence = bookingEvidenceFromSignals({
    ...fallbackBookingEvidence,
    ...(source.bookingEvidence || {}),
  });
  return {
    네이버OTA관측상태: source.status || "not_collected",
    네이버OTA관측라벨: source.label || STATUS_LABELS[source.status] || STATUS_LABELS.not_collected,
    네이버OTA관측시각: source.checkedAt || "",
    네이버OTA근거URL: source.evidenceUrl || "",
    네이버OTA관측방식: source.method || "",
    네이버OTA관측메모: source.note || "",
    네이버OTA노출JSON: JSON.stringify(Array.isArray(source.channels) ? source.channels : []),
    네이버예약노출상태: bookingEvidence.bookingStatus,
    네이버페이노출: bookingEvidence.nPayStatus,
    네이버예약대행사ID: bookingEvidence.agencyId,
    네이버예약대행사명: bookingEvidence.agencyName,
    네이버예약운영신호: bookingEvidence.operationSignal,
  };
}

module.exports = {
  OTA_PROVIDERS,
  STATUS_LABELS,
  bookingEvidenceFromSignals,
  notCollectedObservation,
  observationToCsvFields,
  otaProviderFromUrl,
  parseNaverPlaceGraphqlObservation,
  parseNaverPlaceHtmlObservation,
  unwrapNaverRedirectUrl,
};
