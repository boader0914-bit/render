"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

global.fetch = () => {
  throw new Error("Network calls are forbidden in administrator shell UI contract tests");
};

const root = path.resolve(__dirname, "..");
const html = fs.readFileSync(path.join(root, "web", "index.html"), "utf8");
const app = fs.readFileSync(path.join(root, "web", "app.js"), "utf8");
const css = fs.readFileSync(path.join(root, "web", "styles.css"), "utf8");

assert.match(html, /class="admin-workspace-shell"/);
assert.match(html, /class="admin-workspace-sidebar"[^>]*aria-label="관리자 작업공간"/);
assert.match(html, /class="admin-workspace-main"/);
assert.match(html, /class="section-title admin-workspace-heading"/);
assert.match(html, /class="admin-mobile-nav"[^>]*aria-label="관리자 모바일 메뉴"/);
assert.match(html, /id="adminUserViewButton"[^>]*>사업자 화면 열기</);

const adminSections = ["database", "overview", "collect", "members", "files"];
const actualNavSections = [...html.matchAll(/data-admin-section="([^"]+)"/g)].map((match) => match[1]).sort();
const actualPanelSections = [...html.matchAll(/data-admin-section-panel="([^"]+)"/g)].map((match) => match[1]).sort();
assert.deepEqual(actualNavSections, [...adminSections].sort(), "administrator navigation keys must match the supported section set");
assert.deepEqual(actualPanelSections, [...adminSections].sort(), "administrator panel keys must match the supported section set");
for (const section of adminSections) {
  const navMatches = html.match(new RegExp(`data-admin-section="${section}"`, "g")) || [];
  const panelMatches = html.match(new RegExp(`data-admin-section-panel="${section}"`, "g")) || [];
  assert.equal(navMatches.length, 1, `${section} administrator navigation hook must remain unique`);
  assert.equal(panelMatches.length, 1, `${section} administrator panel hook must remain unique`);
}

const preservedIds = [
  "adminPanel",
  "adminDatabaseDashboard",
  "adminConsoleDashboard",
  "crawlForm",
  "adminMemberRequestDashboard",
  "trafficAdminCard",
  "trafficKeyForm",
  "runSelect",
  "refreshRuns",
  "yeogiOpenButton",
  "yeogiImportButton",
  "adminStatus",
  "adminUserViewButton",
  "logoutButton",
  "themeToggle",
];
for (const id of preservedIds) {
  const matches = html.match(new RegExp(`id="${id}"`, "g")) || [];
  assert.equal(matches.length, 1, `${id} must remain present exactly once`);
}

const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
assert.equal(new Set(ids).size, ids.length, "administrator shell must not introduce duplicate element ids");

const structuralMarkers = [
  'id="adminPanel"',
  'class="admin-workspace-shell"',
  'class="admin-workspace-sidebar"',
  'class="admin-workspace-main"',
  'data-admin-section-panel="database"',
  'data-admin-section-panel="overview"',
  'data-admin-section-panel="collect"',
  'data-admin-section-panel="members"',
  'data-admin-section-panel="files"',
];
let priorMarkerIndex = -1;
for (const marker of structuralMarkers) {
  const markerIndex = html.indexOf(marker);
  assert.ok(markerIndex > priorMarkerIndex, `${marker} must remain in administrator shell order`);
  priorMarkerIndex = markerIndex;
}

assert.match(app, /adminPanel\.dataset\.activeSection = current/);
assert.match(app, /button\.setAttribute\("aria-current", "page"\)/);
assert.match(app, /button\.removeAttribute\("aria-current"\)/);
assert.match(app, /button\.setAttribute\("aria-pressed", active \? "true" : "false"\)/);
assert.match(app, /els\.pageTitle\.textContent = "관리자 콘솔"/);
assert.match(app, /ADMIN_PANEL_SECTIONS\[current\].*데이터 운영 워크스페이스/);
assert.match(app, /isAdminRole\(\) && state\.activeTab === "admin"/);
assert.match(app, /document\.title = `\$\{APP_BRAND_NAME\} · 관리자 콘솔`/);

assert.match(css, /--ui-color-canvas:/);
assert.match(css, /--ui-color-surface:/);
assert.match(css, /--ui-color-text:/);
assert.match(css, /--ui-color-text-muted:/);
assert.match(css, /--ui-color-border:/);
assert.match(css, /--ui-color-accent:/);
assert.match(css, /--ui-color-success:/);
assert.match(css, /--ui-color-warning:/);
assert.match(css, /--ui-color-danger:/);
assert.match(css, /--ui-font-sans:/);
assert.match(css, /--ui-shadow-sm:/);
assert.match(css, /--ui-shadow-md:/);
assert.match(css, /--ui-space-1:/);
assert.match(css, /--ui-radius-xl:/);
assert.match(css, /--ui-control-height:\s*44px/);
assert.match(css, /--ui-focus-ring:/);
assert.match(css, /--admin-shell-sidebar:/);
assert.match(css, /\.admin-workspace-shell\s*\{[\s\S]*grid-template-columns:\s*var\(--admin-shell-sidebar\) minmax\(0, 1fr\)/);
assert.match(css, /\.admin-workspace-sidebar\s*\{[\s\S]*position:\s*sticky/);
assert.match(css, /#adminPanel \.admin-section-nav button\[aria-current="page"\]/);
assert.match(css, /\.admin-workspace-shell :where\(button, a, input, select, textarea, summary\):focus-visible/);
assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
assert.match(css, /@media \(max-width: 720px\)[\s\S]*\.admin-workspace-sidebar\s*\{\s*display:\s*none/);
assert.match(css, /@media \(max-width: 720px\)[\s\S]*\.admin-mobile-nav\s*\{[\s\S]*display:\s*block;[\s\S]*position:\s*sticky/);
assert.match(css, /\.admin-mobile-secondary button\s*\{\s*min-height:\s*var\(--ui-control-height\)/);
assert.match(css, /@media \(max-width: 390px\)[\s\S]*\.admin-workspace-heading/);

console.log("Administrator design system and shell UI contract checks passed");
