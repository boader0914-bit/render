"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { viewModel, resultHtml, editorHtml, createReader, createController: createScopedController, createMarketReader, createRegionController, marketViewModel, marketResultHtml, checkedMarketResult, MAX_IMPORT_BYTES } = require("../web/regional-catchment.js");
// Existing address protections always exercise the explicitly selected mode.
const createController = options => createScopedController({ ...options, mode: "address_radius" });
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const scope = extra => ({ accountKey: "admin-a", regionKey: "sancheong", regionLabel: "산청군", ...extra });
function payload(extra = {}) {
  return { scope: { regionKey: "sancheong", label: "산청군" }, status: "missing", configuration: null, datasets: [], snapshot: null, job: null, storage: {}, sourceCatalog: [], ...extra };
}
function complete(value = 0) {
  return payload({ status: "ready", configuration: { center: { address: "경상남도 산청군 산청읍 산청대로 1", latitude: 35.41, longitude: 127.87, label: "확인한 기준점", sourceUrl: "https://example.org/point", confirmed: true }, datasetId: "grid-2024" },
    snapshot: { resultId: "saved-1", calculatedAt: "2026-10-21T01:00:00Z", scope: { regionKey: "sancheong", label: "산청군", center: { address: "경상남도 산청군 산청읍 산청대로 1", label: "확인한 기준점", latitude: 35.41, longitude: 127.87 } },
      dataset: { id: "grid-2024", sourceYear: "2024", boundaryYear: "2023", gridSizeM: 1000, provider: "공개 제공처", sourceUrl: "https://example.org/data" },
      rings: ["inner50", "outer50to100", "total100"].map(key => ({ key, coverage: { status: "complete", completeFrame: true, bboxContainsCircle: true, declaredByAdmin: true, selectedCells: 10 },
        metrics: Object.fromEntries(["population", "establishments", "workers"].map(metric => [metric, { status: "observed_public", value, publishedSum: value, knownCells: 10, missingCells: 0, suppressedCells: 0, protectedZeroCells: 0, unit: metric === "establishments" ? "개" : "명" }])) })) } });
}
function host() {
  const slots = { "[data-rc-results]": { innerHTML: "" }, "[data-rc-editor-slot]": { innerHTML: "", querySelectorAll: () => [] }, "[data-rc-message]": { textContent: "" } };
  return { dataset: {}, innerHTML: "", isConnected: true, listeners: {}, slots,
    querySelector: selector => slots[selector] || null, querySelectorAll: () => [], addEventListener(name, listener) { this.listeners[name] = listener; } };
}
function controller(options = {}) {
  const fetchJson = options.fetchJson;
  return createController({ reader: createReader(), afterPaint: callback => callback(), ...options,
    fetchJson: (url, init) => url.startsWith("/api/regional-catchment/addresses?") ? Promise.resolve({ addresses: options.addressTargets || [] }) : fetchJson(url, init) });
}

test("unqueried/loading never invent values, zero coverage or a confirmed absence", () => {
  const before = viewModel(null), loading = viewModel(null, { loading: true });
  assert.equal(before.status, "unqueried"); assert.equal(loading.status, "loading");
  for (const model of [before, loading]) for (const card of model.cards) { assert.equal(card.coverage, null); assert.ok(card.metrics.every(metric => metric.value === null && metric.publishedSum === null)); }
  assert.match(resultHtml(null), /미조회/); assert.match(resultHtml(null, { loading: true }), /저장자료 확인 중/);
  assert.doesNotMatch(resultHtml(null, { loading: true }), /data-rc-value="0"|공간자료 미확보/);
  assert.equal(viewModel(payload()).status, "missing"); assert.match(resultHtml(payload()), /중심점 미설정/);
  const configured = payload({ configuration: { center: { address: "경상남도 산청군 산청읍 산청대로 1", confirmed: true }, datasetId: "" } });
  assert.match(resultHtml(configured), /격자 미반입/);
});

test("a genuine normal zero remains zero with its actual annual period", () => {
  const model = viewModel(complete(0));
  for (const card of model.cards) for (const metric of card.metrics) { assert.equal(metric.value, 0); assert.equal(metric.sourceYear, "2024"); assert.equal(metric.publishedSum, null); }
  const html = resultHtml(complete(0)); assert.equal((html.match(/data-rc-value="0"/g) || []).length, 9);
  assert.match(html, /data-rc-year="2024"/); assert.match(html, /관광수요·예약률 또는 이동시간을 뜻하지 않습니다/);
});

test("protected zero, suppression, missing cells and incomplete footprint do not become a full-radius value", () => {
  for (const change of [
    ring => { ring.metrics.population.status = "protected_zero"; ring.metrics.population.protectedZeroCells = 1; },
    ring => { ring.metrics.population.suppressedCells = 1; },
    ring => { ring.metrics.population.missingCells = 1; },
    ring => { ring.coverage.bboxContainsCircle = false; },
    ring => { ring.coverage.completeFrame = false; }
  ]) {
    const result = complete(120); change(result.snapshot.rings[0]); const metric = viewModel(result).cards[0].metrics[0];
    assert.equal(metric.value, null); assert.equal(metric.publishedSum, 120);
    assert.match(resultHtml(result), /확보 자료의 공개합 120/);
  }
  const protectedZero = complete(0); protectedZero.snapshot.rings[0].metrics.population.status = "protected_zero";
  protectedZero.snapshot.rings[0].metrics.population.protectedZeroCells = 1;
  assert.equal(viewModel(protectedZero).cards[0].metrics[0].value, null);
  assert.equal(viewModel(protectedZero).cards[0].metrics[0].publishedSum, 0);
});

