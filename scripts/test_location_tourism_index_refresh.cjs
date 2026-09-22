"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");
const source = fs.readFileSync(path.join(__dirname, "../web/app.js"), "utf8").replace(/\r\n/g, "\n");
const declarations = ["locationTourismIndexRefreshOutcome", "refreshLocationTourismIndexHistory"].map(name => {
  const declaration = source.match(new RegExp(`^(?:async )?function ${name}\\([^]*?^}`, "m"))?.[0];
  assert.ok(declaration, name);
  return declaration;
});
const regionKey = "kr_gyeonggi_pocheon";

function historyResponse(sourceKey, type = "complete") {
  const operations = sourceKey === "resourceDemand" ? ["service", "culture"] : ["tourist", "consumption", "international"];
  const series = Array.from({ length: 12 }, (_, index) => {
    const kind = type === "partial" ? index < 5 ? "complete" : "empty" : type;
    const status = kind === "complete" ? "complete" : "missing";
    return {
      yearMonth: `2025${String(index + 1).padStart(2, "0")}`,
      status, access: "network",
      reason: kind === "empty" ? "no_observation" : kind === "error" ? "api_error" : "",
      operations: Object.fromEntries(operations.map(key => [key, {
        status: kind === "complete" ? "ok" : kind === "empty" ? "no_observation" : "error",
        reason: kind === "empty" ? "empty_verified" : kind === "error" ? "api_error" : "",
        overallValue: kind === "complete" ? 40 : null
      }]))
    };
  });
  const completeMonths = series.filter(row => row.status === "complete").length;
  const history = {
    ok: completeMonths > 0,
    status: completeMonths === 12 ? "ok" : completeMonths ? "partial" : "unavailable",
    reason: completeMonths === 12 ? "" : completeMonths ? "incomplete_history_coverage" : "no_complete_history_observation",
    region: { regionKey }, series,
    coverage: { expectedMonths: 12, completeMonths },
    // collectRegionalIndexHistory counts verified no_observation responses here too.
    collection: { networkAttemptedMonths: 12, networkSucceededMonths: completeMonths, networkFailedMonths: 12 - completeMonths }
  };
  return { ok: history.ok, status: history.status, reason: history.reason,
    [sourceKey === "resourceDemand" ? "tourismResourceDemandHistory" : "tourismDiversityHistory"]: history };
}

function setup(result, { observed = false, requestError = null, profileStatus = "ready", beforeResponse = null } = {}) {
  const state = { activeTab: "dictionary", selectedLocationCard: { regionKey }, locationProfiles: {}, locationTourismIndexRefresh: {} };
  const statuses = [], requests = [];
  const context = vm.createContext({
    state, isAdminRole: () => true, fmtNumber: String,
    locationProfileTourismIndexRefreshKey: (sourceKey, key) => `${sourceKey}:${key}`,
    renderLocationDictionary: () => {},
    fetchJson: async (url, options) => {
      requests.push({ url, body: JSON.parse(options.body) });
      if (requestError) throw new Error(requestError);
      if (beforeResponse) beforeResponse(state);
      return result;
    },
    ensureLocationProfile: async () => { state.locationProfiles[regionKey] = { status: profileStatus, data: {}, error: profileStatus === "ready" ? "" : "저장자료 조회 실패" }; },
    locationProfilePayload: () => ({}), dictionaryAliasForCard: () => ({}),
    locationProfileResourceDemandEvidence: () => ({ observed }),
    locationProfileDiversityEvidence: () => ({ observed }),
    setStatus: value => statuses.push(value)
  });
  const api = vm.runInContext(`${declarations.join("\n")}\n({locationTourismIndexRefreshOutcome, refreshLocationTourismIndexHistory})`, context);
  return { state, statuses, requests, ...api };
}

