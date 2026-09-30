"use strict";

// Persist only known codes and stages: upstream messages may contain URLs,
// response bodies, local paths or credentials.
const FAILURE_LABELS = {
  NAVER_SEARCH_STATE_MISSING: "검색 응답에 업체 목록 데이터가 없음",
  NAVER_SEARCH_STATE_INVALID: "검색 응답의 업체 목록을 해석하지 못함",
  NAVER_SEARCH_RESULT_UNSUPPORTED: "선택한 검색 방식에 맞는 결과 목록이 없음",
  NAVER_SEARCH_HTTP_ERROR: "검색 서버 오류 응답",
  COLLECTION_NETWORK_ERROR: "수집 서버 통신 실패",
  COLLECTION_TIMEOUT: "수집 응답 시간 초과",
  COLLECTION_STAGE_FAILED: "수집 단계 실행 실패",
};
const PHASE_LABELS = {
  setup: "수집 준비", naver_main: "첫 검색", naver_regional: "지역 검색",
  nol: "NOL 조회", yeogi: "여기어때 조회", ddnayo: "떠나요 조회",
  ota: "예약 채널 확인", booking: "예약 상세 조회", output: "결과 파일 저장",
};
function sanitizeCollectionFailure(value) {
  if (!value || !Object.hasOwn(FAILURE_LABELS, value.code) || !Object.hasOwn(PHASE_LABELS, value.phase)) return null;
  return { code: value.code, phase: value.phase,
    ...(Number.isInteger(value.httpStatus) && value.httpStatus >= 100 && value.httpStatus <= 599 ? { httpStatus: value.httpStatus } : {}) };
}
function collectionFailure(error, phase) {
  const transportCode = error?.cause?.code || error?.code;
  const code = Object.hasOwn(FAILURE_LABELS, error?.code) ? error.code
    : ["TimeoutError", "AbortError"].includes(error?.name) || ["ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT"].includes(transportCode) ? "COLLECTION_TIMEOUT"
    : ["ENOTFOUND", "ECONNRESET", "ECONNREFUSED", "EAI_AGAIN", "UND_ERR_SOCKET"].includes(transportCode) ? "COLLECTION_NETWORK_ERROR"
    : "COLLECTION_STAGE_FAILED";
  return sanitizeCollectionFailure({ code, phase: Object.hasOwn(PHASE_LABELS, phase) ? phase : "setup", httpStatus: error?.statusCode });
}
module.exports = { collectionFailure, sanitizeCollectionFailure, FAILURE_LABELS, PHASE_LABELS };
