(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.TrafficIntegrationStatus = api;
})(typeof window === "object" ? window : this, function () {
  "use strict";
  const names = { datalab: "검색 트렌드", searchad: "검색광고 키워드" };
  const reasons = {
    MISSING_KEYS: "인증키 설정이 필요합니다.", MISSING_KEY: "인증키 설정이 필요합니다.", NOT_CONFIGURED: "인증키 설정이 필요합니다.",
    AUTH_ERROR: "인증키 또는 API 이용 권한을 확인해 주세요.", AUTH_FAILED: "인증키 또는 API 이용 권한을 확인해 주세요.",
    RATE_LIMITED: "요청 한도에 도달했습니다. 재시도 가능 시각을 확인해 주세요.", QUOTA_EXCEEDED: "요청 한도에 도달했습니다. 재시도 가능 시각을 확인해 주세요.",
    TIMEOUT: "응답 시간이 초과됐습니다.", NETWORK_ERROR: "제공처와 연결하지 못했습니다.",
    INVALID_RESPONSE: "응답 형식을 확인하지 못했습니다.", NO_DATA: "정상 응답은 확인했지만 테스트 검색어의 자료가 없습니다.",
    RESPONSE_TOO_LARGE: "연결 테스트의 응답 크기 범위를 초과했습니다.", INVALID_JSON: "JSON 응답을 해석하지 못했습니다.", RESPONSE_READ_ERROR: "응답을 끝까지 읽지 못했습니다.",
    KEY_CHANGED: "키 변경 후 다시 확인해야 합니다.", CHECK_RECORD_UNAVAILABLE: "저장된 테스트 기록을 읽지 못했습니다.",
    NOT_TESTED: "저장된 연결 테스트 기록이 없습니다.", HTTP_ERROR: "제공처 요청이 실패했습니다.",
    PROVIDER_ERROR: "제공처가 오류를 반환했습니다.", PROVIDER_UNAVAILABLE: "제공처 응답에 문제가 있습니다.", TEST_IN_PROGRESS: "연결을 테스트하고 있습니다.", CHECK_IN_PROGRESS: "연결을 테스트하고 있습니다.",
    CHECK_INTERRUPTED: "이전 테스트가 끝났는지 확인하지 못했습니다.", CLOCK_SKEW: "저장된 확인 시각을 검증하지 못했습니다.",
    COOLDOWN: "최근 테스트 결과를 사용합니다. 반복 요청은 잠시 기다려 주세요."
  };
  function validTime(value) {
    if (typeof value !== "string" || !value) return null;
    const time = Date.parse(value);
    return Number.isFinite(time) ? time : null;
  }
  function timeLabel(value) {
    if (validTime(value) === null) return "확인 기록 없음";
    return new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date(value)) + " KST";
  }
  function row(data, provider, options = {}) {
    const now = Number.isFinite(options.now) ? options.now : Date.now();
    const check = data?.verification?.[provider];
    const configured = data?.[`${provider}Configured`] === true;
    const checkedTime = validTime(check?.checkedAt);
    const validDate = checkedTime !== null && checkedTime <= now + 5 * 60 * 1000;
    const stale = check?.stale === true || (validDate && now - checkedTime >= 24 * 60 * 60 * 1000);
    const currentKeys = check?.validForCurrentKeys === true;
    const testing = options.testing === provider || options.testing === "all";
    const code = typeof check?.errorCode === "string" ? check.errorCode : "";
    const status = Number.isInteger(check?.status) && check.status >= 100 && check.status <= 599 ? check.status : null;
    const cooldownTime = validTime(check?.cooldownUntil);
    const diagnostic = check?.diagnostics;
    const diagnosticValid = diagnostic && Number.isSafeInteger(diagnostic.responseBytes) && diagnostic.responseBytes >= 0 && diagnostic.responseBytes <= 32 * 1024 * 1024
      && diagnostic.responseLimitBytes === (provider === "searchad" ? 2 * 1024 * 1024 : 256 * 1024) && diagnostic.legacyResponseLimitBytes === 256 * 1024
      && diagnostic.legacyLimitExceeded === (diagnostic.responseBytes > 256 * 1024) && ["verified", "response_size", "json_parse", "response_read", "schema"].includes(diagnostic.validationStage);
    const diagnosticLabel = diagnosticValid ? `수신 확인 ${diagnostic.responseBytes.toLocaleString("ko-KR")}바이트${Number.isSafeInteger(diagnostic.keywordCount) && diagnostic.keywordCount >= 0 && diagnostic.keywordCount <= 100000 ? ` · 키워드 ${diagnostic.keywordCount.toLocaleString("ko-KR")}개` : ""}${diagnostic.legacyLimitExceeded ? " · 이전 검사 크기 초과" : ""}${diagnostic.utf8Bom === true ? " · 문자 표식 정규화" : ""}` : "";
    const base = { provider, name: names[provider] || "검색 API", configured, checkedAt: validDate ? check.checkedAt : "", checkedAtLabel: validDate ? timeLabel(check.checkedAt) : "확인 기록 없음", stale, httpStatus: status, errorCode: Object.hasOwn(reasons, code) ? code : "", diagnosticLabel, cooldownUntil: cooldownTime !== null && cooldownTime > now ? check.cooldownUntil : "", disabled: Boolean(options.testing) || !configured || cooldownTime !== null && cooldownTime > now };
    if (testing) return { ...base, status: "checking", statusLabel: "테스트 중", statusNote: "해당 API의 응답을 확인하고 있습니다." };
    if (!data) return { ...base, status: "checking", statusLabel: "저장 상태 미확인", statusNote: "저장 상태를 다시 확인해 주세요.", disabled: true };
    if (!configured) return { ...base, status: "missing", statusLabel: "미설정", statusNote: "인증키를 저장한 뒤 연결을 테스트해 주세요." };
    if (check?.checkStatus === "checking" && currentKeys) return { ...base, status: "checking", statusLabel: "테스트 중", statusNote: reasons.CHECK_IN_PROGRESS, disabled: true };
    if (!check || check.checkStatus === "unverified") return { ...base, status: "configured", statusLabel: "테스트 전", statusNote: reasons.NOT_TESTED };
    if (check.checkStatus === "key_changed" || check.validForCurrentKeys === false && validDate) return { ...base, status: "configured", statusLabel: "키 변경 후 재확인", statusNote: reasons.KEY_CHANGED };
    if (check.checkStatus === "verified" && check.ok === true && status === 200 && code === "OK" && currentKeys && validDate) return { ...base, status: stale ? "configured" : "connected", statusLabel: stale ? "이전 테스트 정상" : "최근 테스트 정상", statusNote: stale ? "24시간이 지난 기록입니다. 현재 연결은 다시 확인해 주세요." : "표시된 시각의 인증·응답을 확인했습니다." };
    if (check.checkStatus === "no_data" && currentKeys && validDate) return { ...base, status: "configured", statusLabel: "응답 확인 · 자료 없음", statusNote: reasons.NO_DATA };
    if (["failed", "limited"].includes(check.checkStatus) && currentKeys && validDate) return { ...base, status: "missing", statusLabel: `${stale ? "이전 " : ""}${check.checkStatus === "limited" ? "호출 제한 확인" : "테스트 실패"}`, statusNote: (reasons[code] || "연결 테스트가 실패했습니다. 인증·권한·제공처 상태를 확인해 주세요.") + (stale ? " 24시간이 지난 기록입니다." : "") };
    return { ...base, status: "checking", statusLabel: "결과 미확인", statusNote: reasons[code] || "테스트 결과를 확인하지 못했습니다. 정상 연결로 표시하지 않습니다." };
  }
  function escape(value) { return String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
  function detail(check) {
    if (!check || !names[check.provider]) return "";
    return `<div class="traffic-integration-detail"><p><span>마지막 테스트</span><time${check.checkedAt ? ` datetime="${escape(check.checkedAt)}"` : ""}>${escape(check.checkedAtLabel)}</time></p>${check.httpStatus || check.errorCode ? `<p class="traffic-integration-code">${escape([check.httpStatus ? `HTTP ${check.httpStatus}` : "", check.errorCode].filter(Boolean).join(" · "))}</p>` : ""}${check.diagnosticLabel ? `<p class="traffic-integration-diagnostic">${escape(check.diagnosticLabel)}</p>` : ""}${check.cooldownUntil ? `<p class="traffic-integration-cooldown">다음 테스트 ${escape(timeLabel(check.cooldownUntil))}</p>` : ""}<button type="button" class="secondary-button traffic-integration-test" data-traffic-test="${escape(check.provider)}"${check.disabled ? " disabled" : ""}>${escape(check.statusLabel === "테스트 중" ? "확인 중…" : `${check.name} 연결 테스트`)}</button></div>`;
  }
  return { row, detail, timeLabel, names };
});
