"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const app = fs.readFileSync(path.join(__dirname, "..", "web", "app.js"), "utf8");
function block(start, end) {
  const first = app.indexOf(start);
  const last = app.indexOf(end, first + start.length);
  assert.ok(first >= 0 && last > first, `Missing source block: ${start}`);
  return app.slice(first, last);
}
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const GAPYEONG = "kr_gyeonggi_gapyeong";
const SANCHEONG = "kr_gyeongnam_sancheong";
function history(regionKey = GAPYEONG, completeMonths = 12) {
  return {
    ok: completeMonths > 0,
    status: completeMonths === 12 ? "ok" : completeMonths ? "partial" : "unavailable",
    region: { regionKey, sigungu: regionKey === GAPYEONG ? "가평군" : "산청군" },
    series: [],
    coverage: { expectedMonths: 12, completeMonths },
    period: { months: 12 }
  };
}
function fixture(options = {}) {
  const regions = {
    [GAPYEONG]: { regionKey: GAPYEONG, sigungu: "가평군", level: "local" },
    [SANCHEONG]: { regionKey: SANCHEONG, sigungu: "산청군", level: "local" }
  };
  const state = {
    activeRunId: "gapyeong-run",
    activeTab: "dictionary",
    analysisRegionSelection: { regionKey: GAPYEONG, explicit: true },
    selectedLocationCard: { regionKey: GAPYEONG },
    locationProfiles: { [GAPYEONG]: { status: "ready", data: { stale: true }, receivedAt: new Date().toISOString() } },
    locationProfileLoading: {},
    data: { run: { id: "gapyeong-run", regionKey: GAPYEONG }, tourismDemandStrengthHistory: history(GAPYEONG, 5) }
  };
  const calls = { requests: [], statuses: [], renders: 0, dictionaryRenders: 0, statusReads: 0 };
  const context = {
    state,
    loadRunRequestSequence: 1,
    LOCATION_PROFILE_RETRY_INTERVAL_MS: 30000,
    isAdminRole: () => true,
    selectedAnalysisRegion: () => regions[state.analysisRegionSelection?.regionKey] || null,
    locationProfileSubjectForRegion: (region) => ({ regionKey: region.regionKey }),
    // Deliberately points elsewhere: shared regional selection must win.
    tourismDemandStrengthRefreshSelector: () => ({ regionKey: SANCHEONG, label: "산청군" }),
    locationProfileEntry: (card) => state.locationProfiles[card.regionKey] || null,
    compactSearchText: (value) => String(value || "").replace(/\s/g, ""),
    tourismDemandStrengthCoverage: (_region, _kind, source) => source.coverage,
    analysisRunMatchesRegion: (region, data) => region.regionKey === data?.run?.regionKey,
    fmtNumber: String,
    renderDemand: () => { calls.renders++; },
    renderLocationDictionary: () => { calls.dictionaryRenders++; },
    renderRegionSources: () => {},
    setStatus: (message) => { calls.statuses.push(message); },
    loadTourismDataStatus: async () => { calls.statusReads++; },
    loadRun: () => { throw new Error("Refresh must never reload an old run"); },
    fetchJson: async (url, input) => {
      calls.requests.push({ url, input });
      if (input?.method === "POST") return options.post ? options.post() : { ok: true, tourismDemandStrengthHistory: history() };
      return options.profile ? options.profile(url) : { ok: true, region: { regionKey: GAPYEONG }, fresh: true };
    }
  };
  vm.createContext(context);
  vm.runInContext([
    block("function tourismDemandStrengthHistoryRegions(", "function tourismDemandStrengthRegionForName("),
    block("async function ensureLocationProfile(", "function locationProfileFirstObject("),
    block("async function refreshTourismDemandStrengthHistory(", "async function loadRun(")
  ].join("\n"), context);
  return { state, calls, context, refresh: () => context.refreshTourismDemandStrengthHistory() };
}

