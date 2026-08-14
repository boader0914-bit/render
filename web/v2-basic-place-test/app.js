"use strict";

const elements = {
  serviceState: document.querySelector("#serviceState"),
  serviceStateText: document.querySelector("#serviceStateText"),
  budgetValue: document.querySelector("#budgetValue"),
  form: document.querySelector("#collectorForm"),
  modeDemo: document.querySelector("#modeDemo"),
  modeLive: document.querySelector("#modeLive"),
  keyword: document.querySelector("#keywordInput"),
  token: document.querySelector("#tokenInput"),
  collectButton: document.querySelector("#collectButton"),
  buttonLabel: document.querySelector(".button-label"),
  message: document.querySelector("#requestMessage"),
  bookmarkletLink: document.querySelector("#bookmarkletLink"),
  browserAdFile: document.querySelector("#browserAdFile"),
  clearBrowserAds: document.querySelector("#clearBrowserAds"),
  organicCount: document.querySelector("#organicCount"),
  adCount: document.querySelector("#adCount"),
  requestCount: document.querySelector("#requestCount"),
  elapsedValue: document.querySelector("#elapsedValue"),
  organicBalance: document.querySelector("#organicBalance"),
  adBalance: document.querySelector("#adBalance"),
  organicTabCount: document.querySelector("#organicTabCount"),
  adTabCount: document.querySelector("#adTabCount"),
  organicRows: document.querySelector("#organicRows"),
  adRows: document.querySelector("#adRows"),
  advertisementSource: document.querySelector("#advertisementSource"),
  diagnosticStatus: document.querySelector("#diagnosticStatus"),
  candidateCount: document.querySelector("#candidateCount"),
  matchedCandidateCount: document.querySelector("#matchedCandidateCount"),
  rootKeyCount: document.querySelector("#rootKeyCount"),
  responseBytes: document.querySelector("#responseBytes"),
  responseDigest: document.querySelector("#responseDigest"),
  manifestDigest: document.querySelector("#manifestDigest"),
  rawStorage: document.querySelector("#rawStorage"),
  downloadJson: document.querySelector("#downloadJson"),
  downloadCsv: document.querySelector("#downloadCsv"),
  rowTemplate: document.querySelector("#rowTemplate")
};

const tabs = [...document.querySelectorAll('[role="tab"]')];
const panels = [...document.querySelectorAll('[role="tabpanel"]')];
let serviceStatus = null;
let latestResult = null;
let serverResult = null;
let bookmarkletReady = false;

const ERROR_LABELS = Object.freeze({
  V2_BASIC_UI_UNAUTHORIZED: "관리자 토큰을 확인해 주세요.",
  V2_BASIC_UI_LIVE_DISABLED: "Live 수집이 비활성화되어 있습니다.",
  V2_BASIC_UI_DAILY_BUDGET_EXHAUSTED: "오늘의 Live 요청 한도를 모두 사용했습니다.",
  V2_BASIC_UI_RATE_LIMITED: "다음 수동 수집까지 잠시 기다려 주세요.",
  V2_BASIC_UI_PROVIDER_CIRCUIT_OPEN: "네이버 차단 신호로 오늘의 Live 수집을 중지했습니다.",
  V2_BASIC_UI_BUSY: "다른 수집이 진행 중입니다.",
  V2_BASIC_UI_RESULT_UNCERTAIN: "이전 실행 결과가 확정되지 않아 중단했습니다.",
  V2_BASIC_UI_ORIGIN_BLOCKED: "허용되지 않은 요청 출처입니다.",
  V2_BASIC_PLACE_ACCESS_BLOCKED: "네이버 접근이 차단되어 수집을 중단했습니다.",
  V2_BASIC_PLACE_HTTP_ERROR: "네이버가 성공 응답을 반환하지 않았습니다."
});

const DIAGNOSTIC_LABELS = Object.freeze({
  "ad-operation-absent": "광고 operation 없음",
  "ad-candidates-filtered": "광고 후보 필터 불일치",
  "current-filter-matched-with-items": "광고 계약 일치",
  "current-filter-matched-empty": "광고 계약 일치·결과 0건",
  "current-filter-matched-root-shape-mismatch": "광고 응답 구조 변경",
  "current-filter-matched-root-unrecognized": "광고 응답 구조 미확인"
});

function setServiceState(state, text) {
  elements.serviceState.dataset.state = state;
  elements.serviceStateText.textContent = text;
}

function setMessage(text, tone = "") {
  elements.message.textContent = text;
  if (tone) elements.message.dataset.tone = tone;
  else delete elements.message.dataset.tone;
}

