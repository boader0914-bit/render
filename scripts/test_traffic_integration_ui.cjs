const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ui = require("../web/traffic-integration-status.js");
const app = fs.readFileSync(path.join(__dirname, "../web/app.js"), "utf8");
const now = Date.parse("2026-10-31T01:00:00Z");
const checkedAt = "2026-10-31T00:00:00Z";
function data(check = {}, provider = "datalab") {
  return { datalabConfigured: true, searchadConfigured: true, verification: { [provider]: { configured: true, ok: true, status: 200, errorCode: "OK", checkStatus: "verified", checkedAt, validForCurrentKeys: true, stale: false, ...check } } };
}
test("saved credentials and missing status are not verified connections", () => {
  assert.equal(ui.row({ datalabConfigured: true }, "datalab", { now }).statusLabel, "테스트 전");
  assert.equal(ui.row(null, "datalab", { now }).statusLabel, "저장 상태 미확인");
  assert.equal(ui.row({}, "datalab", { now }).statusLabel, "미설정");
});
test("a persisted recent valid check survives a page reload with KST timestamp", () => {
  const row = ui.row(JSON.parse(JSON.stringify(data())), "datalab", { now });
  assert.equal(row.status, "connected"); assert.equal(row.statusLabel, "최근 테스트 정상");
  assert.match(row.checkedAtLabel, /09:00.*KST/);
  assert.match(ui.detail(row), /검색 트렌드 연결 테스트/);
});
test("expired or changed-key evidence does not establish the current connection", () => {
  assert.equal(ui.row(data({ checkedAt: "2026-10-29T00:00:00Z" }), "datalab", { now }).statusLabel, "이전 테스트 정상");
  assert.equal(ui.row(data({ checkStatus: "key_changed", validForCurrentKeys: false }), "datalab", { now }).statusLabel, "키 변경 후 재확인");
  assert.notEqual(ui.row(data({ validForCurrentKeys: false }), "datalab", { now }).status, "connected");
});
test("HTTP200 alone, unknown timestamps and corrupt records are not verification", () => {
  assert.notEqual(ui.row(data({ ok: false, checkStatus: "failed" }), "datalab", { now }).status, "connected");
  assert.notEqual(ui.row(data({ checkedAt: "invalid" }), "datalab", { now }).status, "connected");
  assert.notEqual(ui.row(data({ checkedAt: "2030-01-01T00:00:00Z" }), "datalab", { now }).status, "connected");
  assert.notEqual(ui.row(data({ status: 403, errorCode: "AUTH_ERROR" }), "datalab", { now }).status, "connected");
  assert.equal(ui.row(data({ checkStatus: "unknown", errorCode: "CHECK_RECORD_UNAVAILABLE" }), "datalab", { now }).statusLabel, "결과 미확인");
});
test("failures, limits and valid empty data have separate labels without raw provider text", () => {
  const hostile = data({ ok: false, checkStatus: "failed", errorCode: "AUTH_ERROR", status: 403, message: "secret_credential<script>" });
  const row = ui.row(hostile, "datalab", { now });
  assert.equal(row.statusLabel, "테스트 실패"); assert.match(row.statusNote, /이용 권한/);
  assert.doesNotMatch(ui.detail(row) + row.statusNote, /secret_credential|<script>/);
  assert.equal(ui.row(data({ checkStatus: "limited", ok: false, errorCode: "RATE_LIMITED", status: 429 }), "datalab", { now }).statusLabel, "호출 제한 확인");
  assert.equal(ui.row(data({ checkStatus: "no_data" }), "datalab", { now }).statusLabel, "응답 확인 · 자료 없음");
});
test("per-service actions expose cooldown and prevent overlapping manual requests", () => {
  assert.equal(ui.row(data(), "datalab", { now, testing: "searchad" }).disabled, true);
  assert.equal(ui.row(data(), "datalab", { now, testing: "datalab" }).statusLabel, "테스트 중");
  const row = ui.row(data({ cooldownUntil: "2026-10-31T01:00:30Z" }), "datalab", { now });
  assert.equal(row.disabled, true); assert.match(ui.detail(row), /다음 테스트/);
});
function fixture(fetchJson) {
  const el = () => ({ textContent: "", innerHTML: "", disabled: false });
  const state = { trafficKeyState: null, trafficProviderDraft: null, trafficVerifying: "", trafficKeyLoading: false, trafficKeySaving: false, trafficKeyRequestSequence: 0, trafficTestNotice: "" };
  const els = { trafficKeyVerifyButton: el(), trafficKeyStatus: el(), trafficKeyVerifyResult: el(), trafficApiState: el(), adminIntegrationRegistry: el(), trafficKeyForm: { reset() {} }, naverClientIdInput: { value: "fake-new-client" }, naverClientSecretInput: { value: "" }, datalabProviderInput: { value: "developers" }, datalabProviderStatus: el(), ncpApihubClientIdInput: { value: "" }, ncpApihubClientSecretInput: { value: "" } };
  const context = vm.createContext({ state, els, window: { TrafficIntegrationStatus: ui }, fetchJson, isAdminRole: () => true, renderDemand() {}, renderAdminConsoleDashboard() {}, escapeHtml: value => String(value), fmtNumber: String,
    ADMIN_INTEGRATIONS: [{ key: "naver-datalab", group: "네이버", provider: "NAVER", name: "검색 트렌드", liveKey: "datalab" }, { key: "naver-searchad", group: "네이버", provider: "NAVER", name: "검색광고 키워드", liveKey: "searchad" }] });
  const names = ["adminIntegrationRows", "adminIntegrationSummary", "adminIntegrationSummaryLabel", "renderAdminIntegrationRegistry", "syncTrafficKeyForm", "renderTrafficVerification", "renderTrafficState", "loadTrafficState", "verifyTrafficKeys", "submitTrafficKeys"];
  for (const name of names) {
    const expression = new RegExp(`^(?:async )?function ${name}\\([^]*?^}`, "m");
    const code = app.match(expression)?.[0]; assert.ok(code, name); vm.runInContext(code, context);
  }
  return { state, els, context };
}
test("settings reload performs only saved-state GET and renders both direct actions", async () => {
  const calls = [], f = fixture(async (...args) => { calls.push(args); return data(); });
  await f.context.loadTrafficState();
  assert.equal(calls.length, 1); assert.equal(calls[0][0], "/api/settings/traffic-keys");
  assert.equal(calls[0][1], undefined);
  assert.match(f.els.adminIntegrationRegistry.innerHTML, /data-traffic-test="datalab"/);
  assert.match(f.els.adminIntegrationRegistry.innerHTML, /data-traffic-test="searchad"/);
  assert.match(f.els.adminIntegrationRegistry.innerHTML, /NAVER · 네이버/);
});
test("a manual service test sends its exact target once and ignores duplicate clicks", async () => {
  const calls = []; let finish;
  const f = fixture((...args) => { calls.push(args); return new Promise(resolve => { finish = resolve; }); });
  const first = f.context.verifyTrafficKeys("datalab");
  await f.context.verifyTrafficKeys("searchad");
  assert.equal(calls.length, 1); assert.equal(JSON.parse(calls[0][1].body).provider, "datalab");
  assert.equal(f.state.trafficVerifying, "datalab");
  finish(data({ checkedAt: new Date().toISOString() })); await first;
  assert.equal(f.state.trafficVerifying, ""); assert.equal(f.els.trafficKeyVerifyButton.disabled, false);
});
test("late saved-state reads cannot replace newer test evidence or lock refresh", async () => {
  let finishRead;
  const fresh = data({ checkedAt: new Date().toISOString() });
  const f = fixture((url) => url.endsWith("/verify") ? Promise.resolve(fresh) : new Promise(resolve => { finishRead = resolve; }));
  const read = f.context.loadTrafficState();
  await f.context.verifyTrafficKeys("datalab");
  finishRead({ datalabConfigured: false }); await read;
  assert.equal(f.state.trafficKeyState, fresh); assert.equal(f.state.trafficKeyLoading, false);
});
test("key saving is separate from testing and blank values retain existing credentials", async () => {
  const calls = [], f = fixture(async (...args) => { calls.push(args); return { datalabConfigured: true }; });
  await f.context.submitTrafficKeys({ preventDefault() {} });
  assert.equal(calls.length, 1); assert.equal(calls[0][0], "/api/settings/traffic-keys");
  assert.deepEqual(JSON.parse(calls[0][1].body), { naverClientId: "fake-new-client", datalabProvider: "developers" });
  f.els.naverClientIdInput.value = ""; await f.context.submitTrafficKeys({ preventDefault() {} });
  assert.equal(calls.length, 1); assert.equal(f.state.trafficKeySaving, false);
});
test("one API success cannot label a second API failure as all-normal", () => {
  const f = fixture(async () => ({})), checkedAt = new Date().toISOString();
  f.context.renderTrafficState({ ...data({ checkedAt }), verification: { datalab: data({ checkedAt }).verification.datalab, searchad: { configured: true, ok: false, status: 403, checkStatus: "failed", errorCode: "AUTH_ERROR", checkedAt, validForCurrentKeys: true } } });
  assert.equal(f.els.trafficApiState.textContent, "연결 확인 필요");
});
test("one configured successful API does not imply both APIs are verified", () => {
  const f = fixture(async () => ({}));
  f.context.renderTrafficState({ ...data({ checkedAt: new Date().toISOString() }), searchadConfigured: false });
  assert.equal(f.els.trafficApiState.textContent, "일부 확인");
});
test("an unsuccessful test transport preserves previous evidence without raw exception text", async () => {
  const f = fixture(async () => { throw Error("raw_secret_material"); });
  const saved = data(); f.state.trafficKeyState = saved;
  await f.context.verifyTrafficKeys("searchad");
  assert.equal(f.state.trafficKeyState, saved);
  assert.match(f.state.trafficTestNotice, /현재 연결은 미확인/);
  assert.doesNotMatch(f.els.trafficKeyStatus.textContent, /raw_secret/);
});
test("a missing display module cannot turn historical ok flags into a verified connection", () => {
  const f = fixture(async () => ({}));
  delete f.context.window.TrafficIntegrationStatus;
  f.state.trafficKeyState = data({ stale: true });
  const row = f.context.adminIntegrationRows()[0];
  assert.equal(row.status, "checking");
  assert.equal(row.statusLabel, "표시 기능 확인 필요");
});
test("an unreadable skipped check is unknown rather than a successful cooldown reuse", async () => {
  const result = { ...data({ checkStatus: "unknown", ok: false, errorCode: "CHECK_RECORD_UNAVAILABLE" }), verification: { test: { testSkipped: true, attempts: [{ provider: "datalab", performed: false, reason: "CHECK_RECORD_UNAVAILABLE" }] } } };
  const f = fixture(async () => result);
  await f.context.verifyTrafficKeys("datalab");
  assert.match(f.state.trafficTestNotice, /읽거나 저장하지 못했습니다/);
  assert.doesNotMatch(f.state.trafficTestNotice, /최근 테스트 기록을 표시/);
});

