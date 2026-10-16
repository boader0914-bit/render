"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

// Execute the actual summary coordinator, holding saved-data responses in memory.
// No web server, external provider, crawler, credential, or captured live data is used.
const source = fs.readFileSync(path.join(__dirname, "../web/app.js"), "utf8").replace(/\r\n/g, "\n");
function declaration(name) {
  const found = source.match(new RegExp(`^(?:async )?function ${name}\\([^]*?^}`, "m"))?.[0];
  assert.ok(found, `Missing actual function ${name}`);
  return found;
}
const functionNames = ["companyMasterReadIsCurrent", "loadCompanyMasterSummary", "renderCompanyMasterPriorityView"];

function deferred() {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
async function flush() { await new Promise(resolve => setImmediate(resolve)); }
function master(label = "new", count = 2) {
  return { marker: label, totalCompanies: count, updatedAt: label,
    companies: Array.from({ length: count }, (_, index) => ({ companyId: `company-${index}`, primaryName: `${label}-${index}` })) };
}

function fixture({ initial = null, tab = "admin", section = "overview", role = "admin", customerView = false } = {}) {
  const state = {
    session: { authenticated: true, role, username: "priority-fixture" }, adminUserViewMode: customerView,
    activeTab: tab, adminPanelSection: section, companyMaster: initial, crawlEtaByKey: { previous: { seconds: 15 } },
    companyMasterSummaryRead: null, companyMasterBootstrapSummary: null, adminViewsDeferred: false
  };
  const requests = [], calls = [], hooks = {}, scheduled = [];
  const record = name => calls.push({ name, master: state.companyMaster, tab: state.activeTab, section: state.adminPanelSection });
  const context = {
    state, console, Promise, Array, Number, Date, Object, Map, Set,
    isAdminRole: () => state.session?.role === "admin" && !state.adminUserViewMode,
    fetchJson: async url => {
      assert.equal(url, "/api/company-master/bootstrap", "priority preparation only reads saved company data");
      requests.push(url);
      return hooks.fetch ? hooks.fetch(url) : master();
    },
    loadRecrawlEtaEstimates: async value => { calls.push({ name: "eta", master: value }); return hooks.eta?.(value); },
    scheduleCompanyMasterEta: value => { scheduled.push(value); record("eta-scheduled"); },
    renderAdminStartupReadiness() {}, // The real metadata-only DOM sync has its own startup-label tests.
    renderAdminConsoleDashboard: () => record("home"),
    renderAdminDatabaseDashboard: () => record("database"),
    adminConsoleMasterSource: () => state.companyMaster || {},
    isAdminHomeOverview: () => context.isAdminRole() && state.activeTab === "admin" && state.adminPanelSection === "overview",
    isAdminDatabaseView: () => context.isAdminRole() && state.activeTab === "admin" && state.adminPanelSection === "database",
    window: { setTimeout: callback => { calls.push({ name: "timer", callback }); return calls.length; } }
  };
  vm.createContext(context);
  const api = vm.runInContext(functionNames.map(declaration).join("\n") + `\n({${functionNames.join(",")}})`, context);
  return { state, requests, calls, hooks, scheduled, context, api };
}

test("simultaneous bootstrap consumers share a single saved company summary GET", async () => {
  const f = fixture(), gate = deferred(), value = master();
  f.hooks.fetch = () => gate.promise;
  const first = f.api.loadCompanyMasterSummary({ bootstrap: true });
  const second = f.api.loadCompanyMasterSummary({ bootstrap: true });
  await flush();
  assert.equal(f.requests.length, 1);
  gate.resolve(value);
  const results = await Promise.all([first, second]);
  assert.ok(results.every(result => result === true));
  assert.equal(f.state.companyMaster, value);
  assert.equal(f.calls.filter(call => call.name === "eta").length, 0, "bootstrap does not await or directly compute ETA");
});

test("a priority consumer joining a direct-route GET still paints DB once without waiting for its ETA", async () => {
  const f = fixture({ section: "database" }), response = deferred(), eta = deferred();
  f.hooks.fetch = () => response.promise; f.hooks.eta = () => eta.promise;
  const route = f.api.loadCompanyMasterSummary();
  const priority = f.api.loadCompanyMasterSummary({ bootstrap: true });
  response.resolve(master("shared-route"));
  assert.equal(await priority, true);
  assert.equal(f.requests.length, 1);
  assert.equal(f.calls.filter(call => call.name === "database").length, 1);
  eta.resolve(); await route;
});

test("an explicit newer refresh supersedes an older GET even before either response is applied", async () => {
  const f = fixture(), old = deferred(), recent = deferred();
  f.hooks.fetch = () => f.requests.length === 1 ? old.promise : recent.promise;
  const stale = f.api.loadCompanyMasterSummary({ bootstrap: true });
  const fresh = f.api.loadCompanyMasterSummary({ force: true });
  old.resolve(master("older"));
  assert.equal(await stale, false);
  assert.equal(f.state.companyMaster, null);
  recent.resolve(master("current"));
  assert.equal(await fresh, true);
  assert.equal(f.state.companyMaster.marker, "current");
});

test("successful bootstrap data is reused by the later run bootstrap without a second GET", async () => {
  const f = fixture();
  assert.equal(await f.api.loadCompanyMasterSummary({ bootstrap: true }), true);
  const saved = f.state.companyMaster;
  assert.equal(await f.api.loadCompanyMasterSummary({ bootstrap: true }), true);
  assert.equal(f.requests.length, 1);
  assert.equal(f.state.companyMaster, saved);
});

test("bootstrap publishes a visible DB before delayed ETA work can finish", async () => {
  const f = fixture({ section: "database" }), eta = deferred();
  f.hooks.eta = () => eta.promise;
  const result = await f.api.loadCompanyMasterSummary({ bootstrap: true });
  assert.equal(result, true);
  assert.equal(f.calls.filter(call => call.name === "database").length, 1);
  assert.equal(f.calls.filter(call => call.name === "home").length, 0);
  assert.equal(f.calls.filter(call => call.name === "eta").length, 0);
  assert.equal(f.scheduled.length, 1);
  assert.equal(f.scheduled[0], f.state.companyMaster);
  eta.resolve();
});

test("ordinary refresh still awaits ETA and does not reuse a completed bootstrap GET", async () => {
  const f = fixture(), eta = deferred();
  await f.api.loadCompanyMasterSummary({ bootstrap: true });
  f.hooks.eta = () => eta.promise;
  let finished = false;
  const refresh = f.api.loadCompanyMasterSummary().then(value => { finished = true; return value; });
  await flush();
  assert.equal(f.requests.length, 2);
  assert.equal(finished, false);
  assert.equal(f.calls.filter(call => call.name === "eta").length, 1);
  eta.resolve();
  assert.equal(await refresh, true);
});

test("a valid zero-company summary is successful and reusable rather than missing", async () => {
  const f = fixture(), value = master("empty", 0);
  f.hooks.fetch = async () => value;
  assert.equal(await f.api.loadCompanyMasterSummary({ bootstrap: true }), true);
  assert.equal(f.state.companyMaster, value);
  assert.equal(await f.api.loadCompanyMasterSummary({ bootstrap: true }), true);
  assert.equal(f.requests.length, 1);
  assert.equal(f.state.companyMaster.totalCompanies, 0);
  assert.equal(f.state.companyMaster.error, undefined);
});

test("first summary failure remains an error and can be retried rather than cached as zero", async () => {
  const f = fixture();
  f.hooks.fetch = async () => { throw new Error("saved summary unavailable"); };
  assert.equal(await f.api.loadCompanyMasterSummary({ bootstrap: true }), false);
  assert.match(f.state.companyMaster.error, /saved summary unavailable/);
  f.hooks.fetch = async () => master("retry");
  assert.equal(await f.api.loadCompanyMasterSummary({ bootstrap: true }), true);
  assert.equal(f.requests.length, 2);
  assert.equal(f.state.companyMaster.marker, "retry");
});

test("preserveOnError retains the last known company master", async () => {
  const original = master("known"), f = fixture({ initial: original });
  f.hooks.fetch = async () => { throw new Error("temporary unavailable"); };
  assert.equal(await f.api.loadCompanyMasterSummary({ bootstrap: true, preserveOnError: true }), false);
  assert.equal(f.state.companyMaster, original);
});

test("a late summary cannot replace a newer administrator correction", async () => {
  const f = fixture({ initial: master("old") }), gate = deferred(), fresh = master("manual-correction");
  f.hooks.fetch = () => gate.promise;
  const pending = f.api.loadCompanyMasterSummary({ bootstrap: true });
  await flush();
  f.state.companyMaster = fresh;
  gate.resolve(master("late"));
  assert.equal(await pending, false);
  assert.equal(f.state.companyMaster, fresh);
  assert.equal(f.scheduled.length, 0);
});

test("a late failure cannot replace a newer correction with an error", async () => {
  const f = fixture({ initial: master("old") }), gate = deferred(), fresh = master("manual-review");
  f.hooks.fetch = () => gate.promise;
  const pending = f.api.loadCompanyMasterSummary({ bootstrap: true });
  await flush();
  f.state.companyMaster = fresh;
  gate.reject(new Error("late failure"));
  assert.equal(await pending, false);
  assert.equal(f.state.companyMaster, fresh);
});

test("a direct company detail merge into the same master invalidates an older summary", async () => {
  const original = master("old"), f = fixture({ initial: original }), gate = deferred();
  f.hooks.fetch = () => gate.promise;
  const pending = f.api.loadCompanyMasterSummary({ bootstrap: true });
  await flush();
  const detailed = { ...original.companies[0], primaryName: "verified detail", manualCorrection: { lodgingBasisTotal: 16 } };
  original.companies[0] = detailed;
  gate.resolve(master("late"));
  assert.equal(await pending, false);
  assert.equal(f.state.companyMaster, original);
  assert.equal(f.state.companyMaster.companies[0], detailed);
  assert.equal(f.scheduled.length, 0);
});

test("a changed session cannot publish an older summary even if the new session is also admin", async () => {
  const f = fixture(), gate = deferred(), value = master("old-session");
  f.hooks.fetch = () => gate.promise;
  const pending = f.api.loadCompanyMasterSummary({ bootstrap: true });
  await flush();
  f.state.session = { ...f.state.session, sessionCreatedAt: "new session" };
  gate.resolve(value);
  assert.equal(await pending, false);
  assert.notEqual(f.state.companyMaster, value);
  assert.equal(f.calls.filter(call => ["home", "database"].includes(call.name)).length, 0);
});

test("role and customer-view changes reject late administrator responses", async () => {
  for (const change of [state => { state.session.role = "b2b"; }, state => { state.adminUserViewMode = true; }]) {
    const f = fixture(), gate = deferred(), value = master("private-admin");
    f.hooks.fetch = () => gate.promise;
    const pending = f.api.loadCompanyMasterSummary({ bootstrap: true });
    await flush();
    change(f.state);
    gate.resolve(value);
    assert.equal(await pending, false);
    assert.notEqual(f.state.companyMaster, value);
    assert.equal(f.scheduled.length, 0);
  }
});

test("each shared-request consumer keeps its own isCurrent guard", async () => {
  const f = fixture(), gate = deferred();
  let current = true;
  f.hooks.fetch = () => gate.promise;
  const stale = f.api.loadCompanyMasterSummary({ bootstrap: true, isCurrent: () => current });
  const valid = f.api.loadCompanyMasterSummary({ bootstrap: true });
  await flush();
  current = false;
  const value = master("valid-consumer");
  gate.resolve(value);
  assert.equal(await stale, false);
  assert.equal(await valid, true);
  assert.equal(f.requests.length, 1);
  assert.equal(f.state.companyMaster, value);
});

test("a cancelled caller never publishes its data when there is no valid consumer", async () => {
  const original = master("previous"), f = fixture({ initial: original }), gate = deferred();
  let current = true;
  f.hooks.fetch = () => gate.promise;
  const pending = f.api.loadCompanyMasterSummary({ bootstrap: true, isCurrent: () => current });
  await flush();
  current = false;
  gate.resolve(master("cancelled"));
  assert.equal(await pending, false);
  assert.equal(f.state.companyMaster, original);
  assert.equal(f.scheduled.length, 0);
});

test("priority rendering touches only the currently visible home or DB", () => {
  for (const section of ["overview", "database", "members", "collect"]) {
    const f = fixture({ initial: master(), section });
    f.api.renderCompanyMasterPriorityView();
    const names = f.calls.filter(call => ["home", "database"].includes(call.name)).map(call => call.name);
    assert.deepEqual(names, section === "overview" ? ["home"] : section === "database" ? ["database"] : []);
    if (!["overview", "database"].includes(section)) assert.equal(f.state.adminViewsDeferred, true);
  }
  for (const tab of ["monthlyReports", "demand", "industryHome"]) {
    const f = fixture({ initial: master(), tab });
    f.api.renderCompanyMasterPriorityView();
    assert.equal(f.calls.length, 0);
    assert.equal(f.state.adminViewsDeferred, true);
  }
});

test("priority rendering does not expose administrator views to B2B or customer preview", () => {
  for (const options of [{ role: "b2b" }, { customerView: true }]) {
    const f = fixture({ initial: master(), ...options });
    f.api.renderCompanyMasterPriorityView();
    assert.equal(f.calls.length, 0);
  }
});

test("an unauthenticated administrator-shaped session cannot start a saved company read", async () => {
  const f = fixture(); f.state.session.authenticated = false;
  assert.equal(await f.api.loadCompanyMasterSummary({ bootstrap: true }), false);
  assert.equal(f.requests.length, 0);
});

function etaFixture() {
  const state = { session: { authenticated: true, role: "admin" }, companyMaster: master("saved"),
    data: { run: { id: "saved-run" } }, activeTab: "admin", adminPanelSection: "overview", companyMasterEtaScheduled: null,
    crawlEtaReadSequence: 0, crawlEtaByKey: { preserved: { seconds: 15 } } };
  const paint = deferred(), requests = [], hooks = {}, calls = [];
  const context = {
    state, Promise, Array, Map, console,
    isAdminRole: () => state.session?.role === "admin",
    waitForCompanyMasterPaint: () => { calls.push("paint"); return paint.promise; },
    companyDecisionQueueEntries: () => [{ plan: { keyword: "saved-keyword" } }],
    recrawlAutomationProfile: entries => hooks.profile ? hooks.profile(entries) : { needsExecution: entries },
    crawlEstimatePayloadFromPlan: plan => ({ keyword: plan.keyword }),
    crawlEtaKey: payload => payload.keyword,
    renderDecisionQueue: () => calls.push("decision-render"),
    renderAdminDatabaseDashboard: () => calls.push("database-render"),
    renderCompanyMasterPanel: () => calls.push("legacy-render"),
    fetchJson: async (url, options) => {
      assert.equal(url, "/api/crawl-estimate", "ETA preparation must not start a collection");
      assert.equal(options.method, "POST");
      requests.push({ url, payload: JSON.parse(options.body) });
      return hooks.fetch ? hooks.fetch() : { items: [{ clientKey: "saved-keyword", estimate: { seconds: 25 } }] };
    }
  };
  vm.createContext(context);
  const names = ["companyMasterReadIsCurrent", "scheduleCompanyMasterEta", "loadRecrawlEtaEstimates"];
  const api = vm.runInContext(names.map(declaration).join("\n") + `\n({${names.join(",")}})`, context);
  return { state, paint, requests, hooks, calls, context, api };
}

test("actual ETA scheduler waits for the company display and coalesces the same master", async () => {
  const f = etaFixture();
  f.api.scheduleCompanyMasterEta(f.state.companyMaster);
  f.api.scheduleCompanyMasterEta(f.state.companyMaster);
  assert.equal(f.calls.length, 1);
  assert.equal(f.requests.length, 0);
  f.paint.resolve();
  await flush();
  assert.equal(f.requests.length, 1);
  assert.equal(f.state.crawlEtaByKey["saved-keyword"].seconds, 25);
});

test("completed background ETA refreshes only a currently visible estimate view", async () => {
  for (const [section, view, expected] of [["overview", "list", ""], ["database", "list", ""], ["database", "review", "database-render"], ["collect", "list", "legacy-render"]]) {
    const f = etaFixture(); f.state.adminPanelSection = section; f.state.adminDbViewMode = view;
    f.api.scheduleCompanyMasterEta(f.state.companyMaster); f.paint.resolve(); await flush();
    assert.deepEqual(f.calls.filter(name => name.endsWith("-render")), expected ? [expected] : []);
  }
});

test("a changed result during ETA preparation never publishes the previous result's estimates", async () => {
  const f = etaFixture(), gate = deferred(), known = f.state.crawlEtaByKey;
  f.hooks.fetch = () => gate.promise;
  const pending = f.api.loadRecrawlEtaEstimates(f.state.companyMaster);
  f.state.data = { run: { id: "new-selection" } };
  gate.resolve({ items: [{ clientKey: "saved-keyword", estimate: { seconds: 1 } }] });
  await pending;
  assert.equal(f.state.crawlEtaByKey, known);
});

test("actual ETA scheduler drops work when a newer master supersedes the pending display", async () => {
  const f = etaFixture();
  f.api.scheduleCompanyMasterEta(f.state.companyMaster);
  f.state.companyMaster = master("newer");
  f.api.scheduleCompanyMasterEta(f.state.companyMaster);
  f.paint.resolve();
  await flush();
  assert.equal(f.requests.length, 1, "only the current master reaches the ETA endpoint");
});

test("actual ETA scheduler does no work after navigation to monthly reports", async () => {
  const f = etaFixture();
  f.api.scheduleCompanyMasterEta(f.state.companyMaster);
  f.state.activeTab = "monthlyReports";
  f.paint.resolve();
  await flush();
  assert.equal(f.requests.length, 0);
});

test("actual ETA scheduler skips an initial summary until a saved run is available", async () => {
  const f = etaFixture();
  f.state.data = null;
  f.api.scheduleCompanyMasterEta(f.state.companyMaster);
  f.paint.resolve();
  await flush();
  assert.equal(f.requests.length, 0);
});

test("a late ETA result cannot overwrite estimates for a newer company master", async () => {
  const f = etaFixture(), gate = deferred();
  f.hooks.fetch = () => gate.promise;
  const pending = f.api.loadRecrawlEtaEstimates(f.state.companyMaster);
  await flush();
  f.state.companyMaster = master("newer");
  const newestEta = { latest: { seconds: 99 } };
  f.state.crawlEtaByKey = newestEta;
  gate.resolve({ items: [{ clientKey: "saved-keyword", estimate: { seconds: 1 } }] });
  await pending;
  assert.equal(f.state.crawlEtaByKey, newestEta);
});

test("the newest ETA request wins when two responses finish out of order", async () => {
  const f = etaFixture(), first = deferred(), second = deferred();
  let count = 0;
  f.hooks.fetch = () => ++count === 1 ? first.promise : second.promise;
  const pendingFirst = f.api.loadRecrawlEtaEstimates(f.state.companyMaster);
  const pendingSecond = f.api.loadRecrawlEtaEstimates(f.state.companyMaster);
  second.resolve({ items: [{ clientKey: "saved-keyword", estimate: { seconds: 22 } }] });
  await pendingSecond;
  const newestEta = f.state.crawlEtaByKey;
  first.resolve({ items: [{ clientKey: "saved-keyword", estimate: { seconds: 11 } }] });
  await pendingFirst;
  assert.equal(f.state.crawlEtaByKey, newestEta);
  assert.equal(f.state.crawlEtaByKey["saved-keyword"].seconds, 22);
});

test("a late ETA failure does not clear estimates from a newer successful request", async () => {
  const f = etaFixture(), first = deferred(), second = deferred();
  let count = 0;
  f.hooks.fetch = () => ++count === 1 ? first.promise : second.promise;
  const pendingFirst = f.api.loadRecrawlEtaEstimates(f.state.companyMaster);
  const pendingSecond = f.api.loadRecrawlEtaEstimates(f.state.companyMaster);
  second.resolve({ items: [{ clientKey: "saved-keyword", estimate: { seconds: 22 } }] });
  await pendingSecond;
  const newestEta = f.state.crawlEtaByKey;
  first.reject(new Error("old ETA unavailable"));
  await pendingFirst;
  assert.equal(f.state.crawlEtaByKey, newestEta);
});

test("a detail merge or role change during an ETA request discards the old response", async () => {
  for (const change of [state => { state.companyMaster.companies[0] = { ...state.companyMaster.companies[0], verified: true }; },
    state => { state.session.role = "b2b"; }]) {
    const f = etaFixture(), gate = deferred(), originalEta = f.state.crawlEtaByKey;
    f.hooks.fetch = () => gate.promise;
    const pending = f.api.loadRecrawlEtaEstimates(f.state.companyMaster);
    await flush();
    change(f.state);
    gate.resolve({ items: [{ clientKey: "saved-keyword", estimate: { seconds: 1 } }] });
    await pending;
    assert.equal(f.state.crawlEtaByKey, originalEta);
  }
});
