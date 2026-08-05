"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), "utf8");
const pkg = JSON.parse(read("package.json"));
const server = read("scripts/glamping_app_server.cjs");
const indexHtml = read("web/index.html");
const appCss = read("web/styles.css");
const publicCss = read("web/public-ui.css");
const themeScript = read("web/login-theme.js");
const serviceWorker = read("web/sw.js");
const publicTest = read("scripts/test_public_auth_policy_ui_contract.cjs");

const requiredScripts = {
  "test:surface": "node scripts/test_surface_contrast.cjs",
  "test:app-shell": "node scripts/test_app_shell_ui_contract.cjs",
  "test:admin-shell": "node scripts/test_admin_shell_ui_contract.cjs",
  "test:admin-company-workbench": "node scripts/test_admin_company_workbench_ui_contract.cjs",
  "test:b2b-home-workbench": "node scripts/test_b2b_home_workbench_ui_contract.cjs",
  "test:admin-operations": "node scripts/test_admin_operations_ui_contract.cjs",
  "test:crawl-eta": "node scripts/test_crawl_eta_model.cjs",
  "test:b2b-secondary-workbench": "node scripts/test_b2b_secondary_workbench_ui_contract.cjs",
  "test:b2b-detail-sheet": "node scripts/test_b2b_detail_sheet_ui_contract.cjs",
  "test:report-semantic-cards": "node scripts/test_report_semantic_cards_ui_contract.cjs",
  "test:public-auth-policy": "node scripts/test_public_auth_policy_ui_contract.cjs",
  "test:ui-release-static": "node scripts/test_ui_release_gate.cjs",
  "test:search-ui": "node scripts/test_lodging_search_ui_contract.cjs",
  "test:preview-boundary": "node scripts/test_preview_boundary.cjs",
};

for (const [name, command] of Object.entries(requiredScripts)) {
  assert.equal(pkg.scripts[name], command, `${name} command must remain explicit`);
  if (name === "test:surface") {
    assert.ok(pkg.scripts.check.includes("node scripts/test_surface_contrast.cjs"), "npm check must execute the surface contrast gate");
  } else {
    assert.ok(pkg.scripts.test.includes(`npm run ${name}`), `npm test must include ${name}`);
  }
}

for (const testFile of ["test_crawl_eta_model.cjs", "test_b2b_detail_sheet_ui_contract.cjs", "test_report_semantic_cards_ui_contract.cjs", "test_public_auth_policy_ui_contract.cjs", "test_ui_release_gate.cjs"]) {
  assert.ok(pkg.scripts.check.includes(`node --check scripts/${testFile}`), `check must parse ${testFile}`);
}

for (const asset of ["/login-theme.js", "/public-ui.css", "/manifest.webmanifest", "/offline.html"]) {
  assert.match(server, new RegExp(`"${asset.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`), `public asset missing: ${asset}`);
}

