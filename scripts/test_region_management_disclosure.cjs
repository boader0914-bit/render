"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname, "..", "web", "app.js"), "utf8").replace(/\r\n/g, "\n");
const names = ["adminRegionalAnalysisPanel", "renderAdminRegionAnalysisDashboard"];
const declarations = names.map(name => {
  const declaration = source.match(new RegExp(`^function ${name}\\([^]*?^}`, "m"))?.[0];
  assert.ok(declaration, name);
  return declaration;
});

// Exercise the production renderer. Assigning innerHTML replaces the old details
// node, just as it does in the browser when a review filter is selected.
let overview = null;
let renderedHtml = "";
const dashboard = {
  hidden: false,
  querySelector: selector => selector === ".region-management-overview" ? overview : null,
  set innerHTML(value) {
    renderedHtml = value;
    const tag = value.match(/<details class="region-management-overview"([^>]*)>/);
    overview = tag ? { open: /\bopen\b/.test(tag[1]) } : null;
  },
  get innerHTML() { return renderedHtml; }
};
const state = { adminDbViewMode: "region", adminDbFilters: { query: "" }, adminRegionReviewFilter: "all", adminRegionOverviewOpen: false };
const context = vm.createContext({
  state,
  els: { adminRegionAnalysisDashboard: dashboard },
  document: { getElementById: () => null },
  isAdminRole: () => true,
  adminSelectedRegion: () => null,
  administrativeRegionForKey: () => null,
  adminRegionalOpsSource: () => ({ masterOps: {}, summary: {}, regions: [] }),
  adminRegionFilteredRegions: regions => regions,
  adminRegionSelectedReviewFilter: () => ({ label: state.adminRegionReviewFilter }),
  adminRegionalDetailPanel: () => "",
  adminRegionalSummaryCells: () => [],
  adminLocationScoreReviewQueuePanel: () => "",
  adminRegionReviewFilterBar: () => `<div data-active-filter="${state.adminRegionReviewFilter}"></div>`,
  escapeHtml: value => String(value),
  fmtNumber: value => String(value)
});
const render = vm.runInContext(`${declarations.join("\n")}\nrenderAdminRegionAnalysisDashboard`, context);

render({});
assert.equal(overview.open, false, "The national overview starts collapsed");
overview.open = true;
state.adminRegionReviewFilter = "review_needed";
render({});
assert.equal(overview.open, true, "Selecting a filter must leave its results visible");
assert.match(renderedHtml, /data-active-filter="review_needed"/);
render({});
assert.equal(overview.open, true, "Repeated dashboard rendering preserves the disclosure");

overview.open = false;
render({});
assert.equal(overview.open, false, "An explicit user collapse must remain collapsed");
overview.open = true;
state.adminDbViewMode = "list";
render({});
assert.equal(dashboard.hidden, true);
state.adminDbViewMode = "region";
render({});
assert.equal(overview.open, true, "Returning to region DB preserves the last disclosure choice");
console.log("Region management disclosure: initial collapse, filter results, repeated rendering, manual collapse and return state passed");
