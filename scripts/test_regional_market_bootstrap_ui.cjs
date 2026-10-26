"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { createRegionController, createController } = require("../web/regional-catchment.js");
const ENDPOINT = "/api/regional-market/bootstrap-policy", tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const scope = extra => ({ accountKey: "admin-a", regionKey: "sancheong", regionLabel: "산청군", ...extra });
const policy = extra => ({ schemaVersion: 1, configured: true, enabled: true, phase: "active", schedule: { timezone: "Asia/Seoul", hour: 12, minute: 10, tickMs: 30000 },
  baseline: { sourceJobId: "12345678-1234-4234-8234-123456789abc", sourceSha256: "a".repeat(64), totalRegionCount: 95, pendingRegionCount: 86, initialHeldDatasetCount: 4 },
  progress: { initialRegionCount: 86, availableRegions: 0, pendingRegions: 86, needsVerificationRegions: 0, initialHeldDatasetCount: 4, initialHeldAvailableDatasets: 0, initialHeldOutstandingDatasets: 4, initialHeldProjectionVerified: false },
  job: null, nextDueAt: "2026-10-27T03:10:00.000Z", reasonCode: null, ...extra });
const unconfigured = () => policy({ configured: false, enabled: false, phase: "unconfigured", baseline: null, progress: null, job: null, nextDueAt: null });
const job = extra => ({ schemaVersion: 1, id: "87654321-4321-4321-8321-abcdef123456", day: "2026-10-27", status: "partial", claimedAt: "2026-10-27T03:10:00.000Z", startedAt: "2026-10-27T03:10:00.100Z", finishedAt: "2026-10-27T03:12:00.000Z", currentRegionKey: "sancheong", stopReason: "BOOTSTRAP_LOCAL_BUDGET_EXHAUSTED",
  counts: { checkedRegions: 17, networkAttemptedRegions: 17, unknownAttemptRegions: 0, collectedDatasets: 100, projectedRegions: 16 }, ...extra });
function element() {
  const slots = { "[data-rm-results]": { innerHTML: "", querySelectorAll: () => [] }, "[data-rm-weekly-receipt]": { textContent: "" }, "[data-rm-missing-receipt]": { textContent: "" }, "[data-rm-bootstrap-receipt]": { textContent: "" }, '[data-rm-action="status"]': { disabled: false } };
  const control = value => ({ disabled: false, getAttribute: () => value });
  const weekly = [control("status"), control("enable")], missing = [control("status"), control("collect")], bootstrap = [control("status"), control("enable")];
  return { innerHTML: "", dataset: {}, isConnected: true, slots, weekly, missing, bootstrap, addEventListener() {}, querySelector: selector => slots[selector] || null,
    querySelectorAll: selector => selector === "[data-rm-weekly]" ? weekly : selector === "[data-rm-missing]" ? missing : selector === "[data-rm-bootstrap]" ? bootstrap : [] };
}
function client(fetchJson) {
  return createRegionController({ fetchJson, afterPaint: fn => fn(), marketReader: { read: () => null, get: async input => { await input.fetchJson(`/api/regional-market?regionKey=${input.regionKey}`); return null; } } });
}
const click = (host, group, value) => host.onclick({ target: { closest: selector => selector === `[data-rm-${group}]` ? { getAttribute: () => value } : null } });
const receipt = host => host.slots["[data-rm-bootstrap-receipt]"].textContent;

test("bootstrap controls remain collapsed and unqueried on mount with no extra GET or collection", async () => {
  const calls = [], host = element(), controller = client(async (url, options) => { calls.push({ url, options }); return null; });
  await controller.mount(host, scope()); assert.deepEqual(calls, [{ url: "/api/regional-market?regionKey=sancheong", options: undefined }]);
  assert.match(host.innerHTML, /<details class="rc-sources">/); assert.doesNotMatch(host.innerHTML, /<details[^>]*\sopen(?:\s|>)/); assert.match(receipt(host), /아직 조회하지 않았습니다/);
  assert.match(host.innerHTML, /초기 86개 지역/); assert.match(host.innerHTML, /별도 보류 4개 표/); assert.match(host.innerHTML, /다음 날부터 매일 12:10/); assert.match(host.innerHTML, /100회\/일이며 지역 수와 다릅니다/); assert.match(host.innerHTML, /완료.*기존 주 1회|끝나면 기존 주 1회/); controller.stop();
});

