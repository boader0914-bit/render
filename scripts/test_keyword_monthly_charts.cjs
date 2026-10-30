"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createHash } = require("node:crypto");

const root = path.resolve(__dirname, "..");
const adapterSource = fs.readFileSync(path.join(root, "web/keyword-monthly-charts.js"), "utf8");
const vendorDir = path.join(root, "web/vendor/data-charts-1.2.1");
const modulePath = "/vendor/data-charts-1.2.1/data-analytics-plugin/1.2.1/charts/element.js";
const config = type => ({ id: "monthly-test", title: "월별 비교", height: 280, spec: { type }, rows: [{ date: "2026-10-01", value: 1 }] });
const settle = () => new Promise(resolve => setImmediate(resolve));

// This is an explicit module-loading and lifecycle stub. It does not replace
// the official renderer in the application and does not prove plotted pixels.
function fixture({ failLoad = false } = {}) {
  const doc = { documentElement: {} }, observers = [], imports = [];
  class Element {
    constructor() {
      this.ownerDocument = doc;
      this.isConnected = true;
      this.attributes = {};
      this.listeners = new Map();
      this.children = [];
      this.parentNode = null;
    }
    setAttribute(key, value) { this.attributes[key] = String(value); }
    addEventListener(key, listener) {
      if (!this.listeners.has(key)) this.listeners.set(key, new Set());
      this.listeners.get(key).add(listener);
    }
    removeEventListener(key, listener) { this.listeners.get(key)?.delete(listener); }
    emit(type) { for (const listener of this.listeners.get(type) || []) listener({ target: this }); }
    remove() {
      this.isConnected = false;
      if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(child => child !== this);
      this.parentNode = null;
    }
  }
  class MutationObserver {
    constructor(callback) { this.callback = callback; this.closed = false; observers.push(this); }
    observe() {}
    disconnect() { this.closed = true; }
  }
  const component = {
    mountChart(container, value) {
      for (const old of [...container.children]) old.remove();
      const chart = new Element();
      chart.parentNode = container;
      container.children = [chart];
      if (value.spec.type !== "pending") queueMicrotask(() => chart.emit(value.spec.type === "invalid" ? "data-chart-error" : "data-chart-ready"));
      return chart;
    }
  };
  const window = { HTMLElement: Element, MutationObserver, setTimeout, clearTimeout };
  const context = vm.createContext({
    window, TextEncoder,
    __loadPinnedChartModule(url) {
      imports.push(url);
      return failLoad ? Promise.reject(new Error("test-only module load failure")) : Promise.resolve(component);
    }
  });
  const seam = "import(MODULE_PATH)";
  assert.equal(adapterSource.split(seam).length, 2, "The test intercepts exactly the one documented module import.");
  vm.runInContext(adapterSource.replace(seam, "__loadPinnedChartModule(MODULE_PATH)"), context);
  return { api: window.KeywordMonthlyCharts, Element, observers, imports };
}

test("chart adapter resolves on the official ready event, not just element creation", async () => {
  const value = fixture(), container = new value.Element();
  let resolved = false;
  const result = value.api.mount(container, config("pending")).then(chart => { resolved = true; return chart; });
  await settle();
  assert.equal(resolved, false);
  const chart = container.children[0];
  chart.emit("data-chart-ready");
  assert.equal(await result, chart);
  assert.equal(container.attributes["data-data-chart"], "");
  assert.equal(chart.attributes["data-keyword-monthly-chart"], "1.2.1");
  assert.deepEqual(value.imports, [modulePath]);
});

test("chart adapter rejects an official rendering error without manufacturing a ready result", async () => {
  const value = fixture(), container = new value.Element();
  await assert.rejects(value.api.mount(container, config("invalid")), error => error.code === "KEYWORD_MONTHLY_CHART_RENDER_FAILED");
  assert.equal(container.children.length, 1, "The official error element remains available until the caller replaces it.");
});

test("a superseded pending chart aborts and cannot replace the newer chart", async () => {
  const value = fixture(), container = new value.Element();
  const old = value.api.mount(container, config("pending"));
  old.catch(() => {});
  await settle();
  const oldChart = container.children[0];
  const newer = value.api.mount(container, config("line"));
  await assert.rejects(old, error => error.name === "AbortError" && error.code === "KEYWORD_MONTHLY_CHART_SUPERSEDED");
  const chart = await newer;
  assert.notEqual(chart, oldChart);
  assert.equal(oldChart.isConnected, false);
  assert.equal(container.children[0], chart);
  assert.equal(value.imports.length, 1, "The successful pinned module is reused.");
});