function setLoading(loading) {
  elements.collectButton.disabled = loading;
  elements.collectButton.dataset.loading = String(loading);
  elements.buttonLabel.textContent = loading ? "수집 중" : "수집 실행";
  elements.modeDemo.disabled = loading;
  elements.modeLive.disabled = loading || !serviceStatus?.liveEnabled || serviceStatus?.providerBlocked === true;
  elements.keyword.disabled = loading;
  elements.token.disabled = loading;
}

function selectedMode() {
  return elements.modeLive.checked ? "live" : "demo";
}

function updateModeState() {
  const live = selectedMode() === "live";
  elements.token.required = live || serviceStatus?.authRequired === true;
  elements.token.placeholder = live ? "Live 관리자 토큰" : "배포 환경에서 입력";
  setMessage(live ? "Live · 네이버 요청 1회" : "Demo · 외부 요청 0회");
}

function activateTab(tab) {
  for (const candidate of tabs) {
    const selected = candidate === tab;
    candidate.setAttribute("aria-selected", String(selected));
    candidate.tabIndex = selected ? 0 : -1;
  }
  for (const panel of panels) panel.hidden = panel.id !== tab.getAttribute("aria-controls");
}

for (const tab of tabs) {
  tab.addEventListener("click", () => activateTab(tab));
  tab.addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
    event.preventDefault();
    const direction = event.key === "ArrowRight" ? 1 : -1;
    const next = tabs[(tabs.indexOf(tab) + direction + tabs.length) % tabs.length];
    activateTab(next);
    next.focus();
  });
}

function currency(value) {
  return Number.isFinite(Number(value)) ? `${new Intl.NumberFormat("ko-KR").format(Number(value))}원` : "-";
}

function reviewText(row) {
  const score = row.reviewScore !== null && row.reviewScore !== undefined && Number.isFinite(Number(row.reviewScore))
    ? Number(row.reviewScore).toFixed(1)
    : null;
  const count = row.reviewCount !== null && row.reviewCount !== undefined && Number.isFinite(Number(row.reviewCount))
    ? new Intl.NumberFormat("ko-KR").format(Number(row.reviewCount))
    : null;
  if (score && count) return `평점 ${score} · 리뷰 ${count}`;
  if (count) return `리뷰 ${count}`;
  return "리뷰 정보 없음";
}

function tag(text, className) {
  const span = document.createElement("span");
  span.className = className;
  span.textContent = text;
  return span;
}

function renderRows(target, rows, type) {
  target.replaceChildren();
  const fragment = document.createDocumentFragment();
  for (const row of rows) {
    const element = elements.rowTemplate.content.firstElementChild.cloneNode(true);
    element.querySelector(".rank-cell").replaceChildren(
      type === "ad" ? tag(`AD ${row.adOrder}`, "ad-tag") : document.createTextNode(String(row.rank))
    );
    element.querySelector(".place-name").textContent = row.name || "이름 없음";
    element.querySelector(".review-text").textContent = reviewText(row);
    element.querySelector(".place-id").textContent = row.placeId || "-";
    element.querySelector(".address-text").textContent = row.address || "주소 없음";
    element.querySelector(".category-text").textContent = row.category || "업종 없음";
    const bookingCell = element.querySelector(".booking-cell");
    bookingCell.replaceChildren(row.hasBooking === true
      ? tag("예약", "booking-tag")
      : row.hasBooking === false ? tag("없음", "no-tag") : tag("미확인", "no-tag"));
    element.querySelector(".room-cell").textContent = `${Number(row.roomPreviewCount || 0)}개`;
    element.querySelector(".price-cell").textContent = currency(row.minimumPrice);
    fragment.append(element);
  }
  target.append(fragment);
}

function percent(value, total) {
  return total > 0 ? `${Math.round((value / total) * 10000) / 100}%` : "0%";
}

