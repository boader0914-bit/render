(function (root) {
  "use strict";
  const ENDPOINT = "/api/regional-catchment", MAX_IMPORT_BYTES = 16 * 1024 * 1024;
  const METRICS = [["population", "인구", "명"], ["establishments", "사업체", "개"], ["workers", "종사자", "명"]];
  const RINGS = [["inner50", "0~50km"], ["outer50to100", "50km 초과~100km"], ["total100", "누적 100km"]];
  const LABELS = { unqueried: "미조회", loading: "저장자료 확인 중", missing: "자료 미확보", ready: "저장 결과", partial: "일부 자료", stale: "이전 저장 결과", failed: "조회 실패", queued: "계산 대기", running: "계산 중", interrupted: "계산 중단", observed_public: "공개값", suppressed: "비공개 포함", protected_zero: "공개보호 0 포함", not_acquired: "자료 미확보", not_provided: "미제공" };
  const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const finite = value => typeof value === "number" && Number.isFinite(value);
  const number = value => finite(value) ? value.toLocaleString("ko-KR", { maximumFractionDigits: 2 }) : "—";
  const coordinateLabel = value => finite(value) ? value.toLocaleString("ko-KR", { maximumFractionDigits: 6, useGrouping: false }) : "—";
  const label = value => LABELS[value] || "확인 필요";
  const safeUrl = value => { try { const url = new URL(value); return /^https?:$/.test(url.protocol) ? url.href : ""; } catch { return ""; } };
  const clock = value => value && Number.isFinite(Date.parse(value)) ? `${new Date(Date.parse(value) + 9 * 3600000).toISOString().slice(0, 16).replace("T", " ")} KST` : "저장 전";
  const active = job => ["queued", "running"].includes(job?.status);
  const keyOf = input => `${String(input.accountKey || "")}\n${String(input.regionKey || "")}`;
  const year = (dataset, metric) => typeof dataset?.sourceYear === "object" ? String(dataset.sourceYear[metric] || "미확인") : String(dataset?.sourceYear || "미확인");
  function checkedResult(value, regionKey) {
    if (!value || value.scope?.regionKey !== regionKey || (value.snapshot && value.snapshot.scope?.regionKey !== regionKey)) throw Error("선택한 지역과 저장 결과의 범위가 다릅니다.");
    if (!Object.hasOwn(value, "snapshot") || !["unqueried", "missing", "ready", "partial", "stale", "failed"].includes(value.status)) throw Error("저장 결과의 응답 형식을 확인할 수 없습니다.");
    if (!value.snapshot && value.storage?.errorCode) throw Error("저장 결과를 읽지 못했습니다. 마지막 정상 결과를 유지합니다.");
    return value;
  }
  function viewModel(result, { loading = false, error = "" } = {}) {
    const snapshot = result?.snapshot || null, config = result?.configuration || null;
    const state = !result ? loading ? "loading" : error ? "failed" : "unqueried" : error && !snapshot ? "failed" : snapshot ? error || result.storage?.errorCode ? "stale" : result.status || "ready" : loading ? "loading" : "missing";
    const reason = !result ? loading ? "저장된 공간 집계를 확인하고 있습니다." : error || "저장자료를 아직 조회하지 않았습니다."
      : !config?.center?.confirmed ? "중심점 미설정 · 확인한 위도·경도와 출처를 먼저 저장하세요."
      : !config.datasetId ? "격자 미반입 · 준비한 공간자료를 가져온 뒤 자료를 선택하세요."
      : !snapshot ? active(result.job) ? "반입한 격자로 집계 중입니다. 제공기관 API는 호출하지 않습니다." : "아직 저장된 산출값이 없습니다. 저장자료 계산을 실행하세요."
      : error ? `${error} 마지막 저장 결과를 유지합니다.` : "연간 기초자료입니다. 관광수요·예약률 또는 이동시간을 뜻하지 않습니다.";
    const cards = RINGS.map(([key, fallback]) => {
      const ring = snapshot?.rings?.find(item => item.key === key), coverage = ring?.coverage;
      return { key, label: ring?.label || fallback, coverage: coverage || null, metrics: METRICS.map(([metricKey, metricLabel, defaultUnit]) => {
        const metric = ring?.metrics?.[metricKey], exact = metric?.status === "observed_public" && finite(metric.value) && coverage?.completeFrame === true && coverage?.bboxContainsCircle === true
          && !metric.missingCells && !metric.suppressedCells && !metric.protectedZeroCells;
        return { key: metricKey, label: metricLabel, status: metric?.status || (result && !loading ? "not_acquired" : state), value: exact ? metric.value : null,
          publishedSum: exact || !metric ? null : finite(metric.publishedSum) ? metric.publishedSum : null,
          unit: metric?.unit || defaultUnit, sourceYear: snapshot ? year(snapshot.dataset, metricKey) : "", knownCells: metric?.knownCells,
          missingCells: metric?.missingCells, suppressedCells: metric?.suppressedCells, protectedZeroCells: metric?.protectedZeroCells };
      }) };
    });
    return { status: state, reason, snapshot, configuration: config, cards, loading, error, job: result?.job || null };
  }
  function resultHtml(result, input = {}) {
    const model = viewModel(result, input), snapshot = model.snapshot, dataset = snapshot?.dataset || {}, sourceUrl = safeUrl(dataset.sourceUrl);
    return `<div class="rc-status-line" role="status"><span class="rc-badge is-${esc(model.status)}">${esc(label(model.status))}</span><span>${esc(model.reason)}</span>${model.loading && snapshot ? '<span class="rc-loading">변경 확인 중</span>' : ""}</div>
      <p class="rc-basis">인구는 거주지 기반, 사업체·종사자는 사업장 기반입니다. 서로 더해 시장규모로 계산하지 않습니다.${snapshot ? ` 산업분류: <strong>${esc(dataset.industryClassification || "미확인")}</strong>` : ""} 누적 100km는 두 구간의 합이며 다시 더하지 않습니다.</p>
      <div class="rc-grid">${model.cards.map(card => `<article class="rc-ring" data-rc-ring="${card.key}" data-rc-coverage="${esc(card.coverage?.status || "unchecked")}"><h4>${esc(card.label)}</h4><dl>${card.metrics.map(metric => `<div data-rc-metric="${metric.key}" data-rc-status="${esc(metric.status)}" data-rc-value="${metric.value ?? ""}" data-rc-published-sum="${metric.publishedSum ?? ""}" data-rc-year="${esc(metric.sourceYear)}"><dt>${metric.label}${metric.sourceYear ? `<small>${esc(metric.sourceYear)}년</small>` : ""}</dt><dd><strong>${number(metric.value)}</strong><span>${esc(metric.unit)}</span>${metric.publishedSum !== null ? `<small class="rc-partial">확보 자료의 공개합 ${number(metric.publishedSum)} ${esc(metric.unit)}</small>` : ""}<small>${esc(label(metric.status))}</small></dd></div>`).join("")}</dl>${card.coverage ? `<p class="rc-coverage">${card.coverage.completeFrame === true && card.coverage.bboxContainsCircle === true ? "공간 범위 확보 · 관리자 선언 기준" : "공간 확보범위 부족 · 반경 전체값 미확정"}</p><details class="rc-counts" data-rc-detail="counts:${card.key}"><summary>공개보호·누락 격자 확인</summary><p>집계 격자 ${number(card.coverage.selectedCells)} · 경계 접촉 ${number(card.coverage.boundaryCells)} (중심점 기준 근사)</p>${card.metrics.map(metric => `<p>${metric.label}: 정상 ${number(metric.knownCells)} · 보호 0 ${number(metric.protectedZeroCells)} · 비공개 ${number(metric.suppressedCells)} · 미확보 ${number(metric.missingCells)}</p>`).join("")}</details>` : `<p class="rc-coverage">${model.status === "unqueried" || model.status === "loading" ? "공간 확보범위 확인 전" : "공간자료 미확보"}</p>`}</article>`).join("")}</div>
      ${active(model.job) ? `<p class="rc-job"><span class="rc-spinner" aria-hidden="true"></span>${esc(label(model.job.status))} · 저장된 결과를 유지합니다.</p>` : model.job?.errorCode ? `<p class="rc-warning">집계 확인 필요 · ${esc(model.job.errorCode)}</p>` : ""}
      ${snapshot ? `<details class="rc-method" data-rc-detail="method"><summary>기준점·출처·집계 기준 <span>산출 ${esc(clock(snapshot.calculatedAt))}</span></summary><dl class="rc-facts"><div><dt>확인한 중심점</dt><dd>${esc(snapshot.scope?.center?.label || "명칭 없음")} · ${coordinateLabel(snapshot.scope?.center?.latitude)}, ${coordinateLabel(snapshot.scope?.center?.longitude)}</dd></div><div><dt>통계 출처</dt><dd>${esc(dataset.provider || "미확인")}${sourceUrl ? ` · <a href="${esc(sourceUrl)}" target="_blank" rel="noopener noreferrer">출처 열기 ↗</a>` : ""}</dd></div><div><dt>공간 기준</dt><dd>경계 ${esc(dataset.boundaryYear || "미확인")}년 · ${number(dataset.gridSizeM)}m 격자 · WGS84</dd></div><div><dt>집계 방식</dt><dd>직선거리 · 격자 중심점 포함 · 50km 경계는 안쪽 구간에 포함</dd></div><div><dt>산업분류</dt><dd>${esc(dataset.industryClassification || "미확인")}</dd></div><div><dt>해석 범위</dt><dd>보호 0·비공개·미확보가 있으면 반경 전체값은 미확정이며, 공개된 수량만 별도 표시합니다. 경계와 겹치는 격자는 중심점 기준의 근삿값입니다.</dd></div></dl></details>` : ""}`;
  }
  function draftFrom(result) {
    const config = result?.configuration, center = config?.center || {};
    return { latitude: center.latitude ?? "", longitude: center.longitude ?? "", label: center.label || "", sourceUrl: center.sourceUrl || "", confirmed: center.confirmed === true, datasetId: config?.datasetId || "" };
  }
  function editorHtml(result, draft) {
    const datasets = result?.datasets || [], catalog = result?.sourceCatalog || [];
    return `<details class="rc-editor" data-rc-detail="editor"><summary>기준점·공간자료 관리</summary><div class="rc-editor-body"><p class="rc-muted">자동 추정 위치는 사용하지 않습니다. 확인한 기준점과 반입한 격자로만 계산합니다.</p>
      <form data-rc-form="configure"><div class="rc-fields"><label>기준점 명칭 <span>*</span><input name="label" required maxlength="120" value="${esc(draft.label)}" placeholder="확인한 매장 또는 지역 기준점"></label><label>위도 <span>*</span><input name="latitude" type="number" step="any" min="-90" max="90" required value="${esc(draft.latitude)}"></label><label>경도 <span>*</span><input name="longitude" type="number" step="any" min="-180" max="180" required value="${esc(draft.longitude)}"></label><label class="rc-wide">기준점 출처 URL <span>*</span><input name="sourceUrl" type="url" required maxlength="1000" value="${esc(draft.sourceUrl)}" placeholder="https://"></label><label class="rc-wide">계산할 반입 자료 <span>*</span><select name="datasetId" required><option value="">자료 선택${datasets.length ? "" : " · 격자 미반입"}</option>${datasets.map(dataset => `<option value="${esc(dataset.id)}"${dataset.id === draft.datasetId ? " selected" : ""}>${esc(dataset.provider)} · ${esc(typeof dataset.sourceYear === "object" ? Object.values(dataset.sourceYear).join("/") : dataset.sourceYear)}년 · ${number(dataset.gridSizeM)}m · ${esc(dataset.industryClassification || "분류 미확인")} · ${esc(dataset.id)}</option>`).join("")}</select></label><label class="rc-confirm rc-wide"><input name="confirmed" type="checkbox"${draft.confirmed ? " checked" : ""} required>좌표와 출처를 확인했으며 이 위치를 반경의 중심점으로 사용합니다. <span>*</span></label></div><div class="rc-actions"><button type="submit" data-rc-action="configure">기준점 저장</button><button type="button" data-rc-action="refresh">저장자료 계산</button></div></form>
      <details class="rc-import" data-rc-detail="import"><summary>정규화 격자 JSON 가져오기</summary><p class="rc-muted">SGIS 원본 CSV·경계를 WGS84 격자 중심점 형식으로 준비한 파일을 가져옵니다. 16MiB·50,000개 격자 이내이며 통계연도·경계연도·출처·원본 해시가 필요합니다. 업로드는 제공기관 API를 호출하지 않습니다.</p><form data-rc-form="import"><label>반입 파일<input type="file" accept="application/json,.json" name="datasetFile" required></label><button type="submit" data-rc-action="import">공간자료 반입</button></form><details class="rc-schema" data-rc-detail="schema"><summary>반입 형식 · 빈 예제 확인</summary><p class="rc-muted">아래는 자료가 없는 형식 예제입니다. cells가 비어 있으면 분석자료로 사용할 수 없습니다. SGIS의 보호 0은 정상 0으로 바꾸지 않습니다.</p><pre>${esc(JSON.stringify({ id: "자료식별자", provider: "SGIS", sourceUrl: "https://sgis.mods.go.kr/view/pss/openDataIntrcn", sourceYear: "확인한 통계연도", boundaryYear: "확인한 경계연도", gridSizeM: 1000, crs: "EPSG:4326", sourceSha256: "원본통계SHA256", boundarySha256: "원본경계SHA256", industryClassification: "자료의 산업분류", coverageBBox: ["최소경도", "최소위도", "최대경도", "최대위도"], completeFrame: false, units: { population: "명", establishments: "개", workers: "명" }, cells: [] }, null, 2))}</pre><p class="rc-muted">격자: id, latitude, longitude 및 population·establishments·workers의 {status,value}. status: observed_public, protected_zero, suppressed, not_provided, not_acquired.</p></details></details>
      ${catalog.length ? `<details class="rc-sources" data-rc-detail="sources"><summary>활용 가능한 공간자료·준비 안내</summary><ul>${catalog.map(source => `<li><strong>${esc(source.label || source.provider)}</strong>${safeUrl(source.url) ? ` · <a href="${esc(safeUrl(source.url))}" target="_blank" rel="noopener noreferrer">제공처 안내 ↗</a>` : ""}<p class="rc-muted">${esc(source.note || "")}</p></li>`).join("")}</ul></details>` : ""}</div></details>`;
  }
  async function defaultFetch(url, options) {
    const response = await root.fetch(url, { credentials: "same-origin", ...options });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw Error(body.message || body.error || `서버 응답 ${response.status}`);
    return body;
  }
  function createReader() {
    const values = new Map(), flights = new Map(), generations = new Map();
    return { read(input) { return values.get(keyOf(input)) || null; },
      async get(input) {
        const key = keyOf(input), generation = generations.get(key) || 0;
        if (flights.has(key)) return flights.get(key);
        const promise = Promise.resolve().then(() => input.fetchJson(`${ENDPOINT}?regionKey=${encodeURIComponent(input.regionKey)}`)).then(result => {
          checkedResult(result, input.regionKey); if ((generations.get(key) || 0) === generation) values.set(key, result); return result;
        }).finally(() => { if (flights.get(key) === promise) flights.delete(key); });
        flights.set(key, promise); return promise;
      }, invalidate(input) { const key = keyOf(input); generations.set(key, (generations.get(key) || 0) + 1); flights.delete(key); },
      accept(input, result) { checkedResult(result, input.regionKey); const key = keyOf(input); generations.set(key, (generations.get(key) || 0) + 1); flights.delete(key); values.set(key, result); },
      clear(accountKey) { for (const key of new Set([...values.keys(), ...flights.keys()])) if (accountKey === undefined || key.startsWith(`${accountKey}\n`)) { generations.set(key, (generations.get(key) || 0) + 1); values.delete(key); flights.delete(key); } }
    };
  }
  const savedResults = createReader();
  function createController({ reader = savedResults, fetchJson = defaultFetch, now = () => typeof root.performance?.now === "function" ? root.performance.now() : Date.now(), schedule = (fn, ms) => root.setTimeout(fn, ms), cancel = id => root.clearTimeout(id), afterPaint = fn => typeof root.requestAnimationFrame === "function" ? root.requestAnimationFrame(() => root.requestAnimationFrame(fn)) : queueMicrotask(fn) } = {}) {
    let host, context = {}, revision = 0, paused = true, timer, boundHost;
    const state = { result: null, loading: false, error: "", draft: null, dirty: false, draftRevision: 0, busy: false, actionMessage: "", displaySequence: 0 };
    const visible = () => !paused && host?.isConnected !== false && (context.isVisible?.() ?? true);
    const current = (entry, key) => visible() && revision === entry && keyOf(context) === key;
    function clearTimer() { if (timer !== undefined) { cancel(timer); timer = undefined; } }
    function setAttributes() {
      if (!host?.dataset) return;
      Object.assign(host.dataset, { rcRegion: context.regionKey || "", rcResult: state.result?.snapshot?.resultId || "", rcStatus: viewModel(state.result, state).status, rcSequence: String(state.displaySequence), rcLoading: String(state.loading) });
    }
    function setBusy() {
      for (const button of host?.querySelectorAll?.("[data-rc-action]") || []) button.disabled = state.busy;
      const message = host?.querySelector?.("[data-rc-message]"); if (message) message.textContent = state.actionMessage;
    }
    function renderResults() {
      const slot = host?.querySelector?.("[data-rc-results]");
      const open = [...(slot?.querySelectorAll?.("details[open][data-rc-detail]") || [])].map(node => node.getAttribute("data-rc-detail"));
      if (slot) { slot.innerHTML = resultHtml(state.result, state); for (const key of open) { const detail = slot.querySelector?.(`[data-rc-detail="${key}"]`); if (detail) detail.open = true; } }
      else if (host && !host.querySelector) host.innerHTML = resultHtml(state.result, state);
      setAttributes(); setBusy();
    }
    function renderEditor(force = false) {
      const slot = host?.querySelector?.("[data-rc-editor-slot]");
      if (!slot || (state.dirty && !force)) return;
      const open = new Set([...(slot.querySelectorAll?.("details[open]") || [])].map(node => node.getAttribute("data-rc-detail")).filter(Boolean));
      const html = editorHtml(state.result, state.draft || draftFrom(state.result));
      if (slot.innerHTML === html) return;
      slot.innerHTML = html;
      for (const key of open) { const detail = slot.querySelector?.(`[data-rc-detail="${key}"]`); if (detail) detail.open = true; }
      setBusy();
    }
    function paintReceipt(started, entry, key, source) {
      afterPaint(() => {
        if (!current(entry, key)) return;
        if (host.dataset.rcDisplayStatus === "ready") return;
        const milliseconds = Math.round(Math.max(0, now() - started) * 10) / 10;
        Object.assign(host.dataset, { rcDisplayStatus: "ready", rcDisplayMs: String(milliseconds), rcReadSource: source });
        context.onDisplay?.({ regionKey: context.regionKey, accountKey: context.accountKey, resultId: state.result?.snapshot?.resultId || "", milliseconds, sequence: state.displaySequence, source });
      });
    }
    function queuePoll(entry, key) {
      clearTimer(); if (!current(entry, key) || !active(state.result?.job)) return;
      timer = schedule(() => { timer = undefined; if (current(entry, key)) void load(entry, key, now(), "server"); }, 1500);
    }
    async function load(entry, key, started, source) {
      state.loading = true; renderResults();
      try {
        const result = await reader.get({ ...context, fetchJson }); if (!current(entry, key)) return;
        state.result = result; state.error = "";
        if (!state.dirty) { state.draft = draftFrom(result); renderEditor(); }
      } catch (error) { if (!current(entry, key)) return; state.error = error.message || "저장자료 조회 실패"; }
      finally { if (current(entry, key)) { state.loading = false; renderResults(); paintReceipt(started, entry, key, source); queuePoll(entry, key); } }
    }
    async function mutate(path, body) {
      if (!visible() || state.busy) return;
      const entry = revision, key = keyOf(context), draftRevision = state.draftRevision; clearTimer(); state.busy = true; state.actionMessage = "처리 중입니다."; setBusy();
      let accepted = false;
      try {
        const result = await fetchJson(`${ENDPOINT}/${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
        if (!current(entry, key)) return;
        accepted = true;
        if (result.scope) { reader.accept(context, result); state.result = result; }
        else {
          // Mutation responses contain a receipt, not a full GET envelope.
          // Detach any older read and confirm the published server state once.
          reader.invalidate(context); state.loading = true; renderResults();
          const confirmed = await reader.get({ ...context, fetchJson });
          if (!current(entry, key)) return;
          state.result = confirmed; state.loading = false;
        }
        if (path === "configure" && state.draftRevision === draftRevision) { state.dirty = false; state.draft = draftFrom(state.result); }
        state.actionMessage = path === "configure" ? "기준점을 저장했습니다. 저장자료 계산을 실행하세요." : path === "datasets" ? "공간자료를 반입했습니다. 계산할 자료를 선택해 저장하세요." : result.reused && !active(result.job) ? "입력이 같아 저장된 산출값을 재사용했습니다." : "저장자료 계산을 요청했습니다.";
        if (path === "configure" && state.dirty) state.actionMessage = "요청 당시 기준점을 저장했습니다. 그 뒤 입력한 변경사항은 아직 저장하지 않았습니다.";
        state.error = ""; renderResults(); renderEditor(path === "datasets"); queuePoll(entry, key);
      } catch (error) { if (current(entry, key)) state.actionMessage = accepted ? `저장 요청 후 결과 조회를 확인하지 못했습니다. 요청을 반복하지 말고 화면을 다시 열어 확인하세요. ${error.message || ""}` : error.message || "처리하지 못했습니다."; }
      finally { if (current(entry, key)) { state.busy = false; state.loading = false; renderResults(); setBusy(); } }
    }
    function onInput(event) {
      const field = event.target, name = field?.name;
      if (!state.draft || !["latitude", "longitude", "label", "sourceUrl", "confirmed", "datasetId"].includes(name)) return;
      state.draft[name] = name === "confirmed" ? field.checked === true : field.value; state.dirty = true; state.draftRevision++;
    }
    async function onSubmit(event) {
      const form = event.target, type = form?.getAttribute?.("data-rc-form"); if (!type) return;
      event.preventDefault(); if (state.busy || !visible() || form.reportValidity?.() === false) return;
      if (type === "configure") {
        const draft = state.draft, latitude = Number(draft.latitude), longitude = Number(draft.longitude);
        if (String(draft.latitude).trim() === "" || String(draft.longitude).trim() === "" || !finite(latitude) || !finite(longitude) || latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180 || !draft.confirmed || !draft.label.trim() || !safeUrl(draft.sourceUrl) || !draft.datasetId) { state.actionMessage = "확인한 기준점 명칭·좌표·출처와 확인 항목, 계산할 반입 자료를 입력하세요."; setBusy(); return; }
        await mutate("configure", { regionKey: context.regionKey, center: { latitude, longitude, label: draft.label.trim(), sourceUrl: draft.sourceUrl.trim(), confirmed: true }, datasetId: draft.datasetId || "" });
      } else if (type === "import") {
        const file = form.querySelector?.('[name="datasetFile"]')?.files?.[0];
        if (!file) return;
        if (file.size > MAX_IMPORT_BYTES) { state.actionMessage = "공간자료 파일은 16MiB 이하여야 합니다."; setBusy(); return; }
        const entry = revision, key = keyOf(context); state.busy = true; state.actionMessage = "파일 형식을 확인하고 있습니다."; setBusy();
        let value; try { value = JSON.parse(await file.text()); } catch { state.actionMessage = "JSON 형식 파일인지 확인하세요."; }
        finally { if (current(entry, key)) { state.busy = false; setBusy(); } }
        if (current(entry, key) && value !== undefined) {
          if (value === null || typeof value !== "object" || Array.isArray(value)) { state.actionMessage = "반입 규격의 JSON 객체를 선택하세요."; setBusy(); return; }
          await mutate("datasets", value);
        }
      }
    }
    function onClick(event) {
      const action = event.target?.closest?.("[data-rc-action]")?.getAttribute?.("data-rc-action");
      if (action === "refresh") {
        if (state.dirty) { state.actionMessage = "변경한 기준점과 자료 선택을 먼저 저장하세요."; setBusy(); return; }
        if (!state.result?.configuration?.center?.confirmed || !state.result?.configuration?.datasetId) { state.actionMessage = "확인한 중심점과 계산할 공간자료를 먼저 저장하세요."; setBusy(); return; }
        void mutate("refresh", { regionKey: context.regionKey });
      }
    }
    async function mount(element, input = {}) {
      if (!element || !input.regionKey) return;
      if (!paused && host === element && keyOf(input) === keyOf(context)) { context = { ...context, ...input }; return; }
      clearTimer(); paused = false; revision++; const entry = revision, started = now();
      host = element; context = { ...input }; if (input.fetchJson) fetchJson = input.fetchJson;
      if (!visible()) { stop(); return; }
      state.displaySequence++; state.result = reader.read(context); state.loading = true; state.error = ""; state.draft = draftFrom(state.result); state.dirty = false; state.draftRevision = 0; state.busy = false; state.actionMessage = "";
      Object.assign(host.dataset, { rcDisplayStatus: "pending", rcDisplayMs: "", rcReadSource: "" });
      host.innerHTML = `<section class="regional-catchment" aria-label="지역 배후시장"><header class="rc-header"><div><span class="rc-eyebrow">지역 배후시장 · 연간 기초자료</span><h3>${esc(input.regionLabel || input.regionKey)} · 50km·100km</h3><p class="rc-muted">확인한 기준점 주변의 인구·산업 분포를 저장해 재사용합니다.</p></div></header><div data-rc-results></div><div data-rc-editor-slot></div><p class="rc-action-message" role="status" data-rc-message></p></section>`;
      if (boundHost !== host) { host.addEventListener("input", onInput); host.addEventListener("change", onInput); host.addEventListener("submit", onSubmit); host.addEventListener("click", onClick); boundHost = host; }
      renderResults(); renderEditor(true); const key = keyOf(context);
      if (state.result) paintReceipt(started, entry, key, "cache");
      await load(entry, key, started, "server");
    }
    function stop() { paused = true; revision++; clearTimer(); state.loading = false; state.busy = false; if (host?.dataset) host.dataset.rcDisplayStatus = "paused"; }
    return { mount, stop, state, refreshStatus: () => visible() ? load(revision, keyOf(context), now(), "server") : Promise.resolve() };
  }
  const controllers = new WeakMap(), mounted = new Set();
  const api = { mount(host, context) { let controller = controllers.get(host); if (!controller) { controller = createController(); controllers.set(host, controller); } mounted.add(controller); return controller.mount(host, context); },
    stop(host) { if (host) { const controller = controllers.get(host); controller?.stop(); mounted.delete(controller); } else { for (const controller of mounted) controller.stop(); mounted.clear(); } }, clear(accountKey) { for (const controller of mounted) controller.stop(); mounted.clear(); savedResults.clear(accountKey); },
    createController, createReader, viewModel, resultHtml, editorHtml, checkedResult, MAX_IMPORT_BYTES };
  root.RegionalCatchment = api; if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
