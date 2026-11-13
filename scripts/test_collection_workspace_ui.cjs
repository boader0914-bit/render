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
  const targets = ["collectionWeeklyMonitor", "collectorExecutionHeading", "collectorHistoryTitle"].map(target);
  const root = { contains: value => targets.includes(value) };
  const nav = { contains: button => button.inNav !== false, addEventListener: (name, fn) => { nav.listener = fn; } };
  let open = expanded;
  const toggle = { getAttribute: () => String(open), click: () => { open = !open; calls.push(["disclosure", open]); } };
  nodes.set("collectorControlsCard", root); nodes.set("collectionWorkspaceNav", nav); nodes.set("collectorHistoryToggle", toggle);
  vm.runInNewContext(source, { document: { getElementById: id => nodes.get(id) }, window: { matchMedia: () => ({ matches: reducedMotion }) } });
  const click = (id, extra = {}) => nav.listener({ target: { closest: () => ({ dataset: { collectionWorkspaceTarget: id }, ...extra }) } });
  return { calls, nodes, click };
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

test("unavailable and outside targets do not navigate or invoke application actions", () => {
  const ui = fixture();
  ui.click("missing"); ui.nodes.set("otherPanel", {}); ui.click("otherPanel");
  ui.click("collectionWeeklyMonitor", { inNav: false });
  assert.deepEqual(ui.calls, []);
});
