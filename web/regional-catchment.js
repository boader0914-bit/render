(function (root) {
  "use strict";
  const ENDPOINT = "/api/regional-catchment", MARKET_ENDPOINT = "/api/regional-market", MAX_IMPORT_BYTES = 16 * 1024 * 1024;
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
  const keyOf = input => `${String(input.accountKey || "")}\n${String(input.regionKey || "")}\n${String(input.companyId || "")}`;
  const scopeBody = input => ({ regionKey: input.regionKey, ...(input.companyId ? { companyId: input.companyId } : {}) });
  const scopeQuery = input => `regionKey=${encodeURIComponent(input.regionKey)}${input.companyId ? `&companyId=${encodeURIComponent(input.companyId)}` : ""}`;
  const hasAddress = center => typeof center?.address === "string" && center.address.trim().length > 0;
  const year = (dataset, metric) => typeof dataset?.sourceYear === "object" ? String(dataset.sourceYear[metric] || "미확인") : String(dataset?.sourceYear || "미확인");
  function checkedResult(value, regionKey, companyId = "") {
    if (!value || value.scope?.regionKey !== regionKey || String(value.scope?.companyId || "") !== String(companyId || "")
      || (value.snapshot && (value.snapshot.scope?.regionKey !== regionKey || String(value.snapshot.scope?.companyId || "") !== String(companyId || "")))) throw Error("선택한 지역·업체와 저장 결과의 범위가 다릅니다.");
    if (!Object.hasOwn(value, "snapshot") || !["unqueried", "missing", "ready", "partial", "stale", "failed"].includes(value.status)) throw Error("저장 결과의 응답 형식을 확인할 수 없습니다.");
    if (!value.snapshot && value.storage?.errorCode) throw Error("저장 결과를 읽지 못했습니다. 마지막 정상 결과를 유지합니다.");
    return value;
  }
  function viewModel(result, { loading = false, error = "" } = {}) {
    const snapshot = result?.snapshot || null, config = result?.configuration || null;
    const state = !result ? loading ? "loading" : error ? "failed" : "unqueried" : error && !snapshot ? "failed" : snapshot ? error || result.storage?.errorCode ? "stale" : result.status || "ready" : loading ? "loading" : "missing";
    const reason = !result ? loading ? "저장된 공간 집계를 확인하고 있습니다." : error || "저장자료를 아직 조회하지 않았습니다."
      : !hasAddress(config?.center) ? config?.center?.confirmed ? "주소 확인 전 · 기존 저장 결과는 조회할 수 있습니다. 기준주소와 좌표를 대조해 저장하기 전에는 새 계산을 할 수 없습니다." : "중심점 미설정 · 기준주소와 같은 위치로 확인한 위도·경도·출처를 먼저 저장하세요."
      : !config?.center?.confirmed ? "중심점 미설정 · 기준주소와 같은 위치로 확인한 위도·경도·출처를 먼저 저장하세요."
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
      ${snapshot ? `<details class="rc-method" data-rc-detail="method"><summary>기준점·출처·집계 기준 <span>산출 ${esc(clock(snapshot.calculatedAt))}</span></summary><dl class="rc-facts"><div><dt>기준주소</dt><dd>${esc(snapshot.scope?.center?.address || "주소 확인 전 · 이전 저장 결과")}</dd></div><div><dt>확인한 중심점</dt><dd>${esc(snapshot.scope?.center?.label || "명칭 없음")} · ${coordinateLabel(snapshot.scope?.center?.latitude)}, ${coordinateLabel(snapshot.scope?.center?.longitude)}</dd></div><div><dt>통계 출처</dt><dd>${esc(dataset.provider || "미확인")}${sourceUrl ? ` · <a href="${esc(sourceUrl)}" target="_blank" rel="noopener noreferrer">출처 열기 ↗</a>` : ""}</dd></div><div><dt>공간 기준</dt><dd>경계 ${esc(dataset.boundaryYear || "미확인")}년 · ${number(dataset.gridSizeM)}m 격자 · WGS84</dd></div><div><dt>집계 방식</dt><dd>직선거리 · 격자 중심점 포함 · 50km 경계는 안쪽 구간에 포함</dd></div><div><dt>산업분류</dt><dd>${esc(dataset.industryClassification || "미확인")}</dd></div><div><dt>해석 범위</dt><dd>보호 0·비공개·미확보가 있으면 반경 전체값은 미확정이며, 공개된 수량만 별도 표시합니다. 경계와 겹치는 격자는 중심점 기준의 근삿값입니다.</dd></div></dl></details>` : ""}`;
  }
  function draftFrom(result, companyId = "", target) {
    const config = result?.configuration, center = config?.center || {};
    const address = companyId ? target?.status === "ready" ? target.address : "" : center.address || "";
    return { companyId, address, latitude: center.latitude ?? "", longitude: center.longitude ?? "", label: center.label || target?.label || "", sourceUrl: center.sourceUrl || "", confirmed: center.confirmed === true && hasAddress(center) && center.address === address, datasetId: config?.datasetId || "" };
  }
  function addressOptions(draft, addresses) {
    return `<option value="">직접 주소 입력 · 지역분석 기준주소</option>${addresses.map(target => `<option value="${esc(target.companyId)}"${target.companyId === draft.companyId ? " selected" : ""}${target.status !== "ready" ? " disabled" : ""}>${esc(target.label)} · ${target.status === "ready" ? esc(target.address) : target.status === "ambiguous" ? "주소가 여러 개 · 업체정보 확인 필요" : "주소 없음 · 업체정보 확인 필요"}</option>`).join("")}${draft.companyId && !addresses.some(target => target.companyId === draft.companyId) ? `<option value="${esc(draft.companyId)}" selected disabled>선택한 업체 · 주소 확인 필요</option>` : ""}`;
  }
  function editorHtml(result, draft, { addresses = [], addressesLoading = false, addressError = "" } = {}) {
    const datasets = result?.datasets || [], catalog = result?.sourceCatalog || [];
    return `<details class="rc-editor" data-rc-detail="editor"><summary>기준점·공간자료 관리</summary><div class="rc-editor-body"><p class="rc-muted">기준주소를 먼저 정하고, 같은 위치의 위도·경도를 출처와 대조해 입력하세요. 주소를 자동으로 좌표로 변환하지 않습니다. 행정구역 중심이나 임의 좌표를 사용하지 않습니다.</p>
      <form data-rc-form="configure"><div class="rc-fields"><label class="rc-wide">분석 기준주소 선택<select name="companyId"${addressesLoading ? " disabled" : ""}>${addressOptions(draft, addresses)}</select><small>${addressesLoading ? "등록된 업체 주소 확인 중" : addressError ? esc(addressError) : "업체 주소는 등록된 상세주소가 한 개로 확인된 경우에 선택할 수 있습니다."}</small></label><label class="rc-wide">기준주소 <span>*</span><input name="address" required maxlength="500" value="${esc(draft.address)}"${draft.companyId ? " readonly" : ""} placeholder="확인한 도로명주소 또는 지번주소"><small>${draft.companyId ? "업체정보의 등록주소입니다. 주소 수정은 업체정보에서 진행하세요." : "지역분석에서 사용할 실제 기준주소를 입력하세요."}</small></label><label>기준점 명칭 <span>*</span><input name="label" required maxlength="120" value="${esc(draft.label)}" placeholder="확인한 매장 또는 지역 기준점"></label><label>위도 <span>*</span><input name="latitude" type="number" step="any" min="-90" max="90" required value="${esc(draft.latitude)}"></label><label>경도 <span>*</span><input name="longitude" type="number" step="any" min="-180" max="180" required value="${esc(draft.longitude)}"></label><label class="rc-wide">주소·좌표 대조 출처 URL <span>*</span><input name="sourceUrl" type="url" required maxlength="1000" value="${esc(draft.sourceUrl)}" placeholder="https://"></label><label class="rc-wide">계산할 반입 자료 <span>*</span><select name="datasetId" required><option value="">자료 선택${datasets.length ? "" : " · 격자 미반입"}</option>${datasets.map(dataset => `<option value="${esc(dataset.id)}"${dataset.id === draft.datasetId ? " selected" : ""}>${esc(dataset.provider)} · ${esc(typeof dataset.sourceYear === "object" ? Object.values(dataset.sourceYear).join("/") : dataset.sourceYear)}년 · ${number(dataset.gridSizeM)}m · ${esc(dataset.industryClassification || "분류 미확인")} · ${esc(dataset.id)}</option>`).join("")}</select></label><label class="rc-confirm rc-wide"><input name="confirmed" type="checkbox"${draft.confirmed ? " checked" : ""} required>기준주소와 좌표가 같은 위치임을 출처에서 대조했으며 이 주소를 반경의 중심점으로 사용합니다. <span>*</span></label></div><div class="rc-actions"><button type="submit" data-rc-action="configure">기준점 저장</button><button type="button" data-rc-action="refresh"${!hasAddress(result?.configuration?.center) || !result?.configuration?.center?.confirmed || !result?.configuration?.datasetId ? " disabled" : ""}>저장자료 계산</button></div></form>
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
        const promise = Promise.resolve().then(() => input.fetchJson(`${ENDPOINT}?${scopeQuery(input)}`)).then(result => {
          checkedResult(result, input.regionKey, input.companyId); if ((generations.get(key) || 0) === generation) values.set(key, result); return result;
        }).finally(() => { if (flights.get(key) === promise) flights.delete(key); });
        flights.set(key, promise); return promise;
      }, invalidate(input) { const key = keyOf(input); generations.set(key, (generations.get(key) || 0) + 1); flights.delete(key); },
      accept(input, result) { checkedResult(result, input.regionKey, input.companyId); const key = keyOf(input); generations.set(key, (generations.get(key) || 0) + 1); flights.delete(key); values.set(key, result); },
      clear(accountKey) { for (const key of new Set([...values.keys(), ...flights.keys()])) if (accountKey === undefined || key.startsWith(`${accountKey}\n`)) { generations.set(key, (generations.get(key) || 0) + 1); values.delete(key); flights.delete(key); } }
    };
  }
  const savedResults = createReader();
  function createAddressController({ reader = savedResults, fetchJson = defaultFetch, now = () => typeof root.performance?.now === "function" ? root.performance.now() : Date.now(), schedule = (fn, ms) => root.setTimeout(fn, ms), cancel = id => root.clearTimeout(id), afterPaint = fn => typeof root.requestAnimationFrame === "function" ? root.requestAnimationFrame(() => root.requestAnimationFrame(fn)) : queueMicrotask(fn) } = {}) {
    let host, context = {}, revision = 0, paused = true, timer, boundHost;
    const state = { result: null, loading: false, error: "", draft: null, dirty: false, draftRevision: 0, busy: false, actionMessage: "", displaySequence: 0, addresses: [], addressesLoading: false, addressError: "" };
    const addressTarget = () => state.addresses.find(target => target.companyId === String(context.companyId || ""));
    const newDraft = result => draftFrom(result, String(context.companyId || ""), addressTarget());
    const canCalculate = () => hasAddress(state.result?.configuration?.center) && state.result?.configuration?.center?.confirmed === true && !!state.result?.configuration?.datasetId
      && (!context.companyId || (!state.addressesLoading && addressTarget()?.status === "ready" && addressTarget().address === state.result.configuration.center.address));
    const visible = () => !paused && host?.isConnected !== false && (context.isVisible?.() ?? true);
    const current = (entry, key) => visible() && revision === entry && keyOf(context) === key;
    function clearTimer() { if (timer !== undefined) { cancel(timer); timer = undefined; } }
    function setAttributes() {
      if (!host?.dataset) return;
      Object.assign(host.dataset, { rcRegion: context.regionKey || "", rcCompany: context.companyId || "", rcResult: state.result?.snapshot?.resultId || "", rcStatus: viewModel(state.result, state).status, rcSequence: String(state.displaySequence), rcLoading: String(state.loading) });
    }
    function setBusy() {
      for (const button of host?.querySelectorAll?.("[data-rc-action]") || []) button.disabled = state.busy || (button.getAttribute?.("data-rc-action") === "refresh" && !canCalculate());
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
      const html = editorHtml(state.result, state.draft || newDraft(state.result), state);
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
    async function loadAddresses(entry, key) {
      state.addressesLoading = true; state.addressError = "";
      try {
        const result = await fetchJson(`${ENDPOINT}/addresses?regionKey=${encodeURIComponent(context.regionKey)}`);
        if (!current(entry, key)) return;
        if (!Array.isArray(result?.addresses) || result.addresses.some(target => !target || typeof target.companyId !== "string" || !target.companyId
          || typeof target.label !== "string" || !["ready", "missing", "ambiguous"].includes(target.status) || (target.status === "ready" && !hasAddress(target)))
          || new Set(result.addresses.map(target => target.companyId)).size !== result.addresses.length) throw Error("등록된 업체 주소 응답을 확인할 수 없습니다.");
        state.addresses = result.addresses.map(({ companyId, label, address, status }) => ({ companyId, label, address: status === "ready" ? address : "", status }));
      } catch (error) { if (current(entry, key)) { state.addresses = []; state.addressError = error.message || "등록된 업체 주소를 읽지 못했습니다."; } }
      finally {
        if (current(entry, key)) {
          state.addressesLoading = false;
          if (!state.dirty) { state.draft = newDraft(state.result); renderEditor(); }
          else {
            // Updating only the target selector preserves typed coordinates and focus.
            if (context.companyId) {
              const target = addressTarget(), address = target?.status === "ready" ? target.address : "";
              if (state.draft.address !== address) {
                state.draft.address = address; state.draft.confirmed = false;
                const addressField = host?.querySelector?.('[name="address"]'), confirmation = host?.querySelector?.('[name="confirmed"]');
                if (addressField) addressField.value = address; if (confirmation) confirmation.checked = false;
              }
            }
            const select = host?.querySelector?.('[name="companyId"]');
            if (select) { select.disabled = false; select.innerHTML = addressOptions(state.draft, state.addresses); if (select.nextElementSibling) select.nextElementSibling.textContent = state.addressError || "업체 주소는 등록된 상세주소가 한 개로 확인된 경우에 선택할 수 있습니다."; }
          }
          setBusy();
        }
      }
    }
    async function load(entry, key, started, source) {
      state.loading = true; renderResults();
      try {
        const result = await reader.get({ ...context, fetchJson }); if (!current(entry, key)) return;
        state.result = result; state.error = "";
        if (!state.dirty) { state.draft = newDraft(result); renderEditor(); }
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
        if (path === "configure" && state.draftRevision === draftRevision) { state.dirty = false; state.draft = newDraft(state.result); }
        state.actionMessage = path === "configure" ? "기준점을 저장했습니다. 저장자료 계산을 실행하세요." : path === "datasets" ? "공간자료를 반입했습니다. 계산할 자료를 선택해 저장하세요." : result.reused && !active(result.job) ? "입력이 같아 저장된 산출값을 재사용했습니다." : "저장자료 계산을 요청했습니다.";
        if (path === "configure" && state.dirty) state.actionMessage = "요청 당시 기준점을 저장했습니다. 그 뒤 입력한 변경사항은 아직 저장하지 않았습니다.";
        state.error = ""; renderResults(); renderEditor(path === "datasets"); queuePoll(entry, key);
      } catch (error) { if (current(entry, key)) state.actionMessage = accepted ? `저장 요청 후 결과 조회를 확인하지 못했습니다. 요청을 반복하지 말고 화면을 다시 열어 확인하세요. ${error.message || ""}` : error.message || "처리하지 못했습니다."; }
      finally { if (current(entry, key)) { state.busy = false; state.loading = false; renderResults(); setBusy(); } }
    }
    function onInput(event) {
      const field = event.target, name = field?.name;
      if (!state.draft) return;
      if (name === "companyId") {
        const companyId = String(field.value || ""), target = state.addresses.find(item => item.companyId === companyId);
        if (state.busy || state.addressesLoading || (companyId && target?.status !== "ready")) { field.value = context.companyId || ""; state.actionMessage = "등록된 상세주소가 한 개로 확인된 업체를 선택하세요."; setBusy(); return; }
        if (companyId !== String(context.companyId || "")) void mount(host, { ...context, companyId: companyId || undefined });
        return;
      }
      if (!["address", "latitude", "longitude", "label", "sourceUrl", "confirmed", "datasetId"].includes(name)) return;
      if (name === "address" && context.companyId) { field.value = state.draft.address; return; }
      const previous = state.draft[name];
      state.draft[name] = name === "confirmed" ? field.checked === true : field.value; state.dirty = true; state.draftRevision++;
      if (["address", "latitude", "longitude", "sourceUrl"].includes(name) && previous !== state.draft[name]) {
        state.draft.confirmed = false; const confirmation = host?.querySelector?.('[name="confirmed"]'); if (confirmation) confirmation.checked = false;
      }
    }
    async function onSubmit(event) {
      const form = event.target, type = form?.getAttribute?.("data-rc-form"); if (!type) return;
      event.preventDefault(); if (state.busy || !visible() || form.reportValidity?.() === false) return;
      if (type === "configure") {
        const draft = state.draft, latitude = Number(draft.latitude), longitude = Number(draft.longitude);
        const target = addressTarget();
        if (String(draft.latitude).trim() === "" || String(draft.longitude).trim() === "" || !finite(latitude) || !finite(longitude) || latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180 || !hasAddress(draft) || !draft.confirmed || !draft.label.trim() || !safeUrl(draft.sourceUrl) || !draft.datasetId
          || (context.companyId && (target?.status !== "ready" || draft.address !== target.address))) { state.actionMessage = "기준주소·명칭·좌표·대조 출처와 같은 위치 확인 항목, 계산할 반입 자료를 입력하세요. 업체 주소는 등록된 주소와 일치해야 합니다."; setBusy(); return; }
        await mutate("configure", { ...scopeBody(context), center: { address: draft.address.trim(), latitude, longitude, label: draft.label.trim(), sourceUrl: draft.sourceUrl.trim(), confirmed: true }, datasetId: draft.datasetId || "" });
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
        if (!canCalculate()) { state.actionMessage = "주소 확인 전에는 새 계산을 할 수 없습니다. 기준주소와 같은 위치로 확인한 중심점·공간자료를 먼저 저장하세요. 업체 주소는 현재 등록주소와 일치해야 합니다."; setBusy(); return; }
        void mutate("refresh", scopeBody(context));
      }
    }
    async function mount(element, input = {}) {
      if (!element || !input.regionKey) return;
      // The parent refreshes this region view without owning its company choice.
      if (!Object.hasOwn(input, "companyId") && host === element && input.regionKey === context.regionKey && input.accountKey === context.accountKey && context.companyId) input = { ...input, companyId: context.companyId };
      if (!paused && host === element && keyOf(input) === keyOf(context)) { context = { ...context, ...input }; return; }
      // A mode switch pauses reads while retaining this address editor and draft.
      if (paused && input.resume === true && host === element && keyOf(input) === keyOf(context)) {
        paused = false; revision++; context = { ...context, ...input }; if (input.fetchJson) fetchJson = input.fetchJson;
        if (!visible()) { stop(); return; }
        const entry = revision, key = keyOf(context), started = now();
        Object.assign(host.dataset, { rcDisplayStatus: "pending", rcDisplayMs: "", rcReadSource: "" });
        await Promise.all([load(entry, key, started, "server"), loadAddresses(entry, key)]); return;
      }
      clearTimer(); paused = false; revision++; const entry = revision, started = now();
      host = element; context = { ...input }; if (input.fetchJson) fetchJson = input.fetchJson;
      if (!visible()) { stop(); return; }
      state.addresses = []; state.addressesLoading = true; state.addressError = "";
      state.displaySequence++; state.result = reader.read(context); state.loading = true; state.error = ""; state.draft = newDraft(state.result); state.dirty = false; state.draftRevision = 0; state.busy = false; state.actionMessage = "";
      Object.assign(host.dataset, { rcDisplayStatus: "pending", rcDisplayMs: "", rcReadSource: "" });
      host.innerHTML = `<section class="regional-catchment" aria-label="주소 기준 반경 분석"><header class="rc-header"><div><span class="rc-eyebrow">주소 기준 반경 분석 · 연간 기초자료</span><h3>${esc(input.regionLabel || input.regionKey)} · 50km·100km</h3><p class="rc-muted">확인한 상세주소 주변의 인구·산업 분포를 저장해 재사용합니다.</p></div></header><div data-rc-results></div><div data-rc-editor-slot></div><p class="rc-action-message" role="status" data-rc-message></p></section>`;
      if (boundHost !== host) { host.addEventListener("input", onInput); host.addEventListener("change", onInput); host.addEventListener("submit", onSubmit); host.addEventListener("click", onClick); boundHost = host; }
      renderResults(); renderEditor(true); const key = keyOf(context);
      if (state.result) paintReceipt(started, entry, key, "cache");
      await Promise.all([load(entry, key, started, "server"), loadAddresses(entry, key)]);
    }
    function stop() { paused = true; revision++; clearTimer(); state.loading = false; state.busy = false; if (host?.dataset) host.dataset.rcDisplayStatus = "paused"; }
    return { mount, stop, state, refreshStatus: () => visible() ? load(revision, keyOf(context), now(), "server") : Promise.resolve() };
  }
  const MARKET_LABELS = { ready: "저장 지표 확인", partial: "일부 자료 확보", missing: "자료 미확보", needs_verification: "근거 확인 필요", observed: "확인된 저장값", suppressed: "비공개", publication_pending: "공표 대기", error: "자료 확인 실패", unverified: "원본 근거 미확인" };
  const MARKET_REASONS = { REGIONAL_MARKET_NOT_ACQUIRED: "저장된 자료가 없습니다.", REGIONAL_MARKET_EVIDENCE_UNVERIFIED: "원본 근거로 지역·기간·수량의 일치를 확인하지 못했습니다.", REGIONAL_MARKET_SOURCE_ERROR: "저장 자료의 오류를 확인해야 합니다.", REGIONAL_MARKET_SOURCE_INVALID: "저장 자료의 형식을 확인해야 합니다.", REGIONAL_MARKET_DUPLICATE_DATASET: "같은 항목의 자료가 겹쳐 확인이 필요합니다.", REGIONAL_MARKET_DUPLICATE_METRIC: "같은 지표가 겹쳐 확인이 필요합니다.", SUPPRESSED: "제공기관 비공개 자료입니다.", PARTIAL_DATA: "일부 자료만 있어 전체값을 확정하지 않습니다.", PUBLICATION_PENDING: "해당 기준기간의 공표를 기다리고 있습니다." };
  const MARKET_WARNINGS = { BOUNDARY_YEAR_UNRECORDED: "행정경계 기준연도가 기록되지 않았습니다. 지표별 공표기간과 경계 확인 상태를 유지합니다." };
  const marketKey = input => `${String(input.accountKey || "")}\n${String(input.regionKey || "")}\n${String(input.month || "")}\n${String(input.months || "")}`;
  const marketQuery = input => `regionKey=${encodeURIComponent(input.regionKey)}${input.month ? `&month=${encodeURIComponent(input.month)}` : ""}${input.months ? `&months=${encodeURIComponent(input.months)}` : ""}`;
  const marketStatus = value => MARKET_LABELS[value] || label(value);
  function checkedMarketResult(value, input) {
    if (!value || value.mode !== "administrative_region" || value.originKind !== "administrative_region" || value.scope?.level !== "sigungu"
      || value.scope.regionKey !== input.regionKey || (input.month && value.scope.month !== input.month) || (input.months && value.scope.months !== input.months)) throw Error("선택한 행정구역·기간과 저장 지표의 범위가 다릅니다.");
    if (!['ready', 'partial', 'missing', 'needs_verification'].includes(value.status) || value.readOnly !== true || value.networkAttempted !== false
      || !/^\d{5}(?:\d{5})?$/.test(value.scope.officialCode || "") || !/^20\d{2}-(0[1-9]|1[0-2])$/.test(value.scope.month || "") || ![13, 24].includes(value.scope.months)
      || !Array.isArray(value.metrics) || !value.metrics.length || value.source?.kind !== "saved_regional_analysis"
      || value.visitorOrigins?.status !== "not_acquired" || value.visitorOrigins?.value !== null) throw Error("행정구역 저장 지표의 응답 형식을 확인할 수 없습니다.");
    const keys = new Set();
    for (const metric of value.metrics) {
      if (!metric || !/^[a-zA-Z][a-zA-Z0-9_]{0,60}$/.test(metric.key || "") || keys.has(metric.key) || !['observed', 'missing', 'suppressed', 'partial', 'publication_pending', 'error', 'unverified'].includes(metric.status)
        || !['M', 'Y'].includes(metric.periodType) || !metric.source || (metric.status === "observed" ? !Number.isSafeInteger(metric.value) || metric.value < 0 : metric.value !== null)) throw Error("행정구역 저장 지표의 수치 상태를 확인할 수 없습니다.");
      if (metric.status === "observed") {
        const proof = metric.source.storedProvenance;
        if (!(metric.periodType === "Y" ? /^20\d{2}$/ : /^20\d{2}-(0[1-9]|1[0-2])$/).test(metric.period || "")
          || metric.period > (metric.periodType === "Y" ? value.scope.month.slice(0, 4) : value.scope.month)
          || metric.source.provider !== "KOSIS" || !metric.source.providerRegionCode || proof?.sourceKind !== "stored_raw_response"
          || !/^[a-f0-9]{64}$/.test(proof.sha256 || "") || !proof.evidenceId || proof.period !== metric.period
          || (proof.periodType || "M") !== metric.periodType || !Number.isFinite(Date.parse(proof.verifiedAt))) throw Error("행정구역 저장 지표의 원본 근거 형식을 확인할 수 없습니다.");
      }
      keys.add(metric.key);
    }
    return value;
  }
  function marketViewModel(result, { loading = false, error = "" } = {}) {
    return { result, loading, error, status: error ? result ? "stale" : "failed" : result?.status || (loading ? "loading" : "unqueried"),
      observed: (result?.metrics || []).filter(metric => metric.status === "observed" && Number.isSafeInteger(metric.value) && metric.value >= 0).length };
  }
  function marketResultHtml(result, input = {}) {
    const model = marketViewModel(result, input), scope = result?.scope || {}, source = result?.source || {};
    const reason = model.error ? `${model.error}${result ? " 마지막 확인 결과를 유지합니다." : ""}` : !result ? model.loading ? "선택한 지역의 저장 지표를 확인하고 있습니다." : "저장 지표 조회 전입니다."
      : result.status === "missing" ? "선택한 지역의 확인된 저장 지표가 없습니다. 미확보 자료를 0으로 계산하지 않습니다."
      : result.status === "needs_verification" ? "원본 근거를 확인하지 못한 지표는 수치를 표시하지 않습니다."
      : "지표별 실제 공표기간의 저장값입니다. 기간과 단위가 다른 수치를 더하지 않습니다.";
    return `<div class="rc-status-line" role="status"><span class="rc-badge is-${esc(model.status)}">${esc(marketStatus(model.status))}</span><span>${esc(reason)}</span>${model.loading && result ? '<span class="rc-loading">변경 확인 중</span>' : ""}</div>
      <p class="rc-basis">시·군·구 행정구역 전체의 기초통계입니다. 거주인구를 고객 수로 해석하지 않으며, 실제 방문객 출발지나 외부 유입량을 뜻하지 않습니다. 주민등록 세대 수는 가구 수와 다릅니다.</p>
      ${result ? `<p class="rc-market-scope">${esc(scope.label || input.regionLabel || scope.regionKey)} · 시·군·구 전체 · 행정코드 ${esc(scope.officialCode)}<br>확보범위 ${model.observed}/${result.metrics.length}개 지표 · 조회 기준 ${esc(scope.month)} · 지표별 월간·연간 공표기간 적용 · 경계연도 ${scope.boundaryYearStatus === "recorded" && Number.isInteger(scope.boundaryYear) ? `${esc(scope.boundaryYear)}년` : "미기록"}</p>
      <div class="rc-market-grid">${result.metrics.map(metric => {
        const known = metric.status === "observed" && Number.isSafeInteger(metric.value) && metric.value >= 0, provider = metric.source || {}, proof = provider.storedProvenance, url = safeUrl(provider.sourceUrl);
        return `<article class="rc-market-metric" data-rm-metric="${esc(metric.key)}" data-rm-status="${esc(metric.status)}" data-rm-value="${known ? metric.value : ""}"><h4>${esc(metric.label || metric.key)}</h4><p class="rc-market-value"><strong>${known ? number(metric.value) : "—"}</strong><span>${esc(metric.unit || "단위 미확인")}</span></p><p class="rc-muted">${esc(marketStatus(metric.status))} · ${metric.period ? `${esc(metric.period)}${metric.periodType === "Y" ? "년 · 연간" : " · 월간"}` : "기준기간 미확인"}</p>${!known ? `<p class="rc-market-reason">${esc(MARKET_REASONS[metric.reasonCode] || "저장 근거를 확인해야 합니다.")}</p>` : ""}<p class="rc-market-source">${esc(provider.provider || "출처 미확인")}${url ? ` · <a href="${esc(url)}" target="_blank" rel="noopener noreferrer">통계표 출처 ↗</a>` : ""}${provider.tableId ? ` · 표 ${esc(provider.tableId)}` : ""}</p><details class="rc-counts" data-rc-detail="market:${esc(metric.key)}"><summary>기준기간·원본 근거</summary><dl class="rc-facts"><div><dt>통계 기준기간</dt><dd>${esc(metric.period || "미확인")} · ${metric.periodType === "Y" ? "연간" : "월간"}</dd></div><div><dt>제공 지역코드</dt><dd>${esc(provider.providerRegionCode || "미확인")}</dd></div><div><dt>자료 확인</dt><dd>${esc(clock(provider.retrievedAt))}</dd></div><div><dt>행정경계 기준연도</dt><dd>${provider.boundaryYearStatus === "recorded" && Number.isInteger(provider.boundaryYear) ? `${esc(provider.boundaryYear)}년` : "미기록"}</dd></div><div><dt>저장 원본 근거</dt><dd>${proof ? `원본 ${esc(proof.evidenceId || "미확인")} · 기준 ${esc(proof.period || "미확인")}<br>해시 ${esc(proof.sha256 || "미확인")}<br>검증 ${esc(clock(proof.verifiedAt))}` : "저장 원본 근거 미확인"}</dd></div></dl></details></article>`;
      }).join("")}</div>
      <p class="rc-muted">관광 지표는 이 기본 분석에 포함되지 않습니다. 확보된 관광 자료는 지역 지표에서 별도로 확인하세요.</p>
      <div class="rc-market-origin" data-rm-visitor-origins="not_acquired"><strong>방문객 출발지·외부 유입 · 자료 미확보</strong><p>실제 고객·방문객 거주지 자료가 없어 출발지별 고객 수와 유입량을 산출하지 않습니다.</p></div>
      ${(result.warnings || []).filter(code => MARKET_WARNINGS[code]).map(code => `<p class="rc-warning">${esc(MARKET_WARNINGS[code])}</p>`).join("")}
      <details class="rc-method" data-rc-detail="market-method"><summary>저장자료·해석 기준</summary><dl class="rc-facts"><div><dt>저장 분석 결과</dt><dd>${esc(source.resultId || "저장 전")}</dd></div><div><dt>원본 결과 생성</dt><dd>${esc(clock(source.generatedAt))}</dd></div><div><dt>저장자료 계산</dt><dd>${esc(clock(source.calculatedAt))}</dd></div><div><dt>최근 자료 확인</dt><dd>${esc(clock(result.retrievedAt))}</dd></div><div><dt>원본 결과 해시</dt><dd>${esc(source.resultSha256 || "미기록")}</dd></div></dl><p>조회는 외부 요청 없이 저장된 지역분석 자료를 사용합니다. 지표의 정상 0은 표시하고 미확보·비공개·공표 대기·미검증은 0으로 바꾸지 않습니다. 기준주소와 반경은 주소 기준 반경 분석에서 별도로 확인합니다.</p></details>` : ""}`;
  }
  function createMarketReader() {
    const values = new Map(), flights = new Map(), generations = new Map();
    return { read: input => values.get(marketKey(input)) || null,
      get(input) {
        const key = marketKey(input), generation = generations.get(key) || 0;
        if (flights.has(key)) return flights.get(key);
        const promise = Promise.resolve().then(() => input.fetchJson(`${MARKET_ENDPOINT}?${marketQuery(input)}`)).then(result => {
          checkedMarketResult(result, input); if ((generations.get(key) || 0) === generation) values.set(key, result); return result;
        }).finally(() => { if (flights.get(key) === promise) flights.delete(key); });
        flights.set(key, promise); return promise;
      }, clear(accountKey) { for (const key of new Set([...values.keys(), ...flights.keys()])) if (accountKey === undefined || key.startsWith(`${accountKey}\n`)) { generations.set(key, (generations.get(key) || 0) + 1); values.delete(key); flights.delete(key); } }
    };
  }
  const savedMarkets = createMarketReader();
  function createRegionController({ marketReader = savedMarkets, fetchJson = defaultFetch, afterPaint = fn => typeof root.requestAnimationFrame === "function" ? root.requestAnimationFrame(() => root.requestAnimationFrame(fn)) : queueMicrotask(fn), now = () => typeof root.performance?.now === "function" ? root.performance.now() : Date.now() } = {}) {
    let host, context = {}, revision = 0, paused = true;
    const state = { result: null, loading: false, error: "", displaySequence: 0, missingBusy: false, missingMessage: "", weeklyBusy: false, weeklyMessage: "", weeklyResult: null };
    const visible = () => !paused && host?.isConnected !== false && (context.isVisible?.() ?? true);
    function render() {
      const slot = host?.querySelector?.("[data-rm-results]"), open = [...(slot?.querySelectorAll?.("details[open][data-rc-detail]") || [])].map(node => node.getAttribute("data-rc-detail"));
      if (slot) { slot.innerHTML = marketResultHtml(state.result, state); for (const key of open) { const detail = slot.querySelector?.(`[data-rc-detail="${key}"]`); if (detail) detail.open = true; } }
      Object.assign(host.dataset, { rcRegion: context.regionKey, rcMode: "administrative_region", rcStatus: marketViewModel(state.result, state).status, rcLoading: String(state.loading), rcSequence: String(state.displaySequence), rcResult: state.result?.source?.resultId || "" });
      const commandBusy = state.missingBusy || state.weeklyBusy;
      const button = host.querySelector?.('[data-rm-action="status"]'); if (button) button.disabled = state.loading || commandBusy;
      for (const control of host.querySelectorAll?.('[data-rm-missing]') || []) control.disabled = commandBusy;
      const receipt = host.querySelector?.('[data-rm-missing-receipt]'); if (receipt) receipt.textContent = state.missingMessage;
      for (const control of host.querySelectorAll?.('[data-rm-weekly]') || []) control.disabled = commandBusy || control.getAttribute("data-rm-weekly") === "enable" && state.weeklyResult?.enabled === true;
      const weeklyReceipt = host.querySelector?.('[data-rm-weekly-receipt]'); if (weeklyReceipt) weeklyReceipt.textContent = state.weeklyMessage || "주 1회 자동 확인 설정은 아직 조회하지 않았습니다.";
    }
    async function checkMissing(collect) {
      if (!visible() || state.missingBusy || state.weeklyBusy) return;
      const entry = revision, key = marketKey(context); state.missingBusy = true; state.missingMessage = "주간 누락 확인 상태를 읽고 있습니다."; render();
      try {
        const value = await fetchJson(`${MARKET_ENDPOINT}/missing-check`, collect ? { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" } : undefined);
        if (entry !== revision || !visible() || key !== marketKey(context)) return;
        const job = value?.job, names = { queued: "대기", running: "확인 중", complete: "완료", partial: "일부 보완·확인 필요", failed: "실행 오류", blocked: "보호·호출 한도 확인 필요", needs_verification: "검수 필요" };
        if (job && (!names[job.status] || !job.counts || !job.inventory)) throw Error("누락 확인 응답을 검증하지 못했습니다.");
        const count = job?.counts || {};
        state.missingMessage = !job ? "아직 주간 확인 이력이 없습니다." : `${names[job.status]} · 대상 ${number(job.inventory.eligibleRegionCount)}개 지역 · 확인 ${number(count.inspectedRegions)}개 · 미확인 ${number(job.inventory.eligibleRegionCount - count.inspectedRegions)}개 · 통계 확보 ${number(count.collectedDatasets)}건 · 확인분 미확보 ${number(count.missingDatasets)}건 · 보류 ${number(count.heldDatasets)}건 · 실행 여부 미확인 ${number(count.unknownAttemptRegions)}개 지역. 시작 ${clock(job.startedAt || job.queuedAt)} · 다음 실행 가능 ${clock(job.nextEligibleAt)}${job.stopReason ? " · 중단 사유는 관리자 검수가 필요합니다." : ""}`;
      } catch (error) { if (entry === revision && visible() && key === marketKey(context)) state.missingMessage = error.message || "누락 확인 상태를 읽지 못했습니다."; }
      finally { if (entry === revision && visible() && key === marketKey(context)) { state.missingBusy = false; render(); } }
    }
    async function checkWeekly(enable) {
      if (!visible() || state.weeklyBusy || state.missingBusy || enable && state.weeklyResult?.enabled === true) return;
      const entry = revision, key = marketKey(context); state.weeklyBusy = true; state.weeklyMessage = enable ? "주 1회 자동 확인을 설정하고 있습니다." : "주 1회 자동 확인 설정을 읽고 있습니다."; render();
      try {
        const value = await fetchJson(`${MARKET_ENDPOINT}/missing-weekly-policy`, enable ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled: true }) } : undefined);
        if (entry !== revision || !visible() || key !== marketKey(context)) return;
        const names = { disabled: "자동 확인이 꺼져 있습니다.", waiting: "다음 정기 확인을 기다리고 있습니다.", due: "서버가 다음 점검 주기에 누락 확인을 시작합니다.", held: "기존 작업이 진행 중이거나 검수가 필요하여 추가 수집을 보류합니다.", needs_verification: "설정 또는 이전 작업을 관리자 화면에서 확인해야 합니다.", dispatching: "주간 누락 확인 작업을 전달하고 있습니다." };
        if (!value || value.schemaVersion !== 1 || typeof value.enabled !== "boolean" || !names[value.status] || value.enabled === false && value.status !== "disabled"
          || value.schedule?.timezone !== "Asia/Seoul" || value.schedule?.weekday !== 1 || value.schedule?.hour !== 12 || value.schedule?.minute !== 0 || value.schedule?.intervalHours !== 168
          || [value.nextDueAt, value.nextEligibleAt].some(stamp => stamp !== null && stamp !== undefined && (typeof stamp !== "string" || !Number.isFinite(Date.parse(stamp))))) throw Error("주 1회 설정 응답을 검증하지 못했습니다.");
        state.weeklyResult = value;
        state.weeklyMessage = `주 1회 자동 확인 ${value.enabled ? "켜짐" : "꺼짐"} · 매주 월요일 12:00 (한국시간). ${names[value.status]}${value.nextDueAt ? ` 다음 확인 예정 ${clock(value.nextDueAt)}.` : ""}${value.nextEligibleAt ? ` 최근 작업 기준 재실행 가능 ${clock(value.nextEligibleAt)}.` : ""} 정상 자료와 기존 수집 일정은 유지됩니다.`;
      } catch (error) { if (entry === revision && visible() && key === marketKey(context)) state.weeklyMessage = error.message || "주 1회 자동 확인 설정을 읽지 못했습니다."; }
      finally { if (entry === revision && visible() && key === marketKey(context)) { state.weeklyBusy = false; render(); } }
    }
    async function load() {
      if (!visible() || state.weeklyBusy || state.missingBusy) return;
      const entry = ++revision, key = marketKey(context), started = now(); state.loading = true; render();
      try { const result = await marketReader.get({ ...context, fetchJson }); if (entry !== revision || !visible() || key !== marketKey(context)) return; state.result = result; state.error = ""; }
      catch (error) { if (entry !== revision || !visible()) return; state.error = error.message || "행정구역 저장 지표 조회 실패"; }
      finally {
        if (entry === revision && visible() && key === marketKey(context)) {
          state.loading = false; render(); afterPaint(() => {
            if (entry !== revision || !visible()) return;
            const milliseconds = Math.round(Math.max(0, now() - started) * 10) / 10;
            Object.assign(host.dataset, { rcDisplayStatus: "ready", rcDisplayMs: String(milliseconds), rcReadSource: "server" });
            context.onDisplay?.({ mode: "administrative_region", regionKey: context.regionKey, accountKey: context.accountKey, resultId: state.result?.source?.resultId || "", milliseconds, sequence: state.displaySequence, source: "server" });
          });
        }
      }
    }
    async function mount(element, input = {}) {
      if (!element || !input.regionKey) return;
      if (!paused && host === element && marketKey(input) === marketKey(context)) { context = { ...context, ...input }; return; }
      stop(); host = element; context = { ...input }; if (input.fetchJson) fetchJson = input.fetchJson; paused = false;
      if (!visible()) { stop(); return; }
      state.displaySequence++; state.result = marketReader.read(context); state.error = "";
      host.innerHTML = `<section class="regional-catchment" aria-label="행정구역 기본 분석"><header class="rc-header"><div><span class="rc-eyebrow">지역 배후시장 · 행정구역 기본 분석</span><h3>${esc(input.regionLabel || input.regionKey)}</h3><p class="rc-muted">지역 선택만으로 공식 저장 기초통계를 확인합니다.</p></div><button type="button" data-rm-action="status">저장자료 다시 확인</button></header><div data-rm-results></div><details class="rc-sources"><summary>등록 지역 주간 누락 통계 확인</summary><p>등록 업체 소재지의 기초통계 6개를 확인하고 실제 미확보 표만 보완합니다. 정상 자료·비공개·검증 보류 자료를 덮어쓰지 않습니다. 동일 확인은 7일간 재실행하지 않으며, 관광·검색·예약 수집은 실행하지 않습니다.</p><button type="button" data-rm-weekly="status">주 1회 설정 조회</button> <button type="button" data-rm-weekly="enable">매주 월요일 12시 자동 확인 켜기</button><p role="status" data-rm-weekly-receipt></p><button type="button" data-rm-missing="collect">등록 지역 누락 통계 확인</button> <button type="button" data-rm-missing="status">최근 누락 확인 결과</button><p role="status" data-rm-missing-receipt></p></details></section>`;
      host.onclick = event => { if (event.target?.closest?.('[data-rm-action="status"]')) { void load(); return; } const weekly = event.target?.closest?.('[data-rm-weekly]'); if (weekly) { void checkWeekly(weekly.getAttribute("data-rm-weekly") === "enable"); return; } const control = event.target?.closest?.('[data-rm-missing]'); if (control) void checkMissing(control.getAttribute("data-rm-missing") === "collect"); };
      Object.assign(host.dataset, { rcDisplayStatus: "pending", rcDisplayMs: "", rcReadSource: "" }); await load();
    }
    function stop() { paused = true; revision++; state.loading = false; state.missingBusy = false; state.missingMessage = ""; state.weeklyBusy = false; state.weeklyMessage = ""; state.weeklyResult = null; if (host?.dataset) host.dataset.rcDisplayStatus = "paused"; }
    return { mount, stop, state, refreshStatus: load };
  }
  function createWorkspaceController(options = {}) {
    let host, context = {}, paused = true, boundHost, mode = "administrative_region", address, region, addressHost, regionHost;
    const activeController = () => mode === "address_radius" ? address : region;
    const isVisible = () => !paused && host?.isConnected !== false && (context.isVisible?.() ?? true);
    function markMode() {
      if (host?.dataset) host.dataset.rcMode = mode;
      if (addressHost) addressHost.hidden = mode !== "address_radius";
      if (regionHost) regionHost.hidden = mode !== "administrative_region";
      for (const button of host?.querySelectorAll?.("[data-rc-mode]") || []) button.setAttribute("aria-pressed", String(button.getAttribute("data-rc-mode") === mode));
    }
    async function activate(next) {
      if (!isVisible() || !["administrative_region", "address_radius"].includes(next) || activeController()?.state.busy) return;
      if (next !== mode || !activeController()) Object.assign(host.dataset, { rcDisplayStatus: "pending", rcDisplayMs: "", rcReadSource: "", rcStatus: "loading", rcResult: "", rcCompany: "", rcLoading: "true" });
      if (next !== mode) activeController()?.stop();
      mode = next; markMode();
      const mountedMode = mode;
      const input = { ...context, isVisible: () => isVisible() && mode === mountedMode, onDisplay: receipt => {
        if (!isVisible() || mode !== mountedMode) return;
        const panel = mountedMode === "address_radius" ? addressHost : regionHost;
        Object.assign(host.dataset, panel?.dataset || {}, { rcMode: mountedMode }); context.onDisplay?.({ ...receipt, mode: mountedMode });
      } };
      if (mode === "address_radius") {
        if (!address) address = createAddressController(options);
        await address.mount(addressHost, { ...input, resume: true });
      } else {
        if (!region) region = createRegionController(options);
        await region.mount(regionHost, input);
      }
    }
    async function mount(element, input = {}) {
      if (!element || !input.regionKey) return;
      const sameScope = host === element && marketKey(input) === marketKey(context);
      if (!sameScope) {
        address?.stop(); region?.stop(); address = null; region = null;
        host = element; mode = input.mode === "address_radius" ? "address_radius" : "administrative_region";
        host.innerHTML = `<section class="regional-catchment rc-workspace" aria-label="지역 배후시장 분석"><div class="rc-mode-picker" role="group" aria-label="배후시장 분석 기준"><button type="button" data-rc-mode="administrative_region" aria-pressed="${mode === "administrative_region"}">행정구역 기본 분석</button><button type="button" data-rc-mode="address_radius" aria-pressed="${mode === "address_radius"}">주소 기준 반경 분석</button></div><p class="rc-muted">기본 분석은 선택한 시·군·구 전체의 저장 통계를 사용합니다. 상세주소 주변 50km·100km는 주소 기준 반경 분석에서 확인합니다.</p><div data-rc-mode-panel="administrative_region"></div><div data-rc-mode-panel="address_radius" hidden></div></section>`;
        addressHost = host.querySelector?.('[data-rc-mode-panel="address_radius"]'); regionHost = host.querySelector?.('[data-rc-mode-panel="administrative_region"]');
      }
      context = { ...input }; paused = false;
      if (!isVisible()) { stop(); return; }
      Object.assign(host.dataset, { rcRegion: input.regionKey, rcMode: mode });
      if (boundHost !== host) {
        host.addEventListener("click", event => {
          const selected = event.target?.closest?.("[data-rc-mode]")?.getAttribute?.("data-rc-mode");
          if (selected) void activate(selected);
        }); boundHost = host;
      }
      await activate(input.mode === "address_radius" ? "address_radius" : input.mode === "administrative_region" ? "administrative_region" : mode);
    }
    function stop() { paused = true; address?.stop(); region?.stop(); if (host?.dataset) host.dataset.rcDisplayStatus = "paused"; }
    return { mount, stop, selectMode: activate, get mode() { return mode; }, get state() { return activeController()?.state || {}; }, refreshStatus: () => activeController()?.refreshStatus() || Promise.resolve() };
  }
  function createController(options = {}) { return options.mode === "address_radius" ? createAddressController(options) : createWorkspaceController(options); }
  const controllers = new WeakMap(), mounted = new Set();
  const api = { mount(host, context) { let controller = controllers.get(host); if (!controller) { controller = createController(); controllers.set(host, controller); } mounted.add(controller); return controller.mount(host, context); },
    stop(host) { if (host) { const controller = controllers.get(host); controller?.stop(); mounted.delete(controller); } else { for (const controller of mounted) controller.stop(); mounted.clear(); } }, clear(accountKey) { for (const controller of mounted) controller.stop(); mounted.clear(); savedResults.clear(accountKey); savedMarkets.clear(accountKey); },
    createController, createReader, createMarketReader, createRegionController, marketViewModel, marketResultHtml, checkedMarketResult, viewModel, resultHtml, editorHtml, checkedResult, MAX_IMPORT_BYTES };
  root.RegionalCatchment = api; if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