const expectedAssetVersion = "v2-20260804-search-period-v41";
const shellAssetVersions = [...indexHtml.matchAll(/(?:styles\.css|app\.js)\?v=([^"']+)/g)].map((match) => match[1]);
assert.deepEqual(shellAssetVersions, [expectedAssetVersion, expectedAssetVersion], "index CSS and JS must share the current release cache version");
assert.match(server, /const UI_ASSET_VERSION = "v2-20260804-search-period-v41";/, "server must enforce the current UI asset version");
assert.match(serviceWorker, /const UI_ASSET_VERSION = "v2-20260804-search-period-v41";/, "service worker must share the current UI asset version");
assert.match(serviceWorker, /const CACHE_VERSION = "lodging-datalab-pwa-v20260804-detail-sheet-v40";/, "service worker cache must rotate with the UI release");
assert.match(serviceWorker, /`\/styles\.css\?v=\$\{UI_ASSET_VERSION\}`/, "service worker must precache the versioned app stylesheet");
assert.match(serviceWorker, /`\/app\.js\?v=\$\{UI_ASSET_VERSION\}`/, "service worker must precache the versioned app script");
assert.match(serviceWorker, /const SENSITIVE_NAVIGATION_PATHS = new Set\(/, "service worker must declare sensitive navigation routes");
assert.match(serviceWorker, /request\.mode === "navigate" \|\| SENSITIVE_NAVIGATION_PATHS\.has\(url\.pathname\)/, "navigation and sensitive HTML must remain network-only");
assert.doesNotMatch(serviceWorker, /caches\.match\(request\).*caches\.match\("\/offline\.html"\)/s, "navigation fallback must not reuse cached personalized HTML");
assert.match(
  serviceWorker,
  /\.catch\(\(\) => caches\.open\(CACHE_VERSION\)\.then\(\(cache\) => cache\.match\("\/offline\.html"\)\)\)/,
  "navigation failure must use only the current release cache's static offline page",
);

for (const route of [
  "/login", "/signup", "/account-delete", "/terms", "/privacy", "/refund",
  "/data-collection-notice", "/data-quality-notice", "/collection-failure-notice", "/business-info",
]) {
  assert.match(server, new RegExp(`"${route.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`), `public route missing: ${route}`);
}

for (const helper of ["publicPageHead", "publicPageHeaderHtml", "publicPageFooterHtml"]) {
  assert.match(server, new RegExp(`function ${helper}\\(`), `${helper} missing`);
}
assert.match(server, /publicPageHead\("숙박업 데이터랩 beta 회원가입"\)/, "signup must use shared head");
assert.match(server, /<body class="public-page public-signup-page">/, "signup public shell");
assert.match(server, /data-signup-submit/, "signup submit lock hook");
assert.match(server, /let signupPending = false;/, "signup async submit lock state");
assert.match(server, /if \(signupPending\) \{\s*event\.preventDefault\(\);/s, "signup duplicate submit guard");
assert.match(server, /submitButton\.setAttribute\("aria-busy", String\(pending\)\)/, "signup pending semantics");
assert.match(themeScript, /form\[data-public-submit\]/, "public form submit lock binding");
assert.match(themeScript, /event\.defaultPrevented/, "public submit lock must respect prevented events");
assert.match(themeScript, /const storageKey = "lodging-theme"/, "theme storage key contract");
assert.match(themeScript, /"#070b12"\s*:\s*"#f3f6fa"/, "browser theme colors must match public canvas tokens");

assert.doesNotMatch(appCss, /filter\s*:\s*(?:invert|hue-rotate)/i, "application shell must not use whole-page inversion");
assert.doesNotMatch(publicCss, /filter\s*:\s*(?:invert|hue-rotate)/i, "public shell must not use whole-page inversion");
assert.doesNotMatch(indexHtml, /<(?:link|script)\b[^>]+(?:href|src)="https?:\/\//i, "application shell must not auto-load external assets");
assert.match(appCss, /@media \(min-width: 721px\) and \(max-width: 1120px\)[\s\S]*?body\.role-admin \.admin-console-layout\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\)/s, "release CSS must prevent tablet administrator queue clipping");
assert.match(appCss, /@media \(min-width: 721px\) and \(max-width: 1120px\)[\s\S]*?body\.role-admin \.admin-queue-row\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1\.25fr\) minmax\(0, \.55fr\) minmax\(0, 1fr\)/s, "release queue columns must shrink before parent overflow can hide them");
assert.match(appCss, /@media \(max-width: 720px\)[\s\S]*?body\.role-b2b \.map-caption\s*\{[^}]*white-space:\s*normal[^}]*overflow-wrap:\s*anywhere/s, "release CSS must keep mobile map captions visible");
assert.match(appCss, /@media \(max-width: 720px\)[\s\S]*?\.admin-db-audit-gate-actions button[\s\S]*?min-height:\s*var\(--touch-target-min\)/s, "release CSS must keep primary mobile administrator actions at least 44px high");
assert.match(appCss, /\.report-target-row strong\s*\{[^}]*white-space:\s*normal[^}]*overflow-wrap:\s*anywhere/s, "release CSS must keep long report names readable");

function themeTokenNames(css, marker) {
  const markerIndex = css.indexOf(marker);
  assert.ok(markerIndex >= 0, `theme marker missing: ${marker}`);
  const start = css.indexOf("{", markerIndex) + 1;
  const end = css.indexOf("}", start);
  return [...css.slice(start, end).matchAll(/--([a-z0-9-]+)\s*:/gi)].map((match) => match[1]).sort();
}

const lightTokens = themeTokenNames(publicCss, ':root[data-theme="light"] {');
const darkTokens = themeTokenNames(publicCss, ':root[data-theme="dark"] {');
assert.deepEqual(darkTokens, lightTokens, "public light and dark themes must expose identical semantic tokens");
for (const token of [
  "color-canvas", "color-surface-default", "color-surface-subtle", "color-text-primary",
  "color-text-secondary", "color-border-default", "color-border-focus", "color-action-primary",
  "color-status-success", "color-status-warning", "color-status-danger", "color-disabled-text",
]) {
  assert.ok(lightTokens.includes(token), `semantic token missing: ${token}`);
}

for (const contract of [
  /\.skip-link:focus-visible/,
  /:focus-visible/,
  /min-height:\s*var\(--touch-target-min\)/,
  /@media\s*\(max-width:\s*760px\)/,
  /@media\s*\(max-width:\s*390px\)/,
  /@media\s*\(prefers-reduced-motion:\s*reduce\)/,
  /@media\s+print/,
  /input:-webkit-autofill/,
]) {
  assert.match(publicCss, contract, `public CSS contract missing: ${contract}`);
}

assert.match(publicTest, /hostname, "127\.0\.0\.1"/, "public live test must block non-local requests");
assert.match(publicTest, /snapshotTree\(runtimeRoot\)/, "public live test must prove no data mutation");
assert.match(publicTest, /Public auth\/policy routes, contracts, themes, contrast, and no-write checks passed/, "public live test completion marker");

console.log("Automated UI release prerequisites passed; Chrome release audit remains mandatory");