function renderResult(result) {
  latestResult = result;
  const organic = Array.isArray(result.organic) ? result.organic : [];
  const advertisements = Array.isArray(result.advertisements) ? result.advertisements : [];
  elements.organicCount.textContent = String(organic.length);
  elements.adCount.textContent = String(advertisements.length);
  elements.requestCount.textContent = String(result.externalRequests ?? 0);
  elements.elapsedValue.textContent = Number.isFinite(Number(result.elapsedMs)) ? `${Number(result.elapsedMs).toLocaleString("ko-KR")}ms` : "-";
  elements.organicTabCount.textContent = String(organic.length);
  elements.adTabCount.textContent = String(advertisements.length);
  renderRows(elements.organicRows, organic, "organic");
  renderRows(elements.adRows, advertisements, "ad");

  const total = organic.length + advertisements.length;
  elements.organicBalance.style.width = percent(organic.length, total);
  elements.adBalance.style.width = percent(advertisements.length, total);

  const diagnostics = result.diagnostics || {};
  const adDiagnostics = diagnostics.advertisement || {};
  elements.advertisementSource.textContent = result.advertisementEvidence
    ? `통합검색 실화면 · ${result.advertisementEvidence.browserVisibleRows}건`
    : "숙박 목록 snapshot";
  elements.diagnosticStatus.textContent = DIAGNOSTIC_LABELS[diagnostics.status] || diagnostics.status || "-";
  elements.candidateCount.textContent = String(adDiagnostics.candidateCount ?? "-");
  elements.matchedCandidateCount.textContent = String(adDiagnostics.matchedCandidateCount ?? "-");
  elements.rootKeyCount.textContent = String(diagnostics.apollo?.rootQueryKeyCount ?? "-");
  elements.responseBytes.textContent = Number.isFinite(Number(diagnostics.response?.bodyBytes))
    ? `${Number(diagnostics.response.bodyBytes).toLocaleString("ko-KR")} bytes`
    : "-";
  elements.responseDigest.textContent = diagnostics.response?.bodySha256 || "-";
  elements.manifestDigest.textContent = result.manifestDigest || "-";
  elements.rawStorage.textContent = result.rawProviderResponseStored === false ? "차단" : "확인 필요";
  elements.downloadJson.disabled = false;
  elements.downloadCsv.disabled = false;
}

