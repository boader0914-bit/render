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
];
for (const id of requiredIds) {
  assert.equal((html.match(new RegExp(`id="${id}"`, "g")) || []).length, 1, `${id} must remain unique`);
}
assert.match(html, /id="b2bSearchStatus"[^>]*role="status"[^>]*aria-live="polite"/);
assert.match(app, /b2b:\s*\["report",\s*"rank",\s*"map",\s*"demand"\]/);

const preservedHooks = [
  "data-b2b-onboarding-focus",
  "data-b2b-onboarding-lodge",
  "data-b2b-history-toggle",
  "data-b2b-history-run-id",
  "data-b2b-my-lodge-toggle",
  "data-b2b-my-lodge-form",
  "data-b2b-interest-lodge-edit",
  "data-b2b-interest-lodge-delete",
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
assert.match(app, /const B2B_INTEREST_LODGE_LIMIT = 2/);
assert.match(app, /const B2B_MY_LODGE_SEGMENT_LIMIT = 8/);
assert.match(app, /method:\s*"PUT"[\s\S]*JSON\.stringify\(\{ interestLodges \}\)/);

assert.match(app, /data-b2b-home-workbench="true"/);
assert.match(app, /data-b2b-home-workbench="ready"/);
assert.match(app, /data-b2b-home-workbench="empty"/);
assert.match(app, /data-b2b-performance-summary="true"[^>]*aria-label="경쟁권 핵심 성과 요약"/);
assert.match(app, /data-b2b-interest-workbench="true"[^>]*aria-labelledby="b2bInterestWorkbenchTitle"/);
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
assert.match(app, /b2b-my-lodge-sync-note" role="status" aria-live="polite"/);
assert.match(app, /b2b-my-lodge-collect-status[^>]*role="status" aria-live="polite"/);

assert.match(app, /const editingId = typeof state\.b2bMyLodgeEditing === "string"/);
assert.match(app, /const editorAvailable = canRegisterMore \|\| Boolean\(editingTargetExists\)/);
assert.match(app, /if \(editingLodge\) interestLodges\.splice\(editingIndex, 1, lodge\)/);
assert.match(app, /state\.b2bMyLodgeEditing = editingId/);
assert.match(app, /draft: \{ \.\.\.target \},\s*interestLodges\s*\}\s*, \{ syncInterestLodges: false \}\)/);
assert.doesNotMatch(app, /draft: \{ \.\.\.target, id: "" \}[\s\S]{0,120}interestLodges: interestLodges\.filter/);
assert.match(app, /state\.b2bMyLodgeExpanded = Boolean\(editingId && !deletingEditedLodge\)/);
assert.match(app, /state\.b2bMyLodgeEditing = deletingEditedLodge \? false : editingId/);
assert.doesNotMatch(app, /if \(willOpen\) state\.b2bMyLodgeEditing = false/);

assert.match(css, /B2B home and interest lodge workbench v1/);
assert.match(css, /body\.role-b2b \.b2b-home-status-strip\s*\{/);
assert.match(css, /body\.role-b2b \.b2b-home-journey\s*\{/);
assert.match(css, /body\.role-b2b \.b2b-interest-workbench\s*\{/);
assert.match(css, /body\.role-b2b \.b2b-interest-lodge-insights\s*\{/);
assert.match(css, /body\.role-b2b \.b2b-my-lodge-editor-grid\s*\{/);
assert.match(css, /body\.role-b2b \.b2b-interest-workbench :where\(button, input, summary\):focus-visible/);
assert.match(css, /body\.role-b2b \.b2b-interest-lodge-actions button,[\s\S]*min-height:\s*var\(--ui-control-height\)/);
assert.match(css, /body\.role-b2b \.header-logout,[\s\S]*body\.role-b2b \.bottom-nav button,[\s\S]*min-height:\s*var\(--ui-control-height\)/);
assert.match(css, /body\.role-b2b \.b2b-interest-workbench \.b2b-my-lodge-checks label\s*\{[\s\S]*min-height:\s*var\(--ui-control-height\)/);
assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*body\.role-b2b \.b2b-interest-workbench \*/);
assert.match(css, /@media \(max-width: 720px\)[\s\S]*body\.role-b2b \.b2b-home-journey,[\s\S]*grid-template-columns:\s*1fr/);
assert.match(css, /@media \(max-width: 720px\)[\s\S]*body\.role-b2b \.b2b-my-lodge-editor-grid[\s\S]*grid-template-columns:\s*1fr/);
assert.match(css, /@media \(max-width: 390px\)[\s\S]*body\.role-b2b \.b2b-interest-lodge-actions[\s\S]*grid-template-columns:\s*1fr/);
assert.match(css, /@media \(max-width: 390px\)[\s\S]*overflow-wrap:\s*anywhere/);
assert.match(css, /:root\[data-theme="light"\] body\.role-b2b/);

console.log("B2B home, performance summary, and interest lodge workbench UI contract checks passed");