test("bounded SearchAd response diagnostics survive rendering without raw response text", () => {
  const row = ui.row(data({ diagnostics: { responseBytes: 390000, responseLimitBytes: 2097152, legacyResponseLimitBytes: 262144, legacyLimitExceeded: true, utf8Bom: false, keywordCount: 1000, validationStage: "verified", rawBody: "private-provider-body" } }, "searchad"), "searchad", { now });
  assert.equal(row.status, "connected");
  assert.match(row.diagnosticLabel, /390,000바이트.*1,000개.*이전 검사 크기 초과/);
  assert.doesNotMatch(ui.detail(row), /private-provider-body|rawBody/);
});

test("size, JSON, and body-read failures have distinct safe UI reasons", () => {
  for (const [code, note] of [["RESPONSE_TOO_LARGE", /응답 크기/], ["INVALID_JSON", /JSON/], ["RESPONSE_READ_ERROR", /끝까지/]]) {
    const row = ui.row(data({ checkStatus: "failed", ok: false, errorCode: code }, "searchad"), "searchad", { now });
    assert.equal(row.statusLabel, "테스트 실패"); assert.match(row.statusNote, note); assert.match(ui.detail(row), new RegExp(code));
  }
});

test("invalid diagnostics never render arbitrary provider fields or guessed counts", () => {
  const row = ui.row(data({ diagnostics: { responseBytes: -1, responseLimitBytes: 2097152, legacyResponseLimitBytes: 262144, legacyLimitExceeded: false, validationStage: "verified", keywordCount: "private-string" } }, "searchad"), "searchad", { now });
  assert.equal(row.diagnosticLabel, ""); assert.doesNotMatch(ui.detail(row), /private-string|수신 확인/);
});