test("unsafe source URLs and labels are escaped and are never executable links", () => {
  const result = complete(); result.snapshot.scope.center.label = '<img src=x onerror="bad()">'; result.snapshot.dataset.sourceUrl = "javascript:bad()";
  result.sourceCatalog = [{ label: "<script>bad()</script>", url: "data:text/html,bad" }];
  const html = resultHtml(result) + editorHtml(result, { label: '"><svg onload=bad()>', confirmed: false });
  assert.doesNotMatch(html, /href="javascript:|href="data:|<img src=|<script>|<svg/); assert.match(html, /&lt;img/);
  assert.match(html, /자료가 없는 형식 예제/); assert.match(html, /cells가 비어 있으면 분석자료로 사용할 수 없습니다/);
});

test("reader coalesces only the same account/region and clears prevent an old result from repopulating cache", async () => {
  const reader = createReader(), wait = deferred(), requests = [];
  const fetchJson = async url => { requests.push(url); return wait.promise; };
  const first = reader.get({ ...scope(), fetchJson }), same = reader.get({ ...scope(), fetchJson }); await tick();
  assert.equal(requests.length, 1); assert.equal(requests[0], "/api/regional-catchment?regionKey=sancheong");
  reader.clear("admin-a"); wait.resolve(complete(5)); await Promise.all([first, same]); assert.equal(reader.read(scope()), null);
  await reader.get({ ...scope({ accountKey: "admin-b" }), fetchJson: async () => complete(7) });
  assert.equal(reader.read(scope()), null); assert.equal(reader.read(scope({ accountKey: "admin-b" })).snapshot.rings[0].metrics.population.value, 7);
});

test("mismatched scope and storage failure preserve the last normal saved result", async () => {
  const reader = createReader(), good = complete(8); await reader.get({ ...scope(), fetchJson: async () => good });
  await assert.rejects(reader.get({ ...scope(), fetchJson: async () => payload({ scope: { regionKey: "other" } }) }), /범위/);
  await assert.rejects(reader.get({ ...scope(), fetchJson: async () => payload({ storage: { errorCode: "READ_ERROR" } }) }), /마지막 정상/);
  await assert.rejects(reader.get({ ...scope(), fetchJson: async () => ({ scope: { regionKey: "sancheong" } }) }), /응답 형식/);
  assert.equal(reader.read(scope()), good);
});

test("mount reuses saved data instantly, revalidates once, and repeated mounts do not duplicate reads", async () => {
  const reader = createReader(); reader.accept(scope(), complete(3)); const waiting = deferred(), calls = [], element = host(), paints = [];
  let time = 100;
  const control = controller({ reader, now: () => time, fetchJson: async url => { calls.push(url); return waiting.promise; } });
  const mounting = control.mount(element, { ...scope(), onDisplay: receipt => paints.push(receipt) }); await tick();
  assert.match(element.slots["[data-rc-results]"].innerHTML, /data-rc-value="3"/); assert.equal(element.dataset.rcReadSource, "cache");
  await control.mount(element, scope()); assert.equal(calls.length, 1);
  time = 900; waiting.resolve(complete(4)); await mounting;
  assert.equal(element.dataset.rcReadSource, "cache"); assert.equal(element.dataset.rcDisplayMs, "0");
  assert.match(element.slots["[data-rc-results]"].innerHTML, /data-rc-value="4"/); assert.equal(paints.length, 1); control.stop();
});

test("late former-region response and callbacks cannot replace the selected region", async () => {
  const first = deferred(), second = deferred(), element = host(), callbacks = [], queue = [];
  const control = controller({ afterPaint: callback => queue.push(callback), fetchJson: url => url.endsWith("sancheong") ? first.promise : second.promise });
  const a = control.mount(element, { ...scope(), onDisplay: value => callbacks.push(value) }); await tick();
  const b = control.mount(element, { ...scope({ regionKey: "sacheon" }), onDisplay: value => callbacks.push(value) }); await tick();
  const fresh = complete(42); fresh.scope.regionKey = "sacheon"; fresh.snapshot.scope.regionKey = "sacheon";
  second.resolve(fresh); await b; first.resolve(complete(99)); await a; queue.forEach(fn => fn());
  assert.equal(element.dataset.rcRegion, "sacheon"); assert.match(element.slots["[data-rc-results]"].innerHTML, /data-rc-value="42"/);
  assert.doesNotMatch(element.slots["[data-rc-results]"].innerHTML, /data-rc-value="99"/); assert.equal(callbacks.length, 1); assert.equal(callbacks[0].regionKey, "sacheon"); control.stop();
});

