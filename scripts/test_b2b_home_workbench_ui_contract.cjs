"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

global.fetch = () => {
  throw new Error("Network calls are forbidden in B2B home workbench UI contract tests");
};

const root = path.resolve(__dirname, "..");
const html = fs.readFileSync(path.join(root, "web", "index.html"), "utf8");
const app = fs.readFileSync(path.join(root, "web", "app.js"), "utf8");
const css = fs.readFileSync(path.join(root, "web", "styles.css"), "utf8");

function functionBlock(name) {
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
  const open = app.indexOf("{", parameterClose);
  let depth = 0;
  let quote = "";
  let escaped = false;
  for (let index = open; index < app.length; index += 1) {
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
    if (character === '"' || character === "'" || character === "`") {
      quote = character;
      continue;
    }
    if (character === "{") depth += 1;
    if (character === "}") depth -= 1;
    if (depth === 0) return app.slice(open + 1, index);
  }
  assert.fail(`unbalanced function ${name}`);
}

function assertEarlyPreviewGuard(name, sideEffectMarkers = []) {
  const block = functionBlock(name);
  const guardIndex = block.search(/blockAdminUserViewMutation\s*\(|!canMutateB2B\s*\(\)|isAdminUserViewMode\s*\(\)/);
  assert.ok(guardIndex >= 0, `${name} must enforce the central Admin User View mutation guard`);
  for (const marker of sideEffectMarkers) {
    const sideEffectIndex = block.indexOf(marker);
    assert.ok(sideEffectIndex >= 0, `${name} must retain ${marker}`);
    assert.ok(guardIndex < sideEffectIndex, `${name} must guard before ${marker}`);
  }
}

const requiredIds = [
  "b2bSearchPanel",
  "b2bSearchForm",
  "b2bSearchInput",
  "b2bSearchRangeInput",
  "b2bSearchIntentHint",
  "b2bSearchResults",
  "b2bSearchStatus",
  "b2bAccountPanel",
  "b2bSearchHistory",
  "reportBody",
  "adminUserViewBanner",
];
for (const id of requiredIds) {
  assert.equal((html.match(new RegExp(`id="${id}"`, "g")) || []).length, 1, `${id} must remain unique`);
}
assert.match(html, /id="b2bSearchStatus"[^>]*role="status"[^>]*aria-live="polite"/);
assert.ok(html.indexOf('id="b2bAccountPanel"') < html.indexOf('id="b2bSearchForm"'), "business context must precede search actions in DOM order");
assert.match(app, /b2b:\s*\{[\s\S]*?allowedTabs:\s*\["report",\s*"rank",\s*"map",\s*"demand",\s*"regionInsight",\s*"account"\]/);

const preservedHooks = [
  "data-b2b-onboarding-focus",
  "data-b2b-onboarding-lodge",
  "data-b2b-history-toggle",
  "data-b2b-history-run-id",
  "data-b2b-my-lodge-toggle",
  "data-b2b-my-lodge-form",
  "data-b2b-interest-lodge-edit",
  "data-b2b-interest-lodge-delete",
  "data-b2b-interest-lodge-select",
  "data-b2b-interest-detail-back",
  "data-b2b-my-lodge-collect",
  "data-b2b-my-lodge-save",
  "data-b2b-my-lodge-clear",
  "data-b2b-room-segment-row",
  "data-b2b-room-segment-add",
  "data-b2b-room-segment-remove",
  "data-b2b-won-input",
  "data-drawer-tab",
];
for (const hook of preservedHooks) assert.ok(app.includes(hook), `${hook} must remain available`);

for (const endpoint of ["/api/member/interest-lodges", "/api/b2b-my-lodge-collect"]) {
  assert.ok(app.includes(endpoint), `${endpoint} API contract must remain unchanged`);
}
assert.doesNotMatch(app, /\bb2b\s*\/\s*\d{4}\b/i, "B2B UI must not expose credential-like demo login text");
assert.match(app, /const B2B_INTEREST_LODGE_LIMIT = 2/);
assert.match(app, /const B2B_MY_LODGE_SEGMENT_LIMIT = 8/);
assert.match(app, /method:\s*"PUT"[\s\S]*JSON\.stringify\(\{ interestLodges \}\)/);

assert.match(app, /data-b2b-home-workbench="true"/);
assert.match(app, /data-b2b-home-workbench="ready"/);
assert.match(app, /data-b2b-home-workbench="empty"/);
assert.match(app, /data-b2b-performance-summary="true"[^>]*aria-label="경쟁권 핵심 성과 요약"/);
assert.match(app, /data-b2b-kpi="true"[^>]*data-kpi-state=/);
assert.match(app, /data-kpi-state="\$\{escapeHtml\(card\.state \|\| "unavailable"\)\}"/);
assert.match(app, /Number\.isFinite\(card\.barValue\)/);
assert.doesNotMatch(functionBlock("b2bSimpleSummaryModel"), /value:\s*revenueModel\.averageRevenue\s*\?[^\n]+:\s*fmtWon\(brief\.averageRevenue\)/);
assert.match(functionBlock("b2bSimpleSummaryModel"), /revenueReady \? fmtWon\(revenueModel\.averageRevenue \|\| 0\) : "매출 표본 대기"/);
assert.match(functionBlock("b2bSimpleSummaryModel"), /reservationReady \? \(actualReservationRate === 0 \? "zero" : "ready"\) : "unavailable"/);
assert.match(functionBlock("b2bSimpleSummaryModel"), /const actualReservationRate[\s\S]*?const sampleCount[\s\S]*?const competitionReady[\s\S]*?const reservationReady[\s\S]*?const demandReady[\s\S]*?const completedAt[\s\S]*?const analysisPeriod/, "summary readiness variables must be declared in the same function before card construction");
assert.match(app, /data-b2b-interest-workbench="true"[^>]*aria-labelledby="b2bInterestWorkbenchTitle"/);
assert.match(app, /data-b2b-interest-master-detail="true"/);
assert.match(app, /data-b2b-interest-detail-state="no-selection"/);
assert.match(app, /data-b2b-interest-detail-state="missing"/);
assert.match(app, /data-b2b-interest-detail-state="selected"/);
assert.match(app, /aria-current="\$\{selected \? "true" : "false"\}"/);
assert.match(app, /aria-pressed="\$\{selected \? "true" : "false"\}"/);
assert.match(app, /id="b2bInterestDetailTitle" tabindex="-1"/);
assert.match(app, /다른 숙소로 임의 전환하지 않았습니다/);
assert.match(app, /유형 정보 미수집/);
assert.match(app, /관심숙소 저장 계약에 순위 값이 없습니다/);
assert.match(app, /data-b2b-interest-comparison="true"/);
assert.match(app, /data-b2b-interest-card="true"[^>]*aria-labelledby=/);
assert.match(app, /관심숙소 비교 워크벤치/);
assert.match(app, /실제 회계 매출이 아닌 경쟁권 기반 예상치/);
assert.match(app, /현재 리포트 기준/);
assert.match(app, /최근 분석/);
assert.match(app, /state\.memberSearchHistory/);

assert.match(app, /aria-label="\$\{escapeHtml\(`\$\{name\} 수정`\)\}"/);
assert.match(app, /aria-label="\$\{escapeHtml\(`\$\{name\} 삭제`\)\}"/);
assert.match(app, /data-b2b-interest-lodge-name=/);
assert.match(app, /window\.confirm\(`\$\{lodgeName\} 정보를 삭제할까요\?`\)/);
assert.match(app, /aria-controls="b2bInterestLodgeEditor"/);
assert.match(app, /id="b2bInterestLodgeEditor" data-b2b-my-lodge-form/);
assert.match(app, /b2b-interest-workbench-status[^>]*role="status" aria-live="polite" aria-atomic="true"/);
assert.match(app, /b2b-my-lodge-collect-status[^>]*role="status" aria-live="polite"/);
assert.match(app, /data-b2b-interest-search-result="true"/);

const regionKeyFactory = new Function("compactSearchText", `return function b2bInterestLodgeRegionKey(lodge = {}) {${functionBlock("b2bInterestLodgeRegionKey")}};`);
const compact = (value) => String(value || "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
const regionKey = regionKeyFactory(compact);
const duplicateFactory = new Function("compactSearchText", "b2bInterestLodgeRegionKey", `return function b2bInterestLodgeDuplicateIndex(interestLodges = [], candidate = {}, excludeIndex = -1) {${functionBlock("b2bInterestLodgeDuplicateIndex")}};`);
const duplicateIndex = duplicateFactory(compact, regionKey);
const duplicateFixtures = [
  { lodgingName: "봄날 펜션", searchRegion: "제주" },
  { lodgingName: "블루 풀빌라", searchRegion: "경주" },
];
assert.equal(duplicateIndex(duplicateFixtures, { lodgingName: " 봄날펜션 ", searchRegion: "제주" }), 0, "same lodge name and region must be rejected as duplicate");
assert.equal(duplicateIndex(duplicateFixtures, { lodgingName: "봄날 펜션", searchRegion: "가평" }), -1, "same name in a clearly different region must remain selectable");
assert.equal(duplicateIndex(duplicateFixtures, { lodgingName: "봄날 펜션", searchRegion: "제주" }, 0), -1, "editing the same lodge must not self-conflict");
assert.match(functionBlock("saveB2BMyLodgeBenchmark"), /b2bInterestLodgeDuplicateIndex\(interestLodges, values, editingIndex\)/);
assert.match(functionBlock("saveB2BMyLodgeBenchmark"), /이미 관심숙소에 저장되어 있습니다/);
assert.match(functionBlock("b2bSelectedInterestLodgeRecord"), /b2bInterestLodgeTargetIndex\(rows, selectedId, -1\)/);
assert.doesNotMatch(functionBlock("b2bSelectedInterestLodgeRecord"), /interestLodges\[0\]|rows\[0\]/);
assert.match(functionBlock("selectB2BInterestLodge"), /focusB2BInterestLodgeDetail\(\)/);
assert.match(functionBlock("closeB2BInterestLodgeDetail"), /b2bInterestLodgeReturnFocusId/);
assert.match(functionBlock("deleteB2BInterestLodge"), /deletedSelectedLodge[\s\S]*b2bInterestLodgeSelectedId = ""/);
assert.match(functionBlock("syncB2BInterestLodgesToServer"), /requestId !== state\.b2bInterestLodgeSyncRequestId/);

assert.match(app, /const editingId = typeof state\.b2bMyLodgeEditing === "string"/);
assert.match(app, /const editorAvailable = canRegisterMore \|\| Boolean\(editingTargetExists\)/);
assert.match(app, /if \(editingLodge\) interestLodges\.splice\(editingIndex, 1, lodge\)/);
assert.match(app, /state\.b2bMyLodgeEditing = editingId/);
assert.match(app, /draft: \{ \.\.\.target \},\s*interestLodges\s*\}\s*, \{ syncInterestLodges: false \}\)/);
assert.doesNotMatch(app, /draft: \{ \.\.\.target, id: "" \}[\s\S]{0,120}interestLodges: interestLodges\.filter/);
assert.match(app, /state\.b2bMyLodgeExpanded = Boolean\(editingId && !deletingEditedLodge\)/);
assert.match(app, /state\.b2bMyLodgeEditing = deletingEditedLodge \? false : editingId/);
assert.doesNotMatch(app, /if \(willOpen\) state\.b2bMyLodgeEditing = false/);

assert.match(html, /관리자 미리보기 · 읽기 전용/);
assert.match(html, /<a\b[^>]*href="\/admin"[^>]*>관리자 화면으로 돌아가기<\/a>/);
assert.match(functionBlock("canMutateB2B"), /!isAdminUserViewMode\(\)/);
const blocker = functionBlock("blockAdminUserViewMutation");
assert.match(blocker, /canMutateB2B\(\)/);
assert.match(blocker, /syncAdminUserViewReadOnlyControls\(\)/);
assert.match(blocker, /읽기 전용/);

const readOnlyControls = functionBlock("syncAdminUserViewReadOnlyControls");
for (const hook of [
  "#themeToggle",
  "#b2bSearchForm button[type='submit']",
  "[data-b2b-query]",
  "[data-b2b-onboarding-lodge]",
  "[data-b2b-my-lodge-toggle]",
  "[data-b2b-interest-lodge-edit]",
  "[data-b2b-interest-lodge-delete]",
  "[data-b2b-my-lodge-form] input",
  "[data-b2b-my-lodge-form] button",
  "[data-b2b-my-lodge-collect]",
  "[data-b2b-my-lodge-save]",
  "[data-b2b-my-lodge-clear]",
  "[data-b2b-account-destructive]",
]) {
  assert.ok(readOnlyControls.includes(hook), `Admin User View must disable ${hook}`);
}
assert.ok(!readOnlyControls.includes("[data-b2b-interest-lodge-select]"), "Admin User View must retain read-only lodge selection");
assert.ok(!readOnlyControls.includes("[data-b2b-interest-detail-back]"), "Admin User View must retain read-only detail navigation");
assert.match(readOnlyControls, /\.disabled\s*=\s*true/);
assert.match(readOnlyControls, /dataset\.adminPreviewDisabled/);
assert.match(readOnlyControls, /aria-disabled/);
assert.match(readOnlyControls, /title/);

for (const [name, markers] of [
  ["persistB2BMyLodgeStore", ["localStorage.setItem", "state.b2bMyLodgeDraft"]],
  ["saveB2BMyLodgeBenchmark", ["collectB2BMyLodgeFormValues"]],
  ["editB2BInterestLodge", ["state.b2bMyLodgeEditing"]],
  ["deleteB2BInterestLodge", ["persistB2BMyLodgeStore"]],
  ["updateB2BMyLodgeRoomSegments", ["persistB2BMyLodgeDraft"]],
  ["collectB2BMyLodgeByName", ["fetchJson"]],
  ["clearB2BMyLodgeBenchmark", ["persistB2BMyLodgeStore"]],
  ["submitB2BSearch", ["fetchB2BCrawlEstimate"]],
  ["syncB2BInterestLodgesToServer", ["fetchJson"]],
]) {
  assertEarlyPreviewGuard(name, markers);
}

const storedValueReader = functionBlock("readB2BMyLodgeStoredValue");
const previewReadExit = storedValueReader.search(/isAdminUserViewMode\s*\(\)[\s\S]{0,120}return/);
const migrationWrite = storedValueReader.indexOf("localStorage.setItem");
assert.ok(previewReadExit >= 0, "Admin User View must exit before legacy storage migration");
assert.ok(migrationWrite < 0 || previewReadExit < migrationWrite, "Admin User View must not migrate administrator local storage");
assertEarlyPreviewGuard("clearB2BMyLodgeLegacyStorageKeys", ["localStorage.removeItem"]);
assertEarlyPreviewGuard("writeB2BActiveSearchRecord", ["localStorage.setItem"]);
assertEarlyPreviewGuard("clearB2BActiveSearchRecord", ["localStorage.removeItem"]);

assert.match(css, /B2B home, performance, and interest lodge workbench v2/);
assert.match(css, /body\.role-b2b \.b2b-home-status-strip\s*\{/);
assert.match(css, /body\.role-b2b \.b2b-home-journey\s*\{/);
assert.match(css, /body\.role-b2b \.b2b-interest-workbench\s*\{/);
assert.match(css, /body\.role-b2b \.b2b-interest-lodge-insights\s*\{/);
assert.match(css, /body\.role-b2b \.b2b-interest-master-detail\s*\{[\s\S]*grid-template-columns:\s*minmax\(280px, \.78fr\) minmax\(360px, 1\.22fr\)/);
assert.match(css, /body\.role-b2b \.b2b-interest-detail-pane\s*\{[\s\S]*position:\s*sticky/);
assert.match(css, /body\.role-b2b \.b2b-interest-lodge-card\.is-selected\s*\{[\s\S]*color-border-focus/);
assert.match(css, /body\.role-b2b \.b2b-kpi-status\s*\{/);
assert.match(css, /body\.role-b2b \.b2b-my-lodge-editor-grid\s*\{/);
assert.match(css, /body\.role-b2b \.b2b-interest-workbench :where\(button, input, summary\):focus-visible/);
assert.match(css, /body\.role-b2b \.b2b-interest-lodge-actions button,[\s\S]*min-height:\s*var\(--ui-control-height\)/);
assert.match(css, /body\.role-b2b \.header-logout,[\s\S]*body\.role-b2b \.bottom-nav button,[\s\S]*min-height:\s*var\(--ui-control-height\)/);
assert.match(css, /body\.role-b2b \.b2b-interest-workbench \.b2b-my-lodge-checks label\s*\{[\s\S]*min-height:\s*var\(--ui-control-height\)/);
assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*body\.role-b2b \.b2b-interest-workbench \*/);
assert.match(css, /@media \(max-width: 720px\)[\s\S]*body\.role-b2b \.b2b-home-journey,[\s\S]*grid-template-columns:\s*1fr/);
assert.match(css, /@media \(max-width: 720px\)[\s\S]*body\.role-b2b \.b2b-my-lodge-editor-grid[\s\S]*grid-template-columns:\s*1fr/);
assert.match(css, /@media \(max-width: 1120px\)[\s\S]*body\.role-b2b \.b2b-interest-master-detail[\s\S]*grid-template-columns:\s*1fr/);
assert.match(css, /@media \(max-width: 720px\)[\s\S]*b2b-interest-master-detail\.has-selection \.b2b-interest-list-pane[\s\S]*display:\s*none/);
assert.match(css, /@media \(max-width: 390px\)[\s\S]*body\.role-b2b \.b2b-interest-lodge-actions[\s\S]*grid-template-columns:\s*1fr/);
assert.match(css, /@media \(max-width: 390px\)[\s\S]*overflow-wrap:\s*anywhere/);
assert.match(css, /:root\[data-theme="light"\] body\.role-b2b/);
for (const selector of [
  ".b2b-my-lodge-main",
  ".b2b-my-lodge-cards article",
  ".b2b-my-lodge-chart",
  ".b2b-my-lodge-compare-row",
  ".b2b-interest-detail",
]) {
  assert.ok(css.includes(selector), `${selector} must receive semantic theme treatment`);
}
const stage4Css = css.slice(css.indexOf("/* B2B home, performance, and interest lodge workbench v2 */"));
assert.doesNotMatch(stage4Css, /#121822|#b9dcff|#cfe4ff|#8fc2ff|#dcecff|#f6d58a/);
assert.doesNotMatch(stage4Css, /filter\s*:\s*(?:invert|hue-rotate)/);
assert.match(stage4Css, /\.b2b-room-segment-remove\s*\{[\s\S]*min-width:\s*var\(--touch-target-min\)[\s\S]*width:\s*var\(--touch-target-min\)/);
assert.match(css, /\.admin-user-view-banner\s*\{/);

console.log("B2B home, performance summary, and interest lodge workbench UI contract checks passed");
