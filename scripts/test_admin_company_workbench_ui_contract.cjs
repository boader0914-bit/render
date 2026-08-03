"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

global.fetch = () => {
  throw new Error("Network calls are forbidden in administrator company workbench UI contract tests");
};

const root = path.resolve(__dirname, "..");
const html = fs.readFileSync(path.join(root, "web", "index.html"), "utf8");
const app = fs.readFileSync(path.join(root, "web", "app.js"), "utf8");
const css = fs.readFileSync(path.join(root, "web", "styles.css"), "utf8");

function balancedBlockFrom(source, startIndex) {
  const open = source.indexOf("{", startIndex);
  assert.notEqual(open, -1, "expected CSS block opening brace");
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") depth -= 1;
    if (depth === 0) return source.slice(open + 1, index);
  }
  assert.fail("expected balanced CSS block");
}

function cssRuleBlock(selector) {
  const startIndex = css.indexOf(selector);
  assert.notEqual(startIndex, -1, `expected CSS selector: ${selector}`);
  return balancedBlockFrom(css, startIndex);
}

function lastCssRuleBlock(selector) {
  const startIndex = css.lastIndexOf(selector);
  assert.notEqual(startIndex, -1, `expected final CSS selector: ${selector}`);
  return balancedBlockFrom(css, startIndex);
}

assert.equal((html.match(/id="adminDatabaseDashboard"/g) || []).length, 1, "company management mount must remain unique");
assert.match(html, /data-admin-section-panel="database"/);
assert.match(html, /class="admin-workspace-shell"/);

const listHooks = [
  "data-admin-db-query",
  "data-admin-db-province",
  "data-admin-db-region",
  "data-admin-db-sort",
  "data-admin-db-category",
  "data-admin-db-status",
  "data-admin-db-confidence",
  "data-admin-db-source",
  "data-admin-db-ota",
  "data-admin-db-feature",
  "data-admin-db-clear",
  "data-admin-db-list-page",
  "data-admin-db-company-card-select",
  "data-admin-db-company-select",
  "data-admin-db-filter-remove",
  "data-admin-db-reveal-selected",
];
for (const hook of listHooks) assert.ok(app.includes(hook), `${hook} list contract must remain available`);