test("background result updates leave edited point fields and cursor-bearing form DOM intact", async () => {
  let response = complete(12); const element = host(), control = controller({ fetchJson: async () => response });
  await control.mount(element, scope()); const editor = element.slots["[data-rc-editor-slot]"];
  const before = editor.innerHTML;
  element.listeners.input({ target: { name: "label", value: "입력 중인 기준점" } });
  element.listeners.input({ target: { name: "latitude", value: "35.123" } });
  response = complete(13); await control.refreshStatus();
  assert.equal(control.state.draft.label, "입력 중인 기준점"); assert.equal(control.state.draft.latitude, "35.123");
  assert.equal(editor.innerHTML, before, "existing form nodes, focus and cursor must not be replaced");
  assert.match(element.slots["[data-rc-results]"].innerHTML, /data-rc-value="13"/); control.stop();
});

test("polling occurs only for an active job and stops on hide/stop", async () => {
  const tasks = [], cancelled = [], element = host(); let visible = true, reads = 0;
  const control = controller({ schedule: callback => { tasks.push(callback); return tasks.length; }, cancel: id => cancelled.push(id), fetchJson: async () => { reads++; return payload({ job: { status: "running" } }); } });
  await control.mount(element, { ...scope(), isVisible: () => visible }); assert.equal(tasks.length, 1);
  visible = false; tasks[0](); await tick(); assert.equal(reads, 1);
  control.stop(); assert.equal(element.dataset.rcDisplayStatus, "paused");
  await control.mount(element, { ...scope(), isVisible: () => false }); assert.equal(reads, 1);
});

test("oversized and invalid import files cannot cause a POST or reading a huge file", async () => {
  const calls = [], element = host(), control = controller({ fetchJson: async (url, options) => { calls.push({ url, options }); return payload(); } });
  await control.mount(element, scope()); let textReads = 0;
  const submit = file => element.listeners.submit({ preventDefault() {}, target: { getAttribute: () => "import", reportValidity: () => true, querySelector: () => ({ files: [file] }) } });
  await submit({ size: MAX_IMPORT_BYTES + 1, text: async () => { textReads++; return "{}"; } });
  assert.equal(textReads, 0); assert.match(control.state.actionMessage, /16MiB/);
  await submit({ size: 20, text: async () => "not-json" }); assert.match(control.state.actionMessage, /JSON/);
  await submit({ size: 4, text: async () => "null" }); assert.match(control.state.actionMessage, /JSON 객체/);
  assert.equal(calls.filter(item => item.options?.method === "POST").length, 0); control.stop();
});

test("unsaved or unconfirmed centers cannot trigger calculation and configure is explicit", async () => {
  const calls = [], element = host(), control = controller({ fetchJson: async (url, options) => { calls.push({ url, options }); return options ? complete(10) : payload(); } });
  await control.mount(element, scope());
  const click = () => element.listeners.click({ target: { closest: () => ({ getAttribute: () => "refresh" }) } });
  click(); assert.match(control.state.actionMessage, /중심점/); assert.equal(calls.length, 1);
  for (const [name, value] of Object.entries({ address: "경상남도 산청군 산청읍 산청대로 1", label: "실제 확인 기준점", latitude: "35.4", longitude: "127.8", sourceUrl: "https://example.org/point", datasetId: "grid-2024" })) element.listeners.input({ target: { name, value } });
  element.listeners.change({ target: { name: "confirmed", checked: true } }); click(); assert.match(control.state.actionMessage, /먼저 저장/);
  await element.listeners.submit({ preventDefault() {}, target: { getAttribute: () => "configure", reportValidity: () => true } });
  assert.equal(calls.length, 2); assert.equal(calls[1].url, "/api/regional-catchment/configure");
  const body = JSON.parse(calls[1].options.body); assert.equal(body.center.confirmed, true); assert.equal(body.center.latitude, 35.4); assert.equal(body.regionKey, "sancheong");
  assert.equal(control.state.dirty, false); control.stop();
});

test("actual mutation receipts cause one authoritative GET and do not fabricate an envelope", async () => {
  const calls = [], element = host(); let response = payload();
  const control = controller({ fetchJson: async (url, options) => {
    calls.push({ url, options });
    if (!options) return response;
    const body = JSON.parse(options.body); response = complete(15);
    response.configuration.center = body.center;
    return { configuration: response.configuration, reused: false };
  } });
  await control.mount(element, scope());
  for (const [name, value] of Object.entries({ address: "경상남도 산청군 산청읍 산청대로 1", label: "직접 확인한 지점", latitude: "35.4", longitude: "127.8", sourceUrl: "https://example.org/point", datasetId: "grid-2024" })) element.listeners.input({ target: { name, value } });
  element.listeners.change({ target: { name: "confirmed", checked: true } });
  await element.listeners.submit({ preventDefault() {}, target: { getAttribute: () => "configure", reportValidity: () => true } });
  assert.deepEqual(calls.map(call => call.options?.method || "GET"), ["GET", "POST", "GET"]);
  assert.equal(control.state.result.snapshot.resultId, "saved-1"); assert.equal(control.state.draft.label, "직접 확인한 지점"); assert.equal(control.state.dirty, false);
  assert.match(control.state.actionMessage, /저장했습니다/); control.stop();
});

