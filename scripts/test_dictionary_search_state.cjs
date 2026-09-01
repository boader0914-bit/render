"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// Run the real saved-run loader with all network and heavy render work stubbed.
// Loading a collection result must not replace a separate region-analysis query.
const source = fs.readFileSync(path.join(__dirname, "..", "web", "app.js"), "utf8").replace(/\r\n/g, "\n");
const html = fs.readFileSync(path.join(__dirname, "..", "web", "index.html"), "utf8");
const loadRunDeclaration = source.match(/^async function loadRun\([^]*?^}/m)?.[0];
assert.ok(loadRunDeclaration, "Missing loadRun function");
assert.match(html, /<input id="dictionarySearchInput"[^>]*\bvalue=""/, "Region analysis starts with an empty query");

async function fixture(initialQuery) {
  const dictionarySearchInput = { value: initialQuery };
  const selectedLocationCard = initialQuery ? { regionKey: "manual-region", searchKeyword: initialQuery } : null;
  const state = {
    data: null,
    activeRunId: null,
    activeTab: "report",
    selectedLocationCard,
    dictionaryPendingRegion: null,
    placeRankReplayRunId: null
  };
  const calls = [];
  const context = vm.createContext({
    state,
    els: { dictionarySearchInput, runSelect: { value: "" } },
    loadRunRequestSequence: 0,
    encodeURIComponent,
    setStatus: (value) => calls.push(`status:${value}`),
    fetchJson: async () => ({ run: { id: "run-latest", keyword: "합천 글램핑" } }),
    isAdminRole: () => false,
    renderAll: () => calls.push("render"),
    adminDbCompanyIdFromRoute: () => "",
    handleAdminDbCompanyHash: () => calls.push("route"),
    loadHistoryOps: async () => {},
    loadCompanyMasterSummary: async () => {},
    loadB2BMemberAdminOverview: async () => {},
    loadAccountDeleteAdminOverview: async () => {},
    loadSecurityHardeningOverview: async () => {}
  });
  const api = vm.runInContext(`${loadRunDeclaration}\n({ loadRun })`, context);
  await api.loadRun("run-latest");
  return { state, dictionarySearchInput, selectedLocationCard, runSelect: context.els.runSelect, calls };
}

(async () => {
  for (const initialQuery of ["", "산청"]) {
    const result = await fixture(initialQuery);
    assert.equal(result.dictionarySearchInput.value, initialQuery, "Collection history must not populate or replace the region query");
    assert.equal(result.state.selectedLocationCard, result.selectedLocationCard, "A manually selected region remains selected");
    assert.equal(result.state.activeRunId, "run-latest", "The requested collection result still loads");
    assert.equal(result.state.data.run.keyword, "합천 글램핑", "Collection data remains available to collection views");
    assert.equal(result.runSelect.value, "run-latest", "The collection selector still follows the loaded result");
    assert.deepEqual(result.calls, ["status:데이터 로딩", "render", "status:준비"]);
  }
  console.log("Dictionary search state checks: 12 passed, 0 failed");
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
