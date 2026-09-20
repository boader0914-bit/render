"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "../web/app.js"), "utf8");
const names = [
  "escapeHtml", "adminDbCompanyHash", "adminDbCompanyDetailUrl", "adminDbCompanyIdFromRoute",
  "adminDbCompanyIdFromHash", "setAdminDbCompanyRoute", "adminDbCompanyUseNativeLink",
  "companyEditShortcutId", "companyEditShortcutUrl", "companyEditShortcutHtml",
  "renderSheetCompanyEditShortcut", "openCompanyEditorFromShortcut", "applyPendingCompanyEdit"
];
const declarations = names.map((name) => {
  const declaration = source.match(new RegExp(`^(?:async )?function ${name}\\([^]*?^}`, "m"))?.[0];
  assert.ok(declaration, name);
  return declaration;
});

function fixture() {
  let url = new URL("https://example.invalid/admin?adminCompany=old#admin-db-company=old");
  const trace = [];
  const panels = ["old", "target"].map((companyId) => {
    const maintenance = { open: false };
    const folds = ["profile", "correction"].map((key) => ({
      key, open: false, isConnected: true,
      input: {
        focus: () => trace.push(`focus:${companyId}:${key}`),
        scrollIntoView: (options) => {
          assert.equal(options.behavior, "auto", "The input must be revealed without a competing smooth-scroll animation");
          assert.equal(options.block, "center");
          trace.push(`scroll-input:${companyId}:${key}`);
        }
      },
      closest: () => maintenance,
      scrollIntoView: () => trace.push(`scroll:${companyId}:${key}`),
      querySelector() { return this.input; }
    }));
    return {
      dataset: { adminDbSelectedCompany: companyId }, maintenance, folds,
      querySelector: (selector) => folds.find((fold) => selector.includes(`="${fold.key}"`)),
      querySelectorAll: () => folds
    };
  });
  const state = {
    role: "admin", activeTab: "rank", adminPanelSection: "collect", adminDbSelectedCompanyId: "old",
    adminDbCompanyDetails: { target: { company: { companyId: "target" } } },
    adminDbCompanyDetailLoading: {}
  };
  const context = vm.createContext({
    state, URLSearchParams, trace, panels,
    master: { companies: [{ companyId: "old", primaryName: "동명 숙소" }, { companyId: "target", primaryName: "동명 숙소" }] },
    isAdminRole: () => state.role === "admin",
    window: {
      get location() { return url; },
      history: {
        pushState(_state, _title, next) { url = new URL(next, url); trace.push("route"); },
        replaceState(_state, _title, next) { url = new URL(next, url); trace.push("replace"); }
      },
      requestAnimationFrame: (callback) => callback()
    },
    document: { querySelectorAll: () => panels },
    closeSheet: () => trace.push("closeSheet"),
    setStatus: (message) => trace.push(`status:${message}`),
    setActiveTab(tab, options) {
      state.activeTab = tab;
      trace.push(`tab:${tab}`);
      assert.equal(options.pushHistory, false);
      state.adminDbSelectedCompanyId = context.adminDbCompanyIdFromRoute();
      context.applyPendingCompanyEdit();
    },
    setAdminPanelSection(section) { state.adminPanelSection = section; trace.push(`section:${section}`); }
  });
  context.companyMasterSource = () => context.master;
  context.loadCompanyMasterSummary = async () => { trace.push("loadMaster"); if (context.refreshedMaster) context.master = context.refreshedMaster; };
  context.activateAdminDbCompanyDetail = (companyId, options) => {
    assert.equal(context.adminDbCompanyIdFromRoute(), companyId, "Destination URL must be set before rendering");
    assert.equal(options.updateRoute, false);
    assert.equal(options.preserveScroll, false, "Edit navigation must opt out of inline-search viewport restoration");
    state.adminDbSelectedCompanyId = companyId;
    trace.push(`activate:${companyId}`);
    panels.forEach((panel) => { panel.maintenance.open = false; panel.folds.forEach((fold) => { fold.open = false; }); });
    context.applyPendingCompanyEdit();
  };
  vm.runInContext(declarations.join("\n"), context);
  return context;
}