test("a lost confirmation never automatically repeats a successful save", async () => {
  const calls = [], element = host(); let saved = false;
  const control = controller({ fetchJson: async (url, options) => {
    calls.push({ url, options });
    if (options) { saved = true; return { configuration: {}, reused: false }; }
    if (saved) throw Error("confirmation unavailable");
    return complete(9);
  } });
  await control.mount(element, scope());
  await element.listeners.submit({ preventDefault() {}, target: { getAttribute: () => "configure", reportValidity: () => true } });
  assert.equal(calls.filter(call => call.options).length, 1); assert.match(control.state.actionMessage, /要求|요청을 반복하지 말고/);
  assert.equal(control.state.result.snapshot.rings[0].metrics.population.value, 9); control.stop();
});

test("industry classification and residence versus workplace bases stay visible", () => {
  const result = complete(10); result.snapshot.dataset.industryClassification = "KSIC-11 · 전체산업";
  const html = resultHtml(result); assert.match(html, /KSIC-11 · 전체산업/); assert.match(html, /인구는 거주지 기반/); assert.match(html, /서로 더해 시장규모로 계산하지 않습니다/);
  const editor = editorHtml({ ...result, datasets: [{ id: "grid-2024", provider: "공개자료", sourceYear: 2024, gridSizeM: 1000, industryClassification: "숙박업" }] }, { datasetId: "grid-2024" });
  assert.match(editor, /숙박업/); assert.match(editor, /name="datasetId" required/);
});

test("typing during a point save keeps the later unsaved edit instead of silently resetting it", async () => {
  const waiting = deferred(), element = host();
  const control = controller({ fetchJson: async (url, options) => options ? waiting.promise : complete(9) });
  await control.mount(element, scope());
  const submitting = element.listeners.submit({ preventDefault() {}, target: { getAttribute: () => "configure", reportValidity: () => true } }); await tick();
  element.listeners.input({ target: { name: "label", value: "저장 중 새로 입력한 이름" } });
  waiting.resolve(complete(10)); await submitting;
  assert.equal(control.state.draft.label, "저장 중 새로 입력한 이름"); assert.equal(control.state.dirty, true);
  assert.match(control.state.actionMessage, /그 뒤 입력한 변경사항은 아직 저장하지 않았습니다/); control.stop();
});

test("legacy coordinate-only results stay readable but cannot be saved or recalculated without an address", async () => {
  const legacy = complete(24); delete legacy.configuration.center.address; delete legacy.snapshot.scope.center.address;
  const calls = [], element = host(), control = controller({ fetchJson: async (url, options) => { calls.push({ url, options }); return legacy; } });
  await control.mount(element, scope());
  const html = element.slots["[data-rc-results]"].innerHTML;
  assert.match(html, /data-rc-value="24"/); assert.match(html, /주소 확인 전/); assert.match(html, /새 계산을 할 수 없습니다/);
  assert.equal(control.state.draft.confirmed, false);
  element.listeners.click({ target: { closest: () => ({ getAttribute: () => "refresh" }) } });
  assert.match(control.state.actionMessage, /주소 확인 전/);
  await element.listeners.submit({ preventDefault() {}, target: { getAttribute: () => "configure", reportValidity: () => true } });
  assert.equal(calls.filter(call => call.options).length, 0); control.stop();
});

test("changing the address, coordinates or evidence requires a fresh same-location confirmation", async () => {
  const element = host(), calls = [], control = controller({ fetchJson: async (url, options) => { calls.push({ url, options }); return complete(10); } });
  await control.mount(element, scope()); assert.equal(control.state.draft.confirmed, true);
  for (const [name, value] of [["address", "경상남도 산청군 산청읍 산청대로 2"], ["latitude", "35.3"], ["longitude", "127.9"], ["sourceUrl", "https://example.org/another-point"]]) {
    element.listeners.input({ target: { name, value } }); assert.equal(control.state.draft.confirmed, false);
    await element.listeners.submit({ preventDefault() {}, target: { getAttribute: () => "configure", reportValidity: () => true } });
    assert.equal(calls.filter(call => call.options).length, 0);
    element.listeners.change({ target: { name: "confirmed", checked: true } });
  }
  control.stop();
});

test("address selection exposes confirmed company addresses read-only and explains missing or ambiguous ones", () => {
  const addresses = [
    { companyId: "c1", label: "확정 업체", address: '경상남도 산청군 <도로> "1"', status: "ready" },
    { companyId: "c2", label: "미등록 업체", address: "", status: "missing" },
    { companyId: "c3", label: "충돌 업체", address: "", status: "ambiguous" }
  ];
  const html = editorHtml(complete(), { companyId: "c1", address: addresses[0].address }, { addresses });
  assert.match(html, /직접 주소 입력 · 지역분석 기준주소/);
  assert.match(html, /value="c2" disabled/); assert.match(html, /value="c3" disabled/);
  assert.match(html, /name="address" required[^>]+ readonly/); assert.doesNotMatch(html, /<도로>/);
  assert.match(html, /주소를 자동으로 좌표로 변환하지 않습니다/); assert.match(html, /기준주소와 좌표가 같은 위치임을 출처에서 대조/);
});

