(function (root) {
  "use strict";
  const ENDPOINT = "/api/regional-analysis";
  const LABELS = { observed: "정상 자료", ready: "자료 확보", complete: "완료", completed: "처리 완료", superseded: "새 자료로 다시 정리", partial: "일부 자료", missing: "자료 없음", failed: "확인 실패", error: "확인 실패", blocked: "접근 제한", publication_pending: "공표 대기", unchecked: "확인 전", queued: "대기", running: "처리 중", interrupted: "중단", stale: "갱신 필요", empty: "저장 전", available: "자료 확보", planned: "준비 예정", insufficient: "자료 부족" };
  const active = job => ["queued", "running"].includes(job?.status);
  const escapeHtml = value => String(value ?? "").replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character]));
  const number = value => value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value)) ? Number(value).toLocaleString("ko-KR", { maximumFractionDigits: 2 }) : "—";
  const statusLabel = value => LABELS[value] || "확인 필요";
  const statusClass = value => Object.hasOwn(LABELS, value) ? value : "unchecked";
  function latestCompletedMonth(value = Date.now()) {
    const kst = new Date(Number(value) + 9 * 3600000);
    return new Date(Date.UTC(kst.getUTCFullYear(), kst.getUTCMonth(), 0)).toISOString().slice(0, 7);
  }
  function timeLabel(value) {
    if (!value || !Number.isFinite(Date.parse(value))) return "저장 전";
    return `${new Date(Date.parse(value) + 9 * 3600000).toISOString().slice(0, 16).replace("T", " ")} KST`;
  }
  function periodLabel(value) { return String(value || "미확인").replace(/^(\d{4})(\d{2})$/, "$1-$2"); }
  function known(row) { return ["observed", "ready", "complete", "available"].includes(row?.status) && number(row?.value) !== "—"; }
  let sharedContract;
  function contractApi() {
    if (root.RegionalDataContract) return root.RegionalDataContract;
    if (!sharedContract && typeof module !== "undefined" && module.exports && typeof require === "function") {
      try { sharedContract = require("./regional-data-contract.js"); } catch { /* Legacy data remain visible without claiming a verified region scope. */ }
    }
    return sharedContract;
  }
  const levelLabel = value => ({ sigungu: "시·군·구", sido: "시·도" })[value] || "범위 미확인";
  function contractRows(group, state) {
    const regionKey = state.snapshot?.scope?.regionKey || state.regionKey || "";
    return (group.metrics?.length ? group.metrics : [{}]).map(metric => {
      const rows = (metric.rows || []).slice().sort((a, b) => periodLabel(a.period).localeCompare(periodLabel(b.period))), latest = rows.filter(known).at(-1) || rows.at(-1);
      const spatial = latest && Object.hasOwn(latest, "spatialContract") ? latest.spatialContract || {}
        : Object.hasOwn(metric, "spatialContract") ? metric.spatialContract || {} : group.spatialContract;
      const check = contractApi()?.comparisonEligibility?.([{ regionKey, group, metric: { ...metric, unit: "scope", periodType: "M", spatialContract: spatial } }]);
      const keyword = spatial?.scopeKind === "keyword" || group.key === "searchTrend" || group.category === "search";
      return { metric, latest, spatial, keyword, matched: check?.comparable === true,
        verification: latest?.storedEvidenceVerification || metric.storedEvidenceVerification,
        label: keyword ? "키워드 기준 · 지역 직접 비교 제외" : check?.comparable ? `${levelLabel(spatial?.providedLevel)} 기준 · 범위 일치` : check?.reason || "지역 범위 확인 필요" };
    });
  }
  function contractSummary(group, state) {
    const rows = contractRows(group, state);
    return rows.some(row => row.keyword) ? "키워드 기준 · 지역 직접 비교 제외" : rows.every(row => row.matched)
      && new Set(rows.map(row => row.spatial?.providedLevel)).size === 1 ? `${levelLabel(rows[0].spatial?.providedLevel)} 기준 · 범위 일치`
      : rows.some(row => row.matched) ? "일부 지역 범위 확인 필요" : rows[0].label;
  }
  function contractDetailsHtml(group, state) {
    const rows = contractRows(group, state), detailKey = `scope:${group.key}`;
    return `<details class="ra-contract" data-ra-detail="${escapeHtml(detailKey)}"${state.openDetails?.has(detailKey) ? " open" : ""}><summary>공통 기준 · 출처·지역 범위</summary><p class="ra-muted">같은 출처·단위·기준주기와 확인된 행정 범위만 직접 비교합니다. 범위 미확인 자료는 참고값이며, 검색 관심도는 키워드별 추이로만 봅니다.</p><div class="ra-table-wrap"><table><caption>${escapeHtml(group.label || group.key)} 비교 기준</caption><thead><tr><th scope="col">지표·출처</th><th scope="col">실제 범위</th><th scope="col">기준기간</th><th scope="col">수집 상태</th></tr></thead><tbody>${rows.map(row => `<tr><th scope="row">${escapeHtml(row.metric.label || row.metric.key || group.label || group.key)}<small>${escapeHtml(group.provider || "출처 미확인")} · ${escapeHtml(row.metric.unit || "단위 미확인")}</small></th><td>${escapeHtml(row.label)}${row.spatial?.providerRegionCode ? `<small>제공 지역 ${escapeHtml(row.spatial.providerRegionCode)}</small>` : ""}<small>${row.spatial?.evidence === "response" ? "제공 응답에서 확인" : row.keyword ? "키워드 검색 범위" : "범위 확인 필요"}</small>${storedEvidenceHtml(row)}</td><td>${escapeHtml(periodLabel(row.latest?.period || row.metric.latestPeriod))}<small>${row.metric.periodType === "Y" || group.periodType === "Y" ? "연간 자료" : row.metric.periodType === "M" || group.periodType === "M" ? "월간 자료" : "주기 확인 필요"}</small></td><td>${escapeHtml(statusLabel(row.latest?.status || row.metric.status || group.status || "missing"))}</td></tr>`).join("")}</tbody></table></div></details>`;
  }
  function storedEvidenceHtml(row) {
    const proof = contractApi()?.storedEvidenceSummary?.(row.spatial, row.verification);
    if (!proof) return "";
    return `<small>${escapeHtml(proof.label)} · ${escapeHtml(proof.reason)}</small>${proof.evidenceId ? `<small>원본 ${escapeHtml(proof.evidenceId)} · ${escapeHtml(proof.period)}</small><small>해시 ${escapeHtml(proof.sha256.slice(0, 12))} · 검증 ${escapeHtml(timeLabel(proof.verifiedAt))}</small>` : ""}`;
  }
  function safeCode(value) { return String(value || "").replace(/[^A-Z0-9_.:-]/gi, "").slice(0, 100); }
  function errorLabel(code) {
    return ({ MISSING_KEY: "연결 키 설정 필요", AUTH_ERROR: "이용 권한 확인 필요", QUOTA_EXCEEDED: "제공처 요청 한도", TIMEOUT: "제공처 응답 지연", NETWORK_ERROR: "제공처 연결 실패", NO_DATA: "해당 기간 자료 없음", PUBLICATION_PENDING: "아직 공표되지 않은 자료", PARTIAL_DATA: "일부 항목 미확보", MISSING_VALUES: "필요한 값 미확보", PROVIDER_FAILED: "제공처 응답 확인 필요", PROVIDER_UNAVAILABLE: "제공처 연결 준비 필요", COOLDOWN: "다음 조회 가능 시각 대기", SOURCE_FAILED: "원자료 준비 실패", CACHE_READ_ERROR: "저장자료 읽기 실패", CACHE_WRITE_ERROR: "저장자료 저장 실패", INVALID_RESPONSE: "응답 형식 확인 필요", MAPPING_MISSING: "지역 연결 확인 필요", REGION_MISMATCH: "응답 지역 불일치", PERIOD_MISMATCH: "응답 기간 불일치", REGIONAL_SOURCE_BUSY: "다른 자료 갱신 처리 중", PREPARATION_INTERRUPTED: "자료 갱신 중단" })[code] || (code ? `확인 코드 ${safeCode(code)}` : "");
  }
  const validTime = value => typeof value === "string" && Number.isFinite(Date.parse(value));
  const shownTime = value => validTime(value) ? timeLabel(value) : "기록 없음";
  const newestTime = values => values.filter(validTime).sort((a, b) => Date.parse(a) - Date.parse(b)).at(-1) || null;
  const completeStatus = value => ["observed", "ready", "complete", "available"].includes(value);
  const isBackground = group => group.key === "kosis" || group.category === "background" || ["Y", "annual", "mixed"].includes(group.periodType);
  const monthDistance = (end, start) => /^20\d{2}-\d{2}$/.test(end || "") && /^20\d{2}-\d{2}$/.test(start || "") ? Math.max(0, (Number(end.slice(0, 4)) - Number(start.slice(0, 4))) * 12 + Number(end.slice(5)) - Number(start.slice(5))) : null;
  function reasonHtml(issue) {
    if (!issue || completeStatus(issue.status)) return "";
    const recorded = issue.reasonEvidence === "recorded", code = recorded ? safeCode(issue.reasonCode) : "";
    return `${escapeHtml(code ? errorLabel(code) : "미확보 사유 미확인")}${code ? `<small class="ra-safe-code">${escapeHtml(code)}</small>` : ""}`;
  }
  function legacyManagement(state) {
    const snapshot = state.snapshot, through = snapshot?.scope?.month || state.targetMonth || "";
    const groups = (snapshot?.groups || []).map(group => {
      const background = isBackground(group);
      const metrics = (group.metrics || []).map(metric => {
        const rows = (metric.rows || []).slice().sort((a, b) => String(a.period).localeCompare(String(b.period)));
        const valid = rows.filter(known), latest = valid.at(-1);
        const latestPeriod = metric.latestPeriod || latest?.period || "";
        const expected = background ? 1 : Number.isInteger(metric.expectedMonths) ? metric.expectedMonths : 13;
        const observed = background ? (latest ? 1 : 0) : Number.isInteger(metric.availableMonths) ? metric.availableMonths : valid.length;
        const requestedRow = rows.find(row => row.period === through);
        return { ...metric, latestPeriod, latestValue: metric.latestValue ?? latest?.value ?? null,
          sourceRetrievedAt: newestTime(valid.map(row => row.retrievedAt)), lagMonths: background ? null : monthDistance(through, latestPeriod),
          coverage: { kind: background ? "items" : "months", observed, expected, startPeriod: rows[0]?.period || "", endPeriod: latestPeriod },
          gaps: rows.filter(row => !known(row)).map(row => ({ period: row.period, status: row.status || "missing", reasonCode: safeCode(row.errorCode), reasonEvidence: row.errorCode ? "recorded" : "unknown" })),
          requested: background ? null : { period: through, status: requestedRow ? requestedRow.status : latestPeriod === through ? "observed" : "missing", reasonCode: safeCode(requestedRow?.errorCode), reasonEvidence: requestedRow?.errorCode ? "recorded" : "unknown" } };
      });
      return { ...group, metrics, sourceRetrievedAt: newestTime(metrics.map(metric => metric.sourceRetrievedAt)),
        lagMonths: background ? null : monthDistance(through, group.latestPeriod),
        coverage: { kind: background ? "items" : "months", observed: background ? Number.isInteger(group.observedItems) ? group.observedItems : metrics.filter(metric => number(metric.latestValue) !== "—").length : Number.isInteger(group.availableMonths) ? group.availableMonths : Math.min(...metrics.map(metric => metric.coverage.observed), 13), expected: background ? group.expectedItems || metrics.length : group.expectedMonths || 13 },
        requested: background ? null : { period: through, status: group.latestRequestedStatus || (group.latestPeriod === through ? "observed" : "missing"), reasonCode: safeCode(group.latestRequestedErrorCode), reasonEvidence: group.latestRequestedErrorCode ? "recorded" : "unknown" } };
    });
    const providerJob = state.job?.collectMissing === true ? state.job : null;
    return { legacy: true, scope: snapshot?.scope, result: { generatedAt: snapshot?.generatedAt, resultId: snapshot?.resultId }, groups,
      refresh: { lastProvider: providerJob, schedule: { enabled: state.policy?.enabled === true, nextRunAt: state.policy?.nextRunAt || null, lastDueAt: state.policy?.lastRunAt || null, scope: "regional_bundle" } } };
  }
  function managementModel(state) { return state.management?.schemaVersion === 1 && Array.isArray(state.management.groups) ? state.management : legacyManagement(state); }
  function coverageLabel(coverage, short = false) {
    if (!coverage || !Number.isInteger(coverage.observed) || !Number.isInteger(coverage.expected) || coverage.expected < 1) return "확보 범위 미확인";
    return `${number(coverage.observed)}/${number(coverage.expected)}${coverage.kind === "items" ? "개 항목" : "개월"}${short ? "" : " 확보"}`;
  }
  function managementOverviewHtml(state, model) {
    const monthly = model.groups.filter(group => !isBackground(group)).flatMap(group => group.metrics || []);
    const full = monthly.filter(metric => metric.coverage?.kind === "months" && metric.coverage.expected > 0 && metric.coverage.observed === metric.coverage.expected).length;
    const review = model.summary?.reviewMetrics ?? model.groups.filter(group => !isBackground(group)).reduce((total, group) => total + (group.metrics || []).filter(metric => (metric.gaps || []).length || metric.coverage?.observed < metric.coverage?.expected || metric.requested && !completeStatus(metric.requested.status) || group.stale || ["failed", "error", "blocked"].includes(group.status)).length, 0);
    const refresh = model.refresh || {}, schedule = refresh.schedule || {}, provider = refresh.lastProvider?.status === "never" ? null : refresh.lastProvider;
    const attemptAt = provider?.startedAt || provider?.finishedAt;
    const attempt = attemptAt ? shownTime(attemptAt) : provider?.queuedAt ? "실행 대기" : "실행 기록 없음";
    const network = provider?.networkAttempted === true ? "외부 자료 요청 있음" : provider?.networkAttempted === false ? "외부 요청 없이 저장자료 사용" : provider ? "외부 요청 여부 미기록" : "";
    const sourceAt = newestTime(model.groups.map(group => group.sourceRetrievedAt));
    const due = schedule.status === "due" || schedule.status !== "scheduled" && schedule.enabled && validTime(schedule.nextRunAt) && Date.parse(schedule.nextRunAt) <= (state.nowMs ?? Date.now());
    const next = !schedule.enabled ? "예약 없음" : !validTime(schedule.nextRunAt) ? "예약 시각 확인 필요" : timeLabel(schedule.nextRunAt);
    return `<section class="ra-availability" aria-label="자료 확보 현황">
      <div class="ra-overview-heading"><strong>자료 확보 현황</strong><span>월간 지표 ${number(monthly.length)}개</span></div>
      <div class="ra-availability-counts"><div><span>최근 13개월 확보</span><strong>${monthly.length ? `${number(full)}<small>/${number(monthly.length)}개 지표</small>` : "—"}</strong></div><div class="${review ? "needs-review" : ""}"><span>확인 필요</span><strong>${monthly.length ? `${number(review)}<small>개 지표</small>` : "—"}</strong></div></div>
      <dl class="ra-refresh-meta">
        <div><dt>지역 전체 자동 갱신</dt><dd>${schedule.enabled ? "사용 중" : "꺼짐"}</dd></div>
        <div><dt>다음 예약 · 한국시간</dt><dd>${escapeHtml(next)}${due ? '<small class="ra-warning">예정 시각 지남 · 상태 확인 필요</small>' : ""}</dd></div>
        <div><dt>지역 자료 관리 갱신 시도</dt><dd>${provider ? `<span class="ra-badge is-${statusClass(provider.status)}">${escapeHtml(statusLabel(provider.status))}</span>` : ""}${escapeHtml(attempt)}${network ? `<small>${escapeHtml(network)}</small>` : ""}${provider?.errorCode ? `<small class="ra-warning">${escapeHtml(errorLabel(safeCode(provider.errorCode)))}</small>` : ""}</dd></div>
        <div><dt>원자료 최근 확인</dt><dd>${escapeHtml(shownTime(sourceAt))}</dd></div>
        <div><dt>결과 정리</dt><dd>${escapeHtml(shownTime(model.result?.generatedAt || state.snapshot?.generatedAt))}</dd></div>
        ${refresh.lastSuccessAt ? `<div><dt>최근 정상 갱신</dt><dd>${escapeHtml(shownTime(refresh.lastSuccessAt))}</dd></div>` : ""}
      </dl>${model.legacy ? '<p class="ra-muted">관리 상세 정보가 없는 이전 저장자료입니다. 항목을 펼쳐 확인할 수 있습니다.</p>' : ""}</section>`;
  }
  function managementMetricHtml(metric, sourceMetric, state, groupKey) {
    const background = metric.coverage?.kind === "items", detailKey = `metric:${groupKey}:${metric.key}`;
    const gaps = metric.gaps || [], byPeriod = new Map((sourceMetric?.rows || []).map(row => [row.period, row]));
    const requested = metric.requested && !completeStatus(metric.requested.status) ? metric.requested : null;
    for (const issue of [...gaps, ...(requested ? [requested] : [])]) if (issue.period && !byPeriod.has(issue.period)) byPeriod.set(issue.period, { period: issue.period, status: issue.status, value: null });
    const rows = [...byPeriod.values()].sort((a, b) => String(b.period).localeCompare(String(a.period)));
    return `<details class="ra-management-metric" data-ra-detail="${escapeHtml(detailKey)}"${state.openDetails?.has(detailKey) ? " open" : ""}><summary><strong>${escapeHtml(metric.label || metric.key)}</strong><span>${metric.latestPeriod ? `${escapeHtml(periodLabel(metric.latestPeriod))}${metric.periodType === "Y" ? "년" : ""}` : "확보 자료 없음"}</span><span>${escapeHtml(coverageLabel(metric.coverage, true))}</span></summary><div class="ra-management-metric-body"><dl class="ra-source-meta"><div><dt>최근 관측값</dt><dd>${number(metric.latestValue)} ${escapeHtml(metric.unit || "")}</dd></div><div><dt>원자료 확인</dt><dd>${escapeHtml(shownTime(metric.sourceRetrievedAt))}</dd></div>${!background ? `<div><dt>확보 대상 기간</dt><dd>${escapeHtml(periodLabel(metric.coverage?.startPeriod))} ~ ${escapeHtml(periodLabel(metric.coverage?.endPeriod))}</dd></div><div><dt>직전 완료월과의 시차</dt><dd>${Number.isInteger(metric.lagMonths) ? `${metric.lagMonths}개월` : "미확인"}</dd></div>` : '<div><dt>자료 성격</dt><dd>지역 기초자료 · 실제 공표기간 적용</dd></div>'}</dl>${requested ? `<p class="ra-requested"><strong>${escapeHtml(periodLabel(requested.period))} 자료 미확보</strong><span>${reasonHtml(requested)}</span></p>` : ""}${rows.length ? `<div class="ra-table-wrap"><table><caption>${escapeHtml(metric.label || metric.key)} 저장 자료</caption><thead><tr><th scope="col">기준기간</th><th scope="col">값</th><th scope="col">상태</th><th scope="col">미확보 사유</th></tr></thead><tbody>${rows.map(row => {
      const gap = gaps.find(item => item.period === row.period) || (requested?.period === row.period ? requested : null), observed = !gap && known(row), status = gap?.status || row.status;
      return `<tr><th scope="row">${escapeHtml(periodLabel(row.period))}</th><td>${observed ? number(row.value) : "—"}</td><td>${escapeHtml(statusLabel(status))}</td><td>${observed ? "—" : reasonHtml(gap || { status })}</td></tr>`;
    }).join("")}</tbody></table></div>` : '<p class="ra-muted">월별 세부자료가 저장되어 있지 않습니다.</p>'}</div></details>`;
  }
  function managementGroupHtml(group, state) {
    const background = isBackground(group), raw = state.snapshot?.groups?.find(item => item.key === group.key);
    const contracted = raw ? { ...group, ...raw } : group;
    const refresh = group.refresh || {}, errorCode = safeCode(refresh.errorCode || group.lastRefreshErrorCode || group.errorCode);
    const failedRefresh = Boolean(errorCode && !["NO_DATA", "PUBLICATION_PENDING", "PARTIAL_DATA", "MISSING_VALUES"].includes(errorCode));
    const old = group.stale || refresh.stale;
    const requested = group.requested && !completeStatus(group.requested.status) ? group.requested : null;
    return `<details class="ra-group ra-management-group" data-ra-group="${escapeHtml(group.key)}"${state.openGroups?.has(group.key) ? " open" : ""}><summary><span class="ra-group-title"><strong>${escapeHtml(group.label || group.key)}</strong><small>${escapeHtml(group.provider || raw?.provider || "")}</small><small class="ra-contract-label">${escapeHtml(contractSummary(contracted, state))}</small></span><span class="ra-management-period"><small>최근 자료</small>${escapeHtml(periodLabel(group.latestPeriod))}</span><span class="ra-group-coverage">${escapeHtml(coverageLabel(group.coverage, true))}</span><span class="ra-badge is-${statusClass(old ? "stale" : group.status)}">${old ? "최신 확인 필요" : escapeHtml(statusLabel(group.status))}</span></summary><div class="ra-group-body">${old ? `<p class="ra-warning">${failedRefresh ? "최근 갱신을 완료하지 못해 이전 정상 자료를 표시합니다." : "저장자료를 표시합니다. 최신 자료인지 확인이 필요합니다."}</p>` : ""}${errorCode ? `<p class="ra-muted">${escapeHtml(errorLabel(errorCode))}</p>` : ""}<dl class="ra-source-meta"><div><dt>원자료 확인</dt><dd>${escapeHtml(shownTime(group.sourceRetrievedAt))}</dd></div>${refresh.startedAt || refresh.finishedAt ? `<div><dt>이 묶음의 최근 처리</dt><dd>${escapeHtml(shownTime(refresh.finishedAt || refresh.startedAt))}${refresh.kind ? ` · ${refresh.kind === "local" ? "저장자료 정리" : "갱신 확인"}` : ""}</dd></div>` : ""}</dl>${requested ? `<p class="ra-requested"><strong>${escapeHtml(periodLabel(requested.period))} 자료 미확보</strong><span>${reasonHtml(requested)}</span></p>` : ""}${contractDetailsHtml(contracted, state)}${(group.metrics || []).map(metric => managementMetricHtml(metric, raw?.metrics?.find(item => item.key === metric.key), state, group.key)).join("") || '<p class="ra-muted">확보된 세부 지표가 없습니다.</p>'}</div></details>`;
  }
  function managementGroupsHtml(state, model) {
    const monthly = model.groups.filter(group => !isBackground(group)), background = model.groups.filter(isBackground);
    return `<div class="ra-managed-groups">${monthly.length ? `<div class="ra-section-heading"><strong>월간 흐름 지표</strong><small>각 지표의 최신 정상월부터 13개월</small></div><div class="ra-groups">${monthly.map(group => managementGroupHtml(group, state)).join("")}</div>` : ""}${background.length ? `<div class="ra-section-heading"><strong>지역 기초자료</strong><small>인구·산업 · 실제 공표월·연도</small></div><div class="ra-groups">${background.map(group => managementGroupHtml(group, state)).join("")}</div>` : ""}</div>`;
  }
  function metricHtml(metric) {
    const rows = (Array.isArray(metric.rows) ? metric.rows : []).slice().sort((a, b) => String(b.period).localeCompare(String(a.period)));
    const latest = rows.find(known);
    return `<details class="ra-metric"><summary><span>${escapeHtml(metric.label || metric.key)}</span><strong>${latest ? number(latest.value) : "—"}<small>${escapeHtml(metric.unit || "")}</small></strong><span>${latest ? `${escapeHtml(periodLabel(latest.period))}${latest.status === "partial" ? " · 일부 기간" : ""}` : "확보 자료 없음"}</span></summary><div class="ra-table-wrap"><table><caption>${escapeHtml(metric.label || metric.key)} 기간별 저장 자료</caption><thead><tr><th scope="col">기준기간</th><th scope="col">값${metric.unit ? ` (${escapeHtml(metric.unit)})` : ""}</th><th scope="col">자료 상태</th></tr></thead><tbody>${rows.length ? rows.map(row => `<tr><th scope="row">${escapeHtml(periodLabel(row.period))}</th><td>${known(row) ? number(row.value) : "—"}</td><td>${escapeHtml(statusLabel(row.status || (known(row) ? "ready" : "missing")))}</td></tr>`).join("") : '<tr><td colspan="3">저장 자료가 없습니다.</td></tr>'}</tbody></table></div></details>`;
  }
  function groupHtml(group, state) {
    const metrics = Array.isArray(group.metrics) ? group.metrics : [];
    const annual = group.key === "kosis" || group.frequency === "annual" || group.periodType === "annual";
    const available = Number.isInteger(group.availableMonths) ? group.availableMonths : null;
    const expected = Number.isInteger(group.expectedMonths) && group.expectedMonths > 0 ? group.expectedMonths : 13;
    const coverage = annual ? "월간·연간 기준기간 확인" : available !== null ? `${available}/${expected}개월 확보` : "확보 기간 확인";
    const code = safeCode(group.refresh?.errorCode || group.lastRefreshErrorCode || group.errorCode);
    const shownStatus = group.stale ? "stale" : group.status;
    const failedRefresh = code && !["NO_DATA", "PUBLICATION_PENDING", "PARTIAL_DATA", "MISSING_VALUES"].includes(code);
    return `<details class="ra-group" data-ra-group="${escapeHtml(group.key)}"${state.openGroups?.has(group.key) ? " open" : ""}><summary><span class="ra-group-title"><strong>${escapeHtml(group.label || group.key)}</strong><small>${group.latestPeriod ? `최근 기준 ${escapeHtml(periodLabel(group.latestPeriod))}` : "기준기간 미확인"}</small><small class="ra-contract-label">${escapeHtml(contractSummary(group, state))}</small></span><span class="ra-group-coverage">${escapeHtml(coverage)}</span><span class="ra-badge is-${statusClass(shownStatus)}">${group.stale ? "이전 자료 표시" : escapeHtml(statusLabel(group.status))}</span></summary><div class="ra-group-body">${group.stale ? `<p class="ra-warning">${failedRefresh ? "최근 갱신을 완료하지 못해 이전 정상 자료를 표시합니다." : "저장자료를 표시합니다. 최신 자료인지 확인이 필요합니다."}</p>` : ""}${code ? `<p class="ra-warning">${escapeHtml(errorLabel(code))}</p>` : ""}${state.mode === "sources" ? `<dl class="ra-source-meta"><div><dt>자료 묶음</dt><dd>${escapeHtml(group.label || group.key)}</dd></div><div><dt>기준기간</dt><dd>${escapeHtml(periodLabel(group.latestPeriod))}</dd></div>${group.provider ? `<div><dt>제공처</dt><dd>${escapeHtml(group.provider)}</dd></div>` : ""}${group.updatedAt || group.retrievedAt ? `<div><dt>마지막 자료 확인</dt><dd>${escapeHtml(timeLabel(group.updatedAt || group.retrievedAt))}</dd></div>` : ""}</dl>` : ""}${contractDetailsHtml(group, state)}${metrics.length ? metrics.map(metricHtml).join("") : '<p class="ra-muted">확보된 세부 지표가 없습니다. 미확보 자료를 0으로 계산하지 않습니다.</p>'}</div></details>`;
  }
  function jobHtml(job, snapshot = null) {
    if (!job) return "";
    const steps = Array.isArray(job.steps) ? job.steps : [];
    if (!steps.length && job.status === "completed" && job.resultId && job.resultId === snapshot?.resultId && snapshot.summary) {
      const summary = snapshot.summary;
      return `<div class="ra-job" role="status"><div><strong>처리 완료</strong><span>${number(summary.total)}개 항목 처리</span></div><p>자료 확보 ${number(summary.ready)} · 일부 ${number(summary.partial)} · 실패 ${number(summary.failed)} · 자료 없음·공표 대기 ${number(summary.missing)}${summary.stale ? ` · 이전 자료 표시 ${number(summary.stale)}` : ""}</p></div>`;
    }
    const processed = Number.isInteger(job.progress?.completed) ? job.progress.completed : steps.filter(step => !["queued", "running", "unchecked"].includes(step.status)).length;
    const total = Number.isInteger(job.progress?.total) ? job.progress.total : steps.length;
    const succeeded = steps.filter(step => ["complete", "completed", "ready"].includes(step.status)).length;
    const partial = steps.filter(step => step.status === "partial").length;
    const failed = steps.filter(step => ["failed", "interrupted"].includes(step.status)).length;
    return `<div class="ra-job" role="status"><div><strong>${escapeHtml(statusLabel(job.status))}</strong><span>${total ? `${processed}/${total} 항목 처리` : "서버 작업 상태 확인"}</span></div>${steps.length ? `<p>완료 ${succeeded} · 일부 ${partial} · 실패·중단 ${failed}</p>` : ""}${active(job) && total ? `<progress value="${Math.min(processed, total)}" max="${total}" aria-label="처리한 항목 수"></progress>` : ""}${job.errorCode ? `<p class="ra-warning">${escapeHtml(errorLabel(safeCode(job.errorCode)))}</p>` : ""}</div>`;
  }
  function managementHtml(state) {
    const busy = state.loading || state.starting || state.saving || active(state.job), blocked = busy || state.needsStatusCheck, draft = state.policyDraft || { enabled: false, hour: 9, minute: 0, intervalHours: 24 };
    const time = `${String(draft.hour ?? 9).padStart(2, "0")}:${String(draft.minute ?? 0).padStart(2, "0")}`;
    return `<div class="ra-management"><div class="ra-actions"><button type="button" data-ra-action="build"${blocked || !state.regionKey ? " disabled" : ""}>저장자료 정리</button><button class="ra-primary" type="button" data-ra-action="refresh"${blocked || !state.regionKey ? " disabled" : ""}>즉시 갱신</button></div><p class="ra-muted">저장자료 정리는 외부 요청 없이 계산합니다. 즉시 갱신은 필요한 원자료를 확인합니다.</p><details class="ra-policy-disclosure" data-ra-detail="policy"${state.openDetails?.has("policy") ? " open" : ""}><summary>자동 갱신 설정 <span>${state.policy?.enabled === true ? "사용 중" : "꺼짐"}</span></summary><form class="ra-policy" data-ra-policy-form><label class="ra-check"><input type="checkbox" data-ra-field="enabled"${draft.enabled ? " checked" : ""}${busy ? " disabled" : ""}>자동 갱신 사용</label><label>갱신 시각 · 한국시간<input type="time" data-ra-field="time" value="${escapeHtml(time)}" required${busy ? " disabled" : ""}></label><label>확인 간격<select data-ra-field="intervalHours"${busy ? " disabled" : ""}>${[6, 12, 24, 168].map(hours => `<option value="${hours}"${Number(draft.intervalHours) === hours ? " selected" : ""}>${hours === 168 ? "일주일" : `${hours}시간`}</option>`).join("")}</select></label><button type="submit"${busy || !state.regionKey ? " disabled" : ""}>갱신 설정 저장</button></form><p class="ra-muted">선택 지역의 자료 묶음을 함께 확인합니다. 설정 저장 전에는 변경되지 않습니다.</p></details></div>`;
  }
  function renderState(state) {
    if (state.storageError && !state.error) state = { ...state, error: `저장 자료 확인 필요 · ${errorLabel(state.storageError)}` };
    if (state.snapshot?.scope?.month && state.targetMonth && state.snapshot.scope.month !== state.targetMonth && !state.error) state = { ...state, error: `이전 기간 저장자료 · 기준 ${state.snapshot.scope.month}` };
    return state;
  }
  function statusHtml(input) {
    const state = renderState(input), snapshot = state.snapshot;
    return `${state.error ? `<p class="ra-warning">${escapeHtml(state.error)}${snapshot ? " 마지막 정상 저장 결과를 표시합니다." : ""}</p>` : state.message ? `<p>${escapeHtml(state.message)}</p>` : ""}${snapshot ? `<p>결과 저장 <time datetime="${escapeHtml(snapshot.generatedAt || "")}">${escapeHtml(timeLabel(snapshot.generatedAt))}</time>${state.loading ? " · 변경 여부 확인 중" : ""}</p>` : `<p>${!state.regionKey ? "분석할 지역을 선택해 주세요." : state.loading ? "저장된 결과를 확인하고 있습니다." : "저장된 분석이 없습니다. 지역 자료 관리에서 저장자료를 정리하거나 갱신해 주세요."}</p>`}${state.checkedAt ? `<p class="ra-muted" data-ra-read-meta>${state.readSource === "cache" ? "화면 저장 결과 재사용" : "서버 저장 결과 확인"} · 확인 <time datetime="${escapeHtml(state.checkedAt)}">${escapeHtml(timeLabel(state.checkedAt))}</time></p>` : ""}`;
  }
  function renderCard(input) {
    const state = renderState(input);
    const snapshot = state.snapshot, groups = Array.isArray(snapshot?.groups) ? snapshot.groups : [];
    if (state.mode === "manage") {
      const model = managementModel(state);
      const showJob = state.job && !["completed", "unchanged", "superseded"].includes(state.job.status);
      return `<section class="regional-analysis" aria-label="지역 자료 갱신 관리"><header class="ra-header"><div><span class="ra-eyebrow">지역 자료 갱신 관리</span><h3>${escapeHtml(state.regionLabel || "지역 미선택")}</h3></div><button type="button" data-ra-action="status"${state.loading || !state.regionKey ? " disabled" : ""}>${state.loading ? "확인 중…" : "상태 확인"}</button></header><div class="ra-status" role="status" aria-live="polite">${statusHtml(state)}</div>${managementOverviewHtml(state, model)}${showJob ? jobHtml(state.job, snapshot) : ""}${managementHtml(state)}${managementGroupsHtml(state, model)}<details class="ra-method" data-ra-detail="method"${state.openDetails?.has("method") ? " open" : ""}><summary>확보·갱신 기준</summary><p>13개월 확보율은 지표별 최신 정상월에서 계산합니다. 직전 완료월 자료가 아직 없으면 별도로 표시합니다. 인구·산업 기초자료에는 월간 확보율을 적용하지 않습니다.</p><p>원자료 확인, 제공기관 갱신 시도, 결과 정리는 서로 다른 시각입니다. 화면 조회는 외부 자료를 요청하지 않습니다. 오류·누락은 정상 0과 구별합니다.</p>${model.result?.resultId ? `<small>결과 번호 ${escapeHtml(model.result.resultId)}</small>` : ""}</details></section>`;
    }
    return `<section class="regional-analysis" aria-label="저장된 지역 분석"><header class="ra-header"><div><span class="ra-eyebrow">${state.mode === "manage" ? "지역 자료 갱신 관리" : state.mode === "sources" ? "저장 자료·계산 기준" : "전체 지표 · 저장된 분석"}</span><h3>${escapeHtml(state.regionLabel || "지역 미선택")}</h3><p>각 지표에서 최근 확보한 월을 포함한 13개월 · 인구·산업은 실제 기준기간 적용</p></div><button type="button" data-ra-action="status"${state.loading || !state.regionKey ? " disabled" : ""}>${state.loading ? "확인 중…" : "상태 확인"}</button></header><div class="ra-status" role="status" aria-live="polite">${statusHtml(state)}</div><div data-ra-job>${jobHtml(state.job, snapshot)}</div>${state.mode === "manage" ? managementHtml(state) : ""}${groups.length ? `<div class="ra-groups">${groups.map(group => groupHtml(group, state)).join("")}</div>` : ""}<details class="ra-method"><summary>계산·표시 기준</summary><p>조회는 저장된 결과를 사용합니다. 정상 응답의 0은 표시하고, 오류·누락·공표 대기는 0으로 바꾸지 않습니다. 지표별 기준월이 다르면 각 기준월을 유지합니다.</p><p>네이버 검색 트렌드는 같은 검색어·조회기간 안의 상대 관심도입니다. 다른 조회 구간의 지수를 단순 합산하지 않습니다.</p><p>이번 달 예상·다음 달 전망은 지역분석의 수요 전망에서 확인합니다. 이 화면의 수치는 공식 관측자료이며 예상값과 구별됩니다. 반경별 배후시장 분석은 별도 연결 예정입니다.</p>${snapshot?.resultId ? `<small>결과 번호 ${escapeHtml(snapshot.resultId)}</small>` : ""}</details></section>`;
  }
  async function defaultFetch(url, options = {}) {
    const response = await root.fetch(url, { credentials: "same-origin", ...options });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || "지역 저장 자료를 확인하지 못했습니다.");
    return body;
  }
  function createCache({ now = () => Date.now(), ttl = 60000, maxEntries = 80 } = {}) {
    const entries = new Map(), flights = new Map();
    let generation = 0;
    function remember(key, data, checked = false) { const checkedAt = checked ? now() : entries.get(key)?.checkedAt || null; entries.delete(key); entries.set(key, { data, at: now(), checkedAt }); while (entries.size > maxEntries) entries.delete(entries.keys().next().value); }
    return {
      read(key) { return entries.get(key)?.data || null; },
      info(key) { const item = entries.get(key); return item ? { checkedAt: item.checkedAt } : null; },
      fresh(key) { const item = entries.get(key); return Boolean(item && now() - item.at < ttl); },
      async get(key, fetcher, force = false) {
        if (flights.has(key)) return flights.get(key);
        if (!force && this.fresh(key)) return this.read(key);
        const token = generation;
        const promise = Promise.resolve().then(fetcher).then(data => { if (token === generation && flights.get(key) === promise) remember(key, data, true); return data; }).finally(() => { if (flights.get(key) === promise) flights.delete(key); });
        flights.set(key, promise); return promise;
      },
      set(key, data) { remember(key, data); },
      invalidate(key) { const item = entries.get(key); if (item) item.at = -Infinity; flights.delete(key); },
      clear() { generation++; entries.clear(); flights.clear(); }
    };
  }
  const sharedCache = createCache();
  const validMonth = value => /^20\d{2}-(0[1-9]|1[0-2])$/.test(value || "");
  function savedScope(input = {}, now = () => Date.now()) {
    const accountKey = input.accountKey === undefined ? "" : input.accountKey;
    const month = input.month === undefined ? latestCompletedMonth(now()) : input.month;
    if (typeof accountKey !== "string" || accountKey.length > 300 || accountKey.includes("\u0000")
      || typeof input.regionKey !== "string" || !input.regionKey.trim() || input.regionKey !== input.regionKey.trim()
      || input.regionKey.length > 120 || input.regionKey.includes("\u0000") || !validMonth(month)
      || input.months !== undefined && input.months !== 13) throw new Error("조회할 지역과 13개월 기준기간을 확인해 주세요.");
    return { accountKey, regionKey: input.regionKey, month, months: 13 };
  }
  const savedKey = scope => `${scope.accountKey}\u0000${scope.regionKey}\u0000${scope.month}\u000013`;
  function validateSavedResult(result, scope) {
    if (!result || typeof result !== "object" || !Object.hasOwn(result, "snapshot") || !result.scope) throw new Error("저장 결과 응답을 확인하지 못했습니다.");
    const validateScope = (value, label, required = false) => {
      if (!value) { if (required) throw new Error("저장 결과의 조회 조건을 확인하지 못했습니다."); return; }
      if (value.regionKey !== scope.regionKey) throw new Error(`선택 지역과 다른 ${label}입니다.`);
      if (value.month !== scope.month || value.months !== 13) throw new Error(`조회 기간과 다른 ${label}입니다.`);
    };
    validateScope(result.scope, "조회 조건", true);
    if (result.snapshot !== null) {
      if (typeof result.snapshot !== "object" || !Array.isArray(result.snapshot.groups)) throw new Error("저장 결과 응답을 확인하지 못했습니다.");
      validateScope(result.snapshot.scope, "저장 결과", true);
    }
    if (result.management?.scope) validateScope(result.management.scope, "관리 정보");
    if (result.job?.scope) validateScope(result.job.scope, "작업 결과");
    else if (result.job?.regionKey && result.job.regionKey !== scope.regionKey) throw new Error("선택 지역과 다른 작업 결과입니다.");
    return result;
  }
  function createSavedResults({ cache = sharedCache, now = () => Date.now() } = {}) {
    return {
      read(input) { const scope = savedScope(input, now), data = cache.read(savedKey(scope)); if (!data) return null; try { return validateSavedResult(data, scope); } catch { cache.invalidate(savedKey(scope)); return null; } },
      get(input) { const scope = savedScope(input, now), fetchJson = input.fetchJson || defaultFetch;
        const query = new URLSearchParams({ regionKey: scope.regionKey, month: scope.month, months: "13" });
        return cache.get(savedKey(scope), async () => {
          const result = validateSavedResult(await fetchJson(`${ENDPOINT}?${query}`), scope);
          if (result.storage?.errorCode && !result.snapshot && cache.read(savedKey(scope))?.snapshot) throw new Error("저장 자료 확인 실패 · 마지막 정상 결과를 유지합니다.");
          return result;
        }, input.force === true).then(result => validateSavedResult(result, scope));
      },
      fresh(input) { const scope = savedScope(input, now); return cache.fresh(savedKey(scope)); },
      info(input) { const scope = savedScope(input, now); return cache.info?.(savedKey(scope)) || null; },
      invalidate(input) { cache.invalidate(savedKey(savedScope(input, now))); },
      clear() { cache.clear(); }
    };
  }
  const savedResults = createSavedResults();
  function createController({ cache = sharedCache, fetchJson = defaultFetch, schedule = (fn, ms) => root.setTimeout(fn, ms), cancel = id => root.clearTimeout(id), isVisible = () => true, now = () => Date.now(), afterPaint = callback => typeof root.requestAnimationFrame === "function" ? root.requestAnimationFrame(() => root.requestAnimationFrame(callback)) : queueMicrotask(callback) } = {}) {
    const reader = createSavedResults({ cache, now });
    const state = { regionKey: "", regionLabel: "", mode: "summary", accountKey: "", targetMonth: "", scopeMonth: "", snapshot: null, management: null, job: null, policy: null, policyDraft: null, loading: false, starting: false, saving: false, needsStatusCheck: false, error: "", storageError: "", message: "", checkedAt: null, readSource: "", openGroups: new Set(), openDetails: new Set() };
    let host = null, revision = 0, timer = null, paused = true, contextVisible = () => true;
    let displayRevision = 0, displaySequence = 0, renderedHost = null, renderedBody = null;
    const bound = new WeakSet();
    const visible = () => !paused && host?.isConnected !== false && !root.document?.hidden && isVisible() && contextVisible();
    const scope = () => ({ accountKey: state.accountKey, regionKey: state.regionKey, month: state.targetMonth || latestCompletedMonth(now()), months: 13 });
    const cacheKey = () => savedKey(savedScope(scope(), now));
    function clearTimer() { if (timer !== null) cancel(timer); timer = null; }
    function render() {
      if (!host) return;
      const view = { ...state, nowMs: now() };
      const body = state.snapshot?.resultId ? JSON.stringify([state.accountKey, state.regionKey, state.regionLabel, state.targetMonth, state.mode,
        state.snapshot.resultId, state.snapshot.sourceFingerprint || "", state.snapshot.generatedAt || ""]) : null;
      const status = host.querySelector?.(".ra-status"), button = host.querySelector?.('[data-ra-action="status"]'), job = host.querySelector?.("[data-ra-job]");
      // An immutable result keeps its disclosure/metric DOM. Only live status
      // and job state change during a cache confirmation or polling response.
      if (state.mode !== "manage" && body && body === renderedBody && host === renderedHost && status && button && job) {
        const markup = statusHtml(view); if (status.innerHTML !== markup) status.innerHTML = markup;
        button.disabled = state.loading || !state.regionKey; button.textContent = state.loading ? "확인 중…" : "상태 확인";
        const jobMarkup = jobHtml(state.job, state.snapshot); if (job.innerHTML !== jobMarkup) job.innerHTML = jobMarkup;
      } else { host.innerHTML = renderCard(view); renderedHost = host; renderedBody = body; }
    }
    function entryStart(element) {
      const value = Number(element?.dataset?.raEntryStartedAt);
      if (element?.dataset) delete element.dataset.raEntryStartedAt;
      return Number.isFinite(value) && value > 0 && value <= now() && now() - value <= 60000 ? value : now();
    }
    function beginDisplay(startedAt = now()) {
      const entry = { revision: ++displayRevision, sequence: ++displaySequence, startedAt, recorded: false, verifying: false };
      if (host?.dataset) {
        host.dataset.raDisplayStatus = "loading";
        for (const key of ["raDisplayMs", "raDisplaySequence", "raVerifiedMs", "raVerifiedSequence", "raVerifiedAt"]) delete host.dataset[key];
        host.dataset.raVerifiedStatus = "unchecked";
      }
      return entry;
    }
    function completeDisplay(entry, { cached = false, verified = false, failed = false } = {}) {
      const element = host;
      afterPaint(() => {
        if (!entry || entry.revision !== displayRevision || element !== host || !visible() || !element?.dataset) return;
        // If the GET completed before the cached frame could paint, only its
        // completed-response callback can identify the first visible result.
        if (cached && entry.responseCompleted && !entry.recorded) return;
        const elapsed = Math.max(0, Math.round((now() - entry.startedAt) * 10) / 10);
        if (!entry.recorded) {
          entry.recorded = true; element.dataset.raDisplayMs = String(elapsed); element.dataset.raDisplaySequence = String(entry.sequence);
          element.dataset.raDisplaySource = cached ? "cache" : "server";
        }
        element.dataset.raDisplayStatus = failed ? "error" : "ready";
        element.dataset.raDisplayResultStatus = state.snapshot?.status || "missing";
        element.dataset.raDisplayResultId = state.snapshot?.resultId || "";
        element.dataset.raDisplayCheckedAt = state.checkedAt || "";
        element.dataset.raDisplayStorageError = state.storageError || "";
        if (verified) {
          entry.verifying = false; element.dataset.raVerifiedMs = String(elapsed); element.dataset.raVerifiedSequence = String(entry.sequence);
          element.dataset.raVerifiedStatus = "ready"; element.dataset.raVerifiedAt = state.checkedAt || "";
        } else element.dataset.raVerifiedStatus = failed ? "error" : entry.verifying ? "checking" : "cached";
      });
    }
    function accept(result, { preserveDraft = false } = {}) {
      validateSavedResult(result, scope());
      if (!result || !Object.hasOwn(result, "snapshot")) throw new Error("저장 결과 응답을 확인하지 못했습니다.");
      const scopeKey = result.snapshot?.scope?.regionKey || result.snapshot?.regionKey;
      if (result.snapshot && scopeKey !== state.regionKey) throw new Error("선택 지역과 다른 저장 결과입니다.");
      if (result.scope?.regionKey && result.scope.regionKey !== state.regionKey) throw new Error("선택 지역과 다른 조회 조건입니다.");
      if (result.management?.scope?.regionKey && result.management.scope.regionKey !== state.regionKey) throw new Error("선택 지역과 다른 관리 정보입니다.");
      if (result.management?.scope?.month && result.scope?.month && result.management.scope.month !== result.scope.month) throw new Error("조회 기간과 다른 관리 정보입니다.");
      const jobRegionKey = result.job?.scope?.regionKey || result.job?.regionKey;
      if (jobRegionKey && jobRegionKey !== state.regionKey) throw new Error("선택 지역과 다른 작업 결과입니다.");
      const month = result.scope?.month || result.snapshot?.scope?.month || result.job?.scope?.month;
      if (month && state.scopeMonth && month !== state.scopeMonth) state.snapshot = null;
      if (month) state.scopeMonth = month;
      state.snapshot = result.snapshot;
      state.management = result.management || null;
      state.job = result.job || null;
      state.storageError = safeCode(result.storage?.errorCode);
      state.needsStatusCheck = false;
      if (Object.hasOwn(result, "policy")) { state.policy = result.policy || null; if (!preserveDraft || !state.policyDraft) state.policyDraft = { enabled: state.policy?.enabled === true, hour: state.policy?.hour ?? 9, minute: state.policy?.minute ?? 0, intervalHours: state.policy?.intervalHours ?? 24 }; }
    }
    function poll() { clearTimer(); if (active(state.job) && visible()) timer = schedule(() => { timer = null; if (visible()) void refresh(true); }, 3000); }
    async function refresh(force = false, entry = null) {
      if (!state.regionKey || !visible() || state.loading || state.starting || state.saving) return false;
      clearTimer(); const token = revision, key = cacheKey(), input = scope(), cached = !force && reader.fresh(input);
      entry ||= beginDisplay(); entry.verifying = !cached;
      if (host?.dataset) host.dataset.raVerifiedStatus = cached ? "cached" : "checking";
      state.loading = true; state.error = ""; render();
      try {
        const result = await reader.get({ ...input, fetchJson, force });
        if (token !== revision || !visible()) return false;
        accept(result, { preserveDraft: true }); state.readSource = cached ? "cache" : "server";
        const checkedAt = reader.info(input)?.checkedAt; state.checkedAt = Number.isFinite(checkedAt) ? new Date(checkedAt).toISOString() : null; return true;
      } catch (error) { cache.invalidate(key); if (token === revision && visible()) state.error = error.message || "저장 결과 확인 실패"; return false; }
      finally { if (token === revision) { entry.responseCompleted = true; state.loading = false; render(); completeDisplay(entry, { cached, verified: !cached && !state.error && !state.storageError, failed: Boolean(state.error || state.storageError) }); if (!state.error) poll(); } }
    }
    async function start(collectMissing = false) {
      if (!visible() || !state.regionKey || state.loading || state.starting || state.saving || state.needsStatusCheck || active(state.job)) return false;
      clearTimer(); const token = ++revision; cache.invalidate(cacheKey()); state.loading = false; state.starting = true; state.error = ""; state.message = ""; render();
      try {
        const result = await fetchJson(`${ENDPOINT}/refresh`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ regionKey: state.regionKey, months: 13, collectMissing: collectMissing === true }) });
        if (token !== revision || !visible()) return false;
        if (!result?.job) throw new Error("작업 접수 여부가 불명확합니다. 상태 확인 후 다시 진행해 주세요.");
        const jobRegionKey = result.job.scope?.regionKey || result.job.regionKey;
        if (jobRegionKey && jobRegionKey !== state.regionKey) throw new Error("선택 지역과 다른 작업입니다.");
        state.job = result.job; state.message = result.reused ? "이미 진행 중인 작업을 확인합니다." : "서버에 작업을 등록했습니다.";
        cache.set(cacheKey(), { status: state.snapshot?.status || "missing", scope: { regionKey: state.regionKey, month: state.targetMonth, months: 13 }, snapshot: state.snapshot, management: state.management, job: state.job, policy: state.policy });
        return true;
      } catch (error) { if (token === revision && visible()) { state.needsStatusCheck = true; state.error = `${error.message || "작업 접수 확인 실패"} 상태 확인으로 실행 여부를 확인해 주세요.`; } return false; }
      finally { if (token === revision) { state.starting = false; render(); if (!state.error) { if (active(state.job)) poll(); else void refresh(true); } } }
    }
    function updateDraft(name, value) {
      state.policyDraft ||= { enabled: false, hour: 9, minute: 0, intervalHours: 24 };
      if (name === "enabled") state.policyDraft.enabled = value === true;
      if (name === "intervalHours") state.policyDraft.intervalHours = Number(value);
      if (name === "time" && /^([01]\d|2[0-3]):[0-5]\d$/.test(value)) { const [hour, minute] = value.split(":").map(Number); state.policyDraft.hour = hour; state.policyDraft.minute = minute; }
    }
    async function savePolicy() {
      if (!visible() || !state.regionKey || state.loading || state.saving || state.starting || active(state.job)) return false;
      const token = ++revision; cache.invalidate(cacheKey()); clearTimer(); state.loading = false; state.saving = true; state.error = ""; render();
      try {
        const body = { regionKey: state.regionKey, months: 13, ...(state.policyDraft || { enabled: false, hour: 9, minute: 0, intervalHours: 24 }) };
        const result = await fetchJson(`${ENDPOINT}/policy`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
        if (token !== revision || !visible()) return false;
        if (!result?.policy) throw new Error("저장한 갱신 설정을 확인하지 못했습니다. 상태 확인을 눌러 주세요.");
        state.policy = result.policy; state.message = "갱신 설정을 저장했습니다."; return true;
      } catch (error) { if (token === revision && visible()) state.error = error.message || "갱신 설정 저장 실패"; return false; }
      finally { if (token === revision) { state.saving = false; render(); if (!state.error) void refresh(true); } }
    }
    function stop() { clearTimer(); paused = true; revision++; displayRevision++; if (host?.dataset) host.dataset.raDisplayStatus = "paused"; if (state.starting) state.needsStatusCheck = true; state.loading = false; state.starting = false; state.saving = false; }
    function onVisibility() { if (root.document?.hidden) clearTimer(); else if (visible() && active(state.job)) void refresh(true); }
    async function mount(element, context = {}) {
      const startedAt = entryStart(element), targetMonth = context.month || latestCompletedMonth(now());
      const changed = state.regionKey !== (context.regionKey || "") || state.accountKey !== (context.accountKey || "") || state.targetMonth !== targetMonth;
      const workInFlight = !changed && (state.loading || state.starting || state.saving);
      if (changed) { clearTimer(); revision++; displayRevision++; state.snapshot = null; state.management = null; state.job = null; state.policy = null; state.policyDraft = null; state.error = ""; state.storageError = ""; state.message = ""; state.checkedAt = null; state.readSource = ""; state.scopeMonth = ""; state.loading = false; state.starting = false; state.saving = false; state.needsStatusCheck = false; state.openGroups = new Set(); state.openDetails = new Set(); }
      state.regionKey = context.regionKey || ""; state.regionLabel = context.regionLabel || "지역 미선택"; state.mode = ["summary", "sources", "manage"].includes(context.mode) ? context.mode : "summary"; state.accountKey = context.accountKey || "";
      state.targetMonth = targetMonth;
      contextVisible = context.isVisible || (() => true); if (context.fetchJson) fetchJson = context.fetchJson;
      host = element; paused = false;
      if (!bound.has(host)) {
        bound.add(host);
        host.addEventListener("click", event => { const button = event.target.closest?.("[data-ra-action]"); if (!button || button.disabled) return; if (button.dataset.raAction === "status") void refresh(true); if (button.dataset.raAction === "build") void start(false); if (button.dataset.raAction === "refresh") void start(true); });
        host.addEventListener("change", event => { const field = event.target.dataset?.raField; if (field) updateDraft(field, field === "enabled" ? event.target.checked : event.target.value); });
        host.addEventListener("submit", event => { if (!event.target.matches?.("[data-ra-policy-form]")) return; event.preventDefault(); void savePolicy(); });
        host.addEventListener("toggle", event => { const key = event.target.dataset?.raGroup, detail = event.target.dataset?.raDetail; if (key) { if (event.target.open) state.openGroups.add(key); else state.openGroups.delete(key); } if (detail) { if (event.target.open) state.openDetails.add(detail); else state.openDetails.delete(detail); } }, true);
      }
      const entry = !workInFlight && state.regionKey ? beginDisplay(startedAt) : null;
      const cached = state.regionKey && !state.needsStatusCheck ? reader.read(scope()) : null;
      if (cached && !workInFlight) {
        accept(cached, { preserveDraft: true }); state.readSource = "cache";
        const checkedAt = reader.info(scope())?.checkedAt; state.checkedAt = Number.isFinite(checkedAt) ? new Date(checkedAt).toISOString() : null;
      }
      render();
      if (!state.regionKey || !visible()) return false;
      if (workInFlight) return true;
      if (cached) completeDisplay(entry, { cached: true });
      if (!cached || !reader.fresh(scope()) || active(state.job)) return refresh(Boolean(active(state.job)), entry);
      poll(); return true;
    }
    return { state, mount, refresh, start, savePolicy, updateDraft, stop, render, onVisibility };
  }
  const controllers = new Map();
  const exported = { createController, createCache, createSavedResults, savedResults, latestCompletedMonth, renderCard, metricHtml, jobHtml, number, timeLabel,
    mount(host, context) { if (!host) return false; for (const [element, controller] of controllers) if (element.isConnected === false) { controller.stop(); controllers.delete(element); } let controller = controllers.get(host); if (!controller) { controller = createController(); controllers.set(host, controller); } return controller.mount(host, context); },
    stop(host) { if (host) controllers.get(host)?.stop(); else for (const controller of controllers.values()) controller.stop(); },
    clear() { for (const controller of controllers.values()) controller.stop(); controllers.clear(); sharedCache.clear(); }
  };
  root.document?.addEventListener?.("visibilitychange", () => { for (const controller of controllers.values()) controller.onVisibility(); });
  root.RegionalAnalysis = exported;
  if (typeof module !== "undefined" && module.exports) module.exports = exported;
})(typeof window !== "undefined" ? window : globalThis);
