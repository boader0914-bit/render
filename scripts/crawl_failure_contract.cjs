"use strict";

const crypto = require("node:crypto");

const COLLECTOR_ERROR_PREFIX = "CRAWL_ERROR_V1:";
const FAILURE_CATALOG = Object.freeze({
  NAVER_APOLLO_STATE_MISSING: { message: "네이버 검색 응답을 확인하지 못해 수집을 중단했습니다.", retryable: false, statusCode: 502 },
  NAVER_APOLLO_STATE_INVALID: { message: "네이버 검색 응답 형식이 올바르지 않아 수집을 중단했습니다.", retryable: false, statusCode: 502 },
  NAVER_SEARCH_CONTRACT_UNAVAILABLE: { message: "네이버 검색 결과 형식이 변경되어 수집을 시작하지 못했습니다.", retryable: false, statusCode: 502 },
  NAVER_SEARCH_AMBIGUOUS: { message: "네이버 검색 결과를 안전하게 구분할 수 없어 수집을 중단했습니다.", retryable: false, statusCode: 502 },
  NAVER_ACCESS_BLOCKED: { message: "네이버 검색 접근이 일시적으로 제한되어 수집을 중단했습니다.", retryable: false, statusCode: 502 },
  NAVER_PROVIDER_COOLDOWN_ACTIVE: { message: "네이버 검색 연결을 보호하기 위해 재시도를 잠시 중단했습니다.", retryable: true, statusCode: 503 },
  NAVER_TEMPORARY_UNAVAILABLE: { message: "네이버 검색 응답이 지연되어 수집을 완료하지 못했습니다.", retryable: true, statusCode: 503 },
  NAVER_HTTP_ERROR: { message: "네이버 검색 응답을 받지 못해 수집을 중단했습니다.", retryable: true, statusCode: 502 },
  COLLECTOR_START_FAILED: { message: "수집 프로세스를 시작하지 못했습니다.", retryable: false, statusCode: 500 },
  COLLECTION_FAILED: { message: "수집 중 문제가 발생해 실행을 중단했습니다.", retryable: false, statusCode: 500 },
  INTERNAL_ERROR: { message: "요청 처리 중 문제가 발생했습니다. 잠시 후 다시 시도해 주세요.", retryable: false, statusCode: 500 }
});

function diagnosticId() {
  return `crawl-${crypto.randomBytes(6).toString("hex")}`;
}

function catalogEntry(code) {
  return FAILURE_CATALOG[code] || FAILURE_CATALOG.COLLECTION_FAILED;
}

function createCrawlFailure(code, options = {}) {
  const safeCode = FAILURE_CATALOG[code] ? code : "COLLECTION_FAILED";
  const entry = catalogEntry(safeCode);
  const error = new Error(entry.message);
  error.name = "CrawlFailure";
  error.code = safeCode;
  error.publicMessage = entry.message;
  error.retryable = options.retryable ?? entry.retryable;
  error.statusCode = options.statusCode ?? entry.statusCode;
  error.diagnosticId = options.diagnosticId || diagnosticId();
  const subtype = String(options.providerFailureSubtype || "");
  if (["http_403", "http_429", "challenge_html", "unknown_access_block"].includes(subtype)) {
    error.providerFailureSubtype = subtype;
  }
  const providerHttpStatus = Number(options.providerHttpStatus);
  if (Number.isInteger(providerHttpStatus) && providerHttpStatus >= 100 && providerHttpStatus <= 599) {
    error.providerHttpStatus = providerHttpStatus;
  }
  const retryAfterSeconds = Number(options.retryAfterSeconds);
  if (Number.isInteger(retryAfterSeconds) && retryAfterSeconds >= 0) {
    error.retryAfterSeconds = Math.min(retryAfterSeconds, 120 * 60);
  }
  return error;
}

function collectorFailureCode(error) {
  const code = String(error?.code || "");
  if (FAILURE_CATALOG[code]) return code;
  const causeCode = String(error?.cause?.code || "");
  if (/ETIMEDOUT|ECONNRESET|ECONNREFUSED|UND_ERR_CONNECT_TIMEOUT/i.test(causeCode)) return "NAVER_TEMPORARY_UNAVAILABLE";
  const text = String(error?.message || error || "");
  if (/Apollo state was not found|APOLLO_STATE.*MISSING/i.test(text)) return "NAVER_APOLLO_STATE_MISSING";
  if (/Apollo state JSON|APOLLO_STATE.*INVALID|Unexpected token.*JSON/i.test(text)) return "NAVER_APOLLO_STATE_INVALID";
  if (/Naver main search key not found|NAVER_SEARCH_CONTRACT_UNAVAILABLE/i.test(text)) return "NAVER_SEARCH_CONTRACT_UNAVAILABLE";
  if (/NAVER_SEARCH_AMBIGUOUS/i.test(text)) return "NAVER_SEARCH_AMBIGUOUS";
  if (/captcha|access denied|403|비정상적인 접근/i.test(text)) return "NAVER_ACCESS_BLOCKED";
  if (/ETIMEDOUT|ECONNRESET|AbortError|timeout/i.test(text)) return "NAVER_TEMPORARY_UNAVAILABLE";
  return "COLLECTION_FAILED";
}