test("company results use separate caches and reject a different company scope", async () => {
  const reader = createReader(), company = complete(31); company.scope.companyId = "c1"; company.snapshot.scope.companyId = "c1";
  const urls = []; await reader.get({ ...scope({ companyId: "c1" }), fetchJson: async url => { urls.push(url); return company; } });
  assert.deepEqual(urls, ["/api/regional-catchment?regionKey=sancheong&companyId=c1"]);
  assert.equal(reader.read(scope()), null); assert.equal(reader.read(scope({ companyId: "c2" })), null);
  await assert.rejects(reader.get({ ...scope({ companyId: "c2" }), fetchJson: async () => company }), /범위/);
  assert.equal(reader.read(scope({ companyId: "c1" })), company);
});

test("company save sends the registered address and scope, while synthetic address edits are ignored", async () => {
  const target = { companyId: "c1", label: "등록 업체", address: "경상남도 산청군 산청읍 산청대로 1", status: "ready" };
  const company = complete(30); company.scope.companyId = "c1"; company.snapshot.scope.companyId = "c1";
  const calls = [], element = host(), control = createController({ reader: createReader(), afterPaint: callback => callback(), fetchJson: async (url, options) => {
    calls.push({ url, options }); return url.includes("/addresses?") ? { addresses: [target] } : company;
  } });
  await control.mount(element, scope({ companyId: "c1" }));
  assert.equal(control.state.draft.address, target.address); assert.equal(control.state.draft.confirmed, true);
  const fake = { name: "address", value: "다른 주소" }; element.listeners.input({ target: fake });
  assert.equal(fake.value, target.address); assert.equal(control.state.draft.address, target.address);
  await element.listeners.submit({ preventDefault() {}, target: { getAttribute: () => "configure", reportValidity: () => true } });
  const post = calls.find(call => call.options?.method === "POST"), body = JSON.parse(post.options.body);
  assert.equal(body.companyId, "c1"); assert.equal(body.center.address, target.address); assert.equal(body.center.companyId, undefined);
  assert.ok(calls.some(call => call.url === "/api/regional-catchment/addresses?regionKey=sancheong")); control.stop();
});

test("selecting a company reads its own saved result and returning to direct input reads region scope", async () => {
  const target = { companyId: "c1", label: "등록 업체", address: "경상남도 산청군 산청읍 산청대로 1", status: "ready" }, urls = [], element = host();
  const control = controller({ addressTargets: [target], fetchJson: async url => {
    urls.push(url); const result = complete(url.includes("companyId=") ? 45 : 22);
    if (url.includes("companyId=")) { result.scope.companyId = "c1"; result.snapshot.scope.companyId = "c1"; }
    return result;
  } });
  await control.mount(element, scope());
  element.listeners.change({ target: { name: "companyId", value: "c1" } }); await tick();
  assert.equal(element.dataset.rcCompany, "c1"); assert.match(element.slots["[data-rc-results]"].innerHTML, /data-rc-value="45"/);
  await control.mount(element, scope()); assert.equal(element.dataset.rcCompany, "c1", "parent region rerenders preserve the selected company");
  element.listeners.change({ target: { name: "companyId", value: "" } }); await tick();
  assert.equal(element.dataset.rcCompany, ""); assert.match(element.slots["[data-rc-results]"].innerHTML, /data-rc-value="22"/);
  assert.deepEqual(urls, ["/api/regional-catchment?regionKey=sancheong", "/api/regional-catchment?regionKey=sancheong&companyId=c1", "/api/regional-catchment?regionKey=sancheong"]); control.stop();
});

test("a delayed company address read preserves coordinate edits and populates only the read-only address", async () => {
  const waiting = deferred(), company = complete(10); company.scope.companyId = "c1"; company.snapshot.scope.companyId = "c1";
  const element = host(), control = createController({ reader: createReader(), afterPaint: callback => callback(), fetchJson: async url => url.includes("/addresses?") ? waiting.promise : company });
  const mounting = control.mount(element, scope({ companyId: "c1" })); await tick();
  element.listeners.input({ target: { name: "latitude", value: "35.9" } });
  waiting.resolve({ addresses: [{ companyId: "c1", label: "등록 업체", address: company.configuration.center.address, status: "ready" }] }); await mounting;
  assert.equal(control.state.draft.latitude, "35.9"); assert.equal(control.state.draft.address, company.configuration.center.address);
  assert.equal(control.state.draft.confirmed, false); assert.equal(control.state.dirty, true); control.stop();
});

