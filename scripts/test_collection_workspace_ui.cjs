"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname, "../web/collection-workspace.js"), "utf8");

function fixture({ expanded = false, reducedMotion = false } = {}) {
  const calls = [], nodes = new Map();
  const target = id => {
    const value = { id, setAttribute() {}, focus: options => calls.push(["focus", id, options]), scrollIntoView: options => calls.push(["scroll", id, options]) };
    nodes.set(id, value); return value;
  };
  const targets = ["collectionWeeklyMonitor", "collectorRegularHeading", "collectorExecutionHeading", "collectorHistoryTitle"].map(target);
  const regularPanel = { id: "collectionRotationPanel", open: false };
  const workerCards = [{ open: false, hidden: false }, { open: false, hidden: false }, { open: false, hidden: true, retired: true }];
  const root = { contains: value => targets.includes(value) || value === regularPanel, querySelectorAll: selector => selector === ".collector-worker-card" ? workerCards : [] };
  const nav = { contains: button => button.inNav !== false, addEventListener: (name, fn) => { nav.listener = fn; } };
  let open = expanded;
  const toggle = { getAttribute: () => String(open), click: () => { open = !open; calls.push(["disclosure", open]); } };
  nodes.set("collectorControlsCard", root); nodes.set("collectionWorkspaceNav", nav); nodes.set("collectorHistoryToggle", toggle);
  nodes.set("collectionRotationPanel", regularPanel);
  vm.runInNewContext(source, { document: { getElementById: id => nodes.get(id) }, window: { matchMedia: () => ({ matches: reducedMotion }) } });
  const click = (id, extra = {}) => nav.listener({ target: { closest: () => ({ dataset: { collectionWorkspaceTarget: id }, ...extra }) } });
  return { calls, nodes, click, regularPanel, workerCards };
}

test("workspace shortcuts focus existing target nodes without rebuilding them", () => {
  const ui = fixture(), selectedNode = ui.nodes.get("collectionWeeklyMonitor");
  ui.click("collectionWeeklyMonitor"); ui.click("collectorExecutionHeading");
  assert.equal(ui.nodes.get("collectionWeeklyMonitor"), selectedNode);
  assert.deepEqual(ui.calls.map(row => row.slice(0, 2)), [["focus", "collectionWeeklyMonitor"], ["scroll", "collectionWeeklyMonitor"], ["focus", "collectorExecutionHeading"], ["scroll", "collectorExecutionHeading"]]);
});

test("history shortcut opens only a folded history panel and respects reduced motion", () => {
  for (const expanded of [false, true]) {
    const ui = fixture({ expanded, reducedMotion: true });
    ui.click("collectorHistoryTitle"); ui.click("collectorHistoryTitle");
    assert.equal(ui.calls.filter(row => row[0] === "disclosure").length, expanded ? 0 : 1);
    assert.equal(ui.calls.find(row => row[0] === "scroll")[2].behavior, "auto");
  }
});

test("settings shortcuts expand only their requested existing panels and skip hidden retired workers", () => {
  const ui = fixture(), draft = { keywords: "경남글램핑", execution: "schedule" };
  ui.workerCards[0].draft = draft;
  ui.click("collectorRegularHeading");
  assert.equal(ui.regularPanel.open, true); assert.ok(ui.workerCards.every(card => card.open === false));
  ui.regularPanel.open = false;
  ui.click("collectorExecutionHeading");
  assert.equal(ui.regularPanel.open, false);
  assert.deepEqual(ui.workerCards.map(card => card.open), [true, true, false]);
  assert.equal(ui.workerCards[0].draft, draft);
  assert.equal(ui.calls.length, 4, "only focus and scroll accompany disclosure changes");
});

test("unavailable and outside targets do not navigate or invoke application actions", () => {
  const ui = fixture();
  ui.click("missing"); ui.nodes.set("otherPanel", {}); ui.click("otherPanel");
  ui.click("collectionWeeklyMonitor", { inNav: false });
  assert.deepEqual(ui.calls, []);
});

test("regular setup and direct collection shortcuts stay separate and preserve their existing targets", () => {
  const ui = fixture(), regular = ui.nodes.get("collectorRegularHeading"), direct = ui.nodes.get("collectorExecutionHeading");
  const regularDraft = { bookingDays: 21, dailySlots: 6 }, directDraft = { keywords: "경남글램핑", execution: "schedule", repeat: "daily" };
  regular.draft = regularDraft; direct.draft = directDraft;
  ui.click("collectorRegularHeading"); ui.click("collectorExecutionHeading"); ui.click("collectorRegularHeading");
  assert.equal(ui.nodes.get("collectorRegularHeading"), regular); assert.equal(ui.nodes.get("collectorExecutionHeading"), direct);
  assert.equal(regular.draft, regularDraft); assert.equal(direct.draft, directDraft);
  assert.deepEqual(ui.calls.map(row => row.slice(0, 2)), [["focus", regular.id], ["scroll", regular.id], ["focus", direct.id], ["scroll", direct.id], ["focus", regular.id], ["scroll", regular.id]]);
  const html = fs.readFileSync(path.join(__dirname, "../web/index.html"), "utf8"), nav = /<nav[^>]+id="collectionWorkspaceNav"[\s\S]*?<\/nav>/.exec(html)[0];
  assert.equal((nav.match(/<button\b/g) || []).length, 5);
  assert.match(nav, /data-collection-workspace-target="collectorRegularHeading"[\s\S]*?정기수집 설정/);
  assert.match(nav, /data-collection-workspace-target="collectorExecutionHeading"[\s\S]*?직접수집/);
  assert.ok(html.indexOf('id="collectorRegularHeading"') < html.indexOf('id="collectorExecutionHeading"'));
  assert.ok(html.indexOf('id="collectorExecutionHeading"') < html.indexOf('id="collectorWorkerStates"'));
});