function serializeCollectorFailure(error) {
  const code = collectorFailureCode(error);
  const entry = catalogEntry(code);
  const payload = { version: 1, code, retryable: error?.retryable ?? entry.retryable };
  if (code === "NAVER_ACCESS_BLOCKED") {
    const subtype = String(error?.providerFailureSubtype || "");
    if (["http_403", "http_429", "challenge_html", "unknown_access_block"].includes(subtype)) {
      payload.providerFailureSubtype = subtype;
    }
    const providerHttpStatus = Number(error?.providerHttpStatus);
    if (Number.isInteger(providerHttpStatus) && providerHttpStatus >= 100 && providerHttpStatus <= 599) {
      payload.providerHttpStatus = providerHttpStatus;
    }
    if (Number.isInteger(error?.retryAfterSeconds) && error.retryAfterSeconds >= 0) {
      payload.retryAfterSeconds = Math.min(error.retryAfterSeconds, 120 * 60);
    }
  }
  return `${COLLECTOR_ERROR_PREFIX}${JSON.stringify(payload)}`;
}

function parseCollectorFailureMarker(text) {
  const lines = String(text || "").split(/\r?\n/).reverse();
  const line = lines.find((item) => item.startsWith(COLLECTOR_ERROR_PREFIX));
  if (!line) return null;
  try {
    const payload = JSON.parse(line.slice(COLLECTOR_ERROR_PREFIX.length));
    if (!payload || payload.version !== 1 || !FAILURE_CATALOG[payload.code]) return null;
    return createCrawlFailure(payload.code, {
      retryable: Boolean(payload.retryable),
      providerFailureSubtype: payload.providerFailureSubtype,
      providerHttpStatus: payload.providerHttpStatus,
      retryAfterSeconds: payload.retryAfterSeconds
    });
  } catch {
    return null;
  }
}

function classifyCollectorProcessFailure({ stderr = "", stdout = "", exitCode = 1, spawnError = null } = {}) {
  if (spawnError) return createCrawlFailure("COLLECTOR_START_FAILED");
  const markerFailure = parseCollectorFailureMarker(stderr) || parseCollectorFailureMarker(stdout);
  if (markerFailure) return markerFailure;
  const code = collectorFailureCode(`${stderr}\n${stdout}`);
  const error = createCrawlFailure(code);
  error.exitCode = Number.isInteger(exitCode) ? exitCode : null;
  return error;
}

function unsafePublicText(value) {
  const text = String(value || "");
  return /(?:\n\s*at\s|node:internal|\/opt\/render|\/var\/data|\/(?:home|users?|tmp)\/|[A-Za-z]:[\\/]|\\\\|\.cjs:\d+|authorization|api[-_ ]?key|client[-_ ]?secret)/i.test(text);
}

function publicErrorPayload(error) {
  if (error?.publicMessage && FAILURE_CATALOG[error.code]) {
    return {
      error: error.publicMessage,
      code: error.code,
      retryable: Boolean(error.retryable),
      diagnosticId: error.diagnosticId || undefined
    };
  }
  const statusCode = Number(error?.statusCode) || 500;
  const message = String(error?.message || "").replace(/\s+/g, " ").trim();
  if (statusCode < 500 && message && message.length <= 240 && !unsafePublicText(message)) {
    return { error: message, code: String(error?.code || "REQUEST_REJECTED"), retryable: false };
  }
  const fallback = createCrawlFailure("INTERNAL_ERROR");
  return {
    error: fallback.publicMessage,
    code: fallback.code,
    retryable: fallback.retryable,
    diagnosticId: error?.diagnosticId || fallback.diagnosticId
  };
}

module.exports = {
  COLLECTOR_ERROR_PREFIX,
  FAILURE_CATALOG,
  classifyCollectorProcessFailure,
  collectorFailureCode,
  createCrawlFailure,
  publicErrorPayload,
  serializeCollectorFailure,
  unsafePublicText
};
