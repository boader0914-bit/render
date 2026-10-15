(function (root) {
  "use strict";
  const ENDPOINT = "/api/regional-analysis";
  const LABELS = { observed: "정상 자료", ready: "자료 확보", complete: "완료", completed: "처리 완료", superseded: "새 자료로 다시 정리", partial: "일부 자료", missing: "자료 없음", failed: "확인 실패", publication_pending: "공표 대기", unchecked: "확인 전", queued: "대기", running: "처리 중", interrupted: "중단", stale: "갱신 필요", empty: "저장 전", available: "자료 확보", planned: "준비 예정", insufficient: "자료 부족" };
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
  function safeCode(value) { return String(value || "").replace(/[^A-Z0-9_.:-]/gi, "").slice(0, 100); }
  function errorLabel(code) {
    return ({ MISSING_KEY: "연결 키 설정 필요", AUTH_ERROR: "이용 권한 확인 필요", QUOTA_EXCEEDED: "제공처 요청 한도", TIMEOUT: "제공처 응답 지연", NETWORK_ERROR: "제공처 연결 실패", NO_DATA: "해당 기간 자료 없음", PUBLICATION_PENDING: "아직 공표되지 않은 자료", PROVIDER_FAILED: "제공처 응답 확인 필요", COOLDOWN: "다음 조회 가능 시각 대기", SOURCE_FAILED: "원자료 준비 실패" })[code] || (code ? `확인 코드 ${safeCode(code)}` : "");
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
    return `<details class="ra-group" data-ra-group="${escapeHtml(group.key)}"${state.openGroups?.has(group.key) ? " open" : ""}><summary><span class="ra-group-title"><strong>${escapeHtml(group.label || group.key)}</strong><small>${group.latestPeriod ? `최근 기준 ${escapeHtml(periodLabel(group.latestPeriod))}` : "기준기간 미확인"}</small></span><span class="ra-group-coverage">${escapeHtml(coverage)}</span><span class="ra-badge is-${statusClass(shownStatus)}">${group.stale ? "이전 자료 표시" : escapeHtml(statusLabel(group.status))}</span></summary><div class="ra-group-body">${group.stale ? '<p class="ra-warning">최근 갱신을 완료하지 못해 이전 정상 자료를 표시합니다.</p>' : ""}${code ? `<p class="ra-warning">${escapeHtml(errorLabel(code))}</p>` : ""}${state.mode === "sources" ? `<dl class="ra-source-meta"><div><dt>자료 묶음</dt><dd>${escapeHtml(group.label || group.key)}</dd></div><div><dt>기준기간</dt><dd>${escapeHtml(periodLabel(group.latestPeriod))}</dd></div>${group.provider ? `<div><dt>제공처</dt><dd>${escapeHtml(group.provider)}</dd></div>` : ""}${group.updatedAt || group.retrievedAt ? `<div><dt>마지막 자료 확인</dt><dd>${escapeHtml(timeLabel(group.updatedAt || group.retrievedAt))}</dd></div>` : ""}</dl>` : ""}${metrics.length ? metrics.map(metricHtml).join("") : '<p class="ra-muted">확보된 세부 지표가 없습니다. 미확보 자료를 0으로 계산하지 않습니다.</p>'}</div></details>`;
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
    return `<div class="ra-management"><div class="ra-actions"><button type="button" data-ra-action="build"${blocked || !state.regionKey ? " disabled" : ""}>저장자료 정리</button><button class="ra-primary" type="button" data-ra-action="refresh"${blocked || !state.regionKey ? " disabled" : ""}>즉시 갱신</button></div><p class="ra-muted">저장자료 정리는 외부 자료를 요청하지 않습니다. 즉시 갱신은 필요한 자료를 확인한 뒤 산출값을 저장합니다.</p><form class="ra-policy" data-ra-policy-form><label class="ra-check"><input type="checkbox" data-ra-field="enabled"${draft.enabled ? " checked" : ""}${busy ? " disabled" : ""}>자동 갱신 사용</label><label>갱신 시각 · 한국시간<input type="time" data-ra-field="time" value="${escapeHtml(time)}" required${busy ? " disabled" : ""}></label><label>확인 간격<select data-ra-field="intervalHours"${busy ? " disabled" : ""}>${[6, 12, 24, 168].map(hours => `<option value="${hours}"${Number(draft.intervalHours) === hours ? " selected" : ""}>${hours === 168 ? "일주일" : `${hours}시간`}</option>`).join("")}</select></label><button type="submit"${busy || !state.regionKey ? " disabled" : ""}>갱신 설정 저장</button></form><p class="ra-muted">현재 설정: ${state.policy?.enabled === true ? "자동 갱신 사용" : "자동 갱신 꺼짐"}${state.policy?.nextRunAt ? ` · 다음 확인 ${escapeHtml(timeLabel(state.policy.nextRunAt))}` : ""}. 설정을 저장하기 전에는 변경되지 않습니다.</p></div>`;
  }
  function renderCard(state) {
    if (state.storageError && !state.error) state = { ...state, error: `저장 자료 확인 필요 · ${errorLabel(state.storageError)}` };
    if (state.snapshot?.scope?.month && state.targetMonth && state.snapshot.scope.month !== state.targetMonth && !state.error) state = { ...state, error: `이전 기간 저장자료 · 기준 ${state.snapshot.scope.month}` };
    const snapshot = state.snapshot, groups = Array.isArray(snapshot?.groups) ? snapshot.groups : [];
    return `<section class="regional-analysis" aria-label="저장된 지역 분석"><header class="ra-header"><div><span class="ra-eyebrow">${state.mode === "manage" ? "지역 자료 갱신 관리" : state.mode === "sources" ? "저장 자료·계산 기준" : "전체 지표 · 저장된 분석"}</span><h3>${escapeHtml(state.regionLabel || "지역 미선택")}</h3><p>각 지표에서 최근 확보한 월을 포함한 13개월 · 인구·산업은 실제 기준기간 적용</p></div><button type="button" data-ra-action="status"${state.loading || !state.regionKey ? " disabled" : ""}>${state.loading ? "확인 중…" : "상태 확인"}</button></header><div class="ra-status" role="status" aria-live="polite">${state.error ? `<p class="ra-warning">${escapeHtml(state.error)}${snapshot ? " 마지막 정상 저장 결과를 표시합니다." : ""}</p>` : state.message ? `<p>${escapeHtml(state.message)}</p>` : ""}${snapshot ? `<p>결과 저장 <time datetime="${escapeHtml(snapshot.generatedAt || "")}">${escapeHtml(timeLabel(snapshot.generatedAt))}</time>${state.loading ? " · 변경 여부 확인 중" : ""}</p>` : `<p>${!state.regionKey ? "분석할 지역을 선택해 주세요." : state.loading ? "저장된 결과를 확인하고 있습니다." : "저장된 분석이 없습니다. 지역 자료 관리에서 저장자료를 정리하거나 갱신해 주세요."}</p>`}</div>${jobHtml(state.job, snapshot)}${state.mode === "manage" ? managementHtml(state) : ""}${groups.length ? `<div class="ra-groups">${groups.map(group => groupHtml(group, state)).join("")}</div>` : ""}<details class="ra-method"><summary>계산·표시 기준</summary><p>조회는 저장된 결과를 사용합니다. 정상 응답의 0은 표시하고, 오류·누락·공표 대기는 0으로 바꾸지 않습니다. 지표별 기준월이 다르면 각 기준월을 유지합니다.</p><p>네이버 검색 트렌드는 같은 검색어·조회기간 안의 상대 관심도입니다. 다른 조회 구간의 지수를 단순 합산하지 않습니다.</p><p>이번 달 예상·다음 달 전망은 지역분석의 수요 전망에서 확인합니다. 이 화면의 수치는 공식 관측자료이며 예상값과 구별됩니다. 반경별 배후시장 분석은 별도 연결 예정입니다.</p>${snapshot?.resultId ? `<small>결과 번호 ${escapeHtml(snapshot.resultId)}</small>` : ""}</details></section>`;
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
    function remember(key, data) { entries.delete(key); entries.set(key, { data, at: now() }); while (entries.size > maxEntries) entries.delete(entries.keys().next().value); }
    return {
      read(key) { return entries.get(key)?.data || null; },
      fresh(key) { const item = entries.get(key); return Boolean(item && now() - item.at < ttl); },
      async get(key, fetcher, force = false) {
        if (flights.has(key)) return flights.get(key);
        if (!force && this.fresh(key)) return this.read(key);
        const token = generation;
        const promise = Promise.resolve().then(fetcher).then(data => { if (token === generation) remember(key, data); return data; }).finally(() => { if (flights.get(key) === promise) flights.delete(key); });
        flights.set(key, promise); return promise;
      },
      set(key, data) { remember(key, data); },
      invalidate(key) { const item = entries.get(key); if (item) item.at = -Infinity; },
      clear() { generation++; entries.clear(); flights.clear(); }
    };
  }
  const sharedCache = createCache();
  function createController({ cache = sharedCache, fetchJson = defaultFetch, schedule = (fn, ms) => root.setTimeout(fn, ms), cancel = id => root.clearTimeout(id), isVisible = () => true, now = () => Date.now() } = {}) {
    const state = { regionKey: "", regionLabel: "", mode: "summary", accountKey: "", targetMonth: "", scopeMonth: "", snapshot: null, job: null, policy: null, policyDraft: null, loading: false, starting: false, saving: false, needsStatusCheck: false, error: "", storageError: "", message: "", openGroups: new Set() };
    let host = null, revision = 0, timer = null, paused = true, contextVisible = () => true;
    const bound = new WeakSet();
    const visible = () => !paused && host?.isConnected !== false && !root.document?.hidden && isVisible() && contextVisible();
    const cacheKey = () => `${state.accountKey}\u0000${state.regionKey}\u0000${latestCompletedMonth(now())}\u000013`;
    const query = () => `${ENDPOINT}?regionKey=${encodeURIComponent(state.regionKey)}&months=13`;
    function clearTimer() { if (timer !== null) cancel(timer); timer = null; }
    function render() { if (host) host.innerHTML = renderCard(state); }
    function accept(result, { preserveDraft = false } = {}) {
      if (!result || !Object.hasOwn(result, "snapshot")) throw new Error("저장 결과 응답을 확인하지 못했습니다.");
      const scopeKey = result.snapshot?.scope?.regionKey || result.snapshot?.regionKey;
      if (result.snapshot && scopeKey !== state.regionKey) throw new Error("선택 지역과 다른 저장 결과입니다.");
      if (result.scope?.regionKey && result.scope.regionKey !== state.regionKey) throw new Error("선택 지역과 다른 조회 조건입니다.");
      const jobRegionKey = result.job?.scope?.regionKey || result.job?.regionKey;
      if (jobRegionKey && jobRegionKey !== state.regionKey) throw new Error("선택 지역과 다른 작업 결과입니다.");
      const month = result.scope?.month || result.snapshot?.scope?.month || result.job?.scope?.month;
      if (month && state.scopeMonth && month !== state.scopeMonth) state.snapshot = null;
      if (month) state.scopeMonth = month;
      state.targetMonth = latestCompletedMonth(now());
      if (result.snapshot) state.snapshot = result.snapshot;
      state.job = result.job || null;
      state.storageError = safeCode(result.storage?.errorCode);
      state.needsStatusCheck = false;
      if (Object.hasOwn(result, "policy")) { state.policy = result.policy || null; if (!preserveDraft || !state.policyDraft) state.policyDraft = { enabled: state.policy?.enabled === true, hour: state.policy?.hour ?? 9, minute: state.policy?.minute ?? 0, intervalHours: state.policy?.intervalHours ?? 24 }; }
    }
    function poll() { clearTimer(); if (active(state.job) && visible()) timer = schedule(() => { timer = null; if (visible()) void refresh(true); }, 3000); }
    async function refresh(force = false) {
      if (!state.regionKey || !visible() || state.loading || state.starting || state.saving) return false;
      clearTimer(); const token = revision, key = cacheKey(), url = query(); state.loading = true; state.error = ""; render();
      try {
        const result = await cache.get(key, () => fetchJson(url), force);
        if (token !== revision || !visible()) return false;
        accept(result, { preserveDraft: true }); return true;
      } catch (error) { cache.invalidate(key); if (token === revision && visible()) state.error = error.message || "저장 결과 확인 실패"; return false; }
      finally { if (token === revision) { state.loading = false; render(); if (!state.error) poll(); } }
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
        cache.set(cacheKey(), { snapshot: state.snapshot, job: state.job, policy: state.policy });
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
    function stop() { clearTimer(); paused = true; revision++; if (state.starting) state.needsStatusCheck = true; state.loading = false; state.starting = false; state.saving = false; }
    function onVisibility() { if (root.document?.hidden) clearTimer(); else if (visible() && active(state.job)) void refresh(true); }
    async function mount(element, context = {}) {
      const targetMonth = latestCompletedMonth(now());
      const changed = state.regionKey !== (context.regionKey || "") || state.accountKey !== (context.accountKey || "") || state.targetMonth !== targetMonth;
      const workInFlight = !changed && (state.loading || state.starting || state.saving);
      if (changed) { clearTimer(); revision++; state.snapshot = null; state.job = null; state.policy = null; state.policyDraft = null; state.error = ""; state.storageError = ""; state.message = ""; state.loading = false; state.starting = false; state.saving = false; state.needsStatusCheck = false; state.openGroups = new Set(); }
      state.regionKey = context.regionKey || ""; state.regionLabel = context.regionLabel || "지역 미선택"; state.mode = ["summary", "sources", "manage"].includes(context.mode) ? context.mode : "summary"; state.accountKey = context.accountKey || "";
      state.targetMonth = targetMonth;
      contextVisible = context.isVisible || (() => true); if (context.fetchJson) fetchJson = context.fetchJson;
      host = element; paused = false;
      if (!bound.has(host)) {
        bound.add(host);
        host.addEventListener("click", event => { const button = event.target.closest?.("[data-ra-action]"); if (!button || button.disabled) return; if (button.dataset.raAction === "status") void refresh(true); if (button.dataset.raAction === "build") void start(false); if (button.dataset.raAction === "refresh") void start(true); });
        host.addEventListener("change", event => { const field = event.target.dataset?.raField; if (field) updateDraft(field, field === "enabled" ? event.target.checked : event.target.value); });
        host.addEventListener("submit", event => { if (!event.target.matches?.("[data-ra-policy-form]")) return; event.preventDefault(); void savePolicy(); });
        host.addEventListener("toggle", event => { const key = event.target.dataset?.raGroup; if (key) { if (event.target.open) state.openGroups.add(key); else state.openGroups.delete(key); } }, true);
      }
      const cached = cache.read(cacheKey()); if (cached && !workInFlight && !state.needsStatusCheck) { try { accept(cached, { preserveDraft: true }); } catch { cache.invalidate(cacheKey()); } }
      render();
      if (!state.regionKey || !visible()) return false;
      if (workInFlight) return true;
      if (!cached || !cache.fresh(cacheKey()) || active(state.job)) return refresh(Boolean(active(state.job)));
      poll(); return true;
    }
    return { state, mount, refresh, start, savePolicy, updateDraft, stop, render, onVisibility };
  }
  const controllers = new Map();
  const exported = { createController, createCache, renderCard, metricHtml, jobHtml, number, timeLabel,
    mount(host, context) { if (!host) return false; for (const [element, controller] of controllers) if (element.isConnected === false) { controller.stop(); controllers.delete(element); } let controller = controllers.get(host); if (!controller) { controller = createController(); controllers.set(host, controller); } return controller.mount(host, context); },
    stop(host) { if (host) controllers.get(host)?.stop(); else for (const controller of controllers.values()) controller.stop(); },
    clear() { for (const controller of controllers.values()) controller.stop(); controllers.clear(); sharedCache.clear(); }
  };
  root.document?.addEventListener?.("visibilitychange", () => { for (const controller of controllers.values()) controller.onVisibility(); });
  root.RegionalAnalysis = exported;
  if (typeof module !== "undefined" && module.exports) module.exports = exported;
})(typeof window !== "undefined" ? window : globalThis);