test("cloud trend credentials are distinct from the separate official SearchAd service", () => {
  const cloud = ui.row({ ...data(), datalabProvider: "ncp_apihub", datalabProviderLabel: "private-untrusted-label" }, "datalab", { now });
  assert.match(cloud.connectionLabel, /NAVER API HUB.*네이버 클라우드/);
  assert.match(ui.detail(cloud), /현재 저장 연결/);
  assert.doesNotMatch(ui.detail(cloud), /private-untrusted-label/);
  const searchad = ui.row({ ...data({}, "searchad"), datalabProvider: "ncp_apihub" }, "searchad", { now });
  assert.match(searchad.connectionLabel, /검색광고 API.*별도 서비스/);
  assert.doesNotMatch(searchad.connectionLabel, /API HUB/);
});

test("a saved-state read preserves an unsaved provider choice and both credential drafts", async () => {
  const calls = [], f = fixture(async (...args) => { calls.push(args); return { ...data(), datalabProvider: "developers" }; });
  f.els.datalabProviderInput.value = "ncp_apihub";
  f.state.trafficProviderDraft = "ncp_apihub";
  f.els.ncpApihubClientIdInput.value = "fake-cloud-draft";
  f.els.ncpApihubClientSecretInput.value = "fake-cloud-secret-draft";
  await f.context.loadTrafficState();
  assert.equal(calls.length, 1);
  assert.equal(f.els.datalabProviderInput.value, "ncp_apihub");
  assert.equal(f.els.ncpApihubClientIdInput.value, "fake-cloud-draft");
  assert.equal(f.els.ncpApihubClientSecretInput.value, "fake-cloud-secret-draft");
  assert.match(f.els.datalabProviderStatus.textContent, /기존 네이버 개발자센터.*아직 저장되지/);
});

