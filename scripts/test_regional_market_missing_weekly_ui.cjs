"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { createRegionController } = require("../web/regional-catchment.js");
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const scope = extra => ({ accountKey: "admin-a", regionKey: "sancheong", regionLabel: "산청군", ...extra });
const policy = extra => ({ schemaVersion: 1, enabled: true, status: "waiting", schedule: { timezone: "Asia/Seoul", weekday: 1, hour: 12, minute: 0, intervalHours: 168, tickMs: 30000 }, nextDueAt: "2026-11-02T03:00:00.000Z", nextEligibleAt: "2026-11-02T03:00:00.000Z", ...extra });
function element() {
  const slots = { "[data-rm-results]": { innerHTML: "", querySelectorAll: () => [] }, "[data-rm-weekly-receipt]": { textContent: "" }, "[data-rm-missing-receipt]": { textContent: "" }, '[data-rm-action="status"]': { disabled: false } };
  const control = value => ({ disabled: false, getAttribute: () => value });
  const weekly = [control("status"), control("enable")], missing = [control("status"), control("collect")];
  return { innerHTML: "", dataset: {}, isConnected: true, slots, weekly, missing, querySelector: selector => slots[selector] || null,
    querySelectorAll: selector => selector === "[data-rm-weekly]" ? weekly : selector === "[data-rm-missing]" ? missing : [] };
}
function client(fetchJson) {
  return createRegionController({ fetchJson, afterPaint: fn => fn(), marketReader: { read: () => null, get: async input => { await input.fetchJson(`/api/regional-market?regionKey=${input.regionKey}`); return null; } } });
}
const click = (host, group, value) => host.onclick({ target: { closest: selector => selector === `[data-rm-${group}]` ? { getAttribute: () => value } : null } });
test("initial market render keeps weekly policy unqueried with zero added GETs or writes", async () => {
  const calls = [], host = element(), controller = client(async (url, options) => { calls.push({ url, options }); return null; });
  await controller.mount(host, scope()); assert.deepEqual(calls, [{ url: "/api/regional-market?regionKey=sancheong", options: undefined }]);
  assert.match(host.innerHTML, /주 1회 설정 조회/); assert.match(host.innerHTML, /매주 월요일 12시 자동 확인 켜기/); assert.match(host.slots["[data-rm-weekly-receipt]"].textContent, /아직 조회하지 않았습니다/); controller.stop();
});
test("explicit status is one read and enable sends only the authorized enabled boolean", async () => {
  const calls = [], host = element(), controller = client(async (url, options) => {
    calls.push({ url, options }); return url.includes("missing-weekly-policy") ? policy({ enabled: Boolean(options), status: options ? "waiting" : "disabled", nextDueAt: options ? policy().nextDueAt : null, nextEligibleAt: null }) : null;
  });
  await controller.mount(host, scope()); click(host, "weekly", "status"); await tick(); assert.equal(calls[1].url, "/api/regional-market/missing-weekly-policy"); assert.equal(calls[1].options, undefined);
  assert.match(host.slots["[data-rm-weekly-receipt]"].textContent, /자동 확인 꺼짐/);
  click(host, "weekly", "enable"); await tick(); assert.deepEqual(calls[2], { url: "/api/regional-market/missing-weekly-policy", options: { method: "POST", headers: { "Content-Type": "application/json" }, body: '{"enabled":true}' } });
  assert.match(host.slots["[data-rm-weekly-receipt]"].textContent, /자동 확인 켜짐/); assert.match(host.slots["[data-rm-weekly-receipt]"].textContent, /매주 월요일 12:00 \(한국시간\)/);
  assert.match(host.slots["[data-rm-weekly-receipt]"].textContent, /다음 확인 예정/); assert.equal(host.weekly[1].disabled, true);
  click(host, "weekly", "enable"); await tick(); assert.equal(calls.length, 3); controller.stop();
});
test("busy policy commands block duplicate enable, manual collection and unrelated refresh", async () => {
  const wait = deferred(), calls = [], host = element(), controller = client(async (url, options) => { calls.push({ url, options }); return url.includes("missing-weekly-policy") ? wait.promise : null; });
  await controller.mount(host, scope()); click(host, "weekly", "enable"); click(host, "weekly", "enable"); click(host, "missing", "collect"); await controller.refreshStatus();
  assert.equal(calls.length, 2); assert.ok(host.weekly.every(control => control.disabled)); assert.ok(host.missing.every(control => control.disabled)); assert.equal(controller.state.weeklyBusy, true);
  wait.resolve(policy()); await tick(); assert.equal(controller.state.weeklyBusy, false); assert.equal(calls.filter(value => value.options?.method === "POST").length, 1); controller.stop();
});
test("late prior account and region policy responses cannot change the newly selected view", async () => {
  for (const changed of [{ accountKey: "admin-b" }, { regionKey: "jinju", regionLabel: "진주시" }]) {
    const wait = deferred(), calls = [], host = element(), controller = client(async (url, options) => { calls.push({ url, options }); return url.includes("missing-weekly-policy") ? wait.promise : null; });
    await controller.mount(host, scope()); click(host, "weekly", "status"); await controller.mount(host, scope(changed)); wait.resolve(policy()); await tick();
    assert.equal(controller.state.weeklyResult, null); assert.equal(controller.state.weeklyBusy, false); assert.match(host.slots["[data-rm-weekly-receipt]"].textContent, /아직 조회하지 않았습니다/);
    assert.equal(calls.filter(value => value.url.includes("missing-weekly-policy")).length, 1); controller.stop();
  }
});
test("hidden or stopped views ignore pending policy receipts and do not issue further commands", async () => {
  const wait = deferred(), calls = [], host = element(); let visible = true;
  const controller = client(async (url, options) => { calls.push({ url, options }); return url.includes("missing-weekly-policy") ? wait.promise : null; });
  await controller.mount(host, scope({ isVisible: () => visible })); click(host, "weekly", "status"); visible = false; controller.stop(); wait.resolve(policy()); await tick(); click(host, "weekly", "enable");
  assert.equal(controller.state.weeklyResult, null); assert.equal(controller.state.weeklyBusy, false); assert.equal(calls.length, 2);
});
test("native holds are explained in Korean and wrong or unknown schedules never become enabled claims", async () => {
  const host = element(); let reply = policy({ status: "held" }); const controller = client(async url => url.includes("missing-weekly-policy") ? reply : null);
  await controller.mount(host, scope()); click(host, "weekly", "status"); await tick(); assert.match(host.slots["[data-rm-weekly-receipt]"].textContent, /추가 수집을 보류합니다/);
  for (const value of [policy({ status: "unknown" }), policy({ schedule: { ...policy().schedule, hour: 3 } }), policy({ nextDueAt: "unknown" })]) {
    reply = value; click(host, "weekly", "status"); await tick(); assert.match(host.slots["[data-rm-weekly-receipt]"].textContent, /응답을 검증하지 못했습니다/);
  }
  assert.equal(controller.state.weeklyResult.status, "held"); controller.stop();
});
