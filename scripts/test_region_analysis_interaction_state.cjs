"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { installFixtureNetworkGuard } = require("./fixture_network_guard.cjs");

const networkGuard = installFixtureNetworkGuard({ label: "region interaction fixtures" });

const root = path.resolve(__dirname, "..");
const app = fs.readFileSync(path.join(root, "web", "app.js"), "utf8");

function functionSource(name) {
  const match = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`).exec(app);
  assert.ok(match, `missing function ${name}`);
  const parameterOpen = app.indexOf("(", match.index);
  let parameterDepth = 0;
  let parameterClose = -1;
  for (let index = parameterOpen; index < app.length; index += 1) {
    if (app[index] === "(") parameterDepth += 1;
    if (app[index] === ")") parameterDepth -= 1;
    if (parameterDepth === 0) {
      parameterClose = index;
      break;
    }
  }
  assert.notEqual(parameterClose, -1, `missing parameter close for ${name}`);
  const bodyOpen = app.indexOf("{", parameterClose);
  let bodyDepth = 0;
  let quote = "";
  let escaped = false;
  for (let index = bodyOpen; index < app.length; index += 1) {
    const character = app[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote && character === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = "";
      continue;
    }
    if (["\"", "'", "`"].includes(character)) {
      quote = character;
      continue;
    }
    if (character === "{") bodyDepth += 1;
    if (character === "}") bodyDepth -= 1;
    if (bodyDepth === 0) return app.slice(match.index, index + 1);
  }
  assert.fail(`unbalanced function ${name}`);
}