test("changed or unavailable registered company addresses cannot reuse an old confirmation", async () => {
  for (const target of [{ companyId: "c1", label: "변경 업체", address: "경상남도 산청군 산청읍 산청대로 2", status: "ready" }, { companyId: "c1", label: "미확정 업체", address: "", status: "ambiguous" }]) {
    const company = complete(10); company.scope.companyId = "c1"; company.snapshot.scope.companyId = "c1";
    const calls = [], element = host(), control = controller({ addressTargets: [target], fetchJson: async (url, options) => { calls.push({ url, options }); return company; } });
    await control.mount(element, scope({ companyId: "c1" })); assert.equal(control.state.draft.confirmed, false);
    element.listeners.click({ target: { closest: () => ({ getAttribute: () => "refresh" }) } });
    await element.listeners.submit({ preventDefault() {}, target: { getAttribute: () => "configure", reportValidity: () => true } });
    assert.equal(calls.filter(call => call.options).length, 0); control.stop();
  }
});

function market(extra = {}) {
  const proof = { version: "stored-kosis-spatial-evidence-v1", sourceKind: "stored_raw_response", evidenceId: "saved-proof", sha256: "a".repeat(64), period: "2026-09", periodType: "M", verifiedAt: "2026-10-22T01:00:00Z" };
  return { mode: "administrative_region", originKind: "administrative_region", status: "partial",
    scope: { regionKey: "sancheong", label: "경상남도 산청군", officialCode: "48860", level: "sigungu", month: "2026-09", months: 13, boundaryYear: null, boundaryYearStatus: "unrecorded" },
    metrics: [
      { key: "population", label: "총인구", unit: "명", periodType: "M", period: "2026-09", status: "observed", value: 0, reasonCode: null, source: { provider: "KOSIS", tableId: "TABLE_1", sourceUrl: "https://kosis.kr/statHtml/statHtml.do", providerRegionCode: "48860", storedProvenance: proof, retrievedAt: "2026-10-22T01:01:00Z", boundaryYear: null, boundaryYearStatus: "unrecorded" } },
      { key: "registeredHouseholds", label: "주민등록 세대 수 (가구 수와 다름)", unit: "세대", periodType: "M", period: null, status: "missing", value: null, reasonCode: "REGIONAL_MARKET_NOT_ACQUIRED", source: { provider: "KOSIS", tableId: "TABLE_2" } },
      { key: "establishments", label: "사업체 수", unit: "개", periodType: "Y", period: "2024", status: "observed", value: 15, reasonCode: null, source: { provider: "KOSIS", sourceUrl: "https://kosis.kr", providerRegionCode: "48860", storedProvenance: { ...proof, period: "2024", periodType: "Y" }, boundaryYear: 2023, boundaryYearStatus: "recorded" } }
    ], visitorOrigins: { status: "not_acquired", value: null, reasonCode: "VISITOR_ORIGINS_NOT_AVAILABLE" },
    source: { kind: "saved_regional_analysis", resultId: "saved-market", resultSha256: "b".repeat(64), generatedAt: "2026-10-22T01:02:00Z", calculatedAt: "2026-10-22T01:02:00Z" },
    retrievedAt: "2026-10-22T01:01:00Z", networkAttempted: false, readOnly: true, warnings: ["BOUNDARY_YEAR_UNRECORDED"], ...extra };
}
function workspaceHost() {
  const element = host(), administrative = host(), address = host();
  administrative.slots["[data-rm-results]"] = { innerHTML: "", querySelectorAll: () => [] };
  element.slots['[data-rc-mode-panel="administrative_region"]'] = administrative;
  element.slots['[data-rc-mode-panel="address_radius"]'] = address;
  return { element, administrative, address };
}
function workspace(options = {}) {
  return createScopedController({ reader: createReader(), marketReader: createMarketReader(), afterPaint: callback => callback(), ...options });
}

test("default administrative mode needs only a region and makes no address, configure, import or refresh request", async () => {
  const calls = [], { element, administrative, address } = workspaceHost();
  const control = workspace({ fetchJson: async (url, options) => { calls.push({ url, options }); return market(); } });
  await control.mount(element, scope());
  assert.equal(control.mode, "administrative_region"); assert.equal(element.dataset.rcMode, "administrative_region");
  assert.deepEqual(calls, [{ url: "/api/regional-market?regionKey=sancheong", options: undefined }]);
  assert.equal(address.innerHTML, ""); assert.equal(address.hidden, true); assert.equal(administrative.hidden, false);
  assert.match(administrative.slots["[data-rm-results]"].innerHTML, /시·군·구 전체|확보범위 2\/3개 지표/);
  assert.doesNotMatch(administrative.innerHTML, /name="address"|name="latitude"|name="datasetFile"|data-rc-action="refresh"/);
  await control.mount(element, scope()); assert.equal(calls.length, 1); control.stop();
});