function activationFixture() {
  const declaration = source.match(/^function activateAdminDbCompanyDetail\([^]*?^}/m)?.[0];
  assert.ok(declaration, "Real company detail activation function");
  const restores = [];
  const opens = [];
  let resolveDetail;
  const detailRequest = new Promise((resolve) => { resolveDetail = resolve; });
  const context = vm.createContext({
    state: { adminDbInlineSearchScroll: { left: 12, top: 640 } },
    window: { scrollX: 0, scrollY: 0 },
    openAdminDbCompanyReview(companyId, options) { opens.push({ companyId, ...options }); return true; },
    setAdminDbCompanyRoute() {},
    loadAdminDbCompanyDetail: () => detailRequest,
    restoreAdminDbInlineSearchViewport(position, options) { restores.push({ ...position, clear: options?.clear }); }
  });
  vm.runInContext(declaration, context);
  return {
    context, restores, opens,
    async finishLoading() {
      resolveDetail({ company: { companyId: "target" } });
      await detailRequest;
      await Promise.resolve();
    }
  };
}

function hashRouteFixture({ activeTab = "admin", section = "overview", editing = true, role = "admin" } = {}) {
  const declaration = source.match(/^function handleAdminDbCompanyHash\([^]*?^}/m)?.[0];
  assert.ok(declaration, "Real company route handler");
  const trace = [];
  const state = { activeTab, adminPanelSection: section, adminDbViewMode: "review", adminDbSelectedCompanyId: "target" };
  const context = vm.createContext({
    state, URLSearchParams,
    window: { location: { search: `?adminCompany=target${editing ? "&adminEdit=correction" : ""}` } },
    adminDbCompanyIdFromRoute: () => "target",
    isAdminRole: () => role === "admin",
    setActiveTab(tab) {
      if (editing) assert.equal(state.adminDbEditNavigating, true, "Suppress editor focus during the tab transition");
      state.activeTab = tab;
      trace.push(`tab:${tab}`);
    },
    setAdminPanelSection(next) {
      if (editing) assert.equal(state.adminDbEditNavigating, true, "Suppress editor focus during the section transition");
      state.adminPanelSection = next;
      trace.push(`section:${next}`);
    },
    openAdminDbCompanyReview(companyId, options) {
      assert.notEqual(state.adminDbEditNavigating, true, "Release the transition guard before opening the requested editor");
      trace.push(`open:${companyId}:${options.scroll}`);
    }
  });
  vm.runInContext(declaration, context);
  return { context, state, trace };
}