test("provider-only changes can be saved without copying any existing credential", async () => {
  const calls = [], f = fixture(async (...args) => { calls.push(args); return { datalabProvider: "ncp_apihub", datalabConfigured: false, searchadConfigured: true }; });
  f.els.naverClientIdInput.value = "";
  f.state.trafficKeyState = { datalabProvider: "developers", datalabConfigured: true };
  f.els.datalabProviderInput.value = "ncp_apihub";
  f.state.trafficProviderDraft = "ncp_apihub";
  await f.context.submitTrafficKeys({ preventDefault() {} });
  assert.equal(calls.length, 1);
  assert.deepEqual(JSON.parse(calls[0][1].body), { datalabProvider: "ncp_apihub" });
  assert.equal(f.els.datalabProviderInput.value, "ncp_apihub");
  assert.match(f.els.datalabProviderStatus.textContent, /선택한 서비스의 인증정보 필요/);
  assert.equal(f.state.trafficProviderDraft, null);
  assert.notEqual(f.els.trafficApiState.textContent, "최근 테스트 정상");
});

test("cloud key saving sends only entered values and never triggers provider verification", async () => {
  const calls = [], f = fixture(async (...args) => { calls.push(args); return { datalabProvider: "ncp_apihub", datalabConfigured: true }; });
  f.els.naverClientIdInput.value = "";
  f.els.datalabProviderInput.value = "ncp_apihub";
  f.els.ncpApihubClientIdInput.value = "fake-cloud-id";
  f.els.ncpApihubClientSecretInput.value = "fake-cloud-secret";
  await f.context.submitTrafficKeys({ preventDefault() {} });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "/api/settings/traffic-keys");
  assert.deepEqual(JSON.parse(calls[0][1].body), { datalabProvider: "ncp_apihub", ncpApihubClientId: "fake-cloud-id", ncpApihubClientSecret: "fake-cloud-secret" });
  assert.equal(f.els.ncpApihubClientIdInput.value, "");
  assert.equal(f.els.ncpApihubClientSecretInput.value, "");
});

