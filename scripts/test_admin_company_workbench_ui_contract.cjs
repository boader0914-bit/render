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
assert.match(app, /class="admin-db-pagination"[^>]*aria-label="업체 목록 페이지 이동"/);
assert.match(app, /aria-label="이전 업체 목록 페이지"/);
assert.match(app, /aria-label="다음 업체 목록 페이지"/);
assert.match(app, /aria-label="\$\{escapeHtml\(`\$\{companyName\} 상세 및 수정 열기`\)\}"/);
assert.match(app, /lodgingCategoryBadgesHtml\(company, \{ compact: true \}\)/);

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
assert.match(app, /aria-pressed="\$\{activeFold === key \? "true" : "false"\}"/);
assert.match(app, /id="adminDbFold-\$\{escapeHtml\(foldKey\)\}" data-admin-db-fold=/);
assert.match(app, /button\.classList\.toggle\("active", active\)/);
assert.match(app, /button\.setAttribute\("aria-pressed", active \? "true" : "false"\)/);

const mutationHooks = [
  "data-company-manual-form",
  "data-save-company-correction",
  "data-clear-company-correction",
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
assert.match(css, /#adminDatabaseDashboard \.admin-db-company-status[\s\S]*border-radius:\s*999px/);
assert.match(css, /#adminDatabaseDashboard \.admin-db-company-action button,[\s\S]*min-height:\s*var\(--ui-control-height\)\s*!important/);
assert.match(css, /#adminDatabaseDashboard \.admin-db-workbench-heading/);
assert.match(css, /#adminDatabaseDashboard \.admin-db-detail-tabs button[\s\S]*grid-template-columns:\s*30px minmax\(0, 1fr\)/);
assert.match(css, /#adminDatabaseDashboard \.admin-db-selected-fold\[open\]/);
assert.match(css, /@media \(max-width: 720px\)[\s\S]*#adminDatabaseDashboard \.admin-db-list-overview[\s\S]*grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/);
assert.match(css, /@media \(max-width: 720px\)[\s\S]*#adminDatabaseDashboard \.admin-db-company-values[\s\S]*grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)\s*!important/);
assert.match(css, /@media \(max-width: 720px\)[\s\S]*#adminDatabaseDashboard \.admin-db-workbench-heading[\s\S]*scroll-margin-top:\s*calc\(136px \+ env\(safe-area-inset-top\)\)/);
assert.match(css, /@media \(max-width: 390px\)[\s\S]*#adminDatabaseDashboard \.admin-db-company-identity/);
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