(async () => {
  const editActivation = activationFixture();
  assert.equal(editActivation.context.activateAdminDbCompanyDetail("target", { scroll: false, preserveScroll: false }), true);
  assert.equal(editActivation.opens[0].scroll, false, "Edit navigation also suppresses the generic panel scroll");
  assert.equal(editActivation.restores.length, 0, "No immediate viewport restoration may undo the editor scroll");
  await editActivation.finishLoading();
  assert.equal(editActivation.restores.length, 0, "Detail completion must not restore the previous viewport for edit navigation");

  const searchActivation = activationFixture();
  assert.equal(searchActivation.context.activateAdminDbCompanyDetail("target", { scroll: false }), true);
  assert.equal(searchActivation.restores.length, 1, "Existing inline-search navigation keeps its immediate viewport restoration");
  assert.equal(searchActivation.restores[0].top, 640);
  assert.equal(searchActivation.restores[0].left, 12);
  assert.equal(searchActivation.restores[0].clear, false);
  await searchActivation.finishLoading();
  assert.equal(searchActivation.restores.length, 2, "Existing inline-search navigation restores again when detail loading completes");
  assert.equal(searchActivation.restores[1].top, 640);
  assert.equal(searchActivation.restores[1].left, 12);

  const hiddenSelected = hashRouteFixture();
  assert.equal(hiddenSelected.context.handleAdminDbCompanyHash(), true);
  assert.equal(hiddenSelected.state.adminPanelSection, "database", "A pre-rendered hidden DB selection must not leave a native edit URL on the home section");
  assert(hiddenSelected.trace.includes("open:target:false"), "Edit routes leave the final scroll to the specific editor");

  const otherTab = hashRouteFixture({ activeTab: "rank", section: "database" });
  otherTab.context.handleAdminDbCompanyHash();
  assert.deepEqual(otherTab.trace, ["tab:admin", "section:database", "open:target:false"], "A hidden selected company still needs its visible admin tab");

  const visibleSelected = hashRouteFixture({ section: "database" });
  assert.equal(visibleSelected.context.handleAdminDbCompanyHash(), true);
  assert.equal(visibleSelected.trace.length, 0, "An already visible exact company must not reopen or steal focus");

  const ordinaryRoute = hashRouteFixture({ editing: false });
  ordinaryRoute.context.handleAdminDbCompanyHash();
  assert(ordinaryRoute.trace.includes("open:target:true"), "Ordinary company links retain the existing panel scroll");
  const forbiddenRoute = hashRouteFixture({ role: "b2b" });
  assert.equal(forbiddenRoute.context.handleAdminDbCompanyHash(), false);
  assert.equal(forbiddenRoute.trace.length, 0);

  const context = fixture();
  assert.equal(context.companyEditShortcutId({ name: "동명 숙소" }), "", "Names must never select an editable record");
  assert.equal(context.companyEditShortcutId({ companyProfile: { companyId: "target" } }), "target");
  assert.equal(context.companyEditShortcutId({ companyId: "old", companyProfile: { companyId: "target" } }), "", "Conflicting IDs must not pick either record");
  context.state.data = {ranking:{items:[{placeId:"1975818551",companyId:"target",companyProfile:{companyId:"target"}}]}};
  assert.equal(context.companyEditShortcutId({placeId:"1975818551"}),"target","Availability rows without master metadata must use the exact ranking Place ID");
  assert.equal(context.companyEditShortcutId({placeId:"different",name:"동명 숙소"}),"","Other Place IDs must not match");
  context.state.data.ranking.items.push({placeId:"1975818551",companyId:"old"});
  assert.equal(context.companyEditShortcutId({placeId:"1975818551"}),"","Ambiguous master mappings must not open an editor");
  context.state.data = null;
  const link = context.companyEditShortcutHtml({ companyId: "target", name: '<숙소 "이름">' });
  assert(link.includes("adminEdit=correction"));
  assert(link.includes("&lt;숙소 &quot;이름&quot;&gt; 수정"));
  assert.equal(context.adminDbCompanyUseNativeLink({ ctrlKey: true }, { tagName: "A" }), true, "Keep native new-tab interaction");

  assert.equal(await context.openCompanyEditorFromShortcut("target"), true);
  assert(context.trace.indexOf("closeSheet") < context.trace.indexOf("tab:admin"));
  assert.equal(context.panels[0].maintenance.open, false, "Never open another company's editor");
  assert.equal(context.panels[1].maintenance.open, true);
  assert.equal(context.panels[1].folds[1].open, true);
  assert(context.trace.includes("focus:target:correction"));
  assert(context.trace.includes("scroll-input:target:correction"), "Reveal the input itself even when the editor summary is much higher on the page");
  assert.equal(context.applyPendingCompanyEdit(), false, "Later redraws must not steal focus or reopen tools");

  const handledFold = context.panels[1].folds[1];
  handledFold.open = false;
  context.panels[1].maintenance.open = false;
  assert.equal(context.applyPendingCompanyEdit(), false, "Respect a user's collapse of the same rendered editor");
  assert.equal(handledFold.open, false);
  assert.equal(context.panels[1].maintenance.open, false);

  handledFold.isConnected = false;
  context.panels[1] = fixture().panels[1];
  const replacementFold = context.panels[1].folds[1];
  assert.notEqual(replacementFold, handledFold);
  assert.equal(context.applyPendingCompanyEdit(), true, "Initialization that replaces the DB DOM must reopen the requested editor in the new panel");
  assert.equal(context.panels[1].maintenance.open, true);
  assert.equal(replacementFold.open, true);
  assert.equal(context.state.adminDbHandledEditElement, replacementFold);
  assert.equal(context.applyPendingCompanyEdit(), false, "Only the replacement DOM's first application should open and focus");

  const alreadyInDatabase = fixture();
  Object.assign(alreadyInDatabase.state, { activeTab: "admin", adminPanelSection: "database" });
  await alreadyInDatabase.openCompanyEditorFromShortcut("target");
  assert.equal(alreadyInDatabase.panels[1].folds[1].open, true, "Intermediate navigation renders must not consume the pending edit action");

  const loading = fixture();
  loading.state.adminDbCompanyDetailLoading.target = true;
  assert.equal(await loading.openCompanyEditorFromShortcut("target", "profile"), true);
  assert.equal(loading.panels[1].maintenance.open, false, "Wait for the exact company's details");
  loading.state.adminDbCompanyDetailLoading.target = false;
  assert.equal(loading.applyPendingCompanyEdit(), true);
  assert.equal(loading.panels[1].folds[0].open, true);

  const unresolved = fixture();
  unresolved.master = { companies: [{ companyId: "old", primaryName: "동명 숙소" }] };
  assert.equal(await unresolved.openCompanyEditorFromShortcut("target"), false);
  assert(unresolved.trace.includes("loadMaster"));
  assert(!unresolved.trace.includes("closeSheet"), "Keep the current detail open if an exact master ID cannot be found");
  assert.equal(unresolved.state.adminDbSelectedCompanyId, "old");

  const mismatch = fixture();
  mismatch.state.adminDbCompanyDetails.target = { company: { companyId: "old" } };
  await mismatch.openCompanyEditorFromShortcut("target");
  assert.equal(mismatch.panels[1].maintenance.open, false, "A mismatched API result must not expose an editor");

  const nativeRoute = fixture();
  nativeRoute.window.history.replaceState(null, "", nativeRoute.companyEditShortcutUrl("target", "profile"));
  Object.assign(nativeRoute.state, { activeTab: "admin", adminPanelSection: "database", adminDbSelectedCompanyId: "target" });
  assert.equal(nativeRoute.applyPendingCompanyEdit(), true, "A fresh native link opens the requested tool after data loads");

  const b2b = fixture();
  b2b.state.role = "b2b";
  assert.equal(b2b.companyEditShortcutHtml({ companyId: "target" }), "");
  assert.equal(await b2b.openCompanyEditorFromShortcut("target"), false);
  assert.equal(b2b.trace.length, 0, "B2B navigation must cause no loads or route changes");

  let slot = null;
  context.document.createElement = () => ({ setAttribute() {}, innerHTML: "", hidden: false });
  context.els = { detailSheet: { querySelector: () => slot }, sheetSubtitle: { insertAdjacentElement: (_position, element) => { slot = element; } } };
  context.renderSheetCompanyEditShortcut({ companyId: "target" });
  assert(slot.innerHTML.includes("업체 정보 수정"));
  context.state.role = "b2b";
  context.renderSheetCompanyEditShortcut({ companyId: "target" });
  assert.equal(slot.hidden, true, "The shared detail header removes admin actions when the role changes");
  const renderSheet = source.match(/^function renderSheet\([^]*?^}/m)?.[0] || "";
  assert(renderSheet.includes("renderSheetCompanyEditShortcut(item)"), "All detail tabs use the same admin action header");
  console.log("Company edit shortcut: exact IDs, admin-only navigation, stale-route isolation, async loading, viewport restoration, native links and shared header passed");
})().catch((error) => { console.error(error); process.exitCode = 1; });