for (const sourceKey of ["resourceDemand", "diversity"]) {
  test(`${sourceKey}: HTTP 200 with twelve provider failures never becomes completed or verified empty`, async () => {
    const item = setup(historyResponse(sourceKey, "error"));
    await item.refreshLocationTourismIndexHistory(sourceKey, regionKey);
    const result = item.state.locationTourismIndexRefresh[`${sourceKey}:${regionKey}`];
    assert.equal(result.error, true);
    assert.equal(result.status, "error");
    assert.match(result.message, /호출 실패 12개월/);
    assert.doesNotMatch(result.message, /제공자료 없음|갱신 완료/);
    assert.ok(item.statuses.every(message => !message.includes("갱신 완료")));
    assert.equal(item.requests.length, 1);
    assert.equal(item.requests[0].body.regionKey, regionKey);
  });

  test(`${sourceKey}: a failed refresh can retain previously observed data without calling it success`, async () => {
    const item = setup(historyResponse(sourceKey, "error"), { observed: true });
    await item.refreshLocationTourismIndexHistory(sourceKey, regionKey);
    const result = item.state.locationTourismIndexRefresh[`${sourceKey}:${regionKey}`];
    assert.equal(result.error, true);
    assert.match(result.message, /저장자료는 유지/);
  });

  test(`${sourceKey}: verified empty responses and partial coverage stay distinct from request failure and full success`, () => {
    const item = setup({});
    const empty = item.locationTourismIndexRefreshOutcome(historyResponse(sourceKey, "empty"), sourceKey, regionKey);
    assert.equal(empty.status, "empty");
    assert.equal(empty.error, false);
    assert.match(empty.message, /정상 조회.*제공자료 없음/);
    const partial = item.locationTourismIndexRefreshOutcome(historyResponse(sourceKey, "partial"), sourceKey, regionKey, { observed: true });
    assert.equal(partial.status, "partial");
    assert.match(partial.message, /5\/12/);
    assert.doesNotMatch(partial.message, /갱신 완료/);
    const complete = item.locationTourismIndexRefreshOutcome(historyResponse(sourceKey), sourceKey, regionKey, { observed: true });
    assert.equal(complete.status, "complete");
    assert.match(complete.message, /갱신 완료.*12\/12/);
  });
}

test("unrecognized or wrong-region responses cannot claim completion", () => {
  const item = setup({});
  assert.throws(() => item.locationTourismIndexRefreshOutcome({}, "resourceDemand", regionKey), /갱신 결과/);
  const result = historyResponse("resourceDemand");
  result.tourismResourceDemandHistory.region.regionKey = "kr_gyeonggi_gapyeong";
  assert.throws(() => item.locationTourismIndexRefreshOutcome(result, "resourceDemand", regionKey), /갱신 결과/);
  const unavailable = historyResponse("resourceDemand", "error");
  unavailable.tourismResourceDemandHistory.series = [];
  unavailable.tourismResourceDemandHistory.collection = { networkAttemptedMonths: 0, networkFailedMonths: 0 };
  assert.equal(item.locationTourismIndexRefreshOutcome(unavailable, "resourceDemand", regionKey).status, "unavailable");
});

test("a partially observed month with failed detailed metric requests reports the failure", () => {
  const item = setup({});
  const result = historyResponse("resourceDemand");
  const history = result.tourismResourceDemandHistory;
  history.status = "partial";
  history.series[0].status = "partial";
  history.series[0].operations.service.status = "partial";
  history.series[0].operations.service.quality = { metricQueryFailedCount: 1 };
  history.series[0].operations.service.metricRequests = [{ status: "ok" }, { status: "error" }];
  history.collection.networkFailedMonths = 1;
  const outcome = item.locationTourismIndexRefreshOutcome(result, "resourceDemand", regionKey, { observed: true });
  assert.equal(outcome.error, true);
  assert.match(outcome.message, /호출 실패 1개월.*11\/12.*저장자료는 유지/);
});

test("transport errors and failed saved-profile reads remain failures", async () => {
  for (const options of [{ requestError: "연결 실패" }, { profileStatus: "error" }, { profileStatus: "unavailable" }]) {
    const item = setup(historyResponse("resourceDemand"), options);
    await item.refreshLocationTourismIndexHistory("resourceDemand", regionKey);
    assert.equal(item.state.locationTourismIndexRefresh[`resourceDemand:${regionKey}`].error, true);
    assert.ok(item.statuses.every(message => !message.includes("갱신 완료")));
  }
});

test("a late region response retains its own result and cannot announce success for the newly selected region", async () => {
  const item = setup(historyResponse("resourceDemand"), { observed: true,
    beforeResponse: state => { state.selectedLocationCard = { regionKey: "kr_gyeonggi_gapyeong" }; } });
  await item.refreshLocationTourismIndexHistory("resourceDemand", regionKey);
  assert.equal(item.state.locationTourismIndexRefresh[`resourceDemand:${regionKey}`].status, "complete");
  assert.equal(item.state.selectedLocationCard.regionKey, "kr_gyeonggi_gapyeong");
  assert.equal(item.statuses.length, 0);
});
