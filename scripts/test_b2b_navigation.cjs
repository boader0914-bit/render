"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// Only navigation declarations run. No app bootstrap, server, browser, or network.
// --source <path> or --source - (stdin) permits the same checks against an old app.
const args = process.argv.slice(2);
assert.ok(!args.length || (args.length === 2 && args[0] === "--source"), "Usage: node test_b2b_navigation.cjs [--source <path|->]");
const source = fs.readFileSync(args[1] === "-" ? 0 : args[1] || path.join(__dirname, "..", "web", "app.js"), "utf8").replace(/\r\n/g, "\n");
const html = fs.readFileSync(path.join(__dirname, "..", "web", "index.html"), "utf8");
const constantNames = [
  "ROLE_TABS", "B2B_PRIMARY_TABS", "TAB_LABELS", "B2B_TAB_LABELS", "B2B_NAV_META",
  "ADMIN_MOBILE_SECTIONS", "ADMIN_COMPACT_SECTIONS", "ADMIN_PANEL_MOBILE_TARGETS", "ADMIN_NAV_META"
];
const functionNames = [
  "escapeHtml", "isAdminUserViewMode", "currentRole", "isAdminRole", "roleTabs", "roleAllowsTab", "firstRoleTab", "tabLabel",
  "adminPrimarySectionForTab", "adminMobileSectionForTab", "adminPanelMobileTarget",
  "b2bSearchPolicy", "allowedB2BSearchRange", "syncB2BSearchRangeControl",
  "syncPrimaryNavButtons", "syncB2BRegionSecondaryNav", "syncAppHistoryState", "applyRoleUi", "setActiveTab"
];
// Do not fail merely because the old implementation lacks the new helper.
// The old implementation must fail on the observable stale home panel instead.
if (source.includes("function syncB2BSearchPanelVisibility(")) functionNames.push("syncB2BSearchPanelVisibility");
const declarations = [
  ...constantNames.map((name) => {
    const declaration = source.match(new RegExp(`^const ${name} = [^\\n]*;$`, "m"))?.[0]
      || source.match(new RegExp(`^const ${name} = \\{[^]*?^\\};`, "m"))?.[0];
    assert.ok(declaration, `Missing navigation constant: ${name}`);
    return declaration;
  }),
  ...functionNames.map((name) => {
    const declaration = source.match(new RegExp(`^function ${name}\\([^]*?^}`, "m"))?.[0];
    assert.ok(declaration, `Missing navigation function: ${name}`);
    return declaration;
  })
].join("\n");

function element(dataset = {}, classes = []) {
  const values = new Set(classes);
  const attributes = {};
  return {
    dataset, hidden: false, value: "", innerHTML: "", textContent: "",
    classList: {
      contains: (value) => values.has(value),
      toggle(value, enabled) { if (enabled) values.add(value); else values.delete(value); },
      add: (value) => values.add(value),
      remove: (value) => values.delete(value)
    },
    setAttribute: (name, value) => { attributes[name] = value; },
    getAttribute: (name) => attributes[name],
    removeAttribute: (name) => { delete attributes[name]; },
    querySelector: () => null,
    querySelectorAll: () => []
  };
}

