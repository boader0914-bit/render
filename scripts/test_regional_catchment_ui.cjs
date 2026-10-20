"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { viewModel, resultHtml, editorHtml, createReader, createController, MAX_IMPORT_BYTES } = require("../web/regional-catchment.js");
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const scope = extra => ({ accountKey: "admin-a", regionKey: "sancheong", regionLabel: "산청군", ...extra });
function payload(extra = {}) {
  return { scope: { regionKey: "sancheong", label: "산청군" }, status: "missing", configuration: null, datasets: [], snapshot: null, job: null, storage: {}, sourceCatalog: [], ...extra };
}
function complete(value = 0) {
  return payload({ status: "ready", configuration: { center: { latitude: 35.41, longitude: 127.87, label: "확인한 기준점", sourceUrl: "https://example.org/point", confirmed: true }, datasetId: "grid-2024" },
    snapshot: { resultId: "saved-1", calculatedAt: "2026-10-21T01:00:00Z", scope: { regionKey: "sancheong", label: "산청군", center: { label: "확인한 기준점", latitude: 35.41, longitude: 127.87 } },
      dataset: { id: "grid-2024", sourceYear: "2024", boundaryYear: "2023", gridSizeM: 1000, provider: "공개 제공처", sourceUrl: "https://example.org/data" },
      rings: ["inner50", "outer50to100", "total100"].map(key => ({ key, coverage: { status: "complete", completeFrame: true, bboxContainsCircle: true, declaredByAdmin: true, selectedCells: 10 },
        metrics: Object.fromEntries(["population", "establishments", "workers"].map(metric => [metric, { status: "observed_public", value, publishedSum: value, knownCells: 10, missingCells: 0, suppressedCells: 0, protectedZeroCells: 0, unit: metric === "establishments" ? "개" : "명" }])) })) } });
}
function host() {
  const slots = { "[data-rc-results]": { innerHTML: "" }, "[data-rc-editor-slot]": { innerHTML: "", querySelectorAll: () => [] }, "[data-rc-message]": { textContent: "" } };
  return { dataset: {}, innerHTML: "", isConnected: true, listeners: {}, slots,
    querySelector: selector => slots[selector] || null, querySelectorAll: () => [], addEventListener(name, listener) { this.listeners[name] = listener; } };
}
function controller(options = {}) { return createController({ reader: createReader(), afterPaint: callback => callback(), ...options }); }

test("unqueried/loading never invent values, zero coverage or a confirmed absence", () => {
  const before = viewModel(null), loading = viewModel(null, { loading: true });
  assert.equal(before.status, "unqueried"); assert.equal(loading.status, "loading");
  for (const model of [before, loading]) for (const card of model.cards) { assert.equal(card.coverage, null); assert.ok(card.metrics.every(metric => metric.value === null && metric.publishedSum === null)); }
  assert.match(resultHtml(null), /미조회/); assert.match(resultHtml(null, { loading: true }), /저장자료 확인 중/);
  assert.doesNotMatch(resultHtml(null, { loading: true }), /data-rc-value="0"|공간자료 미확보/);
  assert.equal(viewModel(payload()).status, "missing"); assert.match(resultHtml(payload()), /중심점 미설정/);
  const configured = payload({ configuration: { center: { confirmed: true }, datasetId: "" } });
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
  assert.equal(textReads, 0); assert.match(control.state.actionMessage, /8MiB/);
  await submit({ size: 20, text: async () => "not-json" }); assert.match(control.state.actionMessage, /JSON/);
  await submit({ size: 4, text: async () => "null" }); assert.match(control.state.actionMessage, /JSON 객체/);
  assert.equal(calls.filter(item => item.options?.method === "POST").length, 0); control.stop();
});

test("unsaved or unconfirmed centers cannot trigger calculation and configure is explicit", async () => {
  const calls = [], element = host(), control = controller({ fetchJson: async (url, options) => { calls.push({ url, options }); return options ? complete(10) : payload(); } });
  await control.mount(element, scope());
  const click = () => element.listeners.click({ target: { closest: () => ({ getAttribute: () => "refresh" }) } });
  click(); assert.match(control.state.actionMessage, /중심점/); assert.equal(calls.length, 1);
  for (const [name, value] of Object.entries({ label: "실제 확인 기준점", latitude: "35.4", longitude: "127.8", sourceUrl: "https://example.org/point", datasetId: "grid-2024" })) element.listeners.input({ target: { name, value } });
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
  for (const [name, value] of Object.entries({ label: "직접 확인한 지점", latitude: "35.4", longitude: "127.8", sourceUrl: "https://example.org/point", datasetId: "grid-2024" })) element.listeners.input({ target: { name, value } });
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