async function main() {
  const success = fixture();
  const previousData = success.state.data;
  await success.refresh();
  const request = JSON.parse(success.calls.requests[0].input.body);
  assert.equal(request.regionKey, GAPYEONG);
  assert.equal(request.force, false);
  assert.equal(request.months, 12);
  assert.equal(success.calls.requests[1].url, `/api/tourism-data/location-history?regionKey=${GAPYEONG}`);
  assert.equal(success.calls.requests[1].input, undefined, "Profile reread must stay GET/cache-only");
  assert.equal(success.state.locationProfiles[GAPYEONG].data.fresh, true);
  assert.notEqual(success.state.data, previousData);
  assert.equal(success.state.tourismDemandStrengthRefresh.tone, "success");
  assert.equal(success.state.tourismDemandStrengthRefresh.loading, false);
  assert.ok(success.calls.dictionaryRenders >= 2, "Regional view receives the result message as well as fresh evidence");

  const empty = fixture({ post: () => ({ ok: false, tourismDemandStrengthHistory: history(GAPYEONG, 0) }) });
  const knownGoodData = empty.state.data;
  await empty.refresh();
  assert.equal(empty.state.tourismDemandStrengthRefresh.tone, "error");
  assert.match(empty.state.tourismDemandStrengthRefresh.message, /정상 저장자료 없음/);
  assert.doesNotMatch(empty.state.tourismDemandStrengthRefresh.message, /갱신 완료/);
  assert.equal(empty.state.data, knownGoodData, "No normal months must not replace known data");
  assert.equal(empty.calls.requests.length, 2, "Empty result still rereads the region cache");

  const partial = fixture({ post: () => ({ ok: true, tourismDemandStrengthHistory: history(GAPYEONG, 3) }) });
  await partial.refresh();
  assert.equal(partial.state.tourismDemandStrengthRefresh.tone, "neutral");
  assert.match(partial.state.tourismDemandStrengthRefresh.message, /일부 저장자료/);

  for (const mutation of ["region", "run", "run-started", "data"]) {
    const pending = deferred();
    const late = fixture({ post: () => pending.promise });
    const running = late.refresh();
    if (mutation === "region") {
      late.state.analysisRegionSelection = { regionKey: SANCHEONG, explicit: true };
      late.state.selectedLocationCard = { regionKey: SANCHEONG };
    } else if (mutation === "run") late.state.activeRunId = "another-run";
    else if (mutation === "run-started") late.context.loadRunRequestSequence++;
    else late.state.data = { run: { id: "replacement", regionKey: GAPYEONG } };
    const selectedData = late.state.data;
    const statusCount = late.calls.statuses.length;
    pending.resolve({ ok: true, tourismDemandStrengthHistory: history() });
    await running;
    assert.equal(late.state.data, selectedData, `${mutation}: old request must not change current data`);
    assert.equal(late.calls.statuses.length, statusCount, `${mutation}: old completion must not label the current view`);
    assert.equal(late.state.locationProfiles[GAPYEONG].data.fresh, true, "Only the requested region cache is refreshed");
    assert.equal(late.state.tourismDemandStrengthRefresh.loading, false);
    assert.equal(late.state.tourismDemandStrengthRefresh.message, "");
  }

  const reread = deferred();
  const duringGet = fixture({ profile: () => reread.promise });
  const pendingGet = duringGet.refresh();
  await Promise.resolve();
  await Promise.resolve();
  duringGet.state.activeRunId = "new-run-during-get";
  const unchangedData = duringGet.state.data;
  reread.resolve({ ok: true, fresh: true });
  await pendingGet;
  assert.equal(duringGet.state.data, unchangedData);

  const mismatch = fixture({ post: () => ({ ok: true, tourismDemandStrengthHistory: history(SANCHEONG) }) });
  await mismatch.refresh();
  assert.equal(mismatch.calls.requests.length, 1, "Mismatched response must not invalidate a region cache");
  assert.equal(mismatch.state.locationProfiles[GAPYEONG].data.stale, true);
  assert.equal(mismatch.state.tourismDemandStrengthRefresh.tone, "error");

  const profileFailure = fixture({ profile: () => { throw new Error("cache read unavailable"); } });
  const beforeProfileFailure = profileFailure.state.data;
  await profileFailure.refresh();
  assert.equal(profileFailure.state.data, beforeProfileFailure);
  assert.equal(profileFailure.state.tourismDemandStrengthRefresh.tone, "error");
  assert.match(profileFailure.state.tourismDemandStrengthRefresh.message, /저장자료 재조회 실패/);

  const oldFailure = deferred();
  const staleFailure = fixture({ post: () => oldFailure.promise });
  const oldRequest = staleFailure.refresh();
  staleFailure.state.analysisRegionSelection = { regionKey: SANCHEONG, explicit: true };
  const beforeOldFailure = staleFailure.calls.statuses.length;
  oldFailure.reject(new Error("previous region failed"));
  await oldRequest;
  assert.equal(staleFailure.calls.statuses.length, beforeOldFailure);
  assert.equal(staleFailure.state.tourismDemandStrengthRefresh.message, "");
  assert.equal(staleFailure.state.tourismDemandStrengthRefresh.loading, false);

  const differentRunRegion = fixture();
  differentRunRegion.state.data = { run: { id: "sancheong-run", regionKey: SANCHEONG } };
  const unrelatedData = differentRunRegion.state.data;
  await differentRunRegion.refresh();
  assert.equal(differentRunRegion.state.data, unrelatedData, "Selected region result cannot become an unrelated run's evidence");
  assert.equal(differentRunRegion.state.locationProfiles[GAPYEONG].data.fresh, true);

  // The older initial profile GET may finish after the post-refresh GET.
  for (const rejectOld of [false, true]) {
    const old = deferred();
    let reads = 0;
    const overlap = fixture({ profile: () => ++reads === 1 ? old.promise : { ok: true, fresh: true } });
    delete overlap.state.locationProfiles[GAPYEONG];
    const initial = overlap.context.ensureLocationProfile({ regionKey: GAPYEONG });
    await overlap.refresh();
    if (rejectOld) old.reject(new Error("old request failed"));
    else old.resolve({ ok: true, stale: true });
    await initial;
    assert.equal(overlap.state.locationProfiles[GAPYEONG].data.fresh, true);
    assert.equal(overlap.state.locationProfiles[GAPYEONG].status, "ready");
    assert.equal(overlap.state.locationProfileLoading[GAPYEONG], false);
  }
  console.log("Demand-strength refresh: selected region, empty/partial results, stale region/run/data responses, profile invalidation and overlapping GETs passed");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