function fixture({ data = false, running = false, role = "b2b" } = {}) {
  const navHtml = html.match(/<nav class="bottom-nav"[^]*?<\/nav>/)?.[0] || "";
  const buttons = [...navHtml.matchAll(/<button\b[^>]*\bdata-(tab|admin-primary)="([^"]+)"[^>]*>/g)]
    .map((match) => element({ [match[1] === "tab" ? "tab" : "adminPrimary"]: match[2] }));
  const panels = [...html.matchAll(/<section\b[^>]*\bclass="tab-panel(?: active)?"[^>]*\bdata-panel="([^"]+)"[^>]*>/g)]
    .map((match) => element({ panel: match[1] }, ["tab-panel"]));
  assert.ok(buttons.length >= 4 && panels.length >= 5, "Use the real main-menu and panel markup");
  const secondary = ["map", "demand"].map((tab) => element({ b2bRegionTab: tab }));
  const state = {
    session: { role: role === "preview" ? "admin" : role, accountType: "member" },
    adminUserViewMode: role === "preview", activeTab: "report", adminPanelSection: "overview",
    data: data ? { run: { id: "offline-navigation-fixture" } } : null,
    b2bSearchLoading: running, b2bSearchQuery: "saved query", b2bSearchRange: "1-10"
  };
  const els = Object.fromEntries([
    "b2bSearchPanel", "b2bSearchInput", "b2bSearchRangeInput", "b2bSearchResults", "b2bSearchStatus",
    "b2bOnboarding", "b2bSearchHistory", "b2bRegionSecondaryNav", "pageTitle"
  ].map((name) => [name, element()]));
  els.b2bSearchInput.value = "unsaved search text";
  els.b2bSearchRangeInput.value = "1-10";
  els.b2bSearchResults.innerHTML = running ? "progress already on screen" : "existing result preview";
  els.b2bSearchStatus.textContent = "existing status";
  els.b2bOnboarding.innerHTML = "existing home content";
  els.b2bSearchHistory.innerHTML = "existing search history";
  els.b2bRegionSecondaryNav.querySelectorAll = () => secondary;
  const document = {
    body: element(), activeElement: els.b2bSearchInput,
    querySelectorAll(selector) {
      if (selector === ".bottom-nav button") return buttons;
      if (selector === ".tab-panel") return panels;
      return [];
    }
  };
  const historyCalls = [];
  const history = {
    state: { tab: "report" },
    pushState(value) { this.state = value; historyCalls.push("push"); },
    replaceState(value) { this.state = value; historyCalls.push("replace"); }
  };
  const noOp = () => {};
  const context = {
    state, els, document, window: { history, location: { href: "about:blank" } },
    fetch() { throw new Error("Navigation must not issue network requests"); },
    adminNavIconSvg: () => "", syncAdminDesktopSecondaryNav: noOp,
    syncRoleStaticLabels: noOp, syncAdminSectionPanels: noOp, syncAdminMobileNav: noOp, releaseAppBoot: noOp,
    renderHeader: noOp, renderPlaceRankReplayNotice: noOp, closeDrawer: noOp,
    renderB2BEmptyPanels: noOp, renderLocationDictionary: noOp, renderReport: noOp,
    renderDecisionQueue: noOp, renderMap: noOp, renderDemand: noOp, renderHistoryOps: noOp,
    renderCompanyMasterPanel: noOp, renderDownloads: noOp, syncYeogiManualInterface: noOp,
    renderB2BSearchPanel() { throw new Error("Tab navigation must not rebuild the search form or progress UI"); }
  };
  // Expensive body renderers are outside this test; actual role/menu/panel updates run.
  const api = vm.runInNewContext(`${declarations}\n({ setActiveTab, applyRoleUi, currentRole })`, context, { timeout: 1000 });
  const preserved = () => JSON.stringify([
    els.b2bSearchInput.value, els.b2bSearchRangeInput.value, els.b2bSearchResults.innerHTML,
    els.b2bSearchStatus.textContent, els.b2bOnboarding.innerHTML, els.b2bSearchHistory.innerHTML,
    state.b2bSearchLoading, state.b2bSearchQuery, state.data
  ]);
  api.applyRoleUi();
  return { api, state, els, buttons, panels, secondary, historyCalls, document, preserved };
}

