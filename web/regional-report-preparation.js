(function (root) {
  "use strict";
  const ENDPOINT = "/api/regional-report-preparation";
  const STEPS = [["visitors", "방문자"], ["demandStrength", "체류·소비"], ["resourceDemand", "관광자원 수요"], ["diversity", "관광 다양성"], ["kosis", "인구·산업 통계"], ["searchTrend", "검색 트렌드"]];
  const STATUS = { unchecked: "확인 전", queued: "대기", running: "준비 중", ready: "완료", complete: "완료", partial: "일부 자료 준비", failed: "실패", publication_pending: "공표 대기", missing: "자료 없음", interrupted: "중단" };
  const active = job => ["queued", "running"].includes(job?.status);
  const escapeHtml = value => String(value ?? "").replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character]));
  const today = () => new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
  function validMonth(value) { return typeof value === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(value); }
  function validDate(value) {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const time = Date.parse(`${value}T12:00:00Z`);
    return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
  }
  function defaultMonth(now = today()) { return new Date(Date.UTC(Number(now.slice(0, 4)), Number(now.slice(5, 7)) - 1, 0)).toISOString().slice(0, 7); }
  function defaultCutoff(month, now = today()) {
    if (!validMonth(month)) return "";
    const end = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).toISOString().slice(0, 10);
    return end < now ? end : now;
  }
  function periodLabel(value) {
    const text = String(value || "");
    return text ? text.replace(/\b(\d{4})(0[1-9]|1[0-2])\b/g, "$1.$2") : "미확인";
  }
  function timeLabel(value) {
    if (!value || !Number.isFinite(Date.parse(value))) return "저장 전";
    return `${new Date(Date.parse(value) + 9 * 3600000).toISOString().slice(0, 16).replace("T", " ")} KST`;
  }
  function rowsFor(job) {
    return STEPS.map(([key, label]) => ({ key, label, status: "unchecked", ...(job?.steps || []).find(step => step.key === key) }));
  }
  function progressFor(job) {
    const total = STEPS.length, completed = Math.min(total, Math.max(0, Math.floor(Number(job?.progress?.completed) || 0)));
    return { completed, total, percent: Math.round(completed / total * 100) };
  }
  function searchErrorLabel(code) {
    return ({ MISSING_KEY: "연결 키를 설정해 주세요.", AUTH_ERROR: "연결 키 또는 이용 권한을 확인해 주세요.", QUOTA_EXCEEDED: "제공처의 요청 한도에 도달했습니다.", TIMEOUT: "제공처 응답 시간이 초과됐습니다.", NETWORK_ERROR: "제공처와 연결하지 못했습니다.", COOLDOWN: "다음 조회 가능 시각을 기다리고 있습니다.", NO_DATA: "해당 검색어·기간의 자료가 없습니다.", MISSING_VALUES: "일부 날짜의 응답이 없습니다.", PARTIAL_DATA: "일부 기간의 자료만 준비됐습니다.", PUBLICATION_PENDING: "아직 조회 가능한 날짜가 없습니다.", PROVIDER_UNAVAILABLE: "검색 트렌드 연결을 사용할 수 없습니다.", REGION_MISMATCH: "선택 지역과 다른 응답입니다.", PERIOD_MISMATCH: "요청한 기간과 다른 응답입니다.", INVALID_RESPONSE: "제공처 응답 내용을 확인하지 못했습니다.", CACHE_READ_ERROR: "저장 자료를 읽지 못했습니다.", CACHE_WRITE_ERROR: "조회 자료를 저장하지 못했습니다." })[code] || "검색 트렌드 연결 상태를 확인해 주세요.";
  }
  function renderSearchConnection(connection) {
    let label = "연결 확인 전", detail = "", failed = false;
    if (connection) {
      const success = connection.lastSuccessAt && Number.isFinite(Date.parse(connection.lastSuccessAt));
      if (connection.configured === false) label = "키 설정 필요";
      else if (connection.errorCode) { label = "최근 응답 확인 실패"; detail = searchErrorLabel(connection.errorCode); failed = true; }
      else if (success) label = `응답 확인됨 · ${timeLabel(connection.lastSuccessAt)}`;
      else if (connection.configured === true) label = "키 설정됨 · 응답 확인 전";
      if (connection.errorCode && success) detail += ` 이전 응답 확인: ${timeLabel(connection.lastSuccessAt)}`;
      if (!success && connection.lastCheckedAt && Number.isFinite(Date.parse(connection.lastCheckedAt))) detail += ` 마지막 점검: ${timeLabel(connection.lastCheckedAt)}`;
    }
    return `<div class="rrp-search-connection${failed ? " is-error" : ""}"><span>검색 트렌드 연결</span><strong>${escapeHtml(label)}</strong>${detail ? `<small>${escapeHtml(detail.trim())}</small>` : ""}</div>`;
  }
  function validForm(state) { return state.level === "local" && Boolean(state.regionKey) && validMonth(state.month) && state.month <= today().slice(0, 7) && validDate(state.cutoffDate) && state.cutoffDate <= today(); }
  function canSend(state) { return validForm(state) && Boolean(state.job) && !state.loading && !state.starting && !active(state.job) && !state.error && rowsFor(state.job).some(row => row.dataAvailable === true); }
  function renderCard(state) {
    const busy = state.loading || state.starting || active(state.job), progress = progressFor(state.job);
    const blocked = state.level !== "local" || !state.regionKey;
    const status = state.error ? "확인 필요" : state.job ? STATUS[state.job.status] || "확인 필요" : state.loading ? "저장자료 확인 중" : "준비 전";
    return `<details class="rrp-card"${state.expanded ? " open" : ""}><summary><span><span class="rrp-eyebrow">리포트 자료 준비</span><strong>${escapeHtml(state.regionLabel || "지역 미선택")}</strong></span><span class="rrp-summary-status${active(state.job) ? " is-running" : ""}"><i aria-hidden="true"></i>${escapeHtml(status)}<b>${progress.completed}/${progress.total}</b><span class="rrp-fold-label">상세</span></span></summary><div class="rrp-body">
      ${blocked ? `<p class="rrp-message">${escapeHtml(state.level === "broad" ? "시·군·구를 선택하면 지역 지표를 준비할 수 있습니다. 광역과 시군구 자료는 합산하지 않습니다." : "선택 지역의 행정구역 연결을 확인해 주세요. 다른 지역의 자료로 대체하지 않습니다.")}</p>` : ""}
      <div class="rrp-form"><label>보고월<input type="month" data-rrp-field="month" value="${escapeHtml(state.month)}" max="${today().slice(0, 7)}"${busy || blocked ? " disabled" : ""}></label><label>관측 마감일<input type="date" data-rrp-field="cutoffDate" value="${escapeHtml(state.cutoffDate)}" max="${today()}"${busy || blocked ? " disabled" : ""}></label><div class="rrp-actions"><button class="primary-button" type="button" data-rrp-action="start"${busy || state.needsStatusCheck || !validForm(state) ? " disabled" : ""}>${active(state.job) || state.starting ? "지역 지표 준비 중" : "지역 지표 일괄 수집"}</button><button class="secondary-button" type="button" data-rrp-action="send"${canSend(state) ? "" : " disabled"}>리포트로 보내기 <span aria-hidden="true">↗</span></button></div></div>
      <p class="rrp-help">저장 자료를 우선 사용하고, 없는 관광지표·검색 트렌드와 갱신이 필요한 인구·산업 통계를 준비합니다. 관측 마감일은 숙박 예약에 적용하며, 각 지표는 실제 기준기간을 표시합니다.</p>
      ${renderSearchConnection(state.searchTrendConnection)}
      <div class="rrp-progress"><progress max="${progress.total}" value="${progress.completed}" aria-label="지역 지표 준비 ${progress.completed}/${progress.total}"></progress><span>${progress.completed}/${progress.total} 항목 처리</span><button type="button" data-rrp-action="refresh"${state.loading || state.starting || blocked ? " disabled" : ""}>상태 확인</button></div>
      <div class="rrp-live${state.error ? " is-error" : ""}" role="status" aria-live="polite">${escapeHtml(state.error || state.message || (active(state.job) ? "자료를 준비하고 있습니다. 화면을 이동해도 서버에서 계속 진행됩니다." : ""))}</div>
      <ul class="rrp-steps">${rowsFor(state.job).map(row => {
        const periods = Array.isArray(row.periods) ? row.periods : [];
        const search = row.key === "searchTrend", keyword = search ? row.keyword || state.job?.searchKeyword || "" : "";
        const actualPeriod = search && validDate(row.startDate) && validDate(row.endDate) ? `${row.startDate} ~ ${row.endDate}` : row.period || periods.map(part => part.period).filter(Boolean).filter((value, index, values) => values.indexOf(value) === index).join(" · ");
        const period = row.status === "publication_pending" ? `${periodLabel(row.requestedPeriod || state.month.replace("-", ""))} 공표 대기` : actualPeriod ? `기준 ${periodLabel(actualPeriod)}` : "기준기간 미확인";
        const storedAt = row.retrievedAt || periods.map(part => part.retrievedAt).filter(Boolean).sort().at(-1) || "";
        const detail = search ? [row.partialMonth ? "월 마감 전 자료 · 전날까지의 일부 기간" : "", row.errorCode ? searchErrorLabel(row.errorCode) : row.status === "missing" ? "해당 검색어·기간의 자료가 없습니다." : row.status === "failed" || row.status === "interrupted" ? "검색 트렌드 연결 상태를 확인해 주세요." : row.cacheReused ? "저장자료 사용" : ""].filter(Boolean).join(" · ") : row.status === "publication_pending" ? "아직 공표되지 않은 월입니다." : row.status === "failed" || row.status === "interrupted" ? "연결 상태를 확인해 주세요." : row.cacheReused ? "저장자료 사용" : row.status === "missing" ? "제공 자료를 확인하지 못했습니다." : "";
        return `<li><span class="rrp-step-name">${escapeHtml(row.label || row.key)}${search ? `<small class="rrp-search-keyword">기준 검색어: ${escapeHtml(keyword || "자료 준비 후 확인")}</small>` : ""}<small>${escapeHtml(detail)}</small></span><span class="rrp-step-status is-${escapeHtml(Object.hasOwn(STATUS, row.status) ? row.status : "unchecked")}">${escapeHtml(row.status === "partial" ? "일부 완료" : STATUS[row.status] || "확인 필요")}</span><div class="rrp-step-period">${escapeHtml(period)}${periods.length ? `<details class="rrp-period-details"><summary>지표별 기준기간 <span>${periods.length}개</span></summary><dl>${periods.map(part => `<dt>${escapeHtml(part.label || part.key)}</dt><dd>${escapeHtml(periodLabel(part.period))}</dd>`).join("")}</dl></details>` : ""}</div><time datetime="${escapeHtml(storedAt)}">${escapeHtml(timeLabel(storedAt))}</time></li>`;
      }).join("")}</ul>
      <p class="rrp-footnote">검색 트렌드는 지역명+글램핑 기준으로 조회하며, 구 단위는 상위 지역명도 포함합니다. 0–100의 상대 관심도이며 절대 검색량이 아닙니다. 진행 중인 월은 전날까지의 일부 기간이며, 검색어·조회기간이 다른 지수를 합산하거나 직접 비교하지 않습니다.</p>
      <p class="rrp-footnote">${state.job && !active(state.job) && state.job.status !== "complete" ? "일부 자료가 부족하면 준비된 항목과 누락 안내를 함께 리포트로 보냅니다. " : ""}리포트로 이동한 뒤 내용을 검토해 저장·발행합니다.</p>
    </div></details>`;
  }
  async function request(query = "", method = "GET", body) {
    const response = await root.fetch(`${ENDPOINT}${query}`, { method, credentials: "same-origin", ...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}) });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || "지역 자료 준비 상태를 확인하지 못했습니다.");
    return result;
  }
  function createController({ api = request, onSend = () => {}, isVisible = () => true, schedule = (fn, ms) => root.setTimeout(fn, ms), cancel = id => root.clearTimeout(id) } = {}) {
    const state = { regionKey: "", regionLabel: "", level: "", month: defaultMonth(), cutoffDate: "", job: null, searchTrendConnection: null, loading: false, starting: false, needsStatusCheck: false, expanded: true, message: "", error: "" };
    state.cutoffDate = defaultCutoff(state.month);
    let container = null, timer = null, revision = 0, paused = true;
    const bound = new WeakSet();
    const visible = () => !paused && isVisible() && container?.isConnected !== false;
    function clearTimer() { if (timer !== null) cancel(timer); timer = null; }
    function render() { if (container) container.innerHTML = renderCard(state); }
    function queuePoll() { clearTimer(); if (active(state.job) && visible()) timer = schedule(() => { timer = null; if (visible()) void refresh(); }, 2000); }
    function accept(result) {
      if (!result || !Object.hasOwn(result, "job")) throw new Error("자료 준비 상태 응답을 확인하지 못했습니다.");
      const job = result?.job || null;
      if (job && (job.regionKey !== state.regionKey || job.month !== state.month || !Array.isArray(job.steps))) throw new Error("선택 지역·보고월과 다른 준비 결과입니다. 상태를 다시 확인해 주세요.");
      state.job = job;
      if (Object.hasOwn(result, "searchTrendConnection")) state.searchTrendConnection = result.searchTrendConnection || null;
      state.needsStatusCheck = false;
      state.message = job && !active(job) ? job.status === "complete" ? `${progressFor(job).completed}개 지표 준비를 마쳤습니다. 리포트로 보내 내용을 확인하세요.` : "자료별 준비 결과를 확인해 주세요. 공표 대기는 수집 실패와 구분합니다." : "";
    }
    async function refresh() {
      if (!visible() || state.loading || state.starting || state.level !== "local" || !state.regionKey || !validMonth(state.month)) return false;
      clearTimer(); const token = revision; state.loading = true; state.error = ""; render();
      try {
        const result = await api(`?regionKey=${encodeURIComponent(state.regionKey)}&month=${encodeURIComponent(state.month)}`);
        if (token !== revision) return false;
        accept(result); return true;
      } catch (error) { if (token === revision) { state.needsStatusCheck = true; state.error = `${error.message || "상태 확인에 실패했습니다."} 상태 확인을 눌러 다시 조회하세요.`; } return false; }
      finally { if (token === revision) { state.loading = false; render(); if (!state.error) queuePoll(); } }
    }
    async function start() {
      if (!visible() || !validForm(state) || state.loading || state.starting || state.needsStatusCheck || active(state.job)) return false;
      clearTimer(); const token = revision; state.starting = true; state.error = ""; state.message = "자료 준비를 시작하고 있습니다."; render();
      try {
        const result = await api("", "POST", { regionKey: state.regionKey, month: state.month, cutoffDate: state.cutoffDate });
        if (token !== revision) return false;
        if (!result?.job) throw new Error("시작 결과를 확인하지 못했습니다. 상태 확인으로 실행 여부를 확인해 주세요.");
        accept(result); return true;
      } catch (error) { if (token === revision) { state.needsStatusCheck = true; state.error = `${error.message || "시작 결과를 확인하지 못했습니다."} 재실행 전에 상태 확인으로 진행 여부를 확인해 주세요.`; } return false; }
      finally { if (token === revision) { state.starting = false; render(); if (!state.error) queuePoll(); } }
    }
    function input(name, value) {
      if (state.loading || state.starting || active(state.job) || !["month", "cutoffDate"].includes(name)) return;
      state[name] = value; state.error = ""; state.message = "";
      if (name === "month") { clearTimer(); revision++; state.job = null; state.cutoffDate = defaultCutoff(value); render(); void refresh(); }
      else render();
    }
    function send() { if (!canSend(state)) return false; onSend({ type: "region", targetId: state.regionKey, month: state.month, cutoffDate: state.cutoffDate }); return true; }
    function pause() { clearTimer(); paused = true; revision++; state.loading = false; state.starting = false; }
    async function mount(element, context = {}) {
      const changed = state.regionKey !== (context.regionKey || "") || state.level !== (context.level || "");
      const resume = paused;
      if (changed) { clearTimer(); revision++; state.job = null; state.searchTrendConnection = null; state.loading = false; state.starting = false; state.needsStatusCheck = false; state.error = ""; state.message = ""; }
      state.regionKey = context.regionKey || ""; state.regionLabel = context.regionLabel || "지역 미선택"; state.level = context.level || "";
      container = element; paused = false;
      if (!bound.has(container)) {
        bound.add(container);
        container.addEventListener("click", event => { const action = event.target.closest?.("[data-rrp-action]"); if (!action || action.disabled) return; if (action.dataset.rrpAction === "start") void start(); if (action.dataset.rrpAction === "refresh") void refresh(); if (action.dataset.rrpAction === "send") send(); });
        container.addEventListener("change", event => { if (event.target.dataset?.rrpField) input(event.target.dataset.rrpField, event.target.value); });
        container.addEventListener("toggle", event => { if (event.target.matches?.("details.rrp-card")) state.expanded = event.target.open; }, true);
      }
      render();
      if (changed || resume) return refresh();
      queuePoll(); return true;
    }
    return { state, mount, refresh, start, input, send, pause, render };
  }
  let instance;
  const exported = { createController, renderCard, defaultMonth, defaultCutoff, canSend,
    show(container, context, options) { if (!instance) instance = createController(options); return instance.mount(container, context); },
    pause() { instance?.pause(); }
  };
  root.RegionalReportPreparation = exported;
  if (typeof module !== "undefined" && module.exports) module.exports = exported;
})(typeof window !== "undefined" ? window : globalThis);