test("explicit bootstrap status is one GET and enable sends only enabled true with no immediate collection", async () => {
  const calls = [], host = element(), controller = client(async (url, options) => { calls.push({ url, options }); return url === ENDPOINT ? options ? policy() : unconfigured() : null; });
  await controller.mount(host, scope()); click(host, "bootstrap", "status"); await tick();
  assert.deepEqual(calls[1], { url: ENDPOINT, options: undefined }); assert.match(receipt(host), /아직 설정되지 않았습니다/); assert.match(receipt(host), /다음 날 12:10/);
  click(host, "bootstrap", "enable"); await tick();
  assert.deepEqual(calls[2], { url: ENDPOINT, options: { method: "POST", headers: { "Content-Type": "application/json" }, body: '{"enabled":true}' } });
  assert.match(receipt(host), /초기 일일 보완 켜짐/); assert.match(receipt(host), /매일 12:10 \(한국시간\)/); assert.match(receipt(host), /2026-10-27 12:10 KST/);
  assert.match(receipt(host), /초기 대상 86개 지역: 확보 0개 · 대기 86개/); assert.match(receipt(host), /별도 보류 4개 표: 확보 0개 · 미확보 4개/);
  assert.equal(host.bootstrap[1].disabled, true); click(host, "bootstrap", "enable"); click(host, "missing", "collect"); await tick(); assert.equal(calls.length, 3); controller.stop();
});

test("active, paused and verification bootstrap phases block manual collection while allowing status reads", async () => {
  for (const response of [policy(), policy({ enabled: false, nextDueAt: null }), policy({ enabled: false, phase: "needs_verification", nextDueAt: null, reasonCode: "BOOTSTRAP_INTERRUPTED_JOB" })]) {
    const calls = [], host = element(), controller = client(async (url, options) => { calls.push({ url, options }); return url === ENDPOINT ? response : url.endsWith("missing-check") ? { job: null } : null; });
    await controller.mount(host, scope()); click(host, "bootstrap", "status"); await tick(); assert.equal(host.missing[1].disabled, true); assert.equal(host.missing[0].disabled, false);
    click(host, "missing", "collect"); await tick(); assert.equal(calls.length, 2); click(host, "missing", "status"); await tick(); assert.equal(calls[2].url, "/api/regional-market/missing-check"); assert.equal(calls[2].options, undefined);
    assert.equal(controller.state.bootstrapResult.phase, response.phase); controller.stop();
  }
});

test("completed bootstrap separately verifies all 86 regions and four held tables before enabling ordinary collection", async () => {
  const completed = policy({ enabled: false, phase: "complete", nextDueAt: null, progress: { ...policy().progress, availableRegions: 86, pendingRegions: 0, initialHeldAvailableDatasets: 4, initialHeldOutstandingDatasets: 0, initialHeldProjectionVerified: true }, job: job({ status: "complete", stopReason: null }) });
  const calls = [], host = element(), controller = client(async (url, options) => { calls.push({ url, options }); return url === ENDPOINT ? completed : null; });
  await controller.mount(host, scope()); click(host, "bootstrap", "status"); await tick();
  assert.match(receipt(host), /초기 보완 완료 · 기존 주 1회 확인 유지/); assert.match(receipt(host), /86개 지역: 확보 86개 · 대기 0개/); assert.match(receipt(host), /4개 표: 확보 4개 · 미확보 0개 · 저장 반영 확인/);
  assert.equal(host.bootstrap[1].disabled, true); assert.equal(host.missing[1].disabled, false); click(host, "missing", "collect"); await tick(); assert.equal(calls[2].options.method, "POST"); controller.stop();
});