test("explicit address mode preserves its protected draft and saved values across mode switches", async () => {
  const calls = [], { element, administrative, address } = workspaceHost();
  const control = workspace({ fetchJson: async (url, options) => {
    calls.push({ url, options }); return url.startsWith("/api/regional-market?") ? market() : url.includes("/addresses?") ? { addresses: [] } : complete(17);
  } });
  await control.mount(element, scope()); await control.selectMode("address_radius");
  assert.equal(control.mode, "address_radius"); assert.equal(address.hidden, false); assert.equal(administrative.hidden, true);
  assert.ok(calls.some(call => call.url === "/api/regional-catchment?regionKey=sancheong"));
  assert.ok(calls.some(call => call.url.startsWith("/api/regional-catchment/addresses?")));
  address.listeners.input({ target: { name: "label", value: "입력 중인 상세주소 기준점" } });
  address.listeners.input({ target: { name: "latitude", value: "35.123" } });
  const editor = address.slots["[data-rc-editor-slot]"].innerHTML, callsBefore = calls.filter(call => call.url.startsWith("/api/regional-catchment")).length;
  await control.selectMode("administrative_region"); await control.mount(element, scope());
  assert.equal(calls.filter(call => call.url.startsWith("/api/regional-catchment")).length, callsBefore);
  await control.selectMode("address_radius");
  assert.equal(control.state.draft.label, "입력 중인 상세주소 기준점"); assert.equal(control.state.draft.latitude, "35.123");
  assert.equal(control.state.draft.confirmed, false); assert.equal(control.state.dirty, true);
  assert.equal(address.slots["[data-rc-editor-slot]"].innerHTML, editor);
  assert.match(address.slots["[data-rc-results]"].innerHTML, /data-rc-value="17"/);
  assert.equal(calls.filter(call => call.options?.method === "POST").length, 0); control.stop();
});

test("administrative presentation keeps real zero, missingness, sources, periods and unavailable visitor origins distinct", () => {
  const html = marketResultHtml(market());
  assert.match(html, /data-rm-metric="population" data-rm-status="observed" data-rm-value="0"/);
  assert.match(html, /data-rm-metric="registeredHouseholds" data-rm-status="missing" data-rm-value=""/);
  assert.match(html, /가구 수와 다릅니다|가구 수와 다름/); assert.match(html, /기준기간 미확인/);
  assert.match(html, /2024년 · 연간/); assert.match(html, /2026-09 · 월간/); assert.match(html, /경계연도 미기록/);
  assert.match(html, /KOSIS/); assert.match(html, /TABLE_1/); assert.match(html, /저장 원본 근거/); assert.match(html, /saved-proof/);
  assert.match(html, /지역·기간|공표기간/); assert.match(html, /거주인구를 고객 수로 해석하지 않으며/);
  assert.match(html, /방문객 출발지·외부 유입 · 자료 미확보/); assert.match(html, /관광 지표는 이 기본 분석에 포함되지 않습니다/);
  assert.doesNotMatch(html, /name="address"|rc-ring|반경 전체값|data-rm-visitor-origins="0"/);
  assert.equal(marketViewModel(null, { loading: true }).status, "loading");
  assert.doesNotMatch(marketResultHtml(null, { loading: true }), /data-rm-value="0"|확보범위 0/);
});

test("administrative missing cards explain the reason without exposing internal codes and retain source evidence", () => {
  const input = market(); input.metrics[1].errorCode = "INTERNAL_PROVIDER_READ_ERROR";
  Object.assign(input.metrics[2], { status: "unverified", value: null, reasonCode: "PRIVATE_UNKNOWN_REASON", errorCode: "INTERNAL_EVIDENCE_ERROR" });
  const html = marketResultHtml(input);
  assert.match(html, /저장된 자료가 없습니다\./); assert.match(html, /저장 근거를 확인해야 합니다\./);
  assert.doesNotMatch(html, /REGIONAL_MARKET_NOT_ACQUIRED|PRIVATE_UNKNOWN_REASON|INTERNAL_PROVIDER_READ_ERROR|INTERNAL_EVIDENCE_ERROR/);
  assert.match(html, /data-rc-detail="market:population"/); assert.match(html, /기준기간·원본 근거/);
  assert.match(html, /saved-proof/); assert.match(html, /TABLE_1/); assert.match(html, /data-rm-value="0"/);
});

test("unverified, partial, suppressed, pending and error metrics never render a number even if malformed input contains one", () => {
  for (const status of ["unverified", "partial", "suppressed", "publication_pending", "error", "missing"]) {
    const input = market(); Object.assign(input.metrics[0], { status, value: 987654, reasonCode: "REGIONAL_MARKET_EVIDENCE_UNVERIFIED" });
    const html = marketResultHtml(input); assert.doesNotMatch(html, /987,654|data-rm-value="987654"/); assert.match(html, /data-rm-value=""/);
    assert.throws(() => checkedMarketResult(input, scope()), /수치 상태/);
  }
});

test("administrative DTO rejects foreign geography or frequency, unsafe result status and any network or mutation claim", () => {
  const inputs = [market({ mode: "address_radius" }), market({ originKind: "address_radius" }), market({ networkAttempted: true }), market({ readOnly: false }), market({ status: "ready_fake" }), market({ visitorOrigins: { status: "observed", value: 0 } })];
  const wrongRegion = market(); wrongRegion.scope.regionKey = "jinju"; inputs.push(wrongRegion);
  const wrongLevel = market(); wrongLevel.scope.level = "sido"; inputs.push(wrongLevel);
  for (const input of inputs) assert.throws(() => checkedMarketResult(input, scope()));
  assert.throws(() => checkedMarketResult(market(), scope({ month: "2026-08" })), /범위/);
  assert.throws(() => checkedMarketResult(market(), scope({ months: 24 })), /범위/);
  const badProof = market(); badProof.metrics[0].source.storedProvenance.period = "2026-08";
  assert.throws(() => checkedMarketResult(badProof, scope()), /원본 근거/);
  const future = market(); future.metrics[0].period = "2026-10"; future.metrics[0].source.storedProvenance.period = "2026-10";
  assert.throws(() => checkedMarketResult(future, scope()), /원본 근거/);
  assert.equal(checkedMarketResult(market(), scope()).mode, "administrative_region");
});

