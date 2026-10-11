"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "web", "app.js"), "utf8").replace(/\r\n/g, "\n");
const foldKeys = ["profile", "correction", "channel", "collect", "review"];
const names = [
  "escapeHtml", "adminDbSelectedDetailTabs", "adminDbSelectedFoldBlock", "adminDbCompanyMaintenanceHtml",
  "syncAdminDbReviewNavigation", "openAdminDbReviewFold", "handleAdminDbReviewToggle",
  "renderAdminDatabaseDashboard", "loadAdminDbCompanyDetail"
];
const declarations = names.map((name) => {
  const declaration = source.match(new RegExp(`^(?:async )?function ${name}\\([^]*?^}`, "m"))?.[0];
  assert.ok(declaration, `Production function ${name} must exist`);
  return declaration;
});
const clickStart = source.indexOf('    const adminDbOpenFold = event.target.closest("[data-admin-db-open-fold]");');
const clickEnd = source.indexOf("    const queueRecrawl =", clickStart);
assert.ok(clickStart >= 0 && clickEnd > clickStart, "The production review menu click handler must exist");
assert.match(source, /document\.addEventListener\("toggle", handleAdminDbReviewToggle, true\)/, "Native details toggles use a capture listener because toggle does not bubble");

function attributes(tag) {
  const result = {};
  for (const match of tag.matchAll(/([\w-]+)(?:="([^"]*)")?/g)) result[match[1]] = match[2] ?? "";
  return result;
}

// This small DOM fixture implements only browser operations used by the review
// UI. Its innerHTML setter discards every prior node, so preserving an old node
// cannot accidentally make the async-render regression pass.
class Element {
  constructor(tagName, attrs = {}, parent = null) {
    this.tagName = tagName.toUpperCase();
    this.attrs = { ...attrs };
    this.dataset = Object.fromEntries(Object.entries(attrs).filter(([key]) => key.startsWith("data-")).map(([key, value]) => [
      key.slice(5).replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase()), value
    ]));
    this.parentElement = parent;
    this.children = [];
    this.open = Object.hasOwn(attrs, "open");
    this.isConnected = true;
    this.scrollCount = 0;
    if (parent) parent.children.push(this);
    this.classList = {
      contains: (name) => (this.attrs.class || "").split(/\s+/).includes(name),
      toggle: (name, force) => {
        const classes = new Set((this.attrs.class || "").split(/\s+/).filter(Boolean));
        const enabled = force ?? !classes.has(name);
        if (enabled) classes.add(name); else classes.delete(name);
        this.attrs.class = Array.from(classes).join(" ");
        return enabled;
      },
      add: (name) => this.classList.toggle(name, true),
      remove: (name) => this.classList.toggle(name, false)
    };
  }
  getAttribute(name) { return Object.hasOwn(this.attrs, name) ? this.attrs[name] : null; }
  setAttribute(name, value) { this.attrs[name] = String(value); }
  matches(selector) {
    const compoundMatches = (element, part) => {
      const tag = part.match(/^[\w-]+/);
      if (tag && element.tagName !== tag[0].toUpperCase()) return false;
      for (const match of part.matchAll(/\.([\w-]+)/g)) if (!element.classList.contains(match[1])) return false;
      for (const match of part.matchAll(/\[([\w-]+)(?:="([^"]*)")?\]/g)) {
        const actual = match[1] === "open" ? (element.open ? "" : null) : element.getAttribute(match[1]);
        if (actual === null || (match[2] !== undefined && actual !== match[2])) return false;
      }
      return true;
    };
    return selector.split(",").some((part) => {
      const compounds = part.trim().split(/\s+/);
      if (!compoundMatches(this, compounds.pop())) return false;
      let ancestor = this.parentElement;
      while (compounds.length) {
        const required = compounds.pop();
        while (ancestor && !compoundMatches(ancestor, required)) ancestor = ancestor.parentElement;
        if (!ancestor) return false;
        ancestor = ancestor.parentElement;
      }
      return true;
    });
  }
  closest(selector) { return this.matches(selector) ? this : this.parentElement?.closest(selector) || null; }
  querySelectorAll(selector) {
    const descendants = this.children.flatMap((child) => [child, ...child.querySelectorAll("*")]);
    return descendants.filter((child) => child.matches(selector));
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  scrollIntoView() { this.scrollCount++; }
}

function fixture() {
  const state = {
    activeTab: "admin", adminPanelSection: "database", adminDbViewMode: "review", adminDbSelectedCompanyId: "company-a",
    adminDbReviewUi: {}, adminDbCompanyDetails: {}, adminDbCompanyDetailLoading: {},
    companyMaster: { companies: [{ companyId: "company-a" }, { companyId: "company-b" }] }
  };
  const documentRoot = new Element("main");
  const dashboard = new Element("div", {}, documentRoot);
  const recommendations = { "company-a": "channel", "company-b": "review" };
  const pending = [];
  let renderedHtml = "";
  Object.defineProperty(dashboard, "innerHTML", {
    get() { return renderedHtml; },
    set(value) {
      dashboard.querySelectorAll("*").forEach((node) => { node.isConnected = false; });
      dashboard.children = [];
      renderedHtml = value;
      const company = value.match(/data-admin-db-selected-company="([^"]*)"/)?.[1];
      if (!company) return;
      const panel = new Element("section", { class: "admin-db-selected-panel", "data-admin-db-selected-company": company }, dashboard);
      const maintenanceMatch = value.match(/<details\s+([^>]*class="admin-company-maintenance"[^>]*)>/);
      assert.ok(maintenanceMatch, "Real maintenance HTML is used by the fixture");
      const maintenance = new Element("details", attributes(maintenanceMatch[1]), panel);
      new Element("summary", {}, maintenance);
      const tabs = new Element("div", { class: "admin-db-detail-tabs" }, maintenance);
      for (const match of value.matchAll(/<button\s+([^>]*data-admin-db-open-fold="[^"]*"[^>]*)>/g)) {
        new Element("button", attributes(match[1]), tabs);
      }
      for (const match of value.matchAll(/<details\s+([^>]*data-admin-db-fold="[^"]*"[^>]*)>/g)) {
        const fold = new Element("details", attributes(match[1]), maintenance);
        new Element("summary", {}, fold);
      }
    }
  });
  const row = () => ({ company: { companyId: state.adminDbSelectedCompanyId }, metrics: {} });
  const context = vm.createContext({
    state, Array, Object, URLSearchParams,
    window: { requestAnimationFrame: (callback) => callback() },
    document: {
      querySelectorAll: (selector) => documentRoot.querySelectorAll(selector),
      querySelector: (selector) => documentRoot.querySelector(selector)
    },
    els: { adminDatabaseDashboard: dashboard },
    isAdminRole: () => true,
    adminConsoleMasterSource: () => state.companyMaster,
    adminDbFilterState: () => ({ rows: [row()], filteredRows: [row()], filters: { query: "" } }),
    adminDbGroupedRows: () => [],
    adminDbCompanyIdFromRoute: () => state.adminDbSelectedCompanyId,
    adminDbMasterHasRows: () => true,
    adminDbViewMode: () => state.adminDbViewMode,
    adminDbMetricCard: () => "", fmtNumber: String, fmtWon: String,
    adminDbCompanySearchShellHtml: () => "", adminDbUserViewBridgeHtml: () => "", adminDbSelectedRow: row,
    adminDbAuditBoard: () => "", adminDbWorkPanel: () => "", adminDbCollectionPanel: () => "",
    adminDbReviewFlashHtml: () => "", bindAdminDbCompanySelectButtons() {}, applyPendingCompanyEdit() {},
    renderAdminRegionAnalysisDashboard() {}, adminDbCompanyExplorerHtml: () => "", adminDbRegionWorkspaceHtml: () => "",
    adminRegionalDatabasePanel: () => "",
    fetchJson: () => new Promise((resolve, reject) => { pending.push({ resolve, reject }); })
  });
  context.adminDbSelectedDetailPanel = () => {
    const companyId = state.adminDbSelectedCompanyId;
    return `<section class="admin-db-selected-panel" data-admin-db-selected-company="${companyId}">${context.adminDbCompanyMaintenanceHtml({
      company: { companyId }, selectedId: companyId, nextAction: { foldKey: recommendations[companyId] },
      profileBody: "profile form", correctionBody: "correction form", channelBody: "channel form", collectBody: "collection evidence", reviewBody: "review form"
    })}</section>`;
  };
  vm.runInContext(`${declarations.join("\n")}\nfunction reviewMenuClick(event) {\n${source.slice(clickStart, clickEnd)}\n}`, context);
  return {
    context, state, dashboard, pending,
    maintenance: () => dashboard.querySelector(".admin-company-maintenance"),
    fold: (key) => dashboard.querySelector(`[data-admin-db-fold="${key}"]`),
    button: (key) => dashboard.querySelector(`[data-admin-db-open-fold="${key}"]`),
    render: () => context.renderAdminDatabaseDashboard(),
    click(key) {
      const button = this.button(key);
      assert.ok(button, `Menu ${key} exists`);
      context.reviewMenuClick({ target: button, preventDefault() {} });
    },
    toggle(element) { context.handleAdminDbReviewToggle({ target: element }); }
  };
}

function assertSelection(item, expectedKey, message) {
  const maintenance = item.maintenance();
  const selected = foldKeys.filter((key) => item.button(key).classList.contains("active"));
  assert.deepEqual(selected, expectedKey ? [expectedKey] : [], `${message}: visual selection`);
  for (const key of foldKeys) {
    assert.equal(item.button(key).getAttribute("aria-pressed"), String(key === expectedKey), `${message}: ${key} accessible selection`);
    assert.equal(item.fold(key).open, key === expectedKey, `${message}: ${key} actual details state`);
  }
  if (expectedKey) assert.ok(maintenance.querySelector(`[data-admin-db-fold="${expectedKey}"]`).open);
}

(async () => {
  const item = fixture();
  item.render();
  assert.equal(item.maintenance().open, false, "Review tools initially stay collapsed");
  assertSelection(item, "channel", "Initial recommendation");

  for (const key of foldKeys) {
    item.click(key);
    assert.equal(item.maintenance().open, true, `Clicking ${key} reveals its tool`);
    assertSelection(item, key, `Click ${key}`);
  }

  // Opening a native details summary must update the same menu as a tab click.
  const profile = item.fold("profile");
  profile.open = true;
  item.toggle(profile);
  assertSelection(item, "profile", "Native details opening");
  profile.open = false;
  item.toggle(profile);
  assertSelection(item, "", "Native active details closing");
  item.render();
  assertSelection(item, "", "An explicitly closed section does not restore the recommendation on rerender");

  item.click("correction");
  const previousMaintenance = item.maintenance();
  const request = item.context.loadAdminDbCompanyDetail("company-a", { force: true });
  assert.notEqual(item.maintenance(), previousMaintenance, "Loading creates fresh maintenance nodes");
  assert.equal(previousMaintenance.isConnected, false, "The previously displayed nodes are discarded");
  assert.equal(item.maintenance().open, true, "Starting detail loading preserves visible tools");
  assertSelection(item, "correction", "Loading rerender");
  item.click("collect");
  item.pending.shift().resolve({ company: { companyId: "company-a", primaryName: "Updated company" } });
  await request;
  assert.equal(item.maintenance().open, true, "Finishing async detail loading preserves visible tools");
  assertSelection(item, "collect", "Async completion preserves the latest choice");
  const currentUi = JSON.stringify(item.state.adminDbReviewUi);
  item.toggle(previousMaintenance);
  assert.equal(JSON.stringify(item.state.adminDbReviewUi), currentUi, "A delayed toggle from discarded DOM cannot overwrite the current choice");

  item.maintenance().open = false;
  item.toggle(item.maintenance());
  item.render();
  assert.equal(item.maintenance().open, false, "An explicit user collapse survives rerendering");
  assertSelection(item, "collect", "Collapsed tools retain their chosen section");

  item.state.adminDbSelectedCompanyId = "company-b";
  item.render();
  assert.equal(item.maintenance().open, false, "A new company starts with collapsed tools");
  assertSelection(item, "review", "Another company uses its own recommendation");
  item.click("profile");
  item.state.adminDbSelectedCompanyId = "company-a";
  item.render();
  assert.equal(item.maintenance().open, false, "Returning to a company restores its own collapse choice");
  assertSelection(item, "collect", "Company UI state does not leak between records");

  item.click("review");
  const outsider = new Element("details", { class: "admin-company-maintenance", "data-admin-db-review-company": "other" });
  const outsiderFold = new Element("details", { class: "admin-db-selected-fold", "data-admin-db-fold": "profile", open: "" }, outsider);
  item.dashboard.children.push(outsider);
  item.click("channel");
  assert.equal(outsiderFold.open, true, "Opening a tool must only close siblings in that company's maintenance section");
  assertSelection(item, "channel", "Scope-specific menu opening");

  const unrelated = new Element("details", { class: "different-disclosure", open: "" });
  const before = JSON.stringify(item.state.adminDbReviewUi);
  item.toggle(unrelated);
  assert.equal(JSON.stringify(item.state.adminDbReviewUi), before, "Unrelated native disclosures cannot alter review UI state");
  console.log("Admin DB review navigation: five menus, visual/accessibility state, native disclosure, async rendering, collapse choice and company isolation passed");
})().catch((error) => { console.error(error); process.exitCode = 1; });