function assertView(test, expectedTab) {
  assert.equal(test.state.activeTab, expectedTab, "the requested allowed tab becomes current");
  const admin = test.api.currentRole() === "admin";
  assert.equal(test.els.b2bSearchPanel.hidden, admin || expectedTab !== "report", "home search visibility follows the active tab and role");
  assert.deepEqual(test.panels.filter((panel) => !panel.hidden && panel.classList.contains("active")).map((panel) => panel.dataset.panel), [expectedTab], "exactly the selected body panel is active");
  if (admin) {
    assert.ok(test.document.body.classList.contains("role-admin"));
    assert.ok(test.buttons.filter((button) => button.dataset.tab).every((button) => button.hidden), "B2B primary menus are not shown to the administrator");
    return;
  }
  assert.ok(test.document.body.classList.contains("role-b2b"));
  const selected = test.buttons.filter((button) => !button.hidden && button.classList.contains("active"));
  assert.deepEqual(selected.map((button) => button.dataset.tab), [expectedTab === "demand" ? "map" : expectedTab], "primary menu and body agree, including the demand subtab");
  assert.equal(selected[0].getAttribute("aria-pressed"), "true");
  const regional = ["map", "demand"].includes(expectedTab);
  assert.equal(test.els.b2bRegionSecondaryNav.hidden, !regional);
  if (regional) assert.deepEqual(test.secondary.filter((button) => button.classList.contains("active")).map((button) => button.dataset.b2bRegionTab), [expectedTab]);
  for (const panel of test.panels.filter((panel) => ["dictionary", "target", "decisionQueue", "historyOps", "admin"].includes(panel.dataset.panel))) {
    assert.equal(panel.hidden, true, `restricted panel ${panel.dataset.panel} remains hidden`);
  }
}

let passed = 0;
const failures = [];
function check(label, run) {
  try { run(); passed += 1; } catch (error) { failures.push({ label, message: error.message }); }
}

for (const role of ["b2b", "preview"]) for (const data of [false, true]) for (const running of [false, true]) for (const fromHistory of [false, true]) {
  const test = fixture({ role, data, running });
  const label = `${role}/data=${data}/running=${running}/history=${fromHistory}`;
  check(`${label}/initial home`, () => assertView(test, "report"));
  const before = test.preserved();
  for (const tab of ["rank", "map", "demand", "account", "report"]) {
    check(`${label}/${tab}`, () => {
      const previousCalls = test.historyCalls.length;
      test.api.setActiveTab(tab, { fromHistory });
      assertView(test, tab);
      assert.equal(test.preserved(), before, "tab changes preserve unfinished input, progress, history, and collected data");
      assert.equal(test.historyCalls.length - previousCalls, fromHistory ? 0 : 1, "back/forward navigation must not push another history entry");
    });
  }
}

for (const data of [false, true]) {
  for (const tab of ["dictionary", "target", "decisionQueue", "historyOps", "admin", "unknown"]) {
    check(`role restriction/data=${data}/${tab}`, () => {
      const test = fixture({ data });
      test.api.setActiveTab("account");
      test.api.setActiveTab(tab);
      assertView(test, "report");
    });
  }
  check(`direct role UI synchronization/data=${data}`, () => {
    const test = fixture({ data, running: true });
    const before = test.preserved();
    test.state.activeTab = "map";
    test.api.applyRoleUi(); // The same entry used by renderAll and background UI updates.
    assertView(test, "map");
    test.state.activeTab = "report";
    test.api.applyRoleUi();
    assertView(test, "report");
    assert.equal(test.preserved(), before);
  });
  check(`B2B to administrator and back/data=${data}`, () => {
    const test = fixture({ data });
    test.state.session.role = "admin";
    test.api.applyRoleUi();
    assertView(test, "report");
    test.api.setActiveTab("admin");
    assertView(test, "admin");
    test.state.session.role = "b2b";
    test.api.applyRoleUi();
    assertView(test, "report");
  });
  check(`administrator user-view exit/data=${data}`, () => {
    const test = fixture({ data, role: "preview" });
    test.state.adminUserViewMode = false;
    test.api.applyRoleUi();
    assertView(test, "report");
  });
}

console.log(`B2B navigation checks: ${passed} passed, ${failures.length} failed`);
for (const failure of failures.slice(0, 8)) console.error(`${failure.label}: ${failure.message}`);
if (failures.length) process.exitCode = 1;
