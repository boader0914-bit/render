(function (root) {
  "use strict";

  // Saved snapshot projection only. No network, original files, timers, storage
  // or provider actions belong in this module, including legacy fallbacks.
  const VERSION = "regional-evidence-review-v1";
  const ENCODING = "compact-v1";
  const INPUT_VERSION = "review-input-v1";
  const MONTH = /^20\d{2}-(0[1-9]|1[0-2])$/, YEAR = /^20\d{2}$/;
  const numeric = value => typeof value === "number" && Number.isFinite(value) && value >= 0;
  const sourceLabels = { visitors: "지역 방문자", demandStrength: "체류·소비 지수", resourceDemand: "관광자원 수요 지수",
    diversity: "관광 다양성 지수", kosis: "인구·산업 통계", searchTrend: "검색 트렌드" };
  const observationLabels = { observed: "정상 관측", missing: "자료 미확보", partial: "일부 자료", error: "오류·제한",
    publication_pending: "공표 대기", suppressed: "비공개" };
  const evidenceLabels = { verified: "원본 근거 확인", missing: "원본 근거 부족", rejected: "근거 검증 거절", reference: "검색어 기준 참고", unavailable: "근거 미확인" };
  const priorities = { 1: "범위·원본 검토", 2: "원본 보관 확인", 3: "관측 자료 확인", 4: "원본 근거 보강", 5: "공표 대기", 6: "참고·확인 완료" };
  const issueDefinitions = {
    publication_pending: [5, "wait_publication", "공표 후 확인"], suppressed: [3, "review_suppressed", "비공개 상태 참고"],
    partial: [3, "prepare_observation", "부분 자료 확인"], observation_error: [3, "review_source", "응답 상태 확인"],
    missing_data: [3, "prepare_observation", "저장 자료 확인"], rejected_evidence: [1, "review_scope", "지역·기간·원본 대조"],
    missing_evidence: [4, "prepare_evidence", "보관 원본 근거 확인"], write_failed: [2, "review_storage", "원본 보관 상태 확인"],
    refresh_error: [3, "review_source", "최근 응답 상태 확인"]
  };
  // These enum orders are part of compact-v1. Append only; use a new encoding
  // version if an existing position or tuple meaning ever changes.
  const observationKinds = Object.keys(observationLabels), evidenceKinds = Object.keys(evidenceLabels);
  const issueKinds = Object.keys(issueDefinitions);
  const actionKinds = ["none", "reference_only", "wait_publication", "review_suppressed", "prepare_observation", "review_source", "review_scope", "prepare_evidence", "review_storage"];
  const reasonLabels = {
    UNRECORDED_REASON: "사유 미기록", RAW_RESPONSE_NOT_RETAINED: "응답 원본 미보관", SOURCE_SCOPE_ONLY: "응답 범위 확인 · 원본 보관 없음",
    SCOPE_UNVERIFIED: "지역 범위 근거 부족", MAPPING_PENDING: "지역 코드 확인 대기", MAPPING_MISSING: "지역 코드 연결 없음",
    REGION_NOT_SELECTABLE: "직접 비교 대상 행정구역이 아님", RESPONSE_REGION_MISMATCH: "선택 지역과 응답 범위 다름", REGION_MISMATCH: "지역 범위 불일치",
    STORED_EVIDENCE_PERIOD_OR_REFERENCE_MISMATCH: "기준기간과 보관 근거 불일치", DUPLICATE_PERIOD: "같은 기준기간의 관측 중복",
    EVIDENCE_WRITE_ERROR: "응답 원본 보관 실패", EVIDENCE_SECRET_DETECTED: "응답 원본 보관 거절", EVIDENCE_LIMIT_EXCEEDED: "원본 보관 용량 기준 초과",
    EVIDENCE_NOT_FOUND: "보관 원본 없음", EVIDENCE_REFERENCE_INVALID: "원본 참조 확인 실패", EVIDENCE_PATH_INVALID: "원본 위치 확인 실패",
    EVIDENCE_HASH_MISMATCH: "보관 원본 내용 불일치", EVIDENCE_IDENTITY_MISMATCH: "보관 원본의 대상·기간 불일치", EVIDENCE_READ_ERROR: "보관 원본 읽기 실패",
    KOSIS_STORED_VALUES_MISMATCH: "KOSIS 원본과 저장값 불일치", KOSIS_ORIGINAL_RESPONSE_NOT_FOUND: "KOSIS 보관 원본 없음",
    KOSIS_ORIGINAL_RESPONSE_UNREADABLE: "KOSIS 원본 읽기 실패", KOSIS_ORIGINAL_MAPPING_MISSING: "KOSIS 원본 지역 연결 확인 필요",
    KOSIS_ORIGINAL_INVALID_RESPONSE: "KOSIS 원본 항목·단위·지역 불일치", KOSIS_ORIGINAL_PERIOD_MISMATCH: "KOSIS 원본 기간 불일치",
    VISITOR_ORIGINAL_RESPONSE_NOT_STORED: "방문자 응답 원본 미보관", VISITOR_ORIGINAL_RESPONSE_NOT_FOUND: "방문자 보관 원본 없음",
    VISITOR_ORIGINAL_HASH_MISMATCH: "방문자 원본 내용 불일치", VISITOR_ORIGINAL_IDENTITY_MISMATCH: "방문자 원본 대상·기간 불일치",
    VISITOR_STORED_VALUES_MISMATCH: "방문자 원본과 저장값 불일치", VISITOR_RAW_REGION_MISMATCH: "방문자 원본 지역 불일치",
    VISITOR_RAW_INCOMPLETE_DAYS: "방문자 일별 원본 미완결",
    VISITOR_CACHE_IDENTITY_MISMATCH: "방문자 저장 자료 대상·기간 불일치", VISITOR_CACHE_REGION_AMBIGUOUS: "방문자 저장 지역 중복",
    VISITOR_ORIGINAL_CHANGED_DURING_READ: "검증 중 방문자 원본 변경", VISITOR_ORIGINAL_PATH_INVALID: "방문자 원본 위치 확인 필요",
    VISITOR_ORIGINAL_REFERENCE_INVALID: "방문자 원본 참조 확인 필요", VISITOR_ORIGINAL_RESPONSE_UNREADABLE: "방문자 원본 읽기 실패",
    VISITOR_ORIGINAL_ROW_COUNT_INVALID: "방문자 원본 행 수 확인 필요", VISITOR_ORIGINAL_SIZE_INVALID: "방문자 원본 크기 확인 필요",
    VISITOR_RAW_DATE_CATEGORY_OR_VALUE_INVALID: "방문자 원본 날짜·구분·수량 확인 필요", VISITOR_RAW_DUPLICATE_CONFLICT: "방문자 원본 중복값 불일치",
    VISITOR_REGION_MAPPING_AMBIGUOUS: "방문자 지역 연결 후보 중복", VISITOR_REGION_MAPPING_UNVERIFIED: "방문자 지역 코드 확인 필요",
    TOURISM_ORIGINAL_RESPONSE_NOT_STORED: "관광 응답 원본 미보관", TOURISM_STORED_VALUES_MISMATCH: "관광 원본과 저장값 불일치",
    TOURISM_CACHE_IDENTITY_MISMATCH: "관광 저장 자료 대상·기간 불일치", TOURISM_ORIGINAL_PAGINATION_INVALID: "관광 원본 페이지 구성 확인 필요",
    TOURISM_ORIGINAL_QUERY_INCOMPLETE: "관광 원본 조회 항목 누락", TOURISM_ORIGINAL_QUERY_MISMATCH: "관광 원본 조회 조건 불일치",
    TOURISM_ORIGINAL_RESPONSE_NOT_FOUND: "관광 보관 원본 없음", TOURISM_ORIGINAL_RESPONSE_UNREADABLE: "관광 원본 읽기 실패",
    TOURISM_ORIGINAL_ROW_COUNT_INVALID: "관광 원본 행 수 확인 필요", TOURISM_ORIGINAL_SCHEMA_INVALID: "관광 원본 응답 형식 확인 필요",
    STORED_EVIDENCE_UNVERIFIED: "보관 원본 근거 미확인",
    TOURISM_ORIGINAL_REGION_MISMATCH: "관광 원본 지역 불일치", TOURISM_ORIGINAL_PERIOD_MISMATCH: "관광 원본 기간 불일치",
    TOURISM_ORIGINAL_VALUE_INVALID: "관광 원본 수량 확인 필요", TOURISM_ORIGINAL_PAGE_INCOMPLETE: "관광 원본 페이지 누락",
    TOURISM_ORIGINAL_RESPONSE_FAILED: "관광 원본 응답 실패", TOURISM_ORIGINAL_METRIC_CODE_MISMATCH: "관광 원본 지표 불일치",
    TOURISM_ORIGINAL_METRICS_INVALID: "관광 원본 항목 구성 확인 필요", NO_DATA: "제공된 자료 없음", NOT_COLLECTED: "저장 자료 없음",
    MISSING_VALUES: "관측값 미확보", PARTIAL_DATA: "일부 자료만 확보", PUBLICATION_PENDING: "공식자료 공표 대기", SUPPRESSED: "제공기관 비공개",
    AUTH_ERROR: "자료 인증 확인 필요", MISSING_KEY: "자료 연결 설정 필요", QUOTA_EXCEEDED: "제공기관 요청 한도", TIMEOUT: "자료 응답 대기시간 초과",
    NETWORK_ERROR: "자료 응답 실패", CACHE_READ_ERROR: "저장 자료 읽기 실패", CACHE_WRITE_ERROR: "자료 저장 실패", INVALID_RESPONSE: "자료 응답 구성 확인 필요",
    PERIOD_MISMATCH: "자료 기준기간 불일치", COOLDOWN: "자료 갱신 대기", PROVIDER_FAILED: "제공기관 응답 실패", PROVIDER_UNAVAILABLE: "제공기관 자료 이용 불가",
    REGIONAL_SOURCE_BUSY: "다른 자료 준비 진행 중", RESPONSE_EVIDENCE_ALREADY_VERIFIED: "이전 응답 범위 확인", KEYWORD_SCOPE: "검색어별 상대지수 · 지역 간 절대 비교 제외"
  };
  let shared;
  function contractApi() {
    if (root.RegionalDataContract) return root.RegionalDataContract;
    if (!shared && typeof module !== "undefined" && module.exports && typeof require === "function") {
      try { shared = require("./regional-data-contract.js"); } catch { /* Keep unproven values unverified. */ }
    }
    return shared;
  }
  const safeCode = value => Object.hasOwn(reasonLabels, value) ? value : "UNRECORDED_REASON";
  const safeKey = (value, fallback) => typeof value === "string" && /^[a-zA-Z0-9_.:-]{1,160}$/.test(value) ? value : fallback;
  function safeLabel(value, fallback, length = 140) {
    return typeof value === "string" && value.trim() && value.length <= length && !/[\u0000-\u001f<>\\/=]/.test(value)
      && !/(?:https?:|file:|api.?key|service.?key|password|authorization|cookie|bearer|secret|token)/i.test(value) ? value.trim() : fallback;
  }
  const periodType = value => ["Y", "A", "annual", "yearly"].includes(value) ? "Y" : ["M", "monthly"].includes(value) ? "M" : "";
  const normalizedPeriod = (value, type) => {
    const text = typeof value === "string" ? value.replace(/^(20\d{2})(\d{2})$/, "$1-$2") : "";
    return type === "Y" ? YEAR.test(text) ? text : "" : type === "M" && MONTH.test(text) ? text : "";
  };
  function scopeOf(snapshot) {
    return { regionKey: safeKey(snapshot.scope?.regionKey || snapshot.regionIdentity?.regionKey, "unknown"),
      label: safeLabel(snapshot.scope?.label, "선택 지역"), month: normalizedPeriod(snapshot.scope?.month, "M"),
      months: [13, 24].includes(snapshot.scope?.months) ? snapshot.scope.months : null };
  }
  function inputFingerprint(snapshot) {
    // A non-cryptographic change detector for the already-read classification
    // inputs. This is not provider-original SHA verification or proof of truth.
    const serialized = JSON.stringify({ scope: scopeOf(snapshot), groups: Array.isArray(snapshot.groups) ? snapshot.groups : [] },
      (key, value) => value && typeof value === "object" && !Array.isArray(value)
        ? Object.fromEntries(Object.keys(value).sort().map(name => [name, value[name]])) : value);
    let first = 2166136261, second = 3335557771;
    for (let index = 0; index < serialized.length; index++) {
      const code = serialized.charCodeAt(index);
      first = Math.imul(first ^ code, 16777619) >>> 0;
      second = Math.imul(second ^ code, 16777619) >>> 0;
    }
    return `${INPUT_VERSION}:${serialized.length.toString(36)}:${first.toString(16).padStart(8, "0")}${second.toString(16).padStart(8, "0")}`;
  }
  function describe(group, metric) {
    const sourceKey = safeKey(group.key, "unknown_source"), metricKey = safeKey(metric.key, "unknown_metric");
    return { sourceKey, sourceLabel: safeLabel(group.label, sourceLabels[sourceKey] || "자료 출처"), metricKey,
      metricLabel: safeLabel(metric.label, "지표"), provider: safeLabel(group.provider, "출처 미확인"),
      unit: safeLabel(metric.unit, "단위 미확인", 40) };
  }
  function issue(kind, reason, priority, actionKind, actionLabel) {
    const reasonCode = safeCode(reason);
    return { kind, reasonCode, reasonLabel: reasonLabels[reasonCode], priority, priorityLabel: priorities[priority], actionKind, actionLabel };
  }
  function observedState(row, contract) {
    if (row?.status === "suppressed") return "suppressed";
    if (row?.status === "publication_pending" || row?.reasonCode === "PUBLICATION_PENDING") return "publication_pending";
    if (["error", "failed", "blocked", "interrupted"].includes(row?.status)) return "error";
    if (row?.status === "partial") return "partial";
    const availability = contract?.availabilityOf?.(row);
    // The local fallback also binds saved tuples to their already-read source
    // point. It does not inspect spatial contracts or original provider files.
    const text = value => typeof value === "string" ? value.trim() : "", status = text(row?.status), reasonCode = text(row?.reasonCode) || text(row?.errorCode);
    const locallyObserved = ["observed", "ready", "complete", "completed", "available"].includes(status)
      && !["UNSUPPORTED", "PROVIDER_UNSUPPORTED", "PUBLICATION_PENDING"].includes(reasonCode)
      && !["period_not_closed", "publication_pending", "not_published"].includes(row?.reason);
    return (availability ? availability.observed : locallyObserved) && numeric(row?.value) ? "observed" : "missing";
  }
  function pointsOf(snapshot, metric, type) {
    const collected = new Map(), duplicates = new Set();
    for (const row of Array.isArray(metric.rows) ? metric.rows : []) {
      const period = normalizedPeriod(row?.period, type);
      if (collected.has(period)) duplicates.add(period); else collected.set(period, row || {});
    }
    const requested = metric.requestedPoint, requestedPeriod = normalizedPeriod(requested?.period, type);
    if (requested && requestedPeriod && !collected.has(requestedPeriod)) collected.set(requestedPeriod, requested);
    if (!collected.size) collected.set(type === "M" ? normalizedPeriod(snapshot.scope?.month, type) : "", { status: "missing", value: null, reasonCode: "UNRECORDED_REASON" });
    return { collected, duplicates };
  }
  function observationIssues(row, state) {
    if (state === "publication_pending") return [issue("publication_pending", "PUBLICATION_PENDING", 5, "wait_publication", "공표 후 확인")];
    if (state === "suppressed") return [issue("suppressed", "SUPPRESSED", 3, "review_suppressed", "비공개 상태 참고")];
    if (state === "partial") return [issue("partial", row?.reasonCode || "PARTIAL_DATA", 3, "prepare_observation", "부분 자료 확인")];
    if (state === "error") return [issue("observation_error", row?.reasonCode, 3, "review_source", "응답 상태 확인")];
    if (state === "missing") return [issue("missing_data", row?.reasonCode, 3, "prepare_observation", "저장 자료 확인")];
    return [];
  }
  function reviewRow(snapshot, group, metric, row, period, type, duplicate) {
    const api = contractApi(), regionKey = safeKey(snapshot.scope?.regionKey || snapshot.regionIdentity?.regionKey, "unknown");
    const sourceKey = safeKey(group.key, "unknown_source"), metricKey = safeKey(metric.key, "unknown_metric");
    const ownSpatial = Object.hasOwn(row, "spatialContract");
    const metricPeriodMatches = normalizedPeriod(metric.latestPeriod, type) === period || (metric.rows || []).length === 1;
    let spatial = ownSpatial ? row.spatialContract : Object.hasOwn(metric, "spatialContract") ? metric.spatialContract : group.spatialContract;
    const fallbackProof = api?.storedProvenanceOf?.(spatial?.storedProvenance);
    if (!ownSpatial && spatial && (!metricPeriodMatches || spatial.storedProvenance
      && (!fallbackProof || fallbackProof.period !== period || (fallbackProof.periodType || "M") !== type))) {
      const { storedProvenance, ...base } = spatial;
      spatial = { ...base, status: "scope_unverified", evidence: "unverified", reasonCode: "SCOPE_UNVERIFIED" };
    }
    const verification = Object.hasOwn(row, "storedEvidenceVerification") ? row.storedEvidenceVerification : metricPeriodMatches ? metric.storedEvidenceVerification : null;
    const keyword = group.category === "search" || sourceKey === "searchTrend" || spatial?.scopeKind === "keyword";
    const state = duplicate ? "error" : observedState(row, api), value = state === "observed" ? row.value : null;
    const eligibility = api?.comparisonEligibility?.([{ regionKey, group, metric: { ...metric, periodType: type, spatialContract: spatial } }]);
    const summary = api?.storedEvidenceSummary?.(spatial, verification);
    const proof = api?.storedProvenanceOf?.(spatial?.storedProvenance);
    const proofMismatch = spatial?.storedProvenance && (!proof || proof.period !== period || (proof.periodType || "M") !== type);
    const rejected = verification?.status === "rejected" || spatial?.status === "response_mismatch" || proofMismatch || duplicate;
    let evidenceStatus = keyword ? "reference" : "unavailable", evidenceReason = "", issues = observationIssues(duplicate ? { reasonCode: "INVALID_RESPONSE" } : row, state);
    if (rejected) {
      evidenceStatus = "rejected";
      evidenceReason = duplicate ? "DUPLICATE_PERIOD" : proofMismatch ? "STORED_EVIDENCE_PERIOD_OR_REFERENCE_MISMATCH"
        : verification?.reasonCode || spatial?.reasonCode || "REGION_MISMATCH";
      issues.push(issue("rejected_evidence", evidenceReason, 1, "review_scope", "지역·기간·원본 대조"));
    } else if (!keyword && eligibility?.comparable && proof && summary?.sourceKind === "stored_raw_response") evidenceStatus = "verified";
    else if (!keyword && state === "observed") {
      evidenceStatus = "missing";
      evidenceReason = verification?.status === "pending" ? verification.reasonCode
        : eligibility?.comparable ? "SOURCE_SCOPE_ONLY" : spatial?.reasonCode || "SCOPE_UNVERIFIED";
      issues.push(issue("missing_evidence", evidenceReason, 4, "prepare_evidence", "보관 원본 근거 확인"));
    }
    // A failed newer archive does not invalidate an older normal observation or
    // its proof. Only the exact row's diagnostic may add this second issue.
    const storageReason = row.refreshErrorCode || (verification?.reasonCode === "EVIDENCE_WRITE_ERROR" ? verification.reasonCode : "");
    if (["EVIDENCE_WRITE_ERROR", "EVIDENCE_SECRET_DETECTED", "EVIDENCE_LIMIT_EXCEEDED"].includes(storageReason)) {
      issues.push(issue("write_failed", storageReason, 2, "review_storage", "원본 보관 상태 확인"));
    } else if (row.refreshErrorCode && !["NO_DATA", "PUBLICATION_PENDING"].includes(row.refreshErrorCode)) {
      issues.push(issue("refresh_error", row.refreshErrorCode, 3, "review_source", "최근 응답 상태 확인"));
    }
    issues.sort((a, b) => a.priority - b.priority || a.kind.localeCompare(b.kind));
    const uniqueIssues = [...new Map(issues.map(item => [`${item.kind}:${item.reasonCode}`, item])).values()];
    const primary = uniqueIssues[0], priority = primary?.priority || 6;
    const reasonCode = primary?.reasonCode || (keyword ? "KEYWORD_SCOPE" : "");
    return { id: [sourceKey, metricKey, type || "unknown", period || "unknown"].map(encodeURIComponent).join(":"),
      ...describe(group, metric), period, periodType: type || "unknown", value,
      ...(numeric(row.referenceValue) ? { referenceValue: row.referenceValue } : {}),
      observationStatus: state, observationLabel: observationLabels[state], evidenceStatus, evidenceLabel: evidenceLabels[evidenceStatus],
      reasonCode, reasonLabel: primary?.reasonLabel || (keyword ? reasonLabels.KEYWORD_SCOPE : evidenceLabels[evidenceStatus]),
      priority, priorityLabel: priorities[priority], actionKind: primary?.actionKind || (keyword ? "reference_only" : "none"),
      actionLabel: primary?.actionLabel || (keyword ? "검색어별 흐름 참고" : "확인 완료"),
      needsReview: uniqueIssues.some(item => item.priority <= 4),
      reasonCodes: [...new Set(uniqueIssues.map(item => item.reasonCode))], issues: uniqueIssues };
  }
  function build(snapshot = {}) {
    const items = [];
    for (const group of Array.isArray(snapshot.groups) ? snapshot.groups : []) for (const metric of Array.isArray(group.metrics) ? group.metrics : []) {
      const type = periodType(metric.periodType || group.periodType), { collected, duplicates } = pointsOf(snapshot, metric, type);
      for (const [period, row] of collected) items.push(reviewRow(snapshot, group, metric, row, period, type, duplicates.has(period)));
    }
    items.sort((a, b) => a.priority - b.priority || b.period.localeCompare(a.period) || a.sourceKey.localeCompare(b.sourceKey) || a.metricKey.localeCompare(b.metricKey));
    const count = predicate => items.filter(predicate).length;
    return { schemaVersion: 1, version: VERSION, inputFingerprint: inputFingerprint(snapshot), scope: scopeOf(snapshot),
      summary: { total: items.length, needsReview: count(item => item.needsReview), rejected: count(item => item.evidenceStatus === "rejected"),
        missingEvidence: count(item => item.issues.some(issue => issue.kind === "missing_evidence")), missingData: count(item => item.observationStatus === "missing"),
        publicationPending: count(item => item.observationStatus === "publication_pending"), suppressed: count(item => item.observationStatus === "suppressed"),
        writeFailed: count(item => item.issues.some(issue => issue.kind === "write_failed")), partial: count(item => item.observationStatus === "partial"),
        errors: count(item => item.observationStatus === "error" || item.issues.some(issue => issue.kind === "refresh_error")), verified: count(item => item.evidenceStatus === "verified"),
        normalZero: count(item => item.observationStatus === "observed" && item.value === 0),
        referenceOnly: count(item => item.evidenceStatus === "reference" && item.observationStatus === "observed"),
        byPriority: Object.fromEntries([1, 2, 3, 4, 5, 6].map(priority => [priority, count(item => item.priority === priority)])) }, items };
  }

  function invalid() { const error = new Error("EVIDENCE_REVIEW_INVALID"); error.code = "EVIDENCE_REVIEW_INVALID"; throw error; }
  function requireValid(condition) { if (!condition) invalid(); }
  function same(a, b) {
    if (a === b) return true;
    if (!a || !b || typeof a !== "object" || typeof b !== "object" || Array.isArray(a) !== Array.isArray(b)) return false;
    const keys = Object.keys(a), otherKeys = Object.keys(b);
    return keys.length === otherKeys.length && keys.every(key => Object.hasOwn(b, key) && same(a[key], b[key]));
  }
  function copySummary(summary) {
    const keys = ["total", "needsReview", "rejected", "missingEvidence", "missingData", "publicationPending", "suppressed", "writeFailed", "partial", "errors", "verified", "normalZero", "referenceOnly"];
    requireValid(summary && keys.every(key => Number.isSafeInteger(summary[key]) && summary[key] >= 0));
    requireValid(summary.byPriority && [1, 2, 3, 4, 5, 6].every(key => Number.isSafeInteger(summary.byPriority[key]) && summary.byPriority[key] >= 0));
    return { ...Object.fromEntries(keys.map(key => [key, summary[key]])), byPriority: Object.fromEntries([1, 2, 3, 4, 5, 6].map(key => [key, summary.byPriority[key]])) };
  }
  function copyScope(scope) {
    requireValid(scope && safeKey(scope.regionKey, null) && safeLabel(scope.label, null) && (scope.month === "" || MONTH.test(scope.month))
      && (scope.months === null || [13, 24].includes(scope.months)));
    return { regionKey: scope.regionKey, label: scope.label, month: scope.month, months: scope.months };
  }
  function pack(model) {
    requireValid(model?.schemaVersion === 1 && model.version === VERSION && !model.encoding && Array.isArray(model.items));
    requireValid(typeof model.inputFingerprint === "string" && /^review-input-v1:[0-9a-z]+:[0-9a-f]{16}$/.test(model.inputFingerprint));
    const scope = copyScope(model.scope), summary = copySummary(model.summary), metrics = [], codes = [], metricIndex = new Map(), codeIndex = new Map();
    requireValid(summary.total === model.items.length);
    const code = value => {
      if (value === "") return -1;
      requireValid(safeCode(value) === value);
      if (!codeIndex.has(value)) { codeIndex.set(value, codes.length); codes.push(value); }
      return codeIndex.get(value);
    };
    const items = model.items.map(item => {
      requireValid(item && safeKey(item.sourceKey, null) && safeKey(item.metricKey, null));
      const key = JSON.stringify([item.sourceKey, item.metricKey]);
      if (!metricIndex.has(key)) { metricIndex.set(key, metrics.length); metrics.push([item.sourceKey, item.metricKey]); }
      const observation = observationKinds.indexOf(item.observationStatus), evidence = evidenceKinds.indexOf(item.evidenceStatus), action = actionKinds.indexOf(item.actionKind);
      requireValid(observation >= 0 && evidence >= 0 && action >= 0 && Number.isInteger(item.priority) && item.priority >= 1 && item.priority <= 6
        && typeof item.needsReview === "boolean" && Array.isArray(item.issues));
      const issues = item.issues.map(entry => {
        const kind = issueKinds.indexOf(entry.kind), definition = issueDefinitions[entry.kind];
        requireValid(kind >= 0 && entry.priority === definition[0] && entry.actionKind === definition[1]);
        return [kind, code(entry.reasonCode), entry.priority, actionKinds.indexOf(entry.actionKind)];
      });
      // metric, period, type, value, observation, evidence, reason, priority,
      // action, needsReview, issues, optional referenceValue. No repeated prose.
      return [metricIndex.get(key), item.period, item.periodType, item.value, observation, evidence, code(item.reasonCode), item.priority,
        action, item.needsReview ? 1 : 0, issues, ...(Object.hasOwn(item, "referenceValue") ? [item.referenceValue] : [])];
    });
    return { schemaVersion: 1, version: VERSION, encoding: ENCODING, inputFingerprint: model.inputFingerprint, scope, summary, metrics, codes, items };
  }
  function expandCompact(stored, snapshot) {
    requireValid(stored?.schemaVersion === 1 && stored.version === VERSION && stored.encoding === ENCODING
      && Array.isArray(stored.metrics) && Array.isArray(stored.codes) && Array.isArray(stored.items));
    const scope = copyScope(stored.scope), summary = copySummary(stored.summary);
    requireValid(same(scope, scopeOf(snapshot)) && summary.total === stored.items.length
      && typeof stored.inputFingerprint === "string" && stored.inputFingerprint === inputFingerprint(snapshot));
    requireValid(stored.codes.every(code => typeof code === "string" && safeCode(code) === code) && new Set(stored.codes).size === stored.codes.length);
    const metadata = new Map();
    for (const group of Array.isArray(snapshot.groups) ? snapshot.groups : []) for (const metric of Array.isArray(group.metrics) ? group.metrics : []) {
      const descriptor = describe(group, metric), key = JSON.stringify([descriptor.sourceKey, descriptor.metricKey]), type = periodType(metric.periodType || group.periodType);
      metadata.set(key, metadata.has(key) ? null : { descriptor, type: type || "unknown", ...pointsOf(snapshot, metric, type) });
    }
    requireValid(stored.metrics.length === metadata.size && [...metadata.values()].every(Boolean)
      && [...metadata.values()].reduce((total, entry) => total + entry.collected.size, 0) === stored.items.length);
    const seenMetrics = new Set(), descriptions = stored.metrics.map(entry => {
      requireValid(Array.isArray(entry) && entry.length === 2 && entry.every(key => safeKey(key, null)));
      const key = JSON.stringify(entry), meta = metadata.get(key);
      requireValid(meta && !seenMetrics.has(key)); seenMetrics.add(key); return meta;
    });
    const code = (index, allowEmpty = false) => {
      requireValid(Number.isSafeInteger(index) && (allowEmpty && index === -1 || index >= 0 && index < stored.codes.length));
      return index === -1 ? "" : stored.codes[index];
    };
    const seenRows = new Set(), items = stored.items.map(tuple => {
      requireValid(Array.isArray(tuple) && [11, 12].includes(tuple.length) && Number.isSafeInteger(tuple[0]) && tuple[0] >= 0 && tuple[0] < descriptions.length);
      const { descriptor, type, collected, duplicates } = descriptions[tuple[0]], period = tuple[1];
      requireValid(tuple[2] === type && typeof period === "string" && (period === "" || normalizedPeriod(period, type) === period));
      requireValid(collected.has(period));
      requireValid(Number.isSafeInteger(tuple[4]) && observationKinds[tuple[4]] && Number.isSafeInteger(tuple[5]) && evidenceKinds[tuple[5]]
        && Number.isSafeInteger(tuple[8]) && actionKinds[tuple[8]] && [0, 1].includes(tuple[9]) && Array.isArray(tuple[10])
        && Number.isInteger(tuple[7]) && tuple[7] >= 1 && tuple[7] <= 6);
      const observationStatus = observationKinds[tuple[4]], evidenceStatus = evidenceKinds[tuple[5]], value = tuple[3];
      requireValid(observationStatus === "observed" ? numeric(value) : value === null);
      requireValid(tuple.length === 11 || numeric(tuple[11]));
      const point = collected.get(period), boundState = duplicates.has(period) ? "error" : observedState(point, null);
      requireValid(observationStatus === boundState && value === (boundState === "observed" ? point.value : null)
        && (numeric(point.referenceValue) ? tuple.length === 12 && tuple[11] === point.referenceValue : tuple.length === 11));
      const issues = tuple[10].map(entry => {
        requireValid(Array.isArray(entry) && entry.length === 4 && Number.isSafeInteger(entry[0]) && issueKinds[entry[0]]);
        const kind = issueKinds[entry[0]], definition = issueDefinitions[kind];
        requireValid(entry[2] === definition[0] && Number.isSafeInteger(entry[3]) && actionKinds[entry[3]] === definition[1]);
        return issue(kind, code(entry[1]), entry[2], definition[1], definition[2]);
      });
      const primary = issues[0], priority = tuple[7], reasonCode = code(tuple[6], true), actionKind = actionKinds[tuple[8]], needsReview = tuple[9] === 1;
      requireValid(priority === (primary?.priority || 6) && reasonCode === (primary?.reasonCode || (evidenceStatus === "reference" ? "KEYWORD_SCOPE" : ""))
        && actionKind === (primary?.actionKind || (evidenceStatus === "reference" ? "reference_only" : "none"))
        && needsReview === issues.some(item => item.priority <= 4));
      requireValid(issues.every((item, index) => !index || issues[index - 1].priority < item.priority
        || issues[index - 1].priority === item.priority && issues[index - 1].kind.localeCompare(item.kind) <= 0));
      requireValid(new Set(issues.map(item => `${item.kind}:${item.reasonCode}`)).size === issues.length);
      const id = [descriptor.sourceKey, descriptor.metricKey, type, period || "unknown"].map(encodeURIComponent).join(":");
      requireValid(!seenRows.has(id)); seenRows.add(id);
      return { id, ...descriptor, period, periodType: type, value, ...(tuple.length === 12 ? { referenceValue: tuple[11] } : {}),
        observationStatus, observationLabel: observationLabels[observationStatus], evidenceStatus, evidenceLabel: evidenceLabels[evidenceStatus],
        reasonCode, reasonLabel: primary?.reasonLabel || (evidenceStatus === "reference" ? reasonLabels.KEYWORD_SCOPE : evidenceLabels[evidenceStatus]),
        priority, priorityLabel: priorities[priority], actionKind, actionLabel: primary?.actionLabel || (evidenceStatus === "reference" ? "검색어별 흐름 참고" : "확인 완료"),
        needsReview, reasonCodes: [...new Set(issues.map(item => item.reasonCode))], issues };
    });
    const count = predicate => items.filter(predicate).length;
    const checks = { total: items.length, needsReview: count(item => item.needsReview), rejected: count(item => item.evidenceStatus === "rejected"),
      missingEvidence: count(item => item.issues.some(entry => entry.kind === "missing_evidence")), missingData: count(item => item.observationStatus === "missing"),
      publicationPending: count(item => item.observationStatus === "publication_pending"), suppressed: count(item => item.observationStatus === "suppressed"),
      writeFailed: count(item => item.issues.some(entry => entry.kind === "write_failed")), partial: count(item => item.observationStatus === "partial"),
      errors: count(item => item.observationStatus === "error" || item.issues.some(entry => entry.kind === "refresh_error")), verified: count(item => item.evidenceStatus === "verified"),
      normalZero: count(item => item.observationStatus === "observed" && item.value === 0), referenceOnly: count(item => item.evidenceStatus === "reference" && item.observationStatus === "observed"),
      byPriority: Object.fromEntries([1, 2, 3, 4, 5, 6].map(priority => [priority, count(item => item.priority === priority)])) };
    requireValid(same(checks, summary));
    return { schemaVersion: 1, version: VERSION, inputFingerprint: stored.inputFingerprint, scope, summary, items };
  }
  function expand(stored, snapshot = {}, options = {}) {
    try {
      const verbose = !stored?.encoding;
      const result = expandCompact(verbose ? pack(stored) : stored, snapshot);
      if (verbose) requireValid(same(result, stored));
      return result;
    } catch {
      if (options.strict) invalid();
      return build(snapshot);
    }
  }

  const api = { build, pack, expand, VERSION, ENCODING, INPUT_VERSION };
  if (typeof module === "object" && module.exports) module.exports = api;
  root.RegionalEvidenceReview = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