test("partial job counts show request-attempt regions separately from collected tables and unknown attempts", async () => {
  const host = element(), response = policy({ job: job({ counts: { ...job().counts, unknownAttemptRegions: 1 } }), progress: { ...policy().progress, availableRegions: 16, pendingRegions: 70 } });
  const controller = client(async url => url === ENDPOINT ? response : null); await controller.mount(host, scope()); click(host, "bootstrap", "status"); await tick();
  assert.match(receipt(host), /오늘 한도 내 일부 보완/); assert.match(receipt(host), /이번 확인 17개 지역 · 외부 요청 시도 17개 지역 · 통계 확보 100개 표/); assert.match(receipt(host), /실행 여부 미확인 1개 지역/); controller.stop();
});

test("bootstrap commands share busy guards with weekly commands, manual reads and market refresh", async () => {
  const wait = deferred(), calls = [], host = element(), controller = client(async (url, options) => { calls.push({ url, options }); return url === ENDPOINT ? wait.promise : null; });
  await controller.mount(host, scope()); click(host, "bootstrap", "enable"); click(host, "bootstrap", "enable"); click(host, "weekly", "enable"); click(host, "missing", "collect"); click(host, "missing", "status"); await controller.refreshStatus();
  assert.equal(calls.length, 2); assert.equal(controller.state.bootstrapBusy, true); assert.ok([...host.bootstrap, ...host.weekly, ...host.missing].every(control => control.disabled)); assert.equal(host.slots['[data-rm-action="status"]'].disabled, true);
  wait.resolve(policy()); await tick(); assert.equal(controller.state.bootstrapBusy, false); assert.equal(calls.filter(value => value.options?.method === "POST").length, 1); controller.stop();
});

test("pending weekly or manual commands also prevent bootstrap policy requests", async () => {
  for (const group of ["weekly", "missing"]) {
    const wait = deferred(), calls = [], host = element(), controller = client(async (url, options) => { calls.push({ url, options }); return url.includes(group === "weekly" ? "missing-weekly-policy" : "missing-check") ? wait.promise : null; });
    await controller.mount(host, scope()); click(host, group, group === "weekly" ? "enable" : "status"); click(host, "bootstrap", "enable"); assert.equal(calls.length, 2); assert.ok(host.bootstrap.every(control => control.disabled));
    wait.resolve(group === "weekly" ? { schemaVersion: 1, enabled: true, status: "held", reasonCode: "BOOTSTRAP_IN_PROGRESS", schedule: { timezone: "Asia/Seoul", weekday: 1, hour: 12, minute: 0, intervalHours: 168 }, nextDueAt: null, nextEligibleAt: null } : { job: null }); await tick();
    assert.equal(controller.state.bootstrapBusy, false); if (group === "weekly") assert.match(host.slots["[data-rm-weekly-receipt]"].textContent, /초기 일일 보완이 끝날 때까지 주간 수집을 보류/); controller.stop();
  }
});

test("late bootstrap receipts cannot change another account, region or a stopped/hidden view", async () => {
  for (const change of [{ accountKey: "admin-b" }, { regionKey: "jinju", regionLabel: "진주시" }, "stopped", "hidden"]) {
    const wait = deferred(), calls = [], host = element(); let visible = true;
    const controller = client(async (url, options) => { calls.push({ url, options }); return url === ENDPOINT ? wait.promise : null; });
    await controller.mount(host, scope({ isVisible: () => visible })); click(host, "bootstrap", "enable");
    if (typeof change === "object") await controller.mount(host, scope(change)); else { if (change === "hidden") visible = false; controller.stop(); }
    wait.resolve(policy()); await tick(); assert.equal(controller.state.bootstrapResult, null); assert.equal(controller.state.bootstrapBusy, false); assert.equal(controller.state.bootstrapUnverified, false);
    if (typeof change === "object") assert.match(receipt(host), /아직 조회하지 않았습니다/);
    assert.equal(calls.filter(value => value.url === ENDPOINT).length, 1); controller.stop();
  }
});