function download(name, contents, type) {
  const url = URL.createObjectURL(new Blob([contents], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function csvCell(value) {
  const text = Array.isArray(value) ? value.join(" | ") : value === null || value === undefined ? "" : String(value);
  return `"${text.replaceAll('"', '""')}"`;
}

function resultCsv(result) {
  const headers = ["resultType", "order", "placeId", "name", "category", "address", "hasBooking", "minimumPrice", "roomPreviewCount", "source", "evidenceLevel"];
  const rows = [
    ...(result.organic || []).map((row) => ({ resultType: "organic", order: row.rank, ...row })),
    ...(result.advertisements || []).map((row) => ({ resultType: "advertisement", order: row.adOrder, ...row }))
  ];
  return `\uFEFF${[headers, ...rows.map((row) => headers.map((key) => row[key]))].map((row) => row.map(csvCell).join(",")).join("\r\n")}\r\n`;
}

function browserAdContract() {
  const contract = globalThis.V2NaverVisiblePlaceAdContract;
  if (!contract || typeof contract.validateVisibleAdCaptureEnvelope !== "function" || typeof contract.mergeVisibleAdsWithPlaceResult !== "function") {
    throw new Error("V2_BROWSER_AD_CONTRACT_UNAVAILABLE");
  }
  return contract;
}

async function readCaptureFile(file) {
  if (!(file instanceof File) || file.size < 2 || file.size > 64 * 1024) {
    throw new Error("V2_BROWSER_AD_FILE_INVALID");
  }
  let value;
  try {
    value = JSON.parse(await file.text());
  } catch {
    throw new Error("V2_BROWSER_AD_FILE_INVALID");
  }
  return value;
}

async function loadBookmarklet() {
  try {
    const response = await fetch("/naver-ad-bookmarklet.txt", { headers: { accept: "text/plain" } });
    const value = (await response.text()).trim();
    if (!response.ok || !value.startsWith("javascript:") || value.length > 20000) throw new Error("BOOKMARKLET_INVALID");
    elements.bookmarkletLink.href = value;
    elements.bookmarkletLink.setAttribute("aria-disabled", "false");
    elements.browserAdFile.disabled = false;
    bookmarkletReady = true;
  } catch {
    elements.bookmarkletLink.setAttribute("aria-disabled", "true");
    elements.browserAdFile.disabled = true;
  }
}

elements.bookmarkletLink.addEventListener("click", async (event) => {
  event.preventDefault();
  if (!bookmarkletReady) {
    setMessage("광고 캡처 도구를 불러오지 못했습니다.", "error");
    return;
  }
  try {
    await navigator.clipboard.writeText(elements.bookmarkletLink.href);
    setMessage("광고 캡처 도구를 복사했습니다.", "success");
  } catch {
    setMessage("광고 캡처 링크를 북마크바에 끌어 놓아 주세요.");
  }
});

elements.browserAdFile.addEventListener("change", async () => {
  const file = elements.browserAdFile.files?.[0];
  elements.browserAdFile.value = "";
  if (!serverResult) {
    setMessage("Place 수집을 먼저 실행해 주세요.", "error");
    return;
  }
  try {
    const contract = browserAdContract();
    const capture = contract.validateVisibleAdCaptureEnvelope(await readCaptureFile(file), {
      expectedQuery: serverResult.keyword
    });
    const merged = contract.mergeVisibleAdsWithPlaceResult(serverResult, capture);
    renderResult(merged);
    elements.clearBrowserAds.disabled = false;
    setMessage(`통합검색 실화면 광고 ${merged.advertisements.length}건을 반영했습니다.`, "success");
    activateTab(document.querySelector("#tabAds"));
  } catch (error) {
    setMessage(`광고 증거를 반영하지 못했습니다. ${error.code || error.message || "INVALID"}`, "error");
  }
});

elements.clearBrowserAds.addEventListener("click", () => {
  if (!serverResult) return;
  renderResult(serverResult);
  elements.clearBrowserAds.disabled = true;
  setMessage("서버 snapshot 광고 결과로 복원했습니다.");
});

elements.downloadJson.addEventListener("click", () => {
  if (!latestResult) return;
  download(`${latestResult.runId}.json`, `${JSON.stringify(latestResult, null, 2)}\n`, "application/json;charset=utf-8");
});

elements.downloadCsv.addEventListener("click", () => {
  if (!latestResult) return;
  download(`${latestResult.runId}.csv`, resultCsv(latestResult), "text/csv;charset=utf-8");
});

async function loadStatus() {
  try {
    const response = await fetch("/api/status", { headers: { accept: "application/json" } });
    const value = await response.json();
    if (!response.ok || value.status !== "ready") throw new Error(value.code || "STATUS_FAILED");
    serviceStatus = value;
    elements.modeLive.disabled = !value.liveEnabled || value.providerBlocked === true;
    if (!value.liveEnabled || value.providerBlocked) elements.modeDemo.checked = true;
    const limit = value.liveRequestPolicy === "manual-unlimited" ? "제한 없음" : value.dailyLiveRequestLimit;
    elements.budgetValue.textContent = `${value.dailyLiveRequestsUsed} / ${limit}`;
    setServiceState(
      value.providerBlocked ? "error" : "ready",
      value.providerBlocked ? `Live 차단 · HTTP ${value.providerBlockStatus}` : value.liveEnabled ? "Live 사용 가능" : "Demo 준비됨"
    );
    updateModeState();
  } catch {
    setServiceState("error", "상태 확인 실패");
    setMessage("서비스 상태를 확인할 수 없습니다.", "error");
    elements.collectButton.disabled = true;
  }
}

elements.modeDemo.addEventListener("change", updateModeState);
elements.modeLive.addEventListener("change", updateModeState);

elements.form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const keyword = elements.keyword.value.normalize("NFC").trim().replace(/\s+/gu, " ");
  const mode = selectedMode();
  if (!keyword) {
    setMessage("검색어를 입력해 주세요.", "error");
    elements.keyword.focus();
    return;
  }
  if ((mode === "live" || serviceStatus?.authRequired) && !elements.token.value) {
    setMessage("관리자 토큰을 입력해 주세요.", "error");
    elements.token.focus();
    return;
  }

  setLoading(true);
  setMessage(mode === "live" ? "Live 수집을 실행하고 있습니다." : "Demo 결과를 생성하고 있습니다.");
  try {
    const idempotencyKey = globalThis.crypto?.randomUUID?.() || `ui-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const headers = { "content-type": "application/json", accept: "application/json" };
    if (elements.token.value) headers["x-v2-basic-operator-token"] = elements.token.value;
    const response = await fetch("/api/collect", {
      method: "POST",
      headers,
      body: JSON.stringify({ mode, keyword, idempotencyKey })
    });
    const value = await response.json();
    if (!response.ok || value.status !== "completed") {
      const error = new Error(value.code || "V2_BASIC_UI_REQUEST_FAILED");
      error.code = value.code;
      error.providerStatus = Number.isInteger(value.providerStatus) ? value.providerStatus : null;
      throw error;
    }
    serverResult = value;
    renderResult(value);
    elements.clearBrowserAds.disabled = true;
    await loadStatus();
    setMessage(`${value.mode === "live" ? "Live" : "Demo"} 수집 완료 · ${value.keyword}`, "success");
  } catch (error) {
    const providerStatus = Number.isInteger(error.providerStatus) ? ` (HTTP ${error.providerStatus})` : "";
    await loadStatus();
    setMessage(`${ERROR_LABELS[error.code] || `수집이 중단됐습니다. ${error.code || "UNKNOWN"}`}${providerStatus}`, "error");
  } finally {
    setLoading(false);
  }
});

Promise.all([loadStatus(), loadBookmarklet()]);