test("disconnecting a pending chart aborts its waiter and removes its renderer element", async () => {
  const value = fixture(), container = new value.Element();
  const result = value.api.mount(container, config("pending"));
  result.catch(() => {});
  await settle();
  container.isConnected = false;
  for (const observer of value.observers) if (!observer.closed) observer.callback();
  await assert.rejects(result, error => error.name === "AbortError" && error.code === "KEYWORD_MONTHLY_CHART_DISCONNECTED");
  assert.equal(container.children.length, 0);
  assert.ok(value.observers.every(observer => observer.closed));
});

test("a local module load failure rejects the chart promise", async () => {
  const value = fixture({ failLoad: true });
  await assert.rejects(value.api.mount(new value.Element(), config("line")), error => error.code === "KEYWORD_MONTHLY_CHART_LOAD_FAILED");
  assert.deepEqual(value.imports, [modulePath]);
});

test("invalid chart configuration rejects before loading any module", async () => {
  const value = fixture();
  await assert.rejects(value.api.mount(new value.Element(), { ...config("line"), height: 900 }), error => error.code === "KEYWORD_MONTHLY_CHART_CONFIG_INVALID");
  assert.equal(value.imports.length, 0);
});

test("a new chart container may be connected by the synchronous parent render", async () => {
  const value = fixture(), container = new value.Element();
  container.isConnected = false;
  const result = value.api.mount(container, config("line"));
  container.isConnected = true;
  assert.equal((await result).parentNode, container);
});

test("official vendor bytes and preserved notices match the recorded checksums", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(vendorDir, "manifest.json"), "utf8"));
  assert.equal(manifest.chartApiVersion, 3);
  assert.equal(manifest.buildId, "57515287d6adb6161c9f714f7d7d22497632ea800a917da78d081e531b34b352");
  const expected = {
    "element.js": [12425, "a7fc46ef87c306ed335570bf4bad6d5ec288d0e27b73833aeb61d7156e0255c1"],
    "runtime.js": [946815, "90a2e1b3377cbfc8815c7efef464a0039008561ccf57c72c49224d3a7815eec0"]
  };
  for (const file of manifest.files) {
    const bytes = fs.readFileSync(path.join(vendorDir, file.path));
    assert.equal(bytes.length, file.bytes);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), file.sha256);
    if (expected[path.basename(file.path)]) assert.deepEqual([file.bytes, file.sha256], expected[path.basename(file.path)]);
  }
  assert.deepEqual(manifest.dependencyAudit.runtimeImports, {});
  assert.equal(manifest.dependencyAudit.runtimeFetchCalls, 0);
  assert.equal(manifest.dependencyAudit.runtimeEvalCalls, 0);
  assert.equal(manifest.licenseAudit.noticesCopiedVerbatim, true);
});

test("the actual pinned runtime accepts line gaps and rejects incomplete additive stacks", async () => {
  const source = fs.readFileSync(path.join(vendorDir, "data-analytics-plugin/1.2.1/charts/runtime.js"));
  const runtime = await import(`data:text/javascript;base64,${source.toString("base64")}`);
  const line = {
    id: "line-contract", title: "선택 업체와 전체", height: 280,
    spec: { type: "line", x: "date", y: ["선택 업체", "전체 표본"], yDomain: [0, 1], colors: { "선택 업체": "#70bd9a", "전체 표본": "#b68ade" }, valueFormat: { style: "percent", maximumFractionDigits: 1 } },
    rows: [{ date: "2026-10-01", "선택 업체": 0.2, "전체 표본": 0.3 }, { date: "2026-10-02", "선택 업체": null, "전체 표본": 0.5 }]
  };
  assert.equal(runtime.checkedPayload(line).rows[1]["선택 업체"], null);
  const stack = {
    id: "stack-contract", title: "업체별 예약 추정률", height: 280,
    spec: { type: "horizontalStackedBar", x: ["공개 예약", "타채널 추정"], y: "company", xDomain: [0, 1], colors: { "공개 예약": "#70bd9a", "타채널 추정": "#b68ade" }, valueFormat: { style: "percent", maximumFractionDigits: 1 }, showValues: true },
    rows: [{ company: "확보 업체", "공개 예약": 0.2, "타채널 추정": 0.1 }]
  };
  assert.equal(runtime.checkedPayload(stack).rows.length, 1);
  const unknown = { company: "미확인 업체", "공개 예약": null, "타채널 추정": null };
  assert.throws(() => runtime.checkedPayload({ ...stack, rows: [unknown] }), /stacks and pies require complete numeric observations/);
  assert.throws(() => runtime.checkedPayload({ ...stack, rows: [...stack.rows, unknown] }), /stacks and pies require complete numeric observations/);
});