test("saving never clears edits made while the request is in flight", async () => {
  let finish;
  const f = fixture(() => new Promise(resolve => { finish = resolve; }));
  f.els.naverClientIdInput.value = "";
  f.els.datalabProviderInput.value = "ncp_apihub";
  f.els.ncpApihubClientSecretInput.value = "fake-submitted-secret";
  const save = f.context.submitTrafficKeys({ preventDefault() {} });
  f.els.datalabProviderInput.value = "developers";
  f.state.trafficProviderDraft = "developers";
  f.els.ncpApihubClientSecretInput.value = "fake-new-unsaved-secret";
  finish({ datalabProvider: "ncp_apihub", datalabConfigured: true });
  await save;
  assert.equal(f.els.ncpApihubClientSecretInput.value, "fake-new-unsaved-secret");
  assert.equal(f.els.datalabProviderInput.value, "developers");
  assert.match(f.els.datalabProviderStatus.textContent, /아직 저장되지/);
});

test("failed saves retain drafts and server-supplied masks are never placed in key fields", async () => {
  const f = fixture(async () => { throw Error("private-server-error"); });
  f.els.naverClientIdInput.value = "";
  f.els.datalabProviderInput.value = "ncp_apihub";
  f.state.trafficProviderDraft = "ncp_apihub";
  f.els.ncpApihubClientIdInput.value = "fake-unsaved-id";
  await f.context.submitTrafficKeys({ preventDefault() {} });
  assert.equal(f.els.ncpApihubClientIdInput.value, "fake-unsaved-id");
  assert.doesNotMatch(f.els.trafficKeyStatus.textContent, /private-server-error/);
  f.context.renderTrafficState({ datalabProvider: "developers", storage: { envFields: { ncpApihubClientId: true, datalabProvider: true } }, fields: { ncpApihubClientId: { configured: true, masked: "private-mask" } } });
  assert.equal(f.els.ncpApihubClientIdInput.value, "fake-unsaved-id");
  assert.match(f.els.ncpApihubClientIdInput.placeholder, /서버 값 우선/);
  assert.doesNotMatch(f.els.ncpApihubClientIdInput.placeholder + f.els.datalabProviderStatus.textContent, /private-mask/);
});

test("cloud credentials use password fields with an explicit official migration link", () => {
  const html = fs.readFileSync(path.join(__dirname, "../web/index.html"), "utf8");
  for (const id of ["ncpApihubClientIdInput", "ncpApihubClientSecretInput"]) assert.match(html, new RegExp(`<input id="${id}" type="password" autocomplete="off">`));
  assert.match(html, /https:\/\/guide\.ncloud-docs\.com\/docs\/apihub-migration/);
  assert.match(html, /기존 키로 자동 전환하지 않습니다/);
});

test("unknown explicit providers cannot inherit a legacy label or a verified connection", () => {
  for (const datalabProvider of ["unknown-provider", "", null, 4]) {
    const row = ui.row({ ...data(), datalabProvider }, "datalab", { now });
    assert.equal(row.configured, false);
    assert.equal(row.disabled, true);
    assert.equal(row.connectionLabel, "연결 방식 확인 필요");
    assert.equal(row.statusLabel, "연결 방식 확인 필요");
    assert.doesNotMatch(ui.detail(row), /기존 네이버 개발자센터/);
  }
  assert.match(ui.row(data(), "datalab", { now }).connectionLabel, /기존 네이버 개발자센터/);
});

test("unknown stored provider leaves the form unselected until an explicit valid choice", async () => {
  const calls = [], f = fixture(async (...args) => { calls.push(args); return {}; });
  f.context.renderTrafficState({ datalabProvider: "unsupported", datalabConfigured: false });
  assert.equal(f.els.datalabProviderInput.value, "");
  assert.match(f.els.datalabProviderStatus.textContent, /연결 방식 확인 필요/);
  await f.context.submitTrafficKeys({ preventDefault() {} });
  assert.equal(calls.length, 0);
  assert.match(f.els.trafficKeyStatus.textContent, /다시 선택/);
  assert.equal(f.els.naverClientIdInput.value, "fake-new-client");
});
