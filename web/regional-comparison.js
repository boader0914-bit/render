(function (root) {
  "use strict";
  const MAX_TARGETS = 3, MONTH = /^20\d{2}-(0[1-9]|1[0-2])$/;
  const escapeHtml = value => String(value ?? "").replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character]));
  const numeric = value => typeof value === "number" && Number.isFinite(value);
  const number = value => numeric(value) ? value.toLocaleString("ko-KR", { maximumFractionDigits: 2 }) : "미확인";
  const observed = row => ["observed", "ready", "complete", "available"].includes(row?.status) && numeric(row?.value);
  let sharedContract;
  function contractApi() {
    if (root.RegionalDataContract) return root.RegionalDataContract;
    if (!sharedContract && typeof module !== "undefined" && module.exports && typeof require === "function") {
      try { sharedContract = require("./regional-data-contract.js"); } catch { /* Missing contract support must keep direct comparison disabled. */ }
    }
    return sharedContract;
  }
  const regionOf = record => record.key || record.regionKey || record.data?.scope?.regionKey || record.data?.snapshot?.scope?.regionKey || "";
  const levelLabel = value => ({ sigungu: "시·군·구", sido: "시·도", keyword: "키워드" })[value] || "범위 미확인";
  function effectiveCell(record, cell, row) {
    const spatialContract = row && Object.hasOwn(row, "spatialContract") ? row.spatialContract || {}
      : cell?.metric && Object.hasOwn(cell.metric, "spatialContract") ? cell.metric.spatialContract || {} : cell?.group?.spatialContract;
    return { regionKey: regionOf(record), group: { ...cell?.group }, metric: { ...cell?.metric, spatialContract } };
  }
  function eligibility(cells) {
    return contractApi()?.comparisonEligibility?.(cells) || { comparable: false, reasonCode: "SCOPE_UNVERIFIED", reason: "지역 범위 확인 필요", periodType: "", providedLevel: "unknown" };
  }
  function spatialView(cell) {
    const spatial = cell.metric?.spatialContract || cell.group?.spatialContract, check = eligibility([{ ...cell, metric: { ...cell.metric, unit: "scope", periodType: "M" } }]);
    const keyword = spatial?.scopeKind === "keyword" || search(cell.group);
    return { contract: spatial, keyword, matched: check.comparable, reason: check.reason,
      label: keyword ? "검색어 기준 · 지역 간 직접 비교 불가" : check.comparable ? `${levelLabel(spatial?.providedLevel)} 기준 · 범위 일치` : check.reason || "지역 범위 확인 필요" };
  }
  const period = value => String(value || "").replace(/^(20\d{2})(\d{2})$/, "$1-$2");
  const background = group => group?.key === "kosis" || group?.category === "background";
  const search = group => group?.key === "searchTrend" || group?.category === "search";
  const time = value => value && Number.isFinite(Date.parse(value)) ? `${new Date(Date.parse(value) + 32400000).toISOString().slice(0, 16).replace("T", " ")} KST` : "기록 없음";
  function latestCompletedMonth(now = Date.now()) {
    const day = new Date(Number(now) + 32400000);
    return new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), 0)).toISOString().slice(0, 7);
  }
  function normalRows(metric) {
    const byPeriod = new Map(), duplicates = new Set();
    for (const row of Array.isArray(metric?.rows) ? metric.rows : []) {
      const key = period(row.period);
      if (!/^(20\d{2})(-(0[1-9]|1[0-2]))?$/.test(key)) continue;
      if (byPeriod.has(key)) duplicates.add(key); else byPeriod.set(key, { ...row, period: key });
    }
    for (const key of duplicates) byPeriod.delete(key);
    return [...byPeriod.values()].filter(observed).sort((a, b) => a.period.localeCompare(b.period));
  }
  const usable = record => (record?.data?.snapshot?.groups || []).some(group => (group.metrics || []).some(metric => normalRows(metric).length));
  function sourceWarning(group, metric) {
    if (!group) return "";
    const notes = [];
    if (group.stale || metric?.stale) notes.push("이전 자료 · 최신 여부 확인 필요");
    const refreshCode = group.lastRefreshErrorCode || group.refresh?.errorCode;
    if (["failed", "error", "blocked", "interrupted"].includes(group.refreshedStatus || group.refresh?.status)
      || refreshCode && !["NO_DATA", "PUBLICATION_PENDING", "PARTIAL_DATA", "MISSING_VALUES"].includes(refreshCode)) notes.push("최근 지표 갱신 실패 · 보존된 정상값");
    else if (group.latestRequestedStatus === "publication_pending") notes.push("요청월 자료 공표 대기");
    else if (["failed", "error", "blocked", "interrupted"].includes(group.latestRequestedStatus)) notes.push("요청월 자료 확인 실패");
    const code = group.lastRefreshErrorCode || group.refresh?.errorCode || group.errorCode;
    if (code && !["NO_DATA", "PUBLICATION_PENDING", "PARTIAL_DATA", "MISSING_VALUES"].includes(code) && !notes.length) notes.push("지표 연결 상태 확인 필요");
    return notes.join(" · ");
  }
  function metricIndex(record, kind) {
    const result = new Map();
    for (const group of record?.data?.snapshot?.groups || []) {
      if (kind === "background" ? !background(group) : kind === "search" ? !search(group) : background(group) || search(group)) continue;
      for (const metric of group.metrics || []) result.set(`${group.key}\u0000${metric.key}`, { group, metric });
    }
    return result;
  }
  function comparisonModel(records, kind = "flow") {
    const indexes = records.map(record => metricIndex(record, kind)), keys = new Set(indexes.flatMap(index => [...index.keys()]));
    return [...keys].map(key => {
      const cells = indexes.map(index => index.get(key)), first = cells.find(Boolean);
      const rows = cells.map((cell, index) => normalRows(cell?.metric).filter(row => row.period <= (records[index].data?.scope?.month || records[index].data?.snapshot?.scope?.month || "")));
      const common = rows.length && rows.every(items => items.length) ? rows[0].map(row => row.period).filter(value => rows.every(items => items.some(row => row.period === value))) : [];
      const candidates = common.slice().reverse().map(value => {
        const check = eligibility(cells.map((cell, index) => effectiveCell(records[index], cell, rows[index].find(row => row.period === value))));
        if (check.comparable && (check.periodType === "M" ? !/^20\d{2}-\d{2}$/.test(value) : !/^20\d{2}$/.test(value))) return { period: value, check: { ...check, comparable: false, reasonCode: "PERIOD_TYPE_MISMATCH", reason: "공표 주기와 저장 기준기간 다름" } };
        return { period: value, check };
      });
      const chosen = candidates.find(candidate => candidate.check.comparable), commonPeriod = chosen?.period || "";
      const check = chosen?.check || candidates[0]?.check || eligibility(cells.map((cell, index) => effectiveCell(records[index], cell, rows[index].at(-1))));
      const reason = !rows.every(items => items.length) || check.comparable ? "공통 기간 미확인 · 기간 다름 또는 자료 부족" : check.reason || "지역 범위 확인 필요";
      return { key, label: first.metric.label || first.metric.key, groupLabel: first.group.label || first.group.key,
        provider: first.group.provider || "출처 미확인", unit: first.metric.unit || "단위 미확인", commonPeriod, periodType: check.periodType || first.metric.periodType || first.group.periodType || "unknown", reason,
        reasonCode: commonPeriod ? "" : check.reasonCode || "NO_COMMON_PERIOD", newerPeriodExcluded: Boolean(commonPeriod && candidates[0].period !== commonPeriod), excludedPeriod: candidates[0]?.period || "", excludedReason: candidates[0]?.check.reason || "",
        cells: cells.map((cell, index) => {
          const latest = rows[index].at(-1), shown = commonPeriod ? rows[index].find(row => row.period === commonPeriod) : latest;
          const scope = spatialView(effectiveCell(records[index], cell, shown));
          return { regionKey: regionOf(records[index]), provider: cell?.group.provider || "출처 미확인", unit: cell?.metric.unit || "단위 미확인",
            latestPeriod: latest?.period || "", latestValue: latest?.value ?? null, warning: sourceWarning(cell?.group, cell?.metric), scope,
            sourceStatus: shown?.status || "missing", referenceLabel: !latest || scope.matched ? "지역 최근값" : scope.contract?.status === "response_mismatch" ? "범위가 다른 원자료 참고값" : "범위 미확인 참고값",
            value: commonPeriod ? shown?.value ?? null : null };
        }) };
    });
  }
  function contractDetailsHtml(cell, row, state) {
    const spatial = cell.scope.contract, key = `contract:${encodeURIComponent(row.key)}:${encodeURIComponent(cell.regionKey)}`;
    return `<details class="rc-evidence rc-contract" data-rc-detail="${escapeHtml(key)}"${state?.open?.has(key) ? " open" : ""}><summary>공통 기준 확인</summary><dl><div><dt>출처</dt><dd>${escapeHtml(cell.provider)} · ${escapeHtml(cell.unit)}</dd></div><div><dt>실제 범위</dt><dd>${escapeHtml(cell.scope.label)}</dd></div><div><dt>기준기간</dt><dd>${escapeHtml(row.commonPeriod || cell.latestPeriod || "미확인")} · ${row.periodType === "Y" ? "연간" : row.periodType === "M" ? "월간" : "주기 확인 필요"}</dd></div><div><dt>수집 상태</dt><dd>${["observed", "ready", "complete", "available"].includes(cell.sourceStatus) ? "정상 자료" : "미확인"}</dd></div>${spatial?.providerRegionCode ? `<div><dt>제공 지역 코드</dt><dd>${escapeHtml(spatial.providerRegionCode)}</dd></div>` : ""}<div><dt>범위 근거</dt><dd>${spatial?.evidence === "response" ? "제공 응답에서 확인" : "범위 확인 필요"}</dd></div></dl></details>`;
  }
  function tableHtml(records, kind, state) {
    const rows = comparisonModel(records, kind);
    if (!rows.length) return '<p class="rc-empty">연결할 저장 지표가 없습니다. 미확인을 0으로 바꾸지 않습니다.</p>';
    const table = (items, label) => `<div class="rc-table-wrap"><table><caption>${escapeHtml(label)}</caption><thead><tr><th scope="col">지표 · 기준기간</th>${records.map(record => `<th scope="col">${escapeHtml(record.label)}</th>`).join("")}</tr></thead><tbody>${items.map(row => `<tr><th scope="row"><strong>${escapeHtml(row.label)}</strong><small>${escapeHtml(row.groupLabel)} · ${escapeHtml(row.commonPeriod || row.reason)}</small><small>${escapeHtml(row.provider)} · ${escapeHtml(row.unit)}</small>${row.newerPeriodExcluded ? `<small class="rc-warning">${escapeHtml(row.excludedPeriod)} 비교 제외 · ${escapeHtml(row.excludedReason)}</small>` : ""}</th>${row.cells.map(cell => `<td><strong>${number(cell.value)}</strong><small>${escapeHtml(cell.unit)}</small><small class="${cell.scope.matched ? "" : "rc-warning"}">${escapeHtml(cell.scope.label)}</small>${!row.commonPeriod ? `<small class="rc-latest-reference">${row.periodType === "Y" ? "공통연도" : "공통월"} 직접비교 불가 · ${escapeHtml(cell.referenceLabel)} <b>${number(cell.latestValue)}</b> ${escapeHtml(cell.unit)}<br>기준 ${escapeHtml(cell.latestPeriod || "미확인")}</small>` : ""}${cell.warning ? `<small class="rc-warning">${escapeHtml(cell.warning)}</small>` : ""}<small>${escapeHtml(cell.provider)}</small>${contractDetailsHtml(cell, row, state)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
    if (kind !== "background") return table(rows, "관광 흐름 · 같은 공간 범위·주기의 공통 정상월");
    return [["M", "인구·산업 월간 기초자료 · 공통 기준월"], ["Y", "인구·산업 연간 기초자료 · 공통 기준연도"], ["unknown", "기초자료 · 기준주기 확인 필요"]].map(([type, label]) => {
      const items = rows.filter(row => type === "unknown" ? !["M", "Y"].includes(row.periodType) : row.periodType === type);
      return items.length ? table(items, label) : "";
    }).join("");
  }
  function searchHtml(records) {
    const cards = records.map(record => {
      const entries = [...metricIndex(record, "search").values()];
      return `<article class="rc-search-region"><h4>${escapeHtml(record.label)}</h4>${entries.length ? entries.map(({ group, metric }) => {
        const rows = (metric.rows || []).slice().sort((a, b) => String(a.period).localeCompare(String(b.period)));
        return `<p>${escapeHtml(group.provider || "출처 미확인")} · ${escapeHtml(group.keyword || "기준 검색어 미확인")}</p><p>정규화 기간 ${escapeHtml(group.normalizationPeriod || "미확인")}</p><p class="rc-contract-label">키워드 검색 범위 · 행정구역 전체의 절대 수요가 아닙니다.</p>${sourceWarning(group, metric) ? `<p class="rc-warning">${escapeHtml(sourceWarning(group, metric))}</p>` : ""}<details class="rc-evidence"><summary>개별 지역 추이 · ${escapeHtml(metric.label || metric.key)}</summary><div class="rc-search-points">${rows.map(row => `<span><small>${escapeHtml(period(row.period) || "기간 미확인")}</small><b>${observed(row) ? number(row.value) : "미확인"}</b><small>${escapeHtml(metric.unit || "상대지수")}</small></span>`).join("") || "저장 추이 없음"}</div><p>자료 묶음 ${escapeHtml(group.sourceBatchId || "미확인")}</p></details>`;
      }).join("") : '<p class="rc-empty">저장 검색 자료가 없습니다.</p>'}</article>`;
    }).join("");
    return `<p class="rc-note">검색 관심도는 검색어·정규화 기간·자료 묶음 안의 상대지수입니다. 서로 다른 묶음의 지역별 고저 순위나 증감 비교는 하지 않으며, 각 지역 안의 추이만 참고합니다.</p><div class="rc-search-grid">${cards}</div>`;
  }
  function selectedRecords(state) {
    return [state.regionKey, ...state.targets].filter(Boolean).map(key => ({ key, label: state.regions.find(region => region.regionKey === key)?.label || (key === state.regionKey ? state.regionLabel : key), ...(state.records[key] || {}) }));
  }
  function regionOptions(state) {
    const selected = new Set([state.regionKey, ...state.targets]), query = state.query.trim().toLocaleLowerCase();
    return '<option value="">비교할 지역 선택</option>' + state.regions.filter(region => !selected.has(region.regionKey) && (!query || `${region.label} ${region.regionKey}`.toLocaleLowerCase().includes(query)))
      .map(region => `<option value="${escapeHtml(region.regionKey)}"${state.candidate === region.regionKey ? " selected" : ""}>${escapeHtml(region.label)}</option>`).join("");
  }
  function renderDashboard(state) {
    const records = selectedRecords(state), confirmationFailed = records.some(record => record.error);
    const confirmationLabel = state.checkSource === "cache" ? "캐시 재사용 · 새 서버 확인 없음" : state.checkSource === "mixed" ? "일부 지역 서버 확인 · 나머지 캐시 재사용" : state.checkSource === "server" ? "서버 저장 결과 확인" : "";
    return `<section class="regional-comparison" aria-label="저장자료 지역 비교"><header class="rc-header"><div><span class="rc-eyebrow">지역 비교 · 저장 결과</span><h3>${escapeHtml(state.regionLabel || "지역 미선택")}</h3><p>기준지역과 최대 3개 지역의 저장 지표를 비교합니다. ${escapeHtml(state.month)} 기준 13개월 · 같은 행정 범위·출처·단위·주기의 공통 정상기간을 확인합니다.</p></div><button type="button" data-rc-action="check"${!state.regionKey || state.loading ? " disabled" : ""}>${state.loading ? "변경 확인 중" : "저장 결과 다시 확인"}</button></header><div class="rc-toolbar"><label>자료 기준월<input type="month" data-rc-month value="${escapeHtml(state.month)}" max="${escapeHtml(state.maxMonth)}"></label><label>지역 검색<input type="search" data-rc-search value="${escapeHtml(state.query)}" placeholder="지역명 검색" autocomplete="off"></label><label>비교 대상<select data-rc-candidate>${regionOptions(state)}</select></label><button type="button" data-rc-action="add"${state.targets.length >= MAX_TARGETS || !state.candidate ? " disabled" : ""}>지역 추가</button></div><div class="rc-selected" aria-label="선택 지역"><span class="rc-base">기준 ${escapeHtml(state.regionLabel)}</span>${state.targets.map(key => `<button type="button" data-rc-remove="${escapeHtml(key)}">${escapeHtml(state.regions.find(region => region.regionKey === key)?.label || key)} <span aria-hidden="true">×</span><span class="rc-sr-only"> 비교 제외</span></button>`).join("")}</div><div class="rc-status" role="status" aria-live="polite">${state.error ? `<p class="rc-warning">${escapeHtml(state.error)}</p>` : ""}${!state.regionKey ? '<p>상단에서 기준지역을 선택해 주세요.</p>' : !state.targets.length ? '<p>비교할 지역을 추가하세요. 기준지역의 저장 자료를 먼저 표시합니다.</p>' : ""}${state.loading ? '<p>화면에 있는 저장 자료를 유지하며 변경 여부를 확인합니다.</p>' : confirmationLabel ? `<p>${escapeHtml(confirmationLabel)}${confirmationFailed ? " · 일부 확인 실패" : ""}</p>` : ""}</div>${records.length ? `<div class="rc-source-status">${records.map(record => `<article><strong>${escapeHtml(record.label)}</strong><span>${record.error ? "확인 실패" : record.loading ? record.data?.snapshot ? "저장본 표시 · 변경 확인 중" : "저장 자료 확인 중" : record.data?.snapshot ? record.source === "cache" ? "캐시 재사용" : "서버에서 읽은 저장 결과" : "자료 미확보"}</span>${record.error ? `<p class="rc-warning">${escapeHtml(record.error)}${record.data?.snapshot ? " · 이전 저장 결과를 표시합니다. 최신 상태 미확인" : ""}</p>` : ""}<small>결과 정리 ${escapeHtml(time(record.data?.snapshot?.generatedAt))}</small><small>최근 서버 확인 ${escapeHtml(time(record.checkedAt))}</small>${record.data?.snapshot?.resultId ? `<details class="rc-evidence"><summary>결과 근거</summary><p>${escapeHtml(record.data.snapshot.resultId)}</p></details>` : ""}</article>`).join("")}</div><details class="rc-group" data-rc-detail="flow"${state.open.has("flow") ? " open" : ""}><summary>관광 흐름 <span>지표별 공통 정상월 · 단위 유지</span></summary>${tableHtml(records, "flow", state)}</details><details class="rc-group" data-rc-detail="search"${state.open.has("search") ? " open" : ""}><summary>검색 관심도 <span>개별 지역 안의 추이</span></summary>${searchHtml(records)}</details><details class="rc-group" data-rc-detail="background"${state.open.has("background") ? " open" : ""}><summary>인구·산업 기초자료 <span>실제 공표월·연도</span></summary><p class="rc-note">인구·산업은 지역의 운영 기반을 보여주는 기초자료입니다. 연간 값을 월별로 나누거나 관광 수요의 증감으로 해석하지 않습니다.</p>${tableHtml(records, "background", state)}</details>` : ""}<p class="rc-note">화면 조회는 저장 결과만 읽습니다. 새 수집·외부 API 갱신을 시작하지 않으며, 저장 자료가 없는 지역이나 날짜는 미확인으로 남깁니다.</p></section>`;
  }
  function createController({ reader = null, now = () => Date.now(), requestFrame = callback => typeof root.requestAnimationFrame === "function" ? root.requestAnimationFrame(callback) : root.setTimeout(callback, 0) } = {}) {
    const state = { accountKey: "", regionKey: "", regionLabel: "", month: "", monthExplicit: false, maxMonth: "", regions: [], targets: [], records: {}, query: "", candidate: "", open: new Set(["flow"]), loading: false, error: "", checkedAt: "", checkSource: "" };
    let host = null, revision = 0, paused = true, isVisible = () => true, fetchJson, onDisplay, inFlight = null, inFlightKey = "", sequence = 0, measurement = null, composing = false, deferredRender = false;
    const bound = new WeakSet(), visible = () => !paused && host?.isConnected !== false && !root.document?.hidden && isVisible();
    const currentKey = () => JSON.stringify([state.accountKey, state.regionKey, state.month, state.targets]);
    const inputFor = regionKey => ({ accountKey: state.accountKey, regionKey, month: state.month, months: 13 });
    function status() {
      const records = selectedRecords(state), known = records.filter(usable).length;
      if (!state.regionKey) return "idle";
      if (known === records.length && known) return records.some(record => record.error) ? "stale" : "ready";
      if (state.loading) return "waiting";
      if (known) return "partial";
      return records.some(record => record.error) || state.error ? "error" : "missing";
    }
    function beginTiming(force = false) {
      const entry = Number(host?.dataset?.rcEntryStartedAt), explicit = numeric(entry) && entry > 0 && entry <= now() && now() - entry <= 60000;
      if (host?.dataset) delete host.dataset.rcEntryStartedAt;
      if (!force && !explicit && measurement) return;
      measurement = { token: ++sequence, started: explicit ? entry : now(), key: currentKey(), painted: false };
      if (host?.dataset) { delete host.dataset.rcDisplayMs; delete host.dataset.rcDisplaySource; delete host.dataset.rcDisplayResultIds; host.dataset.rcDisplayStatus = "waiting"; host.dataset.rcDisplaySequence = String(sequence); }
    }
    function markDisplay() {
      const mark = measurement, atHost = host, nextStatus = status();
      if (!mark || mark.painted || mark.scheduled || nextStatus === "waiting" || nextStatus === "idle") return;
      mark.scheduled = true;
      requestFrame(() => requestFrame(() => {
        mark.scheduled = false;
        if (measurement !== mark || !visible() || host !== atHost || mark.key !== currentKey()) return;
        if (mark.painted) return;
        const actual = status(); if (["waiting", "idle"].includes(actual)) return;
        mark.painted = true;
        const milliseconds = Math.max(0, now() - mark.started);
        if (host.dataset) {
          const shown = selectedRecords(state).filter(record => record.data?.snapshot);
          host.dataset.rcDisplayMs = String(milliseconds); host.dataset.rcDisplayStatus = actual; host.dataset.rcDisplaySequence = String(mark.token);
          host.dataset.rcDisplaySource = !shown.length ? "none" : shown.every(record => record.source === "cache") ? "cache" : shown.some(record => record.source === "cache") ? "mixed" : "server";
          host.dataset.rcDisplayResultIds = shown.map(record => record.data.snapshot.resultId || "").join(",");
        }
        if (typeof onDisplay === "function") onDisplay({ status: actual, milliseconds, sequence: mark.token, regionKey: state.regionKey, month: state.month });
      }));
    }
    function render() {
      if (!host || !visible()) return;
      if (composing) { deferredRender = true; return; }
      const active = host.ownerDocument?.activeElement, focused = active?.matches?.("[data-rc-search]") && host.contains?.(active);
      const selection = focused ? [active.selectionStart, active.selectionEnd, active.selectionDirection] : null;
      const markup = renderDashboard(state); if (host.innerHTML !== markup) host.innerHTML = markup;
      if (focused) { const input = host.querySelector?.("[data-rc-search]"); input?.focus({ preventScroll: true }); if (Number.isInteger(selection[0])) input?.setSelectionRange?.(...selection); }
      deferredRender = false; markDisplay();
    }
    function accept(result, regionKey) {
      if (!result || typeof result !== "object" || !Object.hasOwn(result, "snapshot")) throw new Error("저장 결과 응답을 확인하지 못했습니다.");
      for (const scope of [result.scope, result.snapshot?.scope]) {
        if (scope?.regionKey && scope.regionKey !== regionKey || scope?.month && scope.month !== state.month || scope?.months && scope.months !== 13) throw new Error("선택 지역·기준월과 다른 저장 결과입니다.");
      }
      if (result.snapshot && (result.snapshot.scope?.regionKey || result.snapshot.regionKey) !== regionKey) throw new Error("선택 지역과 다른 저장 결과입니다.");
      if ((result.scope?.month || result.snapshot?.scope?.month) !== state.month) throw new Error("저장 자료의 기준월을 확인하지 못했습니다.");
      return result;
    }
    function readerCheckedAt(saved, scope, fallback = "") {
      try {
        const value = saved.info?.(scope)?.checkedAt;
        return numeric(value) && value > 0 ? new Date(value).toISOString() : fallback;
      } catch { return fallback; }
    }
    function updateCheckedAt() {
      state.checkedAt = selectedRecords(state).map(record => record.checkedAt || "").sort().at(-1) || "";
    }
    function restoreCached(preserveSource = false) {
      const saved = reader || root.RegionalAnalysis?.savedResults;
      if (!saved?.read) return;
      for (const regionKey of [state.regionKey, ...state.targets].filter(Boolean)) {
        try {
          const scope = inputFor(regionKey), cached = saved.read(scope), previous = state.records[regionKey];
          if (cached) state.records[regionKey] = { ...previous, data: accept(cached, regionKey),
            source: preserveSource && previous?.data === cached ? previous.source || "cache" : "cache",
            checkedAt: readerCheckedAt(saved, scope, previous?.checkedAt) };
        }
        catch { /* An invalid cached result must not become the selected region's data. */ }
      }
      updateCheckedAt();
    }
    async function refresh(force = true) {
      if (!visible() || !state.regionKey) return false;
      const key = currentKey(); if (inFlight && inFlightKey === key) return inFlight;
      const saved = reader || root.RegionalAnalysis?.savedResults;
      if (!saved?.get) { state.error = "저장 지역 결과 연결을 확인하지 못했습니다."; render(); return false; }
      const token = ++revision; state.loading = true; state.error = ""; inFlightKey = key;
      if (host.dataset) { delete host.dataset.rcCheckMs; delete host.dataset.rcCheckSource; host.dataset.rcCheckStatus = "checking"; }
      for (const regionKey of [state.regionKey, ...state.targets]) state.records[regionKey] = { ...state.records[regionKey], loading: true };
      render(); const started = now();
      const task = (async () => {
        const sources = [];
        const settled = await Promise.allSettled([state.regionKey, ...state.targets].map(async regionKey => {
          try {
            const scope = inputFor(regionKey), previous = state.records[regionKey], beforeData = saved.read?.(scope), beforeCheckedAt = readerCheckedAt(saved, scope, previous?.checkedAt), fresh = saved.fresh?.(scope) === true;
            const result = await saved.get({ ...scope, fetchJson, force: force === true });
            if (token !== revision || !visible()) return;
            const data = accept(result, regionKey), checkedAt = readerCheckedAt(saved, scope, previous?.checkedAt);
            // A fresh cache can still join a concurrent forced GET. Its actual GET time or
            // returned result identity distinguishes that response from a pure cache hit.
            const source = force === true || !fresh || checkedAt !== beforeCheckedAt || beforeData && result !== beforeData ? "server" : "cache";
            sources.push(source);
            state.records[regionKey] = { data, loading: false, source, checkedAt, error: data.storage?.errorCode ? "저장 상태 확인 실패 · 최신 상태 미확인" : "" }; render();
          } catch (error) {
            if (token !== revision || !visible()) return;
            state.records[regionKey] = { ...state.records[regionKey], loading: false, error: error?.message || "저장 결과 확인 실패" }; render();
          }
        }));
        if (token !== revision || !visible()) return false;
        state.loading = false; updateCheckedAt();
        state.checkSource = !sources.length ? "none" : sources.every(source => source === "cache") ? "cache" : sources.every(source => source === "server") ? "server" : "mixed";
        if (host.dataset) {
          host.dataset.rcCheckMs = String(Math.max(0, now() - started)); host.dataset.rcCheckSource = state.checkSource;
          host.dataset.rcCheckStatus = selectedRecords(state).some(record => record.error) ? "error" : state.checkSource === "cache" ? "cached" : state.checkSource === "mixed" ? "mixed" : "checked";
          if (state.checkedAt) host.dataset.rcCheckAt = state.checkedAt; else delete host.dataset.rcCheckAt;
        }
        render(); return settled.every(row => row.status === "fulfilled") && !selectedRecords(state).some(record => record.error);
      })();
      inFlight = task;
      try { return await task; } finally { if (inFlight === task) { inFlight = null; inFlightKey = ""; } }
    }
    function updateSearch(value) {
      state.query = String(value || "");
      const candidate = state.regions.find(region => region.regionKey === state.candidate), query = state.query.trim().toLocaleLowerCase();
      if (candidate && query && !`${candidate.label} ${candidate.regionKey}`.toLocaleLowerCase().includes(query)) state.candidate = "";
      if (!visible()) return;
      const select = host.querySelector?.("[data-rc-candidate]"); if (select) select.innerHTML = regionOptions(state);
      if (select && select.value !== state.candidate) state.candidate = "";
      const button = host.querySelector?.('[data-rc-action="add"]'); if (button) button.disabled = state.targets.length >= MAX_TARGETS || !state.candidate;
    }
    function addTarget(value = state.candidate) {
      if (!visible() || state.targets.length >= MAX_TARGETS || value === state.regionKey || state.targets.includes(value) || !state.regions.some(region => region.regionKey === value)) return false;
      state.targets.push(value); state.candidate = ""; beginTiming(true); restoreCached(); render(); void refresh(); return true;
    }
    function removeTarget(value) {
      if (!visible() || !state.targets.includes(value)) return false;
      state.targets = state.targets.filter(key => key !== value); delete state.records[value]; beginTiming(true); render(); void refresh(); return true;
    }
    function selectMonth(value) {
      if (!visible() || !MONTH.test(value || "") || value > state.maxMonth) return false;
      state.monthExplicit = true;
      if (state.month === value) return true;
      revision++; state.month = value; state.records = {}; state.checkedAt = ""; state.checkSource = ""; state.loading = false; beginTiming(true); restoreCached(); render(); void refresh(); return true;
    }
    function stop() { paused = true; revision++; state.loading = false; composing = false; deferredRender = false; inFlight = null; inFlightKey = ""; }
    function bind() {
      if (bound.has(host)) return; bound.add(host);
      host.addEventListener("input", event => { if (event.currentTarget === host && event.target.matches?.("[data-rc-search]")) updateSearch(event.target.value); });
      host.addEventListener("compositionstart", event => { if (event.currentTarget === host && event.target.matches?.("[data-rc-search]")) composing = true; });
      host.addEventListener("compositionend", event => { if (event.currentTarget !== host || !event.target.matches?.("[data-rc-search]")) return; composing = false; updateSearch(event.target.value); if (deferredRender) render(); });
      host.addEventListener("change", event => {
        if (event.currentTarget !== host || !visible()) return;
        if (event.target.matches?.("[data-rc-month]")) selectMonth(event.target.value);
        if (event.target.matches?.("[data-rc-candidate]")) { state.candidate = event.target.value; const button = host.querySelector?.('[data-rc-action="add"]'); if (button) button.disabled = state.targets.length >= MAX_TARGETS || !state.candidate; }
      });
      host.addEventListener("click", event => {
        if (event.currentTarget !== host || !visible()) return;
        const button = event.target.closest?.("[data-rc-action],[data-rc-remove]"); if (!button || button.disabled) return;
        if (button.dataset.rcAction === "check") void refresh();
        if (button.dataset.rcAction === "add") addTarget();
        if (button.dataset.rcRemove) removeTarget(button.dataset.rcRemove);
      });
      host.addEventListener("toggle", event => { const key = event.target.dataset?.rcDetail; if (event.currentTarget !== host || !key || event.target.isConnected === false) return; if (event.target.open) state.open.add(key); else state.open.delete(key); }, true);
    }
    async function mount(element, context = {}) {
      const resuming = paused, maximum = latestCompletedMonth(now()), accountKey = String(context.accountKey || ""), regionKey = String(context.regionKey || ""), accountChanged = state.accountKey !== accountKey;
      const enteredAt = Number(element?.dataset?.rcEntryStartedAt), newEntry = numeric(enteredAt) && enteredAt > 0 && enteredAt <= now() && now() - enteredAt <= 60000;
      const contextMonth = Object.hasOwn(context, "month"), explicit = contextMonth || !accountChanged && state.monthExplicit;
      const month = contextMonth ? context.month : explicit ? state.month : maximum;
      const validMonth = MONTH.test(month || "") && month <= maximum;
      const changed = state.accountKey !== accountKey || state.regionKey !== regionKey || state.month !== month, previousTargets = JSON.stringify(state.targets);
      if (changed) { stop(); state.records = {}; state.checkedAt = ""; state.checkSource = ""; state.error = ""; state.open = new Set(["flow"]); if (state.accountKey !== accountKey) { state.targets = []; state.query = ""; } }
      host = element; paused = false; isVisible = context.isVisible || (() => true); fetchJson = context.fetchJson; onDisplay = context.onDisplay;
      Object.assign(state, { accountKey, regionKey, regionLabel: context.regionLabel || context.label || "지역 미선택", month, monthExplicit: Boolean(explicit && validMonth), maxMonth: maximum });
      state.regions = [...new Map((Array.isArray(context.regions) ? context.regions : []).filter(row => row?.regionKey).map(row => [String(row.regionKey), { regionKey: String(row.regionKey), label: String(row.label || row.fullName || row.name || row.regionKey) }])).values()];
      if (regionKey && !state.regions.some(row => row.regionKey === regionKey)) state.regions.unshift({ regionKey, label: state.regionLabel });
      state.targets = state.targets.filter(key => key !== regionKey && state.regions.some(row => row.regionKey === key)).slice(0, MAX_TARGETS);
      const selected = new Set([regionKey, ...state.targets]); for (const key of Object.keys(state.records)) if (!selected.has(key)) delete state.records[key];
      if (!state.regions.some(row => row.regionKey === state.candidate) || state.candidate === regionKey || state.targets.includes(state.candidate)) state.candidate = "";
      const targetsChanged = previousTargets !== JSON.stringify(state.targets);
      bind(); beginTiming(changed || resuming || !measurement || targetsChanged);
      if (!validMonth) { state.error = "확인할 자료 기준월을 다시 선택해 주세요."; render(); return false; }
      const saved = reader || root.RegionalAnalysis?.savedResults, force = changed || targetsChanged || resuming || newEntry;
      restoreCached(!force); render();
      if (!force && !state.loading && typeof saved?.fresh === "function") {
        try {
          if (selectedRecords(state).every(record => record.data && !record.error && saved.fresh(inputFor(record.key)))) return true;
        } catch { /* A failed freshness check must perform a saved-result confirmation. */ }
      }
      return refresh(force);
    }
    return { state, mount, refresh, stop, addTarget, removeTarget, selectMonth, updateSearch, render };
  }
  const controllers = new Map();
  const exported = { createController, renderDashboard, comparisonModel, normalRows, latestCompletedMonth,
    mount(host, context) { if (!host) return false; for (const [element, controller] of controllers) if (element.isConnected === false) { controller.stop(); controllers.delete(element); } let controller = controllers.get(host); if (!controller) { controller = createController(); controllers.set(host, controller); } return controller.mount(host, context); },
    stop(host) { if (host) controllers.get(host)?.stop(); else for (const controller of controllers.values()) controller.stop(); },
    clear() { for (const controller of controllers.values()) controller.stop(); controllers.clear(); } };
  root.RegionComparison = exported;
  if (typeof module !== "undefined" && module.exports) module.exports = exported;
})(typeof window !== "undefined" ? window : globalThis);