test("weekly command remains explicit and status reads never start a provider job", async () => {
  const { administrative } = workspaceHost(), calls = [];
  administrative.slots["[data-rm-missing-receipt]"] = { textContent: "" };
  const control = createRegionController({ marketReader: createMarketReader(), afterPaint: fn => fn(), fetchJson: async (url, options) => {
    calls.push({ url, options }); return url.includes("missing-check") ? { job: null } : market();
  } });
  await control.mount(administrative, scope());
  assert.equal(calls.length, 1); assert.ok(calls[0].url.startsWith("/api/regional-market?"));
  const click = kind => administrative.onclick({ target: { closest: selector => selector === "[data-rm-missing]" ? { getAttribute: () => kind } : null } });
  click("status"); await tick(); assert.equal(calls[1].url, "/api/regional-market/missing-check"); assert.equal(calls[1].options, undefined);
  assert.match(administrative.slots["[data-rm-missing-receipt]"].textContent, /아직 주간 확인 이력이 없습니다/);
  click("collect"); await tick(); assert.equal(calls[2].options.method, "POST"); assert.equal(calls[2].options.body, "{}");
  control.stop();
});

test("administrative reader isolates account, region and requested period while deduplicating active reads", async () => {
  const reader = createMarketReader(), waiting = deferred(), urls = [];
  const input = { ...scope({ month: "2026-09", months: 13, companyId: "ignored" }), fetchJson: async url => { urls.push(url); return waiting.promise; } };
  const first = reader.get(input), second = reader.get(input); waiting.resolve(market()); assert.equal(await first, await second);
  assert.deepEqual(urls, ["/api/regional-market?regionKey=sancheong&month=2026-09&months=13"]);
  assert.equal(reader.read(scope({ accountKey: "other", month: "2026-09", months: 13 })), null);
  assert.equal(reader.read(scope({ month: "2026-08", months: 13 })), null);
  assert.equal(reader.read(scope({ regionKey: "jinju", month: "2026-09", months: 13 })), null);
  reader.clear("admin-a"); assert.equal(reader.read(input), null);
});

test("a failed administrative recheck keeps the prior values and never falls back to an address endpoint", async () => {
  const { element, administrative } = workspaceHost(), calls = []; let fail = false;
  const control = workspace({ fetchJson: async url => { calls.push(url); if (fail) throw Error("임시 조회 오류"); return market(); } });
  await control.mount(element, scope()); fail = true; await control.refreshStatus();
  assert.equal(control.state.result.source.resultId, "saved-market");
  const html = administrative.slots["[data-rm-results]"].innerHTML; assert.match(html, /마지막 확인 결과를 유지/); assert.match(html, /data-rm-value="15"/);
  assert.equal(calls.length, 2); assert.ok(calls.every(url => url.startsWith("/api/regional-market?"))); control.stop();
});

test("late administrative responses cannot replace the selected region or a stopped account view", async () => {
  const waiting = deferred(), { element, administrative } = workspaceHost();
  const control = workspace({ fetchJson: async url => {
    if (url.includes("regionKey=sancheong")) return waiting.promise;
    const result = market(); result.scope = { ...result.scope, regionKey: "jinju", label: "진주시", officialCode: "48170" }; return result;
  } });
  const pending = control.mount(element, scope()); await tick();
  await control.mount(element, scope({ regionKey: "jinju", regionLabel: "진주시" }));
  waiting.resolve(market()); await pending;
  assert.equal(control.state.result.scope.regionKey, "jinju"); assert.equal(element.dataset.rcRegion, "jinju");
  assert.match(administrative.slots["[data-rm-results]"].innerHTML, /진주시/); assert.doesNotMatch(administrative.slots["[data-rm-results]"].innerHTML, /경상남도 산청군/);
  control.stop(); assert.equal(element.dataset.rcDisplayStatus, "paused");
});

test("administrative metric text, evidence and links are escaped", () => {
  const result = market(); result.scope.label = '<img src=x onerror="alert(1)">';
  Object.assign(result.metrics[0], { label: "<script>bad()</script>", unit: '명" onclick="bad' });
  result.metrics[0].source.sourceUrl = "javascript:alert(1)"; result.metrics[0].source.storedProvenance.evidenceId = "<svg/onload=bad>";
  const html = marketResultHtml(result); assert.doesNotMatch(html, /<img|<script>|<svg|href="javascript:/);
  assert.match(html, /&lt;script&gt;/); assert.match(html, /&lt;svg/);
});