function loadFunctions(names, context = {}) {
  const sandbox = vm.createContext(context);
  vm.runInContext(`${names.map(functionSource).join("\n")}\n${names.map((name) => `this.${name} = ${name};`).join("\n")}`, sandbox);
  return sandbox;
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function canonicalContext(regionKey) {
  return { matchStatus: "matched", regionKey, displayLabel: regionKey };
}

(async () => {
// Pure tab-state functions are the executable accessibility contract.
const tabState = loadFunctions([
  "regionAnalysisTabPresentation",
  "regionAnalysisTabIndexForKey"
]);
const presentation = tabState.regionAnalysisTabPresentation(["map", "demand", "regionInsight"], "demand", true);
assert.deepEqual(
  Array.from(presentation, (item) => ({ ...item })),
  [
    { tab: "map", active: false, ariaSelected: "false", tabIndex: -1 },
    { tab: "demand", active: true, ariaSelected: "true", tabIndex: 0 },
    { tab: "regionInsight", active: false, ariaSelected: "false", tabIndex: -1 }
  ]
);
assert.equal(tabState.regionAnalysisTabIndexForKey("ArrowRight", 2, 3), 0);
assert.equal(tabState.regionAnalysisTabIndexForKey("ArrowLeft", 0, 3), 2);
assert.equal(tabState.regionAnalysisTabIndexForKey("Home", 2, 3), 0);
assert.equal(tabState.regionAnalysisTabIndexForKey("End", 0, 3), 2);
assert.equal(tabState.regionAnalysisTabIndexForKey("Enter", 0, 3), -1);

// The real key handler delegates to the pure index function and activates the target tab.
const tabButtons = ["map", "demand", "regionInsight"].map((tab) => ({ dataset: { regionAnalysisTab: tab } }));
const activatedTabs = [];
const keyboard = loadFunctions(["handleRegionAnalysisTabKeydown"], {
  els: { regionAnalysisTabs: { querySelectorAll: () => tabButtons } },
  regionAnalysisTabIndexForKey: tabState.regionAnalysisTabIndexForKey,
  activateRegionAnalysisTab: (tab, options) => {
    activatedTabs.push({ tab, options });
    return true;
  }
});
for (const [key, current, expected] of [
  ["ArrowRight", 2, "map"],
  ["ArrowLeft", 0, "regionInsight"],
  ["Home", 2, "map"],
  ["End", 0, "regionInsight"]
]) {
  let prevented = false;
  const event = {
    key,
    target: { closest: () => tabButtons[current] },
    preventDefault: () => { prevented = true; }
  };
  assert.equal(keyboard.handleRegionAnalysisTabKeydown(event), true);
  assert.equal(activatedTabs.at(-1).tab, expected);
  assert.equal(prevented, true);
}

// A rejected dirty-navigation confirmation must not move focus to a different tab.
let scheduledFocus = 0;
const activation = loadFunctions(["activateRegionAnalysisTab"], {
  regionAnalysisTabIds: () => ["map", "reviewPublish"],
  setActiveTab: () => false,
  window: { requestAnimationFrame: () => { scheduledFocus += 1; } },
  els: { regionAnalysisTabs: { querySelector: () => ({ focus: () => { scheduledFocus += 10; } }) } }
});
assert.equal(activation.activateRegionAnalysisTab("map", { focus: true }), false);
assert.equal(scheduledFocus, 0);

// A stale admin-only history tab resolves to the first allowed B2B region tab.
const history = loadFunctions(["resolveRegionAnalysisReturnTab", "resolveHistoryTabForRole"], {
  REGION_ANALYSIS_TABS: {
    admin: ["map", "demand", "dictionary", "reviewPublish"],
    b2b: ["map", "demand", "regionInsight"]
  },
  firstRoleTab: () => "report"
});
const b2bTabs = ["report", "rank", "map", "demand", "regionInsight", "account"];
const b2bRegionTabs = ["map", "demand", "regionInsight"];
assert.equal(history.resolveHistoryTabForRole("reviewPublish", b2bTabs, b2bRegionTabs), "map");
assert.equal(history.resolveHistoryTabForRole("dictionary", b2bTabs, b2bRegionTabs), "map");

// Dirty tab navigation is canceled before any render or history mutation.
let dirtyConfirmations = 0;
const dirtyTabState = {
  activeTab: "reviewPublish",
  adminRegionInsightDirty: true,
  adminSettingsDirty: false
};
const dirtyTab = loadFunctions(["setActiveTab"], {
  state: dirtyTabState,
  roleAllowsTab: () => true,
  firstRoleTab: () => "report",
  confirmAdminRegionInsightNavigation: () => {
    dirtyConfirmations += 1;
    return false;
  }
});
assert.equal(dirtyTab.setActiveTab("map"), false);
assert.equal(dirtyTabState.activeTab, "reviewPublish");
assert.equal(dirtyConfirmations, 1);
assert.equal(dirtyTab.setActiveTab("reviewPublish"), true, "same-tab activation must not prompt or discard input");
assert.equal(dirtyConfirmations, 1);

// The actual loadRun function guards a same-run reload and restores the selector.
let canceledRunFetches = 0;
const canceledRunState = {
  data: { run: { id: "run-a" } },
  activeRunId: "run-a",
  adminRegionInsightDirty: true,
  adminRegionInsightDirtyRevision: 7,
  runRequestId: 0
};
const canceledRunEls = { runSelect: { value: "run-b" } };
const canceledRun = loadFunctions(["loadRun"], {
  state: canceledRunState,
  els: canceledRunEls,
  confirmAdminRegionInsightNavigation: () => false,
  fetchJson: async () => {
    canceledRunFetches += 1;
    throw new Error("fetch must not start after cancellation");
  }
});
assert.equal(await canceledRun.loadRun("run-a"), false);
assert.equal(canceledRunFetches, 0);
assert.equal(canceledRunState.activeRunId, "run-a");
assert.equal(canceledRunEls.runSelect.value, "run-a");
assert.equal(canceledRunState.adminRegionInsightDirty, true);

// A -> B -> C responses arriving C, B, A apply and render C only.
const pendingRuns = new Map();
const renderedRuns = [];
const raceState = {
  data: { run: { id: "seed" }, regionContext: canonicalContext("kr_seed") },
  activeRunId: "seed",
  runRequestId: 0,
  adminRegionInsightDirty: false,
  adminRegionInsightDirtyRevision: 0,
  b2bMapTransientLocations: {},
  b2bMapGeocodingState: "idle",
  b2bMapGeocodingMessage: "",
  historyOps: null,
  companyMaster: null,
  crawlEtaByKey: {},
  b2bMemberAdmin: null,
  accountDeleteAdmin: null,
  securityHardeningAdmin: null
};
const race = loadFunctions(["loadRun"], {
  state: raceState,
  els: { runSelect: { value: "seed" } },
  confirmAdminRegionInsightNavigation: () => true,
  setStatus: () => {},
  shouldLoadRunReadOnly: () => true,
  fetchJson: (url) => {
    const runId = decodeURIComponent(String(url).split("/").at(-1));
    const request = deferred();
    pendingRuns.set(runId, request);
    return request.promise;
  },
  matchedRegionContextKey: (context) => context?.matchStatus === "matched" ? context.regionKey : "",
  setRegionAnalysisRegionKey: (regionKey) => { raceState.regionAnalysisRegionKey = regionKey; },
  syncAppHistoryState: () => {},
  isAdminRole: () => false,
  roleAllowsTab: () => false,
  syncDictionaryInputToActiveRun: () => {},
  correctedSearchMode: (_keyword, mode) => mode,
  syncCollectionModeInputs: () => {},
  renderAll: () => { renderedRuns.push(raceState.data?.run?.id); },
  adminDbCompanyIdFromRoute: () => "",
  handleAdminDbCompanyHash: () => {}
});
const runA = race.loadRun("A");
const runB = race.loadRun("B");
const runC = race.loadRun("C");
pendingRuns.get("C").resolve({ run: { id: "C", keyword: "C" }, regionContext: canonicalContext("kr_c") });
assert.equal(await runC, true);
pendingRuns.get("B").resolve({ run: { id: "B", keyword: "B" }, regionContext: canonicalContext("kr_b") });
pendingRuns.get("A").resolve({ run: { id: "A", keyword: "A" }, regionContext: canonicalContext("kr_a") });
assert.equal(await runB, null);
assert.equal(await runA, null);
assert.equal(raceState.activeRunId, "C");
assert.equal(raceState.data.run.id, "C");
assert.deepEqual(renderedRuns, ["C"]);

function mutationFixture({ outcome }) {
  const memo = { value: "edited memo", defaultValue: "server memo", disabled: false, isConnected: true };
  const version = { value: "v-next", defaultValue: "v-old", disabled: false, isConnected: true };
  const button = { disabled: false, isConnected: true };
  const feedback = { focused: false, focus() { this.focused = true; } };
  const nextMemo = { value: "fresh server memo", defaultValue: "fresh server memo", disabled: false, isConnected: true };
  const nextVersion = { value: "fresh-version", defaultValue: "fresh-version", disabled: false, isConnected: true };
  let rendered = false;
  let inlineError = "";
  const body = {
    querySelector(selector) {
      if (selector === "[data-region-insight-admin-memo]") return rendered ? nextMemo : memo;
      if (selector === "[data-region-insight-version]") return rendered ? nextVersion : version;
      if (selector === ".region-insight-warning.error") return null;
      if (selector === ".region-insight-feedback") return rendered ? feedback : null;
      return null;
    },
    querySelectorAll: () => [memo, version, button]
  };
  const fixtureState = {
    data: { regionContext: canonicalContext("kr_gyeonggi_pocheon") },
    adminRegionInsightSaving: false,
    adminRegionInsightRequestId: 0,
    adminRegionInsightDirty: true,
    adminRegionInsightDraftDirty: true,
    adminRegionInsightError: "",
    adminRegionInsightMessage: "",
    adminRegionInsightRecord: null,
    adminRegionInsightLoadedRegionKey: "kr_gyeonggi_pocheon"
  };
  const context = {
    state: fixtureState,
    els: { reviewPublishBody: body },
    blockAdminUserViewMutation: () => false,
    matchedRegionContextKey: (value) => value?.matchStatus === "matched" ? value.regionKey : "",
    fetchJson: async () => {
      if (outcome === "failure") throw new Error("fixture mutation failed");
      if (outcome === "workflow_conflict") {
        const error = new Error("fixture workflow changed");
        error.status = 409;
        error.code = "REGION_WORKFLOW_REVISION_CONFLICT";
        throw error;
      }
      return {
        regionContext: canonicalContext("kr_gyeonggi_pocheon"),
        regionInsight: { state: { regionKey: "kr_gyeonggi_pocheon" } }
      };
    },
    showAdminRegionInsightInlineError: (message) => { inlineError = message; },
    renderAdminRegionInsightWorkbench: () => { rendered = true; },
    window: { requestAnimationFrame: (callback) => callback() }
  };
  return {
    body,
    button,
    context,
    feedback,
    fixtureState,
    memo,
    nextMemo,
    nextVersion,
    version,
    inlineError: () => inlineError,
    rendered: () => rendered
  };
}

// Failed mutations keep every live input and restore each control's disabled state.
const failedMutation = mutationFixture({ outcome: "failure" });
const failedMutationApi = loadFunctions(["mutateAdminRegionInsight"], failedMutation.context);
await failedMutationApi.mutateAdminRegionInsight("draft", { locationAttractiveness: { value: 77 } });
assert.equal(failedMutation.memo.value, "edited memo");
assert.equal(failedMutation.version.value, "v-next");
assert.equal(failedMutation.memo.disabled, false);
assert.equal(failedMutation.version.disabled, false);
assert.equal(failedMutation.button.disabled, false);
assert.equal(failedMutation.fixtureState.adminRegionInsightDirty, true);
assert.equal(failedMutation.fixtureState.adminRegionInsightDraftDirty, true);
assert.match(failedMutation.inlineError(), /fixture mutation failed/);
assert.equal(failedMutation.rendered(), false, "a failed mutation must not rebuild the form DOM");

// CAS conflicts preserve the live form and tell the reviewer to reload the latest workflow state.
const conflictMutation = mutationFixture({ outcome: "workflow_conflict" });
const conflictMutationApi = loadFunctions(["mutateAdminRegionInsight"], conflictMutation.context);
await conflictMutationApi.mutateAdminRegionInsight("review", { expectedWorkflowRevision: 3 });
assert.equal(conflictMutation.memo.value, "edited memo");
assert.equal(conflictMutation.version.value, "v-next");
assert.equal(conflictMutation.rendered(), false);
assert.match(conflictMutation.inlineError(), /입력한 초안·메모·버전은 보존/);
assert.match(conflictMutation.inlineError(), /최신 데이터를 다시 확인/);

// Successful mutations rebuild from server state, preserve intentional auxiliary edits, and focus status feedback.
const successfulMutation = mutationFixture({ outcome: "success" });
const successfulMutationApi = loadFunctions(["mutateAdminRegionInsight"], successfulMutation.context);
await successfulMutationApi.mutateAdminRegionInsight("draft", { locationAttractiveness: { value: 77 } });
assert.equal(successfulMutation.rendered(), true);
assert.equal(successfulMutation.nextMemo.value, "edited memo");
assert.equal(successfulMutation.nextVersion.value, "v-next");
assert.equal(successfulMutation.feedback.focused, true);
assert.equal(successfulMutation.fixtureState.adminRegionInsightDraftDirty, false);
assert.equal(successfulMutation.fixtureState.adminRegionInsightDirty, true, "preserved auxiliary edits remain dirty");

assert.match(functionSource("renderRegionAnalysisNavigation"), /regionAnalysisTabPresentation/);
assert.match(functionSource("handleRegionAnalysisTabKeydown"), /regionAnalysisTabIndexForKey/);
assert.match(functionSource("activateRegionAnalysisTab"), /if \(!setActiveTab\([\s\S]*?\)\) return false/);
assert.ok((functionSource("loadRun").match(/requestId !== state\.runRequestId/g) || []).length >= 2);
assert.match(functionSource("mutateAdminRegionInsight"), /region-insight-feedback/);
assert.equal(networkGuard.blockedAttempts(), 0);
networkGuard.restore();

console.log("Region analysis interaction state fixture checks passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