test("invalid or unknown bootstrap receipts preserve the last result, expose no false zero and block new commands until a valid read", async () => {
  const host = element(); let response = policy(), fail = false;
  const calls = [], controller = client(async (url, options) => { calls.push({ url, options }); if (url === ENDPOINT) { if (fail) throw new Error("private provider credential"); return response; } return null; });
  await controller.mount(host, scope()); click(host, "bootstrap", "status"); await tick(); const original = controller.state.bootstrapResult;
  const invalid = [null, {}, policy({ enabled: "true" }), policy({ phase: "unknown" }), policy({ phase: "complete" }), policy({ schedule: { ...policy().schedule, minute: 0 } }), policy({ nextDueAt: "unknown" }), policy({ nextDueAt: "2026-10-27T03:00:00.000Z" }), policy({ progress: { ...policy().progress, pendingRegions: 0 } }), policy({ progress: { ...policy().progress, initialHeldOutstandingDatasets: 0 } }), policy({ job: job({ status: "unknown" }) }), policy({ job: job({ counts: { ...job().counts, unknownAttemptRegions: -1 } }) }), policy({ job: job({ counts: { ...job().counts, networkAttemptedRegions: 18 } }) }), policy({ job: job({ counts: { ...job().counts, checkedRegions: undefined } }) })];
  for (const value of invalid) {
    response = value; click(host, "bootstrap", "status"); await tick(); assert.equal(controller.state.bootstrapResult, original); assert.equal(controller.state.bootstrapUnverified, true); assert.equal(host.bootstrap[1].disabled, true); assert.equal(host.missing[1].disabled, true); assert.equal(host.bootstrap[0].disabled, false);
    assert.match(receipt(host), /응답을 검증하지 못했습니다/); assert.doesNotMatch(receipt(host), /확보 0개|완료|private/); const before = calls.length; click(host, "bootstrap", "enable"); click(host, "missing", "collect"); await tick(); assert.equal(calls.length, before);
  }
  fail = true; click(host, "bootstrap", "status"); await tick(); assert.doesNotMatch(receipt(host), /private|credential/); assert.equal(controller.state.bootstrapResult, original);
  fail = false; response = unconfigured(); click(host, "bootstrap", "status"); await tick(); assert.equal(controller.state.bootstrapUnverified, false); assert.equal(host.bootstrap[1].disabled, false); assert.equal(host.missing[1].disabled, false); controller.stop();
});

test("address precision controller remains available without bootstrap policy reads", async () => {
  const calls = [], host = element(), controller = createController({ mode: "address_radius", fetchJson: async (url, options) => { calls.push({ url, options }); throw new Error("fixture has no saved address result"); }, afterPaint: fn => fn() });
  await controller.mount(host, scope()); assert.match(host.innerHTML, /주소 기준 반경 분석/); assert.equal(calls.some(value => value.url.includes("bootstrap-policy")), false); controller.stop();
});

test("an orphan journal before configuration is a verification hold rather than an unconfigured permission to collect", async () => {
  const calls = [], host = element(), response = { ...unconfigured(), phase: "needs_verification", reasonCode: "BOOTSTRAP_ORPHAN_CLAIM" };
  const controller = client(async (url, options) => { calls.push({ url, options }); return url === ENDPOINT ? response : null; });
  await controller.mount(host, scope()); click(host, "bootstrap", "status"); await tick();
  assert.equal(controller.state.bootstrapResult, response); assert.equal(controller.state.bootstrapUnverified, false); assert.match(receipt(host), /실행 기록 또는 보호 상태를 관리자 검수/); assert.doesNotMatch(receipt(host), /아직 설정되지|확보 0개|완료|BOOTSTRAP_ORPHAN/);
  assert.equal(host.bootstrap[1].disabled, true); assert.equal(host.missing[1].disabled, true); assert.equal(host.bootstrap[0].disabled, false); assert.equal(host.missing[0].disabled, false);
  click(host, "bootstrap", "enable"); click(host, "missing", "collect"); await tick(); assert.equal(calls.length, 2); controller.stop();
});