assert.match(app, /data-admin-db-list-workbench="true"/);
assert.match(app, /data-admin-db-company-workbench-row="true"/);
assert.match(app, /class="admin-db-company-identity"/);
assert.match(app, /class="admin-db-company-status/);
assert.match(app, /class="admin-db-company-location"/);
assert.match(app, /class="admin-db-company-categories"/);
assert.match(app, /class="admin-db-company-next-action"/);
assert.match(app, /class="admin-db-list-overview"[^>]*aria-label="현재 업체 작업 요약"/);
assert.match(app, /class="admin-db-master-detail"/);
assert.match(app, /class="admin-db-list-preview/);
assert.match(app, /data-admin-db-selection-state="\$\{outsideFilter \? "outside-filter" : "selected"\}"/);
assert.match(app, /class="admin-db-pagination"[^>]*aria-label="업체 목록 페이지 이동"/);
assert.match(app, /aria-label="이전 업체 목록 페이지"/);
assert.match(app, /aria-label="다음 업체 목록 페이지"/);
assert.match(app, /aria-label="\$\{escapeHtml\(`\$\{companyName\} 상세 및 수정 열기`\)\}"/);
assert.match(app, /lodgingCategoryBadgesHtml\(company, \{ compact: true \}\)/);
assert.match(app, /const localizedSourceLabels = Array\.isArray\(company\.sourcePlatformLabels\)/);
assert.match(app, /localizedSourceLabels\.length \? localizedSourceLabels : rawSourceLabels/);

assert.match(app, /data-admin-db-company-workbench="true"/);
assert.match(app, /class="admin-db-detail-back"[^>]*data-admin-db-view-link="list"/);
assert.match(app, /업체 상세 워크벤치/);
assert.match(app, /class="admin-db-detail-badges"/);
assert.match(app, /class="admin-db-workbench-heading"/);
assert.match(app, /검수 상태 열기/);

const workbenchSteps = ["correction", "channel", "collect", "review"];
for (const key of workbenchSteps) {
  assert.ok(app.includes(`["${key}"`), `${key} workbench step profile must remain available`);
  assert.ok(app.includes(`foldKey: "${key}"`), `${key} workbench fold must remain available`);
}
assert.match(app, /data-admin-db-workbench-step="\$\{escapeHtml\(key\)\}"/);
assert.match(app, /aria-controls="adminDbFold-\$\{escapeHtml\(key\)\}"/);
assert.match(app, /aria-current="\$\{activeFold === key \? "step" : "false"\}"/);
assert.match(app, /id="adminDbFold-\$\{escapeHtml\(foldKey\)\}" data-admin-db-fold=/);
assert.match(app, /button\.classList\.toggle\("active", active\)/);
assert.match(app, /button\.setAttribute\("aria-current", active \? "step" : "false"\)/);

const mutationHooks = [
  "data-company-manual-form",
  "data-save-company-correction",
  "data-clear-company-correction",
  "data-cancel-company-correction",
  "data-company-manual-dirty-status",
  "data-company-manual-draft-summary",
  "data-company-manual-feedback",
  "data-manual-lodging",
  "data-manual-dayuse",
  "data-manual-room-segments",
  "data-manual-region",
  "data-manual-channel-note",
  "data-manual-coupon-note",
  "data-manual-primary-category",
  "data-manual-category-tag",
  "data-manual-category-note",
  "data-manual-note",
  "data-company-channel-form",
  "data-company-channel-save",
  "data-company-channel-clear",
  "data-company-review-control",
  "data-company-review-action",
  "data-queue-recrawl-company",
];
for (const hook of mutationHooks) assert.ok(app.includes(hook), `${hook} mutation contract must remain available`);
assert.match(app, /data-company-manual-feedback aria-live="polite"/);
assert.match(app, /data-company-manual-dirty="false"/);
assert.match(app, /const shouldClear = Boolean\(clear\)/);
assert.doesNotMatch(app, /const shouldClear = clear \|\| emptySave/);
assert.match(app, /빈 입력은 보정 해제로 처리되지 않습니다/);
assert.match(app, /setCompanyManualFormPending\(form, true\)/);
assert.match(app, /window\.confirm\("저장된 관리자 보정값을 해제하고 자동수집 기준으로 되돌릴까요\?"\)/);
assert.match(app, /function confirmAdminDbCorrectionNavigation/);
assert.match(app, /function focusAdminDbDetailHeading/);
assert.match(app, /id="adminDbDetailTitle" tabindex="-1"/);
assert.match(app, /return rows\.find\(\(row\) => row\.company\?\.companyId === selectedId\) \|\| null/);
assert.doesNotMatch(app, /return selected \|\| adminDbWorkRows\(rows\)\[0\]/);
assert.match(app, /manualCorrectionRoomSegments\(correction = \{\}\)[\s\S]*correction\.roomSegments[\s\S]*correction\.segments/);
assert.equal((app.match(/function lodgingCategoryProfile\(/g) || []).length, 1, "generic lodging category profile name must remain unique");
assert.match(app, /function companyLodgingCategoryProfile\(/);
assert.match(app, /사업자 공통 화면은 새 창에서 확인합니다/);
assert.doesNotMatch(app, /\$\{company\.primaryName\} 기준/);

for (const endpoint of [
  "/api/company-master/manual-correction",
  "/api/company-master/channel-exposure",
  "/api/company-master/admin-review",
  "/api/company-master/duplicates",
]) {
  assert.ok(app.includes(endpoint), `${endpoint} API contract must remain unchanged`);
}

assert.match(css, /Admin company management workbench v1/);
assert.match(css, /#adminDatabaseDashboard \.admin-db-company\[data-admin-db-company-workbench-row="true"\][\s\S]*grid-template-areas:/);
assert.match(css, /#adminDatabaseDashboard \.admin-db-company-action button,[\s\S]*min-height:\s*var\(--ui-control-height\)\s*!important/);
assert.match(css, /#adminDatabaseDashboard \.admin-db-workbench-heading/);

const companyDashboardTokens = cssRuleBlock("body.role-admin #adminDatabaseDashboard {");
assert.match(companyDashboardTokens, /--admin-company-panel-radius:\s*var\(--ui-radius-lg\)/);
assert.match(companyDashboardTokens, /--admin-company-card-radius:\s*var\(--ui-radius-md\)/);
assert.match(companyDashboardTokens, /--admin-company-control-radius:\s*var\(--ui-radius-sm\)/);
assert.match(companyDashboardTokens, /--admin-company-pill-radius:\s*var\(--radius-pill\)/);

const companyHeroLabel = cssRuleBlock("body.role-admin #adminDatabaseDashboard .admin-db-hero > div > span {");
for (const declaration of [
  /border:\s*0/,
  /border-radius:\s*0/,
  /background:\s*transparent/,
  /box-shadow:\s*none/,
  /padding:\s*0/,
]) {
  assert.match(companyHeroLabel, declaration, "company management eyebrow must remain plain text instead of a decorative card");
}
assert.ok(!css.includes("body.role-admin .admin-db-hero span,"), "dark badge surfaces must not leak onto the company management eyebrow");
assert.ok(!css.includes(".admin-db-hero > div > span,"), "light badge surfaces must not leak onto the company management eyebrow");

const companyMajorPanels = cssRuleBlock("body.role-admin #adminDatabaseDashboard :is(\n  .admin-db-hero,");
assert.match(companyMajorPanels, /border-radius:\s*var\(--admin-company-panel-radius\)/);
assert.match(
  cssRuleBlock('body.role-admin #adminDatabaseDashboard .admin-db-company[data-admin-db-company-workbench-row="true"] {'),
  /border-radius:\s*var\(--admin-company-card-radius\)\s*!important/,
  "repeated company rows must use the card radius"
);
assert.match(
  cssRuleBlock('body.role-admin #adminDatabaseDashboard .admin-db-selected-panel[data-admin-db-company-workbench="true"] {'),
  /border-radius:\s*var\(--admin-company-panel-radius\)\s*!important/,
  "selected company workbench must use the major panel radius"
);
assert.match(
  cssRuleBlock("body.role-admin #adminDatabaseDashboard .admin-db-company-status {"),
  /border-radius:\s*var\(--admin-company-pill-radius\)/,
  "short company status labels must keep the pill radius"
);
assert.match(
  cssRuleBlock(".admin-db-region-next-grid article {"),
  /border-radius:\s*var\(--ui-radius-md\)/,
  "multi-line next-step content must use a card radius at every viewport"
);
assert.match(
  cssRuleBlock(".admin-db-region-empty-actions button {"),
  /border-radius:\s*var\(--ui-radius-sm\)/,
  "region empty-state actions must use a control radius instead of a pill"
);
assert.match(css, /#adminDatabaseDashboard \.admin-db-master-detail[\s\S]*grid-template-columns:\s*minmax\(0, 1\.55fr\) minmax\(280px, \.55fr\)/);
assert.match(css, /#adminDatabaseDashboard \.admin-db-list-preview[\s\S]*position:\s*sticky/);
assert.match(css, /#adminDatabaseDashboard \.admin-db-active-filter-chips button[\s\S]*min-height:\s*var\(--touch-target-min\)/);
assert.match(
  cssRuleBlock("body.role-admin #adminDatabaseDashboard .admin-db-active-filter-chips button {"),
  /border-radius:\s*var\(--admin-company-pill-radius\)/,
  "removable filter chips must keep the pill shape"
);
assert.match(
  lastCssRuleBlock("body.role-admin #adminDatabaseDashboard .admin-db-active-filters > button,\nbody.role-admin #adminDatabaseDashboard .admin-db-empty-actions button {"),
  /border-radius:\s*var\(--admin-company-control-radius\)/,
  "general workspace actions must use the small rounded-rectangle radius instead of a pill"
);
assert.match(css, /\.company-manual-actions button[\s\S]*min-height:\s*var\(--touch-target-min\)/);
assert.match(css, /\.company-manual-segments-toolbar button[\s\S]*min-height:\s*var\(--touch-target-min\)/);
assert.match(css, /#adminDatabaseDashboard \.admin-db-detail-back[\s\S]*min-height:\s*var\(--touch-target-min\)/);
assert.match(css, /\.company-manual-form[\s\S]*background:\s*var\(--color-surface-subtle\)/);
assert.match(css, /\.company-manual-dirty-status:not\(\[hidden\]\)/);
assert.match(css, /#adminDatabaseDashboard \.admin-db-detail-tabs button[\s\S]*grid-template-columns:\s*30px minmax\(0, 1fr\)/);
assert.match(css, /#adminDatabaseDashboard \.admin-db-selected-fold\[open\]/);
assert.match(css, /@media \(max-width: 720px\)[\s\S]*#adminDatabaseDashboard \.admin-db-list-overview[\s\S]*grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/);
assert.match(css, /@media \(max-width: 720px\)[\s\S]*#adminDatabaseDashboard \.admin-db-company-values[\s\S]*grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)\s*!important/);
assert.match(css, /@media \(max-width: 720px\)[\s\S]*body\.role-admin :is\([\s\S]*\.admin-db-view-switch button,[\s\S]*min-height:\s*var\(--touch-target-min\)/, "mobile company view tabs must expose a 44px touch target");
assert.match(css, /@media \(max-width: 720px\)[\s\S]*body\.role-admin \.admin-db-company-action :is\(button, a\)\s*\{[^}]*min-height:\s*var\(--touch-target-min\)\s*!important/s, "mobile company row actions must override the compact desktop height");
assert.match(css, /@media \(max-width: 720px\)[\s\S]*\.company-review-actions button[\s\S]*min-height:\s*var\(--touch-target-min\)/s, "mobile company review actions must expose a 44px touch target");
assert.match(css, /@media \(max-width: 720px\)[\s\S]*body\.role-admin \.admin-db-region-next-grid article\s*\{[^}]*display:\s*grid[^}]*border-radius:\s*var\(--ui-radius-md\)/s, "narrow next-step cards must use a stable rectangular card layout");
assert.match(css, /@media \(max-width: 720px\)[\s\S]*#adminDatabaseDashboard \.admin-db-workbench-heading[\s\S]*scroll-margin-top:\s*calc\(136px \+ env\(safe-area-inset-top\)\)/);
assert.match(css, /@media \(max-width: 390px\)[\s\S]*#adminDatabaseDashboard \.admin-db-company-identity/);
assert.match(css, /@media \(max-width: 390px\)[\s\S]*#adminDatabaseDashboard \.admin-db-region-next-grid\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\)/s, "mobile next-step cards must use one column instead of narrow multi-line pills");
assert.match(css, /@media \(max-width: 390px\)[\s\S]*#adminDatabaseDashboard \.admin-db-region-next-grid article\s*\{[^}]*border-radius:\s*var\(--ui-radius-md\)/s, "multi-line mobile next-step cards must use a card radius rather than an oval pill");
assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*data-admin-db-company-workbench-row/);

const tabletMediaMarker = "@media (min-width: 721px) and (max-width: 1120px)";
const tabletMediaStart = css.lastIndexOf(tabletMediaMarker);
assert.notEqual(tabletMediaStart, -1, "administrator filter needs a tablet layout contract covering 768px");
const tabletMedia = balancedBlockFrom(css, tabletMediaStart);
assert.match(
  tabletMedia,
  /body\.role-admin \.admin-db-toolbar-main\s*\{[^{}]*grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\);/s,
  "administrator filter must collapse to two flexible columns at 768px"
);
assert.match(
  tabletMedia,
  /body\.role-admin \.admin-db-toolbar-main > \.admin-db-filter-query\s*\{[^{}]*grid-column:\s*1 \/ -1;/s,
  "administrator query must span the tablet toolbar"
);
assert.match(
  tabletMedia,
  /body\.role-admin \.admin-db-toolbar-main > \.admin-db-filter-reset\s*\{[^{}]*width:\s*100%;/s,
  "administrator reset control must fit its tablet grid column"
);

console.log("Administrator company list, detail, and edit workbench UI contract checks passed");
